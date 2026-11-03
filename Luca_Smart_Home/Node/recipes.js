/*
 * Rezepte, Zutaten, Tags, Skalieren und die Einkaufsliste (Tabellen ingredients, recipes,
 * recipe_ingredients, recipe_steps; der Vorrat selbst steht in pantry.js).
 *
 * Rezepte sind das erste auf dieser Seite, was kein Gerät ist. Das Einstellungssystem in
 * smarthome.js (setting_definitions, validateValue) ist für die Zahlen und Farben eines
 * LED-Programms gebaut, nicht für Zutatenlisten — deshalb steht hier eine eigene Prüfung
 * daneben, aber im gleichen Stil: eine fail()-Funktion, deutsche Meldungen, HttpError(400).
 *
 * Zutaten werden immer über ihren Namen geschrieben, nie über eine id. Sonst müsste ein
 * KI-Agent (mcp.js) erst Zutaten-ids einsammeln, bevor er ein Rezept speichern kann. Namen, die
 * der Katalog noch nicht kennt, werden dabei angelegt.
 *
 * Umgebungsvariable:
 *   RECIPE_IMAGE_DIR   Ordner für die Rezeptbilder (Standard /var/lib/luca-smart-home/recipe-images);
 *                      die Bilder liegen bewusst nicht in der Datenbank (db.js: max: 1) und
 *                      außerhalb des Ordners, den der Deploy kopiert
 */
const fs = require("fs");
const path = require("path");
const db = require("./db");
const HttpError = require("./http-error");

/*************** Grenzen *********************************************************************/
const MAX_NAME = 200;
const MAX_TEXT = 2000;
const MAX_INGREDIENTS = 100;
const MAX_STEPS = 60;
const MAX_TAGS = 20;
const MAX_TAG = 50;
const MAX_SERVINGS = 100;
const MAX_LIST = 50;             // Treffer pro Suche
const DIFFICULTIES = ["einfach", "mittel", "schwer"];

const IMAGE_DIR = process.env.RECIPE_IMAGE_DIR || "/var/lib/luca-smart-home/recipe-images";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/*************** Prüfung *********************************************************************/
function fail(message) {
    throw new HttpError(400, message);
}

// Text, der fehlen darf: "" und null werden zu null, sonst ohne Leerzeichen am Rand
function optionalText(value, label, max = MAX_TEXT) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string")
        fail(`${label} muss ein Text sein`);
    const text = value.trim();
    if (text === "")
        return null;
    if (text.length > max)
        fail(`${label} darf höchstens ${max} Zeichen haben`);
    return text;
}

function requiredText(value, label, max = MAX_NAME) {
    const text = optionalText(value, label, max);
    if (text === null)
        fail(`${label} fehlt`);
    return text;
}

// ganze Zahl, die fehlen darf (null)
function optionalInteger(value, label, max) {
    if (value === undefined || value === null || value === "")
        return null;
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isInteger(number))
        fail(`${label} muss eine ganze Zahl sein`);
    if (number < 0 || number > max)
        fail(`${label} muss zwischen 0 und ${max} liegen`);
    return number;
}

// Menge einer Zutat: Komma-Zahl, darf fehlen ("etwas Öl")
function optionalAmount(value, label) {
    if (value === undefined || value === null || value === "")
        return null;
    const number = typeof value === "string" ? Number(value.replace(",", ".")) : value;
    if (typeof number !== "number" || !Number.isFinite(number))
        fail(`${label} muss eine Zahl sein`);
    if (number <= 0)
        fail(`${label} muss größer als 0 sein`);
    if (number > 1e6)
        fail(`${label} ist zu groß`);
    // drei Stellen reichen für jede Küche und halten Rundungsreste aus dem Skalieren heraus
    return Number(number.toFixed(3));
}

function optionalBoolean(value, label) {
    if (value === undefined || value === null)
        return false;
    if (typeof value !== "boolean")
        fail(`${label} muss true oder false sein`);
    return value;
}

// Portionen aus einer Anfrage (?servings=6), null wenn nichts angegeben ist
function parseServings(value) {
    if (value === undefined || value === null || value === "")
        return null;
    const servings = optionalInteger(value, "servings", MAX_SERVINGS);
    if (servings < 1)
        fail("servings muss mindestens 1 sein");
    return servings;
}

// Tags ohne Doppelte; "Nudeln" und "nudeln" sind dasselbe Tag, die erste Schreibweise gewinnt
function normalizeTags(value) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        fail("tags muss eine Liste sein");
    if (value.length > MAX_TAGS)
        fail(`Höchstens ${MAX_TAGS} Tags`);
    const tags = new Map();
    for (const entry of value) {
        const tag = optionalText(entry, "Tag", MAX_TAG);
        if (tag !== null && !tags.has(tag.toLowerCase()))
            tags.set(tag.toLowerCase(), tag);
    }
    return [...tags.values()];
}

// Schreibweisen desselben Namens gleich behandeln: „Chipotle-Pulver“ = „chipotle pulver“
const nameKey = (name) => name.toLowerCase().replace(/[\s-]+/g, " ").trim();

// ein Hauptwort: groß, danach klein. „TK“, „EL“ oder „z. B.“ sind keins.
const NOUN = /[A-ZÄÖÜ][a-zäöüß]/;

