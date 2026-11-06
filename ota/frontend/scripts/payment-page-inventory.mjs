#!/usr/bin/env node
// payment-page-inventory: the script inventory of the storefront build for PCI DSS 6.4.3 and the daily integrity
// check of 11.6.1 (ADR-0011 §C, OADR-0017 point 8, ota/frontend/README.md §10).
//
// Usage:  node scripts/payment-page-inventory.mjs [--dir <dist folder>]   (default: dist/ next to this script's package)
//
// Runs after `vite build` (package.json "build") and writes <dir>/payment-page-inventory.json. The release carries
// dist/ as storefront/ (deploy/scripts/pack-release.sh), so the file is storefront/payment-page-inventory.json of the
// release, /srv/velexis/current/storefront/payment-page-inventory.json on the VM: the file the payment page check of
// the on-VM health check reads (X-030, deploy/scripts/healthcheck.sh) and the source of the PCI evidence pack's
// script inventory (OBE-085). Its format (version 1) is documented in README §10.
//
// It lists EVERY HTML page of the build, not only the two payment pages: any script on the storefront origin could
// draw a look-alike card form or reach the card page (OADR-0017 point 8). Per page: its URL paths, its purpose, the
// SHA-256 of the HTML file, the ordered `<script src>` list (hashed first-party bundles, and Stripe.js by URL with its
// justification on /checkout/pay-card.html), the module preloads, every first-party script the page can run (its
// scripts, preloads and the chunks they import, statically or dynamically: the files scripts/check-budgets.mjs
// counts) with its SHA-256, the stylesheets, and the security headers Caddy sends on its paths. The two payment pages
// are flagged `payment: true`.
//
// The lists below are the reviewed part (the "authorised" of 6.4.3): it exits 1, prints why and writes no inventory
// (it removes a stale one) when the build has a page that is not in PAGE_PURPOSES or lacks one that is, when a page
// loads a third-party script, module preload or stylesheet that THIRD_PARTY_SCRIPTS does not list for it (or lacks
// one it lists), when a chunk a page runs imports a URL of another origin, when a page has an inline script or a
// <script> or <link> inside an HTML comment, or when a page references a file that is not in the build.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { PAY_AIRLINE_HEADERS, PAY_AIRLINE_PATHS } from "../vite.config.js";
import { STOREFRONT_HEADERS } from "./vite-plugins.js";

/** The file name, in the build folder and in the release's storefront/ folder. */
export const INVENTORY_FILE = "payment-page-inventory.json";
/** The `format` and `version` of the file; a reader refuses a version it does not know (README §10). */
export const INVENTORY_FORMAT = "velexis-storefront-payment-page-inventory";
export const INVENTORY_VERSION = 1;

export const CARD_PAGE = "checkout/pay-card.html";
export const AIRLINE_CARD_PAGE = "checkout/pay-airline.html";
/** The pages that take a payment (ADR-0011 §C): flagged `payment: true`. */
export const PAYMENT_PAGES = Object.freeze([CARD_PAGE, AIRLINE_CARD_PAGE]);

/** Stripe.js, as checkout/pay-card.html loads it: a static tag, never bundled or self-hosted (README §10). */
export const STRIPE_JS_URL = "https://js.stripe.com/v3/";

/**
 * Every page of the build (dist-relative file) with its purpose, as README §4 and §10 list them. A new page joins the
 * build by existing (README §12) but joins the inventory only once it is listed here: until then the inventory fails
 * the build, so no page reaches the origin of the card page without a review.
 */
export const PAGE_PURPOSES = Object.freeze({
  "404.html": "Not found page (Caddy's handle_errors 404)",
  "account/forgot-password.html": "Customer authentication: asks for a password reset link",
  "account/index.html": "Account: profile, password change, sign out everywhere, account deletion",
  "account/reset-password.html": "Customer authentication: sets a new password with the e-mailed token",
  "account/sign-in.html": "Customer authentication: sign in",
  "account/sign-up.html": "Customer authentication: sign up",
  "account/verify.html": "Customer authentication: verifies the e-mail address with the e-mailed token",
  "booking.html": "Booking detail: trip, tickets, documents, contact change, cancellation, history",
  "bookings.html": "My bookings of a signed-in customer",
  "checkout.html":
    "Checkout data: travellers, contacts, extras and special requests, payment method and terms",
  "checkout/complete.html": "Completes the checkout after Stripe (the 3-D Secure return URL); no Stripe.js",
  [AIRLINE_CARD_PAGE]:
    "Airline-card payment: the card form, the airline's fee review and Pay; no third-party script (OADR-0017)",
  [CARD_PAGE]: "Card payment: Stripe's Payment Element, the card-fee review and Pay",
  "confirmation.html": "Booking confirmation and ticketing status",
  "index.html": "Home: the search form",
  "lookup.html": "Guest booking lookup by reference and last name",
  "offer.html": "Offer details and branded fares",
  "p.html": "The OTA's content pages (/p/<slug>)",
  "price.html": "Confirmed price, breakdown, extras available and fare rules; starts the checkout",
  "search.html": "Search results with filters, sort and load more",
});

