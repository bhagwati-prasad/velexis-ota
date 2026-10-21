# OADR-0011: Console access: staff sessions, environments and permissions

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when third-party consoles need the password grant, when admin sub-roles are requested, or when raw Amadeus writes are needed by support.
**Revisions:** 2026-10-12 (planning review): point 4 uses the "direct loopback, not through Caddy" test of OADR-0009; points 8 and 9 use the staff member's forwarded IP and user agent instead of the admin server's. 2026-10-21 (lead decision, recording OBE-059): point 3 names the fourth revocation key, the membership cut-off `staffdeny:member:<staffId>` (epoch ms, 12 h TTL) that `console.auth.signOut` with `scope: all` writes and the staff guard and `console.auth.refresh` check, so that signing out every session of a staff member needs no Redis scan; the Consequences and Alternatives say why.

## Context

[ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) and [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md) fix the SSO: a one-time `ptk_` token in Redis, redeemed with `GETDEL` by `console.auth.signIn` (`grantType = portal_token`) through the OTA admin's service key; staff refresh families live in Redis; the platform writes `staffdeny:acct:<accountId>` and requires families of at most 30 days. The OTA admin picks test or live per request, and "live requires a role that allows it". The contract's `StaffPermission` covers bookings, customers, queues, supplier requests and Amadeus, but not the settings and payments the OTA admin needs in M4. The contract also offers raw Amadeus writes and a password grant.

## Decision

1. **Grants.** Only `portal_token` in the MVP. The `password` grant answers `403 FEATURE_DISABLED` (`details.feature = "passwordGrant"`).
2. **Staff sessions.** Access JWT 15 minutes (`typ: staff`, `sub: stf_…`, `tid`, `roles`, `sid`); refresh token rotating in a Redis family `staffsess:<familyId>` with an **absolute lifetime of 12 hours** (a working day; re-entry through the portal is one click). Reuse of a rotated token revokes the family.
3. **Revocation checks** on every console request (the staff guard) and on every refresh (`console.auth.refresh`), against four revocation keys and the membership:
   - the family `staffsess:<familyId>` exists, belongs to the request's tenant, has not reached its absolute end, and is not in **`staffdeny:<familyId>`** (one family revoked: its sign-out, the reuse of a rotated refresh token, a refused refresh);
   - its creation time is after three epoch-ms cut-offs: **`staffdeny:acct:<accountId>`** (written by the platform, [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md); 30 days), **`staffdeny:tenant:<tenantId>`** (written on `tenant.suspend`, [OADR-0007](0007-tenant-migration-runner-and-provisioning-worker.md) point 8; 30 days) and **`staffdeny:member:<staffId>`** (written by `console.auth.signOut` with `scope: all`: the current time in epoch ms, with a TTL of 12 hours, the absolute lifetime of a family, so when it expires every family it refused has ended too). A family created at or before a cut-off is refused, and a cut-off that is not a whole number of milliseconds refuses every family. A membership (`stf_…`) belongs to one tenant, so the member cut-off ends that staff member's sessions in this OTA only, and a later sign-in through the portal opens a family that passes it;
   - the cached membership is `active`, of an active account, and its role is the family's role, which is the token's role (a role change forces a new sign-in within 60 s through the `membership` invalidation).

   `console.auth.signOut` with `scope: all` revokes its own family as well and needs the access token of a live session or the family's current refresh token. The family, its deny key and the tenant cut-off are read in one `MGET`, then the account and member cut-offs the family names in a second; a Redis that cannot answer refuses the request (`503 SERVICE_UNAVAILABLE`), because a revocation that cannot be checked is never skipped.
