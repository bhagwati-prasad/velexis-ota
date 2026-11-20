---
id: architecture
title: JS SDK (@velexis/ota-sdk) — architecture guide
summary: How ota/sdk is built - public modules that mirror the contract, one-line namespace methods over a generated route table, the request core, the three session modes and the client family, transport, errors, pagination, builds, tests, the release draft and where to change things.
---

## At a glance

| Item | Value |
|---|---|
| Package | `@velexis/ota-sdk` 1.0.0 (`repo:ota/sdk/package.json`), `"private": true`, licence `UNLICENSED` until the owner's release decisions |
| Language | ES2022 modules, [[jsdoc-types]] checked by `tsc --checkJs --strict` (TypeScript 5.6.3); **no runtime dependencies** |
| Entry | `repo:ota/sdk/src/index.js` (`createVelexisClient`, `VERSION`, error classes, `isVelexisError`, `Page`, factories) |
| Exports | `"."` → `types` `dist/types/index.d.ts`, `development` `src/index.js` (Vite, Vitest), `import`/`default` `dist/velexis-sdk.mjs`; `"./iife"` → `dist/velexis-sdk.iife.js` (`window.Velexis`); `"sideEffects": false` |
| Runs in | Evergreen browsers, Node.js ≥ 22.12 and 24 (`engines`), edge runtimes |
| Surface | 129 methods in 8 namespaces (96 contract + 33 [[mvp-addition|MVP additions]]), 19 of them [[deferred-operation|deferred]] (`501`) |
| Size | ESM 15.8 KB min+gzip (CHANGELOG 1.0.0) of the 25 KB [[size-budget]] |
| Commands | `pnpm --filter @velexis/ota-sdk generate \| typecheck \| test \| test:contract \| test:smoke \| build \| lint \| clean` |
| Port | none (a library); smoke tests call `OTA_API_URL`, default `http://127.0.0.1:4000` |

## Components

```diagram
components
```

| Folder / file | Job |
|---|---|
| `repo:ota/sdk/src/index.js` | `createVelexisClient(options)` → `clientOf(createCore(options))`: the eight namespaces, `withOptions` (new core from `core.derive(overrides)` in the same [[client-family]]) and `request` |
| `repo:ota/sdk/src/shared.js` | Error classes (`VelexisError` and 13 subclasses), `isVelexisError`, `toJSON()` redaction, `VelexisClientOptions`, `RequestOptions`, `TokenSource`, `EndUserContext` typedefs |
| `repo:ota/sdk/src/identity.js`, `flights.js`, `bookings.js`, `console.js` | Mirror the contract files `identity.d.ts`, `flights.d.ts`, `bookings.d.ts`, `console.d.ts`: typedef aliases of `@velexis/api-types` schemas and the namespace factories |
| `repo:ota/sdk/src/namespaces/` | One factory per namespace; each method is one line, `core.call(op.<key>, params, live(options))`, with JSDoc `@param` / `@returns` / `@throws` |
| `repo:ota/sdk/src/internal/client.js` | The [[request-core]]: option tables (`CLIENT_OPTIONS`, `REQUEST_OPTIONS`), `validateClientOptions`, `core.call` (path/query/header/body split, `Page` wrapping), `core.request`, `derive` |
| `repo:ota/sdk/src/internal/session.js` | Mode choice (`sessionModeOf`), credentials per attempt, CSRF (`fetchCsrf`), [[automatic-refresh]] (`refreshCookies`, `refreshTokens`, `startRefresh`, `runRefresh`), the family (`createFamily`: `refreshing`, `replaced`), `adopt` of [[session-result|session results]], `noteRotation` |
| `repo:ota/sdk/src/internal/http.js` | Transport: headers, timeout per attempt, [[retry-policy]] and [[retry-after]], `onResponse`, response parsing |
| `repo:ota/sdk/src/internal/errors.js` | [[error-envelope]] → class (`errorClassFor`), fallback codes, `parseRetryAfter`, `connectionError` |
| `repo:ota/sdk/src/internal/pagination.js` | `Page<T>` ([[cursor-pagination]]) and `isPageBody` |
| `repo:ota/sdk/src/internal/operations.js` | GENERATED [[route-table]]: 129 frozen entries keyed by the [[x-sdk-method]] with dots replaced by `_` |
| `repo:ota/sdk/src/internal/if-match.js`, `ids.js` | `requireIfMatch` / `optionalIfMatch` ([[if-match]]); `uuidV4` for [[idempotency-key|idempotency keys]] |
| `repo:ota/sdk/scripts/` | `generate-operations.mjs` + `operation-overrides.json` ([[operation-overrides]]), `build.mjs`, `check-size.mjs` |
| `repo:ota/sdk/test/` | `unit/` (fake fetch, fake timers, happy-dom), `contract/` (tsc project, parity, `@throws`), `smoke/`, `fixtures/`, `helpers/fake-fetch.js` |
| `repo:ota/sdk/release/` | The draft publish workflow and its record; never runs, not in the package `files` ([[sdk-publish-draft]]) |

