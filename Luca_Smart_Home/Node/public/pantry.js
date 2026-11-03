/*
 * Die Vorratsseite /pantry: was zu Hause ist.
 *
 * Gespeichert wird sofort, nicht mit einem Knopf — wie bei den Live-Einstellungen eines
 * Dienstes: der Schalter schickt beim Umlegen, die Zahlenfelder nach dem Tippen (throttle, damit
 * nicht jeder Tastendruck eine Anfrage wird).
 *
 * Zwei Arten von Eintrag, das ist die Entscheidung aus dem Plan:
 *   „immer da“      Salz, Pfeffer, Öl — nichts zu zählen
 *   Menge + Einheit die Dinge, die wirklich ausgehen; passt die Einheit zu der im Rezept und ist
 *                   zu wenig da, kommt nur die fehlende Menge auf die Einkaufsliste
 */
import { api, breadcrumb, el, errorBox, icon, plural, showPage, throttle } from "./lib.js";

const SAVE_MS = 400;

function switchInput(id, checked, onChange) {
    const input = el("input", { type: "checkbox", role: "switch", id, checked });
    input.addEventListener("change", () => onChange(input.checked));
    return { node: el("label", { class: "switch" }, input, el("span", { class: "track" }, el("span", { class: "thumb" }))), input };
}

/*************** Eine Zeile *******************************************************************/
// item: wie /api/pantry es liefert; save(values) schickt die Änderung, remove() löscht,
// onMoved() wird gerufen, wenn der Eintrag durch „immer da“ in die andere Liste gehört
function pantryRow(item, { save, remove, errors, onMoved }) {
    const id = `pantry-${item.ingredient_id}`;
    const amount = el("input", {
        type: "number", id: `${id}-amount`, value: item.amount ?? "", min: "0", step: "any",
        placeholder: "Menge", "aria-label": `${item.name}: Menge`,
    });
    const unit = el("input", {
        type: "text", id: `${id}-unit`, value: item.unit ?? "", maxlength: 20,
        placeholder: item.default_unit ?? "Einheit", "aria-label": `${item.name}: Einheit`,
    });
    const note = el("input", {
        type: "text", id: `${id}-note`, value: item.note ?? "", maxlength: 200,
        placeholder: "Notiz", "aria-label": `${item.name}: Notiz`,
    });

    const values = () => ({
        ingredient: item.ingredient_id,
        always_available: always.input.checked,
        amount: amount.value === "" ? null : Number(amount.value),
        unit: unit.value.trim() || null,
        note: note.value.trim() || null,
    });

    // „immer da“ und eine Menge schließen sich nicht aus, aber die Menge ist dann unwichtig —
    // deshalb werden die Felder ausgegraut, statt sie zu verbieten
    const updateEnabled = () => {
        const counted = !always.input.checked;
        amount.disabled = !counted;
        unit.disabled = !counted;
    };

    const sendNow = () => save(values());
    const send = throttle(sendNow, SAVE_MS);
    const always = switchInput(`${id}-always`, item.always_available, async () => {
        updateEnabled();
        if (always.input.checked) {
            // ab jetzt zählt die Menge nicht mehr, also weg damit
            amount.value = "";
            unit.value = "";
        }
        await sendNow();
        onMoved();   // der Eintrag gehört jetzt in die andere Liste
    });
    for (const input of [amount, unit, note])
        input.addEventListener("input", send);
    updateEnabled();

    // „Einheit ohne Menge“ lehnt der Server ab; das Feld sagt es vorher
    const check = () => {
        const bad = amount.value === "" && unit.value.trim() !== "";
        errors.show(`unit-${item.ingredient_id}`, bad ? `${item.name}: eine Einheit braucht auch eine Menge` : "");
    };
    amount.addEventListener("input", check);
    unit.addEventListener("input", check);

    return el("li", { class: "pantry-row" },
        el("span", { class: "pantry-name" }, item.name,
            item.category ? el("span", { class: "muted" }, ` · ${item.category}`) : null),
        el("label", { class: "pantry-always", for: `${id}-always` }, always.node, el("span", {}, "immer da")),
        el("div", { class: "pantry-amount" }, amount, unit),
        note,
        el("button", {
            type: "button", class: "icon-button", title: "aus dem Vorrat nehmen",
            "aria-label": `${item.name} aus dem Vorrat nehmen`,
            onclick: () => remove(),
        }, "✕"));
}

