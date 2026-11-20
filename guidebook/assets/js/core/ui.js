/* Velexis Guidebook: shared UI pieces (banners, toasts, popovers, hover cards, chips, filterable tables, fullscreen). */
(function () {
  "use strict";
  const VG = window.VG;
  const h = VG.h;
  const ui = (VG.ui = {});

  /* ---------------------------------------------------------------- banners and toasts */

  ui.banner = function banner(kind, message, opts) {
    const host = document.getElementById("vg-banners");
    if (!host) return null;
    const id = (opts && opts.id) || null;
    if (id && host.querySelector(`[data-banner="${id}"]`)) return null;
    const el = h(
      "div",
      {
        class: `vg-banner vg-banner-${kind}`,
        role: kind === "error" ? "alert" : "status",
        dataset: { banner: id || "" },
      },
      h("span", { class: "vg-banner-text" }, message),
      h(
        "button",
        { class: "vg-iconbtn", type: "button", "aria-label": "Dismiss message", onclick: () => el.remove() },
        VG.icon("close"),
      ),
    );
    host.appendChild(el);
    return el;
  };

  let toastTimer = 0;
  ui.toast = function toast(message) {
    let el = document.getElementById("vg-toast");
    if (!el) {
      el = h("div", { id: "vg-toast", class: "vg-toast", role: "status", "aria-live": "polite" });
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-on"), 1800);
  };

  /** Shown when the clipboard cannot be written (some file:// setups): the text, selected, to copy by hand. */
  ui.copyFallback = function copyFallback(text) {
    const ta = h("textarea", { class: "vg-copy-ta", rows: 10, "aria-label": "Text to copy" });
    ta.value = text;
    ui.modal(
      "Copy this text",
      h("div", {}, h("p", {}, "Your browser blocked the clipboard. Press Ctrl+C (Cmd+C)."), ta),
    );
    setTimeout(() => ta.select(), 0);
  };

  ui.modal = function modal(title, body) {
    const prev = document.activeElement;
    const close = () => {
      wrap.remove();
      if (prev && prev.focus) prev.focus();
    };
    const id = VG.uid("modal");
    const box = h(
      "div",
      { class: "vg-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": id },
      h(
        "div",
        { class: "vg-modal-head" },
        h("h2", { id }, title),
        h(
          "button",
          { class: "vg-iconbtn", type: "button", "aria-label": "Close", onclick: close },
          VG.icon("close"),
        ),
      ),
      body,
    );
    const wrap = h("div", { class: "vg-modal-wrap", onclick: (e) => e.target === wrap && close() }, box);
    wrap.addEventListener("keydown", (e) => e.key === "Escape" && close());
    document.body.appendChild(wrap);
    const first = box.querySelector("textarea, input, button");
    if (first) first.focus();
    return { close, el: box };
  };

  /* ---------------------------------------------------------------- popover (click detail) */

  let pop = null;
  let popAnchor = null;
  ui.closePopover = function closePopover(restoreFocus) {
    if (!pop) return;
    pop.remove();
    pop = null;
    if (restoreFocus && popAnchor && popAnchor.focus && document.contains(popAnchor)) popAnchor.focus();
    popAnchor = null;
  };
  /**
   * Shows a small panel near `anchor` (an element, a DOM rect or {x, y} in viewport coordinates).
   * `body` is a node; `title` a string; `kind` adds a coloured marker.
   */
  ui.popover = function popover(anchor, title, body, opts) {
    ui.closePopover(false);
    const o = opts || {};
    const id = VG.uid("pop");
    pop = h(
      "div",
      { class: "vg-popover", role: "dialog", "aria-labelledby": id, tabindex: "-1" },
      h(
        "div",
        { class: "vg-popover-head" },
        o.kind
          ? h("span", { class: "vg-kind-dot", style: { background: o.color || VG.kindVar(o.kind) } })
          : null,
        h("strong", { id }, title),
        o.badge ? h("span", { class: "vg-badge" }, o.badge) : null,
        h(
          "button",
          {
            class: "vg-iconbtn vg-popover-close",
            type: "button",
            "aria-label": "Close",
            onclick: () => ui.closePopover(true),
          },
          VG.icon("close", null, 16),
        ),
      ),
      h("div", { class: "vg-popover-body" }, body),
    );
    const host =
      (o.container && o.container.isConnected && o.container) || document.fullscreenElement || document.body;
    host.appendChild(pop);
    popAnchor = anchor && anchor.nodeType === 1 ? anchor : o.returnFocus || null;
    const r =
      anchor && anchor.getBoundingClientRect
        ? anchor.getBoundingClientRect()
        : anchor && anchor.width !== null && anchor.width !== undefined
          ? anchor
          : {
              left: (anchor && anchor.x) || 0,
              top: (anchor && anchor.y) || 0,
              width: 0,
              height: 0,
              bottom: (anchor && anchor.y) || 0,
              right: (anchor && anchor.x) || 0,
            };
    const pw = Math.min(360, window.innerWidth - 24);
    pop.style.width = pw + "px";
    let left = r.left + (r.width || 0) / 2 - pw / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
    pop.style.left = left + "px";
    const ph = pop.offsetHeight;
    let top = (r.bottom ?? r.top) + 8;
    if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 8);
    pop.style.top = top + "px";
    if (o.focus !== false) pop.focus({ preventScroll: true });
    return pop;
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pop) ui.closePopover(true);
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (pop && !pop.contains(e.target) && !(e.target.closest && e.target.closest("[data-pop-keep]")))
        ui.closePopover(false);
    },
    true,
  );

  /* ---------------------------------------------------------------- term hover cards */

  let card = null;
  let cardTimer = 0;
  let cardFor = null;
  function hideCard() {
    clearTimeout(cardTimer);
    if (card) card.classList.remove("is-on");
    cardFor = null;
  }
  function showCard(link) {
    const t = VG.data.terms.get(link.dataset.term);
    if (!t) return;
    if (!card) {
      card = h("div", { class: "vg-hovercard", role: "tooltip", id: "vg-hovercard" });
      card.addEventListener("mouseleave", hideCard);
      document.body.appendChild(card);
    }
    VG.clear(card);
    card.appendChild(
      h(
        "div",
        { class: "vg-hovercard-head" },
        h("span", { class: "vg-kind-dot", style: { background: VG.categoryVar(t.category) } }),
        h("strong", {}, t.term || t.id),
        h("span", { class: "vg-muted" }, t.category || ""),
      ),
    );
    const def = h("div", { class: "vg-hovercard-body" });
    VG.md.inlineInto(def, t.definition || "");
    card.appendChild(def);
    card.appendChild(h("div", { class: "vg-hovercard-foot" }, "Click to open in the glossary"));
    const r = link.getBoundingClientRect();
    card.style.left = "0px";
    card.style.top = "0px";
    card.classList.add("is-on");
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - cw - 8));
    let top = r.bottom + 6;
    if (top + ch > window.innerHeight - 8) top = r.top - ch - 6;
    card.style.left = left + "px";
    card.style.top = Math.max(8, top) + "px";
    link.setAttribute("aria-describedby", "vg-hovercard");
    cardFor = link;
  }
  ui.initHoverCards = function initHoverCards() {
    const isTerm = (el) => el && el.closest && el.closest("a.vg-term[data-term]");
    document.addEventListener("mouseover", (e) => {
      const link = isTerm(e.target);
      if (!link || link === cardFor) return;
      clearTimeout(cardTimer);
      cardTimer = setTimeout(() => showCard(link), 280);
    });
    document.addEventListener("mouseout", (e) => {
      const link = isTerm(e.target);
      if (!link) return;
      if (e.relatedTarget && card && card.contains(e.relatedTarget)) return;
      clearTimeout(cardTimer);
      cardTimer = setTimeout(hideCard, 120);
    });
    document.addEventListener("focusin", (e) => {
      const link = isTerm(e.target);
      if (link) showCard(link);
      else if (cardFor) hideCard();
    });
    document.addEventListener("keydown", (e) => e.key === "Escape" && hideCard());
    window.addEventListener("scroll", hideCard, { passive: true, capture: true });
    VG.on("route", hideCard);
  };

  /* ---------------------------------------------------------------- small widgets */

  ui.copyButton = function copyButton(text, label) {
    return h(
      "button",
      {
        class: "vg-copybtn",
        type: "button",
        "aria-label": `Copy ${label || "value"}`,
        title: "Copy",
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          VG.copy(typeof text === "function" ? text() : text, label);
        },
      },
      VG.icon("copy", null, 16),
    );
  };

  /** Toggle chips. items: [{ value, label, color?, count? }]. Returns { el, selected:Set }. */
  ui.chips = function chips(items, opts) {
    const o = opts || {};
    const selected = new Set(o.selected || []);
    const el = h("div", { class: "vg-chips", role: "group", "aria-label": o.label || "Filters" });
    const render = () => {
      for (const b of el.querySelectorAll("button")) {
        const on = selected.has(b.dataset.value);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
    };
    for (const it of items) {
      el.appendChild(
        h(
          "button",
          {
            type: "button",
            class: "vg-chip",
            dataset: { value: it.value },
            "aria-pressed": "false",
            onclick: () => {
              if (o.single) {
                const was = selected.has(it.value);
                selected.clear();
                if (!was) selected.add(it.value);
              } else if (selected.has(it.value)) selected.delete(it.value);
              else selected.add(it.value);
              render();
              if (o.onChange) o.onChange(selected);
            },
          },
          it.color ? h("span", { class: "vg-kind-dot", style: { background: it.color } }) : null,
          it.label,
          it.count !== null && it.count !== undefined
            ? h("span", { class: "vg-chip-count" }, String(it.count))
            : null,
        ),
      );
    }
    render();
    return { el, selected, render };
  };

  /** Segmented control (single choice). options: [{ value, label, icon? }]. */
  ui.segmented = function segmented(options, value, onChange, label) {
    const el = h("div", { class: "vg-seg", role: "radiogroup", "aria-label": label || "View" });
    const set = (v) => {
      for (const b of el.querySelectorAll("button")) {
        const on = b.dataset.value === v;
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      }
    };
    options.forEach((op) => {
      el.appendChild(
        h(
          "button",
          {
            type: "button",
            role: "radio",
            class: "vg-seg-btn",
            dataset: { value: op.value },
            onclick: () => {
              set(op.value);
              onChange(op.value);
            },
            onkeydown: (e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const i = options.findIndex((x) => x.value === op.value);
              const n = options[(i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length];
              set(n.value);
              onChange(n.value);
              el.querySelector(`[data-value="${n.value}"]`).focus();
            },
          },
          op.icon ? VG.icon(op.icon, null, 16) : null,
          op.label,
        ),
      );
    });
    set(value);
    return el;
  };

  /**
   * Filterable table. columns: [{ key, label, render?(row) -> node|string, text?(row) -> string, cls? }].
   * Returns { el, setFilter(text) }.
   */
  ui.filterTable = function filterTable(opts) {
    const o = opts || {};
    const id = VG.uid("ft");
    const input = h("input", {
      type: "search",
      class: "vg-input",
      id,
      placeholder: o.placeholder || "Filter…",
      "aria-label": o.filterLabel || `Filter ${o.caption || "rows"}`,
      autocomplete: "off",
    });
    const count = h("span", { class: "vg-muted vg-ft-count", "aria-live": "polite" });
    const tbody = h("tbody");
    const table = h(
      "table",
      { class: "vg-table" },
      o.caption ? h("caption", { class: "vg-sr" }, o.caption) : null,
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          o.columns.map((c) => h("th", { scope: "col", class: c.cls || null }, c.label)),
        ),
      ),
      tbody,
    );
    const rows = (o.rows || []).map((row) => {
      const tr = h(
        "tr",
        {},
        o.columns.map((c) => {
          const v = c.render ? c.render(row) : row[c.key];
          return h("td", { class: c.cls || null, "data-label": c.label }, v ?? "");
        }),
      );
      const text = o.columns
        .map((c) => (c.text ? c.text(row) : typeof row[c.key] === "string" ? row[c.key] : ""))
        .join(" ")
        .toLowerCase();
      tbody.appendChild(tr);
      return { tr, text, row };
    });
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      const parts = q.split(/\s+/).filter(Boolean);
      let n = 0;
      for (const r of rows) {
        const show = parts.every((p) => r.text.includes(p));
        r.tr.hidden = !show;
        if (show) n++;
      }
      count.textContent = `${n} of ${rows.length}`;
      empty.hidden = n > 0;
    };
    const empty = h(
      "p",
      { class: "vg-muted vg-ft-empty", hidden: true },
      o.emptyText || "Nothing matches the filter.",
    );
    input.addEventListener("input", apply);
    const el = h(
      "div",
      { class: "vg-ft" },
      h(
        "div",
        { class: "vg-ft-bar" },
        h("label", { for: id, class: "vg-sr" }, o.filterLabel || "Filter"),
        input,
        count,
      ),
      h("div", { class: "vg-table-wrap" }, table),
      empty,
    );
    if (o.initial) input.value = o.initial;
    apply();
    return {
      el,
      input,
      setFilter(text) {
        input.value = text || "";
        apply();
      },
      rows,
    };
  };

  ui.badge = (text, cls) => h("span", { class: `vg-badge ${cls || ""}` }, text);
  ui.empty = (title, text) =>
    h("div", { class: "vg-empty" }, h("h2", {}, title), text ? h("p", {}, text) : null);

  /** Link to a file in the repository (repoBase from site.json). */
  ui.repoLink = (path, label) =>
    h(
      "a",
      {
        class: "vg-repo",
        href: VG.data.repoUrl(path),
        target: "_blank",
        rel: "noopener noreferrer",
        title: "Open in the repository",
      },
      h("code", {}, label || path),
    );

  /* ---------------------------------------------------------------- fullscreen */

  ui.toggleFullscreen = function toggleFullscreen(el, onChange) {
    const native = el.requestFullscreen && document.fullscreenEnabled;
    const isOn = document.fullscreenElement === el || el.classList.contains("is-fullscreen");
    if (isOn) {
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
      el.classList.remove("is-fullscreen");
      document.body.classList.remove("vg-has-fullscreen");
    } else if (native) {
      el.requestFullscreen().catch(() => {
        el.classList.add("is-fullscreen");
        document.body.classList.add("vg-has-fullscreen");
      });
    } else {
      el.classList.add("is-fullscreen");
      document.body.classList.add("vg-has-fullscreen");
    }
    setTimeout(() => onChange && onChange(), 120);
  };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const fs = document.querySelector(".is-fullscreen");
    if (fs && !pop) {
      fs.classList.remove("is-fullscreen");
      document.body.classList.remove("vg-has-fullscreen");
      fs.dispatchEvent(new CustomEvent("vg-resize"));
    }
  });
  document.addEventListener("fullscreenchange", () => {
    for (const el of document.querySelectorAll(".vg-figure, .vg-stage"))
      el.dispatchEvent(new CustomEvent("vg-resize"));
  });

  /** Side detail panel used by graph-like views. */
  ui.detailPanel = function detailPanel(title) {
    const body = h("div", { class: "vg-detail-body" });
    const el = h("aside", { class: "vg-detail", "aria-label": title || "Details" }, body);
    return {
      el,
      body,
      set(nodes) {
        VG.clear(body);
        VG.append ? VG.append(body, nodes) : [].concat(nodes).forEach((n) => n && body.appendChild(n));
      },
    };
  };
})();
