// @vitest-environment happy-dom
//
// The dashboard's storefront links and the tenant limit before the create-OTA wizard (FIX-W69-LIMIT, known issues
// KI-006 and KI-010; README §2 `/dashboard` and `/otas/new`, scope PF-10 AC4): each OTA links its `storefrontUrl` (the
// primary host of listTenants) and, while it is being set up or its set-up failed, shows the host as text with the
// overview's note instead of a link; once `tenantLimit.owned` reaches `max`, "Create an OTA" is a disabled button
// described by the visible reason, and `/otas/new` shows the same reason above its first step. The pages run on the
// server with the real `lib/api.ts` over a mocked fetch; PFE-008's dashboard tests are in otas/new/wizard.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope of Next.js and the configuration; the real API client talks to a mocked fetch ----

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  redirect: navigation.redirect,
}));

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import DashboardPage from "@/app/(app)/dashboard/page";
import NewOtaPage from "@/app/(app)/otas/new/page";
import { loadTenantLimit, tenantLimitReached } from "@/components/tenant-limit-notice";
import type { PlatformApi } from "@/lib/api";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import { DASHBOARD_STRINGS, OTA_DASHBOARD_STRINGS, WIZARD_STEP_LABELS, WIZARD_STRINGS } from "@/lib/strings";

// ---- Builders (dummy values only: no real token) -----------------------------------------------------------------

type Schemas = components["schemas"];
type TenantSummary = Schemas["TenantSummary"];
type TenantLimit = Schemas["TenantLimit"];

const ACCESS_TOKEN = "fixw69-dummy-access-token";

function account(): Schemas["Account"] {
  return {
    id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    email: "anna.berg@example.com",
    emailVerified: true,
    fullName: "Anna Berg",
    locale: "en",
    timeZone: "Europe/Oslo",
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaEnrolmentRequired: false,
    isPlatformAdmin: false,
    createdAt: "2026-10-01T10:02:17Z",
    version: 3,
    memberships: [],
    features: {
      stripeBilling: false,
      ownStripe: false,
      settlements: false,
      ownAmadeus: false,
      customDomains: false,
      liveSwitch: false,
    },
  };
}

function tenantSummary(
  overrides: Partial<TenantSummary> & Pick<TenantSummary, "id" | "key" | "name">,
): TenantSummary {
  return {
    status: "active",
    role: "owner",
    planCode: "early_access",
    storefrontUrl: `https://${overrides.key}.ota.example.com/`,
    storefrontEnvironment: "test",
    ...overrides,
  };
}

