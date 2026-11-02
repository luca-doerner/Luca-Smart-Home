/*
 * Bring! (Einkaufslisten-App): trägt die Einkaufsliste eines Rezepts in eine Bring!-Liste ein.
 *
 * Bring! hat keine offizielle API. Dieses Modul spricht dieselbe zurückentwickelte Schnittstelle
 * an wie die Community-Clients (Quelle für Pfade, Header und Body: github.com/miaucl/bring-api,
 * geprüft gegen bring_api/bring.py, const.py und types.py). Sie kann ohne Vorwarnung brechen —
 * darum steht alles in dieser einen Datei, und ihr Ausfall darf nie mehr als die bring_*-
 * Werkzeuge und den „An Bring! senden“-Knopf mitnehmen. Die Rezepte laufen ohne sie weiter.
 *
 * Kein Zusatzpaket: fetch gibt es seit Node 18 eingebaut.
 *
 * Zugangsdaten stehen in der Umgebung (/etc/luca-smart-home.env):
 *   BRING_EMAIL, BRING_PASSWORD   Konto von Bring!
 *   BRING_LIST_UUID               (optional) Standardliste, damit die KI nicht jedes Mal wählen muss
 *
 * Das Passwort darf nirgends hin, wo log() es hinschreiben könnte: log() schreibt ins Journal und
 * an jede offene Seite. Fehlermeldungen von hier enthalten deshalb nie den Antwortkörper von Bring!.
 *
 * Das Zugriffstoken liegt nur im Speicher. Nach einem Neustart wird neu angemeldet.
 */
const crypto = require("crypto");
const HttpError = require("./http-error");
const recipes = require("./recipes");
const { log } = require("./log");

// BRING_API_URL gibt es nur zum Testen gegen einen Attrappen-Server, im Betrieb bleibt es leer
const BASE_URL = process.env.BRING_API_URL || "https://api.getbring.com/rest/";
const TIMEOUT_MS = 15000;
// so viele Sekunden vor dem Ablauf wird das Token schon erneuert, damit es nicht mitten in einer
// Anfrage ungültig wird
const EXPIRY_MARGIN_S = 60;

// feste Kopfzeilen der App; der Schlüssel steckt in der Android-App, ist für alle gleich und
// steht öffentlich in allen Community-Clients — also kein Geheimnis (daher gitleaks:allow)
const BASE_HEADERS = {
    "X-BRING-API-KEY": "cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp",   // gitleaks:allow
    "X-BRING-CLIENT": "android",
    "X-BRING-APPLICATION": "bring",
    "X-BRING-COUNTRY": "DE",
};

function credentials() {
    const email = process.env.BRING_EMAIL;
    const password = process.env.BRING_PASSWORD;
    if (!email || !password)
        throw new HttpError(503, "Bring! ist nicht eingerichtet (BRING_EMAIL und BRING_PASSWORD fehlen)");
    return { email, password };
}

/*************** Anmeldung ********************************************************************/
let session = null;        // { accessToken, refreshToken, expiresAt, uuid, publicUuid }
let loginRunning = null;   // laufende Anmeldung, damit zwei Anfragen nicht zweimal anmelden

