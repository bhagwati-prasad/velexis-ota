# ADR-0003: Six components and two NestJS backends

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (components, technologies, two backends), lead architect (boundaries and integration rules)

## Context

[`decisions.md`](../decisions.md) §1 defines six components in two groups plus a JS SDK, and §2 chooses one repository with **two NestJS apps**, shared libraries, one PostgreSQL cluster and one Redis. §5 fixes data ownership: the platform backend owns `platform` and `reference`, the OTA backend owns the tenant schemas, and they talk through a job queue and read-only access.

This ADR fixes the responsibilities of each component and how the two backends may interact, so that agents working on one side never reach into the other.

## Decision

### Responsibilities

| Component | Plane | Owns | Talks to |
|---|---|---|---|
| Platform backend (`platform/backend`) | Control plane | `platform` and `reference` schemas and their migrations; portal accounts, MFA and sessions; tenants, memberships, invitations; plans, Stripe Billing subscriptions and invoices; API keys; domains and the Caddy `ask` endpoint; Amadeus and Stripe connections (encrypted); provisioning orchestration; platform audit; reference data loading | PostgreSQL (`platform`, `reference`), Redis, Stripe, SMTP, the OTA backend through queues |
| Platform frontend (`platform/frontend`) | Control plane UI | Portal pages | Platform backend only (server side) |
| Platform admin (`platform/admin`) | Control plane UI | Velexis staff pages | Platform backend only (server side) |
| OTA backend (`ota/backend`) | Data plane | The OTA booking API ([OpenAPI](../../velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)); tenant schemas, their provisioning DDL and migrations; Amadeus client; customer payments; booking workers; tenant e-mails and documents | PostgreSQL (tenant schemas read/write, `reference` and listed `platform` tables read-only), Redis, Amadeus, Stripe, SMTP |
| OTA frontend (`ota/frontend`) | Data plane UI | Hosted multi-tenant storefront (static files) | OTA backend through the SDK, same origin `/api/*` |
| OTA admin (`ota/admin`) | Data plane UI | OTA staff pages | OTA backend through the SDK (server side) |
| JS SDK (`ota/sdk`) | Library | Client for the OTA booking API | OTA backend |

### Process model

Each backend is **one codebase with two entry points**: `main.ts` (HTTP API) and `worker.ts` (BullMQ workers and schedulers). They run as two systemd services from the same build, so a slow job never blocks API requests and a crashing worker never takes the API down ([ADR-0007](0007-single-vm-without-docker.md), [ADR-0009](0009-background-jobs-bullmq.md)).

### Integration rules between the backends

1. **No synchronous HTTP between the backends** in the MVP. They share no in-process code except `packages/*`.
2. **Platform → OTA: BullMQ queue `ota-tenant-ops`** (provision, migrate, and later suspend, export and delete). **OTA → platform: queue `platform-tenant-events`** (provisioned, failed, migrated, and later usage events). The message contracts live in `@velexis/api-types/jobs` ([ADR-0009](0009-background-jobs-bullmq.md)).
3. **OTA reads platform data through a read-only database role** (`velexis_ota_app` has `SELECT` on the platform tables it needs) and caches it in Redis with short TTLs. The platform backend publishes invalidations on a Redis pub/sub channel whenever it changes one of those rows ([ADR-0004](0004-postgresql-schema-per-tenant.md)).
4. **Short-lived handoffs go through Redis**: the one-time portal token for OTA admin SSO is written by the platform backend and consumed once by the OTA backend ([ADR-0008](0008-identity-accounts-customers-sessions.md)).
5. **The OTA backend never writes platform tables.** Anything the platform must record (provisioning results, schema versions, API key usage) is sent as a queue message or a Redis counter that the platform worker persists.
6. **The platform backend never reads or writes tenant schemas.** Its database role has no privileges on them. Money facts it needs for settlements come from Stripe ([ADR-0011](0011-payments-stripe-and-airline-card.md)), not from tenant tables.

### Front-end rules

- Next.js apps call their backend **only from server code** (server components, server actions, route handlers). No token is readable by browser JavaScript ([ADR-0014](0014-frontend-stack-nextjs-tailwind.md)).
- The storefront and the OTA admin use **only the SDK** for booking and console functions, as `decisions.md` requires.

## Consequences

### Positive

- Clear ownership. An agent working on a task in `ota/` never needs platform write access, and the reverse.
- The database enforces the main boundary through role privileges.
- Either backend can be deployed or restarted without the other being up. Queues buffer the work.

### Negative

- Provisioning is asynchronous, and results come back through a second queue. This is more moving parts than a direct call, so it needs a reconciler for lost messages ([ADR-0009](0009-background-jobs-bullmq.md)).
- Platform data seen by the OTA backend can be up to one cache TTL stale if an invalidation is lost. TTLs are kept at 60 s.
- Two NestJS apps duplicate some wiring (config, logging, health). Shared packages keep that small.

### Follow-ups

- Decided during planning; revisit the "no synchronous HTTP" rule when a portal feature needs live OTA data (for example booking statistics on the portal dashboard). The likely answer is an internal, authenticated OTA endpoint, recorded in a new ADR.

## Alternatives considered

- **One NestJS monolith** (as in `docs/velexis-sdk/README.md`). Rejected by the product owner in favour of two apps with separate ownership.
- **Internal HTTP APIs between the backends.** Creates temporal coupling and needs service authentication. Queues are already needed for provisioning.
- **Platform backend writes tenant schemas.** Rejected by `decisions.md` §5: the OTA backend owns them.

## References

- [`../decisions.md`](../decisions.md) §1, §2, §5
- [`../architecture.md`](../architecture.md)
- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §3–§6
