# ADR-0001: Record architecture decisions

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner, lead architect
**Revisions:** 2026-10-12 (planning review): component ADRs are named PADR-/OADR-; the planning-review rule of item 4.

## Context

Velexis is built by one developer who drives AI coding agents. Agents start every task with no memory of earlier sessions. Unless each decision is written down where an agent will find it, agents re-decide things, contradict each other and drift from what the product owner asked for.

The product owner's answers are recorded in [`../decisions.md`](../decisions.md). Many smaller technical choices follow from them, and many more will come up during implementation. They need one format, one place and a clear order of precedence.

## Decision

1. We record architecture decisions as **ADRs in MADR-lite format**: `# ADR-NNNN: Title`, then **Status**, **Date**, **Deciders**, and the sections Context, Decision, Consequences (positive / negative / follow-ups), Alternatives considered and References.
2. **Where they live:**
   - Cross-cutting ADRs (anything that touches more than one component, or the repository as a whole) live in `docs/mvp/adr/` and are numbered `0001`, `0002`, … They are listed in [`README.md`](README.md).
   - Decisions that concern a single component group may live in `platform/docs/adr/` or `ota/docs/adr/`. Their numbers overlap with the cross-cutting ones, so they are always named with a prefix: **PADR-NNNN** for `platform/docs/adr/` and **OADR-NNNN** for `ota/docs/adr/`, linked by path. A bare **ADR-NNNN** always means `docs/mvp/adr/`. Component ADRs must not contradict a cross-cutting ADR; the [index](README.md) links both component indexes.
3. **Precedence**, highest first: [`decisions.md`](../decisions.md) → cross-cutting ADRs → component ADRs → plans → code comments. When two documents disagree, the higher one wins and the lower one is fixed in the same pull request.
4. **Changing a decision:**
   - A product owner decision changes in `decisions.md` first, then in the ADR that records it, then in the plans.
   - An accepted ADR is not rewritten. A new ADR supersedes it. The old one gets `Status: Superseded by ADR-NNNN` and keeps its text.
   - Typos, links and clarifications that do not change the decision may be edited in place.
   - **Planning review exception.** Until the first M0 task is merged, an accepted ADR may be revised in place when a planning review finds a contradiction or a gap, so that readers do not have to chase superseding records for decisions nobody has implemented yet. Each such revision adds a dated line to the ADR's **Revisions** field that says what changed. From the first merged M0 task on, the superseding rule above applies without exception.
5. **Decisions taken while planning or implementing** that `decisions.md` does not cover take the conservative, simple option for a solo developer on a single VM. They are recorded with `Status: Accepted` and a line "Decided during planning; revisit when …" (or "Decided during implementation; revisit when …") that names the trigger for revisiting them.
6. **Agents may write ADRs.** An agent that needs a decision outside its task's scope writes the ADR in the same pull request, marked `Proposed`. The developer changes it to `Accepted` when the pull request is merged, or sends it back.
7. **Template** (copy into a new file `NNNN-kebab-title.md`):

   ```markdown
   # ADR-NNNN: Title

   **Status:** Proposed | Accepted | Superseded by ADR-NNNN
   **Date:** YYYY-MM-DD
   **Deciders:** …
   **Revisions:** (optional) YYYY-MM-DD: what changed

   ## Context
   ## Decision
   ## Consequences
   ### Positive
   ### Negative
   ### Follow-ups
   ## Alternatives considered
   ## References
   ```

## Consequences

### Positive

- Agents and the developer find every decision in one predictable place with one precedence rule.
- The reason behind each choice survives, so a later change can be judged against the original trade-offs.
- Superseded ADRs keep the history.

### Negative

- Writing ADRs takes time. We keep them short: one page is the target.
- Two ADR locations (cross-cutting and component) need discipline. The index in [`README.md`](README.md) links both, and the PADR-/OADR- prefixes keep the numbers apart.

### Follow-ups

- Every pull request that changes a recorded decision updates the ADR index ([AGENTS.md](../../../AGENTS.md) definition of done).

## Alternatives considered

- **Decisions only in `decisions.md`.** Fine for product answers but too coarse for technical choices. It would grow into an unstructured log.
- **Wiki or issue tracker.** Not versioned with the code and invisible to agents working in the repository.
- **Full MADR template.** More sections than a solo team needs.

## References

- [`../decisions.md`](../decisions.md): the product owner's decision record.
- [ADR-0020](0020-ai-agent-development-workflow.md): how agents use ADRs and plans.
- MADR: <https://adr.github.io/madr/>
