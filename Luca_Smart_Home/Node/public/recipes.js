/*
 * Die Rezeptseiten: /recipes (Suche), /recipes/:id (ansehen und bearbeiten), /recipes/new.
 *
 * Zutaten- und Schrittlisten sind nach demselben Muster gebaut wie das color_list-Feld in
 * feature-panel.js: der Zustand liegt in einer Closure, show() baut die Liste neu auf, read()
 * liest sie wieder aus, ↑ ↓ ✕ sortieren und löschen. rowList() unten ist genau dieses Muster,
 * einmal aufgeschrieben und von beiden Listen benutzt.
 *
 * Gespeichert wird immer das ganze Rezept (POST /api/recipes/:id) — der Server ersetzt Zutaten
 * und Schritte komplett, also muss die Seite auch alles mitschicken.
 *
 * Nährwerte stehen pro Portion im Rezept (kcal, Eiweiß, Kohlenhydrate, Fett). Der Knopf „Portion
 * nach YAZIO“ schickt nur die Zahl der Portionen; mal Portionen rechnet der Server (yazio.js).
 */
import { api, breadcrumb, cardGrid, el, errorBox, icon, plural, showPage, throttle } from "./lib.js";
import { mealSelect, nutrientLine, todayLocal } from "./nutrition.js";

const DIFFICULTIES = ["einfach", "mittel", "schwer"];
const MAX_IMAGE_SIDE = 1600;   // größere Bilder werden im Browser verkleinert
const SEARCH_MS = 250;         // so lange wird nach dem Tippen gewartet
const MAX_SERVINGS = 100;

/*************** Kleine Helfer ****************************************************************/
// 1.5 -> "1,5", 750 -> "750"; die Seite rechnet nicht selbst, die Mengen kommen vom Server
function amountText(amount) {
    return amount === null ? "" : String(Number(amount.toFixed(2))).replace(".", ",");
}

// "500 g", "2", "" — dieselbe Form wie spec() im Server
function amountWithUnit(amount, unit) {
    if (amount === null)
        return "";
    return unit ? `${amountText(amount)} ${unit}` : amountText(amount);
}

