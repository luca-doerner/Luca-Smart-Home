// the smart home page: navigation on the left, pages /rooms, /rooms/:id, /devices/:id
// und die Rezepte (/recipes, /recipes/:id, /recipes/new, /pantry) aus recipes.js / pantry.js
import { api, breadcrumb, cardGrid, el, errorBox, icon, plural, showPage } from "./lib.js";
import { renderFeature, settingsForm } from "./feature-panel.js";
import { renderRecipeEditPage, renderRecipePage, renderRecipesPage } from "./recipes.js";
import { renderPantryPage } from "./pantry.js";
import { renderAccountPage } from "./account.js";

const EXPANDED_KEY = "smarthome.expanded";
const DEVICE_POLL_MS = 5000;   // how often the dots of the feature tabs are updated
const sidebar = document.getElementById("sidebar");

/*************** Route ************************************************************************/
// key of a navigation entry: "rooms", "room:<id>", "device:<id>", "recipes", "pantry" or "account"
function currentRoute() {
    const [, page, id] = location.pathname.match(/^\/(rooms|devices|recipes|pantry|account)(?:\/(new|\d+))?$/) || [];
    if (page === "account")
        return { page: "account", key: "account" };
    if (page === "devices" && id)
        return { page: "device", id: Number(id), key: `device:${id}` };
    if (page === "rooms" && id)
        return { page: "room", id: Number(id), key: `room:${id}` };
    if (page === "pantry")
        return { page: "pantry", key: "pantry" };
    if (page === "recipes" && id === "new")
        return { page: "recipe-edit", id: null, key: "recipes" };
    if (page === "recipes" && id)
        // ?edit=1 zeigt dasselbe Rezept im Bearbeiten-Modus
        return new URLSearchParams(location.search).has("edit")
            ? { page: "recipe-edit", id: Number(id), key: "recipes" }
            : { page: "recipe", id: Number(id), key: "recipes" };
    if (page === "recipes")
        return { page: "recipes", key: "recipes" };
    return { page: "rooms", key: "rooms" };
}

const route = currentRoute();

/*************** Navigation *******************************************************************/
// which entries are expanded, remembered in this browser only
function loadExpanded() {
    try {
        return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY)) ?? ["rooms"]);
    } catch {
        return new Set(["rooms"]);
    }
}

function saveExpanded(expanded) {
    try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
    } catch {
        // private window or blocked storage: the navigation just forgets what was expanded
    }
}

function deviceEntry(device) {
    return { key: `device:${device.id}`, label: device.name, href: `/devices/${device.id}`,
        children: device.children.map(deviceEntry) };
}

// Die Navigation hat mehrere Wurzeln: die Zimmer mit ihrem Baum, dazu Rezepte und Vorrat.
// (Vorher war es genau eine Wurzel — Rezepte sind das erste, was kein Gerät ist.)
function navigationEntries(tree) {
    return [
        {
            key: "rooms", label: "Zimmer", href: "/rooms", icon: "home",
            children: tree.map((room) => ({
                key: `room:${room.id}`, label: room.name, href: `/rooms/${room.id}`,
                children: room.devices.map(deviceEntry),
            })),
        },
        { key: "recipes", label: "Rezepte", href: "/recipes", icon: "book", children: [] },
        { key: "pantry", label: "Vorrat", href: "/pantry", icon: "pantry", children: [] },
        { key: "account", label: "Konto", href: "/account", icon: "user", children: [] },
    ];
}

// keys from a top entry down to the entry with the key, null if it is in none of them
function pathTo(entries, key) {
    for (const entry of entries) {
        if (entry.key === key)
            return [entry.key];
        const path = pathTo(entry.children, key);
        if (path)
            return [entry.key, ...path];
    }
    return null;
}

// quick links to the pinned devices above the tree
function pinnedSection(pinned) {
    if (pinned.length === 0)
        return null;
    return el("section", { class: "nav-section", "aria-labelledby": "pinned-heading" },
        el("h2", { class: "nav-heading", id: "pinned-heading" }, icon("pin"), "Angeheftet"),
        el("ul", { class: "pinned-list" }, pinned.map((device) => el("li", {},
            el("a", {
                class: "tree-link", href: `/devices/${device.id}`, title: `${device.location} / ${device.name}`,
                "aria-current": route.key === `device:${device.id}` ? "page" : null,
            }, el("span", {}, device.name), el("span", { class: "tree-location" }, device.location))))));
}

