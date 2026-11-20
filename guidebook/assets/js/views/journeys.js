/* Velexis Guidebook views: journeys index (#/journeys?app=) and one journey as a checklist (#/journey/<id>). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;
  const STATUSES = [
    { id: "pass", label: "Pass", icon: "check" },
    { id: "bug", label: "Bug", icon: "bug" },
    { id: "skip", label: "Skip", icon: "skip" },
  ];

  /* ---------------------------------------------------------------- state (localStorage, optional) */

  function load(id) {
    const s = VG.store.get(`journey.${id}`, null);
    return { status: (s && s.status) || {}, notes: (s && s.notes) || {} };
  }
  function save(id, state) {
    VG.store.set(`journey.${id}`, state);
  }
  function counts(j, state) {
    const c = { pass: 0, bug: 0, skip: 0, total: (j.steps || []).length };
    for (const s of j.steps || []) if (state.status[s.id]) c[state.status[s.id]]++;
    return c;
  }
  function progressBar(c) {
    const pct = (n) => (c.total ? (100 * n) / c.total : 0);
    return h(
      "div",
      {
        class: "vg-progress",
        role: "img",
        "aria-label": `${c.pass} passed, ${c.bug} bugs, ${c.skip} skipped of ${c.total} steps`,
      },
      h("span", { class: "is-pass", style: { width: pct(c.pass) + "%" } }),
      h("span", { class: "is-bug", style: { width: pct(c.bug) + "%" } }),
      h("span", { class: "is-skip", style: { width: pct(c.skip) + "%" } }),
    );
  }

  /* ---------------------------------------------------------------- bug report */

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function stepReport(j, step, index, state) {
    const D = VG.data;
    const note = (state.notes[step.id] || "").trim();
    const lines = [
      `## Bug: ${j.title} — step ${index + 1}: ${step.title}`,
      "",
      `- **Journey:** ${j.title} (\`${j.id}\`), step ${index + 1} of ${(j.steps || []).length} (\`${step.id}\`)`,
      `- **App:** ${D.appName(step.app)} (\`${D.resolveApp(step.app)}\`)`,
      `- **URL:** ${step.url || "n/a"}`,
      `- **Guide:** ${location.href.split("#")[0]}${VG.routes.journey(j.id)}`,
      `- **Date:** ${today()}`,
    ];
    if ((step.code || []).length) lines.push(`- **Code:** ${step.code.map((c) => "`" + c + "`").join(", ")}`);
    lines.push(
      "",
      "### Steps to reproduce",
      "",
      String(step.actions || "").trim(),
      "",
      "### Expected",
      "",
      String(step.expect || "").trim(),
      "",
    );
    lines.push("### Actual", "", note, "");
    if (step.data) lines.push("### Data to check", "", String(step.data).trim(), "");
    return lines.join("\n");
  }
  function journeyReport(j, state) {
    const steps = j.steps || [];
    const bugs = steps.map((s, i) => [s, i]).filter(([s]) => state.status[s.id] === "bug");
    if (bugs.length) return bugs.map(([s, i]) => stepReport(j, s, i, state)).join("\n---\n\n");
    const firstOpen = steps.findIndex((s) => !state.status[s.id]);
    const i = firstOpen < 0 ? 0 : firstOpen;
    return steps[i] ? stepReport(j, steps[i], i, state) : `## Bug: ${j.title}\n\n### Actual\n\n`;
  }
  VG.journeyReport = { stepReport, journeyReport };

  /** Small badge on a step that has known issues: one opens it, several open the filtered list. */
  function issueBadge(j, s) {
    const list = VG.data.issuesOf({ journey: j.id, step: s.id });
    if (!list.length) return null;
    const href =
      list.length === 1 ? VG.routes.issue(list[0].id) : VG.routes.issues({ journey: j.id, step: s.id });
    return h(
      "a",
      {
        class: "vg-badge vg-issue-badge",
        href,
        title: list.map((x) => `${x.id} ${x.title}`).join("\n"),
        "aria-label": `${VG.plural(list.length, "known issue")} on this step: ${list.map((x) => x.id).join(", ")}`,
      },
      VG.icon("bug", null, 12),
      VG.plural(list.length, "known issue"),
    );
  }

  /* ---------------------------------------------------------------- index */

  VG.views.register("journeys", {
    title: () => "Journeys",
    render(main, route) {
      const D = VG.data;
      const list = D.journeyList();
      VG.layout.setCrumbs([{ label: "Journeys" }]);
      main.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h("h1", {}, "Journeys"),
          h(
            "p",
            { class: "vg-lede" },
            "End-to-end walkthroughs across apps. Open one, follow the steps, mark each Pass, Bug or Skip, and copy a ready-made bug report. Progress is kept in this browser.",
          ),
        ),
      );
      if (!list.length) {
        main.appendChild(
          VG.ui.empty("No journeys yet", "Add JSON files under content/journeys/ and rebuild."),
        );
        return {};
      }
      const appCounts = new Map();
      for (const j of list)
        for (const a of new Set((j.apps || []).map((x) => D.resolveApp(x))))
          appCounts.set(a, (appCounts.get(a) || 0) + 1);
      const initial = route.params.get("app");
      const textId = VG.uid("jf");
      const text = h("input", {
        type: "search",
        id: textId,
        class: "vg-input",
        placeholder: "Filter journeys…",
        "aria-label": "Filter journeys",
      });
      const chips = VG.ui.chips(
        [...appCounts].map(([a, n]) => ({
          value: a,
          label: D.appName(a),
          count: n,
          color: `var(--p-${(D.app(a) || {}).product || "shared"})`,
        })),
        { label: "Filter by app", selected: initial ? [D.resolveApp(initial)] : [], onChange: apply },
      );
      main.appendChild(h("div", { class: "vg-toolbar" }, text, chips.el));
      const count = h("p", { class: "vg-muted", "aria-live": "polite" });
      main.appendChild(count);
      const cards = h("div", { class: "vg-cards" });
      main.appendChild(cards);
      const items = list.map((j) => {
        const st = load(j.id);
        const c = counts(j, st);
        const summary = h("span", { class: "vg-card-text" });
        VG.md.inlineInto(summary, j.summary || "");
        const card = h(
          "a",
          { class: "vg-card", href: VG.routes.journey(j.id) },
          h("span", { class: "vg-card-title" }, VG.icon("journey"), j.title),
          summary,
          h("div", { class: "vg-jcard-progress" }, progressBar(c)),
          h(
            "div",
            { class: "vg-card-foot" },
            h("span", {}, `${c.total} steps`),
            j.duration ? h("span", {}, `· ${j.duration}`) : null,
            c.pass + c.bug + c.skip
              ? h("span", {}, `· ${c.pass + c.bug + c.skip} checked${c.bug ? `, ${c.bug} bugs` : ""}`)
              : null,
          ),
          h(
            "div",
            { class: "vg-card-foot" },
            (j.apps || []).map((a) => h("span", { class: "vg-badge" }, D.appName(a))),
          ),
        );
        cards.appendChild(card);
        return {
          j,
          card,
          text: `${j.title} ${j.summary || ""} ${(j.steps || []).map((s) => s.title).join(" ")}`.toLowerCase(),
        };
      });
      function apply() {
        const q = text.value.trim().toLowerCase();
        let n = 0;
        for (const it of items) {
          const appsOk =
            !chips.selected.size || (it.j.apps || []).some((a) => chips.selected.has(D.resolveApp(a)));
          const show = appsOk && (!q || it.text.includes(q));
          it.card.hidden = !show;
          if (show) n++;
        }
        count.textContent = `${n} of ${items.length} journeys`;
      }
      text.addEventListener("input", apply);
      apply();
      return {};
    },
  });

  /* ---------------------------------------------------------------- one journey */

  VG.views.register("journey", {
    title(route) {
      const j = VG.data.journeys.get(route.path[1]);
      return j ? j.title : "Journey not found";
    },
    render(main, route) {
      const D = VG.data;
      const j = D.journeys.get(route.path[1]);
      if (!j) {
        VG.layout.setCrumbs([{ label: "Journeys", href: "#/journeys" }, { label: "Not found" }]);
        main.appendChild(VG.ui.empty("Journey not found", `There is no journey “${route.path[1] || ""}”.`));
        return {};
      }
      VG.layout.setCrumbs([{ label: "Journeys", href: "#/journeys" }, { label: j.title }]);
      const state = load(j.id);
      const journeyIssues = D.issuesOf({ journey: j.id });
      const steps = j.steps || [];
      const summary = h("p", { class: "vg-lede" });
      VG.md.inlineInto(summary, j.summary || "");
      main.appendChild(
        h(
          "header",
          { class: "vg-header" },
          h("h1", {}, j.title),
          summary,
          h(
            "div",
            { class: "vg-meta" },
            j.duration ? h("span", {}, `About ${j.duration}`) : null,
            (j.roles || []).length ? h("span", {}, `· Roles: ${j.roles.join(", ")}`) : null,
            h("span", {}, "· Apps:"),
            (j.apps || []).map((a) =>
              D.app(a)
                ? h("a", { class: "vg-badge", href: VG.routes.app(a) }, D.appName(a))
                : h("span", { class: "vg-badge" }, a),
            ),
            journeyIssues.length
              ? h(
                  "a",
                  { class: "vg-issues-link", href: VG.routes.issues({ journey: j.id }) },
                  VG.icon("bug", null, 15),
                  `Known issues (${journeyIssues.length})`,
                )
              : null,
          ),
        ),
      );
      if ((j.prerequisites || []).length) {
        main.appendChild(h("h2", {}, "Before you start"));
        const ul = h("ul", {});
        for (const p of j.prerequisites) {
          const li = h("li", {});
          VG.md.inlineInto(li, p);
          ul.appendChild(li);
        }
        main.appendChild(ul);
      }

      // progress + actions
      const barHost = h("div", {});
      const legend = h("div", { class: "vg-progress-legend", "aria-live": "polite" });
      const resetBtn = h("button", { type: "button", class: "vg-btn" }, VG.icon("reset", null, 16), "Reset");
      let resetArmed = 0;
      resetBtn.addEventListener("click", () => {
        if (!resetArmed) {
          resetBtn.lastChild.textContent = "Click again to reset";
          resetArmed = setTimeout(() => {
            resetArmed = 0;
            resetBtn.lastChild.textContent = "Reset";
          }, 3000);
          return;
        }
        clearTimeout(resetArmed);
        resetArmed = 0;
        resetBtn.lastChild.textContent = "Reset";
        state.status = {};
        state.notes = {};
        save(j.id, state);
        for (const s of steps) setStep(s.id);
        for (const ta of main.querySelectorAll(".vg-note-ta")) ta.value = "";
        refresh();
        VG.ui.toast("Journey reset");
      });
      main.appendChild(
        h(
          "section",
          { class: "vg-box", "aria-label": "Progress" },
          barHost,
          legend,
          h(
            "div",
            { class: "vg-toolbar" },
            h(
              "button",
              {
                type: "button",
                class: "vg-btn is-primary",
                id: "vg-copy-report",
                onclick: () => VG.copy(journeyReport(j, state), "Bug report"),
              },
              VG.icon("copy", null, 16),
              "Copy bug report",
            ),
            resetBtn,
            h(
              "button",
              { type: "button", class: "vg-btn", onclick: () => window.print() },
              "Print checklist",
            ),
          ),
        ),
      );
      function refresh() {
        const c = counts(j, state);
        VG.clear(barHost).appendChild(progressBar(c));
        legend.textContent = `${c.pass} passed · ${c.bug} bugs · ${c.skip} skipped · ${c.total - c.pass - c.bug - c.skip} to do`;
      }

      const ol = h("ol", { class: "vg-jsteps" });
      const stepEls = new Map();
      function setStep(id) {
        const li = stepEls.get(id);
        if (!li) return;
        const st = state.status[id] || "";
        li.classList.remove("is-pass", "is-bug", "is-skip");
        if (st) li.classList.add(`is-${st}`);
        for (const b of li.querySelectorAll(".vg-status button"))
          b.setAttribute("aria-pressed", b.dataset.status === st ? "true" : "false");
      }
      steps.forEach((s, i) => {
        const statusGroup = h(
          "div",
          { class: "vg-status", role: "group", "aria-label": `Result of step ${i + 1}` },
          STATUSES.map((st) =>
            h(
              "button",
              {
                type: "button",
                class: `is-${st.id}`,
                dataset: { status: st.id },
                "aria-pressed": "false",
                onclick: () => {
                  state.status[s.id] = state.status[s.id] === st.id ? undefined : st.id;
                  if (!state.status[s.id]) delete state.status[s.id];
                  save(j.id, state);
                  setStep(s.id);
                  refresh();
                },
              },
              VG.icon(st.icon, null, 14),
              st.label,
            ),
          ),
        );
        const note = h("textarea", {
          class: "vg-note-ta",
          rows: 2,
          placeholder: "Notes (saved in this browser; used as “Actual” in the bug report)",
          "aria-label": `Notes for step ${i + 1}`,
        });
        note.value = state.notes[s.id] || "";
        note.addEventListener(
          "input",
          VG.debounce(() => {
            if (note.value.trim()) state.notes[s.id] = note.value;
            else delete state.notes[s.id];
            save(j.id, state);
          }, 300),
        );
        const li = h(
          "li",
          { class: "vg-jstep", id: `step-${s.id}` },
          h(
            "div",
            { class: "vg-jstep-head" },
            h("h3", {}, s.title),
            D.app(s.app)
              ? h("a", { class: "vg-badge", href: VG.routes.app(s.app) }, D.appName(s.app))
              : h("span", { class: "vg-badge" }, s.app || ""),
            issueBadge(j, s),
            statusGroup,
          ),
          s.url
            ? h(
                "div",
                { class: "vg-meta" },
                /^https?:\/\//.test(s.url)
                  ? h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.url)
                  : h("code", {}, s.url),
                VG.ui.copyButton(s.url, "URL"),
              )
            : null,
          h("p", { class: "vg-jstep-label" }, "Do"),
          VG.md.block(s.actions || "", { app: s.app }),
          h(
            "div",
            { class: "vg-expect" },
            h("span", { class: "vg-expect-label" }, "Expect"),
            VG.md.block(s.expect || "", { app: s.app }),
          ),
          s.data ? h("p", { class: "vg-jstep-label" }, "Check the data") : null,
          s.data ? VG.md.block(s.data, { app: s.app }) : null,
          (s.code || []).length ? h("p", { class: "vg-jstep-label" }, "Code") : null,
          (s.code || []).length
            ? h(
                "div",
                { class: "vg-tag-list" },
                s.code.map((c) => VG.ui.repoLink(c)),
              )
            : null,
          note,
          h(
            "div",
            { class: "vg-toolbar" },
            h(
              "button",
              {
                type: "button",
                class: "vg-btn",
                onclick: () => VG.copy(stepReport(j, s, i, state), "Bug report"),
              },
              VG.icon("bug", null, 16),
              "Copy bug report for this step",
            ),
          ),
        );
        stepEls.set(s.id, li);
        ol.appendChild(li);
      });
      main.appendChild(h("h2", {}, `Steps (${steps.length})`));
      main.appendChild(ol);
      for (const s of steps) setStep(s.id);
      refresh();
      // #/journey/<id>?step=<step id> (from a known issue): scroll to the step once the router has scrolled to the top
      const target = stepEls.get(route.params.get("step") || "");
      if (target) {
        setTimeout(() => {
          target.scrollIntoView({ block: "start", behavior: "auto" });
          target.classList.remove("vg-flash");
          void target.offsetWidth;
          target.classList.add("vg-flash");
        }, 0);
      }
      return {};
    },
  });
})();