4. **Service key rules.** Accepted only on a direct loopback connection that did not come through Caddy (no `X-Forwarded-For` or `X-Forwarded-Host`, [OADR-0009](0009-caller-and-tenant-resolution.md) rule 1.2), only on console operations, only with a staff token whose `tid` is the tenant (except the sign-in itself). Calls from a custom console use a secret key scoped `console` with a staff token, or `console:automation` keys with explicit permissions, as the contract defines.
5. **Environments.** The OTA admin sends `X-Velexis-Environment`. `live` requires the tenant's `storefront_environment = live` (an active live Amadeus connection exists by then) and a role in `owner`, `admin`, `agent`, `finance`; `viewer` is limited to test. Otherwise `403 ENVIRONMENT_NOT_ALLOWED`. `ConsoleStaffSession.environments` tells the admin which to offer.
6. **New permissions** `settings:read`, `settings:write`, `payments:read`, `payments:capture`, `payments:refund` with the role matrix of [`../scope.md`](../scope.md) §1.3. Settings writes are owner and admin only, because markups, fees and templates change revenue and customer communication.
7. **Raw Amadeus access is read-only** in the MVP: the eight read operations (`amadeus:read`) are built; the four writes (`createFlightOrders`, `issueFlightOrder`, `patchFlightOrder`, `cancelFlightOrder`) answer `501 NOT_IMPLEMENTED`. Bookings are changed through `console.bookings.*`, which keeps payments, tickets, events and documents consistent.
8. **Audit.** Every console call, including reads of sensitive data and denied attempts, writes one `staff_actions` row with actor, role, action, target, reason, redacted before/after, request id, IP and user agent. For the OTA admin these are the staff member's: the admin forwards `X-Velexis-End-User-IP` (the right-most `X-Forwarded-For` entry set by Caddy) and `X-Velexis-End-User-Agent` on every SDK call, and the backend honours them only for the service caller ([OADR-0009](0009-caller-and-tenant-resolution.md) point 8). Without them every row would show `127.0.0.1`.
9. **Rate limits**: 600 requests per minute per staff session or key; `console.auth.signIn` 10 per minute per end-user IP (the forwarded one for the service caller), so the sign-ins of all OTAs, which all arrive from the admin server, never share one bucket that a single client could exhaust.

## Consequences

### Positive

- A removed or demoted member, a suspended tenant, or "sign out everywhere" takes effect within seconds and at most 60 s.
- A staff member's "sign out of every session" in the console is one key write, effective on the next console request or refresh of each other session, without knowing their family ids.
- Settings and payments get explicit permissions instead of piggybacking on booking permissions.
- No console path can create an Amadeus order that the OTA's books do not know about.

### Negative

- Staff sessions are lost if Redis loses data; staff click "Open console" again.
- Viewers cannot look at live data, which some OTAs may want for accountants (they can use `finance`).
- Support staff needing raw writes must use the Amadeus terminal until the writes are built.

### Follow-ups

- Password grant and TOTP for third-party consoles, when requested.
- Raw Amadeus writes with explicit audit and a booking import afterwards, when support needs them.

## Alternatives considered

- **30-day staff families like the portal.** The OTA admin handles payments and personal data; a shorter session limits the damage of a stolen cookie.
- **Environment from a separate service key per environment.** Two keys for one process, and the choice belongs to the staff member, not the deployment.
- **Reuse `bookings:write` for settings.** Agents would then change markups.
- **Sign out every session of a member by finding their families** (a `SCAN` over `staffsess:*`, or a per-member set of family ids kept beside the families). A scan walks every staff family of every OTA on the shared Redis for one sign-out; a set is a second structure that must follow the families' creation, rotation, revocation and expiry. A cut-off is one write, read in the same `MGET` as the account cut-off, and expires on its own.

## References

- [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md), [PADR-0005](../../../platform/docs/adr/0005-api-key-format-and-hashing.md)
- Contract `console.auth.signIn`, `StaffPermission`, `ConsoleApiKeyScope` in the [OpenAPI document](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)
- [`../api-changes.md`](../api-changes.md) §5, [`../api-changes-console-and-internal.md`](../api-changes-console-and-internal.md) §1, [`../flows/console-operations.md`](../flows/console-operations.md)