/**
 * The only third-party code of the storefront, per page (README §1: Stripe.js on one page, nothing else anywhere).
 * Its body changes without notice and cannot be hashed (`sha256: null`); its URL, its page and the headers that
 * limit what it can reach are what the daily check compares.
 */
export const THIRD_PARTY_SCRIPTS = Object.freeze({
  [CARD_PAGE]: Object.freeze([
    Object.freeze({
      src: STRIPE_JS_URL,
      purpose:
        "Stripe.js: mounts Stripe's Payment Element, whose iframes on Stripe's origin collect the card, and runs " +
        "3-D Secure",
      justification:
        "Required for card payments through Stripe (method (a), ADR-0011 §A). Stripe serves it only from " +
        "js.stripe.com and does not allow bundling or self-hosting it, so it is loaded by URL and not hashed; card " +
        "data stays in Stripe's iframes and never reaches this page's code. Only on this page, never on the " +
        "airline-card page (OADR-0017 points 1 and 2); the CSP allows Stripe's hosts only for scripts, frames and " +
        "api.stripe.com.",
    }),
  ]),
});

/** Strict-Transport-Security of the Caddyfile's `(storefront_headers)`, which `vite preview` (plain HTTP) omits. */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000";
/** Cache-Control of every storefront file outside /assets/ (`header @not_hashed` of the Caddyfile). */
export const PAGE_CACHE_CONTROL = "no-cache";

/**
 * The security headers Caddy sends on a page, by header name; `null` means the answer must not carry the header.
 * Every page: the storefront headers of the Caddyfile (`(storefront_headers)`: HSTS, the CSP, Referrer-Policy,
 * nosniff, Permissions-Policy, and neither Cross-Origin-Opener-Policy nor Server) and `no-cache`; the airline-card
 * page: its own CSP, COOP `same-origin` and `no-store` instead (`header @pay_airline`, OADR-0017 point 3). The values
 * are the copies `vite preview` sends (STOREFRONT_HEADERS, PAY_AIRLINE_HEADERS), which test/csp.test.js and
 * test/pay-airline.test.js compare with the Caddyfile, and the two above, which it does not send: so the build reads
 * nothing outside this package (Turborepo's build inputs) and test/payment-page-inventory.test.js, which re-runs when
 * the Caddyfile changes (turbo.json), compares the whole set per path with the Caddyfile.
 * @param {string} file dist-relative page
 * @returns {Record<string, string | null>}
 */
export function expectedHeaders(file) {
  return {
    "Strict-Transport-Security": STRICT_TRANSPORT_SECURITY,
    ...STOREFRONT_HEADERS,
    "Cross-Origin-Opener-Policy": null,
    Server: null,
    "Cache-Control": PAGE_CACHE_CONTROL,
    ...(file === AIRLINE_CARD_PAGE ? PAY_AIRLINE_HEADERS : {}),
  };
}

/**
 * The URL paths a page is checked at: its address (README §4: `/` for index.html, `/account/` for account/index.html,
 * the file's path otherwise), and for the airline-card page also `/checkout/pay-airline`, the other name the
 * Caddyfile's `@pay_airline` matcher gives it (PAY_AIRLINE_PATHS of vite.config.js).
 * @param {string} file dist-relative page
 */
export function pagePaths(file) {
  if (file === AIRLINE_CARD_PAGE) {
    return [...PAY_AIRLINE_PATHS];
  }
  return [
    file === "index.html" || file.endsWith("/index.html")
      ? `/${file.slice(0, -"index.html".length)}`
      : `/${file}`,
  ];
}

