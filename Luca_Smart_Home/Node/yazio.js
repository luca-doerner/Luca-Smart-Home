/*
 * YAZIO (Kalorienzähler): liest das Tagebuch eines Benutzers und trägt Essen ein — auch ein Rezept
 * aus der Rezeptdatenbank, mit den Nährwerten, die dort pro Portion stehen.
 *
 * Aufgebaut wie bring.js: Jeder Benutzer meldet sich auf der Seite „Konto“ mit seinem eigenen
 * YAZIO-Konto an (Tabelle yazio_accounts). Was ein Werkzeug oder ein Knopf tut, geht immer in das
 * Tagebuch des Benutzers, der die Anfrage gestellt hat — auch bei einem Token von OAuth oder
 * Claude Code, denn das gehört auch zu einem Benutzer.
 *
 * YAZIO hat KEINE offizielle API. Dieses Modul spricht dieselbe zurückentwickelte Schnittstelle
 * an wie die Community-Clients. Sie kann ohne Vorwarnung brechen — und die Nutzungsbedingungen
 * erlauben sie vermutlich nicht (Risiko: das Konto wird gesperrt). Darum steht alles in dieser
 * einen Datei, und ihr Ausfall darf nie mehr als die yazio_*-Werkzeuge, die Seite „Ernährung“
 * und den „Portion nach YAZIO“-Knopf mitnehmen: er kommt als 502, die Rezepte laufen weiter.
 *
 * Quellen (beim Bau gelesen, nicht gegen das echte YAZIO geprüft):
 *   github.com/juriadams/yazio       src/api/**, src/utils/constants.ts (TypeScript, Basis /v20)
 *   github.com/saganos/yazio_public_api   swagger.json (Basis /v15)
 * Was dort steht und was sich widerspricht:
 *   - Basis-URL: juriadams /v20, saganos /v15. Hier /v20 (YAZIO_API_URL überschreibt es).
 *   - Token: POST /oauth/token mit client_id/client_secret (fest in der App, öffentlich in allen
 *     Clients, also kein Geheimnis) und grant_type password bzw. refresh_token. juriadams schickt
 *     JSON, saganos schreibt application/x-www-form-urlencoded vor. Darum probiert tokenRequest
 *     das eine und, wenn der Server die Form nicht versteht, das andere und merkt sich, was ging.
 *   - Lesen: GET /user/consumed-items?date= (Produkte, Rezeptportionen und „simple_products“),
 *     /user/widgets/daily-summary?date= (Summen je Mahlzeit, Ziele, Wasser, Schritte),
 *     /user/goals/unmodified?date=, /user/bodyvalues/weight/last?date= (kg),
 *     /products/search?query=&sex=&countries=&locales=, /products/:id.
 *   - Schreiben: POST /user/consumed-items mit { products, recipe_portions, simple_products },
 *     DELETE /user/consumed-items mit Body [id] (die id des Eintrags, nicht des Produkts).
 *   - Einheiten: Nährwerte eines PRODUKTS gelten pro Gramm (energy.energy = kcal pro Gramm, also
 *     0,52 für 52 kcal je 100 g); amount ist in Gramm bzw. Millilitern. Die Schlüssel heißen
 *     energy.energy, nutrient.protein, nutrient.carb, nutrient.fat. daytime ist breakfast,
 *     lunch, dinner oder snack.
 *   - UNGEPRÜFT: das Format eines simple_product beim SCHREIBEN. Keine der Quellen zeigt es; beim
 *     Lesen sieht ein Eintrag aus wie { id, date, daytime, type: "simple_product", name,
 *     nutrients, is_ai_generated }. addSimpleProduct schickt dieselbe Form ohne type, mit den
 *     SUMMEN des Eintrags (kcal und Gramm, nicht pro Gramm). Der erste echte Versuch ist der Test.
 *
 * Gespeichert wird nicht das Passwort, sondern der refresh_token von YAZIO, verschlüsselt (siehe
 * secret.js). Das Zugriffstoken (kurzlebig) liegt nur im Speicher. Passwörter, Token und
 * Antwortkörper von YAZIO dürfen nirgends hin, wo log() sie hinschreiben könnte: log() schreibt
 * ins Journal und an jede offene Seite. Fehlermeldungen von hier enthalten sie deshalb nie.
 *
 * Kein Zusatzpaket: fetch gibt es seit Node 18 eingebaut.
 */