/*************** Hinzufügen *******************************************************************/
function addForm(names, { add, errors }) {
    const name = el("input", {
        type: "text", id: "pantry-new-name", list: "pantry-zutaten", maxlength: 200,
        placeholder: "z. B. Butter", required: true, autocomplete: "off",
    });
    const always = el("input", { type: "checkbox", id: "pantry-new-always", checked: true });
    const amount = el("input", { type: "number", id: "pantry-new-amount", min: "0", step: "any", placeholder: "Menge" });
    const unit = el("input", { type: "text", id: "pantry-new-unit", maxlength: 20, placeholder: "Einheit" });
    const button = el("button", { type: "submit", class: "button primary" }, icon("plus"), "In den Vorrat");
    const status = el("p", { class: "form-status muted", role: "status" });

    const form = el("form", { class: "card settings-form" },
        el("h3", {}, "Zutat in den Vorrat"),
        el("p", { class: "muted form-description" },
            "Eine Zutat, die der Katalog noch nicht kennt, wird dabei angelegt."),
        el("datalist", { id: "pantry-zutaten" }, names.map((entry) => el("option", { value: entry.name }))),
        el("div", { class: "form-row" },
            el("div", { class: "form-field" }, el("label", { for: "pantry-new-name" }, "Zutat"), name),
            el("div", { class: "form-field" }, el("label", { for: "pantry-new-amount" }, "Menge"), amount),
            el("div", { class: "form-field" }, el("label", { for: "pantry-new-unit" }, "Einheit"), unit),
            el("div", { class: "form-field" },
                el("label", { for: "pantry-new-always" }, "Immer da"),
                el("label", { class: "inline-check" }, always, "nichts zu zählen"))),
        el("div", { class: "form-actions" }, button, status));

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity())
            return;
        button.disabled = true;
        status.textContent = "Speichere …";
        try {
            await add({
                ingredient: name.value.trim(),
                always_available: always.checked,
                amount: amount.value === "" ? null : Number(amount.value),
                unit: unit.value.trim() || null,
            });
            name.value = "";
            amount.value = "";
            unit.value = "";
            status.textContent = "";
            errors.show("add", "");
            name.focus();
        } catch (err) {
            status.textContent = "";
            errors.show("add", `Hinzufügen fehlgeschlagen: ${err.message}`);
        } finally {
            button.disabled = false;
        }
    });

    return form;
}

/*************** Seite ************************************************************************/
export async function renderPantryPage() {
    document.title = "Vorrat · Luca Smart Home";
    const errors = errorBox();
    const [{ items }, { ingredients }] = await Promise.all([api("/api/pantry"), api("/api/ingredients")]);

    const alwaysList = el("ul", { class: "pantry-list" });
    const countedList = el("ul", { class: "pantry-list" });
    const summary = el("p", { class: "muted" });

    const save = async (values) => {
        try {
            await api("/api/pantry", values);
            errors.show(`save-${values.ingredient}`, "");
        } catch (err) {
            errors.show(`save-${values.ingredient}`, `Speichern fehlgeschlagen: ${err.message}`);
        }
    };

    const remove = async (item) => {
        try {
            await api(`/api/pantry/${item.ingredient_id}/delete`, {});
            await reload();
        } catch (err) {
            errors.show(`save-${item.ingredient_id}`, `Löschen fehlgeschlagen: ${err.message}`);
        }
    };

    // nach jeder Änderung, die die Einteilung betrifft (hinzufügen, löschen, „immer da“
    // umlegen), wird neu geladen — ein Eintrag wandert dann von der einen Liste in die andere
    async function reload() {
        const { items: fresh } = await api("/api/pantry");
        show(fresh);
    }

    function show(list) {
        const rows = (filtered) => filtered.map((item) => pantryRow(item, {
            save, remove: () => remove(item), errors, onMoved: () => reload(),
        }));
        const always = list.filter((item) => item.always_available);
        const counted = list.filter((item) => !item.always_available);
        alwaysList.replaceChildren(...(always.length > 0
            ? rows(always)
            : [el("li", { class: "muted" }, "Noch nichts, was immer da ist.")]));
        countedList.replaceChildren(...(counted.length > 0
            ? rows(counted)
            : [el("li", { class: "muted" }, "Noch nichts mit Menge.")]));
        summary.textContent = `${plural(list.length, "Zutat", "Zutaten")} im Vorrat.`;
    }

    show(items);

    showPage(
        breadcrumb([{ label: "Rezepte", href: "/recipes" }, { label: "Vorrat" }]),
        el("div", { class: "page-header" },
            el("div", {},
                el("h1", {}, "Vorrat"),
                el("p", { class: "muted" },
                    "Was hier steht, lässt die Einkaufsliste weg — nennt es aber trotzdem, "
                    + "damit nichts vergessen wird."),
                summary),
            el("div", { class: "header-actions" },
                el("a", { class: "button", href: "/recipes" }, icon("book"), "Rezepte"))),
        errors.node,
        addForm(ingredients, {
            add: async (values) => {
                await api("/api/pantry", values);
                await reload();
            },
            errors,
        }),
        el("section", { class: "card" },
            el("h3", {}, "Immer da"),
            el("p", { class: "muted form-description" }, "Salz, Pfeffer, Öl — nichts zu zählen."),
            alwaysList),
        el("section", { class: "card" },
            el("h3", {}, "Mit Menge"),
            el("p", { class: "muted form-description" },
                "Reicht die Menge für ein Rezept nicht, kommt nur die fehlende Menge auf die Liste."),
            countedList));
}
