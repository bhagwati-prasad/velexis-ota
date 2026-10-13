# Platform admin (`@velexis/platform-admin`)

This is the Velexis staff console at `admin.platform.example.com`: a Next.js 15 App Router app for platform admins to run the fleet: tenants and their lifecycle, provisioning jobs and queues, plans and Stripe prices, subscriptions, invoices and Stripe events, the shared Amadeus account and office pool, settlements and payout accounts, domains, accounts, platform admins and the audit log. Like the portal it is a backend-for-frontend: it calls the platform API's `/v1/admin` surface from server code only, with an admin token in httpOnly cookies. This page is the component specification.

Related: [`../docs/flows/platform-admin-operations.md`](../docs/flows/platform-admin-operations.md), [`../docs/api-inventory-admin.md`](../docs/api-inventory-admin.md), [PADR-0006](../docs/adr/0006-platform-admin-access-and-audit.md), [ADR-0014](../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md), [`.env.example`](.env.example).

## 1. At a glance

| Item | Value |
|---|---|
| Stack | Next.js 15 App Router, React 19, TypeScript strict, Tailwind CSS 4, shadcn/ui, `@tanstack/react-table`, Zod (forms only) |
| API client | `openapi-fetch` typed by `@velexis/api-types/platform`, `src/lib/api.ts` (`server-only`), admin operations only |
| Port | `127.0.0.1:3001`, unit `velexis-platform-admin.service`, `standalone` output |
| Host | `https://admin.platform.example.com` (optional Caddy IP allow-list; `X-Robots-Tag: noindex`) |
| Access | Accounts with `is_platform_admin = true` and MFA; TOTP on every sign-in; 12-hour sessions |

## 2. Route map

All routes except sign-in require an admin session. "Step-up" means the action asks for a fresh TOTP code (15-minute window); "reason" means a mandatory reason field that is stored in the audit log.

| Route | Purpose | Key actions | API | M |
|---|---|---|---|---|
| `/sign-in` | E-mail and password | — | `adminSignIn` | M1 |
| `/sign-in/mfa` | TOTP or recovery code | — | `adminVerifyMfa` | M1 |
| `/` | Dashboard: tenants by status, failed provisioning (24 h), failed jobs per queue, office pool levels, live office requests; M5: domains pending, settlements to review, failed Stripe events, past-due subscriptions | Links to each list | `adminGetDashboard` | M1 |
| `/tenants` | Search and filter (key, name, owner e-mail, status, plan) | — | `adminListTenants` | M1 |
| `/tenants/[tenantId]` | Detail with tabs: overview, members and invitations, subscription and invoices, connections (Amadeus, payments; masked), domains, provisioning jobs, audit | Suspend (reason), resume (reason), migrate, disable or enable a connection (reason), edit notes, assign an office, view or reveal payout account (reason, step-up), review payout account | `adminGetTenant`, `adminSuspendTenant`, `adminResumeTenant`, `adminMigrateTenant`, `adminSetConnectionStatus`, `adminUpdateTenant` | M1, M5 |
| `/provisioning-jobs` | Jobs by status and kind | — | `adminListProvisioningJobs` | M1 |
| `/provisioning-jobs/[jobId]` | Step log, attempts, errors, BullMQ state | Retry (failed), cancel (queued, reason) | `adminGetProvisioningJob`, `adminRetryProvisioningJob`, `adminCancelProvisioningJob` | M1 |
| `/queues` | Counts for every queue of both backends | — | `adminListQueues` | M1 |
| `/queues/[queue]` | Failed jobs with reasons and id-only payloads | Retry (platform queues only) | `adminListFailedQueueJobs`, `adminRetryQueueJob` | M1 |
| `/plans` | All plans, tenant counts, Stripe link state and price warnings | Create | `adminListPlans`, `adminCreatePlan` | M1 |
| `/plans/[planCode]` | Edit plan; link Stripe product and month/year prices | Save, check prices, retire | `adminUpdatePlan`, `adminCheckPlanPrices` | M1, M5 |
| `/subscriptions` | Filter by status, provider, plan | — | `adminListSubscriptions` | M1 |
| `/subscriptions/[subscriptionId]` | Detail, invoices, related Stripe events | Resync (Stripe), edit manual subscription (reason) | `adminGetSubscription`, `adminResyncSubscription`, `adminUpdateManualSubscription` | M1, M5 |
| `/invoices` | All invoices with Stripe links | — | `adminListInvoices` | M5 |
| `/stripe-events` | Webhook inbox, failed and ignored first | Reprocess | `adminListStripeEvents`, `adminReprocessStripeEvent` | M5 |
| `/amadeus/accounts` | Velexis Amadeus accounts per environment, verification state | Create (step-up), rotate secret (step-up), verify, disable | Amadeus account endpoints | M1 |
| `/amadeus/offices` | Office pool by environment and status, assigned tenant | Add in bulk, assign to tenant, release (reason, confirmation), retire (reason), notes | Amadeus office endpoints | M1, M5 |
| `/settlements` | Statements by period, status, tenant | Generate drafts for a period | `adminListSettlements`, `adminGenerateSettlements` | M5 |
| `/settlements/[settlementId]` | Totals, lines (paginated, CSV), payout account status | Add adjustment (reason), approve (step-up), mark paid (step-up), void draft (reason) | settlement endpoints | M5 |
| `/domains` | Custom domains with verification and TLS state | Re-check, remove (reason) | domain admin endpoints | M5 |
| `/accounts` | Search accounts | — | `adminListAccounts` | M1 |
| `/accounts/[accountId]` | Memberships, sessions, recent audit | Unlock, disable or enable (reason), reset MFA (reason, step-up) | account admin endpoints | M1 |
| `/admins` | Platform admins | Grant (reason, step-up), revoke (step-up) | `adminListAdmins`, `adminGrantAdmin`, `adminRevokeAdmin` | M1 |
| `/audit` | Audit log search (tenant, actor, action, target, period) | Export CSV (audited) | `adminListAudit`, `adminExportAudit` | M1 |

