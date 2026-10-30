// Content pages (ota/frontend/docs/pages-account.md §7, OADR-0012 point 5, OADR-0015 point 4): lib/blocks.js builds
// the blocks of `storefront.getPage` with createElement and text nodes only, checks every link again (`https:`,
// `mailto:`, `tel:`, `/p/<slug>`) and takes images only from the OTA API's same-origin asset paths; p.html, run by
// src/pages/p.js against a fake SDK, reads the slug from the address and shows the page, the not-found content
// (`noindex`) or the shared states.
import { NotFoundError, PermissionError, ServerError, ValidationError } from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import {
  LINK_SCHEMES,
  MAX_LINK_LENGTH,
  renderBlocks,
  renderInline,
  safeImageSrc,
  safeLinkHref,
} from "../src/lib/blocks.js";
import { isPageSlug, pageHref, pageSlugFromPath } from "../src/lib/url.js";
import { start } from "../src/pages/p.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** The mocked boot() of the page module never resolves here (the static import above). */
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return { ...actual, boot: () => new Promise(() => {}) };
});

const PAGE = "p.html";
const TENANT_KEY = "demo-travel";
const ASSET = `/api/v1/assets/${TENANT_KEY}/ast_01JPAGEIMAGEASSET0000000001.png`;
const CONFIG = Object.freeze({
  tenantKey: TENANT_KEY,
  name: "Demo Travel",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
});

/** The HTML sinks no content-page module may use (conventions §4; ESLint `no-unsanitized` covers every file). */
const HTML_SINKS =
  /\b(?:innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe|srcdoc|DOMParser)\b|document\.write/;

const text = (/** @type {Node | null | undefined} */ node) =>
  node?.textContent?.replace(/\s+/g, " ").trim() ?? "";
/** @param {string} value */
const t = (value) => ({ type: "text", text: value });
/** @param {string} href @param {unknown[]} content */
const a = (href, ...content) => ({ type: "link", href, content });
/** @param {unknown[]} content */
const p = (...content) => ({ type: "paragraph", content });

/** Renders blocks into a fresh `<div>` of the test document. */
function rendered(/** @type {unknown} */ blocks, /** @type {string | null} */ tenantKey = TENANT_KEY) {
  const container = document.createElement("div");
  container.append(renderBlocks(blocks, { doc: document, tenantKey }));
  return container;
}

/** Removes `//` and `/* *\/` comments, keeping string literals intact. */
const withoutComments = (/** @type {string} */ code) =>
  code.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, literal) => literal ?? "",
  );

