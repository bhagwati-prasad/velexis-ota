# OADR-0004: Airline-card data handling in the backend

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when a card vault or forwarding service can reach the Amadeus endpoint (ADR-0011 follow-up), when a 3-D Secure server is added, or after the M6 security review.
**Revisions:** 2026-10-23 (refinements of points 5 and 6 as OBE-051 built them, proposed for the lead's confirmation; dated notes): the payment of a declined card takes the traveller's next card, a card of another brand than the quoted one (or any card before a quote) is refused before it is sent, the third decline answers the `403` itself, the limits are checked again right before the card is sent, and a suspended method answers `403 FEATURE_DISABLED` with `details.reason = "suspended"`. 2026-10-24 (lead decision (1), FIX-W29-SECURITY; dated note of point 2): no stored or logged copy keeps the card holder's name or the expiry date, also of what Amadeus echoes. 2026-10-24 (lead decision (2), recording FIX-W29-OTA): the notes of 2026-10-23 under points 5 and 6 are confirmed (no longer proposed); a declined (`failed`) payment takes the next card's hint through `checkout.updatePayment`, so another brand is quoted on the same `paymentId`; storefront.get and `checkout.createPayment` stop offering the method while it is suspended for the tenant and environment, or when the suspension cannot be read; the completion's Velexis ops copy reads `OPS_ALERT_EMAIL` through the typed shared configuration key (dated notes under points 5 and 6). 2026-10-26 (lead decision (1), recording FIX-W30-OTA; dated note of point 2): the copies stored before 2026-10-24 are scrubbed of the card's holder and expiry by the one-off per-tenant command `tenants:scrub-card-copies`.

## Context

[ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) decides that the airline-card method is off by default, only for the hosted storefront, done through a dedicated operation that completes the checkout in one request with the card in the body, processed in memory, with `issue = true`, recorded as `provider = 'airline'` with brand, BIN and last 4 only, never queued, cached, stored or logged, and protected by the PCI controls of its §C. It leaves the final path and the backend mechanics to the OTA plan. Two more questions arise: what the customer pays when the airline, not the OTA, charges the card, and how an idempotent, reconcilable completion works without keeping the card.

## Decision

### 1. Contract and gating

- Path `POST /v1/checkouts/{checkoutId}/airline-card-completion`, `checkout.completeWithAirlineCard`, `x-edge-only` ([`../api-changes.md`](../api-changes.md) §3). `checkout.createPayment {method: "airline_card"}` prepares the payment and the totals first.
- Enabled only when `AIRLINE_CARD_ENABLED=true` **and** `storefront_settings.airline_card_enabled_<env>` is true for the tenant's storefront environment. In production the global switch stays `false` until the M6 security review; `airline_card_enabled_live` cannot be set while it is off.

### 2. The card in memory

- The route has its own body parser limit (10 KB) and is excluded from every body serializer of `pino-http`, from Sentry breadcrumbs and from the validation error details (Ajv errors are reduced to paths).
- The validated card is wrapped in a `SensitiveCard` class: private fields; `toJSON()`, `toString()` and `util.inspect.custom` return `"[redacted card]"`; `last4()`, `bin()`, `brand()` are the only readers; `toAmadeusCreditCard()` is the only method that returns the full values, called by `AmadeusClient.createFlightOrders` while building the HTTP body. The request handler clears its reference in `finally`.
- The redacted copy for `supplier_requests` and `order_snapshot` is built from the `SensitiveCard` (last 4 only, no security code) before the call; the raw HTTP body string is never stored.
- **2026-10-24 (lead decision (1), FIX-W29-SECURITY).** Every stored or logged copy of an airline card keeps at most its brand, BIN and last 4: `toRedactedCreditCard()` gives the brand and the last 4 only (no holder), and the shared redactor (`redactPayload` of `@velexis/logger`) drops a card's holder and expiry (`holder`, `holderName`, `expiryDate`, `expiryMonth`, `expiryYear`) in a card object and anywhere below `formOfPayments`, so what Amadeus echoes of the card in its answer leaves no holder or expiry in `supplier_requests`, `bookings.form_of_payments`, `order_snapshot`, `idempotency_keys` or the logs (whose redaction list censors whole `creditCard` and `formOfPayments` objects, and the Amadeus spellings of a card flattened into a log object). The console's form of payment shows `holder` and `expiryDate` as `null`.
- **2026-10-26 (lead decision (1), FIX-W30-OTA).** The copies written before 2026-10-24 (`bookings.form_of_payments`, `bookings.order_snapshot`, and the `request_body` and `response_body` of `supplier_requests`: Flight Create Orders of an airline-card payment and the later order reads) are rewritten through the current redactor by a one-off backfill, a batched job per tenant run as a CLI command, never a migration ([`conventions.md`](../../../docs/mvp/conventions.md) §9): `node dist/cli.js tenants:scrub-card-copies (--tenant <key> | --all)` ([`card-copies-scrub.ts`](../../backend/src/payments/airline-card/card-copies-scrub.ts), [`scrub-card-copies.command.ts`](../../backend/src/payments/airline-card/scrub-card-copies.command.ts)). A form of payment is redacted as one (its holder and expiry dropped wherever they sit), a truncated body's preview is cut before the card that holds them, a copy the redactor leaves as it is is not written, and nothing else of the row changes (not `version`, not `updated_at`); a row changed meanwhile is left to another run, and a second run writes nothing. The developer runs it once on the VM after the deploy ([`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md) §9). The console's `holder` and `expiryDate` are then `null` for every booking.
- Nothing card-related is ever put in Redis, BullMQ, `idempotency_keys`, `payment_events`, `booking_events`, `notifications` or `staff_actions`. A unit test feeds a test PAN through every persistence helper and asserts it is absent.

### 3. Idempotency without the card

- `request_hash` is computed over the body with `card` replaced by `{brand, last4}`; no hash of a card number is stored (PCI requirement 3.5.1 would require a keyed hash).
- A replay never re-runs the call: it returns the stored outcome, or the reconciliation state for a `504`.
- The SDK method has no automatic retries; the storefront asks the traveller to type the card again after any error.

### 4. Pricing: the airline's price

The airline charges its own fare: the Amadeus total of the order, plus the airline's card fee where applicable. OTA markup and OTA fees cannot be collected on this path in the MVP.

- `createPayment {method: "airline_card"}` sets `checkouts.pricing_mode = 'net'` and recomputes `offer_amount` (priced net total), `ancillaries_amount` (Amadeus prices of the extras) and `fees_amount` (Amadeus credit-card fee for the brand and BIN once known). Switching back to `card` restores `markup_rules`.
- The booking is stored with `pricing_mode = 'net'` and `markup_amount = 0`; the console shows the OTA's margin as zero (commission agreements with airlines are outside Velexis in the MVP).
- The storefront shows the airline's price and the notice "The airline charges your card" before the card form. The OTA admin warns when the airline card is enabled while markup or fee rules are active.

### 5. Recording the outcome

- `payments`: `provider = 'airline'`, `method = 'airline_card'`, `capture_method = 'automatic'`, `card_brand`, `card_bin`, `card_last4`; status `captured` (amount captured = amount) when the order came back with tickets, `failed` with a public failure code on refusal, `processing` while undecided. The database CHECK `payments_airline_card_ck` refuses expiry, PSP ids and 3-D Secure data on these rows ([`../data-model.md`](../data-model.md) §3.1).
- `payment_events`: `airline.charged`, `airline.declined`, `airline.void_expected` with amounts only.
- Refunds are not made by Velexis: a void or a refund at the airline reverses its charge. The console refuses Stripe refunds on these payments.
- **2026-10-23 (OBE-051; confirmed by lead decision (2) of 2026-10-24).** The payment is `processing` from the moment its card is sent (with the card's brand, BIN and last 4), and the airline's charge is recorded in the same transaction as the order (`airline.charged`); an order without every ticket keeps it `processing` for the staff. The payment of a declined card is `failed` and takes the traveller's next card on the same checkout (the storefront's card page keeps its `paymentId`); a request that was not sent leaves it awaiting the card, and a re-price that raises the total before anything is sent moves it with the checkout to the new total. A card of another brand than the one the Amadeus card fee was quoted for (`checkouts.payment_brand`, kept by `checkout.updatePayment`), or any card while no card fee was quoted (no brand yet: the total holds no card fee), is refused with `409 PAYMENT_AMOUNT_MISMATCH` (`details.reason = "card_changed"`) before it is sent, so the airline never charges a fee the traveller did not see.
- **2026-10-24 (lead decision (2), FIX-W29-OTA).** The note above is the rule: a declined payment returns to `failed` and takes the traveller's next card, the attempts are the declines (point 6), and any card before a card fee was quoted is refused unsent. So that the `card_changed` refusal can be followed on the same payment, `checkout.updatePayment` accepts the hint of the next card on a `failed` airline-card payment while it is the newest payment of its checkout (still at the airline's price): the Amadeus card fee of that brand is quoted, the payment and the checkout take the new amount and `checkouts.payment_brand`, the payment stays `failed` and drops the declined card's last 4 digits (its brand and BIN are the hint's until the next card is sent), and the completion then takes a card of that brand on the same `paymentId`. A payment that another one replaced since is not changed (`409 PAYMENT_NOT_UPDATABLE`).

