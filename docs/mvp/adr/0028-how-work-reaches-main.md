# ADR-0028: How work reaches main

**Status:** Accepted
**Date:** 2026-11-15
**Deciders:** The product owner, who approved the lead's decisions (23i), (23j), (23k), (23l), (24d), (24f) and (24g) on 2026-11-15 (recorded by FIX-W54-DOCS and FIX-W55-DOCS)

## Context

[ADR-0020](0020-ai-agent-development-workflow.md) (2026-10-12) chose one task per branch and pull request, each squash-merged into `main` by the developer, with `main` protected by green CI, **one approval**, **squash merging only** and **linear history**.

The work did not reach `main` that way. Tasks are handed out in **waves**: each task is done on its own branch `task/<ID>-<slug>`, reviewed (by a second agent where the [runbook](../runbooks/second-agent-review.md) asks for one), and squash-merged by the wave's integrator into the **integration branch** `claude/intelligent-bardeen-90hhu7`, one commit per task with its `Task:` footer. `main` has not received that branch yet.

Three facts make ADR-0020's merging and approval rules unworkable for that branch and for later waves:

- **One developer.** The developer is the only person with write access, and GitHub does not let a pull request's author approve it, so a required approval blocks every merge.
- **History matters.** Precondition P21 of the airline-card go-live ([`airline-card-go-live.md`](../../../ota/docs/runbooks/airline-card-go-live.md) §2) checks with `git merge-base --is-ancestor` that a release contains a given task commit. A squash (or a rebase) of the integration branch would replace every task commit with new ones, and the check would fail.
- **PCI change control.** Every change to the cardholder data environment needs a review record by someone other than its author (PCI DSS 6.2.3, 6.2.3.1, 6.5.1; [ADR-0027](0027-pci-scope-and-vm-controls.md)). The changes are written by agents.

ADR-0020's revision of 2026-11-15 (FIX-W54-DOCS) recorded decisions (23i) to (23k) in place. They replace what ADR-0020 chose rather than refine it, so they belong in an ADR of their own that supersedes those points ([ADR-0001](0001-record-architecture-decisions.md) item 4), together with (24d) and (24f) of the same day (lead decision (24g)).

## Decision

This ADR replaces ADR-0020's points on **merging** (squash merge, linear history) and on **approvals** (one approval). The rest of ADR-0020 stands.

