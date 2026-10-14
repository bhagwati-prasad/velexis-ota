# Foundation agent tasks (`X-`)

This plan lists the cross-cutting **foundation** tasks of the Velexis MVP as small, self-contained tasks for AI coding agents:

- the monorepo bootstrap and the shared packages;
- the contract generation pipeline and the database baseline migrations with the migration runner;
- the reference data loader, CI and local development;
- VM provisioning, Caddy, systemd, users per trust zone, the release and deploy pipeline, backups, monitoring and the restore drill;
- the Amadeus stub and its fixture recording, plan progress reporting, and the PCI DSS controls of the VM (SSH MFA, off-VM security logs, a web application firewall, master-key rotation).

Most of it is milestone **M0 Foundations**, which ends with a hello-world deploy on the single VM. A few tasks land later, when a milestone first needs them. Each task block follows the format of [ADR-0020](../adr/0020-ai-agent-development-workflow.md) and is validated by `node tools/plan-lint/plan-lint.mjs docs/mvp/plans/foundation-tasks.md`.

Related: [`../decisions.md`](../decisions.md) (binding), [`../architecture.md`](../architecture.md), [`../tech-stack.md`](../tech-stack.md), [`../conventions.md`](../conventions.md), [`../deployment-single-vm.md`](../deployment-single-vm.md), [`../local-development.md`](../local-development.md), [`../../../packages/README.md`](../../../packages/README.md), [`../../../deploy/README.md`](../../../deploy/README.md), [`../../../AGENTS.md`](../../../AGENTS.md). Decisions taken while writing this plan: [ADR-0021](../adr/0021-migration-cli-and-repeatable-grants.md) (migration CLI and repeatable grants), [ADR-0022](../adr/0022-shared-test-support-package.md) (`@velexis/testing`), [ADR-0023](../adr/0023-release-artefact-and-deploy-user.md) (release artefact and deploy user), [ADR-0024](../adr/0024-reference-data-sources-and-loader.md) (reference data), and from the planning review [ADR-0026](../adr/0026-system-users-per-trust-zone.md) (system users per trust zone) and [ADR-0027](../adr/0027-pci-scope-and-vm-controls.md) (PCI scope and VM controls).

## How to use this plan

- Pick tasks as [`AGENTS.md`](../../../AGENTS.md) §3 says: lowest milestone first, all **Depends on** merged, not claimed, critical path first.
- A task's **Status** line moves from `todo` to `in progress (PR #n)` to `done (PR #n)` in the task's own pull request. In the PR's last commit the heading also gets ` ✅` at the end (`### X-012 · Title ✅`), so the task counts as done on `main` from the merge on. This is the one status rule of all three task files ([ADR-0025](../adr/0025-roadmap-scheduling-and-tracking.md) item 6, [`AGENTS.md`](../../../AGENTS.md) §4).
- **Human step** in a task means a step only the developer can do: an action on a VM (including a throwaway test VM), a GitHub setting, or a secret. Agents have no VM access. The agent prepares everything else, makes as much as possible testable in CI (the `ubuntu-24.04` runner has `sudo` and systemd), and lists the human step in the PR under "Questions and follow-ups". Human steps count against the developer's non-task hours and the milestone buffer.
- A task that adds a variable to a `deploy/env/*.env.example` template lists a human step: add the variable to `/etc/velexis/<app>.env` before the next deploy (`velexis-deploy` refuses the release otherwise).
- Root config files (`package.json`, `turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.nvmrc`, `.env.example`, `pnpm-workspace.yaml`) and the `deploy/` templates already exist. Tasks finalise and test them; they do not start over.
- Plans of the components may depend on these ids. The table below says which task provides what.

## Milestone outcomes

| Milestone | Foundation tasks | Demonstrable at the end |
|---|---|---|
| **M0** Foundations | X-001 to X-023, X-033 | `pnpm install && pnpm build && pnpm test` is green in CI. `pnpm db:migrate` creates the platform and reference baselines locally. A tenant schema can be created with `migrate.js tenant --create`. The reference data is loaded. The VM is provisioned with one system user per trust zone. The **Deploy** workflow puts the hello-world release on it: `https://platform.example.com/` answers over TLS, and `velexis-deploy --status` shows the release. |
| **M1** Platform core | X-024 to X-027, X-035 | Nightly encrypted backups reach the off-site bucket. Integration tests assert e-mails through Mailpit. `pnpm stub:amadeus` serves token and flight-offers search, and tests start the stub in-process (PBE-020 and the M1 end-to-end harness use it). plan-lint reports the remaining work. |
| **M2** Search & price | X-034, X-036 | Fixtures are recorded from the Amadeus test environment with scrubbing, and a scan keeps personal data out of them. The second-agent review procedure is ready for M3. |
| **M3** Book & pay | X-028 | Signed Stripe webhook fixtures in tests; Stripe CLI forwarding for manual checks. |
| **M6** Hardening & launch | X-029 to X-032, X-037 to X-040 | Uptime monitor and on-VM health checks alert. The restore drill is documented with a measured RTO and cannot reach live services. The move to managed services is proven to be configuration only. SSH needs a second factor, security logs are kept 12 months off the VM with a daily review, the WAF protects the public hosts, and the master key can be rotated. |

## What the component plans can depend on

| Need | Task |
|---|---|
| Typed config in an app (`src/config.ts`) | X-002 |
| Logger, `pinoHttpOptions`, redaction, `redactPayload` | X-003 |
| Envelope encryption, key providers | X-004 |
| API key hashing, tokens, signed URLs, `newId` | X-005 |
| OTA OpenAPI document at `ota/backend/openapi/` | X-006 |
| `contracts:lint` | X-007 |
| `@velexis/api-types` (OTA, platform, operations index, job envelope) | X-008 |
| `@velexis/errors`, `AppError` | X-009 |
| `createPool`, `platformDb`, `tenantTx`, `StorageAdapter` | X-010 |
| Migration runner and CLI (platform, reference) | X-011 |
| Baselines `0001` and `R__ota_read_access.sql` (the platform `0002` deltas build on them) | X-012 |
| Tenant fan-out, `migrateTenantSchema` for provisioning | X-013 |
| Generated Kysely table types | X-014 |
| Integration test harness (`@velexis/testing`) | X-015 |
| Local roles, keys, Mailpit setup | X-016 |
| Reference data in the database | X-018 |
| CI with PostgreSQL, Redis and Mailpit | X-019 |
| Running VM, systemd units, Caddy | X-020, X-021, X-022 |
| Deploy pipeline (apps join it by existing) | X-023 |
| Mailpit, Amadeus stub and Stripe test helpers | X-025, X-026, X-027, X-028 |
| Amadeus fixture recording (`record`) and the fixture scan | X-034 |
| Users per trust zone, per-zone key folders, `velexis-run` | X-033 |
| Shared re-wrap helper for master-key rotation | X-040 |

## M0 Foundations

### X-001 · Verify the monorepo bootstrap and commit the lockfile ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** —
- **Size:** S
- **Read first:** AGENTS.md §10; docs/mvp/adr/0002-monorepo-pnpm-turborepo.md; docs/mvp/tech-stack.md §1 and §2; package.json; turbo.json; eslint.config.mjs; tsconfig.base.json
- **Files:** `package.json`, `vitest.workspace.ts`, `AGENTS.md`, `README.md`
- **Steps:**
  1. With Node 22 (`nvm use`) and `corepack enable`, run `pnpm install`. Commit the generated `pnpm-lock.yaml` together with this task: the lockfile is always allowed.
  2. Create `vitest.workspace.ts` (Vitest 3, `defineWorkspace` from `vitest/config`). It lists the globs `packages/*/vitest.config.ts`, `platform/*/vitest.config.ts`, `ota/*/vitest.config.ts` and `tools/*/vitest.config.ts`, so editors can run any test file. CI keeps running tests per package through Turborepo.
  3. Run every root script on the still-empty workspace: `build`, `lint`, `typecheck`, `test`, `format:check`, `plan:lint`. Fix only root configuration problems; do not create packages. Turborepo must report that there are no tasks, not fail.
  4. Check that ESLint loads the shared config with `pnpm exec eslint --print-config eslint.config.mjs`. Check that Prettier ignores `docs/velexis-sdk/` and Markdown: `pnpm exec prettier --check .`.
  5. If a script name in `package.json` differs from the cheat sheet in `AGENTS.md` §10, fix the table, because `package.json` wins. Keep the "Status" line of `README.md` as it is.
- **Acceptance:**
  - `pnpm install --frozen-lockfile` succeeds on a clean clone with Node 22 and pnpm 9.15.9.
  - `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm format:check` exit 0 on the empty workspace.
  - `node tools/plan-lint/plan-lint.mjs` exits 0.
  - The lockfile contains only the root devDependencies listed in `docs/mvp/tech-stack.md`, all with exact versions.
- **Verify:** `pnpm install --frozen-lockfile && pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check && pnpm plan:lint`

### X-002 · Create @velexis/config with typed environment and key-file validation ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-001
- **Size:** M
- **Read first:** packages/README.md (rules and `@velexis/config`); docs/mvp/conventions.md §8; docs/mvp/adr/0010-secrets-envelope-encryption.md (Key material on the VM); docs/mvp/architecture.md §6; .env.example
- **Files:** `packages/config/package.json`, `packages/config/tsconfig.json`, `packages/config/vitest.config.ts`, `packages/config/src/index.ts`, `packages/config/src/env.ts`, `packages/config/src/define-config.ts`, `packages/config/src/dev-env-files.ts`, `packages/config/src/key-files.ts`, `packages/config/src/define-config.test.ts`, `packages/config/src/key-files.test.ts`, `packages/config/src/dev-env-files.test.ts`, `packages/config/README.md`
- **Steps:**
  1. Scaffold the package by the rules of `packages/README.md`:
     - `"private": true`, CommonJS output through `tsc -b` with `composite: true`, an `exports` map;
     - scripts `build`, `typecheck`, `lint`, `test`, `clean`;
     - exact devDependencies `typescript` 5.6.3, `vitest` 3.2.7, `@types/node` 22.x.
  2. Write the builders in `src/env.ts`: `string({ pattern, default, optional })`, `int({ min, max })`, `port()`, `bool()` (only `true`, `false`, `1`, `0`), `url({ protocols })`, `enum(values)`, `dir()`, `secretFile({ minBytes })`, `list()`. The types are inferred: `optional` gives `T | undefined`, `default` gives `T`.
  3. Write `defineConfig(schema, source = process.env)` in `src/define-config.ts`. It validates every entry and collects all problems. It throws one `ConfigError` that names each variable and the reason, **never the value**. It returns a deep-frozen object. This is the only file in the repository allowed to read `process.env`.
  4. Write `loadDevEnvFiles({ appDir, rootDir })` in `src/dev-env-files.ts`, using Node 22 `util.parseEnv`:
     - it reads `<appDir>/.env.local`, then `<rootDir>/.env.local`, and sets only variables that are still unset, so the real environment wins, then the app file, then the root file;
     - it does nothing and logs nothing when `APP_ENV` or `NODE_ENV` is `production`;
     - `rootDir` defaults to the folder that holds `pnpm-workspace.yaml`.
  5. Write `readKeyFile(path, { minBytes, encoding: "base64" | "pem" })` in `src/key-files.ts`. It throws when the file is missing, is readable by group or others (`mode & 0o077`), or is shorter than `minBytes` after decoding. `env.secretFile` uses it.
  6. Write the tests named below, and a README with a usage example.
- **Acceptance:**
  - `defineConfig` with three invalid variables throws a single `ConfigError` whose message names all three and contains none of their values.
  - Type tests (`expectTypeOf`) show that an `optional` string is `string | undefined`, an `int` with `default` is `number`, and an `enum` is the literal union.
  - `secretFile` rejects a missing file, a file with mode 0644, and a file shorter than `minBytes`; it accepts a 0400 file.
  - The precedence of `loadDevEnvFiles` is environment, then app file, then root file; with `APP_ENV=production` it reads no file.
  - `pnpm lint` passes with `n/no-process-env` active for every package except this one.
- **Verify:** `pnpm --filter @velexis/config build && pnpm --filter @velexis/config test && pnpm --filter @velexis/config lint`

