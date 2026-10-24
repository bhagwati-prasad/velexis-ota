// Contract test of OBE-058: the console permissions and the 17 console settings operations of
// ota/docs/api-changes-console-and-internal.md §1, §2.1–§2.3 and §2.6 in the OTA document
// (openapi/velexis-ota-booking-api.openapi.yaml).
//
// - `StaffPermission` gains `settings:*` and `payments:*`, with the role matrix of ota/docs/scope.md §1.3 (parsed
//   from scope.md, so the two cannot drift), and every console operation of the document names its permission in
//   `x-permission` (`none` for the four staff-session operations).
// - The settings operations (markup rules, fee rules, storefront settings, notification templates) with their
//   `x-sdk-method`, `x-permission` and `x-milestone: M4`, their schemas, and their pending entries.
// - `ENVIRONMENT_NOT_ALLOWED` (403) on every console operation, `TEMPLATE_INVALID` (422), and the
//   `consoleCardPayment` refusal of console.bookings.patch and issue (OADR-0018 follow-up).
//
// Requests are validated with the API's own validators (loadOpenApiDocument), responses with the checker every
// integration test uses. OBE-090 and OBE-091 add the remaining console operations with their own `x-permission`;
// the "every console operation" rules below cover them too. Totals are asserted once, by OBE-075.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { components, operations } from "@velexis/api-types";
import { otaOperations } from "@velexis/api-types/operations";
import { AppError, ERROR_CATALOGUE, OTA_ERROR_CODES, type ErrorCode } from "@velexis/errors";
import { responseChecker, type ResponseChecker } from "@velexis/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadOpenApiDocument,
  type OpenApiDocument,
  type RawRequest,
} from "../../src/common/http/openapi-validation.interceptor";
import { PENDING_OPERATIONS } from "../../src/common/http/pending-operations";
import { APP_DIR } from "../../src/config";
import { TEMPLATE_KEYS, TEMPLATE_REGISTRY } from "../../src/notifications/templates/registry";
import {
  APPLIES_PER,
  FEE_SCOPE_CARD_BRANDS,
  FEE_TYPES,
  PRICING_CALCULATIONS,
  PRICING_CHANNELS,
  SCOPE_AMOUNT_FIELDS,
  SCOPE_LIST_FIELDS,
  TRIP_TYPES,
} from "../../src/pricing/pricing.types";

const REPO_ROOT = join(APP_DIR, "..", "..");
const SCOPE_DOCUMENT = join(REPO_ROOT, "ota", "docs", "scope.md");
const FROZEN_DOCUMENT = join(
  REPO_ROOT,
  "docs",
  "velexis-sdk",
  "openapi",
  "velexis-ota-booking-api.openapi.yaml",
);
/** The tenant schema's migrations (the tables of `x-tenant-tables`). */
const TENANT_MIGRATIONS = join(APP_DIR, "migrations", "tenant");
/** The storefront's @font-face rules; OFE-020 bundles the fonts and declares one rule per enum value. */
const STOREFRONT_FONTS_CSS = join(REPO_ROOT, "ota", "frontend", "src", "styles", "fonts.css");

/** Parsing and compiling the 40,000-line document takes a few seconds on a busy runner. */
const DOCUMENT_TIMEOUT_MS = 60_000;

type Json = Record<string, unknown>;
type Method = "get" | "post" | "put" | "patch" | "delete";

/** One row of the tables of api-changes part 2 §2.1–§2.3 and §2.6, and the plan task that implements it. */
interface SettingsOperation {
  readonly operationId: string;
  readonly method: Method;
  readonly path: string;
  readonly sdkMethod: string;
  readonly permission: "settings:read" | "settings:write";
  readonly task: "OBE-069" | "OBE-070" | "OBE-073";
}

const MARKUP = "/v1/console/settings/markup-rules";
const FEES = "/v1/console/settings/fee-rules";
const TEMPLATE = "/v1/console/settings/notification-templates/{templateKey}/{channel}/{locale}";

const row = (
  operationId: string,
  method: Method,
  path: string,
  sdkMethod: string,
  permission: SettingsOperation["permission"],
  task: SettingsOperation["task"],
): SettingsOperation => ({ operationId, method, path, sdkMethod, permission, task });

/** The 17 settings operations of OBE-058, exactly as api-changes part 2 lists them. */
const SETTINGS_OPERATIONS: readonly SettingsOperation[] = [
  // §2.1 Markup rules
  row(
    "consoleListMarkupRules",
    "get",
    MARKUP,
    "console.settings.markupRules.list",
    "settings:read",
    "OBE-069",
  ),
  row(
    "consoleCreateMarkupRule",
    "post",
    MARKUP,
    "console.settings.markupRules.create",
    "settings:write",
    "OBE-069",
  ),
  row(
    "consoleGetMarkupRule",
    "get",
    `${MARKUP}/{markupRuleId}`,
    "console.settings.markupRules.get",
    "settings:read",
    "OBE-069",
  ),
  row(
    "consoleUpdateMarkupRule",
    "patch",
    `${MARKUP}/{markupRuleId}`,
    "console.settings.markupRules.update",
    "settings:write",
    "OBE-069",
  ),
  row(
    "consoleDeleteMarkupRule",
    "delete",
    `${MARKUP}/{markupRuleId}`,
    "console.settings.markupRules.delete",
    "settings:write",
    "OBE-069",
  ),
  // §2.2 Fee rules
  row("consoleListFeeRules", "get", FEES, "console.settings.feeRules.list", "settings:read", "OBE-069"),
  row("consoleCreateFeeRule", "post", FEES, "console.settings.feeRules.create", "settings:write", "OBE-069"),
  row(
    "consoleGetFeeRule",
    "get",
    `${FEES}/{feeRuleId}`,
    "console.settings.feeRules.get",
    "settings:read",
    "OBE-069",
  ),
  row(
    "consoleUpdateFeeRule",
    "patch",
    `${FEES}/{feeRuleId}`,
    "console.settings.feeRules.update",
    "settings:write",
    "OBE-069",
  ),
  row(
    "consoleDeleteFeeRule",
    "delete",
    `${FEES}/{feeRuleId}`,
    "console.settings.feeRules.delete",
    "settings:write",
    "OBE-069",
  ),
  // §2.3 Storefront settings
  row(
    "consoleGetStorefrontSettings",
    "get",
    "/v1/console/settings/storefront",
    "console.settings.storefront.get",
    "settings:read",
    "OBE-070",
  ),
  row(
    "consoleUpdateStorefrontSettings",
    "patch",
    "/v1/console/settings/storefront",
    "console.settings.storefront.update",
    "settings:write",
    "OBE-070",
  ),
  // §2.6 Notification templates
  row(
    "consoleListNotificationTemplates",
    "get",
    "/v1/console/settings/notification-templates",
    "console.settings.templates.list",
    "settings:read",
    "OBE-073",
  ),
  row(
    "consoleGetNotificationTemplate",
    "get",
    TEMPLATE,
    "console.settings.templates.get",
    "settings:read",
    "OBE-073",
  ),
  row(
    "consolePutNotificationTemplate",
    "put",
    TEMPLATE,
    "console.settings.templates.put",
    "settings:write",
    "OBE-073",
  ),
  row(
    "consolePreviewNotificationTemplate",
    "post",
    `${TEMPLATE}/preview`,
    "console.settings.templates.preview",
    "settings:read",
    "OBE-073",
  ),
  row(
    "consoleResetNotificationTemplate",
    "post",
    `${TEMPLATE}/reset`,
    "console.settings.templates.reset",
    "settings:write",
    "OBE-073",
  ),
];

