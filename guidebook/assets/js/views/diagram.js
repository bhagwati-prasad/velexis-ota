/* Velexis Guidebook view: one diagram on its own page (#/diagram/<app>/<id>), or the list of all diagrams (#/diagram). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  function index(main) {
    const D = VG.data;
    VG.layout.setCrumbs([{ label: "Diagrams" }]);
    main.appendChild(
      h(
        "header",
        { class: "vg-header" },
        h("h1", {}, "All diagrams"),
        h("p", { class: "vg-lede" }, "Every interactive diagram, by app."),
      ),
    );
    const list = D.diagramList();
    if (!list.length) {
      main.appendChild(VG.ui.empty("No diagrams yet", "Add JSON files under content/apps/<app>/diagrams/."));
      return {};
    }
    const t = VG.ui.filterTable({
      caption: "diagrams",
      placeholder: "Filter by title, type or app…",
      columns: [
        {
          key: "title",
          label: "Diagram",
          render: (d) => h("a", { href: VG.routes.diagram(d.key) }, d.title || d.key),
          text: (d) => d.title || d.key,
        },
        {
          key: "type",
          label: "Type",
          render: (d) => h("span", { class: "vg-badge" }, d.type),
          text: (d) => d.type,
        },
        {
          key: "app",
          label: "App",
          render: (d) => D.appName(d.app),
          text: (d) => `${d.app} ${D.appName(d.app)}`,
        },
        { key: "usedIn", label: "Used in", render: (d) => String((d.usedIn || []).length), text: () => "" },
      ],
      rows: list,
    });
    main.appendChild(t.el);
    return {};
  }

  VG.views.register("diagram", {
    // no table of contents: a diagram page gives the diagram the full width
    wide: true,
    title(route) {
      const d = VG.data.diagram(route.path.slice(1).join("/"));
      return d ? d.title : "Diagrams";
    },
    render(main, route) {
      if (route.path.length < 3) return index(main);
      const D = VG.data;
      const key = route.path.slice(1).join("/");
      const d = D.diagram(key);
      if (!d) {
        VG.layout.setCrumbs([{ label: "Diagrams", href: "#/diagram" }, { label: "Not found" }]);
        main.appendChild(VG.ui.empty("Diagram not found", `There is no diagram “${key}”.`));
        return {};
      }
      const app = D.app(d.app);
      VG.layout.setCrumbs([
        { label: "Apps" },
        app ? { label: app.name, href: VG.routes.app(app.id) } : { label: d.app },
        { label: "Diagrams", href: "#/diagram" },
        { label: d.title },
      ]);
      main.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h(
            "div",
            { class: "vg-meta" },
            h("span", { class: "vg-badge vg-badge-type" }, d.type),
            app ? h("a", { href: VG.routes.app(app.id) }, app.name) : d.app,
            h("code", {}, d.key),
          ),
          h("h1", {}, d.title),
        ),
      );
      const slot = h("div", {});
      main.appendChild(slot);
      const inst = VG.widgets.mount(slot, d.key, { app: d.app, standalone: true });
      if ((d.usedIn || []).length) {
        main.appendChild(h("h2", {}, "Used in"));
        main.appendChild(
          h(
            "ul",
            { class: "vg-linklist" },
            d.usedIn.map((u) =>
              h("li", {}, h("a", { href: u.route }, u.title), " ", h("span", { class: "vg-badge" }, u.kind)),
            ),
          ),
        );
      }
      main.appendChild(
        h(
          "p",
          { class: "vg-muted", style: { marginTop: "16px" } },
          "Source: ",
          VG.ui.repoLink(`guidebook/content/apps/${d.app}/diagrams/${d.id}.json`),
        ),
      );
      return { destroy: () => inst && inst.destroy() };
    },
  });
})();
