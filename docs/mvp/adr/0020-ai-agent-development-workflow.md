# ADR-0020: AI-agent development workflow

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (solo developer driving AI coding agents, plain Markdown plans in two styles), lead architect (task format, branch and PR rules, review gates)

## Context

[`decisions.md`](../decisions.md) §2: one developer drives AI coding agents. Plans are plain Markdown so they can be audited and edited, in two styles:

- an **agent task plan**: small, self-contained, verifiable tasks;
- a **solo developer plan**: week by week.

Agents have no memory between sessions, can work in parallel, and are confident even when wrong. The workflow must make every task self-describing, checkable by machines, and reviewable by one person in minutes.

## Decision

### Plans

| Plan | File | Task id prefixes |
|---|---|---|
| Foundation (cross-cutting, M0 and shared work) | `docs/mvp/plans/foundation-tasks.md` | `X-` |
| Platform agent tasks | `platform/docs/plans/agent-tasks.md` | `PBE-` (backend), `PFE-` (frontend), `PAD-` (admin) |
| OTA agent tasks | `ota/docs/plans/agent-tasks.md` | `OBE-` (backend), `OFE-` (storefront), `OAD-` (admin), `SDK-` (SDK) |
| Solo developer plans (week by week) | Listed in [`../README.md`](../README.md) | They reference task ids, they do not redefine tasks |

**Task block format.** It is validated by [`tools/plan-lint/plan-lint.mjs`](../../../tools/plan-lint/plan-lint.mjs):

```markdown
### PBE-012 · Short imperative title
- **Component:** platform-backend
- **Milestone:** M1
- **Depends on:** X-003, PBE-010
- **Size:** S | M | L
- **Read first:** docs/mvp/adr/0008-identity-accounts-customers-sessions.md ; …
- **Files:** `platform/backend/src/…`, `…`
- **Steps:**
  1. …
  2. …
- **Acceptance:**
  - …
- **Verify:** `pnpm --filter @velexis/platform-backend test`
```

Rules:

- **Sizes:** S at most 2 hours, M at most 4 hours, L at most 1 day of focused agent and review time. Anything bigger is split.
- **Milestones** are the shared M0–M6 ([`../README.md`](../README.md)). Every plan uses the same ids and meanings.
- `node tools/plan-lint/plan-lint.mjs` runs in CI on every PR that touches a plan. It checks unique ids, prefixes, required fields, dependencies, cycles and allowed file paths, and prints the critical path.
- A task may carry an optional `- **Status:**` line (`todo`, `in progress (PR #n)`, `done (PR #n)`). plan-lint ignores extra fields.

### Doing a task

1. **Pick:** see [AGENTS.md](../../../AGENTS.md). Use milestone order. Every `Depends on` task must be merged. The task must not be claimed: no open PR and no branch `task/<ID>-*`.
2. **Read:** [AGENTS.md](../../../AGENTS.md), then the task's **Read first** list, then only the code it touches. Large files (the OpenAPI document, `api-types.d.ts`, the Amadeus specs) are searched, not read whole.
3. **Branch:** `task/<ID>-<short-slug>` from the latest `main`.
4. **Work contract-first** ([ADR-0006](0006-contract-first-openapi.md)). Change only the files in the task's **Files** list, plus their tests and generated files. Explain any other change in the PR.
5. **Prove it:**
   - the task's **Verify** command passes;
   - `pnpm lint`, `pnpm typecheck` and `pnpm test` pass, plus `pnpm test:int` when backend or database code changed;
   - each acceptance criterion maps to a named test.
6. **Open one PR per task** using the template (`.github/pull_request_template.md`):
   - title `<type>(<scope>): <title> [<ID>]`;
   - acceptance criteria → tests table;
   - docs or ADRs touched;
   - security checklist;
   - open questions.
7. **Update the plan** in the same PR (status `done (PR #n)`) and any doc the change makes stale.

### Gates and permissions

- **The developer reviews and merges every PR.** Agents never merge, never push to `main`, never force-push a branch another agent uses, and never change CI, branch protection or agent configuration unless the task is about exactly that.
- `main` is protected: CI green, one approval (the developer), squash merge, linear history.
- **No production access for agents:** no SSH to the VM, no production secrets, no live Stripe or Amadeus credentials. Deploys are a manual `workflow_dispatch` by the developer ([ADR-0007](0007-single-vm-without-docker.md)).
- **Never weaken tests** to pass ([ADR-0015](0015-testing-strategy.md)).
- **Stop and ask instead of guessing.** If a task conflicts with `decisions.md` or an ADR, or is ambiguous, the agent stops and writes the question in the PR (or in its final message) instead of choosing silently. If a new decision is unavoidable, it writes a `Proposed` ADR ([ADR-0001](0001-record-architecture-decisions.md)).
- **Discovered work** becomes a new task in the right plan, with the next free id, in the same PR or a follow-up. It is not done silently inside an unrelated task.

### Parallel agents

Several agents may work at once when:

- their tasks' dependencies are all merged;
- their **Files** lists do not overlap.

Generated files (`packages/api-types`, `packages/db/src/generated`) are regenerated on rebase, never merged by hand.

## Consequences

### Positive

- Every task is self-contained and machine-checked before it reaches the developer.
- Small PRs with mapped acceptance tests keep review time per task short.
- The plan files double as the project's progress report.

### Negative

- Writing tasks at this granularity is up-front work, and plans need continuous grooming.
- A strict file list sometimes forces a follow-up task for a one-line fix elsewhere. That is the price of predictable, parallel work.

### Follow-ups

- Decided during planning; revisit after M1. If review becomes the bottleneck, add an automated review pass (a second agent running the code-review checklist) before the developer's review.

## Alternatives considered

- **Issue tracker as the plan.** Not versioned with the code, harder for agents to read in full, and harder to lint.
- **Large feature branches per milestone.** Long-lived branches conflict, and reviews become too large to do well.
- **Letting agents merge when CI passes.** Too risky while the test suite is still growing.

## References

- [`../decisions.md`](../decisions.md) §2
- [AGENTS.md](../../../AGENTS.md), [CLAUDE.md](../../../CLAUDE.md)
- [`tools/plan-lint/plan-lint.mjs`](../../../tools/plan-lint/plan-lint.mjs)
- [ADR-0001](0001-record-architecture-decisions.md), [ADR-0006](0006-contract-first-openapi.md), [ADR-0015](0015-testing-strategy.md)
- [`../conventions.md`](../conventions.md) (git workflow)
