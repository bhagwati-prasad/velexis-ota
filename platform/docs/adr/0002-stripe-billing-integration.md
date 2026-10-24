# PADR-0002: Stripe Billing integration details

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when Velexis sells in a second tax jurisdiction, adds metered usage fees, or needs a second billing currency.
**Revisions:** 2026-10-24 (lead decision (5) of 2026-10-24, recorded with FIX-W29-PLATFORM): item 3 gains the Stripe idempotency key of the Customer that a Checkout creates and its attempts: after a Stripe 5xx, which Stripe replays for the same key for 24 hours, the next attempt looks for the Customer the failed one may have made and otherwise creates it under `customer:<tenantId>:<n>`, so one error no longer blocks an OTA's Checkout for a day. Item 3 also says that the request lock of the two idempotent operations that wait on Stripe is renewed while their handler runs, instead of the handler being bounded below the lock. The Consequences follow.

## Context

[ADR-0013](../../../docs/mvp/adr/0013-subscription-billing-stripe-billing.md) chooses Stripe Billing: plans map to prices, sign-up through Checkout, management through the Customer Portal, webhooks syncing `subscriptions` and `invoices`, suspension on non-payment, and a manual path before M5. It leaves open the Stripe object model per tenant, the exact Checkout parameters, how events are stored and processed, how prices map back to plans, and how manual trials move to Stripe.

## Decision