/** Four OTAs: one on its sub-domain, one on a verified primary custom domain, one in set-up and one whose set-up failed. */
const TENANTS: TenantSummary[] = [
  tenantSummary({ id: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F", key: "acme", name: "Acme Travel" }),
  tenantSummary({
    id: "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G",
    key: "nordic",
    name: "Nordic Fares",
    role: "admin",
    storefrontUrl: "https://book.nordicfares.example/",
  }),
  tenantSummary({
    id: "ten_01JC4M2P6R0T4W8Y2A6C0E4G8K",
    key: "polar",
    name: "Polar Trips",
    status: "provisioning",
  }),
  tenantSummary({
    id: "ten_01JD5N3Q7S1V5X9Z3B7D1F5H9M",
    key: "fjord",
    name: "Fjord Flights",
    status: "failed",
    storefrontUrl: "https://fly.fjordflights.example/",
  }),
];

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiError(code: string, status: number): Response {
  return json(
    { error: { code, message: "The API's own text, never shown", status, requestId: "req_api_fixw69" } },
    status,
  );
}

/** Answers each call by `METHOD /path`: the account, no plans, and listTenants with `tenants` and `limit`. */
function routes(answer: { tenants?: TenantSummary[]; limit?: TenantLimit; tenantsFail?: boolean }): void {
  const table: Record<string, () => Response> = {
    "GET /v1/me": () => json(account(), 200),
    "GET /v1/plans": () => json({ data: [] }, 200),
    "GET /v1/tenants": () =>
      answer.tenantsFail === true
        ? apiError("INTERNAL_ERROR", 500)
        : json({ data: answer.tenants ?? TENANTS, tenantLimit: answer.limit ?? { max: 3, owned: 2 } }, 200),
  };
  fetchMock.mockImplementation((input) => {
    const route = table[`${input.method} ${new URL(input.url).pathname}`];
    if (route === undefined) {
      throw new Error(`unexpected call ${input.method} ${input.url}`);
    }
    return Promise.resolve(route());
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  nextHeaders.headers.mockResolvedValue(new Headers({ "x-forwarded-for": "198.51.100.23" }));
  nextHeaders.cookies.mockResolvedValue({
    get: (name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined),
    has: (name: string) => name === ACCESS_TOKEN_COOKIE,
    set: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The card of the OTA named `name`. */
function card(name: string): HTMLElement {
  const list = screen.getByRole("list", { name: DASHBOARD_STRINGS.listLabel });
  const found = within(list)
    .getAllByRole("article")
    .find((article) => within(article).queryByRole("heading", { name }) !== null);
  if (found === undefined) {
    throw new Error(`No card for ${name}.`);
  }
  return found;
}

/**
 * The budget of a hook that opens the wizard: its server render and first browser render build some 850 options in
 * happy-dom, a few hundred milliseconds alone and several times that on a loaded CI runner (as in wizard.test.tsx).
 */
const OPEN_WIZARD_TIMEOUT_MS = 30_000;

/**
 * `/otas/new` called the way Next.js renders a page, with its props (none here): the page may read `searchParams`
 * from them (FIX-W69-SIGNUP's `?plan=`), so it is never called without an argument.
 */
const newOtaPage: (props: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) => ReturnType<typeof NewOtaPage> = NewOtaPage;

// ---- /dashboard ---------------------------------------------------------------------------------------------------

describe("/dashboard: the storefront of each OTA", () => {
  it("[FIX-W69-LIMIT AC2] links each open OTA's storefrontUrl, its primary host, a custom domain included", async () => {
    routes({});
    render(await DashboardPage());

    const acme = within(card("Acme Travel")).getByRole("link", { name: "acme.ota.example.com" });
    expect(acme.getAttribute("href")).toBe("https://acme.ota.example.com/");
    // The verified primary custom domain, not the key's sub-domain.
    const nordic = within(card("Nordic Fares")).getByRole("link", { name: "book.nordicfares.example" });
    expect(nordic.getAttribute("href")).toBe("https://book.nordicfares.example/");
    expect(within(card("Nordic Fares")).queryByText("nordic.ota.example.com")).toBeNull();
    expect(within(card("Acme Travel")).queryByText(OTA_DASHBOARD_STRINGS.storefrontPending)).toBeNull();
  });

  it("[FIX-W69-LIMIT AC2] shows the host as text with the overview's note while the OTA is set up or failed", async () => {
    routes({});
    render(await DashboardPage());

    for (const [name, host] of [
      ["Polar Trips", "polar.ota.example.com"],
      ["Fjord Flights", "fly.fjordflights.example"],
    ] as const) {
      const pending = card(name);
      // The host is there, but no link to a storefront that is not open: only the name's link and "Open console".
      expect(within(pending).getByText(host).closest("a"), name).toBeNull();
      expect(within(pending).queryByRole("link", { name: host }), name).toBeNull();
      expect(within(pending).getByText(OTA_DASHBOARD_STRINGS.storefrontPending), name).toBeTruthy();
    }
    expect(OTA_DASHBOARD_STRINGS.storefrontPending).toBe("The storefront opens when the set-up is done.");
  });
});

describe("/dashboard: the tenant limit", () => {
  it("[FIX-W69-LIMIT AC3] below the limit offers Create an OTA as before, with no notice", async () => {
    routes({ limit: { max: 3, owned: 2 } });
    render(await DashboardPage());

    expect(screen.getByRole("link", { name: DASHBOARD_STRINGS.createOta }).getAttribute("href")).toBe(
      "/otas/new",
    );
    expect(document.querySelector('[data-notice="tenant-limit"]')).toBeNull();
  });

  it("[FIX-W69-LIMIT AC3] at the limit shows Create an OTA disabled, not as a link, described by the visible reason", async () => {
    routes({ limit: { max: 3, owned: 3 } });
    render(await DashboardPage());

    expect(screen.queryByRole("link", { name: DASHBOARD_STRINGS.createOta })).toBeNull();
    const button = screen.getByRole("button", { name: DASHBOARD_STRINGS.createOta }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(WIZARD_STRINGS.tenantLimitReached(3, 3));
    // The wizard's own tenant-limit words, with the count.
    expect(reason?.textContent).toBe(WIZARD_STRINGS.tenantLimit(3));
    expect(reason?.textContent).toContain("You already own 3 OTAs, the most one account can have.");
    // The OTAs are listed as usual.
    expect(card("Acme Travel")).toBeTruthy();
  });

  it("[FIX-W69-LIMIT AC3] above the limit (an owner invitation counts no limit, KI-046) names both numbers", async () => {
    routes({ limit: { max: 3, owned: 4 } });
    render(await DashboardPage());

    const button = screen.getByRole("button", { name: DASHBOARD_STRINGS.createOta }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "You own 4 OTAs, and one account can have at most 3 OTAs. An OTA whose set-up failed does not count. Contact Velexis support if you need more.",
    );
  });

  it("[FIX-W69-LIMIT AC3] at the limit with no OTA listed does not invite to create the first one", async () => {
    // A suspended owner membership counts but is not listed.
    routes({ tenants: [], limit: { max: 1, owned: 1 } });
    render(await DashboardPage());

    expect(screen.getByRole("heading", { name: DASHBOARD_STRINGS.emptyTitle })).toBeTruthy();
    expect(screen.queryByText(DASHBOARD_STRINGS.empty)).toBeNull();
    expect(screen.getByText(WIZARD_STRINGS.tenantLimitReached(1, 1))).toBeTruthy();
  });
});

// ---- /otas/new ------------------------------------------------------------------------------------------------------

describe("/otas/new at the tenant limit", () => {
  beforeEach(async () => {
    routes({ limit: { max: 3, owned: 3 } });
    render(await newOtaPage({}));
  }, OPEN_WIZARD_TIMEOUT_MS);

  it("[FIX-W69-LIMIT AC3] shows the reason above the first step; the review's refusal stays the final guard", () => {
    const notice = document.querySelector('[data-notice="tenant-limit"]');
    expect(notice?.textContent).toBe(WIZARD_STRINGS.tenantLimitReached(3, 3));
    const firstStep = screen.getByRole("heading", { level: 2, name: WIZARD_STEP_LABELS.details });
    // Before the first step in reading order.
    expect(notice?.compareDocumentPosition(firstStep)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe("/otas/new below the tenant limit", () => {
  beforeEach(async () => {
    routes({ limit: { max: 3, owned: 2 } });
    render(await newOtaPage({}));
  }, OPEN_WIZARD_TIMEOUT_MS);

  it("[FIX-W69-LIMIT AC3] opens the wizard as before, with no notice", () => {
    expect(document.querySelector('[data-notice="tenant-limit"]')).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: WIZARD_STEP_LABELS.details })).toBeTruthy();
  });
});

describe("loadTenantLimit and tenantLimitReached", () => {
  it("[FIX-W69-LIMIT AC3] reads listTenants' limit, treats a failed call as unknown, and is reached from owned = max", async () => {
    const answering = (result: unknown) => ({ GET: () => Promise.resolve(result) }) as unknown as PlatformApi;
    expect(
      await loadTenantLimit(answering({ data: { data: [], tenantLimit: { max: 3, owned: 1 } } })),
    ).toEqual({
      max: 3,
      owned: 1,
    });
    expect(
      await loadTenantLimit(
        answering({ error: { code: "INTERNAL_ERROR", status: 500, fieldErrors: [], details: {} } }),
      ),
    ).toBeUndefined();

    expect(tenantLimitReached(undefined)).toBe(false);
    expect(tenantLimitReached({ max: 3, owned: 2 })).toBe(false);
    expect(tenantLimitReached({ max: 3, owned: 3 })).toBe(true);
    expect(tenantLimitReached({ max: 3, owned: 4 })).toBe(true);
  });

  it("leaves Create an OTA as a link when listTenants fails (the review's refusal still guards)", async () => {
    routes({ tenantsFail: true });
    render(await DashboardPage());
    expect(screen.getByRole("link", { name: DASHBOARD_STRINGS.createOta }).getAttribute("href")).toBe(
      "/otas/new",
    );
    expect(document.querySelector('[data-notice="tenant-limit"]')).toBeNull();
  });
});

// ---- /otas/new reads the limit in parallel (lead decision (39d), FIX-W70-CONSOLE) ----------------------------------

describe("/otas/new: the tenant limit read with the page's other reads", () => {
  /** Answers like `routes({})`, with `me` as getMe's answer and `tenants` as listTenants' (a throw: a network error). */
  function answers(me: () => Promise<Response>, tenants: () => Promise<Response>): void {
    routes({});
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input) => {
      const path = new URL(input.url).pathname;
      if (path === "/v1/me") {
        return me();
      }
      if (path === "/v1/tenants") {
        return tenants();
      }
      return base === undefined ? Promise.reject(new Error("no routes")) : base(input);
    });
  }

  it("[FIX-W70-CONSOLE AC5] asks listTenants before getMe has answered", async () => {
    let tenantsAsked: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => {
      tenantsAsked = resolve;
    });
    let askedBeforeMe: boolean | undefined;
    answers(
      async () => {
        // getMe answers once listTenants was asked, or after 1 s: a page that read the limit after getMe asks only then.
        askedBeforeMe = await new Promise<boolean>((resolve) => {
          const late = setTimeout(() => resolve(false), 1000);
          void asked.then(() => {
            clearTimeout(late);
            resolve(true);
          });
        });
        return json(account(), 200);
      },
      () => {
        tenantsAsked();
        return Promise.resolve(json({ data: [], tenantLimit: { max: 3, owned: 3 } }, 200));
      },
    );

    const page = await newOtaPage({});

    expect(askedBeforeMe).toBe(true);
    // The same page as before: the limit read for the verified account (rendered by the tests above).
    expect(page).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([request]) => new URL(request.url).pathname === "/v1/tenants"),
    ).toHaveLength(1);
  });

  it("[FIX-W70-CONSOLE AC5] behaves as before when listTenants is refused: only a verified account's page meets it", async () => {
    // The API's MFA enrolment gate on listTenants (the one answer that leaves the page) reaches only a verified account.
    const gated = () =>
      Promise.resolve(
        json(
          {
            error: {
              code: "MFA_REQUIRED",
              message: "The API's own text, never shown",
              status: 403,
              requestId: "req_api_fixw70",
              details: { reason: "enrolment_required" },
            },
          },
          403,
        ),
      );
    answers(() => Promise.resolve(json({ ...account(), emailVerified: false }, 200)), gated);
    await expect(newOtaPage({})).rejects.toThrow("NEXT_REDIRECT /verify-pending");
    answers(() => Promise.resolve(apiError("UNAUTHENTICATED", 401)), gated);
    await expect(newOtaPage({})).rejects.toThrow("NEXT_REDIRECT /sign-in?next=%2Fotas%2Fnew");
    answers(() => Promise.resolve(json(account(), 200)), gated);
    await expect(newOtaPage({})).rejects.toThrow("NEXT_REDIRECT /mfa-enrolment");
    // A failed listTenants (an error answer, or no answer at all) is no limit: the wizard opens without the notice.
    for (const failing of [
      () => Promise.resolve(apiError("INTERNAL_ERROR", 500)),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      answers(() => Promise.resolve(json(account(), 200)), failing);
      await expect(newOtaPage({})).resolves.toBeTruthy();
    }
  });
});
