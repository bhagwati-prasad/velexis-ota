#!/usr/bin/env node
// check-no-hardcoded-hosts: the apps and packages reach PostgreSQL, Redis and every other service through
// configuration only, never through a host or port written in the code (task X-032; decisions.md §2 "Hosting",
// ADR-0007 "Moving to managed services later", docs/mvp/deployment-single-vm.md §15).
//
// Usage:  node tools/ci/check-no-hardcoded-hosts.mjs [--root <dir>]      (default root: this repository)
//         --allow <file.json>  tests only: a JSON array of { file, code, why } that replaces ALLOWED below
//
// It reads every source file under platform/*/src, ota/*/src, packages/*/src and tools/reference-data/src (the
// reference data loader, which ships in the release and runs on the VM at every deploy) and exits 1, naming file,
// line and column, for each `localhost`, `127.0.0.1`, `:5432` or `:6379` (PostgreSQL's and Redis's default ports;
// spaces may follow the colon, as in `port: 5432`) in their code. Case does not matter. These do not count:
//   - comments: TypeScript's parser separates them from the code, so a URL in a comment or JSDoc is no finding,
//     while strings, template literals, regular expressions and JSX text are code;
//   - tests: *.test.* and *.spec.* files, the folders test, tests, __tests__ and __mocks__, and the whole of
//     packages/testing, the test-support package that is a devDependency only and never ships (ADR-0022 item 2);
//   - documentation and word lists (.md, .txt) and binary files (fonts, images). Templates, styles and data
//     (.hbs, .html, .css, .json, .sql, .yaml, .yml) are read line by line, comments included;
//   - the reviewed exceptions of ALLOWED below: a code fragment of one file, with the reason it is no service
//     location (the apps' own listen address on the VM's loopback, validation rules that recognise the loopback,
//     ...). An exception that matches nothing any more fails too, so the list cannot outlive the code.
// @velexis/config has no development-only defaults to exempt: no URL has a default (conventions.md §8), and the
// only defaults that hold a loopback address are the two Next.js listen addresses below, which are the VM's own.
// It also fails when it finds no source file at all, so it never passes by checking nothing.
//
// Plain Node 22 with the repository's own TypeScript (the root devDependency), so CI runs it after
// `pnpm install`. Tests: tools/ci/check-no-hardcoded-hosts.test.mjs. See tools/ci/README.md.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const { values } = parseArgs({ options: { root: { type: "string" }, allow: { type: "string" } } });
const ROOT = resolve(values.root ?? join(HERE, "..", ".."));
const ANNOTATE = process.env.GITHUB_ACTIONS === "true";

/** The folders whose `<name>/src` is checked: every app and every shared package. */
const COMPONENT_DIRS = ["platform", "ota", "packages"];
/**
 * Source folders of tools that ship in the release and reach a service: the reference data loader, which every deploy
 * runs on the VM with the DATABASE_URL of reference-loader.env (deployment-single-vm.md §8 and §15). The other tools
 * (the Amadeus stub, dev, e2e, perf, ci) never run on the VM.
 */
const RELEASE_TOOL_SOURCES = ["tools/reference-data/src"];
/** Whole packages that are test code: `@velexis/testing` is a devDependency only (ADR-0022 item 2). */
const TEST_PACKAGES = new Set(["packages/testing"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__"]);
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", ".next", ".turbo"]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SCRIPT_KINDS = new Map([
  [".ts", "TS"],
  [".mts", "TS"],
  [".cts", "TS"],
  [".tsx", "TSX"],
  [".js", "JS"],
  [".mjs", "JS"],
  [".cjs", "JS"],
  [".jsx", "JSX"],
]);
const TEXT_EXTENSIONS = new Set([".hbs", ".html", ".css", ".json", ".sql", ".yaml", ".yml"]);

/** What counts as a hard-coded host or port: the loopback's names and the services' default ports. */
const FINDING = /\blocalhost\b|(?<![\d.])127\.0\.0\.1(?!\d)|:[ \t]*(?:5432|6379)(?!\d)/gi;

