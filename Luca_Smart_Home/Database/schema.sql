-- Smart home database: rooms -> devices (nestable) -> features -> settings,
-- plus the recipes: ingredients -> recipes -> recipe_ingredients / recipe_steps / pantry_items
--
-- Can be run again at any time (every deploy runs it), it only creates what is missing.
-- Needs PostgreSQL 15 or newer (UNIQUE NULLS NOT DISTINCT).

-- no "already exists, skipping" notices when it runs again
SET client_min_messages = warning;

-- a room of the house, e.g. "Wohnzimmer"
CREATE TABLE IF NOT EXISTS rooms (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- a device, either directly in a room (room_id) or plugged into another device (parent_device_id),
-- e.g. the ambilight LEDs hang on the TV, the TV is in the living room
CREATE TABLE IF NOT EXISTS devices (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id          BIGINT REFERENCES rooms (id) ON DELETE CASCADE,
    parent_device_id BIGINT REFERENCES devices (id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    type             TEXT,              -- free text, e.g. "tv", "light", "led_strip"
    pinned_at        TIMESTAMPTZ,       -- pinned in the navigation since then, NULL = not pinned
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT devices_one_location CHECK (num_nonnulls(room_id, parent_device_id) = 1),
    -- names are unique per room or per parent device
    CONSTRAINT devices_unique_name UNIQUE NULLS NOT DISTINCT (room_id, parent_device_id, name)
);

-- databases created before pinning existed
ALTER TABLE devices ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS devices_room_id_idx ON devices (room_id);
CREATE INDEX IF NOT EXISTS devices_parent_device_id_idx ON devices (parent_device_id);

-- a device must never end up inside itself (A -> B -> A)
CREATE OR REPLACE FUNCTION devices_check_cycle() RETURNS trigger AS $$
BEGIN
    IF NEW.parent_device_id IS NOT NULL AND EXISTS (
        WITH RECURSIVE ancestors (id) AS (
            SELECT NEW.parent_device_id
            UNION   -- UNION instead of UNION ALL also stops at cycles that already exist
            SELECT d.parent_device_id
            FROM devices d
            JOIN ancestors a ON d.id = a.id
            WHERE d.parent_device_id IS NOT NULL
        )
        SELECT 1 FROM ancestors WHERE id = NEW.id
    ) THEN
        RAISE EXCEPTION 'Gerät % (%) kann nicht in sich selbst verschachtelt werden', NEW.id, NEW.name;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER devices_no_cycle
    BEFORE INSERT OR UPDATE OF parent_device_id ON devices
    FOR EACH ROW EXECUTE FUNCTION devices_check_cycle();

-- how the server runs the program of a feature; a new kind needs a row here and its code in
-- Node/features.js
CREATE TABLE IF NOT EXISTS feature_kinds (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

INSERT INTO feature_kinds (name, description) VALUES
    ('service', 'Läuft dauerhaft mit Start und Stopp; Einstellungen gehen sofort per UDP an das Programm, '
                || 'Einstellungen mit restart_required erst nach Speichern und Neustart'),
    ('oneshot', 'Läuft einmal, wenn Einstellungen gespeichert werden; die Einstellungen kommen als '
                || '--name=wert auf der Kommandozeile')
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;

-- a function of a device, e.g. "ambilight" on the LEDs or later "hdmi_switch" on the TV
--
-- kind:       how the program runs, see feature_kinds
-- executable: program of the feature, relative to Luca_Smart_Home/ or absolute; it gets all settings
--             as --name=value on the command line
-- udp_port:   service only: the settings without restart_required are sent there as "name: value"
--             whenever they change and after the program printed a line starting with "Started"
-- exclusive:  of the exclusive services of a device only one can run at the same time, e.g. the LEDs
--             show either "ambilight" or "static_color"; an exclusive oneshot stops the exclusive
--             services of its device before it runs
-- active:     service only: the feature is started (the server starts it again after a restart)
CREATE TABLE IF NOT EXISTS features (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id  BIGINT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    type       TEXT NOT NULL,           -- free text, e.g. "ambilight"
    name       TEXT NOT NULL,           -- display name
    kind       TEXT NOT NULL DEFAULT 'service' REFERENCES feature_kinds (name),
    executable TEXT,
    udp_port   INTEGER CHECK (udp_port BETWEEN 1 AND 65535),
    exclusive  BOOLEAN NOT NULL DEFAULT false,
    active     BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT features_unique_name UNIQUE (device_id, name)
);

-- databases created before kind existed: all features were services
ALTER TABLE features ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'service' REFERENCES feature_kinds (name);

-- databases created before udp_port existed: ambilight listened on port 9000
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'features' AND column_name = 'udp_port'
    ) THEN
        ALTER TABLE features ADD COLUMN udp_port INTEGER CHECK (udp_port BETWEEN 1 AND 65535);
        UPDATE features SET udp_port = 9000 WHERE type = 'ambilight';
    END IF;
END
$$;

-- databases created before exclusive/active existed: add the columns once,
-- ambilight features become exclusive (later changes to exclusive are kept)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'features' AND column_name = 'exclusive'
    ) THEN
        ALTER TABLE features ADD COLUMN exclusive BOOLEAN NOT NULL DEFAULT false;
        UPDATE features SET exclusive = true WHERE type = 'ambilight';
    END IF;
END
$$;
ALTER TABLE features ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS features_type_idx ON features (type);

-- at most one active exclusive feature per device
CREATE UNIQUE INDEX IF NOT EXISTS features_one_active_exclusive ON features (device_id) WHERE exclusive AND active;

-- the settings a feature has, the web page shows them from this table
CREATE TABLE IF NOT EXISTS setting_definitions (
    feature_id       BIGINT NOT NULL REFERENCES features (id) ON DELETE CASCADE,
    -- key for the database, UDP and the command line, e.g. "brightness"
    name             TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]*$'),
    label            TEXT NOT NULL,     -- shown on the page, e.g. "Helligkeit"
    -- range: slider, number: number field, boolean: switch, text, select: list of options,
    -- button_select: one button per option, color: #rrggbb, color_list: several colors in order
    -- (["#ff0000", "#00ff00"], das Programm bekommt sie als --name=#ff0000,#00ff00),
    -- screen: four numbers around a screen
    -- ({"top": 1, "left": 1, "right": 1, "bottom": 1}, the program gets them as --name_top=1 ...)
    -- (allowed types: see the constraint below)
    type             TEXT NOT NULL,
    default_value    JSONB NOT NULL,    -- used until the setting is changed, e.g. 70, true, "HDMI 1"
    min              DOUBLE PRECISION,  -- range / number
    max              DOUBLE PRECISION,  -- range / number
    step             DOUBLE PRECISION,  -- range / number, 1 = whole numbers only (default)
    unit             TEXT,              -- shown after the value, e.g. "%"
    -- select / button_select: ["HDMI 1", "HDMI 2"] or [{"value": 1, "label": "HDMI 1"}]
    options          JSONB,
    section          TEXT,              -- heading on the page, settings with the same section are shown together
    -- service only: the program has to be restarted to use a new value (saved with a button)
    restart_required BOOLEAN NOT NULL DEFAULT false,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (feature_id, name)
);

-- the current value of a setting, e.g. brightness = 70; settings without a row use their default_value
CREATE TABLE IF NOT EXISTS settings (
    feature_id BIGINT NOT NULL REFERENCES features (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (feature_id, name)
);

-- settings of a device that are the same for all of its features, e.g. led_count of the LEDs;
-- every program of a feature of the device gets all of them as --name=value when it starts, before
-- the feature settings; changing them restarts the running services of the device.
-- Same columns as setting_definitions, without restart_required (they always need a restart).
CREATE TABLE IF NOT EXISTS device_setting_definitions (
    device_id     BIGINT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    name          TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]*$'),
    label         TEXT NOT NULL,
    type          TEXT NOT NULL,
    default_value JSONB NOT NULL,
    min           DOUBLE PRECISION,
    max           DOUBLE PRECISION,
    step          DOUBLE PRECISION,
    unit          TEXT,
    options       JSONB,
    section       TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, name)
);

