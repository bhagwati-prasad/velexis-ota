// Tests of the CI workflow's own rules (task X-019). Run: node --test tools/ci/*.test.mjs (after pnpm install,
// because the lint test loads ESLint with the repository's eslint.config.mjs).
//
// The "Repository guards" step is read from .github/workflows/ci.yml and run with `bash -e`, as GitHub runs a
// `run:` script, inside small git repositories whose last commit plays the pull request's merge commit.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_YML = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
// Built at run time, so that this file does not trip the guard it tests.
const SESSION_SET = ["SET", "search_path"].join(" ");
const SESSION_SET_CONFIG = (value) => `set_config('search_path', ${value}, ${["fal", "se"].join("")})`;

const scratch = mkdtempSync(join(tmpdir(), "x019-ci-workflow-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// ---- A reader for the shape of ci.yml (Prettier keeps the two-space indentation stable) -------------------

function dedent(lines) {
  const indents = lines.filter((l) => l.trim() !== "").map((l) => l.match(/^ */)[0].length);
  const cut = Math.min(...indents);
  return lines
    .map((l) => l.slice(cut))
    .join("\n")
    .trimEnd();
}

/** The fields of one step (`name`, `uses`, `run`, ...); `run: |` blocks are dedented. */
function stepFields(lines) {
  const fields = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^ {8}([a-z-]+):(?: (.*))?$/);
    if (!m) {
      continue;
    }
    const value = (m[2] ?? "").replace(/\s+#.*$/, "");
    if (value === "|") {
      const block = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^ {10}/.test(lines[i + 1]))) {
        block.push(lines[(i += 1)]);
      }
      fields[m[1]] = dedent(block);
    } else {
      fields[m[1]] = value;
    }
  }
  return fields;
}

/** jobId -> { lines, steps: [{ name, uses, run, ... }] } */
function parseWorkflow(text) {
  const jobs = new Map();
  let inJobs = false;
  let job = null;
  for (const line of text.split("\n")) {
    if (/^[^\s#]/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      job = null;
    } else if (inJobs && /^ {2}[\w-]+:\s*$/.test(line)) {
      job = { lines: [], steps: [] };
      jobs.set(line.trim().slice(0, -1), job);
    } else if (job) {
      job.lines.push(line);
    }
  }
  for (const current of jobs.values()) {
    let inSteps = false;
    let step = null;
    for (const line of current.lines) {
      if (/^ {4}[^\s#]/.test(line)) {
        inSteps = /^ {4}steps:\s*$/.test(line);
        step = null;
      } else if (inSteps && /^ {6}- /.test(line)) {
        step = [line.replace(/^ {6}- /, " ".repeat(8))];
        current.steps.push(step);
      } else if (inSteps && step) {
        step.push(line);
      }
    }
    current.steps = current.steps.map(stepFields);
  }
  return jobs;
}

const JOBS = parseWorkflow(CI_YML);
const stepIndex = (job, predicate) => JOBS.get(job).steps.findIndex(predicate);
const GUARDS = JOBS.get("build-test")?.steps.find((s) => s.name === "Repository guards")?.run;

// ---- Scratch git repositories ----------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "CI test",
  GIT_AUTHOR_EMAIL: "ci-test@example.invalid",
  GIT_COMMITTER_NAME: "CI test",
  GIT_COMMITTER_EMAIL: "ci-test@example.invalid",
};
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV });

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