Route handlers: `/sign-out` (POST), `/audit/export.csv` and `/settlements/[settlementId]/lines.csv` (GET, stream from the API), `/health/live`, `/health/ready`.

Health ([ADR-0016](../../docs/mvp/adr/0016-observability.md)), both `GET` with `Cache-Control: no-store` and the static headers of §4 (`X-Robots-Tag: noindex` included):

- `/health/live` answers `200 {"status":"ok"}` while the process serves requests. It checks no dependency.
- `/health/ready` calls `PLATFORM_API_URL/health/live` and answers `200 {"status":"ok","checks":{"platformApi":"ok"}}` when it answers 2xx within 2 seconds, otherwise `503` with `"status":"unavailable"` and `"platformApi":"down"` (refused, error status, redirect or timeout; the cause is not exposed). It also reads the configuration, so an invalid environment answers `500` and the `ConfigError` in the journal names the variable. `deploy.sh` polls `ready` on port 3001 after every restart.

## 3. Folder layout

```
platform/admin/src/
  app/
    (auth)/sign-in/…, sign-in/mfa/…
    (app)/layout.tsx                    shell: navigation, signed-in admin, environment badge
    (app)/page.tsx                      dashboard
    (app)/tenants/…, provisioning-jobs/…, queues/…, plans/…, subscriptions/…, invoices/…,
    (app)/stripe-events/…, amadeus/accounts/…, amadeus/offices/…, settlements/…, domains/…,
    (app)/accounts/…, admins/…, audit/…
    health/live/route.ts, health/ready/route.ts
    layout.tsx                          root layout: lang="en", skip link to #main-content, robots noindex
    globals.css                         Tailwind CSS 4 entry and the design tokens (@theme), copied from the portal
  components/ui/                        shadcn/ui copies (components.json configures the CLI; PAD-003 adds them)
  components/                           AdminShell, DataTable, StatusBadge, ReasonDialog, StepUpDialog,
                                        ConfirmDialog, JsonView (id-only payloads, audit details), MaskedValue,
                                        RevealPanel (payout account, auto-hides after 60 s), FilterBar, Money, DateTime
  lib/config.ts                         configuration schema and getConfig(), server-only (§5)
  lib/api.ts, lib/session.ts, lib/errors.ts, lib/strings.ts
  middleware.ts
```

## 4. Data fetching, actions and session

