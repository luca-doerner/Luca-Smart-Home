/*
 * Web server of the smart home: rooms, nested devices and their features, plus the recipes.
 *
 * - pages: /rooms, /rooms/:id, /devices/:id, /recipes, /recipes/:id, /pantry, /nutrition, /account
 *   (one page, public/index.html + public/app.js)
 * - features and their settings come from the database, their programs run in features.js
 * - recipes, ingredients and the shopping list are in recipes.js and pantry.js
 * - everything except the login page needs a login (auth.js, users are added with user.js)
 *
 * Run (needs root, because the ambilight program needs root for the LEDs):
 *   sudo node server.js
 *
 * Environment variables:
 *   PORT           web server port (default 5000)
 *   HOST           address to listen on (default: all); 127.0.0.1 = only through the Cloudflare
 *                  tunnel, so every connection is encrypted
 *   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
 *                  PostgreSQL database (Database/schema.sql)
 *   UDP_HOST       receiver of the UDP messages of the services (default 127.0.0.1)
 *   RECIPE_IMAGE_DIR
 *                  folder of the recipe pictures (default /var/lib/luca-smart-home/recipe-images)
 *   PUBLIC_URL     (optional) public address, e.g. https://home.example.com; used by the OAuth
 *                  metadata (oauth.js). Without it the address of the request is used.
 *   SECRET_KEY / SECRET_KEY_FILE
 *                  key that encrypts the Bring! and YAZIO logins in the database (secret.js); without
 *                  SECRET_KEY a key file is created (default /var/lib/luca-smart-home/secret.key)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const auth = require("./auth");
const db = require("./db");
const HttpError = require("./http-error");
const { log, streamLog } = require("./log");
const smarthome = require("./smarthome");
const features = require("./features");
const recipes = require("./recipes");
const pantry = require("./pantry");
const mcp = require("./mcp");
const bring = require("./bring");
const yazio = require("./yazio");
const oauth = require("./oauth");

/*************** Configuration ****************************************************************/
const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || undefined;
const PUBLIC_DIR = path.join(__dirname, "public");

// Größe einer JSON-Anfrage: ein Satz Einstellungen ist winzig, ein Rezept mit Zutaten und
// Schritten braucht mehr Platz
const MAX_JSON = 10000;
const MAX_RECIPE_JSON = 100000;

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
};

db.on("error", (err) => log(`Datenbankfehler: ${err.message}`));

/*************** HTTP Helpers *****************************************************************/
// API answers are never cached, they always show the current state
function sendJson(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
}

// only JSON: other pages cannot send JSON to this server without its permission (CORS), so
// together with the SameSite cookie they cannot do anything in the name of a logged in user.
// limit: Standard MAX_JSON, Rezepte brauchen MAX_RECIPE_JSON. Ist die Anfrage zu groß, wird der
// Rest weggeworfen und eine echte 413 geantwortet — die Verbindung einfach zu zerstören
// (req.destroy) hätte dem Browser nur einen Netzwerkfehler ohne Grund hinterlassen.
function readJson(req, limit = MAX_JSON) {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
        return Promise.reject(new HttpError(415, "Nur JSON wird angenommen"));
    return new Promise((resolve, reject) => {
        let body = "";
        let tooBig = false;
        req.on("data", (chunk) => {
            if (tooBig)
                return;
            body += chunk;
            if (body.length > limit) {
                tooBig = true;
                reject(new HttpError(413, `Die Anfrage darf höchstens ${limit} Zeichen lang sein`));
            }
        });
        req.on("end", () => {
            if (tooBig)
                return;
            try {
                resolve(JSON.parse(body || "{}"));
            } catch {
                reject(new HttpError(400, "Ungültiges JSON"));
            }
        });
        req.on("error", reject);
    });
}

