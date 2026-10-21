// Contract test of OBE-009: the spec-first changes of ota/docs/api-changes.md §1, §2, §5 and §6 in the OTA document
// (openapi/velexis-ota-booking-api.openapi.yaml) and the milestone of every original operation (ota/docs/scope.md §3).
// OBE-029 adds the airline-card method (§3.1), the edge-only operation completeCheckoutWithAirlineCard (§3.2), the
// payment account modes of StorefrontPaymentConfig (§4) and PAYMENT_ATTEMPTS_EXCEEDED (§6). OBE-039 adds the webhook
// receiver of the Velexis Stripe account, receiveStripeVelexisWebhook (api-changes-console-and-internal.md §5). OBE-061
// adds the needs-attention filters of consoleListBookings (api-changes-console-and-internal.md §7).
//
// The 96 operations of the original design are read from the frozen copy under docs/velexis-sdk/openapi/, so the
// counts asserted here (77 MVP, 19 deferred, 63 customer-scope) never change when later spec tasks add operations.
// The rules that hold for every operation (an x-milestone, the edge alternatives of customer-scope operations, the
// CSRF header on state-changing ones, the environment header on console ones) run on the whole working document;
// later spec tasks add assertions for their own operations by operationId, never totals (OBE-075 checks the M4 totals
// once). `pnpm contracts:lint` (X-007) and the generators' own tests (X-008, X-009) cover the lint and the
// determinism of the generated files.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { components, operations } from "@velexis/api-types";
import { otaOperations, type ApiOperation } from "@velexis/api-types/operations";
import { ERROR_CATALOGUE, OTA_ERROR_CODES, type ErrorCode } from "@velexis/errors";
import { createResponseChecker, responseChecker, type ResponseChecker } from "@velexis/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_DIR } from "../../src/config";

const REPO_ROOT = join(APP_DIR, "..", "..");
const WORKING_DOCUMENT = join(APP_DIR, "openapi", "velexis-ota-booking-api.openapi.yaml");
const FROZEN_DOCUMENT = join(
  REPO_ROOT,
  "docs",
  "velexis-sdk",
  "openapi",
  "velexis-ota-booking-api.openapi.yaml",
);
/** sha256 of the frozen original: the copy under docs/velexis-sdk/ is never edited (decisions.md §3, ADR-0006). */
const FROZEN_DOCUMENT_SHA256 = "98bd3c523f1da941b018600a1f130037e84900aa442fb5ceb19940e6ff0ebcfb";

/** Parsing and compiling the 40,000-line document takes a few seconds on a busy runner. */
const DOCUMENT_TIMEOUT_MS = 60_000;

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const STATE_CHANGING = new Set(["post", "put", "patch", "delete"]);
/** The values of `x-milestone` the OTA document uses (api-changes §1; health is M0, the M5 webhooks M5). */
const MILESTONE_PATTERN = /^(M[0-5]|deferred)$/;

type Milestone = "M2" | "M3" | "M4" | "deferred";

/**
 * The milestone of each of the 96 original operations, by `x-sdk-method`, exactly as the tables of scope §3 list
 * them. Totals: 77 MVP (M2 16, M3 34, M4 27) and 19 deferred.
 */
const SCOPE_MILESTONES: Readonly<Record<string, Milestone>> = {
  // §3.1 B1 Storefront, auth, account, reference (30: 20 MVP, 10 deferred)
  "storefront.get": "M2",
  "storefront.resolve": "deferred",
  "auth.signUp": "M3",
  "auth.verifyEmail": "M3",
  "auth.resendVerification": "M3",
  "auth.signIn": "M3",
  "auth.refresh": "M3",
  "auth.signOut": "M3",
  "auth.requestPasswordReset": "M3",
  "auth.resetPassword": "M3",
  "auth.changePassword": "M3",
  "auth.getSession": "M3",
  "account.get": "M3",
  "account.update": "M3",
  "account.delete": "M3",
  "account.preferences.get": "deferred",
  "account.preferences.update": "deferred",
  "account.dataExports.create": "deferred",
  "account.dataExports.get": "deferred",
  "account.savedTravelers.list": "deferred",
  "account.savedTravelers.create": "deferred",
  "account.savedTravelers.get": "deferred",
  "account.savedTravelers.update": "deferred",
  "account.savedTravelers.delete": "deferred",
  "reference.locations.search": "M2",
  "reference.airports.get": "M2",
  "reference.airlines.list": "M2",
  "reference.airlines.get": "M2",
  "reference.countries.list": "M2",
  "reference.currencies.list": "M2",
  // §3.2 B2 Flights (10: 9 MVP, 1 deferred)
  "flights.search": "M2",
  "flights.getSearch": "M2",
  "flights.listResults": "M2",
  "flights.getOffer": "M2",
  "flights.upsell": "M2",
  "flights.availability": "deferred",
  "flights.price": "M2",
  "flights.getPricedOffer": "M2",
  "flights.getAncillaries": "M2",
  "flights.getFareRules": "M2",
  // §3.3 B3 Checkout, payments, bookings (24: 21 MVP, 3 deferred)
  "checkout.create": "M3",
  "checkout.get": "M3",
  "checkout.setTravelers": "M3",
  "checkout.setContacts": "M3",
  "checkout.setAncillaries": "M3",
  "checkout.setRemarks": "M3",
  "checkout.createPayment": "M3",
  "checkout.getPayment": "M3",
  "checkout.updatePayment": "M3",
  "checkout.complete": "M3",
  "bookings.list": "M3",
  "bookings.get": "M3",
  "bookings.lookup": "M3",
  "bookings.getTicketingStatus": "M3",
  "bookings.update": "M3",
  "bookings.quoteCancellation": "M3",
  "bookings.cancel": "M3",
  "bookings.getFareRules": "M3",
  "bookings.listDocuments": "M3",
  "bookings.getDocumentDownloadUrl": "M3",
  "bookings.listEvents": "M3",
  "bookings.getAncillaries": "deferred",
  "bookings.addAncillaries": "deferred",
  "bookings.createPayment": "deferred",
  // §3.4 B4 Console (32: 27 MVP, 5 deferred)
  "console.auth.signIn": "M4",
  "console.auth.refresh": "M4",
  "console.auth.signOut": "M4",
  "console.auth.me": "M4",
  "console.bookings.list": "M4",
  "console.bookings.get": "M4",
  "console.bookings.patch": "M4",
  "console.bookings.issue": "M4",
  "console.bookings.cancel": "M4",
  "console.bookings.resync": "M4",
  "console.bookings.addNote": "M4",
  "console.bookings.retrieve": "M4",
  "console.bookings.findByRecordLocator": "M4",
  "console.bookings.import": "M4",
  "console.bookings.create": "deferred",
  "console.queues.list": "M4",
  "console.queues.listSnapshots": "M4",
  "console.customers.list": "M4",
  "console.customers.get": "M4",
  "console.supplierRequests.list": "M4",
  "console.amadeus.searchFlightOffers": "M4",
  "console.amadeus.getFlightOffers": "M4",
  "console.amadeus.searchFlightAvailabilities": "M4",
  "console.amadeus.upsellAirOffers": "M4",
  "console.amadeus.quoteAirOffers": "M4",
  "console.amadeus.getFlightOrder": "M4",
  "console.amadeus.getFlightOrderByReference": "M4",
  "console.amadeus.getQueue": "M4",
  "console.amadeus.createFlightOrders": "deferred",
  "console.amadeus.issueFlightOrder": "deferred",
  "console.amadeus.patchFlightOrder": "deferred",
  "console.amadeus.cancelFlightOrder": "deferred",
};

/** The key credentials of the original design and their edge counterparts (api-changes §2.2). */
const EDGE_COUNTERPART: Readonly<Record<string, string>> = {
  apiKey: "storefrontEdge",
  customerAuth: "customerCookie",
  bookingToken: "bookingCookie",
};

/** The success responses that set cookies in edge mode (api-changes §2.2), by operationId. */
const COOKIE_RESPONSES: Readonly<Record<string, readonly string[]>> = {
  getStorefront: ["200", "304"],
  signUp: ["201"],
  signIn: ["200"],
  refreshSession: ["200"],
  signOut: ["204"],
  resetPassword: ["200"],
  changePassword: ["200"],
  deleteAccount: ["202"],
  completeCheckout: ["201"],
  lookupBooking: ["200"],
};

