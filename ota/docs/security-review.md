# OTA backend security review (M6)

The security review of the OTA backend before launch (task OBE-084 of [`plans/agent-tasks.md`](plans/agent-tasks.md)). It
follows the shared format of the platform's review (PBE-062, `platform/docs/security-review.md`): scope, method, the
checklist of [conventions §12](../../docs/mvp/conventions.md#12-security-checklist-every-pr) per module, the dependency
audit and the secret scan, and every finding with its severity and status. Every finding is either fixed in OBE-084
(with the test that proves it) or a task of this plan, milestone M6, before launch.

- **Reviewed:** 2026-11-04, on `f7efd7b` (wave 41) with the tests of OBE-084.
- **Result:** the authentication matrix, the rate limits, the response headers and the redaction coverage hold; the
  Caddy smoke test proves the forwarding headers. `pnpm audit --prod` reports **7 high** advisories (no critical) in
  three dependencies whose fix is a major upgrade (`nodemailer`, `zod`) or an override (`multer`, which only NestJS 12
  requires in its fixed version): they are **open** (OTA-SR-01 to OTA-SR-03) with tasks OBE-093, OBE-094 and OAD-020,
  so the review is not closed until those are merged.

## 1. Scope

| In scope | Not in scope (own review or task) |
|---|---|
| `ota/backend` (API and worker): every operation of the OTA document (135), the guards of the request pipeline ([architecture §3](architecture.md#3-request-pipeline)), the rate limits of [§8](architecture.md#8-rate-limits), response headers, the redaction of logs and persisted payload copies ([§4](architecture.md#4-data-access), [§9](architecture.md#9-security-notes-specific-to-the-ota-backend)) | The platform backend, portal and platform admin (PBE-062) |
| What Caddy forwards to the OTA API: `api.ota.example.com` and the storefronts' `/api/*` ([`deploy/caddy/Caddyfile`](../../deploy/caddy/Caddyfile)) | The OTA admin's pages, CSP and session expiry (OAD-019) |
| The production dependencies of the workspace (`pnpm audit --prod`) and the repository's history (secret scan) | The PCI evidence pack and the penetration test of the airline-card path (OBE-085, OBE-086) |

## 2. Method

| Area | How | Evidence |
|---|---|---|
| Authentication matrix | Every operation of the operations index (`otaOperations`, generated from the document) called with 12 credentials: none, the storefront edge, `pk_`, `sk_` scoped `storefront`, `sk_` scoped `console`, the OTA admin's service key, a wrong-tenant credential, the right one, a `console:automation` key with exactly the operation's `x-permission` and one with every other permission, and the service key with the forwarding headers of `api.ota.example.com` and of a storefront's `/api/*`. The expected answer of each cell is computed from the operation's `x-scope`, `x-edge-only`, `x-permission`, `security` and pending state, not read back from the code. 1,454 requests (135 operations by 10 credentials, and the two permission keys on the 52 guarded console operations). | [`auth-matrix.int.test.ts`](../backend/test/integration/m6/auth-matrix.int.test.ts) |
| Rate limits | One test per limit of architecture §8, through the real routes: the limit used up by one end user, the next request `429 RATE_LIMITED` with `Retry-After`, another end user not limited; `console.auth.signIn` per forwarded end-user IP through the service caller (two staff members never share a bucket, the service key without `X-Velexis-End-User-IP` is `400`); the handler-side counters (customer sign-in lockout, airline-card attempts per checkout, the tenant's decline suspension); no counted value in clear in the Redis keys or the log lines. A coverage test fails when a limit of `RATE_LIMITS` has no test. | [`rate-limits.int.test.ts`](../backend/test/integration/m6/rate-limits.int.test.ts); the counting of airline-card declines with the Amadeus stub: [`airline-card-completion.int.test.ts`](../backend/test/integration/payments/airline-card-completion.int.test.ts) (OBE-051) |
| Response headers | helmet's headers and no `X-Powered-By` on every kind of answer (successes, every guard's refusal, validation, unknown route, `501`, health); `Cache-Control` with `no-store` on every answer with personal data, a session or an error; the document download and the public image with `nosniff`, their own type, CSP and caching. | [`headers.int.test.ts`](../backend/test/integration/m6/headers.int.test.ts) |
| Redaction coverage | Every schema property marked `x-sensitive`, every property the central list names (`REDACT_PATHS` of `@velexis/logger`) and the document and card numbers of its literal paths, found by walking the whole document (more than a thousand places), with a marker value at its place: absent from log lines (top level and one level down), `supplier_requests`, `staff_actions`, `idempotency_keys` (plain copy; the answer is kept encrypted), `payment_events` and `notifications.payload` (no template variable is sensitive). A test fails when a new writer of one of these tables appears. | [`redaction-coverage.contract.test.ts`](../backend/test/contract/redaction-coverage.contract.test.ts) |
| Caddy | `caddy-smoke.sh` step 6c: on `api.ota`, `api.platform` and the storefront's `/api`, the upstream receives exactly Caddy's `X-Forwarded-For` and `X-Forwarded-Host`, also when the client forges them, and never a client's `X-Velexis-Edge`. Run with Caddy 2.8.4 under the machine-wide lock after checking that its ports were free (from `/proc/net/tcp`, as the script does: `ss` is not installed on the review machine). | [`deploy/caddy/test/caddy-smoke.sh`](../../deploy/caddy/test/caddy-smoke.sh) (504 checks passed) |
| Dependencies | `pnpm audit --prod` at the workspace root (the registry's audit endpoint answered). | §5 |
| Secret scan | The tracked files (2,314, without the frozen `docs/velexis-sdk` and `docs/amadeus-api`) and every added line of the 482 commits of history, searched for Stripe live and test secret keys (`sk_`, `rk_`, `pk_live_`, `whsec_`), portal and booking tokens (`ptk_`, `vxbt_`), private keys, AWS, GitHub, Slack and Google keys, JWTs and DSNs with a password. | §6 |
| Existing evidence | The isolation, CSRF, cookie, permission and card tests of earlier milestones, mapped per module in §4. | §4 |

## 3. Results of the tests of OBE-084

### 3.1 Authentication matrix

Every one of the 135 operations answered every credential as its contract metadata says (all 15 tests pass):

- **No credential:** `401 INVALID_API_KEY` on every authenticated route and every pending (`501`) route; the open routes
  (`getPublicAsset`, `downloadFile`, the three Stripe receivers, health) answer without one.
- **Storefront edge and `pk_`:** customer scope on `customer` and `both` operations; `401 UNAUTHENTICATED` where the
  operation requires a customer (every `security` alternative of the caller carries a customer or a guest booking
  token, the booking operations included through the booking access guard); `403 SCOPE_NOT_ALLOWED` on every console
  operation (`console_operation`) and, for keys, on the `x-edge-only` airline-card completion (`edge_only`).
- **`sk_` scoped `storefront`:** customer scope on customer operations; `403 SCOPE_NOT_ALLOWED` (`storefront_key`) on
  every console operation, the staff-session ones included.
- **`sk_` scoped `console` without a staff token:** the staff-session operations open (sign-in, refresh, sign-out),
  `console.auth.me` `401`, every other console operation `403 SCOPE_NOT_ALLOWED` (`requiredScope:
  console:automation`).
- **The service key:** console operations only (`403 SCOPE_NOT_ALLOWED`, `service_console_only`, elsewhere); every
  console operation but sign-in, refresh and sign-out needs the staff token (`401`).
- **`x-permission`:** a `console:automation` key holding exactly the operation's permission is let in, one holding
  every other permission is refused `403 FORBIDDEN` with `details.requiredPermission` equal to the operation's
  `x-permission` (52 operations).
- **Wrong tenant:** tenant beta's customer cookie on alpha's storefront, beta's staff token with alpha's console key,
  beta's portal token or refresh token with alpha's key, and beta's publishable key from alpha's storefront origin are
  all refused (`401` or `403 ORIGIN_NOT_ALLOWED`); beta's own sessions still work afterwards.
- **The service key through Caddy:** with the `X-Forwarded-For` and `X-Forwarded-Host` Caddy adds on
  `api.ota.example.com`, `401 INVALID_API_KEY` on all 135 operations; with the edge headers as well (a storefront's
  `/api/*`), `400 INVALID_REQUEST` (`edge_with_api_key`), refused before the key is compared. Each request of the
  first kind is logged exactly once as `caller.service_key_not_direct` with the reason `forwarded`, the second kind
  not at all; no log line holds the key.

### 3.2 Rate limits

Every limit of architecture §8 answers `429 RATE_LIMITED` with `Retry-After` within its window once used up, and never
limits another end user: `auth.signIn` and `console.auth.signIn` (10 per minute per end-user IP; an IPv6 end user per
/64), the customer lockout (5 failures per identity, `423 ACCOUNT_LOCKED`, also for the right password, from any
address), account e-mails (5 per hour per IP and 3 per hour per e-mail across the three operations), shopping (30 per
minute per IP for the edge and `pk_` together; `sk_` not counted), `bookings.lookup` (5 failures per 15 minutes per IP
and per tenant and reference), checkout payments (10 per minute per IP), the airline card (5 per minute per IP, 60 per
hour per tenant, a checkout with 3 declined attempts and a suspended method refuse the card unsent), console
operations (600 per minute per staff session or key; a `429` writes no `staff_actions` row) and public downloads (120
per minute per IP across images and signed files). Every throttler key in Redis is `rl:<throttler>:<SHA-256>`, and no
address, e-mail address or booking reference the limits counted appears in clear in a Redis key or a log line.

### 3.3 Response headers

Every JSON answer carries `Content-Security-Policy: default-src 'none';frame-ancestors 'none'`, HSTS,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, COOP and
CORP `same-origin`, and no `X-Powered-By` or `Server`. A customer's session, account and bookings and every console
answer are `private, no-store`; the signed download link, sign-in, health and every error `no-store`. A document
download is `application/pdf`, an attachment, `nosniff`, `private, no-store`; a public image keeps its sniffed type,
`nosniff`, its own CSP `default-src 'none'`, CORP `cross-origin` and `public, max-age=31536000, immutable`.

### 3.4 Redaction coverage

The walk finds the six `x-sensitive` fields of the airline card and more than a thousand places of the document that the
central list names (tokens, passwords, client secrets, cards and forms of payment, document and discount-card numbers,
holders and expiries). None of their values reaches a log line, and none reaches a persisted copy but the two documented
exceptions: a card's brand, and an identity document's `holder` flag and `expiryDate` outside a card (db README §8
drops a card's, not a passport's). An answer that holds a sensitive value is kept encrypted in `idempotency_keys`; no
e-mail template takes a sensitive variable.

## 4. Conventions §12 per module

✔ holds, with the evidence; – does not apply to the module.

| Module | No secrets | No card data / tokens in logs and copies | `tenantTx`, isolation | Guards, `x-scope`, permissions, ownership | Validation, bound SQL | Cookies, CSRF | Idempotent external calls, signed webhooks | Rate limits | No leaking errors | Airline-card PCI controls |
|---|---|---|---|---|---|---|---|---|---|---|
| `common` | ✔ §6 | ✔ redaction coverage; `job-validation.test.ts` (ids only in jobs) | ✔ `tenant-isolation`, `customer-isolation`, `office-isolation` | ✔ auth matrix | ✔ the validation interceptor on every bound route (route parity) | ✔ `cookie-writer.test.ts`, `csrf-matrix.int.test.ts` | ✔ `idempotency.int.test.ts` | ✔ §3.2 | ✔ `error.filter.test.ts` | – |
| `tenancy` | ✔ | ✔ keys compared by HMAC, never logged | ✔ `tenant-resolution`, `caller.int.test.ts` | ✔ auth matrix (service key through Caddy, wrong tenant) | ✔ | – | – | ✔ | ✔ | – |
| `identity` | ✔ | ✔ passwords, tokens censored (§3.4) | ✔ | ✔ auth matrix | ✔ | ✔ `cookie-mode.int.test.ts` | – | ✔ sign-in, lockout, e-mails | ✔ `INVALID_CREDENTIALS` names no field | – |
| `account` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | – | – | ✔ | – |
| `storefront`, `reference` | ✔ | ✔ | ✔ | ✔ | ✔ | – | – | ✔ downloads | ✔ | – |
| `amadeus`, `shopping`, `pricing` | ✔ | ✔ `supplierRequestBody` (§3.4) | ✔ | ✔ | ✔ | – | ✔ reads retried, writes never | ✔ shopping | ✔ `no-net-amounts.int.test.ts` | – |
| `checkout`, `payments` | ✔ | ✔ `pan-absence.int.test.ts`, `scrub-card-copies.int.test.ts` | ✔ | ✔ `x-edge-only` (§3.1) | ✔ | ✔ | ✔ `webhooks.int.test.ts`, `connect-webhooks.int.test.ts` | ✔ payments, airline card | ✔ | ✔ OADR-0004, OADR-0017; evidence pack OBE-085, gate OBE-086 |
| `bookings`, `documents` | ✔ | ✔ | ✔ | ✔ booking access guard (§3.1) | ✔ | ✔ | ✔ OADR-0003 | ✔ lookup | ✔ | – |
| `notifications` | ✔ | ✔ secrets only in `secretData` (encrypted) | ✔ | – | ✔ | – | – | – | – | – |
| `console`, `settings` | ✔ | ✔ `staffActionRow` (§3.4) | ✔ | ✔ `permission-matrix.int.test.ts`, auth matrix | ✔ | – | ✔ | ✔ console | ✔ supplier details in console scope only | – |
| `provisioning`, `jobs`, `health` | ✔ | ✔ | ✔ | ✔ health public, readiness local only | – | – | – | – | ✔ | – |

## 5. Dependency audit

`pnpm audit --prod` on 2026-11-04: **29 advisories: 0 critical, 7 high, 19 moderate, 3 low.** None of the fixes is a
patch inside the pinned versions' ranges for the high ones, and the review task makes no major upgrade and no override,
so each is a finding with a task:

| Package (version) | Reaches | Advisories | Fixed in | Finding |
|---|---|---|---|---|
| `nodemailer` 6.10.1 | `ota/backend`, `platform/backend` (`packages/testing` in development) | 5 high (GHSA-rcmh-qjqh-p98v, GHSA-p6gq-j5cr-w38f, GHSA-2x7j-588g-ccc2, GHSA-v53p-9fqp-m79j, GHSA-r7g4-qg5f-qqm2), 15 moderate, 1 low | 10.1.4 (major) | OTA-SR-01 |
| `multer` 2.4.0, pinned by `@nestjs/platform-express` 11.2.8 (the last 11.x) | `ota/backend`, `platform/backend` | 1 high (GHSA-q7qp-rjg7-q26m) | 2.5.0, a minor release of `multer`; `@nestjs/platform-express` requires it only from 12 (a major, and [decisions.md](../../docs/mvp/decisions.md) names NestJS 11), so the proposed fix is a root `pnpm.overrides` entry within NestJS 11, as `next>postcss` is | OTA-SR-02 |
| `zod` 3.25.76 | `ota/admin` (`platform/admin`, `platform/frontend`: PBE-062) | 1 high (GHSA-mrhx-c7xc-m3w5) | 4.6.6 (major) | OTA-SR-03 |
| `fast-uri` 3.1.8 (through `ajv` 8.20.0) | every package with `ajv` | 2 moderate, 2 low | 3.1.9, inside `ajv`'s range | OTA-SR-04 |
| `qs` 6.16.0 (through `stripe` 18.5.0; `express` already resolves 6.16.1 and later) | both backends | 1 moderate | 6.16.1, inside `stripe`'s range (`^6.11.0`) | OTA-SR-04 |

## 6. Secret scan

No secret was found. Every match is a development value of `.env.example` (`dev_*` database passwords, also in
`ci.yml`), a dummy value of a test (`dummy-…-password`, `sk_live_0123456789abcdef…`, `pk_live_1TestPublishableKeyOnly`,
`sk_live_PFE024DummySecret`, `whsec_PFE024DummyWebhookSigning01`, a PEM header with `A` characters), an example of an
OpenAPI document (`sk_test_Ab12Cd34…`, `ptk_HStG6k…`, `pk_live_3fA9x2…`, unsigned example JWTs), or a run of characters
that only looks like a key inside embedded binary data (a Google-API-key-shaped `AIza…` inside the gzip-compressed,
base64-encoded `data-gz` block of `docs/ota-build/ota-model-1-b2c.html`). The history holds no private key body, no
`sk_live_`/`rk_live_`/`whsec_` value but these dummies, and no AWS, GitHub or Slack token.

## 7. Findings

Severity: **Critical** (exploitable now, data or money at risk), **High** (a vulnerability of the shipped code or a
dependency advisory rated high or critical), **Medium**, **Low** (a gap without a known exploit), **Info** (recorded,
no change). A dependency advisory keeps the advisory's severity; its reachability is noted.

| ID | Severity | Area | Finding | Status |
|---|---|---|---|---|
| OTA-SR-01 | High | Dependencies | `nodemailer` 6.10.1 in the OTA backend: the address parser's quadratic and recursive parsing (DoS), the `raw` option and the OAuth2 token fetch advisories. Reachability: the worker sends to addresses the API validated (one plain address of at most 254 characters), with no `raw`, no OAuth2 and no file or URL content, so the DoS needs an address the validation lets through; still the shipped version is vulnerable. | Open: **OBE-093** |
| OTA-SR-02 | High | Dependencies | `multer` 2.4.0 through `@nestjs/platform-express` 11.2.8 (DoS by a pending asynchronous `fileFilter`). Reachability: none today, the API parses multipart bodies itself (`common/http/body-parsers.ts`) and never mounts multer. Proposed fix: override `multer` to 2.5.0 below `@nestjs/platform-express` 11.2.8 (NestJS 12 would change a decision of the owner). | Open: **OBE-094** |
| OTA-SR-03 | High | Dependencies (OTA admin) | `zod` 3.25.76 (memory exhaustion validating oversized constrained collections) in the OTA admin's server actions. | Open: **OAD-020** |
| OTA-SR-04 | Medium | Dependencies | `fast-uri` 3.1.8 and `qs` 6.16.0 (moderate and low advisories), fixed by a lockfile refresh inside their dependents' ranges. | Open: OBE-094 (step 2) |
| OTA-SR-05 | Low | Contract | The OTA document does not list every answer the API gives: `400 VALIDATION_FAILED` (a path value) or `INVALID_REQUEST` (an edge header beside an API key) on 18 operations (5 of them pending), and the credential refusals (`401`, `403`) of the three Stripe receivers. Clients and the response conformance of the matrix cannot check those answers' shape. | Open: **OBE-095** |
| OTA-SR-06 | Info | Redaction | The `payment_events` rows built by the bookings, cancellation and refund code carry objects of ids, codes and amounts the code builds itself, not copies of a supplier or gateway payload, so they do not pass the redactor; every copied payload does (§3.4). | Accepted |
| OTA-SR-07 | Info | Card data | A Stripe card summary (`PaymentCard`: brand, BIN, last 4, expiry month and year) is answered and kept in idempotency copies; it holds no card number (Stripe keeps it) and the document marks it "no sensitive data". | Accepted |

No finding of the review changes a rule, a limit, a guard or a redaction; none of them needed a fix in OBE-084 itself.

## 8. Re-running the review

```bash
pnpm --filter @velexis/ota-backend test -- redaction-coverage
pnpm --filter @velexis/ota-backend exec vitest run --config vitest.int.config.ts test/integration/m6
bash deploy/caddy/test/caddy-smoke.sh   # alone on the machine: ports 2019, 3000-3002, 3100, 4000, 8080, 8443 free
pnpm audit --prod
```

The matrix, the rate-limit coverage test and the redaction walk follow the document and `RATE_LIMITS` by themselves: a new
operation, limit or sensitive property is in the next run without a change here.
