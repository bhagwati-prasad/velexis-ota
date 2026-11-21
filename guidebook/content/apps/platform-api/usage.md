---
id: usage
title: Platform API — usage guide
summary: How to run, call and test the control-plane API and its worker - every endpoint group, the CLI commands and schedules, the expected answers, and what to check in PostgreSQL, Redis, BullMQ and Mailpit.
---

## What it is

The platform API is the [[control-plane]] of Velexis (`repo:platform/backend`, package `@velexis/platform-backend`).
It owns everything that is about OTAs as customers of Velexis, not about travellers: [[account]]s and sessions,
[[tenant]]s (OTAs) and their [[provisioning-job]]s, [[membership]]s and [[invitation]]s, [[api-key]]s,
[[custom-domain]]s, Amadeus and Stripe connections, [[plan]]s, [[subscription]]s and [[settlement]]s, and the
`/v1/admin/**` operations of Velexis staff. It is two processes built from one code base:

| Process | Entry | Port (127.0.0.1) | Does |
|---|---|---|---|
| API | `repo:platform/backend/src/main.ts` → `dist/main.js` | 3100 | 144 operations of the OpenAPI document, Stripe webhooks, Caddy's TLS ask, health |
| [[platform-worker]] | `repo:platform/backend/src/worker.ts` → `dist/worker.js` | 3101 (health only) | BullMQ processors, schedules, e-mail sending |
| CLI | `repo:platform/backend/src/cli.ts` → `dist/cli.js` | — | `dev:seed`, `admin:grant`, `admin:reset-mfa`, `secrets:rewrap`, `tenants:create-demo` |

Nobody uses it from a browser. The [[app:portal]] and [[app:platform-admin]] call it from their servers (a [[bff]]),
Caddy calls `/internal/tls/ask`, Stripe posts webhooks, and the OTA side talks to it only through queues, Redis and
read-only tables - never synchronous HTTP.

```diagram
neighbours
```

What you test here is therefore mostly *what happens behind the portal and admin screens*: the rows, e-mails, jobs
and Redis keys each action leaves behind. You can also call every operation directly with `curl` (below).

## Before you start

You need PostgreSQL 16, Redis 7, Mailpit and the Amadeus stub running natively (no Docker), Node 24 and pnpm. The
full walkthrough:

```diagram
flow-local-setup
```

The short version, from the repository root:

```try
command: pnpm dev:keys && cp platform/backend/.env.example platform/backend/.env.local
command: pnpm db:migrate && pnpm db:seed:reference
command: pnpm stub:amadeus
command: pnpm --filter @velexis/platform-backend dev:seed
command: pnpm --filter @velexis/platform-backend dev
url: http://127.0.0.1:3100/health/live
expect: {"status":"ok"}; http://127.0.0.1:3101/health/ready lists postgres and redis as ok
```

Seeded data (development only):

