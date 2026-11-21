---
id: architecture
title: Platform API — architecture guide
summary: How the NestJS control plane is built - processes, layered modules, the request pipeline, the platform schema, queues and Redis keys, key flows, every lifecycle, integrations, security, configuration, tests and where to change things.
---

## At a glance

| Item | Value |
|---|---|
| Package | `@velexis/platform-backend` in `repo:platform/backend` |
| Runtime | Node.js 24, TypeScript 5.6 strict, CommonJS output in `dist/` |
| Framework | NestJS 11 on Express 5, `nestjs-pino`, `nestjs-cls`, `@nestjs/bullmq`, `@nestjs/throttler` |
| Entry points | API `repo:platform/backend/src/main.ts` (`AppModule`, `repo:platform/backend/src/app.module.ts`); worker `repo:platform/backend/src/worker.ts` (`WorkerModule`, `repo:platform/backend/src/worker.module.ts`); CLI `repo:platform/backend/src/cli.ts` |
| Ports | API `127.0.0.1:3100`; worker health `127.0.0.1:3101`; public host `https://api.platform.example.com` through Caddy (`/internal/*` blocked) |
| Contract | `repo:platform/backend/openapi/velexis-platform-api.openapi.yaml` (OpenAPI 3.1, 144 operations, validated at runtime) |
| Data | PostgreSQL 16 schemas `platform` (owned) and `reference` (read), role `velexis_platform_app`; Redis 7 |
| systemd | `velexis-platform-api.service`, `velexis-platform-worker.service` |
| Build / test | `pnpm --filter @velexis/platform-backend build` · `test` · `test:int` · `test:xb` (after building the OTA backend) |

The API never runs long jobs: it writes rows, commits, then enqueues. The worker never serves HTTP except health. Both
validate the whole configuration at start (`repo:platform/backend/src/config.ts`) and exit 1 naming every bad
variable.

## Components

```diagram
components
```

Modules are layered; a module imports only lower layers, and cross-module use cases live in `ProvisioningModule`
(`repo:platform/docs/architecture.md` §2).

| Layer | Module (folder) | Owns (writes) | Job |
|---|---|---|---|
| 0 | `CommonModule` (`src/common/`) | `stripe_events`, `credential_submissions` | Guards, interceptors, error filter, Clock, ids, Redis, Stripe client, [[vx-invalidate]] publisher, idempotency, Stripe inbox, schedules |
| 0 | `AuditModule` (`src/audit/`) | `platform_audit_log` | `AuditService.record(trx, …)` in the caller's transaction; queries and CSV ([[audit-log]]) |
| 0 | `NotificationsModule` (`src/notifications/`) | `email_outbox` | [[outbox]] in the caller's transaction, Handlebars templates, SMTP sending |
| 0 | `HealthModule` (`src/health/`) | — | `/health/live`, `/health/ready` |
| 1 | `AuthModule` (`src/auth/`) | `accounts` (credentials), `account_sessions`, `account_tokens`, `account_recovery_codes` | Sign-up, verify, sign-in, MFA challenge, refresh, reset, step-up, JWT signing |
| 1 | `AccountsModule` (`src/accounts/`) | `accounts` (profile, MFA) | `me`, password change, MFA set-up, recovery codes, sessions |
| 1 | `TenantsModule` (`src/tenants/`) | `tenants` | Key rules and availability, profile, lists, demo OTA command |
| 1 | `MembershipsModule` (`src/memberships/`) | `tenant_memberships`, `tenant_invitations` | Members, role matrix, invitations, console token |
| 1 | `ApiKeysModule` (`src/api-keys/`) | `api_keys` | Generate, create, roll, revoke, usage flush |
| 1 | `DomainsModule` (`src/domains/`) | `tenant_domains` | Sub-domain, custom domains, DNS checks, TLS probe, [[on-demand-tls]] ask |
| 1 | `SupplierConnectionsModule` (`src/supplier-connections/`) | `amadeus_accounts`, `amadeus_offices`, `supplier_connections` | [[velexis-amadeus-account]], [[office-pool]], tenant connections, verification |
| 1 | `PaymentConnectionsModule` (`src/payment-connections/`) | `payment_provider_connections` | Velexis mode, [[stripe-connect-standard]], API-key mode, Connect events |
| 1 | `BillingModule` (`src/billing/`) | `plans`, `billing_customers`, `billing_customer_attempts`, `subscriptions`, `invoices` | Plans, Stripe Billing gateway, Checkout, Customer Portal |
| 1 | `SettlementsModule` (`src/settlements/`) | `settlements`, `settlement_lines`, `tenant_payout_accounts` | Statement generation, review, payout accounts |
| 2 | `ProvisioningModule` (`src/provisioning/`) | `provisioning_jobs`, `tenant_schema_migrations` | Create OTA, dispatch, tenant events, [[post-step]]s, [[reconciler]], retry, migrate, suspend, resume, go-live, onboarding |
| 3 | `BillingSyncModule` (`src/billing/sync/`) | via billing repositories | Webhook receiver, event processing, status rules, billing schedules |
| 4 | `AdminModule` (`src/admin/`) | — | Thin `/v1/admin/**` controllers, dashboard, queue inspector, admin CLI |

