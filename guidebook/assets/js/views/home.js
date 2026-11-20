/* Velexis Guidebook view: home (summary, interactive system map, counts, section cards). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  const APP_KIND_LAYERS = [
    { id: "frontend", label: "Frontends" },
    { id: "backend", label: "APIs" },
    { id: "worker", label: "Workers" },
    { id: "library", label: "Libraries" },
    { id: "tooling", label: "Tooling" },
    { id: "infrastructure", label: "Infrastructure" },
  ];
  const APP_KIND_TO_NODE = {
    frontend: "ui",
    backend: "api",
    worker: "worker",
    library: "lib",
    tooling: "lib",
    infrastructure: "edge",
  };

  /** Model for the map: lanes, nodes and links from topology.json (+ app dependsOn), or from app.json alone. */
  function mapModel() {
    const D = VG.data;
    const topo = D.c.topology;
    const apps = D.appList();
    if (topo && (topo.nodes || []).length) {
      const nodes = topo.nodes.map((n) => ({ ...n, app: D.resolveApp(n.app) }));
      const links = (topo.links || []).map((l) => ({ ...l }));
      const has = (a, b) => links.some((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a));
      const nodeOfApp = (id) => nodes.find((n) => n.app === id);
      for (const a of apps) {
        for (const dep of a.dependsOn || []) {
          const x = nodeOfApp(a.id);
          const y = nodeOfApp(D.resolveApp(dep));
          if (x && y && x !== y && !has(x.id, y.id))
            links.push({ from: x.id, to: y.id, label: "depends on", kind: "dep" });
        }
      }
      return { lanes: topo.layers || [], nodes, links };
    }
    const nodes = apps.map((a) => ({
      id: a.id,
      label: a.name || a.id,
      layer: a.kind || "library",
      app: a.id,
      kind: APP_KIND_TO_NODE[a.kind] || "lib",
      detail: a.summary || "",
    }));
    const links = [];
    for (const a of apps) {
      for (const dep of a.dependsOn || [])
        links.push({ from: a.id, to: D.resolveApp(dep), label: "depends on", kind: "sync" });
    }
    const used = new Set(nodes.map((n) => n.layer));
    return { lanes: APP_KIND_LAYERS.filter((l) => used.has(l.id)), nodes, links };
  }

  /** Draws the layered system map into `host`. */
  function drawMap(host) {
    const d3 = window.d3;
    const model = mapModel();
    if (!model.nodes.length) {
      host.appendChild(h("p", { class: "vg-muted", style: { padding: "12px" } }, "No apps or topology yet."));
      return null;
    }
    if (!d3) {
      const ul = h("ul", { class: "vg-fallback-list" });
      model.nodes.forEach((n) =>
        ul.appendChild(h("li", {}, n.app ? h("a", { href: VG.routes.app(n.app) }, n.label) : n.label)),
      );
      host.appendChild(ul);
      return null;
    }
    const lanes = model.lanes.filter((l) => model.nodes.some((n) => n.layer === l.id));
    const laneIndex = new Map(lanes.map((l, i) => [l.id, i]));
    const nodes = model.nodes.filter((n) => laneIndex.has(n.layer));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = model.links.filter((l) => byId.has(l.from) && byId.has(l.to));
    // order nodes in lanes by the barycentre of their neighbours (two sweeps)
    const perLane = lanes.map((l) => nodes.filter((n) => n.layer === l.id));
    perLane.forEach((list) => list.forEach((n, i) => (n._x = i / Math.max(1, list.length - 1 || 1))));
    for (let sweep = 0; sweep < 3; sweep++) {
      for (const list of perLane) {
        for (const n of list) {
          const ns = links
            .filter((l) => l.from === n.id || l.to === n.id)
            .map((l) => byId.get(l.from === n.id ? l.to : l.from));
          n._b = ns.length ? d3.mean(ns, (m) => m._x) : n._x;
        }
        list.sort((a, b) => a._b - b._b);
        list.forEach((n, i) => (n._x = list.length === 1 ? 0.5 : i / (list.length - 1)));
      }
    }
    const maxPer = d3.max(perLane, (l) => l.length) || 1;
    const labelW = 104;
    const nodeW = 146;
    const nodeH = 46;
    const gap = 12;
    const laneH = 84;
    const width = Math.max(720, labelW + maxPer * (nodeW + gap) + 30);
    const height = lanes.length * laneH + 10;
    perLane.forEach((list, li) => {
      const span = width - labelW - 30;
      const step = span / list.length;
      list.forEach((n, i) => {
        n.x = labelW + step * (i + 0.5);
        n.y = li * laneH + laneH / 2 + 5;
      });
    });

    const svg = d3
      .select(host)
      .append("svg")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("width", "100%")
      .attr("role", "group")
      .attr("aria-label", "System map: layers, applications and how they talk")
      .attr("class", "vg-svg vg-map-svg")
      .style("max-height", `${Math.max(320, height)}px`);
    const defs = svg.append("defs");
    const mk = VG.svg.markers(defs);
    const laneG = svg.append("g");
    lanes.forEach((l, i) => {
      const g = laneG.append("g").attr("class", "vg-map-layer");
      g.append("rect")
        .attr("x", 0)
        .attr("y", i * laneH + 5)
        .attr("width", width)
        .attr("height", laneH);
      // long lane titles take two lines so they stay clear of the first box
      const ls = VG.svg.lines(l.label || l.id, 10).slice(0, 2);
      const t = g
        .append("text")
        .attr("x", 14)
        .attr("y", i * laneH + 5 + laneH / 2 + 4);
      ls.forEach((x, k) =>
        t
          .append("tspan")
          .attr("x", 14)
          .attr("dy", k === 0 ? (ls.length === 1 ? 0 : -7) : 15)
          .text(x),
      );
    });
    const linkG = svg.append("g");
    const path = (l) => {
      const a = byId.get(l.from);
      const b = byId.get(l.to);
      if (a.y === b.y) {
        const mx = (a.x + b.x) / 2;
        return `M${a.x},${a.y - nodeH / 2} Q${mx},${a.y - laneH * 0.75} ${b.x},${b.y - nodeH / 2}`;
      }
      const down = b.y > a.y;
      const y1 = a.y + (down ? nodeH / 2 : -nodeH / 2);
      const y2 = b.y + (down ? -nodeH / 2 : nodeH / 2);
      const my = (y1 + y2) / 2;
      return `M${a.x},${y1} C${a.x},${my} ${b.x},${my} ${b.x},${y2}`;
    };
    const linkSel = linkG
      .selectAll("path")
      .data(links)
      .join("path")
      .attr(
        "class",
        (l) =>
          `vg-edge ${l.kind === "async" ? "is-async" : l.kind === "data" ? "is-data" : l.kind === "dep" ? "is-async" : ""}`,
      )
      .attr("d", path)
      .attr("marker-end", mk.normal);
    linkSel
      .append("title")
      .text((l) => `${byId.get(l.from).label} → ${byId.get(l.to).label}: ${l.label || ""}`);

    const nodeG = svg.append("g");
    const nodeSel = nodeG
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", "vg-node vg-map-node")
      .attr("transform", (n) => `translate(${n.x},${n.y})`);
    nodeSel
      .append("rect")
      .attr("x", -nodeW / 2)
      .attr("y", -nodeH / 2)
      .attr("width", nodeW)
      .attr("height", nodeH)
      .attr("rx", 8)
      .style("fill", (n) => `color-mix(in srgb, ${VG.kindVar(n.kind)} 14%, var(--panel))`)
      .style("stroke", (n) => VG.kindVar(n.kind));
    nodeSel.each(function (n) {
      VG.svg.icon(d3.select(this), n.kind, -nodeW / 2 + 8, -8, 16).style("stroke", VG.kindVar(n.kind));
    });
    // labels wrap onto two lines (cut only past that) so every box stays readable
    nodeSel.each(function (n) {
      const all = VG.svg.lines(n.label, 17);
      const ls = all.slice(0, 2);
      if (all.length > 2) ls[1] = ls[1].slice(0, 15) + "…";
      const t = d3.select(this).append("text").attr("text-anchor", "middle");
      ls.forEach((l, i) =>
        t
          .append("tspan")
          .attr("x", 9)
          .attr("dy", i === 0 ? (ls.length === 1 ? 4.5 : -3) : 15)
          .text(l),
      );
    });
    nodeSel.append("title").text((n) => `${n.label}${n.app ? " — open the app" : ""}`);

    const neighbours = (n) => {
      const set = new Set([n.id]);
      links.forEach((l) => {
        if (l.from === n.id) set.add(l.to);
        if (l.to === n.id) set.add(l.from);
      });
      return set;
    };
    const highlight = (n) => {
      if (!n) {
        nodeSel.classed("vg-faded", false);
        linkSel.classed("vg-faded", false).classed("is-hl", false).attr("marker-end", mk.normal);
        return;
      }
      const set = neighbours(n);
      nodeSel.classed("vg-faded", (m) => !set.has(m.id));
      linkSel
        .classed("vg-faded", (l) => l.from !== n.id && l.to !== n.id)
        .classed("is-hl", (l) => l.from === n.id || l.to === n.id)
        .attr("marker-end", (l) => (l.from === n.id || l.to === n.id ? mk.hl : mk.normal));
    };
    const activate = (e, n) => {
      if (n.app && VG.data.app(n.app)) {
        location.hash = VG.routes.app(n.app);
        return;
      }
      const extra = h("div", { class: "vg-popover-links" });
      links
        .filter((l) => l.from === n.id || l.to === n.id)
        .forEach((l) => {
          const other = byId.get(l.from === n.id ? l.to : l.from);
          extra.appendChild(
            h(
              "span",
              { class: "vg-badge" },
              `${l.from === n.id ? "→" : "←"} ${other.label}: ${l.label || ""}`,
            ),
          );
        });
      const body = h("div", {}, n.detail ? VG.md.block(n.detail) : null, extra);
      VG.ui.popover(e.currentTarget, n.label, body, {
        kind: n.kind,
        badge: VG.KIND_LABELS[n.kind] || n.kind,
      });
    };
    nodeSel
      .on("mouseenter", (e, n) => highlight(n))
      .on("mouseleave", () => highlight(null))
      .on("focus", (e, n) => highlight(n))
      .on("blur", () => highlight(null))
      .on("click", activate);
    VG.svg
      .focusable(nodeSel, "", activate)
      .attr(
        "aria-label",
        (n) => `${n.label} (${VG.KIND_LABELS[n.kind] || n.kind})${n.app ? ", opens the app" : ""}`,
      );

    const kinds = [...new Set(nodes.map((n) => n.kind))];
    const legend = h(
      "div",
      { class: "vg-legend" },
      kinds.map((k) =>
        h(
          "span",
          {},
          h("span", { class: "vg-kind-dot", style: { background: VG.kindVar(k) } }),
          VG.KIND_LABELS[k] || k,
        ),
      ),
      h("span", {}, h("span", { class: "vg-legend-line" }), "sync"),
      h("span", {}, h("span", { class: "vg-legend-line is-async" }), "async / depends on"),
      h("span", {}, h("span", { class: "vg-legend-line is-data" }), "data"),
    );
    host.appendChild(legend);
    return { svg };
  }

  function stat(n, label, href) {
    return h(
      href ? "a" : "div",
      { class: "vg-stat", href: href || null },
      h("span", { class: "vg-stat-n" }, String(n || 0)),
      h("span", { class: "vg-stat-l" }, label),
    );
  }

  VG.views.register("home", {
    title: () => "Home",
    // no table of contents: the map, the counts and the cards use the full width
    wide: true,
    render(main) {
      const D = VG.data;
      const site = D.site;
      const st = D.c.stats || {};
      VG.layout.setCrumbs([]);
      const overview = D.pages.get("overview");
      const start = D.pages.get("getting-started");
      main.appendChild(
        h(
          "section",
          { class: "vg-hero" },
          h("h1", {}, site.title || "Velexis Guidebook"),
          site.tagline ? h("p", { class: "vg-lede" }, site.tagline) : null,
          overview && overview.summary ? h("p", {}, overview.summary) : null,
          h(
            "div",
            { class: "vg-toolbar" },
            overview
              ? h("a", { class: "vg-btn is-primary", href: VG.routes.page("overview") }, "Read the overview")
              : null,
            start
              ? h("a", { class: "vg-btn", href: VG.routes.page("getting-started") }, "Getting started")
              : null,
            h("a", { class: "vg-btn", href: "#/journeys" }, VG.icon("journey", null, 16), "Walk a journey"),
            h(
              "button",
              { class: "vg-btn", type: "button", onclick: () => VG.palette.open("") },
              VG.icon("search", null, 16),
              "Search",
              h("kbd", {}, "Ctrl K"),
            ),
          ),
          site.commit || site.date
            ? h(
                "p",
                { class: "vg-meta" },
                `Describes the code at ${site.commit || "HEAD"}${site.date ? " (" + site.date + ")" : ""}.`,
              )
            : null,
        ),
      );

      main.appendChild(h("h2", { id: "sec-system-map" }, "System map"));
      main.appendChild(
        h(
          "p",
          { class: "vg-muted" },
          "Hover a box to see what it talks to; click an application to open its guide. Lanes run from people (top) to external services (bottom).",
        ),
      );
      const mapHost = h("div", { class: "vg-map" });
      main.appendChild(mapHost);
      drawMap(mapHost);

      main.appendChild(h("h2", {}, "At a glance"));
      main.appendChild(
        h(
          "div",
          { class: "vg-stats" },
          stat(st.apps, "apps", null),
          stat(st.screens, "screens", null),
          stat(st.endpoints, "endpoints", null),
          stat(st.journeys, "journeys", "#/journeys"),
          stat(st.journeySteps, "journey steps", "#/journeys"),
          st.issues ? stat(st.issues, "known issues", "#/issues") : null,
          stat(st.diagrams, "diagrams", null),
          stat(st.terms, "glossary terms", "#/glossary"),
          stat(st.classes, "ontology classes", "#/ontology"),
          stat(st.graphNodes, "graph nodes", "#/graph"),
          stat(st.flows, "request flows", "#/system"),
          stat(st.pages, "pages", null),
        ),
      );

      main.appendChild(h("h2", {}, "Applications"));
      const apps = D.appList();
      if (!apps.length) main.appendChild(h("p", { class: "vg-muted" }, "No app content yet."));
      for (const g of D.appGroups()) {
        main.appendChild(h("h3", {}, g.label));
        main.appendChild(
          h(
            "div",
            { class: "vg-cards" },
            g.apps.map((a) =>
              h(
                "div",
                { class: "vg-card" },
                h(
                  "a",
                  { class: "vg-card-title", href: VG.routes.app(a.id) },
                  h("span", {
                    class: "vg-kind-dot",
                    style: { background: `var(--p-${a.product || "shared"})` },
                  }),
                  a.name || a.id,
                ),
                h("span", { class: "vg-card-text" }, a.summary || ""),
                h(
                  "div",
                  { class: "vg-card-foot" },
                  h("span", { class: "vg-badge" }, a.kind || "app"),
                  h("a", { href: VG.routes.app(a.id, "usage") }, "Usage"),
                  h("a", { href: VG.routes.app(a.id, "architecture") }, "Architecture"),
                  h("a", { href: VG.routes.app(a.id, "facts") }, "Facts"),
                ),
              ),
            ),
          ),
        );
      }

      main.appendChild(h("h2", {}, "Explore"));
      const explore = [
        [
          "#/journeys",
          "journey",
          "Journeys",
          "Cross-app walkthroughs with a pass / bug / skip checklist and bug-report template.",
        ],
        ...(st.issues
          ? [
              [
                "#/issues",
                "bug",
                "Known issues",
                `${st.issues} verified bugs to fix, by severity, kind and app, with steps, expected result and the files to change.`,
              ],
            ]
          : []),
        [
          "#/glossary",
          "term",
          "Glossary",
          "Every term with definition, aliases, related terms and where it is used.",
        ],
        [
          "#/taxonomy",
          "tree",
          "Taxonomy",
          "The system classified: products, domains, capabilities, concepts.",
        ],
        [
          "#/graph",
          "graph",
          "Knowledge graph",
          "Apps, terms, classes and journeys as one navigable graph, in 2D or 3D.",
        ],
        [
          "#/ontology",
          "class",
          "Ontology",
          "Classes, properties and individuals: what kinds of things exist and how they relate.",
        ],
        [
          "#/system",
          "cube",
          "System 3D",
          "The deployment in layers, with request flows animated hop by hop.",
        ],
      ];
      main.appendChild(
        h(
          "div",
          { class: "vg-cards" },
          explore.map(([href, icon, title, text]) =>
            h(
              "a",
              { class: "vg-card", href },
              h("span", { class: "vg-card-title" }, VG.icon(icon), title),
              h("span", { class: "vg-card-text" }, text),
            ),
          ),
        ),
      );
      const pages = D.pageList();
      if (pages.length) {
        main.appendChild(h("h2", {}, "Guide pages"));
        main.appendChild(
          h(
            "div",
            { class: "vg-cards" },
            pages.map((p) =>
              h(
                "a",
                { class: "vg-card", href: VG.routes.page(p.id) },
                h("span", { class: "vg-card-title" }, VG.icon("page"), p.title),
                h("span", { class: "vg-card-text" }, p.summary || ""),
              ),
            ),
          ),
        );
      }
      return {};
    },
  });

  VG.homeMap = { mapModel, drawMap };
})();