// Wörter, mit denen nach „oder“ keine andere Zutat anfängt, sondern eine Menge oder Form:
// „oder mehr nach Geschmack“, „oder nach Belieben“, „oder aus der Dose“
const NOT_AN_ALTERNATIVE = new Set(["mehr", "weniger", "nach", "je", "etwas", "ganz", "nur", "aus",
    "in", "im", "mit", "ohne", "vom", "von", "zum", "zur", "als", "wie", "so", "bis", "halb", "doppelt"]);

// „oder Chipotle Pulver“ im Hinweis einer Zutat: so schreibt man eine Alternative, wenn man das
// Feld alternative_group nicht benutzt (eine KI tut das gern). Gibt den Namen der Alternative
// zurück oder null.
//
// Eine falsche Erkennung lehnt beim Speichern ein richtiges Rezept ab — deshalb eng:
// - am Anfang („oder getrockneter Oregano“): es muss ein Hauptwort folgen, und das erste Wort
//   darf keins aus NOT_AN_ALTERNATIVE sein („oder mehr nach Geschmack“ ist keine Alternative)
// - mitten im Text: das Wort direkt nach „oder“ muss ein Hauptwort sein („fein gewürfelt oder
//   gerieben“ und „frisch oder TK“ sind keine), und davor darf keins stehen — „z. B. Gouda oder
//   Emmentaler“ beim Käse beschreibt den Käse, statt eine andere Zutat anzubieten
function alternativeInNote(note) {
    if (!note)
        return null;
    const atStart = note.match(/^\s*(?:oder|bzw\.?|alternativ(?:e|ly)?:?|ersatzweise)\s+(?:auch\s+)?([^,;()]+)/i);
    if (atStart) {
        const phrase = atStart[1].trim();
        const first = phrase.split(/\s+/)[0].toLowerCase();
        return NOUN.test(phrase) && !NOT_AN_ALTERNATIVE.has(first) ? phrase : null;
    }
    const inside = note.match(/^(.*?)\s(?:oder|bzw\.?|alternativ:?|ersatzweise)\s+(?:auch\s+)?([A-ZÄÖÜ][^,;()]*)/);
    if (inside && NOUN.test(inside[2]) && !NOUN.test(inside[1]))
        return inside[2].trim();
    return null;
}

// „Chiliflocken oder Chipotle Pulver“ als ein einziger Name -> ["Chiliflocken", "Chipotle Pulver"]
const namedAlternatives = (name) => name.split(/\s+oder\s+/i).map((part) => part.trim()).filter(Boolean);

// so heißt das Feld auf der Seite und im MCP-Schema — die Meldung muss für beide passen
const GROUP_FIELD = "„Entweder/oder“ (alternative_group)";

