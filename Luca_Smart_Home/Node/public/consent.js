// Freigabe-Seite des OAuth-Ablaufs (oauth.js): ein Konnektor, z. B. claude.ai, will auf den
// MCP-Server zugreifen. Der Benutzer ist hier schon angemeldet (sonst hätte der Server auf
// /login umgeleitet). Die Parameter kommen aus der Adresszeile — der Server prüft Client und
// Rücksprungadresse aber selbst, hier wird nichts davon vertraut.
import { api } from "/lib.js";

const params = new URLSearchParams(location.search);
const text = document.getElementById("consent-text");
const error = document.getElementById("consent-error");
const actions = document.getElementById("consent-actions");
const allow = document.getElementById("consent-allow");
const deny = document.getElementById("consent-deny");

function showError(message) {
    error.textContent = message;
    error.hidden = !message;
}

// approve: true = erlauben, false = ablehnen; der Server antwortet mit der Adresse, zu der der
// Browser zurückgeschickt wird (mit Code bzw. Fehler)
async function answer(approve) {
    allow.disabled = deny.disabled = true;
    showError("");
    try {
        const { redirect } = await api("/api/oauth/authorize", {
            approve,
            response_type: params.get("response_type"),
            client_id: params.get("client_id"),
            redirect_uri: params.get("redirect_uri"),
            code_challenge: params.get("code_challenge"),
            code_challenge_method: params.get("code_challenge_method"),
            state: params.get("state"),
        });
        text.textContent = approve ? "Freigegeben — du wirst zurückgeleitet …" : "Abgelehnt.";
        actions.hidden = true;
        location.assign(redirect);
    } catch (err) {
        showError(err.message);
        allow.disabled = deny.disabled = false;
    }
}

async function start() {
    try {
        const query = new URLSearchParams({
            client_id: params.get("client_id") ?? "",
            redirect_uri: params.get("redirect_uri") ?? "",
        });
        const [client, me] = await Promise.all([api(`/api/oauth/client?${query}`), api("/api/me")]);
        // textContent: der Name kommt vom Client und ist beliebiger Text
        text.textContent = `„${client.client_name}“ möchte sich mit deinem Smart Home verbinden `
            + `(Rezepte, Vorrat, Einkaufsliste) und danach zu ${client.redirect_host} zurückkehren. `
            + `Der Zugriff gilt wie dein Benutzer „${me.username}“ und lässt sich jederzeit mit `
            + "sudo node user.js token delete widerrufen. Nur erlauben, wenn du das gerade selbst gestartet hast.";
        actions.hidden = false;
    } catch (err) {
        text.textContent = "Diese Anfrage kann nicht freigegeben werden.";
        showError(err.message);
    }
}

allow.addEventListener("click", () => answer(true));
deny.addEventListener("click", () => answer(false));
start();
