/* Velexis Guidebook view: a markdown page (#/page/<id>), plus the shared document renderer used by app guides. */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  /**
   * Renders a markdown document with header, inline ToC (narrow screens), right-hand ToC and "terms on this page".
   * opts: { title, summary, md, base, app, header?: node, after?: node }. Returns a view instance.
   */
  VG.renderDoc = function renderDoc(main, opts) {
    const article = h("article", { class: "vg-article" });
    if (opts.header) article.appendChild(opts.header);
    else {
      article.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h("h1", {}, opts.title || ""),
          opts.summary ? h("p", { class: "vg-lede" }, opts.summary) : null,
        ),
      );
    }
    const body = h("div", { class: "vg-doc" });
    const tocSlot = h("div", {});
    article.appendChild(tocSlot);
    article.appendChild(body);
    main.appendChild(article);
    const mounted = VG.md.mount(body, opts.md || "", { app: opts.app || null, base: opts.base });
    const inline = VG.layout.inlineToc(mounted.headings, opts.base);
    if (inline) tocSlot.appendChild(inline);
    VG.layout.setToc(mounted.headings, opts.base);

    const termIds = [
      ...new Set(Array.from(body.querySelectorAll("a.vg-term[data-term]")).map((a) => a.dataset.term)),
    ];
    if (termIds.length) {
      const terms = termIds
        .map((id) => VG.data.terms.get(id))
        .filter(Boolean)
        .sort((a, b) => String(a.term).localeCompare(String(b.term)));
      article.appendChild(
        h(
          "section",
          { class: "vg-box", style: { marginTop: "28px" } },
          h("h3", {}, `Terms on this page (${terms.length})`),
          h(
            "div",
            { class: "vg-tag-list" },
            terms.map((t) =>
              h(
                "a",
                { class: "vg-chip vg-term", href: VG.routes.term(t.id), dataset: { term: t.id } },
                h("span", { class: "vg-kind-dot", style: { background: VG.categoryVar(t.category) } }),
                t.term,
              ),
            ),
          ),
        ),
      );
    }
    if (opts.after) article.appendChild(opts.after);
    const key = VG.router.parse(opts.base).key;
    return {
      headings: mounted.headings,
      destroy: mounted.destroy,
      update(route) {
        if (route.key !== key) return false;
        const s = route.params.get("s");
        if (s) VG.scrollToSection(s, true);
        else window.scrollTo({ top: 0, behavior: VG.reducedMotion() ? "auto" : "smooth" });
        return true;
      },
    };
  };

  VG.views.register("page", {
    title(route) {
      const p = VG.data.pages.get(route.path[1]);
      return p ? p.title : "Page not found";
    },
    render(main, route) {
      const id = route.path[1];
      const p = VG.data.pages.get(id);
      if (!p) {
        VG.layout.setCrumbs([{ label: "Not found" }]);
        main.appendChild(VG.ui.empty("Page not found", `There is no page “${id || ""}”.`));
        return {};
      }
      VG.layout.setCrumbs([{ label: "Guide" }, { label: p.title }]);
      return VG.renderDoc(main, { title: p.title, summary: p.summary, md: p.md, base: VG.routes.page(p.id) });
    },
  });
})();
