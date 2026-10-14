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
| M1 tenants, team, keys, reads | PBE-006 | Tenants (api-inventory §7 without `goLive`, 9), team (§8 without `createConsoleToken`, 9), API keys (api-inventory-resources §1, 5), `listDomains`, `listAmadeusConnections`, `listPaymentConnections`, `getSubscription`: 27 | Done |
| M1 admin, part 1 | PBE-007 | Admin auth and dashboard (api-inventory-admin §2, 7), tenants, provisioning jobs and queues (§3, 14): 21 | Done |
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

Notes on the PBE-006 slice:

- **Conditional step-up.** `createApiKey` and `rollApiKey` need a step-up only for a live secret key, and `updateMember` only when it grants `owner` (the inventory's "live secret keys MFA↑" and "granting owner: MFA↑"). `x-mfa-step-up: true` would put `RecentMfaGuard` on every call, so these operations do not carry it: the service checks the case, and the operations list `REAUTH_REQUIRED` and `MFA_REQUIRED` in their errors.
- **Roles** of `portal: owner, admin` rows are not an extension: `TenantRoleGuard` reads them from `memberships/tenant-roles.ts` (PADR-0009 item 5), and each operation's description names them. Non-members get `404 NOT_FOUND`, members with another role `403 FORBIDDEN`.
- `createTenant` already has its M5 shape: `planCode` and `billingInterval` in the request, `checkoutUrl` (always present, `null` before M5) and the optional `checkoutError` in the answer, with an example of each case, so the Ajv example check covers the M5 answers too. It is the only idempotent operation of the slice and also answers `503 SERVICE_UNAVAILABLE` while the idempotency store is down (PBE-009). A malformed key answers `400`; `409 TENANT_KEY_UNAVAILABLE` is for a reserved or used key, as the error catalogue says.
- `checkTenantKey` accepts any key of 1–64 characters, because a key that breaks the rules answers `200` with `reason: invalid`, not `400`.
- `Tenant` has `billingNotice` (`tenants.billing_notice`) in addition to the inventory's fields, because the portal dashboard shows the billing banner to every member (PFE-010) and only owners and finance members may call `getSubscription`. api-inventory §7 lists it.
- `updateApiKey`, `rollApiKey` and `revokeApiKey` answer `409 TENANT_NOT_ACTIVE` too, as `createApiKey` does: [PADR-0014](../../docs/adr/0014-tenant-suspension-and-resume.md) item 5 makes a suspended OTA's keys read-only. api-inventory-resources §1 lists it.
- **Keys shown once.** `revealInitialKeys`, `createApiKey` and `rollApiKey` answer the full key in `key` (schema `ApiKeySecret`) with `NoStore`. The generic secret check of the contract test cannot key on the name `key` (the OTA key of `Tenant` has the same name), so it follows references to `ApiKeySecret` instead, and the slice test also names these three operations.
- **API key scopes** are strings with a light pattern, not an enum: the service validates them against the generated OTA `ConsoleApiKeyScope` and `StaffPermission` types (PADR-0005 item 6), and the contract test checks that every value of both OTA enums matches the pattern.
- Lists that stay short answer `{data}` only, as the inventory says: the caller's OTAs, members and invitations (bounded by the staff seats), API keys, domains and connections. Cursor pagination starts with the admin lists (PBE-007).
- `AmadeusConnection.ticketingDefaults` has the closed shape of the baseline comment, `{ticketingAgreement: {option, delay}, automatedProcess, issue}` with every property optional (an empty object until set), and a `monitoredQueues` item is `{officeId, queueId, category}`. The M4 update (PBE-037) writes them with the same schemas and may only add optional properties.

Notes on the PBE-007 slice:

- **Admin sign-in.** `adminSignIn` always answers an `AdminMfaChallenge` (TOTP on every admin sign-in, PADR-0006 item 2), and an account that is not an active platform admin gets the same `401 INVALID_CREDENTIALS` as a wrong password. `adminVerifyMfa`, `adminRefresh` and `adminStepUp` answer `AdminSession`: the tokens and `admin` (`AdminMe`). Challenges and refresh families never cross the portal and admin surfaces. Only these three sign-in steps are `public` under `/v1/admin/`; every other admin operation is `platform_admin` with the `adminBearer` scheme.
- **`features` in `adminGetMe`.** `AdminMe` (also inside `AdminSession`) carries the `MilestoneFeatures` of `getMe`, because the admin cannot call the portal-scoped `getMe` and the backend is the only source of the switches (PADR-0015 item 3). api-inventory-admin §2 notes the addition.
- **The admin guard.** A token of an account that is no longer an active platform admin answers `401 UNAUTHENTICATED`, like a portal token (`AdminUnauthenticated`, described on `adminBearer` and in api-inventory-admin §1); the admin operations have no `403` for it.
- **Reasons and step-ups.** The four **reason** operations (`adminSuspendTenant`, `adminResumeTenant`, `adminSetConnectionStatus`, `adminCancelProvisioningJob`) carry `x-reason-required: true` and a required body with `reason` (`AdminReason`, 5–500 characters). No operation of §2 and §3 is marked MFA↑, so the slice has no `x-mfa-step-up`; `adminStepUp` is the step-up itself. `adminSuspendTenant` takes `abuse`, `request` or `admin`: `billing` is set by billing sync only (PADR-0014 item 1).
- **Conflicts** name their cause in `details.reason`: `not_active` (suspend), `not_suspended` and `subscription_not_active` (resume), `migrate_job_active` and `schema_missing` (migrate), `not_disabled` (connection status), `not_queued` (cancel); `adminRetryQueueJob` answers `403 FORBIDDEN` with `details.reason = ota_queue`. PBE-030 and PBE-031 answer these values.
- **Dashboard.** The M5 counters are always present and `null` while their switch is off: `domainsPending` (`custom_domains`), `settlementsToReview` (`settlements`), `stripeEventsFailed` (`stripe_billing` or `own_stripe`), `subscriptionsPastDue` (`stripe_billing`). `jobsFailedByQueue` is keyed by the names of `PLATFORM_QUEUES`; its counts come from BullMQ, so the dashboard answers `503 SERVICE_UNAVAILABLE` while Redis is down, as the queue operations do.
- **Tenant detail.** `adminGetTenant` reuses the masked portal shapes (`Member`, `Invitation`, `Subscription`, `AmadeusConnection`, `PaymentConnection`, `Domain`) with `AdminTenant` (the portal `Tenant` without `myRole`, plus `suspendedAt` and the internal `notes` of `tenants.metadata.notes`), `AdminProvisioningJob` (at most 20) and `AuditEntry` (at most 50). `AuditEntry` is also the item of `adminListAudit` (PBE-066); its `id` is a decimal string. `adminSetConnectionStatus` answers `AdminConnection`, a `oneOf` of the two masked connection shapes.
- **Jobs and queues.** `adminMigrateTenant` takes an optional body (`required: false`, as the OTA document does for optional bodies); `targetVersion` has the `TENANT_MIGRATION_VERSION_PATTERN` of `@velexis/api-types/jobs`. `AdminProvisioningJobDetail.result` and `payload` are open objects that never hold a ciphertext; `bullmqState` is a BullMQ state, `unknown` when BullMQ no longer holds the attempt and `null` before the first dispatch. The three queue operations read Redis only and answer `503 SERVICE_UNAVAILABLE` while it is down. `QueueName` is a pattern (`<owner>-<topic>`), not an enum: an unknown queue of that form answers `404`, any other value `400 VALIDATION_FAILED`. `TenantMigrationVersion`, the `suspensionReason` of `adminSuspendTenant` (without `billing`), `ProvisioningJobKind` and `QueueJobId` follow `@velexis/api-types/jobs`, and the contract test compares them.
- **Pagination.** `adminListTenants` and `adminListProvisioningJobs` are the first cursor-paginated lists (`Cursor`, `Limit`, `{data, page: Page}`); `adminListFailedQueueJobs` takes `limit` only and `adminListQueues` neither, as the inventory says.
- **Tables.** Every admin action that changes state writes `platform_audit_log` (api-inventory-admin §1), so `x-platform-tables` lists it on every writing operation of §3, also where the inventory's Tables cell names only the changed tables. Of the sign-in steps of §2, `adminSignIn` and `adminVerifyMfa` audit, as the inventory says; `adminRefresh`, `adminStepUp` and `adminSignOut` change only the admin's own session rows and, like the portal's `refreshSession`, `stepUp` and `signOut`, list no audit table. The queue reads list no table.

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
- `[PBE-006 AC1]` the operations index lists the 27 operations of the PBE-006 slice with their method, path and scope, none of them in the PBE-005 slice, and they match the inventory rows (method, path, scope, `Idem`, `F:`, unconditional and conditional `MFA↑`);
- `[PBE-006 AC2]` `createTenant` is the slice's only `x-idempotent` operation, and exactly `revealInitialKeys`, `createApiKey` and `rollApiKey` answer a `key` with `no-store`;
- `[PBE-006 AC3]` no response schema of the slice, and no property of the generated `@velexis/api-types/platform`, has a name ending in `Ciphertext` or `Hash` (in any case); the response checker refuses an API key answer with a `keyHash`;
- the eleven shared schemas of PBE-006 step 4 exist, are closed, and have no property ending in `secret`, `ciphertext`, `hash`, `password` or `token`;
- the API key scope pattern accepts every OTA `ConsoleApiKeyScope` and `StaffPermission`, and the onboarding item ids are those of PADR-0018 in its order;
- `[PBE-007 AC1]` the operations index lists the 21 operations of the PBE-007 slice with their method, path and scope, none of them in an earlier slice, and they match the rows of api-inventory-admin §2 and §3 (method, path, `(public)`, **reason**, MFA↑);
- `[PBE-007 AC2]` every `/v1/admin/` operation is `platform_admin` with `adminBearer`, except `adminSignIn`, `adminVerifyMfa` and `adminRefresh`, and every `platform_admin` operation lives under `/v1/admin/`;
- `[PBE-007 AC3]` exactly `adminSuspendTenant`, `adminResumeTenant`, `adminSetConnectionStatus` and `adminCancelProvisioningJob` of the slice carry `x-reason-required`, and the Ajv checker refuses their bodies without a reason, with 4 or 501 characters, and accepts 5 and 500;
- `adminGetMe` and `AdminSession.admin` answer the `features` of `getMe` (and the inventory says so), exactly the four admin token answers document `no-store`, the dashboard keeps its M5 counters required and nullable, no response of the slice has a property ending in `Secret`, `Ciphertext` or `Hash`, the queue examples use the names of `@velexis/api-types/jobs`, and the migration version pattern, the admin suspension reasons, the job kinds and the BullMQ job id of a tenant job agree with `@velexis/api-types/jobs`;
- the catalogue holds exactly the codes of api-inventory §3 with their statuses, a shared code has the OTA status, and the envelope and `Money` have the OTA shape;
- on **every** operation of the document, so the later slices are held to the same rules: an `x-scope` of the list, `x-internal` on internal and webhook operations, `security: []` where no bearer token applies, `adminBearer` on `platform_admin` and `portalBearer` on portal operations, a required `reason` (`AdminReason`) exactly on the `x-reason-required` operations, `REAUTH_REQUIRED` on every `x-mfa-step-up` operation, `X-Request-Id` on every response, an `x-platform-tables` list, the `IdempotencyKey` parameter exactly on the `x-idempotent` operations, closed request bodies, `no-store` on every 2xx answer with a secret property or a reference to `ApiKeySecret` (a key shown once is answered as `key`, a name it shares with the OTA key of `Tenant`), error examples whose code and status agree with the catalogue and with `x-error-codes`, and every response example valid for the Ajv checker of `@velexis/testing` that the integration tests use (strict mode, so a misspelt keyword fails).

The slice tests name their operations and never count the document, so later slices only add tests of their own. The lint is covered by `[X-007 AC1]` of `@velexis/api-types`, which lints both documents, and the generated files by `[X-008 AC1]` and `[X-009 AC4]`.

## 7. Lint status

The document lints with **0 errors and 2 warnings**, both expected:

- `no-server-example.com` on `https://api.platform.example.com`: the placeholder host of every platform document until the domains are chosen;
- `operation-4xx-response` on `healthLive`, which has no 4xx answer.

PBE-006 brought `IdempotencyKey` and `TenantId` into use, and the paginated admin lists of PBE-007 the shared `Cursor`, `Limit` and `Page` of PBE-005, so no component is unused.

Fix a warning when a task touches that part anyway; never silence one or relax a rule ([`packages/api-types/README.md`](../../../packages/api-types/README.md#the-rules)).

## 8. Change log

Every task that changes the document adds one row, newest last. "Breaking" names the approving ADR, or says "no".

| Task | Milestone | Change | Operations | Breaking |
|---|---|---|---|---|
| PBE-005 | M1 | Created: `info`, server, `portalBearer` and `adminBearer`, the OTA error envelope, `Money`, `Page`, the shared parameters and headers, `x-error-catalogue` (52 codes of api-inventory §3), and the identity, plans and internal slice | 24 | no |
| PBE-006 | M1 | Tenants and lifecycle, team and invitations, API keys, and the M1 reads of domains, connections and the subscription; tags `Tenants`, `Team`, `API keys`, `Domains`, `Connections`, `Billing`; parameters `MemberId`, `InvitationId`, `ApiKeyId`; shared error responses of tenant resources | 27 | no |
| PBE-007 | M1 | Admin auth and dashboard, admin tenants (suspend, resume, migrate, connection status), provisioning jobs and queues; tags `Admin auth`, `Admin dashboard`, `Admin tenants`, `Admin provisioning jobs`, `Admin queues`; parameters `AdminTenantId`, `ProvisioningJobId`, `QueueName`, `QueueJobId`; response `AdminUnauthenticated`; shared `AdminReason`, `AuditEntry` and `AdminProvisioningJob`; `adminBearer` and `info` describe the admin guard's `401`; `ServiceUnavailable` also names the BullMQ queues | 21 | no |