type Json = Record<string, unknown>;
type SecurityRequirement = Record<string, unknown[]>;

interface Operation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly spec: Json;
  /** The parameters of the path item, which apply to each of its operations. */
  readonly pathParameters: Json[];
}

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

function readYaml(file: string): Json {
  const document: unknown = parse(readFileSync(file, "utf8"));
  if (!isObject(document)) {
    throw new Error(`${file} is not a YAML mapping`);
  }
  return document;
}

function operationsOf(document: Json): Operation[] {
  return Object.entries(objectAt(document, "paths")).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => isObject(item) && isObject(item[method])).map((method) => {
      const spec = objectAt(item, method);
      const pathParameters = ((item as Json)["parameters"] as Json[] | undefined) ?? [];
      return { operationId: String(spec["operationId"]), method, path, spec, pathParameters };
    }),
  );
}

const securityOf = (operation: Operation): SecurityRequirement[] =>
  (operation.spec["security"] as SecurityRequirement[] | undefined) ?? [];

/** The component parameters an operation takes, its path item's included. */
const parameterRefsOf = (operation: Operation): string[] =>
  [...operation.pathParameters, ...((operation.spec["parameters"] as Json[] | undefined) ?? [])].flatMap(
    (parameter) =>
      typeof parameter["$ref"] === "string"
        ? [parameter["$ref"].replace("#/components/parameters/", "")]
        : [],
  );

const isCustomerScope = (operation: Operation): boolean =>
  operation.spec["x-scope"] === "customer" || operation.spec["x-scope"] === "both";

/** A customer-scope operation that takes a key credential (public ones, `security: []`, take none). */
const takesKey = (operation: Operation): boolean =>
  securityOf(operation).some((requirement) => "apiKey" in requirement);

/** The edge alternatives a customer-scope operation must list: its key alternatives without staff ones, mapped. */
function mirroredEdgeAlternatives(operation: Operation): string[] {
  const mirrored = securityOf(operation)
    .filter((requirement) => "apiKey" in requirement && !("staffAuth" in requirement))
    .map((requirement) =>
      Object.keys(requirement)
        .map((scheme) => EDGE_COUNTERPART[scheme] ?? `unmapped:${scheme}`)
        .sort()
        .join("+"),
    );
  return [...new Set(mirrored)].sort();
}

const edgeAlternatives = (operation: Operation): string[] =>
  securityOf(operation)
    .filter((requirement) => "storefrontEdge" in requirement)
    .map((requirement) => Object.keys(requirement).sort().join("+"))
    .sort();

/** An operation the hosted storefront edge may call: one of its security alternatives is `storefrontEdge`. */
const acceptsEdge = (operation: Operation): boolean =>
  securityOf(operation).some((requirement) => "storefrontEdge" in requirement);

let working: Json;
let frozen: Json;
let workingOperations: Operation[];
let frozenOperations: Operation[];
let byId: Map<string, Operation>;
let checker: ResponseChecker;

beforeAll(() => {
  working = readYaml(WORKING_DOCUMENT);
  frozen = readYaml(FROZEN_DOCUMENT);
  workingOperations = operationsOf(working);
  frozenOperations = operationsOf(frozen);
  byId = new Map(workingOperations.map((operation) => [operation.operationId, operation]));
  checker = responseChecker("ota");
}, DOCUMENT_TIMEOUT_MS);

function operation(operationId: string): Operation {
  const found = byId.get(operationId);
  if (found === undefined) {
    throw new Error(`the OTA document has no operation ${operationId}`);
  }
  return found;
}

/** The JSON example of an operation's response: `example`, or the first of `examples` (resolved). */
function responseExample(operationId: string, status: string): unknown {
  const media = objectAt(operation(operationId).spec, "responses", status, "content", "application/json");
  if (media["example"] !== undefined) {
    return media["example"];
  }
  const first = Object.values(objectAt(media, "examples"))[0];
  if (!isObject(first)) {
    throw new Error(`${operationId} ${status} has no example`);
  }
  const ref = first["$ref"];
  return typeof ref === "string"
    ? objectAt(working, "components", "examples", ref.replace("#/components/examples/", ""))["value"]
    : first["value"];
}

describe("x-milestone (scope §3)", () => {
  it("gives every operation of the document an x-milestone, M0 … M5 or deferred, and the index the same [OBE-009 AC2]", () => {
    expect(workingOperations.length).toBeGreaterThanOrEqual(96);
    for (const { operationId, spec } of workingOperations) {
      expect([operationId, spec["x-milestone"]]).toEqual([
        operationId,
        expect.stringMatching(MILESTONE_PATTERN),
      ]);
    }
    const indexed = new Map<string, ApiOperation>(otaOperations.map((entry) => [entry.operationId, entry]));
    for (const { operationId, spec } of workingOperations) {
      expect([operationId, indexed.get(operationId)?.milestone]).toEqual([operationId, spec["x-milestone"]]);
    }
  });

  it("keeps the milestones of scope §3 for the 96 original operations: 77 MVP and 19 deferred [OBE-009 AC2]", () => {
    expect(frozenOperations).toHaveLength(96);
    expect(Object.keys(SCOPE_MILESTONES)).toHaveLength(96);
    const frozenSdkMethods = frozenOperations.map(({ spec }) => String(spec["x-sdk-method"]));
    expect([...frozenSdkMethods].sort()).toEqual(Object.keys(SCOPE_MILESTONES).sort());

    const counts: Record<string, number> = {};
    for (const { operationId, spec } of frozenOperations) {
      const expected = SCOPE_MILESTONES[String(spec["x-sdk-method"])];
      const actual = operation(operationId).spec["x-milestone"];
      expect([operationId, actual]).toEqual([operationId, expected]);
      counts[String(actual)] = (counts[String(actual)] ?? 0) + 1;
    }
    expect(counts).toEqual({ M2: 16, M3: 34, M4: 27, deferred: 19 });
    expect(96 - (counts["deferred"] ?? 0)).toBe(77);
  });
});

