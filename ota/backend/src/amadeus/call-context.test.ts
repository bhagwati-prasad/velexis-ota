// The office a call on a booking's existing order names (call-context.ts `bookingOrderOffice`, OADR-0001 point 3, lead
// decision (2n) of 2026-11-02): one helper for every caller that names an order's office (the booking sync, the
// ticketing, the cancellations, the changes, the console's actions and raw reads). The booking sync's use of it against
// PostgreSQL, Redis and two Amadeus stubs is test/integration/amadeus/own-credentials.int.test.ts.
import { describe, expect, it } from "vitest";
import { newId } from "../common/ids";
import { bookingOrderOffice, checkCallContext, orderOfficeContext } from "./call-context";

const OWNER = "NCE1A0955";
const QUEUING = "NCE1A0956";

describe("bookingOrderOffice", () => {
  it("[FIX-W39-OTA AC4] names the owner office, else the queuing office when the booking has no owner office", () => {
    expect(bookingOrderOffice({ ownerOfficeId: OWNER, queuingOfficeId: QUEUING })).toBe(OWNER);
    expect(bookingOrderOffice({ ownerOfficeId: null, queuingOfficeId: QUEUING })).toBe(QUEUING);
    // An empty column is no office either.
    expect(bookingOrderOffice({ ownerOfficeId: "", queuingOfficeId: QUEUING })).toBe(QUEUING);
  });

  it("[FIX-W39-OTA AC4] names none for a booking without either office: the connection's current offices serve it", () => {
    expect(bookingOrderOffice({ ownerOfficeId: null, queuingOfficeId: null })).toBeNull();
    expect(bookingOrderOffice({ ownerOfficeId: "", queuingOfficeId: "" })).toBeNull();
  });
});

describe("orderOfficeContext", () => {
  it("[FIX-W39-OTA AC4] gives a call context the booking's order office, or nothing", () => {
    const context = (offices: { ownerOfficeId: string | null; queuingOfficeId: string | null }) =>
      checkCallContext({
        tenantId: newId("ten"),
        environment: "test",
        operation: "bookings.sync",
        requestId: "req_01JA4H1A3C5E7G9J1L3N5Q7S9U",
        ...orderOfficeContext(offices),
      });

    expect(context({ ownerOfficeId: OWNER, queuingOfficeId: QUEUING }).orderOffice).toBe(OWNER);
    expect(context({ ownerOfficeId: null, queuingOfficeId: QUEUING }).orderOffice).toBe(QUEUING);
    expect(orderOfficeContext({ ownerOfficeId: null, queuingOfficeId: null })).toEqual({});
    expect(context({ ownerOfficeId: null, queuingOfficeId: null }).orderOffice).toBeUndefined();
  });
});
