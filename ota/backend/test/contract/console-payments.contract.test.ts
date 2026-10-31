// Contract test of OBE-090: the console payment operations of ota/docs/api-changes-console-and-internal.md §3 and the
// internal endpoints of §5 in the OTA document (openapi/velexis-ota-booking-api.openapi.yaml).
//
// - The 4 console payment operations (`ConsolePayment`, tag `Console payments`) with their `x-sdk-method`,
//   `x-permission` (`payments:read`, `payments:capture`, `payments:refund`) and `x-milestone: M4`, their schemas, their
//   request validation, their examples (whose payment events are the rows the payments code writes: the webhook
//   receiver, the payments service and the refunds repository), their handlers (pending until OBE-068 served them)
//   and their row of ota/sdk/docs/extensions.md §3.3.
// - The internal endpoints under the `Internal` tag (`x-internal: true`): `healthLive` and `healthReady` (`x-milestone:
//   M0`, served by HealthController since OBE-001, so no undocumented route is left) and the two M5 webhooks
//   `receiveStripeConnectWebhook` and `receiveStripeConnectionWebhook` with the tenant rules of OADR-0010 point 4,
//   pending until OBE-078 served them.
//
// Requests are validated with the API's own validators (loadOpenApiDocument), responses with the checker every
// integration test uses; the health answers are the API's own (the application and HealthService). Totals are asserted
// once, by OBE-075.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { components, operations } from "@velexis/api-types";
import { otaOperations, type ApiOperation } from "@velexis/api-types/operations";
import { AppError, ERROR_CATALOGUE, type ErrorCode } from "@velexis/errors";
import { responseChecker, type ResponseChecker } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import type Stripe from "stripe";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "../../src/common/auth/roles";
import {
  loadOpenApiDocument,
  type OpenApiDocument,
  type RawRequest,
} from "../../src/common/http/openapi-validation.interceptor";
import { PENDING_OPERATIONS, UNDOCUMENTED_ROUTES } from "../../src/common/http/pending-operations";
import { APP_DIR } from "../../src/config";
import { HealthService, type DependencyName, type DependencyProbe } from "../../src/health/health.service";
import {
  REFUNDABLE_PAYMENT_STATUSES,
  REFUND_REASONS,
  REFUND_REQUESTERS,
} from "../../src/payments/refunds.repository";
import { eventFactsOf, storedPayloadOf } from "../../src/payments/webhooks/webhook-receiver.service";
import { createTestApp, type TestApp } from "../support/create-test-app";

const REPO_ROOT = join(APP_DIR, "..", "..");
const EXTENSIONS_DOCUMENT = join(REPO_ROOT, "ota", "sdk", "docs", "extensions.md");
/** The tenant schema's migrations (the CHECK constraints of `payment_events`). */
const TENANT_MIGRATIONS = join(APP_DIR, "migrations", "tenant");

/** Parsing and compiling the 40,000-line document, and building the application, take a few seconds on a busy runner. */
const SETUP_TIMEOUT_MS = 60_000;

type Json = Record<string, unknown>;
type Method = "get" | "post";

/** One of the 8 operations of OBE-090 and the plan task that serves it. */
interface Expected {
  readonly operationId: string;
  readonly method: Method;
  readonly path: string;
  readonly sdkMethod: string | null;
  readonly scope: "console" | "internal";
  readonly tag: "Console payments" | "Internal";
  readonly milestone: "M0" | "M4" | "M5";
  readonly permission: "payments:read" | "payments:capture" | "payments:refund" | null;
  /** The plan task that implements it, or `served` for a route that has its handler already. */
  readonly task: "OBE-068" | "OBE-078" | "served";
}

const PAYMENTS = "/v1/console/payments";

/** The 8 operations of OBE-090, as api-changes part 2 §3 and §5 list them. */
const OBE_090_OPERATIONS: readonly Expected[] = [
  {
    operationId: "consoleListPayments",
    method: "get",
    path: PAYMENTS,
    sdkMethod: "console.payments.list",
    scope: "console",
    tag: "Console payments",
    milestone: "M4",
    permission: "payments:read",
    task: "OBE-068",
  },
  {
    operationId: "consoleGetPayment",
    method: "get",
    path: `${PAYMENTS}/{paymentId}`,
    sdkMethod: "console.payments.get",
    scope: "console",
    tag: "Console payments",
    milestone: "M4",
    permission: "payments:read",
    task: "OBE-068",
  },
  {
    operationId: "consoleCapturePayment",
    method: "post",
    path: `${PAYMENTS}/{paymentId}/capture`,
    sdkMethod: "console.payments.capture",
    scope: "console",
    tag: "Console payments",
    milestone: "M4",
    permission: "payments:capture",
    task: "OBE-068",
  },
  {
    operationId: "consoleRefundPayment",
    method: "post",
    path: `${PAYMENTS}/{paymentId}/refunds`,
    sdkMethod: "console.payments.refund",
    scope: "console",
    tag: "Console payments",
    milestone: "M4",
    permission: "payments:refund",
    task: "OBE-068",
  },
  {
    operationId: "healthLive",
    method: "get",
    path: "/health/live",
    sdkMethod: null,
    scope: "internal",
    tag: "Internal",
    milestone: "M0",
    permission: null,
    task: "served",
  },
  {
    operationId: "healthReady",
    method: "get",
    path: "/health/ready",
    sdkMethod: null,
    scope: "internal",
    tag: "Internal",
    milestone: "M0",
    permission: null,
    task: "served",
  },
  {
    operationId: "receiveStripeConnectWebhook",
    method: "post",
    path: "/webhooks/stripe/connect/{environment}",
    sdkMethod: null,
    scope: "internal",
    tag: "Internal",
    milestone: "M5",
    permission: null,
    task: "OBE-078",
  },
  {
    operationId: "receiveStripeConnectionWebhook",
    method: "post",
    path: "/webhooks/stripe/c/{connectionId}",
    sdkMethod: null,
    scope: "internal",
    tag: "Internal",
    milestone: "M5",
    permission: null,
    task: "OBE-078",
  },
];

const CONSOLE_PAYMENT_OPERATIONS = OBE_090_OPERATIONS.filter(({ scope }) => scope === "console");
const WEBHOOKS = ["receiveStripeConnectWebhook", "receiveStripeConnectionWebhook"] as const;
const HEALTH = ["healthLive", "healthReady"] as const;