### X-003 · Create @velexis/logger with the central redaction list ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-001
- **Size:** M
- **Read first:** docs/mvp/adr/0016-observability.md (Logs); docs/mvp/conventions.md §7; docs/mvp/adr/0011-payments-stripe-and-airline-card.md §C; docs/velexis-sdk/db/README.md §8; packages/README.md (`@velexis/logger`)
- **Files:** `packages/logger/package.json`, `packages/logger/tsconfig.json`, `packages/logger/vitest.config.ts`, `packages/logger/src/index.ts`, `packages/logger/src/create-logger.ts`, `packages/logger/src/redact-paths.ts`, `packages/logger/src/http.ts`, `packages/logger/src/redact-payload.ts`, `packages/logger/src/mask.ts`, `packages/logger/src/redaction.test.ts`, `packages/logger/src/redact-payload.test.ts`, `packages/logger/src/http.test.ts`, `packages/logger/README.md`
- **Steps:**
  1. Scaffold the package. Dependencies: `pino` 9.x and `pino-http` 10.x, with exact versions. `nestjs-pino` stays in the apps.
  2. Write `REDACT_PATHS` in `src/redact-paths.ts` from the ADR-0016 list. Spell out every depth that pino needs:
     - top level and `*.` for `password`, `newPassword`, `currentPassword`, `mfaCode`, `accessToken`, `refreshToken`, `portalToken`, `bookingToken`, `token`, `clientSecret`, `secret`, `apiKey`, `securityCode`, `cvc`, `cardNumber`, `certificateNumber`;
     - `*.card.number`, `*.creditCard.number`, `*.documents[*].number`;
     - the whole `card`, `creditCard` and `formOfPayments` objects at the top level and at every nesting depth up to six levels (`card`, `*.card`, `*.*.card`, … and the same for `creditCard` and `formOfPayments`), because pino paths are not recursive and Amadeus-shaped bodies nest deeply (`err.cause.body.data.formOfPayments[0].creditCard`);
     - `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, `req.headers["x-api-key"]`, `req.headers["x-csrf-token"]`, `req.headers["x-booking-token"]`, `req.headers["x-velexis-edge"]`.

     The censor is `[REDACTED]`.
  3. Write `createLogger({ app, env, level })` with base fields `app` and `env`, ISO timestamps, an `err` serializer that keeps type, message, stack and `code` (for each `cause` in the chain as well) and **drops** `body`, `data`, `request`, `response`, `config` and `headers` properties, so a supplier error never carries a request or response body into a log line, and the redaction list.
  4. Write `pinoHttpOptions({ app, logger })` in `src/http.ts`:
     - `genReqId` keeps a valid `X-Request-Id` (`^[A-Za-z0-9._-]{8,128}$`, as in the Caddyfile), otherwise it uses `crypto.randomUUID()`, and sets the response header;
     - one line per request with method, route template, status and `durationMs`;
     - no headers or bodies in the serializers;
     - `/health/*` is not logged.
  5. Write `redactPayload(value)` in `src/redact-payload.ts`, the shared redactor for persisted payload copies (db README §8). It returns a deep copy and never mutates its input:
     - card `number` fields are replaced by their last 4 digits;
     - `securityCode`, `cvc` and `cvv` are dropped;
     - password, token, secret and apiKey keys become `[REDACTED]`;
     - arrays are handled and cycles do not loop.

     Write `maskPan(pan)` in `src/mask.ts`, which keeps BIN and last 4 (ADR-0011).
  6. Write the tests below, using the test PAN `4111111111111111`, the password `Hunter2!` and a bearer token.
- **Acceptance:**
  - A log line produced through `pinoHttpOptions` for a request whose headers and body contain the test PAN, the password and a bearer token contains none of them (`redaction.test.ts`).
  - Logging an error whose `cause` carries a nested Amadeus Flight Create Orders body (`data.formOfPayments[0].creditCard` with the test PAN and CVV `123`) through `createLogger` produces a line without the PAN, the last 12 digits of the PAN, or the CVV; the same holds for a plain object logged at depths 1 to 6 (`redaction.test.ts`).
  - `redactPayload` on an Amadeus-shaped `formOfPayments[0].creditCard` object keeps `1111` as the number, removes `securityCode`, and leaves the input unchanged.
  - A valid incoming `X-Request-Id` is reused; an invalid one (`<script>`) is replaced by a UUID.
  - The README states the rule "a new sensitive field = a new path here plus a test".
- **Verify:** `pnpm --filter @velexis/logger build && pnpm --filter @velexis/logger test`

### X-004 · Create @velexis/crypto with envelope encryption and key providers ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-001
- **Size:** M
- **Read first:** docs/mvp/adr/0010-secrets-envelope-encryption.md (whole); packages/README.md (`@velexis/crypto`); docs/velexis-sdk/db/README.md §8
- **Files:** `packages/crypto/package.json`, `packages/crypto/tsconfig.json`, `packages/crypto/vitest.config.ts`, `packages/crypto/src/index.ts`, `packages/crypto/src/envelope.ts`, `packages/crypto/src/key-provider.ts`, `packages/crypto/src/local-file-key-provider.ts`, `packages/crypto/src/aad.ts`, `packages/crypto/src/envelope.test.ts`, `packages/crypto/src/local-file-key-provider.test.ts`, `packages/crypto/README.md`
- **Steps:**
  1. Scaffold the package. It has no runtime dependency other than Node `crypto`.
  2. Define `KeyProvider` (`currentKekId()`, `wrap(dek)`, `unwrap(wrapped, kekId)`) in `src/key-provider.ts`.
  3. Write `LocalFileKeyProvider.fromDir(dir, current)` in `src/local-file-key-provider.ts`:
     - it loads every `master-v<N>.key` in the folder (base64, exactly 32 bytes after decoding) as KEK id `local:v<N>`;
     - it fails when `current` (for example `local:v1`) has no file;
     - it refuses files readable by group or others.
  4. Write `encryptValue(plaintext, { aad, keys })` in `src/envelope.ts`:
     - a fresh 32-byte data key per value, used with AES-256-GCM (12-byte IV, 16-byte tag);
     - the data key is wrapped with the current KEK;
     - the output follows the ADR-0010 format: `0x01 | kekId length + kekId | wrapped DEK (iv, tag, ct) | iv | tag | ciphertext`;
     - it returns `{ ciphertext: Buffer, kekId }`.

     Also write `decryptValue(ciphertext, { aad, keys })`, and `rewrapValue(ciphertext, { keys })`, which re-wraps only the data key under the current KEK.
  5. Write `aadFor(schema, table, column, rowId)` in `src/aad.ts`, giving `"<schema>.<table>.<column>:<rowId>"`. Decryption errors throw `DecryptionError` with no detail about the cause.
  6. Write the tests below and a README that covers the rotation procedure of ADR-0010.
- **Acceptance:**
  - Round trip works. The same plaintext encrypted twice gives different ciphertexts.
  - Decryption fails with a different AAD, with any single flipped byte, and with a wrapped key from another KEK.
  - A value encrypted under `local:v1` decrypts after `current` becomes `local:v2`. `rewrapValue` moves it to `local:v2` without changing the plaintext.
  - `package.json` lists no third-party crypto library.
- **Verify:** `pnpm --filter @velexis/crypto build && pnpm --filter @velexis/crypto test`

### X-005 · Add token, hashing, signed-URL and id helpers to @velexis/crypto ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-004
- **Size:** S
- **Read first:** platform/docs/adr/0005-api-key-format-and-hashing.md; docs/mvp/adr/0017-email-documents-storage.md (Signed URLs); docs/velexis-sdk/db/README.md §2.1 (ids); docs/mvp/adr/0008-identity-accounts-customers-sessions.md (tokens)
- **Files:** `packages/crypto/src/tokens.ts`, `packages/crypto/src/hash.ts`, `packages/crypto/src/signed-url.ts`, `packages/crypto/src/ids.ts`, `packages/crypto/src/tokens.test.ts`, `packages/crypto/src/hash.test.ts`, `packages/crypto/src/signed-url.test.ts`, `packages/crypto/src/ids.test.ts`, `packages/crypto/src/index.ts`, `packages/crypto/package.json`
- **Steps:**
  1. Write `generateToken(prefix, bytes = 32)` in `src/tokens.ts`. It returns `{ token: "<prefix>_<base64url>", hash: sha256Hex(token) }`.
  2. Write the hashing helpers in `src/hash.ts`:
     - `sha256Hex` and `hmacSha256(key, data)` as hex;
     - `hashApiKey(fullKey, pepper: Buffer)` as `hex(HMAC-SHA-256(pepper, fullKey))`, exactly as PADR-0005 says;
     - `verifyApiKey(fullKey, pepper, expectedHex)` using `crypto.timingSafeEqual`;
     - `timingSafeEqualStr(a, b)`, which is safe for different lengths.
  3. Write `signUrl(path, { expiresAt, key })` and `verifySignedUrl(url, { key, now })` in `src/signed-url.ts`. The signature is `sig = base64url(HMAC-SHA-256(key, "<path>?exp=<unix>"))`, compared in constant time, and the link is rejected after `exp`. Take `now` as a parameter so tests are deterministic.
  4. Write `newId(prefix)` in `src/ids.ts` with `ulid` 3.x. Every id gets 80 **fresh** CSPRNG bits; never use the monotonic factory (db README §2.1). The prefix must match `^[a-z]{2,4}$`. Export the `IdPrefix` type.
  5. Export everything from `src/index.ts` and add the tests below.
- **Acceptance:**
  - `hashApiKey` matches a known HMAC test vector, and `verifyApiKey` rejects a key that differs in one character.
  - A signed URL verifies before `exp`, fails one second after it, and fails with a changed path or a changed `exp`.
  - 10,000 `newId("bkg")` values are unique, match `^bkg_[0-9A-HJKMNP-TV-Z]{26}$`, and two ids made in the same millisecond do not share their random part.
- **Verify:** `pnpm --filter @velexis/crypto test`

### X-006 · Copy the OTA OpenAPI document to ota/backend/openapi ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-001
- **Size:** S
- **Read first:** docs/mvp/adr/0006-contract-first-openapi.md (Documents); AGENTS.md §6; docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep only: `info`, `x-error-catalogue`, `x-sdk-method`)
- **Files:** `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, `ota/backend/openapi/README.md`
- **Steps:**
  1. Copy `docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml` byte for byte to `ota/backend/openapi/`. Do not copy the JSON form, which is generated when needed. The original under `docs/velexis-sdk/` stays frozen and is never edited.
  2. Write `ota/backend/openapi/README.md`. It covers:
     - this document is the source of truth;
     - the workflow (`pnpm contracts:lint`, `pnpm contracts:generate`, then handler, then SDK method);
     - the rule "additive changes only, unless an ADR approves a breaking change";
     - the planned spec-first extensions of ADR-0006 (cookie session mode and CSRF header, edge headers, service credentials, airline-card operation, `Internal` tag with `x-internal: true`).
  3. Do not create a `package.json` in `ota/backend/`; the OTA plan scaffolds the app there.
- **Acceptance:**
  - The copy is identical to the original (`cmp` exits 0).
  - Nothing under `docs/velexis-sdk/` changed.
  - The README links ADR-0006 and AGENTS.md §6.
- **Verify:** `cmp ota/backend/openapi/velexis-ota-booking-api.openapi.yaml docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml`

### X-007 · Create the @velexis/api-types package with contract linting ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-006
- **Size:** S
- **Read first:** docs/mvp/adr/0006-contract-first-openapi.md (Workflow, Checks in CI); docs/mvp/tech-stack.md §2 (`@redocly/cli`, `openapi-typescript`); turbo.json (`contracts:lint`)
- **Files:** `packages/api-types/package.json`, `packages/api-types/tsconfig.json`, `packages/api-types/redocly.yaml`, `packages/api-types/README.md`
- **Steps:**
  1. Scaffold `packages/api-types` with exact devDependencies `@redocly/cli` 1.x and `openapi-typescript` 7.x.
  2. Write `redocly.yaml` with two APIs:
     - `ota`, pointing to `../../ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`;
     - `platform`, pointing to `../../platform/backend/openapi/velexis-platform-api.openapi.yaml`.

     Use the `recommended` ruleset plus `operation-operationId-unique: error` and `no-unused-components: warn`. Allow the `x-*` extensions that the OTA document uses.
  3. Add the `contracts:lint` script. It lints each document that exists, skips the platform document with a notice until the platform plan creates it (ADR-0006: M1), and fails on any error.
  4. Write the README: what is generated, from where, and the commands.
- **Acceptance:**
  - `pnpm contracts:lint` passes on the copied OTA document with zero errors.
  - When the platform document is missing, lint passes and prints that it was skipped.
  - A deliberately broken copy of the OTA document (a duplicated `operationId`) makes the command fail.
- **Verify:** `pnpm install && pnpm contracts:lint`

### X-008 · Generate @velexis/api-types from the OpenAPI documents ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-007
- **Size:** M
- **Read first:** docs/mvp/adr/0006-contract-first-openapi.md; docs/mvp/adr/0009-background-jobs-bullmq.md (item 3); platform/docs/adr/0001-tenant-provisioning-orchestration.md (item 9, message envelope); docs/velexis-sdk/sdk/src/shared.d.ts; docs/velexis-sdk/sdk/src/api-types.d.ts (grep schema names only); packages/README.md (`@velexis/api-types`)
- **Files:** `packages/api-types/package.json`, `packages/api-types/scripts/generate.mjs`, `packages/api-types/src/index.ts`, `packages/api-types/src/platform.ts`, `packages/api-types/src/operations.ts`, `packages/api-types/src/jobs/index.ts`, `packages/api-types/src/jobs/envelope.ts`, `packages/api-types/src/generated/ota.ts`, `packages/api-types/src/generated/platform.ts`, `packages/api-types/src/generated/operations.ts`, `packages/api-types/src/api-types.test.ts`, `packages/api-types/README.md`
- **Steps:**
  1. In `scripts/generate.mjs`, run `openapi-typescript` (Node API) on the OTA document into `src/generated/ota.ts`. `src/index.ts` re-exports `paths`, `components`, `operations` and `$defs`, so `import type { components } from "@velexis/api-types"` works as the SDK contract expects.
  2. If the platform document exists, generate `src/generated/platform.ts` from it. Otherwise write a placeholder with empty `paths`, `components` and `operations` interfaces and a header comment saying the platform plan creates the document in M1. `src/platform.ts` re-exports it.
  3. Parse both documents with `yaml` 2.x and generate `src/generated/operations.ts`: a frozen array of `{ operationId, method, path, sdkMethod, scope, tags, internal }`. Route-parity and SDK-parity tests use it.
  4. Write the `./jobs` subpath, `src/jobs/envelope.ts`. It defines `JobEnvelope<TName, TPayload>` with `v`, `name`, `jobId`, `tenantId`, `requestedAt`, `requestId`, `payload`, matching PADR-0001 item 9, plus a JSON Schema of the envelope for Ajv. Concrete message types (`tenant.provision`, `tenant.provisioned`, …) are added by the provisioning tasks of the platform and OTA plans.
  5. Add an `exports` map for `.`, `./platform`, `./operations` and `./jobs`, a `generate` script, and a `build` script with `tsc -b`. Generated files start with `// Generated by scripts/generate.mjs — do not edit` and are committed. The output must be deterministic, with stable ordering and no timestamps.
  6. Write the tests below.
- **Acceptance:**
  - Running `pnpm contracts:generate` twice leaves no diff.
  - Every operation of the frozen contract (`docs/velexis-sdk/openapi/`, 96 operations) is in the operations index (the index may have more, as spec-first tasks add operations), and every operation without `x-internal` has an `sdkMethod`.
  - Every schema name of `docs/velexis-sdk/sdk/src/api-types.d.ts`, the SDK contract's generated file, is in `components["schemas"]` (compared by a test). Additions are allowed, as ADR-0006 and AGENTS.md §6 permit; the test never asserts equality, so later spec-first tasks (OBE-029, OBE-039, OBE-054, OBE-058, …) do not have to touch it.
  - A type test compiles `components["schemas"]["Money"]` and fails on a misspelt schema name (`// @ts-expect-error`).
- **Verify:** `pnpm contracts:generate && pnpm --filter @velexis/api-types build && pnpm --filter @velexis/api-types test && git diff --exit-code packages/api-types`

### X-009 · Generate @velexis/errors from the error catalogues ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-008
- **Size:** M
- **Read first:** docs/mvp/conventions.md §6; docs/mvp/adr/0006-contract-first-openapi.md (Error catalogue); ota/backend/openapi/velexis-ota-booking-api.openapi.yaml (grep `x-error-catalogue:` and `Error:` schema); packages/README.md (`@velexis/errors`)
- **Files:** `packages/errors/package.json`, `packages/errors/tsconfig.json`, `packages/errors/vitest.config.ts`, `packages/errors/scripts/generate.mjs`, `packages/errors/src/generated/catalogue.ts`, `packages/errors/src/app-error.ts`, `packages/errors/src/envelope.ts`, `packages/errors/src/index.ts`, `packages/errors/src/app-error.test.ts`, `packages/errors/src/envelope.test.ts`, `packages/errors/README.md`
- **Steps:**
  1. In `scripts/generate.mjs`, read `x-error-catalogue` from the OTA document and, when present, from the platform document. Write `src/generated/catalogue.ts` with the `ErrorCode` union, `OtaErrorCode`, `PlatformErrorCode`, and `ERROR_CATALOGUE: Record<ErrorCode, { status, description, source }>`. Generation fails when one code has different statuses in the two documents.
  2. Write `AppError` in `src/app-error.ts`, with the constructor `(code: ErrorCode, { message?, details?, fieldErrors?, supplier?, cause? })`. The default message is the catalogue description, and `status` comes from the catalogue.
  3. Write `toErrorEnvelope(err, requestId, { exposeSupplier })` in `src/envelope.ts`. It returns `{ status, body: { error: { code, message, status, requestId, details?, fieldErrors?, supplier? } } }`:
     - an unknown error gives `500 INTERNAL_ERROR` with a generic message;
     - there is never a stack trace or a `cause`;
     - `fieldErrors` appear only with `VALIDATION_FAILED`;
     - `supplier` appears only when `exposeSupplier` is true (console scope).
  4. Keep the package free of NestJS; backends wrap it in their own exception filter. Add a `generate` script: the root `pnpm contracts:generate` (`turbo run generate`) runs it together with the `@velexis/api-types` generator; both read the YAML documents directly.
- **Acceptance:**
  - Every catalogue code maps to its status. `new AppError("NOT_A_CODE")` does not compile (`// @ts-expect-error` type test).
  - An envelope built from an `AppError` validates with Ajv against the OTA document's `Error` schema.
  - A thrown `TypeError` becomes status 500, code `INTERNAL_ERROR`, with the given `requestId` and no stack in the body.
  - Regeneration is deterministic: the generated file shows no diff after a second run.
- **Verify:** `pnpm contracts:generate && pnpm --filter @velexis/errors build && pnpm --filter @velexis/errors test`

### X-010 · Create @velexis/db with pools, platformDb and tenantTx ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-002, X-003, X-016
- **Size:** L
- **Read first:** docs/mvp/adr/0004-postgresql-schema-per-tenant.md (Kept from the reference design, Database roles); docs/mvp/adr/0005-data-access-kysely-sql-migrations.md (Query layer); docs/velexis-sdk/db/README.md §5 and §8; docs/mvp/adr/0017-email-documents-storage.md (Storage); deploy/postgres/bootstrap.sql; packages/README.md (`@velexis/db`)
- **Files:** `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/vitest.config.ts`, `packages/db/src/index.ts`, `packages/db/src/pool.ts`, `packages/db/src/type-parsers.ts`, `packages/db/src/platform-db.ts`, `packages/db/src/tenant-db.ts`, `packages/db/src/tenant-schema.ts`, `packages/db/src/storage/index.ts`, `packages/db/src/storage/local-disk-storage.ts`, `packages/db/src/tenant-schema.test.ts`, `packages/db/src/storage/local-disk-storage.test.ts`, `packages/db/test/integration/helpers.ts`, `packages/db/test/integration/tenant-tx.int.test.ts`, `packages/db/README.md`
- **Steps:**
  1. Scaffold the package with exact dependencies `kysely` 0.28.x, `pg` 8.x and `@types/pg`, plus the workspace dependency `@velexis/logger`. Add an `exports` map for `.`, `./migrate` (filled in by X-011) and `./storage`. Add a `test:int` script (`vitest run --config vitest.int.config.ts` or a `test/integration` include).
  2. Write `createPool(url, { max, applicationName, statementTimeoutMs, idleTimeoutMillis })` in `src/pool.ts`. It installs the type parsers on a **per-pool** `types` object, without mutating the global `pg.types`: `numeric` (1700) and `int8` (20) stay strings, `timestamptz` becomes `Date`, `jsonb` is parsed.
  3. Write `createPlatformDb<DB>(pool)` in `src/platform-db.ts`: Kysely with `PostgresDialect`, used with schema-qualified table names.
  4. Write `createTenantDb<DB>(pool)` and `tenantTx(db, schema, fn, { statementTimeoutMs = 5000 })` in `src/tenant-db.ts`:
     - it validates the schema name with `assertTenantSchema` (`^tenant_[a-z][a-z0-9_]{1,39}$`, `src/tenant-schema.ts`) before anything else;
     - it opens a transaction and runs ``sql`SELECT set_config('search_path', ${schema + ', reference'}, true)` ``, then the same for `statement_timeout`, then `fn(trx)`;
     - no identifier is concatenated into SQL.
  5. Leak guard: when `APP_ENV` is not `production`, the first statement inside `tenantTx` reads `current_setting('search_path')` and throws `SearchPathLeakError` unless it is the role default (`pg_catalog` for `velexis_ota_app`). This catches session-level `SET search_path` anywhere else.
  6. Write `StorageAdapter` (`put`, `get`, `delete`, `signedUrl`) and `LocalDiskStorage(dir)` in `src/storage/`, as ADR-0017 describes: keys `tenant_<key>/…` or `platform/…`, `..` rejected, atomic writes (temp file + rename), mode 0600. Add `createStorage({ driver, dir })`; `s3` throws "not implemented" until it is needed.
  7. Write integration tests with a small helper in `test/integration/helpers.ts`. As `TEST_DATABASE_ADMIN_URL` it creates `velexis_dbtest_<random>` owned by `velexis_migrator`, applies the database-level grants of `bootstrap.sql` to it (`CONNECT`, `TEMPORARY` for the app roles, plus `CREATE` for `velexis_provisioner`), creates `tenant_a` and `tenant_b`, each with an `items` table holding different rows, and grants DML to `velexis_ota_app`. The roles come from `dev-setup.sh` (X-016) locally and from the CI bootstrap. `@velexis/testing` (X-015) later replaces this helper.
- **Acceptance:**
  - Through a pool of **size 1**, 50 interleaved `tenantTx` calls for `tenant_a` and `tenant_b` each see only their own rows (the mandatory isolation test of ADR-0004).
  - After a `tenantTx` commits or rolls back, the same connection's `search_path` is the role default again.
  - `tenantTx(db, "tenant_a; DROP TABLE x", …)` and `"public"` are rejected before any SQL runs.
  - A connection with a session-level `SET search_path TO tenant_a` triggers `SearchPathLeakError` in the next `tenantTx` (test environment).
  - `numeric` values come back as strings (`"12.30"`), `timestamptz` as `Date`.
  - `LocalDiskStorage` rejects a key with `..` and writes files with mode 0600.
- **Verify:** `pnpm --filter @velexis/db build && pnpm --filter @velexis/db test && pnpm --filter @velexis/db test:int`

### X-011 · Build the migration runner and the migrate CLI ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-010
- **Size:** L
- **Read first:** docs/mvp/adr/0005-data-access-kysely-sql-migrations.md (Migrations); docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md; docs/velexis-sdk/db/README.md §4; docs/mvp/conventions.md §9; docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE schema_migrations`)
- **Files:** `packages/db/src/migrate/index.ts`, `packages/db/src/migrate/files.ts`, `packages/db/src/migrate/ledger.ts`, `packages/db/src/migrate/run-set.ts`, `packages/db/src/migrate/repeatable.ts`, `packages/db/src/cli/migrate.ts`, `packages/db/src/migrate/files.test.ts`, `packages/db/src/migrate/repeatable.test.ts`, `packages/db/test/integration/migrate.int.test.ts`, `packages/db/package.json`, `packages/db/README.md`
- **Steps:**
  1. Write file discovery in `src/migrate/files.ts`:
     - numbered files match `^\d{4}_[a-z0-9_]+\.sql$` and are sorted;
     - repeatable files match `^R__[a-z0-9_]+\.sql$` and are allowed in the `platform` and `reference` sets only;
     - a duplicated number fails;
     - the header `-- velexis:phase (expand|migrate|contract)` is required, except for `0001_baseline.sql`, which is a byte copy without headers and counts as `expand`;
     - `-- velexis:no-transaction` is recognised;
     - the SHA-256 is computed over the raw bytes.
  2. Write the ledgers in `src/migrate/ledger.ts`. For `platform` and `reference` the runner creates `<schema>.schema_migrations` before the first file, with the same columns as the tenant ledger in `tenant.sql` (`id`, `description`, `checksum`, `phase`, `status`, `execution_ms`, `created_at`, `updated_at`), plus `repeatable` as an allowed phase. The ledger id is the file name without `.sql`.
  3. Write `runMigrations({ set, dir, url })` in `src/migrate/run-set.ts`:
     - take `pg_advisory_lock(hashtext('velexis:migrate:' || set))` for the whole run;
     - verify the checksums of applied files and exit with code 2 on a mismatch, before applying anything;
     - apply each pending file in its own transaction (`SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '10min'`) and record it in the same transaction;
     - run `no-transaction` files on the connection outside a transaction, then record them;
     - a failing file rolls back and stops the run with exit code 1.
  4. Write the repeatable files in `src/migrate/repeatable.ts`. They are applied after the numbered files when their checksum changed. Each statement, comments stripped, must start with `GRANT`, `REVOKE` or `COMMENT ON`; anything else is rejected (ADR-0021).
  5. Write the CLI in `src/cli/migrate.ts` (built to `dist/cli/migrate.js`):
     - commands `platform --dir` and `reference --dir`; X-013 adds `tenants` and `tenant`;
     - a `--dir` that does not exist is an empty set: a notice on stderr, nothing applied, exit 0 (CI runs `pnpm db:migrate` as soon as `packages/db/package.json` exists, before X-012 creates the folders);
     - `DATABASE_MIGRATOR_URL` through `@velexis/config`, with dev env files loaded locally; no `--url` flag;
     - one JSON line per file on stdout;
     - exit codes 0, 1, 2, 3 as in ADR-0021.
  6. Add the package scripts. `migrate` runs `node dist/cli/migrate.js platform --dir ../../platform/backend/migrations/platform && node dist/cli/migrate.js reference --dir ../../platform/backend/migrations/reference`; the root `pnpm db:migrate` calls it.
- **Acceptance:**
  - On a fresh database, the files are applied in order. A second run applies nothing and exits 0.
  - Editing an applied file makes the next run exit 2 and apply nothing.
  - A file with an SQL error rolls back, leaves no ledger row and exits 1. Files before it stay applied.
  - A `-- velexis:no-transaction` file with `CREATE INDEX CONCURRENTLY` applies and is recorded.
  - A repeatable file is applied once, re-applied after an edit, and a repeatable file containing `CREATE TABLE` is rejected.
  - Two concurrent runs on the same set do not apply a file twice.
  - `migrate.js platform --dir <missing folder>` prints a notice on stderr, applies nothing and exits 0 (unit test in `files.test.ts`).
- **Verify:** `pnpm --filter @velexis/db build && pnpm --filter @velexis/db test && pnpm --filter @velexis/db test:int`

### X-012 · Add the baseline migrations and the OTA read grants ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-011
- **Size:** M
- **Read first:** docs/mvp/adr/0004-postgresql-schema-per-tenant.md (Database roles, Migration ownership); docs/mvp/adr/0005-data-access-kysely-sql-migrations.md (Baselines); docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md; platform/docs/data-model.md (the platform `0002` deltas; do not create them here); docs/velexis-sdk/db/platform.sql (grep `CREATE TABLE platform.accounts`)
- **Files:** `platform/backend/migrations/platform/0001_baseline.sql`, `platform/backend/migrations/platform/R__ota_read_access.sql`, `platform/backend/migrations/reference/0001_baseline.sql`, `ota/backend/migrations/tenant/0001_baseline.sql`, `platform/backend/migrations/README.md`, `ota/backend/migrations/README.md`, `packages/db/src/migrate/baselines.test.ts`, `packages/db/test/integration/baselines.int.test.ts`
- **Steps:**
  1. Copy `docs/velexis-sdk/db/platform.sql`, `reference.sql` and `tenant.sql` byte for byte to the three `0001_baseline.sql` files.
  2. Write `R__ota_read_access.sql` with a header that explains the file (repeatable, idempotent, ADR-0004 list, ADR-0021). It contains:
     - `GRANT SELECT ON platform.tenants, platform.tenant_domains, platform.api_keys, platform.api_key_tenant_grants, platform.tenant_memberships, platform.plans, platform.supplier_connections, platform.payment_provider_connections TO velexis_ota_app;`
     - a column-level `GRANT SELECT (id, email, email_verified_at, full_name, locale, time_zone, mfa_enabled, status, deleted_at, version) ON platform.accounts TO velexis_ota_app;`. Secrets, hashes and security counters are **never** granted: not `password_hash`, `mfa_secret_ciphertext`, `encryption_key_id`, `failed_login_count`, `locked_until` or `is_platform_admin` (ADR-0004, ADR-0021). The file's header says so, and that a later third-party password grant is verified by the platform, not the OTA backend (ADR-0008).
  3. Write the two migration READMEs: naming, headers, expand/migrate/contract, "never edit a merged numbered file", how to run (`pnpm db:migrate`, `pnpm db:migrate:tenants`). Note that platform deltas start at `0002_add_mvp_platform_deltas.sql` (platform plan).
  4. Unit test `baselines.test.ts`: the SHA-256 of each baseline equals that of its `docs/velexis-sdk/db/` source.
  5. Integration test `baselines.int.test.ts` on a fresh database bootstrapped with `deploy/postgres/bootstrap.sql` semantics:
     - after `platform` and `reference` there are 16 platform tables plus the ledger, and 7 reference tables;
     - applying the tenant set to `tenant_alpha` (through the runner library) gives 42 tables;
     - then check the privileges listed under Acceptance.
- **Acceptance:**
  - The baseline checksums equal the reference DDL (CI also runs `cmp`, X-019).
  - `velexis_ota_app` can `SELECT` the eight listed tables and the listed `accounts` columns.
  - `velexis_ota_app` cannot `SELECT` `platform.accounts.password_hash`, `mfa_secret_ciphertext`, `encryption_key_id`, `failed_login_count`, `locked_until` or `is_platform_admin` (each a `permission denied` error in `baselines.int.test.ts`).
  - `velexis_ota_app` cannot `SELECT` `platform.subscriptions`, `platform.invoices`, `platform.account_sessions`, `platform.provisioning_jobs` or `platform.platform_audit_log`, and cannot `UPDATE` any platform table.
  - `velexis_platform_app` has no privilege on `tenant_alpha` and can insert into `reference.airports`.
  - `pnpm db:migrate` on a developer database prints one applied line per file, then nothing on a second run.
- **Verify:** `pnpm db:migrate && pnpm --filter @velexis/db test && pnpm --filter @velexis/db test:int`

### X-013 · Add the tenant fan-out and single-schema commands to the runner ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-012
- **Size:** M
- **Read first:** docs/mvp/adr/0005-data-access-kysely-sql-migrations.md (item 4); docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md; docs/velexis-sdk/db/README.md §3 and §4; docs/velexis-sdk/db/platform.sql (grep `CREATE TABLE platform.tenants`)
- **Files:** `packages/db/src/migrate/tenants.ts`, `packages/db/src/migrate/tenant-schema.ts`, `packages/db/src/cli/migrate.ts`, `packages/db/src/migrate/index.ts`, `packages/db/test/integration/tenants.int.test.ts`, `packages/db/package.json`, `packages/db/README.md`
- **Steps:**
  1. Write `migrateTenantSchema({ schema, dir, url, create })` in `src/migrate/tenant-schema.ts`. Each schema gets one transaction:
     - `SET LOCAL lock_timeout = '5s'` and `SET LOCAL statement_timeout = '10min'`;
     - `pg_advisory_xact_lock(hashtext(schema))`;
     - `set_config('search_path', schema || ', reference', true)`;
     - verify checksums, apply the pending files, insert ledger rows into the schema's own `schema_migrations`. The baseline creates that table, so its own row is inserted right after it runs.
  2. With `create: true`, in the same transaction:
     - `SET LOCAL ROLE velexis_provisioner` first, so every object belongs to the provisioner whether the caller connects as `velexis_provisioner` (OTA worker, `DATABASE_PROVISIONER_URL`) or as `velexis_migrator` (deploy fan-out, CLI); the same `SET LOCAL ROLE` opens every tenant transaction of step 1 and step 3;
     - `CREATE SCHEMA <ident> AUTHORIZATION velexis_provisioner`, with the identifier quoted by `pg`'s `escapeIdentifier` after `assertTenantSchema`;
     - `GRANT USAGE` and DML on all tables to `velexis_ota_app`;
     - `ALTER DEFAULT PRIVILEGES FOR ROLE velexis_provisioner … IN SCHEMA` for future tables and sequences.

     This is the `create_schema` and `run_migrations` step that the OTA provisioning job calls (db README §3).
  3. Write `migrateTenants({ dir, url, concurrency = 4, maxFailureRatio = 0.1, report })` in `src/migrate/tenants.ts`:
     - targets are `SELECT schema_name FROM platform.tenants WHERE status IN ('provisioning','active','suspended') ORDER BY key`;
     - it uses a hand-written concurrency limiter (no new dependency) and continues past a failed schema;
     - it writes the report JSON `{ target, total, applied: [...], failed: [{ schema, file, error }] }`;
     - it returns exit code 3 when `failed / total > maxFailureRatio`.
  4. `no-transaction` files in the tenant set run on a dedicated migrator connection with a session `search_path`, which is closed afterwards. Never do this on an app pool: the runner is the only place allowed to set `search_path` at session level.
  5. Mirroring results into `platform.tenant_schema_migrations` is **not** done here. The provisioning tasks send them through `platform-tenant-events` (PADR-0001); the report carries everything they need.
  6. CLI: `tenants --dir [--concurrency] [--max-failure-ratio] [--report]` and `tenant --schema --dir [--create]`. Package script `migrate:tenants` uses `../../ota/backend/migrations/tenant`.
- **Acceptance:**
  - `tenant --schema tenant_demo --create` creates a 42-table schema owned by `velexis_provisioner`. `velexis_ota_app` can insert into `tenant_demo.customers`; `velexis_platform_app` cannot select from it.
  - Connected with the provisioner DSN, `migrateTenantSchema({ create: true })` works, and the same connection cannot `UPDATE platform.accounts`, `INSERT` into `platform.platform_audit_log`, `DROP SCHEMA platform` or write to `reference.airports` (permission errors in `tenants.int.test.ts`).
  - A tenant file applied later by the fan-out (as `velexis_migrator`) creates a table owned by `velexis_provisioner` that `velexis_ota_app` can write without a `GRANT`.
  - With 10 tenant schemas where one has a conflicting pre-created table, 9 are migrated, the report lists the failure, and the exit code is 0.
  - With 3 schemas and one failure (33 % > 10 %), the exit code is 3.
  - No more than `--concurrency` schemas are migrated at the same time (asserted through an instrumentation hook).
  - Re-running applies nothing.
- **Verify:** `pnpm --filter @velexis/db build && pnpm --filter @velexis/db test:int`

### X-014 · Generate Kysely table types with pnpm db:codegen ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-013
- **Size:** S
- **Read first:** docs/mvp/adr/0005-data-access-kysely-sql-migrations.md (Query layer item 2, type parsers); docs/mvp/tech-stack.md (`kysely-codegen`)
- **Files:** `packages/db/scripts/codegen.mjs`, `packages/db/src/generated/platform.ts`, `packages/db/src/generated/reference.ts`, `packages/db/src/generated/tenant.ts`, `packages/db/src/index.ts`, `packages/db/src/tenant-db.ts`, `packages/db/src/types.test.ts`, `packages/db/package.json`
- **Steps:**
  1. Add `kysely-codegen` 0.18.x (exact) as a devDependency, and a `codegen` script that runs `scripts/codegen.mjs`.
  2. The script:
     - creates a scratch database `velexis_codegen_<pid>` as `TEST_DATABASE_ADMIN_URL`;
     - applies the platform and reference sets and creates `tenant_template` with the tenant set, using the runner library;
     - runs `kysely-codegen` once per schema;
     - post-processes so that `numeric` and `int8` are `string`, `timestamptz` is `Date`, and tenant table names are **unqualified**;
     - drops the scratch database.
  3. Export the types `PlatformDatabase` (platform tables, qualified as `platform.<table>`), `ReferenceDatabase` (`reference.<table>`) and `TenantDatabase` (unqualified tenant tables plus the reference tables, because the tenant `search_path` includes `reference`). Make them the default type parameters of `createPlatformDb` and `createTenantDb`.
  4. Generated files carry a "do not edit" header and are deterministic (sorted). CI regenerates them and fails on a diff (X-019).
- **Acceptance:**
  - Running `pnpm db:codegen` twice gives no diff.
  - A type test: inside `tenantTx`, `trx.selectFrom("bookings")` compiles and `trx.selectFrom("tenants")` does not (`// @ts-expect-error`).
  - Columns of type `numeric(12,2)` are typed `string`.
- **Verify:** `pnpm db:codegen && pnpm --filter @velexis/db typecheck && pnpm --filter @velexis/db test && git diff --exit-code packages/db/src/generated`

### X-015 · Create @velexis/testing with test databases, Redis, clock and response checks ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-013, X-008
- **Size:** L
- **Read first:** docs/mvp/adr/0022-shared-test-support-package.md; docs/mvp/adr/0015-testing-strategy.md (Dependencies in tests, Contract tests); packages/README.md (`@velexis/testing`); deploy/postgres/bootstrap.sql
- **Files:** `packages/testing/package.json`, `packages/testing/tsconfig.json`, `packages/testing/vitest.config.ts`, `packages/testing/src/index.ts`, `packages/testing/src/roles.ts`, `packages/testing/src/test-database.ts`, `packages/testing/src/vitest-global-setup.ts`, `packages/testing/src/redis.ts`, `packages/testing/src/clock.ts`, `packages/testing/src/builders.ts`, `packages/testing/src/openapi-response.ts`, `packages/testing/src/clock.test.ts`, `packages/testing/src/openapi-response.test.ts`, `packages/testing/test/integration/test-database.int.test.ts`, `packages/testing/README.md`, `packages/testing/src/schemas-sql.test.ts`, `deploy/postgres/schemas.sql`
- **Steps:**
  1. Create `deploy/postgres/schemas.sql` with exactly the in-database statements of `deploy/postgres/bootstrap.sql`, from `REVOKE ALL ON SCHEMA public` to the end, with no psql meta-commands. Leave `bootstrap.sql` unchanged: `provision-vm.sh` feeds it through stdin, where `\ir` would not resolve. The unit test `schemas-sql.test.ts` asserts that `bootstrap.sql` contains `schemas.sql` verbatim, so the two cannot drift.
  2. Write `src/vitest-global-setup.ts`. As `TEST_DATABASE_ADMIN_URL` it:
     - creates `velexis_test_tpl_<runId>` owned by `velexis_migrator`, with the database-level grants of `bootstrap.sql` (`CONNECT`, `TEMPORARY` for the app roles, `CREATE` for `velexis_provisioner`), which clones inherit;
     - runs `schemas.sql`;
     - applies the platform and reference sets with `runMigrations`, and `tenant_alpha` and `tenant_beta` with `migrateTenantSchema({ create: true })`;
     - inserts a tiny reference fixture (3 currencies, 3 countries, 5 airports, 3 airlines);
     - drops the template at teardown.
  3. Write `createTestDatabase()` in `src/test-database.ts`. It clones the template (`CREATE DATABASE … TEMPLATE … OWNER velexis_migrator`) and returns:
     - `{ name, urlFor(role: "migrator" | "provisioner" | "platform" | "ota"), drop() }`;
     - the role passwords from `src/roles.ts`, which are the development values of `.env.example` and are test-only.
  4. Write the other helpers:
     - `useRedis()` in `src/redis.ts`: database index `1 + (VITEST_POOL_ID % 15)` and `FLUSHDB` before each file, returning an `ioredis` client and the URL;
     - `FakeClock` (`now()`, `advance(ms)`) in `src/clock.ts`;
     - `defineBuilder<T>(defaults)` in `src/builders.ts`;
     - `expectResponseToMatch(operationId, res, { document: "ota" | "platform" })` in `src/openapi-response.ts`: it validates status and body with Ajv 2020 and `ajv-formats` against the operation's response schema, and its error message names the failing paths.
  5. Mark the package devDependency-only in its README. X-019 adds the CI check.
- **Acceptance:**
  - Two integration test files running in parallel each get their own database with `tenant_alpha` and `tenant_beta`, and changes in one are invisible to the other.
  - The template is built once per run; each clone takes less than 1 s locally.
  - `drop()` removes the database even while connections are open (`WITH (FORCE)`).
  - `expectResponseToMatch("getBooking", { status: 200, body: { foo: 1 } })` fails with a message naming the missing required properties.
  - `schemas-sql.test.ts` fails when `bootstrap.sql` and `schemas.sql` differ, and passes on the committed files.
- **Verify:** `pnpm --filter @velexis/testing build && pnpm --filter @velexis/testing test && pnpm --filter @velexis/testing test:int`

### X-016 · Local development setup with dev-setup.sh, dev keys and the runbook ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-001
- **Size:** M
- **Read first:** docs/mvp/local-development.md (whole); deploy/postgres/bootstrap.sql; docs/mvp/adr/0010-secrets-envelope-encryption.md (Key material on the VM); .env.example; deploy/scripts/provision-vm.sh (step_keys)
- **Files:** `deploy/scripts/dev-setup.sh`, `tools/dev/dev-keys.mjs`, `tools/dev/README.md`, `docs/mvp/local-development.md`, `.env.example`, `.github/workflows/ci.yml`
- **Steps:**
  1. Write `deploy/scripts/dev-setup.sh` (bash, `set -euo pipefail`, Ubuntu and macOS):
     - refuse to run when `/etc/velexis` exists (a production host);
     - find superuser access (`sudo -u postgres psql` on Linux, the current user with Homebrew);
     - start PostgreSQL and Redis if they are stopped;
     - run `bootstrap.sql` with the development passwords (including `provisioner_password`) passed as `\set` lines on stdin;
     - create `velexis_test_admin` (`LOGIN CREATEDB`, `GRANT velexis_migrator TO velexis_test_admin`) idempotently;
     - if Redis answers without a password, `CONFIG SET requirepass dev_redis` and `CONFIG REWRITE`, warning if the rewrite is refused;
     - print a summary.
  2. Write `tools/dev/dev-keys.mjs` (plain Node, no dependency):
     - create `.local/keys/` (mode 0700) with `master-v1.key`, `api-key-pepper` and `document-url.key` (32 random bytes, base64) and `platform-jwt-ed25519.pem` and `ota-jwt-ed25519.pem` (`crypto.generateKeyPairSync("ed25519")`, PKCS#8 PEM), all mode 0600;
     - create `.local/storage/`;
     - never overwrite an existing file without `--force`.
  3. Add a CI job `dev-setup` to `.github/workflows/ci.yml` that runs on a clean `ubuntu-24.04` runner: install PostgreSQL 16 and Redis 7.4 from their apt repositories, run `dev-setup.sh` twice and `dev-keys.mjs` twice, and check the result (roles exist, Redis needs the password, five key files with mode 0600). Fix every step of `local-development.md` §2 that differs, in the doc and in the scripts. Human step (optional): follow §2 on macOS and record the result in the PR.
  4. Make `.env.example` match the roles, passwords and paths that the scripts create.
- **Acceptance:**
  - The `dev-setup` CI job passes on a clean runner, so `docs/mvp/local-development.md` §2 works up to `dev-keys` without manual fixes; the macOS result (human step, optional) is recorded in the PR.
  - Running `dev-setup.sh` a second time succeeds and changes nothing. `shellcheck -S style` is clean.
  - `node tools/dev/dev-keys.mjs` creates the five files with mode 0600, and a second run keeps them unchanged.
  - The script refuses to run on a host with `/etc/velexis`.
- **Verify:** `shellcheck -S style deploy/scripts/dev-setup.sh && bash deploy/scripts/dev-setup.sh && node tools/dev/dev-keys.mjs && ls -l .local/keys`

### X-017 · Vendor the reference datasets ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-001
- **Size:** M
- **Read first:** docs/mvp/adr/0024-reference-data-sources-and-loader.md; docs/velexis-sdk/db/reference.sql (all CHECK constraints); docs/velexis-sdk/db/dictionary.json (grep the `reference` tables)
- **Files:** `tools/reference-data/package.json`, `tools/reference-data/scripts/fetch.mjs`, `tools/reference-data/scripts/validate.mjs`, `tools/reference-data/data/currencies.csv`, `tools/reference-data/data/countries.csv`, `tools/reference-data/data/time_zones.csv`, `tools/reference-data/data/cities.csv`, `tools/reference-data/data/airports.csv`, `tools/reference-data/data/airlines.csv`, `tools/reference-data/data/aircraft.csv`, `tools/reference-data/data/overrides.csv`, `tools/reference-data/SOURCES.md`, `tools/reference-data/README.md`
- **Steps:**
  1. Create the workspace package `@velexis/reference-data` (`"private": true`). Its `files` field includes `dist` and `data`, so `pnpm deploy` ships the datasets.
  2. Write `scripts/fetch.mjs` (Node 22 `fetch`, plain JavaScript, a tiny CSV parser, no new dependency). It is run by hand, **never in CI**, and downloads:
     - OpenTravelData `optd_por_public.csv`, `optd_airlines.csv` and `optd_aircraft.csv` (caret-separated);
     - the CLDR JSON files for territory names, code mappings, currency data, telephone codes and currency names.
  3. Map the sources to the exact columns of `reference.sql`:
     - airports: only rows with an IATA code and location type airport, heliport, rail or bus station; `is_active = false` for closed ones; `search_rank` from the OPTD page rank × 1,000,000, rounded;
     - cities: from the OPTD city codes;
     - time zones: standard and daylight offsets computed with `Intl` for a January and a July date;
     - countries: continent from OPTD, `is_eu` from a 27-code list in the script.
  4. Write `scripts/validate.mjs`, also used offline by `fetch.mjs --check`:
     - every row meets the CHECK constraints of `reference.sql` (code regexes, latitude and longitude ranges, kind and alliance lists);
     - foreign keys resolve inside the files (airport → city, country, time zone);
     - keys are unique and rows are sorted by key.
  5. Write deterministic CSVs (header row, LF line endings, sorted) and `SOURCES.md`: URL, retrieval date, licence (CC BY 4.0, Unicode License v3), the SHA-256 of each raw download, and the attribution line of ADR-0024. Add an empty `overrides.csv` (`table,key,column,value`) for urgent manual fixes.
  6. Keep the total size of `data/` under 3 MB.
- **Acceptance:**
  - `node tools/reference-data/scripts/fetch.mjs --check` validates the committed files offline and exits 0.
  - Counts are plausible: currencies ≥ 150, countries ≥ 240, time zones ≥ 300, airports with IATA codes ≥ 8,000, airlines ≥ 700, aircraft ≥ 200.
  - Every airport's `time_zone` exists in `time_zones.csv`, and every `city_code` exists in `cities.csv`.
  - `SOURCES.md` names each source, its licence and the attribution text.
- **Verify:** `node tools/reference-data/scripts/fetch.mjs --check && du -sh tools/reference-data/data`

### X-018 · Build the reference data loader and pnpm db:seed:reference ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-017, X-012
- **Size:** M
- **Read first:** docs/mvp/adr/0024-reference-data-sources-and-loader.md (Loader); docs/mvp/adr/0004-postgresql-schema-per-tenant.md (roles); docs/mvp/deployment-single-vm.md §8 (step 4); deploy/scripts/deploy.sh (section 3, reference data)
- **Files:** `tools/reference-data/tsconfig.json`, `tools/reference-data/vitest.config.ts`, `tools/reference-data/src/load.ts`, `tools/reference-data/src/csv.ts`, `tools/reference-data/src/cli/load.ts`, `tools/reference-data/test/integration/load.int.test.ts`, `tools/reference-data/package.json`, `tools/reference-data/README.md`
- **Steps:**
  1. Add TypeScript and a build to the package. Dependencies: `pg` (exact, as in `@velexis/db`), `@velexis/config` and `@velexis/logger`.
  2. Write `loadReferenceData({ url, dataDir })` in `src/load.ts`:
     - one transaction, in foreign-key order: currencies, countries, time zones, cities, airports, airlines, aircraft;
     - per table `INSERT … ON CONFLICT (<code>) DO UPDATE SET … , updated_at = now() WHERE (<columns>) IS DISTINCT FROM (EXCLUDED.<columns>)`;
     - then `overrides.csv`;
     - then codes missing from the files get `is_active = false` where the column exists; **never** `DELETE`;
     - it returns per-table counts (inserted, updated, deactivated).
  3. Write the CLI in `src/cli/load.ts` (`dist/cli/load.js --data <dir>`, `DATABASE_URL` through `@velexis/config`). It prints the counts as one JSON line and exits non-zero on error. Add the package script `load` (`node dist/cli/load.js --data data`); the root `pnpm db:seed:reference` already calls it.
  4. Integration test on a fresh database migrated with X-012: first load, second load, a removed airport, and a run as `velexis_ota_app`.
- **Acceptance:**
  - The first load inserts every row; a second load reports zero inserts and updates.
  - Removing an airport from the file and loading again sets its `is_active` to false and keeps the row.
  - Running with the `velexis_ota_app` DSN fails with a permission error and changes nothing.
  - A full load takes less than 30 s on a developer machine.
- **Verify:** `pnpm --filter @velexis/reference-data build && pnpm db:seed:reference && pnpm --filter @velexis/reference-data test:int`

### X-019 · Make CI green and add the repository guards and Dependabot
- **Status:** in progress (branch claude/intelligent-bardeen-90hhu7; pending: a GitHub CI run with all three jobs green on the PR and on `main` (AC1), GitHub accepting `dependabot.yml` (AC4), Turborepo cache hits on a re-run of the same commit (step 4), human step: protect `main` (step 5))
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-001
- **Size:** M
- **Read first:** .github/workflows/ci.yml; docs/mvp/adr/0015-testing-strategy.md (CI); docs/mvp/adr/0002-monorepo-pnpm-turborepo.md (item 7); AGENTS.md §7; docs/mvp/adr/0022-shared-test-support-package.md (item 2)
- **Files:** `.github/workflows/ci.yml`, `.github/dependabot.yml`, `tools/ci/check-package-json.mjs`, `tools/ci/README.md`
- **Steps:**
  1. Push a branch with the current `ci.yml` and make all three jobs green. Change the workflow only, never a lint rule or a test.
  2. Write `tools/ci/check-package-json.mjs` (plain Node). It fails when:
     - any workspace `package.json` has a `^` or `~` version range (ADR-0002 exact versions);
     - `@velexis/testing` or `@velexis/amadeus-stub` is listed in `dependencies` instead of `devDependencies` (ADR-0022);
     - a package under `packages/` depends on an app.

     Run it in the `build-test` job before the tests.
  3. Write `.github/dependabot.yml`:
     - weekly `npm` updates at the root, grouped as `nestjs`, `next-react`, `tooling` (eslint, prettier, turbo, vitest, typescript-eslint) and `types`, with minor and patch only;
     - `ignore` rules keep the majors and minors pinned by `docs/mvp/tech-stack.md` (TypeScript 5.6, Node types 22, Next.js 15, NestJS 11);
     - weekly `github-actions` updates, which keep the full-commit-SHA pins of every workflow current (the tag stays in the comment, ADR-0023).
  4. Confirm that the Turborepo cache works: the second CI run of the same commit shows cache hits in the log.
  5. Human step: the developer protects `main` (CI required, one approval, squash merge, linear history). Record it in the PR.
- **Acceptance:**
  - CI is green on `main` and on the PR.
  - A test PR containing `it.only` fails lint; one editing `docs/velexis-sdk/` fails the guards; one adding `SET search_path` in `platform/` fails the guards; a `^1.0.0` range fails `check-package-json`.
  - The plan-lint job runs without `pnpm install`.
  - GitHub accepts `dependabot.yml` without errors.
  - Every `uses:` in `.github/workflows/` is pinned to a 40-character commit SHA (`check-package-json.mjs` or a grep step fails otherwise).
- **Verify:** `node tools/ci/check-package-json.mjs && node tools/plan-lint/plan-lint.mjs`

### X-020 · Finalise provision-vm.sh and provision the VM
- **Status:** in progress (branch claude/intelligent-bardeen-90hhu7; pending: human step 3, two provision-vm.sh runs on a throwaway VM with only-PASS check-vm.sh outputs (AC2); human step 4, check-vm.sh on the production VM (AC5), the only place the Verify's `sudo bash deploy/scripts/check-vm.sh` can pass; step 5 after those runs)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-021, X-022, X-033
- **Size:** M
- **Read first:** docs/mvp/deployment-single-vm.md §1 to §7; docs/mvp/adr/0007-single-vm-without-docker.md; docs/mvp/adr/0023-release-artefact-and-deploy-user.md; docs/mvp/adr/0026-system-users-per-trust-zone.md; deploy/README.md; deploy/scripts/provision-vm.sh
- **Files:** `deploy/scripts/provision-vm.sh`, `deploy/scripts/check-vm.sh`, `deploy/postgres/velexis.conf`, `deploy/redis/velexis.conf`, `deploy/journald/velexis.conf`, `deploy/logrotate/velexis`, `deploy/env/platform-backend.env.example`, `deploy/env/ota-backend.env.example`, `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. Review `provision-vm.sh` against the hardening checklist of `deployment-single-vm.md` §2 and the directory table of §4. Keep it idempotent: no step may overwrite a key file, an env file or `/etc/velexis/.provision-secrets`.
  2. Write `deploy/scripts/check-vm.sh`, a read-only check that prints `PASS` or `FAIL` per item:
     - `postgresql`, `redis-server`, `caddy` and `velexis-backup.timer` are active;
     - `ufw status` allows only 22, 80 and 443; `sshd -T` shows no password authentication and no root login; `swapon --show` is empty;
     - the four database roles exist and `velexis_ota_app`'s `search_path` is `pg_catalog`;
     - `redis-cli CONFIG GET maxmemory-policy` returns `noeviction`;
     - `caddy validate` passes with `caddy.env`;
     - key folders and files belong to their zone's user with modes 0500/0400, env files are `root:root 0600`, and `/srv/velexis` has the owners of §4;
     - every `/etc/velexis/<app>.env` has every variable of its `deploy/env/<app>.env.example` template (an empty value is fine); missing ones are listed by name, never with values;
     - Caddy's admin API is not on TCP (`ss -ltn` shows no `:2019`) and `/run/caddy` is `0700 caddy`.
  3. Human step: the developer runs the script on a **throwaway** Ubuntu 24.04 VM (never the production VM), twice, and pastes both `check-vm.sh` outputs into the PR; the second run must change nothing. The agent prepares the exact commands in the PR.
  4. Human step: the developer runs the script on the production VM ([`deployment-single-vm.md`](../deployment-single-vm.md) §3 steps 1 to 9), then runs `check-vm.sh`. The developer pastes the output (no secrets) into the PR.
  5. Update `deployment-single-vm.md` wherever reality differed (package names, versions, paths).
- **Acceptance:**
  - `shellcheck -S style` is clean for both scripts.
  - On a fresh throwaway VM (human step), `provision-vm.sh` completes and `check-vm.sh` reports only `PASS`. A second provisioning run completes without changing any generated secret, key or env file.
  - With a variable removed from a test copy of an env file, `check-vm.sh` reports `FAIL` naming the variable, and `provision-vm.sh --steps envfiles` warns about it.
  - The script prints no secret value to stdout or to the log.
  - The production VM passes `check-vm.sh` (human step recorded in the PR).
- **Verify:** `shellcheck -S style deploy/scripts/provision-vm.sh deploy/scripts/check-vm.sh && sudo bash deploy/scripts/check-vm.sh`

### X-021 · Finalise the systemd units and the failure alert
- **Status:** in progress (branch claude/intelligent-bardeen-90hhu7; pending: the throwaway-VM repeat of steps 2–3 (human step))
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-001
- **Size:** M
- **Read first:** docs/mvp/adr/0007-single-vm-without-docker.md (systemd units); docs/mvp/adr/0016-observability.md (Metrics and alerting); docs/mvp/deployment-single-vm.md §4; deploy/systemd/; deploy/scripts/alert.sh
- **Files:** `deploy/systemd/velexis-platform-api.service`, `deploy/systemd/velexis-platform-worker.service`, `deploy/systemd/velexis-portal.service`, `deploy/systemd/velexis-platform-admin.service`, `deploy/systemd/velexis-ota-api.service`, `deploy/systemd/velexis-ota-worker.service`, `deploy/systemd/velexis-ota-admin.service`, `deploy/systemd/velexis-alert@.service`, `deploy/systemd/velexis-backup.service`, `deploy/systemd/velexis-backup.timer`, `deploy/systemd/caddy.service.d/velexis.conf`, `deploy/scripts/alert.sh`, `deploy/env/alert.env.example`, `deploy/systemd/test/units-smoke.sh`, `.github/workflows/ci.yml`
- **Steps:**
  1. Run `systemd-analyze verify` and `systemd-analyze security --offline=true` on every unit. App units must score 2.0 or lower ("OK").
  2. Write `deploy/systemd/test/units-smoke.sh` and run it in a CI job on the `ubuntu-24.04` runner (it has `sudo` and systemd): it installs one backend unit and one Next.js unit with a stand-in `dist/main.js` under a temporary prefix: a 30-line Node HTTP server that answers `/health/ready` and, at start-up, does what the real apps need:
     - read its release folder and `/etc/velexis/keys` (backends only);
     - connect to `127.0.0.1:5432` and `127.0.0.1:6379`;
     - resolve DNS and open an HTTPS connection to an outside host;
     - call `os.cpus()` and `os.networkInterfaces()`.

     Loosen a sandboxing option only when the stand-in proves it is needed, and write the reason next to it.
  3. In the same job, show that a Next.js unit cannot read `/etc/velexis/keys` and that the OTA API cannot read `ota-worker.env` or `migrator.env`, and kill the stand-in unit 11 times within 5 minutes so that it enters `failed` and `velexis-alert@` sends its message to a Mailpit service container. Human step: repeat steps 2–3 on the throwaway VM of X-020 and paste the result into the PR.
  4. Make `alert.sh` work with Mailpit for testing. Add `ALERT_SMTP_TLS=required|none` (default `required`) to the script and to `deploy/env/alert.env.example`.
- **Acceptance:**
  - The security exposure of every app unit is 2.0 or lower.
  - The stand-in app under the unit reaches PostgreSQL, Redis and an HTTPS host, and the forbidden files return "Permission denied" or "No such file".
  - In the CI job, killing the unit 11 times within 5 minutes puts it in `failed`, and the alert e-mail arrives in Mailpit with the unit name and the last log lines.
  - `shellcheck -S style deploy/scripts/alert.sh` is clean.
- **Verify:** `systemd-analyze security --offline=true deploy/systemd/velexis-ota-api.service && shellcheck -S style deploy/scripts/alert.sh deploy/systemd/test/units-smoke.sh`

### X-022 · Finalise the Caddyfile with an end-to-end smoke test ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-019
- **Size:** M
- **Read first:** docs/mvp/adr/0018-hosted-storefront-custom-domains.md; docs/mvp/deployment-single-vm.md §6; deploy/caddy/Caddyfile; docs/mvp/decisions.md §4
- **Files:** `deploy/caddy/Caddyfile`, `deploy/caddy/maintenance/index.html`, `deploy/caddy/test/caddy-smoke.sh`, `deploy/caddy/test/echo-upstream.mjs`, `deploy/caddy/test/README.md`, `.github/workflows/ci.yml`
- **Steps:**
  1. Write `deploy/caddy/test/caddy-smoke.sh`. It builds a test copy of the Caddyfile in which only the global options block is replaced by:
     - `local_certs` and `http_port 8080`, `https_port 8443`;
     - an `ask` pointing at the echo server, which answers 200 only for `acme.ota.localhost`;
     - host names from `PLATFORM_BASE_DOMAIN=platform.localhost` and `STOREFRONT_BASE_DOMAIN=ota.localhost`.

     It then starts Caddy 2.8.4 and `echo-upstream.mjs`, a Node server on 3000, 3100 and 4000 that echoes request headers and serves the `ask` answers.
  2. With `curl --resolve … --cacert <Caddy local CA>`, assert:
     - on `acme.ota.localhost`, `/api/x` reaches 4000 with `X-Velexis-Edge` equal to the secret even when the client sends a forged one, and `X-Velexis-Host: acme.ota.localhost`;
     - the storefront has the CSP header, `/assets/a.js` is `immutable` and `/` is `no-cache`;
     - on `acme.ota.localhost`, `/api/internal/x`, `/api//internal/x`, `/api/health/ready` and `/api/health/ready/` give 404 without reaching 4000. Found by the OFE-001 review: Caddy 2.8.4 sorts a bare `respond @api_internal 404` of the `(storefront)` snippet after `handle /api/*`, so before this task these paths reached the OTA API with the edge secret. A matcher in its own `handle` placed before `handle /api/*` fixes it, and the matcher also needs `/api/health/ready/`, because Caddy keeps the trailing slash and Express routes `/health/ready/` like `/health/ready`;
     - on `api.ota.localhost`, `/internal/x` and `/health/ready` give 404 and `/health/live` reaches the upstream; client edge headers are removed;
     - an unknown host (`evil.localhost`) gets no certificate, so the TLS handshake fails;
     - with the upstream stopped, `platform.localhost` serves the maintenance page with 503, and `api.platform.localhost` serves the JSON `SERVICE_UNAVAILABLE` envelope;
     - the admin API answers only on the unix socket: the test copy keeps `admin unix/<tmp>/admin.sock`, `caddy reload --config <test copy>` succeeds through it after a header change (and the change is served), and nothing listens on TCP 2019.
  3. Add a CI step to the `deploy-files` job that runs the smoke script (Caddy is already downloaded there).
  4. Fix any Caddyfile issue the test reveals. Keep `caddy fmt` clean.
- **Acceptance:**
  - `bash deploy/caddy/test/caddy-smoke.sh` passes locally and in CI, with every assertion listed in step 2.
  - `caddy validate` and `caddy fmt --diff` are clean.
  - The production Caddyfile still uses only the placeholder hosts of `decisions.md` §4 as defaults, and its admin API is the unix socket `/run/caddy/admin.sock`.
- **Verify:** `bash deploy/caddy/test/caddy-smoke.sh`

### X-023 · Build the release pipeline and deploy the hello world
- **Status:** in progress (branch claude/intelligent-bardeen-90hhu7; pending: human step 5, the `production` environment and the first **Deploy** from `main` (AC2; X-013, which the M0 release needs for `migrate.js tenants`, is now integrated on this branch); human step 6, the hello-world record: certificate and maintenance page, `velexis-deploy --status`, the ledgers with the baselines and `R__ota_read_access` as `velexis_migrator` (AC3); a second **Deploy** of the same sha that changes nothing (AC4))
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-012, X-020, X-022
- **Size:** L
- **Read first:** docs/mvp/adr/0023-release-artefact-and-deploy-user.md; docs/mvp/adr/0027-pci-scope-and-vm-controls.md (row 6.5); docs/mvp/deployment-single-vm.md §8 and §9; deploy/README.md; deploy/scripts/pack-release.sh; deploy/scripts/deploy.sh; .github/workflows/deploy.yml
- **Files:** `deploy/scripts/pack-release.sh`, `deploy/scripts/deploy.sh`, `deploy/scripts/test/deploy.test.sh`, `deploy/scripts/test/fake-systemctl.sh`, `deploy/scripts/test/fake-app.mjs`, `.github/workflows/deploy.yml`, `.github/workflows/ci.yml`, `deploy/README.md`, `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. Make `deploy.sh` testable without changing its production defaults. Add environment overrides: `VELEXIS_ROOT` (prefix for `/srv/velexis`, `/etc/velexis`, `/var/lib/velexis`, `/var/log/velexis`, `/usr/local/sbin`), `SYSTEMCTL`, `RUN_TRANSIENT` (replaces the transient `systemd-run` user of X-033 in tests) and `HEALTH_HOST`.
  2. Write `deploy/scripts/test/deploy.test.sh` (bash, no root). It uses `fake-systemctl.sh`, which starts and stops `fake-app.mjs` processes that answer `/health/ready` on the unit's port, healthy or not depending on a flag file. Cases:
     - happy path, with migrations run through a fake `db/dist/cli/migrate.js` that records its arguments;
     - a tampered file → `SHA256SUMS` refusal, `current` unchanged;
     - an unhealthy app → automatic rollback to the previous release, exit 1;
     - `--rollback`;
     - a failing migration → no switch, and the running release's units are re-installed from its snapshot;
     - a Node major mismatch → refusal;
     - an env file without a variable that the release's `deploy/env` template names → refusal before anything changes, with the variable named in the message; a template with only comments (optional file) is ignored;
     - rollback (automatic and `--rollback`) re-installs the target release's unit files and Caddyfile from `/var/lib/velexis/system/<sha>/` before the restart (a unit changed between two fake releases is back to the old content), and a staged new Caddyfile is never activated by a rollback;
     - re-deploying a release already on the VM re-installs its snapshot;
     - a masked unit is skipped;
     - pruning keeps 5 releases and their snapshots, and never the active one.
  3. Add a CI step that runs `deploy.test.sh` in the `deploy-files` job.
  4. Keep `.github/workflows/deploy.yml` in the two-job shape of ADR-0023 (build without secrets, deploy job that only downloads, re-checks and uploads; refs `main` and `v*` only; actions pinned by SHA) and make it work end to end; check with `actionlint`.
  5. Human step: the developer creates the GitHub `production` environment with secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS`, themself as required reviewer, and a deployment branch policy for `main` and tags `v*`. They then run **Deploy** from `main`.
  6. Record the hello-world result in the PR:
     - `curl -sI https://platform.example.com/` (real host) shows a valid certificate and the maintenance page;
     - `velexis-deploy --status` shows the sha;
     - `psql` lists the `platform` and `reference` ledgers with `0001_baseline`.
- **Acceptance:**
  - `deploy.test.sh` passes locally and in CI, covering every case in step 2.
  - The Deploy workflow uploads, activates and smoke-checks the M0 release on the VM. `/srv/velexis/current` points at it, and it is read-only and owned by `root:velexis` (ADR-0026). The build job has no access to the deploy secrets, and a run from another branch is refused.
  - Migrations ran as `velexis_migrator` on the VM: the ledgers show the baselines and `R__ota_read_access`.
  - A second Deploy of the same sha succeeds and changes nothing.
- **Verify:** `bash deploy/scripts/test/deploy.test.sh`

### X-033 · Run each trust zone under its own system user ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M0
- **Depends on:** X-021
- **Size:** L
- **Read first:** docs/mvp/adr/0026-system-users-per-trust-zone.md; docs/mvp/adr/0023-release-artefact-and-deploy-user.md (Secrets per process); docs/mvp/adr/0010-secrets-envelope-encryption.md (Key material on the VM); docs/mvp/deployment-single-vm.md §4 and §7; deploy/scripts/provision-vm.sh (step_users, step_keys, step_envfiles); deploy/systemd/
- **Files:** `deploy/scripts/provision-vm.sh`, `deploy/scripts/deploy.sh`, `deploy/scripts/run-as.sh`, `deploy/systemd/velexis-platform-api.service`, `deploy/systemd/velexis-platform-worker.service`, `deploy/systemd/velexis-portal.service`, `deploy/systemd/velexis-platform-admin.service`, `deploy/systemd/velexis-ota-api.service`, `deploy/systemd/velexis-ota-worker.service`, `deploy/systemd/velexis-ota-admin.service`, `deploy/env/platform-backend.env.example`, `deploy/env/ota-backend.env.example`, `deploy/env/migrator.env.example`, `deploy/env/reference-loader.env.example`, `deploy/systemd/test/units-smoke.sh`, `deploy/README.md`, `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. In `provision-vm.sh` `step_users`, create the system users of ADR-0026 (`velexis-platform`, `velexis-ota`, `velexis-portal`, `velexis-platform-admin`, `velexis-ota-admin`; no shell, no password) and the group `velexis`, whose only members are those five users and whose only purpose is reading releases. Directories: `/etc/velexis` and `/etc/velexis/keys` `0711 root:root`, `/etc/velexis/keys/platform` `0500 velexis-platform`, `/etc/velexis/keys/ota` `0500 velexis-ota`, `/srv/velexis/releases` `0751 root:velexis`, `/var/lib/velexis/storage` `0700 velexis-ota`.
  2. In `step_keys`, generate `master-v1.key` and `api-key-pepper` once and install identical copies in both zone folders; the platform JWT key only in `platform/`, the OTA JWT key and `document-url.key` only in `ota/`; every file `0400` owned by its zone's user; existing files are never overwritten. Point `MASTER_KEY_DIR` and the `*_FILE` variables of the two backend templates at the zone folders.
  3. In `step_envfiles`, make every env file `root:root 0600` (systemd reads them before it drops privileges). Move `REFERENCE_DATABASE_URL` out of `migrator.env` into a new root-only `reference-loader.env` (`DATABASE_URL` with the platform role) so each one-off process gets exactly one DSN.
  4. In the seven unit files, set `User=` and `Group=` to the zone's user, `SupplementaryGroups=velexis`, keep `ProtectProc=invisible`, update `InaccessiblePaths=` to the other zones' key folders and env files, and replace the comment "all apps share the `velexis` user" with the ADR-0026 boundary.
  5. In `deploy.sh`, hand releases over as `root:velexis` (`u=rX,g=rX,o=`, storefront `o+rX`). Run the migrations and the reference loader as transient units with `systemd-run --pipe --wait --collect -p DynamicUser=yes -p SupplementaryGroups=velexis -p EnvironmentFile=/etc/velexis/migrator.env` (or `reference-loader.env`), so the migrator DSN is never in the environment of a process that an app user owns and never on a command line.
  6. Write `deploy/scripts/run-as.sh`, installed as `/usr/local/sbin/velexis-run <zone> <command…>`: it runs a one-off command (for example `node dist/cli.js admin:grant <email>`) with `systemd-run` as the zone's user, with the zone's env files, working directory and the units' sandbox basics, and returns the command's exit code. Install it in `step_scripts` and from `deploy.sh` like the other root-owned scripts.
  7. Extend `deploy/systemd/test/units-smoke.sh` (X-021) with the cross-zone checks below, and update `deploy/README.md` and `deployment-single-vm.md` §4 and §7 wherever reality differs.
- **Acceptance:**
  - In the CI units job, a stand-in process running as `velexis-portal` gets "Permission denied" or "No such process" for the OTA stand-in's `/proc/<pid>/environ`, for `/proc/<pid>/root/etc/velexis/keys/ota/master-v1.key` and for every `/etc/velexis/*.env`; `velexis-platform` cannot list `/etc/velexis/keys/ota/`.
  - `provision-vm.sh` creates both key folders with identical master-key and pepper copies (same SHA-256), modes `0500`/`0400`, and a second run changes no key file.
  - Env files are `root:root 0600`, and every unit still starts with its variables (the stand-in prints the variable names it sees, never values).
  - During a test deploy, no process owned by an app user has `DATABASE_MIGRATOR_URL` in its environment (the migration runs as a transient dynamic user).
  - `velexis-run platform node -e "process.exit(3)"` runs as `velexis-platform` and exits 3.
  - `shellcheck -S style` is clean for every changed script.
- **Verify:** `shellcheck -S style deploy/scripts/provision-vm.sh deploy/scripts/deploy.sh deploy/scripts/run-as.sh deploy/systemd/test/units-smoke.sh && sudo bash deploy/systemd/test/units-smoke.sh`

## M1 Platform core

### X-024 · Finalise backups and run the first off-VM backup
- **Status:** todo
- **Component:** foundation
- **Milestone:** M1
- **Depends on:** X-023
- **Size:** M
- **Read first:** docs/mvp/deployment-single-vm.md §10 and §11; docs/mvp/adr/0007-single-vm-without-docker.md (Backups); docs/mvp/adr/0010-secrets-envelope-encryption.md (backup of the master key); deploy/scripts/backup.sh; deploy/scripts/restore.sh
- **Files:** `deploy/scripts/backup.sh`, `deploy/scripts/restore.sh`, `deploy/scripts/test/backup-restore.test.sh`, `deploy/env/backup.env.example`, `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. Make both scripts testable without changing their VM defaults: overridable `PG_DATABASE`, `BACKUP_DIR`, `STORAGE_DIR`, `REDIS_AOF_DIR`, a `PG_RUNAS` command (default `runuser -u postgres --`), and `SKIP_REDIS=1` for machines without an AOF directory.
  2. Write `deploy/scripts/test/backup-restore.test.sh` for the local development database:
     - two `age-keygen` keys in a temp folder and an rclone remote of type `local` (a temp folder) through a temp `RCLONE_CONFIG`;
     - run `backup.sh`, check the five `.age` files and `MANIFEST.txt` locally and on the remote;
     - run `restore.sh drill` and compare its figures with the source database;
     - flip a byte in an `.age` file and expect `restore.sh` to refuse;
     - check that `backup.sh` issues no delete on the remote: the test remote is wrapped so that any delete fails the test, and the script contains no `rclone delete`, `purge` or `rmdirs` (retention is the bucket's job);
     - check that using the same key for data and config is refused;
     - `restore.sh db --replace-live` against a scratch "live" database: a corrupt `.age` file, a wrong identity and a failing `pg_restore` each stop the script with the live database unchanged and still connectable; a good set swaps the names, keeps `<db>_before_restore_<stamp>`, and the database-level grants of `bootstrap.sql` are present on the new one.
  3. Human step: the developer creates the bucket with versioning, object lock and the lifecycle rules of `deployment-single-vm.md` §10, and an access key with put, list and get rights only; then, on the VM, installs the two age public keys and the rclone remote, runs `systemctl start velexis-backup`, and checks the bucket and the marker file. They also try `rclone delete` with the VM's key and record that it is refused.
  4. Update §10 and §11 with anything learned (bucket settings, duration, sizes).
- **Acceptance:**
  - `backup-restore.test.sh` passes locally with every case listed in step 2.
  - On the VM the first backup set is in `<remote>/daily/<date>/`, `rclone check` passes, and `/var/lib/velexis/backup-last-success` is updated (human step, output in the PR without secrets).
  - No private age key exists on the VM (`find / -name '*.key' -path '*age*'` shows none; human step).
  - A delete with the VM's bucket key is refused by the bucket (human step, output in the PR).
- **Verify:** `bash deploy/scripts/test/backup-restore.test.sh && shellcheck -S style deploy/scripts/backup.sh deploy/scripts/restore.sh`

### X-025 · Add Mailpit helpers to @velexis/testing ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M1
- **Depends on:** X-015
- **Size:** S
- **Read first:** docs/mvp/adr/0015-testing-strategy.md (E-mail); docs/mvp/adr/0017-email-documents-storage.md; docs/mvp/local-development.md §4; packages/README.md (`@velexis/testing`)
- **Files:** `packages/testing/src/mailpit.ts`, `packages/testing/src/mailpit.test.ts`, `packages/testing/test/integration/mailpit.int.test.ts`, `packages/testing/package.json`, `packages/testing/README.md`
- **Steps:**
  1. Write `mailpit` in `src/mailpit.ts` over the Mailpit API v1 (`MAILPIT_API_URL`), using `fetch` only:
     - `search({ to, subject })` with `GET /api/v1/search?query=…`;
     - `get(id)` with `GET /api/v1/message/{id}`;
     - `clear()` with `DELETE /api/v1/messages`.
  2. Write `waitForMessage({ to, subject, timeoutMs = 5000 })`. It polls every 100 ms until the timeout, with no fixed sleeps, and throws an error that lists the messages it did see.
  3. Write `uniqueEmail(label)`, which returns `label+<uuid>@example.com`, so parallel test files never read each other's mail. Write `extractLinks(message)`, which returns the `href`s of the HTML part and the URLs of the text part.
  4. Export the helpers as the subpath `@velexis/testing/mailpit`.
- **Acceptance:**
  - An integration test sends one e-mail with `nodemailer` to Mailpit and finds it with `waitForMessage` by recipient and subject regex, with its verification link extracted.
  - `waitForMessage` for a recipient that never gets mail fails after the timeout with a readable message.
  - Two parallel test files using `uniqueEmail` never see each other's messages.
- **Verify:** `pnpm --filter @velexis/testing test && pnpm --filter @velexis/testing test:int`

### X-026 · Build the Amadeus stub server skeleton ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** foundation
- **Milestone:** M1
- **Depends on:** X-001
- **Size:** L
- **Read first:** docs/mvp/adr/0015-testing-strategy.md (Amadeus stub server); docs/mvp/adr/0012-amadeus-account-model.md; docs/amadeus-api/FlightOffersSearch_v2_Version_1.0_swagger_specification.json (grep `paths`, `parameters`); docs/amadeus-api/*.json (grep the `paths` keys only); ota/backend/openapi/velexis-ota-booking-api.openapi.yaml (grep `x-amadeus`)
- **Files:** `tools/amadeus-stub/package.json`, `tools/amadeus-stub/tsconfig.json`, `tools/amadeus-stub/vitest.config.ts`, `tools/amadeus-stub/src/index.ts`, `tools/amadeus-stub/src/server.ts`, `tools/amadeus-stub/src/oauth.ts`, `tools/amadeus-stub/src/routes.ts`, `tools/amadeus-stub/src/scenarios.ts`, `tools/amadeus-stub/src/validate.ts`, `tools/amadeus-stub/src/cli.ts`, `tools/amadeus-stub/fixtures/flight-offers-search/success.json`, `tools/amadeus-stub/fixtures/README.md`, `tools/amadeus-stub/test/server.test.ts`, `tools/amadeus-stub/README.md`
- **Steps:**
  1. Create `@velexis/amadeus-stub`: a Node `http` server with no framework. Export `createStubServer({ port })`, which returns `{ url, close() }`. `src/cli.ts` reads `STUB_PORT` (default 4900) and is the `start` script used by the root `pnpm stub:amadeus`.
  2. OAuth: `POST /v1/security/oauth2/token` with `grant_type=client_credentials` returns `access_token`, `token_type`, `expires_in: 1799` and `state: approved`. Missing credentials give 401 in the Amadeus error format. API calls without a bearer token give 401.
  3. In `src/routes.ts`, build a route table of all 12 operations from the 9 specifications. M1 needs the OAuth endpoint (PBE-020 verifies credentials against it, PBE-034 seeds an account pointing at it, PFE-014 starts the stub). In this task, implement Flight Offers Search (`GET` and `POST /v2/shopping/flight-offers`) from `fixtures/flight-offers-search/success.json`, which is synthetic data with no personal data. Every other operation answers 501 with an Amadeus-style error saying "not stubbed yet"; the OTA plan's tasks add them.
  4. Write the scenarios in `src/scenarios.ts`:
     - chosen by the header `X-Stub-Scenario`: `server-error` gives 500, `rate-limited` gives 429 with Amadeus code 38194, `timeout` holds the response until the client aborts or 30 s pass;
     - magic values: destination `ZZZ` returns `data: []`.
  5. Validate each request in `src/validate.ts` against the operation's Swagger 2.0 parameters and body schema, using Ajv with `strict: false`. A failure gives 400 in the Amadeus error format, listing the failing parameter, so a malformed request from our client fails loudly.
- **Acceptance:**
  - The token flow works, and a search without a token gives 401.
  - `GET /v2/shopping/flight-offers?originLocationCode=MAD&destinationLocationCode=PAR&departureDate=2027-01-15&adults=1` returns the fixture; the `POST` form works as well.
  - A search without `originLocationCode` returns 400 naming the parameter.
  - Each scenario and the `ZZZ` magic value behave as described, and an unimplemented operation returns 501.
  - The server starts in under 1 s, and `pnpm stub:amadeus` serves on 127.0.0.1:4900.
- **Verify:** `pnpm --filter @velexis/amadeus-stub build && pnpm --filter @velexis/amadeus-stub test`

### X-027 · Add the Amadeus stub client to @velexis/testing
- **Status:** todo
- **Component:** foundation
- **Milestone:** M1
- **Depends on:** X-026, X-015
- **Size:** S
- **Read first:** docs/mvp/adr/0022-shared-test-support-package.md (item 5); tools/amadeus-stub/README.md; packages/README.md (`@velexis/testing`)
- **Files:** `packages/testing/src/amadeus.ts`, `packages/testing/test/integration/amadeus.int.test.ts`, `packages/testing/package.json`, `packages/testing/README.md`
- **Steps:**
  1. Add `@velexis/amadeus-stub` as a `workspace:*` **devDependency** of `@velexis/testing`.
  2. Write `startAmadeusStub({ port = 0 })` in `src/amadeus.ts`. It returns:
     - `{ url, stop(), requests(), setDefaultScenario(name) }`;
     - `requests()` returns the recorded requests (method, path, query, redacted headers) for assertions.
  3. Write `stubScenario(name)`, which returns `{ "X-Stub-Scenario": name }`, with the scenario names typed from the stub package. Export both as the subpath `@velexis/testing/amadeus`.
- **Acceptance:**
  - An integration test starts the stub on a random port, gets a token, runs a search with and without `stubScenario("server-error")`, and asserts on `requests()`.
  - `stop()` frees the port, so the same test can run twice in one process.
- **Verify:** `pnpm --filter @velexis/testing test:int`

### X-035 · Report remaining work and done markers in plan-lint
- **Status:** todo
- **Component:** foundation
- **Milestone:** M1
- **Depends on:** X-001
- **Size:** S
- **Read first:** tools/plan-lint/plan-lint.mjs; docs/mvp/adr/0025-roadmap-scheduling-and-tracking.md (item 6, follow-ups); docs/mvp/plans/roadmap.md §4.3; AGENTS.md §3
- **Files:** `tools/plan-lint/plan-lint.mjs`, `tools/plan-lint/README.md`, `tools/plan-lint/test/plan-lint.test.mjs`, `tools/plan-lint/test/fixtures/plan.md`, `docs/mvp/plans/roadmap.md`, `docs/mvp/plans/README.md`
- **Steps:**
  1. Recognise the done marker: a heading that ends with ` ✅` is a done task; strip the marker from the title. When a task has a Status line, ` ✅` without `done (PR #n)`, or `done (PR #n)` without ` ✅`, is an error.
  2. Print a second summary block: done and total tasks and hours per milestone and per file, remaining hours, and the critical path over tasks without ` ✅` (done tasks count 0 h).
  3. Add `--remaining`: it prints the ready tasks of the lowest open milestone (every dependency done), critical path first, which is the list that AGENTS.md §3 asks agents to pick from.
  4. Write tests with `node:test` (no dependency) on a small fixture plan, and a README for the tool. Update roadmap §4.3 and plans README §4 to use the new output instead of the `grep` count.
- **Acceptance:**
  - On the current plans the output is unchanged apart from the new summary block (0 done).
  - A fixture with 2 of 3 tasks marked ` ✅` reports 1 remaining task, its hours and a critical path without the done tasks; `--remaining` lists it only when its dependencies are done.
  - ` ✅` without `done (PR #n)`, and the reverse, are reported as errors.
  - The tool still runs with plain Node and no `pnpm install`.
- **Verify:** `node --test tools/plan-lint/test/ && node tools/plan-lint/plan-lint.mjs && node tools/plan-lint/plan-lint.mjs --remaining`

## M2 Search & price

### X-034 · Add fixture recording and the personal-data scan to the Amadeus stub
- **Status:** todo
- **Component:** foundation
- **Milestone:** M2
- **Depends on:** X-026
- **Size:** M
- **Read first:** docs/mvp/adr/0015-testing-strategy.md (Amadeus stub server); docs/mvp/local-development.md §5; tools/amadeus-stub/README.md; docs/velexis-sdk/db/README.md §8 (personal data); docs/amadeus-api/FlightCreateOrders_v1_Version_1.16_swagger_specification.json (grep `travelers`, `contacts`, `documents`)
- **Files:** `tools/amadeus-stub/src/record.ts`, `tools/amadeus-stub/src/scrub.ts`, `tools/amadeus-stub/src/cli.ts`, `tools/amadeus-stub/test/scrub.test.ts`, `tools/amadeus-stub/test/fixtures-scan.test.ts`, `tools/amadeus-stub/package.json`, `tools/amadeus-stub/fixtures/README.md`, `tools/amadeus-stub/README.md`, `docs/mvp/local-development.md`
- **Steps:**
  1. Add the CLI command and package script `record <operation> --request <file.json> [--scenario <name>]` (`pnpm --filter @velexis/amadeus-stub record <operation>`). It reads `AMADEUS_RECORD_BASE_URL` (default: the official test host), `AMADEUS_RECORD_CLIENT_ID` and `AMADEUS_RECORD_CLIENT_SECRET` from the environment only, requests a token, sends the request, scrubs the response and writes `fixtures/<operation>/<scenario>.json` with a header (operation, date, `scrubbed: true`). It refuses to run when `CI` is set and never prints the secret or the token.
  2. Write `src/scrub.ts`: it replaces traveller names, dates of birth, document numbers, e-mail addresses (to `@example.com`), phone numbers, postal addresses, record locators and ticket numbers with deterministic synthetic values, and keeps what the tests need (airports, carriers, fare bases, prices, offer ids).
  3. Write `test/fixtures-scan.test.ts`, which runs in `pnpm test` over every committed fixture and fails on an e-mail address outside `example.com`, a run of 13 to 19 digits that is not marked synthetic, a passport-like document number, a phone number outside the reserved test ranges, or a name field whose value is not in the synthetic list.
  4. Document recording, scrubbing and the scan in the stub README, `fixtures/README.md` and `local-development.md` §5.
- **Acceptance:**
  - A recorded-style Flight Create Orders response with names, a passport number, an e-mail address and a phone number comes out of `scrub` with none of them, and the same input always gives the same output (`scrub.test.ts`).
  - The fixture scan passes on the committed fixtures and fails on a copy with a real-looking e-mail address, a 16-digit number and a passport number.
  - `record` exits non-zero with a clear message when `CI` is set or a credential variable is missing.
- **Verify:** `pnpm --filter @velexis/amadeus-stub build && pnpm --filter @velexis/amadeus-stub test`

### X-036 · Write the second-agent review procedure
- **Status:** todo
- **Component:** foundation
- **Milestone:** M2
- **Depends on:** X-019
- **Size:** S
- **Read first:** docs/mvp/adr/0020-ai-agent-development-workflow.md (Gates and permissions, Follow-ups); docs/mvp/conventions.md §12; docs/mvp/plans/roadmap.md (M3, Human review gates); AGENTS.md §5 and §8; .github/pull_request_template.md
- **Files:** `docs/mvp/runbooks/second-agent-review.md`, `docs/mvp/runbooks/second-agent-review-prompt.md`, `.github/pull_request_template.md`, `AGENTS.md`
- **Steps:**
  1. Write the procedure: when it is required (the deep-review PRs of M3 that the roadmap lists) and when it is optional; how it runs (a fresh agent session with read-only access to the repository and no secrets gets the PR diff, the task block, the security checklist and the prompt file); its output (one PR comment listing findings with severity, file, line and failure scenario, or an explicit "no findings"); and what the developer does with it (every high finding is fixed or answered before the merge).
  2. Write the prompt file: the checks for money and card code (card data never logged, stored or queued; idempotent Amadeus and Stripe writes; webhook signatures and de-duplication; no duplicate order or double charge in the timeout paths; tenant isolation; token handling), and the rule that the reviewing session never pushes commits.
  3. Link the procedure from AGENTS.md and from the PR template's checkbox.
- **Acceptance:**
  - The procedure and the prompt exist and are linked from AGENTS.md and the PR template.
  - A dry run on one merged M2 PR (human step: the developer starts the session) produces a findings comment in the described format; the PR records it.
- **Verify:** `test -f docs/mvp/runbooks/second-agent-review.md && test -f docs/mvp/runbooks/second-agent-review-prompt.md && grep -q second-agent-review AGENTS.md`

## M3 Book & pay

### X-028 · Add the Stripe CLI workflow and signed webhook fixtures
- **Status:** todo
- **Component:** foundation
- **Milestone:** M3
- **Depends on:** X-015
- **Size:** M
- **Read first:** docs/mvp/adr/0011-payments-stripe-and-airline-card.md; docs/mvp/adr/0013-subscription-billing-stripe-billing.md; docs/mvp/architecture.md §5 (d) (webhook table); docs/mvp/adr/0015-testing-strategy.md (Stripe); docs/mvp/local-development.md §6
- **Files:** `packages/testing/src/stripe.ts`, `packages/testing/src/stripe.test.ts`, `packages/testing/fixtures/stripe/payment_intent.amount_capturable_updated.json`, `packages/testing/fixtures/stripe/payment_intent.succeeded.json`, `packages/testing/fixtures/stripe/payment_intent.payment_failed.json`, `packages/testing/fixtures/stripe/charge.refunded.json`, `packages/testing/fixtures/stripe/charge.dispute.created.json`, `packages/testing/fixtures/stripe/checkout.session.completed.json`, `packages/testing/fixtures/stripe/customer.subscription.updated.json`, `packages/testing/fixtures/stripe/invoice.paid.json`, `packages/testing/fixtures/README.md`, `packages/testing/package.json`, `tools/dev/stripe-listen.sh`, `docs/mvp/local-development.md`
- **Steps:**
  1. Write the event fixtures, one per event type in the webhook table of `architecture.md` §5 (d). They are synthetic, with ids like `evt_test_…` and `pi_test_…`, `metadata.velexis_tenant_id` set to `ten_test_alpha`, and no real customer data. `fixtures/README.md` explains how to refresh them from `stripe trigger` output and scrub them.
  2. Write `signedStripeEvent(type, overrides, secret)` in `src/stripe.ts`:
     - it deep-merges the overrides into the fixture and serialises once;
     - it returns `{ payload, header }`, where `header` comes from `stripe.webhooks.generateTestHeaderString`;
     - `stripe` 18.x is an exact devDependency.
  3. Write `tools/dev/stripe-listen.sh`. It starts `stripe listen` for `localhost:4000/webhooks/stripe/velexis/test` and `localhost:3100/webhooks/stripe/billing`, and prints the `whsec_` secrets to put into `.env.local`. Document it in `local-development.md` §6.
  4. Export the helper as the subpath `@velexis/testing/stripe`.
- **Acceptance:**
  - `stripe.webhooks.constructEvent(payload, header, secret)` accepts every fixture, and rejects a payload changed after signing.
  - The fixtures cover every event type of the webhook table, and none contains a real key, e-mail address or card number (a test scans for `sk_live`, `@` outside `example.com`, and 13–19 digit runs).
  - `shellcheck -S style tools/dev/stripe-listen.sh` is clean.
- **Verify:** `pnpm --filter @velexis/testing test && shellcheck -S style tools/dev/stripe-listen.sh`

## M6 Hardening & launch

### X-029 · Set up external uptime monitoring
- **Status:** todo
- **Component:** foundation
- **Milestone:** M6
- **Depends on:** X-024
- **Size:** S
- **Read first:** docs/mvp/adr/0016-observability.md (Metrics and alerting); docs/mvp/deployment-single-vm.md §13
- **Files:** `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. Human step: the developer picks an HTTP uptime service (free tier is fine) and creates monitors, checked once a minute: `https://api.platform.example.com/health/live`, `https://api.ota.example.com/health/live`, the portal and one demo storefront, all on the real hosts (the repository keeps the placeholders; the real API hosts are given to the Verify command as `REAL_PLATFORM_API_HOST` and `REAL_OTA_API_HOST`). Alerts go by e-mail and push.
  2. Test the alerting: stop `velexis-ota-api` for 3 minutes during a quiet hour and confirm the alert and the recovery notice.
  3. Update §13 with the service, the monitors, who receives alerts, and the result of the test. Store no credentials in the repository.
- **Acceptance:**
  - Four monitors exist and are green.
  - The test outage produced an alert within 3 minutes and a recovery notice.
  - §13 lists the monitors and the alert recipients.
- **Verify:** `curl -fsS "https://${REAL_PLATFORM_API_HOST:?}/health/live" && curl -fsS "https://${REAL_OTA_API_HOST:?}/health/live"` (human step: run by the developer with the real host names)

### X-030 · Add the on-VM health check timer
- **Status:** todo
- **Component:** foundation
- **Milestone:** M6
- **Depends on:** X-024, X-021
- **Size:** M
- **Read first:** docs/mvp/adr/0016-observability.md (On-VM check); docs/mvp/adr/0011-payments-stripe-and-airline-card.md §C (payment page integrity); docs/mvp/deployment-single-vm.md §13; deploy/scripts/alert.sh
- **Files:** `deploy/scripts/healthcheck.sh`, `deploy/systemd/velexis-healthcheck.service`, `deploy/systemd/velexis-healthcheck.timer`, `deploy/scripts/test/healthcheck.test.sh`, `deploy/scripts/provision-vm.sh`, `deploy/scripts/deploy.sh`, `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. Write `deploy/scripts/healthcheck.sh` (root-owned copy `/usr/local/sbin/velexis-healthcheck`). It checks:
     - `/health/ready` of every **enabled** Velexis unit;
     - disk use above 80 % for `/` and `/var/lib/postgresql`;
     - Redis `used_memory` above 70 % of `maxmemory`;
     - backup marker older than 26 h;
     - more than 20 failed jobs in the last hour, read from the workers' `/health/ready` JSON;
     - TLS expiry within 14 days for the five named hosts (`openssl s_client`);
     - once a day, the payment page check against `storefront/payment-page-inventory.json` of the current release (OFE-023): it fetches **both** payment pages of the demo storefront (`/checkout/pay-card.html` and `/checkout/pay-airline.html`), compares each page's ordered `<script src>` list with the inventory, fetches every first-party script they reference and compares its SHA-256 with the inventory's hash, and compares the full `Content-Security-Policy` and the other security headers **per path** with the inventory. Any difference raises an alert naming the page and the item. When the inventory is missing (before the OTA plan adds it) the check is skipped with a warning.
  2. Alert only on changes. A state file per check in `/var/lib/velexis/healthcheck/` sends one alert on `ok → fail` and one recovery on `fail → ok`, through `velexis-alert message`.
  3. Add `velexis-healthcheck.service` (oneshot, root) and `.timer` (every 5 minutes). Install and enable them in `provision-vm.sh` (`step_scripts`) and re-install them in `deploy.sh`, like the other root-owned scripts.
  4. Write `deploy/scripts/test/healthcheck.test.sh`. With fake endpoints and a temp state folder, it covers a failing disk check, a recovery and alert de-duplication, and for the payment page check: a changed script body under the same file name, an extra script, a changed CSP on `/checkout/pay-airline.html` only, and a clean pass.
- **Acceptance:**
  - The test passes and shows exactly one alert per transition.
  - A script body changed in place (same hashed file name) and a path-specific CSP change each raise a payment-page alert that names the page and the script or header.
  - On the VM (human step), stopping `velexis-platform-worker` produces one alert within 10 minutes and one recovery after it restarts.
  - `shellcheck -S style` is clean, and `systemd-analyze verify` reports only the expected missing binaries off the VM.
- **Verify:** `bash deploy/scripts/test/healthcheck.test.sh && shellcheck -S style deploy/scripts/healthcheck.sh`

### X-031 · Run and document the restore drill
- **Status:** todo
- **Component:** foundation
- **Milestone:** M6
- **Depends on:** X-024
- **Size:** M
- **Read first:** docs/mvp/deployment-single-vm.md §3, §10 and §11; docs/mvp/adr/0007-single-vm-without-docker.md (Backups: restore drill); docs/velexis-sdk/db/README.md §7
- **Files:** `docs/mvp/runbooks/restore-drill.md`, `docs/mvp/deployment-single-vm.md`, `deploy/scripts/restore.sh`
- **Steps:**
  1. Write `docs/mvp/runbooks/restore-drill.md` as a checklist with timing columns:
     - provision a scratch VM with `provision-vm.sh`, without DNS records;
     - fetch last night's set and restore config, database and storage;
     - **before starting any unit**: `ufw default deny outgoing` with allow rules only for DNS, the package mirrors and the backup bucket; point `AMADEUS_BASE_URL_TEST` and `AMADEUS_BASE_URL_LIVE` at a black hole (`http://127.0.0.1:9`); point `SMTP_URL` at a sink; replace every Stripe key and webhook secret with test-mode values; and mask both workers (`systemctl mask velexis-platform-worker velexis-ota-worker`), whose schedulers (`ticketing.scan`, `bookings.sync_scan`, `queues.poll`, `bookings.reconcile_scan`) would otherwise call live Amadeus with the restored credentials and could issue tickets that production has since cancelled;
     - deploy the same sha and run the checks;
     - destroy the VM and `shred -u` the private keys.
  2. Human step: the developer runs the drill and records the start and end time of every step, the measured RTO, and the figures from `velexis-restore drill` compared with the manifest.
  3. Also rehearse the single-tenant restore of db README §7 on the scratch VM for one demo tenant, and record the commands that worked.
  4. Fix any problem found in `restore.sh` or §11. Every other issue becomes a new task in the right plan.
- **Acceptance:**
  - The drill log is in the runbook with date, duration per step and total RTO, and the RTO is 4 hours or less.
  - The restored tenant count, schema count and last audit time match the manifest of the set.
  - The single-tenant restore steps are verified and written down.
  - No Amadeus or Stripe live call was made from the scratch VM during the drill: the journal shows refused outbound connections only, and the restored `supplier_requests` have no row newer than the backup.
  - A deliberately failed `db --replace-live` (corrupt file) on the scratch VM left its live database intact (`deployment-single-vm.md` §11).
- **Verify:** `sudo /usr/local/sbin/velexis-restore drill /root/restore/set --identity /root/restore/velexis-data.key` (human step: run by the developer on the scratch VM)

### X-032 · Prove that the move to managed services is configuration only
- **Status:** todo
- **Component:** foundation
- **Milestone:** M6
- **Depends on:** X-023, X-015
- **Size:** S
- **Read first:** docs/mvp/decisions.md §2 (Hosting); docs/mvp/deployment-single-vm.md §15; docs/mvp/adr/0007-single-vm-without-docker.md (Moving to managed services later); docs/mvp/adr/0017-email-documents-storage.md (Storage)
- **Files:** `tools/ci/check-no-hardcoded-hosts.mjs`, `.github/workflows/ci.yml`, `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. Write `tools/ci/check-no-hardcoded-hosts.mjs`. It fails when `localhost`, `127.0.0.1`, `:5432` or `:6379` appear in `platform/*/src`, `ota/*/src` or `packages/*/src`, outside configuration defaults that `@velexis/config` marks as development-only, and outside tests.
  2. Add a CI job `alt-hosts` that runs `pnpm test:int` with PostgreSQL and Redis reached through other host names and ports. Add `/etc/hosts` aliases `pg.internal.test` and `redis.internal.test`, map the services to ports 6543 and 6380, and use `?sslmode=prefer` in the DSNs.
  3. Walk through §15 against the code and update it: every step must be a change to an env file, `STORAGE_DRIVER` or the `KeyProvider`, never a code change.
- **Acceptance:**
  - `check-no-hardcoded-hosts.mjs` passes on `main` and fails on a test commit that hard-codes `127.0.0.1:5432` in `platform/backend/src`.
  - The `alt-hosts` job is green.
  - §15 lists only configuration changes.
- **Verify:** `node tools/ci/check-no-hardcoded-hosts.mjs`

### X-037 · Require a second factor for administrative SSH
- **Status:** todo
- **Component:** foundation
- **Milestone:** M6
- **Depends on:** X-020
- **Size:** M
- **Read first:** docs/mvp/adr/0027-pci-scope-and-vm-controls.md (rows 8.4.2 and 8.6); docs/mvp/deployment-single-vm.md §2 and §3; deploy/scripts/provision-vm.sh (step_harden); deploy/scripts/check-vm.sh
- **Files:** `deploy/scripts/provision-vm.sh`, `deploy/scripts/check-vm.sh`, `docs/mvp/runbooks/ssh-access.md`, `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. In `step_harden`, write an sshd drop-in chosen by `ADMIN_MFA=fido2|totp`. `fido2`: the admin user's `authorized_keys` accepts only `sk-ssh-ed25519@openssh.com` keys, each with the `verify-required` option. `totp`: `AuthenticationMethods publickey,keyboard-interactive:pam` for the admin user with `libpam-google-authenticator`. For `deploy`: `Match User deploy` with `AuthenticationMethods publickey`, no TTY and no forwarding (a system account used only by the deploy job, PCI 8.6).
  2. Make the change impossible to lock out: refuse to apply it while the admin user has no enrolled FIDO2 key or TOTP secret (print the enrolment steps instead), validate with `sshd -t`, and reload `ssh` without closing the current session.
  3. Extend `check-vm.sh`: `sshd -T -C user=<admin>` shows the second factor, and `sshd -T -C user=deploy` shows public key only.
  4. Write `docs/mvp/runbooks/ssh-access.md`: enrolment, a second key as backup, break-glass through the provider's console (with MFA on the provider account), removal of a lost key. Update `deployment-single-vm.md` §2 and §3.