// eine Zeile der Zutatenliste eines Rezepts
function normalizeIngredient(entry, index) {
    const where = `Zutat ${index + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        fail(`${where} muss ein Objekt sein`);
    const normalized = {
        name: requiredText(entry.name, `${where}: Name`),
        amount: optionalAmount(entry.amount, `${where}: Menge`),
        unit: optionalText(entry.unit, `${where}: Einheit`, 20),
        note: optionalText(entry.note, `${where}: Hinweis`, MAX_NAME),
        group_label: optionalText(entry.group_label, `${where}: Gruppe`, MAX_NAME),
        optional: optionalBoolean(entry.optional, `${where}: optional`),
        alternative_group: optionalText(entry.alternative_group, `${where}: Alternative`, MAX_NAME),
    };
    // Abgelehnt statt still umgebaut: so lernt eine KI aus der Fehlermeldung, es richtig zu
    // machen, und im Rezept steht die Alternative dort, wo die Einkaufsliste sie findet
    const alternative = normalized.alternative_group ? null : alternativeInNote(normalized.note);
    if (alternative)
        fail(`${where}: Der Hinweis „${normalized.note}“ nennt eine Alternative. Alternativen gehören `
            + `nicht in den Hinweis, sonst werden beide eingekauft: lege „${alternative}“ als eigene Zutat `
            + `an (mit derselben Menge und Einheit) und gib beiden Zutaten denselben Text in `
            + `${GROUP_FIELD}, z. B. „Schärfe“.`);
    // dasselbe für „A oder B“ als Name: im Katalog stünde sonst eine Zutat „Chiliflocken oder
    // Chipotle Pulver“, die der Vorrat nie findet
    const parts = namedAlternatives(normalized.name);
    if (parts.length > 1)
        fail(`${where}: „${normalized.name}“ sind ${parts.length} Zutaten zur Auswahl, nicht eine. `
            + `Lege ${parts.map((part) => `„${part}“`).join(", ")} als eigene Zutaten an und gib ihnen `
            + `denselben Text in ${GROUP_FIELD}, z. B. „Schärfe“.`);
    return normalized;
}

function normalizeStep(entry, index) {
    const where = `Schritt ${index + 1}`;
    if (typeof entry === "string")
        return { text: requiredText(entry, where, MAX_TEXT), minutes: null };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        fail(`${where} muss ein Objekt oder ein Text sein`);
    return {
        text: requiredText(entry.text, `${where}: Text`, MAX_TEXT),
        minutes: optionalInteger(entry.minutes, `${where}: Minuten`, 10000),
    };
}

function normalizeList(value, label, max, normalize) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        fail(`${label} muss eine Liste sein`);
    if (value.length > max)
        fail(`Höchstens ${max} ${label}`);
    return value.map(normalize);
}

// ein ganzes Rezept aus einer Anfrage, so wie es in die Datenbank geht
function normalizeRecipe(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input))
        fail("recipe muss ein Objekt sein");

    const difficulty = optionalText(input.difficulty, "Schwierigkeit", 20);
    if (difficulty !== null && !DIFFICULTIES.includes(difficulty))
        fail(`Schwierigkeit muss ${DIFFICULTIES.join(", ")} oder leer sein`);

    const servings = optionalInteger(input.servings, "Portionen", MAX_SERVINGS) ?? 4;
    if (servings < 1)
        fail("Portionen muss mindestens 1 sein");

    const ingredients = normalizeList(input.ingredients, "Zutaten", MAX_INGREDIENTS, normalizeIngredient);
    // zweimal dieselbe Zutat wäre beim Abziehen vom Vorrat nicht mehr eindeutig
    const seen = new Set();
    for (const ingredient of ingredients) {
        const key = ingredient.name.toLowerCase();
        if (seen.has(key))
            fail(`Die Zutat „${ingredient.name}“ steht zweimal in der Liste`);
        seen.add(key);
    }
    // eine Alternative allein ist keine Wahl — meist ein Tippfehler („Schärfe“ / „Schaerfe“)
    // oder die zweite Zutat fehlt. Groß/klein zählt nicht, genau wie in planShoppingList.
    const groupSizes = new Map();
    for (const { alternative_group: group } of ingredients)
        if (group)
            groupSizes.set(group.toLowerCase(), (groupSizes.get(group.toLowerCase()) ?? 0) + 1);
    const lonely = ingredients.find((entry) => groupSizes.get(entry.alternative_group?.toLowerCase()) === 1);
    if (lonely)
        fail(`Die Zutat „${lonely.name}“ ist die einzige mit ${GROUP_FIELD} „${lonely.alternative_group}“. `
            + "Eine Alternative braucht mindestens zwei Zutaten mit demselben Text (Groß-/Kleinschreibung "
            + "egal); sonst das Feld leer lassen.");

    return {
        name: requiredText(input.name, "Name"),
        description: optionalText(input.description, "Beschreibung"),
        servings,
        prep_minutes: optionalInteger(input.prep_minutes, "Vorbereitungszeit", 10000),
        cook_minutes: optionalInteger(input.cook_minutes, "Kochzeit", 10000),
        difficulty,
        tags: normalizeTags(input.tags),
        source: optionalText(input.source, "Quelle", 500),
        notes: optionalText(input.notes, "Notizen"),
        ingredients,
        steps: normalizeList(input.steps, "Schritte", MAX_STEPS, normalizeStep),
    };
}

/*************** Zutaten-Katalog **************************************************************/
// legt die Namen an, die der Katalog noch nicht kennt, und gibt lower(name) -> id zurück.
// client: damit das Anlegen in derselben Transaktion läuft wie das Rezept.
async function ingredientIds(client, names) {
    if (names.length === 0)
        return new Map();
    const lower = names.map((name) => name.toLowerCase());

    // DISTINCT ON: zwei Schreibweisen desselben Namens in einer Anfrage würden sonst am
    // eindeutigen Index ingredients_name_idx scheitern
    await client.query(`
        INSERT INTO ingredients (name)
        SELECT d.n FROM (
            SELECT DISTINCT ON (lower(n)) n FROM unnest($1::text[]) AS n ORDER BY lower(n)
        ) AS d (n)
        WHERE NOT EXISTS (SELECT 1 FROM ingredients i WHERE lower(i.name) = lower(d.n))
        ON CONFLICT (lower(name)) DO NOTHING`, [names]);

    const { rows } = await client.query(
        "SELECT id, name FROM ingredients WHERE lower(name) = ANY($1::text[])", [lower]);
    return new Map(rows.map((row) => [row.name.toLowerCase(), row.id]));
}

// Zutaten für die Autovervollständigung; q sucht am Anfang und irgendwo im Namen
async function listIngredients(q) {
    const search = (q ?? "").trim();
    const { rows } = await db.query(`
        SELECT i.id, i.name, i.category, i.default_unit,
               EXISTS (SELECT 1 FROM pantry_items p WHERE p.ingredient_id = i.id) AS in_pantry
        FROM ingredients i
        WHERE $1 = '' OR i.name ILIKE '%' || $1 || '%'
        ORDER BY (lower(i.name) LIKE lower($1) || '%') DESC, lower(i.name)
        LIMIT 100`, [search]);
    return rows;
}

// eine Zutat anlegen oder, wenn es den Namen schon gibt, die vorhandene ergänzen
async function createIngredient(input) {
    const name = requiredText(input?.name, "Name");
    const category = optionalText(input?.category, "Kategorie", MAX_NAME);
    const defaultUnit = optionalText(input?.default_unit, "Einheit", 20);
    const { rows: [ingredient] } = await db.query(`
        INSERT INTO ingredients (name, category, default_unit) VALUES ($1, $2, $3)
        ON CONFLICT (lower(name)) DO UPDATE
            SET category = COALESCE(EXCLUDED.category, ingredients.category),
                default_unit = COALESCE(EXCLUDED.default_unit, ingredients.default_unit)
        RETURNING id, name, category, default_unit`, [name, category, defaultUnit]);
    return ingredient;
}

// Zutat über ihren Namen, für den Vorrat und die MCP-Werkzeuge
async function findIngredient(name) {
    const wanted = requiredText(name, "Zutat");
    const { rows: [ingredient] } = await db.query(
        "SELECT id, name, category, default_unit FROM ingredients WHERE lower(name) = lower($1)", [wanted]);
    return ingredient ?? null;
}

// alle Tags mit ihrer Anzahl; min(t) ist die Schreibweise, die angezeigt wird
async function listTags() {
    const { rows } = await db.query(`
        SELECT min(t) AS name, count(*)::int AS count
        FROM recipes, unnest(tags) AS t
        GROUP BY lower(t)
        ORDER BY count(*) DESC, lower(min(t))`);
    return rows;
}

/*************** Lesen ***********************************************************************/
const RECIPE_COLUMNS = `
    id, name, description, servings, prep_minutes, cook_minutes, difficulty, tags, source, notes,
    image_mime IS NOT NULL AS has_image, image_updated_at, created_at, updated_at`;

// ein Rezept vollständig: { id, name, ..., ingredients: [...], steps: [...] }
async function getRecipe(id) {
    const { rows: [recipe] } = await db.query(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE id = $1`, [id]);
    if (!recipe)
        throw new HttpError(404, "Rezept nicht gefunden");

    const { rows: ingredients } = await db.query(`
        SELECT i.name, r.amount, r.unit, r.note, r.group_label, r.optional, r.alternative_group
        FROM recipe_ingredients r
        JOIN ingredients i ON i.id = r.ingredient_id
        WHERE r.recipe_id = $1
        ORDER BY r.position`, [id]);
    const { rows: steps } = await db.query(
        "SELECT text, minutes FROM recipe_steps WHERE recipe_id = $1 ORDER BY position", [id]);

    return { ...recipe, ingredients, steps };
}