describe("edge and cookie mode (api-changes §2)", () => {
  it("defines the edge credential and the two session cookies as security schemes", () => {
    const schemes = objectAt(working, "components", "securitySchemes");
    expect(schemes["storefrontEdge"]).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "X-Velexis-Edge",
      "x-internal": true,
    });
    expect(schemes["customerCookie"]).toMatchObject({ type: "apiKey", in: "cookie", name: "__Host-vx_at" });
    expect(schemes["bookingCookie"]).toMatchObject({ type: "apiKey", in: "cookie", name: "__Host-vx_bt" });
    expect(
      String(objectAt(working, "components", "parameters", "StorefrontHostHeader")["description"]),
    ).toContain("**Edge mode.**");
  });

  it("lets every customer-scope operation accept storefrontEdge, mirroring its key alternatives [OBE-009 AC2]", () => {
    // The 63 customer and both operations of the original design, by operationId.
    const original = frozenOperations.filter(isCustomerScope).map(({ operationId }) => operationId);
    expect(original).toHaveLength(63);
    for (const operationId of original) {
      expect([operationId, edgeAlternatives(operation(operationId)).length > 0]).toEqual([operationId, true]);
    }
    // Every customer-scope operation that takes a key: `storefrontEdge` alone where a key alone is enough, with
    // `customerCookie` where a customer token is accepted and with `bookingCookie` where a guest token is.
    for (const op of workingOperations.filter(
      (candidate) => isCustomerScope(candidate) && takesKey(candidate),
    )) {
      expect([op.operationId, edgeAlternatives(op)]).toEqual([op.operationId, mirroredEdgeAlternatives(op)]);
    }
    expect(edgeAlternatives(operation("getStorefront"))).toEqual(["storefrontEdge"]);
    expect(edgeAlternatives(operation("changePassword"))).toEqual(["customerCookie+storefrontEdge"]);
    expect(edgeAlternatives(operation("getBooking"))).toEqual([
      "bookingCookie+storefrontEdge",
      "customerCookie+storefrontEdge",
    ]);
    expect(edgeAlternatives(operation("getPayment"))).toEqual([
      "bookingCookie+storefrontEdge",
      "customerCookie+storefrontEdge",
      "storefrontEdge",
    ]);
  });

  it("lists 403 HOST_NOT_ALLOWED on every operation that accepts the edge credential (api-changes §2.4)", () => {
    // An edge request whose X-Velexis-Host is unknown or unverified answers 403 HOST_NOT_ALLOWED, whatever the
    // operation, so every operation with a storefrontEdge alternative can answer it.
    const edgeOperations = workingOperations.filter(acceptsEdge);
    expect(edgeOperations.length).toBeGreaterThanOrEqual(63);
    for (const op of edgeOperations) {
      expect([op.operationId, op.spec["x-error-codes"]]).toEqual([
        op.operationId,
        expect.arrayContaining(["HOST_NOT_ALLOWED"]),
      ]);
      expect([op.operationId, "403" in objectAt(op.spec, "responses")]).toEqual([op.operationId, true]);
    }
  });

  it("never combines the edge credential with a key, a bearer token or a console operation", () => {
    for (const op of workingOperations) {
      for (const requirement of securityOf(op)) {
        const schemes = Object.keys(requirement);
        if (
          schemes.some((scheme) => ["storefrontEdge", "customerCookie", "bookingCookie"].includes(scheme))
        ) {
          expect([op.operationId, schemes.includes("storefrontEdge"), isCustomerScope(op)]).toEqual([
            op.operationId,
            true,
            true,
          ]);
          expect([op.operationId, schemes.filter((scheme) => scheme in EDGE_COUNTERPART)]).toEqual([
            op.operationId,
            [],
          ]);
          expect([op.operationId, schemes.includes("staffAuth")]).toEqual([op.operationId, false]);
        }
      }
    }
  });

  it("puts the CSRF header and CSRF_TOKEN_INVALID on every state-changing customer-scope operation, and only there", () => {
    const csrf = objectAt(working, "components", "parameters", "CsrfToken");
    expect(csrf).toMatchObject({
      name: "X-CSRF-Token",
      in: "header",
      required: false,
      schema: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
    });
    let stateChanging = 0;
    for (const op of workingOperations) {
      // Customer-scope operations that take a key (and so have edge alternatives), and the edge-only operations
      // (x-edge-only, OBE-029), which take no key at all: every state-changing request of the edge needs the header.
      const expected =
        ((isCustomerScope(op) && takesKey(op)) || acceptsEdge(op)) && STATE_CHANGING.has(op.method);
      expect([op.operationId, parameterRefsOf(op).includes("CsrfToken")]).toEqual([op.operationId, expected]);
      if (expected) {
        stateChanging += 1;
        expect([op.operationId, op.spec["x-error-codes"]]).toEqual([
          op.operationId,
          expect.arrayContaining(["CSRF_TOKEN_INVALID"]),
        ]);
      }
    }
    expect(stateChanging).toBeGreaterThanOrEqual(32);
  });

  it("documents Set-Cookie on the success responses that open, rotate or clear cookies", () => {
    expect(objectAt(working, "components", "headers", "Set-Cookie")).toMatchObject({
      schema: { type: "string" },
    });
    for (const [operationId, statuses] of Object.entries(COOKIE_RESPONSES)) {
      for (const status of statuses) {
        expect([
          operationId,
          status,
          objectAt(operation(operationId).spec, "responses", status, "headers"),
        ]).toEqual([
          operationId,
          status,
          expect.objectContaining({ "Set-Cookie": { $ref: "#/components/headers/Set-Cookie" } }),
        ]);
      }
    }
  });

  it("answers AuthSessionResult in token mode and AuthSessionInfo in edge mode on signIn, refreshSession and changePassword", () => {
    const tokenBody = responseExample("signIn", "200");
    const edgeBody = responseExample("getSession", "200");
    for (const operationId of ["signIn", "refreshSession", "changePassword"]) {
      const schema = objectAt(
        operation(operationId).spec,
        "responses",
        "200",
        "content",
        "application/json",
        "schema",
      );
      expect([operationId, schema["oneOf"]]).toEqual([
        operationId,
        [
          { $ref: "#/components/schemas/AuthSessionResult" },
          { $ref: "#/components/schemas/AuthSessionInfo" },
        ],
      ]);
      // `oneOf` needs exactly one match: the token body is only an AuthSessionResult, the edge body only an
      // AuthSessionInfo (no `session.accessToken`), and a body of neither shape fails.
      expect([operationId, checker.check(operationId, { status: 200, body: tokenBody })]).toEqual([
        operationId,
        [],
      ]);
      expect([operationId, checker.check(operationId, { status: 200, body: edgeBody })]).toEqual([
        operationId,
        [],
      ]);
      expect(checker.check(operationId, { status: 200, body: { customer: {}, session: {} } })).not.toEqual(
        [],
      );
    }
  });

  it("makes AuthRefreshRequest.refreshToken optional and BookingLookupResult.bookingToken nullable", () => {
    const refresh = objectAt(working, "components", "schemas", "AuthRefreshRequest");
    expect(refresh["required"]).toBeUndefined();
    expect(refresh["additionalProperties"]).toBe(false);
    expect(Object.keys(objectAt(refresh, "properties"))).toEqual(["refreshToken"]);

    const lookup = objectAt(working, "components", "schemas", "BookingLookupResult");
    expect(lookup["required"]).toEqual(expect.arrayContaining(["bookingToken"]));
    expect(objectAt(lookup, "properties", "bookingToken")["type"]).toEqual(["string", "null"]);
    const body = responseExample("lookupBooking", "200");
    expect(checker.check("lookupBooking", { status: 200, body })).toEqual([]);
    expect(
      checker.check("lookupBooking", { status: 200, body: { ...(body as Json), bookingToken: null } }),
    ).toEqual([]);
  });
});

describe("the OTA admin's service credential (api-changes §5)", () => {
  it("defines X-Velexis-Environment as an optional test or live header", () => {
    expect(objectAt(working, "components", "parameters", "VelexisEnvironment")).toMatchObject({
      name: "X-Velexis-Environment",
      in: "header",
      required: false,
      schema: { type: "string", enum: ["test", "live"] },
    });
  });

  it("gives every console operation VelexisEnvironment and the end-user IP and user-agent headers [OBE-009 AC2]", () => {
    const original = frozenOperations.filter(({ spec }) => spec["x-scope"] === "console");
    expect(original).toHaveLength(33);
    for (const op of workingOperations) {
      const refs = parameterRefsOf(op);
      if (op.spec["x-scope"] === "console") {
        expect([op.operationId, refs]).toEqual([
          op.operationId,
          expect.arrayContaining(["VelexisEnvironment", "CustomerEndUserIp", "CustomerEndUserAgent"]),
        ]);
      } else {
        expect([op.operationId, refs.includes("VelexisEnvironment")]).toEqual([op.operationId, false]);
      }
    }
    for (const name of ["CustomerEndUserIp", "CustomerEndUserAgent"]) {
      expect(String(objectAt(working, "components", "parameters", name)["description"])).toContain(
        "service key",
      );
    }
  });

  it("answers 400 VALIDATION_FAILED on every console operation, as the service key's missing headers do", () => {
    // With the service key a missing X-Velexis-Environment or end-user IP answers 400 VALIDATION_FAILED (§5), so
    // every console operation, console.auth.me included, documents a 400 response and lists the code.
    for (const op of workingOperations.filter(({ spec }) => spec["x-scope"] === "console")) {
      expect([op.operationId, op.spec["x-error-codes"]]).toEqual([
        op.operationId,
        expect.arrayContaining(["VALIDATION_FAILED"]),
      ]);
      expect([op.operationId, "400" in objectAt(op.spec, "responses")]).toEqual([op.operationId, true]);
    }
  });

  it("adds environments to ConsoleStaffSession, and the console sign-in example still validates", () => {
    const session = objectAt(working, "components", "schemas", "ConsoleStaffSession");
    expect(session["required"]).toEqual(expect.arrayContaining(["environments"]));
    expect(objectAt(session, "properties", "environments")).toMatchObject({
      type: "array",
      items: { type: "string", enum: ["test", "live"] },
    });
    const body = responseExample("consoleSignIn", "200") as Json;
    expect(body["environments"]).toEqual(["test", "live"]);
    expect(checker.check("consoleSignIn", { status: 200, body })).toEqual([]);
    expect(checker.check("consoleRefreshSession", { status: 200, body })).toEqual([]);
    const { environments, ...withoutEnvironments } = body;
    expect(environments).toBeDefined();
    expect(checker.check("consoleSignIn", { status: 200, body: withoutEnvironments })).not.toEqual([]);
  });
});

