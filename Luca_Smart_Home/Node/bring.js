/*
 * Bring! (Einkaufslisten-App): trägt die Einkaufsliste eines Rezepts in eine Bring!-Liste ein.
 *
 * Jeder Benutzer meldet sich auf der Seite „Konto“ mit seinem eigenen Bring!-Konto an (die
 * Tabelle bring_accounts). Was ein Werkzeug oder der Knopf auf der Rezeptseite tut, geht immer in
 * die Listen des Benutzers, der die Anfrage gestellt hat — auch bei einem Token von OAuth oder
 * Claude Code, denn das gehört auch zu einem Benutzer.
 *
 * Bring! hat keine offizielle API. Dieses Modul spricht dieselbe zurückentwickelte Schnittstelle
 * an wie die Community-Clients (Quelle für Pfade, Header und Body: github.com/miaucl/bring-api,
 * geprüft gegen bring_api/bring.py, const.py und types.py). Sie kann ohne Vorwarnung brechen —
 * darum steht alles in dieser einen Datei, und ihr Ausfall darf nie mehr als die bring_*-
 * Werkzeuge und den „An Bring! senden“-Knopf mitnehmen. Die Rezepte laufen ohne sie weiter.
 *
 * Kein Zusatzpaket: fetch gibt es seit Node 18 eingebaut.
 *
 * Was gespeichert wird: nicht das Passwort. Es wird nur für die Anmeldung gebraucht und danach
 * weggeworfen; behalten wird der refresh_token von Bring!, mit dem sich neue Zugriffstoken holen
 * lassen. Er liegt verschlüsselt in der Datenbank (AES-256-GCM). Der Schlüssel steht nicht in der
 * Datenbank, sondern in SECRET_KEY (Umgebung, 32 Byte als Hex oder Base64) oder, wenn der fehlt,
 * in der Datei SECRET_KEY_FILE (Standard /var/lib/luca-smart-home/secret.key, wird beim ersten
 * Gebrauch angelegt, Modus 0600). Geht der Schlüssel verloren, müssen sich alle neu bei Bring!
 * anmelden — mehr passiert nicht.
 *
 * Das Zugriffstoken (kurzlebig) liegt nur im Speicher. Passwörter und Token dürfen nirgends
 * hin, wo log() sie hinschreiben könnte: log() schreibt ins Journal und an jede offene Seite.
 * Fehlermeldungen von hier enthalten deshalb nie den Antwortkörper von Bring!.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const auth = require("./auth");
const HttpError = require("./http-error");
const recipes = require("./recipes");
const { log } = require("./log");

// BRING_API_URL gibt es nur zum Testen gegen einen Attrappen-Server, im Betrieb bleibt es leer
const BASE_URL = process.env.BRING_API_URL || "https://api.getbring.com/rest/";
const TIMEOUT_MS = 15000;
// so viele Sekunden vor dem Ablauf wird das Token schon erneuert, damit es nicht mitten in einer
// Anfrage ungültig wird
const EXPIRY_MARGIN_S = 60;
const MAX_LOGIN_FAILURES = 10;

// feste Kopfzeilen der App; der Schlüssel steckt in der Android-App, ist für alle gleich und
// steht öffentlich in allen Community-Clients — also kein Geheimnis (daher gitleaks:allow)
const BASE_HEADERS = {
    "X-BRING-API-KEY": "cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp",   // gitleaks:allow
    "X-BRING-CLIENT": "android",
    "X-BRING-APPLICATION": "bring",
    "X-BRING-COUNTRY": "DE",
};

const NOT_CONNECTED = "Bring! ist nicht verbunden — unter „Konto“ bei Bring! anmelden";
const EXPIRED = "Die Bring!-Anmeldung ist abgelaufen — unter „Konto“ neu bei Bring! anmelden";

/*************** Verschlüsselung **************************************************************/
let cachedKey = null;

