"use client";

// The Advanced panel of the PNR lookup `/pnr` (routes.md §4 "Advanced", OAD-010 on OBE-067's raw reads): for staff with
// `amadeus:read`, Amadeus's own answers about the record locator, for support. Two raw console reads, each a button
// that runs a server action of actions.ts (never a read while the page renders: each is an Amadeus call and an audited
// read, `amadeus.<operationId>` in staff_actions):
//
//   "Read the orders of <locator>"   console.amadeus.getFlightOrderByReference   Get Flight Order By Record Locator
//   "Read order <id>"                console.amadeus.getFlightOrder              Flight Order Management GET
//
// The orders to read one by one are those of the lookup's matches and of the by-reference answer. Each answer is shown
// as the API returns it (already redacted: no card number, documents cut to their last 4 characters), open in a JSON
// view, with the call's facts and the booking of this OTA attached to an order, if any. The prices in these answers are
// Amadeus net prices, before the OTA's markup and fees: the panel says so. No customer-scope operation, no input that
// asks for a card.
import type { ConsoleAmadeusCall } from "@velexis/ota-sdk";
import Link from "next/link";
import { useId, useState, useTransition } from "react";

import { JsonView } from "@/components/json-view";
import { Button } from "@/components/ui/button";

import {
  readRawOrder,
  readRawOrders,
  type RawOrderState,
  type RawOrdersState,
  type RawReadState,
} from "./actions";
import { bookingPath } from "./import-rules";

export const ADVANCED_STRINGS = Object.freeze({
  title: "Advanced: raw Amadeus answers",
  intro:
    "For support: Amadeus's own answers about this record locator, as the API returns them (redacted). Their prices are Amadeus net prices, before this OTA's markup and fees. Each read calls Amadeus and is recorded in the audit trail.",
  byReference: (reference: string) => `Read the orders of ${reference}`,
  order: (id: string) => `Read order ${id}`,
  reading: "Asking Amadeus…",
  orders: (count: number) => `${count} order${count === 1 ? "" : "s"} of the OTA's offices`,
  office: (office: string) => `office ${office}`,
  booking: "Booking of this OTA:",
  notBooking: "Not a booking of this OTA",
  attached: "Attached to the booking",
  verbatimOrders: "Get Flight Order By Record Locator (verbatim, net prices)",
  verbatimOrder: (id: string) => `Flight Order Management: order ${id} (verbatim, net prices)`,
  requestId: "Request id",
  call: (call: ConsoleAmadeusCall) =>
    [
      `Amadeus ${call.amadeusApi}`,
      `HTTP ${call.httpStatus}`,
      `${call.durationMs} ms`,
      `office ${call.officeId ?? "none"}`,
      `Amadeus request id ${call.correlationId ?? "none"}`,
      `call log ${call.supplierRequestId}`,
    ].join(" · "),
});

const LINK_CLASS = "font-mono font-medium text-primary underline underline-offset-4";

export interface AdvancedPanelProps {
  /** The record locator that was looked up, in the API's spelling. */
  readonly reference: string;
  /** The Amadeus order ids of the lookup's matches (none when the lookup found none). */
  readonly flightOrderIds: readonly string[];
}

/** A refused or failed read: the message and the request id. */
function ReadFailure({ state }: { readonly state: RawReadState<unknown> }) {
  if (state.ok) {
    return null;
  }
  return (
    <div role="alert" className="grid gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm">
      <p className="font-medium">{state.message}</p>
      {state.requestId === undefined ? null : (
        <p className="text-muted-foreground">
          {ADVANCED_STRINGS.requestId}: <code>{state.requestId}</code>
        </p>
      )}
    </div>
  );
}

/** The facts of the Amadeus call behind an answer. */
function CallFacts({ call }: { readonly call: ConsoleAmadeusCall }) {
  return (
    <p className="text-xs text-muted-foreground" data-call={call.supplierRequestId}>
      {ADVANCED_STRINGS.call(call)}
    </p>
  );
}

