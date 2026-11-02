-- Start data: Wohnzimmer -> Fernseher -> Ambilight LEDs -> feature "ambilight"
--
-- Only runs while there is no ambilight feature yet, so renaming or moving the entries
-- later is fine, they are not created again on the next deploy.
DO $$
DECLARE
    v_room_id BIGINT;
    v_tv_id   BIGINT;
    v_leds_id BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM features WHERE type = 'ambilight') THEN
        RETURN;
    END IF;

    INSERT INTO rooms (name) VALUES ('Wohnzimmer')
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id INTO v_room_id;

    INSERT INTO devices (room_id, name, type) VALUES (v_room_id, 'Fernseher', 'tv')
        ON CONFLICT ON CONSTRAINT devices_unique_name DO UPDATE SET type = EXCLUDED.type
        RETURNING id INTO v_tv_id;

    INSERT INTO devices (parent_device_id, name, type) VALUES (v_tv_id, 'Ambilight LEDs', 'led_strip')
        ON CONFLICT ON CONSTRAINT devices_unique_name DO UPDATE SET type = EXCLUDED.type
        RETURNING id INTO v_leds_id;

    INSERT INTO features (device_id, type, name, kind, executable, udp_port, exclusive)
        VALUES (v_leds_id, 'ambilight', 'Ambilight', 'service', 'C/ambilight', 9000, true);
END
$$;

-- The settings of ambilight.c for every ambilight feature that has no setting definitions yet
-- (new databases and databases from before setting_definitions existed). Definitions that were
-- changed later are kept.
INSERT INTO setting_definitions
    (feature_id, name, label, type, default_value, min, max, step, unit, section, sort_order)
SELECT f.id, d.name, d.label, d.type, d.default_value, d.min, d.max, 1, d.unit, d.section, d.sort_order
FROM features f
CROSS JOIN (VALUES
    ('brightness',      'Helligkeit',  'range',  '70'::jsonb, 0, 100, '%', 'Farbe',                10),
    ('smooth_ratio',    'Glättung',    'range',  '85',        0, 100, '%', 'Farbe',                20),
    ('dark_gamma',      'Dark Gamma',  'range',  '20',        0, 100, '%', 'Farbe',                30),
    ('resize_size',     'Resize Size', 'number', '18',        1, 100, NULL, 'Abtastung',           40),
    ('distance_top',    'Oben',        'number', '1',         0, 100, NULL, 'Abstand zum Bildrand', 50),
    ('distance_left',   'Links',       'number', '1',         0, 100, NULL, 'Abstand zum Bildrand', 60),
    ('distance_right',  'Rechts',      'number', '1',         0, 100, NULL, 'Abstand zum Bildrand', 70),
    ('distance_bottom', 'Unten',       'number', '1',         0, 100, NULL, 'Abstand zum Bildrand', 80)
) AS d (name, label, type, default_value, min, max, unit, section, sort_order)
WHERE f.type = 'ambilight'
  AND NOT EXISTS (SELECT 1 FROM setting_definitions s WHERE s.feature_id = f.id);

-- Modus "color_flow": schiebt die Farben der Liste nacheinander vorne in den Streifen, sie
-- wandern dann wie ein Lauflicht nach hinten (C/color_flow).
-- Wird nur angelegt, solange es noch kein color_flow-Feature gibt, am selben Gerät wie ambilight.
-- Exklusiv wie ambilight, dadurch läuft immer nur eines von beidem und beide können Port 9000 nutzen.
DO $$
DECLARE
    v_device_id  BIGINT;
    v_feature_id BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM features WHERE type = 'color_flow') THEN
        RETURN;
    END IF;
    SELECT device_id INTO v_device_id FROM features WHERE type = 'ambilight' ORDER BY id LIMIT 1;
    IF v_device_id IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO features (device_id, type, name, kind, executable, udp_port, exclusive)
        VALUES (v_device_id, 'color_flow', 'Color Flow', 'service', 'C/color_flow', 9000, true)
        RETURNING id INTO v_feature_id;

    INSERT INTO setting_definitions
        (feature_id, name, label, type, default_value, min, max, step, unit, section, sort_order)
    VALUES
        (v_feature_id, 'colors', 'Farben', 'color_list',
         '["#ff0000", "#00ff00", "#0000ff"]', 1, 20, NULL, NULL, NULL, 10),
        (v_feature_id, 'speed', 'Schritt alle', 'number', '1000', 20, 60000, 10, 'ms', NULL, 20),
        (v_feature_id, 'brightness', 'Helligkeit', 'range', '70', 0, 100, 1, '%', NULL, 30);
END
$$;

