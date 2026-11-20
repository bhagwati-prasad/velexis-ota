---
id: architecture
title: OTA admin — architecture guide
summary: How the OTA's back office is built — a Next.js 15 backend-for-frontend over the OTA API's console namespace with the SDK in server mode — its session cookies and refresh de-duplication, server actions with idempotency keys and If-Match, the tenant tables its actions change, its lifecycles, security headers, configuration, tests and where to change things.
---

## At a glance

| Item | Value |
|---|---|
| Package | `@velexis/ota-admin` (`repo:ota/admin/package.json`) |
| Stack | Next.js 15.5 App Router (standalone output), React 19, TypeScript strict, Tailwind CSS 4 + shadcn/ui (Radix), TanStack Table 8, Zod 4.6.7, `@velexis/ota-sdk` (server mode only) |
| Entry points | `repo:ota/admin/src/middleware.ts` (Node runtime: refresh, redirects, CSP nonce), `repo:ota/admin/src/app/layout.tsx` (root), `repo:ota/admin/src/app/(console)/layout.tsx` (signed-in shell), `repo:ota/admin/src/app/sso/route.ts` |
| Port | `127.0.0.1:3002`; production `admin.ota.example.com` → Caddy → 3002 (systemd `velexis-ota-admin`) |
| Talks to | OTA API on loopback only (`OTA_API_URL=http://127.0.0.1:4000`), never through Caddy |
| Dev | `pnpm --filter @velexis/ota-admin dev` |
| Build | `pnpm --filter @velexis/ota-admin build` → `.next/standalone/ota/admin/server.js` (the script fails if it is missing) |
| Tests | `pnpm --filter @velexis/ota-admin test` (Vitest); e2e `E2E_WITH_OTA=1 pnpm test:e2e -- --project=ota-admin` |
| Owns data | None. Every read and write is a [[console-namespace]] call; the OTA API writes the [[tenant-schema]] through [[tenant-tx]] |

## Components

```diagram
components
```

| Folder / file | Job |
|---|---|
| `repo:ota/admin/src/middleware.ts` | Every request but `/_next/`, favicon and `/health/`: refresh an access token that expires within 60 s, write rotated cookies on the response **and** the request, redirect without a session to the portal, set the per-request CSP nonce. Leaves `/sso`, `/auth/refresh`, `/auth/sign-out`, `/signed-out` alone |
| `repo:ota/admin/src/lib/velexis.ts` | Server only. `createConsoleClient` (service key, staff token, environment, [[end-user-headers]], response log line), `getConsoleRequest` (React `cache`: one `console.auth.me` per request, falls back to `test` on a refused live), `getConsole`, `getStaff`, `refreshStaffSession` |
| `repo:ota/admin/src/lib/session.ts` | Server only. The four [[host-cookie]]s, `readSession`, `staffSessionCookies`, `requireStaff(permission, { maxRetries })` for server actions, `redirectOnSessionError`, `safeNextPath`, `PAGE_PATH_HEADER` |
| `repo:ota/admin/src/lib/refresh-dedup.ts` | [[single-flight-refresh]]: one `console.auth.refresh` per refresh token (SHA-256 key) per process, results kept 30 s, on `globalThis` so middleware and app bundles share it |
| `repo:ota/admin/src/lib/auth-routes.ts` | Paths, Origin check, 1 KiB capped form reader and the plain HTML error page of the session route handlers |
| `repo:ota/admin/src/lib/permissions.ts` | `STAFF_PERMISSIONS`, `ROLE_PERMISSIONS`, `LIVE_ROLES`, `can()`, `canOpenEnvironment()` |
| `repo:ota/admin/src/lib/errors.ts` | `VelexisError` code → admin message; `isSupplierNotFound`; field errors → form state |
| `repo:ota/admin/src/lib/action-state.ts` | `ActionState`, `withNextActionKey` / `keepsActionKey` (the [[action-key]] rule), `useActionKey` |
| `repo:ota/admin/src/app/(console)/layout.tsx` | Shell: OTA name, navigation by permission, environment switch/badge, live colours, [[billing-notice]], "This OTA is suspended" |
| `repo:ota/admin/src/app/(console)/env-actions.ts` | `switchEnvironment`, `resetEnvironment` |
| `repo:ota/admin/src/app/(console)/bookings/` | List (`views.ts` URL model and saved views, `filters.tsx`, `bookings-table.tsx`) and detail (`page.tsx` reads per tab, `sections.tsx`, `actions.ts`, `action-rules.ts`, dialogs) |
| `repo:ota/admin/src/app/(console)/pnr/` | Lookup page, import dialog, `actions.ts` (`importBooking`, `searchCustomers`, `readRawOrders`, `readRawOrder`) |
| `repo:ota/admin/src/app/(console)/queues/` | Snapshot list and one queue (`queue-views.tsx`) |
| `repo:ota/admin/src/app/(console)/shopping/` | Raw Amadeus reads (`actions.ts`: `searchOffers`, `searchAvailability`, `upsellOffer`, `quoteOffer`, all `maxRetries: 0`) |
| `repo:ota/admin/src/app/(console)/payments/` | List and detail; `[paymentId]/actions.ts` reuses the booking page's capture/refund |
| `repo:ota/admin/src/app/(console)/customers/` | Read-only list and detail |
| `repo:ota/admin/src/app/(console)/settings/` | Markups/fees (`pricing-*.ts(x)`), storefront (`storefront/`), images (`assets/`), pages (`pages/`), templates (`templates/`), shared `content-rules.ts` |
| `repo:ota/admin/src/app/(console)/supplier-log/page.tsx` | Amadeus call log, bodies on demand |
| `repo:ota/admin/src/components/` | `confirm-dialog`, `data-table`, `status-badge`, `money`, `json-view`, `permission-gate`, `env-banner`, `billing-banner`, `error-state`, `console-nav`, shadcn/ui copies in `ui/` |

