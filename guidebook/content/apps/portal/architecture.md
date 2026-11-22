---
id: architecture
title: Portal — architecture guide
summary: How the Next.js portal is built - middleware, server-only API client, cookies, server actions, route handlers, CSP - which platform tables sit behind each screen, and where to change things.
---

## At a glance

| Item | Value |
|---|---|
| Code | `repo:platform/frontend` (package `@velexis/platform-frontend`) |
| Stack | Next.js 15.5 App Router (`output: "standalone"`), React 19, TypeScript strict, Tailwind CSS 4, shadcn/ui, Zod 4 (forms), openapi-fetch typed by `@velexis/api-types/platform` |
| Entry points | `repo:platform/frontend/src/middleware.ts` (every request), `repo:platform/frontend/src/app/layout.tsx` (root, `force-dynamic`), route groups `(marketing)`, `(auth)`, `(app)` |
| Port | 127.0.0.1:3000, behind Caddy at `platform.example.com`; systemd `repo:deploy/systemd/velexis-portal.service` |
| Talks to | Only the platform API (`PLATFORM_API_URL`), server side. Browser navigations to Stripe and to the OTA admin's `/sso` |
| Build / run | `pnpm --filter @velexis/platform-frontend build` → `.next/standalone/platform/frontend/server.js` (packed by `repo:deploy/scripts/pack-release.sh`) |
| Checks | `pnpm --filter @velexis/platform-frontend test`, `lint`, `typecheck`; journeys `pnpm test:e2e -- --project=portal` |

