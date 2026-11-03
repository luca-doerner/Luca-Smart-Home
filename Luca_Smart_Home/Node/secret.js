/*
 * Verschlüsselung für Zugangsdaten, die ein Fremddienst ausgibt (Bring!, YAZIO): AES-256-GCM.
 *
 * Beide Konnektoren speichern nicht das Passwort, sondern den refresh_token des Dienstes. Der
 * liegt verschlüsselt in der Datenbank; der Schlüssel steht nicht dort, sondern in SECRET_KEY
 * (Umgebung, 32 Byte als Hex oder Base64) oder, wenn der fehlt, in der Datei SECRET_KEY_FILE
 * (Standard /var/lib/luca-smart-home/secret.key, wird beim ersten Gebrauch angelegt, Modus 0600).
 * Wer die Datenbank allein stiehlt, kann damit nichts anfangen. Geht der Schlüssel verloren,
 * müssen sich alle Benutzer neu bei den Diensten anmelden — mehr passiert nicht.
 *
 * Gespeichert wird `iv.tag.daten` (je base64url): iv = Zufallswert je Verschlüsselung, tag = die
 * Prüfsumme von GCM. Sie sorgt dafür, dass ein verändertes oder mit einem anderen Schlüssel
 * gelesenes Stück nicht „irgendwie“ entschlüsselt, sondern abgelehnt wird.
 *
 * Eigene Datei, damit beide Konnektoren denselben Schlüssel und dasselbe Format benutzen: ein
 * zweiter Schlüssel nebenan würde heißen, dass man zwei Dateien sichern muss.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { log } = require("./log");

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
        log("Verschlüsselung: neuen Schlüssel angelegt (SECRET_KEY_FILE)");
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

module.exports = { encrypt, decrypt };