1. **The first merge (23i).** The integration branch `claude/intelligent-bardeen-90hhu7` is merged into `main` once, with a **merge commit, never a squash or a rebase**, so every task commit with its `Task:` footer stays in `main`'s history.
2. **The developer's deep review comes first (23l).** Before that merge the developer does a deep review of X-037, X-038, X-039 and X-041 (SSH second factor, off-VM logs and their review, the WAF, the outbound allow-list). The recorded agent reviews do not replace it.
3. **`main` becomes the default branch, and later waves reach it as one pull request each (23j).** After the first merge `main` is the repository's default branch, so the nightly E2E schedule and Dependabot run on it. In every later wave each task keeps its own branch, which the integrator squash-merges into the integration branch with its `Task:` footer; the integration branch reaches `main` as **one pull request per wave**, which the developer reviews and merges with a **merge commit**.
4. **A single task's pull request is squash-merged (24f).** A task done outside a wave opens its own pull request from `task/<ID>-<slug>`, which the developer **squash-merges** ([conventions §11](../conventions.md#11-git-workflow)). `main`'s protection therefore allows both merge commits and squash merging, requires no linear history, blocks force pushes and requires the six checks **Plan lint**, **Deploy files**, **Build and test**, **Integration tests**, **VM check test** and **Integration tests on other hosts and ports** ([`tools/ci/README.md`](../../../tools/ci/README.md#human-steps-the-developer)).
5. **Approvals and the review record (23k).** `main` requires **0 approvals** while the developer is the only person with write access. The review record of a pull request into `main` is then: the six required checks green, the second-agent review comment where the runbook asks for one (X-036), and the developer's merge. The author (an agent) is never the reviewer (the developer). Once a second person with write access joins, `main` requires **1 approval**, from someone other than the pull request's author.
6. **Who may merge what (24d).** Agents never merge into `main` and never merge a pull request. Only the wave integrator squash-merges task branches into the integration branch. Only the developer merges into `main`: a wave's pull request with a merge commit, a single task's pull request with a squash. Agents never push to `main` ([CLAUDE.md](../../../CLAUDE.md) rule 2, [AGENTS.md](../../../AGENTS.md) §4 item 9).

## Consequences

### Positive

- **P21's ancestry check works as written:** every task commit stays reachable from `main` and from the releases built from it.
- **The PCI change-control record is explicit.** A wave pull request's review record is the six required checks, the second-agent review comment where the runbook asks for one, and the developer's merge, and the author is never the reviewer. The PCI pack says so for 6.2.3, 6.2.3.1 and 6.5.1 ([`responsibility-matrix.md`](../../../ota/docs/pci/responsibility-matrix.md) row 6, [`data-flow.md`](../../../ota/docs/pci/data-flow.md) §3, [`script-inventory.md`](../../../ota/docs/pci/script-inventory.md) §3, the 6.2.3.1 row of the [pack's calendar](../../../ota/docs/pci/README.md#3-calendar)).
- **The pull request template says which merge applies** ([`.github/pull_request_template.md`](../../../.github/pull_request_template.md) line 3): a wave's pull request is merged with a merge commit, a single task's is squash-merged.
- One review per wave instead of one per task keeps the developer's review time where it was planned.

### Negative

- `main`'s history is no longer linear. `git log --first-parent main` shows one commit per wave and per single-task pull request; the task commits are on the second parent.
- A wave's pull request is large. The developer reviews it task by task, through the task commits, the second-agent reviews and the checks.
- With 0 approvals GitHub shows no approval on a merged pull request; the review record lives in the checks, the review comment and the merge, and an assessor is pointed at it by the PCI pack.
- Two merge methods are allowed, so the developer picks the right one for each pull request.

### Follow-ups

- Human steps of X-019 (step 5) and [`tools/ci/README.md`](../../../tools/ci/README.md#human-steps-the-developer): protect `main` as item 4 says, do the deep review of item 2, merge the integration branch once with a merge commit, make `main` the default branch, and record the settings in the pull request.
- When a second person with write access joins, set the required approvals to 1 (item 5).

## Alternatives considered

- **Squash the integration branch into `main`.** One commit for every task of the branch: the `Task:` footers and the per-task commits leave `main`'s history, and P21's ancestry check fails.
- **Rebase the integration branch onto `main`.** Linear history, but every task commit gets a new hash, so the commits that documents and P21 name are not in `main`.
- **One pull request into `main` per task of a wave** (ADR-0020 as written). Each needs its own CI run and a rebase on the previous one; the wave's integration and its end-to-end run happen once anyway.
- **Keep one required approval.** Impossible while the developer is the only writer: GitHub would block every merge, or every merge would need an administrator bypass, which leaves no better record.
- **Let agents merge when CI passes.** Rejected in ADR-0020 and still rejected: the developer's merge is part of the review record.

## References

- [ADR-0020](0020-ai-agent-development-workflow.md) (step 6 and "Gates and permissions", superseded in part by this ADR), [ADR-0001](0001-record-architecture-decisions.md) item 4, [ADR-0027](0027-pci-scope-and-vm-controls.md)
- [CLAUDE.md](../../../CLAUDE.md) rule 2, [AGENTS.md](../../../AGENTS.md) §4, [conventions §11](../conventions.md#11-git-workflow), [`.github/pull_request_template.md`](../../../.github/pull_request_template.md)
- [`tools/ci/README.md`](../../../tools/ci/README.md#human-steps-the-developer) (human steps), X-019 in [`foundation-tasks.md`](../plans/foundation-tasks.md)
- [Second-agent review runbook](../runbooks/second-agent-review.md), the [roadmap](../plans/roadmap.md) (M0 human steps, M6 human review gates)
- [`airline-card-go-live.md`](../../../ota/docs/runbooks/airline-card-go-live.md) §2 (P21), the [PCI evidence pack](../../../ota/docs/pci/README.md)
