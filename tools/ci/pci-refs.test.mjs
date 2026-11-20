// Tests of tools/ci/check-pci-refs.mjs and tools/ci/fix-pci-refs.mjs (task OBE-085; lead decision (33i) of
// 2026-11-20, approved by the owner; FIX-W64-TOOLS). Run: node --test tools/ci/*.test.mjs
// Each test builds a small tree in a temporary folder (ota/docs/pci/*.md and the files they point at) and runs the
// scripts on it with --root. None of them checks this repository's own pack: that stays a command (README §5 of the
// pack), never a CI test, so a pull request never goes red over a moved reference that only an agent can place.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, "check-pci-refs.mjs");
const FIX = join(HERE, "fix-pci-refs.mjs");

const scratch = mkdtempSync(join(tmpdir(), "obe085-pci-refs-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The files every tree starts with: one config file, a Markdown guide and a second page of the pack. */
const TARGETS = {
  "deploy/app.conf": ["# app.conf", "alpha=1", "beta=2", "gamma=3", "a | b", ""].join("\n"),
  "docs/guide.md": ["# Guide", "", "## 2. Scope, in short", "", "Text.", ""].join("\n"),
  "ota/docs/pci/other.md": ["# Other page", "", "## A heading", ""].join("\n"),
};
const PACK = "ota/docs/pci/pack.md";

let count = 0;
/** Writes TARGETS plus `files` (path -> text; arrays are joined with newlines) to a new folder; returns it. */
function tree(files) {
  const root = join(scratch, `tree-${(count += 1)}`);
  for (const [path, content] of Object.entries({ ...TARGETS, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), Array.isArray(content) ? `${content.join("\n")}\n` : content);
  }
  return root;
}

/** Runs a script with the given arguments (from `cwd`, the scratch folder by default). */
function run(script, args, cwd = scratch) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    lines: result.stdout.trimEnd().split("\n"),
  };
}
const check = (root) => run(CHECK, ["--root", root]);
const fix = (root, ...args) => run(FIX, ["--root", root, ...args]);
const pack = (root) => readFileSync(join(root, PACK), "utf8");

// A link to a line of deploy/app.conf, written as the pack writes them.
const appLine = (n, piece, name = `\`app.conf:${n}\``) =>
  `[${name}](../../../deploy/app.conf#L${n}) \`${piece}\``;