## Data

The SDK owns **no table, no queue and no Redis key**, and writes nothing to browser storage. Its only state lives in
memory, per [[client-family]]:

| State | Where | Holds |
|---|---|---|
| Cookie mode `RefreshState` | `family.cookie.state` | `generation` (finished refreshes), `refreshing` (refresh in flight), `fetchingCsrf` |
| Refreshes in flight | `family.refreshing` (`Map<refreshToken, Promise>`) | One promise per refresh-token value until the rotation is recorded |
| Rotated refresh tokens | `family.replaced` (last `FAMILY_TOKENS_KEPT` = 512) | Old refresh token → newest pair of its session, with time (for the 10 s [[rotation-window]]) and order |
| Per-client replacements | `own` (last 32) and `latest` | Access/refresh tokens this client replaced; its newest pair |

Everything persistent is written by the [[app:ota-api]] while it serves the SDK's calls, in the caller's
[[tenant-schema]] through [[tenant-tx]]; the platform tables are only read by the OTA API. The tables and Redis keys
to check after the SDK's main journey:

```diagram
er-tables-behind-calls
```

Cookies the SDK relies on in [[cookie-mode]] (set by the API, OADR-0006): `__Host-vx_csrf` (readable; copied into
`X-CSRF-Token`), `__Host-vx_at`, `__Host-vx_rt`, `__Host-vx_bt` (httpOnly, never read by JavaScript).

## Key flows

One call, from the namespace to `fetch` and back:

```diagram
seq-call-pipeline
```

Cookie mode: missing CSRF cookie and a shared refresh for a family of clients:

```diagram
seq-cookie-csrf-refresh
```

Token and server mode: one refresh per refresh token, shared by the family:

```diagram
seq-token-refresh-family
```

The airline-card completion (hosted storefront only, PCI-sensitive):

```diagram
seq-airline-card
```

Server mode on the console (portal token sign-in, staff calls, key-only calls):

```diagram
seq-console-server-mode
```

## Lifecycles

```diagram
call-states
```

```diagram
cookie-session-states
```

```diagram
token-session-states
```

```diagram
release-states
```

## Integrations

| With | How | Contract |
|---|---|---|
| [[app:ota-api]] | `fetch` to `baseUrl` + `/v1/…` (cookie mode: same-origin `/api`); headers `X-Api-Key`, `Authorization`, `X-Booking-Token`, `X-CSRF-Token`, `Idempotency-Key`, `If-Match`, `Accept-Language`, `X-Currency`, `X-Velexis-Host`, `X-Velexis-End-User-IP` / `-Agent`, `X-Velexis-Environment` | `repo:ota/backend/openapi/velexis-ota-booking-api.openapi.yaml` (the working document, 129 `x-sdk-method`s) |
| Contract declarations | Never edited; the contract test compiles the SDK's emitted types against them | `repo:docs/velexis-sdk/sdk/src/index.d.ts` and siblings ([[contract-declarations]]) |
| `@velexis/api-types` ([[app:packages]]) | JSDoc imports only (`src/types.js`); the build copies the OTA part into `dist/types/api-types.d.ts` | `repo:packages/api-types` |
| [[app:storefront]] | Imports `src/` in development (Vite `development` condition), the bundle in production | `repo:ota/frontend/src/lib/client.js` |
| [[app:ota-admin]] | Server-only `createConsoleClient` per request; its own de-duplicated staff refresh (OADR-0018) | `repo:ota/admin/src/lib/velexis.ts` |
| e2e workflow ([[app:tools]]) | Nightly step after the Playwright stacks: both `dev:seed`, the API, then `test:smoke` | `repo:.github/workflows/e2e.yml` |
| npm / CDN (pending) | Draft workflow publishes with provenance; IIFE served by versioned CDN URLs with an SRI hash | `repo:ota/sdk/release/sdk-publish.draft.yml` |

## Security

- **No secrets in the browser.** [[cookie-mode]] refuses every key and token (options, per-call options, `X-Api-Key` /
  `Authorization` headers) with a `TypeError`; `secretKey` throws where `document` exists; `fetch` runs with
  `mode: "same-origin"` in cookie mode and `credentials: "omit"` in token mode.
- **Tokens never presented twice.** The [[client-family]] shares one refresh per refresh-token value; a rotated token
  leads to the newest pair only for a client that held it as its own string, or within the 10 s [[rotation-window]];
  otherwise it is sent as it is and the API's [[refresh-token-reuse]] detection revokes the family. Refreshes carry the
  API key only, never the expired access token.
