/*
 * Die Seite /nutrition „Ernährung“: das YAZIO-Tagebuch eines Tages. Die Summen und Ziele rechnet
 * YAZIO, die Einträge sind nach Mahlzeit geordnet; hier lässt sich auch ein Produkt suchen und
 * eintragen oder ein Eintrag löschen. Die Seite rechnet selbst nichts: was sie zeigt, kommt von
 * /api/yazio/day (yazio.js), damit sie dasselbe zeigt wie die MCP-Werkzeuge und die YAZIO-App.
 *
 * Was hier exportiert wird (MEALS, todayLocal, mealForNow, mealSelect, nutrientLine), braucht
 * auch die Rezeptseite für den Knopf „Portion nach YAZIO“.
 */
import { api, breadcrumb, el, errorBox, icon, showPage, throttle } from "./lib.js";

const SEARCH_MS = 300;   // so lange wird nach dem Tippen gewartet
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const MEALS = [
    { key: "breakfast", label: "Frühstück" },
    { key: "lunch", label: "Mittagessen" },
    { key: "dinner", label: "Abendessen" },
    { key: "snack", label: "Snacks" },
];

/*************** Kleine Helfer ****************************************************************/
const numberFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const fmt = (value) => (value === null || value === undefined ? "–" : numberFormat.format(value));

// heutiges Datum im Browser als JJJJ-MM-TT ("sv-SE" schreibt es von sich aus so)
export function todayLocal() {
    return new Date().toLocaleDateString("sv-SE");
}

// die Mahlzeit, die zur Uhrzeit passt, als Vorschlag für das Auswahlfeld
export function mealForNow() {
    const hour = new Date().getHours();
    return hour < 10 ? "breakfast" : hour < 15 ? "lunch" : hour < 18 ? "snack" : "dinner";
}

export function mealSelect(id, selected = mealForNow()) {
    return el("select", { id },
        MEALS.map((meal) => el("option", { value: meal.key, selected: meal.key === selected }, meal.label)));
}

// "540 kcal · 32 g Eiweiß · 48 g Kohlenhydrate · 21 g Fett"
export function nutrientLine(nutrients) {
    return `${fmt(nutrients.kcal)} kcal · ${fmt(nutrients.protein)} g Eiweiß · `
        + `${fmt(nutrients.carbs)} g Kohlenhydrate · ${fmt(nutrients.fat)} g Fett`;
}