describe("lib/blocks.js: links", () => {
  it("[OFE-020 AC1] renders a block with a javascript: link as plain text, without an <a>", () => {
    const container = rendered([
      p(t("Read "), a("javascript:alert(document.cookie)", t("our terms")), t(" before you book.")),
    ]);

    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(text(container.querySelector("p"))).toBe("Read our terms before you book.");
    expect(container.innerHTML).not.toMatch(/javascript:/i);
  });

  it("[OFE-020 AC1] renders every other unsafe link as its text: other schemes, spellings and paths", () => {
    const unsafe = [
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "javascript&colon;alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://example.com/terms",
      "ftp://example.com/terms",
      "//evil.example/p/terms",
      "/\\evil.example",
      "/p/../account/",
      "/p/Terms",
      "/p/terms/",
      "/p/terms?x=1",
      "/checkout.html",
      "p/terms",
      "#top",
      "https://user:secret@example.com/",
      "https://example.com/a b",
      `https://example.com/${"x".repeat(MAX_LINK_LENGTH)}`,
      "",
    ];
    for (const href of unsafe) {
      const container = rendered([p(a(href, t("the link text")))]);
      expect(container.querySelector("a"), JSON.stringify(href)).toBeNull();
      expect(text(container), JSON.stringify(href)).toBe("the link text");
      expect(safeLinkHref(href), JSON.stringify(href)).toBeNull();
    }
    expect(safeLinkHref(undefined)).toBeNull();
    expect(safeLinkHref({ href: "https://example.com/" })).toBeNull();
  });

  it("[OFE-020] keeps https:, mailto:, tel: and /p/<slug> links; https: links get rel=noopener noreferrer", () => {
    expect(LINK_SCHEMES).toEqual(["https:", "mailto:", "tel:"]);
    const container = rendered([
      p(
        a("https://www.example.org/conditions?lang=en#fees", t("conditions")),
        t(", "),
        a("mailto:help@demo-travel.example", t("e-mail")),
        t(", "),
        a("tel:+442071234567", t("phone")),
        t(", "),
        a("/p/baggage-faq", t("baggage")),
      ),
    ]);
    const links = Array.from(container.querySelectorAll("a"), (link) => [
      link.getAttribute("href"),
      link.getAttribute("rel"),
      link.getAttribute("target"),
      text(link),
    ]);
    expect(links).toEqual([
      ["https://www.example.org/conditions?lang=en#fees", "noopener noreferrer", null, "conditions"],
      ["mailto:help@demo-travel.example", null, null, "e-mail"],
      ["tel:+442071234567", null, null, "phone"],
      ["/p/baggage-faq", null, null, "baggage"],
    ]);
    expect(text(container)).toBe("conditions, e-mail, phone, baggage");
  });

  it("[OFE-020] never nests links: a link inside a link is its text", () => {
    const container = rendered([
      p(a("https://example.com/outer", t("outer "), a("https://example.com/inner", t("inner")))),
    ]);
    expect(Array.from(container.querySelectorAll("a"), (link) => link.getAttribute("href"))).toEqual([
      "https://example.com/outer",
    ]);
    expect(text(container.querySelector("a"))).toBe("outer inner");
  });
});