CREATE TABLE IF NOT EXISTS device_settings (
    device_id  BIGINT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, name)
);

-- The rules for type and options of both definition tables are replaced on every run, so a new
-- type only has to be added here (CREATE TABLE IF NOT EXISTS does not change an existing table).
-- setting_definitions_check is the options rule of databases from before the rules had names.
ALTER TABLE setting_definitions DROP CONSTRAINT IF EXISTS setting_definitions_check;
DO $$
DECLARE
    definitions TEXT;
BEGIN
    FOREACH definitions IN ARRAY ARRAY['setting_definitions', 'device_setting_definitions'] LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', definitions, definitions || '_type_check');
        EXECUTE format($sql$ALTER TABLE %I ADD CONSTRAINT %I
            CHECK (type IN ('range', 'number', 'boolean', 'text', 'select', 'button_select',
                            'color', 'color_list', 'screen'))$sql$,
            definitions, definitions || '_type_check');

        -- COALESCE: without options jsonb_typeof is NULL and a CHECK lets NULL pass
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', definitions, definitions || '_options_check');
        EXECUTE format($sql$ALTER TABLE %I ADD CONSTRAINT %I
            CHECK (type NOT IN ('select', 'button_select') OR COALESCE(jsonb_typeof(options) = 'array', false))$sql$,
            definitions, definitions || '_options_check');

        -- screen: the value has the four sides, e.g. {"top": 1, "left": 1, "right": 1, "bottom": 1}
        -- color_list: the value is a list, e.g. ["#ff0000", "#00ff00"]
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', definitions, definitions || '_default_check');
        EXECUTE format($sql$ALTER TABLE %I ADD CONSTRAINT %I
            CHECK ((type <> 'screen' OR default_value ?& array['top', 'left', 'right', 'bottom'])
               AND (type <> 'color_list' OR jsonb_typeof(default_value) = 'array'))$sql$,
            definitions, definitions || '_default_check');
    END LOOP;