/** The error codes every console operation lists (api-changes part 2 §1, part 1 §5). */
const COMMON_CONSOLE_CODES: readonly ErrorCode[] = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "INVALID_API_KEY",
  "TOKEN_EXPIRED",
  "FORBIDDEN",
  "SCOPE_NOT_ALLOWED",
  "TENANT_SUSPENDED",
  "STAFF_MEMBERSHIP_INACTIVE",
  "ENVIRONMENT_NOT_ALLOWED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
];

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function objectAt(value: unknown, ...keys: string[]): Json {
  let current = value;
  for (const key of keys) {
    if (!isObject(current) || !isObject(current[key])) {
      throw new Error(`no object at ${keys.join(".")}`);
    }
    current = current[key];
  }
  return current as Json;
}

interface Operation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly spec: Json;
}

let document: OpenApiDocument;
let working: Json;
let byId: Map<string, Operation>;
let checker: ResponseChecker;
let api: TestApp;
let live: request.Response;
let ready: request.Response;

beforeAll(async () => {
  document = loadOpenApiDocument();
  working = document.document as Json;
  const all = Object.entries(objectAt(working, "paths")).flatMap(([path, item]) =>
    Object.entries(item as Json)
      .filter(([, value]) => isObject(value) && typeof value["operationId"] === "string")
      .map(([method, value]) => ({
        operationId: String((value as Json)["operationId"]),
        method,
        path,
        spec: value as Json,
      })),
  );
  byId = new Map(all.map((entry) => [entry.operationId, entry]));
  checker = responseChecker("ota");
  // The API's own health answers, as main.ts builds the application (dummy services: nothing answers the readiness
  // probes, so /health/ready is 503 whatever the machine runs).
  api = await createTestApp();
  live = await request(api.server).get("/health/live");
  ready = await request(api.server).get("/health/ready");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
});

function operation(operationId: string): Operation {
  const found = byId.get(operationId);
  if (found === undefined) {
    throw new Error(`the OTA document has no operation ${operationId}`);
  }
  return found;
}

const schemaOf = (name: string): Json => objectAt(working, "components", "schemas", name);

/** The value of `components.examples.<name>`. */
const componentExample = (name: string): Json => objectAt(working, "components", "examples", name, "value");

/** A named example of a component response (`components.responses.<response>`). */
const responseExample = (response: string, name: string): Json =>
  objectAt(
    working,
    "components",
    "responses",
    response,
    "content",
    "application/json",
    "examples",
    name,
    "value",
  );

/** The examples of a component response, by name. */
const responseExamples = (response: string): Json =>
  objectAt(working, "components", "responses", response, "content", "application/json", "examples");

/** The component parameters an operation references, by component name, and its inline ones by `in:name`. */
function parametersOf(op: Operation): string[] {
  return ((op.spec["parameters"] as Json[] | undefined) ?? []).map((parameter) =>
    typeof parameter["$ref"] === "string"
      ? parameter["$ref"].replace("#/components/parameters/", "")
      : `${String(parameter["in"])}:${String(parameter["name"])}`,
  );
}

/** An inline parameter of an operation, by name. */
function inlineParameter(operationId: string, name: string): Json {
  const found = ((operation(operationId).spec["parameters"] as Json[] | undefined) ?? []).find(
    (parameter) => parameter["name"] === name,
  );
  if (found === undefined) {
    throw new Error(`${operationId} has no inline parameter ${name}`);
  }
  return found;
}

/** What the API's request validator says about a request: `[]`, or the field errors as `"<path> <code>"`. */
function problems(operationId: string, req: Partial<RawRequest>): string[] {
  try {
    document.validator(operationId).validate({
      params: {},
      query: {},
      headers: {},
      body: undefined,
      bodySent: false,
      ...req,
    });
    return [];
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      return (error.fieldErrors ?? []).map(({ path, code }) => `${path} ${code}`);
    }
    throw error;
  }
}

/** The JSON request example `name` of an operation. */
function requestExample(operationId: string, name: string): Json {
  return objectAt(
    operation(operationId).spec,
    "requestBody",
    "content",
    "application/json",
    "examples",
    name,
    "value",
  );
}

const PAYMENT_ID = "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1";
const IDEMPOTENCY = { "idempotency-key": "4b4c0e0e-6d5b-4a43-9a0b-5d3f1d2e7c10" };
const IF_MATCH = { "if-match": '"3"' };

const capture = (body: unknown, headers: RawRequest["headers"] = { ...IDEMPOTENCY, ...IF_MATCH }): string[] =>
  problems("consoleCapturePayment", { params: { paymentId: PAYMENT_ID }, body, bodySent: true, headers });
const refund = (body: unknown, headers: RawRequest["headers"] = IDEMPOTENCY): string[] =>
  problems("consoleRefundPayment", { params: { paymentId: PAYMENT_ID }, body, bodySent: true, headers });

/** The values of a `CHECK (<column> IN (…))` of a tenant migration's table. */
function checkValues(table: string, column: string): string[] {
  const migrations = readdirSync(TENANT_MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(join(TENANT_MIGRATIONS, file), "utf8"))
    .join("\n");
  const body = new RegExp(`^CREATE TABLE ${table} \\(([\\s\\S]*?)^\\);`, "m").exec(migrations)?.[1] ?? "";
  const check = new RegExp(`^\\s*${column}\\s.*CHECK \\(${column} IN \\(([^)]*)\\)\\)`, "m").exec(body)?.[1];
  return [...(check ?? "").matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "");
}