Design rules from [ADR-0014](#further-reading): pages are server components that read through the API; mutations are
[[server-action]]s that return state for `useActionState`; client components are leaves; no `NEXT_PUBLIC_` variable;
`lib/api.ts` and `lib/session.ts` are `server-only`.

## Components

```diagram
components
```

| Folder / file | Job |
|---|---|
| `repo:platform/frontend/src/middleware.ts` | With `APP_ENV=development`, first send a request for another host than `PUBLIC_PORTAL_URL`'s to the same path and query there (`307`); refresh an expiring access token ([[single-flight-refresh]]), move `?token=` of reset and invitation links into cookies ([[token-link]]), redirect the `(app)` area (`/dashboard`, `/otas`, `/console`, `/account`) to `/sign-in?next=` or `/verify-pending`, set the per-request CSP, hand on `x-velexis-requested-page` |
| `repo:platform/frontend/src/app/(marketing)` | `/`, `/pricing`, `/legal/*` |
| `repo:platform/frontend/src/app/(auth)` | Sign-up, check-email, verify-pending, sign-in, MFA, forgot/reset password, invitations, MFA enrolment; each page with its `actions.ts` |
| `repo:platform/frontend/src/app/(app)/layout.tsx` | Signed-in shell: one `getMe`; `UNAUTHENTICATED`/`TOKEN_EXPIRED` → plain `/sign-in` (no `next`; in practice a disabled or erased account), unverified → `/verify-pending`, `mfaEnrolmentRequired` → `/mfa-enrolment?next=` ([[mfa-enrolment-gate]]) |
| `repo:platform/frontend/src/app/(app)/otas/[tenantId]/layout.tsx` | Loads the OTA once (`requireTenant`), renders the [[tenant-banner]], not-found for non-members (`app/(app)/not-found.tsx`, inside the shell, status `404`). The set-up page reads the same cached answer (`requireTenant`): one `getTenant` per request |
| `repo:platform/frontend/src/app/(app)/step-up-actions.ts` | The [[step-up]] action behind `StepUpDialog` |
| Route handlers | `repo:platform/frontend/src/app/sign-out/route.ts`, `repo:platform/frontend/src/app/verify-email/route.ts`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/console/launch/route.ts`, `repo:platform/frontend/src/app/connect/stripe/callback/route.ts`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/payments/settlements/[settlementId]/lines.csv/route.ts`, `repo:platform/frontend/src/app/health/ready/route.ts` |
| `repo:platform/frontend/src/lib/api.ts` | `platformApi()` / `createPlatformApi()`: base URL, Bearer from `__Host-vxp_at`, [[end-user-headers]], `X-Request-Id`, `cache: no-store`, `redirect: manual`; answers `{data}` or `{error: {code, status, fieldErrors, details, retryAfterSeconds}}`, never the API's `message` |
| `repo:platform/frontend/src/lib/session.ts` | Cookie names, attributes and lifetimes, `refresh()`, `safeNextPath()` ([[safe-next-path]]), `prefillEmail()` |
| `repo:platform/frontend/src/lib/end-user.ts` | Right-most `X-Forwarded-For`, user agent ≤ 512, BFF key ([[bff-key]]) |
| `repo:platform/frontend/src/lib/csp.ts` | Nonce and policy ([[csp-nonce]]); the hand-off variant |
| `repo:platform/frontend/src/lib/errors.ts`, `repo:platform/frontend/src/lib/strings.ts` | Error code → [[portal-error-message]]; all UI text |
| `repo:platform/frontend/src/lib/roles.ts` | Role matrix and navigation per [[tenant-role]] and [[feature-switch]] |
| `repo:platform/frontend/src/lib/tenant.ts` | `loadTenant`, `loadSubscription` (React `cache()`), `ifMatchOf`, `trialEndForBanner` |
| `repo:platform/frontend/src/lib/config.ts` | `PORTAL_CONFIG_SCHEMA`, `getConfig()` |
| `repo:platform/frontend/src/lib/mfa-checks.ts`, `repo:platform/frontend/src/lib/qr.ts` | Checks of MFA set-up answers; QR code as SVG geometry (server only) |
| `repo:platform/frontend/src/components` | `AppShell`, `SideNav`, `OtaSwitcher`, `TenantBanner`, `StatusBadge`, `ProvisioningProgress`, `SubmissionStatus`, `SecretRevealPanel` ([[show-once-secret]]), `StepUpDialog`, `OpenConsoleButton`, `NotAllowed` ([[not-allowed-page]]), `DnsRecordsTable`, `ConnectionCard`, `MembersTable`, `InviteForm`, `ScopePicker`, `OriginsField`, `DataTable`, `Money`, `DateTime` |
| `repo:platform/frontend/src/components/ui` | shadcn/ui copies (alert, dialog, table, tabs, …) |

## Data

The portal has **no database, no Redis and no queue of its own**. It reads and changes platform data only through
the platform API, which writes the `platform` schema (never a tenant schema). The tables behind its screens:

```diagram
portal-er
```

| Screen | Tables the API reads / writes |
|---|---|
| Sign-up, verify, sign-in, MFA, reset | `accounts`, `account_tokens`, `account_sessions`, `account_recovery_codes`, `email_outbox`, `platform_audit_log`; Redis `mfach:*` |
| Create OTA, set-up | `tenants`, `tenant_memberships`, `subscriptions`, `tenant_domains`, `provisioning_jobs`, `billing_customers` (M5); Redis `vx:idem:*`; queues `ota-tenant-ops`, `platform-tenant-events` |
| Overview checklist | Computed on every request from the tables above ([[onboarding-checklist]]) |
| API keys | `api_keys`, `plans` (limit) |
| Team, invitations | `tenant_memberships`, `tenant_invitations`, `plans` (seats), `email_outbox` |
| Domains | `tenant_domains` |
| Amadeus | `supplier_connections`, `credential_submissions`, `amadeus_offices` |
| Payments | `payment_provider_connections`, `credential_submissions`; Redis `stripe:oauth:*` |
| Payout account, settlements | `tenant_payout_accounts`, `settlements`, `settlement_lines` |
| Billing | `subscriptions`, `plans`, `invoices`, `billing_customers` |
| Go live | `tenants.storefront_environment`, `live_enabled_at`, plus the six preconditions' tables |
| Open console | `tenant_memberships`, `tenants`; Redis `ptk:*` |
| Security | `accounts`, `account_sessions`, `account_recovery_codes`; Redis `staffdeny:acct:*` |

**Cookies** are the portal's only state ([[host-cookie]]s, all `HttpOnly; Secure; Path=/`, written by
`repo:platform/frontend/src/lib/session.ts`):

| Cookie | Holds | Lifetime | SameSite |
|---|---|---|---|
| `__Host-vxp_at` | Platform access token (JWT, claims `exp`, `ev`) | as the token, ≤ 15 min | Lax |
| `__Host-vxp_rt` | Refresh token of the [[refresh-family]] | idle expiry, ≤ family's 30 days | Lax |
| `__Host-vxp_mfa` | MFA challenge token | ≤ 5 min | Strict |
| `__Host-vxp_reset`, `__Host-vxp_invite` | Token moved out of an e-mail link | 15 min (`__Host-vxp_invite`: until the invitation expires, at most 24 h, after a sign-up from it) | Strict |
| `__Host-vxp_next` | Validated return path during MFA | 15 min | Lax |
| `__Host-vxp_verify_next` | The sign-up's return path for the e-mail verification | 24 h | Lax |
| `__Host-vxp_connect` | OTA id of a Stripe Connect in progress (not a secret) | 1 h | Lax |

