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

How sign-up and verification behave (PFE-005; [flow](../docs/flows/signup-and-create-ota.md) steps 1–3, PADR-0008):

- **`/sign-up`** (`sign-up-form.tsx`, action `signUp` in `actions.ts`). Zod checks the form on the server first: a full name (trimmed, at most 200 characters), an e-mail address (trimmed, at most 254), a password of 10 to 256 characters (counted in Unicode code points, as the API counts them) and the terms checkbox. The action then calls `signUp` with `acceptTerms: true` and `termsVersion` of `lib/terms.ts`. The API's field errors are mapped by JSON pointer to the form's own messages (`PASSWORD_TOO_WEAK` with `too_short` or `breached` lands on the password field), `RATE_LIMITED` and other failures show above the form, and `202` redirects to `/sign-up/check-email`. A refused submission keeps the name, the address and the checkbox, never the password.
- **`/sign-up/check-email`** reads the same for a new and an already registered address and asks for the address to send a new link to (the portal keeps no copy of it). **`/verify-pending`** shows a signed-in, unverified account its own address, a "send a new link" button for it and "Sign out"; a visitor without a session types the address. Both use `resendVerificationLink` (`verify-pending/actions.ts`): the confirmation never says whether the address has an account, and `RATE_LIMITED` shows the 3-links-per-hour message.
- **`/verify-email?token=…`** (`verify-email/route.ts`) calls `verifyEmail` on the server without a bearer token and answers `303` to a URL without the token, with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`: `/sign-in?verified=1` without a session; for a signed-in account it first renews the session through the single-flight `refresh()` (the old access token still says `ev: false`, which the middleware would send back to `/verify-pending`) and continues to `/dashboard`. An expired, used, unknown or malformed token goes to `/verify-pending?error=token`, a rate limit or an unavailable API to `/verify-pending?error=unavailable`. Redirects use `PUBLIC_PORTAL_URL`. Only `GET` consumes the token: `HEAD` answers `204` with the same two headers and never calls the API, because Next.js would otherwise answer `HEAD` by running `GET`, and link checkers and mail scanners send `HEAD` to the links they find.
- An account verified in another tab or browser keeps an access token with `ev: false` until it is renewed: `/verify-pending` then shows "Your e-mail address is verified" with a "Continue" button (`continueAfterVerification`), which refreshes the session and goes to `/dashboard`.

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
| `/health/live`, `/health/ready` | GET | Health ([ADR-0016](../../docs/mvp/adr/0016-observability.md)), `Cache-Control: no-store`. `live` answers `200 {"status":"ok"}` while the process serves requests. `ready` calls `PLATFORM_API_URL/health/live` and answers `200 {"status":"ok","checks":{"platformApi":"ok"}}` when it answers 2xx within 2 seconds, otherwise `503` with `"status":"unavailable"` and `"platformApi":"down"` (refused, error status, redirect or timeout; the cause is not exposed). `deploy.sh` polls `ready` after every restart. |

## 3. Folder layout

```
platform/frontend/src/
  app/
    (marketing)/page.tsx, pricing/page.tsx, legal/…
    (auth)/sign-up/…, sign-in/…, sign-in/mfa/…, forgot-password/…, reset-password/…, invitations/accept/…, verify-pending/…
    verify-email/route.ts
    (app)/layout.tsx                    signed-in shell: loads getMe once, renders AppShell around the page
    (app)/step-up-actions.ts            the stepUp server action of StepUpDialog (README §5)
    (app)/dashboard/page.tsx
    (app)/otas/new/page.tsx, actions.ts, wizard-*.tsx
    (app)/otas/[tenantId]/layout.tsx    loads the tenant and the caller's role once
    (app)/otas/[tenantId]/<area>/page.tsx, actions.ts, *-form.tsx
    (app)/otas/[tenantId]/console/launch/route.ts
    (app)/console/page.tsx
    (app)/account/…
    connect/stripe/callback/route.ts
    health/live/route.ts, health/ready/route.ts
    layout.tsx                          root layout: lang="en", skip link to #main-content, globals.css
    globals.css                         Tailwind CSS 4 entry and the design tokens (@theme)
  components/ui/                        shadcn/ui copies: alert, alert-dialog, badge, button, dialog, dropdown-menu, input,
                                        label, sonner (the CLI's toast), table, tabs (components.json configures the CLI)
  components/                           app components (below)
  lib/config.ts                         configuration schema and getConfig(), server-only (§8)
  lib/utils.ts                          cn(): class-name merge helper used by the shadcn/ui copies
  lib/api.ts                            openapi-fetch client, bearer from cookies, server-only
  lib/session.ts                        cookie read/write, single-flight refresh, server-only
  lib/end-user.ts                       end-user IP, user agent and BFF key headers (PADR-0019), server-only
  lib/errors.ts                         API error code → user message
  lib/csp.ts                            nonce and Content-Security-Policy of every response
  lib/roles.ts                          role matrix of scope §1.2 and the navigation it allows (mirrors the backend)
  lib/strings.ts                        UI strings (English), including one message per error code
  lib/terms.ts                          the current termsVersion that sign-up sends
  middleware.ts                         access token refresh, auth and unverified redirects, CSP (Node.js runtime)
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

How the shared components behave (PFE-003; `src/components/`):

- **Shell.** `(app)/layout.tsx` calls `getMe` once per request and renders `AppShell` (a server component): the sidebar with `OtaSwitcher` and `SideNav`, a header with the account and a "Sign out" form posting to `/sign-out`, the toaster, and the page inside `<main id="main-content">` (pages inside the shell render no `<main>` of their own). `getMe` answering `UNAUTHENTICATED` or `TOKEN_EXPIRED` redirects to `/sign-in`, an unverified account to `/verify-pending`; any other failure shows the message of its code instead of the shell. Only the memberships and the switches reach the browser components.
- **Navigation.** `lib/roles.ts` holds the matrix of [scope §1.2](../docs/scope.md) (`PORTAL_ACTIONS`, `can(role, action)`) and the entries of an OTA with the action each needs: overview and domains for every member; API keys, team (team management) and settings for owners and admins; Amadeus and payments (the connection settings) for owners, admins and finance; billing for owners and finance; payout account and settlements for owners and finance while `features.settlements` is on; go-live for owners while `features.liveSwitch` is on. `SideNav` reads the OTA from the path (`/otas/<tenantId>/…`) and marks the current page with `aria-current="page"`; outside an OTA it shows the account entries only. `OtaSwitcher` lists every membership (set-up page while an OTA is `provisioning` or `failed`), "All OTAs" and "Create an OTA".
- **`TenantBanner`** takes the tenant of `getTenant` and the caller's role: suspended (reason of PADR-0014; the billing link only for roles that see billing), `past_due`, `trial_ending` and "Test mode". Suspended and `past_due` are alerts, the others status messages.
- **`StatusBadge kind status`** names each status in words with a tone; the kinds and statuses are typed from the platform document (settlements from [`data-model.md`](../docs/data-model.md) until M5), and a status the portal does not know yet still renders.
- **Step-up.** An action whose API call answers `REAUTH_REQUIRED` returns `{ stepUp: true }` in its state (`StepUpRequired` of `(app)/step-up-actions.ts`). The form uses `useStepUpAction(action, initialState)` instead of `useActionState` and renders the returned `stepUpDialog` next to its `<form action={dispatch}>`: the dialog asks for the TOTP code, the `stepUp` action calls `POST /v1/auth/step-up` and stores the new session in the cookies, and the original action runs again with the same `FormData`, now with the new access token. A wrong code stays in the dialog with the message at the field; cancelling keeps the state.
- **Shown once.** `SecretRevealPanel` renders the values an action returned with `CopyField`s and the warning that they cannot be shown again; "I have stored it" removes them from the page (`onDismiss` lets the caller drop its copy). The values live in React state only; the fields have no `name` (a form never submits them) and no autocomplete, and copying writes to the clipboard on request only.
- **Forms.** `FormField` (server or client) renders a visible label, an optional hint and the error, both linked to the control with `aria-describedby`, and `aria-invalid` on error; its control id is `fieldId(name)` unless given, and a render prop takes other controls (select, textarea). `FormErrorSummary` takes the focus when it gets a new errors array and links each entry to its field.
- **`ConfirmDialog`** is an alert dialog (focus on "Cancel", Escape cancels, no close on an outside click) that calls `onConfirm` and closes. **`DataTable`** is the shadcn data table on TanStack Table with a caption (visually hidden by default), `scope="col"` headers and an empty message; its columns live in a client module next to the page.
- **`Money`** formats the decimal string of `{ amount, currency }` with `Intl.NumberFormat` (the string goes to `Intl` as it is, never through a float; every digit of the amount is kept), **`DateTime`** an ISO instant with `Intl.DateTimeFormat` in an explicit time zone (UTC by default) inside `<time dateTime>`; both use the portal's `en` locale, so the server and the browser render the same text.

## 5. Data fetching and mutations

- **Reads** happen in server components through `lib/api.ts`, with `cache: "no-store"`. `otas/[tenantId]/layout.tsx` loads the tenant and the caller's role once per request and passes them down.
- **Mutations** are server actions (`actions.ts` next to the page): validate with Zod, call the API, map `fieldErrors` to the form, return state for `useActionState`, then `revalidatePath` or `redirect`. Actions that answer `REAUTH_REQUIRED` return a `stepUp` state (`{ stepUp: true }`); the `StepUpDialog` of `useStepUpAction` calls the `stepUp` action and re-submits (§4).
- **Secrets shown once** (API keys, initial keys, recovery codes, MFA set-up secret) are returned by the action and rendered by a client component in memory only; they are never put in cookies, URLs, `localStorage` or the Next.js cache.
- **Polling** (setup page, credential submissions) uses a client component that calls a server action every 2 seconds and stops at a final state.
- **Errors** map codes to messages in `lib/errors.ts`; `error.tsx` per area; raw messages from the API are never shown.
- **External navigations** (Checkout, Customer Portal, Connect authorise URL) are `redirect()` calls in server actions with URLs returned by the API, never assembled in the browser.
- **The API client** (`lib/api.ts`, `server-only`). `platformApi()` returns the client for the request being rendered: `openapi-fetch` typed by `@velexis/api-types/platform`, base URL `PLATFORM_API_URL`, `Authorization: Bearer` from `__Host-vxp_at` (none without a session), the request's `X-Request-Id` when it is valid (Caddy sets one on every request; `middleware.ts` creates one in development), `cache: "no-store"`, and `redirect: "manual"` so the bearer token never follows a redirect. `createPlatformApi({ baseUrl, bffKey, requestHeaders, accessToken? })` builds the same client from explicit values; `middleware.ts` uses it for the refresh. Every method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) takes the path and options of `openapi-fetch` (a caller's `baseUrl`, `fetch`, `Request`, `cache` and `redirect` are dropped, so the token only ever goes to `PLATFORM_API_URL` and nothing is cached) and answers `{ data }` or `{ error }`, never throws: `error` is `{ code, status, fieldErrors, details, requestId?, retryAfterSeconds? }`, where `code` is always a code of the platform catalogue (an answer without a valid envelope becomes `SERVICE_UNAVAILABLE` for 502, 503 and 504 or an unreachable API, and `INTERNAL_ERROR` otherwise). The API's `message` and the `message` of each field error are dropped on purpose, so a page can only show the portal's own text.

  ```ts
  const api = await platformApi();
  const me = await api.GET("/v1/me");                   // typed by the platform document
  if (me.error) return { message: errorMessage(me.error) };
  const updated = await api.PATCH("/v1/me", { body: { fullName }, params: { header: { "If-Match": etag } } });
  ```
