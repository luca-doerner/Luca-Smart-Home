// helpers shared by the pages and the feature panels

// GET (without body) or POST (with body) to the API, throws an Error with the message of the server.
// Ein Blob (das Rezeptbild) geht als rohe Bytes mit seinem eigenen Content-Type raus — sonst
// müsste der Bild-Upload an api() vorbei und die Behandlung von 401 doppelt dastehen.
export async function api(url, body) {
    const options = body === undefined ? {}
        : body instanceof Blob ? { method: "POST", headers: { "Content-Type": body.type }, body }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(url, options);
    // the session ran out or was ended: log in again and come back to this page
    if (res.status === 401) {
        location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
        throw new Error("Nicht angemeldet");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(data.error || res.statusText);
    return data;
}

// creates an element; props: attributes, "class", and "on<event>" listeners;
// children: elements or strings (always inserted as text, never as HTML)
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false)
            continue;
        if (key === "class")
            node.className = value;
        else if (key.startsWith("on"))
            node.addEventListener(key.slice(2), value);
        else
            node.setAttribute(key, value === true ? "" : value);
    }
    node.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
    return node;
}

export function icon(name) {
    const paths = {
        chevron: "M9 6l6 6-6 6",
        home: "M3 11l9-7 9 7M5 10v10h14V10",
        up: "M12 19V5M5 12l7-7 7 7",
        pin: "M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76"
            + "a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
        // Rezepte und Vorrat
        book: "M12 6v14M12 6C10 4.5 7 4 4 4v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2",
        pantry: "M5 8h14v12H5zM5 8l2-4h10l2 4M10 12h4",
        user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-4 3.6-6 8-6s8 2 8 6",
        plus: "M12 5v14M5 12h14",
        trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
        pencil: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
        cart: "M3 4h2l2.5 11h10L20 7H6M9.5 19.5a1 1 0 1 0 0-.1zM16.5 19.5a1 1 0 1 0 0-.1z",
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", `icon icon-${name}`);
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[name]);
    svg.append(path);
    return svg;
}

// calls fn at most every ms milliseconds, always with the latest arguments
export function throttle(fn, ms) {
    let timer = null;
    let lastArgs;
    return (...args) => {
        lastArgs = args;
        if (!timer)
            timer = setTimeout(() => {
                timer = null;
                fn(...lastArgs);
            }, ms);
    };
}

/*************** Seitenteile ******************************************************************/
// Die drei Teile, die jede Seite benutzt. Sie stehen hier und nicht in app.js, damit
// recipes.js und pantry.js sie importieren können, ohne dass sich app.js und die Seiten
// gegenseitig importieren (das ginge, wäre aber unnötig verschränkt).

// replaces the content of the page, empty parts (null) are left out
export function showPage(...parts) {
    document.getElementById("main").replaceChildren(...parts.flat(Infinity).filter((part) => part !== null && part !== undefined));
}

// items: [{ label, href }], the last one is the current page (no link)
export function breadcrumb(items) {
    return el("nav", { class: "breadcrumb", "aria-label": "Pfad" },
        el("ol", {}, items.map((item, i) => el("li", {},
            i < items.length - 1
                ? el("a", { href: item.href }, item.label)
                : el("span", { "aria-current": "page" }, item.label)))));
}

export function cardGrid(cards, emptyText) {
    return cards.length > 0 ? el("div", { class: "card-grid" }, cards) : el("p", { class: "empty" }, emptyText);
}

export function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}

// error box that collects one message per source ("power", a setting name, ...)
export function errorBox() {
    const errors = new Map();
    const node = el("p", { class: "error", role: "alert", hidden: true });
    return {
        node,
        // sets or clears (empty message) the error of one source
        show(source, message) {
            if (message)
                errors.set(source, message);
            else
                errors.delete(source);
            node.textContent = [...errors.values()].join("\n");
            node.hidden = errors.size === 0;
        },
    };
}