describe("check-pci-refs", () => {
  it("passes a correct pack: files, folders, headings, lines with their pieces, `\\|` in a piece [FIX-W64-TOOLS]", () => {
    const root = tree({
      [PACK]: [
        "# Pack",
        "",
        `- the unit: ${appLine(2, "alpha=1")}`,
        `- a table cell: ${appLine(5, "a \\| b")}`,
        "- the guide: [`guide.md`](../../../docs/guide.md) and its [scope](../../../docs/guide.md#2-scope-in-short)",
        "- a folder: [`deploy`](../../../deploy)",
        "- another page of the pack: [other](other.md#a-heading)",
        "- an anchor that is no line, into a file that is not Markdown: [conf](../../../deploy/app.conf#top)",
      ],
    });
    const { status, out, lines } = check(root);
    assert.equal(status, 0, out);
    assert.deepEqual(lines, ["7 references checked, 0 problems"]);
  });

  it("reports a missing file, a missing heading and a line link without a piece, and exits 1 [FIX-W64-TOOLS]", () => {
    const root = tree({
      [PACK]: [
        "[gone](../../../deploy/missing.conf)",
        "[guide](../../../docs/guide.md#3-no-such-section)",
        "[`app.conf:2`](../../../deploy/app.conf#L2)",
      ],
    });
    const { status, out, lines } = check(root);
    assert.equal(status, 1, out);
    assert.deepEqual(lines, [
      "PROBLEM pack.md: ../../../deploy/missing.conf: no such file",
      "PROBLEM pack.md: ../../../docs/guide.md#3-no-such-section: no such heading",
      "PROBLEM pack.md: ../../../deploy/app.conf#L2: no piece of the line after the link",
      "3 references checked, 3 problems",
    ]);
  });

  it("reports a piece that moved ('now on line N'), a line past the end, and a piece no line has [FIX-W64-TOOLS]", () => {
    const root = tree({ [PACK]: [appLine(3, "alpha=1"), appLine(99, "gamma=3"), appLine(2, "zeta=9")] });
    const { status, out, lines } = check(root);
    assert.equal(status, 1, out);
    assert.deepEqual(lines, [
      "PROBLEM pack.md: ../../../deploy/app.conf#L3: `alpha=1` is not on that line: now on line 2",
      "PROBLEM pack.md: ../../../deploy/app.conf#L99: `gamma=3` is not on that line (no such line): now on line 4",
      "PROBLEM pack.md: ../../../deploy/app.conf#L2: `zeta=9` is not on that line: no line has it",
      "3 references checked, 3 problems",
    ]);
  });

  it("names every line that holds a piece found on several lines [FIX-W64-TOOLS]", () => {
    const root = tree({
      "deploy/app.conf": ["# app.conf", "alpha=1", "dup=1", "beta=2", "dup=1", ""].join("\n"),
      [PACK]: [appLine(2, "dup=1")],
    });
    const { status, out, lines } = check(root);
    assert.equal(status, 1, out);
    assert.deepEqual(lines, [
      "PROBLEM pack.md: ../../../deploy/app.conf#L2: `dup=1` is not on that line: on lines 3, 5",
      "1 references checked, 1 problems",
    ]);
  });

  it("skips external links and same-page #anchor links [FIX-W64-TOOLS]", () => {
    const root = tree({
      [PACK]: [
        "[site](https://platform.example.com/missing#L9) `nothing`",
        "[mail](mailto:security@platform.example.com)",
        "[up](#no-such-heading-here)",
      ],
    });
    const { status, out, lines } = check(root);
    assert.equal(status, 0, out);
    assert.deepEqual(lines, ["0 references checked, 0 problems"]);
  });

  it("ignores links inside code fences and checks the links after them [FIX-W64-TOOLS]", () => {
    const root = tree({
      [PACK]: [
        "```markdown",
        "[gone](../../../deploy/missing.conf) and " + appLine(3, "alpha=1"),
        "```",
        "",
        "[still checked](../../../deploy/after-the-fence.conf)",
      ],
    });
    const { status, out, lines } = check(root);
    assert.equal(status, 1, out);
    assert.deepEqual(lines, [
      "PROBLEM pack.md: ../../../deploy/after-the-fence.conf: no such file",
      "1 references checked, 1 problems",
    ]);
  });

  it("reads every Markdown file of the pack folder and no other file [FIX-W64-TOOLS]", () => {
    const root = tree({
      [PACK]: [appLine(2, "alpha=1")],
      "ota/docs/pci/second.md": ["[gone](../../../deploy/missing.conf)"],
      "ota/docs/pci/notes.txt": ["[gone](../../../deploy/also-missing.conf)"],
      "ota/docs/elsewhere.md": ["[gone](../../deploy/missing-too.conf)"],
    });
    const { status, out, lines } = check(root);
    assert.equal(status, 1, out);
    assert.deepEqual(lines, [
      "PROBLEM second.md: ../../../deploy/missing.conf: no such file",
      "2 references checked, 1 problems",
    ]);
  });

  it("finds the repository from its own location, from any working directory [FIX-W64-TOOLS]", () => {
    // A copy of the script in the tree's tools/ci checks that tree without --root, run from elsewhere.
    const root = tree({ [PACK]: [appLine(2, "alpha=1"), "[gone](../../../deploy/missing.conf)"] });
    mkdirSync(join(root, "tools", "ci"), { recursive: true });
    copyFileSync(CHECK, join(root, "tools", "ci", "check-pci-refs.mjs"));
    const { status, out, lines } = run(join(root, "tools", "ci", "check-pci-refs.mjs"), [], tmpdir());
    assert.equal(status, 1, out);
    assert.deepEqual(lines, [
      "PROBLEM pack.md: ../../../deploy/missing.conf: no such file",
      "2 references checked, 1 problems",
    ]);
  });
});