- **End-user IP and user agent.** The API's per-IP rate limits and audit rows need the visitor's address, not the portal server's. `lib/api.ts` sends on every call, including the refresh in `middleware.ts`: `X-Velexis-End-User-IP` (the right-most `X-Forwarded-For` entry, which Caddy sets; `127.0.0.1` when there is none in development), `X-Velexis-End-User-Agent` (the browser's `User-Agent`, at most 512 characters) and `X-Velexis-Bff-Key` (`PLATFORM_BFF_KEY`). A browser-supplied left-most `X-Forwarded-For` entry is never used ([PADR-0019](../docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md)). The headers are set after the caller's own headers, so a caller cannot replace them. The address is passed on as Caddy wrote it; the API answers a malformed one with `400 VALIDATION_FAILED`, so a proxy misconfiguration shows at once.

## 6. Auth cookies and session

| Cookie | Content | Lifetime | Flags |
|---|---|---|---|
| `__Host-vxp_at` | Platform access token (JWT) | 15 minutes | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `__Host-vxp_rt` | Refresh token | Until the family's absolute expiry (30 days) | same |
| `__Host-vxp_mfa` | MFA challenge token during sign-in | 5 minutes | same, `SameSite=Strict` |
| `__Host-vxp_reset`, `__Host-vxp_invite` | Reset or invitation token moved out of the URL | 15 minutes | same, `SameSite=Strict` |
| `__Host-vxp_next` | Validated relative return path | 15 minutes | same |

