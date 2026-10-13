// @vitest-environment node
// The storefront's production headers in development: `vite preview` sends the CSP (and the other response
// headers) of the Caddyfile storefront block, and the build is CSP-clean (OADR-0015 points 2 and 11).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFromFile, preview } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { STOREFRONT_HEADERS } from "../scripts/vite-plugins.js";
import {
  NAVIGATION,
  REPO_ROOT,
  VITE_CONFIG,
  baseUrl,
  buildStorefront,
  filesIn,
  httpRequest,
  removeScratch,
  scratchDir,
} from "./helpers/storefront.js";

const CADDYFILE = join(REPO_ROOT, "deploy", "caddy", "Caddyfile");

/** The text of the `{ … }` block that starts at the first `{` at or after `from`. */
function blockAt(/** @type {string} */ text, /** @type {number} */ from, /** @type {string} */ what) {
  const open = text.indexOf("{", from);
  let depth = 0;
  for (let i = open; open >= 0 && i < text.length; i += 1) {
    depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
    if (depth === 0) {
      return text.slice(open + 1, i);
    }
  }
  throw new Error(`Caddyfile: no complete ${what} block`);
}

/** The body of the snippet `(<name>) { … }` of a Caddyfile, or undefined when there is none. */
function snippetBody(/** @type {string} */ caddyfile, /** @type {string} */ name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = caddyfile.search(new RegExp(`^\\(${escaped}\\)\\s*\\{`, "m"));
  return start < 0 ? undefined : blockAt(caddyfile, start, `(${name})`);
}

/**
 * The response headers that the `(storefront)` snippet of a Caddyfile sets in its unconditional `header { … }`
 * block (deletions such as `-Server` left out). The block is either in `(storefront)` itself or in a snippet that
 * `(storefront)` imports at its top level (X-022 moved it to `(storefront_headers)`, which the storefront 404 page
 * imports too). Throws when the snippet, the block or the CSP is missing, so the comparison never passes by reading
 * nothing.
 * @param {string} caddyfile
 * @returns {Record<string, string>}
 */
function caddyStorefrontHeaders(caddyfile) {
  const storefront = snippetBody(caddyfile, "storefront");
  if (storefront === undefined) {
    throw new Error("Caddyfile: no (storefront) snippet");
  }
  const imported = [...storefront.matchAll(/^\t?import\s+(\S+)\s*$/gm)].map((m) => m[1] ?? "");
  const body = [storefront, ...imported.map((name) => snippetBody(caddyfile, name) ?? "")].find(
    (text) => text.search(/^\s*header\s*\{/m) >= 0,
  );
  if (body === undefined) {
    throw new Error("Caddyfile: no header { … } block in (storefront) or a snippet it imports");
  }
  const header = body.search(/^\s*header\s*\{/m);
  /** @type {Record<string, string>} */
  const headers = {};
  for (const raw of blockAt(body, header, "header").split("\n")) {
    const line = raw.trim();
    const m = line.match(/^([A-Za-z0-9-]+)\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))$/);
    if (m) {
      headers[m[1] ?? ""] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
    } else if (line !== "" && !line.startsWith("-") && !line.startsWith("#")) {
      throw new Error(`Caddyfile: cannot read the storefront header line ${JSON.stringify(line)}`);
    }
  }
  if (!headers["Content-Security-Policy"]) {
    throw new Error("Caddyfile: the storefront header block has no Content-Security-Policy");
  }
  return headers;
}

/**
 * Differences between the headers `vite preview` sends and the storefront headers of a Caddyfile, one line each.
 * Strict-Transport-Security is not mirrored: the preview is plain HTTP.
 * @param {string} caddyfile
 * @param {Record<string, string>} previewHeaders
 */
function headerDifferences(caddyfile, previewHeaders) {
  const caddy = caddyStorefrontHeaders(caddyfile);
  delete caddy["Strict-Transport-Security"];
  const names = new Set([...Object.keys(caddy), ...Object.keys(previewHeaders)]);
  return [...names]
    .filter((name) => caddy[name] !== previewHeaders[name])
    .map(
      (name) =>
        `${name}: Caddyfile ${JSON.stringify(caddy[name])}, preview ${JSON.stringify(previewHeaders[name])}`,
    );
}