function minutesText(recipe) {
    const parts = [
        recipe.prep_minutes ? `${recipe.prep_minutes} min Vorbereitung` : null,
        recipe.cook_minutes ? `${recipe.cook_minutes} min Kochen` : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : null;
}

function field(id, label, control, hint = null) {
    return el("div", { class: "form-field" },
        el("label", { for: id }, label),
        control,
        hint ? el("p", { class: "muted field-hint" }, hint) : null);
}

// Textfeld, Zahlenfeld, mehrzeiliges Feld — immer mit { read(), node }
function textInput(id, value, props = {}) {
    const input = el("input", { type: "text", id, value: value ?? "", ...props });
    return { node: input, input, read: () => input.value.trim() || null };
}

function numberInput(id, value, props = {}) {
    const input = el("input", { type: "number", id, value: value ?? "", ...props });
    return { node: input, input, read: () => (input.value === "" ? null : Number(input.value)) };
}

function areaInput(id, value, rows = 3) {
    const input = el("textarea", { id, rows });
    input.value = value ?? "";
    return { node: input, input, read: () => input.value.trim() || null };
}

// Vorschläge aus dem Zutaten-Katalog für die Namensfelder
let ingredientNames = null;

async function ingredientList() {
    if (ingredientNames === null) {
        const { ingredients } = await api("/api/ingredients");
        ingredientNames = ingredients;
    }
    return ingredientNames;
}

function ingredientDatalist(id, names) {
    return el("datalist", { id }, names.map((entry) => el("option", { value: entry.name })));
}

/*
 * Liste mit Reihenfolge (Zutaten, Schritte) — das Muster aus dem color_list-Feld.
 *
 *   items    Startwerte
 *   blank()  was ein neues, leeres Element ist
 *   render(item, index, changed)  baut die Felder einer Zeile; changed() meldet eine Änderung
 *   keep(row) sagt, ob eine Zeile beim Auslesen behalten wird (leere fallen weg)
 *
 * Gibt { node, read(), isEmpty() } zurück. Die Zeilen werden bei jeder Änderung der
 * Reihenfolge neu aufgebaut — bei höchstens hundert Zeilen ist das nicht zu merken und es
 * erspart das Nachführen von Nummern und ↑/↓-Zuständen.
 */
function rowList({ items, blank, render, keep, addLabel, emptyText, onChange = () => {} }) {
    let rows = items.map((item) => ({ ...item }));
    const list = el("ol", { class: "row-list" });
    const addButton = el("button", { type: "button", class: "button" }, icon("plus"), addLabel);

    // die Werte aus den Feldern zurück in rows schreiben, bevor neu gebaut wird
    let collect = () => {};

    // Jede Änderung an der Liste geht hier durch, und zwar in dieser Reihenfolge: erst die
    // Felder in rows zurückschreiben, dann die Liste ändern, dann neu aufbauen. Andersherum
    // würde collect() die alte Reihenfolge aus dem DOM lesen und die gerade gemachte Änderung
    // sofort wieder überschreiben.
    const update = (change) => {
        collect();
        change();
        show();
        onChange();
    };

    function show() {
        const readers = [];
        list.replaceChildren(...rows.map((row, index) => {
            const parts = render(row, index, onChange);
            readers.push(parts.read);
            const move = (to) => update(() => {
                [rows[index], rows[to]] = [rows[to], rows[index]];
            });
            return el("li", { class: "row-list-row" },
                el("div", { class: "row-list-fields" }, parts.node),
                el("div", { class: "row-list-actions" },
                    el("button", {
                        type: "button", class: "icon-button", title: "nach oben",
                        "aria-label": `Zeile ${index + 1} nach oben`,
                        disabled: index === 0 || undefined,
                        onclick: () => move(index - 1),
                    }, "↑"),
                    el("button", {
                        type: "button", class: "icon-button", title: "nach unten",
                        "aria-label": `Zeile ${index + 1} nach unten`,
                        disabled: index === rows.length - 1 || undefined,
                        onclick: () => move(index + 1),
                    }, "↓"),
                    el("button", {
                        type: "button", class: "icon-button", title: "entfernen",
                        "aria-label": `Zeile ${index + 1} entfernen`,
                        onclick: () => update(() => rows.splice(index, 1)),
                    }, "✕")));
        }));
        if (rows.length === 0)
            list.append(el("li", { class: "muted row-list-empty" }, emptyText));
        collect = () => { rows = readers.map((reader) => reader()); };
    }

    addButton.addEventListener("click", () => update(() => rows.push(blank())));
    show();

    return {
        node: el("div", { class: "row-list-control" }, list, addButton),
        // read() liest die Felder und wirft leere Zeilen weg
        read: () => {
            collect();
            return rows.filter(keep);
        },
    };
}

/*************** Zutaten- und Schrittliste ****************************************************/
function ingredientRows(ingredients, datalistId, onChange) {
    return rowList({
        items: ingredients,
        blank: () => ({
            name: "", amount: null, unit: null, note: null, group_label: null, optional: false,
            alternative_group: null,
        }),
        addLabel: "Zutat",
        emptyText: "Noch keine Zutat.",
        onChange,
        keep: (row) => row.name,
        render(row, index, changed) {
            const name = el("input", {
                type: "text", value: row.name ?? "", list: datalistId, placeholder: "Zutat",
                "aria-label": `Zutat ${index + 1}: Name`, class: "ingredient-name",
            });
            const amount = el("input", {
                type: "number", value: row.amount ?? "", step: "any", min: "0", placeholder: "Menge",
                "aria-label": `Zutat ${index + 1}: Menge`, class: "ingredient-amount",
            });
            const unit = el("input", {
                type: "text", value: row.unit ?? "", placeholder: "Einheit", maxlength: 20,
                "aria-label": `Zutat ${index + 1}: Einheit`, class: "ingredient-unit",
            });
            const note = el("input", {
                type: "text", value: row.note ?? "", placeholder: "Hinweis", maxlength: 200,
                "aria-label": `Zutat ${index + 1}: Hinweis`,
            });
            const group = el("input", {
                type: "text", value: row.group_label ?? "", placeholder: "Gruppe, z. B. Für die Soße",
                maxlength: 200, "aria-label": `Zutat ${index + 1}: Gruppe`,
            });
            const alternative = el("input", {
                type: "text", value: row.alternative_group ?? "", maxlength: 200,
                placeholder: "Entweder/oder, z. B. Schärfe", "aria-label": `Zutat ${index + 1}: Alternative`,
                title: "Zutaten mit demselben Text hier sind Alternativen: auf die Einkaufsliste kommt nur die, die du auswählst",
            });
            const optional = el("input", { type: "checkbox", checked: row.optional });
            for (const input of [name, amount, unit, note, group, alternative, optional])
                input.addEventListener("input", changed);

            return {
                node: [name, amount, unit, note, group, alternative,
                    el("label", { class: "inline-check" }, optional, "optional")],
                read: () => ({
                    name: name.value.trim(),
                    amount: amount.value === "" ? null : Number(amount.value),
                    unit: unit.value.trim() || null,
                    note: note.value.trim() || null,
                    group_label: group.value.trim() || null,
                    alternative_group: alternative.value.trim() || null,
                    optional: optional.checked,
                }),
            };
        },
    });
}

function stepRows(steps, onChange) {
    return rowList({
        items: steps,
        blank: () => ({ text: "", minutes: null }),
        addLabel: "Schritt",
        emptyText: "Noch kein Schritt.",
        onChange,
        keep: (row) => row.text,
        render(row, index, changed) {
            const text = el("textarea", { rows: 2, placeholder: "Was ist zu tun?", "aria-label": `Schritt ${index + 1}` });
            text.value = row.text ?? "";
            const minutes = el("input", {
                type: "number", value: row.minutes ?? "", min: "0", placeholder: "min",
                "aria-label": `Schritt ${index + 1}: Minuten`, class: "step-minutes",
            });
            text.addEventListener("input", changed);
            minutes.addEventListener("input", changed);
            return {
                node: [text, minutes],
                read: () => ({
                    text: text.value.trim(),
                    minutes: minutes.value === "" ? null : Number(minutes.value),
                }),
            };
        },
    });
}

/*************** Bild *************************************************************************/
/*
 * Das Bild wird vor dem Hochladen im Browser auf MAX_IMAGE_SIDE verkleinert. Das hat zwei
 * Gründe: der Upload bleibt klein (der Pi hängt an einer normalen Leitung), und das
 * Neu-Zeichnen auf eine Leinwand wirft alle EXIF-Daten weg — also auch den Aufnahmeort, der in
 * Handyfotos steckt.
 */
async function shrinkImage(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return new Promise((resolve, reject) => canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Das Bild konnte nicht umgewandelt werden"))),
        "image/jpeg", 0.85));
}