// Formular- oder JSON-Körper, nur für /oauth/token: das schreibt OAuth als
// application/x-www-form-urlencoded vor. Ein fremdes Formular kann so etwas senden, aber der
// Endpunkt wertet kein Cookie aus — Code und PKCE sind die Berechtigung, nicht die Anmeldung.
async function readTokenRequest(req) {
    const type = req.headers["content-type"] ?? "";
    if (type.startsWith("application/json"))
        return readJson(req);
    if (!type.startsWith("application/x-www-form-urlencoded"))
        throw new oauth.OAuthError(400, "invalid_request", "Content-Type muss application/x-www-form-urlencoded sein");
    return new Promise((resolve, reject) => {
        let body = "";
        let tooBig = false;
        req.on("data", (chunk) => {
            if (tooBig)
                return;
            body += chunk;
            if (body.length > MAX_JSON) {
                tooBig = true;
                reject(new oauth.OAuthError(413, "invalid_request", "Anfrage zu groß"));
            }
        });
        req.on("end", () => {
            if (!tooBig)
                resolve(Object.fromEntries(new URLSearchParams(body)));
        });
        req.on("error", reject);
    });
}

// rohe Bytes, für den Bild-Upload: der geht an readJson vorbei.
// Nur image/* wird angenommen — das ist kein Typ, den ein fremdes Formular senden kann, also
// bleibt der CSRF-Schutz von readJson auch hier erhalten.
function readImageBody(req, limit) {
    if (!(req.headers["content-type"] ?? "").startsWith("image/"))
        return Promise.reject(new HttpError(415, "Content-Type muss image/... sein"));
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooBig = false;
        req.on("data", (chunk) => {
            if (tooBig)
                return;
            size += chunk.length;
            if (size > limit) {
                tooBig = true;
                return reject(new HttpError(413, `Das Bild darf höchstens ${limit / 1024 / 1024} MB groß sein`));
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (!tooBig)
                resolve(Buffer.concat(chunks));
        });
        req.on("error", reject);
    });
}

// Rezeptbild: ETag aus image_updated_at, damit der Browser es nur nach einer Änderung neu lädt.
// private: das Bild gehört zu einem angemeldeten Benutzer, Cloudflare darf es nicht für andere
// zwischenspeichern.
async function sendImage(req, res, id) {
    const image = await recipes.readImage(id);
    const etag = `"${image.updatedAt.getTime().toString(16)}"`;
    const headers = {
        "Content-Type": image.mime,
        "Cache-Control": "private, max-age=3600",
        ETag: etag,
        "X-Content-Type-Options": "nosniff",
    };
    if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        return res.end();
    }
    res.writeHead(200, { ...headers, "Content-Length": image.data.length });
    res.end(image.data);
}

// files from public/, only plain names like "app.js" or "feature-panel.js";
// no-cache: browsers and Cloudflare have to ask on every use whether the file changed (ETag),
// otherwise they keep showing old files after a deploy; unchanged files are answered with 304
async function serveFile(req, res, file) {
    if (!/^[\w-]+(\/[\w-]+)*\.(html|css|js)$/.test(file))
        return sendJson(res, 404, { error: "Nicht gefunden" });
    const fullPath = path.join(PUBLIC_DIR, file);
    let stat;
    try {
        stat = await fs.promises.stat(fullPath);
    } catch {
        return sendJson(res, 404, { error: "Nicht gefunden" });
    }

    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
        "Content-Type": MIME_TYPES[path.extname(file)],
        "Cache-Control": "no-cache",
        ETag: etag,
        // no embedding in other pages (clickjacking), no guessing of file types
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
    };
    if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        return res.end();
    }
    res.writeHead(200, headers);
    res.end(await fs.promises.readFile(fullPath));
}

// nur wer sich im Browser mit Benutzername und Passwort angemeldet hat, nicht mit einem Token
function requireBrowserLogin(req) {
    if (req.user.viaToken)
        throw new HttpError(403, "Das geht nur mit einer Anmeldung im Browser");
}

function redirect(res, location) {
    res.writeHead(302, { Location: location });
    res.end();
}

// feature with its settings and the state of its program; the executable is not sent to the page
async function featureWithState(id) {
    const { executable, ...feature } = await smarthome.getFeature(id);
    return { ...feature, hasProgram: Boolean(executable), state: features.state(id) };
}

// the state that changes while the page is open: started or not and the program
async function featureState(id) {
    const { active } = await smarthome.getFeature(id);
    return { active, ...features.state(id) };
}

