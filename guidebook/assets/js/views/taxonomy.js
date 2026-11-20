/* Velexis Guidebook view: taxonomy (#/taxonomy?view=tree|sunburst): collapsible tidy tree and zoomable sunburst. */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  /** The distinct glossary terms under a node (a term may be placed in more than one category). */
  function termLeaves(d) {
    const seen = new Set();
    return d.leaves().filter((l) => l.data.kind === "term" && !seen.has(l.data.id) && seen.add(l.data.id));
  }

  /** Taxonomy JSON -> plain tree where glossary terms are leaves ({ kind: "term" }). */
  function toTree(node) {
    const D = VG.data;
    const kids = (node.children || []).map(toTree);
    const terms = (node.terms || [])
      .map((id) => D.terms.get(id))
      .filter(Boolean)
      .map((t) => ({ kind: "term", id: t.id, name: t.term || t.id, category: t.category }));
    return {
      kind: "node",
      id: node.id,
      name: node.label || node.id,
      description: node.description || "",
      apps: node.apps || [],
      children: [...kids, ...terms],
    };
  }

  function nodeColor(d) {
    if (d.data.kind === "term") return VG.categoryVar(d.data.category);
    let top = d;
    while (top.depth > 1) top = top.parent;
    const palette = [
      "--p-platform",
      "--p-ota",
      "--p-shared",
      "--g-class",
      "--g-journey",
      "--g-individual",
      "--g-page",
    ];
    if (!top.parent) return "var(--text-muted)";
    const i = top.parent.children.indexOf(top);
    return `var(${palette[i % palette.length]})`;
  }

  /* ---------------------------------------------------------------- side panel */

  function describe(panel, d) {
    const D = VG.data;
    VG.clear(panel);
    if (d.data.kind === "term") {
      const t = D.terms.get(d.data.id);
      panel.appendChild(h("h2", {}, d.data.name));
      if (t) panel.appendChild(VG.md.block(t.definition || ""));
      panel.appendChild(
        h("p", {}, h("a", { class: "vg-btn", href: VG.routes.term(d.data.id) }, "Open in the glossary")),
      );
      return;
    }
    const trail = d
      .ancestors()
      .reverse()
      .map((a) => a.data.name)
      .join(" › ");
    panel.appendChild(h("p", { class: "vg-meta" }, trail));
    panel.appendChild(h("h2", {}, d.data.name));
    if (d.data.description) panel.appendChild(VG.md.block(d.data.description));
    if (d.data.apps.length) {
      panel.appendChild(h("h3", {}, "Apps"));
      panel.appendChild(
        h(
          "div",
          { class: "vg-tag-list" },
          d.data.apps.map((a) =>
            D.app(a)
              ? h("a", { class: "vg-chip", href: VG.routes.app(a) }, D.appName(a))
              : h("span", { class: "vg-badge" }, a),
          ),
        ),
      );
    }
    const leaves = termLeaves(d);
    const sub = (d.data.children || []).filter((c) => c.kind === "node");
    if (sub.length) {
      panel.appendChild(h("h3", {}, `Sub-categories (${sub.length})`));
      panel.appendChild(
        h(
          "ul",
          {},
          sub.map((c) => h("li", {}, c.name)),
        ),
      );
    }
    panel.appendChild(h("h3", {}, `Terms (${leaves.length})`));
    panel.appendChild(
      leaves.length
        ? h(
            "div",
            { class: "vg-tag-list" },
            leaves.map((l) =>
              h(
                "a",
                { class: "vg-chip vg-term", href: VG.routes.term(l.data.id), dataset: { term: l.data.id } },
                h("span", { class: "vg-kind-dot", style: { background: VG.categoryVar(l.data.category) } }),
                l.data.name,
              ),
            ),
          )
        : h("p", { class: "vg-muted" }, "None."),
    );
  }

  /* ---------------------------------------------------------------- tree */

  function drawTree(host, data, panel) {
    const d3 = window.d3;
    const { svg, g } = VG.svg.create(host, {
      height: Math.max(460, Math.min(window.innerHeight - 260, 720)),
      label: "Taxonomy tree",
    });
    const zoom = VG.svg.zoomable(svg, g, { min: 0.15, max: 3 });
    const root = d3.hierarchy(data);
    let uid = 0;
    root.each((d) => {
      d._id = ++uid;
      d._children = d.children;
      if (d.depth >= 2 && d.children) d.children = null;
    });
    const linkG = g.append("g");
    const nodeG = g.append("g");
    const layout = d3.tree().nodeSize([24, 210]);
    const reduced = VG.reducedMotion();
    // Opening the tree (and Expand all / Collapse) keeps the labels legible (scale >= 0.8): a tree too big for the box
    // is shown from its left edge, centred vertically, and pans; the Fit button still shows all of it.
    const MIN_K = 0.8;
    function fitLegible(focus) {
      const el = svg.node();
      if (!el || !el.isConnected) return;
      const box = g.node().getBBox();
      const w = el.clientWidth || 600;
      const hh = el.clientHeight || 400;
      const p = 30;
      if (!box.width || !box.height) return;
      if (Math.min((w - 2 * p) / box.width, (hh - 2 * p) / box.height) >= MIN_K) {
        zoom.fit(p);
        return;
      }
      const k = MIN_K;
      const tx = box.width * k <= w - 2 * p ? w / 2 - k * (box.x + box.width / 2) : p - k * box.x;
      let ty = hh / 2 - k * (focus?.x ?? box.y + box.height / 2);
      if (box.height * k > hh - 2 * p)
        ty = Math.min(p - k * box.y, Math.max(hh - p - k * (box.y + box.height), ty));
      else ty = hh / 2 - k * (box.y + box.height / 2);
      svg.call(zoom.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
    }
    function update(source, refit, instant) {
      layout(root);
      const nodes = root.descendants();
      const links = root.links();
      const dur = reduced ? 0 : 280;
      const tr = (sel) => (instant || reduced ? sel : sel.transition().duration(dur));
      const diag = d3
        .linkHorizontal()
        .x((p) => p.y)
        .y((p) => p.x);
      linkG
        .selectAll("path")
        .data(links, (l) => l.target._id)
        .join(
          (enter) =>
            enter
              .append("path")
              .attr("class", "vg-tax-link")
              .attr("d", () =>
                diag({
                  source: { x: source.x0 || 0, y: source.y0 || 0 },
                  target: { x: source.x0 || 0, y: source.y0 || 0 },
                }),
              ),
          (upd) => upd,
          (exit) => exit.remove(),
        )
        .call((sel) => tr(sel).attr("d", diag));
      const node = nodeG
        .selectAll("g.vg-tax-node")
        .data(nodes, (d) => d._id)
        .join(
          (enter) => {
            const e = enter
              .append("g")
              .attr("class", "vg-tax-node vg-node")
              .attr("transform", () => `translate(${source.y0 || 0},${source.x0 || 0})`);
            e.append("circle");
            e.append("text").attr("dy", "0.32em");
            return e;
          },
          (upd) => upd,
          (exit) => exit.remove(),
        );
      tr(node).attr("transform", (d) => `translate(${d.y},${d.x})`);
      node
        .select("circle")
        .attr("r", (d) => (d.data.kind === "term" ? 4.5 : 7))
        .style("fill", (d) =>
          d.data.kind === "term" ? nodeColor(d) : d._children && !d.children ? nodeColor(d) : "var(--panel)",
        )
        .style("stroke", (d) => nodeColor(d));
      node
        .select("text")
        .attr("x", (d) => (d.data.kind === "term" || !d._children ? 9 : -11))
        .attr("text-anchor", (d) => (d.data.kind === "term" || !d._children ? "start" : "end"))
        .style("font-weight", (d) => (d.data.kind === "term" ? 400 : 650))
        .text((d) =>
          d.data.kind === "node" && d._children
            ? `${d.data.name} (${termLeaves(d).length || d._children.length})`
            : d.data.name,
        );
      const activate = (e, d) => {
        if (d.data.kind === "term") {
          location.hash = VG.routes.term(d.data.id);
          return;
        }
        if (d._children) {
          d.children = d.children ? null : d._children;
          update(d, false);
        }
        describe(panel, d);
      };
      node.on("click", activate);
      VG.svg
        .focusable(node, "", activate)
        .attr("aria-label", (d) =>
          d.data.kind === "term"
            ? `${d.data.name}: open in the glossary`
            : `${d.data.name}${d._children ? (d.children ? ", expanded" : ", collapsed") : ""}`,
        );
      node.attr("aria-expanded", (d) =>
        d.data.kind === "node" && d._children ? String(Boolean(d.children)) : null,
      );
      root.each((d) => {
        d.x0 = d.x;
        d.y0 = d.y;
      });
      if (refit) {
        if (instant || reduced) fitLegible(source);
        else setTimeout(() => fitLegible(source), dur + 20);
      }
    }
    root.x0 = 0;
    root.y0 = 0;
    update(root, true, true);
    describe(panel, root);
    return {
      fit: () => zoom.fit(30),
      expandAll() {
        root.each((d) => {
          if (d._children) d.children = d._children;
        });
        update(root, true);
      },
      collapseAll() {
        root.each((d) => {
          if (d.depth >= 1 && d._children) d.children = null;
        });
        update(root, true);
      },
      zoom,
    };
  }

  /* ---------------------------------------------------------------- sunburst */

  function drawSunburst(host, data, panel) {
    const d3 = window.d3;
    const size = Math.min(host.clientWidth || 640, 720);
    const radius = size / 6;
    const root = d3
      .hierarchy(data)
      .sum((d) => (d.kind === "term" ? 1 : 0))
      .sort((a, b) => b.value - a.value);
    d3.partition().size([2 * Math.PI, root.height + 1])(root);
    root.each((d) => (d.current = d));
    const arc = d3
      .arc()
      .startAngle((d) => d.x0)
      .endAngle((d) => d.x1)
      .padAngle((d) => Math.min((d.x1 - d.x0) / 2, 0.005))
      .padRadius(radius * 1.5)
      .innerRadius((d) => d.y0 * radius)
      .outerRadius((d) => Math.max(d.y0 * radius, d.y1 * radius - 1));
    const svg = d3
      .select(host)
      .append("svg")
      .attr("viewBox", [-size / 2, -size / 2, size, size])
      .attr("width", "100%")
      .attr("class", "vg-svg vg-sunburst")
      .attr("role", "group")
      .attr("aria-label", "Taxonomy sunburst")
      .style("max-height", "720px");
    const visible = (d) => d.y1 <= 3 && d.y0 >= 1 && d.x1 > d.x0;
    const labelVisible = (d) => d.y1 <= 3 && d.y0 >= 1 && (d.y1 - d.y0) * (d.x1 - d.x0) > 0.06;
    const labelTransform = (d) => {
      const x = (((d.x0 + d.x1) / 2) * 180) / Math.PI;
      const y = ((d.y0 + d.y1) / 2) * radius;
      return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`;
    };
    const path = svg
      .append("g")
      .selectAll("path")
      .data(root.descendants().slice(1))
      .join("path")
      .style("fill", (d) => nodeColor(d))
      .attr("fill-opacity", (d) => (visible(d.current) ? (d.children ? 0.75 : 0.5) : 0))
      .attr("pointer-events", (d) => (visible(d.current) ? "auto" : "none"))
      .attr("d", (d) => arc(d.current));
    path.append("title").text(
      (d) =>
        `${d
          .ancestors()
          .map((a) => a.data.name)
          .reverse()
          .slice(1)
          .join(" › ")}${d.data.kind === "node" ? ` (${d.value} terms)` : ""}`,
    );
    const label = svg
      .append("g")
      .attr("pointer-events", "none")
      .attr("text-anchor", "middle")
      .selectAll("text")
      .data(root.descendants().slice(1))
      .join("text")
      .attr("dy", "0.35em")
      .attr("fill-opacity", (d) => Number(labelVisible(d.current)))
      .attr("transform", (d) => labelTransform(d.current))
      .text((d) => (d.data.name.length > 16 ? d.data.name.slice(0, 15) + "…" : d.data.name));
    const parent = svg
      .append("circle")
      .datum(root)
      .attr("r", radius)
      .attr("fill", "var(--bg-soft)")
      .attr("stroke", "var(--border)")
      .attr("pointer-events", "all")
      .style("cursor", "pointer");
    const centerText = svg
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .style("font-weight", 700)
      .attr("pointer-events", "none")
      .text(root.data.name);
    const clicked = (e, p) => {
      if (p.data.kind === "term") {
        location.hash = VG.routes.term(p.data.id);
        return;
      }
      describe(panel, p);
      parent.datum(p.parent || root);
      centerText.text(p.data.name);
      root.each(
        (d) =>
          (d.target = {
            x0: Math.max(0, Math.min(1, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
            x1: Math.max(0, Math.min(1, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
            y0: Math.max(0, d.y0 - p.depth),
            y1: Math.max(0, d.y1 - p.depth),
          }),
      );
      const t = svg.transition().duration(VG.reducedMotion() ? 0 : 600);
      path
        .transition(t)
        .tween("data", (d) => {
          const i = d3.interpolate(d.current, d.target);
          return (tt) => (d.current = i(tt));
        })
        .filter(function (d) {
          return Number(this.getAttribute("fill-opacity")) || visible(d.target);
        })
        .attr("fill-opacity", (d) => (visible(d.target) ? (d.children ? 0.75 : 0.5) : 0))
        .attr("pointer-events", (d) => (visible(d.target) ? "auto" : "none"))
        .attrTween("d", (d) => () => arc(d.current));
      label
        .filter(function (d) {
          return Number(this.getAttribute("fill-opacity")) || labelVisible(d.target);
        })
        .transition(t)
        .attr("fill-opacity", (d) => Number(labelVisible(d.target)))
        .attrTween("transform", (d) => () => labelTransform(d.current));
      path.attr("tabindex", (d) => (visible(d.target) ? 0 : -1));
    };
    path.style("cursor", "pointer").on("click", clicked);
    VG.svg
      .focusable(path, "", clicked)
      .attr("aria-label", (d) =>
        d.data.kind === "term"
          ? `${d.data.name}: open in the glossary`
          : `${d.data.name}: zoom in (${d.value} terms)`,
      );
    path.attr("tabindex", (d) => (visible(d.current) ? 0 : -1));
    parent.on("click", clicked);
    VG.svg.focusable(parent, "Zoom out", clicked);
    describe(panel, root);
    return {};
  }

  VG.views.register("taxonomy", {
    title: () => "Taxonomy",
    wide: true,
    render(main, route) {
      const D = VG.data;
      VG.layout.setCrumbs([{ label: "Taxonomy" }]);
      main.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h("h1", {}, "Taxonomy"),
          h(
            "p",
            { class: "vg-lede" },
            "How the system is classified: products → domains → capabilities → concepts. Click a category to expand it, a term to open its glossary entry.",
          ),
        ),
      );
      const tax = D.c.taxonomy;
      if (!tax) {
        main.appendChild(VG.ui.empty("No taxonomy yet", "Add content/taxonomy/taxonomy.json and rebuild."));
        return {};
      }
      if (!window.d3) {
        const ul = h("ul", {});
        const walk = (n, parent) => {
          const li = h(
            "li",
            {},
            n.label || n.id,
            (n.terms || []).length ? ` — ${(n.terms || []).join(", ")}` : "",
          );
          parent.appendChild(li);
          if ((n.children || []).length) {
            const sub = h("ul", {});
            li.appendChild(sub);
            n.children.forEach((c) => walk(c, sub));
          }
        };
        walk(tax, ul);
        main.appendChild(ul);
        return {};
      }
      const data = toTree(tax);
      let mode = route.params.get("view") === "sunburst" ? "sunburst" : "tree";
      const stage = h("div", { class: "vg-stage" });
      const panel = h("div", { class: "vg-detail-body" });
      const tools = h("div", { class: "vg-toolbar" });
      main.appendChild(tools);
      main.appendChild(
        h(
          "div",
          { class: "vg-graph-layout" },
          stage,
          h("aside", { class: "vg-detail", "aria-label": "Selected category" }, panel),
        ),
      );
      let inst = null;
      const treeTools = h(
        "span",
        { class: "vg-toolbar", style: { margin: 0 } },
        h(
          "button",
          { type: "button", class: "vg-btn", onclick: () => inst && inst.expandAll && inst.expandAll() },
          "Expand all",
        ),
        h(
          "button",
          { type: "button", class: "vg-btn", onclick: () => inst && inst.collapseAll && inst.collapseAll() },
          "Collapse",
        ),
        h(
          "button",
          { type: "button", class: "vg-btn", onclick: () => inst && inst.fit && inst.fit() },
          VG.icon("fit", null, 16),
          "Fit",
        ),
      );
      const draw = () => {
        VG.clear(stage);
        inst = mode === "tree" ? drawTree(stage, data, panel) : drawSunburst(stage, data, panel);
        treeTools.hidden = mode !== "tree";
        if (mode === "tree")
          VG.svg.hint(
            stage,
            "Drag to pan · Ctrl/Cmd + scroll to zoom · click a category to expand or collapse it",
          );
      };
      tools.appendChild(
        VG.ui.segmented(
          [
            { value: "tree", label: "Tree", icon: "tree" },
            { value: "sunburst", label: "Sunburst", icon: "other" },
          ],
          mode,
          (v) => {
            mode = v;
            history.replaceState(null, "", `#/taxonomy${v === "sunburst" ? "?view=sunburst" : ""}`);
            draw();
          },
          "Taxonomy view",
        ),
      );
      tools.appendChild(treeTools);
      tools.appendChild(
        h(
          "button",
          { type: "button", class: "vg-btn", onclick: () => VG.ui.toggleFullscreen(stage, () => draw()) },
          VG.icon("expand", null, 16),
          "Fullscreen",
        ),
      );
      stage.addEventListener("vg-resize", () => draw());
      draw();
      return {};
    },
  });
})();
