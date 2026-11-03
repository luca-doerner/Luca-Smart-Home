# Luca Smart Home

Smart-Home-System auf einem Raspberry Pi: Ein Node-Webserver verwaltet Zimmer, Geräte und
Features; die Features sind C-Programme, die einen WS281x-LED-Streifen steuern. Alles, was die
Weboberfläche anzeigt, kommt aus einer PostgreSQL-Datenbank — **neue Features und Einstellungen
brauchen in der Regel keinen neuen Server-Code, nur neue Zeilen in der Datenbank.**

Daneben steht seit neuestem der **Rezeptteil** (Rezepte, Zutaten, Vorrat, Einkaufsliste) mit
einem **MCP-Server**, über den eine KI die Rezepte benutzen kann. Für ihn gilt die Regel oben
ausdrücklich **nicht**: er hat eigene Tabellen, eigene Routen und eigene Seiten (siehe unten).
Ebenso der **YAZIO-Konnektor** (Kalorienzähler: Tagebuch lesen, Essen und Rezepte eintragen) —
gebaut wie der Bring!-Konnektor, mit eigener Tabelle, eigenen Routen und der Seite „Ernährung“.

Sprache: Code-Kommentare und Oberfläche sind deutsch bzw. gemischt deutsch/englisch, Benutzer
und Commit-Messages deutsch.

## Ordner

| Ordner | Inhalt |
|---|---|
| `Luca_Smart_Home/C/` | die Feature-Programme in C (`ambilight`, `static_color`, `color_flow`) + `leds.c`/`leds.h` |
| `Luca_Smart_Home/Node/` | Webserver (nur Abhängigkeit: `pg`), `public/` ist das Frontend, dazu Rezepte und MCP |
| `Luca_Smart_Home/Database/` | `schema.sql` + `seed.sql`, laufen bei **jedem** Deploy |
| `deploy/` | `ansible.yml`, `inventory.ini` |
| `.github/workflows/pipeline.yml` | Deploy bei Push auf `main` |
| `Ambilight_Flask/` | **Vorgänger** (Python/Flask), nicht mehr pflegen; `static/python/ambilight.py` war die Vorlage für `ambilight.c` |
| `Ambilight_Node/` | leerer Restordner, nicht in Git |

## Datenfluss

```
Browser ──HTTP/JSON──> Node (server.js)
                        ├── PostgreSQL  (Einstellungen, Geräte, Benutzer, Rezepte)
                        ├── features.js ──spawn──> C-Programm   (--name=wert beim Start)
                        │               └──UDP 9000──> C-Programm ("name: wert" im Betrieb)
                        └── recipes.js / pantry.js  (Rezepte, Zutaten, Vorrat, Einkaufsliste)
            <──SSE /api/log──  stdout/stderr der C-Programme

KI ──HTTP/JSON-RPC + Bearer-Token──> /api/mcp (mcp.js) ──> recipes.js / pantry.js
claude.ai / Handy ──OAuth (oauth.js)──> Access-Token ──> /api/mcp           ├──> bring.js ──> Bring!
                                                                            └──> yazio.js ──> YAZIO
Browser ──> /api/yazio/*, /api/recipes/:id/yazio ──> yazio.js   (Seite „Ernährung“, Knopf am Rezept)
```

## Datenbank (`Database/schema.sql`)

`rooms` → `devices` (verschachtelbar) → `features` → `setting_definitions` / `settings`,
dazu `device_setting_definitions` / `device_settings`, `feature_kinds`, `users`, `sessions`,
`api_tokens`, `bring_accounts` / `yazio_accounts` (das Bring!- bzw. YAZIO-Konto je Benutzer), die
OAuth-Tabellen `oauth_clients` / `oauth_codes` / `oauth_refresh_tokens` und die
rekursive View `devices_with_room`.
Der Rezeptteil steht daneben: `ingredients` → `recipes` → `recipe_ingredients` / `recipe_steps`,
dazu `pantry_items` und die View `recipes_search`.

**Was wem gehört:** Zimmer, Geräte, Features und Einstellungen sind **für alle gleich** (das ist
die Hardware des Hauses). **Pro Benutzer** sind: Rezepte (`recipes.user_id`), der Zutatenkatalog
(`ingredients.user_id`, Name eindeutig pro Benutzer), der Vorrat, die angehefteten Geräte
(`device_pins`), Bring!/YAZIO-Konto und Tokens. `pantry_items`, `recipe_ingredients` und
`recipe_steps` haben **keine** eigene `user_id`: sie gehören dem Besitzer ihrer Zutat bzw. ihres
Rezepts — darum geht jede Vorrats-Abfrage über `ingredients`. Jede Funktion in `recipes.js` und
`pantry.js` nimmt `userId` als **ersten** Parameter; ein fremdes Rezept ist `404`, nicht `403`
(wer es nicht sehen darf, soll nicht erfahren, dass es die id gibt). Eine Zutat in einem Rezept
gehört immer dem Rezeptbesitzer (`ingredientIds` sucht und legt nur im eigenen Katalog an), ein
Gericht mit Varianten auch (`setVariantOf` nimmt nur eigene Rezepte als Ziel).

- `devices`: entweder `room_id` **oder** `parent_device_id` (CHECK `num_nonnulls(...) = 1`);
  ein Trigger verhindert Zyklen. Angeheftet wird pro Benutzer in `device_pins`
  (`PRIMARY KEY (user_id, device_id)`); die alte Spalte `devices.pinned_at` hat die Migration
  allen damals vorhandenen Benutzern gegeben und dann gelöscht.
- `features`: `kind` (`service`/`oneshot`), `executable` (relativ zu `Luca_Smart_Home/`),
  `udp_port`, `exclusive`, `active`. Partieller Unique-Index
  `features_one_active_exclusive`: pro Gerät höchstens ein aktives exklusives Feature.
- Werte stehen als `JSONB` in `settings`; fehlt eine Zeile, gilt `default_value`.
- `recipe_ingredients` und `recipe_steps` haben `PRIMARY KEY (recipe_id, position)` statt einer
  eigenen id: die Reihenfolge ist Teil der Identität („Schritt 3“), und Speichern ersetzt die
  ganze Liste. `pantry_items.ingredient_id` ist selbst der Primärschlüssel — jede Zutat kann
  höchstens einmal im Vorrat stehen, genau das macht das Abziehen eindeutig.
- `recipe_ingredients.ingredient_id` zeigt mit `ON DELETE RESTRICT` auf den Katalog: eine Zutat,
  die ein Rezept benutzt, lässt sich nicht aus Versehen löschen.
- `recipes.tags` ist ein `TEXT[]` mit GIN-Index (`tags && ARRAY['vegetarisch']`), keine
  Tag-Tabelle.
