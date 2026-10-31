// The content pages of the hosted storefront (OFE-020; ota/frontend/docs/pages-account.md §7, OADR-0015 point 4,
// OADR-0012 point 5), in the `storefront` project: the production build in `vite preview`, whose Caddy-like routing
// serves `/p/<slug>` with p.html (as `rewrite /p/* /p.html` does in deploy/caddy/Caddyfile), proxied to the OTA API for
// the demo OTA, under the storefront guards (CSP, first-party requests only, cookies, axe).
//
//   a published page and a draft of the demo OTA → /p/<slug> shows the page's title and blocks, built in the browser
//   from storefront.getPage → the footer lists the page (storefront.listPages, showInFooter) and marks it as the
//   current page → the draft's address shows the not-found content with noindex
//
// The OTA admin's page editor is OAD-015's; this journey writes the two rows of `storefront_pages` straight into the
// demo OTA's schema through `tenantTx` (support/ota.ts `withTenantTx`, as velexis_ota_app), with slugs of its own, drops
// the API's pages cache of the demo OTA (`t:<tenantId>:test:pages:<locale>`, as a console page change does) and
// removes both rows again at the end, so the other journeys' footers are as before. Other journeys run in parallel and
// every storefront page asks storefront.listPages, so a list that another request read before the insert can land in
// the cache after the drop (ota/backend/src/storefront/public-pages.service.ts); the cache is therefore dropped again
// until the API's list shows the change, as support/ota.ts `enableAirlineCard` does for storefront.get.
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { DEMO_TENANT_SCHEMA, demoTenantId, withTenantTx } from "../../support/ota";
import { stack } from "../../support/seed";
import { STOREFRONT_URL } from "../../support/stack";
import { expect, test } from "../../support/storefront-guards";

/** A suffix no other run uses: lower-case letters and digits, as a slug allows. */
const RUN = randomBytes(5).toString("hex");
const PAGE_SLUG = `e2e-about-${RUN}`;
const DRAFT_SLUG = `e2e-draft-${RUN}`;
const PAGE_TITLE = `About Demo Travel ${RUN}`;
/** The page body in the Markdown subset (OADR-0012 point 5): a heading, emphasis, a list and links. */
const PAGE_BODY = [
  "## Who we are",
  "",
  "We are a **small team** of *travel* experts. Read our [privacy policy](/p/privacy) or write to [our team](mailto:help@demo-travel.example).",
  "",
  "- Flights to every continent",
  "- Help from real people",
  "",
  "More about fares on [the airline's site](https://www.example.org/fares).",
].join("\n");

/** A page id as the API writes it: `stp_` and 26 letters and digits. */
const pageId = (): string => `stp_${randomBytes(13).toString("hex").toUpperCase()}`;
/** How long the API may take to list a page change (each poll drops a list filled meanwhile from the old rows). */
const PAGES_CHANGE_WAIT_MS = 10_000;

/** Deletes the demo OTA's pages cache of the test environment (every locale) on the stack's Redis. */
async function dropPagesCache(tenantId: string): Promise<void> {
  const redis = new Redis(stack().redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `t:${tenantId}:test:pages:*`, "COUNT", 100);
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } finally {
    redis.disconnect();
  }
}

/** Whether storefront.listPages, asked through the preview as the storefront edge, lists the journey's page now. */
async function listsJourneyPage(): Promise<boolean> {
  const answer = await fetch(`${STOREFRONT_URL}/api/v1/storefront/pages`, {
    headers: { accept: "application/json" },
  });
  if (!answer.ok) {
    return false;
  }
  const list = (await answer.json()) as { data?: Array<{ slug?: unknown }> };
  return Array.isArray(list.data) && list.data.some((page) => page.slug === PAGE_SLUG);
}

/**
 * Drops the pages cache until storefront.listPages lists the journey's page (`listed`) or no longer does: each poll
 * drops first, so a list that another journey's request filled from the old rows meanwhile goes too.
 */