// Bild-Adresse mit dem Änderungszeitpunkt dahinter: ohne den zeigt der Browser nach dem
// Hochladen das alte Bild aus seinem Zwischenspeicher
function imageUrl(recipe) {
    return `/api/recipes/${recipe.id}/image?v=${encodeURIComponent(recipe.image_updated_at ?? "")}`;
}

function imageBox(recipe, errors, onChanged) {
    const picture = el("div", { class: "recipe-image-box" });
    const fileInput = el("input", { type: "file", accept: "image/jpeg,image/png,image/webp", id: "recipe-image" });
    const status = el("p", { class: "form-status muted", role: "status" });
    const removeButton = el("button", { type: "button", class: "button" }, icon("trash"), "Bild entfernen");

    const show = () => {
        picture.replaceChildren(recipe.has_image
            ? el("img", { src: imageUrl(recipe), alt: `Bild von ${recipe.name}`, class: "recipe-image" })
            : el("p", { class: "empty" }, "Noch kein Bild."));
        removeButton.hidden = !recipe.has_image;
    };

    fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0];
        if (!file)
            return;
        status.textContent = "Lade hoch …";
        try {
            const blob = await shrinkImage(file);
            const saved = await api(`/api/recipes/${recipe.id}/image`, blob);
            recipe.has_image = true;
            recipe.image_updated_at = saved.image_updated_at;
            show();
            status.textContent = "Bild gespeichert";
            errors.show("image", "");
            onChanged();
        } catch (err) {
            status.textContent = "";
            errors.show("image", `Bild fehlgeschlagen: ${err.message}`);
        } finally {
            fileInput.value = "";
        }
    });

    removeButton.addEventListener("click", async () => {
        try {
            await api(`/api/recipes/${recipe.id}/image/delete`, {});
            recipe.has_image = false;
            recipe.image_updated_at = null;
            show();
            status.textContent = "Bild entfernt";
            errors.show("image", "");
            onChanged();
        } catch (err) {
            errors.show("image", `Entfernen fehlgeschlagen: ${err.message}`);
        }
    });

    show();
    return el("section", { class: "card" },
        el("h3", {}, "Bild"),
        picture,
        el("div", { class: "form-actions" }, fileInput, removeButton, status));
}

/*************** Rezept bearbeiten ************************************************************/
const NUTRIENT_FIELDS = [
    { key: "kcal", id: "recipe-kcal", label: "Kalorien (kcal)", step: 1 },
    { key: "protein", id: "recipe-protein", label: "Eiweiß (g)", step: 0.1 },
    { key: "carbs", id: "recipe-carbs", label: "Kohlenhydrate (g)", step: 0.1 },
    { key: "fat", id: "recipe-fat", label: "Fett (g)", step: 0.1 },
];

// null, wenn alle leer sind (löscht die Nährwerte); sonst alle vier. Immer mitgeschickt, damit die
// Seite zeigt und speichert, was im Formular steht — nur ein anderer Aufrufer (KI) lässt sie weg.
function readNutrients(fields) {
    const values = fields.map((field) => field.read());
    if (values.every((value) => value === null))
        return null;
    if (values.some((value) => value === null))
        throw new Error("Nährwerte: entweder alle vier Felder ausfüllen oder alle leer lassen");
    return Object.fromEntries(fields.map((field, index) => [field.key, values[index]]));
}

