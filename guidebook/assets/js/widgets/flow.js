/* Velexis Guidebook widget: flow (an interactive stepper: dots, next / previous, keyboard, body and expected result). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;

  VG.widgets.register("flow", {
    needsD3: false,
    render(container, diagram) {
      const steps = diagram.steps || [];
      let cur = 0;
      const dots = h("div", {
        class: "vg-flow-dots",
        role: "tablist",
        "aria-label": `${diagram.title} steps`,
      });
      const body = h("div", {
        class: "vg-flow-step",
        role: "tabpanel",
        tabindex: "0",
        "aria-live": "polite",
      });
      const prev = h("button", { type: "button", class: "vg-btn" }, VG.icon("prev", null, 16), "Previous");
      const next = h(
        "button",
        { type: "button", class: "vg-btn is-primary" },
        "Next",
        VG.icon("next", null, 16),
      );
      const pos = h("span", { class: "vg-muted" });
      const wrap = h(
        "div",
        { class: "vg-flow" },
        dots,
        body,
        h("div", { class: "vg-flow-nav" }, prev, pos, next),
      );
      container.appendChild(wrap);
      const dotEls = steps.map((s, i) => {
        const b = h(
          "button",
          {
            type: "button",
            class: "vg-flow-dot",
            role: "tab",
            "aria-label": `Step ${i + 1}: ${s.title}`,
            title: s.title,
            onclick: () => go(i),
          },
          String(i + 1),
        );
        if (i > 0) dots.appendChild(h("span", { class: "vg-flow-bar", "aria-hidden": "true" }));
        dots.appendChild(b);
        return b;
      });
      const bars = Array.from(dots.querySelectorAll(".vg-flow-bar"));
      function go(i) {
        if (!steps.length) return;
        cur = Math.max(0, Math.min(steps.length - 1, i));
        dotEls.forEach((b, k) => {
          b.classList.toggle("is-done", k < cur);
          b.setAttribute("aria-selected", k === cur ? "true" : "false");
          if (k === cur) b.setAttribute("aria-current", "step");
          else b.removeAttribute("aria-current");
          b.tabIndex = k === cur ? 0 : -1;
        });
        bars.forEach((b, k) => b.classList.toggle("is-done", k < cur));
        const s = steps[cur];
        VG.clear(body);
        body.appendChild(h("h4", {}, `${cur + 1}. ${s.title}`));
        const meta = h("div", { class: "vg-flow-meta" });
        if (s.actor) meta.appendChild(h("span", { class: "vg-badge" }, `Actor: ${s.actor}`));
        if (s.screen) meta.appendChild(h("span", { class: "vg-badge" }, `Screen: ${s.screen}`));
        if (s.url) {
          meta.appendChild(
            /^https?:\/\//.test(s.url)
              ? h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.url)
              : h("code", {}, s.url),
          );
          meta.appendChild(VG.ui.copyButton(s.url, "URL"));
        }
        if (meta.childNodes.length) body.appendChild(meta);
        if (s.body) body.appendChild(VG.md.block(s.body, { app: diagram.app }));
        if (s.expect)
          body.appendChild(
            h(
              "div",
              { class: "vg-expect" },
              h("span", { class: "vg-expect-label" }, "Expected"),
              VG.md.block(s.expect, { app: diagram.app }),
            ),
          );
        prev.disabled = cur === 0;
        next.disabled = cur === steps.length - 1;
        pos.textContent = `Step ${cur + 1} of ${steps.length}`;
      }
      prev.addEventListener("click", () => go(cur - 1));
      next.addEventListener("click", () => go(cur + 1));
      wrap.addEventListener("keydown", (e) => {
        if (e.target.closest && e.target.closest("input, textarea, select, a")) return;
        if (e.key === "ArrowRight") go(cur + 1);
        else if (e.key === "ArrowLeft") go(cur - 1);
        else if (e.key === "Home") go(0);
        else if (e.key === "End") go(steps.length - 1);
        else return;
        e.preventDefault();
        if (dotEls[cur] && e.target.classList.contains("vg-flow-dot")) dotEls[cur].focus();
      });
      if (!steps.length) body.appendChild(h("p", { class: "vg-muted" }, "This flow has no steps."));
      go(0);
      return { go, resize() {} };
    },
  });
})();
