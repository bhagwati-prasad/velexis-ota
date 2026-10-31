// The rules of the Connect account events (PBE-056; connect-account-events.handler.ts): which connections an event
// changes, how `account.updated` sets the status, when two reads of the connections differ, when a deauthorisation is
// older than the connection, which Stripe errors mean the account is out of reach, the handler's declaration for the
// inbox processor, and the rounds of `account.updated` (a write is confirmed by a re-fetch after its commit) over
// stand-ins of the repository, the database and Stripe. The writes themselves run against PostgreSQL in
// test/integration/connections/connect-events.int.test.ts.
import { Reflector } from "@nestjs/core";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import type { AuditService } from "../audit/audit.service";
import type { PlatformDb } from "../common/database";
import type { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import type { StripeClient } from "../common/stripe/stripe.client";
import {
  handlerKey,
  STRIPE_EVENT_HANDLER_METADATA,
  StripeEventFailure,
  stripeEventHandlers,
  type StripeInboxEvent,
} from "../common/stripe/stripe-inbox.service";
import type { OutboxService } from "../notifications/outbox.service";
import {
  ACCOUNT_DEAUTHORIZED,
  ACCOUNT_UPDATED,
  ConnectAccountEventsHandler,
  isAccountUnreachable,
  isDeauthorized,
  isDisabledByAdmin,
  isStaleDeauthorization,
  REFRESH_TRIES,
  refreshedStatus,
  sameCapabilities,
  sameRowVersions,
} from "./connect-account-events.handler";
import type {
  ConnectAccountRefresh,
  ConnectCapabilities,
  PaymentConnectionsRepository,
  PaymentConnectionView,
  PaymentEnvironment,
} from "./payment-connections.repository";

const ENABLED = { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true } as const;
const NOT_YET = { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: true } as const;
const AT = new Date("2026-01-15T10:00:00.000Z");
const TENANT = "ten_01JA2ZA1C5E9G3J7K2M6P00001";
const ACCOUNT = "acct_1QTestAgency";

/** A `connect_standard` connection of ACCOUNT as the repository reads it: `pending`, charges not enabled yet. */
function connectRow(
  environment: PaymentEnvironment,
  overrides: Partial<PaymentConnectionView> = {},
): PaymentConnectionView {
  return {
    id: `ppc_01JA2ZA1C5E9G3J7K2M6P0000${environment === "test" ? 1 : 2}`,
    tenant_id: TENANT,
    provider: "stripe",
    environment,
    account_mode: "connect_standard",
    account_reference: ACCOUNT,
    publishable_key: null,
    encryption_key_id: null,
    supported_methods: ["card"],
    capture_mode: "manual",
    is_default: true,
    status: "pending",
    statement_descriptor_suffix: null,
    capabilities: { ...NOT_YET },
    connected_at: new Date("2026-01-14T10:00:00Z"),
    disconnected_at: null,
    last_verified_at: null,
    last_error: null,
    created_by_account_id: null,
    version: 1,
    created_at: new Date("2026-01-14T10:00:00Z"),
    updated_at: new Date("2026-01-14T10:00:00Z"),
    ...overrides,
  };
}

/** An `account.updated` event of ACCOUNT as the inbox hands it to the handler. */
const UPDATED_EVENT: StripeInboxEvent = {
  id: "evt_1QTestAccountUpdated",
  endpoint: "connect_accounts",
  type: ACCOUNT_UPDATED,
  livemode: false,
  account: ACCOUNT,
  objectType: "account",
  objectId: ACCOUNT,
  apiVersion: null,
  stripeCreatedAt: AT,
  attempt: 1,
};

/**
 * The handler over stand-ins: the connections in memory (each write commits at once), Stripe answering the
 * capabilities of `answers` in turn (the last one again once they run out), and hooks that run before the n-th read of
 * the connections or after the n-th re-fetch has its answer.
 */
class RoundsHarness {
  rows: PaymentConnectionView[] = [connectRow("test"), connectRow("live")];
  answers: readonly ConnectCapabilities[] = [ENABLED];
  /** Thrown by the n-th re-fetch (from 1) instead of an answer. */
  readonly failures = new Map<number, Error>();
  /** Runs before the n-th read of the connections (from 1), as another writer would. */
  readonly beforeRead = new Map<number, () => void>();
  /** Runs after the n-th re-fetch (from 1) has its answer and before the handler gets it. */
  readonly afterRetrieve = new Map<number, () => void>();
  reads = 0;
  retrieves = 0;
  readonly audit: unknown[] = [];
  readonly events: unknown[] = [];
  readonly handler: ConnectAccountEventsHandler;

  constructor() {
    const ofAccount = (accountReference: string): PaymentConnectionView[] =>
      this.rows
        .filter(
          (row) => row.account_mode === "connect_standard" && row.account_reference === accountReference,
        )
        .map((row) => structuredClone(row));
    const repository = {
      connectRowsOfAccount: (accountReference: string) => {
        this.reads += 1;
        this.beforeRead.get(this.reads)?.();
        return Promise.resolve(ofAccount(accountReference));
      },
      lockConnectRowsOfAccount: (_trx: unknown, accountReference: string) =>
        Promise.resolve(ofAccount(accountReference)),
      refreshConnectAccount: (_trx: unknown, id: string, refresh: ConnectAccountRefresh) =>
        Promise.resolve(
          structuredClone(
            this.write(id, {
              capabilities: { ...refresh.capabilities },
              status: refresh.status,
              updated_at: refresh.now,
            }),
          ),
        ),
    };
    const stripe = {
      api: () => ({
        accounts: {
          retrieve: (id: string) => {
            this.retrieves += 1;
            const failure = this.failures.get(this.retrieves);
            if (failure !== undefined) {
              return Promise.reject(failure);
            }
            const capabilities = this.answers[Math.min(this.retrieves, this.answers.length) - 1] ?? ENABLED;
            this.afterRetrieve.get(this.retrieves)?.();
            return Promise.resolve({
              id,
              object: "account",
              charges_enabled: capabilities.chargesEnabled,
              payouts_enabled: capabilities.payoutsEnabled,
              details_submitted: capabilities.detailsSubmitted,
            });
          },
        },
      }),
    };
    const audit = {
      record: (_trx: unknown, entry: unknown) => {
        this.audit.push(entry);
        return Promise.resolve({ id: String(this.audit.length), createdAt: AT });
      },
    };
    const invalidations = {
      publishAfterCommit: (_trx: unknown, event: unknown) => {
        this.events.push(event);
      },
    };
    const db = {
      transaction: () => ({ execute: <T>(work: (trx: object) => Promise<T>): Promise<T> => work({}) }),
    };
    const logger = { info: () => undefined, warn: () => undefined };
    this.handler = new ConnectAccountEventsHandler(
      repository as unknown as PaymentConnectionsRepository,
      stripe as unknown as StripeClient,
      audit as unknown as AuditService,
      {} as OutboxService,
      invalidations as unknown as InvalidationPublisher,
      new FakeClock(AT),
      db as unknown as PlatformDb,
      logger as unknown as PinoLogger,
    );
  }

  /** Changes the stored connection `id` as a committed write does: the fields, and `version + 1`. */
  write(id: string, fields: Partial<PaymentConnectionView>): PaymentConnectionView {
    const index = this.rows.findIndex((row) => row.id === id);
    const current = this.rows[index];
    if (current === undefined) {
      throw new Error(`no connection ${id}`);
    }
    const written = { ...current, ...fields, version: current.version + 1 };
    this.rows[index] = written;
    return written;
  }

  /** The status and version of each stored connection, `test` first. */
  states(): Array<[string, number]> {
    return this.rows.map((row) => [row.status, row.version]);
  }
}

/** The error `work` throws, or `undefined`. */
async function thrown(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("Connect account event rules", () => {
  it("[PBE-056 AC2] account.updated turns pending active when charges are enabled, and back, and keeps other states", () => {
    expect(refreshedStatus("pending", ENABLED)).toBe("active");
    expect(refreshedStatus("active", NOT_YET)).toBe("pending");
    expect(refreshedStatus("active", ENABLED)).toBe("active");
    expect(refreshedStatus("pending", NOT_YET)).toBe("pending");
    // A disabled connection (deauthorised, or disabled by an admin) and one in error keep their status.
    expect(refreshedStatus("disabled", ENABLED)).toBe("disabled");
    expect(refreshedStatus("error", ENABLED)).toBe("error");
  });

  it("[PBE-056 AC1] tells a deauthorised connection from one a platform admin disabled", () => {
    expect(isDeauthorized({ status: "disabled", disconnected_at: AT })).toBe(true);
    expect(isDisabledByAdmin({ status: "disabled", disconnected_at: AT })).toBe(false);
    expect(isDeauthorized({ status: "disabled", disconnected_at: null })).toBe(false);
    expect(isDisabledByAdmin({ status: "disabled", disconnected_at: null })).toBe(true);
    for (const status of ["pending", "active", "error"]) {
      expect([status, isDeauthorized({ status, disconnected_at: null })]).toEqual([status, false]);
      expect([status, isDisabledByAdmin({ status, disconnected_at: null })]).toEqual([status, false]);
    }
  });

  it("compares the stored capabilities flag by flag", () => {
    expect(sameCapabilities({ ...ENABLED }, ENABLED)).toBe(true);
    expect(sameCapabilities({ ...ENABLED, payoutsEnabled: false }, ENABLED)).toBe(false);
    // The column's default `{}` and anything that is not the three flags differ.
    expect(sameCapabilities({}, ENABLED)).toBe(false);
    expect(sameCapabilities({ ...ENABLED, extra: true }, ENABLED)).toBe(false);
    expect(sameCapabilities(null, ENABLED)).toBe(false);
    expect(sameCapabilities([true, true, true], ENABLED)).toBe(false);
    expect(
      sameCapabilities({ chargesEnabled: "true", payoutsEnabled: true, detailsSubmitted: true }, ENABLED),
    ).toBe(false);
  });

  it("sees a connection written between the read and the lock as a change", () => {
    const rows = [
      { id: "ppc_a", version: 2 },
      { id: "ppc_b", version: 5 },
    ];

    expect(
      sameRowVersions(
        rows,
        rows.map((row) => ({ ...row })),
      ),
    ).toBe(true);
    expect(sameRowVersions(rows, [rows[0]!, { id: "ppc_b", version: 6 }])).toBe(false);
    expect(sameRowVersions(rows, [rows[0]!])).toBe(false);
    expect(sameRowVersions(rows, [...rows, { id: "ppc_c", version: 1 }])).toBe(false);
    expect(sameRowVersions(rows, [rows[1]!, rows[0]!])).toBe(false);
    expect(sameRowVersions([], [])).toBe(true);
  });

  it("[PBE-056 AC1] keeps a connection connected again after the deauthorisation, by whole seconds", () => {
    const connected = new Date("2026-01-15T10:00:00.400Z");

    expect(isStaleDeauthorization(new Date("2026-01-15T09:59:59.000Z"), connected)).toBe(true);
    // The same second as the connection still applies (Stripe's `created` has no milliseconds).
    expect(isStaleDeauthorization(new Date("2026-01-15T10:00:00.000Z"), connected)).toBe(false);
    expect(isStaleDeauthorization(new Date("2026-01-15T10:00:01.000Z"), connected)).toBe(false);
    expect(isStaleDeauthorization(new Date("2026-01-15T09:00:00.000Z"), null)).toBe(false);
  });

  it("reads a 403 or 404 of the account as out of reach, and every other error as a failure", () => {
    const raw = { message: "Stripe answered", type: "invalid_request_error" } as const;

    expect(isAccountUnreachable(new Stripe.errors.StripePermissionError({ ...raw, statusCode: 403 }))).toBe(
      true,
    );
    expect(
      isAccountUnreachable(
        new Stripe.errors.StripeInvalidRequestError({ ...raw, statusCode: 403, code: "account_invalid" }),
      ),
    ).toBe(true);
    expect(
      isAccountUnreachable(
        new Stripe.errors.StripeInvalidRequestError({ ...raw, statusCode: 404, code: "resource_missing" }),
      ),
    ).toBe(true);
    expect(
      isAccountUnreachable(
        new Stripe.errors.StripeAPIError({ message: "Stripe answered", type: "api_error", statusCode: 500 }),
      ),
    ).toBe(false);
    expect(
      isAccountUnreachable(
        new Stripe.errors.StripeAuthenticationError({
          message: "Stripe answered",
          type: "authentication_error",
          statusCode: 401,
        }),
      ),
    ).toBe(false);
    expect(
      isAccountUnreachable(
        new Stripe.errors.StripeConnectionError({ message: "unreachable", type: "api_error" }),
      ),
    ).toBe(false);
    expect(isAccountUnreachable(new Error("database down"))).toBe(false);
  });

  it("[PBE-056 AC2] writes what the re-fetch answers, then re-fetches after the commit to confirm it", async () => {
    const h = new RoundsHarness();

    const outcome = await h.handler.handle(UPDATED_EVENT);

    expect(outcome).toEqual({ status: "processed", tenantId: TENANT });
    expect(h.retrieves).toBe(2);
    expect(h.states()).toEqual([
      ["active", 2],
      ["active", 2],
    ]);
    expect(h.audit).toHaveLength(2);
    expect(h.events).toEqual([{ v: 1, type: "connection", tenantId: TENANT }]);
  });

  it("asks Stripe once when the re-fetch confirms the connections", async () => {
    const h = new RoundsHarness();
    h.answers = [NOT_YET];

    expect(await h.handler.handle(UPDATED_EVENT)).toEqual({ status: "processed", tenantId: TENANT });
    expect(h.retrieves).toBe(1);
    expect(h.states()).toEqual([
      ["pending", 1],
      ["pending", 1],
    ]);
    expect([h.audit, h.events]).toEqual([[], []]);
  });

  it("writes nothing when a connection changed during the re-fetch, and re-fetches", async () => {
    const h = new RoundsHarness();
    // Another writer changes the live connection while the first re-fetch waits for Stripe.
    h.afterRetrieve.set(1, () => h.write(connectRow("live").id, {}));

    expect(await h.handler.handle(UPDATED_EVENT)).toEqual({ status: "processed", tenantId: TENANT });
    // The re-fetch whose answer was dropped, the one that wrote, and the one that confirmed it.
    expect(h.retrieves).toBe(3);
    expect(h.states()).toEqual([
      ["active", 2],
      ["active", 3],
    ]);
    expect(h.audit).toHaveLength(2);
  });

  it("ends processed when the connections it wrote are deauthorised, gone or out of reach before the confirmation", async () => {
    const deauthorised = new RoundsHarness();
    deauthorised.beforeRead.set(2, () => {
      for (const row of [...deauthorised.rows]) {
        deauthorised.write(row.id, { status: "disabled", disconnected_at: AT });
      }
    });
    const gone = new RoundsHarness();
    gone.beforeRead.set(2, () => {
      gone.rows = [];
    });
    const refused = new RoundsHarness();
    refused.failures.set(
      2,
      new Stripe.errors.StripePermissionError({ message: "Stripe answered", type: "invalid_request_error" }),
    );

    for (const [label, h, retrieves] of [
      ["deauthorised", deauthorised, 1],
      ["gone", gone, 1],
      ["refused", refused, 2],
    ] as const) {
      expect([label, await h.handler.handle(UPDATED_EVENT), h.retrieves]).toEqual([
        label,
        { status: "processed", tenantId: TENANT },
        retrieves,
      ]);
      expect([label, h.audit.length]).toEqual([label, 2]);
    }
  });

  it("fails with the retryable CONNECTION_BUSY when no re-fetch confirms the connections", async () => {
    const h = new RoundsHarness();
    // Stripe's answer changes between every two re-fetches, so each round writes and none confirms.
    h.answers = Array.from({ length: REFRESH_TRIES }, (_, index) => (index % 2 === 0 ? ENABLED : NOT_YET));

    const error = await thrown(() => h.handler.handle(UPDATED_EVENT));

    expect(error).toBeInstanceOf(StripeEventFailure);
    expect(error).toMatchObject({ code: "CONNECTION_BUSY", options: { retryable: true, tenantId: TENANT } });
    expect(h.retrieves).toBe(REFRESH_TRIES);
    expect(h.audit).toHaveLength(2 * REFRESH_TRIES);
  });

  it("declares the two event types of the Connect endpoint for the inbox processor", () => {
    const reflector = new Reflector();
    const handler = Object.create(ConnectAccountEventsHandler.prototype) as ConnectAccountEventsHandler;

    expect(reflector.get(STRIPE_EVENT_HANDLER_METADATA, ConnectAccountEventsHandler)).toEqual({
      endpoint: "connect_accounts",
      types: [ACCOUNT_UPDATED, ACCOUNT_DEAUTHORIZED],
    });
    const handlers = stripeEventHandlers(
      [{ instance: handler, metatype: ConnectAccountEventsHandler }],
      reflector,
    );
    expect([...handlers.keys()].sort()).toEqual(
      [
        handlerKey("connect_accounts", "account.application.deauthorized"),
        handlerKey("connect_accounts", "account.updated"),
      ].sort(),
    );
  });
});
