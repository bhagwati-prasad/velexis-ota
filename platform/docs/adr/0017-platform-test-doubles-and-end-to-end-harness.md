# PADR-0017: Platform test doubles and the end-to-end harness

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform delivery lead. Decided during planning; revisit when the OTA worker starts in under five seconds in tests (then the fake may go), or when the nightly end-to-end run takes more than 30 minutes.

## Context

Platform provisioning crosses two processes: the platform dispatches `tenant.provision`, the OTA worker builds the schema and answers on `platform-tenant-events` ([PADR-0001](0001-tenant-provisioning-orchestration.md)). The platform group delivers most of M1, while the OTA provisioning worker (OTA feature OF-11) is built by the other group in the same milestone. Platform integration tests must not wait for it, and they must never write a tenant schema ([`decisions.md`](../../../docs/mvp/decisions.md) §5).

[ADR-0015](../../../docs/mvp/adr/0015-testing-strategy.md) fixes Playwright in `tools/e2e/specs/**/*.e2e.ts`, a nightly `e2e.yml` and "M3 adds the first Playwright journey" (the full-stack booking journey). The portal and admin specifications already plan M1 journeys ([`../../frontend/README.md`](../../frontend/README.md) §9, [`../../admin/README.md`](../../admin/README.md) §6). No foundation task creates `tools/e2e`.

Some journeys need Stripe's test mode over the network (Checkout, Customer Portal), which pull-request CI must not depend on ([AGENTS.md](../../../AGENTS.md) §7: no real network in tests).

## Decision

1. **Fake OTA worker in platform integration tests.** `platform/backend/test/support/fake-ota-worker.ts` (PBE-019) is a BullMQ worker on `ota-tenant-ops` that answers valid `tenant.*` events from `@velexis/api-types/jobs` with a configurable outcome per tenant: provisioned (with a fake ledger), failed (retryable or not), silent, suspended, resumed, migrated. It never connects to a tenant schema. It is test-only code and never shipped.
2. **Cross-backend tests are separate and gated.** Tests that need the real OTA worker or API live in `platform/backend/test/cross-backend/*.xb.test.ts` and run with `pnpm --filter @velexis/platform-backend test:xb`:
   - provisioning (M1, PBE-035);
   - API key acceptance, revocation and invalidations (M2, PBE-036);
   - console token redemption (M4, PFE-019).

   Each such task starts with a **gate** step naming the OTA feature it needs (OF-11, OF-01, OF-09 in [`../../../ota/docs/scope.md`](../../../ota/docs/scope.md)). If the gate is not met, the agent stops and reports instead of faking it.
3. **The platform plan creates `tools/e2e` in M1.** PFE-014 creates `@velexis/e2e` with the `portal` and `platform-admin` Playwright projects, the stack starter, Mailpit and TOTP helpers, the axe helper and `.github/workflows/e2e.yml` (nightly, on demand, and on pull requests labelled `e2e`). The OTA plan adds its `storefront` and `ota-admin` projects to the same configuration. This brings platform-only journeys forward; it does not change the tool, the location or the cadence of ADR-0015, and the first full-stack booking journey stays in M3.
4. **Stripe network journeys are a separate project.** Journeys that drive Stripe Checkout or the Customer Portal run in the Playwright project `portal-stripe`, executed only by the nightly job when the Stripe test secrets are configured. Pull-request CI uses signed fixture events ([X-028](../../../docs/mvp/plans/foundation-tasks.md)) and a mocked Stripe client. No test is skipped with `.skip`; the project is simply not selected.
5. **Test data for end-to-end runs** is arranged through the public APIs where possible, and otherwise through `tools/e2e/support/seed.ts`, which uses `@velexis/testing` builders against the end-to-end database (for example a draft settlement, which needs Stripe balance transactions in real life).

## Consequences

### Positive

- The platform M1 backend can be finished and tested independently of the OTA worker's schedule.
- Cross-backend behaviour is still proven with the real components before each milestone closes.
- One end-to-end harness for both groups, created when the first journey needs it.

### Negative

- The fake can drift from the real worker. The shared JSON Schemas and fixtures of PBE-004 limit that, and the cross-backend tests catch the rest.
- The M1 milestone cannot close before the OTA worker exists (PBE-035 gate), which is a real cross-group dependency.

### Follow-ups

- The OTA plan adds its Playwright projects to `tools/e2e/playwright.config.ts` and reuses `support/stack.ts`.
- When the nightly suite is stable, consider running the non-Stripe projects on every pull request.

## Alternatives considered

- **Start the real OTA worker in every platform integration test.** Slower, and it couples the platform's progress to the other group's.
- **Let the platform create the tenant schema in tests.** Forbidden by the ownership rule.
- **Wait for M3 to create `tools/e2e`.** The M1 portal journeys (sign-up, MFA, create OTA) would stay unproven at the M1 exit.

## References

- [ADR-0015](../../../docs/mvp/adr/0015-testing-strategy.md), [ADR-0022](../../../docs/mvp/adr/0022-shared-test-support-package.md), [PADR-0001](0001-tenant-provisioning-orchestration.md)
- [`../plans/agent-tasks.md`](../plans/agent-tasks.md)
