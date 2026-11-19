// The Node.js major kept in step everywhere (task X-047, ADR-0029 item 2). Run: node --test tools/ci/*.test.mjs
// (ci.yml's build-test job runs every test of this folder, so this guard needs no workflow change).
//
// .nvmrc holds the major (one integer, nothing else) and is the source. Every other copy must name the same major:
// the root engines.node (>=N <N+1), provision-vm.sh's NODE_MAJOR default, the default of check-vm.sh's Node item,
// check-vm.test.sh's healthy fixture (its `node --version` and its node_N.x source line), every @types/node declared in
// a tracked package.json and every @types/node@ entry of pnpm-lock.yaml, and the nvm commands of the demo page. Every
// actions/setup-node step of .github/workflows/*.yml reads `node-version-file: .nvmrc` and sets no `node-version`,
// except in the jobs of EXEMPT_JOBS. Each failure names the file, the line and both majors. Without this test a
// mismatch shows only on the VM, when velexis-deploy refuses a release built on another major.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWorkflow, scalar, withOf } from "./workflow-reader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Jobs (by job id, in any workflow) whose actions/setup-node step may set its own `node-version`. Only ci.yml's
 * `sdk-node22` (SDK-019, ADR-0029 item 9): the SDK's unit and contract tests on Node.js 22.12.0, the oldest Node.js
 * the SDK supports, until Node 22's end of life on 2027-04-30, when a task removes the job and this entry. An entry
 * that names no job with an actions/setup-node step fails, so the list cannot outlive its job.
 */
const EXEMPT_JOBS = ["sdk-node22"];

const NVMRC = ".nvmrc";
const PROVISION = "deploy/scripts/provision-vm.sh";
const CHECK_VM = "deploy/scripts/check-vm.sh";
const CHECK_VM_TEST = "deploy/scripts/test/check-vm.test.sh";
const DEMO = "deploy/demo-deployment.html";
const LOCKFILE = "pnpm-lock.yaml";
const WORKFLOWS = ".github/workflows";
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** The package.json files git tracks under root (paths relative to root), the root's own first. */
function trackedPackageJsons(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--", "package.json", "**/package.json"], {
    cwd: root,
    env: GIT_ENV,
    encoding: "utf8",
  });
  return out
    .split("\0")
    .filter((path) => path !== "")
    .sort((a, b) => (a === "package.json" ? -1 : b === "package.json" ? 1 : a.localeCompare(b)));
}

/** Every line (1-based) of text whose content matches re (global), with the first group of each match. */
function matches(text, re) {
  const found = [];
  text.split("\n").forEach((content, i) => {
    for (const m of content.matchAll(re)) {
      found.push({ line: i + 1, value: m[1], content });
    }
  });
  return found;
}

/** The workflow steps that use actions/setup-node: their job, first line (1-based) and `with:` inputs. */
function setupNodeSteps(text) {
  const lines = text.split("\n");
  const steps = [];
  let cursor = 0;
  for (const [job, { steps: jobSteps }] of parseWorkflow(text)) {
    for (const step of jobSteps) {
      // workflow-reader.mjs gives a step's lines as written, with the first line's "- " turned into two spaces.
      const first = `      - ${step.raw[0].slice(8)}`;
      const at = lines.findIndex(
        (line, i) =>
          i >= cursor && line === first && step.raw.slice(1).every((raw, k) => lines[i + 1 + k] === raw),
      );
      if (at < 0) {
        throw new Error(`workflow-reader.mjs gave a step of the job ${job} that is not in the text`);
      }
      cursor = at + 1;
      if (!(step.uses ?? "").startsWith("actions/setup-node@")) {
        continue;
      }
      const inputs = {};
      for (const input of withOf(step)) {
        const m = input.match(/^([\w-]+):(?:\s+(.*))?$/);
        if (m) {
          inputs[m[1]] = {
            value: scalar(m[2] ?? ""),
            line: at + 1 + step.raw.findIndex((raw) => raw.trim() === input),
          };
        }
      }
      steps.push({ job, line: at + 1, inputs });
    }
  }
  return steps;
}

/**
 * The places under root that name a Node.js major other than .nvmrc's, and the copies it cannot find.
 * Returns { major, problems: [{ file, line, message }] } (line 0 when the problem has no line).
 */
