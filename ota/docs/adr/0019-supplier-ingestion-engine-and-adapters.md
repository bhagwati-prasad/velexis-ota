# OADR-0019: Supplier ingestion engine and adapters

**Status:** Proposed
**Date:** 2026-11-25
**Deciders:** Product owner (items 1 to 6: decisions of 2026-11-24; item 15: decision of 2026-11-25; item 16: decision of 2026-11-26), lead architect (items 7 to 14: proposals, not confirmed)

**What is in force.** The status is `Proposed`: [ADR-0001](../../../docs/mvp/adr/0001-record-architecture-decisions.md) (items 6 and 7) and this folder's [README](README.md) allow no other before the developer merges a record. The **Decided** items are the owner's decisions of 2026-11-24 (items 1 to 6), of 2026-11-25 (item 15) and of 2026-11-26 (item 16), in force through [`decisions.md`](../../../docs/mvp/decisions.md). The **Proposed** items are the lead's proposals, not in force until the owner confirms them.

## Context

Amadeus Enterprise is the only supplier today, and business code calls its client ([OADR-0001](0001-amadeus-client-design.md)) directly. [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) lists the owner's thirteen decisions of 2026-11-24; this record details the engine. The design is in the proposed [multi-supplier plan](../../../docs/mvp/plans/multi-supplier-plan.md), sections 4.1 to 4.3 and 4.9. "A1" to "A43" are its assumptions; a "row" is a row of its section 2.

## Decision