describe("preview CSP and the Caddyfile", () => {
  const caddyfile = readFileSync(CADDYFILE, "utf8");

  it("[OFE-001 AC2] the preview CSP equals the storefront CSP of deploy/caddy/Caddyfile", async () => {
    const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, VITE_CONFIG);
    const previewHeaders = /** @type {Record<string, string>} */ (loaded?.config.preview?.headers ?? {});

    expect(previewHeaders["Content-Security-Policy"]).toBe(
      caddyStorefrontHeaders(caddyfile)["Content-Security-Policy"],
    );
    expect(headerDifferences(caddyfile, previewHeaders)).toEqual([]);
  });

  it("[OFE-001 AC2] fails when the Caddyfile CSP changes and the preview copy does not", () => {
    const csp = caddyStorefrontHeaders(caddyfile)["Content-Security-Policy"] ?? "";
    const changed = caddyfile.replace(csp, `${csp}; worker-src 'none'`);
    expect(changed).not.toBe(caddyfile);

    expect(headerDifferences(changed, { ...STOREFRONT_HEADERS })).toEqual([
      expect.stringMatching(/^Content-Security-Policy: Caddyfile ".*worker-src 'none'", preview /),
    ]);
  });

  it("[OFE-001 AC2] refuses a Caddyfile without a readable storefront CSP instead of passing", () => {
    expect(() => caddyStorefrontHeaders("(api_common) {\n}\n")).toThrow(/no \(storefront\) snippet/);
    expect(() =>
      caddyStorefrontHeaders("(storefront) {\n\theader {\n\t\tX-Frame-Options DENY\n\t}\n}\n"),
    ).toThrow(/no Content-Security-Policy/);
    expect(() => caddyStorefrontHeaders("(storefront) {\n\timport storefront_headers\n}\n")).toThrow(
      /no header \{ … \} block/,
    );
    expect(() =>
      caddyStorefrontHeaders(
        "(storefront_headers) {\n\theader {\n\t\tX-Frame-Options DENY\n\t}\n}\n" +
          "(storefront) {\n\timport storefront_headers\n}\n",
      ),
    ).toThrow(/no Content-Security-Policy/);
  });

  it("[OFE-001 AC2] reads the storefront header block from a snippet that (storefront) imports", () => {
    const csp = "default-src 'self'";
    expect(
      caddyStorefrontHeaders(
        `(storefront_headers) {\n\theader {\n\t\tContent-Security-Policy "${csp}"\n\t\t-Server\n\t}\n}\n` +
          "(storefront) {\n\timport access_log\n\timport storefront_headers\n}\n",
      ),
    ).toEqual({ "Content-Security-Policy": csp });
  });
});

