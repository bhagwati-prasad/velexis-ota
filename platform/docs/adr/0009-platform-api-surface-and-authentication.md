# PADR-0009: Platform API surface and authentication

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when a third party (not the portal or admin) must call the platform API, or when the portal moves to a separate host.

## Context

[ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md) creates the platform document `platform/backend/openapi/velexis-platform-api.openapi.yaml` with the OTA document's conventions and `x-scope` values `portal`, `platform_admin` and `internal`. [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) fixes token mechanics (EdDSA JWTs for 15 minutes, rotating refresh tokens, BFF cookies in the Next.js apps). [ADR-0003](../../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md) forbids synchronous HTTP between backends. The shape of the surface itself (paths, versioning, how tenant roles are checked, lifetimes, idempotency, errors) needed one decision so that the portal, the admin and the backend agree.

## Decision

1. **One API, four surfaces**, all served by the platform API process on port 3100:

   | Surface | Prefix | `x-scope` | Callers |
   |---|---|---|---|
   | Portal | `/v1/…` (except `/v1/admin`) | `portal` (and `public` for sign-up, sign-in, plans, invitation lookup) | Portal server only |
   | Admin | `/v1/admin/…` | `platform_admin` | Platform admin server only |
   | Webhooks | `/webhooks/stripe/…` | `webhook` (documented with `x-internal: true`) | Stripe |
   | Internal | `/internal/…`, `/health/…` | `internal` | Caddy, health checks |

   The `public` value is added to the document's scope list; `webhook` is a documented extension.
2. **Version in the path** (`/v1`). Changes are additive; a breaking change needs a new ADR and `/v2` for the affected operations.
3. **No browser calls the API directly.** There is no CORS configuration: browsers reach only the Next.js servers, which call the API server-side with `Authorization: Bearer`. The API still sets `Cache-Control: no-store` on authenticated responses.
4. **Tokens.** Access tokens: EdDSA, 15 minutes, `aud` `portal` or `platform_admin`, claims of [`../architecture.md`](../architecture.md) §3.1. Refresh tokens: opaque 256-bit, SHA-256 in `account_sessions`, rotated on every use, reuse revokes the family. Family lifetimes: **portal 30 days** absolute, refresh token idle expiry 7 days; **admin 12 hours** absolute, idle 2 hours. Password change or reset, MFA reset and account disable revoke all families.
5. **Tenant authorisation** is path-based: every tenant resource lives under `/v1/tenants/{tenantId}/…`. `TenantRoleGuard` reads the caller's membership from PostgreSQL on each request (no cache, so removals act at once) and checks the roles declared with `@TenantRoles(...)`. Non-members get `404 NOT_FOUND`. The role matrix is [`../scope.md`](../scope.md) §1.2, encoded once in `memberships/tenant-roles.ts` and reused by guard, tests and portal navigation.
6. **Conventions** as the OTA document: camelCase JSON, prefixed ULIDs, decimal-string money, ISO UTC times, cursor pagination `{data, page: {nextCursor, limit}}`, error envelope `{error: {code, message, status, requestId, details, fieldErrors}}`.
7. **Errors.** The platform document has its own `x-error-catalogue` ([`../api-inventory.md`](../api-inventory.md) §3), reusing the OTA code and status where the meaning is the same. `@velexis/errors` generates both catalogues; platform-only codes are exported from `@velexis/errors/platform`.
8. **Idempotency.** `Idempotency-Key` is required on `createTenant` and `createCheckoutSession`, stored in Redis for 24 h per account (`vx:idem:<accountId>:<key>`, request hash + response). Other creates are naturally safe to repeat or are not replayed because they return secrets (API keys).
9. **Concurrency.** Versioned resources return `ETag: "<version>"`; PATCH requires `If-Match` (`412 PRECONDITION_FAILED`).
10. **Rate limits** with `@nestjs/throttler` on Redis, per IP and per account ([`../api-inventory.md`](../api-inventory.md) §2).
11. **Responses never contain secrets** except the once-only fields named in the inventory, all `no-store`. Masked forms (`last4`, client id) are used everywhere else.
12. **Generated client.** The portal and the admin use `openapi-fetch` typed by `@velexis/api-types/platform` in `lib/api.ts` (`server-only`).

## Consequences

### Positive

- One document and one client for both Next.js apps; the admin and portal surfaces cannot be confused because tokens carry different audiences.
- Path-based tenant scoping makes authorisation reviewable route by route and testable with one matrix.

### Negative

- Membership is read on every tenant request (one indexed query); fine at MVP load.
- No public platform API for partners in the MVP.

### Follow-ups

- If partners need the platform API (for example to create OTAs programmatically), add API credentials with their own scope in a new ADR.

## Alternatives considered

- **Two APIs (portal API and admin API) in separate processes.** More isolation, but another systemd unit and deploy step for one developer; audiences and guards give enough separation.
- **Tenant id in a header or the token.** Path parameters are explicit in the document and in logs.
- **GraphQL for the dashboards.** Different tooling from the OTA side; REST + OpenAPI keeps one contract style ([ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md)).

## References

- [ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md), [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [ADR-0014](../../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md)
- [`../api-inventory.md`](../api-inventory.md), [`../architecture.md`](../architecture.md) §3