1. **Decided (owner, 2026-11-24).** **Adapters behind one interface** (row 1). "I want to use suppliers as an adapter, so that the booking flow is agnostic to the supplier. I need a common interface, which works independently and an adapter which implements the interfaces."
2. **Decided (owner, 2026-11-24).** **One flow** (row 4). "The flow for all of the suppliers should remain the same."
3. **Decided (owner, 2026-11-24).** **The ingestion engine: fan-out and merge** (row 13). "I propose creating an ingestion engine. The interface would be used by current app. For a given action (for example search), it should fan out the action and parameters to all enabled supplier's (Amadeus, PKFare, Duffle or anyone else) adapter which would form the appropriate request, the results should then be merged and sent from the ingestion engine."
4. **Decided (owner, 2026-11-24).** **Three hooks and their purpose** (row 13). "I also want to expose "pre-action", "post-action" and "post-merge" hooks so that I can manage them better. I would then be able to add markup for certain suppliers, or disable some supplier for some specific search query (maybe based on origin or destination or time or airline or something else) or do some other management."
5. **Decided (owner, 2026-11-24).** **The same engine for OTAs** (row 13). "The same engine would be provided to OTAs as well, so that they can manage things if they use their own supplier."
6. **Decided (owner, 2026-11-24).** **Extras in the interface** (row 12). "Bake in the extras in the interface, if there are no extras then it should be skipped for that booking."
7. **Proposed (lead).** **The module's place** (A1). One module of the OTA backend, `ota/backend/src/supply/`, not a new service. Business code calls the engine, never an adapter.
8. **Proposed (lead).** **Actions, outcomes and routing** (A3, A16 to A18). The actions and the fixed set of outcomes of each are the table of plan 4.1; Check payable is new. Only Search fans out. Any other action goes to the source of the offer or booking, and an unknown source is refused. A search fails only when no called source answers. The merged list has shares and no duplicates.
9. **Proposed (lead).** **Capabilities** (plan 4.2). An adapter declares what it can do: search limits, extras, find order, ticketing, and cancel, void, refund and change. The flow skips a step whose capability is missing and never tests a supplier's name.
10. **Proposed (lead).** **What stays an Amadeus-only tool** (plan 4.2, 9.1). Offices, queues, PNR import, the raw operations and the card paid to the airline stay outside the interface. The advanced search body stays open; a source that cannot serve it is skipped.
11. **Proposed (lead).** **What each hook may do** (plan 4.3). Pre-action may remove a source or refuse the action. Post-action may drop offers or adjust the price, on Search and Price only. Post-merge removes duplicates and applies the shares and the limit. No hook adds a switched-off source. 2026-11-25: part of the base that the owner starts with (item 15 of this record, [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 20), as the lead reads "whatever was documented". 2026-11-26: as the lead reads them, the owner's words of item 16 agree with this item: Search may have all three hooks, and a booking action has no post-merge hook. The rest stays proposed. ADR-0030 questions 16 and 17 ask what the collation rules at post-merge cover, and whether a rule may be bound to a booking action at all.
12. **Proposed (lead).** **Rules are data** (A2, A20). Staff manage rules: conditions, one effect from a fixed list, a priority, an active window and a version. No code, script, expression, template or URL from a tenant or from staff is stored or run. 2026-11-25: part of the base that the owner starts with (item 15 of this record, ADR-0030 item 20), as the lead reads "whatever was documented".
13. **Proposed (lead).** **Who may write rules** (A14, A15). Velexis staff write the rules for Velexis sources, in the platform admin; an OTA writes those for its own sources, in the OTA admin. No rule crosses ownership. A Velexis price rule turns the supplier's net price into the OTA's cost price; the net price is never returned. 2026-11-25: for Velexis's rules, part of the base that the owner starts with (item 15 of this record, ADR-0030 item 20), as the lead reads "whatever was documented". As the lead reads ADR-0030 item 21, the part "an OTA writes those for its own sources, in the OTA admin" is milestone M8, after the launch, with an OTA's own supplier accounts (tasks OBE-207, OBE-208 and OAD-029).
14. **Proposed (lead).** **Hooks on money actions** (A3, A19). A hook may refuse Search, Price and Create order; a failing hook fails closed there. On a money action no hook changes an amount or the supplier, and none stops Check payable, ticketing, reads, releases or service requests. 2026-11-25: part of the base that the owner starts with (item 15 of this record, ADR-0030 item 20), as the lead reads "whatever was documented". 2026-11-26: whether the owner's "nothing would be bound here" (item 16) rules out the refusal point on Create order is ADR-0030 question 17; until the owner answers, this item stays as proposed.
15. **Decided (owner, 2026-11-25).** **The rule engine at the three hooks, before the launch** ([ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 20). Of the multi-supplier engine, which "has to be ready before launch" (ADR-0030 item 19), the owner said: "It should have the pre-request, post-response and post-merge rule engine as well. Start with base rule engine (whatever was documented), and I'd work on it later (post launch)." The lead reads this as: "whatever was documented" is the plan's section 4.3 and items 11, 12 and 14 of this record, and item 13 for Velexis's rules; before the launch the engine gets the three hooks, rules stored as data, the handlers and the platform admin's rules screen; the owner's later work on the rule engine has no task now. Until the owner answers question 3 below, the lead keeps the hook names of item 4: "pre-action", "post-action" and "post-merge". 2026-11-26: the owner answered question 3 (item 16): the names stay.
16. **Decided (owner, 2026-11-26).** **The hook names stay; not every hook applies to every action** ([ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 29; question 3 below). "The hooks are "pre-action", "post-action" and "post-merge" (not all the hooks are applicable to all actions. Search may have all the hooks - post-merge would contain collation rules etc.. A booking action would not have "post-merge" hook and nothing would be bound here)". The lead reads this as: the names of item 4 stay; where the owner's sentence speaks, it agrees with the hook column of plan 4.1 and with item 11: Search may have all three hooks, and a booking action has no post-merge hook. The rest of that column (Price and extras: pre-action and post-action; Create order: only a pre-action point that may refuse; the other actions only observe, or have no hook) stays as proposed. What "collation rules" cover, and whether "nothing would be bound here" rules out the pre-action point on Create order, are ADR-0030 questions 16 and 17.

## Revisions to other records

One dated note of 2026-11-25 points here: [OADR-0001](0001-amadeus-client-design.md), point 1. Its trigger "a second supplier is added" is met (items 1, 3).

## Notes that wait for a decision

They would rest on proposals or open questions; nobody writes them yet.

- [OADR-0001](0001-amadeus-client-design.md) point 4 and the client's folder: items 7 and 8.
- [OADR-0002](0002-offer-and-priced-offer-caching.md) points 2 and 4, and [OADR-0003](0003-booking-orchestration-and-supplier-timeout-recovery.md): items 8 and 9.
- [OADR-0005](0005-markup-and-fee-engine.md) point 2: items 12 and 13, question 1.
- [OADR-0011](0011-console-access-staff-sessions-and-environments.md) point 7: item 10 and ADR-0030.

## Consequences

### Positive

- A new supplier is a new adapter; the flow stays one.

### Negative

- A search waits for several suppliers; the second source's deadline has no number yet (plan 9.6 item 5).

### Follow-ups

- The owner confirms or changes items 7 to 14 and answers the questions below; the developer then sets the status. Nothing is built before. As proposed in the plan (A21, in no item above), the platform would then keep Velexis's rules and grant the OTA backend a read. 2026-11-25: the lead proposes that the owner's go for a wave count as that confirmation for the items its tasks name ([ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) item 26, Proposed); until the owner accepts that proposal, "before" keeps its meaning. 2026-11-26: question 3 is answered (item 16); items 7 to 14 stay proposed.
- The tasks exist (2026-11-25; ADR-0030 item 25). Milestone M7, before the launch, builds the engine, the interface and the Amadeus adapter (OBE-109 to OBE-145, X-060), and the rules at the hooks with Velexis's rules on the platform, the read grant of A21 and the rules screen (OBE-189 to OBE-194, PBE-088, PBE-089, PAD-021). Milestone M8, after the launch, holds an OTA's own rules (item 13, as the lead reads ADR-0030 item 21). The blocks are in the OTA [agent tasks](../plans/agent-tasks.md), the platform [agent tasks](../../../platform/docs/plans/agent-tasks.md) and the [foundation tasks](../../../docs/mvp/plans/foundation-tasks.md); [section 0](../../../docs/mvp/plans/multi-supplier-plan.md) of the plan maps them to its phases.

## Alternatives considered

The plan sets aside a separate engine service (A1; [ADR-0003](../../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md)), code from a tenant or from staff at the hooks (A2), and branches on a supplier's name (item 9).

## References

- [`decisions.md`](../../../docs/mvp/decisions.md), [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md), [OADR-0020](0020-suppliers-paid-from-a-balance.md), [PADR-0020](../../../platform/docs/adr/0020-supplier-registry-switches-and-suppliers-page.md), [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md)

## Open questions for the owner

Each recommendation is the lead's proposal, not a decision.

1. **Markup in two places** (plan 9.6 item 1). OTAs already have markup rules ([OADR-0005](0005-markup-and-fee-engine.md)). Options: an OTA's engine rule may also adjust the price; or not, and the markup rules gain a supply id condition. No recommendation in plan 9.6; as drafted (plan 4.3) an OTA's engine rule may adjust the price. 2026-11-25: the question concerns an OTA's own rules, which the lead places in milestone M8 (item 13); it waits for M8.
2. **Ticketing policy** (plan 4.9, 9.6 item 7). For a source paid from a supplier balance, an OTA on `manual_review` gets none of its content, and `issue_at_booking` runs as `issue_after_payment`: an exception to items 2 and 3. Options: confirm it; or refuse it, and the plan must find another way. The lead's recommendation: confirm.
3. **The names of the hooks** (2026-11-25; [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md) question 12, (44c)). On 2026-11-24 the owner named them "pre-action", "post-action" and "post-merge" (item 4); on 2026-11-25 the owner wrote "pre-request, post-response and post-merge" (item 15). Options: keep "pre-action", "post-action" and "post-merge"; or rename them "pre-request", "post-response" and "post-merge". The lead's recommendation: keep, because an action is more than one request. Until the owner answers, the lead changes no name. 2026-11-26: answered (item 16; ADR-0030 item 29): the names stay. The owner added that not every hook applies to every action; ADR-0030 questions 16 and 17 follow.
