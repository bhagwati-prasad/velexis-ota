// The consumer of `platform-stripe-events` (PBE-043; platform/docs/architecture.md §5, concurrency 2;
// subscription-billing flow §D, PADR-0002 item 5, PADR-0015 item 4). BullMQ hands any job of a queue to any of its
// workers, so this is the queue's one processor, for the events of both receivers (billing and Connect accounts). It
// runs in the worker only (BillingSyncModule.forWorker()). One job, `stripe.event {eventId}` (job id = event id):
//
// 1. Claim the inbox row (stripe-events.repository.ts): `received`, `processing` (a worker stopped during an earlier
//    attempt) or retryable `failed` becomes `processing` with one more attempt. A row that is missing or done
//    (`processed`, `ignored`, `failed` for good) is skipped, so a job that runs twice processes the event once.
// 2. Route it: an event whose endpoint's milestone switch is off (`billing` → FEATURE_STRIPE_BILLING, `connect_accounts`
//    → FEATURE_OWN_STRIPE) ends `ignored`, as does a type no handler declares (`@HandlesStripeEvents`). Otherwise the
//    type's handler runs; it re-fetches the object from Stripe and resolves to `processed` or `ignored`. The billing
//    handlers are those of handlers/ (PBE-045: `checkout.session.completed`, `customer.subscription.created`, `…updated`
//    and `…deleted`, with the price-to-plan map and the status rules); the invoice events (PBE-046) and the Connect
//    account events (PBE-056) follow. A handler applies its change in one transaction of its own and dispatches the
//    jobs it queued after that commit, so this processor holds no transaction while a handler calls Stripe.
// 3. Finish: `processed` or `ignored` with `processed_at`, the reason of an ignored event in `last_error`, and the
//    tenant the handler resolved it to.
//
// A failure records `attempts` and `last_error` (`<CODE>: <short message>`, never a secret or a payload) and marks the
// row `failed`. While BullMQ will try again (5 attempts, exponential backoff from 30 s, ADR-0009) the row stays
// retryable and the job fails with that message; after the last attempt, or for an error no retry mends (a handler's
// StripeEventFailure with `retryable: false`, a Stripe 4xx, a missing STRIPE_SECRET_KEY), the row is `failed` for good
// (`processed_at` set) and the job fails with BullMQ's UnrecoverableError. An admin then reprocesses it
// (adminReprocessStripeEvent, PBE-048). If the worker cannot even record the failure (the database is down), the row
// stays `processing` and the next attempt claims it; after the last one, the `stripe_events.sweep` scheduler queues
// the event again once the row has been unchanged for 10 minutes.
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject } from "@nestjs/common";
import { DiscoveryService, Reflector } from "@nestjs/core";
import { AppError } from "@velexis/errors";
import { UnrecoverableError, type Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { Clock } from "../../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../../common/database";
import { FEATURE_VARIABLES, FeatureSwitches } from "../../common/features";
import { PLATFORM_QUEUE, platformWorkerOptions } from "../../common/queues/queue-names";
import { StripeNotConfiguredError } from "../../common/stripe/stripe.client";
import { StripeEventsRepository } from "../../common/stripe/stripe-events.repository";
import {
  handlerKey,
  inboxEventOf,
  STRIPE_ENDPOINT_FEATURES,
  STRIPE_EVENT_JOB,
  StripeEventFailure,
  stripeEventHandlers,
  stripeEventIdOf,
  type StripeEventHandler,
  type StripeEventOutcome,
  type StripeInboxEvent,
} from "../../common/stripe/stripe-inbox.service";
import { isLastTry, type JobTries } from "../../notifications/email.processor";

/** What a finished `stripe.event` job returns (BullMQ keeps it with the job): ids and the outcome, never a payload. */
export interface StripeEventResult {
  readonly eventId: string;
  /** `skipped` when the row was missing or done already. */
  readonly status: "processed" | "ignored" | "skipped";
}

/** A failure as the inbox records it. */
export interface DescribedFailure {
  /** `UNKNOWN_PRICE`, `STRIPE_API_ERROR`, `INTERNAL_ERROR`, … */
  readonly code: string;
  /** `<code>: <short message>`, for `last_error` and the job's failed reason. */
  readonly lastError: string;
  /** False when no retry can mend it: the attempts end at once. */
  readonly retryable: boolean;
  readonly tenantId: string | null;
}

/** The name of an error, when it is a plain identifier; never its message, which might quote a value. */
function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "Error";
}

/**
 * What the inbox records of an error thrown while an event was processed:
 *
 * - a handler's StripeEventFailure: its code and message, retryable as it says;
 * - StripeNotConfiguredError (no STRIPE_SECRET_KEY): `STRIPE_NOT_CONFIGURED`, not retryable;
 * - a Stripe API error: `STRIPE_<TYPE>` with the HTTP status and Stripe's code (never Stripe's message, which may quote
 *   parameters), retryable for a network failure, a rate limit or a 5xx;
 * - an AppError: its code and message, retryable for a 5xx;
 * - anything else (a database failure, a bug): `INTERNAL_ERROR` with the error's name, retryable.
 */
