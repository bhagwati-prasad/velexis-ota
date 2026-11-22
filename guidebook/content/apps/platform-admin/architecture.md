---
id: architecture
title: Platform admin — architecture guide
summary: How the staff console is built - a Next.js 15 backend-for-frontend with deny-by-default middleware, server components and server actions over a typed /v1/admin client, its session and step-up model, the platform tables behind each screen, and where to change things.
---

## At a glance

| Item | Value |
|---|---|
| Package | `@velexis/platform-admin`, `repo:platform/admin` |
| Stack | Next.js 15.5 App Router, React 19, TypeScript strict, Tailwind CSS 4, shadcn/ui (Radix), TanStack Table, `openapi-fetch` typed by `@velexis/api-types/platform`, Zod 4 |
| Entry points | `repo:platform/admin/src/middleware.ts` (every request), `repo:platform/admin/src/app/layout.tsx` (root, `dynamic = "force-dynamic"`), `repo:platform/admin/src/app/(app)/layout.tsx` (signed-in shell), `repo:platform/admin/src/app/(auth)/sign-in/page.tsx` |
| Port | `127.0.0.1:3001`; on the VM `node platform/admin/server.js` (standalone), unit `repo:deploy/systemd/velexis-platform-admin.service`, host `admin.platform.example.com` |
| Run | `pnpm --filter @velexis/platform-admin dev` (also `build`, `start`, `test`, `lint`, `typecheck`) |
| Talks to | The platform API only ([[app:platform-api]]), on loopback, `/v1/admin/**` |
| Owns | No table, no queue, no Redis key: cookies only |

It is a [[bff]]: no API call ever leaves the browser. Pages are server components; every mutation is a
[[server-action]]; the only client code is forms, dialogs, tables and tabs that receive the fields they show.

## Components

```diagram
components
```

| Folder / file | Job |
|---|---|
| `repo:platform/admin/src/middleware.ts` | [[admin-middleware]]: with `APP_ENV=development`, first a `307` of another host to `PUBLIC_PLATFORM_ADMIN_URL`; deny by default (public: `/sign-in`, `/sign-in/mfa`, `/sign-out`), refresh near-expiry tokens (single-flight), CSP with a per-request nonce, `X-Robots-Tag: noindex`, `303` to `/sign-in?next=` |
| `repo:platform/admin/src/app/(auth)` | Sign-in (`signIn`) and code step (`verifyMfa`) server actions and forms; `form-controls.tsx` |
| `repo:platform/admin/src/app/(app)/layout.tsx` | `adminGetMe` once per request; `AdminShell` with the nav filtered by milestone switches; `UNAUTHENTICATED`/`TOKEN_EXPIRED` (revoked rights, disabled account) → plain `/sign-in` |
| `repo:platform/admin/src/app/(app)` | One folder per area: `tenants`, `provisioning-jobs`, `queues`, `plans`, `subscriptions`, `invoices`, `stripe-events`, `amadeus/accounts`, `amadeus/offices`, `settlements`, `domains`, `accounts`, `admins`, `audit`; each with `page.tsx`, client `*-form.tsx` / `*-table.tsx`, `actions.ts` and a `*.test.tsx` |
| `repo:platform/admin/src/app/(app)/step-up-actions.ts` | `stepUp`: TOTP → `adminStepUp` → new session cookies |
| `repo:platform/admin/src/components` | `admin-shell.tsx`, `data-table.tsx`, `filter-bar.tsx`, `status-badge.tsx`, `reason-dialog.tsx`, `step-up-dialog.tsx`, `confirm-dialog.tsx`, `json-view.tsx`, `masked-value.tsx`, `reveal-panel.tsx`, `money.tsx`, `date-time.tsx`; `ui/` shadcn copies |
| `repo:platform/admin/src/lib/api.ts` | Typed client of the admin surface; refuses other paths; returns `{data}` or `{error}` (platform code, field errors, details, `Retry-After`) |
| `repo:platform/admin/src/lib/session.ts` | Cookie names and attributes, JWT `exp`/`aud` read, `safeNextPath` ([[return-path]]), single-flight refresh |
| `repo:platform/admin/src/lib/end-user.ts` | [[end-user-headers]] and the [[bff-key]] header |
| `repo:platform/admin/src/lib/config.ts` | `ADMIN_CONFIG_SCHEMA`, `getConfig()` |
| `repo:platform/admin/src/lib/errors.ts`, `repo:platform/admin/src/lib/strings.ts` | Every [[platform-error-code]] → the admin's sentence; every label of the UI |
| Route handlers | `repo:platform/admin/src/app/sign-out/route.ts`, `repo:platform/admin/src/app/(app)/audit/export.csv/route.ts`, `repo:platform/admin/src/app/(app)/settlements/[settlementId]/lines.csv/route.ts`, `repo:platform/admin/src/app/health/live/route.ts`, `repo:platform/admin/src/app/health/ready/route.ts` |

