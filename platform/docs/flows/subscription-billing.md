# Flow: subscription billing

This flow covers how an OTA pays Velexis: platform admins link plans to Stripe prices; owners subscribe through Stripe Checkout and manage the subscription in the Stripe Customer Portal; Stripe webhooks keep `platform.subscriptions` and `platform.invoices` in sync; failed payments lead to a banner and, eventually, to suspension; and tenants created before M5 move from the manual trial to Stripe. It implements PF-70 to PF-75 and PF-88, PF-89 of [`../scope.md`](../scope.md), and [ADR-0013](../../../docs/mvp/adr/0013-subscription-billing-stripe-billing.md).

Related: [PADR-0002](../adr/0002-stripe-billing-integration.md), [PADR-0014](../adr/0014-tenant-suspension-and-resume.md), [`signup-and-create-ota.md`](signup-and-create-ota.md), [`../api-inventory-resources.md`](../api-inventory-resources.md) §6, [`../api-inventory-admin.md`](../api-inventory-admin.md) §4 and §8.

## Sequence

```mermaid
sequenceDiagram
  autonumber
  actor V as Platform admin
  actor O as OTA owner
  participant FE as Portal server
  participant PA as Platform API
  participant P as PostgreSQL platform
  participant Q as Redis BullMQ
  participant PW as Platform worker
  participant S as Stripe

  V->>S: Create Product and Prices (dashboard)
  V->>PA: PATCH /v1/admin/plans/growth {stripeProductId, stripePriceIdMonth, stripePriceIdYear}
  PA->>S: prices.retrieve (amount, currency, interval, active)
  PA->>P: plans updated, priceWarnings shown
  O->>FE: Choose plan (wizard, or Billing page)
  FE->>PA: POST …/billing/checkout-session (Idempotency-Key)
  PA->>S: checkout.sessions.create (mode subscription, customer, price, trial, metadata)
  PA-->>FE: url
  O->>S: Pay or start the trial
  S->>PA: POST /webhooks/stripe/billing checkout.session.completed
  PA->>P: stripe_events (evt id unique)
  PA->>Q: platform-stripe-events stripe.event
  PA-->>S: 200
  PW->>S: checkout.sessions.retrieve, then subscriptions.retrieve under the subscription's lock
  PW->>P: subscriptions trialing/active, billing_customers, tenants.plan_code
  PW->>Q: dispatch tenant.provision if waiting (provisioning.md)
  S->>PA: customer.subscription.updated / invoice.* (later)
  PW->>S: re-fetch subscription or invoice
  PW->>P: upsert subscriptions, invoices
  alt status canceled or unpaid
    PW->>P: tenants suspended (billing), provisioning_jobs suspend
    PW->>Q: tenant.suspend, vx:invalidate tenant, e-mail owners
  end
  O->>FE: Manage billing
  FE->>PA: POST …/billing/portal-session
  PA->>S: billingPortal.sessions.create
  FE-->>O: 303 to Stripe Customer Portal
```

## Steps

### A. Plans and prices (admin)

