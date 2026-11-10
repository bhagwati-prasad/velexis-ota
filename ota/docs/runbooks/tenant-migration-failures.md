# Runbook: tenant migration failures

For tenant schemas (`tenant_<key>`) that fail to migrate: in the fan-out that every deploy runs before it switches to the new release, or in a `tenant.migrate` job that a platform admin started for one OTA. The behaviour behind it is [OADR-0007](../adr/0007-tenant-migration-runner-and-provisioning-worker.md), [ADR-0021](../../../docs/mvp/adr/0021-migration-cli-and-repeatable-grants.md), [deployment §9](../../../docs/mvp/deployment-single-vm.md#9-migrations-at-deploy) and the [provisioning flow](../flows/tenant-provisioning-worker.md#4-deploy-fan-out); a tenant whose **provisioning** failed is the platform's runbook ([`platform-operations.md`](../../../platform/docs/runbooks/platform-operations.md), stuck provisioning job). The levels of the escalation are those of the [runbooks README](README.md#3-escalation).

## 1. What the system does by itself

- **The fan-out** (`migrate.js tenants`, run by `velexis-deploy` as a transient unit with the migrator's DSN) migrates every schema of a `provisioning`, `active` or `suspended` tenant, 4 at a time, each in its own transaction under its own advisory lock with `lock_timeout 5s`. A schema that fails is rolled back and recorded; the others go on. A `provisioning` tenant without a schema yet is skipped (its provisioning applies every file).
- **At most 10 % failed** (`MIGRATE_TENANT_MAX_FAILURE_RATIO` of `/etc/velexis/migrator.env`, 0.1 by default): the deploy goes on, switches to the new release and restarts the apps. The failed schemas stay on the version before; the code works with schema versions N-1 and N, so their OTAs keep working ([conventions §9](../../../docs/mvp/conventions.md#9-database-migrations)).
- **More than 10 % failed**: the fan-out exits `3` and the deploy stops before the switch. The running release's units are re-installed from its snapshot and it keeps running; the schemas that did migrate stay migrated (every shipped file is an expand step the running code tolerates).
- **The report reaches the platform** right after the fan-out (`tenants:report-migrations`, as the OTA zone): one `tenant.migrated` or `tenant.migration_failed` event per schema, so the platform's mirror (`tenant_schema_migrations`, `tenants.schema_version`) stays right. A report that cannot be published (Redis refuses it) stops the deploy like a failed migration.
- **The platform** queues one `ops.alert` per failed tenant and deploy run and writes a `tenant.migration_failed` audit row (`system`, label `deploy`). A failed `tenant.migrate` job is retried with a backoff when the OTA worker says the error may pass, otherwise it is `failed` with an `ops.alert`; the tenant's status never changes because of a migration.
- **Nothing is applied twice**: each file is recorded with its SHA-256 in the schema's `schema_migrations`; running the fan-out again applies only what is missing, and a file whose content changed after it was applied fails that schema on purpose.

## 2. Signals

| Signal | Where | Means |
|---|---|---|
| `migrate: tenant_<key> <file> failed: <message> (SQLSTATE <code>)`; `migrate: <n> of <m> tenant schema(s) failed (<p> %), within --max-failure-ratio 0.1` or `more than --max-failure-ratio 0.1 allows` | The Deploy workflow run's log (the deploy job prints what `velexis-deploy` and its transient migration unit print) | Which schemas and files failed, and whether the deploy went on |
| `ERROR: migrations failed; the previous release keeps running …` or `ERROR: publishing the tenant migration report failed; …`, after `re-install the units and Caddyfile of the running release <sha>`; no `deploy <sha> done` | `sudo tail -n 80 /var/log/velexis/deploy.log` | A deploy that stopped before the switch (more than 10 % failed, or the report step failed) |
| The fan-out report: `target`, `total`, `applied`, `failed` (`schema`, `file`, `error.message`, `error.code`), `skipped` | `/var/log/velexis/migrate-<sha>.json` (root only) | The whole result of one deploy's fan-out |
| The platform's `ops.alert` e-mail for `tenant.migration_failed`; the tenant's audit tab (`tenant.migration_failed`, label `deploy`); the tenant's schema version on its page | Velexis ops' mailbox; the platform admin, `/tenants/<id>` | The platform's view of the same failure |
| A `migrate` job `failed` (its steps, attempts and errors) | The platform admin's `/provisioning-jobs` (kind `migrate`) and `/provisioning-jobs/<id>` | A migration of one OTA started from the platform admin failed |
| `tenant_ops.migration_failed`, `tenant_ops.retrying`, `tenant_ops.migrated` | Journal of `velexis-ota-worker` | The OTA worker's side of a `tenant.migrate` job |
| `/health/ready` after the deploy | `curl -s http://127.0.0.1:4000/health/ready`, `…:4001/…` | Stays `200`: a schema on N-1 does not make a process unready. `velexis-deploy` rolls back a release whose units do not become ready, which is a different failure ([deployment §8](../../../docs/mvp/deployment-single-vm.md#8-release-artefact-deploy-and-rollback)) |

## 3. First checks (on the VM)

```bash
sudo velexis-deploy --status                                        # the current release: compare it with the sha the Deploy workflow ran
sudo tail -n 80 /var/log/velexis/deploy.log
SHA=<the release's sha>
sudo jq '{target, total, applied: (.applied | length), skipped, failed: [.failed[] | {schema, file, message: .error.message, sqlstate: .error.code}]}' \
  "/var/log/velexis/migrate-$SHA.json"
# One schema's ledger (read-only, as postgres through peer authentication):
sudo -u postgres psql -d velexis -Atc "SELECT id, status, created_at FROM tenant_<key>.schema_migrations ORDER BY id DESC LIMIT 5"
# Where every tenant stands, as the platform mirrors it:
sudo -u postgres psql -d velexis -Atc "SELECT key, status, schema_version FROM platform.tenants WHERE status IN ('provisioning','active','suspended') ORDER BY schema_version, key"
```

Read the SQLSTATE and the message of each failed schema; they decide the fix (§4.1).

## 4. What to do

### 4.1 Decide by the error

| Error | Typical SQLSTATE or message | What it is | Fix |
|---|---|---|---|
| Lock timeout, a lost connection, a deadlock, a cancelled statement | `55P03`, `08006`, `40P01`, `57014` | A long transaction of the app held a lock the migration needed for more than 5 s, or the database was briefly unavailable | Transient: run it again (§4.2), at a quieter time if it repeats |
| The file was changed after it was applied | The runner's checksum message (that schema's exit code `2`) | Someone edited a merged migration file, which the rules forbid ([AGENTS.md §6](../../../AGENTS.md#6-contract-first)) | Never "fix" the ledger. Put the file back as it was applied (from the release that first shipped it) in a new release, and ship the intended change as a new numbered file |
| The data of this one schema does not fit the change | `23505` (unique), `23502` (not null), `23514` (check), `23503` (foreign key), `22…` (data) | A migration that is right for most OTAs meets data it did not expect in this one | Fix forward: a new release with a migration that handles the data (or an idempotent backfill command run before it, [conventions §9](../../../docs/mvp/conventions.md#9-database-migrations)); never edit the failing file, which did not apply here and may have applied elsewhere |
| A schema without a ledger, or one that is not a provisioned tenant schema | The runner's message (foreign content, schema missing) | Something created or changed the schema outside provisioning | Stop and investigate; never drop a schema. A missing schema of a tenant that should have one is the platform's provisioning runbook |
| Many schemas, the same error | — | The migration itself is wrong | The deploy stopped if more than 10 % failed: fix forward in a new release and deploy that |

### 4.2 Run the migration again

After the cause is fixed (or for a transient error), either:

- **Deploy the same release again** (the Deploy workflow for the same sha, [deployment §8](../../../docs/mvp/deployment-single-vm.md#8-release-artefact-deploy-and-rollback)): it repeats the fan-out for every schema (nothing is applied twice) and the report, and covers every failed OTA at once; or
- **Migrate one OTA** from the platform admin: `/tenants/<id>`, Migrate (an empty target version migrates to the latest file of the running release). The OTA worker applies the pending files as `tenant.migrate` and answers `tenant.migrated` or `tenant.migration_failed`; the job is at `/provisioning-jobs/<id>`, where a failed one can be retried. `409 migrate_job_active` means a migrate job of that OTA is still queued or running.

A fix that needs a new migration file comes with a new release: deploy it; its fan-out applies the new file everywhere.

### 4.3 The report step failed

`velexis-deploy` stops when `tenants:report-migrations` cannot publish its events (Redis down, an unreadable report), before the switch: the old release keeps running. Fix Redis ([README §4](README.md#4-redis-lost-or-restarted-without-its-data)) and deploy the same sha again: the fan-out applies nothing new and the report sends every schema's full ledger. The same holds when the events of a deploy were lost with Redis afterwards: the platform's mirror shows an older `schema_version` than the schema's ledger until the next deploy's report.

### 4.4 While a schema stays behind

- Its OTA keeps working: the release supports schema versions N-1 and N.
- The next release must not ship a **contract** file (one that removes what N-1 code needs) until every tenant reports the version before it ([ADR-0005](../../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md), [deployment §9](../../../docs/mvp/deployment-single-vm.md#9-migrations-at-deploy)): check the platform's `schema_version` of every tenant (§3) before a release with a contract file.
- Keep the failed tenant's key and the report in the deploy's record until it is migrated.

## 5. Escalation

| When | Who acts | Escalates to |
|---|---|---|
| A schema failed with a transient error | Velexis ops (§4.2) | — |
| A schema failed on its data or on a changed file | Velexis ops write the fix (a new release) | The product owner if the OTA must wait for a feature of the release; never a manual change of the ledger |
| More than 10 % failed, the deploy stopped | Velexis ops | The product owner when the release carried a fix OTAs wait for |
| The platform's mirror and the schemas disagree after a lost report | Velexis ops deploy again | — |
| A schema without a ledger or with unknown content | Velexis ops stop and investigate | The incident lead if anything suggests the database was changed by someone else ([incident response plan](../pci/incident-response.md)) |

## 6. After the incident

Record the release, the failed schemas (keys only), the cause and the fix, and check that every tenant's `schema_version` in the platform admin is the latest file of the running release.