Patterns: pages are React Server Components that call the SDK while rendering; mutations are [[server-action]]s that
start with `requireStaff(permission)`, validate with Zod, make **one** SDK call and answer an `ActionState` (never
throw an API error to `error.tsx`, which Next.js would hide in production). Client components are leaves (filters,
dialogs) and never import the SDK or session code (`import "server-only"`).

## Data

The admin owns no table and no Redis key of its own. It drives these rows of the OTA's schema `tenant_<key>` through
the OTA API (which uses `tenantTx` as `velexis_ota_app`), and reads platform data only through `console.auth.me`.

```diagram
er-console
```

```diagram
er-settings
```

| Screen / action | Tables the API reads or writes |
|---|---|
| Bookings list / detail | `bookings`, `booking_travelers`, `booking_segments`, `booking_tickets`, `booking_events`, `staff_actions` (read) |
| Issue | `bookings` (`ticketing_status` claim `in_progress` → `issued`), `booking_tickets`, `payments` + `payment_events` (capture), `booking_events`, `notifications` (`booking.ticketed`), `staff_actions` (`payment.capture`, `booking.issue`), `idempotency_keys`, `supplier_requests` |
| Cancel | `bookings` (`cancellation_claimed_at`, `status`, `cancelled_by`, `cancel_reason`), `refunds`, `payments`, `booking_events`, `notifications`, `staff_actions` (`booking.cancel`), `idempotency_keys` |
| Patch / Resync / Note | `bookings` (`order_snapshot`, `version`, `sync_claimed_at`, `sync_changes`), contacts/remarks/travellers, `booking_events` (`booking.patched`, `booking.synced`, `staff.note`), `staff_actions` |
| Close the review | `bookings` (`reconcile_outcome` `found`/`not_found`), `checkouts`, `payments`, `booking_events` (`booking.reconcile_closed`), `staff_actions` (`booking.reconcile_close`) |
| PNR lookup / import | `bookings` (`channel = import`, `pricing_mode`), `booking_*`, `staff_actions` (`pnr.lookup`, `booking.import`), `supplier_requests` |
| Queues | `queue_snapshots` (one row per Amadeus read; `fetched_by_staff_id` null for the poller) |
| Payments | `payments`, `payment_events`, `refunds`, `staff_actions` (`payment.capture`, `payment.refund`) |
| Customers | `customers`, `saved_travelers`, `customer_sessions`, `customer_consents` (read), `staff_actions` (`customer.view`) |
| Settings | `markup_rules`, `fee_rules`, `storefront_settings` (one row `sfs_default`), `storefront_assets`, `storefront_pages`, `notification_templates`, `staff_actions` (`settings.*`) |
| Supplier log | `supplier_requests` (read; bodies redacted, purged after 90 days) |

**Redis** (written by the APIs, never by the admin):