1. Prices are created in Stripe first (one Product per plan, one recurring Price per interval, tax-exclusive, in the plan's currency). Stripe is the source of truth for what is charged.
2. The admin links them on the plan page. The API retrieves each price and stores warnings when the amount, currency or interval differ from the plan, or the price is inactive. Warnings do not block saving; `adminCheckPlanPrices` re-runs the comparison.
3. The Stripe Customer Portal is configured once in the Stripe dashboard: update payment method, view invoices, cancel at period end, switch between the public plans' prices. Velexis builds no billing UI beyond plan display and the portal link.

### B. Checkout

1. **New OTA (M5).** `createTenant` inserts the subscription `incomplete` and calls Checkout ([`signup-and-create-ota.md`](signup-and-create-ota.md)).
2. **Existing OTA** (manual trial ending, canceled subscription, or Checkout abandoned): `createCheckoutSession` on the Billing page. No subscription row is inserted up front, because the current manual row still holds the "one current subscription" slot; the webhook creates the Stripe row.
3. Session parameters: `mode: 'subscription'`; `customer` from `billing_customers` (created with `email = owner e-mail`, `name = legal name or name`, `metadata.velexis_tenant_id` when missing, Stripe idempotency key `customer:<tenantId>`; after a Stripe 5xx, no answer or a refused key, the next attempt first looks for the Customer that attempt made with `customers.search` and otherwise creates it under `customer:<tenantId>:<n>`, the attempt kept in `billing_customer_attempts`, [PADR-0002](../adr/0002-stripe-billing-integration.md) item 3 revision of 2026-10-24); `line_items: [{price, quantity: 1}]`; `client_reference_id: ten_…`; `metadata` and `subscription_data.metadata`: `velexis_tenant_id`, `velexis_subscription_id` (when pre-inserted), `velexis_plan_code`; `subscription_data.trial_period_days` = `plans.trial_days` only for a tenant's first Stripe subscription; `payment_method_collection: 'always'`; `success_url = https://platform.example.com/otas/{id}/setup?checkout=success`; `cancel_url = https://platform.example.com/otas/{id}/billing?checkout=canceled`. Stripe idempotency key `checkout:<tenantId>:<Idempotency-Key>`.

### C. Webhook intake

1. `/webhooks/stripe/billing` verifies the signature on the raw body with `STRIPE_BILLING_WEBHOOK_SECRET`, refuses events whose `livemode` differs from the deployment, inserts `stripe_events {id, endpoint: 'billing', type, livemode, object_type, object_id, api_version, stripe_created_at}` with `ON CONFLICT DO NOTHING`, enqueues `stripe.event` with BullMQ id = event id, and answers `200`.
2. The `stripe_events.sweep` scheduler re-enqueues `received` rows older than 2 minutes, so an enqueue lost after the commit is not lost. It also re-enqueues retryable `failed` rows older than 2 minutes and `processing` rows unchanged for 10 minutes whose BullMQ job is missing or finished, so an attempt that stopped half-way does not strand its event (PBE-043).

### D. Processing (worker, `platform-stripe-events`, concurrency 2)

Each handler sets the event `processing`, **re-fetches the object from Stripe** (never trusts the payload or the order of events), applies the change in one transaction with an audit row, sets `processed` (or `ignored`), then publishes invalidations and enqueues follow-up jobs. The Stripe call comes before the transaction, never inside it; the transaction locks the tenant's row first, so two events of one OTA never interleave their writes (PBE-045).

**One subscription's events run one after the other** (FIX-W30-PLATFORM, lead decision (2) of 2026-10-26, [PADR-0002](../adr/0002-stripe-billing-integration.md) item 5 revision of 2026-10-26). The worker runs two events at a time, and the tenant's row lock orders the writes, not the re-fetches: two events of one subscription whose re-fetches overlapped could commit the older answer after the newer one. So every handler that re-fetches a Stripe subscription and writes it takes the Redis lock of that subscription, `vx:stripe:sub:<sub_…>:lock`, **before the re-fetch** (the Checkout's handler as soon as the session named its subscription) and holds it until its write has committed: 15 s TTL with a random token, renewed every 5 s while the handler runs, confirmed in the transaction just before the commit (when it is no longer the event's, the event fails with the retryable `SUBSCRIPTION_LOCK_LOST` and nothing is written), released after the work that follows the commit. Another event of the subscription waits for it (polling every 100 ms, holding no transaction) and re-fetches only after that commit, so the row ends in Stripe's newest state whichever event Stripe answered first; after 30 s it fails with the retryable `SUBSCRIPTION_BUSY`, and BullMQ runs it again later. PBE-048's resync takes the same lock.

**Lock order of billing**: the subscription's Redis lock (billing sync only, before any transaction), then the tenant's row (`FOR UPDATE`), then the OTA's `billing_customers` row (a completed Checkout), then its subscription rows (the one the event or the admin edits, then the OTA's other current rows in id order), then what the status rules' suspend or resume locks ([PADR-0014](../adr/0014-tenant-suspension-and-resume.md)). The admin's manual edit (§G) keeps it too, since FIX-W30-PLATFORM: it locks the tenant's row before the subscription's, so it and a completed Checkout that replaces the trial wait for each other in turn, never in a circle.

