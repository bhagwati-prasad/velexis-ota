# Multi-supplier plan: ingestion engine, supplier adapters and Velexis supply

> **Status: Proposed on 2026-11-24. In force for milestone M7 from 2026-11-25 (ADR-0030 items 19 to 25), as re-scoped in [section 0](#0-re-scope-of-2026-11-25). The owner's decisions it lists were recorded on 2026-11-25.**
>
> - This file is a plan, not a decision record. On 2026-11-25 the owner's thirteen decisions of 2026-11-24 ([section 2](#2-what-the-owner-decided)) were recorded in [`docs/mvp/decisions.md`](../decisions.md) and in ADR-0030 (the entry record), OADR-0019, OADR-0020, PADR-0020 and PADR-0021.
> - Everything else is proposed and not decided: the assumptions of [section 3](#3-assumptions-to-confirm), the design of section 4 that rests on them, the lead's four proposals and the open questions of [section 9](#9-risks-and-open-questions). The five records mark each item **Decided** or **Proposed**. 2026-11-25: the owner's answers of that day are decided too ([ADR-0030](../adr/0030-suppliers-supply-sources-and-ingestion-engine.md) items 19 to 25); item 24 decides the fourth proposal, the SDK notes.
> - No task block exists yet, so no task starts from this plan. Task keys such as `E2-08` are placeholders. Phase P0 gives the real ids. 2026-11-25: the task blocks exist now, and [Annex C](#annex-c-plan-keys-and-task-ids) gives the real id of each key.
> - **The owner's answers of 2026-11-25.** Later that day the owner answered the lead's questions (43a), (43b) and (43f), and (43c) in part, and asked for all tasks. Since then the plan is in force for milestone M7, as re-scoped in section 0. The re-scope, that is the phases A to L and the list of milestone M8, is the lead's reading of the answers, not the owner's decision. The task blocks in the three task files are now the source for the work. Annex B is kept as the proposal it was. Being in force confirms no proposal: the lead proposes that the owner's go for a wave accepts the Proposed items that its tasks name (ADR-0030 item 26).

## 0. Re-scope of 2026-11-25

On 2026-11-25 the owner answered the lead's questions (43a), (43b) and (43f), and (43c) in part, and asked for all tasks. This section says what that changes. It keeps two things apart: what the owner decided, in the owner's words, and the lead's re-scope, which is the lead's reading of those words and not a decision. Sections 1 to 9 and Annexes A and B keep their text. Where an answer makes one of their sentences false, a dated sentence follows it.

### 0.1 What the owner decided

Decided by the owner on 2026-11-25. [ADR-0030](../adr/0030-suppliers-supply-sources-and-ingestion-engine.md) items 19 to 25 record each decision with the owner's words, and [`decisions.md`](../decisions.md) holds the rows that rest on items 19 to 23.

| ADR-0030 item | Answers | Decided | The owner's words |
|---|---|---|---|
| 19 | (43a) | M7 is built before the launch. The multi-supplier engine is ready at launch. | "Prior to launch. The multi supplier engine has to be ready before launch." |
| 20 | (43a) | The engine has the rule engine at the three hooks before the launch. The base is what was documented. The owner works on it after the launch. | "It should have the pre-request, post-response and post-merge rule engine as well. Start with base rule engine (whatever was documented), and I'd work on it later (post launch)." |
| 21 | (43b) | The Amadeus tools are hidden now. They come back after the launch, in a different release, with the functionality for an OTA's own Amadeus account. | "Hide Amadeus tools right now (I would resurface them later when there is functionality of adding OTAs own Amadeus, that would be post launch in a different release)." |
| 22 | (43b) | The launch has the reconciliation process ready from the platform. | "I want to launch with the reconciliation process ready from the platform." |
| 23 | (43c), in part | The daily limit per OTA is 0 by default and is set in the platform admin's OTA management. | "Keep limit to 0. It should be configurable from Platform Admin's OTA management." |
| 24 | (43f) | The documentation notes for SDK 1.0.0 are added now. | "go" |
| 25 | none: asked after the answers | Every task of the plan is published in the tracked task files. | "publish all the tasks and their details in a manner which is consistent with current task tracking" |

The dated note of 2026-11-25 under [ADR-0025](../adr/0025-roadmap-scheduling-and-tracking.md) item 3 records what item 19 means for the order of the milestones: M7's tasks start before M6's go/no-go, and the launch go/no-go waits for M7 too.

### 0.2 The lead's re-scope

Everything in this subsection is the lead's reading of the answers, not the owner's decision. ADR-0030 records each reading beside the item or question it reads.

- **M7 is the launch scope** (item 19). Its tasks start now, while the open tasks of M0 to M6 wait on the owner's steps, a nightly run or the launch.
- **The base rule engine** (item 20) is what section 4.3 and OADR-0019 items 11, 12 and 14 document, and OADR-0019 item 13 for Velexis's rules. So before the launch the engine gets the three hooks, rules stored as data, the handlers and the platform admin's rules screen. The owner's later work on the rule engine has no task now. The hooks keep the names "pre-action", "post-action" and "post-merge" until the owner answers question (44c).
- **The Amadeus tools are hidden first** (item 21), in phase B, on today's connection model. An OTA whose Amadeus connection is Velexis's gets no tool; an OTA with its own active Amadeus connection keeps them. No test is deleted: a test OTA with its own connection keeps the existing tool tests running.
- **The later release of item 21 is milestone M8**, after the launch. It holds an OTA's own Amadeus account beside Velexis supply, an OTA's own PKFare account (question (44d)), the "Amadeus" and "PKFare" sections of the Suppliers page beyond what exists today, an OTA's rules for its own suppliers, and the tasks that Annex B calls "Later". What exists today for an OTA's own Amadeus credentials stays as it is, behind the switch `FEATURE_OWN_AMADEUS`, which stays off at launch.
- **Reconciliation** (item 22): phase P9 is in M7 and part of launch readiness.
- **The daily limit per OTA** (item 23) is one platform value per OTA, default 0, changed on the platform admin's OTA page with a reason and an audit row, read by the OTA backend and enforced before the capture. What 0 means is question (44a). The blocks that need it say so, and that part of them does not start before the owner's answer.
- **PKFare's outside steps.** PKFare's certification and the live co-test are outside steps, and ADR-0025 item 5 says that outside approvals do not gate the launch. So the launch needs M7 built and proven on the PKFare fake and in PKFare's sandbox, and PKFare stays switched off in production until PKFare certifies. The task of the live step, X-073, may stay open after the launch as a named exception. This is question (44b).
- **Task blocks from the documented design** (items 20 and 25). Each block names, in "Read first", the record items it builds and says which of them are still Proposed. When the lead proposes a wave, the owner's go for it accepts the Proposed items that its tasks name (ADR-0030 item 26, Proposed (lead)).
- **The SDK 1.0.0 notes run first** (item 24; SDK-020). They get one more note: the Amadeus console operations can answer `403 FEATURE_DISABLED` for an OTA without its own Amadeus connection, which follows from item 21.

**Milestone M7, in twelve phases.** The phases A to L, in this order, replace P0 to P10 of section 6 for the work. "From the plan" names the phase of section 6 and, where a phase changed, the keys of Annex B.

| Phase | Name | From the plan | Tasks | Agent-hours |
|---|---|---|---|---|
| A | Notes, packs and tooling | P0: OS-01, OS-02, RC-02; new: X-053, X-054 | 5 | 10 |
| B | Amadeus tools hidden | P5: OS-13; new: X-055 (the fixture part of OS-17), OBE-106 (the first part of OS-04) | 3 | 12 |
| C | PKFare facts, sandbox and fixtures | P1 | 6 | 20 |
| D | Engine and interface, Amadeus search and pricing | P2 | 16 | 68 |
| E | Amadeus adapter for booking | P3 | 22 | 106 |
| F | Platform: registry, switches, Velexis accounts, wallet, Suppliers page | P4 without SP-10 and SP-20; SP-11 without `setSupplierSelection`; SP-14 without the PKFare form; new in the review: X-075, PBE-105, PAD-025 | 22 | 104 |
| G | The supplier hidden | P5 without OS-13; OS-04 without its first part; OBE-151 (OS-06) grew from S to M in the review | 16 | 68 |
| H | PKFare search and pricing | P6 | 9 | 44 |
| I | PKFare booking, extras and low-cost | P7; BM7-14 without the close-review branch for an OTA's own PKFare source | 25 | 134 |
| J | Rules at the hooks and the platform screen | P8 without E8-02, ED8-03 and ED8-04; E8-08 without the direction for an OTA's own rules | 9 | 46 |
| K | Reconciliation | P9 | 23 | 124 |
| L | Proof and launch readiness | P10 | 13 | 40 |
| **M7** | | | **169** | **776** |

- Phase A runs first: the SDK 1.0.0 notes (SDK-020), the contract annex of ADR-0030 (X-051), the privacy pack for counsel (X-052) and two tool tasks (X-053, X-054).
- Phase F builds the Suppliers page with its Velexis section. It moves into the page what exists today for an OTA's own Amadeus account, shown only while `FEATURE_OWN_AMADEUS` is on.
- Phase G re-keys the guard of phase B from today's connection to supply sources (OBE-149).
- Phase L holds the launch gate for after-sales (X-074) and PKFare's live step (X-073), which the lead reads as a named exception (question (44b)).

**Milestone M8, after the launch.** The later release of item 21, as the lead reads it. Its tasks start after the launch, so they do not move it. In Annex C their phase is Z.

| From the plan | Tasks | Ids | Agent-hours |
|---|---|---|---|
| An OTA's own PKFare account, and own Amadeus beside Velexis: SP-10, SP-20 | 2 | PBE-102, PBE-103 | 12 |
| The split parts: `setSupplierSelection` from SP-11, the PKFare section from SP-14 | 2 | PBE-104, PFE-034 | 6 |
| An OTA's own rules: E8-02, ED8-03, ED8-04 | 3 | OBE-207, OBE-208, OAD-029 | 12 |
| "Later" of Annex B: RC-28 to RC-31, BM7-16, BM7-17 | 6 | OBE-209 to OBE-214 | 36 |
| Found in the review of 2026-11-25, no plan key: the contract steps of the new columns (OTA and platform), an OTA's own Amadeus connection on the OTA side, the cap of open cases per supply source | 4 | OBE-215, PBE-106, OBE-216, PBE-107 | 18 |
| **M8** | **17** | | **84** |

M8 also holds two parts without a task of their own: the direction of E8-08 for an OTA's own rules, which OBE-207 takes up, and the close-review branch of BM7-14 for an OTA's own PKFare source.

### 0.3 Done, new and split tasks

**Done by the records rounds, so no task block.** The records rounds of 2026-11-25 do the work of twelve tasks of P0: G0-01 (`decisions.md`), G0-02, G0-04, G0-05, G0-06 and RC-01 (the five records and their dated notes), G0-03 (the revision of ADR-0025 item 3), G0-07 to G0-10 (the task blocks) and G0-11 (the re-baseline). The dated notes that still wait for a decision, which each record lists, and the owner's case deadlines of RC-01 follow when the owner decides. The other three tasks of P0 are task blocks of phase A: OS-01 (SDK-020), OS-02 (X-051) and RC-02 (X-052).

**New tasks.** The lead added four tasks on 2026-11-25 that the plan did not have:

- X-053 (phase A): plan-lint's mode `--remaining` also lists the open tasks of M7, beside the lowest open milestone.
- X-054 (phase A): `x-milestone` accepts `M7` and `M8`; no operation changes. A task that adds an operation to the OTA contract depends on it.
- X-055 (phase B): a test OTA with its own Amadeus connection, for the integration tests and the end-to-end stack. The tool suites move to it, and no test is removed. It is the fixture part of OS-17.
- OBE-106 (phase B): the guard that hides the Amadeus tools. Unless the OTA's own Amadeus connection is active in that environment, the 15 tool operations answer `403 FEATURE_DISABLED`. It is the first part of OS-04, on today's connection model.

The review of the blocks on 2026-11-25 found work that no block carried, and the lead added seven more tasks, which have no plan key: PBE-105 and PAD-025 (phase F: Velexis staff set the ticketing defaults and monitored queues of an OTA on Velexis supply, which the portal no longer edits for it), X-075 (phase F: the test helpers and seeds write supplier connections and Velexis accounts with their supply source), and, in M8, OBE-215 and PBE-106 (the contract steps of the new columns), OBE-216 (the OTA backend serves an OTA's own Amadeus connection beside Velexis's) and PBE-107 (the cap of open cases per supply source). OBE-151 grew from S to M.

**Split tasks.** Six tasks of Annex B lose a part:

- OS-04 in two parts: the first is OBE-106 (phase B); OBE-149 (phase G) keeps the second, which re-keys the guard to supply sources. Its dependency on SP-20 is dropped.
- OS-17 (X-063) without the fixture OTA with its own Amadeus connection, which is X-055 in phase B; X-063 uses it.
- SP-11 (PBE-085) without `setSupplierSelection`, which is PBE-104 in M8: in the lead's re-scope an OTA has Velexis supply only at launch; for an OTA's own PKFare account this is question (44d), open.
- SP-14 (PFE-033) without the PKFare form, which is PFE-034 in M8.
- E8-08 (OBE-194) without the direction for an OTA's own rules, which goes to M8 with OBE-207.
- BM7-14 (OBE-179) without the close-review branch for an OTA's own PKFare source, which goes to M8.

Smaller changes are in the notes of the blocks. For example: OS-13 (OAD-024) moves to phase B; SP-01 (PBE-078) leaves out the value `pkfare` of `credential_submissions.kind`; E8-04 (OBE-190) reads Velexis's rules only; RC-27 (X-074) moves its first daily check against the supplier's statement to the live step X-073, because that check needs live PKFare.

**Ids.** Milestones M7 and M8 use 186 ids: X-051 to X-075, OBE-106 to OBE-216, PBE-078 to PBE-107, PFE-032 to PFE-034, PAD-018 to PAD-025, OFE-033, OAD-024 to OAD-029, SDK-020 and SDK-021. [Annex C](#annex-c-plan-keys-and-task-ids) maps each plan key to its id.

### 0.4 Effort and the launch

Milestone M7 has 169 tasks and 776 agent-hours (24 S, 108 M and 37 L). Milestone M8 has 17 tasks and 84 agent-hours (2 S, 10 M and 5 L).

From Annex B: its first release had 179 tasks and 836 agent-hours. The twelve tasks of the records rounds (64 agent-hours) and the five tasks moved to M8 (24 agent-hours) leave it, and the four new tasks (12 agent-hours) join it: 179 − 12 − 5 + 4 = 166 tasks, and 836 − 64 − 24 + 12 = 760 agent-hours. M8 holds those five tasks, the six "Later" tasks (36 agent-hours) and the two split parts (6 agent-hours). The review of the blocks then added three tasks to M7 (14 agent-hours) and grew one by 2 agent-hours, which gives 169 tasks and 776 agent-hours, and four tasks to M8 (18 agent-hours), which gives 17 tasks and 84 agent-hours.

The rule of section 7 turns agent-hours into review weeks: review hours are agent-hours times 0.46875, a week has 30 review hours, a 20 % buffer is added, and the result is rounded up to full weeks. For M7: 776 × 0.46875 = 363.75 review hours; that is 12.1 weeks at 30 hours and 14.55 with the buffer, so 15 full review weeks of the one reviewer. The likely and high cases add 15 % and 50 % to the agent-hours, as in section 7.

| Case | Agent-hours | Review hours | Weeks at 30 h | With 20 % buffer | Full review weeks |
|---|---|---|---|---|---|
| Low: the sum of M7's tasks | 776 | 364 | 12.1 | 14.55 | 15 |
| Likely: low + 15 % | 892 | 418 | 13.9 | 16.73 | 17 |
| High: low + 50 % | 1,164 | 546 | 18.2 | 21.83 | 22 |

**The launch now waits for M7** (item 19). One person reviews, so each review week of M7 moves the launch by one week (section 7): 15 weeks, likely 17, high 22. These figures leave out what section 7 leaves out, such as the owner's outside steps and the fixes that reviews ask for. M8 comes after the launch and does not move it. The roadmap's re-baseline under ADR-0025 item 6 places M7 in its calendar.

### 0.5 Where the work is tracked

The task blocks in the three task files are now the source for the work: [`foundation-tasks.md`](foundation-tasks.md) (`X-`), the platform's [`agent-tasks.md`](../../../platform/docs/plans/agent-tasks.md) (`PBE-`, `PFE-`, `PAD-`) and the OTA's [`agent-tasks.md`](../../../ota/docs/plans/agent-tasks.md) (`OBE-`, `OFE-`, `OAD-`, `SDK-`). Each block has its id, size and milestone, and names its plan key in "Read first". Annex B is kept as the proposal it was. The blocks cite the lead's rulings for the task blocks by code (G1 to G12, T, S1 to S18); [Annex D](#annex-d-the-leads-rulings-for-the-task-blocks) states each one.

### 0.6 Still open

The owner has not answered these. This plan answers none of them. ADR-0030's table "Open questions for the owner" holds each one, with the lead's recommendation.

- (44a) What a daily limit of 0 means (question 10).
- (44b) Whether the launch waits for PKFare's certification (question 11).
- (44c) Whether the hooks "pre-action" and "post-action" are renamed to "pre-request" and "post-response" (question 12).
- (44d) Whether an OTA's own PKFare account also moves after the launch (question 13).
- (43d) Counsel on Velexis's role, and (43e) who staffs the reconciliation role. The owner asked the lead to explain both (questions 4 and 5).
- The Stripe modes of (43c): which of them may use Velexis supply at first (question 3).
- ADR-0030 questions 6 to 9: low-cost content when PKFare's sandbox shows no reliable mark, paid bags after ticketing, whether staff Shopping goes with the other Amadeus screens, and the traveller's reference when Amadeus returns no airline locator; and the open questions of OADR-0019, OADR-0020, PADR-0020 and PADR-0021.
- Every item marked **Proposed** in the five records that the answers do not touch.

## 1. Summary

Today Amadeus Enterprise is the only supplier (a company that sells flight content through an API), and business code calls it directly. This plan describes a new milestone, M7.

- An **ingestion engine** stands between the booking flow and the suppliers, as one module of the OTA backend. A search fans out to the **adapter** of every enabled supplier, and the engine merges the results. Other actions go to the supplier of the offer or booking.
- Amadeus becomes the first adapter, with no change in behaviour. PKFare becomes the second: search, pricing, booking, ticketing paid from Velexis's prepaid wallet, extras (paid bags and seats, booked with the order) and low-cost content, if PKFare's sandbox shows how to recognise it (9.1).
- Three **hooks** (pre-action, post-action, post-merge) run rules stored as data: supplier selection, carrier rules, price rules, removal of duplicates, limits.
- The platform gets a registry: an id with a history for every supply source (one supplier used through one account), switches globally and per tenant, one **Suppliers page** in the portal, Velexis's own supplier accounts and a wallet watch.
- An OTA (a tenant travel agency) on Velexis supply is not shown which supplier served a booking. Amadeus tools open only with the OTA's own Amadeus account.
- A reconciliation role for Velexis staff gets a ledger, cases, an audited view of Velexis-supplied bookings and an export for offline reconciliation.

Decided by the owner (section 2): the engine with fan-out and merge, the adapters, the three hooks, the switches, the id with its history, the Suppliers page, the hidden supplier, the wallet, the reconciliation role, offline reconciliation, extras and low-cost content. Proposed and not decided: the engine's place (A1), rules as data (A2), routing by offer or booking (A3), the wallet watch (A6, A26), the ledger and the audited view (A7), the cases (A8), the milestone (A13), the removal of duplicates (proposal 3). 2026-11-25: the milestone runs before the launch, by the owner's decision of that day (ADR-0030 item 19); section 0 gives the owner's other answers.

Three numbers: **11 phases** (P0 to P10); **836 to 1,254 agent-hours** over 179 tasks (likely 961); **16 to 24 full review weeks** (likely 19) of the one reviewer, whose hours the launch also needs. 2026-11-25: section 0 gives the numbers of the re-scope.

**First visible result:** PKFare offers in the merged list on the local stack, after 51 tasks (234 agent-hours, 5 full review weeks). Nothing is sellable then: a PKFare booking needs P3, P4 and P7. PKFare goes live for one OTA only after the product launch and the gate of P10 (A43). Each M7 review week before the launch moves the launch by one week (section 7). 2026-11-25: M7 is built before the launch, by the owner's decision of that day (ADR-0030 item 19), so the launch now waits for M7 (section 0). Whether the launch also waits for PKFare's certification is question (44b), open.

## 2. What the owner decided

All quotes are from the owner's two messages of 2026-11-24.

| # | Decision in short | The owner's words | What it changes today |
|---|---|---|---|
| 1 | Adapters behind one interface | "I want to use suppliers as an adapter, so that the booking flow is agnostic to the supplier. I need a common interface, which works independently and an adapter which implements the interfaces." | No supplier interface exists. |
| 2 | Several suppliers, PKFare first; switches globally and per tenant | "I would add multiple suppliers. PKFare is first in line. I want the ability to enable and disable the supplier globally from admin portal, as well as per tenant." | No global switch exists. Per tenant, staff can only set the one Amadeus connection to `disabled`, which also stops existing orders (4.4). |
| 3 | Velexis supply, own accounts, or both; Velexis's suppliers hidden behind an id | "Each OTA can have their own Amadeus or PKFare. OTA can use either the velexis as supplier OR their own (Amadeus or PKFare or something else, it could be all or some of them). OTAs/Tenants should not be aware of suppliers which Velexis uses internally to supply to the OTAs. Use an id (md5 or something else) to identify the supplier on OTA end." | One Amadeus connection per OTA and environment. Every OTA surface names Amadeus. |
| 4 | One flow | "The flow for all of the suppliers should remain the same." | The booking orchestrator stays one class. |
| 5 | OTAs pay through Velexis's PKFare wallet | "OTAs pay through the Velexis PKFare wallet. OTAs don't have to worry about it." | New: Velexis pays the supplier from a prepaid balance. |
| 6 | No supplier shown; Amadeus tools only with an own account; one Suppliers page | "The OTA need not to know the supplier. They should focus on selling only. The Amadeus surface (making queues etc) would only be useful if they integrate their own Amadeus account. For now, do not surface those APIs. Change the Amadeus section to "Suppliers", it should have a single config page with "Velexis", "Amadeus" and "PKFare" as sections. If they select "Amadeus" or "PKFare" as well, then they should provide their credentials for Integration and then the current Amadeus APIs would be useful." | Queues, PNR import and 12 raw Amadeus operations are open to every OTA. |
| 7 | The ticket cost is recovered offline | "I will do it offline. I would reconcile with OTA later." | The system records and exports; no settlement line. |
| 8 | A reconciliation role | "I would make another role for reconciliation which would get reference to OTA bookings." | Staff cannot see tenant bookings today. |
| 9 | An id in the search; an OTA may ask for the supplier | "The search would contain some form of ID. If need be, they can ask for supplier, but they do not need to know. They should focus on marketing and selling tickets." | A supply id on offers and bookings; a disclosure procedure. |
| 10 | PKFare has agreed | "PKFare agrees, we have signed up with them." | Sandbox, certification and co-test remain. |
| 11 | A good id format, with a history table | "Choose a good format for id, even if id changes it should be discernable. I suggest making a log table for supplier ID to get historic IDs if they change." | A new id and its history table. |
| 12 | Extras and low-cost content in the first release | "the extras and low-cost should be in the first release. Bake in the extras in the interface, if there are no extras then it should be skipped for that booking." | Extras become optional. A booking can lack an e-ticket number. |
| 13 | An ingestion engine with three hooks, also for OTAs | "I propose creating an ingestion engine. The interface would be used by current app. For a given action (for example search), it should fan out the action and parameters to all enabled supplier's (Amadeus, PKFare, Duffle or anyone else) adapter which would form the appropriate request, the results should then be merged and sent from the ingestion engine. I also want to expose "pre-action", "post-action" and "post-merge" hooks so that I can manage them better. I would then be able to add markup for certain suppliers, or disable some supplier for some specific search query (maybe based on origin or destination or time or airline or something else) or do some other management. The same engine would be provided to OTAs as well, so that they can manage things if they use their own supplier." | A search is one Amadeus call today. |

**Proposed by the lead, not yet confirmed.** The owner has not answered these points. 2026-11-25: the owner answered point 4 with a go (question (43f); ADR-0030 item 24); points 1 to 3 are still not answered. Section 0 lists the owner's other answers of that day.

1. Capture the traveller's payment before asking the supplier to ticket.
2. Staff decide a booking that is paid and not ticketed, with a safety set: a repeating alert, an open-cases list, an automatic stop of sales after a balance refusal, and a true e-mail to the traveller.
3. The same flight from two sources is shown once when the offers are like for like. The cheaper wins only above a minimum saving.
4. SDK 1.0.0 gets documentation notes only.

## 3. Assumptions to confirm

None of these is decided. The lead made A1 to A15; the section writers added A16 to A43. P0 confirms each one. [Section 9.1](#91-assumptions-that-cannot-work-as-written) lists seven that cannot work as written. 2026-11-25: the owner's answers settle when M7 runs (A13: before the launch) and the default of the daily limit in A6 (0); nothing else here is decided. The records rounds of 2026-11-25 did most of P0 without confirming the assumptions; the lead proposes that the owner's go for a wave accepts those that its tasks name (ADR-0030 item 26).

| # | Assumption of the lead |
|---|---|
| A1 | The engine is a module inside the OTA backend (`ota/backend/src/supply/`), not a new service. |
| A2 | Hooks are extension points in code. Staff and OTAs manage rules stored as data. No tenant-supplied code ever runs. |
| A3 | Search fans out; other actions go to the supplier of the offer or booking. Hooks on money actions may refuse or observe, never change an amount. |
| A4 | A supply source is one supplier used through one account, Velexis's or the OTA's own. Its public id is `sup_` plus 16 random base32 characters, with a history table. Offers and bookings carry it. |
| A5 | For a Velexis source the OTA never sees the supplier's name, payload, error codes, call log or order reference, Amadeus included. Amadeus-only tools need an own active Amadeus connection. The published contract keeps its Amadeus-named members. |
| A6 | Non-Amadeus sources take Stripe only, captured before the ticketing request. Velexis's wallet pays a Velexis PKFare ticket. The system records debits and reimbursements and offers an export. A wallet floor stops sales. A daily limit per OTA is off by default. 2026-11-25: on the daily limit the owner decided "Keep limit to 0. It should be configurable from Platform Admin's OTA management." (ADR-0030 item 23); what 0 means is question (44a), open. |
| A7 | The reconciliation role belongs to Velexis staff and sees Velexis-supplied bookings only. Facts reach a platform ledger as queue events; details and actions go through an audited interface of the OTA backend. |
| A8 | An unpaid or unticketed order is released by API. For a ticketed Velexis-supplied booking the OTA raises a request, which becomes a case for the role. PKFare void and refund requests come later. |
| A9 | Extras are an optional capability. Low-cost content is in the first PKFare release: a booking can be complete without an e-ticket number, and "no change, no refund" is shown before payment. Velexis staff manage carrier rules. |
| A10 | `FlightOffer.source` becomes the content type (GDS, NDC, low-cost) whatever the supplier, with one new neutral value. |
| A11 | Onboarding and go-live ask for "at least one active supply source in that environment". |
| A12 | A platform registry holds a state per supplier and environment, and per tenant and source. "Off" stops new searches, offers and checkouts; existing bookings stay serviced. |
| A13 | The work is a new milestone M7 beside M6, by a revision of ADR-0025 item 3. Nothing may delay the SDK 1.0.0 publish. Answered on 2026-11-25: before the launch. The owner: "Prior to launch. The multi supplier engine has to be ready before launch." (ADR-0030 item 19; the dated note of 2026-11-25 under ADR-0025 item 3). |
| A14 | The OTA admin gets a rules screen only for OTAs with own supplier accounts. Velexis's rules are invisible to OTAs. 2026-11-25: in the lead's re-scope the OTA admin's rules screen (OAD-029) is milestone M8, with an OTA's own supplier accounts (section 0). |
| A15 | Velexis may add its own price rule on Velexis-supplied content. The OTA sees the result as its cost price, never the supplier's net price. |

| # | Assumption of a section writer | Section |
|---|---|---|
| A16 | A search fails only when no called source answers. | Engine |
| A17 | Shares of the search limit are equal. A losing duplicate is not stored. | Engine |
| A18 | "Like for like" compares flights, cabins, included bags, and change and refund conditions. | Engine |
| A19 | A failing hook fails closed where a hook may refuse: Search, Price and Create order. No hook, failing or not, stops Check payable, ticketing, a read, a release or a service request (this narrows A3). | Engine |
| A20 | A priced offer pins its rule versions. Price rules adjust the fare, not extras. | Engine |
| A21 | Velexis's rules reach the OTA backend by a read grant on a new platform table. Reading the wallet balance is not an engine action of its own: the platform's wallet watch reads it for the floor (4.6), and the PKFare adapter reads it inside Check payable, in the OTA backend, once per completion. | Engine |
| A22 | The global switch also stops the OTAs' own accounts of that supplier. | Platform |
| A23 | A new Velexis source starts off for every OTA. An OTA selects "Velexis" as a whole. | Platform |
| A24 | `amadeus_accounts` stays; a new table holds Velexis's account for every other supplier. | Platform |
| A25 | For a Velexis source, ticketing defaults and monitored queues become staff settings. | Platform |
| A26 | Wallet numbers: a read every five minutes, an hourly stop alert, "balance unknown" after three failed reads. The owner sets floor and warning level. | Platform |
| A27 | Names of new contract members are proposals. A refused tool reuses the feature name `console.rawAmadeus`. A reworded default error text is additive. | OTA surface |
| A28 | A10 with two new values, `LCC` and `OTHER`; a Velexis source never answers `LTC`, `PYTON` or `EAC`. | OTA surface |
| A29 | An OTA's own PKFare account gets no call log and no tools in the first release. 2026-11-25: in the lead's re-scope an OTA's own PKFare account is milestone M8, after the launch (section 0); whether it moves is question (44d), open. | OTA surface |
| A30 | Extras after booking stay off for a source that needs a second order. | OTA surface |
| A31 | The Ticketing request goes out in the completion request; a job sends it only after a late capture. | Money |
| A32 | N = 30 minutes (paid, no ticket), K = 3 open cases per source, H = 24 hours (tickets or a refund). Margins: 5 minutes before the capture deadline, 20 minutes for the second OrderPricing. | Money |
| A33 | An unknown answer to an order request stays with staff (for a Velexis source the reconciliation role, 4.10), until PKFare confirms in writing that an unpaid order is never debited. | Money |
| A34 | The watchdog and the held-back confirmation follow the capability "tickets later, paid from a supplier balance", not PKFare's name. | Money |
| A35 | Every contact e-mail and phone number sent to PKFare for a Velexis source (PreciseBooking `email`, `mobile`, `buyerEmail` and `buyerMobile`; Ticketing `email` and `telNum`) is a Velexis mailbox or number. Limits for extras are checked when the selection is stored. | Money |
| A36 | The platform admin's server calls the support interface, with a one-time handoff through Redis. | Reconciliation |
| A37 | The role is separate from "platform admin". The OTA sees the role's actions in its audit list. | Reconciliation |
| A38 | The ledger holds the OTA's cost price. Velexis-supplied Amadeus bookings get ledger rows and cases too. | Reconciliation |
| A39 | Deadlines: for a rejected ticket a deadline shorter than H (proposal: H less 4 hours), so that the OTA can refund inside H; one working day for a cancel request; for a schedule change the earlier of 48 hours and 24 hours before departure; three working days for a disclosure. | Reconciliation |
| A40 | Five new records, not three. New operations carry `x-milestone: M6`. 2026-11-25: in the lead's re-scope X-054 lets `x-milestone` take `M7` and `M8`, and a task that adds an operation to the OTA contract depends on it (section 0). | Governance |
| A41 | Task blocks are written phase by phase; those of P6 and P7 after the P1 facts. 2026-11-25: the owner asked for all tasks (ADR-0030 item 25), so the blocks of all phases were written that day, those of P6 and P7 before the P1 facts, from the documented design (the lead's proposal, ADR-0030 item 26). The PKFare client, search, pricing and booking tasks still depend on the facts and fixtures of phase C (section 0). | Governance |
| A42 | PKFare's reference pages are committed only if its terms allow it. | Governance |
| A43 | The live co-test comes after the product launch. 2026-11-25: M7 is built before the launch, by the owner's decision of that day (ADR-0030 item 19). Where the co-test falls is now part of question (44b), open: whether the launch waits for PKFare's certification. | Governance |

## 4. Target design

Marks: **(owner)** decided by the owner (section 2); **(A5)** an assumption of section 3; **(proposal)** a proposal of the lead, not answered; **(unknown)** a fact that PKFare has not confirmed (section 9.2). A name in code style after a rule, such as `unknown-source-refused`, is the test that proves it.

### 4.1 The ingestion engine

The ingestion engine (owner) is the only door between the booking flow and the suppliers: the module `ota/backend/src/supply/` (A1). Business code calls an engine **action** and reacts to a fixed set of **outcomes**; it never sees a supplier's name, payload or error code. A search fans out to every enabled supply source (owner). Any other action goes to the source stored on the offer or booking row (A3); a row without a known source is refused (`unknown-source-refused`).

| Action | Outcomes | Hooks |
|---|---|---|
| Search | per source: `ok`, `empty`, `failed`, `timed_out`, `skipped` | pre, post, post-merge |
| Price, extras | `priced`, `sold_out`, `refused`, `unavailable` | pre, post |
| Create order | `created`, `rejected`, `not_sent`, `unknown` | pre may refuse |
| Find order, after a lost answer | `found`, `absent`, `incomplete` | none |
| Check payable (new) | `payable`, `refused`, `higher_amount`, `balance_short`, `unknown` | observe only |
| Request ticketing | `issued`, `accepted`, `rejected`, `balance_refused`, `unknown` | observe only |
| Read order (sync, polling) | `order`, `not_found`, `unavailable` | observe only |
| Cancel or release | `cancelled`, `order_not_found`, `refused`, `version_conflict`, `not_sent`, `unknown` | observe only |
| Service request (void, refund, change) | `quoted`, `submitted`, `completed`, `refused` | observe only |

- Each adapter classifies its own failures. The Amadeus adapter keeps today's `createFailureKind` unchanged (E3-05). Every other adapter answers `not_sent` only with proof that the request never left the process, and `unknown` otherwise: the booking stays pending and nothing is voided. After `unknown`, a booking fails only when Find order answers `absent`; where an adapter cannot search, staff decide (4.10).
- Each source has its own deadline. A late or failing source never fails the search, unless no called source answers.
- One currency per search and no conversion: a source that cannot quote it is skipped.
- The merged list keeps today's limit of offers, with a share per source. Duplicates across sources are removed (proposal 3).

### 4.2 The supplier interface and the adapters

An **adapter** (owner) implements the common interface for one supplier. It builds requests, reads answers into neutral objects, classifies failures and redacts what is stored. It declares its **capabilities** in code. The flow skips a step whose capability is missing and never tests a supplier's name.

| Capability | Values | When missing |
|---|---|---|
| Search limits | journeys, travellers, currencies | the source is skipped for that query |
| Extras | bags, seats, after booking | the step is skipped for that booking (owner) |
| Find order | by queue and remark, by our reference, none | a lost answer goes to staff (4.10) |
| Ticketing | now or later; paid by the agency or from a supplier balance; ticket numbers may be absent | required |
| Cancel, void, refund, change | by API, by request, none | today's "request only" path |

- Amadeus's own tools (offices, queues, PNR import, raw operations, the card paid to the airline) stay outside the interface.
- Proof: a lint rule keeps business code away from adapters; one conformance suite runs against every adapter; recorded Amadeus request bodies (the golden baseline) stay byte-equal, and no existing test changes.
- A third supplier on paper: Duffel's public documentation fits the interface with two additions (an expiry per offer, "pay at creation"). Nothing was tested.

### 4.3 Hooks and rules

The three **hooks** (owner) are extension points in code. Staff manage **rules**: data bound to a hook, with conditions and one effect (A2).

| Hook | Runs | May | May never |
|---|---|---|---|
| pre-action | before any adapter call | remove a source, refuse the action | add a switched-off source; change travellers, dates or amounts |
| post-action | once per supplier result | on Search and Price: drop offers, adjust the price | change flights, or anything on a money action |
| post-merge | once, on the merged list | remove duplicates, apply shares and the limit | change a price |

- Built-in handlers run in a fixed order: supplier selection, carrier rules, price rules, removal of duplicates, limits.
- A rule has conditions (supply ids, route, carriers, cabins, travel dates), one effect (exclude a source, block a carrier, adjust the price, prefer a source, set a share or a deadline), a priority, an active window and a version.
- A rule is data only: conditions and one effect from the fixed lists above. No code, script, expression, template or URL from a tenant or from staff is stored or run (A2; `rules-are-data-only`).
- Velexis staff manage rules for Velexis sources in the platform admin; an OTA manages rules for its own sources in the OTA admin (A14). No rule crosses ownership (`rule-ownership`).
- A Velexis price rule turns the supplier's net price into the OTA's cost price (A15). The net price is never returned (`supply-net-leak`).
- On money actions the hooks are read-only (`money-hooks-cannot-mutate`). A failing hook fails closed only where a hook may refuse: Search, Price and Create order (`hook-failure-fails-closed`). On Find order, Read order, Check payable, Request ticketing, Cancel or release and Service request no rule applies; a failing hook is logged and alerted, and the action goes on (A19; `hook-failure-never-blocks-servicing`).

### 4.4 Supply sources, ids and switches

A **supply source** is one supplier used through one account: a Velexis account or the OTA's own (A4). New platform tables hold the suppliers, their global state, the supply sources and every id of a source. Today the platform allows one provider, `amadeus` (`platform/backend/migrations/platform/0001_baseline.sql:269`).

**Id** (owner: an id with a history table; the format is A4). `sup_` plus 16 random characters. No id is reused. Only a platform admin rotates an id. An old id on an old booking still resolves. This is an exception to the rule that ids are prefixed ULIDs (`docs/mvp/conventions.md` §1): a ULID shows when a source was created. ADR-0030 records the exception.

**Switches** (owner: globally and per tenant; the levels are A12). A source sells only when every level allows it.

| Level | Set by | Covers |
|---|---|---|
| Global | platform admin | every source of the supplier in that environment, own accounts included (A22) |
| Per tenant | platform admin | one source of one OTA |
| The OTA's choice | OTA owner or admin | Velexis as a whole, or one own account |
| Stop | wallet watch or staff | one Velexis source, for every OTA |

- "Off" leaves the source out of new searches and refuses its offers at pricing and checkout. Existing bookings keep being ticketed, polled, synced and serviced (`supply-switch.int.test.ts`).
- Today's status `disabled` serves nothing, existing orders included (`ota/backend/src/amadeus/connection-resolver.ts:16-18`). It stays as the emergency stop. For a source that tickets later it also stops the Ticketing request and the polling of bookings that are already captured. The dialog warns of this, and the watchdog lists each such booking as an open case (4.10, rule 7). This is the one exception to rule 6 of 4.10.
- A test environment never reaches a production supplier host (`supply-host-guard.test.ts`).

### 4.5 The Suppliers page and supplier accounts

The portal's Amadeus section becomes "Suppliers": one page with three sections (owner).

| Section | Shows | Does |
|---|---|---|
| Velexis | one state per environment and the supply ids; never a supplier name, office id or host | select or unselect; request live access |
| Amadeus | the OTA's own connection, offices and settings | submit credentials; select or unselect |
| PKFare | the OTA's own connection | submit partner id and key; select or unselect |

2026-11-25: in the lead's re-scope (section 0), milestone M7 builds the section "Velexis" without select or unselect (PFE-032), and moves what exists today for an OTA's own Amadeus account into the section "Amadeus", shown only while `FEATURE_OWN_AMADEUS` is on (PFE-033). That switch stays off at launch, because the functionality for adding an OTA's own Amadeus account comes after the launch (ADR-0030 item 21; PADR-0015). Select and unselect (PBE-104) and the section "PKFare" (PFE-034) are milestone M8; for an OTA's own PKFare account this is question (44d), open.

- Own Amadeus beside Velexis needs two connection rows. Today own credentials replace the Velexis connection (PADR-0012 item 4). Side by side ships in P4 (SP-20), once P3 routes Amadeus by supply source; it is in the first release. 2026-11-25: no longer in the first release: by the owner's decision of that day, the functionality for adding an OTA's own Amadeus account comes after the launch, in a different release (ADR-0030 item 21), so SP-20 (PBE-103) is milestone M8 (section 0).
- PKFare credentials are checked by one read-only balance request. The host never comes from the form.
- Onboarding and go-live ask for "at least one source that sells in that environment" (A11).

### 4.6 Velexis's own supplier accounts and the wallet

A new table holds Velexis's account for every supplier except Amadeus (A24). PKFare signs each request with a fixed MD5 of partner id and key, so the signature is worth as much as the key. It is never logged, stored or returned (`pkfare-signature-redaction.test.ts`).

The **wallet** is PKFare's prepaid balance. OTAs pay through Velexis's wallet and do not see it (owner). A platform job reads it every five minutes (A26).

| Event | Effect |
|---|---|
| Balance under the warning level | alert to staff, once a day |
| Balance under the floor | stop for every OTA; a read above the floor lifts it |
| Ticketing answers "balance not enough" | stop; only staff lift it |

- A live wallet account never becomes active without a floor.
- Daily limit per OTA (A6: off by default): the engine refuses the checkout that would pass the limit, before the payment capture. 2026-11-25: the owner decided "Keep limit to 0. It should be configurable from Platform Admin's OTA management." (ADR-0030 item 23); what 0 means is question (44a), open.
- Only staff see the balance. One main wallet serves every OTA in the first release (unknown: whether a sub-buyer has its own credentials).

### 4.7 What an OTA sees

For a Velexis source, no OTA-facing answer, screen, e-mail or document shows the supplier (owner; A5 lists what is hidden). This includes Amadeus when Velexis supplies it. An OTA's own source is shown as today.

| Surface | Names the supplier today | The plan |
|---|---|---|
| OTA API, customer scope | `amadeus` members; Amadeus values in `source`; texts such as "Amadeus is unavailable." | members omitted or null; neutral `source` and texts |
| OTA API, console scope | the verbatim offer and order with net prices (`ota/backend/src/shopping/offers.mapper.ts:1268-1274`); supplier errors; office ids; the supplier log | none of these; `netPrice` is the OTA's cost price (A15) |
| OTA admin | 472 lines in 39 files: PNR lookup, Queues, Shopping, Supplier log | tools hidden; neutral labels |
| Storefront, e-mails, PDFs | the main record locator is Amadeus's | the airline's reference, or none |
| The supplier's own e-mails (new with PKFare) | — | every contact given to the supplier is Velexis's (A35); its e-mails reach Velexis, and staff pass them on in neutral words (no task yet: 9.6) |

- **Amadeus-only tools** (owner). Without an own active Amadeus connection, 15 operations answer `403 FEATURE_DISABLED`: the 12 `console.amadeus.*` operations, two queue operations and PNR import. The OTA admin hides their menu items. 2026-11-25: the owner decided "Hide Amadeus tools right now" (ADR-0030 item 21). The lead reads this as phase B of section 0, built on today's connection model; the list of 15 operations and the answer `403 FEATURE_DISABLED` stay the proposal of ADR-0030 item 18.
- **`supplyId`** (owner: "some form of ID") is on offers, priced offers and bookings. Console scope adds a label: "Velexis", or the own supplier's name.

### 4.8 Public contract and SDK

- **What stays** (A5): `console.amadeus` and the Amadeus-named members. SDK 1.0.0 gets documentation notes only (proposal). 2026-11-25: the notes are decided: the owner answered "go" to question (43f) (ADR-0030 item 24). As the lead reads it, the notes run first (SDK-020) and get one more: the Amadeus console operations can answer `403 FEATURE_DISABLED` for an OTA without its own Amadeus connection.
- **`FlightOffer.source`** (A10) becomes the content type. This plan recommends two new values, `LCC` and `OTHER` (A28); a value per supplier would name the supplier. A value can never be removed, so ADR-0030 fixes the names first.
- **Extras.** Today's schema requires an `amadeus` member. New lists `extras` without one serve every supplier. A 1.0.0 client sees no extras on a non-Amadeus offer and skips the step.
- **No ticket number.** A ticket row requires a document number, so a booking without one has no ticket rows. New: a field `ticketless` and an e-mail key.
- **Texts.** E-mail templates are stored per OTA and never backfilled, so the plan adds keys and rewords no default.

| Contract change | Kind | Ships |
|---|---|---|
| Notes: enumerations may gain values; `amadeus` members are optional | documentation | SDK 1.0.0, or 1.1.0 if it would delay the publish |
| `supplyId`, a supply label, the tools list, payment methods, the locator's kind | additive | P5 |
| New meaning of `source`, `netPrice` and `recordLocator` | decision record (ADR-0030) | P5, P7 |
| `extras`, `ticketless`, two e-mail keys | additive | P7 |

Leak tests walk every customer and console operation for a Velexis source. An end-to-end crawl finds no supplier word in the OTA admin, e-mails and PDFs.

### 4.9 One booking flow

The flow is the same for every supplier (owner). The orchestrator stays one class and knows engine outcomes only. One step is new: Check payable.

| Step | Amadeus adapter | PKFare adapter |
|---|---|---|
| 1. Authorise the card (Stripe) | card hold for the total | the same; Stripe only (A6) |
| 2. Price again | only when the priced offer is old | always |
| 3. Create order | Flight Create Orders | PreciseBooking |
| 4. Check payable | answers from the created order | OrderPricing, then the wallet balance |
| 5. Record | confirmation e-mail | e-mail held back |
| 6. Capture | today's step | the same, with a deadline |
| 7. Request ticketing | Flight Order Issue: `issued` | Ticketing, once: `accepted` |
| 8. Record tickets | from the issue answer | from polling |

Capture comes before the ticketing request (proposal). Otherwise a failed capture leaves Velexis paying for the ticket.

- Create order `unknown`: the booking stays pending; Find order or staff decide (4.10).
- Check payable refused, or the capture deadline passed: the order is released and the card hold is voided.
- Ticketing `rejected`, `balance_refused` or `unknown` from a source that is paid from a supplier balance (A34): an **open case** (captured money without a ticket), a staff alert, no re-send. The Amadeus adapter keeps today's retries and its give-up alert.
- Each background job query names the supplier it serves. The Amadeus retry and reconciliation jobs select Amadeus rows only; a database CHECK and fence tests hold this.
- The OTA's ticketing policy applies by capability (BM3-03). For an OTA on `manual_review`, a source paid from a supplier balance is left out of the search and refused at completion, so that OTA gets no PKFare content; `issue_at_booking` runs as `issue_after_payment` for such a source. To confirm.

### 4.10 PKFare: search, pricing, booking and ticketing

PKFare takes at most 2 journeys and 9 seated travellers; any other search skips it, as does a search in a currency that the account does not quote. A priced offer without readable fare rules is not sold.

Three terms: a **write-ahead** is a marker committed before a request leaves; the **hold** is the life of an unpaid order (its length is unknown); the **expected debit** is the order amount plus PKFare's fee.

| Money rule | Test |
|---|---|
| 1. A fresh PrecisePricing before every order; a price reference is never used twice. | `pkfare-price-reference-once` |
| 2. A write-ahead before PreciseBooking; never a second order request. A lost answer opens a case (below). | `pkfare-one-order-per-checkout` |
| 3. No capture unless OrderPricing just succeeded, the hold is open, the amount is within the expected debit and the wallet covers it. | `pkfare-capture-needs-payable-order` |
| 4. The capture deadline is the earlier of the hold end and OrderPricing plus 30 minutes, less a margin. Then: read the payment under the booking lock, CancelOrder, booking cancelled, void. | `pkfare-capture-deadline` |
| 5. Ticketing follows a full capture, an OrderDetail read that shows the order payable and, when the last OrderPricing is older than 20 minutes (A32), a second OrderPricing (unknown: whether PKFare allows a repeat; if not, the capture deadline of rule 4 becomes OrderPricing plus 20 minutes). A second OrderPricing that fails or shows a higher amount is an open case; nothing more is captured. A write-ahead; never a second Ticketing request. The reported debit is checked against the expected one. | `pkfare-one-ticketing-request` |
| 6. Polling never stops before a final status (one exception: the emergency stop of 4.4). Never `ticketed` without ticket numbers (exception: 4.11). After a Ticketing write-ahead the card payment is never voided and CancelOrder is never sent. | `pkfare-poll-until-final` |
| 7. A watchdog finds captured money without a ticket after N minutes: a daily alert and a row in the open-cases list. | `paid-unticketed-watchdog` |
| 8. After one balance refusal, or K open cases, completions are refused before the capture. Only staff lift the stop. | `balance-refusal-stops-sales` |

Rules 7 and 8 are the lead's safety set (proposal). The owner sets N, K and H (A32).

A lost order answer opens a case of the kind "order unknown" for the reconciliation role, without a supplier order number. The role looks the order up in PKFare's portal and records its number or "no order". The engine then releases a found order; the booking fails and the card hold is voided. Deadline: H hours after the case opens (proposal). Until PKFare confirms A33 in writing, nothing fails the booking without this step. On an OTA's own account, OTA staff decide at close-review (BM7-14).

- The traveller is told the truth: "We are finalising your booking" until ticketing is accepted; never "not charged" after a capture; for an open case, tickets or a full refund within H hours. H counts from the capture (proposal). The role records the outcome before its own, shorter deadline (A39); OTA staff then refund.
- PKFare's notifications are not authenticated: one only triggers a read. Polling is the source of truth.
- Proof: a failure matrix stops the process between every two steps and replays the same idempotency key. No second write reaches PKFare. Its fourteen assertions follow the P7 tasks in Annex B.

### 4.11 Extras and low-cost content

| Extras (owner: in the interface, skipped when there are none) | What happens |
|---|---|
| The supplier or the offer has none | the step and its page are skipped |
| Amadeus | today's path, behind the same operation |
| PKFare, with the order | bags and seats go into the order request; Check payable covers the whole amount |
| PKFare, paid bags after ticketing | not in the first release (A30): a second payment and a second supplier order |

**Low-cost content** (owner: first release) is the content of low-cost airlines, which PKFare may book without an e-ticket number.

- The priced offer is flagged low-cost before payment. Only a flagged booking becomes `ticketed` without an e-ticket number, on PKFare's final issued status plus the airline's reference (`ticketless-only-when-flagged`).
- "No change, no refund" is shown before payment and stored with the booking.
- Every carrier is on; staff can block one (A9).
- Unknown: which field marks low-cost content, and whether such orders get ticket numbers.

### 4.12 After-sales for Velexis-supplied bookings

OTA staff talk to the traveller and move the traveller's money. The reconciliation role talks to the supplier. A **case** is one supplier-side question on one booking, with a deadline (A39).

| Case | OTA staff | Reconciliation role |
|---|---|---|
| Ticket rejected after payment | refund in full after the outcome | gets the ticket issued, or confirms the reimbursement |
| Traveller cancels a ticketed booking | confirm the quote; refund after the outcome | records the quote, submits, records what is returned |
| Supplier changes the schedule | record the traveller's choice | answers the supplier in time |
| Non-refundable low-cost booking | a goodwill refund is its own money | records what comes back |
| Order unknown: a lost order answer (4.10) | none; the booking stays pending | looks the order up in the supplier's portal; records its number or "no order" |

- From the Ticketing write-ahead until a final status nobody can cancel the booking; the traveller and OTA staff see that it is being finalised. "Unticketed" in A8 means that no Ticketing request was sent.
- For a ticketed booking the adapter's capability decides: "by API" keeps today's automatic path, "by request" opens a case. This differs from A8 as written (9.1).
- The outcome returns through the support interface (4.13). The OTA's existing refund operation then pays the traveller.
- Never a supplier refund request before the OTA confirmed the quote: PKFare cancels the PNR on a successful RefundRequest.
- Never a console refund while a case is open. The role's interface has no capture, refund or void (`support-no-payment-operations`).

### 4.13 The reconciliation role, the ledger and offline reconciliation

**Role** (owner; its limits are A7). PADR-0006 item 8 says "Supporting an OTA's bookings means being invited as a member like anyone else"; that sentence is revised. A platform admin grants the role. The role works the ledger and the cases, exports, and opens one booking at a time with a reason. Each action is audited. It never changes switches, credentials or settlements.

Three channels keep both ownership rules: the platform never touches tenant schemas, and the OTA backend never writes platform tables.

| Channel | Carries | Rules |
|---|---|---|
| The existing queue to the platform | ids, status, amounts, dates | never for a booking on an OTA's own account; never a name, contact or document (`supply-fact-schema.test.ts`) |
| Platform tables for the ledger and the cases | the record | written by the platform only |
| Support interface of the OTA backend | booking details, case actions | called by the platform admin's server (A36); every call is audited and visible to the OTA; never a document number, contact or card detail (`support-view-redaction`) |

- The **ledger** has one row per supplier order: supply id, order number, the OTA's cost price, expected and reported debit, reimbursements. It holds no traveller data.
- **Offline reconciliation** (owner). The system builds no settlement line. It offers an audited export per period and OTA, and a daily job compares the wallet readings with the ledger.
- Alerts to OTA staff use neutral words; the role gets the supplier detail. A debit difference raises an alert at once, and in the first live weeks staff stop the source until it is explained.

### 4.14 Privacy and disclosure on request

The search carries an id, and an OTA can ask for the supplier (owner). An OTA owner or admin asks on the Suppliers page. A platform admin answers from the id history with the supplier's legal name, country and privacy contact at that date. The answer is stored and audited.

By this plan's reading of the law, which counsel must confirm, a traveller who asks for the actual recipients may be entitled to them, so the procedure always ends with a name. Velexis needs an agreement with each supplier that covers traveller data, a dated list of recipients, and OTA terms that describe the procedure.

One question goes to the owner's counsel; it is a step, not advice. Is Velexis a processor for each OTA, or a controller of its own? If a processor, "on request" may not be enough. No supplier is hidden in live use before the answer. This gates the live step of P5 (Velexis-supplied Amadeus) and the gate of P10 (PKFare).

### 4.15 Tests, operations and security

| Proof | Holds or proves |
|---|---|
| PKFare fake `tools/pkfare-stub` | an order store, a clock that the test controls, failure injection |
| Fixtures | recorded in PKFare's sandbox by a person, never in CI; a behaviour without a fixture or a reference page is "assumed" and blocks going live |
| `supply-secrets-by-value.int.test.ts` | a known key, signature and passport number are searched in every store, queue, e-mail and log |
| `supply-isolation.int.test.ts` | credentials, cache, stops and rules of one tenant or environment never serve another |

- Hosts: one official host per supplier and environment. PKFare's production host enters code and the VM's outbound allow-list only in the pull request of the live step.
- PKFare's signature is built at send time and never stored or logged. A PKFare body is stored as an allow-list copy.
- No card data goes to a supplier other than through the existing airline-card path.
- Every money pull request gets the second-agent review first. Each new alert has a runbook and a drill.

## 5. Decisions and records

`docs/mvp/decisions.md` fixes the order: that file, then the decision records, then the plans. On 2026-11-25 the owner's decisions of 2026-11-24 were recorded in that order: in `decisions.md`, and in ADR-0030, OADR-0019, OADR-0020, PADR-0020 and PADR-0021. The proposals (section 3 and the lead's four proposals) and the open questions (section 9) are not decided: the records mark them **Proposed** or list them as open questions for the owner. No task block exists yet. 2026-11-25: the task blocks exist now, and the owner decided the fourth of the lead's proposals, the SDK notes (section 0). [Annex A](#annex-a-proposed-wording-for-the-decisionsmd-rows) proposed the wording; `decisions.md` took only the sentences that rest on an owner's decision. Dated notes were written in eight records: ADR-0010, ADR-0011, ADR-0012, OADR-0001, PADR-0006, PADR-0010, PADR-0012 and PADR-0015. Each rests on an owner's decision that changes a sentence of the record or, for ADR-0011, the `decisions.md` row that the record details. The other notes of the table below wait for a decision, and each new record lists those of its subject.

| Record | Scope | Revises, by a dated note |
|---|---|---|
| `decisions.md` | the Annex A sentences that rest on an owner's decision, changed in place on 2026-11-25 (the file carries no dated notes) | the rows at its former lines 7, 14, 15, 18, 32, 34 and 68, and six new rows after the row "Whose supplier account" |
| ADR-0030 (new) | the thirteen decisions in the owner's words; proposed: supply sources, hiding rules, `sup_` ids, the engine's place, the meaning of `FlightOffer.source`; the open questions for the owner | ADR-0010, ADR-0012, ADR-0006, ADR-0011, ADR-0015, ADR-0004; `docs/mvp/conventions.md` §1 (the id format) |
| OADR-0019 (new) | the engine: interface, capabilities, routing, hooks, rules as data | OADR-0001, OADR-0002, OADR-0003, OADR-0005 |
| OADR-0020 (new) | suppliers paid from a balance: capture first, one ticketing request, open cases, stops; extras and low-cost content | OADR-0003, OADR-0008, OADR-0010, OADR-0013 |
| PADR-0020 (new) | the registry: switches, supply sources, id history, Velexis accounts, wallet watch, Suppliers page, the rename in the platform API | PADR-0015 item 6, PADR-0010, PADR-0012 item 4, PADR-0018 |
| PADR-0021 (new) | the reconciliation role: ledger, cases, the audited support interface; offline recovery; disclosure on request | PADR-0006 item 8, ADR-0003, ADR-0009 item 3, OADR-0009, OADR-0011 |
| ADR-0025 (not revised yet: the note waits for the owner's answer to question 1 of ADR-0030; 2026-11-25: revised by a dated note under item 3, after the owner's answer, ADR-0030 item 19) | item 3: how M7 runs beside M6 | — |

Nine of the records named for dated notes were not opened when this plan was written; a waiting note is checked against its record when it is written. The lead's four proposals stay proposals. OADR-0019 and OADR-0020 hold three of them as items marked **Proposed**; ADR-0030 names the fourth, the SDK notes. Merging the records does not decide them: only the owner's confirmation does. 2026-11-25: the owner confirmed the fourth, the SDK notes, with "go" (ADR-0030 item 24).

**Milestone M7.** ADR-0025 item 3 starts a milestone's tasks "after the previous milestone's go/no-go"; for M6 that is the launch. A dated revision must say how M7 runs beside M6 (A13). plan-lint accepts `M7` (`tools/plan-lint/plan-lint.mjs:115`). Its `--remaining` mode (`tools/plan-lint/plan-lint.mjs:230-236`) and `AGENTS.md` ("Take the lowest milestone that still has open tasks") offer only the lowest open milestone, and six M6 tasks may stay open after the launch (the launch exceptions of ADR-0025 item 4). Beside M6, the lead hands out M7 tasks by id and the revision of ADR-0025 item 3 says so, or G0-03 changes the rule and the tool. The contract generator knows M0 to M6 only (`packages/api-types/scripts/generate.mjs:123`), so a new operation carries `x-milestone: M6` (A40). 2026-11-25: the dated note under ADR-0025 item 3 records the owner's answer: M7 is built before the launch (ADR-0030 item 19). The lead's re-scope adds X-053, so that `--remaining` also lists the open tasks of M7, and X-054, so that `x-milestone` takes `M7` and `M8` (section 0).

**Task ids.** The counts per prefix are estimates by main component; only the total of 179 is exact, and P0 assigns the real ids. About ten tasks join a backend change with a screen; if P0 splits them, the counts rise. Tenant migrations start at 0007 (0006 is reserved by OBE-105), platform migrations at 0005. 2026-11-25: the real ids are assigned; section 0 gives their ranges, and Annex C maps each key to its id.

| Prefix | Estimated range | Tasks |
|---|---|---|
| `X` | X-051 … X-078 | 28 |
| `OBE` | OBE-106 … OBE-213 | 108 |
| `PBE` | PBE-078 … PBE-103 | 26 |
| `PFE` | PFE-032 … PFE-033 | 2 |
| `PAD` | PAD-018 … PAD-024 | 7 |
| `OFE` | OFE-033 | 1 |
| `OAD` | OAD-024 … OAD-029 | 6 |
| `SDK` | SDK-020 | 1 |

## 6. Phases

Sizes: S is 2 agent-hours, M is 4, L is 8. "Dark" means that no traveller and no OTA can reach the code in production. The tasks are in [Annex B](#annex-b-the-full-task-list). 2026-11-25: the work now follows the phases A to L of section 0, the lead's re-scope, and the task blocks in the three task files; this section is kept as the proposal it was.

| Phase | Goal | Live for Amadeus, or dark | Depends on | Tasks | Agent-hours |
|---|---|---|---|---|---|
| P0 | Decisions, records, task blocks, re-baseline | no code | the owner's confirmation of section 3 | 15 | 70 |
| P1 | PKFare facts, fixtures, the fake | dark: developer machine and CI | P0 without G0-09; sandbox credentials | 6 | 20 |
| P2 | Engine and interface; Amadeus search and pricing as the first adapter | live, same behaviour | P0 without G0-09 | 16 | 68 |
| P3 | Amadeus adapter for booking, ticketing, sync, cancellation, console actions | live, same behaviour | P2; the Amadeus proof of section 8 | 22 | 106 |
| P4 | Platform: registry, ids, switches, Suppliers page, Velexis accounts, wallet watch | live for Amadeus; PKFare parts dark | P0; parts of P1, P2 and P3 | 21 | 102 |
| P5 | The supplier hidden on every OTA surface | live, after counsel's answer (4.14) | P3, P4 | 17 | 70 |
| P6 | PKFare search and pricing, merged results | dark: local stack and tests | P1, P2, four tasks of P4, OS-08 | 9 | 44 |
| P7 | PKFare booking, ticketing, extras, low-cost | dark: PKFare off outside tests | P3 to P6 | 25 | 134 |
| P8 | Rules at the hooks and their two screens | live once a rule exists | P2, P4, P5 | 12 | 58 |
| P9 | Reconciliation role, ledger, cases, export | live for Velexis-supplied Amadeus bookings | P3, P4, P5, P7 | 23 | 124 |
| P10 | Proof, certification, pilot, live gate | PKFare live for one OTA, after the gate | P7, P8, P9; section 8 | 13 | 40 |
| **Total** | | | | **179** | **836** |

The deliverables, exits, going-live steps and preconditions below are proposals. Open cases, stops and limits in P7 are the lead's safety set (proposal 2, A6).

**P0.** Delivers the changed `decisions.md`, five records, the ADR-0025 revision, task blocks with real ids and the roadmap re-baseline. G0-09 waits for the P1 facts (A41); only P6 and P7 wait for it. Exit: the owner has merged `decisions.md` and approved the records; plan-lint reports `ERRORS: 0`; the SDK publish is not delayed. 2026-11-25: the records rounds of that day do the work of G0-01 to G0-11 and RC-01; OS-01, OS-02 and RC-02 are task blocks of phase A (section 0). G0-09 did not wait for the P1 facts (A41).

**P1.** Delivers a facts file (each PKFare statement marked stated, observed or assumed), fixtures and the fake. Exit: a test fails on an unscrubbed fixture value; A6, A8 and A9 are checked against observed facts; every "assumed" fact is a question to PKFare.

**P2.** Delivers the interface, the engine core with its hooks, and Amadeus search and pricing through the engine. Exit: the golden comparison is byte-equal; no existing test changed; the search load test is repeated.

**P3.** Delivers Amadeus booking through the engine, Check payable and the fence for background jobs. Exit: the golden comparison is equal; the 9 booking integration files are unchanged and green; no file outside the adapter imports the Amadeus client.

**P4.** Delivers the registry, ids, switches, Velexis accounts, the wallet watch and the Suppliers page. Exit: the switch and host-guard tests pass; an end-to-end run switches a source off and on at each level; for a Velexis-only OTA the Velexis section, the portal answers about Velexis supply and the rendered platform e-mails show no supplier name, office id or host; the own-account sections "Amadeus" and "PKFare" stay on the page (owner). 2026-11-25: in the lead's re-scope (section 0) the section "Amadeus" is shown only while `FEATURE_OWN_AMADEUS` is on, and that switch stays off at launch, because the functionality for adding an OTA's own Amadeus account comes after the launch (ADR-0030 item 21; PADR-0015). The section "PKFare" is milestone M8 in the lead's re-scope (question (44d)). X-062 checks the section "Amadeus" with the switch on in the test stack.

**P5.** Delivers `supplyId`, the own-account guard and neutral answers, screens, e-mails and documents. Exit: both leak walks and `amadeus-tools-own-account` pass; an end-to-end crawl finds no supplier word in the OTA admin, e-mails and PDFs of a Velexis-only OTA. The live step, hiding the supplier in production, waits until counsel's answer is recorded (4.14).

**P6.** Delivers the first visible result: PKFare offers in the merged list, on the local stack. Exit: the conformance suite passes for the PKFare adapter; a PKFare failure never fails the search; a source that is off gets zero calls.

**P7.** Delivers PKFare orders, ticketing, open cases, limits, extras and low-cost. Exit: the failure matrix passes with its fourteen assertions (Annex B, after the P7 tasks); the tests of the eight money rules pass; end-to-end runs on the fake cover full-service, low-cost, extras and an open case.

**P8.** Delivers rule tables on both sides, the handlers and the two screens. Exit: `rule-ownership` and `supply-net-leak` pass; the three hook tests of E2-07 pass with stored rules; the cost of rules is measured in the search load test.

**P9.** Delivers the role, the ledger, the support interface, cases, export and disclosure. Exit: the case and redaction tests pass; an admin without the role is refused; an end-to-end run takes the cases of 4.12 through both admins and finds no supplier word on the OTA side.

**P10.** Delivers the by-value secrets test, the isolation test, the final load run, two security reviews and the go-live runbook. Going live has four steps: sandbox certification; a pilot with one OTA in the test environment; the live co-test that PKFare requires; live for one OTA. Exit: eight preconditions, the first seven before the co-test. 2026-11-25: the pilot runs before the launch (ADR-0030 item 19, as section 0.2 reads it; roadmap M7, Human steps and Demo). The lead recommends, in question (44b), open, that the launch does not wait for PKFare's certification; then the pilot does not wait for it either. The certification is part of precondition 2, which is signed before the pull request of the live step, X-073, opens; the co-test follows X-073's merge and precondition 7, and live for one OTA follows the co-test. If the owner decides that the launch waits for the certification, the order above holds.

1. M6 is a go; the owner has confirmed every assumption. 2026-11-25: the launch go/no-go, which is M6's, now waits for M7 too (ADR-0030 item 19). This precondition can then be met only if the live step comes after the launch, as a named exception; that is the lead's reading and question (44b), open.
2. No fact of the money path is still "assumed"; PKFare's certification is on file.
3. Every proof of 4.15 passes on `main`.
4. Both security reviews are closed; counsel's answer is recorded.
5. The alert drill is done; reconciliation staff are named.
6. The wallet has a floor; the OTA has a daily limit and written terms for the cost recovery.
7. The production host line is installed.
8. The co-test ticket matches: expected debit, reported debit, statement.

## 7. Effort and calendar

The plan has 24 S, 113 M and 42 L tasks: 48 + 452 + 336 = 836 agent-hours. Review time uses the figures of [`roadmap.md`](roadmap.md) §1.1: 0.469 review hours per agent-hour, 30 review hours a week, a 20 % buffer.

The factor 0.469 is derived from the roadmap, not printed there: 0.75 developer-hours for an S task of 2 agent-hours, plus 25 % (0.9375 / 2). It was never checked against real review time: the roadmap records no actual milestone exit yet (`roadmap.md:758-768`). The likely case adds 15 %, the growth of the MVP plan since its baseline (1,406 to 1,618 agent-hours, [`README.md`](README.md) §5). The high case adds 50 %, an allowance of this plan, not a measurement. The spread covers agent-hours only, not the review factor.

| Case | Agent-hours | Review hours | Weeks at 30 h | With 20 % buffer | Full review weeks |
|---|---|---|---|---|---|
| Low: the plan sum | 836 | 392 | 13.1 | 15.7 | 16 |
| Likely: low + 15 % | 961 | 451 | 15.0 | 18.04 | 19 |
| High: low + 50 % | 1,254 | 588 | 19.6 | 23.5 | 24 |

**The launch needs the same hours.** One person reviews, and M7 adds no reviewer. M7 after the launch does not move the launch. Each M7 review week before the launch moves it by one week. A fixed weekly share is the third way. The revision of ADR-0025 item 3 must name the choice. 2026-11-25: the owner chose before the launch: "Prior to launch. The multi supplier engine has to be ready before launch." (ADR-0030 item 19; the dated note of 2026-11-25 under ADR-0025 item 3). So the launch now waits for M7: by this section's rule, M7 as re-scoped needs 15 full review weeks, likely 17, high 22 (section 0).

Fixed dates (`roadmap.md:710`): the first merge into `main` at about 4 December 2026; SDK 1.0.0 published by about 18 December, hard limit 31 December. The roadmap's example launch date is 11 June 2027. Proposed order (a proposal of this plan, not a roadmap date): outside steps and P0 drafts now; the review of P0 after the SDK publish and the year-end break (21 December 2026 to 2 January 2027, `roadmap.md` §1.2); code in January 2027 at the earliest, and only if the revision of ADR-0025 item 3 lets M7 run before the launch. 2026-11-25: the revision lets M7 run before the launch (ADR-0030 item 19), and the records rounds of that day did most of P0. The lead reads the answer as: M7's tasks start now, while the open tasks of M0 to M6 wait on the owner's steps, a nightly run or the launch, and the SDK 1.0.0 notes (SDK-020) run first. The answers change none of the fixed dates above. The roadmap's re-baseline under ADR-0025 item 6 gives the example dates that follow.

**Not in the figures:**

- the owner's time for the outside steps of section 8;
- fixes that the security reviews, PKFare's certification or the pilot ask for;
- six "Later" tasks of Annex B (36 agent-hours): PKFare void and refund requests, and paid bags after ticketing;
- work in no phase: currency conversion, a neutral multi-city request, a supplier log for own PKFare accounts, reading PKFare's schedule-change list, a settlement line, removing Amadeus-named members.

The figures include five tasks (28 agent-hours) that no section listed and the editor added: supply ids on old rows (ED4-01) and the management side of the rules (ED8-01 to ED8-04). Without them the low figure is 808.

**First visible result.** PKFare offers appear in the merged list after P0, P1, P2, four tasks of P4 (SP-01, SP-02, SP-03, SP-07), P6 and OS-08: 51 tasks, 234 agent-hours, 110 review hours, 5 full review weeks. Nothing is sellable then: a PKFare booking needs P3, P4 and P7.

**What could be cut or moved later:**

| What | Tasks | Agent-hours | Effect |
|---|---|---|---|
| Rules for OTAs and their screen | E8-02, ED8-03, ED8-04 | 12 | the owner asked for them and decides |
| Rules for shares, deadlines, preferred source | E8-07 | 4 | they stay configuration; no stored rule then runs at post-merge, a hook the owner asked to manage (row 13); the owner decides |
| Notification endpoint | BM7-20 | 4 | polling only; enough for the pilot |
| Statement upload and match | RC-18 | 4 | it waits for PKFare's statement format |
| Disclosure screens | RC-24, RC-25 | 6 | the procedure runs by e-mail, from the id history |
| OTAs' own PKFare accounts | SP-10 | 8 | Velexis PKFare only at first; the owner decides |
| **Sum** | | **38** | |

2026-11-25: in the lead's re-scope the rows "Rules for OTAs and their screen" and "OTAs' own PKFare accounts" are milestone M8, after the launch (section 0); for an OTA's own PKFare account this is question (44d), open.

## 8. Outside steps and owner's steps

No agent can do these steps.

| Step | Needed for | State |
|---|---|---|
| PKFare sandbox credentials and the recording runs, by a person | P1 | PKFare has agreed (owner); the runs are not done |
| PKFare's answers to the questions of section 9.2 | P1; the task blocks of P6 and P7 | not asked |
| PKFare certification file: the scenarios of PKFare's workbook, booked in the sandbox | P10 | the workbook is not among the saved pages |
| Live co-test with PKFare: a funded wallet, a real round-trip ticket, the financial statement confirmed | P10 | after the launch (A43); 2026-11-25: part of question (44b), open |
| Counsel on Velexis's role (processor or controller), the notice text and the OTA terms | P5 going live; P10 | the pack is a P0 task |
| Amadeus Enterprise test credentials for a proof on the real test environment; or the owner accepts a proof on the stub only | P3 | "not requested" (`roadmap.md:776`) |
| The offline reconciliation routine: period, invoice, written terms with each OTA, who signs the daily check | P10 | to define |
| Staffing the reconciliation role: a named holder, a stand-in, cover hours | P10 | to name |
| The owner's numbers: wallet floor, daily limits, N, K, H, case deadlines (for a rejected ticket: shorter than H) | P4, P7, P9 | proposals in A26, A32, A39 |

## 9. Risks and open questions

### 9.1 Assumptions that cannot work as written

| Assumption | Finding | What the plan does |
|---|---|---|
| A1: the folder `supply/testing` | The build ships everything under `src` except `*.test.ts` (`ota/backend/tsconfig.build.json:13-14`). Test doubles would reach the VM, against ADR-0025 item 7. | Doubles live under `ota/backend/test/supply/` and in `tools/pkfare-stub`. |
| A5: the advanced search body is an Amadeus-only tool | The hosted storefront builds every multi-city search with it (`ota/frontend/src/pages/search.js:5`). | It stays open. A source that cannot serve it is skipped. |
| A5, A11: nothing is renamed | The platform API's `amadeus_test` and `amadeus_live` name the supplier to a Velexis-only OTA. | One breaking rename, recorded in PADR-0020. The clients are the portal and the platform admin. |
| A6: the daily limit is off by default | In the Connect and own-keys payment modes the OTA collects the traveller's money. Velexis pays the ticket and holds nothing. | P10 sets a limit for the first live OTA. The owner decides the default. 2026-11-25: the owner decided "Keep limit to 0. It should be configurable from Platform Admin's OTA management." (ADR-0030 item 23); what 0 means is question (44a), open. |
| A8: every ticketed Velexis-supplied booking cancels by request | For Amadeus this removes today's automatic same-day void (`ota/backend/src/bookings/cancellation-mode.ts:16`). | The adapter's capability decides (4.12). |
| The owner's decision 12 (and A9): low-cost content in the first release | PKFare's saved reference has no field for the content type and does not say whether low-cost orders get ticket numbers. | Low-cost stays in the first release (BM6-04, BM6-07, BM7-18, OS-20), and its task blocks wait for the P1 facts. If the sandbox shows no reliable mark, the plan cannot keep decision 12; the owner then decides between a first release without low-cost content and a later release. |
| A13: M7 runs beside M6 | One person reviews. M7 adds no review hours. | The ADR-0025 revision says before, after, or which weekly share. 2026-11-25: answered: before the launch (ADR-0030 item 19). |

### 9.2 Facts that PKFare must still confirm

PKFare's saved reference states none of these. Each is a question for PKFare.

| Topic | Open fact |
|---|---|
| Orders | how long an unpaid order lives; whether OrderPricing can be repeated; whether an unpaid order is ever debited (in writing); whether a search by our own reference exists |
| Low-cost | which field marks low-cost content; whether such orders get ticket numbers; when the airline's reference arrives |
| Currency | which currencies the account quotes: the Shopping request has no currency field, and conversion is in no phase |
| Offers | whether bags and conditions compare with Amadeus's |
| Wallet and key | whether a sub-buyer has its own credentials; how often the balance may be read (the wallet watch and one read per checkout); how a key is rotated |
| Hosts and speed | the production host; response times per operation |
| After-sales | how a schedule change reaches us; whether the airline still reaches the traveller when the order holds a Velexis contact (A35); the format of the statement file |
| Going live | the scenarios of the certification workbook; who travels on the co-test ticket |

### 9.3 The limits of hiding the supplier

- The published contract keeps `console.amadeus`, 140 schemas whose name starts with `Amadeus` (170 with `Amadeus` in the name) and the member names `amadeus`, `amadeusOrderId` and `amadeusOperationId`. A reader learns that Velexis can use Amadeus. The plan hides only which supplier served an offer or a booking.
- `supplyId` reaches every browser. Anyone can count Velexis's sources and group offers by source.
- For some airlines Amadeus returns no airline locator. With Amadeus's own locator hidden, the traveller has no reference until a ticket number exists. The owner decides whether to show it.
- In P5 an OTA without its own Amadeus account loses four screens of the OTA admin: PNR lookup with PNR import, Queues, Supplier log and Shopping. Shopping is the staff's screen to search and quote flights for a caller; after P5 such staff sell through the storefront only. The owner named "(making queues etc)"; the owner confirms that Shopping goes too. 2026-11-25: the owner decided "Hide Amadeus tools right now" (ADR-0030 item 21). In the lead's re-scope the four screens go in phase B (OAD-024), before the rest of P5 (section 0). Whether Shopping goes too is still question 8 of ADR-0030.
- Velexis staff get their tools in P9, which depends on P7: P7 and P9 are 258 agent-hours, 302 with P6. If an OTA is live in that time, nobody works its queues inside the product; RC-03 only sends its staff to Velexis support, who have no tool in the product before P9. Two ways close the gap: the guard of OS-04 and OS-13 goes on in production only when RC-11 is merged, or RC-04, RC-05 and RC-09 to RC-11 move before P5 without their P7 dependencies. The owner decides. 2026-11-25: answered by the owner (ADR-0030 items 21 and 22): "Hide Amadeus tools right now" and "I want to launch with the reconciliation process ready from the platform." The lead reads this as: P9 is in M7 and part of launch readiness (phase K of section 0).

### 9.4 Credit exposure of the wallet

- Offline recovery is credit given by Velexis. Where the OTA collects the traveller's money itself, its debt for tickets is unbounded until the owner invoices (A6 in 9.1). The owner should name the Stripe modes allowed in the first live weeks.
- One wallet serves every OTA. A low balance stops sales for all of them.
- The Velexis PKFare key is decrypted in the OTA backend's memory to sign requests. The signature is fixed, so one logged request body gives away the wallet. Floor, daily limit and alerts bound the loss; they do not prevent it.
- A lost order answer stays with staff, because PKFare reads an order only by its own number. For a Velexis source the reconciliation role decides (4.10); until then the booking is pending and the card hold stays.
- Without a statement file the daily check cannot name the booking behind a difference.
- Until the adapter implements void requests, a PKFare void is done by hand, and some windows will be missed.

### 9.5 The size of the work against the launch

- The low figure, 836 agent-hours, is 52 % of the 1,618 agent-hours of the whole MVP plan.
- P0 alone needs about 33 review hours, more than one review week. Section 7 proposes them after the SDK publish, which has priority. 2026-11-25: the records rounds of that day did most of P0; its other three tasks are in phase A (section 0).
- P3 changes the live Amadeus money path, and Amadeus was never proven on its real test environment. P7 depends on P3.
- Counsel's answer (4.14) is not a precondition of the M6 launch while the supplier is shown, as today. It becomes one if P5 goes live before the launch. 2026-11-25: M7 is built before the launch, by the owner's decision of that day (ADR-0030 item 19). As the lead reads it, the supplier is then hidden in live use from the launch on, so counsel's answer is needed before the launch. Counsel is question (43d), which the owner asked the lead to explain; it is open.

### 9.6 Other open questions

1. **Markup in two places.** OTAs already have markup rules. Should an OTA rule also adjust the price? The alternative adds a supply id condition to the markup scope. 2026-11-25: the question concerns an OTA's own rules, which the lead's re-scope places in milestone M8; it waits for M8 (OADR-0019 question 1).
2. **Paid bags after ticketing** are out of the first release (A30; BM7-16 and BM7-17, 12 agent-hours, are in "Later"). Reason: they need a second payment and a second supplier order, two section writers disagreed, and this is the safer version for money. The owner's words are "the extras and low-cost should be in the first release". The first release has bags and seats booked with the order. The owner decides whether that is enough, or whether the two tasks return to P7.
3. **Own PKFare accounts** get no tools in the OTA admin (A29); the OTA works its cases in PKFare's portal. To confirm. 2026-11-25: in the lead's re-scope an OTA's own PKFare account is milestone M8, so this question waits for M8; whether that account moves is question (44d), open.
4. **Schedule changes of PKFare orders.** PKFare's reference lists schedule-change operations, and no task reads them. PKFare's own e-mails reach a Velexis mailbox (A35), and no task passes them on. The task blocks of P7 add the tasks or a manual routine.
5. **The deadline of the second source** has no number until P1 and the P6 load test.
6. **Disclosure on request may not be enough.** The owner decided that an OTA may ask for the supplier (row 9). If counsel finds that Velexis is a processor for each OTA, "on request" may not be enough (4.14); the owner then decides again. Until the answer, no supplier is hidden in live use.
7. **Ticketing policy.** An OTA on `manual_review` gets no PKFare content, and `issue_at_booking` runs as `issue_after_payment` for a source paid from a supplier balance (4.9, BM3-03). This is an exception to the owner's one flow and to "all enabled suppliers". To confirm.

## Annex A: proposed wording for the `decisions.md` rows

On 2026-11-25 `decisions.md` took the sentences of this table that rest on an owner's decision, some reworded (section 5); the parts that rest on an assumption are not in force. The column "Rests on" shows what is the owner's decision (a row number of section 2) and what is still an assumption. An assumption must be confirmed before its sentence is merged. The line numbers in the first column are those of `decisions.md` before 2026-11-25; the rows it added moved the Secrets rule down.

| Place in `decisions.md` | Proposed text | Rests on |
|---|---|---|
| Line 7, first paragraph | "… The OTA sells flights from one or more **suppliers** (Amadeus Enterprise first, PKFare second) to its customers through a storefront and runs its operations in an OTA admin." | Rows 1 and 2 |
| Line 14, portal | "… billing, keys, domains, **Suppliers** (Velexis supply, own Amadeus or PKFare accounts) and Stripe connections, team" | Row 6 |
| Line 15, platform admin | "… subscriptions, **the supplier registry and its switches, Velexis's supplier accounts and offices, reconciliation of Velexis-supplied bookings**, Stripe settlements, provisioning jobs, audit" | Rows 2 and 8; A7, A12 |
| Line 18, OTA admin | "… bookings, **supplier tools for the OTA's own supplier accounts (the Amadeus console) and its supply rules**, payments, customers, markups, storefront settings" | Rows 6 and 13; A5, A14 |
| Line 32, Customer payments: sentences added | "Method (b) only for Amadeus. Other sources: Stripe only, captured before ticketing. Velexis pays PKFare from its wallet and recovers the cost offline." | Rows 5 and 7; "Stripe only, captured before ticketing" is A6 and the lead's first proposal |
| Line 34: replaces "Whose Amadeus account" | "**Whose supplier account: Velexis supply by default, own Amadeus or PKFare accounts as well.** Each is a supply source with an opaque id. An OTA is not shown which supplier Velexis uses; it may ask." | Rows 3, 9 and 11 |
| New row "Supplier engine" | "**One ingestion engine with supplier adapters.** The booking flow uses one interface and is the same for every supplier. A search fans out to the adapters of all enabled suppliers, and the engine merges the results. Hooks (pre-action, post-action, post-merge) let Velexis manage supply through rules stored as data; no tenant-supplied code runs. An OTA that uses its own supplier gets the same engine." | Rows 1, 4 and 13; the engine's place in the OTA backend is A1; rules as data without tenant code are A2 |
| New row "Supplier switches" | "**A supplier can be switched on and off globally in the platform admin, and per tenant.**" | Row 2; what "off" stops is A12 |
| New row "Supplier id" | "**An opaque id identifies a supply source to the OTA.** A history table keeps every id that a source ever had." | Rows 3, 9 and 11; the format is A4 |
| New row "Content" | "**Extras and low-cost content are in the first multi-supplier release.** Extras are part of the supplier interface; a booking without extras skips the step." | Row 12. Not yet secured: low-cost depends on the P1 facts (9.1); paid bags after ticketing are later (A30, 9.6) |
| New row "Staff access to bookings" | "**A reconciliation role for Velexis staff gets a reference to OTA bookings.** It sees bookings that Velexis supplies." | Row 8; the limit to Velexis-supplied bookings is A7 |
| Line 68, Secrets | "**Secrets**: supplier credentials (Amadeus, PKFare) and Stripe credentials are envelope-encrypted in the database …" | Follows from rows 2 and 3 |
| Section 3, new row | "`docs/pkfare-api/README.md` and `ota/docs/suppliers/pkfare-facts.md`: the index of PKFare's API reference and the facts the plans rely on." | A42 |

## Annex B: the full task list

- Keys are placeholders: `E` engine, `SP` platform, `OS` OTA surface, `BM` booking and money, `RC` reconciliation, `G` governance, `ED` added by the editor. P0 gives the real ids. 2026-11-25: Annex C gives them.
- Sizes: S is 2 agent-hours, M is 4, L is 8. Each task includes its tests and documents.
- Totals: 179 tasks and 836 agent-hours in the first release; 6 tasks and 36 agent-hours later. 2026-11-25: section 0 gives the totals of milestones M7 and M8; this annex is kept as the proposal it was.

What the editor changed in the six writers' lists (178 tasks, 828 agent-hours as written):

| Change | Tasks | Effect on the sum |
|---|---|---|
| Merged: the same deliverable named twice; the larger size is kept | G1-05 with BM6-02 (both M): one PKFare fake | 1 task and 4 agent-hours less |
| Merged | BM7-19 (M) into OS-12, OS-19 and OS-20, which already hold its storefront items | 1 task and 4 agent-hours less |
| Moved to "Later": two writers disagreed, and this is the safer version for money | BM7-16 (L) and BM7-17 (M), paid bags after ticketing | 2 tasks and 12 agent-hours less |
| Moved between phases | SP-18 from P4 to P7: it needs PKFare ticketing | none |
| Added by the editor: a writer names the work, no writer lists a task | ED4-01 (M), ED8-01 (L), ED8-02 (L), ED8-03 (M), ED8-04 (M) | 5 tasks and 28 agent-hours more |
| Scope split between two tasks; both sizes kept | BM7-13 and OS-21; BM7-18 and OS-20; BM3-02 and OS-11; E3-03 and BM3-04; RC-06 with BM7-10 and SP-18 | none |
| **Result** | **179 tasks** | **836 agent-hours** |

### P0: decisions and records (15 tasks, 70 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| G0-01 | `docs/mvp/decisions.md`: the rows of Annex A; the owner merges it | S | Decision file | The owner's confirmation of section 3 |
| G0-02 | ADR-0030 with its index row; dated notes in ADR-0012, ADR-0006, ADR-0011, ADR-0015 and ADR-0004; a dated note in `docs/mvp/conventions.md` §1 on the id format | M | Decision records | G0-01 |
| OS-02 | Contract annex of ADR-0030: the hiding rule per surface, the `FlightOfferSource` values, the fields whose meaning changes, the rule that a new response property or enumeration value is a minor SDK version | S | Decision records | The owner's decisions |
| G0-03 | ADR-0025: dated revision of item 3 (how M7 runs beside M6; never in the wave of the first merge or of the SDK publish) and a note under item 6; `AGENTS.md` (its picking rule), `CLAUDE.md` rule 2, `docs/mvp/README.md` and `docs/mvp/plans/README.md` §4 follow the revision and name M7; approved by the owner | S | Decision records | G0-01 |
| G0-04 | OADR-0019 with its index row; dated notes in OADR-0001, OADR-0002, OADR-0003 and OADR-0005 | M | Decision records (OTA) | G0-02 |
| G0-05 | OADR-0020 with its index row; dated notes in OADR-0003, OADR-0008, OADR-0010 and OADR-0013 | M | Decision records (OTA) | G0-02 |
| G0-06 | PADR-0020 with its index row; dated notes in PADR-0015 item 6, PADR-0010, PADR-0012 item 4 and PADR-0018 | M | Decision records (platform) | G0-02 |
| RC-01 | PADR-0021 (role, ledger, cases, support interface); dated revisions of PADR-0006 item 8 and its follow-up on sub-roles, ADR-0003 (the front-end rule; items 2 and 5), ADR-0009 item 3, OADR-0009 and OADR-0011; the owner's case deadlines in `decisions.md` | M | Decision records | The owner's decisions |
| RC-02 | Privacy pack for the owner's counsel: the questions, the disclosure procedure, the notice text block, the template of the recipients list, the clause for the OTA terms | S | Documents | The owner's decisions |
| OS-01 | SDK 1.0.0 notes, documentation only: the sentence that response enumerations may gain values (contract `info.description`, `ota/sdk/README.md`, guide, CHANGELOG 1.0.0); notes that `amadeus` members are optional and `Booking.recordLocator` can stay null; dated notes in OADR-0016 and ADR-0006. It moves to 1.1.0 if it would delay the publish | S | OTA contract, SDK documents | The owner's go-ahead |
| G0-07 | Task blocks for P1 to P3 in the three task files, with real ids and Milestone M7; the M7 section of both implementation plans (the plans index asks for it, section 6); plan-lint without errors; plan counts updated | L | Plans | G0-03, G0-04 |
| G0-08 | Task blocks for P4 and P5; plan counts updated | L | Plans | G0-06, G0-07 |
| G0-09 | Task blocks for P6 and P7, written after the P1 facts; plan counts updated | L | Plans | G0-05, G1-06 |
| G0-10 | Task blocks for P8 to P10; plan counts updated | L | Plans | RC-01, G0-08 |
| G0-11 | Re-baseline under ADR-0025 item 6: roadmap (the row "Milestone order", both calendars, an M7 section with its deep-review list of money pull requests, status row, outside-step rows for PKFare, change log, summary table), `docs/mvp/plans/README.md`, both solo plans | L | Plans | G0-03, G0-07 |

### P1: PKFare facts, sandbox and fixtures (6 tasks, 20 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| G1-01 | Facts file `ota/docs/suppliers/pkfare-facts.md`: every PKFare statement the plan relies on, with its source and a status (stated, observed, assumed); the question list for PKFare; `docs/pkfare-api/README.md` as the index of the saved reference | M | OTA documents | G0-01 |
| G1-02 | Recording tool `pkfare:record <operation>`: it runs on the developer's machine with sandbox credentials from the local environment, never in CI; it scrubs by allow-list; it refuses to write a file that holds the key, the signature or an unscrubbed document number | M | Root tooling | G1-01; sandbox credentials (human step) |
| G1-03 | Fixture set and manifest: Shopping, PrecisePricing, Penalty, AncillaryPricing, PreciseBooking, OrderPricing, Ticketing, OrderDetail in each state, CancelOrder, WalletBalance, notifications, refusals (B022, B024), a statement sample; a test fails on an unscrubbed value and on a fixture that no fact cites | M | Root tooling | G1-02; the recording run (human step) |
| G1-04 | Sandbox measurements: response time per operation and the limits met, written into the facts file; they set the PKFare search deadline and the server budget of `checkout.complete` | S | OTA documents | G1-02 |
| G1-05 | PKFare fake as the dev-only package `tools/pkfare-stub`: loopback HTTP server, signature check, clock, failure injection, fixture loader; Shopping, PrecisePricing, Penalty and AncillaryPricing fed by the fixtures; an entry in the end-to-end stack; entries in `check-no-hardcoded-hosts.mjs` and `check-package-json.mjs`; dated notes in ADR-0015 and ADR-0022. Merged with BM6-02 | M | Root tooling | G1-03 |
| G1-06 | P1 exit: A6, A8 and A9 checked against the observed facts; dated notes in ADR-0030 and OADR-0020; the list of rows that are still "assumed" | S | Decision records | G1-03, G1-04 |

### P2: engine and interface, Amadeus search and pricing (16 tasks, 68 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| E2-01 | Golden baseline for shopping: record the Amadeus request bodies, the `supplier_requests` rows, the stored offer and priced-offer rows and the API answers of the stub scenarios (search, price, upsell); a test compares them | M | OTA backend (tests) | G0-07 |
| E2-02 | `supply/interface`: adapter interface, capability list, outcome sets, neutral offer and priced-offer types (today's `ParsedOffer` with a supplier offer reference); a fake adapter under `ota/backend/test/supply/` | M | OTA backend | G0-07 |
| E2-03 | Move `src/amadeus/` (client, token, limiter, connection resolver, error mapper) into `supply/adapters/amadeus/`; the supplier call log repository becomes common and requires a provider; no change in behaviour | M | OTA backend | E2-01, E2-02 |
| E2-04 | Lint boundary in `eslint.config.mjs`: no adapter import from business code, no business import from an adapter, HTTP clients only in adapters; cases in `lint-rules.test.ts` | S | Root tooling, OTA backend | E2-03 |
| E2-05 | Registry (`supply/registry`): the sources that are on for a tenant and environment, read through the platform cache (the Amadeus connection today); adapter look-up; `capabilities()` | M | OTA backend | E2-02, E2-03 |
| E2-06 | Tenant migration: `supplier`, `supply_id` (nullable until ED4-01) and `supplier_offer_ref` on `flight_offers` and `priced_offers`; Amadeus columns nullable, with a CHECK for Amadeus rows; table `flight_search_sources` (search, source, outcome, skip reason, offers received, kept and dropped, duration); insert helpers that require the source | M | OTA backend (migration) | E2-02; the id format (G0-02) |
| E2-07 | Engine core (`supply/engine`): action pipeline, the three hooks with typed inputs (read-only on money actions; fail closed where a hook may refuse), routing by row; tests `unknown-source-refused`, `money-hooks-cannot-mutate`, `hook-failure-fails-closed` and `hook-failure-never-blocks-servicing` with the fake | M | OTA backend | E2-05 |
| E2-08 | Search through the engine: `buildAmadeusSearch` becomes the adapter's pure `prepare` step and keeps today's validation errors; fan-out with a deadline per source; `searches.service.ts` stops importing the client; single-flight key unchanged with one source; the outcome stored per source | L | OTA backend | E2-06, E2-07 |
| E2-09 | Merge: the limit on the merged list with shares (equal by default, an unused share passes on); the one-currency rule; unit tests with two fake sources | M | OTA backend | E2-08 |
| E2-10 | Duplicates across sources: the like-for-like key; minimum saving and preferred source as settings; tests with two fake sources | M | OTA backend | E2-09 |
| E2-11 | Offer readers per adapter: dispatch at the 5 `parseOffer` sites that hold a row; guards at the 6 Amadeus-only sites | M | OTA backend | E2-06 |
| E2-12 | Priced-offer readers per adapter (`readPricingReply`, 15 call lines; `confirmedOffersOf`, 8); pricing snapshot version 2, keyed by the supplier offer reference | L | OTA backend | E2-11 |
| E2-13 | Price and re-price through the engine (`priced-offers.service.ts`, 3 call lines); offers of mixed sources refused | M | OTA backend | E2-07, E2-12 |
| E2-14 | Upsell as a capability (`upsell.service.ts`), skipped when missing | S | OTA backend | E2-13 |
| E2-15 | Conformance suite, part 1 (capabilities, search, read, price, deadlines, redaction, no supplier name in neutral output), run against the Amadeus adapter with its stub and against the fake | M | OTA backend (tests) | E2-13 |
| E2-16 | Proof: the golden comparison is equal; the search load test repeated through the engine and recorded in `ota/docs/performance.md` | M | OTA backend, tools/perf | E2-08 to E2-15 |

### P3: Amadeus adapter for booking (22 tasks, 106 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| E3-01 | Golden baseline for booking: request bodies and `supplier_requests` rows for create, issue, read, cancel, patch, queue list and read by reference, in the stub scenarios of the 9 booking integration files | M | OTA backend (tests) | E2-16 |
| E3-02 | Tenant migration: `supplier`, `supply_id` and `supplier_order_ref` on `bookings` (filled from `amadeus_order_id` for old rows); the helper `hasSupplierOrder` at the about 18 places that test `amadeus_order_id` | M | OTA backend (migration) | E2-06 |
| E3-03 | The five job queries (ticketing scan, sync scan, reconcile scan and adoption, undecided cancellations, issuance after a late capture) select by the neutral column and name the supplier they serve; a booking of an unknown source is skipped and alerted. No blind dispatch: see BM3-04 | M | OTA backend | E3-02 |
| E3-04 | The order recorder takes a neutral order: supplier order reference, an already redacted snapshot, an explicit pay-by time, no record locator required; `readCreatedOrder` stays in the Amadeus adapter | M | OTA backend | E3-02 |
| E3-05 | Create order through the engine in the orchestrator (lines 818, 1178-1180, 1326, 1485, 1493) with the four outcomes; `createFailureKind` moves into the Amadeus adapter unchanged, and every other adapter defaults to `unknown`; the airline card stays an Amadeus-only extension | L | OTA backend | E3-01, E3-04; the Amadeus proof of section 8 |
| E3-06 | The other completion entries dispatch by source: the idempotency replay hook and the airline-card completion (refused for a source without that payment method) | M | OTA backend | E3-05 |
| E3-07 | Extras through the engine: catalogue and price with selections (`ancillaries.service.ts:977`, orchestrator 1681); the step is skipped when the capability or the catalogue is empty | M | OTA backend | E2-13 |
| E3-08 | Card-fee quote as a capability (`card-fees.ts:373` and its reader) | S | OTA backend | E2-13 |
| E3-09 | The issue step of the orchestrator (2428) through Request ticketing, with `accepted` for suppliers that ticket later | M | OTA backend | E3-05 |
| E3-10 | Ticketing job through the engine (`ticketing.service.ts` 599, 622): read first, request once, no repeat after `accepted` | L | OTA backend | E3-03, E3-09 |
| E3-11 | Sync through Read order (`booking-sync.service.ts:867`); a neutral reader for the stored order snapshot | M | OTA backend | E3-04 |
| E3-12 | Find order: the queue-and-remark search of `reconcile.service.ts` (1667, 1704) becomes the Amadeus adapter's operation; `review-closure.service.ts:503` uses it; `incomplete` never fails a booking | L | OTA backend | E3-03 |
| E3-13 | Cancel or release through the engine (`cancellation.service.ts` 2431, 2711, 3411; `deleteFailureOf` moves into the adapter); the cancellation mode comes from the capability and the order state | L | OTA backend | E3-03 |
| E3-14 | Contact change and console booking actions through the engine (`booking-changes.service.ts:663`; `console-booking-actions.service.ts`, 5 call lines); the console action list reads the capabilities | L | OTA backend | E3-11, E3-13 |
| E3-15 | Amadeus tools: one tools class for the 12 call lines of `raw-amadeus.service.ts`, `pnr-import.service.ts`, `queues.service.ts` and `queue-poller.processor.ts`, with the own-account guard (switched on in P5); after this no file outside the adapter imports the client | M | OTA backend | E2-04 |
| E3-16 | Service request and notification operations in the interface and the engine (optional; the Amadeus adapter declares none); a notification only triggers Read order (`notification-triggers-read-only`) | M | OTA backend | E3-11 |
| E3-17 | Conformance suite, part 2: the four create outcomes with `create-order-lost-answer`, `find-order-incomplete-never-absent`, ticketing now and later, read, cancel, service requests, notifications, redaction of the order snapshot | M | OTA backend (tests) | E3-05 to E3-16 |
| E3-18 | Proof: the golden comparison is equal; the 9 booking integration files unchanged and green; the booking load test repeated | M | OTA backend, tools/perf | E3-17 |
| BM3-01 | Operation Check payable in the interface and as the orchestrator's step between create and record; outcomes `payable`, `refused`, `higher_amount`, `balance_short`, `unknown`; the Amadeus adapter answers from the created order without a call | M | OTA backend | E3-05 |
| BM3-02 | Order recorder option for sources that ticket later: the confirmation e-mail and the "confirmed by the airline" event move to "ticketing accepted"; `ticketingMessageOf` gets a "finalising" sentence (the problem sentences are OS-11) | M | OTA backend | E3-04 |
| BM3-03 | Ticketing policy by capability: `manual_review` hides and refuses sources paid from a supplier balance (search and completion); `issue_at_booking` runs as `issue_after_payment`; a neutral note on the settings page | M | OTA backend, OTA admin | E3-05, E3-06 |
| BM3-04 | Fence: the CHECK `bookings_supplier_fence_ck`, Amadeus-only predicates in the retry and reconciliation queries, fence and mutation tests with a booking of the fake source | M | OTA backend (migration, tests) | E3-02, E3-03 |

### P4: platform (21 tasks, 102 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| SP-01 | Platform migration: `suppliers`, `supplier_environments`, `supply_sources` (with `sales_stop`), `supply_source_ids`; on `supplier_connections` the new columns, the supplier foreign key (no default supplier), the unique key with the credential source, the rewritten source CHECK; `credential_submissions.kind` with `pkfare`; sources and ids for existing rows; grants; data-model document; `baselines.int.test.ts` | L | Platform backend, `packages/db` | G0-01, G0-06 |
| SP-02 | Platform migration: `supplier_accounts`, `supplier_wallet_readings`; column-level grants for the OTA role (no wallet column); the `REWRAP_SOURCES` entry; operations document | M | Platform backend | SP-01 |
| SP-03 | Invalidation events `supplier`, `supplier_account`, `supply_source`; Redis keys `conn:supply`, `supplier:`, `supply:src:`, `supplier:acct:`, `supply:id:`; `invalidatedKeys`; architecture documents of both sides | M | `packages/api-types`, both backends | SP-01 |
| SP-04 | Supply ids: generator (`sup_` plus 16), `adminRotateSupplyId`, `adminResolveSupplyId`, audit rows; the `sup_` examples in `packages/crypto` corrected to `sc_` | M | Platform backend | SP-01, SP-03 |
| SP-05 | Global switch and source stop: `adminListSuppliers`, `adminSetSupplierState`, `adminSetSupplySourceStop`, each with reason, audit row and event | M | Platform backend | SP-01, SP-03 |
| SP-06 | Per-tenant switch and daily limit: `adminSetSupplySourceState`, `adminSetSupplyDailyLimit`; tenant rows for Velexis sources, off by default | M | Platform backend | SP-01, SP-03 |
| SP-07 | `PlatformReadRepository` reads and `SupplySourceResolver`: selling rule, servicing rule, environment check, host guard (`supply-switch.int.test.ts`, `supply-host-guard.test.ts`); it replaces the reads of the registry of E2-05 | L | OTA backend | SP-02, SP-03; E2-02 |
| SP-08 | PKFare balance gateway on the platform: signature, WalletBalance, 10-second time-out, no redirect, no request body in logs (`pkfare-signature-redaction.test.ts`) | M | Platform backend | G1-03 |
| SP-09 | Velexis supplier accounts: admin operations, the job `supplier_account.verify`, the official-host rule in production, a floor required before a live account is `active` | M | Platform backend | SP-02, SP-08 |
| SP-10 | `submitSupplierCredentials` (kind in the path) and the `pkfare` verifier: check, apply, own source and id, e-mail to the submitter; an OTA's own balance is never stored | L | Platform backend | SP-01, SP-08 |
| SP-11 | `getSuppliersPage` and `setSupplierSelection`; the Amadeus-named portal operations answer only for an own connection | M | Platform backend | SP-06 |
| SP-12 | Onboarding facts and go-live precondition: `supply_test`, `supply_live`; the portal's checklist and go-live texts | M | Platform backend, portal | SP-01 |
| SP-13 | Suppliers page: route, menu item, redirect from `/amadeus`, the Velexis section, the live access request, texts without a supplier name; the platform e-mail `amadeus.live_ready` gets a neutral text for a Velexis source, without a supplier name or an office id | L | Portal, platform backend | SP-11 |
| SP-14 | Own-account sections from the registry descriptor: Amadeus settings and credentials moved in, the PKFare form | M | Portal | SP-10, SP-13 |
| SP-15 | "Suppliers" area: registry list, dialogs for the global switch and the source stop with a reason, Velexis accounts with verify and disable | M | Platform admin | SP-05, SP-09 |
| SP-16 | Tenant page: supply sources, per-tenant switch, daily limit, id rotation and look-up | M | Platform admin | SP-04, SP-06 |
| SP-17 | The job `supplier.wallet_watch`: readings, warning level and floor, stop and resume on the source, alerts through the outbox (also "balance unknown" after three failed reads, without a stop), the runbook "wallet under the floor" | L | Platform backend | SP-09 |
| SP-19 | Wallet panel (balance, time, floor, stop, 30 days of readings) and a dashboard tile | S | Platform admin | SP-15, SP-17 |
| SP-20 | Own Amadeus beside Velexis: the verifier inserts a second connection and releases no office; the status action and the row locks take the supply source | M | Platform backend | SP-01; E3-03 to E3-15 (Amadeus routed by supply source) |
| SP-21 | End-to-end proof: switch off and on at each level; for a Velexis-only OTA the Velexis section, the portal API answers about Velexis supply and the rendered platform e-mails hold no supplier name, office id or host; the own-account sections "Amadeus" and "PKFare" stay | M | End-to-end tests | SP-13 to SP-16 |
| ED4-01 | Supply ids on old rows (added by the editor; the engine section proposes the step and lists no task): a tenant migration and a backfill set `supply_id` on stored offers, priced offers and bookings from the tenant's supply source, then NOT NULL; a row that cannot be mapped is listed, never guessed | M | OTA backend (migration) | SP-04, SP-07, E2-06, E3-02 |

### P5: the supplier hidden (17 tasks, 70 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| OS-03 | `supplyId` (both scopes) on `FlightOffer`, `PricedOffer`, `Booking` and `BookingSummary`; `supplyLabel` (console) on offers, priced offers, `ConsoleBookingSummary` and `ConsoleBookingDetails`; mappers; an old id from the history table still resolves | M | OTA contract, OTA backend | SP-04, E2-06, ED4-01 |
| OS-04 | Own-account guard on: the 15 tool operations and raw offers in `flights.price` answer `FEATURE_DISABLED`; `ConsoleTenant.supplierTools`; neutral `ConsoleTenant.supplier`; the supplier log lists own sources only; test `amadeus-tools-own-account` | M | OTA contract, OTA backend | E3-15, SP-20 |
| OS-05 | Customer scope, Velexis source: `amadeus` members omitted or null (offer, priced offer, booking, ticket, fare rules, dictionaries); the search criteria echo is null, `amadeusOperationId` mirrors `mode` | M | OTA backend | OS-03 |
| OS-06 | Neutral default texts for the supplier error codes (catalogue descriptions, 14 literal messages); `error.supplier` only for an own source | S | `packages/errors`, OTA backend | OS-03 |
| OS-07 | Console scope, Velexis source: no verbatim offer or order, `netPrice` is the cost price, no `diagnostics`, `amadeusOrderId` and the sync's request id null | M | OTA backend | OS-03 |
| OS-08 | `FlightOfferSource` in one change: contract, tenant migration for the CHECK, the offer reader's list, the Velexis mapping to `GDS`, `NDC`, `LCC`, `OTHER`, both rule scopes with `pricing-rules.mapper.ts`, the admin label table, the pinned contract test, a matcher test | L | OTA contract, OTA backend (migration), OTA admin | OS-02, E2-06 |
| OS-09 | Record locators: for a Velexis source customer scope lists airline locators only, and the main locator is the airline's or null; `BookingRecordLocator.kind`; both storefront pages choose by kind and keep the `1A` rule as a fall-back; the e-mail and PDF line is safe when empty | M | OTA contract, OTA backend, storefront | OS-03 |
| OS-10 | `Checkout.paymentMethods` (the OTA's methods, cut by the source's capabilities); a refused method answers `FEATURE_DISABLED`; the checkout page reads the list | M | OTA contract, OTA backend, storefront | E3-06 |
| OS-11 | Allowed actions with true reasons from the capabilities (cancel, refresh, extras); true sentences in `BookingTicketing.message` for `failed` and `manual_review` | M | OTA backend | E3-13, E3-14 |
| OS-12 | Storefront: a problem state on the confirmation, booking and my-bookings pages; a cancel note for request-only and closed reasons; the line "cannot be changed or refunded" on the price page and the checkout | M | Storefront | OS-11 |
| OS-13 | The OTA admin hides tools by `supplierTools`: the menu items PNR lookup, Queues, Shopping and Supplier log; the order tab and raw views; a direct link answers "not available" | M | OTA admin | OS-04 |
| OS-14 | OTA admin, neutral wording (39 files): sync button, order tab, dashboard hints, error texts; the supply label in the bookings list and detail; the portal link "Suppliers" | L | OTA admin | OS-03, OS-13, SP-13 |
| OS-15 | Customer leak walk: a Velexis mode in `json-walk.ts`; a walk over every customer operation of shopping, checkout and bookings, for a Velexis Amadeus source and a Velexis stub source | M | OTA backend (tests) | OS-05, OS-06, OS-09 |
| OS-16 | Console leak walk: `consoleScopeLeaks`; a walk over session, shopping, bookings and supplier log; the supplier's net amount never appears | M | OTA backend (tests) | OS-04, OS-07 |
| OS-17 | End-to-end proof: a crawl of the OTA admin of a Velexis-only OTA, a storefront journey walk, rendered e-mails and PDFs without a supplier word; a fixture OTA with its own Amadeus connection for the existing tool specs | M | End-to-end tests | OS-12 to OS-16 |
| OS-18 | Documents for integrators: a guide chapter on supply ids and hidden suppliers, api-changes, SDK README and CHANGELOG 1.1.0 | S | OTA documents, SDK | OS-03 to OS-11 |
| RC-03 | Interim guidance until P9: for a Velexis-supplied booking the request-only dialog of the OTA admin, the staff alert of `booking.cancellation_requested` and the runbook's support levels send staff to Velexis support, not to a terminal | S | OTA admin, OTA backend, runbooks | OS-14 |

### P6: PKFare search and pricing (9 tasks, 44 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| BM6-01 | PKFare client in `supply/adapters/pkfare/`: JSON POST, signature in the body, official-host guard, time-outs, call-log rows without signature or document numbers (`pkfare-signature-redaction` for the OTA backend) | M | OTA backend | G1-03, E2-03, SP-07 |
| BM6-03 | Search: a pure `prepare` step (2 journeys, 9 seats, infants, currency) that answers `skipped`; Shopping with its own deadline; neutral offers; unreadable offers counted | L | OTA backend | BM6-01, G1-05, E2-08 |
| BM6-04 | Offer reader: the complete price reference as `supplier_offer_ref`, carriers, cabins, bags, the content type with the low-cost flag | M | OTA backend | BM6-03, E2-11, OS-08 |
| BM6-05 | Pricing: PrecisePricing, the single-use reference (`supplier_valid_until`, `consumed_at`), outcomes `priced`, `sold_out`, `refused`, `unavailable` | L | OTA backend | BM6-04, E2-12, E2-13 |
| BM6-06 | Traveller requirements in the neutral form of the checkout | M | OTA backend | BM6-05 |
| BM6-07 | Fare rules through the Penalty API; "not sold without readable rules"; the "no change, no refund" block for low-cost | M | OTA backend | BM6-05 |
| BM6-08 | Expected debit (wallet currency, merchant fee) and cost price stored on the priced offer; never returned | M | OTA backend | BM6-05, E2-06 |
| BM6-09 | Conformance suite part 1 against the PKFare adapter; merged search with two stubs: a PKFare failure or time-out never fails the search, and a source that is off gets zero calls | M | OTA backend (tests) | BM6-03 to BM6-08, E2-15 |
| BM6-10 | Search load test with merged results; the PKFare deadline as a number in `ota/docs/performance.md` | M | tools/perf, OTA backend | BM6-09 |

### P7: PKFare booking, extras and low-cost (25 tasks, 134 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| BM7-01 | Tenant migration: `booking_supplier_orders`, repository through `tenantTx`, isolation test, data-model document | M | OTA backend (migration) | BM3-04 |
| BM7-02 | Stateful order side of the fake `tools/pkfare-stub`: order store; PreciseBooking, OrderPricing, Ticketing, OrderDetail, CancelOrder, WalletBalance, with scripted refusals, lost answers and status changes | L | Root tooling | G1-05 |
| BM7-03 | Create order: PreciseBooking with a write-ahead, an outcome classifier with a code table per API, a neutral order with an allow-listed snapshot | L | OTA backend | BM7-01, BM7-02, E3-05 |
| BM7-04 | Check payable: OrderPricing and WalletBalance against the expected debit; the release path (CancelOrder, booking failed, void) | M | OTA backend | BM7-03, BM3-01 |
| BM7-05 | Capture deadline: PaymentIntent read under the booking lock, CancelOrder, booking cancelled, void, e-mail; a racing capture becomes an open case | L | OTA backend | BM7-04 |
| BM7-06 | Request ticketing: order read, second OrderPricing, write-ahead, one request, debit comparison, balance refusal | L | OTA backend | BM7-04, E3-09 |
| BM7-07 | Follow-up job `supply.order_followup`: the one ticketing request after a late capture, polling until a final status, stale write-aheads to review (it sends `supply.case_opened` for a stale order write-ahead), status mapping | L | OTA backend | BM7-06, BM7-10 |
| BM7-08 | Record tickets and the airline's reference from OrderDetail (`pnrList`, fall-back) under the booking lock | M | OTA backend | BM7-07 |
| BM7-09 | Watchdog `supply.paid_unticketed_watch` in its own scheduler; daily repeat of the alert; the age of the oldest case in the health checks | M | OTA backend | BM7-01 |
| BM7-10 | Open cases: query, console operation (contract first, additive), the case message `supply.case_opened` on `platform-tenant-events` for P9 | M | OTA backend, `packages/api-types` | BM7-09 |
| BM7-11 | Open-cases list in the OTA admin, with state and deadline; no supplier details for a Velexis source | M | OTA admin | BM7-10 |
| BM7-12 | Limits at completion: sales stop, the cap of K open cases, the daily limit per OTA from the expected debit; refused before the capture | M | OTA backend | SP-06, SP-18, BM6-08 |
| BM7-13 | Texts: the rules that send `booking.ticketing_problem` (the key is OS-21), staff alert reasons, the held-back confirmation in use (`pkfare-traveller-texts`) | M | OTA backend | BM3-02, BM7-06, OS-21 |
| BM7-14 | Console guards for a non-Amadeus booking: capture, refund, close-review (refused for a Velexis source; for an own source it takes a PKFare order number), refresh | M | OTA backend | BM7-07, E3-14 |
| BM7-15 | Extras with the order: AncillaryPricing catalogue, selection limits, bags and seats in PreciseBooking, re-price, the amount in the expected debit | L | OTA backend | BM7-03, E3-07 |
| BM7-18 | Low-cost: the ticketless completion rule (`ticketless-only-when-flagged`), the kind of the airline reference, the closed cancel reason; the contract field and the wording are OS-20 | L | OTA backend | BM7-08, BM6-04; the P1 facts |
| BM7-20 | Notification endpoint (optional for the pilot): routing by our reference, read trigger only, rate limit | M | OTA backend | BM7-07, E3-16 |
| BM7-21 | Failure matrix `pkfare-failure-matrix.int.test.ts` with its fourteen assertions (listed below this table) | L | OTA backend (tests) | BM7-03 to BM7-14 |
| BM7-22 | Conformance suite part 2 against the PKFare adapter; `pkfare-snapshot-redaction` on `bookings.order_snapshot` and the call log | M | OTA backend (tests) | BM7-08, E3-17 |
| BM7-23 | End-to-end on the fake (full-service, low-cost, with extras, open case) and three runbooks (paid and not ticketed, balance refusal, lost order answer) | M | End-to-end tests, documents | OS-19, OS-20, BM7-13, BM7-18 |
| OS-19 | Extras, neutral shape: `ExtraOption`, `AncillaryCatalogue.extras`, `BookingAncillaryOptions.extras`, filled for every supplier; the storefront extras step reads `extras` and is skipped when there are none | L | OTA contract, OTA backend, storefront | E3-07 |
| OS-20 | Ticketless bookings: `BookingTicketing.ticketless`, wider descriptions, itinerary wording, no receipt, the key `booking.confirmed_ticketless`, storefront strings for a ticketless booking and for the "finalising" state (merged from BM7-19) | M | OTA contract, OTA backend, storefront | OS-02; the P7 booking model |
| OS-21 | Key `booking.ticketing_problem`: contract value, registry, template files, preview data; the rules that send it are BM7-13 | M | OTA contract, OTA backend | OS-12 |
| OS-22 | `SupplierIssue`: open `provider` values and a text `providerCode`, shown for own accounts only | S | OTA contract, `packages/errors` | BM7-03 (the error mapping) |
| SP-18 | Balance refusal path (moved from P4, because it needs PKFare ticketing): the Redis stop flag in the OTA backend, the message `supply.balance_refused` on `platform-tenant-events`, the platform consumer | M | OTA backend, platform backend, `packages/api-types` | SP-17, BM7-06 |

The fourteen assertions of the failure matrix (BM7-21):

1. No capture unless the last OrderPricing is inside its window and the hold is open; a console capture past the hold is refused.
2. No Ticketing request without a full capture.
3. At most one Ticketing request per order; after a lost answer or a restart, none.
4. At most one PreciseBooking per checkout, for any idempotency key and any number of tabs.
5. The captured amount equals the booking total and the selling total of the pricing used, and never exceeds the authorised amount.
6. No void of the card payment once a Ticketing request was sent; a void is queued only after the booking left `confirmed`.
7. Never `ticketed` without ticket numbers (exception: 4.11).
8. Every booking with captured money and no ticket has a staff alert and a row in the open-cases list.
9. No "confirmed" e-mail before the Ticketing request was accepted; no "not charged" text after a capture.
10. The debit in the Ticketing answer is compared with the expected debit.
11. A process stop between every two steps, with the same idempotency key replayed after each, sends no second write to PKFare.
12. The capture deadline handled while a capture is in flight ends with an alert.
13. After one balance refusal the next completion is refused before the capture.
14. PKFare tests send nothing to the Amadeus stub, and the Amadeus booking tests are unchanged.

### P8: rules at the hooks and their two screens (12 tasks, 58 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| E8-01 | Rule model and matcher in `supply/rules`: conditions reuse the markup scope parser (`pricing/rule-matcher.ts`), plus supply ids, travel dates and days before departure; unknown fields refused; test `rules-are-data-only` | M | OTA backend | E2-07 |
| E8-02 | Tenant rules: the table `supply_rules` (tenant migration), repository, a check that a rule names only the OTA's own sources | M | OTA backend (migration) | E8-01, SP-10, SP-20 |
| E8-03 | Read path for Velexis's rules: read grant in `R__ota_read_access.sql`, read repository, cache key and invalidation; no OTA answer returns them | M | Platform backend (grant), OTA backend | E8-01, ED8-01 |
| E8-04 | Handler: supplier selection by rule (origin, destination, dates, airline) at pre-action; outcome `skipped` with the rule id | M | OTA backend | E8-02, E8-03 |
| E8-05 | Handler: carrier rules at post-action (default: every carrier on) | S | OTA backend | E8-04 |
| E8-06 | Handler: price rules per supply source at post-action of Search and Price; the adjustment is stored as its own component; rule versions pinned on the priced offer; test `supply-net-leak` | L | OTA backend | E8-04, OS-07 (raw payload hidden) |
| E8-07 | Rules for shares, deadlines, preferred source and minimum saving | M | OTA backend | E8-04, E2-10 |
| E8-08 | Proof: `rule-ownership` in both directions; the three hook tests of E2-07 repeated with stored rules; the cost of rules measured in the search load test | M | OTA backend (tests), tools/perf | E8-05 to E8-07 |
| ED8-01 | Velexis's rules on the platform (added by the editor): platform migration for the rules table (version, window, priority), validation with the rule model of E8-01, admin operations (list, create, change, switch on and off) with reason, audit row and invalidation event | L | Platform backend, `packages/api-types` | E8-01, SP-01 |
| ED8-02 | Rules screen in the platform admin (added by the editor): list, form (hook, conditions, effect, priority, window), versions, switch with a reason; for Velexis sources, for all OTAs or named ones | L | Platform admin | ED8-01 |
| ED8-03 | Console operations for an OTA's own rules (added by the editor; contract first, additive): list, create, change, switch off; `FEATURE_DISABLED` without an own supplier account; SDK methods | M | OTA contract, OTA backend | E8-02 |
| ED8-04 | Rules screen in the OTA admin (added by the editor), shown only with an own supplier account (A14) | M | OTA admin | ED8-03 |

### P9: reconciliation (23 tasks, 124 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| RC-04 | Platform migration: `platform_staff_roles`, `supply_ledger`, `supply_cases`, `supply_case_events`; no grant for the OTA role (`baselines.int.test.ts`); data-model document | M | Platform backend | SP-01, SP-02 |
| RC-05 | Role: grant and revoke (fresh MFA code, reason, audit row, the `staffdeny:acct` cut-off on revoke), admin sign-in for a role holder, the scope `platform_reconciliation` in the guard; tests: an admin without the role is refused, and a role holder is refused on every `platform_admin` operation | L | Platform backend | RC-04 |
| RC-06 | Messages `supply.booking_fact` and `supply.case_opened` in `packages/api-types/jobs`: one report envelope with `jobId` null, shared with `supply.balance_refused` (SP-18) and the case message of BM7-10; schemas with `additionalProperties: false`; `supply-fact-schema.test.ts` (no traveller field) | M | `packages/api-types` | RC-01, BM7-10, SP-18 |
| RC-07 | Fact outbox in the OTA backend: tenant migration (outbox, sequence), writes in the transactions that create, pay, ticket, cancel and reimburse a supplier order, a publisher job with fixed job ids, a daily re-send of open orders; `own-source-sends-no-fact`; isolation test | L | OTA backend (migration) | RC-06, BM7-01, BM7-07 |
| RC-08 | Ledger consumer: `tenant-events.processor.ts` dispatches the supply messages; upsert by tenant and supplier order, the highest sequence wins; replay and out-of-order tests | M | Platform backend | RC-04, RC-06 |
| RC-09 | Support interface 1: caller kind `support` (`PLATFORM_ADMIN_SERVICE_KEY`, loopback, no forwarded headers), handoff redeem (`GETDEL`), a token bound to tenant, environment and booking; tenant migration for the actor `platform_staff` and the new value of `ConsoleActor.type`; contract tag `Support` with `x-internal: true`, blocked publicly by Caddy; `support-caller-route-fence` | L | OTA backend, OTA contract, deploy files | RC-01 |
| RC-10 | Handoff issue `createSupportHandoff`: role, reason, only a booking that has a ledger row or an open case; Redis `SET … EX 60 NX`; audit `support.handoff_issued` | M | Platform backend | RC-05, RC-08 |
| RC-11 | Support interface 2, reads: booking view, a fresh supplier read through the engine (status, codes, deadlines), the call log of the booking, queue snapshots of the OTA's Velexis office; every read audited; `support-view-redaction`, `support-own-source-404` | L | OTA backend | RC-09, E3-11, E3-15 |
| RC-12 | Cases in the OTA backend: for a Velexis source a `request_only` request, a schedule change that needs an answer and a lost order answer (the kind "order unknown", 4.10) open a case; states; case messages; neutral texts for the traveller and staff | M | OTA backend | BM7-10, E3-13, OS-11 |
| RC-13 | Console side of a case (contract first, additive): confirm a quote or record the traveller's choice; `console.payments.refund` refused with the reason `case_open`; a refund proposal from the outcome; `refund-refused-while-case-open` | M | OTA contract, OTA backend | RC-12, BM7-14 |
| RC-14 | Support interface 3, actions: record a quote, mark submitted, record the outcome (fresh read, booking moved by the sync's record step, waiting request ended, amounts stored, staff alert), for "order unknown" the order number or "no order" (the engine then releases a found order and fails the booking), note; one write per case step; `case-submit-needs-confirmation`, `case-outcome-needs-fresh-read`, `support-no-payment-operations` | L | OTA backend | RC-11, RC-13 |
| RC-15 | Cases on the platform: list, take, quote, submit, outcome, close; the kind "order unknown" with its two outcomes; the due time from the owner's hours and the supplier's limit; an overdue job with a daily repeat and escalation; action names in `audit-actions.ts`; notes refuse card numbers | L | Platform backend | RC-08, RC-10 |
| RC-16 | Ledger operations: list with filters, one row, CSV export per period and OTA (audit `supply_ledger.exported`), a recovery mark with a note; test: no traveller field in the export | M | Platform backend | RC-08 |
| RC-17 | Daily job `supply.ledger_check` with its top-ups table: the balance equation from `supplier_wallet_readings`, paid rows without a ticket after N minutes, sequence gaps; alerts | M | Platform backend | RC-08, SP-17 |
| RC-18 | Statement upload with its table; match by supplier order number and amount; three lists (equal, differs, on one side only) | M | Platform backend | RC-16; a statement sample (G1-03) |
| RC-19 | Role alerts: platform templates and recipients (role holders, else the ops list) for a new case, an overdue case, a debit difference and a failed check; role holders added to the wallet alerts; `staff-alert-neutral-text` over the OTA-facing templates | M | Platform backend, OTA backend | RC-15, RC-17, SP-17 |
| RC-20 | Platform admin, "Reconciliation" area 1: cases list and case page with supplier detail, quote and outcome forms, "Open booking" with a reason dialog and the redacted booking view (server-side call) | L | Platform admin | RC-14, RC-15 |
| RC-21 | Platform admin, "Reconciliation" area 2: ledger list, export, daily check panel, statement upload and its lists, top-up entry | L | Platform admin | RC-16 to RC-18 |
| RC-22 | Role grant and revoke dialog on the Admins page; the menu by role | S | Platform admin | RC-05 |
| RC-23 | OTA admin: cancel and schedule cases in the open-cases list, a case panel on the booking page (confirm, traveller's choice), the refund proposal and the `case_open` text, "Velexis support" rows in the audit list | M | OTA admin | RC-13, BM7-11 |
| RC-24 | Disclosure: recipient fields on the supplier account (legal name, address, country, privacy contact, agreement date), `supply_disclosures`, `adminDiscloseSupplier` (resolve the id at a date, store, audit `supply.disclosed`), admin dialog | M | Platform backend, platform admin | SP-04, RC-04 |
| RC-25 | Portal: "Ask which supplier served a booking" on the Suppliers page; a request row and an alert to platform admins; the notice text block in the portal documents | S | Platform backend, portal | RC-24, SP-13 |
| RC-26 | End-to-end proof on the fake: the cases of 4.12 through both admins; no supplier word in the OTA admin, alerts or e-mails; the runbooks "work a case", "daily check" and "disclosure request"; the support-level table updated | L | End-to-end tests, documents | RC-20 to RC-25 |

### P10: proof, certification, pilot and live gate (13 tasks, 40 agent-hours)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| G10-01 | `supply-secrets-by-value.int.test.ts`: after a full PKFare booking on the fake, a known key, signature, passport number, phone number and test card number are searched in `supplier_requests`, `bookings.order_snapshot`, offer and priced-offer rows, supplier-order rows, Redis job payloads, `platform-tenant-events` messages, `supply_ledger`, error answers, e-mails and log lines | M | OTA backend (tests), platform backend (tests) | BM7-22, RC-08 |
| G10-02 | `supply-isolation.int.test.ts`: two tenants and two environments; credentials, cache keys, rate buckets, stops and rules of one never serve the other; a booking on an own account is invisible to the reconciliation role | M | OTA backend (tests), platform backend (tests) | SP-07, E8-08, RC-11 |
| G10-03 | Final load and soak run on the built stack with two sources: merged search, PKFare bookings on the fake, follow-up jobs; budgets and the go or no-go numbers in `ota/docs/performance.md` | M | tools/perf, OTA backend | BM6-10, BM7-23 |
| G10-04 | Egress for the pilot: PKFare's test host in `deploy/egress/allowed-hosts.conf`, env template entries, a `check-vm.sh` test; by `docs/mvp/runbooks/outbound-allow-list.md` §2 | S | Deploy | G1-01 (the test host), SP-07 |
| G10-05 | Operations pack: an alert inventory with receiver and runbook; the runbooks `supplier-key-rotation.md`, `supplier-switch-off.md` and `supplier-outage.md`; an alert drill on the local stack | M | Documents, deploy | SP-17, BM7-23, RC-19 |
| G10-06 | PCI pack: scope confirmation, `data-flow.md`, `responsibility-matrix.md` §3 (no card data to a supplier other than through the airline-card path), the PCI references check without errors | S | OTA documents | E3-06 |
| G10-07 | Security review of the OTA modules (engine, hooks and rules, adapters, notification endpoint, support interface) in `ota/docs/security-review.md`; findings fixed or tracked | M | OTA backend | P7, P8 and P9 merged |
| G10-08 | Security review of the platform modules (registry, switches, supplier accounts, balance gateway, ledger, reconciliation role) in `platform/docs/security-review.md`; findings fixed or tracked | M | Platform backend | P4 and P9 merged |
| G10-09 | Certification support: an export per booking of order number, airline reference and ticket numbers for PKFare's workbook; the record `ota/docs/suppliers/pkfare-certification.md` | S | OTA backend, OTA documents | BM7-08 |
| G10-10 | Pilot plan and record `ota/docs/runbooks/supplier-pilot.md`: one OTA, test environment, scenarios, daily check list, exit criteria | S | OTA documents | G10-04, G10-05 |
| G10-11 | Go-live runbook `ota/docs/runbooks/supplier-go-live.md`, after the model of `airline-card-go-live.md`: the eight preconditions with evidence and sign-off, the co-test steps, the caps, how the switch goes on and off | M | OTA documents | G10-01 to G10-10, RC-27 |
| G10-12 | Live step: PKFare's production host as a constant and as an egress line, a `check-vm.sh` test; merged only when preconditions 1 to 6 are signed | S | Deploy, platform backend | G10-11 |
| RC-27 | Live gate for after-sales: a named role holder and a stand-in with MFA, the owner's deadlines set, counsel's answer recorded, a drill of the cases of 4.12 in the sandbox, the first daily check done against the supplier's statement | S | Launch checklist | RC-26 |

### Later: outside the first release (6 tasks, 36 agent-hours, not in the totals)

| Key | Task | Size | Component | Depends on |
|---|---|---|---|---|
| RC-28 | PKFare adapter: void request (VoidRequest, `permitVoid`, `lastVoidTime`), result by polling | L | OTA backend | E3-16, P10 |
| RC-29 | PKFare adapter: refund quote and request (RefundPricing, CheckRefundPricing, RefundRequest), result by polling | L | OTA backend | E3-16, P10 |
| RC-30 | Cases driven by the adapter: quote and submit call the engine; reimbursements update the ledger; the confirmation rule stays | M | OTA backend, platform backend | RC-28, RC-29 |
| RC-31 | Automatic outcome for the one clear case (the supplier shows the order cancelled and never paid), after real statuses were seen | M | OTA backend | RC-30 |
| BM7-16 | Paid bags after ticketing, flow: a new operation (contract first, additive), a second payment, a supplier order of kind `extras`, the add-bags entry on the storefront | L | OTA backend, OTA contract, storefront | BM7-07 |
| BM7-17 | Paid bags after ticketing, adapter: AncillaryPricing by order, AncillaryBooking, AncillaryTicketing, AncillaryOrderDetail, CancelAncillaryOrder, the 30-minute expiry; the fake | M | OTA backend | BM7-16 |

## Annex C: plan keys and task ids

The task blocks in the three task files are the source for each task, its dependencies included; this table only helps to find a plan row, with the phases of section 0 (phase Z holds milestone M8). The seven rows marked "none (review)" were added in the review of 2026-11-25 and have no plan row.

| Id | Plan key | Phase | Milestone | Size |
|---|---|---|---|---|
| X-051 | OS-02 | A | M7 | S |
| X-052 | RC-02 | A | M7 | S |
| SDK-020 | OS-01 | A | M7 | S |
| X-053 | NX-01 | A | M7 | S |
| X-054 | NX-02 | A | M7 | S |
| OAD-024 | OS-13 | B | M7 | M |
| X-055 | HT-00 | B | M7 | M |
| OBE-106 | HT-01 | B | M7 | M |
| OBE-107 | G1-01 | C | M7 | M |
| X-056 | G1-02 | C | M7 | M |
| X-057 | G1-03 | C | M7 | M |
| OBE-108 | G1-04 | C | M7 | S |
| X-058 | G1-05 | C | M7 | M |
| X-059 | G1-06 | C | M7 | S |
| OBE-109 | E2-01 | D | M7 | M |
| OBE-110 | E2-02 | D | M7 | M |
| OBE-111 | E2-03 | D | M7 | M |
| X-060 | E2-04 | D | M7 | S |
| OBE-112 | E2-05 | D | M7 | M |
| OBE-113 | E2-06 | D | M7 | M |
| OBE-114 | E2-07 | D | M7 | M |
| OBE-115 | E2-08 | D | M7 | L |
| OBE-116 | E2-09 | D | M7 | M |
| OBE-117 | E2-10 | D | M7 | M |
| OBE-118 | E2-11 | D | M7 | M |
| OBE-119 | E2-12 | D | M7 | L |
| OBE-120 | E2-13 | D | M7 | M |
| OBE-121 | E2-14 | D | M7 | S |
| OBE-122 | E2-15 | D | M7 | M |
| OBE-123 | E2-16 | D | M7 | M |
| OBE-124 | E3-01 | E | M7 | M |
| OBE-125 | E3-02 | E | M7 | M |
| OBE-126 | E3-03 | E | M7 | M |
| OBE-127 | E3-04 | E | M7 | M |
| OBE-128 | E3-05 | E | M7 | L |
| OBE-129 | E3-06 | E | M7 | M |
| OBE-130 | E3-07 | E | M7 | M |
| OBE-131 | E3-08 | E | M7 | S |
| OBE-132 | E3-09 | E | M7 | M |
| OBE-133 | E3-10 | E | M7 | L |
| OBE-134 | E3-11 | E | M7 | M |
| OBE-135 | E3-12 | E | M7 | L |
| OBE-136 | E3-13 | E | M7 | L |
| OBE-137 | E3-14 | E | M7 | L |
| OBE-138 | E3-15 | E | M7 | M |
| OBE-139 | E3-16 | E | M7 | M |
| OBE-140 | E3-17 | E | M7 | M |
| OBE-141 | E3-18 | E | M7 | M |
| OBE-142 | BM3-01 | E | M7 | M |
| OBE-143 | BM3-02 | E | M7 | M |
| OBE-144 | BM3-03 | E | M7 | M |
| OBE-145 | BM3-04 | E | M7 | M |
| PBE-078 | SP-01 | F | M7 | L |
| PBE-079 | SP-02 | F | M7 | M |
| X-061 | SP-03 | F | M7 | M |
| PBE-080 | SP-04 | F | M7 | M |
| PBE-081 | SP-05 | F | M7 | M |
| PBE-082 | SP-06 | F | M7 | M |
| OBE-146 | SP-07 | F | M7 | L |
| PBE-083 | SP-08 | F | M7 | M |
| PBE-084 | SP-09 | F | M7 | M |
| PBE-085 | SP-11 | F | M7 | M |
| PBE-086 | SP-12 | F | M7 | M |
| PFE-032 | SP-13 | F | M7 | L |
| PFE-033 | SP-14 | F | M7 | M |
| PAD-018 | SP-15 | F | M7 | M |
| PAD-019 | SP-16 | F | M7 | M |
| PBE-087 | SP-17 | F | M7 | L |
| PAD-020 | SP-19 | F | M7 | S |
| X-062 | SP-21 | F | M7 | M |
| OBE-147 | ED4-01 | F | M7 | M |
| X-075 | none (review) | F | M7 | L |
| PBE-105 | none (review) | F | M7 | M |
| PAD-025 | none (review) | F | M7 | S |
| OBE-148 | OS-03 | G | M7 | M |
| OBE-149 | OS-04 | G | M7 | M |
| OBE-150 | OS-05 | G | M7 | M |
| OBE-151 | OS-06 | G | M7 | M |
| OBE-152 | OS-07 | G | M7 | M |
| OBE-153 | OS-08 | G | M7 | L |
| OBE-154 | OS-09 | G | M7 | M |
| OBE-155 | OS-10 | G | M7 | M |
| OBE-156 | OS-11 | G | M7 | M |
| OFE-033 | OS-12 | G | M7 | M |
| OAD-025 | OS-14 | G | M7 | L |
| OBE-157 | OS-15 | G | M7 | M |
| OBE-158 | OS-16 | G | M7 | M |
| X-063 | OS-17 | G | M7 | M |
| SDK-021 | OS-18 | G | M7 | S |
| OAD-026 | RC-03 | G | M7 | S |
| OBE-159 | BM6-01 | H | M7 | M |
| OBE-160 | BM6-03 | H | M7 | L |
| OBE-161 | BM6-04 | H | M7 | M |
| OBE-162 | BM6-05 | H | M7 | L |
| OBE-163 | BM6-06 | H | M7 | M |
| OBE-164 | BM6-07 | H | M7 | M |
| OBE-165 | BM6-08 | H | M7 | M |
| OBE-166 | BM6-09 | H | M7 | M |
| OBE-167 | BM6-10 | H | M7 | M |
| OBE-168 | BM7-01 | I | M7 | M |
| X-064 | BM7-02 | I | M7 | L |
| OBE-169 | BM7-03 | I | M7 | L |
| OBE-170 | BM7-04 | I | M7 | M |
| OBE-171 | BM7-05 | I | M7 | L |
| OBE-172 | BM7-06 | I | M7 | L |
| OBE-173 | BM7-07 | I | M7 | L |
| OBE-174 | BM7-08 | I | M7 | M |
| OBE-175 | BM7-09 | I | M7 | M |
| OBE-176 | BM7-10 | I | M7 | M |
| OAD-027 | BM7-11 | I | M7 | M |
| OBE-177 | BM7-12 | I | M7 | M |
| OBE-178 | BM7-13 | I | M7 | M |
| OBE-179 | BM7-14 | I | M7 | M |
| OBE-180 | BM7-15 | I | M7 | L |
| OBE-181 | BM7-18 | I | M7 | L |
| OBE-182 | BM7-20 | I | M7 | M |
| OBE-183 | BM7-21 | I | M7 | L |
| OBE-184 | BM7-22 | I | M7 | M |
| X-065 | BM7-23 | I | M7 | M |
| OBE-185 | OS-19 | I | M7 | L |
| OBE-186 | OS-20 | I | M7 | M |
| OBE-187 | OS-21 | I | M7 | M |
| OBE-188 | OS-22 | I | M7 | S |
| X-066 | SP-18 | I | M7 | M |
| OBE-189 | E8-01 | J | M7 | M |
| PBE-088 | E8-03 | J | M7 | M |
| OBE-190 | E8-04 | J | M7 | M |
| OBE-191 | E8-05 | J | M7 | S |
| OBE-192 | E8-06 | J | M7 | L |
| OBE-193 | E8-07 | J | M7 | M |
| OBE-194 | E8-08 | J | M7 | M |
| PBE-089 | ED8-01 | J | M7 | L |
| PAD-021 | ED8-02 | J | M7 | L |
| PBE-090 | RC-04 | K | M7 | M |
| PBE-091 | RC-05 | K | M7 | L |
| X-067 | RC-06 | K | M7 | M |
| OBE-195 | RC-07 | K | M7 | L |
| PBE-092 | RC-08 | K | M7 | M |
| OBE-196 | RC-09 | K | M7 | L |
| PBE-093 | RC-10 | K | M7 | M |
| OBE-197 | RC-11 | K | M7 | L |
| OBE-198 | RC-12 | K | M7 | M |
| OBE-199 | RC-13 | K | M7 | M |
| OBE-200 | RC-14 | K | M7 | L |
| PBE-094 | RC-15 | K | M7 | L |
| PBE-095 | RC-16 | K | M7 | M |
| PBE-096 | RC-17 | K | M7 | M |
| PBE-097 | RC-18 | K | M7 | M |
| PBE-098 | RC-19 | K | M7 | M |
| PAD-022 | RC-20 | K | M7 | L |
| PAD-023 | RC-21 | K | M7 | L |
| PAD-024 | RC-22 | K | M7 | S |
| OAD-028 | RC-23 | K | M7 | M |
| PBE-099 | RC-24 | K | M7 | M |
| PBE-100 | RC-25 | K | M7 | S |
| X-068 | RC-26 | K | M7 | L |
| X-069 | G10-01 | L | M7 | M |
| X-070 | G10-02 | L | M7 | M |
| OBE-201 | G10-03 | L | M7 | M |
| X-071 | G10-04 | L | M7 | S |
| X-072 | G10-05 | L | M7 | M |
| OBE-202 | G10-06 | L | M7 | S |
| OBE-203 | G10-07 | L | M7 | M |
| PBE-101 | G10-08 | L | M7 | M |
| OBE-204 | G10-09 | L | M7 | S |
| OBE-205 | G10-10 | L | M7 | S |
| OBE-206 | G10-11 | L | M7 | M |
| X-073 | G10-12 | L | M7 | S |
| X-074 | RC-27 | L | M7 | S |
| PBE-102 | SP-10 | Z | M8 | L |
| PBE-103 | SP-20 | Z | M8 | M |
| OBE-207 | E8-02 | Z | M8 | M |
| OBE-208 | ED8-03 | Z | M8 | M |
| OAD-029 | ED8-04 | Z | M8 | M |
| OBE-209 | RC-28 | Z | M8 | L |
| OBE-210 | RC-29 | Z | M8 | L |
| OBE-211 | RC-30 | Z | M8 | M |
| OBE-212 | RC-31 | Z | M8 | M |
| OBE-213 | BM7-16 | Z | M8 | L |
| OBE-214 | BM7-17 | Z | M8 | M |
| PBE-104 | SP-11b | Z | M8 | S |
| PFE-034 | SP-14b | Z | M8 | M |
| OBE-215 | none (review) | Z | M8 | M |
| PBE-106 | none (review) | Z | M8 | S |
| OBE-216 | none (review) | Z | M8 | L |
| PBE-107 | none (review) | Z | M8 | M |

## Annex D: the lead's rulings for the task blocks

The lead wrote these rulings on 2026-11-25 for the task blocks of M7 and M8: G1 to G12 for every block, T for tests whose expected answer changes by design, and S1 to S18 for single points. A block that cites a code, such as "(the lead's ruling S5)" or "(G4)", follows that ruling; a block that cites "the lead's ruling" without a code states that ruling where it cites it. A ruling on how blocks are written is a working rule of this plan. A ruling that makes a design choice is the lead's proposal, "Proposed (lead)", and the owner's go for the wave that builds it accepts it ([ADR-0030](../adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 26, itself Proposed (lead)). A row that mixes both marks its Proposed parts. None of the rulings is a decision of the owner: the owner's decisions are ADR-0030 items 1 to 13 and 19 to 25. The rulings answer none of the owner's open questions. [Section 0.6](#06-still-open) lists (44a) what a daily limit of 0 means, (44b) whether the launch waits for PKFare's certification, (44c) whether the hooks are renamed, (44d) whether an OTA's own PKFare account also moves after the launch, (43d) counsel on Velexis's role, (43e) who staffs the reconciliation role, and the Stripe modes of (43c). ADR-0030's questions 6 to 9 and the questions of OADR-0019, OADR-0020, PADR-0020 and PADR-0021 stay open too (G6), and every Proposed item of these five records stays a proposal.

| Code | Ruling | Kind |
|---|---|---|
| G1 | X-054 lets `x-milestone` take `M7` and `M8`. Only a task that adds an operation, served or pending, to the OTA contract depends on it. A block that adds one and lacked X-054 gains it with a one-line Note, as OBE-197 and OBE-200 do. The platform contract has no `x-milestone`. So OBE-106, OBE-128, OBE-153, OBE-181 and OBE-187, which add no OTA operation, and PBE-080, PBE-081, PBE-082, PBE-085, PBE-093, PBE-099, PBE-102 and PBE-104 do not depend on X-054. | Working rule |
| G2 | No block is cut for length alone. A block stays under 520 words where it can. A block whose content needs more keeps it: OBE-106 under S12, and OBE-162, OBE-192 and PBE-089 under S14. | Working rule |
| G3 | Blocks cite the records of 2026-11-25 by their ADR-0030 item numbers: items 19 to 25 hold the owner's answers, and item 26, how the Proposed items are confirmed, is Proposed (lead). | Working rule |
| G4 | A block may list files of another component when that change must merge together with the block's own change. The block then carries a Note that names the other component and says why, and its Verify runs that component's tests too. For example, SDK-020 changes the OTA contract and the storefront's guide with the SDK, and OBE-151 changes the OTA admin's error predicate with the OTA backend. | Working rule |
| G5 | A block whose Files include a path under `.github/workflows/` carries the Note "Workflow file: the owner approves this change with the wave.", as X-055 and OBE-111 do. | Working rule |
| G6 | A block that rests on an open question for the owner names it in a Note with the lead's recommendation, in this form: "Rests on ADR-0030, question 8: staff Shopping goes with the other Amadeus screens. The wave proposal names it; the owner's go for the wave accepts it." The questions are ADR-0030 questions 1 to 13, the questions of OADR-0019, OADR-0020, PADR-0020 and PADR-0021, (43d), (43e) and (44a) to (44d). Two are harder gates with their own sentence: the daily limit, "the meaning of 0 is the owner's answer to (44a); this part does not start before it" (PBE-082, PAD-019, OBE-177, OBE-206); and counsel's wording (43d) on any text that tells an OTA or a traveller about suppliers (SDK-021, PBE-099, PBE-100). | Working rule |
| G7 | Blocks name the hooks "pre-action", "post-action" and "post-merge", the owner's words of 2026-11-24 (ADR-0030 item 13). No block uses "pre-request" or "post-response": whether the hooks are renamed is question (44c). | Working rule |
| G8 | No block tells an agent to delete, skip or weaken a test. When code moves, a test file may change its import paths, and its assertions stay. Ruling T covers a test whose expected answer changes by design. | Working rule |
| G9 | A block keeps "stop and ask the lead" only where these rulings leave a point open, where a human step comes first, or where the code may contradict the block. Everywhere else the block decides. | Working rule |
| G10 | Every block of M8 carries the Note "After the launch (ADR-0030 item 21): not started before the launch." No M7 block builds M8 scope: an OTA's own Amadeus account beside Velexis supply, an OTA's own PKFare account, `setSupplierSelection`, the PKFare credentials form or an OTA's own rules. M8 is the lead's reading of the later release of item 21 (section 0.2). | Working rule |
| G11 | A block that needs an outside or human step first starts with a step named "Gate" or "Human step", as the existing plans do. Such a step waits for PKFare's sandbox credentials, the saved PKFare reference (OBE-107), a recording run (OBE-209, OBE-210, OBE-214), Amadeus test credentials, counsel's text or the owner's numbers. | Working rule |
| G12 | The downloaded pages of PKFare's API reference are not committed, which settles A42. OBE-107's facts file cites a page's title, the date read and short facts in our own words, and `docs/pkfare-api/README.md` is only an index. Recorded fixtures are scrubbed: no personal data, no credentials and no card data (X-056, X-057). | Working rule |
| T | Phase B hides the Amadeus tools and phase G hides the supplier for an OTA on Velexis supply, but many integration tests and the golden files run on a tenant whose `credential_source` is `velexis`. Class 1: a test whose subject stays visible only with an own connection (the 15 tool operations, an `amadeus` member, office ids, the supplier log) moves to the own-connection tenant of X-055 with its assertions unchanged. Class 2: a booking-flow test stays on the Velexis tenant and changes only the expected values of supplier-visible members that the contract change makes neutral, each listed in the pull request with the contract line it follows; a golden file is re-recorded only for those members, with the diff in the pull request. Class 3: new behaviour (a refusal, a neutral shape, a supply id) gets a new test on the Velexis tenant. No assertion is deleted, and a success assertion is never replaced by a refusal: the success case runs on the own-connection tenant, and the refusal is a new case (OBE-106, OBE-149 to OBE-152, OBE-154, OBE-156, OBE-185, OBE-198, OBE-216, X-075). | Working rule |
| S1 | One rule holds for the new `supplier` columns of `flight_offers`, `priced_offers` and `bookings` (OBE-113, OBE-125, OBE-147). Each is added NOT NULL with `DEFAULT 'amadeus'`, an expand step that rewrites no row. No CHECK lists the suppliers, because the registry refuses an unknown supplier and the fake source and the "unknown source" cases of phase E must be storable. Every new insert names the supplier itself. A contract step drops the default at least one release after those inserts (S2). | Proposed (lead) |
| S2 | A contract step ships at least one release after its expand step ([conventions](../conventions.md#9-database-migrations) §9), and a dependency alone does not make a later release. The contract steps of M7's new columns also wait for a human check that OBE-147's batched job reports no unmapped row in any environment, and the launch does not need them, because every new insert sets the values. So they move to M8, the release after the launch, in two tasks (Proposed (lead)). OBE-215 makes `supply_id` NOT NULL on `flight_offers`, `priced_offers` and `bookings`, drops the `DEFAULT 'amadeus'` of S1 and removes the fallback of `hasSupplierOrder` to `amadeus_order_id`. PBE-106 makes the connection's supply source NOT NULL on `supplier_connections` once X-075 has moved every insert of a connection to its builders. OBE-147 and OBE-148 carry none of these steps, and their Notes point to OBE-215 and PBE-106. Until then a row without `supply_id` answers without the member, and nothing is guessed. | Working rule; parts Proposed (lead) |
| S3 | A block that adds a tenant or platform migration lists in Files and Verify the tests that pin the migration lists: `pnpm --filter @velexis/db test`, `pnpm --filter @velexis/db test:int`, `pnpm --filter @velexis/testing test:int` (the test database), and the `migration-0002`, provisioning and dev-seed tests, as OBE-113, OBE-125, OBE-145 and OBE-149 do. Every other block with a migration follows it, those of M8 included (OBE-207, OBE-213, OBE-215, PBE-102, PBE-104, PBE-106, PBE-107). | Working rule |
| S4 | Each entry of X-060's list of business files that still import an adapter names the task that removes it. OBE-138 removes the four tool files, OBE-106's `amadeus-tools.guard.ts` and `staff-auth.service.ts`. OBE-141 removes the Nest modules, `cli.ts` and the re-exports that OBE-127, OBE-128, OBE-132 and OBE-135 keep (`order-recorder.ts`, `order-request.builder.ts`, `reconcile.service.ts`). If one of these tasks merges before X-060, its entry is on X-060's list at X-060's merge base. OBE-141 deletes the list. | Working rule |
| S5 | A block lists in Depends on every task whose product it uses, even when another dependency already reaches it. Nothing is trimmed. Each added producer gets a one-line Note, such as "X-064 is added as a producer (the lead's ruling S5)". | Working rule |
| S6 | PKFare's hosts mirror today's Amadeus configuration, and nothing more. In the OTA backend: the optional overrides `PKFARE_BASE_URL_TEST` and `PKFARE_BASE_URL_LIVE` (the fake in development and CI, empty in the deploy template), then the `host` of the source's supplier account (PBE-079), then one named constant `PKFARE_OFFICIAL_BASE_URLS` under `ota/backend/src/supply/`; with `APP_ENV=production` only the official hosts pass the host guard. OBE-146 owns the guard and this order, and OBE-159, the first OTA task that calls PKFare, adds the variables to `.env.example`, `deploy/env/ota-backend.env.example` and the configuration matrix. In the platform backend: the supplier account's `host` column, checked in production against one named constant of PKFare's official hosts in `platform/backend/src/config.ts`, beside the Amadeus ones (PBE-084), and a dev-seed variable for the fake's host, named after the Amadeus one, only if a task seeds a PKFare account. X-071 proves both constants and adds no variable; X-073 adds PKFare's production host to both. | Proposed (lead) |
| S7 | `deploy/scripts/test/check-vm.test.sh` reads the official Amadeus hosts from `ota/backend/src/amadeus/connection-resolver.ts` and silently skips a missing file. OBE-111 moves that file, so it lists the test with a G4 Note, points the loop at the moved file and makes the loop fail on a missing file: a silent skip is a weakened test (G8). Its Verify runs `shellcheck -S style` on the test, and the test itself where root is available. X-071's list test builds on this. | Working rule |
| S8 | The daily limit per OTA is a column of `platform.tenants` (PBE-082), which the OTA backend's read role already reads; a change publishes the `tenant` event. OBE-177 reads it with the cached tenant row (`tenant:<id>`, dropped by that event) and counts as PBE-082 proposes. The limit is an amount in minor units of the currency of Velexis's PKFare wallet, and the day is the UTC calendar day. The amount counted is the sum of the expected debits of the orders whose payment was requested that day for that OTA; OBE-165 prices each debit in that currency. The default 0, set in the platform admin's OTA management, is the owner's (ADR-0030 item 23), and the (44a) gate stays. | Proposed (lead) |
| S9 | These are small proposals, each "Proposed (lead); confirm in the pull request". X-061 gives the id prefixes `ssr_` to supply sources (PBE-078) and `sac_` to Velexis supplier accounts (PBE-079). PFE-032 step 6 makes the API key scope labels and the public portal texts that name Amadeus neutral and keeps the scope names `amadeus:read` and `amadeus:write`, with no need for counsel's wording (43d), because neutral text says nothing about suppliers. The PKFare bookings of OBE-201's load run pay through a loopback fake Stripe wired from the run's own preload, and OBE-201 stops if a change under `src/` would be needed. PBE-102 (M8) recommends in its Note a milestone switch for an OTA's own PKFare credentials, as `FEATURE_OWN_AMADEUS` is for Amadeus ([PADR-0015](../../../platform/docs/adr/0015-milestone-feature-switches.md)), and if PBE-102 adds it, PFE-034 shows its entry only while that switch is on. OBE-213 (M8) reuses the deferred `getBookingAncillaries` and `addBookingAncillaries` only if their schemas take OBE-185's neutral extras without a breaking change, and otherwise adds a new additive operation. | Proposed (lead) |
| S10 | The lead added seven tasks without a plan key for work that no block carried, three in M7, phase F, and four in M8. PBE-105 is a platform admin operation, contract first, with an audit row and the `connection` event, with which staff set the ticketing defaults and monitored queues of an OTA's Velexis Amadeus connection (A25), because PFE-032 step 1 stops the portal's `updateAmadeusConnection` from editing them. PAD-025 is its form on the platform admin's tenant page. X-075 makes the shared test helpers and seeds write connections and Velexis Amadeus accounts with their supply source (S14). In M8, OBE-215 and PBE-106 are the contract steps of S2. With OBE-216 the OTA backend serves an OTA's own Amadeus connection beside Velexis's: the connection resolver, its cache key `conn:amadeus:<tenantId>:<env>` and the tools class pick the connection of the offer's or booking's supply source. With PBE-107 the platform counts the open "paid and not ticketed" cases per supply source and stops the source through PBE-081 at the cap K (S15). OBE-151 grows from S to M (S14). PFE-032 depends on PBE-105, OBE-146 on X-075 and PBE-103 on OBE-216. M7 then has 169 tasks and 776 agent-hours, and M8 17 tasks and 84 agent-hours. The designs of PBE-105, OBE-216 and PBE-107 are Proposed (lead) (S16). | Working rule; parts Proposed (lead) |
| S11 | Before the launch, X-072's operations pack holds a manual routine for PKFare's own e-mails and schedule changes (section 4.7, last row; section 9.6, item 4; A35): who reads the Velexis mailbox that receives them, how a schedule change or another PKFare notice becomes a case of OBE-198, and that staff pass it on to the OTA in neutral words (Proposed (lead)). OBE-198's Note points to it. Row A1 of the OTA launch checklist (X-073 proposed as a named exception, which is question (44b), and the M8 tasks after the launch) changes in the lead's re-baseline, not in a block, as X-074 says. The guidebook item of the definition of done in AGENTS.md applies to every M7 and M8 task; as plan-lint accepts no `guidebook/` path in Files, no block lists one, and the introduction of the M7 sections says so once (S13). | Working rule; parts Proposed (lead) |
| S12 | No CHECK lists the suppliers on any `supplier` column (`flight_offers`, `priced_offers`, `flight_search_sources`, `bookings`), so that the fake source and the "unknown source" cases stay storable and a third supplier needs no migration (Proposed (lead)). The registry refuses an unknown supplier, and OBE-113, OBE-125 and OBE-147 follow S1 and S2. A hook that fails on a servicing action logs one error event `supply.hook_failed` with the hook, the action and the source and no payload, and the event reaches Velexis staff, never `StaffAlerts`, which reach OTA staff and would reveal Velexis's rules (OBE-114, OBE-194, OBE-203; Proposed (lead)). X-072's alert inventory names its receiver and runbook, and its drill raises it. OBE-162 is the first task that writes pricing snapshot version 2: its first step gives every new priced offer a version 2 snapshot, it ships a release after OBE-119's reader, and OBE-109's golden priced-offer rows are re-recorded for the snapshot's version and key alone, with the diff in the pull request. OBE-160 makes the readers that assume an Amadeus column, such as `SearchesService.searchResponse`, `OffersRepository.searchOfferIds` and `SearchesRepository.offerSummaries`, handle a search or an offer without one, and its acceptance gains a search served by PKFare alone. Phase B leaves the PNR lookup `console.bookings.findByRecordLocator` served, as it is not one of the 15 tool operations, while OAD-024 hides its screen; S14 sets its answer in phase G (Proposed (lead)). X-055 keeps size M, and its step 4 (the smoke stack) moves into OBE-106 if its pull request outgrows M. Its helper switches the connection to `tenant` only for the fixture import of `review-closure.int.test.ts`. OBE-106 keeps its length (G2). Its four deferred raw writes answer `403` before their `501`, the gate resolving the caller's tenant itself on their pending routes, while a request without a console credential keeps its `501` (ADR-0030 item 18, Proposed (lead)). Four waiting notes of ADR-0030 get an owner, each a dated note in that task's pull request: ADR-0006 on the new meanings of item 17 (OBE-153), ADR-0004 on the id format of item 15 (PBE-080), ADR-0011 on the capture before the ticketing request and Stripe only for other suppliers (OBE-172), and ADR-0012 Lifecycle item 2 on going live with any active supply source (PBE-086). | Working rule; parts Proposed (lead) |
| S13 | CI's guidebook test checks every repository path that the guidebook cites. So a block that moves, deletes or renames a file, a symbol, a table, an endpoint or a term that `guidebook/content` cites names the guidebook update in a step, says in a Note that plan-lint cannot list `guidebook/` in Files, and runs `node --test guidebook/tools/guidebook.test.mjs` in Verify, as OBE-111, OBE-138 and PBE-086 do. S11 covers every other block. | Working rule |
| S14 | Phase G closes the PNR lookup, revising S12. OBE-149 refuses `console.bookings.findByRecordLocator`, which returns the Amadeus order verbatim, with `403 FEATURE_DISABLED` for an OTA without its own active Amadeus connection, and OBE-152 answers `console.bookings.retrieve` with `409 BOOKING_NOT_MODIFIABLE` for a Velexis-supplied booking, both contract first (section 4.7; Proposed (lead)). OBE-106's Note says so, and neither is a question for the owner. X-075 makes the shared test helpers and the seeds write each connection and Velexis Amadeus account with its supply source, and moves the tests' inline inserts of those rows to the helpers, setup only (G8). PBE-078 adds the connection's source column nullable, fills the existing rows and sets it in the repository. OBE-146 depends on X-075, so that its resolver can rely on every connection having its source, and PBE-106 (M8) adds the NOT NULL (S2). PBE-079 adds a non-secret currency column, the wallet's currency, to `supplier_accounts`, grants it to the OTA role and covers it in `baselines.int.test.ts` (Proposed (lead)). OBE-146 returns it, OBE-165 prices the expected debit in it and OBE-177 counts the daily limit in it (S8). Blocks of the platform admin verify with `pnpm --filter @velexis/platform-admin test accounts`, as PBE-089 does. Today's extras lists of a Velexis Amadeus source keep their `amadeus` mapping until OBE-185's neutral `extras` exists and the storefront reads it. OBE-185 then empties them, decided by source through OBE-148's helper, and until it merges, OBE-157 and OBE-158 carry a by-path allowance that names OBE-185. OBE-198 gives neutral wording and Velexis-support guidance to the staff alerts that name Amadeus or its offices for a Velexis-supplied booking. OBE-151 answers the `404` of `closeReview` for a missing order with the neutral `details.reason` `order_not_found` (Proposed (lead)), contract first and read by the OTA admin's predicate (G4), and grows to size M. OBE-143 keeps the sentence "Our team will issue your e-tickets", which `booking-orchestrator.service.test.ts` pins, and whichever of OBE-143 and OBE-156 merges later keeps both changes of `ticketingMessageOf`. The contract annex that X-051 adds to ADR-0030 words the new meanings of `netPrice` and `recordLocator` and the minor-version rule so that OBE-152, OBE-154 and SDK-021 can quote them. Rows stored before phase G keep their supplier details and no read-time filter is built, because before the launch only test tenants hold such rows, as OBE-154's Note states (Proposed (lead)). An upsell runs the pre-action and post-action hooks of the Price row and fails closed when a hook fails, as Price does (Proposed (lead)). OBE-121 registers no handler, OBE-192's price-rule handler runs at post-action of Upsell, and OBE-192's pull request adds a dated note on it to OADR-0019. A Velexis rule of PBE-089 carries an environment column and keeps its sources as `supply_sources` rows, and the API takes and answers current supply ids (PBE-088, PAD-021, OBE-208; Proposed (lead)). OBE-162's Price outcomes use only the errors that `flights.price` lists today, with no contract change before the launch (Proposed (lead)). OBE-162, OBE-192 and PBE-089 keep their direct producers (S5) and their length (G2). | Working rule; parts Proposed (lead) |
| S15 | OBE-177 counts the cap K inside the tenant for the first release, and PBE-107 (M8) counts it per supply source on the platform (Proposed (lead)). The (44a) gate stays on OBE-177's limit step only: the lead asks the owner (44a) when OBE-177's wave is proposed, and splits that step into its own task only if the answer has not come when the rest is ready. The routing part of our reference, which PKFare echoes back, is the tenant id, so it survives a Redis restart and names no OTA, and OBE-182 stops if the reference field cannot hold it (Proposed (lead)). OBE-182's firewall rules are a security choice, Proposed (lead): its notification route keeps the blocking rules with only the narrow exclusions by rule id that X-057's recorded notifications need, each with its reason in `deploy/caddy/waf/exclusions.conf`. `deploy/caddy/test/caddy-smoke.sh` checks that a recorded notification passes while a request with an attack pattern is still refused. The route never trusts the body and only starts the read of the order. PBE-087 adds `M7` to the platform's `ScheduleDefinition.milestone` type, and whichever of OBE-173 and OBE-175 adds the first M7 schedule to `OTA_SCHEDULES` adds `M7` to the OTA's type. OBE-168 adds the one function of `supplier-orders.repository.ts` that sets the open-case mark, and OBE-171, OBE-172, OBE-173 and OBE-175 call it and never write its columns. OBE-198 inserts the case row in that function, in the same transaction (`booking_cases`, Proposed (lead)); it later moves OBE-176's `consoleListOpenCases` to the case table and adds the case kinds of section 4.12. X-066 reuses PBE-081's stop function if it fits, or else adds the platform admin's `audit-filters.ts` with a G4 Note and runs `pnpm --filter @velexis/platform-admin test accounts`. PBE-094 keeps the per-kind deadlines of A39, "the owner's hours", as named constants until the owner sets them, and the cover hours stay with (43e). PBE-097 keeps its JSON limit of 100 kb unless X-057's statement sample is larger, and then stops and asks before one larger limit for that route. PBE-091 writes a role holder's audit rows with the actor type `account`. X-067 takes the order from the booking's ledger row. PAD-024 lands a role holder on a page that says the area is not built yet, until PAD-022 or PAD-023 adds an entry. Explicit dependencies stay (S5). Before the launch the stored disclosure answer of PBE-099 reaches the OTA by hand, so X-068's runbook "disclosure request" gains the step "send the stored answer to the OTA once counsel's wording (43d) allows it" (X-052, PBE-100). Tasks that add migrations take the next free number, and the wave integrator renumbers the later one at merge, with the tests that list the migrations. | Working rule; parts Proposed (lead) |
| S16 | The changed meanings of part 3 of the contract annex that X-051 adds to ADR-0030 ship in the minor SDK version 1.1.0 (SDK-021, OBE-153; Proposed (lead), and the wave proposal confirms it). Today's extras lists, which OBE-185 empties for a Velexis source, join part 3 as a changed meaning under ADR-0030 item 17, and OBE-185 ships it (OBE-150; Proposed (lead)). The test of X-060's list accepts exactly two later entries, `order-recorder.ts` from OBE-127 and `order-request.builder.ts` from OBE-128, each removed by OBE-141, and fails on any other. `flight_search_sources.supply_id` stays nullable, and OBE-215 does not touch it (OBE-113, OBE-147). A block that only shifts lines that the PCI pack cites adds no step, because the wave integrator runs `node tools/ci/fix-pci-refs.mjs` and `node tools/ci/check-pci-refs.mjs` after the merges and OBE-202 checks the whole pack. OBE-127 and OBE-128, whose cited code leaves its file, re-place their references by hand. PBE-078 keeps `DEFAULT 'amadeus'` on `supplier_connections.provider` so that inline inserts keep working, and PBE-106 (M8) drops it with the source NOT NULL once X-075 makes every insert name the provider. OBE-172 keeps its dependency on OBE-171 until OBE-107's facts are written, and the lead drops it before the wave if PKFare allows a second OrderPricing. Every completion refusal that the traveller did not cause uses OBE-144's one neutral `details.reason`, so that no answer tells a stop, a cap, a limit or a policy apart (OBE-177; Proposed (lead)). For a Velexis-supplied Amadeus booking, reconcile's manual-review path at its deadline also opens the case "order unknown" through OBE-198's case repository, and the not-found path keeps its failure, its void and its neutral alert. Before the launch a failing hook shows in the log review's daily count and in the `journalctl` query of X-072's runbook. If X-072's drill shows that this is not enough, the lead proposes a small foundation task for a summary row or an immediate alert in `deploy/scripts/log-review.sh`. X-071 step 4 extends the firewall check of `check-vm.sh` to `PKFARE_BASE_URL_*`, as today's Amadeus check does. X-075 also depends on X-055, keeps PBE-080 and recounts its counts at its base commit. OBE-215 keeps size M, and the lead resizes it only if one builder helper cannot make each test change a single line. PBE-088 grants the OTA role's `SELECT` on the rules table in its own pull request, with its only reader (Annex B row E8-03; ADR-0004: the role gets only the tables it reads), and the wave proposal confirms it (Proposed (lead)). OBE-159 keeps size M. If its pull request outgrows M, the expand migration of `supplier_requests` and the provider filter on its readers move into a task of their own that OBE-159 depends on. The lead accepts the proposals of PBE-105, OBE-216 and PBE-107 as written, each "Proposed (lead); confirm in the pull request", and K is 3 (A32) until the owner sets it with the other values of section 8. | Working rule; parts Proposed (lead) |
| S17 | PBE-102 (M8) depends on PBE-084 and PBE-085 as producers, and not on X-073, which may stay open at the launch (question (44b)). PKFare's production host joins PBE-084's constant when X-073 merges; until then an OTA's own PKFare account is verified against the test host only, so M8 does not wait on PKFare's certification (Proposed (lead)). PBE-102 also writes the PADR-0010 note, with its Files, and the API inventory row of its operation. OBE-150 re-records only OBE-109's golden files, because OBE-124's golden files hold requests and call-log rows and no answer member, and its Verify keeps `golden-booking` to show that the booking requests did not change. So OBE-150 lists OBE-109, OBE-123 and OBE-124; OBE-148 and OBE-162 add OBE-123; and OBE-148, which also re-records `supplyId`, adds OBE-109. OBE-176 and X-066 gain no dependency on each other: whichever merges later keeps both messages in one `supply-events.ts`, one producer module and both dispatch branches, and X-066 registers and exports its schema as OBE-176 does. PBE-099's page "Disclosures" goes in PAD-018's section "Suppliers" of the platform admin's menu, never in "Reconciliation", so PBE-099 depends on PAD-018. Whichever of PBE-099 and PAD-022 to PAD-024 merges later keeps every entry of `admin-shell.tsx` and `components.test.tsx`. The support handoff key of PBE-093 and OBE-196 is `support:handoff:<sha256 hex of the token>` (Proposed (lead)). Both list `docs/mvp/architecture.md`; the first to merge writes the key's row in "Redis keys shared between the backends" (architecture §4), and the other checks that it is there. PBE-086 owns the one function "a supply source sells in an environment", which PBE-085 depends on and uses, so that the onboarding checklist and the Suppliers page never disagree. Every added dependency gets its one-line Note (S5), and none may close a cycle: an edge that closes one is undone. | Working rule; parts Proposed (lead) |
| S18 | While the case "order unknown" is open for a Velexis-supplied booking, the reconciliation role decides alone (section 4.10, A33). OBE-198 makes `consoleCloseBookingReview` refuse with one neutral `details.reason` and `canCloseReview` false, contract first (Proposed (lead)). Its integration test shows the refusal while the case is open and the old behaviour once it is closed, and any words the OTA admin needs for the refusal merge with it (G4). When the role records an order number for an Amadeus source, OBE-200's engine records the found order through `recordFoundOrder` and confirms the booking, as reconcile does today. It releases the order and fails the booking only where the source cannot record an order (PKFare, until A33 is confirmed), and "No order" fails the booking and voids the payment hold for every source. This outcome is Proposed (lead), and the lead confirms it when OBE-200's wave is proposed. Every test written after X-075 writes the platform's supplier rows (connections and supply sources) only through X-075's builders. PBE-106's grep stays a check: if it finds an inline insert, PBE-106 stops and reports it, and the lead adds that file to PBE-106's Files with a dated note, because a task touches only its Files. OBE-133 and OBE-137 both change `recordIssuedTickets` and gain no dependency on each other: whichever merges first changes the signature and converts the other caller through OBE-127's adapter step. OBE-170 to OBE-174 and OBE-177 to OBE-181 depend on X-064, whose scripted PKFare fake their integration tests use, and OBE-176 depends on OBE-110 for its fake own source, each with its one-line Note (S5). | Working rule; parts Proposed (lead) |
