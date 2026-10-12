# ADR-0017: E-mail, documents and storage

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Lead architect. Decided during planning; revisit when sending volume exceeds the SMTP provider's plan, or when moving storage to a managed object store.

## Context

Both backends send e-mail:

- the platform: verification, password reset, invitations, welcome, billing notices;
- the OTA backend, per tenant: customer verification and reset, booking confirmed, ticketed, cancelled, schedule changes, data-export ready.

The tenant schema has an e-mail outbox (`notifications`, with `secret_payload_ciphertext` purged after sending), `notification_templates` seeded at provisioning, and `booking_documents` for itineraries, e-ticket receipts and invoices with a `storage_key` and `content_hash` (db README §6 and §8). The reference design assumes object storage with signed URLs. On a single VM the storage must be local, and moving to managed storage must be configuration only ([`decisions.md`](../decisions.md) §2).

## Decision

### E-mail

- **Nodemailer** over SMTP in both backends, configured by `SMTP_URL` and `MAIL_FROM`.
  - Production uses any transactional SMTP provider. The choice is operational, not architectural.
  - Development and tests use **Mailpit** (SMTP on `127.0.0.1:1025`, UI and API on `:8025`).
- **Sending is always asynchronous:**
  - the use case writes the `notifications` row (tenant) or a platform e-mail job;
  - a worker renders and sends it, with retries ([ADR-0009](0009-background-jobs-bullmq.md));
  - sending never happens inside a request transaction.
- **Templates:**
  - Handlebars, with escaping on by default, plus a plain-text alternative for every HTML template.
  - Platform templates live in code (`platform/backend/src/notifications/templates/`).
  - Tenant templates are rows in `notification_templates`, seeded from code defaults at provisioning. OTAs edit them in the OTA admin (M4) with a preview, and edits are validated by compiling them.
  - Only variables from a per-template allow-list are available.
- **Sender identity:**
  - OTA e-mails are sent from a Velexis-controlled domain, for example `"Acme Travel" <no-reply@mail.ota.example.com>`, with the OTA's support address as `Reply-To`.
  - SPF, DKIM and DMARC are set up for that domain.
  - Sending from the OTA's own domain is post-MVP.
- **Secrets in e-mails** (verification links, guest booking tokens) follow db README §8: encrypted in `secret_payload_ciphertext`, rendered by the worker, purged in the same update that finalises the row.

### Documents (PDF)

- **pdfmake** generates itineraries, e-ticket receipts and invoices in the OTA worker (`ota-documents` queue) from booking data. It runs in pure JavaScript, with no headless browser and no native dependency.
- Fonts are bundled in the repository (open licence). The OTA's logo is fetched once and cached.
- Generation is triggered by booking events (confirmed, ticketed, cancelled) and is idempotent per booking version.
- Each document stores a `content_hash` (SHA-256) and is never regenerated in place: a new version is a new row.

### Storage

- **`StorageAdapter` interface**, exported from `@velexis/db` under the subpath `@velexis/db/storage` (the package that holds the infrastructure adapters): `put(key, bytes, contentType)`, `get(key)`, `delete(key)`, `signedUrl(key, ttl)`.
- **MVP adapter: `LocalDiskStorage`** under `STORAGE_DIR` (`/var/lib/velexis/storage`). Keys are prefixed `tenant_<key>/…` or `platform/…` (db README §5). Files are written atomically (temp file + rename) with mode `0600`.
- **Signed URLs:** the OTA backend serves downloads at `GET /v1/files/<key>?exp=…&sig=…`, an HMAC-SHA-256 with `document-url.key` ([ADR-0010](0010-secrets-envelope-encryption.md)), valid 5 minutes. The handler re-checks the tenant and streams the file. `bookings.getDocumentDownloadUrl` returns such a URL. On the hosted storefront the URL is same-origin under `/api`.
- **Later adapter: `S3Storage`** for any S3-compatible store, selected by `STORAGE_DRIVER=s3` with credentials in the environment. No other code changes.
- **Backups:** the storage directory is in the nightly backup ([ADR-0007](0007-single-vm-without-docker.md)).
- **Platform invoices** are Stripe-hosted. `platform.invoices.pdf_storage_key` stays null in the MVP ([ADR-0013](0013-subscription-billing-stripe-billing.md)).

## Consequences

### Positive

- No extra service on the VM, and a clear path to S3 storage and any SMTP provider.
- PDFs are generated without Chromium, which saves memory on an 8 GB VM.
- The outbox pattern means a slow or failing SMTP provider never fails a booking.

### Negative

- Local disk means documents share the VM's single point of failure and backup RPO.
- pdfmake layouts are code, not HTML, so template changes need a developer.
- Shared sending domains mean one OTA's spam complaints can affect the others. Bounce and complaint webhooks from the SMTP provider are a follow-up.

### Follow-ups

- Bounce and complaint handling, and per-OTA sending domains, after the MVP.

## Alternatives considered

- **Provider SDKs (SES, Postmark APIs)** instead of SMTP. These lock the code to one provider. SMTP keeps it neutral.
- **Puppeteer for PDFs.** Heavy (Chromium) on a small VM.
- **MinIO on the VM** as an S3-compatible store. Another service to run, with no benefit over the local disk until there are several VMs.
- **Storing PDFs in PostgreSQL.** Bloats the database and its dumps.

## References

- [`../decisions.md`](../decisions.md) §2
- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §3 (template seeding), §6 (outbox), §8 (secret payloads, documents)
- [ADR-0009](0009-background-jobs-bullmq.md), [ADR-0010](0010-secrets-envelope-encryption.md), [ADR-0015](0015-testing-strategy.md)