describe("error catalogue (api-changes §6)", () => {
  it("puts CSRF_TOKEN_INVALID (403) and NOT_IMPLEMENTED (501) in ErrorCode [OBE-009 AC3]", () => {
    // Compiles only while both codes are members of the generated union.
    const codes: readonly ErrorCode[] = ["CSRF_TOKEN_INVALID", "NOT_IMPLEMENTED"];
    expect(OTA_ERROR_CODES).toEqual(expect.arrayContaining([...codes]));
    expect(codes.map((code) => [code, ERROR_CATALOGUE[code].status, ERROR_CATALOGUE[code].source])).toEqual([
      ["CSRF_TOKEN_INVALID", 403, "ota"],
      ["NOT_IMPLEMENTED", 501, "ota"],
    ]);
    const catalogue = objectAt(working, "x-error-catalogue");
    expect(catalogue["CSRF_TOKEN_INVALID"]).toMatchObject({ status: 403 });
    expect(catalogue["NOT_IMPLEMENTED"]).toMatchObject({ status: 501 });
    // The generated catalogue is the document's (CI also regenerates and diffs it).
    expect([...OTA_ERROR_CODES]).toEqual(Object.keys(catalogue));
  });
});

describe("vendor extensions (api-changes §1)", () => {
  it("documents x-edge-only, x-internal, x-sdk-exclude, x-milestone and x-permission in info.description", () => {
    const description = String(objectAt(working, "info")["description"]);
    for (const extension of [
      "x-edge-only: true",
      "x-internal: true",
      "x-sdk-exclude: true",
      "x-milestone",
      "x-permission",
    ]) {
      expect(description).toContain(`- \`${extension}\` (`);
    }
  });

  it("indexes milestone, edgeOnly and permission of every operation as the document says [OBE-009 AC1]", () => {
    expect(otaOperations.map((entry) => entry.operationId)).toEqual(
      workingOperations.map(({ operationId }) => operationId),
    );
    for (const { operationId, spec } of workingOperations) {
      expect(otaOperations.find((entry) => entry.operationId === operationId)).toMatchObject({
        milestone: spec["x-milestone"] ?? null,
        edgeOnly: spec["x-edge-only"] === true,
        permission: spec["x-permission"] ?? null,
      });
    }
  });
});

// ---- OBE-029: the airline card and the payment account modes (api-changes §3, §4, §6) ------------------------

const AIRLINE_CARD_COMPLETION = "completeCheckoutWithAirlineCard";

/** The error codes of api-changes §3.2's table, by status (`As checkout.complete` rows included). */
const AIRLINE_CARD_ERROR_CODES: Readonly<Record<string, readonly string[]>> = {
  "400": ["VALIDATION_FAILED"],
  "402": ["PAYMENT_DECLINED"],
  "403": ["FEATURE_DISABLED", "SCOPE_NOT_ALLOWED", "PAYMENT_ATTEMPTS_EXCEEDED", "CSRF_TOKEN_INVALID"],
  "409": ["PRICE_CHANGED", "PAYMENT_AMOUNT_MISMATCH", "SOLD_OUT", "CHECKOUT_ALREADY_COMPLETED"],
  "410": ["CHECKOUT_EXPIRED"],
  "422": ["CHECKOUT_INCOMPLETE", "TRAVELER_DATA_INVALID", "CONTACT_DATA_INVALID", "UNPROCESSABLE"],
  "429": ["RATE_LIMITED"],
  "502": ["SUPPLIER_ERROR"],
  "503": ["SUPPLIER_UNAVAILABLE"],
  "504": ["SUPPLIER_TIMEOUT"],
};

/** A Stripe-documented test card (AGENTS.md §8): Luhn-valid Visa 4242 4242 4242 4242. */
const TEST_CARD = {
  brand: "VISA",
  holderName: "Marco Rossi",
  number: "4242424242424242",
  expiryMonth: 12,
  expiryYear: 2030,
  securityCode: "123",
} as const;

/**
 * Checks request bodies against the document: a copy of it whose only operations are one probe per operation of
 * `operationIds`, with that operation's JSON request body schema as the probe's 200 response. The schemas are
 * compiled by the strict Ajv 2020 set-up of @velexis/testing, as the backend's request validation compiles them.
 */
function requestBodyChecker(operationIds: readonly string[]): ResponseChecker {
  const paths: Json = {};
  for (const operationId of operationIds) {
    const schema = objectAt(operation(operationId).spec, "requestBody", "content", "application/json")[
      "schema"
    ];
    paths[`/request-bodies/${operationId}`] = {
      post: {
        operationId,
        responses: {
          "200": { description: "The request body", content: { "application/json": { schema } } },
        },
      },
    };
  }
  return createResponseChecker({ ...working, paths }, { label: "OTA request bodies" });
}

/** The JSON request example of an operation, by its name in `requestBody.content.application/json.examples`. */
function requestExample(operationId: string, name: string): Json {
  const value = objectAt(
    operation(operationId).spec,
    "requestBody",
    "content",
    "application/json",
    "examples",
    name,
  )["value"];
  if (!isObject(value)) {
    throw new Error(`${operationId} has no request example ${name}`);
  }
  return value;
}

/** A named response example of an operation's JSON response (inline `examples.<name>.value`). */
function namedResponseExample(operationId: string, status: string, name: string): Json {
  const value = objectAt(
    operation(operationId).spec,
    "responses",
    status,
    "content",
    "application/json",
    "examples",
    name,
  )["value"];
  if (!isObject(value)) {
    throw new Error(`${operationId} ${status} has no example ${name}`);
  }
  return value;
}

const schemaOf = (name: string): Json => objectAt(working, "components", "schemas", name);

const enumOf = (schema: Json, ...keys: string[]): unknown => objectAt(schema, ...keys)["enum"];