// recipe: ein vorhandenes Rezept oder null für ein neues
async function recipeForm(recipe, errors) {
    const isNew = recipe === null;
    const start = recipe ?? {
        name: "", description: null, servings: 4, prep_minutes: null, cook_minutes: null,
        difficulty: null, tags: [], source: null, notes: null, nutrients: null, ingredients: [], steps: [],
    };
    const names = await ingredientList();
    const datalistId = "zutaten-vorschlaege";

    const status = el("p", { class: "form-status muted", role: "status" });
    const saveButton = el("button", { class: "button primary", type: "submit" },
        isNew ? "Rezept anlegen" : "Speichern");
    const touched = () => { status.textContent = "Ungespeicherte Änderungen"; };

    const name = textInput("recipe-name", start.name, { required: true, maxlength: 200, placeholder: "z. B. Lasagne" });
    const description = areaInput("recipe-description", start.description, 2);
    const servings = numberInput("recipe-servings", start.servings, { min: 1, max: MAX_SERVINGS, step: 1, required: true });
    const prep = numberInput("recipe-prep", start.prep_minutes, { min: 0, step: 1 });
    const cook = numberInput("recipe-cook", start.cook_minutes, { min: 0, step: 1 });
    const difficulty = el("select", { id: "recipe-difficulty" },
        el("option", { value: "" }, "— nicht gesagt —"),
        DIFFICULTIES.map((level) => el("option", { value: level, selected: start.difficulty === level }, level)));
    const tags = textInput("recipe-tags", start.tags.join(", "), { maxlength: 500, placeholder: "Hauptgericht, vegetarisch" });
    const source = textInput("recipe-source", start.source, { maxlength: 500 });
    const notes = areaInput("recipe-notes", start.notes, 3);
    // die vier Felder gehören zusammen: alle leer = keine Nährwerte, sonst müssen alle da sein
    const nutrients = NUTRIENT_FIELDS.map(({ key, id, step }) =>
        ({ key, id, ...numberInput(id, start.nutrients?.[key], { min: 0, max: 100000, step })}));

    const ingredients = ingredientRows(start.ingredients, datalistId, touched);
    const steps = stepRows(start.steps, touched);
    for (const control of [name, description, servings, prep, cook, tags, source, notes, ...nutrients])
        control.input.addEventListener("input", touched);
    difficulty.addEventListener("change", touched);

    const form = el("form", { class: "card settings-form" },
        el("h3", {}, isNew ? "Neues Rezept" : "Rezept bearbeiten"),
        ingredientDatalist(datalistId, names),
        field("recipe-name", "Name", name.node),
        field("recipe-description", "Beschreibung", description.node),
        el("div", { class: "form-row" },
            field("recipe-servings", "Portionen", servings.node),
            field("recipe-prep", "Vorbereitung (min)", prep.node),
            field("recipe-cook", "Kochen (min)", cook.node),
            field("recipe-difficulty", "Schwierigkeit", difficulty)),
        field("recipe-tags", "Tags", tags.node, "Mit Komma trennen."),
        el("h4", {}, "Zutaten"),
        el("p", { class: "muted form-description" },
            "Die Mengen gelten für die Portionen oben. Ohne Menge heißt „etwas davon“. "
            + "Eine Zutat, die der Katalog noch nicht kennt, wird beim Speichern angelegt."),
        ingredients.node,
        el("h4", {}, "Schritte"),
        steps.node,
        el("h4", {}, "Nährwerte pro Portion"),
        el("p", { class: "muted form-description" },
            "Für YAZIO. Entweder alle vier Felder oder keins. Die Werte gelten für eine Portion, "
            + "nicht für das ganze Rezept — ändert sich die Portionszahl oben, bleiben sie richtig."),
        el("div", { class: "form-row" }, NUTRIENT_FIELDS.map(({ id, label }, index) =>
            field(id, label, nutrients[index].node))),
        el("h4", {}, "Mehr"),
        field("recipe-source", "Quelle", source.node),
        field("recipe-notes", "Notizen", notes.node),
        el("div", { class: "form-actions" }, saveButton, status));

    const collect = () => ({
        name: name.read(),
        description: description.read(),
        servings: servings.read(),
        prep_minutes: prep.read(),
        cook_minutes: cook.read(),
        difficulty: difficulty.value || null,
        tags: tags.read()?.split(",").map((tag) => tag.trim()).filter(Boolean) ?? [],
        source: source.read(),
        notes: notes.read(),
        nutrients: readNutrients(nutrients),
        ingredients: ingredients.read(),
        steps: steps.read(),
    });

    return { node: form, form, collect, status, saveButton };
}

/*************** Seite: ein Rezept ************************************************************/
// Zutatenliste nach ihren Gruppen ("Für die Soße"), in der Reihenfolge des Rezepts
function ingredientGroups(ingredients) {
    const groups = new Map();
    for (const entry of ingredients) {
        const key = entry.group_label ?? "";
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(entry);
    }
    return [...groups];
}

function ingredientTable(ingredients) {
    return ingredientGroups(ingredients).map(([group, entries]) => [
        group ? el("h4", {}, group) : null,
        el("ul", { class: "ingredient-list" }, entries.map((entry) => el("li", {},
            el("span", { class: "ingredient-amount-text" }, amountWithUnit(entry.amount, entry.unit)),
            el("span", {}, entry.name,
                entry.note ? el("span", { class: "muted" }, `, ${entry.note}`) : null,
                entry.optional ? el("span", { class: "badge" }, "optional") : null,
                entry.alternative_group
                    ? el("span", { class: "badge", title: "Alternative: du brauchst nur eine davon" }, `oder · ${entry.alternative_group}`)
                    : null)))),
    ]);
}

