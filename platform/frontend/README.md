# Portal (`@velexis/platform-frontend`)

This is the Velexis portal at `platform.example.com`: the Next.js 15 App Router app where people sign up, create and pay for an OTA, manage API keys, domains, Amadeus and Stripe connections, team and billing, and open the OTA admin. It is a backend-for-frontend: every call to the platform API happens on the server, and tokens live only in httpOnly cookies. This page is the component specification: route map, components, data fetching, auth cookies, configuration and tests.

Related: [`../docs/scope.md`](../docs/scope.md) (features and roles), [`../docs/api-inventory.md`](../docs/api-inventory.md), [flows](../docs/README.md#flows), [ADR-0014](../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md), [`conventions.md` §3](../../docs/mvp/conventions.md#3-nextjs-apps-portal-platform-admin-ota-admin), [`.env.example`](.env.example).

## 1. At a glance

| Item | Value |
|---|---|
| Stack | Next.js 15 App Router, React 19, TypeScript strict, Tailwind CSS 4, shadcn/ui, `lucide-react`, Zod (forms only) |
| API client | `openapi-fetch` typed by `@velexis/api-types/platform`, in `src/lib/api.ts` (`import "server-only"`) |
| Port | `127.0.0.1:3000`, unit `velexis-portal.service`, Next.js `standalone` output |
| Host | `https://platform.example.com` |
| Talks to | Platform API only (`PLATFORM_API_URL`); browser navigations to Stripe (Checkout, Customer Portal, Connect) and to `admin.ota.example.com/sso` |

## 2. Route map

Route groups: `(marketing)` public pages, `(auth)` sign-in flows, `(app)` signed-in shell. "Role" is the minimum membership role from [`../docs/scope.md`](../docs/scope.md) §1.2; the backend enforces it again.

### Public

| Route | Purpose | API | M |
|---|---|---|---|
| `/` | Marketing landing (static content, call to action) | — | M1 |
| `/pricing` | Public plans with limits; "Start" links to sign-up with the plan preselected | `listPlans` | M1 |
| `/legal/terms`, `/legal/privacy` | Static legal pages (versioned terms label used at sign-up) | — | M1 |

### Auth

| Route | Purpose | API | M |
|---|---|---|---|
| `/sign-up` | Name, e-mail, password, terms | `signUp` | M1 |
| `/sign-up/check-email` | "Check your e-mail", resend | `resendVerification` | M1 |
| `/verify-email` (route handler, GET) | Consumes `?token=`, then `303` to `/sign-in?verified=1` or `/dashboard`; `Referrer-Policy: no-referrer` | `verifyEmail` | M1 |
| `/sign-in` | E-mail and password; `next` return path (relative paths only) | `signIn` | M1 |
| `/sign-in/mfa` | TOTP or recovery code | `verifyMfa` | M1 |
| `/forgot-password` | Request a reset link | `requestPasswordReset` | M1 |
| `/reset-password` | Token moved from the URL into a 15-minute cookie, then new-password form | `confirmPasswordReset` | M1 |
| `/invitations/accept` | Token moved into a 15-minute cookie; shows the invitation; sign in or sign up; accept | `lookupInvitation`, `acceptInvitation` | M1 |
| `/verify-pending` | Only page for signed-in, unverified accounts | `getMe`, `resendVerification` | M1 |

### Signed in

| Route | Purpose | Role | API | M |
|---|---|---|---|---|
| `/dashboard` | My OTAs (status, plan, storefront link, role), "Create OTA" | any account | `listTenants`, `getMe` | M1 |
| `/otas/new` | Create-OTA wizard: 1 details (name, key with live availability, country, currency, time zone), 2 plan and interval (M5), 3 review; submit sends one `Idempotency-Key`; redirects to Stripe Checkout (M5) or the setup page | verified account | `checkTenantKey`, `listPlans`, `createTenant` | M1, M5 |
| `/otas/[tenantId]/setup` | Provisioning progress (polls every 2 s), "Continue to payment" when Checkout is pending, failure with retry, one-time reveal of the test keys | member (retry, reveal: owner) | `getProvisioning`, `retryProvisioning`, `revealInitialKeys`, `createCheckoutSession` | M1 |
| `/otas/[tenantId]` | OTA dashboard: status and banners (suspended, `billing_notice`, test mode), storefront link, onboarding checklist, "Open console" | member | `getTenant`, `getOnboarding` | M1 |
| `/otas/[tenantId]/api-keys` | Test and live tabs; create (show once), edit origins, roll, revoke | owner, admin | api-keys endpoints | M1 |
| `/otas/[tenantId]/domains` | Sub-domain, custom domains with DNS records, check now, make primary, remove | member (changes: owner, admin) | domains endpoints | M1 (list), M5 |
| `/otas/[tenantId]/amadeus` | Test and live connections, office settings, request live access, own credentials with submission status | owner, admin, finance (read) | Amadeus endpoints | M1, M4, M5 |
| `/otas/[tenantId]/payments` | Stripe connection per environment (mode, status, capabilities), descriptor suffix, Connect, API keys, back to Velexis | owner, admin, finance (read) | payment-connection endpoints | M1, M3, M5 |
| `/otas/[tenantId]/payments/payout-account` | Payout bank account (masked, review status), edit with step-up | owner (edit), finance (read) | `getPayoutAccount`, `setPayoutAccount` | M5 |
| `/otas/[tenantId]/payments/settlements` and `/[settlementId]` | Statements, totals, CSV download | owner, finance | settlement endpoints | M5 |
| `/otas/[tenantId]/team` | Members, roles, remove, leave; invitations, resend, revoke | member (changes: owner, admin) | membership endpoints | M1 |
| `/otas/[tenantId]/billing` | Plan, status, banner; choose plan (Checkout); manage in Stripe Customer Portal; invoices | owner, finance (read) | `getSubscription`, `createCheckoutSession`, `createCustomerPortalSession`, `listInvoices` | M1 (plan), M5 |
| `/otas/[tenantId]/settings` | OTA profile (name, legal name, support e-mail, country, time zone) | owner, admin | `getTenant`, `updateTenant` | M1 |
| `/otas/[tenantId]/go-live` | Checklist of live preconditions and the switch (step-up) | owner | `getOnboarding`, `goLive` | M5 |
| `/console` | OTA picker used by the OTA admin's "no session" redirect (`?tenant=`) | any account | `listTenants` | M4 |
| `/account` | Profile (name, locale, time zone) | any account | `getMe`, `updateMe` | M1 |
| `/account/security` | Password, MFA set-up (QR) and recovery codes, sessions, sign out everywhere | any account | account endpoints | M1 |

### Route handlers (only where a URL is needed)

| Route | Method | Purpose |
|---|---|---|
| `/otas/[tenantId]/console/launch` | POST | Checks `Origin`, calls `createConsoleToken`, returns the auto-submitting form to `PUBLIC_OTA_ADMIN_URL/sso` ([PADR-0007](../docs/adr/0007-portal-to-ota-admin-sso-token.md)) |
| `/connect/stripe/callback` | GET | Stripe Connect redirect target: posts `{code, state}` to `completeStripeConnect`, then `303` to the payments page |
| `/otas/[tenantId]/payments/settlements/[settlementId]/lines.csv` | GET | Streams the CSV from the API with the user's token |
| `/sign-out` | POST | Revokes the session and clears cookies |
| `/health/live`, `/health/ready` | GET | Health ([ADR-0016](../../docs/mvp/adr/0016-observability.md)); `ready` checks that the platform API answers |

## 3. Folder layout

```
platform/frontend/src/
  app/
    (marketing)/page.tsx, pricing/page.tsx, legal/…
    (auth)/sign-up/…, sign-in/…, sign-in/mfa/…, forgot-password/…, reset-password/…, invitations/accept/…, verify-pending/…
    verify-email/route.ts
    (app)/layout.tsx                    signed-in shell: sidebar, OTA switcher, banners
    (app)/dashboard/page.tsx
    (app)/otas/new/page.tsx, actions.ts, wizard-*.tsx
    (app)/otas/[tenantId]/layout.tsx    loads the tenant and the caller's role once
    (app)/otas/[tenantId]/<area>/page.tsx, actions.ts, *-form.tsx
    (app)/otas/[tenantId]/console/launch/route.ts
    (app)/console/page.tsx
    (app)/account/…
    connect/stripe/callback/route.ts
    health/live/route.ts, health/ready/route.ts
  components/ui/                        shadcn/ui copies
  components/                           app components (below)
  lib/api.ts                            openapi-fetch client, bearer from cookies, server-only
  lib/session.ts                        cookie read/write, single-flight refresh, server-only
  lib/errors.ts                         API error code → user message
  lib/roles.ts                          role matrix for navigation (mirrors the backend)
  lib/strings.ts                        UI strings (English)
  middleware.ts                         auth redirects, access token refresh, unverified redirect
```

## 4. Components

| Component | Used for |
|---|---|
| `AppShell`, `OtaSwitcher`, `SideNav` | Signed-in layout; navigation filtered by role and by `features` from `getMe` |
| `TenantBanner` | Suspended (with reason and billing link), `past_due` and `trial_ending`, "Test mode" |
| `StatusBadge` | Tenant, job, connection, domain, settlement statuses |
| `ProvisioningProgress` | Steps with live polling (client component calling a server action) |
| `OnboardingChecklist` | Items with links, done state |
| `Wizard`, `KeyAvailabilityField`, `PlanPicker` | Create-OTA wizard |
| `SecretRevealPanel`, `CopyField` | Show-once API keys, initial keys, recovery codes; warns that the value cannot be shown again |
| `StepUpDialog` | TOTP prompt when an action returns `REAUTH_REQUIRED`; retries the action with the new session |
| `DnsRecordsTable` | Records to create and last check result |
| `ConnectionCard` | Amadeus and Stripe connection summaries, pending submission state |
| `ScopePicker`, `OriginsField` | API key scopes and origins with the rules of [PADR-0005](../docs/adr/0005-api-key-format-and-hashing.md) |
| `MembersTable`, `InviteForm` | Team page |
| `DataTable` | shadcn data table (invoices, settlements, keys) |
| `ConfirmDialog` | Destructive actions (revoke, remove, switch mode) |
| `FormField`, `FormErrorSummary` | Labels, `aria-describedby` errors, focus on the summary |
| `Money`, `DateTime` | `Intl` formatting |

## 5. Data fetching and mutations

- **Reads** happen in server components through `lib/api.ts`, with `cache: "no-store"`. `otas/[tenantId]/layout.tsx` loads the tenant and the caller's role once per request and passes them down.
- **Mutations** are server actions (`actions.ts` next to the page): validate with Zod, call the API, map `fieldErrors` to the form, return state for `useActionState`, then `revalidatePath` or `redirect`. Actions that answer `REAUTH_REQUIRED` return a `stepUp` state; the `StepUpDialog` calls the `stepUp` action and re-submits.
- **Secrets shown once** (API keys, initial keys, recovery codes, MFA set-up secret) are returned by the action and rendered by a client component in memory only; they are never put in cookies, URLs, `localStorage` or the Next.js cache.
- **Polling** (setup page, credential submissions) uses a client component that calls a server action every 2 seconds and stops at a final state.
- **Errors** map codes to messages in `lib/errors.ts`; `error.tsx` per area; raw messages from the API are never shown.
- **External navigations** (Checkout, Customer Portal, Connect authorise URL) are `redirect()` calls in server actions with URLs returned by the API, never assembled in the browser.

## 6. Auth cookies and session

| Cookie | Content | Lifetime | Flags |
|---|---|---|---|
| `__Host-vxp_at` | Platform access token (JWT) | 15 minutes | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `__Host-vxp_rt` | Refresh token | Until the family's absolute expiry (30 days) | same |
| `__Host-vxp_mfa` | MFA challenge token during sign-in | 5 minutes | same, `SameSite=Strict` |
| `__Host-vxp_reset`, `__Host-vxp_invite` | Reset or invitation token moved out of the URL | 15 minutes | same, `SameSite=Strict` |
| `__Host-vxp_next` | Validated relative return path | 15 minutes | same |

- `middleware.ts` refreshes an expired access token before rendering. Refresh is **single-flighted** inside the one portal process (in-memory map keyed by the refresh token hash, 10 s), so parallel requests never present a rotated token twice and trip reuse detection.
- Unauthenticated `(app)` requests redirect to `/sign-in?next=…`; unverified accounts go to `/verify-pending`.
- Server actions rely on Next.js's Origin check; route handlers that change state check `Origin` against `PUBLIC_PORTAL_URL` explicitly.
- No `NEXT_PUBLIC_` variable holds a key or token. Client components never import `lib/api.ts` or `lib/session.ts`.

## 7. Security headers

Set in `next.config` `headers()` and middleware: CSP with a per-request nonce (`script-src 'self' 'nonce-…'`, `connect-src 'self'`, `img-src 'self' data:`, `form-action 'self'` plus the origin of `PUBLIC_OTA_ADMIN_URL` (`https://admin.ota.example.com` in production), `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`), `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on token pages), `X-Content-Type-Options: nosniff`, `Permissions-Policy` minimal. Stripe pages are reached by navigation, never framed.

## 8. Configuration

See [`.env.example`](.env.example). Variables: `APP_ENV`, `LOG_LEVEL`, `PORT` (3000), `HOSTNAME` (`127.0.0.1`), `PLATFORM_API_URL`, `PUBLIC_PORTAL_URL`, `PUBLIC_OTA_ADMIN_URL`, `STOREFRONT_BASE_DOMAIN`, `SENTRY_DSN`. All read in server code through `@velexis/config`.

## 9. Commands and tests

| Command | Does |
|---|---|
| `pnpm --filter @velexis/platform-frontend dev` | Next.js dev server on port 3000 (needs the platform API on 3100) |
| `pnpm --filter @velexis/platform-frontend build` | Standalone build |
| `pnpm --filter @velexis/platform-frontend test` | Vitest + Testing Library for client components and form states |
| `pnpm test:e2e -- --project=portal` | Playwright journeys in `tools/e2e` |

End-to-end journeys (with axe checks): sign-up → verify (Mailpit) → sign-in with MFA → create OTA → active (M1); API key create and revoke (M1); invitation accept and role change (M1); open console lands in the OTA admin (M4); Checkout with Stripe test mode and the Customer Portal link (M5); custom domain pending view (M5).
