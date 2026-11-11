# ADR-0015: Testing strategy

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Lead architect. Decided during planning; revisit when CI time on a pull request exceeds 15 minutes or flaky tests exceed 1 % of runs.
**Revisions:** 2026-10-12 (planning review): the Amadeus stub arrives in M1 (X-026, X-027), because PBE-020 and the M1 end-to-end harness use it; recording and the fixture scan are task X-034 (M2). 2026-11-06 (lead decision (11f) of 2026-11-06, recording PBE-070 and FIX-W46-SHARED): the tools of the test-level table run on Vitest 4.1.12, happy-dom 21.0.4 and Redocly CLI 2.76.0, and the root Vitest file is the projects config `vitest.config.ts` (dated note under Test levels). 2026-11-11 (lead decision (15c) of 2026-11-11, approved by the owner, recording FIX-W48-SHARED): the end-to-end run "before deploy" is enforced: `deploy.yml` calls `e2e.yml` for the commit it deploys and deploys only after it is green; traces are also uploaded when a run is cancelled (dated note under CI).

## Context

AI agents write most of the code. Tests are the main proof that a task is done, and the main protection against an agent breaking someone else's work. The system has three external dependencies that cannot be called freely in tests:

- Amadeus (quota, test data that changes);
- Stripe (network, webhooks);
- SMTP.

There are also two contracts that must not drift: the OpenAPI documents and the SDK declarations in [`docs/velexis-sdk/sdk/src/`](../../velexis-sdk/sdk/src/).

## Decision

### Test levels

| Level | Tool | Scope | Runs | File naming |
|---|---|---|---|---|
| **Unit** | Vitest 3 | Pure logic: pricing and markups, redaction, crypto, mappers, SDK request building, storefront formatting | Every PR | `*.test.ts` / `*.test.js` next to the source |
| **Integration** | Vitest + Supertest | One backend over HTTP with real PostgreSQL 16 and Redis 7, the Amadeus stub, Stripe mocked at the HTTP boundary, Mailpit or an in-memory mail transport | Every PR | `test/integration/**/*.int.test.ts` |
| **Contract** | Vitest + Ajv, `tsc` | Responses against the OpenAPI document, route parity, SDK declarations against the contract `.d.ts`, generated types up to date | Every PR | `test/contract/**/*.contract.test.ts` |
| **Component (UI)** | Vitest + Testing Library (Next.js apps), Vitest + happy-dom (storefront modules) | Client components, form state, DOM rendering helpers | Every PR | `*.test.tsx` / `*.test.js` |
| **End-to-end** | Playwright | Full stack built and started locally: sign-up → create OTA → storefront search → book → OTA admin actions | Nightly, before deploy, and on PRs labelled `e2e` | `tools/e2e/specs/**/*.e2e.ts` |

**2026-11-06 (lead decision (11f) of 2026-11-06; PBE-070, FIX-W46-SHARED):** the table's tools run on these releases, pinned exactly in every package that uses them ([`../tech-stack.md`](../tech-stack.md) holds the rows):