| Key | Meaning |
|---|---|
| `ptk:<sha256>` | The portal token, 60 s, `GETDEL` by `console.auth.signIn` |
| `staffsess:<familyId>` | A [[staff-session]] family (12 h absolute) with its rotating refresh token ([[refresh-family]]) |
| `staffdeny:acct:<accountId>`, `staffdeny:member:<staffId>`, `staffdeny:tenant:<tenantId>`, `staffdeny:<familyId>` | [[staff-deny-cut-off]]: sessions older than the stamp are refused |
| `t:<tenantId>:<env>:sf:und`, `t:<tenantId>:<env>:sf:<locale>` | storefront.get caches, deleted by every storefront settings save |
| `t:<tenantId>:<env>:pages:<locale>` | Content page caches, deleted by every page change |
| `rl:<throttler>:<tracker>` | Console rate limit `ota_console`: 600 requests a minute per principal (the staff session or the key) |

The 10 s throttle of **Sync from Amadeus** and **Resync** is not a Redis key: the API compares the booking's last
sync time in PostgreSQL (`CONSOLE_REFRESH_THROTTLE_MS` of `repo:ota/backend/src/console/console-bookings.mapper.ts`).

**Queues** (BullMQ on the OTA worker, triggered indirectly): `ota-payments` (`refund.submit`, `payment.void`,
`payment.capture_retry`), `ota-notifications` (the `notifications` outbox: e-mails to Mailpit), `ota-ticketing`
(issuance after a capture), `ota-bookings` (`booking.reconcile`, sync), `ota-stripe-events` (webhooks completing
refunds).

## Key flows

**SSO from the portal.** The portal mints a one-time token; the admin redeems it with the service key alone and turns
the staff session into four cookies.

```diagram
seq-sso-sign-in
```

**A page request.** The middleware refreshes before expiry (de-duplicated), the shell loads `console.auth.me` once,
and the page reads with the access token only.

```diagram
seq-page-request
```

**Issue tickets** (every keyed action has the same shape: key rendered with the page, `If-Match`, one call,
revalidate).

```diagram
seq-issue-tickets
```

**PNR import** with office isolation.

```diagram
seq-pnr-import
```

**Close a reconciliation review** (OAD-022 / OBE-099).

```diagram
seq-close-review
```

**Save a storefront section** (`If-Match`, no idempotency key, cache deletion).

```diagram
seq-settings-save
```

## Lifecycles

The admin's own lifecycles (session, environment, action key) and the business lifecycles it drives.

```diagram
staff-session-states
```

```diagram
environment-states
```

```diagram
action-key-states
```

```diagram
reconciliation-review-states
```

```diagram
cancel-dialog-states
```

```diagram
markup-rule-states
```

```diagram
content-page-states
```

```diagram
template-source-states
```

The booking and payment states themselves belong to the OTA API:

```diagram
ota-api/booking-states
```

```diagram
ota-api/payment-states
```

## Integrations

| With | How | Contract |
|---|---|---|
| OTA API | `@velexis/ota-sdk` `console.*` (server mode: `secretKey`, `accessToken`, `sessionKind: "staff"`, `environment`), headers `X-Api-Key`, `Authorization: Bearer`, `X-Velexis-Environment`, `X-Velexis-End-User-IP`, `X-Velexis-End-User-Agent`, `Idempotency-Key`, `If-Match` | `repo:ota/backend/openapi/velexis-ota-booking-api.openapi.yaml` (operations `console*`), SDK types `repo:docs/velexis-sdk/sdk/src/console.d.ts` |
| Portal | Receives `POST /sso` from the portal's hand-off page (`repo:platform/frontend/src/app/(app)/otas/[tenantId]/console/launch/route.ts`); sends people to `PUBLIC_PORTAL_URL/console?tenant=…` and links `/otas/<id>/…` | [[portal-token]], PADR-0007 |
| Platform API | Indirect: it mints the portal token (`ptk:*`) and owns memberships, billing notice and the live flag that `console.auth.me` reports | — |
| Amadeus | Indirect, through the OTA API (raw reads under `/v1/console/amadeus/…`, order reads, issue, cancel, queues) | Amadeus stub locally |
| Stripe | Indirect: capture/refund through the OTA API; refunds complete by webhook | — |
| Storefront | Settings, rules, pages and templates change what it shows (5-minute browser copy); **View on storefront** links | — |
| Caddy / systemd | `admin.ota.example.com` → 3002; `/health/*` not exposed; `deploy.sh` polls `/health/ready` | `repo:deploy/systemd/velexis-ota-admin.service` |

