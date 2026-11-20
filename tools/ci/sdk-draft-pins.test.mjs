// The draft SDK publish workflow keeps the live workflows' action pins (lead decision (33b) of 2026-11-20, approved by
// the owner; FIX-W64-SDK). Run: node --test tools/ci/*.test.mjs (ci.yml's build-test job runs every test of this
// folder, so this guard needs no workflow change).
//
// ota/sdk/release/sdk-publish.draft.yml (SDK-015, lead decision (32j)) is not in .github/workflows/, so GitHub never
// runs it, check-package-json.mjs's rule 4 never reads it and Dependabot never updates its pins. Until the owner
// approves it, every `uses:` of a YAML file in ota/sdk/release/ must be `owner/repo[/path]@<40-hex SHA> # <tag>`, name
// an action that at least one workflow in .github/workflows/ uses, and carry the same SHA and the same tag as every
// live use of that action; each failure names the file, the line, the action and both pins. A github-actions
// Dependabot pull request that moves a live pin turns this test red until an agent copies the new pin into the draft
// and records the draft's new SHA-256 in ota/sdk/release/CHANGES.md (the owner never edits the draft and approves the
// final file by its SHA-256). On approval the draft moves to .github/workflows/sdk-publish.yml with exactly its two
// DRAFT header lines deleted (lead decision (33c)); then ota/sdk/release/ holds no YAML file, check-package-json.mjs's
// rule 4 covers the pins, and this test only checks that the move happened: no draft and no sdk-publish.yml fails.
//
// The reading rule is rule 4's (one `uses:` per line, quoted keys and values allowed, a flow mapping fails), without
// a YAML package: tools/ci needs no install (README.md). The comparison is the pure function comparePins, which the
// fixtures below exercise as well as this repository.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DRAFT_DIR = "ota/sdk/release";
const WORKFLOWS = ".github/workflows";
const MOVED = `${WORKFLOWS}/sdk-publish.yml`;
const CHANGES = `${DRAFT_DIR}/CHANGES.md`;

