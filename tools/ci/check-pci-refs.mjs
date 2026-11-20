#!/usr/bin/env node
// check-pci-refs: the references of the PCI evidence pack (ota/docs/pci/*.md) to code, tests and VM settings still
// point where they should (task OBE-085; lead decision (33i) of 2026-11-20, approved by the owner, moved the command
// of ota/docs/pci/README.md §5 here, with the same output and exit codes).
//
// Usage:  node tools/ci/check-pci-refs.mjs [--root <dir>]      (default root: this repository)
//
// It reads every Markdown file directly in ota/docs/pci and checks each relative link in it. Links inside ``` code
// fences are ignored; links with a scheme (https:, mailto:, ...) and same-page `#anchor` links are skipped. For the
// rest it prints `PROBLEM <file>: <target>: ...` when:
//   - the linked file or folder does not exist (`no such file`);
//   - a `#heading` anchor into a Markdown file names none of its headings (`no such heading`; GitHub's slug of the
//     heading text);
//   - a `#L<n>` link is not followed by a piece of that line in code style, as in
//     [`velexis-ota-api.service:40`](../../../deploy/systemd/velexis-ota-api.service#L40) `LimitCORE=0`
//     (`no piece of the line after the link`);
//   - the piece is not on line n (`\|` in a piece stands for `|`, as in a table cell): it says where the piece is
//     now (`now on line N`), on which lines when several hold it (then read them and choose), or that no line has
//     it, and `(no such line)` when the file is shorter than n.
// It ends with `N references checked, M problems` and exits 1 when there is a problem. README §5 says how to choose
// a piece and when to run this. The repository's own references are checked by running it (at each review of the
// pack, by every task that touches a referenced file, by the wave integrator), not by CI (33i): a pull request, a
// Dependabot one included, never goes red over a moved reference that only an agent can place.
// tools/ci/fix-pci-refs.mjs moves the line numbers to where their pieces are now.
//
// Plain Node (the `.nvmrc` major) without dependencies. Tests: tools/ci/pci-refs.test.mjs. See tools/ci/README.md.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string" } } });
const ROOT = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const dir = join(ROOT, "ota", "docs", "pci");
const slug = (h) =>
  h
    .replace(/^#+ /, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
const link = /\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^)\s]+)\)(?: `((?:[^`\\]|\\.)+)`)?/g;
let checked = 0,
  problems = 0;
const problem = (text) => {
  problems += 1;
  console.log(`PROBLEM ${text}`);
};
for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(join(dir, file), "utf8").replace(/```[\s\S]*?```/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  for (const [, , target, piece] of text.matchAll(link)) {
    if (/^[a-z]+:/.test(target) || target.startsWith("#")) continue;
    checked += 1;
    const [path, anchor] = target.split("#");
    const abs = resolve(dirname(join(dir, file)), path);
    if (!existsSync(abs)) {
      problem(`${file}: ${target}: no such file`);
      continue;
    }
    if (anchor === undefined) continue;
    const lines = /^L(\d+)$/.exec(anchor);
    if (lines === null) {
      const headings = readFileSync(abs, "utf8")
        .split("\n")
        .filter((l) => /^#{1,6} /.test(l))
        .map(slug);
      if (abs.endsWith(".md") && !headings.includes(anchor)) problem(`${file}: ${target}: no such heading`);
      continue;
    }
    const content = statSync(abs).isFile() ? readFileSync(abs, "utf8").split("\n") : [];
    const line = content[Number(lines[1]) - 1];
    if (piece === undefined) {
      problem(`${file}: ${target}: no piece of the line after the link`);
      continue;
    }
    const wanted = piece.replace(/\\\|/g, "|");
    if (line !== undefined && line.includes(wanted)) continue;
    const now = content.flatMap((l, i) => (l.includes(wanted) ? [i + 1] : []));
    const where =
      now.length === 0
        ? "no line has it"
        : now.length === 1
          ? `now on line ${now[0]}`
          : `on lines ${now.join(", ")}`;
    problem(
      `${file}: ${target}: \`${piece}\` is not on ${line === undefined ? "that line (no such line)" : "that line"}: ${where}`,
    );
  }
}
console.log(`${checked} references checked, ${problems} problems`);
process.exitCode = problems === 0 ? 0 : 1;
