// The queue `platform-settlements` (PBE-059; platform/docs/architecture.md §5, concurrency 1; flows/stripe-payments-
// account.md §F, PADR-0003 item 2): its one job, `settlement.generate {periodStart, tenantId?, requestId?}`, its two
// producers and its consumer.
//
// - **SettlementJobs** (API and worker) queues the job. `enqueue` never throws: Redis failing, or not answering within
//   SETTLEMENT_ENQUEUE_TIMEOUT_MS, is logged (`settlement.enqueue_failed`, `settlement.enqueue_timeout`) and answers
//   `false`. `request` is `adminGenerateSettlements`: `periodStart` (the first instant of a month in UTC, the
//   document's pattern) must be a month that has ended at the Clock's now (`400 VALIDATION_FAILED`, field error
//   `period_not_closed` on `/periodStart`), `tenantId` an existing tenant (`404 NOT_FOUND`); then the job is queued
//   (`503 SERVICE_UNAVAILABLE` when it is not, because the job is the whole effect) and only then the audit row
//   `settlement.generation_requested` is written. The job carries the request id for the audit rows of the drafts.
//   The monthly scheduler (settlements-monthly.scheduler.ts) queues the previous month the same way. Neither sets a
//   job id: a second job for the same month rebuilds the same drafts again, one after the other (concurrency 1).
// - **SettlementsProcessor** (worker only, SettlementsModule.forWorker()) runs SettlementGenerator.generate for each
//   job and returns its counts, which BullMQ keeps. A failure BullMQ can mend by trying again (Stripe unreachable,
//   rate-limited or answering 5xx, the database) fails the job, and BullMQ tries again with the defaults of ADR-0009
//   (5 attempts, backoff from 30 s); the next attempt rebuilds every draft from scratch. A failure no retry mends
//   (another job name or invalid data, no STRIPE_SECRET_KEY, a Stripe 4xx, an amount the columns cannot hold, a
//   currency `reference.currencies` does not know) ends the attempts at once (UnrecoverableError). Each failure is
//   logged as `settlement.generate_failed` with a code and a short message, never a Stripe payload.
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { RequestContext } from "../common/http/request-context";
import { PLATFORM_QUEUE, platformWorkerOptions } from "../common/queues/queue-names";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { StripeNotConfiguredError } from "../common/stripe/stripe.client";
import { SettlementDataError } from "./settlement-formula";
import {
  isClosedPeriod,
  SettlementGenerator,
  settlementPeriod,
  type SettlementGenerationInput,
  type SettlementGenerationResult,
} from "./settlement-generator";
import { SettlementsRepository } from "./settlements.repository";

export type GenerateSettlementsRequest = components["schemas"]["GenerateSettlementsRequest"];

/** The job's name. */
export const SETTLEMENT_GENERATE_JOB = "settlement.generate";

/** The job's data: ids and an ISO time only (ADR-0009 item 10). */
export interface SettlementGenerateJobData {
  /** The first instant of the month, ISO 8601 in UTC (`2027-02-01T00:00:00.000Z`). */
  readonly periodStart: string;
  readonly tenantId?: string;
  readonly requestId?: string;
}

/** How long queueing the job may take before it is given up. */
export const SETTLEMENT_ENQUEUE_TIMEOUT_MS = 2000;

const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A request id as the API writes it (pino-http's, or Caddy's `X-Request-Id`): printable, at most 128 characters. */
const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

/** The generation input of a job's data; throws a TypeError for data of another shape. */
export function parseSettlementGenerateJob(data: unknown): SettlementGenerationInput {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TypeError("settlement.generate data is not an object");
  }
  const { periodStart, tenantId, requestId, ...rest } = data as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    throw new TypeError("settlement.generate data has unknown fields");
  }
  if (typeof periodStart !== "string") {
    throw new TypeError("settlement.generate data has no periodStart");
  }
  const period = settlementPeriod(new Date(periodStart));
  if (tenantId !== undefined && (typeof tenantId !== "string" || !TENANT_ID.test(tenantId))) {
    throw new TypeError("settlement.generate tenantId is not a ten_ id");
  }
  if (requestId !== undefined && (typeof requestId !== "string" || !REQUEST_ID.test(requestId))) {
    throw new TypeError("settlement.generate requestId is not a request id");
  }
  return {
    periodStart: period.start,
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/** A failure of a job, as the log line and BullMQ's failed reason hold it. */
export interface SettlementFailure {
  /** `STRIPE_API_ERROR`, `STRIPE_NOT_CONFIGURED`, `SETTLEMENT_DATA_INVALID`, `INTERNAL_ERROR`, … */
  readonly code: string;
  /** `<code>: <short message>`, never a payload. */
  readonly message: string;
  /** False when no retry can mend it. */
  readonly retryable: boolean;
}

/** The name of an error, when it is a plain identifier; never its message, which might quote a value. */
function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "Error";
}