const USES_LINE = /^\s*(?:-\s+)?(["']?)uses\1\s*:\s*(.*)$/;
const FLOW_MAPPING = /^\s*(?:-\s+)?\{.*\buses["']?\s*:/;
const REFERENCE = /^(["']?)([^"'\s#]+)\1\s*(#.*)?$/;
const ACTION_AT = /^([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+(?:\/[^@\s]+)?)@([^@\s]+)$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
/** The draft's comment must be exactly the tag; a live comment may carry text after it (rule 4 warns only). */
const EXACT_TAG = /^#\s*(v?\d+(?:\.\d+)*)\s*$/;
const LEADING_TAG = /^#\s*(v?\d+(?:\.\d+)*)/;

/** The `uses:` lines of a workflow: { uses: [{ line, ref, comment }], problems }. */
function usesOf(file, text) {
  const uses = [];
  const problems = [];
  text.split(/\r?\n/).forEach((content, index) => {
    const line = index + 1;
    const m = content.match(USES_LINE);
    if (!m) {
      if (FLOW_MAPPING.test(content)) {
        problems.push(`${file}:${line}: write "uses:" as a block mapping key, not in a flow mapping {...}`);
      }
      return;
    }
    const parts = m[2].match(REFERENCE);
    if (!parts) {
      problems.push(`${file}:${line}: cannot read the action reference ${JSON.stringify(m[2])}`);
      return;
    }
    uses.push({ line, ref: parts[2], comment: (parts[3] ?? "").trim() });
  });
  return { uses, problems };
}

const pinText = (sha, tag) => `${sha} # ${tag ?? "(no tag)"}`;

/**
 * Compares the action pins of the draft files with those of the live workflows.
 * `drafts` and `live` are [{ file, text }] (paths relative to the repository root); `moved` says whether
 * .github/workflows/sdk-publish.yml exists. Returns the problems, one message each; [] means the pins agree.
 */
function comparePins({ drafts, live, moved }) {
  const problems = [];
  if (drafts.length === 0) {
    if (!moved) {
      problems.push(
        `${DRAFT_DIR}/ holds no .yml file and ${MOVED} does not exist: the draft publish workflow is gone ` +
          `without the approved move (lead decisions (32j) and (33c))`,
      );
    }
    return problems;
  }

  // action -> distinct live pins: Map("sha # tag" -> { sha, tag, where: ["file:line", ...] })
  const livePins = new Map();
  for (const { file, text } of live) {
    const read = usesOf(file, text);
    problems.push(...read.problems);
    for (const { line, ref, comment } of read.uses) {
      if (ref.startsWith("./") || ref.startsWith("docker://")) {
        continue; // a local action or a container image: no action pin to compare
      }
      const m = ref.match(ACTION_AT);
      if (!m) {
        continue; // rule 4 of check-package-json.mjs reports a live reference it cannot read
      }
      const [, action, sha] = m;
      const tag = comment.match(LEADING_TAG)?.[1] ?? null;
      const key = pinText(sha, tag);
      const pins = livePins.get(action) ?? new Map();
      const pin = pins.get(key) ?? { sha, tag, where: [] };
      pin.where.push(`${file}:${line}`);
      pins.set(key, pin);
      livePins.set(action, pins);
    }
  }

  for (const { file, text } of drafts) {
    const read = usesOf(file, text);
    problems.push(...read.problems);
    if (read.uses.length === 0 && read.problems.length === 0) {
      problems.push(
        `${file}: no "uses:" line found, so there is nothing to compare (the reader cannot see its steps)`,
      );
    }
    for (const { line, ref, comment } of read.uses) {
      const at = `${file}:${line}`;
      const m = ref.match(ACTION_AT);
      if (!m) {
        problems.push(`${at}: "${ref}" is not an owner/repo[/path]@<commit SHA> reference to an action`);
        continue;
      }
      const [, action, sha] = m;
      const pins = livePins.get(action);
      let comparable = true;
      if (!pins) {
        problems.push(
          `${at}: ${action} is used by no workflow in ${WORKFLOWS}/, so its pin cannot be kept in step with a ` +
            `live one: the draft uses only actions the live workflows pin (lead decision (33b))`,
        );
        comparable = false;
      }
      if (!FULL_SHA.test(sha)) {
        problems.push(`${at}: "${ref}" is not pinned to a full 40-character commit SHA (ADR-0023)`);
        comparable = false;
      }
      const tag = comment.match(EXACT_TAG)?.[1];
      if (!tag) {
        problems.push(
          `${at}: "${ref}" needs the tag of that commit as its whole comment, e.g. "# v4.4.0" ` +
            `(found ${JSON.stringify(comment)}; ADR-0023)`,
        );
        comparable = false;
      }
      if (!comparable) {
        continue;
      }
      for (const pin of pins.values()) {
        if (pin.sha === sha && pin.tag === tag) {
          continue;
        }
        const more =
          pin.where.length > 1 ? ` (and ${pin.where.length - 1} more live use(s) with that pin)` : "";
        problems.push(
          `${at}: ${action} is pinned to ${pinText(sha, tag)} in the draft but to ${pinText(pin.sha, pin.tag)} ` +
            `in ${pin.where[0]}${more}: copy the live pin into the draft and record its new SHA-256 in ` +
            `${CHANGES} (lead decision (33b))`,
        );
      }
    }
  }
  return problems;
}

/** The YAML files of a folder of this repository, as [{ file, text }] sorted by name; [] when it does not exist. */
function yamlFiles(root, dir) {
  if (!existsSync(join(root, dir))) {
    return [];
  }
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ file: `${dir}/${name}`, text: readFileSync(join(root, dir, name), "utf8") }));
}

const SHA_CHECKOUT = "11d5960a326750d5838078e36cf38b85af677262";
const SHA_SETUP_NODE = "49933ea5288caeca8642d1e84afbd3f7d6820020";
const SHA_OTHER = "0123456789abcdef0123456789abcdef01234567";

const LIVE_CI = {
  file: ".github/workflows/ci.yml",
  text: [
    "name: CI",
    "jobs:",
    "  a:",
    "    steps:",
    `      - uses: actions/checkout@${SHA_CHECKOUT} # v4.4.0`,
    `      - uses: actions/setup-node@${SHA_SETUP_NODE} # v4.4.0`,
    "  b:",
    "    steps:",
    `      - uses: actions/checkout@${SHA_CHECKOUT} # v4.4.0`,
    "      - uses: ./.github/actions/local",
    "",
  ].join("\n"),
};
const LIVE_DEPLOY = {
  file: ".github/workflows/deploy.yml",
  text: [
    "jobs:",
    "  e2e:",
    "    uses: ./.github/workflows/e2e.yml",
    "  build:",
    "    steps:",
    `      - uses: actions/checkout@${SHA_CHECKOUT} # v4.4.0`,
    "",
  ].join("\n"),
};
const LIVE = [LIVE_CI, LIVE_DEPLOY];

/** A draft at ota/sdk/release/sdk-publish.draft.yml: two header lines, then `jobs:`; its first step is line 6. */
const draft = (...steps) => ({
  file: `${DRAFT_DIR}/sdk-publish.draft.yml`,
  text: ["# DRAFT", "# for approval", "jobs:", "  check:", "    steps:", ...steps, ""].join("\n"),
});
const STEP_CHECKOUT = `      - uses: actions/checkout@${SHA_CHECKOUT} # v4.4.0`;
const STEP_SETUP_NODE = `      - uses: actions/setup-node@${SHA_SETUP_NODE} # v4.4.0`;

describe("comparePins on inline fixtures", () => {
  it("passes when every pin of the draft is the live workflows' pin [FIX-W64-SDK]", () => {
    assert.deepEqual(
      comparePins({ drafts: [draft(STEP_CHECKOUT, STEP_SETUP_NODE)], live: LIVE, moved: false }),
      [],
    );
  });

  it("fails on a drifted SHA, naming the file, the line, the action and both pins [FIX-W64-SDK]", () => {
    const problems = comparePins({
      drafts: [draft(STEP_CHECKOUT, `      - uses: actions/setup-node@${SHA_OTHER} # v4.4.0`)],
      live: LIVE,
      moved: false,
    });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.equal(
      problems[0],
      `${DRAFT_DIR}/sdk-publish.draft.yml:7: actions/setup-node is pinned to ${SHA_OTHER} # v4.4.0 in the draft but ` +
        `to ${SHA_SETUP_NODE} # v4.4.0 in .github/workflows/ci.yml:6: copy the live pin into the draft and record ` +
        `its new SHA-256 in ${CHANGES} (lead decision (33b))`,
    );
  });

  it("fails on a drifted tag, and counts the other live uses with that pin [FIX-W64-SDK]", () => {
    const problems = comparePins({
      drafts: [draft(`      - uses: actions/checkout@${SHA_CHECKOUT} # v4.3.1`)],
      live: LIVE,
      moved: false,
    });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /sdk-publish\.draft\.yml:6: actions\/checkout is pinned to /);
    assert.ok(problems[0].includes(`${SHA_CHECKOUT} # v4.3.1 in the draft but to ${SHA_CHECKOUT} # v4.4.0`));
    assert.ok(problems[0].includes("in .github/workflows/ci.yml:5 (and 2 more live use(s) with that pin)"));
  });

  it("fails on every live pin that differs when the live workflows disagree among themselves [FIX-W64-SDK]", () => {
    const deployMoved = {
      ...LIVE_DEPLOY,
      text: LIVE_DEPLOY.text.replace(`${SHA_CHECKOUT} # v4.4.0`, `${SHA_OTHER} # v4.5.0`),
    };
    const problems = comparePins({
      drafts: [draft(STEP_CHECKOUT)],
      live: [LIVE_CI, deployMoved],
      moved: false,
    });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.ok(problems[0].includes(`but to ${SHA_OTHER} # v4.5.0 in .github/workflows/deploy.yml:6:`));
  });

  it("fails on an action no live workflow uses [FIX-W64-SDK]", () => {
    const problems = comparePins({
      drafts: [draft(STEP_CHECKOUT, `      - uses: actions/upload-artifact@${SHA_OTHER} # v4.6.2`)],
      live: LIVE,
      moved: false,
    });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(
      problems[0],
      /^ota\/sdk\/release\/sdk-publish\.draft\.yml:7: actions\/upload-artifact is used by no workflow in \.github\/workflows\//,
    );
  });

  it("fails on a tag-only reference (@v4) and does not compare it further [FIX-W64-SDK]", () => {
    const problems = comparePins({
      drafts: [draft("      - uses: actions/checkout@v4 # v4.4.0")],
      live: LIVE,
      moved: false,
    });
    assert.deepEqual(problems, [
      `${DRAFT_DIR}/sdk-publish.draft.yml:6: "actions/checkout@v4" is not pinned to a full 40-character commit SHA ` +
        "(ADR-0023)",
    ]);
  });

  it("fails on a missing '# tag' comment and on a comment with more than the tag [FIX-W64-SDK]", () => {
    for (const comment of ["", " # v4.4.0 (pinned by hand)", " # latest"]) {
      const problems = comparePins({
        drafts: [draft(`      - uses: actions/checkout@${SHA_CHECKOUT}${comment}`)],
        live: LIVE,
        moved: false,
      });
      assert.equal(problems.length, 1, `${JSON.stringify(comment)}: ${problems.join("\n")}`);
      assert.match(problems[0], /sdk-publish\.draft\.yml:6: "actions\/checkout@[0-9a-f]{40}" needs the tag/);
    }
  });

  it("fails on a reference that is not an owner/repo@SHA action and on a flow mapping [FIX-W64-SDK]", () => {
    const problems = comparePins({
      drafts: [
        draft(
          "      - uses: ./.github/actions/local",
          "      - uses: docker://alpine:3.20",
          `      - { uses: actions/checkout@${SHA_CHECKOUT} }`,
        ),
      ],
      live: LIVE,
      moved: false,
    });
    assert.equal(problems.length, 3, problems.join("\n"));
    assert.match(problems[0], /:8: write "uses:" as a block mapping key/);
    assert.match(
      problems[1],
      /:6: "\.\/\.github\/actions\/local" is not an owner\/repo\[\/path\]@<commit SHA>/,
    );
    assert.match(problems[2], /:7: "docker:\/\/alpine:3\.20" is not an owner\/repo\[\/path\]@<commit SHA>/);
  });

  it("reads quoted keys and values as rule 4 does, and tells a sub-path action from its repository [FIX-W64-SDK]", () => {
    const cacheLive = {
      file: ".github/workflows/e2e.yml",
      text: `jobs:\n  a:\n    steps:\n      - uses: actions/cache/restore@${SHA_OTHER} # v4.3.0\n`,
    };
    assert.deepEqual(
      comparePins({
        drafts: [draft(`      - "uses": "actions/cache/restore@${SHA_OTHER}" # v4.3.0`)],
        live: [cacheLive],
        moved: false,
      }),
      [],
    );
    const problems = comparePins({
      drafts: [draft(`      - uses: actions/cache@${SHA_OTHER} # v4.3.0`)],
      live: [cacheLive],
      moved: false,
    });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /actions\/cache is used by no workflow/);
  });

  it("fails on a draft in which it reads no uses: line, so it never passes by checking nothing [FIX-W64-SDK]", () => {
    const problems = comparePins({ drafts: [draft("      - run: echo")], live: LIVE, moved: false });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /sdk-publish\.draft\.yml: no "uses:" line found/);
  });

  it("the moved case: no draft left and .github/workflows/sdk-publish.yml present passes [FIX-W64-SDK]", () => {
    assert.deepEqual(comparePins({ drafts: [], live: LIVE, moved: true }), []);
  });

  it("the missing case: no draft left and no .github/workflows/sdk-publish.yml fails [FIX-W64-SDK]", () => {
    const problems = comparePins({ drafts: [], live: LIVE, moved: false });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(
      problems[0],
      /^ota\/sdk\/release\/ holds no \.yml file and \.github\/workflows\/sdk-publish\.yml does not exist/,
    );
  });
});

describe("this repository", () => {
  it("the draft publish workflow keeps the live workflows' action pins, or has moved [FIX-W64-SDK]", () => {
    const drafts = yamlFiles(ROOT, DRAFT_DIR);
    const live = yamlFiles(ROOT, WORKFLOWS);
    assert.ok(live.length > 0, `no workflow found in ${WORKFLOWS}/`);
    const problems = comparePins({ drafts, live, moved: existsSync(join(ROOT, MOVED)) });
    assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
  });
});
