# JS SDK (`@velexis/ota-sdk`)

This is the component specification of the Velexis OTA JavaScript SDK: a framework-agnostic library, written in vanilla JavaScript ES modules with JSDoc types and no runtime dependencies, that wraps the OTA booking API with one method per OpenAPI operation. The hosted storefront uses it in the browser (cookie mode), the OTA admin uses it on its Next.js server (service key + staff token), and third-party frontends use it with publishable or secret keys. This page covers goals, package layout, session modes, the public API, how JSDoc types are checked and compared with the contract, builds, tests, versioning and what is deferred. It refines [ADR-0019](../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md) and never contradicts [`decisions.md`](../../docs/mvp/decisions.md).

Related: [`docs/extensions.md`](docs/extensions.md) (what the SDK adds to the contract), [`docs/types-and-builds.md`](docs/types-and-builds.md) (typing, contract test, bundles), [OADR-0016](../docs/adr/0016-sdk-packaging-and-type-contract.md) (packaging and type contract), [contract declarations](../../docs/velexis-sdk/sdk/src/), [SDK guides B1–B4](../../docs/velexis-sdk/sdk/docs/), [OpenAPI contract](../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml), [`../docs/scope.md`](../docs/scope.md) §2.4 and §3, [`../docs/api-changes.md`](../docs/api-changes.md), [storefront](../frontend/README.md), [OTA admin](../admin/README.md), [conventions §5](../../docs/mvp/conventions.md#5-sdk-otasdk), [tech stack](../../docs/mvp/tech-stack.md#js-sdk-otasdk-velexisota-sdk).

## 1. At a glance

| Item | Value |
|---|---|
| Package | `@velexis/ota-sdk` (workspace package in `ota/sdk`; published to npm at M6) |
| Language | ES2022 modules, JSDoc types checked by `tsc --checkJs --strict` (TypeScript 5.6) |
| Runtime dependencies | **None.** Only platform APIs: `fetch`, `Headers`, `URL`, `AbortController`, `crypto.randomUUID` (with a `getRandomValues` fallback), `FormData`, `Blob` |
| Runs in | Evergreen browsers (`<script type="module">`, a bundler, or the IIFE), Node.js 22, edge runtimes (Cloudflare Workers, Vercel Edge, Deno, Bun) |
| Surface | `createVelexisClient`, `VERSION`, the contract's error classes and `isVelexisError`, 8 namespaces, **128 methods** (96 contract + 32 MVP additions), one per `x-sdk-method` |
| Contract | [`docs/velexis-sdk/sdk/src/`](../../docs/velexis-sdk/sdk/src/) `index`, `shared`, `identity`, `flights`, `bookings`, `console` (`.d.ts`, never edited) |
| Outputs | `dist/velexis-sdk.mjs` (ESM), `dist/velexis-sdk.iife.js` (`window.Velexis`), `dist/types/*.d.ts` |
| Size budget | ESM bundle at most **25 KB** min+gzip (CI) |
| Milestones | M2 core, cookie and token mode, `storefront`, `reference`, `flights`; M3 `auth`, `account`, `checkout`, `bookings`; M4 `console` (with settings and payments); M6 npm publication |

## 2. Goals and non-goals

**Goals**

- **Framework-agnostic.** Plain functions and objects. No React, no Next.js, no global state, no top-level side effects (`"sideEffects": false`).
- **Zero dependencies** and no transpilation of the source: `src/` runs as-is in browsers and Node 22, so a page can import it straight from a bundler or a CDN.
- **Contract-exact.** Every method, option, error class and type of the contract declarations exists with a compatible signature. The SDK may **add** optional options and methods; it never removes or narrows ([ADR-0019](../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md)). This is enforced by the contract test (§6).
- **Safe by default.** No token reaches storefront JavaScript (cookie mode), secret keys are refused in browsers, the airline-card call is never retried or logged, errors never serialise credentials.
- **Predictable I/O.** Retries only where safe, idempotency keys generated per call, timeouts on every request, one error envelope mapped to typed errors.

**Non-goals:** response caching (callers decide), UI helpers and React or Next.js helpers (post-MVP, §9), and logging (the SDK never calls `console.*`; use `onResponse`).

## 3. Package layout

The public modules mirror the contract files one to one ([ADR-0019](../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md)); the implementation is split into small files under `namespaces/` and `internal/` ([OADR-0016](../docs/adr/0016-sdk-packaging-and-type-contract.md)).

```
ota/sdk/
  package.json             "type": "module", exports, "sideEffects": false, no dependencies
  tsconfig.json            checkJs project (src/), noEmit
  tsconfig.build.json      declaration-only emit to dist/types/
  src/
    index.js               public entry: createVelexisClient, VERSION, re-exports        (mirrors index.d.ts)
    shared.js              error classes, isVelexisError, Page, shared typedefs          (mirrors shared.d.ts)
    identity.js            typedefs + storefront, auth, account, reference factories     (mirrors identity.d.ts)
    flights.js             typedefs + flights factory                                    (mirrors flights.d.ts)
    bookings.js            typedefs + checkout and bookings factories                    (mirrors bookings.d.ts)
    console.js             typedefs + console factory, options augmentation              (mirrors console.d.ts)
    types.js               base aliases: Schemas, Paths, Operations from @velexis/api-types
    version.js             export const VERSION = "x.y.z" (checked against package.json)
    namespaces/
      storefront.js        get, resolve, listPages, getPage
      auth.js              signUp … getSession (10)
      account.js           get, update, delete, preferences.*, savedTravelers.*, dataExports.*
      reference.js         locations, airports, airlines, countries, currencies
      flights.js           search … getFareRules (10)
      checkout.js          create … complete, completeWithAirlineCard
      bookings.js          list … listEvents (14)
      console.js           auth, bookings, queues, customers, supplierRequests, amadeus, settings, payments
    internal/
      client.js            option validation, mode selection, the request core handed to namespaces
      http.js              fetch, headers, query encoding, timeouts, retries, idempotency keys, Retry-After
      session.js           cookie mode (CSRF, cookie refresh), token mode (refresh single flight), server mode
      errors.js            response or failure -> contract error class
      pagination.js        Page<T> implementation (next(), for await)
      operations.js        GENERATED route table: x-sdk-method -> method, path, params, headers, retry, timeout
      ids.js               UUID v4 for idempotency keys
  scripts/
    generate-operations.mjs  OpenAPI -> src/internal/operations.js (+ contract assertion list)
    build.mjs                esbuild ESM + IIFE, tsc declarations, api-types copy for publication
    check-size.mjs           gzip budget
  test/
    unit/                  Vitest, fake fetch, fake timers, happy-dom for cookie mode
    contract/              tsc project against the contract + runtime parity test
    smoke/                 against a running OTA backend wired to the Amadeus stub
    fixtures/              response bodies, validated against the OpenAPI document
  docs/
    extensions.md          options, methods and behaviour the contract does not describe
    types-and-builds.md    JSDoc typing, contract test, route table, bundles, size budget
  dist/                    build output (not committed)
```

**How a method is written.** Each namespace file is a factory that receives the request core and returns an object literal. Route details come from the generated table, so a method body is one line (`search: (params, options) => core.call(op.flights_search, params, options)`) and its JSDoc carries the types. `core.call` splits `params` into path, query and header parameters (`ifMatch` → `If-Match`) and the JSON body. An example and the table format are in [`docs/types-and-builds.md`](docs/types-and-builds.md) §5.

## 4. Session modes

The mode is chosen once, in `createVelexisClient`, from the options. A wrong combination throws a `TypeError` at construction, before any request.

| Mode | Who | Options | Credentials sent | Tokens visible to JS |
|---|---|---|---|---|
| **Cookie** (extension) | Hosted storefront, same origin | `{ baseUrl: "/api", session: "cookie" }` | Cookies (`credentials: "same-origin"`, `mode: "same-origin"`); `X-CSRF-Token` on writes. Caddy adds the edge credential. | **No** |
| **Token** (contract) | Third-party browser frontends | `{ publishableKey: "pk_…", accessToken?, refreshToken?, bookingToken?, onSessionRefreshed?, onSessionExpired? }` | `X-Api-Key: pk_…`, `Authorization: Bearer`, `X-Booking-Token`; `credentials: "omit"` | Yes, the integrator's choice |
| **Server** (contract, secret key) | Third-party servers, custom consoles, the OTA admin | `{ secretKey: "sk_…", baseUrl, accessToken, refreshToken?, sessionKind?: "customer" \| "staff", environment? }` | `X-Api-Key: sk_…` (or the OTA admin service key), `Authorization: Bearer`, `X-Velexis-Environment` (OTA admin) | Server memory only |

### 4.1 Cookie mode (hosted storefront)

- **Refused options:** `publishableKey`, `secretKey`, `accessToken`, `refreshToken`, `bookingToken`, and `X-Api-Key` / `Authorization` in `headers`; per-call `accessToken` and `bookingToken` in `RequestOptions` too. Each throws a `TypeError`, so a token cannot leak into storefront code by mistake ([ADR-0019](../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md)).
- **Same origin only.** `mode: "same-origin"` makes `fetch` reject a cross-origin `baseUrl`, so cookies never travel to another host. The mode needs `document` and throws outside a browser.
- **CSRF.** On `POST`, `PUT`, `PATCH` and `DELETE` the SDK copies the `__Host-vx_csrf` cookie into `X-CSRF-Token` ([OADR-0006](../docs/adr/0006-storefront-cookie-sessions-and-csrf.md)). If the cookie is missing it first calls `GET /v1/storefront` once (which issues it). On `403 CSRF_TOKEN_INVALID` it does the same once and retries the call once.
- **Refresh.** On `401 TOKEN_EXPIRED` it calls `POST /v1/auth/refresh` with an empty body (the refresh token is in `__Host-vx_rt`), then retries the original call once. Concurrent calls share **one** refresh promise. A failed refresh (`REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`) calls `onSessionExpired` and throws `AuthenticationError`.
- **Responses without tokens.** `auth.signIn`, `auth.refresh` and `auth.changePassword` resolve with `AuthSessionInfo`; `checkout.complete`, `checkout.completeWithAirlineCard` and `bookings.lookup` resolve with `bookingToken: null`. The guest token lives in `__Host-vx_bt` and is sent by the browser.

### 4.2 Token mode (publishable key)

The contract's behaviour ([`shared.d.ts`](../../docs/velexis-sdk/sdk/src/shared.d.ts)): `accessToken`, `refreshToken` and `bookingToken` are strings or functions called before every request; with `refreshToken` set, the SDK refreshes once on `TOKEN_EXPIRED` (single flight), reports the new tokens through `onSessionRefreshed` and retries. Where to keep tokens is the integrator's decision; the [build-your-own-frontend guide](../frontend/docs/build-your-own-frontend.md) recommends a small server of their own with httpOnly cookies.

### 4.3 Server mode (secret key)

- `secretKey` is refused when `globalThis.document` exists (a browser page). Secret keys belong on servers only.
- `sessionKind: "staff"` (contract augmentation in [`console.d.ts`](../../docs/velexis-sdk/sdk/src/console.d.ts)) makes the automatic refresh call `console.auth.refresh` and report through `onStaffSessionRefreshed`.
- `environment: "test" | "live"` (extension) sends `X-Velexis-Environment` on console operations, as the OTA admin's service credential requires ([`../docs/api-changes.md`](../docs/api-changes.md) §5).
- Server-side callers forward the visitor's address with `headers: { "X-Velexis-End-User-IP": ip }` per call, as the contract describes.
- **Rotating refresh tokens and concurrency.** A server that renders several requests of one user in parallel must not refresh the same token twice (reuse revokes the family). Pass `refreshToken` only where the new tokens can be written back, and de-duplicate refreshes per token; the OTA admin's approach is in [OADR-0018](../docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md).

```js
import { createVelexisClient, isVelexisError } from "@velexis/ota-sdk";

// Hosted storefront: same origin, cookies + CSRF, no keys.
export const velexis = createVelexisClient({ baseUrl: "/api", session: "cookie" });

// Third-party browser app: publishable key, customer scope only.
const browser = createVelexisClient({ publishableKey: "pk_test_…", baseUrl: "https://api.ota.example.com" });

// OTA admin server (server-only module): service key, staff token, chosen environment.
const staff = createVelexisClient({
  secretKey: config.otaAdminServiceKey,
  baseUrl: config.otaApiUrl,                // http://127.0.0.1:4000
  accessToken: staffAccessToken,
  sessionKind: "staff",
  environment: "test",
});
```

## 5. Public API

### 5.1 `createVelexisClient(options)`

Every option of the contract's `VelexisClientOptions` is supported with the contract's defaults; the additions are marked.

| Option | Default | Notes |
|---|---|---|
| `baseUrl` | `https://api.ota.example.com` (placeholder host) | Cookie mode: `/api`. The OTA admin: `OTA_API_URL`. The contract's doc comment names another default host; only the text differs, not the type. |
| `publishableKey`, `secretKey` | — | Token and server mode (§4) |
| `accessToken`, `refreshToken`, `bookingToken` | — | `TokenSource`: string or (async) function |
| `onSessionRefreshed`, `onSessionExpired` | — | Token and server mode; `onSessionExpired` also in cookie mode |
| `sessionKind`, `onStaffSessionRefreshed` | `"customer"` | Contract augmentation from `console.d.ts` |
| `locale`, `currency` | — | `Accept-Language`, `X-Currency`; per call in `RequestOptions` |
| `fetch` | `globalThis.fetch` | Inject a fake in tests or the patched fetch of a framework |
| `timeoutMs` | 30 000 | Long operations use the table's value (§5.3) unless overridden |
| `maxRetries` | 2 | §5.3 |
| `headers` | — | Extra headers on every request |
| `onResponse` | — | `{ method, path, status, requestId, durationMs }`; `path` without the query string |
| `session` (extension) | `"token"` | `"cookie"` selects cookie mode |
| `environment` (extension) | — | `"test"` or `"live"`, console operations only |

The client offers the eight namespaces, `withOptions(overrides)` (a new client sharing nothing mutable) and `request(method, path, init)` (the low-level escape hatch with the same headers, retries and error mapping). `withOptions` cannot switch a cookie-mode client to keys.

### 5.2 Namespaces, mapped 1:1 to `x-sdk-method`

Every OpenAPI operation with an `x-sdk-method` is one SDK method with exactly that dotted name. Operations marked `x-internal` or `x-sdk-exclude` (health, webhooks, file and asset downloads) have none ([`../docs/api-changes.md`](../docs/api-changes.md) §1). Deferred operations still have their method; it surfaces the API's `501 NOT_IMPLEMENTED` as a `ServerError` with `code = "NOT_IMPLEMENTED"` ([scope §3](../docs/scope.md#3-the-96-contract-operations)).

| Namespace | Contract interface | Contract methods | MVP additions | File | Milestone |
|---|---|---|---|---|---|
| `storefront` | `StorefrontApi` | 2 (`resolve` deferred) | `listPages`, `getPage` | `namespaces/storefront.js` | M2 (pages M4) |
| `auth` | `AuthApi` | 10 | — | `namespaces/auth.js` | M3 |
| `account` | `AccountApi` (+ `preferences`, `savedTravelers`, `dataExports`) | 12 (9 deferred) | — | `namespaces/account.js` | M3 |
| `reference` | `ReferenceApi` | 6 | — | `namespaces/reference.js` | M2 |
| `flights` | `FlightsApi` | 10 (`availability` deferred) | — | `namespaces/flights.js` | M2 |
| `checkout` | `CheckoutApi` | 10 | `completeWithAirlineCard` | `namespaces/checkout.js` | M3 |
| `bookings` | `BookingsApi` | 14 (3 deferred) | — | `namespaces/bookings.js` | M3 |
| `console` | `ConsoleApi` (`auth`, `bookings`, `queues`, `customers`, `supplierRequests`, `amadeus`) | 32 (5 deferred) | `settings.*` (25), `payments.*` (4) | `namespaces/console.js` | M4 |
| **Total** | | **96** | **32** | | |

The additions are specified in [`../docs/api-changes.md`](../docs/api-changes.md) and [`../docs/api-changes-console-and-internal.md`](../docs/api-changes-console-and-internal.md) and listed with their types in [`docs/extensions.md`](docs/extensions.md). The usage patterns per area are in the guides [B1](../../docs/velexis-sdk/sdk/docs/B1.md) (storefront, auth, account, reference), [B2](../../docs/velexis-sdk/sdk/docs/B2.md) (flights), [B3](../../docs/velexis-sdk/sdk/docs/B3.md) (checkout, bookings) and [B4](../../docs/velexis-sdk/sdk/docs/B4.md) (console); their Next.js code translates directly, because the method calls are the same.

### 5.3 Behaviour shared by all methods (`internal/http.js`)

| Concern | Rule |
|---|---|
| Idempotency keys | Operations that declare `Idempotency-Key` get one per call (UUID v4), reused across that call's retries; `options.idempotencyKey` overrides it. Callers pass a **stable** key when a user action may be repeated, for example `complete-<checkoutId>-<paymentId>` for `checkout.complete` ([B3 §2.7](../../docs/velexis-sdk/sdk/docs/B3.md)). |
| Retries | At most `maxRetries` (2) for `GET`, `PUT`, `DELETE` and for any request carrying an `Idempotency-Key`, on 429, 503, 504 and network errors. Exponential back-off with jitter (0.5 s, 1 s, capped at 8 s); `Retry-After` is honoured, and a `Retry-After` above 30 s throws `RateLimitError` at once. A client-side timeout is not retried. |
| Never retried | `checkout.completeWithAirlineCard` (`retry: "never"` in the table; the card is in the body) ([OADR-0017](../docs/adr/0017-airline-card-form-isolation.md)). |
| Timeouts | `timeoutMs` (30 s) through `AbortController`, linked to `options.signal`. The table gives 60 s to `flights.search`, `flights.upsell`, `flights.price`, `console.bookings.issue`, `.cancel`, `.import`, `.retrieve`, and 90 s to `checkout.complete` and `checkout.completeWithAirlineCard` (Amadeus order creation plus issuance). |
| Query encoding | Arrays are sent comma-separated, as the contract says; `undefined` values are dropped. |
| Bodies | JSON, except `console.settings.assets.upload`, which builds `multipart/form-data` from a `Blob` or `File`. |
| Errors | The error envelope becomes the contract's class by status and code (`ValidationError` … `ServerError`, as in [`shared.d.ts`](../../docs/velexis-sdk/sdk/src/shared.d.ts)). Failures before a response are `ConnectionError` with `NETWORK_ERROR`, `TIMEOUT` or `ABORTED`. `toJSON()` never contains keys, tokens or request bodies. |
| Pagination | List methods return `Page<T>`: `data`, `page.nextCursor`, `next()`, and `for await (const item of page)` across pages. |
| Hooks | `onResponse` after every response, including retries. The SDK never logs. |

## 6. Types: JSDoc, `checkJs` and the contract test

The details, with the `tsconfig` files and the route-table format, are in [`docs/types-and-builds.md`](docs/types-and-builds.md).

- **Where types come from.** Schema types come only from the generated OTA types (`@velexis/api-types`), the module the contract itself imports ([ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md)). Each public module declares the same aliases as its `.d.ts` counterpart (`/** @typedef {import("./types.js").Schemas["FlightOffer"]} FlightOffer */`). Namespace types such as `FlightsApi` are **inferred from the factories** (`ReturnType<typeof createFlightsApi>`), so each method's JSDoc is written once. Overloads use `@overload`; `Page<T>` is a small class with `@template T`.
- **Checking.** `pnpm --filter @velexis/ota-sdk typecheck` runs `tsc` with `allowJs`, `checkJs`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmit`, `types: []` (no Node globals). A type error fails CI like in TypeScript code.
- **Emitting.** `tsc -p tsconfig.build.json` (`emitDeclarationOnly`) writes `dist/types/*.d.ts`, one file per source module.
- **Contract test** (`test/contract/`, every PR):
  1. a `tsc --noEmit` project maps `velexis-contract` to [`docs/velexis-sdk/sdk/src/index.d.ts`](../../docs/velexis-sdk/sdk/src/index.d.ts), `@velexis/ota-sdk` to `dist/types/index.d.ts`, and `@velexis/api-types` to the generated package for both sides;
  2. generated per-method assertions: the contract's parameters must be assignable to the SDK's, and the SDK's awaited result to the contract's (explicit checks, because TypeScript compares method parameters bivariantly);
  3. hand-written assertions for `createVelexisClient`, `VelexisClient`, the options, `RequestOptions`, `Page<T>`, every error class and `isVelexisError`;
  4. **approved deviations** in `test/contract/deviations.ts`, each naming its ADR; today only the three auth responses that are `AuthSessionResult | AuthSessionInfo` because of cookie mode ([OADR-0006](../docs/adr/0006-storefront-cookie-sessions-and-csrf.md));
  5. a runtime **parity test**: the set of `x-sdk-method` names in the working OpenAPI document equals the set of methods on a client instance.

The contract files under `docs/velexis-sdk/sdk/src/` are never edited; additions go to the OpenAPI document and [`docs/extensions.md`](docs/extensions.md).

## 7. Builds

`pnpm --filter @velexis/ota-sdk build` (esbuild 0.25 + `tsc`) produces:

| Output | Format | Used by |
|---|---|---|
| `dist/velexis-sdk.mjs` + `.map` | ESM, ES2022, minified, external source map | The storefront (through Vite), the OTA admin, npm consumers |
| `dist/velexis-sdk.iife.js` + `.map` | IIFE exposing `window.Velexis` | Plain HTML pages: `<script src="/vendor/velexis-sdk.iife.js"></script>`, then `Velexis.createVelexisClient(…)` |
| `dist/types/*.d.ts` | Declarations | Consumers' type checking |

- `package.json` `exports`: `"."` → `{ types, development: "./src/index.js", import: "./dist/velexis-sdk.mjs" }`, `"./iife"` → the IIFE; `"sideEffects": false`. ESM only, no CommonJS build.
- **Size budget:** `scripts/check-size.mjs` fails when the ESM bundle exceeds **25 KB** min+gzip. If `console` ever pushes past it, it moves to a separate entry, `@velexis/ota-sdk/console` (the ADR-0019 follow-up).
- **Published types are self-contained:** for npm the build copies the OTA part of `@velexis/api-types` into `dist/types/` and rewrites the specifier ([OADR-0016](../docs/adr/0016-sdk-packaging-and-type-contract.md)).

## 8. Testing

| Level | Where | Tool | What |
|---|---|---|---|
| Unit | `test/unit/*.test.js` | Vitest 3 with a fake `fetch` (`test/helpers/fake-fetch.js`), fake timers, `happy-dom` for cookie mode | Header building per mode, CSRF copy and re-fetch, refresh single flight, retry and back-off rules, `Retry-After`, idempotency key reuse, timeouts and abort, error mapping table, pagination, multipart upload, option validation (`TypeError` cases), `toJSON` without secrets |
| Route table | `test/unit/operations.test.js` | Vitest | For every entry of `operations.js`, a call with sample parameters hits the right method, path, query, headers and body |
| Contract | `test/contract/` | `tsc`, Vitest | §6: type assertions, approved deviations, runtime parity with the OpenAPI document, `VERSION` equals `package.json` |
| Smoke | `test/smoke/*.smoke.test.js` | Vitest against `OTA_API_URL` | One call per namespace in token and server mode against the local OTA backend wired to the Amadeus stub, with the `dev:seed` test keys ([`../backend/README.md`](../backend/README.md)); nightly, not on every PR |
| End to end | `tools/e2e/specs/storefront/` | Playwright | Cookie mode through the real storefront journeys ([storefront testing](../frontend/README.md#13-testing)) |

- **Fixtures** in `test/fixtures/` are response bodies validated against the working OpenAPI document with the shared Ajv helper of `@velexis/testing`, so the fake responses cannot drift from the contract.
- Tests never use the real network or sleep; they follow [ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md) and [conventions §10](../../docs/mvp/conventions.md#10-testing).

Commands (`pnpm --filter @velexis/ota-sdk <script>`): `generate` (route table and assertions from `ota/backend/openapi/`; CI fails on a diff), `typecheck`, `test` (unit + contract), `test:smoke`, `build` (bundles, declarations, size check).

## 9. Versioning, publishing and what is deferred

**Versioning.** Semantic versioning. `0.x` while the SDK lives only in the workspace (`workspace:*` in the storefront and the OTA admin). `1.0.0` is the first npm release at M6. A change that the contract test would reject is a major version; new methods and options are minor; fixes are patches. `CHANGELOG.md` is kept by hand. A method that will be removed is marked `@deprecated` in JSDoc for at least one minor release first.

**Publishing (M6 launch checklist).** A manual GitHub Actions workflow publishes `@velexis/ota-sdk` to npm with provenance, after build, contract test and size check, from a tag `sdk-vX.Y.Z`. The IIFE is then available at versioned CDN URLs that mirror npm (for example `https://cdn.jsdelivr.net/npm/@velexis/ota-sdk@1.0.0/dist/velexis-sdk.iife.js`); the release notes give its SRI hash, and the guide recommends self-hosting the file.

**Deferred (post-MVP):**

- `@velexis/ota-sdk/next` and `@velexis/ota-sdk/react` helpers ([`next.d.ts`](../../docs/velexis-sdk/sdk/src/next.d.ts), [`react.d.ts`](../../docs/velexis-sdk/sdk/src/react.d.ts)) and the Next.js example: references only. The OTA admin re-implements the few server helpers it needs ([OADR-0018](../docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md)).
- Helpers around asynchronous search (`resultOptions.async` answers `403 FEATURE_DISABLED` in the MVP).
- Behaviour of deferred operations (saved travellers, preferences, data exports, extras after booking, `storefront.resolve`, console create and raw Amadeus writes): methods exist and surface `501 NOT_IMPLEMENTED`.
- Airline-card completion for third-party frontends: the API refuses keys (`403 SCOPE_NOT_ALLOWED`); the method exists for the hosted storefront only.
- A CommonJS build and support for browsers without ES2022.
