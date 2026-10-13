// @vitest-environment node
// The local Vite plugins (scripts/vite-plugins.js): page inputs, partials, and the dev and preview servers that
// behave like the Caddyfile storefront block for one tenant (OADR-0015 points 1, 4, 6 and 10).
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer, preview } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  caddyMatchPath,
  envPort,
  htmlInputs,
  includePartials,
  resolveStorefrontPath,
  storefrontApiProxy,
} from "../scripts/vite-plugins.js";
import {
  NAVIGATION,
  STOREFRONT_ROOT,
  VITE_CONFIG,
  baseUrl,
  buildStorefront,
  httpRequest,
  removeScratch,
  scratchDir,
} from "./helpers/storefront.js";

/** @type {string[]} */
const scratch = [];
afterEach(() => {
  scratch.splice(0).forEach(removeScratch);
});

/** Writes files into a new scratch folder and returns it. */
function tree(/** @type {Record<string, string>} */ files) {
  const dir = scratchDir("plugins");
  scratch.push(dir);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

const ENV = {
  OTA_API_URL: "http://127.0.0.1:4000",
  VELEXIS_EDGE_SECRET: "test-edge-secret",
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
};

describe("htmlInputs", () => {
  it("[OFE-001 AC1] makes every page an input, nested pages included, and skips partials and public files", () => {
    const root = tree({
      "index.html": "",
      "404.html": "",
      "checkout/pay-card.html": "",
      "account/index.html": "",
      "partials/header.html": "",
      "public/fonts/README.md": "",
      "public/static.html": "",
      "test/fixture.html": "",
      "node_modules/pkg/index.html": "",
      "dist/index.html": "",
    });

    expect(htmlInputs(root)).toEqual({
      404: join(root, "404.html"),
      "account-index": join(root, "account/index.html"),
      "checkout-pay-card": join(root, "checkout/pay-card.html"),
      index: join(root, "index.html"),
    });
  });

  it("[OFE-001 AC1] refuses two pages that would share an entry name", () => {
    const root = tree({ "account/index.html": "", "account-index.html": "" });

    expect(() => htmlInputs(root)).toThrow(/would share the entry name "account-index"/);
  });

  it("[OFE-001 AC1] lists the storefront's own pages", () => {
    expect(Object.keys(htmlInputs(STOREFRONT_ROOT))).toEqual(expect.arrayContaining(["index", "404"]));
  });
});

describe("includePartials", () => {
  const transform = (/** @type {string} */ root, /** @type {string} */ html) => {
    const hook = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
      includePartials({ root }).transformIndexHtml
    );
    return hook.handler(html, { path: "/index.html" });
  };

  it("[OFE-001 AC1] replaces include comments with the partial, nested includes included", () => {
    const root = tree({
      "partials/header.html": "<header><!-- @include partials/templates/brand.html --></header>",
      "partials/templates/brand.html": '<a href="/">Brand</a>',
    });

    expect(transform(root, "<body><!-- @include partials/header.html --><main></main></body>")).toBe(
      '<body><header><a href="/">Brand</a></header><main></main></body>',
    );
  });

  it("[OFE-001 AC1] fails the build on a missing partial or a path outside partials/", () => {
    const root = tree({ "partials/header.html": "", "secret.html": "x" });

    expect(() => transform(root, "<!-- @include partials/nope.html -->")).toThrow(
      /partials\/nope\.html does not exist/,
    );
    expect(() => transform(root, "<!-- @include secret.html -->")).toThrow(/must name a file in partials\//);
    expect(() => transform(root, "<!-- @include partials/../secret.html -->")).toThrow(/must name a file/);
  });

  it("[OFE-001 AC1] stops an include cycle", () => {
    const root = tree({ "partials/a.html": "<!-- @include partials/a.html -->" });

    expect(() => transform(root, "<!-- @include partials/a.html -->")).toThrow(/at most 5 levels deep/);
  });
});

describe("resolveStorefrontPath (Caddy try_files and the /p/ rewrite)", () => {
  it("[OFE-001 AC1] serves files, then {path}.html, then {path}/index.html, else 404", () => {
    const root = tree({
      "index.html": "",
      "search.html": "",
      "account/index.html": "",
      "assets/index-abcdefgh.js": "",
      "empty/.keep": "",
    });

    expect(resolveStorefrontPath("/", [root])).toBe("/index.html");
    expect(resolveStorefrontPath("/search.html", [root])).toBe("/search.html");
    expect(resolveStorefrontPath("/search", [root])).toBe("/search.html");
    expect(resolveStorefrontPath("/account", [root])).toBe("/account/index.html");
    expect(resolveStorefrontPath("/account/", [root])).toBe("/account/index.html");
    expect(resolveStorefrontPath("/assets/index-abcdefgh.js", [root])).toBe("/assets/index-abcdefgh.js");
    expect(resolveStorefrontPath("/nope", [root])).toBeNull();
    expect(resolveStorefrontPath("/empty", [root])).toBeNull();
    expect(resolveStorefrontPath("/empty/", [root])).toBeNull();
    expect(resolveStorefrontPath("/../package.json", [join(root, "account")])).toBeNull();
  });

  it("[OFE-001 AC1] serves /p/<slug> with p.html once it exists", () => {
    const withPage = tree({ "p.html": "" });
    const withoutPage = tree({ "index.html": "" });

    expect(resolveStorefrontPath("/p/about", [withPage])).toBe("/p.html");
    expect(resolveStorefrontPath("/p/terms/", [withPage])).toBe("/p.html");
    expect(resolveStorefrontPath("/P/About", [withPage])).toBe("/p.html");
    expect(resolveStorefrontPath("/p/about", [withoutPage])).toBeNull();
  });

  it("[OFE-001 AC1] compares paths like Caddy's path matcher: lower case, cleaned, slashes merged", () => {
    expect(caddyMatchPath("/API//Internal/./tls/../ask")).toBe("/api/internal/ask");
    expect(caddyMatchPath("/api/health/ready/")).toBe("/api/health/ready/");
    expect(caddyMatchPath("/../p/about")).toBe("/p/about");
  });

  it("[OFE-001 AC1] looks in every root, like the dev server's root and public folders", () => {
    const pages = tree({ "index.html": "" });
    const publicDir = tree({ "favicon.ico": "" });

    expect(resolveStorefrontPath("/favicon.ico", [pages, publicDir])).toBe("/favicon.ico");
  });
});

describe("storefrontApiProxy", () => {
  it("[OFE-001 AC1] strips /api and sets the edge headers for demo.<STOREFRONT_BASE_DOMAIN>", () => {
    const proxy = storefrontApiProxy(ENV);

    expect(proxy.target).toBe("http://127.0.0.1:4000");
    expect(proxy.changeOrigin).toBe(false);
    expect(proxy.rewrite?.("/api/v1/storefront?locale=en")).toBe("/v1/storefront?locale=en");
    expect(proxy.headers).toEqual({
      "x-velexis-edge": "test-edge-secret",
      "x-velexis-host": "demo.ota.example.com",
      origin: "https://demo.ota.example.com",
    });
  });

  it("[OFE-001 AC1] uses STOREFRONT_DEV_HOST for another seeded tenant", () => {
    const proxy = storefrontApiProxy({ ...ENV, STOREFRONT_DEV_HOST: "Beta.OTA.example.com" });

    expect(proxy.headers).toMatchObject({
      "x-velexis-host": "beta.ota.example.com",
      origin: "https://beta.ota.example.com",
    });
  });

  it("[OFE-001 AC1] refuses to start without its variables and names each one", () => {
    expect(() => storefrontApiProxy({})).toThrow(
      /OTA_API_URL .*VELEXIS_EDGE_SECRET.*STOREFRONT_DEV_HOST or STOREFRONT_BASE_DOMAIN/,
    );
    expect(() => storefrontApiProxy({ ...ENV, OTA_API_URL: "ftp://127.0.0.1" })).toThrow(/OTA_API_URL/);
    expect(() =>
      storefrontApiProxy({ ...ENV, STOREFRONT_DEV_HOST: "demo.example.net\r\nX-Evil: 1" }),
    ).toThrow(/STOREFRONT_DEV_HOST/);
  });

  it("[OFE-001 AC1] never prints the edge secret in its error", () => {
    expect(() => storefrontApiProxy({ ...ENV, OTA_API_URL: "" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("test-edge-secret") }),
    );
  });
});

describe("envPort", () => {
  it("[OFE-001 AC1] serves on 5173 and previews on 4173 unless the development environment says otherwise", () => {
    expect(envPort({}, "STOREFRONT_PREVIEW_PORT", 4173)).toBe(4173);
    expect(envPort({ STOREFRONT_PREVIEW_PORT: " 4300 " }, "STOREFRONT_PREVIEW_PORT", 4173)).toBe(4300);
    for (const bad of ["0", "65536", "41.5", "abc", "-1"]) {
      expect(() => envPort({ STOREFRONT_DEV_PORT: bad }, "STOREFRONT_DEV_PORT", 5173), bad).toThrow(
        /STOREFRONT_DEV_PORT must be a port number/,
      );
    }
  });
});

describe("the dev and preview servers behave like Caddy for one tenant", () => {
  /** @type {Array<{ url: string, headers: import("node:http").IncomingHttpHeaders }>} */
  const upstreamRequests = [];
  const upstream = createHttpServer((req, res) => {
    upstreamRequests.push({ url: req.url ?? "", headers: req.headers });
    if (req.url?.startsWith("/v1/unreachable")) {
      req.socket.destroy(); // the OTA API dies mid-request
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
  });
  /** @type {string | undefined} */
  let dist;
  /** @type {import("vite").PreviewServer | undefined} */
  let previewServer;
  /** @type {import("vite").ViteDevServer | undefined} */
  let devServer;

  beforeAll(async () => {
    await new Promise((resolve) => {
      upstream.listen(0, "127.0.0.1", () => resolve(undefined));
    });
    const address = upstream.address();
    const port = address && typeof address === "object" ? address.port : 0;
    vi.stubEnv("OTA_API_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("VELEXIS_EDGE_SECRET", "test-edge-secret");
    vi.stubEnv("STOREFRONT_DEV_HOST", "demo.ota.example.com");

    dist = scratchDir("preview");
    await buildStorefront(dist);
    previewServer = await preview({
      configFile: VITE_CONFIG,
      logLevel: "silent",
      build: { outDir: dist },
      preview: { host: "127.0.0.1", port: 0, open: false },
    });
    devServer = await createServer({
      configFile: VITE_CONFIG,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, open: false, hmr: false, watch: null },
    });
    await devServer.listen();
  });

  afterAll(async () => {
    await previewServer?.close();
    await devServer?.close();
    await new Promise((resolve) => {
      upstream.close(() => resolve(undefined));
    });
    removeScratch(dist);
  });

  const servers = () => [
    ["preview", baseUrl(/** @type {import("vite").PreviewServer} */ (previewServer))],
    ["dev", baseUrl(/** @type {import("vite").ViteDevServer} */ (devServer))],
  ];

  it("[OFE-001 AC1] proxies /api/* without /api, replacing the edge headers a browser sends", async () => {
    for (const [name, url] of servers()) {
      upstreamRequests.splice(0);
      const res = await httpRequest(`${url}/api/v1/storefront?locale=en`, {
        headers: {
          "X-Velexis-Edge": "forged",
          "X-Velexis-Host": "evil.example.net",
          Origin: "https://evil.example.net",
        },
      });

      expect(res.status, name).toBe(200);
      expect(res.body, name).toBe('{"ok":true}');
      expect(
        upstreamRequests.map((r) => r.url),
        name,
      ).toEqual(["/v1/storefront?locale=en"]);
      expect(upstreamRequests[0]?.headers, name).toMatchObject({
        "x-velexis-edge": "test-edge-secret",
        "x-velexis-host": "demo.ota.example.com",
        origin: "https://demo.ota.example.com",
      });
    }
  });

  it("[OFE-001 AC1] answers 503 SERVICE_UNAVAILABLE like Caddy while the OTA API is down", async () => {
    for (const [name, url] of servers()) {
      const kept = await httpRequest(`${url}/api/v1/unreachable`, {
        headers: { "X-Request-Id": "req_test_0001" },
      });
      expect(kept.status, name).toBe(503);
      expect(kept.headers["retry-after"], name).toBe("30");
      expect(JSON.parse(kept.body), name).toEqual({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The service is temporarily unavailable. Retry shortly.",
          status: 503,
          requestId: "req_test_0001",
        },
      });

      const fresh = await httpRequest(`${url}/api/v1/unreachable`, { headers: { "X-Request-Id": "<bad>" } });
      expect(fresh.status, name).toBe(503);
      expect(JSON.parse(fresh.body).error.requestId, name).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("[OFE-001 AC1] answers 404 for /api/internal/* and /api/health/ready without calling the API", async () => {
    // Caddy matches the decoded, cleaned path with repeated slashes merged; so must the dev and preview servers.
    const blocked = [
      "/api/internal/tls/ask?domain=x",
      "/api/health/ready",
      "/api/Health/Ready",
      "/api/health/ready/",
      "/api//internal/tls/ask",
      "/api/%69nternal/tls/ask",
      "/api/internal%2Ftls/ask",
      "/api/health//ready",
    ];
    for (const [name, url] of servers()) {
      upstreamRequests.splice(0);
      for (const path of blocked) {
        expect((await httpRequest(`${url}${path}`)).status, `${name} ${path}`).toBe(404);
      }
      expect(upstreamRequests, name).toEqual([]);
    }
  });

  it("[OFE-001 AC1] answers 400 to a malformed escape, like Caddy, instead of a server error", async () => {
    for (const [name, url] of servers()) {
      upstreamRequests.splice(0);
      for (const path of ["/%E0%A4%A", "/api/v1/%zz"]) {
        const res = await httpRequest(`${url}${path}`, { headers: NAVIGATION });
        expect(res.status, `${name} ${path}`).toBe(400);
        expect(res.body, `${name} ${path}`).toBe("");
      }
      expect(upstreamRequests, name).toEqual([]);
    }
  });

  it("[OFE-001 AC1] serves pages by path and unknown paths and /p/<slug> (until p.html exists) with 404.html", async () => {
    for (const [name, url] of servers()) {
      const home = await httpRequest(`${url}/`, { headers: NAVIGATION });
      expect(home.status, name).toBe(200);
      expect(home.body, name).toContain("Search flights");
      expect(home.body, name).toContain("<header");

      const byName = await httpRequest(`${url}/index`, { headers: NAVIGATION });
      expect(byName.status, name).toBe(200);
      expect(byName.body, name).toContain("Search flights");

      for (const path of ["/no-such-page", "/deep/no/such/page.html", "/p/about"]) {
        const res = await httpRequest(`${url}${path}`, { headers: NAVIGATION });
        expect(res.status, `${name} ${path}`).toBe(404);
        expect(res.body, `${name} ${path}`).toContain("Page not found");
        expect(res.body, `${name} ${path}`).toContain("<footer");
      }
    }
  });
});
