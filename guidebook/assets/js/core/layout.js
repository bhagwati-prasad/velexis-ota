/* Velexis Guidebook: page shell (top bar, sidebar drawer, breadcrumbs, table of contents with scroll-spy, theme). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;
  const L = (VG.layout = {});

  const THEMES = ["system", "light", "dark"];
  const THEME_ICON = { system: "system", light: "sun", dark: "moon" };

  /* ---------------------------------------------------------------- theme */

  function systemDark() {
    return Boolean(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  L.themePref = () => VG.store.get("theme", "system");
  L.applyTheme = function applyTheme(pref) {
    const p = THEMES.includes(pref) ? pref : "system";
    const dark = p === "dark" || (p === "system" && systemDark());
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme-pref", p);
    const btn = document.getElementById("vg-theme");
    if (btn) {
      VG.clear(btn).appendChild(VG.icon(THEME_ICON[p]));
      btn.setAttribute(
        "aria-label",
        `Theme: ${p}${p === "system" ? (dark ? " (dark)" : " (light)") : ""}. Change theme`,
      );
      btn.title = `Theme: ${p}`;
    }
    VG.emit("theme", { pref: p, dark });
  };
  if (window.matchMedia) {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (L.themePref() === "system") L.applyTheme("system");
    });
  }

  /* ---------------------------------------------------------------- shell */

  L.init = function init(root) {
    const D = VG.data;
    const site = D.site;
    VG.clear(root);

    const menuBtn = h(
      "button",
      {
        type: "button",
        class: "vg-iconbtn vg-menu-btn",
        "aria-label": "Open navigation",
        "aria-expanded": "false",
        "aria-controls": "vg-sidebar",
        onclick: () => L.drawer(!document.body.classList.contains("vg-drawer-open")),
      },
      VG.icon("menu"),
    );
    const searchInput = h("input", {
      type: "search",
      id: "vg-search",
      class: "vg-search-input",
      placeholder: "Search…",
      "aria-label": "Search the guidebook (Ctrl+K)",
      autocomplete: "off",
      spellcheck: "false",
    });
    searchInput.addEventListener("input", () => {
      const v = searchInput.value;
      searchInput.value = "";
      VG.palette.open(v);
    });
    searchInput.addEventListener("click", () => VG.palette.open(""));
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        VG.palette.open(searchInput.value);
      }
    });
    const topbar = h(
      "header",
      { class: "vg-topbar" },
      menuBtn,
      h(
        "a",
        { class: "vg-logo", href: "#/", "aria-label": `${site.title || "Velexis Guidebook"}, home` },
        h("span", { class: "vg-logo-mark", "aria-hidden": "true" }, "V"),
        h("span", { class: "vg-logo-text" }, site.title || "Velexis Guidebook"),
      ),
      h(
        "div",
        { class: "vg-search" },
        VG.icon("search"),
        searchInput,
        h(
          "kbd",
          { class: "vg-kbd", "aria-hidden": "true" },
          /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K",
        ),
      ),
      h(
        "div",
        { class: "vg-topbar-actions" },
        h(
          "button",
          {
            type: "button",
            id: "vg-search-btn",
            class: "vg-iconbtn vg-search-mobile",
            "aria-label": "Search",
            onclick: () => VG.palette.open(""),
          },
          VG.icon("search"),
        ),
        h("button", {
          type: "button",
          id: "vg-theme",
          class: "vg-iconbtn",
          onclick: () => {
            const next = THEMES[(THEMES.indexOf(L.themePref()) + 1) % THEMES.length];
            VG.store.set("theme", next);
            L.applyTheme(next);
            VG.ui.toast(`Theme: ${next}`);
          },
        }),
        h(
          "button",
          {
            type: "button",
            id: "vg-copylink",
            class: "vg-iconbtn",
            "aria-label": "Copy link to this view",
            title: "Copy link",
            onclick: () => VG.copy(location.href, "Link"),
          },
          VG.icon("link"),
        ),
      ),
    );

    const sidebar = h(
      "nav",
      { id: "vg-sidebar", class: "vg-sidebar", "aria-label": "Guidebook" },
      buildNav(),
    );
    const backdrop = h("div", { class: "vg-backdrop", onclick: () => L.drawer(false) });
    const main = h("main", { id: "vg-main", class: "vg-main", tabindex: "-1" });
    const toc = h("aside", { id: "vg-toc", class: "vg-toc", "aria-label": "On this page" });
    const crumbs = h("nav", { id: "vg-crumbs", class: "vg-crumbs", "aria-label": "Breadcrumb" });
    const footer = h(
      "footer",
      { class: "vg-footer" },
      h(
        "span",
        {},
        `${site.title || "Velexis Guidebook"}${site.version ? " " + site.version : ""}`,
        site.commit ? ` · code at ${site.commit}` : "",
        site.date ? ` · ${site.date}` : "",
      ),
      h("span", {}, "Content in guidebook/content · rebuild with node guidebook/tools/build.mjs"),
    );
    const shell = h(
      "div",
      { class: "vg-shell" },
      topbar,
      sidebar,
      backdrop,
      h(
        "div",
        { class: "vg-content" },
        h("div", { id: "vg-banners", class: "vg-banners" }),
        crumbs,
        h("div", { class: "vg-main-grid" }, main, toc),
        footer,
      ),
    );
    root.appendChild(shell);
    L.main = main;
    L.toc = toc;
    L.crumbs = crumbs;
    L.sidebar = sidebar;
    L.applyTheme(L.themePref());

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.body.classList.contains("vg-drawer-open")) {
        L.drawer(false);
        menuBtn.focus();
      }
    });
    // In-page anchors (#id, not #/route) scroll instead of changing the route.
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      const href = a.getAttribute("href");
      if (href.startsWith("#/") || href === "#") return;
      const target = document.getElementById(decodeURIComponent(href.slice(1)));
      e.preventDefault();
      if (target) {
        target.scrollIntoView({ block: "start", behavior: VG.reducedMotion() ? "auto" : "smooth" });
        if (target.tabIndex < 0 && !/^(A|BUTTON|INPUT|MAIN)$/.test(target.tagName))
          target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
    });
    window.addEventListener(
      "resize",
      VG.debounce(() => VG.emit("resize"), 150),
    );
    return shell;
  };

  function navLink(href, label, icon, extra) {
    return h(
      "a",
      { class: "vg-nav-link", href, dataset: { nav: href } },
      icon ? VG.icon(icon, null, 16) : null,
      h("span", {}, label),
      extra || null,
    );
  }

  function buildNav() {
    const D = VG.data;
    const frag = h("div", { class: "vg-nav" });
    const section = (title, ...items) =>
      h(
        "div",
        { class: "vg-nav-section" },
        h("h2", { class: "vg-nav-title" }, title),
        h(
          "ul",
          {},
          items.filter(Boolean).map((i) => h("li", {}, i)),
        ),
      );
    const pages = D.pageList().map((p) => navLink(VG.routes.page(p.id), p.title, "page"));
    frag.appendChild(section("Guide", navLink("#/", "Home", "home"), ...pages));

    const appsWrap = h("div", { class: "vg-nav-section" }, h("h2", { class: "vg-nav-title" }, "Apps"));
    for (const g of D.appGroups()) {
      appsWrap.appendChild(h("h3", { class: "vg-nav-group" }, g.label));
      const ul = h("ul", {});
      for (const a of g.apps) {
        const det = h(
          "details",
          { class: "vg-nav-app", dataset: { app: a.id } },
          h(
            "summary",
            {},
            h("span", { class: "vg-kind-dot", style: { background: `var(--p-${a.product || "shared"})` } }),
            a.name || a.id,
          ),
          h(
            "ul",
            {},
            h("li", {}, navLink(VG.routes.app(a.id, "usage"), "Usage")),
            h("li", {}, navLink(VG.routes.app(a.id, "architecture"), "Architecture")),
            h("li", {}, navLink(VG.routes.app(a.id, "facts"), "Facts")),
          ),
        );
        ul.appendChild(h("li", {}, det));
      }
      appsWrap.appendChild(ul);
    }
    if (!D.appList().length) appsWrap.appendChild(h("p", { class: "vg-nav-empty" }, "No apps yet."));
    frag.appendChild(appsWrap);

    const st = D.c.stats || {};
    frag.appendChild(
      section(
        "Explore",
        navLink(
          "#/journeys",
          "Journeys",
          "journey",
          st.journeys ? h("span", { class: "vg-nav-count" }, String(st.journeys)) : null,
        ),
        st.issues
          ? navLink(
              "#/issues",
              "Known issues",
              "bug",
              h("span", { class: "vg-nav-count" }, String(st.issues)),
            )
          : null,
        navLink(
          "#/glossary",
          "Glossary",
          "term",
          st.terms ? h("span", { class: "vg-nav-count" }, String(st.terms)) : null,
        ),
        navLink("#/taxonomy", "Taxonomy", "tree"),
        navLink("#/graph", "Knowledge graph", "graph"),
        navLink("#/ontology", "Ontology", "class"),
        navLink("#/system", "System 3D", "cube"),
      ),
    );
    return frag;
  }

  /** Opens/closes the sidebar drawer (narrow screens). */
  L.drawer = function drawer(open) {
    document.body.classList.toggle("vg-drawer-open", Boolean(open));
    const btn = document.querySelector(".vg-menu-btn");
    if (btn) {
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    }
    if (open) {
      const first = L.sidebar.querySelector("a, summary");
      if (first) setTimeout(() => first.focus(), 50);
    }
  };

  /** Marks the current route in the sidebar. */
  L.setActive = function setActive(route) {
    const path = "#/" + route.path.join("/");
    const links = Array.from(L.sidebar.querySelectorAll(".vg-nav-link"));
    links.forEach((a) => a.removeAttribute("aria-current"));
    let best = links.find((a) => a.dataset.nav === path) || null;
    if (!best) {
      for (const a of links) {
        const href = a.dataset.nav;
        if (href !== "#/" && path.startsWith(href + "/") && (!best || href.length > best.dataset.nav.length))
          best = a;
      }
    }
    if (route.path[0] === "journey") best = L.sidebar.querySelector('[data-nav="#/journeys"]');
    if (route.path[0] === "issue") best = L.sidebar.querySelector('[data-nav="#/issues"]');
    if (route.path[0] === "diagram") best = null;
    if (best) best.setAttribute("aria-current", "page");
    for (const det of L.sidebar.querySelectorAll("details.vg-nav-app")) {
      const on = route.path[0] === "app" && VG.data.resolveApp(route.path[1]) === det.dataset.app;
      if (on) det.open = true;
      det.classList.toggle("is-active", on);
    }
  };

  /** Breadcrumbs: [{ label, href? }]. */
  L.setCrumbs = function setCrumbs(items) {
    VG.clear(L.crumbs);
    if (!items || !items.length) return;
    const ol = h("ol", {});
    const all = [{ label: "Home", href: "#/" }, ...items];
    all.forEach((it, i) => {
      const last = i === all.length - 1;
      ol.appendChild(
        h(
          "li",
          {},
          it.href && !last
            ? h("a", { href: it.href }, it.label)
            : h("span", { "aria-current": last ? "page" : null }, it.label),
        ),
      );
    });
    L.crumbs.appendChild(ol);
  };

  /* ---------------------------------------------------------------- table of contents */

  let spy = null;
  L.clearToc = function clearToc() {
    if (spy) spy.disconnect();
    spy = null;
    if (L.toc) VG.clear(L.toc);
  };
  /** Right-hand ToC with scroll-spy. headings: [{ depth, id, slug, text }], base: route of the document. */
  L.setToc = function setToc(headings, base) {
    L.clearToc();
    if (!headings || headings.length < 2) return;
    const list = h("ul", {});
    const links = new Map();
    for (const hd of headings) {
      const a = h(
        "a",
        { href: `${base}?s=${encodeURIComponent(hd.slug)}`, class: `vg-toc-l${hd.depth}` },
        hd.text,
      );
      links.set(hd.id, a);
      list.appendChild(h("li", {}, a));
    }
    L.toc.appendChild(h("p", { class: "vg-toc-title" }, "On this page"));
    L.toc.appendChild(list);
    if (!("IntersectionObserver" in window)) return;
    const visible = new Set();
    spy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        let current = null;
        for (const hd of headings) {
          if (visible.has(hd.id)) {
            current = hd.id;
            break;
          }
        }
        if (!current) {
          // above the first visible heading: the last heading scrolled past
          for (const hd of headings) {
            const el = document.getElementById(hd.id);
            if (el && el.getBoundingClientRect().top < 120) current = hd.id;
          }
        }
        for (const [id, a] of links) a.classList.toggle("is-active", id === current);
      },
      { rootMargin: "-64px 0px -60% 0px", threshold: [0, 1] },
    );
    for (const hd of headings) {
      const el = document.getElementById(hd.id);
      if (el) spy.observe(el);
    }
  };

  /** Inline "On this page" list for narrow screens (the right-hand ToC is hidden there). */
  L.inlineToc = function inlineToc(headings, base) {
    if (!headings || headings.length < 3) return null;
    return h(
      "details",
      { class: "vg-inline-toc" },
      h("summary", {}, "On this page"),
      h(
        "ul",
        {},
        headings
          .filter((x) => x.depth === 2)
          .map((hd) => h("li", {}, h("a", { href: `${base}?s=${encodeURIComponent(hd.slug)}` }, hd.text))),
      ),
    );
  };

  /** Full-width views (graphs, 3D) hide the ToC column. */
  L.setWide = function setWide(on) {
    document.body.classList.toggle("vg-wide", Boolean(on));
  };
})();
