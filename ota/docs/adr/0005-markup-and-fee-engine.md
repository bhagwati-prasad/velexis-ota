# OADR-0005: Markup and fee engine

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when OTAs need currency conversion of fixed amounts, per-customer pricing, or a pricing simulator in the OTA admin.
**Revisions:** 2026-10-23 (lead decisions (1) and (2), second batch, FIX-W28-CANCEL): the cancellation quote's row of point 7 keeps the card fee unless its `payment_card` line is refundable, from the lines each payment stores when its card fee is quoted (the Amadeus credit-card fee is never refundable), and its kept amount is captured from a payment that is only authorised (dated note under point 7); point 9 is unchanged.

## Context

The tenant schema holds `markup_rules` (scope, percentage, fixed amount, per booking, traveller or segment, caps, priority, stackable, validity window) and `fee_rules` (fee types `booking_service`, `payment_card`, `ticketing`, `change`, `cancellation`, `ancillary_service`, refundable flag). CHECKs require `flight_offers.selling_total = net_total + markup_amount` and `priced_offers.selling_total = net + markup + fees`. The contract says each offer gets "the first matching rule by route, carrier, cabin, source, channel" and fees from `fee_rules`, and that customer scope never sees net amounts. Money is a decimal string computed with `decimal.js` ([`conventions.md` §1](../../../docs/mvp/conventions.md#1-general)). Several details are open: matching semantics, stacking, rounding, currencies, and which fees apply at which step.

## Decision

1. **One pure engine** in `src/pricing/`: `priceOffer(input, rules, fees) → { net, markupLines[], feeLines[], selling }`, no I/O, deterministic, fully unit-tested with table-driven cases. Shopping, checkout, the reconciler and the console call it; settings only edit rules.
2. **Inputs** are taken from the Amadeus offer: net total and base, taxes, currency, origin and destination airports and countries (from `reference.airports`), validating and marketing carriers, cabins, traveller types and counts, segment count, trip type, source (GDS, NDC), channel (`storefront` or `console`).
3. **Rule matching.** A rule matches when it is active, inside its validity window, and every non-empty scope field matches (lists are "any of"; `minNet` and `maxNet` compare the net total). Rules are evaluated by `priority` ascending, then `id`.
   - The **first matching non-stackable** rule is the base markup; evaluation of non-stackable rules stops there.
   - Every matching **stackable** rule with a lower priority number than the base rule, or anywhere when no base rule matched, adds its markup.
   - The seeded default rule (`is_default`, priority 1000, 0 %) guarantees a match.
4. **Computation.** Percentage applies to the net total (per booking) or to the per-traveller or per-segment net share; fixed amounts are multiplied by the unit count; `min_amount`/`max_amount` cap the computed markup per unit. Negative markups (discounts, down to −100 % as the CHECK allows) are applied as computed, but the sum of markup lines is floored at −net so the selling total is never negative; the OTA admin warns about rules that sell below net. Each rule produces one line with the rule id.
5. **Rounding.** Every line is rounded half-up to the currency's minor units (`reference.currencies`), then summed; `selling = net + Σ markup lines (+ Σ fee lines)`, so the database CHECKs always hold exactly.
6. **Currency.** A fixed amount is applied only when `fixed_currency` (or `fee_rules.currency`) equals the offer currency; otherwise the rule's fixed part is skipped and the percentage part (if any) still applies. The OTA admin warns about rules whose fixed currency differs from the default currency. No FX conversion in the MVP.
7. **Fees by step.**

   | Step | Fee types applied |
   |---|---|
   | Search results (`flight_offers`) | none (markup only; `selling_total = net + markup`) |
   | Pricing (`priced_offers`) | `booking_service`, `ticketing` |
   | Extras (`checkout.setAncillaries`) | `ancillary_service` per extra |
   | Card brand known (`checkout.updatePayment`) | Amadeus credit-card fee + `payment_card` rules matching `cardBrands` |
   | Cancellation quote | `cancellation`; non-refundable fees are kept |
   | Change | `change` rules stored, unused (no exchanges in the MVP) |

   The storefront shows the fee lines' `label` in the price breakdown; results pages show "from" prices without fees, as the contract's two totals intend.

   **2026-10-23 (lead decisions (1) and (2), second batch, FIX-W28-CANCEL): what a cancellation keeps.** The card fee of a payment (the Amadeus credit-card fee plus the `payment_card` rules of the brand) was refunded with the rest, because the rules' `refundable` flags were not stored with the payment. Each line is now stored with the payment when its card fee is quoted (checkout.createPayment, checkout.updatePayment: `payments.card_fee_lines`, tenant migration `0004`, `[{source, ruleId, amount, refundable}]`): the Amadeus fee never refundable, an OTA line with its rule's flag at that moment, so a rule changed or deleted later changes nothing. The cancellation quote keeps, besides the `cancellation` fees and the non-refundable fees of the priced offer, the card fee less its refundable lines; a payment without lines (written before `0004`) keeps the whole card fee. The same split applies to a payment that is only authorised: the amount kept is captured and the rest of the authorisation released ([OADR-0010](0010-stripe-gateway-and-payment-webhooks.md) point 6, dated note). With `pricing_mode = 'net'` (point 9) nothing changes: the card fee's only line is the Amadeus fee, and the airline, which holds the money, reverses its whole charge.
8. **Snapshot.** `priced_offers` and `bookings` store `markup_rule_id` (the base rule), the amounts, and the full line list in the existing jsonb payload, so a later rule change or deletion never changes a booked price.
9. **Airline card.** With `pricing_mode = 'net'` the engine is bypassed: selling equals net, fees are only the Amadeus card fee ([OADR-0004](0004-airline-card-data-handling.md)).
10. **Console bookings and imports** use `pricing_mode` `markup_rules`, `net` or `override` as the contract defines; `override` stores the given selling total and the difference as markup.

## Consequences

### Positive

- One audited place for the money rules, with exact decimal arithmetic and rounding that satisfies the database CHECKs.
- OTAs get predictable behaviour: first match wins, stackable rules add, the default rule catches the rest.
- Booked prices are immutable history.

### Negative

- Fixed amounts in a foreign currency are silently skipped (with an admin warning) until FX is added.
- Stacking semantics must be explained in the OTA admin; misconfigured stackable rules can add up quickly (the admin shows the matched rules on a booking).

### Follow-ups

- Later: a pricing simulator endpoint for the OTA admin (net amount + attributes → lines), and FX for fixed amounts.

## Alternatives considered

- **All matching rules add up.** Hard to reason about and easy to over-charge; the reference design names "first matching rule".
- **Fees already in search results.** The contract keeps fees for the priced offer; showing them at search would require pricing every offer.
- **Floating-point arithmetic.** Forbidden by the conventions; rounding errors would break the CHECKs.

## References

- [`tenant.sql`](../../../docs/velexis-sdk/db/tenant.sql) (`markup_rules`, `fee_rules`, `flight_offers`, `priced_offers`, `bookings`), [db README §2.1](../../../docs/velexis-sdk/db/README.md)
- Contract `flights.search` (pricing and storage), `checkout.createPayment` (credit-card fee) in the [OpenAPI document](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)
- [`../api-changes-console-and-internal.md`](../api-changes-console-and-internal.md) §2.1–§2.2, [OADR-0002](0002-offer-and-priced-offer-caching.md)