- **Acceptance:**
  - On the throwaway VM (human step): an admin login with a plain ed25519 key alone is refused, and with the FIDO2 key (or key and TOTP) it succeeds; the Deploy workflow still deploys.
  - `check-vm.sh` reports PASS for both users' methods.
  - Without an enrolled factor, `provision-vm.sh` leaves sshd unchanged and says why.
  - `shellcheck -S style` is clean.
- **Verify:** `shellcheck -S style deploy/scripts/provision-vm.sh deploy/scripts/check-vm.sh`

### X-038 · Ship security logs off the VM with 12-month retention and a daily review
- **Status:** todo
- **Component:** foundation
- **Milestone:** M6
- **Depends on:** X-024, X-030, X-037, X-039
- **Size:** L
- **Read first:** docs/mvp/adr/0027-pci-scope-and-vm-controls.md (rows 10.x); docs/mvp/adr/0016-observability.md; docs/mvp/deployment-single-vm.md §10, §12 and §13; deploy/scripts/backup.sh; deploy/scripts/alert.sh
- **Files:** `deploy/scripts/ship-logs.sh`, `deploy/scripts/log-review.sh`, `deploy/systemd/velexis-ship-logs.service`, `deploy/systemd/velexis-ship-logs.timer`, `deploy/systemd/velexis-log-review.service`, `deploy/systemd/velexis-log-review.timer`, `deploy/scripts/provision-vm.sh`, `deploy/scripts/deploy.sh`, `deploy/scripts/test/ship-logs.test.sh`, `deploy/scripts/test/log-review.test.sh`, `deploy/env/backup.env.example`, `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. Write `ship-logs.sh` (hourly, root). Since the saved journald cursor it exports the entries of `ssh`, `sudo`, `auditd`, `caddy` (access and WAF logs), the `velexis-*` units at warning and above, and every line with `"security":true`. It appends them to a daily compressed file in `/var/log/velexis/security/` (kept 90 days), encrypts the hour's chunk to the data age key, uploads it to `<remote>/logs/<yyyy>/<mm>/<dd>/` with `--immutable`, and saves the cursor only after a verified upload.
  2. Human step: add a `logs/` lifecycle rule of 400 days to the bucket and make sure object lock covers 12 months for that prefix; the VM's key still cannot delete.
  3. Write `log-review.sh` (daily, root). It summarises the last 24 hours (failed and accepted SSH logins by user and source, sudo commands, auditd hits on the watched keys, AIDE changes, unit failures, WAF blocks by rule, 4xx and 5xx counts on the airline-card route) and sends the summary through `velexis-alert message`. It alerts at once, in a separate message, on a root login, a new SSH key, a change under `/etc/velexis/keys`, an AIDE change outside a deploy, and a log shipment that failed or is older than two hours.
  4. Install the scripts and timers in `provision-vm.sh` and re-install them from `deploy.sh`, like the other root-owned scripts. Alert when `/var/log/velexis/security/` grows above 5 GB.
  5. Write the two tests with a fake journal export and a local rclone remote: cursor handling (no lost and no duplicated entries after a failed upload), the summary, and each immediate alert.
- **Acceptance:**
  - After an upload failure the cursor stays, and the next run ships the missed entries exactly once (`ship-logs.test.sh`).
  - Each critical event above produces one immediate alert, and a quiet day produces one summary (`log-review.test.sh`).
  - On the VM (human step): an hour after a test SSH login its line is in the bucket, and the next daily summary lists it.
  - `shellcheck -S style` is clean, and `systemd-analyze verify` reports only the expected missing binaries off the VM.
- **Verify:** `bash deploy/scripts/test/ship-logs.test.sh && bash deploy/scripts/test/log-review.test.sh && shellcheck -S style deploy/scripts/ship-logs.sh deploy/scripts/log-review.sh`

### X-039 · Put a web application firewall in front of the public hosts
- **Status:** todo
- **Component:** foundation
- **Milestone:** M6
- **Depends on:** X-022, X-023
- **Size:** L
- **Read first:** docs/mvp/adr/0027-pci-scope-and-vm-controls.md (row 6.4.2); docs/mvp/adr/0018-hosted-storefront-custom-domains.md; docs/mvp/deployment-single-vm.md §6; deploy/caddy/Caddyfile; deploy/caddy/test/caddy-smoke.sh; deploy/scripts/pack-release.sh
- **Files:** `deploy/caddy/Caddyfile`, `deploy/caddy/waf/coraza.conf`, `deploy/caddy/waf/exclusions.conf`, `deploy/caddy/build/build-caddy.sh`, `deploy/caddy/build/versions.env`, `deploy/caddy/test/caddy-smoke.sh`, `deploy/scripts/pack-release.sh`, `deploy/scripts/deploy.sh`, `deploy/scripts/provision-vm.sh`, `deploy/scripts/test/deploy.test.sh`, `.github/workflows/ci.yml`, `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. Write `build-caddy.sh`: build Caddy 2.8.x with `xcaddy` and `github.com/corazawaf/coraza-caddy/v2`, at the versions (Go toolchain included) pinned in `versions.env`, reproducibly (`-trimpath`, fixed build time); print the binary's SHA-256. `pack-release.sh` runs it in the build job of `deploy.yml` and puts `caddy/bin/caddy` in the release.
  2. `deploy.sh` installs the binary root-owned as `/usr/local/bin/caddy-velexis` from the root-owned snapshot when its checksum changes, validates the Caddyfile with it, and restarts Caddy (a new binary needs a restart). `provision-vm.sh` points the Caddy service at it once (`dpkg-divert` of `/usr/bin/caddy`).
  3. In the Caddyfile: `order coraza_waf first`; the OWASP Core Rule Set v4 at paranoia level 1 with `coraza.conf` in `DetectionOnly` for every public host and blocking (`On`) for the storefront `/api/*`, `/checkout/*` and `api.ota.example.com`; the WAF audit log to journald without bodies; exclusions by rule id in `exclusions.conf`, each with its reason.
  4. Extend the smoke test: an SQL-injection and an XSS payload to `/api/x` on a storefront host get 403; the same request on the portal is logged but passes; normal SDK requests pass; the CSP and edge headers behave as in X-022.
  5. Human step: run in detection mode on the VM for at least one week, review the WAF log daily (`journalctl -u caddy`, later the daily summary of X-038), commit exclusions, then switch the listed paths to blocking.