- **CSRF.** [[csrf-token]] copied from `__Host-vx_csrf` on `POST`, `PUT`, `PATCH`, `DELETE`; one re-fetch and one
  resend on `403 CSRF_TOKEN_INVALID`.
- **Card data (PCI).** `checkout.completeWithAirlineCard` is never retried or resent, gets a new key per call, and its
  errors are rebuilt without card values ([[card-redaction]]). The transport keeps no request in any error.
- **Errors never leak credentials.** `toJSON()` drops secret-named `details` keys and redacts `pk_/sk_/hk_/rk_` keys,
  `Bearer …` and JWTs in texts; option `TypeError`s name the option, never the value. The SDK never calls `console.*`.
- **Rate limits** are the API's (`rl:<throttler>:<tracker>`); server callers forward the visitor with `endUser` so
  limits count per visitor ([[end-user-headers]]).

## Configuration

The library reads no environment variable; everything is a client option (`VelexisClientOptions`, validated by
`CLIENT_OPTIONS` in `repo:ota/sdk/src/internal/client.js`):

| Option | Default | Purpose |
|---|---|---|
| `baseUrl` | `https://api.ota.example.com`; `/api` in cookie mode | API origin or same-origin path (no credentials, query or fragment) |
| `publishableKey` / `secretKey` / `hostingKey` | — | One key at most; prefix `pk_` / `sk_` / `hk_` checked |
| `session` | `"token"` | `"cookie"` selects cookie mode (extension) |
| `accessToken`, `refreshToken`, `bookingToken` | — | [[token-source|Token sources]]: string or (async) function; `""` and `null` mean none |
| `onSessionRefreshed`, `onSessionExpired`, `onStaffSessionRefreshed` | — | [[session-hooks]], awaited, errors ignored |
| `sessionKind` | `"customer"` | `"staff"` refreshes through `console.auth.refresh` |
| `environment` | — | `"test"` / `"live"`: `X-Velexis-Environment` on console operations (OTA admin only) |
| `timeoutMs` / `maxRetries` | 30 000 / 2 | Per attempt; long operations use the route table's 60 s / 90 s |
| `locale`, `currency`, `host`, `endUser`, `headers`, `fetch`, `onResponse` | — | `Accept-Language`, `X-Currency` (ISO 4217), `X-Velexis-Host`, end-user headers, extra headers, injected fetch, [[response-hook]] |

Smoke tests only: `OTA_API_URL`, `SDK_SMOKE_PUBLISHABLE_KEY`, `SDK_SMOKE_SECRET_KEY`, `SDK_SMOKE_CONSOLE_KEY`,
`REDIS_URL`, `DATABASE_MIGRATOR_URL` (`repo:ota/sdk/test/smoke/smoke-env.js`; values never printed).

## Testing

| Level | Where | Run one |
|---|---|---|
| Unit | `repo:ota/sdk/test/unit` (session-cookie, session-token, session-server, http, errors, pagination, multipart, options, namespaces-*, bundle, pack, typecheck, version …) with [[fake-fetch]] | `pnpm --filter @velexis/ota-sdk exec vitest run test/unit/session-token.test.js` |
| Contract | `repo:ota/sdk/test/contract` ([[contract-test]], [[parity-test]], `throws.test.js`, [[approved-deviation|deviations]]) | `pnpm --filter @velexis/ota-sdk test:contract` |
| Route table | `repo:ota/sdk/test/unit/operations.test.js` | `pnpm --filter @velexis/ota-sdk exec vitest run test/unit/operations.test.js` |
| Bundles and package | `repo:ota/sdk/test/unit/bundle.test.js`, `repo:ota/sdk/test/unit/pack.test.js` | part of `test` |
| Smoke | `repo:ota/sdk/test/smoke` ([[sdk-smoke-tests]]) | `pnpm --filter @velexis/ota-sdk test:smoke` (needs the stack and keys) |
| End to end (cookie mode) | `repo:tools/e2e/specs/storefront` | Playwright through the storefront ([[app:storefront]] guide) |
| Release draft pins | `repo:tools/ci/sdk-draft-pins.test.mjs` | `node --test tools/ci/sdk-draft-pins.test.mjs` |

CI runs `test` on Node.js 24 with the repository and on Node.js 22.12.0 in the non-required job `sdk-node22`.

## Where to change things

