// Post-step `record_migrations` (PBE-022; platform/docs/flows/provisioning.md §3): the platform's mirror of the tenant
// schema's migration ledger. Every migration of the `tenant.provisioned` event becomes an `applied` row of
// `tenant_schema_migrations` (checksum, phase, duration, the time the OTA worker applied it, the job as `runner_id`),
// upserted on `(tenant_id, version)`, and `tenants.schema_version` becomes the event's `schemaVersion`, which the job's
// `result` keeps too. A second run writes the same rows again: the step is idempotent. The platform never reads the
// tenant schema itself (decisions.md §5); the OTA worker's report is the source.
import { Injectable } from "@nestjs/common";
import { TenantsRepository } from "../../tenants/tenants.repository";
import { ProvisioningJobsRepository } from "../provisioning-jobs.repository";
import type { PostStep, PostStepContext, PostStepOutcome } from "./post-steps.runner";

@Injectable()
export class RecordMigrationsStep implements PostStep {
  readonly name = "record_migrations";

  constructor(
    private readonly jobs: ProvisioningJobsRepository,
    private readonly tenants: TenantsRepository,
  ) {}

  async run({ trx, job, event, now }: PostStepContext): Promise<PostStepOutcome> {
    const { schemaName, schemaVersion, migrations } = event.payload;
    for (const migration of migrations) {
      await this.jobs.upsertTenantMigration(trx, {
        tenantId: job.tenant_id,
        schemaName,
        runnerId: job.id,
        migration,
        now,
      });
    }
    await this.tenants.setSchemaVersion(trx, job.tenant_id, schemaVersion, now);
    return { status: "succeeded", result: { schemaVersion } };
  }
}
