# Runbook: Stripe down, webhook backlog and payment jobs

For the traveller payments of the OTA backend (method (a), card payments through Stripe): Stripe's API down or slow, webhook deliveries that fail or wait, captures, voids and refunds that fail, authorisations about to lapse, and disputes. The behaviour behind it is [OADR-0010](../adr/0010-stripe-gateway-and-payment-webhooks.md) and [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md); the platform's own Stripe (subscriptions, Connect onboarding, billing webhooks) is the platform's runbook ([`platform-operations.md`](../../../platform/docs/runbooks/platform-operations.md)). The levels of the escalation are those of the [runbooks README](README.md#3-escalation).

**Whose Stripe account.** A payment lives on the account of its OTA's payment connection: Velexis's own account (`velexis` mode), where Velexis ops act in its Dashboard; or the OTA's own account, connected to Velexis's platform (`connect_standard`) or used with its own keys (`api_keys`), where the OTA acts in its own Dashboard and talks to Stripe itself. The payment's page in the OTA admin names its account mode.

## 1. What the system does by itself

- Every PaymentIntent uses manual capture: the money is authorised before the order and captured after it.
- **Stripe unreachable when a payment starts**: `502 PAYMENT_PROVIDER_ERROR`, nothing charged; the traveller tries again.
- **A capture that fails after the order**: the booking stays `confirmed` with ticketing `manual_review`, the staff are alerted, and `payment.capture_retry` captures it 10 minutes later with the same Stripe idempotency key. A capture's safety net (the same job, queued before the record step's commit) covers a process that stopped in between.
- **Voids and refunds** run as jobs on `ota-payments` (`payment.void`, `refund.submit`), each reading its row first and doing nothing if the state already moved; a job is tried 5 times with a backoff from 30 seconds (about 8 minutes in all). `refunds.sweep` (every 5 minutes) queues a refund whose job was lost.
- **Webhooks** are verified on the raw body, stored once per Stripe event id in `payment_events`, answered `200`, and processed by the worker (`ota-stripe-events`), which never trusts the event's body: it reads the PaymentIntent, charge or refund again from Stripe. The receiver answers `503` when it cannot look the tenant up or queue the event (Redis down) and `500` on a database failure; Stripe then sends the event again, for up to 3 days. A repeated delivery of a stored event queues its job again, without a second row.
- **Authorisation watch** (06:15 UTC daily): a staff alert for each authorised, uncaptured payment older than 5 days; Stripe releases an authorisation after about 7.

## 2. Signals