The refresh single-flight map (`refresh()`, keyed by the SHA-256 of the refresh token, outcomes reused for 10 s) lives
in the portal process's memory: that is why the middleware runs in the Node.js runtime and why the portal runs as one
process.

## Key flows

```diagram
seq-request-pipeline
```

```diagram
seq-sign-in-mfa
```

```diagram
seq-token-link
```

```diagram
seq-step-up
```

```diagram
seq-create-ota-checkout
```

```diagram
seq-open-console
```

```diagram
seq-stripe-connect
```

## Lifecycles

The portal owns no stored lifecycle; it shows the API's and keeps a few of its own in cookies and React state.

```diagram
session-states
```

```diagram
setup-page-states
```

```diagram
key-check-states
```

```diagram
invitation-accept-states
```

```diagram
submission-status-states
```

```diagram
checkout-confirmation-states
```

```diagram
go-live-states
```

The stored lifecycles behind these screens are the platform API's:

```diagram
platform-api/tenant-states
```

```diagram
platform-api/provisioning-job-states
```

```diagram
platform-api/subscription-states
```

Also: [[diagram:platform-api/api-key-states]], [[diagram:platform-api/invitation-states]],
[[diagram:platform-api/membership-states]], [[diagram:platform-api/domain-verification-states]],
[[diagram:platform-api/credential-submission-states]], [[diagram:platform-api/payout-account-states]],
[[diagram:platform-api/settlement-states]], [[diagram:platform-api/session-states]].

## Integrations

| With | How | Contract / code |
|---|---|---|
| [[app:platform-api]] | Every operation outside `/v1/admin/**`, `/internal`, `/webhooks` and `/health` (71 operations: auth, me, tenants, provisioning, team, invitations, console token, API keys, domains, Amadeus, payments, billing, payout, settlements) | `repo:platform/backend/openapi/velexis-platform-api.openapi.yaml`, types from `@velexis/api-types/platform` |
| [[app:ota-admin]] | Hand-off form `POST <PUBLIC_OTA_ADMIN_URL>/sso` with `portalToken` ([[hand-off-page]], [[portal-token]]); the OTA admin redirects to `/console?tenant=` | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/console/launch/route.ts`, `repo:platform/frontend/src/app/(app)/console/page.tsx` |
| Stripe Checkout and Customer Portal | `redirect()` to the URL the API answered, only an absolute `https:` URL without credentials ([[checkout-session]], [[customer-portal]]) | `repo:platform/frontend/src/app/(app)/otas/new/actions.ts`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/setup/actions.ts`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/billing/actions.ts` |
| Stripe Connect | Authorize URL must be `https://connect.stripe.com/oauth/authorize?…`; return to `/connect/stripe/callback` ([[stripe-connect-standard]]) | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/payments/actions.ts`, `repo:platform/frontend/src/app/connect/stripe/callback/route.ts` |
| E-mail links | `/verify-email?token=`, `/reset-password?token=`, `/invitations/accept?token=` sent by the platform worker's e-mail outbox | `repo:platform/frontend/src/app/verify-email/route.ts`, `repo:platform/frontend/src/middleware.ts` |
| Caddy | TLS, HSTS, `X-Frame-Options: DENY`, `X-Request-Id`, right-most `X-Forwarded-For` | `repo:deploy/caddy/Caddyfile` |

## Security

- **Tokens never reach browser JavaScript.** Session, MFA, reset and invitation tokens live only in `__Host-` httpOnly
  cookies; client components never import `lib/api.ts`/`lib/session.ts`; `lib/config.test.ts` fails on any
  `NEXT_PUBLIC_` variable.
- **Secrets shown once** (API keys, initial test keys, recovery codes, MFA secret, Stripe/Amadeus secrets typed in)
  exist only in a server action's answer (`Cache-Control: no-store`) and React state; never in cookies, URLs,
  storage or logs. Password fields for third-party secrets use `autocomplete="new-password"` so the browser does not
  fill the member's portal password.
