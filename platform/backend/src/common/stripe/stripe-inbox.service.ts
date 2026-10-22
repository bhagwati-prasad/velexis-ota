// The Stripe event inbox (PBE-043; PADR-0002 items 4 and 5, PADR-0015 item 4, subscription-billing flow §C and §D,
// platform/docs/architecture.md §2.1 "Stripe event inbox"). Two halves, shared by both webhook receivers:
//
// Intake (`StripeInboxService.receive`), after StripeSignatureGuard verified the signature on the raw body and the
// validation interceptor checked the event's shape:
//   1. `livemode` must match the deployment (`APP_ENV=production` means live): else `400 VALIDATION_FAILED` with the
//      field error `livemode_mismatch` on `/livemode`, and nothing is stored;
//   2. one insert into `stripe_events` (ids, type, `livemode`, account, object type and id, API version, creation
//      time; never the payload) with `ON CONFLICT DO NOTHING`, so a redelivered event is stored once; a database
//      failure is a `500` (the error filter), which Stripe retries for up to 3 days;
//   3. `stripe.event {eventId}` on `platform-stripe-events` with the event id as BullMQ job id, for a new event and a
//      duplicate alike: BullMQ adds one job per id, so a redelivery whose earlier enqueue was lost queues it, and any
//      other adds nothing. Redis down, or slower than ENQUEUE_TIMEOUT_MS, is logged (`stripe.webhook_enqueue_failed`)
//      and the delivery still answers `200`: the row is committed, and the `stripe_events.sweep` scheduler queues it
//      (architecture §9). Stripe is never called here, and the whole delivery stays well inside Stripe's 2 seconds.
//   Events are received and stored whatever the milestone switches say: processing decides (PADR-0015 item 4).
//
// Processing contract, for the one `platform-stripe-events` processor (billing/sync/stripe-events.processor.ts) and
// the handlers later tasks add: a provider class marked `@HandlesStripeEvents(endpoint, [types])` implements
// `handle(event)`, re-fetches the object from Stripe (never trusting the payload or the order of events, PADR-0002
// item 5), applies the change in its own transaction and resolves to `processed` or `ignored`; it throws
// StripeEventFailure for a failure with a code (`UNKNOWN_PRICE`), saying whether a retry can mend it. Handlers live in
// the modules that own the tables they change (BillingSyncModule, PaymentConnectionsModule) and are found by the
// processor among the worker's providers, so no module imports another for them.
//
// Log lines carry the endpoint, the event id and type; never the body, the signature or a secret.
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, SetMetadata } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Reflector } from "@nestjs/core";
import { AppError } from "@velexis/errors";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type Stripe from "stripe";
import type { PlatformBackendConfig } from "../../config";
import { Clock } from "../clock";
import { PLATFORM_DB, type PlatformDb } from "../database";
import type { Feature } from "../features";
import { PLATFORM_QUEUE } from "../queues/queue-names";
import {
  STRIPE_ENDPOINTS,
  StripeEventsRepository,
  type StripeEndpoint,
  type StripeEventInsert,
  type StripeEventRecord,
} from "./stripe-events.repository";

/** The job of `platform-stripe-events` that processes one stored event. */
export const STRIPE_EVENT_JOB = "stripe.event";

/** The payload of `stripe.event`: the event id, nothing else (ADR-0009). The BullMQ job id is the event id too. */
export interface StripeEventJobData {
  readonly eventId: string;
}

/** A Stripe event id as `stripe_events.id` allows it (`evt_`, letters, digits, underscores; at most 255). */
export const STRIPE_EVENT_ID = /^evt_[A-Za-z0-9_]{1,251}$/;

/** How long queueing `stripe.event` may take before the delivery answers without it (the sweep queues it later). */
export const ENQUEUE_TIMEOUT_MS = 1000;

/** The milestone switch whose processing each endpoint's events belong to (PADR-0015 item 4). */
export const STRIPE_ENDPOINT_FEATURES: Readonly<Record<StripeEndpoint, Feature>> = Object.freeze({
  billing: "stripe_billing",
  connect_accounts: "own_stripe",
});

/** The field error of an event whose `livemode` is not the deployment's. */
export const LIVEMODE_MISMATCH = Object.freeze({
  path: "/livemode",
  code: "livemode_mismatch",
  message: "The event's mode does not match this deployment.",
});

