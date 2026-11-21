---
id: concepts
title: Cross-cutting concepts
summary: The ideas every app shares - tenancy, identity and sessions, keys, money, payments, Amadeus, queues, caches, errors, configuration and the security layers - with what to check when they break.
order: 30
---

## Tenancy and tenant schemas

A [[tenant]] is one OTA. Each tenant has a row in `platform.tenants` (id `ten_…`, a unique [[tenant-key]] such as
`acme`, a status, a plan, a [[storefront-environment]]) and its own PostgreSQL schema `tenant_<key>` (a
[[tenant-schema]], about 45 tables: searches, offers, checkouts, bookings, payments, customers, settings, templates,
staff actions…). One database `velexis` holds three kinds of schema:

| Schema | Owner (writes, migrations) | Who else reads | Migrations |
|---|---|---|---|
| `platform` | Platform backend (`velexis_platform_app`) | OTA backend, read-only role, selected tables only, cached 60 s | `repo:platform/backend/migrations/platform` |
| `reference` | Platform backend (reference data loader) | OTA backend | `repo:platform/backend/migrations/reference` |
| `tenant_<key>` | OTA backend (`velexis_ota_app`; DDL by `velexis_provisioner`) | Nobody else: the platform role has no privileges | `repo:ota/backend/migrations/tenant` |

How a request reaches the right schema: the OTA API resolves the tenant from the caller (the storefront's host, an API
key, a staff token), then runs every tenant query inside [[tenant-tx]], a transaction that does
`SET LOCAL search_path = tenant_<key>, reference` (`repo:packages/db/src/tenant-db.ts`,
`repo:ota/backend/src/tenancy/tenant-tx.ts`). The OTA role's own `search_path` is `pg_catalog`, so a query outside
`tenantTx` fails with "relation does not exist" instead of touching the wrong tenant.

Tenant lifecycle (`platform.tenants.status`): `provisioning` → `active` ⇄ `suspended`; `failed` when provisioning gives
up (the owner can retry); `deprovisioning` and `deleted` are reserved. Only `active` tenants are served; a suspended
one answers `403 TENANT_SUSPENDED` on the storefront, the API and the console, while paid bookings keep being ticketed
and e-mailed ([[suspension]], `repo:platform/docs/adr/0014-tenant-suspension-and-resume.md`).

```bug-hunt
Tenancy isolation is the most valuable thing to test. With two OTAs (yours and the demo OTA): a booking id, customer
id or payment id of one OTA must answer 404 in the other's console and storefront; a PNR of the other OTA's office
must be refused ("This order belongs to an office outside this OTA", `403 OFFICE_NOT_ALLOWED`); a key of one OTA must
never return the other's data. Any cross-tenant leak is a release blocker.
```

Source: `repo:docs/mvp/adr/0004-postgresql-schema-per-tenant.md`, `repo:docs/velexis-sdk/db/README.md`.

## Identity: accounts, customers, staff and sessions

There are **three kinds of people** with separate identities (ADR-0008, `repo:docs/mvp/adr/0008-identity-accounts-customers-sessions.md`):

| Who | Stored in | Signs in at | Session |
|---|---|---|---|
| Portal user ([[account]]): OTA owners, their team, and Velexis staff | `platform.accounts` (Argon2id password, optional TOTP [[mfa]], recovery codes) | Portal; platform admin for `is_platform_admin` accounts | Ed25519 JWT access token (15 min) + refresh family in `platform.account_sessions` (30 days); cookies `__Host-vxp_at` / `__Host-vxp_rt` (portal) and `__Host-vxa_at` / `__Host-vxa_rt` (admin) |
| OTA staff | No account of their own: a portal account with a [[membership]] (`platform.tenant_memberships`, [[staff-role]] owner, admin, agent, finance or viewer) | Never directly: "Open console" in the portal ([[sso]]) | A [[staff-session]]: staff token (`typ staff`, `sub stf_…`, tenant, roles) + refresh family in Redis `staffsess:<familyId>`; cookies `__Host-vx_staff_at`, `__Host-vx_staff_rt`, `__Host-vx_env`, `__Host-vx_tenant` on the OTA admin |
| Traveller ([[customer]]) | `tenant_<key>.customers` (per OTA: the same e-mail at two OTAs is two customers) | Storefront `/account/sign-in.html` | Access token in `__Host-vx_at` (15 min), refresh token in `__Host-vx_rt` (`customer_sessions`), CSRF value in `__Host-vx_csrf`; a guest who looks a booking up gets a [[guest-token]] in `__Host-vx_bt` |