`lib/session.ts` (`server-only`) owns the names and attributes. `sessionCookies(session)` gives both session cookies of a `PortalSession`, each living as long as its token (`accessTokenExpiresAt`, at most 15 minutes; `refreshTokenExpiresAt`, the refresh token's idle expiry and never after the family's 30 days); `mfaChallengeCookie`, `passwordResetCookie`, `invitationCookie` and `nextPathCookie` give the flow cookies; `writeCookies(sink, writes)` writes them to `cookies()` (actions, route handlers) or `NextResponse#cookies` (middleware), and `setSession()` / `clearSession()` do it for the session in one call. Cookies are deleted by `clearedCookie(name)`: an empty value with the same attributes and `Max-Age=0`, because a browser ignores a `__Host-` deletion without `Secure` (which `cookies().delete()` would send).

- `middleware.ts` refreshes an access token that is missing, unreadable or expires within 30 seconds before rendering, when a refresh token is there. It reads `exp` and `ev` from the token without checking the signature (the API checks it on every call; a forged cookie gets no further than pages whose calls answer 401). The new tokens are set on the response **and** replace the old ones in the request's own `Cookie` header, so the page rendered for that request already uses them; an expired access token is never passed on to a page.
- Refresh is **single-flighted** inside the one portal process (`refresh()`, an in-memory map keyed by the SHA-256 of the refresh token): every request that presents the same refresh token while the call is pending, or within 10 seconds after it succeeded or failed for good, gets the same outcome without a second call, so parallel requests never present a rotated token twice and trip reuse detection. The middleware runs in the Node.js runtime (`export const config = { runtime: "nodejs" }`), in the portal process itself, which is what makes the map shared by all requests.
- `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`, `VALIDATION_FAILED` and `UNAUTHENTICATED` end the session: both cookies are deleted. A failure that may pass (rate limit, API unavailable) keeps the cookies and is not remembered, so the next request tries again; the request itself continues without a session.
- Unauthenticated requests for the `(app)` area (`/dashboard`, `/otas`, `/console`, `/account` and below) get `303` to `PUBLIC_PORTAL_URL/sign-in?next=<path and query>`; an account whose token says `ev: false` gets `303` to `/verify-pending`. Other paths (public pages, the `(auth)` pages, route handlers outside `(app)`) pass with or without a session.
- **`next` is a relative path only.** `safeNextPath()` keeps a value only when it starts with a single `/`, has no backslash or control character, is at most 2 048 characters long, and resolves to the portal's own origin; `https://evil.example/x`, `//evil.example`, `/\evil.example` and the like are dropped. The middleware applies it to the `next` it writes, `nextPathCookie()` to the value it stores, and the sign-in pages to the value they redirect to.
- Server actions rely on Next.js's Origin check; route handlers that change state check `Origin` against `PUBLIC_PORTAL_URL` explicitly.
- No `NEXT_PUBLIC_` variable holds a key or token. Client components never import `lib/api.ts` or `lib/session.ts`.