- `recipes.image_mime IS NULL` heißt „kein Bild“; die Datei liegt **nicht** in der Datenbank,
  sondern unter `RECIPE_IMAGE_DIR/<id>.<ext>` (wegen `max: 1` in `db.js`).
- `recipes_search` ist eine View, kein gespeichertes `tsvector`-Feld: der Text kommt aus drei
  Tabellen, eine `GENERATED`-Spalte kann das nicht. Gewichte A–D (Name, Tags/Zutaten,
  Beschreibung, Schritte), gesucht mit `websearch_to_tsquery('german', …)`.
- `recipes.nutrients` (JSONB) = Nährwerte **pro Portion**: `{ "kcal": 540, "protein": 32,
  "carbs": 48, "fat": 21 }` (kcal und Gramm), `NULL` = unbekannt. Pro Portion und nicht fürs
  ganze Rezept, damit eine geänderte Portionszahl sie nicht verfälscht. Der CHECK (genau diese
  vier Zahlen, keine negativ) steht am Dateiende und wird bei jedem Lauf neu angelegt; ein
  CHECK darf keine Unterabfrage haben, „keine anderen Schlüssel“ ist deshalb
  `nutrients - 'kcal' - … = '{}'`.
- **Varianten eines Gerichts** („Chicharrones“ aus Ofen/Airfryer): `recipes.variant_of` zeigt auf
  das Grundrezept, `variant_label` ist der kurze Name für die Reiter. Jede Variante ist ein
  **vollständiges eigenes Rezept** (Zutaten, Schritte, Nährwerte, Bild) — Einkaufsliste, Bring!
  und YAZIO wissen deshalb nichts von Varianten. **Nur eine Ebene**, das Gericht eines Rezepts ist
  immer `COALESCE(variant_of, id)`. Garantiert vom `CONSTRAINT TRIGGER recipes_one_variant_level`,
  `DEFERRABLE INITIALLY DEFERRED`: er prüft erst beim COMMIT, weil das Wechseln des Grundrezepts
  mehrere UPDATEs braucht. `CREATE OR REPLACE` gibt es für Constraint-Trigger nicht, deshalb
  `DROP TRIGGER IF EXISTS` + `CREATE`.
- `yazio_accounts` ist wie `bring_accounts` gebaut (Benutzer, E-Mail, `credentials` =
  verschlüsselter `refresh_token`), nur ohne Standardliste.

**Regeln, die hier immer gelten:**
- Beide SQL-Dateien laufen bei jedem Deploy und müssen **idempotent** sein:
  `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + `DO`-Blöcke, die
  vorher in `information_schema` nachsehen.
- `CREATE TABLE IF NOT EXISTS` ändert eine vorhandene Tabelle **nicht**. Deshalb werden die
  CHECK-Constraints für `type`, `options` und `default_value` bei jedem Lauf gelöscht und neu
  angelegt (`DO`-Block mit `FOREACH` am Ende der Datei). **Ein neuer Setting-Typ wird nur dort
  eingetragen.**
- `seed.sql` legt Startdaten nur an, solange es das jeweilige Feature noch nicht gibt
  (`IF EXISTS (SELECT 1 FROM features WHERE type = '...') THEN RETURN`), damit Umbenennen auf dem
  Pi erhalten bleibt. Nachträgliche Settings werden per `NOT EXISTS`-Prüfung **pro Name**
  nachgezogen.
- Ein absichtlich gelöschtes Setting kommt beim nächsten Deploy wieder — stattdessen das Feature
  löschen.
- `device_setting_definitions` (z. B. `led_count_left`) legt das Seed **nicht** an, die stehen
  direkt auf dem Pi.
- Beispielrezepte und Grundvorrat legt die Funktion `seed_starter_data(user_id)` (in `seed.sql`)
  **pro Benutzer genau einmal** an: Guard ist `users.starter_data_at`, darin noch einmal getrennt
  „hat keinen Vorrat“ und „hat kein Rezept“. Sie läuft beim Deploy für jeden Benutzer ohne
  Startdaten und direkt bei `node user.js add`. Was ein Benutzer löscht, kommt nicht wieder.
  Rezepte/Zutaten ohne Besitzer (nur möglich, solange es gar keinen Benutzer gab) übernimmt der
  erste Benutzer dort — sonst bekäme er die Beispiele doppelt und der eindeutige Name ließe den
  nächsten Deploy scheitern.
- Migration auf „pro Benutzer“ (Dateiende von `schema.sql`, läuft jedes Mal, findet danach
  nichts mehr): ein Rezept geht an `created_by`, sonst an den ersten Benutzer, der ganze alte
  Katalog samt Vorrat an den ersten Benutzer; benutzt ein Rezept eine Zutat eines anderen, bekommt
  der Rezeptbesitzer eine Kopie. `SET NOT NULL` erst, wenn nichts ohne Besitzer übrig ist, und in
  einem **eigenen** `DO`-Block: der Varianten-Trigger ist `DEFERRED`, nach einem `UPDATE recipes`
  in derselben Transaktion lehnt PostgreSQL `ALTER TABLE` ab („pending trigger events“).
- Der CHECK auf `recipes.difficulty` wird wie die Setting-Regeln bei jedem Lauf gelöscht und neu
  angelegt (am Dateiende). **Eine neue Schwierigkeitsstufe wird nur dort eingetragen** — dazu
  `DIFFICULTIES` in `recipes.js`.

## Feature-Arten

| | `service` | `oneshot` |
|---|---|---|
| Lauf | dauerhaft, Start/Stopp-Knopf, `features.active` wird gemerkt | einmal, bei jedem Speichern |
| Start | alle Einstellungen als `--name=wert` | alle Einstellungen als `--name=wert` |
| Änderung im Betrieb | per UDP `"name: wert"` an `udp_port` | nur beim nächsten Lauf |
| `restart_required` | Speichern-Knopf, startet den Dienst neu | nicht genutzt |

- Ein Service darf UDP erst bekommen, wenn er bereit ist: Er gibt dazu eine Zeile aus, die mit
  `Started` beginnt (`STARTED_LINE` in `features.js`), danach schickt der Server alle Live-Werte.
- Exklusivität: Ein exklusiver **Oneshot** stoppt vorher die exklusiven Services seines Geräts.
  Ein exklusiver **Service** setzt beim Start bei allen exklusiven Oneshots des Geräts das
  Setting `power` auf aus (`POWER_SETTING` in `features.js`).
- Geräte-Einstellungen gehen **immer** an jedes Programm des Geräts (vor den
  Feature-Einstellungen); ihre Änderung startet die laufenden Services des Geräts neu.
- Eine neue Art braucht eine Zeile in `feature_kinds` und einen Zweig in `features.js`.

## Setting-Typen

`range` (Schieber), `number`, `boolean`, `text`, `select`, `button_select` (ein Knopf pro Option,
wie ein Power-BI-Schaltflächenslicer), `color` (Farbwähler + editierbares Hex-Feld),
`color_list` (mehrere Farben, sortierbar), `screen` (vier Zahlen um einen Bildschirm).

Übergabe an das Programm (`settingPairs` in `features.js`):

| Typ | Datenbank (JSONB) | an das Programm |
|---|---|---|
| normal | `70` | `--brightness=70` / `brightness: 70` |
| `color_list` | `["#ff0000","#00ff00"]` | `--colors=#ff0000,#00ff00` |
| `screen` | `{"top":1,"left":1,"right":1,"bottom":1}` | `--distance_top=1 --distance_left=1 ...` |