Inside a module: `*.controller.ts` (HTTP only, bound to an `operationId` with `@OpenApiOperation`), `*.service.ts`
(use case and transaction), `*.repository.ts` (Kysely on `platform.*`), `*.mapper.ts`, `*.processor.ts` (BullMQ),
`*.gateway.ts` (Stripe, Amadeus, DNS, SMTP). External calls never run inside an open transaction.

## Data

```diagram
platform-er
```

- **Schemas.** This app owns and migrates `platform` (`repo:platform/backend/migrations/platform`: `0001_baseline.sql`,
  `0002_add_mvp_platform_deltas.sql`, `0003_add_billing_customer_attempts.sql`, `0004_add_plan_price_warnings.sql`,
  repeatable `R__ota_read_access.sql`) and the structure of `reference` (`repo:platform/backend/migrations/reference`;
  data loaded by `pnpm db:seed:reference`). It reads `reference.currencies`, `countries`, `time_zones`. It has **no**
  privilege on tenant schemas - `tenantTx` belongs to the OTA backend. Generated Kysely types:
  `repo:packages/db/src/generated/platform.ts` (`pnpm db:codegen`).
- **OTA read access.** `velexis_ota_app` may `SELECT` `tenants`, `tenant_domains`, `api_keys`,
  `api_key_tenant_grants`, `tenant_memberships`, `plans`, `supplier_connections`, `payment_provider_connections`,
  `amadeus_accounts`, `amadeus_offices` and ten columns of `accounts`; nothing else (billing, settlements, sessions,
  tokens, outbox, events, submissions stay private).
- **Conventions.** Ids are `<prefix>_<ULID>` (`acc_`, `ten_`, `job_`, `key_`, `eml_`, `stl_`…,
  `repo:platform/backend/src/common/ids.ts`); statuses are `text` + `CHECK` lists; money is `numeric(12,2)` +
  `char(3)` currency, computed with decimal.js; mutable aggregates carry `version` (PATCH takes `If-Match`); every
  state change writes its audit row **in the same transaction** and publishes invalidations and enqueues jobs
  **after** the commit (`runInTransaction` of `repo:platform/backend/src/common/redis/invalidation.publisher.ts`).
- **Secrets at rest.** [[envelope-encryption]] with associated data `platform.<table>.<column>:<row id>`: MFA secrets,
  Amadeus client secrets, Stripe keys, bank details, e-mail secret links, the one-time key reveal.

Queues ([[bullmq]] prefix `vx`, defaults 5 attempts, exponential backoff from 30 s, failed kept 30 days, completed 1 day;
`repo:platform/backend/src/common/queues/queue-names.ts`):

| Queue | Producer → consumer | Jobs | Concurrency |
|---|---|---|---|
| [[ota-tenant-ops]] | API, worker → OTA worker | `tenant.provision`, `tenant.migrate`, `tenant.suspend`, `tenant.resume` | OTA side |
| [[platform-tenant-events]] | OTA worker → worker | `tenant.provisioned`, `tenant.provision_failed`, `tenant.migrated`, `tenant.migration_failed`, `tenant.suspended`, `tenant.resumed` | 4 |
| `platform-emails` | API, worker → worker | `email.send {emailId}`, `email.sweep` (every minute: `pending` rows older than 2 min and `sending` rows unchanged for 10 min whose job is missing or finished) | 4 |
| `platform-stripe-events` | Webhook receivers → worker | `stripe.event` (job id = Stripe event id) | 2 |
| `platform-domains` | API, schedules → worker | `domain.verify`, `domain.recheck`, `domain.tls_probe` | 4 |
| `platform-connections` | API, admin → worker | `amadeus_account.verify`, `credentials.verify`, `credentials.sweep` | 2 |
| `platform-settlements` | Schedule, admin → worker | `settlement.generate {periodStart, tenantId?}` | 1 |
| `platform-maintenance` | Schedules → worker | Every [[maintenance-schedule]] of `scheduler.registry.ts` | 1 |