| To change … | Look at |
|---|---|
| A client option, its default or its validation message | `repo:ota/sdk/src/internal/client.js` (`CLIENT_OPTIONS`, `REQUEST_OPTIONS`, `DEFAULT_*`) and the typedef in `repo:ota/sdk/src/shared.js` |
| Which mode a client gets, what each mode refuses | `repo:ota/sdk/src/internal/session.js` (`sessionModeOf`, `COOKIE_REFUSED_*`, `FETCH_INIT`) |
| CSRF copy / re-fetch | `repo:ota/sdk/src/internal/session.js` (`sendWithCsrf`, `fetchCsrf`, `readCsrfCookie`) |
| Automatic refresh, family sharing, rotation window | `repo:ota/sdk/src/internal/session.js` (`refreshCookies`, `refreshTokens`, `startRefresh`, `runRefresh`, `resolveRefresh`, `resolveAccess`, `ROTATION_WINDOW_MS`, `FAMILY_TOKENS_KEPT`) |
| What a session result does to the client | `repo:ota/sdk/src/internal/session.js` (`adopt`, `noteRotation`) and `repo:ota/sdk/src/namespaces/auth.js` (`sessionCall`, `withoutSessionTokens`) |
| Retries, back-off, `Retry-After`, timeouts, headers order | `repo:ota/sdk/src/internal/http.js` (`RETRY_STATUSES`, `BACKOFF_*`, `MAX_RETRY_AFTER_SECONDS`, `headersOf`) |
| Status/code → error class, fallback codes, `retryable` | `repo:ota/sdk/src/internal/errors.js` (`errorClassFor`, `fallbackCode`) and `repo:ota/sdk/src/shared.js` (`isRetryable`, `SECRET_KEY_NAME`, `SECRET_IN_TEXT`) |
| A method's path, query/header params, idempotency, retry class | The OpenAPI document `repo:ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, then `generate` (never edit `repo:ota/sdk/src/internal/operations.js`) |
| A long timeout or `retry: never` | `repo:ota/sdk/scripts/operation-overrides.json` (with a `reason`), then `generate` |
| A method's JSDoc, `@throws`, defaults (`originSystemCode`, `cache: no-store`) | `repo:ota/sdk/src/namespaces` (the namespace file) |
| `If-Match` rules | `repo:ota/sdk/src/internal/if-match.js` and the callers in `repo:ota/sdk/src/namespaces/bookings.js`, `repo:ota/sdk/src/namespaces/account.js`, `repo:ota/sdk/src/namespaces/console.js` |
| Airline-card error scrubbing | `repo:ota/sdk/src/namespaces/checkout.js` (`CARD_KEYS`, `cardPatterns`, `holdsNoCard`, `withoutCard`) |
| Pagination | `repo:ota/sdk/src/internal/pagination.js` and `core.call` in `repo:ota/sdk/src/internal/client.js` |
| Multipart upload | `formOf` in `repo:ota/sdk/src/internal/client.js`, `uploadAsset` in `repo:ota/sdk/src/namespaces/console.js` |
| Bundles, declarations, size budget | `repo:ota/sdk/scripts/build.mjs`, `repo:ota/sdk/scripts/check-size.mjs` |
| Version | `repo:ota/sdk/package.json` and `repo:ota/sdk/src/version.js` together, plus `repo:ota/sdk/CHANGELOG.md` |
| Publish workflow (owner approval) | `repo:ota/sdk/release/sdk-publish.draft.yml`, `repo:ota/sdk/release/CHANGES.md` |
| How the storefront / OTA admin create their clients | `repo:ota/frontend/src/lib/client.js`, `repo:ota/frontend/src/boot.js`, `repo:ota/frontend/src/pages/booking.js`; `repo:ota/admin/src/lib/velexis.ts` |
| Smoke journey and the test staff member | `repo:ota/sdk/test/smoke/smoke-env.js` |

## Further reading

- `repo:ota/sdk/README.md` (the component specification), `repo:ota/sdk/docs/extensions.md`,
  `repo:ota/sdk/docs/types-and-builds.md`, `repo:ota/sdk/CHANGELOG.md`, `repo:ota/sdk/release/CHANGES.md`
- `repo:docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md`, `repo:ota/docs/adr/0016-sdk-packaging-and-type-contract.md`,
  `repo:ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md`, `repo:ota/docs/adr/0017-airline-card-form-isolation.md`,
  `repo:ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md`,
  `repo:ota/docs/adr/0011-console-access-staff-sessions-and-environments.md`, `repo:docs/mvp/adr/0029-nodejs-24-runtime.md`
- Reference design: `repo:docs/velexis-sdk/README.md`, guides `repo:docs/velexis-sdk/sdk/docs/B1.md` …
  `repo:docs/velexis-sdk/sdk/docs/B4.md`, contract `repo:docs/velexis-sdk/sdk/src/shared.d.ts`
- Third-party integrators: `repo:ota/frontend/docs/build-your-own-frontend.md`; journey [[journey:api-keys-and-sdk]]