Rules worth testing:

- **Passwords**: portal accounts need 12+ characters with a letter and a digit; storefront customers at least 10
  characters (`repo:ota/backend/src/identity/password-policy.ts`); both refuse passwords on the breached-password list.
- **MFA** is optional for portal users, mandatory for platform admins, required to open the console of a **live** OTA,
  and asked again as a [[step-up]] (a fresh TOTP code, 15 minutes) for sensitive actions: granting `owner`, the payout
  account, live secret keys, go-live, admin operations.
- **Revocation**: "Sign out everywhere", a password change or reset, an MFA reset or a disabled account writes
  `staffdeny:acct:<accountId>` in Redis, which ends the account's console sessions too. Removing a member publishes a
  `membership` invalidation: the console refuses them within seconds (60 s at most).
- **No token in browser JavaScript**: every token is in an httpOnly [[host-cookie]]. The only cookie a script may read is
  the storefront's `__Host-vx_csrf`.

## Single sign-on into the OTA admin

"Open console" in the portal is a `POST` to `/otas/<tenantId>/console/launch`
(`repo:platform/frontend/src/app/(app)/otas/[tenantId]/console/launch/route.ts`). The platform API checks the active
membership (and MFA for a live OTA), stores a single-use [[portal-token]] `ptk_…` as `ptk:<sha256>` in Redis for 60
seconds, and the portal answers a small page that auto-posts it to `http://localhost:3002/sso` (production:
`admin.ota.example.com/sso`). The OTA admin's `/sso` route (`repo:ota/admin/src/app/sso/route.ts`) calls
`console.auth.signIn` with grant type `portal_token`; the OTA API does `GETDEL` on the token, checks membership, role
and account status, creates the staff family and returns the tokens; the OTA admin sets its four cookies and redirects
to `/bookings`. A used or expired token answers `401 PORTAL_TOKEN_INVALID` ("This console link expired or was already
used").

Source: `repo:platform/docs/adr/0007-portal-to-ota-admin-sso-token.md`, `repo:ota/docs/adr/0011-console-access-staff-sessions-and-environments.md`.

## API keys and callers

The OTA API recognises four kinds of caller (`repo:ota/backend/src/tenancy/caller-resolver.ts`,
`repo:ota/docs/adr/0009-caller-and-tenant-resolution.md`):

| Caller | How it proves itself | Tenant comes from |
|---|---|---|
| Hosted storefront (through Caddy or the Vite proxy) | `X-Velexis-Edge: <VELEXIS_EDGE_SECRET>` ([[edge-secret]]) + `X-Velexis-Host` | The host (`host:<hostname>` cache → `platform.tenant_domains`) |
| SDK user with a key | `X-Api-Key: pk_…` or `sk_…` ([[api-key]]) | The key's tenant (`apikey:<prefix>` cache → `platform.api_keys`) |
| OTA admin server | `X-Api-Key: <OTA_ADMIN_SERVICE_KEY>` ([[service-key]]), accepted only on a direct loopback connection, plus the staff token | The staff token's tenant |
| Customer in token mode | A publishable key + a bearer customer token | The key |

Keys: `pk_test_…`/`pk_live_…` (publishable, browser-safe, optional allowed origins) and `sk_test_…`/`sk_live_…`
(secret, server only) with [[key-scope|scopes]] `storefront` (default; refused on console operations), `console` (needs
a staff token) or `console:automation` plus explicit permissions. Keys are 40 base62 characters after the prefix, shown
**once**, stored only as an HMAC with the shared pepper (`repo:platform/docs/adr/0005-api-key-format-and-hashing.md`).
Last use is counted in Redis (`apikey:used:<keyId>`) and flushed to `platform.api_keys.last_used_at` every 5 minutes by
the platform worker, so "Last used" in the portal lags up to 5 minutes. A revoked key stops within about a second (60 s
at most).

## Money

Money is always `{ "amount": "123.45", "currency": "EUR" }`: a **decimal string**, never a JavaScript number, computed
with `decimal.js` ([[money-decimal]], `repo:docs/mvp/conventions.md` §1). Database columns are `numeric`. Prices pass
through one pricing engine (`repo:ota/backend/src/pricing/pricing-engine.ts`) that applies the OTA's [[markup-rule|markup
rules]] and [[fee-rule|fee rules]] to the Amadeus net price; **net prices never reach a customer** (only the console and
raw Amadeus views show them). Rounding is half-up per the currency's decimals.

