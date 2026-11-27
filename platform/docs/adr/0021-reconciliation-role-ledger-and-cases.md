# PADR-0021: Reconciliation role, ledger and cases

**Status:** Proposed
**Date:** 2026-11-25
**Deciders:** Product owner (items 1 to 3: decisions of 2026-11-24; item 12: decision of 2026-11-25), lead architect (items 4 to 11: proposals, not confirmed; 2026-11-27: items 10 and 11 accepted with the owner's go for wave 71)

**What is in force.** The status is `Proposed`: [ADR-0001](../../../docs/mvp/adr/0001-record-architecture-decisions.md) (items 6 and 7) and this folder's [README](README.md) allow no other before the developer merges a record. The **Decided** items are the owner's decisions of 2026-11-24 (items 1 to 3) and of 2026-11-25 (item 12), in force through [`decisions.md`](../../../docs/mvp/decisions.md). The **Proposed** items are the lead's proposals, not in force until the owner confirms them. 2026-11-27: the owner's go for wave 71 accepted items 10 and 11 (the dated note under each).

## Context

Velexis staff cannot see tenant bookings today ([PADR-0006](0006-platform-admin-access-and-audit.md) item 8). Once Velexis supplies a ticket and pays PKFare for it ([PADR-0020](0020-supplier-registry-switches-and-suppliers-page.md) item 6), somebody at Velexis must answer the supplier and get the cost back from the OTA.

[ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) lists the owner's thirteen decisions of 2026-11-24; this record details rows 7, 8 and 9. The design is in the [multi-supplier plan](../../../docs/mvp/plans/multi-supplier-plan.md) (4.12 to 4.14), a proposal: "A7" and "plan 4.13" below are its assumptions and sections.

## Decision

1. **Decided (owner, 2026-11-24).** **The ticket cost is recovered offline** (row 7). "I will do it offline. I would reconcile with OTA later." The lead reads "offline" as: the monthly statements of [PADR-0003](0003-settlement-of-velexis-collected-payments.md) get no line for this cost (plan 4.13).
2. **Decided (owner, 2026-11-24).** **A reconciliation role** (row 8). "I would make another role for reconciliation which would get reference to OTA bookings." This changes one sentence of PADR-0006 item 8: "Supporting an OTA's bookings means being invited as a member like anyone else, which is then visible to the OTA in its team list." The item's first sentence stays: admin endpoints never touch tenant schemas.
3. **Decided (owner, 2026-11-24).** **An id in the search; the supplier on request** (row 9). "The search would contain some form of ID. If need be, they can ask for supplier, but they do not need to know. They should focus on marketing and selling tickets." 2026-11-26: counsel, as relayed by the owner, says that "on request" is sufficient if the OTA uses Velexis supply (question 1).
4. **Proposed (lead).** **The role's limits** (A7, A37; plan 4.13). The role is separate from "platform admin"; a platform admin grants it. It sees bookings that Velexis supplies, never a booking on an OTA's own supplier account. It works the ledger and the cases and opens one booking at a time, with a reason. Each action is audited, and the OTA sees it in its audit list. The role never changes switches, credentials or settlements.
5. **Proposed (lead).** **Three channels** (A7, A36; plan 4.13). They keep both ownership rules: the platform never touches tenant schemas, and the OTA backend never writes platform tables. Facts (ids, status, amounts, dates; never a name, contact or document) reach the platform on the existing queue, and never for a booking on an OTA's own account. Platform tables hold the ledger and the cases. Booking details and case actions go through an audited support interface of the OTA backend, called by the platform admin's server; it never returns a document number, a contact or a card detail.
6. **Proposed (lead).** **The ledger** (A38). One row per supplier order: supply id, order number, the OTA's cost price, expected and reported debit, reimbursements. No traveller data. Velexis-supplied Amadeus bookings get rows and cases too.
7. **Proposed (lead).** **What the system does for the offline reconciliation** (A6; plan 4.13). An audited export per period and OTA, and a daily job that compares the wallet readings with the ledger.
8. **Proposed (lead).** **Cases** (A8, A39; plan 4.12). A case is one supplier-side question on one booking, with a deadline that the owner sets. OTA staff talk to the traveller and move the traveller's money; the role talks to the supplier. No refund request goes to the supplier before the OTA confirmed the quote. No console refund runs while a case is open. The role's interface has no capture, refund or void.
9. **Proposed (lead).** **Alerts** (plan 4.13). Alerts to OTA staff use neutral words; the role gets the supplier detail. A debit difference raises an alert at once, and in the first live weeks staff stop the source until it is explained.
10. **Proposed (lead).** **Disclosure on request** (plan 4.14). An OTA owner or admin asks on the Suppliers page. A platform admin answers within three working days (A39), from the id history, with the supplier's legal name, country and privacy contact at that date. The answer is stored and audited. 2026-11-26: counsel's answer as relayed (question 1) says that "on request" is sufficient with Velexis supply. It does not address this procedure: who asks, the three working days, or what the answer holds. So the procedure's details stay proposed ([ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) question 19). 2026-11-27: accepted with the owner's go for wave 71 ("start working on wave 71"), under ADR-0030 item 26; built by X-052, whose pack drafts the procedure for counsel. Whether "on request" also covers it stays ADR-0030 question 19.
11. **Proposed (lead).** **The counsel gate** (plan 4.14). No supplier is hidden in live use before counsel answers question 1 below. 2026-11-26: as the lead reads it, the condition of this gate is met for Velexis supply: counsel answered question 1, as relayed by the owner, although the relayed words do not name Velexis's own role (question 1; ADR-0030 question 19). The item itself stays proposed. Counsel's texts for an OTA or a traveller are other gates (ADR-0030 question 19). 2026-11-27: accepted with the owner's go for wave 71 ("start working on wave 71"), under ADR-0030 item 26; built by X-052. The gate stays as recorded above: counsel's texts still gate the tasks that ADR-0030 question 19 names.
12. **Decided (owner, 2026-11-25).** **The reconciliation process ready at launch** ([ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 22). "I want to launch with the reconciliation process ready from the platform." The lead reads this as: the reconciliation work of the plan's phase P9 (the role, the ledger, the facts, the support interface, the cases, the export, the daily check, the statement, the alerts, both admin areas and disclosure) is in milestone M7 and part of launch readiness, with task X-074, the live gate for after-sales.

## Revisions to other records

A dated note of 2026-11-25 under PADR-0006 item 8 points here. It rests on item 2.

## Notes that wait for a decision

They would rest on proposals; nobody writes them yet.

- PADR-0006, the follow-up on admin sub-roles: item 4 (A37).
- ADR-0003 (the front-end rule; items 2 and 5) and ADR-0009 item 3: item 5.
- OADR-0009 and OADR-0011: the caller kind and the staff actor of the support interface (item 5).

## Consequences

### Positive

- Supplier-side work has one named role. With item 8, the OTA keeps the traveller and the traveller's money.

### Negative

- Offline recovery is credit given by Velexis (plan 9.4).

### Follow-ups

- The owner confirms or changes items 4 to 11 and answers the questions below. The developer then sets the status. 2026-11-26: question 1 is answered by counsel, as relayed by the owner; ADR-0030 questions 19 and 20 follow from it. The pack of X-052 keeps those follow-up questions and its drafts for counsel to approve (the dated note of 2026-11-26 in its block, Proposed (lead)). 2026-11-27: the owner's go for wave 71 accepted items 10 and 11 (X-052); items 4 to 9 stay proposed.
- The owner's steps of plan §8: the offline routine and the case deadlines.
- OTA group: a fact outbox, the support interface and the case states, once confirmed.

## Alternatives considered

- **Staff invited as members of each OTA** (PADR-0006 item 8 today). The owner decided on a role.
- **The platform reads the tenant's booking tables.** It never touches tenant schemas; item 5 keeps that rule.

## References

- [`decisions.md`](../../../docs/mvp/decisions.md) §1 and §2; [multi-supplier plan](../../../docs/mvp/plans/multi-supplier-plan.md)
- [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md), [PADR-0020](0020-supplier-registry-switches-and-suppliers-page.md), [OADR-0020](../../../ota/docs/adr/0020-suppliers-paid-from-a-balance.md)

## Open questions for the owner

Each recommendation is the lead's proposal, not a decision.

1. **Counsel on Velexis's role** (plan 4.14; 9.6 item 6). Is Velexis a processor for each OTA, or a controller of its own? If a processor, "on request" (item 3) may not be enough, and the owner then decides again. The lead's recommendation: no supplier hidden in live use before the answer. 2026-11-25: the owner asked the lead to explain this question; it is still open. As the lead reads [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 19, the supplier is hidden in live use from the launch on, so by item 11, the lead's proposal, the answer is now needed before the launch. 2026-11-26: answered by counsel, as relayed by the owner: "The counsel answered. "On request" is sufficient if OTA uses Velexis supply. They can switch to controller role and control it themselves if they use their own credentials. It's a role transition." The lead reads this as: for Velexis supply, disclosure on request is sufficient, so the branch "If a processor, "on request" (item 3) may not be enough, and the owner then decides again" does not apply; an OTA that uses its own credentials takes the controller role ("a role transition"), which first happens in M8, after the launch. The relayed words do not say when counsel answered or where the written answer is kept. They do not say which role Velexis has under Velexis supply, and they give none of the texts that still gate tasks. ADR-0030 questions 19 and 20 ask about these points.
2. **Who staffs the role** (plan §8). To name: a holder, a stand-in and cover hours. The lead's recommendation: named before the live co-test of P10 (plan §6). 2026-11-25: the owner asked the lead to explain this question; it is still open. As the lead reads item 12, the role needs its holder, stand-in and cover hours before the launch: task X-074, the live gate for after-sales, asks for a named holder and a stand-in.
3. **Who works an OTA's queues between hiding the supplier (P5) and the role's tools (P9)** (plan 9.3). Options: hide the Amadeus tools in production only once the role's booking view is merged; or move the role's first tools before P5. The lead's recommendation: none in the plan. Answered on 2026-11-25 (ADR-0030 items 21 and 22).
