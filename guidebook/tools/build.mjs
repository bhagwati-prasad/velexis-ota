#!/usr/bin/env node
/*
 * Velexis Guidebook builder (zero dependencies, Node 24).
 *
 *   node tools/build.mjs [--content <dir>] [--out <file>] [--check] [--strict] [--repo <dir>|none] [--force] [--quiet]
 *
 * Reads content/ (front-matter markdown and JSON), validates every cross reference, computes backlinks, the search
 * index, the knowledge graph and statistics, and writes dist/content.js as `window.VG_CONTENT = {...};`.
 * The output is deterministic: the same content always gives the same bytes (no timestamps, stable ordering).
 *
 *   --check   build in memory and fail when the existing output differs (stale dist).
 *   --strict  warnings fail the build too.
 *   --repo    repository root used to check `repo:` paths (default: the parent or grandparent of the guidebook folder
 *             when it contains pnpm-workspace.yaml; "none" disables the check).
 *   --force   write the output even when there are errors (the exit code is still 1).
 *
 * Known issues (content/issues/*.json, arrays merged like the glossary) are validated too: ids, enums, apps, journeys
 * and steps, glossary terms, and (with a repository root) every repo path and the line numbers in `where`.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const GUIDE_DIR = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_CONTENT = path.join(GUIDE_DIR, "content");
export const DEFAULT_OUT = path.join(GUIDE_DIR, "dist", "content.js");
export const BUILDER_VERSION = 1;

export const APP_KINDS = ["frontend", "backend", "worker", "library", "tooling", "infrastructure"];
export const PRODUCTS = ["platform", "ota", "shared"];
export const TERM_CATEGORIES = [
  "product",
  "travel",
  "payments",
  "identity",
  "tenancy",
  "data",
  "api",
  "security",
  "operations",
  "engineering",
  "process",
];
export const DIAGRAM_TYPES = ["component", "sequence", "state", "er", "flow", "tree"];
const COMPONENT_KINDS = ["ui", "api", "worker", "db", "cache", "queue", "external", "lib", "user", "edge"];
const EDGE_KINDS = ["sync", "async", "data"];
const STEP_KINDS = ["call", "return", "async", "self"];
const STATE_KINDS = ["initial", "normal", "final", "error"];
const ER_SCHEMAS = ["platform", "tenant", "reference", "redis"];
const FIELD_KEYS = ["pk", "fk", "uk"];
const CARDINALITIES = ["1-1", "1-n", "n-n"];
const TOPOLOGY_KINDS = ["user", "edge", "ui", "api", "worker", "db", "cache", "queue", "storage", "external"];
export const GRAPH_KINDS = ["app", "term", "class", "individual", "page", "journey", "issue"];
export const ISSUE_SEVERITIES = ["critical", "high", "medium", "low"];
export const ISSUE_KINDS = ["bug", "db", "security", "ux", "docs", "perf"];
export const ISSUE_STATUSES = ["confirmed", "plausible"];
const ISSUE_ID = /^KI-\d{3,}$/;
const ISSUE_FIELDS = [
  "id",
  "title",
  "app",
  "severity",
  "kind",
  "status",
  "where",
  "summary",
  "reproduce",
  "expected",
  "actual",
  "fix",
  "files",
  "newFiles",
  "migration",
  "journey",
  "step",
  "terms",
];
const CALLOUTS = ["tip", "note", "warning", "bug-hunt"];
const TRY_KEYS = ["url", "login", "password", "command", "expect"];
const LINK_KINDS = ["app", "page", "journey", "diagram", "term"];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* ------------------------------------------------------------------------------------------------ text helpers */

function loadTextHelpers() {
  const file = path.join(GUIDE_DIR, "assets", "js", "core", "text.js");
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context.VG.text;
}
const TEXT = loadTextHelpers();
export const { slugify, plainInline, plainMarkdown, createSlugger } = TEXT;

/** Code-unit comparison: independent of the machine's locale, so ordering is reproducible everywhere. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function cmpCi(a, b) {
  return cmp(String(a).toLowerCase(), String(b).toLowerCase()) || cmp(String(a), String(b));
}
function words(text) {
  const m = String(text || "").match(/\S+/g);
  return m ? m.length : 0;
}
function clip(text, n) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}
function asArray(v) {
  return Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
}

/* ------------------------------------------------------------------------------------------------ reporting */

function createReport(contentDir) {
  const errors = [];
  const warnings = [];
  const rel = (file) => (file ? path.relative(contentDir, file).split(path.sep).join("/") : "content");
  const fmt = (file, msg, where) => `${rel(file)}${where ? ":" + where : ""}: ${msg}`;
  return {
    errors,
    warnings,
    rel,
    error(file, msg, where) {
      errors.push(fmt(file, msg, where));
    },
    warn(file, msg, where) {
      warnings.push(fmt(file, msg, where));
    },
  };
}

/* ------------------------------------------------------------------------------------------------ reading */

function listDir(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => !d.name.startsWith("."))
    .filter(filter || (() => true))
    .map((d) => d.name)
    .sort(cmp);
}
const isFile = (ext) => (d) => d.isFile() && d.name.endsWith(ext);
const isDir = (d) => d.isDirectory();

function readText(file) {
  return fs
    .readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

function readJson(file, report) {
  try {
    return JSON.parse(readText(file));
  } catch (err) {
    report.error(file, `invalid JSON: ${err.message}`);
    return null;
  }
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Front matter: `---` block of `key: value` scalars and `key: [a, b]` lists (SCHEMA §2). */
export function parseFrontMatter(source, file, report) {
  const lines = source.split("\n");
  if (lines[0].trim() !== "---") {
    report.error(file, "missing front matter (the file must start with a --- line)", 1);
    return { data: {}, body: source, bodyLine: 1 };
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) {
    report.error(file, "front matter is not closed with a --- line", 1);
    return { data: {}, body: "", bodyLine: lines.length + 1 };
  }
  const data = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      report.error(file, `invalid front matter line: ${line.trim()}`, i + 1);
      continue;
    }
    const [, key, raw] = m;
    const value = raw.trim();
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) {
        report.error(file, `front matter list "${key}" is not closed with ]`, i + 1);
        continue;
      }
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map(unquote)
        .filter((s) => s !== "");
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      data[key] = Number(value);
    } else if (value === "true" || value === "false") {
      data[key] = value === "true";
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body: lines.slice(end + 1).join("\n"), bodyLine: end + 2 };
}

/* ------------------------------------------------------------------------------------------------ markdown scan */

