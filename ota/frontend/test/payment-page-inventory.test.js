// @vitest-environment node
// The storefront's script inventory (OFE-023; ADR-0011 §C, PCI DSS 6.4.3 and 11.6.1; OADR-0017 point 8; README §10):
// scripts/payment-page-inventory.mjs on a production build of every page, compared with the build itself, with
// scripts/check-budgets.mjs, with deploy/caddy/Caddyfile and with README §10; and on fixture folders, where a
// third-party script or a page nobody reviewed fails it and leaves no inventory behind.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkBudgets } from "../scripts/check-budgets.mjs";
import {
  AIRLINE_CARD_PAGE,
  CARD_PAGE,
  INVENTORY_FILE,
  INVENTORY_FORMAT,
  INVENTORY_VERSION,
  PAGE_PURPOSES,
  PAYMENT_PAGES,
  STRIPE_JS_URL,
  THIRD_PARTY_SCRIPTS,
  createInventory,
  pagePaths,
  writeInventory,
} from "../scripts/payment-page-inventory.mjs";
import {
  REPO_ROOT,
  STOREFRONT_ROOT,
  buildStorefront,
  filesIn,
  removeScratch,
  scratchDir,
} from "./helpers/storefront.js";

const SCRIPT = join(STOREFRONT_ROOT, "scripts", "payment-page-inventory.mjs");
const CADDYFILE = join(REPO_ROOT, "deploy", "caddy", "Caddyfile");
const sha256 = (/** @type {Buffer | string} */ data) => createHash("sha256").update(data).digest("hex");

/** @type {string[]} */
const scratch = [];