// Tags mit der Schreibweise, die in der Datenbank steht: so findet "vegetarisch" auch
// "Vegetarisch", und die Abfrage kann trotzdem tags && ARRAY[...] mit dem GIN-Index benutzen
async function matchingTags(tag) {
    const { rows } = await db.query(
        "SELECT DISTINCT t FROM recipes, unnest(tags) AS t WHERE lower(t) = lower($1)", [tag]);
    return rows.map((row) => row.t);
}

// Suchtreffer in der kurzen Form, absichtlich klein, damit ein Agent viele davon lesen kann
const SHORT_COLUMNS = `
    r.id, r.name, r.description, r.tags, r.servings,
    CASE WHEN r.prep_minutes IS NULL AND r.cook_minutes IS NULL THEN NULL
         ELSE COALESCE(r.prep_minutes, 0) + COALESCE(r.cook_minutes, 0) END AS total_minutes,
    r.image_mime IS NOT NULL AS has_image`;

// Suche: Volltext über recipes_search, ohne q alle Rezepte; tag / tags filtern zusätzlich.
// Findet die Volltextsuche nichts (Teilwort, Tippfehler), wird mit ILIKE auf dem Namen
// nachgesehen — bei dieser Datenmenge ist der Durchlauf über alle Zeilen nicht messbar.
//
// Mehrere Tags werden mit UND verknüpft („vegetarisch“ und „schnell“), innerhalb eines Tags
// zählt jede Schreibweise. Die Bedingungen werden dafür zusammengesetzt — in die Abfrage kommen
// aber nur unsere eigenen Platzhalternummern ($1, $2, ...), nie Text aus der Anfrage.
async function listRecipes({ q, tag, tags, limit } = {}) {
    const search = (q ?? "").trim();
    const wantedLimit = optionalInteger(limit, "limit", MAX_LIST);
    if (wantedLimit === 0)
        fail("limit muss mindestens 1 sein");
    const max = wantedLimit ?? MAX_LIST;

    const wantedTags = [...(tag ? [tag] : []), ...(Array.isArray(tags) ? tags : [])]
        .map((entry) => requiredText(entry, "Tag", MAX_TAG));
    const params = [];
    const conditions = [];
    for (const name of wantedTags) {
        const spellings = await matchingTags(name);
        if (spellings.length === 0)
            return [];      // dieses Tag kommt an keinem Rezept vor
        params.push(spellings);
        conditions.push(`r.tags && $${params.length}::text[]`);
    }
    const tagWhere = conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";

    if (search === "") {
        const { rows } = await db.query(`
            SELECT ${SHORT_COLUMNS} FROM recipes r
            WHERE true${tagWhere}
            ORDER BY lower(r.name) LIMIT $${params.length + 1}`, [...params, max]);
        return rows;
    }

    const query = `websearch_to_tsquery('german', $${params.length + 1})`;
    const { rows } = await db.query(`
        SELECT ${SHORT_COLUMNS} FROM recipes r
        JOIN recipes_search s ON s.id = r.id
        WHERE s.document @@ ${query}${tagWhere}
        ORDER BY ts_rank(s.document, ${query}) DESC, lower(r.name)
        LIMIT $${params.length + 2}`, [...params, search, max]);
    if (rows.length > 0)
        return rows;

    const { rows: fallback } = await db.query(`
        SELECT ${SHORT_COLUMNS} FROM recipes r
        WHERE r.name ILIKE '%' || $${params.length + 1} || '%'${tagWhere}
        ORDER BY lower(r.name) LIMIT $${params.length + 2}`, [...params, search, max]);
    return fallback;
}