- **Acceptance:**
  - Two builds from the same `versions.env` give the same SHA-256.
  - The smoke test proves blocking on the storefront `/api/*` and detection elsewhere, with the X-022 assertions still green.
  - The deploy test harness covers a changed binary (installed, Caddy restarted) and an unchanged one (no restart).
  - On the VM (human step): one week of detection reviewed, exclusions committed, blocking enabled.
- **Verify:** `bash deploy/caddy/build/build-caddy.sh /tmp/caddy-build && bash deploy/caddy/test/caddy-smoke.sh`

### X-040 · Add the shared re-wrap helper and the master-key rotation runbook
- **Status:** todo
- **Component:** foundation
- **Milestone:** M6
- **Depends on:** X-004, X-033
- **Size:** M
- **Read first:** docs/mvp/adr/0010-secrets-envelope-encryption.md (Rotation); docs/mvp/adr/0026-system-users-per-trust-zone.md (item 2); packages/crypto/README.md; docs/mvp/deployment-single-vm.md §7 and §16
- **Files:** `packages/crypto/src/rewrap-batch.ts`, `packages/crypto/src/rewrap-batch.test.ts`, `packages/crypto/src/index.ts`, `packages/crypto/README.md`, `docs/mvp/runbooks/master-key-rotation.md`, `deploy/scripts/provision-vm.sh`
- **Steps:**
  1. Write `rewrapBatch({ fetch, update, aadFor, keys, batchSize = 500 })`. It fetches rows whose `encryption_key_id` is not the current KEK (keyset pagination), re-wraps each ciphertext with `rewrapValue` and its associated data, and updates ciphertext and `encryption_key_id` with an optimistic check on the old ciphertext. It returns `{ rewrapped, skipped, remainingByKekId }`. No plaintext leaves the function, and it logs counts only. The platform and OTA backends call it from their own `secrets:rewrap` commands (tasks of those plans), because each owns its data.
  2. Add `NEW_MASTER_KEY=v<N>` to `provision-vm.sh --steps keys`: it creates `master-v<N>.key` once and installs identical copies in both zone folders, never overwriting a file.
  3. Write `docs/mvp/runbooks/master-key-rotation.md`: add the key (step 2), set `MASTER_KEY_CURRENT=local:v<N>` in both backend env files, restart, run both backends' `secrets:rewrap`, flush `amadeus:token:*`, check that both report zero rows under the old id, remove the old key files from both folders, back up `/etc/velexis`. Add the order for a suspected compromise: rotate the KEK and every credential an attacker could have read (deployment §16).
  4. Test the helper with an in-memory row source: mixed KEK ids, a concurrent update, a second run.