const crypto = require("crypto");
const db = require("./db");
const auth = require("./auth");
const HttpError = require("./http-error");
const { encrypt, decrypt } = require("./secret");
const { log } = require("./log");

// YAZIO_API_URL gibt es nur zum Testen gegen einen Attrappen-Server, im Betrieb bleibt es leer
const BASE_URL = (process.env.YAZIO_API_URL || "https://yzapi.yazio.com/v20").replace(/\/+$/, "");
const TIMEOUT_MS = 15000;
// so viele Sekunden vor dem Ablauf wird das Token schon erneuert
const EXPIRY_MARGIN_S = 60;
const MAX_LOGIN_FAILURES = 10;

// feste Werte der App (stehen öffentlich in allen Community-Clients, daher gitleaks:allow)
const CLIENT_ID = "1_4hiybetvfksgw40o0sog4s884kwc840wwso8go4k8c04goo4c";   // gitleaks:allow
const CLIENT_SECRET = "6rok2m65xuskgkgogw40wkkk8sw0osg84s8cggsc4woos4s8o";   // gitleaks:allow

const DAYTIMES = ["breakfast", "lunch", "dinner", "snack"];
const KCAL = "energy.energy";
const PROTEIN = "nutrient.protein";
const CARBS = "nutrient.carb";
const FAT = "nutrient.fat";

const MAX_AMOUNT = 10000;      // Gramm bzw. Milliliter pro Eintrag
const MAX_PORTIONS = 50;
const MAX_SEARCH_RESULTS = 15;
const MAX_PRODUCTS_PER_DAY = 40;   // so viele verschiedene Produkte werden je Tag nachgeschlagen
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_CONNECTED = "YAZIO ist nicht verbunden — unter „Konto“ bei YAZIO anmelden";
const EXPIRED = "Die YAZIO-Anmeldung ist abgelaufen — unter „Konto“ neu bei YAZIO anmelden";

/*************** Prüfung **********************************************************************/
// heutiges Datum in der Zeit des Hauses; der Pi läuft in UTC, kurz nach Mitternacht wäre
// „heute“ sonst noch der Vortag. „sv-SE“ schreibt von sich aus JJJJ-MM-TT.
function today() {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
}

function parseDate(value) {
    if (value === undefined || value === null || value === "")
        return today();
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new HttpError(400, "date muss JJJJ-MM-TT sein, z. B. 2026-03-14");
    // „2026-02-31“ besteht den Mustertest, ist aber kein Tag: einmal durch Date und zurück
    const [year, month, day] = value.split("-").map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (year < 2000 || year > 2100 || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
        throw new HttpError(400, `„${value}“ ist kein gültiges Datum`);
    return value;
}

function parseDaytime(value) {
    if (!DAYTIMES.includes(value))
        throw new HttpError(400, `daytime muss eine von ${DAYTIMES.join(", ")} sein`);
    return value;
}

function parsePositive(value, label, max) {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value.replace(",", ".")) : value;
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0)
        throw new HttpError(400, `${label} muss eine Zahl größer als 0 sein`);
    if (number > max)
        throw new HttpError(400, `${label} darf höchstens ${max} sein`);
    return number;
}

function parseUuid(value, label, source) {
    if (typeof value !== "string" || !UUID.test(value))
        throw new HttpError(400, `${label} muss eine id sein, wie sie ${source} liefert`);
    return value.toLowerCase();
}

const round = (value, digits = 1) =>
    Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/*************** Anfragen an YAZIO ************************************************************/
