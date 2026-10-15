<!--
Title: <type>(<scope>): <title> [<TASK-ID>]   e.g. feat(ota-backend): add API key guard [OBE-014]
One task = one branch (task/<TASK-ID>-<slug>) = one PR. Do not merge: the developer reviews and squash-merges.
Definition of done: AGENTS.md §5. Conventions: docs/mvp/conventions.md §11–§12.
-->

## Task

- **Id:** <!-- e.g. X-012 -->
- **Plan entry:** <!-- link to the task block, e.g. docs/mvp/plans/foundation-tasks.md#x-012--... -->

## Summary

<!-- What changed and why, in 3–6 lines. -->

## Acceptance → tests

| # | Acceptance criterion (copied from the task) | Proven by (test file › test name ending in `[<ID> AC<n>]`) |
|---|---|---|
| 1 | | |
| 2 | | |

**Verify command** from the task, and its result:

```text
<command>
<last lines of the output>
```

## Contract changes

- [ ] No OpenAPI change
- [ ] OpenAPI changed first (operations / schemas: …), `pnpm contracts:lint` and `pnpm contracts:generate` run, generated types committed
- [ ] SDK method and JSDoc updated for every new or changed `x-sdk-method` (or follow-up task: …)

## Migrations

- [ ] No migration
- [ ] Files: … (phase: expand / migrate / contract), tested from scratch **and** as an upgrade, `pnpm db:codegen` committed, integration test added

## Docs and ADRs

- [ ] Docs made stale by this change are updated (README, `architecture.md` configuration matrix, `.env.example`, `deploy/env/*.env.example`)
- [ ] New or changed decision recorded in an ADR (status `Proposed`) and the ADR index
- [ ] Plan status set to `done (PR #n)` and ` ✅` appended to the task heading (both take effect on merge; ADR-0025); `node tools/plan-lint/plan-lint.mjs` passes
- [ ] New environment variables added to `deploy/env/*.env.example` are listed under "Questions and follow-ups" as a human step: add them to `/etc/velexis` before the next deploy (`velexis-deploy` refuses a release otherwise)

## Definition of done

- [ ] Every acceptance criterion is mapped to a named test above
- [ ] The task's **Verify** command passes
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass; `pnpm test:int` passes (backend, database or queue changes)
- [ ] Contract checks pass (generated types up to date, route parity, SDK contract)
- [ ] No test deleted, skipped, focused, loosened or slowed down to get green
- [ ] Only the task's **Files** changed (plus tests and generated files); anything else is explained below
- [ ] CI is green

## Security checklist (conventions.md §12; tick or write n/a)

- [ ] No secrets, keys, tokens or real personal data committed; `.env.example` has dummy values only
- [ ] No card data, passwords, tokens, document numbers or decrypted secrets logged, queued or persisted outside ciphertext columns; persisted payload copies go through the redactor
- [ ] Tenant data only through `tenantTx`; no schema-qualified tenant SQL; isolation test for new tenant repositories; `tid` checked
- [ ] Every new endpoint has the right guard and `x-scope`; console permissions and customer ownership checked
- [ ] Input validated by the OpenAPI schema; bound SQL parameters only; no `innerHTML` with data in the storefront
- [ ] Cookies `HttpOnly`, `Secure`, `SameSite`, `__Host-`; CSRF header on storefront state changes; `Origin` checked in state-changing route handlers
- [ ] State-changing Amadeus/Stripe calls idempotent; webhooks verify signatures on the raw body and de-duplicate by event id
- [ ] Authentication, search and payment endpoints rate limited
- [ ] Errors leak no stack traces, SQL or raw supplier errors to customers
- [ ] New dependencies justified here; `pnpm audit` shows no high or critical issue
- [ ] Airline-card path, storefront payment page, Caddyfile, systemd unit or deploy pipeline changes checked against the PCI controls of ADR-0011 and ADR-0027 (script inventory, CSP, sandboxing)
- [ ] M3 deep-review PR (money and card code): second-agent review comment linked here (URL: …) and every high finding fixed or answered; procedure `docs/mvp/runbooks/second-agent-review.md` (n/a for other PRs unless the developer ran one)

## Screenshots

<!-- UI changes only. -->

## Questions and follow-ups

<!-- Open questions, conflicts with decisions.md or an ADR, and proposed new tasks (id, plan, one line). -->
