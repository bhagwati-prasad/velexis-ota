// The content pages of the hosted storefront (OFE-020; ota/frontend/docs/pages-account.md §7, OADR-0015 point 4,
// OADR-0012 point 5), in the `storefront` project: the production build in `vite preview`, whose Caddy-like routing
// serves `/p/<slug>` with p.html (as `rewrite /p/* /p.html` does in deploy/caddy/Caddyfile), under the storefront
// guards (CSP, first-party requests only, cookies, axe).
//
//   a published page and a draft of the journey's OTA → /p/<slug> shows the page's title and blocks, built in the
//   browser from storefront.getPage → the footer lists the page (storefront.listPages, showInFooter) and marks it as the
//   current page → the draft's address shows the not-found content with noindex
//
// Arranged through public APIs only (PADR-0017 item 5; FIX-W46-OTA, lead decision (11l) of 2026-11-06): an OTA of the
// journey's own (`newOwnerWithActiveOta`), whose owner signs in to its console as a custom console's server does
// (`signInStaffWithApi` of support/ota.ts: createApiKey for a test secret key scoped `console`, createConsoleToken,
// console.auth.signIn) and creates the two pages with console.settings.pages.create; the OTA admin's page editor is
// OAD-015's, which settings-effects.e2e.ts drives. The demo OTA has no staff member to sign in (dev:seed creates its
// rows without one, and its console key holds `amadeus:read` only), so its pages are out of the API's reach; an OTA of
// its own also leaves the footer of the demo OTA, which every other storefront journey shows, as it is. The preview
// serves the demo OTA's host, so each test's context sends the `/api/*` requests of the preview's pages to the OTA API
// as the journey OTA's storefront edge (`serveStorefrontOf`), as Caddy does in front of the OTA's host. No other
// journey reads that OTA's pages, and the console's change deletes the API's pages cache itself after its commit, so
// the journey writes nothing to a tenant schema or to Redis.
import { randomBytes } from "node:crypto";
import type { components } from "@velexis/api-types";
import { uniqueTestIp } from "../../support/fixtures";
import {
  EdgeApi,
  newOwnerWithActiveOta,
  serveStorefrontOf,
  signInStaffWithApi,
  type OwnedOta,
} from "../../support/ota";
import { expect, test } from "../../support/storefront-guards";

type PageInput = components["schemas"]["StorefrontPageInput"];

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

/** The journey's two pages, in the OTA's default locale: one published in the footer, one draft. */
const PAGES: readonly Omit<PageInput, "locale">[] = [
  {
    slug: PAGE_SLUG,
    kind: "about",
    title: PAGE_TITLE,
    bodyMarkdown: PAGE_BODY,
    isPublished: true,
    showInFooter: true,
    sortOrder: 5,
  },
  {
    slug: DRAFT_SLUG,
    kind: "content",
    title: `Draft ${RUN}`,
    bodyMarkdown: "Not published yet.",
    isPublished: false,
    showInFooter: true,
    sortOrder: 6,
  },
];

let owned: OwnedOta;

test.beforeAll(async () => {
  // Budget: a sign-up with its verification e-mail (up to 15 s), the OTA's set-up on the OTA worker (about 2 s locally;
  // PF-11 allows a minute) and six API calls of a second at most.
  test.setTimeout(120_000);
  owned = await newOwnerWithActiveOta("Paula Pages", "pag");
  // The OTA's default locale, as storefront.get gives it to its storefront.
  const storefront = (await new EdgeApi(owned.storefrontHost, uniqueTestIp()).call(
    "storefront.get",
    "GET",
    "/v1/storefront",
  )) as { defaultLocale?: unknown } | undefined;
  const locale = storefront?.defaultLocale;
  if (typeof locale !== "string") {
    throw new Error("storefront.get answered without a defaultLocale");
  }
  const staff = await signInStaffWithApi(owned);
  for (const page of PAGES) {
    const input: PageInput = { ...page, locale };
    await staff.call("consoleCreateStorefrontPage", "POST", "/v1/console/settings/pages", input, 201);
  }
});

test("[OFE-020 AC2] /p/<slug> shows the published page, built from its blocks, and the footer lists it", async ({
  context,
  page,
  guards,
}) => {
  await serveStorefrontOf(context, owned.storefrontHost);
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
  context,
  page,
  guards,
}) => {
  await serveStorefrontOf(context, owned.storefrontHost);
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