```diagram
neighbours
```

## Data

The console owns no data. It reads and changes these platform tables through the API (each operation's
`x-platform-tables` in `repo:platform/backend/openapi/velexis-platform-api.openapi.yaml` lists them exactly); every
change adds a `platform.platform_audit_log` row with `actor_type = 'platform_admin'`.

```diagram
admin-er
```

| Screen | Reads | Writes (through the API) |
|---|---|---|
| Sign-in, step-up, sign-out | `accounts` | `account_sessions` (`audience = 'platform_admin'`, `mfa_verified_at`), `account_recovery_codes`, audit `admin.sign_in` / `admin.sign_in_failed` |
| Dashboard | `tenants`, `provisioning_jobs`, `amadeus_accounts`, `amadeus_offices`, `supplier_connections`, `tenant_domains`, `settlements`, `stripe_events`, `subscriptions`; BullMQ counts | — |
| Tenants | `tenants`, `tenant_memberships`, `tenant_invitations`, `tenant_domains`, `subscriptions`, `plans`, `supplier_connections`, `payment_provider_connections`, `credential_submissions`, `provisioning_jobs`, audit | `tenants`, `provisioning_jobs`, `email_outbox`, `supplier_connections`, `payment_provider_connections` |
| Jobs and queues | `provisioning_jobs`; BullMQ | `provisioning_jobs`, `tenants` (retry of `provision`); BullMQ retry |
| Plans, subscriptions, invoices, Stripe events | `plans`, `subscriptions`, `invoices`, `stripe_events` | `plans` (incl. `price_warnings`), `subscriptions`, `tenants` (billing notice / resume), `stripe_events` |
| Amadeus | `amadeus_accounts`, `amadeus_offices`, `tenants` | `amadeus_accounts`, `amadeus_offices`, `supplier_connections`, `credential_submissions`, `email_outbox` |
| Settlements and payouts | `settlements`, `settlement_lines`, `tenant_payout_accounts` | the same, `email_outbox` |
| Domains | `tenant_domains` | `tenant_domains`, `email_outbox` |
| Accounts and admins | `accounts`, `tenant_memberships`, `account_sessions` | `accounts`, `account_sessions`, `account_recovery_codes`, `email_outbox` |
| Audit | `platform_audit_log` | one `audit.exported` row per export |

Tenancy: admin endpoints never touch a tenant schema (`tenant_<key>`); bookings and travellers are out of reach by
design. There is no `tenantTx` here.

Redis (written by the API, never by the console): `mfach:<sha256>` and `mfach:<sha256>:attempts` (the
[[mfa-challenge]], 5 minutes, 5 tries), `mfastep:<accountId>` (no TOTP replay), `staffdeny:acct:<accountId>` (disable
and MFA reset cut OTA console sessions: [[staff-deny-cut-off]]), `rl:<throttler>:<tracker>` (rate limits, per admin IP
thanks to the end-user headers), `tlsask:<host>` (dropped on domain removal), the `vx:invalidate` channel, and BullMQ
keys with prefix `vx`.

Queues the console's actions feed (it never enqueues itself): [[ota-tenant-ops]] (suspend, resume, migrate, provision
retries; the OTA worker answers on [[platform-tenant-events]]), `platform-emails` (every owner e-mail via the [[outbox]]), `platform-connections` (Amadeus verification),
`platform-domains` (re-check), `platform-stripe-events` (reprocess), `platform-settlements` (generate drafts).

