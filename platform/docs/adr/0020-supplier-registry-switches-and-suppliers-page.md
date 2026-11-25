# PADR-0020: Supplier registry, switches and the Suppliers page

**Status:** Proposed
**Date:** 2026-11-25
**Deciders:** Product owner (items 1 to 6: decisions of 2026-11-24), lead architect (items 7 to 15: proposals, not confirmed)

**What is in force.** The status is `Proposed`: [ADR-0001](../../../docs/mvp/adr/0001-record-architecture-decisions.md) (items 6 and 7) and this folder's [README](README.md) allow no other before the developer merges a record. The **Decided** items are the owner's decisions of 2026-11-24, in force through [`decisions.md`](../../../docs/mvp/decisions.md). The **Proposed** items are the lead's proposals, not in force until the owner confirms them.

## Context

The platform allows one provider today, `amadeus` (`platform/backend/migrations/platform/0001_baseline.sql:269`), and no global switch exists.

[ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) lists the owner's thirteen decisions of 2026-11-24; this record details the platform side of rows 2, 3, 5, 6 and 11. The design is in the [multi-supplier plan](../../../docs/mvp/plans/multi-supplier-plan.md) (4.4 to 4.6), a proposal: "A12" and "plan 4.4" below are its assumptions and sections.

## Decision

1. **Decided (owner, 2026-11-24).** **Switches, globally and per tenant** (row 2). "I want the ability to enable and disable the supplier globally from admin portal, as well as per tenant."
2. **Decided (owner, 2026-11-24).** **Velexis supply, own accounts, or both** (row 3). "Each OTA can have their own Amadeus or PKFare. OTA can use either the velexis as supplier OR their own (Amadeus or PKFare or something else, it could be all or some of them)."
3. **Decided (owner, 2026-11-24).** **Velexis's suppliers are not shown** (row 3). "OTAs/Tenants should not be aware of suppliers which Velexis uses internally to supply to the OTAs."
4. **Decided (owner, 2026-11-24).** **One Suppliers page; own credentials** (row 6). "Change the Amadeus section to "Suppliers", it should have a single config page with "Velexis", "Amadeus" and "PKFare" as sections. If they select "Amadeus" or "PKFare" as well, then they should provide their credentials for Integration and then the current Amadeus APIs would be useful."
5. **Decided (owner, 2026-11-24).** **An id with a history table** (rows 3 and 11). "Use an id (md5 or something else) to identify the supplier on OTA end." "Choose a good format for id, even if id changes it should be discernable. I suggest making a log table for supplier ID to get historic IDs if they change."
6. **Decided (owner, 2026-11-24).** **Velexis's PKFare wallet** (row 5). "OTAs pay through the Velexis PKFare wallet. OTAs don't have to worry about it."
7. **Proposed (lead).** **The registry** (A4, A12, A24; ADR-0030 item 14; plan 4.4). A supply source is one supplier used through one account, Velexis's or the OTA's own. New platform tables: `suppliers`, `supplier_environments`, `supply_sources` and `supply_source_ids`, and `supplier_accounts` for Velexis's account with every supplier except Amadeus.
8. **Proposed (lead).** **Id format** (A4; ADR-0030 item 15). `sup_` plus 16 random characters, never reused. Only a platform admin rotates an id; an old id still resolves.
9. **Proposed (lead).** **Levels, and what "off" stops** (A12, A22, A23; plan 4.4). A source sells only when every level allows it: the global switch (own accounts included), the per-tenant switch, the OTA's own choice, and a stop by the wallet watch or staff. "Off" leaves the source out of new searches and refuses its offers at pricing and checkout. Existing bookings keep being ticketed, polled, synced and serviced.
10. **Proposed (lead).** **Two controls** (plan 4.4). Today's status `disabled` serves nothing, existing orders included (`ota/backend/src/amadeus/connection-resolver.ts:16-18`). It stays beside the switch, as the emergency stop. For a source that tickets later it also stops the ticketing request and the polling of captured bookings; the dialog warns, and the watchdog lists each as an open case (OADR-0020 items 8 and 9).
11. **Proposed (lead).** **The Suppliers page** (plan 4.5). The Velexis section shows one state per environment and the supply ids, never a supplier name, office id or host. Own Amadeus beside Velexis needs two connection rows, and no office is then released.
12. **Proposed (lead).** **Own PKFare credentials** (plan 4.5). They are a new kind, `pkfare`, in the flow of [PADR-0010](0010-credential-submission-and-verification.md). One read-only balance request checks them. The host never comes from the form. A test environment never reaches a production supplier host.
13. **Proposed (lead).** **Velexis's supplier accounts and the wallet watch** (A6, A26; plan 4.6). PKFare's signature is worth as much as the key: never logged, stored or returned. A platform job reads the balance every five minutes. Under the floor, or after the answer "balance not enough", the source stops for every OTA. The owner sets the floor and the warning level; no live wallet account is active without a floor. Whether a daily limit per OTA is on by default is question 1 below.
14. **Proposed (lead).** **One breaking rename in the platform API** (plan 9.1). `amadeus_test`, the onboarding item of [PADR-0018](0018-onboarding-checklist-computation.md), and `amadeus_live`, a go-live precondition, name the supplier to a Velexis-only OTA, so the plan renames them. [PADR-0016](0016-contract-rollout-per-milestone-and-route-parity.md) wants an ADR to approve a breaking change; this item would be that approval.
15. **Proposed (lead).** **Onboarding and go-live** (A11). Both ask for "at least one source that sells in that environment".

## Revisions to other records

Dated notes of 2026-11-25 point here: [PADR-0015](0015-milestone-feature-switches.md) item 6 (item 1), [PADR-0012](0012-amadeus-office-pool.md) item 4 and PADR-0010's Context (items 2 and 4).

## Notes that wait for a decision

They would rest on proposals; nobody writes them yet.

- PADR-0018, the row `amadeus_test`: items 14 and 15.
- PADR-0016: its approval of item 14.
- PADR-0010 items 1, 4 and 5, and PADR-0012 item 4: items 11 and 12.

## Consequences

### Positive

- Velexis staff can switch a supplier off for every OTA or for one.

### Negative

- One wallet serves every OTA: with item 13, a low balance stops sales for all of them, and one logged request body would give the wallet away (plan 9.4).

### Follow-ups

- The owner confirms or changes items 7 to 15 and answers the question below. The developer then sets the status.
- OTA group: the OTA backend reads the registry and applies the switches (OADR-0019), once confirmed.

## Alternatives considered

- **`disabled` as the only switch per tenant.** It also stops existing orders.

## References

- [`decisions.md`](../../../docs/mvp/decisions.md), [multi-supplier plan](../../../docs/mvp/plans/multi-supplier-plan.md), [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md), [PADR-0021](0021-reconciliation-role-ledger-and-cases.md), [OADR-0019](../../../ota/docs/adr/0019-supplier-ingestion-engine-and-adapters.md), [OADR-0020](../../../ota/docs/adr/0020-suppliers-paid-from-a-balance.md)

## Open questions for the owner

The recommendation is the lead's proposal, not a decision.

1. **The wallet's daily limit per OTA, and the Stripe modes allowed with Velexis supply** (plan 9.1, 9.4). Where the OTA collects the traveller's money itself, its debt for tickets is unbounded until the owner invoices. Options: the limit off by default (A6), or on; every Stripe mode, or not those where the OTA collects the money. The lead's recommendation: a limit for the first live OTA; the owner names the modes for the first live weeks.
