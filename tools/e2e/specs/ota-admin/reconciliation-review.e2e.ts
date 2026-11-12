// The OTA admin's Reconciliation review journey (OAD-022; ota/admin/docs/routes.md §3.2 "Actions", OBE-099's
// console.bookings.closeReview, OADR-0003 point 5 and its follow-up, ota/docs/runbooks/supplier-timeout-and-reconciliation.md
// §4.3): an OTA that its owner created through the portal API (`createTenant`) and the OTA worker set up, so the journey
// needs `E2E_WITH_OTA=1` (the e2e workflow sets it).
//
//   two airline-card bookings whose Flight Create Orders answer was lost, handed to the staff by the reconciliation →
//   the owner opens the console from the portal → the Reconciliation review view lists both → the first one: "Close
//   the review", "Not booked", a note with a card number refused at the note without a change, then a note of what
//   was looked for → the booking failed, its payment failed (an airline card: nothing to release), the staff event
//   `booking.reconcile_closed` in its timeline → the second one: "Order found" with the record locator of an order
//   that does not carry the booking's remark, refused at the record locator without a change, then the order the agent
//   found → the booking confirmed with the order's record locator → the Reconciliation review view is empty
//
// The arrangement (tools/e2e/README.md, "Tests of OAD-022"). Both bookings are made in `beforeAll` through the OTA API
// as the OTA's storefront edge (`EdgeApi`; the airline card needs no Stripe, which the `ota-admin` project has not),
// each completion with the Amadeus stub's `server-error` scenario: Flight Create Orders answers 500 and stores no order,
// which the OTA cannot tell from a lost answer, so it answers `504 SUPPLIER_TIMEOUT` and keeps the booking `pending`
// with `reconcile_until` 15 minutes ahead (OADR-0003 point 2). The OTA has no booking queue, so its reconciliation
// cannot look for the order; at `reconcile_until` an airline-card booking goes to the staff's review instead of
// failing (the airline may have charged the card: `reconcile_outcome = manual_review`). No operation shortens those
// 15 minutes, so the one fixture of the journey moves the two bookings' `create_order_started_at` and `reconcile_until`
// 16 minutes back in the OTA's schema (`tenantTx` as velexis_ota_app); the OTA worker's own reconciliation then hands
// both to the review, which the journey waits for. The order the agent finds for the second booking is made straight
// at the stub with that booking's `VELEXIS <reference>` remark of sub-type BACKOFFICE, in the booking's queuing office
// (`createStubOrder` with `backofficeRemark`), as the lost order would be; a second stub order of the same office
// without the remark is the wrong record locator.
//
// Plan deviation (OAD-022 step 3): the plan's not-booked booking shows its payment `cancelled` once the void has run,
// which is a Stripe authorisation's; the `ota-admin` project runs without Stripe (its bookings are airline-card ones,
// as in every journey of the project), and an airline-card booking closed as not booked has nothing to void: its
// payment becomes `failed` and the traveller gets no e-mail (OBE-099, decision (18e) of 2026-11-12). The Stripe
// outcomes of both closures are proven by OBE-099's integration tests.
//
// Every page and dialog the journey visits passes axe once its title is in place, and on every page of the OTA admin
// JavaScript reads no cookie. Each closure and each refusal is also checked where the API records it: the booking's
// state, the staff action with the note as its reason, the staff event, and nothing at all after a refusal. The steps
// are tests in order (`mode: "serial"`) on one browser context of the owner, made in `beforeAll`.
import { type BrowserContext, type Page } from "@playwright/test";
import { sql } from "@velexis/db";
import { expectNoSeriousA11yViolations } from "../../support/a11y";
import { addSessionCookies, expect, newAccountContext, test, uniqueTestIp } from "../../support/fixtures";
import { uniqueEmail } from "../../support/mailpit";
import {
  bookLostAirlineCardTrip,
  createStubOrder,
  EdgeApi,
  newOwnerWithActiveOta,
  openConsoleFromPortal,
  scriptReadableCookieNames,
  switchAirlineCardOn,
  withTenantTx,
  type LostAnswerBooking,
  type OwnedOta,
  type SeedTraveller,
  type StubOrder,
} from "../../support/ota";
import { stack } from "../../support/seed";
import { OTA_ADMIN_URL } from "../../support/stack";

