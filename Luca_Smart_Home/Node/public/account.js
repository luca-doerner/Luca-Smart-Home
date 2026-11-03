/*
 * Die Seite /account „Konto“: hier meldet sich jeder Benutzer selbst bei seinem Bring!- und seinem
 * YAZIO-Konto an.
 *
 * Das Passwort geht einmal an den Server, der damit beim Dienst anmeldet und es sofort wieder
 * vergisst (bring.js, yazio.js). Gespeichert wird nur ein verschlüsselter Zugriffsschlüssel. Danach
 * landen die Einkaufslisten dieses Benutzers in seinem Bring! und seine Mahlzeiten in seinem YAZIO,
 * auch wenn eine KI sie über den MCP-Server schickt.
 */
import { api, breadcrumb, el, errorBox, icon, showPage } from "./lib.js";

// Standardliste: wird beim Umstellen sofort gespeichert, wie die Schalter auf der Vorratsseite
function listPicker(lists, current, errors) {
    const select = el("select", { id: "bring-list" },
        el("option", { value: "" }, lists.length > 1 ? "Immer nachfragen" : "Die einzige Liste"),
        lists.map((list) => el("option", { value: list.list_uuid, selected: list.list_uuid === current }, list.name)));
    const status = el("p", { class: "form-status muted", role: "status" });
    select.addEventListener("change", async () => {
        select.disabled = true;
        status.textContent = "";
        try {
            await api("/api/bring/list", { list_uuid: select.value || null });
            status.textContent = "Gespeichert";
            errors.show("bring-list", "");
        } catch (err) {
            errors.show("bring-list", `Liste speichern fehlgeschlagen: ${err.message}`);
        } finally {
            select.disabled = false;
        }
    });
    return el("div", { class: "form-field" },
        el("label", { for: "bring-list" }, "Standardliste"),
        select,
        el("p", { class: "muted hint" }, "In diese Liste geht „An Bring! senden“ und was eine KI einträgt, "
            + "wenn sie keine andere nennt. Bei mehreren Listen und ohne Auswahl fragt die KI nach."),
        status);
}

function connectedCard(account, lists, errors, reload) {
    const logout = el("button", { type: "button", class: "button" }, "Trennen");
    logout.addEventListener("click", async () => {
        logout.disabled = true;
        try {
            await api("/api/bring/logout", {});
            await reload();
        } catch (err) {
            logout.disabled = false;
            errors.show("bring-logout", `Trennen fehlgeschlagen: ${err.message}`);
        }
    });
    return el("section", { class: "card settings-form" },
        el("h3", {}, "Bring!"),
        el("p", {}, "Verbunden als ", el("strong", {}, account.email), "."),
        lists === null
            ? el("p", { class: "muted hint" }, "Die Listen konnten gerade nicht geladen werden. Ist die "
                + "Anmeldung abgelaufen, hilft „Trennen“ und danach neu anmelden.")
            : listPicker(lists, account.list_uuid, errors),
        el("div", { class: "form-actions" }, logout));
}

// service: was sich zwischen Bring! und YAZIO unterscheidet
const BRING = {
    key: "bring", name: "Bring!", icon: "cart",
    description: "Melde dich mit deinem Bring!-Konto an, dann kann „An Bring! senden“ deine Einkaufsliste "
        + "füllen. Das Passwort wird nur zum Anmelden benutzt und nicht gespeichert; behalten wird "
        + "ein verschlüsselter Zugriffsschlüssel, den du hier jederzeit mit „Trennen“ löschen kannst.",
};
const YAZIO = {
    key: "yazio", name: "YAZIO", icon: "food",
    description: "Melde dich mit deinem YAZIO-Konto an, dann kann „Portion nach YAZIO“ ein Rezept in dein "
        + "Tagebuch eintragen, und die Seite „Ernährung“ zeigt deinen Tag. YAZIO hat keine offizielle "
        + "Schnittstelle: das hier nutzt die der App und kann jederzeit aufhören zu gehen. Das Passwort "
        + "wird nur zum Anmelden benutzt und nicht gespeichert; behalten wird ein verschlüsselter "
        + "Zugriffsschlüssel, den du hier jederzeit mit „Trennen“ löschen kannst.",
};

