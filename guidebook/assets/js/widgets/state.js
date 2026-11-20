/* Velexis Guidebook widget: state machine (layered left-to-right layout, labelled transitions, click to highlight). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  VG.widgets.register("state", {
    render(container, diagram, ctx) {
      const d3 = window.d3;
      const states = (diagram.states || []).map((s) => ({ ...s }));
      const byId = new Map(states.map((s) => [s.id, s]));
      const trans = (diagram.transitions || [])
        .filter((t) => byId.has(t.from) && byId.has(t.to))
        .map((t) => ({ ...t }));

      // ranks: BFS from initial states (or states without incoming transitions)
      const incoming = new Map(states.map((s) => [s.id, 0]));
      trans.forEach((t) => t.from !== t.to && incoming.set(t.to, incoming.get(t.to) + 1));
      let starts = states.filter((s) => s.kind === "initial");
      if (!starts.length) starts = states.filter((s) => !incoming.get(s.id));
      if (!starts.length && states.length) starts = [states[0]];
      const rank = new Map();
      const queue = starts.map((s) => s.id);
      queue.forEach((id) => rank.set(id, 0));
      while (queue.length) {
        const id = queue.shift();
        for (const t of trans) {
          if (t.from === id && !rank.has(t.to)) {
            rank.set(t.to, rank.get(id) + 1);
            queue.push(t.to);
          }
        }
      }
      let maxRank = Math.max(0, ...rank.values());
      for (const s of states) if (!rank.has(s.id)) rank.set(s.id, ++maxRank);
      // finals go to the last column when that keeps edges forward
      const cols = [];
      for (const s of states) {
        const r = rank.get(s.id);
        (cols[r] = cols[r] || []).push(s);
      }
      cols.forEach((col) => col && col.forEach((s, i) => (s._y = i - (col.length - 1) / 2)));
      for (let pass = 0; pass < 3; pass++) {
        cols.forEach((col, ci) => {
          if (!col || ci === 0) return;
          col.forEach((s) => {
            const preds = trans
              .filter((t) => t.to === s.id && rank.get(t.from) < ci)
              .map((t) => byId.get(t.from));
            s._b = preds.length ? d3.mean(preds, (p) => p._y) : s._y;
          });
          col.sort((a, b) => a._b - b._b);
          col.forEach((s, i) => (s._y = i - (col.length - 1) / 2));
        });
      }
      const COL_W = 190;
      const ROW_H = 92;
      const sw = (s) => (s.kind === "initial" ? 22 : Math.max(96, (s.label || s.id).length * 7.4 + 30));
      const SH = 38;
      states.forEach((s) => {
        s.x = rank.get(s.id) * COL_W + 70;
        s.y = s._y * ROW_H;
      });
      const { svg, g, defs } = VG.svg.create(container, {
        height: Math.min(560, Math.max(260, (d3.max(cols, (c) => (c ? c.length : 0)) || 1) * ROW_H + 120)),
        label: diagram.title,
      });
      const mk = VG.svg.markers(defs);
      const zoom = VG.svg.zoomable(svg, g);

      const pairCount = new Map();
      trans.forEach((t) => {
        const key = [t.from, t.to].sort().join("|");
        t._i = pairCount.get(key) || 0;
        pairCount.set(key, t._i + 1);
      });
      function geom(t) {
        const a = byId.get(t.from);
        const b = byId.get(t.to);
        if (a === b) {
          const w = sw(a);
          const x1 = a.x - w / 4;
          const x2 = a.x + w / 4;
          const y = a.y - SH / 2;
          return {
            d: `M${x1},${y} C${x1 - 10},${y - 46} ${x2 + 10},${y - 46} ${x2},${y}`,
            lx: a.x,
            ly: y - 40,
          };
        }
        const forward = b.x > a.x;
        const [x1, y1] = VG.svg.boxEdge(a.x, a.y, sw(a) + 4, SH + 4, b.x, b.y);
        const [x2, y2] = VG.svg.boxEdge(b.x, b.y, sw(b) + 6, SH + 6, a.x, a.y);
        const same = pairCount.get([t.from, t.to].sort().join("|")) > 1;
        let bend = 0;
        if (!forward) bend = 46 + t._i * 18;
        else if (same) bend = 22 + t._i * 14;
        if (Math.abs(a.y - b.y) < 1 && !forward && Math.abs(b.x - a.x) > COL_W * 1.2) bend = 70;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const sign = forward ? -1 : 1;
        const cx = mx + (dy / len) * bend * sign;
        const cy = my - (dx / len) * bend * sign;
        return { d: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`, lx: (mx + cx) / 2, ly: (my + cy) / 2 };
      }
      trans.forEach((t) => Object.assign(t, geom(t)));
      const edgeSel = g
        .append("g")
        .selectAll("path")
        .data(trans)
        .join("path")
        .attr("class", "vg-edge")
        .attr("d", (t) => t.d)
        .attr("marker-end", mk.normal);
      edgeSel
        .append("title")
        .text((t) => `${byId.get(t.from).label} → ${byId.get(t.to).label}: ${t.label || ""}`);
      const labSel = g
        .append("g")
        .selectAll("g")
        .data(trans.filter((t) => t.label))
        .join("g")
        .attr("class", "vg-edge-label")
        .attr("transform", (t) => `translate(${t.lx},${t.ly})`);
      labSel
        .append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.32em")
        .text((t) => t.label);
      labSel.each(function () {
        const tx = this.querySelector("text");
        const b = tx.getBBox();
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
        .data(states)
        .join("g")
        .attr("class", "vg-node")
        .attr("transform", (s) => `translate(${s.x},${s.y})`);
      nodeSel.each(function (s) {
        const sel = d3.select(this);
        const color = VG.kindVar(s.kind || "normal");
        if (s.kind === "initial") {
          sel.append("circle").attr("r", 11).style("fill", color).style("stroke", color);
          sel
            .append("text")
            .attr("y", 28)
            .attr("text-anchor", "middle")
            .attr("class", "vg-muted-text")
            .text(s.label || s.id);
          return;
        }
        const w = sw(s);
        sel
          .append("rect")
          .attr("x", -w / 2)
          .attr("y", -SH / 2)
          .attr("width", w)
          .attr("height", SH)
          .attr("rx", SH / 2)
          .style("fill", `color-mix(in srgb, ${color} 12%, var(--panel))`)
          .style("stroke", color)
          .style("stroke-width", s.kind === "error" ? "2px" : null);
        if (s.kind === "final") {
          sel
            .append("rect")
            .attr("x", -w / 2 + 4)
            .attr("y", -SH / 2 + 4)
            .attr("width", w - 8)
            .attr("height", SH - 8)
            .attr("rx", (SH - 8) / 2)
            .style("fill", "none")
            .style("stroke", color);
        }
        sel
          .append("text")
          .attr("text-anchor", "middle")
          .attr("dy", "0.32em")
          .style("font-weight", 600)
          .text(s.label || s.id);
        if (s.detail)
          sel
            .append("circle")
            .attr("cx", w / 2 - 6)
            .attr("cy", -SH / 2 + 6)
            .attr("r", 3.5)
            .style("fill", "var(--accent)");
      });
      let selected = null;
      const hl = (s) => {
        const outs = s ? new Set(trans.filter((t) => t.from === s.id).map((t) => t.to)) : null;
        const isOut = (t) => s && t.from === s.id;
        edgeSel
          .classed("is-hl", isOut)
          .classed("vg-faded", (t) => s && !isOut(t))
          .attr("marker-end", (t) => (isOut(t) ? mk.hl : mk.normal));
        labSel.classed("vg-faded", (t) => s && !isOut(t));
        nodeSel.classed("vg-faded", (n) => s && n.id !== s.id && !outs.has(n.id));
      };
      const open = (ev, s) => {
        selected = selected === s ? null : s;
        hl(selected);
        if (!selected) return;
        const outs = trans.filter((t) => t.from === s.id);
        const ins = trans.filter((t) => t.to === s.id && t.from !== s.id);
        const extra = h(
          "div",
          {},
          outs.length ? h("p", { style: { margin: "6px 0 2px" } }, h("strong", {}, "Leaves to")) : null,
          outs.length
            ? h(
                "ul",
                { style: { margin: 0, paddingLeft: "1.1em" } },
                outs.map((t) =>
                  h(
                    "li",
                    {},
                    `${byId.get(t.to).label}`,
                    h("span", { class: "vg-muted" }, ` on ${t.label || "—"}`),
                  ),
                ),
              )
            : null,
          ins.length ? h("p", { style: { margin: "6px 0 2px" } }, h("strong", {}, "Reached from")) : null,
          ins.length
            ? h(
                "ul",
                { style: { margin: 0, paddingLeft: "1.1em" } },
                ins.map((t) =>
                  h(
                    "li",
                    {},
                    `${byId.get(t.from).label}`,
                    h("span", { class: "vg-muted" }, ` on ${t.label || "—"}`),
                  ),
                ),
              )
            : null,
          !outs.length ? h("p", { class: "vg-muted" }, "No outgoing transitions (terminal state).") : null,
        );
        ctx.detail(ev.currentTarget, s.label || s.id, s.detail || "", {
          kind: s.kind || "normal",
          badge: s.kind || "state",
          extra,
          focus: false,
        });
      };
      nodeSel.on("click", open);
      VG.svg
        .focusable(nodeSel, "", open)
        .attr(
          "aria-label",
          (s) =>
            `State ${s.label || s.id}${s.kind && s.kind !== "normal" ? " (" + s.kind + ")" : ""}: highlight its transitions`,
        );
      svg.on("click", (e) => {
        if (e.target === svg.node()) {
          selected = null;
          hl(null);
        }
      });
      container.appendChild(
        h(
          "div",
          { class: "vg-legend" },
          ["initial", "normal", "final", "error"]
            .filter((k) => states.some((s) => (s.kind || "normal") === k))
            .map((k) =>
              h("span", {}, h("span", { class: "vg-kind-dot", style: { background: VG.kindVar(k) } }), k),
            ),
        ),
      );
      VG.svg.hint(
        container,
        "Click a state to highlight where it can go next · drag to pan · Ctrl/Cmd + scroll to zoom",
      );
      VG.svg.fitHeight(svg, g, 220, 560);
      zoom.fit();
      return { fit: () => zoom.fit(), zoomBy: zoom.zoomBy, resize: () => zoom.fit() };
    },
  });
})();
