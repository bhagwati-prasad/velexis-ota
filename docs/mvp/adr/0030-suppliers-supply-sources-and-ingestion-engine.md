# ADR-0030: Suppliers, supply sources and the ingestion engine

**Status:** Proposed
**Date:** 2026-11-25
**Deciders:** Product owner (items 1 to 13, decided on 2026-11-24; items 19 to 25, decided on 2026-11-25), lead architect (items 14 to 18 and 26, proposed)

**What is in force.** The status is `Proposed` because [ADR-0001](0001-record-architecture-decisions.md) (items 6 and 7) allows no other status before the developer merges a record. The items marked **Decided** are the owner's decisions of 2026-11-24 (items 1 to 13) and of 2026-11-25 (items 19 to 25). They are already in force. Items 1 to 13 and 19 to 23 are in force through [`decisions.md`](../decisions.md). Items 24 and 25 change no row of it: they concern the SDK's documentation notes and the task files. The items marked **Proposed** are the lead's proposals. They are not in force until the owner confirms them.

## Context

Amadeus Enterprise is the only supplier today. On 2026-11-24 the owner decided to open Velexis to several suppliers, PKFare first. On 2026-11-25 the owner said: "record the decisions".

This is the entry record. It holds the thirteen decisions in the owner's words, the record that details each, and the proposals that cross both component groups. The design is in the [multi-supplier plan](../plans/multi-supplier-plan.md), which stays a proposal: "A4" and "plan 4.7" below are its assumptions and sections. No task block exists yet. Later on 2026-11-25 the owner answered the lead's questions (43a), (43b) and (43f), and (43c) in part, and asked for all tasks: items 19 to 25 hold these seven decisions in the owner's words, the task blocks followed (Follow-ups), and since then the plan is in force for milestone M7, as re-scoped in its [section 0](../plans/multi-supplier-plan.md#0-re-scope-of-2026-11-25); its assumptions and proposals stay proposals.

## Decision