## 7. Security headers

Set in `next.config` `headers()` and middleware: CSP with a per-request nonce (`script-src 'self' 'nonce-…'`, `connect-src 'self'`, `img-src 'self' data:`, `form-action 'self'` plus the origin of `PUBLIC_OTA_ADMIN_URL` (`https://admin.ota.example.com` in production), `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`), `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on token pages), `X-Content-Type-Options: nosniff`, `Permissions-Policy` minimal. Stripe pages are reached by navigation, never framed.

The policy of `lib/csp.ts`, set by `middleware.ts` on every response it handles (pages, server actions, route handlers, redirects) with a fresh 128-bit nonce:

```text
default-src 'self'; script-src 'self' 'nonce-<nonce>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; form-action 'self' <origin of PUBLIC_OTA_ADMIN_URL>; frame-ancestors 'none';
base-uri 'self'; object-src 'none'
```

- The middleware also puts the policy and the nonce (`x-nonce`) on the request headers; Next.js reads the nonce from there and adds it to every script it renders. A server component that renders its own `<script>` reads `x-nonce` from `headers()`.
- **Every page is rendered per request** (`export const dynamic = "force-dynamic"` in the root layout): a prerendered page would keep inline scripts without the nonce, and the policy would block them.
- `'unsafe-eval'` is added to `script-src` only when `APP_ENV=development`, because `next dev` evaluates modules with `eval`. Inline styles are allowed (`style` attributes of components such as Radix); inline scripts never are.

| Header | Value | Where |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | `next.config.ts`, every response (PFE-001) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | `next.config.ts`, every response (PFE-001); token pages override it with `no-referrer` |
| `Referrer-Policy` | `no-referrer` | `next.config.ts` `TOKEN_PAGES` (`/verify-email`, PFE-005), a later rule that replaces the one above, and the route handler itself. The rule is needed: Next.js sets the configured headers on the response before a route handler runs and keeps them over the handler's own value of the same header |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()` | `next.config.ts`, every response (PFE-001) |
| `Content-Security-Policy` | nonce-based, as above | `middleware.ts` with `lib/csp.ts` (PFE-002) |