describe("airline-card method and payment account modes (api-changes §3, §4, §6)", () => {
  let requests: ResponseChecker;

  beforeAll(() => {
    requests = requestBodyChecker([AIRLINE_CARD_COMPLETION, "createCheckoutPayment"]);
  });

  it("adds completeCheckoutWithAirlineCard exactly as api-changes §3.2, and the index lists it edge-only [OBE-029 AC1]", () => {
    const op = operation(AIRLINE_CARD_COMPLETION);
    expect([op.method, op.path]).toEqual(["post", "/v1/checkouts/{checkoutId}/airline-card-completion"]);
    expect(op.spec).toMatchObject({
      "x-sdk-method": "checkout.completeWithAirlineCard",
      "x-scope": "customer",
      "x-edge-only": true,
      "x-milestone": "M3",
      tags: ["Checkout"],
    });
    expect(securityOf(op)).toEqual([{ storefrontEdge: [] }, { storefrontEdge: [], customerCookie: [] }]);
    expect(op.spec["x-amadeus"]).toEqual([
      {
        api: "FlightOffersPrice",
        operationId: "quoteAirOffers",
        method: "POST",
        path: "/v1/shopping/flight-offers/pricing",
      },
      {
        api: "FlightCreateOrders",
        operationId: "createFligtOrders",
        method: "POST",
        path: "/v1/booking/flight-orders",
      },
    ]);
    expect(op.spec["x-tenant-tables"]).toEqual([
      "checkouts",
      "checkout_travelers",
      "checkout_contacts",
      "checkout_ancillaries",
      "checkout_remarks",
      "priced_offers",
      "payments",
      "payment_events",
      "bookings",
      "booking_associated_records",
      "booking_travelers",
      "booking_contacts",
      "booking_segments",
      "booking_ancillaries",
      "booking_remarks",
      "booking_tickets",
      "booking_events",
      "booking_access_tokens",
      "storefront_settings",
      "notifications",
      "supplier_requests",
      "idempotency_keys",
    ]);
    // Idempotency-Key is required (the component parameter is), CSRF header on this state-changing edge request.
    expect(parameterRefsOf(op)).toEqual(expect.arrayContaining(["IdempotencyKey", "CsrfToken"]));
    expect(objectAt(working, "components", "parameters", "IdempotencyKey")["required"]).toBe(true);
    expect(objectAt(op.spec, "requestBody")["required"]).toBe(true);
    expect(objectAt(op.spec, "requestBody", "content", "application/json", "schema")).toEqual({
      $ref: "#/components/schemas/AirlineCardCompletionRequest",
    });
    const created = objectAt(op.spec, "responses", "201");
    expect(objectAt(created, "content", "application/json", "schema")).toEqual({
      $ref: "#/components/schemas/CheckoutCompletion",
    });
    expect(objectAt(created, "headers")).toMatchObject({
      "Set-Cookie": { $ref: "#/components/headers/Set-Cookie" },
    });

    // The operations index: the 96 operations of the original design plus this one (97 when OBE-029 lands; later
    // spec tasks add more, so the total itself is not asserted), and this one is edge-only.
    const original = new Set(frozenOperations.map(({ operationId }) => operationId));
    expect(
      otaOperations.filter(
        ({ operationId }) => original.has(operationId) || operationId === AIRLINE_CARD_COMPLETION,
      ),
    ).toHaveLength(97);
    expect(otaOperations.find(({ operationId }) => operationId === AIRLINE_CARD_COMPLETION)).toEqual({
      operationId: AIRLINE_CARD_COMPLETION,
      method: "post",
      path: "/v1/checkouts/{checkoutId}/airline-card-completion",
      sdkMethod: "checkout.completeWithAirlineCard",
      scope: "customer",
      tags: ["Checkout"],
      internal: false,
      milestone: "M3",
      edgeOnly: true,
      permission: null,
    });
  });

  it("lets only the storefront edge call an x-edge-only operation: never a key-only (sk_) or bearer alternative [OBE-029 AC1]", () => {
    const edgeOnly = workingOperations.filter(({ spec }) => spec["x-edge-only"] === true);
    expect(edgeOnly.map(({ operationId }) => operationId)).toEqual(
      expect.arrayContaining([AIRLINE_CARD_COMPLETION]),
    );
    for (const op of edgeOnly) {
      expect([op.operationId, op.spec["x-scope"]]).toEqual([op.operationId, "customer"]);
      expect([op.operationId, securityOf(op).length > 0]).toEqual([op.operationId, true]);
      for (const requirement of securityOf(op)) {
        const schemes = Object.keys(requirement).sort();
        // Every alternative is the edge credential, alone or with a session cookie; none takes X-Api-Key (so no
        // `{apiKey: []}` entry a secret key could satisfy alone), a bearer token or a staff token.
        expect([op.operationId, schemes.includes("storefrontEdge")]).toEqual([op.operationId, true]);
        expect([
          op.operationId,
          schemes.filter((scheme) =>
            ["apiKey", "customerAuth", "bookingToken", "staffAuth"].includes(scheme),
          ),
        ]).toEqual([op.operationId, []]);
      }
      // Keys and the service key that reach it anyway get 403 SCOPE_NOT_ALLOWED (api-changes §1).
      expect([op.operationId, op.spec["x-error-codes"]]).toEqual([
        op.operationId,
        expect.arrayContaining(["SCOPE_NOT_ALLOWED"]),
      ]);
    }
    expect(otaOperations.filter(({ edgeOnly: flag }) => flag).map(({ operationId }) => operationId)).toEqual(
      edgeOnly.map(({ operationId }) => operationId),
    );
  });

  it("lists the error codes of api-changes §3.2, each answered with a documented status [OBE-029 AC1]", () => {
    const op = operation(AIRLINE_CARD_COMPLETION);
    const codes = op.spec["x-error-codes"] as string[];
    expect(codes).toEqual(expect.arrayContaining(Object.values(AIRLINE_CARD_ERROR_CODES).flat()));
    expect(new Set(codes).size).toBe(codes.length);
    const responses = objectAt(op.spec, "responses");
    for (const code of codes) {
      const entry = ERROR_CATALOGUE[code as ErrorCode] as (typeof ERROR_CATALOGUE)[ErrorCode] | undefined;
      expect([code, entry?.source]).toEqual([code, "ota"]);
      expect([code, String(entry?.status) in responses]).toEqual([code, true]);
    }
    for (const [status, statusCodes] of Object.entries(AIRLINE_CARD_ERROR_CODES)) {
      for (const code of statusCodes) {
        expect([code, ERROR_CATALOGUE[code as ErrorCode].status]).toEqual([code, Number(status)]);
      }
    }
    // The 403 and 504 responses of this route, and their examples, which validate as error envelopes.
    expect(responses["403"]).toEqual({ $ref: "#/components/responses/AirlineCardForbidden" });
    expect(responses["504"]).toEqual({ $ref: "#/components/responses/AirlineCardSupplierTimeout" });
    const forbidden = objectAt(working, "components", "responses", "AirlineCardForbidden");
    const examples = objectAt(forbidden, "content", "application/json", "examples");
    expect(Object.keys(examples)).toEqual(
      expect.arrayContaining(["SCOPE_NOT_ALLOWED", "FEATURE_DISABLED", "PAYMENT_ATTEMPTS_EXCEEDED"]),
    );
    for (const [name, example] of Object.entries(examples)) {
      const body = objectAt(example, "value");
      expect([name, objectAt(body, "error")["code"]]).toEqual([name, name]);
      expect([name, checker.check(AIRLINE_CARD_COMPLETION, { status: 403, body })]).toEqual([name, []]);
    }
    expect(objectAt(examples, "FEATURE_DISABLED", "value", "error", "details")).toEqual({
      feature: "airlineCard",
    });
    // 504: the order may exist. A guest's booking token goes into the `__Host-vx_bt` cookie, which the storefront
    // needs to poll bookings.getTicketingStatus, and never into the body (no token readable by browser JavaScript).
    const timeout = objectAt(working, "components", "responses", "AirlineCardSupplierTimeout");
    expect(objectAt(timeout, "headers")).toMatchObject({
      "Set-Cookie": { $ref: "#/components/headers/Set-Cookie" },
    });
    const timeoutBody = objectAt(
      timeout,
      "content",
      "application/json",
      "examples",
      "SUPPLIER_TIMEOUT",
      "value",
    );
    expect(checker.check(AIRLINE_CARD_COMPLETION, { status: 504, body: timeoutBody })).toEqual([]);
    expect(objectAt(timeoutBody, "error", "details")).toEqual({
      bookingId: expect.stringMatching(/^bkg_/),
      replayed: false,
    });
  });

  it("defines AirlineCardCompletionRequest with x-sensitive on card, and validates bodies by it [OBE-029 AC2]", () => {
    const schema = schemaOf("AirlineCardCompletionRequest");
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["paymentId", "expectedTotal", "card"],
    });
    expect(objectAt(schema, "properties", "paymentId")).toMatchObject({
      type: "string",
      pattern: "^pay_[0-9A-Za-z]{16,40}$",
    });
    expect(objectAt(schema, "properties", "expectedTotal")).toMatchObject({
      $ref: "#/components/schemas/Money",
    });
    const card = objectAt(schema, "properties", "card");
    expect(card).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["brand", "holderName", "number", "expiryMonth", "expiryYear", "securityCode"],
      "x-sensitive": true,
    });
    expect(objectAt(card, "properties")).toMatchObject({
      brand: { $ref: "#/components/schemas/AmadeusPaymentBrand" },
      holderName: { type: "string", minLength: 2, maxLength: 64, pattern: "^[A-Za-z .'-]+$" },
      number: { type: "string", pattern: "^[0-9]{12,19}$" },
      expiryMonth: { type: "integer", minimum: 1, maximum: 12 },
      expiryYear: { type: "integer", minimum: 2026, maximum: 2099 },
      securityCode: { type: "string", pattern: "^[0-9]{3,4}$" },
    });
    // `x-sensitive` marks only the card (documented in info.description).
    const sensitive = Object.keys(objectAt(working, "components", "schemas")).filter((name) =>
      JSON.stringify(schemaOf(name)).includes('"x-sensitive"'),
    );
    expect(sensitive).toEqual(["AirlineCardCompletionRequest"]);
    expect(String(objectAt(working, "info")["description"])).toContain("- `x-sensitive: true` (");

    // The generated types carry the body (this assignment compiles only while they do).
    const typed: components["schemas"]["AirlineCardCompletionRequest"] = {
      paymentId: "pay_01JA4CF6M3Q6T9W2Z5C8F1H4K7",
      expectedTotal: { amount: "1361.06", currency: "EUR" },
      card: { ...TEST_CARD },
    };
    const viaOperation: operations[typeof AIRLINE_CARD_COMPLETION]["requestBody"]["content"]["application/json"] =
      typed;
    expect(requestExample(AIRLINE_CARD_COMPLETION, "visa")).toEqual(viaOperation);

    const check = (body: unknown) => requests.check(AIRLINE_CARD_COMPLETION, { status: 200, body });
    const paths = (body: unknown) => check(body).map(({ path, keyword }) => `${path} ${keyword}`);
    expect(check(typed)).toEqual([]);
    expect(paths({ ...typed, card: { ...TEST_CARD, number: "4242 4242 4242 4242" } })).toEqual([
      "/card/number pattern",
    ]);
    expect(paths({ ...typed, card: { ...TEST_CARD, expiryMonth: 13 } })).toEqual([
      "/card/expiryMonth maximum",
    ]);
    expect(paths({ ...typed, card: { ...TEST_CARD, securityCode: "12345" } })).toEqual([
      "/card/securityCode pattern",
    ]);
    expect(paths({ ...typed, card: { ...TEST_CARD, brand: "DISCOVER" } })).toEqual(["/card/brand enum"]);
    expect(paths({ ...typed, card: { ...TEST_CARD, expiry: "12/30" } })).toEqual([
      "/card/expiry additionalProperties",
    ]);
    const { securityCode, ...withoutCode } = TEST_CARD;
    expect(securityCode).toBe("123");
    expect(paths({ ...typed, card: withoutCode })).toEqual(["/card/securityCode required"]);
    expect(paths({ ...typed, savePaymentMethod: true })).toEqual(["/savePaymentMethod additionalProperties"]);
    // Problems name the field and the keyword, never the rejected value.
    const problems = JSON.stringify(check({ ...typed, card: { ...TEST_CARD, number: "4242x4242x4242" } }));
    expect(problems).not.toContain("4242x4242x4242");
  });

  it("adds airline_card to the payment enums and keeps the provider fields null on airline payments (api-changes §3.1)", () => {
    expect(enumOf(schemaOf("PaymentCreateRequest"), "properties", "method")).toEqual([
      "card",
      "apple_pay",
      "google_pay",
      "paypal",
      "airline_card",
    ]);
    expect(enumOf(schemaOf("Payment"), "properties", "method")).toEqual(
      expect.arrayContaining(["card", "bank_transfer", "agency_credit", "cash", "airline_card"]),
    );
    expect(enumOf(schemaOf("Payment"), "properties", "provider")).toEqual(
      expect.arrayContaining(["stripe", "manual", "airline"]),
    );
    expect(enumOf(schemaOf("PaymentNextAction"), "properties", "type")).toEqual([
      "confirm_with_provider_sdk",
      "redirect",
      "wait",
      "none",
      "airline_card_form",
    ]);
    for (const field of ["clientSecret", "providerPublicKey", "providerPaymentId"]) {
      expect([field, String(objectAt(schemaOf("Payment"), "properties", field)["description"])]).toEqual([
        field,
        expect.stringContaining("Always null for airline payments."),
      ]);
    }
    const method: components["schemas"]["Payment"]["method"] = "airline_card";
    const provider: components["schemas"]["Payment"]["provider"] = "airline";
    const nextAction: components["schemas"]["PaymentNextAction"]["type"] = "airline_card_form";
    expect([method, provider, nextAction]).toEqual(["airline_card", "airline", "airline_card_form"]);

    // createPayment {method: airline_card}: refused to key callers, and `provider` must be absent.
    expect(operation("createCheckoutPayment").spec["x-error-codes"]).toEqual(
      expect.arrayContaining(["FEATURE_DISABLED", "SCOPE_NOT_ALLOWED"]),
    );
    const airline = requestExample("createCheckoutPayment", "airlineCard");
    expect(airline).toEqual({ method: "airline_card", termsAccepted: true });
    const create = (body: unknown) =>
      requests
        .check("createCheckoutPayment", { status: 200, body })
        .map(({ path, keyword }) => `${path} ${keyword}`);
    expect(create(airline)).toEqual([]);
    expect(create({ ...airline, provider: "stripe" })).toEqual(["/provider false schema", " if"]);
    expect(create(requestExample("createCheckoutPayment", "paypal"))).toEqual([]);
    expect(create({ method: "card", provider: "stripe", termsAccepted: true })).toEqual([]);

    // The airline payment as createPayment returns it, and as the completed booking holds it.
    const created = namedResponseExample("createCheckoutPayment", "201", "airlineCard");
    expect(created).toMatchObject({
      provider: "airline",
      method: "airline_card",
      status: "requires_payment_method",
      captureMethod: "automatic",
      clientSecret: null,
      providerPublicKey: null,
      providerPaymentId: null,
      nextAction: { type: "airline_card_form" },
    });
    expect(checker.check("createCheckoutPayment", { status: 201, body: created })).toEqual([]);
    const completion = namedResponseExample(AIRLINE_CARD_COMPLETION, "201", "guestTicketed");
    expect(checker.check(AIRLINE_CARD_COMPLETION, { status: 201, body: completion })).toEqual([]);
    expect(completion).toMatchObject({ bookingToken: null, bookingTokenExpiresAt: null });
    const booking = objectAt(completion, "booking");
    expect(booking["status"]).toBe("ticketed");
    const [payment] = booking["payments"] as Json[];
    expect(payment).toMatchObject({
      id: created["id"],
      provider: "airline",
      method: "airline_card",
      status: "captured",
      clientSecret: null,
      providerPublicKey: null,
      providerPaymentId: null,
      card: { brand: "VISA", last4: "4242", expMonth: null, expYear: null },
    });
    // The amount the airline charges is the payment's amount: what the completion request confirmed.
    expect(objectAt(payment, "amount")).toEqual(
      requestExample(AIRLINE_CARD_COMPLETION, "visa")["expectedTotal"],
    );
    // No card field of the request (number, security code, holder, expiry) is echoed anywhere in the answer.
    const answer = JSON.stringify(completion);
    for (const value of [
      TEST_CARD.number,
      TEST_CARD.holderName,
      "securityCode",
      "holderName",
      "expiryYear",
    ]) {
      expect([value, answer.includes(value)]).toEqual([value, false]);
    }
  });

  it("adds the payment account modes and the airline card to StorefrontPaymentConfig (api-changes §4) [OBE-029 AC2]", () => {
    const config = schemaOf("StorefrontPaymentConfig");
    expect(config["required"]).toEqual(
      expect.arrayContaining(["accountMode", "merchantName", "statementDescriptor", "airlineCard"]),
    );
    expect(objectAt(config, "properties", "accountMode")).toMatchObject({
      type: "string",
      enum: ["velexis", "connect_standard", "api_keys"],
    });
    expect(objectAt(config, "properties", "merchantName")).toMatchObject({ type: "string" });
    expect(objectAt(config, "properties", "statementDescriptor")).toMatchObject({ type: ["string", "null"] });
    expect(objectAt(config, "properties", "airlineCard")["anyOf"]).toEqual([
      { $ref: "#/components/schemas/StorefrontAirlineCard" },
      { type: "null" },
    ]);
    expect(enumOf(config, "properties", "supportedMethods", "items")).toEqual([
      "card",
      "apple_pay",
      "google_pay",
      "paypal",
      "airline_card",
    ]);
    expect(String(objectAt(config, "properties", "publishableKey")["description"])).toContain("api_keys");
    expect(String(objectAt(config, "properties", "accountId")["description"])).toContain("connect_standard");
    expect(schemaOf("StorefrontAirlineCard")).toMatchObject({
      required: ["enabled", "cardBrands", "chargedBy", "notice"],
      properties: {
        enabled: { type: "boolean" },
        cardBrands: { type: "array", items: { $ref: "#/components/schemas/StorefrontCardBrand" } },
        chargedBy: { type: "string", enum: ["airline"] },
        notice: { type: "string" },
      },
    });

    // The generated types carry the new fields (this compiles only while they do).
    const mode: components["schemas"]["StorefrontPaymentConfig"]["accountMode"] = "velexis";
    const airlineCard: components["schemas"]["StorefrontPaymentConfig"]["airlineCard"] = {
      enabled: true,
      cardBrands: [{ amadeus: "VISA", psp: "visa", label: "Visa" }],
      chargedBy: "airline",
      notice: "The airline charges your card. The price is the airline's price.",
    };

    // The document's example (a key caller, connect_standard) and an edge answer in velexis mode both validate.
    const keyCaller = responseExample("getStorefront", "200") as Json;
    expect(objectAt(keyCaller, "payment")).toMatchObject({
      accountMode: "connect_standard",
      accountId: expect.stringMatching(/^acct_/),
      statementDescriptor: null,
      airlineCard: null,
    });
    expect(checker.check("getStorefront", { status: 200, body: keyCaller })).toEqual([]);
    const edgePayment = {
      ...objectAt(keyCaller, "payment"),
      accountMode: mode,
      accountId: null,
      merchantName: "Velexis on behalf of Acme Travel",
      statementDescriptor: "ACME TRAVEL",
      supportedMethods: ["card", "airline_card"],
      airlineCard,
    };
    const storefront = (payment: Json) =>
      checker
        .check("getStorefront", { status: 200, body: { ...keyCaller, payment } })
        .map(({ path, keyword }) => `${path} ${keyword}`);
    expect(storefront(edgePayment)).toEqual([]);
    expect(storefront({ ...edgePayment, accountMode: "stripe_direct" })).toEqual([
      "/payment/accountMode enum",
    ]);
    expect(storefront({ ...edgePayment, airlineCard: { ...airlineCard, chargedBy: "ota" } })).toEqual(
      expect.arrayContaining(["/payment/airlineCard/chargedBy enum"]),
    );
    const { merchantName, ...withoutMerchant } = edgePayment;
    expect(merchantName).toBe("Velexis on behalf of Acme Travel");
    expect(storefront(withoutMerchant)).toEqual(["/payment/merchantName required"]);
  });

  it("puts PAYMENT_ATTEMPTS_EXCEEDED (403) in the catalogue and in ErrorCode [OBE-029 AC1]", () => {
    // Compiles only while the code is a member of the generated union.
    const code: ErrorCode = "PAYMENT_ATTEMPTS_EXCEEDED";
    expect(ERROR_CATALOGUE[code]).toMatchObject({ status: 403, source: "ota" });
    expect(OTA_ERROR_CODES).toContain(code);
    expect(objectAt(working, "x-error-catalogue", code)).toEqual({
      status: 403,
      description:
        "Too many airline-card attempts on this checkout; start a new checkout or use another method.",
    });
    expect(ERROR_CATALOGUE[code].description).toBe(
      "Too many airline-card attempts on this checkout; start a new checkout or use another method.",
    );
  });
});

