# ADR-0006: Contract first with OpenAPI

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (contracts first, locations), lead architect (tooling and checks)

## Context

[`decisions.md`](../decisions.md) §5 requires API changes to start in an OpenAPI document. The OTA booking API already exists as a validated OpenAPI 3.1 document with 96 operations, and each operation carries `x-sdk-method`, `x-amadeus`, `x-tenant-tables` and `x-scope` ([`velexis-ota-booking-api.openapi.yaml`](../../velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)). The SDK contract in [`docs/velexis-sdk/sdk/src/`](../../velexis-sdk/sdk/src/) imports its schema types from a module named `@velexis/api-types` that is generated from that document. The platform API has no document yet.

## Decision

### Documents

| API | Source of truth | Notes |
|---|---|---|
| OTA booking API | `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml` | Moved from `docs/velexis-sdk/openapi/` in M0. The copy under `docs/velexis-sdk/` is frozen as the original design and is no longer edited. |
| Platform API | `platform/backend/openapi/velexis-platform-api.openapi.yaml` | New in M1. Same conventions as the OTA document (JSON camelCase, prefixed ids, error envelope, cursor pagination, `Idempotency-Key`), with `x-scope` values `portal`, `platform_admin` and `internal`. |

Both are OpenAPI 3.1 YAML. The JSON form is generated when needed, never edited.

### Workflow for every API change

1. Edit the OpenAPI document. Additive changes only, unless a new ADR approves a breaking change.
2. `pnpm contracts:lint`: Redocly CLI lint with the repository rules.
3. `pnpm contracts:generate`: openapi-typescript writes the types into `packages/api-types`. The OTA types are exported as `@velexis/api-types` (the module name the SDK contract already imports) and the platform types as `@velexis/api-types/platform`. Generated files are committed.
4. Implement the handler, using the generated types for request and response bodies. There are no hand-written DTO classes.
5. Update the SDK method and its JSDoc for OTA changes ([ADR-0019](0019-vanilla-js-sdk-jsdoc.md)).
6. Tests prove that the implementation matches the document (below).

### Runtime validation

- Each backend compiles the request schemas of every operation with **Ajv** (plus `ajv-formats`) at start-up. A NestJS interceptor validates path, query, headers and body before the controller runs, and answers `400 VALIDATION_FAILED` with `fieldErrors` from the Ajv errors.
- Responses are **not** validated at runtime in production. They are validated in tests.

### Checks in CI

- The generated types are up to date (`pnpm contracts:generate` followed by `git diff --exit-code`).
- **Route parity:** a test lists the NestJS routes and the document's operations. Every operation that the current milestone claims has a handler, and every handler has an operation. Unimplemented operations answer `501` and are listed in an allow-list that shrinks milestone by milestone.
- **Response conformance:** integration tests validate every response body against the operation's response schema with Ajv ([ADR-0015](0015-testing-strategy.md)).
- **SDK parity:** every `x-sdk-method` maps to exactly one SDK method, and the SDK's emitted declarations satisfy the contract in `docs/velexis-sdk/sdk/src/` ([ADR-0019](0019-vanilla-js-sdk-jsdoc.md)).
- **Error catalogue:** `@velexis/errors` is generated from `x-error-catalogue`, so code can only throw codes that the document lists.

### Extensions to the OTA document

The MVP adds some things that the original design did not have. Each is added spec-first, in the task that needs it:

- the hosted-storefront cookie session mode and its CSRF header ([ADR-0018](0018-hosted-storefront-custom-domains.md));
- the first-party service credentials of the storefront edge and the OTA admin ([ADR-0008](0008-identity-accounts-customers-sessions.md));
- the airline-card payment operation ([ADR-0011](0011-payments-stripe-and-airline-card.md)).

Webhook receivers and internal endpoints (Stripe webhooks, the Caddy `ask` endpoint) are documented in their backend's document under the tag `Internal`, marked `x-internal: true` and excluded from the SDK.

## Consequences

### Positive

- One source for request and response shapes across the backend, the SDK, the OTA admin and the storefront.
- Agents get exact types and an executable definition of done for API work.
- Spec drift is caught in CI instead of in production.

### Negative

- Every API change touches at least three places: document, generated types, implementation. This is intended.
- Ajv validation from a large document adds start-up time (measured in M2, acceptable below 2 s).

### Follow-ups

- M0 moves the OTA document to `ota/backend/openapi/`, sets up `@velexis/api-types` and the CI checks. M1 creates the platform document.
- Decided during planning; revisit the `501` allow-list approach once all 96 operations are implemented (end of M4). The allow-list then becomes empty and the parity check strict.

## Alternatives considered

- **Code first** (NestJS Swagger decorators that generate the document). It would discard the reviewed 96-operation document and make the contract a by-product.
- **class-validator DTOs.** They duplicate the schemas in a second language and drift from the document.
- **Zod schemas as the source.** Good for forms, but the OpenAPI document is already the reviewed contract ([ADR-0014](0014-frontend-stack-nextjs-tailwind.md) keeps Zod for forms only).

## References

- [`../decisions.md`](../decisions.md) §3, §5
- [`../../velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml`](../../velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)
- [`../../velexis-sdk/sdk/src/shared.d.ts`](../../velexis-sdk/sdk/src/shared.d.ts) (imports `@velexis/api-types`)
- [ADR-0015](0015-testing-strategy.md), [ADR-0019](0019-vanilla-js-sdk-jsdoc.md)