| Event | Handler |
|---|---|
| `checkout.session.completed` (mode subscription) | Retrieve the session; then, under the lock of its subscription, retrieve the subscription. Tenant from `client_reference_id`. Upsert `billing_customers` (the session's Customer, `livemode` and the e-mail address Checkout collected). Find the subscription row by `provider_subscription_id`, else by `metadata.velexis_subscription_id`, else insert one; if a different current row exists (manual trial, or an unpaid `incomplete` Stripe row), set it `canceled` first in the same transaction. Copy status, `provider_customer_id`, `provider_subscription_id`, `provider_price_id`, interval, periods, `trial_ends_at`, `cancel_at_period_end`, `canceled_at`, `checkout_session_id`. Map the price to a plan and set `tenants.plan_code`, then apply the status rules of §E (so a `billing` suspension is resumed). If the tenant is `provisioning` with a `queued` job, dispatch it. If the tenant is `failed` (an abandoned Checkout, §H) and its owner paid through `createCheckoutSession`, so that this subscription is now `trialing` or `active`, re-dispatch it as `retryProvisioning` would: `failed → provisioning`, a new `queued` provision job, `provisioning_job.retried` audited by the system, dispatched after the commit (lead decision (5) of 2026-10-24). |
| `customer.subscription.created`, `…updated`, `…deleted` | Retrieve the subscription under its lock. Locate the row by `provider_subscription_id`, else by `metadata.velexis_subscription_id` (the pre-inserted row of an OTA created in M5); without either, `ignored` (`UNKNOWN_SUBSCRIPTION`): the completed Checkout writes the row of an existing OTA's new subscription. Update status, periods, `cancel_at_period_end`, `canceled_at`, price and plan (a row that becomes current replaces a manual or unpaid row as above). Then apply the status rules of §E, and dispatch the `queued` provision job of a `provisioning` tenant whose subscription is now `trialing` or `active`. |
| `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided` | Retrieve the invoice. Tenant from the customer (`billing_customers`) or the subscription metadata. Upsert `invoices` by `provider_invoice_id`: `number`, status, amounts (minor units converted with the currency's exponent from `reference.currencies`), period, `hosted_invoice_url`, `invoice_pdf_url`, issued, due and paid dates. `payment_failed` also e-mails owners (in addition to Stripe's own e-mail). Two events of one invoice whose re-fetches overlap can commit out of order like a subscription's; see the follow-up of [PADR-0002](../adr/0002-stripe-billing-integration.md) of 2026-10-26 (PBE-046). |
| Anything else, or no tenant found | `ignored`, logged. |

### E. Status rules

| Subscription status | Platform effect |
|---|---|
| `trialing`, `active` | Nothing; if the tenant is suspended with reason `billing`, resume it. |
| `past_due` | `tenants.billing_notice = 'past_due'` and a `tenant` invalidation: banner in the portal and in the OTA admin, which reads it from `tenants`. Stripe Smart Retries and e-mails continue. Cleared when the status is `active` again. |
| `canceled`, `unpaid`, `incomplete_expired` | If the tenant is `active`: suspend with reason `billing` ([PADR-0014](../adr/0014-tenant-suspension-and-resume.md)), e-mail owners. A `provisioning` tenant whose Checkout expired is handled by the abandoned-Checkout job instead. |
| `paused` | Treated like `past_due` (Velexis does not offer pausing in the Customer Portal). |
| `incomplete` | Nothing: the Checkout is not paid yet. |

The rules read the tenant's **shown** subscription (the current one, else the latest), not the event's, so a late event about an earlier, canceled Stripe subscription leaves an OTA that pays a newer one alone; they change nothing for a manual subscription (§G handles it). `tenants.plan_code` follows the shown Stripe subscription's plan, and `trialing` and `active` also clear `billing_notice`. They run in the event's transaction, under the tenant's row lock: the suspend or resume of [PADR-0014](../adr/0014-tenant-suspension-and-resume.md) (status, job, audit, owners' e-mail, invalidation) is written there and its job dispatched after the commit, so two events of one OTA can never suspend it on a subscription that is already paid again. A suspension for `abuse`, `request` or `admin` is never resumed by billing. Each change writes one `subscription.updated` audit row (actor `system`, `billing.sync`, the event id as request id) with the subscription's fields and the tenant's plan and banner before and after.

Billing never deletes data. Reactivation is a new Checkout (canceled) or a successful retry (unpaid → active), which resumes the tenant.

### F. Customer Portal

`createCustomerPortalSession` (owner) calls `stripe.billingPortal.sessions.create({customer, return_url: https://platform.example.com/otas/{id}/billing})` and returns the URL; the portal redirects with `303`.

### G. Manual trials (M1–M4 tenants)

