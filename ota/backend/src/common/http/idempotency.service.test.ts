// The rules of idempotent requests (OBE-014; architecture-booking.md §5.1), without PostgreSQL: the service with an
// in-memory stand-in for `IdempotencyRepository` that keeps the SQL's semantics (one record per scope and key, the
// lease as the holder's token, deletes and renewals of records in flight only). The KEKs are the test process's
// (test/helpers/api-env.ts), so encryption and decryption are the real envelope of @velexis/crypto. The SQL, the
// interceptor and the pipeline around it are test/integration/common/idempotency.int.test.ts.
import type { DiscoveryService } from "@nestjs/core";
import type { OtaOperationId } from "@velexis/api-types/operations";
import { aadFor, decryptValue, DecryptionError, type KeyProvider } from "@velexis/crypto";
import type { TenantSchema } from "@velexis/db";
import { AppError } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testKeyProvider } from "../../../test/helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS } from "../../../test/helpers/openapi";
import type { RequestTenant } from "../../tenancy/tenant-context";
import type { TenantContext } from "../../tenancy/tenant-context";
import type { TenantTx } from "../../tenancy/tenant-tx";
import { Clock } from "../clock";
import { IdGenerator } from "../ids";
import type {
  IdempotencyOutcome,
  IdempotencyRepository,
  IdempotencyRow,
  NewIdempotencyRecord,
} from "./idempotency.repository";
import {
  IDEMPOTENCY_LEASE_MS,
  IDEMPOTENCY_RETENTION_MS,
  IDEMPOTENCY_WAIT_MS,
  IdempotencyHooksFor,
  IdempotencyService,
  idempotencyPrincipal,
  idempotencyScope,
  idempotentOperations,
  outcomeDisposition,
  requestHash,
  UnhashableIdempotentInputError,
  type IdempotencyClaim,
  type IdempotencyHooks,
  type IdempotencyResponse,
  type IdempotencyTicket,
  type IdempotentRequest,
} from "./idempotency.service";
import { loadOpenApiDocument, type OpenApiDocument } from "./openapi-validation.interceptor";

const SCHEMA = "tenant_alpha" as TenantSchema;

/** A storefront visitor of tenant alpha, without a session. */
const EDGE_GUEST: RequestTenant = {
  tenantId: "ten_01JA4CH3G1K4N7R0U3X6A9D2F5",
  key: "alpha",
  schemaName: SCHEMA,
  environment: "test",
  caller: { type: "edge", id: "edge" },
  actor: { type: "guest", id: null },
  requestId: "req-test-0001",
};
const CSRF = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5";

/**
 * The in-memory `IdempotencyRepository`: the semantics of its SQL on one table. The transaction argument is ignored;
 * `complete` and `release` act only on the record in flight whose lease is still the caller's.
 */
class MemoryRecords {
  readonly rows = new Map<string, IdempotencyRow>();

  insertProcessing(_trx: unknown, record: NewIdempotencyRecord): Promise<boolean> {
    if (this.find(record.scope, record.key) !== undefined) {
      return Promise.resolve(false);
    }
    this.rows.set(record.id, {
      id: record.id,
      scope: record.scope,
      key: record.key,
      request_method: record.requestMethod,
      request_path: record.requestPath,
      request_hash: record.requestHash,
      status: "processing",
      locked_until: record.lockedUntil,
      response_status: null,
      response_headers: null,
      response_body: null,
      response_ciphertext: null,
      encryption_key_id: null,
      resource_type: null,
      resource_id: null,
      expires_at: record.expiresAt,
      created_at: record.now,
      updated_at: record.now,
    });
    return Promise.resolve(true);
  }

  lockByScopeAndKey(_trx: unknown, scope: string, key: string): Promise<IdempotencyRow | undefined> {
    return Promise.resolve(this.find(scope, key));
  }