describe("the 8 operations of OBE-090 (api-changes part 2 §3, §5)", () => {
  it("adds the 4 console payment operations and documents the 4 internal endpoints with their extensions [OBE-090 AC1]", () => {
    expect(OBE_090_OPERATIONS).toHaveLength(8);
    for (const expected of OBE_090_OPERATIONS) {
      const op = operation(expected.operationId);
      expect([op.operationId, op.method, op.path]).toEqual([
        expected.operationId,
        expected.method,
        expected.path,
      ]);
      expect(op.spec).toMatchObject({
        "x-scope": expected.scope,
        "x-milestone": expected.milestone,
        tags: [expected.tag],
      });
      expect([op.operationId, op.spec["x-sdk-method"] ?? null]).toEqual([op.operationId, expected.sdkMethod]);
      expect([op.operationId, op.spec["x-permission"] ?? null]).toEqual([
        op.operationId,
        expected.permission,
      ]);
      expect([op.operationId, op.spec["x-internal"] ?? false]).toEqual([
        op.operationId,
        expected.scope === "internal",
      ]);
      expect([op.operationId, op.spec["x-sdk-exclude"], op.spec["x-edge-only"]]).toEqual([
        op.operationId,
        undefined,
        undefined,
      ]);
      // The operations index carries them for route parity, the permission guard and the SDK generator.
      expect(otaOperations.find((entry) => entry.operationId === expected.operationId)).toEqual({
        operationId: expected.operationId,
        method: expected.method,
        path: expected.path,
        sdkMethod: expected.sdkMethod,
        scope: expected.scope,
        tags: [expected.tag],
        internal: expected.scope === "internal",
        milestone: expected.milestone,
        edgeOnly: false,
        permission: expected.permission,
      } satisfies ApiOperation<string>);
      // Every listed code is answered with a documented status.
      for (const code of op.spec["x-error-codes"] as ErrorCode[]) {
        const status = String(ERROR_CATALOGUE[code].status);
        expect([op.operationId, code, status in objectAt(op.spec, "responses")]).toEqual([
          op.operationId,
          code,
          true,
        ]);
      }
    }
    // The console payments tag joins the Console group; the Internal tag names its five operations.
    const tags = working["tags"] as Json[];
    expect(tags.map((tag) => tag["name"])).toContain("Console payments");
    const groups = working["x-tagGroups"] as Json[];
    expect(groups.find((group) => group["name"] === "Console")?.["tags"]).toContain("Console payments");
    const internal = String(tags.find((tag) => tag["name"] === "Internal")?.["description"]);
    for (const operationId of [...HEALTH, "receiveStripeVelexisWebhook", ...WEBHOOKS]) {
      expect([operationId, internal.includes(operationId)]).toEqual([operationId, true]);
    }
  });

  it("lists none of the 8 operations as pending since OBE-068 and OBE-078 served theirs, and no undocumented route [OBE-090 AC1]", () => {
    // A task that implements its operations removes their entries; route parity (route-parity.contract.test.ts)
    // then requires their handlers. The health endpoints have theirs (HealthController), since OBE-068 the four
    // payment operations have theirs (ConsolePaymentsController) and since OBE-078 the two M5 webhooks theirs
    // (StripeConnectWebhookController, StripeConnectionWebhookController), so none is pending or undocumented.
    const implemented: ReadonlySet<Expected["task"]> = new Set(["served", "OBE-068", "OBE-078"]);
    for (const { operationId, task } of OBE_090_OPERATIONS) {
      expect([operationId, PENDING_OPERATIONS[operationId as keyof typeof PENDING_OPERATIONS]]).toEqual([
        operationId,
        implemented.has(task) ? undefined : task,
      ]);
    }
    expect(UNDOCUMENTED_ROUTES).toEqual([]);
  });
});

