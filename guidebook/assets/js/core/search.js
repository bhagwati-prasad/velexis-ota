/* Velexis Guidebook: search over the build's search index, and the Ctrl/Cmd+K command palette. */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  const KIND_WEIGHT = {
    term: 6,
    app: 6,
    page: 5,
    journey: 4,
    screen: 3,
    endpoint: 3,
    issue: 3,
    diagram: 2,
    class: 2,
    section: 0,
  };
  const KIND_LABEL = {
    page: "Page",
    section: "Section",
    term: "Term",
    app: "App",
    screen: "Screen",
    endpoint: "Endpoint",
    journey: "Journey",
    diagram: "Diagram",
    class: "Class",
    issue: "Issue",
    nav: "Go to",
  };
  const KIND_ICON = {
    page: "page",
    section: "page",
    term: "term",
    app: "app",
    screen: "ui",
    endpoint: "api",
    journey: "journey",
    diagram: "graph",
    class: "class",
    issue: "bug",
    nav: "chevron",
  };
  let prepared = null;

  function prepare() {
    if (prepared) return prepared;
    prepared = (VG.data.c.search || []).map((e) => ({
      e,
      t: String(e.t || "").toLowerCase(),
      s: String(e.s || "").toLowerCase(),
      x: String(e.x || "").toLowerCase(),
      id: String(e.id || "").toLowerCase(),
      p: String(e.p || "").toLowerCase(),
    }));
    return prepared;
  }

  /** Ranked results for `q`: [{ e: entry, score }]. opts: { limit, kinds:Set } */
  VG.search = function search(q, opts) {
    const o = opts || {};
    const tokens = String(q || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.length) return [];
    const full = tokens.join(" ");
    const wordRe = tokens.map(
      (tk) => new RegExp(`(^|[\\s/._-])${tk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    const out = [];
    for (const r of prepare()) {
      if (o.kinds && !o.kinds.has(r.e.k)) continue;
      let score = 0;
      let ok = true;
      for (let i = 0; i < tokens.length; i++) {
        const tk = tokens[i];
        let s = 0;
        if (r.t === tk) s = 60;
        else if (r.t.startsWith(tk)) s = 30;
        else if (wordRe[i].test(r.t)) s = 20;
        else if (r.t.includes(tk)) s = 12;
        else if (r.id.includes(tk)) s = 8;
        else if (r.x.includes(tk)) s = 5;
        else if (r.s.includes(tk)) s = 3;
        else if (r.p.includes(tk)) s = 2;
        if (!s) {
          ok = false;
          break;
        }
        score += s;
      }
      if (!ok) continue;
      if (r.t === full) score += 80;
      else if (r.t.startsWith(full)) score += 25;
      score += KIND_WEIGHT[r.e.k] || 0;
      out.push({ e: r.e, score });
    }
    out.sort((a, b) => b.score - a.score || String(a.e.t).localeCompare(String(b.e.t)));
    return o.limit ? out.slice(0, o.limit) : out;
  };
  VG.search.KIND_LABEL = KIND_LABEL;
  VG.search.KIND_ICON = KIND_ICON;

  /** Highlights query tokens in text (returns a DocumentFragment, no HTML injection). */
  VG.search.highlight = function highlight(text, q) {
    const frag = document.createDocumentFragment();
    const tokens = String(q || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);
    const s = String(text || "");
    if (!tokens.length) {
      frag.appendChild(document.createTextNode(s));
      return frag;
    }
    const re = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    let last = 0;
    s.replace(re, (m, _g, i) => {
      if (i > last) frag.appendChild(document.createTextNode(s.slice(last, i)));
      frag.appendChild(h("mark", {}, m));
      last = i + m.length;
      return m;
    });
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    return frag;
  };

  /* ---------------------------------------------------------------- command palette */

  function navEntries() {
    const nav = [
      { k: "nav", t: "Home", r: "#/", s: "System map and sections" },
      { k: "nav", t: "Journeys", r: "#/journeys", s: "End-to-end walkthroughs with a bug checklist" },
      { k: "nav", t: "Known issues", r: "#/issues", s: "Verified bugs to fix: filter, copy as a checklist" },
      { k: "nav", t: "Glossary", r: "#/glossary", s: "Every term, A-Z" },
      { k: "nav", t: "Taxonomy", r: "#/taxonomy", s: "Classification tree and sunburst" },
      { k: "nav", t: "Knowledge graph", r: "#/graph", s: "Apps, terms, classes and their links (2D/3D)" },
      { k: "nav", t: "Ontology", r: "#/ontology", s: "Classes, properties, individuals" },
      { k: "nav", t: "System 3D", r: "#/system", s: "Layers, nodes and animated flows" },
    ];
    for (const a of VG.data.appList())
      nav.push({ k: "app", t: a.name || a.id, r: VG.routes.app(a.id), s: a.summary || "" });
    return nav;
  }

  let paletteEl = null;
  let lastFocus = null;

  VG.palette = {
    open(initial) {
      if (paletteEl) {
        const inp = paletteEl.querySelector("input");
        if (initial !== null && initial !== undefined) {
          inp.value = initial;
          inp.dispatchEvent(new Event("input"));
        }
        inp.focus();
        return;
      }
      lastFocus = document.activeElement;
      const listId = VG.uid("pal-list");
      const input = h("input", {
        type: "search",
        class: "vg-palette-input",
        placeholder: "Search pages, terms, screens, endpoints, journeys…",
        role: "combobox",
        "aria-expanded": "true",
        "aria-controls": listId,
        "aria-autocomplete": "list",
        "aria-label": "Search the guidebook",
        autocomplete: "off",
        spellcheck: "false",
      });
      const list = h("ul", {
        class: "vg-palette-list",
        id: listId,
        role: "listbox",
        "aria-label": "Results",
      });
      const foot = h("div", { class: "vg-palette-foot" }, "↑ ↓ to move · Enter to open · Esc to close");
      const box = h(
        "div",
        { class: "vg-palette", role: "dialog", "aria-modal": "true", "aria-label": "Search" },
        h("div", { class: "vg-palette-head" }, VG.icon("search"), input),
        list,
        foot,
      );
      paletteEl = h(
        "div",
        { class: "vg-palette-wrap", onclick: (e) => e.target === paletteEl && VG.palette.close() },
        box,
      );
      document.body.appendChild(paletteEl);
      let items = [];
      let active = 0;
      const setActive = (i) => {
        active = Math.max(0, Math.min(i, items.length - 1));
        list
          .querySelectorAll("[role=option]")
          .forEach((li, k) => li.setAttribute("aria-selected", k === active ? "true" : "false"));
        const cur = list.querySelector(`[data-i="${active}"]`);
        if (cur) {
          input.setAttribute("aria-activedescendant", cur.id);
          cur.scrollIntoView({ block: "nearest" });
        }
      };
      const go = (i) => {
        const it = items[i];
        if (!it) return;
        VG.palette.close(false);
        location.hash = it.r;
      };
      const render = () => {
        const q = input.value.trim();
        VG.clear(list);
        if (!q) items = navEntries();
        else {
          items = VG.search(q, { limit: 40 }).map((r) => r.e);
          items.push({
            k: "nav",
            t: `All results for “${q}”`,
            r: VG.routes.search(q),
            s: "Open the search page",
          });
        }
        let lastKind = null;
        items.forEach((it, i) => {
          if (q && it.k !== lastKind) {
            list.appendChild(
              h("li", { class: "vg-palette-group", role: "presentation" }, KIND_LABEL[it.k] || it.k),
            );
            lastKind = it.k;
          }
          const li = h(
            "li",
            {
              id: `${listId}-${i}`,
              role: "option",
              class: "vg-palette-item",
              dataset: { i: String(i) },
              "aria-selected": "false",
              onclick: () => go(i),
              onmousemove: () => active !== i && setActive(i),
            },
            h(
              "span",
              { class: `vg-palette-kind vg-k-${it.k}` },
              VG.icon(KIND_ICON[it.k] || "other", null, 16),
            ),
            h(
              "span",
              { class: "vg-palette-text" },
              h("span", { class: "vg-palette-title" }, VG.search.highlight(it.t, q)),
              it.p ? h("span", { class: "vg-palette-parent" }, ` · ${it.p}`) : null,
              it.s ? h("span", { class: "vg-palette-snippet" }, VG.search.highlight(it.s, q)) : null,
            ),
            it.a ? h("span", { class: "vg-badge" }, VG.data.appName(it.a)) : null,
          );
          list.appendChild(li);
        });
        if (!items.length) list.appendChild(h("li", { class: "vg-palette-empty" }, "No results"));
        setActive(0);
      };
      input.addEventListener("input", render);
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive(active + 1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive(active - 1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          go(active);
        } else if (e.key === "Escape") {
          e.preventDefault();
          VG.palette.close();
        } else if (e.key === "Tab") {
          e.preventDefault();
        }
      });
      input.value = initial || "";
      render();
      input.focus();
    },
    close(restore) {
      if (!paletteEl) return;
      paletteEl.remove();
      paletteEl = null;
      if (restore !== false && lastFocus && lastFocus.focus) lastFocus.focus();
    },
    isOpen: () => Boolean(paletteEl),
  };

  document.addEventListener("keydown", (e) => {
    const typing =
      e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (VG.palette.isOpen()) VG.palette.close();
      else VG.palette.open();
    } else if (e.key === "/" && !typing && !VG.palette.isOpen()) {
      e.preventDefault();
      VG.palette.open();
    }
  });
})();