async function rawRequest(method, path, { headers = {}, form, json } = {}) {
    const options = { method, headers: { ...BASE_HEADERS, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (form) {
        options.headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
        options.body = new URLSearchParams(form).toString();
    } else if (json) {
        options.headers["Content-Type"] = "application/json; charset=UTF-8";
        options.body = JSON.stringify(json);
    }
    try {
        return await fetch(BASE_URL + path, options);
    } catch (err) {
        // Netzwerkfehler oder Zeitüberschreitung; err.message könnte die URL enthalten, aber
        // keine Zugangsdaten (die stehen im Körper)
        throw new HttpError(502, err.name === "TimeoutError"
            ? "Bring! antwortet nicht (Zeitüberschreitung)"
            : "Bring! ist nicht erreichbar");
    }
}

async function login() {
    const { email, password } = credentials();
    const response = await rawRequest("POST", "v2/bringauth", { form: { email, password } });
    if (response.status === 401 || response.status === 400) {
        session = null;
        throw new HttpError(502, "Bring!-Anmeldung abgelehnt — E-Mail oder Passwort stimmen nicht "
            + "(BRING_EMAIL / BRING_PASSWORD prüfen)");
    }
    if (!response.ok)
        throw new HttpError(502, `Bring!-Anmeldung fehlgeschlagen (HTTP ${response.status})`);
    const data = await response.json().catch(() => ({}));
    if (!data.access_token || !data.uuid)
        throw new HttpError(502, "Bring! hat eine unerwartete Antwort bei der Anmeldung geschickt");
    session = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
        uuid: data.uuid,
        publicUuid: data.publicUuid ?? "",
    };
    log("Bring!: angemeldet");
}

// versucht zuerst das Erneuern mit dem refresh_token, meldet sonst neu an
async function refresh() {
    if (session?.refreshToken) {
        const response = await rawRequest("POST", "v2/bringauth/token", {
            headers: authHeaders(),
            form: { grant_type: "refresh_token", refresh_token: session.refreshToken },
        });
        if (response.ok) {
            const data = await response.json().catch(() => ({}));
            if (data.access_token) {
                session.accessToken = data.access_token;
                session.expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
                return;
            }
        }
    }
    await login();
}

function authHeaders() {
    return {
        Authorization: `Bearer ${session.accessToken}`,
        "X-BRING-USER-UUID": session.uuid,
        "X-BRING-PUBLIC-USER-UUID": session.publicUuid,
    };
}

async function ensureSession() {
    credentials();   // fehlt die Einrichtung, soll das die erste und klarste Meldung sein
    if (session && session.expiresAt - EXPIRY_MARGIN_S * 1000 > Date.now())
        return;
    loginRunning ??= (session ? refresh() : login()).finally(() => { loginRunning = null; });
    await loginRunning;
}

// Anfrage mit Anmeldung; bei 401 einmal neu anmelden und wiederholen
async function request(method, path, options = {}) {
    await ensureSession();
    let response = await rawRequest(method, path, { ...options, headers: authHeaders() });
    if (response.status === 401) {
        session = null;
        await ensureSession();
        response = await rawRequest(method, path, { ...options, headers: authHeaders() });
    }
    if (!response.ok)
        throw new HttpError(502, `Bring! hat die Anfrage abgelehnt (HTTP ${response.status})`);
    return response;
}

/*************** Listen ***********************************************************************/
async function lists() {
    await ensureSession();
    const response = await request("GET", `bringusers/${session.uuid}/lists`);
    const data = await response.json().catch(() => ({}));
    return (data.lists ?? []).map((entry) => ({ list_uuid: entry.listUuid, name: entry.name }));
}

// list darf eine listUuid oder ein Name sein; ohne Angabe gilt BRING_LIST_UUID, und wenn es nur
// eine einzige Liste gibt, diese. Bei mehreren Listen wird nicht geraten: eine Einkaufsliste ist
// geteilt, ein Eintrag in der falschen Liste landet bei fremden Leuten.
async function resolveList(list) {
    const wanted = (typeof list === "string" && list.trim()) || process.env.BRING_LIST_UUID || null;
    const all = await lists();
    if (all.length === 0)
        throw new HttpError(502, "Im Bring!-Konto gibt es keine Liste");
    if (wanted) {
        const found = all.find((entry) => entry.list_uuid === wanted)
            ?? all.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
        if (!found)
            throw new HttpError(400, `Liste „${wanted}“ gibt es nicht. Vorhanden: ${all.map((entry) => entry.name).join(", ")}`);
        return found;
    }
    if (all.length === 1)
        return all[0];
    throw new HttpError(400, `Welche Liste? Vorhanden: ${all.map((entry) => entry.name).join(", ")}. `
        + "Name oder list_uuid mitgeben (oder BRING_LIST_UUID setzen).");
}

// was gerade auf der Liste steht (noch zu kaufen)
async function listItems(list) {
    const target = await resolveList(list);
    const response = await request("GET", `v2/bringlists/${target.list_uuid}`);
    const data = await response.json().catch(() => ({}));
    const items = (data.items?.purchase ?? []).map((entry) => ({
        name: entry.itemId ?? entry.name,
        spec: entry.specification ?? entry.spec ?? "",
    }));
    return { list: target, items };
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
    });
}

// Trägt Einträge als „zu kaufen“ ein. Was schon auf der Liste steht (gleicher Name, Groß- und
// Kleinschreibung egal), wird übersprungen und gemeldet: Bring! würde sonst die Menge des
// vorhandenen Eintrags überschreiben, und die kann jemand anderes dort hingeschrieben haben.
async function addItems(items, list) {
    const wanted = normalizeItems(items);
    const { list: target, items: present } = await listItems(list);
    const have = new Set(present.map((entry) => entry.name.toLowerCase()));

    const toAdd = [];
    const skipped = [];
    for (const entry of wanted) {
        if (have.has(entry.name.toLowerCase()))
            skipped.push(entry);
        else {
            have.add(entry.name.toLowerCase());   // zweimal derselbe Name in einem Aufruf
            toAdd.push(entry);
        }
    }

    if (toAdd.length > 0) {
        await request("PUT", `v2/bringlists/${target.list_uuid}/items`, {
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
    log(`Bring!: ${toAdd.length} Einträge in „${target.name}“, ${skipped.length} schon vorhanden`);
    return {
        list: target,
        added: toAdd,
        already_on_list: skipped,
        note: (toAdd.length === 1 ? `1 Eintrag in „${target.name}“ eingetragen.`
                                  : `${toAdd.length} Einträge in „${target.name}“ eingetragen.`)
            + (skipped.length === 0 ? ""
                : ` ${skipped.length} davon standen schon auf der Liste und wurden nicht angefasst — `
                  + "bitte dem Benutzer nennen."),
    };
}

// Rezepte -> Einkaufsliste (mit Vorrat abgezogen) -> Bring!. Das ist der Weg des Knopfes auf der
// Rezeptseite. Plan und Eintrag kommen zusammen zurück, damit auch hier from_pantry und note
// beim Benutzer ankommen.
async function sendRecipes(recipeIds, servings, list) {
    const plan = await recipes.planShoppingList(recipeIds, servings);
    if (plan.items.length === 0)
        return { plan, bring: null, note: "Es muss nichts gekauft werden, alles ist im Vorrat." };
    return { plan, bring: await addItems(plan.items, list) };
}

module.exports = { lists, listItems, addItems, sendRecipes };