/*************** Routes ***********************************************************************/
// [method, path pattern, handler(req, res, ...pattern groups)]
const ROUTES = [
    // login
    ["GET", /^\/login$/, (req, res) => req.user ? redirect(res, "/rooms") : serveFile(req, res, "login.html")],
    ["POST", /^\/api\/login$/, async (req, res) => sendJson(res, 200, await auth.login(req, res, await readJson(req)))],
    ["POST", /^\/api\/logout$/, async (req, res) => {
        await auth.logout(req, res);
        sendJson(res, 200, {});
    }],
    ["GET", /^\/api\/me$/, (req, res) => sendJson(res, 200, { username: req.user.username })],
    // for the deploy: server and database answer (no login needed, shows no data)
    ["GET", /^\/api\/health$/, async (req, res) => {
        await db.query("SELECT 1");
        sendJson(res, 200, { ok: true });
    }],

    // pages (the page itself loads its data from the API)
    ["GET", /^\/$/, (req, res) => redirect(res, "/rooms")],
    ["GET", /^\/(rooms|rooms\/\d+|devices\/\d+|recipes|recipes\/new|recipes\/\d+|pantry|nutrition|account)$/,
        (req, res) => serveFile(req, res, "index.html")],
    // old address of the ambilight page
    ["GET", /^\/ambilight$/, async (req, res) => {
        const { rows: [feature] } = await db.query("SELECT id, device_id FROM features WHERE type = 'ambilight' ORDER BY id LIMIT 1");
        redirect(res, feature ? `/devices/${feature.device_id}?feature=${feature.id}` : "/rooms");
    }],

    // navigation, rooms and devices
    ["GET", /^\/api\/navigation$/, async (req, res) => sendJson(res, 200, {
        rooms: await smarthome.getTree(),
        pinned: await smarthome.getPinned(),
    })],
    ["GET", /^\/api\/rooms\/(\d+)$/, async (req, res, id) => sendJson(res, 200, await smarthome.getRoom(Number(id)))],
    // features with running / message, so the page can tell "started" from "really running"
    ["GET", /^\/api\/devices\/(\d+)$/, async (req, res, id) => {
        const device = await smarthome.getDevice(Number(id));
        device.features = device.features.map((feature) => {
            const { running, message } = features.state(feature.id);
            return { ...feature, running, message };
        });
        sendJson(res, 200, device);
    }],
    // { values: { name: value, ... } }; restarts the running services of the device if something changed
    ["POST", /^\/api\/devices\/(\d+)\/settings$/, async (req, res, id) => {
        const { values } = await readJson(req);
        sendJson(res, 200, await features.applyDeviceSettings(Number(id), values));
    }],
    ["POST", /^\/api\/devices\/(\d+)\/pinned$/, async (req, res, id) => {
        const { pinned } = await readJson(req);
        if (typeof pinned !== "boolean")
            throw new HttpError(400, "pinned muss true oder false sein");
        sendJson(res, 200, { pinned: await smarthome.setDevicePinned(Number(id), pinned) });
    }],

    // features
    ["GET", /^\/api\/features\/(\d+)$/, async (req, res, id) => sendJson(res, 200, await featureWithState(Number(id)))],
    ["GET", /^\/api\/features\/(\d+)\/state$/, async (req, res, id) => sendJson(res, 200, await featureState(Number(id)))],
    // start (true) or stop (false) a service
    ["POST", /^\/api\/features\/(\d+)\/active$/, async (req, res, id) => {
        const { active } = await readJson(req);
        if (typeof active !== "boolean")
            throw new HttpError(400, "active muss true oder false sein");
        const changes = await smarthome.setFeatureActive(Number(id), active, features.setActive);
        sendJson(res, 200, { changes, state: await featureState(Number(id)) });
    }],
    // { values: { name: value, ... } }, applied depending on the kind of the feature
    ["POST", /^\/api\/features\/(\d+)\/settings$/, async (req, res, id) => {
        const { values } = await readJson(req);
        const result = await features.applySettings(Number(id), values);
        sendJson(res, 200, { ...result, state: await featureState(Number(id)) });
    }],

    /*
     * Rezepte und Vorrat (recipes.js, pantry.js).
     *
     * Nur GET und POST: api() in public/lib.js kennt nichts anderes, deshalb heißt Löschen hier
     * POST .../delete und nicht DELETE. Zutaten werden überall über ihren Namen angesprochen,
     * nicht über eine id, damit auch ein KI-Agent (mcp.js) ohne Vorarbeit speichern kann.
     */
    ["GET", /^\/api\/recipes$/, async (req, res) => {
        const { searchParams } = new URL(req.url, "http://localhost");
        sendJson(res, 200, {
            recipes: await recipes.listRecipes({
                q: searchParams.get("q"),
                tag: searchParams.get("tag"),
                limit: searchParams.get("limit"),
            }),
        });
    }],
    ["POST", /^\/api\/recipes$/, async (req, res) => {
        const { recipe } = await readJson(req, MAX_RECIPE_JSON);
        sendJson(res, 201, { recipe: await recipes.saveRecipe(null, recipe, req.user.id) });
    }],
    // die Grundrezepte aller Gerichte, für die Auswahl „Variante von“ im Formular
    ["GET", /^\/api\/recipes\/dishes$/, async (req, res) =>
        sendJson(res, 200, { dishes: await recipes.listDishes() })],
    ["GET", /^\/api\/recipes\/(\d+)$/, async (req, res, id) =>
        sendJson(res, 200, { recipe: await recipes.getRecipe(Number(id)) })],
    ["POST", /^\/api\/recipes\/(\d+)$/, async (req, res, id) => {
        const { recipe } = await readJson(req, MAX_RECIPE_JSON);
        sendJson(res, 200, { recipe: await recipes.saveRecipe(Number(id), recipe, req.user.id) });
    }],
    ["POST", /^\/api\/recipes\/(\d+)\/delete$/, async (req, res, id) => {
        await readJson(req);
        sendJson(res, 200, await recipes.deleteRecipe(Number(id)));
    }],
    // ?servings=6 rechnet die Mengen auf andere Portionen um
    ["GET", /^\/api\/recipes\/(\d+)\/ingredients$/, async (req, res, id) => {
        const { searchParams } = new URL(req.url, "http://localhost");
        sendJson(res, 200, await recipes.getRecipeIngredients(Number(id), searchParams.get("servings")));
    }],
    ["GET", /^\/api\/recipes\/(\d+)\/shopping-list$/, async (req, res, id) => {
        const { searchParams } = new URL(req.url, "http://localhost");
        sendJson(res, 200, await recipes.getShoppingList(Number(id), searchParams.get("servings")));
    }],
    // Knopf „An Bring! senden“: { servings?, list? }. Schreibt in eine geteilte Liste, deshalb
    // nur auf ausdrücklichen Klick; die Vorschau ist /shopping-list
    ["POST", /^\/api\/recipes\/(\d+)\/bring$/, async (req, res, id) => {
        const { servings, list, choices } = await readJson(req);
        sendJson(res, 200, await bring.sendRecipes(req.user.id, [Number(id)], servings, list, choices));
    }],

    // das eigene Bring!-Konto, Seite „Konto“. Anmelden, Trennen und die Standardliste ändern nur
    // mit dem Cookie-Login: ein Token (Claude, OAuth) soll das Konto nicht austauschen können,
    // sonst ginge die Einkaufsliste danach an ein fremdes Konto
    ["GET", /^\/api\/bring$/, async (req, res) => sendJson(res, 200, await bring.status(req.user.id))],
    ["GET", /^\/api\/bring\/lists$/, async (req, res) => sendJson(res, 200, { lists: await bring.lists(req.user.id) })],
    ["POST", /^\/api\/bring\/login$/, async (req, res) => {
        requireBrowserLogin(req);
        const { email, password } = await readJson(req);
        sendJson(res, 200, await bring.connect(req.user.id, email, password));
    }],
    ["POST", /^\/api\/bring\/logout$/, async (req, res) => {
        requireBrowserLogin(req);
        await readJson(req);
        sendJson(res, 200, await bring.disconnect(req.user.id));
    }],
    ["POST", /^\/api\/bring\/list$/, async (req, res) => {
        requireBrowserLogin(req);
        const { list_uuid: listUuid } = await readJson(req);
        sendJson(res, 200, await bring.setDefaultList(req.user.id, listUuid ?? null));
    }],
    // Knopf „Portion nach YAZIO“: { portions, daytime, date? }. Schreibt ins echte Tagebuch, deshalb
    // nur auf ausdrücklichen Klick. Die Nährwerte × Portionen rechnet yazio.js, nicht die Seite
    ["POST", /^\/api\/recipes\/(\d+)\/yazio$/, async (req, res, id) => {
        const { portions, daytime, date } = await readJson(req);
        sendJson(res, 200, await yazio.logRecipe(req.user.id, Number(id), portions, daytime, date));
    }],

    // das eigene YAZIO-Konto und das Tagebuch. Wie bei Bring!: Anmelden und Trennen nur mit dem
    // Cookie-Login, ein Token (Claude, OAuth) soll das Konto nicht austauschen können
    ["GET", /^\/api\/yazio$/, async (req, res) => sendJson(res, 200, await yazio.status(req.user.id))],
    ["POST", /^\/api\/yazio\/login$/, async (req, res) => {
        requireBrowserLogin(req);
        const { email, password } = await readJson(req);
        sendJson(res, 200, await yazio.connect(req.user.id, email, password));
    }],
    ["POST", /^\/api\/yazio\/logout$/, async (req, res) => {
        requireBrowserLogin(req);
        await readJson(req);
        sendJson(res, 200, await yazio.disconnect(req.user.id));
    }],
    ["GET", /^\/api\/yazio\/day$/, async (req, res) => {
        const { searchParams } = new URL(req.url, "http://localhost");
        sendJson(res, 200, await yazio.day(req.user.id, searchParams.get("date")));
    }],
    ["GET", /^\/api\/yazio\/products$/, async (req, res) => {
        const { searchParams } = new URL(req.url, "http://localhost");
        sendJson(res, 200, { products: await yazio.searchProducts(req.user.id, searchParams.get("query")) });
    }],
    ["POST", /^\/api\/yazio\/entries$/, async (req, res) =>
        sendJson(res, 201, await yazio.addProduct(req.user.id, await readJson(req)))],
    ["POST", /^\/api\/yazio\/entries\/([0-9a-fA-F-]+)\/delete$/, async (req, res, id) => {
        await readJson(req);
        sendJson(res, 200, await yazio.removeEntry(req.user.id, id));
    }],

    // das Bild kommt als rohe Bytes, der Typ wird an den ersten Bytes geprüft (recipes.js)
    ["POST", /^\/api\/recipes\/(\d+)\/image$/, async (req, res, id) => {
        const body = await readImageBody(req, recipes.MAX_IMAGE_BYTES);
        sendJson(res, 200, await recipes.saveImage(Number(id), body));
    }],
    ["GET", /^\/api\/recipes\/(\d+)\/image$/, (req, res, id) => sendImage(req, res, Number(id))],
    ["POST", /^\/api\/recipes\/(\d+)\/image\/delete$/, async (req, res, id) => {
        await readJson(req);
        sendJson(res, 200, await recipes.deleteImage(Number(id)));
    }],

    ["GET", /^\/api\/ingredients$/, async (req, res) => {
        const { searchParams } = new URL(req.url, "http://localhost");
        sendJson(res, 200, { ingredients: await recipes.listIngredients(searchParams.get("q")) });
    }],
    ["POST", /^\/api\/ingredients$/, async (req, res) =>
        sendJson(res, 201, { ingredient: await recipes.createIngredient(await readJson(req)) })],
    ["GET", /^\/api\/tags$/, async (req, res) => sendJson(res, 200, { tags: await recipes.listTags() })],

    ["GET", /^\/api\/pantry$/, async (req, res) => sendJson(res, 200, { items: await pantry.listPantry() })],
    ["POST", /^\/api\/pantry$/, async (req, res) =>
        sendJson(res, 200, { item: await pantry.setPantryItem(await readJson(req)) })],
    ["POST", /^\/api\/pantry\/(\d+)\/delete$/, async (req, res, id) => {
        await readJson(req);
        sendJson(res, 200, await pantry.removePantryItem(Number(id)));
    }],

    /*
     * MCP: die Rezepte als Werkzeuge für eine KI (mcp.js). Eine Route, JSON-RPC über POST.
     * Die Anmeldung läuft wie überall über auth.js — ein Programm schickt dafür
     * "Authorization: Bearer <token>" statt eines Cookies.
     */
    ["POST", /^\/api\/mcp$/, async (req, res) =>
        mcp.handlePost(req, res, await readJson(req, MAX_RECIPE_JSON))],
    ["GET", /^\/api\/mcp$/, (req, res) => mcp.methodNotAllowed(res)],
    ["DELETE", /^\/api\/mcp$/, (req, res) => mcp.methodNotAllowed(res)],

    /*
     * OAuth (oauth.js), damit claude.ai und die Handy-App den MCP-Server einhängen können.
     * Öffentlich sind nur Metadaten, Registrierung und Token-Abruf; die Freigabe-Seite und ihre
     * API verlangen das normale Login (ohne Cookie: Umleitung auf /login?next=...).
     */
    ["GET", /^\/\.well-known\/oauth-protected-resource(?:\/api\/mcp)?$/, (req, res) => oauth.protectedResourceMetadata(req, res)],
    ["GET", /^\/\.well-known\/oauth-authorization-server$/, (req, res) => oauth.authorizationServerMetadata(req, res)],
    ["OPTIONS", /^\/(?:\.well-known\/[\w-]+(?:\/api\/mcp)?|oauth\/(?:register|token))$/, (req, res) => oauth.preflight(req, res)],
    ["POST", /^\/oauth\/register$/, async (req, res) => oauth.register(req, res, await readJson(req))],
    ["POST", /^\/oauth\/token$/, async (req, res) => oauth.token(req, res, await readTokenRequest(req))],
    ["GET", /^\/oauth\/authorize$/, (req, res) => serveFile(req, res, "consent.html")],
    ["GET", /^\/api\/oauth\/client$/, async (req, res) => {
        const { searchParams } = new URL(req.url, "http://localhost");
        sendJson(res, 200, await oauth.describeClient(searchParams.get("client_id"), searchParams.get("redirect_uri")));
    }],
    ["POST", /^\/api\/oauth\/authorize$/, async (req, res) =>
        sendJson(res, 200, await oauth.decide(req.user, await readJson(req)))],

    // output of the feature programs and server messages as Server-Sent Events
    ["GET", /^\/api\/log$/, (req, res) => streamLog(req, res)],
];