-- Settings that came later: they are added to every ambilight feature that does not have them
-- yet, also in databases that already had the settings above. A setting that was deleted on
-- purpose comes back with the next deploy, so delete the feature instead if you do not want it.
INSERT INTO setting_definitions
    (feature_id, name, label, type, default_value, min, max, step, unit, section, sort_order)
SELECT f.id, d.name, d.label, 'range', d.default_value, 0, 100, 1, '%', 'Farbstärke', d.sort_order
FROM features f
CROSS JOIN (VALUES
    ('strength_red',   'Rot',  '100'::jsonb, 110),
    ('strength_green', 'Grün', '100',        120),
    ('strength_blue',  'Blau', '100',        130)
) AS d (name, label, default_value, sort_order)
WHERE f.type = 'ambilight'
  AND NOT EXISTS (SELECT 1 FROM setting_definitions s WHERE s.feature_id = f.id AND s.name = d.name);

-- ############################################################################################
-- Recipes: a small basic pantry and two example recipes
-- ############################################################################################

-- The things that are simply always there. Own guard: without it the basic pantry would never
-- arrive once there is already a recipe, because the guard of the recipes below would return
-- first. ON CONFLICT ... DO UPDATE SET name = ingredients.name writes nothing (it keeps the
-- spelling that is in the table) and is only there so that RETURNING hands out the id.
DO $$
DECLARE
    v_ingredient_id BIGINT;
    v_basic         TEXT[];
BEGIN
    IF EXISTS (SELECT 1 FROM pantry_items) THEN
        RETURN;
    END IF;

    FOREACH v_basic SLICE 1 IN ARRAY ARRAY[
        ['Salz',      'Gewürze',   'TL'],
        ['Pfeffer',   'Gewürze',   'TL'],
        ['Olivenöl',  'Öl & Fett', 'EL'],
        ['Mehl',      'Backen',    'g'],
        ['Zucker',    'Backen',    'g']
    ] LOOP
        INSERT INTO ingredients (name, category, default_unit)
            VALUES (v_basic[1], v_basic[2], v_basic[3])
            ON CONFLICT (lower(name)) DO UPDATE SET name = ingredients.name
            RETURNING id INTO v_ingredient_id;

        INSERT INTO pantry_items (ingredient_id, always_available)
            VALUES (v_ingredient_id, true)
            ON CONFLICT (ingredient_id) DO NOTHING;
    END LOOP;
END
$$;

