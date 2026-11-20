/*
 * Velexis Guidebook: text helpers shared by the site and tools/build.mjs.
 * tools/build.mjs evaluates this file in a node:vm context, so heading slugs computed at build time (search index,
 * table of contents) are identical to the ids the browser gives the rendered headings. Keep it free of DOM access.
 */
(function (root) {
  "use strict";
  const VG = (root.VG = root.VG || {});

  /**
   * Visible text of a raw markdown heading or line: drops the guidebook's link syntax and inline markup. Code spans
   * are kept as written (`tenant_<key>` stays "tenant_<key>": its `<key>` is not an HTML tag, its `__` no emphasis).
   */
  function plainInline(raw) {
    // A code span waits as "\uE000<n>\uE000" (a private-use character, never in the content) while the markup goes.
    const code = [];
    return String(raw ?? "")
      .replace(/\[\[([^\]|\n]+?)\|([^\]\n]+)\]\]/g, "$2")
      .replace(/\[\[(?:[a-z]+:)?([^\]\n]+)\]\]/g, "$1")
      .replace(/`(?:repo:)?([^`]*)`/g, (m, c) => `\uE000${code.push(c) - 1}\uE000`)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/(\*\*|__|\*|~~)/g, "")
      .replace(/\uE000(\d+)\uE000/g, (m, i) => code[Number(i)])
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Stable, URL-safe id for a heading: "Before you start" -> "before-you-start". */
  function slugify(raw) {
    const s = plainInline(raw)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return s || "section";
  }

  /** Makes slugs unique within one document: x, x-2, x-3 ... */
  function createSlugger() {
    const seen = new Map();
    return function next(raw) {
      const base = slugify(raw);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : base + "-" + n;
    };
  }

  /** Fenced blocks whose body is prose (kept in plain text); other fences (code, diagram ids) are dropped. */
  const PROSE_FENCES = new Set(["tip", "note", "warning", "bug-hunt", "try"]);

  /** Plain text of a markdown fragment (for search snippets and word counts). */
  function plainMarkdown(md) {
    const out = [];
    let fence = null;
    for (const line of String(md ?? "").split("\n")) {
      const m = /^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
      if (fence) {
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2]) fence = null;
        else if (fence.prose) out.push(line);
        continue;
      }
      if (m) {
        fence = { ch: m[1][0], len: m[1].length, prose: PROSE_FENCES.has(m[2]) };
        continue;
      }
      out.push(line);
    }
    return out
      .join("\n")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
      .replace(/\|/g, " ")
      .split("\n")
      .map(plainInline)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Lower-case search tokens. */
  function tokenize(text) {
    return String(text ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9_.@/-]+/)
      .filter(Boolean);
  }

  VG.text = { plainInline, slugify, createSlugger, plainMarkdown, tokenize };
})(typeof window !== "undefined" ? window : globalThis);