## Security

- **No tokens in the browser**: tokens only in `__Host-vx_staff_at` / `__Host-vx_staff_rt` (`HttpOnly; Secure;
  SameSite=Lax; Path=/`); `lib/velexis.ts`, `lib/session.ts`, `config.ts` import `server-only`; no `NEXT_PUBLIC_`
  variable exists (a test fails on one).
- **Service key** accepted by the OTA API only on a direct loopback connection without `X-Forwarded-For` /
  `X-Forwarded-Host`, only on console operations and only with a staff token of the same tenant (OADR-0009 rule 1.2).
  The admin can never call customer-scope operations.
- **CSRF**: server actions get Next.js's Origin check; `/sso` checks `Origin == PUBLIC_PORTAL_URL` (a missing or
  `null` Origin is refused); `/auth/sign-out` checks `Origin == PUBLIC_OTA_ADMIN_URL`.
- **Headers**: per-request CSP with a nonce (`default-src 'self'; script-src 'self' 'nonce-…'; img-src 'self' data:;
  frame-ancestors 'none'; form-action 'self'; object-src 'none'`), `Referrer-Policy:
  strict-origin-when-cross-origin`; static `frame-ancestors 'none'` from `next.config.ts` for answers the middleware
  does not see.
- **No card data**: no card input anywhere (`built-pages.test.ts` scans the production build); airline-card bookings
  are issued with an `other` form of payment (`CASH`/`ACCOUNT`); card brand and last 4 only.
- **Audit**: the OTA API writes `staff_actions` (IP and user agent from the end-user headers); the admin hides what a
  role cannot do, for clarity only.
- **Uploads**: 2 MB server action body limit (Caddy caps the admin host at 10 MB); SVG and files above 1 MB refused
  before any call; the API sniffs bytes.
- **Free text**: only the review closure's note is checked for a card number (`holdsCardNumber` of
  `repo:ota/backend/src/console/review-closure.service.ts`); staff notes, reasons and remarks are stored as typed.
- **Template preview** in `<iframe sandbox="" srcdoc>`: no scripts, no same-origin.
- **Logging**: one line per SDK response (method, path without query, status, request id, duration); never bodies,
  cookies or tokens.

## Configuration

Read by `repo:ota/admin/src/config.ts` on first use (`@velexis/config`; real env > `ota/admin/.env.local` > root
`.env.local`). Production values from `/etc/velexis/ota-admin.env` (`repo:deploy/env/ota-admin.env.example`).

| Variable | Purpose |
|---|---|
| `APP_ENV`, `LOG_LEVEL`, `PORT` | Runtime (`development` / `test` / `production`, default `info`, `3002`) |
| `PUBLIC_OTA_ADMIN_URL` | Absolute links; sign-out Origin check; SSO landing redirect |
| `PUBLIC_PORTAL_URL` | SSO Origin check, "back to the portal", portal links |
| `OTA_API_URL` | SDK base URL; must be `http:` on `127.0.0.1`, `[::1]` or `localhost` |
| `OTA_ADMIN_SERVICE_KEY` | SDK `secretKey`; secret, `^sk_[A-Za-z0-9_]{16,}$`, equal to the backend's |
| `SENTRY_DSN` | Optional error tracking (off when empty) |

`next.config.ts`: `output: "standalone"`, `outputFileTracingRoot` = repo root, `serverActions.bodySizeLimit` `2mb`,
static security headers.

## Testing

| Level | Where | Run one |
|---|---|---|
| Unit / lib | `repo:ota/admin/src/lib` `*.test.ts`, `repo:ota/admin/src/config.test.ts` | `pnpm --filter @velexis/ota-admin exec vitest run src/lib/permissions.test.ts` |
| Route handlers, middleware | `src/app/sso/route.test.ts`, `src/app/auth/*/route.test.ts`, `src/middleware.test.ts` | `… vitest run src/middleware.test.ts` |
| Pages (server-rendered against a fake API) | `src/app/(console)/**/page.test.tsx`, `dashboard.test.tsx`, `layout.test.tsx` with `repo:ota/admin/src/test/fake-ota-api.ts` | `… vitest run "src/app/(console)/bookings/page.test.tsx"` |
| Server actions | `src/app/**/actions.test.ts` (real SDK, fake `fetch`) | `… vitest run "src/app/(console)/bookings/[bookingId]/actions.test.ts"` |
| Dialogs / forms (happy-dom) | `dialogs.test.tsx`, `import-dialog.test.tsx`, `theme-editor.test.tsx`, … | — |
| Built pages (no card field in the build) | `repo:ota/admin/src/app/built-pages.test.ts` | slow: runs `next build` |
| End to end | `repo:tools/e2e/specs/ota-admin/sso-bookings.e2e.ts`, `pnr-import`, `settings-effects`, `roles`, `live-environment`, `a11y-headers`, `session-expiry`, `reconciliation-review`, nightly `payments` | `E2E_WITH_OTA=1 pnpm test:e2e -- --project=ota-admin specs/ota-admin/roles.e2e.ts` |