| What | Where it comes from | Notes |
|---|---|---|
| Platform admin `admin@example.com` | `dev:seed` (`repo:platform/backend/src/dev/dev-seed.command.ts`) | Random 24-character password and TOTP `otpauth://` URI **printed once**. Lost? `node dist/cli.js admin:reset-mfa admin@example.com` and "Forgot password" |
| Velexis test Amadeus account | `dev:seed` | Points at `AMADEUS_BASE_URL_TEST` (stub `http://127.0.0.1:4900`); stays `pending_verification` and exit 1 until the stub runs |
| 40 test offices `DEV1A0001`…`DEV1A0040` | `dev:seed` | The [[office-pool]]; each new OTA takes one |
| Plan `early_access` | migration `0002` | The only plan before M5 billing |
| Portal accounts | none | Sign up yourself; verification links arrive in Mailpit (http://127.0.0.1:8025) |
| Velexis's own [[demo-ota]] | `node dist/cli.js tenants:create-demo <email> --country <CC> --currency <CUR> --time-zone <zone>` | Key `demo`, manual subscription set `active`; the owner needs MFA |

Development connection strings (from `.env.example`, development only): `psql
postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis`, `redis-cli -a dev_redis`.

```note
The M5 [[feature-switch]]es (`FEATURE_STRIPE_BILLING`, `FEATURE_OWN_STRIPE`, `FEATURE_SETTLEMENTS`,
`FEATURE_OWN_AMADEUS`, `FEATURE_CUSTOM_DOMAINS`, `FEATURE_LIVE_SWITCH`) are `false` in `.env.example`. With a switch
off, its operations answer `403 FEATURE_DISABLED` and its schedules are not registered. Turn one on in `.env.local`
and restart both processes to test that area (Stripe ones also need `STRIPE_*` test values and `stripe listen`).
```

### Calling it with curl

```diagram
flow-curl-session
```

Every request without the [[bff-key]] simply uses the socket address as the end-user IP. A portal access token
lives 15 minutes; refresh it with `POST /v1/auth/refresh`. Admin operations need an admin token from
`POST /v1/admin/auth/sign-in` + `POST /v1/admin/auth/mfa/verify` (TOTP from the `dev:seed` URI).

## Tour

The API has no screens, so the tour walks every endpoint group of
`repo:platform/backend/openapi/velexis-platform-api.openapi.yaml` (the source of truth; `app.json` of this app lists
all 144 operations). Each operation has an [[operation-scope]] (`public`, `portal_unverified`, `portal`,
`platform_admin`, `webhook`, `internal`) that decides its guard.

### Auth (`/v1/auth/**`, public unless noted) — `repo:platform/backend/src/auth/auth.controller.ts`

| Endpoint | Try | Should happen |
|---|---|---|
| `POST /sign-up` | New and existing address; weak password | `202 {status: verification_sent}` both ways; new: `accounts` row `pending_verification` + `auth.verify_email`; existing: only `auth.account_exists` e-mail; weak: `422 PASSWORD_TOO_WEAK`; 6th per IP per hour `429` |
| `POST /verify-email` | Link token twice | `200`, account `active`; second use `400 VERIFICATION_TOKEN_INVALID` |
| `POST /resend-verification` | Any address | Always `202`; new link only for an unverified account; 3 per address and 10 per IP per hour |
| `POST /sign-in` | Wrong password 5 times; right password of a disabled account | `401 INVALID_CREDENTIALS` (same body for unknown address), 5th: `423 ACCOUNT_LOCKED` + `Retry-After` ([[account-lockout]]); the count is only reset by a successful sign-in, so after the lockout every further wrong password locks again; disabled: `403 ACCOUNT_DISABLED` (only after a correct password); [[mfa]] accounts get an MFA challenge `{mfaRequired, mfaChallengeToken, expiresIn}` |
| `POST /mfa/verify` | TOTP or recovery code; wrong code | `PortalSession`; the same code twice fails (`mfastep:`); wrong code `401 MFA_CODE_INVALID`; after 5 wrong codes, or after 5 minutes, `401 MFA_CHALLENGE_INVALID` (sign in again) |
| `POST /refresh` | Old refresh token after a refresh | `401 REFRESH_TOKEN_REUSED` and the whole [[refresh-family]] is revoked |
| `POST /sign-out`, `/sign-out-everywhere` (`portal_unverified`) | Then use the old refresh token | `204`; everywhere also writes `staffdeny:acct:<id>` ([[staff-deny-cut-off]]) and kills OTA console sessions |
| `POST /password-reset`, `/password-reset/confirm` | Unknown address; reuse the link; weak new password | `202` always (only an `active` account gets the `auth.password_reset` link, valid 1 h); a used, expired or unknown link `400 PASSWORD_RESET_TOKEN_INVALID`; weak password `422 PASSWORD_TOO_WEAK` (the link stays usable); confirm `204`, revokes every session, writes `staffdeny:` and sends `auth.password_changed` |
| `POST /step-up` (`portal`) | Code, then a step-up operation | New tokens with `mfa_at`; [[step-up]] operations pass for 15 minutes |

### Account (`/v1/me/**`) — `repo:platform/backend/src/accounts`

| Endpoint | Try | Should happen |
|---|---|---|
| `GET /v1/me`, `PATCH /v1/me` (`If-Match`) | Unverified account; stale version | Works unverified; `mfaEnrolmentRequired` true for an owner/admin of a live OTA without MFA; stale `If-Match` → `412` |
| `POST /v1/me/password` | Wrong current password | `422 CURRENT_PASSWORD_INCORRECT`; a change keeps the caller's session, revokes the others, writes `staffdeny:` and sends `auth.password_changed` |
| `POST /v1/me/mfa/setup`, `/enable` | Enable with a wrong code; set up twice | Secret waits 10 min in Redis `mfasetup:<accountId>` (encrypted); wrong code `401 MFA_CODE_INVALID`; set-up older than 10 min `400 MFA_SETUP_EXPIRED`; set-up while MFA is on `409 MFA_ALREADY_ENABLED`; enable returns ten recovery codes once, e-mail `auth.mfa_changed` |
| `POST /v1/me/mfa/disable`, `/recovery-codes` | Without a step-up; disable as live owner or as platform admin | `401 REAUTH_REQUIRED` without step-up; disable: `409 CONFLICT mfa_mandatory` for an owner/admin of a live OTA ([[mandatory-mfa]]), `403 FORBIDDEN platform_admin` for a platform admin; new recovery codes are allowed for both |
| `GET /v1/me/sessions`, `DELETE /v1/me/sessions/{familyId}` | Revoke another browser | Family revoked; that browser's next refresh fails |

### Plans and tenants — `repo:platform/backend/src/tenants/tenants.controller.ts`, `repo:platform/backend/src/provisioning/lifecycle.controller.ts`

| Endpoint | Try | Should happen |
|---|---|---|
| `GET /v1/plans` (public) | — | Public active plans with limits and prices |
| `GET /v1/tenants/key-availability?key=` | `demo`, `www`, `Acme`, a used key | `200 {key, available: false, reason, storefrontHost}` with `reason` `invalid` (breaks `^[a-z][a-z0-9]{2,29}$`, never a `400`), `reserved` or `taken` (any tenant row, also failed ones); 30/min per account |
| `GET /v1/tenants` (`portal_unverified`) | Account with no OTA | Only OTAs where the caller is an active member |
| `POST /v1/tenants` (`Idempotency-Key`, 16-128 characters `[A-Za-z0-9_-]`) | Unverified account; 4th OTA; same key twice | `202`; `403 EMAIL_NOT_VERIFIED`; `409 TENANT_KEY_UNAVAILABLE`; `422 UNPROCESSABLE tenant_limit` (OTAs the caller owns that are not `failed`, MAX_TENANTS_PER_ACCOUNT); replay returns the stored `202`. With `FEATURE_STRIPE_BILLING` on, `planCode` is required and its plan needs a Stripe Price (`422 PLAN_NOT_AVAILABLE`) |
| `GET/PATCH /v1/tenants/{tenantId}` | As non-member; invalid country | `404 NOT_FOUND` for non-members (never 403); profile edits by owner/admin; publishes `vx:invalidate tenant` |
| `GET …/provisioning`, `POST …/provisioning/retry` | Retry an active OTA | Step log and status; retry (owner) only for `failed` (`409 PROVISIONING_NOT_RETRYABLE`), `202` with a **new** job, or `422 UNPROCESSABLE tenant_limit` (createTenant's error; nothing changes) while an owner of the OTA already owns `MAX_TENANTS_PER_ACCOUNT` OTAs that are not `failed`; the admin's job retry and billing sync's reopen after a paid Checkout are exempt (see the bug-hunt below) |
| `POST …/initial-keys/reveal` | Reveal twice; after 24 h | Owner only; keys once (`no-store`), then `410 KEYS_ALREADY_REVEALED`; before the set-up issued keys `404` ([[initial-keys-reveal]]) |
| `GET …/onboarding` | Fresh OTA | [[onboarding-checklist]]: `email_verified`, `mfa_enabled`, `ota_active`, `api_key`, `storefront_open`, `amadeus_test`, `team_invited`, then M5 items when their switch is on |
| `POST …/go-live` | With missing preconditions | See [[go-live]]: `422 LIVE_PRECONDITIONS_UNMET` with `details.missing` |

### Team — `repo:platform/backend/src/memberships`

| Endpoint | Try | Should happen |
|---|---|---|
| `GET …/members`, `PATCH …/members/{memberId}`, `DELETE …/members/{memberId}` | Admin promotes to owner; last owner leaves | Admin cannot touch owners/admins (`403`); granting owner needs step-up; last owner `409 LAST_OWNER`; members may remove themselves |
| `GET/POST …/invitations`, `DELETE …/invitations/{id}`, `POST …/{id}/resend` | Invite an existing member; exceed `staffSeats` (5 on `early_access`, active members + pending invitations) | `201`; `409 ALREADY_MEMBER` / `INVITATION_PENDING`; `422 PLAN_LIMIT_REACHED`; resend `202` invalidates the old link at once; resend or revoke of a non-pending invitation `409 CONFLICT not_pending` |
| `POST /v1/invitations/lookup` (public), `/accept` | Accept with another address | Lookup 20/h per IP; `403 INVITATION_EMAIL_MISMATCH`; expired `400 INVITATION_INVALID` |
| `POST …/console-token` | Suspended OTA; live OTA without MFA | `409 TENANT_NOT_ACTIVE` (with `suspensionReason`); `403 MFA_REQUIRED`; success writes `ptk:<sha256>` for 60 s ([[portal-token]]) |

### API keys — `repo:platform/backend/src/api-keys/api-keys.controller.ts`

| Endpoint | Try | Should happen |
|---|---|---|
| `GET/POST …/api-keys` | Secret key with origins; live key on a test OTA; 11th key | `201`, full key once (`no-store`); origins only for publishable keys (`400 VALIDATION_FAILED`); live key with the switch off `403 FEATURE_DISABLED`, on a test OTA `422 LIVE_MODE_NOT_ENABLED`; live secret needs step-up; over `limits.apiKeys` (10 on `early_access`) `422 PLAN_LIMIT_REACHED`; any write on a non-active OTA `409 TENANT_NOT_ACTIVE` |
| `PATCH …/api-keys/{keyId}` | Change origins | `vx:invalidate api_key` |
| `POST …/{keyId}/roll`, `…/revoke` | Roll with `7d`; revoke twice | Old key expires later; revoked keys are final (`409`) |

### Domains — `repo:platform/backend/src/domains/domains.controller.ts`

| Endpoint | Try | Should happen |
|---|---|---|
| `GET …/domains` | Fresh OTA | The verified sub-domain `<key>.<STOREFRONT_BASE_DOMAIN>` as primary |
| `POST …/domains` | `api.ota.example.com`, `travel.acme.example.com`, a host another OTA has | Switch off, or a plan with `limits.customDomains = 0` (`early_access`): `403 FEATURE_DISABLED`; `422 DOMAIN_INVALID` for Velexis hosts; `201 pending` with TXT/CNAME/A/AAAA records for [[domain-verification]]; `409 DOMAIN_TAKEN` |
| `POST …/{domainId}/check` | Twice within a minute | `202`, then `429` (1/min per domain) |
| `POST …/{domainId}/make-primary`, `DELETE …/{domainId}` | Pending domain; remove primary; remove the sub-domain | `409 DOMAIN_NOT_VERIFIED`; removing a primary (`204`) makes the sub-domain primary; the sub-domain answers `409 CONFLICT subdomain` |

### Connections — `repo:platform/backend/src/supplier-connections/connections.controller.ts`, `repo:platform/backend/src/payment-connections`

Each OTA has one [[supplier-connection]] (Amadeus) and one [[payment-connection]] (Stripe) per environment; the payment
connection's [[account-mode]] is `velexis`, `connect_standard` or `api_keys`.

| Endpoint | Try | Should happen |
|---|---|---|
| `GET …/amadeus-connections`, `PATCH …/amadeus-connections/{environment}` | Default office not in `office_ids` | Masked reads (owner/admin/finance); validation of offices and queues |
| `POST …/amadeus-connections/live/request` | On `early_access`; twice | Owner only, `live_switch`; a plan without `limits.liveMode` (`early_access`) `403 FEATURE_DISABLED`; `202` writes a `pending_verification` live connection that waits for an admin office (dashboard `liveOfficeRequests`); the second request `409 CONFLICT live_connection_exists` |
| `PUT …/amadeus-connections/{environment}/credentials` | Wrong secret | Step-up, `own_amadeus`; `202` [[credential-submission]] that ends `failed` without touching the working connection |
| `GET …/credential-submissions/{submissionId}` | Poll | `pending` → `verifying` → `applied`/`failed` |
| `GET …/payment-connections`, `PATCH …/payment-connections/{environment}` | Descriptor `ab`, `a`, `ACME-TRAVEL`, `ÅSE` | Suffix of 2-22 ASCII letters, digits and spaces, starting with a letter or digit, with at least one letter: `ab` is saved; `a`, `-`, `&`, `.`, accents and `< > \ ' " *` answer `400 VALIDATION_FAILED` (the column CHECK `^[A-Za-z0-9][A-Za-z0-9 .&-]{1,21}$` is looser) |
| `POST …/stripe-connect/start`, `POST /v1/payment-connections/stripe-connect/callback` | Reuse the `state` | Step-up, `own_stripe`; state kept 10 min in `stripe:oauth:<sha256>`; second use refused |
| `PUT …/payment-connections/{environment}/api-keys`, `POST …/use-velexis` | Test keys for live | Verified by the worker; webhook URL `<PUBLIC_OTA_API_URL>/webhooks/stripe/c/<ppc_id>`; use-velexis is owner only |

### Billing and settlements (portal) — `repo:platform/backend/src/billing`, `repo:platform/backend/src/settlements`

| Endpoint | Try | Should happen |
|---|---|---|
| `GET …/subscription`, `GET …/invoices` | As agent | Owner and finance only (`403` for agents) |
| `POST …/billing/checkout-session` (`Idempotency-Key`), `…/portal-session` | Switch off | `403 FEATURE_DISABLED` before M5; Stripe URLs with it on |
| `GET/PUT …/payout-account` ([[payout-account]]) | Invalid IBAN; read back | Step-up and `settlements` switch to set; reads masked (last4 only); any change resets review to `pending_review` |
| `GET …/settlements`, `…/{settlementId}`, `…/lines.csv` | CSV download | Owner/finance; CSV matches the totals |

### Admin — `repo:platform/backend/src/admin`

| Group | Endpoints | Try / should happen |
|---|---|---|
| Admin auth | `POST /v1/admin/auth/sign-in`, `/mfa/verify`, `/refresh`, `/step-up`, `/sign-out`, `GET /v1/admin/me` | A portal token is refused and vice versa; a non-admin gets the same failure as a wrong password; admin families end after 12 h |
| Dashboard | `GET /v1/admin/dashboard` | `tenantsByStatus`, `provisioningFailed24h`, `jobsFailedByQueue`, `officePool`, `liveOfficeRequests`; M5 counters `null` while switched off; `503` if Redis is down |
| Tenants | `GET /v1/admin/tenants`, `GET/PATCH …/{tenantId}`, `POST …/suspend`, `…/resume`, `…/migrate`, `…/connections/{kind}/{environment}/status` | [[suspension]] with reason 5-500 characters (blank → `400`); `billing` refused as suspension reason; migrate queues `tenant.migrate` |
| Provisioning jobs | `GET /v1/admin/provisioning-jobs`, `GET …/{jobId}`, `POST …/retry`, `…/cancel` | Retry only `failed` (new job), cancel only `queued`; no ciphertext ever in answers |
| Queues | `GET /v1/admin/queues`, `GET …/{queue}/failed`, `POST …/{queue}/jobs/{jobId}/retry` | Both backends' queues listed; retry only platform queues; audit `queue_job.retried` |
| Billing | `GET/POST /v1/admin/plans`, `PATCH …/{planCode}`, `POST …/check-prices`, `GET /v1/admin/subscriptions`, `GET/PATCH …/{subscriptionId}`, `POST …/resync`, `GET /v1/admin/invoices`, `GET /v1/admin/stripe-events`, `POST …/{eventId}/reprocess` | Price warnings stored in `plans.price_warnings`; [[manual-subscription]] edit (status, plan, trial end, reason); reprocess `failed`/`ignored` events |
| Amadeus | `GET/POST /v1/admin/amadeus-accounts`, `PATCH …/{accountId}`, `POST …/verify`, `GET/POST /v1/admin/amadeus-offices`, `PATCH …/{officeRowId}`, `POST …/assign`, `…/release`, `…/retire` | See the [[amadeus-office]] lifecycle; base URL must be an official https host in production |
| Settlements | `GET /v1/admin/settlements`, `POST …/generate`, `GET …/{id}`, `…/lines`, `…/lines.csv`, `POST …/adjustments`, `…/approve`, `…/mark-paid`, `…/void`, payout `GET …/tenants/{tenantId}/payout-account`, `POST …/reveal`, `…/review` | Approve/mark-paid need step-up and `If-Match`; reveal is step-up and audited |
| Domains | `GET /v1/admin/domains`, `POST …/{domainId}/recheck`, `…/remove` | Abuse removal sends `domain.removed`; frees the host |
| Accounts | `GET /v1/admin/accounts`, `GET …/{accountId}`, `POST …/disable`, `…/enable`, `…/unlock`, `…/reset-mfa`, `GET/POST /v1/admin/admins`, `DELETE …/{accountId}` | Never disable yourself (`403 self`) or the last admin (`403 last_admin`); reset-mfa refused for admins; grant needs verified + active + MFA; an account locked out now shows as status `locked` with its `lockedUntil`, and `?status=locked` finds it until `lockedUntil` has passed (see the bug-hunt below) |
| Audit | `GET /v1/admin/audit-log`, `GET /v1/admin/audit-log.csv` | Every admin change, sign-in and sensitive read (payout reveal, CSV export `audit.exported`) has a row (`actor_type = platform_admin`); plain list and detail reads have none |

### Webhooks, internal and health

| Endpoint | Try | Should happen |
|---|---|---|
| `POST /webhooks/stripe/billing`, `/webhooks/stripe/connect-accounts` | Tampered body; `stripe listen` events | `400 WEBHOOK_SIGNATURE_INVALID`; valid events stored in `stripe_events` (the [[stripe-event-inbox]]) and answered `200` even if Redis is down |
| `GET /internal/tls/ask?domain=` | From loopback vs through Caddy | `200` only for allowed hosts; `404 NOT_FOUND` when the request came through Caddy (`X-Forwarded-For`), as if the route did not exist |
| `GET /health/live`, `GET /health/ready` | Stop Redis | Live stays `200`; ready `503` with `redis: down` |

### CLI and schedules

| Command (`node platform/backend/dist/cli.js …`) | Does |
|---|---|
| `dev:seed` | Development data above; refused with `APP_ENV=production` |
| `admin:grant <email> [--operator]` | Platform admin for a verified, active account with MFA; audit `admin.granted` |
| `admin:reset-mfa <email>` | Emergency MFA reset of an admin: MFA off, sessions revoked, `staffdeny:` written |
| `secrets:rewrap [--dry-run] [--batch-size n]` | Moves every ciphertext to the current master key ([[envelope-encryption]]) |
| `tenants:create-demo <email> --country --currency --time-zone` | The [[demo-ota]] |

[[maintenance-schedule]]s (UTC, `repo:platform/backend/src/common/queues/scheduler.registry.ts`): `provisioning.reconcile`
and `api_keys.flush_usage` every 5 min, `invitations.expire` hourly at :05, `provisioning.purge_reveals` hourly at
:35, `purge.daily` 02:50, `amadeus.pool_level` 06:55; with switches: `domains.verify_pending` every 5 min,
`domains.recheck_verified` 04:10, `domains.tls_probe` 04:40, `stripe_events.sweep` every 5 min,
`billing.abandoned_checkouts` 03:20, `billing.manual_trials` 08:10, `settlements.monthly` 05:00 on day 3. Plus
`email.sweep` (every minute) and `credentials.sweep` (every 5 min) on their own queues.

## How to …

### Sign up, verify and secure an account

```diagram
flow-sign-up-and-verify
```

### Create an OTA and watch it provision

1. Start the OTA worker as well (`pnpm --filter @velexis/ota-backend dev`). Without it the `tenant.provision` message
   waits in `ota-tenant-ops` and the job stays `running`: every 15 minutes the [[reconciler]] sees the message still
   waiting and only extends the lease (an `ops.alert` "stuck" e-mail after the second lease). Start the OTA worker
   and it picks the message up.
2. Create the OTA in the portal or with `POST /v1/tenants` and an `Idempotency-Key`.
3. Poll `GET /v1/tenants/{tenantId}/provisioning` and watch the [[post-step]]s.

```diagram
flow-create-ota
```

### Manage API keys

```diagram
flow-api-keys
```

### Invite a member and open the console

```diagram
flow-team-and-console
```

### Add a custom domain

```diagram
flow-custom-domain
```

### Go live

Go-live switches the [[storefront-environment]] from `test` to `live` for good.

```diagram
flow-go-live
```

### Pay for a plan with Stripe Checkout (M5)

With `FEATURE_STRIPE_BILLING` on, [[stripe-billing]] replaces the manual trial of earlier OTAs.

```diagram
flow-billing-checkout
```

### Set up the Amadeus pool, suspend an OTA, review a settlement (admin)

```diagram
flow-amadeus-pool
```

```diagram
flow-admin-suspend-resume
```

```diagram
flow-settlement-review
```

## Roles and permissions

Access is decided in this order: [[operation-scope]] guard → [[mandatory-mfa]] → [[tenant-role]] → [[feature-switch]]
→ [[step-up]] → body validation. The role matrix is plain data in
`repo:platform/backend/src/memberships/tenant-roles.ts`.

| Action | owner | admin | finance | agent | viewer |
|---|---|---|---|---|---|
| Overview, onboarding, members list, open console, leave | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit profile, API keys, domains | ✓ | ✓ | | | |
| See connections (masked) | ✓ | ✓ | ✓ | | |
| Change connections, enter credentials (step-up) | ✓ | ✓ | | | |
| Invite / manage agent, finance, viewer | ✓ | ✓ | | | |
| Grant or remove owner/admin (owner grant: step-up) | ✓ | | | | |
| Subscription and invoices (read) | ✓ | | ✓ | | |
| Choose plan, Customer Portal | ✓ | | | | |
| Settlements and payout account (read) | ✓ | | ✓ | | |
| Set payout account, go-live, retry setup, reveal keys, live Amadeus request, use Velexis payments | ✓ | | | | |

What a refusal looks like:

| Situation | Answer |
|---|---|
| Not a member of the OTA (or unknown id) | `404 NOT_FOUND` - never reveals that the OTA exists |
| Member with the wrong role | `403 FORBIDDEN` |
| Unverified e-mail on a `portal` operation | `403 EMAIL_NOT_VERIFIED` |
| Owner/admin of a live OTA without MFA | `403 MFA_REQUIRED` with `details.reason = enrolment_required` |
| Switch off | `403 FEATURE_DISABLED` (before the step-up check) |
| Step-up older than 15 minutes / no MFA | `401 REAUTH_REQUIRED` / `403 MFA_REQUIRED` |
| Disabled account with a valid token | `401 UNAUTHENTICATED` at once |
| Portal token on an admin route, or admin token on a portal route | `401` |

A [[platform-admin-account]] is an account with `is_platform_admin`; the admin guard re-reads that flag and the status
on every request.

## Bug-hunting checklist

```bug-hunt
**Tenancy and roles.** For every `/v1/tenants/{tenantId}/…` call, try another OTA's id: expect `404`, never `403`
and never data. Downgrade a member while their portal tab is open: the next call must follow the new role (the guard
reads `tenant_memberships` on every request, no cache). Remove the last owner: `409 LAST_OWNER`.
```

```bug-hunt
**Provisioning.** After `createTenant` check the six rows:
`select t.status, t.storefront_environment, j.status, j.attempt, j.step from platform.tenants t join platform.provisioning_jobs j on j.tenant_id = t.id where t.key = 'acme';`
`select hostname, is_primary, verification_status from platform.tenant_domains where tenant_id = '<ten_…>';`
`select office_id, status from platform.amadeus_offices where assigned_tenant_id = '<ten_…>';`
Stop the OTA worker: the job stays `running` and the reconciler extends its lease while the BullMQ message is still
waiting or active (`ops.alert` "stuck" after two leases). Only a lost attempt (message missing or failed without an
answer) is retried with backoff (30 s × 2^attempt); after 5 attempts the job and the tenant are `failed`, with an
`ops.alert` and `tenant.provisioning_failed`. Retry must create a new job row, not reuse the failed one.
```

```bug-hunt
**The OTA limit on retry.** `createTenant` counts only the caller's non-`failed` OTAs, so a failed OTA frees its slot;
`retryProvisioning` counts again for every owner of the OTA, under the owners' account locks, before it reopens it.
With the default `MAX_TENANTS_PER_ACCOUNT=3`: let OTA A fail, create B, C and D, then retry A: `422 UNPROCESSABLE
tenant_limit`, as `createTenant` answers, and A stays `failed` with no new job
(`repo:platform/backend/src/provisioning/lifecycle.service.ts#L438`). The platform admin's job retry still reopens A:
it is exempt from the limit (a deliberate staff action, scope PF-10). Billing sync also reopens A when its owner pays
its Checkout, whatever the owners own (lead decision (37i): refusing would leave a paid subscription on a failed OTA).
```

```bug-hunt
**Locked accounts and reserved statuses.** The sign-in lockout writes `accounts.locked_until` and leaves `status` alone.
The admin shows a `pending_verification` or `active` account whose `locked_until` is in the future as `locked`, and
`GET /v1/admin/accounts?status=locked` finds exactly those; it stops finding them once `locked_until` has passed, and
Active and Not verified leave them out. Lock an account with 5 wrong passwords and check the Locked filter and the
badge's until time. `accounts.status` `locked`/`deleted`, `tenants.status` `deprovisioning`/`deleted`,
`tenant_memberships.status` `suspended`, `supplier_connections.status` `invalid_credentials`,
`payment_provider_connections.status` `error`, `email_outbox.status` `canceled` and every
`tenant_schema_migrations.status` except `applied` are reserved (data-model §6): no code writes them and no admin
filter offers them.
```

```bug-hunt
**Sessions and MFA.** Reuse a refresh token after it was rotated: the whole family must be revoked
(`select id, revoked_at, revoke_reason from platform.account_sessions where family_id = '<asn_…>';`). Use one TOTP
code twice within 90 s: the second must fail. Sign out everywhere, then try the OTA console: refused, because
`staffdeny:acct:<id>` exists (`redis-cli -a dev_redis get staffdeny:acct:acc_…`). Lock an account with 5 wrong
passwords and check `failed_login_count`, `locked_until`; `adminUnlockAccount` must clear both.
```

```bug-hunt
**Idempotency.** Send `POST /v1/tenants` twice with the same `Idempotency-Key` and body: one tenant, the same `202`.
Same key, different body: `409 IDEMPOTENCY_KEY_REUSED`. Two parallel requests with one key: only one handler runs
(`redis-cli -a dev_redis keys 'vx:idem:*'`). With Redis stopped: `503`, nothing written.
```

```bug-hunt
**E-mails (Mailpit).** Each of these must arrive exactly once: `auth.verify_email`, `auth.account_exists`,
`auth.password_reset`, `auth.password_changed`, `auth.mfa_changed`, `team.invitation`, `tenant.welcome`,
`tenant.provisioning_failed`, `tenant.suspended`, `tenant.resumed`, `ops.alert`, and with M5 switches
`domain.verified`, `domain.failed`, `domain.removed`, `billing.payment_failed`, `billing.trial_ending`,
`billing.trial_ended`, `payouts.reviewed`, `settlement.paid`, `connection.stripe_disconnected`,
`connection.credentials_applied`, `connection.credentials_failed`, `amadeus.live_ready`. Links must start with
`PUBLIC_PORTAL_URL` / `PUBLIC_PLATFORM_ADMIN_URL`. In the DB: `select template, status, attempts, last_error,
secrets_purged_at from platform.email_outbox order by created_at desc limit 20;` - sent or failed rows must have
`secret_payload_ciphertext` null. Stop Mailpit: no request fails; each send attempt puts the row back to `pending`
with `last_error`, and after 5 attempts (about 7.5 minutes: 30 s, 60 s, 120 s, 240 s) the row is `failed` for good
and is not sent when Mailpit returns.
```

```bug-hunt
**Queues.** Failed jobs per queue: `redis-cli -a dev_redis zcard vx:platform-emails:failed` (likewise
`platform-tenant-events`, `platform-stripe-events`, `platform-domains`, `platform-connections`,
`platform-settlements`, `platform-maintenance`, `ota-tenant-ops`). The admin dashboard and `GET /v1/admin/queues`
must show the same numbers. Job payloads must hold ids only - never a token, secret or e-mail address.
```

```bug-hunt
**Cache invalidation.** Every change the OTA side caches must publish on `vx:invalidate`: run
`redis-cli -a dev_redis subscribe vx:invalidate` and suspend an OTA (`tenant`), revoke a key (`api_key`), change a
role (`membership`), disable an account (`account`), switch a connection (`connection`), verify or remove a domain
(`domain`), change a plan's limits (`plan`), retire an office (`amadeus_account`). A missing event means the OTA
side serves stale data for up to 60 s.
```

```bug-hunt
**Billing and money (M5).** Status rules: `past_due` sets `tenants.billing_notice` ([[billing-notice]]), `canceled`/`unpaid` suspend an
active OTA with reason `billing`, paying again resumes it - but never an `abuse`/`admin` suspension. Check
`select id, type, status, attempts, last_error from platform.stripe_events order by received_at desc;`. Amounts are
`numeric(12,2)` plus a currency; settlement adjustments must refuse more decimals than the currency has (JPY 0, KWD 3).
Trial dates are UTC calendar days: test a trial ending around midnight UTC.
```

```bug-hunt
**Domains and TLS.** `curl 'http://127.0.0.1:3100/internal/tls/ask?domain=acme.ota.example.com'` → `200` for a
provisioning/active/suspended OTA; a random host → refused; `redis-cli -a dev_redis keys 'tlsask:*'` holds only
positive answers. After `removeDomain`, the `tlsask:<host>` key must be gone. Add a host under
`PUBLIC_OTA_API_URL`'s domain: `422 DOMAIN_INVALID`.
```

```bug-hunt
**Secrets and audit.** No password, token, TOTP secret, IBAN or Stripe key may appear in logs, `platform_audit_log.details`,
Redis or queue payloads. Every state change must have its audit row in the same transaction:
`select action, actor_type, target_type, target_id, created_at from platform.platform_audit_log order by id desc limit 20;`
(the table is append-only for the app role).
```

```bug-hunt
**Rate limits.** Sign-up 5/h per IP, sign-in 10/min per IP, MFA 10/10 min per account, reset/resend 3/h per address
and 10/h per IP, invitation lookup 20/h per IP, key availability and console token 30/min per account, domain check
1/min per domain, everything else 300/min per account. Over the limit: `429 RATE_LIMITED` with `Retry-After`.
Counters live in `rl:<throttler>:<sha256>` keys.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Process exits at start with `config.invalid` | Missing or invalid variable (key file mode must be 0400/0600) | Read the named variables; re-run `pnpm dev:keys` |
| `/health/ready` `503` | PostgreSQL or Redis down | Start the service; the report names it |
| `dev:seed` exits 1, account `pending_verification` | Amadeus stub not running | `pnpm stub:amadeus`, run `dev:seed` again |
| OTA stays `provisioning` | OTA worker not running, or M5 Checkout not paid | Start the OTA worker; check `provisioning_jobs.status`/`error`; with billing on, finish the Checkout |
| No e-mails | Mailpit down or the worker not running | Rows wait `pending` in `email_outbox`; start both |
| Every portal user shares one rate limit | `PLATFORM_BFF_KEY` differs between portal and API | Use the same value in all `.env.local` files |
| `403 FEATURE_DISABLED` | Milestone switch off | Set `FEATURE_*=true` in `.env.local`, restart API and worker |
| `503 SERVICE_UNAVAILABLE` on sign-in MFA, console token, create OTA | Redis down | Start Redis; idempotent creates and tokens need it |
| Webhook `400 WEBHOOK_SIGNATURE_INVALID` locally | `STRIPE_BILLING_WEBHOOK_SECRET` is not the one `stripe listen` printed | Copy the `whsec_…` from `stripe listen` into `.env.local` |