// ---- OBE-039: the webhook receiver of the Velexis Stripe account (api-changes part 2 §5, OADR-0010 point 4) ------

const VELEXIS_WEBHOOK = "receiveStripeVelexisWebhook";

describe("receiveStripeVelexisWebhook (api-changes-console-and-internal §5)", () => {
  it("documents POST /webhooks/stripe/velexis/{environment}: tag Internal, x-internal, x-milestone M3, no x-sdk-method, no credential [OBE-039]", () => {
    const op = operation(VELEXIS_WEBHOOK);
    expect([op.method, op.path]).toEqual(["post", "/webhooks/stripe/velexis/{environment}"]);
    expect(op.spec["tags"]).toEqual(["Internal"]);
    expect(op.spec["x-internal"]).toBe(true);
    expect(op.spec["x-milestone"]).toBe("M3");
    expect(op.spec).not.toHaveProperty("x-sdk-method");
    expect(op.spec).not.toHaveProperty("x-sdk-exclude");
    expect(op.spec).not.toHaveProperty("x-edge-only");
    expect(op.spec).not.toHaveProperty("x-permission");
    // Stripe sends no credential: no API key, edge credential, token or cookie alternative (the caller guard's
    // @WebhookRoute lets it through anonymous, and the receiver checks the signature itself).
    expect(op.spec["security"]).toEqual([]);
    expect(op.spec["x-scope"]).toBe("internal");
    expect(op.spec["x-tenant-tables"]).toEqual(["payments", "payment_events"]);
    expect(op.spec["x-platform-tables"]).toEqual(["tenants"]);
    // The operations index carries it for route parity, without an SDK method.
    const indexed = otaOperations.find((entry) => entry.operationId === VELEXIS_WEBHOOK);
    expect(indexed).toEqual({
      operationId: VELEXIS_WEBHOOK,
      method: "post",
      path: "/webhooks/stripe/velexis/{environment}",
      sdkMethod: null,
      scope: "internal",
      tags: ["Internal"],
      internal: true,
      milestone: "M3",
      edgeOnly: false,
      permission: null,
    } satisfies ApiOperation<string>);
  });

  it("takes the environment as test or live, requires Stripe-Signature and documents the Stripe event body [OBE-039]", () => {
    const op = operation(VELEXIS_WEBHOOK);
    const parameters = (op.spec["parameters"] as Json[]).map((parameter) => ({
      name: parameter["name"],
      in: parameter["in"],
      required: parameter["required"],
      schema: parameter["schema"],
    }));
    expect(parameters).toEqual([
      { name: "environment", in: "path", required: true, schema: { type: "string", enum: ["test", "live"] } },
      {
        name: "Stripe-Signature",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 2048 },
      },
    ]);
    // Compiles only while the generated types say so.
    type Parameters = operations["receiveStripeVelexisWebhook"]["parameters"];
    const environments: Parameters["path"]["environment"][] = ["test", "live"];
    const header: Parameters["header"] = { "Stripe-Signature": "t=1,v1=00" };
    expect([environments, Object.keys(header)]).toEqual([["test", "live"], ["Stripe-Signature"]]);
    const body = objectAt(op.spec, "requestBody");
    expect(body["required"]).toBe(true);
    expect(objectAt(body, "content", "application/json", "schema")).toEqual({
      $ref: "#/components/schemas/StripeWebhookEvent",
    });
    const event = objectAt(working, "components", "schemas", "StripeWebhookEvent");
    expect(event["required"]).toEqual(["id", "object", "type", "livemode", "data"]);
    const stripeEvent: components["schemas"]["StripeWebhookEvent"] = {
      id: "evt_example",
      object: "event",
      type: "charge.refunded",
      livemode: false,
      data: { object: { id: "ch_example" } },
    };
    expect(stripeEvent.object).toBe("event");
  });

  it("answers 200 with an acknowledgement, 400, 500 and 503, and lists exactly those error codes [OBE-039]", () => {
    const op = operation(VELEXIS_WEBHOOK);
    expect(Object.keys(objectAt(op.spec, "responses")).sort()).toEqual(["200", "400", "500", "503"]);
    expect(op.spec["x-error-codes"]).toEqual([
      "VALIDATION_FAILED",
      "INVALID_REQUEST",
      "INTERNAL_ERROR",
      "SERVICE_UNAVAILABLE",
    ]);
    for (const code of op.spec["x-error-codes"] as ErrorCode[]) {
      const status = String(ERROR_CATALOGUE[code].status);
      expect([code, status in objectAt(op.spec, "responses")]).toEqual([code, true]);
    }
    expect(responseExample(VELEXIS_WEBHOOK, "200")).toEqual({ received: true });
    expect(checker.check(VELEXIS_WEBHOOK, { status: 200, body: { received: true } })).toEqual([]);
    expect(checker.check(VELEXIS_WEBHOOK, { status: 200, body: { received: false } })).not.toEqual([]);
    const signatureRefused = {
      error: {
        code: "INVALID_REQUEST",
        message: "The Stripe signature of the request is not valid.",
        status: 400,
        requestId: "req_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
        details: { reason: "signature_invalid" },
      },
    };
    expect(checker.check(VELEXIS_WEBHOOK, { status: 400, body: signatureRefused })).toEqual([]);
  });

  it("adds the Internal tag with a description and a tag group of its own [OBE-039]", () => {
    const tags = working["tags"] as Json[];
    const internal = tags.find((tag) => tag["name"] === "Internal");
    expect(typeof internal?.["description"]).toBe("string");
    const groups = working["x-tagGroups"] as Json[];
    expect(groups.find((group) => group["name"] === "Internal")?.["tags"]).toEqual(["Internal"]);
  });
});