/** The by-reference answer: its orders with their office and booking, and the verbatim answer. */
function OrdersAnswer({ state }: { readonly state: RawOrdersState }) {
  if (!state.ok) {
    return <ReadFailure state={state} />;
  }
  const { result } = state;
  const bookings = new Map(result.matches.map((match) => [match.flightOrderId, match.bookingId]));
  return (
    <div className="grid gap-2" data-answer="by-reference">
      <p className="text-sm font-medium">{ADVANCED_STRINGS.orders(result.amadeus.data.length)}</p>
      <CallFacts call={result.call} />
      <ul className="grid gap-1 text-sm">
        {result.amadeus.data.map((order, index) => {
          const id = order.id ?? "";
          const office = order.ownerOfficeId ?? order.queuingOfficeId;
          const bookingId = bookings.get(id) ?? null;
          return (
            // By position: an order without an id is still listed.
            <li key={`${id}-${index}`} className="flex flex-wrap items-center gap-2">
              <code className="break-all">{id === "" ? "?" : id}</code>
              {office === undefined ? null : (
                <span className="text-muted-foreground">{ADVANCED_STRINGS.office(office)}</span>
              )}
              {bookingId === null ? (
                <span className="text-muted-foreground">{ADVANCED_STRINGS.notBooking}</span>
              ) : (
                <span>
                  {ADVANCED_STRINGS.booking}{" "}
                  <Link href={bookingPath(bookingId)} prefetch={false} className={LINK_CLASS}>
                    {bookingId}
                  </Link>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <JsonView value={result.amadeus} label={ADVANCED_STRINGS.verbatimOrders} open />
    </div>
  );
}

/** One order's answer: the booking attached to it and the verbatim order. */
function OrderAnswer({ id, state }: { readonly id: string; readonly state: RawOrderState }) {
  if (!state.ok) {
    return <ReadFailure state={state} />;
  }
  const { result } = state;
  return (
    <div className="grid gap-2" data-answer={id}>
      <CallFacts call={result.call} />
      {result.bookingId === null ? null : (
        <p className="text-sm">
          {ADVANCED_STRINGS.attached}{" "}
          <Link href={bookingPath(result.bookingId)} prefetch={false} className={LINK_CLASS}>
            {result.bookingId}
          </Link>
        </p>
      )}
      <JsonView value={result.amadeus} label={ADVANCED_STRINGS.verbatimOrder(id)} open />
    </div>
  );
}

/** The panel: the by-reference read, and a read per order of the lookup and of that answer. */
export function AdvancedPanel({ reference, flightOrderIds }: AdvancedPanelProps) {
  const id = useId();
  const [orders, setOrders] = useState<RawOrdersState | undefined>(undefined);
  const [order, setOrder] = useState<Readonly<Record<string, RawOrderState>>>({});
  const [reading, setReading] = useState<string | undefined>(undefined);
  const [pending, startRead] = useTransition();
  // The lookup's orders first, then those only the by-reference answer has, each once.
  const ids = [
    ...new Set([
      ...flightOrderIds,
      ...(orders?.ok === true
        ? orders.result.amadeus.data
            .map((entry) => entry.id)
            .filter((entry): entry is string => typeof entry === "string" && entry !== "")
        : []),
    ]),
  ];

  function readOrders(): void {
    setReading(reference);
    startRead(async () => {
      setOrders(await readRawOrders(reference));
      setReading(undefined);
    });
  }

  function readOrder(flightOrderId: string): void {
    setReading(flightOrderId);
    startRead(async () => {
      const state = await readRawOrder(flightOrderId);
      setOrder((current) => ({ ...current, [flightOrderId]: state }));
      setReading(undefined);
    });
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-4 rounded-xl border border-dashed p-4">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          {ADVANCED_STRINGS.title}
        </h2>
        <p className="text-sm text-muted-foreground">{ADVANCED_STRINGS.intro}</p>
      </div>
      <div className="grid gap-2">
        <div>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={readOrders}>
            {ADVANCED_STRINGS.byReference(reference)}
          </Button>
        </div>
        {orders === undefined ? null : <OrdersAnswer state={orders} />}
      </div>
      {ids.map((flightOrderId) => {
        const answer = order[flightOrderId];
        return (
          <div key={flightOrderId} className="grid gap-2">
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => readOrder(flightOrderId)}
              >
                {ADVANCED_STRINGS.order(flightOrderId)}
              </Button>
            </div>
            {answer === undefined ? null : <OrderAnswer id={flightOrderId} state={answer} />}
          </div>
        );
      })}
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {pending && reading !== undefined ? ADVANCED_STRINGS.reading : ""}
      </p>
    </section>
  );
}