// ---- Reviewed exceptions ------------------------------------------------------------------------------------
// Each entry: a fragment of one line of code (comments blanked), exactly as written, that holds a finding which is
// not a service location. Keep the fragments short, so that formatting elsewhere on the line does not matter.

const LISTEN =
  "the process's own listen address: every app binds the VM's loopback behind Caddy (architecture.md §3, " +
  "ADR-0007), which stays so with managed services; it is no service the app connects to";
const LOOPBACK_RULE =
  "a validation rule or its message that recognises the loopback as a value (http://localhost origins of test " +
  "keys, the Amadeus stub of development, the OTA admin's API on the same VM); it connects to nothing";
const FALLBACK_IP =
  "the end-user IP recorded when a request carries no X-Forwarded-For (local development without Caddy); an " +
  "address for the audit trail, not a host to connect to";
const SAME_VM =
  "the TLS probe asks the Caddy of its own VM which certificate it serves for a storefront host (PADR-0004 item 7); " +
  "Caddy stays on the VM when PostgreSQL and Redis move (deployment-single-vm.md §15)";
const DEV_ONLY =
  "a development-only command (`dev:seed`, refused with APP_ENV=production): its default and hints name the local " +
  "development stack";
const HELP_TEXT = "help text of a form field that names the loopback values the field's rule accepts";

/** @type {ReadonlyArray<{ file: string, code: string, why: string }>} */
const ALLOWED = Object.freeze([
  { file: "ota/admin/src/config.ts", code: '["127.0.0.1", "[::1]", "localhost"]', why: LOOPBACK_RULE },
  {
    file: "ota/admin/src/config.ts",
    code: "must point at the loopback interface (127.0.0.1, [::1] or localhost)",
    why: LOOPBACK_RULE,
  },
  { file: "ota/admin/src/lib/velexis.ts", code: 'FALLBACK_END_USER_IP = "127.0.0.1"', why: FALLBACK_IP },
  { file: "ota/backend/src/config.ts", code: '["127.0.0.1", "localhost", "[::1]"]', why: LOOPBACK_RULE },
  {
    file: "ota/backend/src/dev/dev-seed.command.ts",
    code: "http://localhost:4000/v1/storefront",
    why: DEV_ONLY,
  },
  { file: "ota/backend/src/main.ts", code: 'export const API_HOST = "127.0.0.1"', why: LISTEN },
  { file: "ota/backend/src/worker.ts", code: 'export const WORKER_HOST = "127.0.0.1"', why: LISTEN },
  {
    file: "platform/admin/src/lib/config.ts",
    code: 'HOSTNAME: env.string({ pattern: BIND_HOST, default: "127.0.0.1" })',
    why: LISTEN,
  },
  {
    file: "platform/admin/src/lib/end-user.ts",
    code: 'FALLBACK_END_USER_IP = "127.0.0.1"',
    why: FALLBACK_IP,
  },
  {
    file: "platform/admin/src/lib/strings.ts",
    code: "The local Amadeus stub (http://127.0.0.1:4900) works in development only.",
    why: HELP_TEXT,
  },
  {
    file: "platform/backend/src/api-keys/api-key-rules.ts",
    code: 'new Set(["localhost", "127.0.0.1"])',
    why: LOOPBACK_RULE,
  },
  {
    file: "platform/backend/src/api-keys/api-key-rules.ts",
    code: "http is allowed only for http://localhost:<port> and http://127.0.0.1:<port> on test keys",
    why: LOOPBACK_RULE,
  },
  {
    file: "platform/backend/src/dev/dev-seed.command.ts",
    code: 'DEV_SEED_DEFAULT_AMADEUS_BASE_URL = "http://127.0.0.1:4900"',
    why: DEV_ONLY,
  },
  {
    file: "platform/backend/src/dev/dev-seed.command.ts",
    code: "the loopback Amadeus stub http://127.0.0.1:<port>",
    why: DEV_ONLY,
  },
  {
    file: "platform/backend/src/domains/tls-probe.ts",
    code: 'DEFAULT_TLS_PROBE_TARGET: TlsProbeTarget = Object.freeze({ host: "127.0.0.1", port: 443 })',
    why: SAME_VM,
  },
  { file: "platform/backend/src/main.ts", code: 'export const API_HOST = "127.0.0.1"', why: LISTEN },
  {
    file: "platform/backend/src/worker.ts",
    code: 'export const WORKER_HEALTH_HOST = "127.0.0.1"',
    why: LISTEN,
  },
  {
    file: "platform/frontend/src/components/origins-field.tsx",
    code: 'new Set(["localhost", "127.0.0.1"])',
    why: LOOPBACK_RULE,
  },
  {
    file: "platform/frontend/src/lib/config.ts",
    code: 'HOSTNAME: env.string({ pattern: BIND_HOST, default: "127.0.0.1" })',
    why: LISTEN,
  },
  {
    file: "platform/frontend/src/lib/end-user.ts",
    code: 'FALLBACK_END_USER_IP = "127.0.0.1"',
    why: FALLBACK_IP,
  },
  {
    file: "platform/frontend/src/lib/strings.ts",
    code: "On test keys http://localhost:<port> and http://127.0.0.1:<port> work too.",
    why: HELP_TEXT,
  },
  {
    file: "platform/frontend/src/lib/strings.ts",
    code: "Plain http works only for http://localhost:<port> and http://127.0.0.1:<port>.",
    why: HELP_TEXT,
  },
]);