/** A scratch build folder with these files (dist-relative path → content). */
function fixture(/** @type {Record<string, string>} */ files) {
  const dir = scratchDir("inventory");
  scratch.push(dir);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

/** The reviewed lists of the fixtures: two pages, the card page with Stripe.js. */
const FIXTURE_RULES = Object.freeze({
  pages: { "index.html": "Home", [CARD_PAGE]: "Card payment" },
  thirdParty: THIRD_PARTY_SCRIPTS,
  paymentPages: [CARD_PAGE],
});

/** A clean two-page build: a static and a dynamic import, a module preload, a stylesheet, Stripe.js on the card page. */
const FIXTURE = Object.freeze({
  "index.html":
    '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>' +
    '<link rel="modulepreload" crossorigin href="/assets/shared-BBBBBBBB.js">' +
    '<link rel="stylesheet" crossorigin href="/assets/main-CCCCCCCC.css">' +
    "<!-- The home page: a comment without markup. --></head><body></body></html>",
  "assets/index-AAAAAAAA.js":
    'import{a as e}from"./shared-BBBBBBBB.js";import("./lazy-DDDDDDDD.js").then(e);',
  "assets/shared-BBBBBBBB.js": "export const a=1;",
  "assets/lazy-DDDDDDDD.js": "export default 2;",
  "assets/main-CCCCCCCC.css": "body{margin:0}",
  [CARD_PAGE]:
    `<!doctype html><html><head><script src="${STRIPE_JS_URL}" defer></script>` +
    '<script type="module" crossorigin src="/assets/checkout-pay-card-EEEEEEEE.js"></script></head></html>',
  "assets/checkout-pay-card-EEEEEEEE.js": 'import"./shared-BBBBBBBB.js";',
});

/** @type {string | undefined} */
let dist;
/** @type {import("../scripts/payment-page-inventory.mjs").Inventory | undefined} */
let inventory;
/** @type {import("node:child_process").SpawnSyncReturns<string> | undefined} */
let cli;
/** @type {{ dir: string, run: import("node:child_process").SpawnSyncReturns<string> } | undefined} */
let failedCli;

// A production build of every page (`vite build` with the real vite.config.js: a few seconds alone, longer under the
// parallel pnpm test), then the script as the package's build runs it, in a Node process of its own, on that build
// and on a build with a third-party script: both in this hook with its own budget, the tests read the results.
beforeAll(async () => {
  dist = scratchDir("inventory-build");
  scratch.push(dist);
  await buildStorefront(dist);
  cli = spawnSync(process.execPath, [SCRIPT, "--dir", dist], { cwd: STOREFRONT_ROOT, encoding: "utf8" });
  if (cli.status !== 0) {
    // A page or a script nobody reviewed fails every test here, with the script's own report.
    throw new Error(`payment-page-inventory.mjs failed on the production build:\n${cli.stdout}${cli.stderr}`);
  }
  inventory = JSON.parse(readFileSync(join(dist, INVENTORY_FILE), "utf8"));

  const dir = fixture({
    ...Object.fromEntries(
      Object.keys(PAGE_PURPOSES).map((page) => [page, "<!doctype html><title>x</title>"]),
    ),
    "search.html": '<!doctype html><script src="https://cdn.example.net/tag.js"></script>',
    [INVENTORY_FILE]: '{"stale":true}\n',
  });
  failedCli = { dir, run: spawnSync(process.execPath, [SCRIPT, "--dir", dir], { encoding: "utf8" }) };
}, 60_000);

afterAll(() => {
  for (const dir of scratch) {
    removeScratch(dir);
  }
});

const pages = () =>
  /** @type {import("../scripts/payment-page-inventory.mjs").Inventory} */ (inventory).pages;
const page = (/** @type {string} */ file) => {
  const found = pages().find((entry) => entry.file === file);
  if (!found) {
    throw new Error(`${file} is not in the inventory`);
  }
  return found;
};

describe("the inventory of the production build", () => {
  it("[OFE-023 AC1] lists every built page, and only those, with its paths, purpose and HTML hash", () => {
    const out = /** @type {string} */ (dist);
    const built = filesIn(out).filter((file) => file.endsWith(".html"));

    expect(inventory?.format).toBe(INVENTORY_FORMAT);
    expect(inventory?.version).toBe(INVENTORY_VERSION);
    expect(pages().map((entry) => entry.file)).toEqual(built);
    expect(built).toEqual(Object.keys(PAGE_PURPOSES).sort());
    expect(built.length).toBeGreaterThanOrEqual(20);
    for (const entry of pages()) {
      expect(entry.purpose, entry.file).toBe(
        PAGE_PURPOSES[/** @type {keyof typeof PAGE_PURPOSES} */ (entry.file)],
      );
      expect(entry.sha256, entry.file).toBe(sha256(readFileSync(join(out, entry.file))));
      expect(entry.path, entry.file).toBe(entry.paths[0]);
      expect(entry.paths, entry.file).toEqual(pagePaths(entry.file));
    }
    expect(page("index.html").paths).toEqual(["/"]);
    expect(page("account/index.html").paths).toEqual(["/account/"]);
    expect(page("search.html").paths).toEqual(["/search.html"]);
    expect(page(CARD_PAGE).paths).toEqual(["/checkout/pay-card.html"]);
    expect(page(AIRLINE_CARD_PAGE).paths).toEqual(["/checkout/pay-airline.html", "/checkout/pay-airline"]);
  });

  it("[OFE-023 AC1] flags exactly the two payment pages payment: true", () => {
    expect(PAYMENT_PAGES).toEqual(["checkout/pay-card.html", "checkout/pay-airline.html"]);
    expect(
      pages()
        .filter((entry) => entry.payment)
        .map((entry) => entry.file),
    ).toEqual([AIRLINE_CARD_PAGE, CARD_PAGE]);
  });

  it("[OFE-023 AC1] the card page has exactly two scripts: Stripe.js by URL with its justification, and its bundle", () => {
    const card = page(CARD_PAGE);

    expect(card.scripts).toHaveLength(2);
    expect(card.scripts[0]).toEqual({
      src: STRIPE_JS_URL,
      firstParty: false,
      sha256: null,
      purpose: expect.stringMatching(/^Stripe\.js: .*Payment Element/),
      justification: expect.stringMatching(/js\.stripe\.com.*self-hosting/),
    });
    expect(card.scripts[1]).toEqual({
      src: expect.stringMatching(/^\/assets\/checkout-pay-card-[\w-]{8}\.js$/),
      firstParty: true,
      sha256: sha256(readFileSync(join(/** @type {string} */ (dist), card.scripts[1]?.src ?? ""))),
      purpose: expect.stringContaining("src/pages/checkout-pay-card.js"),
    });
    // Its shared chunks are module preloads of the page and hashed with its bundle.
    expect(card.modulePreloads.length).toBeGreaterThan(0);
    expect(card.firstPartyScripts.map((file) => file.src)).toEqual(
      expect.arrayContaining([card.scripts[1]?.src, ...card.modulePreloads.map((preload) => preload.href)]),
    );
  });

  it("[OFE-023 AC1] the airline-card page has exactly one script, its own bundle, which loads nothing else", () => {
    const airline = page(AIRLINE_CARD_PAGE);

    expect(airline.scripts).toEqual([
      {
        src: expect.stringMatching(/^\/assets\/checkout-pay-airline-[\w-]{8}\.js$/),
        firstParty: true,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        purpose: expect.stringContaining("OADR-0017"),
      },
    ]);
    expect(airline.modulePreloads).toEqual([]);
    expect(airline.firstPartyScripts).toEqual([
      { src: airline.scripts[0]?.src, sha256: airline.scripts[0]?.sha256 },
    ]);
    expect(airline.stylesheets).toEqual([
      {
        href: expect.stringMatching(/^\/assets\/checkout-pay-airline-[\w-]{8}\.css$/),
        sha256: expect.any(String),
      },
    ]);
  });

  it("[OFE-023 AC1] no page but the card page has a third-party script; every other script is a hashed build file", () => {
    const out = /** @type {string} */ (dist);
    const thirdParty = pages().flatMap((entry) =>
      entry.scripts.filter((script) => !script.firstParty).map((script) => `${entry.file} ${script.src}`),
    );
    expect(thirdParty).toEqual([`${CARD_PAGE} ${STRIPE_JS_URL}`]);

    for (const entry of pages()) {
      const firstParty = entry.scripts.filter((script) => script.firstParty);
      expect(firstParty.length, entry.file).toBeGreaterThan(0);
      for (const file of [...firstParty, ...entry.firstPartyScripts]) {
        expect(file.src, entry.file).toMatch(/^\/assets\/[\w-]+-[\w-]{8}\.js$/);
        expect(file.sha256, `${entry.file} ${file.src}`).toBe(sha256(readFileSync(join(out, file.src))));
      }
      for (const file of [...entry.modulePreloads, ...entry.stylesheets]) {
        expect(file.href, entry.file).toMatch(/^\/assets\/[\w-]+-[\w-]{8}\.(?:js|css)$/);
        expect(file.sha256, `${entry.file} ${file.href}`).toBe(sha256(readFileSync(join(out, file.href))));
      }
    }
  });

  it("[OFE-023 AC1] hashes every first-party script a page can run: the files scripts/check-budgets.mjs counts", () => {
    const budgets = checkBudgets(/** @type {string} */ (dist));
    for (const entry of pages()) {
      const row = budgets.rows.find((r) => r.page === entry.file && r.kind === "js");
      expect(
        entry.firstPartyScripts.map((file) => file.src.slice(1)),
        entry.file,
      ).toEqual((row?.files ?? []).map((file) => file.file).sort());
    }
  });

  it("[OFE-023 AC1] the headers of every path are the Caddyfile's: the storefront's, and the airline-card page's own", () => {
    const caddy = caddyHeaders(readFileSync(CADDYFILE, "utf8"));

    expect(page(AIRLINE_CARD_PAGE).paths).toEqual(caddy.payAirlinePaths);
    expect(headerDifferences(caddy, pages())).toEqual([]);
    // What the two payment pages must and must not send (OADR-0017 point 3).
    const card = page(CARD_PAGE).headers;
    expect(card["Content-Security-Policy"]).toContain("script-src 'self' https://js.stripe.com");
    expect(card["Cross-Origin-Opener-Policy"]).toBeNull();
    expect(card["Cache-Control"]).toBe("no-cache");
    const airline = page(AIRLINE_CARD_PAGE).headers;
    expect(airline["Content-Security-Policy"]).not.toMatch(/stripe/i);
    expect(airline["Content-Security-Policy"]).toContain("worker-src 'none'");
    expect(airline["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(airline["Cache-Control"]).toBe("no-store");
    expect(airline["Strict-Transport-Security"]).toBe("max-age=31536000");
    for (const entry of pages().filter((e) => e.file !== AIRLINE_CARD_PAGE)) {
      expect(entry.headers, entry.file).toEqual(card);
    }
  });

  it("[OFE-023 AC1] a header changed in the Caddyfile alone is a difference that names the page and the header", () => {
    const caddyfile = readFileSync(CADDYFILE, "utf8");
    const changed = caddyfile.replace(
      /^(\s*header @pay_airline \{\n\s*Content-Security-Policy "[^"]*)"/m,
      '$1; upgrade-insecure-requests"',
    );
    expect(changed).not.toBe(caddyfile);

    expect(headerDifferences(caddyHeaders(changed), pages())).toEqual([
      expect.stringMatching(
        /^\/checkout\/pay-airline\.html Content-Security-Policy: Caddyfile ".*upgrade-insecure/,
      ),
    ]);
    expect(() => caddyHeaders("(storefront) {\n}\n")).toThrow(/Caddyfile/);
  });

  it("[OFE-023 AC1] README §10 documents every page of the inventory with its purpose, and Stripe.js with its justification", () => {
    const readme = readFileSync(join(STOREFRONT_ROOT, "README.md"), "utf8");
    const start = readme.indexOf("\n## 10. Security");
    const section = readme.slice(start, readme.indexOf("\n## 11.", start));
    expect(start).toBeGreaterThan(0);

    expect(section).toContain(`\`dist/${INVENTORY_FILE}\``);
    expect(section).toContain(`\`storefront/${INVENTORY_FILE}\``);
    expect(section).toContain(STRIPE_JS_URL);
    expect(section).toMatch(/justification/i);
    // The page table: one row per page (`| \`<path>\` … | <purpose> | <scripts> |`), its purpose the one of
    // PAGE_PURPOSES (code spans and bold aside), its scripts naming the page's own bundle, and Stripe.js where it runs.
    const plain = (/** @type {string} */ cell) => cell.replace(/\*\*|`/g, "");
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("| `/"))
      .map((line) =>
        line
          .slice(1, -1)
          .split("|")
          .map((cell) => cell.trim()),
      );
    const pathOf = (/** @type {string[]} */ row) => /^`([^`]+)`/.exec(row[0] ?? "")?.[1];
    expect(rows.map(pathOf).sort()).toEqual(
      pages()
        .map((entry) => entry.path)
        .sort(),
    );
    for (const entry of pages()) {
      const row = rows.find((cells) => pathOf(cells) === entry.path) ?? [];
      const bundle = entry.scripts
        .filter((script) => script.firstParty)
        .map((script) => script.src.slice("/assets/".length).replace(/-[\w-]{8}\.js$/, "-<hash>.js"));
      expect(row, entry.file).toHaveLength(3);
      expect(plain(row[1] ?? ""), entry.file).toBe(entry.purpose);
      for (const name of bundle) {
        expect(row[2], entry.file).toContain(`\`${name}\``);
      }
      expect((row[2] ?? "").includes("Stripe.js"), entry.file).toBe(entry.scripts.some((s) => !s.firstParty));
    }
  });
});

