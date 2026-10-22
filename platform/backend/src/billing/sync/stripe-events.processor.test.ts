// The `platform-stripe-events` processor (PBE-043; subscription-billing flow §D, PADR-0015 item 4) on fakes: how one
// attempt routes a claimed event (switch off, no handler, a handler), and what a failure records and tells BullMQ
// (retryable until the last attempt, final at once for an error no retry mends). The processor runs against
// PostgreSQL and Redis, with the real queue, in test/integration/billing/billing-webhook.int.test.ts.
import type { DiscoveryService } from "@nestjs/core";
import { Reflector } from "@nestjs/core";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { UnrecoverableError, type Job } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { FakeStripe } from "../../../test/support/fake-stripe";
import type { Clock } from "../../common/clock";
import type { PlatformDb } from "../../common/database";
import type { Feature, FeatureSwitches } from "../../common/features";
import { StripeNotConfiguredError } from "../../common/stripe/stripe.client";
import type {
  StripeEventFailureRecord,
  StripeEventFinish,
  StripeEventRecord,
  StripeEventsRepository,
} from "../../common/stripe/stripe-events.repository";
import {
  HandlesStripeEvents,
  STRIPE_EVENT_JOB,
  StripeEventFailure,
  type StripeEventOutcome,
  type StripeInboxEvent,
} from "../../common/stripe/stripe-inbox.service";
import { describeFailure, StripeEventsProcessor } from "./stripe-events.processor";

const NOW = new Date("2026-01-15T10:00:00Z");

/** A claimed row of `type` on `endpoint`, at `attempts`. */
function claimed(type: string, endpoint = "billing", attempts = 1): StripeEventRecord {
  return {
    id: "evt_test_unit_1",
    endpoint,
    type,
    livemode: false,
    account: null,
    object_type: "subscription",
    object_id: "sub_test_alpha_1",
    api_version: "2025-08-27.basil",
    stripe_created_at: NOW,
    status: "processing",
    attempts,
    last_error: null,
    tenant_id: null,
    received_at: NOW,
    processed_at: null,
    updated_at: NOW,
  };
}

/** What the handler of the tests does on its next call. */
type Behaviour = (event: StripeInboxEvent) => Promise<StripeEventOutcome>;

@HandlesStripeEvents("billing", ["customer.subscription.updated"])
class SubscriptionHandler {
  readonly seen: StripeInboxEvent[] = [];
  behaviour: Behaviour = () => Promise.resolve({ status: "processed", tenantId: "ten_test_alpha" });

  handle(event: StripeInboxEvent): Promise<StripeEventOutcome> {
    this.seen.push(event);
    return this.behaviour(event);
  }
}

interface Harness {
  readonly processor: StripeEventsProcessor;
  readonly handler: SubscriptionHandler;
  readonly finished: StripeEventFinish[];
  readonly failed: StripeEventFailureRecord[];
  readonly logs: Array<{ level: string; line: unknown; msg: unknown }>;
}

function harness(
  row: StripeEventRecord | undefined,
  on: readonly Feature[] = ["stripe_billing", "own_stripe"],
): Harness {
  const finished: StripeEventFinish[] = [];
  const failed: StripeEventFailureRecord[] = [];
  const repository = {
    claim: () => Promise.resolve(row),
    finish: (_db: unknown, _id: string, finish: StripeEventFinish) => {
      finished.push(finish);
      return Promise.resolve(true);
    },
    fail: (_db: unknown, _id: string, failure: StripeEventFailureRecord) => {
      failed.push(failure);
      return Promise.resolve(true);
    },
  } as unknown as StripeEventsRepository;
  const handler = new SubscriptionHandler();
  const discovery = {
    getProviders: () => [{ instance: handler, metatype: SubscriptionHandler }],
  } as unknown as DiscoveryService;
  const logs: Harness["logs"] = [];
  const log = (level: string) => (line: unknown, msg: unknown) => logs.push({ level, line, msg });
  const processor = new StripeEventsProcessor(
    repository,
    {} as PlatformDb,
    new FakeClock(NOW) as unknown as Clock,
    { isEnabled: (feature: Feature) => on.includes(feature) } as unknown as FeatureSwitches,
    discovery,
    new Reflector(),
    { info: log("info"), warn: log("warn"), error: log("error") } as unknown as PinoLogger,
  );
  return { processor, handler, finished, failed, logs };
}

/** The tries of a job of five attempts that has made `attemptsMade` before this one. */
const tries = (attemptsMade: number) => ({ attemptsMade, opts: { attempts: 5 } });