describe("lib/blocks.js: blocks", () => {
  it("[OFE-020] builds headings 2 to 4, paragraphs with bold and italic, lists and images", () => {
    const container = rendered([
      { type: "heading", level: 2, content: [t("Booking")] },
      p(t("Fares are "), {
        type: "strong",
        content: [t("per person"), { type: "em", content: [t(" incl. tax")] }],
      }),
      { type: "heading", level: 3, content: [{ type: "em", content: [t("Changes")] }] },
      {
        type: "list",
        ordered: false,
        start: null,
        items: [{ content: [t("One")] }, { content: [t("Two")] }],
      },
      { type: "heading", level: 4, content: [t("Refunds")] },
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [{ content: [t("Third")] }, { content: [t("Fourth")] }],
      },
      {
        type: "image",
        assetId: "ast_01JPAGEIMAGEASSET0000000001",
        url: ASSET,
        alt: "Our office",
        width: 800,
        height: 600,
      },
    ]);

    expect(Array.from(container.children, (child) => child.tagName)).toEqual([
      "H2",
      "P",
      "H3",
      "UL",
      "H4",
      "OL",
      "FIGURE",
    ]);
    expect(container.querySelector("p strong em")?.textContent).toBe(" incl. tax");
    expect(text(container.querySelector("p"))).toBe("Fares are per person incl. tax");
    expect(container.querySelector("h3 em")?.textContent).toBe("Changes");
    expect(Array.from(container.querySelectorAll("ul li"), text)).toEqual(["One", "Two"]);
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(Array.from(container.querySelectorAll("ol li"), text)).toEqual(["Third", "Fourth"]);
    const img = /** @type {HTMLImageElement} */ (container.querySelector("figure img"));
    expect(img.getAttribute("src")).toBe(ASSET);
    expect(img.getAttribute("alt")).toBe("Our office");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["800", "600"]);
    expect(img.getAttribute("loading")).toBe("lazy");
    // Every element has its classes (complete strings for Tailwind's scanner); no style attribute anywhere.
    expect(container.querySelector("h2")?.className).toContain("font-heading");
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("[OFE-020] keeps the page title the only h1: other heading levels become h2", () => {
    const container = rendered([
      { type: "heading", level: 1, content: [t("One")] },
      { type: "heading", level: 6, content: [t("Six")] },
      { type: "heading", level: "3", content: [t("Text")] },
    ]);
    expect(Array.from(container.children, (child) => child.tagName)).toEqual(["H2", "H2", "H2"]);
  });

  it("[OFE-020] numbers a list from 1 unless start says otherwise, and never from a bad start", () => {
    const list = (/** @type {unknown} */ start) =>
      rendered([{ type: "list", ordered: true, start, items: [{ content: [t("x")] }] }])
        .querySelector("ol")
        ?.getAttribute("start");
    expect(list(1)).toBeNull();
    expect(list(null)).toBeNull();
    expect(list(0)).toBe("0");
    expect(list(-2)).toBeNull();
    expect(list(1.5)).toBeNull();
    expect(list("7")).toBeNull();
  });

  it("[OFE-020] takes images only from this OTA's same-origin asset paths", () => {
    const image = (/** @type {unknown} */ url, /** @type {string | null} */ key = TENANT_KEY) =>
      rendered([{ type: "image", url, alt: "", width: null, height: null }], key).querySelector("img");

    expect(image(ASSET)?.getAttribute("src")).toBe(ASSET);
    expect(image(`${location.origin}${ASSET}`)?.getAttribute("src")).toBe(ASSET);
    expect(image(ASSET)?.getAttribute("alt")).toBe("");
    expect(image(ASSET)?.hasAttribute("width")).toBe(false);
    for (const url of [
      `https://api.ota.example.com/v1/assets/${TENANT_KEY}/ast_01JPAGEIMAGEASSET0000000001.png`,
      `https://evil.example${ASSET}`,
      `${location.origin}${ASSET}?x=1`,
      `/api/v1/assets/other-ota/ast_01JPAGEIMAGEASSET0000000001.png`,
      `/api/v1/assets/${TENANT_KEY}/ast_01JPAGEIMAGEASSET0000000001.svg`,
      `/api/v1/assets/${TENANT_KEY}/../../v1/storefront`,
      `//evil.example${ASSET}`,
      "/images/logo.png",
      "data:image/png;base64,iVBORw0KGgo=",
      "javascript:alert(1)",
      `${ASSET} `,
      null,
    ]) {
      expect(image(url), String(url)).toBeNull();
    }
    // Without the tenant key (a configuration without it), any OTA's asset path on this origin.
    expect(image(`/api/v1/assets/other-ota/ast_01JPAGEIMAGEASSET0000000001.webp`, null)).not.toBeNull();
    expect(safeImageSrc(ASSET, { origin: null, tenantKey: TENANT_KEY })).toBe(ASSET);
  });

  it("[OFE-020] skips unknown block and inline types, empty blocks and non-text values", () => {
    const container = rendered([
      { type: "html", html: "<b>x</b>" },
      { type: "script", content: [t("alert(1)")] },
      p(t("")),
      p({ type: "raw", text: "<i>raw</i>" }, { type: "strong", content: [] }),
      { type: "heading", level: 2, content: [{ type: "text", text: 42 }] },
      { type: "list", ordered: false, start: null, items: [{ content: [] }, "x", null] },
      null,
      "paragraph",
      p(t("Kept")),
    ]);
    expect(container.innerHTML).toBe(`<p class="${container.querySelector("p")?.className}">Kept</p>`);
    expect(rendered(undefined).childNodes).toHaveLength(0);
    expect(rendered({ type: "paragraph" }).childNodes).toHaveLength(0);
  });

  it("[OFE-020 AC1] puts markup-looking text in text nodes and never calls an HTML sink", () => {
    const innerHTML = vi.spyOn(Element.prototype, "innerHTML", "set");
    const outerHTML = vi.spyOn(Element.prototype, "outerHTML", "set");
    const insertAdjacentHTML = vi.spyOn(Element.prototype, "insertAdjacentHTML");
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

    const container = rendered([
      { type: "heading", level: 2, content: [t(payload)] },
      p(a("https://example.com/", t(payload)), { type: "em", content: [t(payload)] }),
      { type: "list", ordered: false, start: null, items: [{ content: [t(payload)] }] },
      { type: "image", url: ASSET, alt: payload, width: 1, height: 1 },
    ]);
    const inline = renderInline([t(payload)], document);

    expect(innerHTML).not.toHaveBeenCalled();
    expect(outerHTML).not.toHaveBeenCalled();
    expect(insertAdjacentHTML).not.toHaveBeenCalled();
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe(payload);
    expect(container.querySelectorAll("[onerror]")).toHaveLength(0);
    expect(container.querySelector("h2")?.textContent).toBe(payload);
    expect(inline.textContent).toBe(payload);

    // The modules themselves contain no HTML sink at all (comments aside).
    for (const file of ["src/lib/blocks.js", "src/pages/p.js"]) {
      expect(withoutComments(readFileSync(join(STOREFRONT_ROOT, file), "utf8")), file).not.toMatch(
        HTML_SINKS,
      );
    }
  });

  it("[OFE-020] leaves out inline nodes nested deeper than the Markdown subset can", () => {
    /** @type {Record<string, unknown>} */
    let node = t("deep");
    for (let i = 0; i < 40; i += 1) {
      node = { type: "strong", content: [node] };
    }
    const container = rendered([p(t("shallow "), node)]);
    expect(text(container.querySelector("p"))).toBe("shallow");
  });
});