describe("the build fails, writing no inventory, on a script or a page nobody reviewed", () => {
  it("[OFE-023 AC1] a clean build: every page, the static and dynamic imports hashed, a plain comment allowed", () => {
    const dir = fixture(FIXTURE);
    const result = writeInventory(dir, FIXTURE_RULES);

    expect(result.problems).toEqual([]);
    expect(result.written).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, INVENTORY_FILE), "utf8"))).toEqual(result.inventory);
    const [card, home] = result.inventory.pages;
    expect(home?.file).toBe("index.html");
    expect(home?.payment).toBe(false);
    expect(home?.scripts.map((s) => s.src)).toEqual(["/assets/index-AAAAAAAA.js"]);
    expect(home?.firstPartyScripts).toEqual([
      { src: "/assets/index-AAAAAAAA.js", sha256: sha256(FIXTURE["assets/index-AAAAAAAA.js"]) },
      { src: "/assets/lazy-DDDDDDDD.js", sha256: sha256(FIXTURE["assets/lazy-DDDDDDDD.js"]) },
      { src: "/assets/shared-BBBBBBBB.js", sha256: sha256(FIXTURE["assets/shared-BBBBBBBB.js"]) },
    ]);
    expect(home?.stylesheets).toEqual([
      { href: "/assets/main-CCCCCCCC.css", sha256: sha256(FIXTURE["assets/main-CCCCCCCC.css"]) },
    ]);
    expect(card?.file).toBe(CARD_PAGE);
    expect(card?.payment).toBe(true);
    expect(card?.scripts.map((s) => [s.src, s.firstParty])).toEqual([
      [STRIPE_JS_URL, false],
      ["/assets/checkout-pay-card-EEEEEEEE.js", true],
    ]);
  });

  it("[OFE-023 AC1] a third-party script on any page but the card page, or a second one there, fails", () => {
    const other = fixture({
      ...FIXTURE,
      "index.html": FIXTURE["index.html"].replace(
        "</head>",
        '<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></head>',
      ),
    });
    const second = fixture({
      ...FIXTURE,
      [CARD_PAGE]: FIXTURE[CARD_PAGE].replace(
        "</head>",
        '<script src="//cdn.example.net/chat.js"></script></head>',
      ),
    });

    const a = writeInventory(other, FIXTURE_RULES);
    expect(a.written).toBe(false);
    expect(a.problems).toEqual([
      "THIRD-PARTY SCRIPT: index.html loads https://www.googletagmanager.com/gtag/js?id=G-1, which " +
        "THIRD_PARTY_SCRIPTS does not list for it",
    ]);
    expect(existsSync(join(other, INVENTORY_FILE))).toBe(false);
    const b = writeInventory(second, FIXTURE_RULES);
    expect(b.written).toBe(false);
    expect(b.problems).toEqual([
      `THIRD-PARTY SCRIPT: ${CARD_PAGE} loads //cdn.example.net/chat.js, which THIRD_PARTY_SCRIPTS does not list for it`,
    ]);
  });

  it("[OFE-023 AC1] Stripe.js anywhere but the card page fails, as does the card page without it", () => {
    const moved = fixture({
      ...FIXTURE,
      "index.html": FIXTURE["index.html"].replace(
        "</head>",
        `<script src="${STRIPE_JS_URL}"></script></head>`,
      ),
      [CARD_PAGE]: FIXTURE[CARD_PAGE].replace(`<script src="${STRIPE_JS_URL}" defer></script>`, ""),
    });

    expect(createInventory(moved, FIXTURE_RULES).problems).toEqual([
      `MISSING THIRD-PARTY SCRIPT: THIRD_PARTY_SCRIPTS lists ${STRIPE_JS_URL} for ${CARD_PAGE}, which does not load it`,
      `THIRD-PARTY SCRIPT: index.html loads ${STRIPE_JS_URL}, which THIRD_PARTY_SCRIPTS does not list for it`,
    ]);
  });

  it("[OFE-023 AC1] third-party code through a module preload, a stylesheet or a chunk's import fails too", () => {
    const dir = fixture({
      ...FIXTURE,
      "index.html": FIXTURE["index.html"].replace(
        "</head>",
        '<link rel="modulepreload" href="https://cdn.example.net/m.js">' +
          '<link rel="stylesheet" href="https://fonts.example.net/f.css"></head>',
      ),
      // Whatever the URL ends with: a module of another origin need not be named *.js.
      "assets/lazy-DDDDDDDD.js":
        'import"https://cdn.example.net/x.js";import("HTTPS://cdn.example.net/y");' +
        'export*from"//cdn.example.net/z.mjs?v=1";export default 2;',
    });

    expect(createInventory(dir, FIXTURE_RULES).problems).toEqual([
      "THIRD-PARTY MODULE PRELOAD: index.html links https://cdn.example.net/m.js",
      "THIRD-PARTY STYLESHEET: index.html links https://fonts.example.net/f.css",
      "THIRD-PARTY IMPORT: assets/lazy-DDDDDDDD.js (loaded by index.html) imports https://cdn.example.net/x.js",
      "THIRD-PARTY IMPORT: assets/lazy-DDDDDDDD.js (loaded by index.html) imports HTTPS://cdn.example.net/y",
      "THIRD-PARTY IMPORT: assets/lazy-DDDDDDDD.js (loaded by index.html) imports //cdn.example.net/z.mjs?v=1",
    ]);
  });

  it("[OFE-023 AC1] a comment hides no script: <!-->, <!---> and --!> end it, and a commented <script> or <link> fails", () => {
    // The HTML standard ends `<!-->` and `<!--->` at once, and any comment at `--!>`: the scripts after them run. A
    // <script> or <link> inside a real comment runs nothing, but X-030's check reads it as markup of the page, so it
    // would be an extra script there every day: the build refuses it.
    const dir = fixture({
      ...FIXTURE,
      "index.html": FIXTURE["index.html"].replace(
        "</head>",
        '<!--><script src="https://a.example.net/1.js"></script>' +
          '<!---><script src="https://a.example.net/2.js"></script>' +
          '<!-- x --!><script src="https://a.example.net/3.js"></script>' +
          '<!-- <script src="https://a.example.net/hidden.js"></script> --></head>',
      ),
      [CARD_PAGE]: FIXTURE[CARD_PAGE].replace(
        "</head>",
        '<!--\n<LINK rel="modulepreload" href="/assets/shared-BBBBBBBB.js">\n--></head>',
      ),
    });

    expect(createInventory(dir, FIXTURE_RULES).problems).toEqual([
      `COMMENTED MARKUP: ${CARD_PAGE} has a <script> or <link> inside an HTML comment; remove it`,
      "COMMENTED MARKUP: index.html has a <script> or <link> inside an HTML comment; remove it",
      ...[1, 2, 3].map(
        (n) =>
          `THIRD-PARTY SCRIPT: index.html loads https://a.example.net/${n}.js, which THIRD_PARTY_SCRIPTS does not list for it`,
      ),
    ]);
  });

  it("[OFE-023 AC1] an inline script or a file missing from the build fails", () => {
    const dir = fixture({
      ...FIXTURE,
      "index.html": FIXTURE["index.html"].replace("</head>", "<script>alert(1)</script></head>"),
      [CARD_PAGE]: FIXTURE[CARD_PAGE].replace("checkout-pay-card-EEEEEEEE", "checkout-pay-card-FFFFFFFF"),
    });

    expect(createInventory(dir, FIXTURE_RULES).problems).toEqual([
      `MISSING: ${CARD_PAGE} references assets/checkout-pay-card-FFFFFFFF.js, which is not in the build`,
      "INLINE SCRIPT: index.html has a <script> without src (the CSP allows none)",
    ]);
  });

  it("[OFE-023 AC1] a page that is not in the reviewed list fails, as does a listed page missing from the build", () => {
    const dir = fixture({ ...FIXTURE, "promo/landing.html": "<!doctype html><title>Promo</title>" });
    const result = writeInventory(dir, {
      ...FIXTURE_RULES,
      pages: { ...FIXTURE_RULES.pages, "lookup.html": "x" },
    });

    expect(result.written).toBe(false);
    expect(result.problems).toEqual([
      "UNLISTED PAGE: promo/landing.html is not in PAGE_PURPOSES of scripts/payment-page-inventory.mjs; review " +
        "its scripts, then list it with its purpose there and in README §10",
      "MISSING PAGE: lookup.html is in PAGE_PURPOSES but not in the build",
    ]);
    // With the real lists, a page the storefront does not have is unlisted too, and an empty folder has no pages.
    expect(createInventory(dir).problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/^UNLISTED PAGE: promo\/landing\.html /)]),
    );
    expect(createInventory(fixture({})).problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/^NO PAGES: /)]),
    );
  });

  it("[OFE-023 AC1] the real lists: every payment page is a reviewed page, Stripe.js is listed for the card page only", () => {
    for (const file of PAYMENT_PAGES) {
      expect(Object.keys(PAGE_PURPOSES), file).toContain(file);
    }
    expect(Object.keys(THIRD_PARTY_SCRIPTS)).toEqual([CARD_PAGE]);
    expect(THIRD_PARTY_SCRIPTS[CARD_PAGE]?.map((script) => script.src)).toEqual([STRIPE_JS_URL]);
  });
});