-- Two example recipes, so the page and the MCP tools have something to show. Only run while
-- there is no recipe at all, same guard idea as the ambilight feature above: renaming, changing
-- or deleting them on the Pi stays, they are not created again on the next deploy.
--
-- The ingredients are written into the catalogue by name first (only the ones that are missing),
-- then recipe_ingredients is filled from a VALUES list that is joined to the catalogue over
-- lower(name) - exactly what recipes.js does later when a recipe is saved through the API.
DO $$
DECLARE
    v_recipe_id BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM recipes) THEN
        RETURN;
    END IF;

    INSERT INTO ingredients (name, category, default_unit)
    SELECT d.name, d.category, d.default_unit
    FROM (VALUES
        ('Hackfleisch',        'Fleisch',     'g'),
        ('Zwiebel',            'Gemüse',      NULL),
        ('Knoblauchzehe',      'Gemüse',      NULL),
        ('Karotte',            'Gemüse',      NULL),
        ('Passierte Tomaten',  'Konserven',   'g'),
        ('Tomatenmark',        'Konserven',   'EL'),
        ('Lasagneplatten',     'Nudeln',      NULL),
        ('Butter',             'Milchprodukte', 'g'),
        ('Milch',              'Milchprodukte', 'ml'),
        ('Parmesan',           'Milchprodukte', 'g'),
        ('Oregano',            'Gewürze',     'TL'),
        ('Ei',                 'Milchprodukte', NULL),
        ('Mineralwasser',      'Getränke',    'ml')
    ) AS d (name, category, default_unit)
    WHERE NOT EXISTS (SELECT 1 FROM ingredients i WHERE lower(i.name) = lower(d.name));

    /* ---- Lasagne ---- */
    INSERT INTO recipes (name, description, servings, prep_minutes, cook_minutes, difficulty, tags, notes)
    VALUES ('Lasagne',
            'Klassische Lasagne mit Hackfleischsoße und Béchamel.',
            4, 30, 45, 'mittel',
            ARRAY['Hauptgericht', 'Nudeln', 'Ofen'],
            'Vor dem Schneiden zehn Minuten ruhen lassen, dann fällt sie nicht auseinander.')
    RETURNING id INTO v_recipe_id;

    INSERT INTO recipe_ingredients (recipe_id, position, ingredient_id, amount, unit, note, group_label, optional)
    SELECT v_recipe_id, d.position, i.id, d.amount, d.unit, d.note, d.group_label, d.optional
    FROM (VALUES
        (1,  'Hackfleisch',       500::double precision, 'g'::text,  NULL::text,         'Für die Soße'::text,     false),
        (2,  'Zwiebel',           1,                     NULL,       'fein gewürfelt',   'Für die Soße',           false),
        (3,  'Knoblauchzehe',     2,                     NULL,       NULL,               'Für die Soße',           false),
        (4,  'Karotte',           1,                     NULL,       'fein gewürfelt',   'Für die Soße',           false),
        (5,  'Passierte Tomaten', 700,                   'g',        NULL,               'Für die Soße',           false),
        (6,  'Tomatenmark',       2,                     'EL',       NULL,               'Für die Soße',           false),
        (7,  'Oregano',           1,                     'TL',       NULL,               'Für die Soße',           false),
        (8,  'Salz',              1,                     'TL',       NULL,               'Für die Soße',           false),
        (9,  'Pfeffer',           1,                     'TL',       NULL,               'Für die Soße',           false),
        (10, 'Butter',            50,                    'g',        NULL,               'Für die Béchamel',       false),
        (11, 'Mehl',              50,                    'g',        NULL,               'Für die Béchamel',       false),
        (12, 'Milch',             600,                   'ml',       NULL,               'Für die Béchamel',       false),
        (13, 'Lasagneplatten',    12,                    NULL,       NULL,               'Zum Schichten',          false),
        (14, 'Parmesan',          80,                    'g',        'frisch gerieben',  'Zum Schichten',          true)
    ) AS d (position, name, amount, unit, note, group_label, optional)
    JOIN ingredients i ON lower(i.name) = lower(d.name);

    INSERT INTO recipe_steps (recipe_id, position, text, minutes)
    VALUES
        (v_recipe_id, 1, 'Zwiebel, Knoblauch und Karotte fein würfeln und in etwas Olivenöl anbraten.', 5),
        (v_recipe_id, 2, 'Hackfleisch dazugeben und krümelig braten, Tomatenmark kurz mitrösten.', 8),
        (v_recipe_id, 3, 'Passierte Tomaten dazu, mit Salz, Pfeffer und Oregano würzen und 20 Minuten köcheln lassen.', 20),
        (v_recipe_id, 4, 'Für die Béchamel Butter schmelzen, Mehl einrühren und mit der Milch glatt rühren, kurz aufkochen.', 8),
        (v_recipe_id, 5, 'Abwechselnd Soße, Platten und Béchamel schichten, oben mit Béchamel und Parmesan abschließen.', 10),
        (v_recipe_id, 6, 'Bei 180 °C Ober-/Unterhitze 45 Minuten backen, dann zehn Minuten ruhen lassen.', 45);

    /* ---- Pfannkuchen ---- */
    INSERT INTO recipes (name, description, servings, prep_minutes, cook_minutes, difficulty, tags, notes)
    VALUES ('Pfannkuchen',
            'Dünne Pfannkuchen aus vier Zutaten, süß oder salzig.',
            2, 10, 15, 'einfach',
            ARRAY['Hauptgericht', 'vegetarisch', 'süß'],
            'Den Teig zehn Minuten stehen lassen, dann quillt das Mehl und die Pfannkuchen reißen nicht.')
    RETURNING id INTO v_recipe_id;

    INSERT INTO recipe_ingredients (recipe_id, position, ingredient_id, amount, unit, note, group_label, optional)
    SELECT v_recipe_id, d.position, i.id, d.amount, d.unit, d.note, NULL, false
    FROM (VALUES
        (1, 'Mehl',          200::double precision, 'g'::text,  NULL::text),
        (2, 'Milch',         300,                   'ml',       NULL),
        (3, 'Ei',            3,                     NULL,       NULL),
        (4, 'Salz',          1,                     'TL',       'gestrichen'),
        (5, 'Zucker',        1,                     'EL',       NULL),
        (6, 'Mineralwasser', 50,                    'ml',       'macht den Teig luftiger'),
        (7, 'Butter',        NULL,                  NULL,       'zum Braten')
    ) AS d (position, name, amount, unit, note)
    JOIN ingredients i ON lower(i.name) = lower(d.name);

    INSERT INTO recipe_steps (recipe_id, position, text, minutes)
    VALUES
        (v_recipe_id, 1, 'Mehl, Milch, Eier, Salz und Zucker glatt rühren, zum Schluss das Mineralwasser unterrühren.', 5),
        (v_recipe_id, 2, 'Den Teig zehn Minuten ruhen lassen.', 10),
        (v_recipe_id, 3, 'In einer Pfanne etwas Butter zerlaufen lassen und die Pfannkuchen von beiden Seiten goldbraun backen.', 15);
END
$$;
