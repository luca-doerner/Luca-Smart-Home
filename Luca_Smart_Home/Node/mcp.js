/*
 * MCP-Server für die Rezepte: der Werkzeugkasten, den eine KI über HTTP benutzt.
 * Eingehängt als eine einzige Route, POST /api/mcp (dazu GET/DELETE -> 405).
 *
 * Kein @modelcontextprotocol/sdk: das wäre die erste Abhängigkeit neben pg, und der Teil, den
 * wir brauchen, ist JSON-RPC 2.0 über einen POST — ein Objekt rein, ein Objekt raus.
 *
 * Die Werkzeuge rufen die Funktionen in recipes.js und pantry.js direkt auf, nicht die eigene
 * HTTP-API: ein Prozess, eine Validierung, kein Umweg. Die Anmeldung läuft über auth.js
 * (Authorization: Bearer <token>, angelegt mit "node user.js token add"), req.user ist also
 * schon gesetzt, wenn eine Anfrage hier ankommt.
 *
 * Zwei Protokoll-Zeitalter in einem Server — die Spec nennt das „dual-era“:
 *
 *   alt (bis 2025-11-25)  Der Client schickt zuerst "initialize", handelt eine Version aus und
 *                         bekommt eine Sitzung; danach tools/list und tools/call.
 *   neu (ab 2026-07-28)   Kein Handshake und keine Sitzung mehr. Jede Anfrage trägt ihre
 *                         Protokollversion selbst — im Körper unter
 *                         _meta["io.modelcontextprotocol/protocolVersion"] und gespiegelt im
 *                         Header MCP-Protocol-Version. Ergebnisse haben resultType: "complete".
 *
 * Welches Zeitalter ein Client spricht, weiß man vorher nicht (Claude Code, Claude Desktop und
 * mcp-remote sind unterschiedlich alt), deshalb beantwortet dieser Server beides. Erkannt wird
 * es daran, wie der Client anfängt: "initialize" heißt alt, eine Versionsangabe ab 2026-07-28
 * heißt neu, gar keine Angabe behandelt die Spec ausdrücklich als altes Zeitalter.
 *
 * Eine Abweichung mit Absicht: die Spec verlangt im neuen Zeitalter die Header Mcp-Method und
 * Mcp-Name und schreibt vor, eine Anfrage ohne sie mit 400 abzulehnen. Hier werden sie nur
 * geprüft, wenn sie da sind — ein Client, der sie vergisst, soll nicht an unserem Pi scheitern.
 * Stimmen sie nicht mit dem Körper überein, wird abgelehnt (Code -32020): sonst könnte ein
 * Zwischenstück im Netz nach dem Header entscheiden und der Server nach dem Körper.
 */
const recipes = require("./recipes");
const pantry = require("./pantry");
const bring = require("./bring");
const yazio = require("./yazio");
const HttpError = require("./http-error");
const { log } = require("./log");

const SERVER_INFO = {
    name: "luca-smart-home-rezepte",
    title: "Lucas Smart Home — Rezepte, Bring! und YAZIO",
    version: "1.1.0",
};

// neueste Fassung zuerst; Datumsstrings lassen sich direkt vergleichen ("2026-07-28" > "2025-11-25")
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
// was ein "initialize" bekommt, wenn der Client nach einer Version fragt, die wir nicht kennen
const LEGACY_FALLBACK = "2025-06-18";

const INSTRUCTIONS = "Rezepte, Zutaten und Vorrat aus Lucas Smart Home. Typischer Ablauf: "
    + "search_recipes, dann get_recipe, dann plan_shopping_list, nach dem Ja des Benutzers "
    + "bring_add_items. Die Einträge in from_pantry einer Einkaufsliste gehören nicht auf die "
    + "Liste, müssen dem Benutzer aber genannt werden. Steht in choices eine Alternative "
    + "(„A oder B“), frag den Benutzer, welche er will, und trag nur diese ein.\n\n"
    + "Dazu das Ernährungstagebuch YAZIO (yazio_*): lesen darfst du frei, aber alles, was "
    + "ins Tagebuch SCHREIBT oder daraus löscht (yazio_add_product, yazio_log_recipe, "
    + "yazio_remove_entry), nur nach dem ausdrücklichen Ja des Benutzers. Nährwerte eines "
    + "Rezepts stehen pro Portion im Rezept (nutrients); fehlen sie, mit set_recipe_nutrients "
    + "ausrechnen und vorher dem Benutzer zeigen.";

