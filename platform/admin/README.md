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
    (auth)/sign-in/page.tsx, actions.ts, sign-in-form.tsx        e-mail and password (PAD-002)
    (auth)/sign-in/mfa/page.tsx, actions.ts, mfa-form.tsx    TOTP or recovery code, on every sign-in (PAD-002)
    (auth)/form-controls.tsx            labelled field and error summary of the two sign-in forms
    (app)/layout.tsx                    shell: navigation, signed-in admin, environment badge
    (app)/page.tsx                      dashboard
    (app)/tenants/…, provisioning-jobs/…, queues/…, plans/…, subscriptions/…, invoices/…,
    (app)/stripe-events/…, amadeus/accounts/…, amadeus/offices/…, settlements/…, domains/…,
    (app)/accounts/…, admins/…, audit/…
    sign-out/route.ts                   POST only, Origin checked (PAD-002)
    health/live/route.ts, health/ready/route.ts
    layout.tsx                          root layout: lang="en", skip link to #main-content, robots noindex, every page dynamic
    globals.css                         Tailwind CSS 4 entry and the design tokens (@theme), copied from the portal
  components/ui/                        shadcn/ui copies (components.json configures the CLI; PAD-003 adds them)
  components/                           AdminShell, DataTable, StatusBadge, ReasonDialog, StepUpDialog,
                                        ConfirmDialog, JsonView (id-only payloads, audit details), MaskedValue,
                                        RevealPanel (payout account, auto-hides after 60 s), FilterBar, Money, DateTime
  lib/config.ts                         configuration schema and getConfig(), server-only (§5)
  lib/api.ts, lib/end-user.ts          platform API client of the admin surface and the PADR-0019 headers, server-only
  lib/session.ts                      cookies, access token claims, return path, single-flight refresh, server-only
  lib/errors.ts, lib/strings.ts       error code -> admin message (every platform code), the admin's English text
  middleware.ts                       refresh, sign-in redirect (deny by default), CSP with a nonce, noindex