Prozente statt Brüche: Die Seite schickt `brightness: 70`, das C-Programm rechnet `/100.0`.
Ein neuer Typ braucht: CHECK in `schema.sql`, `validateValue` in `smarthome.js`,
`settingInput` in `public/feature-panel.js`, ggf. `settingPairs` in `features.js`, CSS.

## C-Seite (`Luca_Smart_Home/C/`)

`leds.h`/`leds.c` sind der gemeinsame Teil, jedes Programm ist eine eigene `.c`-Datei;
das `Makefile` baut `PROGRAMS = ambilight static_color color_flow` jeweils mit `leds.c`.

Gemeinsames aus `leds.c`: `leds_init`, `leds_fill`, `leds_off` (schwarz + render, **ohne**
`ws2811_fini` — das macht der Aufrufer), `load_config` (Geräte-Einstellungen `led_count_*`,
`led_pin`, `led_dma`), `load_settings(argc, argv, count, names, callback)` (baut das
`struct option`-Array aus den Namen), `init_socket(int *s)`, `poll_settings(int *s, callback)`,
`init_signals`/`get_running` (`volatile sig_atomic_t running`).

Aufbau jedes Programms:

```c
static const char *SETTING_NAMES[] = { "colors", "speed", "brightness" };
#define SETTING_COUNT ((int)(sizeof SETTING_NAMES / sizeof *SETTING_NAMES))
static int set_setting(const char *name, const char *value);   // 0 = unbekannt/ungueltig

int main(int argc, char *argv[]) {
    init_signals();
    led_config_t config = load_config(argc, argv);
    load_settings(argc, argv, SETTING_COUNT, SETTING_NAMES, set_setting);
    int s; init_socket(&s);
    leds_init(&strip, config.led_count, config.led_pin, config.led_dma, 255);
    printf("Started ...\n");                 // ab hier schickt der Server UDP
    while (get_running()) { poll_settings(&s, set_setting); /* ... */ }
    leds_off(&strip); ws2811_fini(&strip);
}
```

| Programm | Art | Einstellungen |
|---|---|---|
| `ambilight.c` | service | `brightness`, `smooth_ratio`, `dark_gamma`, `resize_size`, `distance_{left,top,right,bottom}`, `strength_{red,green,blue}` |
| `static_color.c` | oneshot | `power` (on/off), `color`, `brightness` (0–255) |
| `color_flow.c` | service | `colors` (Liste), `speed` (ms pro Schritt), `brightness` (%) |

- `ambilight.c`: V4L2-Capture (mmap, 640×480 YUYV), BT.601-Umrechnung, Ränder abtasten,
  Glättung `alt * smooth_ratio + neu * (1 - smooth_ratio)`, Schwarzbild-Erkennung über ein
  Raster, automatische Letterbox-Erkennung (`AUTO_BARS`, größere Balken erst nach
  `BAR_GROW_FRAMES`).
- `color_flow.c`: Lauflicht — alle `speed` ms wird die nächste Farbe vorne eingeschoben
  (`memmove` + `pixels[0]`), gerendert wird nur bei einer Änderung (`needs_render`), Takt über
  `CLOCK_MONOTONIC` mit `last_step += speed_ms`; Nachholen auf `led_count` Schritte begrenzt.
  Die Farbliste wird auf einer Kopie zerlegt (`strtok_r`) und erst nach vollständigem Prüfen
  übernommen, damit eine kaputte Nachricht die laufende Animation nicht stört.

**Fallen, die schon weh getan haben:**
- `sscanf` in `uint8_t` braucht `%2hhx`, nicht `%2x`.
- Lange `getopt_long`-Optionen brauchen eigene `val`-Codes (`OPT_*` ab 1001, Settings ab
  `OPT_SETTING_BASE 3001`) — zwei gleiche `case`-Werte sind ein Compile-Fehler.
- `SETTING_VALUE_MAX 256` in `leds.h` begrenzt UDP-Werte; vorher waren es 64 Bytes und `%31s`,
  damit wäre eine Farbliste mit 20 Farben (159 Zeichen) still abgeschnitten worden.
- `ws2811_render` nicht vergessen — ohne den Aufruf bekommt der Streifen nie Daten.
- Bei der Rand-Abtastung ist `resize_size - d` richtig (nicht `- 1 - d`), weil `nearest()` die
  linke/obere Zellkante wählt — damit ist es symmetrisch zu `d`.
- Root ist nötig (DMA/PWM), sonst kommt "Failed to create mailbox device".

## Node-Seite (`Luca_Smart_Home/Node/`)

Kein Framework, nur `http`/`dgram`/`child_process` + `pg`.

