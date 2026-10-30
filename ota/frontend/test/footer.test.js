// The page footer (src/components/footer.js, partials/footer.html; ota/frontend/docs/pages-account.md §7, README §5.1
// point 3): besides the legal links and the support contacts, the published content pages of `storefront.listPages`
// that have `showInFooter`, in the API's order, kept in sessionStorage for 5 minutes, never twice when a legal link
// names the page, and with the footer's other links unchanged when the call fails. boot() hands the footer its client.
import { ServerError } from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { boot } from "../src/boot.js";
import {
  PAGES_STORAGE_KEY,
  PAGES_TTL_MS,
  footerPages,
  loadFooterPages,
  mount,
} from "../src/components/footer.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

const CONFIG = Object.freeze({
  tenantKey: "demo-travel",
  name: "Demo Travel",
  environment: "live",
  primaryUrl: "https://travel.demo-travel.example",
  domains: [
    { host: "travel.demo-travel.example", kind: "custom", primary: true, verifiedAt: "2026-10-01T00:00:00Z" },
    {
      host: "demo-travel.ota.example.com",
      kind: "subdomain",
      primary: false,
      verifiedAt: "2026-10-01T00:00:00Z",
    },
  ],
  features: { customerAccounts: false },
  currencies: [],
  legal: {
    termsUrl: "https://travel.demo-travel.example/p/terms",
    termsVersion: "2026-10-01",
    privacyUrl: "https://demo-travel.ota.example.com/p/privacy",
    privacyVersion: "2026-10-01",
    cookiePolicyUrl: "https://policies.example.org/cookies",
    refundPolicyUrl: "javascript:alert(1)",
    imprintUrl: null,
    accessibilityUrl: null,
  },
  support: {
    email: "help@demo-travel.example",
    phone: null,
    hours: null,
    helpCenterUrl: "https://help.demo-travel.example/",
  },
});

/** A `storefront.listPages` answer. */
const PAGE_LIST = Object.freeze({
  data: [
    { slug: "about-us", title: "About Demo Travel", kind: "about", showInFooter: true, sortOrder: 10 },
    { slug: "terms", title: "Terms and conditions", kind: "terms", showInFooter: true, sortOrder: 20 },
    { slug: "privacy", title: "Privacy policy", kind: "privacy", showInFooter: true, sortOrder: 30 },
    {
      slug: "baggage-faq",
      title: "<b>Baggage</b> questions",
      kind: "faq",
      showInFooter: true,
      sortOrder: 40,
    },
    { slug: "drafty", title: "Not in the footer", kind: "content", showInFooter: false, sortOrder: 50 },
    { slug: "Bad Slug", title: "Bad slug", kind: "content", showInFooter: true, sortOrder: 60 },
    { slug: "untitled", title: "   ", kind: "content", showInFooter: true, sortOrder: 70 },
    { slug: "about-us", title: "About us again", kind: "about", showInFooter: true, sortOrder: 80 },
  ],
});

/** @type {Browser | undefined} */
let browser;
/** The footer partial, parsed once in a happy-dom browser page. */
let footerSource = /** @type {Element | null} */ (null);

beforeAll(() => {
  // Parses partials/footer.html once; each test imports a fresh copy of its <footer> into the test document.
  browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  const page = browser.newPage();
  page.content = `<!doctype html><html><body>${readFileSync(join(STOREFRONT_ROOT, "partials", "footer.html"), "utf8")}</body></html>`;
  footerSource = /** @type {Element | null} */ (
    /** @type {unknown} */ (page.mainFrame.document.querySelector("body > footer"))
  );
}, 10_000); // one file read and one happy-dom browser page

afterAll(async () => {
  await browser?.close();
});

const views = /** @type {Array<{ destroy: () => void }>} */ ([]);
afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  history.replaceState(null, "", "/");
  try {
    sessionStorage.clear();
  } catch {
    // happy-dom always has storage; nothing to clear otherwise.
  }
});

/** An in-memory sessionStorage. */
function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: vi.fn((/** @type {string} */ key) => (items.has(key) ? items.get(key) : null)),
    setItem: vi.fn((/** @type {string} */ key, /** @type {string} */ value) => void items.set(key, value)),
    removeItem: vi.fn((/** @type {string} */ key) => void items.delete(key)),
  };
}