Redis keys (`repo:platform/backend/src/common/redis/redis-keys.ts`; every key has a TTL because Redis runs
`noeviction`):

| Key | TTL | Purpose |
|---|---|---|
| `ptk:<sha256>` | 60 s | [[portal-token]] for the OTA admin SSO; the OTA API takes it with `GETDEL` |
| `staffdeny:acct:<accountId>` | 30 days | [[staff-deny-cut-off]]: OTA staff families older than it are revoked |
| `apikey:used:<keyId>` | 1 day | Last use written by the OTA API, flushed into `api_keys` every 5 min |
| `vx:idem:<accountId>:<key>` (+ `:lock`, 10 s) | 24 h | [[idempotency-key]] store and lock |
| `vx:stripe:sub:<sub_…>:lock` | 15 s, renewed | One Stripe subscription synced at a time |
| `mfach:<sha256>` (+ `:attempts`) | 5 min | MFA sign-in challenge |
| `mfasetup:<accountId>` | 10 min | Pending TOTP secret (encrypted) |
| `mfastep:<accountId>` | 90 s | Last TOTP step used, so a code works once |
| `stripe:oauth:<sha256>` | 10 min | Connect OAuth `state` |
| `tlsask:<host>` | 60 s | Positive TLS ask answers only |
| `rl:<throttler>:<sha256>` | window | Rate-limit counters |
| channel `vx:invalidate` | — | `{v:1, type, …ids}` for `tenant`, `domain`, `api_key`, `connection`, `membership`, `account`, `amadeus_account`, `plan` |

## Key flows

Every `/v1/**` request passes the same pipeline:

```diagram
seq-request-pipeline
```

Sign-in, MFA challenge, refresh rotation and the step-up:

```diagram
seq-sign-in-mfa
```

Creating an OTA, then provisioning it with the OTA worker:

```diagram
seq-create-tenant
```

```diagram
seq-provisioning
```

Stripe Billing events and their effect on the OTA:

```diagram
seq-billing-webhook
```

Opening the OTA admin console from the portal:

```diagram
seq-console-token
```

Custom domain verification and Caddy's TLS gate:

```diagram
seq-domain-tls
```

Own credentials (Amadeus or Stripe API keys) and their verification:

```diagram
seq-credential-submission
```

Admin suspension and resume:

```diagram
seq-suspend-resume
```

## Lifecycles

The OTA and its jobs:

```diagram
tenant-states
```

```diagram
storefront-environment-states
```

```diagram
provisioning-job-states
```

Identity: accounts, sessions, memberships, invitations, API keys.

```diagram
account-states
```

```diagram
session-states
```

```diagram
membership-states
```

```diagram
invitation-states
```

```diagram
api-key-states
```

Billing: subscriptions, invoices, the Stripe inbox, the e-mail outbox.

```diagram
subscription-states
```

```diagram
invoice-states
```

```diagram
stripe-event-states
```

```diagram
email-outbox-states
```

Domains and TLS:

```diagram
domain-verification-states
```

```diagram
tls-states
```

Connections: the Velexis Amadeus account, its offices, tenant connections and credential submissions.

```diagram
amadeus-account-states
```

```diagram
amadeus-office-states
```

```diagram
supplier-connection-states
```

```diagram
payment-connection-states
```

```diagram
credential-submission-states
```

Settlements:

```diagram
payout-account-states
```

```diagram
settlement-states
```

## Integrations

