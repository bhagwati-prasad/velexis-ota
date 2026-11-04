// @vitest-environment happy-dom
// The billing banner of the console shell (OAD-018 AC1): one banner for each value of `tenant.billingNotice`, and none
// for `null` or a missing notice. The notice shows for every role; the link to the portal's billing page of the
// session's OTA only for owner and finance, the portal's `viewBilling` rule (lead decision (2o) of 2026-11-02,
// FIX-W39-OTA). The shell's wiring (the notice and role of `console.auth.me`, `PUBLIC_PORTAL_URL`, the session's
// tenant) is tested in (console)/layout.test.tsx.
import type { StaffRole } from "@velexis/ota-sdk";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TENANT_ID, TEST_PORTAL_URL } from "@/test/fake-ota-api";

import {
  BILLING_ROLES,
  BILLING_STRINGS,
  BillingBanner,
  canViewBilling,
  isBillingNotice,
  portalBillingUrl,
} from "./billing-banner";

const BILLING_PAGE = `${TEST_PORTAL_URL}/otas/${TENANT_ID}/billing`;

function banner(
  notice: string | null | undefined,
  options: { readonly tenantId?: string; readonly role?: StaffRole } = {},
) {
  return render(
    <div data-testid="shell">
      <BillingBanner
        notice={notice}
        portalUrl={TEST_PORTAL_URL}
        tenantId={options.tenantId ?? TENANT_ID}
        role={options.role ?? "owner"}
      />
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

  it("[FIX-W41-OTA AC3] words an ending trial so that it holds before and after the trial's end", () => {
    // The platform's manual-trial run keeps trial_ending from 14 days before the trial's end until a plan replaces the
    // trial or the OTA is suspended at least 14 days after it (lead decision (2k) of 2026-11-04): no promise of an end
    // still to come.
    banner("trial_ending", { role: "agent" });

    const status = screen.getByRole("status");
    expect(within(status).getByText("Your trial is ending: choose a plan in the portal")).toBeTruthy();
    expect(status.textContent).toContain(
      "The Velexis trial of this OTA is ending or has ended. The console keeps working for now; " +
        "the OTA is suspended if no plan is chosen.",
    );
    const words = `${BILLING_STRINGS.trial_ending.title} ${BILLING_STRINGS.trial_ending.detail}`;
    for (const promise of [
      /\bsoon\b/i,
      /\bwill end\b/i,
      /\bends\b/i,
      /\bafter the trial\b/i,
      /\bdays? left\b/i,
    ]) {
      expect([promise.source, promise.test(words)]).toEqual([promise.source, false]);
    }
    // No count of days and no date, which would be wrong on one side of the end.
    expect(words).not.toMatch(/[0-9]/);
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
    banner("past_due", { tenantId: "../../elsewhere" });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(BILLING_STRINGS.past_due.title);
    expect(within(alert).queryByRole("link")).toBeNull();
  });

  it("[FIX-W39-OTA AC5] links owner and finance to the portal's billing page, the roles the portal lets open it", () => {
    for (const role of ["owner", "finance"] as const) {
      banner("past_due", { role });

      const alert = screen.getByRole("alert");
      expect([
        role,
        within(alert).getByRole("link", { name: BILLING_STRINGS.link }).getAttribute("href"),
      ]).toEqual([role, BILLING_PAGE]);
      expect(alert.textContent).not.toContain(BILLING_STRINGS.billingRoles);
      cleanup();
    }
  });

  it("[FIX-W39-OTA AC5] shows every other role the notice without the link, and who manages billing", () => {
    for (const role of ["admin", "agent", "viewer"] as const) {
      for (const notice of ["past_due", "trial_ending"] as const) {
        banner(notice, { role });

        const strip = screen.getByRole(notice === "past_due" ? "alert" : "status");
        expect([role, strip.getAttribute("data-notice")]).toEqual([role, notice]);
        expect(strip.textContent).toContain(BILLING_STRINGS[notice].title);
        expect(strip.textContent).toContain(BILLING_STRINGS[notice].detail);
        expect(strip.textContent).toContain(BILLING_STRINGS.billingRoles);
        expect([role, within(strip).queryByRole("link")]).toEqual([role, null]);
        expect(document.body.innerHTML).not.toContain("/billing");
        cleanup();
      }
    }
  });
});

describe("canViewBilling", () => {
  it("[FIX-W39-OTA AC5] is the portal's viewBilling rule: owner and finance, no other role or value", () => {
    expect(BILLING_ROLES).toEqual(["owner", "finance"]);
    expect(["owner", "admin", "agent", "finance", "viewer", "", null, undefined].map(canViewBilling)).toEqual(
      [true, false, false, true, false, false, false, false],
    );
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