// navigation: { rooms: tree, pinned: [devices] } from /api/navigation
function renderNavigation(navigation) {
    const expanded = loadExpanded();
    const roots = navigationEntries(navigation.rooms);
    // the current page and everything above it is always expanded
    for (const key of pathTo(roots, route.key) ?? [])
        expanded.add(key);
    saveExpanded(expanded);

    function entry(item, level) {
        const open = expanded.has(item.key);
        const children = item.children.length === 0 ? null
            : el("ul", { class: "tree-children", hidden: !open }, item.children.map((child) => entry(child, level + 1)));

        const toggle = children
            ? el("button", {
                class: "tree-toggle", type: "button", "aria-expanded": String(open),
                "aria-label": `${item.label} ${open ? "einklappen" : "ausklappen"}`,
                onclick() {
                    const nowOpen = children.hidden;
                    children.hidden = !nowOpen;
                    this.setAttribute("aria-expanded", String(nowOpen));
                    this.setAttribute("aria-label", `${item.label} ${nowOpen ? "einklappen" : "ausklappen"}`);
                    nowOpen ? expanded.add(item.key) : expanded.delete(item.key);
                    saveExpanded(expanded);
                },
            }, icon("chevron"))
            : el("span", { class: "tree-toggle-spacer" });

        const link = el("a", {
            class: "tree-link", href: item.href,
            "aria-current": item.key === route.key ? "page" : null,
            // clicking an entry also expands it
            onclick() {
                expanded.add(item.key);
                saveExpanded(expanded);
            },
        }, item.icon ? icon(item.icon) : null, el("span", {}, item.label));

        return el("li", {}, el("div", { class: "tree-row", style: `--level: ${level}` }, toggle, link), children);
    }

    sidebar.replaceChildren(...[pinnedSection(navigation.pinned),
        el("ul", { class: "tree" }, roots.map((root) => entry(root, 0)))]
        .filter((part) => part !== null));
}

async function refreshNavigation() {
    renderNavigation(await api("/api/navigation"));
}

// menu button on small screens
function setupMenu() {
    const button = document.getElementById("menu-toggle");
    const setOpen = (open) => {
        document.body.classList.toggle("menu-open", open);
        button.setAttribute("aria-expanded", String(open));
    };
    button.addEventListener("click", () => setOpen(!document.body.classList.contains("menu-open")));
    document.getElementById("backdrop").addEventListener("click", () => setOpen(false));
}

// name of the logged in user and the logout button in the top bar
async function setupUser() {
    document.getElementById("logout").addEventListener("click", async () => {
        try {
            await api("/api/logout", {});
        } finally {
            location.assign("/login");
        }
    });
    const { username } = await api("/api/me");
    document.getElementById("username").textContent = username;
}

/*************** Page Parts *******************************************************************/
// showPage, breadcrumb, cardGrid und plural stehen in lib.js, weil die Rezeptseiten sie auch
// brauchen (recipes.js, pantry.js)
function deviceCard(device) {
    const meta = [plural(device.child_count, "Untergerät", "Untergeräte"), plural(device.feature_count, "Feature", "Features")];
    return el("a", { class: "card link-card", href: `/devices/${device.id}` },
        el("h3", {}, device.name),
        device.type ? el("span", { class: "badge" }, device.type) : null,
        el("p", { class: "muted" }, meta.join(" · ")));
}

/*************** Pages ************************************************************************/
function renderRoomsPage({ rooms, pinned }) {
    document.title = "Zimmer · Smart Home";
    showPage(
        breadcrumb([{ label: "Zimmer" }]),
        el("h1", {}, "Zimmer"),
        ...(pinned.length === 0 ? [] : [
            el("h2", {}, "Angeheftet"),
            cardGrid(pinned.map((device) => el("a", { class: "card link-card", href: `/devices/${device.id}` },
                el("h3", {}, device.name),
                device.type ? el("span", { class: "badge" }, device.type) : null,
                el("p", { class: "muted" }, device.location))), ""),
            el("h2", {}, "Alle Zimmer"),
        ]),
        cardGrid(rooms.map((room) => el("a", { class: "card link-card", href: `/rooms/${room.id}` },
            el("h3", {}, room.name),
            el("p", { class: "muted" }, room.devices.length === 0
                ? "Keine Geräte"
                : `${plural(room.devices.length, "Gerät", "Geräte")}: ${room.devices.map((d) => d.name).join(", ")}`))),
        "Noch keine Zimmer angelegt."));
}