export function describeFailure(error: unknown): DescribedFailure {
  const described = (code: string, message: string, retryable: boolean, tenantId: string | null = null) => ({
    code,
    lastError: `${code}: ${message}`,
    retryable,
    tenantId,
  });
  if (error instanceof StripeEventFailure) {
    return described(error.code, error.message, error.options.retryable, error.options.tenantId ?? null);
  }
  if (error instanceof StripeNotConfiguredError) {
    return described("STRIPE_NOT_CONFIGURED", "STRIPE_SECRET_KEY is not set", false);
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
    return described(
      `STRIPE_${kind.toUpperCase()}`,
      `Stripe answered ${status === undefined ? "nothing" : String(status)}${code}`,
      retryable,
    );
  }
  if (error instanceof AppError) {
    return described(error.code, error.message, error.status >= 500);
  }
  return described("INTERNAL_ERROR", errorName(error), true);
}

@Processor(PLATFORM_QUEUE.stripeEvents, platformWorkerOptions(PLATFORM_QUEUE.stripeEvents))
export class StripeEventsProcessor extends WorkerHost {
  private handlers: Map<string, StripeEventHandler> | undefined;
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly repository: StripeEventsRepository,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    private readonly clock: Clock,
    private readonly features: FeatureSwitches,
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    @InjectPinoLogger(StripeEventsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<StripeEventResult> {
    if (job.name !== STRIPE_EVENT_JOB) {
      this.logger.error({ queue: PLATFORM_QUEUE.stripeEvents, job: job.name }, "stripe.unknown_job");
      throw new UnrecoverableError("platform-stripe-events has no job of this name");
    }
    const eventId = stripeEventIdOf(job.data);
    if (eventId === undefined) {
      this.logger.error({ queue: PLATFORM_QUEUE.stripeEvents, job: job.name }, "stripe.invalid_job");
      throw new UnrecoverableError("stripe.event needs { eventId: evt_… } and nothing else");
    }
    return this.processEvent(eventId, job);
  }

  /** One attempt for the stored event `eventId` (see the file header); `job` says whether BullMQ tries again. */
  async processEvent(eventId: string, job: JobTries): Promise<StripeEventResult> {
    const row = await this.repository.claim(this.db, eventId, this.clock.now());
    if (row === undefined) {
      this.logger.info({ eventId }, "stripe.event_skipped");
      return { eventId, status: "skipped" };
    }
    const event = inboxEventOf(row);
    const context = { eventId, eventType: event.type, endpoint: event.endpoint, attempt: event.attempt };
    let outcome: StripeEventOutcome;
    try {
      outcome = await this.route(event);
    } catch (error) {
      const failure = describeFailure(error);
      const final = !failure.retryable || isLastTry(job);
      await this.repository.fail(
        this.db,
        eventId,
        { error: failure.lastError, final, tenantId: failure.tenantId },
        this.clock.now(),
      );
      const line = { ...context, code: failure.code, final };
      if (final) {
        this.logger.error(line, "stripe.event_failed");
        throw new UnrecoverableError(failure.lastError);
      }
      this.logger.warn(line, "stripe.event_failed");
      // Not the error itself: BullMQ keeps the failed reason, and a database error may quote a value.
      throw new Error(failure.lastError);
    }
    await this.repository.finish(
      this.db,
      eventId,
      {
        status: outcome.status,
        lastError: outcome.status === "ignored" ? outcome.reason : null,
        tenantId: outcome.tenantId ?? null,
      },
      this.clock.now(),
    );
    if (outcome.status === "ignored") {
      this.logger.info({ ...context, reason: outcome.reason }, "stripe.event_ignored");
    } else {
      this.logger.info(context, "stripe.event_processed");
    }
    return { eventId, status: outcome.status };
  }

  /** Step 2: the switch of the event's endpoint, then the handler of its type. */
  private async route(event: StripeInboxEvent): Promise<StripeEventOutcome> {
    const feature = STRIPE_ENDPOINT_FEATURES[event.endpoint];
    if (!this.features.isEnabled(feature)) {
      return { status: "ignored", reason: `FEATURE_DISABLED: ${FEATURE_VARIABLES[feature]} is off` };
    }
    // Found on the first event, not at module init: the BullMQ worker may take a job before the init hooks ran.
    this.handlers ??= stripeEventHandlers(this.discovery.getProviders(), this.reflector);
    const handler = this.handlers.get(handlerKey(event.endpoint, event.type));
    if (handler === undefined) {
      return { status: "ignored", reason: `UNHANDLED_EVENT_TYPE: no handler for ${event.type}` };
    }
    return handler.handle(event);
  }

  /** Errors of the worker itself (its Redis connections); job failures are logged by `processEvent`. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: PLATFORM_QUEUE.stripeEvents, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}