const toPosix = (/** @type {string} */ path) => path.split(sep).join("/");
const sha256 = (/** @type {Buffer | string} */ data) => createHash("sha256").update(data).digest("hex");

/** @param {string} dir */
function htmlPages(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map(toPosix)
    .filter((file) => file.endsWith(".html") && statSync(join(dir, file)).isFile())
    .sort();
}

/**
 * HTML comments as a browser ends them (HTML Living Standard, comment states): `<!-->` and `<!--->` are whole
 * comments, any other runs to the first `-->` or `--!>`. Read the same way, a comment can never hide markup that the
 * browser runs, such as a script after `<!-->`. An unclosed comment is left as markup, so it hides nothing either.
 */
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?--!?>)/g;

/**
 * Attributes of every `<name …>` tag of `html`, lower-cased names, in document order; comments are not markup.
 * @param {string} html
 * @param {string} name
 */
function tags(html, name) {
  const out = [];
  for (const [tag] of html.replace(HTML_COMMENT, "").matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))) {
    /** @type {Record<string, string>} */
    const attrs = {};
    for (const m of tag.matchAll(/([^\s=<>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const key = (m[1] ?? "").toLowerCase();
      if (key !== name.toLowerCase()) {
        attrs[key] = m[2] ?? m[3] ?? m[4] ?? "";
      }
    }
    out.push(attrs);
  }
  return out;
}

/**
 * The dist-relative file of a URL found in `from` (a dist-relative file), or null for a URL of another origin
 * (scheme or `//`), which is third-party.
 * @param {string} url
 * @param {string} from
 */
function localPath(url, from) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
    return null;
  }
  const path = url.split(/[?#]/)[0] ?? "";
  return posix.normalize(path.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(from), path));
}

/**
 * Module specifiers a built JS file imports (`import"./x.js"`, `from"./x.js"`, `import("./x.js")`): the chunks of the
 * build, read as scripts/check-budgets.mjs reads them, and any URL of another origin (a scheme or `//`) whatever its
 * file name ends with, so `import("https://cdn.example.net/x")` is third-party code too. A URL a script builds at run
 * time cannot be read from the file: the CSP's `script-src` is what refuses it.
 */
function jsImports(/** @type {string} */ code) {
  return [
    ...code.matchAll(
      /(?:\bimport\s*\(?|\bfrom)\s*["'`]((?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)[^"'`]*|[^"'`]+\.m?js)["'`]/g,
    ),
  ].map((m) => m[1] ?? "");
}

/**
 * @typedef {{ src: string, firstParty: boolean, sha256: string | null, purpose: string, justification?: string }} InventoryScript
 * @typedef {{ href: string, sha256: string }} InventoryFile
 * @typedef {{ src: string, sha256: string }} InventoryScriptFile
 * @typedef {{
 *   file: string,
 *   path: string,
 *   paths: string[],
 *   payment: boolean,
 *   purpose: string,
 *   sha256: string,
 *   scripts: InventoryScript[],
 *   modulePreloads: InventoryFile[],
 *   firstPartyScripts: InventoryScriptFile[],
 *   stylesheets: InventoryFile[],
 *   headers: Record<string, string | null>,
 * }} InventoryPage
 * @typedef {{ format: string, version: number, description: string, pages: InventoryPage[] }} Inventory
 * @typedef {{ src: string, purpose: string, justification: string }} ThirdPartyScript
 * @typedef {{
 *   pages?: Readonly<Record<string, string>>,
 *   thirdParty?: Readonly<Record<string, ReadonlyArray<ThirdPartyScript>>>,
 *   paymentPages?: readonly string[],
 * }} InventoryRules
 */

/**
 * Reads a build folder into the inventory and the problems that keep it from being written.
 * @param {string} dir the build folder (dist/)
 * @param {InventoryRules} [rules] the reviewed lists (tests pass their own)
 * @returns {{ inventory: Inventory, problems: string[] }}
 */
export function createInventory(
  dir,
  { pages = PAGE_PURPOSES, thirdParty = THIRD_PARTY_SCRIPTS, paymentPages = PAYMENT_PAGES } = {},
) {
  const root = resolve(dir);
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, string>} */
  const hashes = new Map();
  const exists = (/** @type {string} */ file) =>
    !file.startsWith("../") && existsSync(join(root, file)) && statSync(join(root, file)).isFile();
  /** The SHA-256 of a build file, or null (and a problem) when it is not in the build. */
  const hashOf = (/** @type {string} */ file, /** @type {string} */ page) => {
    if (!exists(file)) {
      problems.push(`MISSING: ${page} references ${file}, which is not in the build`);
      return null;
    }
    if (!hashes.has(file)) {
      hashes.set(file, sha256(readFileSync(join(root, file))));
    }
    return hashes.get(file) ?? null;
  };

  const built = existsSync(root) ? htmlPages(root) : [];
  if (built.length === 0) {
    problems.push("NO PAGES: the folder has no HTML page; run `vite build` first");
  }
  for (const file of built.filter((page) => !Object.hasOwn(pages, page))) {
    problems.push(
      `UNLISTED PAGE: ${file} is not in PAGE_PURPOSES of scripts/payment-page-inventory.mjs; review its scripts, ` +
        "then list it with its purpose there and in README §10",
    );
  }
  for (const file of Object.keys(pages).filter((page) => !built.includes(page))) {
    problems.push(`MISSING PAGE: ${file} is in PAGE_PURPOSES but not in the build`);
  }

  /** @type {InventoryPage[]} */
  const entries = [];
  for (const file of built) {
    const html = readFileSync(join(root, file), "utf8");
    const allowed = thirdParty[file] ?? [];
    const entry = file.slice(0, -".html".length).split("/").join("-");
    /** @type {string[]} */
    const seenThirdParty = [];

    // The daily check (X-030) reads every <script> and <link> of the served page, comments included, so a commented-out
    // one would be an extra script there every day: the page must not have any.
    if ([...html.matchAll(HTML_COMMENT)].some(([comment]) => /<(?:script|link)\b/i.test(comment))) {
      problems.push(`COMMENTED MARKUP: ${file} has a <script> or <link> inside an HTML comment; remove it`);
    }

    /** @type {InventoryScript[]} */
    const scripts = [];
    for (const attrs of tags(html, "script")) {
      const src = attrs.src;
      if (!src) {
        problems.push(`INLINE SCRIPT: ${file} has a <script> without src (the CSP allows none)`);
        continue;
      }
      const local = localPath(src, file);
      if (local === null) {
        seenThirdParty.push(src);
        const listed = allowed.find((script) => script.src === src);
        if (!listed) {
          problems.push(
            `THIRD-PARTY SCRIPT: ${file} loads ${src}, which THIRD_PARTY_SCRIPTS does not list for it`,
          );
          continue;
        }
        scripts.push({
          src,
          firstParty: false,
          sha256: null,
          purpose: listed.purpose,
          justification: listed.justification,
        });
        continue;
      }
      // The page's own entry bundle: assets/<entry>-<8-character hash>.js (README §12).
      const bundle = `assets/${entry}-`;
      const own = local.startsWith(bundle) && /^[\w-]{8}\.js$/.test(local.slice(bundle.length));
      scripts.push({
        src,
        firstParty: true,
        sha256: hashOf(local, file),
        purpose: own
          ? `First-party entry bundle of this page: its page module (src/pages/${entry}.js) with the SDK and the lib/ ` +
            "and components/ code it imports, built from this repository" +
            (file === AIRLINE_CARD_PAGE
              ? " on its own, in one file that imports nothing (OADR-0017 points 1 and 2)"
              : "")
          : "First-party script of the storefront build",
      });
    }
    for (const listed of allowed.filter((script) => !seenThirdParty.includes(script.src))) {
      problems.push(
        `MISSING THIRD-PARTY SCRIPT: THIRD_PARTY_SCRIPTS lists ${listed.src} for ${file}, which does not load it`,
      );
    }

    const links = tags(html, "link");
    /** @param {(attrs: Record<string, string>) => boolean} test @param {string} kind */
    const linked = (test, kind) => {
      /** @type {InventoryFile[]} */
      const out = [];
      for (const attrs of links.filter(test)) {
        const href = attrs.href ?? "";
        const local = href ? localPath(href, file) : null;
        if (local === null) {
          problems.push(`THIRD-PARTY ${kind.toUpperCase()}: ${file} links ${href || "(no href)"}`);
          continue;
        }
        out.push({ href, sha256: hashOf(local, file) ?? "" });
      }
      return out;
    };
    const modulePreloads = linked((a) => /\bmodulepreload\b/i.test(a.rel ?? ""), "module preload");
    const stylesheets = linked((a) => /\bstylesheet\b/i.test(a.rel ?? ""), "stylesheet");

    // Every first-party script the page can run: its scripts and module preloads and, transitively, the chunks they
    // import (statically or dynamically), as scripts/check-budgets.mjs counts them.
    /** @type {Map<string, string>} */
    const closure = new Map();
    const queue = [
      ...scripts.filter((s) => s.firstParty).map((s) => localPath(s.src, file)),
      ...modulePreloads.map((p) => localPath(p.href, file)),
    ].filter((f) => f !== null);
    while (queue.length > 0) {
      const local = /** @type {string} */ (queue.shift());
      if (closure.has(local)) {
        continue;
      }
      const hash = hashOf(local, file);
      if (hash === null) {
        continue;
      }
      closure.set(local, hash);
      for (const spec of jsImports(readFileSync(join(root, local), "utf8"))) {
        const next = localPath(spec, local);
        if (next === null) {
          problems.push(`THIRD-PARTY IMPORT: ${local} (loaded by ${file}) imports ${spec}`);
        } else {
          queue.push(next);
        }
      }
    }

    const paths = pagePaths(file);
    entries.push({
      file,
      path: paths[0] ?? `/${file}`,
      paths,
      payment: paymentPages.includes(file),
      purpose: pages[file] ?? "",
      sha256: hashOf(file, file) ?? "",
      scripts,
      modulePreloads,
      firstPartyScripts: [...closure]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([local, hash]) => ({ src: `/${local}`, sha256: hash })),
      stylesheets,
      headers: expectedHeaders(file),
    });
  }
  for (const file of paymentPages.filter((page) => !built.includes(page))) {
    problems.push(`MISSING PAYMENT PAGE: ${file} is not in the build`);
  }

  return {
    inventory: {
      format: INVENTORY_FORMAT,
      version: INVENTORY_VERSION,
      description:
        "Every page of the hosted storefront build with its scripts, their SHA-256 and the security headers of its " +
        "paths (PCI DSS 6.4.3 and 11.6.1, ADR-0011 §C, OADR-0017 point 8); written by " +
        "ota/frontend/scripts/payment-page-inventory.mjs, format in ota/frontend/README.md §10.",
      pages: entries,
    },
    problems: [...new Set(problems)],
  };
}