/** The event id of a `stripe.event` payload, or `undefined` when the payload is not `{ eventId: "evt_…" }`. */
export function stripeEventIdOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const eventId = (data as Partial<StripeEventJobData>).eventId;
  return Object.keys(data).length === 1 && typeof eventId === "string" && STRIPE_EVENT_ID.test(eventId)
    ? eventId
    : undefined;
}

/** Adds `stripe.event {eventId}` with the event id as job id (a no-op while BullMQ holds a job of that id). */
export async function addStripeEventJob(queue: Pick<Queue, "add">, eventId: string): Promise<void> {
  const data: StripeEventJobData = { eventId };
  await queue.add(STRIPE_EVENT_JOB, data, { jobId: eventId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const shortString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 255 ? value : null;

/** The inbox row of a verified event received at `now` (the columns of PADR-0002 item 4; never the payload). */
export function inboxRowOf(endpoint: StripeEndpoint, event: Stripe.Event, now: Date): StripeEventInsert {
  const data: unknown = event.data;
  const object: unknown = isRecord(data) ? data["object"] : undefined;
  const source = isRecord(object) ? object : {};
  return {
    id: event.id,
    endpoint,
    type: event.type,
    livemode: event.livemode,
    account: shortString((event as { account?: unknown }).account),
    objectType: shortString(source["object"]),
    objectId: shortString(source["id"]),
    apiVersion: shortString(event.api_version),
    stripeCreatedAt: new Date(event.created * 1000),
    receivedAt: now,
  };
}

/** What became of a delivery. */
export interface StripeInboxReceipt {
  /** False for an event the inbox held already. */
  readonly stored: boolean;
  /** False when Redis failed or was too slow: the sweep queues the event later. */
  readonly enqueued: boolean;
}

@Injectable()
export class StripeInboxService {
  private readonly live: boolean;

  constructor(
    private readonly repository: StripeEventsRepository,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    private readonly clock: Clock,
    @InjectQueue(PLATFORM_QUEUE.stripeEvents) private readonly queue: Queue,
    @InjectPinoLogger(StripeInboxService.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.live = config.get("APP_ENV", { infer: true }) === "production";
  }

  /** Steps 1 to 3 of the file header for a verified event of `endpoint`. */
  async receive(endpoint: StripeEndpoint, event: Stripe.Event): Promise<StripeInboxReceipt> {
    const context = { endpoint, eventId: event.id, eventType: event.type };
    if (event.livemode !== this.live) {
      this.logger.warn({ ...context, livemode: event.livemode }, "stripe.webhook_livemode_mismatch");
      throw new AppError("VALIDATION_FAILED", { fieldErrors: [{ ...LIVEMODE_MISMATCH }] });
    }
    const stored = await this.repository.insertIfAbsent(
      this.db,
      inboxRowOf(endpoint, event, this.clock.now()),
    );
    const enqueued = await this.enqueue(event.id, context);
    this.logger.info({ ...context, enqueued }, stored ? "stripe.webhook_stored" : "stripe.webhook_duplicate");
    return { stored, enqueued };
  }

  /** Queues `stripe.event`; resolves false, after one log line, when Redis fails or takes over ENQUEUE_TIMEOUT_MS. */
  private async enqueue(eventId: string, context: Record<string, unknown>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const added = addStripeEventJob(this.queue, eventId).then(
      () => "added" as const,
      (error: unknown) => {
        this.logger.warn({ ...context, err: error }, "stripe.webhook_enqueue_failed");
        return "failed" as const;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), ENQUEUE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([added, timedOut]);
      if (result === "timeout") {
        this.logger.warn({ ...context, timeoutMs: ENQUEUE_TIMEOUT_MS }, "stripe.webhook_enqueue_failed");
      }
      return result === "added";
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A stored event as a handler sees it: the inbox row's ids and type, never a payload. */
export interface StripeInboxEvent {
  readonly id: string;
  readonly endpoint: StripeEndpoint;
  readonly type: string;
  readonly livemode: boolean;
  readonly account: string | null;
  readonly objectType: string | null;
  /** The object to re-fetch from Stripe. */
  readonly objectId: string | null;
  readonly apiVersion: string | null;
  readonly stripeCreatedAt: Date;
  /** This attempt, counting from 1 (`stripe_events.attempts`). */
  readonly attempt: number;
}

/** The StripeInboxEvent of a claimed row. */
export function inboxEventOf(row: StripeEventRecord): StripeInboxEvent {
  const endpoint = (STRIPE_ENDPOINTS as readonly string[]).includes(row.endpoint)
    ? (row.endpoint as StripeEndpoint)
    : "billing";
  return {
    id: row.id,
    endpoint,
    type: row.type,
    livemode: row.livemode,
    account: row.account,
    objectType: row.object_type,
    objectId: row.object_id,
    apiVersion: row.api_version,
    stripeCreatedAt: row.stripe_created_at,
    attempt: row.attempts,
  };
}

/** How a handler's attempt ended. `tenantId` is the OTA the event was resolved to, when the handler found one. */
export type StripeEventOutcome =
  | { readonly status: "processed"; readonly tenantId?: string | null | undefined }
  | {
      readonly status: "ignored";
      /** Why, for `last_error` and the admin (no secret). */
      readonly reason: string;
      readonly tenantId?: string | null | undefined;
    };

/** A handler of some event types of one endpoint (see the file header). */
export interface StripeEventHandler {
  handle(event: StripeInboxEvent): Promise<StripeEventOutcome>;
}

/**
 * A failure a handler names: `code` and a short message without secrets go into `last_error` (`UNKNOWN_PRICE: …`).
 * `retryable: false` ends the attempts at once (the event is `failed` until an admin reprocesses it); `true` lets
 * BullMQ try again, as for any other error.
 */
export class StripeEventFailure extends Error {
  override readonly name = "StripeEventFailure";

  constructor(
    readonly code: string,
    message: string,
    readonly options: { readonly retryable: boolean; readonly tenantId?: string | null | undefined },
  ) {
    super(message);
  }
}

/** The metadata key of `@HandlesStripeEvents`. */
export const STRIPE_EVENT_HANDLER_METADATA = "velexis:stripe-event-handler";

/** What `@HandlesStripeEvents` declares. */
export interface StripeEventHandlerDeclaration {
  readonly endpoint: StripeEndpoint;
  readonly types: readonly string[];
}

const EVENT_TYPE = /^[a-z_]+(\.[a-z_]+)+$/;

/**
 * Marks an injectable class as the handler of `types` (exact Stripe event types, e.g. `invoice.paid`) of `endpoint`.
 * Throws for an endpoint that is not one of STRIPE_ENDPOINTS or a type of another shape.
 */
export function HandlesStripeEvents(endpoint: StripeEndpoint, types: readonly string[]): ClassDecorator {
  if (!(STRIPE_ENDPOINTS as readonly string[]).includes(endpoint)) {
    throw new TypeError("@HandlesStripeEvents(): not a Stripe webhook endpoint");
  }
  if (types.length === 0 || types.some((type) => !EVENT_TYPE.test(type))) {
    throw new TypeError("@HandlesStripeEvents(): list one or more Stripe event types such as invoice.paid");
  }
  const declaration: StripeEventHandlerDeclaration = Object.freeze({
    endpoint,
    types: Object.freeze([...types]),
  });
  return SetMetadata(STRIPE_EVENT_HANDLER_METADATA, declaration);
}

/** The key of a handler in the registry: `<endpoint> <type>`. */
export function handlerKey(endpoint: StripeEndpoint, type: string): string {
  return `${endpoint} ${type}`;
}

function isHandler(value: unknown): value is StripeEventHandler {
  return isRecord(value) && typeof value["handle"] === "function";
}

/**
 * The handlers among `providers` (instances of classes marked with `@HandlesStripeEvents`), by `handlerKey`. Throws
 * for a marked class without `handle` and for two handlers of one type of one endpoint.
 */
export function stripeEventHandlers(
  providers: ReadonlyArray<{ readonly instance: unknown; readonly metatype: unknown }>,
  reflector: Pick<Reflector, "get">,
): Map<string, StripeEventHandler> {
  const handlers = new Map<string, StripeEventHandler>();
  for (const { instance, metatype } of providers) {
    if (typeof metatype !== "function") {
      continue;
    }
    const declaration: unknown = reflector.get(STRIPE_EVENT_HANDLER_METADATA, metatype);
    if (!isRecord(declaration)) {
      continue;
    }
    const { endpoint, types } = declaration as unknown as StripeEventHandlerDeclaration;
    if (!isHandler(instance)) {
      throw new TypeError(`@HandlesStripeEvents("${endpoint}"): the class has no handle(event) method`);
    }
    for (const type of types) {
      const key = handlerKey(endpoint, type);
      if (handlers.has(key) && handlers.get(key) !== instance) {
        throw new TypeError(`@HandlesStripeEvents("${endpoint}"): two handlers for ${type}`);
      }
      handlers.set(key, instance);
    }
  }
  return handlers;
}