test.describe.configure({ mode: "serial" });

/** The note of the closure as not booked: what was looked for, never a card value. */
const NOT_BOOKED_NOTE =
  "Queue 50 and the Selling Platform checked for LOSTANSWER after the timeout; no order (OAD-022 journey).";
/** A note with the Visa test number in it: refused by the API at the note, and never stored. */
const NOTE_WITH_CARD = "The traveller read out the card 4111 1111 1111 1111 on the phone (OAD-022 journey).";
/** The note of the closure with the order found. */
const FOUND_NOTE = "Found in the queuing office with the booking's remark (OAD-022 journey).";

const NOT_BOOKED_TRAVELLER: SeedTraveller = {
  firstName: "Nora",
  lastName: "Lostanswer",
  dateOfBirth: "1988-05-14",
  gender: "FEMALE",
};
const FOUND_TRAVELLER: SeedTraveller = {
  firstName: "Felix",
  lastName: "Foundorder",
  dateOfBirth: "1981-11-03",
  gender: "MALE",
};

/**
 * How long the reconciliation may take to hand both bookings to the review once their window has passed: its first
 * attempt runs 30 s after the completion, and `bookings.reconcile_scan` queues another every minute.
 */
const REVIEW_WAIT_MS = 150_000;

/** The OTA admin's title of a page (`%s · Velexis OTA admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis OTA admin`;

/** A booking of the journey: its id, its checkout and payment, and the reference the OTA gave it. */
interface ReviewBooking extends LostAnswerBooking {
  readonly reference: string;
}

let owned: OwnedOta;
let notBooked: ReviewBooking;
let found: ReviewBooking;
/** The order the agent finds for `found`: its remark names `found`'s reference. */
let foundOrder: StubOrder;
/** An order of the same office without the remark: the wrong record locator. */
let strayOrder: StubOrder;
let context: BrowserContext;
let page: Page;

/** Waits until `target` shows the OTA admin's page `title`, then runs axe and checks that no cookie is readable. */
async function expectAdminPage(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(adminTitle(title));
  await expectNoSeriousA11yViolations(target);
  expect(await scriptReadableCookieNames(target)).toEqual([]);
}

/** The status badge of `kind` in the booking page's header (components/status-badge.tsx). */
const badge = (target: Page, kind: "booking" | "ticketing" | "payment") =>
  target.getByRole("main").locator(`[data-kind="${kind}"]`).first();

/** The review state of `bookings` as the OTA's schema holds it, by id. */
async function reviewStates(
  bookings: readonly LostAnswerBooking[],
): Promise<Record<string, { status: string; outcome: string | null }>> {
  const rows = await withTenantTx(owned.schema, (trx) =>
    trx
      .selectFrom("bookings")
      .select(["id", "status", "reconcile_outcome"])
      .where(
        "id",
        "in",
        bookings.map((booking) => booking.bookingId),
      )
      .execute(),
  );
  return Object.fromEntries(
    rows.map((row) => [row.id, { status: row.status, outcome: row.reconcile_outcome }]),
  );
}

/** What the API records of a closure of `booking`: its state, its staff actions and its closing events. */
async function closureRecords(booking: LostAnswerBooking) {
  return await withTenantTx(owned.schema, async (trx) => ({
    booking: await trx
      .selectFrom("bookings")
      .select(["status", "reconcile_outcome", "failure_code", "version"])
      .where("id", "=", booking.bookingId)
      .executeTakeFirstOrThrow(),
    payment: await trx
      .selectFrom("payments")
      .select(["status"])
      .where("id", "=", booking.paymentId)
      .executeTakeFirstOrThrow(),
    actions: await trx
      .selectFrom("staff_actions")
      .select(["outcome", "reason", "staff_role"])
      .where("booking_id", "=", booking.bookingId)
      .where("action", "=", "booking.reconcile_close")
      .execute(),
    events: await trx
      .selectFrom("booking_events")
      .select(["type"])
      .where("booking_id", "=", booking.bookingId)
      .where("type", "=", "booking.reconcile_closed")
      .execute(),
  }));
}

