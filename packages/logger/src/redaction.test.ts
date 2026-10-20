import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pinoHttp from "pino-http";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, type Logger } from "./create-logger.js";
import { pinoHttpOptions } from "./http.js";
import { REDACT_CENSOR, REDACT_PATHS } from "./redact-paths.js";

// Test data only: Visa's documented test PAN, a made-up password and a made-up bearer token.
const TEST_PAN = "4111111111111111";
const TEST_PAN_LAST_12 = TEST_PAN.slice(-12);
const TEST_CVV = "123";
const TEST_PASSWORD = "Hunter2!";
const TEST_BEARER_TOKEN = "test-only-bearer-7d1e2f3a4b5c6d7e8f90";
// A fixed request id: a generated UUID contains the CVV digits "123" in about 1 run of 200.
const REQUEST_ID = "req-redaction-ac1";

type LogRecord = Record<string, unknown>;

/** A pino destination that keeps every line in memory. */
function memorySink(): { write: (line: string) => void; lines: string[]; records: () => LogRecord[] } {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
    records: () => lines.map((line) => JSON.parse(line) as LogRecord),
  };
}

function testLogger(): { logger: Logger; sink: ReturnType<typeof memorySink> } {
  const sink = memorySink();
  return { logger: createLogger({ app: "ota-api", env: "test", level: "debug", destination: sink }), sink };
}

/**
 * The serialised line without the numbers that change from run to run (the timestamp and the request
 * duration), whose digits could contain the CVV by chance.
 */
function withoutVolatileFields(line: string): string {
  const { time: _time, durationMs: _durationMs, ...rest } = JSON.parse(line) as LogRecord;
  return JSON.stringify(rest);
}

function expectNoCardData(line: string): void {
  expect(line).not.toContain(TEST_PAN);
  expect(line).not.toContain(TEST_PAN_LAST_12);
  expect(withoutVolatileFields(line)).not.toContain(TEST_CVV);
}

/** Runs `fn` with stack traces reduced to their first line, so no file position can contain the CVV. */
function withoutStackFrames<T>(fn: () => T): T {
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    return fn();
  } finally {
    Error.stackTraceLimit = previous;
  }
}

function amadeusCreditCard(): LogRecord {
  return {
    brand: "VISA",
    holder: "JORGE GONZALES",
    number: TEST_PAN,
    expiryDate: "2030-12",
    securityCode: TEST_CVV,
  };
}

/** An Amadeus Flight Create Orders request body with an airline-card form of payment. */
function amadeusCreateOrderBody(): LogRecord {
  return {
    data: {
      type: "flight-order",
      flightOffers: [{ type: "flight-offer", id: "1", source: "GDS" }],
      travelers: [
        {
          id: "1",
          dateOfBirth: "1982-01-16",
          name: { firstName: "JORGE", lastName: "GONZALES" },
          documents: [{ documentType: "PASSPORT", number: "00000000", issuanceCountry: "ES" }],
        },
      ],
      formOfPayments: [{ creditCard: amadeusCreditCard() }],
    },
  };
}

/** A supplier error shaped like an HTTP client error: it carries the request and the response. */
class SupplierRequestError extends Error {
  readonly code = "AMADEUS_INVALID_REQUEST";
  readonly body: unknown;
  readonly data: unknown;
  readonly request: unknown;
  readonly response: unknown;
  readonly config: unknown;
  readonly headers: unknown;

  constructor(message: string, body: LogRecord, options?: ErrorOptions) {
    super(message, options);
    this.name = "SupplierRequestError";
    const headers = { authorization: `Bearer ${TEST_BEARER_TOKEN}`, "content-type": "application/json" };
    this.body = body;
    this.data = body;
    this.request = { method: "POST", url: "/v1/booking/flight-orders", headers, body };
    this.response = { status: 400, data: body, headers };
    this.config = { data: JSON.stringify(body), headers };
    this.headers = headers;
  }
}

/** Nests `leaf` so that its keys sit at `depth` (1 is the top level of the log line). */
function nestAt(depth: number, leaf: LogRecord): LogRecord {
  let value = leaf;
  for (let level = depth - 1; level >= 1; level -= 1) {
    value = { [`level${level}`]: value };
  }
  return value;
}

