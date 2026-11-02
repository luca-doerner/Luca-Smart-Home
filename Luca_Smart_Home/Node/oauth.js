/*
 * OAuth 2.1 für den MCP-Server: damit sich claude.ai und die Handy-App einhängen lassen.
 *
 * Diese Anwendungen kennen keinen festen Bearer-Token, sie wollen sich selbst anmelden. Der Pi
 * wird dafür sein eigener kleiner Autorisierungsserver — und benutzt das bestehende Login:
 *
 *   1. Client ruft /api/mcp ohne Token auf        -> 401 + WWW-Authenticate (server.js) mit
 *                                                    Verweis auf /.well-known/oauth-protected-resource
 *   2. Client liest die beiden .well-known-Seiten -> weiß, wo registrieren/anmelden/Token holen
 *   3. POST /oauth/register                       -> client_id (dynamische Registrierung, RFC 7591)
 *   4. Browser: GET /oauth/authorize?...          -> ohne Login Umleitung auf /login?next=...,
 *                                                    danach die Freigabe-Seite (consent.html)
 *   5. Freigabe: POST /api/oauth/authorize        -> Code, Umleitung zurück zum Client
 *   6. POST /oauth/token                          -> Access- und Refresh-Token (PKCE S256)
 *
 * Alle Clients sind „öffentlich“ (kein Client-Secret, das kann eine Handy-App nicht geheim
 * halten). Geschützt wird der Code stattdessen durch PKCE: der Client schickt anfangs den Hash
 * eines Geheimnisses (code_challenge) und beweist beim Token-Abruf, dass er es kennt
 * (code_verifier). Wer den Code abfängt, kann damit ohne das Geheimnis nichts anfangen.
 *
 * Die Access-Tokens sind gewöhnliche Zeilen in api_tokens (Name "oauth:<client_id>", Laufzeit
 * eine Stunde), damit auth.js und mcp.js keinen Unterschied kennen. Pro Benutzer und Client gibt
 * es immer nur eines: ein neues ersetzt das alte. Refresh-Tokens (30 Tage) werden bei jeder
 * Benutzung ausgetauscht; ein schon benutztes ist ungültig.
 *
 * Fehler an den Endpunkten /oauth/register und /oauth/token haben die Form, die RFC 6749 und
 * RFC 7591 vorschreiben ({ error, error_description }) — nicht die { error: "Text" } der übrigen
 * API, denn die Clients, die hier lesen, erwarten genau diese Codes.
 */
const crypto = require("crypto");
const db = require("./db");
const auth = require("./auth");
const HttpError = require("./http-error");
const { log } = require("./log");

const CODE_MINUTES = 10;
const ACCESS_SECONDS = 60 * 60;
const REFRESH_DAYS = 30;
const MAX_CLIENTS = 200;
const MAX_REGISTRATIONS_PER_IP = 20;
const CLIENT_KEEP_DAYS = 7;   // eine Registrierung ohne Freigabe verfällt nach so vielen Tagen

class OAuthError extends Error {
    constructor(status, error, description) {
        super(description);
        this.status = status;
        this.error = error;
    }
}

/*************** Adressen und Antworten *******************************************************/
// Die öffentliche Adresse, unter der der Pi erreichbar ist (Cloudflare-Tunnel). PUBLIC_URL
// überschreibt sie; sonst kommt sie aus der Anfrage, wie schon beim Secure-Cookie in auth.js.
function baseUrl(req) {
    if (process.env.PUBLIC_URL)
        return process.env.PUBLIC_URL.replace(/\/+$/, "");
    const https = req.socket.encrypted === true || req.headers["x-forwarded-proto"] === "https";
    return `${https ? "https" : "http"}://${req.headers.host}`;
}

// Die Endpunkte für Programme dürfen von jeder Seite aus aufgerufen werden (ein Browser-Client
// wie der MCP Inspector braucht das). Das ist hier sicher, weil sie weder ein Cookie noch sonst
// eine Anmeldung auswerten: der Code und PKCE beweisen die Berechtigung.
const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
};

function send(res, status, body, extra = {}) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        ...CORS,
        ...extra,
    });
    res.end(JSON.stringify(body));
}

function sendError(res, err) {
    if (!(err instanceof OAuthError))
        throw err;
    send(res, err.status, { error: err.error, error_description: err.message });
}

function preflight(req, res) {
    res.writeHead(204, CORS);
    res.end();
}