describe("StripeEventsProcessor: routing", () => {
  it("[PBE-043 AC2] ends an event of a switched-off endpoint ignored, without its handler", async () => {
    for (const [endpoint, off, variable] of [
      ["billing", "stripe_billing", "FEATURE_STRIPE_BILLING"],
      ["connect_accounts", "own_stripe", "FEATURE_OWN_STRIPE"],
    ] as const) {
      const on = (["stripe_billing", "own_stripe"] as const).filter((feature) => feature !== off);
      const { processor, handler, finished } = harness(
        claimed("customer.subscription.updated", endpoint),
        on,
      );

      expect(await processor.processEvent("evt_test_unit_1", tries(0))).toEqual({
        eventId: "evt_test_unit_1",
        status: "ignored",
      });
      expect(finished).toEqual([
        { status: "ignored", lastError: `FEATURE_DISABLED: ${variable} is off`, tenantId: null },
      ]);
      expect(handler.seen).toEqual([]);
    }
  });

  it("[PBE-043] ends an event type without a handler ignored, also a handled type of the other endpoint", async () => {
    for (const row of [
      claimed("invoice.paid"),
      claimed("customer.subscription.updated", "connect_accounts"),
    ]) {
      const { processor, handler, finished } = harness(row);

      expect((await processor.processEvent(row.id, tries(0))).status).toBe("ignored");
      expect(finished).toEqual([
        { status: "ignored", lastError: `UNHANDLED_EVENT_TYPE: no handler for ${row.type}`, tenantId: null },
      ]);
      expect(handler.seen).toEqual([]);
    }
  });

  it("[PBE-043] runs the type's handler, which re-fetches the object, and finishes with its outcome", async () => {
    const { processor, handler, finished, logs } = harness(claimed("customer.subscription.updated"));
    const stripe = new FakeStripe().put({ id: "sub_test_alpha_1", object: "subscription" });
    handler.behaviour = async (event) => {
      await stripe.api().subscriptions.retrieve(event.objectId ?? "");
      return { status: "processed", tenantId: "ten_test_alpha" };
    };

    expect(await processor.processEvent("evt_test_unit_1", tries(0))).toEqual({
      eventId: "evt_test_unit_1",
      status: "processed",
    });
    expect(handler.seen).toEqual([
      expect.objectContaining({ id: "evt_test_unit_1", objectId: "sub_test_alpha_1", attempt: 1 }),
    ]);
    expect(stripe.callsOf("subscriptions.retrieve").map((call) => call.id)).toEqual(["sub_test_alpha_1"]);
    expect(finished).toEqual([{ status: "processed", lastError: null, tenantId: "ten_test_alpha" }]);
    expect(logs.map(({ msg }) => msg)).toEqual(["stripe.event_processed"]);
  });

  it("keeps the reason and the tenant of an event the handler ignores", async () => {
    const { processor, handler, finished } = harness(claimed("customer.subscription.updated"));
    handler.behaviour = () =>
      Promise.resolve({ status: "ignored", reason: "NO_TENANT: no OTA has this customer" });

    expect((await processor.processEvent("evt_test_unit_1", tries(0))).status).toBe("ignored");
    expect(finished).toEqual([
      { status: "ignored", lastError: "NO_TENANT: no OTA has this customer", tenantId: null },
    ]);
  });

  it("skips an event that is missing or done, so a job that runs twice processes it once", async () => {
    const { processor, handler, finished, failed } = harness(undefined);

    expect(await processor.processEvent("evt_test_unit_1", tries(0))).toEqual({
      eventId: "evt_test_unit_1",
      status: "skipped",
    });
    expect([handler.seen, finished, failed]).toEqual([[], [], []]);
  });

  it("fails a job of another name or payload at once", async () => {
    const { processor } = harness(claimed("invoice.paid"));
    const job = (name: string, data: unknown) =>
      ({ name, data, attemptsMade: 0, opts: { attempts: 5 } }) as unknown as Job;

    await expect(processor.process(job("stripe.other", { eventId: "evt_test_unit_1" }))).rejects.toThrow(
      UnrecoverableError,
    );
    await expect(processor.process(job(STRIPE_EVENT_JOB, { eventId: "in_test_1" }))).rejects.toThrow(
      UnrecoverableError,
    );
    expect(await processor.process(job(STRIPE_EVENT_JOB, { eventId: "evt_test_unit_1" }))).toEqual({
      eventId: "evt_test_unit_1",
      status: "ignored",
    });
  });
});

