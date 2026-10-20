# OTA agent tasks (`OBE-`, `OFE-`, `OAD-`, `SDK-`)

This plan breaks the OTA group's MVP work (OTA backend, hosted storefront, OTA admin and JS SDK) into small, self-contained tasks for AI coding agents, ordered by the shared milestones M0–M6. Each task names the documents to read, the files to touch, the steps, the acceptance criteria and the command that proves it. Every MVP operation of [`../scope.md`](../scope.md) §3 is implemented by a backend task, exposed by an SDK task and, where people use it, built into a storefront or OTA admin page with a test. Contract changes come before the code that uses them, and every user-facing feature ends in an integration test or a Playwright journey. The plan follows [`decisions.md`](../../../docs/mvp/decisions.md), [ADR-0020](../../../docs/mvp/adr/0020-ai-agent-development-workflow.md) and the [OTA ADRs](../adr/README.md), and is validated by `node tools/plan-lint/plan-lint.mjs`.

Related: [`implementation-plan.md`](implementation-plan.md) (milestones, epics, risks, traceability), [`solo-developer-plan.md`](solo-developer-plan.md) (week by week), [`../scope.md`](../scope.md), [`../architecture.md`](../architecture.md), [`../architecture-booking.md`](../architecture-booking.md), [`../api-changes.md`](../api-changes.md), [`../api-changes-console-and-internal.md`](../api-changes-console-and-internal.md), [`../data-model.md`](../data-model.md), [flows](../README.md#flows), [`../../../docs/mvp/plans/foundation-tasks.md`](../../../docs/mvp/plans/foundation-tasks.md) (`X-` tasks), [`../../../platform/docs/plans/agent-tasks.md`](../../../platform/docs/plans/agent-tasks.md) (`PBE-`, `PFE-`, `PAD-` tasks), [`../../../AGENTS.md`](../../../AGENTS.md).

## How to use this file

1. **Pick** the lowest-milestone task whose **Depends on** tasks are all done (their headings end with ` ✅`) and that nobody has claimed (no open PR, no branch `task/<ID>-*`). Prefer the critical path that `node tools/plan-lint/plan-lint.mjs` prints. Dependencies may be `X-` (foundation) or `PBE-`/`PFE-` (platform) tasks; never fake the other group's side ([AGENTS.md](../../../AGENTS.md) §3).
2. **Claim** it by adding `- **Status:** in progress (PR #n)` under its heading in your PR. plan-lint ignores the extra field.
3. **Finish** it in one branch and one PR (`task/<ID>-<slug>`, [conventions §11](../../../docs/mvp/conventions.md#11-git-workflow)). When the PR is merged, append ` ✅` to the heading (for example `### OBE-012 · Resolve the tenant … ✅`) and set the status line to `done (PR #n)`.
4. **Contract first.** An operation is added to `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml` by a spec task before any handler uses it. Until its handler exists it is listed in `ota/backend/src/common/http/pending-operations.ts` (answers `501 NOT_IMPLEMENTED`); the implementing task removes its entries. At the M4 exit only operations with `x-milestone: deferred` remain, plus the two M5 webhooks that OBE-090 documents ahead of their handler (OBE-078); at the M5 exit only `deferred` ones. A spec task that adds an operation with an `x-sdk-method` also regenerates the SDK route table `ota/sdk/src/internal/operations.js` (the CI check of SDK-002 fails on a stale file) and, when the method's namespace is no longer pending, lists the method in `ota/sdk/test/contract/pending-namespaces.js` with the SDK task that adds it ([ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md), [`../scope.md`](../scope.md) §3).
5. **Tests** end their names with the task and criterion, for example `it("rejects a staff token of another tenant [OBE-060 AC2]")`. Integration tests use a database from `@velexis/testing` with `tenant_alpha` and `tenant_beta`; every tenant repository gets a two-tenant isolation test ([conventions §10](../../../docs/mvp/conventions.md#10-testing)).
6. **New variables** go into `src/config.ts`, the root `.env.example`, the component `.env.example`, `deploy/env/` and the [configuration matrix](../../../docs/mvp/architecture.md#6-configuration-matrix) in the same PR ([conventions §8](../../../docs/mvp/conventions.md#8-configuration)).
7. **After editing this file**, run `node tools/plan-lint/plan-lint.mjs docs/mvp/plans/foundation-tasks.md platform/docs/plans/agent-tasks.md ota/docs/plans/agent-tasks.md` and fix every error. Work found during a task becomes a new task here (next free id of its component).

Common commands: backend `pnpm --filter @velexis/ota-backend test` and `test:int`; storefront `pnpm --filter @velexis/ota-frontend test` and `build`; OTA admin `pnpm --filter @velexis/ota-admin test` and `build`; SDK `pnpm --filter @velexis/ota-sdk typecheck`, `test` and `build`; end to end `E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront` or `--project=ota-admin`.

## Milestone summary

| Milestone | Tasks | Demo at the end |
|---|---|---|
| M0 Foundations | OBE-001, OFE-001, OAD-001, SDK-001 | The four OTA packages build; the backend and the OTA admin answer `/health/live`; the storefront builds to `dist/` within budget; the release contains them. |
| M1 Platform core | OBE-002 … OBE-007 | A tenant created in the portal is provisioned by the real OTA worker: schema, migrations, grants and seeds in one transaction, reported on `platform-tenant-events` (OF-11). |
| M2 Search & price | OBE-008 … OBE-028, SDK-002 … SDK-007, OFE-002 … OFE-008 | On `demo.ota.example.com` (dev) a traveller searches, filters, opens an offer, picks a branded fare and prices it against the Amadeus stub; a suspended tenant shows "temporarily unavailable" (OF-01, OF-02). |
| M3 Book & pay | OBE-029 … OBE-057, SDK-008 … SDK-010, OFE-009 … OFE-019 | Guest and customer bookings paid by Stripe (3-D Secure) or by airline card (test), tickets, e-mails and PDFs, my bookings, guest lookup, change contacts, cancel with refund (OF-03 … OF-08). |
| M4 OTA admin | OBE-058 … OBE-075, OBE-090, OBE-091, SDK-011 … SDK-014, OAD-002 … OAD-017, OFE-020 | "Open console" in the portal lands in the OTA admin; staff issue, cancel, import a PNR, read queues, capture and refund, change markups, branding, pages and templates (OF-09, OF-10). |
| M5 Monetisation & self-service | OBE-076 … OBE-083, OAD-018, OFE-021, OFE-022 | The same code serves an OTA on its own Stripe (Connect or keys) and its own Amadeus credentials, a custom domain, and the live environment after go-live (OF-12). |
| M6 Hardening & launch | OBE-084 … OBE-089, OFE-023 … OFE-026, OAD-019, SDK-015 | Security review and PCI evidence closed, airline card live-ready, erasure job, performance measured, nightly suites green, SDK 1.0.0 published. |

## M0 — Foundations

### OBE-001 · Scaffold the OTA backend with API, worker and CLI entry points ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M0
- **Depends on:** X-002, X-003, X-009, X-010
- **Size:** M
- **Read first:** ota/backend/README.md §1, §2, §3 (M0 rows), §5; ota/docs/architecture.md §1 and §2.1 (`common`, `health`); docs/mvp/conventions.md §2 and §8; docs/mvp/tech-stack.md §2 and §3 (OTA backend); docs/mvp/adr/0016-observability.md (health endpoints)
- **Files:** `ota/backend/package.json`, `ota/backend/nest-cli.json`, `ota/backend/tsconfig.json`, `ota/backend/tsconfig.build.json`, `ota/backend/vitest.config.ts`, `ota/backend/vitest.int.config.ts`, `ota/backend/.env.example`, `ota/backend/src/main.ts`, `ota/backend/src/worker.ts`, `ota/backend/src/cli.ts`, `ota/backend/src/app.module.ts`, `ota/backend/src/worker.module.ts`, `ota/backend/src/config.ts`, `ota/backend/src/config.test.ts`, `ota/backend/src/common/clock.ts`, `ota/backend/src/common/ids.ts`, `ota/backend/src/health/health.module.ts`, `ota/backend/src/health/health.controller.ts`, `ota/backend/src/health/health.service.ts`, `ota/backend/test/integration/health/health.int.test.ts`, `deploy/env/ota-backend.env.example`
- **Steps:**
  1. Create `@velexis/ota-backend` (private, CommonJS output) with the exact versions of tech-stack §2: `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` 11, `@nestjs/config`, `nestjs-pino`, `pino-http`, `nestjs-cls`, `ioredis`, and the workspace packages `@velexis/config`, `@velexis/logger`, `@velexis/db`, `@velexis/errors`, `@velexis/api-types`. Scripts: `build` (entry points `dist/main.js`, `dist/worker.js`, `dist/cli.js`), `dev` (`dev:api` + `dev:worker`), `test`, `test:int`, `typecheck`, `lint`, `clean`.
  2. `src/config.ts` with `defineConfig`: `APP_ENV`, `LOG_LEVEL`, `PORT` (4000), `HEALTH_PORT` (4001, worker), `TRUST_PROXY` (`loopback`), `DATABASE_URL`, `DATABASE_PROVISIONER_URL` (required in the worker only: tenant provisioning as `velexis_provisioner`; no app process ever holds the migrator DSN, ADR-0004), `REDIS_URL`. Later tasks extend the schema. Write `ota/backend/.env.example` with dummy values.
  3. `main.ts` binds `127.0.0.1:PORT`, sets `trust proxy` from `TRUST_PROXY`, uses `nestjs-pino` with the `@velexis/logger` HTTP options (request bodies never logged), `nestjs-cls` with `requestId` from `X-Request-Id` or a new id, and shutdown hooks. `worker.ts` is a Nest application context plus a `node:http` health server on `HEALTH_PORT`. `cli.ts` is a command dispatcher with `help`.
  4. `Clock` (injectable, `now()`) and `newId(prefix)` (prefixed ULID from X-005) in `src/common/`.
  5. `HealthModule`: `GET /health/live` answers `200 {status: "ok"}`; `GET /health/ready` checks PostgreSQL (`SELECT 1` through `createPool`) and Redis (`PING`) and answers `200` or `503` with the status of each dependency. The worker serves the same paths.
- **Acceptance:**
  - `pnpm --filter @velexis/ota-backend build` produces `dist/main.js`, `dist/worker.js` and `dist/cli.js`.
  - `/health/ready` answers 200 on 4000 and 4001 with PostgreSQL and Redis up, and 503 naming `redis` when Redis is unreachable (integration test).
  - Starting without `DATABASE_URL` exits non-zero with a `ConfigError` naming the variable; the API's config object never exposes `DATABASE_PROVISIONER_URL`, only the worker's does, and neither process's config exposes `DATABASE_MIGRATOR_URL` (unit tests of `config.ts`).
  - Lint finds no `console.*` and no `process.env`; every request log line carries `requestId`.
- **Verify:** `pnpm --filter @velexis/ota-backend build && pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int`

### OFE-001 · Scaffold the storefront as a Vite multi-page app with Tailwind and a Caddy-like dev proxy ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-frontend
- **Milestone:** M0
- **Depends on:** X-001, X-019
- **Size:** M
- **Read first:** ota/frontend/README.md §1, §3, §9, §10, §11, §12; ota/docs/adr/0015-storefront-build-urls-and-hosting.md (points 1–4, 6, 10–12); docs/mvp/conventions.md §4; deploy/caddy/Caddyfile (storefront block)
- **Files:** `ota/frontend/package.json`, `ota/frontend/vite.config.js`, `ota/frontend/vitest.config.js`, `ota/frontend/.env.example`, `ota/frontend/index.html`, `ota/frontend/404.html`, `ota/frontend/partials/header.html`, `ota/frontend/partials/footer.html`, `ota/frontend/partials/noscript.html`, `ota/frontend/src/pages/index.js`, `ota/frontend/src/styles/main.css`, `ota/frontend/src/styles/fonts.css`, `ota/frontend/public/fonts/README.md`, `ota/frontend/scripts/check-budgets.mjs`, `ota/frontend/scripts/vite-plugins.js`, `ota/frontend/test/csp.test.js`, `ota/frontend/test/budgets.test.js`
- **Steps:**
  1. Create `@velexis/ota-frontend` (private, `"type": "module"`) with exact `vite` 6, `tailwindcss` 4.1, `@tailwindcss/vite`, `vitest` 3 and `happy-dom`. Scripts: `dev`, `build` (`vite build && node scripts/check-budgets.mjs`), `preview` (port 4173), `test`, `lint`.
  2. `vite.config.js`: `appType: "mpa"`, every HTML file as an input (a glob so later pages join by existing), `build.modulePreload.polyfill = false`, `build.assetsInlineLimit = 0`, no `VITE_` variables. Load env from the root `.env.local` then `ota/frontend/.env.local` with `loadEnv`.
  3. `scripts/vite-plugins.js`: the `<!-- @include partials/… -->` plugin (`transformIndexHtml`, about 20 lines) and the dev and preview rewrites (`/p/<slug>` → `/p.html`, unknown paths → `/404.html`). The dev and preview proxy send `/api/*` to `OTA_API_URL` with `/api` stripped and `X-Velexis-Edge`, `X-Velexis-Host` (`STOREFRONT_DEV_HOST`, default `demo.<STOREFRONT_BASE_DOMAIN>`) and `Origin: https://<host>`. `preview` also sends the production CSP header, read from `deploy/caddy/Caddyfile`.
  4. `src/styles/main.css` with the `:root` defaults and `@theme inline` tokens of README §6; `index.html` with a static header, footer, `<noscript>` partial and one module script. `404.html` uses the same partials.
  5. `scripts/check-budgets.mjs`: gzip sizes of `dist/`: JS per page ≤ 60 KB (`checkout/pay-airline` ≤ 30 KB once it exists), CSS ≤ 20 KB, HTML ≤ 20 KB per page; exit 1 with a table on any breach.
  6. `test/csp.test.js` asserts that the preview CSP equals the Caddyfile storefront CSP; `test/budgets.test.js` runs the budget function on a fixture folder.
- **Acceptance:**
  - `pnpm --filter @velexis/ota-frontend build` writes `dist/index.html`, `dist/404.html` and hashed assets with no inline script or style (a test greps `dist/*.html` for `<script>` without `src` and for `style=`).
  - The CSP test fails when the Caddyfile CSP changes and the preview copy does not.
  - A budget breach on the fixture folder exits 1 and names the file.
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OAD-001 · Scaffold the OTA admin Next.js app with config and health routes ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-admin
- **Milestone:** M0
- **Depends on:** X-002, X-003
- **Size:** M
- **Read first:** ota/admin/README.md §1, §6, §10, §11; docs/mvp/conventions.md §3; docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md; docs/mvp/tech-stack.md §3 (OTA admin); deploy/env/ota-admin.env.example; deploy/scripts/pack-release.sh (Next.js standalone check); deploy/systemd/velexis-ota-admin.service
- **Files:** `ota/admin/package.json`, `ota/admin/next.config.ts`, `ota/admin/tsconfig.json`, `ota/admin/vitest.config.ts`, `ota/admin/.env.example`, `ota/admin/postcss.config.mjs`, `ota/admin/src/config.ts`, `ota/admin/src/config.test.ts`, `ota/admin/src/app/layout.tsx`, `ota/admin/src/app/globals.css`, `ota/admin/src/app/health/live/route.ts`, `ota/admin/src/app/health/ready/route.ts`, `ota/admin/src/app/health/health.test.ts`, `ota/admin/components.json`, `deploy/env/ota-admin.env.example`
- **Steps:**
  1. Create `@velexis/ota-admin` (private) with exact Next.js 15, React 19, Tailwind 4 (`@tailwindcss/postcss`), `lucide-react`, `zod`, `server-only`, and Vitest with Testing Library. `next.config.ts`: `output: "standalone"`, `outputFileTracingRoot` set to the repository root (two levels up from `ota/admin`; workspace packages are traced and the server lands at `.next/standalone/ota/admin/server.js`, the path that `deploy/scripts/pack-release.sh` and the `velexis-ota-admin` unit expect), `poweredByHeader: false`, `serverActions.bodySizeLimit: "2mb"`, security headers (`frame-ancestors 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`); the CSP nonce comes later with the middleware (OAD-003).
  2. `src/config.ts` with `@velexis/config`: `APP_ENV`, `LOG_LEVEL`, `PORT` (3002), `PUBLIC_OTA_ADMIN_URL`, `PUBLIC_PORTAL_URL`, `OTA_API_URL`, `OTA_ADMIN_SERVICE_KEY`, `SENTRY_DSN` (optional); `import "server-only"`. No `NEXT_PUBLIC_` variable.
  3. Initialise shadcn/ui (`components.json`, CSS variables in `globals.css`) without adding components yet.
  4. Route handlers `/health/live` (200 `{status: "ok"}`) and `/health/ready` (200 when `OTA_API_URL/health/live` answers within 2 s, else 503).
- **Acceptance:**
  - `pnpm --filter @velexis/ota-admin build` produces `ota/admin/.next/standalone/ota/admin/server.js` (nested because of `outputFileTracingRoot`); a test or script asserts that path, and `deploy/scripts/pack-release.sh` packs the app without "missing … server.js".
  - Missing `OTA_ADMIN_SERVICE_KEY` fails `config.ts` with a `ConfigError` naming it (unit test).
  - `/health/ready` answers 503 when the OTA API is unreachable (route test with a fake fetch).
  - A lint rule or test fails on any `NEXT_PUBLIC_` variable in the app.
- **Verify:** `pnpm --filter @velexis/ota-admin test && pnpm --filter @velexis/ota-admin build && test -f ota/admin/.next/standalone/ota/admin/server.js`

### SDK-001 · Scaffold the SDK package with checkJs, version and test setup ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-sdk
- **Milestone:** M0
- **Depends on:** X-001, X-008
- **Size:** S
- **Read first:** ota/sdk/README.md §1, §3, §6, §8, §9; ota/docs/adr/0016-sdk-packaging-and-type-contract.md (points 1, 3, 7, 8); ota/sdk/docs/types-and-builds.md §2; docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md
- **Files:** `ota/sdk/package.json`, `ota/sdk/tsconfig.json`, `ota/sdk/tsconfig.build.json`, `ota/sdk/vitest.config.js`, `ota/sdk/src/index.js`, `ota/sdk/src/version.js`, `ota/sdk/src/types.js`, `ota/sdk/test/unit/version.test.js`, `ota/sdk/test/helpers/fake-fetch.js`, `ota/sdk/CHANGELOG.md`
- **Steps:**
  1. Create `@velexis/ota-sdk` (`"type": "module"`, `"sideEffects": false`, version `0.1.0`, **no dependencies**; devDependencies `typescript` 5.6, `vitest` 3, `happy-dom`, `esbuild` 0.25 and the workspace `@velexis/api-types` for types only). Scripts: `typecheck`, `test`, `build` (filled by SDK-007), `generate` (filled by SDK-002).
  2. `tsconfig.json`: `allowJs`, `checkJs`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmit`, `types: []`, `lib: ["ES2022", "DOM"]`. `tsconfig.build.json`: `emitDeclarationOnly` to `dist/types/`.
  3. `src/types.js` declares the base aliases (`Schemas`, `Paths`, `Operations`) from `@velexis/api-types` in JSDoc; `src/version.js` exports `VERSION`; `src/index.js` re-exports `VERSION` only for now.
  4. `test/helpers/fake-fetch.js`: a queue of canned responses that records every request (method, URL, headers, body) for assertions.
- **Acceptance:**
  - `pnpm --filter @velexis/ota-sdk typecheck` passes with `checkJs` on.
  - `version.test.js` fails when `VERSION` differs from `package.json`.
  - `package.json` has no `dependencies` field (test).
- **Verify:** `pnpm --filter @velexis/ota-sdk typecheck && pnpm --filter @velexis/ota-sdk test`

## M1 — Platform core

The OTA side of M1 is the provisioning worker (OF-11): the platform's `tenant.provision` job turns into a complete tenant schema. Platform task PBE-035 is gated on it.

### OBE-002 · Add the Redis client, queue names and job validation to the OTA backend ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M1
- **Depends on:** OBE-001, PBE-004
- **Size:** M
- **Read first:** ota/docs/architecture.md §6 and §7; docs/mvp/adr/0009-background-jobs-bullmq.md; packages/api-types/src/jobs/queues.ts; packages/api-types/README.md (jobs); ota/backend/README.md §4
- **Files:** `ota/backend/src/common/redis/redis.module.ts`, `ota/backend/src/common/redis/redis.keys.ts`, `ota/backend/src/common/redis/redis.keys.test.ts`, `ota/backend/src/common/queues/queues.module.ts`, `ota/backend/src/common/queues/queue-names.ts`, `ota/backend/src/common/queues/job-validation.ts`, `ota/backend/src/common/queues/job-validation.test.ts`, `packages/api-types/src/jobs/queues.ts`, `ota/backend/package.json`, `ota/backend/test/integration/common/queues.int.test.ts`
- **Steps:**
  1. Add exact `bullmq` 5 and `@nestjs/bullmq` 11. `RedisModule` provides one `ioredis` client per process (`REDIS_URL`), with `maxRetriesPerRequest: null` for BullMQ connections.
  2. `redis.keys.ts`: builders for every key of architecture §7 (`tenant(id)`, `host(name)`, `apiKey(prefix)`, `conn(kind, tenantId, env)`, `amadeusToken(credId, env)`, `sf(tenantId, env, locale)`, …) so no module writes a key string by hand; each builder returns the key and its TTL and is tagged with its kind: `tenant` (tenant data: `sf`, `search`, `cxq`, `acChk`, `authfail`), `shared` (the keys of the cross-cutting table in docs/mvp/architecture.md and platform §6.4) or `credential`. Tenant builders take `(tenantId, env, …)` and always return `t:<tenantId>:<env>:…`. A unit test asserts every builder has a TTL (Redis runs with `noeviction`) and every `tenant` builder's key starts with `t:<tenantId>:<env>:`; a source scan in the same test fails when a file other than `redis.keys.ts` passes a string or template literal key to the Redis client.
  3. Append the OTA queue names to `OTA_QUEUES` in `packages/api-types/src/jobs/queues.ts` (`ota-stripe-events`, `ota-payments`, `ota-bookings`, `ota-ticketing`, `ota-notifications`, `ota-documents`, `ota-maintenance`), as PBE-004 asks. `queue-names.ts` re-exports them with their concurrency (architecture §6) and the defaults of ADR-0009 (`attempts: 5`, exponential backoff from 30 s, failed jobs kept 30 days, prefix `vx`).
  4. `job-validation.ts` wraps `validateJob` from `@velexis/api-types/jobs`: an invalid payload throws BullMQ's `UnrecoverableError` and is logged without the payload.
- **Acceptance:**
  - Every key builder has a TTL; a test lists the builders and fails on a new one without TTL, or on a tenant-data builder whose key does not start with `t:<tenantId>:<env>:`.
  - A `tenant.provision` fixture from PBE-004 validates; one with an extra field is refused as unrecoverable (integration test with a real queue).
  - `@velexis/api-types` tests still pass with the extended `OTA_QUEUES`.
- **Verify:** `pnpm --filter @velexis/api-types test && pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- common`

### OBE-003 · Add the read-only platform repository for tenants ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M1
- **Depends on:** OBE-001, X-014, PBE-002
- **Size:** S
- **Read first:** ota/docs/data-model.md §2.1; platform/docs/architecture.md §6.2; docs/mvp/adr/0004-postgresql-schema-per-tenant.md (Database roles); ota/docs/adr/0009-caller-and-tenant-resolution.md (point 5)
- **Files:** `ota/backend/src/tenancy/tenancy.module.ts`, `ota/backend/src/tenancy/platform-read.repository.ts`, `ota/backend/src/tenancy/platform-read.types.ts`, `ota/backend/test/integration/tenancy/platform-read.int.test.ts`
- **Steps:**
  1. `PlatformReadRepository` on `platformDb` (role `velexis_ota_app`): `tenantById(id)` and `tenantByKey(key)` returning `{id, key, name, status, schemaName, storefrontEnvironment, defaultCurrency, defaultLocale, billingNotice}` from `platform.tenants`, each in a short read-only transaction. Later tasks add domains, keys, memberships and connections to the same repository.
  2. Validate `schemaName` with `assertTenantSchema` from `@velexis/db` before returning it.
  3. Integration test: the repository reads a tenant inserted by the test as migrator, and an `UPDATE platform.tenants` through the same pool fails with `permission denied`.
- **Acceptance:**
  - Reads return the mapped row; an unknown id returns `null`.
  - The OTA role cannot write `platform.tenants` (test asserts the PostgreSQL error code 42501).
  - A tenant row with a malformed `schema_name` is refused before any tenant SQL.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- tenancy`

### OBE-004 · Write the provisioning seeds for settings, the default markup rule and template defaults ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M1
- **Depends on:** OBE-001, X-014
- **Size:** M
- **Read first:** ota/docs/flows/tenant-provisioning-worker.md §2 (step 5); ota/docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md (point 4); ota/docs/adr/0013-notifications-and-booking-documents.md (point 3); docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE storefront_settings`, `CREATE TABLE markup_rules`, `CREATE TABLE notification_templates`)
- **Files:** `ota/backend/src/provisioning/seeds/index.ts`, `ota/backend/src/provisioning/seeds/storefront-settings.seed.ts`, `ota/backend/src/provisioning/seeds/markup-rules.seed.ts`, `ota/backend/src/provisioning/seeds/templates.seed.ts`, `ota/backend/src/notifications/templates/registry.ts`, `ota/backend/test/integration/provisioning/seeds.int.test.ts`
- **Steps:**
  1. `seedTenant(trx, tenant)` runs the three seeds with `ON CONFLICT DO NOTHING`, inside the caller's transaction.
  2. `storefront_settings`: brand name = tenant name, default currency and locale from the tenant, `time_zone = 'UTC'`, `ticketing_policy = 'issue_after_payment'`, `payment_timing = 'authorize_before_booking'`, `booking_queue_number = 50`, `booking_queue_category = 0`, airline card off in both environments (columns that `0002` adds are written only when they exist, so the seed works on schema N-1 and N).
  3. `markup_rules`: one default rule (`is_default`, priority 1000, `percentage` 0, scope empty, active).
  4. `notifications/templates/registry.ts`: the list of MVP template keys of OADR-0013 with their variable allow-lists and a loader for `templates/<key>.{subject,html,txt}.hbs`; files are added by OBE-030 and OBE-055. `templates.seed.ts` inserts one row per key whose files exist (none yet), so tenants provisioned earlier simply use the code fallback.
- **Acceptance:**
  - On a fresh tenant schema the seeds create one settings row and one default markup rule; running them twice changes nothing.
  - An existing settings row edited by the test is not overwritten by a second run.
  - With a template file present in a test fixture directory, one `notification_templates` row is seeded per key.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- provisioning`

### OBE-005 · Implement the tenant.provision consumer in one provisioner transaction ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M1
- **Depends on:** OBE-002, OBE-003, OBE-004, X-013, X-015
- **Size:** L
- **Read first:** ota/docs/flows/tenant-provisioning-worker.md §1, §2, §5, §7; ota/docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md; platform/docs/adr/0001-tenant-provisioning-orchestration.md (items 3–5, 9); docs/velexis-sdk/db/README.md §3; packages/db/README.md (`migrateTenantSchema`)
- **Files:** `ota/backend/src/provisioning/provisioning.module.ts`, `ota/backend/src/provisioning/tenant-ops.processor.ts`, `ota/backend/src/provisioning/provisioning.service.ts`, `ota/backend/src/provisioning/tenant-events.producer.ts`, `ota/backend/src/provisioning/provisioning.service.test.ts`, `ota/backend/src/worker.module.ts`, `ota/backend/test/integration/provisioning/provision.int.test.ts`
- **Steps:**
  1. `tenant-ops.processor.ts` consumes `ota-tenant-ops` with concurrency 2 in the worker only; validates with OBE-002; dispatches by job name. Unknown names fail as unrecoverable.
  2. `provisionTenant(tenantId)`: re-read the tenant (OBE-003); only `status = 'provisioning'` is provisioned. A schema already complete at the latest version answers `tenant.provisioned` again; other statuses answer `tenant.provision_failed {retryable: false, error.code: "TENANT_NOT_PROVISIONING"}`.
  3. One transaction on a `DATABASE_PROVISIONER_URL` pool (role `velexis_provisioner`, ADR-0004): `lock_timeout 5s`, advisory lock on the schema name, `migrateTenantSchema({ schema, dir: migrations/tenant, create: true })` (schema, files, ledger, grants and default privileges for `velexis_ota_app`), then `seedTenant` (OBE-004). A schema with tables but no ledger is "foreign content": unrecoverable, never dropped.
  4. After commit, `tenant-events.producer.ts` publishes `tenant.provisioned {schemaName, schemaVersion, migrations[{version, checksum, phase, appliedAt, durationMs}], steps[]}` on `platform-tenant-events`, validated with `validateJob`.
  5. Integration tests with `@velexis/testing`: a fresh tenant row → complete schema, ledger, grants (`has_table_privilege` for `velexis_ota_app`) and seeds; the same message twice → one schema and two `tenant.provisioned` events; two schemas provisioned from scratch have the same catalog hash.
- **Acceptance:**
  - `tenant.provision` creates the schema, applies every migration, grants and seeds in one transaction and reports `tenant.provisioned` with the ledger [OF-11 AC1].
  - Re-running the message is harmless and answers `tenant.provisioned` again [OF-11 AC2].
  - A crash injected after the migrations but before commit leaves no schema.
  - The API process cannot construct the provisioner pool (config test).
- **Verify:** `pnpm --filter @velexis/ota-backend build && pnpm --filter @velexis/ota-backend test:int -- provisioning`

### OBE-006 · Implement tenant.migrate and classify provisioning failures ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M1
- **Depends on:** OBE-005
- **Size:** M
- **Read first:** ota/docs/flows/tenant-provisioning-worker.md §3 (`tenant.migrate`) and §5; ota/docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md (points 5–6); docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md (exit codes)
- **Files:** `ota/backend/src/provisioning/provisioning.service.ts`, `ota/backend/src/provisioning/failure-classifier.ts`, `ota/backend/src/provisioning/failure-classifier.test.ts`, `ota/backend/src/provisioning/tenant-ops.processor.ts`, `ota/backend/test/integration/provisioning/migrate.int.test.ts`
- **Steps:**
  1. `migrateTenant(tenantId, targetVersion?)`: the same migrator transaction as provisioning without creating the schema or seeding; answers `tenant.migrated {schemaVersion, migrations[]}` or `tenant.migration_failed {version, error}`.
  2. `failure-classifier.ts`: lock timeout (55P03), serialization failure (40001), deadlock (40P01) and connection loss are retryable (BullMQ retries 3 times within the attempt, then the failure event says `retryable: true`); checksum mismatch, foreign content, invalid schema name and wrong tenant status throw `UnrecoverableError` and report `retryable: false`.
  3. Every failure event carries `error {code, message}` without SQL text or parameters.
- **Acceptance:**
  - A forced lock timeout (a second connection holding the advisory lock) ends in `tenant.provision_failed {retryable: true}` after the in-attempt retries.
  - An edited, already applied migration file ends in `retryable: false` and changes nothing.
  - `tenant.migrate` on a schema at N-1 applies the pending file and reports the full ledger.
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- provisioning`

### OBE-007 · Add the tenants:report-migrations and dev:seed commands and run the report at deploy ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M1
- **Depends on:** OBE-006, PBE-034, X-005, X-023, X-033
- **Size:** M
- **Read first:** ota/docs/flows/tenant-provisioning-worker.md §4; ota/docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md (item 7); ota/backend/README.md §5 and §6; platform/backend/README.md §5 (`dev:seed`); platform/docs/adr/0005-api-key-format-and-hashing.md; docs/mvp/local-development.md; deploy/scripts/deploy.sh (section 2, migrations); docs/mvp/adr/0026-system-users-per-trust-zone.md (item 6, `velexis-run`); docs/mvp/deployment-single-vm.md §8 and §9
- **Files:** `ota/backend/src/cli.ts`, `ota/backend/src/provisioning/report-migrations.command.ts`, `ota/backend/src/provisioning/report-migrations.command.test.ts`, `ota/backend/src/dev/dev-seed.command.ts`, `ota/backend/package.json`, `ota/backend/test/integration/dev/dev-seed.int.test.ts`, `ota/backend/README.md`, `docs/mvp/local-development.md`, `deploy/scripts/deploy.sh`, `deploy/scripts/test/deploy.test.sh`, `docs/mvp/deployment-single-vm.md`
- **Steps:**
  1. `tenants:report-migrations --report <file>`: read the JSON report of `migrate.js tenants` (X-013) and publish one `tenant.migrated` or `tenant.migration_failed` per schema named in it (`applied` and `failed`) with `jobId = null`. The tenant id comes from `platform.tenants` (read-only role) and each `tenant.migrated` carries the schema's full ledger read from its `schema_migrations`, so a repeated run re-sends a correct mirror. Exit 1 on an unreadable report or when Redis refuses the events.
  2. `dev:seed` (script `pnpm --filter @velexis/ota-backend dev:seed`): refused with exit 1 when `APP_ENV=production`. It needs the platform `dev:seed` (PBE-034) first. As a **development-only exception** to "the OTA backend never writes platform tables", it uses `DATABASE_MIGRATOR_URL` to insert, idempotently, the demo tenant (`demo`, status `provisioning`), its sub-domain `demo.<STOREFRONT_BASE_DOMAIN>`, a test supplier connection on the platform's Velexis test account and office, a `velexis` test payment connection, and a `pk_test` and an `sk_test` key hashed with the shared pepper (X-005 helpers, PADR-0005 format).
  3. It then calls `provisionTenant` directly (the real provisioning function), sets the tenant `active`, and prints the two raw keys once.
  4. **Deploy wiring.** In `deploy/scripts/deploy.sh`, section 2, right after the tenant fan-out and before the switch: when `$REL/ota-backend/dist/cli.js` exists, make the fan-out report `/var/lib/velexis/migrate-$SHA.json` readable (mode `0644`; it holds schema names, versions and error texts, no secrets) and run `velexis-run ota node "$REL/ota-backend/dist/cli.js" tenants:report-migrations --report "/var/lib/velexis/migrate-$SHA.json"`. The X-033 wrapper runs it as the OTA zone user with `/etc/velexis/ota-backend.env` and `/etc/velexis/ota-worker.env` loaded (`REDIS_URL`, the read-only database DSN), never with the migrator DSN. A failure stops the deploy like a failed migration (`restore_running_system_files`; the previous release keeps running on N-1-compatible schemas); re-running the deploy repeats the fan-out (nothing applied twice) and the report.
  5. Add `deploy.test.sh` cases with a fake `velexis-run` that records its arguments: the report runs after the fan-out and before the switch with the release's own `cli.js` and the report path of this sha; a failing report leaves the previous release current; a release without `ota-backend/` skips the step. Update `deployment-single-vm.md` §8 (step 5) and §9 with the step.
  6. Document both commands in the README and the local development runbook.
- **Acceptance:**
  - A report with 3 applied and 1 failed schema publishes 4 valid events with `jobId: null` (unit test with a fake queue); a second run with the same report publishes the same 4 events.
  - `dev:seed` twice leaves one tenant, one schema and two keys; the printed `sk_test` authenticates once OBE-011 exists (asserted later by OBE-026).
  - With `APP_ENV=production` it exits 1 without writing anything.
  - `deploy.test.sh` passes with the cases of step 5; `shellcheck -S style` is clean for `deploy.sh`.
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- dev && bash deploy/scripts/test/deploy.test.sh && shellcheck -S style deploy/scripts/deploy.sh`

## M2 — Search & price

The OTA backend gets its contract extensions, request pipeline, tenancy, Amadeus client and shopping endpoints; the SDK gets its core and the M2 namespaces; the storefront gets the search-to-price pages. Platform tasks PBE-036 and PAD-011 are gated on OF-01 (OBE-011 … OBE-013, OBE-026, OFE-008).

### OBE-008 · Add tenant migration 0002 with the MVP deltas ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-005
- **Size:** M
- **Read first:** ota/docs/data-model.md §1 and §3; ota/docs/data-model-migration-0002.md (whole); docs/mvp/conventions.md §9; ota/backend/migrations/README.md
- **Files:** `ota/backend/migrations/tenant/0002_add_mvp_tenant_deltas.sql`, `ota/backend/test/integration/migrations/tenant-0002.int.test.ts`, `ota/backend/test/contract/migration-0002.contract.test.ts`, `packages/db/src/generated/tenant.ts`
- **Steps:**
  1. Copy the SQL block of `data-model-migration-0002.md` §2 verbatim into `0002_add_mvp_tenant_deltas.sql` (header `-- velexis:phase expand`). Do not change a statement; if it fails, fix the document and the file together in this PR.
  2. `migration-0002.contract.test.ts` extracts the SQL block from the Markdown document and asserts it equals the file, so the two never drift.
  3. Write the integration tests of `data-model-migration-0002.md` §3: from scratch; upgrade over baseline rows in `payments`, `checkouts`, `bookings`, `storefront_settings`; airline CHECK; asset `RESTRICT`; page uniqueness and `published_at`; ledger row with phase `expand` and the file checksum.
  4. Run `pnpm db:migrate:tenants` locally from the previous version and from scratch, then `pnpm db:codegen` and commit the regenerated tenant types.
- **Acceptance:**
  - Every test of §3 passes; inserting `provider = 'airline'` with `card_exp_month` fails with `payments_airline_card_ck`.
  - A tenant provisioned by OBE-005 after this task has `0002` in its ledger; `velexis_ota_app` can write `storefront_assets` and `storefront_pages` without any `GRANT` in the file (default privileges).
  - `git diff --exit-code packages/db/src/generated` is clean after `pnpm db:codegen`.
- **Verify:** `pnpm db:codegen && pnpm --filter @velexis/ota-backend test -- contract && pnpm --filter @velexis/ota-backend test:int -- migrations`

### OBE-009 · Spec-first: edge and cookie mode, environment header, vendor extensions and x-milestone ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** X-006, X-008, X-009
- **Size:** M
- **Read first:** ota/docs/api-changes.md §1, §2, §5, §6; ota/docs/scope.md §3 (milestone of every operation); ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md (point 4); docs/mvp/adr/0006-contract-first-openapi.md; ota/backend/openapi/README.md
- **Files:** `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, `ota/backend/openapi/README.md`, `packages/api-types/scripts/generate.mjs`, `packages/api-types/src/generated/ota.ts`, `packages/api-types/src/generated/operations.ts`, `packages/errors/src/generated/catalogue.ts`, `ota/backend/test/contract/openapi-extensions.contract.test.ts`
- **Steps:**
  1. Document the vendor extensions `x-edge-only`, `x-internal`, `x-sdk-exclude`, `x-milestone`, `x-permission` in `info.description` (api-changes §1).
  2. Add `x-milestone` to all 96 operations from scope §3: `M2`, `M3` or `M4` for the 77 MVP operations, `deferred` for the 19 others.
  3. Apply §2 exactly: security schemes `storefrontEdge` (`x-internal`), `customerCookie`, `bookingCookie`; parameter `CsrfToken`; header `Set-Cookie`; `storefrontEdge` alternatives on every `customer`/`both` operation; `CsrfToken` on state-changing ones; `signIn`, `refreshSession`, `changePassword` 200 → `oneOf [AuthSessionResult, AuthSessionInfo]`; `AuthRefreshRequest.refreshToken` optional; `BookingLookupResult.bookingToken` nullable; `StorefrontHostHeader` description.
  4. Apply §5: parameter `VelexisEnvironment` on every `x-scope: console` operation and `ConsoleStaffSession.environments`; the existing `CustomerEndUserIp` and `CustomerEndUserAgent` header parameters on every console operation too, with descriptions saying they are honoured for secret keys and for the OTA admin's service caller.
  5. Add `CSRF_TOKEN_INVALID` (403) and `NOT_IMPLEMENTED` (501) to `x-error-catalogue`.
  6. Extend `packages/api-types/scripts/generate.mjs` so the operations index also carries `milestone`, `edgeOnly` and `permission`. Run `pnpm contracts:lint` and `pnpm contracts:generate`; record the change in the README's change log.
  7. `openapi-extensions.contract.test.ts`: every operation has `x-milestone` (`M0` … `M5` or `deferred`); the 96 operations of the original document (operationIds read from `docs/velexis-sdk/openapi/`) keep the milestones of scope §3, 77 MVP and 19 deferred, so operations added by later spec tasks never change these counts; every customer-scope operation accepts `storefrontEdge`; every console operation has `VelexisEnvironment`. Later spec tasks add assertions for their own operations by operationId, never totals (OBE-075 checks the M4 totals once).
- **Acceptance:**
  - `pnpm contracts:lint` reports zero errors; regeneration twice leaves no diff.
  - The contract test passes; the original under `docs/velexis-sdk/` is unchanged (`git diff --exit-code docs/velexis-sdk`).
  - `ErrorCode` contains `CSRF_TOKEN_INVALID` and `NOT_IMPLEMENTED`.
- **Verify:** `pnpm contracts:lint && pnpm contracts:generate && pnpm --filter @velexis/ota-backend test -- contract && git diff --exit-code docs/velexis-sdk`

### OBE-010 · Build the HTTP pipeline with OpenAPI validation, error filter and route parity ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-001, OBE-009
- **Size:** L
- **Read first:** ota/docs/architecture.md §3 (steps 1–3, 6, 12, 13); docs/mvp/conventions.md §2 (Rules) and §6; docs/mvp/adr/0006-contract-first-openapi.md (Runtime validation, Route parity); packages/errors/README.md; packages/testing/README.md (`expectResponseToMatch`)
- **Files:** `ota/backend/src/common/http/http.module.ts`, `ota/backend/src/common/http/request-context.ts`, `ota/backend/src/common/http/body-parsers.ts`, `ota/backend/src/common/http/openapi-operation.decorator.ts`, `ota/backend/src/common/http/openapi-validation.interceptor.ts`, `ota/backend/src/common/http/openapi-validation.interceptor.test.ts`, `ota/backend/src/common/http/error.filter.ts`, `ota/backend/src/common/http/error.filter.test.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/src/common/http/not-implemented.controller.ts`, `ota/backend/src/main.ts`, `ota/backend/package.json`, `ota/backend/test/support/create-test-app.ts`, `ota/backend/test/contract/route-parity.contract.test.ts`, `ota/backend/test/contract/response-conformance.contract.test.ts`
- **Steps:**
  1. Add exact `helmet`, `cookie-parser`, `ajv` 8 and `ajv-formats`. In `main.ts`: raw body on `/webhooks/*`, JSON limit 256 KB elsewhere (a per-route override hook for the 10 KB airline-card route of OBE-051), `helmet`, `cookie-parser`, `trust proxy loopback`.
  2. `@OpenApiOperation("getStorefront")` binds a controller method to its operation; `openapi-validation.interceptor.ts` compiles the operation's path, query, header and body schemas once from the YAML and answers `400 VALIDATION_FAILED` with `fieldErrors` holding paths and codes, never values.
  3. `error.filter.ts` uses `toErrorEnvelope` from `@velexis/errors`; unknown errors become `500 INTERNAL_ERROR` with the `requestId`; `supplier` details only when the request is in console scope.
  4. `pending-operations.ts`: a map `operationId → task id` (or `"deferred"`) seeded with every operation; `not-implemented.controller.ts` registers each listed route and answers `501 NOT_IMPLEMENTED` with `details.milestone`. Every later endpoint task removes its own entries.
  5. `create-test-app.ts`: boots the API module on a `@velexis/testing` database and Redis for Supertest. `route-parity.contract.test.ts`: every document operation has exactly one handler or one pending entry, and every handler has an operation. `response-conformance.contract.test.ts` replays recorded responses through `expectResponseToMatch`.
- **Acceptance:**
  - A body with an unknown property answers 400 with the property path and no value echoed (test with a password-like value).
  - A thrown `TypeError` answers 500 `INTERNAL_ERROR` with the `requestId` and no stack.
  - Every not-yet-implemented operation answers 501; the parity test fails for a handler without an operation and for an operation with neither handler nor pending entry.
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test -- contract`

### OBE-011 · Classify callers: edge secret and API key verification ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-010, OBE-003, X-005
- **Size:** M
- **Read first:** ota/docs/adr/0009-caller-and-tenant-resolution.md (point 1); ota/docs/architecture.md §3.1; platform/docs/adr/0005-api-key-format-and-hashing.md; docs/mvp/adr/0018-hosted-storefront-custom-domains.md (edge credential); docs/mvp/architecture.md §4 (Redis keys)
- **Files:** `ota/backend/src/common/auth/caller.guard.ts`, `ota/backend/src/common/auth/caller.guard.test.ts`, `ota/backend/src/tenancy/caller-resolver.ts`, `ota/backend/src/tenancy/api-key.verifier.ts`, `ota/backend/src/tenancy/api-key.verifier.test.ts`, `ota/backend/src/tenancy/platform-read.repository.ts`, `ota/backend/src/config.ts`, `ota/backend/.env.example`, `deploy/env/ota-backend.env.example`, `ota/backend/test/integration/tenancy/caller.int.test.ts`
- **Steps:**
  1. Config: `VELEXIS_EDGE_SECRET`, `API_KEY_PEPPER_FILE`, `STOREFRONT_BASE_DOMAIN`, `PUBLIC_OTA_API_URL`.
  2. `CallerGuard` order (OADR-0009): `X-Velexis-Edge` present → constant-time compare with the secret → `edge` (`X-Velexis-Host` required, else 400); `X-Api-Key` with `pk_`/`sk_` → `key`; public routes (`/health/live`, `/v1/assets/*`, `/v1/files/*`) and `/webhooks/*` → `anonymous`; anything else `401 INVALID_API_KEY`. Edge header plus API key → `400 INVALID_REQUEST`. The service-key branch is added by OBE-060.
  3. `api-key.verifier.ts`: 14-character prefix → `api_keys` row (repository method `apiKeyByPrefix`) → `HMAC-SHA-256(pepper, key)` compared in constant time → revoked, expired, environment, kind, scopes; `pk_` keys check `Origin` against `allowed_origins`.
  4. Put the caller (`{type, id, keyId?, environment?, scopes?}`) in the request context. No platform lookup happens before the edge secret check.
- **Acceptance:**
  - A wrong edge secret answers 401 without any database query (spy on the repository).
  - A valid `sk_test` key is accepted; the same key revoked, expired or with a one-character change is refused with 401; a `pk_` key from a non-listed origin is refused.
  - Edge header plus `X-Api-Key` answers 400.
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- tenancy`

### OBE-012 · Resolve the tenant with Redis caches and the vx:invalidate subscriber ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-011, OBE-002, PBE-002
- **Size:** L
- **Read first:** ota/docs/adr/0009-caller-and-tenant-resolution.md (points 2–5, 7); platform/docs/architecture.md §6.2 and §6.3; ota/docs/architecture.md §3 (step 5), §4 and §7; docs/velexis-sdk/db/README.md §5; platform/docs/adr/0014-tenant-suspension-and-resume.md
- **Files:** `ota/backend/src/common/auth/tenant.guard.ts`, `ota/backend/src/tenancy/tenant-resolver.ts`, `ota/backend/src/tenancy/tenant-resolver.test.ts`, `ota/backend/src/tenancy/platform-cache.ts`, `ota/backend/src/tenancy/invalidation.subscriber.ts`, `ota/backend/src/tenancy/tenant-context.ts`, `ota/backend/src/tenancy/tenant-tx.ts`, `ota/backend/src/tenancy/platform-read.repository.ts`, `ota/backend/test/integration/tenancy/tenant-resolution.int.test.ts`, `ota/backend/test/integration/tenancy/invalidation.int.test.ts`
- **Steps:**
  1. `TenantGuard`: edge → `X-Velexis-Host` is `<key>.<STOREFRONT_BASE_DOMAIN>` (`tenantkey:<key>`) or a verified `tenant_domains` row with `purpose = storefront` (`host:<hostname>`, active tenants only); environment = `tenants.storefront_environment`. Key → the key's tenant and environment. Unknown host → `403 HOST_NOT_ALLOWED`; status other than `active` → `403 TENANT_SUSPENDED` (sub-domains of suspended tenants still resolve so the storefront can show it).
  2. `platform-cache.ts`: Redis read-through for `tenant:`, `tenantkey:`, `host:`, `apikey:`, `member:`, `conn:` with 60 s TTL and 10 s negative caching; ciphertext stays encrypted. Redis down → read PostgreSQL directly; PostgreSQL down → 503.
  3. `invalidation.subscriber.ts` subscribes to `vx:invalidate`, validates with `validateInvalidation`, and deletes the keys of every type: `tenant`, `domain`, `api_key`, `connection`, `membership`, `account`, `amadeus_account`, `plan`.
  4. `tenant-context.ts` (`nestjs-cls`): `{tenantId, key, schemaName, environment, caller, actor, requestId}`. `tenant-tx.ts` wraps `tenantTx` from `@velexis/db` with the context's schema; nothing else takes a schema name.
  5. Tests: a `tenant` invalidation makes a suspension visible within one second; a host of tenant A never resolves tenant B; a pool of one connection serves interleaved requests of two tenants correctly.
- **Acceptance:**
  - Edge requests resolve the tenant from a verified host and the tenant's storefront environment [OF-01 AC1].
  - A suspended tenant answers `403 TENANT_SUSPENDED` within one second of the invalidation and at most 60 s without it [OF-01 AC3].
  - Every invalidation type deletes exactly its keys (table-driven test); unknown hosts are negatively cached for 10 s.
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- tenancy`

### OBE-013 · Add the scope guard, CSRF guard, rate limits and key-usage counters ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-012
- **Size:** M
- **Read first:** ota/docs/architecture.md §3 (steps 7, 9, 10) and §8; ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md (point 3); ota/docs/adr/0009-caller-and-tenant-resolution.md (point 6); ota/docs/api-changes.md §2.4
- **Files:** `ota/backend/src/common/auth/scope.guard.ts`, `ota/backend/src/common/auth/scope.guard.test.ts`, `ota/backend/src/common/auth/csrf.guard.ts`, `ota/backend/src/common/auth/csrf.guard.test.ts`, `ota/backend/src/common/redis/throttler-storage.ts`, `ota/backend/src/common/http/rate-limits.ts`, `ota/backend/src/tenancy/key-usage.ts`, `ota/backend/package.json`, `ota/backend/test/integration/common/guards.int.test.ts`
- **Steps:**
  1. `ScopeGuard` reads `scope`, `edgeOnly` and `permission` from the generated operations index: customer-scope operations accept edge and `pk_`/`sk_` (`storefront` scope); console operations need a console-scoped caller (OBE-060 completes it); `x-edge-only` refuses keys with `403 SCOPE_NOT_ALLOWED`.
  2. `CsrfGuard` on edge `POST`, `PUT`, `PATCH`, `DELETE`: `X-CSRF-Token` equals `__Host-vx_csrf` (constant time) and `Origin` (or `Sec-Fetch-Site: same-origin`) is `https://<X-Velexis-Host>`; otherwise `403 CSRF_TOKEN_INVALID`. Never for key callers.
  3. `@nestjs/throttler` 6 with a Redis storage; `rate-limits.ts` holds the table of architecture §8 (per IP from Caddy or `X-Velexis-End-User-IP` for server-side keys). Rate-limited routes refuse with 503 when Redis is down.
  4. `key-usage.ts` sets `apikey:used:<keyId>` (`{at, ip}`, 1 day) at most once a minute per key after a successful request.
- **Acceptance:**
  - Edge POST without the header, with a different header, or with a foreign `Origin` answers 403 `CSRF_TOKEN_INVALID`; GET needs no header [OF-03 AC2 groundwork].
  - The 31st search in a minute from one IP answers 429 with `Retry-After`.
  - Ten requests with one key within a minute write `apikey:used:<keyId>` once.
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- common`

### OBE-014 · Add the idempotency interceptor ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-012, OBE-008
- **Size:** M
- **Read first:** ota/docs/architecture-booking.md §5; docs/mvp/conventions.md §2 (Idempotency); docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE idempotency_keys`); docs/mvp/adr/0010-secrets-envelope-encryption.md (associated data)
- **Files:** `ota/backend/src/common/http/idempotency.interceptor.ts`, `ota/backend/src/common/http/idempotency.service.ts`, `ota/backend/src/common/http/idempotency.repository.ts`, `ota/backend/src/common/http/idempotency.service.test.ts`, `ota/backend/test/integration/common/idempotency.int.test.ts`
- **Steps:**
  1. Applies to operations whose `Idempotency-Key` parameter is required (from the document); a missing key answers 400.
  2. Scope `<environment>:<principal>:<operationId>`; principal `cus_…`, `key_…`, `stf_…` or `edge-<first 16 hex of sha256(csrf cookie)>`.
  3. Insert `processing` with `request_hash` and `locked_until` in its own short transaction; on conflict: other hash → `409 IDEMPOTENCY_KEY_REUSED`; `completed` → replay status and body (from `response_ciphertext` when the response carries a token); `processing` → wait up to 60 s, then replay or `409 CONFLICT`.
  4. Store final outcomes for 24 h (success and final `4xx`); delete the record on transient errors (`503`, `502 PAYMENT_PROVIDER_ERROR` before any provider effect). Provide a hook `resolveReplay(record)` so OBE-043 can rebuild a stored `504` from the linked booking.
  5. A per-operation `hashInput` hook lets OBE-051 replace the card by `{brand, last4}` before hashing. Bodies pass the shared redactor before storage.
- **Acceptance:**
  - Two requests with the same key and body produce one handler execution and identical responses; a different body answers 409 `IDEMPOTENCY_KEY_REUSED`.
  - A transient 503 lets the same key be retried; a stored 422 is replayed.
  - A replay of a token-carrying response decrypts `response_ciphertext`; the plain body column holds no token.
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- common`

### OBE-015 · Implement the reference endpoints ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-012, X-018
- **Size:** M
- **Read first:** ota/docs/scope.md §3.1 (reference rows); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: searchLocations` and the five other reference operations); docs/velexis-sdk/db/reference.sql; docs/mvp/adr/0024-reference-data-sources-and-loader.md
- **Files:** `ota/backend/src/reference/reference.module.ts`, `ota/backend/src/reference/reference.controller.ts`, `ota/backend/src/reference/reference.service.ts`, `ota/backend/src/reference/reference.repository.ts`, `ota/backend/src/reference/reference.mapper.ts`, `ota/backend/src/reference/reference.mapper.test.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/reference/reference.int.test.ts`
- **Steps:**
  1. Implement `reference.locations.search` (`searchLocations`: keyword prefix on IATA code, city and airport names, `subType` filter, limit ≤ 20, ranking exact code first), `reference.airports.get`, `reference.airlines.list`, `reference.airlines.get`, `reference.countries.list`, `reference.currencies.list` on the `reference` schema through `tenantTx` (the `search_path` includes `reference`).
  2. `Cache-Control: public, max-age=3600` on these responses; `Accept-Language` picks localised names where the data has them.
  3. Remove the six operations from `pending-operations.ts`.
- **Acceptance:**
  - `searchLocations?keyword=par` returns `PAR` before airports named "Parma"; unknown IATA codes answer 404.
  - Every response validates against the document (`expectResponseToMatch`) in edge and key mode.
  - No tenant table is touched (query log assertion).
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- reference`

### OBE-016 · Implement storefront.get with the CSRF cookie and the response cache ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-013, OBE-008
- **Size:** M
- **Read first:** ota/docs/flows/search-and-price.md §2 (step 1); ota/docs/api-changes.md §2.2 (`getStorefront`) and §2.3; ota/docs/adr/0012-storefront-settings-assets-and-pages.md (points 1, 7, 8); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `StorefrontConfig:`)
- **Files:** `ota/backend/src/storefront/storefront.module.ts`, `ota/backend/src/storefront/storefront.controller.ts`, `ota/backend/src/storefront/storefront.service.ts`, `ota/backend/src/storefront/storefront.repository.ts`, `ota/backend/src/storefront/storefront.mapper.ts`, `ota/backend/src/storefront/storefront.mapper.test.ts`, `ota/backend/src/common/http/cookie-writer.ts`, `ota/backend/src/common/http/cookie-writer.test.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/storefront/storefront.int.test.ts`
- **Steps:**
  1. `storefront.get` (`getStorefront`): map `storefront_settings` (with the `0002` columns), tenant name and `environment` into `StorefrontConfig`; `features.savedTravelers = false`; `payment.supportedMethods = []` until OBE-038 fills the payment configuration.
  2. Cache only the caller-independent config in `t:<tenantId>:<env>:sf:<locale>` for 5 minutes (asset references as ids, the airline-card availability as a flag); settings changes delete it (OBE-070). `storefront.mapper.ts` adds the caller-specific parts on every request: asset URLs as same-origin `/api/v1/assets/…` paths for the edge and absolute `PUBLIC_OTA_API_URL` URLs for key callers (OADR-0012 point 3), and, from OBE-050, `airline_card` and `airlineCard` for the edge only.
  3. `cookie-writer.ts`: writes `__Host-` cookies only in edge mode, with `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`, and `HttpOnly` except for `__Host-vx_csrf`. `storefront.get` in edge mode sets `__Host-vx_csrf` (256-bit base64url) when missing or malformed and answers `Cache-Control: private`.
  4. Remove `getStorefront` from `pending-operations.ts`.
- **Acceptance:**
  - An edge call without the CSRF cookie gets `Set-Cookie: __Host-vx_csrf=…; Secure; SameSite=Lax; Path=/` and no `HttpOnly`; a key call never gets `Set-Cookie`.
  - The response validates against `StorefrontConfig` and contains no internal column (`booking_queue_number`, `ops_alert_email`).
  - A second call within 5 minutes reads no settings row (cache hit asserted).
  - A `pk_` call followed by an edge call for the same tenant and locale (one cache fill) returns absolute asset URLs to the key and relative `/api/v1/assets/…` paths to the edge, and the reverse order gives the same answers.
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- storefront`

### OBE-017 · Build the Amadeus connection resolver and token provider ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-012, X-004
- **Size:** M
- **Read first:** ota/docs/adr/0001-amadeus-client-design.md (points 1–5); ota/docs/flows/amadeus-connection-and-tokens.md §1–§3; docs/mvp/adr/0012-amadeus-account-model.md; platform/docs/architecture.md §6.2 (`supplier_connections`, `amadeus_accounts`, `amadeus_offices`)
- **Files:** `ota/backend/src/amadeus/amadeus.module.ts`, `ota/backend/src/amadeus/connection-resolver.ts`, `ota/backend/src/amadeus/connection-resolver.test.ts`, `ota/backend/src/amadeus/token-provider.ts`, `ota/backend/src/amadeus/token-provider.test.ts`, `ota/backend/src/amadeus/generated/README.md`, `ota/backend/scripts/amadeus-types.mjs`, `ota/backend/src/tenancy/platform-read.repository.ts`, `ota/backend/package.json`, `ota/backend/src/config.ts`, `ota/backend/test/integration/amadeus/resolver.int.test.ts`
- **Steps:**
  1. `scripts/amadeus-types.mjs` (`pnpm --filter @velexis/ota-backend amadeus:types`) generates `src/amadeus/generated/*.ts` from the 9 files of `docs/amadeus-api/`. Eight are Swagger 2.0, which `openapi-typescript` 7 does not read: convert them in memory with `swagger2openapi` (exact devDependency, justified in the PR as tech-stack.md asks), and normalise the Queue List path key `GET/office/queues/{queue-id}`. Commit the output with a "do not edit" header; exclude the folder from lint.
  2. `connection-resolver.ts`: cached `conn:amadeus:<tenantId>:<env>` row (OBE-012 cache) → `{credId, clientId, encryptedSecret, baseUrl, offices: {queuing, owner, queue, retrieval}}`. `credential_source = velexis` uses the referenced `amadeus_accounts` row of that environment; `tenant` is accepted by the type but implemented in OBE-079. No active row → `424 SUPPLIER_NOT_CONFIGURED`. `AMADEUS_BASE_URL_TEST`/`_LIVE` override the base URL (stub in development and CI).
  3. `token-provider.ts`: `client_credentials`; token encrypted with `@velexis/crypto` in `amadeus:token:<credId>:<env>` with TTL `expires_in − 60 s`; single flight with `amadeus:tokenlock:<credId>:<env>` (10 s, others wait up to 2 s); `dropToken()` for the operation-level 401 retry; refused credentials set `amadeus:badcred:<credId>` for 5 minutes and answer 424 without a new token request.
- **Acceptance:**
  - 50 concurrent calls cause one token request against the stub (integration test).
  - A connection without an active row, or with a `badcred` flag, answers 424; the token in Redis is ciphertext.
  - `pnpm --filter @velexis/ota-backend amadeus:types` is deterministic (second run, no diff).
- **Verify:** `pnpm --filter @velexis/ota-backend amadeus:types && git diff --exit-code ota/backend/src/amadeus/generated && pnpm --filter @velexis/ota-backend test:int -- amadeus`

### OBE-018 · Add rate limits, timeouts, retries, error mapping and supplier_requests to the Amadeus client ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-017, OBE-008, X-027
- **Size:** L
- **Read first:** ota/docs/adr/0001-amadeus-client-design.md (points 3, 6–11); ota/docs/flows/amadeus-connection-and-tokens.md §4–§8; docs/velexis-sdk/db/README.md §8 (redaction); docs/mvp/adr/0016-observability.md (redaction list)
- **Files:** `ota/backend/src/amadeus/amadeus.client.ts`, `ota/backend/src/amadeus/rate-limiter.ts`, `ota/backend/src/amadeus/rate-limiter.test.ts`, `ota/backend/src/amadeus/limits.ts`, `ota/backend/src/amadeus/error-mapper.ts`, `ota/backend/src/amadeus/error-mapper.test.ts`, `ota/backend/src/amadeus/supplier-requests.repository.ts`, `ota/backend/src/amadeus/call-context.ts`, `eslint.config.mjs`, `ota/backend/test/integration/amadeus/client.int.test.ts`
- **Steps:**
  1. `AmadeusClient` with one method per operation (`searchFlightOffers`, `getFlightOffers`, `searchFlightAvailabilities`, `upsellAirOffers`, `quoteAirOffers`, `createFlightOrders`, `issueFlightOrder`, `getFlightOrder`, `patchFlightOrder`, `cancelFlightOrder`, `getFlightOrderByReference`, `listQueue`), typed by the generated types, over built-in `fetch`. Call context `{tenantId, environment, operation, requestId, staffId?, bookingId?, searchId?, orderOffice?}`. ESLint `no-restricted-imports`/`no-restricted-globals` forbid Amadeus `fetch` outside `src/amadeus/`.
  2. `rate-limiter.ts`: two Redis token buckets per call (`rl:amadeus:cred:<credId>:<env>` 20/s; `rl:amadeus:ten:<tenantId>:<env>` 5/s burst 10); empty → `429 RATE_LIMITED` with `Retry-After`, no call; Redis down → 503.
  3. `limits.ts`: timeouts per operation (flow §4) through `AbortController`; one retry with 300–800 ms jitter only for reads and the token request on network errors, timeouts and `5xx`; writes are never retried; a 401 drops the token and retries once.
  4. `error-mapper.ts`: the initial table of flow §5 as a unit-tested constant (`SOLD_OUT`, `PRICE_CHANGED`, `TRAVELER_DATA_INVALID`, `VERSION_CONFLICT`, `TICKETING_FAILED`, `PAYMENT_DECLINED`, `SUPPLIER_*`), raw issue kept in `error.supplier` for console scope.
  5. One `supplier_requests` row per call in its own short tenant transaction **after** the call (never inside the caller's transaction), bodies through the shared redactor, truncated to 64 KB; one `amadeus.call` log line without bodies. A `redactedRequest` argument lets callers pass a pre-redacted copy (airline card, OBE-051). Offices outside the tenant's list → `403 OFFICE_NOT_ALLOWED` before any call. `X-Stub-Scenario` is forwarded only when `APP_ENV` is not `production`.
- **Acceptance:**
  - Stub scenario `timeout` on a read gives one retry then `504 SUPPLIER_TIMEOUT`; on `createFlightOrders` it gives no retry.
  - A request carrying a passport number is stored masked in `supplier_requests`; the log line has no body.
  - An empty tenant bucket answers 429 without calling the stub (`requests()` count unchanged).
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- amadeus`

### OBE-019 · Stub the shopping operations: price, upsell and availability ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** X-026
- **Size:** M
- **Read first:** tools/amadeus-stub/README.md; tools/amadeus-stub/fixtures/README.md; ota/backend/README.md §7; docs/amadeus-api/FlightOffersPrice_v1_Version_1.15_swagger_specification.json, BrandedFaresUpsell_v1_Version_1.4_swagger_specification.json, FlightAvailabilitiesSearch_v1_Version_1.0_swagger_specification.json (grep `paths` and `parameters`)
- **Files:** `tools/amadeus-stub/src/routes.ts`, `tools/amadeus-stub/src/handlers/pricing.ts`, `tools/amadeus-stub/src/handlers/upselling.ts`, `tools/amadeus-stub/src/handlers/availability.ts`, `tools/amadeus-stub/src/scenarios.ts`, `tools/amadeus-stub/fixtures/flight-offers-price/success.json`, `tools/amadeus-stub/fixtures/flight-offers-price/credit-card-fees.json`, `tools/amadeus-stub/fixtures/branded-fares-upsell/success.json`, `tools/amadeus-stub/fixtures/flight-availabilities/success.json`, `tools/amadeus-stub/test/shopping.test.ts`, `tools/amadeus-stub/README.md`
- **Steps:**
  1. Synthetic fixtures (no personal data) consistent with the existing flight-offers-search fixture: pricing echoes the posted offers with `bookingRequirements`, `include=bags,other-services,detailed-fare-rules,credit-card-fees` adds the `included` dictionaries, and the card fee depends on the posted brand.
  2. Scenarios: `price-changed` (pricing returns a higher total and warning 37200), `sold-out` (pricing and upsell return error 34651), plus the existing `server-error`, `rate-limited`, `timeout`.
  3. Requests are validated against the specifications like the search route; unknown fields fail loudly with 400.
- **Acceptance:**
  - Each new route returns its fixture for a valid request and 400 naming the parameter for an invalid one.
  - `price-changed` and `sold-out` behave as described for pricing; `ZZZ` still returns no offers.
- **Verify:** `pnpm --filter @velexis/amadeus-stub build && pnpm --filter @velexis/amadeus-stub test`

### OBE-020 · Build the markup and fee engine ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-001, X-014
- **Size:** M
- **Read first:** ota/docs/adr/0005-markup-and-fee-engine.md (whole); docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE markup_rules`, `CREATE TABLE fee_rules`); docs/mvp/conventions.md §1 (Money)
- **Files:** `ota/backend/src/pricing/pricing.module.ts`, `ota/backend/src/pricing/pricing-engine.ts`, `ota/backend/src/pricing/pricing-engine.test.ts`, `ota/backend/src/pricing/rule-matcher.ts`, `ota/backend/src/pricing/rule-matcher.test.ts`, `ota/backend/src/pricing/pricing.types.ts`, `ota/backend/src/pricing/rules.repository.ts`, `ota/backend/test/integration/pricing/rules.int.test.ts`
- **Steps:**
  1. `priceOffer(input, rules, fees, step) → {net, markupLines[], feeLines[], selling}`: pure, `decimal.js`, no I/O. Inputs from OADR-0005 point 2.
  2. Matching: active, inside the validity window, every non-empty scope field matches ("any of" lists, `minNet`/`maxNet`); order by `priority`, `id`; first non-stackable is the base; stackable rules with a lower priority number (or all when no base) add; the default rule guarantees a match.
  3. Computation per booking, traveller or segment; caps per unit; negative markups floored at −net; half-up rounding per line to the currency's minor units (from `reference.currencies`); fixed amounts only when their currency equals the offer currency.
  4. Fees by step: none at search, `booking_service` and `ticketing` at pricing, `ancillary_service` per extra, `payment_card` with `cardBrands` when the brand is known, `cancellation` at the quote.
  5. `rules.repository.ts` loads active rules once per request (tenant transaction); isolation test with two tenants.
- **Acceptance:**
  - A table of at least 25 cases (stacking, caps, rounding, negative markup, foreign fixed currency, per-segment) passes, and `selling = net + Σ lines` holds in every case.
  - The engine never uses JavaScript numbers for money (lint rule or test grepping for `Number(` and `parseFloat` in `src/pricing/`).
  - Tenant B's rules never apply to tenant A.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- pricing && pnpm --filter @velexis/ota-backend test:int -- pricing`

### OBE-021 · Implement flights.search, getSearch and listResults ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-018, OBE-020, OBE-013
- **Size:** L
- **Read first:** ota/docs/flows/search-and-price.md §1–§4, §6; ota/docs/adr/0002-offer-and-priced-offer-caching.md (points 1–3, 5, 7, 8); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: createFlightSearch`, `listFlightSearchResults`, `getFlightSearch`); docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE flight_searches`, `CREATE TABLE flight_offers`)
- **Files:** `ota/backend/src/shopping/shopping.module.ts`, `ota/backend/src/shopping/searches.controller.ts`, `ota/backend/src/shopping/searches.service.ts`, `ota/backend/src/shopping/searches.repository.ts`, `ota/backend/src/shopping/offers.mapper.ts`, `ota/backend/src/shopping/offers.mapper.test.ts`, `ota/backend/src/shopping/facets.ts`, `ota/backend/src/shopping/facets.test.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/shopping/search.int.test.ts`
- **Steps:**
  1. `flights.search` (`createFlightSearch`): `mode: simple` (one-way, return) builds the Amadeus GET query, `advanced` posts the body; currency body → `X-Currency` → default; defaults from `search_defaults`; `resultOptions.async: true` → `403 FEATURE_DISABLED` (`details.feature = "asyncSearch"`).
  2. Single flight per tenant, environment and normalised criteria hash (`t:<tenantId>:<env>:search:<sha256>`, 30 s).
  3. For each offer run the engine (step `search`) and insert `flight_searches` plus up to 250 `flight_offers` in one transaction with summary columns, facets and highlights stored on the search; `expires_at = now + offer_ttl_minutes`. A timeout or `5xx` marks the search `failed`.
  4. `flights.getSearch` and `flights.listResults` (filters, sort, cursor, SQL only). Expired → `410 SEARCH_EXPIRED`.
  5. Customer scope never sees net amounts: the mapper rewrites `amadeus.price` to selling amounts. Remove the three operations from `pending-operations.ts`.
- **Acceptance:**
  - Search, filter and sort work against the stub with selling prices only; a JSON walk finds no `net*` field in customer responses [OF-02 AC1].
  - A search past `expires_at` answers 410 `SEARCH_EXPIRED` [OF-02 AC2]; destination `ZZZ` answers 201 with zero offers.
  - Two identical concurrent searches make one stub call.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- shopping && pnpm --filter @velexis/ota-backend test:int -- shopping`

### OBE-022 · Implement flights.getOffer and flights.upsell ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-021, OBE-019
- **Size:** M
- **Read first:** ota/docs/flows/search-and-price.md §2 (step 6); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: getFlightOffer`, `upsellFlightOffer`); docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE offer_upsells`)
- **Files:** `ota/backend/src/shopping/offers.controller.ts`, `ota/backend/src/shopping/offers.service.ts`, `ota/backend/src/shopping/offers.repository.ts`, `ota/backend/src/shopping/upsell.service.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/shopping/offer-upsell.int.test.ts`
- **Steps:**
  1. `flights.getOffer` (`view` summary or full) reads the stored offer; expired → `410 OFFER_EXPIRED`.
  2. `flights.upsell` calls Branded Fares Upsell with the stored Amadeus offer, prices each brand with the engine, stores `offer_upsells` and the upsold `flight_offers` (`origin = 'upsell'`, same `expires_at` as the parent search).
  3. Remove both operations from `pending-operations.ts`.
- **Acceptance:**
  - Upsell returns the brand alternatives as new `off_` ids with selling prices; `sold-out` answers 409 `SOLD_OUT`.
  - Tenant B gets 404 for tenant A's `off_` id.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- shopping`

### OBE-023 · Implement flights.price, getPricedOffer, getAncillaries and getFareRules ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-022
- **Size:** L
- **Read first:** ota/docs/flows/search-and-price.md §2 (steps 7–8), §3; ota/docs/adr/0002-offer-and-priced-offer-caching.md (point 3); ota/docs/adr/0005-markup-and-fee-engine.md (point 7); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: priceFlightOffers`, `getPricedOffer`, `getPricedOfferAncillaries`, `getPricedOfferFareRules`)
- **Files:** `ota/backend/src/shopping/priced-offers.controller.ts`, `ota/backend/src/shopping/priced-offers.service.ts`, `ota/backend/src/shopping/priced-offers.repository.ts`, `ota/backend/src/shopping/priced-offers.mapper.ts`, `ota/backend/src/shopping/priced-offers.mapper.test.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/shopping/pricing.int.test.ts`
- **Steps:**
  1. `flights.price` (up to 6 offers of one search, else `422 OFFER_COMBINATION_INVALID`) calls Flight Offers Price with the `include` flags; the engine adds `booking_service` and `ticketing` fees; store `priced_offers` with booking requirements, the redacted Amadeus request, the line list and `expires_at = min(now + offer_ttl_minutes, end of lastTicketingDate)`. A different price sets `priceChanged` with old and new totals.
  2. `flights.getPricedOffer`, `flights.getAncillaries` and `flights.getFareRules` read from `priced_offers.response`, calling Amadeus only when the data was not included yet.
  3. Remove the four operations from `pending-operations.ts`.
- **Acceptance:**
  - Stub `price-changed` returns 200 with `priceChanged: true` and both totals; the stored row satisfies `selling = net + markup + fees`.
  - An expired priced offer answers 410 `OFFER_EXPIRED`; customer responses carry no net amount.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- shopping && pnpm --filter @velexis/ota-backend test:int -- shopping`

### OBE-024 · Add the scheduler framework and the offers.purge job ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-023, OBE-002
- **Size:** M
- **Read first:** ota/docs/adr/0014-per-tenant-workers-and-schedulers.md (whole); ota/docs/architecture.md §6 (schedulers); ota/docs/adr/0002-offer-and-priced-offer-caching.md (point 6)
- **Files:** `ota/backend/src/jobs/jobs.module.ts`, `ota/backend/src/jobs/schedulers.ts`, `ota/backend/src/jobs/fan-out.ts`, `ota/backend/src/jobs/fan-out.test.ts`, `ota/backend/src/jobs/limits.ts`, `ota/backend/src/shopping/offers-purge.processor.ts`, `ota/backend/test/integration/jobs/offers-purge.int.test.ts`
- **Steps:**
  1. `schedulers.ts` declares schedulers with `upsertJobScheduler` at worker start-up; each runs a small fan-out job on `ota-maintenance`.
  2. `fan-out.ts` lists target tenants from the cached platform data (`active` and `suspended`, with a per-task filter) and enqueues one job per tenant with job id `<task>:<tenantId>:<minute bucket>`; `limits.ts` holds the batch sizes of OADR-0014.
  3. `offers.purge` (every 15 minutes): per tenant, delete expired searches in batches of 500 unless a checkout references one of their priced offers; re-enqueue itself when more remain.
- **Acceptance:**
  - Two overlapping scheduler runs enqueue one job per tenant (deterministic ids).
  - The purge deletes an expired search and keeps one whose priced offer a checkout references (FakeClock).
  - `provisioning` and `failed` tenants are skipped.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- jobs && pnpm --filter @velexis/ota-backend test:int -- jobs`

### OBE-025 · Report queue ages in worker readiness and add amadeus:ping
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-024, OBE-018
- **Size:** S
- **Read first:** ota/docs/adr/0014-per-tenant-workers-and-schedulers.md (point 8); docs/mvp/adr/0016-observability.md (health); ota/backend/README.md §5 (`amadeus:ping`)
- **Files:** `ota/backend/src/health/health.service.ts`, `ota/backend/src/health/queue-age.ts`, `ota/backend/src/health/queue-age.test.ts`, `ota/backend/src/amadeus/amadeus-ping.command.ts`, `ota/backend/src/cli.ts`
- **Steps:**
  1. Worker `/health/ready` adds `queues: {name: {waiting, oldestWaitingSeconds, failedLastHour}}` for every OTA queue; status stays 200 (the on-VM check of X-030 decides the alert threshold).
  2. `node dist/cli.js amadeus:ping --tenant <key> --env test`: resolve the connection, request a token, run one cheap read; print status and duration, never the token.
- **Acceptance:**
  - With a job waiting for 2 minutes, readiness reports `oldestWaitingSeconds ≥ 120` for that queue (FakeClock or BullMQ timestamps).
  - `amadeus:ping` against the stub prints `ok` and exits 0; with bad credentials it exits 1 with `SUPPLIER_NOT_CONFIGURED`.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- health`

### OBE-026 · Prove tenant resolution and shopping isolation across two tenants
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-023, OBE-016, OBE-015, OBE-007
- **Size:** M
- **Read first:** ota/docs/scope.md §4 (OF-01, OF-02); ota/docs/flows/search-and-price.md §6; ota/docs/architecture.md §9; docs/velexis-sdk/db/README.md §5 (pool-of-one test)
- **Files:** `ota/backend/test/integration/m2/tenant-isolation.int.test.ts`, `ota/backend/test/integration/m2/edge-and-key.int.test.ts`, `ota/backend/test/integration/m2/no-net-amounts.int.test.ts`, `ota/backend/test/support/json-walk.ts`
- **Steps:**
  1. Two tenants with their own hosts, keys and stub connections: every M2 customer operation is called in edge mode and with an `sk_test` key; responses validate against the document.
  2. Cross-tenant checks: tenant A's `srch_`, `off_`, `prc_` ids answer 404 at tenant B; tenant A's key used with tenant B's host header answers 400 (edge plus key) or resolves A only.
  3. `json-walk.ts` asserts that no customer-scope response contains a `net*` field or raw supplier details.
  4. Run the M2 suite with a pool of one connection to prove the `search_path` never leaks.
  5. Use the keys printed by `dev:seed` (OBE-007) once in a smoke test.
- **Acceptance:**
  - A token or key of tenant A is never accepted at tenant B [OF-01 AC2].
  - Search, results, offer, upsell and price work in both modes with selling prices only [OF-02 AC1].
  - The pool-of-one run passes.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- m2`

### OBE-027 · Confirm the Amadeus error table and the booking-queue convention against the test environment
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-018, OBE-019
- **Size:** S
- **Read first:** ota/docs/adr/0001-amadeus-client-design.md (Follow-ups); ota/docs/adr/0003-booking-orchestration-and-supplier-timeout-recovery.md (point 3, Follow-ups); ota/docs/flows/amadeus-connection-and-tokens.md §5; tools/amadeus-stub/fixtures/README.md
- **Files:** `ota/backend/src/amadeus/error-mapper.ts`, `ota/backend/src/amadeus/error-mapper.test.ts`, `ota/docs/flows/amadeus-connection-and-tokens.md`, `ota/docs/adr/0003-booking-orchestration-and-supplier-timeout-recovery.md`, `tools/amadeus-stub/fixtures/README.md`
- **Steps:**
  1. Human step: with the developer's own Amadeus test credentials, run `pnpm --filter @velexis/amadeus-stub record <operation>` for search, price, upsell and the error cases that can be triggered (invalid data, sold out where possible), and ask Amadeus support whether `automatedProcess` with code `IMMEDIATE` places new orders on queue 50 of the shared offices.
  2. Scrub recorded fixtures (no names, documents or e-mails) and add only scrubbed copies.
  3. Update the error table where real codes differ; record the queue answer in OADR-0003's Follow-ups and in flow §5.
- **Acceptance:**
  - The error-mapper tests cover every code seen in the recordings.
  - OADR-0003 states the confirmed (or changed) queue convention with the date of the answer.
  - No recorded fixture contains personal data (the stub's fixture scan passes).
- **Verify:** `pnpm --filter @velexis/ota-backend test -- amadeus && pnpm --filter @velexis/amadeus-stub test`

### OBE-028 · Load-test search against the stub and tune the Amadeus buckets
- **Component:** ota-backend
- **Milestone:** M2
- **Depends on:** OBE-026
- **Size:** S
- **Read first:** ota/docs/adr/0001-amadeus-client-design.md (Follow-ups); ota/docs/adr/0002-offer-and-priced-offer-caching.md (Follow-ups); docs/mvp/architecture.md §3 (memory budget)
- **Files:** `ota/backend/test/load/search-load.mjs`, `ota/backend/test/load/README.md`, `ota/docs/performance.md`, `ota/backend/src/amadeus/limits.ts`
- **Steps:**
  1. `search-load.mjs` (plain Node, `fetch`, no new dependency): N virtual visitors on two tenants run search, list results and price against the local API wired to the stub with a 300 ms stub delay.
  2. Measure p50/p95 latency, search insert time, rows and table sizes after 1 000 searches, API RSS, and how often the buckets answer 429.
  3. Write `ota/docs/performance.md` with the figures and adjust the bucket constants only if the data says so (with the reason).
- **Acceptance:**
  - `performance.md` records the run (date, commit, machine) and the bucket decision.
  - p95 of `flights.search` excluding the stub delay is below 500 ms at 10 concurrent visitors, or a follow-up task is added to this plan.
- **Verify:** `node ota/backend/test/load/search-load.mjs --visitors 10 --searches 200`

### SDK-002 · Generate the route table from the OpenAPI document ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-sdk
- **Milestone:** M2
- **Depends on:** SDK-001, OBE-009
- **Size:** M
- **Read first:** ota/docs/adr/0016-sdk-packaging-and-type-contract.md (point 2); ota/sdk/docs/types-and-builds.md §5; ota/sdk/README.md §3 (How a method is written), §5.3; ota/docs/api-changes.md §1 (vendor extensions)
- **Files:** `ota/sdk/scripts/generate-operations.mjs`, `ota/sdk/scripts/operation-overrides.json`, `ota/sdk/src/internal/operations.js`, `ota/sdk/test/unit/operations.test.js`, `ota/sdk/package.json`, `.github/workflows/ci.yml`
- **Steps:**
  1. `generate-operations.mjs` (Node, `yaml` 2.x as a devDependency) reads `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml` and writes `src/internal/operations.js`: a frozen object keyed by `x-sdk-method` (dots replaced by `_` for the key) with `method`, `path`, `pathParams`, `queryParams`, `headerParams` (`If-Match` → `ifMatch`, `X-Velexis-Environment` handled by the client), `idempotency` (`none`, `optional`, `required`), `retry` (`safe`, `idempotent`, `never`) and `timeoutMs`.
  2. `operation-overrides.json`: reviewed values the document does not carry: 60 s for `flights.search`, `flights.upsell`, `flights.price`, `console.bookings.issue`, `.cancel`, `.import`, `.retrieve`; 90 s and `retry: "never"` for `checkout.complete` (90 s only) and `checkout.completeWithAirlineCard` (both).
  3. Skip operations with `x-internal` or `x-sdk-exclude`; fail on a parameter-name collision or a duplicated `x-sdk-method`. Output is deterministic and starts with a "generated, do not edit" header.
  4. Add a CI step that runs `pnpm --filter @velexis/ota-sdk generate` and fails on a diff.
- **Acceptance:**
  - The table has one entry per `x-sdk-method` of the document (96 now); a second run gives no diff.
  - `operations.test.js` checks a sample per namespace (method, path template, idempotency, timeout).
  - A document with a duplicated `x-sdk-method` makes the generator exit 1.
- **Verify:** `pnpm --filter @velexis/ota-sdk generate && git diff --exit-code ota/sdk/src/internal/operations.js && pnpm --filter @velexis/ota-sdk test`

### SDK-003 · Build the request core: options, HTTP, retries, errors and pagination ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-sdk
- **Milestone:** M2
- **Depends on:** SDK-002
- **Size:** L
- **Read first:** ota/sdk/README.md §5.1 and §5.3; docs/velexis-sdk/sdk/src/shared.d.ts and index.d.ts (options, `RequestOptions`, error classes, `Page<T>`); ota/docs/adr/0016-sdk-packaging-and-type-contract.md (point 6); ota/sdk/docs/extensions.md §1 and §2
- **Files:** `ota/sdk/src/internal/client.js`, `ota/sdk/src/internal/http.js`, `ota/sdk/src/internal/errors.js`, `ota/sdk/src/internal/pagination.js`, `ota/sdk/src/internal/ids.js`, `ota/sdk/src/shared.js`, `ota/sdk/src/index.js`, `ota/sdk/test/unit/http.test.js`, `ota/sdk/test/unit/errors.test.js`, `ota/sdk/test/unit/pagination.test.js`, `ota/sdk/test/unit/options.test.js`
- **Steps:**
  1. `createVelexisClient(options)` validates options (contract defaults; `baseUrl` default `https://api.ota.example.com`), builds the request core and exposes `withOptions` and `request`. `core.call(op, params, options)` splits params into path, query (arrays comma-separated, `undefined` dropped), headers and JSON body.
  2. `http.js`: headers (`Accept-Language`, `X-Currency`, `Idempotency-Key` per call reused across its retries, caller headers), `AbortController` timeouts linked to `options.signal`, retries (at most `maxRetries` for GET/PUT/DELETE and idempotent requests on 429, 503, 504 and network errors; back-off 0.5 s, 1 s, cap 8 s, jitter; `Retry-After` honoured, above 30 s throws `RateLimitError` at once; client timeouts and `retry: "never"` never retried), `onResponse` hook.
  3. `errors.js` maps the envelope to the contract classes by status and code; `ConnectionError` with `NETWORK_ERROR`, `TIMEOUT`, `ABORTED`; `501 NOT_IMPLEMENTED` → `ServerError` with `retryable: false`; `toJSON()` never contains keys, tokens or bodies. `shared.js` exports the classes and `isVelexisError`.
  4. `pagination.js`: `Page<T>` (`@template T`) with `data`, `page.nextCursor`, `next()` and async iteration. `ids.js`: UUID v4 with a `getRandomValues` fallback.
- **Acceptance:**
  - Unit tests with the fake fetch cover header building, idempotency key reuse across retries, each retry rule, `Retry-After` above 30 s, timeout without retry, abort, error mapping for every catalogue status, and `for await` over three pages.
  - `toJSON()` of an error raised from a request with a secret key contains no `sk_` string.
  - `pnpm --filter @velexis/ota-sdk typecheck` passes.
- **Verify:** `pnpm --filter @velexis/ota-sdk typecheck && pnpm --filter @velexis/ota-sdk test`

### SDK-004 · Implement cookie, token and server session modes ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-sdk
- **Milestone:** M2
- **Depends on:** SDK-003
- **Size:** M
- **Read first:** ota/sdk/README.md §4 (all); ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md (points 3, 5); ota/docs/adr/0016-sdk-packaging-and-type-contract.md (points 5, 6); docs/velexis-sdk/sdk/src/console.d.ts (`sessionKind`, `onStaffSessionRefreshed`)
- **Files:** `ota/sdk/src/internal/session.js`, `ota/sdk/src/internal/client.js`, `ota/sdk/test/unit/session-cookie.test.js`, `ota/sdk/test/unit/session-token.test.js`, `ota/sdk/test/unit/session-server.test.js`
- **Steps:**
  1. Mode selection at construction: `session: "cookie"` (needs `document`; refuses `publishableKey`, `secretKey`, `accessToken`, `refreshToken`, `bookingToken`, and `X-Api-Key`/`Authorization` headers, also per call, with `TypeError`; `fetch` with `credentials: "same-origin"`, `mode: "same-origin"`); token mode (`publishableKey`, token sources, `credentials: "omit"`); server mode (`secretKey`, refused when `globalThis.document` exists; `environment` sends `X-Velexis-Environment` on console operations only).
  2. Cookie mode: copy `__Host-vx_csrf` into `X-CSRF-Token` on writes; when the cookie is missing call `GET /v1/storefront` once first; on `403 CSRF_TOKEN_INVALID` re-fetch once and retry once. On `401 TOKEN_EXPIRED` call `POST /v1/auth/refresh` with an empty body and retry once; concurrent calls share one refresh promise; a failed refresh calls `onSessionExpired` and throws `AuthenticationError`.
  3. Token and server mode: contract refresh with `refreshToken` (single flight, `onSessionRefreshed`); `sessionKind: "staff"` refreshes through `console.auth.refresh` and reports `onStaffSessionRefreshed`.
- **Acceptance:**
  - Each refused option throws `TypeError` before any request (table test).
  - Five concurrent calls that all get `401 TOKEN_EXPIRED` trigger one refresh and five retried calls.
  - The CSRF re-fetch happens once per failure, never in a loop; `X-Velexis-Environment` is absent on customer operations.
- **Verify:** `pnpm --filter @velexis/ota-sdk typecheck && pnpm --filter @velexis/ota-sdk test`

### SDK-005 · Write the storefront, reference and flights namespaces ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-sdk
- **Milestone:** M2
- **Depends on:** SDK-004
- **Size:** M
- **Read first:** docs/velexis-sdk/sdk/src/identity.d.ts (`StorefrontApi`, `ReferenceApi`); docs/velexis-sdk/sdk/src/flights.d.ts; docs/velexis-sdk/sdk/docs/B1.md and B2.md; ota/sdk/docs/types-and-builds.md §1; ota/sdk/README.md §5.2
- **Files:** `ota/sdk/src/namespaces/storefront.js`, `ota/sdk/src/namespaces/reference.js`, `ota/sdk/src/namespaces/flights.js`, `ota/sdk/src/identity.js`, `ota/sdk/src/flights.js`, `ota/sdk/src/index.js`, `ota/sdk/test/unit/namespaces-m2.test.js`, `ota/sdk/test/fixtures/storefront.json`, `ota/sdk/test/fixtures/flight-search.json`
- **Steps:**
  1. Factories `createStorefrontApi`, `createReferenceApi`, `createFlightsApi`: one line per method calling `core.call(op.<name>, params, options)`, named exactly by `x-sdk-method` (`storefront.get`, `storefront.resolve`, the six `reference.*`, the ten `flights.*`, including the deferred `storefront.resolve` and `flights.availability`).
  2. Hand-written JSDoc per method: one-line summary, `@param` and `@returns` with types from `@velexis/api-types` through `src/types.js`, `@throws` with classes and codes. Namespace types are `ReturnType<typeof createFlightsApi>` and so on.
  3. `identity.js` and `flights.js` mirror their `.d.ts` counterparts (same typedef names); `index.js` attaches the namespaces to the client.
  4. Fixtures are response bodies validated against the document with the Ajv helper of `@velexis/testing`.
- **Acceptance:**
  - Each method hits the right method, path, query and headers with sample parameters (route-table test over the M2 namespaces).
  - `flights.search` uses a 60 s timeout; `storefront.resolve` surfaces `501` as `ServerError` with `code = "NOT_IMPLEMENTED"`.
  - `typecheck` passes with no `any` in the three namespace files.
- **Verify:** `pnpm --filter @velexis/ota-sdk typecheck && pnpm --filter @velexis/ota-sdk test`

### SDK-006 · Add the contract test, approved deviations and the parity test with a pending list ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-sdk
- **Milestone:** M2
- **Depends on:** SDK-005
- **Size:** M
- **Read first:** ota/docs/adr/0016-sdk-packaging-and-type-contract.md (point 4); ota/sdk/docs/types-and-builds.md §4; ota/sdk/README.md §6; docs/mvp/adr/0015-testing-strategy.md (SDK contract)
- **Files:** `ota/sdk/test/contract/tsconfig.json`, `ota/sdk/test/contract/client.contract.ts`, `ota/sdk/test/contract/methods.generated.ts`, `ota/sdk/test/contract/deviations.ts`, `ota/sdk/test/contract/pending-namespaces.js`, `ota/sdk/test/contract/parity.test.js`, `ota/sdk/scripts/generate-operations.mjs`, `ota/sdk/package.json`
- **Steps:**
  1. A `tsc --noEmit` project maps `velexis-contract` to `docs/velexis-sdk/sdk/src/index.d.ts`, `@velexis/ota-sdk` to `dist/types/index.d.ts` and `@velexis/api-types` to the generated package.
  2. The generator also writes `methods.generated.ts`: per method, the contract's `Parameters` assignable to the SDK's and the SDK's awaited return assignable to the contract's. `client.contract.ts` holds the hand-written assertions (client, options, `RequestOptions`, `Page<T>`, error classes, `isVelexisError`).
  3. `deviations.ts` lists approved deviations with their ADR; the only entry is the cookie-mode auth union of OADR-0006.
  4. `parity.test.js`: the set of `x-sdk-method` names equals the set of client methods, except entries listed in `pending-namespaces.js`. An entry is a namespace (`auth`, `account`, `checkout`, `bookings` until M3; `console` until M4) or a single method of a namespace that is already implemented (for example `storefront.listPages`, added by OBE-091), each with its task id. SDK-013 empties the list.
- **Acceptance:**
  - The contract project compiles for the M2 namespaces; narrowing a parameter type of `flights.search` makes it fail.
  - Removing a method from `flights.js` makes the parity test fail.
  - `pnpm --filter @velexis/ota-sdk test` runs the contract project and the parity test.
- **Verify:** `pnpm --filter @velexis/ota-sdk build && pnpm --filter @velexis/ota-sdk test`

### SDK-007 · Build the ESM and IIFE bundles with declarations and the size budget ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-sdk
- **Milestone:** M2
- **Depends on:** SDK-005
- **Size:** M
- **Read first:** ota/sdk/README.md §7; ota/sdk/docs/types-and-builds.md §3, §6, §7; ota/docs/adr/0016-sdk-packaging-and-type-contract.md (point 7)
- **Files:** `ota/sdk/scripts/build.mjs`, `ota/sdk/scripts/check-size.mjs`, `ota/sdk/package.json`, `ota/sdk/test/unit/bundle.test.js`
- **Steps:**
  1. `build.mjs`: esbuild ESM `dist/velexis-sdk.mjs` and IIFE `dist/velexis-sdk.iife.js` (`window.Velexis`), ES2022, minified, external source maps; then `tsc -p tsconfig.build.json` for `dist/types/`.
  2. `package.json` `exports`: `"."` → `{ types, development: "./src/index.js", import: "./dist/velexis-sdk.mjs" }`, `"./iife"`; `"sideEffects": false`; `files` limited to `dist`, `src`, `README.md`, `CHANGELOG.md`.
  3. `check-size.mjs` fails when the ESM bundle exceeds 25 KB min+gzip and prints the size.
  4. `bundle.test.js` imports the built ESM bundle in Node and loads the IIFE in happy-dom to check `window.Velexis.createVelexisClient`.
- **Acceptance:**
  - `pnpm --filter @velexis/ota-sdk build` writes both bundles and the declarations and passes the size check.
  - The bundle has no top-level side effects (importing it performs no `fetch` and touches no global except the IIFE's `window.Velexis`).
- **Verify:** `pnpm --filter @velexis/ota-sdk build && pnpm --filter @velexis/ota-sdk test`

### OFE-002 · Write the shared storefront modules: client, config, dom, format, forms, errors, i18n, url ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-frontend
- **Milestone:** M2
- **Depends on:** OFE-001, SDK-004
- **Size:** M
- **Read first:** ota/frontend/README.md §3 (`src/lib`), §5.2, §7, §10; docs/mvp/conventions.md §4; ota/docs/adr/0015-storefront-build-urls-and-hosting.md (point 7)
- **Files:** `ota/frontend/src/lib/client.js`, `ota/frontend/src/lib/config.js`, `ota/frontend/src/lib/dom.js`, `ota/frontend/src/lib/format.js`, `ota/frontend/src/lib/forms.js`, `ota/frontend/src/lib/errors.js`, `ota/frontend/src/lib/i18n.js`, `ota/frontend/src/lib/url.js`, `ota/frontend/test/format.test.js`, `ota/frontend/test/forms.test.js`, `ota/frontend/test/url.test.js`, `ota/frontend/test/config.test.js`, `ota/frontend/package.json`, `eslint.config.mjs`
- **Steps:**
  1. `client.js`: the single `createVelexisClient({ baseUrl: "/api", session: "cookie" })` (workspace dependency `@velexis/ota-sdk`).
  2. `config.js`: `storefront.get` cached in `sessionStorage` for 5 minutes, wrapped in `try/catch` so pages work without storage.
  3. `dom.js` (`$`, `$$`, `clone(templateId)`, `fill(el, data)` with `textContent` and safe attributes by `data-field`, `on()`); `format.js` (money with `Intl.NumberFormat`, airport-local times from their parts, durations `PT7H35M` → "7 h 35 min"); `forms.js` (serialisation, `fieldErrors` → `aria-invalid`/`aria-describedby`, focused error summary, submit state); `errors.js` (VelexisError code → page state); `i18n.js` (English strings, `Intl.PluralRules`); `url.js` (query helpers, safe `next`: one leading `/`, else `/`).
  4. Add ESLint `no-unsanitized` for `ota/frontend` so `innerHTML` with data fails lint.
- **Acceptance:**
  - Unit tests cover money in three currencies, a local time without time-zone shift, durations, field-error mapping with focus, `next=//evil.example` → `/`, and the config cache with a throwing `sessionStorage`.
  - A test file using `el.innerHTML = data` fails lint.
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm lint`

### OFE-003 · Build boot, theming, header, footer, banners and the shared page states ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-frontend
- **Milestone:** M2
- **Depends on:** OFE-002, SDK-005, OBE-016
- **Size:** M
- **Read first:** ota/frontend/README.md §2, §5.1, §6, §8; ota/frontend/docs/pages.md §2; ota/frontend/docs/pages-account.md §8; ota/docs/adr/0012-storefront-settings-assets-and-pages.md (points 4, 8)
- **Files:** `ota/frontend/src/boot.js`, `ota/frontend/src/lib/theme.js`, `ota/frontend/src/lib/session.js`, `ota/frontend/src/components/header.js`, `ota/frontend/src/components/footer.js`, `ota/frontend/src/components/test-banner.js`, `ota/frontend/src/components/live-region.js`, `ota/frontend/partials/test-banner.html`, `ota/frontend/partials/states.html`, `ota/frontend/test/theme.test.js`, `ota/frontend/test/boot.test.js`
- **Steps:**
  1. `boot()`: load the config, then in parallel apply the theme, fill header and footer (legal links, support contacts, currency selector from `config.currencies` remembered in `localStorage` and sent with `client.withOptions({ currency })`), show the test banner and `noindex` when `environment = test`, and ask `auth.getSession` for the account menu (`401` = signed out; the method arrives with SDK-008, so call it only when present). Returns `{ config, session, client }`.
  2. `theme.js`: colours, radius, fonts and favicon as CSS custom properties with `style.setProperty`; computes `--vx-on-primary` for 4.5:1 contrast and falls back to the neutral palette below WCAG contrast.
  3. Shared full-page states from `pages.md` §2: suspended, unknown host, service unavailable with Retry, rate limited, supplier not configured.
- **Acceptance:**
  - A config with a low-contrast primary colour falls back to the neutral palette (unit test).
  - `403 TENANT_SUSPENDED` from `storefront.get` renders the "temporarily unavailable" page; `403 HOST_NOT_ALLOWED` renders "this storefront does not exist" (happy-dom tests with a fake SDK).
  - No CSS text is injected (`style.setProperty` only, asserted by a test).
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-004 · Build the home page with the search form and location combobox ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-frontend
- **Milestone:** M2
- **Depends on:** OFE-003, OBE-015
- **Size:** M
- **Read first:** ota/frontend/docs/pages.md §3; ota/frontend/README.md §5, §8 (Search row); docs/velexis-sdk/examples/next-storefront/components/search-form.tsx and location-input.tsx (reference flow)
- **Files:** `ota/frontend/index.html`, `ota/frontend/src/pages/index.js`, `ota/frontend/src/components/location-combobox.js`, `ota/frontend/src/components/passenger-picker.js`, `ota/frontend/src/components/date-range.js`, `ota/frontend/partials/search-form.html`, `ota/frontend/test/location-combobox.test.js`, `ota/frontend/test/search-form.test.js`
- **Steps:**
  1. A real `<form method="get" action="/search.html">` with `from`, `to` (IATA codes in hidden inputs), `depart`, `return`, `trip`, `adults`, `children`, `infants`, `cabin`, and multi-city leg rows (`legs=`), working without JavaScript as a plain GET.
  2. `location-combobox.js`: ARIA 1.2 combobox over `reference.locations.search` (from 2 characters, 250 ms debounce, previous call aborted with `options.signal`); typed IATA codes accepted when the call fails; `reference.airports.get` fills the label for a pre-filled code.
  3. `passenger-picker.js` (disclosure with labelled steppers; infants ≤ adults; at most 9 seats) and `date-range.js` (native date inputs; return after departure). Defaults from the config.
- **Acceptance:**
  - Keyboard tests: arrow keys move `aria-activedescendant`, Enter selects, Escape closes and keeps the typed text.
  - Submitting builds the expected query string, including multi-city legs.
  - Typing quickly sends at most one request per 250 ms and aborts the previous one.
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-005 · Build the results page with filters, sort and load more ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-frontend
- **Milestone:** M2
- **Depends on:** OFE-004, OBE-021
- **Size:** L
- **Read first:** ota/frontend/docs/pages.md §4; ota/frontend/README.md §5.2, §7, §9; ota/docs/flows/search-and-price.md §3; docs/velexis-sdk/sdk/docs/B2.md (search and results)
- **Files:** `ota/frontend/search.html`, `ota/frontend/src/pages/search.js`, `ota/frontend/src/components/offer-card.js`, `ota/frontend/src/components/itinerary.js`, `ota/frontend/src/components/filters.js`, `ota/frontend/src/components/sort.js`, `ota/frontend/src/components/load-more.js`, `ota/frontend/partials/templates/offer-card.html`, `ota/frontend/partials/templates/segment.html`, `ota/frontend/test/filters.test.js`, `ota/frontend/test/search-page.test.js`
- **Steps:**
  1. Without `search=srch_…` in the URL, call `flights.search` (`mode: simple`, or `advanced` for multi-city; 60 s) and write the id into the URL with `history.replaceState`, so reload and Back never search again. With it, call `flights.getSearch` to rebuild the summary bar.
  2. `flights.listResults({ searchId, sort, ...filters, limit: 20 })` after every filter or sort change (cursor dropped); "Load more" uses `page.next()`.
  3. Filters from the facets (stops, carriers with names from `reference.airlines.list`, time bands, price slider plus number inputs, duration, cabin, bags, refundable, changeable, branded fares) mirrored in the query string; sort best, price, duration, departure, arrival. Airline name and IATA code instead of logos.
  4. States of `pages.md` §4 (searching skeleton and live region, no offers with suggestions, filters exclude everything, `410 SEARCH_EXPIRED` with Refresh, `504`/`503` with Retry, `400` back to the form).
- **Acceptance:**
  - Filters round-trip through the query string and survive reload without a new search (unit test with a fake SDK counting `flights.search` calls).
  - Offer cards render prices only from API totals (no client arithmetic) with `textContent`.
  - Each state of §4 renders for its error code.
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-006 · Build the offer page with fare families and pricing ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-frontend
- **Milestone:** M2
- **Depends on:** OFE-005, OBE-022, OBE-023
- **Size:** M
- **Read first:** ota/frontend/docs/pages.md §5; docs/velexis-sdk/sdk/docs/B2.md (upsell, price); docs/velexis-sdk/examples/next-storefront/app/flights/offers/ (reference flow)
- **Files:** `ota/frontend/offer.html`, `ota/frontend/src/pages/offer.js`, `ota/frontend/src/components/fare-families.js`, `ota/frontend/partials/templates/fare-family.html`, `ota/frontend/test/offer-page.test.js`
- **Steps:**
  1. `flights.getOffer({ offerId, view: "full" })`: itinerary, segments, layovers, baggage, fare conditions.
  2. When `features.brandedFareUpsell`: `flights.upsell({ offerId })` shown as fare-family cards; a failed upsell shows the original fare only, without an error banner.
  3. "Continue with this fare": `flights.price({ offerIds: [chosen], include: ["bags", "other-services", "detailed-fare-rules"] })` (60 s), then `/price.html?priced=prc_…`.
  4. States: `410 OFFER_EXPIRED` with a link back to refreshed results, `409 SOLD_OUT`, `504`/`503` with Retry keeping the choice.
- **Acceptance:**
  - With `brandedFareUpsell` off, no upsell call is made.
  - Choosing a fare family prices that family's `off_` id and navigates with the returned `prc_` id.
  - The states render for their codes (happy-dom tests).
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-007 · Build the price page with breakdown, extras preview and fare rules
- **Component:** ota-frontend
- **Milestone:** M2
- **Depends on:** OFE-006
- **Size:** M
- **Read first:** ota/frontend/docs/pages.md §6; ota/docs/adr/0005-markup-and-fee-engine.md (point 7, fee labels); docs/velexis-sdk/sdk/docs/B2.md (priced offers)
- **Files:** `ota/frontend/price.html`, `ota/frontend/src/pages/price.js`, `ota/frontend/src/components/price-breakdown.js`, `ota/frontend/partials/templates/price-line.html`, `ota/frontend/test/price-page.test.js`
- **Steps:**
  1. `flights.getPricedOffer({ pricedOfferId })`: totals per traveller type, taxes, fee lines with their labels, `priceChanged`, booking requirements, `expiresAt`.
  2. When `features.ancillaries`: `flights.getAncillaries` shown as "Available in checkout" (no selection). `flights.getFareRules` in a disclosure "Changes and refunds".
  3. `priceChanged: true` shows old and new totals with an explicit Continue; a countdown from `expiresAt`, then "Price expired" with Re-price.
  4. The Continue button is present but disabled with "Checkout opens soon" until OFE-011 wires `checkout.create` (M3).
- **Acceptance:**
  - The breakdown shows every fee line label and the total from the API.
  - The countdown reaches zero and shows the expired state (fake timers).
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-008 · Add the storefront Playwright project and the M2 search journey
- **Component:** ota-frontend
- **Milestone:** M2
- **Depends on:** OFE-007, PFE-014, OBE-026, SDK-007
- **Size:** M
- **Read first:** ota/frontend/README.md §11, §13; tools/e2e/README.md; platform/docs/adr/0017-platform-test-doubles-and-end-to-end-harness.md; ota/docs/adr/0015-storefront-build-urls-and-hosting.md (point 11); docs/mvp/adr/0015-testing-strategy.md (End-to-end)
- **Files:** `tools/e2e/playwright.config.ts`, `tools/e2e/support/stack.ts`, `tools/e2e/support/ota.ts`, `tools/e2e/support/storefront-guards.ts`, `tools/e2e/specs/storefront/search.e2e.ts`, `tools/e2e/README.md`, `.github/workflows/e2e.yml`
- **Steps:**
  1. Add the Playwright project `storefront` (base URL `http://127.0.0.1:4173`, `testMatch` `specs/storefront/**/*.e2e.ts`) to the harness of PFE-014.
  2. `support/stack.ts` with `E2E_WITH_OTA=1`: also build and start the OTA API and worker, run the platform and OTA `dev:seed` commands, and start `vite preview` of the storefront with the preview proxy (`STOREFRONT_DEV_HOST=demo.ota.example.com`) and the production CSP.
  3. `support/storefront-guards.ts`: fail the test on any `securitypolicyviolation`, on a request to a third-party host (Stripe is allowed only on `/checkout/pay-card.html`), on `document.cookie` containing anything but `__Host-vx_csrf`, and on serious or critical axe violations.
  4. `search.e2e.ts`: home → search (stub) → filter and sort → offer → branded fare → price; destination `ZZZ` shows "No flights found"; an expired search (a seeded `srch_` id whose `expires_at` is in the past) shows "Prices have expired"; a suspended tenant shows "temporarily unavailable" (platform admin API or direct row change through the migrator in test).
  5. Run the project in `.github/workflows/e2e.yml` next to the platform projects.
- **Acceptance:**
  - The journey passes locally and in the nightly workflow against the production build [OF-02 AC1].
  - Every guard of step 3 is active and a deliberately inline script in a test page makes the run fail.
- **Verify:** `pnpm --filter @velexis/ota-frontend build && E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/search.e2e.ts`

## M3 — Book & pay

Checkout, customer accounts in cookies, Stripe on the Velexis account, the airline-card path (test environment only), order creation and ticketing, e-mails and documents, my bookings, guest lookup, change and cancel.

### OBE-029 · Spec-first: airline-card method, completion operation and payment account modes ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-009
- **Size:** M
- **Read first:** ota/docs/api-changes.md §3, §4, §6; ota/docs/adr/0004-airline-card-data-handling.md (point 1); ota/sdk/docs/extensions.md §3.1, §4, §5; docs/mvp/adr/0006-contract-first-openapi.md (Workflow)
- **Files:** `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, `ota/backend/openapi/README.md`, `packages/api-types/src/generated/ota.ts`, `packages/api-types/src/generated/operations.ts`, `packages/errors/src/generated/catalogue.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/contract/openapi-extensions.contract.test.ts`, `ota/sdk/src/internal/operations.js`
- **Steps:**
  1. Apply §3.1: `PaymentCreateRequest.method` and `Payment.method` add `airline_card`; `Payment.provider` adds `airline`; `PaymentNextAction.type` adds `airline_card_form`; descriptions of `clientSecret`, `providerPublicKey`, `providerPaymentId` say "always null for airline payments".
  2. Add `completeCheckoutWithAirlineCard` exactly as §3.2 (`x-sdk-method: checkout.completeWithAirlineCard`, `x-scope: customer`, `x-edge-only: true`, `x-milestone: M3`, required `Idempotency-Key`, `CsrfToken`, `x-amadeus`, `x-tenant-tables`) and the `AirlineCardCompletionRequest` schema with `x-sensitive: true` on `card`.
  3. Apply §4 to `StorefrontPaymentConfig`: `accountMode`, `merchantName`, `statementDescriptor`, `airlineCard`, `supportedMethods` adds `airline_card`, descriptions of `publishableKey` and `accountId`.
  4. Add `PAYMENT_ATTEMPTS_EXCEEDED` (403) to the catalogue. Lint, regenerate, add the new operation to `pending-operations.ts` (task OBE-051), extend the contract test (the new operation is edge-only and never has an `sk_`-only security entry). Run `pnpm --filter @velexis/ota-sdk generate` so the SDK route table has the new entry and SDK-002's CI check stays green; `checkout` is still a pending namespace, so the SDK parity test passes until SDK-009 adds the method.
- **Acceptance:**
  - `pnpm contracts:lint` is clean; the operations index has 97 operations and the new one has `edgeOnly: true`.
  - Generated types contain `AirlineCardCompletionRequest` and `StorefrontPaymentConfig.accountMode`.
  - The route parity test passes with the new pending entry.
  - `pnpm --filter @velexis/ota-sdk generate` leaves no diff and the SDK tests pass.
- **Verify:** `pnpm contracts:lint && pnpm contracts:generate && pnpm --filter @velexis/ota-backend test -- contract && pnpm --filter @velexis/ota-sdk generate && git diff --exit-code ota/sdk/src/internal/operations.js && pnpm --filter @velexis/ota-sdk test`

### OBE-030 · Add the notifications outbox, template registry, renderer, mailer and sweep ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-024, OBE-014, X-025
- **Size:** L
- **Read first:** ota/docs/adr/0013-notifications-and-booking-documents.md (points 1–5); docs/mvp/adr/0017-email-documents-storage.md; docs/velexis-sdk/db/README.md §6 and §8 (outbox, secret purge); docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE notifications`, `CREATE TABLE notification_templates`)
- **Files:** `ota/backend/src/notifications/notifications.module.ts`, `ota/backend/src/notifications/outbox.service.ts`, `ota/backend/src/notifications/outbox.repository.ts`, `ota/backend/src/notifications/template.service.ts`, `ota/backend/src/notifications/template.service.test.ts`, `ota/backend/src/notifications/renderer.ts`, `ota/backend/src/notifications/mailer.gateway.ts`, `ota/backend/src/notifications/notifications.processor.ts`, `ota/backend/src/notifications/templates/registry.ts`, `ota/backend/src/notifications/templates/auth.verify_email.subject.hbs`, `ota/backend/src/notifications/templates/auth.verify_email.html.hbs`, `ota/backend/src/notifications/templates/auth.verify_email.txt.hbs`, `ota/backend/src/notifications/templates/auth.password_reset.subject.hbs`, `ota/backend/src/notifications/templates/auth.password_reset.html.hbs`, `ota/backend/src/notifications/templates/auth.password_reset.txt.hbs`, `ota/backend/src/jobs/schedulers.ts`, `ota/backend/src/config.ts`, `ota/backend/package.json`, `ota/backend/test/integration/notifications/outbox.int.test.ts`
- **Steps:**
  1. Add exact `nodemailer` 6 and `handlebars` 4.7. Config `SMTP_URL`, `MAIL_FROM`, `OPS_ALERT_EMAIL`, `PUBLIC_OTA_ADMIN_URL`.
  2. `outbox.service.ts`: `enqueue(trx, {templateKey, to, locale, data, secretData?, dedupeKey})` inserts a `pending` row in the caller's transaction (secrets envelope-encrypted in `secret_payload_ciphertext`, payload redacted); `afterCommit` enqueues `notify {tenantId}`.
  3. `template.service.ts`: effective template = active tenant row, else code default for the locale, else English; Handlebars strict mode with the key's variable allow-list (registry of OBE-004).
  4. `notifications.processor.ts` on `ota-notifications`: take due rows with `FOR UPDATE SKIP LOCKED` (100 per job), render, send with `From: "<brand name>" <MAIL_FROM address>` and `Reply-To` from `support_email`, then mark `sent` or retry (5 attempts, exponential from 1 minute) and erase `secret_payload_ciphertext` at a final status. `notifications.sweep` (1 minute) enqueues tenants with due rows.
  5. Write the `auth.verify_email` and `auth.password_reset` defaults with links to `/account/verify.html?token=…` and `/account/reset-password.html?token=…` on the tenant's storefront host.
- **Acceptance:**
  - An outbox row inserted in a rolled-back transaction is never sent; a committed one arrives in Mailpit (`waitForMessage`).
  - After sending, `secret_payload_ciphertext` is NULL; with SMTP down the row stays `pending` and is retried.
  - A tenant template using a variable outside the allow-list fails to render with a clear error; the code default is used when the tenant row is inactive.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- notifications && pnpm --filter @velexis/ota-backend test:int -- notifications`

### OBE-031 · Add token signing, customer sessions, the cookie writer and the customer guard ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-013, X-005
- **Size:** M
- **Read first:** ota/docs/architecture.md §3 (step 8) and §3.2; ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md (points 1, 2, 5); docs/mvp/adr/0008-identity-accounts-customers-sessions.md; docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE customer_sessions`)
- **Files:** `ota/backend/src/identity/identity.module.ts`, `ota/backend/src/identity/token.service.ts`, `ota/backend/src/identity/token.service.test.ts`, `ota/backend/src/identity/sessions.repository.ts`, `ota/backend/src/identity/sessions.service.ts`, `ota/backend/src/common/auth/customer.guard.ts`, `ota/backend/src/common/auth/customer.guard.test.ts`, `ota/backend/src/common/http/cookie-writer.ts`, `ota/backend/src/config.ts`, `ota/backend/package.json`, `ota/backend/test/integration/identity/sessions.int.test.ts`
- **Steps:**
  1. Add exact `jose` 5 and `argon2`. Config `JWT_PRIVATE_KEY_FILE`. `token.service.ts`: EdDSA JWTs with `kid`, `typ: customer`, `sub: cus_…`, `tid`, `sid`, 15 minutes; verification with clock skew 30 s.
  2. `sessions.service.ts`: refresh families in `customer_sessions` (256-bit opaque tokens stored as hashes; 12 h, 30 days with `rememberMe`; rotation on every refresh; reuse of a rotated token revokes the family).
  3. `cookie-writer.ts`: `setSession(res, tokens)` writes `__Host-vx_at` (900 s) and `__Host-vx_rt` (remaining family lifetime) and rotates `__Host-vx_csrf`; `clearSession(res)`; edge mode only.
  4. `CustomerGuard`: bearer token (key callers) or `__Host-vx_at` cookie (edge only; cookies on key callers are ignored); `tid` must equal the resolved tenant; `401 TOKEN_EXPIRED` for an expired token.
- **Acceptance:**
  - A token of tenant A presented at tenant B answers 401 [OF-01 AC2].
  - Reusing a rotated refresh token revokes every session of the family (integration test).
  - Cookies carry `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and no `Domain`; key callers never receive `Set-Cookie`.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- identity && pnpm --filter @velexis/ota-backend test:int -- identity`

### OBE-032 · Implement customer sign-up, e-mail verification and resend
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-031, OBE-030
- **Size:** M
- **Read first:** ota/docs/flows/my-bookings-and-guest-lookup.md §3 (steps 1–2); ota/docs/api-changes.md §2.2 (`signUp`); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: signUp`, `verifyEmail`, `resendEmailVerification`); docs/velexis-sdk/sdk/docs/B1.md (sign-up)
- **Files:** `ota/backend/src/identity/auth.controller.ts`, `ota/backend/src/identity/sign-up.service.ts`, `ota/backend/src/identity/verification.service.ts`, `ota/backend/src/identity/customers.repository.ts`, `ota/backend/src/identity/customers.mapper.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/identity/sign-up.int.test.ts`
- **Steps:**
  1. `auth.signUp`: create `customers` and `customer_identities` (Argon2id, OWASP parameters), record `customer_consents` with `terms_version` and `privacy_version` from settings, queue `auth.verify_email` with the token only in `secretData`. When `require_email_verification` is off, open a session: cookies in edge mode (`session: null` in the body), tokens in bearer mode.
  2. `auth.verifyEmail`: consume the token, set `email_verified_at`, attach guest bookings whose `contact_email` matches and that have no customer (`claimedGuestBookings`).
  3. `auth.resendVerification`: same answer whether or not the e-mail exists; rate limits of architecture §8 (5 per hour per IP, 3 per hour per e-mail).
  4. Remove the three operations from `pending-operations.ts`.
- **Acceptance:**
  - Sign-up then the Mailpit link verifies the address; the token is single use and expires.
  - The same e-mail at two tenants creates two customers; a duplicate at one tenant answers 409.
  - Edge sign-up with verification off returns `session: null` and sets the cookies; bearer sign-up returns tokens.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- identity`

### OBE-033 · Implement sign-in with lockout, refresh rotation, sign-out and getSession ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-031
- **Size:** L
- **Read first:** ota/docs/flows/my-bookings-and-guest-lookup.md §1, §3 (steps 3, 6, 7), §4; ota/docs/api-changes.md §2.2 (`signIn`, `refreshSession`, `signOut`); ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md (points 4, 5); ota/docs/architecture.md §8
- **Files:** `ota/backend/src/identity/auth.controller.ts`, `ota/backend/src/identity/sign-in.service.ts`, `ota/backend/src/identity/sign-in.service.test.ts`, `ota/backend/src/identity/lockout.ts`, `ota/backend/src/identity/sessions.service.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/identity/sign-in.int.test.ts`
- **Steps:**
  1. `auth.signIn`: Argon2id verification; 10 per minute per IP; 5 failures per identity lock it for 15 minutes (`t:<tenantId>:<env>:authfail:<sha256(email)>`, `423 ACCOUNT_LOCKED`); edge mode sets the cookies, rotates the CSRF cookie and returns `AuthSessionInfo`; bearer mode returns `AuthSessionResult`.
  2. `auth.refresh`: edge mode reads `__Host-vx_rt` and refuses a body token (`400 INVALID_REQUEST`); rotation; reuse answers `401 REFRESH_TOKEN_REUSED`, revokes the family and clears the cookies.
  3. `auth.signOut` (current session or `scope: all`) clears the cookies; `auth.getSession` returns `AuthSessionInfo` from the access token.
  4. Remove the four operations from `pending-operations.ts`.
- **Acceptance:**
  - The fifth wrong password locks the identity; the sixth attempt answers 423 even with the right password.
  - Edge sign-in, refresh and change of session never put a token in the body; bearer mode is unchanged (both modes tested).
  - Refresh with an old rotated token revokes the family and clears both cookies.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- identity && pnpm --filter @velexis/ota-backend test:int -- identity`

### OBE-034 · Implement password reset and change
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-033, OBE-030
- **Size:** M
- **Read first:** docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: requestPasswordReset`, `resetPassword`, `changePassword`); ota/docs/api-changes.md §2.2; docs/mvp/adr/0008-identity-accounts-customers-sessions.md (password reset)
- **Files:** `ota/backend/src/identity/password.service.ts`, `ota/backend/src/identity/password-resets.repository.ts`, `ota/backend/src/identity/auth.controller.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/identity/password.int.test.ts`
- **Steps:**
  1. `auth.requestPasswordReset`: same answer for known and unknown e-mails; token hash in `customer_password_resets` (1 hour); `auth.password_reset` e-mail with the token in `secretData`; rate limits of architecture §8.
  2. `auth.resetPassword`: consume the token, set the new hash, revoke all sessions, optionally open a session (cookies in edge mode, `session: null`).
  3. `auth.changePassword` (customer guard): verify the current password, revoke other sessions, rotate the current session and the CSRF cookie; edge mode returns `AuthSessionInfo`.
  4. Remove the three operations from `pending-operations.ts`.
- **Acceptance:**
  - A reset link works once; after use every older session is revoked.
  - Unknown and known e-mails get byte-identical responses (apart from `requestId`).
  - Change password with a wrong current password answers 401 and changes nothing.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- identity`

### OBE-035 · Implement account get, update and delete
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-033
- **Size:** M
- **Read first:** ota/docs/scope.md §3.1 (account rows); ota/docs/flows/my-bookings-and-guest-lookup.md §3 (step 9); docs/velexis-sdk/db/README.md §7 (deletion); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: getAccount`, `updateAccount`, `deleteAccount`)
- **Files:** `ota/backend/src/account/account.module.ts`, `ota/backend/src/account/account.controller.ts`, `ota/backend/src/account/account.service.ts`, `ota/backend/src/account/account.repository.ts`, `ota/backend/src/account/account.mapper.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/account/account.int.test.ts`
- **Steps:**
  1. `account.get` and `account.update` (`If-Match` on the customer `version`; e-mail change re-verifies the address).
  2. `account.delete`: re-authentication as the contract requires, soft delete at once (`deleted_at`, status), revoke every session, clear the cookies in edge mode; bookings keep `customer_id` until the M6 erasure job (OBE-087).
  3. The deferred account operations stay in `pending-operations.ts` as `deferred`; remove the three implemented ones.
- **Acceptance:**
  - A stale `If-Match` answers 412; tenant B cannot read tenant A's customer.
  - After deletion the session cookie no longer works and sign-in answers 401.
  - `account.preferences.get` answers 501 `NOT_IMPLEMENTED`.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- account`

### OBE-036 · Implement checkout create, get, travellers, contacts and remarks ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-023, OBE-031, OBE-014
- **Size:** L
- **Read first:** ota/docs/flows/checkout-stripe.md §1 and §2 (steps 1–2); ota/docs/data-model.md §4 (encrypted columns); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: createCheckout`, `getCheckout`, `setCheckoutTravelers`, `setCheckoutContacts`, `setCheckoutRemarks`); docs/velexis-sdk/sdk/docs/B3.md §2
- **Files:** `ota/backend/src/checkout/checkout.module.ts`, `ota/backend/src/checkout/checkout.controller.ts`, `ota/backend/src/checkout/checkout.service.ts`, `ota/backend/src/checkout/checkout.repository.ts`, `ota/backend/src/checkout/checkout.mapper.ts`, `ota/backend/src/checkout/requirements.ts`, `ota/backend/src/checkout/requirements.test.ts`, `ota/backend/src/checkout/traveler-documents.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/builders/checkouts.ts`, `ota/backend/test/integration/checkout/checkout.int.test.ts`
- **Steps:**
  1. `checkout.create` from a non-expired `prc_…` (`410 OFFER_EXPIRED` otherwise): customer or guest (`features.guestCheckout`), `403 EMAIL_NOT_VERIFIED` when the settings require it; totals from the priced offer; `expires_at = now + checkout_ttl_minutes`; requirements from `booking_requirements`.
  2. `checkout.get` with progress; `setTravelers`, `setContacts`, `setRemarks` replace their part with `If-Match` (`412` on a stale version) and validate against the requirements (`422 TRAVELER_DATA_INVALID` / `CONTACT_DATA_INVALID` with `fieldErrors`, never echoing values).
  3. Documents and discount cards go into `documents_ciphertext` / `discount_eligibility_ciphertext` with associated data `tenant_<key>.checkout_travelers.documents_ciphertext:<id>`; only last 4, expiry and countries stay readable.
  4. Remove the five operations from `pending-operations.ts`.
- **Acceptance:**
  - A full checkout can be filled step by step in edge and key mode; responses validate against the document.
  - The database holds no plain document number (query asserts the ciphertext column and the absence of the number in every text column).
  - Tenant B gets 404 for tenant A's `chk_` id; an expired checkout answers 410.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- checkout && pnpm --filter @velexis/ota-backend test:int -- checkout`

### OBE-037 · Implement checkout.setAncillaries with re-pricing and service fees
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-036
- **Size:** M
- **Read first:** ota/docs/flows/checkout-stripe.md §2 (step 2); ota/docs/adr/0005-markup-and-fee-engine.md (point 7); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: setCheckoutAncillaries`)
- **Files:** `ota/backend/src/checkout/ancillaries.service.ts`, `ota/backend/src/checkout/ancillaries.service.test.ts`, `ota/backend/src/checkout/checkout.controller.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/checkout/ancillaries.int.test.ts`
- **Steps:**
  1. Validate selections against the priced offer's ancillary catalogue; call Flight Offers Price with `additionalServices` (no transaction open during the call) and store a child priced offer (`parent_priced_offer_id`); `checkouts.priced_offer_id` points at it.
  2. Apply `ancillary_service` fee rules per extra; check `expectedTotal` (`409 PRICE_CHANGED` with the new total, selection kept); `409 ANCILLARY_NOT_AVAILABLE` for an unknown option.
  3. Remove the operation from `pending-operations.ts`.
- **Acceptance:**
  - Adding a bag re-prices into a child priced offer and the checkout totals satisfy `total = offer + ancillaries + fees`.
  - A mismatching `expectedTotal` answers 409 and changes nothing.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- checkout`

### OBE-038 · Add the Stripe gateway and the checkout payment endpoints in Velexis mode ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-036, OBE-029
- **Size:** L
- **Read first:** ota/docs/adr/0010-stripe-gateway-and-payment-webhooks.md (points 1–3, 7, 8); ota/docs/architecture.md §5.1; ota/docs/flows/checkout-stripe.md §2 (steps 3–4); ota/docs/api-changes.md §4; docs/mvp/adr/0011-payments-stripe-and-airline-card.md (A)
- **Files:** `ota/backend/src/payments/payments.module.ts`, `ota/backend/src/payments/payment-gateway.ts`, `ota/backend/src/payments/stripe/stripe-client.factory.ts`, `ota/backend/src/payments/stripe/stripe.gateway.ts`, `ota/backend/src/payments/stripe/stripe.gateway.test.ts`, `ota/backend/src/payments/payments.controller.ts`, `ota/backend/src/payments/payments.service.ts`, `ota/backend/src/payments/payments.repository.ts`, `ota/backend/src/payments/card-fees.ts`, `ota/backend/src/storefront/storefront.mapper.ts`, `ota/backend/src/config.ts`, `ota/backend/package.json`, `deploy/env/ota-backend.env.example`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/payments/create-payment.int.test.ts`
- **Steps:**
  1. Add exact `stripe` 18 (pinned `apiVersion`, 10 s timeout, `maxNetworkRetries: 1`). Config `STRIPE_SECRET_KEY_TEST`, `STRIPE_PUBLISHABLE_KEY_TEST`, `STRIPE_SECRET_KEY_LIVE`, `STRIPE_PUBLISHABLE_KEY_LIVE` (live may be empty until M6).
  2. `PaymentGateway` interface (`createSession`, `refresh`, `capture`, `void`, `refund`); `StripeGateway` reads the cached `payment_provider_connections` row and serves `account_mode = velexis` (M5 adds the other modes; any other mode answers `424 PAYMENT_PROVIDER_NOT_CONFIGURED` until then).
  3. `checkout.createPayment {method: "card", termsAccepted}`: complete data required (`422 CHECKOUT_INCOMPLETE`); insert the `payments` row and commit **before** the PaymentIntent (`capture_method: manual`, 3-D Secure `automatic` or `any` when `require_3ds`, metadata `velexis_tenant_id`, `velexis_environment`, `checkout_id`, `payment_id`, statement descriptor suffix, idempotency `pi:create:<pay_id>`); store the PaymentIntent id; checkout `payment_pending`, expiry +15 min.
  4. `checkout.getPayment` (`refresh` re-reads Stripe) and `checkout.updatePayment {card: {brand, bin}}`: quote the Amadeus credit-card fee (`include=credit-card-fees`) plus `payment_card` rules, update totals and the PaymentIntent amount (`pi:update:<pay_id>:<version>`).
  5. `storefront.get` now fills `StorefrontPaymentConfig` for `velexis` mode (`accountMode`, publishable key of the environment, `merchantName` "Velexis on behalf of <OTA name>", `statementDescriptor`, `supportedMethods: ["card"]`). Remove the three payment operations from `pending-operations.ts`.
- **Acceptance:**
  - With Stripe mocked at the HTTP layer, the PaymentIntent carries manual capture, the four metadata keys and the idempotency key; the `payments` row exists before the Stripe call (call-order assertion).
  - Stripe unreachable answers `502 PAYMENT_PROVIDER_ERROR` and charges nothing; the same idempotency key can be retried.
  - `storefront.get` shows `accountMode: "velexis"` and the merchant name; no secret key appears in any response.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- payments && pnpm --filter @velexis/ota-backend test:int -- payments`

### OBE-039 · Receive Stripe webhooks and process them with re-fetch
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-038, X-028
- **Size:** L
- **Read first:** ota/docs/adr/0010-stripe-gateway-and-payment-webhooks.md (points 4–5); ota/docs/api-changes-console-and-internal.md §5; docs/mvp/architecture.md §5 (d); packages/testing/README.md (`stripe`)
- **Files:** `ota/backend/src/payments/webhooks/stripe-velexis-webhook.controller.ts`, `ota/backend/src/payments/webhooks/webhook-receiver.service.ts`, `ota/backend/src/payments/webhooks/webhook-receiver.service.test.ts`, `ota/backend/src/payments/stripe-events.processor.ts`, `ota/backend/src/payments/payment-state.ts`, `ota/backend/src/payments/payment-state.test.ts`, `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, `ota/backend/test/contract/openapi-extensions.contract.test.ts`, `ota/backend/src/config.ts`, `ota/backend/test/integration/payments/webhooks.int.test.ts`
- **Steps:**
  1. Document `receiveStripeVelexisWebhook` (`POST /webhooks/stripe/velexis/{environment}`, tag `Internal`, `x-internal: true`, `x-milestone: M3`) in the OpenAPI document, then implement it; the contract test asserts this operation's extensions (internal, M3, no `x-sdk-method`, no API-key security) by operationId. Config `STRIPE_WEBHOOK_SECRET_VELEXIS_TEST`, `_LIVE`.
  2. Verify the signature on the raw body (`400` on failure); check `event.livemode` against the path's environment and `metadata.velexis_environment` (a mismatch is logged as a security event and acknowledged with `200` without effect); find the tenant from `metadata.velexis_tenant_id` (only Velexis creates PaymentIntents on this account, OADR-0010 point 4) and the payment from `metadata.payment_id`, then `provider_payment_id`, inside that tenant only (a payment whose `provider_payment_id` differs from the event's object is a security event); insert a `payment_events` row (`source = webhook`, `type = webhook.<type>`, `provider_event_id`, redacted payload) in a tenant transaction; a unique violation is a duplicate; answer 200; enqueue `stripe.event {tenantId, paymentEventId}` with the Stripe event id as job id. Unknown tenant or payment: log and acknowledge.
  3. `stripe-events.processor.ts` re-fetches the PaymentIntent, charge or refund and applies the state with the payment `version`: `amount_capturable_updated` (authorized), `succeeded` (captured), `payment_failed`, `canceled`, `charge.refunded` and `charge.refund.updated` (refund rows), `charge.dispute.created` (staff alert only). Other types are stored and ignored.
- **Acceptance:**
  - A signed fixture is stored once and processed once; the same event delivered twice creates one row and one job.
  - A payload changed after signing answers 400; an event with an unknown tenant answers 200 and writes nothing.
  - A signed `livemode: true` event on `/velexis/test` answers 200, writes nothing and logs a security event.
  - The processor applies Stripe's re-fetched state even when the event body is stale (fixture with an old status).
- **Verify:** `pnpm --filter @velexis/ota-backend test -- payments && pnpm --filter @velexis/ota-backend test -- contract && pnpm --filter @velexis/ota-backend test:int -- payments`

### OBE-040 · Add the payments queue: voids, capture retries, refunds and the authorisation watch
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-039, OBE-030
- **Size:** M
- **Read first:** ota/docs/adr/0010-stripe-gateway-and-payment-webhooks.md (point 6); ota/docs/adr/0008-ticketing-policy.md (points 6–7); ota/docs/architecture.md §6; docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE refunds`)
- **Files:** `ota/backend/src/payments/payments.processor.ts`, `ota/backend/src/payments/payments.processor.test.ts`, `ota/backend/src/payments/refunds.repository.ts`, `ota/backend/src/payments/authorisation-watch.processor.ts`, `ota/backend/src/jobs/schedulers.ts`, `ota/backend/test/integration/payments/payments-queue.int.test.ts`
- **Steps:**
  1. `ota-payments` processor: `payment.void` (`pi:cancel:<pay_id>`), `payment.capture_retry` (`pi:capture:<pay_id>:<amount>`, once after 10 minutes, then staff alert), `refund.submit` (`refund:<rfd_id>`). Each job re-reads the row and does nothing if the state already moved.
  2. `payments.authorisation_watch` (06:15 UTC daily): outbox `staff.manual_review` alert for authorised, uncaptured Stripe payments older than 5 days.
  3. Refund rows: `requested_by_type`, amount ≤ captured − refunded; final state from the webhook (OBE-039).
- **Acceptance:**
  - A void job for an already cancelled payment makes no Stripe call.
  - Two `refund.submit` jobs for one refund row make one Stripe refund call (same idempotency key).
  - The watch alerts once per payment (FakeClock).
- **Verify:** `pnpm --filter @velexis/ota-backend test -- payments && pnpm --filter @velexis/ota-backend test:int -- payments`

### OBE-041 · Stub the order operations with in-memory orders and scenarios ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-019
- **Size:** L
- **Read first:** ota/backend/README.md §7; ota/docs/architecture-booking.md §4 (what reconciliation reads); docs/amadeus-api/FlightCreateOrders_v1_Version_1.16_swagger_specification.json, FlightOrderIssue_v1_Version_1.8_swagger_specification.json, FlightOrderManagement_v1_Version_1.15_swagger_specification.json, GetFlightOrderByRecordLocator_v1_Version_1.10_swagger_specification.json, QueueList_v1_Version_1.0_swagger_specification.json (grep `paths`)
- **Files:** `tools/amadeus-stub/src/routes.ts`, `tools/amadeus-stub/src/orders.ts`, `tools/amadeus-stub/src/handlers/create-orders.ts`, `tools/amadeus-stub/src/handlers/issue.ts`, `tools/amadeus-stub/src/handlers/order-management.ts`, `tools/amadeus-stub/src/handlers/by-reference.ts`, `tools/amadeus-stub/src/handlers/queue-list.ts`, `tools/amadeus-stub/src/scenarios.ts`, `tools/amadeus-stub/fixtures/flight-create-orders/success.json`, `tools/amadeus-stub/fixtures/flight-order-issue/success.json`, `tools/amadeus-stub/test/orders.test.ts`, `tools/amadeus-stub/README.md`
- **Steps:**
  1. `orders.ts`: an in-memory store of created orders (id, record locator, offices, travellers, remarks, queue placement from `automatedProcess`, tickets, status, version) with a `reset()` for tests.
  2. Flight Create Orders stores the order and returns it (with tickets when `issue=true`); `formOfPayments.creditCard` is accepted (number never stored: the stub keeps last 4 only) and test PAN `4000000000000002` returns a card refusal. Flight Order Issue adds tickets; Management GET, PATCH (contacts) and DELETE; by-reference GET; Queue List returns orders placed on the queue with creation time and names.
  3. Scenarios: `ticketing-failed` (9112), `version-conflict` (2552 on PATCH), `timeout` on create **after** storing the order (the order exists, so reconciliation can find it), `timeout-lost` (no order stored), `sold-out` on create.
- **Acceptance:**
  - A created order is visible through Management GET, by-reference GET and Queue List.
  - `timeout` on create still stores the order; `timeout-lost` does not.
  - The stub's request log never contains a full card number (test).
- **Verify:** `pnpm --filter @velexis/amadeus-stub build && pnpm --filter @velexis/amadeus-stub test`

### OBE-042 · Build the booking orchestrator and checkout.complete for Stripe ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-038, OBE-041, OBE-030
- **Size:** L
- **Read first:** ota/docs/architecture-booking.md §1 and §2; ota/docs/adr/0003-booking-orchestration-and-supplier-timeout-recovery.md (points 1–3); ota/docs/adr/0008-ticketing-policy.md (point 1); ota/docs/flows/checkout-stripe.md §2 (steps 5–7) and §3; docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: completeCheckout`)
- **Files:** `ota/backend/src/bookings/bookings.module.ts`, `ota/backend/src/bookings/booking-orchestrator.service.ts`, `ota/backend/src/bookings/booking-orchestrator.service.test.ts`, `ota/backend/src/bookings/bookings.repository.ts`, `ota/backend/src/bookings/order-recorder.ts`, `ota/backend/src/bookings/order-request.builder.ts`, `ota/backend/src/bookings/order-request.builder.test.ts`, `ota/backend/src/bookings/booking-reference.ts`, `ota/backend/src/checkout/checkout.controller.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/builders/bookings.ts`, `ota/backend/test/integration/bookings/complete-stripe.int.test.ts`
- **Steps:**
  1. **Claim (T1):** lock the checkout, check status, expiry, completeness; re-read the PaymentIntent (`requires_capture`, amount = total, else `402 PAYMENT_REQUIRED`); insert `bookings` (`pending`, new reference, `create_order_started_at`, amounts copied); `bookings.checkout_id` unique; commit.
  2. **Call:** re-price when the priced offer is expired, older than 10 minutes or carries discount data (higher total → void, booking `failed`, `409 PRICE_CHANGED`); Flight Create Orders with remark `VELEXIS <reference>`, `automatedProcess` on the tenant's booking queue, `formOfPayments` `other` (OTA-merchant model), `issue` per policy (`issue_at_booking`, `instantTicketingRequired`). Rejections → void, booking `failed`, checkout open (`409 SOLD_OUT`, `422 TRAVELER_DATA_INVALID`, `502 SUPPLIER_ERROR`).
  3. **Record (T2):** booking `confirmed` (or `ticketed`), children, redacted `order_snapshot`, `booking_events`, `ticketing_deadline_at` (OADR-0008 point 3), checkout `completed`, outbox `booking.confirmed`; the timeout path is added by OBE-043.
  4. **Money:** capture (`pi:capture:<pay_id>:<amount>`); failure → `ticketing_status = manual_review`, `payment.capture_retry`, staff alert, `201` with a warning. **Issue** for `issue_after_payment`: Flight Order Issue; failure → `ticketing_status = failed` and the next attempt time (OBE-044 retries).
  5. `checkout.complete` requires `Idempotency-Key`; remove it from `pending-operations.ts`. The guest token is added by OBE-047.
- **Acceptance:**
  - Authorise, create the order, capture and issue succeed for each ticketing policy [OF-04 AC1].
  - An Amadeus rejection voids the authorisation and keeps the checkout open [OF-04 AC2].
  - Two calls with the same key create one order; another key answers `409 CHECKOUT_ALREADY_COMPLETED`; no transaction is open during the Amadeus call (spy on the pool).
- **Verify:** `pnpm --filter @velexis/ota-backend test -- bookings && pnpm --filter @velexis/ota-backend test:int -- bookings`

### OBE-043 · Reconcile timed-out orders and replay the 504
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-042, OBE-040
- **Size:** L
- **Read first:** ota/docs/architecture-booking.md §4 and §5.2; ota/docs/adr/0003-booking-orchestration-and-supplier-timeout-recovery.md (points 4–6); ota/docs/data-model.md §3.3
- **Files:** `ota/backend/src/bookings/reconcile.processor.ts`, `ota/backend/src/bookings/reconcile.service.ts`, `ota/backend/src/bookings/reconcile.service.test.ts`, `ota/backend/src/bookings/booking-orchestrator.service.ts`, `ota/backend/src/common/http/idempotency.service.ts`, `ota/backend/src/jobs/schedulers.ts`, `ota/backend/test/integration/bookings/reconcile.int.test.ts`
- **Steps:**
  1. On a timeout or network error after the create request was sent: `reconcile_until = create_order_started_at + 15 min`, event `booking.supplier_timeout`, enqueue `booking.reconcile` (delay 30 s), answer `504 SUPPLIER_TIMEOUT {bookingId}`. Never send Flight Create Orders again for the checkout.
  2. `reconcile.processor.ts` on `ota-bookings` (claim with `reconcile_attempts + 1`): Queue List of the booking queue, PNRs created between `create_order_started_at − 1 min` and `+ 5 min` with the lead last name, at most three by-reference reads, accept only the remark `VELEXIS <reference>`. `bookings.reconcile_scan` (1 minute) enqueues due pending bookings.
  3. Outcomes: found → record (step 3 of OBE-042), capture, issue per policy, `reconcile_outcome = found`, e-mail; not found (Stripe) → void, booking `failed` (`SUPPLIER_TIMEOUT`), checkout reopened if not expired, `booking.not_confirmed`, staff alert; no booking queue → the same after 15 minutes with "check the office by hand". The airline-card branch (manual review) is added by OBE-051.
  4. The idempotency `resolveReplay` hook (OBE-014) returns the same `504` while the booking is pending and undecided, then the final `201` built from the booking or the final error.
- **Acceptance:**
  - Stub `timeout`: the replay answers 504 until the reconciler finds the order, then 201 with the booking; the booking is reconciled within 15 minutes (FakeClock) [OF-04 AC3].
  - Stub `timeout-lost`: after 15 minutes the authorisation is voided, the booking is `failed` and the traveller e-mail is queued.
  - A PNR with the right name but no `VELEXIS` remark is never accepted.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- bookings && pnpm --filter @velexis/ota-backend test:int -- bookings`

### OBE-044 · Retry ticketing until the deadline with resync
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-042
- **Size:** M
- **Read first:** ota/docs/adr/0008-ticketing-policy.md (points 3–5, 8); ota/docs/flows/ticketing-and-documents.md §2, §3 (steps 1–4), §4, §7; ota/docs/adr/0014-per-tenant-workers-and-schedulers.md (point 6)
- **Files:** `ota/backend/src/bookings/ticketing.processor.ts`, `ota/backend/src/bookings/ticketing.service.ts`, `ota/backend/src/bookings/ticketing-schedule.ts`, `ota/backend/src/bookings/ticketing-schedule.test.ts`, `ota/backend/src/jobs/schedulers.ts`, `ota/backend/test/integration/bookings/ticketing.int.test.ts`
- **Steps:**
  1. `ticketing-schedule.ts`: +5 min, +15 min, +1 h, then every 2 h; at most 8 attempts; never after `ticketing_deadline_at − 2 h`; payment-reason failures are not retried.
  2. `ticketing.processor.ts` on `ota-ticketing`: claim (`ticketing_status = in_progress`, `ticketing_last_attempt_at`, `SKIP LOCKED`, a claim older than 5 minutes counts as abandoned), Flight Order Management GET first; tickets present → record them; otherwise Flight Order Issue; failure → next attempt or give up (`ticketing_next_attempt_at = NULL`, outbox `staff.ticketing_failed` and `booking.ticketing_delayed`).
  3. `ticketing.scan` (5 minutes) enqueues due bookings, including suspended tenants. Airline-card bookings without tickets are never retried (OBE-051 sets them to manual review).
- **Acceptance:**
  - Stub `ticketing-failed`: attempts follow the schedule and stop at deadline − 2 h; alerts are written once [OF-06 AC1].
  - A timed-out issue followed by a GET that shows tickets makes no second issue call [OF-06 AC2].
- **Verify:** `pnpm --filter @velexis/ota-backend test -- bookings && pnpm --filter @velexis/ota-backend test:int -- bookings`

### OBE-045 · Sync bookings with Amadeus on a schedule
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-042
- **Size:** M
- **Read first:** ota/docs/flows/ticketing-and-documents.md §3 (step 5); ota/docs/adr/0014-per-tenant-workers-and-schedulers.md (points 2, 4, 6); ota/docs/architecture.md §6 (`bookings.sync_scan`)
- **Files:** `ota/backend/src/bookings/booking-sync.processor.ts`, `ota/backend/src/bookings/booking-sync.service.ts`, `ota/backend/src/bookings/order-diff.ts`, `ota/backend/src/bookings/order-diff.test.ts`, `ota/backend/src/jobs/schedulers.ts`, `ota/backend/test/integration/bookings/sync.int.test.ts`
- **Steps:**
  1. `bookings.sync_scan` (10 minutes) enqueues `booking.sync` for the 20 oldest synced active bookings per tenant (suspended tenants included).
  2. The processor claims the booking, reads Flight Order Management GET (`include=bags`), and applies the diff: new tickets, schedule changes (`booking.schedule_changed` event, flagged for the console), cancellation by the airline (`cancelled_by = airline`); writes `last_synced_at` and the redacted `order_snapshot` with the booking `version`.
  3. No customer e-mail for schedule changes in the MVP.
- **Acceptance:**
  - A segment time change in the stub produces one `booking.schedule_changed` event and an updated segment.
  - An order cancelled in the stub becomes `cancelled` with `cancelled_by = airline`.
  - A concurrent change of the booking (version bump) makes the sync retry instead of overwriting.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- bookings && pnpm --filter @velexis/ota-backend test:int -- bookings`

### OBE-046 · Implement customer bookings: list, get, ticketing status, events and fare rules
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-042, OBE-033
- **Size:** M
- **Read first:** ota/docs/flows/my-bookings-and-guest-lookup.md §3 (steps 4–5); docs/velexis-sdk/db/README.md §10 (my-trips queries); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: listBookings`, `getBooking`, `getBookingTicketingStatus`, `listBookingEvents`, `getBookingFareRules`)
- **Files:** `ota/backend/src/bookings/customer-bookings.controller.ts`, `ota/backend/src/bookings/customer-bookings.service.ts`, `ota/backend/src/bookings/bookings.mapper.ts`, `ota/backend/src/bookings/bookings.mapper.test.ts`, `ota/backend/src/bookings/allowed-actions.ts`, `ota/backend/src/bookings/allowed-actions.test.ts`, `ota/backend/src/common/auth/booking-access.guard.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/bookings/customer-bookings.int.test.ts`
- **Steps:**
  1. `bookings.list` with `timeframe` `upcoming`, `past`, `cancelled` on the three customer indexes, newest departure first for past and cancelled; only bookings of the caller's environment.
  2. `bookings.get` (`refresh=true` triggers a Management GET at most once a minute per booking) with `allowedActions`; `bookings.getTicketingStatus` (`pollAfterSeconds`), `bookings.listEvents` (customer-visible events only), `bookings.getFareRules`.
  3. `booking-access.guard.ts`: the owning customer, or a guest booking token (OBE-047 adds the cookie and header sources); anyone else gets 404.
  4. Remove the five operations from `pending-operations.ts`.
- **Acceptance:**
  - The three lists return the bookings that db README §10 defines for each timeframe [OF-07 AC1].
  - Another customer's booking, or a test booking seen from a live storefront, answers 404.
  - Staff-only events (notes) never appear in `bookings.listEvents`.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- bookings && pnpm --filter @velexis/ota-backend test:int -- bookings`

### OBE-047 · Implement guest booking tokens and bookings.lookup
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-046
- **Size:** M
- **Read first:** ota/docs/flows/my-bookings-and-guest-lookup.md §2, §3 (step 8), §4, §7; ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md (point 6); ota/docs/api-changes.md §2.2 (`completeCheckout`, `lookupBooking`); docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE booking_access_tokens`)
- **Files:** `ota/backend/src/bookings/guest-access.service.ts`, `ota/backend/src/bookings/guest-access.service.test.ts`, `ota/backend/src/bookings/lookup.controller.ts`, `ota/backend/src/common/auth/booking-access.guard.ts`, `ota/backend/src/common/http/cookie-writer.ts`, `ota/backend/src/bookings/booking-orchestrator.service.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/bookings/guest-access.int.test.ts`
- **Steps:**
  1. Issue a booking access token (256-bit, stored hashed) for guest bookings at completion (until trip end) and at lookup (24 h). Edge mode prepends `bkg_<id>.<token>` to `__Host-vx_bt` (at most 5, `~`-separated, newest first) and returns `bookingToken: null`; key callers get the token in the body.
  2. `booking-access.guard.ts` reads `__Host-vx_bt` (edge) or `X-Booking-Token` (keys) and picks the entry of the requested booking.
  3. `bookings.lookup` (`Idempotency-Key`): reference, record locator or associated record plus traveller last name, in the storefront environment; byte-identical `404` for every mismatch; 5 failures per 15 minutes per IP and per reference → 429; event `booking.lookup`.
  4. Remove `lookupBooking` from `pending-operations.ts`.
- **Acceptance:**
  - Wrong reference and wrong name give identical 404 bodies apart from `requestId`; the sixth failure answers 429 [OF-07 AC2].
  - A sixth guest booking drops the oldest cookie entry; the cookie is `HttpOnly`.
  - A guest token of booking A cannot open booking B.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- bookings && pnpm --filter @velexis/ota-backend test:int -- bookings`

### OBE-048 · Implement bookings.update for contacts and remarks
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-047
- **Size:** M
- **Read first:** ota/docs/flows/change-and-cancel.md §1, §3 (steps 1–2), §4; docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: updateBooking`)
- **Files:** `ota/backend/src/bookings/booking-changes.service.ts`, `ota/backend/src/bookings/booking-changes.service.test.ts`, `ota/backend/src/bookings/customer-bookings.controller.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/bookings/update.int.test.ts`
- **Steps:**
  1. `bookings.update` with `If-Match` (`412` when stale): `contacts` and `remarks` only; `travelers[…]` answers `403 FEATURE_DISABLED` (`details.feature = "travelerChanges"`).
  2. Flight Order Management PATCH with the full contacts list (no transaction open); 2552 → `409 VERSION_CONFLICT`; a timeout resyncs and answers 504.
  3. Record: redacted `order_snapshot`, `booking_contacts`, `contact_email`, `version + 1`, event `booking.contacts_updated`, outbox confirmation to the old and the new address.
  4. Remove `updateBooking` from `pending-operations.ts`.
- **Acceptance:**
  - Contacts change at Amadeus (stub) and in the booking, and both addresses get an e-mail [OF-08 AC1].
  - Stub `version-conflict` answers 409 and changes nothing locally.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- bookings`

### OBE-049 · Implement cancellation quotes and cancellation with the money step
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-048, OBE-040
- **Size:** L
- **Read first:** ota/docs/flows/change-and-cancel.md §2, §3 (steps 3–7), §4, §7; ota/docs/adr/0003-booking-orchestration-and-supplier-timeout-recovery.md (point 7); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: quoteBookingCancellation`, `cancelBooking`)
- **Files:** `ota/backend/src/bookings/cancellation.service.ts`, `ota/backend/src/bookings/cancellation-mode.ts`, `ota/backend/src/bookings/cancellation-mode.test.ts`, `ota/backend/src/bookings/customer-bookings.controller.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/bookings/cancel.int.test.ts`
- **Steps:**
  1. `cancellation-mode.ts` (pure): `release` (nothing ticketed), `void` (every ticket issued today in the OTA's time zone), `request_only` (ticketed outside the void window), `not_allowed` (flown, cancelled, pending, within 3 hours of departure, self-service off). Refund estimate keeps non-refundable fees and applies `cancellation` fee rules.
  2. `bookings.quoteCancellation`: Management GET with refund fare rules, refresh snapshot and tickets, cache the quote in `t:<tenantId>:<env>:cxq:<bookingId>` (10 minutes; the contract text says `cxq:{bookingId}`, the OTA keeps every tenant-data key under `t:<tenantId>:<env>:`).
  3. `bookings.cancel` (`If-Match`, `Idempotency-Key`, `expectedRefund` else `409 REFUND_AMOUNT_CHANGED`): `release`/`void` → Management DELETE, booking `cancelled` (`cancelled_by = customer`), segments and tickets updated, events, outbox `booking.cancelled`; money step once: Stripe not captured → void, captured → `refunds` row and `refund.submit`, airline card → `payment_events` `airline.void_expected` only. Amadeus refusal → `request_only` (`202`). `request_only` → event, `booking.cancellation_requested`, staff alert, `202`. Timeout on DELETE → `504`, booking flagged, GET within 15 minutes, replay until decided.
  4. Remove both operations from `pending-operations.ts`.
- **Acceptance:**
  - Release and void cancel the order and void or refund the payment exactly once, even with two calls on the same key and a retried refund job [OF-08 AC2].
  - Mode unit tests cover unticketed, ticketed today, ticketed yesterday and flown fixtures.
  - Cancelling an airline-card booking makes no Stripe call and writes the `payment_events` row.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- bookings && pnpm --filter @velexis/ota-backend test:int -- bookings`

### OBE-050 · Add the airline-card gateway, SensitiveCard and net pricing
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-038
- **Size:** M
- **Read first:** ota/docs/adr/0004-airline-card-data-handling.md (points 1, 2, 4, 5); ota/docs/api-changes.md §3.1; ota/docs/flows/checkout-airline-card.md §1 and §3 (steps 1–2); ota/docs/data-model.md §3.1–§3.2; ota/docs/architecture.md §9 (redaction additions)
- **Files:** `ota/backend/src/payments/airline-card/airline-card.gateway.ts`, `ota/backend/src/payments/airline-card/sensitive-card.ts`, `ota/backend/src/payments/airline-card/sensitive-card.test.ts`, `ota/backend/src/payments/payments.service.ts`, `ota/backend/src/checkout/pricing-mode.ts`, `ota/backend/src/checkout/pricing-mode.test.ts`, `ota/backend/src/storefront/storefront.mapper.ts`, `ota/backend/src/config.ts`, `packages/logger/src/redact-paths.ts`, `packages/logger/src/redaction.test.ts`, `ota/backend/test/integration/payments/airline-card-payment.int.test.ts`
- **Steps:**
  1. Config `AIRLINE_CARD_ENABLED` (default `false`). `createPayment {method: "airline_card"}` is refused with `403 FEATURE_DISABLED` (`details.feature = "airlineCard"`) unless the switch and `storefront_settings.airline_card_enabled_<env>` are on, and with `403 SCOPE_NOT_ALLOWED` unless the caller is the edge.
  2. It sets `checkouts.pricing_mode = 'net'`, recomputes totals as the Amadeus total plus Amadeus-priced extras (engine bypassed, OADR-0005 point 9), cancels other active payments of the checkout and inserts `payments` (`provider = airline`, `method = airline_card`, `capture_method = automatic`, `requires_payment_method`, `nextAction.type = airline_card_form`); no provider call. Choosing `card` again restores `markup_rules`.
  3. `updatePayment {card: {brand, bin}}` quotes the Amadeus card fee for that brand and BIN.
  4. `SensitiveCard`: private fields; `toJSON`, `toString` and `util.inspect.custom` return `"[redacted card]"`; readers `last4()`, `bin()`, `brand()`; `toAmadeusCreditCard()` returns the full values for the Amadeus body only.
  5. Add `holderName`, `expiryMonth`, `expiryYear`, the `card` object, `x-velexis-edge`, `x-csrf-token`, `x-booking-token` and `stripe-signature` to the central redaction list `REDACT_PATHS` in `packages/logger/src/redact-paths.ts` (X-003; no second list), with tests in `redaction.test.ts`. `storefront.get` lists `airline_card` in `supportedMethods` and fills `airlineCard` only when both switches are on **and the caller is the edge** (the operation is edge-only, so `pk_` and `sk_` callers never see the method); this is decided per request by `storefront.mapper.ts`, never stored in the shared cache (OBE-016).
- **Acceptance:**
  - With the switch off, the method is absent from `storefront.get` and `createPayment` answers 403 [OF-05 AC3]; with it on, a `pk_` call followed by an edge call (one cache fill) shows `airline_card` to the edge only.
  - A key caller gets `403 SCOPE_NOT_ALLOWED` [OF-05 AC2 groundwork].
  - `JSON.stringify`, template strings and `util.inspect` of a `SensitiveCard` never show the number; the redaction test covers every new path.
- **Verify:** `pnpm --filter @velexis/logger test && pnpm --filter @velexis/ota-backend test -- payments && pnpm --filter @velexis/ota-backend test:int -- payments`

### OBE-051 · Implement checkout.completeWithAirlineCard
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-050, OBE-043
- **Size:** L
- **Read first:** ota/docs/api-changes.md §3.2; ota/docs/architecture-booking.md §3 and §5.1 (point 4); ota/docs/adr/0004-airline-card-data-handling.md (points 2, 3, 5–7); ota/docs/flows/checkout-airline-card.md §2–§4
- **Files:** `ota/backend/src/payments/airline-card/airline-card-completion.controller.ts`, `ota/backend/src/payments/airline-card/airline-card-completion.service.ts`, `ota/backend/src/payments/airline-card/card-validation.ts`, `ota/backend/src/payments/airline-card/card-validation.test.ts`, `ota/backend/src/payments/airline-card/abuse-limits.ts`, `ota/backend/src/bookings/booking-orchestrator.service.ts`, `ota/backend/src/bookings/reconcile.service.ts`, `ota/backend/src/main.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/payments/airline-card-completion.int.test.ts`
- **Steps:**
  1. Route `POST /v1/checkouts/{checkoutId}/airline-card-completion` with its own 10 KB JSON parser, excluded from `pino-http` body serialisers and Sentry breadcrumbs; Ajv errors carry paths only. Checks: edge only, kill switch and tenant setting, Redis available (else 503), limits (5 per minute per IP, 3 attempts per checkout in `t:<tenantId>:<env>:ac:chk:<checkoutId>`, 60 per hour per tenant), Luhn, expiry not past, brand in `accepted_card_brands`.
  2. Idempotency with the `hashInput` hook replacing `card` by `{brand, last4}`; the SDK and the handler never retry.
  3. Orchestration as OBE-042 with `issue = true` and `formOfPayments: [{creditCard: {brand, holder (upper case), number, expiryDate "YYYY-MM", securityCode, flightOfferIds}}]`, `paymentOperationContext.interactionCondition = ECOMMERCE`; the redacted request (last 4, no security code) is built from `SensitiveCard` **before** the call and passed to the client; the reference is cleared in `finally`.
  4. Record: booking `ticketed`, `pricing_mode = net`, `markup_amount = 0`; payment `captured` with brand, BIN, last 4; `payment_events` `airline.charged`. Decline → booking `failed`, payment `failed`, attempt counted, `402 PAYMENT_DECLINED`; third decline → `403 PAYMENT_ATTEMPTS_EXCEEDED`, `staff.airline_card_alert` and an ops alert; 20 declines per tenant per hour suspend the method for an hour (Redis flag). Order without tickets → `ticketing_status = manual_review`, `201` with a warning.
  5. Timeout → reconcile (OBE-043); not found → `manual_review` and staff alert, never `failed`. Remove the operation from `pending-operations.ts`.
- **Acceptance:**
  - Success against the stub returns 201 with a ticketed booking and a captured payment carrying last 4 only.
  - `pk_`, `sk_` and (later) service-key callers get `403 SCOPE_NOT_ALLOWED` [OF-05 AC2]; the fourth attempt on a checkout is refused.
  - A lost answer (`timeout-lost`) ends in `manual_review`, not `failed`.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- payments && pnpm --filter @velexis/ota-backend test:int -- payments`

### OBE-052 · Prove the card number never reaches a log, table, Redis or queue
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-051, OBE-049
- **Size:** M
- **Read first:** ota/docs/flows/checkout-airline-card.md §7; ota/docs/adr/0004-airline-card-data-handling.md (point 2); docs/mvp/adr/0011-payments-stripe-and-airline-card.md (C); ota/backend/README.md §8
- **Files:** `ota/backend/test/integration/payments/pan-absence.int.test.ts`, `ota/backend/test/support/pan-scanner.ts`, `ota/backend/test/support/log-capture.ts`, `.github/workflows/ci.yml`
- **Steps:**
  1. `log-capture.ts` captures every pino line of the API and worker during the test; `pan-scanner.ts` scans every text and jsonb column of every tenant table, every Redis key and value, every BullMQ job's data and the captured logs for the PAN `4111111111111111`, its last 12 digits and the CVV `123` (as a JSON value).
  2. Drive the success, decline (`4000000000000002`), `timeout`, `timeout-lost`, validation-error (bad Luhn) and idempotent-replay paths, then cancel the successful booking.
  3. Make the test part of the default `test:int` run in CI (not skippable by pattern).
- **Acceptance:**
  - None of the values appears anywhere after any path [OF-05 AC1].
  - Deliberately logging the request body in a scratch branch makes the test fail (documented in the test file's header as a manual check).
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- pan-absence`

### OBE-053 · Render itinerary and e-ticket PDFs in the documents queue
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-042, OBE-030
- **Size:** L
- **Read first:** ota/docs/adr/0013-notifications-and-booking-documents.md (points 6–8); ota/docs/flows/ticketing-and-documents.md §3 (step 7); docs/mvp/adr/0017-email-documents-storage.md; docs/velexis-sdk/db/tenant.sql (grep `CREATE TABLE booking_documents`)
- **Files:** `ota/backend/src/documents/documents.module.ts`, `ota/backend/src/documents/documents.processor.ts`, `ota/backend/src/documents/documents.repository.ts`, `ota/backend/src/documents/renderers/itinerary.renderer.ts`, `ota/backend/src/documents/renderers/e-ticket-receipt.renderer.ts`, `ota/backend/src/documents/renderers/renderers.test.ts`, `ota/backend/src/documents/fonts/README.md`, `ota/backend/src/config.ts`, `ota/backend/package.json`, `ota/backend/test/integration/documents/render.int.test.ts`
- **Steps:**
  1. Add exact `pdfmake` 0.2 with fonts bundled in the repository (open licences); config `STORAGE_DRIVER`, `STORAGE_DIR`; `StorageAdapter` from `@velexis/db`.
  2. `document.render {tenantId, bookingId, kind, bookingVersion[, ticketId]}` on `ota-documents`: job key `document.render:<bookingId>:<kind>:<bookingVersion>[:<ticketId>]`, a second job for the same key is a no-op; enqueued after commit when an order is recorded (`itinerary`), when tickets are stored (`e_ticket_receipt` per ticket and a new itinerary; the previous one `superseded`) and on cancellation (itinerary marked cancelled).
  3. Renderers use only booking data and the square logo from `storefront_assets` (read from storage, no network); store `tenant_<key>/documents/<bookingId>/<documentId>.pdf` with SHA-256 in `content_hash`; `failed` status on errors with retries.
- **Acceptance:**
  - Rendering the same booking version twice produces the same hash and one row.
  - A ticketed booking gets one receipt per ticket and the earlier itinerary becomes `superseded`.
  - No document number appears in full in the PDF text (only the masked form).
- **Verify:** `pnpm --filter @velexis/ota-backend test -- documents && pnpm --filter @velexis/ota-backend test:int -- documents`

### OBE-054 · Implement document listing, signed download URLs and the file endpoint
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-053, OBE-047
- **Size:** M
- **Read first:** ota/docs/adr/0013-notifications-and-booking-documents.md (point 9); ota/docs/api-changes-console-and-internal.md §5 (`downloadFile`); ota/docs/flows/ticketing-and-documents.md §3 (step 8), §7; docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: listBookingDocuments`, `getBookingDocumentDownloadUrl`)
- **Files:** `ota/backend/src/documents/documents.controller.ts`, `ota/backend/src/documents/files.controller.ts`, `ota/backend/src/documents/signed-url.ts`, `ota/backend/src/documents/signed-url.test.ts`, `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, `ota/backend/test/contract/openapi-extensions.contract.test.ts`, `ota/backend/src/config.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/documents/download.int.test.ts`
- **Steps:**
  1. Document `downloadFile` (`GET /v1/files/{storageKey}`, `x-sdk-exclude`, `security: []`, `x-milestone: M3`) in the OpenAPI document; the contract test asserts these extensions by operationId (the baseline counts of OBE-009 are unaffected). Config `DOCUMENT_URL_KEY_FILE`.
  2. `bookings.listDocuments` (ready documents only) and `bookings.getDocumentDownloadUrl`: a 5-minute HMAC-SHA-256 URL, same-origin `/api/v1/files/…` for the edge and `PUBLIC_OTA_API_URL/v1/files/…` for key callers; `409 DOCUMENT_NOT_READY` while rendering.
  3. `/v1/files/{storageKey}?exp=…&sig=…`: verify signature and expiry (`403`), re-check that the key's tenant is the request's tenant (`404` otherwise), stream with `Content-Disposition: attachment`, 120 per minute per IP.
  4. Remove both SDK operations from `pending-operations.ts`.
- **Acceptance:**
  - Expired or tampered signatures answer 403; another tenant's key answers 404.
  - The edge receives a same-origin path, a key caller an absolute URL on `api.ota.example.com`.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- documents && pnpm --filter @velexis/ota-backend test -- contract && pnpm --filter @velexis/ota-backend test:int -- documents`

### OBE-055 · Write the booking and staff e-mail templates with attachments
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-053, OBE-044
- **Size:** M
- **Read first:** ota/docs/adr/0013-notifications-and-booking-documents.md (points 3–5, 8); ota/docs/flows/ticketing-and-documents.md §3 (step 7 table); ota/docs/api-changes-console-and-internal.md §2.6 (MVP keys); ota/docs/adr/0015-storefront-build-urls-and-hosting.md (point 5)
- **Files:** `ota/backend/src/notifications/templates/registry.ts`, `ota/backend/src/notifications/templates/booking.confirmed.html.hbs`, `ota/backend/src/notifications/templates/booking.ticketed.html.hbs`, `ota/backend/src/notifications/templates/booking.ticketing_delayed.html.hbs`, `ota/backend/src/notifications/templates/booking.cancelled.html.hbs`, `ota/backend/src/notifications/templates/booking.cancellation_requested.html.hbs`, `ota/backend/src/notifications/templates/booking.not_confirmed.html.hbs`, `ota/backend/src/notifications/templates/staff.ticketing_failed.html.hbs`, `ota/backend/src/notifications/templates/staff.manual_review.html.hbs`, `ota/backend/src/notifications/templates/staff.airline_card_alert.html.hbs`, `ota/backend/src/notifications/attachments.ts`, `ota/backend/src/notifications/staff-recipients.ts`, `ota/backend/src/notifications/templates/templates.test.ts`, `ota/backend/test/integration/notifications/booking-emails.int.test.ts`
- **Steps:**
  1. Write subject, HTML and text defaults for the nine keys (only the HTML files are listed; add the matching `.subject.hbs` and `.txt.hbs` next to each). Links use `/booking.html?id=bkg_…` on the tenant's storefront host; the confirmation says that invoices come from the OTA.
  2. Variable allow-lists per key in the registry; a test compiles every default in strict mode with its sample data.
  3. `attachments.ts`: `booking.confirmed` attaches the itinerary and `booking.ticketed` the receipts when `ready`; otherwise wait up to 2 minutes, then send with a link instead.
  4. `staff-recipients.ts`: `ops_alert_email`, else the owners' e-mails from the platform (read-only membership and account columns).
- **Acceptance:**
  - Every default compiles and renders with its sample data; a variable outside the allow-list fails the test.
  - A booking flow produces the confirmation with the itinerary attached and, after ticketing, the e-ticket e-mail with receipts (Mailpit).
  - Staff alerts go to `ops_alert_email` when set, else to the owners.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- notifications && pnpm --filter @velexis/ota-backend test:int -- notifications`

### OBE-056 · Add the checkout expiry and retention schedulers
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-040, OBE-047
- **Size:** M
- **Read first:** ota/docs/architecture.md §6 (`checkouts.expire`, `retention.daily`); ota/docs/data-model.md §6; ota/docs/adr/0014-per-tenant-workers-and-schedulers.md (points 2, 4)
- **Files:** `ota/backend/src/checkout/checkout-expiry.processor.ts`, `ota/backend/src/jobs/retention.processor.ts`, `ota/backend/src/jobs/retention.repository.ts`, `ota/backend/src/jobs/schedulers.ts`, `ota/backend/test/integration/jobs/expiry-retention.int.test.ts`
- **Steps:**
  1. `checkouts.expire` (1 minute): per tenant, at most 50 `open`/`payment_pending` checkouts past `expires_at` become `expired`; authorised payments get `payment.void`.
  2. `retention.daily` (03:35 UTC): `supplier_requests` older than 90 days, `queue_snapshots` older than 30 days, expired `idempotency_keys`, customer sessions, reset tokens and booking access tokens expired more than 7 days ago; batches of 1 000; counts logged.
  3. Suspended tenants are included (obligations to paid travellers).
- **Acceptance:**
  - An expired checkout with an authorised payment ends `expired` and its void job runs once (FakeClock).
  - Retention deletes only rows past their limits and never touches bookings, payments, refunds, events, documents or staff actions.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- jobs`

### OBE-057 · Prove cookie sessions, CSRF and both caller modes for customer operations
- **Component:** ota-backend
- **Milestone:** M3
- **Depends on:** OBE-035, OBE-047, OBE-049, OBE-054
- **Size:** M
- **Read first:** ota/docs/scope.md §4 (OF-03, OF-07); ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md (point 9); ota/docs/flows/my-bookings-and-guest-lookup.md §7; docs/mvp/conventions.md §12
- **Files:** `ota/backend/test/integration/m3/cookie-mode.int.test.ts`, `ota/backend/test/integration/m3/csrf-matrix.int.test.ts`, `ota/backend/test/integration/m3/customer-isolation.int.test.ts`
- **Steps:**
  1. For every auth and booking-access operation, in edge mode: no token in any body, cookie attributes as OADR-0006, JS-readable cookies limited to `__Host-vx_csrf`; in bearer mode the same operations return their tokens.
  2. Table-driven CSRF matrix over every state-changing customer operation: missing header, different header, foreign `Origin`, missing `Origin` with `Sec-Fetch-Site: cross-site` → 403; key callers unaffected.
  3. Customer isolation: tokens, guest cookies and ids of tenant A at tenant B; test bookings from a live storefront.
- **Acceptance:**
  - No token ever appears in a storefront response body or a JS-readable cookie [OF-03 AC1].
  - Every state-changing edge call without a matching `X-CSRF-Token` answers `403 CSRF_TOKEN_INVALID` [OF-03 AC2].
  - Cross-tenant access answers 401 or 404 in every case.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- m3`

### SDK-008 · Write the auth and account namespaces with cookie-mode results
- **Component:** ota-sdk
- **Milestone:** M3
- **Depends on:** SDK-006, OBE-033
- **Size:** M
- **Read first:** docs/velexis-sdk/sdk/src/identity.d.ts (`AuthApi`, `AccountApi`); docs/velexis-sdk/sdk/docs/B1.md; ota/sdk/docs/extensions.md §6; ota/sdk/README.md §4.1 (responses without tokens)
- **Files:** `ota/sdk/src/namespaces/auth.js`, `ota/sdk/src/namespaces/account.js`, `ota/sdk/src/identity.js`, `ota/sdk/test/unit/namespaces-auth.test.js`, `ota/sdk/test/contract/pending-namespaces.js`, `ota/sdk/test/contract/deviations.ts`, `ota/sdk/test/fixtures/auth-session-info.json`
- **Steps:**
  1. Factories with the ten `auth.*` and twelve `account.*` methods (nine deferred), one line each, with full JSDoc; `auth.signIn`, `auth.refresh` and `auth.changePassword` are typed `AuthSessionResult | AuthSessionInfo` with the deviation entry of OADR-0006.
  2. In token and server mode, `signIn` and `refresh` results feed the session (`onSessionRefreshed`); in cookie mode nothing is stored.
  3. Remove `auth` and `account` from `pending-namespaces.js`.
- **Acceptance:**
  - The contract test passes with exactly the approved deviations.
  - Cookie-mode `auth.refresh` sends an empty body; token-mode sends the refresh token.
  - Deferred methods surface `ServerError` `NOT_IMPLEMENTED`.
- **Verify:** `pnpm --filter @velexis/ota-sdk build && pnpm --filter @velexis/ota-sdk test`

### SDK-009 · Write the checkout namespace including completeWithAirlineCard ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-sdk
- **Milestone:** M3
- **Depends on:** SDK-006, OBE-029
- **Size:** M
- **Read first:** docs/velexis-sdk/sdk/src/bookings.d.ts (`CheckoutApi`); docs/velexis-sdk/sdk/docs/B3.md §2; ota/sdk/docs/extensions.md §3.1; ota/docs/adr/0017-airline-card-form-isolation.md (point 6)
- **Files:** `ota/sdk/src/namespaces/checkout.js`, `ota/sdk/src/bookings.js`, `ota/sdk/test/unit/namespaces-checkout.test.js`, `ota/sdk/test/contract/pending-namespaces.js`, `ota/sdk/docs/extensions.md`
- **Steps:**
  1. Factory with the ten contract methods and `completeWithAirlineCard`; JSDoc for each. `complete` and `completeWithAirlineCard` use 90 s; `completeWithAirlineCard` is `retry: "never"`, its arguments never reach `onResponse` or an error's `toJSON`.
  2. Run `pnpm --filter @velexis/ota-sdk generate` so the route table has the new operation; update `docs/extensions.md` if anything differs from the document.
  3. Remove `checkout` from `pending-namespaces.js`.
- **Acceptance:**
  - A 503 on `completeWithAirlineCard` throws at once with one request (no retry); `complete` retries with the same idempotency key.
  - An error from `completeWithAirlineCard` serialises without any card field.
- **Verify:** `pnpm --filter @velexis/ota-sdk generate && pnpm --filter @velexis/ota-sdk build && pnpm --filter @velexis/ota-sdk test`

### SDK-010 · Write the bookings namespace ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-sdk
- **Milestone:** M3
- **Depends on:** SDK-006
- **Size:** M
- **Read first:** docs/velexis-sdk/sdk/src/bookings.d.ts (`BookingsApi`); docs/velexis-sdk/sdk/docs/B3.md §3–§5; ota/sdk/README.md §4.1
- **Files:** `ota/sdk/src/namespaces/bookings.js`, `ota/sdk/src/bookings.js`, `ota/sdk/test/unit/namespaces-bookings.test.js`, `ota/sdk/test/contract/pending-namespaces.js`
- **Steps:**
  1. Factory with the fourteen `bookings.*` methods (three deferred), JSDoc for each; `ifMatch` on `update` and `cancel`; `bookingToken` per call in token mode, refused in cookie mode.
  2. `bookings.lookup` resolves with `bookingToken: null` in cookie mode (approved deviation already listed).
  3. Remove `bookings` from `pending-namespaces.js`.
- **Acceptance:**
  - `bookings.list` returns a `Page` that iterates across cursors.
  - Passing `bookingToken` in cookie mode throws `TypeError` before any request.
- **Verify:** `pnpm --filter @velexis/ota-sdk build && pnpm --filter @velexis/ota-sdk test`

### OFE-009 · Build the authentication pages and the account menu
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-003, SDK-008, OBE-032, OBE-034
- **Size:** M
- **Read first:** ota/frontend/docs/pages-account.md §1 and §5; ota/frontend/README.md §8 (Authentication row), §10 (tokens in URLs, redirects); ota/docs/flows/my-bookings-and-guest-lookup.md §3–§4; docs/velexis-sdk/sdk/docs/B1.md
- **Files:** `ota/frontend/account/sign-in.html`, `ota/frontend/account/sign-up.html`, `ota/frontend/account/verify.html`, `ota/frontend/account/forgot-password.html`, `ota/frontend/account/reset-password.html`, `ota/frontend/src/pages/account-sign-in.js`, `ota/frontend/src/pages/account-sign-up.js`, `ota/frontend/src/pages/account-verify.js`, `ota/frontend/src/pages/account-forgot-password.js`, `ota/frontend/src/pages/account-reset-password.js`, `ota/frontend/src/lib/session.js`, `ota/frontend/test/auth-pages.test.js`
- **Steps:**
  1. Sign-up (terms and privacy links from the config, consent checkbox), sign-in (`rememberMe`), verify (`?token=` read once and removed with `history.replaceState`), forgot password (same message whether or not the e-mail exists), reset password (`?token=`).
  2. Every page uses the SDK in cookie mode; on success redirect to a validated `next` or `/account/`. States: `401 INVALID_CREDENTIALS`, `423 ACCOUNT_LOCKED`, expired or used tokens, `fieldErrors` with the focused summary.
  3. `lib/session.js`: the account menu from `auth.getSession` (sign-in link when signed out, name and sign-out when signed in; sign-out calls `auth.signOut`).
- **Acceptance:**
  - Tokens are removed from the address bar after reading (happy-dom test on `history.replaceState`).
  - `next=https://evil.example` redirects to `/`.
  - Password fields allow paste and password managers (`autocomplete` tokens present).
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-010 · Build the account page
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-009, OBE-035
- **Size:** M
- **Read first:** ota/frontend/docs/pages-account.md §6; ota/docs/scope.md §2.2 (account rows); docs/velexis-sdk/sdk/docs/B1.md (account)
- **Files:** `ota/frontend/account/index.html`, `ota/frontend/src/pages/account-index.js`, `ota/frontend/src/components/dialog.js`, `ota/frontend/test/account-page.test.js`
- **Steps:**
  1. Profile with `account.get` and `account.update` (`ifMatch`, `412` reload); change password (`auth.changePassword`); sign out everywhere (`auth.signOut({ scope: "all" })`).
  2. Delete account in a native `<dialog>` with re-authentication as the contract requires; on success go to `/` signed out.
  3. Not signed in → `/account/sign-in.html?next=/account/`. Saved travellers are not offered (`features.savedTravelers = false`).
- **Acceptance:**
  - A stale version shows "updated elsewhere, reload" and keeps the typed values.
  - After deletion the account menu shows "Sign in".
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-011 · Build the checkout data page
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-007, SDK-009, OBE-037, OBE-038
- **Size:** L
- **Read first:** ota/frontend/docs/pages.md §6 (step 4) and §7; ota/docs/flows/checkout-stripe.md §2 (steps 1–3); docs/velexis-sdk/sdk/docs/B3.md §2; docs/velexis-sdk/examples/next-storefront/app/checkout/ (reference flow)
- **Files:** `ota/frontend/checkout.html`, `ota/frontend/src/pages/checkout.js`, `ota/frontend/src/components/stepper.js`, `ota/frontend/src/components/traveller-form.js`, `ota/frontend/src/components/contact-form.js`, `ota/frontend/src/components/ancillary-picker.js`, `ota/frontend/src/components/error-summary.js`, `ota/frontend/partials/templates/traveller-form.html`, `ota/frontend/src/pages/price.js`, `ota/frontend/test/checkout-page.test.js`
- **Steps:**
  1. Wire the price page's Continue to `checkout.create({ pricedOfferId })` (guest checkout off and no session → sign-in with `next`).
  2. One page, steps `travellers`, `contacts`, `extras`, `payment` (each a history entry; stepper from `checkout.progress`). Travellers follow `requirements` (`reference.countries.list` for nationality and issuing country); contacts pre-filled from the first adult or the account; extras with `flights.getAncillaries` and `checkout.setAncillaries` plus `checkout.setRemarks` (skipped when `features.ancillaries` is off).
  3. Payment step: methods from `config.payment.supportedMethods` (`card`; `airline_card` with `payment.airlineCard.notice`), total, terms, privacy and fare-rules links, "I accept"; `checkout.createPayment` then go to `/checkout/pay-card.html` or `/checkout/pay-airline.html` with `payment=pay_…`.
  4. States of `pages.md` §7 (`422` field errors, `412` reload and re-apply, `409 PRICE_CHANGED` on extras, `409 ANCILLARY_NOT_AVAILABLE`, `410 CHECKOUT_EXPIRED`, `422 CHECKOUT_INCOMPLETE`, `424 PAYMENT_PROVIDER_NOT_CONFIGURED`, `403 FEATURE_DISABLED`). No third-party script on this page.
- **Acceptance:**
  - Every `set*` call sends `ifMatch` with the displayed version (fake SDK assertions).
  - `fieldErrors` mark the right fields with `aria-invalid` and focus the error summary.
  - The airline-card option is shown only when `supportedMethods` includes it.
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-012 · Build the card payment page with Stripe's Payment Element
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-011
- **Size:** M
- **Read first:** ota/frontend/docs/pages.md §8; ota/frontend/README.md §10 (Stripe, script inventory); ota/docs/flows/checkout-stripe.md §2 (steps 4–5); ota/docs/adr/0015-storefront-build-urls-and-hosting.md (point 9)
- **Files:** `ota/frontend/checkout/pay-card.html`, `ota/frontend/src/pages/checkout-pay-card.js`, `ota/frontend/test/pay-card.test.js`
- **Steps:**
  1. A static `<script src="https://js.stripe.com/v3/">` tag in this HTML file only. `checkout.getPayment` and `checkout.get` give `clientSecret`, `providerPublicKey`, `accountId` and totals; mount the Payment Element with `stripeAccount` when `accountId` is set and the OTA colours in the Appearance API.
  2. "Review total": `stripe.createConfirmationToken`, then `checkout.updatePayment({ paymentId, card: { brand } })`, then `elements.fetchUpdates()`; show the final total, card fee, merchant name and statement descriptor.
  3. "Pay": `stripe.confirmPayment` with `return_url` `/checkout/complete.html?id=…&payment=…` and `redirect: "if_required"`.
  4. States of `pages.md` §8, including "Card payment is unavailable" when Stripe.js fails to load.
- **Acceptance:**
  - The built `checkout/pay-card.html` references exactly two scripts: its own bundle and Stripe.js (test on `dist/`).
  - The page never reads card data itself (no input elements outside Stripe's iframe).
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-013 · Build the complete and confirmation pages
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-012, SDK-010, OBE-042, OBE-046, OBE-047
- **Size:** M
- **Read first:** ota/frontend/docs/pages.md §10 and §11; docs/velexis-sdk/sdk/docs/B3.md §2.7 (stable idempotency key); ota/docs/flows/checkout-stripe.md §3
- **Files:** `ota/frontend/checkout/complete.html`, `ota/frontend/src/pages/checkout-complete.js`, `ota/frontend/confirmation.html`, `ota/frontend/src/pages/confirmation.js`, `ota/frontend/test/complete-page.test.js`, `ota/frontend/test/confirmation-page.test.js`
- **Steps:**
  1. Complete page (no Stripe.js): poll `checkout.getPayment` every 2 s while `processing` or `requires_action` (at most 60 s); then `checkout.complete({ checkoutId, paymentId, expectedTotal }, { idempotencyKey: "complete-<checkoutId>-<paymentId>", timeoutMs: 90000 })`; success → `location.replace("/confirmation.html?booking=…")`.
  2. States of `pages.md` §10, including `504 SUPPLIER_TIMEOUT` → confirmation page in pending mode with `details.bookingId` (never a new key).
  3. Confirmation: `bookings.get` and `bookings.getTicketingStatus({ refresh: true })` polled after `pollAfterSeconds`; states of §11 (ticketed, being issued, pending after a timeout polled every 10 s, failed, guests with lookup link and "create an account", `401` → lookup link).
- **Acceptance:**
  - Reloading the complete page replays the same idempotency key (fake SDK sees the same key twice).
  - The pending state polls until the booking is decided, then shows the final state (fake timers).
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-014 · Build the isolated airline-card payment page
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-013, OBE-051
- **Size:** M
- **Read first:** ota/docs/adr/0017-airline-card-form-isolation.md (whole); ota/frontend/docs/pages.md §9; ota/docs/flows/checkout-airline-card.md §3; deploy/caddy/Caddyfile (storefront block); deploy/caddy/test/caddy-smoke.sh
- **Files:** `ota/frontend/checkout/pay-airline.html`, `ota/frontend/src/pages/checkout-pay-airline.js`, `ota/frontend/src/lib/card-brand.js`, `ota/frontend/test/card-brand.test.js`, `ota/frontend/test/pay-airline.test.js`, `ota/frontend/vite.config.js`, `deploy/caddy/Caddyfile`, `deploy/caddy/test/caddy-smoke.sh`
- **Steps:**
  1. Own page and entry bundle importing only the SDK and the few `lib/` helpers it needs (budget 30 KB gzip); static header and footer partials; no third-party code, font or image. The page takes its state only from the URL (`checkoutId`, `paymentId`) and the API (`checkout.get`, `storefront.get` called fresh), never from `sessionStorage` or `localStorage`, which other pages of the origin can write.
  2. Inputs without `name` attributes, `autocomplete` `cc-name`, `cc-number`, `cc-exp-month`, `cc-exp-year`, `cc-csc`, `inputmode="numeric"`; form `method="post"` without `action`; `<noscript>` notice.
  3. After six digits: brand detected locally (`card-brand.js`) and `checkout.updatePayment({ paymentId, card: { brand, bin } })`. On Pay: read the inputs into one local object passed straight to `checkout.completeWithAirlineCard` with a new idempotency key per submit and 90 s; never write values to storage, cookies, the URL, `history.state`, events or the console; clear inputs on success, decline, error and `pagehide`.
  4. States of `pages.md` §9; `504` → `/confirmation.html?booking=…&pending=1`, never re-sending the card.
  5. Caddyfile: for `/checkout/pay-airline.html` and `/checkout/pay-airline`, the path-specific CSP without Stripe hosts, `Cross-Origin-Opener-Policy: same-origin` and `Cache-Control: no-store` (OADR-0017 point 3); add `worker-src 'none'` to the general storefront CSP, and make sure no other storefront path sends `Cross-Origin-Opener-Policy: same-origin`, so a window opened from any other page lands in a new browsing context group and its opener gets no handle on the card page. Mirror the headers in the `vite preview` config; extend `caddy-smoke.sh` to assert all of them.
- **Acceptance:**
  - The built page references only its own bundle; the bundle is within 30 KB gzip (budget script).
  - Unit tests prove the inputs are empty after success, decline and `pagehide`, and that no storage API is called.
  - `caddy-smoke.sh` passes with the stricter CSP, COOP `same-origin` and `no-store` on that path, the general CSP (with `worker-src 'none'`) elsewhere, and no COOP `same-origin` on any other storefront path.
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build && bash deploy/caddy/test/caddy-smoke.sh`

### OFE-015 · Build my bookings and the booking detail page
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-013, OFE-009, OBE-049, OBE-054
- **Size:** L
- **Read first:** ota/frontend/docs/pages-account.md §1–§3; ota/docs/flows/change-and-cancel.md §3; ota/docs/flows/my-bookings-and-guest-lookup.md §3 (steps 4–5, 8); docs/velexis-sdk/examples/next-storefront/app/bookings/ (reference flow)
- **Files:** `ota/frontend/bookings.html`, `ota/frontend/src/pages/bookings.js`, `ota/frontend/booking.html`, `ota/frontend/src/pages/booking.js`, `ota/frontend/src/components/booking-timeline.js`, `ota/frontend/src/components/cancel-dialog.js`, `ota/frontend/partials/templates/booking-row.html`, `ota/frontend/partials/templates/document-row.html`, `ota/frontend/test/bookings-page.test.js`, `ota/frontend/test/booking-page.test.js`
- **Steps:**
  1. `/bookings.html?tab=upcoming|past|cancelled` with `bookings.list` and "Load more" (signed-in customers; others go to sign-in or lookup).
  2. `/booking.html?id=bkg_…`: `bookings.get` (access through the session or the guest cookie), itinerary, travellers, tickets, `bookings.listDocuments` with downloads through `bookings.getDocumentDownloadUrl` (navigate to the returned same-origin URL), `bookings.listEvents` as a timeline, `bookings.getFareRules`.
  3. Actions from `allowedActions`: change contacts (`bookings.update` with `ifMatch`; `409 VERSION_CONFLICT` reload with `refresh: true`), cancel in a dialog with `bookings.quoteCancellation` (mode, estimated refund) then `bookings.cancel({ expectedRefund, reasonCode, ifMatch })` with a stable idempotency key; `request_only` shows "request sent".
  4. States of `pages-account.md` §2–§3, including `401` without a guest token → lookup link.
- **Acceptance:**
  - Buttons follow `allowedActions` exactly (table test).
  - `409 REFUND_AMOUNT_CHANGED` shows the new amount and asks again.
  - Document links are fetched on click, never pre-generated (signed URLs expire in 5 minutes).
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-016 · Build the guest lookup page
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-015, OBE-047
- **Size:** S
- **Read first:** ota/frontend/docs/pages-account.md §4; ota/docs/flows/my-bookings-and-guest-lookup.md §2
- **Files:** `ota/frontend/lookup.html`, `ota/frontend/src/pages/lookup.js`, `ota/frontend/test/lookup-page.test.js`
- **Steps:**
  1. Form with booking reference and last name; `bookings.lookup` with a new idempotency key per submit; success → `/booking.html?id=…` (the guest cookie is set by the response).
  2. One message for every mismatch ("We could not find a booking with these details"); `429` shows the wait time.
- **Acceptance:**
  - The page never reveals which of the two fields was wrong.
  - `429` disables the button until `retryAfterSeconds` has passed (fake timers).
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-017 · Write the guest Stripe checkout journey
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-013, OFE-015, OFE-008, OBE-047, OBE-055
- **Size:** M
- **Read first:** ota/frontend/README.md §13 (journey 2); ota/docs/flows/checkout-stripe.md §6; docs/mvp/local-development.md §6 (Stripe CLI); tools/e2e/README.md
- **Files:** `tools/e2e/specs/storefront/checkout-stripe.e2e.ts`, `tools/e2e/playwright.config.ts`, `tools/e2e/support/stack.ts`, `tools/e2e/support/stripe.ts`, `.github/workflows/e2e.yml`
- **Steps:**
  1. Add the nightly-only Playwright project `storefront-stripe` (needs `STRIPE_SECRET_KEY_TEST`, `STRIPE_PUBLISHABLE_KEY_TEST` and a Stripe CLI forwarder to `/webhooks/stripe/velexis/test`, started by `support/stripe.ts`).
  2. Journey: search → offer → price → guest checkout (travellers, contacts, one bag) → card page with the 3-D Secure test card `4000 0027 6000 3184` → challenge → complete → confirmation shows the reference → the confirmation e-mail with the itinerary arrives in Mailpit → the booking page opens through the guest cookie.
  3. A second test: Amadeus `sold-out` scenario at completion shows "you have not been charged" and the PaymentIntent is cancelled.
- **Acceptance:**
  - The journey passes nightly with the storefront guards of OFE-008 active [OF-04 AC1].
  - The sold-out test ends with the authorisation voided [OF-04 AC2].
- **Verify:** `E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront-stripe specs/storefront/checkout-stripe.e2e.ts`

### OFE-018 · Write the airline-card journey with leak checks
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-014, OFE-017
- **Size:** M
- **Read first:** ota/docs/adr/0017-airline-card-form-isolation.md (point 8); ota/frontend/README.md §13 (journey 3); ota/docs/flows/checkout-airline-card.md §4 and §7
- **Files:** `tools/e2e/specs/storefront/checkout-airline-card.e2e.ts`, `tools/e2e/support/card-leak-guards.ts`
- **Steps:**
  1. Stack with `AIRLINE_CARD_ENABLED=true` and the tenant's test switch on (seed). Journey: price → checkout → airline card → notice and the airline's price → test PAN `4111 1111 1111 1111` → confirmation with tickets.
  2. Decline with `4000 0000 0000 0002` three times: declined, then "Too many attempts". A `timeout` scenario goes to the pending confirmation without resubmitting.
  3. `card-leak-guards.ts`: after each path, the PAN, its last 12 digits and the CVV are absent from `localStorage`, `sessionStorage`, IndexedDB, cookies, the URL and `history.state`; the inputs are empty after leaving the page; the page made no third-party request; a script on `/checkout/pay-card.html` that opens the card page with `window.open` gets no access to its document (the handle reports `closed`), because of COOP `same-origin` (OADR-0017 point 3).
- **Acceptance:**
  - Success, decline, attempt limit and timeout pass with every leak guard green [OF-05 AC1, AC2].
- **Verify:** `E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/checkout-airline-card.e2e.ts`

### OFE-019 · Write the account, bookings and keyboard-only journeys
- **Component:** ota-frontend
- **Milestone:** M3
- **Depends on:** OFE-016, OFE-010, OFE-014, OFE-017
- **Size:** M
- **Read first:** ota/frontend/README.md §8 and §13 (journeys 4, 5); ota/docs/flows/my-bookings-and-guest-lookup.md §7; ota/docs/flows/change-and-cancel.md §7
- **Files:** `tools/e2e/specs/storefront/account-bookings.e2e.ts`, `tools/e2e/specs/storefront/keyboard-checkout.e2e.ts`, `tools/e2e/support/ota.ts`
- **Steps:**
  1. Account journey: sign up → verify through the Mailpit link → sign in → the three bookings tabs (bookings seeded through the API with the airline-card path so no Stripe is needed) → change contacts → cancel with the refund preview → cancelled tab; guest lookup with a wrong name then the right one; the access cookie expires (clock in the backend's test mode or a short TTL) and the next call refreshes silently.
  2. Keyboard-only journey through search, filters, fare choice, checkout and the airline-card form, with focus visible and the error summary focused on a validation error.
- **Acceptance:**
  - Both journeys pass with axe and the storefront guards active [OF-07 AC1, AC2; OF-08 AC1, AC2].
  - `document.cookie` holds only `__Host-vx_csrf` throughout [OF-03 AC1].
- **Verify:** `E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/account-bookings.e2e.ts specs/storefront/keyboard-checkout.e2e.ts`

## M4 — OTA admin

The console API (staff sign-in by portal token, bookings, PNR import, queues, customers, supplier log, raw Amadeus reads, payments, settings), the `console` SDK namespace, the OTA admin app and the storefront content pages. Platform task PFE-019 is gated on OF-09 (OBE-059, OAD-003, OAD-016).

### OBE-058 · Spec-first: console permissions and settings operations ✅
- **Status:** done (branch claude/intelligent-bardeen-90hhu7)
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-029
- **Size:** L
- **Read first:** ota/docs/api-changes-console-and-internal.md §1, §2.1–§2.3, §2.6, §6; ota/docs/api-changes.md §5 and §6 (`ENVIRONMENT_NOT_ALLOWED`, `TEMPLATE_INVALID`); ota/docs/adr/0015-storefront-build-urls-and-hosting.md (Follow-ups: font enum); ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md (Follow-ups: `consoleCardPayment`); ota/docs/scope.md §1.3
- **Files:** `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, `ota/backend/openapi/README.md`, `packages/api-types/src/generated/ota.ts`, `packages/api-types/src/generated/operations.ts`, `packages/errors/src/generated/catalogue.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/contract/console-settings.contract.test.ts`, `ota/sdk/src/internal/operations.js`, `ota/sdk/docs/extensions.md`
- **Steps:**
  1. `StaffPermission` gains `settings:read`, `settings:write`, `payments:read`, `payments:capture`, `payments:refund` (description with the role matrix of scope §1.3); add `x-permission` to every existing console operation and to the new ones of this task. OBE-090 and OBE-091 add the remaining console operations with their own `x-permission`.
  2. Add the 17 settings operations of §2.1–§2.3 and §2.6 (markup rules, fee rules, storefront settings, templates) with their schemas (`MarkupRule`, `MarkupRuleInput`, `FeeRule`, `PricingRuleScope`, `StorefrontSettings` with `branding.fonts` as an enum of the bundled font names, `NotificationTemplate`). Every new operation has `x-milestone: M4`.
  3. Add `ENVIRONMENT_NOT_ALLOWED` (403) and `TEMPLATE_INVALID` (422); state in `consolePatchBooking` and `consoleIssueBooking` that `creditCard` in `formOfPayments` answers `403 FEATURE_DISABLED` (`details.feature = "consoleCardPayment"`).
  4. Lint, regenerate the contract packages and the SDK route table (`pnpm --filter @velexis/ota-sdk generate`; `console` is still a pending namespace), add the new operations to `pending-operations.ts` with their implementing task ids (OBE-069, OBE-070, OBE-073), align the settings rows of `ota/sdk/docs/extensions.md` §3.2. `console-settings.contract.test.ts` asserts the 17 operationIds with their milestone and permission, and that every console operation in the document has `x-permission`.
- **Acceptance:**
  - `pnpm contracts:lint` is clean; the 17 operations match api-changes part 2 §2.1–§2.3 and §2.6.
  - The font enum equals the list of fonts the storefront bundles (a contract test compares it with `ota/frontend/src/styles/fonts.css` once OFE-020 exists; until then with a constant in the test).
  - The route parity test passes with the new pending entries; `pnpm --filter @velexis/ota-sdk generate` leaves no diff and the SDK tests pass.
- **Verify:** `pnpm contracts:lint && pnpm contracts:generate && pnpm --filter @velexis/ota-backend test -- contract && pnpm --filter @velexis/ota-sdk generate && git diff --exit-code ota/sdk/src/internal/operations.js && pnpm --filter @velexis/ota-sdk test`

### OBE-090 · Spec-first: console payments and the internal health and Stripe webhook endpoints
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-058
- **Size:** S
- **Read first:** ota/docs/api-changes-console-and-internal.md §3, §5, §6; ota/sdk/docs/extensions.md §3.3; ota/docs/adr/0010-stripe-gateway-and-payment-webhooks.md (point 4); ota/docs/adr/0011-console-access-staff-sessions-and-environments.md (point 6)
- **Files:** `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, `ota/backend/openapi/README.md`, `packages/api-types/src/generated/ota.ts`, `packages/api-types/src/generated/operations.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/contract/console-payments.contract.test.ts`, `ota/sdk/src/internal/operations.js`, `ota/sdk/docs/extensions.md`
- **Steps:**
  1. Add the 4 console payment operations of §3 (`ConsolePayment`) with `x-permission` `payments:read`, `payments:capture` or `payments:refund` and `x-milestone: M4`.
  2. Document under the `Internal` tag (`x-internal: true`): `healthLive` and `healthReady` (`x-milestone: M0`, already served by OBE-001 and OBE-025), and the two M5 webhooks `receiveStripeConnectWebhook` and `receiveStripeConnectionWebhook` (`x-milestone: M5`, with the per-endpoint tenant rules of OADR-0010 point 4 in their descriptions). The webhooks are documented here, ahead of their handler, so the M4 document is complete (135 operations); OBE-076 only adds the billing notice.
  3. Lint, regenerate the contract packages and the SDK route table, add the payment operations (task OBE-068) and the two webhooks (task OBE-078) to `pending-operations.ts`, align `extensions.md` §3.3. `console-payments.contract.test.ts` asserts the 8 operationIds and their extensions.
- **Acceptance:**
  - `pnpm contracts:lint` is clean; the route parity test passes with the new pending entries and without pending entries for the two health routes.
  - `pnpm --filter @velexis/ota-sdk generate` leaves no diff and the SDK tests pass.
- **Verify:** `pnpm contracts:lint && pnpm contracts:generate && pnpm --filter @velexis/ota-backend test -- contract && pnpm --filter @velexis/ota-sdk generate && git diff --exit-code ota/sdk/src/internal/operations.js && pnpm --filter @velexis/ota-sdk test`

### OBE-091 · Spec-first: content pages, storefront assets and their public endpoints
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-058
- **Size:** S
- **Read first:** ota/docs/api-changes-console-and-internal.md §2.4, §2.5, §4, §6; ota/docs/api-changes.md §6 (`ASSET_INVALID`); ota/docs/adr/0012-storefront-settings-assets-and-pages.md (points 2, 3, 5); ota/sdk/docs/extensions.md §3.1–§3.2; this plan's SDK-006 (pending list format)
- **Files:** `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, `ota/backend/openapi/README.md`, `packages/api-types/src/generated/ota.ts`, `packages/api-types/src/generated/operations.ts`, `packages/errors/src/generated/catalogue.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/contract/storefront-content.contract.test.ts`, `ota/sdk/src/internal/operations.js`, `ota/sdk/test/contract/pending-namespaces.js`, `ota/sdk/docs/extensions.md`
- **Steps:**
  1. Add the 8 console page and asset operations of §2.4–§2.5 (`StorefrontPage`, `StorefrontAsset` with multipart upload) with `x-permission` `settings:read` or `settings:write`, the public `listStorefrontPages` and `getStorefrontPage` (§4.1, page `blocks`, `x-sdk-method` `storefront.listPages` and `storefront.getPage`) and `getPublicAsset` (§4.2, `x-sdk-exclude`). Every new operation has `x-milestone: M4`. Add `ASSET_INVALID` (422).
  2. Lint, regenerate the contract packages and the SDK route table, add the new operations to `pending-operations.ts` (tasks OBE-071 and OBE-072), align `extensions.md` §3.1 and the pages and assets rows of §3.2. `storefront-content.contract.test.ts` asserts the 11 operationIds and their extensions.
  3. SDK parity: the `storefront` namespace is implemented since SDK-005 and no longer pending, so add `storefront.listPages` and `storefront.getPage` to `pending-namespaces.js` as method entries with task SDK-012, which removes them.
- **Acceptance:**
  - `pnpm contracts:lint` is clean; the route parity test passes with the new pending entries.
  - The SDK parity test passes on this PR (two pending method entries); `pnpm --filter @velexis/ota-sdk generate` leaves no diff.
- **Verify:** `pnpm contracts:lint && pnpm contracts:generate && pnpm --filter @velexis/ota-backend test -- contract && pnpm --filter @velexis/ota-sdk generate && git diff --exit-code ota/sdk/src/internal/operations.js && pnpm --filter @velexis/ota-sdk test`

### OBE-059 · Implement staff sign-in by portal token and staff sessions in Redis
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-031, OBE-058
- **Size:** L
- **Read first:** ota/docs/adr/0011-console-access-staff-sessions-and-environments.md (points 1–3); platform/docs/adr/0007-portal-to-ota-admin-sso-token.md; ota/docs/flows/console-operations.md §1, §3 (step 1), §4, §6; platform/docs/architecture.md §6.4; docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: consoleSignIn`, `consoleRefreshSession`, `consoleSignOut`, `consoleGetMe`)
- **Files:** `ota/backend/src/identity/staff/staff-auth.controller.ts`, `ota/backend/src/identity/staff/staff-auth.service.ts`, `ota/backend/src/identity/staff/staff-auth.service.test.ts`, `ota/backend/src/identity/staff/staff-sessions.ts`, `ota/backend/src/common/auth/staff.guard.ts`, `ota/backend/src/common/auth/staff.guard.test.ts`, `ota/backend/src/tenancy/platform-read.repository.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/console/staff-auth.int.test.ts`
- **Steps:**
  1. `console.auth.signIn` with `grantType: portal_token`: `GETDEL ptk:<sha256(token)>`; check the membership (active, role), account (active) and tenant (active) from the platform tables; `password` grant → `403 FEATURE_DISABLED` (`details.feature = "passwordGrant"`); unknown or used token → `401 PORTAL_TOKEN_INVALID`; rate limit 10 per minute per IP.
  2. Staff access JWT (15 minutes; `typ: staff`, `sub: stf_…`, `tid`, `roles`, `sid`) and a rotating refresh token in `staffsess:<familyId>` (absolute 12 h); reuse revokes the family.
  3. `StaffGuard` and refresh check: family exists and not in `staffdeny:<familyId>`; family created after `staffdeny:acct:<accountId>` and `staffdeny:tenant:<tenantId>`; cached membership active with the token's role; `tid` equals the tenant.
  4. `console.auth.refresh`, `console.auth.signOut`, `console.auth.me` (staff, tenant, permissions from the role matrix, `environments`: `["test"]`, or `["test", "live"]` for a live tenant and a non-viewer role). Write `staff_actions` `staff.sign_in` (OBE-060 provides the writer; until then a minimal insert). Remove the four operations from `pending-operations.ts`.
- **Acceptance:**
  - A portal token works once; the second use and a token for another tenant answer 401.
  - A `staffdeny:acct` cut-off newer than the family makes the next request and refresh fail; a membership invalidation for a removed member takes effect within one second.
  - `console.auth.me` returns the permissions of scope §1.3 for each of the five roles.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- identity && pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-060 · Enforce service-key rules, environments, permissions and staff_actions
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-059
- **Size:** M
- **Read first:** ota/docs/adr/0011-console-access-staff-sessions-and-environments.md (points 4–6, 8, 9); ota/docs/adr/0009-caller-and-tenant-resolution.md (point 1.2); platform/docs/architecture.md §3.2 (the same end-user forwarding on the platform side); deploy/caddy/Caddyfile (`api_common`, storefront `/api/*`); ota/docs/api-changes.md §5; docs/velexis-sdk/db/README.md §8 (`staff_actions`); ota/docs/scope.md §1.2 (automation keys)
- **Files:** `ota/backend/src/common/auth/caller.guard.ts`, `ota/backend/src/common/auth/scope.guard.ts`, `ota/backend/src/common/auth/permission.guard.ts`, `ota/backend/src/common/auth/permission.guard.test.ts`, `ota/backend/src/console/console.module.ts`, `ota/backend/src/console/staff-actions.writer.ts`, `ota/backend/src/console/staff-actions.writer.test.ts`, `ota/backend/src/common/auth/roles.ts`, `ota/backend/src/config.ts`, `ota/backend/test/integration/console/console-access.int.test.ts`
- **Steps:**
  1. `CallerGuard` gains the service branch before keys: `X-Api-Key` equal to `OTA_ADMIN_SERVICE_KEY` (constant time), socket peer (`req.socket.remoteAddress`, never `req.ip`) on loopback, **and no `X-Forwarded-For` or `X-Forwarded-Host` header** → `service`. Caddy sets both on every proxied request (`api.ota.example.com` and the storefront `/api/*`), so a request that came through Caddy is never a service request, whatever key it carries (OADR-0009 rule 1.2, the same test as the platform's `InternalOnlyGuard`); it falls through to the key rules and gets `401 INVALID_API_KEY`, logged as a security event without the value. The service caller is accepted only on console operations and only with a staff token of the tenant (except `consoleSignIn`); `X-Velexis-Environment` required (400 without), `live` only for a live tenant and a non-viewer role (`403 ENVIRONMENT_NOT_ALLOWED`).
  2. `roles.ts` holds the role → permission matrix of scope §1.3; `PermissionGuard` reads `x-permission` from the operations index and answers `403 FORBIDDEN` with `details.requiredPermission`. `sk_` keys scoped `console` need a staff token; `console:automation` keys use their own permissions with `X-Velexis-Scope: console`, audited as the key.
  3. `staff-actions.writer.ts`: one row per console call (also denied ones with `outcome = denied`): actor, role, action, target, reason, redacted before/after, request id, IP, user agent; written in the use case's transaction or, for reads and denials, in its own short transaction.
  4. End-user context for the service caller: honour `X-Velexis-End-User-IP` (required, valid IPv4 or IPv6, else `400 VALIDATION_FAILED`) and `X-Velexis-End-User-Agent` (cut to 512 characters) only when the caller is `service`; they become the request-context IP and user agent used by the throttler (`console.auth.signIn` 10 per minute per end-user IP), the staff sign-in lockout and `staff_actions`. For every other caller the headers follow the contract (secret keys) or are ignored.
  5. Rate limit: 600 per minute per staff session or key.
- **Acceptance:**
  - The service key with an `X-Forwarded-For` header (as Caddy sends it), from a non-loopback address, on a customer operation, or without a staff token is refused.
  - Eleven `console.auth.signIn` attempts in a minute from one end-user IP through the service caller get `429` on the eleventh, while a different end-user IP is still served; `staff_actions` rows carry the forwarded IP and user agent, not `127.0.0.1`.
  - A viewer asking for `live` gets `403 ENVIRONMENT_NOT_ALLOWED`; an agent calling a settings write gets `403 FORBIDDEN` with the permission in `details`, and a `denied` row is written.
  - `staff_actions` rows contain no token and no full document number (redaction test).
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-061 · Implement console bookings list and get
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-060, OBE-046
- **Size:** M
- **Read first:** ota/docs/flows/console-operations.md §2 (Bookings list and detail), §3 (step 3); docs/velexis-sdk/db/README.md §10 (console filters); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: consoleListBookings`, `consoleGetBooking`); docs/velexis-sdk/sdk/docs/B4.md
- **Files:** `ota/backend/src/console/console-bookings.controller.ts`, `ota/backend/src/console/console-bookings.service.ts`, `ota/backend/src/console/console-bookings.repository.ts`, `ota/backend/src/console/console-bookings.mapper.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/console/bookings-read.int.test.ts`
- **Steps:**
  1. `console.bookings.list` (`bookings:read`): filters of db README §10 plus the needs-attention filters (`ticketingStatus in (failed, manual_review)`, `reconcileOutcome = manual_review`, deadline within 24 h, cancellation requested, schedule changed), sort, cursor, `totalCount`; selected environment only.
  2. `console.bookings.get`: the console view with net amounts, markup lines, payments, events including staff notes and `recentStaffActions`; `refresh=true` triggers a Management GET; documents decrypted only for display and never logged.
  3. Remove both operations from `pending-operations.ts`.
- **Acceptance:**
  - Each needs-attention filter returns exactly the seeded bookings it should.
  - Test-environment staff never see live bookings; customer-scope fields such as net amounts appear only here.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-062 · Implement console retrieve, patch, resync and notes
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-061
- **Size:** M
- **Read first:** ota/docs/flows/console-operations.md §2 (Amadeus order view, Patch, Resync, notes); ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md (point 8, Follow-ups); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: consoleRetrieveFlightOrder`, `consolePatchBooking`, `consoleResyncBooking`, `consoleAddBookingNote`)
- **Files:** `ota/backend/src/console/console-bookings.controller.ts`, `ota/backend/src/console/console-booking-actions.service.ts`, `ota/backend/src/console/console-booking-actions.service.test.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/console/bookings-actions.int.test.ts`
- **Steps:**
  1. `console.bookings.retrieve` (`bookings:read`): Management GET, net prices, staff-visible order view; writes `staff_actions` `booking.retrieve`.
  2. `console.bookings.patch` (`bookings:write`, `If-Match`): travellers, contacts, remarks, ticketing agreement through Management PATCH; `creditCard` in `formOfPayments` → `403 FEATURE_DISABLED` (`consoleCardPayment`); 2552 → `409 VERSION_CONFLICT`; timeout → resync then 504.
  3. `console.bookings.resync` (`bookings:write`) reuses the sync service (OBE-045); `console.bookings.addNote` stores a staff-only `booking_events` note.
  4. Remove the four operations from `pending-operations.ts`.
- **Acceptance:**
  - Patch with a stale version answers 412; with `creditCard` answers 403 and makes no Amadeus call.
  - Notes appear in the console booking but never in `bookings.listEvents` for customers.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- console && pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-063 · Implement console issue and cancel with payments
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-062, OBE-044, OBE-049
- **Size:** L
- **Read first:** ota/docs/flows/console-operations.md §1 and §2 (Issue, Cancel); ota/docs/adr/0008-ticketing-policy.md (point 1, `manual_review`); ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md (point 8); ota/docs/flows/change-and-cancel.md §3 (step 6); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: consoleIssueBooking`, `consoleCancelBooking`)
- **Files:** `ota/backend/src/console/console-booking-actions.service.ts`, `ota/backend/src/console/console-bookings.controller.ts`, `ota/backend/src/bookings/ticketing.service.ts`, `ota/backend/src/bookings/cancellation.service.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/console/issue-cancel.int.test.ts`
- **Steps:**
  1. `console.bookings.issue` (`bookings:issue`, `If-Match`, `Idempotency-Key`): claim the booking (refuse a fresh ticketing claim), capture an authorised Stripe payment first (`capturePayment` default true), then Flight Order Issue with resync on timeout; `allowUnpaid` only for owner and admin; airline-card bookings in manual review are issued only with an `other` form of payment (`CASH` or `ACCOUNT`), `creditCard` refused.
  2. `console.bookings.cancel` (`bookings:cancel`): Management DELETE, refund modes `none`, `full`, `amount` through the money step of OBE-049; airline-card payments never refunded through Stripe.
  3. Both write `booking_events` and `staff_actions` with redacted before and after. Remove both operations from `pending-operations.ts`.
- **Acceptance:**
  - Issue of a `manual_review` Stripe booking captures then issues, once, even with a double submit on the same key.
  - An agent cannot use `allowUnpaid`; an owner can.
  - Cancel with `refund.mode = amount` creates one refund row and one Stripe refund.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-064 · Implement PNR lookup and import
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-061
- **Size:** M
- **Read first:** ota/docs/flows/console-operations.md §3 (step 4), §4; ota/docs/adr/0005-markup-and-fee-engine.md (point 10); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: consoleFindBookingByRecordLocator`, `consoleImportBooking`)
- **Files:** `ota/backend/src/console/pnr-import.service.ts`, `ota/backend/src/console/pnr-import.service.test.ts`, `ota/backend/src/console/console-bookings.controller.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/console/pnr-import.int.test.ts`
- **Steps:**
  1. `console.bookings.findByRecordLocator` (`bookings:read`): local unique index first, then Get Flight Order By Record Locator with the tenant's office; owner or queuing office must be one of the tenant's (`403 OFFICE_NOT_ALLOWED`).
  2. `console.bookings.import` (`bookings:write`, `Idempotency-Key`): create a booking with `channel = import`, `pricing_mode` chosen by staff (`markup_rules`, `net`, `override`), no payment (`not_applicable`), children from the order, events; `409 ORDER_ALREADY_IMPORTED` for a known order.
  3. Remove both operations from `pending-operations.ts`.
- **Acceptance:**
  - Two tenants on the shared account: tenant B cannot find or import tenant A's PNR [OF-09 AC3].
  - Importing the same order twice answers 409 the second time.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- console && pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-065 · Implement queues, snapshots and the queue poller
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-060, OBE-041
- **Size:** M
- **Read first:** ota/docs/flows/console-operations.md §2 (Queues); ota/docs/architecture.md §6 (`queues.poll`); ota/docs/adr/0003-booking-orchestration-and-supplier-timeout-recovery.md (Follow-ups: booking queue view); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: consoleListQueue`, `consoleListQueueSnapshots`)
- **Files:** `ota/backend/src/console/queues.controller.ts`, `ota/backend/src/console/queues.service.ts`, `ota/backend/src/console/queue-poller.processor.ts`, `ota/backend/src/console/queue-snapshots.repository.ts`, `ota/backend/src/jobs/schedulers.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/console/queues.int.test.ts`
- **Steps:**
  1. `console.queues.list` (`queues:read`): Queue List for a queue of the tenant's office; other offices → `403 OFFICE_NOT_ALLOWED`; each item is marked as linked to a local booking (by record locator) or orphan, which gives staff the booking-queue view of OADR-0003.
  2. `console.queues.listSnapshots` reads `queue_snapshots`.
  3. `queues.poll` (15 minutes) for the monitored queues of `supplier_connections` of active tenants (suspended tenants skipped); one snapshot row per poll.
  4. Remove both operations from `pending-operations.ts`.
- **Acceptance:**
  - The poller stores a snapshot per monitored queue and skips suspended tenants.
  - An order on the booking queue without a local booking is shown as orphan.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-066 · Implement console customers and the supplier log
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-060
- **Size:** M
- **Read first:** ota/docs/flows/console-operations.md §2 (Customers, Supplier log), §3 (step 7); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: consoleListCustomers`, `consoleGetCustomer`, `consoleListSupplierRequests`)
- **Files:** `ota/backend/src/console/customers.controller.ts`, `ota/backend/src/console/customers.service.ts`, `ota/backend/src/console/customers.repository.ts`, `ota/backend/src/console/supplier-log.controller.ts`, `ota/backend/src/console/supplier-log.repository.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/console/customers-supplier-log.int.test.ts`
- **Steps:**
  1. `console.customers.list` (`customers:read`): search by e-mail and name prefixes, cursor; `console.customers.get` with booking statistics; reading a customer writes `staff_actions` `customer.get`.
  2. `console.supplierRequests.list` (`supplier_requests:read`): filters (operation, outcome, booking, time), redacted bodies as stored.
  3. Remove the three operations from `pending-operations.ts`.
- **Acceptance:**
  - Deleted customers are shown as deleted without personal data beyond what the contract allows.
  - The supplier log never shows a full card number or document number (seeded redacted rows checked).
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-067 · Implement the read-only raw Amadeus console operations
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-060
- **Size:** M
- **Read first:** ota/docs/adr/0011-console-access-staff-sessions-and-environments.md (point 7); ota/docs/scope.md §3.4 (`console.amadeus.*`); ota/docs/flows/console-operations.md §2 (Raw Amadeus); docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml (grep `operationId: consoleAmadeus`)
- **Files:** `ota/backend/src/console/raw-amadeus.controller.ts`, `ota/backend/src/console/raw-amadeus.service.ts`, `ota/backend/src/console/raw-amadeus.service.test.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/console/raw-amadeus.int.test.ts`
- **Steps:**
  1. Implement the eight reads with `amadeus:read`: `console.amadeus.searchFlightOffers`, `.getFlightOffers`, `.searchFlightAvailabilities`, `.upsellAirOffers`, `.quoteAirOffers`, `.getFlightOrder`, `.getFlightOrderByReference`, `.getQueue`. Bodies pass through to the Amadeus client unchanged except offices, which come from the tenant's connection; a caller-provided office outside the list → `403 OFFICE_NOT_ALLOWED`.
  2. Net prices are returned (console scope); every call writes `supplier_requests` and `staff_actions`.
  3. The four writes stay `deferred` in `pending-operations.ts` (501); remove the eight reads.
- **Acceptance:**
  - Each read reaches the stub with the tenant's offices; another tenant's office is refused before any call [OF-09 AC3].
  - `console.amadeus.createFlightOrders` answers 501 `NOT_IMPLEMENTED`.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-068 · Implement console payments list, get, capture and refund
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-060, OBE-040, OBE-090
- **Size:** M
- **Read first:** ota/docs/api-changes-console-and-internal.md §3; ota/docs/flows/console-operations.md §3 (step 5); ota/docs/adr/0010-stripe-gateway-and-payment-webhooks.md (point 3)
- **Files:** `ota/backend/src/console/console-payments.controller.ts`, `ota/backend/src/console/console-payments.service.ts`, `ota/backend/src/console/console-payments.service.test.ts`, `ota/backend/src/payments/payments.repository.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/console/payments.int.test.ts`
- **Steps:**
  1. `console.payments.list` (filters `status`, `provider`, `method`, `bookingId`, `createdFrom`, `createdTo`; sort `-createdAt`; selected environment) and `console.payments.get` (`ConsolePayment` with redacted events, refunds, booking summary, `providerConnection.accountMode`; `refresh=true` re-reads the PaymentIntent) with `payments:read`.
  2. `console.payments.capture {amount?, reason}` (`payments:capture`, `If-Match`, `Idempotency-Key`): Stripe `authorized` only; partial capture releases the rest; expired authorisation → `402 PAYMENT_DECLINED`.
  3. `console.payments.refund {amount, reason, reasonNote?}` (`payments:refund`): Stripe `captured` or `partially_refunded`; `amount ≤ captured − refunded` (`422 UNPROCESSABLE`, `amount_exceeds_captured`); airline-card payments → `422` with `refund_via_airline`; a `refunds` row then `refund.submit`. Booking payments also write `booking_events`.
  4. Remove the four operations from `pending-operations.ts`.
- **Acceptance:**
  - A finance user can refund, an agent gets 403; a refund above the captured amount answers 422.
  - Capturing twice with the same key captures once.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- console && pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-069 · Implement markup and fee rule settings
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-060, OBE-020
- **Size:** M
- **Read first:** ota/docs/api-changes-console-and-internal.md §2.1 and §2.2; ota/docs/adr/0005-markup-and-fee-engine.md (points 3, 6, 8); ota/docs/scope.md §4 (OF-10)
- **Files:** `ota/backend/src/settings/settings.module.ts`, `ota/backend/src/settings/markup-rules.controller.ts`, `ota/backend/src/settings/fee-rules.controller.ts`, `ota/backend/src/settings/pricing-rules.service.ts`, `ota/backend/src/settings/pricing-rules.service.test.ts`, `ota/backend/src/settings/pricing-rules.mapper.ts`, `ota/backend/src/pricing/rules.repository.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/settings/pricing-rules.int.test.ts`
- **Steps:**
  1. The ten operations `console.settings.markupRules.*` and `console.settings.feeRules.*` (`settings:read` / `settings:write`), list ordered by `priority, id` with `?active`, `If-Match` and `ETag` on updates.
  2. Rules: the default rule cannot be deleted or narrowed (`409 CONFLICT`, `default_rule`); deleting keeps history (`markup_rule_id` set NULL on old rows, amounts kept); `change` fees stored but unused; warnings for fixed amounts in a currency other than the default and for rules selling below net.
  3. Changes apply to the next search; stored offers keep their prices. Each change writes `staff_actions` with before and after.
  4. Remove the ten operations from `pending-operations.ts`.
- **Acceptance:**
  - A markup change applies to the next search, not to an existing search's offers [OF-10 AC1].
  - Deleting the default rule answers 409; a viewer can list but not create.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- settings && pnpm --filter @velexis/ota-backend test:int -- settings`

### OBE-070 · Implement storefront settings get and update
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-060, OBE-016
- **Size:** M
- **Read first:** ota/docs/api-changes-console-and-internal.md §2.3; ota/docs/adr/0012-storefront-settings-assets-and-pages.md (points 1, 4, 6, 7); ota/docs/adr/0008-ticketing-policy.md (point 2); ota/docs/adr/0004-airline-card-data-handling.md (point 1)
- **Files:** `ota/backend/src/settings/storefront-settings.controller.ts`, `ota/backend/src/settings/storefront-settings.service.ts`, `ota/backend/src/settings/storefront-settings.service.test.ts`, `ota/backend/src/settings/storefront-settings.mapper.ts`, `ota/backend/src/storefront/storefront.repository.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/settings/storefront-settings.int.test.ts`
- **Steps:**
  1. `console.settings.storefront.get` and `.update` (`If-Match`): map every section of `StorefrontSettings` to the settings row and its `0002` columns.
  2. Validation: currencies against `reference.currencies`, supported lists contain the default, fonts from the enum, asset ids of the right kind, `paymentTiming` only `authorize_before_booking` (`422`), TTL ranges; `airlineCard.enabledLive = true` → `403 FEATURE_DISABLED` while `AIRLINE_CARD_ENABLED` is off; enabling the airline card with active markup or fee rules returns a `warnings[]` entry.
  3. Effect: `version + 1`, delete the `storefront.get` and page caches of both environments, `staff_actions` with redacted before and after.
  4. Remove both operations from `pending-operations.ts`.
- **Acceptance:**
  - A branding change is returned by the next uncached `storefront.get`, so the storefront shows it within 5 minutes [OF-10 AC2].
  - `paymentTiming: pay_later` answers 422; `enabledLive: true` with the switch off answers 403.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- settings && pnpm --filter @velexis/ota-backend test:int -- settings`

### OBE-071 · Implement asset upload, list, delete and public download
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-070, OBE-091
- **Size:** M
- **Read first:** ota/docs/api-changes-console-and-internal.md §2.5 and §4.2; ota/docs/adr/0012-storefront-settings-assets-and-pages.md (points 2, 3); docs/mvp/adr/0018-hosted-storefront-custom-domains.md (CSP)
- **Files:** `ota/backend/src/settings/assets.controller.ts`, `ota/backend/src/settings/assets.service.ts`, `ota/backend/src/settings/image-sniffer.ts`, `ota/backend/src/settings/image-sniffer.test.ts`, `ota/backend/src/storefront/public-assets.controller.ts`, `ota/backend/src/storefront/storefront.mapper.ts`, `ota/backend/src/main.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/settings/assets.int.test.ts`
- **Steps:**
  1. `console.settings.assets.upload` (multipart `file`, `kind`; `Idempotency-Key`; multipart parsing only on this route): sniff PNG, JPEG, WebP (ICO for favicons) from magic bytes, read dimensions from the header, ≤ 1 MB, logos ≤ 2000 × 2000, no SVG or CSS (`422 ASSET_INVALID` with `details.reason`); store `tenant_<key>/assets/<sha256>.<ext>` and an immutable `storefront_assets` row.
  2. `console.settings.assets.list` and `.delete` (`409 CONFLICT` when settings or a page reference the asset).
  3. `GET /v1/assets/{tenantKey}/{assetId}.{ext}` (`getPublicAsset`, no auth): served for active and suspended tenants with `Cache-Control: public, max-age=31536000, immutable`, `nosniff`, `Content-Security-Policy: default-src 'none'`, 120 per minute per IP. `storefront.get` now returns same-origin `/api/v1/assets/…` paths to the edge and absolute `PUBLIC_OTA_API_URL` URLs to key callers.
  4. Remove the four operations from `pending-operations.ts`.
- **Acceptance:**
  - An SVG renamed to `.png` is refused by the sniffer; a 1.2 MB PNG answers 422 `size`.
  - The public asset carries the three headers; an unknown asset answers 404.
  - Deleting a logo in use answers 409.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- settings && pnpm --filter @velexis/ota-backend test:int -- settings`

### OBE-072 · Implement content pages with the Markdown-subset parser and the public page endpoints
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-071
- **Size:** L
- **Read first:** ota/docs/api-changes-console-and-internal.md §2.4 and §4.1; ota/docs/adr/0012-storefront-settings-assets-and-pages.md (points 5–7); ota/docs/data-model-migration-0002.md (grep `CREATE TABLE storefront_pages`)
- **Files:** `ota/backend/src/settings/pages.controller.ts`, `ota/backend/src/settings/pages.service.ts`, `ota/backend/src/storefront/markdown-subset.parser.ts`, `ota/backend/src/storefront/markdown-subset.parser.test.ts`, `ota/backend/src/storefront/markdown-subset.fuzz.test.ts`, `ota/backend/src/storefront/public-pages.controller.ts`, `ota/backend/src/storefront/public-pages.service.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/settings/pages.int.test.ts`
- **Steps:**
  1. `markdown-subset.parser.ts` (no library that emits HTML): headings 2–4, paragraphs, bold, italic, bullet and numbered lists, links (`https:`, `mailto:`, `tel:`, relative `/p/<slug>`), images referencing `page_image` assets → a block tree (`heading`, `paragraph`, `list`, `image` with inline `text`, `strong`, `em`, `link`); anything else → `422 UNPROCESSABLE` with `details.line`.
  2. The five `console.settings.pages.*` operations (`settings:read` / `settings:write`): one page per `(slug, locale)` (`409`), published pages need `published_at`, a page referenced by `legal.links` cannot be deleted (`409`), body ≤ 50 000 characters.
  3. Public `storefront.listPages` and `storefront.getPage` (edge and keys): published pages of the request locale with fallback to the default, cached 5 minutes per tenant, environment and locale, deleted on page changes.
  4. Remove the seven operations from `pending-operations.ts`.
- **Acceptance:**
  - `<script>`, raw HTML, tables and `javascript:` links are refused with the line number; a fuzz test of 1 000 random inputs never throws an unhandled error.
  - A published page appears in `storefront.listPages` within the cache window; an unpublished one answers 404.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- storefront && pnpm --filter @velexis/ota-backend test:int -- settings`

### OBE-073 · Implement notification template settings with preview and reset
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-060, OBE-055
- **Size:** M
- **Read first:** ota/docs/api-changes-console-and-internal.md §2.6; ota/docs/adr/0013-notifications-and-booking-documents.md (point 3)
- **Files:** `ota/backend/src/settings/templates.controller.ts`, `ota/backend/src/settings/templates.service.ts`, `ota/backend/src/settings/templates.service.test.ts`, `ota/backend/src/notifications/template.service.ts`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/settings/templates.int.test.ts`
- **Steps:**
  1. `console.settings.templates.list` shows the effective template for every known key (`customised: false` for code defaults) with its variable allow-list.
  2. `get`, `put` (upsert, `If-Match` when the row exists; compile subject, HTML and text in strict mode and check variables → `422 TEMPLATE_INVALID` with `details.errors[{part, line, message}]`), `preview` (render with `sample_data` or given variables, return `{subject, html, text}`), `reset` (delete the row).
  3. Remove the five operations from `pending-operations.ts`.
- **Acceptance:**
  - A template that does not compile or uses an unknown variable is refused with 422 `TEMPLATE_INVALID` [OF-10 AC3].
  - After `reset` the next e-mail uses the code default.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- settings && pnpm --filter @velexis/ota-backend test:int -- settings`

### OBE-074 · Handle tenant.suspend and tenant.resume
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-006, OBE-056, OBE-059
- **Size:** M
- **Read first:** ota/docs/flows/tenant-provisioning-worker.md §3 (`tenant.suspend`, `tenant.resume`) and §7; platform/docs/adr/0014-tenant-suspension-and-resume.md; ota/docs/adr/0014-per-tenant-workers-and-schedulers.md (point 4)
- **Files:** `ota/backend/src/provisioning/housekeeping.service.ts`, `ota/backend/src/provisioning/housekeeping.service.test.ts`, `ota/backend/src/provisioning/tenant-ops.processor.ts`, `ota/backend/test/integration/provisioning/suspend-resume.int.test.ts`
- **Steps:**
  1. `tenant.suspend {reason}`: re-read `tenants.status`; if still `suspended`, expire `open`/`payment_pending` checkouts and enqueue `payment.void` for their authorisations, write `staffdeny:tenant:<tenantId>` (epoch ms, 30 days), answer `tenant.suspended`. No-op (still answered) when the tenant is active again.
  2. `tenant.resume`: if `active`, delete `staffdeny:tenant:<tenantId>`, answer `tenant.resumed`.
  3. Confirm the scheduler filters of OBE-024: the queue poller skips suspended tenants; ticketing, sync, reconciliation, refunds and transactional e-mails continue.
- **Acceptance:**
  - Suspend expires an open checkout and enqueues its void; a staff session created before it is refused; the ticketing job still runs for a paid booking.
  - Resume lets staff sign in again; both events validate against PBE-004's schemas.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- provisioning && pnpm --filter @velexis/ota-backend test:int -- provisioning`

### OBE-075 · Prove the permission matrix, staff audit and office isolation across console operations
- **Component:** ota-backend
- **Milestone:** M4
- **Depends on:** OBE-063, OBE-064, OBE-065, OBE-066, OBE-067, OBE-068, OBE-069, OBE-070, OBE-071, OBE-072, OBE-073
- **Size:** M
- **Read first:** ota/docs/scope.md §1.3 and §4 (OF-09); ota/docs/flows/console-operations.md §6; docs/mvp/adr/0006-contract-first-openapi.md (route parity at the end of M4)
- **Files:** `ota/backend/test/integration/m4/permission-matrix.int.test.ts`, `ota/backend/test/integration/m4/staff-actions.int.test.ts`, `ota/backend/test/integration/m4/office-isolation.int.test.ts`, `ota/backend/test/contract/route-parity.contract.test.ts`, `ota/backend/test/contract/openapi-extensions.contract.test.ts`
- **Steps:**
  1. Table-driven test over every console operation and the five roles: allowed or `403 FORBIDDEN` exactly as scope §1.3 says; viewers limited to test.
  2. Every console call (success and denied) writes exactly one `staff_actions` row with redacted before and after.
  3. Two tenants on the shared Amadeus account: imports, queue reads and raw calls for the other tenant's office are refused.
  4. Route parity: `pending-operations.ts` now holds only operations with `x-milestone: deferred` (19) plus the two M5 webhooks (documented by OBE-090, implemented by OBE-078); the test asserts it. `openapi-extensions.contract.test.ts` asserts the M4 totals of api-changes part 2 §6 once: 135 operations, 128 with `x-sdk-method`.
- **Acceptance:**
  - Every console call writes `staff_actions` [OF-09 AC1]; permissions follow scope §1.3 [OF-09 AC2]; PNR import accepts only the tenant's offices [OF-09 AC3].
  - The parity and totals assertions of step 4 pass.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- contract && pnpm --filter @velexis/ota-backend test:int -- m4`

### SDK-011 · Write the console namespace for auth, bookings, queues, customers, supplier log and raw Amadeus
- **Component:** ota-sdk
- **Milestone:** M4
- **Depends on:** SDK-006, OBE-058
- **Size:** M
- **Read first:** docs/velexis-sdk/sdk/src/console.d.ts; docs/velexis-sdk/sdk/docs/B4.md; ota/sdk/README.md §4.3; ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md (points 1, 3)
- **Files:** `ota/sdk/src/namespaces/console.js`, `ota/sdk/src/console.js`, `ota/sdk/test/unit/namespaces-console.test.js`, `ota/sdk/test/contract/pending-namespaces.js`
- **Steps:**
  1. Run `pnpm --filter @velexis/ota-sdk generate` for the M4 document. Factory with `console.auth.*` (4), `console.bookings.*` (11, `create` deferred), `console.queues.*`, `console.customers.*`, `console.supplierRequests.list` and `console.amadeus.*` (12, four deferred), JSDoc for each; long actions use 60 s.
  2. `console.js` mirrors `console.d.ts`, including the `sessionKind` and `onStaffSessionRefreshed` augmentation; `environment` sends `X-Velexis-Environment`.
  3. Keep `console` in `pending-namespaces.js` until SDK-012 adds `settings` and `payments`, but assert the contract methods here.
- **Acceptance:**
  - The contract test passes for the 32 contract console methods.
  - In server mode with `environment: "live"`, every console request carries `X-Velexis-Environment: live` and customer requests do not.
- **Verify:** `pnpm --filter @velexis/ota-sdk generate && pnpm --filter @velexis/ota-sdk build && pnpm --filter @velexis/ota-sdk test`

### SDK-012 · Write console settings and payments, multipart upload and storefront pages
- **Component:** ota-sdk
- **Milestone:** M4
- **Depends on:** SDK-011, OBE-090, OBE-091
- **Size:** M
- **Read first:** ota/sdk/docs/extensions.md §3.1–§3.3; ota/docs/api-changes-console-and-internal.md §2–§4; ota/sdk/README.md §5.3 (Bodies)
- **Files:** `ota/sdk/src/namespaces/console.js`, `ota/sdk/src/namespaces/storefront.js`, `ota/sdk/src/internal/http.js`, `ota/sdk/test/unit/namespaces-console-settings.test.js`, `ota/sdk/test/unit/multipart.test.js`, `ota/sdk/test/contract/pending-namespaces.js`, `ota/sdk/docs/extensions.md`
- **Steps:**
  1. `console.settings.markupRules.*`, `.feeRules.*`, `.storefront.get/update`, `.pages.*`, `.assets.list/upload/delete`, `.templates.list/get/put/preview/reset` (25) and `console.payments.list/get/capture/refund` (4), with JSDoc.
  2. `console.settings.assets.upload` builds `multipart/form-data` from a `Blob` or `File` and `kind`; the `Content-Type` boundary is left to `fetch`.
  3. `storefront.listPages` and `storefront.getPage`; remove their two method entries (OBE-091) from `pending-namespaces.js`.
- **Acceptance:**
  - The multipart request carries the file and `kind` parts and an idempotency key.
  - Every new method hits the right method and path (route-table test).
- **Verify:** `pnpm --filter @velexis/ota-sdk build && pnpm --filter @velexis/ota-sdk test`

### SDK-013 · Close the parity pending list and make the contract check strict
- **Component:** ota-sdk
- **Milestone:** M4
- **Depends on:** SDK-012, SDK-008, SDK-009, SDK-010
- **Size:** S
- **Read first:** ota/docs/adr/0016-sdk-packaging-and-type-contract.md (point 4); ota/sdk/docs/types-and-builds.md §4 and §7
- **Files:** `ota/sdk/test/contract/pending-namespaces.js`, `ota/sdk/test/contract/parity.test.js`, `ota/sdk/scripts/check-size.mjs`
- **Steps:**
  1. Empty `pending-namespaces.js` and make the parity test fail on any non-empty list.
  2. Confirm the ESM bundle with all 128 methods stays within 25 KB min+gzip; if not, split `@velexis/ota-sdk/console` as a separate entry (OADR-0016 follow-up) in this task.
- **Acceptance:**
  - The set of `x-sdk-method` names equals the set of client methods (128).
  - The size check passes with the printed size recorded in the PR.
- **Verify:** `pnpm --filter @velexis/ota-sdk build && pnpm --filter @velexis/ota-sdk test`

### SDK-014 · Add the nightly smoke tests against the local backend
- **Component:** ota-sdk
- **Milestone:** M4
- **Depends on:** SDK-013, OBE-075
- **Size:** M
- **Read first:** ota/sdk/README.md §8 (Smoke); ota/backend/README.md §5 (`dev:seed`); docs/mvp/adr/0015-testing-strategy.md
- **Files:** `ota/sdk/test/smoke/token-mode.smoke.test.js`, `ota/sdk/test/smoke/server-mode.smoke.test.js`, `ota/sdk/vitest.smoke.config.js`, `ota/sdk/package.json`, `.github/workflows/e2e.yml`
- **Steps:**
  1. `test:smoke` against `OTA_API_URL` with the `dev:seed` keys: one call per namespace in token mode (`pk_test`) and in server mode (`sk_test` with a staff token minted through a test portal token), including a deferred method that answers 501.
  2. Run it in the nightly workflow after the stack starts.
- **Acceptance:**
  - The smoke run passes against the local stack and fails clearly (not hangs) when the API is down.
- **Verify:** `pnpm --filter @velexis/ota-sdk test:smoke`

### OAD-002 · Add the server-only SDK client, session cookies with refresh de-duplication and permissions
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-001, SDK-011
- **Size:** M
- **Read first:** ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md (points 1–5, 10); ota/docs/adr/0011-console-access-staff-sessions-and-environments.md (points 4, 8, 9); ota/admin/README.md §4, §6 (`lib/`), §7, §8; docs/mvp/conventions.md §3
- **Files:** `ota/admin/src/lib/velexis.ts`, `ota/admin/src/lib/session.ts`, `ota/admin/src/lib/session.test.ts`, `ota/admin/src/lib/refresh-dedup.ts`, `ota/admin/src/lib/refresh-dedup.test.ts`, `ota/admin/src/lib/permissions.ts`, `ota/admin/src/lib/permissions.test.ts`, `ota/admin/src/lib/errors.ts`, `ota/admin/src/lib/errors.test.ts`, `ota/admin/src/lib/action-state.ts`, `ota/admin/package.json`
- **Steps:**
  1. Workspace dependency `@velexis/ota-sdk`. `lib/velexis.ts` (`import "server-only"`): `getConsole()` with React `cache`, building a server-mode client per request (`secretKey` = `OTA_ADMIN_SERVICE_KEY`, `baseUrl` = `OTA_API_URL`, staff `accessToken`, `sessionKind: "staff"`, `environment` from the session, `onResponse` logging one line without bodies, and `headers` with `X-Velexis-End-User-IP` (the right-most `X-Forwarded-For` entry, which Caddy sets, or `127.0.0.1` when there is none in local development) and `X-Velexis-End-User-Agent` (the browser's `User-Agent`, cut to 512 characters), read with `next/headers`, so the backend's sign-in throttle, lockout and `staff_actions` see the staff member's address, not the admin server's); `getStaff()` = `console.auth.me` once per request.
  2. `lib/session.ts`: read and write `__Host-vx_staff_at`, `__Host-vx_staff_rt`, `__Host-vx_env`, `__Host-vx_tenant` (`HttpOnly; Secure; SameSite=Lax; Path=/`); `requireStaff(permission)` for server actions; redirect to `${PUBLIC_PORTAL_URL}/console?tenant=<id>` without a session.
  3. `lib/refresh-dedup.ts`: one in-process map from `sha256(refreshToken)` to the refresh promise and its result, kept 30 s, so parallel requests with the same old token get the same new tokens.
  4. `lib/permissions.ts` (`can(profile, permission)` from the scope matrix), `lib/errors.ts` (VelexisError code → message, `fieldErrors` → form state, `requestId` shown), `lib/action-state.ts`.
- **Acceptance:**
  - Two parallel refreshes with the same token make one SDK call and both receive the new tokens (unit test).
  - Every SDK request carries `X-Velexis-End-User-IP` taken from the right-most `X-Forwarded-For` entry and `X-Velexis-End-User-Agent`; a client-supplied left-most entry is never used (unit test with a fake `fetch`).
  - `can()` matches scope §1.3 for all five roles (table test); client components cannot import `lib/velexis.ts` (`server-only` build error asserted by a test fixture).
- **Verify:** `pnpm --filter @velexis/ota-admin test && pnpm --filter @velexis/ota-admin build`

### OAD-003 · Build the SSO, refresh and sign-out handlers and the middleware
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-002, OBE-059
- **Size:** M
- **Read first:** ota/admin/README.md §3 and §4; ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md (points 2, 3, 6); platform/docs/adr/0007-portal-to-ota-admin-sso-token.md (§5); docs/mvp/architecture.md §5 (c)
- **Files:** `ota/admin/src/app/sso/route.ts`, `ota/admin/src/app/sso/route.test.ts`, `ota/admin/src/app/auth/refresh/route.ts`, `ota/admin/src/app/auth/sign-out/route.ts`, `ota/admin/src/app/signed-out/page.tsx`, `ota/admin/src/middleware.ts`, `ota/admin/src/middleware.test.ts`, `ota/admin/next.config.ts`, `ota/admin/README.md`
- **Steps:**
  1. `POST /sso`: only `application/x-www-form-urlencoded` with `portalToken` matching `^ptk_[A-Za-z0-9]{24,64}$`; `Origin` must equal `PUBLIC_PORTAL_URL`; `console.auth.signIn({ grantType: "portal_token", portalToken })`; set the four cookies; `303 See Other` to `/bookings` (architecture flow (c), README §3 and PFE-019). Errors render a short page with "Back to the portal".
  2. `src/middleware.ts` (Node.js runtime; next to `src/app`, because Next.js ignores a `middleware.ts` at the app root when the app uses `src/`): refresh through the de-duplicated function when the access token expires within 60 s; redirect to the portal without a session; set the per-request CSP nonce header used by `next.config.ts`.
  3. `GET /auth/refresh?next=` (validated relative `next`) and `POST /auth/sign-out` (Origin checked, `console.auth.signOut`, clear cookies, `/signed-out`). A refused refresh clears the cookies and goes to the portal.
- **Acceptance:**
  - A foreign `Origin` on `/sso` answers 403; a token reused a second time shows the error page.
  - The SSO response sets four `__Host-` cookies with the attributes above and contains no token in the URL or body.
  - The middleware never refreshes the same token twice for parallel requests (test with two simultaneous requests).
- **Verify:** `pnpm --filter @velexis/ota-admin test && pnpm --filter @velexis/ota-admin build`

### OAD-004 · Build the console shell with the environment switch and shared components
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-003
- **Size:** M
- **Read first:** ota/admin/README.md §4 (Environment switch), §5, §9; ota/admin/docs/routes.md §1; ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md (point 6)
- **Files:** `ota/admin/src/app/(console)/layout.tsx`, `ota/admin/src/app/(console)/error.tsx`, `ota/admin/src/app/(console)/env-actions.ts`, `ota/admin/src/components/ui/button.tsx`, `ota/admin/src/components/ui/dialog.tsx`, `ota/admin/src/components/ui/table.tsx`, `ota/admin/src/components/data-table.tsx`, `ota/admin/src/components/status-badge.tsx`, `ota/admin/src/components/money.tsx`, `ota/admin/src/components/json-view.tsx`, `ota/admin/src/components/confirm-dialog.tsx`, `ota/admin/src/components/env-banner.tsx`, `ota/admin/src/components/permission-gate.tsx`, `ota/admin/src/components/confirm-dialog.test.tsx`, `ota/admin/src/components/permission-gate.test.tsx`, `ota/admin/package.json`
- **Steps:**
  1. Add the shadcn/ui components the shell needs (button, input, select, checkbox, switch, tabs, table, dialog, alert-dialog, badge, card, tooltip, dropdown-menu) and exact `@tanstack/react-table` 8.
  2. `(console)/layout.tsx`: tenant name, navigation filtered by `can()`, the TEST / LIVE switch when `session.environments` contains `live` (server action `env-actions.ts` sets `__Host-vx_env` only to an allowed value), warning colour in live mode, link back to the portal.
  3. Shared components: data table with server-side filters and cursor paging, status badges with text, money, collapsible JSON view of redacted payloads, confirmation dialog (summary, required reason, live warning, hidden idempotency key rendered once), permission gate with a tooltip naming the permission.
  4. `error.tsx` per area using `lib/errors.ts`.
- **Acceptance:**
  - A viewer sees no LIVE switch; posting `env=live` for a viewer is refused by the action.
  - The confirmation dialog cannot be submitted without a reason and keeps the same idempotency key on a double submit (component test).
- **Verify:** `pnpm --filter @velexis/ota-admin test && pnpm --filter @velexis/ota-admin build`

### OAD-005 · Build the dashboard
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-004, OBE-061, OBE-068, OBE-065
- **Size:** S
- **Read first:** ota/admin/docs/routes.md §2; ota/admin/README.md §5 (`/`)
- **Files:** `ota/admin/src/app/(console)/page.tsx`, `ota/admin/src/app/(console)/dashboard-tiles.tsx`, `ota/admin/src/app/(console)/dashboard.test.tsx`
- **Steps:**
  1. Tiles per permission: needs-attention counts (`console.bookings.list` with `totalCount` for ticketing failed or manual review, deadlines within 24 h, pending reconciliation), authorised uncaptured payments (`console.payments.list`), last queue snapshot (`console.queues.listSnapshots`), recent bookings.
  2. Each tile links to the filtered list; a tile the role cannot read is not rendered.
- **Acceptance:**
  - A finance user sees payments but not queues; counts link to the matching filters (component test with a fake SDK fetch).
- **Verify:** `pnpm --filter @velexis/ota-admin test`

### OAD-006 · Build the bookings list
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-004, OBE-061
- **Size:** M
- **Read first:** ota/admin/docs/routes.md §3.1; ota/docs/flows/console-operations.md §3 (step 3)
- **Files:** `ota/admin/src/app/(console)/bookings/page.tsx`, `ota/admin/src/app/(console)/bookings/filters.tsx`, `ota/admin/src/app/(console)/bookings/filters.test.tsx`, `ota/admin/src/app/(console)/bookings/views.ts`
- **Steps:**
  1. Server component calling `console.bookings.list` with filters, sort and cursor from `searchParams` (shareable links); saved needs-attention views from `views.ts`.
  2. Client filter component writes `searchParams` only; columns: reference, PNR, status, ticketing status, travellers, departure, total, channel.
- **Acceptance:**
  - Changing a filter updates the URL and the server request (component and server tests with the SDK's `fetch` option).
  - "Next" uses `page.nextCursor`; `totalCount` is shown when present.
- **Verify:** `pnpm --filter @velexis/ota-admin test`

### OAD-007 · Build the booking detail page
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-006, OBE-062
- **Size:** M
- **Read first:** ota/admin/docs/routes.md §3.2 (view parts); ota/admin/README.md §9 (JSON view)
- **Files:** `ota/admin/src/app/(console)/bookings/[bookingId]/page.tsx`, `ota/admin/src/app/(console)/bookings/[bookingId]/sections.tsx`, `ota/admin/src/app/(console)/bookings/[bookingId]/page.test.tsx`
- **Steps:**
  1. `console.bookings.get` for overview, travellers and contacts (documents masked unless the Amadeus order view is opened), tickets and documents, payments (`console.payments.get`), timeline with notes and `recentStaffActions`; the Amadeus order view loads `console.bookings.retrieve` on demand in the JSON view.
  2. Markup lines and net amounts shown to staff; reconciliation and manual-review states highlighted.
- **Acceptance:**
  - The page renders every section for a seeded ticketed booking and for a manual-review airline-card booking.
  - `console.bookings.retrieve` is not called until the order view is opened.
- **Verify:** `pnpm --filter @velexis/ota-admin test`

### OAD-008 · Build the booking actions
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-007, OBE-063, OBE-068
- **Size:** L
- **Read first:** ota/admin/docs/routes.md §3.2 (actions); ota/admin/README.md §7 (server action example), §10; ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md (points 5, 8)
- **Files:** `ota/admin/src/app/(console)/bookings/[bookingId]/actions.ts`, `ota/admin/src/app/(console)/bookings/[bookingId]/actions.test.ts`, `ota/admin/src/app/(console)/bookings/[bookingId]/patch-form.tsx`, `ota/admin/src/app/(console)/bookings/[bookingId]/issue-dialog.tsx`, `ota/admin/src/app/(console)/bookings/[bookingId]/cancel-dialog.tsx`, `ota/admin/src/app/(console)/bookings/[bookingId]/payment-dialogs.tsx`, `ota/admin/src/app/(console)/bookings/[bookingId]/note-form.tsx`
- **Steps:**
  1. Server actions, each starting with `requireStaff(permission)` and Zod validation: `patchBooking` (travellers, contacts, remarks, ticketing agreement; `ifMatch`), `issueTickets` (`allowUnpaid` only for owner and admin), `cancelBooking` (refund `none`, `full`, `amount`), `resyncBooking`, `addNote`, `capturePayment`, `refundPayment`.
  2. Every dialog renders a fresh idempotency key in a hidden input; `412` asks to reload; `fieldErrors` map to fields.
  3. Airline-card bookings in manual review: issue offers only `other` forms of payment (`CASH`, `ACCOUNT`) or cancel; no card entry anywhere; refunds of airline payments are not offered (`refund_via_airline`).
- **Acceptance:**
  - Server-action tests with a fake `fetch` assert method, path, `If-Match`, idempotency key reuse on a double submit and the environment header.
  - No form in the admin has a card-number field (test greps the built pages).
- **Verify:** `pnpm --filter @velexis/ota-admin test && pnpm --filter @velexis/ota-admin build`

### OAD-009 · Build PNR lookup and import and the queue pages
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-004, OBE-064, OBE-065
- **Size:** M
- **Read first:** ota/admin/docs/routes.md §4 and §5; ota/docs/flows/console-operations.md §3 (step 4)
- **Files:** `ota/admin/src/app/(console)/pnr/page.tsx`, `ota/admin/src/app/(console)/pnr/actions.ts`, `ota/admin/src/app/(console)/pnr/actions.test.ts`, `ota/admin/src/app/(console)/queues/page.tsx`, `ota/admin/src/app/(console)/queues/[queueId]/page.tsx`, `ota/admin/src/app/(console)/queues/queues.test.tsx`
- **Steps:**
  1. `/pnr`: record locator form → `console.bookings.findByRecordLocator`; preview; import with the pricing mode (`markup_rules`, `net`, `override` with a selling total) through `console.bookings.import`; `409 ORDER_ALREADY_IMPORTED` links to the existing booking; `403 OFFICE_NOT_ALLOWED` explained.
  2. `/queues` and `/queues/[queueId]`: monitored queues, live `console.queues.list` and stored snapshots; orphan items (no local booking) marked with an "Import" link.
- **Acceptance:**
  - Import sends the chosen pricing mode and an idempotency key; a second import shows the existing booking link.
  - Orphan queue items link to `/pnr?recordLocator=…`.
- **Verify:** `pnpm --filter @velexis/ota-admin test`

### OAD-010 · Build shopping on behalf
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-004, OBE-067
- **Size:** M
- **Read first:** ota/admin/docs/routes.md §6; ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md (point 7); docs/velexis-sdk/examples/next-storefront/app/console/search/ (reference flow)
- **Files:** `ota/admin/src/app/(console)/shopping/page.tsx`, `ota/admin/src/app/(console)/shopping/actions.ts`, `ota/admin/src/app/(console)/shopping/actions.test.ts`, `ota/admin/src/app/(console)/shopping/results.tsx`
- **Steps:**
  1. Search form → `console.amadeus.searchFlightOffers`; availability tab → `console.amadeus.searchFlightAvailabilities`; branded fares → `console.amadeus.upsellAirOffers`; read-only quote → `console.amadeus.quoteAirOffers`. Net prices, clearly labelled.
  2. A notice that booking on behalf comes later (`console.bookings.create` is deferred); no customer-scope operation is called.
- **Acceptance:**
  - Each action calls the right raw operation with the environment header (server-action tests).
  - The page never calls `flights.*` (a test asserts no request to `/v1/flight-searches`).
- **Verify:** `pnpm --filter @velexis/ota-admin test`

### OAD-011 · Build the payments pages
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-004, OBE-068
- **Size:** M
- **Read first:** ota/admin/docs/routes.md §7; ota/docs/api-changes-console-and-internal.md §3
- **Files:** `ota/admin/src/app/(console)/payments/page.tsx`, `ota/admin/src/app/(console)/payments/[paymentId]/page.tsx`, `ota/admin/src/app/(console)/payments/[paymentId]/actions.ts`, `ota/admin/src/app/(console)/payments/[paymentId]/actions.test.ts`
- **Steps:**
  1. List with filters (`status`, `provider`, `method`, booking, dates) through `console.payments.list`; detail through `console.payments.get` with events, refunds and the booking link; `refresh` button.
  2. Capture and refund dialogs (reason, amount, live warning, idempotency key, `ifMatch`); airline-card payments show "refunded by the airline" instead of a refund button.
- **Acceptance:**
  - A refund above the captured amount shows the API's message; an agent sees no refund button.
- **Verify:** `pnpm --filter @velexis/ota-admin test`

### OAD-012 · Build customers, the supplier log and portal links
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-004, OBE-066
- **Size:** M
- **Read first:** ota/admin/docs/routes.md §8, §10, §11; ota/admin/README.md §5 (`/portal`)
- **Files:** `ota/admin/src/app/(console)/customers/page.tsx`, `ota/admin/src/app/(console)/customers/[customerId]/page.tsx`, `ota/admin/src/app/(console)/supplier-log/page.tsx`, `ota/admin/src/app/(console)/portal/page.tsx`, `ota/admin/src/lib/portal-links.ts`, `ota/admin/src/lib/portal-links.test.ts`, `ota/admin/src/app/(console)/customers/customers.test.tsx`
- **Steps:**
  1. Customers search by e-mail or name prefix (`console.customers.list`), detail with statistics and bookings (`console.customers.get`, `console.bookings.list({ customerId })`).
  2. Supplier log with filters (`console.supplierRequests.list`) and the JSON view of redacted bodies.
  3. `/portal`: links to `${PUBLIC_PORTAL_URL}/otas/<tenantId>/…` for API keys, domains, Amadeus, payments and Stripe, team, billing, go-live.
- **Acceptance:**
  - Portal links are built from the configured URL and the tenant id only (unit test).
  - The customer detail lists that customer's bookings through `console.bookings.list({ customerId })` (server test with a fake `fetch`).
- **Verify:** `pnpm --filter @velexis/ota-admin test`

### OAD-013 · Build markup and fee rule settings
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-004, OBE-069, SDK-012
- **Size:** M
- **Read first:** ota/admin/docs/routes.md §9; ota/docs/api-changes-console-and-internal.md §2.1–§2.2; ota/docs/adr/0005-markup-and-fee-engine.md (points 3–6)
- **Files:** `ota/admin/src/app/(console)/settings/markups/page.tsx`, `ota/admin/src/app/(console)/settings/markups/[id]/page.tsx`, `ota/admin/src/app/(console)/settings/markups/new/page.tsx`, `ota/admin/src/app/(console)/settings/fees/page.tsx`, `ota/admin/src/app/(console)/settings/fees/[id]/page.tsx`, `ota/admin/src/app/(console)/settings/fees/new/page.tsx`, `ota/admin/src/app/(console)/settings/pricing-rule-form.tsx`, `ota/admin/src/app/(console)/settings/pricing-actions.ts`, `ota/admin/src/app/(console)/settings/pricing-actions.test.ts`
- **Steps:**
  1. Lists ordered by priority with active filter; one shared form for scope (origins, destinations, countries, carriers, cabins, traveller types, trip types, sources, channels, net range), calculation, amounts, per unit, caps, priority, stackable, validity, and for fees the type, label, card brands and refundable flag.
  2. Show the API's warnings (foreign fixed currency, selling below net) and an explanation of first-match and stacking; the default rule cannot be deleted.
  3. Server actions with `requireStaff("settings:write")`, `ifMatch`, Zod mirrors of the schema.
- **Acceptance:**
  - Agents see the lists read-only; owners can create, edit and delete (permission tests).
  - Server-action tests assert the payloads for create, update and delete.
- **Verify:** `pnpm --filter @velexis/ota-admin test`

### OAD-014 · Build storefront settings and assets
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-013, OBE-070, OBE-071
- **Size:** L
- **Read first:** ota/admin/docs/routes.md §9; ota/docs/api-changes-console-and-internal.md §2.3 and §2.5; ota/admin/README.md §9 (theme editor), §10 (uploads); ota/frontend/README.md §6
- **Files:** `ota/admin/src/app/(console)/settings/storefront/page.tsx`, `ota/admin/src/app/(console)/settings/storefront/sections.tsx`, `ota/admin/src/app/(console)/settings/storefront/theme-editor.tsx`, `ota/admin/src/app/(console)/settings/storefront/actions.ts`, `ota/admin/src/app/(console)/settings/storefront/actions.test.ts`, `ota/admin/src/app/(console)/settings/assets/page.tsx`, `ota/admin/src/app/(console)/settings/assets/actions.ts`, `ota/admin/src/app/(console)/settings/assets/actions.test.ts`, `ota/admin/src/lib/contrast.ts`, `ota/admin/src/lib/contrast.test.ts`
- **Steps:**
  1. Sections: brand, branding and theme (colours with a live swatch preview and WCAG contrast warning, fonts from the enum, corner radius, logo and favicon pickers from `console.settings.assets.list`), locales and currencies, markets, features, policies (ticketing policy, 3-D Secure, card brands, TTLs, e-mail verification), airline card per environment (live disabled while the platform switch is off, with the warning about markups), legal and support, SEO and consent, operations (alert e-mail, booking queue).
  2. One server action per section with `ifMatch`; show `warnings[]` from the API.
  3. Assets page: upload through a server action (2 MB limit, the API refuses over 1 MB, SVG and CSS), list with kind and size, delete (409 when in use explained); a notice that image metadata is kept.
- **Acceptance:**
  - A low-contrast colour pair shows the warning (unit test of `contrast.ts`).
  - The upload action sends multipart with an idempotency key; an SVG is rejected with the API's `ASSET_INVALID` reason shown.
- **Verify:** `pnpm --filter @velexis/ota-admin test && pnpm --filter @velexis/ota-admin build`

### OAD-015 · Build content page and template settings
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-014, OBE-072, OBE-073
- **Size:** M
- **Read first:** ota/admin/docs/routes.md §9; ota/docs/api-changes-console-and-internal.md §2.4 and §2.6; ota/admin/README.md §9 (template preview)
- **Files:** `ota/admin/src/app/(console)/settings/pages/page.tsx`, `ota/admin/src/app/(console)/settings/pages/[pageId]/page.tsx`, `ota/admin/src/app/(console)/settings/pages/actions.ts`, `ota/admin/src/app/(console)/settings/templates/page.tsx`, `ota/admin/src/app/(console)/settings/templates/[key]/[channel]/[locale]/page.tsx`, `ota/admin/src/app/(console)/settings/templates/actions.ts`, `ota/admin/src/app/(console)/settings/templates/preview-frame.tsx`, `ota/admin/src/app/(console)/settings/content-actions.test.ts`
- **Steps:**
  1. Pages: list, create, edit (Markdown subset with a short syntax help, slug, locale, kind, published, footer, order), delete; `422` errors shown at their line.
  2. Templates: list of effective templates (`customised` badge), editor for subject, HTML and text with the variable list, preview in an `<iframe sandbox srcdoc>` without `allow-scripts`, reset to default; `422 TEMPLATE_INVALID` errors listed per part and line.
- **Acceptance:**
  - The preview iframe has a `sandbox` attribute without `allow-scripts` (component test).
  - A Markdown error is shown next to the reported line.
- **Verify:** `pnpm --filter @velexis/ota-admin test`

### OAD-016 · Add the OTA admin Playwright project with the SSO and bookings journeys
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-008, OAD-009, PFE-017, PFE-014
- **Size:** M
- **Read first:** ota/admin/README.md §12; tools/e2e/README.md; platform/docs/plans/agent-tasks.md (PFE-019 gate); docs/mvp/adr/0015-testing-strategy.md (End-to-end)
- **Files:** `tools/e2e/playwright.config.ts`, `tools/e2e/support/stack.ts`, `tools/e2e/support/ota.ts`, `tools/e2e/specs/ota-admin/sso-bookings.e2e.ts`, `tools/e2e/specs/ota-admin/pnr-import.e2e.ts`, `tools/e2e/README.md`
- **Steps:**
  1. Add the Playwright project `ota-admin` (base URL `http://127.0.0.1:3002`, `testMatch` `specs/ota-admin/**/*.e2e.ts`); `support/stack.ts` also starts the built OTA admin when `E2E_WITH_OTA=1`.
  2. `sso-bookings.e2e.ts`: portal sign-in → "Open console" → `/bookings` of the right OTA; open a seeded manual-review booking → issue with a reason → status ticketed; cancel another with a full refund (airline-card booking, so no Stripe) → cancelled; reposting the captured SSO form fails.
  3. `pnr-import.e2e.ts`: import a PNR created in the stub for the tenant's office; the same for another tenant's office is refused.
  4. axe on every page visited (no serious or critical violation); `document.cookie` on the admin origin is empty for JavaScript.
- **Acceptance:**
  - The journeys pass locally and nightly, which meets the gate of platform task PFE-019 (OF-09).
- **Verify:** `pnpm --filter @velexis/ota-admin build && E2E_WITH_OTA=1 pnpm test:e2e -- --project=ota-admin specs/ota-admin/sso-bookings.e2e.ts specs/ota-admin/pnr-import.e2e.ts`

### OAD-017 · Write the payments, settings and permissions journeys
- **Component:** ota-admin
- **Milestone:** M4
- **Depends on:** OAD-016, OAD-011, OAD-015, OFE-020
- **Size:** M
- **Read first:** ota/admin/README.md §12 (end-to-end list); ota/docs/scope.md §4 (OF-09, OF-10)
- **Files:** `tools/e2e/specs/ota-admin/payments.e2e.ts`, `tools/e2e/specs/ota-admin/settings-effects.e2e.ts`, `tools/e2e/specs/ota-admin/roles.e2e.ts`
- **Steps:**
  1. `payments.e2e.ts` (project `storefront-stripe` stack, nightly): capture a `manual_review` Stripe payment and refund part of a captured one; the refund completes through the webhook.
  2. `settings-effects.e2e.ts`: change a markup rule → the next storefront search shows the new selling price; change the primary colour and add a page → the storefront shows them (after clearing the 5-minute caches in test mode); a broken template is refused.
  3. `roles.e2e.ts`: a viewer sees no actions and no LIVE switch; an agent cannot open settings writes.
- **Acceptance:**
  - Markup and fee changes apply to the next search [OF-10 AC1]; settings changes reach the storefront [OF-10 AC2]; invalid templates are refused [OF-10 AC3].
  - The role journey matches scope §1.3 for viewer and agent [OF-09 AC2].
- **Verify:** `E2E_WITH_OTA=1 pnpm test:e2e -- --project=ota-admin specs/ota-admin/settings-effects.e2e.ts specs/ota-admin/roles.e2e.ts`

### OFE-020 · Build content pages and footer links with the Caddy rewrite
- **Component:** ota-frontend
- **Milestone:** M4
- **Depends on:** OFE-003, OBE-072, SDK-012
- **Size:** M
- **Read first:** ota/frontend/docs/pages-account.md §7; ota/docs/adr/0015-storefront-build-urls-and-hosting.md (points 4, 8, Follow-ups); ota/docs/adr/0012-storefront-settings-assets-and-pages.md (point 5); deploy/caddy/Caddyfile
- **Files:** `ota/frontend/p.html`, `ota/frontend/src/pages/p.js`, `ota/frontend/src/lib/blocks.js`, `ota/frontend/test/blocks.test.js`, `ota/frontend/src/components/footer.js`, `ota/frontend/src/styles/fonts.css`, `ota/frontend/test/fonts.test.js`, `deploy/caddy/Caddyfile`, `deploy/caddy/test/caddy-smoke.sh`
- **Steps:**
  1. `p.html` reads the slug from `location.pathname`, calls `storefront.getPage`, renders `blocks` with `createElement` and `textContent` only (`lib/blocks.js`), re-checks link schemes (`https:`, `mailto:`, `tel:`, relative `/p/…`) and adds `rel="noopener noreferrer"` to external links; images only from same-origin asset paths.
  2. The footer lists `storefront.listPages` with `showInFooter` (failure ignored).
  3. `fonts.css` declares every font of the `StorefrontSettings.branding.fonts` enum; `fonts.test.js` compares the two lists.
  4. Caddyfile: `rewrite /p/* /p.html` inside the storefront `handle` block before `try_files`; extend `caddy-smoke.sh`.
- **Acceptance:**
  - A block with a `javascript:` link is rendered as plain text (unit test); no `innerHTML` is used.
  - `/p/terms` serves `p.html` in Caddy (smoke test) and in `vite preview`.
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build && bash deploy/caddy/test/caddy-smoke.sh`

## M5 — Monetisation & self-service

The platform turns on own Stripe, own Amadeus credentials, custom domains and go-live. The OTA code follows the data (`account_mode`, `credential_source`, verified domains, `storefront_environment`) with no per-tenant code path (OF-12).

### OBE-076 · Spec-first: the billing notice in the console session
- **Component:** ota-backend
- **Milestone:** M5
- **Depends on:** OBE-058
- **Size:** S
- **Read first:** platform/docs/data-model.md (grep `billing_notice`); platform/docs/plans/implementation-plan.md §4 (M5 dependencies on the OTA group); ota/docs/api-changes-console-and-internal.md §3 and §5 (the M5 webhooks are already documented by OBE-090)
- **Files:** `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, `ota/backend/openapi/README.md`, `ota/docs/api-changes-console-and-internal.md`, `packages/api-types/src/generated/ota.ts`
- **Steps:**
  1. Add the optional, nullable field `tenant.billingNotice` (`past_due`, `trial_ending`) to `ConsoleStaffSession` (additive), so the OTA admin can show the platform's billing banner; describe it in part 2 of the API changes (new §3.1).
  2. Lint and regenerate; record the change in the README's change log. The Connect and connection webhooks need no spec change here: OBE-090 documented them in M4 and OBE-078 implements them.
- **Acceptance:**
  - `pnpm contracts:lint` is clean; the SDK contract test still passes (the change is additive).
- **Verify:** `pnpm contracts:lint && pnpm contracts:generate && pnpm --filter @velexis/ota-backend test -- contract && pnpm --filter @velexis/ota-sdk test`

### OBE-077 · Serve Connect Standard and API-key modes in the Stripe gateway
- **Component:** ota-backend
- **Milestone:** M5
- **Depends on:** OBE-076, OBE-039
- **Size:** M
- **Read first:** ota/docs/adr/0010-stripe-gateway-and-payment-webhooks.md (point 1); ota/docs/api-changes.md §4; platform/docs/adr/0011-stripe-connect-standard-and-api-key-connections.md; docs/mvp/adr/0011-payments-stripe-and-airline-card.md (account modes)
- **Files:** `ota/backend/src/payments/stripe/stripe-client.factory.ts`, `ota/backend/src/payments/stripe/stripe.gateway.ts`, `ota/backend/src/payments/stripe/stripe.gateway.test.ts`, `ota/backend/src/storefront/storefront.mapper.ts`, `ota/backend/test/integration/payments/account-modes.int.test.ts`
- **Steps:**
  1. `connect_standard`: Velexis secret key of the environment plus `Stripe-Account: <account_reference>` on every call (direct charges); storefront config gives Velexis's publishable key and `accountId`.
  2. `api_keys`: the connection's secret decrypted inside the gateway only (associated data of the connection row); storefront config gives the connection's publishable key; no statement descriptor suffix.
  3. Existing payments keep the mode they were created with (stored on the payment's connection snapshot), so a switch never moves a payment; a connection invalidation takes effect within 60 s.
- **Acceptance:**
  - The same code serves all three modes: table-driven tests assert the key, the `Stripe-Account` header and the storefront config per mode [OF-12 AC1].
  - The decrypted secret never appears in a log line or an error.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- payments && pnpm --filter @velexis/ota-backend test:int -- payments`

### OBE-078 · Receive Connect and per-connection Stripe webhooks
- **Component:** ota-backend
- **Milestone:** M5
- **Depends on:** OBE-077, OBE-090
- **Size:** M
- **Read first:** ota/docs/adr/0010-stripe-gateway-and-payment-webhooks.md (point 4); docs/mvp/architecture.md §5 (d) table; ota/docs/api-changes-console-and-internal.md §5
- **Files:** `ota/backend/src/payments/webhooks/stripe-connect-webhook.controller.ts`, `ota/backend/src/payments/webhooks/stripe-connection-webhook.controller.ts`, `ota/backend/src/payments/webhooks/webhook-receiver.service.ts`, `ota/backend/src/config.ts`, `deploy/env/ota-backend.env.example`, `ota/backend/src/common/http/pending-operations.ts`, `ota/backend/test/integration/payments/connect-webhooks.int.test.ts`
- **Steps:**
  1. Config `STRIPE_WEBHOOK_SECRET_CONNECT_TEST`, `_LIVE`. `/webhooks/stripe/connect/{environment}`: verify with the Connect secret; tenant **only** from `event.account` → `payment_provider_connections.account_reference` of a `connect_standard` connection.
  2. `/webhooks/stripe/c/{connectionId}`: verify with that connection's encrypted webhook secret; tenant **only** from the path's connection (`api_keys` mode).
  3. On both endpoints the OTA controls the Stripe account and can write any metadata, so metadata never selects the tenant: `metadata.velexis_tenant_id` and `metadata.velexis_environment`, when present, must equal the resolved tenant and environment; `event.livemode` must match the path's environment (Connect) or the connection's environment (`c/`); the payment is looked up only inside the resolved tenant and its `provider_payment_id` must match the event's object. Any mismatch is logged as a security event (no payload) and acknowledged with `200` without writing anything (OADR-0010 point 4).
  4. Both reuse the receiver of OBE-039 (store, acknowledge, enqueue, re-fetch with the right mode). Remove both from `pending-operations.ts`.
- **Acceptance:**
  - Signed fixtures for both endpoints are stored and processed once; a fixture signed with another connection's secret answers 400.
  - An event for an unknown `acct_` is acknowledged with 200 and ignored.
  - Forged metadata: a correctly signed Connect event from tenant A's account, and a `c/<ppc_id>` event of tenant A, each carrying `metadata.velexis_tenant_id` of tenant B, write no `payment_events` row in either schema, raise no staff alert and log a security event; a `livemode` mismatch behaves the same.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- payments`

### OBE-079 · Use OTA-owned Amadeus credentials and the releasing-office rule
- **Component:** ota-backend
- **Milestone:** M5
- **Depends on:** OBE-017, OBE-063
- **Size:** M
- **Read first:** ota/docs/flows/amadeus-connection-and-tokens.md §2 (rules 2–3, 6); ota/docs/adr/0001-amadeus-client-design.md (point 4, Follow-ups); platform/docs/adr/0012-amadeus-office-pool.md (point 4)
- **Files:** `ota/backend/src/amadeus/connection-resolver.ts`, `ota/backend/src/amadeus/connection-resolver.test.ts`, `ota/backend/src/tenancy/platform-read.repository.ts`, `ota/backend/test/integration/amadeus/own-credentials.int.test.ts`
- **Steps:**
  1. `credential_source = tenant`: the connection's own client id and encrypted secret, base URL and offices; tokens keyed by the new credential id, so the old token is never reused.
  2. For calls on an existing booking (sync, issue, cancel, patch, queue reads), use the booking's `owner_office_id`/`queuing_office_id`: if that office is a Velexis `amadeus_offices` row `assigned` or `releasing` for the tenant, the Velexis account serves the call; otherwise the tenant's credentials.
  3. Handle the `amadeus_account` and `connection` invalidations for the new rows.
- **Acceptance:**
  - After a switch to own credentials, new searches use the tenant's credentials while the sync of an old booking still uses the Velexis account [OF-12 AC2].
  - An office `available` again (released) no longer routes to the Velexis account.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- amadeus && pnpm --filter @velexis/ota-backend test:int -- amadeus`

### OBE-080 · Resolve verified custom domains and use the primary host in e-mail links
- **Component:** ota-backend
- **Milestone:** M5
- **Depends on:** OBE-012, OBE-055
- **Size:** M
- **Read first:** docs/mvp/adr/0018-hosted-storefront-custom-domains.md; ota/docs/adr/0009-caller-and-tenant-resolution.md (point 2); ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md (point 7, Follow-ups); platform/docs/adr/0004-custom-domain-verification.md
- **Files:** `ota/backend/src/tenancy/tenant-resolver.ts`, `ota/backend/src/tenancy/platform-read.repository.ts`, `ota/backend/src/notifications/storefront-host.ts`, `ota/backend/src/notifications/storefront-host.test.ts`, `ota/backend/test/integration/tenancy/custom-domains.int.test.ts`
- **Steps:**
  1. Prove and complete edge resolution of verified custom storefront domains (`host:<hostname>`, active tenants only, `domain` invalidation); a pending or failed domain answers `403 HOST_NOT_ALLOWED`.
  2. `storefront-host.ts`: e-mail links and absolute asset URLs use the tenant's primary storefront host (custom domain when verified and primary, else the sub-domain).
  3. CSRF `Origin` checks follow the request's verified host.
- **Acceptance:**
  - A verified custom domain resolves within one second of the `domain` invalidation; a removed one stops resolving.
  - Booking e-mails link to the primary custom domain when it is set.
- **Verify:** `pnpm --filter @velexis/ota-backend test && pnpm --filter @velexis/ota-backend test:int -- tenancy`

### OBE-081 · Serve the live environment for live tenants
- **Component:** ota-backend
- **Milestone:** M5
- **Depends on:** OBE-077, OBE-060
- **Size:** M
- **Read first:** docs/mvp/adr/0018-hosted-storefront-custom-domains.md (environment switch); ota/docs/adr/0011-console-access-staff-sessions-and-environments.md (point 5); platform/docs/plans/agent-tasks.md (PBE-061 effects); ota/backend/README.md §3 (live Stripe keys)
- **Files:** `ota/backend/src/tenancy/tenant-resolver.ts`, `ota/backend/src/payments/stripe/stripe-client.factory.ts`, `ota/backend/src/identity/staff/staff-auth.service.ts`, `ota/backend/test/integration/tenancy/live-environment.int.test.ts`
- **Steps:**
  1. When `tenants.storefront_environment` flips to `live` (with a `tenant` invalidation), edge requests use the live environment: live Amadeus connection, live payment connection, live bookings; test data never appears on the live storefront.
  2. `console.auth.me` offers `live` to non-viewer roles of live tenants; console calls with `X-Velexis-Environment: live` read live rows only.
  3. Live Stripe keys (`STRIPE_SECRET_KEY_LIVE`, `STRIPE_PUBLISHABLE_KEY_LIVE`) are required only when a live tenant uses `velexis` or `connect_standard` mode; otherwise a missing key answers `424 PAYMENT_PROVIDER_NOT_CONFIGURED`.
- **Acceptance:**
  - Within one second of the invalidation the storefront config reports `environment: "live"` and searches use the live connection (stub on a second port).
  - A test booking is not visible from the live storefront nor in the live console view.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- tenancy`

### OBE-082 · Expose the billing notice to the console
- **Component:** ota-backend
- **Milestone:** M5
- **Depends on:** OBE-076, OBE-059
- **Size:** S
- **Read first:** platform/docs/flows/subscription-billing.md (status effects); platform/docs/architecture.md §6.2 (`billing_notice`); ota/docs/api-changes-console-and-internal.md §3.1 (added by OBE-076)
- **Files:** `ota/backend/src/identity/staff/staff-auth.service.ts`, `ota/backend/src/identity/staff/staff-auth.service.test.ts`, `ota/backend/test/integration/console/billing-notice.int.test.ts`
- **Steps:**
  1. `console.auth.me` and the sign-in response fill `tenant.billingNotice` from the cached tenant row (`past_due`, `trial_ending` or `null`).
  2. A `tenant` invalidation refreshes it within one second.
- **Acceptance:**
  - Setting `billing_notice = 'past_due'` on the platform row (as migrator in the test) shows in the next `console.auth.me` after the invalidation.
- **Verify:** `pnpm --filter @velexis/ota-backend test:int -- console`

### OBE-083 · Prove own Stripe, own Amadeus and go-live across the backends
- **Component:** ota-backend
- **Milestone:** M5
- **Depends on:** OBE-078, OBE-079, OBE-080, OBE-081, PBE-053, PBE-055, PBE-057, PBE-061
- **Size:** M
- **Read first:** ota/docs/scope.md §4 (OF-12); platform/docs/adr/0017-platform-test-doubles-and-end-to-end-harness.md (item 2); platform/backend/test/cross-backend/stack.ts
- **Files:** `ota/backend/test/cross-backend/m5.xb.test.ts`, `ota/backend/test/cross-backend/stack.ts`, `ota/backend/vitest.xb.config.ts`, `ota/backend/package.json`, `.github/workflows/ci.yml`
- **Steps:**
  1. A cross-backend stack (platform API and worker, OTA API and worker, one database, one Redis, the Amadeus stub) with the platform `FEATURE_*` switches on.
  2. Own Amadeus: submit test credentials through the platform API (accepted by the stub) → the next OTA search uses them; an earlier booking still syncs through the Velexis account while its office is `releasing`.
  3. Own Stripe: connect an API-key connection (mocked `/v1/account`) → the next PaymentIntent uses the connection's key; a Connect connection (fixture) → `Stripe-Account` header present.
  4. Go-live: the platform's `goLive` with all preconditions → the OTA storefront config reports `live` within a second.
- **Acceptance:**
  - Every step passes with no OTA code path per tenant (the gateways and resolver are the only branches) [OF-12 AC1, AC2].
  - The test runs in CI as `test:xb`.
- **Verify:** `pnpm --filter @velexis/platform-backend build && pnpm --filter @velexis/ota-backend build && pnpm --filter @velexis/ota-backend test:xb`

### OAD-018 · Show the live environment and the billing notice in the OTA admin
- **Component:** ota-admin
- **Milestone:** M5
- **Depends on:** OAD-004, OBE-081, OBE-082
- **Size:** M
- **Read first:** ota/admin/README.md §4 (Environment switch); ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md (point 6); platform/docs/flows/subscription-billing.md (banner)
- **Files:** `ota/admin/src/app/(console)/layout.tsx`, `ota/admin/src/components/billing-banner.tsx`, `ota/admin/src/components/billing-banner.test.tsx`, `ota/admin/src/components/env-banner.tsx`, `tools/e2e/specs/ota-admin/live-environment.e2e.ts`
- **Steps:**
  1. The shell shows the billing banner for `tenant.billingNotice` (`past_due`: "Payment problem: update billing in the portal"; `trial_ending`) with a link to the portal billing page.
  2. For live tenants the LIVE switch appears for non-viewers; destructive dialogs repeat "LIVE"; switching reloads data for the chosen environment.
  3. `live-environment.e2e.ts`: after go-live (seeded), an agent switches to LIVE and sees live bookings only; a viewer still sees no switch.
- **Acceptance:**
  - The banner renders for each notice value and not for `null` (component test).
  - The live journey passes.
- **Verify:** `pnpm --filter @velexis/ota-admin test && E2E_WITH_OTA=1 pnpm test:e2e -- --project=ota-admin specs/ota-admin/live-environment.e2e.ts`

### OFE-021 · Handle live mode and custom domains on the storefront
- **Component:** ota-frontend
- **Milestone:** M5
- **Depends on:** OFE-003, OBE-080, OBE-081
- **Size:** S
- **Read first:** ota/frontend/README.md §2 (points 4–5); ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md (Follow-ups); docs/mvp/adr/0018-hosted-storefront-custom-domains.md (primary domain redirect)
- **Files:** `ota/frontend/src/boot.js`, `ota/frontend/src/lib/primary-host.js`, `ota/frontend/test/primary-host.test.js`
- **Steps:**
  1. `environment = live` removes the test banner and the `noindex` meta.
  2. When the config names a primary custom domain and the page runs on the sub-domain, the sign-in and sign-up pages redirect to the same path on the primary host before a session is created (OADR-0006 follow-up); other pages keep working on both hosts.
- **Acceptance:**
  - Unit tests cover live versus test rendering and the redirect rule (only auth pages, only to the configured primary host, path and query kept).
- **Verify:** `pnpm --filter @velexis/ota-frontend test && pnpm --filter @velexis/ota-frontend build`

### OFE-022 · Write the live-mode and custom-domain storefront journey
- **Component:** ota-frontend
- **Milestone:** M5
- **Depends on:** OFE-021, OBE-083, OFE-019
- **Size:** M
- **Read first:** ota/frontend/README.md §13; platform/docs/plans/implementation-plan.md §4 (M5 demo); tools/e2e/README.md
- **Files:** `tools/e2e/specs/storefront/live-and-domains.e2e.ts`, `tools/e2e/support/ota.ts`
- **Steps:**
  1. Seed a tenant that goes live through the platform API (preconditions met with stub and Stripe test fixtures) and a verified custom domain served by `vite preview` under a second host name.
  2. Assert: no test banner after go-live, search uses the live connection (stub port of the live account), the custom host serves the same tenant, sign-in on the sub-domain redirects to the primary host, e-mail links use the primary host.
- **Acceptance:**
  - The journey passes nightly with the storefront guards on [OF-12 AC1].
- **Verify:** `E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/live-and-domains.e2e.ts`

## M6 — Hardening & launch

Security review, the PCI controls of the airline-card flow and the gate for live airline-card payments, the erasure job, performance, runbooks, complete end-to-end suites and the SDK's first npm release. Foundation tasks X-029 … X-032 (monitoring, on-VM checks, restore drill, managed-services proof) run in the same milestone.

### OBE-084 · Run the OTA backend security review and close the gaps
- **Component:** ota-backend
- **Milestone:** M6
- **Depends on:** OBE-075, OBE-083, OBE-052
- **Size:** L
- **Read first:** docs/mvp/conventions.md §12; ota/docs/architecture.md §8 and §9; docs/mvp/adr/0011-payments-stripe-and-airline-card.md (C); docs/mvp/adr/0016-observability.md (redaction); platform/docs/plans/agent-tasks.md (PBE-062, for the shared format)
- **Files:** `ota/docs/security-review.md`, `deploy/caddy/test/caddy-smoke.sh`, `ota/backend/test/integration/m6/auth-matrix.int.test.ts`, `ota/backend/test/integration/m6/rate-limits.int.test.ts`, `ota/backend/test/integration/m6/headers.int.test.ts`, `ota/backend/test/contract/redaction-coverage.contract.test.ts`
- **Steps:**
  1. Auth matrix: every operation of the operations index called with no credential, a wrong-tenant credential, a wrong-scope credential (edge, `pk_`, `sk_` storefront, `sk_` console, service key) and the right one; the result must match `x-scope`, `x-edge-only` and `x-permission`. Service key through Caddy: the service key with the `X-Forwarded-For` and `X-Forwarded-Host` headers that Caddy adds, as on `api.ota.example.com`, answers `401`, and with the edge headers as well, as through the storefront `/api/*`, answers `400`; `caddy-smoke.sh` asserts with an echo upstream that both routes really add `X-Forwarded-For` and drop a client-supplied `X-Velexis-Edge`.
  2. One test per rate limit of architecture §8, including `console.auth.signIn` per forwarded end-user IP through the service caller (two end-user IPs do not share a bucket, and a missing `X-Velexis-End-User-IP` with the service key answers 400); response headers (`helmet`, `Cache-Control` on personal data, `nosniff` on files and assets).
  3. Redaction coverage: every schema property marked `x-sensitive` or named in the central list is redacted in logs, `supplier_requests`, `staff_actions`, `idempotency_keys`, `payment_events` and `notifications`.
  4. Run `pnpm audit --prod` and a secret scan of the repository; write `ota/docs/security-review.md` (scope, method, findings with severity and status). Every high finding is fixed in this task or becomes a task in this plan before launch.
- **Acceptance:**
  - The auth matrix, rate-limit, header and redaction tests pass.
  - `security-review.md` lists no open high finding; `pnpm audit --prod` shows no high or critical issue.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- contract && pnpm --filter @velexis/ota-backend test:int -- m6 && bash deploy/caddy/test/caddy-smoke.sh && pnpm audit --prod`

### OFE-023 · Publish the storefront script inventory for the daily integrity check
- **Component:** ota-frontend
- **Milestone:** M6
- **Depends on:** OFE-014
- **Size:** S
- **Read first:** docs/mvp/plans/foundation-tasks.md (X-030 step 1, payment page check); ota/frontend/README.md §10 (script inventory); ota/docs/adr/0017-airline-card-form-isolation.md (point 8)
- **Files:** `ota/frontend/scripts/payment-page-inventory.mjs`, `ota/frontend/test/payment-page-inventory.test.js`, `ota/frontend/package.json`, `ota/frontend/README.md`
- **Steps:**
  1. After `vite build`, `payment-page-inventory.mjs` writes `dist/payment-page-inventory.json` for **every** HTML page of the build, not only the two payment pages: any script on the storefront origin could draw a look-alike card form or reach the card page, so all of them are in the PCI DSS 6.4.3 inventory (OADR-0017 point 8). Per page: the ordered `<script src>` list (hashed bundle paths, and the Stripe.js URL on `/checkout/pay-card.html`), the SHA-256 of each first-party script, and the expected security headers (CSP strings, and COOP and `Cache-Control` on the card page, from the Caddyfile). The two payment pages are flagged `payment: true`.
  2. The healthcheck of X-030 compares the live pages with this file (it fetches the two payment pages today; extending it to every page listed is a request to X-030's owner, recorded in the OTA ADR index); document the purpose of each script, Stripe.js included with its justification, in README §10.
- **Acceptance:**
  - The inventory lists every built page; exactly two scripts for the card page and one for the airline-card page, and no third-party script on any other page; a test fails if a third-party script or an unlisted page appears.
  - The file is part of the release artefact (`dist/`).
- **Verify:** `pnpm --filter @velexis/ota-frontend build && pnpm --filter @velexis/ota-frontend test`

### OBE-085 · Write the PCI evidence pack for the airline-card path
- **Component:** ota-backend
- **Milestone:** M6
- **Depends on:** OBE-052, OFE-023
- **Size:** M
- **Read first:** docs/mvp/adr/0011-payments-stripe-and-airline-card.md (C, Documentation row); ota/docs/adr/0004-airline-card-data-handling.md; ota/docs/adr/0017-airline-card-form-isolation.md; docs/mvp/deployment-single-vm.md §2 (hardening)
- **Files:** `ota/docs/pci/README.md`, `ota/docs/pci/data-flow.md`, `ota/docs/pci/script-inventory.md`, `ota/docs/pci/incident-response.md`, `ota/docs/pci/responsibility-matrix.md`, `ota/docs/README.md`
- **Steps:**
  1. `data-flow.md`: a Mermaid diagram of the card from the storefront page through Caddy, the OTA API process and the Amadeus client, with what exists where (memory only) and the controls of ADR-0011 §C mapped to code, tests and VM settings (`LimitCORE=0`, no swap, `auditd`, AIDE).
  2. `script-inventory.md` (from OFE-023: every storefront page, Stripe.js with its justification, and the residual risk of OADR-0017: a script on any page of the origin could imitate the card form; COOP, `frame-ancestors 'none'` and `worker-src 'none'` stop it from reading the real one), `incident-response.md` (detection, containment, Stripe and Amadeus contacts, OTA notification), `responsibility-matrix.md` (Velexis versus OTA for each PCI DSS v4.0.1 requirement relevant to SAQ D for service providers).
  3. Link the pack from the OTA docs index.
- **Acceptance:**
  - Every control row of ADR-0011 §C points to a test, a file or a VM check that exists.
  - The developer reviews the pack and records the review date in `ota/docs/pci/README.md`.
- **Verify:** `test -f ota/docs/pci/data-flow.md && test -f ota/docs/pci/responsibility-matrix.md && test -f ota/docs/pci/incident-response.md`

### OBE-086 · Gate live airline-card payments on the review and the penetration test
- **Component:** ota-backend
- **Milestone:** M6
- **Depends on:** OBE-084, OBE-085, X-030
- **Size:** S
- **Read first:** ota/docs/adr/0004-airline-card-data-handling.md (point 1, Follow-ups); ota/docs/adr/0017-airline-card-form-isolation.md (Follow-ups); docs/mvp/adr/0011-payments-stripe-and-airline-card.md (Vulnerability management)
- **Files:** `ota/docs/pci/README.md`, `ota/docs/runbooks/airline-card-go-live.md`, `deploy/env/ota-backend.env.example`
- **Steps:**
  1. Human step: commission the penetration test and an external ASV scan of the storefront hosts and `api.ota.example.com`; record dates, scope and results in `ota/docs/pci/README.md`; fix or plan every finding.
  2. Write `airline-card-go-live.md`: the checklist (security review closed, PCI pack reviewed, X-030 payment-page check green for 7 days, penetration test passed), then set `AIRLINE_CARD_ENABLED=true` in `/etc/velexis/ota-backend.env`, restart, and only then may OTAs set `airlineCard.enabledLive`.
  3. Update the comment of `AIRLINE_CARD_ENABLED` in the env template to point at the runbook.
- **Acceptance:**
  - The runbook exists and every precondition is checked with its evidence linked (human sign-off in the PR).
  - Until then, `AIRLINE_CARD_ENABLED` stays `false` in production (the PR shows the current value).
- **Verify:** `test -f ota/docs/runbooks/airline-card-go-live.md && grep -q AIRLINE_CARD_ENABLED deploy/env/ota-backend.env.example`

### OBE-087 · Add the 30-day customer erasure job
- **Component:** ota-backend
- **Milestone:** M6
- **Depends on:** OBE-035, OBE-056
- **Size:** M
- **Read first:** docs/velexis-sdk/db/README.md §7 (deletion and erasure); ota/docs/data-model.md §6; ota/docs/scope.md §3.1 (`account.delete`)
- **Files:** `ota/backend/src/account/erasure.processor.ts`, `ota/backend/src/account/erasure.service.ts`, `ota/backend/src/account/erasure.service.test.ts`, `ota/backend/src/jobs/schedulers.ts`, `ota/backend/test/integration/account/erasure.int.test.ts`
- **Steps:**
  1. `customers.erase` (daily) per tenant: customers soft-deleted more than 30 days ago are anonymised as db README §7 describes (identity, consents, sessions, saved data removed; bookings keep the financial record with traveller data anonymised where the law allows; `customer_id` detached).
  2. Idempotent and batched (100 customers per job); an audit `booking_events` or log entry per erasure without personal data.
- **Acceptance:**
  - A customer deleted 31 days ago (FakeClock) is anonymised; one deleted 29 days ago is untouched.
  - Bookings, payments and refunds keep their amounts and references after erasure.
- **Verify:** `pnpm --filter @velexis/ota-backend test -- account && pnpm --filter @velexis/ota-backend test:int -- account`

### OBE-088 · Measure OTA performance and memory against the VM budget
- **Component:** ota-backend
- **Milestone:** M6
- **Depends on:** OBE-028, OBE-075
- **Size:** M
- **Read first:** docs/mvp/architecture.md §3 (memory budget); ota/docs/adr/0014-per-tenant-workers-and-schedulers.md (Follow-ups); ota/docs/performance.md; platform/docs/plans/agent-tasks.md (PBE-063)
- **Files:** `ota/backend/test/load/booking-load.mjs`, `ota/backend/test/load/search-load.mjs`, `ota/docs/performance.md`
- **Steps:**
  1. Extend the load scripts: mixed traffic on 5 tenants (searches, prices, checkouts paid by airline card against the stub, console list calls) for 30 minutes while the worker runs ticketing, sync and notifications.
  2. Measure p95 per operation, API and worker RSS against 768 MB and 512 MB, PostgreSQL connections, Redis memory, and queue latency per queue.
  3. Record results in `performance.md`; split the worker into booking-critical and housekeeping processes only if queue latency shows one blocks the other (OADR-0014 follow-up) — as a new task.
- **Acceptance:**
  - API and worker RSS stay within their `MemoryMax`; queue latency for `ota-ticketing` and `ota-bookings` stays under 60 s at the tested load, or follow-up tasks are added before launch.
- **Verify:** `node ota/backend/test/load/booking-load.mjs --tenants 5 --minutes 30`

### OBE-089 · Write the OTA operations runbooks and launch checklist
- **Component:** ota-backend
- **Milestone:** M6
- **Depends on:** OBE-084
- **Size:** M
- **Read first:** docs/mvp/deployment-single-vm.md (operations); ota/docs/architecture.md §10; ota/docs/architecture-booking.md §4; ota/docs/flows/ticketing-and-documents.md §4; platform/docs/plans/agent-tasks.md (PBE-065)
- **Files:** `ota/docs/runbooks/README.md`, `ota/docs/runbooks/supplier-timeout-and-reconciliation.md`, `ota/docs/runbooks/ticketing-failures.md`, `ota/docs/runbooks/stripe-incidents.md`, `ota/docs/runbooks/tenant-migration-failures.md`, `ota/docs/runbooks/launch-checklist.md`, `ota/docs/README.md`
- **Steps:**
  1. One runbook per incident class: Amadeus slow or down and orphan PNRs, ticketing given up, manual-review airline-card bookings, Stripe down or webhook backlog, tenant migration failures in the fan-out, Redis loss (staff sign in again).
  2. Launch checklist: SDK published (SDK-015), airline card still off unless OBE-086 is done, live Stripe keys present, booking queue confirmed per shared office, nightly suites green three times, monitoring (X-029, X-030) and restore drill (X-031) done.
  3. Link the runbooks from the OTA docs index.
- **Acceptance:**
  - Each runbook names the signals (logs, `/health/ready`, console views), the commands and the escalation; the developer walks through the checklist and records the date.
- **Verify:** `test -f ota/docs/runbooks/launch-checklist.md && test -f ota/docs/runbooks/supplier-timeout-and-reconciliation.md`

### OFE-024 · Run the accessibility and performance pass on the storefront
- **Component:** ota-frontend
- **Milestone:** M6
- **Depends on:** OFE-019, OFE-020
- **Size:** M
- **Read first:** ota/frontend/README.md §8 and §9; docs/mvp/conventions.md §4 (Accessibility)
- **Files:** `ota/docs/storefront-accessibility.md`, `tools/e2e/specs/storefront/a11y-pages.e2e.ts`, `ota/frontend/scripts/check-budgets.mjs`
- **Steps:**
  1. axe on every page in every main state (including error states) in one spec; a manual screen-reader pass (NVDA and VoiceOver) through search and checkout; record findings and fixes in `storefront-accessibility.md`.
  2. Lighthouse mobile runs on home and results against `vite preview`: LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms; record the figures; add the font budget (≤ 2 families, ≤ 120 KB per page) to the budget script.
- **Acceptance:**
  - No serious or critical axe violation on any page; the manual pass is recorded with its date.
  - The Lighthouse targets are met or have follow-up tasks.
- **Verify:** `pnpm --filter @velexis/ota-frontend build && E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/a11y-pages.e2e.ts`

### OFE-025 · Finalise the build-your-own-frontend guide
- **Component:** ota-frontend
- **Milestone:** M6
- **Depends on:** SDK-014, OFE-019
- **Size:** M
- **Read first:** ota/frontend/docs/build-your-own-frontend.md (outline); ota/sdk/README.md §4.2, §4.3, §9; docs/velexis-sdk/sdk/docs/B1.md … B4.md; docs/mvp/decisions.md §2 (OTA storefront hosting)
- **Files:** `ota/frontend/docs/build-your-own-frontend.md`, `ota/sdk/README.md`
- **Steps:**
  1. Turn the outline into the guide: keys and origins from the portal, token mode in the browser versus a small own server with `sk_` keys and httpOnly cookies, CORS origins, Stripe.js with `accountId` in Connect mode, what is not available (airline card, cookie mode), errors and retries, pagination, idempotency keys for `checkout.complete`.
  2. Code samples in plain HTML with the IIFE and in a bundler with the ESM build, using placeholder hosts only; point to the hosted storefront's source as the reference implementation.
- **Acceptance:**
  - Every code sample runs against the local stack with the `dev:seed` `pk_test` key (checked by hand, recorded in the PR).
  - The guide uses only the placeholder hosts of `decisions.md` §4.
- **Verify:** `grep -c "api.ota.example.com" ota/frontend/docs/build-your-own-frontend.md`

### OAD-019 · Complete the OTA admin suite with accessibility and header checks
- **Component:** ota-admin
- **Milestone:** M6
- **Depends on:** OAD-017, OAD-018
- **Size:** M
- **Read first:** ota/admin/README.md §10 and §12; platform/docs/plans/agent-tasks.md (PAD-016, for the shared checks)
- **Files:** `tools/e2e/specs/ota-admin/a11y-headers.e2e.ts`, `tools/e2e/specs/ota-admin/session-expiry.e2e.ts`
- **Steps:**
  1. axe on every route; headers on every route (CSP with nonce, `frame-ancestors 'none'`, referrer policy, no `X-Powered-By`); no `NEXT_PUBLIC_` value and no token in any HTML or JS response.
  2. Session expiry: the access cookie expires mid-session and the next navigation refreshes once; a removed member is signed out within 60 seconds; "sign out everywhere" in the portal ends the admin session.
- **Acceptance:**
  - Both specs pass nightly three times in a row before launch.
- **Verify:** `E2E_WITH_OTA=1 pnpm test:e2e -- --project=ota-admin specs/ota-admin/a11y-headers.e2e.ts specs/ota-admin/session-expiry.e2e.ts`

### SDK-015 · Publish @velexis/ota-sdk 1.0.0 to npm
- **Component:** ota-sdk
- **Milestone:** M6
- **Depends on:** SDK-014, OBE-084
- **Size:** M
- **Read first:** ota/docs/adr/0016-sdk-packaging-and-type-contract.md (points 7, 8); ota/sdk/README.md §9; ota/sdk/docs/types-and-builds.md §6
- **Files:** `.github/workflows/sdk-publish.yml`, `ota/sdk/scripts/build.mjs`, `ota/sdk/package.json`, `ota/sdk/src/version.js`, `ota/sdk/CHANGELOG.md`, `ota/sdk/README.md`
- **Steps:**
  1. `build.mjs` copies the OTA part of `@velexis/api-types` into `dist/types/api-types.d.ts` and rewrites the import specifier, so the published package has no dependencies, not even for types.
  2. `sdk-publish.yml`: manual workflow on a tag `sdk-vX.Y.Z`; build, contract test, size check, `npm publish --provenance`; release notes with the SRI hash of the IIFE.
  3. Human step: create the npm organisation and the automation token as a GitHub secret; set version `1.0.0`, write the CHANGELOG, tag and run the workflow.
- **Acceptance:**
  - `npm pack` produces a package whose `dist/types` compile in an empty project without `@velexis/api-types` installed (test in CI).
  - The 1.0.0 release exists with provenance (human step recorded in the PR).
- **Verify:** `pnpm --filter @velexis/ota-sdk build && cd ota/sdk && npm pack --dry-run`

### OFE-026 · Make the storefront and OTA admin suites nightly and stable
- **Component:** ota-frontend
- **Milestone:** M6
- **Depends on:** OFE-024, OAD-019, OFE-022
- **Size:** S
- **Read first:** docs/mvp/adr/0015-testing-strategy.md (CI); tools/e2e/README.md; platform/docs/plans/agent-tasks.md (PFE-028)
- **Files:** `.github/workflows/e2e.yml`, `tools/e2e/README.md`, `tools/e2e/playwright.config.ts`
- **Steps:**
  1. Run `storefront`, `storefront-stripe` and `ota-admin` nightly and before each deploy; upload traces on failure; quarantine nothing (a flaky test is fixed, not skipped).
  2. Record three consecutive green nightly runs (links in the README) as a launch gate.
- **Acceptance:**
  - Three consecutive green nightly runs of the three OTA projects are linked in `tools/e2e/README.md`.
- **Verify:** `E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront --project=ota-admin`

## Cross-group dependencies at a glance

| OTA task | Needs | Why |
|---|---|---|
| OBE-002 | PBE-004 | `tenant.*` job and invalidation schemas |
| OBE-003, OBE-012 | PBE-002 | Platform `0002` columns (`storefront_environment`, Amadeus accounts and offices, payment `account_mode`) and their read grants |
| OBE-007 | PBE-034 | The platform `dev:seed` creates the Velexis test Amadeus account and offices |
| OBE-007 | X-023, X-033 | `deploy.sh` with its `deploy.test.sh`, and the `velexis-run` wrapper that runs `tenants:report-migrations` as the OTA zone user after the fan-out |
| OFE-008, OAD-016 | PFE-014 | The `tools/e2e` harness |
| OAD-016 | PFE-017 | The portal's "Open console" hand-off |
| OBE-083 | PBE-053, PBE-055, PBE-057, PBE-061 | Own Amadeus credentials, Connect, API-key connections, go-live |

| Platform task | Gated on OTA feature | Delivered by |
|---|---|---|
| PBE-035 | OF-11 | OBE-005, OBE-006 (worker build from OBE-001) |
| PBE-036, PAD-011 | OF-01 | OBE-011, OBE-012, OBE-013, OBE-016, OFE-008 |
| PFE-019 | OF-09 | OBE-059, OAD-003, OAD-016 |
| M5 switches on | OF-12 | OBE-076 … OBE-083 |
