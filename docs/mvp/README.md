# Velexis MVP documentation index

This page lists every document of the Velexis MVP with one line on what it is for: cross-cutting documents, architecture decision records, platform and OTA component documents, the plans, and the reference material they build on. It also defines the **shared milestones M0–M6** that every plan uses. Start with [`decisions.md`](decisions.md), then [`architecture.md`](architecture.md), then the roadmap and the plans. AI agents start with [`AGENTS.md`](../../AGENTS.md).

When you add, rename or remove an MVP document, update this index in the same pull request.

## 1. Shared milestones

Every plan uses exactly these ids and meanings.

| Id | Name | Scope |
|---|---|---|
| **M0** | Foundations | Monorepo, shared packages, CI, database baseline migrations (platform, reference, tenant), single VM provisioned with Caddy, PostgreSQL and Redis, and a hello-world deploy. |
| **M1** | Platform core | Portal sign-up, sign-in and MFA; create OTA; the provisioning job creates the tenant schema; API keys; the default Velexis Amadeus test office assigned; platform admin basics (tenants, provisioning jobs, audit). |
| **M2** | Search & price | OTA backend tenancy, Amadeus client and shopping endpoints; SDK core plus the flights, reference and storefront namespaces; hosted storefront (search, results, offer details, upsell, pricing, ancillaries) on `<key>.ota.example.com`. |
| **M3** | Book & pay | Checkout; customer auth (cookie sessions); Stripe payments on the Velexis account; airline-card payment through Amadeus; create order; issue; e-mails and documents; my bookings (upcoming, past, cancelled); guest lookup; change contacts; cancel. |
| **M4** | OTA admin | OTA admin app (SSO from the portal); bookings console (retrieve, patch, issue, cancel, notes); PNR lookup and import; queues; Stripe capture and refund; customers; markups and fees; storefront settings and branding; templates. |
| **M5** | Monetisation & self-service | Stripe Billing subscriptions; the OTA's own Stripe (Connect Standard or API keys); Velexis-account settlements; the OTA's own Amadeus credentials; custom domains with on-demand TLS; live environment switch. |
| **M6** | Hardening & launch | Security review and PCI controls for the airline-card flow; backups and a restore drill; monitoring and alerting; end-to-end test suite; performance sanity; launch checklist. |

## 2. Cross-cutting documents (`docs/mvp/`)

| Document | One line |
|---|---|
| [`decisions.md`](decisions.md) | The product owner's decisions: components, hosting, payments, Amadeus and Stripe models, placeholder hosts, cross-cutting rules. **Binding for everything below.** |
| [`architecture.md`](architecture.md) | System context and containers, hosts and ports, data ownership, request flows (sign-up, booking, SSO, webhooks, custom domains), configuration matrix, failure domains. |
| [`tech-stack.md`](tech-stack.md) | Versions and libraries per component with a one-line reason each, and what we deliberately do not use. |
| [`conventions.md`](conventions.md) | Code organisation (NestJS, Next.js, vanilla storefront, SDK), error model, logging, configuration, migrations, testing, git workflow, security checklist. |
| [`plans/roadmap.md`](plans/roadmap.md) | Master roadmap: calendars with and without agents, batches, review gates, demos, go/no-go criteria, critical path, risks and progress tracking. |
| [`deployment-single-vm.md`](deployment-single-vm.md) | Operations guide for the single VM: sizing, hardening, process layout, PostgreSQL, Redis, Caddy and TLS, secrets, deploy and rollback, migrations, backups and restore drill, logs, monitoring, capacity, the path to managed services. |
| [`local-development.md`](local-development.md) | Local development runbook: prerequisites, one-time setup, daily commands, Mailpit, Stripe CLI, Amadeus stub, tests, troubleshooting. |
| [`adr/README.md`](adr/README.md) | Index of the cross-cutting architecture decision records. |
| [`plans/`](plans/README.md) | The plans index, the master roadmap and the foundation agent tasks (§5). |

## 3. Architecture decision records (`docs/mvp/adr/`)