let count = 0;
/** A repository with a base commit and a head commit, as `actions/checkout` with fetch-depth 2 leaves a PR. */
function repo(base, head) {
  const dir = join(scratch, `repo-${(count += 1)}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFiles(dir, {
    "README.md": "fixture\n",
    "docs/velexis-sdk/sdk/src/shared.d.ts": "export {};\n",
    ...base,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  writeFiles(dir, head);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "head");
  return dir;
}

/** Runs the guards step the way GitHub runs a `run:` script without `shell:` (bash -e). */
function guards(cwd, event = "pull_request") {
  const script = join(scratch, `guards-${(count += 1)}.sh`);
  writeFileSync(script, `${GUARDS}\n`);
  const result = spawnSync("bash", ["-e", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: event },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

// ---- Tests -------------------------------------------------------------------------------------------------

describe("workflow shape", () => {
  it("[X-019 AC3] the plan-lint job runs without pnpm install", () => {
    const job = JOBS.get("plan-lint");
    assert.ok(job, "ci.yml has a plan-lint job");
    assert.ok(
      job.steps.some((s) => s.run === "node tools/plan-lint/plan-lint.mjs"),
      "it runs plan-lint",
    );
    for (const step of job.steps) {
      assert.doesNotMatch(step.uses ?? "", /pnpm\/action-setup/);
      assert.doesNotMatch(step.run ?? "", /\bpnpm\b|\bnpm (?:ci|install)\b/);
    }
    const code = job.lines.filter((line) => !/^\s*#/.test(line)).join("\n");
    assert.doesNotMatch(code, /cache: pnpm|pnpm install|pnpm\/action-setup/);
  });

  it("[X-019 AC2] build-test runs the guards and check-package-json before the install and the tests", () => {
    const guardsAt = stepIndex("build-test", (s) => s.name === "Repository guards");
    const checkAt = stepIndex("build-test", (s) => s.run === "node tools/ci/check-package-json.mjs");
    const installAt = stepIndex("build-test", (s) => s.run === "pnpm install --frozen-lockfile");
    const ciTestsAt = stepIndex("build-test", (s) =>
      /node --test tools\/ci\/\*\.test\.mjs/.test(s.run ?? ""),
    );
    const lintAt = stepIndex("build-test", (s) => s.run === "pnpm lint");
    const testAt = stepIndex("build-test", (s) => s.run === "pnpm test");
    const intAt = stepIndex("build-test", (s) => s.run === "pnpm test:int");
    for (const [name, at] of Object.entries({
      guardsAt,
      checkAt,
      installAt,
      ciTestsAt,
      lintAt,
      testAt,
      intAt,
    })) {
      assert.ok(at >= 0, `step ${name} exists`);
    }
    assert.ok(guardsAt < installAt && checkAt < installAt, "guards and package checks need no install");
    assert.ok(
      installAt < ciTestsAt && ciTestsAt < testAt && testAt < intAt,
      "CI-script tests run before the tests",
    );
    assert.ok(lintAt < testAt);
  });

  it("[X-019 AC5] every uses: in .github/workflows is pinned to a 40-character commit SHA", () => {
    const dir = join(ROOT, ".github/workflows");
    let uses = 0;
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
        if (m) {
          uses += 1;
          assert.match(m[1], /^(?:\.\/|[\w.-]+\/[\w./-]+@[0-9a-f]{40}$)/, `${file}: ${line.trim()}`);
        }
      }
    }
    assert.ok(uses > 0);
  });

  it("[X-019 AC2] the guards step uses no ${{ }} expression, so it runs here exactly as in CI", () => {
    assert.ok(GUARDS, "build-test has a Repository guards step");
    assert.doesNotMatch(GUARDS, /\$\{\{/);
  });
});

describe("dependabot.yml", () => {
  // GitHub validates the file when it is pushed (AC4); this keeps the agreed policy from drifting.
  const text = readFileSync(join(ROOT, ".github/dependabot.yml"), "utf8");
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  /** The `ignore` entry of one dependency name: its line and its update-types line. */
  const ignoreRule = (name) =>
    text.match(
      new RegExp(`^ {6}- dependency-name: ${escape(name)}(?: #.*)?\\n {8}update-types: .*$`, "m"),
    )?.[0] ?? "";

  it("[X-019 AC4] weekly npm updates, minor and patch only, in the four groups", () => {
    assert.match(text, /^version: 2$/m);
    assert.match(text, /- package-ecosystem: npm\n {4}directory: \/\n {4}schedule:\n {6}interval: weekly/);
    assert.match(text, /^ {4}versioning-strategy: increase$/m);
    for (const group of ["nestjs", "next-react", "tooling", "types"]) {
      const at = text.search(new RegExp(`^ {6}${group}:$`, "m"));
      assert.ok(at > 0, `group ${group}`);
      assert.match(text.slice(at).split(/\n {6}\S/)[0], /update-types: \[minor, patch\]/, group);
    }
    for (const pattern of ["eslint", "prettier", "turbo", "vitest", "typescript-eslint"]) {
      assert.match(text, new RegExp(`^ {10}- ${pattern}$`, "m"), `tooling: ${pattern}`);
    }
    assert.match(ignoreRule('"*"'), /version-update:semver-major/);
  });

  it("[X-019 AC4] the ignore rules keep TypeScript 5.6, Node types 22, Next.js 15 and NestJS 11", () => {
    assert.match(ignoreRule("typescript"), /semver-major.*semver-minor/);
    for (const name of ['"@types/node"', "next", '"@next/*"', '"@nestjs/*"']) {
      assert.match(ignoreRule(name), /"version-update:semver-major"/, name);
    }
  });

  it("[X-019 AC4] the ignore rules keep the other minor lines of tech-stack.md (patches only)", () => {
    for (const name of [
      "kysely",
      "kysely-codegen",
      "openapi-fetch",
      "esbuild",
      "pdfmake",
      "handlebars",
      "cookie-parser",
      "tailwindcss",
      '"@tailwindcss/*"',
    ]) {
      assert.match(ignoreRule(name), /"version-update:semver-minor"/, name);
    }
  });

  it("[X-019 AC4] weekly github-actions updates", () => {
    assert.match(
      text,
      /- package-ecosystem: github-actions\n {4}directory: \/\n {4}schedule:\n {6}interval: weekly/,
    );
  });
});