### 6. Abuse defence

- Limits: 5 per minute per IP, 3 attempts per checkout (`t:<tenantId>:<env>:ac:chk:<checkoutId>`), 60 per hour per tenant; without Redis the route answers `503` rather than run unlimited.
- Three declines on a checkout lock it (`403 PAYMENT_ATTEMPTS_EXCEEDED`) and alert the OTA (`staff.airline_card_alert`) and Velexis ops (`OPS_ALERT_EMAIL`). A tenant passing 20 declines in an hour has the method suspended for an hour (Redis flag) and ops are alerted.
- **2026-10-23 (OBE-051; confirmed by lead decision (2) of 2026-10-24).** An attempt is a card the airline declined: the third decline answers `403 PAYMENT_ATTEMPTS_EXCEEDED` itself and every later request on the checkout is refused before anything is sent (the limits are checked before the booking's claim and again right before the card is sent, and a decline is counted before its booking fails and frees the checkout, so a completion running at the same time as the third decline is refused too), while a card the server refuses (Luhn, expiry, brand) or a request that never sent the card is no attempt. The tenant's declines count per storefront environment in a fixed window of an hour (`t:<tenantId>:<env>:ac:declines`); the 20th sets the flag `t:<tenantId>:<env>:ac:suspended` for an hour, once (`SET NX`), and while it is set the route answers `403 FEATURE_DISABLED` with `details.reason = "suspended"`. The OTA's alert goes to its staff recipients (OADR-0013 item 5); the Velexis ops alert is the same e-mail to `OPS_ALERT_EMAIL` when the process has it, and an error log line (`payments.airline_card_attempts_exceeded`, `payments.airline_card_suspended`).
- **2026-10-24 (lead decision (2), FIX-W29-OTA).** The note above is confirmed: the attempts are the declines, a suspension answers `403 FEATURE_DISABLED` with `details.reason = "suspended"`, and the limits are checked again right before the card is sent. The suspension also stops the method being offered: while the flag `t:<tenantId>:<env>:ac:suspended` is set, storefront.get leaves `airline_card` out of the edge's `payment.supportedMethods` (`payment.airlineCard: null`) and `checkout.createPayment {method: "airline_card"}` answers the same `403`; a Redis that cannot say whether the flag is set offers nothing either (storefront.get leaves the method out, `createPayment` answers `503 SERVICE_UNAVAILABLE`, as the completion does without its limits). The flag is read on every request, never cached with the storefront's entry (`AirlineCardLimits.suspension`, [`abuse-limits.ts`](../../backend/src/payments/airline-card/abuse-limits.ts)). The completion reads `OPS_ALERT_EMAIL` through the shared configuration's typed key (`config.ts` checks it is one plain address), the key StaffRecipients falls back to for the other staff alerts.

### 7. Timeouts

On a lost answer the booking is reconciled ([OADR-0003](0003-booking-orchestration-and-supplier-timeout-recovery.md)); if the order is not found, the booking goes to **manual review**, never to an automatic failure, because the card may have been charged.

## Consequences

### Positive

- The card exists in one process, in one request, in one object whose accidental serialisation is harmless.
- The traveller pays exactly what the airline charges; no OTA amount is promised that nobody collects.
- The database itself refuses card attributes beyond brand, BIN and last 4 on airline payments.

### Negative

- OTAs earn no markup on airline-card sales in the MVP; some will prefer Stripe or need commission agreements outside the system.
- Travellers retype the card after any error, and there is no 3-D Secure (more declines, no liability shift).
- The route needs its own parser, logging exceptions and tests, which must be kept in mind when the logging stack changes.

### Follow-ups

- M6: security review, penetration test, script inventory and integrity monitoring of the payment page ([ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §C) before `airline_card_enabled_live`.
- Later: collect OTA service fees separately through Stripe on airline-card bookings, if OTAs ask for it.

## Alternatives considered

- **Reuse `checkout.complete` with a `card` field.** Puts card data on a general route with general logging and retries; ADR-0011 asks for a dedicated, narrow endpoint.
- **Keep the card until issuance succeeds** (to issue later or retry). Storage of card data is excluded by ADR-0011.
- **Charge markup through the airline.** Not possible: the airline charges its fare.
- **Hash the PAN for idempotency.** Unnecessary; replacing the card by brand and last 4 in the hash input is enough to detect key reuse.

## References

- [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [ADR-0016](../../../docs/mvp/adr/0016-observability.md), [db README §8](../../../docs/velexis-sdk/db/README.md)
- [`../api-changes.md`](../api-changes.md) §3, [`../flows/checkout-airline-card.md`](../flows/checkout-airline-card.md), [`../architecture-booking.md`](../architecture-booking.md) §3
- Amadeus `formOfPayments.creditCard` in [`FlightCreateOrders_v1_Version_1.16_swagger_specification.json`](../../../docs/amadeus-api/FlightCreateOrders_v1_Version_1.16_swagger_specification.json)
- FIX-W30-OTA (2026-10-26): the scrub of the copies of before 2026-10-24, `scrubCardCopies` in [`card-copies-scrub.ts`](../../backend/src/payments/airline-card/card-copies-scrub.ts) and the `tenants:scrub-card-copies` command; tests in [`card-copies-scrub.test.ts`](../../backend/src/payments/airline-card/card-copies-scrub.test.ts) and [`scrub-card-copies.int.test.ts`](../../backend/test/integration/payments/scrub-card-copies.int.test.ts)
- FIX-W29-OTA (2026-10-24): `AirlineCardLimits.suspension` and `assertNotSuspended` in [`abuse-limits.ts`](../../backend/src/payments/airline-card/abuse-limits.ts), `airlineCardFor` in [`storefront.mapper.ts`](../../backend/src/storefront/storefront.mapper.ts), `PaymentsService.update` (`takesNextCard`) in [`payments.service.ts`](../../backend/src/payments/payments.service.ts); tests in [`airline-card-completion.int.test.ts`](../../backend/test/integration/payments/airline-card-completion.int.test.ts), [`abuse-limits.test.ts`](../../backend/src/payments/airline-card/abuse-limits.test.ts), [`storefront.mapper.test.ts`](../../backend/src/storefront/storefront.mapper.test.ts) and [`airline-card-completion.service.test.ts`](../../backend/src/payments/airline-card/airline-card-completion.service.test.ts)
