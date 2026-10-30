// The storefront settings (OAD-014) against the fake OTA API (OADR-0018 point 10): the real server actions,
// `requireStaff`, `getConsoleRequest` and the SDK, with the SDK's `fetch` answered by src/test/fake-ota-api.ts. Each
// action's exact request (method, path, `If-Match`, `X-Velexis-Environment`, the one section of the body), the state it
// answers (the API's warnings, its refusals on their fields) and the page it revalidates; the page as Next.js renders
// it on the server (rendered to HTML and queried in a detached happy-dom document: what each role is offered, the
// pickers' images by kind, the contrast warning, the API's codes handled on the server); and every form the page
// renders posted as it is to its real action, so the page, the sections and the actions agree on every field. Next.js's
// request scope (`cookies()`, `headers()`), `redirect()` and `revalidatePath()` are mocked. Every token, id and name
// here is a dummy.
import type { StaffRole, StorefrontAsset, StorefrontSettings } from "@velexis/ota-sdk";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  apiError,
  fakeOtaApi,
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
  type SentRequest,
} from "@/test/fake-ota-api";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/cache", () => nextCache);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/settings/storefront",
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    redirect: fakeRedirect,
  };
});

import { INITIAL_ACTION_STATE, type ActionState } from "@/lib/action-state";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import {
  saveAirlineCard,
  saveBrand,
  saveBranding,
  saveConsent,
  saveCurrencies,
  saveFeatures,
  saveLegal,
  saveLocales,
  saveMarkets,
  saveOperations,
  savePolicies,
  saveSeo,
  saveSupport,
} from "./actions";
import StorefrontSettingsPage from "./page";
import type { SettingsActionState, SettingsSection } from "./settings-rules";

const ME = "GET /v1/console/auth/me";
const SETTINGS = "/v1/console/settings/storefront";
const ASSETS = "/v1/console/settings/assets";
const LOGO_ID = "ast_01JA6B2C3D4E5F6G7H8J9K0M1N";
const OTHER_LOGO_ID = "ast_01JA6B2C3D4E5F6G7H8J9K0M9Z";
const FAVICON_ID = "ast_01JA6B2C3D4E5F6G7H8J9K0M3Q";
const OG_IMAGE_ID = "ast_01JA6B2C3D4E5F6G7H8J9K0M4R";

const ACTIONS: Readonly<
  Record<SettingsSection, (state: ActionState, form: FormData) => Promise<ActionState>>
> = {
  brand: saveBrand,
  branding: saveBranding,
  locales: saveLocales,
  currencies: saveCurrencies,
  markets: saveMarkets,
  features: saveFeatures,
  policies: savePolicies,
  airlineCard: saveAirlineCard,
  legal: saveLegal,
  support: saveSupport,
  seo: saveSeo,
  consent: saveConsent,
  operations: saveOperations,
};

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member of `role` whose switch says `environment`. */
function signedIn(role: StaffRole = "owner", environment: "test" | "live" = "test"): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`storefront-settings-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-storefront-settings-${sequence}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
  api.on(ME, () => Response.json(staffProfile({ role }), { headers: { "X-Request-Id": "req_me" } }));
}

/** The storefront settings as the API answers them. */
function storefrontSettings(): StorefrontSettings {
  return {
    brand: { name: "Demo Travel", legalName: "Demo Travel AS", timeZone: "Europe/Oslo" },
    branding: {
      logoAssetId: LOGO_ID,
      logoDarkAssetId: null,
      logoSquareAssetId: null,
      faviconAssetId: FAVICON_ID,
      colors: {
        primary: "#0B5FFF",
        secondary: "#0F172A",
        accent: "#B45309",
        background: "#FFFFFF",
        text: "#111827",
      },
      fonts: { heading: "Montserrat", body: "Inter" },
      cornerRadius: "medium",
    },
    locales: { default: "en", supported: ["en", "nb", "fr-CA"] },
    currencies: { default: "EUR", supported: ["EUR", "NOK"] },
    markets: {
      default: "NO",
      list: [
        { countryCode: "NO", name: "Norway", currency: "NOK", locale: "nb" },
        { countryCode: "FR", name: "France", currency: "EUR", locale: "en" },
      ],
    },
    features: {
      guestCheckout: true,
      customerAccounts: true,
      ancillaries: false,
      brandedFareUpsell: true,
      selfServiceCancellation: false,
    },
    policies: {
      ticketingPolicy: "issue_after_payment",
      paymentTiming: "authorize_before_booking",
      require3ds: true,
      acceptedCardBrands: ["VISA", "MASTERCARD"],
      requireEmailVerification: false,
      offerTtlMinutes: 30,
      checkoutTtlMinutes: 60,
    },
    airlineCard: { enabledTest: true, enabledLive: false },
    legal: {
      termsVersion: "2026-10",
      privacyVersion: null,
      links: [
        { kind: "terms", label: "Terms and conditions", pageSlug: "terms" },
        { kind: "privacy", label: "Privacy", url: "https://demo.example.com/privacy" },
      ],
    },
    support: {
      email: "support@demo.example.com",
      phone: "+4722334455",
      hours: "Monday to Friday, 9 to 17",
      helpCenterUrl: "https://help.demo.example.com",
      emergencyPhone: null,
    },
    seo: {
      titleTemplate: "%s | Demo Travel",
      defaultTitle: "Demo Travel",
      defaultDescription: "Flights from Oslo.",
      ogImageAssetId: null,
      robots: { index: true, follow: true },
    },
    consent: {
      regime: "gdpr",
      bannerRequired: true,
      policyVersion: "1",
      categories: [
        {
          id: "necessary",
          required: true,
          defaultEnabled: true,
          title: "Necessary",
          description: "Search, booking and sign-in.",
        },
        {
          id: "analytics",
          required: false,
          defaultEnabled: false,
          title: "Analytics",
          description: "How the site is used.",
        },
      ],
    },
    operations: { opsAlertEmail: "ops@demo.example.com", bookingQueue: { number: 50, category: 0 } },
    version: 12,
    updatedAt: "2026-10-29T10:00:00Z",
  };
}

/** An uploaded image of `kind`. */
function asset(id: string, kind: StorefrontAsset["kind"], fileName: string): StorefrontAsset {
  return {
    id,
    kind,
    contentType: kind === "favicon" ? "image/x-icon" : "image/png",
    sizeBytes: 48_213,
    width: 640,
    height: 160,
    fileName,
    url: `https://api.ota.example.com/v1/assets/demo/${id}.png`,
    createdAt: "2026-10-12T10:05:00Z",
  };
}