```bug-hunt
Check money end to end: the price on the results page, the offer page, the price page, the checkout total, the card
fee line, the Stripe PaymentIntent amount (Stripe works in minor units), the confirmation, the e-mail, the itinerary PDF
and the console must agree to the cent. Try a 10 % markup plus a fixed fee, a currency with 0 decimals if one is
enabled, and a refund of part of a payment.
```

## Payments: Stripe, the airline card and PCI scope

Travellers pay in one of **two ways** (ADR-0011, `repo:docs/mvp/adr/0011-payments-stripe-and-airline-card.md`):

| Method | How | Who holds card data | Money flow |
|---|---|---|---|
| **Stripe** (card, 3-D Secure) | `checkout.createPayment` creates a [[payment-intent]] with **manual capture**; Stripe.js confirms it in the browser (only on `/checkout/pay-card.html`); `checkout.complete` re-reads it, creates the Amadeus order, then captures | Stripe only; never Velexis | Velexis's Stripe account by default ([[account-mode]] `velexis`), later the OTA's own account (Connect Standard or API keys) |
| **[[airline-card]]** | The card goes to `/checkout/pay-airline.html` (an isolated page with no third-party script), then in memory to Amadeus as `formOfPayments` CREDIT_CARD; the airline charges it | In transit through the OTA backend: [[pci-scope]] applies | The airline charges the traveller; no refund through Stripe |

Payment states (`tenant_<key>.payments.status`): `requires_payment_method`, `requires_action`, `processing`,
`authorized`, `captured`, `partially_refunded`, `refunded`, `canceled`, `failed`. Stripe webhooks (`payment_intent.*`,
`charge.refunded`, `charge.dispute.*`) arrive at `/webhooks/stripe/velexis/{test,live}` on the OTA API, are verified,
stored in `payment_events` (unique provider event id) and applied by the worker. Events without a known tenant are
logged and acknowledged.

The airline card is off unless **both** the global switch `AIRLINE_CARD_ENABLED=true` (OTA backend) and the OTA's
storefront setting ("Offer the airline card in the test environment") are on. Card numbers are never stored, queued,
cached or logged: only brand, BIN and last 4. Its completion is rate limited (5 per minute per end-user IP) and
declines are counted (three attempts, then `403 PAYMENT_ATTEMPTS_EXCEEDED`). PCI evidence lives in `repo:ota/docs/pci`.

Platform billing is separate: OTAs pay Velexis through [[stripe-billing]] subscriptions (`FEATURE_STRIPE_BILLING`,
off locally; before that every OTA gets a manual `early_access` trial). Velexis-collected customer payments are paid
out to the OTA by monthly [[settlement|settlements]] to a verified [[payout-account]].

## Amadeus: test and live, offices, tokens, rate limits

Flights come from [[amadeus-enterprise]] (ADR-0012, `repo:docs/mvp/adr/0012-amadeus-account-model.md`,
`repo:ota/docs/adr/0001-amadeus-client-design.md`):

- **Accounts.** Velexis owns one shared account per environment (`platform.amadeus_accounts`, credentials
  envelope-encrypted, managed in the platform admin). An OTA may later use its own credentials
  (`supplier_connections.credential_source = 'tenant'`, `FEATURE_OWN_AMADEUS`).
- **Offices.** Each OTA gets an [[amadeus-office]] from the shared account's [[office-pool]]
  (`platform.amadeus_offices`: `available` → `assigned` → `releasing` → `retired`) at provisioning (test) or on request
  (live). Office isolation: an OTA sees only orders whose owner or queuing office is one of its own.