function majorProblems(root, { exemptJobs = EXEMPT_JOBS } = {}) {
  const problems = [];
  const read = (file) => readFileSync(join(root, file), "utf8");
  const nvmrc = read(NVMRC);
  const m = nvmrc.match(/^([1-9][0-9]*)\n?$/);
  if (!m) {
    problems.push({
      file: NVMRC,
      line: 1,
      message: `holds ${JSON.stringify(nvmrc)}, not one major (an integer and nothing else, as ADR-0029 item 1 says)`,
    });
    return { major: null, problems };
  }
  const major = Number(m[1]);
  /** One problem per copy whose major differs; `missing` when the file holds no copy at all. */
  const compare = (file, what, found, missing) => {
    if (found.length === 0 && missing) {
      problems.push({ file, line: 0, message: `${missing}: this test would check nothing there` });
    }
    for (const { line, value } of found) {
      if (Number(value) !== major) {
        problems.push({ file, line, message: `${what} names Node.js ${value}, .nvmrc names ${major}` });
      }
    }
  };

  // The root engines.node: exactly ">=N <N+1" (ADR-0002 item 1).
  const rootJson = read("package.json");
  const engines = JSON.parse(rootJson).engines?.node;
  const enginesLine = rootJson.split("\n").findIndex((line) => /^\s*"node":\s*"/.test(line)) + 1;
  const range = /^>=([0-9]+) <([0-9]+)$/.exec(engines ?? "");
  if (!range || Number(range[2]) !== Number(range[1]) + 1) {
    problems.push({
      file: "package.json",
      line: enginesLine,
      message: `engines.node is ${JSON.stringify(engines ?? null)}, not ">=${major} <${major + 1}"`,
    });
  } else {
    compare("package.json", `engines.node "${engines}"`, [{ line: enginesLine, value: range[1] }]);
  }

  compare(
    PROVISION,
    "the NODE_MAJOR default",
    matches(read(PROVISION), /^: "\$\{NODE_MAJOR:=([0-9]+)\}"/g),
    'no NODE_MAJOR default (: "${NODE_MAJOR:=<major>}")',
  );
  compare(
    CHECK_VM,
    "the Node item's default (${NODE_MAJOR:-<major>})",
    matches(read(CHECK_VM), /\$\{NODE_MAJOR:[-=]([0-9]+)\}/g),
    "no default of NODE_MAJOR (${NODE_MAJOR:-<major>}) in the Node item",
  );
  const checkTest = read(CHECK_VM_TEST);
  compare(
    CHECK_VM_TEST,
    "the healthy fixture's node --version",
    matches(checkTest, /\bv([0-9]+)\.[0-9]+\.[0-9]+\b.*\bnode-version\b/g),
    'no node --version fixture (echo v<major>.<minor>.<patch> >"$FAKE/node-version")',
  );
  compare(
    CHECK_VM_TEST,
    "the NodeSource source line",
    matches(checkTest, /\bnode_([0-9]+)\.x\b/g),
    "no NodeSource source line (node_<major>.x)",
  );

  // @types/node in every tracked package.json: the line of each declaration, checked against the parsed file so
  // that no declaration escapes the line search.
  let typesDeclared = 0;
  for (const file of trackedPackageJsons(root)) {
    const text = read(file);
    const json = JSON.parse(text);
    const declared = DEPENDENCY_FIELDS.filter((field) => json[field]?.["@types/node"] !== undefined).length;
    const lines = matches(text, /"@types\/node":\s*"([^"]*)"/g);
    typesDeclared += declared;
    if (lines.length !== declared) {
      problems.push({
        file,
        line: lines[0]?.line ?? 0,
        message: `declares @types/node ${declared} time(s) in its dependency fields, but ${lines.length} line(s) hold "@types/node": "<version>"`,
      });
    }
    for (const { line, value } of lines) {
      const version = /^([0-9]+)\.[0-9]+\.[0-9]+$/.exec(value);
      if (!version) {
        problems.push({ file, line, message: `@types/node is "${value}", not an exact version` });
      } else {
        compare(file, `@types/node ${value}`, [{ line, value: version[1] }]);
      }
    }
  }
  if (typesDeclared === 0) {
    problems.push({
      file: "package.json",
      line: 0,
      message: "no tracked package.json declares @types/node: this test would check nothing",
    });
  }
  compare(
    LOCKFILE,
    "an @types/node@ entry",
    matches(read(LOCKFILE), /@types\/node@([0-9]+)\./g).filter(
      // One problem per line and major: a line can hold the same entry several times as a peer suffix.
      (hit, i, all) => all.findIndex((other) => other.line === hit.line && other.value === hit.value) === i,
    ),
    typesDeclared > 0 ? "no @types/node@ entry" : undefined,
  );
  compare(DEMO, "an nvm command", matches(read(DEMO), /\bnvm (?:install|use|alias default) ([0-9]+)\b/g));

  // Every actions/setup-node step reads .nvmrc, except those of the exempt jobs.
  const stepsOfJob = new Map();
  const workflows = readdirSync(join(root, WORKFLOWS)).filter((name) => /\.ya?ml$/.test(name));
  for (const name of workflows.sort()) {
    const file = `${WORKFLOWS}/${name}`;
    const text = read(file);
    const steps = setupNodeSteps(text);
    const uses = text
      .split("\n")
      .filter((line) => !/^\s*#/.test(line) && line.includes("actions/setup-node@")).length;
    if (uses !== steps.length) {
      problems.push({
        file,
        line: 0,
        message: `uses actions/setup-node ${uses} time(s), but ${steps.length} of them are steps this test can read`,
      });
    }
    for (const { job, line, inputs } of steps) {
      stepsOfJob.set(job, (stepsOfJob.get(job) ?? 0) + 1);
      if (exemptJobs.includes(job)) {
        continue;
      }
      if (inputs["node-version"]) {
        problems.push({
          file,
          line: inputs["node-version"].line,
          message: `the job ${job} sets node-version: ${inputs["node-version"].value} (Node.js ${String(inputs["node-version"].value).split(".")[0]}); .nvmrc names ${major}, and only the jobs of EXEMPT_JOBS may set their own`,
        });
      }
      if (inputs["node-version-file"]?.value !== NVMRC) {
        problems.push({
          file,
          line: inputs["node-version-file"]?.line ?? line,
          message: `the job ${job}'s actions/setup-node step reads ${inputs["node-version-file"] ? `node-version-file: ${inputs["node-version-file"].value}` : "no node-version-file"}, not node-version-file: .nvmrc (Node.js ${major})`,
        });
      }
    }
  }
  for (const job of exemptJobs) {
    if (!stepsOfJob.has(job)) {
      problems.push({
        file: WORKFLOWS,
        line: 0,
        message: `EXEMPT_JOBS names ${job}, which no workflow runs actions/setup-node in`,
      });
    }
  }
  return { major, problems };
}

const format = ({ file, line, message }) => `${file}${line > 0 ? `:${line}` : ""}: ${message}`;

// ---- Scratch copies of the repository ------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "x047-node-major-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Every file majorProblems reads, as git tracks it in this repository. */
const GUARDED = [
  NVMRC,
  LOCKFILE,
  PROVISION,
  CHECK_VM,
  CHECK_VM_TEST,
  DEMO,
  ...trackedPackageJsons(ROOT),
  ...readdirSync(join(ROOT, WORKFLOWS)).map((name) => `${WORKFLOWS}/${name}`),
];

let count = 0;
/** A git repository with a copy of every guarded file, then `files` written over it (null removes one). */
function scratchCopy(files = {}) {
  const dir = join(scratch, `repo-${(count += 1)}`);
  for (const file of GUARDED) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(dir, file));
  }
  for (const [file, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(dir, file));
    } else {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
  }
  execFileSync("git", ["init", "-q"], { cwd: dir, env: GIT_ENV });
  execFileSync("git", ["add", "-A"], { cwd: dir, env: GIT_ENV });
  return dir;
}