describe("lib/url.js: content page slugs", () => {
  it("[OFE-020] reads the slug of /p/<slug> from the path, and nothing else", () => {
    expect(pageSlugFromPath("/p/terms")).toBe("terms");
    expect(pageSlugFromPath("/p/baggage-faq/")).toBe("baggage-faq");
    expect(pageSlugFromPath("/P/Terms")).toBe("terms");
    expect(pageSlugFromPath("/p/about%2Dus")).toBe("about-us");
    for (const path of [
      "/p/",
      "/p",
      "/p.html",
      "/p/a/b",
      "/p//terms",
      "/p/-terms",
      "/p/terms-",
      "/p/te--rms",
      "/p/te_rms",
      "/p/%3Cscript%3E",
      "/p/%E0%A4%A",
      `/p/${"a".repeat(65)}`,
      "/pages/terms",
      "/x/p/terms",
    ]) {
      expect(pageSlugFromPath(path), path).toBeNull();
    }
    expect(isPageSlug("a".repeat(64))).toBe(true);
    expect(pageHref("terms")).toBe("/p/terms");
  });
});

/** @type {Browser | undefined} */
let browser;
/** @type {Document | undefined} */
let pageDocument;
const original = { title: "" };
const views = /** @type {Array<{ destroy: () => void }>} */ ([]);

beforeAll(async () => {
  // Expands p.html with the build's include plugin and parses it once in a happy-dom browser; each test imports a
  // fresh copy of its body into the test document.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  const html = await transform.handler(readFileSync(join(STOREFRONT_ROOT, PAGE), "utf8"), {
    path: `/${PAGE}`,
  });
  browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  const page = browser.newPage();
  page.url = `${location.origin}/${PAGE}`;
  page.content = html;
  pageDocument = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}, 15_000); // a file read, the include plugin and one happy-dom browser page; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
  document.head.querySelector('meta[name="robots"]')?.remove();
  if (original.title !== "") {
    document.title = original.title;
  }
});

/** @param {Function} ErrorClass @param {string} code @param {number} status */
const apiError = (ErrorClass, code, status) =>
  new ErrorClass({ code, message: `${code} from the fake API`, status, requestId: "req_content_page" });

/** A published page as `storefront.getPage` answers it. */
const content = (/** @type {Record<string, unknown>} */ overrides = {}) => ({
  slug: "terms",
  locale: "en-GB",
  title: "Terms and conditions",
  kind: "terms",
  blocks: [
    { type: "heading", level: 2, content: [t("Booking")] },
    p(
      t("See the "),
      a("javascript:alert(1)", t("airline's rules")),
      t(" and "),
      a("/p/privacy", t("privacy")),
    ),
  ],
  updatedAt: "2026-10-20T10:00:00Z",
  ...overrides,
});