| With | How | Contract / code |
|---|---|---|
| Portal, platform admin | REST on loopback, Bearer JWT, PADR-0019 headers | `repo:platform/backend/openapi/velexis-platform-api.openapi.yaml`; generated `repo:packages/api-types/src/generated/platform.ts` |
| OTA worker | BullMQ `ota-tenant-ops` / `platform-tenant-events`; messages carry ids only (`v`, `jobId`, `tenantId`, `requestedAt`, `requestId`), BullMQ id `<jobId>-<attempt>` | `repo:packages/api-types/src/jobs/tenant-ops.ts`, `repo:packages/api-types/src/jobs/tenant-events.ts` |
| OTA API | Read-only platform tables (cached 60 s), `vx:invalidate`, `ptk:`, `staffdeny:`, `apikey:used:` | `repo:packages/api-types/src/jobs/invalidation.ts` |
| Stripe (Velexis account) | Billing (customers, Checkout, Customer Portal, subscriptions, invoices), Connect OAuth and account retrieval, balance transactions, key checks; pinned `apiVersion`, idempotency key `<purpose>:<row id>` on every POST, 10 s timeout; webhooks verified on the raw body, stored before processing | `repo:platform/backend/src/common/stripe/stripe.client.ts`, `repo:platform/backend/src/billing/stripe-billing.gateway.ts` |
| Amadeus | `POST {baseUrl}/v1/security/oauth2/token` only, to verify credentials; token discarded | `repo:platform/backend/src/supplier-connections/amadeus-oauth.gateway.ts` |
| DNS | `node:dns` Resolver on `DNS_RESOLVERS`, never the VM's resolver | `repo:platform/backend/src/domains/dns.gateway.ts` |
| SMTP | Nodemailer, no pooling, 10 s/30 s timeouts; Mailpit locally | `repo:platform/backend/src/notifications/mailer.gateway.ts` |
| Caddy | `GET /internal/tls/ask?domain=` on loopback; forwards `/webhooks/stripe/*` | `repo:platform/backend/src/domains/tls-ask.controller.ts` |

## Security

- **Tokens.** EdDSA JWTs (15 min, `kid` header) signed with `JWT_PRIVATE_KEY_FILE`; audiences `portal` and
  `platform_admin` never mix; claims `sub`, `sid` (family), `ev`, `amr`, `mfa_at`. During a key rotation tokens of the
  previous key verify through `JWT_PREVIOUS_PUBLIC_KEY_FILE`. Opaque refresh tokens are hashed in `account_sessions`
  and rotated on use ([[refresh-family]], reuse revokes the family). The API sets no cookies; the Next.js apps do.
- **Guards** by [[operation-scope]]: `PortalAuthGuard` and `AdminAuthGuard` re-read the account (and admin flag) on
  every request; `InternalOnlyGuard` answers `404` unless the request is from loopback without `X-Forwarded-For`;
  `StripeSignatureGuard` checks the raw body. Then [[mandatory-mfa]], `TenantRoleGuard` (`404` for non-members),
  `FeatureGuard`, `RecentMfaGuard` ([[step-up]], 15 min). Code: `repo:platform/backend/src/common/auth`. Three step-ups
  are conditional and checked in the service, so `x-mfa-step-up` does not mark them: a live secret key
  (`createApiKey`, `rollApiKey`), granting `owner` (`updateMember`) and new Amadeus credentials
  (`adminUpdateAmadeusAccount`).
- **Passwords.** Argon2id; at least 12 characters with a letter and a digit, not on the bundled breached list
  (`repo:platform/backend/src/auth/password-policy.ts`); [[account-lockout]] after 5 failures for 15 minutes; the
  same answer and work for unknown addresses.
- **BFF trust.** The end user's IP and user agent are honoured only from loopback with a matching [[bff-key]]
  (`X-Velexis-Bff-Key`, constant-time compare); otherwise `req.ip` (`trust proxy` loopback).
- **Rate limits** in Redis (`repo:platform/backend/src/common/http/throttler.config.ts`); while Redis is down the
  specific limits refuse with `503`, the general one lets requests through.
- **No secrets in logs, jobs or audit rows**: tokens, passwords, TOTP secrets, recovery codes, Stripe keys, IBANs and
  e-mail links are on the `@velexis/logger` redaction list; secret e-mail variables travel only encrypted in the outbox.
- **Admin.** MFA mandatory, refresh families of 12 h (refresh tokens idle 2 h), every change, sign-in and sensitive read
  (payout reveal, audit export) audited with `actor_type = platform_admin` (plain reads are not); sensitive admin
  operations need a step-up, some only conditionally (new Amadeus host or credentials on `adminUpdateAmadeusAccount`).
- **PCI.** The platform never handles card data; Stripe Checkout and the Customer Portal are redirects.

## Configuration

Validated by `repo:platform/backend/src/config.ts`; example in `repo:platform/backend/.env.example` (dummy values).
On the VM both processes read `/etc/velexis/platform-backend.env`; the worker may add `/etc/velexis/platform-worker.env`.

