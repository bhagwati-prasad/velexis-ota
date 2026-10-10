# Velexis OTA SDK: multi-tenant database, booking API and `@velexis/ota-sdk`

This folder contains the design for a multi-tenant OTA built as a **NestJS + Next.js monolith** on Amadeus Enterprise. When a person signs up on the Velexis portal, they get their own OTA. Each OTA builds its Next.js storefront and its Amadeus-like staff console with one JS SDK.

Open **`index.html`** (offline, single file) for the full documentation. It has the ER diagrams, the data dictionary, the SDK reference, the guides, the example app, the Amadeus coverage table and the SQL. **`api.html`** is the offline OpenAPI reference.

## What is here

| Path | Content |
|---|---|
| `db/tenant.sql` | The tables of **one OTA's own schema** `tenant_<key>` (42 tables: customers, sessions, saved travellers, consents, searches, offers, priced offers, checkouts, payments, refunds, bookings, travellers, segments, ancillaries, tickets, documents, events, guest tokens, supplier request log, markups/fees, notifications, staff audit, queue snapshots, settings, idempotency). Run it inside each tenant schema. |
| `db/platform.sql` | The shared control plane `platform` (16 tables): portal accounts, tenants, staff memberships and roles, plans and billing, API keys (publishable / secret / hosting) and their grants, encrypted Amadeus and payment-provider connections, the per-tenant migration ledger, provisioning jobs and audit. It holds no end-customer PII. |
| `db/reference.sql` | The shared read-only `reference` schema (7 tables): airports, cities, countries, airlines, aircraft, currencies, time zones. |
| `db/er/*.mmd` / `*.svg` | ER diagrams for the tenancy overview, `platform`, `reference` and the tenant schema (Mermaid source and rendered SVG). |
| `db/README.md`, `db/dictionary.json` | The tenancy design (why schema-per-tenant, provisioning, migrations, routing with `SET LOCAL search_path`, security, scaling) and a description of every table and column. |
| `openapi/velexis-ota-booking-api.openapi.(json\|yaml)` | The REST contract (OpenAPI 3.1) that NestJS implements: 96 operations. Each one names its SDK method (`x-sdk-method`), the Amadeus calls it makes (`x-amadeus`), the tenant tables it touches (`x-tenant-tables`) and who may call it (`x-scope`). |
| `sdk/src/*.d.ts` | The SDK contract: `createVelexisClient` with the `storefront`, `auth`, `account`, `reference`, `flights`, `checkout`, `bookings` and `console` namespaces, plus `@velexis/ota-sdk/next` (server client, httpOnly-cookie sessions, proxy route, auth routes, middleware) and `@velexis/ota-sdk/react` (provider + booking-flow hooks). `api-types.d.ts` is generated from the OpenAPI document. |
| `sdk/docs/*.md` | Developer guides: Next.js integration, storefront/auth/account/reference, flight shopping, checkout and bookings, console. |
| `examples/next-storefront/` | A Next.js 15 App Router storefront and console written only against the SDK: search → results → offer + upsell → price → checkout (travellers, contacts, bags/services/seats, payment) → booking → my trips (upcoming / past / cancelled) → detail / change / cancel, guest lookup, account; console bookings, PNR lookup, order patch/issue/cancel, queues, availability and raw Amadeus. |

## Key decisions

- **Schema per tenant.** Every OTA gets `tenant_<key>` with its own copy of all its user-specific tables. No foreign key crosses schemas, so each OTA can be dumped, restored, moved or erased on its own. NestJS resolves the tenant from `X-Api-Key` (or the host) and runs each request in a transaction with `SET LOCAL search_path TO tenant_<key>, reference`.
- **Keys and scopes.** Publishable `pk_…` keys work in the browser and in customer scope only. Secret `sk_…` keys are server-only, act in customer scope by default and reach console scope with a staff token. Key scopes (`storefront`, `console`, `console:automation`) limit what each key can do. Hosting `hk_…` keys let one deployment serve many OTA domains.
- **Amadeus fidelity.** Customer flows use typed, normalised resources that wrap the verbatim Amadeus payloads (`Amadeus*` schemas converted from `docs/amadeus-api`). Customer scope sees selling prices; console scope sees net prices and markups. The console also has a raw pass-through for every Amadeus operation, so every Amadeus parameter and body field is reachable. All 12 operations of the 9 specs are covered.

## How it was checked

- The DDL was run on PostgreSQL 16: `platform.sql` + `reference.sql`, then `tenant.sql` provisioned into two tenant schemas. The schemas are identical, there are no cross-schema foreign keys, every table has a primary key, the diagrams match the real tables and foreign keys, and every table and column has a description (`db/check_db.py`; needs a local PostgreSQL 16 on port 5433).
- The OpenAPI document lints clean with Redocly. TypeScript types are generated from it with openapi-typescript, and all SDK declarations compile against them with `tsc --strict`. Every API operation maps to exactly one SDK method.
- The example Next.js app type-checks against the SDK with the real `next@15` / `react@19` types.
- Three independent reviews ran: Amadeus field-level coverage, database ⇄ API consistency plus tenancy and security, and SDK/API consistency. Their 74 findings were fixed.

## Status

This is the **contract and design**: database DDL, ER diagrams, API specification and SDK type declarations, with guides and a type-checked example app. The SDK runtime (the JS implementation of these declarations) and the NestJS services are the next step to implement against this contract.
