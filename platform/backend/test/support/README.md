# Test support of the platform backend

Helpers for the integration tests of `test/integration/**` (`pnpm --filter @velexis/platform-backend test:int`). They are test-only code: nothing under `src/` imports them, and the build ships no `test/` file. Test data comes from the builders of [`../builders/`](../builders) ([`conventions.md` §10](../../../../docs/mvp/conventions.md#10-testing)), never from shared fixtures that tests change.

| File | What it gives a test | Task |
|---|---|---|
| [`app.ts`](app.ts) | `createTestApp()`: the API of `main.ts` on the file's own database clone and the Vitest worker's Redis database, listening on `127.0.0.1`, with Supertest (`http`), the `FakeClock` (`clock`), the parsed log lines (`logs`) and the portal server's headers (`bffHeaders(ip)`). See [README §8](../../README.md#8-tests). | PBE-008 |
| [`jwt-key.ts`](jwt-key.ts) | A fresh Ed25519 key file (mode 0600) for `JWT_PRIVATE_KEY_FILE`. | PBE-012 |
| [`master-key.ts`](master-key.ts) | A fresh key folder for `MASTER_KEY_DIR` (KEK and API key pepper) and the development e-mail settings. | PBE-011 |
| [`fake-ota-worker.ts`](fake-ota-worker.ts) | `FakeOtaWorker`: the OTA worker's side of provisioning, as a BullMQ worker on `ota-tenant-ops` that answers on `platform-tenant-events` ([PADR-0017](../../../docs/adr/0017-platform-test-doubles-and-end-to-end-harness.md) item 1). Below. | PBE-019 |

## The fake OTA worker

Platform provisioning crosses two processes ([PADR-0001](../../../docs/adr/0001-tenant-provisioning-orchestration.md)): the platform dispatches `tenant.provision`, `tenant.migrate`, `tenant.suspend` and `tenant.resume` on `ota-tenant-ops`, and the OTA worker answers on `platform-tenant-events`. Platform integration tests do not start the real OTA worker (that is `test:xb`, PADR-0017 item 2) and never write a tenant schema ([`decisions.md`](../../../../docs/mvp/decisions.md) §5). They start the fake instead:

```ts
import { FakeOtaWorker, schemaNamesFrom } from "../../support/fake-ota-worker";

let fake: FakeOtaWorker;
beforeAll(async () => {
  fake = await FakeOtaWorker.start({
    redisUrl: t.redis.url, // the Redis database of createTestApp()
    schemaNameOf: schemaNamesFrom(pool), // reads platform.tenants.schema_name
    now: () => t.clock.now(), // the answers' requestedAt and ledger times follow the FakeClock
  });
}, 60_000);
afterAll(() => fake.close());

it("…", async () => {
  fake.setOutcome(tenantId, { type: "failed", retryable: true });
  await dispatcher.dispatch(jobId);
  await fake.waitForHandled((handled) => handled.some((h) => h.bullmqJobId === `${jobId}-1`));
});
```

The outcome is set per tenant (`setOutcome`), with `{ type: "provisioned" }` as the default (`defaultOutcome` changes it):

| Outcome | `tenant.provision` | `tenant.migrate` | `tenant.suspend`, `tenant.resume` |
|---|---|---|---|
| `{ type: "provisioned" }` | `tenant.provisioned`: the tenant's `schema_name`, the fake ledger of two migrations (`FAKE_TENANT_LEDGER`: `0001_baseline`, `0002_add_mvp_tenant_deltas`) and the three OTA steps, all `succeeded` | `tenant.migrated` with the ledger up to `targetVersion` (all of it without one) | `tenant.suspended`, `tenant.resumed` |
| `{ type: "failed", retryable, code? }` | `tenant.provision_failed` with `retryable` as given; `create_schema` succeeded, `run_migrations` failed; code `LOCK_TIMEOUT` (retryable) or `CHECKSUM_MISMATCH` unless `code` is set | `tenant.migration_failed` for `0002_add_mvp_tenant_deltas`, `retryable` as given | no answer (the contract has no failure event for them) |
| `{ type: "silent" }` | no answer | no answer | no answer |

How it behaves, so tests can rely on it:

- **Contract.** Every message is checked with `validateJob` of `@velexis/api-types/jobs` when it arrives: an invalid one is recorded in `fake.invalid` and fails as BullMQ's `UnrecoverableError`, never answered. Every answer is checked before it is added, so a test that runs the fake proves both directions keep the PBE-004 schemas.
- **Answers.** An answer carries the message's `jobId`, `tenantId` and `requestId`, `requestedAt` from `now()`, and the message's BullMQ id `<jobId>-<attempt>` as its own BullMQ id (as the real worker does), from which the platform reads the attempt. `fake.handled` lists every message taken with its answer (`null` when none).
- **BullMQ state.** The fake answers at once; BullMQ's tries inside one attempt (`attempts: 3`) are the real worker's business. After a success answer the `ota-tenant-ops` job completes; after a failure answer, or when it gives none, the job fails at once (`UnrecoverableError`). A silent tenant therefore looks to the reconciler like a message that failed without an event (PADR-0001 item 6).
- **No tenant schema.** It connects to Redis only. The schema name comes from `schemaNameOf`; `schemaNamesFrom(pool)` reads `platform.tenants`, as the real worker does with its read-only role. It writes nothing to PostgreSQL.
- **One queue, one consumer.** It consumes every message on the Redis database it is given, so a test file starts at most one, after `createTestApp()` (which empties that database). Messages that earlier tests of the file left on `ota-tenant-ops` are taken too; drain the queue first (`tenantOps.drain(true)`) when that matters.

[`../integration/provisioning/dispatch.int.test.ts`](../integration/provisioning/dispatch.int.test.ts) runs it for every outcome and message.