/** Lines (1-based) of a file of this repository that include every one of the strings. */
function linesWith(file, ...strings) {
  return readFileSync(join(ROOT, file), "utf8")
    .split("\n")
    .flatMap((line, i) => (strings.every((s) => line.includes(s)) ? [i + 1] : []));
}

const MAJOR = Number(readFileSync(join(ROOT, NVMRC), "utf8").trim());
const OTHER = MAJOR + 2;

const SCRATCH_WORKFLOW = (inputs) =>
  [
    "name: scratch",
    "on: workflow_dispatch",
    "jobs:",
    "  scratch-job:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0",
    "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0",
    "        with:",
    ...inputs.map((input) => `          ${input}`),
    "      - run: node --version",
    "",
  ].join("\n");

// ---- Tests -------------------------------------------------------------------------------------------------------

describe("the Node.js major of .nvmrc", () => {
  it("[X-047 AC1] engines, NODE_MAJOR, check-vm.sh and its fixture, every @types/node, the lockfile, the demo page and every setup-node step agree with .nvmrc", () => {
    const { major, problems } = majorProblems(ROOT);
    assert.deepEqual(problems.map(format), []);
    assert.equal(major, MAJOR);
  });

  it("[X-047 AC1] a copy whose .nvmrc names another major fails, naming each file, line and both majors", () => {
    const { problems } = majorProblems(scratchCopy({ [NVMRC]: `${OTHER}\n` }));
    // Where each copy of the major is, found here by plain text search, independently of the guard's patterns.
    const expected = [
      ...linesWith("package.json", '"node": ">=').map((line) => `package.json:${line}`),
      ...linesWith(PROVISION, ': "${NODE_MAJOR:=').map((line) => `${PROVISION}:${line}`),
      ...linesWith(CHECK_VM, "${NODE_MAJOR:-").map((line) => `${CHECK_VM}:${line}`),
      ...linesWith(CHECK_VM_TEST, `echo v${MAJOR}.`, "node-version").map(
        (line) => `${CHECK_VM_TEST}:${line}`,
      ),
      ...linesWith(CHECK_VM_TEST, `node_${MAJOR}.x`).map((line) => `${CHECK_VM_TEST}:${line}`),
      ...trackedPackageJsons(ROOT).flatMap((file) =>
        linesWith(file, '"@types/node"').map((line) => `${file}:${line}`),
      ),
      ...linesWith(LOCKFILE, "@types/node@").map((line) => `${LOCKFILE}:${line}`),
      ...["nvm install ", "nvm use ", "nvm alias default "].flatMap((command) =>
        linesWith(DEMO, `${command}${MAJOR}`).map((line) => `${DEMO}:${line}`),
      ),
    ];
    const named = problems.map(({ file, line }) => `${file}:${line}`);
    assert.deepEqual([...new Set(named)].sort(), [...new Set(expected)].sort());
    for (const file of [
      "package.json",
      PROVISION,
      CHECK_VM,
      CHECK_VM_TEST,
      LOCKFILE,
      DEMO,
      "ota/backend/package.json",
    ]) {
      assert.ok(
        named.some((at) => at.startsWith(`${file}:`)),
        `a problem names ${file}`,
      );
    }
    for (const problem of problems) {
      assert.match(problem.message, new RegExp(`names Node\\.js ${MAJOR}, \\.nvmrc names ${OTHER}$`));
    }
    // Every workflow reads .nvmrc, so none of them is named.
    assert.ok(!named.some((at) => at.startsWith(`${WORKFLOWS}/`)), named.join("\n"));
  });

  it("[X-047 AC1] .nvmrc holds one major and nothing else", () => {
    for (const content of [
      `v${MAJOR}\n`,
      `${MAJOR}.12.0\n`,
      "lts/*\n",
      `${MAJOR}\n${MAJOR}\n`,
      `${MAJOR} \n`,
      "",
    ]) {
      const { problems } = majorProblems(scratchCopy({ [NVMRC]: content }));
      assert.deepEqual(problems.map(format), [
        `.nvmrc:1: holds ${JSON.stringify(content)}, not one major (an integer and nothing else, as ADR-0029 item 1 says)`,
      ]);
    }
  });

  it("[X-047 AC1] engines.node must be >=N <N+1 of .nvmrc's major", () => {
    const rootJson = readFileSync(join(ROOT, "package.json"), "utf8");
    const line = linesWith("package.json", '"node": ">=')[0];
    for (const engines of [
      `>=${OTHER} <${OTHER + 1}`,
      `>=${MAJOR}`,
      `>=${MAJOR} <${MAJOR + 2}`,
      `^${MAJOR}.0.0`,
    ]) {
      const changed = rootJson.replace(/"node": "[^"]*"/, `"node": "${engines}"`);
      const { problems } = majorProblems(scratchCopy({ "package.json": changed }));
      assert.equal(problems.length, 1, problems.map(format).join("\n"));
      assert.equal(problems[0].file, "package.json");
      assert.equal(problems[0].line, line);
    }
  });

  it("[X-047 AC1] a copy without one of the guarded places fails instead of checking nothing", () => {
    const without = (file, re) => readFileSync(join(ROOT, file), "utf8").replace(re, "");
    for (const [file, re, wanted] of [
      [PROVISION, /^: "\$\{NODE_MAJOR:=[0-9]+\}".*\n/m, "no NODE_MAJOR default"],
      [CHECK_VM, /\$\{NODE_MAJOR:-[0-9]+\}/g, "no default of NODE_MAJOR"],
      [CHECK_VM_TEST, /^.*\bnode-version"$/gm, "no node --version fixture"],
      [CHECK_VM_TEST, /node_[0-9]+\.x/g, "no NodeSource source line"],
    ]) {
      const { problems } = majorProblems(scratchCopy({ [file]: without(file, re) }));
      assert.ok(
        problems.some((p) => p.file === file && p.message.startsWith(wanted)),
        `${file} without its copy: ${problems.map(format).join("\n")}`,
      );
    }
  });

  it("[X-047 AC1] a scratch workflow with a node-version: line fails, naming its file and line", () => {
    const { problems } = majorProblems(
      scratchCopy({
        [`${WORKFLOWS}/scratch.yml`]: SCRATCH_WORKFLOW([`node-version: ${OTHER}.1.0`, "cache: pnpm"]),
      }),
    );
    assert.deepEqual(problems.map(format), [
      `${WORKFLOWS}/scratch.yml:10: the job scratch-job sets node-version: ${OTHER}.1.0 (Node.js ${OTHER}); .nvmrc names ${MAJOR}, and only the jobs of EXEMPT_JOBS may set their own`,
      `${WORKFLOWS}/scratch.yml:8: the job scratch-job's actions/setup-node step reads no node-version-file, not node-version-file: .nvmrc (Node.js ${MAJOR})`,
    ]);
    // node-version beside node-version-file fails too: the action would take node-version.
    const both = majorProblems(
      scratchCopy({
        [`${WORKFLOWS}/scratch.yml`]: SCRATCH_WORKFLOW([
          "node-version-file: .nvmrc",
          `node-version: ${MAJOR}`,
        ]),
      }),
    );
    assert.deepEqual(both.problems.map(format), [
      `${WORKFLOWS}/scratch.yml:11: the job scratch-job sets node-version: ${MAJOR} (Node.js ${MAJOR}); .nvmrc names ${MAJOR}, and only the jobs of EXEMPT_JOBS may set their own`,
    ]);
  });

  it("[X-047 AC1] every setup-node step reads node-version-file: .nvmrc, comments and other inputs aside", () => {
    const ok = majorProblems(
      scratchCopy({
        [`${WORKFLOWS}/scratch.yml`]: SCRATCH_WORKFLOW([
          "# a comment",
          "node-version-file: .nvmrc # the major",
          "cache: pnpm",
        ]),
      }),
    );
    assert.deepEqual(ok.problems.map(format), []);
    for (const [inputs, found] of [
      [["node-version-file: package.json"], "node-version-file: package.json"],
      [["node-version-file: ./.nvmrc"], "node-version-file: ./.nvmrc"],
      [["cache: pnpm"], "no node-version-file"],
    ]) {
      const { problems } = majorProblems(
        scratchCopy({ [`${WORKFLOWS}/scratch.yml`]: SCRATCH_WORKFLOW(inputs) }),
      );
      assert.deepEqual(problems.map(format), [
        `${WORKFLOWS}/scratch.yml:${found === "no node-version-file" ? 8 : 10}: the job scratch-job's actions/setup-node step reads ${found}, not node-version-file: .nvmrc (Node.js ${MAJOR})`,
      ]);
    }
    // A step without `with:` at all, and a setup-node use this test cannot read as a step, fail too.
    const bare = SCRATCH_WORKFLOW([]).replace("        with:\n", "");
    assert.deepEqual(
      majorProblems(scratchCopy({ [`${WORKFLOWS}/scratch.yml`]: bare })).problems.map(format),
      [
        `${WORKFLOWS}/scratch.yml:8: the job scratch-job's actions/setup-node step reads no node-version-file, not node-version-file: .nvmrc (Node.js ${MAJOR})`,
      ],
    );
    const hidden = `${SCRATCH_WORKFLOW(["node-version-file: .nvmrc"])}env:\n  X: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\n`;
    assert.deepEqual(
      majorProblems(scratchCopy({ [`${WORKFLOWS}/scratch.yml`]: hidden })).problems.map(format),
      [
        `${WORKFLOWS}/scratch.yml: uses actions/setup-node 2 time(s), but 1 of them are steps this test can read`,
      ],
    );
  });

  it("[X-047 AC1] only a job of the exemption list may set its own node-version, and the list names real jobs", () => {
    const dir = scratchCopy({
      [`${WORKFLOWS}/scratch.yml`]: SCRATCH_WORKFLOW([`node-version: ${MAJOR - 2}.12.0`]),
    });
    assert.deepEqual(
      majorProblems(dir, { exemptJobs: ["scratch-job", ...EXEMPT_JOBS] }).problems.map(format),
      [],
    );
    assert.deepEqual(
      majorProblems(dir, { exemptJobs: ["scratch-job", ...EXEMPT_JOBS, "sdk-node20"] }).problems.map(format),
      [`${WORKFLOWS}: EXEMPT_JOBS names sdk-node20, which no workflow runs actions/setup-node in`],
    );
  });

  it("[SDK-019 AC2] the exemption list is ci.yml's sdk-node22 alone, and without it that job's node-version fails", () => {
    assert.deepEqual(EXEMPT_JOBS, ["sdk-node22"], "SDK-019's job (ADR-0029 items 2 and 9), nothing else");
    const CI = `${WORKFLOWS}/ci.yml`;
    const [line] = linesWith(CI, "node-version: 22.12.0");
    assert.ok(line > 0, "ci.yml's sdk-node22 job sets node-version: 22.12.0");
    const step = linesWith(CI, "uses: actions/setup-node@")
      .filter((at) => at < line)
      .at(-1);
    // Exempt by name only: the same repository without the entry fails on that job's step, and nowhere else.
    assert.deepEqual(majorProblems(ROOT, { exemptJobs: [] }).problems.map(format), [
      `${CI}:${line}: the job sdk-node22 sets node-version: 22.12.0 (Node.js 22); .nvmrc names ${MAJOR}, and only the jobs of EXEMPT_JOBS may set their own`,
      `${CI}:${step}: the job sdk-node22's actions/setup-node step reads no node-version-file, not node-version-file: .nvmrc (Node.js ${MAJOR})`,
    ]);
    assert.deepEqual(majorProblems(ROOT).problems.map(format), []);
  });

  it("[X-047 AC1] an @types/node or a demo-page nvm command of another major fails, naming its line", () => {
    const pkg = "packages/config/package.json";
    const pkgText = readFileSync(join(ROOT, pkg), "utf8");
    const pkgLine = linesWith(pkg, '"@types/node"')[0];
    const changed = pkgText.replace(/"@types\/node": "[0-9]+\./, `"@types/node": "${OTHER}.`);
    assert.deepEqual(majorProblems(scratchCopy({ [pkg]: changed })).problems.map(format), [
      `${pkg}:${pkgLine}: @types/node ${changed.match(/"@types\/node": "([^"]*)"/)[1]} names Node.js ${OTHER}, .nvmrc names ${MAJOR}`,
    ]);
    const range = pkgText.replace(/"@types\/node": "([^"]*)"/, '"@types/node": "^$1"');
    assert.match(
      majorProblems(scratchCopy({ [pkg]: range }))
        .problems.map(format)
        .join("\n"),
      /@types\/node is "\^/,
    );
    const demoText = readFileSync(join(ROOT, DEMO), "utf8");
    const demo = `${demoText}<!-- nvm use ${OTHER} -->\n`;
    assert.deepEqual(majorProblems(scratchCopy({ [DEMO]: demo })).problems.map(format), [
      `${DEMO}:${demoText.split("\n").length}: an nvm command names Node.js ${OTHER}, .nvmrc names ${MAJOR}`,
    ]);
  });
});

describe("the build cache and the Node.js major", () => {
  it("[X-047 AC2] turbo.json's globalDependencies include .nvmrc, so a change of the major misses every cached task", () => {
    const turbo = JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8"));
    assert.ok(turbo.globalDependencies.includes(NVMRC), JSON.stringify(turbo.globalDependencies));
  });
});
