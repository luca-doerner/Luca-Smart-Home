/*
 * Die Seite /account „Konto“: hier meldet sich jeder Benutzer selbst bei seinem Bring!-Konto an.
 *
 * Das Passwort geht einmal an den Server, der damit bei Bring! anmeldet und es sofort wieder
 * vergisst (bring.js). Gespeichert wird nur ein verschlüsselter Zugriffsschlüssel. Danach landen
 * die Einkaufslisten dieses Benutzers in seinem Bring!, auch wenn eine KI sie über den
 * MCP-Server schickt.
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
            errors.show("list", "");
        } catch (err) {
            errors.show("list", `Liste speichern fehlgeschlagen: ${err.message}`);
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
            errors.show("logout", `Trennen fehlgeschlagen: ${err.message}`);
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

function loginCard(errors, reload) {
    const email = el("input", {
        type: "email", id: "bring-email", required: true, maxlength: 200,
        autocomplete: "off", autocapitalize: "none", spellcheck: "false",
    });
    const password = el("input", {
        type: "password", id: "bring-password", required: true, maxlength: 200, autocomplete: "off",
    });
    const button = el("button", { type: "submit", class: "button primary" }, icon("cart"), "Bei Bring! anmelden");
    const form = el("form", { class: "card settings-form" },
        el("h3", {}, "Bring!"),
        el("p", { class: "muted form-description" },
            "Melde dich mit deinem Bring!-Konto an, dann kann „An Bring! senden“ deine Einkaufsliste "
            + "füllen. Das Passwort wird nur zum Anmelden benutzt und nicht gespeichert; behalten wird "
            + "ein verschlüsselter Zugriffsschlüssel, den du hier jederzeit mit „Trennen“ löschen kannst."),
        el("div", { class: "form-row" },
            el("div", { class: "form-field" }, el("label", { for: "bring-email" }, "E-Mail von Bring!"), email),
            el("div", { class: "form-field" }, el("label", { for: "bring-password" }, "Passwort von Bring!"), password)),
        el("div", { class: "form-actions" }, button));

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        button.disabled = true;
        errors.show("login", "");
        try {
            await api("/api/bring/login", { email: email.value, password: password.value });
            password.value = "";
            await reload();
        } catch (err) {
            password.value = "";
            errors.show("login", `Anmelden fehlgeschlagen: ${err.message}`);
            button.disabled = false;
        }
    });
    return form;
}

export async function renderAccountPage() {
    document.title = "Konto · Smart Home";
    const errors = errorBox();
    const slot = el("div");

    async function reload() {
        errors.show("lists", "");   // eine alte Meldung gehört nicht zum neuen Stand
        const account = await api("/api/bring");
        let lists = null;
        if (account.connected) {
            // Bring! kann gerade nicht erreichbar sein: die Seite soll trotzdem das Konto zeigen
            try {
                ({ lists } = await api("/api/bring/lists"));
            } catch (err) {
                errors.show("lists", err.message);
            }
        }
        slot.replaceChildren(account.connected ? connectedCard(account, lists, errors, reload) : loginCard(errors, reload));
    }

    showPage(
        breadcrumb([{ label: "Konto" }]),
        el("h1", {}, "Konto"),
        errors.node,
        slot);
    await reload();
}