| Datei | Aufgabe |
|---|---|
| `server.js` | Routen-Tabelle `[methode, regex, handler]`, Dateien aus `public/`, Security-Header |
| `smarthome.js` | Datenbankzugriff: Baum, Geräte, Features, Einstellungen laden/prüfen/speichern |
| `features.js` | startet/stoppt die Programme, UDP, Oneshot-Läufe, Exklusivitätsregeln |
| `auth.js` | Login: scrypt-Hash, Session-Token (nur SHA-256 davon in der DB), Ratenbegrenzung, Bearer-Tokens |
| `user.js` | `sudo node user.js add/password/delete/list` + `token add/list/delete` (keine Registrierungsseite); `add` legt gleich die Startdaten an, `delete` nimmt Rezepte samt Bilddateien mit |
| `recipes.js` | Rezepte, Zutaten, Tags, Skalieren, Einkaufsliste, Bilder |
| `pantry.js` | der Vorrat (`pantry_items`) |
| `mcp.js` | MCP-Server: JSON-RPC über `POST /api/mcp`, ruft `recipes.js`/`pantry.js`/`bring.js`/`yazio.js` direkt auf |
| `bring.js` | Bring!-Konnektor je Benutzer (inoffizielle API per `fetch`, kein Zusatzpaket): Konto verbinden, Listen, Einträge hinzufügen |
| `yazio.js` | YAZIO-Konnektor je Benutzer (inoffizielle API, wie `bring.js` gebaut): Konto verbinden, Tag/Ziele/Gewicht lesen, Produkte suchen, Essen eintragen und löschen, Rezept eintragen |
| `secret.js` | `encrypt`/`decrypt` (AES-256-GCM) und der Schlüssel (`SECRET_KEY`/`SECRET_KEY_FILE`) — gemeinsam für Bring! und YAZIO |
| `oauth.js` | OAuth 2.1 für claude.ai/Handy: Metadaten, Registrierung, Freigabe, Token (PKCE S256) |
| `db.js` | `new Pool({ max: 1, options: "-c jit=off" })` |
| `log.js` | letzte 200 Zeilen + SSE-Stream `/api/log` |
| `public/` | `app.js` (Navigation + Seiten), `feature-panel.js` (Panels aus den Definitionen), `recipes.js`/`pantry.js` (Rezeptseiten), `nutrition.js` (Seite „Ernährung“, dazu die Helfer für den Rezeptknopf), `account.js` (Konto: Bring! und YAZIO), `lib.js` (`api`, `el`, `icon`, `throttle`, `errorBox`, `showPage`, `breadcrumb`, `cardGrid`, `plural`), `style.css`, `login.*` |

Routen: `/api/health` (ohne Login, für den Deploy), `/api/login|logout|me`, `/api/navigation`,
`/api/rooms/:id`, `/api/devices/:id` (+`/settings`, `/pinned`), `/api/features/:id`
(+`/state`, `/active`, `/settings`), `/api/log`; dazu `/api/recipes` (+`/dishes` (Grundrezepte für
die Auswahl „Variante von“), `/:id`, `/:id/delete`,
`/:id/ingredients`, `/:id/shopping-list`, `/:id/image` (+`/delete`)), `/api/ingredients`,
`/api/tags`, `/api/pantry` (+`/:ingredientId/delete`) und `/api/mcp`; dazu
`POST /api/recipes/:id/bring` (Knopf „An Bring! senden“), `/api/bring` (+`/lists`, `/login`,
`/logout`, `/list`: das eigene Bring!-Konto), `POST /api/recipes/:id/yazio` (Knopf „Portion nach
YAZIO“: `{ portions, daytime, date? }`), `/api/yazio` (+`/login`, `/logout`: das eigene
YAZIO-Konto; `/day?date=`, `/products?query=`, `POST /entries`, `POST /entries/:id/delete`: das
Tagebuch) und die OAuth-Routen:
`/.well-known/oauth-protected-resource` (+`/api/mcp`), `/.well-known/oauth-authorization-server`,
`POST /oauth/register`, `POST /oauth/token`, `/oauth/authorize` (Freigabe-Seite),
`/api/oauth/client`, `POST /api/oauth/authorize`.
Seiten: `/rooms`, `/rooms/:id`, `/devices/:id`, `/recipes`, `/recipes/new` (`?from=:id` = neue
Variante), `/recipes/:id`
(`?edit=1` zum Bearbeiten), `/pantry`, `/nutrition` (`?date=JJJJ-MM-TT`), `/account` (`account.js`), `/oauth/authorize` (`consent.html` + `consent.js`).

Umgebung: `PORT` (5000), `HOST`, `PG*`, `UDP_HOST` (127.0.0.1),
`RECIPE_IMAGE_DIR` (`/var/lib/luca-smart-home/recipe-images`), `PUBLIC_URL` (optional, öffentliche
Adresse für die OAuth-Metadaten; sonst die Adresse der Anfrage), `SECRET_KEY` / `SECRET_KEY_FILE`
(Schlüssel für die Bring!- und YAZIO-Anmeldungen, siehe MCP-Abschnitt; `BRING_API_URL` und
`YAZIO_API_URL` nur zum Testen gegen eine Attrappe).
Start: `sudo node server.js` (root wegen der LEDs). Node ≥ 18 (wegen `fetch`).

**Entscheidungen mit Grund:**
- `jit=off`: PostgreSQL schätzt die rekursive View völlig falsch ein und compiliert die Abfrage
  sekundenlang — das war die Ursache für ~1,1 s Ladezeit pro Seitenwechsel.
- `max: 1`: Schreibvorgänge bleiben in der Reihenfolge, in der sie gestartet wurden.
- Statische Dateien mit `Cache-Control: no-cache` + ETag/304, API mit `no-store` — sonst zeigen
  Browser und Cloudflare nach einem Deploy alte Dateien.
- CSRF: Es wird nur `application/json` angenommen, dazu ein `SameSite=Lax`-Cookie — deshalb ist
  kein Token nötig.
- `next` beim Login wird über `new URL(next, location.origin)` geprüft (offene Weiterleitung).
- Das Frontend baut DOM mit `el()` statt `innerHTML` (XSS) und wechselt Tabs über
  `history.pushState`, ohne die Seite neu zu laden.
- `features.state(id)` unterscheidet "gestartet" (`active`) von "läuft wirklich" (`running`) —
  die Punkte in der Tab-Leiste zeigen `running`.
- `readJson(req, limit)`: Standard 10 000 Zeichen, Rezepte 100 000. Zu große Anfragen bekommen
  eine echte `413` statt eines zerstörten Sockets.
- Der Bild-Upload geht an `readJson` **vorbei** (rohe Bytes, `readImageBody`). Der Dateityp wird
  an den ersten Bytes geprüft, nie am `Content-Type` — der kommt vom Browser. `image/*` ist
  trotzdem CSRF-sicher: ein fremdes Formular kann nur `text/plain`, `multipart/form-data` oder
  `x-www-form-urlencoded` schicken.
- Das Frontend verkleinert Bilder vorher per `canvas` auf 1600 px. Das hält den Upload klein und
  wirft nebenbei die EXIF-Daten weg (Aufnahmeort in Handyfotos).

## Rezepte, Vorrat und Einkaufsliste

- **Zutaten werden überall über ihren Namen angesprochen, nie über eine id** (`lower()`-Vergleich,
  unbekannte Namen werden angelegt). Sonst müsste ein KI-Agent erst ids einsammeln, bevor er
  etwas speichern kann.
- **Speichern ersetzt Zutaten und Schritte komplett** (`DELETE` + `INSERT` in einer Transaktion).
  Bei Listen mit Reihenfolge ist Ersetzen das einzig Vorhersagbare — die Seite und
  `update_recipe` müssen deshalb immer die ganze Liste mitschicken.
