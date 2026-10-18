// lib/dom.js (ota/frontend/README.md §5.2): `<template>` clones filled with textContent and allowlisted attributes by
// `data-field`, so API data never becomes markup or script; `$`, `$$` and `on()` with delegation.
import { afterEach, describe, expect, it, vi } from "vitest";

import { $, $$, clone, fill, on } from "../src/lib/dom.js";

/** Puts the test templates (and an element that is not one) into the page. */
function renderTemplates() {
  document.body.innerHTML = `
  <template id="tpl-offer">
    <article class="offer" data-field-data-offer-id="id" data-field-aria-label="label">
      <h3 data-field="carrier.name">Airline</h3>
      <p data-field="price">Price</p>
      <a href="/offer.html" data-field-href="detailsUrl" data-field-title="label">Details</a>
      <span data-field-hidden="direct">Stops</span>
      <img src="/placeholder.png" alt="" data-field-src="logoUrl" data-field-alt="carrier.name" />
    </article>
  </template>
  <template id="tpl-two"><li>a</li><li>b</li></template>
  <div id="not-a-template"></div>`;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("$ and $$", () => {
  it("[OFE-002 AC1] select inside the document or a root", () => {
    document.body.innerHTML = '<ul id="list"><li class="item">1</li><li class="item">2</li></ul>';
    const list = /** @type {Element} */ ($("#list"));

    expect($(".item")?.textContent).toBe("1");
    expect($$(".item", list).map((item) => item.textContent)).toEqual(["1", "2"]);
    expect($(".missing")).toBeNull();
    expect($$(".missing")).toEqual([]);
  });
});

describe("clone and fill", () => {
  it("[OFE-002 AC1] fills text with textContent, so markup in data stays text", () => {
    renderTemplates();
    const card = fill(clone("tpl-offer"), {
      id: "off_01",
      label: "Air France, 412 euros",
      carrier: { name: '<img src=x onerror="alert(1)">' },
      price: "€412.30",
      detailsUrl: "/offer.html?offer=off_01",
      direct: true,
      logoUrl: "/api/v1/assets/demo/ast_01.png",
    });
    document.body.append(card);

    expect(card.getAttribute("data-offer-id")).toBe("off_01");
    expect(card.getAttribute("aria-label")).toBe("Air France, 412 euros");
    const heading = /** @type {Element} */ (card.querySelector("h3"));
    expect(heading.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(heading.childElementCount).toBe(0);
    expect(document.querySelectorAll("img")).toHaveLength(1);
    expect(card.querySelector("p")?.textContent).toBe("€412.30");
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/offer.html?offer=off_01");
    expect(card.querySelector("a")?.getAttribute("title")).toBe("Air France, 412 euros");
    expect(card.querySelector("span")?.hidden).toBe(true);
    expect(card.querySelector("img")?.getAttribute("src")).toBe("/api/v1/assets/demo/ast_01.png");
    expect(card.querySelector("img")?.getAttribute("alt")).toBe('<img src=x onerror="alert(1)">');
  });

  it("[OFE-002 AC1] removes unsafe URLs, keeps template text for missing data and empties it for null", () => {
    renderTemplates();
    const card = fill(clone("tpl-offer"), {
      price: null,
      detailsUrl: "javascript:alert(1)",
      logoUrl: "https://cdn.example.com/logo.png",
      direct: false,
      __proto__: { carrier: { name: "inherited" } },
    });

    expect(card.querySelector("h3")?.textContent).toBe("Airline");
    expect(card.querySelector("p")?.textContent).toBe("");
    expect(card.querySelector("a")?.hasAttribute("href")).toBe(false);
    // Images are same-origin only (CSP img-src 'self'): an absolute URL is dropped.
    expect(card.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(card.querySelector("span")?.hidden).toBe(false);

    const link = fill(clone("tpl-offer"), { detailsUrl: "mailto:help@example.com" }).querySelector("a");
    expect(link?.getAttribute("href")).toBe("mailto:help@example.com");
  });

  it("[OFE-002 AC1] refuses attributes outside the allowlist and objects as text", () => {
    for (const attribute of ["onclick", "style", "srcdoc", "class", "formaction", "data-field-x"]) {
      const element = document.createElement("div");
      element.setAttribute(`data-field-${attribute}`, "value");

      expect(() => fill(element, { value: "alert(1)" }), attribute).toThrow(/not an attribute fill may set/);
      expect(element.hasAttribute(attribute)).toBe(false);
    }
    const price = document.createElement("p");
    price.setAttribute("data-field", "price");
    expect(() => fill(price, { price: { amount: "1.00", currency: "EUR" } })).toThrow(TypeError);
  });

  it("[OFE-002 AC1] sets href on links and src on images only, never on scripts, frames or stylesheets", () => {
    for (const [tag, attribute] of [
      ["script", "src"],
      ["iframe", "src"],
      ["embed", "src"],
      ["link", "href"],
      ["base", "href"],
      ["div", "href"],
    ]) {
      const element = document.createElement(/** @type {string} */ (tag));
      element.setAttribute(`data-field-${attribute}`, "url");

      expect(() => fill(element, { url: "/same-origin.js" }), `${tag} ${attribute}`).toThrow(
        /not an attribute fill may set/,
      );
      expect(element.hasAttribute(/** @type {string} */ (attribute))).toBe(false);
    }
    const area = document.createElement("area");
    area.setAttribute("data-field-href", "url");
    expect(fill(area, { url: "/p/terms" }).getAttribute("href")).toBe("/p/terms");
  });

  it("[OFE-002 AC1] clones exactly one element of a template, and refuses anything else", () => {
    renderTemplates();

    const first = clone("tpl-offer");
    const second = clone("tpl-offer");
    expect(first).not.toBe(second);
    expect(first.tagName).toBe("ARTICLE");
    expect(() => clone("tpl-two")).toThrow(/exactly one element/);
    expect(() => clone("not-a-template")).toThrow(/no <template id="not-a-template">/);
    expect(() => clone("missing")).toThrow(/no <template/);
  });
});

describe("on", () => {
  it("[OFE-002 AC1] adds a listener and returns its remover", () => {
    const button = document.createElement("button");
    const listener = vi.fn();

    const off = on(button, "click", listener);
    button.click();
    off();
    button.click();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("[OFE-002 AC1] delegates to matching descendants, a form included", () => {
    document.body.innerHTML =
      '<form id="form"><ul><li data-action="remove"><span>Remove</span></li><li>Keep</li></ul></form>';
    const form = /** @type {HTMLFormElement} */ (document.getElementById("form"));
    const listener = vi.fn();

    const off = on(form, "click", "[data-action=remove]", listener);
    /** @type {HTMLElement} */ (form.querySelector("span")).click();
    /** @type {HTMLElement} */ (form.querySelectorAll("li")[1]).click();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[1]).toBe(form.querySelector("li"));
    off();
    /** @type {HTMLElement} */ (form.querySelector("span")).click();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("[OFE-002 AC1] ignores matches outside the target", () => {
    document.body.innerHTML =
      '<div data-action="remove"><section id="inner"><button>Inside</button></section></div>';
    const inner = /** @type {HTMLElement} */ (document.getElementById("inner"));
    const listener = vi.fn();

    on(inner, "click", "[data-action=remove]", listener);
    /** @type {HTMLElement} */ (inner.querySelector("button")).click();

    expect(listener).not.toHaveBeenCalled();
    expect(() => on(inner, "click", "button")).toThrow(TypeError);
  });
});