| ADR | One line |
|---|---|
| [0001](adr/0001-record-architecture-decisions.md) Record architecture decisions | Format, location, precedence and the change process for decisions. |
| [0002](adr/0002-monorepo-pnpm-turborepo.md) Monorepo with pnpm and Turborepo | Workspace layout, package names, module formats, dependency rules. |
| [0003](adr/0003-six-components-two-nestjs-backends.md) Six components, two NestJS backends | Responsibilities, API + worker processes, how the backends may interact. |
| [0004](adr/0004-postgresql-schema-per-tenant.md) PostgreSQL schema per tenant | What we keep from the db design, MVP simplifications, the four database roles. |
| [0005](adr/0005-data-access-kysely-sql-migrations.md) Kysely and SQL migrations | Query layer, generated types, migration runner and baselines. |
| [0006](adr/0006-contract-first-openapi.md) Contract first with OpenAPI | Document locations, generation, runtime validation, CI parity checks. |
| [0007](adr/0007-single-vm-without-docker.md) Single VM without Docker | Host, users, directories, systemd units, deploy and backups. |
| [0008](adr/0008-identity-accounts-customers-sessions.md) Identity, accounts, customers, sessions | Identity realms, tokens, MFA, portal-token SSO, cookie mode and CSRF, first-party credentials. |
| [0009](adr/0009-background-jobs-bullmq.md) Background jobs with BullMQ | Queues between and inside the backends, durability, retries, payload rules. |
| [0010](adr/0010-secrets-envelope-encryption.md) Secrets with envelope encryption | AES-256-GCM envelopes, key files on the VM, rotation, who decrypts what. |
| [0011](adr/0011-payments-stripe-and-airline-card.md) Payments: Stripe and airline card | Stripe account modes, settlements, the airline-card path, PCI DSS scope and controls. |
| [0012](adr/0012-amadeus-account-model.md) Amadeus account model | Shared account with office per OTA, own credentials later, isolation and rate limits. |
| [0013](adr/0013-subscription-billing-stripe-billing.md) Subscription billing | Stripe Checkout, Customer Portal, webhook sync, suspension, the pre-M5 manual path. |
| [0014](adr/0014-frontend-stack-nextjs-tailwind.md) Frontend stack | Next.js BFF pattern for three apps, vanilla storefront rules. |
| [0015](adr/0015-testing-strategy.md) Testing strategy | Test levels, Amadeus stub, Stripe test mode, contract tests, rules for agents. |
| [0016](adr/0016-observability.md) Observability | Logs, redaction, health endpoints, uptime and on-VM alerting. |
| [0017](adr/0017-email-documents-storage.md) E-mail, documents, storage | Nodemailer and templates, pdfmake, the storage adapter and signed URLs. |
| [0018](adr/0018-hosted-storefront-custom-domains.md) Hosted storefront and custom domains | Caddy configuration, `ask` endpoint, edge credential, custom domain lifecycle. |
| [0019](adr/0019-vanilla-js-sdk-jsdoc.md) Vanilla JS SDK with JSDoc | Source layout, type checking against the contract, session modes, bundles. |
| [0020](adr/0020-ai-agent-development-workflow.md) AI-agent development workflow | Plans, task format, one task per PR, review gates, parallel agents. |
| [0021](adr/0021-migration-cli-and-repeatable-grants.md) Migration CLI and repeatable grants | One migrate CLI for every caller; idempotent `R__*.sql` files for the OTA read grants. |
| [0022](adr/0022-shared-test-support-package.md) Shared test-support package | `@velexis/testing`: test databases, Redis, clock, response checks, Mailpit, Stripe and Amadeus stub helpers. |
| [0023](adr/0023-release-artefact-and-deploy-user.md) Release artefact and deploy user | Release folder layout, separate build and deploy jobs, the `deploy` user's single sudo command, root-owned scripts, rollback with the release's own units. |
| [0024](adr/0024-reference-data-sources-and-loader.md) Reference data sources and loader | OpenTravelData and CLDR snapshots, vendored and loaded idempotently. |
| [0025](adr/0025-roadmap-scheduling-and-tracking.md) Roadmap scheduling and tracking | Calendars with and without agents, batches and gates, launch exceptions, the ` ✅` status rule, where demos run. |
| [0026](adr/0026-system-users-per-trust-zone.md) System users per trust zone | One OS user per backend zone and per Next.js app, per-zone key folders, env files read by systemd only. |
| [0027](adr/0027-pci-scope-and-vm-controls.md) PCI DSS scope and controls on the single VM | The whole VM is the CDE; each applicable requirement with its control and owning task. |

## 4. Component documents

Each group keeps its own documents next to its code. They refine the cross-cutting documents and must not contradict them.

| Location | Contains |
|---|---|
| [`platform/docs/`](../../platform/docs/) | Platform backend, portal and platform admin: component architecture, platform API outline, platform schema deltas, screens, component ADRs named PADR-NNNN ([`platform/docs/adr/`](../../platform/docs/adr/README.md)), plans (`platform/docs/plans/`). |
| [`ota/docs/`](../../ota/docs/) | OTA backend, storefront, OTA admin and SDK: component architecture, OTA API extensions, tenant schema deltas, Amadeus integration, pages and screens, component ADRs named OADR-NNNN ([`ota/docs/adr/`](../../ota/docs/adr/README.md)), plans (`ota/docs/plans/`). |

## 5. Plans

