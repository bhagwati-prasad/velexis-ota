#!/usr/bin/env node
/*
 * Velexis Guidebook static server (zero dependencies). Optional: the guidebook also works from file://.
 *
 *   node tools/serve.mjs [--port 4173] [--host 127.0.0.1] [--root <folder>]
 *
 * Serves the guidebook folder read-only on http://127.0.0.1:4173 (local only by default). Port 0 picks a free port.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUIDE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function parseArgs(argv) {
  const o = { port: Number(process.env.PORT || 4173), host: "127.0.0.1", root: GUIDE_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--host") o.host = argv[++i];
    else if (a === "--root") o.root = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** Creates the server (not listening). Exported for tests. */
export function createServer(root = GUIDE_DIR) {
  const base = path.resolve(root);
  return http.createServer((req, res) => {
    const send = (status, body, type) => {
      res.writeHead(status, {
        "content-type": type || "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Method not allowed");
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      return send(400, "Bad request");
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(base, "." + rel);
    if (file !== base && !file.startsWith(base + path.sep)) return send(403, "Forbidden");
    if (path.basename(file).startsWith(".")) return send(404, "Not found");
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(404, "Not found");
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        "content-length": st.size,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`serve: ${err.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log("usage: node tools/serve.mjs [--port 4173] [--host 127.0.0.1] [--root <folder>]");
    process.exit(0);
  }
  const server = createServer(opts.root);
  server.listen(opts.port, opts.host, () => {
    const { port } = server.address();
    console.log(`Velexis Guidebook: http://${opts.host}:${port}/  (serving ${opts.root}; Ctrl+C to stop)`);
  });
}