| Variable | Purpose |
|---|---|
| `APP_ENV`, `LOG_LEVEL`, `PORT` (3100), `HEALTH_PORT` (3101), `TRUST_PROXY` | Process basics |
| `DATABASE_URL` (app role), `DATABASE_MIGRATOR_URL` (migrations only), `REDIS_URL` | Data stores |
| `MASTER_KEY_DIR`, `MASTER_KEY_CURRENT` | Key-encryption keys of envelope encryption |
| `API_KEY_PEPPER_FILE` | HMAC pepper for API keys (identical copy on the OTA side) ([[api-key-pepper]]) |
| `JWT_PRIVATE_KEY_FILE`, `JWT_PREVIOUS_PUBLIC_KEY_FILE` | Token signing and rotation |
| `PLATFORM_BFF_KEY` | Shared first-party key of the portal and admin servers |
| `SMTP_URL`, `MAIL_FROM`, `OPS_ALERT_EMAIL` | E-mail |
| `PUBLIC_PORTAL_URL`, `PUBLIC_PLATFORM_ADMIN_URL`, `PUBLIC_OTA_ADMIN_URL`, `PUBLIC_OTA_API_URL` | Links, redirects, SSO target, own-Stripe webhook URL; Velexis hosts no OTA may claim |
| `STOREFRONT_BASE_DOMAIN`, `STOREFRONT_IPV4`, `STOREFRONT_IPV6`, `DNS_RESOLVERS` | Sub-domains, apex records, verification resolvers |
| `AMADEUS_BASE_URL_TEST`, `AMADEUS_BASE_URL_LIVE` | Hosts to verify OTA-owned credentials (official hosts only in production) |
| `STRIPE_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET` | Velexis Stripe account (required while their switches are on) |
| `MAX_TENANTS_PER_ACCOUNT` (3) | Non-failed OTAs per account (createTenant and the owner's retry; the admin's job retry and billing sync's reopen after a paid Checkout are exempt) |
| `FEATURE_STRIPE_BILLING`, `FEATURE_OWN_STRIPE`, `FEATURE_SETTLEMENTS`, `FEATURE_OWN_AMADEUS`, `FEATURE_CUSTOM_DOMAINS`, `FEATURE_LIVE_SWITCH` | Milestone [[feature-switch]]es (default `false`) |
| `SENTRY_DSN` | Not a variable of the platform backend: `config.ts` does not read it, no platform code sends errors anywhere yet (M6), and the env templates no longer list it (KI-043) |

Never in environment variables: the shared Amadeus credentials (encrypted in `amadeus_accounts`), OTA credentials,
MFA secrets.

## Testing

| Level | Where | Run one |
|---|---|---|
| Unit | Next to the code (`src/**/*.test.ts`): key generator, hostname rules, IBAN, settlement formula, role matrix, status rules, tokens | `pnpm --filter @velexis/platform-backend test -- src/domains/hostname-rules.test.ts` |
| Integration | `repo:platform/backend/test/integration` (per module; `security/` holds the auth matrix, rate limits and secrets-at-rest proofs); real PostgreSQL, Redis, Mailpit; Stripe and the OTA worker faked (`repo:platform/backend/test/support/fake-stripe.ts`, `repo:platform/backend/test/support/fake-ota-worker.ts`) | `pnpm --filter @velexis/platform-backend test:int -- test/integration/tenants/tenants.int.test.ts` |
| Contract | `repo:platform/backend/test/contract`: [[route-parity]], OpenAPI document, migrations | part of `test` |
| Cross-backend | `repo:platform/backend/test/cross-backend` (provisioning, API keys, console token with the built OTA worker/API) | `pnpm --filter @velexis/ota-backend build && pnpm --filter @velexis/platform-backend test:xb` |
| End-to-end | `repo:tools/e2e/specs` (`portal-*.e2e.ts`, `admin-*.e2e.ts`, `console-sso.e2e.ts`) | `pnpm test:e2e` (see `repo:tools/e2e/README.md`) |

`createTestApp()` (`repo:platform/backend/test/support/app.ts`) builds the real API with a `FakeClock`, its own
database clone, Redis database and keys. A new operation needs its inventory row (the auth matrix fails otherwise)
and a cached-row mutation needs a row in the invalidation coverage test.

## Where to change things

| To change … | Look at |
|---|---|
| An endpoint's shape, status codes, errors | `repo:platform/backend/openapi/velexis-platform-api.openapi.yaml`, then `pnpm contracts:generate` |
| Error codes and HTTP statuses | `x-error-catalogue` in the OpenAPI document → `repo:packages/errors/src/generated/catalogue.ts`; envelope `repo:packages/errors/src/envelope.ts` |
| Request validation, idempotency, error filter | `repo:platform/backend/src/common/http/openapi-validation.interceptor.ts`, `repo:platform/backend/src/common/http/idempotency.interceptor.ts`, `repo:platform/backend/src/common/http/error.filter.ts` |
| Rate limits | `repo:platform/backend/src/common/http/throttler.config.ts` |
| End-user IP / BFF headers | `repo:platform/backend/src/common/http/request-context.ts`, `repo:platform/backend/src/common/http/end-user.ts` |
| Who may call an operation | `repo:platform/backend/src/memberships/tenant-roles.ts`; guards in `repo:platform/backend/src/common/auth` |
| Feature switches | `repo:platform/backend/src/common/features.ts`, `repo:platform/backend/src/config.ts` |
| Sign-up, verification, sign-in, lockout | `repo:platform/backend/src/auth/sign-up.service.ts`, `repo:platform/backend/src/auth/sign-in.service.ts` |
| Sessions, refresh, step-up, tokens | `repo:platform/backend/src/auth/sessions.service.ts`, `repo:platform/backend/src/auth/token.service.ts`, `repo:platform/backend/src/auth/jwt-keys.ts` |
| Password rules | `repo:platform/backend/src/auth/password-policy.ts`, `repo:platform/backend/src/auth/breached-passwords.txt` |
| MFA set-up, recovery codes | `repo:platform/backend/src/accounts/mfa.service.ts`, `repo:platform/backend/src/auth/mfa-challenge.store.ts` |
| Create OTA, retry, reveal keys | `repo:platform/backend/src/provisioning/lifecycle.service.ts`; key rules `repo:platform/backend/src/tenants/tenant-key.ts` |
| Dispatch, reconciler, failures | `repo:platform/backend/src/provisioning/dispatcher.ts`, `repo:platform/backend/src/provisioning/reconciler.scheduler.ts`, `repo:platform/backend/src/provisioning/failure-handler.ts` |
| Post-steps after provisioning | `repo:platform/backend/src/provisioning/post-steps` |
| Go-live preconditions | `repo:platform/backend/src/provisioning/go-live.service.ts` |
| Suspend, resume, connection switch | `repo:platform/backend/src/provisioning/suspension.service.ts` |
| Onboarding checklist items | `repo:platform/backend/src/provisioning/onboarding.service.ts` |
| Members, invitations, console token | `repo:platform/backend/src/memberships/members.service.ts`, `repo:platform/backend/src/memberships/invitations.service.ts`, `repo:platform/backend/src/memberships/console-token.service.ts` |
| API keys | `repo:platform/backend/src/api-keys/api-keys.service.ts`, `repo:platform/backend/src/api-keys/api-key-generator.ts`, `repo:platform/backend/src/api-keys/api-key-rules.ts` |
| Custom domains, DNS checks, TLS ask | `repo:platform/backend/src/domains/domains.service.ts`, `repo:platform/backend/src/domains/hostname-rules.ts`, `repo:platform/backend/src/domains/domain-checks.ts`, `repo:platform/backend/src/domains/tls-ask.service.ts`, `repo:platform/backend/src/domains/tls-probe.ts` |
| Amadeus pool and connections | `repo:platform/backend/src/supplier-connections/amadeus-offices.service.ts`, `repo:platform/backend/src/supplier-connections/connections.service.ts`, `repo:platform/backend/src/supplier-connections/live-office.service.ts` |
| Credential submissions | `repo:platform/backend/src/common/credentials/credential-submissions.service.ts`, `repo:platform/backend/src/common/credentials/credentials-verify.processor.ts`, `repo:platform/backend/src/common/credentials/credentials-sweep.ts` |
| Stripe Connect, API keys, Velexis mode, descriptor | `repo:platform/backend/src/payment-connections` |
| Plans, Checkout, Customer Portal | `repo:platform/backend/src/billing/plans.service.ts`, `repo:platform/backend/src/billing/checkout.service.ts` |
| Webhook processing and status rules | `repo:platform/backend/src/billing/sync/stripe-events.processor.ts`, `repo:platform/backend/src/billing/sync/status-rules.ts`, `repo:platform/backend/src/billing/sync/handlers` |
| Manual trials, abandoned Checkouts | `repo:platform/backend/src/billing/sync/manual-trials.scheduler.ts`, `repo:platform/backend/src/billing/sync/abandoned-checkouts.scheduler.ts` |
| Settlements and payout accounts | `repo:platform/backend/src/settlements/settlement-generator.ts`, `repo:platform/backend/src/settlements/settlement-formula.ts`, `repo:platform/backend/src/settlements/settlement-review.service.ts`, `repo:platform/backend/src/settlements/payout-accounts.service.ts` |
| E-mail text | `repo:platform/backend/src/notifications/templates` (+ allow-list in `repo:platform/backend/src/notifications/templates.ts`) |
| E-mail sending and retries | `repo:platform/backend/src/notifications/outbox.service.ts`, `repo:platform/backend/src/notifications/email.processor.ts` |
| Audit actions | `repo:platform/backend/src/audit/audit-actions.ts`, `repo:platform/backend/src/audit/audit.service.ts` |
| Admin dashboard, queue views | `repo:platform/backend/src/admin/admin-dashboard.service.ts`, `repo:platform/backend/src/admin/queue-inspector.ts`, `repo:platform/backend/src/admin/admin-jobs.service.ts` |
| Schedules and queues | `repo:platform/backend/src/common/queues/scheduler.registry.ts`, `repo:platform/backend/src/common/queues/queue-names.ts`, `repo:platform/backend/src/common/queues/maintenance.processor.ts` |
| Retention / purge | `repo:platform/backend/src/common/purge.scheduler.ts`, `repo:platform/backend/src/common/purge.repository.ts` |
| Redis keys, invalidation events | `repo:platform/backend/src/common/redis/redis-keys.ts`, `repo:platform/backend/src/common/redis/invalidation.publisher.ts`; event contract `repo:packages/api-types/src/jobs/invalidation.ts` |
| Table columns, constraints, grants | New migration in `repo:platform/backend/migrations/platform` (never edit an applied one), `R__ota_read_access.sql` for OTA grants, then `pnpm db:codegen` |
| CLI commands | `repo:platform/backend/src/cli.ts`, `repo:platform/backend/src/admin/admin-cli.commands.ts`, `repo:platform/backend/src/tenants/demo-ota.command.ts`, `repo:platform/backend/src/secrets/rewrap.command.ts`, `repo:platform/backend/src/dev/dev-seed.command.ts` |

## Further reading

- Component spec: `repo:platform/backend/README.md`; OpenAPI conventions: `repo:platform/backend/openapi/README.md`
- Architecture: `repo:platform/docs/architecture.md`, flows at a glance `repo:platform/docs/architecture-flows.md`,
  data model `repo:platform/docs/data-model.md`
- Endpoints: `repo:platform/docs/api-inventory.md`, `repo:platform/docs/api-inventory-resources.md`,
  `repo:platform/docs/api-inventory-admin.md`
- Flows: `repo:platform/docs/flows/signup-and-create-ota.md`, `repo:platform/docs/flows/provisioning.md`,
  `repo:platform/docs/flows/subscription-billing.md`, `repo:platform/docs/flows/stripe-payments-account.md`,
  `repo:platform/docs/flows/amadeus-connection.md`, `repo:platform/docs/flows/custom-domains.md`,
  `repo:platform/docs/flows/api-keys.md`, `repo:platform/docs/flows/team-and-ota-admin-sso.md`,
  `repo:platform/docs/flows/platform-admin-operations.md`
- Operations: `repo:platform/docs/runbooks/platform-operations.md`, `repo:platform/docs/runbooks/launch-checklist.md`,
  `repo:platform/docs/security-review.md`, `repo:platform/docs/scope.md`
- ADRs: `repo:platform/docs/adr/README.md` (PADR-0001 to 0019), and `repo:docs/mvp/adr/0003-six-components-two-nestjs-backends.md`,
  `repo:docs/mvp/adr/0004-postgresql-schema-per-tenant.md`, `repo:docs/mvp/adr/0009-background-jobs-bullmq.md`,
  `repo:docs/mvp/adr/0010-secrets-envelope-encryption.md`, `repo:docs/mvp/adr/0018-hosted-storefront-custom-domains.md`
- Related apps: [[app:portal]], [[app:platform-admin]], [[app:ota-api]]
