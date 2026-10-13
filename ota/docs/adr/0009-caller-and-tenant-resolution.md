# OADR-0009: Caller and tenant resolution

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when hosting keys (`hk_`) or custom API hosts are built, or when the OTA backend runs on more than one machine.

## Context

The contract resolves the tenant and environment from `X-Api-Key` (db README §5) and forbids resolving from the host alone. The MVP adds two first-party callers: the storefront edge, whose tenant comes from the verified host and whose environment is `tenants.storefront_environment` ([ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)), and the OTA admin's service key with a staff token and a per-request environment ([ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md)). The OTA backend reads platform tables with a read-only role and caches them in Redis for 60 s, invalidated through `vx:invalidate` ([architecture §4](../../../docs/mvp/architecture.md#4-data-ownership)). The order of checks, the cache layout and the behaviour on cache or database errors must be fixed once for every module.

## Decision

1. **`CallerGuard` classifies every request** before anything else, in this order, and refuses ambiguous combinations (`400 INVALID_REQUEST` when an edge header and an API key are both present):
   1. `X-Velexis-Edge` present → must equal `VELEXIS_EDGE_SECRET` (constant time) → **edge**; `X-Velexis-Host` required.
   2. `X-Api-Key` equals `OTA_ADMIN_SERVICE_KEY` (constant time) and the socket peer is `127.0.0.1` → **service**.
   3. `X-Api-Key` with a `pk_`/`sk_` prefix → **key** (prefix lookup, HMAC-SHA-256 with the pepper, constant-time compare, revocation, expiry, origins for `pk_`).
   4. Route marked public (`/v1/assets/*`, `/v1/files/*`, `/health/live`) or webhook → **anonymous** with its own verification.
   5. Anything else → `401 INVALID_API_KEY`.
2. **`TenantGuard`** resolves the tenant:

   | Caller | Tenant | Environment |
   |---|---|---|
   | edge | `host:<hostname>` → verified `tenant_domains` row with `purpose = storefront`, or `<key>.<STOREFRONT_BASE_DOMAIN>` → `tenantkey:<key>` | `tenants.storefront_environment` |
   | service | staff token `tid` (or the redeemed portal token on sign-in) | `X-Velexis-Environment` |
   | key | the key's `tenant_id` | the key's `environment` |

   Unknown host → `403 HOST_NOT_ALLOWED`. Custom domains are resolved only for `active` tenants ([PADR-0014](../../../platform/docs/adr/0014-tenant-suspension-and-resume.md)); sub-domains of suspended tenants resolve so the storefront can show its maintenance page from `403 TENANT_SUSPENDED`.
3. **Tenant context** in `nestjs-cls`: `{tenantId, key, schemaName, environment, caller: {type, id}, actor: {type, id}, requestId}`. Repositories and `tenantTx` read it; nothing else takes a schema name.
4. **Caches.** Redis keys `tenant:<id>`, `tenantkey:<key>`, `host:<hostname>`, `apikey:<prefix>`, `member:<accountId>:<tenantId>`, `conn:*` with a 60 s TTL; negative answers (unknown host or prefix) are cached for 10 s to absorb scans. A subscriber on `vx:invalidate` deletes the matching keys for every type of [platform architecture §6.3](../../../platform/docs/architecture.md#63-cache-invalidation-vxinvalidate), including `account`, `amadeus_account` and `plan`.
5. **Degraded mode.** If Redis is down, lookups go to PostgreSQL directly (short platform transactions); if PostgreSQL is down, requests fail with `503`. Cached entries are never used past their TTL.
6. **Key usage.** Each successful key request sets `apikey:used:<keyId>` (`{at, ip}`, TTL 1 day) at most once a minute per key; the platform worker flushes it ([architecture §4](../../../docs/mvp/architecture.md#4-data-ownership)).
7. **Session tokens** must carry `tid` equal to the resolved tenant; staff tokens are also checked against `staffdeny:acct:<accountId>`, `staffdeny:tenant:<tenantId>` and the cached membership (active, role).

## Consequences

### Positive

- One guard decides who the caller is; modules never inspect headers.
- First-party secrets are checked before any database access, so they cannot be used to probe keys.
- Invalidation keeps changes (suspension, key revocation) effective within seconds, and at most 60 s.

### Negative

- The edge secret and service key are powerful shared secrets; they live only in environment files and are rotated by restarting the services that hold them.
- Falling back to PostgreSQL when Redis is down adds load exactly when the system is degraded; acceptable at MVP traffic.

### Follow-ups

- Hosting keys and custom API hosts (db README §5) when an agency needs them.

## Alternatives considered

- **Host-only resolution for every caller.** Rejected by the contract: the environment and connections must follow the key.
- **Injecting a hosting key at Caddy.** Rejected in ADR-0018 (the storefront environment is a per-tenant switch).
- **No negative caching.** Unknown-host scans would hit PostgreSQL on every request.

## References

- [db README §5](../../../docs/velexis-sdk/db/README.md), [ADR-0004](../../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md), [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)
- [platform architecture §6](../../../platform/docs/architecture.md#6-integration-with-the-ota-backend), [`../architecture.md`](../architecture.md) §3
