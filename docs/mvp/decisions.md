# Velexis MVP: decision record

This file holds the decisions taken while planning the MVP, as answered by the product owner. Every document under `platform/`, `ota/` and `docs/mvp/` follows it. To change a decision, edit this file first, then the ADR that records it, then the plans.

## 1. What we are building

Velexis is a multi-tenant OTA platform. A person signs up on the Velexis **portal**, subscribes to a plan and gets their own **OTA** (a tenant). The OTA sells flights from **Amadeus Enterprise** to its customers through a storefront and runs its operations in an OTA admin.

The system has six components in two groups. Each group has its own top-level directory.

| # | Component | Directory | Who uses it | Technology |
|---|---|---|---|---|
| 1 | Platform backend | `platform/backend` | Portal and platform admin (API) | NestJS 11, TypeScript |
| 2 | Platform frontend (portal) | `platform/frontend` | People who sign up and own or run an OTA: sign-up, OTA creation, billing, keys, domains, Amadeus and Stripe connections, team | Next.js 15 App Router, TypeScript, Tailwind |
| 3 | Platform admin | `platform/admin` | Velexis staff: tenants, plans, subscriptions, shared Amadeus account and offices, Stripe settlements, provisioning jobs, audit | Next.js 15 App Router, TypeScript, Tailwind |
| 4 | OTA backend | `ota/backend` | The OTA booking API (`docs/velexis-sdk/openapi/`) for storefronts, the SDK and OTA admin, plus workers | NestJS 11, TypeScript |
| 5 | OTA frontend (storefront) | `ota/frontend` | The OTA's customers (travellers) | **Vanilla HTML + Tailwind CSS + vanilla JS**, all booking functionality through the JS SDK |
| 6 | OTA admin | `ota/admin` | The OTA's staff: bookings, Amadeus console, payments, customers, markups, storefront settings | Next.js 15 App Router, TypeScript, Tailwind; booking/console functionality through the JS SDK |
| — | JS SDK | `ota/sdk` | Storefronts (ours and third-party), OTA admin | **Vanilla JavaScript (ES modules) with JSDoc types**, no framework dependency |

Shared TypeScript libraries live in `packages/` at the repository root: config, logger, database access and tenancy, crypto and secrets, errors, and generated API contract types. The deployment files live in `deploy/`.

## 2. Answers from the product owner

| Topic | Decision |
|---|---|
| Backends | **One repository, two NestJS apps** (`platform/backend`, `ota/backend`), shared libraries, one PostgreSQL cluster and one Redis. |
| OTA storefront hosting | **One hosted multi-tenant storefront**, served by Velexis for every OTA on `<key>.ota.example.com` or a custom domain. OTAs may also build and deploy their own frontend with the SDK in any framework (Next.js, React, Angular, Vue or plain HTML). |
| Storefront technology | **Vanilla HTML + Tailwind CSS + vanilla JS** for the MVP storefront. |
| SDK | **Vanilla JS with JSDoc**, framework-agnostic. The existing TypeScript declarations in `docs/velexis-sdk/sdk/src/` are the **contract** that the JSDoc types must match. The Next.js and React helpers (`next.d.ts`, `react.d.ts`) and the Next.js example are **post-MVP references**. |
| Language of the other apps | **TypeScript** for the platform backend, frontend and admin, and for the OTA backend and admin. |
| Customer payments | **Two methods.** (a) **Stripe**: online card payment with 3-D Secure. (b) **Credit card passed to the airline through Amadeus**: the card goes into `formOfPayments` (CREDIT_CARD) on Flight Create Orders / Issue and the airline charges it. Method (b) puts card data in transit through the OTA backend, so PCI DSS scope applies. See ADR-0011 for the controls and the path to a vault or forwarding service. |
| Whose Stripe account | **Velexis's Stripe account by default** for quick onboarding. Velexis then settles to the OTA. Each OTA can later connect **its own account via Stripe Connect (Standard, OAuth) or by entering API keys**. |
| Whose Amadeus account | **Both.** By default the OTA books through **Velexis's Amadeus Enterprise account** with an office assigned to the OTA, for a quick start. An OTA can switch to **its own Amadeus credentials** (client id/secret, office ids). |
| OTA subscription billing | **Stripe Billing subscriptions**: plans map to Stripe prices, sign-up goes through Stripe Checkout, management through the Stripe Customer Portal, and webhooks keep `platform.subscriptions` and `platform.invoices` in sync. |
| Hosting | **Everything on a single VM, without Docker**: Ubuntu LTS with Node.js, PostgreSQL 16, Redis and Caddy installed natively, and apps run as systemd services. Managed services (first the database) come later. The code must keep that move to configuration only: DSNs, URLs and storage adapters. |
| Domains | **Generic placeholders** everywhere (see §4). |
| Team and plans | **Solo developer driving AI coding agents.** Plans are plain text (Markdown) so they can be audited and edited. There are two plan styles: an **agent task plan** (small, self-contained, verifiable tasks) and a **solo developer plan** (week by week). |