/** Opens the booking `reference` from the Reconciliation review view. */
async function openFromReview(reference: string): Promise<void> {
  await page.goto("/bookings");
  await expectAdminPage(page, "Bookings");
  await page.getByRole("link", { name: /^Reconciliation review/ }).click();
  await page.waitForURL((url) => url.searchParams.get("reconcileOutcome") === "manual_review");
  await page.getByRole("main").getByRole("link", { name: reference, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(reference);
  await expectAdminPage(page, "Booking");
}

/** Opens the "Close the review" dialog of the open booking `reference`. */
async function openReviewDialog(reference: string) {
  await page.getByRole("button", { name: "Close the review" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: `Close the reconciliation review of ${reference}?` }),
  ).toBeVisible();
  return dialog;
}

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "reconciliation-review.e2e.ts needs the OTA backend, the OTA admin and the Amadeus stub: run it with " +
        "E2E_WITH_OTA=1",
    );
  }
  // Budget: a sign-up with its verification e-mail (up to 15 s), the OTA's set-up on the OTA worker (about 2 s locally;
  // PF-11 allows a minute), two bookings through the OTA API and the stub (a second or two each), two orders in the
  // stub (milliseconds) and the reconciliation's hand-over to the staff (REVIEW_WAIT_MS).
  test.setTimeout(120_000 + REVIEW_WAIT_MS);
  owned = await newOwnerWithActiveOta("Rhea Reviewer", "rcr");
  await switchAirlineCardOn(owned.schema);
  const edge = new EdgeApi(owned.storefrontHost, uniqueTestIp());
  const lost = [
    await bookLostAirlineCardTrip(edge, {
      daysAhead: 62,
      traveller: NOT_BOOKED_TRAVELLER,
      email: uniqueEmail("oad022-notbooked"),
    }),
    await bookLostAirlineCardTrip(edge, {
      daysAhead: 63,
      traveller: FOUND_TRAVELLER,
      email: uniqueEmail("oad022-found"),
    }),
  ];

  // The fixture of the journey (no operation reaches it): the reconciliation's 15-minute window has passed. Only the
  // two times move; the bookings, their checkouts and their payments stay as checkout.completeWithAirlineCard left them.
  // The same transaction reads the references the OTA gave the bookings (the 504 names none) and the queuing office.
  const pending = await withTenantTx(owned.schema, async (trx) => {
    const moved = await trx
      .updateTable("bookings")
      .set({
        create_order_started_at: sql<Date>`create_order_started_at - interval '16 minutes'`,
        reconcile_until: sql<Date>`now() - interval '1 minute'`,
      })
      .where(
        "id",
        "in",
        lost.map((booking) => booking.bookingId),
      )
      .where("status", "=", "pending")
      .where("reconcile_outcome", "is", null)
      .where("reconcile_until", "is not", null)
      .executeTakeFirst();
    expect(Number(moved.numUpdatedRows)).toBe(2);
    return await trx
      .selectFrom("bookings")
      .select(["id", "reference", "queuing_office_id"])
      .where(
        "id",
        "in",
        lost.map((booking) => booking.bookingId),
      )
      .execute();
  });
  const withReference = (booking: LostAnswerBooking): ReviewBooking => {
    const row = pending.find((candidate) => candidate.id === booking.bookingId);
    if (row === undefined) {
      throw new Error("a lost booking is not in the OTA's schema");
    }
    return { ...booking, reference: row.reference };
  };
  const [first, second] = lost;
  if (first === undefined || second === undefined) {
    throw new Error("the journey books two trips");
  }
  notBooked = withReference(first);
  found = withReference(second);
  // The OTA worker's reconciliation hands both to the staff: no booking queue to search, an airline card.
  await expect
    .poll(async () => reviewStates(lost), { timeout: REVIEW_WAIT_MS, intervals: [1_000] })
    .toEqual({
      [notBooked.bookingId]: { status: "pending", outcome: "manual_review" },
      [found.bookingId]: { status: "pending", outcome: "manual_review" },
    });

  // The order the agent finds in the booking's queuing office, with the booking's remark, and another one without it.
  const officeId =
    pending.find((row) => row.id === found.bookingId)?.queuing_office_id ?? owned.connection.officeId;
  foundOrder = await createStubOrder({
    officeId,
    traveller: FOUND_TRAVELLER,
    email: uniqueEmail("oad022-found-order"),
    daysAhead: 63,
    backofficeRemark: `VELEXIS ${found.reference}`,
  });
  strayOrder = await createStubOrder({
    officeId,
    traveller: { ...FOUND_TRAVELLER, firstName: "Other" },
    email: uniqueEmail("oad022-stray-order"),
    daysAhead: 64,
  });

  context = await newAccountContext(browser, owned.owner.account, OTA_ADMIN_URL);
  await addSessionCookies(context, "portal", owned.session);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("the owner opens the console and the Reconciliation review view lists both bookings [OAD-022 AC1]", async () => {
  await openConsoleFromPortal(page, owned.ota.id);
  await expect(page.getByText(owned.ota.name, { exact: true })).toBeVisible();
  await expectAdminPage(page, "Bookings");

  await page.getByRole("link", { name: /^Reconciliation review/ }).click();
  await page.waitForURL((url) => url.searchParams.get("reconcileOutcome") === "manual_review");
  const list = page.getByRole("main");
  await expect(list.getByRole("link", { name: notBooked.reference, exact: true })).toBeVisible();
  await expect(list.getByRole("link", { name: found.reference, exact: true })).toBeVisible();
  await expectAdminPage(page, "Bookings");
});

