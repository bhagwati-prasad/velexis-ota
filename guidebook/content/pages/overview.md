---
id: overview
title: Velexis at a glance
summary: What Velexis is, who uses it, the ten parts of the monorepo and how they connect, and how to read this guide.
order: 10
---

## What Velexis is

Velexis is a **multi-tenant platform that sells and runs online travel agencies**. A person signs up on the Velexis
**portal**, creates an OTA (a [[tenant]]), and Velexis provisions everything that OTA needs: its own database schema
([[tenant-schema]]), a hosted [[storefront]] on `<key>.ota.example.com`, an [[amadeus-office]] on the shared
[[amadeus-enterprise]] account, a [[stripe]] payment connection and two test [[api-key|API keys]]. The OTA then sells
flights to travellers and runs its operations (bookings, tickets, refunds, markups, storefront branding) in the
**OTA admin**.

So there are **two products in one repository**:

| Product | Directory | What it is | Main users |
|---|---|---|---|
| **Velexis platform** (control plane) | `platform/` | Sign-up, OTA creation, billing, keys, domains, Amadeus and Stripe connections, team, and the back office for Velexis staff | OTA owners, Velexis staff |
| **Velexis OTA** (data plane) | `ota/` | The booking API, the hosted storefront, the OTA admin and the JS SDK that every OTA uses | Travellers, OTA staff, third-party developers |

The authoritative statement of this split is `repo:docs/mvp/decisions.md` (§1, §2, §5); the architecture is in
`repo:docs/mvp/architecture.md`. Both win over anything else, this guide included.

```note
Everything runs on **one Ubuntu VM without Docker** in production (Caddy, PostgreSQL 16, Redis 7.4, seven Node
services under systemd), and natively on a developer machine for local work. Hosts in this guide are placeholders
(`*.example.com`); locally everything is `localhost`.
```

## Who uses it (actors)

| Actor | Uses | Through |
|---|---|---|
| **OTA owner** and their team (portal users) | Sign-up, create an OTA, billing, API keys, domains, Amadeus and Stripe connections, team, "Open console" | [[app:portal]] |
| **Velexis staff** ([[app:platform-admin]] users, MFA mandatory) | Tenants, plans, subscriptions, the shared Amadeus account and its office pool, settlements, provisioning jobs, queues, audit | [[app:platform-admin]] |
| **OTA staff** (portal accounts with a [[membership]] and a [[staff-role]]) | Bookings console, PNR import, queues, payments, customers, markups and fees, storefront settings, templates | [[app:ota-admin]], reached by [[sso]] from the portal |
| **Traveller** (guest or signed-in [[customer]]) | Search, price, book, pay, my bookings, guest lookup, change contacts, cancel | [[app:storefront]] |
| **Third-party developer** | Their own storefront or automation | [[app:sdk]] + the OTA API with `pk_`/`sk_` keys |
| **External systems** | Amadeus Enterprise (flights), Stripe (billing and payments), SMTP (e-mail), Let's Encrypt (certificates), public DNS (custom domains) | Backends only |

## The ten parts of the monorepo

Every part has its own section in this guide (usage guide + architecture guide). The ids below are used everywhere
(links, diagrams, the knowledge graph).

| App id | Directory | Kind | Local port | In one line |
|---|---|---|---|---|
| [[app:platform-api]] | `platform/backend` | NestJS API + worker | 3100 (worker health 3101) | Accounts, MFA, tenants, provisioning orchestration, keys, domains, connections, billing, settlements, audit |
| [[app:portal]] | `platform/frontend` | Next.js 15 (BFF) | 3000 | The OTA owner's site: sign-up, create OTA, set-up, keys, domains, team, billing, go-live, "Open console" |
| [[app:platform-admin]] | `platform/admin` | Next.js 15 (BFF) | 3001 | Velexis staff's back office |
| [[app:ota-api]] | `ota/backend` | NestJS API + worker | 4000 (worker health 4001) | The OTA booking API (136-operation OpenAPI contract: 117 implemented, 19 deferred), tenant schemas, Amadeus, Stripe, e-mails, documents |
| [[app:ota-admin]] | `ota/admin` | Next.js 15 (BFF, SDK on the server) | 3002 | The OTA staff console |
| [[app:storefront]] | `ota/frontend` | Static HTML + Tailwind + vanilla JS | 5173 (dev), 4173 (preview) | The hosted multi-tenant storefront travellers use |
| [[app:sdk]] | `ota/sdk` | Vanilla JS library | — | `@velexis/ota-sdk`: one method per API operation; cookie, token and server modes |
| [[app:packages]] | `packages/*` | Shared libraries | — | config, logger, db ([[tenant-tx]]), crypto, errors, api-types, testing |
| [[app:tools]] | `tools/*` | Developer tooling | 4900 (stub) | [[amadeus-stub]], Playwright e2e, reference data, plan-lint, CI and perf scripts, dev keys |
| [[app:deploy]] | `deploy/*` | Infrastructure | 80/443 | The single VM: [[caddy]] with the [[waf]], systemd units, provisioning, deploy, backups, monitoring |

## How the parts connect

