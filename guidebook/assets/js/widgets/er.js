/* Velexis Guidebook widget: entity-relationship diagram (fields with pk/fk/uk badges, crow's-foot cardinality, drag). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;
  const ROW = 18;
  const HEAD = 28;
  const MAX_H = 680;

  VG.widgets.register("er", {
    render(container, diagram, ctx) {
      const d3 = window.d3;
      const ents = (diagram.entities || []).map((e) => ({ ...e, fields: e.fields || [] }));
      const byId = new Map(ents.map((e) => [e.id, e]));
      const rels = (diagram.relations || [])
        .filter((r) => byId.has(r.from) && byId.has(r.to))
        .map((r) => ({ ...r }));
      for (const e of ents) {
        const longest = Math.max(
          (e.label || e.id).length * 7.6 + String(e.schema || "").length * 6 + 36,
          ...e.fields.map((f) => (f.name.length + String(f.type || "").length) * 6.6 + 64),
        );
        e.w = Math.max(150, Math.min(360, longest));
        e.h = HEAD + Math.max(1, e.fields.length) * ROW + 8;
      }
      // initial layout: force with rectangle-ish collision, then fixed
      const sim = d3
        .forceSimulation(ents)
        .force(
          "link",
          d3
            .forceLink(rels.map((r) => ({ source: r.from, target: r.to })))
            .id((d) => d.id)
            .distance((l) => (l.source.w + l.target.w) / 2 + 70),
        )
        .force("charge", d3.forceManyBody().strength(-900))
        .force("x", d3.forceX(0).strength(0.06))
        .force("y", d3.forceY(0).strength(0.1))
        .force(
          "collide",
          d3.forceCollide((d) => Math.hypot(d.w, d.h) / 2 + 22),
        )
        .stop();
      for (let i = 0; i < 320; i++) sim.tick();
      // The force layout leaves wide gaps; pack its result into rows (keeping its top-to-bottom, then left-to-right
      // order) shaped like the box it is shown in, so the fitted tables stay large enough to read.
      if (ents.length > 2) {
        const GAP_X = 60;
        const GAP_Y = 64;
        const aspect = Math.max(0.9, Math.min(2.2, ((container.clientWidth || 680) - 48) / (MAX_H - 48)));
        const area = d3.sum(ents, (e) => (e.w + GAP_X) * (e.h + GAP_Y));
        // greedy rows are never full, so aim a little wider than the box
        const rowW = Math.max(
          d3.max(ents, (e) => e.w),
          Math.sqrt(area * aspect) * 1.2,
        );
        const rows = [];
        let row = [];
        let used = 0;
        for (const e of ents.slice().sort((a, b) => a.y - b.y)) {
          if (row.length && used + e.w > rowW) {
            rows.push(row);
            row = [];
            used = 0;
          }
          row.push(e);
          used += e.w + GAP_X;
        }
        if (row.length) rows.push(row);
        let top = 0;
        for (const r of rows) {
          r.sort((a, b) => a.x - b.x);
          let x = -(d3.sum(r, (e) => e.w) + GAP_X * (r.length - 1)) / 2;
          for (const e of r) {
            e.x = x + e.w / 2;
            e.y = top + e.h / 2;
            x += e.w + GAP_X;
          }
          top += d3.max(r, (e) => e.h) + GAP_Y;
        }
      }
      const { svg, g, defs } = VG.svg.create(container, {
        height: Math.min(640, Math.max(320, ents.length * 90)),
        label: diagram.title,
      });
      void defs;
      const zoom = VG.svg.zoomable(svg, g);
      const relG = g.append("g");
      const entG = g.append("g");

      function ends(r) {
        const a = byId.get(r.from);
        const b = byId.get(r.to);
        const [x1, y1] = VG.svg.boxEdge(a.x, a.y, a.w, a.h, b.x, b.y);
        const [x2, y2] = VG.svg.boxEdge(b.x, b.y, b.w, b.h, a.x, a.y);
        return { x1, y1, x2, y2 };
      }
      /** Cardinality mark at (x, y) pointing along angle `ang` (towards the entity): one = bar, many = crow's foot. */
      function mark(sel, x, y, ang, many) {
        const ux = Math.cos(ang);
        const uy = Math.sin(ang);
        const px = -uy;
        const py = ux;
        if (many) {
          const bx = x - ux * 12;
          const by = y - uy * 12;
          sel
            .append("path")
            .attr("class", "vg-edge")
            .attr(
              "d",
              `M${bx},${by} L${x + px * 7},${y + py * 7} M${bx},${by} L${x},${y} M${bx},${by} L${x - px * 7},${y - py * 7}`,
            );
        } else {
          const bx = x - ux * 8;
          const by = y - uy * 8;
          sel
            .append("path")
            .attr("class", "vg-edge")
            .attr("d", `M${bx + px * 7},${by + py * 7} L${bx - px * 7},${by - py * 7}`);
        }
      }
      function drawRels() {
        relG.selectAll("*").remove();
        for (const r of rels) {
          const { x1, y1, x2, y2 } = ends(r);
          const gg = relG.append("g").attr("class", "vg-er-rel").datum(r);
          gg.append("line")
            .attr("class", "vg-edge")
            .attr("x1", x1)
            .attr("y1", y1)
            .attr("x2", x2)
            .attr("y2", y2);
          const ang = Math.atan2(y2 - y1, x2 - x1);
          const card = r.cardinality || "1-n";
          mark(gg, x1, y1, ang + Math.PI, card === "n-n");
          mark(gg, x2, y2, ang, card !== "1-1");
          gg.append("title").text(
            `${byId.get(r.from).label} → ${byId.get(r.to).label}: ${r.label || ""} (${card})`,
          );
          if (r.label) {
            const lab = gg
              .append("g")
              .attr("class", "vg-edge-label")
              .attr("transform", `translate(${(x1 + x2) / 2},${(y1 + y2) / 2})`);
            const t = lab
              .append("text")
              .attr("text-anchor", "middle")
              .attr("dy", "0.32em")
              .text(`${r.label} (${card})`);
            const b = t.node().getBBox();
            lab
              .insert("rect", "text")
              .attr("x", b.x - 3)
              .attr("y", b.y - 1)
              .attr("width", b.width + 6)
              .attr("height", b.height + 2)
              .attr("rx", 3);
          }
        }
      }
      const entSel = entG
        .selectAll("g")
        .data(ents)
        .join("g")
        .attr("class", "vg-node vg-er-entity")
        .attr("transform", (e) => `translate(${e.x - e.w / 2},${e.y - e.h / 2})`);
      entSel.each(function (e) {
        const sel = d3.select(this);
        const color = `var(--s-${e.schema || "platform"}, var(--k-other))`;
        sel
          .append("rect")
          .attr("width", e.w)
          .attr("height", e.h)
          .attr("rx", 7)
          .style("fill", "var(--panel)")
          .style("stroke", color)
          .style("stroke-width", "1.5px");
        sel
          .append("path")
          .attr("d", `M0,7 a7,7 0 0 1 7,-7 h${e.w - 14} a7,7 0 0 1 7,7 v${HEAD - 7} h${-e.w} z`)
          .style("fill", `color-mix(in srgb, ${color} 20%, var(--panel))`)
          .style("stroke", color);
        sel
          .append("text")
          .attr("x", 10)
          .attr("y", 18)
          .style("font-weight", 700)
          .text(e.label || e.id);
        sel
          .append("text")
          .attr("x", e.w - 8)
          .attr("y", 18)
          .attr("text-anchor", "end")
          .attr("class", "vg-muted-text")
          .style("font-size", "10px")
          .text(e.schema || "");
        e.fields.forEach((f, i) => {
          const y = HEAD + 4 + i * ROW;
          const row = sel.append("g").attr("transform", `translate(0,${y})`);
          if (f.key) {
            const kc = f.key === "pk" ? "var(--k-user)" : f.key === "fk" ? "var(--k-ui)" : "var(--k-lib)";
            row
              .append("rect")
              .attr("x", 6)
              .attr("y", 2)
              .attr("width", 22)
              .attr("height", 13)
              .attr("rx", 3)
              .style("fill", `color-mix(in srgb, ${kc} 22%, var(--panel))`)
              .style("stroke", kc);
            row
              .append("text")
              .attr("x", 17)
              .attr("y", 12)
              .attr("text-anchor", "middle")
              .style("font-size", "9px")
              .style("font-weight", 700)
              .text(f.key.toUpperCase());
          }
          row
            .append("text")
            .attr("x", 34)
            .attr("y", 13)
            .style("font-weight", f.key === "pk" ? 700 : 400)
            .text(f.name);
          row
            .append("text")
            .attr("x", e.w - 8)
            .attr("y", 13)
            .attr("text-anchor", "end")
            .attr("class", "vg-muted-text")
            .style("font-family", "var(--mono)")
            .style("font-size", "10.5px")
            .text(f.type || "");
        });
      });
      const open = (ev, e) => {
        const rs = rels.filter((r) => r.from === e.id || r.to === e.id);
        const extra = h(
          "div",
          {},
          h(
            "p",
            { class: "vg-muted", style: { margin: "0 0 4px" } },
            `Schema: ${e.schema || "—"} · ${e.fields.length} fields shown`,
          ),
          rs.length
            ? h(
                "ul",
                { style: { margin: 0, paddingLeft: "1.1em" } },
                rs.map((r) =>
                  h(
                    "li",
                    {},
                    r.from === e.id ? `→ ${byId.get(r.to).label}` : `← ${byId.get(r.from).label}`,
                    h("span", { class: "vg-muted" }, `: ${r.label || ""} (${r.cardinality || "1-n"})`),
                  ),
                ),
              )
            : h("p", { class: "vg-muted" }, "No relations."),
          h(
            "p",
            { style: { marginTop: "8px" } },
            h("a", { href: VG.routes.search(e.label || e.id) }, `Find “${e.label || e.id}” in the guide`),
          ),
        );
        ctx.detail(ev.currentTarget || ev.sourceEvent?.target, e.label || e.id, "", {
          color: `var(--s-${e.schema || "platform"})`,
          kind: "db",
          badge: e.schema,
          extra,
        });
      };
      const drag = d3
        .drag()
        .clickDistance(4)
        .on("start", function () {
          d3.select(this).raise();
        })
        .on("drag", function (ev, e) {
          e.x += ev.dx;
          e.y += ev.dy;
          d3.select(this).attr("transform", `translate(${e.x - e.w / 2},${e.y - e.h / 2})`);
          drawRels();
        });
      entSel.call(drag).on("click", open);
      VG.svg.focusable(entSel, "", open).attr("aria-label", (e) => `Table ${e.label || e.id}: details`);
      drawRels();
      const schemas = [...new Set(ents.map((e) => e.schema).filter(Boolean))];
      container.appendChild(
        h(
          "div",
          { class: "vg-legend" },
          schemas.map((s) =>
            h(
              "span",
              {},
              h("span", { class: "vg-kind-dot", style: { background: `var(--s-${s})` } }),
              `${s} schema`,
            ),
          ),
          h("span", {}, h("strong", {}, "PK"), " primary key"),
          h("span", {}, h("strong", {}, "FK"), " foreign key"),
          h("span", {}, h("strong", {}, "UK"), " unique"),
          h("span", {}, "bar = one, fork = many"),
        ),
      );
      VG.svg.hint(
        container,
        "Drag a table to move it · drag the background to pan · Ctrl/Cmd + scroll to zoom · click a table for its relations",
      );
      VG.svg.fitHeight(svg, g, 280, MAX_H);
      zoom.fit();
      return { fit: () => zoom.fit(), zoomBy: zoom.zoomBy, resize: () => zoom.fit() };
    },
  });
})();
