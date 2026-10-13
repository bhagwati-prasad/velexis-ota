# OADR-0004: Airline-card data handling in the backend

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when a card vault or forwarding service can reach the Amadeus endpoint (ADR-0011 follow-up), when a 3-D Secure server is added, or after the M6 security review.

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

### 6. Abuse defence

- Limits: 5 per minute per IP, 3 attempts per checkout (`t:<tenantId>:ac:chk:<checkoutId>`), 60 per hour per tenant; without Redis the route answers `503` rather than run unlimited.
- Three declines on a checkout lock it (`403 PAYMENT_ATTEMPTS_EXCEEDED`) and alert the OTA (`staff.airline_card_alert`) and Velexis ops (`OPS_ALERT_EMAIL`). A tenant passing 20 declines in an hour has the method suspended for an hour (Redis flag) and ops are alerted.

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
