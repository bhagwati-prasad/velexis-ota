// Vite 6 multi-page build, dev server and preview of the hosted storefront (OADR-0015, ota/frontend/README.md §11, §12).
// One build serves every OTA: no build-time variables (nothing prefixed VITE_), no per-tenant builds.
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

import {
  STOREFRONT_HEADERS,
  caddyLikeServer,
  envPort,
  htmlInputs,
  includePartials,
  omitPublicDocs,
  storefrontApiProxy,
} from "./scripts/vite-plugins.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(ROOT, "../..");

export default defineConfig(({ command, mode }) => {
  // Development only: the root .env.local, then ota/frontend/.env.local; the real environment wins over both.
  // The values configure the proxy below and never reach the browser bundle.
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...loadEnv(mode, ROOT, "") };
  const proxy = command === "serve" ? { "^/api/": storefrontApiProxy(env) } : undefined;

  return {
    root: ROOT,
    appType: "mpa",
    plugins: [tailwindcss(), includePartials({ root: ROOT }), caddyLikeServer(), omitPublicDocs()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      // CSP-clean output (OADR-0015 point 2): no inline module-preload polyfill, no data: URIs for fonts or scripts.
      modulePreload: { polyfill: false },
      assetsInlineLimit: 0,
      rollupOptions: { input: htmlInputs(ROOT) },
    },
    server: { port: envPort(env, "STOREFRONT_DEV_PORT", 5173), strictPort: true, proxy },
    // `vite preview` serves dist/ with the production headers of the Caddyfile (OADR-0015 point 11).
    preview: {
      port: envPort(env, "STOREFRONT_PREVIEW_PORT", 4173),
      strictPort: true,
      proxy,
      headers: { ...STOREFRONT_HEADERS },
    },
  };
});
