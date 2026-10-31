// The OTA admin's PNR import journey (OAD-016; ota/admin/docs/routes.md §4, ota/docs/flows/console-operations.md §2
// "PNR lookup and import", ADR-0012 "Office isolation on the shared account", scope OF-09 AC3): an OTA that its owner
// created through the portal API (`createTenant`) and the OTA worker set up with an office of the Velexis test pool, so
// the journey needs `E2E_WITH_OTA=1` (the e2e workflow sets it).
//
//   the owner opens the console from the portal → /pnr → the record locator of an order an agent made in the Amadeus
//   stub for this OTA's office (a GDS terminal booking Velexis never saw) → the order with "Import as a booking" →
//   imported with a reason → the new booking (channel import, manual review: nothing was issued or paid through
//   Velexis) → the record locator of an order of another OTA's office (the demo OTA's) → refused: "This order belongs
//   to an office outside this OTA", nothing of it shown, nothing to import
//
// On the shared Velexis account every OTA's offices answer to the same credentials, and the stub, like Amadeus's
// by-reference read, answers an order whoever asks; which OTA may see it is the OTA API's office isolation. The orders
// are made in `beforeAll` straight at the stack's stub (`createStubOrder` of support/ota.ts: a token, a search and
// Flight Create Orders, queued and owned by the office), so no Velexis booking or `supplier_requests` row exists for
// them. Every page the journey visits passes axe once its title is in place, and JavaScript reads no cookie on any page
// of the OTA admin. The steps are tests in order (`mode: "serial"`) on one browser context of the owner.
import { type BrowserContext, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y";
import { addSessionCookies, expect, newAccountContext, test } from "../../support/fixtures";
import { uniqueEmail } from "../../support/mailpit";
import {
  activeAmadeusConnectionOf,
  createStubOrder,
  demoTenantId,
  newOwnerWithActiveOta,
  openConsoleFromPortal,
  scriptReadableCookieNames,
  withTenantTx,
  type OwnedOta,
  type StubOrder,
} from "../../support/ota";
import { stack } from "../../support/seed";
import { OTA_ADMIN_URL } from "../../support/stack";

test.describe.configure({ mode: "serial" });

const IMPORT_REASON = "Booked by phone in the GDS terminal; bring it into the console (OAD-016 journey).";

/** The OTA admin's title of a page (`%s · Velexis OTA admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis OTA admin`;

let owned: OwnedOta;
/** The order of this OTA's office. */
let ownOrder: StubOrder;
/** The order of another OTA's office (the demo OTA's). */
let foreignOrder: StubOrder;
let foreignOfficeId: string;
let context: BrowserContext;
let page: Page;

/** Waits until `target` shows the OTA admin's page `title`, then runs axe and checks that no cookie is readable. */
async function expectAdminPage(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(adminTitle(title));
  await expectNoSeriousA11yViolations(target);
  expect(await scriptReadableCookieNames(target)).toEqual([]);
}

/** Looks the record locator up in /pnr's form, as staff type it. */
async function lookUp(recordLocator: string): Promise<void> {
  await page.getByRole("textbox", { name: "Record locator" }).fill(recordLocator.toLowerCase());
  await page.getByRole("button", { name: "Look up" }).click();
  await page.waitForURL((url) => url.pathname === "/pnr" && url.searchParams.get("recordLocator") !== null);
}

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "pnr-import.e2e.ts needs the OTA backend, the OTA admin and the Amadeus stub: run it with E2E_WITH_OTA=1",
    );
  }
  // Budget: a sign-up with its verification e-mail (up to 15 s), the OTA's set-up on the OTA worker (about 2 s locally;
  // PF-11 allows a minute) and two orders in the stub (milliseconds).
  test.setTimeout(90_000);
  owned = await newOwnerWithActiveOta("Pia Importer", "pnr");
  const demoConnection = await activeAmadeusConnectionOf(await demoTenantId());
  if (demoConnection === undefined) {
    throw new Error(
      "the demo OTA has no active Amadeus test connection (the OTA backend's dev:seed sets one up)",
    );
  }
  foreignOfficeId = demoConnection.officeId;
  expect(owned.connection.officeIds).not.toContain(foreignOfficeId);
  ownOrder = await createStubOrder({
    officeId: owned.connection.officeId,
    traveller: { firstName: "Gita", lastName: "Terminal", dateOfBirth: "1990-06-30", gender: "FEMALE" },
    email: uniqueEmail("oad016-pnr"),
    daysAhead: 58,
  });
  foreignOrder = await createStubOrder({
    officeId: foreignOfficeId,
    traveller: { firstName: "Otto", lastName: "Elsewhere", dateOfBirth: "1975-12-01", gender: "MALE" },
    email: uniqueEmail("oad016-pnr-other"),
    daysAhead: 59,
  });

  context = await newAccountContext(browser, owned.owner.account, OTA_ADMIN_URL);
  await addSessionCookies(context, "portal", owned.session);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("the owner opens the console from the portal and goes to the PNR lookup [OAD-016 AC1]", async () => {
  await openConsoleFromPortal(page, owned.ota.id);
  await expect(page.getByText(owned.ota.name, { exact: true })).toBeVisible();
  await expectAdminPage(page, "Bookings");
  await page.goto("/pnr");
  await expect(page.getByRole("heading", { level: 1, name: "PNR lookup" })).toBeVisible();
  await expectAdminPage(page, "PNR lookup");
});