/** The nine permissions of the original design and the five of api-changes part 2 §1, in enum order. */
const ORIGINAL_PERMISSIONS = [
  "bookings:read",
  "bookings:write",
  "bookings:issue",
  "bookings:cancel",
  "customers:read",
  "queues:read",
  "supplier_requests:read",
  "amadeus:read",
  "amadeus:write",
] as const;
const NEW_PERMISSIONS = [
  "settings:read",
  "settings:write",
  "payments:read",
  "payments:capture",
  "payments:refund",
] as const;
const ALL_PERMISSIONS: readonly string[] = [...ORIGINAL_PERMISSIONS, ...NEW_PERMISSIONS];
const ROLES = ["owner", "admin", "agent", "finance", "viewer"] as const;

/**
 * `x-permission` of the 33 console operations of the original design: the permission each operation's
 * description names ("Permission `bookings:read`", the same as console.amadeus.searchFlightOffers, …), and `none`
 * for the staff-session operations. flights.availability (owner, admin, agent) is a raw Amadeus read.
 */
const ORIGINAL_CONSOLE_PERMISSIONS: Readonly<Record<string, string>> = {
  searchFlightAvailabilities: "amadeus:read",
  consoleSignIn: "none",
  consoleRefreshSession: "none",
  consoleSignOut: "none",
  consoleGetMe: "none",
  consoleListBookings: "bookings:read",
  consoleCreateBooking: "bookings:write",
  consoleGetBooking: "bookings:read",
  consolePatchBooking: "bookings:write",
  consoleIssueBooking: "bookings:issue",
  consoleCancelBooking: "bookings:cancel",
  consoleResyncBooking: "bookings:write",
  consoleAddBookingNote: "bookings:write",
  consoleFindBookingByRecordLocator: "bookings:read",
  consoleImportBooking: "bookings:write",
  consoleRetrieveFlightOrder: "bookings:read",
  consoleListQueue: "queues:read",
  consoleListQueueSnapshots: "queues:read",
  consoleListCustomers: "customers:read",
  consoleGetCustomer: "customers:read",
  consoleListSupplierRequests: "supplier_requests:read",
  consoleAmadeusSearchFlightOffers: "amadeus:read",
  consoleAmadeusGetFlightOffers: "amadeus:read",
  consoleAmadeusSearchFlightAvailabilities: "amadeus:read",
  consoleAmadeusUpsellAirOffers: "amadeus:read",
  consoleAmadeusQuoteAirOffers: "amadeus:read",
  consoleAmadeusGetFlightOrder: "amadeus:read",
  consoleAmadeusGetFlightOrderByReference: "amadeus:read",
  consoleAmadeusGetQueue: "amadeus:read",
  consoleAmadeusCreateFlightOrders: "amadeus:write",
  consoleAmadeusIssueFlightOrder: "amadeus:write",
  consoleAmadeusPatchFlightOrder: "amadeus:write",
  consoleAmadeusCancelFlightOrder: "amadeus:write",
};

/**
 * The MVP template keys of api-changes part 2 §2.6, with `booking.updated` of OADR-0013 item 4 as revised on 2026-10-23
 * and `account.email_changed` and `account.deleted` as revised on 2026-10-24 (FIX-W29-OTA).
 */
const SPEC_TEMPLATE_KEYS = [
  "auth.verify_email",
  "auth.password_reset",
  "account.email_changed",
  "account.deleted",
  "booking.confirmed",
  "booking.ticketed",
  "booking.ticketing_delayed",
  "booking.cancelled",
  "booking.cancellation_requested",
  "booking.not_confirmed",
  "booking.updated",
  "staff.ticketing_failed",
  "staff.manual_review",
  "staff.airline_card_alert",
];

/**
 * The font families the hosted storefront bundles (OADR-0015 point 8). Until OFE-020 declares them in
 * ota/frontend/src/styles/fonts.css, this list is the reference; once fonts.css has @font-face rules, the enum is
 * compared with them instead (and OFE-020's own test compares fonts.css with the enum).
 */
const BUNDLED_FONTS = [
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Source Sans 3",
  "Merriweather",
  "Playfair Display",
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
let workingOperations: Operation[];
let frozenConsoleOperationIds: string[];
let byId: Map<string, Operation>;
let checker: ResponseChecker;

beforeAll(() => {
  document = loadOpenApiDocument();
  working = document.document as Json;
  workingOperations = Object.entries(objectAt(working, "paths")).flatMap(([path, item]) =>
    Object.entries(item as Json)
      .filter(([, value]) => isObject(value) && typeof value["operationId"] === "string")
      .map(([method, value]) => ({
        operationId: String((value as Json)["operationId"]),
        method,
        path,
        spec: value as Json,
      })),
  );
  byId = new Map(workingOperations.map((operation) => [operation.operationId, operation]));
  const frozen = parse(readFileSync(FROZEN_DOCUMENT, "utf8")) as Json;
  frozenConsoleOperationIds = Object.values(objectAt(frozen, "paths")).flatMap((item) =>
    Object.values(item as Json)
      .filter((value): value is Json => isObject(value) && value["x-scope"] === "console")
      .map((value) => String(value["operationId"])),
  );
  checker = responseChecker("ota");
}, DOCUMENT_TIMEOUT_MS);

function operation(operationId: string): Operation {
  const found = byId.get(operationId);
  if (found === undefined) {
    throw new Error(`the OTA document has no operation ${operationId}`);
  }
  return found;
}

const schemaOf = (name: string): Json => objectAt(working, "components", "schemas", name);

const consoleOperations = (): Operation[] =>
  workingOperations.filter(({ spec }) => spec["x-scope"] === "console");

/** The component parameters an operation references, by component name, and its inline ones by `in:name`. */
function parametersOf(op: Operation): string[] {
  return ((op.spec["parameters"] as Json[] | undefined) ?? []).map((parameter) =>
    typeof parameter["$ref"] === "string"
      ? parameter["$ref"].replace("#/components/parameters/", "")
      : `${String(parameter["in"])}:${String(parameter["name"])}`,
  );
}

/** What the API's request validator says about a request: `[]`, or the field errors as `"<path> <code>"`. */
function problems(operationId: string, request: Partial<RawRequest>): string[] {
  try {
    document.validator(operationId).validate({
      params: {},
      query: {},
      headers: {},
      body: undefined,
      bodySent: false,
      ...request,
    });
    return [];
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      return (error.fieldErrors ?? []).map(({ path, code }) => `${path} ${code}`);
    }
    throw error;
  }
}

/** A request with a JSON body and the headers the operation needs. */
const withBody = (body: unknown, headers: RawRequest["headers"] = {}): Partial<RawRequest> => ({
  body,
  bodySent: true,
  headers,
});

const IDEMPOTENCY = { "idempotency-key": "4b4c0e0e-6d5b-4a43-9a0b-5d3f1d2e7c10" };
const IF_MATCH = { "if-match": '"3"' };

const MARKUP_RULE_ID = "mkr_01JA5M2K8Q4R7T0V3X6Z9B2D5F";
const TEMPLATE_PARAMS = { templateKey: "booking.confirmed", channel: "email", locale: "en" };

/** The JSON request example `name` of an operation. */
function requestExample(operationId: string, name: string): unknown {
  return objectAt(
    operation(operationId).spec,
    "requestBody",
    "content",
    "application/json",
    "examples",
    name,
  )["value"];
}

/** The value of `components.examples.<name>`. */
const componentExample = (name: string): Json => objectAt(working, "components", "examples", name, "value");

