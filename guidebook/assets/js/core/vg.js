/* Velexis Guidebook: namespace, DOM helpers, storage, events, clipboard, colours and icons. */
(function () {
  "use strict";
  const VG = (window.VG = window.VG || {});
  VG.version = "1.0.0";

  /* ---------------------------------------------------------------- DOM */

  /**
   * Creates an element: h("a", { href: "#/", class: "x", onclick: fn, dataset: { id: 1 } }, "text", child).
   * Strings become text nodes (never HTML); null/false children are skipped; arrays are flattened.
   */
  function h(tag, attrs, ...children) {
    const el = tag.startsWith("svg:")
      ? document.createElementNS("http://www.w3.org/2000/svg", tag.slice(4))
      : document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else
        el.appendChild(
          typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c,
        );
    }
    return el;
  }
  VG.h = h;
  VG.append = append;
  VG.$ = (sel, root) => (root || document).querySelector(sel);
  VG.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  VG.clear = (el) => {
    while (el && el.firstChild) el.removeChild(el.firstChild);
    return el;
  };
  VG.esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  VG.uid = (() => {
    let n = 0;
    return (prefix) => `${prefix || "vg"}-${++n}`;
  })();
  VG.debounce = (fn, ms) => {
    let t = 0;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };
  VG.reducedMotion = () =>
    Boolean(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  VG.isNarrow = () => window.innerWidth < 900;
  VG.plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + "s"}`;

  /* ---------------------------------------------------------------- storage (never required to work) */

  VG.store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem("vg." + key);
        return raw === null || raw === undefined ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem("vg." + key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem("vg." + key);
      } catch {
        /* storage unavailable: nothing to remove */
      }
    },
  };

  /* ---------------------------------------------------------------- events */

  const listeners = new Map();
  VG.on = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  };
  VG.emit = (name, detail) => {
    for (const fn of listeners.get(name) || []) {
      try {
        fn(detail);
      } catch (err) {
        VG.reportError(err);
      }
    }
  };
  VG.reportError = (err) => {
    // Shown in the page (never thrown at the console as an uncaught error).
    VG.lastError = err;
    if (VG.ui && VG.ui.banner)
      VG.ui.banner("error", `Something went wrong: ${err && err.message ? err.message : err}`);
  };

  /* ---------------------------------------------------------------- clipboard */

  VG.copy = async function copy(text, label) {
    VG.lastCopied = text;
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      const ta = h("textarea", { class: "vg-sr", "aria-hidden": "true", readonly: true });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    if (VG.ui && VG.ui.toast) {
      if (ok) VG.ui.toast(`${label || "Text"} copied`);
      else VG.ui.copyFallback(text);
    }
    return ok;
  };

  /* ---------------------------------------------------------------- colours */

  /** Resolved value of a CSS custom property (for canvas and WebGL, which cannot read CSS variables). */
  VG.cssVar = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback || "#888";
  };
  VG.kindVar = (kind) => `var(--k-${kind || "other"}, var(--k-other))`;
  VG.TERM_CATEGORIES = [
    "product",
    "travel",
    "payments",
    "identity",
    "tenancy",
    "data",
    "api",
    "security",
    "operations",
    "engineering",
    "process",
  ];
  VG.categoryVar = (cat) => (VG.TERM_CATEGORIES.includes(cat) ? `var(--cat-${cat})` : "var(--text-faint)");
  VG.GRAPH_KINDS = ["app", "term", "class", "individual", "page", "journey", "issue"];
  VG.KIND_LABELS = {
    app: "App",
    term: "Term",
    class: "Class",
    individual: "Individual",
    page: "Page",
    journey: "Journey",
    issue: "Issue",
    ui: "UI",
    api: "API",
    worker: "Worker",
    db: "Database",
    cache: "Cache",
    queue: "Queue",
    storage: "Storage",
    external: "External",
    lib: "Library",
    user: "Person",
    edge: "Edge",
  };

  /* ---------------------------------------------------------------- icons (24x24 stroke paths, no emoji) */

  const ICONS = {
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
    edge: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
    ui: "M3 5h18v14H3zM3 9h18M7 7h.01",
    api: "M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16",
    worker:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
    db: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    cache: "M13 2L4 14h7l-1 8 9-12h-7z",
    queue: "M4 6h16M4 12h16M4 18h10",
    storage: "M3 7l9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4",
    external: "M7 18a5 5 0 0 1-.5-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9z",
    lib: "M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10",
    app: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    term: "M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4zM8 9h8M8 13h6",
    class: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
    individual: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    page: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7",
    journey:
      "M5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7 17h6a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h6",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5",
    menu: "M4 6h16M4 12h16M4 18h16",
    close: "M6 6l12 12M18 6L6 18",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
    moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
    system: "M3 4h18v12H3zM8 20h8M12 16v4",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    fit: "M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9z",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    play: "M7 4l13 8-13 8z",
    pause: "M7 4h4v16H7zM13 4h4v16h-4z",
    next: "M6 4l10 8-10 8zM18 4v16",
    prev: "M18 4L8 12l10 8zM6 4v16",
    reset: "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5",
    check: "M5 12l5 5 9-10",
    bug: "M8 8a4 4 0 0 1 8 0v8a4 4 0 0 1-8 0zM12 12v8M4 12h4M16 12h4M5 7l3 2M19 7l-3 2M5 18l3-2M19 18l-3-2",
    skip: "M5 12h14M13 6l6 6-6 6",
    external_link: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
    chevron: "M9 6l6 6-6 6",
    graph: "M6 6a2 2 0 1 0 0 .1M18 8a2 2 0 1 0 0 .1M12 18a2 2 0 1 0 0 .1M7.5 7l9 1M7 7.5l4 9M17 10l-4 7",
    cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
    tree: "M5 4h5v4H5zM14 10h5v4h-5zM14 17h5v4h-5zM7.5 8v11H14M7.5 12H14",
    book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 5v16M8 7h7",
    home: "M3 11l9-8 9 8M5 9v11h14V9",
    bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z",
    flag: "M5 21V4M5 4h11l-2 4 2 4H5",
    gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.6V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z",
    download: "M12 4v11M7 10l5 5 5-5M5 20h14",
    other: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z",
  };
  ICONS.issue = ICONS.bug;
  VG.ICONS = ICONS;
  /** Inline SVG icon element; decorative unless a label is given. */
  VG.icon = (name, label, size) => {
    const svg = h("svg:svg", {
      class: "vg-icon",
      viewBox: "0 0 24 24",
      width: size || 18,
      height: size || 18,
      "aria-hidden": label ? null : "true",
      role: label ? "img" : null,
      "aria-label": label || null,
      focusable: "false",
    });
    svg.appendChild(h("svg:path", { d: ICONS[name] || ICONS.other }));
    return svg;
  };

  /* ---------------------------------------------------------------- routes */

  VG.routes = {
    home: () => "#/",
    page: (id, s) => `#/page/${encodeURIComponent(id)}${s ? "?s=" + encodeURIComponent(s) : ""}`,
    app: (id, tab, s) =>
      `#/app/${encodeURIComponent(id)}/${tab || "usage"}${s ? "?s=" + encodeURIComponent(s) : ""}`,
    journey: (id) => `#/journey/${encodeURIComponent(id)}`,
    journeys: (app) => `#/journeys${app ? "?app=" + encodeURIComponent(app) : ""}`,
    /** Known issues, filtered: issues({ app: "portal", severity: ["high", "medium"], journey, step, q }). */
    issues: (params) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) {
        const value = Array.isArray(v) ? v.join(",") : v;
        if (value !== null && value !== undefined && value !== "") p.set(k, String(value));
      }
      const qs = p.toString();
      return `#/issues${qs ? "?" + qs : ""}`;
    },
    issue: (id) => `#/issue/${encodeURIComponent(id)}`,
    term: (id) => `#/glossary/${encodeURIComponent(id)}`,
    glossary: () => "#/glossary",
    diagram: (key) => `#/diagram/${key.split("/").map(encodeURIComponent).join("/")}`,
    cls: (id) => `#/ontology/${encodeURIComponent(id)}`,
    graph: (focus) => `#/graph${focus ? "?focus=" + encodeURIComponent(focus) : ""}`,
    system: (flow) => `#/system${flow ? "?flow=" + encodeURIComponent(flow) : ""}`,
    search: (q) => `#/search?q=${encodeURIComponent(q || "")}`,
  };
})();