```

## 4. Data fetching, actions and session

- Server components read through `lib/api.ts` with `cache: "no-store"`; lists use URL search params for filters and the cursor, so pages are linkable.
- Every mutation is a server action that validates with Zod, sends `If-Match` where the resource is versioned, passes the reason when required, and handles `REAUTH_REQUIRED` with `StepUpDialog` (TOTP → `adminStepUp` → retry).
- Revealed payout details come back from a server action and render in memory only; the panel hides them after 60 seconds and offers no copy-to-clipboard of the full value in logs or URLs.
- Cookies: `__Host-vxa_at` (admin access token, 15 minutes) and `__Host-vxa_rt` (refresh, 12-hour family), `HttpOnly; Secure; SameSite=Strict; Path=/`; `__Host-vxa_mfa` during sign-in. Middleware refreshes the access token (single-flighted in the process) and redirects to `/sign-in` without a session.
- **Sign-in (PAD-002).** `/sign-in` sends e-mail and password to `adminSignIn` (no bearer token, the end-user headers below). Its answer is always an MFA challenge, which goes into `__Host-vxa_mfa` (at most 5 minutes) before the browser continues to `/sign-in/mfa`; the password step never writes a session cookie, and an answer that is not a challenge is refused (`INTERNAL_ERROR`). `/sign-in/mfa` sends the challenge with a TOTP code or one recovery code to `adminVerifyMfa`, and only its `AdminSession` becomes `__Host-vxa_at` and `__Host-vxa_rt`, so the TOTP step happens on **every** sign-in (PF-80). Without a challenge cookie, and on `MFA_CHALLENGE_INVALID`, the admin goes back to `/sign-in?mfa=expired`. `MFA_REQUIRED` (a platform admin without MFA) explains that MFA is turned on in the portal and links to `PUBLIC_PORTAL_URL/account/security`; `ACCOUNT_LOCKED` and `RATE_LIMITED` show the wait of `Retry-After`. A forgotten password is reset in the portal (`PUBLIC_PORTAL_URL/forgot-password`): it is the same account.
- **Return path.** The middleware sends a request without a session to `/sign-in?next=<path and query>`; `next` travels in the query of `/sign-in/mfa` (no fourth cookie) and is used after the code step only when it is a relative path on the admin (`safeNextPath`: no absolute, protocol-relative or backslash URL, no control character, at most 2 048 characters). Otherwise the admin lands on the dashboard `/`. Because every cookie is `SameSite=Strict`, a link to the admin opened from another site (a chat, a mail client) arrives without the session and asks to sign in again; `next` then brings the admin back to the page.
- **Middleware (PAD-002).** It runs on every request except `/_next/…`, `/favicon.ico` and `/health/…`, in the Node.js runtime (the single-flight map lives in the admin process). Deny by default: only the exact paths `/sign-in`, `/sign-in/mfa` and `/sign-out` work without a session; every other path, including one that does not exist yet (`/sign-in/other` too), answers `303` to `/sign-in`. An access token that is missing, unreadable, not of the `platform_admin` audience or within 30 seconds of its expiry is refreshed with `adminRefresh` (the same refresh token is sent once per 10 seconds however many requests present it; `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`, `VALIDATION_FAILED` and `UNAUTHENTICATED` delete both cookies, a rate limit or an unreachable API keeps them), and the new tokens replace the old ones in the request the page renders. The JWT signature is not checked here: the API checks it on every call.
- **Sign-out.** `POST /sign-out` answers `403` unless `Origin` is the origin of `PUBLIC_PLATFORM_ADMIN_URL`, then calls `adminSignOut` with the bearer token and the refresh token, deletes the cookies whatever the API answered, and answers `303` to `/sign-in?signedOut=1`. Other methods answer `405`.
- Portal sessions do not work here and admin sessions do not work in the portal: different cookies on different hosts and different token audiences ([PADR-0009](../docs/adr/0009-platform-api-surface-and-authentication.md)).
- Security headers as the portal, with `form-action 'self'` and `X-Robots-Tag: noindex`. The static ones are set in `next.config.ts` `headers()` for `/:path*`, so they reach every response: pages, route handlers (the health routes included), static assets and error pages.

  | Header | Value | Where |
  |---|---|---|
  | `X-Robots-Tag` | `noindex` | `next.config.ts`, every response (PAD-001); `middleware.ts` sets it on its own redirects too (PAD-002) |
  | `X-Content-Type-Options` | `nosniff` | `next.config.ts`, every response (PAD-001) |
  | `Referrer-Policy` | `same-origin`: admin URLs (tenant ids, filters) are not sent to other origins | `next.config.ts`, every response (PAD-001); see the Caddy note below |
  | `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()` | `next.config.ts`, every response (PAD-001), as the portal |
  | `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'` with a new nonce per request; `script-src` also has `'unsafe-eval'` when `APP_ENV=development` (`next dev`). Every page is rendered per request (`export const dynamic = "force-dynamic"` in the root layout), as in the portal: a prerendered page would keep inline scripts without the nonce, and the policy would block them | `middleware.ts` (PAD-002), on pages and on its own redirects |

  `X-Powered-By` is switched off (`poweredByHeader: false`), and the root layout also renders `<meta name="robots" content="noindex, nofollow">`. Caddy adds `Strict-Transport-Security` and `X-Frame-Options: DENY` on the public host ([`deploy/caddy/Caddyfile`](../../deploy/caddy/Caddyfile)). Its shared `security_headers` snippet also sets `Referrer-Policy: strict-origin-when-cross-origin` (the value of [ADR-0014](../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md)), and Caddy's deferred header operations replace the app's `same-origin` with it on `admin.platform.example.com`; the stricter value only holds there once the Caddyfile's admin site stops overriding it.
- `lib/api.ts` (`server-only`) calls the admin surface `/v1/admin/…` only (the types refuse other paths, and a call of another path throws before anything is sent), with `cache: "no-store"`, no redirect following, the bearer token of `__Host-vxa_at` when there is one and the request id of the incoming request. A call answers `{ data }` or `{ error }` with the code of the platform catalogue, field errors, details and `Retry-After`, never the API's own message. It forwards the admin's IP and user agent on every call, as the portal does (`lib/end-user.ts`): `X-Velexis-End-User-IP` (right-most `X-Forwarded-For` entry set by Caddy, `127.0.0.1` without one), `X-Velexis-End-User-Agent` (at most 512 characters) and `X-Velexis-Bff-Key` (`PLATFORM_BFF_KEY`). Admin sign-in is throttled per admin IP, and admin audit rows record it ([PADR-0019](../docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md)). The sign-in calls and the middleware's refresh carry them too.
- `lib/errors.ts` maps every code of the platform catalogue to the admin's own message (`lib/strings.ts`); `errors.test.ts` fails when the catalogue gains a code without one.

## 5. Configuration