// ---- FIX-W23-STAFF: the console auth operations as the ADRs and the code have them (ADR-0003, ADR-0008, OADR-0011,
// PADR-0007, PADR-0008) ---------------------------------------------------------------------------------------------

const CONSOLE_AUTH = ["consoleSignIn", "consoleRefreshSession", "consoleSignOut", "consoleGetMe"] as const;

/** The description of an operation, folded onto one line. */
const descriptionOf = (operationId: string): string =>
  String(operation(operationId).spec["description"]).replace(/\s+/g, " ");

/** What the original descriptions said the OTA backend writes to the platform tables (ADR-0003 forbids it). */
const PLATFORM_WRITES = [
  "Inserts `platform.account_sessions`",
  "`platform.account_sessions.revoked_at`",
  "`platform.account_sessions.rotated_at`",
  "updates `accounts.last_login_at`",
  "sets `tenant_memberships.last_active_at`",
  "Updates `tenant_memberships.last_active_at`",
];

describe("console auth (FIX-W23-STAFF)", () => {
  it("describes no platform write, the staff token's claims without an environment, and staff.sign_in [FIX-W23-STAFF AC1]", () => {
    for (const operationId of CONSOLE_AUTH) {
      const text = descriptionOf(operationId);
      expect([operationId, PLATFORM_WRITES.filter((phrase) => text.includes(phrase))]).toEqual([
        operationId,
        [],
      ]);
      expect([operationId, text.toLowerCase().includes("no platform table is written")]).toEqual([
        operationId,
        true,
      ]);
    }
    const signIn = descriptionOf("consoleSignIn");
    for (const claim of ["`typ` (`staff`)", "`sub` (`stf_…`", "`tid`", "`roles`", "`sid`"]) {
      expect([claim, signIn.includes(claim)]).toEqual([claim, true]);
    }
    // The environment is chosen per request (OADR-0011 point 5); the original `acc`, `ten` and `env` claims are gone.
    expect(signIn).toContain("It carries no environment");
    expect(signIn).not.toMatch(/`(acc|ten|env)`/);
    expect(signIn).toContain("`action = staff.sign_in`");
    expect(signIn).not.toContain("auth.sign_in");
  });

  it("names the revocation keys of OADR-0011 and the sign-out order of the code [FIX-W23-STAFF AC1]", () => {
    const keys = [
      "staffdeny:<familyId>",
      "staffdeny:acct:<accountId>",
      "staffdeny:tenant:<tenantId>",
      "staffdeny:member:<staffId>",
    ];
    for (const operationId of ["consoleRefreshSession", "consoleGetMe"]) {
      const text = descriptionOf(operationId);
      expect([operationId, keys.filter((key) => !text.includes(key))]).toEqual([operationId, []]);
    }
    const signOut = descriptionOf("consoleSignOut");
    const accessToken = signOut.indexOf("the session of the staff access token");
    const refreshToken = signOut.indexOf("the session that issued the body's `refreshToken`");
    const ended = signOut.indexOf("the session of a valid access token whose session has already ended");
    expect(accessToken).toBeGreaterThan(-1);
    expect(refreshToken).toBeGreaterThan(accessToken);
    expect(ended).toBeGreaterThan(refreshToken);
    expect(signOut).toContain("`staffdeny:member:<staffId>`");
  });

  it("describes the tenant writes and the role change as the code has them [FIX-W23-STAFF AC1]", () => {
    // The required Idempotency-Key stores the rotated pair in the tenant's idempotency_keys (idempotency.service.ts).
    const refresh = descriptionOf("consoleRefreshSession");
    expect(refresh).toContain("`idempotency_keys`, the only tenant table written");
    expect(refresh).not.toContain("no tenant table");
    // Only the sign-in writes a staff_actions row; the sign-out writes none (staff-auth.service.ts).
    expect(descriptionOf("consoleSignOut")).not.toContain("staff_actions");
    // The staff guard ends a session whose role changed (staff-sessions.ts `role_changed`): no new environments then.
    const environments = String(
      objectAt(working, "components", "schemas", "ConsoleStaffProfile", "properties", "environments")[
        "description"
      ],
    ).replace(/\s+/g, " ");
    expect(environments).not.toContain("a role change or the OTA going live shows");
    expect(environments).toContain("a role change ends the session instead (`401 UNAUTHENTICATED`");
  });

  it("lists TOKEN_EXPIRED on consoleSignOut, which answers it to an expired access token alone [FIX-W23-STAFF AC1]", () => {
    const signOut = operation("consoleSignOut");
    expect(signOut.spec["x-error-codes"]).toContain("TOKEN_EXPIRED");
    expect(ERROR_CATALOGUE.TOKEN_EXPIRED.status).toBe(401);
    expect(objectAt(signOut.spec, "responses")["401"]).toBeDefined();
    expect(descriptionOf("consoleSignOut")).toContain("`401 TOKEN_EXPIRED`");
  });

  it("adds MFA_REQUIRED (403) to the catalogue and to consoleSignIn, with an example that validates [FIX-W23-STAFF AC2]", () => {
    // Compiles only while the code is a member of the generated union.
    const code: ErrorCode = "MFA_REQUIRED";
    // The platform document has the code with the same status (PADR-0008); a code of both keeps the OTA entry.
    expect(ERROR_CATALOGUE[code]).toMatchObject({ status: 403, source: "ota" });
    expect(OTA_ERROR_CODES).toContain(code);
    expect(objectAt(working, "x-error-catalogue", code)["status"]).toBe(403);
    expect(operation("consoleSignIn").spec["x-error-codes"]).toContain(code);
    expect(descriptionOf("consoleSignIn")).toContain("`403 MFA_REQUIRED`");
    const forbidden = objectAt(working, "components", "responses", "ConsoleForbidden");
    expect(String(forbidden["description"])).toContain("MFA_REQUIRED");
    const example = objectAt(forbidden, "content", "application/json", "examples", code)["value"];
    expect(objectAt(example, "error")).toMatchObject({ code, status: 403 });
    expect(checker.check("consoleSignIn", { status: 403, body: example })).toEqual([]);
  });
});

