// `/portal` as Next.js renders it on the server (OAD-012): the real page, `getConsoleRequest` and the SDK against the
// fake OTA API, rendered to HTML and queried in a detached happy-dom document. The links come from the configured
// portal URL and the session's tenant id (lib/portal-links.test.ts proves the builder).
import { within } from "@testing-library/dom";
import { Window } from "happy-dom";
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

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return { usePathname: () => "/portal", redirect: fakeRedirect };
});

import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import PortalPage from "./page";

let api: FakeOtaApi;
let sequence = 0;

function signedIn(): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`portal-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-portal-${sequence}`,
      [ENVIRONMENT_COOKIE]: "test",
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

async function renderPage(): Promise<HTMLElement> {
  const element = await PortalPage();
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body as unknown as HTMLElement;
}

// Once per file: the first server render and the SDK's first call are the slowest in a fresh worker.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  await renderPage();
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
  signedIn();
});

describe("/portal", () => {
  it("[OAD-012] links every portal area of the session's OTA under the configured portal URL, for every role", async () => {
    for (const role of ["owner", "agent", "finance", "viewer"] as const) {
      api.on("GET /v1/console/auth/me", () => Response.json(staffProfile({ role })));
      const page = await renderPage();

      expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Portal links");
      expect(page.textContent).toContain("Demo Travel's API keys, domains");
      const nav = within(page).getByRole("navigation", { name: "Portal pages of this OTA" });
      const links = within(nav)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]);
      expect(links).toEqual([
        ["OTA overview", `${TEST_PORTAL_URL}/otas/${TENANT_ID}`],
        ["API keys", `${TEST_PORTAL_URL}/otas/${TENANT_ID}/api-keys`],
        ["Domains", `${TEST_PORTAL_URL}/otas/${TENANT_ID}/domains`],
        ["Amadeus", `${TEST_PORTAL_URL}/otas/${TENANT_ID}/amadeus`],
        ["Payments and Stripe", `${TEST_PORTAL_URL}/otas/${TENANT_ID}/payments`],
        ["Team", `${TEST_PORTAL_URL}/otas/${TENANT_ID}/team`],
        ["Billing", `${TEST_PORTAL_URL}/otas/${TENANT_ID}/billing`],
        ["Go live", `${TEST_PORTAL_URL}/otas/${TENANT_ID}/go-live`],
        ["OTA settings", `${TEST_PORTAL_URL}/otas/${TENANT_ID}/settings`],
      ]);
    }
    // No call but the session's own profile.
    expect(api.requests.every((request) => request.url.pathname === "/v1/console/auth/me")).toBe(true);
  });

  it("[OAD-012] uses the tenant of the session, never the tenant cookie", async () => {
    const other = "ten_01JB9Z8Y7X6W5V4T3S2R1Q0P9N";
    nextHeaders.cookies.mockResolvedValue(
      new CookieJar({
        [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken("portal-other", Date.now(), 900),
        [STAFF_REFRESH_TOKEN_COOKIE]: "staff-refresh-token-portal-other",
        [ENVIRONMENT_COOKIE]: "test",
        [TENANT_COOKIE]: other,
      }),
    );
    const page = await renderPage();
    const hrefs = within(page)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every((href) => href.startsWith(`${TEST_PORTAL_URL}/otas/${TENANT_ID}`))).toBe(true);
    expect(page.innerHTML).not.toContain(other);
  });

  it("redirects an expired session to /auth/refresh and an ended one to the portal, and renders other failures with the request id", async () => {
    // `getConsoleRequest` redirects a refused `console.auth.me` itself, as on every page.
    api.on("GET /v1/console/auth/me", () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => renderPage())).toBe("/auth/refresh");

    api.on("GET /v1/console/auth/me", () => apiError("UNAUTHENTICATED", 401));
    expect(await redirectOf(() => renderPage())).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);

    api.on("GET /v1/console/auth/me", () => apiError("INTERNAL_ERROR", 500));
    const page = await renderPage();
    const alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("The portal links could not be shown");
    expect(alert.textContent).toContain("req_fake_1");
  });
});