/* JSON-RPC- und MCP-Fehlercodes (MCP legt -32020 und -32022 fest) */
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

/*************** Schema-Bausteine *************************************************************/
// kleine Helfer, damit die Werkzeugliste unten lesbar bleibt
const text = (description, extra = {}) => ({ type: "string", description, ...extra });
const integer = (description, extra = {}) => ({ type: "integer", description, ...extra });
const number = (description) => ({ type: "number", description });
const flag = (description) => ({ type: "boolean", description });
const list = (items, description) => ({ type: "array", items, description });
const object = (properties, required = []) => ({ type: "object", properties, required });

// "keine Parameter": ausdrücklich nur ein leeres Objekt, so empfiehlt es die Spec
const NO_ARGS = { type: "object", additionalProperties: false };

const BRING_LIST = text("Name oder list_uuid der Bring!-Liste (bring_lists zeigt sie). Weglassen = "
    + "die Standardliste, die der Benutzer auf der Seite „Konto“ gewählt hat, oder die einzige Liste.");

// Zutaten mit gleichem alternative_group: der Agent soll beim Vorlesen nicht beide verlangen
const ALTERNATIVES_HINT = "Zutaten mit demselben alternative_group sind Alternativen: man braucht "
    + "nur eine davon (z. B. Chiliflocken oder Chipotle-Pulver).";

const SERVINGS = integer("Für wie viele Portionen gerechnet werden soll. Weglassen = die "
    + "Portionszahl, die im Rezept steht.", { minimum: 1, maximum: 100 });