/** What a failure of `settlement.generate` is (file header). */
export function describeSettlementFailure(error: unknown): SettlementFailure {
  const failure = (code: string, message: string, retryable: boolean): SettlementFailure => ({
    code,
    message: `${code}: ${message}`,
    retryable,
  });
  if (error instanceof UnrecoverableError) {
    // The processor's own: its message is already `<CODE>: <short message>` when it wraps a described failure.
    const code = /^([A-Z][A-Z_]{1,60}): /.exec(error.message)?.[1];
    return code === undefined
      ? failure("UNRECOVERABLE", error.message, false)
      : { code, message: error.message, retryable: false };
  }
  if (error instanceof StripeNotConfiguredError) {
    return failure("STRIPE_NOT_CONFIGURED", "STRIPE_SECRET_KEY is not set", false);
  }
  if (error instanceof SettlementDataError) {
    return failure("SETTLEMENT_DATA_INVALID", error.message, false);
  }
  if (error instanceof Stripe.errors.StripeError) {
    const status = error.statusCode;
    const retryable =
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeRateLimitError ||
      error instanceof Stripe.errors.StripeAPIError ||
      status === 429 ||
      (status !== undefined && status >= 500);
    const rawType: unknown = error.rawType;
    const kind =
      error instanceof Stripe.errors.StripeConnectionError
        ? "connection_error"
        : typeof rawType === "string" && /^[a-z_]{1,60}$/.test(rawType)
          ? rawType
          : "error";
    const code =
      typeof error.code === "string" && /^[a-z_]{1,60}$/.test(error.code) ? ` (${error.code})` : "";
    return failure(
      `STRIPE_${kind.toUpperCase()}`,
      `Stripe answered ${status ?? "nothing"}${code}`,
      retryable,
    );
  }
  return failure("INTERNAL_ERROR", errorName(error), true);
}

@Injectable()
export class SettlementJobs {
  constructor(
    @InjectQueue(PLATFORM_QUEUE.settlements) private readonly queue: Queue,
    private readonly repository: SettlementsRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(SettlementJobs.name) private readonly logger: PinoLogger,
    // The API's request context (CommonModule.forApi); the worker has none.
    @Optional() private readonly context?: RequestContext,
  ) {}

  /** Queues `settlement.generate`; `false`, after one log line, when Redis fails or takes too long (file header). */
  async enqueue(data: SettlementGenerateJobData): Promise<boolean> {
    const context = { periodStart: data.periodStart, tenantId: data.tenantId ?? null };
    let timer: NodeJS.Timeout | undefined;
    const added = this.queue.add(SETTLEMENT_GENERATE_JOB, data).then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ ...context, err: error }, "settlement.enqueue_failed");
        return false;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), SETTLEMENT_ENQUEUE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([added, timedOut]);
      if (result === "timeout") {
        this.logger.warn(
          { ...context, timeoutMs: SETTLEMENT_ENQUEUE_TIMEOUT_MS },
          "settlement.enqueue_timeout",
        );
        return false;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** adminGenerateSettlements (file header). */
  async request(claims: Pick<AccessTokenClaims, "sub">, request: GenerateSettlementsRequest): Promise<void> {
    // The document's pattern admits only the first instant of a month in UTC.
    const period = settlementPeriod(new Date(request.periodStart));
    if (!isClosedPeriod(period, this.clock.now())) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          { path: "/periodStart", code: "period_not_closed", message: "Choose a month that has ended." },
        ],
      });
    }
    if (request.tenantId !== undefined && !(await this.repository.tenantExists(request.tenantId))) {
      throw new AppError("NOT_FOUND");
    }
    const periodStart = period.start.toISOString();
    const requestId = this.context?.active === true ? this.context.requestId : undefined;
    const queued = await this.enqueue({
      periodStart,
      ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
      ...(requestId === undefined ? {} : { requestId }),
    });
    if (!queued) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }
    await runInTransaction(this.db, async (trx) => {
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "settlement.generation_requested",
        targetType: "settlement",
        targetId: null,
        ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
        details: { periodStart, tenantId: request.tenantId ?? null },
      });
    });
  }
}

@Processor(PLATFORM_QUEUE.settlements, platformWorkerOptions(PLATFORM_QUEUE.settlements))
export class SettlementsProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly generator: SettlementGenerator,
    @InjectPinoLogger(SettlementsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<SettlementGenerationResult> {
    if (job.name !== SETTLEMENT_GENERATE_JOB) {
      const name = /^[a-z][a-z0-9_.-]{0,60}$/.test(job.name) ? job.name : "(not a job name)";
      throw new UnrecoverableError(`${PLATFORM_QUEUE.settlements} has no job named ${name}`);
    }
    let input: SettlementGenerationInput;
    try {
      input = parseSettlementGenerateJob(job.data);
    } catch (error) {
      throw new UnrecoverableError(
        error instanceof TypeError ? error.message : "invalid settlement.generate data",
      );
    }
    try {
      return await this.generator.generate(input);
    } catch (error) {
      const failure = describeSettlementFailure(error);
      if (!failure.retryable) {
        throw new UnrecoverableError(failure.message);
      }
      throw error;
    }
  }

  /** A job failed: logged with its month, tenant and attempt, so the failure is seen before the retries run out. */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    const failure = describeSettlementFailure(error);
    const data: unknown = job?.data;
    const fields = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    this.logger.error(
      {
        queue: PLATFORM_QUEUE.settlements,
        job: job?.name,
        attempt: job?.attemptsMade,
        periodStart: typeof fields["periodStart"] === "string" ? fields["periodStart"] : undefined,
        tenantId: typeof fields["tenantId"] === "string" ? fields["tenantId"] : undefined,
        code: failure.code,
        failure: failure.message,
        // A database failure or a bug keeps its stack; a Stripe error is described above, without its payload.
        ...(failure.code === "INTERNAL_ERROR" ? { err: error } : {}),
      },
      "settlement.generate_failed",
    );
  }

  /** Errors of the worker itself (its Redis connections). */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: PLATFORM_QUEUE.settlements, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}