- **CSRF.** Server actions rely on Next.js's Origin check; the state-changing route handlers (`/sign-out`,
  `console/launch`) compare `Origin` with `PUBLIC_PORTAL_URL` and answer `403` otherwise. "Open console" is a form,
  never a link, so prefetchers cannot mint tokens; the Stripe callback answers `HEAD` with `405`.
- **Open redirects.** `next` passes [[safe-next-path]] (one leading `/`, no backslash or control character, ≤ 2048,
  re-checked after URL normalisation); external redirects only to URLs the API answered and the portal checked.
- **Headers.** Nonce CSP from the middleware (`script-src 'self' 'nonce-…'`, `form-action 'self' <OTA admin origin>`,
  `frame-ancestors 'none'`, `object-src 'none'`); `Referrer-Policy` `strict-origin-when-cross-origin`, `no-referrer`
  on `/verify-email` and token pages, `strict-origin` on the hand-off page (so the OTA admin sees the portal's
  `Origin`); `nosniff`; `Permissions-Policy`; no `X-Powered-By` (`repo:platform/frontend/next.config.ts`). In
  production Caddy's `security_headers` snippet (`repo:deploy/caddy/Caddyfile`) sets `Referrer-Policy` only when an
  answer has none, so these policies reach the browser; the token-link refresh page and the hand-off page also carry
  `<meta name="referrer">`.
- **End-user identity for rate limits and audit** ([[end-user-headers]]): `X-Velexis-End-User-IP` (right-most
  `X-Forwarded-For` only), `X-Velexis-End-User-Agent`, `X-Velexis-Bff-Key`; the API trusts them only from loopback
  with the key (PADR-0019).
- **Errors** show only the [[portal-error-message]] for the code; field errors are mapped by JSON pointer.
- **Step-up and MFA policy** are the API's; the portal only reacts to `REAUTH_REQUIRED`, `MFA_REQUIRED` and
  `mfaEnrolmentRequired` ([[step-up]], [[mandatory-mfa]]).
- **PCI.** The portal never sees card data: payments happen on Stripe's hosted pages; bank numbers of the payout
  account are sent once and only `last4` is ever answered.

## Configuration

All read on the server through `getConfig()` (`repo:platform/frontend/src/lib/config.ts`); outside production it
fills unset values from `platform/frontend/.env.local`, then the root `.env.local`. Template:
`repo:platform/frontend/.env.example`; on the VM `/etc/velexis/platform-frontend.env` from
`repo:deploy/env/platform-frontend.env.example`.

| Variable | Purpose |
|---|---|
| `APP_ENV` | `development`, `test` or `production` (`'unsafe-eval'` in the CSP only for development) |
| `LOG_LEVEL` | pino level |
| `PORT`, `HOSTNAME` | Bind address (3000, 127.0.0.1) |
| `PLATFORM_API_URL` | Platform API base URL (server side only) |
| `PLATFORM_BFF_KEY` | Shared secret with the API for the end-user headers (≥ 32 chars; a secret, never logged) |
| `PUBLIC_PORTAL_URL` | The portal's own origin: redirects, Origin checks (`https:` in production) |
| `PUBLIC_OTA_ADMIN_URL` | OTA admin origin: CSP `form-action`, the only allowed `consoleSsoUrl` origin |
| `STOREFRONT_BASE_DOMAIN` | Builds `<key>.<domain>` on the dashboard and in the wizard |
| `SENTRY_DSN` | Validated only (`https:` URL or empty); no client sends errors until M6, so it stays empty |

The milestone switches (`FEATURE_*`) belong to the platform API; the portal reads them from `getMe.features`.

## Testing

| Level | Where | Run one |
|---|---|---|
| Unit (Node) | `src/lib/*.test.ts`, `src/middleware.test.ts`, route handler tests (`route.test.ts`) | `pnpm --filter @velexis/platform-frontend test -- src/lib/session.test.ts` |
| Component (happy-dom) | `src/**/*.test.tsx` (real server actions and `lib/api.ts` against a mocked `fetch`) | `pnpm --filter @velexis/platform-frontend test -- src/app/(app)/otas/new/wizard.test.tsx` |
| End-to-end (Playwright) | `repo:tools/e2e/specs/portal-signup.e2e.ts`, `portal-account-security`, `portal-api-keys`, `portal-team`, `portal-domains`, `portal-payments`, `portal-go-live`, `portal-mfa-enrolment`, `portal-roles`, `portal-keyboard`, `portal-a11y`, `portal-headers`, `console-sso` (project `portal`); `portal-checkout` (`@stripe`, nightly project `portal-stripe`) | `E2E_WITH_OTA=1 pnpm test:e2e -- --project=portal specs/portal-signup.e2e.ts` |