describe("console payments (api-changes part 2 §3; OADR-0010)", () => {
  it("gives every payment operation the console credentials, headers, tables and common errors [OBE-090 AC1]", () => {
    for (const { operationId } of CONSOLE_PAYMENT_OPERATIONS) {
      const op = operation(operationId);
      expect(op.spec).toMatchObject({ "x-amadeus": [] });
      // A staff token with the service or a secret key, or a console:automation key alone.
      expect([operationId, op.spec["security"]]).toEqual([
        operationId,
        [{ apiKey: [], staffAuth: [] }, { apiKey: [] }],
      ]);
      expect([operationId, parametersOf(op)]).toEqual([
        operationId,
        expect.arrayContaining(["VelexisEnvironment", "CustomerEndUserIp", "CustomerEndUserAgent"]),
      ]);
      // A refused call of any console operation writes staff_actions (OADR-0011 point 8 as decided on 2026-10-21).
      expect([operationId, op.spec["x-tenant-tables"]]).toEqual([
        operationId,
        expect.arrayContaining(["payments", "payment_events", "staff_actions"]),
      ]);
      expect([operationId, op.spec["x-platform-tables"]]).toEqual([
        operationId,
        ["payment_provider_connections"],
      ]);
      expect([operationId, op.spec["x-error-codes"]]).toEqual([
        operationId,
        expect.arrayContaining([...COMMON_CONSOLE_CODES]),
      ]);
      expect([operationId, objectAt(op.spec, "responses", "403")]).toEqual([
        operationId,
        { $ref: "#/components/responses/ConsoleForbidden" },
      ]);
    }
    for (const operationId of ["consoleGetPayment", "consoleCapturePayment", "consoleRefundPayment"]) {
      expect([operationId, parametersOf(operation(operationId))]).toEqual([
        operationId,
        expect.arrayContaining(["ConsolePaymentId"]),
      ]);
    }
    expect(
      problems("consoleGetPayment", { params: { paymentId: "rfd_01JAC2E5G7J0L3N6Q9S2U5W8Y1" } }),
    ).toEqual(["/path/paymentId pattern"]);
    // Reads are not audited per call; captures and refunds write their staff_actions row.
    for (const operationId of ["consoleListPayments", "consoleGetPayment"]) {
      expect([operationId, String(operation(operationId).spec["description"])]).toEqual([
        operationId,
        expect.stringContaining("not audited per call"),
      ]);
    }
    expect(String(operation("consoleCapturePayment").spec["description"])).toContain("`payment.capture`");
    expect(String(operation("consoleRefundPayment").spec["description"])).toContain("`payment.refund`");
  });

  it("names the roles of scope §1.3 that hold each payment permission [OBE-090 AC1]", () => {
    const holders = (permission: string): string[] =>
      Object.entries(ROLE_PERMISSIONS)
        .filter(([, permissions]) => (permissions as readonly string[]).includes(permission))
        .map(([role]) => role)
        .sort();
    expect(holders("payments:read")).toEqual(["admin", "agent", "finance", "owner", "viewer"]);
    expect(holders("payments:capture")).toEqual(["admin", "agent", "finance", "owner"]);
    expect(holders("payments:refund")).toEqual(["admin", "finance", "owner"]);
    expect(String(operation("consoleListPayments").spec["description"])).toContain(
      "`payments:read` (every role)",
    );
    expect(String(operation("consoleCapturePayment").spec["description"])).toContain(
      "`payments:capture` (owner, admin, agent, finance)",
    );
    expect(String(operation("consoleRefundPayment").spec["description"])).toContain(
      "`payments:refund` (owner, admin, finance)",
    );
  });

  it("filters the list by the Payment enums, the booking and the creation time, newest first [OBE-090 AC1]", () => {
    const list = operation("consoleListPayments");
    expect(parametersOf(list)).toEqual([
      "query:status",
      "query:provider",
      "query:method",
      "query:bookingId",
      "ConsoleCreatedFrom",
      "ConsoleCreatedTo",
      "Cursor",
      "Limit",
      "AcceptLanguage",
      "VelexisEnvironment",
      "CustomerEndUserIp",
      "CustomerEndUserAgent",
    ]);
    const payment = schemaOf("Payment");
    for (const name of ["status", "provider", "method"]) {
      const parameter = inlineParameter("consoleListPayments", name);
      expect([name, parameter["style"], parameter["explode"]]).toEqual([name, "form", false]);
      expect([name, objectAt(parameter, "schema", "items")["enum"]]).toEqual([
        name,
        objectAt(payment, "properties", name)["enum"],
      ]);
    }
    expect(objectAt(list.spec, "responses", "200", "content", "application/json", "schema")).toEqual({
      $ref: "#/components/schemas/ConsolePaymentPage",
    });

    const query = (value: Json) => problems("consoleListPayments", { query: value });
    expect(query({})).toEqual([]);
    expect(
      query({
        status: "authorized,captured",
        provider: "stripe",
        method: "card,airline_card",
        bookingId: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
        createdFrom: "2026-10-01T00:00:00Z",
        createdTo: "2026-11-01T00:00:00Z",
        limit: "50",
      }),
    ).toEqual([]);
    // The API spells cancelled as every state of the API does, never the stored `canceled`.
    expect(query({ status: "canceled" })).toEqual(["/query/status/0 enum"]);
    expect(query({ provider: "klarna" })).toEqual(["/query/provider/0 enum"]);
    expect(query({ bookingId: "VX7K2Q" })).toEqual(["/query/bookingId pattern"]);
    expect(query({ limit: "500" })).toEqual(["/query/limit maximum"]);
    // The list describes the environment and the order.
    const description = String(list.spec["description"]);
    expect(description).toContain("`X-Velexis-Environment`");
    expect(description).toContain("newest first");
    expect(
      checker.check("consoleListPayments", {
        status: 200,
        body: componentExample("ConsolePaymentPageExample"),
      }),
    ).toEqual([]);
  });

  it("refreshes a payment from Stripe only with refresh=true, and answers 502 PAYMENT_PROVIDER_ERROR when Stripe fails [OBE-090 AC1]", () => {
    const get = operation("consoleGetPayment");
    expect(inlineParameter("consoleGetPayment", "refresh")).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "boolean", default: false },
    });
    expect(
      problems("consoleGetPayment", { params: { paymentId: PAYMENT_ID }, query: { refresh: "true" } }),
    ).toEqual([]);
    expect(objectAt(get.spec, "responses", "200")).toEqual({
      $ref: "#/components/responses/ConsolePaymentOk",
    });
    expect(objectAt(get.spec, "responses", "502")).toEqual({
      $ref: "#/components/responses/ConsolePaymentProviderError",
    });
    expect(get.spec["x-error-codes"]).toEqual(
      expect.arrayContaining(["NOT_FOUND", "PAYMENT_PROVIDER_ERROR"]),
    );
    expect(objectAt(working, "components", "responses", "ConsolePaymentOk", "headers")).toMatchObject({
      ETag: { $ref: "#/components/headers/ETag" },
    });
    for (const name of ["ConsolePaymentExample", "ConsolePaymentCapturedExample"]) {
      expect([
        name,
        checker.check("consoleGetPayment", { status: 200, body: componentExample(name) }),
      ]).toEqual([name, []]);
    }
    const providerError = responseExample("ConsolePaymentProviderError", "PAYMENT_PROVIDER_ERROR");
    expect(checker.check("consoleGetPayment", { status: 502, body: providerError })).toEqual([]);
    expect(objectAt(providerError, "error")).toMatchObject({ code: "PAYMENT_PROVIDER_ERROR", status: 502 });
  });

  it("captures with If-Match and an Idempotency-Key, an optional amount and a required reason [OBE-090 AC1]", () => {
    const op = operation("consoleCapturePayment");
    expect(parametersOf(op)).toEqual(expect.arrayContaining(["IdempotencyKey", "IfMatch"]));
    expect(schemaOf("ConsolePaymentCaptureRequest")).toMatchObject({
      additionalProperties: false,
      required: ["reason"],
    });
    for (const name of ["full", "partial"]) {
      expect([name, capture(requestExample("consoleCapturePayment", name))]).toEqual([name, []]);
    }
    const typed: operations["consoleCapturePayment"]["requestBody"]["content"]["application/json"] = {
      amount: { amount: "100.00", currency: "EUR" },
      reason: "Manual review passed",
    };
    expect(capture(typed)).toEqual([]);
    expect(capture({ reason: "ok" })).toEqual(["/reason minLength"]);
    expect(capture({})).toEqual(["/reason required"]);
    expect(capture({ ...typed, amount: { amount: 100, currency: "EUR" } })).toEqual(["/amount/amount type"]);
    expect(capture({ ...typed, amount: { amount: "100.00", currency: "eur" } })).toEqual([
      "/amount/currency pattern",
    ]);
    expect(capture({ ...typed, paymentId: PAYMENT_ID })).toEqual(["/paymentId additionalProperties"]);
    expect(capture(typed, IDEMPOTENCY)).toEqual(["/header/If-Match required"]);
    expect(capture(typed, IF_MATCH)).toEqual(["/header/Idempotency-Key required"]);

    // The answers: the captured payment with its new ETag, and the refusals of §3.
    expect(objectAt(op.spec, "responses", "200")).toEqual({
      $ref: "#/components/responses/ConsolePaymentCaptured",
    });
    expect(objectAt(working, "components", "responses", "ConsolePaymentCaptured", "headers")).toMatchObject({
      ETag: { $ref: "#/components/headers/ETag" },
    });
    expect(Object.keys(objectAt(op.spec, "responses")).sort()).toEqual(
      ["200", "400", "401", "402", "403", "404", "409", "412", "422", "429", "500", "502"].sort(),
    );
    expect(op.spec["x-error-codes"]).toEqual(
      expect.arrayContaining([
        "PAYMENT_DECLINED",
        "NOT_FOUND",
        "CONFLICT",
        "IDEMPOTENCY_KEY_REUSED",
        "PRECONDITION_FAILED",
        "UNPROCESSABLE",
        "PAYMENT_PROVIDER_ERROR",
      ]),
    );
    const captured = componentExample("ConsolePaymentCapturedExample");
    expect(checker.check("consoleCapturePayment", { status: 200, body: captured })).toEqual([]);
    expect(captured).toMatchObject({
      status: "captured",
      provider: "stripe",
      amountCaptured: captured["amountAuthorized"],
    });
    expect(
      checker.check("consoleCapturePayment", {
        status: 402,
        body: responseExample("PaymentRequired", "PAYMENT_DECLINED"),
      }),
    ).toEqual([]);
    const description = String(op.spec["description"]).replace(/\s+/g, " ");
    // Stripe's idempotency key of OADR-0010 point 3, and the lock order of OADR-0003 point 11.
    expect(description).toContain("`pi:capture:<pay_id>:<amount>`");
    expect(description).toContain("locks the booking, then the payment");
    expect(description).toContain("`authorized`");
  });

  it("refunds with an Idempotency-Key, an amount, a refunds.reason and an optional note, and answers 201 [OBE-090 AC1]", () => {
    const op = operation("consoleRefundPayment");
    expect(parametersOf(op)).toEqual(expect.arrayContaining(["IdempotencyKey"]));
    expect(parametersOf(op)).not.toContain("IfMatch");
    const body = schemaOf("ConsolePaymentRefundRequest");
    expect(body).toMatchObject({ additionalProperties: false, required: ["amount", "reason"] });
    // The reasons are the refunds table's and the Refund schema's.
    expect(objectAt(body, "properties", "reason")["enum"]).toEqual([...REFUND_REASONS]);
    expect(objectAt(schemaOf("Refund"), "properties", "reason")["enum"]).toEqual([...REFUND_REASONS]);
    for (const name of ["goodwill", "duplicate"]) {
      expect([name, refund(requestExample("consoleRefundPayment", name))]).toEqual([name, []]);
    }
    const typed: operations["consoleRefundPayment"]["requestBody"]["content"]["application/json"] = {
      amount: { amount: "50.00", currency: "EUR" },
      reason: "goodwill",
      reasonNote: "Delayed flight",
    };
    expect(refund(typed)).toEqual([]);
    expect(refund({ reason: "goodwill" })).toEqual(["/amount required"]);
    expect(refund({ ...typed, reason: "refund" })).toEqual(["/reason enum"]);
    expect(refund({ ...typed, reasonNote: "x".repeat(501) })).toEqual(["/reasonNote maxLength"]);
    expect(refund(typed, {})).toEqual(["/header/Idempotency-Key required"]);

    // 201 with the pending refund; no Stripe call in the request, so no 502.
    expect(objectAt(op.spec, "responses", "201")).toEqual({
      $ref: "#/components/responses/ConsolePaymentRefundRequested",
    });
    expect(
      objectAt(working, "components", "responses", "ConsolePaymentRefundRequested", "headers"),
    ).toMatchObject({
      Location: { $ref: "#/components/headers/Location" },
      ETag: { $ref: "#/components/headers/ETag" },
    });
    expect(Object.keys(objectAt(op.spec, "responses")).sort()).toEqual(
      ["201", "400", "401", "403", "404", "409", "422", "429", "500"].sort(),
    );
    expect(op.spec["x-error-codes"]).not.toContain("PAYMENT_PROVIDER_ERROR");
    const requested = componentExample("ConsolePaymentRefundRequestedExample");
    expect(checker.check("consoleRefundPayment", { status: 201, body: requested })).toEqual([]);
    expect(requested["refunds"]).toEqual([
      expect.objectContaining({
        status: "pending",
        reason: "goodwill",
        requestedBy: { type: "staff", id: expect.stringMatching(/^stf_/) },
        providerRefundId: null,
      }),
    ]);
    const description = String(op.spec["description"]).replace(/\s+/g, " ");
    expect(description).toContain("`refund.submit`");
    expect(description).toContain("`refund:<rfd_id>`");
    expect(description).toContain("`requested_by_type = staff`");
    // The payment statuses a refund accepts are the refunds repository's.
    expect([...REFUNDABLE_PAYMENT_STATUSES].sort()).toEqual(["captured", "partially_refunded"]);
    expect(description).toContain("`captured` or `partially_refunded`");
  });

  it("refuses with 409 CONFLICT and 422 UNPROCESSABLE and the details.reason values of §3 [OBE-090 AC1]", () => {
    for (const operationId of ["consoleCapturePayment", "consoleRefundPayment"]) {
      const spec = operation(operationId).spec;
      expect([operationId, objectAt(spec, "responses", "409")]).toEqual([
        operationId,
        { $ref: "#/components/responses/ConsolePaymentConflict" },
      ]);
      expect([operationId, objectAt(spec, "responses", "422")]).toEqual([
        operationId,
        { $ref: "#/components/responses/ConsolePaymentUnprocessable" },
      ]);
    }
    const reasons = (response: string): string[] =>
      Object.values(responseExamples(response))
        .map((example) => objectAt(example, "value", "error"))
        .filter((error) => isObject(error["details"]) && "reason" in error["details"])
        .map((error) => String(objectAt(error, "details")["reason"]))
        .sort();
    expect(reasons("ConsolePaymentConflict")).toEqual(["payment_not_capturable", "payment_not_refundable"]);
    expect(reasons("ConsolePaymentUnprocessable")).toEqual([
      "amount_exceeds_authorized",
      "amount_exceeds_captured",
      "currency_mismatch",
      "refund_via_airline",
    ]);
    const captureText = String(operation("consoleCapturePayment").spec["description"]);
    const refunds = String(operation("consoleRefundPayment").spec["description"]);
    for (const reason of ["payment_not_capturable", "amount_exceeds_authorized", "currency_mismatch"]) {
      expect([reason, captureText.includes(`"${reason}"`)]).toEqual([reason, true]);
    }
    // api-changes §3 names amount_exceeds_captured and refund_via_airline for refunds.
    for (const reason of [
      "payment_not_refundable",
      "amount_exceeds_captured",
      "refund_via_airline",
      "currency_mismatch",
    ]) {
      expect([reason, refunds.includes(`"${reason}"`)]).toEqual([reason, true]);
    }
    for (const [response, status, operationId] of [
      ["ConsolePaymentConflict", 409, "consoleCapturePayment"],
      ["ConsolePaymentConflict", 409, "consoleRefundPayment"],
      ["ConsolePaymentUnprocessable", 422, "consoleCapturePayment"],
      ["ConsolePaymentUnprocessable", 422, "consoleRefundPayment"],
    ] as const) {
      for (const [name, example] of Object.entries(responseExamples(response))) {
        const body = objectAt(example, "value");
        expect([response, name, checker.check(operationId, { status, body })]).toEqual([response, name, []]);
      }
    }
  });

  it("defines ConsolePayment as Payment with environment, version, events, refunds, booking and account mode [OBE-090 AC1]", () => {
    expect(schemaOf("ConsolePayment")["allOf"]).toEqual([
      { $ref: "#/components/schemas/Payment" },
      { $ref: "#/components/schemas/ConsolePaymentDetails" },
    ]);
    const details = schemaOf("ConsolePaymentDetails");
    expect(details["required"]).toEqual([
      "environment",
      "version",
      "events",
      "refunds",
      "booking",
      "providerConnection",
    ]);
    expect(objectAt(details, "properties", "events", "items")).toEqual({
      $ref: "#/components/schemas/ConsolePaymentEvent",
    });
    expect(objectAt(details, "properties", "refunds", "items")).toEqual({
      $ref: "#/components/schemas/ConsolePaymentRefund",
    });
    expect(schemaOf("ConsolePaymentBooking")["required"]).toEqual(["id", "reference", "status"]);
    expect(objectAt(schemaOf("ConsolePaymentBooking"), "properties", "status")).toMatchObject({
      $ref: "#/components/schemas/BookingStatus",
    });
    // The account modes are the storefront's (StorefrontPaymentConfig) and the platform's connection modes.
    expect(
      objectAt(schemaOf("ConsolePaymentProviderConnection"), "properties", "accountMode")["enum"],
    ).toEqual(objectAt(schemaOf("StorefrontPaymentConfig"), "properties", "accountMode")["enum"]);
    // An event's source is payment_events.source; a refund's requester refunds.requested_by_type.
    expect(objectAt(schemaOf("ConsolePaymentEvent"), "properties", "source")["enum"]).toEqual(
      checkValues("payment_events", "source"),
    );
    expect(checkValues("payment_events", "source")).toEqual(["api", "webhook", "system", "staff"]);
    expect(schemaOf("ConsolePaymentRefund")["allOf"]).toEqual([
      { $ref: "#/components/schemas/Refund" },
      { $ref: "#/components/schemas/ConsolePaymentRefundDetails" },
    ]);
    expect(objectAt(schemaOf("ConsolePaymentRefundRequester"), "properties", "type")["enum"]).toEqual([
      ...REFUND_REQUESTERS,
    ]);
    expect(checkValues("refunds", "requested_by_type")).toEqual([...REFUND_REQUESTERS]);

    // The generated types compile from the examples' shape.
    const example = componentExample(
      "ConsolePaymentExample",
    ) as unknown as components["schemas"]["ConsolePayment"];
    const typed: components["schemas"]["ConsolePayment"] = { ...example, clientSecret: null };
    expect(typed.version).toBe(3);
    // No example of console scope carries a client secret or more of a card than its brand, BIN, last 4 and expiry.
    const payments = [
      componentExample("ConsolePaymentExample"),
      componentExample("ConsolePaymentCapturedExample"),
      componentExample("ConsolePaymentRefundRequestedExample"),
      ...(componentExample("ConsolePaymentPageExample")["data"] as Json[]),
    ];
    for (const payment of payments) {
      expect([payment["id"], payment["clientSecret"]]).toEqual([payment["id"], null]);
      expect(Object.keys(objectAt(payment, "card")).sort()).toEqual([
        "bin",
        "brand",
        "expMonth",
        "expYear",
        "last4",
      ]);
      // Its booking and the payment agree.
      expect([payment["id"], objectAt(payment, "booking")["id"]]).toEqual([
        payment["id"],
        payment["bookingId"],
      ]);
    }
    expect(String(schemaOf("ConsolePayment")["description"])).toContain("`clientSecret` is always `null`");
  });

  it("shows the payment events of the examples as the payments code writes them [OBE-090 AC1]", () => {
    const payments = [
      componentExample("ConsolePaymentExample"),
      componentExample("ConsolePaymentCapturedExample"),
      componentExample("ConsolePaymentRefundRequestedExample"),
      ...(componentExample("ConsolePaymentPageExample")["data"] as Json[]),
    ];
    const types = new Set<string>();
    for (const payment of payments) {
      const events = payment["events"] as Json[];
      for (const event of events) {
        const type = String(event["type"]);
        types.add(type);
        const where = `${String(payment["id"])} ${type}`;
        if (type.startsWith("webhook.")) {
          // The receiver's row (webhook-receiver.service.ts): no status, no amount, the event id, and the payload
          // that storedPayloadOf derives from the Stripe event.
          const payload = objectAt(event, "payload");
          const object = objectAt(payload, "object");
          const stripeEvent = {
            id: payload["eventId"],
            object: "event",
            type: payload["type"],
            livemode: payload["livemode"],
            created: Date.parse(String(payload["createdAt"])) / 1000,
            api_version: payload["apiVersion"],
            data: {
              object: {
                object: object["type"],
                id: object["id"],
                status: object["status"],
                currency: object["currency"],
                amount: object["amount"],
                amount_capturable: object["amountCapturable"],
                amount_received: object["amountReceived"],
              },
            },
          } as unknown as Stripe.Event;
          expect([where, event]).toMatchObject([
            where,
            {
              source: "webhook",
              statusFrom: null,
              statusTo: null,
              amount: null,
              providerEventId: payload["eventId"],
            },
          ]);
          expect([where, type]).toEqual([where, `webhook.${String(payload["type"])}`]);
          expect([where, payload]).toEqual([where, storedPayloadOf(stripeEvent, eventFactsOf(stripeEvent))]);
          continue;
        }
        // Every other event carries no Stripe event id of its own; a payment's events name payment statuses and a
        // refund's events refund statuses.
        expect([where, event["providerEventId"]]).toEqual([where, null]);
        if (type === "payment.created") {
          expect([where, event]).toMatchObject([
            where,
            { source: "api", statusFrom: null, statusTo: "requires_payment_method", amount: null },
          ]);
          expect([where, objectAt(event, "payload")["checkoutId"]]).toEqual([where, payment["checkoutId"]]);
        }
        if (type === "payment.authorized") {
          // Applied by the ota-stripe-events processor after the stored webhook it names.
          expect([where, event["source"]]).toEqual([where, "webhook"]);
          const stored = events.find(({ id }) => id === objectAt(event, "payload")["paymentEventId"]);
          expect([where, String(stored?.["type"]).startsWith("webhook.")]).toEqual([where, true]);
        }
        if (type === "refund.requested") {
          // refunds.repository.ts writes the new refund's status, not the payment's.
          const refundId = objectAt(event, "payload")["refundId"];
          const requested = (payment["refunds"] as Json[]).find(({ id }) => id === refundId);
          expect([where, event["statusTo"], requested?.["status"]]).toEqual([where, "pending", "pending"]);
          expect([where, event["source"]]).toEqual([where, "staff"]);
        }
      }
    }
    expect([...types].sort()).toEqual([
      "payment.authorized",
      "payment.captured",
      "payment.created",
      "refund.requested",
      "webhook.payment_intent.amount_capturable_updated",
    ]);
    const statusFrom = String(
      objectAt(schemaOf("ConsolePaymentEvent"), "properties", "statusFrom")["description"],
    );
    expect(statusFrom.replace(/\s+/g, " ")).toContain(
      "the refund's (as `Refund.status` spells it) for a `refund.*` event",
    );
  });

  it("aligns ota/sdk/docs/extensions.md §3.3 with the document: one row per method, its route and its parameters [OBE-090 AC1]", () => {
    const text = readFileSync(EXTENSIONS_DOCUMENT, "utf8");
    const section = text.slice(text.indexOf("### 3.3"), text.indexOf("## 4."));
    const rows = section.split("\n").filter((line) => line.startsWith("| `console.payments."));
    expect(rows).toHaveLength(4);
    for (const expected of CONSOLE_PAYMENT_OPERATIONS) {
      const row = rows.find((line) => line.startsWith(`| \`${String(expected.sdkMethod)}\` |`));
      const cells = (row ?? "").split("|").map((cell) => cell.trim());
      expect([expected.operationId, cells[2]]).toEqual([
        expected.operationId,
        `\`${expected.method.toUpperCase()} ${expected.path}\``,
      ]);
      // The method's params: path and query parameters, the body's properties and `ifMatch` for If-Match.
      const op = operation(expected.operationId);
      const fromDocument = [
        ...((op.spec["parameters"] as Json[] | undefined) ?? [])
          .map((parameter) => document.resolve(parameter) as Json)
          .filter((parameter) => parameter["in"] === "path" || parameter["in"] === "query")
          .map((parameter) => String(parameter["name"])),
        ...(parametersOf(op).includes("IfMatch") ? ["ifMatch"] : []),
        ...Object.keys(
          isObject(op.spec["requestBody"])
            ? objectAt(
                document.resolve(objectAt(op.spec, "requestBody", "content", "application/json")["schema"]),
                "properties",
              )
            : {},
        ),
      ];
      const fromRow = [
        ...(/^`\{ ([^}]*) \}`/.exec(cells[3] ?? "")?.[1] ?? "").matchAll(/([A-Za-z]+)\??/g),
      ].map((match) => match[1] ?? "");
      expect([expected.operationId, [...fromRow].sort()]).toEqual([
        expected.operationId,
        [...fromDocument].sort(),
      ]);
    }
  });
});

