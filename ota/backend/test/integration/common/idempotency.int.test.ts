// Idempotent requests against PostgreSQL 16 and Redis 7 (OBE-014; architecture-booking.md §5.1): the API of
// test/support/create-test-app.ts on this file's database clone, with probe routes bound to three operations of the
// document that require `Idempotency-Key` (lookupBooking, createCheckoutPayment, completeCheckoutWithAirlineCard). The
// probes count their executions and answer what each test tells them to; the records are read back from the tenant
// schemas through `tenantTx`, as velexis_ota_app. Tenants and keys are inserted as the platform writes them (as
// velexis_migrator, the owner of the platform tables).
//
// Storefront requests carry what a storefront page sends with a state-changing request (the `__Host-vx_csrf` cookie,
// its copy in `X-CSRF-Token` and the storefront's `Origin`); key requests use a secret key, which the rate limits of
// the shopping row do not count.
import { randomBytes } from "node:crypto";
import { Body, Controller, HttpCode, Injectable, Post, Res } from "@nestjs/common";
import { hashApiKey } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type Selectable,
  type TenantDatabase,
  type TenantDb,
  type Transaction,
} from "@velexis/db";
import { AppError } from "@velexis/errors";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import type { Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IdempotencyHooksFor,
  requestHash,
  type IdempotencyHooks,
  type IdempotencyRecord,
  type IdempotencyResource,
  type IdempotencyResponse,
} from "../../../src/common/http/idempotency.service";
import { IdempotencyRepository } from "../../../src/common/http/idempotency.repository";
import { OpenApiOperation } from "../../../src/common/http/openapi-operation.decorator";
import { newId } from "../../../src/common/ids";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeHeaders, newApiKey, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const CHECKOUT_ID = "chk_0123456789ABCDEFGHJK";
const PAYMENT_ID = "pay_0123456789ABCDEFGHJK";
const BOOKING_ID = "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5";
const LOOKUP = { bookingReference: "VX7K2M", lastName: "Berg" };
const PAYMENT = { method: "card", termsAccepted: true };
/** How long a test waits for a request it sent to reach a point: well inside Vitest's 5 s, generous on a loaded CI. */
const WAIT = { timeout: 4_000, interval: 10 } as const;

type Answer = (input: unknown, res: Response) => unknown;

/** What each probe answers in the current test, and how often each ran. */
const answers: Record<"lookup" | "payment" | "airlineCard", Answer> = {
  lookup: () => ({ bookingId: BOOKING_ID }),
  payment: () => ({ id: PAYMENT_ID }),
  airlineCard: () => ({ id: BOOKING_ID }),
};
const executions = vi.fn<(probe: keyof typeof answers) => void>();

@Controller("__idempotency")
class IdempotencyProbe {
  @Post("lookup")
  @HttpCode(200)
  @OpenApiOperation("lookupBooking")
  async lookup(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    executions("lookup");
    return await answers.lookup(body, res);
  }

  @Post("checkouts/:checkoutId/payments")
  @OpenApiOperation("createCheckoutPayment")
  async payment(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    executions("payment");
    return await answers.payment(body, res);
  }

  @Post("checkouts/:checkoutId/airline-card-completion")
  @OpenApiOperation("completeCheckoutWithAirlineCard")
  async airlineCard(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    executions("airlineCard");
    return await answers.airlineCard(body, res);
  }
}

// completeCheckoutWithAirlineCard's hashInput is the application's own since OBE-051
// (AirlineCardCompletionIdempotencyHooks of src/payments/airline-card/airline-card-completion.service.ts): the probe of
// that operation is hashed with it, the card as `{brand, last4}`. Before OBE-051 this file registered a stand-in.

/** Whether the stand-in reconciliation job has decided the booking of a stored 504. */
let decided = false;

/** OBE-043's hooks as its task describes them: a 504 names its pending booking, decided replays build the 201. */
@Injectable()
@IdempotencyHooksFor(["createCheckoutPayment"])
class TimeoutHooks implements IdempotencyHooks {
  resourceOf(response: IdempotencyResponse): IdempotencyResource | undefined {
    const details = (response.body as { error?: { details?: { bookingId?: unknown } } } | undefined)?.error
      ?.details;
    return typeof details?.bookingId === "string" ? { type: "booking", id: details.bookingId } : undefined;
  }

