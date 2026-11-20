/*
 * Velexis Guidebook: hash router (#/view/arg?param=value) and the view registry.
 * A view registers with VG.views.register(name, { render(main, route) -> { destroy?, update?(route) -> boolean } }).
 * update() lets a view handle a parameter change in place (for example ?s=section scrolls instead of re-rendering).
 */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  const registry = {};
  VG.views = {
    registry,
    register(name, def) {
      registry[name] = def;
    },
  };

  /** First path segment -> view name. */
  const VIEW_OF = {
    "": "home",
    page: "page",
    app: "app",
    diagram: "diagram",
    journeys: "journeys",
    journey: "journey",
    issues: "issues",
    issue: "issue",
    glossary: "glossary",
    taxonomy: "taxonomy",
    graph: "graph",
    ontology: "ontology",
    system: "system",
    search: "search",
  };

  function parse(hash) {
    const raw = String(hash || "").replace(/^#\/?/, "");
    const qi = raw.indexOf("?");
    const pathPart = qi < 0 ? raw : raw.slice(0, qi);
    const query = qi < 0 ? "" : raw.slice(qi + 1);
    const path = pathPart
      .split("/")
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
    const params = new URLSearchParams(query);
    return { raw, path, params, view: VIEW_OF[path[0] || ""] || "notfound", key: path.join("/") };
  }

  let current = null; // { name, route, inst }

  function scrollToSection(slug, smooth) {
    if (!slug) return false;
    const el = document.getElementById(`sec-${slug}`);
    if (!el) return false;
    el.scrollIntoView({ block: "start", behavior: smooth && !VG.reducedMotion() ? "smooth" : "auto" });
    el.classList.remove("vg-flash");
    void el.offsetWidth;
    el.classList.add("vg-flash");
    return true;
  }
  VG.scrollToSection = scrollToSection;

  function notFound(main, route) {
    VG.layout.setCrumbs([{ label: "Not found" }]);
    main.appendChild(
      h(
        "div",
        { class: "vg-empty" },
        h("h1", {}, "Page not found"),
        h("p", {}, `Nothing lives at “#/${route.raw}”.`),
        h("p", {}, h("a", { href: "#/" }, "Go to the home page"), " or press Ctrl+K to search."),
      ),
    );
    return {};
  }

  function render() {
    const route = parse(location.hash);
    const main = VG.layout.main;
    // Same view: let it handle the change in place (it returns true when it did, for example a ?s= scroll or a
    // glossary selection); otherwise the view is rendered again.
    if (current && current.name === route.view && current.inst && current.inst.update) {
      let handled = false;
      try {
        handled = current.inst.update(route) === true;
      } catch (err) {
        handled = false;
        VG.reportError(err);
      }
      if (handled) {
        current.route = route;
        VG.emit("route", route);
        return;
      }
    }
    if (current && current.inst && current.inst.destroy) {
      try {
        current.inst.destroy();
      } catch (err) {
        VG.reportError(err);
      }
    }
    VG.ui.closePopover(false);
    VG.layout.clearToc();
    VG.layout.drawer(false);
    VG.clear(main);
    const def = registry[route.view];
    const wide = Boolean(def && (typeof def.wide === "function" ? def.wide(route) : def.wide));
    VG.layout.setWide(wide);
    main.className = `vg-main vg-view-${route.view}`;
    let inst = {};
    try {
      inst = (def ? def.render(main, route) : notFound(main, route)) || {};
    } catch (err) {
      inst = {};
      VG.clear(main);
      main.appendChild(
        h(
          "div",
          { class: "vg-empty vg-view-error", role: "alert" },
          h("h1", {}, "This view could not be shown"),
          h("p", {}, String(err && err.message ? err.message : err)),
        ),
      );
      VG.lastError = err;
    }
    const firstRender = !current;
    current = { name: route.view, route, inst };
    VG.layout.setActive(route);
    const title = (inst && inst.title) || (def && def.title && def.title(route)) || "";
    document.title = title
      ? `${title} · ${VG.data.site.title || "Velexis Guidebook"}`
      : VG.data.site.title || "Velexis Guidebook";
    const s = route.params.get("s");
    if (!(s && scrollToSection(s, false))) window.scrollTo(0, 0);
    if (!firstRender && !s) main.focus({ preventScroll: true });
    VG.emit("route", route);
  }

  VG.router = {
    parse,
    start() {
      window.addEventListener("hashchange", render);
      if (!location.hash || location.hash === "#") history.replaceState(null, "", "#/");
      render();
    },
    current: () => current,
    rerender() {
      if (current) current.route = { key: "\u0000" };
      render();
    },
  };
})();