`X-Powered-By` is switched off (`poweredByHeader: false`). Caddy adds `Strict-Transport-Security` and `X-Frame-Options: DENY` on the public host ([`deploy/caddy/Caddyfile`](../../deploy/caddy/Caddyfile)).

## 8. Configuration

See [`.env.example`](.env.example). On the VM they come from `/etc/velexis/platform-frontend.env` (template [`deploy/env/platform-frontend.env.example`](../../deploy/env/platform-frontend.env.example)). Variables: `APP_ENV`, `LOG_LEVEL`, `PORT` (3000), `HOSTNAME` (`127.0.0.1`), `PLATFORM_API_URL`, `PLATFORM_BFF_KEY` (shared with the API, PADR-0019), `PUBLIC_PORTAL_URL`, `PUBLIC_OTA_ADMIN_URL`, `STOREFRONT_BASE_DOMAIN`, `SENTRY_DSN`. All read in server code through `@velexis/config`.

`src/lib/config.ts` (`import "server-only"`) declares the schema `PORTAL_CONFIG_SCHEMA`; later tasks add their entries there.

| Variable | Rule | Default |
|---|---|---|
| `APP_ENV` | `development`, `test` or `production` | required |
| `LOG_LEVEL` | a pino level (`fatal` … `trace`, `silent`) | `info` |
| `PORT` | 1–65535 | `3000` |
| `HOSTNAME` | host name or IP literal to bind | `127.0.0.1` |
| `PLATFORM_API_URL` | absolute `http:` or `https:` URL | required |
| `PLATFORM_BFF_KEY` | at least 32 characters of `A–Z a–z 0–9 _ -`; the same value as the platform API and the platform admin. `provision-vm.sh` generates it (64 hex characters) in place of the template's `@@PLATFORM_BFF_KEY@@`, which is refused as a value. A secret: never logged, only sent to `PLATFORM_API_URL` as `X-Velexis-Bff-Key` ([PADR-0019](../docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md)). | required |
| `PUBLIC_PORTAL_URL`, `PUBLIC_OTA_ADMIN_URL` | absolute `http:` or `https:` URL; `https:` when `APP_ENV=production` | required |
| `STOREFRONT_BASE_DOMAIN` | lower-case DNS name with at least two labels (`ota.example.com`) | required |
| `SENTRY_DSN` | `https:` URL; unset or empty switches error tracking off | optional |

- `getConfig()` validates the process environment on first use and caches the frozen result. Outside production it first fills unset variables from `platform/frontend/.env.local`, then from the root `.env.local` (`loadDevEnvFiles`), so the root file made from the root `.env.example` is enough for `pnpm dev`.
- Call it inside request handling (route handlers, server components, server actions), never at module scope: `next build` imports modules without the runtime environment. An invalid environment therefore fails the first request that needs it, and `/health/ready` is such a request, so `deploy.sh` does not take a release live with a broken `/etc/velexis/platform-frontend.env`. The error is a `ConfigError` that names each variable and the reason, never a value.
- `parseConfig(source)` validates a plain object; the unit tests use it.
- **No browser-exposed variables.** No `NEXT_PUBLIC_` variable exists and `next.config.ts` has no `env` block, so nothing is inlined into client bundles; `src/lib/config.test.ts` fails if either appears.

## 9. Commands and tests

