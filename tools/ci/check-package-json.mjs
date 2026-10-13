#!/usr/bin/env node
// check-package-json: repository rules for the package.json files and the GitHub workflows (task X-019).
//
// Usage:  node tools/ci/check-package-json.mjs [--root <dir>]      (default root: this repository)
//
// It exits 1 and names every offending file when:
//   1. a dependency in any workspace package.json (the root one included) is not an exact version
//      (ADR-0002 item 7): a `^` or `~` range, any other range, a dist-tag, a URL or a path. The only other
//      accepted form is `workspace:*`. The root "packageManager" must name an exact pnpm version;
//   2. @velexis/testing or @velexis/amadeus-stub is listed anywhere but in devDependencies (ADR-0022 item 2);
//   3. a package under packages/ depends on an app: a workspace package under platform/ or ota/, or any
//      @velexis/platform-* or @velexis/ota-* name (ADR-0002 item 5);
//   4. a `uses:` in .github/workflows/ (or .github/actions/) is not pinned to a full 40-character commit SHA
//      with the tag in a comment (ADR-0023). Dependabot keeps both current (.github/dependabot.yml).
// It also fails when it cannot read what it checks (a pnpm-workspace.yaml without a block list of packages, a
// package.json that is not JSON, a `uses:` in a flow mapping), so it never passes by checking nothing.
//
// Plain Node 22 without dependencies, so CI runs it before `pnpm install`. See tools/ci/README.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const DEV_ONLY = new Set(["@velexis/testing", "@velexis/amadeus-stub"]);
const APP_DIRS = new Set(["platform", "ota"]);
const APP_NAME = /^@velexis\/(?:platform|ota)-/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_MANAGER = /^pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[0-9a-f]+)?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const TAG_COMMENT = /^#\s*(v?\d+(?:\.\d+)*)(.*)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);

const { values } = parseArgs({ options: { root: { type: "string" } } });
const ROOT = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const ANNOTATE = process.env.GITHUB_ACTIONS === "true";

const problems = [];
const warnings = [];
const report = (list, file, message, line) => list.push({ file, line, message });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// ---- Workspace packages ---------------------------------------------------------------------------------

/**
 * The `packages:` globs of pnpm-workspace.yaml (a block list of strings; no YAML library needed). A missing
 * file, a flow list (`packages: [...]`) or an empty list is a problem: otherwise no workspace package would be
 * checked and the script would pass on the root package.json alone.
 */
