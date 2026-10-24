# OADR-0010: Stripe gateway and payment webhooks

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when a second payment provider is added, when Stripe disputes need handling in the OTA admin, or when the legal review of Velexis-collected payments changes the default mode (ADR-0011 follow-up).
**Revisions:** 2026-10-12 (planning review): point 4 binds the tenant to the endpoint, cross-checks metadata and `livemode`, and acknowledges mismatches without effect. 2026-10-23 (lead decision (4), FIX-W27-FOLLOWUPS): point 6 gains the `refunds.sweep` schedule, which queues `refund.submit` again for a refund whose enqueue was lost (dated note under point 6). 2026-10-23 (lead decisions (1) and (2), second batch, FIX-W28-CANCEL): a cancellation of a booking whose payment is only authorised captures the amount the OTA keeps and releases the rest, and voids only when it keeps nothing; a card fee is kept unless its stored line is refundable (point 3 gains the key `pi:capture:<pay_id>:cancellation:<amount>`, dated note under point 6; the Consequences and References follow).

## Context

[ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) fixes three Stripe account modes (`velexis` in M3; `connect_standard` and `api_keys` in M5), PaymentIntents with manual capture after the order exists, metadata `velexis_tenant_id`, `velexis_environment`, `checkout_id`, `payment_id`, a statement descriptor suffix in `velexis` mode, webhook verification on the raw body, de-duplication on `payment_events.provider_event_id`, `200` at once and processing in `ota-stripe-events`, and a `PaymentGateway` interface. The webhook endpoints are listed in [architecture flow (d)](../../../docs/mvp/architecture.md#d-stripe-webhooks-platform-billing-vs-ota-payments). Open: how a webhook finds its payment row, which events matter, the idempotency keys, what is re-fetched, and how the mode is chosen without per-tenant code.

## Decision

1. **Mode selection is data.** `StripeGateway` reads the tenant's cached `payment_provider_connections` row for the environment and builds a Stripe client:

   | `account_mode` | API key | Extra header | Publishable key to the storefront |
   |---|---|---|---|
   | `velexis` | `STRIPE_SECRET_KEY_<ENV>` | — | `STRIPE_PUBLISHABLE_KEY_<ENV>` |
   | `connect_standard` | `STRIPE_SECRET_KEY_<ENV>` | `Stripe-Account: <account_reference>` (direct charges) | Velexis's, with `accountId` |
   | `api_keys` | Decrypted connection secret (inside the gateway only) | — | The connection's publishable key |

   The `stripe` SDK is created with a pinned `apiVersion`, 10 s timeout and `maxNetworkRetries: 1` (safe because every POST carries an idempotency key).
2. **Payment rows first.** `createSession` inserts the `payments` row (`requires_payment_method`) and commits **before** calling Stripe, so a webhook can always find the row through `metadata.payment_id`; the PaymentIntent id is stored right after the call.
3. **Idempotency keys** (Stripe `Idempotency-Key`): `pi:create:<pay_id>`, `pi:update:<pay_id>:<version>`, `pi:capture:<pay_id>:<amount>`, `pi:cancel:<pay_id>`, `refund:<rfd_id>`; since 2026-10-23 (FIX-W28-CANCEL) `pi:capture:<pay_id>:cancellation:<amount>`, the capture of the amount a cancellation keeps (one per booking cancellation, below), so it never meets the key of a capture of the order that failed (Stripe would replay that answer).
4. **Webhook receivers** (`payments/webhooks/*.controller.ts`, raw body):
   - verify the signature with the secret of the endpoint (`velexis/{test,live}`: environment secrets; `connect/{test,live}`: Connect secrets; `c/<ppc_id>`: that connection's encrypted webhook secret);
   - find the tenant **by the endpoint's own rule**, never by trying sources in turn:

     | Endpoint | Tenant from | Why |
     |---|---|---|
     | `velexis/{environment}` | `metadata.velexis_tenant_id` | Only Velexis creates PaymentIntents on its own account, so the metadata is ours |
     | `connect/{environment}` | `event.account` → the `connect_standard` connection with that `account_reference`, only | The OTA controls its connected account and can write any metadata |
     | `c/<ppc_id>` | The path's connection, only | The OTA owns that account and, in `api_keys` mode, even knows the signing secret |

   - cross-check: wherever `metadata.velexis_tenant_id` or `metadata.velexis_environment` is present it must equal the resolved tenant and environment, and `event.livemode` must match the path's environment (or the connection's for `c/`). The payment (`metadata.payment_id`, then `provider_payment_id`) is looked up only inside the resolved tenant, and its `provider_payment_id`, when set, must equal the event's object. Any mismatch is logged as a security event (no payload) and acknowledged with `200` without writing a `payment_events` row or raising a staff alert, so one OTA's signed events can never write into another tenant's schema;
   - in one tenant transaction insert a `payment_events` row (`source = webhook`, `type = webhook.<event type>`, `provider_event_id`, redacted payload); a unique violation means a duplicate;
   - answer `200`, then enqueue `stripe.event {tenantId, paymentEventId}` with job id = Stripe event id;
   - an unknown tenant or payment is logged and acknowledged with `200`.
5. **Processing re-fetches.** The `ota-stripe-events` processor never trusts the event body: it retrieves the PaymentIntent, charge or refund from Stripe and applies the state with the payment's `version` lock. Handled types: `payment_intent.amount_capturable_updated` (authorized), `payment_intent.succeeded` (captured), `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded` and `charge.refund.updated` (refund rows), `charge.dispute.created` (staff alert only in the MVP). Other types are stored and ignored.
6. **Voids and retries** run in `ota-payments`: `payment.void` (checkout expiry, Amadeus rejection after authorisation, reconciliation not found), `payment.capture_retry`, `refund.submit`. Each job re-reads the row and does nothing if the state already moved.

   **2026-10-23 (lead decision (4), FIX-W27-FOLLOWUPS): the refund sweep.** A refund's producer queues `refund.submit` after the commit and never fails its request when Redis does not answer, so a lost enqueue (Redis down at the commit, or the after-commit task failed) left the row `pending` for good. The `refunds.sweep` schedule (every 5 minutes, per `active` and `suspended` tenant, [OADR-0014](0014-per-tenant-workers-and-schedulers.md) points 1 and 4) queues `refund.submit` again for the refunds still `pending` and never claimed 5 minutes or more after their request (100 per job, the oldest first; a full batch continues with the next, OADR-0014 point 2, so refunds whose jobs are still waiting never hide a lost one behind them). Never claimed means still at the version of a new row: a claim and the release of a claim bump it, so such a refund was never sent to Stripe. The sweep adds the producers' own job, with its id `refund-submit-<rfd_id>`, which BullMQ ignores while it holds that job, and the job claims the row before it calls Stripe with the refund's key `refund:<rfd_id>` (point 3), so a refund is never submitted twice. A refund being sent, one already sent and one whose claim was released after an answer that never came (its own job retries it, then the staff are alerted to check before refunding again) are left alone.

   **2026-10-23 (lead decisions (1) and (2), second batch, FIX-W28-CANCEL): the money of a cancellation.** Until then a cancellation voided an authorisation that was never captured, so the cancellation fee and the fees the OTA keeps were never charged, and a cancellation refunded the card fee with the rest. Now:
   - **A payment that is only authorised** (`authorized`, Stripe): the cancellation's money step captures the amount the OTA keeps (the quote's `otaFee` and `penalty`: the cancellation fee, the fees that are not refunded, the card fee unless refundable, any airline penalty the quote counts; `bookings.cancel`'s estimate is the authorisation less that amount) with `amount_to_capture`, which releases the rest of the authorisation; only a kept amount of zero voids it (`pi:cancel:<pay_id>`, as before). The capture runs after the commit of the record step, outside any transaction, with `pi:capture:<pay_id>:cancellation:<amount>` (the amount the `booking.cancelled` event records as `captureAmount`, beside `capturePaymentId` and `releaseAmount`). What Stripe reports is applied in one transaction in the lock order of OADR-0003 point 11 (the booking `FOR UPDATE`, then the payment, then the release's refund row), with the events the capture paths write (the payment's `payment.captured`, the booking's `amount_paid` and customer-visible `payment.captured`) and the **release**: a `refunds` row `succeeded` at once for the authorisation less the captured amount, with the kept amount as `penalty_amount`, no Stripe refund id and the note `RefundsRepository.RELEASE_NOTE`, a `payment.released` payment event and the customer-visible `refund.succeeded`, once per payment (Stripe's word, the capture's answer or a later read, says it happened). `refund.submit` and `refunds.sweep` never take such a row (it is final), and the webhooks never match it.
   - **Failures** follow the capture paths' rules: a capture that fails or whose answer is lost never undoes the cancellation. It is recorded (`payment.capture_failed` on the payment and, staff-only, on the booking), the staff are alerted, and `payment.capture_retry` is queued 10 minutes later with the job id `capture-retry-cancellation-<pay_id>` (never the id of a retry of the order's capture). The job reads the amount from the `booking.cancelled` event, captures with the same key (a capture whose answer was lost is found again; one captured meanwhile is recorded), and when it cannot (a refusal, a 5xx Stripe keeps for the key, the last attempt) reads the PaymentIntent again, applies what Stripe holds, and alerts the staff, with a `payment.capture_failed` event marked `final`.
   - **What the customer sees** (`Cancellation.refundStatus`, the contract's values, unchanged): `pending` while the capture is queued, `succeeded` with `refund` = the release once it is done, `manual_review` once the retry gave up, `authorization_voided` only when nothing was captured (a void, or an authorisation that lapsed), `not_applicable` when nothing is released.
   - **Card fees** (decision (2)): each line of a payment's card fee is stored with the payment when the fee is quoted (`payments.card_fee_lines`, tenant migration `0004`): the Amadeus credit-card fee, never refundable, and each OTA `payment_card` fee with its rule's `refundable` flag at that moment ([OADR-0005](0005-markup-and-fee-engine.md) point 7). The quote, the estimate, the refund and the capture above keep the card fee unless its line is refundable; a payment without lines (written before `0004`) keeps all of it. An airline-card payment is unchanged: the airline holds the money and reverses its charge.

7. **3-D Secure:** `payment_method_options.card.request_three_d_secure = automatic`, or `any` when `storefront_settings.require_3ds`. The 3-D Secure outcome is copied to `payments.three_ds` for display; it is not forwarded to Amadeus (the OTA-merchant model uses `other` forms of payment).
8. **What never happens:** card data reaching the backend on this path (Stripe.js collects it), refunds from the storefront (only cancellations trigger them), or a PaymentIntent without the tenant metadata.

## Consequences

### Positive

- The same code serves all three modes; switching an OTA to its own Stripe is a platform data change plus an invalidation.
- Webhooks are cheap and safe to retry; state comes from Stripe, not from event order.
- Every Stripe write is idempotent, so the SDK's single network retry and our job retries cannot double-charge or double-refund.
- A refund whose enqueue was lost goes out within about 10 minutes (the refund sweep of point 6), without a second submission of a refund that was ever claimed.
- A cancellation charges what the OTA keeps whether the payment was captured or only authorised, and the customer's money back is the release of the rest at once, without a refund to wait for (2026-10-23, FIX-W28-CANCEL).

### Negative

- Two Stripe calls per webhook (event + re-fetch) cost API quota; acceptable at MVP volume.
- Disputes are only alerted, not managed, in the MVP.
- A cancellation of an authorised payment makes one more Stripe call than a void, and a capture that fails twice leaves the authorisation held until the staff settle it or Stripe releases it (about 7 days): the customer sees `manual_review` meanwhile. The release is recorded as a `refunds` row although Stripe made no refund: the console shows it with the note, without a Stripe id. Stripe's representation of a partial capture (that it reports no refund for the released part) is to be confirmed with a test account (follow-up).
- Settlement of Velexis-collected funds is the platform's job from Stripe balance transactions; the OTA admin shows payments, not payouts.

### Follow-ups

- M5: Connect and API-key endpoints, tests with fixtures for each mode, including forged metadata naming another tenant and a `livemode` mismatch on the Connect and `c/` endpoints (OBE-078); the `livemode` check of the `velexis` endpoint is tested in M3 (OBE-039).
- Dispute handling screens after launch.
- With a Stripe test account (human step): confirm that a partial capture of the pinned API version releases the rest without a `charge.refunded` for it, so the webhook keeps the payment `captured` for the kept amount (2026-10-23, FIX-W28-CANCEL).

## Alternatives considered

- **Trust webhook bodies.** Simpler, but event order is not guaranteed and bodies can be stale.
- **An inbox table separate from `payment_events`.** The baseline table already has the unique provider event id that ADR-0011 names.
- **Create the PaymentIntent before the row.** A fast webhook could arrive for a payment the backend does not know yet.
- **One resolution order for every endpoint** (metadata, then `event.account`, then the path). The first version of point 4. Rejected in the planning review: on the Connect and `c/` endpoints the OTA writes the metadata, so it could route its signed events into another tenant.

## References

- [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md), [PADR-0011](../../../platform/docs/adr/0011-stripe-connect-standard-and-api-key-connections.md)
- [`../api-changes.md`](../api-changes.md) §4, [`../api-changes-console-and-internal.md`](../api-changes-console-and-internal.md) §3, §5
- [`../flows/checkout-stripe.md`](../flows/checkout-stripe.md), [`../flows/change-and-cancel.md`](../flows/change-and-cancel.md)
- FIX-W28-CANCEL: `authorisationSettlementOf` and `CancellationRecorder.captureKept` in [`cancellation.service.ts`](../../backend/src/bookings/cancellation.service.ts), the capture retry of a cancellation (`cancellationCaptureOf`, `cancellationCaptureRetryJob`) in [`payments.processor.ts`](../../backend/src/payments/payments.processor.ts), `RefundsRepository.recordRelease` in [`refunds.repository.ts`](../../backend/src/payments/refunds.repository.ts), `cardFeeLinesFor` in [`pricing-mode.ts`](../../backend/src/checkout/pricing-mode.ts) and `keptCardFeeOf` in [`card-fees.ts`](../../backend/src/payments/card-fees.ts); tests in [`cancel.int.test.ts`](../../backend/test/integration/bookings/cancel.int.test.ts) and [`create-payment.int.test.ts`](../../backend/test/integration/payments/create-payment.int.test.ts)