// room: from /api/rooms/:id
function renderRoomPage(room) {
    document.title = `${room.name} · Smart Home`;
    showPage(
        breadcrumb([{ label: "Zimmer", href: "/rooms" }, { label: room.name }]),
        el("h1", {}, room.name),
        el("h2", {}, "Geräte"),
        cardGrid(room.devices.map(deviceCard), "In diesem Zimmer sind noch keine Geräte."));
}

function pathLink(item) {
    return { label: item.name, href: item.kind === "room" ? `/rooms/${item.id}` : `/devices/${item.id}` };
}

// the feature shown first: ?feature=<id>, otherwise the started exclusive service, otherwise the first
function selectedFeature(features) {
    const id = Number(new URLSearchParams(location.search).get("feature"));
    return features.find((f) => f.id === id)
        ?? features.find((f) => f.kind === "service" && f.exclusive && f.active)
        ?? features[0];
}

// dot of a service: "on" = running, "failed" = started but the program does not run, "" = stopped
function serviceDot(feature) {
    if (feature.running)
        return { state: "on", text: "läuft" };
    if (feature.active)
        return { state: "failed", text: `gestartet, läuft aber nicht (${feature.message})` };
    return { state: "", text: "gestoppt" };
}

// services have a dot (serviceDot); a click shows the feature without loading the page again
// (onSelect), ctrl / middle click still opens the link in a new tab
function featureTabs(device, selected, onSelect) {
    return el("nav", { class: "tabs", "aria-label": "Features" },
        device.features.map((f) => el("a", {
            class: "tab", href: `/devices/${device.id}?feature=${f.id}`,
            "aria-current": f.id === selected.id ? "page" : null,
            title: f.kind === "service" ? `${f.name}: ${serviceDot(f).text}` : f.name,
            onclick(event) {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
                    return;
                event.preventDefault();
                if (f.id === selected.id)
                    return;
                history.pushState(null, "", this.href);
                onSelect(f.id);
            },
        },
        f.kind === "service" ? el("span", { class: `dot ${serviceDot(f).state}`, "aria-hidden": "true" }) : null,
        f.name)));
}

// button to pin the device in the navigation, errors are shown in the error box of the page
function pinButton(device, errors) {
    let pinned = device.pinned;
    const label = el("span");
    const button = el("button", { class: "button pin-button", type: "button" }, icon("pin"), label);
    const update = () => {
        button.setAttribute("aria-pressed", String(pinned));
        button.title = pinned ? "Nicht mehr in der Navigation anheften" : "Oben in der Navigation anheften";
        label.textContent = pinned ? "Angeheftet" : "Anheften";
    };
    button.addEventListener("click", async () => {
        button.disabled = true;
        try {
            ({ pinned } = await api(`/api/devices/${device.id}/pinned`, { pinned: !pinned }));
            update();
            errors.show("pin", "");
            await refreshNavigation();
        } catch (err) {
            errors.show("pin", `Anheften fehlgeschlagen: ${err.message}`);
        } finally {
            button.disabled = false;
        }
    });
    update();
    return button;
}

// settings of the device that all its programs get (null if it has none); saving restarts the
// running services of the device, onRestarted updates the dots of the feature tabs
function deviceSettingsForm(device, errors, onRestarted) {
    if (device.settings.length === 0)
        return null;
    return settingsForm(device.settings, {
        idPrefix: `device-setting-${device.id}`,
        save: (values) => api(`/api/devices/${device.id}/settings`, { values }),
        title: "Geräte-Einstellungen",
        description: ["Gelten für alle Features dieses Geräts, jedes Programm bekommt sie beim Start als ",
            el("code", {}, "--name=wert"), ". Beim Speichern werden laufende Dienste neu gestartet."],
        submitLabel: "Speichern",
        errors,
        onSaved(result, status) {
            status.textContent = result.restarted.length > 0
                ? `Gespeichert, neu gestartet: ${result.restarted.join(", ")}`
                : "Gespeichert";
            if (result.restarted.length > 0)
                onRestarted();
        },
    });
}

