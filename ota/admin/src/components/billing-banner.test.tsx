// @vitest-environment happy-dom
// The billing banner of the console shell (OAD-018 AC1): one banner for each value of `tenant.billingNotice`, with the
// link to the portal's billing page of the session's OTA, and none for `null` or a missing notice. The shell's wiring
// (the notice of `console.auth.me`, `PUBLIC_PORTAL_URL`, the session's tenant) is tested in (console)/layout.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TENANT_ID, TEST_PORTAL_URL } from "@/test/fake-ota-api";

import { BILLING_STRINGS, BillingBanner, isBillingNotice, portalBillingUrl } from "./billing-banner";

const BILLING_PAGE = `${TEST_PORTAL_URL}/otas/${TENANT_ID}/billing`;

function banner(notice: string | null | undefined, tenantId: string = TENANT_ID) {
  return render(
    <div data-testid="shell">
      <BillingBanner notice={notice} portalUrl={TEST_PORTAL_URL} tenantId={tenantId} />
    </div>,
  );
}

// Once per file: the first render (React DOM, the icons) is the slowest in a fresh worker; on a busy CI runner it
// would otherwise land in the first test's own five seconds. Nothing of it stays.
beforeAll(() => {
  banner("past_due");
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("BillingBanner", () => {
  it("[OAD-018 AC1] shows a failed payment as an alert with the link to the portal's billing page", () => {
    banner("past_due");

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-notice")).toBe("past_due");
    expect(within(alert).getByText("Payment problem: update billing in the portal")).toBeTruthy();
    expect(alert.textContent).toContain(BILLING_STRINGS.past_due.detail);
    const link = within(alert).getByRole("link", { name: "Go to billing in the portal" });
    expect(link.getAttribute("href")).toBe(BILLING_PAGE);
    // The portal opens in the same tab, as "Back to the portal" does; the icon is decoration.
    expect(link.getAttribute("target")).toBeNull();
    expect(alert.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("[OAD-018 AC1] shows an ending trial as a status message with the link to the portal's billing page", () => {
    banner("trial_ending");

    const status = screen.getByRole("status");
    expect(status.getAttribute("data-notice")).toBe("trial_ending");
    expect(within(status).getByText(BILLING_STRINGS.trial_ending.title)).toBeTruthy();
    expect(status.textContent).toContain(BILLING_STRINGS.trial_ending.detail);
    expect(within(status).getByRole("link", { name: BILLING_STRINGS.link }).getAttribute("href")).toBe(
      BILLING_PAGE,
    );
    // An ending trial is not urgent: no alert, which a screen reader would announce on every page.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("[OAD-018 AC1] renders nothing for null or a missing notice", () => {
    for (const notice of [null, undefined]) {
      banner(notice);
      const shell = screen.getByTestId("shell");
      expect(shell.childElementCount).toBe(0);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
      cleanup();
    }
  });

  it("renders nothing for a value the console does not know", () => {
    banner("canceled");

    expect(screen.getByTestId("shell").childElementCount).toBe(0);
  });

  it("keeps the notice but drops the link when the tenant id is not one", () => {
    banner("past_due", "../../elsewhere");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(BILLING_STRINGS.past_due.title);
    expect(within(alert).queryByRole("link")).toBeNull();
  });
});

describe("portalBillingUrl", () => {
  it("is the portal's billing page of the OTA, built by lib/portal-links.ts", () => {
    expect(portalBillingUrl(TEST_PORTAL_URL, TENANT_ID)).toBe(BILLING_PAGE);
    // The configured portal URL keeps its path and loses its query and fragment.
    expect(portalBillingUrl("https://portal.example.com/app/?x=1#y", TENANT_ID)).toBe(
      `https://portal.example.com/app/otas/${TENANT_ID}/billing`,
    );
    expect(portalBillingUrl(TEST_PORTAL_URL, "ten_not-a-ulid")).toBeUndefined();
  });

  it("knows the two notices that show a banner", () => {
    expect(["past_due", "trial_ending", null, undefined, "", "active"].map(isBillingNotice)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});
