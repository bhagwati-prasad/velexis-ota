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
- **2026-11-05 (OBE-094):** OTA-SR-02 (`multer`) and OTA-SR-04 (`fast-uri`, `qs`) are closed: a root `pnpm.overrides`
  entry lifts `multer` to 2.5.0 below `@nestjs/platform-express` 11 (NestJS stays on 11.2.8) and a lockfile refresh
  moves `fast-uri` to 3.1.9 and `qs` to 6.17.1 inside their dependents' ranges. `pnpm audit --prod` now reports **6
  high** (no critical), all of them OTA-SR-01 (`nodemailer`) and OTA-SR-03 (`zod`) (§5).
- **2026-11-05 (OBE-093):** OTA-SR-01 (`nodemailer`) is closed: the OTA backend and `@velexis/testing` pin `nodemailer`
  10.3.1, and `pnpm audit --prod` lists no `nodemailer` advisory reaching either of them (§5). The same advisories stay
  listed for the platform backend's 6.10.1 until PBE-068 (the platform review's F-2) moves it to the same release.
- **2026-11-05 (OBE-095):** OTA-SR-05 is closed: the OTA document lists every answer of the authentication matrix but
  a pending operation's `501` (the `400` of 18 operations and the `401` and `403` of the three Stripe receivers, with
  the shared error responses), and the matrix now checks each of those answers against it (§3.1).
- **2026-11-05 (OAD-020):** OTA-SR-03 (`zod`) is closed: the OTA admin pins `zod` 4.6.7, and `pnpm audit --prod`
  lists no `zod` advisory reaching `ota/admin` (§5). The same advisory stays listed for the portal's and the platform
  admin's 3.25.76 (the platform review's F-4: PFE-029, PAD-017) until they move to the same release.
- **2026-11-05 (PFE-029, PAD-017):** the portal and the platform admin pin `zod` 4.6.7 as well (the platform review's
  F-4 is closed), so `pnpm audit --prod` reports no known vulnerabilities: 0 critical, 0 high. No finding of this
  review is open: OTA-SR-01 to OTA-SR-05 are closed and OTA-SR-06 and OTA-SR-07 accepted (§7), which is OBE-084's
  acceptance.

## 1. Scope

