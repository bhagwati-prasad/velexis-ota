# OADR-0013: Notifications and booking documents

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when an OTA needs invoices issued by Velexis, SMS, or sending from its own domain.
**Revisions:** 2026-10-23 (lead decision (3), recording FIX-W27-SYNC): point 6's itinerary is also rendered again on a schedule change (`booking.schedule_changed`), whichever synchronisation found it (dated note under point 6).

## Context

[ADR-0017](../../../docs/mvp/adr/0017-email-documents-storage.md) fixes the mechanics: Nodemailer over SMTP, sending only from workers, Handlebars templates (tenant templates are rows seeded at provisioning and edited in the OTA admin), pdfmake documents in the `ota-documents` queue, idempotent per booking version, a `StorageAdapter` with signed URLs, and OTA e-mails from a Velexis-controlled domain with the OTA's support address as `Reply-To`. The tenant schema has `notifications` (outbox with encrypted secrets purged at a final status) and `booking_documents` with kinds `e_ticket_receipt`, `emd_receipt`, `itinerary`, `invoice`, `credit_note`. The contract queues itinerary, e-ticket receipts and an invoice at completion. Invoices are legal documents with numbering and tax rules per country.

## Decision

1. **Outbox in the business transaction.** Use cases insert `notifications` rows (`pending`, `dedupe_key` such as `booking.ticketed:bkg_…:v3`) in the same transaction as the state change, and enqueue `notify {tenantId}` after commit. The `notifications.sweep` scheduler catches anything missed.
2. **Worker sending.** The `ota-notifications` processor takes due rows with `FOR UPDATE SKIP LOCKED`, renders, sends, and in the same update moves the row to `sent` or `failed` and erases `secret_payload_ciphertext` (the CHECK enforces it). Retries: 5 attempts with exponential backoff from 1 minute; then `failed` and a staff alert for booking e-mails.
3. **Templates.** Effective template = tenant row if present and active, else the code default for that key and locale, else the code default in English. Defaults live in `notifications/templates/<key>.{subject,html,txt}.hbs`. Handlebars runs in strict mode with a per-key variable allow-list; edits are compiled and checked on save (`422 TEMPLATE_INVALID`). New keys in later releases need no data migration.
4. **MVP template keys:** customers `auth.verify_email`, `auth.password_reset`; travellers `booking.confirmed`, `booking.ticketed`, `booking.ticketing_delayed`, `booking.cancelled`, `booking.cancellation_requested`, `booking.not_confirmed`; staff `staff.ticketing_failed`, `staff.manual_review`, `staff.airline_card_alert`. E-mail only.
5. **Sender.** `From: "<OTA brand name>" <no-reply@mail.ota.example.com>` (the domain of `MAIL_FROM`), `Reply-To: storefront_settings.support_email`. Staff alerts go to `ops_alert_email`, else to the owners' e-mails read from the platform.
6. **Documents in the MVP:** `itinerary` (on confirmation, on ticketing, on cancellation; the previous one becomes `superseded`) and `e_ticket_receipt` (one per ticket). **No `invoice`, `credit_note` or `emd_receipt`** in the MVP: legal invoicing (numbering, VAT, company data) stays with the OTA's accounting until a later decision. The confirmation e-mail says so.

   **2026-10-23 (lead decision (3), FIX-W27-SYNC).** A schedule change by the airline (`booking.schedule_changed`, which the background sync, a refresh or console.bookings.resync writes, whichever reads the changed order first) also asks for a new itinerary with the new times (`DOCUMENT_TRIGGERS` of [`documents.processor.ts`](../../backend/src/documents/documents.processor.ts)); no e-mail of its own in the MVP.
7. **Rendering.** pdfmake with fonts bundled in the repository and the OTA's square logo read from `storefront_assets` (no network fetch). Job key `document.render:<bookingId>:<kind>:<bookingVersion>[:<ticketId>]`; a second job for the same key is a no-op. Files are stored at `tenant_<key>/documents/<bookingId>/<documentId>.pdf` with SHA-256 in `content_hash`.
8. **Attachments.** `booking.confirmed` attaches the itinerary and `booking.ticketed` the e-ticket receipts when they are `ready`; if not ready within 2 minutes the e-mail is sent with a link to the booking page instead.
9. **Downloads.** `bookings.getDocumentDownloadUrl` returns a 5-minute HMAC-signed URL under `/v1/files/` (same-origin `/api/v1/files/` for the edge); the handler re-checks the tenant and streams the file with `Content-Disposition: attachment`.

## Consequences

### Positive

- E-mails and documents never block or fail a booking request.
- OTAs can edit every message, and missing templates never break sending.
- No legal-invoice obligations for Velexis in the MVP.

### Negative

- OTAs must issue invoices themselves; some will need it soon.
- One sending domain for all OTAs: one OTA's bounces affect the shared reputation (bounce handling is basic in the MVP).
- PDFs use a fixed layout; only the logo and colours are customisable.

### Follow-ups

- Invoices and credit notes with per-tenant numbering when OTAs ask for Velexis invoicing.
- Bounce webhooks from the SMTP provider to set `bounced`.

## Alternatives considered

- **Send in the request.** Slow and fragile; ADR-0017 forbids it.
- **HTML-to-PDF with a headless browser.** Rejected in ADR-0017 for memory on one VM.
- **Seed every template row and backfill new keys.** Data migrations per tenant for each new key; the code fallback is simpler.

## References

- [ADR-0017](../../../docs/mvp/adr/0017-email-documents-storage.md), [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md), [ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md)
- [db README §6, §8](../../../docs/velexis-sdk/db/README.md) (outbox, secret purge)
- [`../flows/ticketing-and-documents.md`](../flows/ticketing-and-documents.md), [`../api-changes-console-and-internal.md`](../api-changes-console-and-internal.md) §2.6