const DATE = text("Der Tag als JJJJ-MM-TT, z. B. 2026-03-14. Weglassen = heute.",
    { pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

const DAYTIME = text("Die Mahlzeit: breakfast (Frühstück), lunch (Mittag), dinner (Abend) oder snack.",
    { enum: yazio.DAYTIMES });

const NUTRIENTS_SCHEMA = object({
    kcal: number("Kilokalorien pro Portion."),
    protein: number("Eiweiß in Gramm pro Portion."),
    carbs: number("Kohlenhydrate in Gramm pro Portion."),
    fat: number("Fett in Gramm pro Portion."),
}, ["kcal", "protein", "carbs", "fat"]);

const INGREDIENT_SCHEMA = object({
    name: text("Name der Zutat, z. B. „Hackfleisch“. Unbekannte Namen werden im Katalog angelegt. "
        + "Genau eine Zutat: „A oder B“ als Name wird abgelehnt (dafür gibt es alternative_group)."),
    amount: number("Menge für die Portionszahl des Rezepts. Weglassen für „etwas davon“, z. B. Öl zum Braten."),
    unit: text("Einheit, z. B. g, ml, EL, TL. Weglassen heißt Stück."),
    note: text("Zusatz zur Zutat, z. B. „fein gewürfelt“. KEINE Alternativen wie „oder Chipotle "
        + "Pulver“ — das wird abgelehnt; dafür gibt es alternative_group."),
    group_label: text("Zwischentitel in der Zutatenliste, z. B. „Für die Soße“."),
    optional: flag("true, wenn die Zutat weggelassen werden kann."),
    alternative_group: text("Für „entweder A oder B“: gib allen Alternativen denselben Text, z. B. "
        + "„Schärfe“ bei Chiliflocken und Chipotle-Pulver. Jede Alternative ist eine eigene Zutat mit "
        + "eigenem Namen. Nicht „A oder B“ in einen Namen schreiben und nicht beide ohne Gruppe anlegen: "
        + "sonst steht am Ende beides auf der Einkaufsliste. Eine Gruppe braucht mindestens zwei "
        + "Zutaten (Groß-/Kleinschreibung egal); eine allein wird abgelehnt."),
}, ["name"]);

const STEP_SCHEMA = object({
    text: text("Ein Arbeitsschritt in einem oder zwei Sätzen."),
    minutes: integer("Wie lange dieser Schritt dauert, in Minuten."),
}, ["text"]);

const RECIPE_SCHEMA = object({
    name: text("Name des Rezepts. Jeder Name gibt es nur einmal."),
    description: text("Ein Satz, worum es geht."),
    servings: integer("Für wie viele Portionen die Mengen gelten.", { minimum: 1, maximum: 100 }),
    prep_minutes: integer("Vorbereitungszeit in Minuten."),
    cook_minutes: integer("Koch- oder Backzeit in Minuten."),
    difficulty: text("Schwierigkeit.", { enum: recipes.DIFFICULTIES }),
    tags: list(text("Ein Tag, z. B. „Hauptgericht“ oder „vegetarisch“."), "Tags zum Filtern."),
    source: text("Woher das Rezept kommt, z. B. ein Link."),
    notes: text("Freie Notizen, z. B. ein Tipp."),
    nutrients: {
        ...NUTRIENTS_SCHEMA,
        description: "Nährwerte PRO PORTION (für YAZIO). Weglassen = unverändert lassen; beim "
            + "Ändern eines Rezepts muss man sie also nicht mitschicken.",
    },
    ingredients: list(INGREDIENT_SCHEMA, "Die Zutaten in ihrer Reihenfolge."),
    steps: list(STEP_SCHEMA, "Die Arbeitsschritte in ihrer Reihenfolge."),
}, ["name"]);

/*************** Werkzeuge ********************************************************************/
// run(args, user) gibt ein Objekt zurück; das wird als structuredContent und zusätzlich als
// JSON-Text geliefert, damit auch ein Client ohne structuredContent damit arbeiten kann
const TOOLS = [
    {
        name: "search_recipes",
        title: "Rezepte suchen",
        description: "Sucht Rezepte über Name, Tags, Zutaten und Zubereitungstext (deutsche "
            + "Volltextsuche, Treffer im Namen zählen am meisten). Ohne query kommen alle "
            + "Rezepte. Liefert die kurze Form — mit der id dann get_recipe oder "
            + "plan_shopping_list aufrufen.",
        inputSchema: object({
            query: text("Suchwörter, z. B. „Hackfleisch“ oder „schnelles Nudelgericht“."),
            tags: list(text("Ein Tag."), "Nur Rezepte, an denen alle diese Tags stehen. "
                + "Groß- und Kleinschreibung ist egal; list_tags zeigt, welche es gibt."),
            limit: integer("Höchstens so viele Treffer (1–50).", { minimum: 1, maximum: 50 }),
        }),
        run: async ({ query, tags, limit }) => ({
            recipes: await recipes.listRecipes({ q: query, tags, limit }),
        }),
    },
    {
        name: "get_recipe",
        title: "Rezept lesen",
        description: "Ein Rezept vollständig: Zutaten mit Mengen und Gruppen, Schritte, Tags, Zeiten. "
            + ALTERNATIVES_HINT,
        inputSchema: object({ id: integer("Die id aus search_recipes.") }, ["id"]),
        run: async ({ id }) => ({ recipe: await recipes.getRecipe(id) }),
    },
    {
        name: "get_recipe_ingredients",
        title: "Zutaten eines Rezepts",
        description: "Nur die Zutaten eines Rezepts, auf Wunsch auf andere Portionen gerechnet. "
            + "Zutaten ohne Menge bleiben unverändert. " + ALTERNATIVES_HINT,
        inputSchema: object({ id: integer("Die id des Rezepts."), servings: SERVINGS }, ["id"]),
        run: ({ id, servings }) => recipes.getRecipeIngredients(id, servings),
    },
    {
        name: "plan_shopping_list",
        title: "Einkaufsliste planen",
        description: "Macht aus einem oder mehreren Rezepten die Einkaufsliste und zieht dabei "
            + "ab, was im Vorrat steht.\n\n"
            + "items gehen 1:1 an Bring!: name ist der itemName, spec die specification von "
            + "saveItem. Nichts umrechnen, nichts weglassen.\n\n"
            + "Die Einträge in from_pantry dürfen NICHT auf die Einkaufsliste — sie müssen in "
            + "der Antwort an den Benutzer aber genannt werden, sonst fehlt am Ende etwas. Der "
            + "Satz in note sagt genau das.\n\n"
            + "Mehrere Rezepte werden zusammengefasst: gleiche Zutat mit gleicher Einheit wird "
            + "addiert.\n\n"
            + "choices sind Alternativen („Chiliflocken ODER Chipotle-Pulver“). Sie stehen "
            + "absichtlich NICHT in items. Frage den Benutzer für jede Alternative, welche er "
            + "haben will (nenne die Optionen), und trage danach nur die gewählte ein. Nie beide, "
            + "nie ungefragt eine. Hat eine Option in_pantry, ist ein Teil davon schon im Vorrat und "
            + "spec nur der Rest — nenne das, wenn sie gewählt wird. Reicht der Vorrat für eine "
            + "Option ganz, gibt es keine Frage, sie steht dann in from_pantry.",
        inputSchema: object({
            recipe_ids: list(integer("Die id eines Rezepts."), "Ein bis zwanzig Rezepte."),
            servings: SERVINGS,
        }, ["recipe_ids"]),
        run: ({ recipe_ids: ids, servings }) => recipes.planShoppingList(ids, servings),
    },
    {
        name: "create_recipe",
        title: "Rezept anlegen",
        description: "Legt ein neues Rezept an. Zutaten werden über ihren Namen angegeben; "
            + "Namen, die der Katalog noch nicht kennt, werden dabei angelegt.\n\n"
            + "Steht im Rezept „A oder B“, werden A und B zwei Zutaten mit demselben "
            + "alternative_group (z. B. „Schärfe“) — nicht B in den Hinweis von A schreiben.",
        inputSchema: object({ recipe: RECIPE_SCHEMA }, ["recipe"]),
        run: async ({ recipe }, user) => ({ recipe: await recipes.saveRecipe(null, recipe, user.id) }),
    },
    {
        name: "update_recipe",
        title: "Rezept ändern",
        description: "Ersetzt ein Rezept. Achtung: Zutaten und Schritte werden komplett ersetzt, "
            + "nicht ergänzt — deshalb vorher get_recipe lesen und die ganze Liste mitschicken.",
        inputSchema: object({ id: integer("Die id des Rezepts."), recipe: RECIPE_SCHEMA }, ["id", "recipe"]),
        run: async ({ id, recipe }, user) => ({ recipe: await recipes.saveRecipe(id, recipe, user.id) }),
    },
    {
        name: "delete_recipe",
        title: "Rezept löschen",
        description: "Löscht ein Rezept samt Zutatenliste, Schritten und Bild. Das lässt sich "
            + "nicht zurücknehmen — vorher beim Benutzer nachfragen.",
        inputSchema: object({ id: integer("Die id des Rezepts.") }, ["id"]),
        run: ({ id }) => recipes.deleteRecipe(id),
    },
    {
        name: "list_pantry",
        title: "Vorrat zeigen",
        description: "Was zu Hause ist. always_available heißt „ist immer da“ (Salz, Pfeffer, "
            + "Öl), sonst stehen Menge und Einheit dabei.",
        inputSchema: NO_ARGS,
        run: async () => ({ items: await pantry.listPantry() }),
    },
    {
        name: "set_pantry_item",
        title: "Vorrat eintragen",
        description: "Legt einen Vorrats-Eintrag an oder ändert ihn. Eine Zutat kann nur einmal "
            + "im Vorrat stehen, der Eintrag wird also ersetzt.",
        inputSchema: object({
            ingredient: text("Name der Zutat, z. B. „Mehl“. Unbekannte Namen werden angelegt."),
            always_available: flag("true = ist immer da, Menge spielt keine Rolle."),
            amount: number("Wie viel da ist. Nur zusammen mit unit sinnvoll."),
            unit: text("Einheit der Menge, z. B. g."),
            note: text("Notiz, z. B. „im Keller“."),
        }, ["ingredient"]),
        run: async (args) => ({ item: await pantry.setPantryItem(args) }),
    },
    {
        name: "remove_pantry_item",
        title: "Vorrat löschen",
        description: "Nimmt eine Zutat aus dem Vorrat. Die Zutat selbst bleibt im Katalog.",
        inputSchema: object({ name: text("Name der Zutat.") }, ["name"]),
        run: ({ name }) => pantry.removePantryItemByName(name),
    },
    {
        name: "search_ingredients",
        title: "Zutaten suchen",
        description: "Zutaten aus dem Katalog, für die Schreibweise und um zu sehen, was schon "
            + "im Vorrat steht (in_pantry).",
        inputSchema: object({ query: text("Teil eines Namens; leer = alle.") }),
        run: async ({ query }) => ({ ingredients: await recipes.listIngredients(query) }),
    },
    {
        name: "list_tags",
        title: "Tags zeigen",
        description: "Alle Tags mit der Anzahl der Rezepte — die richtige Schreibweise für "
            + "search_recipes.",
        inputSchema: NO_ARGS,
        run: async () => ({ tags: await recipes.listTags() }),
    },
    {
        name: "bring_lists",
        title: "Bring!-Listen",
        description: "Die Einkaufslisten im Bring!-Konto des Benutzers, mit Name und list_uuid. "
            + "Ist noch kein Konto verbunden, sagt der Fehler, dass sich der Benutzer auf der "
            + "Seite „Konto“ bei Bring! anmelden muss.",
        inputSchema: NO_ARGS,
        run: async (args, user) => ({ lists: await bring.lists(user.id) }),
    },
    {
        name: "bring_list_items",
        title: "Bring!-Liste lesen",
        description: "Was schon auf einer Bring!-Liste steht. Vor bring_add_items aufrufen, wenn "
            + "Doppeleinträge vermieden werden sollen.",
        inputSchema: object({ list: BRING_LIST }),
        run: ({ list }, user) => bring.listItems(user.id, list),
    },
    {
        name: "bring_add_items",
        title: "In Bring! eintragen",
        description: "Trägt Einträge in eine Bring!-Liste ein. items ist genau die Ausgabe von "
            + "plan_shopping_list (name, spec) — nichts umrechnen, nichts aus from_pantry "
            + "hinzufügen. Aus choices nur das, was der Benutzer ausdrücklich gewählt hat: nie "
            + "alle Optionen einer Alternative, und keine, die er nicht gewählt hat.\n\n"
            + "Das SCHREIBT in eine geteilte Liste, andere sehen es sofort. Deshalb zuerst die "
            + "Vorschau (plan_shopping_list) dem Benutzer zeigen und erst nach seinem Ja "
            + "eintragen.\n\n"
            + "Einträge, die schon auf der Liste stehen, werden nicht überschrieben, sondern in "
            + "already_on_list gemeldet — nenne sie dem Benutzer.",
        inputSchema: object({
            items: list(object({
                name: text("Name des Artikels, wie in plan_shopping_list."),
                spec: text("Menge, wie in plan_shopping_list, z. B. „750 g“."),
            }, ["name"]), "Die items aus plan_shopping_list."),
            list: BRING_LIST,
        }, ["items"]),
        run: ({ items, list: target }, user) => bring.addItems(user.id, items, target),
    },
    {
        name: "set_recipe_nutrients",
        title: "Nährwerte eines Rezepts setzen",
        description: "Setzt die Nährwerte PRO PORTION eines Rezepts (kcal, Eiweiß, Kohlenhydrate, "
            + "Fett in Gramm), ohne Zutaten und Schritte anzufassen. Damit trägt yazio_log_recipe "
            + "das Rezept ins Tagebuch ein.\n\n"
            + "So rechnest du sie aus: für jede Zutat mit yazio_search_products das passende "
            + "Produkt suchen (per_100 gilt je 100 g bzw. ml), die Menge aus dem Rezept in Gramm "
            + "umrechnen (EL, TL und Stück schätzen und sagen, dass du geschätzt hast), alles "
            + "addieren und durch die Portionszahl des Rezepts (servings) teilen. Zutaten ohne "
            + "Menge („etwas Öl“) nicht vergessen, aber grob ansetzen; bei Alternativen "
            + "(alternative_group) die nehmen, die der Benutzer kocht.\n\n"
            + "Zeig dem Benutzer die Werte und kurz, woraus sie entstanden, BEVOR du sie "
            + "speicherst: es sind Schätzungen, und sie landen später in seinem Tagebuch.",
        inputSchema: object({
            id: integer("Die id des Rezepts."),
            nutrients: { ...NUTRIENTS_SCHEMA, description: "Nährwerte pro Portion." },
        }, ["id", "nutrients"]),
        run: async ({ id, nutrients }) => ({ recipe: await recipes.setNutrients(id, nutrients) }),
    },
    {
        name: "yazio_day",
        title: "YAZIO: Tag lesen",
        description: "Das Ernährungstagebuch eines Tages aus YAZIO: Summe und Ziele (kcal, Eiweiß, "
            + "Kohlenhydrate, Fett, Wasser in ml, Schritte) und die Einträge nach Mahlzeit. Jeder "
            + "Eintrag hat eine id; die braucht yazio_remove_entry. Ist noch kein Konto verbunden, "
            + "sagt der Fehler, dass sich der Benutzer auf der Seite „Konto“ bei YAZIO anmelden muss.",
        inputSchema: object({ date: DATE }),
        run: ({ date }, user) => yazio.day(user.id, date),
    },
    {
        name: "yazio_goals",
        title: "YAZIO: Ziele lesen",
        description: "Die Tagesziele des Benutzers in YAZIO: kcal, Eiweiß, Kohlenhydrate, Fett, "
            + "Wasser (ml), Schritte und das Zielgewicht (kg).",
        inputSchema: object({ date: DATE }),
        run: ({ date }, user) => yazio.goals(user.id, date),
    },
    {
        name: "yazio_weight",
        title: "YAZIO: Gewicht lesen",
        description: "Das letzte in YAZIO eingetragene Gewicht (kg) am oder vor dem Tag; "
            + "weight_kg ist null, wenn noch keins eingetragen ist. Nur lesen — Gewicht "
            + "eintragen kann dieser Server nicht.",
        inputSchema: object({ date: DATE }),
        run: ({ date }, user) => yazio.weight(user.id, date),
    },
    {
        name: "yazio_search_products",
        title: "YAZIO: Produkt suchen",
        description: "Sucht Lebensmittel in der YAZIO-Datenbank. Jeder Treffer hat product_id und "
            + "per_100 (kcal, Eiweiß, Kohlenhydrate, Fett je 100 g bzw. ml) und die Portion, die "
            + "YAZIO vorschlägt. Die Werte kommen unverändert von YAZIO; wirken sie unplausibel "
            + "(mehr als 900 kcal je 100 g), nimm nicht still einen davon, sondern sag es.",
        inputSchema: object({ query: text("Suchbegriff, z. B. „Haferflocken“ oder „Skyr natur“.") }, ["query"]),
        run: async ({ query }, user) => ({ products: await yazio.searchProducts(user.id, query) }),
    },
    {
        name: "yazio_get_product",
        title: "YAZIO: Produkt lesen",
        description: "Ein Produkt aus YAZIO mit per_100 (je 100 g bzw. ml) und den Portionsgrößen "
            + "(servings, z. B. „1 Scheibe“ = 30 g).",
        inputSchema: object({ product_id: text("Die product_id aus yazio_search_products.") }, ["product_id"]),
        run: ({ product_id: id }, user) => yazio.product(user.id, id),
    },
    {
        name: "yazio_add_product",
        title: "YAZIO: Produkt eintragen",
        description: "Trägt ein Produkt aus YAZIO ins Tagebuch des Benutzers ein. Das SCHREIBT in "
            + "sein echtes Tagebuch: sag dem Benutzer vorher, was du eintragen willst (Produkt, "
            + "Menge, Mahlzeit, Tag), und tu es erst nach seinem Ja. Die Antwort nennt die id des "
            + "Eintrags und die Nährwerte; nenne sie dem Benutzer.",
        inputSchema: object({
            product_id: text("Die product_id aus yazio_search_products."),
            amount: number("Menge in Gramm bzw. Millilitern (nicht in Portionen: eine Portion von "
                + "30 g sind amount 30)."),
            daytime: DAYTIME,
            date: DATE,
            serving: text("Nur wenn der Benutzer in Portionen gedacht hat: Name der Portion, wie in "
                + "den servings des Produkts, z. B. „Scheibe“. Zusammen mit serving_quantity."),
            serving_quantity: number("Wie viele dieser Portionen (amount bleibt trotzdem die Summe in Gramm)."),
        }, ["product_id", "amount", "daytime"]),
        run: (args, user) => yazio.addProduct(user.id, args),
    },
    {
        name: "yazio_log_recipe",
        title: "YAZIO: Rezept eintragen",
        description: "Trägt eine oder mehrere Portionen eines Rezepts als freien Eintrag ins "
            + "YAZIO-Tagebuch ein. Die Nährwerte stehen pro Portion im Rezept (nutrients); der "
            + "Server rechnet mal portions. Hat das Rezept keine, kommt ein Fehler: dann erst "
            + "set_recipe_nutrients.\n\n"
            + "Das SCHREIBT in das echte Tagebuch des Benutzers: nenne vorher Rezept, Portionen, "
            + "Mahlzeit und Tag und tu es erst nach seinem Ja.",
        inputSchema: object({
            recipe_id: integer("Die id des Rezepts aus search_recipes."),
            portions: number("Wie viele Portionen gegessen wurden, auch 0,5 oder 1,5."),
            daytime: DAYTIME,
            date: DATE,
        }, ["recipe_id", "portions", "daytime"]),
        run: ({ recipe_id: id, portions, daytime, date }, user) => yazio.logRecipe(user.id, id, portions, daytime, date),
    },
    {
        name: "yazio_remove_entry",
        title: "YAZIO: Eintrag löschen",
        description: "Löscht einen Eintrag aus dem YAZIO-Tagebuch. entry_id ist die id des EINTRAGS "
            + "aus yazio_day (oder der Antwort von yazio_add_product / yazio_log_recipe), nicht "
            + "die product_id. Das lässt sich nicht zurücknehmen: zuerst dem Benutzer sagen, "
            + "welchen Eintrag (Name, Mahlzeit), und erst nach seinem Ja löschen.",
        inputSchema: object({ entry_id: text("Die id des Eintrags aus yazio_day.") }, ["entry_id"]),
        run: ({ entry_id: id }, user) => yazio.removeEntry(user.id, id),
    },
];

// was tools/list schickt: alles außer run()
const TOOL_LIST = TOOLS.map(({ run, ...tool }) => tool);

/*************** JSON-RPC *********************************************************************/
function rpcResult(id, result, modern) {
    // resultType gehört zum neuen Zeitalter; alte Clients kennen das Feld nicht
    return { jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result } : result };
}

function rpcError(id, code, message, data = undefined) {
    return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
}

// Schutz vor DNS-Rebinding: ein Browser schickt einen Origin, ein MCP-Client nicht. Ist er da,
// muss er zu dem Host gehören, über den die Anfrage gekommen ist.
function originAllowed(origin, host) {
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

/*************** Methoden *********************************************************************/
function initialize(params) {
    const wanted = params?.protocolVersion;
    return {
        protocolVersion: LEGACY_VERSIONS.includes(wanted) ? wanted : LEGACY_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
    };
}

function discover() {
    return {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
    };
}

// Fehler eines Werkzeugs gehen als Ergebnis mit isError zurück, nicht als Protokollfehler:
// nur so liest das Modell die Meldung („Portionen muss mindestens 1 sein“) und kann es gleich
// richtig nochmal versuchen.
async function callTool(params, user) {
    const tool = TOOLS.find((entry) => entry.name === params?.name);
    if (!tool)
        throw new HttpError(400, `Unbekanntes Werkzeug: ${params?.name}`);
    const args = params.arguments ?? {};
    if (args === null || typeof args !== "object" || Array.isArray(args))
        throw new HttpError(400, "arguments muss ein Objekt sein");

    log(`MCP: ${tool.name} (${user.username})`);
    try {
        const value = await tool.run(args, user);
        return {
            content: [{ type: "text", text: JSON.stringify(value, null, 1) }],
            structuredContent: value,
            isError: false,
        };
    } catch (err) {
        if (!(err instanceof HttpError))
            console.error(err);
        const message = err instanceof HttpError ? err.message : "Unerwarteter Fehler im Server";
        log(`MCP: ${tool.name} fehlgeschlagen — ${message}`, "stderr");
        return { content: [{ type: "text", text: `Fehler: ${message}` }], isError: true };
    }
}

/*************** Handler **********************************************************************/
// message: der JSON-Körper der Anfrage (server.js hat ihn schon gelesen)
async function handlePost(req, res, message) {
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin, req.headers.host))
        return send(res, 403, rpcError(null, INVALID_REQUEST, "Origin nicht erlaubt"));

    if (message === null || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0")
        return send(res, 400, rpcError(null, INVALID_REQUEST, "Erwartet wird ein JSON-RPC-2.0-Objekt"));

    const { method, params } = message;
    const id = message.id ?? null;

    // kein id-Feld heißt Notification: der Client will keine Antwort, nur ein 202
    if (!("id" in message))
        return res.writeHead(202).end();

    /* Version und gespiegelte Header */
    const headerVersion = req.headers["mcp-protocol-version"] ?? null;
    const metaVersion = params?._meta?.["io.modelcontextprotocol/protocolVersion"] ?? null;
    if (headerVersion && metaVersion && headerVersion !== metaVersion)
        return send(res, 400, rpcError(id, HEADER_MISMATCH,
            "MCP-Protocol-Version passt nicht zu _meta im Körper"));
    const headerMethod = req.headers["mcp-method"];
    if (headerMethod && headerMethod !== method)
        return send(res, 400, rpcError(id, HEADER_MISMATCH, "Mcp-Method passt nicht zur Methode im Körper"));

    const version = metaVersion ?? headerVersion;
    if (version && !SUPPORTED_VERSIONS.includes(version))
        return send(res, 400, rpcError(id, UNSUPPORTED_VERSION, "Protokollversion wird nicht unterstützt",
            { supported: SUPPORTED_VERSIONS, requested: version }));
    // keine Angabe behandelt die Spec ausdrücklich als altes Zeitalter
    const modern = version !== null && version >= MODERN_VERSION;

    try {
        let result;
        switch (method) {
            case "initialize":
                result = initialize(params);
                break;
            case "server/discover":
                result = discover();
                break;
            case "ping":
                result = {};
                break;
            case "tools/list":
                result = { tools: TOOL_LIST };
                break;
            case "tools/call":
                result = await callTool(params, req.user);
                break;
            default:
                // 404 gehört zum neuen Zeitalter: daran erkennt ein Client, dass hier ein
                // moderner Server steht und nicht der alte SSE-Endpunkt
                return send(res, modern ? 404 : 200,
                    rpcError(id, METHOD_NOT_FOUND, `Unbekannte Methode: ${method}`));
        }
        send(res, 200, rpcResult(id, result, modern));
    } catch (err) {
        if (!(err instanceof HttpError))
            console.error(err);
        const status = err instanceof HttpError ? err.status : 500;
        send(res, status, rpcError(id, err instanceof HttpError ? INVALID_PARAMS : INVALID_REQUEST,
            err.message));
    }
}

// GET und DELETE gab es nur im alten Transport (SSE-Stream, Sitzung beenden)
function methodNotAllowed(res) {
    res.writeHead(405, { Allow: "POST", "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(rpcError(null, INVALID_REQUEST,
        "Dieser MCP-Endpunkt nimmt nur POST (kein SSE-Stream, keine Sitzungen)")));
}

module.exports = { handlePost, methodNotAllowed, TOOLS, SUPPORTED_VERSIONS };