| Tool | Release | Where | Since |
|---|---|---|---|
| Vitest | **4.1.12** (the unit row's "Vitest 3" reads Vitest 4) | Every package and the root | PBE-070 (3.x carried Tinypool 1.1.1, security review F-5) |
| happy-dom | **21.0.4** | The DOM tests of the storefront and the SDK, and the component tests of the portal and both admins (`// @vitest-environment happy-dom`) | PBE-070 |
| Redocly CLI | **2.76.0** | `pnpm contracts:lint` in `@velexis/api-types` (the OpenAPI documents of the contract-test row) | PBE-070 |

Vitest 4 reads no workspace file, so the root file that lists every package's Vitest config as a project for editors and ad-hoc runs is `vitest.config.ts` (`test.projects`, run with `--config vitest.config.ts --project <name>`; [ADR-0002](0002-monorepo-pnpm-turborepo.md) item 6). CI still runs the tests per package through Turborepo.

**Target mix:** many unit tests, a solid integration layer for every endpoint, and a few end-to-end journeys (one per milestone's main flow). There is no coverage percentage gate. Instead, **every acceptance criterion in a plan task maps to at least one test**, and the PR lists which.

### Dependencies in tests

- **PostgreSQL and Redis are real.** Integration tests create a fresh database per test file from the migrations: platform, reference and two tenant schemas, `tenant_alpha` and `tenant_beta`. Each test runs inside a transaction that is rolled back, or truncates touched tables. Redis uses a per-worker database index and `FLUSHDB`.
- **Tenant isolation test (mandatory):** every repository suite for tenant data runs its main query for `tenant_alpha` and asserts that no `tenant_beta` row appears. A dedicated test runs two tenants concurrently through a pool of size 1 ([ADR-0004](0004-postgresql-schema-per-tenant.md)).
- **Amadeus stub server** (`tools/amadeus-stub`):
  - A small Node HTTP server implementing the OAuth token endpoint and the 12 operations.
  - Responses come from **recorded fixtures**: captured once from the Amadeus test environment, scrubbed of personal data, stored as JSON under `tools/amadeus-stub/fixtures/`.
  - Scenarios are selected by a request header in tests (`X-Stub-Scenario: sold-out`), or by magic values for end-to-end runs (for example, the destination `ZZZ` returns no offers).
  - Covered scenarios: success, sold out, price changed, ticketing failure (9112), version conflict (2552), 5xx, timeout.
  - Requests are validated against the Amadeus specifications in [`docs/amadeus-api/`](../../amadeus-api/), so a malformed request from our client fails the test.
- **Recording new fixtures:** `pnpm --filter @velexis/amadeus-stub record <operation>` runs against the real test environment with credentials from the developer's local environment, then scrubs the output. It is never run in CI.
- **Stripe:**
  - Unit and integration tests mock the Stripe HTTP API at the boundary.
  - Webhook tests send **signed fixture events** built with `stripe.webhooks.generateTestHeaderString`.
  - End-to-end runs use **Stripe test mode** with test cards (including 3-D Secure cards) and `stripe listen --forward-to` for webhooks.
- **E-mail:** integration and end-to-end tests send to **Mailpit** and assert through its API (recipient, subject, links). No real SMTP in tests.
- **Time:** code takes a `Clock` dependency. Tests use fake timers. Ticketing deadlines and token expiry are tested this way.

### Contract tests

- **OpenAPI conformance:** a helper `expectResponseToMatch(operationId, res)` validates status and body against the document with Ajv. Every integration test that calls an endpoint uses it.
- **Route parity and error catalogue:** see [ADR-0006](0006-contract-first-openapi.md).
- **SDK contract:** `ota/sdk/test/contract/` holds a `tsc --noEmit` project that imports the SDK's emitted `.d.ts` and the contract declarations, and asserts assignability in both directions for `createVelexisClient`, every namespace interface and every error class ([ADR-0019](0019-vanilla-js-sdk-jsdoc.md)).

### Rules for agents

- **Never weaken a test to make it pass**: no deleting, skipping (`.skip`, `.only` left in), loosening assertions or raising timeouts without a reason written in the PR. CI fails on `.only` and on new `.skip` without a linked issue.
- A bug fix starts with a failing test that reproduces it.
- Tests are deterministic: no real network, no sleeping (use fake timers or polling helpers), and no dependency on test order.

### CI

- `ci.yml` on every PR: install, lint, typecheck, unit, integration (PostgreSQL 16 and Redis 7 service containers), contract, build, plan-lint.
- `e2e.yml`: nightly and on demand.
- Playwright traces and screenshots are uploaded on failure.

*Note (2026-11-11, lead decision (15c), FIX-W48-SHARED).* `e2e.yml` also runs on pull requests labelled `e2e` and, called by `deploy.yml` (`workflow_call`), for the commit being deployed: Deploy's `deploy` job needs that run, so nothing is deployed before a green end-to-end run of the same commit (the "before deploy" of the test-level table). Traces, screenshots, reports and the stack's logs are uploaded on failure or cancellation, each Playwright step in a folder of its own ([`tools/e2e/README.md`](../../../tools/e2e/README.md), CI).

## Consequences

### Positive

- Agents get fast, local, deterministic feedback that does not depend on Amadeus quota or network.
- Contract drift between the API, its document and the SDK is caught on every PR.
- Isolation tests make the schema-per-tenant guarantee executable.

### Negative

- Recorded fixtures go stale when Amadeus changes. A monthly manual run against the real test environment (`pnpm test:amadeus-live`) detects it.
- Real PostgreSQL in integration tests is slower than mocks. Running files in parallel with separate databases keeps it acceptable.

### Follow-ups

- M0 sets up Vitest, the integration harness (database per test file, two tenant schemas) and CI. M1 adds the Amadeus stub (X-026, X-027) and the Playwright harness (PFE-014); M2 adds fixture recording and the personal-data scan (X-034). M3 adds Stripe fixtures. M6 completes the end-to-end suite.

## Alternatives considered

- **Mocking the database.** Would not catch SQL, `search_path` or constraint errors, which are exactly the risky parts.
- **Calling the Amadeus test environment in CI.** Slow, rate limited and non-deterministic.
- **Jest.** Vitest is faster, ESM-friendly and shares configuration with Vite.
- **Cypress.** Playwright handles several origins (portal, OTA admin, storefront), Stripe iframes and parallel runs better.

## References

- [ADR-0006](0006-contract-first-openapi.md), [ADR-0012](0012-amadeus-account-model.md), [ADR-0019](0019-vanilla-js-sdk-jsdoc.md)
- [`../conventions.md`](../conventions.md) (testing section), [`../../../AGENTS.md`](../../../AGENTS.md)
- [`../../amadeus-api/`](../../amadeus-api/)
