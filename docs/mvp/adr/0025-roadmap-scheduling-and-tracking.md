# ADR-0025: Roadmap scheduling and tracking

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (solo developer driving AI coding agents, plain Markdown plans), program manager (master roadmap). Decided during planning; revisit when M1 is done and the review hours actually spent per task size are known, or when an outside approval (Amadeus, Stripe, legal, PCI) is refused.
**Revisions:** 2026-10-12 (planning review): eight new foundation tasks (298 tasks, 1,392 agent-hours, calendars unchanged); X-026 and X-027 tagged M1; OBE-016 added to the PBE-036 gate; OBE-007 placed in the M1 block; explicit launch exceptions; item 6 amends [ADR-0020](0020-ai-agent-development-workflow.md); new item 7 on where demos run.

## Context

[`decisions.md`](../decisions.md) §2 says the MVP is built by one developer driving AI coding agents, with two plan styles: agent task plans and week-by-week solo plans. The three task plans hold 298 tasks (1,392 agent-hours by the plan-lint sizes; 290 and 1,350 before the planning review), and the two solo plans schedule the platform and OTA groups separately. Both solo plans leave the combined calendar to [`plans/roadmap.md`](../plans/roadmap.md).

Writing that roadmap needed decisions that neither `decisions.md` nor [ADR-0020](0020-ai-agent-development-workflow.md) covers:

- how to turn task sizes into calendar weeks, with and without agents;
- how strictly milestones follow each other when agents can work ahead;
- where gated tasks go in the parallel batches;
- how the foundation tasks after M0, which no solo plan schedules, fit into the calendar without agents;
- whether the launch waits for outside approvals (Amadeus live access, Stripe and legal confirmation, the PCI penetration test);
- how progress is tracked across the three task files.

## Decision

1. **Calendar with agents.** The developer works 40 hours a week: 30 on agent tasks and 10 on everything else. Developer time per task is S 0.75 h, M 1.5 h, L 3 h, plus 25 % for re-runs and second rounds; agent run time is not on the developer's clock. Three agents run in parallel. Each milestone gets about 20 % buffer, rounded up to whole weeks. The result is **30 working weeks**: M0 3, M1 7, M2 4, M3 5, M4 4, M5 4, M6 3. The planning review's eight extra tasks (about 20 developer-hours) fit in the existing buffers.
2. **Calendar without agents.** S ½ day, M 1 day, L 2 days, as in the solo plans. Their weeks stay as they are and are mapped to calendar weeks, with three changes:
   - X-024 … X-028, X-033 and X-035 join X-001 … X-023 in a seven-week foundation block, because PBE-011 (Mailpit helpers), PBE-020 (the stub client), OBE-018 and OBE-039 depend on them. X-026 and X-027 are tagged M1, because PBE-020 and the M1 end-to-end harness (PFE-014, PFE-015) use the stub; the other tags do not change.
   - The other foundation tasks take buffer days next to the work that needs them: X-036 and X-040 in C21, X-034 in C28 (before OBE-027 in OTA W8), X-037 in C69.
   - OBE-007 (M1, needs PBE-034 from platform W12) moves from OTA W4 into C27, the platform M1 buffer week, so that the M1 exit can check `tenants:report-migrations`.
   - The OTA half-weeks W3 and W37 get their own calendar week, and the rest of each of those weeks is buffer.
   - Platform W31, OTA W40, X-029 … X-032, X-038 and X-039 form a three-week launch block.

   The result is **76 working weeks**; the extra tasks use foundation and launch buffer days.
