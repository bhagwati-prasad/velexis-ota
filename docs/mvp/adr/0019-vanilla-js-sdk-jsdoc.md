# ADR-0019: Vanilla JS SDK with JSDoc types

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (vanilla JS with JSDoc, framework-agnostic, the `docs/velexis-sdk/sdk/src/` declarations as the contract, `next`/`react` helpers post-MVP), lead architect (module layout, type checking, bundles, session modes)

## Context

[`decisions.md`](../decisions.md) §1–§2 make the SDK (`ota/sdk`) **vanilla JavaScript ES modules with JSDoc types and no framework dependency**. The TypeScript declarations in [`docs/velexis-sdk/sdk/src/`](../../velexis-sdk/sdk/src/) are the **contract** the JSDoc types must match. The MVP implements `index`, `shared`, `identity`, `flights`, `bookings` and `console`; `next.d.ts` and `react.d.ts` are post-MVP references.

The SDK is used by:

- the hosted storefront, in the browser, same-origin, with cookie sessions ([ADR-0018](0018-hosted-storefront-custom-domains.md));
- the OTA admin, on its Next.js server, with a service credential and staff tokens ([ADR-0008](0008-identity-accounts-customers-sessions.md));
- third-party frontends, with a publishable key in the browser or a secret key on their server.

## Decision

### Source layout

```
ota/sdk/
  src/
    index.js          createVelexisClient, VERSION, re-exports (mirrors index.d.ts)
    shared.js         error classes, isVelexisError, Page helper (mirrors shared.d.ts)
    identity.js       storefront, auth, account, reference namespaces (mirrors identity.d.ts)
    flights.js        flights namespace (mirrors flights.d.ts)
    bookings.js       checkout and bookings namespaces (mirrors bookings.d.ts)
    console.js        console namespace (mirrors console.d.ts)
    internal/http.js     fetch wrapper: headers, timeouts, retries, idempotency keys, error mapping
    internal/session.js  token mode and cookie mode
    types.js          JSDoc @typedef aliases to @velexis/api-types schemas
  test/               unit tests (Vitest, fake fetch) and test/contract/
  docs/               SDK extensions and usage notes for vanilla JS
```

- **ES2022 modules, no runtime dependencies, no transpilation of the source.** The files run as-is in evergreen browsers and Node 22. Only platform APIs are used: `fetch`, `AbortController`, `URL`, `crypto.randomUUID`.
- One method per OpenAPI operation, named by its `x-sdk-method` (96 in total). Every method takes `RequestOptions` as its last argument, as the contract defines.

### Types

- JSDoc on every export: `@param`, `@returns`, `@throws`, and `@typedef` aliases such as
  `/** @typedef {import('@velexis/api-types').components['schemas']['FlightOffer']} FlightOffer */`.
  Schema types come only from the generated OTA types, which are the `@velexis/api-types` module the contract itself imports ([ADR-0006](0006-contract-first-openapi.md)).
- **`tsc --checkJs --strict --noEmit`** runs in `pnpm typecheck`. A type error fails CI like in TypeScript code.
- **`tsc --allowJs --declaration --emitDeclarationOnly`** emits `dist/types/*.d.ts`, which ship with the package.
- **Contract check** (`ota/sdk/test/contract/`):
  - a `tsc --noEmit` project maps `velexis-contract` to `docs/velexis-sdk/sdk/src/index.d.ts` and `@velexis/api-types` to the generated package;
  - it asserts that `typeof createVelexisClient`, every namespace interface, `VelexisClientOptions`, `RequestOptions`, `Page<T>` and every error class of the emitted declarations are assignable to the contract's.
  The SDK may **add** optional options and methods. It may never remove or narrow what the contract offers.
- The contract files under `docs/velexis-sdk/sdk/src/` are **not edited**. Additions are documented in `ota/sdk/docs/extensions.md` and in the OTA OpenAPI document.

### Session modes

| Mode | Used by | How it authenticates | Tokens in JS |
|---|---|---|---|
| **Token mode** (the contract) | Third-party frontends; the OTA admin server | `X-Api-Key` from `publishableKey` or `secretKey`. `Authorization: Bearer` from `accessToken`, refreshed with `refreshToken` and reported through `onSessionRefreshed`, as in `shared.d.ts`. | Yes, the integrator's choice. Server-side for the OTA admin. |
| **Cookie mode** (extension) | The hosted storefront | `createVelexisClient({ baseUrl: "/api", session: "cookie" })`: `credentials: "same-origin"`, no key header (Caddy adds the edge credential), the `__Host-vx_csrf` cookie value copied into `X-CSRF-Token` on state-changing calls. On `TOKEN_EXPIRED` it calls `auth.refresh()` once, using cookies, and retries. | **No.** Auth methods resolve with session metadata only. |