// Portionsrechner: die Mengen kommen vom Server (/ingredients?servings=), damit sie genauso
// gerundet werden wie in der Einkaufsliste und in den MCP-Werkzeugen
function servingsCalculator(recipe, errors) {
    let servings = recipe.servings;
    const input = el("input", { type: "number", id: "recipe-portions", value: servings, min: 1, max: MAX_SERVINGS, step: 1 });
    const table = el("div", { class: "ingredient-table" }, ingredientTable(recipe.ingredients));
    const hint = el("p", { class: "muted" });

    const load = throttle(async (wanted) => {
        try {
            const result = await api(`/api/recipes/${recipe.id}/ingredients?servings=${wanted}`);
            if (result.servings !== Number(input.value))
                return;   // in der Zwischenzeit wurde weitergeklickt
            table.replaceChildren(...[ingredientTable(result.ingredients)].flat(Infinity).filter(Boolean));
            hint.textContent = result.servings === recipe.servings
                ? ""
                : `Umgerechnet von ${plural(recipe.servings, "Portion", "Portionen")} im Rezept.`;
            errors.show("servings", "");
        } catch (err) {
            errors.show("servings", `Umrechnen fehlgeschlagen: ${err.message}`);
        }
    }, 200);

    const step = (by) => {
        servings = Math.min(Math.max(1, servings + by), MAX_SERVINGS);
        input.value = servings;
        load(servings);
    };
    input.addEventListener("input", () => {
        const wanted = Number(input.value);
        if (!Number.isInteger(wanted) || wanted < 1 || wanted > MAX_SERVINGS)
            return;
        servings = wanted;
        load(servings);
    });

    return el("section", { class: "card" },
        el("div", { class: "portions" },
            el("h3", {}, "Zutaten"),
            el("div", { class: "portions-control" },
                el("button", { type: "button", class: "icon-button", "aria-label": "eine Portion weniger", onclick: () => step(-1) }, "−"),
                input,
                el("button", { type: "button", class: "icon-button", "aria-label": "eine Portion mehr", onclick: () => step(1) }, "+"),
                el("label", { for: "recipe-portions" }, "Portionen"))),
        hint,
        table);
}

// „An Bring! senden“ erscheint erst unter der Vorschau: Bring!-Listen sind geteilt, geschrieben
// wird deshalb nur nach dem ausdrücklichen Klick, nachdem man gesehen hat, was hineinkommt
// chosen(): die Namen der gewählten Alternativen, oder null, solange noch nicht überall gewählt ist
function bringButton(recipe, servings, errors, chosen) {
    const status = el("p", { class: "muted hint" });
    const button = el("button", { type: "button", class: "button" }, icon("cart"), "An Bring! senden");
    const node = el("div", { class: "bring-send" }, button, status);
    node.update = () => {
        button.disabled = chosen() === null;
        status.textContent = button.disabled ? "Bitte erst bei „entweder/oder“ eine Zutat wählen." : "";
    };
    node.update();
    button.addEventListener("click", async () => {
        const choices = chosen();
        if (choices === null)
            return;
        button.disabled = true;
        status.textContent = "";
        try {
            const { bring, note } = await api(`/api/recipes/${recipe.id}/bring`, { servings, choices });
            status.textContent = bring ? bring.note : note;
            errors.show("bring", "");
        } catch (err) {
            errors.show("bring", `An Bring! senden fehlgeschlagen: ${err.message}`);
        } finally {
            button.disabled = false;
        }
    });
    return node;
}

// Alternativen („A oder B“): eine Wahl je Alternative. Ohne Wahl steht nichts auf der Liste —
// nie beides und nie eine, die niemand ausgesucht hat.
function choicesBlock(choices, onChange) {
    const selected = choices.map(() => null);
    const nodes = choices.map((choice, index) => el("fieldset", { class: "choice" },
        el("legend", {}, `Entweder oder: ${choice.question}`),
        choice.options.map((option) => el("label", { class: "inline-check" },
            el("input", {
                type: "radio", name: `choice-${index}`,
                onchange() {
                    selected[index] = option.name;
                    onChange();
                },
            }),
            // ein span, damit Name und Vorratshinweis als ein Text umbrechen (label ist ein Flex-Container)
            el("span", {}, option.spec ? `${option.name} (${option.spec})` : option.name,
                // ein Teil davon ist schon da: dann steht hier nur die fehlende Menge
                option.in_pantry ? el("span", { class: "muted" }, ` — ${option.in_pantry}`) : null)))));
    return { nodes, chosen: () => (selected.every(Boolean) ? [...selected] : null) };
}

