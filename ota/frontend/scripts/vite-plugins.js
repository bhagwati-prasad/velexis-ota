// Local Vite plugins and helpers of the storefront (OADR-0015 points 1, 4, 6, 10, 11; ota/frontend/README.md §5.2, §11).
//
// - htmlInputs: every HTML page of the package is a build input, so a new page joins the build by existing.
// - includePartials: `<!-- @include partials/… -->` in transformIndexHtml (shared markup at build time).
// - caddyLikeServer: the dev and preview servers answer like the Caddyfile storefront block: `/p/<slug>` is served
//   by `p.html`, `try_files {path} {path}.html {path}/index.html`, unknown paths get `404.html` with status 404, and
//   `/api/internal/*` and `/api/health/*` other than `/api/health/live` are 404.
// - storefrontApiProxy: `/api/*` to OTA_API_URL with `/api` stripped and the edge headers Caddy adds; 503 with the
//   SERVICE_UNAVAILABLE envelope while the OTA API is down.
// - STOREFRONT_HEADERS: the production response headers that `vite preview` sends, copied from deploy/caddy/Caddyfile.
// - envPort: the dev server and preview ports (STOREFRONT_DEV_PORT 5173, STOREFRONT_PREVIEW_PORT 4173).
// - omitPublicDocs: keeps Markdown notes of public/ (public/fonts/README.md) out of dist/.
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

/**
 * Response headers of the `(storefront)` snippet in deploy/caddy/Caddyfile that `vite preview` sends, so E2E runs
 * see production headers (OADR-0015 point 11). A copy, not a live read: test/csp.test.js fails when the Caddyfile
 * changes and this copy does not. Strict-Transport-Security is left out because the preview is plain HTTP. The
 * airline-card page has headers of its own (PAY_AIRLINE_HEADERS of vite.config.js, OADR-0017 point 3).
 */
export const STOREFRONT_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://js.stripe.com https://*.js.stripe.com; style-src 'self'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.stripe.com; " +
    "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; frame-ancestors 'none'; " +
    "base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'none'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});

/** Folders that never hold pages: partials are fragments, public/ is copied as is, the rest is not served. */
const NOT_PAGES = new Set([
  "node_modules",
  "dist",
  "partials",
  "public",
  "src",
  "test",
  "scripts",
  "docs",
  "coverage",
]);

/**
 * Every `*.html` page under `root` as a Rollup input map. The key is the page path without `.html`, with `-` for
 * `/` (`index`, `account-index`, `checkout-pay-card`), like the entry modules in src/pages/; it names the page's
 * bundle (`assets/checkout-pay-card-<hash>.js`).
 * @param {string} root the storefront folder (ota/frontend)
 * @returns {Record<string, string>}
 */
export function htmlInputs(root) {
  /** @type {Record<string, string>} */
  const inputs = {};
  const walk = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      const top = dir === root;
      if (entry.isDirectory() && !entry.name.startsWith(".") && !(top && NOT_PAGES.has(entry.name))) {
        walk(file);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        const name = relative(root, file).split(sep).join("-").slice(0, -".html".length);
        if (inputs[name]) {
          throw new Error(`${inputs[name]} and ${file} would share the entry name "${name}"; rename one`);
        }
        inputs[name] = file;
      }
    }
  };
  walk(root);
  return inputs;
}

const INCLUDE = /<!--\s*@include\s+(\S+?)\s*-->/g;

/**
 * Replaces `<!-- @include partials/header.html -->` with that file (paths from the storefront folder, nested
 * includes allowed). A missing partial, or a path outside partials/, fails the build.
 * @param {{ root: string, dir?: string, maxDepth?: number }} options
 * @returns {import("vite").Plugin}
 */
export function includePartials({ root, dir = "partials", maxDepth = 5 }) {
  const base = resolve(root, dir) + sep;
  const expand = (/** @type {string} */ html, /** @type {string} */ from, depth = 0) =>
    html.replace(INCLUDE, (_match, /** @type {string} */ ref) => {
      const file = resolve(root, ref);
      if (!file.startsWith(base) || depth >= maxDepth) {
        throw new Error(
          `${from}: @include ${ref} must name a file in ${dir}/ (at most ${maxDepth} levels deep)`,
        );
      }
      if (!existsSync(file)) {
        throw new Error(`${from}: @include ${ref} does not exist`);
      }
      return expand(readFileSync(file, "utf8"), ref, depth + 1);
    });
  return {
    name: "velexis:include-partials",
    transformIndexHtml: { order: "pre", handler: (html, ctx) => expand(html, ctx.path) },
    handleHotUpdate({ file, server }) {
      if (resolve(file).startsWith(base)) {
        server.ws.send({ type: "full-reload" });
        return [];
      }
      return undefined;
    },
  };
}