  resolveReplay(record: IdempotencyRecord): Promise<IdempotencyResponse | undefined> {
    if (record.response.status !== 504 || record.resource === null || !decided) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      status: 201,
      headers: {},
      setCookie: [],
      body: { id: PAYMENT_ID, bookingId: record.resource.id },
    });
  }
}

type IdempotencyRow = Selectable<TenantDatabase["idempotency_keys"]>;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenants: TenantDb;
let alphaKey: string;
let betaKey: string;

async function insertTenant(key: string): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  return id;
}

/** Issues a secret test key of a tenant as the platform does. */
async function issueKey(tenantId: string): Promise<string> {
  const key = newApiKey("sk", "test");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
    })
    .execute();
  return key;
}

/** A new `Idempotency-Key`, as the SDK makes one per call. */
const newKey = (): string => `idem-${randomBytes(12).toString("hex")}`;

/** A storefront visitor of `host`: their CSRF cookie and what their pages send with a state-changing request. */
function visitor(host = "alpha.ota.example.com"): Readonly<Record<string, string>> {
  const csrf = randomBytes(32).toString("base64url");
  return {
    ...edgeHeaders(host),
    Origin: `https://${host}`,
    Cookie: `__Host-vx_csrf=${csrf}`,
    "X-CSRF-Token": csrf,
  };
}

const keyHeaders = (apiKey = alphaKey): Readonly<Record<string, string>> => ({ "X-Api-Key": apiKey });

const lookup = (headers: Readonly<Record<string, string>>, key: string, body: object = LOOKUP) =>
  request(api.server).post("/__idempotency/lookup").set(headers).set("Idempotency-Key", key).send(body);

const payment = (key: string, checkoutId = CHECKOUT_ID, body: object = PAYMENT) =>
  request(api.server)
    .post(`/__idempotency/checkouts/${checkoutId}/payments`)
    .set(keyHeaders())
    .set("Idempotency-Key", key)
    .send(body);

/** The records of `key` in a tenant's schema, read as the API reads them. */
async function recordsOf(schema: string, key: string): Promise<IdempotencyRow[]> {
  return await tenantTx(tenants, schema, (trx) =>
    trx.selectFrom("idempotency_keys").selectAll().where("key", "=", key).execute(),
  );
}