describe("fix-pci-refs", () => {
  /** app.conf after two lines were added above `alpha=1`: it moved from line 2 to line 4. */
  const MOVED = ["# app.conf", "# added", "# added", "alpha=1", "beta=2", "gamma=3", ""].join("\n");

  it("moves a reference to the line that holds its piece, in the URL and in the link text [FIX-W64-TOOLS]", () => {
    const root = tree({
      "deploy/app.conf": MOVED,
      [PACK]: [
        `- ${appLine(2, "alpha=1")}`,
        `- ${appLine(3, "beta=2", "app.conf:3")}`,
        `- ${appLine(4, "gamma=3", "the last line")}`,
        `- ${appLine(4, "alpha=1")} stays`,
      ],
    });
    const { status, out, lines } = fix(root);
    assert.equal(status, 0, out);
    assert.deepEqual(lines, [
      "pack.md: ../../../deploy/app.conf#L2 -> #L4",
      "pack.md: ../../../deploy/app.conf#L3 -> #L5",
      "pack.md: ../../../deploy/app.conf#L4 -> #L6",
      "3 references moved (0 of them to CHECK by reading), 0 could not be placed",
    ]);
    assert.equal(
      pack(root),
      [
        `- ${appLine(4, "alpha=1")}`,
        `- ${appLine(5, "beta=2", "app.conf:5")}`,
        `- ${appLine(6, "gamma=3", "the last line")}`,
        `- ${appLine(4, "alpha=1")} stays`,
        "",
      ].join("\n"),
    );
    const after = check(root);
    assert.equal(after.status, 0, after.out);
    assert.deepEqual(after.lines, ["4 references checked, 0 problems"]);
  });

  it("moves to the nearest of several lines that hold the piece and prints CHECK with every candidate [FIX-W64-TOOLS]", () => {
    const root = tree({
      "deploy/app.conf": ["# app.conf", "alpha=1", "dup=1", "beta=2", "gamma=3", "x", "x", "dup=1", ""].join(
        "\n",
      ),
      [PACK]: [appLine(4, "dup=1")],
    });
    const { status, out, lines } = fix(root);
    assert.equal(status, 0, out);
    assert.deepEqual(lines, [
      "CHECK pack.md: ../../../deploy/app.conf#L4 -> #L3 `dup=1` (nearest of lines 3, 8: read it)",
      "1 references moved (1 of them to CHECK by reading), 0 could not be placed",
    ]);
    assert.equal(pack(root), `${appLine(3, "dup=1")}\n`);
    const after = check(root);
    assert.equal(after.status, 0, after.out);
    assert.deepEqual(after.lines, ["1 references checked, 0 problems"]);
  });

  it("prints CANNOT PLACE when no line holds the piece or two are as near, changes nothing, exits 1 [FIX-W64-TOOLS]", () => {
    const original = [appLine(2, "zeta=9"), appLine(5, "dup=1")];
    const root = tree({
      "deploy/app.conf": ["# app.conf", "alpha=1", "dup=1", "beta=2", "gamma=3", "x", "dup=1", ""].join("\n"),
      [PACK]: original,
    });
    const { status, out, lines } = fix(root);
    assert.equal(status, 1, out);
    assert.deepEqual(lines, [
      "CANNOT PLACE pack.md: ../../../deploy/app.conf#L2 `zeta=9` (no line has it)",
      "CANNOT PLACE pack.md: ../../../deploy/app.conf#L5 `dup=1` (lines 3, 7 are as near)",
      "0 references moved (0 of them to CHECK by reading), 2 could not be placed",
    ]);
    assert.equal(pack(root), `${original.join("\n")}\n`);
  });

  it("with --dry-run prints the same moves and writes nothing [FIX-W64-TOOLS]", () => {
    const original = [appLine(2, "alpha=1"), appLine(2, "zeta=9")];
    const root = tree({ "deploy/app.conf": MOVED, [PACK]: original });
    const { status, out, lines } = fix(root, "--dry-run");
    assert.equal(status, 1, out);
    assert.deepEqual(lines, [
      "pack.md: ../../../deploy/app.conf#L2 -> #L4",
      "CANNOT PLACE pack.md: ../../../deploy/app.conf#L2 `zeta=9` (no line has it)",
      "1 references moved (0 of them to CHECK by reading), 1 could not be placed (dry run: nothing written)",
    ]);
    assert.equal(pack(root), `${original.join("\n")}\n`);
  });

  it("leaves a correct pack as it is, byte for byte [FIX-W64-TOOLS]", () => {
    const original = [
      `${appLine(2, "alpha=1")} and ${appLine(5, "a \\| b")}`,
      "[guide](../../../docs/guide.md)",
    ];
    const root = tree({ [PACK]: original });
    const { status, out, lines } = fix(root);
    assert.equal(status, 0, out);
    assert.deepEqual(lines, ["0 references moved (0 of them to CHECK by reading), 0 could not be placed"]);
    assert.equal(pack(root), `${original.join("\n")}\n`);
  });

  it("finds the repository from its own location, from any working directory [FIX-W64-TOOLS]", () => {
    const root = tree({ "deploy/app.conf": MOVED, [PACK]: [appLine(2, "alpha=1")] });
    mkdirSync(join(root, "tools", "ci"), { recursive: true });
    copyFileSync(FIX, join(root, "tools", "ci", "fix-pci-refs.mjs"));
    const { status, out, lines } = run(join(root, "tools", "ci", "fix-pci-refs.mjs"), [], tmpdir());
    assert.equal(status, 0, out);
    assert.deepEqual(lines, [
      "pack.md: ../../../deploy/app.conf#L2 -> #L4",
      "1 references moved (0 of them to CHECK by reading), 0 could not be placed",
    ]);
    assert.equal(pack(root), `${appLine(4, "alpha=1")}\n`);
  });

  it("refuses an unknown option before it reads or writes anything [FIX-W64-TOOLS]", () => {
    const original = [appLine(2, "alpha=1")];
    const root = tree({ "deploy/app.conf": MOVED, [PACK]: original });
    const { status, out } = fix(root, "--dryrun");
    assert.equal(status, 1, out);
    assert.match(out, /Unknown option '--dryrun'/);
    assert.equal(pack(root), `${original.join("\n")}\n`);
  });
});