| Command | Does |
|---|---|
| `pnpm --filter @velexis/platform-frontend dev` | Next.js dev server on `127.0.0.1:3000` (needs the platform API on 3100; configuration from the root `.env.local`, §8) |
| `pnpm --filter @velexis/platform-frontend build` | Standalone build: `.next/standalone/platform/frontend/server.js` plus `.next/static` (`outputFileTracingRoot` is the repository root, as `deploy/scripts/pack-release.sh` expects) |
| `pnpm --filter @velexis/platform-frontend start` | Local smoke run of the production build with `next start` on `127.0.0.1:3000` (Next.js warns that standalone output is meant for `server.js`; the VM runs `node platform/frontend/server.js` from the release, unit `velexis-portal.service`) |
| `pnpm --filter @velexis/platform-frontend test` | Vitest: configuration, route handler, API client, session, middleware, error-message and role tests in Node (`src/**/*.test.ts`), with `fetch` mocked and fake timers; component tests (`src/**/*.test.tsx`) with Testing Library in happy-dom. |
| `pnpm --filter @velexis/platform-frontend lint` / `typecheck` | ESLint with the root flat config (Next.js rules included) / `tsc --noEmit` (strict, path alias `@/*` → `src/*`) |
| `pnpm test:e2e -- --project=portal` | Playwright journeys in `tools/e2e` |

`next build` also lints and type-checks. Its "Next.js plugin was not detected in your ESLint configuration" warning is a false positive: Next.js looks for the plugin in the configuration of `eslint.config.mjs` itself, while the root config enables it for `platform/frontend/**/*.{ts,tsx}`.

**postcss override.** Next.js 15 pins `postcss` 8.4.31, which has high-severity advisories (source-map path traversal). The root `package.json` overrides `next>postcss` to the patched version already used by Vite, so `pnpm audit --prod` stays clean for all three Next.js apps. Remove the override once Next.js ships a patched `postcss`.

**Tests in Node.** `server-only` throws outside the `react-server` export condition, which only Next.js sets, so `vitest.config.ts` maps it to the package's own empty module. The `@/` alias matches `tsconfig.json`.

**Component tests.** A `*.test.tsx` file starts with `// @vitest-environment happy-dom` and uses `@testing-library/react` (with `cleanup()` in `afterEach`: Vitest globals are off); `vitest.config.ts` compiles JSX with the React 19 runtime, because `tsconfig.json` keeps it for Next.js. Server modules are reached through mocks of `next/headers` (`cookies()`), `next/navigation` (`usePathname`, `redirect`) and `platformApi()`, so a server action runs for real inside a component test.

**What the shell and component tests prove** (PFE-003).

- `src/lib/roles.test.ts`: the matrix equals scope §1.2 row by row; the navigation of each of the five roles with the M5 switches off and on (a viewer has no API keys, team, billing, Amadeus or payments entry; finance has billing); the switches hide settlements, payout account and go-live; the OTA of a path, the most specific current entry, and where an OTA in set-up opens.
- `src/components/components.test.tsx`: `SideNav` per role and the current page; `OtaSwitcher` items; the `(app)` layout calls `getMe` once, redirects an ended session and an unverified account, and shows the message of other failures; `StepUpDialog` asks for a code on `{ stepUp: true }`, posts it to `/v1/auth/step-up`, writes the new tokens as httpOnly cookies and only then re-submits the same `FormData`, keeps a wrong code in the dialog, and does not re-submit when cancelled; `SecretRevealPanel` writes nothing to `localStorage`, `sessionStorage`, `document.cookie` or the history, and its fields never join a form submission; every `FormField` error is in the control's `aria-describedby` with `aria-invalid`; `FormErrorSummary` takes the focus; `Money` keeps every digit of large and precise amounts; `DateTime`, `StatusBadge`, `TenantBanner`, `ConfirmDialog` and `DataTable`.

**What the sign-up and verification tests prove** (PFE-005).

