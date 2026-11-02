// Login with username and password (tables users and sessions, api_tokens).
//
// - passwords are stored as scrypt hash with a random salt, never in plain text
// - after the login the browser gets a random 256 bit token in an HttpOnly cookie; the database
//   only keeps its SHA-256 hash; the session lasts SESSION_DAYS and is extended while it is used
// - too many failed logins per IP / user are blocked for a while
// - Programme (der MCP-Server, mcp.js) melden sich stattdessen mit "Authorization: Bearer ..."
//   an; das hängt an genau einer Stelle (userFromRequest), dadurch ist die ganze API damit
//   erreichbar, ohne dass eine Route sich ändert
const crypto = require("crypto");
const { promisify } = require("util");
const db = require("./db");
const HttpError = require("./http-error");
const { log } = require("./log");

const scrypt = promisify(crypto.scrypt);
// N = 2^14: about 16 MB memory and well below a second on a Raspberry Pi
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD_LENGTH = 10;

const SESSION_COOKIE = "sid";
const SESSION_DAYS = 30;
const SESSION_REFRESH_MS = 60 * 60 * 1000;   // a used session is extended at most once per hour

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 10;
const MAX_FAILURES_PER_USER = 20;

/*************** Passwords ********************************************************************/
async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
    return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
    const [algorithm, N, r, p, salt, hash] = stored.split("$");
    if (algorithm !== "scrypt")
        return false;
    const expected = Buffer.from(hash, "base64");
    const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length,
        { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(actual, expected);
}

function checkPasswordRules(password) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH)
        throw new HttpError(400, `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein`);
}

// checked for unknown users too, so the answer does not tell whether a user exists
let dummyHash = null;

/*************** Failed Logins ****************************************************************/
const failures = new Map();   // "ip:<ip>" / "user:<name>" -> { count, until }

function blocked(key, max) {
    const entry = failures.get(key);
    return entry !== undefined && entry.until > Date.now() && entry.count >= max;
}

function recordFailure(key) {
    const now = Date.now();
    const entry = failures.get(key);
    if (!entry || entry.until <= now)
        failures.set(key, { count: 1, until: now + LOGIN_WINDOW_MS });
    else
        entry.count++;
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of failures)
        if (entry.until <= now)
            failures.delete(key);
}, LOGIN_WINDOW_MS).unref();

// behind the Cloudflare tunnel every request comes from cloudflared on the Pi itself
function clientIp(req) {
    return req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
}

/*************** Cookie ***********************************************************************/
function isHttps(req) {
    return req.socket.encrypted === true || req.headers["x-forwarded-proto"] === "https";
}

// Secure only over HTTPS (Cloudflare), otherwise the browser would not keep the cookie on
// http://<pi>:5000 in the home network
function sessionCookie(req, token, maxAgeSeconds) {
    return [
        `${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`,
        isHttps(req) ? "Secure" : null,
    ].filter(Boolean).join("; ");
}

function sessionToken(req) {
    for (const part of (req.headers.cookie ?? "").split(";")) {
        const [name, ...value] = part.trim().split("=");
        if (name === SESSION_COOKIE)
            return value.join("=");
    }
    return null;
}

function tokenHash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