- Skalieren (`?servings=`) rechnet `amount * servings / recipes.servings` und rundet: ab 10 auf
  ganze Zahlen, ab 1 auf halbe Schritte, darunter auf zwei Stellen. Zutaten ohne Menge
  („etwas Öl“) bleiben unverändert. Das rechnet **immer der Server**, damit Seite, API und
  MCP-Werkzeuge dieselben Zahlen zeigen.
- **Einkaufsliste** (`planShoppingList`): eine Zutat, die im Vorrat steht, kommt nicht auf die
  Liste — außer der Vorrat hat dieselbe Einheit und zu wenig davon, dann nur die fehlende Menge.
  `items` ist genau die Form, die Bring! `saveItem(listUuid, itemName, specification)` braucht:
  `{ name, spec }`. `from_pantry` und `note` sind **Pflicht in der Antwort**, auch wenn leer:
  der Agent soll die Vorratszutaten nennen, damit nichts vergessen wird.
- **Alternativen („Chiliflocken oder Chipotle-Pulver“)** sind eine Wahl, keine zwei Zutaten:
  `recipe_ingredients.alternative_group` — gleicher Text im selben Rezept heißt „eine davon
  genügt“. Sie stehen **nicht** in `items`, sondern in `choices` (`{ question, options: [{ name,
  spec }] }`, in der Antwort Pflicht wie `from_pantry`); die `note` sagt dem Agenten, dass er
  nachfragen und nur die gewählte eintragen soll.
  **Beim Speichern abgelehnt** (mit einer Anleitung in der Meldung — die KI liest sie und legt
  es richtig an, nur Prompt-Text hat nicht gereicht): ein Name „A oder B“, „oder X“ im
  **Hinweis** einer Zutat (`alternativeInNote`) und eine `alternative_group`, die nur eine Zutat
  hat (Tippfehler „Schärfe“/„Schaerfe“; Groß/klein zählt nicht). Ältere Rezepte, die so etwas
  schon tragen, erkennt `planShoppingList` trotzdem als Wahl; steht die im Hinweis genannte
  Zutat zusätzlich als eigene Zeile da, ist diese Zeile die zweite Option (mit ihrer Menge).
  `alternativeInNote` ist absichtlich eng, weil ein Fehlalarm ein richtiges Rezept ablehnt: am
  Anfang muss nach „oder/bzw./alternativ/ersatzweise“ ein Hauptwort folgen und das erste Wort
  darf keins aus `NOT_AN_ALTERNATIVE` sein („oder mehr nach Geschmack“); mitten im Text muss
  direkt danach ein Hauptwort stehen und davor keins („frisch oder TK“, „z. B. Gouda oder
  Emmentaler“ beim Käse sind keine Alternativen). Hauptwort = groß, dann klein (`NOUN`).
  Dieselbe Wahl aus mehreren Rezepten wird **eine** Frage mit addierten Mengen; braucht ein
  anderes Rezept eine Option fest, entfällt die Frage und die Menge kommt dazu. Reicht der
  Vorrat für eine Option, entfällt die Wahl (steht in `from_pantry`); reicht er nur zum Teil,
  trägt die Option `in_pantry` (`spec` ist dann der Rest). `POST /api/recipes/:id/bring` nimmt
  `choices: [Name, …]` und verlangt genau eine Option je Alternative, sonst `400` (eine Wahl
  darf für zwei Fragen gelten, die dieselbe Option haben) — die Seite schaltet den Knopf erst
  nach der Wahl frei. Das MCP-Werkzeug `bring_add_items` kann das nicht erzwingen (es kennt die
  Alternativen nicht), deshalb steht es in den Beschreibungen.
  Die Seite zeigt **nicht** `note` (das ist für den Agenten geschrieben), sondern einen eigenen
  Satz.
- **Varianten** (`variant_of`, `variant_label`): beim Speichern drei Zustände wie die Nährwerte
  (`undefined` = bleibt, `null` = eigenständig, id = Variante). `setVariantOf` baut um statt
  abzulehnen, damit jede Angabe ein gültiges Gericht ergibt: id einer Variante → deren Gericht;
  ein Grundrezept mit Varianten nimmt sie mit; id einer **eigenen** Variante → die wird das neue
  Grundrezept; `null` löst nur eine Variante heraus (ein Grundrezept bleibt Grundrezept).
  Löschen eines Grundrezepts macht die älteste Variante zum neuen (`new_base` in der Antwort).
  `getRecipe` liefert `dish_id` und `variants` (leer ohne Varianten), die Suche `dish_id` und
  `variant_count` (1 = keine). Die Rezeptliste zeigt eine Karte pro Gericht (bester Treffer),
  die Rezeptseite die Varianten als Reiter (echte Links). „Variante anlegen“
  (`/recipes/new?from=:id`) kopiert das Rezept **ohne Nährwerte und Bild** — die gälten für die
  andere Variante und landeten sonst ungeprüft in YAZIO.
- Mehrere Rezepte werden zusammengefasst: gleiche Zutat und gleiche Einheit werden addiert, eine
  Zutat ohne Menge („Butter zum Braten“) wird in den vorhandenen Eintrag eingehängt.
- **Nährwerte** (`recipes.nutrients`) sind drei Zustände: nicht mitgeschickt (`undefined`: beim
  Ändern bleibt der alte Wert, sonst müsste jede Änderung durch eine KI sie mitschicken),
  `null` (löschen) oder ein Objekt (setzen). `saveRecipe` macht das mit
  `CASE WHEN $11::boolean THEN … ELSE nutrients END`. Die Seite schickt das Feld **immer**
  (alle vier Felder leer = `null`, teilweise ausgefüllt = Fehler im Browser), die KI hat
  `set_recipe_nutrients` (`setNutrients`), das nur die Nährwerte ändert.

## MCP-Server (`Node/mcp.js`)

Eine Route, `POST /api/mcp`, JSON-RPC 2.0. **Kein `@modelcontextprotocol/sdk`** — das wäre die
erste Abhängigkeit neben `pg`. Die Werkzeuge rufen `recipes.js`/`pantry.js` direkt auf.

- **Zwei Protokoll-Zeitalter in einem Server („dual-era“).** Alt (bis `2025-11-25`): `initialize`,
  dann `tools/list`. Neu (ab `2026-07-28`): kein Handshake, jede Anfrage trägt ihre Version in
  `_meta["io.modelcontextprotocol/protocolVersion"]` und im Header `MCP-Protocol-Version`,
  Ergebnisse haben `resultType: "complete"`, `server/discover` ersetzt `initialize`. Welches ein
  Client spricht, weiß man vorher nicht.
- Absichtliche Abweichung: `Mcp-Method`/`Mcp-Name` werden nur geprüft, **wenn** sie da sind
  (Spec verlangt sie). Stimmen sie nicht zum Körper → `400` mit `-32020`.
