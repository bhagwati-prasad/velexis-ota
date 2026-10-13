# OADR-0008: Ticketing policy: automatic and manual issuance

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when pay-later holds are requested, when the queuing office time zone is stored with the offices, or after the first month of live ticketing data.

## Context

`storefront_settings.ticketing_policy` offers `issue_at_booking`, `issue_after_payment` and `manual_review`; `payment_timing` offers `authorize_before_booking`, `capture_before_booking` and `pay_later`. The contract describes the retry job for failed issuance "until the ticketing deadline", staff notifications, `manual_review` leaving the authorisation for staff, and `DELAY_TO_CANCEL` agreements for pay-later. [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) forces `issue = true` for airline-card bookings. Stripe authorisations expire after about 7 days. The deadline must be computed from `lastTicketingDate` "in the office time zone", which the platform does not store.

## Decision

1. **Policies in the MVP.**

   | Policy | Meaning | Default |
   |---|---|---|
   | `issue_after_payment` | Create the order without tickets, capture, then issue in the same request | **yes** |
   | `issue_at_booking` | Create the order with `issue=true`, then capture | |
   | `manual_review` | Create the order without tickets, keep the authorisation; staff issue from the console (which captures first) | |

   Airline-card bookings and offers with `instantTicketingRequired` always use `issue=true`, whatever the policy.
2. **Payment timing** is `authorize_before_booking` only. `capture_before_booking` (charging before an order exists) and `pay_later` (holds with `DELAY_TO_CANCEL`) are refused by the settings API (`422 UNPROCESSABLE`) until a later decision.
3. **Deadline.** `ticketing_deadline_at` = the start (00:00) of `lastTicketingDate` in the OTA's `storefront_settings.time_zone`, or the order's `ticketingAgreement.dateTime` if earlier. Using the start of the day is an early, safe reading while the office time zone is unknown.
4. **Retry schedule** after a failed issuance: +5 min, +15 min, +1 h, then every 2 h; at most 8 attempts; never after `ticketing_deadline_at − 2 h`. Each attempt starts with a Flight Order Management GET so a ticket issued by an earlier timed-out call is recorded rather than issued twice. Failures for payment reasons are not retried.
5. **Giving up** sets `ticketing_next_attempt_at = NULL`, alerts staff (`staff.ticketing_failed` to `ops_alert_email` or the owners) and tells the traveller (`booking.ticketing_delayed`). Staff issue or cancel from the console. The worker never cancels automatically.
6. **Authorisation watch.** A daily job alerts staff about authorised, uncaptured Stripe payments older than 5 days, so `manual_review` bookings are issued (and captured) before the authorisation lapses.
7. **Capture failure after the order** (rare: authorisation expired or revoked): booking `confirmed`, `ticketing_status = manual_review`, `payment.capture_retry` once after 10 minutes, then staff.
8. **Suspended tenants**: issuance retries and booking sync continue for paid bookings ([PADR-0014](../../../platform/docs/adr/0014-tenant-suspension-and-resume.md)).

## Consequences

### Positive

- The default never issues a ticket that is not paid, and never captures money without an order.
- Retries are bounded and visible; staff know exactly when they must act.
- No double issuance after timeouts.

### Negative

- No pay-later holds in the MVP, which some OTAs use for group or corporate sales.
- The deadline reading can be up to a day early for offices far from the OTA's time zone; staff may see alerts earlier than strictly necessary.
- `issue_at_booking` issues before capture; a capture failure then leaves the OTA exposed for that booking (staff alerted).

### Follow-ups

- Store the office time zone with `amadeus_offices` (platform) and use it for the deadline.
- Pay-later holds with `DELAY_TO_CANCEL` and reminder e-mails, after launch.

## Alternatives considered

- **`issue_at_booking` by default.** Fewer Amadeus calls, but issues before the money is captured.
- **Unbounded retries until the deadline.** Can hammer Amadeus for days on a permanent error.
- **Automatic cancellation at the deadline.** Takes a commercial decision that belongs to staff; the airline's own time limit already cancels unticketed PNRs.

## References

- `storefront_settings`, `bookings` ticketing columns in [`tenant.sql`](../../../docs/velexis-sdk/db/tenant.sql), [db README §2.1, §6](../../../docs/velexis-sdk/db/README.md)
- Contract `checkout.complete`, `console.bookings.issue`, `bookings.getTicketingStatus` in the [OpenAPI document](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)
- [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [`../flows/ticketing-and-documents.md`](../flows/ticketing-and-documents.md), [OADR-0003](0003-booking-orchestration-and-supplier-timeout-recovery.md)
