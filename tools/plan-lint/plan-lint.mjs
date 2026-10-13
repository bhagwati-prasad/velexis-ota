#!/usr/bin/env node
// plan-lint: validates the Markdown agent-task plans of the Velexis MVP.
//
// Usage:  node tools/plan-lint/plan-lint.mjs [--graph] [file ...]
//         (default files: docs/mvp/plans/foundation-tasks.md, platform/docs/plans/agent-tasks.md, ota/docs/plans/agent-tasks.md)
//
// Task block format (one per task):
//   ### PBE-012 · Short imperative title
//   - **Component:** platform-backend
//   - **Milestone:** M2
//   - **Depends on:** X-003, PBE-010            (or "—" for none)
//   - **Size:** S | M | L                       (S ≤ 2h, M ≤ 4h, L ≤ 1 day of focused agent+review time)
//   - **Read first:** docs/... ; docs/...
//   - **Files:** `path/a.ts`, `path/b.ts`        (files created or changed, each in backticks)
//   - **Steps:**
//     1. ...
//   - **Acceptance:**
//     - ...
//   - **Verify:** `command`
//
// Checks: unique ids, id prefix matches component, dependencies exist and form no cycle, every required field is present
// and non-empty, at least 2 steps and 1 acceptance criterion, Verify contains a backticked command, Files are repo paths
// under an allowed top-level directory, milestone format. Prints counts and the critical path.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_FILES = ["docs/mvp/plans/foundation-tasks.md", "platform/docs/plans/agent-tasks.md", "ota/docs/plans/agent-tasks.md"];
const PREFIX = {
  X: "foundation", PBE: "platform-backend", PFE: "platform-frontend", PAD: "platform-admin",
  OBE: "ota-backend", OFE: "ota-frontend", OAD: "ota-admin", SDK: "ota-sdk",
};
const REQUIRED = ["Component", "Milestone", "Depends on", "Size", "Read first", "Files", "Steps", "Acceptance", "Verify"];
const ALLOWED_DIRS = ["platform/", "ota/", "packages/", "deploy/", "docs/", "tools/", ".github/", "package.json", "pnpm-workspace.yaml", "turbo.json",
  "tsconfig.base.json", ".editorconfig", ".nvmrc", ".gitignore", ".prettierrc.json", "eslint.config.mjs", "AGENTS.md", "CLAUDE.md", "README.md", "vitest.workspace.ts", ".env.example"];
const SIZE_HOURS = { S: 2, M: 4, L: 8 };

const args = process.argv.slice(2);
const wantGraph = args.includes("--graph");
const files = args.filter((a) => !a.startsWith("--"));
const targets = (files.length ? files : DEFAULT_FILES).filter((f) => {
  if (existsSync(resolve(ROOT, f))) return true;
  console.warn(`(skipping missing ${f})`);
  return false;
});

