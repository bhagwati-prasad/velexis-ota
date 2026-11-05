// `customers.erase` (OBE-087; db README §7 "End-customer erasure inside a tenant", ota/docs/data-model.md §6,
// OADR-0014 points 1, 2, 4 and 5; lead decision (5f) of 2026-11-05, FIX-W43-OTA): at minute 50 of every hour, per
// tenant (`active` and `suspended`; jobs/schedulers.ts fans it out and jobs/fan-out.ts runs it in the tenant's
// context), the customers deleted 30 days less one hour ago or more are erased, so before the `erasureDueBy` their
// deletion promised, 100 per job, by CustomerErasureService (erasure.service.ts, which describes what an erasure
// removes and what it keeps). A full batch asks for more: the runner queues the job again at the back of
// `ota-maintenance`. The job's result carries counts only. The account module is the API's; the worker provides this
// handler, its service and its repository in JobsModule (`jobs → account`, as the checkout expiry is
// `jobs → checkout`).
import { Injectable } from "@nestjs/common";
import { TenantJob, type TenantJobHandler, type TenantJobOutcome } from "../jobs/fan-out";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { CustomerErasureService } from "./erasure.service";

/** The schedule and job name (jobs/schedulers.ts). */
export const CUSTOMERS_ERASE_JOB = "customers.erase";

/** `customers.erase` for one tenant (hourly at minute 50; see the file header). */
@Injectable()
@TenantJob(CUSTOMERS_ERASE_JOB)
export class CustomerErasureProcessor implements TenantJobHandler {
  constructor(private readonly erasure: CustomerErasureService) {}

  /** Erases up to 100 of the tenant's due customers; a full batch asks for more. */
  async run(tenant: PlatformTenant): Promise<TenantJobOutcome> {
    const { counts, more } = await this.erasure.eraseDue(tenant.id);
    return { more, counts };
  }
}
