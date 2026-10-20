// The tenant jobs and queues routes of the platform admin (platform/docs/api-inventory-admin.md §3, PBE-031): the jobs
// under `/v1/admin/provisioning-jobs` (list, detail, retry a failed one, cancel a queued one) and the queues under
// `/v1/admin/queues` (counts of every queue of both backends, a queue's failed jobs, retry a failed platform job).
// Every operation is `x-scope: platform_admin`, so AdminAuthGuard checks the admin token and re-reads the account
// first. Thin: each handler binds its operation, reads the validated request and makes one AdminJobsService call.
import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  AdminJobsService,
  type AdminProvisioningJobDetail,
  type AdminProvisioningJobList,
  type AdminProvisioningJobResult,
  type AdminReasonRequest,
  type FailedQueueJobList,
  type ListProvisioningJobsQuery,
  type QueueList,
} from "./admin-jobs.service";

type RequestParameters = Readonly<Record<string, unknown>>;

@Controller("v1/admin")
export class AdminJobsController {
  constructor(private readonly jobs: AdminJobsService) {}

  @Get("provisioning-jobs")
  @OpenApiOperation("adminListProvisioningJobs")
  adminListProvisioningJobs(
    @Validated("query") query: ListProvisioningJobsQuery,
  ): Promise<AdminProvisioningJobList> {
    return this.jobs.list(query);
  }

  @Get("provisioning-jobs/:jobId")
  @OpenApiOperation("adminGetProvisioningJob")
  adminGetProvisioningJob(@Validated("path") path: RequestParameters): Promise<AdminProvisioningJobDetail> {
    return this.jobs.get(path["jobId"] as string);
  }

  @Post("provisioning-jobs/:jobId/retry")
  @HttpCode(202)
  @OpenApiOperation("adminRetryProvisioningJob")
  adminRetryProvisioningJob(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
  ): Promise<AdminProvisioningJobResult> {
    return this.jobs.retry(token, path["jobId"] as string);
  }

  @Post("provisioning-jobs/:jobId/cancel")
  @HttpCode(200)
  @OpenApiOperation("adminCancelProvisioningJob")
  adminCancelProvisioningJob(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AdminReasonRequest,
  ): Promise<AdminProvisioningJobResult> {
    return this.jobs.cancel(token, path["jobId"] as string, body);
  }

  @Get("queues")
  @OpenApiOperation("adminListQueues")
  adminListQueues(): Promise<QueueList> {
    return this.jobs.listQueues();
  }

  @Get("queues/:queue/failed")
  @OpenApiOperation("adminListFailedQueueJobs")
  adminListFailedQueueJobs(
    @Validated("path") path: RequestParameters,
    @Validated("query") query: RequestParameters,
  ): Promise<FailedQueueJobList> {
    return this.jobs.listFailedQueueJobs(path["queue"] as string, query["limit"] as number | undefined);
  }

  @Post("queues/:queue/jobs/:jobId/retry")
  @HttpCode(202)
  @OpenApiOperation("adminRetryQueueJob")
  async adminRetryQueueJob(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
  ): Promise<void> {
    await this.jobs.retryQueueJob(token, path["queue"] as string, path["jobId"] as string);
  }
}