// Datum um Tage verschieben; über UTC gerechnet, damit die Sommerzeit nichts verschiebt
function shiftDate(date, days) {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function dateLabel(date) {
    const [year, month, day] = date.split("-").map(Number);
    return new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
        .format(new Date(Date.UTC(year, month - 1, day)));
}

/*************** Balken ***********************************************************************/
function meter(label, value, goal, unit) {
    const percent = goal > 0 && value !== null ? Math.min(100, Math.round((value / goal) * 100)) : 0;
    const fill = el("div", { class: `meter-fill${goal > 0 && value > goal ? " over" : ""}` });
    fill.style.width = `${percent}%`;
    return el("div", { class: "meter" },
        el("div", { class: "meter-head" },
            el("span", {}, label),
            el("span", { class: "muted" }, `${fmt(value)} / ${fmt(goal)} ${unit}`)),
        el("div", {
            class: "meter-track", role: "progressbar", "aria-label": label,
            "aria-valuemin": 0, "aria-valuemax": goal ?? 0, "aria-valuenow": value ?? 0,
        }, fill));
}

function summaryCard(day) {
    return el("section", { class: "card" },
        el("h3", {}, "Tagesübersicht"),
        meter("Kalorien", day.total.kcal, day.goals.kcal, "kcal"),
        meter("Eiweiß", day.total.protein, day.goals.protein, "g"),
        meter("Kohlenhydrate", day.total.carbs, day.goals.carbs, "g"),
        meter("Fett", day.total.fat, day.goals.fat, "g"),
        el("p", { class: "muted hint" },
            `Wasser ${fmt(day.water_ml)} / ${fmt(day.goals.water_ml)} ml · Schritte ${fmt(day.steps)} / ${fmt(day.goals.steps)}`));
}

/*************** Einträge *********************************************************************/
// Löschen in zwei Schritten wie auf der Rezeptseite: der zweite Klick löscht wirklich
function removeButton(entry, errors, reload) {
    const button = el("button", { type: "button", class: "button", "aria-label": `${entry.name} löschen` }, icon("trash"));
    let armed = false;
    const reset = () => {
        armed = false;
        button.replaceChildren(icon("trash"));
        button.classList.remove("danger");
        button.disabled = false;
    };
    button.addEventListener("click", async () => {
        if (!armed) {
            armed = true;
            button.replaceChildren(icon("trash"), "Wirklich?");
            button.classList.add("danger");
            setTimeout(() => armed && reset(), 5000);
            return;
        }
        button.disabled = true;
        try {
            await api(`/api/yazio/entries/${entry.id}/delete`, {});
            errors.show("remove", "");
            await reload();
        } catch (err) {
            reset();
            errors.show("remove", `Löschen fehlgeschlagen: ${err.message}`);
        }
    });
    return button;
}

function entryText(entry) {
    const parts = [];
    if (entry.amount) parts.push(`${fmt(entry.amount)} ${entry.unit ?? "g"}`);
    if (entry.portions) parts.push(`${fmt(entry.portions)} Portionen`);
    if (entry.kcal !== undefined) parts.push(`${fmt(entry.kcal)} kcal`);
    return parts.join(" · ");
}

function mealCard(meal, data, errors, reload) {
    return el("section", { class: "card" },
        el("h3", {}, meal.label, " ",
            el("span", { class: "badge" }, `${fmt(data.kcal)} / ${fmt(data.goal_kcal)} kcal`)),
        data.entries.length === 0
            ? el("p", { class: "muted" }, "Nichts eingetragen.")
            : el("ul", { class: "diary-list" }, data.entries.map((entry) => el("li", {},
                el("div", { class: "diary-text" },
                    el("span", {}, entry.name),
                    el("span", { class: "muted" }, entryText(entry))),
                removeButton(entry, errors, reload)))));
}

/*************** Produkt suchen und eintragen *************************************************/
function addCard(getDate, errors, reload) {
    const query = el("input", {
        type: "search", id: "product-query", maxlength: 100, autocomplete: "off",
        placeholder: "Produkt suchen, z. B. Haferflocken", "aria-label": "Produkt suchen",
    });
    const results = el("div");
    let counter = 0;   // nur die Antwort auf die letzte Eingabe zählt

    async function search() {
        const text = query.value.trim();
        const mine = ++counter;
        if (text.length < 2) {
            results.replaceChildren();
            return;
        }
        try {
            const { products } = await api(`/api/yazio/products?query=${encodeURIComponent(text)}`);
            if (mine !== counter)
                return;
            errors.show("search", "");
            results.replaceChildren(products.length === 0
                ? el("p", { class: "muted" }, "Nichts gefunden.")
                : el("ul", { class: "diary-list" }, products.map((product) => productRow(product))));
        } catch (err) {
            if (mine === counter)
                errors.show("search", `Suche fehlgeschlagen: ${err.message}`);
        }
    }
    query.addEventListener("input", throttle(search, SEARCH_MS));

    function productRow(product) {
        const choose = el("button", { type: "button", class: "button" }, icon("plus"), "Wählen");
        const row = el("li", {},
            el("div", { class: "diary-text" },
                el("span", {}, product.name, product.producer ? el("span", { class: "muted" }, `, ${product.producer}`) : null),
                el("span", { class: "muted" }, `je 100 ${product.base_unit}: ${nutrientLine(product.per_100)}`)),
            choose);
        choose.addEventListener("click", () => {
            row.replaceWith(addForm(product));
        });
        return row;
    }

    function addForm(product) {
        const amount = el("input", {
            type: "number", id: "product-amount", min: 1, max: 10000, step: "any", required: true,
            value: product.serving_amount ?? 100, inputmode: "decimal",
        });
        const meal = mealSelect("product-meal");
        const status = el("p", { class: "form-status muted", role: "status" });
        const submit = el("button", { type: "submit", class: "button primary" }, "Eintragen");
        const form = el("form", { class: "add-form" },
            el("strong", {}, product.name),
            el("div", { class: "form-row" },
                el("div", { class: "form-field" }, el("label", { for: "product-amount" }, `Menge (${product.base_unit})`), amount),
                el("div", { class: "form-field" }, el("label", { for: "product-meal" }, "Mahlzeit"), meal)),
            el("div", { class: "form-actions" }, submit, status));
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            submit.disabled = true;
            status.textContent = "Trage ein …";
            try {
                await api("/api/yazio/entries", {
                    product_id: product.product_id, amount: Number(amount.value), daytime: meal.value, date: getDate(),
                });
                errors.show("add", "");
                await reload();
                query.value = "";
                results.replaceChildren();
            } catch (err) {
                errors.show("add", `Eintragen fehlgeschlagen: ${err.message}`);
                status.textContent = "";
                submit.disabled = false;
            }
        });
        return form;
    }

    return el("section", { class: "card" },
        el("h3", {}, "Produkt eintragen"),
        el("div", { class: "search-row" }, query),
        results);
}