END
$$;

-- people who can log in to the web page, added with Node/user.js (there is no sign up page)
CREATE TABLE IF NOT EXISTS users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT NOT NULL CHECK (username ~ '^[A-Za-z0-9._-]{1,64}$'),
    password_hash TEXT NOT NULL,      -- scrypt$N$r$p$salt$hash, never the password itself
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Luca" and "luca" are the same user
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (lower(username));

-- logged in browsers: the session cookie holds a random token, only its SHA-256 hash is stored,
-- so the database alone is not enough to take over a session
CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

-- every device with the room it is in (also through parent devices) and its path,
-- e.g. "Wohnzimmer / Fernseher / Ambilight LEDs"
CREATE OR REPLACE VIEW devices_with_room AS
WITH RECURSIVE tree AS (
    SELECT d.id, d.name, d.type, d.parent_device_id, d.room_id, 0 AS depth,
           r.name || ' / ' || d.name AS path
    FROM devices d
    JOIN rooms r ON r.id = d.room_id
    UNION ALL
    SELECT d.id, d.name, d.type, d.parent_device_id, t.room_id, t.depth + 1,
           t.path || ' / ' || d.name
    FROM devices d
    JOIN tree t ON d.parent_device_id = t.id
)
SELECT * FROM tree;

-- ############################################################################################
-- Recipes: ingredients -> recipes -> recipe_ingredients / recipe_steps, plus pantry_items
--
-- This is the first part of the page that is not a device, so it needs its own tables: the
-- settings system above is built for the numbers and colors of an LED program, not for lists of
-- ingredients. The patterns are the same though: IDENTITY ids, created_at, and uniqueness
-- through a functional index on lower(name) like users_username_idx.
-- ############################################################################################