Items 1 to 13 and 19 to 25 are the owner's. "Detail" names where the design of an item is. That design is mostly proposed, and each record marks it.

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
18. **Proposed (lead).** **Hiding rules** (A5; plan 4.7): for a Velexis source, Amadeus included, the OTA never sees the supplier's name, payload, error codes, call log or order reference. Without an own active Amadeus connection, 15 Amadeus-only operations answer `403 FEATURE_DISABLED`. The published contract keeps its Amadeus-named members. 2026-11-25: the owner decided that the Amadeus tools are hidden now (item 21); the list of 15 operations and the answer `403 FEATURE_DISABLED` stay this proposal; as the lead reads item 21, the first part is built on today's connection model.
19. **Decided (owner, 2026-11-25).** "Prior to launch. The multi supplier engine has to be ready before launch." This answers the lead's question (43a), when M7 runs against the launch: after it, before it, or with a fixed weekly share of the review hours (question 1 below). Detail: [ADR-0025](0025-roadmap-scheduling-and-tracking.md) item 3 (dated note of 2026-11-25); plan §0. The lead reads this as: milestone M7 holds the launch scope, and M7's tasks start now, while the open tasks of M0 to M6 wait on the owner's steps, a nightly run or the launch.
20. **Decided (owner, 2026-11-25).** "It should have the pre-request, post-response and post-merge rule engine as well. Start with base rule engine (whatever was documented), and I'd work on it later (post launch)." The owner wrote this in the same answer to (43a). Detail: OADR-0019 (the hooks and the rules); plan 4.3. The lead reads this as: "whatever was documented" is plan 4.3 and OADR-0019 items 11, 12 and 14, and OADR-0019 item 13 for Velexis's rules, so the three hooks, rules stored as data, the handlers and the rules screen of the platform admin come before the launch, the owner's later work on the rule engine has no task now, and the hooks keep the names "pre-action", "post-action" and "post-merge" of item 13 above until the owner answers question (44c).
21. **Decided (owner, 2026-11-25).** "Hide Amadeus tools right now (I would resurface them later when there is functionality of adding OTAs own Amadeus, that would be post launch in a different release)." This answers, with item 22, the lead's question (43b): who works an OTA's queues between hiding the supplier and the reconciliation tools (question 2 below). Detail: item 18; PADR-0020 (the Suppliers page); PADR-0015 (the switch `FEATURE_OWN_AMADEUS`). The lead reads this as: hiding the tools is the first build phase and uses today's connection model, so an OTA whose Amadeus connection is Velexis's gets no tool, an OTA with its own active Amadeus connection keeps them, and no test is deleted, because a test OTA with its own connection keeps the existing tool tests running; the release after the launch is milestone M8, which holds an OTA's own Amadeus account beside Velexis supply, an OTA's own PKFare account (question (44d)), the "Amadeus" and "PKFare" sections of the Suppliers page beyond what exists today, an OTA's rules for its own suppliers and the tasks the plan called "Later"; and what exists today for own Amadeus credentials stays as it is, behind its switch.
22. **Decided (owner, 2026-11-25).** "I want to launch with the reconciliation process ready from the platform." This is the rest of the answer to (43b). Detail: PADR-0021. The lead reads this as: the plan's reconciliation phase (P9) is in M7 and part of launch readiness.
23. **Decided (owner, 2026-11-25).** "Keep limit to 0. It should be configurable from Platform Admin's OTA management." This answers part of the lead's question (43c) (question 3 below): the default of the daily limit per OTA is 0. It does not say what 0 means, so whether the limit is on by default is still question (44a), and the Stripe modes of (43c) stay open. Detail: PADR-0020 (the daily limit); OADR-0020 (the stops). The lead reads this as: the limit is one platform value per OTA, changed in the platform admin's OTA page with a reason and an audit row, read by the OTA backend and enforced before the capture, and the part of a task that needs the meaning of 0 does not start before the owner's answer to (44a).
24. **Decided (owner, 2026-11-25).** "go". This answers the lead's question (43f): go or no go for the documentation notes in SDK 1.0.0, the fourth of the lead's earlier proposals (below). Detail: plan 4.8; the task SDK-020. The lead reads this as: the SDK 1.0.0 notes run first and get one more note, that the Amadeus console operations can be refused with `403 FEATURE_DISABLED` for an OTA without its own Amadeus connection, which follows from item 21.
25. **Decided (owner, 2026-11-25).** "publish all the tasks and their details in a manner which is consistent with current task tracking". The owner asked for this after the answers. Detail: Follow-ups (the three task files); plan §0.
26. **Proposed (lead).** **How the Proposed items are confirmed** (items 20 and 25). The task blocks are written from the documented design. A block names, in "Read first", the record items it builds, and says which of them are still Proposed. When the lead proposes a wave, the lead lists the Proposed items that the wave's tasks name, and the owner's go for the wave accepts them. Basis: the owner's words "whatever was documented" (item 20) and "publish all the tasks and their details in a manner which is consistent with current task tracking" (item 25).

The lead's four earlier proposals stay proposals: capture before the ticketing request, and the safety set for a paid booking without a ticket (OADR-0020); one offer per like-for-like flight (OADR-0019); documentation notes only in SDK 1.0.0. 2026-11-25: the fourth, documentation notes only in SDK 1.0.0, is decided by item 24.

## Revisions to other records

Dated notes of 2026-11-25 point here. Each rests on an owner's decision: [ADR-0010](0010-secrets-envelope-encryption.md) (Context), [ADR-0011](0011-payments-stripe-and-airline-card.md) (Settlements) and [ADR-0012](0012-amadeus-account-model.md) (Context, Lifecycle item 3, Office isolation). The component records have their own notes of the same date, listed in OADR-0019, PADR-0020 and PADR-0021: OADR-0001 (point 1), PADR-0006 (item 8), PADR-0010 (Context), PADR-0012 (item 4) and PADR-0015 (item 6).

