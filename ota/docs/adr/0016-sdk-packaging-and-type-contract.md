# OADR-0016: SDK packaging and type contract

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA frontend and SDK tech lead. Decided during planning; revisit when the ESM bundle approaches the 25 KB budget, when a consumer needs CommonJS, or when the `next` and `react` helpers are built after the MVP.

## Context

[ADR-0019](../../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md) fixes the SDK: vanilla ES modules with JSDoc, no dependencies, public modules that mirror the contract files (`index`, `shared`, `identity`, `flights`, `bookings`, `console`), `internal/http.js` and `internal/session.js`, `tsc --checkJs`, emitted declarations, a contract check against [`docs/velexis-sdk/sdk/src/`](../../../docs/velexis-sdk/sdk/src/), token and cookie modes, esbuild ESM and IIFE bundles within 25 KB, npm publication at M6. [`api-changes.md`](../api-changes.md) adds 32 SDK methods and the OTA admin's environment header, and [OADR-0006](0006-storefront-cookie-sessions-and-csrf.md) approves cookie-mode responses without tokens.

Still open:

- how 128 methods learn their HTTP method, path and parameters without generating the SDK (ADR-0019 rejects generation);
- how JSDoc types avoid restating the contract's documentation;
- how the contract check handles TypeScript's bivariant method parameters and the approved deviations;
- how published types reference `@velexis/api-types`;
- the option names for cookie mode and the environment, timeouts for completion calls, and versioning.

## Decision

