# PADR-0004: Custom-domain verification

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when sign-ups approach 30 per week (wildcard certificate, ADR-0018 follow-up), or when OTAs ask for API or console hosts on their own domains.
**Revisions:** 2026-10-12 (planning review): point 6 validates the host before any lookup and caches only positive answers in Redis, because the catch-all site lets any client put any name in a TLS handshake.

## Context

[ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md) fixes the custom-domain lifecycle at a high level: a `tenant_domains` row with a verification token, a CNAME and a `_velexis` TXT record, a `platform-domains` job every 5 minutes for 72 hours, Caddy on-demand TLS gated by the platform's `ask` endpoint, a daily TLS probe, and an optional primary domain. It leaves open the exact checks, apex domains, what happens when DNS later changes, host name validation, caching and cleanup.

## Decision

1. **Host name rules** (on add): lower-case, IDN to punycode, no trailing dot, valid labels, at least two labels, 253 characters at most; not an IP; not `STOREFRONT_BASE_DOMAIN` or below it; not any Velexis host of [`decisions.md`](../../../docs/mvp/decisions.md) §4; not on a deny list of shared hosting suffixes kept in code (where ownership of a sub-domain does not prove anything). Only `purpose = 'storefront'` in the MVP.
2. **Two proofs, both required:**
   - **Ownership:** `TXT _velexis.<host>` contains `vx-verify-<32 base32 characters>` (the row's `verification_token`).
   - **Routing:** the CNAME chain of `<host>` ends at `<key>.ota.example.com`, **or** its `A`/`AAAA` records are all within `STOREFRONT_IPV4` / `STOREFRONT_IPV6` (apex domains cannot have a CNAME). The portal shows both options.
3. **Resolver.** `node:dns` `Resolver` with `DNS_RESOLVERS` (public resolvers such as `1.1.1.1, 8.8.8.8`), 5 s timeout, no use of the VM's caching resolver, so a fresh record is seen quickly and a stale local cache never verifies a domain.
4. **Window.** `verification_deadline_at = created + 72 h`. Pending domains are checked every 5 minutes (one job per domain, concurrency 4) and on "Check now" (1 per minute per domain). Past the deadline → `failed`; "Check now" restarts the window with the same token. Failed domains older than 7 days are deleted so the host name is free again.
5. **Re-check.** Verified domains are re-checked daily; three consecutive failures → `failed`, the primary flag returns to the sub-domain, owners are e-mailed. One success resets the counter. This tolerates short DNS incidents and stops serving hosts that no longer point to Velexis.
6. **`ask` endpoint** answers `200` for: sub-domains of tenants in `provisioning`, `active` or `suspended`; verified custom storefront domains of `active` tenants whose plan has `customDomains > 0`, with `FEATURE_CUSTOM_DOMAINS` on. Everything else, including malformed input, is `404`.
   - **Input first.** The `domain` value is checked before any cache or database access: lower-cased, at most 253 characters, labels of 1–63 characters of `a-z`, `0-9` and inner `-` (punycode allowed), at least two labels, not an IP address. A failure answers `404` at once and is not cached anywhere.
   - **Positive answers only in Redis.** A `200` is cached 60 s in `tlsask:<host>`. The platform deletes that key itself whenever it changes a domain or a tenant's status (in addition to `vx:invalidate`).
   - **Negative answers stay in the process.** A `404` for a well-formed host goes into a bounded in-process LRU cache in the API (10 000 entries, 60 s). The `vx:invalidate` subscriber that clears `tlsask:` keys also drops matching entries from it, so a newly verified domain or a new tenant is not refused for the rest of the minute. Unknown names in TLS handshakes cost no Redis memory. Caddy's catch-all `https://` site sends every unknown SNI here, and Caddy 2.8 has no on-demand rate limit, so negative answers would otherwise fill the shared `noeviction` Redis that BullMQ needs.
   - The flood case is bounded by the LRU size and one indexed lookup per new name. `tlsAsk` is not throttled per IP, because its only caller is Caddy on loopback.
7. **Warm-up and probe.** One minute after verification, and daily, a TLS probe connects to `127.0.0.1:443` with the host as SNI. The first probe triggers on-demand issuance, so travellers do not wait for it; the probe records `tls_status`, `tls_expires_at`, `tls_checked_at`. Renewals are Caddy's job.
8. **Primary.** Only verified domains; one primary storefront host per tenant (existing partial unique index). Removing or failing the primary custom domain makes the sub-domain primary again.
9. **Uniqueness.** One tenant per host name (existing unique index). A pending claim blocks other tenants until it fails and is cleaned up, or an admin removes it.

## Consequences

### Positive

- A domain is served only when its owner proved control and it actually points to Velexis, which protects ACME rate limits and stops domain hijacking through stale DNS.
- Apex domains work without a DNS provider's CNAME flattening.
- The traveller's first visit already has a certificate.

### Negative

- Apex domains break if the VM's address changes; owners must update A/AAAA records (the portal warns). A move to a new VM must keep or announce the address.
- Squatting: someone can add a host they do not own and block it for up to 72 hours plus 7 days. Admins can remove such claims.
- Public resolvers are an external dependency of verification (not of serving).

### Follow-ups

- 301 redirect from the sub-domain to the primary custom domain (ADR-0018 follow-up), implemented in Caddy or the storefront when needed.
- Wildcard certificate for `*.ota.example.com` when sign-ups grow (ADR-0018).

## Alternatives considered

- **HTTP-based verification** (a file served under the host). It requires the host to already route to Velexis and gives no proof before TLS; DNS TXT is standard and works before routing.
- **CNAME only, no TXT.** Pointing a CNAME proves routing but not that the tenant asking is the owner, because two OTAs could race for a host the owner pointed at the wrong sub-domain.
- **Verify once, never re-check.** Leaves certificates being issued for hosts that moved away.

## References

- [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md), [`../flows/custom-domains.md`](../flows/custom-domains.md)
- [`../../../docs/velexis-sdk/db/platform.sql`](../../../docs/velexis-sdk/db/platform.sql) (`tenant_domains`)
- Caddy on-demand TLS: <https://caddyserver.com/docs/automatic-https#on-demand-tls>