describe("StripeEventsProcessor: failures", () => {
  it("[PBE-043] records attempts' errors as retryable until the last attempt, then failed for good", async () => {
    for (const [attemptsMade, final] of [
      [0, false],
      [3, false],
      [4, true],
    ] as const) {
      const { processor, handler, failed, finished, logs } = harness(
        claimed("customer.subscription.updated", "billing", attemptsMade + 1),
      );
      handler.behaviour = () => Promise.reject(FakeStripe.apiError(503));

      const thrown = await processor
        .processEvent("evt_test_unit_1", tries(attemptsMade))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown instanceof UnrecoverableError).toBe(final);
      expect((thrown as Error).message).toBe("STRIPE_API_ERROR: Stripe answered 503");
      expect(failed).toEqual([{ error: "STRIPE_API_ERROR: Stripe answered 503", final, tenantId: null }]);
      expect(finished).toEqual([]);
      expect(logs).toEqual([
        {
          level: final ? "error" : "warn",
          line: expect.objectContaining({ eventId: "evt_test_unit_1", code: "STRIPE_API_ERROR", final }),
          msg: "stripe.event_failed",
        },
      ]);
    }
  });

  it("[PBE-043] fails at once for a failure no retry mends (UNKNOWN_PRICE), keeping its tenant", async () => {
    const { processor, handler, failed } = harness(claimed("customer.subscription.updated"));
    handler.behaviour = () =>
      Promise.reject(
        new StripeEventFailure("UNKNOWN_PRICE", "price_test_x is linked to no plan", {
          retryable: false,
          tenantId: "ten_test_alpha",
        }),
      );

    await expect(processor.processEvent("evt_test_unit_1", tries(0))).rejects.toThrow(UnrecoverableError);
    expect(failed).toEqual([
      { error: "UNKNOWN_PRICE: price_test_x is linked to no plan", final: true, tenantId: "ten_test_alpha" },
    ]);
  });

  it("never puts an unknown error's message into the inbox or the job (it may quote a value)", async () => {
    const { processor, handler, failed } = harness(claimed("customer.subscription.updated"));
    handler.behaviour = () =>
      Promise.reject(
        new Error("duplicate key value violates unique constraint: Key (email)=(ana@example.com)"),
      );

    const thrown = await processor.processEvent("evt_test_unit_1", tries(0)).catch((error: unknown) => error);

    expect(failed).toEqual([{ error: "INTERNAL_ERROR: Error", final: false, tenantId: null }]);
    expect((thrown as Error).message).toBe("INTERNAL_ERROR: Error");
  });
});

describe("describeFailure", () => {
  it.each([
    [FakeStripe.apiError(500), "STRIPE_API_ERROR", true],
    [FakeStripe.apiError(429), "STRIPE_RATE_LIMIT_ERROR", true],
    [FakeStripe.connectionError(), "STRIPE_CONNECTION_ERROR", true],
    [FakeStripe.apiError(404, "resource_missing"), "STRIPE_INVALID_REQUEST_ERROR", false],
    [new StripeNotConfiguredError(), "STRIPE_NOT_CONFIGURED", false],
    [new StripeEventFailure("UNKNOWN_PRICE", "x", { retryable: false }), "UNKNOWN_PRICE", false],
    [new StripeEventFailure("LOCKED", "x", { retryable: true }), "LOCKED", true],
    [new AppError("SERVICE_UNAVAILABLE"), "SERVICE_UNAVAILABLE", true],
    [new AppError("CONFLICT"), "CONFLICT", false],
    [new TypeError("x is undefined"), "INTERNAL_ERROR", true],
    ["a string", "INTERNAL_ERROR", true],
  ])("%s is %s, retryable %s", (error, code, retryable) => {
    const described = describeFailure(error);

    expect([described.code, described.retryable]).toEqual([code, retryable]);
    expect(described.lastError.startsWith(`${code}: `)).toBe(true);
  });

  it("says the HTTP status and Stripe's code, never Stripe's message", () => {
    const error = FakeStripe.apiError(404, "resource_missing");

    expect(describeFailure(error).lastError).toBe(
      "STRIPE_INVALID_REQUEST_ERROR: Stripe answered 404 (resource_missing)",
    );
    expect(describeFailure(error).lastError).not.toContain(error.message);
  });
});

describe("the handler registry", () => {
  it("is read once, on the first event, from the worker's providers", async () => {
    const { processor } = harness(claimed("customer.subscription.updated"));
    const providers = vi.spyOn(
      (processor as unknown as { discovery: DiscoveryService }).discovery,
      "getProviders",
    );

    await processor.processEvent("evt_test_unit_1", tries(0));
    await processor.processEvent("evt_test_unit_1", tries(0));
    expect(providers).toHaveBeenCalledTimes(1);
  });
});