describe("the health endpoints (api-changes part 2 §5; ADR-0016)", () => {
  it("documents GET /health/live and /health/ready without a credential, as HealthController answers them [OBE-090 AC1]", () => {
    // A credential sent anyway meets the caller guard (caller-resolver.ts, api-key.verifier.ts): 400 INVALID_REQUEST,
    // 401 INVALID_API_KEY, 403 ORIGIN_NOT_ALLOWED, or 503 SERVICE_UNAVAILABLE when the key cannot be looked up.
    const callerGuardErrors: Record<number, Json> = {
      400: { code: "INVALID_REQUEST", details: { reason: "edge_with_api_key" } },
      401: { code: "INVALID_API_KEY" },
      403: { code: "ORIGIN_NOT_ALLOWED" },
      503: { code: "SERVICE_UNAVAILABLE" },
    };
    for (const operationId of HEALTH) {
      const op = operation(operationId);
      expect([operationId, op.spec["security"]]).toEqual([operationId, []]);
      expect([operationId, op.spec["x-error-codes"]]).toEqual([
        operationId,
        ["INVALID_REQUEST", "INVALID_API_KEY", "ORIGIN_NOT_ALLOWED", "SERVICE_UNAVAILABLE"],
      ]);
      expect([operationId, objectAt(op.spec, "responses", "200", "headers")]).toEqual([
        operationId,
        expect.objectContaining({ "Cache-Control": expect.anything() }),
      ]);
      expect([operationId, Object.keys(objectAt(op.spec, "responses")).sort()]).toEqual([
        operationId,
        ["200", "400", "401", "403", "503"],
      ]);
      for (const [status, error] of Object.entries(callerGuardErrors)) {
        const body = {
          error: {
            message: "Refused by the caller guard.",
            status: Number(status),
            requestId: "req_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
            ...error,
          },
        };
        expect([operationId, status, checker.check(operationId, { status: Number(status), body })]).toEqual([
          operationId,
          status,
          [],
        ]);
      }
    }
    // healthReady answers 503 with the readiness body, or with the error envelope of the caller guard.
    expect(
      objectAt(operation("healthReady").spec, "responses", "503", "content", "application/json", "schema"),
    ).toEqual({
      oneOf: [
        { $ref: "#/components/schemas/HealthReadiness" },
        { $ref: "#/components/schemas/ErrorResponse" },
      ],
    });
    expect(String(operation("healthLive").spec["description"]).replace(/\s+/g, " ")).toContain(
      "a publishable key from an origin it does not list `403 ORIGIN_NOT_ALLOWED`, and a key that cannot be looked up",
    );

    // The API's own answers (createTestApp builds the application as main.ts does).
    expect([live.status, live.body]).toEqual([200, { status: "ok" }]);
    expect(live.headers["cache-control"]).toBe("no-store");
    expect(live.headers["x-request-id"]).toEqual(expect.any(String));
    expect(checker.check("healthLive", live)).toEqual([]);
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ status: "unavailable" });
    expect(checker.check("healthReady", ready)).toEqual([]);
  });

  it("matches every readiness answer of HealthService, and the worker's queues of OBE-025 [OBE-090 AC1]", async () => {
    const quiet = { warn: () => undefined, error: () => undefined } as unknown as PinoLogger;
    const probe = (name: DependencyName, outcome: "ok" | "down"): DependencyProbe => ({
      name,
      check: () => (outcome === "ok" ? Promise.resolve() : Promise.reject(new Error("refused"))),
      close: () => Promise.resolve(),
    });
    for (const [postgres, redis] of [
      ["ok", "ok"],
      ["ok", "down"],
      ["down", "ok"],
      ["down", "down"],
    ] as const) {
      const readiness = await new HealthService(
        [probe("postgres", postgres), probe("redis", redis)],
        quiet,
      ).ready();
      const status = readiness.ready ? 200 : 503;
      expect([
        postgres,
        redis,
        status,
        checker.check("healthReady", { status, body: readiness.body }),
      ]).toEqual([postgres, redis, postgres === "ok" && redis === "ok" ? 200 : 503, []]);
    }
    expect(schemaOf("HealthDependencyStatus")["enum"]).toEqual(["ok", "timeout", "down"]);
    // The worker adds its queues; a readiness body never carries anything else.
    const worker = objectAt(
      operation("healthReady").spec,
      "responses",
      "200",
      "content",
      "application/json",
      "examples",
      "worker",
      "value",
    );
    expect(checker.check("healthReady", { status: 200, body: worker })).toEqual([]);
    expect(
      checker.check("healthReady", {
        status: 200,
        body: { ...worker, queues: { "ota-payments": { waiting: 1 } } },
      }),
    ).not.toEqual([]);
    expect(
      checker.check("healthReady", { status: 200, body: { ...worker, database: "velexis" } }),
    ).not.toEqual([]);
    expect(checker.check("healthLive", { status: 200, body: { status: "ok", uptime: 12 } })).not.toEqual([]);
  });
});

