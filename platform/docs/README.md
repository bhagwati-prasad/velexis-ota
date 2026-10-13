# Platform documentation index

This page lists every document of the Velexis platform group (platform backend, portal, platform admin) with one line on what it is for. These documents refine the cross-cutting MVP documents in [`docs/mvp/`](../../docs/mvp/README.md) for the control plane and must never contradict them. Precedence is [`decisions.md`](../../docs/mvp/decisions.md) → [cross-cutting ADRs](../../docs/mvp/adr/README.md) → [platform ADRs](adr/README.md) → plans → code ([ADR-0001](../../docs/mvp/adr/0001-record-architecture-decisions.md)).

When you add, rename or remove a platform document, update this index in the same pull request.

## Read order for a new agent session

1. [`../../AGENTS.md`](../../AGENTS.md) and [`../../docs/mvp/decisions.md`](../../docs/mvp/decisions.md)
2. [`../README.md`](../README.md) (what the platform group is)
3. [`scope.md`](scope.md) (what the MVP contains)
4. [`architecture.md`](architecture.md) (modules, workers, integration with the OTA backend)
5. The flow, API section, data-model section and PADRs your task names

## Core documents

| Document | One line |
|---|---|
| [`scope.md`](scope.md) | MVP scope per component (in, out, later), user roles and permissions, feature list with acceptance-level detail and milestones. |
| [`architecture.md`](architecture.md) | NestJS modules of the platform backend, guards, workers, queues and schedules, Redis keys, integration contract with the OTA backend, configuration. |
| [`architecture-flows.md`](architecture-flows.md) | One overview sequence diagram per platform flow, with links to the detailed flow documents. |
| [`api-inventory.md`](api-inventory.md) | API conventions, auth scopes, error catalogue, and the auth, account, tenant and team endpoints. Source of the platform OpenAPI document. |
| [`api-inventory-resources.md`](api-inventory-resources.md) | Endpoints for API keys, domains, Amadeus and payment connections, billing and settlements. |
| [`api-inventory-admin.md`](api-inventory-admin.md) | Platform admin endpoints, Stripe webhook endpoints and internal endpoints. |
| [`data-model.md`](data-model.md) | The `platform` and `reference` schemas as the platform uses them, every delta of migration `0002` and why it is needed. |
| [`data-model-migration-0002.md`](data-model-migration-0002.md) | The exact SQL of `platform/backend/migrations/platform/0002_add_mvp_platform_deltas.sql`, part 1: identity, tenants, domains, Amadeus. |
| [`data-model-migration-0002-part2.md`](data-model-migration-0002-part2.md) | Part 2: payment connection modes, plans ↔ Stripe prices, settlements, payout accounts. |
| [`data-model-migration-0002-part3.md`](data-model-migration-0002-part3.md) | Part 3: billing customers, subscription statuses, invoices, Stripe event inbox, e-mail outbox, privileges. |

## Flows

Each flow has a Mermaid sequence diagram, numbered steps, failure handling and the tables it touches.

| Flow | Milestones | One line |
|---|---|---|
| [`flows/signup-and-create-ota.md`](flows/signup-and-create-ota.md) | M1, M5 | Sign-up, e-mail verification, sign-in with MFA, create OTA wizard, Checkout hand-off. |
| [`flows/provisioning.md`](flows/provisioning.md) | M1 | Provisioning job dispatch, OTA worker steps, platform post-steps, retries, reconciler, migrate. |
| [`flows/amadeus-connection.md`](flows/amadeus-connection.md) | M1, M5 | Velexis shared account and office pool, test office at provisioning, live office, OTA-owned credentials. |
| [`flows/stripe-payments-account.md`](flows/stripe-payments-account.md) | M1, M5 | Velexis Stripe account by default, Connect Standard OAuth, API keys, monthly settlements. |
| [`flows/subscription-billing.md`](flows/subscription-billing.md) | M5 | Plans ↔ Stripe prices, Checkout, Customer Portal, webhook sync, dunning and suspension. |
| [`flows/custom-domains.md`](flows/custom-domains.md) | M5 | Add a domain, DNS verification, on-demand TLS through the `ask` endpoint, primary domain, removal. |
| [`flows/api-keys.md`](flows/api-keys.md) | M1 | Create, show once, scopes and origins, roll, revoke, usage flush. |
| [`flows/team-and-ota-admin-sso.md`](flows/team-and-ota-admin-sso.md) | M1, M4 | Invitations, roles, removal, "Open console" SSO into the OTA admin, sign out everywhere. |
| [`flows/platform-admin-operations.md`](flows/platform-admin-operations.md) | M1, M5 | Admin sign-in, suspend and resume, job retry, plans, offices, settlements, account support. |

## Platform ADRs

The index with status and one-line summaries is in [`adr/README.md`](adr/README.md). Platform ADRs are numbered `PADR-NNNN` so they never clash with the cross-cutting `ADR-NNNN`.

## Component specifications

| Document | One line |
|---|---|
| [`../backend/README.md`](../backend/README.md) | Folder tree, modules, environment variables, jobs, commands, OpenAPI location, test layout. |
| [`../backend/.env.example`](../backend/.env.example) | Every platform backend variable with a dummy value. |
| [`../frontend/README.md`](../frontend/README.md) | Portal route map, components, data fetching through server actions, auth cookies. |
| [`../frontend/.env.example`](../frontend/.env.example) | Portal variables. |
| [`../admin/README.md`](../admin/README.md) | Platform admin route map, components, access rules. |
| [`../admin/.env.example`](../admin/.env.example) | Platform admin variables. |

## Plans

| Plan | Style | One line |
|---|---|---|
| [`plans/agent-tasks.md`](plans/agent-tasks.md) | Agent tasks (`PBE-`, `PFE-`, `PAD-`) | Small verifiable tasks for the platform backend, portal and admin, M0–M6. |
| [`plans/`](plans/) | Solo developer, week by week | The order in which the developer drives and reviews the platform tasks. |

## Reference material used here (reuse, do not redo)

| Path | Used for |
|---|---|
| [`../../docs/velexis-sdk/db/platform.sql`](../../docs/velexis-sdk/db/platform.sql), [`reference.sql`](../../docs/velexis-sdk/db/reference.sql) | Migration `0001_baseline` of `platform` and `reference` |
| [`../../docs/velexis-sdk/db/README.md`](../../docs/velexis-sdk/db/README.md) | Provisioning steps (§3), migration runner (§4), routing (§5), security (§8) |
| [`../../docs/velexis-sdk/db/dictionary.json`](../../docs/velexis-sdk/db/dictionary.json), [`er/er-platform.mmd`](../../docs/velexis-sdk/db/er/er-platform.mmd) | Column meanings and the baseline ER diagram |
| [`../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml`](../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml) | `console.auth.signIn` (portal token grant), `StaffPermission`, `ConsoleApiKeyScope`, the error envelope and catalogue style |
