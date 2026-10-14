#!/usr/bin/env node
// plan-lint: validates the Markdown agent-task plans of the Velexis MVP and reports progress (README.md next to it).
//
// Usage:  node tools/plan-lint/plan-lint.mjs [--graph] [--remaining] [file ...]
//         (default files: docs/mvp/plans/foundation-tasks.md, platform/docs/plans/agent-tasks.md, ota/docs/plans/agent-tasks.md)
//   --graph      also print the dependency graph as a Mermaid flowchart
//   --remaining  instead of the two summary blocks, print the ready tasks of the lowest open milestone (every
//                dependency done), critical path first: the list AGENTS.md §3 asks agents to pick from
//
// Task block format (one per task):
//   ### PBE-012 · Short imperative title          (a done task ends with " ✅": "### PBE-012 · Short imperative title ✅")
//   - **Status:** in progress (PR #n)            (optional: todo | in progress (PR #n) | done (PR #n))
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
// under an allowed top-level directory, milestone format, done marker (ADR-0025 item 6): " ✅" only at the end of the
// heading, and when a task has a Status line, " ✅" without a done status or a done status without " ✅" is an error.
// A done status is "done (PR #n)", or "done (branch <name>)" for work integrated on a branch without per-task PRs.
// Prints counts and the critical path, then done and total tasks and hours per milestone and per file, the remaining
// hours and the critical path of the tasks without " ✅" (done tasks count 0 h). Exit codes: 0 no errors, 1 errors,
// 2 bad usage. Plain Node, no dependencies: CI runs it without `pnpm install`.
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
const DONE_MARK = " ✅";
const DONE_STATUS = /^done \((?:PR #\d+|branch [^\s()]+)\)$/;
const USAGE = "usage: node tools/plan-lint/plan-lint.mjs [--graph] [--remaining] [file ...]";
const OPTIONS = ["--graph", "--remaining", "--help"];

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
const unknownOptions = args.filter((a) => a.startsWith("-") && !OPTIONS.includes(a));
if (unknownOptions.length) {
  console.error(`unknown option ${unknownOptions.join(", ")}\n${USAGE}`);
  process.exit(2);
}
const wantGraph = args.includes("--graph");
const wantRemaining = args.includes("--remaining");
const files = args.filter((a) => !a.startsWith("-"));
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
    const done = m[3].endsWith(DONE_MARK);
    const title = done ? m[3].slice(0, -DONE_MARK.length) : m[3];
    if (title.includes("✅")) errors.push(`${where}: misplaced done marker in the heading (" ✅" goes at the very end)`);
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
    const status = (fields.Status || []).join(" ");
    if ("Status" in fields) {
      if (done && !DONE_STATUS.test(status)) errors.push(`${where}: the heading ends with " ✅" but the status is "${status}" (expected "done (PR #n)")`);
      if (!done && /^done\b/i.test(status)) errors.push(`${where}: the status is "${status}" but the heading does not end with " ✅"`);
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
    tasks.set(id, { id, file, title, component: comp, milestone: ms, size, deps, hours: SIZE_HOURS[size] || 4, done, status });
  }
}

for (const t of tasks.values()) {
  for (const d of t.deps) {
    if (d === t.id) errors.push(`${t.file} ${t.id}: depends on itself`);
    else if (!tasks.has(d)) errors.push(`${t.file} ${t.id}: depends on unknown task ${d}`);
  }
}
// Longest path in hours over the dependencies. weight(task) is its hours; a task of weight 0 adds nothing and is left
// out of the path. The first pass (all hours) also reports cycles; the second (done tasks count 0 h) does not repeat them.
function longestPath(weight, reportCycles) {
  const state = new Map();
  const best = new Map();
  function visit(id, stack) {
    if (state.get(id) === 2) return best.get(id);
    if (state.get(id) === 1) {
      if (reportCycles) errors.push(`dependency cycle: ${[...stack, id].join(" -> ")}`);
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
    const w = weight(t);
    const res = { hours: top.hours + w, path: w ? [...top.path, id] : top.path };
    state.set(id, 2);
    best.set(id, res);
    return res;
  }
  let critical = { hours: 0, path: [] };
  for (const id of tasks.keys()) {
    const r = visit(id, []);
    if (r.hours > critical.hours) critical = r;
  }
  return critical;
}
const critical = longestPath((t) => t.hours, true);
const remainingHours = (t) => (t.done ? 0 : t.hours);
const remainingCritical = longestPath(remainingHours, false);

const msNumber = (ms) => (/^M\d+$/.test(ms) ? Number(ms.slice(1)) : Infinity);
const byMilestone = (a, b) => msNumber(a) - msNumber(b) || a.localeCompare(b);

if (!wantRemaining) printSummary();
else printRemaining();
if (wantGraph) {
  console.log("\nflowchart LR");
  for (const t of tasks.values()) for (const d of t.deps) console.log(`  ${d.replace("-", "_")} --> ${t.id.replace("-", "_")}`);
}
console.log(`ERRORS: ${errors.length}`);
for (const e of errors.slice(0, 200)) console.log(`  - ${e}`);
process.exit(errors.length ? 1 : 0);

function printSummary() {
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

  // Second block: progress by the done markers.
  const tally = (list) => {
    const s = { tasks: 0, done: 0, hours: 0, doneHours: 0 };
    for (const t of list) {
      s.tasks += 1;
      s.hours += t.hours;
      if (t.done) {
        s.done += 1;
        s.doneHours += t.hours;
      }
    }
    return s;
  };
  const all = [...tasks.values()];
  const total = tally(all);
  const per = (key, keys) => keys.map((k) => {
    const s = tally(all.filter((t) => t[key] === k));
    return `${k} ${s.done}/${s.tasks} ${s.doneHours}/${s.hours}h`;
  }).join(", ");
  console.log("");
  console.log(`done tasks: ${total.done}/${total.tasks}  done hours: ${total.doneHours}/${total.hours}  remaining tasks: ${total.tasks - total.done}  remaining hours: ${total.hours - total.doneHours}`);
  console.log(`done by milestone (tasks, hours): ${per("milestone", [...new Set(all.map((t) => t.milestone))].sort(byMilestone))}`);
  console.log(`done by file (tasks, hours): ${per("file", targets)}`);
  if (total.done === total.tasks) console.log("remaining critical path: none, every task is done");
  else console.log(`remaining critical path: ${remainingCritical.hours}h over ${remainingCritical.path.length} tasks: ${remainingCritical.path.join(" -> ")}`);
}

function printRemaining() {
  const isDone = (id) => tasks.has(id) && tasks.get(id).done;
  const open = [...tasks.values()].filter((t) => !t.done && /^M\d+$/.test(t.milestone));
  if (!open.length) {
    console.log("remaining: none, every task is done");
    return;
  }
  const lowest = open.map((t) => t.milestone).sort(byMilestone)[0];
  const inMilestone = [...tasks.values()].filter((t) => t.milestone === lowest);
  const openInMilestone = inMilestone.filter((t) => !t.done);
  const ready = openInMilestone.filter((t) => t.deps.every(isDone));
  const waiting = openInMilestone.filter((t) => !t.deps.every(isDone));

  // chain(id): hours of the longest chain of open tasks that starts with the task and follows its dependents.
  const dependents = new Map([...tasks.keys()].map((id) => [id, []]));
  for (const t of tasks.values()) for (const d of t.deps) if (dependents.has(d)) dependents.get(d).push(t.id);
  const chains = new Map();
  const visiting = new Set();
  const chain = (id) => {
    if (chains.has(id)) return chains.get(id);
    if (visiting.has(id)) return 0; // a cycle, already reported
    visiting.add(id);
    let longest = 0;
    for (const c of dependents.get(id)) longest = Math.max(longest, chain(c));
    visiting.delete(id);
    const hours = remainingHours(tasks.get(id)) + longest;
    chains.set(id, hours);
    return hours;
  };
  const onPath = new Set(remainingCritical.path);
  ready.sort((a, b) => Number(onPath.has(b.id)) - Number(onPath.has(a.id)) || chain(b.id) - chain(a.id) || b.hours - a.hours);

  console.log(`lowest open milestone: ${lowest} (${openInMilestone.length} of ${inMilestone.length} tasks open, ${ready.length} ready)`);
  console.log("ready tasks (every dependency done), critical path first; * = on the remaining critical path, chain = hours of the longest open chain the task starts:");
  for (const t of ready) {
    const claimed = /^in progress\b/i.test(t.status) ? "  [in progress]" : "";
    console.log(`${onPath.has(t.id) ? "*" : " "} ${t.id}  ${t.size} ${t.hours}h  chain ${chain(t.id)}h  ${t.title}${claimed}  (${t.file})`);
  }
  if (!ready.length) console.log("  none: every open task of the milestone waits for a dependency");
  if (waiting.length) {
    console.log("waiting for dependencies:");
    for (const t of waiting) console.log(`  ${t.id} waits for ${t.deps.filter((d) => !isDone(d)).join(", ")}`);
  }
}