/*************** Schreiben *******************************************************************/
// Rezept anlegen (id = null) oder ersetzen. Zutaten und Schritte werden komplett neu geschrieben
// (DELETE + INSERT in einer Transaktion, wie setFeatureActive in smarthome.js): bei Listen mit
// Reihenfolge ist Ersetzen das einzige, was vorhersagbar ist.
async function saveRecipe(id, input, userId = null) {
    const recipe = normalizeRecipe(input);
    const client = await db.connect();
    let recipeId = id;
    try {
        await client.query("BEGIN");
        const values = [
            recipe.name, recipe.description, recipe.servings, recipe.prep_minutes, recipe.cook_minutes,
            recipe.difficulty, recipe.tags, recipe.source, recipe.notes,
        ];
        if (id === null) {
            const { rows: [created] } = await client.query(`
                INSERT INTO recipes (name, description, servings, prep_minutes, cook_minutes,
                                     difficulty, tags, source, notes, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`, [...values, userId]);
            recipeId = created.id;
        } else {
            const { rows: [updated] } = await client.query(`
                UPDATE recipes SET name = $2, description = $3, servings = $4, prep_minutes = $5,
                    cook_minutes = $6, difficulty = $7, tags = $8, source = $9, notes = $10,
                    updated_at = now()
                WHERE id = $1 RETURNING id`, [id, ...values]);
            if (!updated)
                throw new HttpError(404, "Rezept nicht gefunden");
        }

        const ids = await ingredientIds(client, recipe.ingredients.map((entry) => entry.name));
        await client.query("DELETE FROM recipe_ingredients WHERE recipe_id = $1", [recipeId]);
        await client.query("DELETE FROM recipe_steps WHERE recipe_id = $1", [recipeId]);

        // eine Abfrage für die ganze Liste: unnest() legt die Spalten wieder nebeneinander
        if (recipe.ingredients.length > 0)
            await client.query(`
                INSERT INTO recipe_ingredients
                    (recipe_id, position, ingredient_id, amount, unit, note, group_label, optional,
                     alternative_group)
                SELECT $1, position, ingredient_id, amount, unit, note, group_label, optional,
                       alternative_group
                FROM unnest($2::int[], $3::bigint[], $4::double precision[], $5::text[], $6::text[],
                            $7::text[], $8::boolean[], $9::text[])
                     AS t (position, ingredient_id, amount, unit, note, group_label, optional,
                           alternative_group)`, [
                recipeId,
                recipe.ingredients.map((_, index) => index + 1),
                recipe.ingredients.map((entry) => ids.get(entry.name.toLowerCase())),
                recipe.ingredients.map((entry) => entry.amount),
                recipe.ingredients.map((entry) => entry.unit),
                recipe.ingredients.map((entry) => entry.note),
                recipe.ingredients.map((entry) => entry.group_label),
                recipe.ingredients.map((entry) => entry.optional),
                recipe.ingredients.map((entry) => entry.alternative_group),
            ]);

        if (recipe.steps.length > 0)
            await client.query(`
                INSERT INTO recipe_steps (recipe_id, position, text, minutes)
                SELECT $1, position, text, minutes
                FROM unnest($2::int[], $3::text[], $4::int[]) AS t (position, text, minutes)`, [
                recipeId,
                recipe.steps.map((_, index) => index + 1),
                recipe.steps.map((step) => step.text),
                recipe.steps.map((step) => step.minutes),
            ]);

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        // 23505 = unique_violation, hier immer der Name (recipes_name_idx)
        if (err.code === "23505")
            throw new HttpError(409, `Es gibt schon ein Rezept mit dem Namen „${recipe.name}“`);
        throw err;
    } finally {
        client.release();
    }
    return getRecipe(recipeId);
}

async function deleteRecipe(id) {
    const { rowCount } = await db.query("DELETE FROM recipes WHERE id = $1", [id]);
    if (rowCount === 0)
        throw new HttpError(404, "Rezept nicht gefunden");
    // Das Bild hängt nicht am ON DELETE CASCADE, es liegt im Dateisystem — und zwar erst
    // hinterher: bliebe das Rezept wider Erwarten stehen, wäre sonst sein Bild schon weg.
    await deleteImage(id, { quiet: true });
    return { deleted: true };
}

/*************** Skalieren *******************************************************************/
// Mengen runden, damit beim Skalieren keine krummen Zahlen entstehen: große Mengen auf ganze
// Zahlen (750 g statt 750,0001 g), mittlere auf halbe Schritte (1,5 Zwiebeln), kleine auf zwei
// Stellen (0,25 TL). Zutaten ohne Menge („etwas Öl“) bleiben, wie sie sind.
function scaleAmount(amount, factor) {
    if (amount === null)
        return null;
    const scaled = amount * factor;
    if (scaled >= 10)
        return Math.round(scaled);
    if (scaled >= 1)
        return Math.round(scaled * 2) / 2;
    return Math.max(Math.round(scaled * 100) / 100, 0.01);
}

// Zutaten eines Rezepts, optional auf andere Portionen gerechnet
async function getRecipeIngredients(id, servings) {
    const wanted = parseServings(servings);
    const recipe = await getRecipe(id);
    const target = wanted ?? recipe.servings;
    const factor = target / recipe.servings;
    return {
        id: recipe.id,
        name: recipe.name,
        servings: target,
        recipe_servings: recipe.servings,
        ingredients: recipe.ingredients.map((entry) => ({ ...entry, amount: scaleAmount(entry.amount, factor) })),
    };
}