There are two plan styles ([ADR-0020](adr/0020-ai-agent-development-workflow.md)). Agent task plans are validated by [`tools/plan-lint/plan-lint.mjs`](../../tools/plan-lint/plan-lint.mjs).

| Plan | Style | Task ids | One line |
|---|---|---|---|
| [`plans/README.md`](plans/README.md) | Index | — | Every plan file, the question it answers, how the plans relate, the rules they share. |
| [`plans/roadmap.md`](plans/roadmap.md) | Master plan | references all ids | One calendar with and without agents, batches, review gates, demos, go/no-go criteria, critical path, risks, status and change log. |
| [`plans/foundation-tasks.md`](plans/foundation-tasks.md) | Agent tasks | `X-` | Monorepo, shared packages, CI, baseline migrations, VM and deploy (M0), and the shared work of M1–M6 (stub, backups, monitoring, PCI controls). |
| [`../../platform/docs/plans/implementation-plan.md`](../../platform/docs/plans/implementation-plan.md) | Implementation plan | references `PBE-`, `PFE-`, `PAD-` | Platform goals, epics, demos, exit criteria, interfaces with the OTA group and risks per milestone. |
| [`../../platform/docs/plans/agent-tasks.md`](../../platform/docs/plans/agent-tasks.md) | Agent tasks | `PBE-`, `PFE-`, `PAD-` | Platform backend, portal and platform admin tasks, M0–M6. |
| [`../../platform/docs/plans/solo-developer-plan.md`](../../platform/docs/plans/solo-developer-plan.md) | Solo developer | references platform ids | The platform group week by week without agents (31 weeks). |
| [`../../ota/docs/plans/implementation-plan.md`](../../ota/docs/plans/implementation-plan.md) | Implementation plan | references `OBE-`, `OFE-`, `OAD-`, `SDK-` | OTA goals, epics, demos, exit criteria, interfaces with the platform group and risks per milestone. |
| [`../../ota/docs/plans/agent-tasks.md`](../../ota/docs/plans/agent-tasks.md) | Agent tasks | `OBE-`, `OFE-`, `OAD-`, `SDK-` | OTA backend, storefront, OTA admin and SDK tasks, M0–M6. |
| [`../../ota/docs/plans/solo-developer-plan.md`](../../ota/docs/plans/solo-developer-plan.md) | Solo developer | references OTA ids | The OTA group week by week without agents (40 weeks). |

## 6. Repository-level documents

| Document | One line |
|---|---|
| [`README.md`](../../README.md) | Repository map, what each component is, where to start, status. |
| [`AGENTS.md`](../../AGENTS.md) | Operating manual for AI coding agents: read order, picking tasks, definition of done, rules, commands. |
| [`CLAUDE.md`](../../CLAUDE.md) | Pointer to `AGENTS.md` and the five most important rules. |

## 7. Reference material (reuse, do not redo)

| Path | One line |
|---|---|
| [`../velexis-sdk/README.md`](../velexis-sdk/README.md) | Overview of the validated database, API and SDK design. |
| [`../velexis-sdk/db/README.md`](../velexis-sdk/db/README.md) | Tenancy design: provisioning, migration runner, routing with `SET LOCAL search_path`, jobs, backups, security, scaling. |
| [`../velexis-sdk/db/platform.sql`](../velexis-sdk/db/platform.sql), [`reference.sql`](../velexis-sdk/db/reference.sql), [`tenant.sql`](../velexis-sdk/db/tenant.sql) | Baseline DDL (16 + 7 + 42 tables), migration `0001` of each schema. |
| [`../velexis-sdk/db/dictionary.json`](../velexis-sdk/db/dictionary.json), [`er/`](../velexis-sdk/db/er/) | Description of every table and column, and the ER diagrams. |
| [`../velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml`](../velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml) | The OTA booking API: 96 operations with `x-sdk-method`, `x-amadeus`, `x-tenant-tables`, `x-scope`, and the error catalogue. |
| [`../velexis-sdk/sdk/src/`](../velexis-sdk/sdk/src/) | SDK contract (`index`, `shared`, `identity`, `flights`, `bookings`, `console`; `next` and `react` are post-MVP). |
| [`../velexis-sdk/sdk/docs/`](../velexis-sdk/sdk/docs/) | SDK developer guides B1–B4 and the Next.js guide. |
| [`../velexis-sdk/examples/next-storefront/`](../velexis-sdk/examples/next-storefront/) | Reference storefront and console flows written against the SDK. |
| [`../amadeus-api/`](../amadeus-api/) | The 9 Amadeus Enterprise specifications (12 operations). |
| [`../ota-build/ota-model-1-b2c-essentials.html`](../ota-build/ota-model-1-b2c-essentials.html) | The broader B2C essentials plan. Background only. |
