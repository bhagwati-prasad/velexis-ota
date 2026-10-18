// Post-step `activate` (PBE-022; platform/docs/flows/provisioning.md §3, PADR-0001 item 1; scope PF-11): the new OTA
// goes live in test mode. In one transaction:
//
// - the tenant: `provisioning → active`, `activated_at`, `version + 1` (a conditional update; a tenant that is already
//   `active` stays as it is, and one in any other status fails the step: provisioning never revives a `failed` or
//   `suspended` tenant);
// - the job: `succeeded`, `finished_at`, no lease and no error, only while it is still active at the event's attempt
//   (otherwise the step fails: the job changed under the run); its `result` holds what the earlier steps merged into it,
//   `{schemaVersion, officeId?, apiKeyIds}`;
// - the audit row `tenant.activated` (actor `system`, label `provisioning`), with the job, schema version, office and
//   key ids.
//
// The invalidations and the welcome e-mails follow in `notify`, after this commit.
import { Injectable } from "@nestjs/common";
import { AuditService } from "../../audit/audit.service";
import { TenantsRepository } from "../../tenants/tenants.repository";
import { ProvisioningJobsRepository } from "../provisioning-jobs.repository";
import type { PostStep, PostStepContext, PostStepOutcome } from "./post-steps.runner";

/** The actor label of the system audit rows of provisioning (as the API key generator writes them). */
export const PROVISIONING_ACTOR_LABEL = "provisioning";

/** The activation found the tenant or the job in a state provisioning does not change. */
export class ActivationRefusedError extends Error {
  override readonly name = "ActivationRefusedError";
  readonly code = "ACTIVATION_REFUSED";
}

function resultFields(result: unknown): Record<string, unknown> {
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>) }
    : {};
}

@Injectable()
export class ActivateStep implements PostStep {
  readonly name = "activate";

  constructor(
    private readonly tenants: TenantsRepository,
    private readonly jobs: ProvisioningJobsRepository,
    private readonly audit: AuditService,
  ) {}

  async run({ trx, job, event, now }: PostStepContext): Promise<PostStepOutcome> {
    const tenant = await this.tenants.activateProvisioned(trx, job.tenant_id, now);
    if (!tenant.activated && tenant.status !== "active") {
      throw new ActivationRefusedError(`the tenant is ${tenant.status ?? "missing"}, not provisioning`);
    }
    if (!(await this.jobs.markSucceeded(trx, { jobId: job.id, attempt: job.attempt, now }))) {
      throw new ActivationRefusedError("the job is no longer active at this attempt");
    }
    const result = resultFields(job.result);
    await this.audit.record(trx, {
      actorType: "system",
      actorLabel: PROVISIONING_ACTOR_LABEL,
      action: "tenant.activated",
      targetType: "tenant",
      targetId: job.tenant_id,
      tenantId: job.tenant_id,
      tenantKey: job.tenant_key,
      before: { status: tenant.activated ? "provisioning" : "active" },
      after: { status: "active" },
      details: {
        jobId: job.id,
        attempt: job.attempt,
        ...("schemaVersion" in result ? { schemaVersion: result["schemaVersion"] } : {}),
        ...("officeId" in result ? { officeId: result["officeId"] } : {}),
        ...("apiKeyIds" in result ? { apiKeyIds: result["apiKeyIds"] } : {}),
      },
      requestId: event.requestId,
    });
    return { status: "succeeded" };
  }
}