In cookie mode, passing `publishableKey`, `secretKey` or `accessToken` throws a configuration error, so tokens cannot leak into storefront code by mistake.

### Behaviour shared by both modes (from `shared.d.ts`)

- **Errors:** the contract's error classes, mapped from `status` and `code` (`PriceChangedError` exposes `newPrice` and `oldPrice`). `toJSON()` never contains tokens or keys.
- **Retries:**
  - `maxRetries` (default 2) only for idempotent methods and POSTs with an `Idempotency-Key`, on 429, 503, 504 and network errors;
  - `Retry-After` is honoured;
  - the idempotency key is generated once per call and reused across its retries.
- **Timeouts:** `timeoutMs` (default 30 s) through `AbortController`. Search and booking calls pass 60 s.
- **Pagination:** `Page<T>` with `next()` and `for await` iteration.
- **Hooks:** `onResponse` gives method, path, status, `requestId` and duration, for logging.

### Bundles

**esbuild** produces:

- `dist/velexis-sdk.mjs`: ESM, minified, with a source map. It is what the storefront (through Vite) and npm consumers import.
- `dist/velexis-sdk.iife.js`: an IIFE exposing `window.Velexis`, for plain HTML sites using a `<script>` tag.

Other rules:

- `package.json` `exports`: `"."` → `{ types, import }`, `"./iife"` → the IIFE file. `"sideEffects": false`.
- **Size budget:** at most 25 KB min+gzip for the ESM bundle, checked in CI.
- **Milestones:**
  - M2: client core with token mode and cookie mode, `storefront`, `reference`, `flights`. The hosted storefront needs cookie mode and the CSRF header from its first state-changing call (`flights.search` is a POST); the CSRF cookie is issued by `storefront.get`.
  - M3: `auth`, `account`, `checkout`, `bookings`, and customer and guest sessions in cookies;
  - M4: `console`.
  - `next` and `react` helpers come after the MVP.
- **Distribution:** inside the monorepo through the workspace until launch. Publishing `@velexis/ota-sdk` to npm (and the IIFE to a versioned URL) is on the M6 launch checklist.

## Consequences

### Positive

- Works in any framework or none, with no build step required for consumers of the IIFE.
- Type safety comparable to TypeScript for SDK users (shipped `.d.ts`) and for us (`checkJs`).
- The contract check makes "the JSDoc types must match the contract" executable.

### Negative

- JSDoc is more verbose than TypeScript syntax, and some generic patterns are awkward (for example, the `Page<T>` async iterator). Such helpers may carry a hand-written `.d.ts` beside the `.js` file, which the contract check still verifies.
- Cookie mode is an extension that the contract does not describe. It is documented in the SDK's own docs and tested separately.

### Follow-ups

- Decided during planning; revisit the size budget if the console namespace pushes past it (split it into a separate entry point, `@velexis/ota-sdk/console`).

## Alternatives considered

- **Write the SDK in TypeScript and compile it.** Rejected by the product owner: vanilla JS with JSDoc.
- **Generate the SDK from the OpenAPI document** (openapi-fetch, orval). Loses the hand-designed namespaces, error classes and pagination of the contract.
- **Rollup or Vite library mode.** esbuild is enough for two output formats and is much faster.

## References

- [`../decisions.md`](../decisions.md) §1, §2, §5
- [`../../velexis-sdk/sdk/src/`](../../velexis-sdk/sdk/src/) (`index.d.ts`, `shared.d.ts`, `identity.d.ts`, `flights.d.ts`, `bookings.d.ts`, `console.d.ts`)
- [`../../velexis-sdk/sdk/docs/`](../../velexis-sdk/sdk/docs/) (guides B1–B4)
- [ADR-0006](0006-contract-first-openapi.md), [ADR-0008](0008-identity-accounts-customers-sessions.md), [ADR-0015](0015-testing-strategy.md), [ADR-0018](0018-hosted-storefront-custom-domains.md)
