# OADR-0020: Suppliers paid from a balance, extras and low-cost content

**Status:** Proposed
**Date:** 2026-11-25
**Deciders:** Product owner (items 1 to 3: decisions of 2026-11-24), lead architect (items 4 to 13: proposals, not confirmed)

**What is in force.** The status is `Proposed`: [ADR-0001](../../../docs/mvp/adr/0001-record-architecture-decisions.md) (items 6 and 7) and this folder's [README](README.md) allow no other before the developer merges a record. The **Decided** items are the owner's decisions of 2026-11-24, in force through [`decisions.md`](../../../docs/mvp/decisions.md). The **Proposed** items are the lead's proposals, not in force until the owner confirms them.

## Context

PKFare tickets after the booking and is paid from a prepaid balance, its wallet. Velexis pays from that wallet while the traveller pays by card, so the order of the money steps decides who carries a loss. The design is in the proposed [multi-supplier plan](../../../docs/mvp/plans/multi-supplier-plan.md), sections 4.9 to 4.12. "A1" to "A43" are its assumptions, a "row" is a row of its section 2, and a "rule" is a money rule of its section 4.10.

**PKFare facts not yet confirmed are assumptions.** PKFare's saved reference states none of these (plan 9.2): how long an unpaid order lives (the hold); whether an order can be priced twice; whether an unpaid order is ever debited; whether an order can be found by our own reference; which field marks low-cost content; whether such orders get ticket numbers. An item that rests on one of them is an assumption until PKFare confirms it.

## Decision

