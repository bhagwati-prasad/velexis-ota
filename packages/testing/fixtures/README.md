# Test fixtures of `@velexis/testing`

Data files that the helpers of this package load at run time. They ship with the package (`"files"` in [`package.json`](../package.json)) and sit next to `src/` and `dist/`, so the helpers find them from both.

| Folder | Used by | Task |
|---|---|---|
| [`stripe/`](stripe/) | `@velexis/testing/stripe`: `signedStripeEvent`, `stripeFixture` ([package README](../README.md#stripe-velexistestingstripe)) | X-028 |

## `stripe/`: Stripe webhook events

One **synthetic** event per event type of the webhook table in [`docs/mvp/architecture.md`](../../../docs/mvp/architecture.md#d-stripe-webhooks-platform-billing-vs-ota-payments) §5 (d), named `<event type>.json`, as Stripe delivers it to a webhook endpoint: a test-mode `event` object (`livemode: false`) with the API version of the pinned `stripe` package (`Stripe.API_VERSION`, `2025-08-27.basil` for `stripe` 18.5.0), with every field the SDK's type marks as always present. Nothing in them comes from a real account: no key, no secret, no real customer, no card number.

They tell one consistent story, so a test can seed one payment or one subscription and replay several events against it:

| File | Endpoint | Object | Story | Tenant from |
|---|---|---|---|---|
| `payment_intent.payment_failed.json` | `/webhooks/stripe/velexis/{test,live}` | `pi_test_alpha_1`, `requires_payment_method` | The first card is declined (`card_declined`, `generic_decline`, test card ending 0002); charge `ch_test_alpha_declined` | `data.object.metadata.velexis_tenant_id` |
| `payment_intent.amount_capturable_updated.json` | same | `pi_test_alpha_1`, `requires_capture` | The second card (ending 4242) is authorised: 452.10 EUR, `capture_method: manual`; charge `ch_test_alpha_1` | same |
| `payment_intent.succeeded.json` | same | `pi_test_alpha_1`, `succeeded` | Captured after the Amadeus order exists | same |
| `charge.refunded.json` | same | `ch_test_alpha_1` | Refunded in full (`previous_attributes`: not refunded) | same (Stripe copies the PaymentIntent's metadata to its charges) |
| `charge.dispute.created.json` | same | `dp_test_alpha_1` on `ch_test_alpha_1` | A fraud chargeback (`needs_response`, Visa 10.4) with its 15.00 EUR dispute fee | **Not on the dispute:** Stripe does not copy metadata to disputes (`metadata: {}`). The disputed charge (`charge`) and PaymentIntent (`payment_intent`) carry it |
| `checkout.session.completed.json` | `/webhooks/stripe/billing` | `cs_test_alpha_1`, `mode: subscription`, `paid` | The owner subscribes to `growth` (49.00 EUR a month): customer `cus_test_alpha`, subscription `sub_test_alpha_1`, invoice `in_test_alpha_1` | `client_reference_id`, and `metadata` (`velexis_tenant_id`, `velexis_subscription_id`, `velexis_plan_code`) |
| `customer.subscription.updated.json` | same | `sub_test_alpha_1`, `active` | The owner cancels at the period end in the Customer Portal (`cancel_at_period_end: true`) | `metadata` (from `subscription_data.metadata`) |
| `invoice.paid.json` | same | `in_test_alpha_1`, `paid` | The first invoice (`subscription_create`) | `parent.subscription_details.metadata` (the invoice's own `metadata` is empty) |
| `account.updated.json` | `/webhooks/stripe/connect-accounts` (M5) | `acct_test_alpha`, Standard | The OTA's connected account can take charges (`previous_attributes`: `charges_enabled: false`) | `event.account` |
| `account.application.deauthorized.json` | same (M5) | `ca_test_velexis` | The OTA disconnects Velexis from its Stripe account | `event.account` |

The tenant of the payment fixtures is `ten_test_alpha` in `velexis_environment: test`, with `checkout_id: chk_test_alpha_1` and `payment_id: pay_test_alpha_1` ([ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) "metadata"). The M5 endpoints `connect/{test,live}` and `c/<ppc_id>` receive the same payment events with `account` set: override it (`{ account: "acct_testalpha" }`; 2026-10-31, FIX-W37-OTA: an account reference is `acct_` and letters and digits only, as the platform's CHECK on `platform.payment_provider_connections.account_reference` (`^acct_[A-Za-z0-9]+$`, `platform/backend/migrations/platform/0002_add_mvp_platform_deltas.sql`) and the OTA's `ACCOUNT_REFERENCE` in `ota/backend/src/payments/payment-gateway.ts` require, so the `acct_test_alpha` of `account.updated.json` would be refused as an override).

### What [`src/stripe.test.ts`](../src/stripe.test.ts) checks on every fixture (`pnpm --filter @velexis/testing test`)

- `stripe.webhooks.constructEvent` accepts it once signed, and rejects it after any change to the signed body;
- the folder holds exactly one file per type of `STRIPE_FIXTURE_EVENT_TYPES`, and those types cover every event type and `prefix.*` pattern of the webhook table in `architecture.md` (a row added there without a fixture fails the test);
- **the scan** (`scanStripeFixture`): no Stripe API key (`sk_`/`rk_` live or test, `pk_live_`), no webhook secret (`whsec_`), no `@` outside `example.com`, no run of 13 or more digits (card numbers have 13 to 19, also grouped with spaces or dashes), no `"livemode": true`;
- `object: "event"`, `livemode: false`, `api_version` equal to `Stripe.API_VERSION` of the pinned `stripe`, and every id (`id` and every reference field, such as `customer`, `charge`, `payment_intent`, `subscription`, the `velexis_*` metadata) of the form `<prefix>_test_…`;
- the tenant is where the last column above says.

### Refreshing a fixture from `stripe trigger`

Do this when the pinned `stripe` package moves to a new API version (the `api_version` check fails), or when a handler needs a field a fixture lacks. It needs the Stripe CLI and a Stripe **test-mode** account or sandbox whose API version is the pinned one ([`local-development.md`](../../../docs/mvp/local-development.md) §6). Never use live mode.

1. Capture the event as Stripe delivers it, in one terminal:

   ```bash
   stripe listen --print-json --events payment_intent.succeeded > /tmp/stripe-events.jsonl
   ```

2. Trigger it in another, with the Velexis metadata set when the object is created (`--add <resource>:<path>=<value>`):

   ```bash
   stripe trigger payment_intent.succeeded \
     --add payment_intent:metadata.velexis_tenant_id=ten_test_alpha \
     --add payment_intent:metadata.velexis_environment=test \
     --add payment_intent:metadata.checkout_id=chk_test_alpha_1 \
     --add payment_intent:metadata.payment_id=pay_test_alpha_1
   ```

   `stripe trigger` creates its own objects (a customer, a payment method, a product), so the captured event differs in shape from what the backends create (for example `capture_method: automatic`). Keep the fields of the captured event and the values of the current fixture where they tell the story above.

3. **Scrub** the event by hand into `stripe/<event type>.json`. Nothing of the capture may stay that identifies the account, a person or a card:
   - every id becomes the synthetic id of the story (`evt_test_…`, `pi_test_alpha_1`, `ch_test_alpha_1`, `cus_test_alpha`, `sub_test_alpha_1`, `in_test_alpha_1`, …), the same in every fixture that refers to it, and `request.id` becomes `req_test_…` or `null` and `request.idempotency_key` `null`;
   - e-mail addresses become `…@example.com`; names, phone numbers and postal addresses become `null` (keep a `country`);
   - card details keep only Stripe's documented test values (brand, `last4` of a test card, `exp_month`/`exp_year`); `fingerprint` becomes `TestFingerprint…`; `network_transaction_id`, `authorization_code`, `receipt_url` and `receipt_number` become `null`; a `client_secret` becomes `<object id>_secret_synthetic`;
   - URLs that name the account (`hosted_invoice_url`, `invoice_pdf`) use `acct_test_velexis`;
   - timestamps (Unix seconds) and amounts may stay; keep `livemode: false` and `api_version` as captured.
4. A new event type also goes into `STRIPE_FIXTURE_EVENT_TYPES` in [`src/stripe.ts`](../src/stripe.ts) and into the table above. Then run Prettier and the tests:

   ```bash
   pnpm exec prettier --write packages/testing/fixtures/stripe
   pnpm --filter @velexis/testing build && pnpm --filter @velexis/testing test
   ```

   The scan and the id check fail on most leftovers of the capture; they are a safety net, not a replacement for reading the file before committing it.

Delete `/tmp/stripe-events.jsonl` afterwards: unlike the fixtures, it holds the account's real ids.