## 3. Existing reference material (reuse, do not redo)

| Path | What to reuse |
|---|---|
| `docs/velexis-sdk/db/platform.sql`, `reference.sql`, `tenant.sql` | The baseline DDL, validated on PostgreSQL 16: `platform` (16 tables), `reference` (7), tenant (42). Use as migration `0001` of each schema, then apply the deltas listed in the plans. |
| `docs/velexis-sdk/db/README.md`, `dictionary.json`, `er/` | The tenancy design (provisioning, migrations, routing with `SET LOCAL search_path`, security, scaling) and the ER diagrams. |
| `docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.{json,yaml}` | The OTA backend API contract: 96 operations (storefront, auth, account, reference, flights, checkout, bookings, console). Implement it, extend it spec-first. |
| `docs/velexis-sdk/sdk/src/*.d.ts`, `sdk/docs/*.md` | The SDK contract and developer guides. The vanilla JS SDK implements `index`, `shared`, `identity`, `flights`, `bookings` and `console`. |
| `docs/velexis-sdk/examples/next-storefront/` | Reference flows for the storefront and console pages (Next.js; the MVP storefront re-implements them in vanilla HTML/JS). |
| `docs/amadeus-api/*.json` | The 9 Amadeus Enterprise specs (12 operations). |
| `docs/ota-build/ota-model-1-b2c-essentials.html` | The broader B2C essentials plan. Background only; the MVP plans here are the ones to follow. |

## 4. Placeholder hosts

| Host | Serves |
|---|---|
| `platform.example.com` | Platform frontend (portal) |
| `admin.platform.example.com` | Platform admin |
| `api.platform.example.com` | Platform backend API |
| `<key>.ota.example.com` and verified custom domains | Hosted storefront (static files) plus a same-origin `/api/*` proxy to the OTA backend |
| `admin.ota.example.com` | OTA admin (multi-tenant; the OTA is chosen after sign-in) |
| `api.ota.example.com` | OTA backend API for SDK users on their own domains (publishable/secret keys) |

## 5. Cross-cutting rules

- **Tenancy**: one PostgreSQL schema per OTA (`tenant_<key>`), as in `docs/velexis-sdk/db/README.md`. The **OTA backend owns the tenant schema and its migrations**. The **platform backend owns `platform` and `reference`**. The platform backend never writes tenant schemas: it asks the OTA backend to provision or migrate one through a job queue. The OTA backend reads the platform tables it needs (tenants, domains, API keys, connections) with a read-only database role and caches them in Redis.
- **Contracts first**: API changes start in an OpenAPI document. The OTA API is in `docs/velexis-sdk/openapi/` and moves to `ota/backend/openapi/`. The platform API is created in `platform/backend/openapi/`. TypeScript types are generated from these documents, and the SDK's JSDoc types reference the generated OTA types.
- **Storefront sessions**: the hosted storefront calls the OTA backend **same-origin** (`/api/*` through Caddy). Customer sessions use **httpOnly cookies + a CSRF token**, so no token is ever readable by JavaScript. Third-party frontends use publishable keys plus bearer tokens, or their own server with a secret key.
- **Secrets**: Amadeus and Stripe credentials are envelope-encrypted in the database with a master key held outside the database (a file readable only by the service user on the VM; a KMS later). Raw card data is never stored or logged.
- **Single VM**: no Docker. systemd units, Caddy (automatic and on-demand TLS for custom domains), local PostgreSQL and Redis, nightly backups copied off the VM.