The owner's answers of 2026-11-25 (items 19 to 25) bring more dated notes of that date. [ADR-0025](0025-roadmap-scheduling-and-tracking.md) item 3 rests on item 19: M7 is built before the launch. [PADR-0015](../../../platform/docs/adr/0015-milestone-feature-switches.md) and the platform's [launch checklist](../../../platform/docs/runbooks/launch-checklist.md) rest on item 21: the switch `FEATURE_OWN_AMADEUS` stays off at launch. OADR-0019, OADR-0020, PADR-0020 and PADR-0021 record their own parts of these answers.

## Notes that wait for a decision

These would rest on a proposal or an open question. Nobody writes them before the owner decides.

- [ADR-0025](0025-roadmap-scheduling-and-tracking.md) item 5: whether PKFare's certification and the live co-test are outside steps that do not gate the launch, so that X-073 is a named exception (question 11, (44b)).
- [ADR-0003](0003-six-components-two-nestjs-backends.md) and [ADR-0009](0009-background-jobs-bullmq.md) item 3: the reconciliation role's interface and its facts on the queue (A7, A36).
- [ADR-0004](0004-postgresql-schema-per-tenant.md) and `conventions.md` §1: the id format (item 15).
- [ADR-0006](0006-contract-first-openapi.md): the new meanings of item 17.
- [ADR-0011](0011-payments-stripe-and-airline-card.md): capture before the ticketing request; Stripe only for other suppliers (A6).
- [ADR-0012](0012-amadeus-account-model.md) Lifecycle item 2: go-live with any active supply source (A11).
- [ADR-0015](0015-testing-strategy.md): a PKFare fake (plan 4.15).
- OADR-0016: the SDK notes. 2026-11-25: decided by item 24; the task SDK-020 writes the note.

## Consequences

### Positive

- One place states what the owner decided, in the owner's words, apart from what is only proposed.

### Negative

- The decisions are in force before any code follows them. The code still knows one supplier.
- The documents below `decisions.md` that describe the system as built (`README.md`, `AGENTS.md`, [`architecture.md`](../architecture.md), the component documents and the guidebook) still describe one supplier. Each changes with the task that builds its part.
- Hiding has limits. As proposed, the contract keeps Amadeus-named members (item 18), and `supplyId` lets anyone count Velexis's sources (item 14; plan 9.3).
- Offline recovery is credit given by Velexis (plan 9.4).
- The plan counts 836 to 1,254 agent-hours (plan §7).
- The launch now waits for M7 (item 19). In the lead's re-scope (plan §0), M7 has 169 tasks and 776 agent-hours, which the rule of plan §7 (agent-hours times 0.46875, 30 review hours a week, a 20 % buffer, rounded up) turns into 15 full review weeks of the one reviewer (likely 17, high 22). Milestone M8, the later release of item 21 as the lead reads it, has 17 tasks and 84 agent-hours after the launch.
- The switch `FEATURE_OWN_AMADEUS` (PADR-0015) stays off at launch, because the functionality for an OTA's own Amadeus account comes after the launch (item 21). So PBE-064, which removes the six milestone switches once all six have been on in production for one release, waits for that later release.

### Follow-ups