The e2e specs are the best step-by-step scripts of real journeys; `repo:tools/e2e/README.md` says what each proves.
Journeys that create an OTA need `E2E_WITH_OTA=1` (OTA worker and Amadeus stub); `portal-checkout` runs only in the
`portal-stripe` project, which exists with `E2E_STRIPE=1` and also needs `E2E_WITH_OTA=1` and `E2E_STRIPE_BILLING=1`.

## Where to change things

| To change … | Look at |
|---|---|
| Any UI text or error message | `repo:platform/frontend/src/lib/strings.ts` (`ERROR_MESSAGES`, per-page `*_STRINGS`) |
| Which role sees which page or button | `repo:platform/frontend/src/lib/roles.ts` (`PORTAL_ACTIONS`, `OTA_NAV_RULES`) |
| Session refresh, cookie lifetimes, `next` handling | `repo:platform/frontend/src/lib/session.ts`, `repo:platform/frontend/src/middleware.ts` |
| Which paths need a session | `APP_ROUTE_PREFIXES` in `repo:platform/frontend/src/middleware.ts` |
| Headers sent to the API, error mapping | `repo:platform/frontend/src/lib/api.ts`, `repo:platform/frontend/src/lib/end-user.ts`, `repo:platform/frontend/src/lib/errors.ts` |
| CSP and security headers | `repo:platform/frontend/src/lib/csp.ts`, `repo:platform/frontend/next.config.ts` |
| Sign-up form and password rule | `repo:platform/frontend/src/app/(auth)/sign-up/actions.ts`, `repo:platform/frontend/src/lib/password-rule.ts`, `repo:platform/frontend/src/lib/terms.ts` |
| Sign-in, MFA step | `repo:platform/frontend/src/app/(auth)/sign-in/actions.ts`, `repo:platform/frontend/src/app/(auth)/sign-in/mfa/actions.ts` |
| Verification link handling | `repo:platform/frontend/src/app/verify-email/route.ts`, `repo:platform/frontend/src/app/(auth)/verify-pending/actions.ts` |
| Reset and invitation token links | `TOKEN_LINKS` in `repo:platform/frontend/src/middleware.ts`; `repo:platform/frontend/src/app/(auth)/invitations/accept/actions.ts` |
| MFA enrolment gate | `repo:platform/frontend/src/app/(app)/layout.tsx`, `repo:platform/frontend/src/app/(auth)/mfa-enrolment/page.tsx`, `repo:platform/frontend/src/lib/errors.ts` |
| Dashboard cards | `repo:platform/frontend/src/app/(app)/dashboard/page.tsx` |
| Create-OTA wizard, key check, plan step | `repo:platform/frontend/src/app/(app)/otas/new/wizard.tsx`, `repo:platform/frontend/src/app/(app)/otas/new/key-availability-field.tsx`, `repo:platform/frontend/src/app/(app)/otas/new/plan-picker.tsx`, `repo:platform/frontend/src/app/(app)/otas/new/actions.ts` |
| Country, currency, time zone lists | `repo:platform/frontend/src/lib/reference-options.ts` |
| Set-up page, polling, retry, key reveal, payment | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/setup/page.tsx`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/setup/actions.ts`, `repo:platform/frontend/src/components/provisioning-progress.tsx` |
| OTA banner (suspended, past due, trial, test mode) | `repo:platform/frontend/src/components/tenant-banner.tsx`, `repo:platform/frontend/src/lib/tenant.ts` |
| Onboarding checklist | `repo:platform/frontend/src/components/onboarding-checklist.tsx` (items come from the API's `getOnboarding`) |
| OTA profile | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/settings/settings-form.tsx`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/settings/actions.ts` |
| API keys page, origins, scopes | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/api-keys/actions.ts`, `repo:platform/frontend/src/components/origins-field.tsx`, `repo:platform/frontend/src/components/scope-picker.tsx` |
| Team, roles, invitations | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/team/actions.ts`, `repo:platform/frontend/src/components/members-table.tsx`, `repo:platform/frontend/src/components/invite-form.tsx` |
| Domains and DNS records | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/domains/actions.ts`, `repo:platform/frontend/src/components/dns-records-table.tsx` |
| Amadeus settings, live access, own credentials | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/amadeus/settings-form.tsx`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/amadeus/live-access-form.tsx`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/amadeus/own-credentials-form.tsx`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/amadeus/actions.ts` |
| Credential verification polling | `repo:platform/frontend/src/components/submission-status.tsx` ([[submission-polling]]) |
| Card statement suffix | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/payments/descriptor-rules.ts` ([[statement-descriptor-suffix]]) |
| Stripe Connect, own keys, back to Velexis | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/payments/stripe-keys-form.tsx`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/payments/stripe-connect.ts`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/payments/use-velexis-dialog.tsx` |
| Payout account form and IBAN checks | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/payments/payout-account/actions.ts`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/payments/payout-account/payout-form.tsx` |
| Settlements list, statement, CSV | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/payments/settlements/statements.ts`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/payments/settlements/[settlementId]/lines.csv/route.ts` |
| Billing rules, Checkout, invoices | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/billing/billing-rules.ts`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/billing/actions.ts`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/billing/invoices-table.tsx` |
| Go-live checklist and switch | `repo:platform/frontend/src/app/(app)/otas/[tenantId]/go-live/preconditions.ts` ([[live-preconditions]]), `repo:platform/frontend/src/app/(app)/otas/[tenantId]/go-live/go-live-switch.tsx` |
| Open console and its refusals | `repo:platform/frontend/src/components/open-console-button.tsx`, `repo:platform/frontend/src/app/(app)/otas/[tenantId]/console/launch/route.ts` |
| Profile, password, MFA, sessions | `repo:platform/frontend/src/app/(app)/account/actions.ts`, `repo:platform/frontend/src/app/(app)/account/security/actions.ts`, `repo:platform/frontend/src/app/(app)/account/security/mfa-setup.tsx`, `repo:platform/frontend/src/app/(app)/account/security/sessions-table.tsx` |
| Money and date formatting | `repo:platform/frontend/src/components/money.tsx`, `repo:platform/frontend/src/components/date-time.tsx` |
| Environment variables | `repo:platform/frontend/src/lib/config.ts`, `repo:platform/frontend/.env.example` |
| A rule the API enforces (limits, statuses, e-mails) | the platform API: [[app:platform-api]] |

## Further reading

- `repo:platform/frontend/README.md` — the component specification (route map, every page's behaviour, tests)
- `repo:platform/docs/scope.md` (features and role matrix), `repo:platform/docs/api-inventory.md`
- Flows: `repo:platform/docs/flows/signup-and-create-ota.md`, `repo:platform/docs/flows/provisioning.md`,
  `repo:platform/docs/flows/api-keys.md`, `repo:platform/docs/flows/team-and-ota-admin-sso.md`,
  `repo:platform/docs/flows/custom-domains.md`, `repo:platform/docs/flows/amadeus-connection.md`,
  `repo:platform/docs/flows/stripe-payments-account.md`, `repo:platform/docs/flows/subscription-billing.md`
- ADRs: `repo:docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md` (frontend stack, BFF),
  `repo:docs/mvp/adr/0008-identity-accounts-customers-sessions.md`,
  `repo:platform/docs/adr/0007-portal-to-ota-admin-sso-token.md`,
  `repo:platform/docs/adr/0008-email-verification-and-mfa-policy.md`,
  `repo:platform/docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md`,
  `repo:platform/docs/adr/0015-milestone-feature-switches.md`,
  `repo:platform/docs/adr/0018-onboarding-checklist-computation.md`
- `repo:docs/mvp/local-development.md`, `repo:tools/e2e/README.md`

```note
Known differences between the docs and the code at this commit: ADR-0014 puts the CSP in `next.config` `headers()`,
while the code sets it in `middleware.ts` with `lib/csp.ts`; the sign-up flow says the set-up page polls with
`router.refresh()`, while `ProvisioningProgress` calls the `getSetupProgress` server action every 2 s; the same flow
calls the unverified account's page "check your e-mail", while the code shows `/verify-pending` ("Verify your e-mail
address"); the team flow says the invitation link "redirects", while the middleware answers a `200` script-free
refresh page (a `303` would lose the `SameSite=Strict` cookie).
```