  renewLease(_trx: unknown, id: string, lockedUntil: Date, now: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row?.status === "processing") {
      this.rows.set(id, { ...row, locked_until: lockedUntil, updated_at: now });
    }
    return Promise.resolve();
  }

  complete(_trx: unknown, id: string, lease: Date, outcome: IdempotencyOutcome): Promise<boolean> {
    const row = this.held(id, lease);
    if (row === undefined) {
      return Promise.resolve(false);
    }
    // As jsonb would: a parsed copy of the JSON.
    const json = (value: unknown): IdempotencyRow["response_body"] =>
      value === null ? null : (JSON.parse(JSON.stringify(value)) as IdempotencyRow["response_body"]);
    this.rows.set(id, {
      ...row,
      status: outcome.status,
      locked_until: null,
      response_status: outcome.responseStatus,
      response_headers: json(outcome.responseHeaders),
      response_body: json(outcome.responseBody),
      response_ciphertext: outcome.responseCiphertext,
      encryption_key_id: outcome.encryptionKeyId,
      resource_type: outcome.resourceType,
      resource_id: outcome.resourceId,
      expires_at: outcome.expiresAt,
      updated_at: outcome.now,
    });
    return Promise.resolve(true);
  }

  release(_trx: unknown, id: string, lease: Date): Promise<boolean> {
    return Promise.resolve(this.held(id, lease) !== undefined && this.rows.delete(id));
  }

  deleteExpired(_trx: unknown, id: string, now: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row !== undefined && row.expires_at.getTime() <= now.getTime()) {
      this.rows.delete(id);
    }
    return Promise.resolve();
  }

  only(): IdempotencyRow {
    const [row, ...others] = [...this.rows.values()];
    if (row === undefined || others.length > 0) {
      throw new Error(`expected one record, found ${this.rows.size}`);
    }
    return row;
  }

  private find(scope: string, key: string): IdempotencyRow | undefined {
    return [...this.rows.values()].find((row) => row.scope === scope && row.key === key);
  }

  private held(id: string, lease: Date): IdempotencyRow | undefined {
    const row = this.rows.get(id);
    return row?.status === "processing" && row.locked_until?.getTime() === lease.getTime() ? row : undefined;
  }
}

let document: OpenApiDocument;
let keys: KeyProvider;

// Parsing and compiling the OTA document and loading the test KEKs are one-time work: here, within the budget of
// test/helpers/openapi.ts, not in the first test.
beforeAll(async () => {
  document = loadOpenApiDocument();
  keys = await testKeyProvider();
}, OPENAPI_SETUP_TIMEOUT_MS);

afterEach(() => {
  vi.useRealTimers();
});

interface Harness {
  readonly service: IdempotencyService;
  readonly records: MemoryRecords;
  readonly logger: { [K in "setContext" | "debug" | "info" | "warn" | "error"]: ReturnType<typeof vi.fn> };
}

function harness(tenant: RequestTenant = EDGE_GUEST, discovery?: Partial<DiscoveryService>): Harness {
  const records = new MemoryRecords();
  const clock = new Clock();
  const logger = { setContext: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const tx = { run: <T>(fn: (trx: never) => Promise<T>): Promise<T> => fn(undefined as never) };
  const tenants = { get: () => tenant, require: () => tenant };
  const service = new IdempotencyService(
    tx as unknown as TenantTx,
    tenants as unknown as TenantContext,
    records as unknown as IdempotencyRepository,
    clock,
    new IdGenerator(clock),
    keys,
    document,
    (discovery ?? { getProviders: () => [] }) as DiscoveryService,
    logger as unknown as PinoLogger,
  );
  service.onModuleInit();
  return { service, records, logger };
}

const LOOKUP = { bookingReference: "VX7K2M", lastName: "Berg" };

function lookup(key: string, body: unknown = LOOKUP): IdempotentRequest {
  return {
    operationId: "lookupBooking",
    key,
    method: "POST",
    path: "/v1/bookings/lookup",
    input: { path: {}, query: {}, body },
    csrfCookie: CSRF,
  };
}

function ticketOf(claim: IdempotencyClaim): IdempotencyTicket {
  if (claim.kind !== "execute") {
    throw new Error(`expected to run the request, got a ${claim.kind}`);
  }
  return claim.ticket;
}

function replayOf(claim: IdempotencyClaim): IdempotencyResponse {
  if (claim.kind !== "replay") {
    throw new Error(`expected a replay, got a ${claim.kind}`);
  }
  return claim.response;
}

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an AppError");
}