- `src/app/(auth)/sign-up/sign-up-form.test.tsx`: a short password shows its error at the field (`aria-describedby`, `aria-invalid`, the focused summary) without an API call; the API's `PASSWORD_TOO_WEAK` (with `too_short`, with `breached`, or without a field) lands on the password field; a refused submission keeps the name and the address but not the password; `202` redirects to `/sign-up/check-email` with the trimmed values and `termsVersion`; missing fields and the terms are listed in form order; field errors are mapped by JSON pointer; "send a new link" confirms the same way for every address, shows the 3-per-hour message on `RATE_LIMITED`, and uses the signed-in account's own address; `/verify-pending` for a visitor, an unverified account, an account verified in the meantime (stale and current token) and `?error=token`; `continueAfterVerification` renews the session, or ends it when it cannot be renewed.
- `src/app/verify-email/route.test.ts`: the `303` never carries the token and has `Referrer-Policy: no-referrer` and `Cache-Control: no-store`; the `verifyEmail` call carries the end-user headers and no bearer token; a signed-in visitor's session is renewed after the verification and reaches `/dashboard` with new httpOnly cookies; a dead session is cleared, a passing failure keeps it; invalid, missing and over-long tokens go to `?error=token` (the last two without an API call), a rate limit or an unavailable API to `?error=unavailable`; `HEAD`, dispatched as Next.js dispatches it, answers `204` without calling the API; and the header rules of `next.config.ts`, compiled as `next build` compiles them, give `/verify-email` `no-referrer`, which survives Next.js's merge with the handler's headers.

**What the API, session and middleware tests prove** (PFE-002). `fetch` is a Vitest mock; the tests build `NextRequest`s and read what `NextResponse.next({ request })` hands to the page from its `x-middleware-request-*` headers.

- `src/lib/session.test.ts`: five parallel refreshes of one token make one call; the outcome is reused for 10 seconds after it settled, a pending call stays shared however long it takes, failures that may pass are forgotten; the cookie names and attributes (`Set-Cookie` lines as Next.js writes them); `safeNextPath` drops absolute, protocol-relative and malformed values; and a scan of `src/` fails when a `"use client"` module imports `lib/api` or `lib/session`, directly, by type only, dynamically or through other local modules (a `"use server"` module ends the search), with fixtures proving each case is caught.
- `src/middleware.test.ts`: five parallel requests with an expired access token cause one refresh call and all five see the new tokens; redirects to `/sign-in?next=…` and `/verify-pending`; cookies deleted only when the refresh token is dead; the exact policy, a new nonce per request, `'unsafe-eval'` only in development; the matcher skips static files and the health routes.
- `src/lib/end-user.test.ts` and `src/lib/api.test.ts`: the right-most `X-Forwarded-For` entry, the `127.0.0.1` fallback, the 512-character user agent, the three headers on every mocked call (a caller cannot replace them), the bearer token, `no-store`, no redirect following (a caller cannot change the base URL, cache mode or redirect handling), and the normalised `{ data }` / `{ error }` answers.
- `src/lib/errors.test.ts`: every code of `PLATFORM_ERROR_CODES` (generated from the platform document into `@velexis/errors`) has a message, and no message exists for another code, so a new code in the document fails the test until `lib/strings.ts` has its text.

**Adding a shadcn/ui component.** From `platform/frontend`, run the CLI pinned to the 2.x line of [`tech-stack.md`](../../docs/mvp/tech-stack.md), for example `pnpm dlx shadcn@2.10.0 add dialog`. `components.json` sends the copy to `src/components/ui/` with the `new-york` style, CSS variables and lucide icons. The CLI adds the component's dependencies with `^` ranges: make them exact in `package.json` before committing (`tools/ci/check-package-json.mjs` fails otherwise), and copy the change to the platform admin and the OTA admin when the design tokens in `globals.css` change ([ADR-0014](../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md)).

The copies of PFE-003 are the `new-york-v4` registry files of the `shadcn@2.10.0` tag, formatted by Prettier, with three changes: `alert-dialog.tsx` imports `buttonVariants` from `@/components/ui/button`; `dropdown-menu.tsx` passes `checked` only when it is set (`exactOptionalPropertyTypes`); and `sonner.tsx` fixes the light theme instead of reading `next-themes` (the portal has no dark theme). With Tailwind CSS 4 the CLI refuses `add toast` ("deprecated, use sonner"), so the toast is `sonner` and `AppShell` mounts its `Toaster`. The animation utilities of the copies (`animate-in`, `fade-in-0`, …) come from `tw-animate-css`, which the portal does not load, so dialogs and menus open without animation.

End-to-end journeys (with axe checks): sign-up → verify (Mailpit) → sign-in with MFA → create OTA → active (M1); API key create and revoke (M1); invitation accept and role change (M1); open console lands in the OTA admin (M4); Checkout with Stripe test mode and the Customer Portal link (M5); custom domain pending view (M5).