- Server components read through `lib/api.ts` with `cache: "no-store"`; lists use URL search params for filters and the cursor, so pages are linkable.
- Every mutation is a server action that validates with Zod, sends `If-Match` where the resource is versioned, passes the reason when required, and handles `REAUTH_REQUIRED` with `StepUpDialog` (TOTP → `adminStepUp` → retry).
- Revealed payout details come back from a server action and render in memory only; the panel hides them after 60 seconds and offers no copy-to-clipboard of the full value in logs or URLs.
- Cookies: `__Host-vxa_at` (admin access token, 15 minutes) and `__Host-vxa_rt` (refresh, 12-hour family), `HttpOnly; Secure; SameSite=Strict; Path=/`; `__Host-vxa_mfa` during sign-in. Middleware refreshes the access token (single-flighted in the process) and redirects to `/sign-in` without a session.
- Portal sessions do not work here and admin sessions do not work in the portal: different cookies on different hosts and different token audiences ([PADR-0009](../docs/adr/0009-platform-api-surface-and-authentication.md)).
- Security headers as the portal, with `form-action 'self'` and `X-Robots-Tag: noindex`. The static ones are set in `next.config.ts` `headers()` for `/:path*`, so they reach every response: pages, route handlers (the health routes included), static assets and error pages.

  | Header | Value | Where |
  |---|---|---|
  | `X-Robots-Tag` | `noindex` | `next.config.ts`, every response (PAD-001) |
  | `X-Content-Type-Options` | `nosniff` | `next.config.ts`, every response (PAD-001) |
  | `Referrer-Policy` | `same-origin`: admin URLs (tenant ids, filters) are not sent to other origins | `next.config.ts`, every response (PAD-001); see the Caddy note below |
  | `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()` | `next.config.ts`, every response (PAD-001), as the portal |
  | `Content-Security-Policy` | nonce-based, as the portal, with `form-action 'self'` | `middleware.ts` (PAD-002) |

  `X-Powered-By` is switched off (`poweredByHeader: false`), and the root layout also renders `<meta name="robots" content="noindex, nofollow">`. Caddy adds `Strict-Transport-Security` and `X-Frame-Options: DENY` on the public host ([`deploy/caddy/Caddyfile`](../../deploy/caddy/Caddyfile)). Its shared `security_headers` snippet also sets `Referrer-Policy: strict-origin-when-cross-origin` (the value of [ADR-0014](../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md)), and Caddy's deferred header operations replace the app's `same-origin` with it on `admin.platform.example.com`; the stricter value only holds there once the Caddyfile's admin site stops overriding it.
- `lib/api.ts` forwards the admin's IP and user agent on every call, as the portal does: `X-Velexis-End-User-IP` (right-most `X-Forwarded-For` entry set by Caddy, `127.0.0.1` without one), `X-Velexis-End-User-Agent` (at most 512 characters) and `X-Velexis-Bff-Key` (`PLATFORM_BFF_KEY`). Admin sign-in is throttled per admin IP, and admin audit rows record it ([PADR-0019](../docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md)).

## 5. Configuration

See [`.env.example`](.env.example); on the VM `/etc/velexis/platform-admin.env` (template [`deploy/env/platform-admin.env.example`](../../deploy/env/platform-admin.env.example)): `APP_ENV`, `LOG_LEVEL`, `PORT` (3001), `HOSTNAME` (`127.0.0.1`), `PLATFORM_API_URL`, `PLATFORM_BFF_KEY` (shared with the API, PADR-0019), `PUBLIC_PLATFORM_ADMIN_URL`, `PUBLIC_PORTAL_URL` (link to enable MFA in the portal), `SENTRY_DSN`. All are read in server code through `@velexis/config`. On the VM the systemd unit sets `PORT` and `HOSTNAME`.

`src/lib/config.ts` (`import "server-only"`) declares the schema `ADMIN_CONFIG_SCHEMA`; later tasks add their entries there (`PLATFORM_BFF_KEY` comes with PAD-002).

| Variable | Rule | Default |
|---|---|---|
| `APP_ENV` | `development`, `test` or `production` | required |
| `LOG_LEVEL` | a pino level (`fatal` … `trace`, `silent`) | `info` |
| `PORT` | 1–65535 | `3001` |
| `HOSTNAME` | host name or IP literal to bind | `127.0.0.1` |
| `PLATFORM_API_URL` | absolute `http:` or `https:` URL | required |
| `PUBLIC_PLATFORM_ADMIN_URL`, `PUBLIC_PORTAL_URL` | absolute `http:` or `https:` URL; `https:` when `APP_ENV=production` | required |
| `SENTRY_DSN` | `https:` URL; unset or empty switches error tracking off | optional |