```
 Traveller ──► Storefront (static) ──same-origin /api──► Caddy ──► OTA API ──► Amadeus, Stripe
 OTA staff ──► OTA admin (Next.js server) ──SDK + service key──► OTA API
 OTA owner ──► Portal (Next.js server) ──BFF key──► Platform API ──► Stripe (billing, Connect)
 Velexis staff ─► Platform admin ──────────────────► Platform API
 Platform API/worker ══ BullMQ ota-tenant-ops ══► OTA worker (provision, migrate, suspend, resume)
 OTA worker ══ BullMQ platform-tenant-events ══► Platform worker (results)
 Platform ── vx:invalidate (Redis pub/sub) ──► OTA API caches
 OTA API ──read-only role──► platform tables (tenants, domains, keys, connections, memberships)
```

The rules behind these arrows (see [[page:concepts]] for each):

1. **Data ownership.** The platform backend owns the `platform` and `reference` schemas; the OTA backend owns every
   `tenant_<key>` schema. The platform never touches a tenant schema; the OTA backend never writes a platform table. It
   reads the platform rows it needs with a read-only role and caches them for 60 s in Redis.
2. **Work across the line goes through queues.** Provisioning, migration, suspension and resume of a tenant are
   [[bullmq]] jobs on `ota-tenant-ops`; results come back on `platform-tenant-events`.
3. **Cache freshness goes through [[vx-invalidate]].** Every platform change to a cached row publishes an
   invalidation, so a revoked key or a suspended OTA stops working within about a second (60 s at worst).
4. **Contracts first.** The OTA API's contract is `repo:ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`; the
   platform API's is `repo:platform/backend/openapi/velexis-platform-api.openapi.yaml`. Types in
   `repo:packages/api-types` are generated from both.
5. **No token readable by browser JavaScript.** Portal, platform admin and OTA admin are backends-for-frontends
   ([[bff]]) holding tokens in [[host-cookie|`__Host-` httpOnly cookies]]; the storefront uses httpOnly cookies plus a
   [[csrf-token]].

The interactive system map on the home page (and the 3D view) draws the same picture from
`content/system/topology.json`, with animated flows: search and book, OTA provisioning, staff SSO, Stripe webhooks
and platform billing.

## The life of an OTA in one paragraph

An owner signs up and verifies their e-mail (Mailpit locally), creates an OTA with a [[tenant-key]] (`acme`); the
platform inserts the tenant (`provisioning`) and a [[provisioning-job]] and asks the OTA worker to create
`tenant_acme`. The platform worker then assigns a test Amadeus office from the [[office-pool]], creates a Stripe
connection in Velexis mode, issues `pk_test_`/`sk_test_` keys and sets the tenant `active`. The storefront at
`acme.ota.example.com` works at once in the **test** [[storefront-environment]]. The owner tunes markups and branding in
the OTA admin, travellers book (Stripe or the [[airline-card]]), the worker issues tickets and e-mails documents, staff
manage bookings in the console. When the preconditions are met (live Amadeus office, live payments, a plan with live
mode, an active subscription, MFA), the owner presses [[go-live]].

## How to read this guide

| You want to… | Go to |
|---|---|
| Get the whole stack running on your machine | [[page:getting-started]] |
| Understand a cross-cutting idea (tenancy, sessions, money, payments, Amadeus, queues, errors, keys, security) | [[page:concepts]] |
| Hunt bugs efficiently: what to capture, how to inspect the DB, Redis, Mailpit and logs | [[page:bug-hunting]] |
| Walk an end-to-end scenario across several apps, step by step, ticking pass / bug | **Journeys**, starting with [[journey:run-the-stack]] |
| Learn one app: every screen, what to try, what should happen | The app's **Usage** tab (for example [[app:portal]]) |
| Find where to fix something: modules, tables, flows, configuration | The app's **Architecture** tab, section "Where to change things" |
| Look up a word | **Glossary** (hover any dotted link such as [[tenant-schema]]) |
| See how concepts relate | **Taxonomy**, **Ontology** and **Knowledge graph** |

Suggested order for a full bug-hunting pass:

1. [[journey:run-the-stack]] → [[journey:signup-and-provision]] → [[journey:amadeus-and-stripe-connections]]
2. [[journey:storefront-settings-and-markups]] → [[journey:book-with-airline-card]] → [[journey:book-with-stripe]]
3. [[journey:console-manage-booking]] → [[journey:my-bookings-change-and-cancel]]
4. [[journey:team-and-console-sso]] → [[journey:api-keys-and-sdk]] → [[journey:suspend-and-resume-ota]] →
   [[journey:custom-domain-and-go-live]]

```tip
Each journey step lists the URL, what to type, what you should see, which tables, e-mails and queues change, and the
code paths behind it. Mark each step Pass, Bug or Skip; the "Copy bug report" button formats the step with its
expected result and your notes as "Actual". Check [Known issues](#/issues) before you file a new bug.
```

## Status and sources of truth

- The code at commit `f72d3f2a` is the reference for this guide. Where a document and the code disagree, the guide
  follows the code and says so.
- The planning documents (milestones M0 to M6, task ids such as `PBE-`, `OBE-`, `PFE-`, `OAD-`, `OFE-`, `SDK-`, `X-`) are
  in `repo:docs/mvp/README.md`, `repo:platform/docs/plans` and `repo:ota/docs/plans`.
- Some features are behind [[feature-switch|milestone switches]] that are **off by default locally**: Stripe Billing,
  the OTA's own Stripe, settlements, own Amadeus credentials, custom domains and the live switch. Turn one on in
  `platform/backend/.env.local` to test it.

```warning
The root `README.md` still says "planning is done; implementation starts with M0". That is out of date: every
component exists and the end-to-end suite covers all of them. Trust the code and the component READMEs.
```
