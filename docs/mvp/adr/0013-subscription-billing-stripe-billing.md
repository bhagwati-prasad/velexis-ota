# ADR-0013: Subscription billing with Stripe Billing

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (Stripe Billing, Checkout, Customer Portal, webhooks syncing subscriptions and invoices), lead architect (sync and suspension rules, pre-M5 behaviour)

## Context

[`decisions.md`](../decisions.md) §2 makes OTA subscriptions **Stripe Billing subscriptions**:

- plans map to Stripe prices;
- sign-up goes through Stripe Checkout;
- management goes through the Stripe Customer Portal;
- webhooks keep `platform.subscriptions` and `platform.invoices` in sync.

The schema already has `plans` (monthly and annual price, per-booking fee, limits, features), `subscriptions` and `invoices`, all with provider id columns. Paid billing lands in **M5**, but OTAs are created from M1.

## Decision

1. **Stripe objects.**
   - One Stripe Product per plan and one Price per billing interval.
   - `platform.plans` gains `stripe_product_id`, `stripe_price_id_month` and `stripe_price_id_year` (platform delta), set by platform admins.
   - Prices are created in Stripe first, then linked. Stripe is the source of truth for amounts actually charged.
2. **Velexis's Stripe account** is used for billing, in the same account as OTA payments in `velexis` mode ([ADR-0011](0011-payments-stripe-and-airline-card.md)). The billing webhook endpoint is separate from the payments endpoints and only subscribes to billing events.
3. **Sign-up flow (M5):**
   1. **Create OTA** inserts the tenant (`provisioning`), its owner membership and a subscription with `status = incomplete`, then creates a **Checkout Session** (`mode = subscription`, `client_reference_id = ten_…`, metadata with tenant and subscription ids, trial days from the plan).
   2. The browser goes to Stripe Checkout and back to the portal.
   3. The `checkout.session.completed` webhook (not the browser redirect) sets the subscription to `trialing` or `active` and enqueues `tenant.provision` ([ADR-0009](0009-background-jobs-bullmq.md)).
   See [`../architecture.md`](../architecture.md) flow (a).
4. **Before M5 (M1–M4):** create OTA skips Checkout. The subscription is created as `trialing` with `billing_provider = 'manual'` on a free internal plan, and provisioning is enqueued at once. M5 migrates these tenants by sending owners through Checkout when the trial ends.
5. **Management:** the portal's **Billing** page opens a Stripe **Customer Portal** session (change plan, card, cancel, download invoices). Velexis builds no billing UI beyond plan display and the portal link.
6. **Webhook sync.** Endpoint: `https://api.platform.example.com/webhooks/stripe/billing`. Events:
   - `checkout.session.completed`;
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`;
   - `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`.

   Processing:
   - verify the signature on the raw body;
   - insert into a platform webhook inbox table (platform delta, unique Stripe event id);
   - answer `200`;
   - process in `platform-stripe-events`.

   Handlers **re-fetch the object from Stripe** instead of trusting event order, then upsert `subscriptions` (status, period, `cancel_at_period_end`) and `invoices` (amounts, status, Stripe-hosted PDF link; `number` from Stripe). `tenants.plan_code` follows the subscription.
7. **Dunning and suspension:**
   - Stripe Smart Retries and Stripe's e-mails handle failed payments.
   - `past_due` shows a banner in the portal and the OTA admin.
   - When the subscription becomes `canceled` or `unpaid`, the platform sets the tenant to `suspended` (`suspension_reason = 'billing'`) and publishes a cache invalidation. The OTA backend then answers `TENANT_SUSPENDED` (db README §5).
   - Reactivation reverses this. Data is never deleted by billing events.
8. **Taxes:** Stripe Tax is off in the MVP. Prices are tax-exclusive, and the platform admin can set a tax rate per customer in Stripe. Revisit before selling outside the first market.
9. **Usage fees** (`per_booking_fee`, `included_bookings`) are **post-MVP**. MVP plans set them to 0. When they come, the OTA backend will send usage events over `platform-tenant-events` to Stripe Billing meters.
10. **Testing:** Stripe test mode, `stripe listen --forward-to localhost:3100/webhooks/stripe/billing` in development, and signed fixture events in CI ([ADR-0015](0015-testing-strategy.md)).

## Consequences

### Positive

- No PCI scope and almost no billing UI to build. Stripe hosts Checkout, invoices and the card update flow.
- Re-fetching objects makes the sync robust to duplicate and out-of-order events.
- The pre-M5 manual path lets M1–M4 proceed without billing.

### Negative

- Tenants are created before payment succeeds. An abandoned Checkout leaves a `provisioning` tenant with an `incomplete` subscription. A daily cleanup marks such tenants `failed` after 48 hours. Their key stays reserved, as db README §3 requires.
- Plan prices live in two places (Stripe and `platform.plans`). The platform admin shows a mismatch warning.

### Follow-ups

- Decided during planning; revisit Stripe Tax when Velexis sells in a second tax jurisdiction, and metered usage fees after the MVP.

## Alternatives considered

- **Custom billing with PaymentIntents.** Re-implements invoicing, dunning and proration.
- **Paddle or Lemon Squeezy as merchant of record.** Handles tax, but the product owner chose Stripe Billing.
- **Provision only after payment, with no tenant row before Checkout.** It would need a new pre-tenant state, and the key could be taken by someone else during Checkout. Reserving the tenant row first is simpler.

## References

- [`../decisions.md`](../decisions.md) §2
- [`../../velexis-sdk/db/platform.sql`](../../velexis-sdk/db/platform.sql) (`plans`, `subscriptions`, `invoices`)
- [ADR-0009](0009-background-jobs-bullmq.md), [ADR-0011](0011-payments-stripe-and-airline-card.md)
- [`../architecture.md`](../architecture.md), flows (a) and (d)
