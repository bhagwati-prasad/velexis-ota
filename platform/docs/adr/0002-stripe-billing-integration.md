# PADR-0002: Stripe Billing integration details

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when Velexis sells in a second tax jurisdiction, adds metered usage fees, or needs a second billing currency.

## Context

[ADR-0013](../../../docs/mvp/adr/0013-subscription-billing-stripe-billing.md) chooses Stripe Billing: plans map to prices, sign-up through Checkout, management through the Customer Portal, webhooks syncing `subscriptions` and `invoices`, suspension on non-payment, and a manual path before M5. It leaves open the Stripe object model per tenant, the exact Checkout parameters, how events are stored and processed, how prices map back to plans, and how manual trials move to Stripe.

## Decision

1. **One Stripe Customer per tenant**, stored in a new `platform.billing_customers` table (`tenant_id` primary key, `cus_…` unique). It is created on the first Checkout with the owner's e-mail, the tenant's legal name or name, and `metadata.velexis_tenant_id`, and reused for every later Checkout and Customer Portal session, including after a cancellation. The billing e-mail is managed in the Customer Portal and copied back on sync.
2. **Plans ↔ prices.** `plans.stripe_product_id`, `stripe_price_id_month`, `stripe_price_id_year` (each price unique across plans). Admins create products and prices in Stripe and link them; the API compares amount, currency, interval and `active` and shows warnings. A webhook for a price that maps to no plan fails with `UNKNOWN_PRICE` until an admin links it and reprocesses.
3. **Checkout parameters** (fixed in code): `mode: 'subscription'`; `customer`; one line item; `client_reference_id = ten_…`; metadata `velexis_tenant_id`, `velexis_subscription_id` (when a row was pre-inserted), `velexis_plan_code` on both the session and `subscription_data`; `trial_period_days` from the plan for the tenant's **first** Stripe subscription only; `payment_method_collection: 'always'`; `allow_promotion_codes: false` in the MVP; no automatic tax; success and cancel URLs on `platform.example.com`; Stripe idempotency key `checkout:<tenantId>:<Idempotency-Key>`.
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

### Negative

- Prices live in two places; mismatches are warnings, not blocks, so an admin can still save a wrong link.
- Re-fetching costs one Stripe API call per event (a few per subscription per month: negligible).
- A pending manual trial row and a new Stripe row cannot coexist; existing tenants get no "incomplete" row while they are in Checkout.

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
