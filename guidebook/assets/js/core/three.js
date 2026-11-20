/*
 * Velexis Guidebook: lazy loader for three.js (ES modules from the CDN through the import map in index.html).
 * Dynamic import() works from a classic script and from file:// because the CDN sends CORS headers.
 */
(function () {
  "use strict";
  const VG = window.VG;
  let loading = null;

  VG.three = {
    /** True when the browser can create a WebGL context (checked without three.js, so no console error). */
    webglAvailable() {
      try {
        const c = document.createElement("canvas");
        return Boolean(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
      } catch {
        return false;
      }
    },
    /** Resolves { THREE, OrbitControls, CSS2DRenderer, CSS2DObject }; rejects when the CDN is unreachable. */
    load() {
      if (!loading) {
        loading = Promise.all([
          import("three"),
          import("three/addons/controls/OrbitControls.js"),
          import("three/addons/renderers/CSS2DRenderer.js"),
        ])
          .then(([THREE, oc, css2d]) => ({
            THREE,
            OrbitControls: oc.OrbitControls,
            CSS2DRenderer: css2d.CSS2DRenderer,
            CSS2DObject: css2d.CSS2DObject,
          }))
          .catch((err) => {
            loading = null;
            throw err;
          });
      }
      return loading;
    },
    /** Message element shown when 3D is not possible. */
    unavailable(reason) {
      return VG.h(
        "div",
        { class: "vg-empty vg-3d-unavailable", role: "note" },
        VG.h("h2", {}, "3D view unavailable"),
        VG.h("p", {}, reason || "The 3D library could not be loaded (offline?) or WebGL is disabled."),
      );
    },
  };
})();