/** A storage whose every access throws, like a browser that blocks it. */
const blockedStorage = () => ({
  getItem: vi.fn(() => {
    throw new Error("SecurityError");
  }),
  setItem: vi.fn(() => {
    throw new Error("SecurityError");
  }),
  removeItem: vi.fn(() => {
    throw new Error("SecurityError");
  }),
});

/**
 * A fake client whose `storefront.listPages` gives `answers` in turn (an Error is thrown; the last answer repeats).
 * @param {unknown[]} answers
 */
function fakeClient(answers) {
  const queue = [...answers];
  const listPages = vi.fn(async () => {
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer instanceof Error) {
      throw answer;
    }
    return structuredClone(answer);
  });
  return { storefront: { listPages } };
}

/** Puts the footer partial into the test document and returns the `<footer>`. */
function footerRoot() {
  if (!footerSource) {
    throw new Error("partials/footer.html has no <footer>");
  }
  const footer = /** @type {HTMLElement} */ (document.importNode(footerSource, true));
  document.body.append(footer);
  return footer;
}

/**
 * Mounts the footer with a fake client and waits for its content pages.
 * @param {Partial<import("../src/components/footer.js").FooterProps>} [props]
 */
async function mountFooter(props = {}) {
  const view = mount(footerRoot(), { config: /** @type {never} */ (CONFIG), ...props });
  views.push(view);
  await view.done;
  return view;
}