test("closes the first booking as not booked: a card number is refused at the note, then the booking fails [OAD-022 AC1]", async () => {
  await openFromReview(notBooked.reference);
  await expect(badge(page, "booking")).toHaveText("Pending");
  await expect(page.locator('[data-attention="reconcile-review"]')).toContainText(
    "Reconciliation needs staff review",
  );
  const before = await closureRecords(notBooked);

  const dialog = await openReviewDialog(notBooked.reference);
  // An airline card: nothing to release, the agent asks the airline about a charge and contacts the traveller.
  await expect(
    dialog.getByText("ask the airline whether it charged the card", { exact: false }),
  ).toBeVisible();
  await dialog.getByRole("radio", { name: "Not booked" }).check();
  const note = dialog.getByRole("textbox", { name: "Note (required)" });
  await note.fill(NOTE_WITH_CARD);
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole("button", { name: "Close the review" }).click();

  // The API's refusal at the note; the dialog stays open, and nothing changed.
  await expect(dialog.getByText("A note never holds a card number: remove it.")).toBeVisible();
  await expect(note).toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toBeVisible();
  expect(await closureRecords(notBooked)).toEqual(before);
  expect(before.actions).toEqual([]);

  await note.fill(NOT_BOOKED_NOTE);
  await dialog.getByRole("button", { name: "Close the review" }).click();
  // The page's new render: the booking failed and has left the review, so the action and its dialog are gone.
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(badge(page, "booking")).toHaveText("Failed");
  // The payment as the page shows it: the airline card's payment failed (nothing to release), not a captured one.
  await expect(badge(page, "payment")).toHaveText("Payment failed");
  await expect(page.locator('[data-attention="failed"]')).toContainText("SUPPLIER_TIMEOUT");
  await expect(page.locator('[data-attention="reconcile-review"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close the review" })).toHaveCount(0);
  await expectAdminPage(page, "Booking");

  // The timeline holds the staff event.
  await page.getByRole("link", { name: "Timeline and notes" }).click();
  await expect(page.locator('[data-event-type="booking.reconcile_closed"]')).toHaveCount(1);
  await expectAdminPage(page, "Booking");

  // As the API recorded it: failed as the reconciliation's not-found decision, the airline-card payment failed (no
  // void: Velexis never charged the card), the owner's staff action with the note as its reason, one staff event.
  const after = await closureRecords(notBooked);
  expect(after.booking).toMatchObject({
    status: "failed",
    reconcile_outcome: "not_found",
    failure_code: "SUPPLIER_TIMEOUT",
  });
  expect(after.payment).toEqual({ status: "failed" });
  expect(after.actions).toEqual([{ outcome: "succeeded", reason: NOT_BOOKED_NOTE, staff_role: "owner" }]);
  expect(after.events).toHaveLength(1);
});

test("closes the second booking with its order found: a record locator without its remark is refused, then the order is recorded [OAD-022 AC1]", async () => {
  await openFromReview(found.reference);
  await expect(badge(page, "booking")).toHaveText("Pending");
  const before = await closureRecords(found);

  const dialog = await openReviewDialog(found.reference);
  await dialog.getByRole("radio", { name: "Order found" }).check();
  const recordLocator = dialog.getByRole("textbox", { name: "Record locator" });
  // Typed in lower case: the action sends the API's capitals.
  await recordLocator.fill(strayOrder.recordLocator.toLowerCase());
  await dialog.getByRole("textbox", { name: "Note" }).fill(FOUND_NOTE);
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole("button", { name: "Close the review" }).click();

  // `remark_mismatch` at the record locator; the dialog stays open, and nothing changed.
  // The refusal in the dialog's alert and at the record locator (its field error, in its accessible description).
  await expect(dialog.getByRole("alert")).toContainText("does not carry this booking's remark");
  await expect(recordLocator).toHaveAttribute("aria-invalid", "true");
  await expect(recordLocator).toHaveAccessibleDescription(/does not carry this booking's remark/);
  expect(await closureRecords(found)).toEqual(before);

  await recordLocator.fill(foundOrder.recordLocator);
  await dialog.getByRole("button", { name: "Close the review" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(badge(page, "booking")).toHaveText("Confirmed");
  await expect(page.locator('[data-attention="reconcile-review"]')).toHaveCount(0);
  await expect(page.getByRole("main")).toContainText(foundOrder.recordLocator);
  await expect(page.getByRole("button", { name: "Close the review" })).toHaveCount(0);
  await expectAdminPage(page, "Booking");

  await page.getByRole("link", { name: "Timeline and notes" }).click();
  await expect(page.locator('[data-event-type="booking.reconcile_closed"]')).toHaveCount(1);
  await expectAdminPage(page, "Booking");

  const after = await closureRecords(found);
  expect(after.booking).toMatchObject({ status: "confirmed", reconcile_outcome: "found" });
  expect(after.actions).toEqual([{ outcome: "succeeded", reason: FOUND_NOTE, staff_role: "owner" }]);
  expect(after.events).toHaveLength(1);
  const recorded = await withTenantTx(owned.schema, (trx) =>
    trx
      .selectFrom("booking_associated_records")
      .select("reference")
      .where("booking_id", "=", found.bookingId)
      .execute(),
  );
  expect(recorded.map((record) => record.reference)).toContain(foundOrder.recordLocator);
});

test("both bookings have left the Reconciliation review view [OAD-022 AC1]", async () => {
  await page.goto("/bookings");
  await expectAdminPage(page, "Bookings");
  await page.getByRole("link", { name: /^Reconciliation review/ }).click();
  await page.waitForURL((url) => url.searchParams.get("reconcileOutcome") === "manual_review");
  await expect(page.getByText("No reconciliation waits for staff.")).toBeVisible();
  const list = page.getByRole("main");
  await expect(list.getByRole("link", { name: notBooked.reference, exact: true })).toHaveCount(0);
  await expect(list.getByRole("link", { name: found.reference, exact: true })).toHaveCount(0);
  await expectAdminPage(page, "Bookings");
});
