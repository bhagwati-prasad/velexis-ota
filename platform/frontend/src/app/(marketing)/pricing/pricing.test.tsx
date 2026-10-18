// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import type { ReactElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope of Next.js and the configuration; the real API client talks to a mocked fetch ----

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import PrivacyPage from "@/app/(marketing)/legal/privacy/page";
import TermsPage from "@/app/(marketing)/legal/terms/page";
import MarketingLayout from "@/app/(marketing)/layout";
import LandingPage from "@/app/(marketing)/page";
import PricingPage from "@/app/(marketing)/pricing/page";
import { formatMoney } from "@/components/money";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  ERROR_MESSAGES,
  LANDING_STRINGS,
  LEGAL_STRINGS,
  MARKETING_STRINGS,
  PRICING_STRINGS,
} from "@/lib/strings";
import { termsVersion } from "@/lib/terms";

// ---- Builders ------------------------------------------------------------------------------------------------

type Plan = components["schemas"]["Plan"];

function plan(overrides: Partial<Plan> & Pick<Plan, "code" | "name">): Plan {
  return {
    description: null,
    monthlyPrice: { amount: "0.00", currency: "EUR" },
    annualPrice: null,
    trialDays: 0,
    limits: { staffSeats: 5, apiKeys: 10, customDomains: 0, liveMode: false },
    features: {},
    checkoutAvailable: { month: false, year: false },
    ...overrides,
  };
}

/** Three plans in the API's order (`sort_order`): neither alphabetical nor by price, so a re-sort would show. */
const GROWTH = plan({
  code: "growth",
  name: "Growth",
  description: "For OTAs that sell every day.",
  monthlyPrice: { amount: "49.00", currency: "EUR" },
  annualPrice: { amount: "490.00", currency: "EUR" },
  trialDays: 14,
  limits: { staffSeats: 10, apiKeys: 20, customDomains: 1, liveMode: true },
  features: { customDomains: true },
  checkoutAvailable: { month: true, year: true },
});
const EARLY_ACCESS = plan({
  code: "early_access",
  name: "Early access",
  description: "Free plan for OTAs created before paid plans open. Test mode only.",
  trialDays: 90,
});
const SCALE = plan({
  code: "scale",
  name: "Scale",
  monthlyPrice: { amount: "1290.5", currency: "USD" },
  annualPrice: { amount: "12900.00", currency: "USD" },
  trialDays: 1,
  limits: { staffSeats: 1, apiKeys: 1000, customDomains: 3, liveMode: true },
});

/** The visitor's address as Caddy appends it, after one the browser sent itself (PADR-0019). */
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) PricingTest/1.0";
/** A signed-in visitor's access token cookie: a dummy, never a real token. */
const ACCESS_TOKEN = "header.payload-of-a-signed-in-visitor.signature";

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function answerPlans(plans: readonly Plan[]): void {
  fetchMock.mockImplementation(() => Promise.resolve(Response.json({ data: plans })));
}

function lastRequest(): Request {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error("fetch was not called");
  }
  return call[0];
}

/** The request scope of a signed-in visitor: the session cookie, the forwarded address and the user agent. */
function signedInRequest(): void {
  const requestHeaders = new Headers({
    "x-forwarded-for": FORWARDED_FOR,
    "user-agent": USER_AGENT,
    cookie: `${ACCESS_TOKEN_COOKIE}=${ACCESS_TOKEN}`,
  });
  nextHeaders.headers.mockResolvedValue(requestHeaders);
  nextHeaders.cookies.mockResolvedValue({
    get: (name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined),
    set: vi.fn(),
  });
}

async function renderPricing(): Promise<void> {
  render(<MarketingLayout>{await PricingPage()}</MarketingLayout>);
}

/** The plan cards of the page, in document order. */
function planCards(): HTMLElement[] {
  return within(screen.getByRole("list", { name: PRICING_STRINGS.plansLabel })).getAllByRole("article");
}

/** The text of a card's `<dd>` for the term `term`. */
function detail(card: HTMLElement, term: string): string {
  const dt = within(card).getByText(term, { selector: "dt" });
  return dt.nextElementSibling?.textContent ?? "";
}