async function rawRequest(method, requestPath, { headers = {}, form, json } = {}) {
    const options = { method, headers: { ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (form) {
        options.headers["Content-Type"] = "application/x-www-form-urlencoded";
        options.body = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(json);
    }
    try {
        return await fetch(BASE_URL + requestPath, options);
    } catch (err) {
        // Netzwerkfehler oder Zeitüberschreitung; die Meldung enthält nie den Körper der Anfrage
        throw new HttpError(502, err.name === "TimeoutError"
            ? "YAZIO antwortet nicht (Zeitüberschreitung)"
            : "YAZIO ist nicht erreichbar");
    }
}

// Was beim letzten Mal ging; JSON zuerst, weil der neuere Client es so macht
let tokenFormat = "json";

// OAuth-Fehler wie invalid_grant (falsches Passwort) zeigen, dass der Server die Anfrage
// verstanden hat. Nur wenn er die FORM nicht versteht (415, oder 400 ohne klaren OAuth-Fehler),
// lohnt sich ein zweiter Versuch in der anderen Form.
async function formatNotUnderstood(response) {
    if (response.status === 415)
        return true;
    if (response.status !== 400)
        return false;
    const data = await response.clone().json().catch(() => ({}));
    return data.error === undefined || data.error === "invalid_request";
}

async function tokenRequest(fields) {
    const formats = tokenFormat === "json" ? ["json", "form"] : ["form", "json"];
    let response;
    for (const format of formats) {
        const body = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields };
        response = await rawRequest("POST", "/oauth/token", format === "json" ? { json: body } : { form: body });
        if (response.ok) {
            tokenFormat = format;
            return response;
        }
        if (!(await formatNotUnderstood(response)))
            return response;
    }
    return response;
}

function bearer(accessToken) {
    return { Authorization: `Bearer ${accessToken}` };
}

/*************** Konto verbinden **************************************************************/
// Zugriffstoken im Speicher: Benutzer-id -> { accessToken, expiresAt }
const sessions = new Map();
const refreshing = new Map();   // Benutzer-id -> laufende Erneuerung

function expiry(data) {
    return Date.now() + (Number(data.expires_in) || 3600) * 1000;
}

// Meldet den Benutzer bei YAZIO an und merkt sich das Konto. Das Passwort geht nur hier durch.
async function connect(userId, email, password) {
    if (typeof email !== "string" || email.trim() === "" || typeof password !== "string" || password === "")
        throw new HttpError(400, "E-Mail und Passwort von YAZIO angeben");
    if (email.length > 200 || password.length > 200)
        throw new HttpError(400, "E-Mail oder Passwort ist zu lang");

    const key = `yazio:${userId}`;
    if (auth.blocked(key, MAX_LOGIN_FAILURES))
        throw new HttpError(429, "Zu viele fehlgeschlagene Anmeldungen bei YAZIO, bitte in 15 Minuten nochmal");

    const response = await tokenRequest({ grant_type: "password", username: email.trim(), password });
    // 429 und Co. sind kein falsches Passwort und zählen deshalb nicht in die Sperre
    if ([400, 401, 403].includes(response.status)) {
        auth.recordFailure(key);
        throw new HttpError(400, "YAZIO hat die Anmeldung abgelehnt — E-Mail oder Passwort stimmen nicht");
    }
    if (!response.ok)
        throw new HttpError(502, `YAZIO-Anmeldung fehlgeschlagen (HTTP ${response.status})`);
    const data = await response.json().catch(() => ({}));
    if (!data.access_token || !data.refresh_token)
        throw new HttpError(502, "YAZIO hat eine unerwartete Antwort bei der Anmeldung geschickt");

    await db.query(`
        INSERT INTO yazio_accounts (user_id, email, credentials) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE
            SET email = EXCLUDED.email, credentials = EXCLUDED.credentials, created_at = now()`,
        [userId, email.trim(), encrypt({ refreshToken: data.refresh_token })]);
    sessions.set(userId, { accessToken: data.access_token, expiresAt: expiry(data) });
    log("YAZIO: ein Benutzer hat sein Konto verbunden");
    return status(userId);
}

async function disconnect(userId) {
    await db.query("DELETE FROM yazio_accounts WHERE user_id = $1", [userId]);
    sessions.delete(userId);
    return { connected: false };
}

async function loadAccount(userId) {
    const { rows: [row] } = await db.query(
        "SELECT email, credentials FROM yazio_accounts WHERE user_id = $1", [userId]);
    if (!row)
        throw new HttpError(409, NOT_CONNECTED);
    const credentials = decrypt(row.credentials);
    if (!credentials)
        throw new HttpError(409, EXPIRED);
    return { email: row.email, ...credentials };
}

// für die Seite „Konto“: verbunden oder nicht, ohne YAZIO zu fragen
async function status(userId) {
    const { rows: [row] } = await db.query("SELECT email FROM yazio_accounts WHERE user_id = $1", [userId]);
    return row ? { connected: true, email: row.email } : { connected: false };
}

// holt mit dem refresh_token ein neues Zugriffstoken; gelingt das nicht mehr, muss man sich neu
// anmelden (das Konto bleibt stehen, damit die Seite „abgelaufen“ statt „nicht verbunden“ sagt)
async function refresh(userId, account) {
    const response = await tokenRequest({ grant_type: "refresh_token", refresh_token: account.refreshToken });
    const data = response.ok ? await response.json().catch(() => ({})) : {};
    if (!data.access_token) {
        sessions.delete(userId);
        if (response.status >= 500)
            throw new HttpError(502, `YAZIO hat das Erneuern abgelehnt (HTTP ${response.status})`);
        throw new HttpError(409, EXPIRED);
    }
    // Wechselt YAZIO den refresh_token bei jeder Erneuerung, ist der alte bald wertlos: der neue
    // muss in die Datenbank, sonst wäre man nach dem nächsten Neustart abgemeldet.
    if (data.refresh_token && data.refresh_token !== account.refreshToken)
        await db.query("UPDATE yazio_accounts SET credentials = $2 WHERE user_id = $1",
            [userId, encrypt({ refreshToken: data.refresh_token })]);
    const entry = { accessToken: data.access_token, expiresAt: expiry(data) };
    sessions.set(userId, entry);
    return entry;
}

async function accessToken(userId, account) {
    const current = sessions.get(userId);
    if (current && current.expiresAt - EXPIRY_MARGIN_S * 1000 > Date.now())
        return current.accessToken;
    // zwei gleichzeitige Anfragen sollen nur einmal erneuern
    if (!refreshing.has(userId))
        refreshing.set(userId, refresh(userId, account).finally(() => refreshing.delete(userId)));
    return (await refreshing.get(userId)).accessToken;
}

// Anfrage im Namen des Benutzers; bei 401 einmal das Token erneuern und wiederholen.
// notFound: 404 ist eine Antwort („das Produkt gibt es nicht“), kein Ausfall von YAZIO.
async function request(userId, account, method, requestPath, options = {}) {
    const { notFound = false, ...rest } = options;
    const send = async () => rawRequest(method, requestPath,
        { ...rest, headers: bearer(await accessToken(userId, account)) });
    let response = await send();
    if (response.status === 401) {
        sessions.delete(userId);
        response = await send();
    }
    if (notFound && response.status === 404)
        return response;
    if (!response.ok)
        throw new HttpError(502, `YAZIO hat die Anfrage abgelehnt (HTTP ${response.status})`);
    return response;
}

async function getJson(userId, account, requestPath, options) {
    const response = await request(userId, account, "GET", requestPath, options);
    if (response.status === 404)
        return null;
    return response.json().catch(() => {
        throw new HttpError(502, "YAZIO hat eine unerwartete Antwort geschickt");
    });
}

/*************** Produkte *********************************************************************/
// Nährwerte eines Produkts gelten pro Gramm. Hier die Form, die ein Mensch (und ein Agent)
// braucht: je 100 g bzw. ml.
function per100(nutrients = {}) {
    return {
        kcal: round(nutrients[KCAL] * 100),
        protein: round(nutrients[PROTEIN] * 100),
        carbs: round(nutrients[CARBS] * 100),
        fat: round(nutrients[FAT] * 100),
    };
}

// Produkte ändern sich kaum; ein Tag mit 15 Einträgen soll nicht 15 Anfragen kosten
const productCache = new Map();
const MAX_CACHED_PRODUCTS = 500;

async function loadProduct(userId, account, id) {
    if (productCache.has(id))
        return productCache.get(id);
    const data = await getJson(userId, account, `/products/${id}`, { notFound: true });
    if (!data)
        return null;
    const product = {
        product_id: id,
        name: String(data.name ?? "Unbekanntes Produkt"),
        producer: data.producer || null,
        base_unit: data.base_unit || "g",
        nutrients: data.nutrients ?? {},
        servings: Array.isArray(data.servings) ? data.servings : [],
    };
    if (productCache.size >= MAX_CACHED_PRODUCTS)
        productCache.clear();
    productCache.set(id, product);
    return product;
}

async function product(userId, id) {
    const productId = parseUuid(id, "product_id", "yazio_search_products");
    const account = await loadAccount(userId);
    const found = await loadProduct(userId, account, productId);
    if (!found)
        throw new HttpError(404, "Dieses Produkt gibt es bei YAZIO nicht");
    return {
        product_id: found.product_id,
        name: found.name,
        producer: found.producer,
        base_unit: found.base_unit,
        per_100: per100(found.nutrients),
        servings: found.servings.map((entry) => ({ serving: entry.serving, amount: entry.amount })),
    };
}

async function searchProducts(userId, query) {
    const text = typeof query === "string" ? query.trim() : "";
    if (text.length < 2 || text.length > 100)
        throw new HttpError(400, "Suchbegriff mit 2 bis 100 Zeichen angeben");
    const account = await loadAccount(userId);
    const params = new URLSearchParams({ query: text, sex: "male", countries: "DE", locales: "de_DE" });
    const data = await getJson(userId, account, `/products/search?${params}`);
    if (!Array.isArray(data))
        throw new HttpError(502, "YAZIO hat eine unerwartete Antwort auf die Suche geschickt");
    return data.slice(0, MAX_SEARCH_RESULTS).map((entry) => ({
        product_id: entry.product_id,
        name: entry.name,
        producer: entry.producer || null,
        verified: entry.is_verified === true,
        base_unit: entry.base_unit || "g",
        per_100: per100(entry.nutrients),
        // die Portion, die YAZIO vorschlägt (z. B. „1 Scheibe“ = 30 g)
        serving: entry.serving ?? null,
        serving_quantity: entry.serving_quantity ?? null,
        serving_amount: entry.amount ?? null,
    }));
}

/*************** Lesen ************************************************************************/
// Werte eines Eintrags in der Form des Tagebuchs. Produkte: pro Gramm mal Menge; ein
// simple_product trägt schon die Summen.
function entryNutrients(totals) {
    return {
        kcal: round(totals[KCAL], 0),
        protein: round(totals[PROTEIN]),
        carbs: round(totals[CARBS]),
        fat: round(totals[FAT]),
    };
}

function scaleNutrients(nutrients = {}, amount) {
    return entryNutrients({
        [KCAL]: nutrients[KCAL] * amount, [PROTEIN]: nutrients[PROTEIN] * amount,
        [CARBS]: nutrients[CARBS] * amount, [FAT]: nutrients[FAT] * amount,
    });
}

// Die Antwort von /user/consumed-items: laut juriadams ein Objekt mit drei Listen, laut Swagger
// eine Liste. Beides wird zu einer Liste mit type.
function flattenEntries(data) {
    if (Array.isArray(data))
        return data;
    return [
        ...(data?.products ?? []).map((entry) => ({ type: "product", ...entry })),
        ...(data?.recipe_portions ?? []).map((entry) => ({ type: "recipe_portion", ...entry })),
        ...(data?.simple_products ?? []).map((entry) => ({ type: "simple_product", ...entry })),
    ];
}

// Ein Tag: Summen und Ziele von YAZIO, die Einträge nach Mahlzeit. Die Summen rechnet YAZIO,
// nicht wir — sie stimmen dann auch mit dem überein, was die App zeigt.
async function day(userId, date) {
    const wanted = parseDate(date);
    const account = await loadAccount(userId);
    const [consumed, summary] = await Promise.all([
        getJson(userId, account, `/user/consumed-items?date=${wanted}`),
        getJson(userId, account, `/user/widgets/daily-summary?date=${wanted}`),
    ]);
    if (!consumed || !summary)
        throw new HttpError(502, "YAZIO hat eine unerwartete Antwort geschickt");

    const entries = flattenEntries(consumed);
    const ids = [...new Set(entries.filter((entry) => entry.product_id).map((entry) => entry.product_id))]
        .slice(0, MAX_PRODUCTS_PER_DAY);
    const products = new Map();
    // nacheinander: die Datenbank-Verbindung hat max: 1, und YAZIO soll nicht mit 40 Anfragen
    // gleichzeitig kommen
    for (const id of ids)
        products.set(id, await loadProduct(userId, account, id));

    const meals = {};
    for (const daytime of DAYTIMES) {
        const meal = summary.meals?.[daytime] ?? {};
        meals[daytime] = { ...entryNutrients(meal.nutrients ?? {}), goal_kcal: round(meal.energy_goal, 0), entries: [] };
    }
    for (const entry of entries) {
        const meal = meals[entry.daytime] ?? meals.snack;
        const base = { id: entry.id, type: entry.type };
        if (entry.type === "simple_product") {
            meal.entries.push({ ...base, name: entry.name, ...entryNutrients(entry.nutrients ?? {}) });
        } else if (entry.type === "recipe_portion") {
            // ein Rezept aus YAZIO selbst: Name und Werte stehen hier nicht
            meal.entries.push({ ...base, name: "Rezept aus YAZIO", portions: entry.portion_count ?? null });
        } else {
            const found = products.get(entry.product_id);
            meal.entries.push({
                ...base,
                name: found?.name ?? "Produkt",
                amount: entry.amount,
                unit: found?.base_unit ?? "g",
                ...(found ? scaleNutrients(found.nutrients, entry.amount) : {}),
            });
        }
    }

    const sum = (key) => round(DAYTIMES.reduce((total, daytime) => total + (meals[daytime][key] ?? 0), 0));
    return {
        date: wanted,
        total: { kcal: round(sum("kcal"), 0), protein: sum("protein"), carbs: sum("carbs"), fat: sum("fat") },
        goals: goalsFrom(summary.goals),
        water_ml: round(summary.water_intake, 0),
        steps: round(summary.steps, 0),
        meals,
    };
}

function goalsFrom(goals = {}) {
    return {
        kcal: round(goals[KCAL], 0),
        protein: round(goals[PROTEIN], 0),
        carbs: round(goals[CARBS], 0),
        fat: round(goals[FAT], 0),
        water_ml: round(goals.water, 0),
        steps: round(goals["activity.step"], 0),
        weight_kg: round(goals["bodyvalue.weight"]),
    };
}

async function goals(userId, date) {
    const wanted = parseDate(date);
    const account = await loadAccount(userId);
    const data = await getJson(userId, account, `/user/goals/unmodified?date=${wanted}`);
    if (!data)
        throw new HttpError(502, "YAZIO hat eine unerwartete Antwort geschickt");
    return { date: wanted, goals: goalsFrom(data) };
}

// das letzte eingetragene Gewicht am oder vor dem Tag (kg); null, wenn noch keins da ist
async function weight(userId, date) {
    const wanted = parseDate(date);
    const account = await loadAccount(userId);
    const data = await getJson(userId, account, `/user/bodyvalues/weight/last?date=${wanted}`);
    return {
        date: wanted,
        weight_kg: data && Number.isFinite(data.value) ? round(data.value) : null,
        measured_at: data?.date ?? null,
    };
}

/*************** Schreiben ********************************************************************/
async function postItems(userId, account, items) {
    await request(userId, account, "POST", "/user/consumed-items", {
        json: { products: [], recipe_portions: [], simple_products: [], ...items },
    });
}

// Ein Produkt aus der YAZIO-Datenbank eintragen. amount in Gramm bzw. Millilitern (base_unit).
// Eine Portion („1 Scheibe“) ist nur eine andere Schreibweise derselben Menge: serving und
// serving_quantity zeigen YAZIO, wie es sie anzeigen soll, gerechnet wird mit amount.
async function addProduct(userId, { product_id, amount, serving, serving_quantity, daytime, date }) {
    const productId = parseUuid(product_id, "product_id", "yazio_search_products");
    const grams = parsePositive(amount, "amount", MAX_AMOUNT);
    const meal = parseDaytime(daytime);
    const wanted = parseDate(date);
    const hasServing = serving !== undefined && serving !== null;
    if (hasServing && (typeof serving !== "string" || serving.length > 40
            || serving_quantity === undefined || serving_quantity === null))
        throw new HttpError(400, "serving (Text) und serving_quantity (Zahl) gehören zusammen");

    const account = await loadAccount(userId);
    // erst nachsehen, ob es das Produkt gibt: so kommt eine verständliche Meldung statt eines
    // abgelehnten Eintrags, und die Antwort kann den Namen nennen
    const found = await loadProduct(userId, account, productId);
    if (!found)
        throw new HttpError(404, "Dieses Produkt gibt es bei YAZIO nicht");

    const id = crypto.randomUUID();
    await postItems(userId, account, {
        products: [{
            id, product_id: productId, date: wanted, daytime: meal, amount: grams,
            serving: hasServing ? serving : null,
            serving_quantity: hasServing ? parsePositive(serving_quantity, "serving_quantity", MAX_AMOUNT) : null,
        }],
    });
    log("YAZIO: ein Produkt eingetragen");
    return {
        id, date: wanted, daytime: meal, name: found.name, amount: grams, unit: found.base_unit,
        ...scaleNutrients(found.nutrients, grams),
    };
}

// Freier Eintrag mit Namen und Summen (kcal, Gramm) — der Weg für Rezepte, die es in YAZIO
// nicht als Produkt gibt. Format beim Schreiben: siehe „UNGEPRÜFT“ oben.
async function addSimpleProduct(userId, account, { name, nutrients, daytime, date }) {
    const id = crypto.randomUUID();
    await postItems(userId, account, {
        simple_products: [{
            id, date, daytime, name,
            nutrients: {
                [KCAL]: nutrients.kcal, [PROTEIN]: nutrients.protein,
                [CARBS]: nutrients.carbs, [FAT]: nutrients.fat,
            },
            is_ai_generated: false,
        }],
    });
    return id;
}

// 1,5 statt 1.5
const german = (number) => String(number).replace(".", ",");

// Eine Portion (oder mehrere) eines Rezepts aus der Rezeptdatenbank eintragen. Die Nährwerte
// stehen pro Portion im Rezept; HIER wird mal Portionen gerechnet, nicht von der Seite oder
// vom Agenten — dieselbe Regel wie beim Skalieren und der Einkaufsliste: der Server rechnet.
async function logRecipe(userId, recipeId, portions, daytime, date) {
    const id = Number(recipeId);
    if (!Number.isInteger(id) || id < 1)
        throw new HttpError(400, "recipe_id muss eine ganze Zahl sein");
    const count = parsePositive(portions, "portions", MAX_PORTIONS);
    const meal = parseDaytime(daytime);
    const wanted = parseDate(date);

    const { rows: [recipe] } = await db.query("SELECT name, nutrients FROM recipes WHERE id = $1", [id]);
    if (!recipe)
        throw new HttpError(404, "Rezept nicht gefunden");
    if (!recipe.nutrients)
        throw new HttpError(409, `Für „${recipe.name}“ sind keine Nährwerte hinterlegt. Erst die Nährwerte `
            + "pro Portion setzen (auf der Rezeptseite beim Bearbeiten, oder mit set_recipe_nutrients).");

    const nutrients = {
        kcal: round(recipe.nutrients.kcal * count, 0),
        protein: round(recipe.nutrients.protein * count),
        carbs: round(recipe.nutrients.carbs * count),
        fat: round(recipe.nutrients.fat * count),
    };
    const name = count === 1 ? recipe.name : `${recipe.name} (${german(count)} Portionen)`;

    const account = await loadAccount(userId);
    const entryId = await addSimpleProduct(userId, account, { name, nutrients, daytime: meal, date: wanted });
    log("YAZIO: ein Rezept eingetragen");
    return { id: entryId, date: wanted, daytime: meal, name, portions: count, ...nutrients };
}

// Löscht einen Eintrag des Tagebuchs. Gemeint ist die id des Eintrags (aus yazio_day), nicht die
// des Produkts. YAZIO antwortet auch auf eine unbekannte id mit Erfolg, deshalb steht in der
// Antwort nur, was verlangt wurde.
async function removeEntry(userId, entryId) {
    const id = parseUuid(entryId, "entry_id", "yazio_day");
    const account = await loadAccount(userId);
    await request(userId, account, "DELETE", "/user/consumed-items", { json: [id] });
    log("YAZIO: ein Eintrag gelöscht");
    return { removed: id };
}

module.exports = {
    DAYTIMES,
    status, connect, disconnect,
    day, goals, weight, searchProducts, product,
    addProduct, logRecipe, removeEntry,
};