/*************** Seite ************************************************************************/
export async function renderNutritionPage() {
    document.title = "Ernährung · Luca Smart Home";
    const errors = errorBox();
    const slot = el("div");
    showPage(breadcrumb([{ label: "Ernährung" }]), el("h1", {}, "Ernährung"), errors.node, slot);

    const account = await api("/api/yazio");
    if (!account.connected) {
        slot.replaceChildren(el("section", { class: "card" },
            el("h3", {}, "YAZIO ist nicht verbunden"),
            el("p", {}, "Melde dich auf der Seite ", el("a", { href: "/account" }, "Konto"),
                " bei YAZIO an, dann steht hier dein Tagebuch.")));
        return;
    }

    const asked = new URLSearchParams(location.search).get("date");
    let date = DATE_PATTERN.test(asked ?? "") ? asked : todayLocal();

    const content = el("div");
    const label = el("p", { class: "date-label", "aria-live": "polite" });
    const picker = el("input", { type: "date", id: "day-picker", value: date, "aria-label": "Tag wählen" });
    const previous = el("button", { type: "button", class: "button", "aria-label": "Vorheriger Tag" }, "‹");
    const next = el("button", { type: "button", class: "button", "aria-label": "Nächster Tag" }, "›");
    const today = el("button", { type: "button", class: "button" }, "Heute");

    let counter = 0;   // nur die Antwort auf den zuletzt gewählten Tag wird gezeigt
    async function load() {
        const mine = ++counter;
        picker.value = date;
        label.textContent = dateLabel(date);
        history.replaceState(null, "", date === todayLocal() ? "/nutrition" : `/nutrition?date=${date}`);
        try {
            const day = await api(`/api/yazio/day?date=${date}`);
            if (mine !== counter)
                return;
            errors.show("day", "");
            content.replaceChildren(
                summaryCard(day),
                // flach, nicht verschachtelt: replaceChildren macht aus einer Liste sonst Text
                ...MEALS.map((meal) => mealCard(meal, day.meals[meal.key], errors, load)));
        } catch (err) {
            if (mine !== counter)
                return;
            content.replaceChildren();
            errors.show("day", `Tag konnte nicht geladen werden: ${err.message}`);
        }
    }

    const go = (to) => {
        date = to;
        load();
    };
    previous.addEventListener("click", () => go(shiftDate(date, -1)));
    next.addEventListener("click", () => go(shiftDate(date, 1)));
    today.addEventListener("click", () => go(todayLocal()));
    picker.addEventListener("change", () => DATE_PATTERN.test(picker.value) && go(picker.value));

    slot.replaceChildren(
        el("div", { class: "date-bar" }, previous, picker, next, today),
        label,
        content,
        addCard(() => date, errors, load));
    await load();
}