/*************** Metadaten ********************************************************************/
// RFC 9728: welche Ressource das ist und wer ihre Tokens ausstellt
function protectedResourceMetadata(req, res) {
    const base = baseUrl(req);
    send(res, 200, {
        resource: `${base}/api/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ["header"],
        resource_name: "Luca Smart Home — Rezepte",
    });
}

// RFC 8414: die Adressen des Autorisierungsservers
function authorizationServerMetadata(req, res) {
    const base = baseUrl(req);
    send(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
    });
}

// Wert für den Header WWW-Authenticate einer 401-Antwort von /api/mcp
function challenge(req) {
    return `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`;
}

/*************** Registrierung ****************************************************************/
// Rücksprungadressen: https, oder http nur auf dem eigenen Rechner (Claude Code lauscht auf
// http://localhost:<port>). Alles andere würde den Code im Klartext durchs Netz schicken.
function validRedirectUri(value) {
    if (typeof value !== "string" || value.length > 500)
        return false;
    let url;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.hash !== "" || url.username !== "" || url.password !== "")
        return false;
    if (url.protocol === "https:")
        return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

async function register(req, res, body) {
    const ipKey = `reg:${auth.clientIp(req)}`;
    if (auth.blocked(ipKey, MAX_REGISTRATIONS_PER_IP))
        throw new OAuthError(429, "temporarily_unavailable", "Zu viele Registrierungen, bitte später nochmal");

    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(validRedirectUri))
        throw new OAuthError(400, "invalid_redirect_uri",
            "redirect_uris: ein bis fünf Adressen, https:// oder http://localhost");
    const name = typeof body.client_name === "string" && body.client_name.trim() !== ""
        ? body.client_name.trim().slice(0, 100)
        : "Unbenannter Client";

    // Aufräumen: Registrierungen ohne Freigabe und abgelaufene Tokens von OAuth
    await db.query(`
        DELETE FROM oauth_clients c
        WHERE c.created_at < now() - make_interval(days => $1)
          AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r
                          WHERE r.client_id = c.client_id AND r.expires_at > now())`, [CLIENT_KEEP_DAYS]);
    await db.query("DELETE FROM api_tokens WHERE name LIKE 'oauth:%' AND expires_at <= now()");
    await db.query("DELETE FROM oauth_codes WHERE expires_at <= now()");
    await db.query("DELETE FROM oauth_refresh_tokens WHERE expires_at <= now()");
    const { rows: [{ count }] } = await db.query("SELECT count(*)::int AS count FROM oauth_clients");
    if (count >= MAX_CLIENTS)
        throw new OAuthError(429, "temporarily_unavailable", "Zu viele registrierte Clients");

    const clientId = crypto.randomBytes(18).toString("base64url");
    await db.query("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)",
        [clientId, name, uris]);
    auth.recordFailure(ipKey);   // zählt jede Registrierung, nicht nur Fehler
    log(`OAuth: Client „${name}“ registriert`);
    send(res, 201, {
        client_id: clientId,
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(Date.now() / 1000),
    });
}

/*************** Freigabe ("authorize") *******************************************************/
async function findClient(clientId, redirectUri) {
    const { rows: [client] } = typeof clientId === "string"
        ? await db.query("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1", [clientId])
        : { rows: [] };
    if (!client)
        throw new HttpError(400, "Unbekannter Client — bitte den Konnektor neu hinzufügen");
    // genau gleich, nicht „beginnt mit“: sonst könnte eine ähnliche Adresse den Code abgreifen
    if (!client.redirect_uris.includes(redirectUri))
        throw new HttpError(400, "Die Rücksprungadresse gehört nicht zu diesem Client");
    return client;
}

// für die Freigabe-Seite: wer fragt und wohin es danach zurückgeht
async function describeClient(clientId, redirectUri) {
    const client = await findClient(clientId, redirectUri);
    return { client_name: client.client_name, redirect_host: new URL(redirectUri).host };
}

function redirectTo(redirectUri, params) {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params))
        if (value !== undefined && value !== null && value !== "")
            url.searchParams.set(key, value);
    return { redirect: url.toString() };
}

// Antwort der Freigabe-Seite. Client und Rücksprungadresse werden hier selbst geprüft und nicht
// aus der Adresszeile übernommen; bei einer ungültigen Kombination wird nie umgeleitet.
async function decide(user, body) {
    if (user.viaToken)
        throw new HttpError(403, "Die Freigabe geht nur mit einer Anmeldung im Browser");
    const { client_id: clientId, redirect_uri: redirectUri, state } = body ?? {};
    await findClient(clientId, redirectUri);

    if (body.approve !== true)
        return redirectTo(redirectUri, { error: "access_denied", state });
    if (body.response_type !== "code")
        return redirectTo(redirectUri, { error: "unsupported_response_type", state });
    if (body.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge ?? ""))
        return redirectTo(redirectUri, {
            error: "invalid_request", error_description: "PKCE mit S256 ist Pflicht", state,
        });

    const code = crypto.randomBytes(32).toString("base64url");
    await db.query(`
        INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
        [auth.tokenHash(code), clientId, user.id, redirectUri, body.code_challenge, CODE_MINUTES]);
    log(`OAuth: ${user.username} hat einen Client freigegeben`);
    return redirectTo(redirectUri, { code, state });
}