function secretKey() {
    if (cachedKey)
        return cachedKey;
    const fromEnv = process.env.SECRET_KEY;
    if (fromEnv) {
        const key = /^[0-9a-f]{64}$/i.test(fromEnv) ? Buffer.from(fromEnv, "hex") : Buffer.from(fromEnv, "base64");
        if (key.length !== 32)
            throw new Error("SECRET_KEY muss 32 Byte lang sein (64 Hex-Zeichen)");
        return (cachedKey = key);
    }
    const file = process.env.SECRET_KEY_FILE || "/var/lib/luca-smart-home/secret.key";
    try {
        cachedKey = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
    } catch (err) {
        if (err.code !== "ENOENT")
            throw err;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // "wx": legt nur an, überschreibt nie — zwei gleichzeitige Starts haben so denselben Schlüssel
        try {
            fs.writeFileSync(file, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
        } catch (writeErr) {
            if (writeErr.code !== "EEXIST")
                throw writeErr;
        }
        cachedKey = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
        log("Bring!: neuen Schlüssel angelegt (SECRET_KEY_FILE)");
    }
    if (cachedKey.length !== 32)
        throw new Error("Der Schlüssel in SECRET_KEY_FILE ist nicht 32 Byte lang");
    return cachedKey;
}

function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

// null, wenn sich nichts entschlüsseln lässt (falscher Schlüssel, beschädigter Wert)
function decrypt(stored) {
    try {
        const [iv, tag, data] = stored.split(".").map((part) => Buffer.from(part, "base64url"));
        const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
    } catch {
        return null;
    }
}

/*************** Anfragen an Bring! ***********************************************************/
async function rawRequest(method, requestPath, { headers = {}, form, json } = {}) {
    const options = { method, headers: { ...BASE_HEADERS, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (form) {
        options.headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
        options.body = new URLSearchParams(form).toString();
    } else if (json) {
        options.headers["Content-Type"] = "application/json; charset=UTF-8";
        options.body = JSON.stringify(json);
    }
    try {
        return await fetch(BASE_URL + requestPath, options);
    } catch (err) {
        // Netzwerkfehler oder Zeitüberschreitung; die Meldung enthält nie den Körper der Anfrage
        throw new HttpError(502, err.name === "TimeoutError"
            ? "Bring! antwortet nicht (Zeitüberschreitung)"
            : "Bring! ist nicht erreichbar");
    }
}

function authHeaders(account, accessToken) {
    return {
        Authorization: `Bearer ${accessToken}`,
        "X-BRING-USER-UUID": account.uuid,
        "X-BRING-PUBLIC-USER-UUID": account.publicUuid ?? "",
    };
}

/*************** Konto verbinden **************************************************************/
// Zugriffstoken im Speicher: Benutzer-id -> { accessToken, expiresAt }
const sessions = new Map();
const refreshing = new Map();   // Benutzer-id -> laufende Erneuerung

function expiry(data) {
    return Date.now() + (Number(data.expires_in) || 3600) * 1000;
}

// Meldet den Benutzer bei Bring! an und merkt sich das Konto. Das Passwort geht nur hier durch.
async function connect(userId, email, password) {
    if (typeof email !== "string" || email.trim() === "" || typeof password !== "string" || password === "")
        throw new HttpError(400, "E-Mail und Passwort von Bring! angeben");
    if (email.length > 200 || password.length > 200)
        throw new HttpError(400, "E-Mail oder Passwort ist zu lang");

    const key = `bring:${userId}`;
    if (auth.blocked(key, MAX_LOGIN_FAILURES))
        throw new HttpError(429, "Zu viele fehlgeschlagene Anmeldungen bei Bring!, bitte in 15 Minuten nochmal");

    const response = await rawRequest("POST", "v2/bringauth", { form: { email: email.trim(), password } });
    if (response.status === 401 || response.status === 400) {
        auth.recordFailure(key);
        throw new HttpError(400, "Bring! hat die Anmeldung abgelehnt — E-Mail oder Passwort stimmen nicht");
    }
    if (!response.ok)
        throw new HttpError(502, `Bring!-Anmeldung fehlgeschlagen (HTTP ${response.status})`);
    const data = await response.json().catch(() => ({}));
    if (!data.access_token || !data.refresh_token || !data.uuid)
        throw new HttpError(502, "Bring! hat eine unerwartete Antwort bei der Anmeldung geschickt");

    const credentials = encrypt({ refreshToken: data.refresh_token, uuid: data.uuid, publicUuid: data.publicUuid ?? "" });
    // eine neue Anmeldung behält die gewählte Liste nicht: es kann ein anderes Konto sein
    await db.query(`
        INSERT INTO bring_accounts (user_id, email, credentials) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE
            SET email = EXCLUDED.email, credentials = EXCLUDED.credentials, list_uuid = NULL, created_at = now()`,
        [userId, email.trim(), credentials]);
    sessions.set(userId, { accessToken: data.access_token, expiresAt: expiry(data) });
    log("Bring!: ein Benutzer hat sein Konto verbunden");
    return status(userId);
}

async function disconnect(userId) {
    await db.query("DELETE FROM bring_accounts WHERE user_id = $1", [userId]);
    sessions.delete(userId);
    return { connected: false };
}

async function loadAccount(userId) {
    const { rows: [row] } = await db.query(
        "SELECT email, credentials, list_uuid FROM bring_accounts WHERE user_id = $1", [userId]);
    if (!row)
        throw new HttpError(409, NOT_CONNECTED);
    const credentials = decrypt(row.credentials);
    if (!credentials)
        throw new HttpError(409, EXPIRED);
    return { email: row.email, listUuid: row.list_uuid, ...credentials };
}

// für die Seite „Konto“: verbunden oder nicht, ohne Bring! zu fragen
async function status(userId) {
    const { rows: [row] } = await db.query(
        "SELECT email, list_uuid FROM bring_accounts WHERE user_id = $1", [userId]);
    return row ? { connected: true, email: row.email, list_uuid: row.list_uuid } : { connected: false };
}

// holt mit dem refresh_token ein neues Zugriffstoken; gelingt das nicht mehr, muss man sich neu
// anmelden (das Konto bleibt stehen, damit die Seite „abgelaufen“ statt „nicht verbunden“ sagt)
async function refresh(userId, account) {
    const response = await rawRequest("POST", "v2/bringauth/token", {
        headers: authHeaders(account, ""),
        form: { grant_type: "refresh_token", refresh_token: account.refreshToken },
    });
    const data = response.ok ? await response.json().catch(() => ({})) : {};
    if (!data.access_token) {
        sessions.delete(userId);
        if (response.status >= 500)
            throw new HttpError(502, `Bring! hat das Erneuern abgelehnt (HTTP ${response.status})`);
        throw new HttpError(409, EXPIRED);
    }
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

// Anfrage im Namen des Benutzers; bei 401 einmal das Token erneuern und wiederholen
async function request(userId, account, method, requestPath, options = {}) {
    let response = await rawRequest(method, requestPath,
        { ...options, headers: authHeaders(account, await accessToken(userId, account)) });
    if (response.status === 401) {
        sessions.delete(userId);
        response = await rawRequest(method, requestPath,
            { ...options, headers: authHeaders(account, await accessToken(userId, account)) });
    }
    if (!response.ok)
        throw new HttpError(502, `Bring! hat die Anfrage abgelehnt (HTTP ${response.status})`);
    return response;
}

/*************** Listen ***********************************************************************/
async function lists(userId) {
    const account = await loadAccount(userId);
    const response = await request(userId, account, "GET", `bringusers/${account.uuid}/lists`);
    const data = await response.json().catch(() => ({}));
    return (data.lists ?? []).map((entry) => ({ list_uuid: entry.listUuid, name: entry.name }));
}

// die Liste, die auf der Seite „Konto“ als Standard gewählt wurde; null löscht die Wahl
async function setDefaultList(userId, listUuid) {
    if (listUuid !== null) {
        if (typeof listUuid !== "string" || !(await lists(userId)).some((entry) => entry.list_uuid === listUuid))
            throw new HttpError(400, "Diese Liste gibt es im Bring!-Konto nicht");
    }
    await db.query("UPDATE bring_accounts SET list_uuid = $2 WHERE user_id = $1", [userId, listUuid]);
    return status(userId);
}

// list darf eine listUuid oder ein Name sein; ohne Angabe gilt die Standardliste des Kontos, und
// wenn es nur eine einzige Liste gibt, diese. Bei mehreren Listen wird nicht geraten: eine
// Einkaufsliste ist oft geteilt, ein Eintrag in der falschen Liste landet bei fremden Leuten.
async function resolveList(userId, list) {
    const account = await loadAccount(userId);
    const wanted = (typeof list === "string" && list.trim()) || account.listUuid || null;
    const all = await lists(userId);
    if (all.length === 0)
        throw new HttpError(502, "Im Bring!-Konto gibt es keine Liste");
    if (wanted) {
        const found = all.find((entry) => entry.list_uuid === wanted)
            ?? all.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
        if (!found)
            throw new HttpError(400, `Liste „${wanted}“ gibt es nicht. Vorhanden: ${all.map((entry) => entry.name).join(", ")}`);
        return { account, target: found };
    }
    if (all.length === 1)
        return { account, target: all[0] };
    throw new HttpError(400, `Welche Liste? Vorhanden: ${all.map((entry) => entry.name).join(", ")}. `
        + "Name oder list_uuid mitgeben oder unter „Konto“ eine Standardliste wählen.");
}

// was gerade auf der Liste steht (noch zu kaufen)
async function readItems(userId, account, target) {
    const response = await request(userId, account, "GET", `v2/bringlists/${target.list_uuid}`);
    const data = await response.json().catch(() => ({}));
    return (data.items?.purchase ?? []).map((entry) => ({
        name: entry.itemId ?? entry.name,
        spec: entry.specification ?? entry.spec ?? "",
    }));
}

async function listItems(userId, list) {
    const { account, target } = await resolveList(userId, list);
    return { list: target, items: await readItems(userId, account, target) };
}

/*************** Schreiben ********************************************************************/
function normalizeItems(items) {
    if (!Array.isArray(items) || items.length === 0)
        throw new HttpError(400, "items muss eine Liste mit mindestens einem Eintrag sein");
    if (items.length > 100)
        throw new HttpError(400, "Höchstens 100 Einträge auf einmal");
    return items.map((entry, index) => {
        const name = typeof entry?.name === "string" ? entry.name.trim() : "";
        if (name === "" || name.length > 100)
            throw new HttpError(400, `items[${index}].name fehlt oder ist zu lang`);
        const spec = entry.spec === undefined || entry.spec === null ? "" : String(entry.spec).trim();
        if (spec.length > 200)
            throw new HttpError(400, `items[${index}].spec ist zu lang`);
        return { name, spec };
    }).reduce(mergeSameName, []);
}

// Bring! hat je Name genau einen Eintrag. Kommt derselbe Name zweimal (500 g und 2 Packungen
// lassen sich nicht addieren; oder dieselbe Wahl in zwei Alternativen mit TL und EL), wird daraus
// ein Eintrag „500 g + 2 Packungen“ — sonst ginge der zweite verloren bzw. hieße fälschlich
// „stand schon auf der Liste“.
function mergeSameName(merged, entry) {
    const same = merged.find((other) => other.name.toLowerCase() === entry.name.toLowerCase());
    if (!same)
        return [...merged, entry];
    same.spec = [same.spec, entry.spec].filter(Boolean).join(" + ").slice(0, 200);
    return merged;
}

// Trägt Einträge als „zu kaufen“ ein. Was schon auf der Liste steht (gleicher Name, Groß- und
// Kleinschreibung egal), wird übersprungen und gemeldet: Bring! würde sonst die Menge des
// vorhandenen Eintrags überschreiben, und die kann jemand anderes dort hingeschrieben haben.
async function addItems(userId, items, list) {
    const wanted = normalizeItems(items);
    const { account, target } = await resolveList(userId, list);
    const present = await readItems(userId, account, target);
    const have = new Set(present.map((entry) => entry.name.toLowerCase()));

    const toAdd = [];
    const skipped = [];
    for (const entry of wanted) {
        if (have.has(entry.name.toLowerCase()))
            skipped.push(entry);
        else
            toAdd.push(entry);   // gleiche Namen hat normalizeItems schon zusammengefasst
    }

    if (toAdd.length > 0) {
        await request(userId, account, "PUT", `v2/bringlists/${target.list_uuid}/items`, {
            json: {
                changes: toAdd.map((entry) => ({
                    accuracy: "0.0", altitude: "0.0", latitude: "0.0", longitude: "0.0",
                    itemId: entry.name,
                    spec: entry.spec,
                    uuid: crypto.randomUUID(),
                    operation: "TO_PURCHASE",
                })),
                sender: "",
            },
        });
    }
    log(`Bring!: ${toAdd.length} Einträge in eine Liste, ${skipped.length} schon vorhanden`);
    return {
        list: target,
        added: toAdd,
        already_on_list: skipped,
        note: (toAdd.length === 1 ? `1 Eintrag in „${target.name}“ eingetragen.`
                                  : `${toAdd.length} Einträge in „${target.name}“ eingetragen.`)
            + (skipped.length === 0 ? ""
                : ` ${skipped.length} weitere standen schon auf der Liste und wurden nicht angefasst `
                  + "(already_on_list) — bitte dem Benutzer nennen."),
    };
}

// Rezepte -> Einkaufsliste (mit Vorrat abgezogen) -> Bring!. Das ist der Weg des Knopfes auf der
// Rezeptseite. Plan und Eintrag kommen zusammen zurück, damit auch hier from_pantry und note
// beim Benutzer ankommen.
//
// Alternativen („Chiliflocken oder Chipotle-Pulver“, plan.choices) trägt nur ein, was der
// Benutzer ausdrücklich gewählt hat: chosen ist die Liste der gewählten Namen, genau einer je
// Alternative. Ohne Wahl wird nichts geschrieben — lieber nachfragen als beides eintragen.
async function sendRecipes(userId, recipeIds, servings, list, chosen = []) {
    const plan = await recipes.planShoppingList(recipeIds, servings);
    if (!Array.isArray(chosen) || chosen.some((name) => typeof name !== "string"))
        throw new HttpError(400, "choices muss eine Liste von Namen sein");
    const picked = new Set(chosen.map((name) => name.trim().toLowerCase()));

    // erst am Ende prüfen, ob etwas übrig ist: zwei Alternativen können dieselbe Option haben,
    // dann zählt eine Wahl für beide
    const items = [...plan.items];
    const offered = new Set();
    for (const choice of plan.choices) {
        const selected = choice.options.filter((option) => picked.has(option.name.toLowerCase()));
        if (selected.length !== 1)
            throw new HttpError(400, `Bitte genau eine wählen: ${choice.question}`);
        items.push({ name: selected[0].name, spec: selected[0].spec });   // ohne in_pantry
        choice.options.forEach((option) => offered.add(option.name.toLowerCase()));
    }
    if ([...picked].some((name) => !offered.has(name)))
        throw new HttpError(400, "Die Auswahl passt nicht zu den Alternativen des Rezepts");

    if (items.length === 0)
        return { plan, bring: null, note: "Es muss nichts gekauft werden, alles ist im Vorrat." };
    return { plan, bring: await addItems(userId, items, list) };
}

module.exports = { status, connect, disconnect, lists, setDefaultList, listItems, addItems, sendRecipes };
