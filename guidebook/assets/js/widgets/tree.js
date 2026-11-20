/* Velexis Guidebook widget: tree (collapsible tidy tree with zoom and pan; nodes may link to glossary terms). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  VG.widgets.register("tree", {
    render(container, diagram, ctx) {
      const d3 = window.d3;
      const root = d3.hierarchy(diagram.root || { name: diagram.title || "root" });
      let uid = 0;
      root.each((d) => {
        d._id = ++uid;
        d._children = d.children;
        if (d.depth >= 3 && d.children) d.children = null;
      });
      const leaves = root.leaves().length;
      const { svg, g } = VG.svg.create(container, {
        height: Math.min(600, Math.max(260, leaves * 24 + 60)),
        label: diagram.title,
      });
      const zoom = VG.svg.zoomable(svg, g);
      const linkG = g.append("g");
      const nodeG = g.append("g");
      const reduced = VG.reducedMotion();
      const D = VG.data;
      const layout = d3.tree().nodeSize([24, 180]);
      function update(source, refit, instant) {
        layout(root);
        const dur = reduced ? 0 : 250;
        const tr = (sel) => (instant || reduced ? sel : sel.transition().duration(dur));
        const diag = d3
          .linkHorizontal()
          .x((p) => p.y)
          .y((p) => p.x);
        linkG
          .selectAll("path")
          .data(root.links(), (l) => l.target._id)
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
            (u) => u,
            (exit) => exit.remove(),
          )
          .call((sel) => tr(sel).attr("d", diag));
        const node = nodeG
          .selectAll("g.vg-tax-node")
          .data(root.descendants(), (d) => d._id)
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
            (u) => u,
            (exit) => exit.remove(),
          );
        tr(node).attr("transform", (d) => `translate(${d.y},${d.x})`);
        node
          .select("circle")
          .attr("r", 6)
          .style("fill", (d) =>
            d._children && !d.children
              ? "var(--accent)"
              : d.data.term
                ? VG.categoryVar((D.terms.get(d.data.term) || {}).category)
                : "var(--panel)",
          )
          .style("stroke", (d) =>
            d.data.term ? VG.categoryVar((D.terms.get(d.data.term) || {}).category) : "var(--accent)",
          );
        node
          .select("text")
          .attr("x", (d) => (d.children ? -10 : 10))
          .attr("text-anchor", (d) => (d.children ? "end" : "start"))
          .style("text-decoration", (d) => (d.data.term ? "underline dotted" : null))
          .style("font-weight", (d) => (d.depth === 0 ? 700 : 400))
          .text((d) => `${d.data.name}${d._children && !d.children ? ` (+${d._children.length})` : ""}`);
        root.each((d) => {
          d.x0 = d.x;
          d.y0 = d.y;
        });
        node.attr("aria-expanded", (d) => (d._children ? String(Boolean(d.children)) : null));
        if (refit) setTimeout(() => zoom.fit(), instant || reduced ? 0 : dur + 20);
      }
      const activate = (ev, d) => {
        if (d._children) {
          d.children = d.children ? null : d._children;
          update(d, false);
        }
        if (d.data.detail || d.data.term) {
          const t = d.data.term && D.terms.get(d.data.term);
          const extra = t
            ? h(
                "div",
                {},
                h(
                  "p",
                  { style: { margin: "4px 0" } },
                  h("strong", {}, t.term),
                  ": ",
                  VG.text.plainInline(t.definition || ""),
                ),
                h("a", { class: "vg-btn", href: VG.routes.term(t.id) }, "Open in the glossary"),
              )
            : null;
          ctx.detail(ev.currentTarget, d.data.name, d.data.detail || "", { extra, focus: false });
        }
      };
      update(root, false, true);
      nodeG.on("click", (ev) => {
        const el = ev.target.closest("g.vg-tax-node");
        if (el) activate({ currentTarget: el }, d3.select(el).datum());
      });
      nodeG.on("keydown", (ev) => {
        const el = ev.target.closest("g.vg-tax-node");
        if (el && (ev.key === "Enter" || ev.key === " ")) {
          ev.preventDefault();
          activate({ currentTarget: el }, d3.select(el).datum());
        }
      });
      const refreshA11y = () =>
        nodeG
          .selectAll("g.vg-tax-node")
          .attr("tabindex", 0)
          .attr("role", "button")
          .attr(
            "aria-label",
            (d) =>
              `${d.data.name}${d._children ? (d.children ? ", expanded" : ", collapsed") : ""}${d.data.term ? ", glossary term" : ""}`,
          );
      refreshA11y();
      new MutationObserver(refreshA11y).observe(nodeG.node(), { childList: true });
      VG.svg.hint(
        container,
        "Click a node to expand or collapse it (and see its notes) · drag to pan · Ctrl/Cmd + scroll to zoom",
      );
      zoom.fit();
      return {
        fit: () => zoom.fit(),
        zoomBy: zoom.zoomBy,
        resize: () => zoom.fit(),
      };
    },
  });
})();