// Einkaufsliste auf Knopfdruck: zeigt ausdrücklich, was aus dem Vorrat kommt — das ist dieselbe
// Antwort, die auch das MCP-Werkzeug plan_shopping_list liefert
function shoppingListBox(recipe, errors) {
    const result = el("div");
    const button = el("button", { type: "button", class: "button" }, icon("cart"), "Einkaufsliste");

    button.addEventListener("click", async () => {
        const servings = Number(document.getElementById("recipe-portions")?.value) || recipe.servings;
        button.disabled = true;
        try {
            const list = await api(`/api/recipes/${recipe.id}/shopping-list?servings=${servings}`);
            // replaceChildren macht verschachtelte Listen nicht flach und schreibt null als
            // Text hin — deshalb hier eine flache Liste bauen, nicht wie bei el() verschachteln
            const block = choicesBlock(list.choices, () => bring.update());
            const bring = bringButton(recipe, list.servings, errors, block.chosen);
            result.replaceChildren(
                el("h4", {}, `Einkaufen für ${plural(list.servings, "Portion", "Portionen")}`),
                ...(list.items.length === 0 && list.choices.length === 0
                    ? [el("p", { class: "empty" }, "Alles schon da.")] : []),
                // nur Alternativen und sonst nichts: keine leere Liste davor
                ...(list.items.length === 0 ? [] : [
                    el("ul", { class: "ingredient-list" }, list.items.map((item) => el("li", {},
                        el("span", { class: "ingredient-amount-text" }, item.spec),
                        el("span", {}, item.name)))),
                ]),
                ...block.nodes,
                ...(list.from_pantry.length === 0 ? [] : [
                    el("h4", {}, "Aus dem Vorrat"),
                    el("ul", { class: "ingredient-list" }, list.from_pantry.map((item) => el("li", {},
                        el("span", { class: "ingredient-amount-text" }, item.needed),
                        el("span", {}, item.name, el("span", { class: "muted" }, ` — ${item.reason}`))))),
                ]),
                // list.note ist für den KI-Agenten geschrieben („nenne sie in der Antwort“,
                // „stehen NICHT in items“) — hier steht dasselbe für Menschen
                el("p", { class: "muted hint" }, [
                    list.from_pantry.length === 0 ? null : "Was aus dem Vorrat kommt, steht nicht auf der Liste.",
                    list.choices.length === 0 ? null : "Bei „Entweder oder“ kommt nur die Zutat auf die Liste, die du wählst.",
                ].filter(Boolean).join(" ")),
                ...(list.items.length + list.choices.length === 0 ? [] : [bring]));
            errors.show("shopping", "");
        } catch (err) {
            errors.show("shopping", `Einkaufsliste fehlgeschlagen: ${err.message}`);
        } finally {
            button.disabled = false;
        }
    });

    return { button, node: el("section", { class: "card" }, el("h3", {}, "Einkaufsliste"), result) };
}

// Löschen in zwei Schritten statt mit einem Browser-Dialog: der zweite Klick löscht wirklich
function deleteButton(recipe, errors) {
    const button = el("button", { type: "button", class: "button" }, icon("trash"), "Löschen");
    let armed = false;
    button.addEventListener("click", async () => {
        if (!armed) {
            armed = true;
            button.replaceChildren(icon("trash"), "Wirklich löschen?");
            button.classList.add("danger");
            setTimeout(() => {
                if (!armed)
                    return;
                armed = false;
                button.replaceChildren(icon("trash"), "Löschen");
                button.classList.remove("danger");
            }, 5000);
            return;
        }
        button.disabled = true;
        try {
            await api(`/api/recipes/${recipe.id}/delete`, {});
            location.assign("/recipes");
        } catch (err) {
            armed = false;
            button.disabled = false;
            button.replaceChildren(icon("trash"), "Löschen");
            button.classList.remove("danger");
            errors.show("delete", `Löschen fehlgeschlagen: ${err.message}`);
        }
    });
    return button;
}

function recipeMeta(recipe) {
    return el("p", { class: "muted" }, [
        plural(recipe.servings, "Portion", "Portionen"),
        minutesText(recipe),
        recipe.difficulty,
    ].filter(Boolean).join(" · "));
}

