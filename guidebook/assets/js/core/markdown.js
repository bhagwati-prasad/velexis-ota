/*
 * Velexis Guidebook: markdown renderer (marked + DOMPurify) with the guidebook's extensions (SCHEMA §2):
 * [[term]] / [[term|text]] glossary links with hover cards, [[app:x]] [[page:x]] [[journey:x]] [[diagram:a/b]] links,
 * `repo:path` links, ```diagram blocks, callouts (tip, note, warning, bug-hunt), ```try cards, heading anchors.
 */
(function () {
  "use strict";
  const VG = window.VG;
  const esc = VG.esc;
  const md = (VG.md = {});

  const CALLOUTS = {
    tip: { title: "Tip", icon: "bulb" },
    note: { title: "Note", icon: "book" },
    warning: { title: "Warning", icon: "flag" },
    "bug-hunt": { title: "Bug hunt: worth testing", icon: "bug" },
  };
  const TRY_LABELS = {
    url: "URL",
    login: "Login",
    password: "Password",
    command: "Command",
    expect: "Expect",
  };

  /** Render context of the document being rendered (headings need a slugger and the document's route). */
  let ctx = { app: null, base: "", slug: VG.text.createSlugger() };

  md.ready = () => Boolean(window.marked && window.DOMPurify);

  /* ---------------------------------------------------------------- links */

  function linkHtml(target, label) {
    const D = VG.data;
    const m = /^([a-z]+):(.+)$/.exec(target);
    const kind = m && ["app", "page", "journey", "diagram", "term"].includes(m[1]) ? m[1] : "term";
    const id = (m && kind === m[1] ? m[2] : target).trim();
    const broken = (what) =>
      `<span class="vg-broken" title="Unknown ${what}: ${esc(id)}">${esc(label || id)}</span>`;
    if (kind === "app") {
      const a = D.app(id);
      return a
        ? `<a class="vg-xref vg-xref-app" href="${VG.routes.app(a.id)}">${esc(label || a.name || a.id)}</a>`
        : broken("app");
    }
    if (kind === "page") {
      const p = D.pages.get(id);
      return p
        ? `<a class="vg-xref" href="${VG.routes.page(id)}">${esc(label || p.title)}</a>`
        : broken("page");
    }
    if (kind === "journey") {
      const j = D.journeys.get(id);
      return j
        ? `<a class="vg-xref vg-xref-journey" href="${VG.routes.journey(id)}">${esc(label || j.title)}</a>`
        : broken("journey");
    }
    if (kind === "diagram") {
      const d = D.diagram(id, ctx.app);
      return d
        ? `<a class="vg-xref vg-xref-diagram" href="${VG.routes.diagram(d.key)}">${esc(label || d.title)}</a>`
        : broken("diagram");
    }
    const t = D.terms.get(id);
    return t
      ? `<a class="vg-term" data-term="${esc(id)}" href="${VG.routes.term(id)}">${esc(label || t.term || id)}</a>`
      : broken("term");
  }
  md.linkHtml = linkHtml;

  function repoHtml(path) {
    const clean = String(path).trim();
    return `<a class="vg-repo" href="${esc(VG.data.repoUrl(clean))}" target="_blank" rel="noopener noreferrer" title="Open in the repository"><code>${esc(clean)}</code></a>`;
  }

  /* ---------------------------------------------------------------- blocks */

  function calloutHtml(lang, body) {
    const c = CALLOUTS[lang];
    const inner = window.marked.parse(body);
    return (
      `<aside class="vg-callout vg-callout-${lang}" aria-label="${esc(c.title)}">` +
      `<p class="vg-callout-title"><span class="vg-callout-icon" data-icon="${c.icon}"></span>${esc(c.title)}</p>` +
      `<div class="vg-callout-body">${inner}</div></aside>\n`
    );
  }

  function tryHtml(body) {
    const rows = [];
    for (const line of body.split("\n")) {
      const m = /^\s*([a-z]+)\s*:\s*(.*)$/.exec(line);
      if (!m || !m[2].trim()) continue;
      const key = m[1];
      const value = m[2].trim();
      let shown;
      if (key === "expect") shown = `<span class="vg-try-expect">${window.marked.parseInline(value)}</span>`;
      else if (key === "url" && /^https?:\/\//.test(value))
        shown = `<a class="vg-try-val" data-copy="${esc(value)}" href="${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a>`;
      else shown = `<code class="vg-try-val" data-copy="${esc(value)}">${esc(value)}</code>`;
      rows.push(
        `<div class="vg-try-row vg-try-${esc(key)}"><dt>${esc(TRY_LABELS[key] || key)}</dt><dd>${shown}</dd></div>`,
      );
    }
    return `<div class="vg-try"><p class="vg-try-title"><span class="vg-callout-icon" data-icon="play"></span>Try it</p><dl>${rows.join("")}</dl></div>\n`;
  }

  /* ---------------------------------------------------------------- marked setup */

  let configured = false;
  function configure() {
    if (configured || !md.ready()) return;
    configured = true;
    window.marked.use({
      gfm: true,
      extensions: [
        {
          name: "vglink",
          level: "inline",
          start(src) {
            const i = src.indexOf("[[");
            return i < 0 ? undefined : i;
          },
          tokenizer(src) {
            const m = /^\[\[([^\]|\n]+?)(?:\\?\|([^\]\n]+))?\]\]/.exec(src);
            if (!m) return undefined;
            return {
              type: "vglink",
              raw: m[0],
              target: m[1].replace(/\\$/, "").trim(),
              label: m[2] ? m[2].trim() : null,
            };
          },
          renderer(token) {
            return linkHtml(token.target, token.label);
          },
        },
      ],
      renderer: {
        heading(token) {
          const inner = this.parser.parseInline(token.tokens);
          if (token.depth > 4) return `<h${token.depth}>${inner}</h${token.depth}>\n`;
          const slug = ctx.slug(token.text);
          const href = ctx.base ? `${ctx.base}?s=${encodeURIComponent(slug)}` : "";
          const anchor = href
            ? ` <a class="vg-anchor" href="${href}" aria-label="Link to this section" title="Link to this section">#</a>`
            : "";
          return `<h${token.depth} id="sec-${slug}" data-slug="${slug}">${inner}${anchor}</h${token.depth}>\n`;
        },
        code(token) {
          const lang = (token.lang || "").trim().split(/\s+/)[0];
          const text = String(token.text || "");
          if (lang === "diagram") {
            const id = text.trim().split("\n")[0].trim();
            return `<div class="vg-diagram-slot" data-diagram="${esc(id)}"></div>\n`;
          }
          if (CALLOUTS[lang]) return calloutHtml(lang, text);
          if (lang === "try") return tryHtml(text);
          const cls = lang ? ` class="language-${esc(lang)}"` : "";
          return `<pre class="vg-code"${lang ? ` data-lang="${esc(lang)}"` : ""}><code${cls}>${esc(text)}</code></pre>\n`;
        },
        codespan(token) {
          const raw = String(token.text || "");
          if (raw.startsWith("repo:")) return repoHtml(raw.slice(5));
          return `<code>${esc(raw)}</code>`;
        },
        link(token) {
          const inner = this.parser.parseInline(token.tokens);
          const href = String(token.href || "");
          const title = token.title ? ` title="${esc(token.title)}"` : "";
          if (href.startsWith("repo:")) {
            return `<a class="vg-repo" href="${esc(VG.data.repoUrl(href.slice(5)))}" target="_blank" rel="noopener noreferrer"${title}>${inner}</a>`;
          }
          if (/^https?:\/\//i.test(href)) {
            return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${title}>${inner}</a>`;
          }
          if (/^(#|mailto:)/i.test(href)) return `<a href="${esc(href)}"${title}>${inner}</a>`;
          return `<a href="${esc(href)}"${title}>${inner}</a>`;
        },
      },
    });
    window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A" && node.getAttribute("target") === "_blank")
        node.setAttribute("rel", "noopener noreferrer");
    });
  }

  const PURIFY = { ADD_ATTR: ["target"], FORBID_TAGS: ["style", "form", "input", "textarea", "select"] };

  /** Escapes "|" inside [[a|b]] on table rows, so GFM does not split the cell there. */
  function protectTables(src) {
    let fence = false;
    return src
      .split("\n")
      .map((line) => {
        if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
        if (fence || !line.includes("[[") || !/^\s*\|/.test(line)) return line;
        return line.replace(/\[\[([^\]\n|]*?)\|([^\]\n]*?)\]\]/g, "[[$1\\|$2]]");
      })
      .join("\n");
  }

  /** Plain fallback when marked or DOMPurify did not load: escaped paragraphs, links shown as text. */
  function fallbackHtml(src) {
    const text = String(src || "")
      .replace(/\[\[(?:[a-z]+:)?([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/g, (_, a, b) => b || a)
      .replace(/`repo:([^`]+)`/g, "$1");
    return text
      .split(/\n{2,}/)
      .map((p) => `<p class="vg-plain">${esc(p).replace(/\n/g, "<br>")}</p>`)
      .join("\n");
  }

  /** Markdown to sanitised HTML. opts: { app, base } (base = route of the document, for heading anchors). */
  md.render = function render(src, opts) {
    configure();
    if (!md.ready()) return fallbackHtml(src);
    const prev = ctx;
    ctx = { app: (opts && opts.app) || null, base: (opts && opts.base) || "", slug: VG.text.createSlugger() };
    try {
      const html = window.marked.parse(protectTables(String(src || "")));
      return window.DOMPurify.sanitize(html, PURIFY);
    } finally {
      ctx = prev;
    }
  };

  /** Inline markdown (no paragraphs) to sanitised HTML. */
  md.inline = function inline(src, opts) {
    configure();
    if (!md.ready())
      return esc(
        String(src || "").replace(/\[\[(?:[a-z]+:)?([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/g, (_, a, b) => b || a),
      );
    const prev = ctx;
    ctx = { app: (opts && opts.app) || null, base: "", slug: VG.text.createSlugger() };
    try {
      return window.DOMPurify.sanitize(window.marked.parseInline(String(src || "")), PURIFY);
    } finally {
      ctx = prev;
    }
  };

  /**
   * Inline markdown into an element, replacing its content; returns the element. The views put inline markdown into
   * the page only through this function, so that every HTML sink takes md.inline's sanitised output.
   */
  md.inlineInto = function inlineInto(el, src, opts) {
    // eslint-disable-next-line no-unsanitized/property -- md.inline returns DOMPurify's output (escaped text without DOMPurify)
    el.innerHTML = md.inline(src, opts);
    return el;
  };

  /** Block markdown into an element (for short fields such as journey actions or diagram details). */
  md.block = function block(src, opts) {
    const div = VG.h("div", { class: "vg-md" });
    // eslint-disable-next-line no-unsanitized/property -- md.render returns DOMPurify's output (escaped text without DOMPurify)
    div.innerHTML = md.render(src, opts);
    enhance(div, opts || {});
    return div;
  };

  /* ---------------------------------------------------------------- DOM enhancement */

  function enhance(root, opts) {
    const instances = [];
    for (const el of root.querySelectorAll(".vg-callout-icon[data-icon]")) {
      el.appendChild(VG.icon(el.dataset.icon, null, 16));
    }
    for (const el of root.querySelectorAll("[data-copy]")) {
      el.after(
        VG.ui.copyButton(
          el.getAttribute("data-copy"),
          el.closest(".vg-try-row")?.querySelector("dt")?.textContent,
        ),
      );
    }
    for (const pre of root.querySelectorAll("pre.vg-code")) {
      const wrap = VG.h("div", { class: "vg-code-wrap" });
      pre.replaceWith(wrap);
      wrap.appendChild(pre);
      wrap.appendChild(
        VG.ui.copyButton(() => pre.textContent, pre.dataset.lang ? `${pre.dataset.lang} code` : "code"),
      );
    }
    for (const table of root.querySelectorAll("table")) {
      if (table.parentElement && table.parentElement.classList.contains("vg-table-wrap")) continue;
      table.classList.add("vg-table");
      const wrap = VG.h("div", {
        class: "vg-table-wrap",
        tabindex: "0",
        role: "region",
        "aria-label": "Table",
      });
      table.replaceWith(wrap);
      wrap.appendChild(table);
    }
    for (const slot of root.querySelectorAll(".vg-diagram-slot[data-diagram]")) {
      const inst = VG.widgets.mount(slot, slot.dataset.diagram, { app: opts.app || null });
      if (inst) instances.push(inst);
    }
    return instances;
  }
  md.enhance = enhance;

  /**
   * Renders a document into `container`: sanitised HTML, diagrams, copy buttons. Returns
   * { headings: [{ depth, id, slug, text }], destroy() }.
   */
  md.mount = function mount(container, src, opts) {
    const o = opts || {};
    container.classList.add("vg-md");
    // eslint-disable-next-line no-unsanitized/property -- md.render returns DOMPurify's output (escaped text without DOMPurify)
    container.innerHTML = md.render(src, o);
    const instances = enhance(container, o);
    const headings = Array.from(container.querySelectorAll("h2[id], h3[id]"))
      .filter((el) => !el.closest(".vg-callout, .vg-figure"))
      .map((el) => ({
        depth: Number(el.tagName[1]),
        id: el.id,
        slug: el.dataset.slug,
        text: el.textContent.replace(/\s*#$/, "").trim(),
      }));
    return {
      headings,
      destroy() {
        for (const i of instances) if (i && i.destroy) i.destroy();
      },
    };
  };
})();