/*************** Einkaufsliste ***************************************************************/
// Menge und Einheit als ein Text, genau so, wie Bring! die "specification" eines Eintrags
// erwartet: "750 g", "2" oder, wenn es keine Menge gibt, der Hinweis ("zum Braten")
function spec(amount, unit, note) {
    if (amount === null)
        return note ?? "";
    return unit ? `${formatAmount(amount)} ${unit}` : formatAmount(amount);
}

// 1.5 -> "1,5", 750 -> "750" (deutsches Komma, keine Nullen hinten)
function formatAmount(amount) {
    return String(Number(amount.toFixed(2))).replace(".", ",");
}

/*
 * Einkaufsliste für ein oder mehrere Rezepte.
 *
 *   items       was gekauft werden muss, genau in der Form, die Bring!
 *               saveItem(listUuid, itemName, specification) braucht: { name, spec }
 *   from_pantry was aus dem Vorrat kommt und deshalb nicht auf der Liste steht; das muss der
 *               Agent dem Benutzer trotzdem nennen, sonst fehlt am Ende etwas
 *   choices     Alternativen („A oder B“): { question, options: [{ name, spec, in_pantry? }] }.
 *               Stehen NICHT in items — der Benutzer wählt je Frage genau eine Option
 *   note        der Satz, der genau daran erinnert
 *
 * Die Regel ist bewusst eine einzige: eine Zutat, die im Vorrat steht, kommt nicht auf die
 * Liste — außer der Vorrat hat dieselbe Einheit und zu wenig davon, dann nur die fehlende Menge.
 * Mehrere Rezepte werden zusammengefasst: gleiche Zutat und gleiche Einheit werden addiert.
 */
