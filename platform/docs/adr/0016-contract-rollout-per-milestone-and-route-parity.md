# PADR-0016: Contract rollout per milestone and route parity

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform delivery lead. Decided during planning; revisit when the pending-operations list is empty at the M5 exit, or if the OTA plan needs to change a `tenant.*` message in a way that is not backward compatible.
**Revisions:** 2026-10-12 (planning review): the M1 admin slice is split in two tasks (PBE-007 and PBE-066), because 47 operations did not fit one task; seven tasks now edit the document.

## Context

[ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md) makes the OpenAPI document the source of truth and asks for a route parity check in CI. The platform API inventory ([part 1](../api-inventory.md), [part 2](../api-inventory-resources.md), [part 3](../api-inventory-admin.md)) lists about 150 operations spread over M1 to M5. If the whole document is written in M1, a strict parity test ("every documented operation has a route") fails for months. If each operation is added to the document only inside the task that implements it, contract-first becomes contract-at-the-same-time, and the portal and admin cannot start against generated types.

Two smaller questions were also open:

- Who defines the `tenant.*` queue messages and the `vx:invalidate` event types in `@velexis/api-types/jobs`? Both plans touch them ([PADR-0001](0001-tenant-provisioning-orchestration.md) item 9, [`../architecture.md`](../architecture.md) §6), and X-008 left the concrete types to "the provisioning tasks of the platform and OTA plans".
- Part 3 of the inventory names one operation, `adminListSettlementLines`, for two paths (`…/lines` and `…/lines.csv`). OpenAPI needs one `operationId` per path and method.

## Decision

1. **Milestone slices.** The platform document is written in slices, each at the start of its milestone and before any implementation task of that milestone:

   | Slice | Task | Operations |
   |---|---|---|
   | M1 identity, plans, internal | PBE-005 | Auth, account, `listPlans`, `tlsAsk`, health |
   | M1 tenants, team, keys, reads | PBE-006 | Tenants and lifecycle (not `goLive`), team (not `createConsoleToken`), API keys, M1 reads of domains, connections and subscription |
   | M1 admin, part 1 | PBE-007 | Admin auth and dashboard, tenants, provisioning jobs and queues (21 operations) |
   | M1 admin, part 2 | PBE-066 | Plans and subscriptions, Amadeus accounts and offices, accounts, platform admins and audit (26 operations) |
   | M3–M4 | PBE-037 | `updatePaymentConnection`, `createConsoleToken`, `updateAmadeusConnection` |
   | M5 portal | PBE-041 | `goLive`, custom domains, own Amadeus, Stripe Connect and API keys, payout account, settlements, Checkout, Customer Portal, invoices |
   | M5 admin and webhooks | PBE-042 | Every admin operation marked M5, both Stripe webhook receivers |

2. **Route parity with a pending list.** `platform/backend/test/contract/route-parity.contract.test.ts` fails when:
   - a route is bound with `@OpenApiOperation` to an operation that is not in the document, or with another method or path;
   - a documented operation is neither bound nor listed in `platform/backend/test/contract/pending-operations.ts`;
   - an operation is both bound and listed as pending.

   Each pending entry names the task that implements it (`{ operationId: "addDomain", task: "PBE-049" }`). The implementing task removes its entries. **The list is empty at the M5 exit**; an empty list is an M5 exit criterion.
3. **Queue and invalidation contracts belong to the platform plan.** PBE-004 defines every `tenant.*` message (both directions), the queue names and the `vx:invalidate` event union, with JSON Schemas and shared fixtures. The OTA plan consumes them and may extend them only backward compatibly for one release ([ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md)).
4. **One operation per representation.** The CSV path of settlement lines in the admin gets its own operation, `adminDownloadSettlementLines`, added by PBE-042 together with the matching line in part 3 of the inventory. The JSON path keeps `adminListSettlementLines`.

## Consequences

### Positive

- The portal and the admin are built against generated types of every operation of their milestone from its first day.
- The parity test stays green during the whole MVP and still catches undocumented routes and forgotten operations.
- One owner for the job messages avoids two incompatible definitions written in parallel.

### Negative

- The pending list is one more file to keep in step; a task that forgets to remove its entries fails the parity test (which is the intent).
- The document is edited by seven tasks. They are ordered by dependencies (PBE-005 → PBE-006 → PBE-007 → PBE-066 → PBE-037 → PBE-041 → PBE-042) so that two agents never edit it at the same time.

### Follow-ups

- PBE-042 adds `adminDownloadSettlementLines` to [`../api-inventory-admin.md`](../api-inventory-admin.md) §6.
- The OTA plan's provisioning consumer depends on PBE-004.

## Alternatives considered

- **Whole document in M1, parity test switched off until M5.** Simple, but the check that catches drift would be off for most of the MVP.
- **Each operation added inside its implementation task.** Every task is smaller, but the UIs would wait for the backend task of each screen, and the M5 contract could not be reviewed as one piece.
- **An `x-milestone` field and a parity test that skips future milestones.** It needs the current milestone as configuration and hides operations whose task slipped.

## References

- [ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md), [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md), [ADR-0020](../../../docs/mvp/adr/0020-ai-agent-development-workflow.md)
- [`../plans/agent-tasks.md`](../plans/agent-tasks.md), [`../plans/implementation-plan.md`](../plans/implementation-plan.md)