const text = (/** @type {Element | null} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
/** The footer's links: text, href, rel and aria-current. */
const footerLinks = () =>
  Array.from(document.querySelectorAll('footer [data-slot="footer-links"] a'), (link) => [
    text(link),
    link.getAttribute("href"),
    link.getAttribute("rel"),
    link.getAttribute("aria-current"),
  ]);

describe("footer: content pages", () => {
  it("[OFE-020] lists the pages with showInFooter after the legal links, in the API's order, once per slug", async () => {
    const client = fakeClient([PAGE_LIST]);
    await mountFooter({ client, storage: memoryStorage() });

    expect(client.storefront.listPages).toHaveBeenCalledTimes(1);
    expect(footerLinks()).toEqual([
      ["Find a booking", "/lookup.html", null, null],
      ["Terms and conditions", "https://travel.demo-travel.example/p/terms", "noopener noreferrer", null],
      ["Privacy policy", "https://demo-travel.ota.example.com/p/privacy", "noopener noreferrer", null],
      ["Cookie policy", "https://policies.example.org/cookies", "noopener noreferrer", null],
      // The terms and privacy pages are already named by the legal links of the OTA's own hosts.
      ["About Demo Travel", "/p/about-us", null, null],
      ["<b>Baggage</b> questions", "/p/baggage-faq", null, null],
      ["Help centre", "https://help.demo-travel.example/", "noopener noreferrer", null],
      ["help@demo-travel.example", "mailto:help@demo-travel.example", null, null],
    ]);
    // A title is text, never markup.
    expect(document.querySelectorAll("footer b")).toHaveLength(0);
  });

  it("[OFE-020] lists a page that a legal link on another site names, and marks the link of the page shown", async () => {
    history.replaceState(null, "", "/p/about-us");
    const config = {
      ...CONFIG,
      legal: {
        ...CONFIG.legal,
        termsUrl: "https://policies.example.org/p/terms",
        privacyUrl: "https://x.example/",
      },
    };
    await mountFooter({
      config: /** @type {never} */ (config),
      client: fakeClient([PAGE_LIST]),
      storage: null,
    });

    expect(footerLinks().filter(([, href]) => String(href).startsWith("/p/"))).toEqual([
      ["About Demo Travel", "/p/about-us", null, "page"],
      ["Terms and conditions", "/p/terms", null, null],
      ["Privacy policy", "/p/privacy", null, null],
      ["<b>Baggage</b> questions", "/p/baggage-faq", null, null],
    ]);
  });

  it("[OFE-020] ignores a failed listPages: the other links stay, and nothing is cached", async () => {
    const storage = memoryStorage();
    const client = fakeClient([
      new ServerError({ code: "SERVICE_UNAVAILABLE", message: "down", status: 503, requestId: "req_footer" }),
    ]);
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    await mountFooter({ client, storage });

    expect(footerLinks().map(([label]) => label)).toEqual([
      "Find a booking",
      "Terms and conditions",
      "Privacy policy",
      "Cookie policy",
      "Help centre",
      "help@demo-travel.example",
    ]);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    await expect(loadFooterPages({ client, storage })).resolves.toBeNull();
  });

  it("[OFE-020] asks nothing without listPages (a client of an older SDK) and changes nothing", async () => {
    await mountFooter({ client: /** @type {never} */ ({ storefront: {} }), storage: memoryStorage() });
    expect(footerLinks()).toHaveLength(6);
    await expect(loadFooterPages({ client: null })).resolves.toBeNull();
  });

  it("[OFE-020] keeps the list in sessionStorage for 5 minutes, and works when the browser refuses storage", async () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    const clock = () => now;
    const client = fakeClient([PAGE_LIST, { data: [] }]);

    await expect(loadFooterPages({ client, storage, now: clock })).resolves.toEqual([
      { slug: "about-us", title: "About Demo Travel" },
      { slug: "terms", title: "Terms and conditions" },
      { slug: "privacy", title: "Privacy policy" },
      { slug: "baggage-faq", title: "<b>Baggage</b> questions" },
    ]);
    expect(JSON.parse(storage.items.get(PAGES_STORAGE_KEY))).toEqual({
      storedAt: 1_000_000,
      pages: footerPages(PAGE_LIST),
    });
    now += PAGES_TTL_MS - 1;
    await loadFooterPages({ client, storage, now: clock });
    expect(client.storefront.listPages).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(loadFooterPages({ client, storage, now: clock })).resolves.toEqual([]);
    expect(client.storefront.listPages).toHaveBeenCalledTimes(2);

    // An entry that is not JSON is dropped and the API asked again.
    storage.items.set(PAGES_STORAGE_KEY, "{not json");
    await loadFooterPages({ client, storage, now: clock });
    expect(client.storefront.listPages).toHaveBeenCalledTimes(3);

    const blocked = fakeClient([PAGE_LIST]);
    await expect(loadFooterPages({ client: blocked, storage: blockedStorage() })).resolves.toHaveLength(4);
    await mountFooter({ client: blocked, storage: /** @type {never} */ (blockedStorage()) });
    expect(footerLinks().map(([, href]) => href)).toContain("/p/about-us");
  });

  it("[OFE-020] adds nothing when it is destroyed before the list arrives, and keeps the pages on update", async () => {
    /** @type {(value: unknown) => void} */
    let answer = () => {};
    const slow = { storefront: { listPages: vi.fn(() => new Promise((resolve) => (answer = resolve))) } };
    const view = mount(footerRoot(), { config: /** @type {never} */ (CONFIG), client: slow, storage: null });
    view.destroy();
    answer(structuredClone(PAGE_LIST));
    await view.done;
    expect(document.querySelectorAll("[data-footer-link]")).toHaveLength(0);

    document.body.replaceChildren();
    const live = await mountFooter({ client: fakeClient([PAGE_LIST]), storage: null });
    live.update({
      config: /** @type {never} */ ({ ...CONFIG, support: { ...CONFIG.support, helpCenterUrl: null } }),
    });
    const labels = footerLinks().map(([label]) => label);
    expect(labels).toContain("About Demo Travel");
    expect(labels).not.toContain("Help centre");
  });
});

describe("footer: boot", () => {
  it("[OFE-020] boot() gives the footer its client, so every page lists the content pages", async () => {
    footerRoot();
    const listPages = vi.fn(async () => structuredClone(PAGE_LIST));
    const client = {
      storefront: { get: vi.fn(async () => structuredClone(CONFIG)), listPages },
      withOptions: vi.fn(),
    };
    await boot({ client: /** @type {never} */ (client), storage: null, preferences: null, doc: document });
    await vi.waitFor(() => expect(footerLinks().map(([, href]) => href)).toContain("/p/about-us"), {
      timeout: 1000,
    });
    expect(listPages).toHaveBeenCalledTimes(1);
  });
});
