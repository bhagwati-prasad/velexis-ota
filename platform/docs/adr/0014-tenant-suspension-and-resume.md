# PADR-0014: Tenant suspension and resume

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when tenant deletion and data export are built, or when the first OTA disputes a suspension.

## Context

Tenants are suspended for non-payment ([ADR-0013](../../../docs/mvp/adr/0013-subscription-billing-stripe-billing.md)) and by Velexis staff (abuse, request). The OTA backend answers `TENANT_SUSPENDED` for any non-active tenant, read from the cached `platform.tenants` row (db README §5). [ADR-0003](../../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md) lists `suspend` as a later job on `ota-tenant-ops`, and `provisioning_jobs.kind` already allows `suspend` and `resume`. Travellers who already paid must not be harmed by an OTA's billing problem more than necessary.

## Decision

1. **Reasons:** `billing` (set only by billing sync), `abuse`, `request`, `admin` (set by platform admins with a written reason). A CHECK constraint enforces the list.
2. **Suspend** (one platform transaction): `tenants.status = 'suspended'`, `suspended_at`, `suspension_reason`, `version + 1`; insert a `suspend` job; audit. After commit: `vx:invalidate tenant` (traffic stops within seconds, 60 s at most), dispatch `tenant.suspend {jobId, tenantId, reason}`, e-mail the owners.
3. **What the OTA backend does on `tenant.suspend`** (OTA plan; housekeeping only, the status already blocks requests): expire open checkouts and void their uncaptured Stripe authorisations; stop accepting console sign-ins and deny existing staff refresh for that tenant; pause per-tenant schedulers that create new supplier activity (queue polling). It answers `tenant.suspended`. Obligations to travellers continue: ticketing of already paid bookings before their deadline, booking-sync, refunds already requested, and transactional e-mails keep running for confirmed bookings.
4. **Resume:** status back to `active`, suspension fields cleared, `resume` job, invalidation, `tenant.resume` (the OTA re-enables its schedulers), e-mail. Billing suspensions resume automatically when the subscription becomes `trialing` or `active`; other reasons only by a platform admin.
5. **What stays reachable while suspended:**
   - the hosted storefront static files and the sub-domain certificate (the `ask` endpoint allows sub-domains of suspended tenants), so the storefront can show a "temporarily unavailable" page from the `TENANT_SUSPENDED` answer;
   - the portal: owners can sign in, see why, pay (billing page) and download invoices; API keys, domains and connections are read-only (`TENANT_NOT_ACTIVE` on writes) and "Open console" is refused;
   - custom domains are not served (no new certificates; the OTA backend does not resolve them for non-active tenants).
6. **Data is never deleted** by suspension. Deletion and export are post-MVP jobs with their own ADR.
7. **Handlers act on current state.** A `tenant.suspend` arriving after a resume is a no-op on the OTA side, because the OTA worker re-reads `tenants.status`; the platform still marks the job `succeeded` on the answer.

## Consequences

### Positive

- One switch (`tenants.status`) stops all OTA traffic quickly; the queue message only cleans up.
- Paid travellers still get their tickets and e-mails.
- Owners can always reach the page that fixes a billing suspension.

### Negative

- Ticketing and sync for a suspended abusive tenant continue until bookings settle; staff can disable the Amadeus connection separately if needed.
- The OTA backend needs explicit "allowed while suspended" paths in its workers.

### Follow-ups

- OTA plan: implement the `tenant.suspend` / `tenant.resume` consumer and the worker exceptions of point 3 (M4/M5).
- Suspended tenants with no activity for 12 months: export and deletion policy after the MVP.

## Alternatives considered

- **Suspend through the queue only** (OTA marks itself suspended). The OTA cannot write platform tables, and the queue adds delay.
- **Hard stop of everything, including ticketing.** Harms travellers who paid and creates chargebacks.
- **No queue message at all.** Open checkouts would keep authorisations on customers' cards until they expire.

## References

- [ADR-0013](../../../docs/mvp/adr/0013-subscription-billing-stripe-billing.md), [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md), [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)
- [db README §5](../../../docs/velexis-sdk/db/README.md), [`../flows/platform-admin-operations.md`](../flows/platform-admin-operations.md), [`../flows/subscription-billing.md`](../flows/subscription-billing.md)