async function onlyRecordOf(key: string, schema = "tenant_alpha"): Promise<IdempotencyRow> {
  const rows = await recordsOf(schema, key);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** Every column of the record as text, as a dump of the table would show it. */
async function rowText(id: string): Promise<string> {
  const rows = await tenantTx(tenants, "tenant_alpha", async (trx) => {
    const { rows: found } = await sql<{ text: string }>`
      SELECT row_to_json(k)::text AS text FROM idempotency_keys k WHERE id = ${id}
    `.execute(trx);
    return found;
  });
  return rows[0]?.text ?? "";
}

/** A gate a probe waits on, so a test can send a request while the first one is still running. */
function gate(): { readonly wait: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return { wait, open };
}

// The clone, the tenants and their keys, and the application: one-time work, here with the budget of
// test/helpers/openapi.ts (the first application of the process parses and compiles the OTA document).
beforeAll(async () => {
  preloadOpenApiDocument();
  db = await createTestDatabase();
  redis = await useRedis();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-reader",
    logger: { error: () => undefined },
    max: 2,
  });
  tenants = createTenantDb(otaPool, { appEnv: "test" });
  alphaKey = await issueKey(await insertTenant("alpha"));
  betaKey = await issueKey(await insertTenant("beta"));
  api = await createTestApp({
    database: db,
    redis,
    controllers: [IdempotencyProbe],
    providers: [TimeoutHooks],
  });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(() => {
  executions.mockClear();
  answers.lookup = () => ({ bookingId: BOOKING_ID });
  answers.payment = () => ({ id: PAYMENT_ID });
  answers.airlineCard = () => ({ id: BOOKING_ID });
  decided = false;
});

describe("the same key and body", () => {
  it("runs the handler once and answers both requests alike, headers included [OBE-014 AC1]", async () => {
    answers.payment = (_input, res) => {
      res.setHeader("Location", `/v1/payments/${PAYMENT_ID}`);
      res.setHeader("ETag", '"1"');
      return {
        id: PAYMENT_ID,
        status: "requires_payment_method",
        amount: { amount: "120.50", currency: "EUR" },
      };
    };
    const key = newKey();

    const first = await payment(key);
    const second = await payment(key);

    expect(executions).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(201);
    for (const res of [first, second]) {
      expect([res.status, res.body, res.headers["location"], res.headers["etag"]]).toEqual([
        201,
        { id: PAYMENT_ID, status: "requires_payment_method", amount: { amount: "120.50", currency: "EUR" } },
        `/v1/payments/${PAYMENT_ID}`,
        '"1"',
      ]);
    }
    expect(second.headers["x-request-id"]).not.toBe(first.headers["x-request-id"]);
    expect(await onlyRecordOf(key)).toMatchObject({
      scope: expect.stringMatching(/^test:key_[0-9A-Za-z]+:createCheckoutPayment$/) as unknown,
      request_method: "POST",
      request_path: `/__idempotency/checkouts/${CHECKOUT_ID}/payments`,
      status: "completed",
      response_status: 201,
      response_headers: { location: `/v1/payments/${PAYMENT_ID}`, etag: '"1"' },
      locked_until: null,
      response_ciphertext: null,
    });
  });

  it("refuses the key for another body or another checkout: 409 IDEMPOTENCY_KEY_REUSED [OBE-014 AC1]", async () => {
    const key = newKey();
    await payment(key);

    const otherBody = await payment(key, CHECKOUT_ID, { ...PAYMENT, method: "paypal" });
    const otherCheckout = await payment(key, "chk_1123456789ABCDEFGHJK");

    expect(executions).toHaveBeenCalledTimes(1);
    for (const res of [otherBody, otherCheckout]) {
      expect([res.status, res.body.error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    }
  });

  it("makes a request sent while the first one runs wait for it, then replays its answer [OBE-014 AC1]", async () => {
    const running = gate();
    answers.lookup = async () => {
      await running.wait;
      return { bookingId: BOOKING_ID, expiresAt: "2026-10-18T10:30:00Z" };
    };
    const headers = visitor();
    const key = newKey();
    const reads = vi.spyOn(api.app.get(IdempotencyRepository), "lockByScopeAndKey");

    const first = lookup(headers, key).then((res) => res);
    await vi.waitFor(() => expect(executions).toHaveBeenCalledTimes(1), WAIT);
    const second = lookup(headers, key).then((res) => res);
    // The second request found the key taken and reads the record in flight until it is settled.
    await vi.waitFor(() => expect(reads).toHaveBeenCalled(), WAIT);
    expect((await onlyRecordOf(key)).status).toBe("processing");
    running.open();
    const [a, b] = await Promise.all([first, second]);

    expect(executions).toHaveBeenCalledTimes(1);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
    expect((await onlyRecordOf(key)).status).toBe("completed");
  });

  it("is kept apart per principal: another visitor or a key with the same key runs the handler again", async () => {
    const key = newKey();

    await lookup(visitor(), key);
    await lookup(visitor(), key);
    await lookup(keyHeaders(), key);

    expect(executions).toHaveBeenCalledTimes(3);
    const scopes = (await recordsOf("tenant_alpha", key)).map((row) => row.scope).sort();
    expect(scopes).toHaveLength(3);
    expect(scopes[0]).toMatch(/^test:edge-[0-9a-f]{16}:lookupBooking$/);
    expect(scopes[2]).toMatch(/^test:key_[0-9A-Za-z]+:lookupBooking$/);
  });

  it("keeps each tenant's records in its own schema (two tenants)", async () => {
    const key = newKey();
    answers.lookup = (body) => ({ bookingId: BOOKING_ID, lastName: (body as typeof LOOKUP).lastName });

    const alpha = await lookup(keyHeaders(alphaKey), key, { ...LOOKUP, lastName: "Alpha" });
    const beta = await lookup(keyHeaders(betaKey), key, { ...LOOKUP, lastName: "Beta" });
    const alphaAgain = await lookup(keyHeaders(alphaKey), key, { ...LOOKUP, lastName: "Alpha" });

    expect(executions).toHaveBeenCalledTimes(2);
    expect([alpha.body.lastName, beta.body.lastName, alphaAgain.body.lastName]).toEqual([
      "Alpha",
      "Beta",
      "Alpha",
    ]);
    expect((await onlyRecordOf(key, "tenant_alpha")).response_body).toMatchObject({ lastName: "Alpha" });
    expect((await onlyRecordOf(key, "tenant_beta")).response_body).toMatchObject({ lastName: "Beta" });
  });
});

describe("transient and final errors", () => {
  it("let the same key run again after a transient 503 or 502 PAYMENT_PROVIDER_ERROR [OBE-014 AC2]", async () => {
    for (const code of ["SERVICE_UNAVAILABLE", "PAYMENT_PROVIDER_ERROR"] as const) {
      executions.mockClear();
      let failures = 1;
      answers.lookup = () => {
        if (failures > 0) {
          failures -= 1;
          throw new AppError(code);
        }
        return { bookingId: BOOKING_ID };
      };
      const headers = visitor();
      const key = newKey();

      const failed = await lookup(headers, key);
      const afterFailure = await recordsOf("tenant_alpha", key);
      const retried = await lookup(headers, key);

      expect([code, failed.status, failed.body.error.code]).toEqual([
        code,
        code === "SERVICE_UNAVAILABLE" ? 503 : 502,
        code,
      ]);
      expect(afterFailure).toEqual([]);
      expect([code, retried.status, retried.body]).toEqual([code, 200, { bookingId: BOOKING_ID }]);
      expect(executions).toHaveBeenCalledTimes(2);
    }
  });

  it("replay a stored 422 without running the handler again [OBE-014 AC2]", async () => {
    answers.lookup = () => {
      throw new AppError("UNPROCESSABLE", { details: { reason: "probe" } });
    };
    const headers = visitor();
    const key = newKey();

    const first = await lookup(headers, key);
    const second = await lookup(headers, key);

    expect(executions).toHaveBeenCalledTimes(1);
    expect([first.status, first.body.error.code, first.body.error.requestId]).toEqual([
      422,
      "UNPROCESSABLE",
      first.headers["x-request-id"],
    ]);
    expect([second.status, second.body, second.headers["cache-control"]]).toEqual([
      422,
      first.body,
      "no-store",
    ]);
    expect(await onlyRecordOf(key)).toMatchObject({ status: "failed", response_status: 422 });
  });
});

describe("answers that carry a token", () => {
  it("are replayed from response_ciphertext; the plain columns hold no token [OBE-014 AC3]", async () => {
    const token = `vxbt_test_${randomBytes(24).toString("base64url")}`;
    answers.lookup = () => ({
      bookingId: BOOKING_ID,
      bookingToken: token,
      expiresAt: "2026-10-18T10:30:00Z",
    });
    const key = newKey();

    const first = await lookup(keyHeaders(), key);
    const record = await onlyRecordOf(key);
    const replay = await lookup(keyHeaders(), key);

    expect(executions).toHaveBeenCalledTimes(1);
    expect([first.status, first.body.bookingToken]).toEqual([200, token]);
    expect([replay.status, replay.body]).toEqual([200, first.body]);
    expect(record.response_body).toEqual({
      bookingId: BOOKING_ID,
      bookingToken: "[REDACTED]",
      expiresAt: "2026-10-18T10:30:00Z",
    });
    expect(record.encryption_key_id).toBe("local:v1");
    expect(record.response_ciphertext).toBeInstanceOf(Buffer);
    expect(await rowText(record.id)).not.toContain(token);
    expect(api.sink.text()).not.toContain(token);
    expect(api.sink.records()).toContainEqual(
      expect.objectContaining({ msg: "idempotency.replayed", operationId: "lookupBooking", encrypted: true }),
    );
  });

  it("replay the guest cookie of a storefront answer from the ciphertext too [OBE-014 AC3]", async () => {
    const token = `vxbt_test_${randomBytes(24).toString("base64url")}`;
    answers.lookup = (_input, res) => {
      res.cookie("__Host-vx_bt", token, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
      return { bookingId: BOOKING_ID, bookingToken: null };
    };
    const headers = visitor();
    const key = newKey();

    const first = await lookup(headers, key);
    const record = await onlyRecordOf(key);
    const replay = await lookup(headers, key);

    expect(executions).toHaveBeenCalledTimes(1);
    expect(first.headers["set-cookie"]).toEqual([expect.stringContaining(`__Host-vx_bt=${token};`)]);
    expect([replay.status, replay.body, replay.headers["set-cookie"]]).toEqual([
      200,
      { bookingId: BOOKING_ID, bookingToken: null },
      first.headers["set-cookie"],
    ]);
    expect(record.response_headers).toBeNull();
    expect(record.encryption_key_id).toBe("local:v1");
    expect(await rowText(record.id)).not.toContain(token);
  });
});

describe("the key and the body", () => {
  it("are validated first: a missing key or an invalid body is 400 and leaves no record", async () => {
    const headers = visitor();
    const key = newKey();

    const withoutKey = await request(api.server).post("/__idempotency/lookup").set(headers).send(LOOKUP);
    const invalid = await lookup(headers, key, { ...LOOKUP, bookingReference: "no spaces allowed" });
    const records = await recordsOf("tenant_alpha", key);
    const valid = await lookup(headers, key);

    expect([withoutKey.status, withoutKey.body.error.fieldErrors]).toEqual([
      400,
      [{ path: "/header/Idempotency-Key", code: "required", message: "Idempotency-Key is required" }],
    ]);
    expect([invalid.status, invalid.body.error.code]).toEqual([400, "VALIDATION_FAILED"]);
    expect(records).toEqual([]);
    expect(valid.status).toBe(200);
    expect(executions).toHaveBeenCalledTimes(1);
  });

  it("of a storefront visitor without a CSRF cookie are refused: 403 CSRF_TOKEN_INVALID", async () => {
    const res = await lookup(edgeHeaders("alpha.ota.example.com"), newKey());

    expect([res.status, res.body.error.code]).toEqual([403, "CSRF_TOKEN_INVALID"]);
    expect(executions).not.toHaveBeenCalled();
  });
});

describe("a record left in flight", () => {
  it("is taken over once its lease ran out; the first request's answer is not written over the second's", async () => {
    const stuck = gate();
    let calls = 0;
    answers.lookup = async () => {
      calls += 1;
      if (calls === 1) {
        await stuck.wait;
        return { bookingId: BOOKING_ID, attempt: 1 };
      }
      return { bookingId: BOOKING_ID, attempt: 2 };
    };
    const headers = visitor();
    const key = newKey();

    const first = lookup(headers, key).then((res) => res);
    await vi.waitFor(() => expect(executions).toHaveBeenCalledTimes(1), WAIT);
    // As if the process running the first request had died two minutes ago.
    await tenantTx(tenants, "tenant_alpha", (trx) =>
      trx
        .updateTable("idempotency_keys")
        .set({ locked_until: new Date(Date.now() - 1_000) })
        .where("key", "=", key)
        .execute(),
    );
    const second = await lookup(headers, key);
    stuck.open();
    const firstAnswer = await first;
    const third = await lookup(headers, key);

    expect(executions).toHaveBeenCalledTimes(2);
    expect([second.body.attempt, firstAnswer.body.attempt, third.body.attempt]).toEqual([2, 1, 2]);
    expect((await onlyRecordOf(key)).response_body).toEqual({ bookingId: BOOKING_ID, attempt: 2 });
  });
});

describe("hooks of later tasks", () => {
  it("hash the airline card as its brand and last 4 (OBE-051's hashInput) [OBE-014 AC1]", async () => {
    const completion = (card: Record<string, unknown>) => ({
      paymentId: PAYMENT_ID,
      expectedTotal: { amount: "120.50", currency: "EUR" },
      card: {
        brand: "VISA",
        holderName: "Anna Berg",
        number: "4242424242424242",
        expiryMonth: 12,
        expiryYear: 2030,
        securityCode: "123",
        ...card,
      },
    });
    const headers = visitor();
    const key = newKey();
    const send = (body: object) =>
      request(api.server)
        .post(`/__idempotency/checkouts/${CHECKOUT_ID}/airline-card-completion`)
        .set(headers)
        .set("Idempotency-Key", key)
        .send(body);

    const first = await send(completion({}));
    const sameCard = await send(completion({ securityCode: "999" }));
    const otherCard = await send(completion({ brand: "MASTERCARD", number: "5555555555554444" }));
    const record = await onlyRecordOf(key);

    expect(executions).toHaveBeenCalledTimes(1);
    expect([first.status, sameCard.status, sameCard.body]).toEqual([201, 201, first.body]);
    expect([otherCard.status, otherCard.body.error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    expect(await rowText(record.id)).not.toContain("4242424242424242");
    // The stored hash is the one of the card's brand and last 4, not of a body with the card number.
    const { card: _card, ...rest } = completion({});
    expect(record.request_hash).toBe(
      requestHash("completeCheckoutWithAirlineCard", {
        path: { checkoutId: CHECKOUT_ID },
        query: {},
        body: { ...rest, card: { brand: "VISA", last4: "4242" } },
      }),
    );
  });

  it("keep a 504 linked to its booking and answer its replays through resolveReplay (OBE-043)", async () => {
    answers.payment = () => {
      throw new AppError("SUPPLIER_TIMEOUT", { details: { bookingId: BOOKING_ID, replayed: false } });
    };
    const key = newKey();

    const timedOut = await payment(key);
    const undecided = await payment(key);
    decided = true;
    const confirmed = await payment(key);

    expect(executions).toHaveBeenCalledTimes(1);
    expect([timedOut.status, timedOut.body.error.code, undecided.status, undecided.body]).toEqual([
      504,
      "SUPPLIER_TIMEOUT",
      504,
      timedOut.body,
    ]);
    expect([confirmed.status, confirmed.body]).toEqual([201, { id: PAYMENT_ID, bookingId: BOOKING_ID }]);
    expect(await onlyRecordOf(key)).toMatchObject({
      status: "failed",
      response_status: 504,
      resource_type: "booking",
      resource_id: BOOKING_ID,
    });
  });
});

describe("the lease of a request in flight (FIX-W30-OTA)", () => {
  it("[FIX-W30-OTA AC4] is renewed only with the holder's lease: a lease taken over or an answered record is never renewed", async () => {
    const repository = api.app.get(IdempotencyRepository, { strict: false });
    const inAlpha = <T>(run: (trx: Transaction<TenantDatabase>) => Promise<T>): Promise<T> =>
      tenantTx(tenants, "tenant_alpha", run);
    const now = new Date();
    const lease = new Date(now.getTime() + 120_000);
    const id = newId("idk");
    const key = newKey();
    // A record in flight as a claim inserts it.
    expect(
      await inAlpha((trx) =>
        repository.insertProcessing(trx, {
          id,
          scope: "test:edge-0123456789abcdef:lookupBooking",
          key,
          requestMethod: "POST",
          requestPath: "/__idempotency/lookup",
          requestHash: "0".repeat(64),
          lockedUntil: lease,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          now,
        }),
      ),
    ).toBe(true);

    const renewedAt = new Date(now.getTime() + 30_000);
    const renewed = new Date(renewedAt.getTime() + 120_000);
    expect(await inAlpha((trx) => repository.extendLease(trx, id, lease, renewed, renewedAt))).toBe(true);
    expect(await onlyRecordOf(key)).toMatchObject({
      status: "processing",
      locked_until: renewed,
      updated_at: renewedAt,
    });
    // The old lease is not the token any more: a request that lost it renews nothing.
    expect(
      await inAlpha((trx) => repository.extendLease(trx, id, lease, new Date(renewed.getTime() + 1), now)),
    ).toBe(false);
    // A waiting request took it over (its lease ran out): the holder's next renewal finds another lease.
    const takenOver = new Date(renewed.getTime() + 5_000);
    await inAlpha((trx) => repository.renewLease(trx, id, takenOver, now));
    expect(
      await inAlpha((trx) =>
        repository.extendLease(trx, id, renewed, new Date(renewed.getTime() + 30_000), now),
      ),
    ).toBe(false);
    expect((await onlyRecordOf(key)).locked_until).toEqual(takenOver);
    // Once the answer is stored, nothing renews the record.
    expect(
      await inAlpha((trx) =>
        repository.complete(trx, id, takenOver, {
          status: "completed",
          responseStatus: 200,
          responseHeaders: null,
          responseBody: { bookingId: BOOKING_ID },
          responseCiphertext: null,
          encryptionKeyId: null,
          resourceType: null,
          resourceId: null,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          now,
        }),
      ),
    ).toBe(true);
    expect(
      await inAlpha((trx) =>
        repository.extendLease(trx, id, takenOver, new Date(takenOver.getTime() + 1), now),
      ),
    ).toBe(false);
    expect(await onlyRecordOf(key)).toMatchObject({ status: "completed", locked_until: null });
  });
});
