/*
 * Velexis Guidebook view: ontology (#/ontology, #/ontology/<ClassId>?individual=<id>): class hierarchy (tree or
 * radial), property diagram (domain -> range), tables of classes, properties, individuals and assertions.
 */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  function hierarchyData() {
    const D = VG.data;
    const classes = D.c.ontology.classes || [];
    const kids = new Map();
    for (const c of classes) {
      const p = c.parent && D.classes.has(c.parent) ? c.parent : "__root";
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(c);
    }
    const build = (c) => ({ id: c.id, name: c.label || c.id, children: (kids.get(c.id) || []).map(build) });
    const roots = kids.get("__root") || [];
    // an ontology with a single root class (its own "Thing") needs no synthetic root above it
    if (roots.length === 1) return build(roots[0]);
    return { id: "__root", name: "Thing", children: roots.map(build) };
  }

  function drawHierarchy(host, mode, onPick, selected) {
    const d3 = window.d3;
    const root = d3.hierarchy(hierarchyData());
    const { svg, g } = VG.svg.create(host, {
      height: mode === "radial" ? 520 : Math.max(320, Math.min(640, root.leaves().length * 26 + 60)),
      label: "Class hierarchy",
    });
    const zoom = VG.svg.zoomable(svg, g, { min: 0.2, max: 3, instant: true });
    if (mode === "radial") {
      // Leaves sit on the outer ring about 16 px apart, so the ring grows with the class count; a large hierarchy
      // then scrolls (below) at a legible scale instead of shrinking into the box.
      const r = Math.max(120, Math.ceil((root.leaves().length * 16) / (2 * Math.PI)));
      d3.cluster().size([2 * Math.PI, r])(root);
      g.append("g")
        .selectAll("path")
        .data(root.links())
        .join("path")
        .attr("class", "vg-tax-link")
        .attr(
          "d",
          d3
            .linkRadial()
            .angle((d) => d.x)
            .radius((d) => d.y),
        );
      const node = g
        .append("g")
        .selectAll("g")
        .data(root.descendants())
        .join("g")
        .attr("class", "vg-tax-node vg-node")
        .attr("transform", (d) => `rotate(${(d.x * 180) / Math.PI - 90}) translate(${d.y},0)`);
      node
        .append("circle")
        .attr("r", (d) => (d.depth === 0 ? 6 : 5))
        .style("fill", (d) => (d.data.id === selected ? "var(--accent)" : "var(--g-class)"))
        .style("stroke", "var(--panel)");
      node
        .append("text")
        .attr("dy", "0.31em")
        .attr("x", (d) => (d.depth === 0 ? 0 : d.x < Math.PI === !d.children ? 8 : -8))
        .attr("dy", (d) => (d.depth === 0 ? "-0.9em" : "0.31em"))
        .attr("text-anchor", (d) =>
          d.depth === 0 ? "middle" : d.x < Math.PI === !d.children ? "start" : "end",
        )
        // the root's label stays level above its dot, clear of the first ring's labels
        .attr("transform", (d) =>
          d.depth === 0 ? `rotate(${90 - (d.x * 180) / Math.PI})` : d.x >= Math.PI ? "rotate(180)" : null,
        )
        .style("font-weight", (d) => (d.data.id === selected ? 700 : 400))
        .text((d) => d.data.name);
      const pick = (e, d) => d.data.id !== "__root" && onPick(d.data.id);
      node.on("click", pick);
      VG.svg
        .focusable(
          node.filter((d) => d.depth > 0),
          "",
          pick,
        )
        .attr("aria-label", (d) => `Class ${d.data.name}`);
    } else {
      d3.tree().nodeSize([26, 170])(root);
      g.append("g")
        .selectAll("path")
        .data(root.links())
        .join("path")
        .attr("class", "vg-tax-link")
        .attr(
          "d",
          d3
            .linkHorizontal()
            .x((d) => d.y)
            .y((d) => d.x),
        );
      const node = g
        .append("g")
        .selectAll("g")
        .data(root.descendants())
        .join("g")
        .attr("class", "vg-tax-node vg-node")
        .attr("transform", (d) => `translate(${d.y},${d.x})`);
      node
        .append("circle")
        .attr("r", 6)
        .style("fill", (d) =>
          d.data.id === selected ? "var(--accent)" : d.children ? "var(--panel)" : "var(--g-class)",
        )
        .style("stroke", "var(--g-class)");
      node
        .append("text")
        .attr("dy", "0.32em")
        .attr("x", (d) => (d.children ? -10 : 10))
        .attr("text-anchor", (d) => (d.children ? "end" : "start"))
        .style("font-weight", (d) => (d.data.id === selected ? 700 : 400))
        .text((d) => d.data.name);
      const pick = (e, d) => d.data.id !== "__root" && onPick(d.data.id);
      node.on("click", pick);
      VG.svg
        .focusable(
          node.filter((d) => d.depth > 0),
          "",
          pick,
        )
        .attr("aria-label", (d) => `Class ${d.data.name}`);
    }
    // A large hierarchy keeps a legible scale (at least 0.8): the SVG takes the drawing's own size and the figure body
    // scrolls, instead of shrinking 100+ classes into one box. Same for the tree and the radial layout.
    let scroll = false;
    if (g.node().isConnected) {
      const box = g.node().getBBox();
      const avail = host.clientWidth || 600;
      const hgt = Number(svg.attr("height")) || 640;
      if (box.width && box.height && Math.min((avail - 48) / box.width, (hgt - 48) / box.height) < 0.8) {
        const k = Math.max(0.8, Math.min(1, (avail - 48) / box.width));
        svg.attr("width", Math.ceil(box.width * k + 48)).attr("height", Math.ceil(box.height * k + 48));
        scroll = true;
      }
    }
    host.classList.toggle("vg-figure-scroll", scroll);
    zoom.fit(24);
    if (scroll) {
      const el = selected
        ? g
            .selectAll(".vg-tax-node")
            .filter((d) => d.data.id === selected)
            .node()
        : null;
      if (el) {
        const r = el.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        host.scrollTop += r.top - hr.top - host.clientHeight / 2;
        host.scrollLeft += r.left - hr.left - host.clientWidth / (mode === "radial" ? 2 : 3);
      } else if (mode === "radial") {
        host.scrollTop = (host.scrollHeight - host.clientHeight) / 2;
        host.scrollLeft = (host.scrollWidth - host.clientWidth) / 2;
      }
    }
    return { fit: () => zoom.fit(24), zoomBy: zoom.zoomBy };
  }

  /** Classes as nodes, properties as labelled directed edges domain -> range. */
  function drawProperties(host, onPick, selected) {
    const d3 = window.d3;
    const D = VG.data;
    const props = (D.c.ontology.properties || []).filter(
      (p) => D.classes.has(p.domain) && D.classes.has(p.range),
    );
    const ids = new Set();
    props.forEach((p) => {
      ids.add(p.domain);
      ids.add(p.range);
    });
    if (!props.length) {
      host.appendChild(h("p", { class: "vg-muted", style: { padding: "12px" } }, "No properties defined."));
      return {};
    }
    const nodes = [...ids].map((id) => ({ id, label: (D.classes.get(id) || {}).label || id }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // parallel edges get increasing curvature
    const pairCount = new Map();
    const links = props.map((p) => {
      const key = [p.domain, p.range].sort().join("|");
      const i = pairCount.get(key) || 0;
      pairCount.set(key, i + 1);
      return { p, source: p.domain, target: p.range, idx: i, flip: p.domain > p.range };
    });
    const { svg, g, defs } = VG.svg.create(host, { height: 480, label: "Property diagram" });
    const mk = VG.svg.markers(defs);
    const zoom = VG.svg.zoomable(svg, g, { min: 0.2, max: 3, instant: true });
    const sim = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(160),
      )
      .force("charge", d3.forceManyBody().strength(-520).distanceMax(420))
      .force("x", d3.forceX(0).strength(0.09))
      .force("y", d3.forceY(0).strength(0.12))
      .force(
        "collide",
        d3.forceCollide((n) => Math.max(70, n.label.length * 7 + 20) / 2 + 16),
      )
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    const bw = (n) => Math.max(70, n.label.length * 7 + 20);
    const pathOf = (l) => {
      const s = l.source;
      const t = l.target;
      if (s === t) {
        const r = 26 + l.idx * 12;
        return `M${s.x - 10},${s.y - 15} C${s.x - r * 2},${s.y - r * 3} ${s.x + r * 2},${s.y - r * 3} ${s.x + 10},${s.y - 15}`;
      }
      const [x1, y1] = VG.svg.boxEdge(s.x, s.y, bw(s) + 6, 36, t.x, t.y);
      const [x2, y2] = VG.svg.boxEdge(t.x, t.y, bw(t) + 6, 36, s.x, s.y);
      const bend =
        (l.idx === 0 && (pairCount.get([l.p.domain, l.p.range].sort().join("|")) || 1) === 1
          ? 0
          : (l.idx + 1) * 28) * (l.flip ? -1 : 1);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const cx = mx - (dy / len) * bend;
      const cy = my + (dx / len) * bend;
      l.lx = (mx + cx) / 2;
      l.ly = (my + cy) / 2;
      return `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
    };
    const linkSel = g
      .append("g")
      .selectAll("path")
      .data(links)
      .join("path")
      .attr("class", "vg-edge")
      .attr("d", pathOf)
      .attr("marker-end", mk.normal);
    linkSel
      .append("title")
      .text(
        (l) =>
          `${l.p.label || l.p.id}: ${l.p.domain} → ${l.p.range}${l.p.cardinality ? " (" + l.p.cardinality + ")" : ""}. ${l.p.description || ""}`,
      );
    const lab = g
      .append("g")
      .selectAll("g")
      .data(links)
      .join("g")
      .attr("class", "vg-edge-label")
      .attr("transform", (l) =>
        l.source === l.target
          ? `translate(${l.source.x},${l.source.y - 60 - l.idx * 22})`
          : `translate(${l.lx},${l.ly})`,
      );
    lab
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.32em")
      .text((l) => `${l.p.label || l.p.id}${l.p.cardinality ? " [" + l.p.cardinality + "]" : ""}`);
    lab.each(function () {
      const t = this.querySelector("text");
      const b = t.getBBox();
      d3.select(this)
        .insert("rect", "text")
        .attr("x", b.x - 3)
        .attr("y", b.y - 1)
        .attr("width", b.width + 6)
        .attr("height", b.height + 2)
        .attr("rx", 3);
    });
    const node = g
      .append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", "vg-node")
      .attr("transform", (n) => `translate(${n.x},${n.y})`);
    node
      .append("rect")
      .attr("x", (n) => -bw(n) / 2)
      .attr("y", -18)
      .attr("width", bw)
      .attr("height", 36)
      .attr("rx", 18)
      .style("fill", (n) =>
        n.id === selected ? "var(--accent-soft)" : "color-mix(in srgb, var(--g-class) 14%, var(--panel))",
      )
      .style("stroke", (n) => (n.id === selected ? "var(--accent)" : "var(--g-class)"));
    node
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.32em")
      .style("font-weight", 600)
      .text((n) => n.label);
    const hl = (n) => {
      linkSel
        .classed("is-hl", (l) => n && (l.source.id === n.id || l.target.id === n.id))
        .attr("marker-end", (l) => (n && (l.source.id === n.id || l.target.id === n.id) ? mk.hl : mk.normal));
      lab.classed("vg-faded", (l) => n && l.source.id !== n.id && l.target.id !== n.id);
      linkSel.classed("vg-faded", (l) => n && l.source.id !== n.id && l.target.id !== n.id);
    };
    node.on("mouseenter", (e, n) => hl(n)).on("mouseleave", () => hl(selected ? byId.get(selected) : null));
    const pick = (e, n) => onPick(n.id);
    node.on("click", pick);
    VG.svg.focusable(node, "", pick).attr("aria-label", (n) => `Class ${n.label}`);
    if (selected && byId.has(selected)) hl(byId.get(selected));
    zoom.fit(30);
    return { fit: () => zoom.fit(30), zoomBy: zoom.zoomBy };
  }

  function classPanel(panel, id) {
    const D = VG.data;
    VG.clear(panel);
    const c = D.classes.get(id);
    if (!c) {
      panel.appendChild(h("h2", {}, id ? "Unknown class" : "Pick a class"));
      panel.appendChild(
        h(
          "p",
          { class: "vg-muted" },
          "Click a class in the hierarchy, the property diagram or the table to see its properties, individuals and glossary terms.",
        ),
      );
      return;
    }
    const chain = [];
    let p = c.parent;
    while (p && D.classes.has(p) && chain.length < 20) {
      chain.unshift(D.classes.get(p));
      p = D.classes.get(p).parent;
    }
    // the synthetic "Thing" only when the ontology has several root classes (otherwise its own root starts the chain)
    const singleRoot =
      (D.c.ontology.classes || []).filter((x) => !x.parent || !D.classes.has(x.parent)).length === 1;
    const crumbs = chain.map((x) => h("a", { href: VG.routes.cls(x.id) }, x.label || x.id));
    if (!singleRoot) crumbs.unshift(h("a", { href: "#/ontology" }, "Thing"));
    if (crumbs.length)
      panel.appendChild(
        h(
          "p",
          { class: "vg-meta" },
          crumbs.map((a, i) => (i ? [" › ", a] : a)),
        ),
      );
    panel.appendChild(
      h(
        "h2",
        { id: "vg-class-title", tabindex: "-1" },
        c.label || c.id,
        " ",
        h("code", { style: { fontSize: "0.75rem" } }, c.id),
      ),
    );
    if (c.description) panel.appendChild(VG.md.block(c.description));
    if ((c.examples || []).length)
      panel.appendChild(
        h(
          "p",
          { class: "vg-meta" },
          "Examples: ",
          c.examples.map((e) => h("code", {}, e)),
        ),
      );
    const subs = (D.c.ontology.classes || []).filter((x) => x.parent === c.id);
    if (subs.length) {
      panel.appendChild(h("h3", {}, `Subclasses (${subs.length})`));
      panel.appendChild(
        h(
          "div",
          { class: "vg-tag-list" },
          subs.map((s) => h("a", { class: "vg-chip", href: VG.routes.cls(s.id) }, s.label || s.id)),
        ),
      );
    }
    const props = D.c.ontology.properties || [];
    const outP = props.filter((x) => x.domain === c.id);
    const inP = props.filter((x) => x.range === c.id);
    panel.appendChild(h("h3", {}, `Properties (${outP.length + inP.length})`));
    if (!outP.length && !inP.length) panel.appendChild(h("p", { class: "vg-muted" }, "None."));
    const propLine = (x, dir) =>
      h(
        "li",
        {},
        dir === "out"
          ? [
              h("strong", {}, x.label || x.id),
              " → ",
              h("a", { href: VG.routes.cls(x.range) }, (D.classes.get(x.range) || {}).label || x.range),
            ]
          : [
              h("a", { href: VG.routes.cls(x.domain) }, (D.classes.get(x.domain) || {}).label || x.domain),
              " → ",
              h("strong", {}, x.label || x.id),
              " → this",
            ],
        x.cardinality ? h("span", { class: "vg-muted" }, ` [${x.cardinality}]`) : null,
      );
    if (outP.length || inP.length)
      panel.appendChild(
        h(
          "ul",
          {},
          outP.map((x) => propLine(x, "out")),
          inP.map((x) => propLine(x, "in")),
        ),
      );
    const inds = (D.c.ontology.individuals || []).filter((x) => x.class === c.id);
    panel.appendChild(h("h3", {}, `Individuals (${inds.length})`));
    panel.appendChild(
      inds.length
        ? h(
            "ul",
            {},
            inds.map((x) =>
              h(
                "li",
                { id: `ind-${x.id}` },
                h("strong", {}, x.label || x.id),
                x.app ? [" · ", h("a", { href: VG.routes.app(x.app) }, D.appName(x.app))] : null,
                x.term
                  ? [
                      " · ",
                      h(
                        "a",
                        { class: "vg-term", href: VG.routes.term(x.term), dataset: { term: x.term } },
                        (D.terms.get(x.term) || {}).term || x.term,
                      ),
                    ]
                  : null,
              ),
            ),
          )
        : h("p", { class: "vg-muted" }, "None."),
    );
    const terms = D.termsOfClass(c.id);
    panel.appendChild(h("h3", {}, `Glossary terms (${terms.length})`));
    panel.appendChild(
      terms.length
        ? h(
            "div",
            { class: "vg-tag-list" },
            terms.map((t) =>
              h(
                "a",
                { class: "vg-chip vg-term", href: VG.routes.term(t.id), dataset: { term: t.id } },
                t.term,
              ),
            ),
          )
        : h("p", { class: "vg-muted" }, "None."),
    );
    panel.appendChild(
      h(
        "p",
        { style: { marginTop: "12px" } },
        h(
          "a",
          { class: "vg-btn", href: VG.routes.graph(`class:${c.id}`) },
          VG.icon("graph", null, 16),
          "Show in the knowledge graph",
        ),
      ),
    );
  }

  VG.views.register("ontology", {
    title(route) {
      const c = route.path[1] && VG.data.classes.get(route.path[1]);
      return c ? `${c.label || c.id} · Ontology` : "Ontology";
    },
    wide: true,
    render(main, route) {
      const D = VG.data;
      const o = D.c.ontology;
      VG.layout.setCrumbs([{ label: "Ontology", href: "#/ontology" }]);
      main.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h("h1", {}, "Ontology"),
          h(
            "p",
            { class: "vg-lede" },
            `What kinds of things exist in Velexis and how they relate: ${o.classes.length} classes, ${o.properties.length} properties, ${o.individuals.length} individuals, ${o.assertions.length} assertions.`,
          ),
        ),
      );
      if (!o.classes.length) {
        main.appendChild(VG.ui.empty("No ontology yet", "Add content/ontology/ontology.json and rebuild."));
        return {};
      }
      let selected = route.params.get("individual")
        ? (D.individuals.get(route.params.get("individual")) || {}).class || route.path[1]
        : route.path[1] || null;
      let mode = "tree";
      const panel = h("div", { class: "vg-detail-body" });
      const hierHost = h("div", { class: "vg-figure-body" });
      const propHost = h("div", { class: "vg-figure-body" });
      const hierFig = h(
        "section",
        { class: "vg-figure", "aria-label": "Class hierarchy" },
        h(
          "div",
          { class: "vg-figure-head" },
          h("span", { class: "vg-badge vg-badge-type" }, "tree"),
          h("div", { class: "vg-figure-title" }, "Class hierarchy"),
          VG.ui.segmented(
            [
              { value: "tree", label: "Tree" },
              { value: "radial", label: "Radial" },
            ],
            mode,
            (v) => {
              mode = v;
              drawAll();
            },
            "Hierarchy layout",
          ),
        ),
        hierHost,
      );
      const propFig = h(
        "section",
        { class: "vg-figure", "aria-label": "Property diagram" },
        h(
          "div",
          { class: "vg-figure-head" },
          h("span", { class: "vg-badge vg-badge-type" }, "properties"),
          h("div", { class: "vg-figure-title" }, "Properties: domain → range"),
        ),
        propHost,
      );
      const pick = (id) => {
        location.hash = VG.routes.cls(id);
      };
      function drawAll() {
        VG.clear(hierHost);
        VG.clear(propHost);
        if (!window.d3) {
          hierHost.appendChild(h("p", { class: "vg-muted" }, "Diagrams need d3."));
          return;
        }
        drawHierarchy(hierHost, mode, pick, selected);
        drawProperties(propHost, pick, selected);
        VG.svg.hint(
          propHost,
          "Drag to pan · Ctrl/Cmd + scroll to zoom · hover a class to highlight its properties · click to select",
        );
      }
      main.appendChild(
        h(
          "div",
          { class: "vg-graph-layout" },
          h("div", {}, hierFig, propFig),
          h("aside", { class: "vg-detail", "aria-label": "Selected class" }, panel),
        ),
      );

      main.appendChild(h("h2", {}, "Classes"));
      main.appendChild(
        VG.ui.filterTable({
          caption: "classes",
          placeholder: "Filter classes…",
          columns: [
            {
              key: "id",
              label: "Class",
              render: (c) => h("a", { href: VG.routes.cls(c.id) }, c.label || c.id),
              text: (c) => `${c.id} ${c.label || ""}`,
            },
            {
              key: "parent",
              label: "Parent",
              render: (c) =>
                c.parent
                  ? h(
                      "a",
                      { href: VG.routes.cls(c.parent) },
                      (D.classes.get(c.parent) || {}).label || c.parent,
                    )
                  : "—",
              text: (c) => c.parent || "",
            },
            {
              key: "description",
              label: "Description",
              render: (c) => VG.text.plainInline(c.description || ""),
              text: (c) => c.description || "",
            },
          ],
          rows: o.classes,
        }).el,
      );
      main.appendChild(h("h2", {}, "Properties"));
      main.appendChild(
        VG.ui.filterTable({
          caption: "properties",
          placeholder: "Filter properties…",
          columns: [
            {
              key: "id",
              label: "Property",
              render: (p) => [h("strong", {}, p.label || p.id), " ", h("code", {}, p.id)],
              text: (p) => `${p.id} ${p.label || ""}`,
            },
            {
              key: "domain",
              label: "Domain → range",
              render: (p) => [
                h("a", { href: VG.routes.cls(p.domain) }, p.domain),
                " → ",
                h("a", { href: VG.routes.cls(p.range) }, p.range),
              ],
              text: (p) => `${p.domain} ${p.range}`,
            },
            {
              key: "cardinality",
              label: "Card.",
              render: (p) => p.cardinality || "",
              text: (p) => p.cardinality || "",
            },
            {
              key: "inverse",
              label: "Inverse",
              render: (p) => (p.inverse ? h("code", {}, p.inverse) : ""),
              text: (p) => p.inverse || "",
            },
            { key: "description", label: "Description" },
          ],
          rows: o.properties,
        }).el,
      );
      main.appendChild(h("h2", { id: "sec-individuals" }, "Individuals"));
      const indTable = VG.ui.filterTable({
        caption: "individuals",
        placeholder: "Filter individuals…",
        initial: route.params.get("individual") || "",
        columns: [
          {
            key: "id",
            label: "Individual",
            render: (x) => [h("strong", {}, x.label || x.id), " ", h("code", {}, x.id)],
            text: (x) => `${x.id} ${x.label || ""}`,
          },
          {
            key: "class",
            label: "Class",
            render: (x) =>
              h("a", { href: VG.routes.cls(x.class) }, (D.classes.get(x.class) || {}).label || x.class),
            text: (x) => x.class,
          },
          {
            key: "app",
            label: "App",
            render: (x) => (x.app ? h("a", { href: VG.routes.app(x.app) }, D.appName(x.app)) : ""),
            text: (x) => x.app || "",
          },
          {
            key: "term",
            label: "Term",
            render: (x) =>
              x.term
                ? h(
                    "a",
                    { class: "vg-term", href: VG.routes.term(x.term), dataset: { term: x.term } },
                    (D.terms.get(x.term) || {}).term || x.term,
                  )
                : "",
            text: (x) => x.term || "",
          },
        ],
        rows: o.individuals,
      });
      main.appendChild(indTable.el);
      if ((o.assertions || []).length) {
        main.appendChild(h("h2", {}, "Assertions"));
        const label = (id) => (D.individuals.get(id) || {}).label || id;
        main.appendChild(
          VG.ui.filterTable({
            caption: "assertions",
            placeholder: "Filter assertions…",
            columns: [
              {
                key: "subject",
                label: "Subject",
                render: (a) => label(a.subject),
                text: (a) => `${a.subject} ${label(a.subject)}`,
              },
              {
                key: "property",
                label: "Property",
                render: (a) => h("code", {}, a.property),
                text: (a) => `${a.property} ${(D.properties.get(a.property) || {}).label || ""}`,
              },
              {
                key: "object",
                label: "Object",
                render: (a) => label(a.object),
                text: (a) => `${a.object} ${label(a.object)}`,
              },
            ],
            rows: o.assertions,
          }).el,
        );
      }
      classPanel(panel, selected);
      drawAll();
      if (route.params.get("individual"))
        setTimeout(() => document.getElementById("sec-individuals")?.scrollIntoView({ block: "start" }), 0);
      return {
        update(r) {
          selected = r.params.get("individual")
            ? (D.individuals.get(r.params.get("individual")) || {}).class || r.path[1]
            : r.path[1] || null;
          if (r.params.get("individual")) indTable.setFilter(r.params.get("individual"));
          classPanel(panel, selected);
          drawAll();
          const c = selected && D.classes.get(selected);
          VG.layout.setCrumbs(
            c
              ? [{ label: "Ontology", href: "#/ontology" }, { label: c.label || c.id }]
              : [{ label: "Ontology" }],
          );
          document.title = `${c ? (c.label || c.id) + " · " : ""}Ontology · ${D.site.title || "Velexis Guidebook"}`;
          const t = panel.querySelector("#vg-class-title");
          if (t) {
            if (VG.isNarrow()) panel.scrollIntoView({ block: "start" });
            t.focus({ preventScroll: !VG.isNarrow() });
          }
          return true;
        },
      };
    },
  });
})();