const KEY = "idem-0123456789abcdef";
const FOUND: IdempotencyResponse = {
  status: 200,
  headers: { "cache-control": "no-store" },
  setCookie: [],
  body: { bookingId: "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5", expiresAt: "2026-10-18T10:30:00.000Z" },
};

describe("the scope of a record", () => {
  it("is the environment, the actor or the visitor's CSRF cookie hash, and the operation", () => {
    const actorOf = (type: "customer" | "staff" | "api_key", id: string) =>
      idempotencyPrincipal({ caller: { type: "key", id: "key_01" }, actor: { type, id } }, CSRF);

    expect(actorOf("customer", "cus_01JA4CH3G1K4N7R0U3X6A9D2F5")).toBe("cus_01JA4CH3G1K4N7R0U3X6A9D2F5");
    expect(actorOf("staff", "stf_01JA4CH3G1K4N7R0U3X6A9D2F5")).toBe("stf_01JA4CH3G1K4N7R0U3X6A9D2F5");
    expect(actorOf("api_key", "key_01JA4CH3G1K4N7R0U3X6A9D2F5")).toBe("key_01JA4CH3G1K4N7R0U3X6A9D2F5");
    const visitor = idempotencyPrincipal(EDGE_GUEST, CSRF);
    expect(visitor).toMatch(/^edge-[0-9a-f]{16}$/);
    expect(visitor).not.toContain(CSRF);
    expect(idempotencyPrincipal(EDGE_GUEST, `${CSRF}x`)).not.toBe(visitor);
    expect(idempotencyScope("live", visitor, "completeCheckout")).toBe(`live:${visitor}:completeCheckout`);
  });

  it("is `service` for the OTA admin before a staff member is known, and the staff member after [OBE-060]", () => {
    const service = { type: "service", id: "service" } as const;

    expect(idempotencyPrincipal({ caller: service, actor: { type: "system", id: null } }, undefined)).toBe(
      "service",
    );
    expect(
      idempotencyPrincipal(
        { caller: service, actor: { type: "staff", id: "stf_01JA4CH3G1K4N7R0U3X6A9D2F5" } },
        undefined,
      ),
    ).toBe("stf_01JA4CH3G1K4N7R0U3X6A9D2F5");
  });

  it("needs the CSRF cookie of a storefront visitor without a session: 403 CSRF_TOKEN_INVALID", () => {
    for (const cookie of [undefined, ""]) {
      const error = (() => {
        try {
          return idempotencyPrincipal(EDGE_GUEST, cookie);
        } catch (thrown) {
          return thrown;
        }
      })();

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "CSRF_TOKEN_INVALID", status: 403 });
    }
  });

  it("keeps the requests of two visitors with the same key apart", async () => {
    const { service, records } = harness();
    const first = ticketOf(await service.claim(lookup(KEY)));
    await service.settle(first, FOUND);

    const other = await service.claim({ ...lookup(KEY), csrfCookie: `${CSRF}-other` });

    expect(other.kind).toBe("execute");
    expect(records.rows.size).toBe(2);
  });
});