- `GET`/`DELETE` auf `/api/mcp` → `405` (die gab es nur im alten Transport).
- Fehler eines Werkzeugs kommen als Ergebnis mit `isError: true` zurück, nicht als
  Protokollfehler — nur so liest das Modell die Meldung und kann es richtig nochmal versuchen.
- **Anmeldung:** `Authorization: Bearer <token>` aus `api_tokens`. Eingehängt an genau einer
  Stelle (`auth.userFromRequest`: erst Cookie, dann Bearer), dadurch ist die ganze API damit
  erreichbar. Token anlegen: `sudo node user.js token add <benutzer> <name> [tage]` — es wird
  genau einmal angezeigt, gespeichert ist nur der SHA-256-Hash. Falsche Tokens zählen in dieselbe
  Sperre wie falsche Passwörter.
- Einhängen in Claude Code: `claude mcp add --transport http rezepte https://<adresse>/api/mcp
  --header "Authorization: Bearer …"`. In claude.ai und der Handy-App: als eigenen Konnektor mit
  der Adresse `https://<adresse>/api/mcp` hinzufügen, ohne Token — der Rest ist OAuth (unten).
- **OAuth (`oauth.js`)**: der Pi ist sein eigener kleiner Autorisierungsserver und benutzt das
  bestehende Login. Ablauf: `/api/mcp` ohne Token → `401` mit `WWW-Authenticate: Bearer
  resource_metadata=…` → die beiden `.well-known`-Seiten → `POST /oauth/register` (dynamisch,
  nur öffentliche Clients, Rücksprung nur `https://` oder `http://localhost`) →
  `/oauth/authorize` (ohne Cookie Umleitung auf `/login?next=…`, dann die Freigabe-Seite) →
  `POST /oauth/token` mit PKCE-S256. Access-Token sind normale Zeilen in `api_tokens` (Name
  `oauth:<client_id>`, 1 Stunde, pro Benutzer und Client genau eines), Refresh-Token 30 Tage und
  bei jeder Benutzung ausgetauscht, der Code gilt 10 Minuten und genau einen Versuch (auch einen
  falschen). Die Freigabe geht nur mit Cookie-Login, nie mit einem Bearer-Token — ein
  gestohlenes Token soll keine weiteren ausstellen. **Der Token gilt für die ganze API des
  Benutzers**, nicht nur für `/api/mcp` (das steht auch auf der Freigabe-Seite). Widerrufen:
  `sudo node user.js token delete <benutzer> oauth:<client_id>`. Fehler dieser Endpunkte haben die
  RFC-Form `{ error, error_description }`, nicht `{ error: "Text" }`.
  **Nicht gegen claude.ai selbst geprüft** — nur gegen die Spec und eigene Aufrufe (siehe
  „Testen“); der erste echte Versuch ist der Test.
