#!/usr/bin/env node
// fix-pci-refs: moves the line numbers of the PCI evidence pack's references (ota/docs/pci/*.md) to where their
// pieces are now, after changes and merges moved the lines (task OBE-085; lead decision (33i) of 2026-11-20, approved
// by the owner, moved it here from OBE-085's scratch tools with the same output and exit codes).
//
// Usage:  node tools/ci/fix-pci-refs.mjs [--dry-run] [--root <dir>]      (default root: this repository)
//
// For each link [`name:N`](path#LN) `piece` whose piece is no longer on line N, the nearest line of the file that
// contains the piece becomes the new N, in both the URL and the link text. It prints every change
// (`<file>: <target>#LN -> #LM`) and every reference it cannot place, and changes nothing else:
//   - `CHECK <file>: ...` when several lines hold the piece: it moved the reference to the nearest of them; read the
//     target and correct the line by hand when the nearest line is not the right one (check-pci-refs passes either
//     way);
//   - `CANNOT PLACE <file>: ...` when no line holds the piece, or two lines are equally near: the reference is left as
//     it was, to be corrected by hand.
// It ends with `N references moved (C of them to CHECK by reading), U could not be placed` and exits 1 when a
// reference could not be placed. With --dry-run it prints the same and writes nothing; an unknown option (a misspelt
// --dry-run) stops it before it reads or writes anything. Links inside ``` code fences are moved too (README §5's
// example). Run tools/ci/check-pci-refs.mjs first: a #L link to a file that does not exist stops this script with an
// error. ota/docs/pci/README.md §5 says when to run both.
//
// Plain Node (the `.nvmrc` major) without dependencies. Tests: tools/ci/pci-refs.test.mjs. See tools/ci/README.md.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, root: { type: "string" } } });
const ROOT = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const dry = values["dry-run"] === true;
const dir = join(ROOT, "ota", "docs", "pci");
const link = /\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^)\s#]+)#L(\d+)\)( `((?:[^`\\]|\\.)+)`)/g;
let moved = 0;
let unplaced = 0;
let toCheck = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const path = join(dir, file);
  const text = readFileSync(path, "utf8");
  const out = text.replace(link, (whole, name, target, n, tail, piece) => {
    const lines = readFileSync(resolve(dirname(path), target), "utf8").split("\n");
    const wanted = piece.replace(/\\\|/g, "|");
    const old = Number(n);
    if (lines[old - 1]?.includes(wanted)) return whole;
    const hits = lines.flatMap((l, i) => (l.includes(wanted) ? [i + 1] : []));
    if (hits.length === 0) {
      unplaced += 1;
      console.log(`CANNOT PLACE ${file}: ${target}#L${old} \`${wanted}\` (no line has it)`);
      return whole;
    }
    const best = hits.reduce((a, b) => (Math.abs(b - old) < Math.abs(a - old) ? b : a));
    const ties = hits.filter((h) => Math.abs(h - old) === Math.abs(best - old));
    if (ties.length > 1) {
      unplaced += 1;
      console.log(
        `CANNOT PLACE ${file}: ${target}#L${old} \`${wanted}\` (lines ${ties.join(", ")} are as near)`,
      );
      return whole;
    }
    moved += 1;
    if (hits.length > 1) {
      toCheck += 1;
      console.log(
        `CHECK ${file}: ${target}#L${old} -> #L${best} \`${wanted}\` (nearest of lines ${hits.join(", ")}: read it)`,
      );
    } else {
      console.log(`${file}: ${target}#L${old} -> #L${best}`);
    }
    const newName = name.replace(new RegExp(`:${old}(\`?)$`), `:${best}$1`);
    return `[${newName}](${target}#L${best})${tail}`;
  });
  if (!dry && out !== text) writeFileSync(path, out);
}
console.log(
  `${moved} references moved (${toCheck} of them to CHECK by reading), ${unplaced} could not be placed${dry ? " (dry run: nothing written)" : ""}`,
);
process.exitCode = unplaced === 0 ? 0 : 1;