/** Role → permissions of the matrix in ota/docs/scope.md §1.3 (rows of backticked permissions, ✓ per role). */
function scopeRoleMatrix(): Record<string, string[]> {
  const text = readFileSync(SCOPE_DOCUMENT, "utf8");
  const section = text.slice(text.indexOf("### 1.3"), text.indexOf("## 2."));
  const header = section.split("\n").find((line) => line.startsWith("| Permission |"));
  expect(header?.split("|").map((cell) => cell.trim())).toEqual(["", "Permission", ...ROLES, ""]);
  const matrix: Record<string, string[]> = Object.fromEntries(ROLES.map((role) => [role, []]));
  for (const line of section.split("\n").filter((candidate) => candidate.startsWith("| `"))) {
    const cells = line.split("|").map((cell) => cell.trim());
    const permissions = [...(cells[1] ?? "").matchAll(/`([a-z_]+:[a-z_]+)`/g)].map((match) => match[1] ?? "");
    ROLES.forEach((role, index) => {
      if (cells[index + 2] === "✓") {
        matrix[role]?.push(...permissions);
      }
    });
  }
  return matrix;
}

/** Role → permissions as the StaffPermission description lists them (`- \`agent\`: \`bookings:read\`, …`). */
function describedRoleMatrix(description: string): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};
  for (const match of description.matchAll(/^- ((?:`[a-z]+`(?:, )?)+): (.+)$/gm)) {
    const roles = [...(match[1] ?? "").matchAll(/`([a-z]+)`/g)].map((role) => role[1] ?? "");
    const listed = (match[2] ?? "").startsWith("every permission")
      ? [...ALL_PERMISSIONS]
      : [...(match[2] ?? "").matchAll(/`([a-z_]+:[a-z_]+)`/g)].map((permission) => permission[1] ?? "");
    for (const role of roles) {
      matrix[role] = listed;
    }
  }
  return matrix;
}

/** The family names of the @font-face rules of a stylesheet. */
function fontFaceFamilies(css: string): string[] {
  const families = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].flatMap((rule) => {
    const family = /font-family\s*:\s*["']?([^"';]+?)["']?\s*;/.exec(rule[1] ?? "");
    return family === null ? [] : [family[1] ?? ""];
  });
  return [...new Set(families)];
}