- **Connections.** `platform.supplier_connections`, one per tenant and environment (`pending_verification`, `active`,
  `disabled`; `invalid_credentials` is reserved and never written). No free test office means the OTA activates with a `pending_verification`
  connection and the storefront cannot search until an admin assigns one.
- **Tokens.** One OAuth token per credential set and environment, shared by every OTA on the shared account, cached
  encrypted in Redis `amadeus:token:<credId>:<env>` for `expires_in` − 60 s, with a 10 s refill lock
  ([[amadeus-token-cache]]).
- **Rate limits.** Token buckets in Redis ([[rate-limit-bucket]]): per credential set 20 requests/s (burst 20), per
  tenant 5/s (burst 10), with half of each burst reserved for background work (booking sync) so shoppers keep a share
  (`repo:ota/backend/src/amadeus/limits.ts`). An empty bucket answers `429 RATE_LIMITED`.
- **Log.** Every call is a row in `supplier_requests` with redacted bodies (the console's "Supplier log").
- **Failures** map to `SUPPLIER_TIMEOUT`, `SUPPLIER_UNAVAILABLE`, `SOLD_OUT`, `PRICE_CHANGED`,
  `TRAVELER_DATA_INVALID`… **Order creation is never retried blindly**: a timeout leaves the booking `pending` and the
  [[reconciliation]] job looks for the order before anything else happens
  (`repo:ota/docs/adr/0003-booking-orchestration-and-supplier-timeout-recovery.md`).

Locally every Amadeus call goes to the [[amadeus-stub]] (see [[page:getting-started]]).

## Queues, workers and schedules

Each backend has an API process and a worker process. Background work is [[bullmq]] jobs in Redis (key prefix `vx:`),
each [[queue]] named after the worker that consumes it (`repo:packages/api-types/src/jobs/queues.ts`):

| Queue | Consumer | Carries |
|---|---|---|
| `ota-tenant-ops` | OTA worker | `tenant.provision`, `tenant.migrate`, `tenant.suspend`, `tenant.resume` (from the platform) |
| `platform-tenant-events` | Platform worker | `tenant.provisioned`, `tenant.provision_failed`, `tenant.migrated`, `tenant.migration_failed`, `tenant.suspended`, `tenant.resumed` |
| `platform-emails` | Platform worker | E-mails of `platform.email_outbox` |
| `platform-stripe-events`, `platform-domains`, `platform-connections`, `platform-settlements`, `platform-maintenance` | Platform worker | Billing events, DNS and TLS checks, credential verification, settlements, purges and flushes |
| `ota-stripe-events`, `ota-payments` | OTA worker | Payment webhooks, captures, voids, refunds |
| `ota-bookings`, `ota-ticketing` | OTA worker | Reconciliation, booking sync, ticketing retries |
| `ota-notifications`, `ota-documents` | OTA worker | E-mails of `notifications`, PDF itineraries and e-ticket receipts |
| `ota-maintenance` | OTA worker | Expiry, retention, purges, queue polling |

`platform.provisioning_jobs` is the durable record of cross-backend work; each attempt is the BullMQ job
`<job_id>-<attempt>`, and a reconciler re-dispatches lost ones every 5 minutes. E-mails use an [[outbox]] row written in
the same transaction as the change, so a crash never loses or duplicates them. The platform admin's `/queues` page shows
every queue (OTA queues view-only).

## Caches and invalidation

The OTA API caches the platform rows it needs in Redis for 60 s: `tenant:<id>`, `host:<hostname>`, `apikey:<prefix>`,
`conn:amadeus:<tenantId>:<env>`, `conn:payment:<tenantId>:<env>`, `member:<accountId>:<tenantId>`. After every change
to such a row the platform publishes [[vx-invalidate]] (`{type: "tenant" | "domain" | "api_key" | "connection" |
"membership" …}`) and the OTA API deletes its entry. Tenant-scoped state lives under `t:<tenantId>:<env>:…` (offer
caches, storefront configuration). The storefront keeps `storefront.get` in the tab's sessionStorage for 5 minutes, so
a settings change appears in an already open tab only after that (a new tab sees it at once).

```bug-hunt
A change that "does not show" is usually a missing invalidation: note how long it takes. More than about a second for a
platform change (key revoked, OTA suspended, domain verified) or for a console settings change on a new storefront tab
is a bug; up to 60 s means the invalidation was lost and only the TTL saved it.
```

## Errors: the JSON error envelope

Both APIs answer errors with **one JSON [[error-envelope]]** (`repo:packages/errors/src/envelope.ts`). It is not RFC 7807
`application/problem+json`, although older planning text speaks of "problem details":

```json
{ "error": { "code": "PRICE_CHANGED", "message": "…", "status": 409, "requestId": "…", "details": {}, "fieldErrors": [], "supplier": null } }
```

- `code` comes from the OpenAPI `x-error-catalogue`; clients map codes to text and never parse messages.
- `VALIDATION_FAILED` carries `fieldErrors: [{ path, code, message }]` (JSON pointers); messages never echo the value.
- Unknown failures are `500 INTERNAL_ERROR` with a generic message; the stack is only in the log.
- `supplier` (the raw Amadeus issue) appears only in console scope.
- Every response carries `X-Request-Id`, and every log line of that request carries the same [[request-id]]: always
  put it in a bug report.

Common codes to recognise: `UNAUTHENTICATED`, `FORBIDDEN` (`details.requiredPermission`), `NOT_FOUND`, `CONFLICT`,
`VERSION_CONFLICT` / `412` (a stale `If-Match`), `RATE_LIMITED` (`Retry-After`), `FEATURE_DISABLED`,
`TENANT_SUSPENDED`, `MFA_REQUIRED`, `REAUTH_REQUIRED` (step-up), `SUPPLIER_TIMEOUT`, `SOLD_OUT`, `PRICE_CHANGED`,
`PAYMENT_DECLINED`, `BOOKING_NOT_MODIFIABLE`, `LIVE_PRECONDITIONS_UNMET`.

The whole [[error-catalogue]] has 103 codes: 74 the OTA API may send (some shared with the platform) and 29 only the platform
sends (`repo:packages/errors/src/generated/catalogue.ts`, generated from both contracts). Some rarer ones:

| Code | Status | Where it comes from |
|---|---|---|
| `SUPPLIER_REJECTED` | 422 | Amadeus refused a request with a 4xx message; `error.supplier` holds the first Amadeus error (console scope) |
| `ANCILLARY_NOT_AVAILABLE` | 422 | A bag or seat is not offered for that traveller and segment, or the airline refused it at pricing |
| `BOOKING_ALREADY_CANCELLED` | 409 | Cancel or change of a booking that is already cancelled |
| `AMADEUS_OFFICE_UNAVAILABLE` | 409 | Platform admin assigns an office that is not `available`, or the [[office-pool]] is empty |
| `STRIPE_ACCOUNT_ALREADY_CONNECTED` | 409 | Stripe Connect returns an `acct_…` that another OTA already uses |
| `CONNECT_STATE_INVALID` | 400 | The Stripe Connect callback's `state` is unknown, used or expired |
| `SAVED_TRAVELER_LIMIT_REACHED` | 422 | Contract only: the saved-traveller operations are deferred (`501 NOT_IMPLEMENTED`) |
| `STAFF_MFA_REQUIRED` | 401 | Contract only: never thrown; the console's portal-token grant answers `MFA_REQUIRED` instead |

## Ids, time, versions and idempotency

- **Ids** are prefixed ULIDs generated by the application ([[prefixed-id]]): `ten_` tenant, `acc_` account, `stf_` staff
  member, `key_` API key, `dom_` domain, `cus_` customer, `srch_` search, `off_` offer, `prc_` priced offer, `chk_` checkout, `pay_` payment, `bkg_` booking, `job_`
  provisioning job, `ptk_` portal token. A [[booking-reference]] shown to travellers is `VX` plus six characters
  (`VXAB2C3D`); the airline's own reference is the [[record-locator]].
- **Time** is UTC `timestamptz` in the database and ISO 8601 with `Z` in the API; local times only in views (the OTA's
  `storefront_settings.time_zone`, or the airport's zone for flights). "Today" for void windows and ticketing deadlines
  is the OTA's time zone.
- **Optimistic locking**: updates send `If-Match` with the row's version; a stale one answers `412` or
  `409 VERSION_CONFLICT`.
- **[[idempotency-key|Idempotency]]**: state-changing calls (create OTA, checkout completion, console actions) take an `Idempotency-Key`;
  a replay returns the first answer (`tenant_<key>.idempotency_keys`), and Stripe calls carry their own keys
  (`pi:create:<pay_id>`, `pi:capture:<pay_id>:<amount>`).

## Configuration, keys and secrets

- Every Node app validates its configuration at start-up with `@velexis/config` (`repo:packages/config`) and refuses to
  start on a missing or unsafe value. Locally: `.env.local` files; on the VM: `/etc/velexis/<app>.env`. The full matrix
  is `repo:docs/mvp/architecture.md` §6.
- **Key files** (ADR-0010, `repo:docs/mvp/adr/0010-secrets-envelope-encryption.md`): the [[master-key]]
  (`MASTER_KEY_DIR`, `MASTER_KEY_CURRENT=local:v1`), the API key pepper, one Ed25519 JWT key per backend, and the
  document URL key (5-minute [[signed-url|signed download URLs]]).
- **[[envelope-encryption]]**: Amadeus and Stripe credentials, MFA secrets, payout bank details, the one-time reveal of
  the initial keys and secret e-mail payloads are encrypted with a data key wrapped by the master key, bound to their
  place (`platform.accounts.mfa_secret_ciphertext:<id>`). They are never logged or put in queue messages.
- **First-party credentials**: [[edge-secret]] (`VELEXIS_EDGE_SECRET`, Caddy and the Vite proxy → OTA API),
  [[service-key]] (`OTA_ADMIN_SERVICE_KEY`, OTA admin → OTA API, loopback only), [[bff]] key (`PLATFORM_BFF_KEY`,
  portal and admin → platform API, to trust the forwarded end-user IP and user agent). Development values are dummies
  such as `dev_edge_secret_change_me` (development only).
- **[[feature-switch|Feature switches]]** default to `false`: `AIRLINE_CARD_ENABLED` (OTA) and the six `FEATURE_*`
  milestone switches (platform). An operation behind an off switch answers `403 FEATURE_DISABLED`.
- **Environments**: `APP_ENV` is `development`, `test` (e2e) or `production`; independently every OTA has a `test` and
  a `live` [[storefront-environment]], and the console switches between them (`X-Velexis-Environment`, live needs a live
  OTA and a role other than viewer).

## Security layers

From the outside in (`repo:docs/mvp/adr/0027-pci-scope-and-vm-controls.md`, `repo:docs/mvp/deployment-single-vm.md`):

1. **Edge**: [[caddy]] terminates TLS (automatic certificates, [[on-demand-tls]] for storefront and custom domains via
   the platform's `/internal/tls/ask`), strips client copies of the edge headers, blocks `/internal/*` and most
   `/health/*`, adds strict CSP and security headers, and runs the Coraza [[waf]] with the OWASP Core Rule Set (blocking
   on the storefront's `/api/*` and `/checkout/*` and on `api.ota.example.com`, detection elsewhere).
2. **Apps**: BFF cookies (`__Host-`, httpOnly, Secure, SameSite=Lax), the storefront's [[csrf-token]] double submit,
   per-route rate limits (sign-ups 5 per hour per IP, guest lookups 5 failures per 15 min, airline-card completion 5 per
   minute, console 600 per minute per staff session or key), role permissions (`bookings:issue`, `settings:write`…),
   MFA and step-up.
3. **Data**: one schema per tenant, [[tenant-tx]], separate database roles per process, office isolation, envelope
   encryption, the redaction list of `@velexis/logger`, audit trails ([[audit-log]] `platform.platform_audit_log`,
   [[staff-action]] `tenant_<key>.staff_actions`).
4. **Host**: one system user per trust zone, systemd sandboxing, an nftables outbound allow-list, AIDE file integrity,
   auditd, encrypted off-site backups ([[app:deploy]]).