function included(card: HTMLElement): string[] {
  const heading = within(card).getByRole("heading", { level: 3, name: PRICING_STRINGS.includedTitle });
  const list = heading.nextElementSibling as HTMLElement;
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

/**
 * The HTML parser of happy-dom 17 decodes `&amp;` and `&quot;` in attribute values but keeps the other character
 * references React writes there (`&#x27;`, `&lt;`, `&gt;`) as text, where a browser decodes them. The shadcn/ui
 * class names hold `'` and `>`, so without this step hydration would see a class mismatch that no browser has.
 */
function decodeAttributeReferences(root: Element): void {
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      const decoded = attribute.value
        .replaceAll("&#x27;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">");
      if (decoded !== attribute.value) {
        element.setAttribute(attribute.name, decoded);
      }
    }
  }
}

/**
 * Renders `element` the way a browser gets the page: HTML from the server (`renderToString`), then React hydrates
 * it in the DOM. Collects every error React or the window reports on the way: console errors and warnings
 * (hydration mismatches, missing keys, invalid DOM nesting), recoverable, caught and uncaught errors, and `error`
 * events.
 */
async function serverRenderAndHydrate(element: ReactElement): Promise<{ errors: unknown[]; root: Root }> {
  const errors: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(["console.error", ...args]);
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    errors.push(["console.warn", ...args]);
  });
  const onWindowError = (event: ErrorEvent) => {
    errors.push(["window error", event.error ?? event.message]);
  };
  window.addEventListener("error", onWindowError);

  const container = document.createElement("div");
  container.innerHTML = renderToString(element);
  decodeAttributeReferences(container);
  document.body.append(container);
  // The server's page as the DOM holds it (serialised by the DOM, so entities are normalised).
  const serverDom = container.innerHTML;
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, element, {
        onRecoverableError: (error) => errors.push(["recoverable", error]),
        onCaughtError: (error) => errors.push(["caught", error]),
        onUncaughtError: (error) => errors.push(["uncaught", error]),
      });
      await Promise.resolve();
    });
  } finally {
    window.removeEventListener("error", onWindowError);
  }
  if (root === undefined) {
    throw new Error("hydrateRoot did not run");
  }
  // The hydrated page is the server's page: same markup, nothing replaced on the client.
  expect(container.innerHTML).toBe(serverDom);
  return { errors, root };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  signedInRequest();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- /pricing ----------------------------------------------------------------------------------------------------

