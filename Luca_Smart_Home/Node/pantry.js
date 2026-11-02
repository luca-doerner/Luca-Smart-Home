/*
 * Der Vorrat: was zu Hause ist (Tabelle pantry_items).
 *
 * Jede Zutat kann höchstens einmal im Vorrat stehen — ingredient_id ist dort selbst der
 * Primärschlüssel. Genau das macht das Abziehen von der Einkaufsliste eindeutig
 * (planShoppingList in recipes.js).
 *
 * Zwei Arten von Eintrag:
 *   always_available = true    „ist immer da“ (Salz, Pfeffer, Öl), nichts zu zählen
 *   amount / unit              für die Dinge, die wirklich ausgehen; passt die Einheit zu der
 *                              im Rezept und ist zu wenig da, kommt nur die fehlende Menge auf
 *                              die Einkaufsliste
 *
 * Die Zutat wird wie überall über ihren Namen angesprochen; einen Namen, den der Katalog noch
 * nicht kennt, legt setPantryItem an.
 */
const db = require("./db");
const HttpError = require("./http-error");
const recipes = require("./recipes");

const MAX_NOTE = 200;

// alle Einträge: die „immer da“-Sachen zuerst, darin alphabetisch
async function listPantry() {
    const { rows } = await db.query(`
        SELECT p.ingredient_id, i.name, i.category, i.default_unit,
               p.always_available, p.amount, p.unit, p.note, p.updated_at
        FROM pantry_items p
        JOIN ingredients i ON i.id = p.ingredient_id
        ORDER BY p.always_available DESC, lower(i.name)`);
    return rows;
}

async function getPantryItem(ingredientId) {
    const { rows: [item] } = await db.query(`
        SELECT p.ingredient_id, i.name, i.category, i.default_unit,
               p.always_available, p.amount, p.unit, p.note, p.updated_at
        FROM pantry_items p
        JOIN ingredients i ON i.id = p.ingredient_id
        WHERE p.ingredient_id = $1`, [ingredientId]);
    return item ?? null;
}

// "Salz" oder 12: ein Name wird gesucht und, wenn es ihn noch nicht gibt, im Katalog angelegt
async function resolveIngredient(value, { create = true } = {}) {
    if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
        const id = Number(value);
        const { rows: [ingredient] } = await db.query("SELECT id FROM ingredients WHERE id = $1", [id]);
        if (!ingredient)
            throw new HttpError(404, "Zutat nicht gefunden");
        return id;
    }
    const name = recipes.requiredText(value, "Zutat");
    const found = await recipes.findIngredient(name);
    if (found)
        return found.id;
    if (!create)
        throw new HttpError(404, `Die Zutat „${name}“ gibt es nicht`);
    return (await recipes.createIngredient({ name })).id;
}

// Eintrag anlegen oder ändern: { ingredient, always_available?, amount?, unit?, note? }
async function setPantryItem(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input))
        recipes.fail("Es wird ein Objekt mit ingredient erwartet");

    const ingredientId = await resolveIngredient(input.ingredient);
    const alwaysAvailable = recipes.optionalBoolean(input.always_available, "always_available");
    const amount = recipes.optionalAmount(input.amount, "Menge");
    const unit = recipes.optionalText(input.unit, "Einheit", 20);
    const note = recipes.optionalText(input.note, "Hinweis", MAX_NOTE);
    if (amount === null && unit !== null)
        recipes.fail("Eine Einheit ohne Menge sagt nichts — bitte auch die Menge angeben");

    await db.query(`
        INSERT INTO pantry_items (ingredient_id, always_available, amount, unit, note)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (ingredient_id) DO UPDATE
            SET always_available = EXCLUDED.always_available, amount = EXCLUDED.amount,
                unit = EXCLUDED.unit, note = EXCLUDED.note, updated_at = now()`,
        [ingredientId, alwaysAvailable, amount, unit, note]);
    return getPantryItem(ingredientId);
}

async function removePantryItem(ingredientId) {
    const { rowCount } = await db.query("DELETE FROM pantry_items WHERE ingredient_id = $1", [ingredientId]);
    if (rowCount === 0)
        throw new HttpError(404, "Diese Zutat steht nicht im Vorrat");
    return { deleted: true };
}

// für die MCP-Werkzeuge, die nur den Namen kennen
async function removePantryItemByName(name) {
    return removePantryItem(await resolveIngredient(name, { create: false }));
}

module.exports = { listPantry, getPantryItem, setPantryItem, removePantryItem, removePantryItemByName };