/** ALLOWED, or the test list of --allow; every entry needs a file, a code fragment and a reason. */
function exceptions() {
  let list = ALLOWED;
  if (values.allow !== undefined) {
    try {
      list = JSON.parse(readFileSync(values.allow, "utf8"));
    } catch (error) {
      console.log(`check-no-hardcoded-hosts: cannot read --allow ${values.allow}: ${error.message}`);
      process.exit(1);
    }
  }
  const valid = (entry) =>
    entry !== null &&
    typeof entry === "object" &&
    ["file", "code", "why"].every((key) => typeof entry[key] === "string" && entry[key].trim() !== "");
  if (!Array.isArray(list) || !list.every(valid)) {
    console.log("check-no-hardcoded-hosts: every exception needs a file, a code fragment and a reason (why)");
    process.exit(1);
  }
  return list;
}

// ---- TypeScript ----------------------------------------------------------------------------------------------

function loadTypeScript() {
  try {
    return createRequire(import.meta.url)("typescript");
  } catch {
    console.log(
      "check-no-hardcoded-hosts: TypeScript is not installed. Run `pnpm install` first (the root devDependency).",
    );
    process.exit(1);
  }
}
const ts = loadTypeScript();

/**
 * The text of `file` with every comment blanked: each character outside a token becomes a space, line breaks stay,
 * so lines and columns are those of the file. Tokens are the leaves of TypeScript's syntax tree; JSDoc is not
 * parsed, so it stays a comment.
 */
function codeOnly(file, text, kind) {
  const source = ts.createSourceFile(
    file,
    text,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
    ts.ScriptKind[kind],
  );
  const code = new Uint8Array(text.length);
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(source);
    if (children.length === 0) {
      code.fill(1, node.getStart(source), node.getEnd());
      return;
    }
    for (const child of children) {
      visit(child);
    }
  };
  visit(source);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    out += code[i] === 1 || ch === "\n" || ch === "\r" ? ch : " ";
  }
  return out;
}

// ---- Files ---------------------------------------------------------------------------------------------------

const toPosix = (path) => path.split(sep).join("/");

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every checked file under `dir` (absolute), tests and skipped folders left out, sorted. */
function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && !TEST_DIRS.has(entry.name)) {
        walk(path, files);
      }
    } else if (entry.isFile() && !TEST_FILE.test(entry.name)) {
      const ext = extname(entry.name).toLowerCase();
      if (SCRIPT_KINDS.has(ext) || TEXT_EXTENSIONS.has(ext)) {
        files.push(path);
      }
    }
  }
  return files;
}

