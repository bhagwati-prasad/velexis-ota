# PADR-0006: Platform admin access and audit

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when Velexis has more than two staff (admin sub-roles), or when a customer contract requires an external audit store.
**Revisions:** 2026-10-30 (lead decision (2j) of 2026-10-30, recorded with FIX-W35-PLATFORM): item 5's 5–500 characters count after trimming (dated note under item 5).

## Context

[`decisions.md`](../../../docs/mvp/decisions.md) §1 gives Velexis staff a platform admin for tenants, plans, subscriptions, the shared Amadeus account and offices, settlements, provisioning jobs and audit. [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) makes platform admins ordinary accounts with `is_platform_admin = true` and mandatory TOTP, on their own host with their own cookies. The baseline has `platform_audit_log` with `actor_type` `platform_admin`. Open points: how the first admin is created, how admin tokens are kept apart from portal tokens, which actions need extra friction, and how the audit log is protected.

## Decision

### Access

1. **Separate audience.** Admin sessions are created only by `/v1/admin/auth/*`, carry `aud = platform_admin`, and live in `account_sessions` rows with `audience = 'platform_admin'` and a 12-hour absolute family lifetime. Portal tokens are refused on admin routes and admin tokens on portal routes.
2. **MFA always.** Admin sign-in requires `is_platform_admin`, an active verified account and MFA enabled, then a TOTP (or recovery) code on every sign-in. Admins cannot disable MFA. Non-admins get the same `INVALID_CREDENTIALS` as a wrong password.
3. **Re-check on every request.** `AdminAuthGuard` re-reads `is_platform_admin` and `status`, so revoking an admin takes effect at once.
4. **Step-up** (TOTP within 15 minutes) for: entering or rotating shared Amadeus credentials, approving and marking settlements paid, revealing payout accounts, resetting an account's MFA, granting and revoking admins.
5. **Reasons** (5–500 characters, stored in the audit `details`) for: suspend, resume, cancel jobs, disable or enable accounts and connections, reset MFA, manual subscription edits, settlement adjustments and voids, domain removals, admin grants.
   - *Note (2026-10-30, lead decision (2j), FIX-W35-PLATFORM).* The API trims a reason (the white space at either end) before it counts the 5–500 characters, for every admin reason (the document's `AdminReason`, also the optional reason of a revocation and the reveal's reason), in one place: the request validation of the platform API (`TRIMMED_SCHEMAS` of `platform/backend/src/common/http/openapi-validation.interceptor.ts`). A reason of only spaces answers `400 VALIDATION_FAILED`, and the audit row (and any record that keeps the reason) holds the trimmed reason. The platform admin's `ReasonDialog` and server actions already trim and count the same way.
6. **Bootstrap.** The first admin is granted by a CLI command run on the VM by the developer (`node dist/cli.js admin:grant <email>`), which requires an existing, verified account with MFA enabled and writes an audit row with `actor_type = 'system'` and the operator's name. `admin:reset-mfa <email>` exists for the case where the only admin loses their authenticator. No admin is created by migrations or seeds in production.
7. **Network.** The admin host is served by Caddy like the portal; an optional IP allow-list can be set in the Caddy configuration. The admin app sets `X-Robots-Tag: noindex`.
8. **No tenant data.** Admin endpoints never touch tenant schemas. Supporting an OTA's bookings means being invited as a member like anyone else, which is then visible to the OTA in its team list.
9. **No impersonation** of portal users in the MVP.

### Audit

1. **Every state change** in the platform API writes one `platform_audit_log` row **in the same transaction** as the change: `actor_type` (`account`, `platform_admin`, `system`), `actor_account_id`, `actor_label` (e-mail snapshot or job name), `action` (dotted, for example `tenant.suspended`, `api_key.revoked`), `target_type`, `target_id`, `tenant_id`, `tenant_key`, `request_id`, `ip_address`, `user_agent`, and `details` with before and after values passed through the shared redactor (no secrets, no tokens, no bank numbers).
2. **Sensitive reads** are audited too: payout account reveal, audit export, initial key reveal, console token issue.
3. **Append-only by privilege.** Migration `0002` revokes `UPDATE`, `DELETE` and `TRUNCATE` on `platform_audit_log` from `velexis_platform_app`. Retention purges (if ever needed) run as `velexis_migrator` in a reviewed migration or script.
4. **Retention.** Kept with the data, no purge in the MVP; the table is small (control-plane actions only).
5. **Access.** Platform admins see everything; tenant owners do not see the platform audit log in the MVP (their OTA admin has `staff_actions`).
6. **Action names** are listed in one TypeScript union in `audit/audit-actions.ts`, so a typo fails to compile, and the admin UI filters on the same list.

## Consequences

### Positive

- A stolen portal session cannot reach admin functions; a stolen admin password is useless without the TOTP device.
- Every change and every sensitive read can be traced to a person, a request and a reason.
- The database itself prevents silent edits of the audit trail by the application.

### Negative

- Admin work has some friction (TOTP, step-ups, reasons). That is intended.
- Root or `velexis_migrator` access can still alter the audit table; an external, write-once audit store is out of scope for a single VM.

### Follow-ups

- Ship audit rows to off-VM storage with the nightly backup (already covered by the database dump, ADR-0007).
- Admin sub-roles (support versus finance) when the team grows.

## Alternatives considered

- **A separate admin identity store.** Two password systems for one developer; accounts with a flag are enough.
- **Audit through log lines only.** Logs rotate after 30 days and are not queryable by tenant ([ADR-0016](../../../docs/mvp/adr/0016-observability.md) keeps audit in tables).
- **Database triggers writing audit rows.** They see row changes but not the actor, request or reason without session variables; application-level writes in the same transaction are clearer.

## References

- [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [ADR-0016](../../../docs/mvp/adr/0016-observability.md), [ADR-0004](../../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md)
- [db README §8](../../../docs/velexis-sdk/db/README.md) (audit, redaction)
- [`../flows/platform-admin-operations.md`](../flows/platform-admin-operations.md), [`../api-inventory-admin.md`](../api-inventory-admin.md)
