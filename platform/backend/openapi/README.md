# Platform API contract (`platform/backend/openapi/`)

This folder holds the OpenAPI 3.1 document of the Velexis platform API, `velexis-platform-api.openapi.yaml`. It is the **source of truth** for every request and response shape of the platform backend, the portal and the platform admin ([ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md), [PADR-0009](../../docs/adr/0009-platform-api-surface-and-authentication.md)). This page says where its operations come from, which conventions and `x-` extensions it uses, how to change it and how to regenerate what is built from it. Read it, with [`AGENTS.md` §6](../../../AGENTS.md#6-contract-first), before any task that edits the document.

Related: [`../../docs/api-inventory.md`](../../docs/api-inventory.md), [`../../docs/api-inventory-resources.md`](../../docs/api-inventory-resources.md) and [`../../docs/api-inventory-admin.md`](../../docs/api-inventory-admin.md) (the inventory), [PADR-0016](../../docs/adr/0016-contract-rollout-per-milestone-and-route-parity.md) (slices and route parity), [`packages/api-types/README.md`](../../../packages/api-types/README.md) (`contracts:lint`, `contracts:generate`, the operations index), [`packages/errors/README.md`](../../../packages/errors/README.md) (the error catalogue), [`ota/backend/openapi/README.md`](../../../ota/backend/openapi/README.md) (the OTA document, whose conventions this one shares).

## 1. What is here

| File | Role |
|---|---|
| `velexis-platform-api.openapi.yaml` | The contract, OpenAPI 3.1 YAML. `info.version` `1.0.0`; operations are only added, slice by slice (§2). |
| `README.md` | This page. |

Only the YAML is the contract. When a tool needs JSON, generate it into a scratch location (`redocly bundle platform --ext json`, see [`packages/api-types/README.md`](../../../packages/api-types/README.md#commands)); it is never committed.

Keep the file name and location: [`packages/api-types/redocly.yaml`](../../../packages/api-types/redocly.yaml) (lint and types), the generator of `@velexis/errors`, the response checks of `@velexis/testing`, the Turborepo inputs in [`turbo.json`](../../../turbo.json) and the backend's Ajv loader (PBE-008) all read it from here.

## 2. Where the operations come from

Every operation comes from the platform API inventory, with its `operationId`, method and path unchanged. The inventory's columns map to the document like this:

| Inventory | Document |
|---|---|
| Operation, Method and path | `operationId`, the path item and its method |
| Auth `public` / `portal*` / `portal` (with roles) / `admin` / `internal` / `webhook` | `x-scope`: `public` / `portal_unverified` / `portal` / `platform_admin` / `internal` / `webhook`, and the security scheme (§3) |
| `MFA↑`, `Idem`, `F:<switch>`, admin **reason** | `x-mfa-step-up: true`, `x-idempotent: true`, `x-feature: <switch>`, `x-reason-required: true` |
| Request → response | `requestBody` and `responses`, with named component schemas |
| Tables | `x-platform-tables` (Redis keys are named in the description) |
| Errors | `x-error-codes` and one error response per status, with an example per code (§5) |

The document grows in **milestone slices**, each written before the implementation tasks of its milestone ([PADR-0016](../../docs/adr/0016-contract-rollout-per-milestone-and-route-parity.md) item 1). Until a route is implemented, its operation is listed in `platform/backend/test/contract/pending-operations.ts` with the implementing task (PBE-008 creates the list and the route parity test).

| Slice | Task | Operations | State |
|---|---|---|---|
| M1 identity, plans, internal | PBE-005 | Auth (api-inventory §4, 11), account (§5, 9), `listPlans` (§6), `tlsAsk`, `healthLive`, `healthReady` (admin §9): 24 | Done |
| M1 tenants, team, keys, reads | PBE-006 | 27 | Planned |
| M1 admin, part 1 | PBE-007 | 21 | Planned |
| M1 admin, part 2 | PBE-066 | 26 | Planned |
| M3–M4 | PBE-037 | 3 | Planned |
| M5 portal | PBE-041 | — | Planned |
| M5 admin and webhooks | PBE-042 | — | Planned |

Notes on the PBE-005 slice:

- `healthLive` is `public` (the uptime monitor reaches it through Caddy) and `healthReady` and `tlsAsk` are `internal`, as the inventory says; PADR-0009 item 1 groups all of `/health/*` with the internal surface. All three carry `x-internal: true` and the tag `Internal`, because none belongs to the portal or admin surface.
- `tlsAsk`'s `domain` parameter has no schema constraint and is not required: a missing or malformed host must answer `404` before any lookup ([PADR-0004](../../docs/adr/0004-custom-domain-verification.md) item 6), never `400`.
- The health answers are the ones `HealthService` gives since PBE-001; `HealthReady.queues` (the oldest waiting job per platform queue, api-inventory-admin §9) is optional until the queues exist.
- `resendVerification` sends a new link and leaves the earlier unexpired links valid, as [PADR-0008](../../docs/adr/0008-email-verification-and-mfa-policy.md) item 3 decides. Step 4 of PBE-013 in the plan says the older tokens are consumed; the ADR wins.
- Passwords are bounded only in length (1–256): the password rules answer `422 PASSWORD_TOO_WEAK` from the service, so a short password must pass the schema (PBE-013).

## 3. Conventions

The same as the OTA document ([`conventions.md` §1 and §6](../../../docs/mvp/conventions.md), [PADR-0009](../../docs/adr/0009-platform-api-surface-and-authentication.md) item 6), and stated in the document's `info.description`:

- JSON in camelCase; ids are prefixed ULIDs (`acc_`, `ten_`, `stf_`, …, pattern `^<prefix>_[0-9A-HJKMNP-TV-Z]{26}$`); money is the `Money` schema of the OTA document (`amount` a decimal string); times are ISO 8601 UTC with `Z`.
- Lists: the `Cursor` and `Limit` parameters (default 50, maximum 200) and `{data, page: Page}`. A list that is never long (`listSessions`, `listPlans`) answers `{data}` only, as the inventory says.
- Versioned resources answer `ETag: "<version>"` (component header `ETag`); their PATCH takes the `IfMatch` parameter and answers `412 PRECONDITION_FAILED` when it is stale.
- `x-idempotent: true` operations take the `IdempotencyKey` parameter (required); a replay within 24 hours answers the stored response.
- **Secrets.** A 2xx answer that carries a secret (access, refresh, MFA challenge or portal tokens, the TOTP secret, recovery codes, a key shown once) documents the header `Cache-Control` with the component `NoStore` (`const: no-store`). Such answers are never cached and never stored for an idempotent replay. The health answers use `NoStoreHealth`, which says the same without meaning a secret.
- Every response documents `X-Request-Id`. Request bodies are closed (`additionalProperties: false`, also in every `oneOf` branch). Response schemas are closed too, so the response checks of the integration tests catch a field that should not be there (a hash, a ciphertext).
- **Security schemes.** `portalBearer` (audience `portal`) on `portal_unverified` and `portal` operations, `adminBearer` (audience `platform_admin`) on `platform_admin` ones, and `security: []` on `public`, `internal` and `webhook` operations, whose checks are not bearer tokens.
- The end-user headers `X-Velexis-End-User-IP`, `X-Velexis-End-User-Agent` and `X-Velexis-Bff-Key` ([PADR-0019](../../docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md)) are handled by the request context for every operation and are described in `info.description`, not repeated as parameters.
- **The error envelope** is the OTA document's `ErrorResponse`, `Error` and `FieldError` (the same properties, types and patterns) without the console-only `supplier` field, which the platform never sends, and closed.

## 4. Extensions

| Extension | On | Meaning | Used by |
|---|---|---|---|
| `x-scope` | every operation | `public`, `portal_unverified`, `portal`, `platform_admin`, `internal` or `webhook` (§2) | The operations index (`scope`), the auth guards (PBE-012) |
| `x-internal: true` | internal, health and webhook operations | Outside the portal and admin surface | The operations index (`internal`) |
| `x-idempotent: true` | operation | `Idempotency-Key` required, 24-hour replay | The idempotency interceptor (PBE-009) |
| `x-mfa-step-up: true` | operation | TOTP step-up within 15 minutes: `401 REAUTH_REQUIRED`, or `403 MFA_REQUIRED` without MFA | `RecentMfaGuard` (PBE-012) |
| `x-feature: <switch>` | operation | Milestone switch of [PADR-0015](../../docs/adr/0015-milestone-feature-switches.md): `403 FEATURE_DISABLED` while off | `FeatureGuard` (PBE-012) |
| `x-reason-required: true` | admin operation | Required `reason` (5–500 characters) in the body, kept in the audit row | Admin tasks (PBE-007, PBE-066) |
| `x-error-codes` | every operation | The catalogue codes it answers; exactly the codes of its error examples | Reviewers, the contract test |
| `x-platform-tables` | every operation | The `platform` tables it reads or writes | Reviewers |
| `x-error-catalogue` | root | Every error code with its HTTP status and default message (§5) | `@velexis/errors` |

OpenAPI 3.1 allows `x-*` keys everywhere, and Redocly's `recommended` rules accept them ([`packages/api-types/redocly.yaml`](../../../packages/api-types/redocly.yaml)); the X-007 lint test checks that no problem concerns an extension.

## 5. The error catalogue

`x-error-catalogue` lists every code of [api-inventory §3](../../docs/api-inventory.md#3-error-catalogue) (52 codes) with its status and a default message that is safe to show and never echoes a submitted value. `pnpm contracts:generate` turns it into `PlatformErrorCode`, `PLATFORM_ERROR_CODES` and the platform entries of `ERROR_CATALOGUE` in `@velexis/errors`.

- A code that both documents list must have the **same HTTP status** in both, or the generator of `@velexis/errors` fails (conventions §6). For such a shared code `ERROR_CATALOGUE` keeps the OTA entry, so the default `AppError` message is the OTA description; the platform backend passes its own message where the OTA wording does not fit.
- A new code is added here and to api-inventory §3 in the task that first answers it.
- An operation answers each error status with one response whose examples name its codes (component examples named after the code, such as `#/components/examples/NOT_FOUND`). Only `VALIDATION_FAILED` examples carry `fieldErrors`; a code with field errors must be in `FIELD_ERROR_CODES` of `@velexis/errors`, whose test compares the list with the examples of both documents.

## 6. Changing the document

1. **Edit the document.** Take the operation from the inventory (§2) and follow §3 to §5. Additive changes only, unless an ADR approves a breaking one (the rules of [`ota/backend/openapi/README.md` §4](../../../ota/backend/openapi/README.md#4-additive-changes-only) apply here too).
2. **`pnpm contracts:lint`** until it reports zero errors (§7).
3. **`pnpm contracts:generate`**, then commit the document with `packages/api-types/src/generated/platform.ts`, `packages/api-types/src/generated/operations.ts` and `packages/errors/src/generated/catalogue.ts`. A second run must give no diff; CI runs it again and fails on one.
4. **`pnpm --filter @velexis/platform-backend test`** runs the contract test below.
5. Add the new operations to `platform/backend/test/contract/pending-operations.ts` (from PBE-008) with their implementing task, and a row to the change log (§8).

| Command | Does |
|---|---|
| `pnpm contracts:lint` | Redocly lint of this document and the OTA one ([`packages/api-types/README.md`](../../../packages/api-types/README.md#contractslint)) |
| `pnpm contracts:generate` | Regenerates `@velexis/api-types/platform`, the operations index and the `@velexis/errors` catalogue |
| `pnpm contracts:lint && pnpm contracts:generate && git diff --exit-code packages/api-types/src/generated packages/errors/src/generated` | The check of a spec task |
| `pnpm --filter @velexis/platform-backend test -- contract` | The contract test of the document |

### The contract test

[`../test/contract/platform-openapi.contract.test.ts`](../test/contract/platform-openapi.contract.test.ts) reads this document, the OTA document and the inventory:

- `[PBE-005 AC2]` the operations index lists the 24 operations of the PBE-005 slice with their method, path, scope and `internal`, and `PlatformErrorCode` holds `REAUTH_REQUIRED`, `TENANT_KEY_UNAVAILABLE` and `LIVE_PRECONDITIONS_UNMET` (a type annotation and the generated catalogue);
- the slice matches the inventory rows (method, path, scope, `MFA↑`, `Idem`, `F:`), documents `no-store` on exactly the seven secret-bearing answers, and documents the health answers `HealthService` gives;
- the catalogue holds exactly the codes of api-inventory §3 with their statuses, a shared code has the OTA status, and the envelope and `Money` have the OTA shape;
- on **every** operation of the document, so the later slices are held to the same rules: an `x-scope` of the list, `x-internal` on internal and webhook operations, `security: []` where no bearer token applies, `X-Request-Id` on every response, an `x-platform-tables` list, the `IdempotencyKey` parameter exactly on the `x-idempotent` operations, closed request bodies, `no-store` on every 2xx answer with a secret property, error examples whose code and status agree with the catalogue and with `x-error-codes`, and every response example valid for the Ajv checker of `@velexis/testing` that the integration tests use (strict mode, so a misspelt keyword fails).

The slice tests name their operations and never count the document, so later slices only add tests of their own. The lint is covered by `[X-007 AC1]` of `@velexis/api-types`, which lints both documents, and the generated files by `[X-008 AC1]` and `[X-009 AC4]`.

## 7. Lint status

The document lints with **0 errors and 7 warnings**, all expected:

- `no-server-example.com` on `https://api.platform.example.com`: the placeholder host of every platform document until the domains are chosen;
- `operation-4xx-response` on `healthLive`, which has no 4xx answer;
- `no-unused-components` on the parameters `IdempotencyKey`, `Cursor`, `Limit`, `TenantId` and the schema `Page`: shared conventions of PBE-005 that the next slices use (`createTenant`, the tenant lists).

Fix a warning when a task touches that part anyway; never silence one or relax a rule ([`packages/api-types/README.md`](../../../packages/api-types/README.md#the-rules)).

## 8. Change log

Every task that changes the document adds one row, newest last. "Breaking" names the approving ADR, or says "no".

| Task | Milestone | Change | Operations | Breaking |
|---|---|---|---|---|
| PBE-005 | M1 | Created: `info`, server, `portalBearer` and `adminBearer`, the OTA error envelope, `Money`, `Page`, the shared parameters and headers, `x-error-catalogue` (52 codes of api-inventory §3), and the identity, plans and internal slice | 24 | no |
