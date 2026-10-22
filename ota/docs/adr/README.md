# OTA architecture decision records

This folder holds the decision records that concern only the OTA group (OTA backend, hosted storefront, OTA admin, JS SDK). They are numbered `OADR-NNNN` so they never clash with the cross-cutting `ADR-NNNN` of [`docs/mvp/adr/`](../../../docs/mvp/adr/README.md) or the platform `PADR-NNNN` of [`platform/docs/adr/`](../../../platform/docs/adr/README.md). They use the same MADR-lite format ([ADR-0001](../../../docs/mvp/adr/0001-record-architecture-decisions.md)) and must not contradict [`decisions.md`](../../../docs/mvp/decisions.md) or any cross-cutting ADR. Precedence: `decisions.md` → cross-cutting ADRs → OTA ADRs → plans → code.

Related: [OTA docs index](../README.md), [`../architecture.md`](../architecture.md), [`../architecture-booking.md`](../architecture-booking.md).

## Index

| OADR | Title | Status | In one line |
|---|---|---|---|
| [0001](0001-amadeus-client-design.md) | Amadeus client design | Accepted | One typed client for the 12 operations; resolver incl. releasing offices; encrypted token cache; two token buckets; retries for reads only; error table; redacted `supplier_requests`. |
| [0002](0002-offer-and-priced-offer-caching.md) | Offer and priced-offer caching and expiry | Accepted | Offers in PostgreSQL, Redis only for single flight; TTLs from settings; re-price at completion after 10 min; purge every 15 min; synchronous search only. |
| [0003](0003-booking-orchestration-and-supplier-timeout-recovery.md) | Booking orchestration and SUPPLIER_TIMEOUT recovery | Accepted | Claim (pending row) → call → record → money → issue, no transaction across calls; every order findable by remark and booking queue; only a `4xx` business refusal voids, any answer that proves nothing (`5xx` included) is reconciled; checkout locked while its booking is pending; 15-minute reconciliation that reads every candidate PNR and never voids on an incomplete search (staff review at the deadline, after up to 3 more attempts when only transient failures left it incomplete); airline card goes to manual review; locks in the order checkout, booking, payment, refund. |
| [0004](0004-airline-card-data-handling.md) | Airline-card data handling in the backend | Accepted | Dedicated edge-only route, `SensitiveCard` in memory, idempotency hash without the card, airline's price (`pricing_mode = net`), brand/BIN/last 4 only, abuse limits. |
| [0005](0005-markup-and-fee-engine.md) | Markup and fee engine | Accepted | Pure engine: first non-stackable rule plus stackable rules, half-up rounding per line, no FX for fixed amounts, fees by step, immutable snapshots. |
| [0006](0006-storefront-cookie-sessions-and-csrf.md) | Storefront cookie sessions and CSRF | Accepted | `__Host-` cookies only in edge mode, double-submit CSRF plus Origin on every edge write, token-free bodies (approved response type change), guest token list cookie. |
| [0007](0007-tenant-migration-runner-and-provisioning-worker.md) | Tenant migration runner and provisioning worker | Accepted | One migrator transaction per provisioning, default privileges for later tables, code seeds, ledger in events, deploy fan-out reported with `jobId = null`; suspension expires checkouts except those whose booking is pending. |
| [0008](0008-ticketing-policy.md) | Ticketing policy: automatic and manual issuance | Accepted | Default `issue_after_payment`; airline card always issues; no pay-later; early deadline reading; bounded retries with resync; staff decide at the end. |
| [0009](0009-caller-and-tenant-resolution.md) | Caller and tenant resolution | Accepted | Edge, service key (direct loopback without `X-Forwarded-For`, never through Caddy), API key, public, in that order; the service caller's forwarded end-user IP; tenant and environment per caller; 60 s caches with negative caching and `vx:invalidate`. |
| [0010](0010-stripe-gateway-and-payment-webhooks.md) | Stripe gateway and payment webhooks | Accepted | Mode from data, payment row before PaymentIntent, idempotency keys on every write, tenant bound to the webhook endpoint with metadata and `livemode` cross-checks, webhooks stored as `payment_events` then re-fetched. |
| [0011](0011-console-access-staff-sessions-and-environments.md) | Console access: staff sessions, environments and permissions | Accepted | Portal-token grant only, 12 h staff families with four deny keys (family, account, tenant and member cut-offs), live for non-viewer roles, settings and payments permissions, raw Amadeus read-only, a `staff_actions` row for every change, every refusal and every read of one person's personal data or a supplier record (none for other reads or a `429`). |
| [0012](0012-storefront-settings-assets-and-pages.md) | Storefront settings, assets and content pages | Accepted | Same-origin immutable image assets (no SVG, no CSS), theme tokens, Markdown-subset pages parsed to blocks, 5-minute caches of the caller-independent part only. |
| [0013](0013-notifications-and-booking-documents.md) | Notifications and booking documents | Accepted | Outbox in the business transaction, code-default templates, itinerary and e-ticket PDFs only (no invoices), signed downloads. |
| [0014](0014-per-tenant-workers-and-schedulers.md) | Per-tenant workers and schedulers | Accepted | Schedulers fan out small per-tenant jobs, bounded batches, claims instead of long locks (`FOR NO KEY UPDATE SKIP LOCKED`, so a child row's insert never makes a claim skip), suspended tenants keep obligations to paid travellers. |
| [0015](0015-storefront-build-urls-and-hosting.md) | Storefront build, URLs and hosting | Accepted | One Vite MPA build for all tenants, CSP-clean output, `.html` URLs with query-string ids, one `/p/<slug>` rewrite, build-time partials, font enum, no airline logos, dev proxy and preview that mimic Caddy. |
| [0016](0016-sdk-packaging-and-type-contract.md) | SDK packaging and type contract | Accepted | Generated route table with hand-written methods, types inferred from factories, per-method contract assertions with an approved-deviations list, `session` and `environment` options, ESM + IIFE, self-contained published types. |
| [0017](0017-airline-card-form-isolation.md) | Airline-card form isolation on the storefront | Accepted | Separate page and bundle, no third-party code, stricter path CSP with COOP, nameless inputs, values only in inputs until one SDK call, cleared on leave, tested for leaks; the whole origin in the script inventory, residual risk of the shared origin stated for the M6 review. |
| [0018](0018-ota-admin-consumes-the-sdk-server-side.md) | The OTA admin consumes the SDK on the server | Accepted | Server-only SDK clients per request, staff cookies, refresh only where cookies can be written and de-duplicated per token, permissions from `console.auth.me`, read-only shopping, no card entry, audit page later. |

## Requirements from other groups that these ADRs implement

| Requirement | Source | Implemented by |
|---|---|---|
| Check `staffdeny:acct:<accountId>` in the staff guard and on refresh | [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md) | [OADR-0011](0011-console-access-staff-sessions-and-environments.md) |
| Velexis account for orders owned by `assigned` or `releasing` offices | [PADR-0012](../../../platform/docs/adr/0012-amadeus-office-pool.md) | [OADR-0001](0001-amadeus-client-design.md) |
| `tenant.suspend` / `tenant.resume` consumer and worker exceptions | [PADR-0014](../../../platform/docs/adr/0014-tenant-suspension-and-resume.md) | [OADR-0007](0007-tenant-migration-runner-and-provisioning-worker.md), [OADR-0014](0014-per-tenant-workers-and-schedulers.md) |
| `tenant.provision` consumer and event producer | [PADR-0001](../../../platform/docs/adr/0001-tenant-provisioning-orchestration.md) | [OADR-0007](0007-tenant-migration-runner-and-provisioning-worker.md) |
| Handlers for the `account`, `amadeus_account` and `plan` invalidation types | [platform architecture §6.3](../../../platform/docs/architecture.md#63-cache-invalidation-vxinvalidate) | [OADR-0009](0009-caller-and-tenant-resolution.md) |

## Requests from the storefront, SDK and OTA admin ADRs to other parts

| Request | Owner | Asked by |
|---|---|---|
| Caddyfile: `rewrite /p/* /p.html` in the storefront `handle` block | Deploy (`deploy/caddy/Caddyfile`) | [OADR-0015](0015-storefront-build-urls-and-hosting.md) |
| Caddyfile: path-specific CSP without Stripe hosts, COOP `same-origin` and `no-store` for `/checkout/pay-airline.html`; `worker-src 'none'` in the general storefront CSP; no COOP `same-origin` elsewhere | Deploy (done by OFE-014) | [OADR-0017](0017-airline-card-form-isolation.md) |
| Daily integrity check over every page of `payment-page-inventory.json`, not only the two payment pages | Foundation (X-030 healthcheck) | [OADR-0017](0017-airline-card-form-isolation.md) |
| `deploy.sh`: run `tenants:report-migrations` through `velexis-run ota` after the tenant fan-out; `deployment-single-vm.md` §8–§9 | Deploy (done by OBE-007) | [OADR-0007](0007-tenant-migration-runner-and-provisioning-worker.md) |
| Service key "only from `127.0.0.1`" becomes "direct loopback without `X-Forwarded-For`"; the OTA admin forwards `X-Velexis-End-User-IP` / `-Agent` | Cross-cutting ADR ([ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), service key bullet) | [OADR-0009](0009-caller-and-tenant-resolution.md), [OADR-0011](0011-console-access-staff-sessions-and-environments.md) |
| Font names as an enum in `StorefrontSettings.branding.fonts`; e-mail links to `/account/verify.html`, `/account/reset-password.html`, `/booking.html?id=` | OTA backend (OpenAPI, notifications) | [OADR-0015](0015-storefront-build-urls-and-hosting.md) |
| Refuse `creditCard` in console `formOfPayments` (`403 FEATURE_DISABLED`) in the MVP | OTA backend (console) | [OADR-0018](0018-ota-admin-consumes-the-sdk-server-side.md) |
| `console.staffActions.list`, spec-first, when a tenant-wide audit view is requested | OTA backend (later) | [OADR-0018](0018-ota-admin-consumes-the-sdk-server-side.md) |

## Adding an OTA ADR

1. Copy the template of [ADR-0001](../../../docs/mvp/adr/0001-record-architecture-decisions.md) into `NNNN-kebab-title.md` with the next free number and the heading `# OADR-NNNN: Title`.
2. Use status `Proposed` in the pull request; the developer sets `Accepted` on merge. Decisions taken while planning say "Decided during planning; revisit when …" in **Deciders**.
3. Add a row to the index above and update the documents the decision changes in the same pull request.
4. If the decision needs behaviour from the platform group (a queue message, a Redis key, a platform column), name it under **Follow-ups** so the platform plan picks it up. If it changes a cross-cutting decision, write a cross-cutting ADR in `docs/mvp/adr/` instead.