describe("console permissions (api-changes part 2 §1, scope §1.3)", () => {
  it("adds settings and payments permissions to StaffPermission with the role matrix of scope §1.3 [OBE-058 AC1]", () => {
    const staffPermission = schemaOf("StaffPermission");
    expect(staffPermission["enum"]).toEqual(ALL_PERMISSIONS);
    // The generated union carries the new values (this compiles only while it does).
    const typed: ReadonlyArray<components["schemas"]["StaffPermission"]> = [...NEW_PERMISSIONS];
    expect(typed).toHaveLength(5);

    const scope = scopeRoleMatrix();
    const described = describedRoleMatrix(String(staffPermission["description"]));
    for (const role of ROLES) {
      expect([role, [...(described[role] ?? [])].sort()]).toEqual([role, [...(scope[role] ?? [])].sort()]);
    }
    // The matrix as scope §1.3 states it: owner and admin everything, settings:write theirs alone.
    expect(scope["owner"]?.sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(scope["admin"]?.sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(scope["agent"]).toEqual(expect.arrayContaining(["settings:read", "payments:capture"]));
    expect(scope["agent"]).not.toContain("settings:write");
    expect(scope["agent"]).not.toContain("payments:refund");
    expect(scope["finance"]).toEqual(expect.arrayContaining(["payments:refund", "settings:read"]));
    expect(scope["viewer"]?.sort()).toEqual(
      ["bookings:read", "customers:read", "payments:read", "settings:read"].sort(),
    );
    // console.auth.me describes the same matrix.
    const me = String(operation("consoleGetMe").spec["description"]);
    for (const permission of NEW_PERMISSIONS) {
      expect([permission, me.includes(`\`${permission}\``)]).toEqual([permission, true]);
    }
  });

  it("gives every console operation an x-permission: a StaffPermission, or none for the staff-session operations [OBE-058 AC1]", () => {
    const allowed = new Set(ALL_PERMISSIONS);
    expect(frozenConsoleOperationIds).toHaveLength(33);
    expect(Object.keys(ORIGINAL_CONSOLE_PERMISSIONS).sort()).toEqual([...frozenConsoleOperationIds].sort());
    for (const op of consoleOperations()) {
      const permission = op.spec["x-permission"];
      const isSession = (op.spec["tags"] as string[]).includes("Console auth");
      expect([op.operationId, typeof permission]).toEqual([op.operationId, "string"]);
      if (isSession) {
        expect([op.operationId, permission]).toEqual([op.operationId, "none"]);
      } else {
        expect([op.operationId, allowed.has(String(permission))]).toEqual([op.operationId, true]);
      }
      // The operations index carries it for the permission guard (OBE-060).
      const indexed = otaOperations.find((entry) => entry.operationId === op.operationId);
      expect([op.operationId, indexed?.permission]).toEqual([op.operationId, permission]);
    }
    for (const [operationId, permission] of Object.entries(ORIGINAL_CONSOLE_PERMISSIONS)) {
      expect([operationId, operation(operationId).spec["x-permission"]]).toEqual([operationId, permission]);
    }
    // Only console operations have one.
    for (const op of workingOperations.filter(({ spec }) => spec["x-scope"] !== "console")) {
      expect([op.operationId, op.spec["x-permission"]]).toEqual([op.operationId, undefined]);
    }
    const description = String(objectAt(working, "info")["description"]);
    expect(description).toContain("- `x-permission` (");
    expect(description).toContain("`none` marks the four");
  });

  it("lists 403 ENVIRONMENT_NOT_ALLOWED on every console operation and adds it and TEMPLATE_INVALID to the catalogue [OBE-058 AC1]", () => {
    // Compiles only while both codes are members of the generated union.
    const codes: readonly ErrorCode[] = ["ENVIRONMENT_NOT_ALLOWED", "TEMPLATE_INVALID"];
    expect(codes.map((code) => [code, ERROR_CATALOGUE[code].status, ERROR_CATALOGUE[code].source])).toEqual([
      ["ENVIRONMENT_NOT_ALLOWED", 403, "ota"],
      ["TEMPLATE_INVALID", 422, "ota"],
    ]);
    expect(OTA_ERROR_CODES).toEqual(expect.arrayContaining([...codes]));
    expect(objectAt(working, "x-error-catalogue", "ENVIRONMENT_NOT_ALLOWED")).toEqual({
      status: 403,
      description: "The requested environment is not available to this tenant or role.",
    });
    expect(objectAt(working, "x-error-catalogue", "TEMPLATE_INVALID")).toEqual({
      status: 422,
      description:
        "The notification template does not compile or uses a variable that is not allowed (details.errors).",
    });

    // Every console call of the OTA admin's service key can ask for an environment it may not open.
    for (const op of consoleOperations()) {
      expect([op.operationId, op.spec["x-error-codes"]]).toEqual([
        op.operationId,
        expect.arrayContaining(["ENVIRONMENT_NOT_ALLOWED"]),
      ]);
      expect([op.operationId, "403" in objectAt(op.spec, "responses")]).toEqual([op.operationId, true]);
    }
    expect(
      String(objectAt(working, "components", "parameters", "VelexisEnvironment")["description"]),
    ).toContain("`403 ENVIRONMENT_NOT_ALLOWED`");
    const forbidden = objectAt(
      working,
      "components",
      "responses",
      "ConsoleForbidden",
      "content",
      "application/json",
      "examples",
      "ENVIRONMENT_NOT_ALLOWED",
      "value",
    );
    expect(checker.check("consoleListBookings", { status: 403, body: forbidden })).toEqual([]);
    expect(objectAt(forbidden, "error")["code"]).toBe("ENVIRONMENT_NOT_ALLOWED");
  });

  it("refuses creditCard in console.bookings.patch and issue with 403 FEATURE_DISABLED consoleCardPayment [OBE-058 AC1]", () => {
    for (const operationId of ["consolePatchBooking", "consoleIssueBooking"]) {
      const spec = operation(operationId).spec;
      expect([operationId, String(spec["description"])]).toEqual([
        operationId,
        expect.stringContaining(
          'A `creditCard` entry in `formOfPayments` answers `403 FEATURE_DISABLED` with `details.feature = "consoleCardPayment"`',
        ),
      ]);
      expect([operationId, spec["x-error-codes"]]).toEqual([
        operationId,
        expect.arrayContaining(["FEATURE_DISABLED"]),
      ]);
      expect(objectAt(spec, "responses", "403")).toEqual({ $ref: "#/components/responses/ConsoleForbidden" });
    }
    for (const schema of ["ConsoleBookingPatchRequest", "ConsoleBookingIssueRequest"]) {
      expect([
        schema,
        String(objectAt(schemaOf(schema), "properties", "formOfPayments")["description"]),
      ]).toEqual([schema, expect.stringContaining('`details.feature = "consoleCardPayment"`')]);
    }
    const example = objectAt(
      working,
      "components",
      "responses",
      "ConsoleForbidden",
      "content",
      "application/json",
      "examples",
      "FEATURE_DISABLED_CONSOLE_CARD_PAYMENT",
      "value",
    );
    expect(objectAt(example, "error")).toMatchObject({
      code: "FEATURE_DISABLED",
      status: 403,
      details: { feature: "consoleCardPayment" },
    });
    expect(checker.check("consoleIssueBooking", { status: 403, body: example })).toEqual([]);
  });
});

describe("the 17 console settings operations (api-changes part 2 §2.1–§2.3, §2.6)", () => {
  it("adds every operation of §2.1–§2.3 and §2.6 with its x-sdk-method, permission and x-milestone M4 [OBE-058 AC1]", () => {
    expect(SETTINGS_OPERATIONS).toHaveLength(17);
    expect(new Set(SETTINGS_OPERATIONS.map(({ sdkMethod }) => sdkMethod)).size).toBe(17);
    for (const expected of SETTINGS_OPERATIONS) {
      const op = operation(expected.operationId);
      expect([op.operationId, op.method, op.path]).toEqual([
        expected.operationId,
        expected.method,
        expected.path,
      ]);
      expect(op.spec).toMatchObject({
        "x-sdk-method": expected.sdkMethod,
        "x-scope": "console",
        "x-permission": expected.permission,
        "x-milestone": "M4",
        "x-amadeus": [],
        tags: ["Console settings"],
      });
      // A staff token with the service or a secret key, or a console:automation key alone (as every console
      // operation of the original design).
      expect([op.operationId, op.spec["security"]]).toEqual([
        op.operationId,
        [{ apiKey: [], staffAuth: [] }, { apiKey: [] }],
      ]);
      // Every settings operation writes staff_actions: a change its row, any call its refused row (api-changes
      // part 2 §1, OADR-0011 point 8 as decided on 2026-10-21; a successful read writes none).
      expect([op.operationId, op.spec["x-tenant-tables"]]).toEqual([
        op.operationId,
        expect.arrayContaining(["staff_actions"]),
      ]);
      expect([op.operationId, parametersOf(op)]).toEqual([
        op.operationId,
        expect.arrayContaining(["VelexisEnvironment", "CustomerEndUserIp", "CustomerEndUserAgent"]),
      ]);
      expect([op.operationId, op.spec["x-error-codes"]]).toEqual([
        op.operationId,
        expect.arrayContaining([
          "VALIDATION_FAILED",
          "UNAUTHENTICATED",
          "TOKEN_EXPIRED",
          "FORBIDDEN",
          "SCOPE_NOT_ALLOWED",
          "TENANT_SUSPENDED",
          "STAFF_MEMBERSHIP_INACTIVE",
          "ENVIRONMENT_NOT_ALLOWED",
          "RATE_LIMITED",
        ]),
      ]);
      expect(otaOperations.find((entry) => entry.operationId === expected.operationId)).toEqual({
        operationId: expected.operationId,
        method: expected.method,
        path: expected.path,
        sdkMethod: expected.sdkMethod,
        scope: "console",
        tags: ["Console settings"],
        internal: false,
        milestone: "M4",
        edgeOnly: false,
        permission: expected.permission,
      });
    }
    const tags = (working["tags"] as Json[]).map((tag) => tag["name"]);
    expect(tags).toContain("Console settings");
    const consoleGroup = (working["x-tagGroups"] as Json[]).find((group) => group["name"] === "Console");
    expect(consoleGroup?.["tags"]).toContain("Console settings");
  });

  it("takes If-Match on updates and deletes, an Idempotency-Key on creates, and returns the version as ETag [OBE-058 AC1]", () => {
    for (const operationId of [
      "consoleUpdateMarkupRule",
      "consoleDeleteMarkupRule",
      "consoleUpdateFeeRule",
      "consoleDeleteFeeRule",
      "consoleUpdateStorefrontSettings",
    ]) {
      expect([operationId, parametersOf(operation(operationId))]).toEqual([
        operationId,
        expect.arrayContaining(["IfMatch"]),
      ]);
      expect([operationId, "412" in objectAt(operation(operationId).spec, "responses")]).toEqual([
        operationId,
        true,
      ]);
    }
    for (const operationId of ["consoleCreateMarkupRule", "consoleCreateFeeRule"]) {
      expect([operationId, parametersOf(operation(operationId))]).toEqual([
        operationId,
        expect.arrayContaining(["IdempotencyKey"]),
      ]);
      expect(objectAt(operation(operationId).spec, "responses", "201", "headers")).toMatchObject({
        ETag: { $ref: "#/components/headers/ETag" },
        Location: { $ref: "#/components/headers/Location" },
      });
    }
    for (const operationId of [
      "consoleGetMarkupRule",
      "consoleUpdateMarkupRule",
      "consoleGetFeeRule",
      "consoleUpdateFeeRule",
      "consoleGetStorefrontSettings",
      "consoleUpdateStorefrontSettings",
      "consoleGetNotificationTemplate",
      "consolePutNotificationTemplate",
    ]) {
      expect([operationId, objectAt(operation(operationId).spec, "responses", "200", "headers")]).toEqual([
        operationId,
        expect.objectContaining({ ETag: { $ref: "#/components/headers/ETag" } }),
      ]);
    }
    // put: If-Match only when the OTA already has a row (optional), so the generic required IfMatch is not used.
    const put = operation("consolePutNotificationTemplate");
    expect(parametersOf(put)).toContain("header:If-Match");
    expect(
      (put.spec["parameters"] as Json[]).find((parameter) => parameter["name"] === "If-Match")?.["required"],
    ).toBe(false);
    expect(
      problems("consolePutNotificationTemplate", {
        params: TEMPLATE_PARAMS,
        ...withBody(requestExample("consolePutNotificationTemplate", "confirmed")),
      }),
    ).toEqual([]);
    // preview renders and reset deletes: safe to repeat without an Idempotency-Key.
    for (const operationId of ["consolePreviewNotificationTemplate", "consoleResetNotificationTemplate"]) {
      expect([operationId, operation(operationId).spec["x-idempotent-by-design"]]).toEqual([
        operationId,
        true,
      ]);
    }
    expect(problems("consoleUpdateMarkupRule", { params: { markupRuleId: MARKUP_RULE_ID } })).toEqual(
      expect.arrayContaining(["/header/If-Match required", " required"]),
    );
    expect(
      problems("consoleCreateMarkupRule", withBody(requestExample("consoleCreateMarkupRule", "longHaul"))),
    ).toEqual(["/header/Idempotency-Key required"]);
  });

  it("lists the 17 operations in pending-operations.ts with the tasks that implement them until those are done [OBE-058 AC3]", () => {
    // A task that implements its operations removes their entries (pending-operations.ts); route parity
    // (route-parity.contract.test.ts) then requires their handlers.
    const implemented: ReadonlySet<SettingsOperation["task"]> = new Set(["OBE-069", "OBE-070"]);
    for (const { operationId, task } of SETTINGS_OPERATIONS) {
      expect([operationId, PENDING_OPERATIONS[operationId as keyof typeof PENDING_OPERATIONS]]).toEqual([
        operationId,
        implemented.has(task) ? undefined : task,
      ]);
    }
  });
});

describe("markup and fee rules (api-changes part 2 §2.1, §2.2; OADR-0005)", () => {
  it("defines MarkupRule, MarkupRuleInput and MarkupRuleUpdate as §2.1 sketches them [OBE-058 AC1]", () => {
    const rule = schemaOf("MarkupRule");
    expect(rule["required"]).toEqual([
      "id",
      "name",
      "scope",
      "calculation",
      "appliesPer",
      "priority",
      "stackable",
      "isDefault",
      "isActive",
      "version",
      "createdAt",
      "updatedAt",
    ]);
    expect(objectAt(rule, "properties", "id")["pattern"]).toBe("^mkr_[0-9A-Za-z]{16,40}$");
    expect(objectAt(rule, "properties", "scope")).toEqual({ $ref: "#/components/schemas/PricingRuleScope" });
    expect(objectAt(rule, "properties", "calculation")["enum"]).toEqual([...PRICING_CALCULATIONS]);
    expect(objectAt(rule, "properties", "appliesPer")["enum"]).toEqual([...APPLIES_PER]);
    for (const money of ["fixed", "min", "max"]) {
      expect([money, objectAt(rule, "properties", money)["anyOf"]]).toEqual([
        money,
        [{ $ref: "#/components/schemas/Money" }, { type: "null" }],
      ]);
    }
    for (const field of [
      "description",
      "percentage",
      "priority",
      "stackable",
      "isDefault",
      "isActive",
      "activeFrom",
      "activeUntil",
    ]) {
      expect([field, field in objectAt(rule, "properties")]).toEqual([field, true]);
    }

    const input = schemaOf("MarkupRuleInput");
    const update = schemaOf("MarkupRuleUpdate");
    expect(input).toMatchObject({ additionalProperties: false, required: ["name", "scope", "calculation"] });
    // An update is any subset of the create fields; isDefault, id and version are never writable.
    expect(update).toMatchObject({ additionalProperties: false, minProperties: 1 });
    expect(update["required"]).toBeUndefined();
    expect(objectAt(update, "properties")).toEqual(objectAt(input, "properties"));
    for (const readOnly of ["id", "isDefault", "version", "createdAt", "updatedAt", "warnings"]) {
      expect([readOnly, readOnly in objectAt(input, "properties")]).toEqual([readOnly, false]);
    }

    // The API's request validation.
    const create = (body: unknown) => problems("consoleCreateMarkupRule", withBody(body, IDEMPOTENCY));
    for (const name of ["longHaul", "promotion"]) {
      expect([name, create(requestExample("consoleCreateMarkupRule", name))]).toEqual([name, []]);
    }
    const typed: operations["consoleCreateMarkupRule"]["requestBody"]["content"]["application/json"] = {
      name: "Everything",
      scope: {},
      calculation: "percentage",
      percentage: "2.5000",
    };
    expect(create(typed)).toEqual([]);
    expect(create({ ...typed, percentage: 2.5 })).toEqual(["/percentage type"]);
    expect(create({ ...typed, percentage: "12.34567" })).toEqual(["/percentage pattern"]);
    // markup_rules.percentage is numeric(7,4): 999.9999 is the largest value the column holds, so the pattern
    // refuses 1000 (which the CHECK's upper bound would allow) instead of the database failing on it.
    expect(create({ ...typed, percentage: "999.9999" })).toEqual([]);
    expect(create({ ...typed, percentage: "1000" })).toEqual(["/percentage pattern"]);
    expect(String(objectAt(rule, "properties", "percentage")["description"])).toContain("-100 to 999.9999");
    expect(create({ ...typed, isDefault: true })).toEqual(["/isDefault additionalProperties"]);
    expect(create({ ...typed, scope: { routes: ["CDG-JFK"] } })).toEqual([
      "/scope/routes additionalProperties",
    ]);
    expect(create({ ...typed, scope: { cardBrands: ["VISA"] } })).toEqual([
      "/scope/cardBrands additionalProperties",
    ]);
    expect(create({ ...typed, scope: { cabins: ["COACH"] } })).toEqual(["/scope/cabins/0 enum"]);
    const { calculation, ...withoutCalculation } = typed;
    expect(calculation).toBe("percentage");
    expect(create(withoutCalculation)).toEqual(["/calculation required"]);

    const patch = (body: unknown) =>
      problems("consoleUpdateMarkupRule", {
        params: { markupRuleId: MARKUP_RULE_ID },
        ...withBody(body, IF_MATCH),
      });
    for (const name of ["raise", "disable"]) {
      expect([name, patch(requestExample("consoleUpdateMarkupRule", name))]).toEqual([name, []]);
    }
    expect(patch({})).toEqual([" minProperties"]);
    expect(patch({ version: 4 })).toEqual(["/version additionalProperties"]);
    expect(
      problems("consoleGetMarkupRule", { params: { markupRuleId: "fee_01JA5P4M0S6T9V2X5Z8B1D4F7H" } }),
    ).toEqual(["/path/markupRuleId pattern"]);

    expect(
      checker.check("consoleGetMarkupRule", { status: 200, body: componentExample("MarkupRuleExample") }),
    ).toEqual([]);
    expect(
      checker.check("consoleListMarkupRules", {
        status: 200,
        body: componentExample("MarkupRulePageExample"),
      }),
    ).toEqual([]);
    const page = componentExample("MarkupRulePageExample")["data"] as Json[];
    expect(page.filter((entry) => entry["isDefault"] === true)).toEqual([
      expect.objectContaining({ scope: {}, priority: 1000, calculation: "percentage" }),
    ]);
    // Rules are listed in evaluation order: priority, then id.
    expect(page.map((entry) => entry["priority"])).toEqual([50, 100, 1000]);
  });

  it("matches PricingRuleScope to the pricing engine's scope fields, and FeeRuleScope adds cardBrands [OBE-058 AC1]", () => {
    const scope = schemaOf("PricingRuleScope");
    expect(scope["additionalProperties"]).toBe(false);
    // The scope fields of §2.1 are the ones the engine evaluates (src/pricing/pricing.types.ts).
    expect(Object.keys(objectAt(scope, "properties"))).toEqual([
      ...SCOPE_LIST_FIELDS,
      ...SCOPE_AMOUNT_FIELDS,
    ]);
    expect(objectAt(scope, "properties", "tripTypes", "items")["enum"]).toEqual([...TRIP_TYPES]);
    expect(objectAt(scope, "properties", "channels", "items")["enum"]).toEqual([...PRICING_CHANNELS]);
    expect(objectAt(scope, "properties", "cabins", "items")).toEqual({
      $ref: "#/components/schemas/AmadeusTravelClass",
    });
    expect(objectAt(scope, "properties", "travelerTypes", "items")).toEqual({
      $ref: "#/components/schemas/AmadeusTravelerType",
    });
    expect(objectAt(scope, "properties", "sources", "items")).toEqual({
      $ref: "#/components/schemas/AmadeusFlightOfferSource",
    });

    const feeScope = schemaOf("FeeRuleScope");
    expect(feeScope["additionalProperties"]).toBe(false);
    expect(objectAt(feeScope, "properties")).toEqual({
      ...objectAt(scope, "properties"),
      [FEE_SCOPE_CARD_BRANDS]: expect.objectContaining({
        type: "array",
        items: { $ref: "#/components/schemas/AmadeusPaymentBrand" },
      }),
    });
  });

  it("defines FeeRule, FeeRuleInput and FeeRuleUpdate as §2.2 sketches them [OBE-058 AC1]", () => {
    const rule = schemaOf("FeeRule");
    expect(rule["required"]).toEqual([
      "id",
      "name",
      "label",
      "feeType",
      "scope",
      "calculation",
      "appliesPer",
      "refundable",
      "priority",
      "isActive",
      "version",
      "createdAt",
      "updatedAt",
    ]);
    expect(objectAt(rule, "properties", "id")["pattern"]).toBe("^fee_[0-9A-Za-z]{16,40}$");
    expect(objectAt(rule, "properties", "feeType")["enum"]).toEqual([...FEE_TYPES]);
    expect(objectAt(rule, "properties", "scope")).toEqual({ $ref: "#/components/schemas/FeeRuleScope" });
    expect(String(objectAt(rule, "properties", "feeType")["description"])).toContain(
      "`change` fees are stored but unused in the MVP",
    );
    for (const field of ["percentage", "fixed", "min", "max", "activeFrom", "activeUntil"]) {
      expect([field, field in objectAt(rule, "properties")]).toEqual([field, true]);
    }

    const input = schemaOf("FeeRuleInput");
    const update = schemaOf("FeeRuleUpdate");
    expect(input).toMatchObject({
      additionalProperties: false,
      required: ["name", "label", "feeType", "scope", "calculation"],
    });
    expect(update).toMatchObject({ additionalProperties: false, minProperties: 1 });
    expect(update["required"]).toBeUndefined();
    expect(objectAt(update, "properties")).toEqual(objectAt(input, "properties"));

    const create = (body: unknown) => problems("consoleCreateFeeRule", withBody(body, IDEMPOTENCY));
    for (const name of ["serviceFee", "amexFee"]) {
      expect([name, create(requestExample("consoleCreateFeeRule", name))]).toEqual([name, []]);
    }
    const amex = requestExample("consoleCreateFeeRule", "amexFee") as Json;
    // Fee percentages are 0 to 100: no negative fee.
    expect(create({ ...amex, percentage: "-1.0000" })).toEqual(["/percentage pattern"]);
    expect(create({ ...amex, feeType: "refund" })).toEqual(["/feeType enum"]);
    expect(create({ ...amex, scope: { cardBrands: ["DISCOVER"] } })).toEqual(["/scope/cardBrands/0 enum"]);
    expect(
      problems("consoleUpdateFeeRule", {
        params: { feeRuleId: "fee_01JA5P4M0S6T9V2X5Z8B1D4F7H" },
        ...withBody(requestExample("consoleUpdateFeeRule", "refundable"), IF_MATCH),
      }),
    ).toEqual([]);

    expect(
      checker.check("consoleGetFeeRule", { status: 200, body: componentExample("FeeRuleExample") }),
    ).toEqual([]);
    expect(
      checker.check("consoleListFeeRules", { status: 200, body: componentExample("FeeRulePageExample") }),
    ).toEqual([]);
  });

  it("documents the default rule conflict and the warnings of rule changes [OBE-058 AC1]", () => {
    for (const operationId of ["consoleUpdateMarkupRule", "consoleDeleteMarkupRule"]) {
      const spec = operation(operationId).spec;
      expect([operationId, String(spec["description"])]).toEqual([
        operationId,
        expect.stringContaining('`details.reason = "default_rule"`'),
      ]);
      expect([operationId, spec["x-error-codes"]]).toEqual([
        operationId,
        expect.arrayContaining(["CONFLICT"]),
      ]);
      expect(objectAt(spec, "responses", "409")).toEqual({ $ref: "#/components/responses/SettingsConflict" });
    }
    const conflict = objectAt(
      working,
      "components",
      "responses",
      "SettingsConflict",
      "content",
      "application/json",
      "examples",
      "CONFLICT",
      "value",
    );
    expect(objectAt(conflict, "error", "details")).toEqual({ reason: "default_rule" });
    expect(checker.check("consoleDeleteMarkupRule", { status: 409, body: conflict })).toEqual([]);
    // Only the default markup rule conflicts: creates answer 409 for a reused Idempotency-Key alone, and fee rules
    // (no default rule) never answer CONFLICT.
    for (const operationId of [
      "consoleCreateMarkupRule",
      "consoleCreateFeeRule",
      "consoleUpdateFeeRule",
      "consoleDeleteFeeRule",
    ]) {
      const spec = operation(operationId).spec;
      expect([operationId, (spec["x-error-codes"] as string[]).includes("CONFLICT")]).toEqual([
        operationId,
        false,
      ]);
      const creates = operationId.startsWith("consoleCreate");
      expect([operationId, "409" in objectAt(spec, "responses")]).toEqual([operationId, creates]);
      expect([operationId, (spec["x-error-codes"] as string[]).includes("IDEMPOTENCY_KEY_REUSED")]).toEqual([
        operationId,
        creates,
      ]);
    }
    for (const name of ["MarkupRule", "FeeRule"]) {
      expect([name, objectAt(schemaOf(name), "properties", "warnings", "items")]).toEqual([
        name,
        { $ref: "#/components/schemas/SettingsWarning" },
      ]);
      expect([name, (schemaOf(name)["required"] as string[]).includes("warnings")]).toEqual([name, false]);
      // Only create and update answers carry warnings; the example the get answers share has none.
      expect([name, "warnings" in componentExample(`${name}Example`)]).toEqual([name, false]);
    }
  });

  it("lists in console.settings.markupRules.delete every table whose markup_rule_id the deletion clears [OBE-058 AC1]", () => {
    // The tenant migrations' tables with a `markup_rule_id … REFERENCES markup_rules (id) ON DELETE SET NULL`.
    const migrations = readdirSync(TENANT_MIGRATIONS)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => readFileSync(join(TENANT_MIGRATIONS, file), "utf8"))
      .join("\n");
    const clearedBy = [...migrations.matchAll(/^CREATE TABLE (\w+) \(([\s\S]*?)^\);/gm)]
      .filter((table) => /REFERENCES markup_rules \(id\) ON DELETE SET NULL/.test(table[2] ?? ""))
      .map((table) => table[1] ?? "");
    expect(clearedBy).toEqual(expect.arrayContaining(["flight_offers", "priced_offers", "bookings"]));
    expect(operation("consoleDeleteMarkupRule").spec["x-tenant-tables"]).toEqual(
      expect.arrayContaining(["markup_rules", ...clearedBy, "staff_actions"]),
    );
  });
});

describe("storefront settings (api-changes part 2 §2.3; OADR-0012, OADR-0015)", () => {
  /** The sections of §2.3's sketch, in its order. */
  const SECTIONS = [
    "brand",
    "branding",
    "locales",
    "currencies",
    "markets",
    "features",
    "policies",
    "airlineCard",
    "legal",
    "support",
    "seo",
    "consent",
    "operations",
  ];
  const sectionSchema = (section: string): Json =>
    schemaOf(
      String(objectAt(schemaOf("StorefrontSettings"), "properties", section)["$ref"]).replace(
        "#/components/schemas/",
        "",
      ),
    );
  const update = (body: unknown) => problems("consoleUpdateStorefrontSettings", withBody(body, IF_MATCH));

  it("defines StorefrontSettings with the sections of §2.3, and an update that replaces whole sections [OBE-058 AC1]", () => {
    const settings = schemaOf("StorefrontSettings");
    expect(Object.keys(objectAt(settings, "properties"))).toEqual([...SECTIONS, "version", "updatedAt"]);
    expect(settings["required"]).toEqual([...SECTIONS, "version", "updatedAt"]);
    const fields: Record<string, string[]> = {
      brand: ["name", "legalName", "timeZone"],
      branding: [
        "logoAssetId",
        "logoDarkAssetId",
        "logoSquareAssetId",
        "faviconAssetId",
        "colors",
        "fonts",
        "cornerRadius",
      ],
      locales: ["default", "supported"],
      currencies: ["default", "supported"],
      markets: ["default", "list"],
      features: [
        "guestCheckout",
        "customerAccounts",
        "ancillaries",
        "brandedFareUpsell",
        "selfServiceCancellation",
      ],
      policies: [
        "ticketingPolicy",
        "paymentTiming",
        "require3ds",
        "acceptedCardBrands",
        "requireEmailVerification",
        "offerTtlMinutes",
        "checkoutTtlMinutes",
      ],
      airlineCard: ["enabledTest", "enabledLive"],
      legal: ["termsVersion", "privacyVersion", "links"],
      support: ["email", "phone", "hours", "helpCenterUrl", "emergencyPhone"],
      seo: ["titleTemplate", "defaultTitle", "defaultDescription", "ogImageAssetId", "robots"],
      consent: ["regime", "bannerRequired", "policyVersion", "categories"],
      operations: ["opsAlertEmail", "bookingQueue"],
    };
    for (const section of SECTIONS) {
      const schema = sectionSchema(section);
      expect([section, Object.keys(objectAt(schema, "properties"))]).toEqual([section, fields[section]]);
      // Sections travel in the PATCH body too: closed and complete.
      expect([section, schema["additionalProperties"], schema["required"]]).toEqual([
        section,
        false,
        fields[section],
      ]);
    }
    const branding = sectionSchema("branding");
    expect(Object.keys(objectAt(branding, "properties", "colors", "properties"))).toEqual([
      "primary",
      "secondary",
      "accent",
      "background",
      "text",
    ]);
    expect(objectAt(branding, "properties", "cornerRadius")["enum"]).toEqual([
      "none",
      "small",
      "medium",
      "large",
    ]);
    const policies = sectionSchema("policies");
    expect(objectAt(policies, "properties", "ticketingPolicy")["enum"]).toEqual([
      "issue_after_payment",
      "issue_at_booking",
      "manual_review",
    ]);
    expect(objectAt(policies, "properties", "offerTtlMinutes")).toMatchObject({ minimum: 5, maximum: 240 });
    expect(objectAt(policies, "properties", "checkoutTtlMinutes")).toMatchObject({
      minimum: 5,
      maximum: 1440,
    });
    expect(String(objectAt(policies, "properties", "paymentTiming")["description"])).toContain(
      "The MVP offers `authorize_before_booking` only",
    );

    // The update: any non-empty set of sections, each replacing its section.
    const body = schemaOf("StorefrontSettingsUpdate");
    expect(body).toMatchObject({ additionalProperties: false, minProperties: 1 });
    expect(body["required"]).toBeUndefined();
    const { version, updatedAt, ...sections } = objectAt(settings, "properties");
    expect([version, updatedAt]).toEqual([expect.anything(), expect.anything()]);
    expect(objectAt(body, "properties")).toEqual(sections);
    expect(schemaOf("StorefrontSettingsUpdateResult")["allOf"]).toEqual([
      { $ref: "#/components/schemas/StorefrontSettings" },
      expect.objectContaining({
        required: ["warnings"],
        properties: { warnings: expect.objectContaining({ type: "array" }) },
      }),
    ]);

    for (const name of ["branding", "airlineCard"]) {
      expect([name, update(requestExample("consoleUpdateStorefrontSettings", name))]).toEqual([name, []]);
    }
    const settingsExample = componentExample("StorefrontSettingsExample");
    const { version: _version, updatedAt: _updatedAt, ...everySection } = settingsExample;
    expect(update(everySection)).toEqual([]);
    expect(update({})).toEqual([" minProperties"]);
    expect(update({ version: 8 })).toEqual(["/version additionalProperties"]);
    expect(update({ airlineCard: { enabledTest: true } })).toEqual(["/airlineCard/enabledLive required"]);
    expect(update({ policies: { ...objectAt(settingsExample, "policies"), offerTtlMinutes: 300 } })).toEqual([
      "/policies/offerTtlMinutes maximum",
    ]);
    expect(
      update({
        branding: { ...objectAt(settingsExample, "branding"), colors: { primary: "#0B5FFF" } },
      }),
    ).toEqual(
      expect.arrayContaining(["/branding/colors/secondary required", "/branding/colors/text required"]),
    );
    // A legal link names an external https page or a content page, never both.
    const legal = objectAt(settingsExample, "legal");
    expect(
      update({
        legal: {
          ...legal,
          links: [{ kind: "terms", label: "Terms", url: "https://a.example/t", pageSlug: "terms" }],
        },
      }),
    ).toEqual(expect.arrayContaining(["/legal/links/0 oneOf"]));
    expect(
      update({ legal: { ...legal, links: [{ kind: "terms", label: "Terms", url: "http://a.example/t" }] } }),
    ).toEqual(expect.arrayContaining(["/legal/links/0 oneOf"]));

    expect(checker.check("consoleGetStorefrontSettings", { status: 200, body: settingsExample })).toEqual([]);
    const result = componentExample("StorefrontSettingsUpdateResultExample");
    expect(checker.check("consoleUpdateStorefrontSettings", { status: 200, body: result })).toEqual([]);
    expect(result["warnings"]).toEqual([expect.objectContaining({ code: "airline_card_net_price" })]);
    const { warnings, ...withoutWarnings } = result;
    expect(warnings).toBeDefined();
    expect(checker.check("consoleUpdateStorefrontSettings", { status: 200, body: withoutWarnings })).toEqual([
      expect.objectContaining({ keyword: "required" }),
    ]);
  });

  it("refuses airlineCard.enabledLive with FEATURE_DISABLED and invalid settings with 422 UNPROCESSABLE [OBE-058 AC1]", () => {
    const spec = operation("consoleUpdateStorefrontSettings").spec;
    expect(spec["x-error-codes"]).toEqual(
      expect.arrayContaining(["FEATURE_DISABLED", "UNPROCESSABLE", "PRECONDITION_FAILED"]),
    );
    expect(objectAt(spec, "responses", "403")).toEqual({
      $ref: "#/components/responses/StorefrontSettingsForbidden",
    });
    expect(objectAt(spec, "responses", "422")).toEqual({
      $ref: "#/components/responses/SettingsUnprocessable",
    });
    const description = String(spec["description"]);
    expect(description).toContain("`AIRLINE_CARD_ENABLED`");
    expect(description).toContain("`reference.currencies`");
    expect(description).toContain("`422 UNPROCESSABLE`");
    expect(description).toContain("`airline_card_net_price`");
    for (const [response, status] of [
      ["StorefrontSettingsForbidden", 403],
      ["SettingsUnprocessable", 422],
    ] as const) {
      const examples = objectAt(
        working,
        "components",
        "responses",
        response,
        "content",
        "application/json",
        "examples",
      );
      for (const [name, example] of Object.entries(examples)) {
        const body = objectAt(example, "value");
        expect([response, name, checker.check("consoleUpdateStorefrontSettings", { status, body })]).toEqual([
          response,
          name,
          [],
        ]);
      }
    }
    expect(
      objectAt(
        working,
        "components",
        "responses",
        "StorefrontSettingsForbidden",
        "content",
        "application/json",
        "examples",
        "FEATURE_DISABLED",
        "value",
        "error",
        "details",
      ),
    ).toEqual({ feature: "airlineCard" });
  });

  it("makes branding.fonts an enum equal to the fonts the storefront bundles [OBE-058 AC2]", () => {
    const fonts = objectAt(sectionSchema("branding"), "properties", "fonts");
    expect(objectAt(fonts, "properties")).toEqual({
      heading: { $ref: "#/components/schemas/StorefrontFontFamily" },
      body: { $ref: "#/components/schemas/StorefrontFontFamily" },
    });
    const families = schemaOf("StorefrontFontFamily")["enum"] as string[];
    expect(new Set(families).size).toBe(families.length);

    expect(existsSync(STOREFRONT_FONTS_CSS)).toBe(true);
    const declared = fontFaceFamilies(readFileSync(STOREFRONT_FONTS_CSS, "utf8"));
    // Until OFE-020 bundles the fonts, fonts.css declares none and the reference list is BUNDLED_FONTS.
    expect([...families].sort()).toEqual([...(declared.length > 0 ? declared : BUNDLED_FONTS)].sort());
    expect(
      fontFaceFamilies('@font-face { font-family: "Source Sans 3"; src: url("/fonts/x.woff2"); }'),
    ).toEqual(["Source Sans 3"]);

    // The generated type is the union of the names (this compiles only while "Inter" is one of them).
    const font: components["schemas"]["StorefrontFontFamily"] = "Inter";
    expect(families).toContain(font);
    // A font outside the list fails the request validation.
    const branding = objectAt(componentExample("StorefrontSettingsExample"), "branding");
    expect(
      problems(
        "consoleUpdateStorefrontSettings",
        withBody({ branding: { ...branding, fonts: { heading: "Comic Sans MS", body: "Inter" } } }, IF_MATCH),
      ),
    ).toEqual(["/branding/fonts/heading enum"]);
  });
});

describe("notification templates (api-changes part 2 §2.6; OADR-0013)", () => {
  it("defines NotificationTemplate with the MVP keys of §2.6, which the code's registry knows [OBE-058 AC1]", () => {
    const keys = schemaOf("NotificationTemplateKey")["enum"];
    expect(keys).toEqual(SPEC_TEMPLATE_KEYS);
    expect(keys).toEqual([...TEMPLATE_KEYS]);
    expect(schemaOf("NotificationChannel")["enum"]).toEqual(["email"]);
    const template = schemaOf("NotificationTemplate");
    expect(template["required"]).toEqual([
      "key",
      "channel",
      "locale",
      "subject",
      "bodyHtml",
      "bodyText",
      "variables",
      "customised",
      "isActive",
      "version",
      "updatedAt",
    ]);
    expect(objectAt(template, "properties", "variables", "items")).toEqual({
      $ref: "#/components/schemas/NotificationTemplateVariable",
    });
    expect(schemaOf("NotificationTemplateVariable")["required"]).toEqual(["name", "description"]);

    // The examples use only variables of their key's allow-list.
    for (const name of [
      "NotificationTemplateExample",
      "NotificationTemplateDefaultExample",
      "NotificationTemplateListExample",
    ]) {
      const value = componentExample(name);
      const templates = (Array.isArray(value["data"]) ? value["data"] : [value]) as Json[];
      for (const entry of templates) {
        const allowed = TEMPLATE_REGISTRY[entry["key"] as (typeof TEMPLATE_KEYS)[number]].variables.map(
          (variable) => variable.name,
        );
        const used = [
          ...`${String(entry["subject"])} ${String(entry["bodyHtml"])} ${String(entry["bodyText"])}`.matchAll(
            /\{\{\s*([a-zA-Z.]+)\s*\}\}/g,
          ),
        ].map((match) => match[1]);
        expect([name, entry["key"], used.filter((variable) => !allowed.includes(String(variable)))]).toEqual([
          name,
          entry["key"],
          [],
        ]);
        for (const variable of entry["variables"] as Json[]) {
          expect([name, variable["name"], allowed.includes(String(variable["name"]))]).toEqual([
            name,
            variable["name"],
            true,
          ]);
        }
      }
    }
    expect(
      checker.check("consoleGetNotificationTemplate", {
        status: 200,
        body: componentExample("NotificationTemplateExample"),
      }),
    ).toEqual([]);
    expect(
      checker.check("consoleResetNotificationTemplate", {
        status: 200,
        body: componentExample("NotificationTemplateDefaultExample"),
      }),
    ).toEqual([]);
    expect(
      checker.check("consoleListNotificationTemplates", {
        status: 200,
        body: componentExample("NotificationTemplateListExample"),
      }),
    ).toEqual([]);
  });

  it("validates put and preview bodies and the template path, and answers 422 TEMPLATE_INVALID with details.errors [OBE-058 AC1]", () => {
    expect(schemaOf("NotificationTemplateInput")).toMatchObject({
      additionalProperties: false,
      required: ["subject", "bodyHtml", "bodyText"],
    });
    expect(schemaOf("NotificationTemplatePreviewRequest")["required"]).toBeUndefined();
    expect(schemaOf("NotificationTemplatePreview")["required"]).toEqual(["subject", "html", "text"]);

    const put = (body: unknown, params: Json = TEMPLATE_PARAMS) =>
      problems("consolePutNotificationTemplate", { params, ...withBody(body) });
    const confirmed = requestExample("consolePutNotificationTemplate", "confirmed") as Json;
    expect(put(confirmed)).toEqual([]);
    expect(put({ ...confirmed, variables: [] })).toEqual(["/variables additionalProperties"]);
    const { bodyText, ...withoutText } = confirmed;
    expect(bodyText).toBeDefined();
    expect(put(withoutText)).toEqual(["/bodyText required"]);
    expect(put(confirmed, { ...TEMPLATE_PARAMS, templateKey: "booking.unknown" })).toEqual([
      "/path/templateKey enum",
    ]);
    expect(put(confirmed, { ...TEMPLATE_PARAMS, channel: "sms" })).toEqual(["/path/channel enum"]);
    expect(put(confirmed, { ...TEMPLATE_PARAMS, locale: "english" })).toEqual(["/path/locale pattern"]);

    const preview = (body: unknown) =>
      problems("consolePreviewNotificationTemplate", { params: TEMPLATE_PARAMS, ...withBody(body) });
    for (const name of ["stored", "draft"]) {
      expect([name, preview(requestExample("consolePreviewNotificationTemplate", name))]).toEqual([name, []]);
    }
    expect(problems("consolePreviewNotificationTemplate", { params: TEMPLATE_PARAMS })).toEqual([]);
    expect(problems("consoleResetNotificationTemplate", { params: TEMPLATE_PARAMS })).toEqual([]);

    for (const operationId of ["consolePutNotificationTemplate", "consolePreviewNotificationTemplate"]) {
      const spec = operation(operationId).spec;
      expect([operationId, spec["x-error-codes"]]).toEqual([
        operationId,
        expect.arrayContaining(["TEMPLATE_INVALID"]),
      ]);
      expect([operationId, objectAt(spec, "responses", "422")]).toEqual([
        operationId,
        { $ref: "#/components/responses/TemplateUnprocessable" },
      ]);
    }
    const invalid = objectAt(
      working,
      "components",
      "responses",
      "TemplateUnprocessable",
      "content",
      "application/json",
      "examples",
      "TEMPLATE_INVALID",
      "value",
    );
    expect(checker.check("consolePutNotificationTemplate", { status: 422, body: invalid })).toEqual([]);
    const errors = objectAt(invalid, "error", "details")["errors"] as Json[];
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(Object.keys(error).sort()).toEqual(["line", "message", "part"]);
      expect(["subject", "bodyHtml", "bodyText"]).toContain(error["part"]);
    }
  });
});