- **Acceptance:**
  - After `rewrapBatch` every row decrypts with the new KEK alone, `remainingByKekId` has no entry for the old id, and a second run changes nothing.
  - A row changed concurrently is skipped and counted, not overwritten.
  - The runbook names both component commands and the order; `provision-vm.sh` creates the new key in both folders with the same SHA-256.
- **Verify:** `pnpm --filter @velexis/crypto test && shellcheck -S style deploy/scripts/provision-vm.sh`

## Dependency graph

Generated with `node tools/plan-lint/plan-lint.mjs --graph docs/mvp/plans/foundation-tasks.md`.

```mermaid
flowchart LR
  subgraph M0["M0"]
    X_001["X-001"]
    X_002["X-002"]
    X_003["X-003"]
    X_004["X-004"]
    X_005["X-005"]
    X_006["X-006"]
    X_007["X-007"]
    X_008["X-008"]
    X_009["X-009"]
    X_010["X-010"]
    X_011["X-011"]
    X_012["X-012"]
    X_013["X-013"]
    X_014["X-014"]
    X_015["X-015"]
    X_016["X-016"]
    X_017["X-017"]
    X_018["X-018"]
    X_019["X-019"]
    X_020["X-020"]
    X_021["X-021"]
    X_022["X-022"]
    X_023["X-023"]
    X_033["X-033"]
  end
  subgraph M1["M1"]
    X_024["X-024"]
    X_025["X-025"]
    X_026["X-026"]
    X_027["X-027"]
    X_035["X-035"]
  end
  subgraph M2["M2"]
    X_034["X-034"]
    X_036["X-036"]
  end
  subgraph M3["M3"]
    X_028["X-028"]
  end
  subgraph M6["M6"]
    X_029["X-029"]
    X_030["X-030"]
    X_031["X-031"]
    X_032["X-032"]
    X_037["X-037"]
    X_038["X-038"]
    X_039["X-039"]
    X_040["X-040"]
  end
  X_001 --> X_002
  X_001 --> X_003
  X_001 --> X_004
  X_004 --> X_005
  X_001 --> X_006
  X_006 --> X_007
  X_007 --> X_008
  X_008 --> X_009
  X_002 --> X_010
  X_003 --> X_010
  X_016 --> X_010
  X_010 --> X_011
  X_011 --> X_012
  X_012 --> X_013
  X_013 --> X_014
  X_013 --> X_015
  X_008 --> X_015
  X_001 --> X_016
  X_001 --> X_017
  X_017 --> X_018
  X_012 --> X_018
  X_001 --> X_019
  X_021 --> X_020
  X_022 --> X_020
  X_033 --> X_020
  X_001 --> X_021
  X_019 --> X_022
  X_012 --> X_023
  X_020 --> X_023
  X_022 --> X_023
  X_021 --> X_033
  X_023 --> X_024
  X_015 --> X_025
  X_001 --> X_026
  X_026 --> X_027
  X_015 --> X_027
  X_001 --> X_035
  X_026 --> X_034
  X_019 --> X_036
  X_015 --> X_028
  X_024 --> X_029
  X_024 --> X_030
  X_021 --> X_030
  X_024 --> X_031
  X_023 --> X_032
  X_015 --> X_032
  X_020 --> X_037
  X_024 --> X_038
  X_030 --> X_038
  X_037 --> X_038
  X_039 --> X_038
  X_022 --> X_039
  X_023 --> X_039
  X_004 --> X_040
  X_033 --> X_040
```

The critical path printed by plan-lint runs through the database work (X-002 → X-010 → X-011 → X-012 → X-013 → X-015). Start X-016, X-003, X-004, X-006, X-017, X-019 and X-021 in parallel on day one; they do not share files. The VM chain (X-021 → X-033 → X-020 → X-023, 24 agent-hours) also carries the human steps on the VM: start X-033 as soon as X-021 is merged.
