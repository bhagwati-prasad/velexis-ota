# OTA documentation index

This page lists every document of the Velexis OTA group (OTA backend, hosted storefront, OTA admin, JS SDK) with one line on what it is for. These documents refine the cross-cutting MVP documents in [`docs/mvp/`](../../docs/mvp/README.md) for the data plane and must never contradict them. Precedence is [`decisions.md`](../../docs/mvp/decisions.md) → [cross-cutting ADRs](../../docs/mvp/adr/README.md) → [OTA ADRs](adr/README.md) → plans → code ([ADR-0001](../../docs/mvp/adr/0001-record-architecture-decisions.md)).

When you add, rename or remove an OTA document, update this index in the same pull request.

Related: [`../README.md`](../README.md) (what the OTA group is), [platform docs](../../platform/docs/README.md).

## Read order for a new agent session

1. [`../../AGENTS.md`](../../AGENTS.md) and [`../../docs/mvp/decisions.md`](../../docs/mvp/decisions.md)
2. [`../README.md`](../README.md) (the four OTA parts)
3. [`scope.md`](scope.md) (what the MVP contains, which operations are MVP)
4. [`architecture.md`](architecture.md) (backend modules, request pipeline, workers)
5. The flow, API change, data-model section and OADRs your task names

## Core documents

| Document | One line |
|---|---|
| [`scope.md`](scope.md) | MVP scope per OTA part (in, out, later), roles and permissions, and every one of the 96 contract operations marked MVP (with milestone) or deferred. |
| [`architecture.md`](architecture.md) | NestJS modules of `ota/backend`, the request pipeline (edge, keys, service key, cookies), data access, Amadeus and Stripe integration, workers, queues, schedulers, Redis keys, failure behaviour. |
| [`architecture-booking.md`](architecture-booking.md) | Booking orchestration: sequence diagrams for Stripe and airline-card bookings, the `SUPPLIER_TIMEOUT` recovery, and how idempotency works end to end. |
| [`api-changes.md`](api-changes.md) | Spec-first deltas to the OTA OpenAPI document, part 1: cookie session mode and CSRF, airline-card payment, payment account modes in the storefront config, the OTA admin service credential. |
| [`api-changes-console-and-internal.md`](api-changes-console-and-internal.md) | Part 2: console settings (markups, fees, storefront settings, pages, assets, templates), console payments (capture, refund, list), public storefront pages and assets, internal endpoints (health, webhooks, files). |
| [`data-model.md`](data-model.md) | How the backend uses the tenant schema (links to the DDL and ER), every delta of tenant migration `0002` and why it is needed. |
| [`data-model-migration-0002.md`](data-model-migration-0002.md) | The exact SQL of `ota/backend/migrations/tenant/0002_add_mvp_tenant_deltas.sql`. |

## Flows

Each flow has a Mermaid sequence diagram, numbered steps, failure handling, the tables it touches and the SDK methods it uses.

| Flow | Milestones | One line |
|---|---|---|
| [`flows/search-and-price.md`](flows/search-and-price.md) | M2 | Storefront bootstrap, search, results, offer details, branded-fare upsell, pricing, ancillaries and fare rules. |
| [`flows/checkout-stripe.md`](flows/checkout-stripe.md) | M3 | Checkout data, Stripe PaymentIntent with 3-D Secure, completion, order, capture, issue. |
| [`flows/checkout-airline-card.md`](flows/checkout-airline-card.md) | M3, M6 | Airline-card payment: net pricing, the dedicated completion call, card in memory only, create order with issue. |
| [`flows/ticketing-and-documents.md`](flows/ticketing-and-documents.md) | M3 | Ticketing policies, issuance retries until the deadline, booking sync, e-mails, itinerary and e-ticket PDFs, signed downloads. |
| [`flows/my-bookings-and-guest-lookup.md`](flows/my-bookings-and-guest-lookup.md) | M3 | Customer sign-up and sign-in in cookies, upcoming / past / cancelled bookings, guest lookup by reference and last name. |
| [`flows/change-and-cancel.md`](flows/change-and-cancel.md) | M3 | Change contacts, cancellation quote, release / void / request-only cancellation, refunds and voids. |
| [`flows/console-operations.md`](flows/console-operations.md) | M4 | Staff SSO, bookings list, retrieve, patch, issue, cancel, notes, PNR lookup and import, queues, payments, settings. |
| [`flows/tenant-provisioning-worker.md`](flows/tenant-provisioning-worker.md) | M1, M2+ | `tenant.provision`, `tenant.migrate`, deploy fan-out, `tenant.suspend` / `tenant.resume` handling in the OTA worker. |
| [`flows/amadeus-connection-and-tokens.md`](flows/amadeus-connection-and-tokens.md) | M2, M5 | Connection resolution (Velexis shared office or OTA credentials), OAuth tokens, rate limits, timeouts, retries, logging. |

## OTA ADRs

The index with status and one-line summaries is in [`adr/README.md`](adr/README.md). OTA ADRs are numbered `OADR-NNNN` so they never clash with the cross-cutting `ADR-NNNN` or the platform `PADR-NNNN`.

## Component specifications

| Document | One line |
|---|---|
| [`../backend/README.md`](../backend/README.md) | Folder and module tree, environment variables, processes and workers, commands, the Amadeus stub, test layout. |
| [`../backend/.env.example`](../backend/.env.example) | Every OTA backend variable with a dummy value. |
| [`../frontend/README.md`](../frontend/README.md) | Hosted storefront pages, modules, SDK cookie mode, CSP rules. |
| [`../admin/README.md`](../admin/README.md) | OTA admin route map, SSO, server actions through the SDK. |
| [`../sdk/README.md`](../sdk/README.md) | SDK layout, session modes, bundles, contract check. |

## Plans

| Plan | Style | One line |
|---|---|---|
| `plans/agent-tasks.md` | Agent tasks (`OBE-`, `OFE-`, `OAD-`, `SDK-`) | Small verifiable tasks for the OTA backend, storefront, OTA admin and SDK, M0–M6. |
| `plans/` | Solo developer, week by week | The order in which the developer drives and reviews the OTA tasks. |

## Reference material used here (reuse, do not redo)

| Path | Used for |
|---|---|
| [`../../docs/velexis-sdk/db/tenant.sql`](../../docs/velexis-sdk/db/tenant.sql) | Tenant migration `0001_baseline` (42 tables) |
| [`../../docs/velexis-sdk/db/README.md`](../../docs/velexis-sdk/db/README.md) | Provisioning (§3), migration runner (§4), routing (§5), jobs (§6), security and redaction (§8), API areas ↔ tables (§10) |
| [`../../docs/velexis-sdk/db/dictionary.json`](../../docs/velexis-sdk/db/dictionary.json), [`er/er-tenant.mmd`](../../docs/velexis-sdk/db/er/er-tenant.mmd) | Column meanings and the tenant ER diagram |
| [`../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml`](../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml) | The frozen original of the OTA contract (96 operations); the working copy is `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml` |
| [`../../docs/velexis-sdk/sdk/src/`](../../docs/velexis-sdk/sdk/src/), [`sdk/docs/`](../../docs/velexis-sdk/sdk/docs/) | SDK contract and guides B1–B4 |
| [`../../docs/velexis-sdk/examples/next-storefront/`](../../docs/velexis-sdk/examples/next-storefront/) | Reference storefront and console flows (Next.js; post-MVP reference) |
| [`../../docs/amadeus-api/`](../../docs/amadeus-api/) | The 9 Amadeus specifications (12 operations) behind the Amadeus client and the stub |