## Where to change things

| To change … | Look at |
|---|---|
| Which role sees what (matrix, LIVE roles) | `repo:ota/admin/src/lib/permissions.ts` (and the API's guard; scope §1.3) |
| Navigation entries and their permission | `repo:ota/admin/src/components/console-nav.tsx` |
| Shell, suspended page, billing notice | `repo:ota/admin/src/app/(console)/layout.tsx`, `repo:ota/admin/src/components/billing-banner.tsx`, `repo:ota/admin/src/components/env-banner.tsx` |
| SSO hand-off, its error pages | `repo:ota/admin/src/app/sso/route.ts`, `repo:ota/admin/src/lib/auth-routes.ts` |
| Cookies, refresh margin (60 s), `requireStaff` | `repo:ota/admin/src/lib/session.ts`, `repo:ota/admin/src/middleware.ts`, `repo:ota/admin/src/lib/refresh-dedup.ts` |
| SDK client options, end-user headers, retries | `repo:ota/admin/src/lib/velexis.ts` |
| Error message for an API code | `repo:ota/admin/src/lib/errors.ts` |
| Idempotency key rules after a failure | `repo:ota/admin/src/lib/action-state.ts`, `repo:ota/admin/src/components/confirm-dialog.tsx` |
| Dashboard tiles and their counts | `repo:ota/admin/src/app/(console)/page.tsx`, `repo:ota/admin/src/app/(console)/dashboard-tiles.tsx` |
| Bookings filters, saved views, columns | `repo:ota/admin/src/app/(console)/bookings/views.ts`, `repo:ota/admin/src/app/(console)/bookings/filters.tsx`, `repo:ota/admin/src/app/(console)/bookings/bookings-table.tsx` |
| Booking detail tabs, "What needs staff" | `repo:ota/admin/src/app/(console)/bookings/[bookingId]/sections.tsx`, `repo:ota/admin/src/app/(console)/bookings/[bookingId]/page.tsx` |
| Issue / cancel / patch / note / capture / refund / review closure | `repo:ota/admin/src/app/(console)/bookings/[bookingId]/actions.ts`, `repo:ota/admin/src/app/(console)/bookings/[bookingId]/action-rules.ts`, `issue-dialog.tsx`, `cancel-dialog.tsx`, `payment-dialogs.tsx`, `patch-form.tsx`, `note-form.tsx`, `review-dialog.tsx` |
| What the API does on issue/cancel/patch | `repo:ota/backend/src/console/console-booking-actions.service.ts` |
| Review closure on the API | `repo:ota/backend/src/console/review-closure.service.ts` |
| PNR lookup and import | `repo:ota/admin/src/app/(console)/pnr/actions.ts`, `repo:ota/admin/src/app/(console)/pnr/import-dialog.tsx`, API `repo:ota/backend/src/console/pnr-import.service.ts` |
| Queues | `repo:ota/admin/src/app/(console)/queues/page.tsx`, `repo:ota/admin/src/app/(console)/queues/[queueId]/page.tsx`, API `repo:ota/backend/src/console/queues.service.ts` |
| Shopping forms and raw calls | `repo:ota/admin/src/app/(console)/shopping/actions.ts`, `repo:ota/admin/src/app/(console)/shopping/results.tsx`, API `repo:ota/backend/src/console/raw-amadeus.service.ts` |
| Payments pages | `repo:ota/admin/src/app/(console)/payments/page.tsx`, `repo:ota/admin/src/app/(console)/payments/[paymentId]/page.tsx`, API `repo:ota/backend/src/console/console-payments.service.ts` |
| Customers | `repo:ota/admin/src/app/(console)/customers/page.tsx`, `repo:ota/admin/src/app/(console)/customers/[customerId]/page.tsx`, API `repo:ota/backend/src/console/customers.service.ts` |
| Markup / fee rule form and checks | `repo:ota/admin/src/app/(console)/settings/pricing-rule-form.tsx`, `repo:ota/admin/src/app/(console)/settings/pricing-rules.ts`, `repo:ota/admin/src/app/(console)/settings/pricing-actions.ts`, API `repo:ota/backend/src/settings/pricing-rules.service.ts` |
| Storefront settings tabs, sections, offers per search | `repo:ota/admin/src/app/(console)/settings/storefront/settings-rules.ts`, `repo:ota/admin/src/app/(console)/settings/storefront/sections.tsx`, `repo:ota/admin/src/app/(console)/settings/storefront/actions.ts`, API `repo:ota/backend/src/settings/storefront-settings.service.ts` |
| Theme editor and contrast rule | `repo:ota/admin/src/app/(console)/settings/storefront/theme-editor.tsx`, `repo:ota/admin/src/lib/contrast.ts` (mirrors `repo:ota/frontend/src/lib/theme.js`) |
| Image upload limits | `repo:ota/admin/src/app/(console)/settings/assets/asset-rules.ts`, API `repo:ota/backend/src/settings/assets.service.ts` |
| Content pages | `repo:ota/admin/src/app/(console)/settings/pages/page-form.tsx`, `repo:ota/admin/src/app/(console)/settings/pages/actions.ts`, `repo:ota/admin/src/app/(console)/settings/content-rules.ts`, API `repo:ota/backend/src/settings/pages.service.ts` |
| E-mail templates, preview frame | `repo:ota/admin/src/app/(console)/settings/templates/template-form.tsx`, `repo:ota/admin/src/app/(console)/settings/templates/preview-frame.tsx`, API `repo:ota/backend/src/settings/templates.service.ts`, defaults in `repo:ota/backend/src/notifications/templates` |
| Supplier log | `repo:ota/admin/src/app/(console)/supplier-log/page.tsx`, API `repo:ota/backend/src/console/supplier-log.controller.ts` |
| Portal links | `repo:ota/admin/src/lib/portal-links.ts`, `repo:ota/admin/src/app/(console)/portal/page.tsx` |
| Config validation, CSP, headers | `repo:ota/admin/src/config.ts`, `repo:ota/admin/src/middleware.ts`, `repo:ota/admin/next.config.ts` |
| Readiness probe | `repo:ota/admin/src/app/health/ready/route.ts` |
| Audit row names and redaction | `repo:ota/backend/src/console/staff-actions.writer.ts` |
| A console operation's contract | `repo:ota/backend/openapi/velexis-ota-booking-api.openapi.yaml` (then regenerate types; never edit `docs/velexis-sdk/sdk/src/*.d.ts`) |
| Tenant columns | `repo:ota/backend/migrations/tenant/0001_baseline.sql`, `repo:ota/backend/migrations/tenant/0002_add_mvp_tenant_deltas.sql` (new migration, never edit the reference SQL) |

## Further reading

- `repo:ota/admin/README.md` (component specification) and `repo:ota/admin/docs/routes.md` (every route, call, state)
- `repo:ota/docs/flows/console-operations.md` (the API side of every console task)
- `repo:ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md`, `repo:ota/docs/adr/0011-console-access-staff-sessions-and-environments.md`, `repo:ota/docs/adr/0009-caller-and-tenant-resolution.md`
- `repo:platform/docs/adr/0007-portal-to-ota-admin-sso-token.md` (the SSO token)
- `repo:ota/docs/adr/0005-markup-and-fee-engine.md`, `repo:ota/docs/adr/0008-ticketing-policy.md`, `repo:ota/docs/adr/0012-storefront-settings-assets-and-pages.md`, `repo:ota/docs/adr/0013-notifications-and-booking-documents.md`, `repo:ota/docs/adr/0004-airline-card-data-handling.md`, `repo:ota/docs/adr/0003-booking-orchestration-and-supplier-timeout-recovery.md`
- `repo:ota/docs/runbooks/supplier-timeout-and-reconciliation.md` (review closure §4.3)
- `repo:ota/docs/api-changes-console-and-internal.md`, `repo:ota/docs/scope.md` (§1.3 roles, §2.3 OTA admin)
- `repo:docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md`, `repo:docs/mvp/adr/0008-identity-accounts-customers-sessions.md`
- `repo:tools/e2e/README.md` (OTA admin journeys)