// „Portion nach YAZIO“: schreibt in das echte Tagebuch, deshalb nur auf ausdrücklichen Klick. Die
// Karte gibt es nur bei verbundenem Konto; ohne Nährwerte erklärt sie, was fehlt, statt zu fehlen.
function yazioBox(recipe, errors) {
    if (!recipe.nutrients)
        return el("section", { class: "card" },
            el("h3", {}, "YAZIO"),
            el("p", { class: "muted" }, "Für dieses Rezept fehlen die Nährwerte pro Portion. Trag sie beim ",
                el("a", { href: `/recipes/${recipe.id}?edit=1` }, "Bearbeiten"), " ein, dann kannst du eine Portion hier ins Tagebuch schicken."));

    const portions = el("input", { type: "number", id: "yazio-portions", value: 1, min: 0.5, max: 50, step: 0.5, required: true });
    const meal = mealSelect("yazio-meal");
    const date = el("input", { type: "date", id: "yazio-date", value: todayLocal(), required: true });
    const status = el("p", { class: "muted hint", role: "status" });
    const button = el("button", { type: "submit", class: "button primary" }, icon("food"), "Portion nach YAZIO");
    const form = el("form", {},
        el("div", { class: "form-row" },
            el("div", { class: "form-field" }, el("label", { for: "yazio-portions" }, "Portionen"), portions),
            el("div", { class: "form-field" }, el("label", { for: "yazio-meal" }, "Mahlzeit"), meal),
            el("div", { class: "form-field" }, el("label", { for: "yazio-date" }, "Tag"), date)),
        el("div", { class: "form-actions" }, button),
        status);

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity())
            return;
        button.disabled = true;
        status.replaceChildren();
        try {
            const entry = await api(`/api/recipes/${recipe.id}/yazio`,
                { portions: Number(portions.value), daytime: meal.value, date: date.value });
            errors.show("yazio", "");
            status.replaceChildren(`Eingetragen: ${entry.name} — ${nutrientLine(entry)}. `,
                el("a", { href: `/nutrition?date=${entry.date}` }, "Tag ansehen"));
        } catch (err) {
            errors.show("yazio", `Nach YAZIO senden fehlgeschlagen: ${err.message}`);
        } finally {
            button.disabled = false;
        }
    });

    return el("section", { class: "card" },
        el("h3", {}, "YAZIO"),
        form);
}

export async function renderRecipePage(id) {
    const errors = errorBox();
    const { recipe } = await api(`/api/recipes/${id}`);
    document.title = `${recipe.name} · Luca Smart Home`;
    const shopping = shoppingListBox(recipe, errors);
    // YAZIO darf fehlen oder spinnen: die Seite zeigt dann einfach keine Karte
    const yazio = await api("/api/yazio").catch(() => ({ connected: false }));

    showPage(
        breadcrumb([{ label: "Rezepte", href: "/recipes" }, { label: recipe.name }]),
        el("div", { class: "page-header" },
            el("div", {},
                el("h1", {}, recipe.name),
                recipe.description ? el("p", { class: "muted" }, recipe.description) : null,
                recipeMeta(recipe),
                recipe.nutrients ? el("p", { class: "muted" }, `Pro Portion: ${nutrientLine(recipe.nutrients)}`) : null,
                recipe.tags.length > 0
                    ? el("p", { class: "tag-row" }, recipe.tags.map((tag) =>
                        el("a", { class: "badge", href: `/recipes?tag=${encodeURIComponent(tag)}` }, tag)))
                    : null),
            el("div", { class: "header-actions" },
                shopping.button,
                el("a", { class: "button", href: `/recipes/${recipe.id}?edit=1` }, icon("pencil"), "Bearbeiten"),
                deleteButton(recipe, errors))),
        errors.node,
        recipe.has_image
            ? el("img", { src: imageUrl(recipe), alt: `Bild von ${recipe.name}`, class: "recipe-image" })
            : null,
        servingsCalculator(recipe, errors),
        shopping.node,
        yazio.connected ? yazioBox(recipe, errors) : null,
        recipe.steps.length === 0 ? null : el("section", { class: "card" },
            el("h3", {}, "Zubereitung"),
            el("ol", { class: "step-list" }, recipe.steps.map((step) => el("li", {},
                el("span", {}, step.text),
                step.minutes ? el("span", { class: "badge" }, `${step.minutes} min`) : null)))),
        recipe.notes || recipe.source ? el("section", { class: "card" },
            el("h3", {}, "Notizen"),
            recipe.notes ? el("p", {}, recipe.notes) : null,
            recipe.source ? el("p", { class: "muted" }, `Quelle: ${recipe.source}`) : null) : null);
}

// Bearbeiten: /recipes/:id?edit=1, und /recipes/new für ein neues Rezept
export async function renderRecipeEditPage(id) {
    const errors = errorBox();
    const recipe = id === null ? null : (await api(`/api/recipes/${id}`)).recipe;
    document.title = `${recipe ? recipe.name : "Neues Rezept"} · Luca Smart Home`;
    const form = await recipeForm(recipe, errors);

    form.form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.form.reportValidity())
            return;
        form.saveButton.disabled = true;
        form.status.textContent = "Speichere …";
        try {
            const url = recipe ? `/api/recipes/${recipe.id}` : "/api/recipes";
            const saved = await api(url, { recipe: form.collect() });
            ingredientNames = null;   // es können neue Zutaten dazugekommen sein
            location.assign(`/recipes/${saved.recipe.id}`);
        } catch (err) {
            errors.show("form", `Speichern fehlgeschlagen: ${err.message}`);
            form.status.textContent = "";
            form.saveButton.disabled = false;
        }
    });

    showPage(
        breadcrumb([
            { label: "Rezepte", href: "/recipes" },
            ...(recipe ? [{ label: recipe.name, href: `/recipes/${recipe.id}` }] : []),
            { label: recipe ? "Bearbeiten" : "Neu" },
        ]),
        el("div", { class: "page-header" },
            el("h1", {}, recipe ? recipe.name : "Neues Rezept"),
            el("div", { class: "header-actions" },
                el("a", { class: "button", href: recipe ? `/recipes/${recipe.id}` : "/recipes" }, "Abbrechen"))),
        errors.node,
        form.node,
        // ein Bild braucht eine id, die es vor dem ersten Speichern noch nicht gibt
        recipe
            ? imageBox(recipe, errors, () => {})
            : el("p", { class: "muted hint" }, "Ein Bild kannst du hinzufügen, sobald das Rezept angelegt ist."));
}