/** Reads the value at `depth` under the `level<n>` keys built by `nestAt`. */
function valueAt(record: LogRecord, depth: number, key: string): unknown {
  let value: unknown = record;
  for (let level = 1; level < depth; level += 1) {
    value = (value as LogRecord)[`level${level}`];
  }
  return (value as LogRecord)[key];
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("redaction through pinoHttpOptions", () => {
  it("logs a request whose headers and body carry a PAN, a password and a bearer token without any of them [X-003 AC1]", async () => {
    const { logger, sink } = testLogger();
    const httpLogger = pinoHttp(pinoHttpOptions({ app: "ota-api", logger }));
    let requestCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      requestCompleted = resolve;
    });
    const baseUrl = await listen((req, res) => {
      httpLogger(req, res);
      res.on("finish", () => setImmediate(requestCompleted));
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        raw += chunk;
      });
      req.on("end", () => {
        // A careless handler that logs the parsed body: the redaction list is the safety net.
        req.log.info({ body: JSON.parse(raw) as unknown }, "checkout.body_received");
        res.statusCode = 201;
        res.setHeader("set-cookie", `__Host-session=${TEST_BEARER_TOKEN}; HttpOnly; Secure`);
        res.end("{}");
      });
    });

    const response = await fetch(`${baseUrl}/v1/checkouts/chk_01/payments?token=${TEST_BEARER_TOKEN}`, {
      method: "POST",
      headers: {
        "x-request-id": REQUEST_ID,
        authorization: `Bearer ${TEST_BEARER_TOKEN}`,
        cookie: `__Host-session=${TEST_BEARER_TOKEN}`,
        "x-api-key": TEST_BEARER_TOKEN,
        "x-booking-token": TEST_BEARER_TOKEN,
        "x-card-number": TEST_PAN,
        "x-password": TEST_PASSWORD,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        password: TEST_PASSWORD,
        token: TEST_BEARER_TOKEN,
        card: { brand: "visa", number: TEST_PAN, securityCode: TEST_CVV },
        creditCard: amadeusCreditCard(),
      }),
    });
    expect(response.status).toBe(201);
    await response.text();
    await completed;

    expect(sink.lines).toHaveLength(2);
    for (const line of sink.lines) {
      expectNoCardData(line);
      expect(line).not.toContain(TEST_PASSWORD);
      expect(line).not.toContain(TEST_BEARER_TOKEN);
    }
    const [bodyLine, requestLine] = sink.records();
    expect(bodyLine).toMatchObject({
      requestId: REQUEST_ID,
      msg: "checkout.body_received",
      body: { password: REDACT_CENSOR, token: REDACT_CENSOR, card: REDACT_CENSOR, creditCard: REDACT_CENSOR },
    });
    expect(requestLine).toMatchObject({
      app: "ota-api",
      env: "test",
      requestId: REQUEST_ID,
      method: "POST",
      route: "/v1/checkouts/chk_01/payments",
      status: 201,
      msg: "request completed",
    });
    expect(typeof requestLine?.["durationMs"]).toBe("number");
    expect(requestLine).not.toHaveProperty("req");
    expect(requestLine).not.toHaveProperty("res");
  });
});