/*************** Sessions *********************************************************************/
// the logged in user of the request ({ id, username }) or null; extends the session and its
// cookie (on res) at most once per SESSION_REFRESH_MS
async function userFromSession(req, res) {
    const token = sessionToken(req);
    if (!token)
        return null;
    const { rows: [session] } = await db.query(`
        SELECT s.token_hash, s.last_seen_at, u.id, u.username
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash(token)]);
    if (!session)
        return null;

    if (Date.now() - session.last_seen_at.getTime() > SESSION_REFRESH_MS) {
        await db.query(`
            UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2)
            WHERE token_hash = $1`, [session.token_hash, SESSION_DAYS]);
        res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_DAYS * 24 * 60 * 60));
    }
    return { id: session.id, username: session.username };
}

/*************** API-Tokens ******************************************************************/
// "Authorization: Bearer <token>" statt Cookie, für Programme
function bearerToken(req) {
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
}

// Benutzer zu einem API-Token oder null. Falsche Tokens zählen in dieselbe Sperre wie falsche
// Passwörter (blocked / recordFailure), damit niemand Tokens durchprobieren kann.
async function userFromToken(req) {
    const token = bearerToken(req);
    if (!token)
        return null;
    const ipKey = `ip:${clientIp(req)}`;
    if (blocked(ipKey, MAX_FAILURES_PER_IP))
        throw new HttpError(429, "Zu viele fehlgeschlagene Versuche, bitte in 15 Minuten nochmal");

    const { rows: [row] } = await db.query(`
        SELECT t.token_hash, t.last_used_at, u.id, u.username
        FROM api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > now())`, [tokenHash(token)]);
    if (!row) {
        recordFailure(ipKey);
        log(`Unbekanntes API-Token von ${clientIp(req)}`);
        return null;
    }

    // last_used_at nur höchstens einmal pro Stunde schreiben, sonst schreibt jede Anfrage
    // in die Datenbank (und db.js hat nur eine Verbindung)
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > SESSION_REFRESH_MS)
        await db.query("UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1", [row.token_hash]);
    return { id: row.id, username: row.username, viaToken: true };
}

// Cookie zuerst, dann Bearer: ein Browser bringt immer sein Cookie mit, ein Programm nie
async function userFromRequest(req, res) {
    return (await userFromSession(req, res)) ?? (await userFromToken(req));
}

// legt ein Token an und gibt es genau einmal zurück — gespeichert wird nur sein Hash,
// das Token selbst steht nirgends in der Datenbank (wie bei den Sessions)
async function createApiToken(userId, name, days = null) {
    const token = crypto.randomBytes(32).toString("base64url");
    await db.query(`
        INSERT INTO api_tokens (token_hash, user_id, name, expires_at)
        VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL
                                 ELSE now() + make_interval(days => $4::int) END)`,
        [tokenHash(token), userId, name, days]);
    return token;
}

async function listApiTokens() {
    const { rows } = await db.query(`
        SELECT t.name, u.username, t.created_at, t.last_used_at, t.expires_at
        FROM api_tokens t JOIN users u ON u.id = t.user_id
        ORDER BY lower(u.username), lower(t.name)`);
    return rows;
}

async function deleteApiToken(userId, name) {
    const { rowCount } = await db.query(
        "DELETE FROM api_tokens WHERE user_id = $1 AND lower(name) = lower($2)", [userId, name]);
    return rowCount;
}

// checks username and password, starts a session and sets its cookie
async function login(req, res, { username, password }) {
    if (typeof username !== "string" || typeof password !== "string" || username === "" || password === "")
        throw new HttpError(400, "Benutzername und Passwort angeben");

    const ipKey = `ip:${clientIp(req)}`;
    const userKey = `user:${username.toLowerCase()}`;
    if (blocked(ipKey, MAX_FAILURES_PER_IP) || blocked(userKey, MAX_FAILURES_PER_USER))
        throw new HttpError(429, "Zu viele fehlgeschlagene Anmeldungen, bitte in 15 Minuten nochmal versuchen");

    const { rows: [user] } = await db.query(
        "SELECT id, username, password_hash FROM users WHERE lower(username) = lower($1)", [username]);
    dummyHash ??= await hashPassword(crypto.randomBytes(16).toString("hex"));
    const valid = await verifyPassword(password, user ? user.password_hash : dummyHash);
    if (!user || !valid) {
        recordFailure(ipKey);
        recordFailure(userKey);
        log(`Fehlgeschlagene Anmeldung für "${username}" von ${clientIp(req)}`);
        throw new HttpError(401, "Benutzername oder Passwort falsch");
    }

    failures.delete(ipKey);
    failures.delete(userKey);
    await db.query("DELETE FROM sessions WHERE expires_at <= now()");
    const token = crypto.randomBytes(32).toString("base64url");
    await db.query(`
        INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
        VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
        [tokenHash(token), user.id, SESSION_DAYS, (req.headers["user-agent"] ?? "").slice(0, 300)]);
    res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_DAYS * 24 * 60 * 60));
    log(`${user.username} hat sich angemeldet (${clientIp(req)})`);
    return { username: user.username };
}

async function logout(req, res) {
    const token = sessionToken(req);
    if (token)
        await db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
    res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
}

module.exports = {
    hashPassword, checkPasswordRules, userFromRequest, login, logout,
    createApiToken, listApiTokens, deleteApiToken,
};