/*************** Seite: Rezeptliste ***********************************************************/
function recipeCard(recipe) {
    return el("a", { class: "card link-card recipe-card", href: `/recipes/${recipe.id}` },
        recipe.has_image
            ? el("img", { src: imageUrl(recipe), alt: "", class: "recipe-thumb", loading: "lazy" })
            : null,
        el("div", {},
            el("h3", {}, recipe.name),
            el("p", { class: "muted" }, [
                plural(recipe.servings, "Portion", "Portionen"),
                recipe.total_minutes ? `${recipe.total_minutes} min` : null,
            ].filter(Boolean).join(" · ")),
            recipe.description ? el("p", { class: "recipe-card-text" }, recipe.description) : null,
            recipe.tags.length > 0
                ? el("p", { class: "tag-row" }, recipe.tags.map((tag) => el("span", { class: "badge" }, tag)))
                : null));
}

export async function renderRecipesPage() {
    document.title = "Rezepte · Luca Smart Home";
    const errors = errorBox();
    const params = new URLSearchParams(location.search);
    let query = params.get("q") ?? "";
    let activeTag = params.get("tag") ?? null;

    const search = el("input", {
        type: "search", id: "recipe-search", value: query, placeholder: "Name, Zutat, Zubereitung …",
        autocomplete: "off",
    });
    const results = el("div");
    const count = el("p", { class: "muted" });
    const tagRow = el("div", { class: "button-select" });

    // die Adresse mitführen, damit ein Treffer teilbar ist und Zurück funktioniert
    const remember = () => {
        const params = new URLSearchParams();
        if (query)
            params.set("q", query);
        if (activeTag)
            params.set("tag", activeTag);
        const queryString = params.toString();
        history.replaceState(null, "", `/recipes${queryString ? `?${queryString}` : ""}`);
    };

    const loadNow = async () => {
        const url = new URL("/api/recipes", location.origin);
        if (query)
            url.searchParams.set("q", query);
        if (activeTag)
            url.searchParams.set("tag", activeTag);
        try {
            const { recipes } = await api(url.pathname + url.search);
            count.textContent = recipes.length === 0 ? "" : plural(recipes.length, "Rezept", "Rezepte");
            results.replaceChildren(cardGrid(recipes.map(recipeCard),
                query || activeTag ? "Dazu gibt es kein Rezept." : "Noch kein Rezept angelegt."));
            errors.show("search", "");
        } catch (err) {
            errors.show("search", `Suche fehlgeschlagen: ${err.message}`);
        }
    };
    // beim Tippen gebremst, beim Öffnen der Seite sofort
    const load = throttle(loadNow, SEARCH_MS);

    search.addEventListener("input", () => {
        query = search.value.trim();
        remember();
        load();
    });

    // Tag-Filter als Knöpfe, wie der button_select einer Einstellung
    const showTags = (tags) => tagRow.replaceChildren(...tags.map((tag) => {
        const button = el("button", {
            type: "button", class: "choice", "aria-pressed": String(activeTag === tag.name),
        }, tag.name, el("span", { class: "muted" }, ` ${tag.count}`));
        button.addEventListener("click", () => {
            activeTag = activeTag === tag.name ? null : tag.name;
            showTags(tags);
            remember();
            loadNow();
        });
        return button;
    }));

    showPage(
        breadcrumb([{ label: "Rezepte" }]),
        el("div", { class: "page-header" },
            el("h1", {}, "Rezepte"),
            el("div", { class: "header-actions" },
                el("a", { class: "button", href: "/pantry" }, icon("pantry"), "Vorrat"),
                el("a", { class: "button primary", href: "/recipes/new" }, icon("plus"), "Neues Rezept"))),
        errors.node,
        el("div", { class: "search-row" }, search, count),
        tagRow,
        results);

    search.focus();
    // Tags und Treffer gleichzeitig laden, nicht eins nach dem anderen
    const tagsLoaded = api("/api/tags").then(({ tags }) => showTags(tags), () => {
        // ohne die Tag-Knöpfe lässt sich trotzdem suchen
    });
    await Promise.all([loadNow(), tagsLoaded]);
}