const ASSETS_BY_KIND: Readonly<Record<string, readonly StorefrontAsset[]>> = {
  logo: [asset(LOGO_ID, "logo", "demo-logo.png"), asset(OTHER_LOGO_ID, "logo", "demo-logo-2027.png")],
  favicon: [asset(FAVICON_ID, "favicon", "favicon.ico")],
  og_image: [asset(OG_IMAGE_ID, "og_image", "share.png")],
};

/** The fake API's settings, images and update. */
function serveSettings(settings: StorefrontSettings = storefrontSettings()): void {
  api.on(`GET ${SETTINGS}`, () =>
    Response.json(settings, { headers: { ETag: `"${settings.version}"`, "X-Request-Id": "req_get" } }),
  );
  api.on(`GET ${ASSETS}`, (request) =>
    Response.json(
      {
        data: ASSETS_BY_KIND[request.url.searchParams.get("kind") ?? ""] ?? [],
        page: { nextCursor: null, limit: 100 },
      },
      { headers: { "X-Request-Id": "req_assets" } },
    ),
  );
}

/** The update's answer: the settings with `body`'s sections, a new version and `warnings`. */
function serveUpdate(warnings: readonly Record<string, unknown>[] = []): void {
  api.on(`PATCH ${SETTINGS}`, (request) => {
    const saved = { ...storefrontSettings(), ...(request.body as object), version: 13 };
    return Response.json({ ...saved, warnings }, { headers: { ETag: '"13"', "X-Request-Id": "req_update" } });
  });
}

/** A form of fields (a list value repeats the field, as checkboxes post). */
function formOf(fields: Readonly<Record<string, string | readonly string[]>>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === "string" ? [value] : value) {
      form.append(name, item);
    }
  }
  return form;
}

/** The one request of `route`, failing the test when there is not exactly one. */
function only(route: string): SentRequest {
  const sent = api.sent(route);
  expect(sent, route).toHaveLength(1);
  return sent[0] as SentRequest;
}

/** The requests besides `console.auth.me`. */
function actionRequests(): SentRequest[] {
  return api.requests.filter((request) => `${request.method} ${request.url.pathname}` !== ME);
}

/** The paths the actions revalidated. */
function revalidated(): string[] {
  return nextCache.revalidatePath.mock.calls.map(([path]) => String(path));
}

const run = (
  action: (state: ActionState, form: FormData) => Promise<ActionState>,
  form: FormData,
): Promise<SettingsActionState> => action(INITIAL_ACTION_STATE, form) as Promise<SettingsActionState>;

/** The page rendered on the server, in a detached document. */
async function renderPage(search: Record<string, string> = {}): Promise<HTMLElement> {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(
    await StorefrontSettingsPage({ searchParams: Promise.resolve(search) }),
  );
  return document.body as unknown as HTMLElement;
}

/** The form of a section in the rendered page. */
function sectionForm(page: HTMLElement, section: SettingsSection): HTMLFormElement {
  const form = page.querySelector<HTMLFormElement>(`form[data-section="${section}"]`);
  if (form === null) {
    throw new Error(`no form of ${section}`);
  }
  return form;
}

