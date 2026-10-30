# PADR-0013: Platform e-mail outbox

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when sending volume needs a provider API (bounces, complaints) or when portal e-mails need localisation.
**Revisions:** 2026-10-30 (lead decision (2g) of 2026-10-30, recorded with FIX-W35-PLATFORM): item 5 names the `payouts.reviewed` template that PBE-058 added (dated note under item 5).

## Context

[ADR-0017](../../../docs/mvp/adr/0017-email-documents-storage.md) makes all e-mail asynchronous (Nodemailer over SMTP, Handlebars templates in `platform/backend/src/notifications/templates/`, Mailpit in development) and describes the tenant outbox, whose secret links are encrypted and purged at a final status. [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md) forbids tokens in queue messages, and the conventions require sending outside request transactions. Platform e-mails carry verification, reset and invitation links that contain tokens, so the worker needs them from somewhere other than the queue.

## Decision

1. **Table** `platform.email_outbox` (`eml_…`): `template`, `to_email`, `account_id`, `tenant_id`, `locale`, `data` (non-secret variables), `secret_payload_ciphertext` (envelope-encrypted JSON of secret variables), `status`, `attempts`, `last_error`, `provider_message_id`, `sent_at`, `secrets_purged_at`.
2. **Enqueue in the caller's transaction.** `NotificationsService.queue(tx, template, to, data, secrets?)` inserts the row in the same transaction as the business change; after commit the caller enqueues `email.send {emailId}` on `platform-emails`. A sweep (every minute, inside the processor's scheduler) picks `pending` rows older than 2 minutes, so a lost enqueue only delays the e-mail.
3. **Send.** The worker sets `sending`, decrypts secrets, renders HTML and text with Handlebars (escaping on, per-template variable allow-list checked at render), sends through SMTP, then in **one update** sets `sent`, `sent_at`, `provider_message_id`, erases `secret_payload_ciphertext` and sets `secrets_purged_at`. A CHECK refuses `sent`, `failed` or `canceled` rows that still hold secrets.
4. **Retries.** 5 attempts with exponential backoff from 30 s; then `failed` (secrets erased). The user can ask again (resend verification, request a new reset, resend an invitation).
5. **Templates** (English in the MVP, each with subject, HTML and text, and a fixture test):

   | Key | Trigger | Secret variables |
   |---|---|---|
   | `auth.verify_email` | Sign-up, resend | `verifyUrl` |
   | `auth.account_exists` | Sign-up with a known e-mail | `resetUrl` |
   | `auth.password_reset` | Reset request | `resetUrl` |
   | `auth.password_changed`, `auth.mfa_changed` | Security changes | — |
   | `team.invitation` | Invitation create or resend | `acceptUrl` |
   | `tenant.welcome` | Tenant activated | — |
   | `tenant.provisioning_failed` | Job failed | — |
   | `tenant.suspended`, `tenant.resumed` | Lifecycle | — |
   | `billing.payment_failed`, `billing.trial_ending` | Billing sync (M5) | — |
   | `domain.verified`, `domain.failed` | Domain checks (M5) | — |
   | `connection.credentials_applied`, `connection.credentials_failed`, `connection.stripe_disconnected` | Connections (M5) | — |
   | `settlement.paid` | Admin marks paid (M5) | — |
   | `ops.alert` | Pool low, live office request, payout account to review, provisioning failure | — (sent to `OPS_ALERT_EMAIL`) |

   *Note (2026-10-30, lead decision (2g), FIX-W35-PLATFORM).* PBE-058 added one template to this list: **`payouts.reviewed`**, queued when a platform admin verifies or rejects an OTA's payout account (`adminReviewPayoutAccount`, [`../flows/stripe-payments-account.md`](../flows/stripe-payments-account.md) §B, [PADR-0003](0003-settlement-of-velexis-collected-payments.md) item 10) to every active owner of the OTA, once per owner and account version. It has no secret variables: its data are the owner's name, the OTA's name and key, the outcome (`verified` or `rejected`), the next step and the link to the portal's payout account page (built from `PUBLIC_PORTAL_URL`, item 7). The reviewer's note and the bank details stay out of it (the portal shows the note). A new or changed payout account still goes to ops as an `ops.alert` (the "payout account to review" row above). The template lives with the others in `platform/backend/src/notifications/templates/` and has its fixture test (`templates.test.ts`).

6. **Sender.** `MAIL_FROM` (for example `"Velexis" <no-reply@mail.platform.example.com>`), SPF, DKIM and DMARC set for the sending domain (deploy task).
7. **Links** always use `PUBLIC_PORTAL_URL` or `PUBLIC_PLATFORM_ADMIN_URL`; never a host from the request.
8. **Retention.** Sent rows are deleted after 30 days; the audit log keeps the business event.

## Consequences

### Positive

- No token ever sits in Redis or in a log; the database holds it only encrypted and only until the e-mail is final.
- An SMTP outage never fails a sign-up or an invitation.
- One table shows what was sent to whom, for support.

### Negative

- One more table and processor to maintain, mirroring the tenant outbox.
- Failed e-mails need the user to ask again.

### Follow-ups

- Provider webhooks for bounces and complaints ([ADR-0017](../../../docs/mvp/adr/0017-email-documents-storage.md) follow-up).

## Alternatives considered

- **Send inside the request.** Couples availability to SMTP and holds transactions open.
- **Put the link in the job payload.** Forbidden by ADR-0009.
- **Reuse a tenant schema's outbox.** The platform cannot write tenant schemas.

## References

- [ADR-0017](../../../docs/mvp/adr/0017-email-documents-storage.md), [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md), [ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md)
- [db README §8](../../../docs/velexis-sdk/db/README.md) (secret payloads in the tenant outbox)