function sourceFolders() {
  const folders = [];
  for (const top of COMPONENT_DIRS) {
    for (const name of listDirs(join(ROOT, top))) {
      const rel = `${top}/${name}`;
      const src = join(ROOT, top, name, "src");
      if (TEST_PACKAGES.has(rel)) {
        continue;
      }
      try {
        if (statSync(src).isDirectory()) {
          folders.push(src);
        }
      } catch {
        // No src folder: nothing to check in this component.
      }
    }
  }
  for (const rel of RELEASE_TOOL_SOURCES) {
    const src = join(ROOT, ...rel.split("/"));
    try {
      if (statSync(src).isDirectory()) {
        folders.push(src);
      }
    } catch {
      // Not in this tree (the tests' small trees): nothing to check.
    }
  }
  return folders;
}

// ---- Check ---------------------------------------------------------------------------------------------------

const problems = [];
const allowed = exceptions();
const used = new Set();
const allowedByFile = new Map();
for (const [index, entry] of allowed.entries()) {
  const list = allowedByFile.get(entry.file) ?? [];
  list.push({ ...entry, index });
  allowedByFile.set(entry.file, list);
}

/** The exception of `file` whose fragment covers [start, end) of `line`, or undefined. */
function exceptionFor(file, line, start, end) {
  for (const entry of allowedByFile.get(file) ?? []) {
    for (let at = line.indexOf(entry.code); at !== -1; at = line.indexOf(entry.code, at + 1)) {
      if (at <= start && end <= at + entry.code.length) {
        return entry;
      }
    }
  }
  return undefined;
}

const folders = sourceFolders();
const files = folders.flatMap((folder) => walk(folder, []));
for (const path of files) {
  const file = toPosix(relative(ROOT, path));
  const text = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  const kind = SCRIPT_KINDS.get(ext);
  const lines = (kind === undefined ? text : codeOnly(file, text, kind)).split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(FINDING)) {
      const start = match.index;
      const exception = exceptionFor(file, line, start, start + match[0].length);
      if (exception === undefined) {
        problems.push({
          file,
          line: index + 1,
          column: start + 1,
          message:
            `${JSON.stringify(match[0])} in code: reach a service through a DSN or URL of the configuration, ` +
            "never a host or port written in the code (decisions.md §2). If this is no service location, add " +
            "a reviewed exception to ALLOWED in tools/ci/check-no-hardcoded-hosts.mjs.",
        });
      } else {
        used.add(exception.index);
      }
    }
  });
}

for (const [index, entry] of allowed.entries()) {
  if (!used.has(index)) {
    problems.push({
      file: entry.file,
      message:
        `the reviewed exception ${JSON.stringify(entry.code)} matches no finding any more: remove it from ALLOWED ` +
        "in tools/ci/check-no-hardcoded-hosts.mjs",
    });
  }
}
if (files.length === 0) {
  problems.push({
    file: ".",
    message:
      "found no source file under platform/*/src, ota/*/src, packages/*/src or tools/reference-data/src: " +
      "nothing was checked",
  });
}

// Workflow-command escaping (as @actions/core does), so that file content cannot start a command of its own.
const escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
for (const { file, line, column, message } of problems) {
  if (ANNOTATE) {
    const where = `file=${escapeProperty(file)}${line ? `,line=${line},col=${column}` : ""}`;
    console.log(`::error ${where}::${escapeData(message)}`);
  } else {
    console.log(`error: ${file}${line ? `:${line}:${column}` : ""}: ${message}`);
  }
}
console.log(
  `check-no-hardcoded-hosts: ${files.length} file(s) in ${folders.length} source folder(s), ` +
    `${allowed.length} reviewed exception(s), ${problems.length} problem(s)`,
);
process.exitCode = problems.length > 0 ? 1 : 0;