/** The fields a rendered form posts, as a Node `FormData` (happy-dom reads the inputs as a browser would). */
function formDataOf(form: HTMLFormElement): FormData {
  // happy-dom 17 selects the option before the one marked `selected` when it parses server-rendered HTML; a browser
  // selects the marked one, so the select is set to it first.
  for (const select of form.querySelectorAll("select")) {
    const marked = select.querySelector<HTMLOptionElement>("option[selected]");
    if (marked !== null) {
      select.value = marked.value;
    }
  }
  const window = form.ownerDocument.defaultView as unknown as { FormData: new (form: unknown) => FormData };
  const posted = new FormData();
  for (const [name, value] of new window.FormData(form).entries()) {
    posted.append(name, String(value));
  }
  return posted;
}

// Once per file: the first server render, the first SDK call and the first Zod parse of a fresh worker are the
// slowest; on a busy CI runner they would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn("owner");
  serveSettings();
  serveUpdate();
  const page = await renderPage();
  await run(saveBranding, formDataOf(sectionForm(page, "branding")));
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(
    new Headers({ "User-Agent": "Mozilla/5.0 Test", "X-Forwarded-For": "203.0.113.7" }),
  );
  nextCache.revalidatePath.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- The actions ------------------------------------------------------------------------------------------------