1. **One Stripe Customer per tenant**, stored in a new `platform.billing_customers` table (`tenant_id` primary key, `cus_…` unique). It is created on the first Checkout with the owner's e-mail, the tenant's legal name or name, and `metadata.velexis_tenant_id`, and reused for every later Checkout and Customer Portal session, including after a cancellation. The billing e-mail is managed in the Customer Portal and copied back on sync.
2. **Plans ↔ prices.** `plans.stripe_product_id`, `stripe_price_id_month`, `stripe_price_id_year` (each price unique across plans). Admins create products and prices in Stripe and link them; the API compares amount, currency, interval and `active` and shows warnings. A webhook for a price that maps to no plan fails with `UNKNOWN_PRICE` until an admin links it and reprocesses.
3. **Checkout parameters** (fixed in code): `mode: 'subscription'`; `customer`; one line item; `client_reference_id = ten_…`; metadata `velexis_tenant_id`, `velexis_subscription_id` (when a row was pre-inserted), `velexis_plan_code` on both the session and `subscription_data`; `trial_period_days` from the plan for the tenant's **first** Stripe subscription only; `payment_method_collection: 'always'`; `allow_promotion_codes: false` in the MVP; no automatic tax; success and cancel URLs on `platform.example.com`; Stripe idempotency key `checkout:<tenantId>:<Idempotency-Key>`.
   - **The Customer's key** (revision of 2026-10-24). The Customer of item 1 is created with the Stripe idempotency key `customer:<tenantId>` on the first attempt, so two first Checkouts of one OTA at once get the same Customer. A creation that fails in a way that spends the key moves the tenant to its next attempt, kept in `platform.billing_customer_attempts` (no row is attempt 0; the move is a compare-and-set, so concurrent failures of one attempt move it once): a Stripe 5xx (Stripe stores it and replays it for the key for 24 hours), no answer (a timeout or a lost connection after the SDK's retry: Stripe may have made the Customer or stored a failure), or the key refused as used with other parameters (`idempotency_error`). A rate limit, another refused request or a success never move it: Stripe kept nothing for the key, or the key answers the Customer again. Attempt `n` ≥ 1 first looks for a Customer an earlier attempt made (`customers.search` on `metadata['velexis_tenant_id']`, the oldest when there are several) and stores that one; otherwise it creates one with the key `customer:<tenantId>:<n>`. A failed search answers `502 PROVIDER_ERROR` and creates nothing.
   - **The request lock** (revision of 2026-10-24). `createTenant` and `createCheckoutSession` wait on Stripe calls with a 10-second timeout and one network retry each (the Stripe client of [platform architecture §7](../architecture.md#7-external-services)), longer than the 10-second lock of the request's `Idempotency-Key` (PBE-009). The request that holds the lock renews it every 3 seconds, with its own token, until its answer is stored, so a request with the same key that arrives meanwhile waits up to 10 seconds and replays the answer, or answers `503 SERVICE_UNAVAILABLE`, and never runs the handler a second time. A lock that was lost all the same (Redis unreachable for a whole TTL) is not renewed again, and the token keeps a request from renewing or releasing another one's lock. Bounding the handler below the lock was not chosen: it would cut the Stripe timeout or its retry for these calls only.
4. **Webhook intake** at `/webhooks/stripe/billing`: signature verified on the raw body; `livemode` must equal the deployment's mode; the event is inserted into `platform.stripe_events` (event id primary key, ids and types only, no payload) and enqueued on `platform-stripe-events` with BullMQ id = event id; the endpoint answers `200` without calling Stripe. A sweep re-enqueues inbox rows left `received`.
5. **Processing** re-fetches the session, subscription or invoice from Stripe and upserts by provider ids, so duplicates and reordering converge. Handlers act on the current Stripe state, never on the event's snapshot.
6. **One current subscription per tenant** (partial unique index, now including `unpaid`). When Checkout completes for a tenant that still has a manual row, the handler cancels the manual row and inserts the Stripe row in one transaction.
7. **Status effects**: `past_due` and trial notices set `tenants.billing_notice` (read by the OTA admin through the tenant row); `canceled`, `unpaid` and `incomplete_expired` suspend an active tenant with reason `billing`; `trialing` or `active` resume a `billing` suspension. Never delete data.
8. **Amounts**: Stripe minor units are converted with the currency exponent from `reference.currencies`; money stays decimal strings in the API. Invoices keep Stripe's `number`, `hosted_invoice_url` and `invoice_pdf` (no PDF stored by Velexis).
9. **Manual trials**: `early_access` plan (seeded by migration `0002`), `trial_ends_at = created_at + 90 days`, changeable by admins. From M5 a daily job sends notices at 14 and 3 days, moves the row to `past_due` at the end date and suspends 14 days later unless the owner went through Checkout.
10. **Stripe API version** pinned in code with the SDK; the webhook endpoint in the Stripe dashboard is created with the same version. An upgrade is a task with fixture updates.
11. **Feature switch** `FEATURE_STRIPE_BILLING` ([PADR-0015](0015-milestone-feature-switches.md)): off before M5 (manual path), on at M5.

## Consequences

### Positive

- No duplicate Stripe customers; the Customer Portal always works for a tenant that ever paid.
- The webhook endpoint is fast and never loses an event; processing is retryable and visible in the admin.
- The pre-M5 tenants have a clear, automated route to paid plans.
- A Stripe error while the Customer is created costs the owner one more click on "Continue to payment", not 24 hours (revision of 2026-10-24).

### Negative

- Prices live in two places; mismatches are warnings, not blocks, so an admin can still save a wrong link.
- Re-fetching costs one Stripe API call per event (a few per subscription per month: negligible).
- A pending manual trial row and a new Stripe row cannot coexist; existing tenants get no "incomplete" row while they are in Checkout.
- Stripe's search index may lag up to a minute behind a Customer just made. An attempt within that minute after a failure whose Customer Stripe did make creates a second Customer; `billing_customers` keeps the first one stored and the other stays unused in Stripe (revision of 2026-10-24).
- One more table, `billing_customer_attempts` (platform migration `0003`), for a counter that only matters for a day after a failure (revision of 2026-10-24).

### Follow-ups

- Promotion codes, Stripe Tax and usage-based fees ([ADR-0013](../../../docs/mvp/adr/0013-subscription-billing-stripe-billing.md) points 8 and 9) are post-MVP.
- A daily drift check comparing active Stripe subscriptions with `platform.subscriptions` would catch missed events; add it if the admin's event list ever shows gaps.

## Alternatives considered

- **Customer per portal account** (one account paying for several OTAs). Simpler for agencies, but invoices, cancellation and suspension are per OTA, and `subscriptions` are per tenant.
- **Storing the full event payload.** Useful for debugging, but it holds billing contacts' personal data and is not needed because handlers re-fetch.
- **Trusting the Checkout redirect** to activate. Rejected by ADR-0013: only the webhook is authoritative.

## References

- [ADR-0013](../../../docs/mvp/adr/0013-subscription-billing-stripe-billing.md), [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md)
- [`../flows/subscription-billing.md`](../flows/subscription-billing.md), [`../data-model.md`](../data-model.md) §4.6
- Stripe Checkout and Billing documentation: <https://docs.stripe.com/billing/subscriptions/build-subscriptions>