1. **Layout.** The public modules stay exactly as ADR-0019 names them and mirror the contract files one to one. Implementation is split into `src/namespaces/{storefront,auth,account,reference,flights,checkout,bookings,console}.js` (one factory per namespace) and `src/internal/` (`client.js`, `http.js`, `session.js`, `errors.js`, `pagination.js`, `operations.js`, `ids.js`). `src/types.js` keeps the base aliases (`Schemas`, `Paths`). The public modules re-export the factories and declare the same typedefs as their `.d.ts` counterparts ([SDK README §3](../../sdk/README.md#3-package-layout)).
2. **A generated route table, hand-written methods.** `scripts/generate-operations.mjs` turns the working OpenAPI document into `src/internal/operations.js`, a frozen data table keyed by `x-sdk-method`:
   - method and path template;
   - path, query and header parameter names;
   - idempotency (none, optional, required);
   - retry class and timeout, with a small reviewed override list for values the document does not carry.

   Each namespace method is one line calling `core.call(op.<name>, params, options)`; its JSDoc is written by hand. The generator fails on a parameter-name collision. CI regenerates the table and fails on a diff.
3. **Types are inferred from the factories.** `FlightsApi` and friends are `ReturnType<typeof createFlightsApi>`, so each method is documented once. Overloads use JSDoc `@overload`; `Page<T>` is a class with `@template T`. Schema types come only from `@velexis/api-types`.
4. **Contract test.** A `tsc --noEmit` project maps `velexis-contract` to the contract's `index.d.ts`, `@velexis/ota-sdk` to the emitted `dist/types/index.d.ts`, and `@velexis/api-types` to the generated package for both. It contains:
   - **generated per-method assertions**: the contract's `Parameters` are assignable to the SDK's, and the SDK's awaited return type is assignable to the contract's (explicit, because interface assignability compares methods bivariantly);
   - hand-written assertions for the client, options, `RequestOptions`, `Page<T>`, the error classes and `isVelexisError`;
   - an **approved-deviations list** (`test/contract/deviations.ts`) where each entry names the ADR that approves it. The only entry is the cookie-mode auth response union of OADR-0006. Anything else that fails is a bug.

   A Vitest parity test asserts that the `x-sdk-method` set of the working document equals the method set of a client instance.
5. **Options.**
   - `session: "token" | "cookie"` (default `"token"`) selects the mode.
   - `environment: "test" | "live"` sends `X-Velexis-Environment` on console operations.
   - In cookie mode, keys, tokens and `Authorization` or `X-Api-Key` headers throw a `TypeError`, and `fetch` runs with `credentials: "same-origin"` and `mode: "same-origin"`.
   - `secretKey` throws a `TypeError` when `globalThis.document` exists.

   All additions are listed in [`ota/sdk/docs/extensions.md`](../../sdk/docs/extensions.md).
6. **Behaviour details.**
   - Cookie mode fetches `GET /v1/storefront` once when the CSRF cookie is missing, and once more on `403 CSRF_TOKEN_INVALID` before one retry.
   - Concurrent `401 TOKEN_EXPIRED` share one refresh.
   - Default timeouts: 60 s for search, upsell, price and the long console booking actions; 90 s for `checkout.complete` and `checkout.completeWithAirlineCard`.
   - `checkout.completeWithAirlineCard` is never retried.
   - A client-side timeout is not retried.
   - A `Retry-After` above 30 s throws at once.
   - Idempotency keys fall back to `crypto.getRandomValues` where `randomUUID` is missing.
   - `501 NOT_IMPLEMENTED` maps to `ServerError` with `retryable: false`.
7. **Packaging.**
   - **Bundles:** ESM (`dist/velexis-sdk.mjs`) and IIFE (`window.Velexis`) from esbuild; declarations from `tsc`. ESM only, no CommonJS build.
   - **`exports`:** `"."` → `{ types, development: "./src/index.js", import }`, `"./iife"`; `"sideEffects": false`. The `development` condition lets Vite's dev server use the unbundled source.
   - **Published types:** for npm, the build copies the OTA part of `@velexis/api-types` into `dist/types/api-types.d.ts` and rewrites the import specifier, so the published package has no dependencies, not even for types.
   - **Size:** at most 25 KB min+gzip for the ESM bundle, checked in CI.
8. **Versioning and publication.**
   - `0.x` inside the workspace until M6, then `1.0.0` on npm.
   - A change the contract test would reject is a major version; new methods and options are minor; fixes are patches.
   - `CHANGELOG.md` is kept by hand, and `VERSION` (in `src/version.js`) is tested against `package.json`.
   - A manual GitHub Actions workflow publishes from a `sdk-vX.Y.Z` tag with npm provenance.
   - The IIFE is reachable through npm-mirroring CDNs, with the SRI hash in the release notes.

## Consequences

### Positive

- Paths, parameters and idempotency rules cannot drift from the OpenAPI document; method bodies stay trivial, which keeps the bundle small.
- "The JSDoc types must match the contract" is checked per method, including parameters, which plain assignability would miss.
- Approved contract changes are visible in one file with their ADRs.
- Consumers install one package with no dependencies and complete types.

### Negative

- One more generator to maintain, and an override list to review for timeouts and retry classes.
- Types inferred from factories make the emitted `.d.ts` less readable than hand-written interfaces (the contract files remain the readable reference).
- Copying `@velexis/api-types` into the published package duplicates types for monorepo consumers who also use the generated package (they are the same file, so they stay compatible).

### Follow-ups

- If the console namespace pushes the bundle past 25 KB, add `@velexis/ota-sdk/console` as a separate entry (ADR-0019 follow-up).
- The M6 launch checklist gets the publish workflow, the npm organisation and the documentation of the IIFE URL.

## Alternatives considered

- **Route details written by hand in every method.** 128 places to keep in sync with the document, and no mechanical check besides tests.
- **Generating the whole SDK** (openapi-fetch, orval). Rejected by ADR-0019: it loses the contract's namespaces, errors and pagination.
- **Hand-written interfaces in JSDoc `@typedef` objects.** Duplicates every method signature and its documentation.
- **Plain interface assignability as the contract check.** Misses narrowed parameters because of method bivariance.
- **Publishing `@velexis/api-types` as a second npm package.** Two packages to version together for no user benefit.
- **A CommonJS build.** Node 22 can `require()` ES modules; a second format doubles the test matrix.

## References

- [ADR-0019](../../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md), [ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md), [ADR-0015](../../../docs/mvp/adr/0015-testing-strategy.md)
- [OADR-0006](0006-storefront-cookie-sessions-and-csrf.md), [OADR-0011](0011-console-access-staff-sessions-and-environments.md), [OADR-0017](0017-airline-card-form-isolation.md)
- [`../../sdk/README.md`](../../sdk/README.md), [`../../sdk/docs/types-and-builds.md`](../../sdk/docs/types-and-builds.md), [`../../sdk/docs/extensions.md`](../../sdk/docs/extensions.md), [`../api-changes.md`](../api-changes.md)
