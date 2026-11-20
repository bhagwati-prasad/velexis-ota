/*
 * Velexis Guidebook view: System 3D (#/system?flow=<id>&node=<id>). Layers of content/system/topology.json as stacked
 * translucent planes, nodes as shapes per kind, links as lines; a flow picker animates a pulse hop by hop with a
 * caption. three.js is loaded lazily; without WebGL the view falls back to the 2D map and text flows.
 */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;
  const HOP_MS = 1300;
  const PAUSE_MS = 450;

  function nodeDetail(panel, n, topo) {
    const D = VG.data;
    VG.clear(panel);
    if (!n) {
      panel.appendChild(h("h2", {}, "Pick a node or a flow"));
      panel.appendChild(
        h(
          "p",
          { class: "vg-muted" },
          "Drag to orbit, scroll to zoom, right-drag to pan. Click a node to see what it is and what it talks to. Pick a flow and press Play to watch a request travel hop by hop.",
        ),
      );
      const layers = h(
        "ol",
        {},
        (topo.layers || []).map((l) =>
          h(
            "li",
            {},
            l.label || l.id,
            h(
              "span",
              { class: "vg-muted" },
              ` (${(topo.nodes || []).filter((x) => x.layer === l.id).length})`,
            ),
          ),
        ),
      );
      panel.appendChild(h("h3", {}, "Layers, top to bottom"));
      panel.appendChild(layers);
      return;
    }
    const layer = (topo.layers || []).find((l) => l.id === n.layer);
    panel.appendChild(
      h(
        "div",
        { class: "vg-meta" },
        h("span", { class: "vg-kind-dot", style: { background: VG.kindVar(n.kind) } }),
        VG.KIND_LABELS[n.kind] || n.kind,
        layer ? h("span", { class: "vg-badge" }, layer.label || layer.id) : null,
      ),
    );
    panel.appendChild(h("h2", {}, n.label));
    if (n.detail) panel.appendChild(VG.md.block(n.detail, { app: n.app || null }));
    if (n.app && D.app(n.app)) {
      panel.appendChild(
        h(
          "div",
          { class: "vg-toolbar" },
          h("a", { class: "vg-btn is-primary", href: VG.routes.app(n.app, "usage") }, "Usage"),
          h("a", { class: "vg-btn", href: VG.routes.app(n.app, "architecture") }, "Architecture"),
          h("a", { class: "vg-btn", href: VG.routes.app(n.app, "facts") }, "Facts"),
        ),
      );
    }
    const label = (id) => ((topo.nodes || []).find((x) => x.id === id) || {}).label || id;
    const links = (topo.links || []).filter((l) => l.from === n.id || l.to === n.id);
    panel.appendChild(h("h3", {}, `Links (${links.length})`));
    panel.appendChild(
      links.length
        ? h(
            "ul",
            {},
            links.map((l) =>
              h(
                "li",
                {},
                l.from === n.id ? `→ ${label(l.to)}` : `← ${label(l.from)}`,
                h("span", { class: "vg-muted" }, `: ${l.label || ""} (${l.kind || "sync"})`),
              ),
            ),
          )
        : h("p", { class: "vg-muted" }, "None."),
    );
    const flows = (topo.flows || []).filter((f) =>
      (f.path || []).some((p) => p.from === n.id || p.to === n.id),
    );
    if (flows.length) {
      panel.appendChild(h("h3", {}, "In flows"));
      panel.appendChild(
        h(
          "ul",
          {},
          flows.map((f) => h("li", {}, h("a", { href: VG.routes.system(f.id) }, f.title || f.id))),
        ),
      );
    }
  }

  function textFlows(topo) {
    const label = (id) => ((topo.nodes || []).find((x) => x.id === id) || {}).label || id;
    return h(
      "div",
      {},
      (topo.flows || []).map((f) =>
        h(
          "section",
          { class: "vg-box", style: { marginTop: "12px" } },
          h("h3", {}, f.title || f.id),
          f.summary ? h("p", { class: "vg-muted" }, f.summary) : null,
          h(
            "ol",
            {},
            (f.path || []).map((p) => h("li", {}, `${label(p.from)} → ${label(p.to)}: ${p.label || ""}`)),
          ),
        ),
      ),
    );
  }

  VG.views.register("system", {
    title: () => "System 3D",
    wide: true,
    render(main, route) {
      const D = VG.data;
      const topo = D.c.topology;
      VG.layout.setCrumbs([{ label: "System 3D" }]);
      main.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h("h1", {}, "System 3D"),
          h(
            "p",
            { class: "vg-lede" },
            "The deployment as stacked layers, from people at the top to external services at the bottom. Pick a flow and play it to follow a request hop by hop.",
          ),
        ),
      );
      if (!topo || !(topo.nodes || []).length) {
        main.appendChild(VG.ui.empty("No topology yet", "Add content/system/topology.json and rebuild."));
        return {};
      }
      const flows = topo.flows || [];
      const state = {
        flow: flows.find((f) => f.id === route.params.get("flow"))
          ? route.params.get("flow")
          : flows[0]
            ? flows[0].id
            : null,
        hop: 0,
        t: 0,
        playing: false,
        node: route.params.get("node") || null,
      };
      const caption = h("div", { class: "vg-flow-caption", "aria-live": "polite" });
      const stage = h("div", {
        class: "vg-stage",
        style: { height: "min(70vh, 720px)", minHeight: "420px" },
      });
      const panel = h("div", { class: "vg-detail-body" });
      const flowSel = h(
        "select",
        { class: "vg-select", "aria-label": "Flow" },
        flows.map((f) => h("option", { value: f.id }, f.title || f.id)),
      );
      if (state.flow) flowSel.value = state.flow;
      const playBtn = h(
        "button",
        { type: "button", class: "vg-btn is-primary", id: "vg-flow-play" },
        VG.icon("play", null, 16),
        h("span", {}, "Play"),
      );
      const prevBtn = h(
        "button",
        { type: "button", class: "vg-btn", "aria-label": "Previous hop" },
        VG.icon("prev", null, 16),
        "Prev",
      );
      const nextBtn = h(
        "button",
        { type: "button", class: "vg-btn", "aria-label": "Next hop" },
        "Next",
        VG.icon("next", null, 16),
      );
      const resetBtn = h(
        "button",
        { type: "button", class: "vg-btn" },
        VG.icon("reset", null, 16),
        "Reset view",
      );
      const fsBtn = h(
        "button",
        { type: "button", class: "vg-btn" },
        VG.icon("expand", null, 16),
        "Fullscreen",
      );
      main.appendChild(
        h(
          "div",
          { class: "vg-toolbar" },
          flows.length
            ? [h("label", { class: "vg-muted" }, "Flow"), flowSel, prevBtn, playBtn, nextBtn]
            : h("span", { class: "vg-muted" }, "No flows defined."),
          h("span", { class: "vg-spacer" }),
          resetBtn,
          fsBtn,
        ),
      );
      main.appendChild(
        h(
          "div",
          { class: "vg-graph-layout" },
          stage,
          h("aside", { class: "vg-detail", "aria-label": "Selected node" }, panel),
        ),
      );
      const flowSummary = h("p", { class: "vg-muted" });
      main.appendChild(flowSummary);
      nodeDetail(
        panel,
        (topo.nodes || []).find((n) => n.id === state.node),
        topo,
      );

      const curFlow = () => flows.find((f) => f.id === state.flow) || null;
      const label = (id) => ((topo.nodes || []).find((x) => x.id === id) || {}).label || id;
      function setCaption() {
        const f = curFlow();
        if (!f) {
          caption.textContent = "";
          caption.hidden = true;
          return;
        }
        caption.hidden = false;
        flowSummary.textContent = f.summary || "";
        const hop = (f.path || [])[state.hop];
        VG.clear(caption);
        if (!hop) return;
        caption.appendChild(h("strong", {}, `Hop ${state.hop + 1} of ${f.path.length}`));
        caption.appendChild(document.createTextNode(` · ${label(hop.from)} → ${label(hop.to)}: `));
        caption.appendChild(h("span", {}, hop.label || ""));
      }
      function setPlaying(on) {
        state.playing = on;
        VG.clear(playBtn).appendChild(VG.icon(on ? "pause" : "play", null, 16));
        playBtn.appendChild(h("span", {}, on ? "Pause" : "Play"));
        playBtn.setAttribute("aria-pressed", on ? "true" : "false");
      }
      function syncUrl() {
        const p = new URLSearchParams();
        if (state.flow) p.set("flow", state.flow);
        if (state.node) p.set("node", state.node);
        history.replaceState(null, "", `#/system${p.toString() ? "?" + p : ""}`);
      }
      function step(delta) {
        const f = curFlow();
        if (!f) return;
        setPlaying(false);
        state.hop = Math.max(0, Math.min(f.path.length - 1, state.hop + delta));
        state.t = 1;
        setCaption();
        if (scene) scene.showHop();
      }
      flowSel.addEventListener("change", () => {
        state.flow = flowSel.value;
        state.hop = 0;
        state.t = 0;
        setCaption();
        syncUrl();
        if (scene) scene.showHop();
        setPlaying(!VG.reducedMotion());
      });
      playBtn.addEventListener("click", () => {
        const f = curFlow();
        if (!f) return;
        if (!state.playing && state.hop >= f.path.length - 1 && state.t >= 1) {
          state.hop = 0;
          state.t = 0;
        }
        if (VG.reducedMotion()) {
          // no animation: advance one hop per press
          if (state.t >= 1) state.hop = Math.min(f.path.length - 1, state.hop + 1);
          state.t = 1;
          setCaption();
          if (scene) scene.showHop();
          return;
        }
        setPlaying(!state.playing);
      });
      prevBtn.addEventListener("click", () => step(-1));
      nextBtn.addEventListener("click", () => step(1));
      fsBtn.addEventListener("click", () => VG.ui.toggleFullscreen(stage, () => scene && scene.resize()));
      stage.addEventListener("vg-resize", () => scene && scene.resize());
      stage.appendChild(caption);
      setCaption();

      let scene = null;
      let disposed = false;
      const fallback = (reason) => {
        VG.clear(stage);
        stage.style.height = "auto";
        stage.appendChild(VG.three.unavailable(reason));
        const mapHost = h("div", { class: "vg-map" });
        stage.appendChild(mapHost);
        if (window.d3 && VG.homeMap) VG.homeMap.drawMap(mapHost);
        stage.appendChild(textFlows(topo));
      };
      if (!VG.three.webglAvailable())
        fallback("WebGL is not available in this browser; showing the 2D map and the flows as text.");
      else {
        const loading = h("p", { class: "vg-muted", style: { padding: "16px" } }, "Loading the 3D view…");
        stage.appendChild(loading);
        VG.three
          .load()
          .then((lib) => {
            if (disposed) return;
            loading.remove();
            scene = build(lib);
            VG.system3d = { state, scene };
            if (state.flow && !VG.reducedMotion() && !state.node) setPlaying(true);
          })
          .catch((err) => {
            if (!disposed)
              fallback(
                `The 3D library could not be loaded (${err && err.message ? err.message : "network"}); showing the 2D map and the flows as text.`,
              );
          });
      }

      function build(lib) {
        const { THREE, OrbitControls, CSS2DRenderer, CSS2DObject } = lib;
        const css = (n, f) => new THREE.Color(VG.cssVar(n, f));
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        const labelRenderer = new CSS2DRenderer();
        Object.assign(labelRenderer.domElement.style, {
          position: "absolute",
          inset: "0",
          pointerEvents: "none",
        });
        stage.insertBefore(renderer.domElement, caption);
        stage.insertBefore(labelRenderer.domElement, caption);
        renderer.domElement.setAttribute("role", "img");
        renderer.domElement.setAttribute(
          "aria-label",
          "System in 3D: drag to orbit, scroll to zoom, click a node for details",
        );
        const tip = h("div", { class: "vg-graph-tip" });
        stage.appendChild(tip);
        const sc = new THREE.Scene();
        sc.background = css("--panel", "#fff");
        const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = !VG.reducedMotion();
        controls.dampingFactor = 0.08;
        sc.add(new THREE.AmbientLight(0xffffff, 1.5));
        const dl = new THREE.DirectionalLight(0xffffff, 1.5);
        dl.position.set(200, 400, 300);
        sc.add(dl);

        const layers = (topo.layers || []).filter((l) => (topo.nodes || []).some((n) => n.layer === l.id));
        const GAP = 125;
        const STEP = 135;
        const perLayer = layers.map((l) => (topo.nodes || []).filter((n) => n.layer === l.id));
        const maxPer = Math.max(...perLayer.map((x) => x.length), 1);
        const perRowMax = maxPer > 6 ? Math.ceil(maxPer / 2) : maxPer;
        const width = Math.max(360, perRowMax * STEP + 60);
        const depthZ = maxPer > 6 ? 210 : 150;
        const pos = new Map();
        const disposables = [];
        const layerColors = [
          "--p-platform",
          "--g-class",
          "--p-shared",
          "--p-ota",
          "--g-term",
          "--k-external",
        ];
        layers.forEach((l, i) => {
          const y = ((layers.length - 1) / 2 - i) * GAP;
          const pg = new THREE.PlaneGeometry(width, depthZ);
          const pm = new THREE.MeshBasicMaterial({
            color: css(layerColors[i % layerColors.length]),
            transparent: true,
            opacity: 0.09,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
          const plane = new THREE.Mesh(pg, pm);
          plane.rotation.x = -Math.PI / 2;
          plane.position.y = y;
          sc.add(plane);
          const eg = new THREE.EdgesGeometry(pg);
          const em = new THREE.LineBasicMaterial({
            color: css(layerColors[i % layerColors.length]),
            transparent: true,
            opacity: 0.45,
          });
          const edge = new THREE.LineSegments(eg, em);
          edge.rotation.x = -Math.PI / 2;
          edge.position.y = y;
          sc.add(edge);
          disposables.push(pg, pm, eg, em);
          const el = h("div", { class: "vg-label3d is-small" }, l.label || l.id);
          const lab = new CSS2DObject(el);
          lab.position.set(-width / 2 - 10, y, depthZ / 2);
          sc.add(lab);
          const list = perLayer[i];
          const rows = list.length > 6 ? 2 : 1;
          const perRow = Math.ceil(list.length / rows);
          list.forEach((n, k) => {
            const row = Math.floor(k / perRow);
            const col = k % perRow;
            const countInRow = row === rows - 1 ? list.length - perRow * (rows - 1) : perRow;
            const x = (col - (countInRow - 1) / 2) * STEP;
            const z = rows === 1 ? 0 : (row - 0.5) * 100;
            pos.set(n.id, new THREE.Vector3(x, y + 13, z));
          });
        });
        const GEO = {
          user: new THREE.CapsuleGeometry(5, 8, 4, 12),
          edge: new THREE.OctahedronGeometry(9),
          ui: new THREE.BoxGeometry(20, 13, 4),
          api: new THREE.CylinderGeometry(9, 9, 14, 6),
          worker: new THREE.DodecahedronGeometry(9),
          db: new THREE.CylinderGeometry(9, 9, 15, 24),
          cache: new THREE.TorusGeometry(7, 3, 10, 24),
          queue: new THREE.BoxGeometry(24, 7, 9),
          storage: new THREE.CylinderGeometry(11, 11, 6, 24),
          external: new THREE.IcosahedronGeometry(9),
        };
        Object.values(GEO).forEach((g) => disposables.push(g));
        const meshes = new Map();
        for (const n of topo.nodes || []) {
          const p = pos.get(n.id);
          if (!p) continue;
          const mat = new THREE.MeshStandardMaterial({
            color: css(`--k-${n.kind || "other"}`, "#888"),
            roughness: 0.5,
            metalness: 0.1,
            emissive: new THREE.Color(0x000000),
          });
          disposables.push(mat);
          const m = new THREE.Mesh(GEO[n.kind] || GEO.external, mat);
          m.scale.setScalar(1.5);
          m.position.copy(p);
          m.userData.node = n;
          sc.add(m);
          meshes.set(n.id, m);
          const el = h("div", { class: "vg-label3d" }, n.label);
          const lab = new CSS2DObject(el);
          lab.position.set(0, -12, 0);
          m.add(lab);
          m.userData.label = el;
        }
        const edgeColor = css("--edge", "#888");
        const linkObjs = [];
        for (const l of topo.links || []) {
          const a = pos.get(l.from);
          const b = pos.get(l.to);
          if (!a || !b) continue;
          const g = new THREE.BufferGeometry().setFromPoints([a, b]);
          const mat =
            l.kind === "async" || l.kind === "data"
              ? new THREE.LineDashedMaterial({
                  color: edgeColor,
                  dashSize: l.kind === "data" ? 2 : 6,
                  gapSize: l.kind === "data" ? 3 : 4,
                  transparent: true,
                  opacity: 0.8,
                })
              : new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.8 });
          const line = new THREE.Line(g, mat);
          if (l.kind === "async" || l.kind === "data") line.computeLineDistances();
          sc.add(line);
          linkObjs.push(line);
          disposables.push(g, mat);
        }
        // pulse and active hop
        const accent = css("--accent", "#06c");
        const pulseMat = new THREE.MeshBasicMaterial({ color: accent });
        const pulse = new THREE.Mesh(new THREE.SphereGeometry(4.5, 20, 14), pulseMat);
        const haloMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.25 });
        const halo = new THREE.Mesh(new THREE.SphereGeometry(8, 20, 14), haloMat);
        pulse.add(halo);
        disposables.push(pulse.geometry, pulseMat, halo.geometry, haloMat);
        sc.add(pulse);
        pulse.visible = false;
        let hopTube = null;
        function showHop() {
          const f = curFlow();
          if (hopTube) {
            sc.remove(hopTube);
            hopTube.geometry.dispose();
            hopTube.material.dispose();
            hopTube = null;
          }
          for (const m of meshes.values()) {
            m.material.emissive.setHex(0x000000);
            m.userData.label.classList.remove("is-hl");
          }
          if (!f || !f.path[state.hop]) {
            pulse.visible = false;
            return;
          }
          const hop = f.path[state.hop];
          const a = pos.get(hop.from);
          const b = pos.get(hop.to);
          if (!a || !b) return;
          const curve = new THREE.LineCurve3(a, b);
          hopTube = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 8, 1.6, 8, false),
            new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.85 }),
          );
          sc.add(hopTube);
          for (const id of [hop.from, hop.to]) {
            const m = meshes.get(id);
            if (m) {
              m.material.emissive.copy(accent).multiplyScalar(0.45);
              m.userData.label.classList.add("is-hl");
            }
          }
          pulse.visible = true;
          pulse.position.lerpVectors(a, b, Math.min(1, state.t));
        }
        function fit() {
          // distance at which the bounding sphere of all layers fits both the vertical and horizontal field of view
          const r = Math.hypot(width / 2 + 40, (layers.length * GAP) / 2 + 20, depthZ / 2);
          const vfov = (camera.fov * Math.PI) / 180;
          const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
          const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 0.74;
          const dir = new THREE.Vector3(0.38, 0.26, 1).normalize();
          camera.position.copy(dir.multiplyScalar(dist));
          camera.near = 1;
          camera.far = dist * 6;
          controls.target.set(0, 0, 0);
          camera.updateProjectionMatrix();
          controls.update();
        }
        function resize() {
          const r = stage.getBoundingClientRect();
          const w = Math.max(200, r.width);
          const hh = Math.max(200, r.height);
          renderer.setSize(w, hh);
          labelRenderer.setSize(w, hh);
          camera.aspect = w / hh;
          camera.updateProjectionMatrix();
        }
        // picking
        const ray = new THREE.Raycaster();
        const v2 = new THREE.Vector2();
        const pick = (ev) => {
          const r = renderer.domElement.getBoundingClientRect();
          v2.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
          ray.setFromCamera(v2, camera);
          const hit = ray.intersectObjects([...meshes.values()], false)[0];
          return hit ? hit.object.userData.node : null;
        };
        let down = null;
        renderer.domElement.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
        renderer.domElement.addEventListener("pointerup", (e) => {
          if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
          const n = pick(e);
          state.node = n ? n.id : null;
          nodeDetail(panel, n, topo);
          syncUrl();
        });
        renderer.domElement.addEventListener("pointermove", (e) => {
          const n = pick(e);
          if (n) {
            const r = stage.getBoundingClientRect();
            tip.textContent = `${n.label} · ${VG.KIND_LABELS[n.kind] || n.kind}`;
            tip.style.left = e.clientX - r.left + "px";
            tip.style.top = e.clientY - r.top + "px";
            tip.classList.add("is-on");
            renderer.domElement.style.cursor = "pointer";
          } else {
            tip.classList.remove("is-on");
            renderer.domElement.style.cursor = "grab";
          }
        });
        const ro = new ResizeObserver(resize);
        ro.observe(stage);
        resize();
        fit();
        showHop();
        const clock = new THREE.Clock();
        let pauseLeft = 0;
        renderer.setAnimationLoop(() => {
          if (document.hidden) return;
          const dt = Math.min(0.1, clock.getDelta()) * 1000;
          const f = curFlow();
          if (state.playing && f && f.path.length) {
            if (pauseLeft > 0) pauseLeft -= dt;
            else {
              state.t += dt / HOP_MS;
              if (state.t >= 1) {
                state.t = 1;
                if (state.hop < f.path.length - 1) {
                  state.hop++;
                  state.t = 0;
                  pauseLeft = PAUSE_MS;
                  setCaption();
                  showHop();
                } else setPlaying(false);
              }
            }
            const hop = f.path[state.hop];
            const a = hop && pos.get(hop.from);
            const b = hop && pos.get(hop.to);
            if (a && b) {
              const e = state.t < 0.5 ? 2 * state.t * state.t : 1 - Math.pow(-2 * state.t + 2, 2) / 2;
              pulse.position.lerpVectors(a, b, e);
            }
          }
          halo.scale.setScalar(1 + 0.25 * Math.sin(performance.now() / 180));
          controls.update();
          renderer.render(sc, camera);
          labelRenderer.render(sc, camera);
        });
        const offTheme = VG.on("theme", () => {
          sc.background = css("--panel", "#fff");
          for (const m of meshes.values())
            m.material.color = css(`--k-${m.userData.node.kind || "other"}`, "#888");
        });
        return {
          showHop,
          resize,
          fit,
          meshes,
          destroy() {
            renderer.setAnimationLoop(null);
            ro.disconnect();
            offTheme();
            controls.dispose();
            if (hopTube) {
              hopTube.geometry.dispose();
              hopTube.material.dispose();
            }
            disposables.forEach((d) => d.dispose());
            renderer.dispose();
            renderer.forceContextLoss();
          },
        };
      }

      resetBtn.addEventListener("click", () => scene && scene.fit());
      return {
        destroy() {
          disposed = true;
          if (scene) scene.destroy();
          scene = null;
          VG.system3d = null;
        },
        update(r) {
          const f = r.params.get("flow");
          if (f && f !== state.flow && flows.some((x) => x.id === f)) {
            state.flow = f;
            flowSel.value = f;
            state.hop = 0;
            state.t = 0;
            setCaption();
            if (scene) scene.showHop();
          }
          const n = r.params.get("node");
          if (n !== state.node) {
            state.node = n;
            nodeDetail(
              panel,
              (topo.nodes || []).find((x) => x.id === n),
              topo,
            );
          }
          return true;
        },
      };
    },
  });
})();
