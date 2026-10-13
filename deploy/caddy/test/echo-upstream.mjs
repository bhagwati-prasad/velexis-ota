#!/usr/bin/env node
// echo-upstream.mjs: the stand-in for the Velexis apps behind Caddy in deploy/caddy/test/caddy-smoke.sh (X-022).
//
//   node deploy/caddy/test/echo-upstream.mjs
//
// It listens on 127.0.0.1 on the app ports the Caddyfile proxies to (docs/mvp/architecture.md §3): 3000 (portal),
// 3001 (platform admin), 3002 (OTA admin), 3100 (platform API) and 4000 (OTA API); ECHO_PORTS (comma-separated)
// overrides the list. Every request gets 200 and a JSON echo of what reached the upstream:
//
//   {"port":4000,"method":"GET","url":"/x","headers":{"x-velexis-host":["acme.ota.localhost"],...}}
//
// Header names are lower case and every name maps to the list of its values as received, so a header that a
// proxy appended instead of replacing shows up as two values.
//
// On the platform API port (3100) it also plays Caddy's on-demand TLS `ask` endpoint (ADR-0018):
// GET /internal/tls/ask?domain=<host> answers 200 only for the hosts of ECHO_ASK_ALLOW (comma-separated, default
// acme.ota.localhost) and 404 for anything else, and prints one line `ask <host> <status>` to stdout.
//
// It prints `ready` once every port listens, and exits 1 if a port cannot be opened (for example because it is
// in use). It never prints header values: the edge secret travels in them. SIGTERM and SIGINT stop it.
import { createServer } from "node:http";

const HOST = "127.0.0.1";
const ASK_PORT = 3100;
const ASK_PATH = "/internal/tls/ask";

const ports = (process.env.ECHO_PORTS ?? "3000,3001,3002,3100,4000")
  .split(",")
  .map((p) => Number.parseInt(p.trim(), 10));
const askAllow = new Set(
  (process.env.ECHO_ASK_ALLOW ?? "acme.ota.localhost")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== ""),
);

if (ports.length === 0 || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
  process.stderr.write(`echo-upstream: invalid ECHO_PORTS\n`);
  process.exit(2);
}

function send(res, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function handler(port) {
  return (req, res) => {
    // Drain the request body: the echo is about the request line and the headers only.
    req.resume();
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://upstream.invalid");
      if (port === ASK_PORT && req.method === "GET" && url.pathname === ASK_PATH) {
        const domain = (url.searchParams.get("domain") ?? "").toLowerCase();
        const status = askAllow.has(domain) ? 200 : 404;
        process.stdout.write(`ask ${domain || "-"} ${status}\n`);
        send(res, status, { ask: domain, allowed: status === 200 });
        return;
      }
      send(res, 200, {
        port,
        method: req.method,
        url: req.url,
        headers: req.headersDistinct,
      });
    });
  };
}

const servers = ports.map((port) => {
  const server = createServer(handler(port));
  server.keepAliveTimeout = 1000;
  return new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`port ${port}: ${error.code ?? error.message}`)));
    server.listen(port, HOST, () => resolve(server));
  });
});

try {
  const listening = await Promise.all(servers);
  const stop = () => {
    for (const server of listening) {
      server.close();
      server.closeAllConnections();
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.write(`ready ${ports.join(" ")}\n`);
} catch (error) {
  process.stderr.write(`echo-upstream: cannot listen: ${error.message}\n`);
  process.exit(1);
}
