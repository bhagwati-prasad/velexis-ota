// Shopping on behalf `/shopping` as Next.js renders it on the server (OAD-010): the real page, `getConsoleRequest` and
// the SDK against the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a detached happy-dom document (a
// server-mode SDK client refuses to run in a browser-like test environment, rightly). It checks what the page reads
// (`console.auth.me` and, for `settings:read`, the markup rules; never an Amadeus call or a customer-scope operation
// while it renders), the net-price and booking-later notices, the default markup rule for orientation, the console it
// hands the environment and the currency, a role without `amadeus:read`, and the session's codes as redirects. Every id,
// name and amount here is a dummy.
import type { MarkupRule, StaffRole } from "@velexis/ota-sdk";
import { within } from "@testing-library/dom";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
} from "@/test/fake-ota-api";

import type * as ResultsModule from "./results";

// ---- Mocks: the request scope and navigation of Next.js and the configuration ------------------------------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/shopping",
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    redirect: fakeRedirect,
  };
});
// The real console, watched: the page must hand it the environment and the OTA's currency.
vi.mock("./results", async (importOriginal) => {
  const real = await importOriginal<typeof ResultsModule>();
  return { ...real, ShoppingConsole: vi.fn(real.ShoppingConsole) };
});

import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import ShoppingPage from "./page";
import { ShoppingConsole } from "./results";

