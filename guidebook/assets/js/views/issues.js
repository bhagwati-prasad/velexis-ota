/*
 * Velexis Guidebook views: known issues (#/issues?app=&severity=&kind=&status=&q=&journey=&step=&sort=&open=) and one
 * issue (#/issue/<id>). The list filters with chips (several values per group are OR, groups are AND) and a text box,
 * sorts by any column, expands a row to the full record, copies the filtered list as a Markdown checklist and
 * downloads it as JSON. Every filter is in the URL, so a filtered view can be shared.
 */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  const SEVERITIES = ["critical", "high", "medium", "low"];
  const KINDS = ["bug", "security", "db", "ux", "perf", "docs"];
  const STATUSES = ["confirmed", "plausible"];
  const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
  const KIND_LABEL = {
    bug: "Bug",
    security: "Security",
    db: "Database",
    ux: "UX",
    perf: "Performance",
    docs: "Docs",
  };
  const STATUS_LABEL = { confirmed: "Confirmed", plausible: "Plausible" };
  const SORTS = [
    { id: "id", label: "Id (severity, then app)" },
    { id: "severity", label: "Severity" },
    { id: "app", label: "App" },
    { id: "kind", label: "Kind" },
    { id: "status", label: "Status" },
    { id: "title", label: "Title" },
  ];

  const rank = (list, v) => {
    const i = list.indexOf(v);
    return i < 0 ? list.length : i;
  };
  const issueNum = (id) => Number(String(id).replace(/^\D+/, "")) || 0;
  const csv = (v) =>
    String(v || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  /** `path:12` or `path:12-20` -> { path, line, end, label }. */
  function parseWhere(w) {
    const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(String(w || "").trim());
    if (!m) return { path: String(w || "").trim(), line: 0, end: 0, label: String(w || "").trim() };
    return { path: m[1], line: Number(m[2]), end: Number(m[3] || m[2]), label: w };
  }
  /** Repository link whose long path may wrap after each slash. */
  function pathLink(path, label) {
    const code = h("code", {});
    String(label || path)
      .split(/(?<=\/)/)
      .forEach((seg, i) => {
        if (i) code.appendChild(h("wbr"));
        code.appendChild(document.createTextNode(seg));
      });
    return h(
      "a",
      {
        class: "vg-repo",
        href: VG.data.repoUrl(path),
        target: "_blank",
        rel: "noopener noreferrer",
        title: "Open in the repository",
      },
      code,
    );
  }
  function whereLink(w) {
    const p = parseWhere(w);
    const anchor = p.line ? `#L${p.line}${p.end !== p.line ? "-L" + p.end : ""}` : "";
    return pathLink(p.path + anchor, p.label);
  }
  function guideBase() {
    return location.href.split("#")[0];
  }
  function appLabel(id) {
    return VG.data.appName(id);
  }

  /* ---------------------------------------------------------------- small pieces */

  function severityBadge(sev) {
    return h(
      "span",
      { class: `vg-sev is-${sev}` },
      h("span", { class: "vg-kind-dot", style: { background: `var(--sev-${sev}, var(--k-other))` } }),
      SEVERITY_LABEL[sev] || sev || "?",
    );
  }
  function kindBadge(kind) {
    return h("span", { class: "vg-badge" }, KIND_LABEL[kind] || kind || "?");
  }
  function statusBadge(status) {
    return h(
      "span",
      { class: `vg-badge vg-issue-status is-${status}` },
      STATUS_LABEL[status] || status || "?",
    );
  }
  function appBadge(id) {
    const D = VG.data;
    const app = D.app(id);
    return app
      ? h(
          "a",
          { class: "vg-badge", href: VG.routes.app(app.id) },
          h("span", { class: "vg-kind-dot", style: { background: `var(--p-${app.product || "shared"})` } }),
          app.name || app.id,
        )
      : h("span", { class: "vg-badge" }, id || "?");
  }
  function journeyStep(x) {
    const D = VG.data;
    const j = x.journey ? D.journeys.get(x.journey) : null;
    if (!j) return null;
    const steps = j.steps || [];
    const i = x.step ? steps.findIndex((s) => s.id === x.step) : -1;
    const href = `${VG.routes.journey(j.id)}${i >= 0 ? "?step=" + encodeURIComponent(x.step) : ""}`;
    return {
      href,
      text: i >= 0 ? `${j.title} › step ${i + 1}: ${steps[i].title}` : j.title,
      journey: j,
      index: i,
    };
  }

  /* ---------------------------------------------------------------- markdown export */

  function inlineMd(s) {
    return String(s || "")
      .replace(/\s*\n\s*/g, " ")
      .trim();
  }
  function issueMarkdown(x) {
    const D = VG.data;
    const js = journeyStep(x);
    const lines = [
      `## ${x.id}: ${x.title}`,
      "",
      `- **Severity:** ${x.severity} · **Kind:** ${x.kind} · **Status:** ${x.status}`,
      `- **App:** ${appLabel(x.app)} (\`${D.resolveApp(x.app)}\`)`,
    ];
    if (js) lines.push(`- **Journey:** ${js.text} (\`${x.journey}${x.step ? " / " + x.step : ""}\`)`);
    lines.push(`- **Database migration needed:** ${x.migration ? "yes" : "no"}`);
    if ((x.terms || []).length) lines.push(`- **Terms:** ${x.terms.join(", ")}`);
    lines.push(
      `- **Guide:** ${guideBase()}${VG.routes.issue(x.id)}`,
      "",
      "### Summary",
      "",
      inlineMd(x.summary),
      "",
    );
    lines.push(
      "### Steps to reproduce",
      "",
      ...(x.reproduce || []).map((s, i) => `${i + 1}. ${inlineMd(s)}`),
      "",
    );
    lines.push("### Expected", "", inlineMd(x.expected), "", "### Actual", "", inlineMd(x.actual), "");
    lines.push(
      "### Fix",
      "",
      inlineMd(x.fix),
      "",
      "### Where",
      "",
      ...(x.where || []).map((w) => `- \`${w}\``),
      "",
    );
    lines.push(
      "### Files to change",
      "",
      ...(x.files || []).map((f) => `- \`${f}\``),
      ...(x.newFiles || []).map((f) => `- \`${f}\` (new)`),
      "",
    );
    return lines.join("\n");
  }
  function listMarkdown(list, filterText) {
    const D = VG.data;
    const site = D.site || {};
    const total = D.issueList().length;
    const lines = [
      `## Known issues (${list.length === total ? total : `${list.length} of ${total}`})`,
      "",
      `${site.title || "Velexis Guidebook"}${site.commit ? `, code at ${site.commit}` : ""}.${filterText ? ` Filters: ${filterText}.` : ""}`,
      "",
    ];
    for (const x of list) {
      const files = [
        ...(x.files || []).map((f) => `\`${f}\``),
        ...(x.newFiles || []).map((f) => `\`${f}\` (new)`),
      ];
      lines.push(
        `- [ ] **${x.id}** (${x.severity} · ${x.kind} · ${appLabel(x.app)}${x.status === "plausible" ? " · plausible" : ""}) ${x.title}`,
        `  - Summary: ${inlineMd(x.summary)}`,
        `  - Fix: ${inlineMd(x.fix)}`,
        `  - Files: ${files.join(", ")}${x.migration ? " (needs a database migration)" : ""}`,
        `  - Guide: ${guideBase()}${VG.routes.issue(x.id)}`,
      );
    }
    return lines.join("\n") + "\n";
  }

  /** Saves `text` as a file with a Blob URL (works from file://; no server involved). */
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name, hidden: true });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function jsonExport(list, filters) {
    const site = VG.data.site || {};
    return (
      JSON.stringify(
        {
          source: site.title || "Velexis Guidebook",
          commit: site.commit || null,
          exported: new Date().toISOString(),
          filters,
          count: list.length,
          issues: list,
        },
        null,
        2,
      ) + "\n"
    );
  }

  /* ---------------------------------------------------------------- the full record */

  /** The full record of an issue. opts: { level: 2|3 (heading level), page: bool }. */
  function issueBody(x, opts) {
    const o = opts || {};
    const H = `h${o.level || 3}`;
    const D = VG.data;
    const md = { app: D.resolveApp(x.app) };
    const js = journeyStep(x);
    const wrap = h("div", { class: "vg-issue" });
    wrap.appendChild(
      h(
        "div",
        { class: "vg-meta" },
        severityBadge(x.severity),
        kindBadge(x.kind),
        statusBadge(x.status),
        appBadge(x.app),
        x.migration
          ? h("span", { class: "vg-badge vg-issue-migration" }, "Needs a database migration")
          : null,
      ),
    );
    if (x.status === "plausible") {
      wrap.appendChild(
        h(
          "p",
          { class: "vg-issue-note" },
          "Plausible: the code allows it, but it has not been reproduced yet. Reproduce it before fixing.",
        ),
      );
    }
    wrap.appendChild(VG.md.block(x.summary || "", md));
    wrap.appendChild(h(H, {}, "Steps to reproduce"));
    const ol = h("ol", { class: "vg-issue-steps" });
    for (const s of x.reproduce || []) {
      const li = h("li", {});
      VG.md.inlineInto(li, s, md);
      ol.appendChild(li);
    }
    wrap.appendChild(ol);
    wrap.appendChild(
      h(
        "div",
        { class: "vg-issue-ea" },
        h(
          "div",
          { class: "vg-expect" },
          h("span", { class: "vg-expect-label" }, "Expected"),
          VG.md.block(x.expected || "", md),
        ),
        h(
          "div",
          { class: "vg-expect vg-actual" },
          h("span", { class: "vg-expect-label" }, "Actual"),
          VG.md.block(x.actual || "", md),
        ),
      ),
    );
    wrap.appendChild(h(H, {}, "Fix"));
    wrap.appendChild(VG.md.block(x.fix || "", md));
    const grid = h("div", { class: "vg-facts-grid vg-issue-grid" });
    grid.appendChild(
      h(
        "div",
        { class: "vg-box" },
        h(H, {}, "Where (evidence)"),
        h(
          "ul",
          { class: "vg-linklist" },
          (x.where || []).map((w) => h("li", {}, whereLink(w))),
        ),
      ),
    );
    grid.appendChild(
      h(
        "div",
        { class: "vg-box" },
        h(H, {}, "Files to change"),
        h(
          "ul",
          { class: "vg-linklist" },
          (x.files || []).map((f) => h("li", {}, pathLink(f))),
          (x.newFiles || []).map((f) =>
            h("li", {}, h("code", {}, f), " ", h("span", { class: "vg-badge" }, "new")),
          ),
        ),
        h(
          "p",
          { class: "vg-muted vg-issue-mig" },
          x.migration ? "Needs a database migration." : "No database migration needed.",
        ),
      ),
    );
    if (js || (x.terms || []).length) {
      const terms = (x.terms || []).map((id) => D.terms.get(id)).filter(Boolean);
      grid.appendChild(
        h(
          "div",
          { class: "vg-box" },
          h(H, {}, "Related"),
          js
            ? h(
                "p",
                { class: "vg-issue-journey" },
                VG.icon("journey", null, 15),
                " ",
                h("a", { href: js.href }, js.text),
              )
            : null,
          terms.length
            ? h(
                "div",
                { class: "vg-tag-list" },
                terms.map((t) =>
                  h(
                    "a",
                    { class: "vg-chip vg-term", href: VG.routes.term(t.id), dataset: { term: t.id } },
                    h("span", { class: "vg-kind-dot", style: { background: VG.categoryVar(t.category) } }),
                    t.term,
                  ),
                ),
              )
            : null,
        ),
      );
    }
    wrap.appendChild(grid);
    wrap.appendChild(
      h(
        "div",
        { class: "vg-toolbar" },
        h(
          "button",
          {
            type: "button",
            class: "vg-btn",
            onclick: () => VG.copy(issueMarkdown(x), `${x.id} as Markdown`),
          },
          VG.icon("copy", null, 16),
          "Copy as Markdown",
        ),
        o.page
          ? null
          : h(
              "a",
              { class: "vg-btn", href: VG.routes.issue(x.id) },
              VG.icon("expand", null, 16),
              "Open full page",
            ),
        h(
          "a",
          { class: "vg-btn", href: VG.routes.graph(`issue:${x.id}`) },
          VG.icon("graph", null, 16),
          "Show in the graph",
        ),
      ),
    );
    return wrap;
  }
  VG.issues = { issueMarkdown, listMarkdown, issueBody, parseWhere };

  /* ---------------------------------------------------------------- list */

  VG.views.register("issues", {
    title: () => "Known issues",
    wide: true,
    render(main, route) {
      const D = VG.data;
      const all = D.issueList();
      VG.layout.setCrumbs([{ label: "Known issues" }]);
      const site = D.site || {};
      main.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h("h1", {}, "Known issues"),
          h(
            "p",
            { class: "vg-lede" },
            `Verified defects in the code${site.commit ? " at " + site.commit : ""}: your starting backlog. Filter them, open a row for the steps, the expected result and the files to change, then copy the list as a Markdown checklist or download it as JSON.`,
          ),
        ),
      );
      if (!all.length) {
        main.appendChild(
          VG.ui.empty("No known issues", "Add issues to content/issues/*.json and rebuild (see the README)."),
        );
        return {};
      }

      /* ---------- state from the URL */
      const p = route.params;
      const appIds = D.appList()
        .map((a) => a.id)
        .filter((id) => all.some((x) => D.resolveApp(x.app) === id));
      const facets = [
        {
          key: "severity",
          label: "Severity",
          values: SEVERITIES.filter((v) => all.some((x) => x.severity === v)),
          name: (v) => SEVERITY_LABEL[v],
          color: (v) => `var(--sev-${v})`,
          of: (x) => x.severity,
        },
        {
          key: "kind",
          label: "Kind",
          values: KINDS.filter((v) => all.some((x) => x.kind === v)),
          name: (v) => KIND_LABEL[v],
          of: (x) => x.kind,
        },
        {
          key: "status",
          label: "Status",
          values: STATUSES.filter((v) => all.some((x) => x.status === v)),
          name: (v) => STATUS_LABEL[v],
          of: (x) => x.status,
        },
        {
          key: "app",
          label: "App",
          values: appIds,
          name: (v) => appLabel(v),
          color: (v) => `var(--p-${(D.app(v) || {}).product || "shared"})`,
          of: (x) => D.resolveApp(x.app),
        },
      ];
      const sel = {};
      for (const f of facets) {
        const raw = csv(p.get(f.key)).map((v) => (f.key === "app" ? D.resolveApp(v) : v));
        sel[f.key] = new Set(raw.filter((v) => f.values.includes(v)));
      }
      const ctx = { journey: p.get("journey") || "", step: p.get("step") || "" };
      if (ctx.journey && !D.journeys.get(ctx.journey)) ctx.journey = ctx.step = "";
      let sortKey = String(p.get("sort") || "id");
      let desc = sortKey.startsWith("-");
      sortKey = sortKey.replace(/^-/, "");
      if (!SORTS.some((s) => s.id === sortKey)) sortKey = "id";
      const open = new Set(csv(p.get("open")).filter((id) => D.issues.has(id)));

      /* ---------- controls */
      const qId = VG.uid("iq");
      const q = h("input", {
        type: "search",
        id: qId,
        class: "vg-input vg-issues-q",
        placeholder: "Filter by text, id, file…",
        "aria-label": "Filter issues by text, id or file",
        autocomplete: "off",
        value: p.get("q") || "",
      });
      const sortSel = h(
        "select",
        { class: "vg-select", "aria-label": "Sort issues by" },
        SORTS.map((s) =>
          h("option", { value: s.id, selected: s.id === sortKey ? true : null }, `Sort: ${s.label}`),
        ),
      );
      const dirBtn = h("button", {
        type: "button",
        class: "vg-btn",
        "aria-label": "Reverse the order",
        title: "Reverse the order",
      });
      const copyBtn = h(
        "button",
        { type: "button", class: "vg-btn is-primary", id: "vg-issues-copy" },
        VG.icon("copy", null, 16),
        "Copy as Markdown",
      );
      const dlBtn = h(
        "button",
        { type: "button", class: "vg-btn", id: "vg-issues-download" },
        VG.icon("download", null, 16),
        "Download JSON",
      );
      const clearBtn = h(
        "button",
        { type: "button", class: "vg-btn" },
        VG.icon("reset", null, 16),
        "Clear filters",
      );
      main.appendChild(
        h(
          "div",
          { class: "vg-toolbar vg-issues-bar" },
          h("label", { for: qId, class: "vg-sr" }, "Filter"),
          q,
          sortSel,
          dirBtn,
        ),
      );
      const facetEls = new Map();
      const facetsBox = h("div", { class: "vg-facets" });
      for (const f of facets) {
        const chips = VG.ui.chips(
          f.values.map((v) => ({ value: v, label: f.name(v), color: f.color ? f.color(v) : null, count: 0 })),
          {
            label: `Filter by ${f.label.toLowerCase()}`,
            selected: [...sel[f.key]],
            onChange: (set) => {
              sel[f.key] = new Set(set);
              apply(true);
            },
          },
        );
        facetEls.set(f.key, chips);
        facetsBox.appendChild(
          h("div", { class: "vg-facet" }, h("span", { class: "vg-facet-label" }, f.label), chips.el),
        );
      }
      main.appendChild(facetsBox);
      const ctxBox = h("div", {});
      main.appendChild(ctxBox);
      const count = h("p", { class: "vg-muted vg-issues-count", "aria-live": "polite" });
      main.appendChild(
        h("div", { class: "vg-toolbar" }, count, h("span", { class: "vg-spacer" }), copyBtn, dlBtn, clearBtn),
      );

      /* ---------- table */
      const COLS = [
        { key: "id", label: "Id", cls: "vg-col-id" },
        { key: "severity", label: "Severity", cls: "vg-col-sev" },
        { key: "title", label: "Title", cls: "vg-col-title" },
        { key: "app", label: "App", cls: "vg-col-app" },
        { key: "kind", label: "Kind", cls: "vg-col-kind" },
        { key: "status", label: "Status", cls: "vg-col-status" },
      ];
      const headRow = h("tr", {});
      const thOf = new Map();
      for (const c of COLS) {
        const th = h(
          "th",
          { scope: "col", class: c.cls },
          h(
            "button",
            {
              type: "button",
              class: "vg-sort",
              onclick: () => {
                if (sortKey === c.key) desc = !desc;
                else {
                  sortKey = c.key;
                  desc = false;
                }
                sortSel.value = sortKey;
                apply(true);
              },
            },
            c.label,
            h("span", { class: "vg-sort-mark", "aria-hidden": "true" }),
          ),
        );
        thOf.set(c.key, th);
        headRow.appendChild(th);
      }
      const tbody = h("tbody", {});
      const table = h(
        "table",
        { class: "vg-table vg-issues" },
        h("caption", { class: "vg-sr" }, "Known issues; the Id buttons expand a row"),
        h(
          "colgroup",
          {},
          COLS.map((c) => h("col", { class: c.cls })),
        ),
        h("thead", {}, headRow),
        tbody,
      );
      main.appendChild(h("div", { class: "vg-table-wrap vg-issues-wrap" }, table));
      const empty = h("p", { class: "vg-muted", hidden: true }, "No issue matches these filters.");
      main.appendChild(empty);

      /* ---------- filtering and sorting */
      const textOf = new Map(
        all.map((x) => [
          x.id,
          [
            x.id,
            x.title,
            x.summary,
            x.fix,
            x.expected,
            x.actual,
            ...(x.reproduce || []),
            ...(x.where || []),
            ...(x.files || []),
            ...(x.newFiles || []),
            ...(x.terms || []),
            x.journey,
            appLabel(x.app),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
        ]),
      );
      const matchesText = (x) => {
        const parts = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const t = textOf.get(x.id);
        return parts.every((part) => t.includes(part));
      };
      const matchesCtx = (x) =>
        (!ctx.journey || x.journey === ctx.journey) && (!ctx.step || x.step === ctx.step);
      const matchesFacets = (x, except) =>
        facets.every((f) => f.key === except || !sel[f.key].size || sel[f.key].has(f.of(x)));
      const cmpBy = {
        id: (a, b) => issueNum(a.id) - issueNum(b.id),
        severity: (a, b) => rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity),
        app: (a, b) => rank(appIds, D.resolveApp(a.app)) - rank(appIds, D.resolveApp(b.app)),
        kind: (a, b) => rank(KINDS, a.kind) - rank(KINDS, b.kind),
        status: (a, b) => rank(STATUSES, a.status) - rank(STATUSES, b.status),
        title: (a, b) => String(a.title).localeCompare(String(b.title), "en", { sensitivity: "base" }),
      };
      const sorted = (list) =>
        list.slice().sort((a, b) => (desc ? -1 : 1) * (cmpBy[sortKey](a, b) || cmpBy.id(a, b)));

      function filterText() {
        const parts = [];
        for (const f of facets) {
          if (sel[f.key].size)
            parts.push(`${f.label.toLowerCase()} ${[...sel[f.key]].map(f.name).join(", ")}`);
        }
        if (ctx.journey) parts.push(`journey ${ctx.journey}${ctx.step ? " / " + ctx.step : ""}`);
        if (q.value.trim()) parts.push(`text “${q.value.trim()}”`);
        return parts.join("; ");
      }
      function filtersObject() {
        const out = {};
        for (const f of facets) if (sel[f.key].size) out[f.key] = [...sel[f.key]];
        if (ctx.journey) out.journey = ctx.journey;
        if (ctx.step) out.step = ctx.step;
        if (q.value.trim()) out.q = q.value.trim();
        return out;
      }
      function syncUrl() {
        const params = filtersObject();
        if (sortKey !== "id" || desc) params.sort = `${desc ? "-" : ""}${sortKey}`;
        if (open.size) params.open = [...open];
        history.replaceState(null, "", VG.routes.issues(params));
      }

      let shown = [];
      function row(x) {
        const detailId = `issue-detail-${x.id}`;
        const isOpen = open.has(x.id);
        const toggle = h(
          "button",
          {
            type: "button",
            class: "vg-issue-toggle",
            "aria-expanded": isOpen ? "true" : "false",
            "aria-controls": detailId,
            "aria-label": `${x.id}: ${isOpen ? "hide" : "show"} the details`,
          },
          VG.icon("chevron", null, 14),
          h("code", {}, x.id),
        );
        const tr = h(
          "tr",
          { class: `vg-issue-row${isOpen ? " is-open" : ""}`, dataset: { id: x.id } },
          h("td", { class: "vg-col-id" }, toggle),
          h("td", { class: "vg-col-sev" }, severityBadge(x.severity)),
          h(
            "td",
            { class: "vg-col-title" },
            h("span", { class: "vg-issue-title" }, x.title),
            // shown under the title when the narrow layout hides the App, Kind and Status columns
            h(
              "span",
              { class: "vg-issue-sub" },
              h("span", { class: "vg-sub-app" }, appLabel(x.app)),
              h("span", { class: "vg-sub-kind" }, KIND_LABEL[x.kind] || x.kind),
              h("span", { class: "vg-sub-status" }, STATUS_LABEL[x.status] || x.status),
            ),
          ),
          h("td", { class: "vg-col-app" }, appLabel(x.app)),
          h("td", { class: "vg-col-kind" }, KIND_LABEL[x.kind] || x.kind),
          h("td", { class: "vg-col-status" }, statusBadge(x.status)),
        );
        const cell = h("td", { colspan: String(COLS.length) });
        const detail = h("tr", { class: "vg-issue-detail", id: detailId, hidden: !isOpen }, cell);
        const fill = () => {
          if (!cell.firstChild) cell.appendChild(issueBody(x, { level: 3 }));
        };
        if (isOpen) fill();
        const setOpen = (on) => {
          if (on) {
            open.add(x.id);
            fill();
          } else open.delete(x.id);
          detail.hidden = !on;
          tr.classList.toggle("is-open", on);
          toggle.setAttribute("aria-expanded", on ? "true" : "false");
          toggle.setAttribute("aria-label", `${x.id}: ${on ? "hide" : "show"} the details`);
          syncUrl();
        };
        toggle.addEventListener("click", () => setOpen(!open.has(x.id)));
        tr.addEventListener("click", (e) => {
          if (e.target.closest("a, button, input, select, textarea")) return;
          if (window.getSelection && String(window.getSelection())) return;
          setOpen(!open.has(x.id));
        });
        return [tr, detail];
      }

      function apply(push) {
        shown = sorted(all.filter((x) => matchesCtx(x) && matchesText(x) && matchesFacets(x)));
        // chip counts: the issues each value would show with the other groups' filters and the text
        for (const f of facets) {
          const base = all.filter((x) => matchesCtx(x) && matchesText(x) && matchesFacets(x, f.key));
          const chips = facetEls.get(f.key);
          for (const b of chips.el.querySelectorAll("button")) {
            const n = base.filter((x) => f.of(x) === b.dataset.value).length;
            const c = b.querySelector(".vg-chip-count");
            if (c) c.textContent = String(n);
            b.classList.toggle("is-zero", n === 0);
          }
          chips.selected.clear();
          sel[f.key].forEach((v) => chips.selected.add(v));
          chips.render();
        }
        VG.clear(tbody);
        for (const x of shown) for (const el of row(x)) tbody.appendChild(el);
        empty.hidden = shown.length > 0;
        const bySev = SEVERITIES.map((s) => [s, shown.filter((x) => x.severity === s).length]).filter(
          ([, n]) => n,
        );
        count.textContent =
          `${shown.length === all.length ? all.length : `${shown.length} of ${all.length}`} ${shown.length === 1 && all.length === 1 ? "issue" : "issues"}` +
          (bySev.length ? `: ${bySev.map(([s, n]) => `${n} ${s}`).join(", ")}` : "");
        for (const c of COLS) {
          const th = thOf.get(c.key);
          if (c.key === sortKey) th.setAttribute("aria-sort", desc ? "descending" : "ascending");
          else th.removeAttribute("aria-sort");
          th.querySelector(".vg-sort-mark").textContent = c.key === sortKey ? (desc ? "▼" : "▲") : "";
        }
        VG.clear(dirBtn).append(
          VG.icon(desc ? "minus" : "plus", null, 14),
          desc ? "Descending" : "Ascending",
        );
        copyBtn.disabled = !shown.length;
        dlBtn.disabled = !shown.length;
        VG.clear(ctxBox);
        if (ctx.journey) {
          const j = D.journeys.get(ctx.journey);
          const st = ctx.step ? (j.steps || []).find((s) => s.id === ctx.step) : null;
          ctxBox.appendChild(
            h(
              "p",
              { class: "vg-issues-ctx" },
              VG.icon("journey", null, 15),
              " Only issues seen in ",
              h("a", { href: VG.routes.journey(j.id) }, j.title),
              st ? ` › ${st.title}` : "",
              " ",
              h(
                "button",
                {
                  type: "button",
                  class: "vg-btn",
                  onclick: () => {
                    ctx.journey = ctx.step = "";
                    apply(true);
                  },
                },
                VG.icon("close", null, 14),
                "Show all journeys",
              ),
            ),
          );
        }
        if (push) syncUrl();
      }

      q.addEventListener(
        "input",
        VG.debounce(() => apply(true), 120),
      );
      sortSel.addEventListener("change", () => {
        sortKey = sortSel.value;
        desc = false;
        apply(true);
      });
      dirBtn.addEventListener("click", () => {
        desc = !desc;
        apply(true);
      });
      clearBtn.addEventListener("click", () => {
        for (const f of facets) sel[f.key].clear();
        ctx.journey = ctx.step = "";
        q.value = "";
        apply(true);
      });
      copyBtn.addEventListener("click", () =>
        VG.copy(listMarkdown(shown, filterText()), `${VG.plural(shown.length, "issue")} as Markdown`),
      );
      dlBtn.addEventListener("click", () => {
        download("velexis-known-issues.json", jsonExport(shown, filtersObject()));
        VG.ui.toast(`Downloaded ${VG.plural(shown.length, "issue")} as JSON`);
      });
      apply(false);
      const first = [...open][0];
      if (first) {
        setTimeout(() => {
          const el = document.querySelector(`tr[data-id="${first}"]`);
          if (el) el.scrollIntoView({ block: "start" });
        }, 0);
      }
      return {};
    },
  });

  /* ---------------------------------------------------------------- one issue */

  VG.views.register("issue", {
    wide: true,
    title(route) {
      const x = VG.data.issues.get(route.path[1]);
      return x ? `${x.id} ${x.title}` : "Issue not found";
    },
    render(main, route) {
      const D = VG.data;
      const x = D.issues.get(route.path[1]);
      if (!x) {
        VG.layout.setCrumbs([{ label: "Known issues", href: "#/issues" }, { label: "Not found" }]);
        main.appendChild(
          VG.ui.empty(
            "Issue not found",
            `There is no issue “${route.path[1] || ""}”. It may have been fixed and removed: see the list of known issues.`,
          ),
        );
        main.appendChild(h("p", {}, h("a", { class: "vg-btn", href: "#/issues" }, "All known issues")));
        return {};
      }
      VG.layout.setCrumbs([{ label: "Known issues", href: "#/issues" }, { label: x.id }]);
      const list = D.issueList();
      const i = list.findIndex((y) => y.id === x.id);
      const prev = list[i - 1];
      const next = list[i + 1];
      main.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h("p", { class: "vg-issue-id" }, h("code", {}, x.id)),
          h("h1", {}, x.title),
        ),
      );
      main.appendChild(h("article", { class: "vg-issue-page" }, issueBody(x, { level: 2, page: true })));
      main.appendChild(
        h(
          "nav",
          { class: "vg-issue-nav", "aria-label": "Other issues" },
          prev
            ? h("a", { class: "vg-btn", href: VG.routes.issue(prev.id), rel: "prev" }, `‹ ${prev.id}`)
            : h("span", {}),
          h(
            "a",
            { class: "vg-btn", href: VG.routes.issues({ app: D.resolveApp(x.app) }) },
            `All issues of ${appLabel(x.app)}`,
          ),
          h("a", { class: "vg-btn", href: "#/issues" }, "All known issues"),
          next
            ? h("a", { class: "vg-btn", href: VG.routes.issue(next.id), rel: "next" }, `${next.id} ›`)
            : h("span", {}),
        ),
      );
      return {};
    },
  });
})();
