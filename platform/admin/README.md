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
  components/ui/                        shadcn/ui copies
  components/                           AdminShell, DataTable, StatusBadge, ReasonDialog, StepUpDialog,
                                        ConfirmDialog, JsonView (id-only payloads, audit details), MaskedValue,
                                        RevealPanel (payout account, auto-hides after 60 s), FilterBar, Money, DateTime
  lib/api.ts, lib/session.ts, lib/errors.ts, lib/strings.ts
  middleware.ts
```

## 4. Data fetching, actions and session

- Server components read through `lib/api.ts` with `cache: "no-store"`; lists use URL search params for filters and the cursor, so pages are linkable.
- Every mutation is a server action that validates with Zod, sends `If-Match` where the resource is versioned, passes the reason when required, and handles `REAUTH_REQUIRED` with `StepUpDialog` (TOTP → `adminStepUp` → retry).
- Revealed payout details come back from a server action and render in memory only; the panel hides them after 60 seconds and offers no copy-to-clipboard of the full value in logs or URLs.
- Cookies: `__Host-vxa_at` (admin access token, 15 minutes) and `__Host-vxa_rt` (refresh, 12-hour family), `HttpOnly; Secure; SameSite=Strict; Path=/`; `__Host-vxa_mfa` during sign-in. Middleware refreshes the access token (single-flighted in the process) and redirects to `/sign-in` without a session.
- Portal sessions do not work here and admin sessions do not work in the portal: different cookies on different hosts and different token audiences ([PADR-0009](../docs/adr/0009-platform-api-surface-and-authentication.md)).
- Security headers as the portal, with `form-action 'self'` and `X-Robots-Tag: noindex`.

## 5. Configuration

See [`.env.example`](.env.example): `APP_ENV`, `LOG_LEVEL`, `PORT` (3001), `HOSTNAME` (`127.0.0.1`), `PLATFORM_API_URL`, `PUBLIC_PLATFORM_ADMIN_URL`, `PUBLIC_PORTAL_URL` (link to enable MFA in the portal), `SENTRY_DSN`.

## 6. Commands and tests

| Command | Does |
|---|---|
| `pnpm --filter @velexis/platform-admin dev` | Dev server on port 3001 (needs the platform API) |
| `pnpm --filter @velexis/platform-admin build` | Standalone build |
| `pnpm --filter @velexis/platform-admin test` | Vitest + Testing Library: reason and step-up dialogs, tables, form states |
| `pnpm test:e2e -- --project=platform-admin` | Playwright: admin sign-in with TOTP; suspend and resume a tenant and see the storefront follow; retry a failed provisioning job (M1); assign and release an office (M1/M5); approve and mark a settlement paid (M5) |

The `dev:seed` command of the backend creates a development admin and prints its TOTP set-up URI to the console (refused when `APP_ENV=production`). End-to-end tests create their own admin through test builders and compute TOTP codes from the secret they generated ([`../backend/README.md`](../backend/README.md)).