describe("the file in the release artefact", () => {
  it("[OFE-023 AC2] the package's build writes dist/payment-page-inventory.json after vite build", () => {
    const pkg = JSON.parse(readFileSync(join(STOREFRONT_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.build).toBe(
      "vite build && node scripts/payment-page-inventory.mjs && node scripts/check-budgets.mjs",
    );

    // The command line as the build runs it: the inventory next to the pages, which the release carries as
    // storefront/ (deploy/scripts/pack-release.sh copies dist/), and a report of every page.
    expect(cli?.status, cli?.stderr).toBe(0);
    expect(cli?.stdout).toContain(
      `payment-page-inventory: wrote ${join(/** @type {string} */ (dist), INVENTORY_FILE)}`,
    );
    expect(cli?.stdout).toMatch(
      /^\/checkout\/pay-card\.html +yes +2 +\d+ +https:\/\/js\.stripe\.com\/v3\/$/m,
    );
    expect(cli?.stdout).toMatch(/^\/checkout\/pay-airline\.html +yes +1 +1$/m);
    expect(filesIn(/** @type {string} */ (dist))).toContain(INVENTORY_FILE);
    expect(inventory).toEqual(createInventory(/** @type {string} */ (dist)).inventory);
  });

  it("[OFE-023 AC2] the build fails and removes a stale inventory when a page breaks a rule", () => {
    const run = failedCli?.run;
    expect(run?.status).toBe(1);
    expect(run?.stdout).toContain(`payment-page-inventory: FAILED, no ${INVENTORY_FILE} written`);
    expect(run?.stdout).toContain(
      "THIRD-PARTY SCRIPT: search.html loads https://cdn.example.net/tag.js, which THIRD_PARTY_SCRIPTS does not list",
    );
    expect(existsSync(join(/** @type {string} */ (failedCli?.dir), INVENTORY_FILE))).toBe(false);
  });
});

/**
 * The headers the Caddyfile sends on storefront pages: the `header { … }` block of `(storefront_headers)` (a value
 * per header; a removed header, `-Name`, as null), the file server's `header @not_hashed Cache-Control`, and the
 * paths and headers of the airline-card page's `@pay_airline` matcher and block. Throws when one is missing, so the
 * comparison never passes by reading nothing.
 * @param {string} caddyfile
 */
function caddyHeaders(caddyfile) {
  const storefront = caddyfile.match(/^\(storefront_headers\)\s*\{\n\s*header\s*\{\n([\s\S]*?)\n\s*\}\n\}/m);
  const noCache = caddyfile.match(/^\s*header @not_hashed Cache-Control "([^"]*)"$/m);
  const matcher = caddyfile.match(/^\s*@pay_airline\s+path\s+(.+)$/m);
  const airline = caddyfile.match(/^\s*header\s+@pay_airline\s*\{\n([\s\S]*?)\n\s*\}/m);
  if (!storefront || !noCache || !matcher || !airline) {
    throw new Error(
      "Caddyfile: no (storefront_headers) block, @not_hashed Cache-Control or @pay_airline block",
    );
  }
  const read = (/** @type {string} */ block) => {
    /** @type {Record<string, string | null>} */
    const headers = {};
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      const set = line.match(/^([A-Za-z0-9-]+)\s+"((?:[^"\\]|\\.)*)"$/);
      const removed = line.match(/^-([A-Za-z0-9-]+)$/);
      if (set) {
        headers[set[1] ?? ""] = (set[2] ?? "").replace(/\\(.)/g, "$1");
      } else if (removed) {
        headers[removed[1] ?? ""] = null;
      } else if (line !== "" && line !== "defer" && !line.startsWith("#")) {
        throw new Error(`Caddyfile: cannot read the header line ${JSON.stringify(line)}`);
      }
    }
    return headers;
  };
  const page = { ...read(storefront[1] ?? ""), "Cache-Control": noCache[1] ?? "" };
  return {
    page,
    payAirline: { ...page, ...read(airline[1] ?? "") },
    payAirlinePaths: (matcher[1] ?? "").trim().split(/\s+/),
  };
}

/**
 * Differences between the headers of each page of the inventory and the Caddyfile's, one line per path and header.
 * @param {ReturnType<typeof caddyHeaders>} caddy
 * @param {import("../scripts/payment-page-inventory.mjs").InventoryPage[]} entries
 */
function headerDifferences(caddy, entries) {
  const out = [];
  for (const entry of entries) {
    const expected = entry.file === AIRLINE_CARD_PAGE ? caddy.payAirline : caddy.page;
    const names = new Set([...Object.keys(expected), ...Object.keys(entry.headers)]);
    for (const name of [...names].filter((n) => expected[n] !== entry.headers[n])) {
      out.push(
        `${entry.path} ${name}: Caddyfile ${JSON.stringify(expected[name])}, inventory ` +
          JSON.stringify(entry.headers[name]),
      );
    }
  }
  return out;
}
