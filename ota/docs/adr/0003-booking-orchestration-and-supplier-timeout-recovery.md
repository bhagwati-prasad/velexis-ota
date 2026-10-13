# OADR-0003: Booking orchestration and SUPPLIER_TIMEOUT recovery

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when Amadeus offers an idempotency key or a search by remark for Flight Create Orders, or when the booking queue convention is confirmed or changed with Amadeus during M2.

## Context

`checkout.complete` turns a checkout into an Amadeus order. The contract fixes the outward behaviour: Flight Create Orders at most once per checkout, a `pending` booking and `504 SUPPLIER_TIMEOUT` when Amadeus does not answer, a reconciliation "in the queuing office (Queue List / Flight Order Management) for up to 15 minutes", then confirm or void and fail, and same-key replays of the `504` until the decision. [`conventions.md` §2](../../../docs/mvp/conventions.md#rules) allows the order-creation step to keep a transaction open across the call. Amadeus has no idempotency key on order creation and no search by remark; Queue List returns PNRs of a queue with their creation time and traveller names. The airline-card method adds a twist: the card may have been charged when the answer is lost ([ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)).

## Decision

1. **Five steps, no transaction across a call:** claim (T1), call, record (T2), money, issue ([`../architecture-booking.md`](../architecture-booking.md) §1). We do **not** use the conventions' exception: holding a row lock and a pooled connection for up to 60 s risks pool exhaustion on one VM, and a crash during the call would roll back the only trace of the attempt.
2. **The claim is a `pending` booking row** committed before the call, with `create_order_started_at`. `bookings.checkout_id` is unique, so a concurrent or repeated completion of the same checkout cannot reach Amadeus a second time; it finds the pending booking and answers like the contract says (`504` with the same details, or `409 CHECKOUT_ALREADY_COMPLETED`).
3. **Every order is findable.** Each Flight Create Orders request carries:
   - the general remark `VELEXIS <booking reference>` (the booking reference is generated at the claim);
   - an `automatedProcess` entry that places the PNR immediately on the tenant's booking queue (`storefront_settings.booking_queue_number` and category, seeded to queue 50 / category 0 on Velexis shared offices) in the queuing office.
4. **Reconciliation** after a timeout or network error once the request was sent: set `reconcile_until = create_order_started_at + 15 min`, answer `504`, enqueue `booking.reconcile` (first run after 30 s, then the 1-minute scan). Each run lists the booking queue, keeps PNRs created between `create_order_started_at − 1 min` and `+ 5 min` whose names include the lead traveller's last name, reads at most three candidates by reference, and accepts only one carrying the `VELEXIS <reference>` remark.
5. **Decisions.**

   | Outcome | Stripe | Airline card |
   |---|---|---|
   | Found | Record the order (step 3), capture, issue per policy, confirmation e-mail | Record the order and tickets, confirmation e-mail |
   | Not found by `reconcile_until` | Void the authorisation, booking `failed` (`failure_code = SUPPLIER_TIMEOUT`), checkout reopened if not expired, e-mail `booking.not_confirmed`, staff alert | **No automatic failure**: `ticketing_status = manual_review`, `reconcile_outcome = manual_review`, staff alert, traveller told the booking is being confirmed |
   | No booking queue configured | Same as "not found" after 15 minutes, with the alert saying the office must be checked by hand | Manual review |

6. **Replays.** The idempotency record of a timed-out completion points at the booking (`resource_id`); replays read the booking state and return the same `504` until `reconcile_outcome` is set, then the final result ([`../architecture-booking.md`](../architecture-booking.md) §5).
7. **Same pattern for other writes.** Issue: on timeout no retry in the request; the ticketing job resyncs before any retry. Cancel (DELETE): booking flagged, GET within 15 minutes, then the money step once. Patch: resync, then the caller retries with `If-Match`.
8. **Late discoveries.** If staff later find an order that reconciliation missed, they import it from the console (`console.bookings.import`) and settle payment with the traveller; the failed booking stays for audit.

## Consequences

### Positive

- A crash at any point leaves a durable trace (the pending booking) that the reconciler or staff can act on.
- At most one order per checkout, proven by a database constraint instead of in-memory locks.
- The airline-card path never fails a booking whose card may have been charged.

### Negative

- Every order goes to a queue, so the booking queue fills; staff or a later job must clean it (Queue List has no removal in the 12 operations). The queue is dedicated to Velexis bookings so it does not mix with other work.
- The queue convention (queue 50) is an assumption to confirm with Amadeus for the shared offices; OTAs on their own credentials must configure a queue or accept manual handling after timeouts.
- A booking can be `failed` while a PNR exists (if reconciliation misses it); the PNR's own time limit cancels it because it is unticketed and unpaid, and staff are alerted.

### Follow-ups

- M2: confirm with Amadeus that `automatedProcess` with code `IMMEDIATE` places new orders on the queue for the shared offices, and record a fixture.
- M4: a console "booking queue" view to spot orphan PNRs.

## Alternatives considered

- **Hold the transaction and row lock during the call** (the conventions' exception). Simpler code, but loses the trace on crash and ties up pool connections.
- **Retry Flight Create Orders after a timeout.** Can create duplicate PNRs and, with the airline card, charge the card twice.
- **Poll Flight Order Management only.** Needs the order id, which a lost answer never delivered.
- **Store the card to retry later.** Rejected by ADR-0011 (PCI requirement 3).

## References

- Contract `checkout.complete`, `bookings.cancel` descriptions in the [OpenAPI document](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)
- [`../architecture-booking.md`](../architecture-booking.md), [`../flows/checkout-stripe.md`](../flows/checkout-stripe.md), [`../flows/checkout-airline-card.md`](../flows/checkout-airline-card.md)
- [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [ADR-0012](../../../docs/mvp/adr/0012-amadeus-account-model.md), [`../data-model.md`](../data-model.md) §3.3
- Amadeus Queue List and Flight Create Orders specifications in [`docs/amadeus-api/`](../../../docs/amadeus-api/)
