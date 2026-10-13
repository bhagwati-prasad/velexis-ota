# OADR-0007: Tenant migration runner and provisioning worker

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when tenant count makes the deploy fan-out slower than 10 minutes, when per-tenant roles are introduced, or when a second database cluster is added.
**Revisions:** 2026-10-12 (planning review): item 7 names the release paths `deploy.sh` uses and the `velexis-run` step that OBE-007 adds to it.

## Context

The OTA backend owns every tenant schema and its migrations ([`decisions.md`](../../../docs/mvp/decisions.md) §5, [ADR-0004](../../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md)). The platform asks for provisioning and migration on `ota-tenant-ops` and expects results on `platform-tenant-events` with the ledger rows ([ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md), [PADR-0001](../../../platform/docs/adr/0001-tenant-provisioning-orchestration.md)). `@velexis/db` provides the runner and CLI (`migrateTenantSchema`, `migrateTenants`, `migrate.js tenants`) with checksums, advisory locks and a failure ratio ([ADR-0005](../../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md), [ADR-0021](../../../docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md)). Open points: what exactly the OTA worker does in one provisioning transaction, how the application role gets privileges on tables created later, which defaults are seeded, how deploy fan-out results reach the platform, and how failures are classified.

## Decision

1. **Consumer.** `provisioning/tenant-ops.processor.ts` in the OTA worker consumes `ota-tenant-ops` with concurrency 2. Messages are validated against `@velexis/api-types/jobs`. The worker re-reads `platform.tenants` and acts on the current state, never on message order.
2. **One transaction per provisioning**, as `velexis_migrator` (the only process with `DATABASE_MIGRATOR_URL` is the worker): advisory lock on the schema name, `CREATE SCHEMA IF NOT EXISTS … AUTHORIZATION velexis_migrator`, `migrateTenantSchema` (pending files from `migrations/tenant/`, checksums verified, ledger rows), grants, seeds. Either everything exists after the commit or nothing does.
3. **Privileges:** `GRANT USAGE ON SCHEMA`, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES`, and `ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velexis_ota_app`. New tables of later migrations are therefore usable without a `GRANT` in the migration, which keeps tenant migrations free of role names. No sequences exist (ULID ids). `TRUNCATE`, `REFERENCES` and `TRIGGER` are never granted.
4. **Seeds** live in code (`provisioning/seeds/`) and use `ON CONFLICT DO NOTHING`: the settings row (brand name, currency, locale, `UTC`, `issue_after_payment`, `authorize_before_booking`, booking queue 50/0, airline card off), one default markup rule at 0 %, and the English template defaults. Seeds never overwrite OTA edits; template keys added in later releases are covered by the code fallback, not by backfills ([OADR-0013](0013-notifications-and-booking-documents.md)).
5. **Results** are published after the commit: `tenant.provisioned` or `tenant.migrated` with the full ledger (`version`, `checksum`, `phase`, `appliedAt`, `durationMs`) and `steps[]`; failures as `…_failed` with `error {code, message}` and `retryable`.
6. **Failure classes.**

   | Error | Retryable |
   |---|---|
   | Lock timeout, serialization failure, deadlock, connection loss | yes (BullMQ retries 3 times inside the attempt; then reported retryable) |
   | Checksum mismatch, schema with tables but no ledger ("foreign content"), invalid schema name, tenant not in `provisioning` | no (`UnrecoverableError`) |

   A schema is never dropped by the worker.
7. **Deploy fan-out** is run by `velexis-deploy` before the switch, with the shared CLI (`migrate.js tenants --dir "$REL/migrations/tenant"`, concurrency 4, failure ratio 0.1, report `/var/lib/velexis/migrate-<sha>.json`, copied to `/var/log/velexis/`). Right after it, still before the switch, `velexis-run ota node "$REL/ota-backend/dist/cli.js" tenants:report-migrations --report /var/lib/velexis/migrate-<sha>.json` publishes one `tenant.migrated` / `tenant.migration_failed` per schema with `jobId = null` and the schema's full ledger. `velexis-run` ([ADR-0026](../../../docs/mvp/adr/0026-system-users-per-trust-zone.md) item 6) runs it as the OTA zone user with `ota-backend.env` and `ota-worker.env` (for `REDIS_URL`), never with the migrator DSN. A failed report stops the deploy like a failed migration; re-running it repeats both steps safely. OBE-007 adds the step to `deploy/scripts/deploy.sh` and its test. Workers restart before APIs. The code supports schema versions N-1 and N.
8. **Housekeeping messages** `tenant.suspend` and `tenant.resume` are handled by the same consumer: expire open checkouts and void their authorisations, write or delete `staffdeny:tenant:<tenantId>`, and answer `tenant.suspended` / `tenant.resumed` ([PADR-0014](../../../platform/docs/adr/0014-tenant-suspension-and-resume.md)).
9. **Local and test use.** `@velexis/testing` provisions `tenant_alpha` and `tenant_beta` through the same function the consumer uses, so tests exercise the real provisioning path.

## Consequences

### Positive

- Schemas are complete or absent; retries and duplicates are harmless.
- Tenant migrations stay plain DDL with no grants, exactly like the reference DDL.
- The platform's ledger mirror is fed by the same events for provisioning, admin migrations and deploys.

### Negative

- Default privileges are bound to the role that creates the tables; running a tenant migration as another role would leave tables without grants. The CLI only accepts `DATABASE_MIGRATOR_URL`, and an integration test checks privileges on a table created by a later migration.
- Seeds in code must stay compatible with every schema version they may run on (they run right after all migrations, so they always see the latest version).
- The fan-out runs at deploy time and grows with the number of tenants (about 1 s per schema for small migrations).

### Follow-ups

- When the fan-out exceeds 10 minutes, move it to a background job with canary tenants first (db README §4 rollout).

## Alternatives considered

- **Grants inside every tenant migration.** Easy to forget, and puts role names into tenant DDL.
- **Provisioning by the platform worker.** The platform role has no privileges on tenant schemas by design ([ADR-0003](../../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md)).
- **Seeding from SQL in a migration.** Data in migrations cannot use the tenant's name and currency, and would re-run on the fan-out.

## References

- [db README §3–§4](../../../docs/velexis-sdk/db/README.md), [ADR-0004](../../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md), [ADR-0005](../../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md), [ADR-0021](../../../docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md)
- [PADR-0001](../../../platform/docs/adr/0001-tenant-provisioning-orchestration.md), [platform architecture §6.1](../../../platform/docs/architecture.md#61-queue-messages)
- [`../flows/tenant-provisioning-worker.md`](../flows/tenant-provisioning-worker.md), [`../data-model.md`](../data-model.md)
