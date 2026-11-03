// Rooms, devices (nested), features and their settings from the database (Database/schema.sql).
const db = require("./db");
const HttpError = require("./http-error");

// rooms with all their devices as a tree, for the navigation:
// [{ id, name, devices: [{ id, name, type, children: [...] }] }]
async function getTree() {
    const { rows: rooms } = await db.query("SELECT id, name FROM rooms ORDER BY name");
    const { rows: devices } = await db.query(
        "SELECT id, name, type, room_id, parent_device_id FROM devices ORDER BY name");

    const nodes = new Map(devices.map((d) => [d.id, { id: d.id, name: d.name, type: d.type, children: [] }]));
    const roomNodes = new Map(rooms.map((r) => [r.id, { id: r.id, name: r.name, devices: [] }]));
    for (const d of devices) {
        if (d.room_id !== null)
            roomNodes.get(d.room_id).devices.push(nodes.get(d.id));
        else
            nodes.get(d.parent_device_id).children.push(nodes.get(d.id));
    }
    return [...roomNodes.values()];
}

// the devices this user pinned, in the order they were pinned (device_pins: the devices are
// shared, the pins are per user), location: room / parent devices, e.g. "Wohnzimmer / Fernseher"
async function getPinned(userId) {
    const { rows } = await db.query(`
        SELECT v.id, v.name, v.type, COALESCE(p.path, r.name) AS location
        FROM device_pins pin
        JOIN devices_with_room v ON v.id = pin.device_id
        JOIN devices d ON d.id = v.id
        LEFT JOIN devices_with_room p ON p.id = v.parent_device_id
        LEFT JOIN rooms r ON r.id = d.room_id
        WHERE pin.user_id = $1
        ORDER BY pin.pinned_at`, [userId]);
    return rows;
}

// pinning again keeps the old pinned_at (ON CONFLICT DO NOTHING), so the order does not change
async function setDevicePinned(userId, id, pinned) {
    const { rows: [device] } = await db.query("SELECT id FROM devices WHERE id = $1", [id]);
    if (!device)
        throw new HttpError(404, "Gerät nicht gefunden");
    if (pinned)
        await db.query(`
            INSERT INTO device_pins (user_id, device_id) VALUES ($1, $2)
            ON CONFLICT DO NOTHING`, [userId, id]);
    else
        await db.query("DELETE FROM device_pins WHERE user_id = $1 AND device_id = $2", [userId, id]);
    return pinned;
}

// the devices directly in a room or directly plugged into a device, with counts for the cards
async function listDevices(column, id) {
    const { rows } = await db.query(`
        SELECT d.id, d.name, d.type,
               (SELECT count(*)::int FROM devices c WHERE c.parent_device_id = d.id) AS child_count,
               (SELECT count(*)::int FROM features f WHERE f.device_id = d.id) AS feature_count
        FROM devices d
        WHERE d.${column} = $1
        ORDER BY d.name`, [id]);
    return rows;
}

async function getRoom(id) {
    const { rows: [room] } = await db.query("SELECT id, name FROM rooms WHERE id = $1", [id]);
    if (!room)
        throw new HttpError(404, "Zimmer nicht gefunden");
    return { ...room, devices: await listDevices("room_id", id) };
}