const tasks = new Map();
const errors = [];
for (const file of targets) {
  const text = readFileSync(resolve(ROOT, file), "utf8").replace(/\r\n/g, "\n");
  const blocks = text.split(/\n(?=### )/).filter((b) => b.startsWith("### "));
  for (const block of blocks) {
    const head = block.split("\n", 1)[0];
    const m = head.match(/^### ([A-Z]+)-(\d{3}) · (.+)$/);
    if (!m) {
      if (/^### [A-Z]+-\d/.test(head)) errors.push(`${file}: bad heading "${head}" (expected "### PBE-012 · Title")`);
      continue;
    }
    const id = `${m[1]}-${m[2]}`;
    const where = `${file} ${id}`;
    if (!PREFIX[m[1]]) errors.push(`${where}: unknown id prefix ${m[1]} (use ${Object.keys(PREFIX).join(", ")})`);
    if (tasks.has(id)) errors.push(`${where}: duplicate id (also in ${tasks.get(id).file})`);
    const fields = {};
    const lines = block.split("\n").slice(1);
    let cur = null;
    for (const line of lines) {
      const fm = line.match(/^- \*\*([A-Za-z ]+):\*\*\s*(.*)$/);
      if (fm) {
        cur = fm[1].trim();
        fields[cur] = fm[2].trim() ? [fm[2].trim()] : [];
      } else if (cur && line.trim() && !line.startsWith("#")) {
        fields[cur].push(line.trim());
      }
    }
    for (const f of REQUIRED) {
      if (!(f in fields) || !fields[f].join("").trim()) errors.push(`${where}: missing or empty field "${f}"`);
    }
    const comp = (fields.Component || [""])[0];
    if (PREFIX[m[1]] && comp && comp !== PREFIX[m[1]]) errors.push(`${where}: component "${comp}" does not match prefix ${m[1]} (${PREFIX[m[1]]})`);
    const size = (fields.Size || [""])[0];
    if (size && !SIZE_HOURS[size]) errors.push(`${where}: size must be S, M or L`);
    const ms = (fields.Milestone || [""])[0];
    if (ms && !/^M\d+$/.test(ms)) errors.push(`${where}: milestone must look like M1`);
    const deps = ((fields["Depends on"] || [""]).join(" ").match(/\b[A-Z]+-\d{3}\b/g) || []);
    const steps = (fields.Steps || []).filter((l) => /^\d+\./.test(l));
    if (fields.Steps && steps.length < 2) errors.push(`${where}: needs at least 2 numbered steps`);
    const acc = (fields.Acceptance || []).filter((l) => l.startsWith("- "));
    if (fields.Acceptance && acc.length < 1 && !(fields.Acceptance[0] || "").length) errors.push(`${where}: needs acceptance criteria`);
    const verify = (fields.Verify || []).join(" ");
    if (fields.Verify && !/`[^`]+`/.test(verify)) errors.push(`${where}: Verify must contain a command in backticks`);
    const fileList = [...(fields.Files || []).join(" ").matchAll(/`([^`]+)`/g)].map((x) => x[1].trim());
    if (fields.Files && !fileList.length) errors.push(`${where}: Files must list paths in backticks`);
    for (const p of fileList) {
      if (!ALLOWED_DIRS.some((d) => p === d || p.startsWith(d))) errors.push(`${where}: file "${p}" is outside the allowed directories`);
    }
    tasks.set(id, { id, file, title: m[3], component: comp, milestone: ms, size, deps, hours: SIZE_HOURS[size] || 4 });
  }
}

for (const t of tasks.values()) {
  for (const d of t.deps) {
    if (d === t.id) errors.push(`${t.file} ${t.id}: depends on itself`);
    else if (!tasks.has(d)) errors.push(`${t.file} ${t.id}: depends on unknown task ${d}`);
  }
}
// cycle detection + longest path
const state = new Map();
const best = new Map();
function visit(id, stack) {
  if (state.get(id) === 2) return best.get(id);
  if (state.get(id) === 1) {
    errors.push(`dependency cycle: ${[...stack, id].join(" -> ")}`);
    return { hours: 0, path: [] };
  }
  state.set(id, 1);
  const t = tasks.get(id);
  let top = { hours: 0, path: [] };
  for (const d of t.deps) {
    if (!tasks.has(d)) continue;
    const r = visit(d, [...stack, id]);
    if (r.hours > top.hours) top = r;
  }
  const res = { hours: top.hours + t.hours, path: [...top.path, id] };
  state.set(id, 2);
  best.set(id, res);
  return res;
}
let critical = { hours: 0, path: [] };
for (const id of tasks.keys()) {
  const r = visit(id, []);
  if (r.hours > critical.hours) critical = r;
}

const byComp = {};
const byMs = {};
let hours = 0;
for (const t of tasks.values()) {
  byComp[t.component] = (byComp[t.component] || 0) + 1;
  byMs[t.milestone] = (byMs[t.milestone] || 0) + 1;
  hours += t.hours;
}
console.log(`tasks: ${tasks.size}  estimated hours: ${hours}`);
console.log(`by component: ${JSON.stringify(byComp)}`);
console.log(`by milestone: ${JSON.stringify(Object.fromEntries(Object.entries(byMs).sort()))}`);
console.log(`critical path: ${critical.hours}h over ${critical.path.length} tasks: ${critical.path.join(" -> ")}`);
if (wantGraph) {
  console.log("\nflowchart LR");
  for (const t of tasks.values()) for (const d of t.deps) console.log(`  ${d.replace("-", "_")} --> ${t.id.replace("-", "_")}`);
}
console.log(`ERRORS: ${errors.length}`);
for (const e of errors.slice(0, 200)) console.log(`  - ${e}`);
process.exit(errors.length ? 1 : 0);