const REF_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/g;
const CODE_RE = /`([^`\n]+)`/g;
const MDLINK_RE = /\]\(\s*((?:repo:|#\/)[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

function parseRefTarget(inner) {
  const raw = inner.trim();
  const m = /^([a-z]+):(.+)$/.exec(raw);
  if (m && LINK_KINDS.includes(m[1])) return { kind: m[1], id: m[2].trim() };
  return { kind: "term", id: raw };
}

function scanInline(line, where, acc) {
  let rest = line.replace(CODE_RE, (_, code) => {
    const c = code.trim();
    if (c.startsWith("repo:")) acc.repo.push({ path: c.slice(5).trim(), where });
    return " ".repeat(code.length + 2);
  });
  for (const m of rest.matchAll(MDLINK_RE)) {
    const target = m[1];
    if (target.startsWith("repo:")) acc.repo.push({ path: target.slice(5), where });
    else acc.hash.push({ route: target, where });
  }
  rest = rest.replace(MDLINK_RE, "");
  for (const m of rest.matchAll(REF_RE)) {
    acc.refs.push({ ...parseRefTarget(m[1]), raw: m[0], where });
  }
}

/**
 * Scans a markdown body: headings (with the same slugs as the browser), [[links]], repo: paths, internal #/ links,
 * diagram blocks, callouts and try cards, and the text of each section for the search index.
 */
export function scanMarkdown(body, startLine = 1, file = null, report = null) {
  const acc = {
    headings: [],
    refs: [],
    repo: [],
    hash: [],
    diagrams: [],
    sections: [],
    tries: 0,
    callouts: 0,
  };
  const slug = createSlugger();
  let section = { slug: "", title: "", depth: 0, lines: [] };
  acc.sections.push(section);
  const lines = body.split("\n");
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = startLine + i;
    const fm = /^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && !fm[2]) {
        if (fence.lang === "diagram") {
          const id = fence.body.map((l) => l.trim()).find(Boolean);
          if (id) acc.diagrams.push({ id, where: fence.line });
          else report?.error(file, "empty diagram block (its body must be a diagram id)", fence.line);
        }
        fence = null;
        continue;
      }
      fence.body.push(line);
      if (CALLOUTS.includes(fence.lang)) {
        scanInline(line, lineNo, acc);
        section.lines.push(line);
      } else if (fence.lang === "try") {
        const t = /^\s*([a-z]+)\s*:\s*(.*)$/.exec(line);
        if (t && !TRY_KEYS.includes(t[1])) {
          report?.warn(file, `unknown try key "${t[1]}" (use ${TRY_KEYS.join(", ")})`, lineNo);
        } else if (!t && line.trim()) {
          report?.warn(file, `try card line is not "key: value": ${line.trim()}`, lineNo);
        }
        if (t) {
          if (t[1] === "expect") scanInline(t[2], lineNo, acc);
          section.lines.push(t[2]);
        }
      }
      continue;
    }
    if (fm) {
      fence = { ch: fm[1][0], len: fm[1].length, lang: fm[2] || "", line: lineNo, body: [] };
      if (fence.lang === "try") acc.tries++;
      if (CALLOUTS.includes(fence.lang)) acc.callouts++;
      continue;
    }
    const h = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h) {
      const depth = h[1].length;
      const raw = h[2];
      const heading = { depth, text: plainInline(raw), slug: slug(raw), line: lineNo };
      acc.headings.push(heading);
      scanInline(raw, lineNo, acc);
      if (depth >= 2 && depth <= 3) {
        section = { slug: heading.slug, title: heading.text, depth, lines: [] };
        acc.sections.push(section);
      }
      continue;
    }
    scanInline(line, lineNo, acc);
    section.lines.push(line);
  }
  if (fence)
    report?.error(file, `code block opened here is never closed (${fence.ch.repeat(fence.len)})`, fence.line);
  acc.sections = acc.sections
    .map((s) => ({ slug: s.slug, title: s.title, depth: s.depth, text: plainMarkdown(s.lines.join("\n")) }))
    .filter((s) => s.slug || s.text);
  acc.words = words(plainMarkdown(body));
  return acc;
}

/* ------------------------------------------------------------------------------------------------ repo root */

export function findRepoRoot(option) {
  if (option === "none") return null;
  if (option) {
    const abs = path.resolve(option);
    return fs.existsSync(path.join(abs, "pnpm-workspace.yaml")) ? abs : null;
  }
  for (const candidate of [path.resolve(GUIDE_DIR, ".."), path.resolve(GUIDE_DIR, "..", "..")]) {
    if (fs.existsSync(path.join(candidate, "pnpm-workspace.yaml"))) return candidate;
  }
  return null;
}

/** `path:12` or `path:12-20` -> { line: 12, end: 20 } (null without a line). */
function repoLine(p) {
  const m = /:(\d+)(?:-(\d+))?$/.exec(String(p || "").trim());
  return m ? { line: Number(m[1]), end: m[2] ? Number(m[2]) : Number(m[1]) } : null;
}

function normaliseRepoPath(p) {
  return String(p || "")
    .trim()
    .replace(/#.*$/, "")
    .replace(/:\d+(-\d+)?$/, "")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}

/* ------------------------------------------------------------------------------------------------ build */

/**
 * Builds the content bundle. Returns { data, output, errors, warnings, stats, repoRoot }.
 * Nothing is written; see writeBundle() and main().
 */
export function build(options = {}) {
  const contentDir = path.resolve(options.contentDir || DEFAULT_CONTENT);
  const repoRoot = options.repoRoot === undefined ? findRepoRoot() : options.repoRoot;
  const report = createReport(contentDir);
  const P = (...parts) => path.join(contentDir, ...parts);
  if (!fs.existsSync(contentDir)) report.error(null, `content folder not found: ${contentDir}`);

  /* ---------- site.json */
  const siteFile = P("site.json");
  let site = fs.existsSync(siteFile) ? readJson(siteFile, report) : null;
  if (!site) {
    if (!fs.existsSync(siteFile)) report.warn(siteFile, "site.json is missing; using defaults");
    site = {};
  }
  site = { title: "Velexis Guidebook", tagline: "", repoBase: "", apps: [], appAliases: {}, ...site };
  const aliases = site.appAliases && typeof site.appAliases === "object" ? site.appAliases : {};

  /* ---------- collectors */
  const repoRefs = []; // { path, file, where, line? }
  const mdRefs = []; // { file, where, kind, id, raw, ctxApp, from:{kind,id,title,route} }
  const hashRefs = [];
  const diagramBlocks = []; // { file, where, id, ctxApp, from }

  function collect(scan, file, ctxApp, from) {
    for (const r of scan.repo) repoRefs.push({ path: r.path, file, where: r.where });
    for (const r of scan.refs) mdRefs.push({ ...r, file, ctxApp, from });
    for (const r of scan.hash) hashRefs.push({ ...r, file, from });
    for (const d of scan.diagrams) diagramBlocks.push({ ...d, file, ctxApp, from });
  }
  /** Scans a markdown string held in a JSON field. */
  function collectField(value, file, field, ctxApp, from) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") {
      report.error(file, `${field} must be a markdown string`);
      return null;
    }
    const scan = scanMarkdown(value, 1, file, report);
    const fix = (list) => list.forEach((x) => (x.where = field));
    fix(scan.repo);
    fix(scan.refs);
    fix(scan.hash);
    fix(scan.diagrams);
    collect(scan, file, ctxApp, from);
    return scan;
  }
  function addRepo(p, file, where, withLine) {
    if (typeof p !== "string" || !p.trim()) {
      report.error(file, "repo path must be a non-empty string", where);
      return;
    }
    repoRefs.push({ path: p, file, where, line: withLine ? repoLine(p) : null });
  }
  const resolveApp = (id) => (id && aliases[id] ? aliases[id] : id);

  /* ---------- pages */
  const pages = [];
  const pageIds = new Map();
  for (const name of listDir(P("pages"), isFile(".md"))) {
    const file = P("pages", name);
    const fmr = parseFrontMatter(readText(file), file, report);
    const id = String(fmr.data.id || "");
    if (!id) report.error(file, "front matter needs an id");
    else if (!KEBAB.test(id)) report.error(file, `page id "${id}" must be kebab-case`);
    if (!fmr.data.title) report.error(file, "front matter needs a title");
    if (!fmr.data.summary) report.warn(file, "front matter has no summary");
    if (id && pageIds.has(id)) report.error(file, `duplicate page id "${id}" (also in ${pageIds.get(id)})`);
    if (id) pageIds.set(id, report.rel(file));
    const from = { kind: "page", id, title: fmr.data.title || id, route: `#/page/${id}` };
    const scan = scanMarkdown(fmr.body, fmr.bodyLine, file, report);
    collect(scan, file, null, from);
    pages.push({ file, id, data: fmr.data, body: fmr.body, scan, from });
  }

  /* ---------- apps */
  const apps = [];
  const appIds = new Set();
  const diagrams = new Map(); // key app/id -> { file, app, data }
  for (const dir of listDir(P("apps"), isDir)) {
    const appFile = P("apps", dir, "app.json");
    if (!fs.existsSync(appFile)) {
      report.error(P("apps", dir), "app folder has no app.json");
      continue;
    }
    const app = readJson(appFile, report);
    if (!app || typeof app !== "object" || Array.isArray(app)) {
      if (app) report.error(appFile, "app.json must be an object");
      continue;
    }
    if (app.id !== dir) report.error(appFile, `app id "${app.id}" must equal its folder name "${dir}"`);
    const id = dir;
    appIds.add(id);
    for (const key of ["name", "kind", "product", "summary"]) {
      if (!app[key]) report.error(appFile, `app.json needs "${key}"`);
    }
    if (app.kind && !APP_KINDS.includes(app.kind)) {
      report.error(appFile, `kind "${app.kind}" is not one of ${APP_KINDS.join(", ")}`);
    }
    if (app.product && !PRODUCTS.includes(app.product)) {
      report.error(appFile, `product "${app.product}" is not one of ${PRODUCTS.join(", ")}`);
    }
    if (app.repoPath) addRepo(app.repoPath, appFile, "repoPath");
    asArray(app.docs).forEach((p, i) => addRepo(p, appFile, `docs[${i}]`));
    asArray(app.adrs).forEach((p, i) => addRepo(p, appFile, `adrs[${i}]`));
    asArray(app.screens).forEach((s, i) => {
      if (!s || !s.route || !s.title) report.error(appFile, `screens[${i}] needs route and title`);
      if (s && s.code) asArray(s.code).forEach((c) => addRepo(c, appFile, `screens[${i}].code`));
    });
    asArray(app.endpoints).forEach((e, i) => {
      if (!e || !e.method || !e.path) report.error(appFile, `endpoints[${i}] needs method and path`);
    });
    const docs = {};
    for (const docId of ["usage", "architecture"]) {
      const file = P("apps", dir, `${docId}.md`);
      if (!fs.existsSync(file)) {
        report.warn(file, `app has no ${docId}.md`);
        continue;
      }
      const fmr = parseFrontMatter(readText(file), file, report);
      if (fmr.data.id && fmr.data.id !== docId) report.error(file, `front matter id must be "${docId}"`);
      if (!fmr.data.title) report.error(file, "front matter needs a title");
      const from = {
        kind: docId,
        id,
        title: fmr.data.title || `${app.name || id} ${docId}`,
        route: `#/app/${id}/${docId}`,
      };
      const scan = scanMarkdown(fmr.body, fmr.bodyLine, file, report);
      collect(scan, file, id, from);
      docs[docId] = { file, data: fmr.data, body: fmr.body, scan, from };
    }
    for (const name of listDir(P("apps", dir, "diagrams"), isFile(".json"))) {
      const file = P("apps", dir, "diagrams", name);
      const data = readJson(file, report);
      if (!data) continue;
      const dId = name.slice(0, -5);
      if (data.id !== dId) report.error(file, `diagram id "${data.id}" must equal the file name "${dId}"`);
      diagrams.set(`${id}/${dId}`, { file, app: id, id: dId, data });
    }
    apps.push({ id, file: appFile, json: app, docs });
  }

  /* ---------- journeys */
  const journeys = [];
  const journeyIds = new Set();
  for (const name of listDir(P("journeys"), isFile(".json"))) {
    const file = P("journeys", name);
    const j = readJson(file, report);
    if (!j) continue;
    const jId = name.slice(0, -5);
    if (j.id !== jId) report.error(file, `journey id "${j.id}" must equal the file name "${jId}"`);
    if (journeyIds.has(jId)) report.error(file, `duplicate journey id "${jId}"`);
    journeyIds.add(jId);
    if (!j.title) report.error(file, "journey needs a title");
    const from = { kind: "journey", id: jId, title: j.title || jId, route: `#/journey/${jId}` };
    collectField(j.summary, file, "summary", null, from);
    asArray(j.prerequisites).forEach((p, i) => collectField(p, file, `prerequisites[${i}]`, null, from));
    const stepIds = new Set();
    if (!Array.isArray(j.steps) || !j.steps.length)
      report.error(file, "journey needs a non-empty steps array");
    asArray(j.steps).forEach((s, i) => {
      const w = `steps[${i}]`;
      if (!s || typeof s !== "object") return report.error(file, `${w} must be an object`);
      if (!s.id) report.error(file, `${w} needs an id`);
      else if (stepIds.has(s.id)) report.error(file, `${w}: duplicate step id "${s.id}"`);
      stepIds.add(s.id);
      if (!s.title) report.error(file, `${w} needs a title`);
      if (!s.actions) report.error(file, `${w} needs actions`);
      if (!s.expect) report.error(file, `${w} needs expect`);
      collectField(s.actions, file, `${w}.actions`, s.app, from);
      collectField(s.expect, file, `${w}.expect`, s.app, from);
      collectField(s.data, file, `${w}.data`, s.app, from);
      asArray(s.code).forEach((c, k) => addRepo(c, file, `${w}.code[${k}]`));
    });
    journeys.push({ id: jId, file, json: j, from });
  }

  /* ---------- glossary */
  const terms = [];
  const termIds = new Map();
  for (const name of listDir(P("glossary"), isFile(".json"))) {
    const file = P("glossary", name);
    const list = readJson(file, report);
    if (!list) continue;
    if (!Array.isArray(list)) {
      report.error(file, "glossary file must be an array of terms");
      continue;
    }
    list.forEach((t, i) => {
      const w = `[${i}]`;
      if (!t || typeof t !== "object") return report.error(file, `${w} must be an object`);
      if (!t.id) return report.error(file, `${w} needs an id`);
      if (!KEBAB.test(t.id)) report.error(file, `term id "${t.id}" must be kebab-case`, w);
      if (termIds.has(t.id))
        report.error(file, `duplicate term id "${t.id}" (also in ${termIds.get(t.id)})`, w);
      termIds.set(t.id, report.rel(file));
      if (!t.term) report.error(file, `term "${t.id}" needs a "term"`, w);
      if (!t.definition) report.error(file, `term "${t.id}" needs a definition`, w);
      if (!TERM_CATEGORIES.includes(t.category)) {
        report.error(
          file,
          `term "${t.id}": category "${t.category}" is not one of ${TERM_CATEGORIES.join(", ")}`,
          w,
        );
      }
      const from = { kind: "term", id: t.id, title: t.term || t.id, route: `#/glossary/${t.id}` };
      collectField(t.definition, file, `${t.id}.definition`, null, from);
      terms.push({ file, json: t, where: w });
    });
  }

  /* ---------- known issues (SCHEMA §14) */
  const issues = [];
  const issueIds = new Map();
  for (const name of listDir(P("issues"), isFile(".json"))) {
    const file = P("issues", name);
    const list = readJson(file, report);
    if (!list) continue;
    if (!Array.isArray(list)) {
      report.error(file, "issues file must be an array of issues");
      continue;
    }
    list.forEach((x, i) => {
      if (!x || typeof x !== "object" || Array.isArray(x))
        return report.error(file, "issue must be an object", `[${i}]`);
      const id = typeof x.id === "string" ? x.id : "";
      const w = id || `[${i}]`;
      if (!id) return report.error(file, "issue needs an id (KI-001, KI-002, …)", w);
      if (!ISSUE_ID.test(id)) report.error(file, `issue id "${id}" must look like KI-001`, w);
      if (issueIds.has(id)) report.error(file, `duplicate issue id "${id}" (also in ${issueIds.get(id)})`, w);
      issueIds.set(id, report.rel(file));
      for (const key of Object.keys(x)) {
        if (!ISSUE_FIELDS.includes(key)) report.warn(file, `unknown issue field "${key}"`, w);
      }
      if (typeof x.title !== "string" || !x.title.trim()) report.error(file, "issue needs a title", w);
      if (!x.app) report.error(file, "issue needs an app", w);
      const enumIn = (key, allowed) => {
        if (!allowed.includes(x[key]))
          report.error(file, `${key} "${x[key]}" is not one of ${allowed.join(", ")}`, w);
      };
      enumIn("severity", ISSUE_SEVERITIES);
      enumIn("kind", ISSUE_KINDS);
      enumIn("status", ISSUE_STATUSES);
      if (typeof x.migration !== "boolean") report.error(file, "migration must be true or false", w);
      const from = { kind: "issue", id, title: `${id} ${x.title || ""}`.trim(), route: `#/issue/${id}` };
      for (const key of ["summary", "expected", "actual", "fix"]) {
        if (typeof x[key] !== "string" || !x[key].trim())
          report.error(file, `issue needs ${key} (markdown)`, w);
        else collectField(x[key], file, `${w} ${key}`, x.app || null, from);
      }
      if (!Array.isArray(x.reproduce) || !x.reproduce.length) {
        report.error(file, "issue needs reproduce: a non-empty array of steps", w);
      }
      asArray(x.reproduce).forEach((s, k) => {
        if (typeof s !== "string" || !s.trim())
          report.error(file, `reproduce[${k}] must be a markdown string`, w);
        else collectField(s, file, `${w} reproduce[${k}]`, x.app || null, from);
      });
      for (const key of ["where", "files"]) {
        if (!Array.isArray(x[key]) || !x[key].length) {
          report.error(file, `issue needs ${key}: a non-empty array of repo paths`, w);
        }
      }
      asArray(x.where).forEach((p, k) => addRepo(p, file, `${w} where[${k}]`, true));
      asArray(x.files).forEach((p, k) => {
        if (repoLine(p))
          report.error(file, `files[${k}] "${p}" takes no line number (put lines in where)`, w);
        addRepo(p, file, `${w} files[${k}]`);
      });
      if (x.newFiles !== null && x.newFiles !== undefined && !Array.isArray(x.newFiles))
        report.error(file, "newFiles must be an array", w);
      if (x.terms !== null && x.terms !== undefined && !Array.isArray(x.terms))
        report.error(file, "terms must be an array of term ids", w);
      issues.push({ file, json: x, id, where: w, from });
    });
  }

  /* ---------- taxonomy */
  const taxFile = P("taxonomy", "taxonomy.json");
  const taxonomy = fs.existsSync(taxFile) ? readJson(taxFile, report) : null;

  /* ---------- ontology */
  const ontology = { classes: [], properties: [], individuals: [], assertions: [] };
  const ontologyFiles = { classes: [], properties: [], individuals: [], assertions: [] };
  for (const name of listDir(P("ontology"), isFile(".json"))) {
    const file = P("ontology", name);
    const o = readJson(file, report);
    if (!o) continue;
    for (const key of Object.keys(ontology)) {
      if (o[key] === null || o[key] === undefined) continue;
      if (!Array.isArray(o[key])) {
        report.error(file, `ontology "${key}" must be an array`);
        continue;
      }
      o[key].forEach((x, i) => {
        ontology[key].push(x);
        ontologyFiles[key].push({ file, where: `${key}[${i}]` });
      });
    }
  }

  /* ---------- relations */
  const relations = [];
  const relationFiles = [];
  for (const name of listDir(P("graph"), isFile(".json"))) {
    const file = P("graph", name);
    const list = readJson(file, report);
    if (!list) continue;
    if (!Array.isArray(list)) {
      report.error(file, "relations file must be an array");
      continue;
    }
    list.forEach((r, i) => {
      relations.push(r);
      relationFiles.push({ file, where: `[${i}]` });
    });
  }

  /* ---------- topology */
  const topoFile = P("system", "topology.json");
  const topology = fs.existsSync(topoFile) ? readJson(topoFile, report) : null;

  /* ================================================================ validation */
  const hasApp = (id) => appIds.has(resolveApp(id));
  const hasTerm = (id) => termIds.has(id);
  const classIds = new Set();
  const propertyIds = new Set();
  const individualIds = new Map();

  // site.json app order
  const order = asArray(site.apps).map(resolveApp);
  for (const id of order) {
    if (!appIds.has(id))
      report.warn(siteFile, `site.json lists app "${id}" but content/apps/${id} does not exist`);
  }
  for (const id of appIds) {
    if (!order.includes(id))
      report.warn(siteFile, `app "${id}" is not listed in site.json apps (shown last)`);
  }
  for (const [alias, target] of Object.entries(aliases)) {
    if (!appIds.has(target)) report.warn(siteFile, `appAliases.${alias} points to missing app "${target}"`);
  }

  // apps
  for (const a of apps) {
    asArray(a.json.dependsOn).forEach((d, i) => {
      if (!hasApp(d)) report.error(a.file, `dependsOn[${i}]: unknown app "${d}"`);
    });
    asArray(a.json.talksTo).forEach((t, i) => {
      if (!t || !hasApp(t.app)) report.error(a.file, `talksTo[${i}]: unknown app "${t && t.app}"`);
    });
  }

  // ontology
  ontology.classes.forEach((c, i) => {
    const { file, where } = ontologyFiles.classes[i];
    if (!c || !c.id) return report.error(file, "class needs an id", where);
    if (classIds.has(c.id)) report.error(file, `duplicate class id "${c.id}"`, where);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(c.id))
      report.warn(file, `class id "${c.id}" should be PascalCase`, where);
    classIds.add(c.id);
  });
  ontology.classes.forEach((c, i) => {
    const { file, where } = ontologyFiles.classes[i];
    if (c && c.parent && !classIds.has(c.parent))
      report.error(file, `class "${c.id}": unknown parent "${c.parent}"`, where);
  });
  // cycles in the class hierarchy
  const parentOf = new Map(ontology.classes.filter((c) => c && c.id).map((c) => [c.id, c.parent]));
  for (const id of classIds) {
    const seen = new Set([id]);
    let p = parentOf.get(id);
    while (p) {
      if (seen.has(p)) {
        report.error(ontologyFiles.classes[0].file, `class hierarchy has a cycle through "${id}"`);
        break;
      }
      seen.add(p);
      p = parentOf.get(p);
    }
  }
  ontology.properties.forEach((p, i) => {
    const { file, where } = ontologyFiles.properties[i];
    if (!p || !p.id) return report.error(file, "property needs an id", where);
    if (propertyIds.has(p.id)) report.error(file, `duplicate property id "${p.id}"`, where);
    if (!/^[a-z][A-Za-z0-9]*$/.test(p.id))
      report.warn(file, `property id "${p.id}" should be camelCase`, where);
    propertyIds.add(p.id);
    if (!classIds.has(p.domain))
      report.error(file, `property "${p.id}": unknown domain "${p.domain}"`, where);
    if (!classIds.has(p.range)) report.error(file, `property "${p.id}": unknown range "${p.range}"`, where);
  });
  ontology.properties.forEach((p, i) => {
    const { file, where } = ontologyFiles.properties[i];
    if (p && p.inverse && !propertyIds.has(p.inverse)) {
      report.error(file, `property "${p.id}": unknown inverse "${p.inverse}"`, where);
    }
  });
  ontology.individuals.forEach((x, i) => {
    const { file, where } = ontologyFiles.individuals[i];
    if (!x || !x.id) return report.error(file, "individual needs an id", where);
    if (individualIds.has(x.id)) report.error(file, `duplicate individual id "${x.id}"`, where);
    if (!KEBAB.test(x.id)) report.warn(file, `individual id "${x.id}" should be kebab-case`, where);
    individualIds.set(x.id, x);
    if (!classIds.has(x.class)) report.error(file, `individual "${x.id}": unknown class "${x.class}"`, where);
    if (x.app && !hasApp(x.app)) report.error(file, `individual "${x.id}": unknown app "${x.app}"`, where);
    if (x.term && !hasTerm(x.term))
      report.error(file, `individual "${x.id}": unknown term "${x.term}"`, where);
  });
  ontology.assertions.forEach((a, i) => {
    const { file, where } = ontologyFiles.assertions[i];
    if (!a) return;
    if (!individualIds.has(a.subject)) report.error(file, `assertion: unknown subject "${a.subject}"`, where);
    if (!propertyIds.has(a.property))
      report.error(file, `assertion: unknown property "${a.property}"`, where);
    if (!individualIds.has(a.object)) report.error(file, `assertion: unknown object "${a.object}"`, where);
  });
  ontology.classes.forEach((c, i) => {
    if (!c || !c.description) return;
    const from = { kind: "class", id: c.id, title: c.label || c.id, route: `#/ontology/${c.id}` };
    collectField(c.description, ontologyFiles.classes[i].file, `class ${c.id}.description`, null, from);
  });

  // glossary
  for (const { file, json: t, where } of terms) {
    asArray(t.apps).forEach((a) => {
      if (!hasApp(a)) report.error(file, `term "${t.id}": unknown app "${a}"`, where);
    });
    asArray(t.related).forEach((r) => {
      if (!hasTerm(r)) report.error(file, `term "${t.id}": related term "${r}" does not exist`, where);
      if (r === t.id) report.warn(file, `term "${t.id}" is related to itself`, where);
    });
    asArray(t.see).forEach((s) => {
      if (pageIds.has(s)) return;
      if (/[/.]/.test(s)) addRepo(s, file, `${where} ${t.id}.see`);
      else report.error(file, `term "${t.id}": see "${s}" is neither a page id nor a repo path`, where);
    });
    if (t.classOf && !classIds.has(t.classOf)) {
      report.error(file, `term "${t.id}": classOf "${t.classOf}" is not an ontology class`, where);
    }
  }

  // taxonomy
  const taxTerms = new Set();
  let taxNodes = 0;
  if (taxonomy) {
    const ids = new Set();
    const walk = (node, trail) => {
      if (!node || typeof node !== "object") return report.error(taxFile, `${trail}: node must be an object`);
      taxNodes++;
      if (!node.id) report.error(taxFile, `${trail}: node needs an id`);
      else if (ids.has(node.id)) report.error(taxFile, `duplicate taxonomy id "${node.id}"`);
      ids.add(node.id);
      if (!node.label) report.error(taxFile, `${trail}: node "${node.id}" needs a label`);
      asArray(node.terms).forEach((t) => {
        if (!hasTerm(t)) report.error(taxFile, `taxonomy node "${node.id}": term "${t}" does not exist`);
        taxTerms.add(t);
      });
      asArray(node.apps).forEach((a) => {
        if (!hasApp(a)) report.error(taxFile, `taxonomy node "${node.id}": unknown app "${a}"`);
      });
      asArray(node.children).forEach((c, i) => walk(c, `${trail}.children[${i}]`));
    };
    walk(taxonomy, "root");
    for (const { json: t } of terms) {
      if (!taxTerms.has(t.id)) report.warn(taxFile, `term "${t.id}" does not appear in the taxonomy`);
    }
  } else if (terms.length) {
    report.warn(taxFile, "taxonomy.json is missing");
  }

  // diagrams
  for (const [key, d] of diagrams) validateDiagram(key, d);
  function validateDiagram(key, d) {
    const { file, data, app } = d;
    const from = { kind: "diagram", id: key, title: data.title || key, route: `#/diagram/${key}` };
    if (!DIAGRAM_TYPES.includes(data.type)) {
      report.error(file, `diagram type "${data.type}" is not one of ${DIAGRAM_TYPES.join(", ")}`);
      return;
    }
    if (!data.title) report.error(file, "diagram needs a title");
    if (!data.caption) report.warn(file, "diagram has no caption");
    collectField(data.caption, file, "caption", app, from);
    const uniq = (list, what) => {
      const ids = new Set();
      asArray(list).forEach((x, i) => {
        if (!x || x.id === null || x.id === undefined || x.id === "")
          return report.error(file, `${what}[${i}] needs an id`);
        if (ids.has(x.id)) report.error(file, `duplicate ${what} id "${x.id}"`);
        ids.add(x.id);
      });
      return ids;
    };
    const kindIn = (value, allowed, what) => {
      if (value !== null && value !== undefined && !allowed.includes(value))
        report.warn(file, `${what}: kind "${value}" is not one of ${allowed.join(", ")}`);
    };
    const ends = (list, ids, what) =>
      asArray(list).forEach((e, i) => {
        if (!e) return;
        if (!ids.has(e.from)) report.error(file, `${what}[${i}]: unknown "from" id "${e.from}"`);
        if (!ids.has(e.to)) report.error(file, `${what}[${i}]: unknown "to" id "${e.to}"`);
      });
    if (data.type === "component") {
      const groups = uniq(data.groups, "group");
      const nodes = uniq(data.nodes, "node");
      if (!nodes.size) report.error(file, "component diagram needs nodes");
      asArray(data.nodes).forEach((n, i) => {
        if (!n) return;
        if (!n.label) report.error(file, `node "${n.id}" needs a label`);
        if (n.group && !groups.has(n.group)) report.error(file, `node "${n.id}": unknown group "${n.group}"`);
        kindIn(n.kind, COMPONENT_KINDS, `node "${n.id}"`);
        if (n.app && !hasApp(n.app)) report.error(file, `node "${n.id}": unknown app "${n.app}"`);
        if (n.term && !hasTerm(n.term)) report.error(file, `node "${n.id}": unknown term "${n.term}"`);
        collectField(n.detail, file, `nodes[${i}].detail`, app, from);
      });
      ends(data.edges, nodes, "edges");
      asArray(data.edges).forEach((e, i) => e && kindIn(e.kind, EDGE_KINDS, `edges[${i}]`));
    } else if (data.type === "sequence") {
      const actors = uniq(data.actors, "actor");
      if (!actors.size) report.error(file, "sequence diagram needs actors");
      if (!asArray(data.steps).length) report.error(file, "sequence diagram needs steps");
      ends(data.steps, actors, "steps");
      asArray(data.steps).forEach((s, i) => {
        if (!s) return;
        kindIn(s.kind, STEP_KINDS, `steps[${i}]`);
        collectField(s.note, file, `steps[${i}].note`, app, from);
      });
    } else if (data.type === "state") {
      const states = uniq(data.states, "state");
      if (!states.size) report.error(file, "state diagram needs states");
      asArray(data.states).forEach((s, i) => {
        if (!s) return;
        kindIn(s.kind, STATE_KINDS, `states[${i}]`);
        collectField(s.detail, file, `states[${i}].detail`, app, from);
      });
      ends(data.transitions, states, "transitions");
    } else if (data.type === "er") {
      const entities = uniq(data.entities, "entity");
      if (!entities.size) report.error(file, "er diagram needs entities");
      asArray(data.entities).forEach((e) => {
        if (!e) return;
        if (e.schema && !ER_SCHEMAS.includes(e.schema)) {
          report.warn(file, `entity "${e.id}": schema "${e.schema}" is not one of ${ER_SCHEMAS.join(", ")}`);
        }
        if (!Array.isArray(e.fields)) report.error(file, `entity "${e.id}" needs a fields array`);
        asArray(e.fields).forEach((f, k) => {
          if (!f || !f.name) report.error(file, `entity "${e.id}": fields[${k}] needs a name`);
          else if (f.key && !FIELD_KEYS.includes(f.key))
            report.warn(file, `entity "${e.id}": field "${f.name}" key "${f.key}"`);
        });
      });
      ends(data.relations, entities, "relations");
      asArray(data.relations).forEach((r, i) => {
        if (r && r.cardinality && !CARDINALITIES.includes(r.cardinality)) {
          report.warn(
            file,
            `relations[${i}]: cardinality "${r.cardinality}" is not one of ${CARDINALITIES.join(", ")}`,
          );
        }
      });
    } else if (data.type === "flow") {
      if (!asArray(data.steps).length) report.error(file, "flow diagram needs steps");
      asArray(data.steps).forEach((s, i) => {
        if (!s || !s.title) report.error(file, `steps[${i}] needs a title`);
        if (!s) return;
        collectField(s.body, file, `steps[${i}].body`, app, from);
        collectField(s.expect, file, `steps[${i}].expect`, app, from);
      });
    } else if (data.type === "tree") {
      if (!data.root || !data.root.name) report.error(file, "tree diagram needs root.name");
      const walk = (n, trail) => {
        if (!n || typeof n !== "object") return report.error(file, `${trail} must be an object`);
        if (!n.name) report.error(file, `${trail} needs a name`);
        if (n.term && !hasTerm(n.term)) report.error(file, `${trail}: unknown term "${n.term}"`);
        collectField(n.detail, file, `${trail}.detail`, app, from);
        asArray(n.children).forEach((c, i) => walk(c, `${trail}.children[${i}]`));
      };
      if (data.root) walk(data.root, "root");
    }
  }

  // journeys
  for (const j of journeys) {
    asArray(j.json.apps).forEach((a) => {
      if (!hasApp(a)) report.error(j.file, `unknown app "${a}"`, "apps");
    });
    asArray(j.json.steps).forEach((s, i) => {
      if (s && s.app && !hasApp(s.app)) report.error(j.file, `steps[${i}]: unknown app "${s.app}"`);
      if (s && !s.app) report.error(j.file, `steps[${i}] needs an app`);
    });
  }

  // known issues
  const stepsOf = new Map(
    journeys.map((j) => [
      j.id,
      new Set(
        asArray(j.json.steps)
          .map((s) => s && s.id)
          .filter(Boolean),
      ),
    ]),
  );
  const newFileRefs = []; // { path, file, where }
  for (const { file, json: x, where: w } of issues) {
    if (x.app && !hasApp(x.app)) report.error(file, `unknown app "${x.app}"`, w);
    if (x.journey !== null && x.journey !== undefined && !journeyIds.has(x.journey))
      report.error(file, `unknown journey "${x.journey}"`, w);
    if (x.step !== null && x.step !== undefined) {
      if (x.journey === null || x.journey === undefined)
        report.error(file, `step "${x.step}" needs a journey`, w);
      else if (journeyIds.has(x.journey) && !stepsOf.get(x.journey).has(x.step))
        report.error(file, `journey "${x.journey}" has no step "${x.step}"`, w);
    }
    asArray(x.terms).forEach((t) => {
      if (!hasTerm(t)) report.error(file, `unknown term "${t}"`, w);
    });
    asArray(x.newFiles).forEach((p, k) => {
      if (typeof p !== "string" || !p.trim()) report.error(file, `newFiles[${k}] must be a repo path`, w);
      else newFileRefs.push({ path: p, file, where: `${w} newFiles[${k}]` });
    });
  }

  // topology
  if (topology) {
    const layers = new Set();
    asArray(topology.layers).forEach((l, i) => {
      if (!l || !l.id) return report.error(topoFile, `layers[${i}] needs an id`);
      if (layers.has(l.id)) report.error(topoFile, `duplicate layer id "${l.id}"`);
      layers.add(l.id);
    });
    const nodes = new Set();
    asArray(topology.nodes).forEach((n, i) => {
      if (!n || !n.id) return report.error(topoFile, `nodes[${i}] needs an id`);
      if (nodes.has(n.id)) report.error(topoFile, `duplicate node id "${n.id}"`);
      nodes.add(n.id);
      if (!layers.has(n.layer)) report.error(topoFile, `node "${n.id}": unknown layer "${n.layer}"`);
      if (n.app && !hasApp(n.app)) report.error(topoFile, `node "${n.id}": unknown app "${n.app}"`);
      if (n.kind && !TOPOLOGY_KINDS.includes(n.kind)) {
        report.warn(topoFile, `node "${n.id}": kind "${n.kind}" is not one of ${TOPOLOGY_KINDS.join(", ")}`);
      }
      collectField(n.detail, topoFile, `nodes[${i}].detail`, n.app || null, {
        kind: "system",
        id: n.id,
        title: `System: ${n.label || n.id}`,
        route: `#/system?node=${encodeURIComponent(n.id)}`,
      });
    });
    asArray(topology.links).forEach((l, i) => {
      if (!l) return;
      if (!nodes.has(l.from)) report.error(topoFile, `links[${i}]: unknown "from" node "${l.from}"`);
      if (!nodes.has(l.to)) report.error(topoFile, `links[${i}]: unknown "to" node "${l.to}"`);
    });
    const flows = new Set();
    asArray(topology.flows).forEach((f, i) => {
      if (!f || !f.id) return report.error(topoFile, `flows[${i}] needs an id`);
      if (flows.has(f.id)) report.error(topoFile, `duplicate flow id "${f.id}"`);
      flows.add(f.id);
      if (!asArray(f.path).length) report.error(topoFile, `flow "${f.id}" needs a path`);
      asArray(f.path).forEach((h, k) => {
        if (!h) return;
        if (!nodes.has(h.from)) report.error(topoFile, `flow "${f.id}" path[${k}]: unknown node "${h.from}"`);
        if (!nodes.has(h.to)) report.error(topoFile, `flow "${f.id}" path[${k}]: unknown node "${h.to}"`);
      });
    });
  }

  // relations
  const nodeExists = (ref) => {
    const m = /^([a-z]+):(.+)$/.exec(String(ref || ""));
    if (!m || !GRAPH_KINDS.includes(m[1])) return false;
    const [, kind, id] = m;
    if (kind === "app") return hasApp(id);
    if (kind === "term") return hasTerm(id);
    if (kind === "class") return classIds.has(id);
    if (kind === "individual") return individualIds.has(id);
    if (kind === "page") return pageIds.has(id);
    if (kind === "issue") return issueIds.has(id);
    return journeyIds.has(id);
  };
  relations.forEach((r, i) => {
    const { file, where } = relationFiles[i];
    if (!r) return;
    if (!nodeExists(r.from))
      report.error(
        file,
        `relation from "${r.from}" does not resolve (kind:id with kind in ${GRAPH_KINDS.join(", ")})`,
        where,
      );
    if (!nodeExists(r.to)) report.error(file, `relation to "${r.to}" does not resolve`, where);
    if (!r.label) report.error(file, "relation needs a label", where);
  });

  // markdown references
  const diagramUse = new Map(); // key -> [from]
  const resolveDiagram = (id, ctxApp) => (id.includes("/") ? id : ctxApp ? `${ctxApp}/${id}` : null);
  for (const r of mdRefs) {
    const w = r.where;
    if (r.kind === "term" && !hasTerm(r.id)) report.error(r.file, `unknown term ${r.raw}`, w);
    if (r.kind === "app" && !hasApp(r.id)) report.error(r.file, `unknown app ${r.raw}`, w);
    if (r.kind === "page" && !pageIds.has(r.id)) report.error(r.file, `unknown page ${r.raw}`, w);
    if (r.kind === "journey" && !journeyIds.has(r.id)) report.error(r.file, `unknown journey ${r.raw}`, w);
    if (r.kind === "diagram") {
      const key = resolveDiagram(r.id, r.ctxApp);
      if (!key) report.error(r.file, `diagram link ${r.raw} must be <app>/<id> outside an app`, w);
      else if (!diagrams.has(key)) report.error(r.file, `unknown diagram ${r.raw}`, w);
      else addUse(key, r.from);
    }
  }
  for (const b of diagramBlocks) {
    const key = resolveDiagram(b.id, b.ctxApp);
    if (!key) report.error(b.file, `diagram block "${b.id}" must be <app>/<id> outside an app`, b.where);
    else if (!diagrams.has(key))
      report.error(b.file, `unknown diagram "${b.id}" in a diagram block`, b.where);
    else addUse(key, b.from);
  }
  function addUse(key, from) {
    if (!from) return;
    const list = diagramUse.get(key) || [];
    if (!list.some((f) => f.route === from.route)) list.push(from);
    diagramUse.set(key, list);
  }
  for (const r of hashRefs) {
    const parts = r.route.replace(/^#\//, "").split("?")[0].split("/");
    const [view, a, b] = parts;
    const bad = (what) => report.error(r.file, `internal link ${r.route}: unknown ${what}`, r.where);
    if (view === "glossary" && a && !hasTerm(a)) bad("term");
    if (view === "app" && a && !hasApp(a)) bad("app");
    if (view === "page" && a && !pageIds.has(a)) bad("page");
    if (view === "journey" && a && !journeyIds.has(a)) bad("journey");
    if (view === "ontology" && a && !classIds.has(a)) bad("class");
    if (view === "diagram" && a && !diagrams.has(`${resolveApp(a)}/${b}`)) bad("diagram");
    if (view === "issue" && a && !issueIds.has(a)) bad("issue");
  }

  // repo paths
  let repoChecked = 0;
  if (repoRoot) {
    const seen = new Map();
    const lineCounts = new Map();
    const linesOf = (p) => {
      if (!lineCounts.has(p)) {
        const abs = path.join(repoRoot, p);
        let n = null;
        try {
          if (fs.statSync(abs).isFile())
            n = fs.readFileSync(abs, "utf8").replace(/\n$/, "").split("\n").length;
        } catch {
          n = null;
        }
        lineCounts.set(p, n);
      }
      return lineCounts.get(p);
    };
    for (const r of repoRefs) {
      const p = normaliseRepoPath(r.path);
      if (!p || p.split("/").includes("..")) {
        report.error(r.file, `invalid repo path "${r.path}"`, r.where);
        continue;
      }
      if (!seen.has(p)) seen.set(p, fs.existsSync(path.join(repoRoot, p)));
      repoChecked++;
      if (!seen.get(p)) {
        report.error(r.file, `repo path does not exist: ${p}`, r.where);
        continue;
      }
      if (r.line) {
        const n = linesOf(p);
        if (n === null || n === undefined)
          report.error(r.file, `${p} is not a file, so it has no line ${r.line.line}`, r.where);
        else if (r.line.line < 1 || r.line.end < r.line.line || r.line.end > n)
          report.error(
            r.file,
            `line ${r.line.line}${r.line.end !== r.line.line ? "-" + r.line.end : ""} is outside ${p} (${n} lines)`,
            r.where,
          );
      }
    }
    for (const r of newFileRefs) {
      const p = normaliseRepoPath(r.path);
      if (!p || p.split("/").includes("..")) {
        report.error(r.file, `invalid repo path "${r.path}"`, r.where);
        continue;
      }
      if (!fs.existsSync(path.join(repoRoot, path.dirname(p))))
        report.error(r.file, `the folder of new file ${p} does not exist`, r.where);
      else if (fs.existsSync(path.join(repoRoot, p)))
        report.warn(
          r.file,
          `new file ${p} exists now: move it to files, or remove the issue if it is fixed`,
          r.where,
        );
    }
  } else if (repoRefs.length) {
    report.warn(
      null,
      `repository root not found (no pnpm-workspace.yaml next to the guidebook): ${repoRefs.length} repo paths were not checked`,
    );
  }

  /* ================================================================ output */
  const appOrder = [
    ...order.filter((id) => appIds.has(id)),
    ...[...appIds].filter((id) => !order.includes(id)).sort(cmp),
  ];
  const appRank = new Map(appOrder.map((id, i) => [id, i]));
  const docOut = (d) =>
    d
      ? {
          title: d.data.title || "",
          summary: d.data.summary || "",
          md: d.body.trim() + "\n",
          headings: d.scan.headings.map(({ depth, text, slug }) => ({ depth, text, slug })),
          words: d.scan.words,
        }
      : null;

  // backlinks: which documents mention each term
  const backlinks = new Map();
  for (const r of mdRefs) {
    if (r.kind !== "term" || !hasTerm(r.id) || !r.from) continue;
    if (r.from.kind === "term" && r.from.id === r.id) continue;
    const list = backlinks.get(r.id) || [];
    if (!list.some((f) => f.route === r.from.route)) list.push(r.from);
    backlinks.set(r.id, list);
  }
  for (const { json: x, from } of issues) {
    for (const t of new Set(asArray(x.terms))) {
      if (!hasTerm(t)) continue;
      const list = backlinks.get(t) || [];
      if (!list.some((f) => f.route === from.route)) list.push(from);
      backlinks.set(t, list);
    }
  }
  const sortFrom = (list) =>
    list
      .map(({ kind, id, title, route }) => ({ kind, id, title, route }))
      .sort((a, b) => cmp(a.kind, b.kind) || cmpCi(a.title, b.title) || cmp(a.route, b.route));

  const journeysByApp = new Map();
  for (const j of journeys) {
    for (const a of new Set(
      [...asArray(j.json.apps), ...asArray(j.json.steps).map((s) => s && s.app)]
        .filter(Boolean)
        .map(resolveApp),
    )) {
      journeysByApp.set(a, [...(journeysByApp.get(a) || []), j.id]);
    }
  }
  const dependents = new Map();
  for (const a of apps) {
    const targets = new Set(
      [...asArray(a.json.dependsOn), ...asArray(a.json.talksTo).map((t) => t && t.app)]
        .filter(Boolean)
        .map(resolveApp),
    );
    for (const t of targets) dependents.set(t, [...(dependents.get(t) || []), a.id]);
  }

  const outApps = apps
    .slice()
    .sort((a, b) => appRank.get(a.id) - appRank.get(b.id))
    .map((a) => {
      const json = { ...a.json, id: a.id };
      return {
        ...json,
        usage: docOut(a.docs.usage),
        architecture: docOut(a.docs.architecture),
        diagrams: [...diagrams.values()]
          .filter((d) => d.app === a.id)
          .map((d) => d.id)
          .sort(cmp),
        journeys: (journeysByApp.get(a.id) || []).slice().sort(cmp),
        dependents: [...new Set(dependents.get(a.id) || [])].sort(
          (x, y) => (appRank.get(x) ?? 99) - (appRank.get(y) ?? 99) || cmp(x, y),
        ),
      };
    });

  const outPages = pages
    .filter((p) => p.id)
    .map((p) => ({
      ...p.data,
      id: p.id,
      title: p.data.title || p.id,
      summary: p.data.summary || "",
      order: typeof p.data.order === "number" ? p.data.order : 1000,
      md: p.body.trim() + "\n",
      headings: p.scan.headings.map(({ depth, text, slug }) => ({ depth, text, slug })),
      words: p.scan.words,
    }))
    .sort((a, b) => a.order - b.order || cmp(a.id, b.id));

  const outDiagrams = {};
  for (const key of [...diagrams.keys()].sort(cmp)) {
    const d = diagrams.get(key);
    outDiagrams[key] = { ...d.data, id: d.id, app: d.app, key, usedIn: sortFrom(diagramUse.get(key) || []) };
  }

  const outJourneys = journeys
    .map((j) => ({ ...j.json, id: j.id }))
    .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || cmp(a.id, b.id));

  const issueNum = (id) => Number(String(id).replace(/^\D+/, "")) || 0;
  const outIssues = issues
    .map(({ json, id }) => ({ ...json, id, app: resolveApp(json.app) }))
    .sort((a, b) => issueNum(a.id) - issueNum(b.id) || cmp(a.id, b.id));

  const outTerms = terms
    .map(({ json }) => ({ ...json, backlinks: sortFrom(backlinks.get(json.id) || []) }))
    .sort((a, b) => cmp(a.id, b.id));

  /* ---------- knowledge graph (SCHEMA §11) */
  const gNodes = new Map();
  const gEdges = new Map();
  const addNode = (n) => {
    if (!gNodes.has(n.id)) gNodes.set(n.id, n);
  };
  const addEdge = (source, target, label) => {
    if (!source || !target || source === target) return;
    const key = `${source}\u0000${target}\u0000${label}`;
    if (!gEdges.has(key)) gEdges.set(key, { source, target, label });
  };
  for (const a of outApps) {
    addNode({
      id: `app:${a.id}`,
      kind: "app",
      label: a.name || a.id,
      app: a.id,
      category: a.product || "",
      route: `#/app/${a.id}/usage`,
    });
  }
  for (const t of outTerms) {
    addNode({
      id: `term:${t.id}`,
      kind: "term",
      label: t.term || t.id,
      app: resolveApp(asArray(t.apps)[0]) || "",
      category: t.category || "",
      route: `#/glossary/${t.id}`,
    });
  }
  for (const c of ontology.classes.filter((c) => c && c.id)) {
    addNode({
      id: `class:${c.id}`,
      kind: "class",
      label: c.label || c.id,
      app: "",
      category: "ontology",
      route: `#/ontology/${c.id}`,
    });
  }
  for (const x of ontology.individuals.filter((x) => x && x.id)) {
    addNode({
      id: `individual:${x.id}`,
      kind: "individual",
      label: x.label || x.id,
      app: resolveApp(x.app) || "",
      category: x.class || "",
      route: `#/ontology/${x.class}?individual=${encodeURIComponent(x.id)}`,
    });
  }
  for (const j of outJourneys) {
    addNode({
      id: `journey:${j.id}`,
      kind: "journey",
      label: j.title || j.id,
      app: resolveApp(asArray(j.apps)[0]) || "",
      category: "journey",
      route: `#/journey/${j.id}`,
    });
  }
  for (const x of outIssues) {
    addNode({
      id: `issue:${x.id}`,
      kind: "issue",
      label: `${x.id} ${clip(x.title, 56)}`,
      app: x.app || "",
      category: x.severity || "",
      route: `#/issue/${x.id}`,
    });
  }
  const pageNode = (id) => {
    const p = outPages.find((x) => x.id === id);
    if (p)
      addNode({
        id: `page:${id}`,
        kind: "page",
        label: p.title,
        app: "",
        category: "page",
        route: `#/page/${id}`,
      });
  };
  const has = (id) => gNodes.has(id);
  for (const a of outApps) {
    asArray(a.dependsOn).forEach((d) => addEdge(`app:${a.id}`, `app:${resolveApp(d)}`, "depends on"));
    asArray(a.talksTo).forEach((t) => t && addEdge(`app:${a.id}`, `app:${resolveApp(t.app)}`, "talks to"));
  }
  for (const t of outTerms) {
    asArray(t.apps).forEach((a) => addEdge(`term:${t.id}`, `app:${resolveApp(a)}`, "used in"));
    asArray(t.related).forEach((r) => {
      const [x, y] = [t.id, r].sort(cmp);
      addEdge(`term:${x}`, `term:${y}`, "related to");
    });
    if (t.classOf) addEdge(`term:${t.id}`, `class:${t.classOf}`, "is a");
  }
  for (const c of ontology.classes.filter((c) => c && c.id)) {
    if (c.parent) addEdge(`class:${c.id}`, `class:${c.parent}`, "subclass of");
  }
  for (const p of ontology.properties.filter((p) => p && p.id)) {
    addEdge(`class:${p.domain}`, `class:${p.range}`, p.label || p.id);
  }
  for (const x of ontology.individuals.filter((x) => x && x.id)) {
    addEdge(`individual:${x.id}`, `class:${x.class}`, "instance of");
    if (x.app) addEdge(`individual:${x.id}`, `app:${resolveApp(x.app)}`, "belongs to");
    if (x.term) addEdge(`individual:${x.id}`, `term:${x.term}`, "described by");
  }
  const propLabel = new Map(ontology.properties.filter((p) => p && p.id).map((p) => [p.id, p.label || p.id]));
  for (const a of ontology.assertions.filter(Boolean)) {
    addEdge(`individual:${a.subject}`, `individual:${a.object}`, propLabel.get(a.property) || a.property);
  }
  for (const j of outJourneys) {
    const jApps = new Set(
      [...asArray(j.apps), ...asArray(j.steps).map((s) => s && s.app)].filter(Boolean).map(resolveApp),
    );
    for (const a of jApps) addEdge(`journey:${j.id}`, `app:${a}`, "covers");
  }
  for (const x of outIssues) {
    if (x.app) addEdge(`issue:${x.id}`, `app:${x.app}`, "affects");
    if (x.journey) addEdge(`issue:${x.id}`, `journey:${x.journey}`, "seen in");
    for (const t of asArray(x.terms)) addEdge(`issue:${x.id}`, `term:${t}`, "about");
  }
  const normRef = (ref) => {
    const m = /^([a-z]+):(.+)$/.exec(String(ref || ""));
    if (!m) return ref;
    if (m[1] === "page") pageNode(m[2]);
    return m[1] === "app" ? `app:${resolveApp(m[2])}` : ref;
  };
  for (const r of relations.filter(Boolean)) addEdge(normRef(r.from), normRef(r.to), r.label || "related to");
  const edgeList = [...gEdges.values()].filter((e) => has(e.source) && has(e.target));
  const degree = new Map();
  for (const e of edgeList) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  const graph = {
    nodes: [...gNodes.values()]
      .map((n) => ({ ...n, degree: degree.get(n.id) || 0 }))
      .sort((a, b) => cmp(a.id, b.id)),
    edges: edgeList.sort(
      (a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.label, b.label),
    ),
  };

  /* ---------- search index */
  const search = [];
  const push = (e) => search.push(e);
  const sectionEntries = (scan, base, title, app) => {
    for (const s of scan.sections) {
      if (!s.slug) continue;
      push({
        k: "section",
        id: `${base}?s=${s.slug}`,
        t: s.title,
        s: clip(s.text, 180),
        r: `${base}?s=${s.slug}`,
        a: app || "",
        p: title,
        x: clip(s.text, 1500).toLowerCase(),
      });
    }
  };
  for (const p of pages.filter((p) => p.id)) {
    const intro = p.scan.sections[0] && !p.scan.sections[0].slug ? p.scan.sections[0].text : "";
    push({
      k: "page",
      id: p.id,
      t: p.data.title || p.id,
      s: clip(p.data.summary || intro, 180),
      r: `#/page/${p.id}`,
      a: "",
      x: clip(intro, 600).toLowerCase(),
    });
    sectionEntries(p.scan, `#/page/${p.id}`, p.data.title || p.id, "");
  }
  for (const a of outApps) {
    push({
      k: "app",
      id: a.id,
      t: a.name || a.id,
      s: clip(a.summary, 180),
      r: `#/app/${a.id}/usage`,
      a: a.id,
      x: [a.package, a.repoPath, ...asArray(a.stack), ...asArray(a.tags)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    });
    const src = apps.find((x) => x.id === a.id);
    for (const docId of ["usage", "architecture"]) {
      const d = src.docs[docId];
      if (d) sectionEntries(d.scan, `#/app/${a.id}/${docId}`, `${a.name || a.id} · ${docId}`, a.id);
    }
    asArray(a.screens).forEach((s) => {
      if (!s || !s.route) return;
      push({
        k: "screen",
        id: `${a.id} ${s.route}`,
        t: `${s.title || s.route}`,
        s: clip(`${s.route} — ${s.purpose || ""}`, 180),
        r: `#/app/${a.id}/facts?screen=${encodeURIComponent(s.route)}`,
        a: a.id,
        x: `${s.route} ${s.code || ""}`.toLowerCase(),
      });
    });
    asArray(a.endpoints).forEach((e) => {
      if (!e || !e.path) return;
      const label = `${String(e.method || "").toUpperCase()} ${e.path}`;
      push({
        k: "endpoint",
        id: `${a.id} ${label}`,
        t: label,
        s: clip(`${e.operationId ? e.operationId + " — " : ""}${e.purpose || ""}`, 180),
        r: `#/app/${a.id}/facts?endpoint=${encodeURIComponent(label)}`,
        a: a.id,
        x: `${e.operationId || ""} ${e.tag || ""}`.toLowerCase(),
      });
    });
  }
  for (const t of outTerms) {
    push({
      k: "term",
      id: t.id,
      t: t.term || t.id,
      s: clip(plainMarkdown(t.definition), 180),
      r: `#/glossary/${t.id}`,
      a: resolveApp(asArray(t.apps)[0]) || "",
      x: [t.id, ...asArray(t.aliases), t.category].join(" ").toLowerCase(),
    });
  }
  for (const j of outJourneys) {
    push({
      k: "journey",
      id: j.id,
      t: j.title || j.id,
      s: clip(plainMarkdown(j.summary), 180),
      r: `#/journey/${j.id}`,
      a: resolveApp(asArray(j.apps)[0]) || "",
      x: asArray(j.steps)
        .map((s) => s && s.title)
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    });
  }
  for (const key of Object.keys(outDiagrams)) {
    const d = outDiagrams[key];
    push({
      k: "diagram",
      id: key,
      t: d.title || key,
      s: clip(plainMarkdown(d.caption || ""), 180),
      r: `#/diagram/${key}`,
      a: d.app,
      x: `${d.type} ${key}`.toLowerCase(),
    });
  }
  for (const c of ontology.classes.filter((c) => c && c.id)) {
    push({
      k: "class",
      id: c.id,
      t: c.label || c.id,
      s: clip(plainMarkdown(c.description || ""), 180),
      r: `#/ontology/${c.id}`,
      a: "",
      x: [c.id, ...asArray(c.examples)].join(" ").toLowerCase(),
    });
  }
  for (const x of outIssues) {
    push({
      k: "issue",
      id: x.id,
      t: x.title || x.id,
      s: clip(plainMarkdown(x.summary || ""), 180),
      r: `#/issue/${x.id}`,
      a: x.app || "",
      x: [x.id, x.severity, x.kind, x.status, x.journey, x.step, ...asArray(x.terms), ...asArray(x.files)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    });
  }
  for (const e of search) if (!e.x) delete e.x;

  /* ---------- statistics */
  const countBy = (list, fn) => {
    const out = {};
    for (const x of list) {
      const k = fn(x);
      if (k) out[k] = (out[k] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => cmp(a[0], b[0])));
  };
  const allDiagrams = Object.values(outDiagrams);
  // bundleStats must not depend on where the build runs (scratch copy or inside the repository), so the number of
  // repo paths actually checked stays out of the bundle; only the count of repo references goes in.
  const bundleStats = {
    pages: outPages.length,
    apps: outApps.length,
    screens: outApps.reduce((n, a) => n + asArray(a.screens).length, 0),
    endpoints: outApps.reduce((n, a) => n + asArray(a.endpoints).length, 0),
    journeys: outJourneys.length,
    journeySteps: outJourneys.reduce((n, j) => n + asArray(j.steps).length, 0),
    diagrams: allDiagrams.length,
    diagramsByType: countBy(allDiagrams, (d) => d.type),
    terms: outTerms.length,
    termsByCategory: countBy(outTerms, (t) => t.category),
    taxonomyNodes: taxNodes,
    classes: ontology.classes.length,
    properties: ontology.properties.length,
    individuals: ontology.individuals.length,
    assertions: ontology.assertions.length,
    relations: relations.length,
    issues: outIssues.length,
    issuesBySeverity: countBy(outIssues, (x) => x.severity),
    issuesByKind: countBy(outIssues, (x) => x.kind),
    issuesByStatus: countBy(outIssues, (x) => x.status),
    issuesByApp: countBy(outIssues, (x) => x.app),
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
    topologyNodes: topology ? asArray(topology.nodes).length : 0,
    topologyLinks: topology ? asArray(topology.links).length : 0,
    flows: topology ? asArray(topology.flows).length : 0,
    words:
      outPages.reduce((n, p) => n + p.words, 0) +
      outApps.reduce((n, a) => n + (a.usage?.words || 0) + (a.architecture?.words || 0), 0),
    searchEntries: search.length,
    repoPaths: repoRefs.length,
  };
  const stats = { ...bundleStats, repoPathsChecked: repoChecked };

  const data = {
    generator: {
      name: "guidebook/tools/build.mjs",
      version: BUILDER_VERSION,
      note: "Generated file: edit content/ and run the build.",
    },
    site,
    pages: outPages,
    apps: outApps,
    diagrams: outDiagrams,
    journeys: outJourneys,
    terms: outTerms,
    issues: outIssues,
    taxonomy: taxonomy || null,
    ontology,
    relations,
    topology: topology || null,
    graph,
    search,
    stats: bundleStats,
  };
  // The first line keeps Prettier off the generated bundle (`prettier --check guidebook` accepts it as it is).
  const output =
    "// prettier-ignore\n" +
    "/* Generated by guidebook/tools/build.mjs from guidebook/content. Do not edit; run the build instead. */\n" +
    `window.VG_CONTENT = ${JSON.stringify(data)};\n`;
  return { data, output, errors: report.errors, warnings: report.warnings, stats, repoRoot };
}

/* ------------------------------------------------------------------------------------------------ CLI */

function parseArgs(argv) {
  const opts = {
    content: null,
    out: null,
    check: false,
    strict: false,
    repo: undefined,
    force: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--content") opts.content = next();
    else if (a === "--out") opts.out = next();
    else if (a === "--repo") opts.repo = next();
    else if (a === "--check") opts.check = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.error(`build: ${err.message}`);
    return 2;
  }
  if (opts.help) {
    io.log(
      "usage: node tools/build.mjs [--content <dir>] [--out <file>] [--check] [--strict] [--repo <dir>|none] [--force] [--quiet]",
    );
    return 0;
  }
  const contentDir = path.resolve(opts.content || DEFAULT_CONTENT);
  const out = path.resolve(opts.out || DEFAULT_OUT);
  const repoRoot = opts.repo === undefined ? findRepoRoot() : findRepoRoot(opts.repo);
  if (opts.repo && opts.repo !== "none" && !repoRoot) {
    io.error(`build: --repo ${opts.repo} has no pnpm-workspace.yaml`);
    return 2;
  }
  const result = build({ contentDir, repoRoot });
  for (const w of result.warnings) io.error(`WARN  ${w}`);
  for (const e of result.errors) io.error(`ERROR ${e}`);
  const failed = result.errors.length > 0 || (opts.strict && result.warnings.length > 0);
  const s = result.stats;
  const summary = `${s.pages} pages, ${s.apps} apps, ${s.diagrams} diagrams, ${s.journeys} journeys, ${s.terms} terms, ${s.issues} issues, ${s.classes} classes, ${s.graphNodes} graph nodes, ${s.searchEntries} search entries`;
  if (opts.check) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
    if (current !== result.output) {
      io.error(
        `build: ${path.relative(process.cwd(), out) || out} is ${current === null ? "missing" : "stale"}; run node tools/build.mjs and commit the result`,
      );
      return 1;
    }
    if (!opts.quiet)
      io.log(
        `build: ${out} is up to date (${summary}); ${result.errors.length} errors, ${result.warnings.length} warnings`,
      );
    return failed ? 1 : 0;
  }
  if (result.errors.length && !opts.force) {
    io.error(`build: ${result.errors.length} errors; ${out} was not written (use --force to write anyway)`);
    return 1;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, result.output);
  if (!opts.quiet) {
    io.log(
      `build: wrote ${out} (${(result.output.length / 1024).toFixed(1)} KiB): ${summary}; ${result.errors.length} errors, ${result.warnings.length} warnings${result.repoRoot ? "" : " (repo paths not checked)"}`,
    );
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