async function planShoppingList(recipeIds, servings) {
    if (!Array.isArray(recipeIds) || recipeIds.length === 0)
        fail("Mindestens ein Rezept angeben");
    if (recipeIds.length > 20)
        fail("Höchstens 20 Rezepte auf einmal");

    // Zusammenfassen nach Zutat: gleiche Einheit wird addiert, unterschiedliche Einheiten
    // bleiben getrennt (500 g und 2 Packungen lassen sich nicht zusammenrechnen). Eine Zutat
    // ohne Menge („Butter zum Braten“) bringt keine Menge mit und wird deshalb in einen
    // vorhandenen Eintrag derselben Zutat eingehängt, statt eine zweite Zeile zu erzeugen.
    const unitKey = (unit) => (unit ?? "").toLowerCase();
    // zwei Mengen derselben Zutat passen zusammen, wenn eine keine Menge hat oder die Einheit gleich ist
    const fits = (a, b) => a.amount === null || b.amount === null || unitKey(a.unit) === unitKey(b.unit);
    // b in a einrechnen (a wird verändert)
    function combine(a, b) {
        if (a.amount === null) {
            a.amount = b.amount;
            a.unit ??= b.unit;
        } else if (b.amount !== null) {
            a.amount = Number((a.amount + b.amount).toFixed(3));
        }
        a.note ??= b.note;
    }
    const needed = new Map();   // name (klein) -> [{ name, unit, amount, note }]
    // existing: nur in einen vorhandenen Eintrag einrechnen, keinen neuen anlegen (false = ging nicht)
    function addNeeded(entry, existing = false) {
        const entries = needed.get(entry.name.toLowerCase()) ?? [];
        const found = entry.amount === null ? entries[0] : entries.find((other) => fits(other, entry));
        if (found)
            combine(found, entry);
        else if (existing)
            return false;
        else
            needed.set(entry.name.toLowerCase(), [...entries, { name: entry.name, unit: entry.unit, amount: entry.amount, note: entry.note }]);
        return true;
    }

    // Alternativen („entweder Chiliflocken oder Chipotle-Pulver“) werden nie einfach auf die Liste
    // gesetzt: sie sind eine Wahl. Dieselbe Wahl aus mehreren Rezepten wird eine Frage, die
    // Mengen werden je Option addiert — wie bei normalen Zutaten und nur, wenn die Einheiten passen.
    const groups = new Map();   // Namen der Optionen -> [Zutaten, von denen eine genügt]
    function addGroup(options) {
        const copies = options.map(({ name, unit, amount, note }) => ({ name, unit, amount, note }));
        const key = copies.map((option) => nameKey(option.name)).sort().join("|");
        const existing = groups.get(key);
        const partner = (option) => existing.find((other) => nameKey(other.name) === nameKey(option.name));
        if (!existing)
            groups.set(key, copies);
        else if (copies.every((option) => fits(partner(option), option)))
            copies.forEach((option) => combine(partner(option), option));
        else
            groups.set(`${key}#${groups.size}`, copies);
    }

    const used = [];            // welches Rezept mit wie vielen Portionen gerechnet wurde
    for (const recipeId of recipeIds) {
        const recipe = await getRecipeIngredients(recipeId, servings);
        const { ingredients, servings: target } = recipe;
        used.push({ id: recipe.id, name: recipe.name, servings: target });

        // Rezepte, die vor der Prüfung in normalizeIngredient gespeichert wurden, können die
        // Alternative noch im Hinweis tragen („oder Chipotle Pulver“). Steht die genannte Zutat
        // zusätzlich als eigene Zeile da, ist diese Zeile die zweite Option (mit ihrer eigenen
        // Menge) und wird nicht noch einmal gezählt — auch nicht, wenn sie selbst „oder A“ sagt.
        const plain = ingredients.filter((entry) => !entry.alternative_group);
        const own = new Map(plain.map((entry) => [nameKey(entry.name), entry]));
        const partners = new Map();   // Zeile mit Alternative im Hinweis -> zweite Option
        const taken = new Set();
        for (const entry of plain) {
            const alternative = taken.has(entry) ? null : alternativeInNote(entry.note);
            if (!alternative)
                continue;
            const other = own.get(nameKey(alternative));
            const second = other && other !== entry ? other : { ...entry, name: alternative };
            partners.set(entry, { ...second, note: null });
            taken.add(entry).add(second);
        }

        // eine Gruppe mit nur einer Zutat ist keine Wahl (beim Speichern abgelehnt, ältere
        // Rezepte können sie haben): dann ist es eine normale Zutat
        const groupOf = (entry) => entry.alternative_group?.toLowerCase();
        const members = new Map();
        for (const entry of ingredients)
            if (groupOf(entry))
                members.set(groupOf(entry), [...(members.get(groupOf(entry)) ?? []), entry]);

        for (const entry of ingredients) {
            if (partners.has(entry)) {
                addGroup([{ ...entry, note: null }, partners.get(entry)]);
            } else if (taken.has(entry)) {
                continue;
            } else if (members.get(groupOf(entry))?.length > 1) {
                if (members.get(groupOf(entry))[0] === entry)
                    addGroup(members.get(groupOf(entry)));
            } else if (namedAlternatives(entry.name).length > 1) {
                // „A oder B“ in einem einzigen Namen heißt dasselbe (ebenfalls nur noch bei
                // älteren Rezepten, neue lehnt normalizeIngredient ab)
                addGroup(namedAlternatives(entry.name).map((part) => ({ ...entry, name: part })));
            } else {
                addNeeded(entry);
            }
        }
    }

    // steht eine Option ohnehin auf der Liste (ein anderes Rezept braucht sie fest), wird sie
    // einfach mehr gekauft statt gefragt — das ist kein zweiter Einkauf, sondern derselbe
    for (const [key, options] of groups)
        if (options.some((option) => needed.has(option.name.toLowerCase()) && addNeeded(option, true)))
            groups.delete(key);

    const names = [...new Set([...needed.keys(), ...[...groups.values()].flat().map((entry) => entry.name.toLowerCase())])];
    const { rows: pantry } = await db.query(`
        SELECT i.name, p.always_available, p.amount, p.unit
        FROM pantry_items p JOIN ingredients i ON i.id = p.ingredient_id
        WHERE lower(i.name) = ANY($1::text[])`, [names]);
    const inPantry = new Map(pantry.map((row) => [row.name.toLowerCase(), row]));

    // Was eine Zutat für die Liste heißt: { item, pantry }. item = muss gekauft werden (null: nichts),
    // pantry = steht im Vorrat und muss genannt werden (null: nicht im Vorrat). Beides ist
    // möglich, wenn vom Vorrat nur ein Teil da ist.
    function decide(entry) {
        const stock = inPantry.get(entry.name.toLowerCase());
        const neededSpec = spec(entry.amount, entry.unit, entry.note);
        if (!stock)
            return { item: { name: entry.name, spec: neededSpec }, pantry: null };
        if (stock.always_available)
            return { item: null, pantry: { name: entry.name, needed: neededSpec, reason: "immer vorrätig" } };

        // ohne Menge im Vorrat bleibt es bei „vorrätig“, mit Menge wird sie genannt
        const stockSpec = spec(stock.amount, stock.unit, null);
        const sameUnit = (stock.unit ?? "").toLowerCase() === (entry.unit ?? "").toLowerCase();
        const missing = sameUnit && stock.amount !== null && entry.amount !== null
            ? Number((entry.amount - stock.amount).toFixed(3))
            : 0;
        if (missing > 0) {
            // zu wenig im Vorrat: nur der Rest muss gekauft werden, der Vorrat wird genannt
            return {
                item: { name: entry.name, spec: spec(missing, entry.unit, entry.note) },
                pantry: {
                    name: entry.name, needed: neededSpec,
                    reason: `${stockSpec} vorrätig, ${spec(missing, entry.unit, null)} fehlen`,
                },
            };
        }
        return {
            item: null,
            pantry: { name: entry.name, needed: neededSpec, reason: stockSpec ? `${stockSpec} vorrätig` : "vorrätig" },
        };
    }

    const items = [];
    const fromPantry = [];
    const choices = [];
    for (const entry of [...needed.values()].flat()) {
        const { item, pantry: stocked } = decide(entry);
        if (item)
            items.push(item);
        if (stocked)
            fromPantry.push(stocked);
    }
    for (const options of groups.values()) {
        const decided = options.map((entry) => ({ entry, ...decide(entry) }));
        // reicht der Vorrat für eine der Alternativen, muss keine gekauft werden
        const covered = decided.find((one) => one.item === null);
        if (covered) {
            const others = decided.filter((one) => one !== covered).map((one) => one.entry.name);
            fromPantry.push({ ...covered.pantry, reason: `${covered.pantry.reason} — reicht statt ${others.join(" oder ")}` });
            continue;
        }
        // ist von einer Option ein Teil im Vorrat, steht der nur hier (in_pantry) — in
        // from_pantry gehört er erst, wenn diese Option gewählt ist
        choices.push({
            question: options.map((entry) => entry.name).join(" oder "),
            options: decided.map((one) => (one.pantry ? { ...one.item, in_pantry: one.pantry.reason } : one.item)),
        });
    }

    // bei einem Rezept (und bei mehreren mit derselben Portionszahl) steht hier die Zahl, mit
    // der wirklich gerechnet wurde, auch wenn die Anfrage keine Portionen mitgegeben hat
    const allServings = [...new Set(used.map((entry) => entry.servings))];
    return {
        servings: allServings.length === 1 ? allServings[0] : (parseServings(servings) ?? null),
        recipes: used,
        items,
        choices,
        from_pantry: fromPantry,
        note: [
            fromPantry.length === 0
                ? "Nichts kommt aus dem Vorrat."
                : `${fromPantry.length} Zutat(en) stammen aus dem Vorrat und stehen nicht `
                  + "(oder nur mit der fehlenden Menge) auf der Liste. "
                  + "Bitte nenne sie in der Antwort, damit nichts vergessen wird.",
            choices.length === 0
                ? "Die Liste ist vollständig."
                : `${choices.length} Zutat(en) sind Alternativen (choices) und stehen NICHT in items: `
                  + `${choices.map((choice) => `„${choice.question}“`).join(", ")}. `
                  + "Frage den Benutzer, welche Option er haben will, und trage nur die gewählte ein.",
        ].join(" "),
    };
}

