# OADR-0020: Suppliers paid from a balance, extras and low-cost content

**Status:** Proposed
**Date:** 2026-11-25
**Deciders:** Product owner (items 1 to 3: decisions of 2026-11-24), lead architect (items 4 to 13: proposals, not confirmed)

**What is in force.** The status is `Proposed`: [ADR-0001](../../../docs/mvp/adr/0001-record-architecture-decisions.md) (items 6 and 7) and this folder's [README](README.md) allow no other status before the developer merges a record. The items marked **Decided** are the owner's decisions of 2026-11-24, already in force through [`decisions.md`](../../../docs/mvp/decisions.md). The items marked **Proposed** are the lead's proposals, not in force until the owner confirms them.

## Context

PKFare tickets after the booking and is paid from a prepaid balance, its wallet. Velexis pays from that wallet while the traveller pays by card, so the order of the money steps decides who carries a loss. [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) lists the owner's decisions; [OADR-0019](0019-supplier-ingestion-engine-and-adapters.md) details the engine. The design is in the proposed [multi-supplier plan](../../../docs/mvp/plans/multi-supplier-plan.md), sections 4.9 to 4.12. "A1" to "A43" are its assumptions, a "row" is a row of its section 2, and a "rule" is a money rule of its section 4.10.

**PKFare facts not yet confirmed are assumptions.** PKFare's saved reference states none of these (plan 9.2): how long an unpaid order lives (the hold); whether an order can be priced twice; whether an unpaid order is ever debited; whether an order can be found by our own reference; which field marks low-cost content; whether such orders get ticket numbers. Every item below that rests on one of them is an assumption until PKFare confirms it.

## Decision

1. **Decided (owner, 2026-11-24).** **Velexis's PKFare wallet pays the tickets of Velexis-supplied PKFare bookings** (row 5). "OTAs pay through the Velexis PKFare wallet. OTAs don't have to worry about it."
2. **Decided (owner, 2026-11-24).** **The cost is recovered offline** (row 7). "I will do it offline. I would reconcile with OTA later."
3. **Decided (owner, 2026-11-24).** **Extras and low-cost content are in the first release** (row 12). "the extras and low-cost should be in the first release." Extras in the interface: OADR-0019 item 6.
4. **Proposed (lead).** **Capture before the ticketing request** (A6; the step table of plan 4.9). The traveller's payment is captured in full before the supplier is asked to ticket; otherwise a failed capture leaves Velexis paying. A source other than Amadeus takes Stripe only.
5. **Proposed (lead).** **Write-aheads and single requests** (rules 1, 2 and 5; A31). A write-ahead is a marker committed before a request leaves. A price reference is never used twice. There is never a second order request or a second ticketing request, also after a lost answer or a restart.
6. **Proposed (lead).** **The checks** (rules 3 and 5). Check payable, a new step, allows a capture only when the order was just priced, its hold is open, the amount is within the expected debit and the wallet covers it. Ticketing needs a full capture and a payable order. The reported debit is compared with the expected one.
7. **Proposed (lead).** **The deadlines** (rule 4; A32). The capture deadline is the earlier of the hold end and the order pricing plus 30 minutes, less a margin. The owner sets N, K and H; the plan proposes 30 minutes, 3 cases and 24 hours.
8. **Proposed (lead).** **Polling and final states** (rule 6). Polling never stops before a final status, except at the emergency stop (plan 4.4). No booking is `ticketed` without ticket numbers, except by item 12. After a ticketing write-ahead the card payment is never voided and the order is never cancelled.
9. **Proposed (lead).** **Watchdog and open cases** (rule 7; A33). An open case is captured money without a ticket. A rejected, balance-refused or unknown ticketing answer opens one: a staff alert, no re-send. A watchdog lists such bookings after N minutes and alerts daily. A lost order answer opens the case "order unknown", which staff decide (for a Velexis source, the reconciliation role of PADR-0021).
10. **Proposed (lead).** **The stops** (rule 8). After one balance refusal, or K open cases of a source, completions are refused before the capture. Only staff lift the stop. The wallet floor and the daily limit are in PADR-0020.
11. **Proposed (lead).** **The texts** (plan 4.10; A34). The traveller reads "We are finalising your booking" until ticketing is accepted, and never "not charged" after a capture. The confirmation e-mail waits until then. An open case promises tickets or a full refund within H hours.
12. **Proposed (lead).** **Extras and low-cost content in detail** (plan 4.11; A9, A30). Bags and seats go into the order request; paid bags after ticketing come later. An offer is flagged low-cost before payment, and only a flagged booking becomes `ticketed` without an e-ticket number. "No change, no refund" is shown before payment.
13. **Proposed (lead).** **After-sales** (plan 4.12; A8, A39). OTA staff talk to the traveller and move the traveller's money; the reconciliation role talks to the supplier. A case is one supplier-side question on one booking, with a deadline. Nobody cancels between the ticketing write-ahead and a final status, and no console refund runs while a case is open.

## Notes that wait for a decision

No dated note points here: rows 5, 7 and 12 alone change no sentence of an older OTA record. These notes would rest on a proposal or an open question. Nobody writes them before the owner decides.

- [OADR-0003](0003-booking-orchestration-and-supplier-timeout-recovery.md) (the five steps): items 4 to 6.
- [OADR-0008](0008-ticketing-policy.md) (policies, retries): item 9, and question 2 of OADR-0019.
- [OADR-0010](0010-stripe-gateway-and-payment-webhooks.md) (voids, captures): items 4, 7 and 8.
- [OADR-0013](0013-notifications-and-booking-documents.md) (template keys, documents): items 11 and 12.

## Consequences

### Positive

- If item 4 is confirmed, Velexis does not pay for a ticket whose card payment was not captured.

### Negative

- Offline recovery is credit that Velexis gives. One wallet serves every OTA, so a low balance stops sales for all of them (plan 9.4).

### Follow-ups

- This record builds nothing. The task blocks of PKFare booking wait for the facts of phase P1 (A41); a dated note here then says what is still assumed.

## Alternatives considered

The plan sets aside ticketing before the capture, and a second ticketing request after a rejected or lost answer (plan 4.9).

## References

- [`decisions.md`](../../../docs/mvp/decisions.md), [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md), [OADR-0019](0019-supplier-ingestion-engine-and-adapters.md); PADR-0020 and PADR-0021 in the [platform index](../../../platform/docs/adr/README.md)
- [Multi-supplier plan](../../../docs/mvp/plans/multi-supplier-plan.md): sections 2, 3, 4.9 to 4.12 and 9

## Open questions for the owner

Each recommendation is the lead's proposal, not a decision.

1. **Low-cost content without a reliable mark** (plan 9.1). Options, if PKFare's sandbox shows none: a first release without low-cost content; or a later release. The lead's recommendation: none between the two; it stays in the first release until the facts are known.
2. **Paid bags after ticketing** (plan 9.6 item 2). Options: bags and seats booked with the order are enough; or the two tasks return (12 agent-hours). The lead's recommendation: later (A30).
3. **Daily limit and Stripe modes** (plan 9.1, 9.4). Options: the limit per OTA off by default (A6), or on; all Stripe modes, or not those where the OTA collects the traveller's money. The lead's recommendation: a limit for the first live OTA; the owner decides the rest.
4. **Tools for an OTA's own PKFare account** (plan 9.6 item 3). Options: none in the first release; or tools, which the plan has not sized. The lead's recommendation: none (A29).
