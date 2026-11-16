// Unit tests of unit-node-options.mjs (X-050; ADR-0029 item 5): each app unit's NODE_OPTIONS read as systemd reads it,
// the young generation pinned in one quoted assignment, and V8's heap limit with those flags (old + 3 x semi MiB) below
// the unit's MemoryMax. CI's build-test job runs them with the tools/ci tests. Run: node --test tools/perf/*.test.mjs
// (plain Node, no install). That the units give these values to the real processes under systemd is the units smoke
// test's part ([X-050 AC2], deploy/systemd/test/units-smoke.sh).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MIB,
  checkAppUnit,
  nodeOptionsFlags,
  parseUnitMemoryMax,
  parseUnitNodeOptions,
  splitWords,
  unitEnvironment,
  unitNodeOptions,
} from "./unit-node-options.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./unit-node-options.mjs", import.meta.url));
const UNITS = join(ROOT, "deploy/systemd");
const unitPath = (name) => join(UNITS, `${name}.service`);

// The seven app units and their pinned values (ADR-0029 item 5, decision D3; the OTA API's 32 is lead decision (11h)).
// A value changes only with a measurement and a lead decision: this table changes with it.
const APP_UNITS = Object.freeze({
  "velexis-platform-api": { oldMiB: 640, semiMiB: 16, heapLimitMiB: 688, memoryMaxMiB: 768 },
  "velexis-platform-worker": { oldMiB: 400, semiMiB: 1, heapLimitMiB: 403, memoryMaxMiB: 512 },
  "velexis-portal": { oldMiB: 384, semiMiB: 1, heapLimitMiB: 387, memoryMaxMiB: 512 },
  "velexis-platform-admin": { oldMiB: 384, semiMiB: 1, heapLimitMiB: 387, memoryMaxMiB: 512 },
  "velexis-ota-api": { oldMiB: 640, semiMiB: 32, heapLimitMiB: 736, memoryMaxMiB: 768 },
  "velexis-ota-worker": { oldMiB: 400, semiMiB: 1, heapLimitMiB: 403, memoryMaxMiB: 512 },
  "velexis-ota-admin": { oldMiB: 384, semiMiB: 1, heapLimitMiB: 387, memoryMaxMiB: 512 },
});

/** A unit file's text with the `Environment="NODE_OPTIONS=…"` line replaced by `line` (the platform API's by default). */
function scratchUnit(line, name = "velexis-platform-api") {
  const text = readFileSync(unitPath(name), "utf8");
  const quoted = /^Environment="NODE_OPTIONS=[^"\n]*"$/m;
  assert.match(text, quoted, `${name} has its quoted NODE_OPTIONS line`);
  return text.replace(quoted, line);
}

