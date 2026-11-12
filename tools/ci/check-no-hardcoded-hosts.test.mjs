// Tests of tools/ci/check-no-hardcoded-hosts.mjs (task X-032). Run: node --test tools/ci/*.test.mjs (after
// pnpm install: the script parses with the repository's TypeScript).
// The repository itself is checked once (AC1: it passes on main); every other test writes a small tree of source
// folders to a temporary folder and runs the script on it with --root and, where exceptions matter, --allow.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-no-hardcoded-hosts.mjs");

const scratch = mkdtempSync(join(tmpdir(), "x032-check-no-hardcoded-hosts-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs the script; GITHUB_ACTIONS is removed unless `annotate`, so the output is the plain form. */
function check(args, { annotate = false } = {}) {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  if (annotate) {
    env.GITHUB_ACTIONS = "true";
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

let count = 0;
/**
 * Writes `files` (path → content) to a new folder and runs the script on it. A tree always holds one clean source
 * file, so that it is never empty; `allow` (an array) is written to a file and passed with --allow, by default [].
 */
function run(files, { allow = [], annotate = false } = {}) {
  const dir = join(scratch, `repo-${(count += 1)}`);
  const all = { "packages/config/src/index.ts": "export const ok = 1;\n", ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const allowFile = join(dir, "allow.json");
  writeFileSync(allowFile, JSON.stringify(allow));
  return check(["--root", dir, "--allow", allowFile], { annotate });
}

/** The `error: <file>:<line>:<column>` locations of an output, in order. */
const locations = (out) =>
  [...out.matchAll(/^error: (\S+?):(\d+):(\d+): /gm)].map((m) => `${m[1]}:${m[2]}:${m[3]}`);

describe("the repository", () => {
  // Budget: one run over every source file of the repository, about 5 s on four CPUs (TypeScript parses each file).
  let repository;
  before(() => {
    repository = check([]);
  });

  it("[X-032 AC1] passes on this repository, with every reviewed exception in use", () => {
    assert.equal(repository.status, 0, repository.out);
    const summary = repository.out.match(
      /check-no-hardcoded-hosts: (\d+) file\(s\) in (\d+) source folder\(s\), (\d+) reviewed exception\(s\), 0 problem\(s\)/,
    );
    assert.ok(summary, repository.out);
    assert.ok(Number(summary[1]) > 500, "it read the source files of every app and package");
    // platform/{admin,backend,frontend}, ota/{admin,backend,frontend,sdk} and packages/* without packages/testing.
    assert.ok(Number(summary[2]) >= 12, "every source folder");
    assert.ok(Number(summary[3]) > 0, "the reviewed exceptions apply");
  });
});

describe("findings", () => {
  it("[X-032 AC1] a commit that hard-codes 127.0.0.1:5432 in platform/backend/src fails and names the place", () => {
    const { status, out } = run({
      "platform/backend/src/database.ts": [
        'import pg from "pg";',
        "",
        'export const pool = new pg.Pool({ connectionString: "postgres://velexis_platform_app:x@127.0.0.1:5432/velexis" });',
        "",
      ].join("\n"),
    });
    assert.equal(status, 1, out);
    assert.deepEqual(locations(out), [
      "platform/backend/src/database.ts:3:88",
      "platform/backend/src/database.ts:3:97",
    ]);
    assert.match(out, /"127\.0\.0\.1" in code: reach a service through a DSN or URL of the configuration/);
    assert.match(out, /":5432" in code/);
    assert.match(out, /0 reviewed exception\(s\), 2 problem\(s\)/);
  });

  it("[X-032 AC1] localhost, the Redis port and a numeric port fail in every app and package, in any case", () => {
    const { status, out } = run({
      "ota/backend/src/redis.ts": 'export const url = "redis://LocalHost:6379/0";\n',
      "ota/sdk/src/client.js": "export const options = { host: db, port: 5432 };\n",
      "packages/db/src/defaults.ts": "export const redis = { port:6379 };\n",
      "platform/frontend/src/page.tsx": "export const Page = () => <p>Open http://localhost:3000 now</p>;\n",
      "ota/frontend/src/lib/api.js": "export const base = `http://127.0.0.1:${port}/v1`;\n",
    });
    assert.equal(status, 1, out);
    assert.deepEqual(locations(out), [
      "platform/frontend/src/page.tsx:1:42",
      "ota/backend/src/redis.ts:1:29",
      "ota/backend/src/redis.ts:1:38",
      "ota/frontend/src/lib/api.js:1:29",
      "ota/sdk/src/client.js:1:40",
      "packages/db/src/defaults.ts:1:28",
    ]);
  });

  it("[X-032 AC1] the reference data loader, which ships in the release, is checked; the other tools are not", () => {
    const { status, out } = run({
      "tools/reference-data/src/load.ts": 'export const url = "postgres://x@localhost/velexis";\n',
      "tools/amadeus-stub/src/server.ts": 'export const host = "127.0.0.1";\n',
      "tools/dev/src/seed.ts": 'export const url = "redis://127.0.0.1:6379/0";\n',
    });
    assert.equal(status, 1, out);
    assert.deepEqual(locations(out), ["tools/reference-data/src/load.ts:1:34"]);
  });

  it("[X-032 AC1] templates and styles are read with their comments; other hosts and ports pass", () => {
    const { status, out } = run({
      "ota/backend/src/templates/booking.hbs": '{{!-- link --}}\n<a href="http://localhost:3000/b">x</a>\n',
      "platform/backend/src/clean.ts": [
        'export const a = "postgres://db.internal.test:6543/velexis";',
        'export const b = "127.0.0.10";',
        "export const c = 15432;",
        "export const isLocalhostOrigin = (origin: string) => origin.length > 0;",
        "",
      ].join("\n"),
    });
    assert.equal(status, 1, out);
    assert.deepEqual(locations(out), ["ota/backend/src/templates/booking.hbs:2:17"]);
  });
});

describe("what does not count", () => {
  it("[X-032 AC1] comments, JSDoc and documentation files are no findings", () => {
    const { status, out } = run({
      "platform/backend/src/main.ts": [
        "// The API listens on 127.0.0.1:3100 behind Caddy; PostgreSQL is on localhost:5432 in development.",
        "/**",
        " * Connects to `REDIS_URL` (redis://127.0.0.1:6379/0 locally).",
        " */",
        "export const port = Number(process.env.PORT); /* not 127.0.0.1 */",
        "",
      ].join("\n"),
      "ota/admin/src/page.tsx": "export const P = () => <p>{/* http://localhost:3002 */}ok</p>;\n",
      "ota/backend/src/README.md": "Run it on http://localhost:4000.\n",
      "ota/backend/src/words.txt": "127.0.0.1\n",
    });
    assert.equal(status, 0, out);
    assert.match(out, / 0 problem\(s\)/);
  });

  it("[X-032 AC1] tests, test folders and the test-support package are no findings", () => {
    const { status, out } = run({
      "platform/backend/src/config.test.ts": 'const url = "postgres://x@127.0.0.1:5432/velexis";\n',
      "ota/backend/src/worker.spec.mts": 'const url = "redis://localhost:6379/0";\n',
      "ota/admin/src/test/fake-api.ts": 'export const host = "127.0.0.1";\n',
      "ota/admin/src/__mocks__/api.ts": 'export const host = "localhost";\n',
      "packages/testing/src/redis.ts": 'export const url = "redis://127.0.0.1:6379/0";\n',
      "platform/backend/test/helpers.ts": 'export const url = "postgres://x@127.0.0.1:5432/velexis";\n',
    });
    assert.equal(status, 0, out);
  });

  it("[X-032 AC1] build output and dependencies inside a source folder are not read", () => {
    const { status, out } = run({
      "ota/backend/src/node_modules/x/index.js": 'module.exports = "http://localhost";\n',
      "platform/admin/src/dist/a.js": 'export const a = "127.0.0.1";\n',
    });
    assert.equal(status, 0, out);
  });
});

describe("reviewed exceptions", () => {
  const MAIN = 'export const API_HOST = "127.0.0.1";\nexport const OTHER = "127.0.0.1";\n';
  const LISTEN = {
    file: "platform/backend/src/main.ts",
    code: 'API_HOST = "127.0.0.1"',
    why: "listen address",
  };

  it("[X-032 AC1] an exception covers its own fragment of its own file only", () => {
    const { status, out } = run(
      { "platform/backend/src/main.ts": MAIN, "ota/backend/src/main.ts": MAIN },
      { allow: [LISTEN] },
    );
    assert.equal(status, 1, out);
    assert.deepEqual(locations(out), [
      "platform/backend/src/main.ts:2:23",
      "ota/backend/src/main.ts:1:26",
      "ota/backend/src/main.ts:2:23",
    ]);
    assert.match(out, /1 reviewed exception\(s\), 3 problem\(s\)/);
  });

  it("[X-032 AC1] an exception that matches nothing any more fails", () => {
    const { status, out } = run(
      { "platform/backend/src/main.ts": "export const API_HOST = process.env.HOST;\n" },
      { allow: [LISTEN] },
    );
    assert.equal(status, 1, out);
    assert.match(
      out,
      /error: platform\/backend\/src\/main\.ts: the reviewed exception "API_HOST = \\"127\.0\.0\.1\\"" matches no finding any more/,
    );
  });

  it("[X-032 AC1] an exception needs a file, a code fragment and a reason", () => {
    const { status, out } = run(
      { "platform/backend/src/main.ts": MAIN },
      { allow: [{ file: LISTEN.file, code: LISTEN.code, why: " " }] },
    );
    assert.equal(status, 1, out);
    assert.match(out, /every exception needs a file, a code fragment and a reason/);
  });
});

describe("output", () => {
  it("[X-032 AC1] a tree without any source file fails: nothing was checked", () => {
    const dir = join(scratch, "empty");
    mkdirSync(join(dir, "platform/backend"), { recursive: true });
    const allowFile = join(dir, "allow.json");
    writeFileSync(allowFile, "[]");
    const { status, out } = check(["--root", dir, "--allow", allowFile]);
    assert.equal(status, 1, out);
    assert.match(
      out,
      /found no source file under platform\/\*\/src, ota\/\*\/src, packages\/\*\/src or tools\/reference-data\/src/,
    );
  });

  it("[X-032 AC1] inside GitHub Actions a finding is an error annotation with file, line and column", () => {
    const { status, out } = run(
      { "platform/backend/src/database.ts": 'export const url = "postgres://x@127.0.0.1:5432/v";\n' },
      { annotate: true },
    );
    assert.equal(status, 1, out);
    assert.match(
      out,
      /^::error file=platform\/backend\/src\/database\.ts,line=1,col=34::"127\.0\.0\.1" in code/m,
    );
  });
});
