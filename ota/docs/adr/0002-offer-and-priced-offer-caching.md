# OADR-0002: Offer and priced-offer caching and expiry

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when search volume makes PostgreSQL inserts of offers a bottleneck (more than about 50 searches per second), or when an asynchronous search mode is needed.

## Context

The contract stores every search and offer (`flight_searches`, `flight_offers`, `offer_upsells`, `priced_offers`) with an `expires_at`, hands out capability ids (`srch_`, `off_`, `prc_`) and filters results in SQL on summary columns ([db README §2.1, §6, §10](../../../docs/velexis-sdk/db/README.md)). It offers a synchronous and an asynchronous search mode, and re-prices at completion when a priced offer is older than `repriceAfterMinutes` (default 10). Amadeus offers are only valid for a short time and fares change. On one VM with one Redis and `noeviction`, large result sets in Redis would compete with queues. We need to fix where offers live, how long each object is valid, when we re-price, and what the purge job does.

## Decision

1. **PostgreSQL is the offer store.** Searches, offers, upsells and priced offers are rows in the tenant schema, inserted in one transaction per search (multi-row insert, at most 250 offers). Redis holds no offer data.
2. **Redis only for single flight.** Identical concurrent searches of one tenant and environment (same normalised criteria hash) share one Amadeus call through `t:<tenantId>:<env>:search:<sha256>` (30 s): the second request waits up to 30 s for the first search id and returns its results. No result cache across visitors beyond that.
3. **Lifetimes.**

   | Object | `expires_at` |
   |---|---|
   | Search and its offers | `now + storefront_settings.offer_ttl_minutes` (default 30) |
   | Upsell offers | Same as the parent search |
   | Priced offer | `min(now + offer_ttl_minutes, end of lastTicketingDate)` |
   | Checkout | `now + checkout_ttl_minutes` (default 30), +15 min when a payment is created |

   Reads after expiry answer `410 SEARCH_EXPIRED` / `OFFER_EXPIRED`, as in the contract.
4. **Re-price rules.** `checkout.complete` (and the airline-card completion) re-prices with Flight Offers Price when the current priced offer is expired, older than 10 minutes, or travellers carry discount or loyalty data. A higher total stops the booking with `409 PRICE_CHANGED`; a lower one is accepted with a warning. `checkout.create` itself does not re-price.
5. **Selling prices are fixed at insert time.** Markups and fees are computed when the offer or priced offer row is written ([OADR-0005](0005-markup-and-fee-engine.md)); a rule change applies to the next search, never to stored offers.
6. **Purge.** `offers.purge` every 15 minutes per tenant deletes expired searches (cascading to offers, upsells and priced offers) **unless** a checkout references one of their priced offers (`priced_offer_id` or `base_priced_offer_id`; the `RESTRICT` foreign keys are the safety net). Deletes run in batches of 500 searches to keep transactions short.
7. **Synchronous search only in the MVP.** `resultOptions.async: true` answers `403 FEATURE_DISABLED` (`details.feature = "asyncSearch"`). The hosted storefront waits for the result with a progress state; the 30 s Amadeus timeout and the SDK's 60 s timeout fit.
8. **Pagination stays in SQL** within one search (`flights.listResults`), sorted by the indexed summary columns; facets and highlights are computed once at insert and stored on the search row.

## Consequences

### Positive

- One store, transactional with the selling-price computation; capability ids survive API restarts and work across processes.
- Redis memory stays small and predictable, which `noeviction` requires.
- The purge is a plain indexed delete; checkouts in progress are never broken by it.

### Negative

- Each search writes up to 250 rows with large jsonb payloads; WAL and table bloat grow with traffic. Autovacuum and the 15-minute purge keep it bounded at MVP volumes.
- No cross-visitor result cache: two visitors searching the same route a minute apart cost two Amadeus calls. Shared-quota buckets protect Amadeus.
- No asynchronous mode for third-party serverless frontends in the MVP.

### Follow-ups

- Measure search insert time and table sizes in the M2 load test; consider partitioning `flight_offers` by day (db README §9) only if needed.
- Asynchronous search (queue `ota-searches`) when a third-party frontend needs it.

## Alternatives considered

- **Offers in Redis with a TTL, only priced offers in PostgreSQL.** Faster writes, but SQL filtering, capability ids across restarts and the contract's `x-tenant-tables` all assume rows; Redis memory would grow with traffic.
- **A cross-visitor search cache (e.g. 5 minutes per route and date).** Saves quota but serves stale availability and complicates per-visitor currency and markups.
- **Re-price on every checkout step.** More Amadeus calls for little gain; the completion re-price catches changes where they matter.

## References

- [db README §2.1, §6, §10](../../../docs/velexis-sdk/db/README.md)
- Contract operations `flights.search`, `flights.listResults`, `flights.price`, `checkout.complete` in the [OpenAPI document](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)
- [`../flows/search-and-price.md`](../flows/search-and-price.md), [OADR-0005](0005-markup-and-fee-engine.md)