describe("repository guards", () => {
  it("[X-019 AC2] a pull request adding a session-level search_path change in platform/ fails the guards", () => {
    const pr = repo(
      {},
      { "platform/backend/src/tenant.ts": `await sql.raw("${SESSION_SET} TO tenant_alpha");\n` },
    );
    const { status, out } = guards(pr);
    assert.notEqual(status, 0, out);
    assert.match(out, /platform\/backend\/src\/tenant\.ts:1:/);
    assert.ok(out.includes(`::error::Session-level ${SESSION_SET} outside packages/db`), out);
  });

  it("[X-019 AC2] the search_path guard covers every app and package, any case, SQL and JS too", () => {
    const lower = SESSION_SET.toLowerCase().replace(" ", " session ");
    for (const [path, content] of Object.entries({
      "ota/backend/migrations/tenant/0002_x.sql": `${lower} = tenant_alpha;\n`,
      "packages/testing/src/db.ts": `${SESSION_SET} TO tenant_alpha\n`,
      "tools/reference-data/src/load.mjs": `${SESSION_SET} TO reference\n`,
      "platform/frontend/src/page.tsx": `${SESSION_SET} TO platform\n`,
    })) {
      const { status, out } = guards(repo({}, { [path]: content }));
      assert.notEqual(status, 0, `${path}: ${out}`);
      assert.ok(out.includes(`${path}:1:`), out);
    }
  });

  it("[X-019 AC2] the session-level forms set_config(..., false) and a quoted search_path fail the guards", () => {
    for (const [path, content] of Object.entries({
      "platform/backend/src/a.ts": `await sql\`select ${SESSION_SET_CONFIG("${schema}")}\`;\n`,
      "ota/backend/src/b.ts": `db.query("SELECT ${SESSION_SET_CONFIG("quote_ident($1)")}");\n`,
      "packages/testing/src/c.sql": `${SESSION_SET.replace("search_path", '"search_path"')} TO x;\n`,
    })) {
      const { status, out } = guards(repo({}, { [path]: content }));
      assert.notEqual(status, 0, `${path}: ${out}`);
      assert.ok(out.includes(`${path}:1:`), out);
    }
    // packages/db (the migration runner and its leak-guard tests) stays exempt.
    const db = repo({}, { "packages/db/src/migrate.ts": `${SESSION_SET_CONFIG("$1")}\n` });
    const dbRun = guards(db);
    assert.equal(dbRun.status, 0, dbRun.out);
  });

  it("[X-019 AC2] packages/db, transaction-level SET LOCAL and set_config(..., true) pass the guards", () => {
    const pr = repo(
      {},
      {
        "packages/db/src/tenant-tx.ts": `${SESSION_SET} TO pg_catalog\n`,
        "ota/backend/src/a.ts": `${SESSION_SET.replace(" ", " LOCAL ")} TO tenant_alpha\n`,
        "ota/backend/src/b.ts": "select set_config('search_path', $1, true)\n",
        "ota/backend/node_modules/x/index.ts": `${SESSION_SET} TO x\n`,
      },
    );
    const { status, out } = guards(pr);
    assert.equal(status, 0, out);
  });

  it("[X-019 AC2] a pull request editing docs/velexis-sdk/ or docs/amadeus-api/ fails the guards", () => {
    for (const path of ["docs/velexis-sdk/sdk/src/shared.d.ts", "docs/amadeus-api/flight-offers.json"]) {
      const pr = repo({ "docs/amadeus-api/flight-offers.json": "{}\n" }, { [path]: "changed\n" });
      const { status, out } = guards(pr);
      assert.notEqual(status, 0, `${path}: ${out}`);
      assert.ok(out.includes(path), out);
      assert.match(out, /::error::docs\/velexis-sdk and docs\/amadeus-api are reference material/);
    }
  });

  it("[X-019 AC2] the reference-material guard applies to pull requests only", () => {
    const push = repo({}, { "docs/velexis-sdk/sdk/src/shared.d.ts": "changed\n" });
    assert.equal(guards(push, "push").status, 0);
    assert.equal(guards(push, "workflow_dispatch").status, 0);
  });

  it("[X-019 AC2] a baseline migration that differs from the reference DDL fails the guards", () => {
    const reference = { "docs/velexis-sdk/db/platform.sql": "create table a ();\n" };
    const same = repo(reference, {
      "platform/backend/migrations/platform/0001_baseline.sql": "create table a ();\n",
    });
    assert.equal(guards(same, "push").status, 0);
    const differs = repo(reference, {
      "platform/backend/migrations/platform/0001_baseline.sql": "create table b ();\n",
    });
    const { status, out } = guards(differs, "push");
    assert.notEqual(status, 0, out);
    assert.match(out, /::error::platform\/backend\/migrations\/platform\/0001_baseline\.sql differs from/);
  });

  it("[X-019 AC2] a clean pull request and this repository pass the guards", () => {
    const clean = repo({}, { "packages/config/src/index.ts": "export const ok = true;\n" });
    assert.equal(guards(clean).status, 0);
    const self = guards(ROOT, "push");
    assert.equal(self.status, 0, self.out);
  });
});

