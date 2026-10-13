# AGENTS.md: operating manual for AI coding agents

This file tells an AI coding agent how to work in the Velexis repository:

- what to read, and in which order;
- how to pick the next task from the plans;
- how to do it in one branch and one pull request;
- what "done" means;
- the rules that are never broken (contracts first, tests never weakened, no secrets, no card data or tokens in logs, tenant isolation);
- the commands to use.

Humans should read it too. It is the short version of [`docs/mvp/conventions.md`](docs/mvp/conventions.md) and [ADR-0020](docs/mvp/adr/0020-ai-agent-development-workflow.md).

## 1. The project in five lines

Velexis is a multi-tenant OTA platform. A person signs up on the **portal**, subscribes, and gets their own **OTA** (a tenant with its own PostgreSQL schema `tenant_<key>`). The OTA sells **Amadeus Enterprise** flights through a hosted **storefront** and runs operations in the **OTA admin**. There are six components in two groups (`platform/`, `ota/`), a vanilla JS **SDK** (`ota/sdk`), shared packages (`packages/`), and everything runs on **one VM without Docker**.

Status: **planning is done, implementation starts with milestone M0.**

## 2. Read order

Read these before your first change in a session:

1. **This file.**
2. [`docs/mvp/decisions.md`](docs/mvp/decisions.md): the product owner's decisions. **They win over everything.**
3. [`docs/mvp/README.md`](docs/mvp/README.md): the document index and the shared milestones M0–M6.
4. [`docs/mvp/architecture.md`](docs/mvp/architecture.md): components, ports, data ownership, request flows.
5. [`docs/mvp/conventions.md`](docs/mvp/conventions.md): how code is organised and written.
6. Your task's **Read first** list, and the ADRs it names ([`docs/mvp/adr/`](docs/mvp/adr/README.md)).
7. Only then the code you will touch.

**Reference material: search it, do not read it whole.**

| File | Size | Use it for |
|---|---|---|
| `docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml` | ~40k lines | Grep for the `operationId` or `x-sdk-method` you implement, then read that operation and its schemas |
| `docs/velexis-sdk/sdk/src/api-types.d.ts` | ~16k lines | Generated types. Grep for the schema name. |
| `docs/velexis-sdk/sdk/src/*.d.ts` (other files) | 60–1,650 lines | The SDK contract. Read the namespace you implement. |
| `docs/velexis-sdk/db/README.md` | 45 KB | Tenancy design. Read the section your task names. |
| `docs/velexis-sdk/db/*.sql`, `dictionary.json` | large | Grep for the table |
| `docs/amadeus-api/*.json` | 20–540 KB each | Grep for the path or schema |
| `docs/ota-build/*.html`, `docs/ota-architecture-review.html`, `docs/velexis-sdk/*.html` | very large | Background only. Do not load. |

## 3. Picking the next task

The plans are Markdown files of task blocks (`### OBE-014 · Title` with Component, Milestone, Depends on, Size, Read first, Files, Steps, Acceptance, Verify):

- `docs/mvp/plans/foundation-tasks.md`: `X-` tasks (M0 and shared work)
- `platform/docs/plans/agent-tasks.md`: `PBE-`, `PFE-`, `PAD-`
- `ota/docs/plans/agent-tasks.md`: `OBE-`, `OFE-`, `OAD-`, `SDK-`

If you were given a task id, do that task. Otherwise pick one like this:

1. Take the **lowest milestone** that still has open tasks (M0 → M6). Finish foundation (`X-`) tasks of a milestone before component tasks that depend on them.
2. Keep only tasks whose **Depends on** tasks are all **merged** into `main`. A task is merged when, on `main`, its heading ends with ` ✅` and its status says `done (PR #n)` ([ADR-0025](docs/mvp/adr/0025-roadmap-scheduling-and-tracking.md) item 6).
3. Drop tasks that are **claimed**: a status `in progress`, an open PR, or an existing branch `task/<ID>-*`.
4. Prefer tasks on the **critical path**. `node tools/plan-lint/plan-lint.mjs` prints it.
5. Prefer tasks whose **Files** do not overlap with tasks in progress, so parallel agents do not collide. Registry files (`pending-operations.ts`, `config.ts`, module and scheduler registries, `cli.ts`, `package.json`, `.env.example` files, OpenAPI documents, CI workflows, Markdown sections) and folder entries do not count as overlap: add only your own entries and rebase ([ADR-0020](docs/mvp/adr/0020-ai-agent-development-workflow.md), Parallel agents).
6. If nothing qualifies, stop and report which dependencies block progress.

## 4. Doing a task: one task = one branch = one PR