3. **Strict milestone order, with one exception.** A milestone's tasks start after the previous milestone's go/no-go. When fewer than three tasks of the current milestone are ready, the developer may give an agent a batch-1 task of the next milestone by id, if its dependencies are merged. Agents never pick ahead on their own ([AGENTS.md](../../../AGENTS.md) §3 is unchanged).
4. **Batches.** A task's batch is one more than the highest batch of its dependencies in the same milestone. Gated tasks (PBE-035, PBE-036, PAD-011, PFE-019, PBE-064) count the tasks named in their **Gate** step as dependencies; the PBE-036 gate is OBE-011 … OBE-013 **and OBE-016** (`getStorefront`, which its cross-backend test calls). Within a batch, tasks on the plan-lint critical path start first. **Launch exceptions:** PBE-064 (M6) runs after the launch, once all six switches have been on in production for one release, and OBE-086 (M6) may stay open at launch while its outside steps (penetration test, ASV scan) are missing; the airline card then stays off. Both are named exceptions to the go criterion "every task of the milestone is done".
5. **Launch does not wait for outside approvals.** M6 ends when its go/no-go list is met. A feature whose outside step is missing stays off in production: the airline card until OBE-086 is fully checked, each `FEATURE_*` switch until its approval, and live tenants until Amadeus live access exists. If Amadeus test access is missing at the M2 exit, M2 may close with OBE-027 open (a conditional go), but the M5 go-live is a no-go until OBE-027 is done.
6. **Tracking.** One status rule for all three task files, which **amends ADR-0020**: `- **Status:** in progress (PR #n)` when work starts; the task's own PR, in its last commit, appends ` ✅` to the heading and sets `done (PR #n)`, so both are true on `main` from the merge on. [AGENTS.md](../../../AGENTS.md) §3–§5, the PR template and the foundation plan say the same. A weekly review compares progress with the roadmap's target weeks. The roadmap keeps a milestone status table, an outside-step table and a change log. A milestone that overruns by more than one week triggers a re-baseline with a dated reason; later milestones are never shortened to absorb a slip.
7. **Where demos run.** The VM runs `APP_ENV=production` from M0 on: no Amadeus stub, no Mailpit, no `X-Stub-Scenario` header, no `dev:seed`, test-mode Stripe Billing and Connect events refused, `AIRLINE_CARD_ENABLED=false`. Each milestone demo therefore has an **On the VM** part, shown on the real hosts with real test accounts (Amadeus test credentials, Stripe test mode for OTA payments, the SMTP provider), and a **Local stack** part, shown on the developer's machine or in the CI end-to-end stack (`tools/e2e`, `dev:seed`, the stub, Mailpit, Stripe test mode with switches on). The VM never gets a staging mode or the stub: it is the cardholder data environment ([ADR-0027](0027-pci-scope-and-vm-controls.md)).

## Consequences

### Positive

- One calendar covers both groups and the foundation, and both solo plans' week numbers now map to calendar weeks.
- The calendar rests on the real bottleneck, the developer's review hours, instead of on agent speed.
- Outside approvals cannot hold the launch hostage, and no feature goes live without its approval.
- Progress can be counted mechanically (`grep` for ` ✅`, and plan-lint's remaining-work report from X-035) and checked against target weeks.
- Demos never weaken the production posture of the VM.

### Negative

- The review-time figures are estimates until M1 shows real numbers.
- Strict milestone order leaves some agent capacity unused at the end of each milestone; the exception recovers only part of it.
- The calendar without agents carries less buffer (about 8 %) than the agent calendar (about 27 %), because it keeps the solo plans' own buffers.
- Launching without live tenants or without the airline card is possible, but commercially weaker.
- Some demo steps (stub scenarios, airline card, billing in test mode) are only ever shown locally before launch.

### Follow-ups

- After M1, compare actual review hours per size with the assumption. If the difference is more than 25 %, recompute the agent calendar.
- X-035 (M1): plan-lint reports remaining tasks, remaining hours and the critical path of tasks without ` ✅`.
- Revisit item 5 if the product owner wants the launch tied to live sales.

## Alternatives considered

- **Agent throughput as the limit** (agents finish a task in an hour or two, so the calendar shrinks with more agents). Rejected: every PR needs the developer's review ([ADR-0020](0020-ai-agent-development-workflow.md)), so review hours set the pace. A simulation finishes in nearly the same time (17 to 17.5 weeks of review throughput) with anything from 2 to 6 agents.
- **Free overlap of milestones** (agents take any ready task). Rejected: milestone demos and go/no-go checks would lose meaning, and reviews would jump between unrelated areas.
- **Launch only when all outside approvals are in.** Rejected: it puts dates the developer cannot control on the critical path. The switches and `AIRLINE_CARD_ENABLED` already let features go live one at a time.
- **A separate solo plan for the foundation.** Not needed: the foundation is 40 tasks, and the roadmap's foundation and launch blocks schedule them.
- **A pre-launch staging posture for the VM** (`APP_ENV=staging`, the stub as a systemd unit, a cutover in M6). Rejected for item 7: it would put test doubles and scenario headers on the cardholder data environment and add a cutover step to the launch.

## References

- [`../decisions.md`](../decisions.md) §2
- [`../plans/roadmap.md`](../plans/roadmap.md), [`../plans/README.md`](../plans/README.md)
- [ADR-0011](0011-payments-stripe-and-airline-card.md), [ADR-0012](0012-amadeus-account-model.md), [ADR-0020](0020-ai-agent-development-workflow.md)
- [PADR-0015](../../../platform/docs/adr/0015-milestone-feature-switches.md) (milestone switches), [PADR-0017](../../../platform/docs/adr/0017-platform-test-doubles-and-end-to-end-harness.md) (gates)
- [`../../../platform/docs/plans/solo-developer-plan.md`](../../../platform/docs/plans/solo-developer-plan.md), [`../../../ota/docs/plans/solo-developer-plan.md`](../../../ota/docs/plans/solo-developer-plan.md)
- [`../../../tools/plan-lint/plan-lint.mjs`](../../../tools/plan-lint/plan-lint.mjs)