// device: from /api/devices/:id
async function renderDevicePage(device) {
    document.title = `${device.name} · Smart Home`;
    const parent = pathLink(device.parent);

    const tabsSlot = el("div");
    const panel = el("div", { class: "feature-panel" });
    const errors = errorBox();

    // which features stop each other
    const exclusive = device.features.filter((f) => f.kind === "service" && f.exclusive);
    const exclusiveOneshots = device.features.filter((f) => f.kind === "oneshot" && f.exclusive);
    const names = (list) => list.map((f) => f.name).join(", ");
    const exclusiveHints = [
        exclusive.length > 1 ? `Von ${names(exclusive)} kann immer nur einer laufen.` : null,
        exclusiveOneshots.length > 0 && exclusive.length > 0
            ? `${names(exclusiveOneshots)} ${exclusiveOneshots.length === 1 ? "stoppt" : "stoppen"} beim Ausführen ${names(exclusive)}.`
            : null,
    ].filter(Boolean);
    showPage(
        breadcrumb([{ label: "Zimmer", href: "/rooms" }, ...device.path.slice(0, -1).map(pathLink), { label: device.name }]),
        el("div", { class: "page-header" },
            el("div", {}, el("h1", {}, device.name), device.type ? el("span", { class: "badge" }, device.type) : null),
            el("div", { class: "header-actions" },
                pinButton(device, errors),
                el("a", { class: "button", href: parent.href }, icon("up"), `Zu ${parent.label}`))),
        errors.node,
        deviceSettingsForm(device, errors, () => onFeaturesChanged()),
        el("h2", {}, "Features"),
        tabsSlot,
        exclusiveHints.length > 0 ? el("p", { class: "muted hint" }, exclusiveHints.join(" ")) : null,
        panel,
        el("h2", {}, "Untergeräte"),
        cardGrid(device.children.map(deviceCard), "An diesem Gerät hängen keine weiteren Geräte."));

    if (device.features.length === 0) {
        tabsSlot.append(el("p", { class: "empty" }, "Dieses Gerät hat keine Features."));
        return;
    }

    let selected = selectedFeature(device.features);
    let cleanup = () => {};
    const showTabs = () => tabsSlot.replaceChildren(featureTabs(device, selected, showFeature));

    // after start / stop other exclusive services may have been stopped, and a program can fail
    // or crash at any time: update the dots when something changed
    const dots = () => JSON.stringify(device.features.map((f) => [f.id, f.active, f.running, f.message]));
    async function onFeaturesChanged() {
        const before = dots();
        device = await api(`/api/devices/${device.id}`);
        if (dots() !== before)
            showTabs();
    }
    setInterval(() => onFeaturesChanged().catch(() => {}), DEVICE_POLL_MS);

    // loads only the panel of the feature, the old panel stays (dimmed) until the new one is there
    async function showFeature(featureId) {
        selected = device.features.find((f) => f.id === featureId) ?? selected;
        showTabs();
        panel.classList.add("loading");
        try {
            const feature = await api(`/api/features/${selected.id}`);
            if (feature.id !== selected.id)   // another tab was clicked in the meantime
                return;
            cleanup();
            panel.replaceChildren();
            cleanup = renderFeature(panel, feature, { onFeaturesChanged });
            errors.show("feature", "");
        } catch (err) {
            errors.show("feature", `Feature konnte nicht geladen werden: ${err.message}`);
        } finally {
            panel.classList.remove("loading");
        }
    }

    // back / forward between features of this device
    window.addEventListener("popstate", () => showFeature(selectedFeature(device.features).id));
    await showFeature(selected.id);
}

/*************** Start ************************************************************************/
async function init() {
    setupMenu();
    setupUser().catch(() => {});
    try {
        // the data of the page is loaded at the same time as the navigation
        const pageData = route.page === "device" ? api(`/api/devices/${route.id}`)
            : route.page === "room" ? api(`/api/rooms/${route.id}`)
            : null;
        pageData?.catch(() => {});   // the error is shown below, not as unhandled rejection

        const navigation = await api("/api/navigation");
        renderNavigation(navigation);
        if (route.page === "rooms")
            renderRoomsPage(navigation);
        else if (route.page === "room")
            renderRoomPage(await pageData);
        else if (route.page === "device")
            await renderDevicePage(await pageData);
        // die Rezeptseiten holen sich ihre Daten selbst, sie haben mehrere Quellen
        else if (route.page === "recipes")
            await renderRecipesPage();
        else if (route.page === "recipe")
            await renderRecipePage(route.id);
        else if (route.page === "recipe-edit")
            await renderRecipeEditPage(route.id);
        else if (route.page === "pantry")
            await renderPantryPage();
        else if (route.page === "account")
            await renderAccountPage();
    } catch (err) {
        const errors = errorBox();
        errors.show("page", `Seite konnte nicht geladen werden: ${err.message}`);
        const home = route.key === "rooms" ? { label: "Zimmer", href: "/rooms" }
            : route.key === "account" ? { label: "Konto", href: "/account" }
            : { label: "Rezepte", href: "/recipes" };
        showPage(breadcrumb([home, { label: "Fehler" }]), errors.node);
    }
}

init();
