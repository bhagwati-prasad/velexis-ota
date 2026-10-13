// Test helpers: build the storefront with its real vite.config.js into a scratch folder, and plain HTTP requests
// against the dev and preview servers (node:http, because storefront code never calls fetch directly).
import { request } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

export const STOREFRONT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_ROOT = resolve(STOREFRONT_ROOT, "..", "..");
export const VITE_CONFIG = join(STOREFRONT_ROOT, "vite.config.js");

/** A new empty folder in the system temporary folder; remove it with `removeScratch`. */
export const scratchDir = (/** @type {string} */ prefix) =>
  mkdtempSync(join(tmpdir(), `velexis-ofe-${prefix}-`));

export const removeScratch = (/** @type {string | undefined} */ dir) => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Runs `vite build` with the storefront's vite.config.js into `outDir`. */
export async function buildStorefront(/** @type {string} */ outDir) {
  await build({ configFile: VITE_CONFIG, logLevel: "silent", build: { outDir, emptyOutDir: true } });
}

/** Every file below `dir`, as `/`-separated paths relative to it. */
export const filesIn = (/** @type {string} */ dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .split(sep)
        .join("/"),
    )
    .sort();

/**
 * One HTTP request; resolves with the status, the response headers and the body as text.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, headers: import("node:http").IncomingHttpHeaders, body: string }>}
 */
export function httpRequest(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = /** @type {Buffer[]} */ ([]);
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolvePromise({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** The `http://127.0.0.1:<port>` base URL of a listening Vite dev or preview server. */
export function baseUrl(/** @type {{ httpServer: import("node:http").Server | null }} */ server) {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("the server is not listening on a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

/** Browser-like Accept header of a page navigation. */
export const NAVIGATION = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
