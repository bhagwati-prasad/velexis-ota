/* Velexis Guidebook widget: component diagram (groups as lanes, typed boxes, curved labelled arrows). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  VG.widgets.register("component", {
    render(container, diagram, ctx) {
      const d3 = window.d3;
      const groups = (diagram.groups || []).slice();
      const nodes = (diagram.nodes || []).map((n) => ({ ...n }));
      if (nodes.some((n) => !n.group || !groups.some((g) => g.id === n.group)))
        groups.push({ id: "__other", label: "Other" });
      for (const n of nodes) if (!n.group || !groups.some((g) => g.id === n.group)) n.group = "__other";
      const lanes = groups.filter((g) => nodes.some((n) => n.group === g.id));
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const edges = (diagram.edges || [])
        .filter((e) => byId.has(e.from) && byId.has(e.to))
        .map((e) => ({ ...e }));

      // order nodes inside lanes by the barycentre of their neighbours
      const perLane = lanes.map((l) => nodes.filter((n) => n.group === l.id));
      perLane.forEach((list) => list.forEach((n, i) => (n._o = (i + 0.5) / list.length)));
      for (let s = 0; s < 4; s++) {
        for (const list of perLane) {
          for (const n of list) {
            const ns = edges
              .filter((e) => e.from === n.id || e.to === n.id)
              .map((e) => byId.get(e.from === n.id ? e.to : e.from));
            n._b = ns.length ? d3.mean(ns, (m) => m._o) : n._o;
          }
          list.sort((a, b) => a._b - b._b);
          list.forEach((n, i) => (n._o = (i + 0.5) / list.length));
        }
      }
      const NW = 156;
      const NH = 50;
      const LANE_H = 104;
      // The lane title sits in the lane's top-left corner, above the boxes, so the boxes need no left column:
      // a narrower drawing keeps a larger scale (and legible labels) when it is fitted to the page.
      const LABEL_W = 16;
      const maxPer = Math.max(...perLane.map((l) => l.length), 1);
      const W = LABEL_W + maxPer * (NW + 30) + 20;
      perLane.forEach((list, li) => {
        list.forEach((n) => {
          n.x = LABEL_W + 10 + n._o * (W - LABEL_W - 20);
          n.y = li * LANE_H + LANE_H / 2;
        });
      });
      const H = lanes.length * LANE_H;
      const { svg, g, defs } = VG.svg.create(container, {
        height: Math.min(640, Math.max(280, H + 40)),
        label: diagram.title,
      });
      const mk = VG.svg.markers(defs);
      const zoom = VG.svg.zoomable(svg, g);

      const laneG = g.append("g");
      lanes.forEach((l, i) => {
        const lg = laneG.append("g").attr("class", "vg-lane");
        lg.append("rect")
          .attr("x", 0)
          .attr("y", i * LANE_H + 4)
          .attr("width", W)
          .attr("height", LANE_H - 8)
          .attr("rx", 8);
        lg.append("text")
          .attr("x", 12)
          .attr("y", i * LANE_H + 22)
          .text(l.label || l.id);
      });

      // parallel edges between the same pair get different bends
      const pairIndex = new Map();
      edges.forEach((e) => {
        const key = [e.from, e.to].sort().join("|");
        e._i = pairIndex.get(key) || 0;
        pairIndex.set(key, e._i + 1);
      });
      function geometry(e) {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        const bend = e._i * 26;
        if (a.y === b.y) {
          const dir = a.x < b.x ? 1 : -1;
          const x1 = a.x + (dir * NW) / 2;
          const x2 = b.x - (dir * NW) / 2;
          if (Math.abs(b.x - a.x) <= NW + 60) {
            const cy = a.y - NH / 2 - 26 - bend;
            return {
              d: `M${x1},${a.y - 6} C${x1 + dir * 20},${cy} ${x2 - dir * 20},${cy} ${x2},${b.y - 6}`,
              lx: (x1 + x2) / 2,
              ly: cy + 8,
            };
          }
          const cy = a.y - NH / 2 - 34 - bend;
          return {
            d: `M${a.x},${a.y - NH / 2} C${a.x},${cy} ${b.x},${cy} ${b.x},${b.y - NH / 2}`,
            lx: (a.x + b.x) / 2,
            ly: cy + 6,
          };
        }
        const down = b.y > a.y;
        const y1 = a.y + ((down ? 1 : -1) * NH) / 2;
        const y2 = b.y - ((down ? 1 : -1) * NH) / 2;
        const off = bend * (a.x <= b.x ? 1 : -1);
        const x1 = a.x + off * 0.4;
        const x2 = b.x + off * 0.4;
        const my = (y1 + y2) / 2;
        return {
          d: `M${x1},${y1} C${x1 + off},${my} ${x2 + off},${my} ${x2},${y2}`,
          lx: (x1 + x2) / 2 + off * 0.75,
          ly: my,
        };
      }
      edges.forEach((e) => Object.assign(e, geometry(e)));
      const edgeG = g.append("g");
      const edgeSel = edgeG
        .selectAll("path")
        .data(edges)
        .join("path")
        .attr(
          "class",
          (e) => `vg-edge ${e.kind === "async" ? "is-async" : e.kind === "data" ? "is-data" : ""}`,
        )
        .attr("d", (e) => e.d)
        .attr("marker-end", mk.normal);
      edgeSel
        .append("title")
        .text(
          (e) =>
            `${byId.get(e.from).label} → ${byId.get(e.to).label}: ${e.label || ""} (${e.kind || "sync"})`,
        );
      const labelSel = g
        .append("g")
        .selectAll("g")
        .data(edges.filter((e) => e.label))
        .join("g")
        .attr("class", "vg-edge-label")
        .attr("transform", (e) => `translate(${e.lx},${e.ly})`);
      labelSel
        .append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.32em")
        .text((e) => (e.label.length > 28 ? e.label.slice(0, 27) + "…" : e.label));
      labelSel.each(function () {
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

      const nodeSel = g
        .append("g")
        .selectAll("g")
        .data(nodes)
        .join("g")
        .attr("class", "vg-node")
        .attr("transform", (n) => `translate(${n.x},${n.y})`);
      nodeSel
        .append("rect")
        .attr("x", -NW / 2)
        .attr("y", -NH / 2)
        .attr("width", NW)
        .attr("height", NH)
        .attr("rx", (n) => (n.kind === "user" ? NH / 2 : n.kind === "db" ? 14 : 8))
        .style("fill", (n) => `color-mix(in srgb, ${VG.kindVar(n.kind)} 13%, var(--panel))`)
        .style("stroke", (n) => VG.kindVar(n.kind));
      nodeSel.each(function (n) {
        VG.svg.icon(d3.select(this), n.kind, -NW / 2 + 9, -9, 18).style("stroke", VG.kindVar(n.kind));
        const lines = VG.svg.lines(n.label, 18).slice(0, 2);
        const t = d3.select(this).append("text").attr("text-anchor", "middle").style("font-weight", 600);
        lines.forEach((l, i) =>
          t
            .append("tspan")
            .attr("x", 10)
            .attr("dy", i === 0 ? (lines.length === 1 ? 4 : -3) : 14)
            .text(l),
        );
        if (n.app || n.term) {
          d3.select(this)
            .append("circle")
            .attr("cx", NW / 2 - 8)
            .attr("cy", -NH / 2 + 8)
            .attr("r", 3.5)
            .style("fill", "var(--accent)");
        }
      });
      nodeSel.append("title").text((n) => `${n.label} (${VG.KIND_LABELS[n.kind] || n.kind || "node"})`);

      const near = (n) => {
        const s = new Set([n.id]);
        edges.forEach((e) => {
          if (e.from === n.id) s.add(e.to);
          if (e.to === n.id) s.add(e.from);
        });
        return s;
      };
      const hl = (n) => {
        const s = n ? near(n) : null;
        nodeSel.classed("vg-faded", (m) => s && !s.has(m.id));
        const on = (e) => n && (e.from === n.id || e.to === n.id);
        edgeSel
          .classed("vg-faded", (e) => n && !on(e))
          .classed("is-hl", on)
          .attr("marker-end", (e) => (on(e) ? mk.hl : mk.normal));
        labelSel.classed("vg-faded", (e) => n && !on(e));
      };
      const open = (ev, n) => {
        const D = VG.data;
        const extra = h("div", {});
        const outs = edges.filter((e) => e.from === n.id || e.to === n.id);
        if (outs.length) {
          extra.appendChild(
            h(
              "ul",
              { style: { paddingLeft: "1.1em", margin: "6px 0" } },
              outs.map((e) =>
                h(
                  "li",
                  {},
                  e.from === n.id ? `→ ${byId.get(e.to).label}` : `← ${byId.get(e.from).label}`,
                  h("span", { class: "vg-muted" }, `: ${e.label || ""} (${e.kind || "sync"})`),
                ),
              ),
            ),
          );
        }
        const links = h("div", { class: "vg-popover-links" });
        if (n.app && D.app(n.app))
          links.appendChild(
            h("a", { class: "vg-btn", href: VG.routes.app(n.app) }, `Open ${D.appName(n.app)}`),
          );
        if (n.term && D.terms.get(n.term))
          links.appendChild(
            h(
              "a",
              { class: "vg-btn", href: VG.routes.term(n.term) },
              `Glossary: ${D.terms.get(n.term).term}`,
            ),
          );
        if (links.childNodes.length) extra.appendChild(links);
        ctx.detail(ev.currentTarget, n.label, n.detail || "", {
          kind: n.kind,
          badge: VG.KIND_LABELS[n.kind] || n.kind,
          extra,
        });
      };
      nodeSel
        .on("mouseenter", (e, n) => hl(n))
        .on("mouseleave", () => hl(null))
        .on("focus", (e, n) => hl(n))
        .on("blur", () => hl(null))
        .on("click", open);
      VG.svg
        .focusable(nodeSel, "", open)
        .attr("aria-label", (n) => `${n.label}, ${VG.KIND_LABELS[n.kind] || n.kind}: details`);

      const kinds = [...new Set(nodes.map((n) => n.kind).filter(Boolean))];
      container.appendChild(
        h(
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
          h("span", {}, h("span", { class: "vg-legend-line is-async" }), "async"),
          h("span", {}, h("span", { class: "vg-legend-line is-data" }), "data"),
        ),
      );
      VG.svg.hint(container);
      VG.svg.fitHeight(svg, g, 240, 640);
      zoom.fit();
      return { fit: () => zoom.fit(), zoomBy: zoom.zoomBy, resize: () => zoom.fit() };
    },
  });
})();