describe("/pricing: the public plans of listPlans", () => {
  it("[PFE-004 AC1] lists only the plans the API returns, in its order, with formatted prices [PF-70 AC1]", async () => {
    answerPlans([GROWTH, EARLY_ACCESS, SCALE]);
    await renderPricing();

    const cards = planCards();
    expect(cards.map((card) => within(card).getByRole("heading", { level: 2 }).textContent)).toEqual([
      "Growth",
      "Early access",
      "Scale",
    ]);
    const [growth, earlyAccess, scale] = cards as [HTMLElement, HTMLElement, HTMLElement];

    // Prices: formatted by Money with Intl, per currency, from the decimal strings as they are.
    expect(detail(growth, PRICING_STRINGS.monthly)).toBe(`€49.00${PRICING_STRINGS.perMonth}`);
    expect(detail(growth, PRICING_STRINGS.annual)).toBe(`€490.00${PRICING_STRINGS.perYear}`);
    expect(detail(earlyAccess, PRICING_STRINGS.monthly)).toBe(`€0.00${PRICING_STRINGS.perMonth}`);
    expect(detail(earlyAccess, PRICING_STRINGS.annual)).toBe(PRICING_STRINGS.noAnnual);
    expect(detail(scale, PRICING_STRINGS.monthly)).toBe(`$1,290.50${PRICING_STRINGS.perMonth}`);
    expect(detail(scale, PRICING_STRINGS.annual)).toBe(`$12,900.00${PRICING_STRINGS.perYear}`);
    // The machine-readable value is the API's decimal string, never a float.
    expect(
      Array.from(scale.querySelectorAll("data")).map((element) => element.getAttribute("value")),
    ).toEqual(["1290.5", "12900.00"]);
    expect(formatMoney(SCALE.monthlyPrice)).toBe("$1,290.50");

    // Free trial and limits.
    expect(detail(growth, PRICING_STRINGS.trial)).toBe("14 days");
    expect(detail(earlyAccess, PRICING_STRINGS.trial)).toBe("90 days");
    expect(detail(scale, PRICING_STRINGS.trial)).toBe("1 day");
    expect(included(growth)).toEqual([
      "Up to 10 team members",
      "20 API keys",
      "1 custom domain",
      PRICING_STRINGS.liveMode,
    ]);
    expect(included(earlyAccess)).toEqual([
      "Up to 5 team members",
      "10 API keys",
      "No custom domains",
      PRICING_STRINGS.testModeOnly,
    ]);
    expect(included(scale)).toEqual([
      "Up to 1 team member",
      "1,000 API keys",
      "3 custom domains",
      "Live bookings and payments",
    ]);

    // Descriptions as the API sends them; none for a plan without one.
    expect(within(growth).getByText("For OTAs that sell every day.")).toBeTruthy();
    expect(scale.querySelectorAll("h2 + p")).toHaveLength(0);
  });

  it("[PFE-004 AC1] 'Start' leads to /sign-up?plan=<code>, one link named after each plan", async () => {
    answerPlans([GROWTH, EARLY_ACCESS, SCALE]);
    await renderPricing();

    const links = planCards().map((card) => within(card).getByRole("link"));
    expect(links.map((link) => link.textContent)).toEqual([
      `${PRICING_STRINGS.start} with Growth`,
      `${PRICING_STRINGS.start} with Early access`,
      `${PRICING_STRINGS.start} with Scale`,
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/sign-up?plan=growth",
      "/sign-up?plan=early_access",
      "/sign-up?plan=scale",
    ]);
    expect(screen.getByRole("link", { name: "Start with Early access" }).getAttribute("href")).toBe(
      "/sign-up?plan=early_access",
    );
  });

  it("[PFE-004 AC1] shows nothing but what the API returns: one plan gives one card", async () => {
    answerPlans([SCALE]);
    await renderPricing();

    expect(planCards()).toHaveLength(1);
    expect(screen.queryByText("Growth")).toBeNull();
    expect(screen.queryByText("Early access")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Scale",
    ]);
  });

  it("[PFE-004 AC1] calls listPlans once, without the visitor's token, with the end-user headers", async () => {
    answerPlans([EARLY_ACCESS]);
    await renderPricing();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = lastRequest();
    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://127.0.0.1:3100/v1/plans");
    // listPlans is public: a signed-in visitor's token stays in the portal.
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("cookie")).toBeNull();
    // The right-most X-Forwarded-For entry (Caddy's), never the one the browser sent (PADR-0019).
    expect(request.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
    expect(request.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
    expect(request.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
  });

  it("says so when no plan is open, without an empty list", async () => {
    answerPlans([]);
    await renderPricing();

    expect(screen.getByText(PRICING_STRINGS.empty)).toBeTruthy();
    expect(screen.queryByRole("list", { name: PRICING_STRINGS.plansLabel })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("shows the portal's message for a failed call, never the API's, and still offers sign-up", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            status: 429,
            message: "Raw API message: slow down",
            requestId: "req_1",
          },
        },
        { status: 429, headers: { "retry-after": "30" } },
      ),
    );
    await renderPricing();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(PRICING_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.RATE_LIMITED);
    expect(alert.textContent).not.toContain("Raw API message");
    expect(within(alert).getByRole("link", { name: PRICING_STRINGS.signUp }).getAttribute("href")).toBe(
      "/sign-up",
    );
    expect(screen.queryByRole("list", { name: PRICING_STRINGS.plansLabel })).toBeNull();
  });

  it("shows the unavailable message when the API cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:3100"));
    await renderPricing();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(PRICING_STRINGS.unavailableTitle);
    expect(alert.textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(alert.textContent).not.toContain("ECONNREFUSED");
    expect(within(alert).getByRole("link", { name: PRICING_STRINGS.signUp }).getAttribute("href")).toBe(
      "/sign-up",
    );
    expect(screen.queryByRole("list", { name: PRICING_STRINGS.plansLabel })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("[PFE-004 AC2] renders with one h1 in the one main, and without JavaScript errors", async () => {
    answerPlans([GROWTH, EARLY_ACCESS, SCALE]);
    const page = <MarketingLayout>{await PricingPage()}</MarketingLayout>;

    const { errors, root } = await serverRenderAndHydrate(page);

    expect(errors).toEqual([]);
    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      PRICING_STRINGS.title,
    ]);
    expect(screen.getAllByRole("main").map((main) => main.id)).toEqual(["main-content"]);
    expect(planCards()).toHaveLength(3);
    act(() => root.unmount());
  });
});