function workspacePatterns() {
  const file = join(ROOT, "pnpm-workspace.yaml");
  const patterns = [];
  let inPackages = false;
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  for (const raw of lines) {
    if (/^\s*(?:#|$)/.test(raw)) {
      continue;
    }
    if (/^\S/.test(raw)) {
      inPackages = /^packages:\s*(?:#.*)?$/.test(raw);
      continue;
    }
    const item = inPackages ? raw.match(/^\s+-\s+(["']?)([^"'#\s]+)\1\s*(?:#.*)?$/) : null;
    if (item) {
      patterns.push(item[2]);
    } else if (inPackages) {
      report(
        problems,
        "pnpm-workspace.yaml",
        `cannot read the workspace entry ${JSON.stringify(raw.trim())}`,
      );
    }
  }
  if (patterns.length === 0) {
    report(
      problems,
      "pnpm-workspace.yaml",
      'lists no workspace packages: write one "- <glob>" per line under "packages:"',
    );
  }
  return patterns;
}

/** pnpm workspace globs use `*` (one path segment) and `**` (any depth); `!` excludes. */
function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      source += ".*";
      i += 1;
    } else if (c === "*") {
      source += "[^/]*";
    } else {
      source += c.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** Every directory of the repository (relative, `/`-separated) without dependencies, build output or dot folders. */
function listDirs(dir = "") {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        out.push(child);
        walk(child);
      }
    }
  };
  if (existsSync(join(ROOT, dir))) {
    walk(dir);
  }
  return out;
}

function workspaceDirs() {
  const patterns = workspacePatterns().map((p) => p.replace(/^(!?)\.\//, "$1").replace(/\/+$/, ""));
  const include = patterns.filter((p) => !p.startsWith("!")).map(globToRegExp);
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => globToRegExp(p.slice(1)));
  return listDirs()
    .filter((dir) => include.some((re) => re.test(dir)) && !exclude.some((re) => re.test(dir)))
    .filter((dir) => existsSync(join(ROOT, dir, "package.json")))
    .sort();
}

function readManifest(rel) {
  try {
    const value = JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
    if (isObject(value)) {
      return value;
    }
    report(problems, rel, "is not a JSON object");
  } catch (err) {
    report(problems, rel, `cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

// ---- Rules 1 to 3: package.json -------------------------------------------------------------------------

/** Why a dependency spec is not an exact version, or null when it is fine (ADR-0002 item 7). */
function specProblem(spec) {
  if (typeof spec !== "string") {
    return "is not a version string";
  }
  if (spec === "workspace:*" || EXACT_VERSION.test(spec)) {
    return null;
  }
  const alias = spec.match(/^npm:(@?[^@]+)@(.+)$/);
  if (alias && EXACT_VERSION.test(alias[2])) {
    return null;
  }
  if (/[\^~]/.test(spec)) {
    return "is a ^ or ~ range; versions are exact (ADR-0002 item 7)";
  }
  return 'is not an exact version; versions are exact and workspace packages use "workspace:*" (ADR-0002 item 7)';
}

function checkManifest(dir, pkg, apps) {
  const file = dir === "." ? "package.json" : `${dir}/package.json`;
  const isSharedPackage = dir.split("/")[0] === "packages";
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (deps === undefined) {
      continue;
    }
    if (!isObject(deps)) {
      report(problems, file, `"${field}" is not an object`);
      continue;
    }
    for (const [name, spec] of Object.entries(deps)) {
      const why = specProblem(spec);
      if (why) {
        report(problems, file, `${field} "${name}": ${JSON.stringify(spec)} ${why}`);
      }
      if (DEV_ONLY.has(name) && field !== "devDependencies") {
        report(problems, file, `"${name}" is in ${field}; it is a devDependency only (ADR-0022 item 2)`);
      }
      if (isSharedPackage && (apps.has(name) || APP_NAME.test(name))) {
        const where = apps.has(name) ? ` (${apps.get(name)})` : "";
        report(
          problems,
          file,
          `${field} "${name}" is an app${where}; packages never depend on apps (ADR-0002 item 5)`,
        );
      }
    }
  }
  const overrides = isObject(pkg.pnpm) ? pkg.pnpm.overrides : undefined;
  if (overrides !== undefined && !isObject(overrides)) {
    report(problems, file, `"pnpm.overrides" is not an object`);
  }
  for (const [selector, spec] of Object.entries(isObject(overrides) ? overrides : {})) {
    // pnpm also accepts "$<name>" (the version of a direct dependency) and "-" (remove the dependency).
    const why =
      typeof spec === "string" && (/^\$[^\s]+$/.test(spec) || spec === "-") ? null : specProblem(spec);
    if (why) {
      report(problems, file, `pnpm.overrides "${selector}": ${JSON.stringify(spec)} ${why}`);
    }
  }
  if (dir === "." && !PACKAGE_MANAGER.test(String(pkg.packageManager ?? ""))) {
    report(problems, file, `"packageManager" must be an exact "pnpm@x.y.z" (ADR-0002 item 1)`);
  }
}

// ---- Rule 4: GitHub workflow pins -----------------------------------------------------------------------

function workflowFiles() {
  const files = [];
  const workflows = ".github/workflows";
  if (existsSync(join(ROOT, workflows))) {
    for (const entry of readdirSync(join(ROOT, workflows), { withFileTypes: true })) {
      if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
        files.push(`${workflows}/${entry.name}`);
      }
    }
  }
  // Composite actions of this repository pin their own `uses:` too.
  for (const dir of [".github/actions", ...listDirs(".github/actions")]) {
    for (const name of ["action.yml", "action.yaml"]) {
      if (existsSync(join(ROOT, dir, name))) {
        files.push(`${dir}/${name}`);
      }
    }
  }
  return files.sort();
}

function checkWorkflow(file) {
  const lines = readFileSync(join(ROOT, file), "utf8").split(/\r?\n/);
  lines.forEach((text, index) => {
    const line = index + 1;
    const uses = text.match(/^\s*(?:-\s+)?(["']?)uses\1\s*:\s*(.*)$/);
    if (!uses) {
      // A flow mapping (`- { uses: ... }`) would hide its reference from this line-based reader: fail closed.
      if (/^\s*(?:-\s+)?\{.*\buses["']?\s*:/.test(text)) {
        report(problems, file, `write "uses:" as a block mapping key, not in a flow mapping {...}`, line);
      }
      return;
    }
    const parts = uses[2].match(/^(["']?)([^"'\s#]+)\1\s*(#.*)?$/);
    if (!parts) {
      report(problems, file, `cannot read the action reference ${JSON.stringify(uses[2])}`, line);
      return;
    }
    const [, , ref, comment = ""] = parts;
    if (ref.startsWith("./")) {
      return; // an action of this repository, at the same commit
    }
    if (ref.startsWith("docker://")) {
      if (!DOCKER_DIGEST.test(ref)) {
        report(problems, file, `"${ref}" is not pinned to an image digest (@sha256:...) (ADR-0023)`, line);
      }
      return;
    }
    const at = ref.lastIndexOf("@");
    if (at < 0 || !FULL_SHA.test(ref.slice(at + 1))) {
      report(problems, file, `"${ref}" is not pinned to a full 40-character commit SHA (ADR-0023)`, line);
      return;
    }
    const tag = comment.trim().match(TAG_COMMENT);
    if (!tag) {
      report(
        problems,
        file,
        `"${ref}" needs the tag of that commit in a comment, e.g. "# v4.2.0" (ADR-0023)`,
        line,
      );
    } else if (tag[2].trim() !== "") {
      report(
        warnings,
        file,
        `the comment after "${ref}" has text after ${tag[1]}; Dependabot updates the tag only when the comment ends with it`,
        line,
      );
    }
  });
}

// ---- Main -----------------------------------------------------------------------------------------------

const dirs = [".", ...workspaceDirs()];
const manifests = new Map();
for (const dir of dirs) {
  const pkg = readManifest(dir === "." ? "package.json" : `${dir}/package.json`);
  if (pkg) {
    manifests.set(dir, pkg);
  }
}
const apps = new Map();
for (const [dir, pkg] of manifests) {
  if (APP_DIRS.has(dir.split("/")[0]) && typeof pkg.name === "string") {
    apps.set(pkg.name, dir);
  }
}
for (const [dir, pkg] of manifests) {
  checkManifest(dir, pkg, apps);
}
const workflows = workflowFiles();
for (const file of workflows) {
  checkWorkflow(file);
}

// Workflow-command escaping (as @actions/core does), so that a newline in a package.json key cannot start a
// command of its own.
const escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
const print = (level, { file, line, message }) => {
  if (ANNOTATE) {
    const where = `file=${escapeProperty(file)}${line ? `,line=${line}` : ""}`;
    console.log(`::${level} ${where}::${escapeData(message)}`);
  } else {
    console.log(`${level}: ${file}${line ? `:${line}` : ""}: ${message}`);
  }
};
warnings.forEach((w) => print("warning", w));
problems.forEach((p) => print("error", p));
console.log(
  `check-package-json: ${dirs.length} package.json file(s), ${workflows.length} workflow file(s), ` +
    `${problems.length} problem(s), ${warnings.length} warning(s)`,
);
process.exitCode = problems.length > 0 ? 1 : 0;