let scratchDir;
before(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "unit-node-options-"));
});
after(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("the seven app units", () => {
  it("[X-050 AC1] every app unit's NODE_OPTIONS is one quoted assignment that pins both generations, and old + 3 x semi is below MemoryMax", () => {
    for (const [name, want] of Object.entries(APP_UNITS)) {
      const file = unitPath(name);
      const checked = checkAppUnit(readFileSync(file, "utf8"), file);
      assert.deepEqual(
        {
          oldMiB: checked.oldMiB,
          semiMiB: checked.semiMiB,
          heapLimitMiB: checked.heapLimitMiB,
          memoryMaxMiB: checked.memoryMaxBytes / MIB,
        },
        want,
        name,
      );
      assert.ok(
        checked.heapLimitMiB < want.memoryMaxMiB,
        `${name}: ${checked.heapLimitMiB} < ${want.memoryMaxMiB}`,
      );
      assert.deepEqual(
        unitNodeOptions(file),
        [`--max-old-space-size=${want.oldMiB}`, `--max-semi-space-size=${want.semiMiB}`],
        name,
      );
    }
  });

  it("[X-050 AC1] the app units are exactly the units that run node", () => {
    const nodeUnits = readdirSync(UNITS)
      .filter((f) => f.endsWith(".service"))
      .filter((f) => /^ExecStart=\/usr\/bin\/node /m.test(readFileSync(join(UNITS, f), "utf8")))
      .map((f) => f.replace(/\.service$/, ""))
      .sort();
    assert.deepEqual(nodeUnits, Object.keys(APP_UNITS).sort());
  });

  it("[X-050 AC1] no env file of deploy/env/ or provision-vm.sh sets NODE_OPTIONS (EnvironmentFile= would override the unit's)", () => {
    for (const f of readdirSync(join(ROOT, "deploy/env")).filter((name) => name.endsWith(".env.example"))) {
      assert.doesNotMatch(readFileSync(join(ROOT, "deploy/env", f), "utf8"), /^\s*NODE_OPTIONS\s*=/m, f);
    }
    assert.doesNotMatch(readFileSync(join(ROOT, "deploy/scripts/provision-vm.sh"), "utf8"), /NODE_OPTIONS/);
  });
});

describe("a unit whose NODE_OPTIONS line is not one quoted assignment", () => {
  it("[X-050 AC1] a scratch unit whose line is unquoted fails with the file and the line", () => {
    const file = join(scratchDir, "velexis-platform-api.service");
    const text = scratchUnit("Environment=NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=16");
    writeFileSync(file, text);
    const line = text.split("\n").findIndex((l) => l.startsWith("Environment=NODE_OPTIONS=")) + 1;
    const named = (error) =>
      error.message.startsWith(`${file}:${line}: systemd ignores the word "--max-semi-space-size=16" `);
    assert.throws(() => checkAppUnit(text, file), named);
    assert.throws(() => unitNodeOptions(file), named);
    // What systemd itself keeps of that line: the first word only (the second flag is gone).
    const { variables, ignored } = unitEnvironment(text, file);
    assert.equal(variables.get("NODE_OPTIONS").value, "--max-old-space-size=640");
    assert.deepEqual(ignored, [{ line, word: "--max-semi-space-size=16" }]);
  });

  it("[X-050 AC1] quotes around the value only, a second assignment on the line or a missing flag fail with the file and the line", () => {
    const cases = [
      [
        'Environment=NODE_OPTIONS="--max-old-space-size=640 --max-semi-space-size=16"',
        /one quoted assignment/,
      ],
      [
        'Environment="NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=16" TZ=UTC',
        /one quoted assignment/,
      ],
      ["Environment=NODE_OPTIONS=--max-old-space-size=640", /one quoted assignment/],
      ['Environment="NODE_OPTIONS=--max-old-space-size=640"', /sets no --max-semi-space-size/],
      ['Environment="NODE_OPTIONS=--max-semi-space-size=16"', /sets no --max-old-space-size/],
      [
        'Environment="NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=64"',
        /832 MiB is not below/,
      ],
      ['Environment="NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=1.5"', /not a whole number/],
      // V8 reads 0 as "not set" and sizes that generation itself.
      [
        'Environment="NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=0"',
        /sets no --max-semi-space-size/,
      ],
      [
        'Environment="NODE_OPTIONS=--max-old-space-size=0 --max-semi-space-size=16"',
        /sets no --max-old-space-size/,
      ],
      // Valid for systemd, but not the line units-smoke.sh reads (sed and a bash pattern over the physical line).
      [
        '  Environment="NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=16"',
        /one quoted assignment on its own line/,
      ],
      [
        'Environment = "NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=16"',
        /one quoted assignment on its own line/,
      ],
      [
        'Environment="NODE_OPTIONS=--max-old-space-size=640 \\\n  --max-semi-space-size=16"',
        /one quoted assignment on its own line/,
      ],
    ];
    for (const [nodeOptionsLine, problem] of cases) {
      const text = scratchUnit(nodeOptionsLine);
      const line = text.split("\n").indexOf(nodeOptionsLine.split("\n")[0]) + 1;
      assert.ok(line > 0);
      assert.throws(
        () => checkAppUnit(text, "scratch.service"),
        (error) => error.message.startsWith(`scratch.service:${line}: `) && problem.test(error.message),
        nodeOptionsLine,
      );
    }
    // The heap limit must stay below MemoryMax, not reach it: 384 + 3 x 1 = 387 MiB against MemoryMax=387M.
    const atLimit = readFileSync(unitPath("velexis-portal"), "utf8").replace(
      /^MemoryMax=.*$/m,
      "MemoryMax=387M",
    );
    assert.throws(
      () => checkAppUnit(atLimit, "scratch.service"),
      /387 MiB is not below MemoryMax \(387 MiB\)/,
    );
    const none = readFileSync(unitPath("velexis-portal"), "utf8").replace(
      /^Environment="NODE_OPTIONS=.*$/m,
      "",
    );
    assert.throws(() => checkAppUnit(none, "scratch.service"), {
      message: "scratch.service: no Environment= line of [Service] sets NODE_OPTIONS",
    });
    const noLimit = readFileSync(unitPath("velexis-portal"), "utf8").replace(/^MemoryMax=.*$/m, "");
    assert.throws(() => checkAppUnit(noLimit, "scratch.service"), {
      message: "scratch.service: the unit sets no MemoryMax in [Service]",
    });
  });
});

describe("reading Environment= as systemd does", () => {
  const service = (...lines) =>
    ["[Unit]", "Description=x", "[Service]", ...lines, "[Install]", ""].join("\n");

  it("splits at unquoted whitespace, keeps quoted parts in one word wherever the quotes are, and ignores words that are no assignment", () => {
    assert.deepEqual(splitWords(`"A=1 2" B=3 'C=4 5' D="6 7"x`), [
      { word: "A=1 2", quoted: true },
      { word: "B=3", quoted: false },
      { word: "C=4 5", quoted: true },
      { word: "D=6 7x", quoted: true },
    ]);
    const { variables, ignored } = unitEnvironment(service('Environment="A=1 2" B=3 -x 9=no =empty'));
    assert.deepEqual([...variables.keys()], ["A", "B"]);
    assert.equal(variables.get("A").value, "1 2");
    assert.deepEqual(
      ignored.map(({ word }) => word),
      ["-x", "9=no", "=empty"],
    );
  });

  it("lets the last assignment win, resets on an empty Environment= and reads only [Service]", () => {
    const text = [
      "[Unit]",
      "Environment=NODE_OPTIONS=--unit-section",
      "[Service]",
      "Environment=NODE_OPTIONS=--first",
      "Environment=A=1",
      "Environment=",
      "Environment=NODE_OPTIONS=--second",
      "Environment=NODE_OPTIONS=--third",
      "[Install]",
      "Environment=NODE_OPTIONS=--install-section",
    ].join("\n");
    const { variables } = unitEnvironment(text);
    assert.deepEqual([...variables.keys()], ["NODE_OPTIONS"]);
    assert.deepEqual(parseUnitNodeOptions(text), {
      value: "--third",
      line: 8,
      quoted: false,
      raw: "NODE_OPTIONS=--third",
      flags: ["--third"],
    });
  });

  it("skips comments, joins continued lines and reads %% as %", () => {
    const text = service(
      "# Environment=NODE_OPTIONS=--commented",
      "; Environment=NODE_OPTIONS=--commented-too",
      'Environment="NODE_OPTIONS=--a=1 \\',
      "# a comment inside the continuation is skipped",
      '  --b=100%%"',
    );
    assert.deepEqual(parseUnitNodeOptions(text).flags, ["--a=1", "--b=100%"]);
    assert.equal(parseUnitNodeOptions(text).line, 6);
  });

  it("refuses what it does not model, with the file and the line", () => {
    for (const [line, problem] of [
      ['Environment="NODE_OPTIONS=--a', /unterminated " quote/],
      ["Environment=NODE_OPTIONS=--a\\x20--b", /backslash escape/],
      ["Environment=NODE_OPTIONS=--title=%n", /specifier other than %%/],
    ]) {
      assert.throws(
        () => parseUnitNodeOptions(service(line), "u.service"),
        (error) => error.message.startsWith("u.service:4: ") && problem.test(error.message),
        line,
      );
    }
  });

  it("splits NODE_OPTIONS as Node does: at spaces, a double-quoted part kept together", () => {
    assert.deepEqual(nodeOptionsFlags("  --a=1   --b=2 "), ["--a=1", "--b=2"]);
    assert.deepEqual(nodeOptionsFlags('--title="x y" "--c=\\"q\\""'), ["--title=x y", '--c="q"']);
    assert.deepEqual(nodeOptionsFlags('"" --d'), ["--d"]);
    assert.throws(() => nodeOptionsFlags('--a="x'), /unterminated "/);
  });

  it("reads MemoryMax in bytes, base 1024", () => {
    const memoryMax = (value) => parseUnitMemoryMax(service(`MemoryMax=${value}`), "u.service");
    assert.equal(memoryMax("768M"), 768 * MIB);
    assert.equal(memoryMax("512M"), 512 * MIB);
    assert.equal(memoryMax("1G"), 1024 * MIB);
    assert.equal(memoryMax("4096"), 4096);
    assert.equal(memoryMax("infinity"), null);
    assert.equal(parseUnitMemoryMax(service()), null);
    assert.equal(
      parseUnitMemoryMax(service("MemoryMax=1G", "MemoryMax=512M")),
      512 * MIB,
      "the last one counts",
    );
    assert.throws(() => memoryMax("50%"), {
      message: "u.service:4: MemoryMax=50% is not a size this reader models",
    });
  });
});

describe("the script", () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });

  it("[X-050 AC1] prints a unit's flags on one line for the shell, and exits 1 with the file and the line for an unquoted unit", () => {
    const ok = run("deploy/systemd/velexis-platform-api.service");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, "--max-old-space-size=640 --max-semi-space-size=16\n");
    assert.equal(ok.stderr, "");

    const file = join(scratchDir, "unquoted.service");
    writeFileSync(
      file,
      scratchUnit("Environment=NODE_OPTIONS=--max-old-space-size=400 --max-semi-space-size=1"),
    );
    const bad = run(file);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    assert.match(
      bad.stderr,
      /^unit-node-options: .*unquoted\.service:\d+: systemd ignores the word "--max-semi/,
    );

    // A flag that Node's splitting at spaces would not give back the same is refused rather than printed.
    const spaced = join(scratchDir, "spaced.service");
    writeFileSync(spaced, scratchUnit(`Environment='NODE_OPTIONS=--max-old-space-size=640 --title="a b"'`));
    const refused = run(spaced);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /the flag "--title=a b" would not survive Node's splitting at spaces/);

    const usage = run();
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^usage: /);
  });
});