/** Caddy's file matcher: a path ending in `/` must be a directory, any other path a file. */
const strictExists = (/** @type {string} */ path, /** @type {boolean} */ dir) => {
  try {
    return dir ? statSync(path).isDirectory() : statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Resolves a request path like the Caddyfile storefront block: `rewrite /p/* /p.html` (OADR-0015 point 4; Caddy
 * matches paths case-insensitively), then `try_files {path} {path}.html {path}/index.html` over `roots`, where a
 * path ending in `/` is a directory served by its `index.html`.
 * @param {string} pathname decoded URL path, starting with `/`
 * @param {string[]} roots folders the server serves at `/`
 * @returns {string | null} the path to serve, or null for a 404
 */
export function resolveStorefrontPath(pathname, roots) {
  const path = /^\/p\//i.test(pathname) ? "/p.html" : pathname;
  const candidates = path.endsWith("/")
    ? [`${path}index.html`]
    : [path, `${path}.html`, `${path}/index.html`];
  for (const candidate of candidates) {
    for (const root of roots) {
      const file = resolve(root, `.${candidate}`);
      const inside = file === root || file.startsWith(root + sep);
      if (inside && strictExists(file, false)) {
        return candidate;
      }
    }
  }
  return null;
}

// `@api_private` of the Caddyfile storefront block (`path /api/internal/* /api/health/*`, `not path
// /api/health/live`), tested on `caddyMatchPath(pathname)`. Caddy keeps a trailing slash, so `/api/health/live/` is
// blocked too.
const BLOCKED_API = /^\/api\/(?:internal|health)\//;
const PUBLIC_HEALTH = "/api/health/live";
const VITE_INTERNAL = /^\/(?:@|__|node_modules\/)/;

/**
 * A decoded request path as Caddy's `path` matcher compares it: lower-cased, `.` and `..` segments resolved and
 * repeated slashes merged, a trailing slash kept. Without this, `/api//internal/x` (which the proxy forwards as
 * `/internal/x`) or `/api/%69nternal/x` would pass the block below and reach the API, where Caddy matches them.
 * @param {string} pathname decoded URL path, starting with `/`
 */
export const caddyMatchPath = (pathname) => posix.normalize(pathname).toLowerCase();

/**
 * Middleware with Caddy's storefront routing for the dev server (HTML navigations only, because Vite serves its
 * modules from virtual paths) and for `vite preview` (every GET and HEAD, like Caddy over dist/).
 * @param {{ roots: () => string[], htmlOnly: boolean, notFound: (req: import("node:http").IncomingMessage) => Promise<string>, headers: () => Record<string, string> | undefined }} options
 * @returns {import("vite").Connect.NextHandleFunction}
 */
function caddyRoutes({ roots, htmlOnly, notFound, headers }) {
  return (req, res, next) => {
    const url = req.url ?? "/";
    const cut = url.search(/[?#]/);
    const rawPath = cut === -1 ? url : url.slice(0, cut);
    const query = cut === -1 ? "" : url.slice(cut);
    let pathname;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      // Caddy (Go's URL parser) refuses a malformed escape with 400; Vite would answer 500 with a stack trace.
      res.statusCode = 400;
      res.end();
      return;
    }
    const matchPath = caddyMatchPath(pathname);
    if (BLOCKED_API.test(matchPath) && matchPath !== PUBLIC_HEALTH) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const navigation = (req.headers.accept ?? "").includes("text/html");
    if (
      (req.method !== "GET" && req.method !== "HEAD") ||
      url.startsWith("/api/") ||
      VITE_INTERNAL.test(url) ||
      (htmlOnly && !navigation)
    ) {
      next();
      return;
    }
    const target = resolveStorefrontPath(pathname, roots());
    if (target !== null) {
      req.url = target === pathname ? url : encodeURI(target) + query;
      next();
      return;
    }
    notFound(req).then((html) => {
      res.statusCode = 404;
      for (const [name, value] of Object.entries(headers() ?? {})) {
        res.setHeader(name, value);
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end(req.method === "HEAD" ? undefined : html);
    }, next);
  };
}

/**
 * The dev and preview servers behave like Caddy for one tenant (OADR-0015 points 4 and 10).
 * @returns {import("vite").Plugin}
 */
export function caddyLikeServer() {
  return {
    name: "velexis:caddy-like-server",
    configureServer(server) {
      const { root, publicDir } = server.config;
      server.middlewares.use(
        caddyRoutes({
          roots: () => [root, publicDir].filter(Boolean),
          htmlOnly: true,
          headers: () => server.config.server.headers,
          notFound: (req) =>
            server.transformIndexHtml(
              "/404.html",
              readFileSync(join(root, "404.html"), "utf8"),
              req.originalUrl,
            ),
        }),
      );
    },
    configurePreviewServer(server) {
      const dist = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use(
        caddyRoutes({
          roots: () => [dist],
          htmlOnly: false,
          headers: () => server.config.preview.headers,
          notFound: async () => readFileSync(join(dist, "404.html"), "utf8"),
        }),
      );
    },
  };
}

const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Proxy options for `/api/*`, like the storefront `handle /api/*` block of the Caddyfile: `/api` stripped, and
 * `X-Velexis-Edge` (development secret), `X-Velexis-Host` and `Origin: https://<host>` set, replacing any value the
 * browser sent. The host is STOREFRONT_DEV_HOST, default `demo.<STOREFRONT_BASE_DOMAIN>`.
 * @param {Record<string, string | undefined>} env root .env.local, then ota/frontend/.env.local, then the environment
 * @returns {import("vite").ProxyOptions}
 */
export function storefrontApiProxy(env) {
  const host = (
    env.STOREFRONT_DEV_HOST ||
    (env.STOREFRONT_BASE_DOMAIN && `demo.${env.STOREFRONT_BASE_DOMAIN}`) ||
    ""
  )
    .trim()
    .toLowerCase();
  const problems = [];
  let target = "";
  try {
    const url = new URL(env.OTA_API_URL ?? "");
    target = /^https?:$/.test(url.protocol) ? url.href.replace(/\/$/, "") : "";
  } catch {
    target = "";
  }
  if (!target) {
    problems.push("OTA_API_URL (an http or https URL)");
  }
  if (!env.VELEXIS_EDGE_SECRET) {
    problems.push("VELEXIS_EDGE_SECRET");
  }
  if (!HOST_NAME.test(host)) {
    problems.push("STOREFRONT_DEV_HOST or STOREFRONT_BASE_DOMAIN (a host name such as demo.ota.example.com)");
  }
  if (problems.length > 0) {
    throw new Error(
      `ota/frontend dev proxy: missing or invalid ${problems.join(", ")}. ` +
        "Copy the root .env.example to .env.local (docs/mvp/local-development.md); see ota/frontend/.env.example.",
    );
  }
  return {
    target,
    changeOrigin: false,
    rewrite: (path) => path.replace(/^\/api(?=\/)/, ""),
    // Lower-case names replace the browser's own copies (Node lower-cases incoming header names).
    headers: {
      "x-velexis-edge": String(env.VELEXIS_EDGE_SECRET),
      "x-velexis-host": host,
      origin: `https://${host}`,
    },
    // While the OTA API is down, answer like the `api_unavailable` snippet of the Caddyfile. Registered before
    // Vite's own handler, which then only logs the error. The API's helmet adds `Cross-Origin-Opener-Policy:
    // same-origin` to every answer; like the Caddyfile's storefront headers, the proxy drops it, so only the
    // airline-card page sends COOP `same-origin` on the storefront origin (OADR-0017 point 3).
    configure: (proxy) => {
      proxy.on("proxyRes", (proxyRes) => {
        delete proxyRes.headers["cross-origin-opener-policy"];
      });
      proxy.on("error", (_err, req, res) => {
        if ("writeHead" in res && !res.headersSent && !res.writableEnded) {
          res.writeHead(503, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Retry-After": "30",
          });
          res.end(apiUnavailableBody(req.headers["x-request-id"]));
        }
      });
    },
  };
}

/** The `SERVICE_UNAVAILABLE` error envelope of the Caddyfile, with the request id Caddy would have kept or set. */
export function apiUnavailableBody(/** @type {string | string[] | undefined} */ requestId) {
  const id =
    typeof requestId === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(requestId) ? requestId : randomUUID();
  return JSON.stringify({
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "The service is temporarily unavailable. Retry shortly.",
      status: 503,
      requestId: id,
    },
  });
}

/**
 * A TCP port from the development environment (STOREFRONT_DEV_PORT, STOREFRONT_PREVIEW_PORT), or the default.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} fallback
 */
export function envPort(env, name, fallback) {
  const value = env[name]?.trim();
  if (!value) {
    return fallback;
  }
  const port = /^\d{1,5}$/.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) {
    throw new Error(`ota/frontend: ${name} must be a port number from 1 to 65535`);
  }
  return port;
}

/**
 * Removes Markdown notes copied from public/ (public/fonts/README.md) from the build output, so dist/ holds only
 * what Caddy should serve.
 * @returns {import("vite").Plugin}
 */
export function omitPublicDocs() {
  let publicDir = "";
  return {
    name: "velexis:omit-public-docs",
    apply: "build",
    configResolved(config) {
      ({ publicDir } = config);
    },
    writeBundle(options) {
      const out = options.dir;
      if (!publicDir || !out || !existsSync(publicDir)) {
        return;
      }
      const docs = readdirSync(publicDir, { recursive: true, encoding: "utf8" }).filter((f) =>
        f.endsWith(".md"),
      );
      for (const file of docs) {
        rmSync(join(out, file), { force: true });
        // Drop folders that held only the note (public/fonts/ before any font is bundled).
        for (let dir = dirname(join(out, file)); dir.startsWith(out + sep); dir = dirname(dir)) {
          if (readdirSync(dir).length > 0) {
            break;
          }
          rmdirSync(dir);
        }
      }
    },
  };
}