1. **Decided (owner, 2026-11-24).** **Velexis's PKFare wallet pays the tickets of Velexis-supplied PKFare bookings** (row 5). "OTAs pay through the Velexis PKFare wallet. OTAs don't have to worry about it."
2. **Decided (owner, 2026-11-24).** **The cost is recovered offline** (row 7). "I will do it offline. I would reconcile with OTA later."
3. **Decided (owner, 2026-11-24).** **Extras and low-cost content are in the first release** (row 12). "the extras and low-cost should be in the first release."
4. **Proposed (lead).** **Capture before the ticketing request** (A6; plan 4.9). The traveller's payment is captured in full before the supplier is asked to ticket. A source other than Amadeus takes Stripe only.
5. **Proposed (lead).** **Write-aheads and single requests** (rules 1, 2 and 5; A31). A write-ahead is a marker committed before a request leaves. A price reference is never used twice. No second order request and no second ticketing request is sent, also after a lost answer or a restart.
6. **Proposed (lead).** **The checks** (rules 3 and 5). Check payable allows a capture only when the order was just priced, its hold is open, the amount is within the expected debit and the wallet covers it. Ticketing needs a full capture and a payable order. The reported debit is compared with the expected one.
7. **Proposed (lead).** **The deadlines** (rule 4; A32). The capture deadline is the earlier of the hold end and the order pricing plus 30 minutes, less a margin. The owner sets N, K and H (proposed: 30 minutes, 3 cases, 24 hours).
8. **Proposed (lead).** **Polling and final states** (rule 6). Polling never stops before a final status, except at the emergency stop (plan 4.4). No booking is `ticketed` without ticket numbers, except by item 12. After a ticketing write-ahead the card payment is never voided and the order never cancelled.
9. **Proposed (lead).** **Watchdog and open cases** (rule 7; A33). An open case is captured money without a ticket. A rejected, balance-refused or unknown ticketing answer opens one: a staff alert, no re-send. A watchdog lists such bookings after N minutes and alerts daily. A lost order answer opens a case of another kind, "order unknown": nothing is captured yet, and staff decide. For a Velexis source the reconciliation role works both kinds as cases of PADR-0021 item 8.
10. **Proposed (lead).** **The stops** (rule 8). After one balance refusal, or K open cases (item 9) of a source, completions are refused before the capture. Only staff lift the stop. The wallet floor and the daily limit per OTA are in PADR-0020 (item 13, question 1). 2026-11-25: on the daily limit per OTA the owner decided: "Keep limit to 0. It should be configurable from Platform Admin's OTA management." ([ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 23; PADR-0020 item 17). What 0 means is still open (ADR-0030 question 10, (44a)). 2026-11-26: the owner answered what 0 means (ADR-0030 item 27; PADR-0020 item 18): "no ticket is paid from the wallet until staff set a limit." The lead reads this as: while an OTA's limit is 0, every completion of that OTA that Velexis's wallet would pay is refused before the capture, until staff set a limit above 0.
11. **Proposed (lead).** **The texts** (plan 4.10; A34). The traveller reads "We are finalising your booking" until ticketing is accepted, and never "not charged" after a capture. The confirmation e-mail waits until then. An open case promises tickets or a full refund within H hours.
12. **Proposed (lead).** **Extras and low-cost content in detail** (plan 4.11; A9, A30). Bags and seats go into the order request; paid bags after ticketing come later. An offer is flagged low-cost before payment, and only a flagged booking becomes `ticketed` without an e-ticket number. "No change, no refund" is shown before payment.
13. **Proposed (lead).** **After-sales** (plan 4.12; A8, A39). OTA staff move the traveller's money; the reconciliation role talks to the supplier. Nobody cancels between the ticketing write-ahead and a final status, and no console refund runs while a case (PADR-0021 item 8) is open.

## Notes that wait for a decision

Rows 5, 7 and 12 change no sentence of an older OTA record, so no OTA record has a dated note for them. The dated note of 2026-11-25 in [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) (Settlements) names this record. The notes below would rest on proposals or open questions; nobody writes them yet.

- [OADR-0003](0003-booking-orchestration-and-supplier-timeout-recovery.md): items 4 to 6.
- [OADR-0008](0008-ticketing-policy.md): item 9; OADR-0019, question 2.
- [OADR-0010](0010-stripe-gateway-and-payment-webhooks.md): items 4, 7 and 8.
- [OADR-0013](0013-notifications-and-booking-documents.md): items 11 and 12.

## Consequences

### Positive

- With item 4, Velexis pays for no ticket whose card payment was not captured.

### Negative

- One wallet serves every OTA. With item 10 and the wallet floor of PADR-0020 (item 13), a low balance stops sales for all of them (plan 9.4).

### Follow-ups

- The owner confirms or changes items 4 to 13 and answers the questions below; the developer then sets the status. 2026-11-25: as the lead proposes in [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 26, the owner's go for a wave of tasks would accept the Proposed items that the wave's tasks name.
- As proposed (A41), the task blocks of PKFare booking wait for the facts of phase P1. 2026-11-25: the tasks exist. The owner asked for all of them (ADR-0030 item 25), so the blocks of PKFare search and booking were written before the facts, from the documented design (the lead's proposal, ADR-0030 item 26). The work still waits for the facts: the PKFare client, search, pricing and booking tasks depend on the facts tasks OBE-107 and X-056 to X-058, and X-059 checks A6, A8 and A9 against the observed facts, with dated notes here. The blocks are in the OTA [agent tasks](../plans/agent-tasks.md), the platform [agent tasks](../../../platform/docs/plans/agent-tasks.md) and the [foundation tasks](../../../docs/mvp/plans/foundation-tasks.md).

## Alternatives considered

The plan sets aside ticketing before the capture, and a second ticketing request after a rejected or lost answer (plan 4.9).

## References

- [`decisions.md`](../../../docs/mvp/decisions.md), [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md), [OADR-0019](0019-supplier-ingestion-engine-and-adapters.md), [PADR-0020](../../../platform/docs/adr/0020-supplier-registry-switches-and-suppliers-page.md), [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md)

## Open questions for the owner

Each recommendation is the lead's proposal, not a decision.

1. **Low-cost content without a reliable mark** (plan 9.1). Options, if PKFare's sandbox shows none: a first release without low-cost content; or a later release. The lead's recommendation: none; it stays in the first release until the facts are known.
2. **Paid bags after ticketing** (plan 9.6 item 2). Options: bags and seats booked with the order are enough; or the two tasks return. The lead's recommendation: later (A30).
3. **Tools for an OTA's own PKFare account** (plan 9.6 item 3). Options: none in the first release; or tools, not yet sized. The lead's recommendation: none (A29). 2026-11-25: as the lead reads [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 21, an OTA's own PKFare account moves after the launch, to milestone M8, so this question waits for M8. The owner named only an OTA's own Amadeus account; whether its own PKFare account moves too is open (ADR-0030 question 13, (44d)). 2026-11-26: the owner decided that an OTA's own PKFare account also moves after the launch (ADR-0030 item 30), so this question waits until after the launch, for the release with own Amadeus, now by the owner's decision; that this release is M8 stays the lead's reading.