describe("the production build and its preview", () => {
  /** @type {string | undefined} */
  let dist;
  /** @type {import("vite").PreviewServer | undefined} */
  let server;
  const EDGE_SECRET = "edge-secret-marker-for-ofe-001-tests";

  beforeAll(async () => {
    // The dev values exist when the build runs; none of them may reach the bundle (no VITE_ variables).
    vi.stubEnv("OTA_API_URL", "http://127.0.0.1:9");
    vi.stubEnv("VELEXIS_EDGE_SECRET", EDGE_SECRET);
    vi.stubEnv("STOREFRONT_DEV_HOST", "demo.ota.example.com");
    dist = scratchDir("build");
    await buildStorefront(dist);
    server = await preview({
      configFile: VITE_CONFIG,
      logLevel: "silent",
      build: { outDir: dist },
      preview: { host: "127.0.0.1", port: 0, open: false },
    });
  });

  afterAll(async () => {
    await server?.close();
    removeScratch(dist);
  });

  it("[OFE-001 AC1] writes index.html, 404.html and hashed assets with no inline script or style", () => {
    const out = /** @type {string} */ (dist);
    const files = filesIn(out);
    expect(files).toEqual(expect.arrayContaining(["index.html", "404.html"]));

    const assets = files.filter((f) => f.startsWith("assets/"));
    expect(assets.some((f) => /^assets\/index-[\w-]{8}\.js$/.test(f))).toBe(true);
    expect(assets.some((f) => /^assets\/[\w-]+-[\w-]{8}\.css$/.test(f))).toBe(true);
    expect(assets.filter((f) => !/^assets\/[\w.-]+-[\w-]{8}\.\w+$/.test(f))).toEqual([]);

    const pages = files.filter((f) => f.endsWith(".html"));
    for (const page of pages) {
      const html = readFileSync(join(out, page), "utf8");
      const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
      expect(
        scripts.filter((tag) => !/\ssrc\s*=/i.test(tag)),
        `${page}: <script> without src`,
      ).toEqual([]);
      expect(html, `${page}: style attribute`).not.toMatch(/\sstyle\s*=/i);
      expect(html, `${page}: <style> element`).not.toMatch(/<style\b/i);
      expect(html, `${page}: data: URI`).not.toMatch(/(?:src|href)\s*=\s*["']?data:/i);
      expect(html, `${page}: unexpanded partial`).not.toMatch(/@include/);
    }
    const home = readFileSync(join(out, "index.html"), "utf8");
    expect(home).toMatch(/<script type="module" crossorigin src="\/assets\/index-[\w-]{8}\.js"><\/script>/);
    expect(home).toMatch(/<noscript>/);
    expect(home).toMatch(/<header\b/);
    expect(home).toMatch(/<footer\b/);
    expect(readFileSync(join(out, "404.html"), "utf8")).toMatch(
      /<header\b[\s\S]*Page not found[\s\S]*<footer\b/,
    );
  });

  it("[OFE-001 AC1] builds every page as an MPA input without the preload polyfill or inlined assets", async () => {
    const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, VITE_CONFIG);
    const config = loaded?.config;

    expect(config?.appType).toBe("mpa");
    expect(config?.build?.modulePreload).toEqual({ polyfill: false });
    expect(config?.build?.assetsInlineLimit).toBe(0);
    expect(Object.keys(config?.build?.rollupOptions?.input ?? {})).toEqual(
      expect.arrayContaining(["index", "404"]),
    );
    expect(config?.server?.proxy).toBeUndefined();

    const out = /** @type {string} */ (dist);
    for (const file of filesIn(out).filter((f) => /\.(?:css|js)$/.test(f))) {
      expect(readFileSync(join(out, file), "utf8"), file).not.toMatch(
        /url\(\s*["']?data:|["']data:[a-z]+\//i,
      );
    }
  });

  it("[OFE-001 AC1] keeps development values and Markdown notes out of the build", () => {
    const out = /** @type {string} */ (dist);
    const files = filesIn(out);
    expect(files.filter((f) => f.endsWith(".md"))).toEqual([]);
    for (const file of files) {
      expect(readFileSync(join(out, file), "utf8"), file).not.toContain(EDGE_SECRET);
    }
    expect(existsSync(join(out, "fonts"))).toBe(false);
  });

  it("[OFE-001 AC2] vite preview sends the Caddyfile CSP on pages and on the 404 page", async () => {
    const csp = caddyStorefrontHeaders(readFileSync(CADDYFILE, "utf8"))["Content-Security-Policy"];
    const url = baseUrl(/** @type {import("vite").PreviewServer} */ (server));

    const home = await httpRequest(`${url}/`, { headers: NAVIGATION });
    expect(home.status).toBe(200);
    expect(home.headers["content-security-policy"]).toBe(csp);
    expect(home.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(home.body).toContain("<h1");

    const missing = await httpRequest(`${url}/no-such-page`, { headers: NAVIGATION });
    expect(missing.status).toBe(404);
    expect(missing.headers["content-security-policy"]).toBe(csp);
    expect(missing.body).toContain("Page not found");
  });
});