describe("the request hash", () => {
  it("ignores the key order of the JSON, and covers the operation, the path, the query and the body", () => {
    const input = {
      path: { checkoutId: "chk_0123456789ABCDEFGHJK" },
      query: {},
      body: { a: 1, b: { c: [1, 2] } },
    };
    const hash = requestHash("createCheckoutPayment", input);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      requestHash("createCheckoutPayment", { body: { b: { c: [1, 2] }, a: 1 }, query: {}, path: input.path }),
    ).toBe(hash);
    for (const other of [
      requestHash("completeCheckout", input),
      requestHash("createCheckoutPayment", { ...input, path: { checkoutId: "chk_1123456789ABCDEFGHJK" } }),
      requestHash("createCheckoutPayment", { ...input, query: { include: "x" } }),
      requestHash("createCheckoutPayment", { ...input, body: { a: 1, b: { c: [2, 1] } } }),
    ]) {
      expect(other).not.toBe(hash);
    }
  });

  it("covers what a hashInput hook makes of the input: a card as its brand and last 4 [OBE-014 AC1]", () => {
    const { service } = harness();
    const asBrandAndLast4: IdempotencyHooks = {
      hashInput: (input) => {
        const body = input.body as { card: { brand: string; number: string } };
        return {
          ...input,
          body: { ...body, card: { brand: body.card.brand, last4: body.card.number.slice(-4) } },
        };
      },
    };
    service.register(["completeCheckoutWithAirlineCard"], asBrandAndLast4);
    const withCard = (number: string, securityCode: string) => ({
      path: { checkoutId: "chk_0123456789ABCDEFGHJK" },
      query: {},
      body: { paymentId: "pay_0123456789ABCDEFGHJK", card: { brand: "VISA", number, securityCode } },
    });

    const first = service.hashOf("completeCheckoutWithAirlineCard", withCard("4242424242424242", "123"));

    expect(service.hashOf("completeCheckoutWithAirlineCard", withCard("4242424242424242", "999"))).toBe(
      first,
    );
    expect(service.hashOf("completeCheckoutWithAirlineCard", withCard("4000056655665556", "123"))).not.toBe(
      first,
    );
    expect(first).toBe(
      requestHash("completeCheckoutWithAirlineCard", {
        ...withCard("4242424242424242", "123"),
        body: { paymentId: "pay_0123456789ABCDEFGHJK", card: { brand: "VISA", last4: "4242" } },
      }),
    );
  });

  it("never covers a card or document number, even without a hook: they count by their last 4", () => {
    const { service } = harness();
    const issue = (cardNumber: string, securityCode: string, passport: string) => ({
      path: { bookingId: "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5" },
      query: {},
      body: {
        formOfPayments: [
          {
            creditCard: {
              brand: "VISA",
              holder: "ANNA BERG",
              number: cardNumber,
              securityCode,
              expiryDate: "2030-12",
            },
          },
        ],
        travelers: [{ documents: [{ documentType: "PASSPORT", number: passport, birthPlace: "Bergen" }] }],
      },
    });
    // The card counts by its brand and last 4: its holder and expiry are no part of it (FIX-W29-SECURITY).
    const masked = {
      ...issue("", "", ""),
      body: {
        formOfPayments: [{ creditCard: { brand: "VISA", number: "4242" } }],
        travelers: [{ documents: [{ documentType: "PASSPORT", number: "7731" }] }],
      },
    };

    const hash = service.hashOf("consoleIssueBooking", issue("4242424242424242", "123", "NO4827731"));

    expect(hash).toBe(requestHash("consoleIssueBooking", masked));
    expect(hash).not.toBe(requestHash("consoleIssueBooking", issue("4242424242424242", "123", "NO4827731")));
    expect(service.hashOf("consoleIssueBooking", issue("4000056655664242", "999", "SE1237731"))).toBe(hash);
    expect(service.hashOf("consoleIssueBooking", issue("4000056655665556", "123", "NO4827731"))).not.toBe(
      hash,
    );
  });

  it("[FIX-W26-SECURITY AC4] never covers a form-of-identification number either: it counts by its last 4, as a document number does", () => {
    const { service } = harness();
    // Test values only: made-up passport and driving licence numbers of an Amadeus order request.
    const order = (passport: string, licence: string) => ({
      path: {},
      query: {},
      body: {
        data: {
          type: "flight-order",
          formOfIdentifications: [
            { identificationType: "PASSPORT", carrierCode: "IB", number: passport, travelerIds: ["1"] },
            { identificationType: "DRIVERS_LICENSE", number: licence, travelerIds: ["2"] },
          ],
        },
      },
    });

    const hash = service.hashOf("consoleAmadeusCreateFlightOrders", order("PX48213579", "DL90817263"));

    expect(hash).toBe(requestHash("consoleAmadeusCreateFlightOrders", order("3579", "7263")));
    expect(hash).not.toBe(requestHash("consoleAmadeusCreateFlightOrders", order("PX48213579", "DL90817263")));
    expect(service.hashOf("consoleAmadeusCreateFlightOrders", order("XY11113579", "AB00007263"))).toBe(hash);
    expect(service.hashOf("consoleAmadeusCreateFlightOrders", order("PX48213570", "DL90817263"))).not.toBe(
      hash,
    );
  });

  it("refuses a password before anything is hashed or stored, also in what a hook returns; a hook can leave it out", async () => {
    const { service, records } = harness();
    const signIn = (body: unknown): IdempotentRequest => ({
      operationId: "signIn",
      key: KEY,
      method: "POST",
      path: "/v1/auth/sign-in",
      input: { path: {}, query: {}, body },
      csrfCookie: CSRF,
    });
    const body = { email: "anna.berg@example.com", password: "Fjord-Lights-2026", rememberMe: true };

    const refused = await service.claim(signIn(body)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(UnhashableIdempotentInputError);
    expect(String(refused)).not.toContain(body.password);
    expect(() =>
      service.hashOf("changePassword", { path: {}, query: {}, body: { newPassword: "x" } }),
    ).toThrow(UnhashableIdempotentInputError);
    expect(records.rows.size).toBe(0);

    service.register(["signIn"], { hashInput: (input) => input });
    await expect(service.claim(signIn(body))).rejects.toBeInstanceOf(UnhashableIdempotentInputError);

    const other = harness();
    other.service.register(["signIn"], {
      hashInput: (input) => ({ ...input, body: { email: (input.body as typeof body).email } }),
    });
    expect((await other.service.claim(signIn(body))).kind).toBe("execute");
    expect(other.records.only().request_hash).toBe(
      requestHash("signIn", { path: {}, query: {}, body: { email: body.email } }),
    );
  });
});