See [`.env.example`](.env.example); on the VM `/etc/velexis/platform-admin.env` (template [`deploy/env/platform-admin.env.example`](../../deploy/env/platform-admin.env.example)): `APP_ENV`, `LOG_LEVEL`, `PORT` (3001), `HOSTNAME` (`127.0.0.1`), `PLATFORM_API_URL`, `PLATFORM_BFF_KEY` (shared with the API, PADR-0019), `PUBLIC_PLATFORM_ADMIN_URL`, `PUBLIC_PORTAL_URL` (link to enable MFA in the portal), `SENTRY_DSN`. All are read in server code through `@velexis/config`. On the VM the systemd unit sets `PORT` and `HOSTNAME`.

`src/lib/config.ts` (`import "server-only"`) declares the schema `ADMIN_CONFIG_SCHEMA`; later tasks add their entries there.

| Variable | Rule | Default |
|---|---|---|
| `APP_ENV` | `development`, `test` or `production` | required |
| `LOG_LEVEL` | a pino level (`fatal` … `trace`, `silent`) | `info` |
| `PORT` | 1–65535 | `3001` |
| `HOSTNAME` | host name or IP literal to bind | `127.0.0.1` |
| `PLATFORM_API_URL` | absolute `http:` or `https:` URL | required |
| `PLATFORM_BFF_KEY` | at least 32 characters of `[A-Za-z0-9_-]` (refuses the unsubstituted `@@PLATFORM_BFF_KEY@@`); the same value as the API and the portal | required |
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
| `pnpm --filter @velexis/platform-admin test` | Vitest: configuration, health route handlers and the static headers of `next.config.ts`, the API client and the end-user headers, session cookies and the single-flight refresh, the middleware, `/sign-out`, the error messages (Node, `fetch` mocked, fake timers), and the two sign-in steps with Testing Library (`sign-in.test.tsx`, `// @vitest-environment happy-dom`). |
| `pnpm --filter @velexis/platform-admin lint` / `typecheck` | ESLint with the root flat config (Next.js rules included) / `tsc --noEmit` (strict, path alias `@/*` → `src/*`) |
| `pnpm test:e2e -- --project=platform-admin` | Playwright: admin sign-in with TOTP; suspend and resume a tenant and see the storefront follow; retry a failed provisioning job (M1); assign and release an office (M1/M5); approve and mark a settlement paid (M5) |

**Health and headers without a browser.** After a build, `PORT=3001 APP_ENV=development PLATFORM_API_URL=http://127.0.0.1:3100 PLATFORM_BFF_KEY=dev_bff_key_change_me_0123456789abcdef PUBLIC_PLATFORM_ADMIN_URL=http://localhost:3001 PUBLIC_PORTAL_URL=http://localhost:3000 node .next/standalone/platform/admin/server.js` serves the standalone build (it sets `NODE_ENV=production`, so no `.env.local` is read), and `curl -i http://127.0.0.1:3001/health/live` shows `200` with `X-Robots-Tag: noindex`. The unit test `src/app/health/live/route.test.ts` checks the same headers by compiling the rules of `next.config.ts` with Next.js's own route matcher, for `/health/live` and other paths.

**Tests in Node.** `server-only` throws outside the `react-server` export condition, which only Next.js sets, so `vitest.config.ts` maps it to the package's own empty module. The `@/` alias matches `tsconfig.json`.

**postcss override.** Next.js 15 pins `postcss` 8.4.31, which has high-severity advisories. The root `package.json` overrides `next>postcss` to the patched version that Tailwind CSS already uses (the same override as the portal), so `pnpm audit --prod` stays clean. Remove the override once Next.js ships a patched `postcss`.

**Adding a shadcn/ui component.** From `platform/admin`, run the CLI pinned to the 2.x line of [`tech-stack.md`](../../docs/mvp/tech-stack.md), for example `pnpm dlx shadcn@2.10.0 add table`. `components.json` sends the copy to `src/components/ui/` with the `new-york` style, CSS variables and lucide icons, and `cn()` to `src/lib/utils.ts`. The CLI adds the component's dependencies with `^` ranges: make them exact in `package.json` before committing (`tools/ci/check-package-json.mjs` fails otherwise). The design tokens in `globals.css` are a copy of the portal's: change the portal, the platform admin and the OTA admin together ([ADR-0014](../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md)).

The `dev:seed` command of the backend creates a development admin and prints its TOTP set-up URI to the console (refused when `APP_ENV=production`). End-to-end tests create their own admin through test builders and compute TOTP codes from the secret they generated ([`../backend/README.md`](../backend/README.md)).
