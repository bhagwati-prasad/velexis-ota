# Platform security review (M6)

**Task:** PBE-062 · **Date:** 2026-11-04 · **Code reviewed:** `claude/intelligent-bardeen-90hhu7` at `f7efd7b` (M5 complete but PAD-012, PFE-027 and PAD-015) · **Scope:** the platform backend (API, worker, CLI), the portal and the platform admin · **Deep review:** the product owner.

This is the security review of the platform group before launch ([`../../docs/mvp/conventions.md` §12](../../docs/mvp/conventions.md#12-security-checklist-every-pr), [`architecture.md` §8](architecture.md#8-security-notes-specific-to-the-platform), [PADR-0008](adr/0008-email-verification-and-mfa-policy.md), [ADR-0016](../../docs/mvp/adr/0016-observability.md)). Three integration tests carry its proofs and keep proving them on every run of `pnpm test:int`; the rest is code reading, recorded below with the place that shows it. Every finding has a severity and a task of [`plans/agent-tasks.md`](plans/agent-tasks.md); nothing found was fixed in this task, because each fix either changes a rule an ADR states or needs a major dependency upgrade.

## 1. Summary

| Check | Result | Proof |
|---|---|---|
| Auth matrix: every operation × every kind of caller | 144 operations × 12 callers, 1 728 answers, all as the API inventories say; no `5xx`, every refusal documented | [`auth-matrix.int.test.ts`](../backend/test/integration/security/auth-matrix.int.test.ts) |
| Rate limits of api-inventory §2 | 9 of 9 rows answer `429` with `Retry-After` (and the sign-in lockout `423`); one IP, account, address or domain over its limit never holds another | [`rate-limits.int.test.ts`](../backend/test/integration/security/rate-limits.int.test.ts) |
| Secrets at rest after the main flows | none outside the ciphertext columns, and none in clear inside them | [`secrets-at-rest.int.test.ts`](../backend/test/integration/security/secrets-at-rest.int.test.ts) |
| `pending-operations.ts` (PADR-0016 item 2) | empty; every operation of the document is bound and answers its guards | the auth matrix |
| `pnpm audit` | 3 critical and 15 high advisories (7 high in production dependencies) | §7, findings F-2 to F-5 |
| MFA mandatory for owners (PADR-0008 follow-up) | recommended for owners and admins of **live** OTAs; decided on 2026-11-05 (lead decision (5b), [PADR-0008](adr/0008-email-verification-and-mfa-policy.md) revision): mandatory for them, enforced at go-live and at their first portal sign-in after it; tasks PBE-071 and PFE-030 | §9 |

### Findings

| Id | Severity | Finding | Task |
|---|---|---|---|
| F-1 | Medium | A disabled or deleted account keeps using the portal API for up to 15 minutes with an access token it holds, sensitive actions included | [PBE-067](plans/agent-tasks.md#pbe-067--refuse-the-portal-tokens-of-disabled-and-deleted-accounts-at-once) |
| F-2 | High (advisory); reachable: Medium | `nodemailer` 6.10.1 in the platform backend: five high advisories (production dependency) | [PBE-068](plans/agent-tasks.md#pbe-068--upgrade-nodemailer-in-the-platform-backend-past-its-high-advisories) |
| F-3 | High (advisory); reachable: Low | `multer` 2.4.0 through `@nestjs/platform-express` 11.2.8: one high advisory, not reachable on the platform API; OBE-094's root `pnpm.overrides` entry lifts it to 2.5.0 for both backends, NestJS stays on 11 | OBE-094 (the override), [PBE-069](plans/agent-tasks.md#pbe-069--confirm-the-multer-override-in-the-platform-backend-and-keep-its-api-free-of-multipart-routes) (its confirmation and the multipart-route guard) |
| F-4 | High (advisory); reachable: Low | `zod` 3.25.76 in the portal and the platform admin: one high advisory (production dependency) | [PFE-029](plans/agent-tasks.md#pfe-029--upgrade-zod-in-the-portal-past-its-high-advisory), [PAD-017](plans/agent-tasks.md#pad-017--upgrade-zod-in-the-platform-admin-past-its-high-advisory) |
| F-5 | Critical (advisory); reachable: Low | Test and contract tooling (`vitest` → `tinypool`, `happy-dom`; `@redocly/cli` → `undici`, `@faker-js/faker`): 3 critical and 8 high advisories in development dependencies | [PBE-070](plans/agent-tasks.md#pbe-070--upgrade-the-test-and-contract-tooling-past-the-audits-critical-and-high-advisories) |

Severity: **High** — exploitable from the internet against production data or money; **Medium** — exploitable with a precondition (a stolen token, a crafted input) or a weakening of a stated control; **Low** — not reachable in production as built, or development tooling only.

A dependency finding (F-2 to F-5) shows two ratings side by side (lead decision (5d) of 2026-11-05): first the advisory's own severity, the highest one its advisories carry in `pnpm audit` (the rating that `--audit-level` gates count, and that the M6 go/no-go criterion "`pnpm audit --prod` clean of high and critical" counts for the production dependencies of F-2 to F-4, so it never drops because the code does not reach the package), then the reachability that this review rates on the scale above (how urgent the fix is for the platform as built). The review's own findings (F-1) have the second rating only.

## 2. How the review was done

1. **The auth matrix** (§4) calls every operation of the operations index with every kind of caller and compares each answer with what the API inventories write, not with the code's own role matrix.
2. **The rate limits** (§5) run each row of api-inventory §2 through the real routes, as the portal and admin servers call them.
3. **The secrets scan** (§6) runs the main flows once and scans every text and jsonb column, every log line at `trace` and every Redis value.
4. **Code reading** of the guards (`src/common/auth/`), the throttler, the validation interceptor, the error filter, the idempotency interceptor, the redaction list of `@velexis/logger`, the e-mail outbox, the credential submissions, the Stripe client and webhook receivers, and the Next.js middleware, CSP builders and session cookies of both apps. Searches over `platform/backend/src`: no `sql.raw`, `sql.lit` or other raw SQL, no `search_path` or `tenant_…` schema access, no `console.` call; over `platform/`, `packages/`, `deploy/` and `.env.example`: no live key, signing secret or private key outside tests' made-up values.
5. **`pnpm audit`** on 2026-11-04 (the registry's audit endpoint answered).

## 3. The checklist of conventions §12, module by module

✓ the item holds (evidence in the notes); — the item does not apply to the module; F-n a finding.

| Module (`src/`) | Secrets committed | Secrets logged or stored | Tenant data | Guard and `x-scope` | Validation and SQL | Cookies and CSRF | Idempotency and webhooks | Rate limits | Errors | Dependencies |
|---|---|---|---|---|---|---|---|---|---|---|
| `auth` | ✓ | ✓ | — | ✓ | ✓ | — | — | ✓ | ✓ | — |
| `accounts` | ✓ | ✓ | — | ✓ F-1 | ✓ | — | — | ✓ | ✓ | — |
| `admin` | ✓ | ✓ | — | ✓ | ✓ | — | — | ✓ | ✓ | — |
| `api-keys` | ✓ | ✓ | — | ✓ F-1 | ✓ | — | — | ✓ | ✓ | — |
| `audit` | ✓ | ✓ | — | ✓ | ✓ | — | — | ✓ | ✓ | — |
| `billing` | ✓ | ✓ | — | ✓ | ✓ | — | ✓ | ✓ | ✓ | — |
| `common` | ✓ | ✓ | ✓ | ✓ F-1 | ✓ | — | ✓ | ✓ | ✓ | F-3 |
| `dev` | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `domains` | ✓ | ✓ | — | ✓ | ✓ | — | — | ✓ | ✓ | — |
| `health` | ✓ | ✓ | — | ✓ | ✓ | — | — | — | ✓ | — |
| `memberships` | ✓ | ✓ | — | ✓ F-1 | ✓ | — | — | ✓ | ✓ | — |
| `notifications` | ✓ | ✓ | — | — | — | — | ✓ | — | — | F-2 |
| `payment-connections` | ✓ | ✓ | — | ✓ F-1 | ✓ | — | ✓ | ✓ | ✓ | — |
| `provisioning` | ✓ | ✓ | ✓ | ✓ F-1 | ✓ | — | ✓ | ✓ | ✓ | — |
| `settlements` | ✓ | ✓ | — | ✓ F-1 | ✓ | — | ✓ | ✓ | ✓ | — |
| `supplier-connections` | ✓ | ✓ | — | ✓ F-1 | ✓ | — | — | ✓ | ✓ | — |
| `tenants` | ✓ | ✓ | — | ✓ F-1 | ✓ | — | — | ✓ | ✓ | — |
| Portal (`platform/frontend`) | ✓ | ✓ | — | — | ✓ | ✓ | — | — | ✓ | F-4, F-5 |
| Admin (`platform/admin`) | ✓ | ✓ | — | — | ✓ | ✓ | — | — | ✓ | F-4, F-5 |

The PCI item of §12 (the airline-card path and the storefront's payment page) does not apply to the platform: it never handles card data; Stripe's own pages take the cards of Checkout and the Customer Portal.

Notes:

- **Secrets committed.** `.env.example` and the env templates hold development dummies only (`sk_test_replace_me`, `whsec_replace_me`, `dev_bff_key_change_me_…`); tests make their keys at run time ([`test/support/`](../backend/test/support/README.md)).
- **Secrets logged or stored.** The redaction list of `@velexis/logger` holds every name of architecture §8 (`secretKey`, `webhookSecret`, `iban`, `accountNumber`, `bic`, `routingNumber`, `recoveryCode(s)`, `totpSecret`, `otpauthUrl`, `mfaChallengeToken`, `invitationToken`, `secretData`, `verifyUrl`, `resetUrl`, `acceptUrl`, with `clientSecret`, `token`, `password`, `portalToken`) at the root and one level down. Secrets at rest are envelope-encrypted (ADR-0010) in the `bytea` columns `accounts.mfa_secret_ciphertext`, `amadeus_accounts.client_secret_ciphertext`, `supplier_connections.client_secret_ciphertext`, `payment_provider_connections.secret_ciphertext` and `.webhook_secret_ciphertext`, `credential_submissions.secret_ciphertext` and `.webhook_secret_ciphertext` (cleared once applied), `email_outbox.secret_payload_ciphertext` (cleared once sent), `provisioning_jobs.reveal_ciphertext` (cleared at the reveal or by the hourly purge) and `tenant_payout_accounts.bank_details_ciphertext`; tokens, recovery codes and API keys are stored as SHA-256 or HMAC digests only. The scan of §6 proves it for the flows that write them.
- **Tenant data.** The platform never touches a tenant schema ([`decisions.md`](../../docs/mvp/decisions.md) §5): there is no tenant SQL in `src/`; `provisioning` and `common` talk to the OTA backend through the `tenant.*` queue messages and the Redis handoffs only (architecture §6).
- **Guard and `x-scope`.** Every route is bound to its operation (route parity) and every guard acts on the operation's `x-scope`, `x-mfa-step-up` and `x-feature` (`OperationPolicies`), so a controller cannot forget one; §4 proves the answers. F-1 is the one gap: the portal guard trusts an access token for its 15 minutes.
- **Validation and SQL.** The validation interceptor validates the path, query, headers and body of every bound route against the document before the handler runs, with field errors that never quote a value; SQL is Kysely or `pg` with bound parameters only.
- **Cookies and CSRF.** The API sets no cookie. The portal and the admin keep the tokens in `__Host-` cookies that are `HttpOnly` and `Secure` (§8); server actions get Next.js's `Origin` check, and the route handlers that change state (`/sign-out` of both apps, the portal's console hand-off) check `Origin` themselves.
- **Idempotency and webhooks.** Every state-changing Stripe call carries an idempotency key (FakeStripe refuses a create without one, so every Stripe test proves it); `createTenant` and `createCheckoutSession` take `Idempotency-Key`, and replays never store an answer with `Cache-Control: no-store`. Both webhook receivers verify `Stripe-Signature` on the raw body before anything reads it (`StripeSignatureGuard`, `400 WEBHOOK_SIGNATURE_INVALID` for every caller in the matrix) and insert into `stripe_events` with `ON CONFLICT DO NOTHING`.
- **Rate limits.** §5.
- **Errors.** The error filter answers the envelope of the catalogue; an unknown error is `500 INTERNAL_ERROR`, logged with its stack and never answered with it; Nest's own exceptions answer their generic code, never their message. No answer of the matrix was a `5xx`.
- **`dev`.** `dev:seed` refuses `APP_ENV=production` before it opens a connection; the module is a CLI command, not part of the API.

## 4. The auth matrix

[`auth-matrix.int.test.ts`](../backend/test/integration/security/auth-matrix.int.test.ts) takes its rows from the operations index (`@velexis/api-types/operations`) and the expected answers from the API inventories ([part 1](api-inventory.md) §2 notation: `public`, `portal*`, `portal`, `portal: <roles>` or `member`, `admin`, `internal`, `webhook`) and from the document's `x-mfa-step-up`. It fails when an operation of the index has no inventory row, when an inventory's notation is not the operation's `x-scope`, when a tenant path names no roles (or another path names some), and when an inventory's `MFA↑` mark and `x-mfa-step-up` disagree. Every request sends the body `[]`, which no operation takes, so an allowed call ends in request validation (`400 VALIDATION_FAILED` with a body field error) after every guard and no handler runs.

| Caller | What it is | Answers |
|---|---|---|
| `noToken` | the portal or admin server without a session (BFF key, end-user IP) | `public` and `internal` allowed; everything else `401 UNAUTHENTICATED` |
| `throughProxy` | an internet client through Caddy (`X-Forwarded-For`) | as `noToken`, but `internal` answers `404 NOT_FOUND` |
| `unverified` | a portal token with `ev = false` | `portal_unverified` allowed; `portal` `403 EMAIL_NOT_VERIFIED`; admin `401` |
| `portal` | a verified account that is no member of the OTA | non-tenant portal operations allowed; every tenant path `404 NOT_FOUND`; admin `401` |
| `platformAdmin` | an active platform admin | admin operations allowed; portal operations `401` |
| `owner` … `viewer` | members of each role | the inventory's roles allowed, the others `403 FORBIDDEN` |
| `ownerWithoutStepUp`, `platformAdminWithoutStepUp` | tokens whose last TOTP is 20 minutes old | the 15 `x-mfa-step-up` operations `401 REAUTH_REQUIRED`, the rest as their fresh counterpart |
| `disabledAccount`, `erasedAccount` (PBE-067) | unexpired portal tokens (verified e-mail, step-up of now) of two owners of the OTA, disabled and erased after the tokens were signed | every `portal_unverified` and `portal` operation `401 UNAUTHENTICATED`; admin `401`; `public` and `internal` allowed |

Totals of a run: 580 allowed, 894 `401 UNAUTHENTICATED`, 117 `403 FORBIDDEN`, 52 `403 EMAIL_NOT_VERIFIED`, 46 `404 NOT_FOUND`, 24 `400 WEBHOOK_SIGNATURE_INVALID`, 15 `401 REAUTH_REQUIRED`. The operations by scope: 14 `public`, 9 `portal_unverified`, 52 `portal` (44 of them under `/v1/tenants/{tenantId}`), 65 `platform_admin`, 2 `internal`, 2 `webhook`. `removeMember` lets every member through the role guard (the inventory's "or the member themself"; the service decides who may remove whom, members.int.test.ts). Rules finer than a role — granting owner, live secret keys, Amadeus account rotation — are the services' and are tested with their operations.

*Note (2026-11-05, PBE-067).* The two columns of the last row came with F-1's fix. The twelve columns of the review answer exactly the totals above; the two new ones add 32 allowed (the `public` and `internal` operations), 252 `401 UNAUTHENTICATED` (the 61 portal and 65 admin operations, twice) and 4 `400 WEBHOOK_SIGNATURE_INVALID`.

## 5. Rate limits

[`rate-limits.int.test.ts`](../backend/test/integration/security/rate-limits.int.test.ts), one group per row of [api-inventory §2](api-inventory.md#2-conventions), through the real routes:

| Row | Proven | Leaves alone |
|---|---|---|
| Sign-up, 5 per IP per hour | the sixth `signUp` of an IP `429`, `Retry-After` ≤ 3600; a forwarded IP with a wrong BFF key counts for the caller's own address | the next IP |
| Sign-in, admin sign-in, 10 per IP per minute; 5 failures lock | the eleventh sign-in of an IP `429` (portal and admin count together); the fifth wrong password `423 ACCOUNT_LOCKED` with `Retry-After: 900`, the right password refused while locked | the next IP; another account from the locked one's IP |
| MFA verify, step-up, 5 per challenge, 10 per account per 10 minutes | the fifth wrong code ends a challenge; the eleventh `verifyMfa` and the eleventh `stepUp` of an account `429` | another account |
| Password reset, resend verification, 3 per e-mail and 10 per IP per hour | the fourth link of an address (any IP, any letter case, either operation) `429`; the eleventh of an IP `429` | another address; the next IP |
| Invitation lookup, 20 per IP per hour | the 21st lookup of an IP `429` | the next IP |
| Key availability, 30 per account per minute | the 31st check of an account `429`, whatever the IP | another account |
| Console token, 30 per account per minute | the 31st token of an account `429` | another member |
| Domain check now, 1 per domain per minute | the second check of a domain `429`, also for a caller without a token (counted before the guards) | another domain |
| Everything else authenticated, 300 per account per minute | the 301st `getMe` of an account `429` | another account |

The public token endpoints that consume a 256-bit token (`verifyEmail`, `confirmPasswordReset`, `refreshSession`, `adminRefresh`) have no row of their own: guessing such a token is not feasible, and each attempt costs one indexed lookup of a digest (accepted, no task).

## 6. Secrets at rest

[`secrets-at-rest.int.test.ts`](../backend/test/integration/security/secrets-at-rest.int.test.ts) runs, through the API and the worker's module graph: a sign-up verified from its e-mail, a sign-in, MFA set up and enabled, a sign-in with MFA and a refresh; an OTA created, provisioned (the fake OTA worker and the post-steps) and its initial keys revealed; an API key created and rolled; own Amadeus credentials verified against the Amadeus stub; Stripe Connect started and completed; own Stripe keys verified; the payout account set; an invitation accepted from its e-mail; a console token; a password reset from its e-mail. E-mails go through SMTP to Mailpit, where the tokens are read as a person reads them.

It then scans every `text`, `character`, `text[]` and `jsonb` column of the `platform` schema (from the catalog), every API and worker log line at `trace` and every key and value of the test's Redis database (the BullMQ jobs with their data, the idempotent replays, the challenges, the console tokens, the counters) for the patterns of §12 — `sk_`/`rk_` keys beyond the 14-character visible prefix, `whsec_` secrets, `ptk_` console tokens, the platform's `vt_`, `pr_`, `iv_`, `rt_` and `mfa_` tokens, access tokens, IBAN-shaped strings with a valid ISO 13616 checksum, `otpauth://` URLs — and for every secret value the flows made or sent (passwords, TOTP secrets, recovery codes, tokens, API keys, the Amadeus secret, the Stripe keys and Connect code, state and tokens, the IBAN and BIC, and the configuration's secrets: the BFF key, the Stripe secrets, the key files of the JWT signing key, the API key pepper and the master keys, and the passwords of the database, Redis and SMTP URLs when they have one). **Nothing was found.** The `bytea` ciphertext columns hold no value in clear either, and a planted text proves that each pattern is detected.

## 7. Dependencies (`pnpm audit`, 2026-11-04)

The registry's audit endpoint answered. Whole workspace: 3 critical, 15 high, 29 moderate, 3 low. Production dependencies only (`pnpm audit --prod`): 0 critical, 7 high, 19 moderate, 3 low. `pnpm audit --audit-level high` therefore fails until the tasks below land. The review applies no override and no major upgrade (lead decision of 2026-11-04).

| Package (version) | Advisories | Reached through | Where | Platform exposure | Finding |
|---|---|---|---|---|---|
| `nodemailer` 6.10.1 | high: GHSA-rcmh-qjqh-p98v, GHSA-2x7j-588g-ccc2, GHSA-v53p-9fqp-m79j (address parser DoS), GHSA-r7g4-qg5f-qqm2 (OAuth2 TLS), GHSA-p6gq-j5cr-w38f (`raw` message option) | direct | platform backend (also the OTA backend and `@velexis/testing`) | the worker parses the addresses of the outbox; the API validates every address (`format: email`) before it queues one; OAuth2 and `raw` are not used | F-2 |
| `multer` 2.4.0 | high: GHSA-q7qp-rjg7-q26m (DoS through a pending `fileFilter`) | `@nestjs/platform-express` 11.2.8 (the latest 11.x) | platform and OTA backends | none: the platform API registers no multipart route; multer runs only for `FileInterceptor` routes | F-3 |
| `zod` 3.25.76 | high: GHSA-mrhx-c7xc-m3w5 (memory on oversized constrained collections) | direct | portal, platform admin (also the OTA admin; `kysely-codegen` in development) | server actions validate form data; Next.js caps a server action's body at 1 MB by default (neither app raises it) | F-4 |
| `tinypool` 1.1.1 | critical: GHSA-85c8-ppgw-ccpr, GHSA-5gmw-xhrv-c9v3 | `vitest` 3.2.7 | every package (development) | test runner only, never shipped | F-5 |
| `happy-dom` 17.6.3 | critical: GHSA-37j7-fg3j-429f; high: GHSA-w4gp-fjgq-3q4g, GHSA-c8p4-j97h-3vg8, GHSA-6q6h-j7hj-3r64, GHSA-834v-8h66-3h79 | direct and `vitest` | DOM tests (development) | renders the repository's own components only | F-5 |
| `undici` 6.29.0 | high: GHSA-2m5v-pch6-74hx, GHSA-qrxm-fqhp-jwvm, GHSA-xjj6-f33q-929c | `@redocly/cli` 1.34.22 | `@velexis/api-types` (development) | the contract lint, run on the repository's documents | F-5 |
| `@faker-js/faker` 7.6.0 | high: GHSA-qxc2-j82w-r537 | `@redocly/cli` 1.34.22 | `@velexis/api-types` (development) | as above | F-5 |

## 8. The two Next.js apps: CSP, cookies and headers

| | Portal (`platform/frontend`) | Platform admin (`platform/admin`) |
|---|---|---|
| Content-Security-Policy | per request from `middleware.ts` (`src/lib/csp.ts`) with a fresh 128-bit nonce: `default-src 'self'; script-src 'self' 'nonce-…'` (`'unsafe-eval'` only with `APP_ENV=development`); `style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self' <OTA admin origin>` (the console hand-off page: the OTA admin origin only); `frame-ancestors 'none'; base-uri 'self'; object-src 'none'` | per request from `middleware.ts` with a fresh nonce: the same directives with `form-action 'self'` |
| Session cookies | `__Host-vxp_at` (15 minutes) and `__Host-vxp_rt` (30 days): `HttpOnly; Secure; Path=/; SameSite=Lax`; the flow cookies `__Host-vxp_mfa`, `__Host-vxp_reset`, `__Host-vxp_invite` are `SameSite=Strict`; `__Host-vxp_next` and `__Host-vxp_connect` (Stripe's top-level return) are `Lax` | `__Host-vxa_at` (15 minutes), `__Host-vxa_rt` (12 hours), `__Host-vxa_mfa`: `HttpOnly; Secure; Path=/; SameSite=Strict` |
| Other headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on the token pages, `strict-origin` on the console hand-off), `Permissions-Policy` denying camera, microphone, geolocation, payment, USB and topics; no `X-Powered-By` | `X-Robots-Tag: noindex`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, the same `Permissions-Policy`; no `X-Powered-By` |
| At Caddy | `Strict-Transport-Security: max-age=31536000`, `X-Frame-Options: DENY`, no `Server` | the same; an IP allow-list for the admin host is prepared in the Caddyfile and left to the launch checklist (PBE-065) |

No token reaches browser JavaScript in either app: the platform tokens exist only in those cookies and in the apps' server code (PFE-028 checks the portal's rendered pages for tokens end to end, PAD-016 the admin's headers and cookies). Accepted, no task: `style-src 'unsafe-inline'` (inline `style` attributes of the components; scripts stay nonce-only), and HSTS without `includeSubDomains`, which would bind every name under the base domain, the OTAs' storefronts included.

## 9. Making MFA mandatory for owners (PADR-0008 follow-up)

**Today.** MFA is optional for portal users. Every sensitive action of PADR-0008 already needs MFA and a recent step-up (the matrix proves it for all 15), going live needs the owner's MFA (`LIVE_PRECONDITIONS_UNMET`, `missing: mfa`), and every member of a live OTA needs MFA to open its console.

**What a stolen owner password alone still allows** (no step-up needed): opening the Stripe Customer Portal (change the card, cancel the subscription, which suspends the OTA), inviting a member (persistence), revoking or rolling API keys and removing members (an outage), adding custom domains, editing the OTA profile, and every read of the OTA, the team and the masked connections.

**Recommendation.** Keep MFA optional while an OTA is test-only, as decided for the "OTA in minutes" promise ([`decisions.md`](../../docs/mvp/decisions.md) §2, PADR-0008 "Alternatives"), and make it mandatory for the **owners and admins of a live OTA**: on every portal operation of a live OTA, an owner or admin without MFA answers `403 MFA_REQUIRED` (reads included, as the console rule does), the portal sends them to the MFA set-up, and granting owner or admin on a live OTA (`updateMember`, `acceptInvitation`) needs MFA. The other roles stay as they are: they cannot change money, credentials or the team. This closes the "password alone" list above for the OTAs that take real money, without slowing anyone's first test OTA. It is a policy change of PADR-0008, so it is a question to the lead, not a task: if approved, it needs a dated revision of PADR-0008, a backend task (the rule in the tenant guard's path, with tests and a matrix column) and a portal task (the set-up prompt).

**Decision (2026-11-05, lead decision (5b)).** Approved: MFA is mandatory for the owners and admins of live OTAs, enforced when the OTA goes live (`goLive` already needs the acting owner's MFA and a step-up) and at the first portal sign-in of any owner or admin of a live OTA after that, with the enrolment then and there before any other portal page. The reasons are the ones above. [PADR-0008](adr/0008-email-verification-and-mfa-policy.md) records it in its revision of 2026-11-05 (the dated note under its MFA table, FIX-W43-PLATFORM), and two tasks of the plan implement it: [PBE-071](plans/agent-tasks.md#pbe-071--make-mfa-mandatory-for-the-owners-and-admins-of-live-otas-in-the-platform-api) (the API: `403 MFA_REQUIRED` on the `portal` operations of such an account until it enrols, `getMe` saying so, no self-service disabling while the role lasts, and a column of the auth matrix) and [PFE-030](plans/agent-tasks.md#pfe-030--send-the-owners-and-admins-of-live-otas-to-mfa-enrolment-before-any-other-portal-page) (the portal's enrolment gate). Test-only OTAs, agents, finance members and viewers keep MFA optional. Unlike the recommendation above, granting owner or admin on a live OTA (`updateMember`, `acceptInvitation`) is not refused for an account without MFA: the account meets the gate at its next portal request and enrols there (the PADR-0008 note), which closes the same gap without a new refusal on the team pages.

## 10. Findings

### F-1 · Medium · A disabled or deleted account keeps the portal API for up to 15 minutes

**Evidence.** `PortalAuthGuard` verifies the token's signature and claims only (`src/common/auth/portal-auth.guard.ts`); `AdminAuthGuard` re-reads the account on every request (architecture §3.1). `RecentMfaGuard` re-reads the account but checks `mfaEnabled` only, not `status`, and `TenantRoleGuard` reads the membership, not the account's state. A probe of this review: after an admin disabled the account, the account's unexpired access token still answered `200` on `getTenant`, `201` on `createApiKey` (a new secret key) and `200` on `setPayoutAccount` (a new bank account, with the token's recent step-up); after the account was erased (`deleted_at` set), it still answered `200` on `getTenant` and `201` on `createApiKey`, while `setPayoutAccount` answered `401` (the step-up guard finds no account); in both cases `getMe` and `createConsoleToken`, which read the account, answered `401`.

**Impact.** Disabling an account is the platform admin's answer to a compromised or abusive account (PADR-0006); revoking its refresh families does not end the access token it already holds, so the holder keeps up to 15 minutes to mint keys, change the payout account (a disabled account; the step-up actions refuse an erased one) or remove members. ADR-0008 accepts 15-minute stateless tokens for sign-out, but the lead's decision of 2026-10-24 (FIX-W29-SECURITY) already refuses the tokens of disabled or deleted customers on the OTA side, and the admin guard does the same for admins.

**Status: fixed (2026-11-05, PBE-067; the rule confirmed by lead decision (5a)).** `PortalAuthGuard` reads the account on every request and answers `401 UNAUTHENTICATED` for a missing, erased, `deleted` or `disabled` one, before the e-mail check; `locked` and `pending_verification` keep their answers. The probe above, repeated in [`auth-guards.int.test.ts`](../backend/test/integration/common/auth-guards.int.test.ts), now answers `401` on `getMe`, `getTenant`, `createApiKey` and `setPayoutAccount` (with a step-up of now) once the account is disabled or erased, and writes nothing; the auth matrix's `disabledAccount` and `erasedAccount` columns (§4) prove the `401` on every `portal_unverified` and `portal` operation. Dated notes: [PADR-0009](adr/0009-platform-api-surface-and-authentication.md) item 4 and [architecture §3.1](architecture.md#31-tokens).

**Fix.** `PortalAuthGuard` re-reads the account (`AccountAuthStates`, one primary-key read, as the admin guard) and refuses a missing, deleted or disabled one with `401 UNAUTHENTICATED`; a dated note in PADR-0009 item 4 and architecture §3.1; a disabled-account column in the auth matrix. **Task:** PBE-067 (its first step is the lead's confirmation of the rule).

### F-2 · High (advisory); reachable: Medium · `nodemailer` 6.10.1 in the platform backend

**Evidence.** §7: five high advisories, fixed in 10.0.6 and later (a major upgrade; [tech-stack](../../docs/mvp/tech-stack.md) pins 6.x).

**Impact.** The address-parser DoS needs a crafted address list in a message's headers; the API validates every recipient as one e-mail address (`format: email`) before it queues an e-mail, which leaves little room, but the worker still runs the vulnerable parser on every send. The OAuth2 and `raw` advisories concern options the mailer does not use.

**Status: fixed (2026-11-05, PBE-068).** The platform backend pins `nodemailer` 10.3.1, the release OBE-093 pins in the OTA backend and `@velexis/testing`, without `@types/nodemailer` (Nodemailer ships its own declarations from 10.0). `pnpm audit --prod` lists no `nodemailer` advisory any more; the gateway keeps `disableFileAccess`, `disableUrlAccess` and no `raw` messages, which `mailer.gateway.test.ts` proves through the real transport.

**Fix.** Upgrade to nodemailer 10.x in the platform backend, adapt `mailer.gateway.ts` to its API, run the outbox tests against Mailpit, update the tech-stack row. **Task:** PBE-068. (The OTA backend and `@velexis/testing` use the same version; the OTA review, OBE-084, and the foundation plan own those.)

### F-3 · High (advisory); reachable: Low · `multer` 2.4.0 through NestJS 11.2.8

**Evidence.** §7: GHSA-q7qp-rjg7-q26m, fixed in multer 2.5.0, which `@nestjs/platform-express` 12.x requires; 11.2.8 is the latest 11.x.

**Impact.** None as built: multer runs only on routes with a file interceptor, and the platform API has none (multipart bodies are not parsed at all).

**Fix.** *Revised 2026-11-05 (lead decision (5c)).* NestJS stays on 11 ([`decisions.md`](../../docs/mvp/decisions.md), components 1 and 4), so no move to NestJS 12 is planned for it (the review first proposed one when no 11.x patch would require multer 2.5.0). OBE-094 adds a root `pnpm.overrides` entry that resolves `multer` below `@nestjs/platform-express` to 2.5.0; one lockfile serves the workspace, so the entry lifts the platform backend's copy too. PBE-069 confirms with `pnpm audit --prod` and `pnpm why multer` that the platform backend resolves 2.5.0 once OBE-094 has merged, and adds the test that keeps the API free of multipart routes (file interceptors), so the parser stays unreachable whatever its version. **Tasks:** OBE-094 (the override), PBE-069 (the confirmation and the guard test).

### F-4 · High (advisory); reachable: Low · `zod` 3.25.76 in the portal and the platform admin

**Evidence.** §7: GHSA-mrhx-c7xc-m3w5, fixed in 4.6.6 (a major upgrade; tech-stack pins 3.x).

**Impact.** A signed-in person could post an oversized form to a server action whose schema validates a constrained collection; Next.js caps a server action's body at 1 MB by default (neither app raises it) and Caddy the apps' request bodies at 5 MB, which bounds the memory the validation can take.

**Fix.** Upgrade to zod 4.x in each app, adapt the form schemas to its API and run the app's UI tests; update the tech-stack row once for both. **Tasks:** PFE-029 (portal), PAD-017 (admin).

### F-5 · Critical (advisory); reachable: Low · Test and contract tooling

**Evidence.** §7: `tinypool` and `happy-dom` (through and next to `vitest` 3.2.7), `undici` and `@faker-js/faker` (through `@redocly/cli` 1.34.22): 3 critical and 8 high advisories (`happy-dom` 4, `undici` 3, `@faker-js/faker` 1; with the 7 high of production dependencies, the 15 of the workspace).

**Impact.** Development and CI only: nothing of them ships to the VM, and they run the repository's own tests and documents. The audit gate of §12 still fails on them.

**Fix.** Upgrade `vitest` to a release whose `tinypool` is 2.1.2 or later, `happy-dom` to 21.0.4 or later, and `@redocly/cli` to a release without `undici` < 6.29.1 and `@faker-js/faker` < 10.5.0 (1.34.23 fixes `undici`; `faker` needs 2.x), with the tech-stack rows and the test-timing rules of the workspace. **Task:** PBE-070, a workspace-wide upgrade the lead may prefer to move to the foundation plan.

## 11. Questions to the lead

1. **F-1:** confirm the rule of PBE-067 — the portal guard refuses the tokens of disabled and deleted accounts at once, as the admin guard and the OTA's customer guard do; `locked` (a sign-in lockout) and `pending_verification` keep their answers.
   - *Closed 2026-11-05 (lead decision (5a)).* Confirmed as written: an unexpired portal token of a disabled, deleted or erased account answers `401 UNAUTHENTICATED` at once; `locked` and `pending_verification` keep their answers. PBE-067 implements it (F-1, "Status").
2. **MFA for owners:** approve the recommendation of §9 (mandatory for owners and admins of live OTAs), keep MFA optional, or make it mandatory for every owner.
   - *Closed 2026-11-05 (lead decision (5b)).* The recommendation is approved: mandatory for the owners and admins of live OTAs, enforced at go-live and at their first portal sign-in after it, with the enrolment then and there ([PADR-0008](adr/0008-email-verification-and-mfa-policy.md) revision of 2026-11-05, §9 "Decision"). Tasks: PBE-071 (platform backend) and PFE-030 (portal).
3. **The audit gate:** PBE-062's Verify ends with `pnpm audit --audit-level high`, which fails until F-2 to F-5 are fixed by major upgrades that the review may not make; confirm that the review is done with its findings recorded, and whether F-5 belongs to the foundation plan.
   - *Closed 2026-11-05 (lead decision (5d)).* PBE-062 stays done on its acceptance criteria, with its findings recorded; the dependency findings keep the advisory's own severity with the reachability beside it (§1, findings table), the M6 go/no-go keeps "`pnpm audit --prod` clean of high and critical", and PBE-070 (F-5) stays in the platform plan.