describe("redaction through createLogger", () => {
  it("logs an error whose cause carries an Amadeus Create Orders body without the PAN, its last 12 digits or the CVV [X-003 AC2]", () => {
    const { logger, sink } = testLogger();
    const body = amadeusCreateOrderBody();
    const snapshot = structuredClone(body);

    withoutStackFrames(() => {
      const socketError = Object.assign(new TypeError("fetch failed"), { code: "UND_ERR_SOCKET", body });
      const supplierError = new SupplierRequestError("Amadeus Flight Create Orders failed", body, {
        cause: socketError,
      });
      const error = Object.assign(new Error("checkout.complete failed", { cause: supplierError }), {
        code: "SUPPLIER_ERROR",
        response: { data: body },
      });
      logger.error({ err: error }, "checkout.failed");
    });

    expect(sink.lines).toHaveLength(1);
    const line = sink.lines[0] ?? "";
    expectNoCardData(line);
    expect(line).not.toContain(TEST_BEARER_TOKEN);
    expect(body).toEqual(snapshot);

    const record = JSON.parse(line) as LogRecord;
    expect(record["err"]).toEqual({
      type: "Error",
      message: "checkout.complete failed",
      stack: "Error: checkout.complete failed",
      code: "SUPPLIER_ERROR",
      cause: {
        type: "SupplierRequestError",
        message: "Amadeus Flight Create Orders failed",
        stack: "SupplierRequestError: Amadeus Flight Create Orders failed",
        code: "AMADEUS_INVALID_REQUEST",
        cause: {
          type: "TypeError",
          message: "fetch failed",
          stack: "TypeError: fetch failed",
          code: "UND_ERR_SOCKET",
        },
      },
    });
  });

  it("logs an error passed as the only argument with the same rules [X-003 AC2]", () => {
    const { logger, sink } = testLogger();
    withoutStackFrames(() => {
      logger.error(
        new SupplierRequestError("Amadeus Flight Create Orders failed", amadeusCreateOrderBody(), {
          cause: new SupplierRequestError("upstream", amadeusCreateOrderBody()),
        }),
      );
    });
    expectNoCardData(sink.lines[0] ?? "");
    for (const dropped of ["body", "data", "request", "response", "config", "headers"]) {
      expect(sink.lines[0]).not.toContain(`"${dropped}"`);
    }
  });

  it("keeps the full stack trace and a numeric code of each error in the chain", () => {
    const { logger, sink } = testLogger();
    const cause = Object.assign(new RangeError("limit"), { code: 429 });
    const error = new Error("search failed", { cause });

    logger.error({ err: error }, "search.failed");

    const [record] = sink.records();
    expect(record?.["err"]).toEqual({
      type: "Error",
      message: "search failed",
      stack: error.stack,
      cause: { type: "RangeError", message: "limit", stack: cause.stack, code: 429 },
    });
    expect(error.stack).toContain("redaction.test.ts");
  });

  it("applies the err rules to an Error logged under the error key and keeps other error values", () => {
    const { logger, sink } = testLogger();
    withoutStackFrames(() => {
      logger.error(
        { error: new SupplierRequestError("Amadeus Flight Create Orders failed", amadeusCreateOrderBody()) },
        "checkout.failed",
      );
    });
    logger.warn({ error: "PRICE_CHANGED" }, "checkout.rejected");

    expectNoCardData(sink.lines[0] ?? "");
    expect(sink.lines[0]).not.toContain(TEST_BEARER_TOKEN);
    const [errorRecord, codeRecord] = sink.records();
    expect(errorRecord?.["error"]).toEqual({
      type: "SupplierRequestError",
      message: "Amadeus Flight Create Orders failed",
      stack: "SupplierRequestError: Amadeus Flight Create Orders failed",
      code: "AMADEUS_INVALID_REQUEST",
    });
    expect(codeRecord?.["error"]).toBe("PRICE_CHANGED");
  });

  it("keeps only the allowed fields of AggregateError entries, a non-object cause and a cause cycle", () => {
    const { logger, sink } = testLogger();
    withoutStackFrames(() => {
      const first = new SupplierRequestError("offer 1 failed", amadeusCreateOrderBody());
      const second = new Error("raw cause", { cause: JSON.stringify(amadeusCreateOrderBody()) });
      const looping = new Error("looping");
      const other = new Error("other", { cause: looping });
      Object.assign(looping, { cause: other });
      logger.error({ err: new AggregateError([first, second, looping], "batch failed") }, "batch.failed");
    });

    const line = sink.lines[0] ?? "";
    expectNoCardData(line);
    expect(line).not.toContain(TEST_BEARER_TOKEN);
    const [record] = sink.records();
    expect(record?.["err"]).toEqual({
      type: "AggregateError",
      message: "batch failed",
      stack: "AggregateError: batch failed",
      errors: [
        {
          type: "SupplierRequestError",
          message: "offer 1 failed",
          stack: "SupplierRequestError: offer 1 failed",
          code: "AMADEUS_INVALID_REQUEST",
        },
        {
          type: "Error",
          message: "raw cause",
          stack: "Error: raw cause",
          cause: { type: "string", message: "" },
        },
        {
          type: "Error",
          message: "looping",
          stack: "Error: looping",
          cause: { type: "Error", message: "other", stack: "Error: other" },
        },
      ],
    });
  });

  it("refuses a logger without an app name", () => {
    expect(() => createLogger({ app: " ", env: "test" })).toThrow(/app must be a non-empty/);
  });

  for (const key of ["card", "creditCard", "formOfPayments"]) {
    for (let depth = 1; depth <= 8; depth += 1) {
      it(`censors the whole ${key} object of a plain object logged at depth ${depth} [X-003 AC2]`, () => {
        const { logger, sink } = testLogger();
        const value = key === "formOfPayments" ? [{ creditCard: amadeusCreditCard() }] : amadeusCreditCard();
        const logged = nestAt(depth, { [key]: value, bookingId: "bkg_01" });
        const snapshot = structuredClone(logged);

        logger.info(logged, "payment.debug");

        const line = sink.lines[0] ?? "";
        expectNoCardData(line);
        const record = JSON.parse(line) as LogRecord;
        expect(valueAt(record, depth, key)).toBe(REDACT_CENSOR);
        expect(valueAt(record, depth, "bookingId")).toBe("bkg_01");
        expect(logged).toEqual(snapshot);
      });
    }
  }

  for (let depth = 1; depth <= 6; depth += 1) {
    it(`logs an Amadeus Create Orders body nested at depth ${depth} of a plain object without card data [X-003 AC2]`, () => {
      const { logger, sink } = testLogger();
      const logged = nestAt(depth, { body: amadeusCreateOrderBody() });
      const snapshot = structuredClone(logged);

      logger.info(logged, "supplier.request");

      const line = sink.lines[0] ?? "";
      expectNoCardData(line);
      const body = valueAt(JSON.parse(line) as LogRecord, depth, "body") as { data: LogRecord };
      expect(body.data["formOfPayments"]).toBe(REDACT_CENSOR);
      expect(body.data["type"]).toBe("flight-order");
      expect(logged).toEqual(snapshot);
    });
  }

  it("logs an Amadeus Create Orders body as the whole log object without card data [X-003 AC2]", () => {
    const { logger, sink } = testLogger();
    logger.info(amadeusCreateOrderBody(), "supplier.request");
    expectNoCardData(sink.lines[0] ?? "");
  });

  it("censors every sensitive key at the top level and one level down", () => {
    const keys = REDACT_PATHS.filter((path) => /^[A-Za-z]+$/.test(path));
    expect(keys).toEqual([
      "password",
      "newPassword",
      "currentPassword",
      "mfaCode",
      "accessToken",
      "refreshToken",
      "portalToken",
      "bookingToken",
      "token",
      "clientSecret",
      "secret",
      "apiKey",
      "securityCode",
      "cvc",
      "cardNumber",
      "certificateNumber",
      "secretKey",
      "webhookSecret",
      "iban",
      "accountNumber",
      "recoveryCode",
      "recoveryCodes",
      "totpSecret",
      "otpauthUrl",
      "mfaChallengeToken",
      "invitationToken",
      "secretData",
      "verifyUrl",
      "resetUrl",
      "acceptUrl",
      "card",
      "creditCard",
      "formOfPayments",
      "holderName",
      "expiryMonth",
      "expiryYear",
    ]);
    const { logger, sink } = testLogger();
    for (const key of keys) {
      const secret = `${key}-value-${TEST_BEARER_TOKEN}`;
      logger.info({ [key]: secret, nested: { [key]: secret }, keep: "visible" }, "sensitive.key");
    }
    expect(sink.lines).toHaveLength(keys.length);
    for (const [index, record] of sink.records().entries()) {
      const key = keys[index] ?? "";
      expect(record[key]).toBe(REDACT_CENSOR);
      expect(record["nested"]).toEqual({ [key]: REDACT_CENSOR });
      expect(record["keep"]).toBe("visible");
    }
  });

  it("censors card and identity document numbers below their parent", () => {
    const { logger, sink } = testLogger();
    const logged = {
      documents: [{ documentType: "PASSPORT", number: "X1234567", issuanceCountry: "ES" }],
      traveler: {
        id: "1",
        documents: [{ documentType: "PASSPORT", number: "X1234567", issuanceCountry: "ES" }],
      },
    };
    const snapshot = structuredClone(logged);

    logger.info(logged, "traveler.debug");

    expect(sink.lines[0]).not.toContain("X1234567");
    const [record] = sink.records();
    expect(record).toMatchObject({
      documents: [{ documentType: "PASSPORT", number: REDACT_CENSOR, issuanceCountry: "ES" }],
      traveler: { id: "1", documents: [{ documentType: "PASSPORT", number: REDACT_CENSOR }] },
    });
    expect(logged).toEqual(snapshot);
    expect(REDACT_PATHS).toEqual(expect.arrayContaining(["*.card.number", "*.creditCard.number"]));
  });

  it("censors credential headers of a request and a response, and the serializers drop headers", () => {
    const { logger, sink } = testLogger();
    const headers = {
      authorization: `Bearer ${TEST_BEARER_TOKEN}`,
      cookie: `__Host-session=${TEST_BEARER_TOKEN}`,
      "x-api-key": TEST_BEARER_TOKEN,
      "x-csrf-token": TEST_BEARER_TOKEN,
      "x-booking-token": TEST_BEARER_TOKEN,
      "x-velexis-edge": TEST_BEARER_TOKEN,
      accept: "application/json",
    };
    // A child that passes req/res through unchanged shows that the paths themselves censor the headers.
    const identity = (value: unknown): unknown => value;
    logger.child({}, { serializers: { req: identity, res: identity } }).info(
      {
        req: { method: "GET", headers },
        res: { statusCode: 200, headers: { "set-cookie": [`__Host-session=${TEST_BEARER_TOKEN}`] } },
      },
      "headers.debug",
    );
    logger.info({ req: { method: "GET", headers }, res: { statusCode: 200, headers } }, "serialized.request");

    for (const line of sink.lines) {
      expect(line).not.toContain(TEST_BEARER_TOKEN);
    }
    const [rawRecord, serializedRecord] = sink.records();
    expect(rawRecord).toMatchObject({
      req: {
        headers: {
          authorization: REDACT_CENSOR,
          cookie: REDACT_CENSOR,
          "x-api-key": REDACT_CENSOR,
          "x-csrf-token": REDACT_CENSOR,
          "x-booking-token": REDACT_CENSOR,
          "x-velexis-edge": REDACT_CENSOR,
          accept: "application/json",
        },
      },
      res: { headers: { "set-cookie": REDACT_CENSOR } },
    });
    expect(serializedRecord?.["req"]).toEqual({ method: "GET" });
    expect(serializedRecord?.["res"]).toEqual({ status: 200 });
  });

  it("censors the platform's X-Velexis-Bff-Key header and keeps the end-user headers it vouches for (PADR-0019)", () => {
    const { logger, sink } = testLogger();
    const identity = (value: unknown): unknown => value;
    const headers = {
      "x-velexis-bff-key": TEST_BEARER_TOKEN,
      "x-velexis-end-user-ip": "203.0.113.7",
      "x-velexis-end-user-agent": "Mozilla/5.0 (test)",
    };

    logger
      .child({}, { serializers: { req: identity } })
      .warn({ req: { method: "POST", headers } }, "bff.debug");

    expect(sink.lines.join("\n")).not.toContain(TEST_BEARER_TOKEN);
    expect(sink.records()[0]).toMatchObject({
      req: {
        headers: {
          "x-velexis-bff-key": REDACT_CENSOR,
          "x-velexis-end-user-ip": "203.0.113.7",
          "x-velexis-end-user-agent": "Mozilla/5.0 (test)",
        },
      },
    });
    expect(REDACT_PATHS).toContain('req.headers["x-velexis-bff-key"]');
    // The caller's object is unchanged: pino censors a copy.
    expect(headers["x-velexis-bff-key"]).toBe(TEST_BEARER_TOKEN);
  });

  it("writes the base fields app and env and an ISO timestamp", () => {
    const { logger, sink } = testLogger();
    logger.info({ bookingId: "bkg_01" }, "booking.created");
    const [record] = sink.records();
    expect(record).toMatchObject({
      app: "ota-api",
      env: "test",
      bookingId: "bkg_01",
      msg: "booking.created",
    });
    expect(record?.["time"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(record).not.toHaveProperty("pid");
    expect(record).not.toHaveProperty("hostname");
  });
});

/** The platform's paths of platform/docs/architecture.md §8 (PBE-010, PBE-011), in the order of REDACT_PATHS. */
const PLATFORM_KEYS = [
  "secretKey",
  "webhookSecret",
  "iban",
  "accountNumber",
  "recoveryCode",
  "recoveryCodes",
  "totpSecret",
  "otpauthUrl",
  "mfaChallengeToken",
  "invitationToken",
  "secretData",
  "verifyUrl",
  "resetUrl",
  "acceptUrl",
] as const;
const PLATFORM_BODY_PATHS = [
  "mfa.code",
  "mfa.state",
  "oauth.code",
  "oauth.state",
  "*.mfa.code",
  "*.mfa.state",
  "*.oauth.code",
  "*.oauth.state",
] as const;
const PLATFORM_PATHS = [...PLATFORM_KEYS, ...PLATFORM_KEYS.map((key) => `*.${key}`), ...PLATFORM_BODY_PATHS];

/**
 * A log object that holds `value` at a pino path of plain keys and `*` wildcards (a `*` becomes the key `level<n>`),
 * with a visible sibling `keep` next to the value, and the keys to read the value back.
 */
function objectAtPath(path: string, value: unknown): { logged: LogRecord; keys: string[] } {
  const keys = path.split(".").map((segment, index) => (segment === "*" ? `level${index + 1}` : segment));
  let logged: LogRecord = { [keys.at(-1) ?? ""]: value, keep: "visible" };
  for (const key of keys.slice(0, -1).reverse()) {
    logged = { [key]: logged };
  }
  return { logged, keys };
}

function readPath(record: LogRecord, keys: readonly string[]): unknown {
  let value: unknown = record;
  for (const key of keys) {
    value = (value as LogRecord | undefined)?.[key];
  }
  return value;
}

describe("the platform's redaction paths (platform/docs/architecture.md §8)", () => {
  it("lists every platform path in REDACT_PATHS and keeps the list ordered from shallow to deep [PBE-010 AC3]", () => {
    for (const path of PLATFORM_PATHS) {
      expect(REDACT_PATHS).toContain(path);
    }
    // `documents[*].number` and `req.headers["x-api-key"]` are three levels deep, like `*.card.number`.
    const depths = REDACT_PATHS.map((path) => path.split(/\.|\[/).length);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });

  for (const path of PLATFORM_PATHS) {
    it(`censors ${path} and keeps its sibling and the caller's object [PBE-010 AC3]`, () => {
      const { logger, sink } = testLogger();
      const secret = `platform-${path}-${TEST_BEARER_TOKEN}`;
      const { logged, keys } = objectAtPath(path, path.endsWith("recoveryCodes") ? [secret, secret] : secret);
      const snapshot = structuredClone(logged);

      logger.info(logged, "platform.sensitive");

      const line = sink.lines[0] ?? "";
      expect(line).not.toContain(TEST_BEARER_TOKEN);
      const [record] = sink.records();
      expect(readPath(record ?? {}, keys)).toBe(REDACT_CENSOR);
      expect(readPath(record ?? {}, [...keys.slice(0, -1), "keep"])).toBe("visible");
      expect(logged).toEqual(snapshot);
    });
  }

  it("logs a payout account, an MFA set-up and an invitation without their bank numbers, secrets or tokens [PBE-010 AC3]", () => {
    const { logger, sink } = testLogger();
    // Test values only: a made-up IBAN, account number, TOTP secret and recovery codes.
    const iban = "XX00TEST0000111122223333";
    const accountNumber = "000123456789";
    const totpSecret = "TESTTOTPSECRETAAAAAAAAAAAAAAAAAA";
    const recoveryCodes = ["TEST-AAAA-BBBB-CCCC", "TEST-DDDD-EEEE-FFFF"];
    const logged = {
      tenantId: "ten_01",
      payoutAccount: { holderName: "Acme Travel SL", iban, accountNumber, last4: "3333" },
      setup: { totpSecret, otpauthUrl: `otpauth://totp/Velexis:anna%40example.com?secret=${totpSecret}` },
      recoveryCodes,
      invitation: { email: "jo@example.com", invitationToken: TEST_BEARER_TOKEN },
      stripe: { secretKey: `sk_test_${TEST_BEARER_TOKEN}`, webhookSecret: `whsec_${TEST_BEARER_TOKEN}` },
    };
    const snapshot = structuredClone(logged);

    logger.warn(logged, "platform.careless_debug");

    const line = sink.lines[0] ?? "";
    for (const value of [iban, accountNumber, totpSecret, TEST_BEARER_TOKEN, ...recoveryCodes]) {
      expect(line).not.toContain(value);
    }
    expect(sink.records()[0]).toMatchObject({
      tenantId: "ten_01",
      payoutAccount: {
        // `*.holderName` is an airline-card path since OBE-050: a payout account's holder is censored as well.
        holderName: REDACT_CENSOR,
        iban: REDACT_CENSOR,
        accountNumber: REDACT_CENSOR,
        last4: "3333",
      },
      setup: { totpSecret: REDACT_CENSOR, otpauthUrl: REDACT_CENSOR },
      recoveryCodes: REDACT_CENSOR,
      invitation: { email: "jo@example.com", invitationToken: REDACT_CENSOR },
      stripe: { secretKey: REDACT_CENSOR, webhookSecret: REDACT_CENSOR },
    });
    expect(logged).toEqual(snapshot);
  });

  it("censors the code and state of an MFA or OAuth body and keeps every other code visible [PBE-010 AC3]", () => {
    const { logger, sink } = testLogger();
    const totpCode = "918273";
    const oauthCode = `ac_${TEST_BEARER_TOKEN}`;
    const oauthState = `state-${TEST_BEARER_TOKEN}`;
    const logged = {
      mfa: { mfaChallengeToken: TEST_BEARER_TOKEN, code: totpCode },
      oauth: { state: oauthState, code: oauthCode },
      request: { mfa: { code: totpCode }, oauth: { state: oauthState, code: oauthCode } },
      code: "VALIDATION_FAILED",
      error: { code: "CONNECT_STATE_INVALID", state: "failed" },
      account: { mfa: true },
    };
    const snapshot = structuredClone(logged);

    logger.warn(logged, "platform.mfa_debug");

    const line = sink.lines[0] ?? "";
    for (const value of [totpCode, oauthCode, oauthState, TEST_BEARER_TOKEN]) {
      expect(line).not.toContain(value);
    }
    expect(sink.records()[0]).toMatchObject({
      mfa: { mfaChallengeToken: REDACT_CENSOR, code: REDACT_CENSOR },
      oauth: { state: REDACT_CENSOR, code: REDACT_CENSOR },
      request: { mfa: { code: REDACT_CENSOR }, oauth: { state: REDACT_CENSOR, code: REDACT_CENSOR } },
      code: "VALIDATION_FAILED",
      error: { code: "CONNECT_STATE_INVALID", state: "failed" },
      account: { mfa: true },
    });
    expect(logged).toEqual(snapshot);
  });

  it("keeps the error code of an err about an OAuth failure, whose other fields the err serializer drops", () => {
    const { logger, sink } = testLogger();
    withoutStackFrames(() => {
      const error = Object.assign(new Error("Stripe OAuth token exchange failed"), {
        code: "invalid_grant",
        oauth: { code: `ac_${TEST_BEARER_TOKEN}` },
      });
      logger.error({ err: error }, "payments.connect_failed");
    });

    expect(sink.lines[0]).not.toContain(TEST_BEARER_TOKEN);
    expect(sink.records()[0]?.["err"]).toEqual({
      type: "Error",
      message: "Stripe OAuth token exchange failed",
      stack: "Error: Stripe OAuth token exchange failed",
      code: "invalid_grant",
    });
  });
});

/** The airline card's field paths of ota/docs/architecture.md §9 (OBE-050), in the order of REDACT_PATHS. */
const AIRLINE_CARD_KEYS = ["holderName", "expiryMonth", "expiryYear"] as const;
const AIRLINE_CARD_FIELD_PATHS = [...AIRLINE_CARD_KEYS, ...AIRLINE_CARD_KEYS.map((key) => `*.${key}`)];
/** The request headers of ota/docs/architecture.md §9 (OBE-050). */
const AIRLINE_CARD_HEADERS = [
  "x-velexis-edge",
  "x-csrf-token",
  "x-booking-token",
  "stripe-signature",
] as const;

/** An airline-card completion body (AirlineCardCompletionRequest) with Visa's documented test PAN. */
function airlineCardCompletionBody(): LogRecord {
  return {
    paymentId: "pay_01J9ZQ4V3K8M2N6P0R5T7W9XYZ",
    expectedTotal: { amount: "412.30", currency: "EUR" },
    card: {
      brand: "VISA",
      holderName: "Jorge Gonzales",
      number: TEST_PAN,
      expiryMonth: 12,
      expiryYear: 2030,
      securityCode: TEST_CVV,
    },
  };
}

describe("the airline card's redaction paths (ota/docs/architecture.md §9)", () => {
  it("lists every airline-card path and header in REDACT_PATHS, in order from shallow to deep [OBE-050 AC3]", () => {
    for (const path of [...AIRLINE_CARD_FIELD_PATHS, "card", "*.card", "*.*.card", "*.card.number"]) {
      expect(REDACT_PATHS).toContain(path);
    }
    for (const name of AIRLINE_CARD_HEADERS) {
      expect(REDACT_PATHS).toContain(`req.headers["${name}"]`);
    }
    const depths = REDACT_PATHS.map((path) => path.split(/\.|\[/).length);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });

  for (const path of AIRLINE_CARD_FIELD_PATHS) {
    it(`censors ${path} and keeps its sibling and the caller's object [OBE-050 AC3]`, () => {
      const { logger, sink } = testLogger();
      const value = path.endsWith("holderName") ? `Holder ${TEST_BEARER_TOKEN}` : 2030;
      const { logged, keys } = objectAtPath(path, value);
      const snapshot = structuredClone(logged);

      logger.info(logged, "airline_card.sensitive");

      const line = sink.lines[0] ?? "";
      expect(line).not.toContain(TEST_BEARER_TOKEN);
      expect(withoutVolatileFields(line)).not.toContain("2030");
      const [record] = sink.records();
      expect(readPath(record ?? {}, keys)).toBe(REDACT_CENSOR);
      expect(readPath(record ?? {}, [...keys.slice(0, -1), "keep"])).toBe("visible");
      expect(logged).toEqual(snapshot);
    });
  }

  for (const name of AIRLINE_CARD_HEADERS) {
    it(`censors the ${name} request header when a request's headers are logged [OBE-050 AC3]`, () => {
      const { logger, sink } = testLogger();
      // A child that passes req through unchanged shows that the path itself censors the header.
      const identity = (value: unknown): unknown => value;
      const headers = { [name]: TEST_BEARER_TOKEN, "content-type": "application/json" };

      logger
        .child({}, { serializers: { req: identity } })
        .warn({ req: { method: "POST", headers } }, "edge.debug");

      expect(sink.lines[0]).not.toContain(TEST_BEARER_TOKEN);
      expect(sink.records()[0]).toMatchObject({
        req: { headers: { [name]: REDACT_CENSOR, "content-type": "application/json" } },
      });
      expect(headers[name]).toBe(TEST_BEARER_TOKEN);
    });
  }

  for (let depth = 1; depth <= 6; depth += 1) {
    it(`logs an airline-card completion body nested at depth ${depth} without the card [OBE-050 AC3]`, () => {
      const { logger, sink } = testLogger();
      const logged = nestAt(depth, { body: airlineCardCompletionBody() });
      const snapshot = structuredClone(logged);

      logger.warn(logged, "airline_card.careless_debug");

      const line = sink.lines[0] ?? "";
      expectNoCardData(line);
      expect(line).not.toContain("Jorge Gonzales");
      const body = valueAt(JSON.parse(line) as LogRecord, depth, "body") as LogRecord;
      expect(body["card"]).toBe(REDACT_CENSOR);
      expect(body["paymentId"]).toBe("pay_01J9ZQ4V3K8M2N6P0R5T7W9XYZ");
      expect(logged).toEqual(snapshot);
    });
  }

  it("censors the holder and the expiry of a card flattened into a log object, at the top level and one down [OBE-050 AC3]", () => {
    const { logger, sink } = testLogger();
    const flattened = { brand: "VISA", holderName: "Jorge Gonzales", expiryMonth: 12, expiryYear: 2030 };

    logger.warn({ ...flattened, attempt: { ...flattened, last4: "1111" } }, "airline_card.flattened");

    const line = sink.lines[0] ?? "";
    expect(line).not.toContain("Jorge Gonzales");
    expect(withoutVolatileFields(line)).not.toContain("2030");
    expect(sink.records()[0]).toMatchObject({
      brand: "VISA",
      holderName: REDACT_CENSOR,
      expiryMonth: REDACT_CENSOR,
      expiryYear: REDACT_CENSOR,
      attempt: {
        brand: "VISA",
        holderName: REDACT_CENSOR,
        expiryMonth: REDACT_CENSOR,
        expiryYear: REDACT_CENSOR,
        last4: "1111",
      },
    });
  });
});

describe("package README", () => {
  it('states the rule "a new sensitive field = a new path here plus a test" [X-003 AC5]', () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
    expect(readme).toContain("a new sensitive field = a new path here plus a test");
  });
});
