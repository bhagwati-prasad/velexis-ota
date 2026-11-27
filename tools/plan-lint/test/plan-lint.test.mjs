// Tests of plan-lint.mjs with Node's own test runner (no dependencies): node --test tools/plan-lint/test/
// Each test runs the script as a child process, on the fixture plan (fixtures/plan.md) or on a variant of it
// written to a temporary folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.dirname(HERE);
const REPO_ROOT = path.resolve(TOOL_DIR, "..", "..");
const SCRIPT = path.join(TOOL_DIR, "plan-lint.mjs");
const FIXTURE = path.join(HERE, "fixtures", "plan.md");
const FIXTURE_TEXT = readFileSync(FIXTURE, "utf8");
const PLANS = [
  "docs/mvp/plans/foundation-tasks.md",
  "platform/docs/plans/agent-tasks.md",
  "ota/docs/plans/agent-tasks.md",
];

const tmp = mkdtempSync(path.join(tmpdir(), "velexis-plan-lint-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(args, script = SCRIPT) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout,
    lines: result.stdout.trimEnd().split("\n"),
    output: `${result.stdout}${result.stderr}`,
  };
}

/** Replaces one exact piece of the text and fails when it is missing: a variant never silently equals the fixture. */
function replace(text, from, to) {
  assert.ok(text.includes(from), `the fixture contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

let variants = 0;
/** Writes an edited copy of the fixture to the temporary folder and returns its absolute path. */
function variant(edit) {
  variants += 1;
  const file = path.join(tmp, `plan-${variants}.md`);
  writeFileSync(file, edit(FIXTURE_TEXT));
  return file;
}

const openX902 = (text) =>
  replace(
    replace(
      text,
      "### X-902 · Build the second fixture wall ✅",
      "### X-902 · Build the second fixture wall",
    ),
    "done (PR #2)",
    "in progress (PR #2)",
  );
const noMarkers = (text) => text.replaceAll(" ✅\n", "\n").replace(/done \(PR #\d+\)/g, "todo");
/** An open task block for the variants, with a blank line before and after it. */
const extraTask = (id, title, deps, size, milestone = "M1") =>
  [
    "",
    `### ${id} · ${title}`,
    "- **Component:** foundation",
    `- **Milestone:** ${milestone}`,
    `- **Depends on:** ${deps}`,
    `- **Size:** ${size}`,
    "- **Read first:** tools/plan-lint/README.md",
    "- **Files:** `tools/plan-lint/test/fixtures/plan.md`",
    "- **Steps:**",
    "  1. One.",
    "  2. Two.",
    "- **Acceptance:**",
    "  - Done.",
    "- **Verify:** `node --version`",
    "",
  ].join("\n");
const FIRST_BLOCK = [
  "tasks: 3  estimated hours: 14",
  'by component: {"foundation":3}',
  'by milestone: {"M0":1,"M1":2}',
  "critical path: 14h over 3 tasks: X-901 -> X-902 -> X-903",
];

describe("plan-lint.mjs", () => {
  test("[X-035 AC1] the first summary block does not change, and a plan without done markers reports 0 done", () => {
    const file = variant(noMarkers);
    const { status, lines, output } = run([file]);
    assert.equal(status, 0, output);
    assert.deepEqual(lines, [
      ...FIRST_BLOCK,
      "",
      "done tasks: 0/3  done hours: 0/14  remaining tasks: 3  remaining hours: 14",
      "done by milestone (tasks, hours): M0 0/1 0/2h, M1 0/2 0/12h",
      `done by file (tasks, hours): ${file} 0/3 0/14h`,
      "remaining critical path: 14h over 3 tasks: X-901 -> X-902 -> X-903",
      "ERRORS: 0",
    ]);
    // The done markers change only the second block.
    assert.deepEqual(run([FIXTURE]).lines.slice(0, 5), [...FIRST_BLOCK, ""]);
  });

  test("[X-035 AC1] on the current plans the first block keeps its format and the second block adds up to it", () => {
    const { status, lines, output } = run([]);
    assert.equal(status, 0, output);
    const [
      tasksLine,
      byComponent,
      byMilestone,
      criticalPath,
      blank,
      doneLine,
      doneByMilestone,
      doneByFile,
      remainingPath,
    ] = lines;
    const [, total, hours] =
      tasksLine.match(/^tasks: (\d+) {2}estimated hours: (\d+)$/) ?? assert.fail(tasksLine);
    assert.match(byComponent, /^by component: \{.+\}$/);
    assert.match(byMilestone, /^by milestone: \{"M0":\d+.*\}$/);
    assert.match(criticalPath, /^critical path: \d+h over \d+ tasks: [A-Z]+-\d{3}( -> [A-Z]+-\d{3})*$/);
    assert.equal(blank, "");
    const [, done, all, doneHours, allHours, open, openHours] =
      doneLine.match(
        /^done tasks: (\d+)\/(\d+) {2}done hours: (\d+)\/(\d+) {2}remaining tasks: (\d+) {2}remaining hours: (\d+)$/,
      ) ?? assert.fail(doneLine);
    assert.deepEqual([all, allHours], [total, hours]);
    assert.equal(Number(done) + Number(open), Number(total));
    assert.equal(Number(doneHours) + Number(openHours), Number(hours));

    // Per milestone and per file, the counts add up to the totals; per file they replace the grep count of the roadmap.
    const sums = (line) =>
      [...line.matchAll(/ (\d+)\/(\d+) (\d+)\/(\d+)h/g)].reduce(
        (s, m) => s.map((v, i) => v + Number(m[i + 1])),
        [0, 0, 0, 0],
      );
    assert.deepEqual(sums(doneByMilestone), [done, total, doneHours, hours].map(Number));
    assert.deepEqual(sums(doneByFile), [done, total, doneHours, hours].map(Number));
    for (const plan of PLANS) {
      const marked = readFileSync(path.join(REPO_ROOT, plan), "utf8")
        .split("\n")
        .filter((l) => /^### .* ✅$/.test(l)).length;
      assert.match(doneByFile, new RegExp(`${plan.replaceAll(".", "\\.")} ${marked}/\\d+ `), plan);
    }
    assert.match(
      remainingPath,
      /^remaining critical path: (\d+h over \d+ tasks: [A-Z]+-\d{3}|none, every task is done)/,
    );
    assert.equal(lines.at(-1), "ERRORS: 0");
  });

  test("[X-035 AC2] a fixture with 2 of 3 tasks done reports 1 remaining task, its hours and a critical path without the done tasks", () => {
    const { status, lines, output } = run([FIXTURE]);
    assert.equal(status, 0, output);
    assert.deepEqual(lines, [
      ...FIRST_BLOCK,
      "",
      "done tasks: 2/3  done hours: 6/14  remaining tasks: 1  remaining hours: 8",
      "done by milestone (tasks, hours): M0 1/1 2/2h, M1 1/2 4/12h",
      `done by file (tasks, hours): ${FIXTURE} 2/3 6/14h`,
      "remaining critical path: 8h over 1 tasks: X-903",
      "ERRORS: 0",
    ]);
  });

  test("[X-035 AC2] --remaining lists the open task when its dependencies are done", () => {
    const { status, lines, output } = run(["--remaining", FIXTURE]);
    assert.equal(status, 0, output);
    assert.equal(lines[0], "lowest open milestone: M1 (1 of 2 tasks open, 1 ready)");
    assert.match(lines[1], /^ready tasks \(every dependency done\), critical path first/);
    assert.equal(lines[2], `* X-903  L 8h  chain 8h  Put the third fixture roof on  (${FIXTURE})`);
    assert.deepEqual(lines.slice(3), ["ERRORS: 0"]);
  });

  test("[X-035 AC2] --remaining leaves out a task whose dependency is not done", () => {
    const file = variant(openX902);
    const remaining = run(["--remaining", file]);
    assert.equal(remaining.status, 0, remaining.output);
    assert.deepEqual(remaining.lines.slice(2), [
      `* X-902  M 4h  chain 12h  Build the second fixture wall  [in progress]  (${file})`,
      "waiting for dependencies:",
      "  X-903 waits for X-902",
      "ERRORS: 0",
    ]);
    assert.equal(remaining.lines[0], "lowest open milestone: M1 (2 of 2 tasks open, 1 ready)");

    const summary = run([file]);
    assert.equal(summary.status, 0, summary.output);
    assert.ok(
      summary.lines.includes("done tasks: 1/3  done hours: 2/14  remaining tasks: 2  remaining hours: 12"),
      summary.output,
    );
    assert.ok(
      summary.lines.includes("remaining critical path: 12h over 2 tasks: X-902 -> X-903"),
      summary.output,
    );
  });

  test("[X-035 AC2] --remaining starts at the lowest open milestone, puts the critical path first and stops when all is done", () => {
    // With no task done, the open M0 task comes before every M1 task.
    const m0 = run(["--remaining", variant(noMarkers)]);
    assert.equal(m0.status, 0, m0.output);
    assert.equal(m0.lines[0], "lowest open milestone: M0 (1 of 1 tasks open, 1 ready)");
    assert.match(m0.lines[2], /^\* X-901 {2}S 2h {2}chain 14h {2}Lay the first fixture stone {2}\(/);

    // X-904 (S) starts a longer open chain than X-903 (L), so it is listed first although it comes later in the file.
    const longer = variant(
      (text) =>
        text +
        extraTask("X-904", "Dig the fourth fixture well", "X-901", "S") +
        extraTask("X-905", "Fill the fifth fixture tank", "X-904", "L"),
    );
    const ordered = run(["--remaining", longer]);
    assert.equal(ordered.status, 0, ordered.output);
    assert.deepEqual(ordered.lines.slice(0, 1).concat(ordered.lines.slice(2)), [
      "lowest open milestone: M1 (3 of 4 tasks open, 2 ready)",
      `* X-904  S 2h  chain 10h  Dig the fourth fixture well  (${longer})`,
      `  X-903  L 8h  chain 8h  Put the third fixture roof on  (${longer})`,
      "waiting for dependencies:",
      "  X-905 waits for X-904",
      "ERRORS: 0",
    ]);
    assert.ok(run([longer]).lines.includes("remaining critical path: 10h over 2 tasks: X-904 -> X-905"));

    const allDone = variant((text) =>
      replace(
        replace(
          text,
          "### X-903 · Put the third fixture roof on",
          "### X-903 · Put the third fixture roof on ✅",
        ),
        "- **Status:** todo",
        "- **Status:** done (PR #3)",
      ),
    );
    assert.deepEqual(run(["--remaining", allDone]).lines, [
      "remaining: none, every task is done",
      "ERRORS: 0",
    ]);
    const summary = run([allDone]);
    assert.equal(summary.status, 0, summary.output);
    assert.deepEqual(summary.lines.slice(5), [
      "done tasks: 3/3  done hours: 14/14  remaining tasks: 0  remaining hours: 0",
      "done by milestone (tasks, hours): M0 1/1 2/2h, M1 2/2 12/12h",
      `done by file (tasks, hours): ${allDone} 3/3 14/14h`,
      "remaining critical path: none, every task is done",
      "ERRORS: 0",
    ]);
  });

  test("[X-035 AC2] --remaining orders the ready tasks by the critical path, then the longest open chain, then the size", () => {
    // X-905 stands before X-903 in the file, so the remaining critical path is X-904 -> X-905 (8 h): it is found
    // before X-903 (also 8 h). Each sort key decides one pair of ready tasks:
    // - critical path: X-904 (M, chain 8 h) before X-903 (L, chain 8 h), although X-903 is larger and comes first;
    // - longest chain: X-906 (S, chain 6 h) before X-910 (M, chain 4 h), although X-910 is larger;
    // - size: X-908 (M, chain 6 h) before X-906 (S, chain 6 h), although X-906 comes first.
    const file = variant(
      (text) =>
        replace(
          text,
          "### X-903 · Put the third fixture roof on",
          `${extraTask("X-905", "Raise the fifth fixture beam", "X-904", "M").slice(1)}\n### X-903 · Put the third fixture roof on`,
        ) +
        extraTask("X-904", "Set the fourth fixture post", "X-901", "M") +
        extraTask("X-906", "Lay the sixth fixture path", "X-902", "S") +
        extraTask("X-907", "Edge the seventh fixture path", "X-906", "M") +
        extraTask("X-908", "Hang the eighth fixture door", "X-902", "M") +
        extraTask("X-909", "Paint the ninth fixture door", "X-908", "S") +
        extraTask("X-910", "Fit the tenth fixture window", "X-902", "M"),
    );
    assert.ok(run([file]).lines.includes("remaining critical path: 8h over 2 tasks: X-904 -> X-905"));
    const { status, lines, output } = run(["--remaining", file]);
    assert.equal(status, 0, output);
    assert.deepEqual(lines.slice(0, 1).concat(lines.slice(2)), [
      "lowest open milestone: M1 (8 of 9 tasks open, 5 ready)",
      `* X-904  M 4h  chain 8h  Set the fourth fixture post  (${file})`,
      `  X-903  L 8h  chain 8h  Put the third fixture roof on  (${file})`,
      `  X-908  M 4h  chain 6h  Hang the eighth fixture door  (${file})`,
      `  X-906  S 2h  chain 6h  Lay the sixth fixture path  (${file})`,
      `  X-910  M 4h  chain 4h  Fit the tenth fixture window  (${file})`,
      "waiting for dependencies:",
      "  X-905 waits for X-904",
      "  X-907 waits for X-906",
      "  X-909 waits for X-908",
      "ERRORS: 0",
    ]);

    // A dependency in a later milestone that is not done: the lowest open milestone has no ready task.
    const later = variant(
      (text) =>
        replace(text, "- **Depends on:** X-902", "- **Depends on:** X-902, X-904") +
        extraTask("X-904", "Plan the fourth fixture floor", "—", "S", "M2"),
    );
    const blocked = run(["--remaining", later]);
    assert.equal(blocked.status, 0, blocked.output);
    assert.deepEqual(blocked.lines.slice(0, 1).concat(blocked.lines.slice(2)), [
      "lowest open milestone: M1 (1 of 2 tasks open, 0 ready)",
      "  none: every open task of the milestone waits for a dependency",
      "waiting for dependencies:",
      "  X-903 waits for X-904",
      "ERRORS: 0",
    ]);
  });

  test("[X-035 AC3] a heading with ✅ and no done (PR #n) status is an error", () => {
    for (const bad of ["in progress (PR #2)", "todo", "done", "done (#2)", "done (PR #2) ✅"]) {
      const file = variant((text) => replace(text, "- **Status:** done (PR #2)", `- **Status:** ${bad}`));
      const { status, output } = run([file]);
      assert.equal(status, 1, output);
      assert.ok(
        output.includes(
          `ERRORS: 1\n  - ${file} X-902: the heading ends with " ✅" but the status is "${bad}" (expected "done (PR #n)")\n`,
        ),
        output,
      );
    }
  });

  test("[X-035 AC3] a done (PR #n) status without ✅ is an error", () => {
    const file = variant((text) =>
      replace(
        text,
        "### X-902 · Build the second fixture wall ✅",
        "### X-902 · Build the second fixture wall",
      ),
    );
    const { status, output } = run([file]);
    assert.equal(status, 1, output);
    assert.ok(
      output.includes(
        `ERRORS: 1\n  - ${file} X-902: the status is "done (PR #2)" but the heading does not end with " ✅"\n`,
      ),
      output,
    );
    // The same holds in --remaining mode, which prints the errors too.
    assert.equal(run(["--remaining", file]).status, 1);
  });

  test("[X-035 AC3] a misplaced marker is an error; ✅ without a Status line and done (branch <name>) are accepted", () => {
    const misplaced = variant((text) =>
      replace(
        text,
        "### X-903 · Put the third fixture roof on",
        "### X-903 · Put the third ✅ fixture roof on",
      ),
    );
    const bad = run([misplaced]);
    assert.equal(bad.status, 1, bad.output);
    assert.ok(
      bad.output.includes(
        `${misplaced} X-903: misplaced done marker in the heading (" ✅" goes at the very end)`,
      ),
      bad.output,
    );

    const noStatus = variant((text) => replace(text, "- **Status:** done (PR #2)\n", ""));
    const branch = variant((text) => replace(text, "done (PR #2)", "done (branch claude/integration-1)"));
    for (const file of [noStatus, branch]) {
      const { status, lines, output } = run([file]);
      assert.equal(status, 0, output);
      assert.ok(
        lines.includes("done tasks: 2/3  done hours: 6/14  remaining tasks: 1  remaining hours: 8"),
        output,
      );
    }
  });

  test("[X-035 AC4] runs with plain Node: only node: built-ins, no package.json, and a copy outside the workspace works", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    assert.deepEqual(
      imports.filter((s) => !s.startsWith("node:")),
      [],
    );
    assert.doesNotMatch(source, /\bimport\(|\brequire\(/);
    assert.equal(existsSync(path.join(TOOL_DIR, "package.json")), false);

    // A copy in an empty folder (no node_modules anywhere above it) still lints the fixture.
    const bare = mkdtempSync(path.join(tmpdir(), "velexis-plan-lint-bare-"));
    try {
      mkdirSync(path.join(bare, "tools", "plan-lint"), { recursive: true });
      copyFileSync(SCRIPT, path.join(bare, "tools", "plan-lint", "plan-lint.mjs"));
      copyFileSync(FIXTURE, path.join(bare, "plan.md"));
      const { status, lines, output } = run(
        ["plan.md"],
        path.join(bare, "tools", "plan-lint", "plan-lint.mjs"),
      );
      assert.equal(status, 0, output);
      assert.deepEqual(lines.slice(0, 4), FIRST_BLOCK);
      assert.ok(lines.includes("remaining critical path: 8h over 1 tasks: X-903"), output);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("[X-035] --help prints the usage and an unknown option exits 2", () => {
    const help = run(["--help"]);
    assert.equal(help.status, 0);
    assert.match(
      help.stdout,
      /^usage: node tools\/plan-lint\/plan-lint\.mjs \[--graph\] \[--remaining\] \[file \.\.\.\]\n$/,
    );
    const unknown = run(["--remainig", FIXTURE]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.output, /unknown option --remainig/);
  });

  test("[X-035] --graph still prints the Mermaid flowchart after the summary", () => {
    const { status, lines, output } = run(["--graph", FIXTURE]);
    assert.equal(status, 0, output);
    assert.deepEqual(lines.slice(-5), [
      "",
      "flowchart LR",
      "  X_901 --> X_902",
      "  X_902 --> X_903",
      "ERRORS: 0",
    ]);
  });

  // X-053: M7 is built before the launch, so --remaining lists its open tasks in a second block beside the lowest
  // open milestone (ADR-0025 item 3, revision of 2026-11-25).
  const LEGEND =
    "ready tasks (every dependency done), critical path first; * = on the remaining critical path, chain = hours of the longest open chain the task starts:";
  const M7_HEADING = "also open, built before the launch: M7";
  /** The fixture with X-903 done too: every task of M0 and M1 is done. */
  const allFixtureDone = (text) =>
    replace(
      replace(
        text,
        "### X-903 · Put the third fixture roof on",
        "### X-903 · Put the third fixture roof on ✅",
      ),
      "- **Status:** todo",
      "- **Status:** done (PR #3)",
    );

  test("[X-053 AC1] with open tasks in M0 and in M7, --remaining prints M0's block as today, then M7's ready and waiting tasks", () => {
    const withoutM7 = variant(noMarkers);
    const file = variant(
      (text) =>
        noMarkers(text) +
        extraTask("X-904", "Draw the fourth fixture plan", "—", "S", "M7") +
        extraTask("X-905", "Survey the fifth fixture site", "X-904", "M", "M7") +
        extraTask("X-906", "Order the sixth fixture beams", "—", "L", "M7"),
    );
    const { status, lines, output } = run(["--remaining", file]);
    assert.equal(status, 0, output);
    assert.deepEqual(lines, [
      "lowest open milestone: M0 (1 of 1 tasks open, 1 ready)",
      LEGEND,
      `* X-901  S 2h  chain 14h  Lay the first fixture stone  (${file})`,
      "",
      `${M7_HEADING} (3 of 3 tasks open, 2 ready)`,
      LEGEND,
      `  X-906  L 8h  chain 8h  Order the sixth fixture beams  (${file})`,
      `  X-904  S 2h  chain 6h  Draw the fourth fixture plan  (${file})`,
      "waiting for dependencies:",
      "  X-905 waits for X-904",
      "ERRORS: 0",
    ]);
    // The first block is what the same plan without its M7 tasks prints, line for line.
    const without = run(["--remaining", withoutM7]);
    assert.equal(without.status, 0, without.output);
    const firstBlock = without.lines.slice(0, -1).map((l) => l.replaceAll(withoutM7, file));
    assert.deepEqual(lines.slice(0, firstBlock.length), firstBlock);
    assert.equal(lines[firstBlock.length], "");
  });

  test("[X-053 AC1] the second block marks the remaining critical path and the claimed tasks as the first does", () => {
    // X-904 (M7, L, in progress) starts the longest open chain, X-904 -> X-905 (16 h), so the remaining critical path
    // runs through M7: X-904 gets the `*` and the `[in progress]` mark, and X-903 (M1, chain 8 h) has no `*`.
    const file = variant(
      (text) =>
        text +
        replace(
          extraTask("X-904", "Raise the fourth fixture tower", "—", "L", "M7"),
          "- **Component:** foundation",
          "- **Status:** in progress (PR #4)\n- **Component:** foundation",
        ) +
        extraTask("X-905", "Crown the fifth fixture tower", "X-904", "L", "M7"),
    );
    assert.ok(run([file]).lines.includes("remaining critical path: 16h over 2 tasks: X-904 -> X-905"));
    const { status, lines, output } = run(["--remaining", file]);
    assert.equal(status, 0, output);
    assert.deepEqual(lines, [
      "lowest open milestone: M1 (1 of 2 tasks open, 1 ready)",
      LEGEND,
      `  X-903  L 8h  chain 8h  Put the third fixture roof on  (${file})`,
      "",
      `${M7_HEADING} (2 of 2 tasks open, 1 ready)`,
      LEGEND,
      `* X-904  L 8h  chain 16h  Raise the fourth fixture tower  [in progress]  (${file})`,
      "waiting for dependencies:",
      "  X-905 waits for X-904",
      "ERRORS: 0",
    ]);
  });

  test("[X-053 AC2] when M7 is the lowest open milestone, has no open task or is not in the plan, the output is as before", () => {
    // Not in the plan: the fixture prints one block, byte for byte.
    const fixture = run(["--remaining", FIXTURE]);
    assert.equal(
      fixture.stdout,
      [
        "lowest open milestone: M1 (1 of 2 tasks open, 1 ready)",
        LEGEND,
        `* X-903  L 8h  chain 8h  Put the third fixture roof on  (${FIXTURE})`,
        "ERRORS: 0",
        "",
      ].join("\n"),
    );
    const waiting = variant(openX902);
    assert.equal(
      run(["--remaining", waiting]).stdout,
      [
        "lowest open milestone: M1 (2 of 2 tasks open, 1 ready)",
        LEGEND,
        `* X-902  M 4h  chain 12h  Build the second fixture wall  [in progress]  (${waiting})`,
        "waiting for dependencies:",
        "  X-903 waits for X-902",
        "ERRORS: 0",
        "",
      ].join("\n"),
    );

    // No open task: an M7 task that is done adds nothing.
    const doneM7 = variant(
      (text) =>
        text +
        replace(
          extraTask("X-904", "Close the fourth fixture gate", "X-901", "S", "M7"),
          "### X-904 · Close the fourth fixture gate",
          "### X-904 · Close the fourth fixture gate ✅",
        ),
    );
    const done = run(["--remaining", doneM7]);
    assert.equal(done.status, 0, done.output);
    assert.equal(done.stdout, fixture.stdout.replaceAll(FIXTURE, doneM7));

    // M7 is the lowest open milestone: it is the first block, and no second block follows.
    const lowestM7 = variant(
      (text) =>
        allFixtureDone(text) +
        extraTask("X-904", "Draw the fourth fixture plan", "X-903", "S", "M7") +
        extraTask("X-905", "Survey the fifth fixture site", "X-904", "M", "M7"),
    );
    assert.equal(
      run(["--remaining", lowestM7]).stdout,
      [
        "lowest open milestone: M7 (2 of 2 tasks open, 1 ready)",
        LEGEND,
        `* X-904  S 2h  chain 6h  Draw the fourth fixture plan  (${lowestM7})`,
        "waiting for dependencies:",
        "  X-905 waits for X-904",
        "ERRORS: 0",
        "",
      ].join("\n"),
    );
  });

  test("[X-053 AC3] an M7 task with an open dependency is listed as waiting, and the second block lists no M8 task", () => {
    // X-904 depends on X-901 (M0, done): ready, whatever the milestone of its dependency. X-905 waits for X-903 (M1,
    // open) and X-906 for X-905 (M7, open). X-907 and X-908 are M8 tasks, one ready and one after an M7 task.
    const file = variant(
      (text) =>
        text +
        extraTask("X-904", "Draw the fourth fixture plan", "X-901", "S", "M7") +
        extraTask("X-905", "Survey the fifth fixture site", "X-903", "M", "M7") +
        extraTask("X-906", "Order the sixth fixture beams", "X-901, X-905", "S", "M7") +
        extraTask("X-907", "Paint the seventh fixture sign", "—", "M", "M8") +
        extraTask("X-908", "Hang the eighth fixture sign", "X-904", "M", "M8"),
    );
    const { status, lines, output } = run(["--remaining", file]);
    assert.equal(status, 0, output);
    assert.deepEqual(lines, [
      "lowest open milestone: M1 (1 of 2 tasks open, 1 ready)",
      LEGEND,
      `* X-903  L 8h  chain 14h  Put the third fixture roof on  (${file})`,
      "",
      `${M7_HEADING} (3 of 3 tasks open, 1 ready)`,
      LEGEND,
      `  X-904  S 2h  chain 6h  Draw the fourth fixture plan  (${file})`,
      "waiting for dependencies:",
      "  X-905 waits for X-903",
      "  X-906 waits for X-905",
      "ERRORS: 0",
    ]);
    assert.ok(!lines.some((l) => /X-907|X-908|: M8 \(/.test(l.replaceAll(file, ""))), output);

    // Open M8 tasks without open M7 tasks: no second block.
    const m8Only = variant(
      (text) => text + extraTask("X-904", "Paint the fourth fixture sign", "—", "M", "M8"),
    );
    const m8 = run(["--remaining", m8Only]);
    assert.equal(m8.status, 0, m8.output);
    assert.equal(m8.stdout, run(["--remaining", FIXTURE]).stdout.replaceAll(FIXTURE, m8Only));
  });

  test("[X-053 AC4] on the real plans --remaining exits 0 with ERRORS: 0 and names M7 while it has open tasks", () => {
    const { status, lines, output } = run(["--remaining"]);
    assert.equal(status, 0, output);
    assert.equal(lines.at(-1), "ERRORS: 0");
    const [, doneM7, allM7] =
      run([])
        .lines.find((l) => l.startsWith("done by milestone"))
        ?.match(/ M7 (\d+)\/(\d+) /) ?? assert.fail("the plans have M7 tasks");
    const openM7 = Number(allM7) - Number(doneM7);
    if (openM7 > 0) {
      // M7 heads the first block when it is the lowest open milestone, else the second.
      const counts = ` (${openM7} of ${allM7} tasks open, `;
      const heading = lines[0].startsWith("lowest open milestone: M7 ")
        ? `lowest open milestone: M7${counts}`
        : `${M7_HEADING}${counts}`;
      assert.ok(lines.some((l) => l.startsWith(heading)), output);
    }
    assert.ok(!lines.some((l) => /^also open\b/.test(l) && !l.startsWith(M7_HEADING)), output);
  });

  test("[X-053 AC4] a --remaining output larger than a pipe reaches a slow reader whole, down to ERRORS: 0", () => {
    // 40 open M7 tasks with long titles print about 90 KB, more than a pipe holds (64 KiB by default on Linux). The
    // reader starts a second late, so the script has to wait for it: process.exit() would drop what the pipe has not
    // taken (the real plans' 12 KB lost their last line that way in about 1 run of 20 on a loaded machine).
    const title = "Raise a long fixture tower ".repeat(80);
    const file = variant(
      (text) =>
        text +
        Array.from({ length: 40 }, (_, i) => extraTask(`X-${950 + i}`, `${title}${i}`, "—", "S", "M7")).join(""),
    );
    const slow = spawnSync(
      "sh",
      ["-c", '"$0" "$1" --remaining "$2" | { sleep 1; cat; }', process.execPath, SCRIPT, file],
      { encoding: "utf8" },
    );
    assert.equal(slow.status, 0, slow.stderr);
    assert.ok(slow.stdout.length > 65536, `${slow.stdout.length} bytes`);
    assert.equal(slow.stdout, run(["--remaining", file]).stdout);
    assert.ok(slow.stdout.endsWith(`  X-989  S 2h  chain 2h  ${title}39  (${file})\nERRORS: 0\n`), slow.stdout.slice(-300));
  });
});
