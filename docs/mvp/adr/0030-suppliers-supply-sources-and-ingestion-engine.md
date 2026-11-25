# ADR-0030: Suppliers, supply sources and the ingestion engine

**Status:** Proposed
**Date:** 2026-11-25
**Deciders:** Product owner (items 1 to 13, decided on 2026-11-24), lead architect (items 14 to 18, proposed)

**What is in force.** The status is `Proposed` because [ADR-0001](0001-record-architecture-decisions.md) (items 6 and 7) allows no other status before the developer merges a record. The items marked **Decided** are the owner's decisions of 2026-11-24. They are already in force through [`decisions.md`](../decisions.md). The items marked **Proposed** are the lead's proposals. They are not in force until the owner confirms them.

## Context

Amadeus Enterprise is the only supplier today. On 2026-11-24 the owner decided to open Velexis to several suppliers, PKFare first. On 2026-11-25 the owner said: "record the decisions".

This is the entry record. It holds the thirteen decisions in the owner's words, the record that details each, and the proposals that cross both component groups. The design is in the [multi-supplier plan](../plans/multi-supplier-plan.md), which stays a proposal: "A4" and "plan 4.7" below are its assumptions and sections. No task block exists yet.

## Decision

Items 1 to 13 are the owner's. "Detail" names where the design of an item is. That design is mostly proposed, and each record marks it.

1. **Decided (owner, 2026-11-24).** "I want to use suppliers as an adapter, so that the booking flow is agnostic to the supplier. I need a common interface, which works independently and an adapter which implements the interfaces." Detail: OADR-0019.
2. **Decided (owner, 2026-11-24).** "I would add multiple suppliers. PKFare is first in line. I want the ability to enable and disable the supplier globally from admin portal, as well as per tenant." Detail: PADR-0020 (the switches); OADR-0019.
3. **Decided (owner, 2026-11-24).** "Each OTA can have their own Amadeus or PKFare. OTA can use either the velexis as supplier OR their own (Amadeus or PKFare or something else, it could be all or some of them). OTAs/Tenants should not be aware of suppliers which Velexis uses internally to supply to the OTAs. Use an id (md5 or something else) to identify the supplier on OTA end." Detail: items 14, 15 and 18; PADR-0020.
4. **Decided (owner, 2026-11-24).** "The flow for all of the suppliers should remain the same." Detail: OADR-0019; OADR-0020.
5. **Decided (owner, 2026-11-24).** "OTAs pay through the Velexis PKFare wallet. OTAs don't have to worry about it." Detail: OADR-0020; PADR-0020 (the wallet watch).
6. **Decided (owner, 2026-11-24).** "The OTA need not to know the supplier. They should focus on selling only. The Amadeus surface (making queues etc) would only be useful if they integrate their own Amadeus account. For now, do not surface those APIs. Change the Amadeus section to "Suppliers", it should have a single config page with "Velexis", "Amadeus" and "PKFare" as sections. If they select "Amadeus" or "PKFare" as well, then they should provide their credentials for Integration and then the current Amadeus APIs would be useful." Detail: item 18; PADR-0020 (the Suppliers page).
7. **Decided (owner, 2026-11-24).** "I will do it offline. I would reconcile with OTA later." This answers how the ticket cost comes back from OTAs. Detail: PADR-0021; OADR-0020.
8. **Decided (owner, 2026-11-24).** "I would make another role for reconciliation which would get reference to OTA bookings." The owner said this when asked who can work a booking that Velexis supplies: Velexis staff have no access to tenant bookings today. So `decisions.md` records a role for Velexis staff. Detail: PADR-0021.
9. **Decided (owner, 2026-11-24).** "The search would contain some form of ID. If need be, they can ask for supplier, but they do not need to know. They should focus on marketing and selling tickets." Detail: item 14; PADR-0021 (disclosure on request).
10. **Decided (owner, 2026-11-24).** "PKFare agrees, we have signed up with them." No record details this. Sandbox credentials, certification and the live co-test remain (plan §8).
11. **Decided (owner, 2026-11-24).** "Choose a good format for id, even if id changes it should be discernable. I suggest making a log table for supplier ID to get historic IDs if they change." Detail: item 15; PADR-0020 (the id history).
12. **Decided (owner, 2026-11-24).** "the extras and low-cost should be in the first release. Bake in the extras in the interface, if there are no extras then it should be skipped for that booking." Detail: OADR-0020; OADR-0019 (extras in the interface).
13. **Decided (owner, 2026-11-24).** "I propose creating an ingestion engine. The interface would be used by current app. For a given action (for example search), it should fan out the action and parameters to all enabled supplier's (Amadeus, PKFare, Duffle or anyone else) adapter which would form the appropriate request, the results should then be merged and sent from the ingestion engine. I also want to expose "pre-action", "post-action" and "post-merge" hooks so that I can manage them better. I would then be able to add markup for certain suppliers, or disable some supplier for some specific search query (maybe based on origin or destination or time or airline or something else) or do some other management. The same engine would be provided to OTAs as well, so that they can manage things if they use their own supplier." Detail: OADR-0019.
14. **Proposed (lead).** **Supply source** (A4). `decisions.md` §2 says that an opaque id identifies the supplier on the OTA's side and that search results carry it (items 3, 9 and 11). It does not use the term "supply source". Proposed: the id belongs to a supply source, which is one supplier used through one account, Velexis's or the OTA's own. Velexis supply then has one source and one id per Velexis supplier account. Also proposed: offers and bookings carry the id in a member named `supplyId`.
15. **Proposed (lead).** **Id format** (A4): `sup_` plus 16 random base32 characters, never reused, with no time part and no hash of a name. It would be an exception to the prefixed ULIDs of [`conventions.md`](../conventions.md) §1: a ULID shows when a source was created.
16. **Proposed (lead).** **Where the engine lives** (A1): in the OTA backend, as the module `ota/backend/src/supply/`, not in a new service.
17. **Proposed (lead).** **`FlightOffer.source`** (A10, A28): the content type, whatever the supplier, with the new values `LCC` and `OTHER`. `netPrice` becomes the OTA's cost price, and `recordLocator` the airline's reference or none (plan 4.8).
18. **Proposed (lead).** **Hiding rules** (A5; plan 4.7): for a Velexis source, Amadeus included, the OTA never sees the supplier's name, payload, error codes, call log or order reference. Without an own active Amadeus connection, 15 Amadeus-only operations answer `403 FEATURE_DISABLED`. The published contract keeps its Amadeus-named members.

