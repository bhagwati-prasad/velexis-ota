/*
 * Velexis Guidebook view: knowledge graph (#/graph?focus=<kind:id>&depth=1|2&mode=3d).
 * 2D: d3-force on a canvas with zoom, pan, drag, filters, search-to-focus and 1-2 hop neighbourhoods.
 * 3D: the same graph with three.js (lazy-loaded), orbit controls, hover labels and click selection.
 */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;
  const RADIUS = { app: 10, class: 7.5, journey: 7.5, page: 6.5, term: 5, individual: 4.5, issue: 5.5 };
  // Above this many nodes the ontology individuals start hidden (their chip turns them on): the full graph is slow to
  // lay out and too dense to read.
  const LARGE_GRAPH = 600;
  // Known issues are a working list, not part of the system's model: their chip starts off (as the individuals' does
  // in a large graph), unless the graph is opened on one of them.
  const HIDDEN_KINDS = ["issue"];

  function colors() {
    const c = {};
    for (const k of VG.GRAPH_KINDS) c[k] = VG.cssVar(`--g-${k}`, "#888");
    c.edge = VG.cssVar("--edge", "#888");
    c.edgeFaint = VG.cssVar("--edge-faint", "#ccc");
    c.text = VG.cssVar("--text", "#111");
    c.muted = VG.cssVar("--text-muted", "#555");
    c.panel = VG.cssVar("--panel", "#fff");
    c.accent = VG.cssVar("--accent", "#06c");
    return c;
  }

  /** Description of a graph node for the detail panel. */
  function describeNode(n) {
    const D = VG.data;
    const [kind, ...rest] = n.id.split(":");
    const id = rest.join(":");
    if (kind === "term") return (D.terms.get(id) || {}).definition || "";
    if (kind === "app") return (D.app(id) || {}).summary || "";
    if (kind === "class") return (D.classes.get(id) || {}).description || "";
    if (kind === "journey") return (D.journeys.get(id) || {}).summary || "";
    if (kind === "page") return (D.pages.get(id) || {}).summary || "";
    if (kind === "issue") {
      const x = D.issues.get(id) || {};
      return `**${x.severity || ""}** ${x.kind || ""} issue, ${x.status || ""}. ${x.summary || ""}`;
    }
    if (kind === "individual") {
      const x = D.individuals.get(id) || {};
      const c = D.classes.get(x.class);
      return `Instance of **${c ? c.label || c.id : x.class}**${x.term ? ` · see [[${x.term}]]` : ""}.`;
    }
    return "";
  }

  VG.views.register("graph", {
    title: () => "Knowledge graph",
    wide: true,
    render(main, route) {
      const D = VG.data;
      const d3 = window.d3;
      VG.layout.setCrumbs([{ label: "Knowledge graph" }]);
      main.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h("h1", {}, "Knowledge graph"),
          h(
            "p",
            { class: "vg-lede" },
            "Apps, glossary terms, ontology classes and individuals, journeys and pages, with the links between them (known issues too, once their chip is on). Search a node to focus it; show its 1- or 2-hop neighbourhood; switch to 3D.",
          ),
        ),
      );
      const all = D.c.graph || { nodes: [], edges: [] };
      if (!all.nodes.length) {
        main.appendChild(
          VG.ui.empty(
            "The graph is empty",
            "It is built from apps, glossary, ontology, journeys and relations; add content and rebuild.",
          ),
        );
        return {};
      }
      if (!d3) {
        main.appendChild(h("p", { class: "vg-muted" }, "The graph needs d3, which did not load."));
        return {};
      }

      /* ---------- model */
      const nodes = all.nodes.map((n) => ({ ...n }));
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const edges = all.edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ ...e }));
      const adj = new Map(nodes.map((n) => [n.id, []]));
      for (const e of edges) {
        adj.get(e.source).push({ id: e.target, e, dir: "out" });
        adj.get(e.target).push({ id: e.source, e, dir: "in" });
      }
      const kindCounts = new Map();
      for (const n of nodes) kindCounts.set(n.kind, (kindCounts.get(n.kind) || 0) + 1);

      const focusParam = route.params.get("focus");
      const defaultKinds = () =>
        new Set(
          VG.GRAPH_KINDS.filter(
            (k) =>
              kindCounts.has(k) &&
              !(
                k === "individual" &&
                nodes.length > LARGE_GRAPH &&
                !String(focusParam).startsWith("individual:")
              ) &&
              !(HIDDEN_KINDS.includes(k) && !String(focusParam).startsWith(`${k}:`)),
          ),
        );
      const state = {
        kinds: defaultKinds(),
        app: "",
        category: "",
        selected:
          route.params.get("focus") && byId.has(route.params.get("focus")) ? route.params.get("focus") : null,
        depth: Number(route.params.get("depth") || (route.params.get("focus") ? 1 : 0)) || 0,
        mode: route.params.get("mode") === "3d" ? "3d" : "2d",
        hover: null,
      };

      function syncUrl() {
        const p = new URLSearchParams();
        if (state.selected) p.set("focus", state.selected);
        if (state.selected && state.depth) p.set("depth", String(state.depth));
        if (state.mode === "3d") p.set("mode", "3d");
        const qs = p.toString();
        history.replaceState(null, "", `#/graph${qs ? "?" + qs : ""}`);
      }

      function visibleSet() {
        let vis = nodes.filter((n) => state.kinds.has(n.kind));
        if (state.app) {
          const appNode = `app:${state.app}`;
          const near = new Set([appNode, ...(adj.get(appNode) || []).map((x) => x.id)]);
          vis = vis.filter((n) => n.app === state.app || near.has(n.id));
        }
        if (state.category) vis = vis.filter((n) => n.kind !== "term" || n.category === state.category);
        let set = new Set(vis.map((n) => n.id));
        if (state.selected && state.depth > 0) {
          const keep = new Set([state.selected]);
          let frontier = [state.selected];
          for (let d = 0; d < state.depth; d++) {
            const next = [];
            for (const id of frontier) {
              for (const x of adj.get(id) || []) {
                if ((set.has(x.id) || x.id === state.selected) && !keep.has(x.id)) {
                  keep.add(x.id);
                  next.push(x.id);
                }
              }
            }
            frontier = next;
          }
          set = keep;
        }
        if (state.selected) set.add(state.selected);
        return set;
      }

      /* ---------- controls */
      const listId = VG.uid("gl");
      const datalist = h(
        "datalist",
        { id: listId },
        nodes
          .slice()
          .sort((a, b) => a.label.localeCompare(b.label))
          .map((n) => h("option", { value: n.label }, `${VG.KIND_LABELS[n.kind] || n.kind}`)),
      );
      const searchInput = h("input", {
        type: "search",
        class: "vg-input",
        list: listId,
        placeholder: "Find a node…",
        "aria-label": "Find a node to focus",
        autocomplete: "off",
      });
      const focusFromSearch = () => {
        const v = searchInput.value.trim().toLowerCase();
        if (!v) return;
        const exact =
          nodes.find((n) => n.label.toLowerCase() === v) ||
          nodes.find((n) => n.label.toLowerCase().startsWith(v)) ||
          nodes.find((n) => n.label.toLowerCase().includes(v) || n.id.toLowerCase().includes(v));
        if (exact) select(exact.id, { depth: state.depth || 1, center: true });
        else VG.ui.toast("No node matches");
      };
      searchInput.addEventListener("change", focusFromSearch);
      searchInput.addEventListener("keydown", (e) => e.key === "Enter" && focusFromSearch());
      const depthSeg = VG.ui.segmented(
        [
          { value: "0", label: "All" },
          { value: "1", label: "1 hop" },
          { value: "2", label: "2 hops" },
        ],
        String(state.depth),
        (v) => {
          state.depth = Number(v);
          syncUrl();
          refresh(true);
        },
        "Neighbourhood depth",
      );
      const modeSeg = VG.ui.segmented(
        [
          { value: "2d", label: "2D", icon: "graph" },
          { value: "3d", label: "3D", icon: "cube" },
        ],
        state.mode,
        (v) => {
          state.mode = v;
          syncUrl();
          mountMode();
        },
        "Graph mode",
      );
      const kindChips = VG.ui.chips(
        VG.GRAPH_KINDS.filter((k) => kindCounts.has(k)).map((k) => ({
          value: k,
          label: VG.KIND_LABELS[k],
          color: `var(--g-${k})`,
          count: kindCounts.get(k),
        })),
        {
          label: "Show kinds",
          selected: [...state.kinds],
          onChange: () => {
            state.kinds = new Set(kindChips.selected);
            refresh(true);
            if (!state.selected) showDetail();
          },
        },
      );
      const appSel = h(
        "select",
        { class: "vg-select", "aria-label": "Filter by app" },
        h("option", { value: "" }, "All apps"),
        D.appList().map((a) => h("option", { value: a.id }, a.name || a.id)),
      );
      appSel.addEventListener("change", () => {
        state.app = appSel.value;
        refresh(true);
      });
      const cats = [...new Set(nodes.filter((n) => n.kind === "term").map((n) => n.category))]
        .filter(Boolean)
        .sort();
      const catSel = h(
        "select",
        { class: "vg-select", "aria-label": "Filter terms by category" },
        h("option", { value: "" }, "All term categories"),
        cats.map((c) => h("option", { value: c }, c)),
      );
      catSel.addEventListener("change", () => {
        state.category = catSel.value;
        refresh(true);
      });
      const stage = h("div", {
        class: "vg-stage",
        style: { height: "min(72vh, 760px)", minHeight: "420px" },
      });
      const panel = h("div", { class: "vg-detail-body" });
      main.appendChild(
        h(
          "div",
          { class: "vg-toolbar" },
          searchInput,
          datalist,
          depthSeg,
          modeSeg,
          h(
            "button",
            { type: "button", class: "vg-btn", onclick: () => clearSelection() },
            VG.icon("reset", null, 16),
            "Reset",
          ),
          h(
            "button",
            {
              type: "button",
              class: "vg-btn",
              onclick: () => VG.ui.toggleFullscreen(stage, () => view && view.resize()),
            },
            VG.icon("expand", null, 16),
            "Fullscreen",
          ),
        ),
      );
      main.appendChild(h("div", { class: "vg-toolbar" }, kindChips.el, appSel, catSel));
      main.appendChild(
        h(
          "div",
          { class: "vg-graph-layout" },
          stage,
          h("aside", { class: "vg-detail", "aria-label": "Selected node" }, panel),
        ),
      );
      stage.addEventListener("vg-resize", () => view && view.resize());

      /* ---------- detail panel */
      function showDetail() {
        VG.clear(panel);
        const n = state.selected && byId.get(state.selected);
        if (!n) {
          panel.appendChild(h("h2", {}, "Nothing selected"));
          panel.appendChild(
            h(
              "p",
              { class: "vg-muted" },
              "Click a node, or find one with the search box. Drag nodes to move them; scroll to zoom; drag the background to pan.",
            ),
          );
          const legend = h(
            "div",
            { class: "vg-legend", style: { padding: 0 } },
            VG.GRAPH_KINDS.filter((k) => kindCounts.has(k)).map((k) =>
              h(
                "span",
                {},
                h("span", { class: "vg-kind-dot", style: { background: `var(--g-${k})` } }),
                `${VG.KIND_LABELS[k]} (${kindCounts.get(k)})`,
              ),
            ),
          );
          panel.appendChild(h("h3", {}, "Legend"));
          panel.appendChild(legend);
          if (kindCounts.has("individual") && !state.kinds.has("individual"))
            panel.appendChild(
              h(
                "p",
                { class: "vg-muted" },
                `The ${kindCounts.get("individual")} individuals are hidden to keep the graph fast and readable: turn on their chip to show them.`,
              ),
            );
          if (kindCounts.has("issue") && !state.kinds.has("issue"))
            panel.appendChild(
              h(
                "p",
                { class: "vg-muted" },
                `The ${kindCounts.get("issue")} known issues are hidden: turn on the Issue chip to see which apps, journeys and terms they touch.`,
              ),
            );
          return;
        }
        panel.appendChild(
          h(
            "div",
            { class: "vg-meta" },
            h("span", { class: "vg-kind-dot", style: { background: `var(--g-${n.kind})` } }),
            VG.KIND_LABELS[n.kind] || n.kind,
            n.app ? h("span", { class: "vg-badge" }, D.appName(n.app)) : null,
            n.category && n.kind === "term" ? h("span", { class: "vg-badge" }, n.category) : null,
          ),
        );
        panel.appendChild(h("h2", {}, n.label));
        const desc = describeNode(n);
        if (desc) panel.appendChild(VG.md.block(desc));
        panel.appendChild(
          h(
            "div",
            { class: "vg-toolbar" },
            n.route ? h("a", { class: "vg-btn is-primary", href: n.route }, "Open") : null,
            h(
              "button",
              { type: "button", class: "vg-btn", onclick: () => select(n.id, { depth: 1 }) },
              "1 hop",
            ),
            h(
              "button",
              { type: "button", class: "vg-btn", onclick: () => select(n.id, { depth: 2 }) },
              "2 hops",
            ),
          ),
        );
        const groups = new Map();
        for (const x of adj.get(n.id) || []) {
          const key = `${x.dir === "out" ? "→" : "←"} ${x.e.label}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(byId.get(x.id));
        }
        panel.appendChild(h("h3", {}, `Links (${(adj.get(n.id) || []).length})`));
        for (const [label, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
          panel.appendChild(
            h("p", { class: "vg-muted", style: { margin: "8px 0 2px", fontSize: "0.85rem" } }, label),
          );
          panel.appendChild(
            h(
              "div",
              { class: "vg-tag-list" },
              list
                .sort((a, b) => a.label.localeCompare(b.label))
                .map((m) =>
                  h(
                    "button",
                    {
                      type: "button",
                      class: "vg-chip",
                      onclick: () => select(m.id, { depth: state.depth, center: true }),
                    },
                    h("span", { class: "vg-kind-dot", style: { background: `var(--g-${m.kind})` } }),
                    m.label,
                  ),
                ),
            ),
          );
        }
      }

      function select(id, opts) {
        const o = opts || {};
        state.selected = id;
        if (o.depth !== null && o.depth !== undefined) state.depth = o.depth;
        for (const b of depthSeg.querySelectorAll("button")) {
          const on = b.dataset.value === String(state.depth);
          b.setAttribute("aria-checked", on ? "true" : "false");
          b.tabIndex = on ? 0 : -1;
        }
        syncUrl();
        showDetail();
        refresh(state.depth > 0 || o.relayout);
        if (view && view.center && (o.center || state.depth > 0)) view.center(id);
      }
      function clearSelection() {
        state.selected = null;
        state.depth = 0;
        state.kinds = defaultKinds();
        kindChips.selected.clear();
        state.kinds.forEach((k) => kindChips.selected.add(k));
        kindChips.render();
        state.app = "";
        appSel.value = "";
        state.category = "";
        catSel.value = "";
        searchInput.value = "";
        select(null, { depth: 0 });
        if (view && view.fit) view.fit();
      }

      /* ---------- 2D renderer */
      function make2D() {
        const canvas = h("canvas", {
          "aria-label":
            "Knowledge graph (use the search box and the detail panel to navigate with the keyboard)",
          role: "img",
        });
        const tip = h("div", { class: "vg-graph-tip" });
        stage.appendChild(canvas);
        stage.appendChild(tip);
        const ctx = canvas.getContext("2d");
        let col = colors();
        let W = 0;
        let H = 0;
        let transform = d3.zoomIdentity;
        let userMoved = false;
        let fittedAtEnd = false;
        let visible = visibleSet();
        let visEdges = [];
        const sim = d3
          .forceSimulation()
          .force(
            "link",
            d3
              .forceLink()
              .id((d) => d.id)
              .distance((l) => (l.source.kind === "app" || l.target.kind === "app" ? 90 : 55))
              .strength(0.35),
          )
          .force(
            "charge",
            d3
              .forceManyBody()
              .strength((d) => (d.kind === "app" ? -420 : -140))
              .distanceMax(500),
          )
          .force("x", d3.forceX(0).strength(0.04))
          .force("y", d3.forceY(0).strength(0.04))
          .force(
            "collide",
            d3.forceCollide((d) => (RADIUS[d.kind] || 5) + 3),
          )
          .alphaDecay(0.03)
          .on("tick", draw);
        if (VG.reducedMotion()) sim.alphaDecay(0.1);

        function size() {
          const r = stage.getBoundingClientRect();
          W = Math.max(200, r.width);
          H = Math.max(200, r.height);
          const dpr = window.devicePixelRatio || 1;
          canvas.width = Math.round(W * dpr);
          canvas.height = Math.round(H * dpr);
          canvas.style.width = W + "px";
          canvas.style.height = H + "px";
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          draw();
        }
        function setData(relayout) {
          visible = visibleSet();
          const vNodes = nodes.filter((n) => visible.has(n.id));
          visEdges = edges.filter(
            (e) => visible.has(e.source.id || e.source) && visible.has(e.target.id || e.target),
          );
          sim.nodes(vNodes);
          sim.force("link").links(visEdges);
          if (relayout) sim.alpha(0.7).restart();
          else draw();
        }
        const neighbourIds = (id) => new Set([id, ...(adj.get(id) || []).map((x) => x.id)]);
        function draw() {
          ctx.save();
          ctx.clearRect(0, 0, W, H);
          ctx.fillStyle = col.panel;
          ctx.fillRect(0, 0, W, H);
          ctx.translate(transform.x, transform.y);
          ctx.scale(transform.k, transform.k);
          const focusId = state.hover || state.selected;
          const near = focusId ? neighbourIds(focusId) : null;
          // edges
          for (const e of visEdges) {
            const s = e.source;
            const t = e.target;
            const on = focusId && (s.id === focusId || t.id === focusId);
            ctx.globalAlpha = near && !on ? 0.12 : on ? 0.95 : 0.45;
            ctx.strokeStyle = on ? col.accent : col.edge;
            ctx.lineWidth = (on ? 2 : 1) / Math.sqrt(transform.k);
            ctx.beginPath();
            ctx.moveTo(s.x, s.y);
            ctx.lineTo(t.x, t.y);
            ctx.stroke();
            if (on || (state.depth > 0 && transform.k > 0.9)) {
              // arrow head
              const ang = Math.atan2(t.y - s.y, t.x - s.x);
              const r = (RADIUS[t.kind] || 5) + 2;
              const ax = t.x - Math.cos(ang) * r;
              const ay = t.y - Math.sin(ang) * r;
              ctx.fillStyle = on ? col.accent : col.edge;
              ctx.beginPath();
              ctx.moveTo(ax, ay);
              ctx.lineTo(ax - Math.cos(ang - 0.4) * 7, ay - Math.sin(ang - 0.4) * 7);
              ctx.lineTo(ax - Math.cos(ang + 0.4) * 7, ay - Math.sin(ang + 0.4) * 7);
              ctx.closePath();
              ctx.fill();
            }
          }
          // edge labels of the focused node
          if (focusId) {
            ctx.globalAlpha = 1;
            ctx.font = `${11 / Math.sqrt(transform.k)}px system-ui, sans-serif`;
            ctx.textAlign = "center";
            for (const e of visEdges) {
              if (e.source.id !== focusId && e.target.id !== focusId) continue;
              const mx = (e.source.x + e.target.x) / 2;
              const my = (e.source.y + e.target.y) / 2;
              ctx.lineWidth = 3 / Math.sqrt(transform.k);
              ctx.strokeStyle = col.panel;
              ctx.strokeText(e.label, mx, my);
              ctx.fillStyle = col.muted;
              ctx.fillText(e.label, mx, my);
            }
          }
          // nodes
          for (const n of sim.nodes()) {
            const r = RADIUS[n.kind] || 5;
            ctx.globalAlpha = near && !near.has(n.id) ? 0.18 : 1;
            ctx.fillStyle = col[n.kind] || col.edge;
            ctx.beginPath();
            if (n.kind === "class") {
              ctx.moveTo(n.x, n.y - r - 1);
              ctx.lineTo(n.x + r + 1, n.y);
              ctx.lineTo(n.x, n.y + r + 1);
              ctx.lineTo(n.x - r - 1, n.y);
              ctx.closePath();
            } else if (n.kind === "app" || n.kind === "journey") {
              ctx.rect(n.x - r, n.y - r, r * 2, r * 2);
            } else if (n.kind === "issue") {
              ctx.moveTo(n.x, n.y - r - 1.5);
              ctx.lineTo(n.x + r + 1, n.y + r);
              ctx.lineTo(n.x - r - 1, n.y + r);
              ctx.closePath();
            } else ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
            ctx.fill();
            if (n.id === state.selected || n.id === state.hover) {
              ctx.lineWidth = 3 / Math.sqrt(transform.k);
              ctx.strokeStyle = col.accent;
              ctx.stroke();
            }
          }
          // labels: apps always; classes, journeys and pages once zoomed in a little (or when few nodes are shown)
          ctx.textAlign = "center";
          const crowded = sim.nodes().length > 150 && transform.k < 0.9;
          for (const n of sim.nodes()) {
            const important =
              n.kind === "app" ||
              (!crowded && (n.kind === "class" || n.kind === "journey" || n.kind === "page"));
            const show = important || transform.k > 1.6 || (near && near.has(n.id)) || state.depth > 0;
            if (!show) continue;
            ctx.globalAlpha = near && !near.has(n.id) ? 0.25 : 1;
            const fs = (n.kind === "app" ? 13 : 11) / Math.sqrt(Math.max(0.6, transform.k));
            ctx.font = `${n.kind === "app" || n.id === state.selected ? 600 : 400} ${fs}px system-ui, sans-serif`;
            const y = n.y - (RADIUS[n.kind] || 5) - 4;
            ctx.lineWidth = 3 / Math.sqrt(transform.k);
            ctx.strokeStyle = col.panel;
            ctx.strokeText(n.label, n.x, y);
            ctx.fillStyle = col.text;
            ctx.fillText(n.label, n.x, y);
          }
          ctx.restore();
        }
        const findAtXY = (sx, sy) => {
          const [x, y] = transform.invert([sx, sy]);
          return sim.find(x, y, 14 / Math.sqrt(transform.k)) || null;
        };
        const findAt = (ev) => {
          const r = canvas.getBoundingClientRect();
          return findAtXY(ev.clientX - r.left, ev.clientY - r.top);
        };
        const zoom = d3
          .zoom()
          .scaleExtent([0.1, 6])
          .on("zoom", (e) => {
            if (e.sourceEvent) userMoved = true;
            transform = e.transform;
            draw();
          });
        const drag = d3
          .drag()
          .container(canvas)
          .subject((ev) => {
            // drag works in screen coordinates; the node is converted with the zoom transform
            const n = findAtXY(ev.x, ev.y);
            return n ? { node: n, x: transform.applyX(n.x), y: transform.applyY(n.y) } : null;
          })
          .on("start", (ev) => {
            if (!ev.active) sim.alphaTarget(0.25).restart();
            ev.subject.node.fx = ev.subject.node.x;
            ev.subject.node.fy = ev.subject.node.y;
          })
          .on("drag", (ev) => {
            const [x, y] = transform.invert([ev.x, ev.y]);
            ev.subject.node.fx = x;
            ev.subject.node.fy = y;
          })
          .on("end", (ev) => {
            if (!ev.active) sim.alphaTarget(0);
            ev.subject.node.fx = null;
            ev.subject.node.fy = null;
          });
        d3.select(canvas).call(drag).call(zoom).on("dblclick.zoom", null);
        let downAt = null;
        canvas.addEventListener("pointerdown", (ev) => (downAt = { x: ev.clientX, y: ev.clientY }));
        canvas.addEventListener("click", (ev) => {
          if (downAt && Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5) return;
          const n = findAt(ev);
          if (n) select(n.id, { depth: state.depth });
        });
        canvas.addEventListener("pointermove", (ev) => {
          const n = findAt(ev);
          const id = n ? n.id : null;
          if (id !== state.hover) {
            state.hover = id;
            canvas.style.cursor = id ? "pointer" : "grab";
            draw();
          }
          if (n) {
            const r = stage.getBoundingClientRect();
            tip.textContent = `${n.label} · ${VG.KIND_LABELS[n.kind] || n.kind}`;
            tip.style.left = ev.clientX - r.left + "px";
            tip.style.top = ev.clientY - r.top + "px";
            tip.classList.add("is-on");
          } else tip.classList.remove("is-on");
        });
        canvas.addEventListener("pointerleave", () => {
          state.hover = null;
          tip.classList.remove("is-on");
          draw();
        });
        const ro = new ResizeObserver(() => size());
        ro.observe(stage);
        const offTheme = VG.on("theme", () => {
          col = colors();
          draw();
        });
        size();
        setData(true);
        // initial zoom so the whole graph fits; fit again when the layout has settled unless the reader moved it
        sim.tick(160);
        fitNow();
        sim.on("end.fit", () => {
          if (!userMoved && !fittedAtEnd && !state.selected) {
            fittedAtEnd = true;
            fitNow();
          }
        });
        function fitNow() {
          const ns = sim.nodes();
          if (!ns.length) return;
          const x0 = d3.min(ns, (n) => n.x) - 30;
          const x1 = d3.max(ns, (n) => n.x) + 30;
          const y0 = d3.min(ns, (n) => n.y) - 30;
          const y1 = d3.max(ns, (n) => n.y) + 30;
          const k = Math.min(W / (x1 - x0), H / (y1 - y0), 2.2);
          const t = d3.zoomIdentity
            .translate(W / 2, H / 2)
            .scale(k)
            .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
          d3.select(canvas).call(zoom.transform, t);
        }
        return {
          refresh(relayout) {
            setData(relayout);
            if (relayout) setTimeout(() => state.depth > 0 && fitNow(), VG.reducedMotion() ? 0 : 600);
          },
          center(id) {
            const n = byId.get(id);
            if (!n || n.x === null || n.x === undefined) return;
            const k = Math.max(transform.k, 1.2);
            const t = d3.zoomIdentity
              .translate(W / 2, H / 2)
              .scale(k)
              .translate(-n.x, -n.y);
            const sel = d3.select(canvas);
            (VG.reducedMotion() ? sel : sel.transition().duration(450)).call(zoom.transform, t);
          },
          fit: fitNow,
          resize: size,
          destroy() {
            sim.stop();
            ro.disconnect();
            offTheme();
            VG.clear(stage);
          },
        };
      }

      /* ---------- 3D renderer (three.js, lazy) */
      function make3D() {
        const loading = h("p", { class: "vg-muted", style: { padding: "16px" } }, "Loading the 3D view…");
        stage.appendChild(loading);
        if (!VG.three.webglAvailable()) {
          loading.replaceWith(
            VG.three.unavailable("WebGL is not available in this browser. Use the 2D view."),
          );
          return { refresh() {}, resize() {}, destroy: () => VG.clear(stage) };
        }
        let disposed = false;
        let api = null;
        const inst = {
          refresh: (r) => api && api.refresh(r),
          resize: () => api && api.resize(),
          center: (id) => api && api.center(id),
          fit: () => api && api.fit(),
          destroy() {
            disposed = true;
            if (api) api.destroy();
            VG.clear(stage);
          },
        };
        VG.three
          .load()
          .then((lib) => {
            if (disposed) return;
            loading.remove();
            api = build3D(lib);
          })
          .catch((err) => {
            if (disposed) return;
            loading.replaceWith(
              VG.three.unavailable(
                `The 3D library could not be loaded (${err && err.message ? err.message : "network"}). Use the 2D view.`,
              ),
            );
          });
        return inst;
      }

      function layout3D(list, links) {
        // seed: 2D positions if any, z by kind; then a short force relaxation in 3D
        const kindZ = { app: 0, journey: 60, page: 60, term: -40, class: 120, individual: 90, issue: -90 };
        const idx = new Map(list.map((n, i) => [n.id, i]));
        const P = list.map((n, i) => ({
          x: n.x ?? Math.cos(i) * 200,
          y: n.y !== null && n.y !== undefined ? -n.y : Math.sin(i) * 200,
          z: (kindZ[n.kind] || 0) + ((i * 37) % 40) - 20,
          vx: 0,
          vy: 0,
          vz: 0,
        }));
        const L = links
          .map((e) => [idx.get(e.source.id || e.source), idx.get(e.target.id || e.target)])
          .filter(([a, b]) => a !== null && a !== undefined && b !== null && b !== undefined);
        // Each link pulls with 1 / (degree of its less-linked end), as d3.forceLink does: without it a hub with
        // hundreds of links sums every pull, overshoots and the layout diverges.
        const deg = new Array(P.length).fill(0);
        for (const [i, j] of L) {
          deg[i]++;
          deg[j]++;
        }
        const n = P.length;
        const iters = n > 900 ? 40 : 90;
        for (let it = 0; it < iters; it++) {
          const alpha = 1 - it / iters;
          for (let i = 0; i < n; i++) {
            const a = P[i];
            for (let j = i + 1; j < n; j++) {
              const b = P[j];
              let dx = a.x - b.x;
              let dy = a.y - b.y;
              let dz = a.z - b.z;
              let d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > 90000) continue;
              if (d2 < 1) d2 = 1;
              const f = (900 * alpha) / d2;
              dx *= f;
              dy *= f;
              dz *= f;
              a.vx += dx;
              a.vy += dy;
              a.vz += dz;
              b.vx -= dx;
              b.vy -= dy;
              b.vz -= dz;
            }
          }
          for (const [i, j] of L) {
            const a = P[i];
            const b = P[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dz = b.z - a.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            const f = (((d - 60) / d) * 0.5 * alpha) / Math.min(deg[i], deg[j]);
            a.vx += dx * f;
            a.vy += dy * f;
            a.vz += dz * f;
            b.vx -= dx * f;
            b.vy -= dy * f;
            b.vz -= dz * f;
          }
          for (const p of P) {
            p.vx -= p.x * 0.01 * alpha;
            p.vy -= p.y * 0.01 * alpha;
            p.vz -= p.z * 0.01 * alpha;
            const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
            if (v > 40) {
              p.vx *= 40 / v;
              p.vy *= 40 / v;
              p.vz *= 40 / v;
            }
            p.x += p.vx;
            p.y += p.vy;
            p.z += p.vz;
            p.vx *= 0.6;
            p.vy *= 0.6;
            p.vz *= 0.6;
          }
        }
        list.forEach((nd, i) => {
          nd.p3 = P[i];
        });
      }

      function build3D(lib) {
        const { THREE, OrbitControls, CSS2DRenderer, CSS2DObject } = lib;
        let col = colors();
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        const labelRenderer = new CSS2DRenderer();
        labelRenderer.domElement.style.position = "absolute";
        labelRenderer.domElement.style.inset = "0";
        labelRenderer.domElement.style.pointerEvents = "none";
        stage.appendChild(renderer.domElement);
        stage.appendChild(labelRenderer.domElement);
        renderer.domElement.setAttribute(
          "aria-label",
          "Knowledge graph in 3D: drag to orbit, scroll to zoom, click a node to select it",
        );
        renderer.domElement.setAttribute("role", "img");
        const tip = h("div", { class: "vg-graph-tip" });
        stage.appendChild(tip);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(col.panel);
        const camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
        camera.position.set(0, 0, 900);
        scene.add(new THREE.AmbientLight(0xffffff, 1.6));
        const dl = new THREE.DirectionalLight(0xffffff, 1.4);
        dl.position.set(300, 500, 600);
        scene.add(dl);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = !VG.reducedMotion();
        controls.dampingFactor = 0.08;
        // Render on demand: a frame is drawn only after a change (orbit, damping, selection, resize, theme), so an
        // idle view costs nothing; with ~1000 nodes a continuous loop keeps the main thread busy on slow GPUs.
        let frame = 0;
        let stopped = false;
        function requestRender() {
          if (!frame && !stopped) frame = requestAnimationFrame(renderFrame);
        }
        function renderFrame() {
          frame = 0;
          if (controls.update()) requestRender(); // damping is still moving the camera
          renderer.render(scene, camera);
          labelRenderer.render(scene, camera);
        }
        controls.addEventListener("change", requestRender);

        const geo = {
          sphere: new THREE.SphereGeometry(1, 12, 8),
          box: new THREE.BoxGeometry(1.7, 1.7, 1.7),
          oct: new THREE.OctahedronGeometry(1.35),
          tetra: new THREE.TetrahedronGeometry(1.45),
        };
        const shapeOf = (k) =>
          k === "app" || k === "journey"
            ? geo.box
            : k === "class"
              ? geo.oct
              : k === "issue"
                ? geo.tetra
                : geo.sphere;
        const group = new THREE.Group();
        scene.add(group);
        const meshes = new Map();
        let edgeLines = null;
        let hlLines = null;
        const labels = new Map();
        const dispose = [];

        function rebuild() {
          for (const m of meshes.values()) {
            group.remove(m);
            m.material.dispose();
          }
          meshes.clear();
          for (const l of labels.values()) {
            l.parent && l.parent.remove(l);
            l.element.remove();
          }
          labels.clear();
          if (edgeLines) {
            group.remove(edgeLines);
            edgeLines.geometry.dispose();
            edgeLines.material.dispose();
            edgeLines = null;
          }
          const visible = visibleSet();
          const list = nodes.filter((n) => visible.has(n.id));
          const links = edges.filter(
            (e) => visible.has(e.source.id || e.source) && visible.has(e.target.id || e.target),
          );
          layout3D(list, links);
          for (const n of list) {
            const mat = new THREE.MeshStandardMaterial({
              color: new THREE.Color(col[n.kind] || col.edge),
              roughness: 0.55,
              metalness: 0.05,
              transparent: true,
              opacity: 1,
            });
            const mesh = new THREE.Mesh(shapeOf(n.kind), mat);
            const r = (RADIUS[n.kind] || 5) * 0.9;
            mesh.scale.setScalar(r);
            mesh.position.set(n.p3.x, n.p3.y, n.p3.z);
            mesh.userData.node = n;
            group.add(mesh);
            meshes.set(n.id, mesh);
            // labels: apps always, classes while the view is not crowded, everything in small views
            if (n.kind === "app" || (n.kind === "class" && list.length < 300) || list.length < 60)
              addLabel(n, mesh);
          }
          const pos = [];
          for (const e of links) {
            const a = meshes.get(e.source.id || e.source);
            const b = meshes.get(e.target.id || e.target);
            if (!a || !b) continue;
            pos.push(a.position.x, a.position.y, a.position.z, b.position.x, b.position.y, b.position.z);
          }
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          edgeLines = new THREE.LineSegments(
            g,
            new THREE.LineBasicMaterial({
              color: new THREE.Color(col.edge),
              transparent: true,
              opacity: 0.35,
            }),
          );
          group.add(edgeLines);
          highlight();
        }
        function addLabel(n, mesh) {
          if (labels.has(n.id)) return;
          const el = h(
            "div",
            { class: `vg-label3d ${n.kind === "app" || n.kind === "class" ? "" : "is-small"}` },
            n.label,
          );
          const obj = new CSS2DObject(el);
          obj.position.set(0, 1.8, 0);
          mesh.add(obj);
          labels.set(n.id, obj);
        }
        function highlight() {
          const focusId = state.selected;
          const near = focusId ? new Set([focusId, ...(adj.get(focusId) || []).map((x) => x.id)]) : null;
          for (const [id, m] of meshes) {
            m.material.opacity = near && !near.has(id) ? 0.18 : 1;
            m.material.emissive = new THREE.Color(id === focusId ? col.accent : 0x000000);
            m.material.emissiveIntensity = id === focusId ? 0.6 : 0;
            if (near && near.has(id)) addLabel(m.userData.node, m);
          }
          for (const [id, l] of labels) l.element.classList.toggle("is-hl", id === focusId);
          if (hlLines) {
            group.remove(hlLines);
            hlLines.geometry.dispose();
            hlLines.material.dispose();
            hlLines = null;
          }
          if (edgeLines) edgeLines.material.opacity = focusId ? 0.12 : 0.35;
          if (focusId && meshes.has(focusId)) {
            const pos = [];
            for (const x of adj.get(focusId) || []) {
              const a = meshes.get(focusId);
              const b = meshes.get(x.id);
              if (b)
                pos.push(a.position.x, a.position.y, a.position.z, b.position.x, b.position.y, b.position.z);
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
            hlLines = new THREE.LineSegments(
              g,
              new THREE.LineBasicMaterial({ color: new THREE.Color(col.accent) }),
            );
            group.add(hlLines);
          }
          requestRender();
        }
        function fit() {
          const box = new THREE.Box3().setFromObject(group);
          if (box.isEmpty()) return;
          const c = box.getCenter(new THREE.Vector3());
          const s = box.getSize(new THREE.Vector3()).length();
          controls.target.copy(c);
          camera.position.set(c.x, c.y + s * 0.1, c.z + s * 0.9 + 100);
          camera.near = 1;
          camera.far = s * 10 + 2000;
          camera.updateProjectionMatrix();
          controls.update();
          requestRender();
        }
        function center(id) {
          const m = meshes.get(id);
          if (!m) return;
          const target = m.position.clone();
          const dir = camera.position.clone().sub(controls.target).normalize();
          controls.target.copy(target);
          camera.position.copy(target.clone().add(dir.multiplyScalar(260)));
          controls.update();
          requestRender();
        }
        function resize() {
          const r = stage.getBoundingClientRect();
          const w = Math.max(200, r.width);
          const hh = Math.max(200, r.height);
          renderer.setSize(w, hh);
          labelRenderer.setSize(w, hh);
          camera.aspect = w / hh;
          camera.updateProjectionMatrix();
          requestRender();
        }
        // picking
        const ray = new THREE.Raycaster();
        const ptr = new THREE.Vector2();
        const pick = (ev) => {
          const r = renderer.domElement.getBoundingClientRect();
          ptr.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
          ptr.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
          ray.setFromCamera(ptr, camera);
          const hit = ray.intersectObjects([...meshes.values()], false)[0];
          return hit ? hit.object.userData.node : null;
        };
        let down = null;
        const onDown = (ev) => (down = { x: ev.clientX, y: ev.clientY });
        const onUp = (ev) => {
          if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return;
          const n = pick(ev);
          if (n) select(n.id, { depth: state.depth });
        };
        let raf = 0;
        const onMove = (ev) => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            const n = pick(ev);
            if (n) {
              const r = stage.getBoundingClientRect();
              tip.textContent = `${n.label} · ${VG.KIND_LABELS[n.kind] || n.kind}`;
              tip.style.left = ev.clientX - r.left + "px";
              tip.style.top = ev.clientY - r.top + "px";
              tip.classList.add("is-on");
              renderer.domElement.style.cursor = "pointer";
            } else {
              tip.classList.remove("is-on");
              renderer.domElement.style.cursor = "grab";
            }
          });
        };
        renderer.domElement.addEventListener("pointerdown", onDown);
        renderer.domElement.addEventListener("pointerup", onUp);
        renderer.domElement.addEventListener("pointermove", onMove);
        const ro = new ResizeObserver(resize);
        ro.observe(stage);
        const offTheme = VG.on("theme", () => {
          col = colors();
          scene.background = new THREE.Color(col.panel);
          rebuild();
        });
        resize();
        rebuild();
        fit();
        if (state.selected) center(state.selected);
        requestRender();
        VG.graph3d = { scene, camera, meshes, renderer, requestRender };
        return {
          refresh(relayout) {
            if (relayout) {
              rebuild();
              if (state.selected && state.depth > 0) fit();
            } else highlight();
          },
          resize,
          fit,
          center,
          destroy() {
            stopped = true;
            cancelAnimationFrame(frame);
            cancelAnimationFrame(raf);
            ro.disconnect();
            offTheme();
            controls.removeEventListener("change", requestRender);
            controls.dispose();
            for (const m of meshes.values()) m.material.dispose();
            for (const g of Object.values(geo)) g.dispose();
            if (edgeLines) {
              edgeLines.geometry.dispose();
              edgeLines.material.dispose();
            }
            if (hlLines) {
              hlLines.geometry.dispose();
              hlLines.material.dispose();
            }
            dispose.forEach((f) => f());
            renderer.dispose();
            renderer.forceContextLoss();
            VG.graph3d = null;
          },
        };
      }

      /* ---------- mode switching */
      let view = null;
      function mountMode() {
        if (view) view.destroy();
        VG.clear(stage);
        view = state.mode === "3d" ? make3D() : make2D();
        VG.graphView = { state, view, select };
      }
      function refresh(relayout) {
        if (view) view.refresh(relayout);
      }
      showDetail();
      mountMode();
      if (state.selected && view.center)
        setTimeout(() => view && view.center && view.center(state.selected), 50);
      return {
        destroy() {
          if (view) view.destroy();
          view = null;
          VG.graphView = null;
        },
        update(r) {
          const focus = r.params.get("focus");
          const mode = r.params.get("mode") === "3d" ? "3d" : "2d";
          if (mode !== state.mode) {
            state.mode = mode;
            for (const b of modeSeg.querySelectorAll("button"))
              b.setAttribute("aria-checked", b.dataset.value === mode ? "true" : "false");
            mountMode();
          }
          if (focus && byId.has(focus))
            select(focus, { depth: Number(r.params.get("depth") || 1), center: true });
          else if (!focus && state.selected) select(null, { depth: 0 });
          return true;
        },
      };
    },
  });
})();