1. Create the branch `task/<ID>-<short-slug>` from the latest `main`.
2. Set the task's status to `in progress (PR #n)` in its plan once the PR exists. If the task block has no Status line, add `- **Status:** in progress (PR #n)` under the heading (plan-lint accepts extra fields).
3. **Contract first** (§6). Then implement the steps.
4. Change only the files listed in **Files**, plus their tests and generated files. If something else must change, keep it minimal and explain it in the PR.
5. Write tests that prove each **Acceptance** criterion. End the test name with `[<ID> AC<n>]`.
6. Run the task's **Verify** command and the checks in §5.
7. Update docs that your change makes stale. In the PR's last commit, set the plan status to `done (PR #n)` **and** end the task's heading with ` ✅` (`### X-012 · Title ✅`). Both become true when the developer merges; the roadmap counts done tasks by the ` ✅`.
8. Commit with Conventional Commits (`feat(ota-backend): add API key guard`, footer `Task: OBE-014`) and open **one PR** using the template. Its title is `<type>(<scope>): <title> [<ID>]`.
9. **Do not merge.** The developer reviews and merges.

Discovered extra work becomes a **new task** in the right plan (next free id, all fields, `node tools/plan-lint/plan-lint.mjs` passes). It is not done silently inside this task.

## 5. Definition of done

A task is done only when **all** of these hold:

