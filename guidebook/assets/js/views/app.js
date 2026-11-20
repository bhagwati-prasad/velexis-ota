/* Velexis Guidebook view: an app (#/app/<id>/usage | architecture | facts). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;
  const TABS = [
    { id: "usage", label: "Usage" },
    { id: "architecture", label: "Architecture" },
    { id: "facts", label: "Facts" },
  ];

  /** "Known issues (N)" link to the issues of the app (usage and facts tabs). */
  function issuesLink(app) {
    const n = VG.data.issuesOf({ app: app.id }).length;
    if (!n) return null;
    return h(
      "a",
      {
        class: "vg-issues-link",
        href: VG.routes.issues({ app: app.id }),
        title: `Known issues of ${app.name || app.id}`,
      },
      VG.icon("bug", null, 15),
      `Known issues (${n})`,
    );
  }

  function header(app, tab) {
    return h(
      "header",
      { class: "vg-header" },
      h(
        "div",
        { class: "vg-meta" },
        h("span", { class: "vg-kind-dot", style: { background: `var(--p-${app.product || "shared"})` } }),
        h("span", {}, (app.product || "shared").toUpperCase()),
        h("span", { class: "vg-badge" }, app.kind || "app"),
        app.repoPath ? VG.ui.repoLink(app.repoPath) : null,
        tab === "usage" || tab === "facts" ? issuesLink(app) : null,
      ),
      h("h1", {}, app.name || app.id),
      app.summary ? h("p", { class: "vg-lede" }, app.summary) : null,
      h(
        "nav",
        { class: "vg-tabs", role: "tablist", "aria-label": `${app.name} sections` },
        TABS.map((t) =>
          h(
            "a",
            {
              class: "vg-tab",
              role: "tab",
              href: VG.routes.app(app.id, t.id),
              "aria-selected": t.id === tab ? "true" : "false",
              "aria-controls": "vg-main",
            },
            t.label,
          ),
        ),
      ),
    );
  }

  /* ---------------------------------------------------------------- depends-on mini graph */

  function miniGraph(app) {
    const D = VG.data;
    const d3 = window.d3;
    const out = new Map(); // id -> label
    for (const dep of app.dependsOn || []) out.set(D.resolveApp(dep), "depends on");
    for (const t of app.talksTo || []) {
      if (!t) continue;
      const id = D.resolveApp(t.app);
      out.set(id, out.has(id) ? `${out.get(id)}; ${t.how || "talks to"}` : t.how || "talks to");
    }
    const inc = (app.dependents || []).filter((id) => id !== app.id);
    const wrap = h("div", { class: "vg-box" }, h("h3", {}, "Depends on / used by"));
    if (!out.size && !inc.length) {
      wrap.appendChild(h("p", { class: "vg-muted" }, "No recorded dependencies."));
      return wrap;
    }
    if (!d3) {
      wrap.appendChild(
        h(
          "p",
          {},
          `Depends on: ${[...out.keys()].join(", ") || "none"}. Used by: ${inc.join(", ") || "none"}.`,
        ),
      );
      return wrap;
    }
    const rows = Math.max(out.size, inc.length, 1);
    const W = 640;
    const rowH = 46;
    const H = rows * rowH + 20;
    const scroller = h("div", { class: "vg-minigraph-wrap" });
    wrap.appendChild(scroller);
    const svg = d3
      .select(scroller)
      .append("svg")
      .attr("class", "vg-svg vg-minigraph")
      .attr("viewBox", `0 0 ${W} ${H}`)
      .attr("width", "100%")
      .attr("role", "group")
      .attr("aria-label", `${app.name} dependencies`);
    const mk = VG.svg.markers(svg.append("defs"));
    const center = { id: app.id, label: app.name || app.id, x: W / 2, y: H / 2 };
    const place = (ids, x) =>
      ids.map((id, i) => ({
        id,
        label: D.appName(id),
        x,
        y: (H - ids.length * rowH) / 2 + rowH * (i + 0.5) + 0,
      }));
    const left = place(inc, 110);
    const right = place([...out.keys()], W - 110);
    const edges = [
      ...left.map((n) => ({ a: n, b: center, label: "uses this" })),
      ...right.map((n) => ({ a: center, b: n, label: out.get(n.id) })),
    ];
    const bw = 150;
    const bh = 32;
    svg
      .append("g")
      .selectAll("path")
      .data(edges)
      .join("path")
      .attr("class", "vg-edge")
      .attr("d", (e) => {
        const x1 = e.a.x + bw / 2;
        const x2 = e.b.x - bw / 2;
        const mx = (x1 + x2) / 2;
        return `M${x1},${e.a.y} C${mx},${e.a.y} ${mx},${e.b.y} ${x2},${e.b.y}`;
      })
      .attr("marker-end", mk.normal);
    const lab = svg
      .append("g")
      .selectAll("g")
      .data(edges.filter((e) => e.label))
      .join("g")
      .attr("class", "vg-edge-label")
      .attr("transform", (e) => `translate(${(e.a.x + e.b.x) / 2},${(e.a.y + e.b.y) / 2 - 4})`);
    lab
      .append("text")
      .attr("text-anchor", "middle")
      .text((e) => (e.label.length > 34 ? e.label.slice(0, 33) + "…" : e.label));
    const nodes = [center, ...left, ...right];
    const g = svg
      .append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", "vg-node")
      .attr("transform", (n) => `translate(${n.x},${n.y})`);
    g.append("rect")
      .attr("x", -bw / 2)
      .attr("y", -bh / 2)
      .attr("width", bw)
      .attr("height", bh)
      .attr("rx", 7)
      .style("fill", (n) => (n === center ? "var(--accent-soft)" : "var(--bg-soft)"))
      .style("stroke", (n) => (n === center ? "var(--accent)" : "var(--border-strong)"));
    g.append("text")
      .attr("text-anchor", "middle")
      .attr("y", 4)
      .style("font-weight", (n) => (n === center ? 700 : 400))
      .text((n) => n.label);
    const go = (e, n) => {
      if (n !== center && D.app(n.id)) location.hash = VG.routes.app(n.id, "facts");
    };
    g.filter((n) => n !== center && Boolean(D.app(n.id))).on("click", go);
    VG.svg
      .focusable(
        g.filter((n) => n !== center && Boolean(D.app(n.id))),
        "",
        go,
      )
      .attr("aria-label", (n) => `Open ${n.label}`);
    return wrap;
  }

  /* ---------------------------------------------------------------- facts */

  function kv(pairs) {
    const dl = h("dl", { class: "vg-kv" });
    for (const [k, v] of pairs) {
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
      dl.appendChild(h("dt", {}, k));
      dl.appendChild(h("dd", {}, v));
    }
    return dl;
  }

  function facts(main, app, route) {
    const D = VG.data;
    const grid = h("div", { class: "vg-facts-grid" });
    grid.appendChild(
      h(
        "div",
        { class: "vg-box" },
        h("h3", {}, "Identity"),
        kv([
          ["Id", h("code", {}, app.id)],
          ["Kind", app.kind],
          ["Product", app.product],
          ["Package", app.package ? h("code", {}, app.package) : null],
          ["Folder", app.repoPath ? VG.ui.repoLink(app.repoPath) : null],
          ["Audience", (app.audience || []).join(", ")],
        ]),
      ),
    );
    const local = app.local || {};
    if (Object.keys(local).length) {
      grid.appendChild(
        h(
          "div",
          { class: "vg-box vg-runcard" },
          h("h3", {}, "Run locally"),
          kv([
            [
              "URL",
              local.url
                ? h(
                    "span",
                    {},
                    h("a", { href: local.url, target: "_blank", rel: "noopener noreferrer" }, local.url),
                    VG.ui.copyButton(local.url, "URL"),
                  )
                : null,
            ],
            ["Port", local.port !== null && local.port !== undefined ? String(local.port) : null],
            [
              "Command",
              local.command
                ? h("span", {}, h("code", {}, local.command), VG.ui.copyButton(local.command, "command"))
                : null,
            ],
            ["Notes", local.notes ? VG.md.block(local.notes, { app: app.id }) : null],
          ]),
        ),
      );
    }
    if (app.production && Object.keys(app.production).length) {
      grid.appendChild(
        h(
          "div",
          { class: "vg-box" },
          h("h3", {}, "Production"),
          kv(Object.entries(app.production).map(([k, v]) => [k, h("code", {}, String(v))])),
        ),
      );
    }
    if ((app.stack || []).length) {
      grid.appendChild(
        h(
          "div",
          { class: "vg-box" },
          h("h3", {}, "Stack"),
          h(
            "div",
            { class: "vg-tag-list" },
            app.stack.map((s) => h("span", { class: "vg-badge" }, s)),
          ),
        ),
      );
    }
    main.appendChild(grid);
    main.appendChild(miniGraph(app));

    const screens = app.screens || [];
    if (screens.length) {
      main.appendChild(h("h2", { id: "sec-screens" }, `Screens (${screens.length})`));
      const t = VG.ui.filterTable({
        caption: "screens",
        placeholder: "Filter screens by route, title, purpose or file…",
        initial: route.params.get("screen") || "",
        columns: [
          { key: "route", label: "Route", render: (r) => h("code", {}, r.route), text: (r) => r.route },
          { key: "title", label: "Title" },
          { key: "purpose", label: "Purpose" },
          {
            key: "code",
            label: "Code",
            render: (r) =>
              r.code ? [].concat(r.code).map((c) => VG.ui.repoLink(c, c.split("/").slice(-2).join("/"))) : "",
            text: (r) => [].concat(r.code || []).join(" "),
          },
        ],
        rows: screens,
      });
      main.appendChild(t.el);
    }
    const eps = app.endpoints || [];
    if (eps.length) {
      main.appendChild(h("h2", { id: "sec-endpoints" }, `Endpoints (${eps.length})`));
      const t = VG.ui.filterTable({
        caption: "endpoints",
        placeholder: "Filter endpoints by method, path, operationId or purpose…",
        initial: route.params.get("endpoint") || "",
        columns: [
          {
            key: "method",
            label: "Method",
            render: (r) =>
              h(
                "span",
                { class: `vg-badge is-${String(r.method || "").toLowerCase()}` },
                String(r.method || "").toUpperCase(),
              ),
            text: (r) => String(r.method || ""),
          },
          { key: "path", label: "Path", render: (r) => h("code", {}, r.path), text: (r) => r.path },
          {
            key: "operationId",
            label: "Operation",
            render: (r) => (r.operationId ? h("code", {}, r.operationId) : ""),
            text: (r) => r.operationId || "",
          },
          { key: "purpose", label: "Purpose", text: (r) => `${r.purpose || ""} ${r.tag || ""}` },
        ],
        rows: eps,
      });
      main.appendChild(t.el);
    }
    const roles = app.roles || [];
    if (roles.length) {
      main.appendChild(h("h2", {}, "Roles"));
      const t = VG.ui.filterTable({
        caption: "roles",
        placeholder: "Filter roles…",
        columns: [
          { key: "name", label: "Role", render: (r) => h("strong", {}, r.name), text: (r) => r.name },
          { key: "can", label: "Can" },
        ],
        rows: roles,
      });
      main.appendChild(t.el);
    }
    if ((app.data || []).length) {
      main.appendChild(h("h2", {}, "Data it touches"));
      main.appendChild(
        h(
          "div",
          { class: "vg-tag-list" },
          app.data.map((d) =>
            h(
              "a",
              { class: "vg-chip", href: VG.routes.search(d), title: `Search the guide for ${d}` },
              h("code", {}, d),
            ),
          ),
        ),
      );
    }
    const docs = [...(app.docs || [])];
    const adrs = [...(app.adrs || [])];
    if (docs.length || adrs.length) {
      main.appendChild(h("h2", {}, "Docs and ADRs"));
      const g2 = h("div", { class: "vg-facts-grid" });
      if (docs.length)
        g2.appendChild(
          h(
            "div",
            { class: "vg-box" },
            h("h3", {}, "Docs"),
            h(
              "ul",
              { class: "vg-linklist" },
              docs.map((p) => h("li", {}, VG.ui.repoLink(p))),
            ),
          ),
        );
      if (adrs.length)
        g2.appendChild(
          h(
            "div",
            { class: "vg-box" },
            h("h3", {}, "ADRs"),
            h(
              "ul",
              { class: "vg-linklist" },
              adrs.map((p) => h("li", {}, VG.ui.repoLink(p))),
            ),
          ),
        );
      main.appendChild(g2);
    }
    const diagrams = (app.diagrams || []).map((id) => D.diagram(id, app.id)).filter(Boolean);
    const journeys = (app.journeys || []).map((id) => D.journeys.get(id)).filter(Boolean);
    if (diagrams.length || journeys.length) {
      main.appendChild(h("h2", {}, "Diagrams and journeys"));
      const g3 = h("div", { class: "vg-facts-grid" });
      if (diagrams.length) {
        g3.appendChild(
          h(
            "div",
            { class: "vg-box" },
            h("h3", {}, `Diagrams (${diagrams.length})`),
            h(
              "ul",
              { class: "vg-linklist" },
              diagrams.map((d) =>
                h(
                  "li",
                  {},
                  h("a", { href: VG.routes.diagram(d.key) }, d.title),
                  " ",
                  h("span", { class: "vg-badge" }, d.type),
                ),
              ),
            ),
          ),
        );
      }
      if (journeys.length) {
        g3.appendChild(
          h(
            "div",
            { class: "vg-box" },
            h("h3", {}, `Journeys (${journeys.length})`),
            h(
              "ul",
              { class: "vg-linklist" },
              journeys.map((j) => h("li", {}, h("a", { href: VG.routes.journey(j.id) }, j.title))),
            ),
          ),
        );
      }
      main.appendChild(g3);
    }
    if ((app.tags || []).length) {
      main.appendChild(
        h(
          "p",
          { class: "vg-meta", style: { marginTop: "20px" } },
          "Tags: ",
          app.tags.map((t) => h("span", { class: "vg-badge" }, t)),
        ),
      );
    }
    const target = route.params.get("screen")
      ? "sec-screens"
      : route.params.get("endpoint")
        ? "sec-endpoints"
        : null;
    if (target) setTimeout(() => document.getElementById(target)?.scrollIntoView({ block: "start" }), 0);
  }

  VG.views.register("app", {
    title(route) {
      const a = VG.data.app(route.path[1]);
      const tab = TABS.find((t) => t.id === route.path[2]) || TABS[0];
      return a ? `${a.name} · ${tab.label}` : "App not found";
    },
    render(main, route) {
      const D = VG.data;
      const app = D.app(route.path[1]);
      if (!app) {
        VG.layout.setCrumbs([{ label: "Apps" }, { label: "Not found" }]);
        main.appendChild(VG.ui.empty("App not found", `There is no app “${route.path[1] || ""}”.`));
        return {};
      }
      const tab = TABS.some((t) => t.id === route.path[2]) ? route.path[2] : "usage";
      VG.layout.setCrumbs([
        { label: "Apps" },
        { label: app.name, href: VG.routes.app(app.id) },
        { label: TABS.find((t) => t.id === tab).label },
      ]);
      if (tab === "facts") {
        main.appendChild(header(app, tab));
        facts(main, app, route);
        return {};
      }
      const doc = app[tab];
      if (!doc) {
        main.appendChild(header(app, tab));
        main.appendChild(
          VG.ui.empty(`No ${tab} guide yet`, `Add content/apps/${app.id}/${tab}.md and rebuild.`),
        );
        return {};
      }
      return VG.renderDoc(main, {
        header: header(app, tab),
        md: doc.md,
        base: VG.routes.app(app.id, tab),
        app: app.id,
      });
    },
  });
})();
