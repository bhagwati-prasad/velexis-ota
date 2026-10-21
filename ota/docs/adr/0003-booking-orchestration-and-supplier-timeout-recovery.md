# OADR-0003: Booking orchestration and SUPPLIER_TIMEOUT recovery

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when Amadeus offers an idempotency key or a search by remark for Flight Create Orders, or when the booking queue convention is confirmed or changed with Amadeus during M2.
**Revisions:** 2026-10-21 (lead decision, recording FIX-W22, commit 42d5704): point 4 starts the reconciliation on every unknown outcome, not only on a timeout or a network error; new point 9 says which answers of Flight Create Orders are refusals, which were not sent and which are unknown (an Amadeus `5xx`, `502` and `503` included); new point 10 locks the checkout while its booking is `pending` (`409 CHECKOUT_BEING_COMPLETED`) and keeps the checkout expiry away from its authorisation; the Consequences, Follow-ups, Alternatives and References follow.

## Context

`checkout.complete` turns a checkout into an Amadeus order. The contract fixes the outward behaviour: Flight Create Orders at most once per checkout, a `pending` booking and `504 SUPPLIER_TIMEOUT` when Amadeus does not answer, a reconciliation "in the queuing office (Queue List / Flight Order Management) for up to 15 minutes", then confirm or void and fail, and same-key replays of the `504` until the decision. [`conventions.md` §2](../../../docs/mvp/conventions.md#rules) allows the order-creation step to keep a transaction open across the call. Amadeus has no idempotency key on order creation and no search by remark; Queue List returns PNRs of a queue with their creation time and traveller names. The airline-card method adds a twist: the card may have been charged when the answer is lost ([ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)).

## Decision

1. **Five steps, no transaction across a call:** claim (T1), call, record (T2), money, issue ([`../architecture-booking.md`](../architecture-booking.md) §1). We do **not** use the conventions' exception: holding a row lock and a pooled connection for up to 60 s risks pool exhaustion on one VM, and a crash during the call would roll back the only trace of the attempt.
2. **The claim is a `pending` booking row** committed before the call, with `create_order_started_at`. `bookings.checkout_id` is unique, so a concurrent or repeated completion of the same checkout cannot reach Amadeus a second time; it finds the pending booking and answers like the contract says (`504` with the same details, or `409 CHECKOUT_ALREADY_COMPLETED`).
3. **Every order is findable.** Each Flight Create Orders request carries:
   - the general remark `VELEXIS <booking reference>` (the booking reference is generated at the claim);
   - an `automatedProcess` entry that places the PNR immediately on the tenant's booking queue (`storefront_settings.booking_queue_number` and category, seeded to queue 50 / category 0 on Velexis shared offices) in the queuing office.
4. **Reconciliation** after an unknown outcome (point 9: no answer, or an answer that does not prove a refusal, once the request may have reached Amadeus): set `reconcile_until = create_order_started_at + 15 min`, answer `504`, enqueue `booking.reconcile` (first run after 30 s, then the 1-minute scan). Each run lists the booking queue, keeps PNRs created between `create_order_started_at − 1 min` and `+ 5 min` whose names include the lead traveller's last name, reads at most three candidates by reference, and accepts only one carrying the `VELEXIS <reference>` remark.
5. **Decisions.**

   | Outcome | Stripe | Airline card |
   |---|---|---|
   | Found | Record the order (step 3), capture, issue per policy, confirmation e-mail | Record the order and tickets, confirmation e-mail |
   | Not found by `reconcile_until` | Void the authorisation, booking `failed` (`failure_code = SUPPLIER_TIMEOUT`), checkout reopened if not expired, e-mail `booking.not_confirmed`, staff alert | **No automatic failure**: `ticketing_status = manual_review`, `reconcile_outcome = manual_review`, staff alert, traveller told the booking is being confirmed |
   | No booking queue configured | Same as "not found" after 15 minutes, with the alert saying the office must be checked by hand | Manual review |

6. **Replays.** The idempotency record of a timed-out completion points at the booking (`resource_id`); replays read the booking state and return the same `504` until `reconcile_outcome` is set, then the final result ([`../architecture-booking.md`](../architecture-booking.md) §5).
7. **Same pattern for other writes.** Issue: on timeout no retry in the request; the ticketing job resyncs before any retry. Cancel (DELETE): booking flagged, GET within 15 minutes, then the money step once. Patch: resync, then the caller retries with `If-Match`.
8. **Late discoveries.** If staff later find an order that reconciliation missed, they import it from the console (`console.bookings.import`) and settle payment with the traveller; the failed booking stays for audit.
9. **What an answer of Flight Create Orders proves.** Only an answer that proves the order was not created may fail the booking. A failed call is one of three kinds (`createFailureKind` in [`booking-orchestrator.service.ts`](../../backend/src/bookings/booking-orchestrator.service.ts)):

   | Kind | Answers | Booking | Authorisation | Checkout | API answer |
   |---|---|---|---|---|---|
   | **Refused**: Amadeus processed the request and created nothing | An Amadeus `4xx` whose mapped code is a business refusal: `SOLD_OUT` (34651), `PRICE_CHANGED` (37200), `TRAVELER_DATA_INVALID` or `SUPPLIER_REJECTED` (4926, 32171, and any other `4xx` but `401`, `403` and `429`), `TICKETING_FAILED` (9112), `PAYMENT_DECLINED` (1304), `VERSION_CONFLICT` (2552) | `failed`, `checkout_id` cleared | Voided (`pi:cancel:<pay_id>`; a failed void queues `payment.void`) | `open` again | `409 SOLD_OUT`, `409 PRICE_CHANGED`, `422 TRAVELER_DATA_INVALID`, `502 TICKETING_FAILED`, else `502 SUPPLIER_ERROR` |
   | **Not sent**: the request never reached the order | An error raised before the request left the backend (the OAuth token request, the token buckets, Redis, the connection and office checks, an unexpected error); a connection that was never made (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT` and the TLS certificate errors); an Amadeus `401` (after the client's one retry with a new token), `403` or `429` without a business code, which refuse the request before processing it | `failed`, `checkout_id` cleared | Kept | Still `payment_pending`; a new completion may send the order | The error in the operation's codes, such as `503 SUPPLIER_UNAVAILABLE`, `503 SERVICE_UNAVAILABLE`, `424 SUPPLIER_NOT_CONFIGURED`, `429 RATE_LIMITED` or `502 SUPPLIER_ERROR` |
   | **Unknown**: the order may exist | Every other answer once the request may have reached Amadeus: no answer in time, a reset or otherwise cut connection, an Amadeus `5xx` (`500` with 141 SYSTEM ERROR, `502`, `503`, `504` and any other), an answer that cannot be read (a `2xx` that is not JSON, any other status, a created order whose answer cannot be parsed), and a created order whose recording (T2) fails | Stays `pending` with its `checkout_id`; `reconcile_until = create_order_started_at + 15 min`; event `booking.supplier_timeout` | Kept: never voided by the request | `payment_pending`, locked (point 10) | `504 SUPPLIER_TIMEOUT` (`details.bookingId`) |

   Once a request of the checkout may have reached Amadeus, Flight Create Orders is never sent again for that checkout: a refused booking is `failed`, and an unknown one stays `pending` until the reconciliation (points 4 and 5) decides it. Before FIX-W22 an Amadeus `500` counted as a refusal and a `502` or `503` as not sent, so the authorisation of an order that existed could be voided, or the order sent again. The airline-card completion (OBE-051) classifies its answers the same way, with the money of point 5 ([`../flows/checkout-airline-card.md`](../flows/checkout-airline-card.md) §4).
10. **The checkout lock.** While a checkout has a `pending` booking (checkout.complete claimed it: the order is being created, or is looked for after a `504`), nothing of the checkout changes. Its mutating steps, `checkout.setTravelers`, `checkout.setContacts`, `checkout.setRemarks`, `checkout.setAncillaries`, `checkout.createPayment` and `checkout.updatePayment`, answer `409 CHECKOUT_BEING_COMPLETED` (`details.bookingId`). They check it under the checkout's row lock, which the claim takes too, so a change and a claim never overlap; the steps that call Amadeus or Stripe first also check before that call. `checkout.complete` and `checkout.completeWithAirlineCard` answer the booking's `504 SUPPLIER_TIMEOUT` (point 2). So no new payment replaces, and voids, the authorisation the booking is made with, and the travellers, extras and amounts stay those of the order that may exist. A job that expires checkouts (`checkouts.expire`, and the suspension's expiry of [OADR-0007](0007-tenant-migration-runner-and-provisioning-worker.md) point 8) skips a checkout whose booking is `pending`: its authorisation stays for the reconciliation, the only one that voids or captures it. The lock ends when the reconciliation decides (point 5). With a Stripe payment: found, the booking is recorded and the checkout `completed`; not found, the authorisation is voided through `ota-payments`, the booking is `failed` with its `checkout_id` cleared, and the checkout is reopened if it has not expired, else `checkouts.expire` expires it on its next run.

## Consequences

### Positive

- A crash at any point leaves a durable trace (the pending booking) that the reconciler or staff can act on.
- At most one order per checkout, proven by a database constraint instead of in-memory locks.
- The airline-card path never fails a booking whose card may have been charged.
- No authorisation is voided and no order is sent twice while the order may exist: an order Amadeus created behind a `5xx` or a gateway's `502`/`503` is found and confirmed by the reconciliation instead of being left unpaid.
- While the outcome is unknown the order, the booking and the checkout cannot drift apart: the checkout lock keeps its travellers, extras, amounts and authorisation as they were sent.

### Negative

- Every order goes to a queue, so the booking queue fills; staff or a later job must clean it (Queue List has no removal in the 12 operations). The queue is dedicated to Velexis bookings so it does not mix with other work.
- The queue convention (queue 50) is an assumption to confirm with Amadeus for the shared offices; OTAs on their own credentials must configure a queue or accept manual handling after timeouts.
- A booking can be `failed` while a PNR exists (if reconciliation misses it); the PNR's own time limit cancels it because it is unticketed and unpaid, and staff are alerted.
- An Amadeus `5xx` that created nothing still holds the traveller's authorisation and locks the checkout until the reconciliation decides (15 minutes after the request, plus one run); the storefront shows its "we are confirming your booking" page meanwhile.

### Follow-ups

- M2: confirm with Amadeus that `automatedProcess` with code `IMMEDIATE` places new orders on the queue for the shared offices, and record a fixture.
- M4: a console "booking queue" view to spot orphan PNRs.
- OBE-043: the reconciler decides every `pending` booking with `reconcile_until` and so releases the checkout lock of point 10; until it is merged, a pending booking keeps its checkout locked and its authorisation held.
- OBE-056: `checkouts.expire` skips checkouts whose booking is `pending` (point 10). The suspension's expiry (OBE-074) must skip them too.

## Alternatives considered

- **Hold the transaction and row lock during the call** (the conventions' exception). Simpler code, but loses the trace on crash and ties up pool connections.
- **Retry Flight Create Orders after a timeout.** Can create duplicate PNRs and, with the airline card, charge the card twice.
- **Poll Flight Order Management only.** Needs the order id, which a lost answer never delivered.
- **Store the card to retry later.** Rejected by ADR-0011 (PCI requirement 3).
- **Count an Amadeus `5xx` as a refusal, or a `502` or `503` as not sent** (the behaviour before FIX-W22). A system or gateway error does not say whether the order was created behind it: voiding then leaves an order without money, and a retry may create a second one.
- **Let the checkout change while its booking is pending.** A new payment would cancel the authorisation the booking is made with, and travellers or extras changed after the request would no longer match the order the reconciliation finds.
- **Expire the checkout and void its authorisation on schedule.** The order may exist: voiding before the reconciliation decides is the same risk as voiding on a `5xx`.

## References

- Contract `checkout.complete`, `bookings.cancel` descriptions in the [OpenAPI document](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml); `completeCheckout`'s failure semantics and the error code `CHECKOUT_BEING_COMPLETED` in the [OTA backend's document](../../backend/openapi/velexis-ota-booking-api.openapi.yaml) (FIX-W22)
- FIX-W22 (commit 42d5704): `createFailureKind` and the unknown outcome in [`booking-orchestrator.service.ts`](../../backend/src/bookings/booking-orchestrator.service.ts), `refuseWhileCompleting` in [`checkout.service.ts`](../../backend/src/checkout/checkout.service.ts), and their tests in [`booking-orchestrator.service.test.ts`](../../backend/src/bookings/booking-orchestrator.service.test.ts) and [`complete-stripe.int.test.ts`](../../backend/test/integration/bookings/complete-stripe.int.test.ts)
- [`../architecture-booking.md`](../architecture-booking.md), [`../flows/checkout-stripe.md`](../flows/checkout-stripe.md), [`../flows/checkout-airline-card.md`](../flows/checkout-airline-card.md)
- [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [ADR-0012](../../../docs/mvp/adr/0012-amadeus-account-model.md), [`../data-model.md`](../data-model.md) §3.3
- Amadeus Queue List and Flight Create Orders specifications in [`docs/amadeus-api/`](../../../docs/amadeus-api/)