- [ ] Every **Acceptance** criterion is met and mapped to a named test in the PR description.
- [ ] The task's **Verify** command passes.
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass. `pnpm test:int` passes when backend, database or queue code changed.
- [ ] Contract checks pass: generated types are up to date, route parity holds, and the SDK contract check passes.
- [ ] No test was deleted, skipped, loosened or given a longer timeout to make it pass (§7).
- [ ] Migrations, if any, follow [`conventions.md` §9](docs/mvp/conventions.md#9-database-migrations), run from scratch and as an upgrade, and the regenerated table types are committed.
- [ ] Docs are updated: README or docs files affected by the change, the [configuration matrix](docs/mvp/architecture.md#6-configuration-matrix), `.env.example` and the `deploy/env` template for new variables (with the human step "add it to `/etc/velexis` before the next deploy" in the PR), and an **ADR** for any new or changed decision (status `Proposed`).
- [ ] The plan status is set to `done (PR #n)`, the task heading ends with ` ✅`, and `node tools/plan-lint/plan-lint.mjs` passes.
- [ ] The security checklist in [`conventions.md` §12](docs/mvp/conventions.md#12-security-checklist-every-pr) is ticked.
- [ ] One PR, with the template filled in, and CI green.

## 6. Contract first

- **API changes start in the OpenAPI document**:
  - OTA: `ota/backend/openapi/` (moved from `docs/velexis-sdk/openapi/` in M0);
  - platform: `platform/backend/openapi/`.
- Then run `pnpm contracts:lint` and `pnpm contracts:generate`, then write the handler, then the SDK method. Never hand-write request or response types that the document defines ([ADR-0006](docs/mvp/adr/0006-contract-first-openapi.md)).
- **Queue messages between backends** change in `@velexis/api-types/jobs` first, backward compatible for one release ([ADR-0009](docs/mvp/adr/0009-background-jobs-bullmq.md)).
- **The SDK's JSDoc types must match the contract** in `docs/velexis-sdk/sdk/src/*.d.ts`. Additions are allowed. Removing or narrowing anything is not. **Never edit the contract files** to make the SDK pass ([ADR-0019](docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md)).
- **Database changes are new numbered migrations.** Never edit a merged migration. Never edit `docs/velexis-sdk/db/*.sql`, because the baselines are copies of them.

## 7. Tests are never weakened

- Never delete, skip (`.skip`, `xit`), focus (`.only`), loosen (weaker matchers, broader snapshots) or slow down (longer timeouts) a test to make CI green. If a test is wrong, say so in the PR, explain why, and fix it as a visible, separate change.
- Never change CI configuration, lint rules or type-check strictness to get your change through.
- A bug fix starts with a failing test.
- Tests are deterministic: no real network (use the Amadeus stub, Stripe fixtures, Mailpit), no sleeping (use fake timers), and no dependence on order.

## 8. Security rules (never broken)

- **No secrets in code**, tests, fixtures, logs or commits: no keys, passwords, tokens, real customer data or real card numbers. Use `.env.example` with dummy values. Test cards are Stripe's documented test numbers only.
- **Never log card data, tokens, passwords, document numbers or decrypted secrets.** Use the injected logger, never `console`. Never log request or response bodies. Add every new sensitive field to the redaction list in `@velexis/logger`, with a test ([ADR-0016](docs/mvp/adr/0016-observability.md)).
- **Card data** (airline-card payments) lives only in memory for one request. It is never stored, queued, cached or logged ([ADR-0011](docs/mvp/adr/0011-payments-stripe-and-airline-card.md)).
- **Tenant isolation:**
  - tenant data only through `tenantTx` (which sets `search_path` with `set_config(…, true)`);
  - never session-level `SET search_path`, never schema-qualified tenant SQL;
  - check the token's `tid` against the resolved tenant;
  - add an isolation test for every new tenant repository ([ADR-0004](docs/mvp/adr/0004-postgresql-schema-per-tenant.md)).
- **Ownership boundaries:**
  - the platform backend never touches tenant schemas;
  - the OTA backend never writes platform tables;
  - they talk only through queues, read-only data and Redis handoffs ([ADR-0003](docs/mvp/adr/0003-six-components-two-nestjs-backends.md)).
- **No tokens in browser JavaScript.** Next.js apps keep tokens in httpOnly cookies on the server. The storefront uses the SDK's cookie mode with CSRF ([ADR-0008](docs/mvp/adr/0008-identity-accounts-customers-sessions.md)).
- **Secrets at rest** use `@velexis/crypto` envelope encryption only ([ADR-0010](docs/mvp/adr/0010-secrets-envelope-encryption.md)).
- **Webhooks** verify signatures on the raw body and de-duplicate by event id.
- **No production access.** Never SSH to the VM, use production or live credentials, run deploys, or change branch protection.

## 9. When to stop and ask

Stop and write your question (in the PR under "Questions", or in your final message) instead of guessing when:

- the task conflicts with `decisions.md`, an ADR or the contract;
- the task is ambiguous, or the acceptance criteria cannot be tested as written;
- the change needs files far outside the task's **Files** list;
- a dependency task is not actually done.

If a decision is unavoidable, take the conservative, simple option for a solo developer on a single VM, and record it in a `Proposed` ADR ([ADR-0001](docs/mvp/adr/0001-record-architecture-decisions.md)).

## 10. Commands cheat sheet

The root scripts are created by the M0 foundation tasks. Until they exist, only the plan linter works. If a script name differs in `package.json`, `package.json` wins and this table is fixed in the same PR.

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies (Node 22, pnpm 9) |
| `pnpm build` | Build every package and app (Turborepo, cached) |
| `pnpm dev` | Run every app in development mode |
| `pnpm --filter @velexis/ota-backend dev` | Run one app (any `@velexis/*` name) |
| `pnpm lint` / `pnpm lint:fix` | ESLint (flat config) |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm typecheck` | `tsc --noEmit` everywhere, including the SDK's `checkJs` |
| `pnpm test` | Unit, contract and UI tests (Vitest) |
| `pnpm test:int` | Integration tests (needs PostgreSQL 16, Redis 7 and Mailpit; the Amadeus stub starts in-process) |
| `pnpm test:e2e` | Playwright end-to-end suite (`tools/e2e`) |
| `pnpm --filter <pkg> test -- <pattern>` | One package, matching tests only |
| `pnpm contracts:lint` | Lint the OpenAPI documents (Redocly) |
| `pnpm contracts:generate` | Regenerate `@velexis/api-types` from the OpenAPI documents |
| `pnpm db:migrate` | Apply platform and reference migrations |
| `pnpm db:migrate:tenants` | Apply tenant migrations to every tenant schema |
| `pnpm db:codegen` | Regenerate Kysely table types |
| `pnpm db:seed:reference` | Load the vendored reference data (airports, airlines, countries, currencies) into `reference` |
| `pnpm dev:keys` | Create local key files in `.local/keys/` |
| `pnpm stub:amadeus` | Start the Amadeus stub on `127.0.0.1:4900` |
| `node tools/plan-lint/plan-lint.mjs` (or `pnpm plan:lint`) | Validate the task plans and print the critical path (`--graph` for a Mermaid graph) |
| `stripe listen --forward-to localhost:4000/webhooks/stripe/velexis/test` | Forward Stripe test webhooks to the local OTA backend |
| `stripe listen --forward-to localhost:3100/webhooks/stripe/billing` | Forward Stripe billing webhooks to the local platform backend |

Local services: PostgreSQL `127.0.0.1:5432`, Redis `127.0.0.1:6379`, Mailpit SMTP `1025` and UI `http://127.0.0.1:8025`. Ports of the apps are in [`docs/mvp/architecture.md` §3](docs/mvp/architecture.md#3-hosts-ports-and-the-vm).

## 11. Repository map

| Path | What |
|---|---|
| `platform/backend`, `platform/frontend`, `platform/admin` | Platform API (NestJS), portal and platform admin (Next.js) |
| `ota/backend`, `ota/frontend`, `ota/admin`, `ota/sdk` | OTA API (NestJS), hosted storefront (vanilla), OTA admin (Next.js), JS SDK |
| `packages/*` | `config`, `logger`, `db`, `crypto`, `errors`, `api-types`, `testing` (devDependency only) |
| `deploy/` | Caddyfile, systemd units, VM, deploy and backup scripts, env templates |
| `tools/` | `plan-lint`, `reference-data`, `amadeus-stub`, `e2e` |
| `docs/mvp/` | Decisions, architecture, conventions, tech stack, ADRs, plans |
| `docs/velexis-sdk/`, `docs/amadeus-api/` | Reference contracts and designs (reuse, do not redo, do not edit) |
