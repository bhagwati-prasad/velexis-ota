// The pure parts of the Stripe event inbox (PBE-043; PADR-0002 item 4): the only payload `stripe.event` takes, the
// inbox row of an event (ids and types, never the payload), the livemode rule and the bounded enqueue of the intake,
// and the registry of `@HandlesStripeEvents` handlers. The intake against PostgreSQL and Redis runs in
// test/integration/billing/billing-webhook.int.test.ts.
import { Injectable } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { stripeFixture } from "@velexis/testing/stripe";
import type { Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import type Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformBackendConfig } from "../../config";
import type { Clock } from "../clock";
import type { PlatformDb } from "../database";
import type { StripeEventInsert, StripeEventsRepository } from "./stripe-events.repository";
import {
  ENQUEUE_TIMEOUT_MS,
  handlerKey,
  HandlesStripeEvents,
  inboxEventOf,
  inboxRowOf,
  STRIPE_EVENT_JOB,
  stripeEventHandlers,
  stripeEventIdOf,
  StripeInboxService,
  type StripeEventOutcome,
} from "./stripe-inbox.service";

afterEach(() => {
  vi.useRealTimers();
});

describe("stripeEventIdOf", () => {
  it("accepts { eventId } with a Stripe event id, and nothing else", () => {
    expect(stripeEventIdOf({ eventId: "evt_1QyMn3Oq0Su5WxZ7Ab9Cd1Ef" })).toBe("evt_1QyMn3Oq0Su5WxZ7Ab9Cd1Ef");
    expect(stripeEventIdOf({ eventId: "evt_test_alpha_invoice_paid" })).toBe("evt_test_alpha_invoice_paid");
    for (const data of [
      undefined,
      null,
      "evt_1",
      [],
      {},
      { eventId: "in_test_alpha_1" },
      { eventId: "evt_" },
      { eventId: `evt_${"a".repeat(252)}` },
      { eventId: "evt_1", payload: { secret: "x" } },
    ]) {
      expect(stripeEventIdOf(data)).toBeUndefined();
    }
  });
});

describe("inboxRowOf", () => {
  it("[PBE-043] keeps the ids, the type, livemode, the API version and the creation time, never the payload", () => {
    const event = stripeFixture("checkout.session.completed") as unknown as Stripe.Event;
    const now = new Date("2026-01-15T10:00:00Z");
    const row = inboxRowOf("billing", event, now);

    expect(row).toEqual<StripeEventInsert>({
      id: event.id,
      endpoint: "billing",
      type: "checkout.session.completed",
      livemode: false,
      account: null,
      objectType: "checkout.session",
      objectId: "cs_test_alpha_1",
      apiVersion: event.api_version,
      stripeCreatedAt: new Date(event.created * 1000),
      receivedAt: now,
    });
    expect(JSON.stringify(row)).not.toContain("metadata");
  });

  it("keeps the connected account of a Connect event", () => {
    const event = stripeFixture("account.updated") as unknown as Stripe.Event;

    expect(inboxRowOf("connect_accounts", event, new Date(0))).toMatchObject({
      endpoint: "connect_accounts",
      account: "acct_test_alpha",
      objectType: "account",
      objectId: "acct_test_alpha",
    });
  });
});

/** A StripeInboxService on fakes, in `appEnv`; `add` is the queue's add. */
function inbox(appEnv: string, add: Queue["add"]) {
  const inserted: StripeEventInsert[] = [];
  const repository = {
    insertIfAbsent: (_db: unknown, row: StripeEventInsert) => {
      const fresh = !inserted.some((existing) => existing.id === row.id);
      inserted.push(row);
      return Promise.resolve(fresh);
    },
  } as unknown as StripeEventsRepository;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const config = { get: () => appEnv } as unknown as ConfigService<PlatformBackendConfig, true>;
  const service = new StripeInboxService(
    repository,
    {} as PlatformDb,
    new FakeClock() as unknown as Clock,
    { add } as unknown as Queue,
    logger as unknown as PinoLogger,
    config,
  );
  return { service, inserted, logger };
}

