import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CookieJar, TENANT_ID, TEST_CONFIG, TEST_PORTAL_URL } from "@/test/fake-ota-api";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);

import { TENANT_COOKIE } from "@/lib/session";

import SignedOutPage from "./page";

describe("/signed-out", () => {
  it("links back to this OTA's console page in the portal when the tenant cookie names it", async () => {
    nextHeaders.cookies.mockResolvedValue(new CookieJar({ [TENANT_COOKIE]: TENANT_ID }));

    const html = renderToStaticMarkup(await SignedOutPage());

    expect(html).toContain("<h1");
    expect(html).toContain("You have signed out");
    expect(html).toContain(`href="${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}"`);
    expect(html).toContain("Back to the portal");
  });

  it("links to the portal's console page without a tenant", async () => {
    nextHeaders.cookies.mockResolvedValue(new CookieJar({ [TENANT_COOKIE]: "not-a-tenant" }));

    const html = renderToStaticMarkup(await SignedOutPage());

    expect(html).toContain(`href="${TEST_PORTAL_URL}/console"`);
  });
});