// device with its path from the room ([room, device, ..., this device]), its parent,
// its child devices and its features; pinned is about the user who asks
async function getDevice(id, userId) {
    const { rows: chain } = await db.query(`
        WITH RECURSIVE up AS (
            SELECT id, name, type, room_id, parent_device_id, 0 AS depth FROM devices WHERE id = $1
            UNION ALL
            SELECT d.id, d.name, d.type, d.room_id, d.parent_device_id, up.depth + 1
            FROM devices d JOIN up ON d.id = up.parent_device_id
        )
        SELECT up.*, r.name AS room_name FROM up LEFT JOIN rooms r ON r.id = up.room_id
        ORDER BY depth DESC`, [id]);
    if (chain.length === 0)
        throw new HttpError(404, "Gerät nicht gefunden");

    const top = chain[0];   // the device that is directly in the room
    const device = chain[chain.length - 1];
    const path = [
        { kind: "room", id: top.room_id, name: top.room_name },
        ...chain.map((d) => ({ kind: "device", id: d.id, name: d.name })),
    ];
    const { rows: features } = await db.query(
        "SELECT id, type, name, kind, exclusive, active FROM features WHERE device_id = $1 ORDER BY id", [id]);
    const { rowCount: pinned } = await db.query(
        "SELECT 1 FROM device_pins WHERE user_id = $1 AND device_id = $2", [userId, id]);

    return {
        id: device.id,
        name: device.name,
        type: device.type,
        pinned: pinned > 0,
        settings: await loadSettings("device", id),
        path,
        parent: path[path.length - 2],
        children: await listDevices("parent_device_id", id),
        features,
    };
}

/*************** Settings *********************************************************************/
// select options as [{ value, label }], also written as plain values ["HDMI 1", "HDMI 2"]
function selectOptions(options) {
    return (options ?? []).map((option) => option !== null && typeof option === "object"
        ? { value: option.value, label: String(option.label ?? option.value) }
        : { value: option, label: String(option) });
}

// decimals of a step, e.g. 0.05 -> 2, used to remove float noise like 0.30000000000000004
function decimals(step) {
    const text = String(step);
    return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

// the four sides of a "screen" setting, in the order the page shows them
const SCREEN_SIDES = ["top", "left", "right", "bottom"];

// number against min / max / step of the definition, fail(message) reports the problem
function validateNumber(definition, value, fail) {
    if (typeof value !== "number" || !Number.isFinite(value))
        fail("muss eine Zahl sein");
    if (definition.min !== null && value < definition.min)
        fail(`muss mindestens ${definition.min} sein`);
    if (definition.max !== null && value > definition.max)
        fail(`darf höchstens ${definition.max} sein`);
    const step = definition.step ?? 1;
    const steps = (value - (definition.min ?? 0)) / step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9)
        fail(step === 1 ? "muss eine ganze Zahl sein" : `muss in Schritten von ${step} sein`);
    return Number((Math.round(steps) * step + (definition.min ?? 0)).toFixed(decimals(step)));
}

// checks a value against its definition (setting_definitions), returns the normalized value
// or throws an HttpError with a message for the page
function validateValue(definition, value) {
    const fail = (message) => {
        throw new HttpError(400, `${definition.label}: ${message}`);
    };
    switch (definition.type) {
        case "range":
        case "number":
            return validateNumber(definition, value, fail);
        case "screen": {
            if (value === null || typeof value !== "object" || Array.isArray(value))
                fail(`braucht die vier Seiten (${SCREEN_SIDES.join(", ")})`);
            const unknown = Object.keys(value).find((side) => !SCREEN_SIDES.includes(side));
            if (unknown)
                fail(`unbekannte Seite: ${unknown}`);
            const sides = {};
            for (const side of SCREEN_SIDES) {
                if (!Object.hasOwn(value, side))
                    fail(`${side} fehlt`);
                sides[side] = validateNumber(definition, value[side], (message) => fail(`${side} ${message}`));
            }
            return sides;
        }
        case "boolean":
            if (typeof value !== "boolean")
                fail("muss an oder aus sein");
            return value;
        case "text":
            if (typeof value !== "string")
                fail("muss ein Text sein");
            if (value.length > 1000 || /[\r\n]/.test(value))
                fail("darf höchstens 1000 Zeichen und keine Zeilenumbrüche haben");
            return value;
        case "select":
        case "button_select": {
            const option = selectOptions(definition.options).find((o) => JSON.stringify(o.value) === JSON.stringify(value));
            if (!option)
                fail("ist keine der möglichen Auswahlen");
            return option.value;
        }
        case "color":
            if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))
                fail("muss eine Farbe wie #ff8800 sein");
            return value.toLowerCase();
        case "color_list": {
            // mehrere Farben in ihrer Reihenfolge; min / max begrenzen die Anzahl
            if (!Array.isArray(value))
                fail("muss eine Liste von Farben sein");
            const least = definition.min ?? 0;
            const most = definition.max ?? 50;
            if (value.length < least)
                fail(`braucht mindestens ${least} Farbe(n)`);
            if (value.length > most)
                fail(`darf höchstens ${most} Farbe(n) haben`);
            return value.map((color, index) => {
                if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))
                    fail(`Farbe ${index + 1} muss wie #ff8800 aussehen`);
                return color.toLowerCase();
            });
        }
        default:
            return fail(`unbekannter Typ ${definition.type}`);
    }
}