describe("StripeInboxService.receive", () => {
  const event = stripeFixture("invoice.paid") as unknown as Stripe.Event;

  it("[PBE-043] refuses an event of the other mode with livemode_mismatch on /livemode, and stores nothing", async () => {
    const add = vi.fn<Queue["add"]>();
    const test = inbox("test", add);
    const live = inbox("production", add);

    for (const [target, sent] of [
      [test, { ...event, livemode: true }],
      [live, event],
    ] as const) {
      const refused = await target.service.receive("billing", sent).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(AppError);
      expect(refused).toMatchObject({
        code: "VALIDATION_FAILED",
        fieldErrors: [{ path: "/livemode", code: "livemode_mismatch" }],
      });
      expect(target.inserted).toEqual([]);
    }
    expect(add).not.toHaveBeenCalled();
    expect(await live.service.receive("billing", { ...event, livemode: true })).toEqual({
      stored: true,
      enqueued: true,
    });
  });

  it("[PBE-043 AC1] stores a redelivered event once and queues stripe.event with the event id as job id", async () => {
    const add = vi.fn<Queue["add"]>().mockResolvedValue({} as Awaited<ReturnType<Queue["add"]>>);
    const { service, logger } = inbox("test", add);

    expect(await service.receive("billing", event)).toEqual({ stored: true, enqueued: true });
    expect(await service.receive("billing", event)).toEqual({ stored: false, enqueued: true });
    expect(add.mock.calls).toEqual([
      [STRIPE_EVENT_JOB, { eventId: event.id }, { jobId: event.id }],
      [STRIPE_EVENT_JOB, { eventId: event.id }, { jobId: event.id }],
    ]);
    expect(logger.info.mock.calls.map(([, msg]: unknown[]) => msg)).toEqual([
      "stripe.webhook_stored",
      "stripe.webhook_duplicate",
    ]);
  });

  it("[PBE-043] answers without the job when Redis fails or is slower than the budget (the sweep queues it)", async () => {
    vi.useFakeTimers();
    const failing = inbox(
      "test",
      vi.fn<Queue["add"]>().mockRejectedValue(new Error("Connection is closed.")),
    );
    const hanging = inbox("test", vi.fn<Queue["add"]>().mockReturnValue(new Promise(() => undefined)));

    expect(await failing.service.receive("billing", event)).toEqual({ stored: true, enqueued: false });
    const pending = hanging.service.receive("billing", event);
    await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);
    expect(await pending).toEqual({ stored: true, enqueued: false });
    for (const { logger } of [failing, hanging]) {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: event.id }),
        "stripe.webhook_enqueue_failed",
      );
    }
  });
});

describe("@HandlesStripeEvents", () => {
  @Injectable()
  @HandlesStripeEvents("billing", ["invoice.paid", "invoice.voided"])
  class InvoiceHandler {
    handle(): Promise<StripeEventOutcome> {
      return Promise.resolve({ status: "processed" });
    }
  }

  @Injectable()
  @HandlesStripeEvents("connect_accounts", ["account.updated"])
  class AccountHandler {
    handle(): Promise<StripeEventOutcome> {
      return Promise.resolve({ status: "processed" });
    }
  }

  @Injectable()
  @HandlesStripeEvents("billing", ["invoice.paid"])
  class SecondInvoiceHandler extends InvoiceHandler {}

  @Injectable()
  @HandlesStripeEvents("billing", ["customer.subscription.updated"])
  class NoHandleMethod {}

  const reflector = new Reflector();
  const provider = (metatype: new () => object) => ({ instance: new metatype(), metatype });

  it("finds the handlers among the providers, by endpoint and type", () => {
    const invoices = provider(InvoiceHandler);
    const accounts = provider(AccountHandler);
    const handlers = stripeEventHandlers(
      [invoices, accounts, { instance: {}, metatype: Object }, { instance: undefined, metatype: undefined }],
      reflector,
    );

    expect([...handlers.keys()]).toEqual([
      handlerKey("billing", "invoice.paid"),
      handlerKey("billing", "invoice.voided"),
      handlerKey("connect_accounts", "account.updated"),
    ]);
    expect(handlers.get(handlerKey("billing", "invoice.paid"))).toBe(invoices.instance);
    // An event type of one endpoint is not handled for the other.
    expect(handlers.get(handlerKey("connect_accounts", "invoice.paid"))).toBeUndefined();
  });

  it("refuses two handlers of one type, a handler without handle(), and declarations of another shape", () => {
    expect(() =>
      stripeEventHandlers([provider(InvoiceHandler), provider(SecondInvoiceHandler)], reflector),
    ).toThrow(/two handlers for invoice.paid/);
    expect(() => stripeEventHandlers([provider(NoHandleMethod)], reflector)).toThrow(
      /no handle\(event\) method/,
    );
    expect(() => HandlesStripeEvents("payments" as "billing", ["invoice.paid"])).toThrow(TypeError);
    expect(() => HandlesStripeEvents("billing", [])).toThrow(TypeError);
    expect(() => HandlesStripeEvents("billing", ["Invoice.Paid"])).toThrow(TypeError);
  });
});

describe("inboxEventOf", () => {
  it("gives a handler the row's ids and type and the attempt, never more", () => {
    const createdAt = new Date("2026-01-15T09:59:00Z");
    expect(
      inboxEventOf({
        id: "evt_test_1",
        endpoint: "billing",
        type: "invoice.paid",
        livemode: false,
        account: null,
        object_type: "invoice",
        object_id: "in_test_alpha_1",
        api_version: "2025-08-27.basil",
        stripe_created_at: createdAt,
        status: "processing",
        attempts: 2,
        last_error: "INTERNAL_ERROR: Error",
        tenant_id: null,
        received_at: createdAt,
        processed_at: null,
        updated_at: createdAt,
      }),
    ).toEqual({
      id: "evt_test_1",
      endpoint: "billing",
      type: "invoice.paid",
      livemode: false,
      account: null,
      objectType: "invoice",
      objectId: "in_test_alpha_1",
      apiVersion: "2025-08-27.basil",
      stripeCreatedAt: createdAt,
      attempt: 2,
    });
  });
});