- `getConfig()` validates the process environment on first use and caches the frozen result. Outside production it first fills unset variables from `platform/admin/.env.local`, then from the root `.env.local` (`loadDevEnvFiles`), so the root file made from the root `.env.example` is enough for `pnpm dev`.
- Call it inside request handling (route handlers, server components, server actions), never at module scope: `next build` imports modules without the runtime environment. An invalid environment therefore fails the first request that needs it, and `/health/ready` is such a request, so `deploy.sh` does not take a release live with a broken `/etc/velexis/platform-admin.env`. The error is a `ConfigError` that names each variable and the reason, never a value.
- `parseConfig(source)` validates a plain object; the unit tests use it.
- **No browser-exposed variables.** No `NEXT_PUBLIC_` variable exists and `next.config.ts` has no `env` block, so nothing is inlined into client bundles; `src/lib/config.test.ts` fails if either appears.

## 6. Commands and tests

| Command | Does |
|---|---|
| `pnpm --filter @velexis/platform-admin dev` | Next.js dev server on `127.0.0.1:3001` (needs the platform API on 3100; configuration from the root `.env.local`, §5) |
| `pnpm --filter @velexis/platform-admin build` | Standalone build: `.next/standalone/platform/admin/server.js` plus `.next/static` (`outputFileTracingRoot` is the repository root, as `deploy/scripts/pack-release.sh` expects) |
| `pnpm --filter @velexis/platform-admin start` | Local smoke run of the production build with `next start` on `127.0.0.1:3001` (Next.js warns that standalone output is meant for `server.js`; the VM runs `node platform/admin/server.js` from the release, unit `velexis-platform-admin.service`) |
| `pnpm --filter @velexis/platform-admin test` | Vitest in Node: configuration, health route handlers and the static headers of `next.config.ts` (`src/**/*.test.ts`, `fetch` mocked, fake timers). Testing Library for reason and step-up dialogs, tables and form states arrives with the first client components (PAD-002, PAD-003). |
| `pnpm --filter @velexis/platform-admin lint` / `typecheck` | ESLint with the root flat config (Next.js rules included) / `tsc --noEmit` (strict, path alias `@/*` → `src/*`) |
| `pnpm test:e2e -- --project=platform-admin` | Playwright: admin sign-in with TOTP; suspend and resume a tenant and see the storefront follow; retry a failed provisioning job (M1); assign and release an office (M1/M5); approve and mark a settlement paid (M5) |

**Health and headers without a browser.** After a build, `PORT=3001 APP_ENV=development PLATFORM_API_URL=http://127.0.0.1:3100 PUBLIC_PLATFORM_ADMIN_URL=http://localhost:3001 PUBLIC_PORTAL_URL=http://localhost:3000 node .next/standalone/platform/admin/server.js` serves the standalone build (it sets `NODE_ENV=production`, so no `.env.local` is read), and `curl -i http://127.0.0.1:3001/health/live` shows `200` with `X-Robots-Tag: noindex`. The unit test `src/app/health/live/route.test.ts` checks the same headers by compiling the rules of `next.config.ts` with Next.js's own route matcher, for `/health/live` and other paths.

**Tests in Node.** `server-only` throws outside the `react-server` export condition, which only Next.js sets, so `vitest.config.ts` maps it to the package's own empty module. The `@/` alias matches `tsconfig.json`.

**postcss override.** Next.js 15 pins `postcss` 8.4.31, which has high-severity advisories. The root `package.json` overrides `next>postcss` to the patched version that Tailwind CSS already uses (the same override as the portal), so `pnpm audit --prod` stays clean. Remove the override once Next.js ships a patched `postcss`.

**Adding a shadcn/ui component.** From `platform/admin`, run the CLI pinned to the 2.x line of [`tech-stack.md`](../../docs/mvp/tech-stack.md), for example `pnpm dlx shadcn@2.10.0 add table`. `components.json` sends the copy to `src/components/ui/` with the `new-york` style, CSS variables and lucide icons, and `cn()` to `src/lib/utils.ts`. The CLI adds the component's dependencies with `^` ranges: make them exact in `package.json` before committing (`tools/ci/check-package-json.mjs` fails otherwise). The design tokens in `globals.css` are a copy of the portal's: change the portal, the platform admin and the OTA admin together ([ADR-0014](../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md)).

The `dev:seed` command of the backend creates a development admin and prints its TOTP set-up URI to the console (refused when `APP_ENV=production`). End-to-end tests create their own admin through test builders and compute TOTP codes from the secret they generated ([`../backend/README.md`](../backend/README.md)).
