# PADR-0020: Supplier registry, switches and the Suppliers page

**Status:** Proposed
**Date:** 2026-11-25
**Deciders:** Product owner (items 1 to 6: decisions of 2026-11-24; items 16 and 17: decisions of 2026-11-25; items 18 and 19: decisions of 2026-11-26), lead architect (items 7 to 15: proposals, not confirmed; 2026-11-27: items 7 to 9 accepted with the owner's go for wave 71)

**What is in force.** The status is `Proposed`: [ADR-0001](../../../docs/mvp/adr/0001-record-architecture-decisions.md) (items 6 and 7) and this folder's [README](README.md) allow no other before the developer merges a record. The **Decided** items are the owner's decisions of 2026-11-24 (items 1 to 6), of 2026-11-25 (items 16 and 17) and of 2026-11-26 (items 18 and 19), in force through [`decisions.md`](../../../docs/mvp/decisions.md). The **Proposed** items are the lead's proposals, not in force until the owner confirms them. 2026-11-27: the owner's go for wave 71 accepted items 7 to 9 (the dated note under each).

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
7. **Proposed (lead).** **The registry** (A4, A12, A24; ADR-0030 item 14; plan 4.4). A supply source is one supplier used through one account, Velexis's or the OTA's own. New platform tables: `suppliers`, `supplier_environments`, `supply_sources` and `supply_source_ids`, and `supplier_accounts` for Velexis's account with every supplier except Amadeus. 2026-11-27: accepted with the owner's go for wave 71 ("start working on wave 71"), under ADR-0030 item 26; built by PBE-078, and PBE-079 adds `supplier_accounts`.
8. **Proposed (lead).** **Id format** (A4; ADR-0030 item 15). `sup_` plus 16 random characters, never reused. Only a platform admin rotates an id; an old id still resolves. 2026-11-27: accepted with the owner's go for wave 71 ("start working on wave 71"), under ADR-0030 item 26; built by PBE-078 (the id's pattern), and PBE-080 adds the generator and the rotation.
9. **Proposed (lead).** **Levels, and what "off" stops** (A12, A22, A23; plan 4.4). A source sells only when every level allows it: the global switch (own accounts included), the per-tenant switch, the OTA's own choice, and a stop by the wallet watch or staff. "Off" leaves the source out of new searches and refuses its offers at pricing and checkout. Existing bookings keep being ticketed, polled, synced and serviced. 2026-11-27: accepted with the owner's go for wave 71 ("start working on wave 71"), under ADR-0030 item 26; built by PBE-078 (the global state, the per-tenant switch and the stop).
10. **Proposed (lead).** **Two controls** (plan 4.4). Today's status `disabled` serves nothing, existing orders included (`ota/backend/src/amadeus/connection-resolver.ts:16-18`). It stays beside the switch, as the emergency stop. For a source that tickets later it also stops the ticketing request and the polling of captured bookings; the dialog warns, and the watchdog lists each as an open case (OADR-0020 items 8 and 9).
11. **Proposed (lead).** **The Suppliers page** (plan 4.5). The Velexis section shows one state per environment and the supply ids, never a supplier name, office id or host. Own Amadeus beside Velexis needs two connection rows, and no office is then released. 2026-11-25: own Amadeus beside Velexis comes after the launch, in a different release, by the owner's decision of item 16; its task, PBE-103, is in milestone M8. The lead keeps two parts in milestone M7: the Velexis section (PFE-032), and the move of what exists today for an OTA's own Amadeus account, the settings and the credentials form behind `FEATURE_OWN_AMADEUS`, into the Suppliers page (PFE-033).
12. **Proposed (lead).** **Own PKFare credentials** (plan 4.5). They are a new kind, `pkfare`, in the flow of [PADR-0010](0010-credential-submission-and-verification.md). One read-only balance request checks them. The host never comes from the form. A test environment never reaches a production supplier host. 2026-11-25: the lead reads item 16 as moving an OTA's own PKFare account after the launch too, so its tasks (PBE-102, PFE-034) are in milestone M8. The owner named only an OTA's own Amadeus account; whether its own PKFare account moves too is open ([ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) question 13, (44d)). 2026-11-26: the owner decided that an OTA's own PKFare account also moves after the launch (item 19; ADR-0030 item 30), so PBE-102 and PFE-034 stay in M8. The rest of this item stays proposed.
13. **Proposed (lead).** **Velexis's supplier accounts and the wallet watch** (A6, A26; plan 4.6). PKFare's signature is worth as much as the key: never logged, stored or returned. A platform job reads the balance every five minutes. Under the floor, or after the answer "balance not enough", the source stops for every OTA. The owner sets the floor and the warning level; no live wallet account is active without a floor. Whether a daily limit per OTA is on by default is question 1 below. 2026-11-25: question 1 is answered in part: the default is 0, by the owner's decision of item 17; what 0 means is still open ([ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) question 10, (44a)). 2026-11-26: the owner answered what 0 means (item 18; ADR-0030 item 27): no ticket is paid from the wallet until staff set a limit. The floor and the warning level stay the owner's to set.
14. **Proposed (lead).** **One breaking rename in the platform API** (plan 9.1). `amadeus_test`, the onboarding item of [PADR-0018](0018-onboarding-checklist-computation.md), and `amadeus_live`, a go-live precondition, name the supplier to a Velexis-only OTA, so the plan renames them. [PADR-0016](0016-contract-rollout-per-milestone-and-route-parity.md) wants an ADR to approve a breaking change; this item would be that approval.
15. **Proposed (lead).** **Onboarding and go-live** (A11). Both ask for "at least one source that sells in that environment".
16. **Decided (owner, 2026-11-25).** **The Amadeus tools hidden now; back after the launch with an OTA's own Amadeus account** ([ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 21). "Hide Amadeus tools right now (I would resurface them later when there is functionality of adding OTAs own Amadeus, that would be post launch in a different release)." So the functionality for adding an OTA's own Amadeus account comes after the launch, in a different release. `FEATURE_OWN_AMADEUS` ([PADR-0015](0015-milestone-feature-switches.md)) enables the part of it that exists today, own Amadeus credential submissions, so it stays off at launch (dated note of 2026-11-25 under PADR-0015's Follow-ups). The lead reads this as: an OTA's own supplier accounts come in that later release, milestone M8, with own Amadeus beside Velexis (item 11), the "Amadeus" and "PKFare" sections of the Suppliers page beyond what exists today, and the rules of an OTA for its own suppliers; what exists today for an OTA's own Amadeus credentials stays as it is, behind that switch. The owner named only own Amadeus, so for an OTA's own PKFare account this reading is open (item 12; ADR-0030 question 13, (44d)). 2026-11-26: for an OTA's own PKFare account, the move after the launch is now the owner's decision too (item 19).
17. **Decided (owner, 2026-11-25).** **The daily limit per OTA: 0 by default, set in the platform admin's OTA management** (ADR-0030 item 23; question 1 below). "Keep limit to 0. It should be configurable from Platform Admin's OTA management." The lead reads this as: one platform value per OTA, default 0, changed on the platform admin's OTA page with a reason and an audit row, read by the OTA backend and enforced before the capture (tasks PBE-082, PAD-019 and OBE-177). What 0 means is not decided: no limit, or no ticket paid from the wallet until staff set a limit. The lead asks the owner (ADR-0030 question 10, (44a)) and starts the limit parts of PBE-082, PAD-019 and OBE-177, and the caps step of OBE-206, only after the answer. 2026-11-26: the owner answered (item 18): no ticket is paid from the wallet until staff set a limit. So the limit parts of PBE-082, PAD-019 and OBE-177, and the caps step of OBE-206, may start.
18. **Decided (owner, 2026-11-26).** **What a daily limit of 0 means** ([ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 27; question 1 below). "no ticket is paid from the wallet until staff set a limit." This answers ADR-0030 question 10, (44a), whether 0 means no limit, or no ticket paid from the wallet until staff set a limit: the second. The lead reads this as: a daily limit of 0 refuses every ticket paid from Velexis's wallet for that OTA until staff set a limit above 0 in the platform admin's OTA management (item 17); the plan's A6, "A daily limit per OTA is off by default", no longer holds for the limit; and the limit parts of PBE-082, PAD-019, OBE-177 and OBE-206 may start. The limit's unit and day stay the lead's proposal in PBE-082 (step 5). ADR-0030 questions 14 and 15 follow from this answer.
19. **Decided (owner, 2026-11-26).** **An OTA's own PKFare account after the launch too** (ADR-0030 item 30; items 12 and 16). "Yes." This answers ADR-0030 question 13, (44d), whether an OTA's own PKFare account also moves after the launch with own Amadeus: it moves. The lead reads this as: an OTA's own PKFare account moves after the launch, to milestone M8, with own Amadeus, so its tasks PBE-102 and PFE-034 stay in M8.

## Revisions to other records

Dated notes of 2026-11-25 point here: [PADR-0015](0015-milestone-feature-switches.md) item 6 (item 1) and its Follow-ups (item 16), [PADR-0012](0012-amadeus-office-pool.md) item 4 and PADR-0010's Context (items 2 and 4). The platform [launch checklist](../runbooks/launch-checklist.md) keeps `FEATURE_OWN_AMADEUS` off at launch (§7, switch 3; item 16).

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

- The owner confirms or changes items 7 to 15 and answers the question below. The developer then sets the status. 2026-11-26: the question is answered except for the Stripe modes (items 17 and 18). Two follow-ups are ADR-0030 questions 14 and 15: whether the limit also counts tickets paid from the test wallet, and whether a wallet-paid source is left out of an OTA's search and pricing while that OTA's limit is 0. 2026-11-27: the owner's go for wave 71 accepted items 7 to 9 (PBE-078); items 10 to 15 stay proposed.
- OTA group: the OTA backend reads the registry and applies the switches (OADR-0019), once confirmed.

## Alternatives considered

- **`disabled` as the only switch per tenant.** It also stops existing orders.

## References

- [`decisions.md`](../../../docs/mvp/decisions.md), [multi-supplier plan](../../../docs/mvp/plans/multi-supplier-plan.md), [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md), [PADR-0021](0021-reconciliation-role-ledger-and-cases.md), [OADR-0019](../../../ota/docs/adr/0019-supplier-ingestion-engine-and-adapters.md), [OADR-0020](../../../ota/docs/adr/0020-suppliers-paid-from-a-balance.md)

## Open questions for the owner

The recommendation is the lead's proposal, not a decision.

1. **The wallet's daily limit per OTA, and the Stripe modes allowed with Velexis supply** (plan 9.1, 9.4). Where the OTA collects the traveller's money itself, its debt for tickets is unbounded until the owner invoices. Options: the limit off by default (A6), or on; every Stripe mode, or not those where the OTA collects the money. The lead's recommendation: a limit for the first live OTA; the owner names the modes for the first live weeks. Answered in part on 2026-11-25 (item 17; [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 23): the limit is 0 by default and is set in the platform admin's OTA management. Open: what 0 means (ADR-0030 question 10, (44a)) and the Stripe modes. 2026-11-26: what 0 means is answered (item 18; ADR-0030 item 27): no ticket is paid from the wallet until staff set a limit. Still open: the Stripe modes.
