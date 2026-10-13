# OADR-0011: Console access: staff sessions, environments and permissions

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when third-party consoles need the password grant, when admin sub-roles are requested, or when raw Amadeus writes are needed by support.

## Context

[ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) and [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md) fix the SSO: a one-time `ptk_` token in Redis, redeemed with `GETDEL` by `console.auth.signIn` (`grantType = portal_token`) through the OTA admin's service key; staff refresh families live in Redis; the platform writes `staffdeny:acct:<accountId>` and requires families of at most 30 days. The OTA admin picks test or live per request, and "live requires a role that allows it". The contract's `StaffPermission` covers bookings, customers, queues, supplier requests and Amadeus, but not the settings and payments the OTA admin needs in M4. The contract also offers raw Amadeus writes and a password grant.

## Decision

1. **Grants.** Only `portal_token` in the MVP. The `password` grant answers `403 FEATURE_DISABLED` (`details.feature = "passwordGrant"`).
2. **Staff sessions.** Access JWT 15 minutes (`typ: staff`, `sub: stf_…`, `tid`, `roles`, `sid`); refresh token rotating in a Redis family `staffsess:<familyId>` with an **absolute lifetime of 12 hours** (a working day; re-entry through the portal is one click). Reuse of a rotated token revokes the family.
3. **Revocation checks** on every console request and refresh: the family exists and is not in `staffdeny:<familyId>`; its creation time is after `staffdeny:acct:<accountId>` and `staffdeny:tenant:<tenantId>`; the cached membership is `active` and its role is the token's role (a role change forces a new sign-in within 60 s through the `membership` invalidation).
4. **Service key rules.** Accepted only from `127.0.0.1`, only on console operations, only with a staff token whose `tid` is the tenant (except the sign-in itself). Calls from a custom console use a secret key scoped `console` with a staff token, or `console:automation` keys with explicit permissions, as the contract defines.
5. **Environments.** The OTA admin sends `X-Velexis-Environment`. `live` requires the tenant's `storefront_environment = live` (an active live Amadeus connection exists by then) and a role in `owner`, `admin`, `agent`, `finance`; `viewer` is limited to test. Otherwise `403 ENVIRONMENT_NOT_ALLOWED`. `ConsoleStaffSession.environments` tells the admin which to offer.
6. **New permissions** `settings:read`, `settings:write`, `payments:read`, `payments:capture`, `payments:refund` with the role matrix of [`../scope.md`](../scope.md) §1.3. Settings writes are owner and admin only, because markups, fees and templates change revenue and customer communication.
7. **Raw Amadeus access is read-only** in the MVP: the eight read operations (`amadeus:read`) are built; the four writes (`createFlightOrders`, `issueFlightOrder`, `patchFlightOrder`, `cancelFlightOrder`) answer `501 NOT_IMPLEMENTED`. Bookings are changed through `console.bookings.*`, which keeps payments, tickets, events and documents consistent.
8. **Audit.** Every console call, including reads of sensitive data and denied attempts, writes one `staff_actions` row with actor, role, action, target, reason, redacted before/after, request id, IP and user agent.
9. **Rate limit**: 600 requests per minute per staff session or key.

## Consequences

### Positive

- A removed or demoted member, a suspended tenant, or "sign out everywhere" takes effect within seconds and at most 60 s.
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

## References

- [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md), [PADR-0005](../../../platform/docs/adr/0005-api-key-format-and-hashing.md)
- Contract `console.auth.signIn`, `StaffPermission`, `ConsoleApiKeyScope` in the [OpenAPI document](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)
- [`../api-changes.md`](../api-changes.md) §5, [`../api-changes-console-and-internal.md`](../api-changes-console-and-internal.md) §1, [`../flows/console-operations.md`](../flows/console-operations.md)