describe("outcomes", () => {
  it("stores successes and final 4xx; releases 429 and 5xx, except a 504 linked to a resource [OBE-014 AC2]", () => {
    for (const [status, linked, expected] of [
      [200, false, "store"],
      [201, false, "store"],
      [202, false, "store"],
      [204, false, "store"],
      [400, false, "store"],
      [404, false, "store"],
      [409, false, "store"],
      [422, false, "store"],
      [429, false, "release"],
      [500, false, "release"],
      [502, false, "release"],
      [503, false, "release"],
      [503, true, "release"],
      [504, false, "release"],
      [504, true, "store"],
    ] as const) {
      expect([status, linked, outcomeDisposition(status, linked)]).toEqual([status, linked, expected]);
    }
  });

  it("replays a stored answer instead of running the request again, and refuses the key for another body [OBE-014 AC1]", async () => {
    const { service, records } = harness();
    const ticket = ticketOf(await service.claim(lookup(KEY)));
    await service.settle(ticket, FOUND);

    const replay = replayOf(await service.claim(lookup(KEY)));
    const reused = await rejectionOf(service.claim(lookup(KEY, { ...LOOKUP, lastName: "Lind" })));

    expect(replay).toEqual(FOUND);
    expect([reused.code, reused.status]).toEqual(["IDEMPOTENCY_KEY_REUSED", 409]);
    expect(records.only()).toMatchObject({
      status: "completed",
      response_status: 200,
      response_headers: { "cache-control": "no-store" },
      response_body: FOUND.body,
      response_ciphertext: null,
      encryption_key_id: null,
      locked_until: null,
    });
  });

  it("releases the key after a transient answer and replays a stored 422 [OBE-014 AC2]", async () => {
    const { service, records } = harness();
    const unavailable: IdempotencyResponse = {
      status: 503,
      headers: { "cache-control": "no-store" },
      setCookie: [],
      body: { error: { code: "SERVICE_UNAVAILABLE", status: 503 } },
    };
    const unprocessable: IdempotencyResponse = {
      status: 422,
      headers: { "cache-control": "no-store" },
      setCookie: [],
      body: { error: { code: "UNPROCESSABLE", status: 422, requestId: "req-test-0001" } },
    };

    await service.settle(ticketOf(await service.claim(lookup(KEY))), unavailable);
    expect(records.rows.size).toBe(0);
    await service.settle(ticketOf(await service.claim(lookup(KEY))), unprocessable);

    expect(replayOf(await service.claim(lookup(KEY)))).toEqual(unprocessable);
    expect(records.only()).toMatchObject({ status: "failed", response_status: 422 });
  });

  it("keeps an answer with a token only encrypted, and replays it decrypted [OBE-014 AC3]", async () => {
    const { service, records } = harness();
    const token = "vxbt_test_Rk2mP9wQ4tL7xC1vB8nZ3hJ6dF0sG5aY";
    const issued: IdempotencyResponse = {
      status: 200,
      headers: {},
      setCookie: [`__Host-vx_bt=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`],
      body: { bookingId: "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5", bookingToken: token },
    };
    const ticket = ticketOf(await service.claim(lookup(KEY)));
    await service.settle(ticket, issued);

    const row = records.only();
    const replay = replayOf(await service.claim(lookup(KEY)));

    expect(replay).toEqual(issued);
    expect(row.response_body).toEqual({
      bookingId: "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5",
      bookingToken: "[REDACTED]",
    });
    expect(row.response_headers).toBeNull();
    expect(row.encryption_key_id).toBe("local:v1");
    expect(row.response_ciphertext).toBeInstanceOf(Buffer);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.response_ciphertext?.toString("latin1")).not.toContain(token);
    // Bound to its row: the same ciphertext does not open as another record's or another tenant's.
    await expect(
      decryptValue(row.response_ciphertext as Buffer, {
        aad: aadFor(SCHEMA, "idempotency_keys", "response_ciphertext", "idk_other"),
        keys,
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
    await expect(
      decryptValue(row.response_ciphertext as Buffer, {
        aad: aadFor("tenant_beta", "idempotency_keys", "response_ciphertext", row.id),
        keys,
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("stores no plain copy of a body that carries none, and encrypts an answer that only sets a cookie", async () => {
    const { service, records } = harness();
    const noContent: IdempotencyResponse = {
      status: 204,
      headers: {},
      setCookie: ["__Host-vx_at=x; Path=/"],
      body: undefined,
    };
    await service.settle(ticketOf(await service.claim(lookup(KEY))), noContent);

    expect(records.only()).toMatchObject({ response_body: null, encryption_key_id: "local:v1" });
    expect(replayOf(await service.claim(lookup(KEY)))).toEqual(noContent);
  });

  it("logs and swallows a failure to store an outcome: the answer is sent either way", async () => {
    const { service, records, logger } = harness();
    vi.spyOn(records, "complete").mockRejectedValueOnce(new Error("connection terminated"));
    const ticket = ticketOf(await service.claim(lookup(KEY)));

    await expect(service.settle(ticket, FOUND)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "lookupBooking" }),
      "idempotency.settle_failed",
    );
    expect(records.only().status).toBe("processing");
  });
});

describe("a request in flight", () => {
  it("makes a request with its key wait, then replays its answer [OBE-014 AC1]", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { service } = harness();
    const ticket = ticketOf(await service.claim(lookup(KEY)));
    let settled: IdempotencyClaim | undefined;
    const waiting = service.claim(lookup(KEY)).then((claim) => (settled = claim));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBeUndefined();
    await service.settle(ticket, FOUND);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;

    expect(settled === undefined ? undefined : replayOf(settled)).toEqual(FOUND);
  });

  it("answers 409 CONFLICT when it is still running after 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { service } = harness();
    ticketOf(await service.claim(lookup(KEY)));
    const started = Date.now();
    const waiting = rejectionOf(service.claim(lookup(KEY)));

    await vi.advanceTimersByTimeAsync(IDEMPOTENCY_WAIT_MS + 1_000);
    const conflict = await waiting;

    expect([conflict.code, conflict.status, conflict.details]).toEqual([
      "CONFLICT",
      409,
      { reason: "idempotency_key_in_use" },
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(IDEMPOTENCY_WAIT_MS);
  });

  it("runs the request again when the lease of the first one ran out; the first one's outcome is not written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { service, records, logger } = harness();
    const first = ticketOf(await service.claim(lookup(KEY)));

    vi.setSystemTime(Date.now() + IDEMPOTENCY_LEASE_MS + 1);
    const second = ticketOf(await service.claim(lookup(KEY)));
    await service.settle(first, FOUND);

    expect(second.id).toBe(first.id);
    expect(second.lease.getTime()).toBeGreaterThan(first.lease.getTime());
    expect(records.only().status).toBe("processing");
    expect(logger.warn).toHaveBeenCalledWith(
      { operationId: "lookupBooking" },
      "idempotency.lease_taken_over",
    );
    expect(logger.warn).toHaveBeenCalledWith({ operationId: "lookupBooking" }, "idempotency.lease_lost");
  });

  it("starts afresh, with any body, once the record's 24 hours have passed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { service, records } = harness();
    const first = ticketOf(await service.claim(lookup(KEY)));
    await service.settle(first, FOUND);

    vi.setSystemTime(Date.now() + IDEMPOTENCY_RETENTION_MS);
    const again = ticketOf(await service.claim(lookup(KEY, { ...LOOKUP, lastName: "Lind" })));

    expect(again.id).not.toBe(first.id);
    expect(records.only()).toMatchObject({ id: again.id, status: "processing" });
  });
});

describe("hooks", () => {
  const STATUS = {
    status: 504,
    headers: { "cache-control": "no-store" },
    setCookie: [],
    body: {
      error: {
        code: "SUPPLIER_TIMEOUT",
        status: 504,
        details: { bookingId: "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5" },
      },
    },
  } satisfies IdempotencyResponse;

  it("keep a 504 linked to its booking and let resolveReplay answer for it (OBE-043)", async () => {
    const { service, records } = harness();
    const confirmed: IdempotencyResponse = {
      status: 201,
      headers: {},
      setCookie: [],
      body: { id: "bkg_01JA4" },
    };
    const resolveReplay = vi.fn(() => Promise.resolve(confirmed));
    service.register(["lookupBooking"], {
      resourceOf: (response) => {
        const details = (response.body as { error?: { details?: { bookingId?: string } } }).error?.details;
        return details?.bookingId === undefined ? undefined : { type: "booking", id: details.bookingId };
      },
      resolveReplay,
    });
    await service.settle(ticketOf(await service.claim(lookup(KEY))), STATUS);

    const replay = replayOf(await service.claim(lookup(KEY)));

    expect(records.only()).toMatchObject({
      status: "failed",
      response_status: 504,
      resource_type: "booking",
      resource_id: "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5",
    });
    expect(resolveReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "lookupBooking",
        status: "failed",
        response: STATUS,
        resource: { type: "booking", id: "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5" },
      }),
    );
    expect(replay).toEqual(confirmed);
  });

  it("come from the providers marked @IdempotencyHooksFor, one provider per hook", () => {
    const hooks: IdempotencyHooks = { hashInput: () => "same" };
    const wrapper = { name: "Hooks", instance: hooks, isDependencyTreeStatic: () => true };
    const discovery: Partial<DiscoveryService> = {
      getProviders: () => [wrapper] as unknown as ReturnType<DiscoveryService["getProviders"]>,
      getMetadataByDecorator: (() => [
        "lookupBooking",
      ]) as unknown as DiscoveryService["getMetadataByDecorator"],
    };

    const { service } = harness(EDGE_GUEST, discovery);

    expect(service.hashOf("lookupBooking", { path: {}, query: {}, body: LOOKUP })).toBe(
      requestHash("lookupBooking", "same"),
    );
    expect(() => service.register(["lookupBooking"], { hashInput: () => "other" })).toThrow(
      "Two idempotency hashInput hooks for lookupBooking",
    );
    expect(typeof IdempotencyHooksFor.KEY).toBe("string");
  });

  it("are refused for an operation that takes no Idempotency-Key", () => {
    const { service } = harness();

    expect(() => service.register(["getStorefront" as OtaOperationId], { hashInput: () => null })).toThrow(
      "Idempotency hooks for getStorefront, which does not require Idempotency-Key",
    );
  });
});

describe("the idempotent operations", () => {
  it("are the document's operations whose Idempotency-Key header is required, all of them POST", () => {
    const operations = idempotentOperations(document);

    expect([...operations]).toEqual(
      expect.arrayContaining([
        "createFlightSearch",
        "priceFlightOffers",
        "completeCheckout",
        "lookupBooking",
      ]),
    );
    expect(operations.has("getStorefront")).toBe(false);
    expect(operations.has("updatePayment")).toBe(false);
    for (const operationId of operations) {
      expect([operationId, document.operation(operationId).method]).toEqual([operationId, "post"]);
    }
  });
});