- **Bring! (`bring.js`)** läuft auf dem Pi, damit die Kette auch vom Handy aus geht. Bring! hat
  **keine offizielle API**; Pfade, Header und Body sind aus
  [miaucl/bring-api](https://github.com/miaucl/bring-api) übernommen und können ohne Vorwarnung
  brechen. Darum eigene Datei: ein Fehler von Bring! kommt als 424 — die Rezepte laufen immer
  weiter.
  **Jeder Benutzer meldet sich selbst an**, auf der Seite `/account` („Konto“); Tabelle
  `bring_accounts`. Werkzeuge, Knopf und OAuth-/Claude-Code-Tokens schreiben immer in das Konto
  des anfragenden Benutzers. Ohne Konto antworten sie `409` mit dem Hinweis auf die Seite.
  Anmelden, Trennen und Standardliste gehen nur mit dem Cookie-Login (`requireBrowserLogin`),
  nie mit einem Token — sonst könnte es die Einkaufsliste in ein fremdes Konto umleiten.
  **Das Passwort wird nicht gespeichert**, es geht nur durch den Server zu Bring!. Behalten wird
  der `refresh_token`, AES-256-GCM-verschlüsselt (`credentials` = `iv.tag.daten`). Der Schlüssel
  steht nicht in der Datenbank: `SECRET_KEY` (64 Hex-Zeichen) oder die Datei `SECRET_KEY_FILE`
  (Standard `/var/lib/luca-smart-home/secret.key`, wird beim ersten Gebrauch angelegt, 0600,
  liegt wie die Rezeptbilder außerhalb des kopierten Ordners). Geht sie verloren, müssen sich
  alle neu bei Bring! anmelden — mehr nicht. Das Zugriffstoken liegt nur im Speicher (Erneuern
  per `refresh_token`; schlägt das fehl, kommt „abgelaufen“ mit dem Hinweis, sich neu
  anzumelden).
  Werkzeuge: `bring_lists`, `bring_list_items`, `bring_add_items`; Knopf auf der Rezeptseite
  (erscheint erst unter der Vorschau). **Schreiben nur auf ausdrücklichen Befehl:**
  `plan_shopping_list` ist die Vorschau, `bring_add_items` der einzige schreibende Aufruf; die
  Werkzeugbeschreibung verlangt erst das Ja des Benutzers. Was schon auf der Liste steht (gleicher
  Name), wird **nicht** überschrieben, sondern als `already_on_list` gemeldet — Bring! würde sonst
  die Menge eines fremden Eintrags ersetzen. Derselbe Name zweimal in einem Aufruf (500 g und
  2 Packungen) wird vorher zu einem Eintrag „500 g + 2 Packungen“ (`mergeSameName`), denn
  Bring! kennt je Name nur einen. Bei mehreren Listen wird nicht geraten (geteilte
  Liste): ohne `list` und ohne Standardliste (auf der Seite „Konto“ gewählt) kommt ein Fehler
  mit den Namen.
- **YAZIO (`yazio.js`)**: dieselbe Bauart wie Bring!, gleiche Gründe. **Keine offizielle API**;
  die Quellen (Pfade, Bodies, Einheiten) stehen als Kommentar oben in `yazio.js`:
  [juriadams/yazio](https://github.com/juriadams/yazio) (Basis `/v20`, Token als JSON) und
  [saganos/yazio_public_api](https://github.com/saganos/yazio_public_api) (Basis `/v15`, Token als
  `x-www-form-urlencoded`).
  **Basis ist `/v15`, nicht `/v20`:** `/v20` liefert für alle `/user/…`-Pfade `403
  {"error":"version_blocked"}` (so aufgefallen beim ersten echten Test; die Produktsuche ist nicht
  gesperrt und ging durch). Ohne Anmeldung nachgemessen (nur GET): v10–v19 antworten `401`
  (gültig), v20–v22 `version_blocked`, ab v23 und bis v5 `410`. Fällt auch `/v15` weg, ist `v19`
  der nächste Kandidat; `YAZIO_API_URL` überschreibt die Basis.
  Bei den Tokens widersprechen sich die Quellen, deshalb nimmt `tokenRequest` JSON und
  probiert die andere Form nur, wenn der Server die erste nicht versteht (415, oder 400 **ohne**
  OAuth-Fehlerfeld — ein `invalid_grant` heißt „verstanden, Passwort falsch“) und merkt sich, was
  ging. Die Anmeldung kann gegen **Kontosperre** und die Nutzungsbedingungen laufen — Luca hat das
  bewusst entschieden. Ein Fehler von YAZIO kommt als **424** (`HttpError.UPSTREAM`, wie bei
  Bring!) und nimmt nur die `yazio_*`-Werkzeuge, die Seite „Ernährung“ und den Rezeptknopf mit.
  **Nicht 502:** vor dem Pi steht Cloudflare und ersetzt ein 502 des Servers durch seine eigene
  „Bad gateway“-Seite — die Meldung ginge verloren (so aufgefallen beim ersten echten Test).
  Die Meldung nennt den Grund aus YAZIOs Antwort (`reason()`: nur `error_description`/`message`/
  `error`, auf 120 Zeichen gekürzt; ist die Antwort kein JSON, ihr Typ — eine Sperrseite vor
  YAZIO erkennt man daran), und `rejected()` schreibt dieselbe Zeile ins Log (`/api/log`).
  Der MCP-Endpunkt zeigt den Fehler ohnehin als `isError`, mit der Browser-Sitzung lässt er sich
  zum Diagnostizieren aufrufen (`fetch("/api/mcp", …)` mit `tools/call`).
  **Jeder Benutzer meldet sich selbst an** (Seite „Konto“, Tabelle `yazio_accounts`), Anmelden
  und Trennen nur mit Cookie-Login. Passwort wird nicht gespeichert, nur der `refresh_token`
  verschlüsselt (`secret.js`, derselbe Schlüssel wie Bring!). **Wechselt YAZIO den
  `refresh_token` bei der Erneuerung, wird der neue gespeichert** (`refresh()`), sonst wäre man
  nach dem nächsten Neustart abgemeldet. `client_id`/`client_secret` sind fest in der App und
  öffentlich (`gitleaks:allow`).
  Werkzeuge: lesend `yazio_day`, `yazio_goals`, `yazio_weight`, `yazio_search_products`,
  `yazio_get_product`; schreibend `yazio_add_product`, `yazio_log_recipe`, `yazio_remove_entry`
  und `set_recipe_nutrients` (das schreibt in die Rezepte, nicht nach YAZIO). **Schreiben nur
  nach dem ausdrücklichen Ja des Benutzers** (steht in den Beschreibungen und in `INSTRUCTIONS`).
  Wasser und Gewicht werden **nur gelesen**.
  - Einheiten: Nährwerte eines **Produkts** gelten pro Gramm (`energy.energy` = kcal pro Gramm);
    die Werkzeuge geben deshalb `per_100` (je 100 g/ml) aus. `amount` ist Gramm bzw. Milliliter.
    Summen und Ziele eines Tages rechnet YAZIO (`/user/widgets/daily-summary`), nicht wir.
  - **Rezept → YAZIO** (`logRecipe`): ein `simple_product` (freier Eintrag mit Namen und
    Summen) „Chili con Carne (2 Portionen)“. Der Server rechnet Nährwerte pro Portion mal
    `portions` — Seite und Werkzeug schicken nur die Portionszahl. Ohne Nährwerte im Rezept
    `409` mit dem Hinweis, sie erst zu setzen. **Das Format eines `simple_product` beim
    Schreiben steht in keiner der Quellen** (beim Lesen: `{ id, date, daytime, type, name,
    nutrients, is_ai_generated }`); es wird die Spiegelform ohne `type` geschickt, siehe
    „Offene Punkte“.
  - `date` ist `JJJJ-MM-TT` (Standard heute in `Europe/Berlin`, der Pi läuft in UTC),
    `daytime` ist `breakfast|lunch|dinner|snack`, Eintrags-ids sind UUIDs. Löschen nimmt die id
    des **Eintrags** (aus `yazio_day`), nicht die des Produkts; YAZIO antwortet auch auf eine
    unbekannte id mit Erfolg.
  - Namen der Produkte im Tagebuch löst `day()` über `/products/:id` auf, im Speicher gecacht.

## Deploy

Push auf `main` → GitHub Actions → `ansible-playbook` über `cloudflared access ssh`
(Cloudflare Access Service Token) → auf dem Pi: Dienst stoppen, Ordner kopieren,
`schema.sql` + `seed.sql`, `make`, `npm ci --omit=dev`, Bildordner anlegen,
`/etc/luca-smart-home.env` schreiben, systemd-Unit `luca-smart-home` installieren und starten,
`/api/health` prüfen. Eine `concurrency`-Gruppe sorgt dafür, dass zwei Deploys sich nicht
überholen (`cancel-in-progress: false` — ein abgebrochener Deploy ließe den Pi halb kopiert
zurück).

Die Unit setzt `HOST=127.0.0.1`: der Server ist **nur noch über den Cloudflare-Tunnel**
erreichbar, nicht mehr unter `http://<pi>:5000` im Heimnetz.
`RECIPE_IMAGE_DIR=/var/lib/luca-smart-home/recipe-images` liegt außerhalb des Ordners, den der
Deploy kopiert — sonst wären die Bilder nach jedem Deploy weg.

GitHub: Secrets `SSH_PASSWORD`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `DB_PASSWORD`;
Variablen `SSH_USER`, `SERVER_IP`, `DB_USER`, `DB_NAME`.
Optional: Variable `PUBLIC_URL` (z. B. `https://home.example.com`) — fehlt sie, steht die Zeile
nicht in `/etc/luca-smart-home.env` und der Deploy läuft trotzdem. Bring! und YAZIO brauchen
**keine** Secrets: die Zugangsdaten gibt jeder Benutzer auf der Seite „Konto“ ein.

## Testen (Windows, alles in Docker)

Es gibt keine Testsuite; geprüft wird mit Containern. In Git Bash **`MSYS_NO_PATHCONV=1`** vor
`docker run` setzen, sonst verbiegt Git Bash die Pfade.

`rpi_ws281x` selbst bauen (die Debian-Pakete sind oft nicht erreichbar, cmake ist nicht nötig):
Repo klonen, eine `version.h` mit `VERSION_MAJOR/MINOR/MICRO` selbst schreiben, dann
`gcc -O2 -c ws2811.c pwm.c pcm.c dma.c mailbox.c rpihw.c` und `ar rcs libws2811.a *.o`;
die Header nach `include/ws2811/` kopieren, weil die Programme `<ws2811/ws2811.h>` einbinden.

Bauen: `make CFLAGS="-O2 -Wall -Wextra -I/w/include" LDLIBS="/w/lib/libws2811.a -lm"`.

Verhalten ohne Pi: einen Stub mit `ws2811_init/fini/render/wait/get_return_t_str` dazulinken,
der jeden Render-Durchgang als Hex-Zeile druckt, dazu ein kleines Sendeprogramm
(`sendto` an `127.0.0.1:9000`) für die Live-Einstellungen. Mit
`-fsanitize=address,undefined` bauen.

Datenbank: `postgres:15-alpine` starten, **erst den Stand vom Pi** (alte `schema.sql` + `seed.sql`
aus `git show`), dann die neuen Dateien zweimal darüber — beides muss fehlerfrei durchlaufen.
Beim `psql -f` in Git Bash den Pfad im Container mit doppeltem Schrägstrich schreiben
(`-f //schema.sql`). `MSYS_NO_PATHCONV=1` gilt auch für `docker exec`, nicht nur `docker run`.

Node-Seite: Container mit `-p 55432:5432` starten, dann den Server lokal gegen ihn laufen lassen
(`PGHOST=127.0.0.1 PGPORT=55432 … PORT=5099 RECIPE_IMAGE_DIR=<Temp-Ordner> node server.js`) und
mit `curl` durchgehen. Für den MCP-Teil vorher `node user.js token add luca test` — das Token
geht dann als `Authorization: Bearer …` an `/api/mcp`.
Die Oberfläche lässt sich im eingebauten Browser prüfen; auch auf 375 px Breite ansehen. Eingeloggt
wird dort mit einem Testbenutzer (`node user.js add …`, Passwort per Pipe); mit `form_input` und
`ref` statt Koordinaten, und Interaktionen gehen zuverlässiger über `javascript_tool`
(Ereignisse auslösen, `requestSubmit()`), wenn das Fenster nicht im Vordergrund ist.

YAZIO/Bring! testet man gegen eine **Attrappe**: ein kleiner Node-Server, der die Pfade
nachstellt (`/v15/oauth/token` in JSON und als Formular, `/user/consumed-items` GET/POST/DELETE,
`/user/widgets/daily-summary`, `/user/goals/unmodified`, `/user/bodyvalues/weight/last`,
`/products/search`, `/products/:id`), jede Anfrage mitprotokolliert (um die Bodies zu prüfen) und
mit Schaltern für „Token abgelaufen“, „refresh_token wechselt“, „nur Formular“, „ausgefallen“.
Server mit `YAZIO_API_URL=http://127.0.0.1:<port>/v15` und `SECRET_KEY_FILE=<Temp>` starten.
Zu prüfen: Anmelden (Cookie ja, Token `403`), falsches Passwort und Sperre nach 10, Rezept mit
Nährwerten (die Zahlen im POST-Body nachrechnen), Löschen, abgelaufenes Token (genau **eine**
Erneuerung bei parallelen Anfragen), Ausfall (`424`, Rezepte laufen weiter), und dass alte
Bring!-Werte mit `secret.js` lesbar bleiben (mit dem alten `encrypt` aus `git show` erzeugen).

## Zusammenarbeit

- Antworten auf Deutsch, ausführlich erklären: Luca lernt C, also auch erklären **warum** etwas
  so gemacht wird, nicht nur den Code zeigen.
- Nur auf Ansage pushen ("push") — dann direkt auf `main`, das löst den Deploy aus.
- Luca wendet Änderungen oft selbst an; dann den Stand lesen und seine Struktur weiterführen
  statt sie zu ersetzen (bei `color_flow.c` kam das Lauflicht von ihm).
- Vor einer Aussage über das Verhalten eines Programms im Container nachbauen und laufen lassen;
  er prüft Behauptungen nach und hat schon mehrfach zu Recht widersprochen.

## Offene Punkte

- **OAuth und Bring! sind gebaut, aber noch nie gegen die echten Dienste gelaufen.** Getestet
  wurde gegen eine Attrappe der Bring!-API und mit eigenen Aufrufen für OAuth. Beim ersten
  Einhängen in claude.ai und beim ersten echten Bring!-Eintrag genau hinsehen (Pfade, Header,
  Form des Batch-Bodys; Spec-Fassung von OAuth/MCP).
- **YAZIO ist gebaut, aber noch nie gegen das echte YAZIO gelaufen** — nur gegen eine Attrappe
  und den gelesenen Quelltext der Community-Clients. Beim ersten echten Versuch (mit Luca, nach
  dem Deploy) in dieser Reihenfolge prüfen und jeweils nachsehen, was YAZIO antwortet:
  1. **Anmelden**: ging am 2026-11-03 beim ersten Versuch. **Lesen** scheiterte an `/v20`
     (`version_blocked`), seitdem Basis `/v15` — ob die `/user/…`-Pfade dort mit dem Token gehen,
     ist noch nicht gesehen.
  2. **Lesen**: `yazio_day` für einen Tag mit Einträgen; stimmen Summe, Ziele, Wasser mit der App
     überein? Sind die Produkt-Nährwerte wirklich pro Gramm (`per_100` von etwas Bekanntem wie
     Haferflocken ≈ 370 kcal)? Kommt `/user/consumed-items` als Objekt mit drei Listen oder als
     Liste (`flattenEntries` kann beides)?
  3. **Schreiben, größte Unbekannte**: ein `simple_product` per `yazio_log_recipe` — Body
     `{ id, date, daytime, name, nutrients: { "energy.energy", "nutrient.protein",
     "nutrient.carb", "nutrient.fat" }, is_ai_generated: false }`, `date` nur als Datum. Lehnt
     YAZIO ab (422), steht in der Antwort nur „HTTP 422“ (Antwortkörper werden nie geloggt);
     dann den Body gegen die App abgleichen (z. B. `date` mit Uhrzeit, `type` mitschicken). Danach
     den Eintrag in der YAZIO-App ansehen und wieder löschen.
  4. `yazio_add_product` mit `serving`/`serving_quantity` und `yazio_remove_entry`.
  Dazu das Risiko der **Kontosperre** bei inoffizieller Nutzung.
- OAuth-Token auf `/api/mcp` beschränken (heute gilt es für die ganze API, siehe MCP-Abschnitt).
- Aufräumen läuft nur beim Registrieren eines Clients (`oauth.js`), nicht zeitgesteuert.
- Der Name-CHECK (`^[a-z][a-z0-9_-]*$`) wird bei vorhandenen Tabellen nicht ersetzt; wenn er
  sich ändern soll, in den `DO`-Block zu den anderen Constraints aufnehmen.
- `ambilight.c` ist noch einthreadig (Aufnahme und Ausgabe in einer Schleife).
