// Smoke test of the end-to-end harness (PFE-014): the stack starts from the built apps, the portal serves its landing
// page without a serious or critical accessibility violation, and the platform admin answers its liveness check (the
// admin has no page yet; PAD-010 adds the admin journeys). Each test runs in the project of its tag only.
import { expectNoSeriousA11yViolations } from "../support/a11y";
import { expect, PROJECT_TAGS, test } from "../support/fixtures";

test(
  "the portal landing page loads with no serious or critical axe violation [PFE-014 AC1]",
  { tag: PROJECT_TAGS.portal },
  async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/Velexis/);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  },
);

test(
  "the platform admin answers 200 on /health/live [PFE-014 AC1]",
  { tag: PROJECT_TAGS.platformAdmin },
  async ({ request }) => {
    const response = await request.get("/health/live");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  },
);