- Before M5, subscriptions are `trialing`, `billing_provider = 'manual'`, on `early_access`, with `trial_ends_at = created_at + 90 days`. Admins may change the date (`adminUpdateManualSubscription`). The edit locks the tenant's row, then the subscription's: the lock order of §D (FIX-W30-PLATFORM).
- From M5, `billing.manual_trials` (daily) e-mails owners 14 and 3 days before `trial_ends_at` and sets `tenants.billing_notice = 'trial_ending'`; on the end date it sets the manual row `past_due`; 14 days later it sets it `canceled` and suspends the tenant (`billing`). Choosing a plan at any point goes through §B and replaces the manual row.

### H. Abandoned Checkout

`billing.abandoned_checkouts` (daily): tenants in `provisioning` whose current subscription is `incomplete` and older than 48 hours → subscription `incomplete_expired`, job `canceled`, tenant `failed`, audit. The key stays reserved; the owner can retry from the portal.

## Failure handling

| Failure | Behaviour |
|---|---|
| Invalid signature | `400 WEBHOOK_SIGNATURE_INVALID`, logged as a security event. |
| Duplicate event | Inbox insert does nothing; `200`. |
| Out-of-order events | Harmless: every handler re-fetches the current object. |
| Two events of one subscription at once | The second waits for the subscription's lock and re-fetches after the first one's commit, so the newest state is written last (§D). A lock still held after 30 s fails the event with the retryable `SUBSCRIPTION_BUSY`; a lock lost before the commit (Redis unreachable for 15 s) with `SUBSCRIPTION_LOCK_LOST`, writing nothing; BullMQ runs it again. |
| Stripe API down during processing | The job fails and retries (5 attempts, backoff); then the event is `failed`, visible in the admin (`adminReprocessStripeEvent`). |
| Price not linked to any plan | Event `failed` with `UNKNOWN_PRICE`; dashboard alert; admin links the price and reprocesses. A price linked to two plans fails the same way, and a subscription with more than one item with `UNSUPPORTED_SUBSCRIPTION`. |
| Subscription event before the Checkout's | `ignored` (`UNKNOWN_SUBSCRIPTION`) when no row is the subscription's yet; `checkout.session.completed` re-fetches the subscription and writes its current state. |
| Two current Stripe subscriptions, or a Customer or row of another OTA | Event `failed` for good (`SUBSCRIPTION_CONFLICT`, `CUSTOMER_CONFLICT`, `TENANT_MISMATCH`); nothing is written, an admin resolves it in Stripe and reprocesses. |
| Webhook endpoint down | Stripe retries for 3 days; Checkout success pages keep polling. |

## Tables touched

`plans`, `billing_customers`, `billing_customer_attempts`, `subscriptions`, `invoices`, `stripe_events`, `tenants` (`plan_code`, suspension), `provisioning_jobs` (dispatch, suspend, resume), `email_outbox`, `platform_audit_log`. Reads `reference.currencies`.

## Tests that prove it

- Signed fixture events in CI ([ADR-0015](../../../docs/mvp/adr/0015-testing-strategy.md)) with a mocked Stripe client: duplicate and reversed delivery give the same final rows; `checkout.session.completed` dispatches provisioning once; `unpaid` suspends and `active` resumes a `billing` suspension but not an `abuse` one; manual row replaced on Checkout; a failed OTA paid through `createCheckoutSession` is re-dispatched once; a late event about an earlier, canceled subscription leaves an OTA that pays a newer one alone; a second current Stripe subscription, or a Customer, row or metadata of another OTA, fails the event for good and writes nothing (`platform/backend/test/integration/billing/billing-events.int.test.ts`, PBE-045; the rules as a table in `src/billing/sync/status-rules.test.ts`).
- FIX-W30-PLATFORM: two events of one subscription processed at once, the first re-fetch answered before Stripe's change and held, end in the newest state, for both directions of the change (`past_due` then `active`, `active` then `past_due`) and in both orders of a completed Checkout and its subscription's event; the manual edit and a billing-sync write on the same OTA never deadlock, whichever holds the tenant first (`billing-events.int.test.ts`); the edit waits for the tenant holding no lock on the subscription (`test/integration/admin/admin-subscriptions.int.test.ts`); the lock's wait, renewal (also after a renewal Redis failed), loss, confirmation and release (`src/billing/sync/subscription-lock.test.ts`).
- Manual run with Stripe test mode and `stripe listen --forward-to localhost:3100/webhooks/stripe/billing`.
