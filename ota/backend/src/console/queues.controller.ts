// `console.queues.list` and `console.queues.listSnapshots` (consoleListQueue, consoleListQueueSnapshots; `x-scope:
// console`, `x-permission: queues:read`; OBE-065): thin handlers over QueuesService (queues.service.ts). The global
// guards resolved the caller (the OTA admin's service key with a staff token, a secret key with a staff token, or a
// `console:automation` key), the tenant and its environment, the staff member, the rate limits and the permission
// (OADR-0011 points 3 to 6), and the validation interceptor checked the parameters against the OTA document. Every
// answer is `Cache-Control: private, no-store`. Neither read opts in to the audit (`@AuditedRead`): a queue is a list,
// not one person's data (OADR-0011 point 8 as decided on 2026-10-21).
import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  CONSOLE_QUEUE_CACHE_CONTROL,
  QueuesService,
  type QueueListResult,
  type QueueSnapshotPage,
} from "./queues.service";

@Controller("v1/console")
export class QueuesController {
  constructor(private readonly queues: QueuesService) {}

  @Get("queues/:queueId")
  @OpenApiOperation("consoleListQueue")
  async list(
    @OpenApiInput() input: ValidatedInput<"consoleListQueue">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QueueListResult> {
    const page = await this.queues.list(input.path.queueId, input.query ?? {});
    res.setHeader("Cache-Control", CONSOLE_QUEUE_CACHE_CONTROL);
    return page;
  }

  @Get("queue-snapshots")
  @OpenApiOperation("consoleListQueueSnapshots")
  async listSnapshots(
    @OpenApiInput() input: ValidatedInput<"consoleListQueueSnapshots">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QueueSnapshotPage> {
    const page = await this.queues.listSnapshots(input.query ?? {});
    res.setHeader("Cache-Control", CONSOLE_QUEUE_CACHE_CONTROL);
    return page;
  }
}
