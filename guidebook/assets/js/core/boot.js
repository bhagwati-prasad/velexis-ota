/* Velexis Guidebook: start-up (waits for the content bundle, checks libraries, builds the shell, starts the router). */
(function () {
  "use strict";
  const VG = window.VG;

  async function boot() {
    const root = document.getElementById("vg-app");
    let ok = false;
    try {
      ok = await (window.VG_CONTENT_READY || Promise.resolve(Boolean(window.VG_CONTENT)));
    } catch {
      ok = false;
    }
    VG.data.init(ok ? window.VG_CONTENT : null);
    VG.layout.init(root);
    root.removeAttribute("aria-busy");

    const missing = [];
    if (!window.d3) missing.push("d3 (diagrams and graphs)");
    if (!window.marked) missing.push("marked (formatting)");
    if (!window.DOMPurify) missing.push("DOMPurify (safe formatting)");
    VG.libs = { d3: Boolean(window.d3), marked: Boolean(window.marked), purify: Boolean(window.DOMPurify) };
    if (missing.length) {
      VG.ui.banner(
        "warn",
        `Some libraries did not load from the CDN: ${missing.join(", ")}. The text is still here; diagrams and formatting are limited. Check the network and reload.`,
        { id: "libs" },
      );
    }
    if (!ok) {
      VG.ui.banner(
        "error",
        `The content bundle (${window.VG_BUNDLE_SRC || "dist/content.js"}) was not found. Build it with: node guidebook/tools/build.mjs`,
        { id: "bundle" },
      );
    }
    VG.ui.initHoverCards();
    VG.router.start();
    document.documentElement.classList.add("vg-ready");
  }

  window.addEventListener("unhandledrejection", (e) => {
    VG.lastError = e.reason;
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