/**
 * A fake `storefront.getPage` that gives `answers` in turn (an Error is thrown; the last answer repeats).
 * @param {unknown[]} answers
 */
function fakeClient(answers) {
  const queue = [...answers];
  const getPage = vi.fn(async () => {
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer instanceof Error) {
      throw answer;
    }
    return structuredClone(answer);
  });
  return { storefront: { getPage } };
}

/** Waits until queued promise callbacks have run (the fake SDK answers at once). */
const settle = async () => {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
};

const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const robots = () => document.head.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null;

/**
 * Opens p.html at `pathname` with a fake SDK.
 * @param {string} pathname
 * @param {ReturnType<typeof fakeClient>} client
 */
async function openPage(pathname, client) {
  original.title ||= document.title;
  const source = /** @type {Document} */ (pageDocument);
  document.body.replaceChildren(
    ...Array.from(source.body.childNodes, (node) => document.importNode(node, true)),
  );
  document.title = source.title;
  const view = start(
    { config: /** @type {never} */ (CONFIG), client: /** @type {never} */ (client) },
    { doc: document, location: /** @type {Location} */ ({ pathname }) },
  );
  if (!view) {
    throw new Error("the content page did not start");
  }
  views.push(view);
  await view.done;
  await settle();
  return view;
}

describe("p.html: the content page", () => {
  it("[OFE-020] reads the slug from the address and shows the page: title, blocks, language", async () => {
    const client = fakeClient([content()]);
    await openPage("/p/terms", client);

    expect(client.storefront.getPage).toHaveBeenCalledTimes(1);
    expect(client.storefront.getPage).toHaveBeenCalledWith(
      { slug: "terms" },
      { signal: expect.any(AbortSignal) },
    );
    const article = $("[data-page-article]");
    expect(article.hidden).toBe(false);
    expect(article.getAttribute("lang")).toBe("en-GB");
    expect(text($("main h1:not([hidden] *)"))).toBe("Terms and conditions");
    expect(document.title).toBe("Terms and conditions");
    expect(text($("[data-page-body] h2"))).toBe("Booking");
    // The javascript: link is plain text; the page link stays a link.
    expect(text($("[data-page-body] p"))).toBe("See the airline's rules and privacy");
    expect(
      Array.from(document.querySelectorAll("[data-page-body] a"), (link) => link.getAttribute("href")),
    ).toEqual(["/p/privacy"]);
    expect($("[data-page-loading]").hidden).toBe(true);
    expect($("[data-page-not-found]").hidden).toBe(true);
    expect($("[data-page-state]").childElementCount).toBe(0);
    expect(robots()).toBeNull();
  });

  it("[OFE-020] accepts upper case and a trailing slash, as Caddy's rewrite does", async () => {
    const client = fakeClient([content({ slug: "about-us", title: "About us", locale: "x" })]);
    await openPage("/P/About-Us/", client);
    expect(client.storefront.getPage).toHaveBeenCalledWith({ slug: "about-us" }, expect.anything());
    expect(document.title).toBe("About us");
    // A locale that is no language tag sets no lang.
    expect($("[data-page-article]").hasAttribute("lang")).toBe(false);
  });

  it("[OFE-020] shows the not-found content with noindex for an address without a valid slug, without a request", async () => {
    for (const pathname of ["/p/", "/p.html", "/p/a/b", "/p/%3Cscript%3E"]) {
      const client = fakeClient([content()]);
      await openPage(pathname, client);
      expect(client.storefront.getPage, pathname).not.toHaveBeenCalled();
      expect($("[data-page-not-found]").hidden, pathname).toBe(false);
      expect($("[data-page-article]").hidden, pathname).toBe(true);
      expect(document.title, pathname).toBe("Page not found");
      expect(robots(), pathname).toBe("noindex");
    }
  });

  it("[OFE-020] shows the 404 page's content in place, with noindex, for 404 NOT_FOUND (and a slug the API refuses)", async () => {
    for (const error of [
      apiError(NotFoundError, "NOT_FOUND", 404),
      apiError(ValidationError, "VALIDATION_FAILED", 400),
    ]) {
      await openPage("/p/old-terms", fakeClient([error]));
      expect($("[data-page-not-found]").hidden, error.code).toBe(false);
      expect(text($("[data-page-not-found] h1")), error.code).toBe("Page not found");
      expect($("[data-page-not-found] a")?.getAttribute("href"), error.code).toBe("/");
      expect($("[data-page-article]").hidden, error.code).toBe(true);
      expect(document.title, error.code).toBe("Page not found");
      expect(robots(), error.code).toBe("noindex");
    }
  });

  it("[OFE-020] offers Retry when the API is unavailable, and shows the page after it", async () => {
    const client = fakeClient([apiError(ServerError, "SERVICE_UNAVAILABLE", 503), content()]);
    await openPage("/p/terms", client);

    const unavailable = "The service is not available right now. Nothing is lost: try again in a moment.";
    expect($("[data-page-article]").hidden).toBe(true);
    expect(text($('[data-page-state] [data-field="title"]'))).toBe(unavailable);
    // As on the other pages: the state is the document title, and the live region says it (after its short delay).
    expect(document.title).toBe(unavailable);
    await vi.waitFor(() => expect(text($("[data-live-region]"))).toBe(unavailable), { timeout: 1000 });
    const retry = /** @type {HTMLButtonElement} */ ($('[data-page-state] [data-action="retry"]'));
    retry.click();
    await settle();

    expect(client.storefront.getPage).toHaveBeenCalledTimes(2);
    expect($("[data-page-article]").hidden).toBe(false);
    expect($("[data-page-state]").childElementCount).toBe(0);
    expect(document.title).toBe("Terms and conditions");
    expect(document.activeElement).toBe($("[data-page-title]"));
  });

  it("[OFE-020] shows the request id for an unexpected error, and no Retry for a suspended storefront", async () => {
    await openPage("/p/terms", fakeClient([apiError(ServerError, "INTERNAL_ERROR", 500)]));
    expect(text($("[data-page-state]"))).toContain("req_content_page");
    expect($('[data-page-state] [data-action="retry"]')).not.toBeNull();

    await openPage("/p/terms", fakeClient([apiError(PermissionError, "TENANT_SUSPENDED", 403)]));
    expect(text($('[data-page-state] [data-field="title"]'))).toBe(
      "This travel site is temporarily unavailable",
    );
    expect($('[data-page-state] [data-action="retry"]')).toBeNull();
    expect($("[data-page-article]").hidden).toBe(true);
    expect(document.title).toBe("This travel site is temporarily unavailable");
  });

  it("[OFE-020] uses the slug as the title when the page has none, and ignores an answer after destroy()", async () => {
    await openPage("/p/terms", fakeClient([content({ title: "  " })]));
    expect(document.title).toBe("terms");

    /** @type {(value: unknown) => void} */
    let answer = () => {};
    const slow = { storefront: { getPage: vi.fn(() => new Promise((resolve) => (answer = resolve))) } };
    document.body.replaceChildren(
      ...Array.from(/** @type {Document} */ (pageDocument).body.childNodes, (node) =>
        document.importNode(node, true),
      ),
    );
    const view = start(
      { config: /** @type {never} */ (CONFIG), client: /** @type {never} */ (slow) },
      { doc: document, location: /** @type {Location} */ ({ pathname: "/p/privacy" }) },
    );
    expect($("[data-page-loading]").hidden).toBe(false);
    view?.destroy();
    answer(content({ title: "Privacy" }));
    await view?.done;
    expect($("[data-page-article]").hidden).toBe(true);
    expect(document.title).not.toBe("Privacy");
  });
});
