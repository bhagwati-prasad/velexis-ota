/* Velexis Guidebook view: search results (#/search?q=...), grouped by kind with kind filters. */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  VG.views.register("search", {
    title: (route) => `Search: ${route.params.get("q") || ""}`,
    render(main, route) {
      VG.layout.setCrumbs([{ label: "Search" }]);
      const input = h("input", {
        type: "search",
        class: "vg-input",
        style: { width: "100%", maxWidth: "560px" },
        placeholder: "Search the guidebook…",
        "aria-label": "Search the guidebook",
        autocomplete: "off",
        value: route.params.get("q") || "",
      });
      main.appendChild(h("header", { class: "vg-header" }, h("h1", {}, "Search"), input));
      const chipsHost = h("div", {});
      const count = h("p", { class: "vg-muted", "aria-live": "polite" });
      const list = h("ol", { class: "vg-results" });
      main.appendChild(chipsHost);
      main.appendChild(count);
      main.appendChild(list);
      let kinds = new Set();
      function run(push) {
        const q = input.value.trim();
        if (push) history.replaceState(null, "", VG.routes.search(q));
        document.title = `Search: ${q} · ${VG.data.site.title || "Velexis Guidebook"}`;
        const results = VG.search(q);
        const byKind = new Map();
        for (const r of results) byKind.set(r.e.k, (byKind.get(r.e.k) || 0) + 1);
        VG.clear(chipsHost);
        const chips = VG.ui.chips(
          [...byKind].map(([k, n]) => ({ value: k, label: VG.search.KIND_LABEL[k] || k, count: n })),
          {
            label: "Filter by kind",
            selected: [...kinds].filter((k) => byKind.has(k)),
            onChange: (sel) => {
              kinds = new Set(sel);
              draw();
            },
          },
        );
        if (byKind.size > 1) chipsHost.appendChild(chips.el);
        function draw() {
          VG.clear(list);
          const shown = results.filter((r) => !kinds.size || kinds.has(r.e.k)).slice(0, 200);
          count.textContent = q
            ? `${results.length} results for “${q}”${shown.length < results.length ? `, showing ${shown.length}` : ""}`
            : "Type to search pages, sections, terms, apps, screens, endpoints, journeys, known issues, diagrams and classes.";
          for (const r of shown) {
            const e = r.e;
            list.appendChild(
              h(
                "li",
                { class: "vg-result" },
                h("span", { class: "vg-badge" }, VG.search.KIND_LABEL[e.k] || e.k),
                " ",
                h("a", { href: e.r }, VG.search.highlight(e.t, q)),
                e.p ? h("span", { class: "vg-muted" }, ` · ${e.p}`) : null,
                e.a ? h("span", { class: "vg-muted" }, ` · ${VG.data.appName(e.a)}`) : null,
                e.s ? h("p", {}, VG.search.highlight(e.s, q)) : null,
              ),
            );
          }
        }
        draw();
      }
      input.addEventListener(
        "input",
        VG.debounce(() => run(true), 150),
      );
      run(false);
      setTimeout(() => input.focus({ preventScroll: true }), 0);
      return {
        update(r) {
          if (r.params.get("q") !== input.value) {
            input.value = r.params.get("q") || "";
            run(false);
          }
          return true;
        },
      };
    },
  });
})();
