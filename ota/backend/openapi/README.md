# OTA booking API contract (`ota/backend/openapi/`)

This folder holds the OpenAPI 3.1 document of the Velexis OTA booking API, `velexis-ota-booking-api.openapi.yaml`. It is the **source of truth** for every request and response shape of the OTA backend, the JS SDK, the OTA admin and the hosted storefront ([ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md)). This page says what the document is, how to change it, which changes are allowed, which extensions are planned, and what has changed since the copy. Read it before any task that edits the document, together with [`AGENTS.md` §6](../../../AGENTS.md#6-contract-first).

Related: [ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md) (contract first), [`AGENTS.md` §6](../../../AGENTS.md#6-contract-first) (contract-first rules for agents), [`../../docs/api-changes.md`](../../docs/api-changes.md) and [`../../docs/api-changes-console-and-internal.md`](../../docs/api-changes-console-and-internal.md) (the planned changes, operation by operation), [`../../docs/scope.md`](../../docs/scope.md) §3 (milestone of every operation), [`packages/README.md`](../../../packages/README.md) (`@velexis/api-types`, `@velexis/errors`), [`../../sdk/docs/extensions.md`](../../sdk/docs/extensions.md) (what the SDK adds to the contract), [frozen original](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml).

## 1. What is here

| File | Role |
|---|---|
| `velexis-ota-booking-api.openapi.yaml` | The working contract, OpenAPI 3.1 YAML. Foundation task X-006 copied it **byte for byte** from [`docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml`](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml): `info.version` `1.0.0`, 96 operations in 19 tags, every one with `x-sdk-method` and `x-scope` (`customer` 36, `both` 27, `console` 33), and 66 codes in `x-error-catalogue`. |
| `README.md` | This page. |

What is **not** here:

- **The JSON form.** Only the YAML is the contract. When a tool needs JSON, generate it from the YAML (for example with the Redocly CLI that X-007 installs, `redocly bundle … --ext json`) into a scratch location. It is never committed here and never edited.
- **The frozen original.** [`docs/velexis-sdk/openapi/`](../../../docs/velexis-sdk/openapi/) keeps the original design (YAML and JSON) and is never edited again ([`decisions.md`](../../../docs/mvp/decisions.md) §3). The CI repository guard fails a pull request that changes anything under `docs/velexis-sdk/` or `docs/amadeus-api/`. Tests that must stay stable while this document grows read the 96 original operations from there (the operations-index test of X-008, the milestone test of OBE-009).

Keep the file name and location. The turbo inputs of `generate`, `contracts:lint` and `@velexis/api-types#test` and the Redocly config ([`packages/api-types/redocly.yaml`](../../../packages/api-types/redocly.yaml), X-007) point to this folder today; the generators of `@velexis/api-types`, `@velexis/errors` and the SDK route table, the backend's Ajv loader and the release folder (`ota-backend/openapi/`, [ADR-0023](../../../docs/mvp/adr/0023-release-artefact-and-deploy-user.md)) will.

## 2. The source of truth

- **Backend.** Handlers are bound to an `operationId` and use the generated types for bodies; there are no hand-written DTO classes. At start-up the backend compiles the request schemas of every operation with Ajv and validates path, query, headers and body before the controller runs (`400 VALIDATION_FAILED`). Integration tests validate every response against the operation's response schema.
- **Types.** `pnpm contracts:generate` turns the document into `@velexis/api-types` (the module name the SDK contract in [`docs/velexis-sdk/sdk/src/`](../../../docs/velexis-sdk/sdk/src/) imports) and the operations index `@velexis/api-types/operations`. Generated files are committed.
- **Errors.** `@velexis/errors` is generated from `x-error-catalogue`, so code can only throw codes that the document lists.
- **SDK.** The SDK has exactly one method per `x-sdk-method` ([ADR-0019](../../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md)); its route table is generated from this document (`pnpm --filter @velexis/ota-sdk generate`).
- **Never hand-write** a request or response type that the document defines, in any component. If a shape is missing, add it here first.

Vendor extensions already in the document:

| Extension | On | Meaning |
|---|---|---|
| `x-sdk-method` | operation | SDK method name (`namespace.method`), one per operation |
| `x-scope` | operation | `customer`, `console` or `both`: which callers may use it |
| `x-amadeus` | operation | The Amadeus Enterprise operations the handler calls |
| `x-tenant-tables`, `x-platform-tables`, `x-reference-tables` | operation | Tables read or written, per schema |
| `x-error-codes` | operation | Catalogue codes the operation can answer |
| `x-idempotent-by-design` | operation | A `POST` that is safe to repeat without an `Idempotency-Key` |
| `x-error-catalogue` | root | Every public error code with its HTTP status and description |
| `x-tagGroups`, `x-new-tenant-tables` | root | Tag navigation; the tenant tables the original design added to the baseline |
| `x-examples`, `x-tags`, `x-risk-personal-data-field` | schema | Carried over inside the `Amadeus*` schemas converted from [`docs/amadeus-api/`](../../../docs/amadeus-api/) |

The MVP vendor extensions, documented in the document's `info.description` since OBE-009 ([`api-changes.md`](../../docs/api-changes.md) §1); the operations index `@velexis/api-types/operations` carries `x-milestone`, `x-edge-only` and `x-permission` as `milestone`, `edgeOnly` and `permission`:

| Extension | On | Meaning |
|---|---|---|
| `x-milestone` | operation | `M0` … `M6` or `deferred`: the milestone that implements it. The route answers `501 NOT_IMPLEMENTED` (`details.milestone`) until its handler exists, and for good when `deferred` (route-parity allow-list). Every operation has one; the 96 original operations carry the milestones of [`scope.md`](../../docs/scope.md) §3 |
| `x-edge-only: true` | operation | Only the hosted storefront edge may call it; keys and the service key get `403 SCOPE_NOT_ALLOWED` |
| `x-internal: true` | operation, security scheme | Not for SDK users, excluded from the SDK and the public reference (the `storefrontEdge` scheme today; the `Internal` endpoints later) |
| `x-sdk-exclude: true` | operation | Public, but used as a plain URL (images, downloads), so no SDK method |
| `x-permission` | console operation | The `StaffPermission` the operation needs (added to the console operations by OBE-058) |

## 3. Workflow for every change

The order is fixed by [ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md) (Workflow) and [`AGENTS.md` §6](../../../AGENTS.md#6-contract-first). The document is always changed **first**, in a spec-first task, before any handler or SDK method uses the change.

1. **Edit the document.** Follow the sketch in the API-changes documents when there is one. Keep the conventions of the original: JSON camelCase, prefixed ids, the `Error` envelope, cursor pagination, `Idempotency-Key`, and on every operation `operationId`, `x-sdk-method` (unless it is `x-internal` or `x-sdk-exclude`), `x-scope`, `x-error-codes` and the table extensions. New error codes go into `x-error-catalogue` in the task that first throws them.
2. **`pnpm contracts:lint`.** Redocly CLI lint with the repository rules (`packages/api-types/redocly.yaml`, task X-007). Zero errors.
3. **`pnpm contracts:generate`.** Regenerates `@velexis/api-types` (X-008) and `@velexis/errors` (X-009). Commit the generated files; CI runs the generator again and fails on any diff. The output is deterministic, so a second run leaves no diff.
4. **Handler.** Implement the operation with the generated types. Until its handler exists, the operation is listed in `ota/backend/src/common/http/pending-operations.ts` and answers `501 NOT_IMPLEMENTED` (route parity).
5. **SDK method.** For OTA operations with an `x-sdk-method`: regenerate the SDK route table, add the method and its JSDoc, and list SDK additions in [`../../sdk/docs/extensions.md`](../../sdk/docs/extensions.md). The contract files in `docs/velexis-sdk/sdk/src/` are never edited.
6. **Tests.** Route parity (every operation has a handler or a pending entry, every handler has an operation), response conformance (Ajv in integration tests), SDK parity (every `x-sdk-method` maps to exactly one SDK method) and the contract test of the spec task, which asserts its own operations by `operationId`, never totals.
7. **Change log.** Add a row to §6 of this page in the same PR.

`pnpm contracts:lint` exists since X-007 and `pnpm contracts:generate` since X-008 (types and the operations index, [`packages/api-types/README.md`](../../../packages/api-types/README.md)); X-009 adds the `@velexis/errors` generator to it.

## 4. Additive changes only

**Changes to this document are additive only, unless an ADR approves a breaking change** ([ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md), Workflow step 1). [`AGENTS.md` §6](../../../AGENTS.md#6-contract-first) sets the same rule for the SDK's types against the frozen contract: additions are allowed, removing or narrowing anything is not.

| Additive (allowed) | Breaking (needs an ADR) |
|---|---|
| A new operation, schema, tag, security scheme or optional parameter | Removing or renaming an operation, path, `operationId`, `x-sdk-method`, schema, property, parameter or error code |
| A new optional request property or header | Making an optional request property, parameter or header required |
| A new response property, a new enum value, a new error code | Narrowing a type, format, pattern or enum of an existing property |
| A security alternative for a new caller kind (for example the storefront edge) | Changing an existing response type or status code, or making a required response property nullable |
| A clearer description that does not change behaviour | Changing the meaning of an existing field, parameter or code |

When a change is breaking, the PR links the ADR that approves it, and the change-log row names it. Example: [OADR-0006](../../docs/adr/0006-storefront-cookie-sessions-and-csrf.md) point 4 approves the `oneOf` response of `signIn`, `refreshSession` and `changePassword` and the nullable `BookingLookupResult.bookingToken` for the cookie session mode. Review is the main guard: the schema test of `@velexis/api-types` (every schema of the SDK contract still exists) and the SDK contract test of [ADR-0019](../../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md) catch some breaking changes, not all.

## 5. Planned spec-first extensions

The MVP needs things the original design does not have. [ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md) (Extensions to the OTA document) lists them, and each is added spec-first, in the task that needs it. The details (schemas, parameters, error codes, tables) are in [`api-changes.md`](../../docs/api-changes.md) and [`api-changes-console-and-internal.md`](../../docs/api-changes-console-and-internal.md).

| Extension | What it adds to the document | Decided in | Spec task |
|---|---|---|---|
| **Cookie session mode and CSRF header** | Security schemes `customerCookie` (`__Host-vx_at`) and `bookingCookie` (`__Host-vx_bt`), the `CsrfToken` parameter (`X-CSRF-Token`) on state-changing edge requests, the `Set-Cookie` response header, edge-mode response bodies without tokens, `CSRF_TOKEN_INVALID` (403) | [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md), [OADR-0006](../../docs/adr/0006-storefront-cookie-sessions-and-csrf.md); api-changes §2 | OBE-009 (M2), done |
| **Edge headers** | Security scheme `storefrontEdge` (`X-Velexis-Edge`, `x-internal: true`, set by Caddy, never by a browser) as an alternative on every `customer` and `both` operation; the edge use of `X-Velexis-Host` (parameter `StorefrontHostHeader`); `x-edge-only: true` for operations only the edge may call | [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md), [OADR-0009](../../docs/adr/0009-caller-and-tenant-resolution.md); api-changes §1, §2 | OBE-009 (M2), done; the first `x-edge-only` operation with OBE-029 (M3) |
| **Service credentials** | The first-party service credentials: the storefront edge (above) and the OTA admin's service key in `X-Api-Key`, with the `X-Velexis-Environment` parameter (`test`, `live`) and the end-user IP and user-agent headers on every console operation, `ConsoleStaffSession.environments`, `ENVIRONMENT_NOT_ALLOWED` (403) | [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [OADR-0011](../../docs/adr/0011-console-access-staff-sessions-and-environments.md); api-changes §5 | OBE-009 (M2), done; the error code with OBE-058 (M4) |
| **Airline-card operation** | `completeCheckoutWithAirlineCard` (`checkout.completeWithAirlineCard`, `x-edge-only`, `x-sensitive` card), `airline_card` in the payment enums, the payment account modes of `StorefrontPaymentConfig`, `PAYMENT_ATTEMPTS_EXCEEDED` (403) | [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [OADR-0004](../../docs/adr/0004-airline-card-data-handling.md); api-changes §3, §4 | OBE-029 (M3) |
| **`Internal` tag with `x-internal: true`** | Webhook receivers and internal endpoints, excluded from the SDK and the public reference: `receiveStripeVelexisWebhook`, then `healthLive`, `healthReady`, `receiveStripeConnectWebhook` and `receiveStripeConnectionWebhook` | [ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md), [OADR-0010](../../docs/adr/0010-stripe-gateway-and-payment-webhooks.md); api-changes part 2 §5 | OBE-039 (M3), OBE-090 (M4; the Connect and connection webhooks are served from M5) |

The Caddy `ask` endpoint for on-demand TLS is not in this document: it belongs to the platform backend, which owns `tenant_domains`, so it is documented in `platform/backend/openapi/` (api-changes part 2 §5).

Other spec-first additions planned for the MVP:

- **Vendor extensions** `x-milestone` (route-parity allow-list), `x-permission` (console scope guard) and `x-sdk-exclude` (plain URLs such as images and downloads), documented in `info.description` by OBE-009 (done), which also gives each of the 96 original operations its `x-milestone` and adds `NOT_IMPLEMENTED` (501) to the catalogue.
- **Console settings** (markup and fee rules, storefront settings, templates; 17 operations) and the new `StaffPermission` values by OBE-058; **console payments** (4 operations) by OBE-090; **content pages and storefront assets** (8 console and 3 public operations, `ASSET_INVALID`) by OBE-091; the file download `downloadFile` (`x-sdk-exclude`) by OBE-054; the billing notice of the console session by OBE-076 (M5).

After the M4 spec tasks the document has 135 operations, 128 of them with an `x-sdk-method` ([`api-changes-console-and-internal.md`](../../docs/api-changes-console-and-internal.md) §6).

## 6. Change log

Every task that changes the document adds one row, newest last, in the same PR. "Breaking" names the approving ADR, or says "no". OBE-039 (`receiveStripeVelexisWebhook`) and OBE-054 (`downloadFile`) change the document without listing this page in their **Files**; they add their row as the minimal extra change that [`AGENTS.md` §4](../../../AGENTS.md#4-doing-a-task-one-task--one-branch--one-pr) step 4 allows and say so in the PR.

| Task | Milestone | Change | Operations | Breaking |
|---|---|---|---|---|
| X-006 | M0 | Copied byte for byte from `docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml` (`info.version` `1.0.0`, 66 error codes). The JSON form was not copied. | 96 | no |
| OBE-009 | M2 | `info.description` documents the hosted storefront's edge mode, the OTA admin's service key and the MVP vendor extensions (`x-edge-only`, `x-internal`, `x-sdk-exclude`, `x-milestone`, `x-permission`). Every operation gets `x-milestone` from scope §3 (77 `M2`/`M3`/`M4`, 19 `deferred`). Edge and cookie mode (api-changes §2): security schemes `storefrontEdge` (`x-internal`), `customerCookie`, `bookingCookie`; each of the 63 `customer` and `both` operations lists the edge counterparts of its key alternatives (`apiKey` → `storefrontEdge`, with `customerAuth` → `customerCookie`, with `bookingToken` → `bookingCookie`; staff alternatives have none); parameter `CsrfToken` and `CSRF_TOKEN_INVALID` in `x-error-codes` on the 32 state-changing ones (`refreshSession` also lists `INVALID_REQUEST`); `HOST_NOT_ALLOWED` (unknown edge host, §2.4) in `x-error-codes` of every operation with an edge alternative; header `Set-Cookie` on the success responses of `getStorefront`, `signUp`, `signIn`, `refreshSession`, `signOut`, `resetPassword`, `changePassword`, `deleteAccount`, `completeCheckout`, `lookupBooking`, with edge-mode notes; `signIn`, `refreshSession`, `changePassword` `200` → `oneOf [AuthSessionResult, AuthSessionInfo]`; `AuthRefreshRequest.refreshToken` optional; `BookingLookupResult.bookingToken` nullable; edge use of `StorefrontHostHeader`. Service credential (api-changes §5): parameter `VelexisEnvironment` and the existing `CustomerEndUserIp` and `CustomerEndUserAgent` on the 33 `console` operations (descriptions name the service key; `consoleGetMe` gains the `400` response and `VALIDATION_FAILED` that the other console operations already had), the service key in the `apiKey` description, required `ConsoleStaffSession.environments` (example updated). Catalogue: `CSRF_TOKEN_INVALID` (403), `NOT_IMPLEMENTED` (501), 68 codes. The operations index gains `milestone`, `edgeOnly` and `permission`. | 96 | [OADR-0006](../../docs/adr/0006-storefront-cookie-sessions-and-csrf.md) point 4 (the `oneOf` responses and the nullable `bookingToken`); otherwise no |