// the settings of a feature or a device: tables and extra columns (fixed names, never from a request)
const SETTING_TABLES = {
    feature: { definitions: "setting_definitions", values: "settings", key: "feature_id", extra: ", d.restart_required" },
    device: { definitions: "device_setting_definitions", values: "device_settings", key: "device_id", extra: "" },
};

// setting definitions with their current values, owner: "feature" or "device":
// [{ name, label, type, min, max, step, unit, options, section, (restart_required,) value }]
async function loadSettings(owner, id) {
    const t = SETTING_TABLES[owner];
    const { rows } = await db.query(`
        SELECT d.name, d.label, d.type, d.min, d.max, d.step, d.unit, d.options, d.section${t.extra},
               d.default_value, s.value
        FROM ${t.definitions} d
        LEFT JOIN ${t.values} s ON s.${t.key} = d.${t.key} AND s.name = d.name
        WHERE d.${t.key} = $1
        ORDER BY d.sort_order, d.name`, [id]);

    return rows.map(({ default_value: defaultValue, value, ...definition }) => {
        // a saved value that does not fit a changed definition anymore falls back to the default
        let current = defaultValue;
        if (value !== null) {
            try {
                current = validateValue(definition, value);
            } catch {
                // keep the default
            }
        }
        const hasOptions = definition.type === "select" || definition.type === "button_select";
        const options = hasOptions ? selectOptions(definition.options) : null;
        return { ...definition, options, value: current };
    });
}