| Signal | Where | Means |
|---|---|---|
| `502 PAYMENT_PROVIDER_ERROR` on checkout.createPayment; `424 PAYMENT_PROVIDER_NOT_CONFIGURED` | Storefront and SDK answers | Stripe unreachable or erroring; the environment's Stripe keys or connection missing |
| `payments.stripe_call_failed`, `payments.capture_retry_failed`, `payments.capture_retry_impossible`, `payments.void_failed`, `payments.refund_submit_failed`, `payments.job_failed`, `payments.stripe_account_unavailable` | Journal of `velexis-ota-api` and `velexis-ota-worker` | Calls to Stripe that failed, with the payment or refund id and the job |
| `payments.webhook_signature_invalid` (`endpoint`, `reason`), `payments.webhook_secret_missing` (level 50) | Journal of `velexis-ota-api` | Deliveries refused with `400`: a signing secret that does not match the endpoint's, an empty one, or forged requests |
| `payments.webhook_enqueue_failed`, `payments.webhook_enqueue_timeout` | Same | Deliveries answered `503` because Redis did not take the job ([README §4](README.md#4-redis-lost-or-restarted-without-its-data)) |
| `payments.webhook_mismatch`, `payments.stripe_event_mismatch` (with `securityEvent`) | Same, and the worker | A signed event that names another tenant, environment or account: acknowledged without effect; read with the [incident response plan](../pci/incident-response.md) if it repeats |
| `payments.webhook_stored`, `payments.webhook_duplicate`; `payments.stripe_event_processed`, `payments.stripe_event_job_failed`, `payments.stripe_event_read_failed` | API (receiver) and worker (processing) | The inbox at work: stored, repeated, processed, failed |
| Caddy's answers on the webhook paths | `journalctl -u caddy --since -1h -o cat \| jq -rR 'fromjson? \| select((.request.uri // "") \| startswith("/webhooks/stripe/")) \| [(.request.uri \| split("?")[0]), .status] \| @tsv' \| sort \| uniq -c` | `200` normal; `400` signatures; `503`/`502` the API or Redis |
| The worker's `queues["ota-stripe-events"]` and `queues["ota-payments"]`: `waiting`, `oldestWaitingSeconds`, `failedLastHour` | `curl -s http://127.0.0.1:4001/health/ready \| jq '.queues \| {"ota-stripe-events", "ota-payments"}'`; the e-mails `queue-age-velexis-ota-worker`, `failed-jobs-velexis-ota-worker`; the platform admin's `/queues/ota-stripe-events`, `/queues/ota-payments` | Events or payment jobs waiting or failing |
| Failed deliveries of the endpoint; Stripe's status information | The Stripe Dashboard of the account (Developers, Webhooks, the endpoint's attempts) | Stripe could not deliver, and why (our answer's status) |
| Dashboard tile "Authorised, not captured"; `/payments?status=authorized`; a payment's events, refunds and "Refresh from Stripe" | OTA admin | Authorisations still held; one payment's history as Velexis recorded it |
| "[Action needed] Booking … needs a review" or "A payment needs a review" (`staff.manual_review`): a capture that failed, an authorisation older than 5 days, a dispute, a refund Stripe refused | E-mail to the OTA's alert address | A payment that needs the staff |

## 3. First checks

1. **Stripe or Velexis?** `/health/ready` of the API and the worker (`200`: the processes and their PostgreSQL and Redis are fine). Then Stripe's status information, and in the journal the codes of the failed Stripe calls:

   ```bash
   journalctl -u velexis-ota-api -u velexis-ota-worker --since -1h -o cat \
     | jq -rR 'fromjson? | select((.msg // "") | startswith("payments.")) | select(.level >= 40) | [.msg, .tenantId, .code] | @tsv' | sort | uniq -c | sort -rn
   ```

2. **Are deliveries arriving?** The Caddy line of §2 (the statuses of the webhook paths in the last hour) and, in the Dashboard of the account, the endpoint's failed attempts.
3. **Is the worker keeping up?** `ota-stripe-events` and `ota-payments` in the worker's readiness: a small `oldestWaitingSeconds`, `failedLastHour` near 0.

## 4. What to do

### 4.1 Stripe's API down or slow

1. Nothing to restart: payments that cannot start fail fast (`502`), and voids, refunds and capture retries are retried by their jobs.
2. If it lasts more than 15 minutes, tell the product owner (checkouts cannot be paid by card; bookings already paid are safe). The airline card, where it is enabled, does not use Stripe.
3. **After it**, in the OTA admin of each OTA and environment (Velexis ops can do the `velexis`-mode ones):
   - `/payments?status=authorized` and the dashboard's "Authorised, not captured": an authorisation whose booking is `confirmed` or ticketed is captured from its payment's page (Capture), or by issuing the booking (Issue captures first). One whose booking `failed` or that has no booking is released: its void job may have failed for good (`payments.void_failed` after the 5 attempts): the account holder cancels the PaymentIntent in the Stripe Dashboard, then "Refresh from Stripe" on the payment's page records it (`cancelled`).
   - Refunds still `pending` after the outage: `refunds.sweep` queues them again within 5 minutes; a refund Stripe refused is shown on the payment with its failure and alerted.
   - Bookings with ticketing `manual_review` because their capture failed: the capture retry took them 10 minutes later; any left are captured and issued by hand ([`ticketing-failures.md`](ticketing-failures.md) §4.1).

### 4.2 A webhook backlog

Find which of the three it is:

- **Stripe cannot deliver** (failed attempts in the Dashboard; Caddy shows `503`, `502` or nothing): fix the cause on our side (the API down: [deployment §16](../../../docs/mvp/deployment-single-vm.md#16-incident-quick-reference); Redis: [README §4](README.md#4-redis-lost-or-restarted-without-its-data)). Stripe keeps retrying for up to 3 days, so nothing is lost; to shorten the wait, resend the failed events from the endpoint's page in the Dashboard.
- **Deliveries refused with `400`** (`payments.webhook_signature_invalid`, `payments.webhook_secret_missing`): the signing secret in `/etc/velexis/ota-backend.env` is missing or not the endpoint's. Check that it is set without printing it (`sudo grep -c '^STRIPE_WEBHOOK_SECRET_VELEXIS_LIVE=whsec_' /etc/velexis/ota-backend.env` must print `1`; `payments.webhook_secret_missing` means it is empty), take the endpoint's signing secret from the Dashboard (roll it if it may have leaked), write it to the env file, `sudo systemctl restart velexis-ota-api velexis-ota-worker`, then resend the failed events. The endpoints and their variables:

  | Endpoint (on `api.ota.example.com`) | Account | Variable |
  |---|---|---|
  | `/webhooks/stripe/velexis/test`, `/webhooks/stripe/velexis/live` | Velexis's own (`velexis` mode) | `STRIPE_WEBHOOK_SECRET_VELEXIS_TEST`, `_LIVE` |
  | `/webhooks/stripe/connect/test`, `/webhooks/stripe/connect/live` | Velexis's platform account, events of the OTAs' connected accounts (`connect_standard`) | `STRIPE_WEBHOOK_SECRET_CONNECT_TEST`, `_LIVE` |
  | `/webhooks/stripe/c/<ppc_…>` | One OTA's own account (`api_keys`) | The connection's own secret, stored encrypted: the OTA enters it again in the portal |

  Many `400`s that no secret change explains, or with `securityEvent` mismatches, may be forged requests: the [incident response plan](../pci/incident-response.md).
- **Stored but not processed** (the Dashboard shows `200`s; `ota-stripe-events` grows or fails, `payments.stripe_event_read_failed`): the worker is down (`sudo systemctl restart velexis-ota-worker`) or cannot read the objects from Stripe (§4.1). Failed jobs are retried 5 times; after that, resend the event from the Dashboard (its delivery queues the job again) or use "Refresh from Stripe" on each payment concerned.
- **A delivery acknowledged whose job was lost** (Redis lost after the `200`): the same two remedies.

### 4.3 Authorisations about to lapse

The authorisation watch's alert names the payment and its booking. Capture it if the booking stands (`/payments/<pay_…>`, Capture, or Issue on the booking), or cancel the booking (its authorisation is voided). After about 7 days Stripe releases it on its own, and a later capture answers `402 PAYMENT_DECLINED`: the traveller must pay again outside the booking.

### 4.4 Disputes

`charge.dispute.created` raises a staff alert only; the MVP has no dispute screens ([OADR-0010](../adr/0010-stripe-gateway-and-payment-webhooks.md) follow-ups). The account holder answers it in the Stripe Dashboard before Stripe's deadline: Velexis ops with the OTA's evidence (the booking, its tickets and documents) for `velexis` mode, the OTA itself for its own account.

### 4.5 A Stripe key or the card page may be compromised

Treat it as an incident ([incident response plan](../pci/incident-response.md)): roll the key in the Dashboard, write the new one to `/etc/velexis/ota-backend.env` (each pair is used only when both keys are set; a key of the other mode stops the processes at start-up, so check `/health/ready` and the journal right after), `sudo systemctl restart velexis-ota-api velexis-ota-worker`, and tell Stripe through the Dashboard.

## 5. Escalation

| When | Who acts | Escalates to |
|---|---|---|
| Stripe's API down or slow | Velexis ops confirm and watch | Stripe support (the Dashboard of Velexis's account); the product owner after 15 minutes |
| Deliveries failing on our side (`5xx`, `400`) | Velexis ops (§4.2) | The incident lead when `400`s or mismatches look forged |
| An authorisation to release or capture on Velexis's account | The OTA's staff ask; Velexis ops act in the Dashboard | — |
| The same on the OTA's own account | The OTA's staff, in their own Dashboard | Stripe support of their account |
| A dispute | The account holder | The product owner for disputes on Velexis's account |
| Payment jobs failing as a whole (`ota-payments`, `ota-stripe-events`) | Velexis ops | A bug report with the job reasons and payment ids |

## 6. After the incident

Check that `/payments?status=authorized` of every live OTA holds only authorisations of bookings that wait for a decision, that the endpoints' failed attempts in the Dashboard are resent or answered, and record the window and the payments handled (ids only).