// ---- / ---------------------------------------------------------------------------------------------------------

describe("/: the landing page", () => {
  it("[PFE-004 AC2] renders with one h1 in the one main, and without JavaScript errors", async () => {
    const { errors, root } = await serverRenderAndHydrate(
      <MarketingLayout>
        <LandingPage />
      </MarketingLayout>,
    );

    expect(errors).toEqual([]);
    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      LANDING_STRINGS.title,
    ]);
    expect(screen.getAllByRole("main").map((main) => main.id)).toEqual(["main-content"]);
    expect(screen.getByRole("main").getAttribute("tabindex")).toBe("-1");
    act(() => root.unmount());
  });

  it("calls the visitor to sign up and to the pricing, and makes no API call", () => {
    render(
      <MarketingLayout>
        <LandingPage />
      </MarketingLayout>,
    );

    const main = screen.getByRole("main");
    const getStarted = within(main).getAllByRole("link", { name: LANDING_STRINGS.getStarted });
    expect(getStarted.length).toBeGreaterThanOrEqual(1);
    expect(getStarted.map((link) => link.getAttribute("href"))).toEqual(getStarted.map(() => "/sign-up"));
    expect(within(main).getByRole("link", { name: LANDING_STRINGS.seePricing }).getAttribute("href")).toBe(
      "/pricing",
    );
    expect(
      within(main)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual([LANDING_STRINGS.stepsTitle, LANDING_STRINGS.featuresTitle, LANDING_STRINGS.closingTitle]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has the public header and footer: home, pricing, sign-in, sign-up and the legal pages", () => {
    render(
      <MarketingLayout>
        <LandingPage />
      </MarketingLayout>,
    );

    const header = screen.getByRole("navigation", { name: MARKETING_STRINGS.navigationLabel });
    expect(
      within(header)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      [MARKETING_STRINGS.pricing, "/pricing"],
      [MARKETING_STRINGS.signIn, "/sign-in"],
      [MARKETING_STRINGS.getStarted, "/sign-up"],
    ]);
    expect(screen.getByRole("link", { name: MARKETING_STRINGS.homeLink }).getAttribute("href")).toBe("/");
    const footer = screen.getByRole("navigation", { name: MARKETING_STRINGS.footerLabel });
    expect(
      within(footer)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      [MARKETING_STRINGS.terms, "/legal/terms"],
      [MARKETING_STRINGS.privacy, "/legal/privacy"],
    ]);
  });
});

// ---- /legal/terms and /legal/privacy -----------------------------------------------------------------------------

describe("/legal/terms and /legal/privacy", () => {
  it("termsVersion is a version the API accepts (1 to 32 characters)", () => {
    expect(termsVersion.length).toBeGreaterThanOrEqual(1);
    expect(termsVersion.length).toBeLessThanOrEqual(32);
  });

  it.each([
    { path: "/legal/terms", Page: TermsPage, title: LEGAL_STRINGS.termsTitle },
    { path: "/legal/privacy", Page: PrivacyPage, title: LEGAL_STRINGS.privacyTitle },
  ])(
    "$path shows the termsVersion that sign-up sends, the placeholder notice and one h1",
    async ({ Page, title }) => {
      const { errors, root } = await serverRenderAndHydrate(
        <MarketingLayout>
          <Page />
        </MarketingLayout>,
      );

      expect(errors).toEqual([]);
      expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
        title,
      ]);
      expect(screen.getAllByRole("main").map((main) => main.id)).toEqual(["main-content"]);
      expect(screen.getByText(LEGAL_STRINGS.version(termsVersion))).toBeTruthy();
      expect(screen.getByRole("note").textContent).toContain(LEGAL_STRINGS.placeholder);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(0);
      act(() => root.unmount());
    },
  );
});