describe("the Connect and connection webhooks (api-changes part 2 §5; OADR-0010 point 4)", () => {
  it("takes the signed Stripe event without a credential and answers as the Velexis endpoint does [OBE-090 AC1]", () => {
    const velexis = operation("receiveStripeVelexisWebhook").spec;
    const signature = ((velexis["parameters"] as Json[] | undefined) ?? []).find(
      (parameter) => parameter["name"] === "Stripe-Signature",
    );
    for (const operationId of WEBHOOKS) {
      const op = operation(operationId);
      expect([operationId, op.spec["security"]]).toEqual([operationId, []]);
      expect([operationId, inlineParameter(operationId, "Stripe-Signature")]).toEqual([
        operationId,
        signature,
      ]);
      expect([operationId, op.spec["x-error-codes"]]).toEqual([operationId, velexis["x-error-codes"]]);
      expect([operationId, Object.keys(objectAt(op.spec, "responses")).sort()]).toEqual([
        operationId,
        Object.keys(objectAt(velexis, "responses")).sort(),
      ]);
      expect([operationId, op.spec["x-tenant-tables"]]).toEqual([
        operationId,
        ["payments", "payment_events"],
      ]);
      expect([operationId, op.spec["x-platform-tables"]]).toEqual([
        operationId,
        ["payment_provider_connections", "tenants"],
      ]);
      expect([operationId, objectAt(op.spec, "requestBody")["required"]]).toEqual([operationId, true]);
      expect(checker.check(operationId, { status: 200, body: { received: true } })).toEqual([]);
      const signatureRefused = {
        error: {
          code: "INVALID_REQUEST",
          message: "The Stripe signature of the request is not valid.",
          status: 400,
          requestId: "req_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
          details: { reason: "signature_invalid" },
        },
      };
      expect(checker.check(operationId, { status: 400, body: signatureRefused })).toEqual([]);
    }
    expect(inlineParameter("receiveStripeConnectWebhook", "environment")).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "string", enum: ["test", "live"] },
    });
    // The platform's connection ids (ppc_ + ULID), as its webhookUrl names them.
    expect(inlineParameter("receiveStripeConnectionWebhook", "connectionId")).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "string", pattern: "^ppc_[0-9A-HJKMNP-TV-Z]{26}$" },
    });
    const connectionPath = (connectionId: string) =>
      problems("receiveStripeConnectionWebhook", {
        params: { connectionId },
        headers: { "stripe-signature": "t=1,v1=00" },
        // The raw bytes of a webhook route (body-parsers.ts), which the validator passes through untouched.
        body: Buffer.from("{}"),
        bodySent: true,
      });
    expect(connectionPath("ppc_01JA2ZBA4D8F2H6K0N4Q8S2V6X")).toEqual([]);
    expect(connectionPath("pay_01JA2ZBA4D8F2H6K0N4Q8S2V6X")).toEqual(["/path/connectionId pattern"]);
    // Compiles only while the generated types say so.
    type ConnectionPath = operations["receiveStripeConnectionWebhook"]["parameters"]["path"];
    const path: ConnectionPath = { connectionId: "ppc_01JA2ZBA4D8F2H6K0N4Q8S2V6X" };
    expect(Object.keys(path)).toEqual(["connectionId"]);

    // Connect events carry the connected account.
    expect(
      objectAt(
        operation("receiveStripeConnectWebhook").spec,
        "requestBody",
        "content",
        "application/json",
        "schema",
      ),
    ).toEqual({
      $ref: "#/components/schemas/StripeConnectWebhookEvent",
    });
    expect(schemaOf("StripeConnectWebhookEvent")["allOf"]).toEqual([
      { $ref: "#/components/schemas/StripeWebhookEvent" },
      expect.objectContaining({ required: ["account"] }),
    ]);
    const connectEvent: components["schemas"]["StripeConnectWebhookEvent"] = {
      id: "evt_example",
      object: "event",
      account: "acct_example",
      type: "charge.refunded",
      livemode: false,
      data: { object: { id: "ch_example" } },
    };
    expect(connectEvent.account).toBe("acct_example");
    expect(
      objectAt(
        operation("receiveStripeConnectionWebhook").spec,
        "requestBody",
        "content",
        "application/json",
        "schema",
      ),
    ).toEqual({ $ref: "#/components/schemas/StripeWebhookEvent" });
  });

  it("states each endpoint's own tenant rule and the metadata and livemode cross-checks of OADR-0010 point 4 [OBE-090 AC1]", () => {
    const connect = String(operation("receiveStripeConnectWebhook").spec["description"]).replace(/\s+/g, " ");
    const connection = String(operation("receiveStripeConnectionWebhook").spec["description"]).replace(
      /\s+/g,
      " ",
    );
    // Connect: the tenant only from event.account, through the one connection of that account (any mode since lead
    // decision (2l) of 2026-10-31, FIX-W37-OTA: until then the connect_standard connection only).
    expect(connect).toContain("The OTA comes **only** from `event.account`");
    expect(connect).toContain(
      "the one Stripe connection of `{environment}` whose `account_reference` is that `acct_…`",
    );
    expect(connect).toContain("connections of several OTAs holding that account, is an unknown account");
    // Step 4 on both: the payment created on the event's account (the account compared, not the mode; OADR-0010
    // point 4, note of 2026-10-31).
    expect(connect).toContain("the payment must have been created on the event's `acct_…`");
    expect(connection).toContain("the payment must have been created on the connection's `acct_…`");
    for (const description of [connect, connection]) {
      expect(description).toContain("the account is compared, not the mode");
      expect(description).toContain("OADR-0010 point 4, note of 2026-10-31");
    }
    expect(connect).toContain("`STRIPE_WEBHOOK_SECRET_CONNECT_TEST`");
    expect(connect).toContain("`event.livemode` must match `{environment}`");
    // c/<ppc_id>: the tenant only from the path's connection, verified with that connection's own secret.
    expect(connection).toContain("The OTA comes **only** from the path's connection");
    expect(connection).toContain("that connection's own webhook signing secret");
    expect(connection).toContain("`event.livemode` must match the connection's environment");
    expect(connection).toContain("`api_keys` mode");
    for (const description of [connect, connection]) {
      // Metadata never selects the tenant; it is cross-checked, and a mismatch is acknowledged without effect.
      expect(description).toContain("`metadata.velexis_tenant_id` never selects the OTA");
      expect(description).toContain("`metadata.velexis_environment`");
      expect(description).toContain("inside that OTA only");
      expect(description).toContain("logged as a security event");
      expect(description).toContain(
        "**Acknowledged without effect** (`200`, nothing written, no staff alert",
      );
      expect(description).toContain("`ota-stripe-events`");
      expect(description).toContain("served from M5 (OBE-078)");
    }
  });
});
