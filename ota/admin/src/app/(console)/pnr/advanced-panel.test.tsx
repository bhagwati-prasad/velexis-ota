// @vitest-environment happy-dom
// The Advanced panel of the PNR lookup (OAD-010: advanced-panel.tsx) in a DOM, with its server actions mocked (README
// §12): each raw read runs from its button only (the record locator's orders, then one order), the answers are shown
// with the call's facts, the booking attached to an order and the verbatim answer open, a refusal with its request id,
// and the panel says the prices are net. Every id here is a dummy.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  importBooking: vi.fn(),
  searchCustomers: vi.fn(),
  readRawOrders: vi.fn(),
  readRawOrder: vi.fn(),
}));
vi.mock("./actions", () => actions);

import type { RawOrderState, RawOrdersState } from "./actions";
import { ADVANCED_STRINGS, AdvancedPanel } from "./advanced-panel";

const ORDER_ID = "eJzTd9cPNfX09DUFAAsGAkT";
const OTHER_ORDER_ID = "eJzTd9cPNfX09DUFAAsGAkV";
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";

/** How long a step that runs a (fake) server action through React's transition may take before a wait gives up. */
const UI_WAIT = { timeout: 3_000 } as const;

const CALL = {
  supplierRequestId: "sreq_01JA4H9Z1B3D5F7H9K1M3P5R7T",
  environment: "test",
  officeId: "OSLN12345",
  amadeusApi: "GetFlightOrderByRecordLocator",
  amadeusOperationId: "getFlightOrder",
  httpMethod: "GET",
  path: "/v1/booking/flight-orders/by-reference",
  httpStatus: 200,
  durationMs: 980,
  correlationId: null,
  staffActionId: "sact_01JA4H1A4D6F8H0K2M4P6R8T0W",
} as const;

const ORDERS: RawOrdersState = {
  ok: true,
  result: {
    call: CALL,
    matches: [
      { flightOrderId: ORDER_ID, bookingId: null },
      { flightOrderId: OTHER_ORDER_ID, bookingId: BOOKING_ID },
    ],
    amadeus: {
      data: [
        { type: "flight-order", id: ORDER_ID, queuingOfficeId: "OSLN12345", flightOffers: [] },
        { type: "flight-order", id: OTHER_ORDER_ID, ownerOfficeId: "OSLN12345", flightOffers: [] },
      ],
    },
  },
};

const ORDER: RawOrderState = {
  ok: true,
  result: {
    call: {
      ...CALL,
      amadeusApi: "FlightOrderManagement",
      path: `/v1/booking/flight-orders/${OTHER_ORDER_ID}`,
    },
    flightOrderId: OTHER_ORDER_ID,
    bookingId: BOOKING_ID,
    bookingSynced: false,
    amadeus: { data: { type: "flight-order", id: OTHER_ORDER_ID, flightOffers: [] } },
  },
};

/** Clicks the button `name` once it is enabled (the panel's buttons wait while a read runs). */
async function clickWhenEnabled(name: string): Promise<void> {
  const button = screen.getByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false), UI_WAIT);
  fireEvent.click(button);
}

// Once per file: the first render and React's first transition are the slowest in a fresh worker; on a busy CI runner
// they would otherwise land in the first test's own five seconds. Nothing of it stays.
beforeAll(async () => {
  actions.readRawOrders.mockResolvedValue(ORDERS);
  render(<AdvancedPanel reference="L2P9XC" flightOrderIds={[ORDER_ID]} />);
  await clickWhenEnabled(ADVANCED_STRINGS.byReference("L2P9XC"));
  await screen.findByText(ADVANCED_STRINGS.orders(2), {}, UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  for (const action of Object.values(actions)) {
    action.mockReset();
  }
  actions.readRawOrders.mockResolvedValue(ORDERS);
  actions.readRawOrder.mockResolvedValue(ORDER);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("AdvancedPanel", () => {
  it("reads the record locator's raw orders only when asked, then one order, and shows each answer verbatim", async () => {
    render(<AdvancedPanel reference="L2P9XC" flightOrderIds={[ORDER_ID]} />);

    const panel = screen.getByRole("region", { name: ADVANCED_STRINGS.title });
    expect(panel.textContent).toContain(
      "Their prices are Amadeus net prices, before this OTA's markup and fees.",
    );
    expect(actions.readRawOrders).not.toHaveBeenCalled();
    expect(actions.readRawOrder).not.toHaveBeenCalled();
    // The lookup's order can be read before the by-reference answer; the other order of the locator comes with it.
    expect(within(panel).getByRole("button", { name: ADVANCED_STRINGS.order(ORDER_ID) })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: ADVANCED_STRINGS.order(OTHER_ORDER_ID) })).toBeNull();

    await clickWhenEnabled(ADVANCED_STRINGS.byReference("L2P9XC"));
    await waitFor(() => expect(actions.readRawOrders).toHaveBeenCalledWith("L2P9XC"), UI_WAIT);
    const answer = await within(panel).findByText(ADVANCED_STRINGS.orders(2), {}, UI_WAIT);
    const byReference = answer.closest("[data-answer]") as HTMLElement;
    expect(byReference.textContent).toContain(
      "Amadeus GetFlightOrderByRecordLocator · HTTP 200 · 980 ms · office OSLN12345 · Amadeus request id none · call log sreq_01JA4H9Z1B3D5F7H9K1M3P5R7T",
    );
    expect(byReference.textContent).toContain(`${ORDER_ID}office OSLN12345Not a booking of this OTA`);
    expect(within(byReference).getByRole("link", { name: BOOKING_ID }).getAttribute("href")).toBe(
      `/bookings/${BOOKING_ID}`,
    );
    const verbatim = within(byReference).getByRole("region", { name: ADVANCED_STRINGS.verbatimOrders });
    expect(verbatim.textContent).toContain(`"id": "${OTHER_ORDER_ID}"`);

    await clickWhenEnabled(ADVANCED_STRINGS.order(OTHER_ORDER_ID));
    await waitFor(() => expect(actions.readRawOrder).toHaveBeenCalledWith(OTHER_ORDER_ID), UI_WAIT);
    const order = await within(panel).findByRole(
      "region",
      { name: ADVANCED_STRINGS.verbatimOrder(OTHER_ORDER_ID) },
      UI_WAIT,
    );
    const orderAnswer = order.closest("[data-answer]") as HTMLElement;
    expect(orderAnswer.textContent).toContain(`Attached to the booking ${BOOKING_ID}`);
    expect(actions.readRawOrders).toHaveBeenCalledTimes(1);
  });

  it("shows a refused read with its request id", async () => {
    actions.readRawOrder.mockResolvedValueOnce({
      ok: false,
      code: "OFFICE_NOT_ALLOWED",
      message:
        "This order belongs to an Amadeus office outside this OTA: Velexis shows only the orders of its own offices.",
      requestId: "req_403",
    } satisfies RawOrderState);
    render(<AdvancedPanel reference="L2P9XC" flightOrderIds={[ORDER_ID]} />);

    await clickWhenEnabled(ADVANCED_STRINGS.order(ORDER_ID));

    const alert = await screen.findByRole("alert", {}, UI_WAIT);
    expect(alert.textContent).toContain("This order belongs to an Amadeus office outside this OTA");
    expect(alert.textContent).toContain("req_403");
    expect(actions.readRawOrder).toHaveBeenCalledWith(ORDER_ID);
  });
});
