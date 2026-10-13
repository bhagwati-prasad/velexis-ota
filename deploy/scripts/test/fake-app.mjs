#!/usr/bin/env node
// fake-app.mjs: the stand-in for a Velexis app unit in deploy/scripts/test/deploy.test.sh (task X-023).
//
// deploy/scripts/test/fake-systemctl.sh starts one per unit, in the unit's WorkingDirectory (a folder of the active
// release, for example <root>/srv/velexis/current/ota-backend) and with a clean environment:
//
//   FAKE_UNIT=velexis-ota-api FAKE_HOST=127.x.y.z FAKE_PORT=4000 FAKE_STATE=<state folder> node fake-app.mjs
//
// It answers on FAKE_HOST:FAKE_PORT (the unit's health port):
//   GET /health/live   200
//   GET /health/ready  200 {"status":"ok",...}, or 503 {"status":"unhealthy",...} while the release folder holds
//                      the flag file FAKE_UNHEALTHY (deploy.test.sh packs it into a broken release)
//   anything else      404
// Each answer names the unit, the release sha (from the release's RELEASE.json) and the process id, so the test
// sees which release every unit runs. Once it listens it writes <FAKE_STATE>/run/<unit>.ready (its pid); when it
// cannot listen it writes <unit>.error (the error code) and exits 1. SIGTERM and SIGINT stop it.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";

const unit = process.env.FAKE_UNIT ?? "";
const host = process.env.FAKE_HOST ?? "";
const port = Number.parseInt(process.env.FAKE_PORT ?? "", 10);
const state = process.env.FAKE_STATE ?? "";

if (!/^[a-z][a-z-]*$/.test(unit) || host === "" || state === "" || !(port > 0 && port < 65536)) {
  process.stderr.write("fake-app: FAKE_UNIT, FAKE_HOST, FAKE_PORT and FAKE_STATE are required\n");
  process.exit(2);
}

const releaseDir = dirname(process.cwd());
const release = (() => {
  try {
    const sha = JSON.parse(readFileSync(join(releaseDir, "RELEASE.json"), "utf8")).sha;
    return typeof sha === "string" ? sha : basename(releaseDir);
  } catch {
    return basename(releaseDir);
  }
})();
const unhealthy = () => existsSync(join(releaseDir, "FAKE_UNHEALTHY"));

/** Writes a file of the state folder atomically, so fake-systemctl.sh never reads half of it. */
function writeState(name, text) {
  const file = join(state, "run", name);
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

const server = createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(`${JSON.stringify({ ...body, unit, release, pid: process.pid })}\n`);
  };
  if (req.method === "GET" && req.url === "/health/live") {
    reply(200, { status: "ok" });
  } else if (req.method === "GET" && req.url === "/health/ready") {
    if (unhealthy()) {
      reply(503, { status: "unhealthy" });
    } else {
      reply(200, { status: "ok" });
    }
  } else {
    reply(404, { status: "not found" });
  }
});

server.on("error", (error) => {
  const code = error.code ?? "ERROR";
  writeState(`${unit}.error`, `${code}\n`);
  process.stderr.write(`fake-app ${unit}: cannot listen on ${host}:${port}: ${code}\n`);
  process.exit(1);
});

server.listen(port, host, () => {
  writeState(`${unit}.ready`, `${process.pid}\n`);
  process.stdout.write(`fake-app ${unit}: release ${release} on ${host}:${port}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    process.stdout.write(`fake-app ${unit}: ${signal}\n`);
    process.exit(0);
  });
}