test("imports the PNR an agent made in the stub for the OTA's office [OAD-016 AC1]", async () => {
  await lookUp(ownOrder.recordLocator);
  // Typed in lower case, looked up in the API's spelling: capitals.
  await expect(
    page.getByRole("heading", { level: 2, name: `1 order with record locator ${ownOrder.recordLocator}` }),
  ).toBeVisible();
  // The order of this OTA's office, with its traveller as Amadeus writes the name.
  const match = page.getByRole("region", { name: `Amadeus order ${ownOrder.id}` });
  await expect(match.getByText("TERMINAL/GITA", { exact: true })).toBeVisible();
  await expect(match.getByText(owned.connection.officeId, { exact: true })).toBeVisible();
  await expectAdminPage(page, "PNR lookup");

  await match.getByRole("button", { name: "Import as a booking" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: `Import ${ownOrder.recordLocator} as a booking?` }),
  ).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "No customer: a guest booking" })).toBeChecked();
  await dialog.getByRole("textbox", { name: "Reason" }).fill(IMPORT_REASON);
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole("button", { name: "Import", exact: true }).click();

  // The new booking opens: imported, confirmed, waiting for the staff to issue it (nothing was issued at Amadeus).
  await page.waitForURL(
    (url) => url.origin === OTA_ADMIN_URL && /^\/bookings\/bkg_[0-9A-Za-z]+$/.test(url.pathname),
  );
  const bookingId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
  const header = page.getByRole("main");
  await expect(header.locator('[data-kind="booking"]').first()).toHaveText("Confirmed");
  await expect(header.locator('[data-kind="ticketing"]').first()).toHaveText("Manual review");
  await expect(header.getByText(ownOrder.recordLocator, { exact: true }).first()).toBeVisible();
  await expectAdminPage(page, "Booking");

  // The booking of this OTA: channel import, the stub's order, made by the staff member, with the reason audited.
  const imported = await withTenantTx(owned.schema, async (trx) => ({
    booking: await trx
      .selectFrom("bookings")
      .select(["channel", "amadeus_order_id", "record_locator"])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
    action: await trx
      .selectFrom("staff_actions")
      .select(["action", "outcome", "reason"])
      .where("booking_id", "=", bookingId)
      .where("action", "=", "booking.import")
      .execute(),
  }));
  expect(imported.booking).toEqual({
    channel: "import",
    amadeus_order_id: ownOrder.id,
    record_locator: ownOrder.recordLocator,
  });
  expect(imported.action).toEqual([
    { action: "booking.import", outcome: "succeeded", reason: IMPORT_REASON },
  ]);

  // The same record locator again: the order is a booking of this OTA now, linked instead of offered for import.
  await page.goto(`/pnr?recordLocator=${ownOrder.recordLocator}`);
  await expect(page.getByText("Already a booking of this OTA:", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import as a booking" })).toHaveCount(0);
  await expectAdminPage(page, "PNR lookup");
});

test("refuses the PNR of another OTA's office, showing nothing of it [OAD-016 AC1]", async () => {
  await page.goto("/pnr");
  await expectAdminPage(page, "PNR lookup");
  await lookUp(foreignOrder.recordLocator);
  await expect(
    page.getByRole("heading", { level: 2, name: "This order belongs to an office outside this OTA" }),
  ).toBeVisible();
  // This OTA's own offices are named, the other office never; neither its traveller nor an import is offered.
  const offices = page.locator("[data-offices]");
  await expect(offices).toContainText(owned.connection.officeId);
  await expect(page.getByRole("main")).not.toContainText(foreignOfficeId);
  await expect(page.getByRole("main")).not.toContainText("ELSEWHERE");
  await expect(page.getByRole("button", { name: "Import as a booking" })).toHaveCount(0);
  await expectAdminPage(page, "PNR lookup");

  // Nothing of the other office's order reached this OTA: no booking; the lookup is a denied staff action.
  const leaked = await withTenantTx(owned.schema, async (trx) => ({
    bookings: await trx
      .selectFrom("bookings")
      .select("id")
      .where("record_locator", "=", foreignOrder.recordLocator)
      .execute(),
    actions: await trx
      .selectFrom("staff_actions")
      .select(["action", "outcome"])
      .where("target_type", "=", "record_locator")
      .where("target_id", "=", foreignOrder.recordLocator)
      .execute(),
  }));
  expect(leaked.bookings).toEqual([]);
  // The refusal is the staff member's denied lookup, audited with the record locator alone.
  expect(leaked.actions).toEqual([{ action: "bookings.findByRecordLocator", outcome: "denied" }]);
});