Cookies (all `HttpOnly; Secure; SameSite=Strict; Path=/`, the [[admin-session]]):

| Cookie | Holds | Lifetime |
|---|---|---|
| `__Host-vxa_mfa` | MFA challenge token | ≤ 5 minutes, sign-in only |
| `__Host-vxa_at` | Admin access token (JWT, audience `platform_admin`, `mfa_at`) | 15 minutes |
| `__Host-vxa_rt` | Refresh token (opaque) | until `refreshTokenExpiresAt` (2 idle hours, 12-hour family), capped at 12 h |

## Key flows

Sign-in: the password step only ever yields a challenge; the session comes from the code step.

```diagram
seq-sign-in-mfa
```

Every page request: middleware refresh, then the layout's `adminGetMe`, then the page.

```diagram
seq-request-refresh
```

A step-up action ([[step-up]], [[step-up-dialog]]):

```diagram
seq-step-up-retry
```

Suspending an OTA ([[suspension]]):

```diagram
seq-suspend-tenant
```

Settlement review and payment:

```diagram
seq-settlement-review
```

Live office request to release:

```diagram
seq-live-office
```

Streaming CSV exports:

```diagram
seq-csv-export
```

## Lifecycles

The console drives these states; each diagram names the buttons offered in each state.

```diagram
admin-session-states
```

```diagram
tenant-states
```

```diagram
provisioning-job-states
```

```diagram
amadeus-account-states
```

```diagram
amadeus-office-states
```

```diagram
velexis-connection-states
```

```diagram
plan-states
```

```diagram
manual-subscription-states
```

```diagram
stripe-event-states
```

```diagram
settlement-states
```

```diagram
payout-account-states
```

```diagram
domain-states
```

```diagram
account-states
```

## Integrations

| With | How | Contract |
|---|---|---|
| Platform API | `openapi-fetch` over HTTP on loopback; `cache: no-store`, `redirect: manual`; Bearer from `__Host-vxa_at`; `X-Request-Id` forwarded | `repo:platform/backend/openapi/velexis-platform-api.openapi.yaml` (68 `admin*` operations, `x-scope: platform_admin`), types `repo:packages/api-types/src/platform.ts` (generated with `pnpm contracts:generate`) |
| Error catalogue | `@velexis/errors` `PLATFORM_ERROR_CODES`; `errors.test.ts` fails when a code has no admin message | `repo:packages/errors/src/index.ts` |
| Queue names | `@velexis/api-types/jobs` `PLATFORM_QUEUES`, `OTA_QUEUES` (owner = name prefix) | `repo:packages/api-types/src/jobs/queues.ts` |
| Audit lists | `AUDIT_ACTIONS`, `AUDIT_TARGET_TYPES` copied from the backend (test compares) | `repo:platform/backend/src/audit/audit-actions.ts` |
| Currency exponents | `adjustment-amount.ts` copies them (test compares) | `repo:tools/reference-data/data/currencies.csv` |
| Portal | Links only (MFA set-up, password reset, pricing page) | `PUBLIC_PORTAL_URL` |
| Caddy | Reverse proxy, HSTS, WAF, `/health/*` 404, optional staff IP allow-list | `repo:deploy/caddy/Caddyfile` |
| Stripe, Amadeus, SMTP | Indirect: through the platform API and worker only | — |

## Security

- **Authentication.** Password + TOTP (or one recovery code) on **every** sign-in ([[mfa]], [[totp]],
  [[recovery-code]]). Non-admins get the same `INVALID_CREDENTIALS` as a wrong password. Admin tokens have audience
  `platform_admin`; portal sessions do not open the console and admin sessions do not open the portal
  (`admin-headers.e2e.ts`).
- **Sessions.** HttpOnly `__Host-` cookies only; the token never reaches browser JavaScript or a client component's
  props. The middleware reads `exp`/`aud` without verifying the signature: the API verifies it on every call.
- **Deny by default.** Any path that is not exactly `/sign-in`, `/sign-in/mfa` or `/sign-out` needs a session, even
  a path that does not exist yet.
