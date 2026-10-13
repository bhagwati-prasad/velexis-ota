// Tests of tools/ci/check-package-json.mjs (task X-019). Run: node --test tools/ci/*.test.mjs
// Each test builds a small repository in a temporary folder and runs the script on it with --root.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SCRIPT = join(HERE, "check-package-json.mjs");
const SHA = "11d5960a326750d5838078e36cf38b85af677262";

const scratch = mkdtempSync(join(tmpdir(), "x019-check-package-json-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BASE = {
  "package.json": {
    name: "velexis",
    private: true,
    packageManager: "pnpm@9.15.9",
    devDependencies: { turbo: "2.11.4" },
  },
  "pnpm-workspace.yaml": [
    "# comment",
    "packages:",
    '  - "platform/*"',
    '  - "ota/*"',
    '  - "packages/*"',
    '  - "tools/*"',
    "",
  ].join("\n"),
  ".github/workflows/ci.yml": `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v4.4.0\n`,
  "packages/config/package.json": { name: "@velexis/config", dependencies: { pino: "9.14.0" } },
  "ota/sdk/package.json": { name: "@velexis/ota-sdk" },
};

let count = 0;
/** Writes BASE plus `files` (null removes a BASE file) to a new folder and runs the script on it. */
function run(files = {}) {
  const dir = join(scratch, `repo-${(count += 1)}`);
  for (const [path, content] of Object.entries({ ...BASE, ...files })) {
    if (content === null) {
      continue;
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(
      join(dir, path),
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
  return check(dir);
}

function check(root) {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8", env });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const withDeps = (dir, name, deps) => ({ [`${dir}/package.json`]: { name, ...deps } });

describe("exact versions (ADR-0002 item 7)", () => {
  it("[X-019 AC2] a ^1.0.0 range fails check-package-json", () => {
    const { status, out } = run(
      withDeps("packages/logger", "@velexis/logger", { dependencies: { pino: "^1.0.0" } }),
    );
    assert.equal(status, 1, out);
    assert.match(out, /packages\/logger\/package\.json: dependencies "pino": "\^1\.0\.0" is a \^ or ~ range/);
  });

  it("[X-019 AC2] a ~ range fails, in every dependency field and in the root package.json", () => {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const { status, out } = run({
        "package.json": { ...BASE["package.json"], [field]: { prettier: "~3.9.9" } },
      });
      assert.equal(status, 1, out);
      assert.match(
        out,
        new RegExp(`error: package\\.json: ${field} "prettier": "~3\\.9\\.9" is a \\^ or ~ range`),
      );
    }
  });

  it("[X-019 AC2] other ranges, dist-tags, URLs, paths and workspace ranges fail too", () => {
    const specs = [">=1.0.0", "1.x", "1.0", "*", "latest", "", "workspace:^", "workspace:~", "file:../x"];
    for (const spec of [...specs, "github:owner/repo", "https://example.com/x.tgz", "npm:other@^1.0.0"]) {
      const { status, out } = run(
        withDeps("platform/backend", "@velexis/platform-backend", { dependencies: { x: spec } }),
      );
      assert.equal(status, 1, `${spec}: ${out}`);
      assert.match(out, /platform\/backend\/package\.json: dependencies "x"/);
    }
  });

  it("[X-019 AC2] exact versions, prereleases, workspace:* and exact npm aliases pass", () => {
    const { status, out } = run(
      withDeps("platform/backend", "@velexis/platform-backend", {
        dependencies: {
          "@velexis/config": "workspace:*",
          pino: "9.14.0",
          next: "15.5.0-canary.3",
          "string-width-cjs": "npm:string-width@4.2.3",
          "@scoped/alias": "npm:@other/pkg@1.0.0",
        },
      }),
    );
    assert.equal(status, 0, out);
    assert.match(out, /0 problem\(s\)/);
  });

  it("[X-019 AC2] a range in pnpm.overrides fails; exact, $name and - overrides pass", () => {
    const root = (overrides) => ({ "package.json": { ...BASE["package.json"], pnpm: { overrides } } });
    const bad = run(root({ "foo@<2": "^2.0.0" }));
    assert.equal(bad.status, 1, bad.out);
    assert.match(bad.out, /pnpm\.overrides "foo@<2": "\^2\.0\.0" is a \^ or ~ range/);
    const good = run(root({ "foo@<2": "2.0.1", bar: "$bar", baz: "-" }));
    assert.equal(good.status, 0, good.out);
  });

  it("[X-019 AC2] the root packageManager must be an exact pnpm version", () => {
    for (const packageManager of ["pnpm@9", "pnpm@^9.15.9", "npm@10.0.0", undefined]) {
      const { status, out } = run({ "package.json": { ...BASE["package.json"], packageManager } });
      assert.equal(status, 1, `${packageManager}: ${out}`);
      assert.match(out, /"packageManager" must be an exact "pnpm@x\.y\.z"/);
    }
    const sha = `pnpm@9.15.9+sha512.${"ab".repeat(32)}`;
    assert.equal(run({ "package.json": { ...BASE["package.json"], packageManager: sha } }).status, 0);
  });

  it("[X-019 AC2] only workspace folders are read: docs, node_modules and excluded globs are skipped", () => {
    const ranged = (name) => ({ name, dependencies: { x: "^1.0.0" } });
    const { status, out } = run({
      "pnpm-workspace.yaml": `${BASE["pnpm-workspace.yaml"]}  - "!tools/legacy"\n`,
      "docs/velexis-sdk/sdk/package.json": ranged("reference-sdk"),
      "packages/config/node_modules/pino/package.json": ranged("pino"),
      "tools/legacy/package.json": ranged("legacy"),
      "tools/e2e/package.json": { name: "@velexis/e2e", devDependencies: { "@playwright/test": "1.56.1" } },
    });
    assert.equal(status, 0, out);
    assert.match(out, /4 package\.json file\(s\)/);
  });

  it("[X-019 AC2] a package.json that is not valid JSON fails", () => {
    const { status, out } = run({ "packages/config/package.json": "{ not json" });
    assert.equal(status, 1, out);
    assert.match(out, /packages\/config\/package\.json: cannot be read/);
  });

  it("[X-019 AC2] a pnpm-workspace.yaml it cannot read fails instead of checking the root alone", () => {
    const ranged = {
      "packages/config/package.json": { name: "@velexis/config", dependencies: { x: "^1.0.0" } },
    };
    for (const workspace of [null, 'packages: ["platform/*", "packages/*"]\n', "packages:\n", "# none\n"]) {
      const { status, out } = run({ ...ranged, "pnpm-workspace.yaml": workspace });
      assert.equal(status, 1, `${JSON.stringify(workspace)}: ${out}`);
      assert.match(out, /error: pnpm-workspace\.yaml: lists no workspace packages/);
    }
  });
});

describe("dev-only test packages (ADR-0022 item 2)", () => {
  for (const name of ["@velexis/testing", "@velexis/amadeus-stub"]) {
    it(`[X-019 AC2] ${name} outside devDependencies fails`, () => {
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        const { status, out } = run(
          withDeps("ota/backend", "@velexis/ota-backend", { [field]: { [name]: "workspace:*" } }),
        );
        assert.equal(status, 1, out);
        assert.ok(out.includes(`"${name}" is in ${field}; it is a devDependency only`), out);
      }
    });

    it(`[X-019 AC2] ${name} in devDependencies passes`, () => {
      const deps = { devDependencies: { [name]: "workspace:*" } };
      const { status, out } = run(withDeps("packages/db", "@velexis/db", deps));
      assert.equal(status, 0, out);
    });
  }
});

describe("packages never depend on apps (ADR-0002 item 5)", () => {
  it("[X-019 AC2] a package under packages/ that depends on an app fails, in any field", () => {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const { status, out } = run(
        withDeps("packages/api-types", "@velexis/api-types", {
          [field]: { "@velexis/ota-sdk": "workspace:*" },
        }),
      );
      assert.equal(status, 1, out);
      assert.ok(
        out.includes(`${field} "@velexis/ota-sdk" is an app (ota/sdk); packages never depend on apps`),
        out,
      );
    }
  });

  it("[X-019 AC2] an app name is refused even before the app exists", () => {
    const deps = { dependencies: { "@velexis/platform-backend": "workspace:*" } };
    const { status, out } = run(withDeps("packages/db", "@velexis/db", deps));
    assert.equal(status, 1, out);
    assert.match(out, /"@velexis\/platform-backend" is an app; packages never depend on apps/);
  });

  it("[X-019 AC2] apps and tools may depend on packages and apps may depend on each other's packages", () => {
    const { status, out } = run({
      ...withDeps("ota/admin", "@velexis/ota-admin", {
        dependencies: { "@velexis/ota-sdk": "workspace:*", "@velexis/config": "workspace:*" },
      }),
      ...withDeps("tools/e2e", "@velexis/e2e", { devDependencies: { "@velexis/ota-sdk": "workspace:*" } }),
    });
    assert.equal(status, 0, out);
  });
});

describe("SHA-pinned actions (ADR-0023)", () => {
  const workflow = (...uses) => ({
    ".github/workflows/ci.yml": `jobs:\n  a:\n    steps:\n${uses.map((u) => `      - uses: ${u}\n`).join("")}`,
  });

  it("[X-019 AC5] a uses: pinned to a tag, a branch or a short SHA fails", () => {
    for (const ref of [
      "actions/checkout@v4 # v4",
      "actions/checkout@v4.4.0",
      "actions/checkout@main",
      "actions/checkout@11d5960 # v4.4.0",
      "actions/checkout",
      `actions/checkout@${SHA.toUpperCase()} # v4.4.0`,
    ]) {
      const { status, out } = run(workflow(ref));
      assert.equal(status, 1, `${ref}: ${out}`);
      assert.match(out, /\.github\/workflows\/ci\.yml:4: .* is not pinned to a full 40-character commit SHA/);
    }
  });

  it("[X-019 AC5] the same rule applies to every workflow file, reusable workflows and composite actions", () => {
    const deploy = run({
      ".github/workflows/deploy.yaml": "jobs:\n  b:\n    uses: owner/repo/.github/workflows/x.yml@v1\n",
    });
    assert.equal(deploy.status, 1, deploy.out);
    assert.match(
      deploy.out,
      /\.github\/workflows\/deploy\.yaml:3: "owner\/repo\/\.github\/workflows\/x\.yml@v1"/,
    );
    const action = run({
      ".github/actions/setup/action.yml":
        "runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n",
    });
    assert.equal(action.status, 1, action.out);
    assert.match(action.out, /\.github\/actions\/setup\/action\.yml:4: "actions\/cache@v4" is not pinned/);
  });

  it("[X-019 AC5] a quoted uses key is checked and a flow mapping fails", () => {
    const quoted = run({
      ".github/workflows/ci.yml": `jobs:\n  a:\n    steps:\n      - "uses": actions/checkout@v4\n`,
    });
    assert.equal(quoted.status, 1, quoted.out);
    assert.match(quoted.out, /ci\.yml:4: "actions\/checkout@v4" is not pinned/);
    for (const step of [
      `- { uses: actions/checkout@v4 }`,
      `- {name: x, "uses": "actions/checkout@${SHA}"}`,
    ]) {
      const { status, out } = run({ ".github/workflows/ci.yml": `jobs:\n  a:\n    steps:\n      ${step}\n` });
      assert.equal(status, 1, `${step}: ${out}`);
      assert.match(out, /ci\.yml:4: write "uses:" as a block mapping key/);
    }
  });

  it("[X-019 AC5] a full SHA needs the tag in a comment", () => {
    const { status, out } = run(workflow(`actions/checkout@${SHA}`));
    assert.equal(status, 1, out);
    assert.match(out, /needs the tag of that commit in a comment/);
  });

  it("[X-019 AC5] quoted SHA pins, local actions and docker digests pass; docker tags fail", () => {
    const digest = `docker://alpine@sha256:${"0".repeat(64)}`;
    const good = run(workflow(`"actions/setup-node@${SHA}" # v4.4.0`, "./.github/actions/setup", digest));
    assert.equal(good.status, 0, good.out);
    const bad = run(workflow("docker://alpine:3.20"));
    assert.equal(bad.status, 1, bad.out);
    assert.match(bad.out, /"docker:\/\/alpine:3\.20" is not pinned to an image digest/);
  });

  it("[X-019 AC5] text after the tag in the comment is a warning, not a failure", () => {
    const { status, out } = run(workflow(`pnpm/action-setup@${SHA} # v4.3.0; pnpm from packageManager`));
    assert.equal(status, 0, out);
    assert.match(
      out,
      /warning: \.github\/workflows\/ci\.yml:4: .* has text after v4\.3\.0; Dependabot updates the tag/,
    );
  });

  it("[X-019 AC5] GitHub annotations are printed inside GitHub Actions", () => {
    const dir = join(scratch, "annotations");
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(BASE["package.json"]));
    writeFileSync(
      join(dir, ".github/workflows/ci.yml"),
      "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n",
    );
    const result = spawnSync(process.execPath, [SCRIPT, "--root", dir], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "true" },
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /^::error file=\.github\/workflows\/ci\.yml,line=4::"actions\/checkout@v4" is not/m,
    );
  });

  it("[X-019 AC5] a package.json key cannot inject a workflow command into the annotations", () => {
    const dir = join(scratch, "annotations-injection");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pnpm-workspace.yaml"), BASE["pnpm-workspace.yaml"]);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        ...BASE["package.json"],
        devDependencies: { "x\n::warning::injected\r\n50%": "^1.0.0" },
      }),
    );
    const result = spawnSync(process.execPath, [SCRIPT, "--root", dir], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "true" },
    });
    assert.equal(result.status, 1, result.stdout);
    assert.doesNotMatch(result.stdout, /^::warning::injected/m);
    assert.match(
      result.stdout,
      /^::error file=package\.json::devDependencies "x%0A::warning::injected%0D%0A50%25": "\^1\.0\.0" is a/m,
    );
  });
});

describe("this repository", () => {
  it("[X-019 AC2] [X-019 AC5] passes check-package-json", () => {
    const { status, out } = check(ROOT);
    assert.equal(status, 0, out);
    assert.match(out, /0 problem\(s\)/);
  });
});