The lead's four earlier proposals stay proposals: capture before the ticketing request, and the safety set for a paid booking without a ticket (OADR-0020); one offer per like-for-like flight (OADR-0019); documentation notes only in SDK 1.0.0.

## Revisions to other records

Dated notes of 2026-11-25 point here. Each rests on an owner's decision: [ADR-0010](0010-secrets-envelope-encryption.md) (Context), [ADR-0011](0011-payments-stripe-and-airline-card.md) (Settlements) and [ADR-0012](0012-amadeus-account-model.md) (Context, Lifecycle item 3, Office isolation). The component records have their own notes of the same date, listed in OADR-0019, PADR-0020 and PADR-0021: OADR-0001 (point 1), PADR-0006 (item 8), PADR-0010 (Context), PADR-0012 (item 4) and PADR-0015 (item 6).

## Notes that wait for a decision

These would rest on a proposal or an open question. Nobody writes them before the owner decides.

- [ADR-0025](0025-roadmap-scheduling-and-tracking.md) item 3: how M7 runs beside M6.
- [ADR-0003](0003-six-components-two-nestjs-backends.md) and [ADR-0009](0009-background-jobs-bullmq.md) item 3: the reconciliation role's interface and its facts on the queue (A7, A36).
- [ADR-0004](0004-postgresql-schema-per-tenant.md) and `conventions.md` §1: the id format (item 15).
- [ADR-0006](0006-contract-first-openapi.md): the new meanings of item 17.
- [ADR-0011](0011-payments-stripe-and-airline-card.md): capture before the ticketing request; Stripe only for other suppliers (A6).
- [ADR-0012](0012-amadeus-account-model.md) Lifecycle item 2: go-live with any active supply source (A11).
- [ADR-0015](0015-testing-strategy.md): a PKFare fake (plan 4.15).
- OADR-0016: the SDK notes.

## Consequences

### Positive

- One place states what the owner decided, in the owner's words, apart from what is only proposed.

### Negative