const ME = "GET /v1/console/auth/me";
const MARKUP_RULES = "GET /v1/console/settings/markup-rules";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member whose switch says `environment`. */
function signedIn(environment: "test" | "live" = "test"): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`shopping-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-shopping-${sequence}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

/** `console.auth.me` answers a staff member of `role`, with the supplier connection `connected`. */
function staffOf(role: StaffRole, connected = true): void {
  api.on(ME, () => {
    const profile = staffProfile({ role });
    return Response.json({
      ...profile,
      tenant: { ...profile.tenant, supplier: { ...profile.tenant.supplier, connected } },
    });
  });
}

/** A markup rule (dummy), the seeded default one unless `overrides` say otherwise. */
function rule(overrides: Partial<MarkupRule> = {}): MarkupRule {
  return {
    id: "mkr_01JA4H1A3C5E7G9J1L3N5Q7S9U",
    name: "Default",
    description: null,
    scope: {},
    calculation: "percentage",
    percentage: "5.0000",
    fixed: null,
    appliesPer: "traveler",
    min: { amount: "5.00", currency: "EUR" },
    max: { amount: "50.00", currency: "EUR" },
    priority: 1000,
    stackable: false,
    isDefault: true,
    isActive: true,
    activeFrom: null,
    activeUntil: null,
    version: 1,
    createdAt: "2026-10-01T10:02:17Z",
    updatedAt: "2026-10-01T10:02:17Z",
    ...overrides,
  };
}

/** The markup rules answer `pages` in turn: each a list of rules, the cursor of the next one on all but the last. */
function markupPages(...pages: MarkupRule[][]): void {
  api.on(MARKUP_RULES, (request) => {
    const cursor = request.url.searchParams.get("cursor");
    const index = cursor === null ? 0 : Number(cursor.replace("cur_", ""));
    const data = pages[index] ?? [];
    return Response.json({
      data,
      page: { nextCursor: index + 1 < pages.length ? `cur_${index + 1}` : null, limit: 100 },
    });
  });
}

/** `/shopping`, rendered to HTML on the "server" and parsed into a document. */
async function renderPage(): Promise<HTMLElement> {
  const element = await ShoppingPage();
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body as unknown as HTMLElement;
}

/** The routes the page called, in order. */
function routes(): string[] {
  return api.requests.map((request) => `${request.method} ${request.url.pathname}`);
}

// Once per file: the first server render of the page and the SDK's first calls are the slowest in a fresh worker; on
// a busy CI runner they would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  staffOf("agent");
  markupPages([rule()]);
  await renderPage();
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
  signedIn();
  vi.mocked(ShoppingConsole).mockClear();
});

describe("/shopping", () => {
  it("[OAD-010 AC2] renders the searches with the net-price and booking-later notices, and calls no Amadeus or customer-scope operation", async () => {
    staffOf("agent");
    markupPages([rule()]);

    const page = await renderPage();

    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Shopping on behalf");
    const notes = within(page).getAllByRole("note");
    expect(notes[0]?.textContent).toContain(
      "Every price on this page is an Amadeus net price: before this OTA's markup and fees, not the price a customer pays.",
    );
    expect(page.textContent).toContain("Environment: test. Amadeus offices: OSLN12345.");
    const later = within(page).getByRole("region", { name: "Booking on behalf comes later" });
    expect(later.textContent).toContain(
      "booking on behalf waits for console.bookings.create, which is deferred",
    );
    expect(within(later).getByRole("link", { name: "PNR lookup" }).getAttribute("href")).toBe("/pnr");
    // The two searches, with net totals labelled as such.
    expect(within(page).getByRole("tab", { name: "Flight offers" })).toBeTruthy();
    expect(within(page).getByRole("tab", { name: "Seat availability" })).toBeTruthy();
    expect(within(page).getByRole("form", { name: "Search flight offers" })).toBeTruthy();
    expect(within(page).getByRole("form", { name: "Search seat availability" })).toBeTruthy();
    expect(vi.mocked(ShoppingConsole).mock.calls[0]?.[0]).toEqual({
      environment: "test",
      defaultCurrency: "EUR",
    });

    // Rendering reads the profile and the markup rules, nothing else: no Amadeus call, no `flights.*`.
    expect(routes()).toEqual([ME, MARKUP_RULES]);
    expect(api.requests.some((request) => request.url.pathname.startsWith("/v1/flight"))).toBe(false);
    expect(api.requests.some((request) => request.url.pathname.startsWith("/v1/console/amadeus"))).toBe(
      false,
    );
  });

  it("shows the OTA's default markup rule for orientation, read from the markup rules in the switch's environment", async () => {
    signedIn("live");
    staffOf("agent");
    // The default rule is the last of the evaluation order (priority 1000): here on the second page.
    markupPages(
      [rule({ id: "mkr_01JA4H1A3C5E7G9J1L3N5Q7S9V", name: "Long haul", isDefault: false, priority: 10 })],
      [rule()],
    );

    const page = await renderPage();

    const sent = api.sent(MARKUP_RULES);
    expect(sent.map((request) => Object.fromEntries(request.url.searchParams))).toEqual([
      { limit: "100" },
      { limit: "100", cursor: "cur_1" },
    ]);
    expect(sent[0]?.headers.get("X-Velexis-Environment")).toBe("live");
    const tile = within(page).getByRole("region", { name: "Default markup rule, for orientation" });
    expect(tile.querySelector("[data-markup-rule]")?.textContent).toBe(
      "Default: 5 % of the net price, per traveller (at least €5.00, at most €50.00 each).",
    );
    expect(tile.textContent).toContain("this default rule applies when no other rule matches");
    expect(tile.textContent).not.toContain("Long haul");
    expect(within(tile).getByRole("link", { name: "Markup rules" }).getAttribute("href")).toBe(
      "/settings/markups",
    );
    expect(vi.mocked(ShoppingConsole).mock.calls[0]?.[0]).toEqual({
      environment: "live",
      defaultCurrency: "EUR",
    });
  });

  it("describes fixed and combined markups, a rule that is switched off, and an OTA without a default rule", async () => {
    staffOf("owner");
    markupPages([
      rule({
        calculation: "percentage_plus_fixed",
        percentage: "2.5000",
        fixed: { amount: "10.00", currency: "EUR" },
        appliesPer: "booking",
        min: null,
        max: null,
        isActive: false,
      }),
    ]);
    let tile = within(await renderPage()).getByRole("region", {
      name: "Default markup rule, for orientation",
    });
    expect(tile.querySelector("[data-markup-rule]")?.textContent).toBe(
      "Default: 2.5 % of the net price plus €10.00, per booking.",
    );
    expect(tile.textContent).toContain("This rule is switched off.");

    markupPages([
      rule({
        calculation: "fixed",
        percentage: null,
        fixed: { amount: "7.00", currency: "EUR" },
        appliesPer: "segment",
        min: null,
        max: null,
      }),
    ]);
    tile = within(await renderPage()).getByRole("region", { name: "Default markup rule, for orientation" });
    expect(tile.querySelector("[data-markup-rule]")?.textContent).toBe("Default: €7.00, per segment.");

    markupPages([rule({ isDefault: false, name: "Long haul" })]);
    tile = within(await renderPage()).getByRole("region", { name: "Default markup rule, for orientation" });
    expect(tile.textContent).toContain("This OTA has no default markup rule.");
  });

  it("keeps the searches when the markup rules cannot be read, with the message and the request id in their tile", async () => {
    staffOf("agent");
    api.on(MARKUP_RULES, () => apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }));

    const page = await renderPage();

    const tile = within(page).getByRole("region", { name: "Default markup rule, for orientation" });
    expect(within(tile).getByRole("alert").textContent).toContain(
      "The markup rules could not be read. The OTA API is unavailable right now.",
    );
    expect(tile.textContent).toContain("req_fake_1");
    expect(within(page).getByRole("form", { name: "Search flight offers" })).toBeTruthy();
  });

  it("warns when the environment has no Amadeus connection", async () => {
    staffOf("agent", false);
    markupPages([rule()]);

    const page = await renderPage();

    expect(page.textContent).toContain(
      "No Amadeus connection is active in this environment, so Amadeus refuses the searches.",
    );
  });

  it("refuses a role without amadeus:read with the permission's name and no request but the profile", async () => {
    for (const role of ["finance", "viewer"] as const) {
      api = fakeOtaApi();
      vi.stubGlobal("fetch", api.fetch);
      staffOf(role);

      const page = await renderPage();

      const alert = within(page).getByRole("alert");
      expect(within(alert).getByRole("heading").textContent).toBe("You cannot shop on behalf of callers");
      expect(alert.textContent).toContain("You do not have permission to do this (amadeus:read).");
      expect(within(page).queryByRole("form")).toBeNull();
      expect(routes()).toEqual([ME]);
    }
  });

  it("redirects an expired session back to /shopping and an ended one to the portal", async () => {
    staffOf("agent");
    api.on(MARKUP_RULES, () => apiError("TOKEN_EXPIRED", 401));
    const next = new URLSearchParams({ next: "/shopping" }).toString();
    expect(await redirectOf(() => renderPage())).toBe(`/auth/refresh?${next}`);

    api.on(MARKUP_RULES, () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));
    expect(await redirectOf(() => renderPage())).toBe(
      `${TEST_CONFIG.PUBLIC_PORTAL_URL}/console?tenant=${TENANT_ID}`,
    );
  });
});