async function waitForPagesCache(listed: boolean): Promise<void> {
  await expect
    .poll(
      async () => {
        await dropPagesCache(tenantId);
        return await listsJourneyPage();
      },
      { timeout: PAGES_CHANGE_WAIT_MS },
    )
    .toBe(listed);
}

let tenantId = "";

test.beforeAll(async () => {
  tenantId = await demoTenantId();
  await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    const settings = await trx.selectFrom("storefront_settings").select("default_locale").executeTakeFirst();
    const locale = settings?.default_locale ?? "en";
    await trx
      .insertInto("storefront_pages")
      .values([
        {
          id: pageId(),
          slug: PAGE_SLUG,
          locale,
          kind: "about",
          title: PAGE_TITLE,
          body_markdown: PAGE_BODY,
          is_published: true,
          show_in_footer: true,
          sort_order: 5,
          published_at: new Date(),
        },
        {
          id: pageId(),
          slug: DRAFT_SLUG,
          locale,
          kind: "content",
          title: `Draft ${RUN}`,
          body_markdown: "Not published yet.",
          is_published: false,
          show_in_footer: true,
          sort_order: 6,
          published_at: null,
        },
      ])
      .execute();
  });
  await waitForPagesCache(true);
});

test.afterAll(async () => {
  await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    await trx.deleteFrom("storefront_pages").where("slug", "in", [PAGE_SLUG, DRAFT_SLUG]).execute();
  });
  await waitForPagesCache(false);
});

test("[OFE-020 AC2] /p/<slug> shows the published page, built from its blocks, and the footer lists it", async ({
  page,
  guards,
}) => {
  const response = await page.goto(`/p/${PAGE_SLUG}`);
  expect(response?.status()).toBe(200);

  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: PAGE_TITLE })).toBeVisible();
  await expect(page).toHaveTitle(PAGE_TITLE);
  await expect(main.getByRole("heading", { level: 2, name: "Who we are" })).toBeVisible();
  await expect(main.locator("strong", { hasText: "small team" })).toBeVisible();
  await expect(main.getByRole("listitem")).toHaveText([
    "Flights to every continent",
    "Help from real people",
  ]);
  await expect(main.getByRole("link", { name: "privacy policy" })).toHaveAttribute("href", "/p/privacy");
  await expect(main.getByRole("link", { name: "our team" })).toHaveAttribute(
    "href",
    "mailto:help@demo-travel.example",
  );
  const external = main.getByRole("link", { name: "the airline's site" });
  await expect(external).toHaveAttribute("href", "https://www.example.org/fares");
  await expect(external).toHaveAttribute("rel", "noopener noreferrer");

  // The footer lists the published page with showInFooter (never the draft) and marks it as the page shown.
  const footer = page.getByRole("contentinfo");
  const footerLink = footer.getByRole("link", { name: PAGE_TITLE });
  await expect(footerLink).toHaveAttribute("href", `/p/${PAGE_SLUG}`);
  await expect(footerLink).toHaveAttribute("aria-current", "page");
  await expect(footer.getByRole("link", { name: `Draft ${RUN}` })).toHaveCount(0);

  await guards.checkA11y(page);
});

test("[OFE-020 AC2] a page that is not published shows the not-found content with noindex", async ({
  page,
  guards,
}) => {
  const response = await page.goto(`/p/${DRAFT_SLUG}`);
  // The HTML is static, so the status stays 200; the page shows the 404 content and adds noindex.
  expect(response?.status()).toBe(200);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Search flights" })).toHaveAttribute("href", "/");
  await expect(page).toHaveTitle("Page not found");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  // The footer still lists the published page.
  await expect(page.getByRole("contentinfo").getByRole("link", { name: PAGE_TITLE })).toHaveAttribute(
    "href",
    `/p/${PAGE_SLUG}`,
  );
  await guards.checkA11y(page);
});
