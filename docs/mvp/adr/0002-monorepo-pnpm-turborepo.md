# ADR-0002: Monorepo with pnpm workspaces and Turborepo

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (one repository, shared libraries), lead architect (tooling)
**Revisions:** 2026-10-12 (planning review): the table lists `@velexis/testing` ([ADR-0022](0022-shared-test-support-package.md)) and `@velexis/reference-data` ([ADR-0024](0024-reference-data-sources-and-loader.md)); 17 workspace packages.

## Context

[`decisions.md`](../decisions.md) §1–§2 fix one repository with six components in two groups (`platform/`, `ota/`), a JS SDK (`ota/sdk`), shared TypeScript libraries (`packages/`) and deployment files (`deploy/`). A single change often spans several of them: an OpenAPI change, the generated types, the backend handler, the SDK method and the storefront page. The developer and the agents need one install, one command set and fast, cached builds.

## Decision

1. **pnpm 9 workspaces.** `pnpm-workspace.yaml` lists `platform/*`, `ota/*`, `packages/*` and `tools/*`. The root `package.json` pins `"packageManager": "pnpm@9.x"` (exact version) and `engines.node` `>=22 <23`. `.nvmrc` holds `22`. One `pnpm-lock.yaml` at the root.
2. **Turborepo 2** runs the tasks `build`, `dev`, `lint`, `typecheck`, `test`, `test:int` and `generate` across packages, with `dependsOn: ["^build"]` where a package needs its dependencies built first. Local caching is on; remote caching is off in the MVP.
3. **Workspace layout and package names:**

   | Directory | Package name | Kind |
   |---|---|---|
   | `platform/backend` | `@velexis/platform-backend` | NestJS app |
   | `platform/frontend` | `@velexis/platform-frontend` | Next.js app (portal) |
   | `platform/admin` | `@velexis/platform-admin` | Next.js app |
   | `ota/backend` | `@velexis/ota-backend` | NestJS app |
   | `ota/frontend` | `@velexis/ota-frontend` | Vanilla HTML/JS storefront (Vite build) |
   | `ota/admin` | `@velexis/ota-admin` | Next.js app |
   | `ota/sdk` | `@velexis/ota-sdk` | Vanilla JS library |
   | `packages/config` | `@velexis/config` | Typed environment loading and validation |
   | `packages/logger` | `@velexis/logger` | pino setup, redaction list |
   | `packages/db` | `@velexis/db` | Kysely, pools, tenant transactions, migration runner, generated table types |
   | `packages/crypto` | `@velexis/crypto` | Envelope encryption, HMAC, token hashing, key providers |
   | `packages/errors` | `@velexis/errors` | Error codes and the `AppError` class |
   | `packages/api-types` | `@velexis/api-types` | Types generated from both OpenAPI documents, plus queue message contracts |
   | `packages/testing` | `@velexis/testing` | Test support: test databases, Redis, clock, response checks, Mailpit, Stripe and Amadeus stub helpers. **devDependency only** |
   | `tools/reference-data` | `@velexis/reference-data` | Vendored reference datasets and their loader CLI, shipped in releases |
   | `tools/amadeus-stub` | `@velexis/amadeus-stub` | Amadeus stub server for dev and tests (devDependency only) |
   | `tools/e2e` | `@velexis/e2e` | Playwright end-to-end suite |

   That is 17 workspace packages. `tools/plan-lint` stays a plain script with no `package.json`.
4. **Module format.**
   - Backends and the Node-side shared packages are TypeScript compiled by `tsc` to **CommonJS** in `dist/`, with declarations. This is the path NestJS supports best.
   - The SDK and the storefront are **ES modules**.
   - Next.js apps use their own bundler and consume the shared packages' `dist/`.
   - `@velexis/api-types` is mostly type-only, so it works from both module systems.
5. **Dependency rules**, enforced by ESLint `no-restricted-imports` and by the `dependencies` of each `package.json`:
   - Apps may depend on `packages/*`. Packages never depend on apps.
   - `platform/*` never imports from `ota/*` and the reverse. They share only `packages/*`.
   - The OTA admin and the storefront reach the OTA backend only through `@velexis/ota-sdk`.
   - The SDK has **no runtime dependencies**. It may use `@velexis/api-types` for types only.
6. **Shared root configuration files:** `tsconfig.base.json`, `eslint.config.mjs` (flat config), `.prettierrc.json`, `.editorconfig`, `vitest.workspace.ts`, `.env.example`. Packages extend them instead of copying them. There are no separate config packages.
7. **Versions** are exact in `package.json` (no `^`). Dependabot opens weekly grouped update PRs. [`../tech-stack.md`](../tech-stack.md) lists the versions.

## Consequences

### Positive

- One clone, one `pnpm install` and one set of commands for every component.
- Atomic pull requests across a contract, its implementation and its consumers.
- Turborepo only rebuilds what changed, which keeps agent feedback loops short.

### Negative

- Shared packages must be built before the apps that import them. Turborepo handles the order, but a stale `dist/` can confuse a manual run, so `pnpm build` first.
- CommonJS for the backends and ESM for the SDK and storefront is two module systems. The boundary is clear (Node services against browser code), and Node 22 can `require()` ES modules if needed.

### Follow-ups

- Decided during planning; revisit the module format when NestJS ships first-class ESM support, and remote caching when CI time exceeds 10 minutes.

## Alternatives considered

- **Nx.** More powerful generators and graph rules, but heavier to learn and configure. Turborepo is enough for 17 packages.
- **npm or Yarn workspaces.** pnpm is faster, stricter about phantom dependencies and has `pnpm deploy` for building self-contained app folders ([ADR-0007](0007-single-vm-without-docker.md)).
- **Several repositories.** Cross-component changes would need coordinated releases. That is too much overhead for one developer.
- **ESM everywhere.** Possible with NestJS 11 but less trodden. Agents make fewer mistakes on the default CommonJS setup.

## References

- [`../decisions.md`](../decisions.md) §1, §2
- [ADR-0003](0003-six-components-two-nestjs-backends.md), [ADR-0006](0006-contract-first-openapi.md), [ADR-0019](0019-vanilla-js-sdk-jsdoc.md)
- [`../tech-stack.md`](../tech-stack.md), [`../conventions.md`](../conventions.md)