- The owner confirms or changes items 14 to 18 and answers the open questions. The developer then sets the status. 2026-11-25: item 26 too; it proposes how the owner's go for a wave confirms the Proposed items that the wave's tasks name.
- Ten assumptions of the plan are in no item of the five records. A13, A29 and A43 are in open questions; A21 and A41 are in Follow-ups; A25, A27, A35, A40 and A42 are named in no record. They stay proposals of the plan until the owner confirms them. 2026-11-25: question 1, which held A13, is answered (item 19); A43, the live co-test after the launch, is now part of question (44b).
- The waiting notes and the task blocks follow. 2026-11-25: the task blocks are published: 169 tasks in milestone M7 and 17 in milestone M8, in the three task files, [`foundation-tasks.md`](../plans/foundation-tasks.md), the platform's [`agent-tasks.md`](../../../platform/docs/plans/agent-tasks.md) and the OTA's [`agent-tasks.md`](../../../ota/docs/plans/agent-tasks.md); the plan is re-scoped in its [section 0](../plans/multi-supplier-plan.md#0-re-scope-of-2026-11-25).

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

Only the owner answers these. Each recommendation is the lead's proposal. The sections are the plan's. For questions 2 to 7 the detail record named has the options and the recommendation. Questions 1 to 5 are the lead's questions (43a) to (43e); questions 10 to 13 are (44a) to (44d), asked on 2026-11-25.

| # | Question | Options | Recommendation (the lead's proposal) |
|---|---|---|---|
| 1 | When does M7 run against the launch? (§7, 9.5) **Answered on 2026-11-25: before the launch (item 19).** | After it; before it, where each M7 review week moves the launch by one week; or a fixed weekly share | A13 says beside M6; plan 9.1 says that this must become one of the three. The SDK 1.0.0 publish first; PKFare live after the launch (A43) |
| 2 | Who works an OTA's queues between hiding the supplier (P5) and the reconciliation tools (P9)? (9.3) **Answered on 2026-11-25 (items 21 and 22).** | [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md), question 3 | There |
| 3 | The wallet's default daily limit per OTA, and the Stripe modes allowed with Velexis supply (9.1, 9.4) **Answered in part on 2026-11-25 (item 23); open: what 0 means (44a) and the Stripe modes.** | [PADR-0020](../../../platform/docs/adr/0020-supplier-registry-switches-and-suppliers-page.md), question 1 | There |
| 4 | Counsel: is Velexis a processor for each OTA, or a controller of its own? (4.14) **The owner asked the lead to explain on 2026-11-25; open.** | [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md), question 1 | There |
| 5 | Who staffs the reconciliation role? (§8) **The owner asked the lead to explain on 2026-11-25; open.** | [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md), question 2 | There |
| 6 | Low-cost content, if PKFare's sandbox shows no reliable mark for it (9.1) | [OADR-0020](../../../ota/docs/adr/0020-suppliers-paid-from-a-balance.md), question 1 | There |
| 7 | Paid bags after ticketing (9.6) | [OADR-0020](../../../ota/docs/adr/0020-suppliers-paid-from-a-balance.md), question 2 | There |
| 8 | Does staff Shopping go with the other Amadeus screens? (9.3) | Hidden with PNR lookup, Queues and Supplier log; or kept | Hidden |
| 9 | The traveller's reference when Amadeus returns no airline locator (9.3) | Amadeus's own locator; or none until a ticket number exists | No recommendation in plan 9.3; as drafted the plan shows the airline's reference or none (item 17) |
| 10 | What does a daily limit of 0 mean? (44a; item 23; 4.6) | 0 means no limit; or 0 means no ticket is paid from the wallet until staff set a limit | Say which; the lead prefers the second, because it cannot lose money by mistake |
| 11 | Does the launch wait for PKFare's certification? (44b; §8; [ADR-0025](0025-roadmap-scheduling-and-tracking.md) item 5) | The launch waits for PKFare's certification; or PKFare stays switched off in production until it is certified, and the launch does not wait | The second (ADR-0025 item 5): the task of PKFare's live step, X-073, is then a named exception |
| 12 | Are the hooks renamed? On 2026-11-25 the owner wrote "pre-request, post-response and post-merge" (44c; items 13 and 20) | Keep "pre-action", "post-action", "post-merge"; or rename to "pre-request", "post-response", "post-merge" | Keep, because an action is more than one request |
| 13 | Does an OTA's own PKFare account also move after the launch? (44d; item 21) | It moves after the launch with own Amadeus; or it stays in the launch scope | It moves, as the re-scope of plan §0 has it |

Plan 9.6 lists more points to confirm. Items 1, 3 and 7 are questions in OADR-0019 and OADR-0020, and item 5 is under Consequences in OADR-0019. Item 4 (schedule changes of PKFare orders) is in no record: the plan leaves it to the task blocks of P7.
