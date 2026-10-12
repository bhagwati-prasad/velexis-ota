# ADR-0022: Shared test-support package `@velexis/testing`

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform/DevOps engineer (foundation plan). Decided during planning; revisit when the package grows beyond test helpers, or when the two backends need test tooling that cannot be shared.

## Context

[ADR-0015](0015-testing-strategy.md) asks for the same test machinery in every backend and in `@velexis/db`:

- a fresh database per test file, built from the real migrations, with two tenant schemas (`tenant_alpha`, `tenant_beta`) for isolation tests;
- Redis with a per-worker database index;
- Mailpit assertions, signed Stripe webhook events, the Amadeus stub with scenarios;
- Ajv response checks against the OpenAPI documents (`expectResponseToMatch`), and a fake clock.

[ADR-0002](0002-monorepo-pnpm-turborepo.md) lists the workspace packages but has no place for these helpers. If each app writes its own, the platform and OTA suites drift, and agents copy code between them.

## Decision

1. Add **`packages/testing`**, published in the workspace as **`@velexis/testing`**. It follows the rules of every shared package ([`packages/README.md`](../../../packages/README.md)).
2. It is a **devDependency only**. No package or app may list it in `dependencies`; CI checks the `package.json` files (task X-019), and the release packer would fail anyway because `pnpm deploy --prod` leaves dev dependencies out.
3. **Subpaths:** `.` (test databases, Redis, clock, builders, `expectResponseToMatch`), `./vitest-global-setup`, `./mailpit`, `./stripe`, `./amadeus`.
4. **Test databases** use a migrated **template**:
   - the Vitest global setup creates `velexis_test_tpl_<run>` once, as `velexis_test_admin`, and migrates it with the real runner ([ADR-0021](0021-migration-cli-and-repeatable-grants.md));
   - each test file clones it with `CREATE DATABASE … TEMPLATE …` and drops it afterwards.

   `velexis_test_admin` is a local and CI-only role with `CREATEDB` and membership in `velexis_migrator`. It is created by `dev-setup.sh` and the CI workflow, never on the VM.
5. The **Amadeus stub server** stays in `tools/amadeus-stub` (`@velexis/amadeus-stub`, ADR-0015). `@velexis/testing/amadeus` only starts it in-process and builds scenario headers.
6. The OpenAPI contract types package keeps the name **`@velexis/api-types`** ([ADR-0006](0006-contract-first-openapi.md)). The SDK contract already imports that module name, so the planning brief's working name "`@velexis/contracts`" is not used.

## Consequences

### Positive

- Isolation tests, response conformance checks and fixtures behave the same in both backends.
- Cloning a template database takes about 100 ms, instead of seconds to migrate, so integration test files can run in parallel.
- One place to fix a flaky helper.

### Negative

- One more workspace package (16 in total) to build before tests run. Turborepo caches it.
- The template approach needs the `CREATEDB` test role, which differs slightly from production privileges. The application roles themselves are the production ones.

### Follow-ups

- X-015 creates the package (databases, Redis, clock, builders, Ajv helper). X-025, X-027 and X-028 add the Mailpit, Amadeus and Stripe helpers when their milestones need them.

## Alternatives considered

- **Helpers inside each backend's `test/` folder.** Duplicated and drifting; packages such as `@velexis/db` could not use them.
- **Testcontainers.** Needs Docker on developer machines, while the project uses native services everywhere ([ADR-0007](0007-single-vm-without-docker.md)).
- **One shared database with transactions rolled back per test.** Fast, but it cannot test code that commits, such as outbox and provisioning jobs, or `search_path` across pooled connections.

## References

- [ADR-0002](0002-monorepo-pnpm-turborepo.md), [ADR-0015](0015-testing-strategy.md), [ADR-0021](0021-migration-cli-and-repeatable-grants.md)
- [`../../../packages/README.md`](../../../packages/README.md), [`../local-development.md`](../local-development.md) §7