/*************** Token ************************************************************************/
// Access- und Refresh-Token ausstellen. Das Access-Token ersetzt das bisherige desselben Clients
// (gleicher Name, siehe der Unique-Index auf api_tokens), damit nichts liegen bleibt.
async function issueTokens(clientId, userId) {
    const name = `oauth:${clientId}`;
    const access = crypto.randomBytes(32).toString("base64url");
    const refresh = crypto.randomBytes(32).toString("base64url");
    await db.query("DELETE FROM api_tokens WHERE user_id = $1 AND lower(name) = lower($2)", [userId, name]);
    await db.query(`
        INSERT INTO api_tokens (token_hash, user_id, name, expires_at)
        VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
        [auth.tokenHash(access), userId, name, ACCESS_SECONDS]);
    await db.query(`
        INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, expires_at)
        VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
        [auth.tokenHash(refresh), clientId, userId, REFRESH_DAYS]);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh };
}

function requireText(params, key) {
    const value = params[key];
    if (typeof value !== "string" || value === "")
        throw new OAuthError(400, "invalid_request", `${key} fehlt`);
    return value;
}

async function exchangeCode(params) {
    const code = requireText(params, "code");
    const verifier = requireText(params, "code_verifier");
    const clientId = requireText(params, "client_id");
    const redirectUri = requireText(params, "redirect_uri");

    // zuerst löschen, dann prüfen: ein Code gilt nur für einen Versuch, auch für einen falschen
    const { rows: [row] } = await db.query(`
        DELETE FROM oauth_codes WHERE code_hash = $1 AND expires_at > now()
        RETURNING client_id, user_id, redirect_uri, code_challenge`, [auth.tokenHash(code)]);
    const expected = row && crypto.createHash("sha256").update(verifier).digest("base64url");
    const valid = row
        && /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)
        && row.client_id === clientId
        && row.redirect_uri === redirectUri
        && expected.length === row.code_challenge.length
        && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(row.code_challenge));
    if (!valid)
        throw new OAuthError(400, "invalid_grant", "Code ungültig, abgelaufen oder schon benutzt");
    return issueTokens(clientId, row.user_id);
}

async function exchangeRefresh(params) {
    const refresh = requireText(params, "refresh_token");
    const clientId = requireText(params, "client_id");
    const { rows: [row] } = await db.query(`
        DELETE FROM oauth_refresh_tokens
        WHERE token_hash = $1 AND client_id = $2 AND expires_at > now()
        RETURNING user_id`, [auth.tokenHash(refresh), clientId]);
    if (!row)
        throw new OAuthError(400, "invalid_grant", "Refresh-Token ungültig, abgelaufen oder schon benutzt");
    return issueTokens(clientId, row.user_id);
}

// params: Formularfelder oder JSON (server.js liest beides)
async function token(req, res, params) {
    const ipKey = `ip:${auth.clientIp(req)}`;
    if (auth.blocked(ipKey, 10))
        throw new OAuthError(429, "temporarily_unavailable", "Zu viele fehlgeschlagene Versuche, bitte später nochmal");
    try {
        let tokens;
        switch (params.grant_type) {
            case "authorization_code":
                tokens = await exchangeCode(params);
                break;
            case "refresh_token":
                tokens = await exchangeRefresh(params);
                break;
            default:
                throw new OAuthError(400, "unsupported_grant_type", "grant_type muss authorization_code oder refresh_token sein");
        }
        send(res, 200, tokens);
    } catch (err) {
        if (err instanceof OAuthError && err.error === "invalid_grant")
            auth.recordFailure(ipKey);
        throw err;
    }
}

module.exports = {
    OAuthError, sendError, preflight, baseUrl, challenge,
    protectedResourceMetadata, authorizationServerMetadata,
    register, describeClient, decide, token,
};