describe("lint", () => {
  it("[X-019 AC2] a test containing it.only fails lint", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: ROOT });
    const code = 'import { describe, it, test } from "vitest";\n';
    for (const [file, focused] of [
      ["ota/sdk/test/client.test.js", 'it.only("x", () => {});'],
      ["ota/frontend/test/search.test.js", 'describe.only("x", () => {});'],
      ["tools/e2e/specs/booking.e2e.ts", 'test.only("x", () => {});'],
    ]) {
      const [result] = await eslint.lintText(`${code}${focused}\n`, { filePath: join(ROOT, file) });
      const errors = result.messages.filter((m) => m.severity === 2);
      assert.ok(
        errors.some((m) => m.ruleId === "no-restricted-properties" && /focused tests/.test(m.message)),
        `${file}: ${JSON.stringify(result.messages)}`,
      );
    }
    // Type-aware sources (packages/*/src, apps' src and test) need their tsconfig to parse; the rule is the same.
    for (const file of [
      "packages/config/src/env.test.ts",
      "packages/db/test/integration/tenant.int.test.ts",
      "platform/backend/test/health.test.ts",
      "platform/frontend/src/components/button.test.tsx",
    ]) {
      const config = await eslint.calculateConfigForFile(join(ROOT, file));
      const [severity, ...options] = config.rules["no-restricted-properties"];
      assert.ok(severity === 2 || severity === "error", `${file}: severity ${severity}`);
      for (const object of ["it", "test", "describe"]) {
        assert.ok(
          options.some((o) => o.object === object && o.property === "only"),
          `${file}: ${object}.only`,
        );
      }
    }
  });
});
