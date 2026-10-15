// Contract test of OBE-009: the spec-first changes of ota/docs/api-changes.md §1, §2, §5 and §6 in the OTA document
// (openapi/velexis-ota-booking-api.openapi.yaml) and the milestone of every original operation (ota/docs/scope.md §3).
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
import { otaOperations, type ApiOperation } from "@velexis/api-types/operations";
import { ERROR_CATALOGUE, OTA_ERROR_CODES, type ErrorCode } from "@velexis/errors";
import { responseChecker, type ResponseChecker } from "@velexis/testing";
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
    const edgeOperations = workingOperations.filter((op) =>
      securityOf(op).some((requirement) => "storefrontEdge" in requirement),
    );
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
      const expected = isCustomerScope(op) && takesKey(op) && STATE_CHANGING.has(op.method);
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

describe("the frozen original", () => {
  it("is unchanged under docs/velexis-sdk: same bytes, no MVP extension [OBE-009 AC2]", () => {
    const sha256 = createHash("sha256").update(readFileSync(FROZEN_DOCUMENT)).digest("hex");
    expect(sha256).toBe(FROZEN_DOCUMENT_SHA256);
    expect(frozenOperations.filter(({ spec }) => "x-milestone" in spec)).toEqual([]);
    expect(objectAt(frozen, "components", "securitySchemes")["storefrontEdge"]).toBeUndefined();
  });
});
