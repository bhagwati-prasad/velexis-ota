# PADR-0012: Amadeus office pool

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when more than 20 OTAs are live on the shared account ([ADR-0012](../../../docs/mvp/adr/0012-amadeus-account-model.md) follow-up), or when Amadeus offers an API to create offices.

## Context

[ADR-0012](../../../docs/mvp/adr/0012-amadeus-account-model.md) introduces `platform.amadeus_accounts` (Velexis credentials per environment) and `platform.amadeus_offices` (a pool, one tenant per office), assigns a free test office at provisioning, lets admins assign live offices, and returns a shared office to the pool "after a grace period, once no open booking still depends on it". The platform cannot read tenant bookings, so it cannot check that condition itself, and the OTA backend needs to know which credentials serve an old order after a switch.

## Decision

1. **Statuses:** `available` → `assigned` → `releasing` → `available`, plus `retired` (from `available` only). A CHECK keeps `assigned_tenant_id` set exactly in `assigned` and `releasing`. At most one `assigned` office per tenant and account (partial unique index); a tenant may have several `releasing` ones.
2. **Assignment at provisioning** takes the oldest available test office with `FOR UPDATE SKIP LOCKED` inside the post-step transaction; no free office is not a provisioning failure ([`../flows/provisioning.md`](../flows/provisioning.md)).
3. **Live offices** are assigned only by a platform admin, after the tenant's live request and Velexis's commercial onboarding (recorded in `notes`).
4. **Switch away** (own credentials applied): the office goes to `releasing` with `release_requested_at`, keeping `assigned_tenant_id`. The OTA backend treats every office in `assigned` **or** `releasing` for a tenant as usable with the Velexis account for orders owned by that office (booking sync, issue, cancel, queues), and uses the tenant's own credentials for everything new. This is a requirement on the OTA plan's Amadeus credential resolver.
5. **Release** is a manual admin action with `confirmNoOpenBookings: true` and a reason, after the OTA confirms (from its bookings console, filtered by office) that no booking with future travel remains on it. Only then does the office return to `available` with `released_at`. No automatic timer: a release that cuts off a live booking is worse than an office kept a few weeks longer.
6. **Pool levels.** A daily job e-mails ops below 3 available offices per environment; the admin dashboard shows the counts. Offices are ordered from Amadeus outside the system and added in bulk.
7. **Rotation of the shared secret** updates `amadeus_accounts` and publishes `vx:invalidate {type: "amadeus_account", id}`; office assignments are unaffected.
8. **Disabling** a tenant's connection (abuse) does not release its office; the office stays assigned until an admin decides.

## Consequences

### Positive

- OTAs on the shared account are isolated by office, as ADR-0012 requires, and existing orders keep working after an OTA moves to its own credentials.
- Assignment is race-free and needs no admin work in the common case.

### Negative

- Releasing depends on a human check; offices may stay in `releasing` longer than necessary.
- The pool must be topped up by hand.

### Follow-ups

- OTA plan: the Amadeus credential resolver uses the Velexis account for orders owned by an office that is `assigned` or `releasing` for the tenant, and the tenant's own credentials for everything else (M5).
- When the OTA backend can report "no open bookings on office X" through `platform-tenant-events`, automate the release check.

## Alternatives considered

- **Fixed grace period (for example 90 days).** Bookings can be made up to 11 months ahead; a timer could cut off servicing of a paid booking.
- **Never reuse offices.** Simple, but offices are a limited, contracted resource.
- **Copy the shared credentials into the tenant's connection.** Rejected in ADR-0012 (rotation would touch every row).

## References

- [ADR-0012](../../../docs/mvp/adr/0012-amadeus-account-model.md), [`../flows/amadeus-connection.md`](../flows/amadeus-connection.md), [`../data-model.md`](../data-model.md) §4.4