// Einkaufsliste eines einzelnen Rezepts, für die Seite und /api/recipes/:id/shopping-list
async function getShoppingList(id, servings) {
    return planShoppingList([id], servings);
}

/*************** Bilder **********************************************************************/
// Der Dateityp wird an den ersten Bytes erkannt, nie am Content-Type-Header: der kommt vom
// Browser und kann alles behaupten.
const IMAGE_TYPES = [
    { mime: "image/jpeg", ext: "jpg" },
    { mime: "image/png", ext: "png" },
    { mime: "image/webp", ext: "webp" },
];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageType(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
        return IMAGE_TYPES[0];
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC))
        return IMAGE_TYPES[1];
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF"
        && buffer.subarray(8, 12).toString("latin1") === "WEBP")
        return IMAGE_TYPES[2];
    return null;
}

function imagePath(id, ext) {
    return path.join(IMAGE_DIR, `${id}.${ext}`);
}

async function saveImage(id, buffer) {
    if (buffer.length === 0)
        fail("Es wurde kein Bild gesendet");
    if (buffer.length > MAX_IMAGE_BYTES)
        throw new HttpError(413, `Das Bild darf höchstens ${MAX_IMAGE_BYTES / 1024 / 1024} MB groß sein`);
    const type = imageType(buffer);
    if (!type)
        fail("Nur JPEG, PNG oder WebP");

    const { rows: [recipe] } = await db.query("SELECT id FROM recipes WHERE id = $1", [id]);
    if (!recipe)
        throw new HttpError(404, "Rezept nicht gefunden");

    await fs.promises.mkdir(IMAGE_DIR, { recursive: true });
    await fs.promises.writeFile(imagePath(id, type.ext), buffer);
    // ein Bild im alten Format würde sonst liegen bleiben
    for (const other of IMAGE_TYPES)
        if (other.ext !== type.ext)
            await fs.promises.rm(imagePath(id, other.ext), { force: true });

    const { rows: [updated] } = await db.query(`
        UPDATE recipes SET image_mime = $2, image_updated_at = now(), updated_at = now()
        WHERE id = $1 RETURNING image_mime, image_updated_at`, [id, type.mime]);
    return updated;
}

// { mime, updatedAt, data } oder 404, wenn es kein Bild gibt
async function readImage(id) {
    const { rows: [recipe] } = await db.query(
        "SELECT image_mime, image_updated_at FROM recipes WHERE id = $1", [id]);
    if (!recipe)
        throw new HttpError(404, "Rezept nicht gefunden");
    const type = IMAGE_TYPES.find((entry) => entry.mime === recipe.image_mime);
    if (!type)
        throw new HttpError(404, "Dieses Rezept hat kein Bild");
    try {
        return { mime: type.mime, updatedAt: recipe.image_updated_at, data: await fs.promises.readFile(imagePath(id, type.ext)) };
    } catch {
        // in der Datenbank steht ein Bild, die Datei fehlt (z. B. neu aufgesetzter Pi)
        throw new HttpError(404, "Die Bilddatei ist nicht mehr da");
    }
}

// quiet: beim Löschen eines Rezepts darf das Bild auch fehlen
async function deleteImage(id, { quiet = false } = {}) {
    for (const type of IMAGE_TYPES)
        await fs.promises.rm(imagePath(id, type.ext), { force: true });
    const { rowCount } = await db.query(
        "UPDATE recipes SET image_mime = NULL, image_updated_at = NULL WHERE id = $1", [id]);
    if (rowCount === 0 && !quiet)
        throw new HttpError(404, "Rezept nicht gefunden");
    return { deleted: true };
}

module.exports = {
    MAX_IMAGE_BYTES, DIFFICULTIES,
    listRecipes, getRecipe, saveRecipe, deleteRecipe,
    getRecipeIngredients, getShoppingList, planShoppingList,
    listIngredients, createIngredient, findIngredient, listTags,
    saveImage, readImage, deleteImage,
    // für pantry.js und mcp.js
    fail, optionalText, optionalAmount, optionalBoolean, requiredText, parseServings,
};