-- catalogue of ingredients; every ingredient exists only once and is used by the recipes and by
-- the pantry, that is what makes "take what is at home off the shopping list" possible
CREATE TABLE IF NOT EXISTS ingredients (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT NOT NULL,
    category     TEXT,              -- free text, e.g. "Gemüse", only used to sort the list
    default_unit TEXT,              -- suggested in the form, e.g. "g" for Mehl
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Mehl" and "mehl" are the same ingredient
CREATE UNIQUE INDEX IF NOT EXISTS ingredients_name_idx ON ingredients (lower(name));

-- a recipe; its ingredients and its steps are in their own tables below
--
-- servings:         what the amounts in recipe_ingredients belong to, the page scales from here
-- tags:             ["Hauptgericht", "vegetarisch"], searched with tags && ARRAY[...]
-- image_mime:       NULL = no picture; the file itself is not in the database (see db.js max: 1),
--                   it lies in RECIPE_IMAGE_DIR/<id>.<ext>
-- image_updated_at: the browser only has to load a picture again when this changes (ETag)
CREATE TABLE IF NOT EXISTS recipes (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name             TEXT NOT NULL,
    description      TEXT,
    servings         INTEGER NOT NULL DEFAULT 4 CHECK (servings > 0),
    prep_minutes     INTEGER CHECK (prep_minutes >= 0),
    cook_minutes     INTEGER CHECK (cook_minutes >= 0),
    difficulty       TEXT,              -- einfach / mittel / schwer, see the rule at the end of the file
    tags             TEXT[] NOT NULL DEFAULT '{}',
    source           TEXT,              -- where it comes from, e.g. a link or "Oma"
    notes            TEXT,
    image_mime       TEXT,
    image_updated_at TIMESTAMPTZ,
    created_by       BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recipes_name_idx ON recipes (lower(name));

-- tags && ARRAY['vegetarisch'] uses this index instead of reading every recipe
CREATE INDEX IF NOT EXISTS recipes_tags_idx ON recipes USING GIN (tags);

-- the ingredients of a recipe in their order
--
-- The primary key is (recipe_id, position) and not an id of its own: the order is part of what
-- an entry is, and saving replaces the whole list anyway (DELETE + INSERT), so an extra id would
-- only be ballast.
-- ON DELETE RESTRICT: an ingredient a recipe uses cannot be deleted from the catalogue by
-- accident, the recipe would lose a line.
-- amount NULL means "no amount", e.g. "etwas Öl"; scaling leaves those alone.
CREATE TABLE IF NOT EXISTS recipe_ingredients (
    recipe_id     BIGINT NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
    position      INTEGER NOT NULL CHECK (position > 0),
    ingredient_id BIGINT NOT NULL REFERENCES ingredients (id) ON DELETE RESTRICT,
    amount        DOUBLE PRECISION CHECK (amount > 0),
    unit          TEXT,              -- "g", "ml", "EL", NULL = pieces
    note          TEXT,              -- "fein gewürfelt"
    group_label   TEXT,              -- heading inside the list, e.g. "Für die Soße"
    optional      BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (recipe_id, position)
);

-- for ON DELETE RESTRICT and for "which recipes use this ingredient"
CREATE INDEX IF NOT EXISTS recipe_ingredients_ingredient_idx ON recipe_ingredients (ingredient_id);

-- the steps of a recipe in their order, same primary key reasoning as above ("Schritt 3")
CREATE TABLE IF NOT EXISTS recipe_steps (
    recipe_id BIGINT NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
    position  INTEGER NOT NULL CHECK (position > 0),
    text      TEXT NOT NULL,
    minutes   INTEGER CHECK (minutes >= 0),   -- how long this step takes, NULL = not said
    PRIMARY KEY (recipe_id, position)
);

-- what is at home. ingredient_id is the primary key itself, so an ingredient can be in the
-- pantry at most once - that is what makes taking it off a shopping list unambiguous.
-- always_available: "it is always there" (Salz, Pfeffer, Öl), nothing to count;
-- amount / unit:    optional, for the things that do run out
CREATE TABLE IF NOT EXISTS pantry_items (
    ingredient_id    BIGINT PRIMARY KEY REFERENCES ingredients (id) ON DELETE CASCADE,
    always_available BOOLEAN NOT NULL DEFAULT false,
    amount           DOUBLE PRECISION CHECK (amount >= 0),
    unit             TEXT,
    note             TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- tokens for programs instead of browsers (the MCP server, Node/mcp.js): same technique as
-- sessions, only the SHA-256 hash of the token is stored. Deliberately not a row in sessions:
-- the login deletes expired rows there, and a machine token should not be swept away together
-- with the browsers of a user.
CREATE TABLE IF NOT EXISTS api_tokens (
    token_hash   TEXT PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,     -- what it is for, e.g. "claude-code"
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ        -- NULL = never runs out
);

CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens (user_id);

-- so "user.js token delete <benutzer> <name>" always means exactly one token
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_user_name_idx ON api_tokens (user_id, lower(name));

-- The Bring! account of a user (Node/bring.js): everybody logs in to their own account on the
-- page "Konto". The password is only used for the login itself and never stored; what is kept
-- is the refresh token of Bring!, AES-256-GCM encrypted with a key that is not in the database
-- (credentials = "iv.tag.data", base64url, see bring.js). A database dump alone is useless.
-- list_uuid: the shopping list that is used when a call does not name one
CREATE TABLE IF NOT EXISTS bring_accounts (
    user_id     BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    credentials TEXT NOT NULL,
    list_uuid   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OAuth for claude.ai and the phone app (Node/oauth.js): the Pi is its own small authorization
-- server. The access tokens of OAuth are ordinary rows in api_tokens (named "oauth:<client_id>"),
-- so mcp.js and auth.js do not know the difference. Only what OAuth adds lives here.
--
-- oauth_clients:        programs that registered themselves (dynamic client registration, RFC 7591);
--                       all are public clients, there is no client secret, PKCE protects the code
-- oauth_codes:          the one-time code between the consent page and the token request; only the
--                       hash is stored, it lives a few minutes and is deleted when it is used
-- oauth_refresh_tokens: the long-lived part; rotated on every use (the old one is deleted)
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id     TEXT PRIMARY KEY,
    client_name   TEXT NOT NULL,
    redirect_uris TEXT[] NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    user_id        BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,   -- PKCE, always S256
    expires_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token_hash  TEXT PRIMARY KEY,
    client_id   TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL
);

-- Full text search over the name, the tags, the ingredients and the text of a recipe.
--
-- A view and not a stored tsvector column: the text comes from three tables, a GENERATED column
-- can only see its own row, and a trigger on three tables is work without a win for a few
-- hundred recipes. CREATE OR REPLACE VIEW is idempotent by itself, which fits the deploy rule.
-- The weights A-D are the reason why a hit in the name beats a hit in the instructions:
-- A name, B tags and ingredients, C description, D steps.
CREATE OR REPLACE VIEW recipes_search AS
SELECT r.id,
       setweight(to_tsvector('german', r.name), 'A')
    || setweight(to_tsvector('german', array_to_string(r.tags, ' ')), 'B')
    || setweight(to_tsvector('german', coalesce(zutaten.names, '')), 'B')
    || setweight(to_tsvector('german', coalesce(r.description, '')), 'C')
    || setweight(to_tsvector('german', coalesce(schritte.texts, '')), 'D') AS document
FROM recipes r
LEFT JOIN (
    SELECT ri.recipe_id, string_agg(i.name || ' ' || coalesce(ri.note, ''), ' ') AS names
    FROM recipe_ingredients ri
    JOIN ingredients i ON i.id = ri.ingredient_id
    GROUP BY ri.recipe_id
) AS zutaten ON zutaten.recipe_id = r.id
LEFT JOIN (
    SELECT recipe_id, string_agg(text, ' ') AS texts
    FROM recipe_steps
    GROUP BY recipe_id
) AS schritte ON schritte.recipe_id = r.id;

-- Replaced on every run, like the rules of the setting definitions above: CREATE TABLE IF NOT
-- EXISTS does not change a table that is already there, so a new level of difficulty would never
-- reach the Pi. Dropping and adding the rule every time is what keeps it changeable.
ALTER TABLE recipes DROP CONSTRAINT IF EXISTS recipes_difficulty_check;
ALTER TABLE recipes ADD CONSTRAINT recipes_difficulty_check
    CHECK (difficulty IS NULL OR difficulty IN ('einfach', 'mittel', 'schwer'));
