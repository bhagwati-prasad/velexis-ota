# Architecture decision records (cross-cutting)

This folder holds the cross-cutting architecture decision records (ADRs) of the Velexis MVP. Each ADR states one decision, why it was taken, and what follows from it. They implement the product owner's answers in [`../decisions.md`](../decisions.md), which always takes precedence. Read [ADR-0001](0001-record-architecture-decisions.md) for the format, the precedence rules and how to add or supersede an ADR. The full MVP document index is in [`../README.md`](../README.md).

## Index

| ADR | Title | Status | In one line |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted | MADR-lite ADRs here and per component (PADR-, OADR-); `decisions.md` > ADRs > plans > code; planning-review revisions in place until M0 starts; since then a new ADR supersedes, except dated in-place revisions that record a lead decision refining (not reversing) an ADR. |
| [0002](0002-monorepo-pnpm-turborepo.md) | Monorepo with pnpm workspaces and Turborepo | Accepted | One repo, pnpm 9 workspaces, Turborepo 2, `@velexis/*` package names, dependency rules. |
| [0003](0003-six-components-two-nestjs-backends.md) | Six components and two NestJS backends | Accepted | Control plane vs data plane, API + worker processes, queues and read-only access between backends. |
| [0004](0004-postgresql-schema-per-tenant.md) | PostgreSQL schema per tenant | Accepted | Reuse the db README design with four database roles (migrator, provisioner, two app roles), no per-tenant roles and one local cluster. |
| [0005](0005-data-access-kysely-sql-migrations.md) | Data access with Kysely and plain SQL migrations | Accepted | Kysely on `pg`, generated table types, forward-only SQL migrations, reference DDL as `0001_baseline`. |
| [0006](0006-contract-first-openapi.md) | Contract first with OpenAPI | Accepted | OpenAPI 3.1 documents in each backend, generated types in `@velexis/api-types`, Ajv validation, parity checks. |
| [0007](0007-single-vm-without-docker.md) | Single VM without Docker | Accepted | Ubuntu 24.04, native services, systemd units, release symlinks, nightly encrypted off-VM backups. |
| [0008](0008-identity-accounts-customers-sessions.md) | Identity: accounts, customers and sessions | Accepted | Realms, Argon2id + TOTP, Ed25519 JWTs with rotating refresh tokens, portal-token SSO, cookie mode + CSRF. |
| [0009](0009-background-jobs-bullmq.md) | Background jobs with BullMQ | Accepted | BullMQ on Redis, `ota-tenant-ops` and `platform-tenant-events` queues, PostgreSQL as the durable record. |
| [0010](0010-secrets-envelope-encryption.md) | Secrets with envelope encryption | Accepted | AES-256-GCM per-value data keys wrapped by a file-based master key, rotation by key id. |
| [0011](0011-payments-stripe-and-airline-card.md) | Payments: Stripe and airline card | Accepted | Stripe on the Velexis account, Connect Standard or API keys later; airline card in memory only under SAQ D controls. |
| [0012](0012-amadeus-account-model.md) | Amadeus account model | Accepted | Shared Velexis account with an office per OTA by default, OTA-owned credentials later, per-tenant rate limits. |
| [0013](0013-subscription-billing-stripe-billing.md) | Subscription billing with Stripe Billing | Accepted | Checkout for sign-up, Customer Portal for management, webhook sync with re-fetch, suspension on non-payment. |
| [0014](0014-frontend-stack-nextjs-tailwind.md) | Frontend stack: Next.js and Tailwind | Accepted | Next.js 15 + React 19 + Tailwind 4 + shadcn/ui as BFFs; vanilla Vite-built storefront. |
| [0015](0015-testing-strategy.md) | Testing strategy | Accepted | Vitest, Supertest, Playwright, Amadeus stub with recorded fixtures, Stripe test mode, contract tests. |
| [0016](0016-observability.md) | Observability | Accepted | pino to journald with central redaction, health endpoints, external uptime monitor, on-VM alert script. |
| [0017](0017-email-documents-storage.md) | E-mail, documents and storage | Accepted | Nodemailer + Mailpit, Handlebars templates, pdfmake, `StorageAdapter` with local disk and signed URLs. |
| [0018](0018-hosted-storefront-custom-domains.md) | Hosted storefront and custom domains | Accepted | Caddy on-demand TLS gated by an `ask` endpoint, same-origin `/api` proxy with an edge credential, CSP. |
| [0019](0019-vanilla-js-sdk-jsdoc.md) | Vanilla JS SDK with JSDoc types | Accepted | ES modules, JSDoc on generated types, `checkJs`, contract check, ESM + IIFE bundles, token and cookie modes. |
| [0020](0020-ai-agent-development-workflow.md) | AI-agent development workflow | Accepted | Linted Markdown task plans, one task per branch and PR, developer-only merges and deploys. |
| [0021](0021-migration-cli-and-repeatable-grants.md) | Migration CLI and repeatable grant files | Accepted | One `migrate.js` CLI for deploys, dev, provisioning and tests; idempotent `R__*.sql` grant files keep the OTA read grants out of the baselines. |
| [0022](0022-shared-test-support-package.md) | Shared test-support package `@velexis/testing` | Accepted | Dev-only package: template-cloned test databases with two tenants, Redis, clock, Ajv response checks, Mailpit, Stripe and Amadeus stub helpers. |
| [0023](0023-release-artefact-and-deploy-user.md) | Release artefact and deploy user | Accepted | Checksummed release built in a job without secrets and deployed by a separate job; `deploy` user with one sudo command; root runs only root-owned code; rollback restores the release's units and Caddyfile. |
| [0024](0024-reference-data-sources-and-loader.md) | Reference data sources and loader | Accepted | OpenTravelData and Unicode CLDR snapshots vendored in `tools/reference-data`, loaded idempotently with the platform role; never fetched at runtime. |
| [0025](0025-roadmap-scheduling-and-tracking.md) | Roadmap scheduling and tracking | Accepted | 30 weeks with agents, 76 without; strict milestone order; gates and launch exceptions; one ` ✅` status rule; demos split into VM and local-stack parts. |
| [0026](0026-system-users-per-trust-zone.md) | System users per trust zone | Accepted | One OS user per backend zone and per Next.js app, per-zone key folders, env files read by systemd only; `InaccessiblePaths=` is defence in depth. |
| [0027](0027-pci-scope-and-vm-controls.md) | PCI DSS scope and controls on the single VM | Accepted | The whole VM and the systems that change it are the CDE; every applicable requirement has a control and an owning task (SSH MFA, off-VM logs, WAF, scans). |

## Component ADRs

Decisions that concern only one component group are recorded next to it. They must not contradict the ADRs above. Their numbers overlap with these, so they are always named with a prefix ([ADR-0001](0001-record-architecture-decisions.md) item 2):

| Prefix | Index | Holds |
|---|---|---|
| **PADR-NNNN** | [`platform/docs/adr/README.md`](../../../platform/docs/adr/README.md) | Platform backend, portal and platform admin decisions (18 records) |
| **OADR-NNNN** | [`ota/docs/adr/README.md`](../../../ota/docs/adr/README.md) | OTA backend, storefront, OTA admin and SDK decisions (18 records) |

A bare ADR-NNNN always means a record in this folder.

## New ADR checklist

1. Copy the template from [ADR-0001](0001-record-architecture-decisions.md) into `NNNN-kebab-title.md`, using the next free number.
2. Use status `Proposed` in the pull request. The developer sets `Accepted` on merge.
3. Add a row to the index above.
4. If it supersedes an ADR, set the old one's status to `Superseded by ADR-NNNN`. A lead decision that only refines an ADR is a dated revision of that ADR instead ([ADR-0001](0001-record-architecture-decisions.md) item 4).
5. If it changes a product owner decision, edit [`../decisions.md`](../decisions.md) first.