- The decisions are in force before any code follows them. The code still knows one supplier.
- The documents below `decisions.md` that describe the system as built (`README.md`, `AGENTS.md`, [`architecture.md`](../architecture.md), the component documents and the guidebook) still describe one supplier. Each changes with the task that builds its part.
- Hiding has limits. As proposed, the contract keeps Amadeus-named members (item 18), and `supplyId` lets anyone count Velexis's sources (item 14; plan 9.3).
- Offline recovery is credit given by Velexis (plan 9.4).
- The plan counts 836 to 1,254 agent-hours (plan §7).

### Follow-ups

- The owner confirms or changes items 14 to 18 and answers the open questions. The developer then sets the status.
- Ten assumptions of the plan are in no item of the five records. A13, A29 and A43 are in open questions; A21 and A41 are in Follow-ups; A25, A27, A35, A40 and A42 are named in no record. They stay proposals of the plan until the owner confirms them.
- The waiting notes and the task blocks follow.

## Alternatives considered

- **A new service for the engine.** [ADR-0003](0003-six-components-two-nestjs-backends.md) fixed two backends.
- **A ULID or a hash as the supply id.** A ULID shows when a source was created. The owner named md5 as one possibility; the proposal takes random characters.
- **One value of `FlightOffer.source` per supplier.** It would name the supplier.

## References

- [`../decisions.md`](../decisions.md) §1, §2 and §5
- [`../plans/multi-supplier-plan.md`](../plans/multi-supplier-plan.md) §2 (the owner's words), §3 (A1 to A43), §4, §5 and §9
- [OADR-0019](../../../ota/docs/adr/0019-supplier-ingestion-engine-and-adapters.md) (the ingestion engine), [OADR-0020](../../../ota/docs/adr/0020-suppliers-paid-from-a-balance.md) (suppliers paid from a balance, extras, low-cost content)
- [PADR-0020](../../../platform/docs/adr/0020-supplier-registry-switches-and-suppliers-page.md) (the supplier registry), [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md) (the reconciliation role)
- [ADR-0010](0010-secrets-envelope-encryption.md), [ADR-0011](0011-payments-stripe-and-airline-card.md), [ADR-0012](0012-amadeus-account-model.md)

## Open questions for the owner

Only the owner answers these. Each recommendation is the lead's proposal. The sections are the plan's. For questions 2 to 7 the detail record named has the options and the recommendation.

| # | Question | Options | Recommendation (the lead's proposal) |
|---|---|---|---|
| 1 | When does M7 run against the launch? (§7, 9.5) | After it; before it, where each M7 review week moves the launch by one week; or a fixed weekly share | A13 says beside M6; plan 9.1 says that this must become one of the three. The SDK 1.0.0 publish first; PKFare live after the launch (A43) |
| 2 | Who works an OTA's queues between hiding the supplier (P5) and the reconciliation tools (P9)? (9.3) | [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md), question 3 | There |
| 3 | The wallet's default daily limit per OTA, and the Stripe modes allowed with Velexis supply (9.1, 9.4) | [PADR-0020](../../../platform/docs/adr/0020-supplier-registry-switches-and-suppliers-page.md), question 1 | There |
| 4 | Counsel: is Velexis a processor for each OTA, or a controller of its own? (4.14) | [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md), question 1 | There |
| 5 | Who staffs the reconciliation role? (§8) | [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md), question 2 | There |
| 6 | Low-cost content, if PKFare's sandbox shows no reliable mark for it (9.1) | [OADR-0020](../../../ota/docs/adr/0020-suppliers-paid-from-a-balance.md), question 1 | There |
| 7 | Paid bags after ticketing (9.6) | [OADR-0020](../../../ota/docs/adr/0020-suppliers-paid-from-a-balance.md), question 2 | There |
| 8 | Does staff Shopping go with the other Amadeus screens? (9.3) | Hidden with PNR lookup, Queues and Supplier log; or kept | Hidden |
| 9 | The traveller's reference when Amadeus returns no airline locator (9.3) | Amadeus's own locator; or none until a ticket number exists | No recommendation in plan 9.3; as drafted the plan shows the airline's reference or none (item 17) |

Plan 9.6 lists more points to confirm. Items 1, 3 and 7 are questions in OADR-0019 and OADR-0020, and item 5 is under Consequences in OADR-0019. Item 4 (schedule changes of PKFare orders) is in no record: the plan leaves it to the task blocks of P7.
