// The shell as Next.js renders it on the server: the real layout, `getConsoleRequest` and the SDK against the fake
// OTA API, rendered to HTML and queried in a detached happy-dom document (a server-mode SDK client refuses to run in a
// browser-like test environment, rightly). What the switch and the banner do in the browser is tested in
// src/components/components.test.tsx, the switch's server action in env-actions.test.ts.
import type { ConsoleStaffProfile } from "@velexis/ota-sdk";
import { within } from "@testing-library/dom";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  TEST_PORTAL_URL,
  apiError,
  fakeOtaApi,
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
} from "@/test/fake-ota-api";

// ---- Mocks: the request scope and navigation of Next.js, the configuration and the switch's server actions -----

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/bookings",
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    redirect: fakeRedirect,
  };
});
vi.mock("@/app/(console)/env-actions", () => ({ switchEnvironment: vi.fn(), resetEnvironment: vi.fn() }));

import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import ConsoleLayout from "./layout";

const LIVE_REFUSED = "Live is not available for this OTA or role.";
const PORTAL_OF_TENANT = `${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`;

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member whose switch says `environment`. */
function signedIn(environment: "test" | "live"): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`layout-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-layout-${sequence}-${Date.now()}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

/** `console.auth.me` answers `profile`. */
function me(profile: ConsoleStaffProfile): void {
  api.on("GET /v1/console/auth/me", () => Response.json(profile));
}

/** The layout around a page, rendered to HTML on the "server" and parsed into a document to query. */
async function renderLayout(children: ReactNode = <p>Page body</p>): Promise<HTMLElement> {
  const html = renderToStaticMarkup(await ConsoleLayout({ children }));
  const { document } = new Window();
  document.body.innerHTML = html;
  return document.body as unknown as HTMLElement;
}

/** The navigation's links as [text, href]. */
function navEntries(page: HTMLElement): [string, string][] {
  return within(within(page).getByRole("navigation", { name: "Console" }))
    .getAllByRole("link")
    .map((link) => [link.textContent ?? "", link.getAttribute("href") ?? ""]);
}

/** The environment the shell renders, from its `data-environment`. */
function shellEnvironment(page: HTMLElement): string | null | undefined {
  return within(page).getByRole("main").closest("[data-environment]")?.getAttribute("data-environment");
}

// Once per file: the first server render of the shell (React DOM server, Radix, next/link) and the SDK's first call are
// the slowest in a fresh worker; on a busy CI runner they would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn("test");
  await renderLayout();
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
});

describe("(console) layout", () => {
  it("[OAD-004 AC1] a viewer sees no LIVE switch, only the TEST badge", async () => {
    signedIn("test");
    me(staffProfile({ role: "viewer", environments: ["test"] }));

    const page = await renderLayout();

    expect(within(page).queryByRole("group", { name: "Environment" })).toBeNull();
    expect(within(page).queryByRole("button", { name: "LIVE" })).toBeNull();
    expect(page.querySelector('[name="environment"]')).toBeNull();
    expect(page.textContent).not.toContain("LIVE");
    const badge = within(page).getByText("TEST").closest("[data-environment]");
    expect(badge?.getAttribute("data-environment")).toBe("test");
    expect(badge?.textContent).toBe("Environment: TEST");
  });

  it("[OAD-004 AC1] never offers live to a viewer, even when a profile lists it", async () => {
    signedIn("test");
    me(staffProfile({ role: "viewer", environments: ["test", "live"] }));

    const page = await renderLayout();

    expect(within(page).queryByRole("button", { name: "LIVE" })).toBeNull();
  });

  it("renders the OTA, the navigation the role may open, the staff member, the portal link and sign-out", async () => {
    signedIn("test");
    me(staffProfile({ role: "viewer", environments: ["test"] }));

    const page = await renderLayout();

    expect(within(page).getByText("Demo Travel")).toBeTruthy();
    expect(navEntries(page)).toEqual([
      ["Dashboard", "/"],
      ["Bookings", "/bookings"],
      ["PNR lookup", "/pnr"],
      ["Payments", "/payments"],
      ["Customers", "/customers"],
      ["Markups", "/settings/markups"],
      ["Fees", "/settings/fees"],
      ["Storefront", "/settings/storefront"],
      ["Assets", "/settings/assets"],
      ["Pages", "/settings/pages"],
      ["E-mail templates", "/settings/templates"],
      ["Portal links", "/portal"],
    ]);
    expect(within(page).getByRole("link", { name: "Bookings" }).getAttribute("aria-current")).toBe("page");
    expect(within(page).getByText("Kari Nordmann")).toBeTruthy();
    expect(within(page).getByText("Viewer")).toBeTruthy();
    expect(within(page).getByRole("link", { name: "Back to the portal" }).getAttribute("href")).toBe(
      PORTAL_OF_TENANT,
    );
    const signOut = within(page).getByRole("button", { name: "Sign out" }).closest("form");
    expect(signOut?.getAttribute("action")).toBe("/auth/sign-out");
    expect(signOut?.getAttribute("method")).toBe("post");
    const main = within(page).getByRole("main");
    expect(main.id).toBe("main-content");
    expect(main.textContent).toBe("Page body");
    // One console.auth.me for the shell, in the environment of the cookie; nothing of the profile but the role and
    // the permissions crosses into the navigation's client component (the HTML holds no e-mail address).
    expect(
      api.sent("GET /v1/console/auth/me").map((sent) => sent.headers.get("X-Velexis-Environment")),
    ).toEqual(["test"]);
    expect(page.innerHTML).not.toContain("kari.nordmann@example.com");
  });

  it("gives an agent of a live OTA the TEST / LIVE switch and the agent's areas", async () => {
    signedIn("test");
    me(staffProfile({ role: "agent", environments: ["test", "live"] }));

    const page = await renderLayout();

    const group = within(page).getByRole("group", { name: "Environment" });
    const test = within(group).getByRole("button", { name: "TEST" });
    const live = within(group).getByRole("button", { name: "LIVE" });
    expect(test.getAttribute("aria-pressed")).toBe("true");
    expect(live.getAttribute("aria-pressed")).toBe("false");
    // Each button submits its own form, whose hidden `environment` is its value.
    expect(live.getAttribute("type")).toBe("submit");
    expect(
      live.closest("form")?.querySelector('input[type="hidden"][name="environment"]')?.getAttribute("value"),
    ).toBe("live");
    expect(shellEnvironment(page)).toBe("test");
    expect(navEntries(page).map(([label]) => label)).toEqual(
      expect.arrayContaining(["Queues", "Shopping", "Supplier log"]),
    );
    expect(within(page).queryByRole("note")).toBeNull();
  });

  it("turns the shell into live mode with a warning when the switch says live", async () => {
    signedIn("live");
    me(staffProfile({ role: "finance", environments: ["test", "live"] }));

    const page = await renderLayout();

    expect(shellEnvironment(page)).toBe("live");
    expect(within(page).getByRole("note").textContent).toBe(
      "LIVE environment: bookings, tickets and payments here are real.",
    );
    expect(within(page).getByRole("button", { name: "LIVE" }).getAttribute("aria-pressed")).toBe("true");
    expect(api.sent("GET /v1/console/auth/me")[0]?.headers.get("X-Velexis-Environment")).toBe("live");
  });

  it("falls back to test after a refused live environment and shows the banner of routes.md §1", async () => {
    signedIn("live");
    const viewer = staffProfile({ role: "viewer", environments: ["test"] });
    api.on("GET /v1/console/auth/me", (request) =>
      request.headers.get("X-Velexis-Environment") === "live"
        ? apiError("ENVIRONMENT_NOT_ALLOWED", 403)
        : Response.json(viewer),
    );

    const page = await renderLayout();

    expect(within(page).getByRole("status").textContent).toContain(LIVE_REFUSED);
    expect(shellEnvironment(page)).toBe("test");
    expect(within(page).queryByRole("note")).toBeNull();
    expect(within(page).queryByRole("button", { name: "LIVE" })).toBeNull();
    expect(within(page).getByRole("main").textContent).toBe("Page body");
  });

  it("renders the full page of a suspended OTA with a link to the portal", async () => {
    signedIn("test");
    api.on("GET /v1/console/auth/me", () => apiError("TENANT_SUSPENDED", 403));

    const page = await renderLayout();

    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("This OTA is suspended");
    expect(within(page).getByText("This OTA is suspended. The portal says why and what to do.")).toBeTruthy();
    expect(within(page).getByText("req_fake_1")).toBeTruthy();
    expect(within(page).getByRole("link", { name: "Back to the portal" }).getAttribute("href")).toBe(
      PORTAL_OF_TENANT,
    );
    expect(within(page).queryByRole("navigation")).toBeNull();
    expect(page.textContent).not.toContain("Page body");
  });

  it("renders the console's message and request id instead of the shell when the API fails", async () => {
    signedIn("test");
    // `Retry-After: 60` ends the SDK's call at once instead of waiting for a retry.
    api.on("GET /v1/console/auth/me", () =>
      apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }),
    );

    const page = await renderLayout();

    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("The console is unavailable");
    expect(
      within(page).getByText("The OTA API is unavailable right now. Try again in a moment."),
    ).toBeTruthy();
    expect(within(page).getByText("req_fake_1")).toBeTruthy();
    // `href=""` is the same URL again (a server component does not know its path).
    expect(within(page).getByText("Try again").closest("a")?.getAttribute("href")).toBe("");
    // Never the API's own message.
    expect(page.textContent).not.toContain("The API refused the request");
  });

  it("redirects an expired session to /auth/refresh and an ended one to the portal", async () => {
    signedIn("test");
    api.on("GET /v1/console/auth/me", () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => ConsoleLayout({ children: null }))).toBe("/auth/refresh");

    api.on("GET /v1/console/auth/me", () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));
    expect(await redirectOf(() => ConsoleLayout({ children: null }))).toBe(PORTAL_OF_TENANT);
  });
});
