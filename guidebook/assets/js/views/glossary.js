/* Velexis Guidebook view: glossary (#/glossary, #/glossary/<id>): A-Z index, instant search, filters, term detail. */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  /** Small d3 force graph of a term, its related terms (1 hop) and their related terms (2 hops, faded). */
  function termGraph(term, onPick) {
    const D = VG.data;
    const d3 = window.d3;
    const wrap = h("div", { class: "vg-minigraph", style: { marginTop: "6px" } });
    if (!d3) return wrap;
    const nodes = new Map();
    const links = [];
    const add = (t, hop) => {
      if (!nodes.has(t.id)) nodes.set(t.id, { id: t.id, label: t.term || t.id, hop, cat: t.category });
    };
    add(term, 0);
    for (const r of term.related || []) {
      const t = D.terms.get(r);
      if (!t) continue;
      add(t, 1);
      links.push({ source: term.id, target: t.id });
    }
    // terms that list this one as related
    for (const t of D.termList) {
      if (t.id !== term.id && (t.related || []).includes(term.id)) {
        add(t, 1);
        if (
          !links.some(
            (l) => (l.source === t.id && l.target === term.id) || (l.source === term.id && l.target === t.id),
          )
        ) {
          links.push({ source: t.id, target: term.id });
        }
      }
    }
    for (const n of [...nodes.values()].filter((n) => n.hop === 1)) {
      for (const r of (D.terms.get(n.id).related || []).slice(0, 4)) {
        const t = D.terms.get(r);
        if (!t || nodes.size > 28) continue;
        add(t, 2);
        if (
          !links.some(
            (l) => (l.source === n.id && l.target === t.id) || (l.source === t.id && l.target === n.id),
          )
        ) {
          links.push({ source: n.id, target: t.id });
        }
      }
    }
    const W = 420;
    const H = 260;
    const svg = d3
      .select(wrap)
      .append("svg")
      .attr("viewBox", `0 0 ${W} ${H}`)
      .attr("width", "100%")
      .attr("class", "vg-svg")
      .attr("role", "group")
      .attr("aria-label", `Terms related to ${term.term}`);
    const data = [...nodes.values()];
    if (data.length === 1) {
      svg.attr("viewBox", `0 0 ${W} 60`);
      svg
        .append("text")
        .attr("x", W / 2)
        .attr("y", 34)
        .attr("text-anchor", "middle")
        .attr("class", "vg-muted-text")
        .text("No related terms recorded.");
      return wrap;
    }
    const sim = d3
      .forceSimulation(data)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance((l) => (l.source.hop === 0 || l.target.hop === 0 ? 80 : 60)),
      )
      .force("charge", d3.forceManyBody().strength(-260))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide(30))
      .stop();
    data[0].fx = W / 2;
    data[0].fy = H / 2;
    for (let i = 0; i < 220; i++) sim.tick();
    for (const n of data) {
      n.x = Math.max(40, Math.min(W - 40, n.x));
      n.y = Math.max(18, Math.min(H - 18, n.y));
    }
    svg
      .append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("class", "vg-edge")
      .attr("x1", (l) => l.source.x)
      .attr("y1", (l) => l.source.y)
      .attr("x2", (l) => l.target.x)
      .attr("y2", (l) => l.target.y)
      .style("opacity", (l) => (l.source.hop === 2 || l.target.hop === 2 ? 0.4 : 1));
    const g = svg
      .append("g")
      .selectAll("g")
      .data(data)
      .join("g")
      .attr("class", "vg-node")
      .attr("transform", (n) => `translate(${n.x},${n.y})`)
      .style("opacity", (n) => (n.hop === 2 ? 0.6 : 1));
    g.append("circle")
      .attr("r", (n) => (n.hop === 0 ? 10 : 7))
      .style("fill", (n) => VG.categoryVar(n.cat))
      .style("stroke", "var(--panel)")
      .style("stroke-width", "2px");
    g.append("text")
      .attr("y", (n) => (n.hop === 0 ? -15 : -11))
      .attr("text-anchor", "middle")
      .style("font-weight", (n) => (n.hop === 0 ? 700 : 400))
      .style("paint-order", "stroke")
      .style("stroke", "var(--panel)")
      .style("stroke-width", "3px")
      .text((n) => n.label);
    const pick = (e, n) => n.hop && onPick(n.id);
    g.filter((n) => n.hop > 0).on("click", pick);
    VG.svg
      .focusable(
        g.filter((n) => n.hop > 0),
        "",
        pick,
      )
      .attr("aria-label", (n) => `Open ${n.label}`);
    return wrap;
  }

  function detail(term) {
    const D = VG.data;
    const box = h("div", {});
    box.appendChild(
      h(
        "div",
        { class: "vg-meta" },
        h("span", { class: "vg-kind-dot", style: { background: VG.categoryVar(term.category) } }),
        h("span", {}, term.category || ""),
        h("code", {}, term.id),
      ),
    );
    box.appendChild(h("h2", { id: "vg-term-title", tabindex: "-1" }, term.term || term.id));
    if ((term.aliases || []).length) {
      box.appendChild(
        h(
          "p",
          { class: "vg-meta" },
          "Also: ",
          term.aliases.map((a) => h("span", { class: "vg-badge" }, a)),
        ),
      );
    }
    box.appendChild(VG.md.block(term.definition || ""));
    if ((term.apps || []).length) {
      box.appendChild(h("h3", {}, "Apps"));
      box.appendChild(
        h(
          "div",
          { class: "vg-tag-list" },
          term.apps.map((a) =>
            D.app(a)
              ? h("a", { class: "vg-chip", href: VG.routes.app(a) }, D.appName(a))
              : h("span", { class: "vg-badge" }, a),
          ),
        ),
      );
    }
    if ((term.related || []).length) {
      box.appendChild(h("h3", {}, "Related terms"));
      box.appendChild(
        h(
          "div",
          { class: "vg-tag-list" },
          term.related.map((r) => {
            const t = D.terms.get(r);
            return t
              ? h(
                  "a",
                  { class: "vg-chip vg-term", href: VG.routes.term(r), dataset: { term: r } },
                  h("span", { class: "vg-kind-dot", style: { background: VG.categoryVar(t.category) } }),
                  t.term,
                )
              : h("span", { class: "vg-broken" }, r);
          }),
        ),
      );
    }
    box.appendChild(h("h3", {}, "Neighbourhood"));
    box.appendChild(termGraph(term, (id) => (location.hash = VG.routes.term(id))));
    if ((term.see || []).length) {
      box.appendChild(h("h3", {}, "See also"));
      box.appendChild(
        h(
          "ul",
          { class: "vg-linklist" },
          term.see.map((s) =>
            h(
              "li",
              {},
              D.pages.get(s) ? h("a", { href: VG.routes.page(s) }, D.pages.get(s).title) : VG.ui.repoLink(s),
            ),
          ),
        ),
      );
    }
    if (term.classOf) {
      const c = D.classes.get(term.classOf);
      box.appendChild(h("h3", {}, "Ontology class"));
      box.appendChild(
        h(
          "p",
          {},
          h("a", { href: VG.routes.cls(term.classOf) }, c ? c.label || c.id : term.classOf),
          c && c.description ? ` — ${VG.text.plainInline(c.description)}` : "",
        ),
      );
    }
    const back = term.backlinks || [];
    box.appendChild(h("h3", {}, `Mentioned in (${back.length})`));
    box.appendChild(
      back.length
        ? h(
            "ul",
            { class: "vg-linklist" },
            back.map((b) =>
              h("li", {}, h("a", { href: b.route }, b.title), " ", h("span", { class: "vg-badge" }, b.kind)),
            ),
          )
        : h("p", { class: "vg-muted" }, "No page links to this term yet."),
    );
    box.appendChild(
      h(
        "p",
        { style: { marginTop: "14px" } },
        h(
          "a",
          { class: "vg-btn", href: VG.routes.graph(`term:${term.id}`) },
          VG.icon("graph", null, 16),
          "Show in the knowledge graph",
        ),
      ),
    );
    return box;
  }

  VG.views.register("glossary", {
    title(route) {
      const t = route.path[1] && VG.data.terms.get(route.path[1]);
      return t ? `${t.term} · Glossary` : "Glossary";
    },
    render(main, route) {
      const D = VG.data;
      const terms = D.termList;
      VG.layout.setCrumbs([{ label: "Glossary", href: "#/glossary" }]);
      main.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h("h1", {}, "Glossary"),
          h(
            "p",
            { class: "vg-lede" },
            `${terms.length} terms. Type to search names, aliases and definitions; filter by category or app; pick a term for details.`,
          ),
        ),
      );
      if (!terms.length) {
        main.appendChild(VG.ui.empty("No terms yet", "Add content/glossary/terms.json and rebuild."));
        return {};
      }
      const qId = VG.uid("gq");
      const q = h("input", {
        type: "search",
        id: qId,
        class: "vg-input",
        placeholder: "Search terms, aliases, definitions…",
        "aria-label": "Search the glossary",
        autocomplete: "off",
        value: route.params.get("q") || "",
      });
      const catCounts = new Map();
      for (const t of terms) catCounts.set(t.category, (catCounts.get(t.category) || 0) + 1);
      const cats = VG.ui.chips(
        VG.TERM_CATEGORIES.filter((c) => catCounts.has(c)).map((c) => ({
          value: c,
          label: c,
          color: VG.categoryVar(c),
          count: catCounts.get(c),
        })),
        { label: "Filter by category", onChange: apply },
      );
      const appCounts = new Map();
      for (const t of terms)
        for (const a of t.apps || [])
          appCounts.set(D.resolveApp(a), (appCounts.get(D.resolveApp(a)) || 0) + 1);
      const apps = VG.ui.chips(
        [...appCounts].map(([a, n]) => ({ value: a, label: D.appName(a), count: n })),
        { label: "Filter by app", onChange: apply },
      );
      const az = h("nav", { class: "vg-az", "aria-label": "Jump to letter" });
      const count = h("p", { class: "vg-muted", "aria-live": "polite", style: { margin: 0 } });
      main.appendChild(
        h(
          "div",
          { class: "vg-gloss-filters" },
          q,
          h("div", {}, cats.el),
          appCounts.size ? h("div", {}, apps.el) : null,
          az,
          count,
        ),
      );
      const list = h("div", { class: "vg-gloss-list", role: "region", "aria-label": "Terms", tabindex: "0" });
      const panel = h("aside", {
        class: "vg-gloss-detail",
        "aria-live": "polite",
        "aria-label": "Term details",
      });
      main.appendChild(h("div", { class: "vg-gloss" }, list, panel));

      const items = terms.map((t) => {
        const a = h(
          "a",
          { class: "vg-gloss-item", href: VG.routes.term(t.id), dataset: { id: t.id } },
          h("span", {
            class: "vg-kind-dot",
            style: { background: VG.categoryVar(t.category) },
            title: t.category,
          }),
          h(
            "span",
            { class: "vg-gloss-item-text" },
            h("strong", {}, t.term),
            h("span", { class: "vg-gloss-item-def" }, VG.text.plainInline(t.definition || "")),
          ),
        );
        const letter = (t.term || t.id).trim().charAt(0).toUpperCase();
        return {
          t,
          a,
          letter: /[A-Z]/.test(letter) ? letter : "#",
          text: [t.term, t.id, ...(t.aliases || []), VG.text.plainInline(t.definition || "")]
            .join(" ")
            .toLowerCase(),
        };
      });

      function apply() {
        const tokens = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const visible = items.filter(
          (it) =>
            tokens.every((tk) => it.text.includes(tk)) &&
            (!cats.selected.size || cats.selected.has(it.t.category)) &&
            (!apps.selected.size || (it.t.apps || []).some((a) => apps.selected.has(D.resolveApp(a)))),
        );
        VG.clear(list);
        const groups = new Map();
        for (const it of visible) {
          if (!groups.has(it.letter)) groups.set(it.letter, []);
          groups.get(it.letter).push(it);
        }
        for (const [letter, its] of groups) {
          list.appendChild(h("h2", { class: "vg-gloss-letter", id: `gl-${letter}` }, letter));
          const ul = h("ul", {});
          its.forEach((it) => ul.appendChild(h("li", {}, it.a)));
          list.appendChild(ul);
        }
        if (!visible.length)
          list.appendChild(h("p", { class: "vg-muted", style: { padding: "12px" } }, "No term matches."));
        VG.clear(az);
        for (const L of "ABCDEFGHIJKLMNOPQRSTUVWXYZ#") {
          if (groups.has(L)) {
            az.appendChild(
              h(
                "a",
                {
                  href: `#gl-${L}`,
                  "aria-label": `Terms starting with ${L}`,
                  onclick: (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const el = document.getElementById(`gl-${L}`);
                    if (el) list.scrollTop = el.offsetTop - list.offsetTop;
                  },
                },
                L,
              ),
            );
          } else az.appendChild(h("span", { "aria-hidden": "true" }, L));
        }
        count.textContent = `${visible.length} of ${items.length} terms`;
      }
      q.addEventListener("input", apply);

      function select(id, focus) {
        const t = id && D.terms.get(id);
        for (const it of items) it.a.setAttribute("aria-current", it.t.id === id ? "true" : "false");
        VG.clear(panel);
        if (!t) {
          panel.appendChild(
            h(
              "div",
              {},
              h("h2", {}, id ? "Unknown term" : "Pick a term"),
              h(
                "p",
                { class: "vg-muted" },
                id
                  ? `There is no term “${id}”.`
                  : "Choose a term from the list to see its definition, related terms, where it is used and its place in the ontology.",
              ),
            ),
          );
          VG.layout.setCrumbs([{ label: "Glossary" }]);
          return;
        }
        panel.appendChild(detail(t));
        VG.layout.setCrumbs([{ label: "Glossary", href: "#/glossary" }, { label: t.term }]);
        document.title = `${t.term} · Glossary · ${VG.data.site.title || "Velexis Guidebook"}`;
        const cur = items.find((it) => it.t.id === id);
        if (cur && cur.a.isConnected) {
          const top = cur.a.offsetTop - list.offsetTop;
          if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - 40)
            list.scrollTop = top - 40;
        }
        if (focus) {
          if (VG.isNarrow()) panel.scrollIntoView({ block: "start" });
          const title = panel.querySelector("#vg-term-title");
          if (title) title.focus({ preventScroll: !VG.isNarrow() });
        }
      }
      apply();
      select(route.path[1], false);
      return {
        update(r) {
          select(r.path[1], true);
          return true;
        },
      };
    },
  });
})();