describe("the section actions", () => {
  it("[OAD-014] saves one section, complete, with If-Match = the displayed version and the environment header", async () => {
    signedIn("owner", "live");
    serveUpdate();

    const state = await run(
      saveBrand,
      formOf({
        version: "12",
        "brand.name": "  Demo Travel  ",
        "brand.legalName": "",
        "brand.timeZone": "Europe/Oslo",
      }),
    );

    const sent = only(`PATCH ${SETTINGS}`);
    expect(sent.headers.get("If-Match")).toBe('"12"');
    expect(sent.headers.get("Idempotency-Key")).toBeNull();
    expect(sent.headers.get("X-Velexis-Environment")).toBe("live");
    expect(sent.headers.get("X-Api-Key")).toBe(TEST_CONFIG.OTA_ADMIN_SERVICE_KEY);
    expect(sent.headers.get("X-Velexis-End-User-IP")).toBe("203.0.113.7");
    expect(sent.body).toEqual({ brand: { name: "Demo Travel", legalName: null, timeZone: "Europe/Oslo" } });
    expect(state).toEqual({ ok: true, message: "Saved. The storefront shows the change within 5 minutes." });
    expect(revalidated()).toEqual(["/settings/storefront"]);
  });

  it("[OAD-014] sends the theme: the logos by id, the colours, the fonts and the corner radius", async () => {
    signedIn("admin");
    serveUpdate();

    await run(
      saveBranding,
      formOf({
        version: "12",
        "branding.logoAssetId": OTHER_LOGO_ID,
        "branding.logoDarkAssetId": "",
        "branding.logoSquareAssetId": "",
        "branding.faviconAssetId": FAVICON_ID,
        "branding.colors.primary": "#0b5fff",
        "branding.colors.secondary": "#0f172a",
        "branding.colors.accent": "#b45309",
        "branding.colors.background": "#ffffff",
        "branding.colors.text": " #111827 ",
        "branding.fonts.heading": "Playfair Display",
        "branding.fonts.body": "Source Sans 3",
        "branding.cornerRadius": "large",
      }),
    );

    expect(only(`PATCH ${SETTINGS}`).body).toEqual({
      branding: {
        logoAssetId: OTHER_LOGO_ID,
        logoDarkAssetId: null,
        logoSquareAssetId: null,
        faviconAssetId: FAVICON_ID,
        colors: {
          primary: "#0b5fff",
          secondary: "#0f172a",
          accent: "#b45309",
          background: "#ffffff",
          text: "#111827",
        },
        fonts: { heading: "Playfair Display", body: "Source Sans 3" },
        cornerRadius: "large",
      },
    });
  });

  it("[OAD-014] sends lists as the API spells them, and the rows of a list in the form's order", async () => {
    signedIn("owner");
    serveUpdate();

    await run(
      saveLocales,
      formOf({ version: "12", "locales.default": "EN", "locales.supported": "en, fr_ca;nb nb" }),
    );
    await run(
      saveCurrencies,
      formOf({ version: "12", "currencies.default": "eur", "currencies.supported": "eur,nok" }),
    );
    await run(
      saveMarkets,
      formOf({
        version: "12",
        "markets.default": "fr",
        // Row 1 was removed in the form: rows 0 and 2 are posted.
        "markets.list.0.countryCode": "no",
        "markets.list.0.name": "Norway",
        "markets.list.0.currency": "nok",
        "markets.list.0.locale": "nb",
        "markets.list.2.countryCode": "FR",
        "markets.list.2.name": " France ",
        "markets.list.2.currency": "EUR",
        "markets.list.2.locale": "fr_ca",
      }),
    );

    expect(api.sent(`PATCH ${SETTINGS}`).map((request) => request.body)).toEqual([
      { locales: { default: "en", supported: ["en", "fr-CA", "nb"] } },
      { currencies: { default: "EUR", supported: ["EUR", "NOK"] } },
      {
        markets: {
          default: "FR",
          list: [
            { countryCode: "NO", name: "Norway", currency: "NOK", locale: "nb" },
            { countryCode: "FR", name: "France", currency: "EUR", locale: "fr-CA" },
          ],
        },
      },
    ]);
  });

  it("[OAD-014] sends the policies, the legal links, the consent categories and the operations", async () => {
    signedIn("owner");
    serveUpdate();

    await run(
      savePolicies,
      formOf({
        version: "12",
        "policies.ticketingPolicy": "manual_review",
        "policies.paymentTiming": "authorize_before_booking",
        "policies.acceptedCardBrands": ["MASTERCARD", "VISA", "NOT_A_BRAND"],
        "policies.requireEmailVerification": "true",
        "policies.offerTtlMinutes": "45",
        "policies.checkoutTtlMinutes": "1440",
      }),
    );
    await run(
      saveLegal,
      formOf({
        version: "12",
        "legal.termsVersion": "2026-11",
        "legal.privacyVersion": " ",
        "legal.links.0.kind": "terms",
        "legal.links.0.label": "Terms",
        "legal.links.0.target": "page",
        "legal.links.0.url": "https://left.over.example.com",
        "legal.links.0.pageSlug": "terms",
        "legal.links.1.kind": "privacy",
        "legal.links.1.label": "Privacy",
        "legal.links.1.target": "url",
        "legal.links.1.url": "https://demo.example.com/privacy",
        "legal.links.1.pageSlug": "",
      }),
    );
    await run(
      saveConsent,
      formOf({
        version: "12",
        "consent.regime": "gdpr",
        "consent.bannerRequired": "true",
        "consent.policyVersion": "2",
        "consent.categories.necessary.included": "true",
        "consent.categories.necessary.required": "true",
        "consent.categories.necessary.defaultEnabled": "true",
        "consent.categories.necessary.title": "Necessary",
        "consent.categories.necessary.description": "Always on.",
        // Not shown: its fields are not sent.
        "consent.categories.preferences.title": "Preferences",
        "consent.categories.preferences.description": "",
        "consent.categories.marketing.included": "true",
        // A forged `required` for another category than `necessary` is never sent.
        "consent.categories.marketing.required": "true",
        "consent.categories.marketing.title": "Marketing",
        "consent.categories.marketing.description": "",
      }),
    );
    await run(
      saveOperations,
      formOf({
        version: "12",
        "operations.opsAlertEmail": "",
        "operations.bookingQueue.number": "",
        "operations.bookingQueue.category": "3",
      }),
    );

    expect(api.sent(`PATCH ${SETTINGS}`).map((request) => request.body)).toEqual([
      {
        policies: {
          ticketingPolicy: "manual_review",
          paymentTiming: "authorize_before_booking",
          require3ds: false,
          acceptedCardBrands: ["VISA", "MASTERCARD"],
          requireEmailVerification: true,
          offerTtlMinutes: 45,
          checkoutTtlMinutes: 1440,
        },
      },
      {
        legal: {
          termsVersion: "2026-11",
          privacyVersion: null,
          links: [
            { kind: "terms", label: "Terms", pageSlug: "terms" },
            { kind: "privacy", label: "Privacy", url: "https://demo.example.com/privacy" },
          ],
        },
      },
      {
        consent: {
          regime: "gdpr",
          bannerRequired: true,
          policyVersion: "2",
          categories: [
            {
              id: "necessary",
              required: true,
              defaultEnabled: true,
              title: "Necessary",
              description: "Always on.",
            },
            { id: "marketing", required: false, defaultEnabled: false, title: "Marketing", description: "" },
          ],
        },
      },
      { operations: { opsAlertEmail: null, bookingQueue: { number: null, category: 3 } } },
    ]);
  });

  it("[OAD-014] answers the API's warnings with the saved section, as the API sent them", async () => {
    signedIn("owner");
    const warnings = [
      {
        code: "airline_card_net_price",
        message:
          "The airline card is on while markup or fee rules add an amount: airline-card bookings are sold at the airline's price.",
        path: "/airlineCard/enabledTest",
      },
    ];
    serveUpdate(warnings);

    const state = await run(saveAirlineCard, formOf({ version: "12", "airlineCard.enabledTest": "true" }));

    expect(only(`PATCH ${SETTINGS}`).body).toEqual({
      airlineCard: { enabledTest: true, enabledLive: false },
    });
    expect(state).toEqual({
      ok: true,
      message: "Saved. The storefront shows the change within 5 minutes.",
      warnings,
    });
  });

  it("[OAD-014] refuses an agent, a finance member and a viewer before any call, naming the permission", async () => {
    for (const role of ["agent", "finance", "viewer"] as const) {
      api = fakeOtaApi();
      vi.stubGlobal("fetch", api.fetch);
      signedIn(role);

      const state = await run(saveFeatures, formOf({ version: "12", "features.guestCheckout": "true" }));

      expect(state).toEqual({
        ok: false,
        code: "FORBIDDEN",
        message: "You do not have permission to do this (settings:write).",
      });
      expect(actionRequests()).toEqual([]);
    }
  });

  it("checks the section first, as the API would: every problem on its field, no request", async () => {
    signedIn("owner");

    const branding = await run(
      saveBranding,
      formOf({
        version: "12",
        "branding.logoAssetId": "logo.png",
        "branding.colors.primary": "blue",
        "branding.colors.secondary": "#0f172a",
        "branding.colors.accent": "#b4530",
        "branding.colors.background": "#ffffff",
        "branding.colors.text": "#111827",
        "branding.fonts.heading": "Comic Sans MS",
        "branding.fonts.body": "Inter",
        "branding.cornerRadius": "round",
      }),
    );
    const locales = await run(
      saveLocales,
      formOf({ version: "12", "locales.default": "de", "locales.supported": "en, nb" }),
    );
    const markets = await run(
      saveMarkets,
      formOf({
        version: "12",
        "markets.default": "SE",
        "markets.list.0.countryCode": "NO",
        "markets.list.0.name": "Norway",
        "markets.list.0.currency": "NOK",
        "markets.list.0.locale": "nb",
        "markets.list.3.countryCode": "no",
        "markets.list.3.name": "",
        "markets.list.3.currency": "KRONER",
        "markets.list.3.locale": "nb",
      }),
    );
    const policies = await run(
      savePolicies,
      formOf({
        version: "12",
        "policies.ticketingPolicy": "",
        "policies.paymentTiming": "pay_later",
        "policies.offerTtlMinutes": "4",
        "policies.checkoutTtlMinutes": "a day",
      }),
    );

    expect(branding).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      fieldErrors: {
        "branding.logoAssetId": "Choose an image from the list.",
        "branding.colors.primary": "Enter a colour as #RRGGBB, like #0B5FFF.",
        "branding.colors.accent": "Enter a colour as #RRGGBB, like #0B5FFF.",
        "branding.fonts.heading": "Choose one of the bundled fonts.",
        "branding.cornerRadius": "Choose a corner radius.",
      },
    });
    expect(locales.fieldErrors).toEqual({
      "locales.supported": "The supported locales must include the default one (de).",
    });
    expect(markets.fieldErrors).toEqual({
      "markets.list.3.countryCode": "Each country can be one market only.",
      "markets.list.3.name": "Enter the market's name (at most 80 characters).",
      "markets.list.3.currency": "Enter a currency code like EUR.",
      "markets.default": "The default market must be one of the markets below, or empty.",
    });
    expect(policies.fieldErrors).toEqual({
      "policies.ticketingPolicy": "Choose when tickets are issued.",
      "policies.paymentTiming": "The payment is authorised before the booking: the only timing of the MVP.",
      "policies.acceptedCardBrands": "Choose at least one card brand.",
      "policies.offerTtlMinutes": "Enter a whole number of minutes from 5 to 240.",
      "policies.checkoutTtlMinutes": "Enter a whole number of minutes from 5 to 1440.",
    });
    expect(actionRequests()).toEqual([]);
  });

  it("asks for a reload without the page's version", async () => {
    signedIn("owner");

    expect(await run(saveFeatures, formOf({ "features.guestCheckout": "true" }))).toEqual({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "This form is out of date. Reload the page and try again.",
    });
    expect(await run(saveFeatures, formOf({ version: "twelve" }))).toMatchObject({ ok: false });
    expect(actionRequests()).toEqual([]);
  });

  it("[OAD-014] answers 412 with a reload: the settings changed since the page was loaded", async () => {
    signedIn("owner");
    api.on(`PATCH ${SETTINGS}`, () => apiError("PRECONDITION_FAILED", 412));

    expect(await run(saveFeatures, formOf({ version: "12" }))).toEqual({
      ok: false,
      code: "PRECONDITION_FAILED",
      requestId: "req_fake_1",
      message:
        "The storefront settings changed since this page was loaded (another section was saved, or someone else changed them). Reload the page to see them; this section was not saved.",
    });
    expect(revalidated()).toEqual([]);
  });

  it("[OAD-014] puts a 422's reason on the field it points to, the row the form posted", async () => {
    signedIn("owner");
    api.on(`PATCH ${SETTINGS}`, () =>
      apiError("UNPROCESSABLE", 422, {
        details: { reason: "market_currency_not_supported", path: "/markets/list/1/currency" },
      }),
    );

    const state = await run(
      saveMarkets,
      formOf({
        version: "12",
        "markets.default": "",
        "markets.list.0.countryCode": "NO",
        "markets.list.0.name": "Norway",
        "markets.list.0.currency": "NOK",
        "markets.list.0.locale": "nb",
        "markets.list.2.countryCode": "SE",
        "markets.list.2.name": "Sweden",
        "markets.list.2.currency": "SEK",
        "markets.list.2.locale": "en",
      }),
    );

    expect(state).toEqual({
      ok: false,
      code: "UNPROCESSABLE",
      requestId: "req_fake_1",
      message: "Use one of the storefront's supported currencies (Locales and markets).",
      fieldErrors: {
        "markets.list.2.currency": "Use one of the storefront's supported currencies (Locales and markets).",
      },
    });
  });

  it("[OAD-014] puts a saved market that the sent list no longer supports on that list, naming the market", async () => {
    signedIn("owner");
    // The locales or currencies sent drop one a saved market uses: the API points at the market, which this form
    // does not show (api-changes part 2 §2.3, storefront-settings.service.ts `marketProblem`).
    api.on(`PATCH ${SETTINGS}`, (request) => {
      const body = request.body as Record<string, unknown>;
      return "locales" in body
        ? apiError("UNPROCESSABLE", 422, {
            details: { reason: "market_locale_not_supported", path: "/markets/list/0/locale" },
          })
        : apiError("UNPROCESSABLE", 422, {
            details: { reason: "market_currency_not_supported", path: "/markets/list/1/currency" },
          });
    });

    const locales = await run(
      saveLocales,
      formOf({ version: "12", "locales.default": "en", "locales.supported": "en, fr-CA" }),
    );
    const currencies = await run(
      saveCurrencies,
      formOf({ version: "12", "currencies.default": "NOK", "currencies.supported": "NOK" }),
    );

    const localeMessage =
      "Market 1 (under Markets) uses a locale this list no longer includes. Keep that locale here, or give the market another one and save the markets first.";
    expect(locales).toEqual({
      ok: false,
      code: "UNPROCESSABLE",
      requestId: "req_fake_1",
      message: localeMessage,
      fieldErrors: { "locales.supported": localeMessage },
    });
    expect(currencies).toMatchObject({
      message:
        "Market 2 (under Markets) uses a currency this list no longer includes. Keep that currency here, or give the market another one and save the markets first.",
      fieldErrors: {
        "currencies.supported":
          "Market 2 (under Markets) uses a currency this list no longer includes. Keep that currency here, or give the market another one and save the markets first.",
      },
    });
  });

  it("puts the API's field errors on the form's fields: a list's item on its list, a category's position on its id", async () => {
    signedIn("owner");
    api.on(`PATCH ${SETTINGS}`, () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [
          { path: "/consent/categories/1/title", code: "maxLength" },
          { path: "/locales/supported/2", code: "pattern" },
        ],
      }),
    );

    const state = await run(
      saveConsent,
      formOf({
        version: "12",
        "consent.regime": "none",
        "consent.categories.necessary.included": "true",
        "consent.categories.necessary.title": "Necessary",
        "consent.categories.necessary.description": "",
        "consent.categories.analytics.included": "true",
        "consent.categories.analytics.title": "Analytics",
        "consent.categories.analytics.description": "",
      }),
    );

    expect(state.fieldErrors).toEqual({
      "consent.categories.analytics.title": "Too long.",
      "locales.supported": "Not in the expected format.",
    });
  });

  it("[OAD-014] explains that the airline card stays off in live until the platform turns it on", async () => {
    signedIn("owner");
    api.on(`PATCH ${SETTINGS}`, () =>
      apiError("FEATURE_DISABLED", 403, { details: { feature: "airlineCard" } }),
    );

    const state = await run(
      saveAirlineCard,
      formOf({ version: "12", "airlineCard.enabledTest": "true", "airlineCard.enabledLive": "true" }),
    );

    expect(only(`PATCH ${SETTINGS}`).body).toEqual({ airlineCard: { enabledTest: true, enabledLive: true } });
    const message =
      "The airline card cannot be turned on in live yet: the platform turns it on after its security review. The test environment can use it already.";
    expect(state).toEqual({
      ok: false,
      code: "FEATURE_DISABLED",
      requestId: "req_fake_1",
      message,
      fieldErrors: { "airlineCard.enabledLive": message },
    });
  });

  it("puts a picked image of the wrong kind on its picker", async () => {
    signedIn("owner");
    api.on(`PATCH ${SETTINGS}`, () =>
      apiError("UNPROCESSABLE", 422, { details: { reason: "asset_kind", path: "/seo/ogImageAssetId" } }),
    );

    const state = await run(
      saveSeo,
      formOf({
        version: "12",
        "seo.titleTemplate": "%s | Demo",
        "seo.defaultTitle": "",
        "seo.defaultDescription": "",
        "seo.ogImageAssetId": LOGO_ID,
      }),
    );

    expect(state.fieldErrors).toEqual({
      "seo.ogImageAssetId":
        "This image was uploaded for another purpose. Choose one uploaded as this kind of image.",
    });
  });
});

