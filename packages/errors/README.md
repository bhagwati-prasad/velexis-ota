# `@velexis/errors`

One error model for both Velexis APIs ([conventions §6](../../docs/mvp/conventions.md#6-error-model)). The package holds three things:

- the **error catalogue**, generated from the `x-error-catalogue` of the OTA and platform OpenAPI documents;
- **`AppError`**, which only takes a code of that catalogue;
- **`toErrorEnvelope`**, which turns any thrown value into the error envelope of the API.

The documents are the source of truth ([ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md), Checks in CI). A new code is added to its document first, then `pnpm contracts:generate` regenerates the catalogue, so code can only throw codes that a document lists.

The package is pure TypeScript with no NestJS dependency. Each backend wraps it in its own exception filter (OBE-010, PBE-008), and the Next.js apps map the codes to user-facing text.

Related: [`packages/README.md`](../README.md#velexiserrors) (public API sketch), [`@velexis/api-types`](../api-types/README.md) (the contract types and the other generator of `pnpm contracts:generate`), [`ota/backend/openapi/README.md`](../../ota/backend/openapi/README.md) (how to change the OTA document).

## Usage

```ts
import { AppError, isAppError, toErrorEnvelope, httpStatusFor, type ErrorCode } from "@velexis/errors";

throw new AppError("PRICE_CHANGED", { details: { newPrice } });          // status 409 from the catalogue
throw new AppError("VALIDATION_FAILED", {
  fieldErrors: [{ path: "/email", code: "format", message: "Enter a valid e-mail address." }],
});
throw new AppError("SUPPLIER_REJECTED", { supplier, details: { errors }, cause: err }); // cause: logs only
new AppError("NOT_A_CODE");                                               // does not compile

// In the exception filter of a backend:
const { status, body } = toErrorEnvelope(err, requestId, { exposeSupplier: isConsoleScope });
response.status(status).json(body);  // { error: { code, message, status, requestId, details?, fieldErrors?, supplier? } }
```

| Export | What it is |
|---|---|
| `AppError<C>` | `new AppError(code, { message?, details?, fieldErrors?, supplier?, cause? })`. `code` must be an `ErrorCode`. `status` comes from the catalogue. `message` defaults to the catalogue description. `cause` stays on the error for the logs. A code from outside the catalogue (a JavaScript caller, a cast) throws a `TypeError`. |
| `toErrorEnvelope(err, requestId, { exposeSupplier })` | Returns `{ status, body: { error: { … } } }` for any thrown value (below) |
| `isAppError(value)`, `isErrorCode(value)`, `httpStatusFor(code)` | Type guards and the status of a code |
| `FIELD_ERROR_CODES`, `isFieldErrorCode(code)`, `FieldErrorCode` | The codes whose envelope may carry `fieldErrors` (below) |
| `ERROR_CATALOGUE` | Frozen map from code to `{ status, description, source }`. `source` is `"ota"` for every code of the OTA catalogue and `"platform"` for a code only the platform catalogue lists. |
| `ErrorCode`, `OtaErrorCode`, `PlatformErrorCode` | The unions of the codes: both catalogues, the OTA catalogue, and the platform catalogue (`never` until the platform document exists) |
| `OTA_ERROR_CODES`, `PLATFORM_ERROR_CODES` | The codes of each catalogue, frozen, in document order |
| `ErrorCatalogueEntry`, `ErrorSource` | The types of the catalogue entries |
| `ErrorResponse`, `ErrorBody`, `FieldError`, `SupplierIssue`, `ErrorEnvelope`, `ErrorEnvelopeOptions` | The envelope types. The first four are the `ErrorResponse`, `Error`, `FieldError` and `SupplierIssue` schemas of the OTA document, from `@velexis/api-types`. |

## The envelope

`toErrorEnvelope(err, requestId, { exposeSupplier })` builds the answer the way conventions §6 says. The body matches the `ErrorResponse` schema of the OTA document (a test validates it with Ajv). The platform document uses the same envelope (PBE-005).

- **An `AppError`** gives its catalogue status and `{ code, message, status, requestId }`, plus:
  - `details`, when it has them (copied);
  - `fieldErrors`, only for a code of `FIELD_ERROR_CODES`, and with only `path`, `code` and `message`;
  - `supplier`, only when `exposeSupplier` is true (console scope), and with only the fields of the `SupplierIssue` schema that have its types (a `status` or `code` that is not an integer is left out).
- **Anything else** gives `500 INTERNAL_ERROR` with the catalogue's generic message ("Unexpected error; quote the requestId to support.") and the `requestId`. This covers a `TypeError`, a string, an object that only looks like an error, or an `AppError` lookalike with an unknown code. Nothing of the thrown value is used.
- **The body never holds a stack trace or a `cause`.** The exception filter logs unknown errors with their stack ([ADR-0016](../../docs/mvp/adr/0016-observability.md)); the client only gets the `requestId`.
- Messages are safe to show and never echo a rejected value, which may be a card number or a password. This holds for the `message` of an `AppError` and for every `fieldErrors[].message`. The copies drop any extra field, such as a careless `value`.

### Which codes carry `fieldErrors`

`FIELD_ERROR_CODES` lists them:

- `VALIDATION_FAILED`: request validation (conventions §6);
- `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID`, `CHECKOUT_INCOMPLETE`: traveller, contact and checkout data;
- `EMAIL_ALREADY_REGISTERED`, `PASSWORD_TOO_WEAK`, `CURRENT_PASSWORD_INCORRECT`: the customer account checks.

These are exactly the codes that the OTA document's response examples answer with `fieldErrors`. The SDK contract documents them too ([`bookings.d.ts`](../../docs/velexis-sdk/sdk/src/bookings.d.ts): `TRAVELER_DATA_INVALID` with `fieldErrors[]`). A test compares the list with the examples of both documents. The plan of X-009 says "`fieldErrors` appear only with `VALIDATION_FAILED`", but the contract wins over the plan (ADR-0006), so the list follows the contract.

`new AppError(code, { fieldErrors })` does not compile when `code` is another literal code. A `code` typed as the whole `ErrorCode` union (or a cast) gets past the compiler, so `toErrorEnvelope` also drops them at run time for every other code. A new code with field errors gets an example with `fieldErrors` in its document and an entry in this list, in the same change.

## The generator (`pnpm contracts:generate`)

`node scripts/generate.mjs [--root <repository root>] [--out <dir>]` writes `src/generated/catalogue.ts`. The root `pnpm contracts:generate` (`turbo run generate`) runs it together with the generator of `@velexis/api-types`. Both parse the YAML documents directly; this one does not read the generated types. `pnpm build` and `pnpm typecheck` run `generate` first (`turbo.json`).

1. It reads `x-error-catalogue` from `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`. These are the locations [ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md) fixes, the same as the `apis` of [`packages/api-types/redocly.yaml`](../api-types/redocly.yaml).
2. It also reads `x-error-catalogue` from `platform/backend/openapi/velexis-platform-api.openapi.yaml` once that document exists. The platform plan creates it in M1 (PBE-005). Until then the script prints a notice, `PlatformErrorCode` is `never`, and `PLATFORM_ERROR_CODES` is empty.
3. It checks every entry:
   - the code matches `^[A-Z][A-Z0-9_]+$`, the `code` pattern of the `Error` schema;
   - `status` is an integer from 400 to 599;
   - `description` is a non-empty string.

   A missing or empty catalogue fails, and so does a platform document without one. A code listed twice fails, because the YAML parser refuses duplicate keys.
4. It merges the two catalogues: the OTA codes first, then the platform-only codes, each in document order. A code in both documents keeps the OTA entry, since the platform API reuses the OTA codes. **Generation fails when one code has different HTTP statuses in the two documents**, and the message names every conflicting code.
5. On any failure it exits 1 and writes nothing. Otherwise it rewrites `catalogue.ts` only when its content changed, and prints `wrote` or `unchanged`.

The output is deterministic: no timestamps, no absolute paths, document order. The file starts with `// Generated by scripts/generate.mjs — do not edit` and the source lines. Prettier and ESLint skip `src/generated/` ([`.prettierignore`](../../.prettierignore), [`eslint.config.mjs`](../../eslint.config.mjs)), so the committed file is byte for byte the generator's output. CI runs `pnpm contracts:generate` again and fails when `git diff --exit-code -- packages/api-types packages/errors` is not empty.

`--root` generates from another copy of the repository layout, and `--out` writes elsewhere than `src/generated/`. The tests use both, so they never touch the committed file.

## Commands

| Command | Does |
|---|---|
| `pnpm contracts:generate` | From the repository root: regenerate this package's catalogue and the types of `@velexis/api-types` (Turborepo, cached on both `openapi/` folders) |
| `pnpm --filter @velexis/errors generate` | `node scripts/generate.mjs` without Turborepo and its cache |
| `pnpm --filter @velexis/errors build` | `tsc -b` to `dist/` (CommonJS and `.d.ts`). It builds `@velexis/api-types` first (project reference). |
| `pnpm --filter @velexis/errors test` | Unit tests (Vitest), below |
| `pnpm --filter @velexis/errors typecheck` / `lint` | `tsc --noEmit` / ESLint |

## Tests

- [`src/app-error.test.ts`](src/app-error.test.ts):
  - `[X-009 AC1]` every code of the documents' catalogues is in `ERROR_CATALOGUE` with its status and description, in document order, and `new AppError(code)` and `httpStatusFor(code)` give that status;
  - `[X-009 AC1]` `new AppError("NOT_A_CODE")` does not compile. This is a `// @ts-expect-error` (checked by `tsc` in `typecheck` and `build`), and the same snippet compiled in the test with the TypeScript compiler API (`TS2345`);
  - `fieldErrors` only compile for `FIELD_ERROR_CODES` (`TS2322`);
  - also: defaults and options, the `cause` kept for the logs, codes from outside the catalogue refused at run time (`toString` and `__proto__` included), the type guards, and frozen exports.
- [`src/envelope.test.ts`](src/envelope.test.ts):
  - `[X-009 AC2]` envelopes from `AppError`s validate with Ajv 2020 and `ajv-formats` against the OTA document's `ErrorResponse` schema and every schema it references, taken verbatim from the document. This covers one envelope with every optional field and one per catalogue code. No body has a field outside the `Error` schema;
  - `[X-009 AC3]` a thrown `TypeError` becomes status 500, `INTERNAL_ERROR`, with the given `requestId` and no stack, error name or message in the body;
  - other thrown values become 500 too. The status always comes from the catalogue, even for a tampered `AppError`. Neither the `cause` nor the stack of an `AppError` is returned. `fieldErrors` appear only for `FIELD_ERROR_CODES` and lose extra fields. `supplier` appears only with `exposeSupplier`. `FIELD_ERROR_CODES` equals the codes of the documents' examples with `fieldErrors`.
- [`src/generate.test.ts`](src/generate.test.ts) runs the generator as a child process, into scratch folders in the system temporary folder that are removed after the run:
  - `[X-009 AC4]` two runs on the repository give byte-identical files, equal to the committed `catalogue.ts`, with no timestamp or local path. A third run reports `unchanged`;
  - a code with different statuses in the two documents fails, names every conflict, and writes nothing;
  - with a platform document (in a scratch copy), shared codes keep the OTA entry and platform-only codes join `ErrorCode`. Without one, `PlatformErrorCode` is `never`. Both outputs compile under the repository's strict options;
  - every malformed input listed above fails and writes nothing.

The tests read both `openapi/` folders, so `turbo.json` gives this package's `test` task those folders as inputs (`@velexis/errors#test`), as it does for `@velexis/api-types`. A changed document reruns them instead of replaying a cached pass.

## Dependencies

| Package | Version | Kind | Used by |
|---|---|---|---|
| `@velexis/api-types` | `workspace:*` | dependency | The envelope types (`ErrorResponse`, `Error`, `FieldError`, `SupplierIssue`); type imports only, nothing at run time |
| `yaml` | 2.9.1 | dev | The generator parses the documents; the tests read them |
| `ajv`, `ajv-formats` | 8.20.0, 3.0.1 | dev | The tests validate envelopes against the `ErrorResponse` schema, as the backends' response checks will ([`tech-stack.md`](../../docs/mvp/tech-stack.md) §2) |
| `typescript`, `@types/node`, `vitest` | 5.6.3, 22.20.5, 3.2.7 | dev | Typecheck, build and tests, as in the other packages. The tests also use the TypeScript compiler API. |

`dist/` has no runtime dependency: the catalogue is plain data, and the types of `@velexis/api-types` are erased.