| In scope | Not in scope (own review or task) |
|---|---|
| `ota/backend` (API and worker): every operation of the OTA document (135), the guards of the request pipeline ([architecture §3](architecture.md#3-request-pipeline)), the rate limits of [§8](architecture.md#8-rate-limits), response headers, the redaction of logs and persisted payload copies ([§4](architecture.md#4-data-access), [§9](architecture.md#9-security-notes-specific-to-the-ota-backend)) | The platform backend, portal and platform admin (PBE-062) |
| What Caddy forwards to the OTA API: `api.ota.example.com` and the storefronts' `/api/*` ([`deploy/caddy/Caddyfile`](../../deploy/caddy/Caddyfile)) | The OTA admin's pages, CSP and session expiry (OAD-019) |
| The production dependencies of the workspace (`pnpm audit --prod`) and the repository's history (secret scan) | The PCI evidence pack and the penetration test of the airline-card path (OBE-085, OBE-086) |

## 2. Method

| Area | How | Evidence |
|---|---|---|
| Authentication matrix | Every operation of the operations index (`otaOperations`, generated from the document) called with 12 credentials: none, the storefront edge, `pk_`, `sk_` scoped `storefront`, `sk_` scoped `console`, the OTA admin's service key, a wrong-tenant credential, the right one, a `console:automation` key with exactly the operation's `x-permission` and one with every other permission, and the service key with the forwarding headers of `api.ota.example.com` and of a storefront's `/api/*`. The expected answer of each cell is computed from the operation's `x-scope`, `x-edge-only`, `x-permission`, `security` and pending state, not read back from the code. 1,454 requests (135 operations by 10 credentials, and the two permission keys on the 52 guarded console operations). Every answer but a pending operation's `501` is also checked against the document: a status the operation lists and a body of that response's schema (OBE-095). | [`auth-matrix.int.test.ts`](../backend/test/integration/m6/auth-matrix.int.test.ts) |
| Rate limits | One test per limit of architecture §8, through the real routes: the limit used up by one end user, the next request `429 RATE_LIMITED` with `Retry-After`, another end user not limited; `console.auth.signIn` per forwarded end-user IP through the service caller (two staff members never share a bucket, the service key without `X-Velexis-End-User-IP` is `400`); the handler-side counters (customer sign-in lockout, airline-card attempts per checkout, the tenant's decline suspension); no counted value in clear in the Redis keys or the log lines. A coverage test fails when a limit of `RATE_LIMITS` has no test. | [`rate-limits.int.test.ts`](../backend/test/integration/m6/rate-limits.int.test.ts); the counting of airline-card declines with the Amadeus stub: [`airline-card-completion.int.test.ts`](../backend/test/integration/payments/airline-card-completion.int.test.ts) (OBE-051) |
| Response headers | helmet's headers and no `X-Powered-By` on every kind of answer (successes, every guard's refusal, validation, unknown route, `501`, health); `Cache-Control` with `no-store` on every answer with personal data, a session or an error; the document download and the public image with `nosniff`, their own type, CSP and caching. | [`headers.int.test.ts`](../backend/test/integration/m6/headers.int.test.ts) |
| Redaction coverage | Every schema property marked `x-sensitive`, every property the central list names (`REDACT_PATHS` of `@velexis/logger`) and the document and card numbers of its literal paths, found by walking the whole document (more than a thousand places), with a marker value at its place: absent from log lines (top level and one level down), `supplier_requests`, `staff_actions`, `idempotency_keys` (plain copy; the answer is kept encrypted), `payment_events` and `notifications.payload` (no template variable is sensitive). A test fails when a new writer of one of these tables appears. | [`redaction-coverage.contract.test.ts`](../backend/test/contract/redaction-coverage.contract.test.ts) |
| Caddy | `caddy-smoke.sh` step 6c: on `api.ota`, `api.platform` and the storefront's `/api`, the upstream receives exactly Caddy's `X-Forwarded-For` and `X-Forwarded-Host`, also when the client forges them, and never a client's `X-Velexis-Edge`. Run with Caddy 2.8.4 under the machine-wide lock after checking that its ports were free (from `/proc/net/tcp`, as the script does: `ss` is not installed on the review machine). | [`deploy/caddy/test/caddy-smoke.sh`](../../deploy/caddy/test/caddy-smoke.sh) (504 checks passed) |
| Dependencies | `pnpm audit --prod` at the workspace root (the registry's audit endpoint answered). | §5 |
| Secret scan | The tracked files (2,314, without the frozen `docs/velexis-sdk` and `docs/amadeus-api`) and every added line of the 482 commits of history, searched for Stripe live and test secret keys (`sk_`, `rk_`, `pk_live_`, `whsec_`), portal and booking tokens (`ptk_`, `vxbt_`), private keys, AWS, GitHub, Slack and Google keys, JWTs and DSNs with a password. | §6 |
| Existing evidence | The isolation, CSRF, cookie, permission and card tests of earlier milestones, mapped per module in §4. | §4 |

## 3. Results of the tests of OBE-084

### 3.1 Authentication matrix

Every one of the 135 operations answered every credential as its contract metadata says (all 15 tests of OBE-084
pass, and the 16th of OBE-095 since 2026-11-05):

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
- **Conformance (OBE-095, 2026-11-05):** every answer but a pending operation's `501` matches the OTA document
  (`expectResponseToMatch` on every such cell, in the 12 column tests and in a 16th test that lists every mismatch of
  the whole matrix at once and proves that the cells left out are exactly the pending `501`s). Before OBE-095 the
  matrix checked only the answers whose status the operation listed; the others were finding OTA-SR-05: `400
  VALIDATION_FAILED` for a path value and `400 INVALID_REQUEST` for the edge header beside a key on 18 operations
  without a `400` (5 of them pending), and the `401 INVALID_API_KEY` and `403` (`ORIGIN_NOT_ALLOWED`,
  `SCOPE_NOT_ALLOWED`) of the three Stripe receivers, 84 cells in all. Against the document before the change the
  strict check fails in 10 of the 16 tests.

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

**2026-11-05 (OBE-094): `multer`, `fast-uri` and `qs` fixed.** `pnpm audit --prod` after the change: **23 advisories:
0 critical, 6 high, 16 moderate, 1 low**, all of them `nodemailer` (5 high, 16 moderate, 1 low: OTA-SR-01) and `zod` (1
high: OTA-SR-03); none for `multer`, `fast-uri` or `qs`. The same advisories also reach the platform's copies
(`nodemailer` in `platform/backend`: PBE-068; `zod` in `platform/admin` and `platform/frontend`: PAD-017, PFE-029), so
the audit is clean of high advisories only once those land as well. The table's `nodemailer` row counts 15 moderate: the
audit of 2026-11-04 listed 16, as its total of 19 moderate shows, and so does a run on the lockfile before this change.

- **`multer` 2.5.0** through the root `package.json`'s `pnpm.overrides` entry `"@nestjs/platform-express@11>multer":
  "2.5.0"`, beside `next>postcss`: every `@nestjs/*` package stays on 11.2.8 ([decisions.md](../../docs/mvp/decisions.md)
  names NestJS 11). One lockfile entry serves both backends, so the override also closes the platform backend's copy
  (PBE-062's finding F-3). The selector names the 11.x parent only, so a later major of `@nestjs/platform-express` keeps
  the `multer` it requires instead of being held at 2.5.0. 2.5.0 is a minor release of `multer` with the same API; the
  OTA API still parses multipart bodies itself (`common/http/body-parsers.ts`) and mounts no `FileInterceptor`. Remove
  the entry when the backends move to a NestJS release that requires `multer` 2.5.0 or later (an owner's decision).
- **`fast-uri` 3.1.9** (the latest 3.x, inside `ajv` 8.20.0's `^3.0.1`) and **`qs` 6.17.1** (the latest 6.x, inside
  `stripe` 18.5.0's `^6.11.0`) by a lockfile refresh without an override (`pnpm update fast-uri qs -r`, which changes no
  `package.json`). The refresh also moves the `qs` of `body-parser`, of the backends' own `express` 5.3.0 and of
  `superagent` (tests) from 6.16.1 to 6.17.1, the version that `@nestjs/platform-express`'s `express` 5.2.1 already
  used, so the workspace has one `qs`; its changelog from 6.16.1 lists parser and `stringify` fixes and one new
  `stringify` format, no breaking change. Reachability was low already: neither API parses URL-encoded bodies (the OTA
  API's parsers are JSON, raw webhook bytes and its own multipart) and Express 5's default `simple` query parser does
  not use `qs`, so `qs` runs inside the Stripe client's form encoding.

**2026-11-05 (OBE-093): `nodemailer` 10.3.1 in the OTA backend.** `ota/backend` (dependency) and `packages/testing`
(devDependency) pin `nodemailer` 10.3.1, the latest 10.x (`npm view nodemailer dist-tags`: `latest` 10.3.1, published
2026-10-29), which closes all 22 advisories `pnpm audit --prod` lists for 6.10.1 (5 high, 16 moderate, 1 low: the table
above counts one moderate fewer; the last ones, GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w and GHSA-85x2-q946-cp5h, are
fixed from 10.1.4). Nodemailer ships its own type declarations from 10.0, so `@types/nodemailer` is dropped from both
packages (its last release, 8.0.2, describes Nodemailer 8). `pnpm audit --prod` still lists the 22 `nodemailer`
advisories (5 high) until PBE-068, because it counts each advisory once and the platform backend's 6.10.1 carries them;
none of them has a path from `ota/backend` or `packages/testing` any more (`pnpm why nodemailer -r`: 10.3.1 for both,
6.10.1 for `platform/backend` only). On this task's base (wave 42, `53b5f12`) the totals are the same before
and after the change: 29 advisories, 0 critical, 7 high.

- **Breaking changes from 6.10 to 10.3** (the changelog's majors): 7.0 rewrote the SES transport (unused here), 8.0
  renamed the error code `NoAuth` to `ENOAUTH` (the gateway keeps any upper-case code as is), 9.0 checks TLS
  certificates when fetching remote content (the gateway fetches none) and 10.0 needs Node.js 20 (the backends run 22)
  and applies the other keys of a configuration beside its `url`, the URL's values winning. The gateway already parsed
  SMTP_URL itself (`parseConnectionUrl` from `nodemailer/lib/shared`, still exported); it now puts its own settings
  after the URL's (no logs, `disableFileAccess`, `disableUrlAccess`, the timeouts), so no query parameter of SMTP_URL
  changes them, and drops a nested `url` parameter that would win over them again.
- **Proof** (`mailer.gateway.test.ts`): the real transport of `createSmtpTransport`, with only its SMTP stage replaced by
  one that builds the message from the same stream the SMTP stage sends in DATA, refuses a path or a URL for an
  attachment, an HTML body and a `raw` message before reading it (`EFILEACCESS`, `EURLACCESS`; through SMTP the
  connection reports that stream error as `ESTREAM` with the command `API`, and nothing is sent), also when the message
  sets `disableFileAccess: false` and SMTP_URL asks for access; the gateway never hands Nodemailer `raw`, `path` or
  `href`; and its e-mail (sender, Reply-To, Message-ID, envelope, attachment bytes) is built as before. The
  notifications unit tests and the Mailpit integration tests (`outbox.int.test.ts`, `booking-emails.int.test.ts`) pass
  unchanged.

**2026-11-05 (OAD-020): `zod` 4.6.7 in the OTA admin.** `ota/admin` pins `zod` 4.6.7, the latest 4.x (`npm view zod
dist-tags`: `latest` 4.6.7), the release the portal and the platform admin take too (PFE-029, PAD-017,
[tech-stack](../../docs/mvp/tech-stack.md)). `pnpm audit --prod` on this task's base (wave 43, `6c73a96`): **1
advisory, 0 critical, 1 high** (GHSA-mrhx-c7xc-m3w5, paths `ota/admin`, `platform/admin` and `platform/frontend`);
after the change the same 1 high with the two platform paths only, none from `ota/admin` (`pnpm why zod -r`: 4.6.7 for
`ota/admin`; 3.25.76 for the two platform apps and for `kysely-codegen`, a development tool of `packages/db` that
`--prod` does not count).

- **What the forms accept and say stays as it was.** The server actions' schemas moved to the Zod 4 API (`error` for
  `required_error`, `invalid_type_error`, `errorMap` and `message`; `"custom"` issues; `z.looseObject`; `z.record` with
  its key schema). Where Zod 4 judges differently, the schema keeps Zod 3's verdict: a string's `.max()` now counts code
  points, so the bounds that counted UTF-16 units (as the dialogs' `maxLength` does) count them with a refinement; Zod
  4's `z.uuid()` checks the RFC 9562 version, so the dialogs' idempotency keys use `z.guid()` (any 8-4-4-4-12
  hexadecimal key, Zod 3's `.uuid()`); the priority of the page's stored rule is any whole number, as Zod 3's `.int()`
  took it (Zod 4's refuses one past 2^53); an absent key of the other rule kind is `z.undefined().optional()`; and a
  check whose `transform` Zod 3 skipped after a failure now ends the form's checks (`abort`), so the rules across a
  form's fields run exactly when they ran before. In a one-off comparison (not kept in the repository), every form's
  schema ran against its Zod 3 version on about 67,000 generated forms (each field alone, then random mixes): the same
  accepted values and the same messages on every field a dialog shows; the differences left are Zod's own English for a
  hidden field (the stored contact a patch posts back) and for an offer the shopping page posts back, which nothing
  shows (their forms answer "This form is out of date" and "This offer cannot be sent to Amadeus as it is"), the list
  bounds below, and the locales and currencies section, whose empty or malformed list made Zod 3's refinement of the
  default throw (a server error) where Zod 4 names the problem at the field. The second agent's review repeated the
  comparison on about 130,000 generated forms (the bookings, PNR and shopping schemas, the storefront's thirteen
  sections, the pricing rules and the stored rule, the content pages and templates) with the same result, and the action
  tests named `[OAD-020] …` pin the kept verdicts (UTF-16 units, `z.guid()`, `abort`).
- **Every list a server action parses is bounded** by the document's own `maxItems` (or, for a `uniqueItems` list of an
  enum, the enum's size; the form's own bound where it is lower or the document sets none), and Zod 4.6.7's `.max()`
  refuses a longer one before any item is checked: the stored contact's phones (3) and address lines (10, the lines
  the page writes: the document sets no bound), an airline-card issuance's flight offers (6), the PNR import's tags
  (10), the shopping filter's airlines (10, the form's own: the document allows 99), the storefront's locales and
  currencies (20), markets (50, counted on the posted rows before any row is checked: a record has no `.max()`), legal
  links (20) and card brands (13), and the pricing rules' scope lists (200 or 250 codes, a choice list's own
  choices). The consent categories are the four ids the form reads, never posted keys. Where Zod 3 still checked a
  form's other rules beside a list that was too long (the PNR import's selling total, the search's origin and
  destination, an issuance's settlement), they are still checked: the list's own checks run as the field's, without
  ending the form's. The tests `[OAD-020] …` of the action tests show each bound: a list past it is refused by its
  count alone, and each test fails if its bound is taken out.
- **No Zod in the browser.** Zod 4 registers its English messages on the first schema it builds, and they name a "credit
  card number", which the built-pages test (OAD-008 AC2) refuses in a browser chunk. The modules that the client forms
  import (`content-rules.ts`, `pricing-rules.ts`, `settings-rules.ts`) build their schemas on first use, so no browser
  chunk holds Zod at all; `(console)/zod.test.ts` proves that importing them builds none, and that the pinned release is
  exact and installed.

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
| OTA-SR-01 | High | Dependencies | `nodemailer` 6.10.1 in the OTA backend: the address parser's quadratic and recursive parsing (DoS), the `raw` option and the OAuth2 token fetch advisories. Reachability: the worker sends to addresses the API validated (one plain address of at most 254 characters), with no `raw`, no OAuth2 and no file or URL content, so the DoS needs an address the validation lets through; still the shipped version is vulnerable. | Closed 2026-11-05 by **OBE-093**: `nodemailer` 10.3.1 in `ota/backend` and `packages/testing`, the transport still without file or URL access and the gateway without `raw` messages (§5); the platform backend's copy: PBE-068 |
| OTA-SR-02 | High | Dependencies | `multer` 2.4.0 through `@nestjs/platform-express` 11.2.8 (DoS by a pending asynchronous `fileFilter`). Reachability: none today, the API parses multipart bodies itself (`common/http/body-parsers.ts`) and never mounts multer. Proposed fix: override `multer` to 2.5.0 below `@nestjs/platform-express` 11.2.8 (NestJS 12 would change a decision of the owner). | Closed 2026-11-05 by **OBE-094**: `multer` 2.5.0 through the root override `@nestjs/platform-express@11>multer`, NestJS on 11.2.8, both backends (§5) |
| OTA-SR-03 | High | Dependencies (OTA admin) | `zod` 3.25.76 (memory exhaustion validating oversized constrained collections) in the OTA admin's server actions. | Closed 2026-11-05 by **OAD-020**: `zod` 4.6.7 in `ota/admin`, every list a server action parses bounded by the document's limit before any item is checked (§5); the portal's and the platform admin's copies: the platform review's F-4 (PFE-029, PAD-017) |
| OTA-SR-04 | Medium | Dependencies | `fast-uri` 3.1.8 and `qs` 6.16.0 (moderate and low advisories), fixed by a lockfile refresh inside their dependents' ranges. | Closed 2026-11-05 by **OBE-094**: `fast-uri` 3.1.9 and `qs` 6.17.1 by a lockfile refresh, no override (§5) |
| OTA-SR-05 | Low | Contract | The OTA document does not list every answer the API gives: `400 VALIDATION_FAILED` (a path value) or `INVALID_REQUEST` (an edge header beside an API key) on 18 operations (5 of them pending), and the credential refusals (`401`, `403`) of the three Stripe receivers. Clients and the response conformance of the matrix cannot check those answers' shape. | Closed 2026-11-05 by **OBE-095**: the 18 operations list `400 BadRequest` (`VALIDATION_FAILED`, `INVALID_REQUEST` in `x-error-codes`), the Stripe receivers `401 Unauthorized` and `403 Forbidden` with their codes and a paragraph on a credential sent anyway; the matrix checks every answer but a pending `501` against the document (§3.1) |
| OTA-SR-06 | Info | Redaction | The `payment_events` rows built by the bookings, cancellation and refund code carry objects of ids, codes and amounts the code builds itself, not copies of a supplier or gateway payload, so they do not pass the redactor; every copied payload does (§3.4). | Accepted |
| OTA-SR-07 | Info | Card data | A Stripe card summary (`PaymentCard`: brand, BIN, last 4, expiry month and year) is answered and kept in idempotency copies; it holds no card number (Stripe keeps it) and the document marks it "no sensitive data". | Accepted |

No finding of the review changes a rule, a limit, a guard or a redaction; none of them needed a fix in OBE-084 itself.

## 8. Re-running the review

```bash
pnpm --filter @velexis/ota-backend test -- redaction-coverage
pnpm --filter @velexis/ota-backend exec vitest run --config vitest.int.config.ts test/integration/m6
bash deploy/caddy/test/caddy-smoke.sh   # alone on the machine: ports 2019, 3000-3002, 3100, 4000, 8080, 8443 free
pnpm audit --prod
pnpm why multer -r       # 2.5.0 below @nestjs/platform-express 11 (the root override of §5)
pnpm why nodemailer -r   # 10.3.1 in ota/backend and packages/testing (OBE-093)
pnpm why zod -r          # 4.6.7 in ota/admin (OAD-020)
```

The matrix, the rate-limit coverage test and the redaction walk follow the document and `RATE_LIMITS` by themselves: a new
operation, limit or sensitive property is in the next run without a change here.