// what can be opened without login: the login page and what it needs
const PUBLIC = [
    ["GET", /^\/login$/],
    ["POST", /^\/api\/login$/],
    ["POST", /^\/api\/logout$/],
    ["GET", /^\/api\/health$/],
    ["GET", /^\/(login\.js|style\.css)$/],
    // OAuth für Programme (oauth.js): Metadaten, Registrierung, Token-Abruf
    ["GET", /^\/\.well-known\/oauth-(protected-resource(\/api\/mcp)?|authorization-server)$/],
    ["OPTIONS", /^\/(\.well-known\/[\w-]+(\/api\/mcp)?|oauth\/(register|token))$/],
    ["POST", /^\/oauth\/(register|token)$/],
];

async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    try {
        req.user = await auth.userFromRequest(req, res);
        const isPublic = PUBLIC.some(([method, pattern]) => req.method === method && pattern.test(url.pathname));
        if (!req.user && !isPublic) {
            if (url.pathname.startsWith("/api/")) {
                // der Hinweis, wo ein MCP-Client sich anmelden kann (RFC 9728): daran beginnt
                // der OAuth-Ablauf von claude.ai
                if (url.pathname === "/api/mcp")
                    res.setHeader("WWW-Authenticate", oauth.challenge(req));
                throw new HttpError(401, "Nicht angemeldet");
            }
            return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
        }

        for (const [method, pattern, handler] of ROUTES) {
            const match = req.method === method && url.pathname.match(pattern);
            if (match)
                return await handler(req, res, ...match.slice(1));
        }
        if (req.method === "GET" && !url.pathname.startsWith("/api/"))
            return await serveFile(req, res, url.pathname.slice(1));
        sendJson(res, 404, { error: "Nicht gefunden" });
    } catch (err) {
        if (err instanceof oauth.OAuthError)
            return oauth.sendError(res, err);
        if (!(err instanceof HttpError))
            console.error(err);
        if (!res.headersSent)
            sendJson(res, err.status || 500, { error: err.message });
    }
}

/*************** Main *************************************************************************/
features.init();

const server = http.createServer(handle);
server.listen(PORT, HOST, () => {
    log(`Webserver läuft auf http://localhost:${PORT}`);
});

// stop the programs (ambilight switches the LEDs off) when the web server is stopped
async function shutdown() {
    await features.shutdown();
    await db.end().catch(() => {});
    server.close();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
