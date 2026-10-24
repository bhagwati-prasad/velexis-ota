// Vite 6 multi-page build, dev server and preview of the hosted storefront (OADR-0015, ota/frontend/README.md §11, §12).
// One build serves every OTA: no build-time variables (nothing prefixed VITE_), no per-tenant builds.
//
// The airline-card page (checkout/pay-airline.html) is built on its own (OADR-0017 points 1 and 2): after the build of
// the other pages, a second build writes its single bundle (page code, SDK and the few lib/ helpers it imports) and
// its stylesheet into the same folder, so it shares no chunk with any other page and its HTML references nothing but
// its own files. `vite preview` sends that page the stricter headers of the Caddyfile (OADR-0017 point 3).
import tailwindcss from "@tailwindcss/vite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, defineConfig, loadEnv } from "vite";

import {
  STOREFRONT_HEADERS,
  caddyLikeServer,
  caddyMatchPath,
  envPort,
  htmlInputs,
  includePartials,
  omitPublicDocs,
  storefrontApiProxy,
} from "./scripts/vite-plugins.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(ROOT, "../..");

/** Pages built on their own, by entry name (OADR-0017 point 1). */
export const ISOLATED_PAGES = Object.freeze(["checkout-pay-airline"]);

/** The airline-card page's paths, as the Caddyfile matches them (`try_files` serves the second one too). */
export const PAY_AIRLINE_PATHS = Object.freeze(["/checkout/pay-airline.html", "/checkout/pay-airline"]);

/**
 * The headers of the airline-card page in deploy/caddy/Caddyfile (OADR-0017 point 3), which replace the storefront's
 * CSP there: no Stripe host, COOP `same-origin` (no other page sends it, so a window another page opens on the card
 * page gets no handle on it) and `no-store`. A copy, compared with the Caddyfile by test/pay-airline.test.js.
 */
export const PAY_AIRLINE_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'none'; img-src 'self' data:; " +
    "style-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; " +
    "object-src 'none'; worker-src 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cache-Control": "no-store",
});

/**
 * The build options both builds share: CSP-clean output (OADR-0015 point 2), with no inline module-preload polyfill
 * and no data: URIs for fonts or scripts.
 * @param {string} outDir
 */
const sharedBuild = (outDir) => ({ outDir, modulePreload: { polyfill: false }, assetsInlineLimit: 0 });

/**
 * After the main build has written its files, builds each isolated page alone into the same folder: one input, one
 * bundle (`inlineDynamicImports`), its own stylesheet, and nothing from public/ (the main build copied it).
 * @param {Record<string, string>} pages entry name → HTML file
 * @returns {import("vite").Plugin}
 */
function isolatedPages(pages) {
  /** @type {import("vite").ResolvedConfig | undefined} */
  let resolved;
  return {
    name: "velexis:isolated-pages",
    apply: "build",
    configResolved(config) {
      resolved = config;
    },
    async writeBundle() {
      const config = /** @type {import("vite").ResolvedConfig} */ (resolved);
      for (const [name, file] of Object.entries(pages)) {
        await build({
          configFile: false,
          root: ROOT,
          mode: config.mode,
          logLevel: config.logLevel,
          appType: "mpa",
          publicDir: false,
          plugins: [tailwindcss(), includePartials({ root: ROOT })],
          build: {
            ...sharedBuild(config.build.outDir),
            emptyOutDir: false,
            rollupOptions: { input: { [name]: file }, output: { inlineDynamicImports: true } },
          },
        });
      }
    },
  };
}

/**
 * `vite preview` serves the airline-card page with the Caddyfile's headers for it (the storefront headers, with its
 * own CSP, COOP and Cache-Control). It runs after the Caddy-like routing, which serves `/checkout/pay-airline` as the
 * `.html` file.
 * @returns {import("vite").Plugin}
 */
function payAirlinePreview() {
  return {
    name: "velexis:pay-airline-preview",
    configurePreviewServer(server) {
      const file = join(
        resolve(server.config.root, server.config.build.outDir),
        "checkout",
        "pay-airline.html",
      );
      server.middlewares.use((req, res, next) => {
        let path = "";
        try {
          path = caddyMatchPath(decodeURIComponent((req.url ?? "/").split(/[?#]/)[0] ?? "/"));
        } catch {
          // A malformed escape: the Caddy-like routing answered it already.
        }
        if (
          !PAY_AIRLINE_PATHS.includes(path) ||
          (req.method !== "GET" && req.method !== "HEAD") ||
          !existsSync(file)
        ) {
          next();
          return;
        }
        res.statusCode = 200;
        for (const [name, value] of Object.entries({ ...STOREFRONT_HEADERS, ...PAY_AIRLINE_HEADERS })) {
          res.setHeader(name, value);
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(req.method === "HEAD" ? undefined : readFileSync(file));
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // Development only: the root .env.local, then ota/frontend/.env.local; the real environment wins over both.
  // The values configure the proxy below and never reach the browser bundle.
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...loadEnv(mode, ROOT, "") };
  const proxy = command === "serve" ? { "^/api/": storefrontApiProxy(env) } : undefined;
  const pages = htmlInputs(ROOT);
  const isolated = Object.fromEntries(
    Object.entries(pages).filter(([name]) => ISOLATED_PAGES.includes(name)),
  );
  const shared = Object.fromEntries(Object.entries(pages).filter(([name]) => !ISOLATED_PAGES.includes(name)));

  return {
    root: ROOT,
    appType: "mpa",
    plugins: [
      tailwindcss(),
      includePartials({ root: ROOT }),
      caddyLikeServer(),
      omitPublicDocs(),
      isolatedPages(isolated),
      payAirlinePreview(),
    ],
    build: {
      ...sharedBuild("dist"),
      emptyOutDir: true,
      rollupOptions: { input: shared },
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