// values: { name: normalized value }, see validateValue
async function saveSettingValues(owner, id, values) {
    const t = SETTING_TABLES[owner];
    await db.query(`
        INSERT INTO ${t.values} (${t.key}, name, value)
        SELECT $1, name, value FROM jsonb_each($2::jsonb) AS v (name, value)
        ON CONFLICT (${t.key}, name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [id, JSON.stringify(values)]);
}

// checks values from a request against the definitions ([{ name, ... }]), returns the normalized ones
function validateValues(definitions, values) {
    if (values === null || typeof values !== "object" || Array.isArray(values))
        throw new HttpError(400, "values muss ein Objekt sein");
    const byName = new Map(definitions.map((definition) => [definition.name, definition]));
    const normalized = {};
    for (const [name, value] of Object.entries(values)) {
        const definition = byName.get(name);
        if (!definition)
            throw new HttpError(400, `Unbekannte Einstellung: ${name}`);
        normalized[name] = validateValue(definition, value);
    }
    return normalized;
}

// feature with its setting definitions and current values:
// { id, device_id, type, name, kind, executable, udp_port, exclusive, active,
//   settings: [{ name, label, type, min, max, step, unit, options, section, restart_required, value }] }
async function getFeature(id) {
    const { rows: [feature] } = await db.query(`
        SELECT id, device_id, type, name, kind, executable, udp_port, exclusive, active
        FROM features WHERE id = $1`, [id]);
    if (!feature)
        throw new HttpError(404, "Feature nicht gefunden");
    feature.settings = await loadSettings("feature", id);
    return feature;
}

// device settings (loadSettings) and the services of the device, for applying device settings
async function getDeviceSettings(deviceId) {
    const { rows: [device] } = await db.query("SELECT id FROM devices WHERE id = $1", [deviceId]);
    if (!device)
        throw new HttpError(404, "Gerät nicht gefunden");
    const { rows: services } = await db.query(
        "SELECT id, name FROM features WHERE device_id = $1 AND kind = 'service' ORDER BY id", [deviceId]);
    return { settings: await loadSettings("device", deviceId), services };
}

// services that were started before the server stopped
async function activeServices() {
    const { rows } = await db.query("SELECT id FROM features WHERE kind = 'service' AND active ORDER BY id");
    return rows.map((row) => row.id);
}

/*************** Start / Stop *****************************************************************/
// starts or stops a service; starting an exclusive service stops the other exclusive services of
// the device. onChange(featureId, active) is called after the change is saved, stopped features
// first (e.g. stop ambilight before static_color starts)
async function setFeatureActive(id, active, onChange) {
    const client = await db.connect();
    let changes;
    try {
        await client.query("BEGIN");
        const { rows: [feature] } = await client.query(
            "SELECT id, device_id, kind, exclusive FROM features WHERE id = $1 FOR UPDATE", [id]);
        if (!feature)
            throw new HttpError(404, "Feature nicht gefunden");
        if (feature.kind !== "service")
            throw new HttpError(400, "Nur Dienste (kind = service) können gestartet und gestoppt werden");

        // locks the exclusive services of the device, so two requests cannot start two of them
        const { rows: before } = await client.query(`
            SELECT id, active FROM features
            WHERE id = $1 OR (device_id = $2 AND kind = 'service' AND exclusive AND $3::boolean)
            ORDER BY id FOR UPDATE`, [id, feature.device_id, feature.exclusive]);

        // stop the others first, otherwise the unique index sees two active features
        if (active && feature.exclusive)
            await client.query(`
                UPDATE features SET active = false
                WHERE device_id = $1 AND kind = 'service' AND exclusive AND active AND id <> $2`,
                [feature.device_id, id]);
        await client.query("UPDATE features SET active = $2 WHERE id = $1", [id, active]);
        await client.query("COMMIT");

        // the feature itself is always passed on: "start" again also starts a service that is
        // active but crashed, "stop" also stops a program that still runs
        const after = (f) => f.id === id ? active : (active && feature.exclusive ? false : f.active);
        changes = before
            .filter((f) => f.id === id || after(f) !== f.active)
            .map((f) => ({ id: f.id, active: after(f) }))
            .sort((a, b) => a.active - b.active);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    for (const change of changes)
        await onChange(change.id, change.active);
    return changes;
}

// the exclusive oneshots of a device except one feature, e.g. a "static color" that should be
// switched off when an exclusive service takes over the device
async function exclusiveOneshots(deviceId, exceptId) {
    const { rows } = await db.query(`
        SELECT id, name FROM features
        WHERE device_id = $1 AND kind = 'oneshot' AND exclusive AND id <> $2
        ORDER BY id`, [deviceId, exceptId]);
    return rows;
}

// marks the exclusive services of the device except one feature as stopped, so they do not start
// again with the server; returns them as [{ id, name, active }] (active: before the change)
async function stopExclusiveServices(deviceId, exceptId) {
    const { rows } = await db.query(`
        WITH before AS (
            SELECT id, name, active FROM features
            WHERE device_id = $1 AND kind = 'service' AND exclusive AND id <> $2
            FOR UPDATE
        )
        UPDATE features f SET active = false
        FROM before b WHERE f.id = b.id
        RETURNING b.id, b.name, b.active`, [deviceId, exceptId]);
    return rows;
}

module.exports = {
    getTree, getPinned, setDevicePinned, getRoom, getDevice,
    SCREEN_SIDES,
    getFeature, getDeviceSettings, loadSettings, validateValues, saveSettingValues,
    activeServices, setFeatureActive, exclusiveOneshots, stopExclusiveServices,
};
