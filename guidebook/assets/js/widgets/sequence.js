/* Velexis Guidebook widget: sequence diagram with play / next / previous step-through, notes and keyboard control. */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  VG.widgets.register("sequence", {
    render(container, diagram) {
      const d3 = window.d3;
      const actors = diagram.actors || [];
      const ax = new Map();
      const steps = (diagram.steps || []).filter(
        (s) => actors.some((a) => a.id === s.from) && actors.some((a) => a.id === s.to),
      );
      const colW = Math.max(
        150,
        Math.min(220, d3.max(actors, (a) => (a.label || a.id).length * 7.5 + 30) || 150),
      );
      actors.forEach((a, i) => ax.set(a.id, 70 + i * colW));
      const TOP = 58;
      const ROW = 46;
      const W = 70 + (actors.length - 1) * colW + 110;
      const H = TOP + steps.length * ROW + 40;

      // controls
      let cur = -1;
      let timer = 0;
      const counter = h("span", { class: "vg-seq-counter", "aria-live": "polite" });
      const playBtn = h(
        "button",
        { type: "button", class: "vg-btn is-primary", "aria-label": "Play" },
        VG.icon("play", null, 16),
        h("span", {}, "Play"),
      );
      const controls = h(
        "div",
        { class: "vg-seq-controls" },
        h(
          "button",
          { type: "button", class: "vg-btn", "aria-label": "Previous step", onclick: () => go(cur - 1) },
          VG.icon("prev", null, 16),
        ),
        playBtn,
        h(
          "button",
          { type: "button", class: "vg-btn", "aria-label": "Next step", onclick: () => go(cur + 1) },
          VG.icon("next", null, 16),
        ),
        h(
          "button",
          { type: "button", class: "vg-btn", "aria-label": "Show all steps", onclick: () => go(-1) },
          VG.icon("reset", null, 16),
          "All",
        ),
        counter,
      );
      container.appendChild(controls);
      const scroller = h("div", {
        style: { overflowX: "auto" },
        tabindex: "0",
        role: "region",
        "aria-label": `${diagram.title}: use the arrow keys to step`,
      });
      container.appendChild(scroller);
      const note = h("div", { class: "vg-seq-note", "aria-live": "polite" });
      container.appendChild(note);

      const svg = d3
        .select(scroller)
        .append("svg")
        .attr("class", "vg-svg")
        .attr("width", W)
        .attr("height", H)
        .attr("viewBox", `0 0 ${W} ${H}`)
        .style("min-width", `${W}px`)
        .style("cursor", "default")
        .attr("role", "group")
        .attr("aria-label", diagram.title);
      const mk = VG.svg.markers(svg.append("defs"));
      // lifelines and actor heads
      const head = svg.append("g");
      actors.forEach((a) => {
        const x = ax.get(a.id);
        head
          .append("line")
          .attr("class", "vg-lifeline")
          .attr("x1", x)
          .attr("x2", x)
          .attr("y1", 44)
          .attr("y2", H - 10);
        const g = head.append("g").attr("class", "vg-node").attr("transform", `translate(${x},24)`);
        const w = Math.min(colW - 16, (a.label || a.id).length * 7.5 + 34);
        g.append("rect")
          .attr("x", -w / 2)
          .attr("y", -17)
          .attr("width", w)
          .attr("height", 34)
          .attr("rx", 7)
          .style("fill", `color-mix(in srgb, ${VG.kindVar(a.kind)} 13%, var(--panel))`)
          .style("stroke", VG.kindVar(a.kind));
        VG.svg.icon(g, a.kind, -w / 2 + 7, -8, 16).style("stroke", VG.kindVar(a.kind));
        g.append("text")
          .attr("text-anchor", "middle")
          .attr("x", 8)
          .attr("dy", "0.32em")
          .style("font-weight", 600)
          .text(a.label || a.id);
      });
      const stepG = svg.append("g").selectAll("g").data(steps).join("g").attr("class", "vg-seq-step");
      stepG.each(function (s, i) {
        const g = d3.select(this);
        const y = TOP + i * ROW + 22;
        const x1 = ax.get(s.from);
        const x2 = ax.get(s.to);
        const self = s.kind === "self" || s.from === s.to;
        const cls = `vg-edge ${s.kind === "return" ? "is-async" : ""}`;
        if (self) {
          g.append("path")
            .attr("class", cls)
            .attr("d", `M${x1},${y - 8} h36 v18 h-34`)
            .attr("marker-end", mk.normal);
          g.append("text")
            .attr("x", x1 + 44)
            .attr("y", y + 4)
            .text(s.label || "");
        } else {
          const dir = x2 > x1 ? 1 : -1;
          g.append("line")
            .attr("class", cls)
            .attr("x1", x1 + dir * 4)
            .attr("x2", x2 - dir * 4)
            .attr("y1", y)
            .attr("y2", y)
            .style("stroke-dasharray", s.kind === "async" ? "2 4" : null)
            .attr("marker-end", mk.normal);
          g.append("text")
            .attr("x", (x1 + x2) / 2)
            .attr("y", y - 7)
            .attr("text-anchor", "middle")
            .text(s.label || "");
        }
        g.append("circle").attr("class", "vg-seq-step-num").attr("cx", 18).attr("cy", y).attr("r", 10);
        g.append("text")
          .attr("class", "vg-seq-step-numtext")
          .attr("x", 18)
          .attr("y", y)
          .attr("dy", "0.33em")
          .attr("text-anchor", "middle")
          .style("font-size", "10px")
          .style("font-weight", 700)
          .text(String(i + 1));
        g.append("rect")
          .attr("x", Math.min(x1, x2) - 6)
          .attr("y", y - 22)
          .attr("width", Math.abs(x2 - x1) + (self ? 200 : 12))
          .attr("height", 30)
          .style("fill", "transparent");
        g.append("title").text(
          `${i + 1}. ${s.label || ""}${s.note ? " — " + VG.text.plainInline(s.note) : ""}`,
        );
      });
      stepG.on("click", (e, s) => go(steps.indexOf(s)));
      VG.svg
        .focusable(stepG, "", (e, s) => go(steps.indexOf(s)))
        .attr("aria-label", (s, i) => `Step ${i + 1}: ${s.label || ""}`);

      const actorLabel = (id) => (actors.find((a) => a.id === id) || {}).label || id;
      function render() {
        stepG.classed("is-current", (s, i) => i === cur).classed("is-future", (s, i) => cur >= 0 && i > cur);
        stepG.selectAll("line, path").attr("marker-end", function () {
          return this.parentNode.classList.contains("is-current") ? mk.hl : mk.normal;
        });
        counter.textContent = cur < 0 ? `${steps.length} steps` : `Step ${cur + 1} of ${steps.length}`;
        VG.clear(note);
        if (cur < 0) {
          note.appendChild(
            h(
              "span",
              { class: "vg-muted" },
              "Press Play or Next (or the arrow keys) to step through the messages; click a message to jump to it.",
            ),
          );
          return;
        }
        const s = steps[cur];
        note.appendChild(
          h(
            "div",
            { class: "vg-seq-note-head" },
            `${cur + 1}. ${actorLabel(s.from)} → ${actorLabel(s.to)}: ${s.label || ""}`,
            h("span", { class: "vg-badge", style: { marginLeft: "8px" } }, s.kind || "call"),
          ),
        );
        if (s.note) note.appendChild(VG.md.block(s.note, { app: diagram.app }));
        const node = stepG.nodes()[cur];
        if (node && scroller.scrollWidth > scroller.clientWidth) {
          const bb = node.getBBox();
          const target = bb.x - scroller.clientWidth / 3;
          scroller.scrollLeft = Math.max(0, target);
        }
      }
      function go(i) {
        cur = Math.max(-1, Math.min(steps.length - 1, i));
        render();
      }
      function stop() {
        clearInterval(timer);
        timer = 0;
        VG.clear(playBtn).append(VG.icon("play", null, 16), h("span", {}, "Play"));
        playBtn.setAttribute("aria-label", "Play");
      }
      function play() {
        if (timer) return stop();
        if (cur >= steps.length - 1) cur = -1;
        go(cur + 1);
        VG.clear(playBtn).append(VG.icon("pause", null, 16), h("span", {}, "Pause"));
        playBtn.setAttribute("aria-label", "Pause");
        timer = setInterval(() => {
          if (cur >= steps.length - 1) return stop();
          go(cur + 1);
        }, 1700);
      }
      playBtn.addEventListener("click", play);
      const onKey = (e) => {
        if (e.target.closest && e.target.closest("input, textarea, select")) return;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") go(cur + 1);
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") go(cur - 1);
        else if (e.key === " ") play();
        else if (e.key === "Home") go(0);
        else if (e.key === "End") go(steps.length - 1);
        else if (e.key === "Escape") go(-1);
        else return;
        e.preventDefault();
      };
      scroller.addEventListener("keydown", onKey);
      render();
      return {
        go,
        destroy: stop,
        resize() {},
      };
    },
  });
})();