function loginCard(service, errors, reload) {
    const email = el("input", {
        type: "email", id: `${service.key}-email`, required: true, maxlength: 200,
        autocomplete: "off", autocapitalize: "none", spellcheck: "false",
    });
    const password = el("input", {
        type: "password", id: `${service.key}-password`, required: true, maxlength: 200, autocomplete: "off",
    });
    const button = el("button", { type: "submit", class: "button primary" },
        icon(service.icon), `Bei ${service.name} anmelden`);
    const form = el("form", { class: "card settings-form" },
        el("h3", {}, service.name),
        el("p", { class: "muted form-description" }, service.description),
        el("div", { class: "form-row" },
            el("div", { class: "form-field" },
                el("label", { for: `${service.key}-email` }, `E-Mail von ${service.name}`), email),
            el("div", { class: "form-field" },
                el("label", { for: `${service.key}-password` }, `Passwort von ${service.name}`), password)),
        el("div", { class: "form-actions" }, button));

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        button.disabled = true;
        errors.show(`${service.key}-login`, "");
        try {
            await api(`/api/${service.key}/login`, { email: email.value, password: password.value });
            password.value = "";
            await reload();
        } catch (err) {
            password.value = "";
            errors.show(`${service.key}-login`, `Anmelden bei ${service.name} fehlgeschlagen: ${err.message}`);
            button.disabled = false;
        }
    });
    return form;
}

// YAZIO hat außer dem Konto nichts einzustellen: verbunden oder nicht
function yazioConnectedCard(account, errors, reload) {
    const logout = el("button", { type: "button", class: "button" }, "Trennen");
    logout.addEventListener("click", async () => {
        logout.disabled = true;
        try {
            await api("/api/yazio/logout", {});
            await reload();
        } catch (err) {
            logout.disabled = false;
            errors.show("yazio-logout", `Trennen fehlgeschlagen: ${err.message}`);
        }
    });
    return el("section", { class: "card settings-form" },
        el("h3", {}, "YAZIO"),
        el("p", {}, "Verbunden als ", el("strong", {}, account.email), "."),
        el("p", { class: "muted hint" }, "Dein Tag steht unter ", el("a", { href: "/nutrition" }, "Ernährung"),
            "; ein Rezept mit Nährwerten trägst du auf seiner Seite ein."),
        el("div", { class: "form-actions" }, logout));
}

export async function renderAccountPage() {
    document.title = "Konto · Luca Smart Home";
    const errors = errorBox();
    const bringSlot = el("div");
    const yazioSlot = el("div");

    async function reloadBring() {
        errors.show("bring-lists", "");   // eine alte Meldung gehört nicht zum neuen Stand
        const account = await api("/api/bring");
        let lists = null;
        if (account.connected) {
            // Bring! kann gerade nicht erreichbar sein: die Seite soll trotzdem das Konto zeigen
            try {
                ({ lists } = await api("/api/bring/lists"));
            } catch (err) {
                errors.show("bring-lists", err.message);
            }
        }
        bringSlot.replaceChildren(account.connected
            ? connectedCard(account, lists, errors, reloadBring)
            : loginCard(BRING, errors, reloadBring));
    }

    // der Status steht in der Datenbank, YAZIO selbst wird hier nicht gefragt
    async function reloadYazio() {
        const account = await api("/api/yazio");
        yazioSlot.replaceChildren(account.connected
            ? yazioConnectedCard(account, errors, reloadYazio)
            : loginCard(YAZIO, errors, reloadYazio));
    }

    showPage(
        breadcrumb([{ label: "Konto" }]),
        el("h1", {}, "Konto"),
        errors.node,
        bringSlot,
        yazioSlot);
    // getrennt abgefangen, damit ein Fehler bei dem einen Dienst den anderen nicht verdeckt
    await Promise.all([
        reloadBring().catch((err) => errors.show("bring-load", `Bring!-Konto konnte nicht geladen werden: ${err.message}`)),
        reloadYazio().catch((err) => errors.show("yazio-load", `YAZIO-Konto konnte nicht geladen werden: ${err.message}`)),
    ]);
}