// ---- The page ---------------------------------------------------------------------------------------------------

describe("/settings/storefront", () => {
  it("[OAD-014] reads the settings and the images of each picker's kind, and offers every section to an owner", async () => {
    signedIn("owner");
    serveSettings();

    const page = await renderPage();

    expect(only(`GET ${SETTINGS}`).headers.get("X-Velexis-Environment")).toBe("test");
    expect(api.sent(`GET ${ASSETS}`).map((request) => Object.fromEntries(request.url.searchParams))).toEqual(
      ["logo", "logo_dark", "logo_square", "favicon", "og_image"].map((kind) => ({ kind, limit: "100" })),
    );
    expect(page.querySelector("h1")?.textContent).toBe("Storefront settings");
    expect(page.textContent).toContain("Version 12, last changed");
    expect(
      [...page.querySelectorAll("form[data-section]")].map((form) => form.getAttribute("data-section")),
    ).toEqual([
      "brand",
      "branding",
      "locales",
      "currencies",
      "markets",
      "features",
      "policies",
      "airlineCard",
      "legal",
      "support",
      "seo",
      "consent",
      "operations",
    ]);
    for (const form of page.querySelectorAll("form[data-section]")) {
      expect(form.querySelector("fieldset")?.hasAttribute("disabled")).toBe(false);
      expect(form.querySelector('button[type="submit"]')).not.toBeNull();
      expect(form.querySelector('input[name="version"]')?.getAttribute("value")).toBe("12");
    }
  });

  it("[OAD-014] lists the images of the right kind in each picker, and keeps a choice that is not listed", async () => {
    signedIn("owner");
    serveSettings({
      ...storefrontSettings(),
      branding: { ...storefrontSettings().branding, logoSquareAssetId: "ast_01JA6B2C3D4E5F6G7H8J9K0M8Y" },
    });

    const page = await renderPage();
    const options = (name: string) =>
      [...page.querySelectorAll<HTMLOptionElement>(`select[name="${name}"] option`)].map((option) => [
        option.value,
        option.textContent,
      ]);

    expect(options("branding.logoAssetId")).toEqual([
      ["", "No image"],
      [LOGO_ID, "demo-logo.png (640 × 160 px, 47 KB)"],
      [OTHER_LOGO_ID, "demo-logo-2027.png (640 × 160 px, 47 KB)"],
    ]);
    expect(options("branding.faviconAssetId")).toEqual([
      ["", "No image"],
      [FAVICON_ID, "favicon.ico (640 × 160 px, 47 KB)"],
    ]);
    expect(options("branding.logoDarkAssetId")).toEqual([["", "No image"]]);
    expect(options("branding.logoSquareAssetId")).toEqual([
      ["", "No image"],
      ["ast_01JA6B2C3D4E5F6G7H8J9K0M8Y", "ast_01JA6B2C3D4E5F6G7H8J9K0M8Y (not among the images listed)"],
    ]);
    expect(options("seo.ogImageAssetId")).toEqual([
      ["", "No image"],
      [OG_IMAGE_ID, "share.png (640 × 160 px, 47 KB)"],
    ]);
    expect(
      page.querySelector<HTMLOptionElement>('select[name="branding.logoAssetId"] option[selected]')?.value,
    ).toBe(LOGO_ID);
  });

  it("[OAD-014 AC1] shows the contrast warning for saved colours that fail WCAG contrast, and the preview", async () => {
    signedIn("owner");
    const settings = storefrontSettings();
    serveSettings({
      ...settings,
      branding: { ...settings.branding, colors: { ...settings.branding.colors, text: "#999999" } },
    });

    const page = await renderPage();
    const status = page.querySelector("[data-contrast]");

    expect(status?.getAttribute("data-contrast")).toBe("fails");
    expect(status?.textContent).toContain("The storefront will not use these colours");
    expect(status?.textContent).toContain("The body text on the page background is 2.84:1; it needs 4.5:1.");
    expect(page.querySelector('[data-preview="theme"]')?.getAttribute("style")).toContain("color:#999999");
  });

  it("says the colours pass when every pair reaches 4.5:1", async () => {
    signedIn("owner");
    serveSettings();

    const page = await renderPage();

    expect(page.querySelector("[data-contrast]")?.getAttribute("data-contrast")).toBe("passes");
  });

  // One render per test: a page of thirteen forms takes a while to render and parse on a busy runner.
  it.each(["agent", "finance", "viewer"] as const)(
    "[OAD-014] shows every section read only to a role without settings:write (%s)",
    async (role) => {
      signedIn(role);
      serveSettings();

      const page = await renderPage();

      expect(page.textContent).toContain(
        "Read only: changing the storefront settings needs the permission settings:write.",
      );
      const forms = [...page.querySelectorAll("form[data-section]")];
      expect(forms).toHaveLength(13);
      for (const form of forms) {
        expect(form.querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
        expect(form.querySelector('button[type="submit"]')).toBeNull();
      }
    },
  );

  it("keeps the live airline card off while the API has it off", async () => {
    signedIn("owner");
    serveSettings();

    const page = await renderPage();

    expect(page.querySelector('input[name="airlineCard.enabledLive"]')?.hasAttribute("disabled")).toBe(true);
    expect(page.textContent).toContain("Live stays off until the platform turns the airline card on");
  });

  it("offers the live airline card to turn it off when the API has it on", async () => {
    signedIn("owner");
    serveSettings({ ...storefrontSettings(), airlineCard: { enabledTest: true, enabledLive: true } });

    const page = await renderPage();

    const live = page.querySelector('input[name="airlineCard.enabledLive"]');
    expect(live?.hasAttribute("disabled")).toBe(false);
    expect(live?.hasAttribute("checked")).toBe(true);
  });

  it("[OAD-014] posts every form as the page renders it to its action: each section is sent back unchanged", async () => {
    signedIn("owner");
    const settings = storefrontSettings();
    serveSettings(settings);
    serveUpdate();
    const page = await renderPage();

    for (const [section, action] of Object.entries(ACTIONS) as [
      SettingsSection,
      (typeof ACTIONS)[SettingsSection],
    ][]) {
      const state = await run(action, formDataOf(sectionForm(page, section)));
      expect(state, section).toMatchObject({ ok: true });
    }

    const sent = api.sent(`PATCH ${SETTINGS}`);
    expect(sent.map((request) => request.headers.get("If-Match"))).toEqual(Array(13).fill('"12"'));
    expect(sent.map((request) => request.body)).toEqual(
      Object.keys(ACTIONS).map((section) => ({ [section]: settings[section as SettingsSection] })),
    );
  });

  it.each([
    ["policies", "Policies"],
    ["../admin", "Brand and theme"],
  ])("opens the tab of ?tab=%s, and the first one for any other value", async (tab, label) => {
    signedIn("owner");
    serveSettings();

    const page = await renderPage({ tab });

    expect(page.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(label);
  });

  it("keeps the settings editable when the images cannot be read, and says so", async () => {
    signedIn("owner");
    serveSettings();
    api.on(`GET ${ASSETS}`, () => apiError("INTERNAL_ERROR", 500));

    const page = await renderPage();

    expect(page.textContent).toContain("The uploaded images could not be loaded");
    expect(
      [...page.querySelectorAll<HTMLOptionElement>('select[name="branding.logoAssetId"] option')].map(
        (option) => option.value,
      ),
    ).toEqual(["", LOGO_ID]);
    expect(page.querySelector('form[data-section="branding"] button[type="submit"]')).not.toBeNull();
  });

  it("renders the API's refusal of the settings with its request id, and redirects an expired session", async () => {
    signedIn("owner");
    api.on(`GET ${SETTINGS}`, () => apiError("INTERNAL_ERROR", 500));

    const failed = await renderPage();
    expect(failed.querySelector('[role="alert"] h2')?.textContent).toBe(
      "The storefront settings could not be loaded",
    );
    expect(failed.textContent).toContain("req_fake_1");
    expect(failed.querySelector("form")).toBeNull();

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    signedIn("owner");
    api.on(`GET ${SETTINGS}`, () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => renderPage({ tab: "seo" }))).toBe(
      `/auth/refresh?next=${encodeURIComponent("/settings/storefront?tab=seo")}`,
    );
  });

  it("refuses a staff member without settings:read without reading the settings", async () => {
    signedIn("owner");
    api.on(ME, () =>
      Response.json(
        { ...staffProfile({ role: "viewer" }), permissions: ["bookings:read"] },
        {
          headers: { "X-Request-Id": "req_me" },
        },
      ),
    );

    const page = await renderPage();

    expect(page.querySelector('[role="alert"] h2')?.textContent).toBe(
      "You cannot open the storefront settings",
    );
    expect(page.textContent).toContain("You do not have permission to do this (settings:read).");
    expect(actionRequests()).toEqual([]);
  });
});