/**
 * Writes `<dir>/payment-page-inventory.json` when the build has no problem; otherwise removes any copy there, so a
 * failed build never leaves an inventory behind for the daily check to trust.
 * @param {string} dir the build folder (dist/)
 * @param {InventoryRules} [rules]
 * @returns {ReturnType<typeof createInventory> & { file: string, written: boolean }}
 */
export function writeInventory(dir, rules) {
  const result = createInventory(dir, rules);
  const file = join(resolve(dir), INVENTORY_FILE);
  const written = result.problems.length === 0;
  if (written) {
    writeFileSync(file, `${JSON.stringify(result.inventory, null, 2)}\n`);
  } else {
    rmSync(file, { force: true });
  }
  return { ...result, file, written };
}

/**
 * The report: one line per page (payment flag, scripts, first-party files, third-party scripts), then the problems.
 * @param {ReturnType<typeof createInventory>} result
 */
export function formatReport({ inventory, problems }) {
  const header = ["Page", "Payment", "Scripts", "First-party JS", "Third-party"];
  const body = inventory.pages.map((page) => [
    page.path,
    page.payment ? "yes" : "",
    String(page.scripts.length),
    String(page.firstPartyScripts.length),
    page.scripts
      .filter((s) => !s.firstParty)
      .map((s) => s.src)
      .join(" "),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((cells) => (cells[i] ?? "").length)));
  const line = (/** @type {string[]} */ cells) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line), ...problems].join(
    "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { dir: { type: "string" } } });
  const dir = resolve(values.dir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist"));
  const result = writeInventory(dir);
  // The file below the working folder by its relative path (dist/payment-page-inventory.json), any other one in full.
  const below = relative(process.cwd(), result.file);
  const where = below.startsWith("..") || isAbsolute(below) ? result.file : toPosix(below);
  console.log(
    `payment-page-inventory: ${result.written ? `wrote ${where}` : `FAILED, no ${INVENTORY_FILE} written`}\n` +
      formatReport(result),
  );
  process.exitCode = result.written ? 0 : 1;
}