- **CSRF.** Server actions get Next.js's Origin check; `POST /sign-out` checks `Origin` itself against
  `PUBLIC_PLATFORM_ADMIN_URL`; `SameSite=Strict` everywhere. The audit CSV link is a plain `<a>` (no prefetch that
  would export and audit).
- **[[reason-action]]s and [[step-up]].** Both checked in the browser (`ReasonDialog`, 5-500 code points) and again in
  the server action before the call, and enforced by the API.
- **Secrets on screen.** Amadeus secrets are write-only (password fields, `autocomplete="new-password"`, emptied after
  every answer, never in state). Client ids, Stripe ids and bank accounts are [[masked-value]]s from the API. A
  [[payout-account-reveal]] lives 60 s in React state only, no copy button, audited each time.
- **Headers.** `next.config.ts`: `X-Robots-Tag: noindex`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  same-origin`, `Permissions-Policy`; middleware: CSP with nonce, `form-action 'self'`, `frame-ancestors 'none'`
  (`'unsafe-eval'` only in development). Caddy adds HSTS and `X-Frame-Options: DENY`; its `security_headers`
  snippet sets `Referrer-Policy` only when an answer has none, so the admin's `same-origin` reaches the browser on the
  admin host too.
- **Redirect safety.** `safeNextPath` drops absolute, protocol-relative, backslash and dot-segment tricks.
- **Configuration.** `server-only` on every lib module; no `NEXT_PUBLIC_` variable and no `env` block
  (`config.test.ts` fails otherwise). PCI: the console never sees card data.

## Configuration

`repo:platform/admin/.env.example` locally (filled from the root `.env.local` outside production); on the VM
`/etc/velexis/platform-admin.env` from `repo:deploy/env/platform-admin.env.example`.

| Variable | Purpose |
|---|---|
| `APP_ENV` | `development`, `test` or `production` (badge colour, `'unsafe-eval'` in dev, https enforced in production) |
| `LOG_LEVEL` | pino level, default `info` |
| `PORT`, `HOSTNAME` | `3001`, `127.0.0.1` |
| `PLATFORM_API_URL` | Platform API base URL (loopback) |
| `PLATFORM_BFF_KEY` | Secret shared with the API and the portal (≥ 32 chars of `[A-Za-z0-9_-]`); never log it |
| `PUBLIC_PLATFORM_ADMIN_URL` | The console's own origin: redirects, sign-out Origin check |
| `PUBLIC_PORTAL_URL` | Portal origin for the MFA and password links |
| `SENTRY_DSN` | Validated only (`https:` URL or empty); no client sends errors until M6, so it stays empty |

The M5 [[feature-switch]]es live in the platform API (`FEATURE_STRIPE_BILLING`, `FEATURE_OWN_STRIPE`,
`FEATURE_SETTLEMENTS`, `FEATURE_CUSTOM_DOMAINS`, …); the console only reads them from `adminGetMe`.

## Testing

| Kind | Where | Run one |
|---|---|---|
| Unit + component (Vitest, happy-dom, `fetch` mocked or a small in-memory platform) | `repo:platform/admin/src/lib/api.test.ts`, `repo:platform/admin/src/middleware.test.ts`, `repo:platform/admin/src/components/components.test.tsx`, `repo:platform/admin/src/app/(app)/tenants/tenants.test.tsx`, `repo:platform/admin/src/app/(app)/settlements/settlements.test.tsx`, … (one per area) | `pnpm --filter @velexis/platform-admin test -- src/app/(app)/plans/plans.test.tsx` |
| End-to-end (Playwright, project `platform-admin`, built apps) | `repo:tools/e2e/specs/admin-signin.e2e.ts`, `repo:tools/e2e/specs/admin-tenant-lifecycle.e2e.ts`, `repo:tools/e2e/specs/admin-amadeus-pool.e2e.ts`, `repo:tools/e2e/specs/admin-audit.e2e.ts`, `repo:tools/e2e/specs/admin-suspension-storefront.e2e.ts`, `repo:tools/e2e/specs/admin-settlements.e2e.ts`, `repo:tools/e2e/specs/admin-live-office.e2e.ts`, `repo:tools/e2e/specs/admin-domains.e2e.ts`, `repo:tools/e2e/specs/admin-a11y.e2e.ts`, `repo:tools/e2e/specs/admin-headers.e2e.ts`, `repo:tools/e2e/specs/admin-step-up.e2e.ts` | `E2E_WITH_OTA=1 pnpm test:e2e -- --project=platform-admin specs/admin-audit.e2e.ts` (after building the apps) |
| Backend side | `platform/backend/test/integration/admin/*.int.test.ts` | `pnpm --filter @velexis/platform-backend test:int` |

Tests also read the OpenAPI document (`x-reason-required`, `x-mfa-step-up`), `audit-actions.ts` and `currencies.csv`,
so changing those reruns the admin tests (listed as Turborepo inputs in `repo:turbo.json`).

## Where to change things

| To change … | Look at |
|---|---|
| Which paths need no session, the CSP, the refresh margin | `repo:platform/admin/src/middleware.ts`, `repo:platform/admin/src/lib/session.ts` |
| Cookie names, lifetimes, `next` validation | `repo:platform/admin/src/lib/session.ts` |
| Sign-in validation and messages (locked, MFA required) | `repo:platform/admin/src/app/(auth)/sign-in/actions.ts`, `repo:platform/admin/src/app/(auth)/sign-in/mfa/actions.ts` |
| Navigation groups, feature-gated areas, environment badge | `repo:platform/admin/src/components/admin-shell.tsx` |
| Any label, message or error wording | `repo:platform/admin/src/lib/strings.ts` (errors via `repo:platform/admin/src/lib/errors.ts`) |
| Reason length rule, step-up dialog, confirm dialog | `repo:platform/admin/src/components/reason-dialog.tsx`, `repo:platform/admin/src/components/step-up-dialog.tsx`, `repo:platform/admin/src/components/confirm-dialog.tsx`, `repo:platform/admin/src/app/(app)/step-up-actions.ts` |
| List filters in the URL, paging | `repo:platform/admin/src/components/filter-bar.tsx`, `repo:platform/admin/src/components/data-table.tsx` |
| Status words and colours | `repo:platform/admin/src/components/status-badge.tsx` (`STATUS_LABELS` in strings) |
| Money and date formatting | `repo:platform/admin/src/components/money.tsx`, `repo:platform/admin/src/components/date-time.tsx` |
| Dashboard counters and live requests | `repo:platform/admin/src/app/(app)/page.tsx`; API `repo:platform/backend/src/admin/admin-dashboard.service.ts` |
| Tenant tabs, suspend/resume/migrate, notes, connection status, assign office | `repo:platform/admin/src/app/(app)/tenants/[tenantId]/page.tsx`, `repo:platform/admin/src/app/(app)/tenants/[tenantId]/actions.ts`, `repo:platform/admin/src/app/(app)/tenants/[tenantId]/suspend-form.tsx`; API `repo:platform/backend/src/admin/admin-tenants.service.ts`, `repo:platform/backend/src/provisioning/suspension.service.ts` |
| Payout account panel and reveal | `repo:platform/admin/src/app/(app)/tenants/[tenantId]/payout-account.tsx`, `repo:platform/admin/src/app/(app)/tenants/[tenantId]/payout-actions.ts`, `repo:platform/admin/src/components/reveal-panel.tsx`; API `repo:platform/backend/src/settlements/payout-accounts.service.ts` |
| Job retry/cancel, queue retry | `repo:platform/admin/src/app/(app)/provisioning-jobs/[jobId]/actions.ts`, `repo:platform/admin/src/app/(app)/queues/[queue]/actions.ts`; API `repo:platform/backend/src/admin/admin-jobs.service.ts`, `repo:platform/backend/src/admin/queue-inspector.ts` |
| Plan form, Stripe price links | `repo:platform/admin/src/app/(app)/plans/plan-form.tsx`, `repo:platform/admin/src/app/(app)/plans/stripe-prices-form.tsx`, `repo:platform/admin/src/app/(app)/plans/actions.ts`; API `repo:platform/backend/src/billing/plans.service.ts`, `repo:platform/backend/src/billing/price-check.ts` |
| Manual subscription edit, resync | `repo:platform/admin/src/app/(app)/subscriptions/[subscriptionId]/manual-subscription-form.tsx`, `repo:platform/admin/src/app/(app)/subscriptions/actions.ts`; API `repo:platform/backend/src/billing/subscriptions.service.ts` |
| Stripe events reprocess | `repo:platform/admin/src/app/(app)/stripe-events/actions.ts`; API `repo:platform/backend/src/admin/admin-stripe-events.service.ts` |
| Amadeus account form and secret handling | `repo:platform/admin/src/app/(app)/amadeus/accounts/account-form.tsx`, `repo:platform/admin/src/app/(app)/amadeus/accounts/actions.ts`; API `repo:platform/backend/src/supplier-connections/amadeus-accounts.service.ts` |
| Office pool: add, assign by key, retire, release | `repo:platform/admin/src/app/(app)/amadeus/offices/actions.ts`, `repo:platform/admin/src/app/(app)/amadeus/offices/release-dialog.tsx`; API `repo:platform/backend/src/admin/admin-amadeus.controller.ts` |
| Settlement review, adjustment decimals | `repo:platform/admin/src/app/(app)/settlements/[settlementId]/actions.ts`, `repo:platform/admin/src/app/(app)/settlements/[settlementId]/adjustment-amount.ts`; API `repo:platform/backend/src/settlements/settlement-review.service.ts` |
| Generate drafts | `repo:platform/admin/src/app/(app)/settlements/generate-drafts-form.tsx`, `repo:platform/admin/src/app/(app)/settlements/actions.ts`; API `repo:platform/backend/src/settlements/settlements.processor.ts` |
| Domains re-check and removal | `repo:platform/admin/src/app/(app)/domains/actions.ts`, `repo:platform/admin/src/app/(app)/domains/domain-table.tsx`; API `repo:platform/backend/src/domains/admin-domains.service.ts` |
| Account support and admins | `repo:platform/admin/src/app/(app)/accounts/[accountId]/actions.ts`, `repo:platform/admin/src/app/(app)/admins/actions.ts`; API `repo:platform/backend/src/admin/admin-accounts.service.ts` |
| Audit filters, export | `repo:platform/admin/src/app/(app)/audit/audit-filters.ts`, `repo:platform/admin/src/app/(app)/audit/export.csv/route.ts`; actions list `repo:platform/backend/src/audit/audit-actions.ts` |
| An admin API operation's shape | `repo:platform/backend/openapi/velexis-platform-api.openapi.yaml`, then `pnpm contracts:generate` (contract first) |
| Configuration variables | `repo:platform/admin/src/lib/config.ts`, `repo:platform/admin/.env.example`, `repo:deploy/env/platform-admin.env.example` |
| Static security headers | `repo:platform/admin/next.config.ts` |
| Host, allow-list, health exposure | `repo:deploy/caddy/Caddyfile` |

## Further reading

- `repo:platform/admin/README.md` — the component specification (routes, every behaviour, tests).
- `repo:platform/docs/flows/platform-admin-operations.md` — what staff do, failure handling.
- `repo:platform/docs/api-inventory-admin.md` — every admin operation with tables and errors.
- `repo:platform/docs/runbooks/platform-operations.md` — stuck jobs, failed Stripe events, abusive domains, lost
  authenticators.
- `repo:platform/docs/adr/0006-platform-admin-access-and-audit.md` (PADR-0006),
  `repo:platform/docs/adr/0014-tenant-suspension-and-resume.md`, `repo:platform/docs/adr/0012-amadeus-office-pool.md`,
  `repo:platform/docs/adr/0015-milestone-feature-switches.md`,
  `repo:platform/docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md`.
- `repo:docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md`, `repo:docs/mvp/adr/0008-identity-accounts-customers-sessions.md`.
- `repo:tools/e2e/README.md` — "Tests of PAD-010", "PAD-015", "PAD-016".
- Related apps: [[app:platform-api]], [[app:portal]]; journeys [[journey:suspend-and-resume-ota]],
  [[journey:amadeus-and-stripe-connections]], [[journey:custom-domain-and-go-live]].
