# ADR-0020: AI-agent development workflow

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (solo developer driving AI coding agents, plain Markdown plans in two styles), lead architect (task format, branch and PR rules, review gates)
**Revisions:** 2026-10-12 (planning review): one status rule with ` ✅` on merged task headings ([ADR-0025](0025-roadmap-scheduling-and-tracking.md) item 6); registry files and folder entries do not block parallel work; the second-agent review pass becomes a written procedure (X-036).

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
- **Status, one rule for all three task files** ([ADR-0025](0025-roadmap-scheduling-and-tracking.md) item 6): a task carries a `- **Status:**` line (`todo`, then `in progress (PR #n)`, then `done (PR #n)`). The task's own PR, in its last commit, sets `done (PR #n)` **and** appends ` ✅` to the task heading (`### X-012 · Title ✅`), so both become true on `main` exactly when the developer merges. The roadmap counts done tasks with `grep '^### .* ✅$'`. plan-lint ignores the Status field and accepts the ` ✅` suffix.

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
7. **Update the plan** in the same PR (status `done (PR #n)` and ` ✅` on the heading) and any doc the change makes stale.

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
- their **Files** lists do not overlap, apart from the exemptions below.

Exemptions (they never block parallel work):

- **Generated files** (`packages/api-types/src/generated`, `packages/errors/src/generated`, `packages/db/src/generated`) are regenerated on rebase, never merged by hand.
- **Registry files** are *rebase-merge* files: many tasks add one line or one entry to them, and the second PR rebases and keeps both additions. They are `pending-operations.ts` (both backends), each app's `config.ts`, `app.module.ts` and `worker.module.ts`, the scheduler registries (`schedulers.ts`, `scheduler.registry.ts`), `cli.ts`, `package.json` scripts and dependencies, the root and component `.env.example`, the `deploy/env/*.env.example` templates, the OpenAPI documents (one operation per task), the CI workflows (one job or step per task), and Markdown documents (each task edits its own sections). A task changes only its own entries in them.
- **Folder entries** in a Files list (a path ending in `/`, such as `src/notifications/templates/`) mean "new files in this folder"; two tasks overlap only if they create or change the same file.

Two tasks that share any other source file run one after the other. A check of the roadmap's batches (2026-10-12, 298 tasks) found eleven such pairs in eight batches. With the exemptions, a throughput simulation gives 17.8–18.0 weeks of review time for 2 to 6 agents, the same as without the overlap rule, against 19.2–19.4 weeks if every shared file blocked ([`plans/roadmap.md`](../plans/roadmap.md) §1.1).

## Consequences

### Positive

- Every task is self-contained and machine-checked before it reaches the developer.
- Small PRs with mapped acceptance tests keep review time per task short.
- The plan files double as the project's progress report.

### Negative

- Writing tasks at this granularity is up-front work, and plans need continuous grooming.
- A strict file list sometimes forces a follow-up task for a one-line fix elsewhere. That is the price of predictable, parallel work.

### Follow-ups

- Decided during planning; revisit after M1.
- **Second-agent review pass.** Task X-036 (M2) writes the procedure: a fresh agent session with read-only access gets the PR diff, the task block and the security checklist, and posts its findings in the PR before the developer reviews. It is required for the deep-review PRs of M3 (money and card code) and recommended elsewhere when review becomes the bottleneck.

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