describe("V8 with each unit's flags", () => {
  // A flag given twice, the second time with underscores: V8 takes the last value and reads `_` as `-`.
  const REPEATED = "--max-old-space-size=100 --max_old_space_size=640 --max-semi-space-size=16";
  // Budget: one short `node -p` per app unit and one for REPEATED, about 50 ms each (eight in all), run once before
  // the tests.
  const reported = new Map();
  const heapLimitWith = (nodeOptions) => {
    const probe = spawnSync(
      process.execPath,
      ["-p", "require('node:v8').getHeapStatistics().heap_size_limit"],
      {
        env: { PATH: process.env.PATH, NODE_OPTIONS: nodeOptions },
        encoding: "utf8",
      },
    );
    return probe.status === 0 ? Number(probe.stdout) : probe.stderr;
  };
  before(() => {
    for (const name of Object.keys(APP_UNITS)) {
      reported.set(name, heapLimitWith(unitNodeOptions(unitPath(name)).join(" ")));
    }
    reported.set(REPEATED, heapLimitWith(REPEATED));
  });

  it("[X-050 AC1] reads a repeated flag as V8 does: the last value counts, and `_` is `-`", () => {
    const checked = checkAppUnit(scratchUnit(`Environment="NODE_OPTIONS=${REPEATED}"`), "scratch.service");
    assert.equal(checked.oldMiB, 640);
    assert.equal(checked.heapLimitMiB, 688);
    assert.equal(reported.get(REPEATED), checked.heapLimitMiB * MIB);
  });

  it(`[X-050 AC1] this Node (${process.version}) reports old + 3 x semi as the heap limit for every unit's flags`, () => {
    for (const [name, want] of Object.entries(APP_UNITS)) {
      assert.equal(reported.get(name), want.heapLimitMiB * MIB, name);
    }
  });
});
