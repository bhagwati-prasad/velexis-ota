# Platform operations runbooks

What to do when the platform needs a person after the launch: a stuck provisioning job, a failed Stripe event, a Stripe deauthorisation, an abusive custom domain, a lost authenticator of an owner or admin, the rotation of the JWT signing key and of the master key, and why the API key pepper is never rotated. Each section names the signals that show the problem, the commands that diagnose it, the fix, the check that it is fixed, the escalation, and where the behaviour is implemented and tested. Task PBE-065 of [`../plans/agent-tasks.md`](../plans/agent-tasks.md) wrote it.

Related: [`launch-checklist.md`](launch-checklist.md); [`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md) §7 (secrets), §13 (monitoring and the on-VM health check) and §16 (incident quick reference); the cross-cutting runbooks [`master-key-rotation.md`](../../../docs/mvp/runbooks/master-key-rotation.md) and [`ssh-access.md`](../../../docs/mvp/runbooks/ssh-access.md); the OTA's runbooks in `ota/docs/runbooks/` (task OBE-089); the [incident response plan](../../../ota/docs/pci/incident-response.md) for anything that may be a security incident; [`../flows/platform-admin-operations.md`](../flows/platform-admin-operations.md) and the "Failure handling" of each flow.

It is a human procedure in the platform admin and on the VM. AI agents never run it ([`AGENTS.md`](../../../AGENTS.md) §8: no production access). The Velexis hosts are the placeholders of [`decisions.md`](../../../docs/mvp/decisions.md) §4 (on the VM, the real hosts); a custom storefront domain is written `<custom-domain>`.

## 1. Common ground

### Who responds

| Role | Who | When |
|---|---|---|
| First responder | The developer: reads the operations mailbox, has the platform admin and SSH access to the VM | Every signal below |
| Decisions about an OTA's access or money, and every message to an OTA | The product owner | A suspension or resume, a refused support request, a disputed charge, anything an OTA is told |
| Providers | Stripe support from Velexis's Dashboard; Amadeus through the support channel of the contract; the DNS, SMTP and cloud providers | A cause on their side |
| Security incident | The [incident response plan](../../../ota/docs/pci/incident-response.md): the developer leads, the product owner communicates | Any sign of a compromise: a leaked key, an unknown admin, a forged token, an account used by someone else |

### Signals

| Signal | Where it comes from | What it covers |
|---|---|---|
| `ops.alert` e-mails to `OPS_ALERT_EMAIL` | The platform worker's e-mail outbox (`platform/backend/src/notifications/templates.ts`) | A provisioning job failed for good, or still running after two leases; no Amadeus test office for a new OTA; a tenant migration of a deploy that failed; the Amadeus office pool is low; a live office request (or one without a Velexis live account); a payout account to review |
| `[velexis][…] health check failed: <check>` e-mails, and `recovered` when it passes again | `velexis-healthcheck` every 5 minutes ([deployment §13](../../../docs/mvp/deployment-single-vm.md#13-monitoring-and-uptime)) | `ready-velexis-platform-api`, `ready-velexis-platform-worker` (readiness); `failed-jobs-velexis-platform-worker` (more than 20 failed jobs in the last hour); `queue-age-velexis-platform-worker` (a job waiting more than 10 minutes); the same three for `velexis-ota-worker` |
| A unit's failure e-mail | `velexis-alert@<unit>`, when systemd stops restarting it | A process that cannot start (`config.invalid`, `api.start_failed`, `worker.start_failed`) |
| The platform admin's dashboard | `https://admin.platform.example.com/` | OTAs by status, provisioning failures of the last 24 hours, failed jobs per queue, the office pool, live office requests, pending domains, settlements to review, failed Stripe events, past-due subscriptions |
| Messages from owners and from Stripe | The support mailbox; Stripe's e-mails about a webhook endpoint that keeps failing | What no alert sees |

### Commands used throughout

```bash
# Readiness of both platform processes, and the worker's queues (waiting, oldest waiting age, failures of the last hour)
curl -s http://127.0.0.1:3100/health/ready; echo
curl -s http://127.0.0.1:3101/health/ready | jq '.status, .checks, .queues'
sudo velexis-healthcheck --status

# Log lines are JSON; `msg` is the event name, `level` 40 is warn, 50 error
sudo journalctl -u velexis-platform-worker --since -2h -o cat | jq -cR 'fromjson? | select((.msg // "") | startswith("provisioning."))'
sudo journalctl -u velexis-platform-api --since -2h -o cat | jq -cR 'fromjson? | select(.level >= 40)'

# Read-only SQL, only when the admin's pages are not enough
sudo -u postgres env PGOPTIONS='-c default_transaction_read_only=on' psql -d velexis -c "<query>"
```

Changes always go through the platform admin or the CLI, which audit them; never write to the database by hand. Log lines, the admin and the queries here show no secret ([ADR-0016](../../../docs/mvp/adr/0016-observability.md) redaction list); never paste a token, key or password into a ticket.

## 2. Stuck provisioning job

An OTA stays in `provisioning` (its set-up page does not finish) for more than about 10 minutes, or a `migrate`, `suspend` or `resume` job does not finish.

**Signals.** The owner writes that set-up does not finish; the dashboard's provisioning failures and its count of OTAs in `provisioning`; the `ops.alert` "Provisioning job still running after two leases: `<kind>` of `<key>`" (the reconciler sends it once per attempt that stays `running` past two 15-minute leases while BullMQ still holds its message or answer); the `ops.alert` "Provisioning job failed: `<kind>` of `<key>`" (the job failed for good, and the owner of a failed `provision` job got "setup failed, we are on it"); health check e-mails `queue-age-velexis-ota-worker` (the `ota-tenant-ops` queue), `queue-age-velexis-platform-worker` (`platform-tenant-events`) or `ready-velexis-ota-worker`; log lines `provisioning.dispatch_failed`, `provisioning.reconcile_failed` and `provisioning.not_dispatched`.

**Diagnose.** Open the job: `/tenants/<tenantId>` (tab provisioning jobs), or `/provisioning-jobs` filtered by status `queued` or `running`, then `/provisioning-jobs/<jobId>`: status, step, attempt (of 5), `scheduledAt`, `lockedUntil`, the step log, the last error and the BullMQ state of the current attempt. Without the admin:

```bash
sudo -u postgres env PGOPTIONS='-c default_transaction_read_only=on' psql -d velexis -c "
  SELECT j.id, t.key, j.kind, j.status, j.step, j.attempt, j.scheduled_at, j.locked_until, left(j.error, 120) AS error
    FROM platform.provisioning_jobs j JOIN platform.tenants t ON t.id = j.tenant_id
   WHERE j.status IN ('queued', 'running')
   ORDER BY j.created_at"
```

Then follow the row that matches:

| What the job shows | Cause | Fix |
|---|---|---|
| `queued`, a `provision` job of an OTA whose subscription is `incomplete` | The gate waits for the owner's Checkout (billing switched on) | Nothing: the owner pays, or after 48 hours `billing.abandoned_checkouts` fails the OTA and the owner can retry from the portal. If Stripe's Dashboard shows the Checkout paid, the billing event did not arrive or failed: [§3](#3-failed-stripe-event). |
| `queued`, gate open, `scheduledAt` more than 5 minutes ago | Nobody dispatched it: the platform worker (it runs `provisioning.reconcile` every 5 minutes) or Redis is down | `systemctl status velexis-platform-worker redis-server`; restart what failed; the next reconcile dispatches the job. `provisioning.reconcile_failed` lines name the job and the error. |
| `running`, BullMQ state `waiting`, `active` or `delayed` | The OTA worker is slow or down; the reconciler extends the lease meanwhile | `systemctl status velexis-ota-worker`, `curl -s http://127.0.0.1:4001/health/ready`, the `ota-tenant-ops` row of `/queues`, `sudo journalctl -u velexis-ota-worker --since -1h --grep <jobId>`. Restart the OTA worker if it is down; the job goes on. A tenant migration that fails is the OTA's runbook (`ota/docs/runbooks/tenant-migration-failures.md`). |
| `running`, BullMQ state missing or `failed`, `lockedUntil` past | The message was lost | Nothing: the reconciler counts it as a retryable failure and dispatches the next attempt (backoff 30 s × 2^attempt). |
| `running` at a post-step (`record_migrations`, `assign_amadeus_office`, `create_payment_connection`, `issue_api_keys`, `activate`, `notify`) | The platform's post-steps fail (database, e-mail queue) | `/queues/platform-tenant-events` shows the failed event job and its reason; fix the cause and retry it there. The steps are idempotent: those already done are skipped. |
| `failed` | Attempts used up, or an error that cannot pass by itself | Fix the cause, then **Retry** on `/provisioning-jobs/<jobId>`: a new job of the same kind (for `provision` the OTA returns to `provisioning`; after a post-step error only the post-steps run again), or let the owner retry from the portal. A checksum mismatch or foreign objects in an existing tenant schema are the OTA side's and need the developer before any retry: the platform never touches a tenant schema. A failed `migrate`, `suspend` or `resume` job never changes the OTA's status (a suspended OTA stays suspended). |
| `queued`, not wanted any more | — | **Cancel job** with a reason on `/provisioning-jobs/<jobId>` (a `queued` job only: never dispatched, or waiting for its next attempt; the OTA's status does not change). |

No free Amadeus test office is not a stuck job: the OTA activates with a `pending_verification` connection, ops get an e-mail, and an admin assigns an office later on `/amadeus/offices`.

**Done when** the job is `succeeded` (or deliberately `canceled`), a `provision` job's OTA is `active`, the dashboard's counters are back, and the health check has sent its `recovered` e-mail if it alerted.

**Escalation.** Many OTAs stuck at once after a deploy point at the release: roll it back with `sudo velexis-deploy --rollback` ([deployment §8](../../../docs/mvp/deployment-single-vm.md#8-release-artefact-deploy-and-rollback)). The product owner writes to an owner whose OTA waits more than a working day.

**Evidence.** `platform/backend/src/provisioning/dispatcher.ts`, `reconciler.scheduler.ts`, `failure-handler.ts`, `tenant-events.processor.ts`; `platform/backend/test/integration/provisioning/dispatch.int.test.ts`, `failures.int.test.ts`, `post-steps.int.test.ts`, `platform/backend/test/integration/admin/admin-jobs.int.test.ts`; [`provisioning.md`](../flows/provisioning.md) "Failure handling", [PADR-0001](../adr/0001-tenant-provisioning-orchestration.md).

## 3. Failed Stripe event

How events flow: the endpoint checks the signature and the mode, stores the event (unique by its id) and queues it; the worker re-fetches the object from Stripe, applies it in one transaction and marks the event `processed` or `ignored`. An event that fails is tried up to 5 times in all, with backoff, then it is `failed` for good. `stripe_events.sweep` queues again events left `received` or retryable `failed` for more than 2 minutes. Stripe repeats a delivery that did not get `200` for 3 days.

**Signals.** The dashboard's failed Stripe events; `/stripe-events` with status `failed`; the health check's `failed-jobs-velexis-platform-worker` naming `platform-stripe-events`; log lines `stripe.event_failed` (`warn` while it is retried, `error` when final, with `eventId`, `eventType` and `code`); at the endpoint, `stripe.webhook_signature_invalid` (a security event with the caller's IP) and Stripe's e-mail that an endpoint keeps failing; an owner whose Checkout was paid but whose OTA still waits, or whose OTA was suspended although it pays.

**Diagnose.** `/stripe-events` (failed and ignored first) shows each event's type, OTA, attempts and last error (`CODE: message`). Without the admin:

```bash
sudo -u postgres env PGOPTIONS='-c default_transaction_read_only=on' psql -d velexis -c "
  SELECT id, endpoint, type, status, attempts, left(last_error, 120) AS last_error, tenant_id, received_at
    FROM platform.stripe_events
   WHERE status IN ('failed', 'received', 'processing')
   ORDER BY received_at DESC LIMIT 50"
```

| Last error or symptom | Cause | Fix |
|---|---|---|
| Failed deliveries in Stripe's Dashboard, answered `400`, with `stripe.webhook_signature_invalid` lines | The endpoint's signing secret and `STRIPE_BILLING_WEBHOOK_SECRET` (or `STRIPE_CONNECT_WEBHOOK_SECRET`) differ, for example after the secret was rolled in the Dashboard | Put the endpoint's current secret into `/etc/velexis/platform-backend.env` (`sudoedit`), restart `velexis-platform-api`, then resend the failed deliveries from the Dashboard (Stripe keeps retrying for 3 days anyway). Roll a secret with an expiry for the old one, so both work until the env file has the new one. Signature failures from addresses that are not Stripe's are attacks to note, not a fault to fix. |
| Deliveries answered `400` with `livemode_mismatch` | A test-mode endpoint points at production, or the reverse | Fix or remove that endpoint in the Dashboard: production takes live events only. |
| Deliveries answered `500` | PostgreSQL is down | [Deployment §16](../../../docs/mvp/deployment-single-vm.md#16-incident-quick-reference), "APIs answer 503"; Stripe retries. |
| `UNKNOWN_PRICE` | A price that no plan links (or two plans link) | Link the price on `/plans/<code>`, then **Reprocess**. |
| `UNSUPPORTED_SUBSCRIPTION` | A subscription with more than one item | Correct it in Stripe with the product owner, then Reprocess. |
| `SUBSCRIPTION_CONFLICT`, `CUSTOMER_CONFLICT`, `TENANT_MISMATCH` | Two current Stripe subscriptions of one OTA, or a Customer or row of another OTA | Nothing was written. Resolve it in Stripe with the product owner (cancel the duplicate, correct `velexis_tenant_id` in the metadata), then Reprocess. |
| `UNKNOWN_SUBSCRIPTION` on an invoice event | The invoice came before its Checkout's event | Retried until the Checkout's row exists; once `failed`, Reprocess it after `checkout.session.completed` is `processed`. |
| `SUBSCRIPTION_BUSY`, `SUBSCRIPTION_LOCK_LOST` | Another event of the subscription held its lock, or Redis was unreachable | Retried by BullMQ; fix Redis if it is the cause; Reprocess a final failure. |
| `STRIPE_API_ERROR`, `STRIPE_CONNECTION_ERROR`, `STRIPE_RATE_LIMIT_ERROR` | Stripe did not answer | Retried; once Stripe's status page shows it resolved, Reprocess what failed for good. |
| `STRIPE_NOT_CONFIGURED` | `STRIPE_SECRET_KEY` is missing | Set it ([launch checklist §4](launch-checklist.md#4-stripe-live-mode-velexiss-account)), restart both platform units, Reprocess. |
| Status `ignored` | No OTA found, a type the platform does not handle, or its switch was off | Reprocess only those that matter, once their switch is on. |

**Reprocess** (`/stripe-events`, an event that is `failed` or `ignored`) puts it back to `received`, audits `stripe_event.reprocessed` and queues it; the handler re-fetches the current object from Stripe, so an old event is safe to reprocess. For one subscription, **Resync from Stripe** on `/subscriptions/<subscriptionId>` re-fetches it without an event.

**Done when** the event is `processed`, the OTA's subscription, plan, banner and status on `/tenants/<tenantId>` match Stripe's Dashboard, and an OTA suspended for billing although it pays has been resumed by the sync (it resumes when its subscription is `trialing` or `active` again).

**Escalation.** A fault on Stripe's side: Stripe support from the Dashboard. A charge, refund or suspension that an OTA disputes: the product owner.

**Evidence.** `platform/backend/src/billing/sync/stripe-events.processor.ts` (`describeFailure`), `stripe-events-sweep.scheduler.ts`, `platform/backend/src/common/stripe/stripe-signature.guard.ts`, `stripe-inbox.service.ts`; `platform/backend/test/integration/billing/billing-webhook.int.test.ts`, `billing-events.int.test.ts`, `platform/backend/test/integration/admin/admin-billing.int.test.ts`; [`subscription-billing.md`](../flows/subscription-billing.md) §C, §D and "Failure handling".

## 4. Stripe deauthorisation

An OTA disconnects Velexis from its own Stripe account (or Stripe does), and Stripe sends `account.application.deauthorized` to the platform's Connect endpoint.

**What happens by itself.** The OTA's `connect_standard` connections of that account (test and live) become `disabled` with `disconnected_at`, audited `payments.connect_disconnected`; the owners get the `connection.stripe_disconnected` e-mail. There is no fallback to Velexis payments, because that would change who holds the travellers' money ([PADR-0011](../adr/0011-stripe-connect-standard-and-api-key-connections.md) item 4). From then on the OTA API answers the OTA's new payments with `424 PAYMENT_PROVIDER_NOT_CONFIGURED`. A connection a platform admin had disabled keeps its state and gets one audit row `payments.connect_deauthorized_while_disabled`.

**Signals.** The event on `/stripe-events`; the log line `stripe_connect.account_deauthorized`; the OTA's payment connection `disabled` with a disconnection time on `/tenants/<tenantId>` (tab connections); the owner's question.

**Do.**

1. Confirm on `/tenants/<tenantId>` that the connection is `disabled` with a disconnection time, and find the audit row.
2. The product owner (or the developer on their behalf) asks the owner to choose: **Connect Stripe again** on the portal's payments page (a deauthorised connection may reconnect), or **Use Velexis payments** (live needs a verified payout account, so the settlements switch).
3. Payments made on the disconnected account stay on it ([PADR-0011](../adr/0011-stripe-connect-standard-and-api-key-connections.md) item 7), but Velexis has no access to that account any more: an authorisation not yet captured cannot be captured by Velexis, and a refund of a captured payment is made by the OTA in its own Stripe Dashboard. Go through the OTA's open bookings with it and follow the OTA's Stripe runbook (`ota/docs/runbooks/stripe-incidents.md`).

**Done when** the OTA has an `active` payment connection again on `/tenants/<tenantId>`, its storefront's payment step offers card payment again (no `PAYMENT_PROVIDER_NOT_CONFIGURED`), and its open authorisations are settled with it.

**Escalation.** The product owner for the conversation with the OTA; Stripe support when the deauthorisation was not the OTA's doing.

**Evidence.** `platform/backend/src/payment-connections/connect-account-events.handler.ts`, `ota/backend/src/payments/stripe/stripe.gateway.ts` (`PAYMENT_PROVIDER_NOT_CONFIGURED`, a payment keeps its account); `platform/backend/test/integration/connections/connect-events.int.test.ts`; [`stripe-payments-account.md`](../flows/stripe-payments-account.md) §C item 5, §E and "Failure handling".

## 5. Abusive custom domain

**Signals.** An abuse report to the operations or support mailbox (phishing, a trademark complaint, a notice from a registrar or hosting provider, a browser's safe-browsing warning); an odd host on the admin's `/domains` (a lookalike of a bank, an airline or Velexis); `sudo journalctl -u caddy --grep <custom-domain>` showing its certificate.

**Diagnose.** `/domains`, the host, its OTA; `/tenants/<tenantId>`: owners, plan, status and the domain's audit rows (who added it, when). Decide with the product owner whether the **domain** is the problem (a host the OTA has no right to, or one used to mislead) or the **OTA** (its storefront itself is abusive).

**Fix.**

- **Remove the domain:** `/domains`, **Remove**, with a reason (custom domains only; the sub-domain cannot be removed). One transaction deletes it, makes the sub-domain primary again when needed and audits `domain.removed` with the reason; every owner is e-mailed without the reason; the invalidations follow and the cached `ask` answer is deleted. The host name is then free for any OTA that proves ownership with its TXT record.
- **When the OTA itself is abusive,** suspend it on `/tenants/<tenantId>` with reason `abuse` and a note ([PADR-0014](../adr/0014-tenant-suspension-and-resume.md)): within 60 seconds its storefront and API answer `TENANT_SUSPENDED`, `ask` refuses its custom domains, and the owners are e-mailed. Only the product owner decides a suspension for abuse, and its resume.
- **When the same OTA adds the host again,** suspend the OTA: there is no deny-list of hosts.
- The certificate Caddy obtained stays in Caddy's storage until it expires; no storefront is served with it once `ask` and the OTA API no longer know the host.

**Check.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3100/internal/tls/ask?domain=<custom-domain>'      # 404
curl -s -o /dev/null -w '%{http_code}\n' --resolve '<custom-domain>:443:127.0.0.1' \
  'https://<custom-domain>/api/v1/storefront'                                                                 # 403 (HOST_NOT_ALLOWED) within a minute; 000 when Caddy holds no certificate for it
```

**Escalation.** The product owner answers the reporter and the OTA; a registrar, a brand owner or the police are answered only through the product owner.

**Evidence.** `platform/backend/src/domains/admin-domains.service.ts`, `tls-ask.service.ts`, `ota/backend/src/tenancy/tenant-resolver.ts` (`HOST_NOT_ALLOWED`); `platform/backend/test/integration/admin/admin-domains.int.test.ts`, `platform/backend/test/integration/domains/tls-ask.int.test.ts`; `tools/e2e/specs/admin-domains.e2e.ts`; [`custom-domains.md`](../flows/custom-domains.md) steps 7 and 8.

## 6. Lost authenticator of an owner or admin

For the portal accounts of OTA owners and admins (and every other portal account), and for platform admins.

**Signals.** The person writes that the authenticator app is gone; `/accounts/<accountId>` shows MFA on and recent `auth.sign_in_failed` rows (`admin.sign_in_failed` for a platform admin) with the reason `invalid_mfa_code`.

**Never reset MFA only because someone asks.** A reset followed by a password reset gives the account to whoever controls its mailbox. The identity check comes first, and the reset's reason records how it was done.

**A. The person still has a recovery code.** The sign-in's code step accepts one (each works once), and that sign-in counts as a fresh step-up for 15 minutes.

- An owner or admin of a live OTA cannot turn MFA off (`409 CONFLICT`, `mfa_mandatory`; [PADR-0008](../adr/0008-email-verification-and-mfa-policy.md) revision of 2026-11-05), and a step-up needs a code of the authenticator: a recovery code gets them in, not to a new authenticator. Continue with B.
- Any other portal account (a platform admin: C): right after signing in with the recovery code, turn MFA off on `/account/security` and set it up again with the new device; new recovery codes come with it. Nothing for support to do.

**B. Support reset** (an owner or admin of a live OTA, or nobody with a recovery code).

1. **Identity check, outside the system.** The request comes from the account's own address and is confirmed in a reply to a message you send to that address; plus one independent check: another active owner of the same OTA confirms from their own account's address, or a call to the phone number of the OTA's contract with Velexis (kept by the product owner). When neither is possible, the product owner decides.
2. **Reset.** `/accounts/<accountId>`, **Reset two-factor**, with a step-up and a reason that says how the identity was checked (no other personal data). It turns MFA off, deletes the recovery codes, revokes every session, writes `staffdeny` (the OTA console's sessions end too), e-mails the account and audits `account.mfa_reset`.
3. **Enrol again.** At the next sign-in an owner or admin of a live OTA meets `/mfa-enrolment` and can use nothing else until MFA is on (PBE-071, PFE-030); anyone else enrols on `/account/security`.

**C. A platform admin.** Platform admins cannot turn MFA off, and the admin's reset refuses an admin.

- Another platform admin exists: they revoke the person's admin rights on `/admins` (step-up), reset the MFA as in B, and grant admin again on `/admins` once the person has enrolled in the portal (granting needs MFA).
- It is the only admin: on the VM, `sudo velexis-run platform node dist/cli.js admin:reset-mfa <email> --operator "<your name>"` (audited `account.mfa_reset`, actor `system`, with the operator), then enrol at `https://platform.example.com/account/security` and sign in to `https://admin.platform.example.com` again. SSH needs its own second factor; if that is lost too, [`ssh-access.md`](../../../docs/mvp/runbooks/ssh-access.md) §4 and §5.

**Done when** `/accounts/<accountId>` shows MFA on again (audit `account.mfa_enabled`) and the person confirms that they can sign in.

**Escalation.** A request that fails the identity check, or a suspicion that someone else holds the account: the product owner, and the incident response plan when an account may have been taken over.

**Evidence.** `platform/backend/src/accounts/mfa.service.ts`, `platform/backend/src/common/auth/mfa-enrolment.guard.ts`, `platform/backend/src/cli.ts` (`admin:reset-mfa`); `platform/backend/test/integration/admin/admin-accounts.int.test.ts`, `admin-cli.int.test.ts`, `platform/backend/test/integration/accounts/mfa.int.test.ts`, `mfa-enrolment.int.test.ts`; `tools/e2e/specs/portal-mfa-enrolment.e2e.ts`; [PADR-0008](../adr/0008-email-verification-and-mfa-policy.md) "Additional rules" item 5.

## 7. Rotating the JWT signing key

`/etc/velexis/keys/platform/platform-jwt-ed25519.pem` (`JWT_PRIVATE_KEY_FILE`, `0400 velexis-platform`) signs the access tokens of the portal and the platform admin (EdDSA, 15 minutes); a token's `kid` is the JWK thumbprint of the key's public half. Refresh tokens are opaque rows of `account_sessions` and do not depend on the key. The OTA API's staff and customer tokens have their own key (`ota-jwt-ed25519.pem`), which its own runbook rotates (FIX-W48-OTA, the same variable in `ota-backend.env`).

**The rule** ([ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md), "Rotation"): a new key brings a new `kid`, and the old public key stays valid for one token lifetime, so both keys are accepted for 15 minutes and nobody notices the change.

**As built** (FIX-W48-PLATFORM, lead decision (15f) of 2026-11-11): `TokenService` (`platform/backend/src/auth/token.service.ts`) signs with `JWT_PRIVATE_KEY_FILE` only and verifies a token with the key its `kid` names: the current key, or the previous one of `JWT_PREVIOUS_PUBLIC_KEY_FILE` when that optional variable names a file (the old key's **public** half, SPKI PEM, `0400 velexis-platform`). The API, the worker and the CLI refuse to start when the file is missing, readable by others, holds a private key or a key that is not Ed25519, or holds the public half of the current key (the same `kid`). Without the variable, a token of the old `kid` answers `401 UNAUTHENTICATED`.

**When.** After a suspected exposure of the key (the VM, the platform zone's user, a copy of `/etc/velexis` or of its backup): at once, **without the overlap** (skip steps 2 and 5 and leave `JWT_PREVIOUS_PUBLIC_KEY_FILE` unset): tokens forged with a stolen key must stop at the restart, so everyone signed in signs in again (the portal's and the admin's pages send them to the sign-in page; the automatic refresh, which uses the refresh token, also gets a token of the new key). When someone who had root leaves, or as planned hygiene: with the overlap, at any time.

**Procedure.**

1. Note the fingerprint of the current public key, move the key out of the zone's folder into a folder only root reads, and let `provision-vm.sh` create a new one. It never overwrites a key file, so it writes only the missing JWT key, `0400 velexis-platform`.

   ```bash
   sudo openssl pkey -in /etc/velexis/keys/platform/platform-jwt-ed25519.pem -pubout | sha256sum      # the old fingerprint
   sudo install -d -m 0700 -o root -g root /root/jwt-rotation
   sudo mv /etc/velexis/keys/platform/platform-jwt-ed25519.pem /root/jwt-rotation/
   sudo bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps keys
   sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only files                               # only PASS lines
   sudo openssl pkey -in /etc/velexis/keys/platform/platform-jwt-ed25519.pem -pubout | sha256sum      # a new fingerprint
   ```

2. **The overlap** (skip it after a suspected exposure): write the old key's public half into the zone's folder, `0400 velexis-platform` like every file there (`check-vm.sh`'s `key_folder`), and add it to the platform backend's env file with `sudoedit /etc/velexis/platform-backend.env` (it stays `root:root 0600`), as the one line of the second block:

   ```bash
   sudo openssl pkey -in /root/jwt-rotation/platform-jwt-ed25519.pem -pubout \
     -out /etc/velexis/keys/platform/platform-jwt-ed25519.previous.pub.pem
   sudo chown velexis-platform:velexis-platform /etc/velexis/keys/platform/platform-jwt-ed25519.previous.pub.pem
   sudo chmod 0400 /etc/velexis/keys/platform/platform-jwt-ed25519.previous.pub.pem
   sudo openssl pkey -pubin -in /etc/velexis/keys/platform/platform-jwt-ed25519.previous.pub.pem | sha256sum   # the old fingerprint
   sudoedit /etc/velexis/platform-backend.env                                                           # add the line below
   ```

   ```bash
   JWT_PREVIOUS_PUBLIC_KEY_FILE=/etc/velexis/keys/platform/platform-jwt-ed25519.previous.pub.pem
   ```

3. Restart the platform units, the worker first (the API signs with the key; the worker and the CLI check the files at start-up). Two commands, because one `systemctl restart` of both units restarts them at the same time; note the time of the API's restart:

   ```bash
   sudo systemctl restart velexis-platform-worker && sudo systemctl restart velexis-platform-api
   curl -fsS http://127.0.0.1:3100/health/ready; echo
   systemctl show -p ActiveEnterTimestamp velexis-platform-api                                          # the restart
   ```

   If a unit does not start, `sudo journalctl -u velexis-platform-worker -n 20 -o cat` (or `-u velexis-platform-api`) names the variable and the key file's problem (never its content); a worker that fails stops the command before the API restarts, so the API still runs on the old key. Put the old key back (`sudo mv /root/jwt-rotation/platform-jwt-ed25519.pem /etc/velexis/keys/platform/` after removing the new file, the `.previous.pub.pem` file and the line of step 2), restart, and find the cause before you try again.

4. **Check:** a browser that was signed in before step 3 stays signed in at `https://platform.example.com/dashboard` and at `https://admin.platform.example.com/` (with the overlap; without it, it is sent to sign in), signing in works at `https://admin.platform.example.com/sign-in` and at `https://platform.example.com/sign-in`, and `/audit` shows the rows `admin.sign_in` and `auth.sign_in`. Then destroy the old private key at once, since only its public half is needed for the overlap: `sudo shred -u /root/jwt-rotation/platform-jwt-ed25519.pem && sudo rmdir /root/jwt-rotation`.
5. **End the overlap** at least 15 minutes after the API's restart of step 3 (one token lifetime: every token of the old key has expired by then): remove the line of step 2 with `sudoedit`, delete the public key file and restart the units as in step 3. From then on the API refuses every token of the old `kid`, so the old key's copies in older backups of `/etc/velexis` can sign nothing it accepts.

   ```bash
   sudo grep -c '^JWT_PREVIOUS_PUBLIC_KEY_FILE=' /etc/velexis/platform-backend.env                    # 0
   sudo rm /etc/velexis/keys/platform/platform-jwt-ed25519.previous.pub.pem
   sudo systemctl restart velexis-platform-worker && sudo systemctl restart velexis-platform-api
   sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only files                               # only PASS lines
   ```

6. Back up `/etc/velexis` and replace the offline copy: `sudo systemctl start velexis-backup` ([deployment §3](../../../docs/mvp/deployment-single-vm.md#3-provisioning-a-new-vm) step 8).
7. Record the date, the reason, who did it, whether the overlap was used (and when it ended) and both fingerprints (hashes of public keys, not secrets).

After a suspected compromise also review `/audit` for the exposure window (every change made with a portal or admin token is audited with its IP address and user agent), disable any account that looks used by someone else (`/accounts/<accountId>`, which revokes its sessions) until its owner is reached, and follow the incident response plan.

**Done when** the fingerprint changed, both sign-ins work, the old private key is shredded, `JWT_PREVIOUS_PUBLIC_KEY_FILE` is gone from the env file with its key file (at least 15 minutes after the restart), `check-vm.sh --only files` passes and the backup ran.

**Evidence.** `platform/backend/src/auth/token.service.ts` (`loadSigningKey`, `loadVerifyingKey`, `verify`), `platform/backend/src/auth/jwt-keys.ts`, `platform/backend/src/config.ts` (`jwtPreviousKeyProblems`), `platform/backend/src/auth/token.service.test.ts`, `platform/backend/test/integration/auth/jwt-rotation.int.test.ts`; `deploy/scripts/provision-vm.sh` (`step_keys`, `new_key_file`), `deploy/scripts/check-vm.sh` (`key_folder`: every file of the folder `0400 velexis-platform`).

## 8. Rotating the master key

The procedure for both backends is [`master-key-rotation.md`](../../../docs/mvp/runbooks/master-key-rotation.md) (task X-040); follow it. What concerns the platform:

- The platform zone's copies are `/etc/velexis/keys/platform/master-v<N>.key`; `MASTER_KEY_CURRENT` is in `/etc/velexis/platform-backend.env`, which the worker reads too; both units load the keys at start-up (`platform/backend/src/common/crypto.provider.ts`).
- The platform encrypts with it the Velexis Amadeus account secrets, the OTAs' own Amadeus and Stripe credentials (connections and credential submissions), the MFA secrets of portal and admin accounts, the bank details of payout accounts, the secret links of the e-mail outbox, the provisioning reveal of the test keys, and, in Redis, a pending MFA set-up (10 minutes).
- **The platform's `secrets:rewrap`** (PBE-072; *2026-11-11: the gap that FIX-W48-SHARED recorded here is closed*, and the OTA's command is OBE-100). The runbook's steps 5 and 7 run it as `sudo velexis-run platform node dist/cli.js secrets:rewrap [--dry-run] [--batch-size <n>]` (`platform/backend/src/secrets/rewrap.command.ts`, `node dist/cli.js help` lists it). It reads `MASTER_KEY_DIR`, `MASTER_KEY_CURRENT` and `DATABASE_URL` from `/etc/velexis/platform-backend.env` and needs no Redis; it refuses to start, before it connects, when the current KEK cannot be loaded. For each of the eight tables of the query below it pages through the rows whose key id is not the current KEK, checks each value at its own place (`platform.<table>.<column>:<row id>`), re-wraps its data key (the data is not re-encrypted) and writes the row's values and key id together, only while the row still holds what was read; nothing else of the row changes (not `version`, not `updated_at`), and it publishes no `vx:invalidate`. Its output is one line per table, a total and a verdict, with counts, table names and KEK ids only (never a row id, a ciphertext or a value; an error shows as its class and code):

  ```text
  secrets:rewrap: current KEK local:v2 (loaded: local:v1, local:v2); 8 platform table(s).
  secrets:rewrap: platform.accounts: rewrapped 3, skipped 0, failed 0; remainingByKekId before {"local:v1":3} after {}
  …
  secrets:rewrap: total of 8 table(s): rewrapped 9, skipped 0, failed 0; remainingByKekId before {"local:v1":9} after {}
  secrets:rewrap: nothing is left under an old KEK: every value is under local:v2.
  ```

  `before` and `after` count the rows that hold a ciphertext and are not under the current KEK, by key id (`(none)` for an account whose secret has no key id). **Skipped** rows were changed by a person or a job between the read and the write and keep that writer's value; **failed** rows hold a value that does not authenticate at its place and stay under the old KEK: find them with the query below (the table the line names) and have the secret entered again (an MFA reset as in [§6](#6-lost-authenticator-of-an-owner-or-admin) B, the OTA owner's credentials in the portal, the payout account in the portal); an outbox link or a reveal expires by itself. A line `stopped (<class> <code>)` means the database failed for that table (for example `stopped (DatabaseError 42501)`, a privilege missing, or `stopped (Error ECONNREFUSED)`, PostgreSQL down; the command goes on with the next table and exits `1`): fix the cause and run the command again, it continues with what is left. `--dry-run` checks every value the same way, prints what would move and what would fail, and writes nothing. Exit codes: `0` when nothing is left under an old KEK (a dry run: when nothing was), `1` when a row failed or remains, a table stopped or it could not start, `2` for invalid arguments.
- **What it does not re-wrap, and when step 8 may follow.** The pending MFA set-ups in Redis (`mfasetup:<accountId>`, wrapped under the KEK that was current when the set-up started) live 10 minutes, and the OTA backend's 60-second caches of platform rows (`conn:*`, `amadeus:acct:*`) hold the ciphertexts they read: both expire by themselves, so neither is re-wrapped or flushed. A verification of a Velexis Amadeus account that runs while the command moves that account sees a changed secret and drops its result (the account stays `pending_verification`): verify it again at `/amadeus/accounts`. Step 8 (removing the old key) may follow only when both commands of step 7 exit `0` (every platform line `rewrapped 0, skipped 0, failed 0; remainingByKekId before {} after {}`), at least one minute after the platform command of step 5 finished (the 60-second caches), and at least ten minutes after the restart of step 4 (an MFA set-up started before it under the old key would otherwise fail at its confirmation, and the person would have to start it again).
- This read-only query shows how many rows each key still wraps: the rows the command counts, with the current key's too (an empty `kek` is a row without a key id). Use it to find the tables of failed rows, or while a release without the command is active (then do steps 1 to 4 only, never step 8):

  ```bash
  sudo -u postgres env PGOPTIONS='-c default_transaction_read_only=on' psql -d velexis -c "
    SELECT 'accounts' AS t, encryption_key_id AS kek, count(*) FROM platform.accounts WHERE mfa_secret_ciphertext IS NOT NULL GROUP BY 2
    UNION ALL SELECT 'amadeus_accounts', encryption_key_id, count(*) FROM platform.amadeus_accounts GROUP BY 2
    UNION ALL SELECT 'supplier_connections', encryption_key_id, count(*) FROM platform.supplier_connections WHERE client_secret_ciphertext IS NOT NULL GROUP BY 2
    UNION ALL SELECT 'payment_provider_connections', encryption_key_id, count(*) FROM platform.payment_provider_connections WHERE secret_ciphertext IS NOT NULL OR webhook_secret_ciphertext IS NOT NULL GROUP BY 2
    UNION ALL SELECT 'credential_submissions', encryption_key_id, count(*) FROM platform.credential_submissions WHERE secret_ciphertext IS NOT NULL OR webhook_secret_ciphertext IS NOT NULL GROUP BY 2
    UNION ALL SELECT 'tenant_payout_accounts', encryption_key_id, count(*) FROM platform.tenant_payout_accounts GROUP BY 2
    UNION ALL SELECT 'email_outbox', encryption_key_id, count(*) FROM platform.email_outbox WHERE secret_payload_ciphertext IS NOT NULL GROUP BY 2
    UNION ALL SELECT 'provisioning_jobs', reveal_encryption_key_id, count(*) FROM platform.provisioning_jobs WHERE reveal_ciphertext IS NOT NULL GROUP BY 2
    ORDER BY 1, 2"
  ```

- After a suspected compromise, the master-key runbook's §4 lists every credential to change at its source; on the platform's side that is the Velexis Amadeus secrets (`/amadeus/accounts`, rotate the secret with a step-up), the OTAs' own credentials (their owners enter new ones in the portal), and the MFA of every account (a reset as in [§6](#6-lost-authenticator-of-an-owner-or-admin) B, after which each one enrols again under the new key).

**Escalation.** A suspected compromise is an incident: the incident response plan first, the rotation second.

**Evidence.** `platform/backend/src/secrets/rewrap.command.ts` and `rewrap.repository.ts` (the command and its eight row sources), `platform/backend/src/secrets/rewrap.command.test.ts`, `platform/backend/test/integration/secrets/rewrap.int.test.ts` (values under `local:v1` and `local:v2` in every table: a dry run, a run, a second run, a row changed meanwhile, a corrupted and a copied value, a table whose writes PostgreSQL refuses and the run that continues, the catalog's ciphertext columns, no secret, ciphertext or row id in the output); `packages/crypto/src/rewrap-batch.ts` (`rewrapBatch`).

## 9. Why the API key pepper is never rotated

`api-key-pepper` is 32 random bytes, with identical copies in `/etc/velexis/keys/platform/` (the platform hashes the keys it creates and rolls) and `/etc/velexis/keys/ota/` (the OTA API checks the key of every request). A key's stored hash is `hex(HMAC-SHA-256(pepper, key))`; the full key is shown once and never stored ([PADR-0005](../adr/0005-api-key-format-and-hashing.md) items 3 and 4).

**Why not rotate it.** Velexis never has the keys again, so it cannot compute their hashes under a new pepper: a new pepper would make every existing key fail at once (every OTA's storefront, SDK integration and automation) until each owner made new keys. And it would buy little: a key carries about 238 random bits, so even someone with both a database dump and the pepper cannot find a key from its hash; the pepper only stops someone with the dump alone from checking guesses. [ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md) and PADR-0005 accept this for the MVP. Keys are rolled instead.

**What to do instead.**

- **A key leaked** (in a repository, a log, a ticket): an owner or admin of the OTA **rolls** it on `/otas/<tenantId>/api-keys` (a new key with the same settings, hashed with the same pepper; the old one expires now, in 1 hour, 24 hours or 7 days) or **revokes** it. The OTA API refuses the old key within a minute (the `api_key` invalidation). Platform admins have no key operations: when the owner cannot be reached and the key is being abused, the product owner may have the OTA suspended (`abuse`) until a key is rolled.
- **The pepper may have leaked** (the VM, a copy of `/etc/velexis`): the keys stay safe for the reason above. Follow the master-key runbook's §4 for the rest; when a database dump may have leaked too, ask the owners to roll their keys, which issues new keys under the same pepper.
- **The pepper is lost**: every key stops working. Restore `/etc/velexis` from the config backup ([deployment §10 and §11](../../../docs/mvp/deployment-single-vm.md#10-backups)); never generate a new pepper. `provision-vm.sh` restores a copy missing from one folder from the other and refuses to go on when the two differ.

**Check.** `sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only files` passes `api-key-pepper: identical copies in keys/platform and keys/ota`.

A rotation would need peppers with versions (each key recording its pepper's version, new keys under the new one): a new PADR and a task (the revisit condition of PADR-0005), not a runbook.

**Evidence.** `packages/crypto/src/hash.ts` (`hashApiKey`, `verifyApiKey`), `platform/backend/src/api-keys/api-key-generator.ts`, `ota/backend/src/tenancy/api-key.verifier.ts`; `platform/backend/test/integration/api-keys/api-keys.int.test.ts`; `deploy/scripts/check-vm.sh` (identical copies).

## 10. Gaps found while writing these runbooks

The questions to the lead; the sections above and the launch checklist say what to do until they are answered. The lead decided them on 2026-11-11: the JWT key overlap and the manual subscription's `active` were built by FIX-W48-PLATFORM (decisions (15f) and (15g); [§7](#7-rotating-the-jwt-signing-key) and the [launch checklist §6](launch-checklist.md#6-manual-trials-before-billing)), and `secrets:rewrap` is a task of its own (decision (15m)).

1. **Neither backend has `secrets:rewrap`.** ADR-0010 ("Rotation" item 3) and X-040 leave each backend's re-wrap command to its plan, but neither plan has the task and neither CLI the command, so a master-key rotation cannot remove the old key ([§8](#8-rotating-the-master-key)). The shared helper `rewrapBatch` of `packages/crypto` exists. *2026-11-11 (lead decision (15m), FIX-W48-SHARED):* each plan now has the task: PBE-072 (platform) and OBE-100 (OTA), in M6. *2026-11-11 (PBE-072 and OBE-100):* built: the platform backend's `secrets:rewrap` (PBE-072, [§8](#8-rotating-the-master-key)) and the OTA backend's (OBE-100) re-wrap their own ciphertext columns with `rewrapBatch`, so the master-key runbook can now go through step 8 once both report nothing under the old key.
