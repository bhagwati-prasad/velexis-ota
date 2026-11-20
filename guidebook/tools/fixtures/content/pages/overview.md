---
id: overview
title: Overview
summary: What Velexis is, how its applications fit together and how to read this guidebook.
order: 1
---

Velexis is a multi-tenant [[ota|online travel agency]] platform. A person signs up on the [[app:portal]], creates an
OTA (a [[tenant]] with its own [[tenant-schema]]) and sells flights through a hosted storefront.

## How the system fits together

The [[app:portal]] is a Next.js [[bff]] in front of the [[app:platform-api]]. Every request that touches tenant data
goes through `tenantTx` (see `repo:packages/db/src/index.ts`).

```diagram
portal/neighbours
```

| Layer | Apps | Notes |
|---|---|---|
| Frontends | [[app:portal]] | Server-side rendered, talks to the API from the server only |
| APIs | [[app:platform-api]] | NestJS, PostgreSQL, Redis queues ([[bullmq]]) |

## Reading this guide

Each app has a **Usage** tab (what to click, what should happen), an **Architecture** tab (where the code is, which
tables change) and a **Facts** tab (screens, endpoints, roles). Cross-app walkthroughs live under
[[journey:sign-up-and-create-ota]].

```tip
Press **Ctrl+K** (or **Cmd+K**) anywhere to search pages, terms, screens and endpoints.
```

```note
Development passwords quoted in this guide are **development only**; they come from the committed seeds.
```

## Key ideas

- **Tenancy:** one PostgreSQL schema per OTA, `tenant_<key>` ([[schema-per-tenant]]).
- **Identity:** portal [[account|accounts]] own [[membership|memberships]] in tenants.
- **Money:** subscriptions are billed through [[stripe]]; see [[diagram:portal/ota-status]] for the OTA lifecycle.

```warning
The platform never touches tenant schemas, and the OTA backend never writes platform tables.
```
