/*
 * Velexis Guidebook: diagram widget registry, the figure frame (title, toolbar, fullscreen, caption) and SVG helpers
 * shared by the widgets in assets/js/widgets/*.js. A widget registers with
 *   VG.widgets.register(type, { render(container, diagram, ctx) -> { fit?, zoomBy?, resize?, destroy? } }).
 */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  const types = {};
  const W = (VG.widgets = {
    types,
    register(type, impl) {
      types[type] = impl;
    },
  });

  /* ---------------------------------------------------------------- text fallback (no d3) */

  function fallbackList(d) {
    const ul = h("ul", { class: "vg-fallback-list" });
    const li = (...c) => ul.appendChild(h("li", {}, ...c));
    if (d.type === "component") {
      (d.nodes || []).forEach((n) => li(h("strong", {}, n.label), ` (${n.kind || "node"})`));
      (d.edges || []).forEach((e) => li(`${e.from} → ${e.to}: ${e.label || ""}`));
    } else if (d.type === "sequence") {
      (d.steps || []).forEach((s, i) => li(`${i + 1}. ${s.from} → ${s.to}: ${s.label || ""}`));
    } else if (d.type === "state") {
      (d.transitions || []).forEach((t) => li(`${t.from} → ${t.to}: ${t.label || ""}`));
    } else if (d.type === "er") {
      (d.entities || []).forEach((e) =>
        li(h("strong", {}, e.label || e.id), ": ", (e.fields || []).map((f) => f.name).join(", ")),
      );
    } else if (d.type === "tree") {
      const walk = (n, depth) => {
        li(`${"  ".repeat(depth)}${n.name}`);
        (n.children || []).forEach((c) => walk(c, depth + 1));
      };
      if (d.root) walk(d.root, 0);
    }
    return ul;
  }

  /* ---------------------------------------------------------------- frame */

  /**
   * Replaces `slot` with an interactive figure for diagram `key` (resolved against ctx.app).
   * Returns the widget instance (with destroy) or null.
   */
  W.mount = function mount(slot, key, ctx) {
    const c = ctx || {};
    const d = VG.data.diagram(key, c.app);
    if (!d) {
      const miss = h(
        "div",
        { class: "vg-figure vg-figure-missing", role: "note" },
        `Unknown diagram “${key}”.`,
      );
      slot.replaceWith(miss);
      return null;
    }
    const impl = types[d.type];
    const titleId = VG.uid("fig");
    const toolbar = h("div", { class: "vg-figure-tools", role: "toolbar", "aria-label": `${d.title} tools` });
    const body = h("div", { class: `vg-figure-body vg-figure-body-${d.type}` });
    const caption = h("figcaption", { class: "vg-figure-caption" });
    if (d.caption) {
      const span = h("span", {});
      VG.md.inlineInto(span, d.caption, { app: d.app });
      caption.appendChild(span);
    }
    if (!c.standalone) {
      caption.appendChild(
        h(
          "a",
          {
            class: "vg-figure-open",
            href: VG.routes.diagram(d.key),
            "aria-label": `Open ${d.title} on its own page`,
          },
          "Open",
        ),
      );
    }
    const fig = h(
      "figure",
      { class: `vg-figure vg-figure-${d.type}`, "aria-labelledby": titleId, dataset: { diagram: d.key } },
      h(
        "div",
        { class: "vg-figure-head" },
        h("span", { class: "vg-badge vg-badge-type" }, d.type),
        h("div", { class: "vg-figure-title", id: titleId }, d.title || d.key),
        toolbar,
      ),
      body,
      caption,
    );
    slot.replaceWith(fig);

    let inst = null;
    const tool = (icon, label, fn) =>
      toolbar.appendChild(
        h(
          "button",
          { type: "button", class: "vg-iconbtn", "aria-label": label, title: label, onclick: fn },
          VG.icon(icon, null, 16),
        ),
      );
    const wctx = {
      app: d.app,
      figure: fig,
      body,
      tool,
      reducedMotion: VG.reducedMotion(),
      /** Detail popover for a diagram element; md is markdown, extra a node appended below. */
      detail(anchor, title, md, opts) {
        const o = opts || {};
        const content = h("div", {});
        if (md) content.appendChild(VG.md.block(md, { app: d.app }));
        if (o.extra) content.appendChild(o.extra);
        if (!md && !o.extra) content.appendChild(h("p", { class: "vg-muted" }, "No further detail."));
        VG.ui.popover(anchor, title, content, {
          kind: o.kind,
          badge: o.badge,
          color: o.color,
          focus: o.focus,
        });
      },
    };
    if (!impl) {
      body.appendChild(h("p", { class: "vg-muted" }, `No widget for diagram type “${d.type}”.`));
    } else if (!window.d3 && impl.needsD3 !== false) {
      body.appendChild(h("p", { class: "vg-muted" }, "Diagram library unavailable; showing a text version."));
      body.appendChild(fallbackList(d));
    } else {
      try {
        inst = impl.render(body, d, wctx) || {};
      } catch (err) {
        body.appendChild(h("p", { class: "vg-error" }, `This diagram could not be drawn: ${err.message}`));
        body.appendChild(fallbackList(d));
        inst = {};
      }
    }
    if (inst && inst.zoomBy) {
      tool("plus", "Zoom in", () => inst.zoomBy(1.3));
      tool("minus", "Zoom out", () => inst.zoomBy(1 / 1.3));
    }
    if (inst && inst.fit) tool("fit", "Fit to view", () => inst.fit());
    tool("expand", "Fullscreen", () =>
      VG.ui.toggleFullscreen(fig, () => inst && inst.resize && inst.resize()),
    );
    fig.addEventListener("vg-resize", () => inst && inst.resize && inst.resize());
    return {
      diagram: d,
      figure: fig,
      destroy() {
        if (inst && inst.destroy) inst.destroy();
      },
    };
  };

  /* ---------------------------------------------------------------- SVG helpers for widgets */

  const S = (VG.svg = {});

  /** Creates <svg> inside container with a root <g>; returns { svg, g, defs } (d3 selections). */
  S.create = function create(container, opts) {
    const o = opts || {};
    const svg = window.d3
      .select(container)
      .append("svg")
      .attr("class", `vg-svg ${o.cls || ""}`)
      .attr("role", "img")
      .attr("aria-label", o.label || "Diagram")
      .attr("width", "100%")
      .attr("height", o.height || 420);
    const defs = svg.append("defs");
    const g = svg.append("g").attr("class", "vg-svg-root");
    return { svg, g, defs };
  };

  /** Arrow markers (normal, highlighted, faint); returns ids. Colour comes from CSS classes. */
  S.markers = function markers(defs) {
    const base = VG.uid("mk");
    const make = (suffix, cls) => {
      defs
        .append("marker")
        .attr("id", `${base}-${suffix}`)
        .attr("viewBox", "0 0 10 10")
        .attr("refX", 9)
        .attr("refY", 5)
        .attr("markerWidth", 7)
        .attr("markerHeight", 7)
        .attr("orient", "auto-start-reverse")
        .append("path")
        .attr("d", "M0,0 L10,5 L0,10 z")
        .attr("class", `vg-arrowhead ${cls}`);
      return `url(#${base}-${suffix})`;
    };
    return { normal: make("n", ""), hl: make("h", "is-hl"), async: make("a", "is-async") };
  };

  /**
   * Zoom and pan on `svg` transforming `g`. Wheel zooms only with Ctrl/Cmd (plain wheel scrolls the page);
   * on touch screens one finger scrolls the page and two fingers pan/zoom.
   */
  S.zoomable = function zoomable(svg, g, opts) {
    const o = opts || {};
    const d3 = window.d3;
    const zoom = d3
      .zoom()
      .scaleExtent([o.min || 0.2, o.max || 4])
      // d3's default extent reads width.baseVal, which throws for width="100%" once the SVG is detached (a fit
      // transition can outlive a re-render); the client size is always readable.
      .extent(function () {
        const el = this.ownerSVGElement || this;
        return [
          [0, 0],
          [el.clientWidth || 600, el.clientHeight || 400],
        ];
      })
      .filter((e) => {
        if (e.type === "wheel") return e.ctrlKey || e.metaKey || o.freeWheel;
        if (e.type === "touchstart" || e.type === "touchmove") return e.touches && e.touches.length > 1;
        return (!e.ctrlKey || e.type === "wheel") && !e.button;
      })
      .on("zoom", (e) => g.attr("transform", e.transform));
    svg.call(zoom).on("dblclick.zoom", null);
    svg.style("touch-action", "pan-x pan-y");
    const api = {
      zoom,
      fit(pad) {
        const node = g.node();
        const el = svg.node();
        if (!node || !el || !el.isConnected) return;
        const box = node.getBBox();
        const w = el.clientWidth || 600;
        const hgt = el.clientHeight || 400;
        if (!box.width || !box.height) return;
        const p = pad ?? 24;
        const k = Math.min((w - p * 2) / box.width, (hgt - p * 2) / box.height, o.fitMax || 1.6);
        const tx = w / 2 - k * (box.x + box.width / 2);
        const ty = hgt / 2 - k * (box.y + box.height / 2);
        const t = d3.zoomIdentity.translate(tx, ty).scale(k);
        const sel = VG.reducedMotion() || o.instant ? svg : svg.transition().duration(350);
        sel.call(zoom.transform, t);
      },
      zoomBy(k) {
        const sel = VG.reducedMotion() ? svg : svg.transition().duration(200);
        sel.call(zoom.scaleBy, k);
      },
      focusOn(x, y, k) {
        const el = svg.node();
        const t = d3.zoomIdentity
          .translate((el.clientWidth || 600) / 2, (el.clientHeight || 400) / 2)
          .scale(k || 1.4)
          .translate(-x, -y);
        const sel = VG.reducedMotion() ? svg : svg.transition().duration(450);
        sel.call(zoom.transform, t);
      },
    };
    return api;
  };

  /** Splits text into lines of at most `max` characters (word boundaries). */
  S.lines = function lines(text, max) {
    const words = String(text || "")
      .split(/\s+/)
      .filter(Boolean);
    const out = [];
    let cur = "";
    for (const w of words) {
      if (!cur) cur = w;
      else if ((cur + " " + w).length <= max) cur += " " + w;
      else {
        out.push(cur);
        cur = w;
      }
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  };

  /** Appends multi-line text centred at (x, y) to a d3 selection. */
  S.multiline = function multiline(sel, text, max, lineHeight) {
    const ls = S.lines(text, max);
    const lh = lineHeight || 14;
    const t = sel.append("text").attr("text-anchor", "middle");
    ls.forEach((l, i) =>
      t
        .append("tspan")
        .attr("x", 0)
        .attr("dy", i === 0 ? -((ls.length - 1) * lh) / 2 + 4 : lh)
        .text(l),
    );
    return t;
  };

  /** Icon (24x24 path from VG.ICONS) placed at (x, y) with `size`. */
  S.icon = function icon(sel, name, x, y, size) {
    const s = (size || 16) / 24;
    return sel
      .append("path")
      .attr("class", "vg-svg-icon")
      .attr("d", VG.ICONS[name] || VG.ICONS.other)
      .attr("transform", `translate(${x},${y}) scale(${s})`);
  };

  /** Makes an SVG element keyboard-activatable (Enter/Space) with an accessible label. */
  S.focusable = function focusable(sel, label, onActivate) {
    sel
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", label)
      .on("keydown", (e, d) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate(e, d);
        }
      });
    return sel;
  };

  /** Point on the border of a w x h box centred at (cx, cy) towards (tx, ty). */
  S.boxEdge = function boxEdge(cx, cy, w, hgt, tx, ty) {
    const dx = tx - cx;
    const dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    const sx = Math.abs(dx) / (w / 2 || 1);
    const sy = Math.abs(dy) / (hgt / 2 || 1);
    const s = Math.max(sx, sy) || 1;
    return [cx + dx / s, cy + dy / s];
  };

  /**
   * Sets the SVG's height to the drawing fitted to its width (clamped to [min, max]), so a wide diagram gets no empty
   * bands above and below it. Call it after drawing and before the first fit.
   */
  S.fitHeight = function fitHeight(svg, g, min, max) {
    const el = svg.node();
    if (!el || !el.isConnected || !el.clientWidth) return;
    const box = g.node().getBBox();
    if (!box.width || !box.height) return;
    const k = Math.min((el.clientWidth - 48) / box.width, 1.6);
    if (k > 0) svg.attr("height", Math.round(Math.min(max, Math.max(min, box.height * k + 48))));
  };

  /** Hint line under zoomable diagrams. */
  S.hint = function hint(container, text) {
    container.appendChild(
      h(
        "p",
        { class: "vg-figure-hint" },
        text || "Drag to pan · Ctrl/Cmd + scroll or the buttons to zoom · click an element for details",
      ),
    );
  };
})();