/** The needs-attention filters OBE-061 adds to consoleListBookings (api-changes-console-and-internal.md §7). */
const NEEDS_ATTENTION_FILTERS = ["reconcileOutcome", "cancellationRequested", "hasScheduleChange"];

type ConsoleListBookingsQuery = NonNullable<operations["consoleListBookings"]["parameters"]["query"]>;

describe("console.bookings.list: the needs-attention filters (api-changes-console-and-internal §7)", () => {
  it("adds reconcileOutcome, cancellationRequested and hasScheduleChange as optional query parameters, keeping every original one [OBE-061]", () => {
    const list = operation("consoleListBookings");
    const parameters = (list.spec["parameters"] as Json[] | undefined) ?? [];
    const byName = new Map(parameters.map((parameter) => [parameter["name"], parameter]));
    expect(byName.get("reconcileOutcome")).toMatchObject({
      in: "query",
      required: false,
      style: "form",
      explode: false,
      schema: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: ["found", "not_found", "manual_review"] },
      },
    });
    for (const name of ["cancellationRequested", "hasScheduleChange"]) {
      expect([name, byName.get(name)]).toMatchObject([
        name,
        { in: "query", required: false, schema: { type: "boolean" } },
      ]);
    }
    // Additive: the frozen design has none of them, and each of its parameters is still there as it was.
    const original = frozenOperations.find(({ operationId }) => operationId === "consoleListBookings");
    const originalParameters = (original?.spec["parameters"] as Json[] | undefined) ?? [];
    expect(originalParameters.length).toBeGreaterThan(0);
    expect(
      originalParameters.filter((parameter) => NEEDS_ATTENTION_FILTERS.includes(String(parameter["name"]))),
    ).toEqual([]);
    for (const parameter of originalParameters) {
      expect(parameters).toContainEqual(parameter);
    }
    // The cancellation and schedule-change filters read booking_events; the description names the five views.
    expect(list.spec["x-tenant-tables"]).toContain("booking_events");
    const description = descriptionOf("consoleListBookings");
    expect(description).toContain("**Needs attention**");
    for (const name of NEEDS_ATTENTION_FILTERS) {
      expect([name, description.includes(`\`${name}=`)]).toEqual([name, true]);
    }
    // Compiles only while the generated query type has the three filters with these types.
    const query: Pick<
      ConsoleListBookingsQuery,
      "reconcileOutcome" | "cancellationRequested" | "hasScheduleChange"
    > = { reconcileOutcome: ["manual_review"], cancellationRequested: true, hasScheduleChange: false };
    expect(Object.keys(query)).toEqual(NEEDS_ATTENTION_FILTERS);
  });
});

describe("the frozen original", () => {
  it("is unchanged under docs/velexis-sdk: same bytes, no MVP extension [OBE-009 AC2]", () => {
    const sha256 = createHash("sha256").update(readFileSync(FROZEN_DOCUMENT)).digest("hex");
    expect(sha256).toBe(FROZEN_DOCUMENT_SHA256);
    expect(frozenOperations.filter(({ spec }) => "x-milestone" in spec)).toEqual([]);
    expect(objectAt(frozen, "components", "securitySchemes")["storefrontEdge"]).toBeUndefined();
  });
});
