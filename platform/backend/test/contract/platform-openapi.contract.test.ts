// Contract tests of the platform OpenAPI document, openapi/velexis-platform-api.openapi.yaml (ADR-0006, PADR-0016).
//
// PBE-005 wrote its first slice (identity, plans, internal: 24 operations, the conventions and the error catalogue).
// The tests of that slice name its operations by operationId and never count the document, so the later slices
// (PBE-006, PBE-007, PBE-066, PBE-037, PBE-041, PBE-042) only add operations. The convention checks run on every
// operation of the document: x-scope, X-Request-Id on every response, x-platform-tables, Idempotency-Key exactly on
// x-idempotent operations, closed request bodies, `Cache-Control: no-store` on secret-bearing responses, error
// examples that agree with x-error-codes and the catalogue, and examples that validate with the Ajv checker of
// @velexis/testing that the integration tests use. `pnpm contracts:lint` (Redocly, X-007) and the generators' tests
// (X-008, X-009) cover the lint and the generated files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { platformOperations, type PlatformOperationId } from "@velexis/api-types/operations";
import { ERROR_CATALOGUE, PLATFORM_ERROR_CODES, type PlatformErrorCode } from "@velexis/errors";
import { createResponseChecker, type ResponseChecker } from "@velexis/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_DIR } from "../../src/config";
import { HealthService } from "../../src/health/health.service";

const REPO_ROOT = join(APP_DIR, "..", "..");
const PLATFORM_DOCUMENT = join(APP_DIR, "openapi", "velexis-platform-api.openapi.yaml");
const OTA_DOCUMENT = join(REPO_ROOT, "ota", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");
const INVENTORY = join(REPO_ROOT, "platform", "docs", "api-inventory.md");
const INVENTORY_ADMIN = join(REPO_ROOT, "platform", "docs", "api-inventory-admin.md");

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** The `x-scope` values of the platform document (PADR-0009 item 1, api-inventory §2). */
const SCOPES = ["public", "portal_unverified", "portal", "platform_admin", "internal", "webhook"] as const;

/** Response properties that hold a secret: a 2xx response with one must document `Cache-Control: no-store`. */
const SECRET_PROPERTIES = new Set([
  "accessToken",
  "refreshToken",
  "mfaChallengeToken",
  "portalToken",
  "secret",
  "otpauthUrl",
  "recoveryCodes",
]);

type Json = Record<string, unknown>;

interface Operation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly spec: Json;
}

/** One slice operation as the operations index lists it. */
interface SliceOperation {
  readonly operationId: PlatformOperationId;
  readonly method: string;
  readonly path: string;
  readonly scope: (typeof SCOPES)[number];
  readonly internal: boolean;
}

/**
 * The PBE-005 slice: api-inventory §4 (auth, 11), §5 (account, 9), §6 (`listPlans`) and api-inventory-admin §9
 * (`tlsAsk`, `healthLive`, `healthReady`). The `PlatformOperationId` type makes a misspelt id fail to compile.
 */
const SLICE: readonly SliceOperation[] = [
  { operationId: "signUp", method: "post", path: "/v1/auth/sign-up", scope: "public", internal: false },
  {
    operationId: "verifyEmail",
    method: "post",
    path: "/v1/auth/verify-email",
    scope: "public",
    internal: false,
  },
  {
    operationId: "resendVerification",
    method: "post",
    path: "/v1/auth/resend-verification",
    scope: "public",
    internal: false,
  },
  { operationId: "signIn", method: "post", path: "/v1/auth/sign-in", scope: "public", internal: false },
  { operationId: "verifyMfa", method: "post", path: "/v1/auth/mfa/verify", scope: "public", internal: false },
  {
    operationId: "refreshSession",
    method: "post",
    path: "/v1/auth/refresh",
    scope: "public",
    internal: false,
  },
  {
    operationId: "signOut",
    method: "post",
    path: "/v1/auth/sign-out",
    scope: "portal_unverified",
    internal: false,
  },
  {
    operationId: "signOutEverywhere",
    method: "post",
    path: "/v1/auth/sign-out-everywhere",
    scope: "portal_unverified",
    internal: false,
  },
  {
    operationId: "requestPasswordReset",
    method: "post",
    path: "/v1/auth/password-reset",
    scope: "public",
    internal: false,
  },
  {
    operationId: "confirmPasswordReset",
    method: "post",
    path: "/v1/auth/password-reset/confirm",
    scope: "public",
    internal: false,
  },
  { operationId: "stepUp", method: "post", path: "/v1/auth/step-up", scope: "portal", internal: false },
  { operationId: "getMe", method: "get", path: "/v1/me", scope: "portal_unverified", internal: false },
  { operationId: "updateMe", method: "patch", path: "/v1/me", scope: "portal_unverified", internal: false },
  {
    operationId: "changePassword",
    method: "post",
    path: "/v1/me/password",
    scope: "portal",
    internal: false,
  },
  {
    operationId: "startMfaSetup",
    method: "post",
    path: "/v1/me/mfa/setup",
    scope: "portal_unverified",
    internal: false,
  },
  {
    operationId: "enableMfa",
    method: "post",
    path: "/v1/me/mfa/enable",
    scope: "portal_unverified",
    internal: false,
  },
  { operationId: "disableMfa", method: "post", path: "/v1/me/mfa/disable", scope: "portal", internal: false },
  {
    operationId: "regenerateRecoveryCodes",
    method: "post",
    path: "/v1/me/mfa/recovery-codes",
    scope: "portal",
    internal: false,
  },
  {
    operationId: "listSessions",
    method: "get",
    path: "/v1/me/sessions",
    scope: "portal_unverified",
    internal: false,
  },
  {
    operationId: "revokeSession",
    method: "delete",
    path: "/v1/me/sessions/{familyId}",
    scope: "portal_unverified",
    internal: false,
  },
  { operationId: "listPlans", method: "get", path: "/v1/plans", scope: "public", internal: false },
  { operationId: "tlsAsk", method: "get", path: "/internal/tls/ask", scope: "internal", internal: true },
  { operationId: "healthLive", method: "get", path: "/health/live", scope: "public", internal: true },
  { operationId: "healthReady", method: "get", path: "/health/ready", scope: "internal", internal: true },
];

/** The slice operations whose 2xx answer carries a secret and so documents `Cache-Control: no-store`. */
const SLICE_NO_STORE = [
  "signIn",
  "verifyMfa",
  "refreshSession",
  "stepUp",
  "startMfaSetup",
  "enableMfa",
  "regenerateRecoveryCodes",
] as const satisfies readonly PlatformOperationId[];

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readYaml(file: string): Json {
  const document: unknown = parse(readFileSync(file, "utf8"));
  if (!isObject(document)) {
    throw new Error(`${file} is not a YAML mapping`);
  }
  return document;
}

function objectAt(value: unknown, key: string): Json {
  const child = isObject(value) ? value[key] : undefined;
  return isObject(child) ? child : {};
}

/** The value of a local `$ref` (`#/components/…`), following chained references. */
function resolve(document: Json, value: unknown): unknown {
  let current = value;
  for (let depth = 0; isObject(current) && typeof current["$ref"] === "string"; depth += 1) {
    if (depth > 10) {
      throw new Error(`$ref cycle at ${String(current["$ref"])}`);
    }
    const ref = current["$ref"];
    if (!ref.startsWith("#/")) {
      throw new Error(`non-local $ref ${ref}`);
    }
    current = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((node, segment) => (isObject(node) ? node[segment] : undefined), document);
    if (current === undefined) {
      throw new Error(`unresolved $ref ${ref}`);
    }
  }
  return current;
}

function operationsOf(document: Json): Operation[] {
  return Object.entries(objectAt(document, "paths")).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const spec = isObject(item) ? item[method] : undefined;
      return isObject(spec) ? [{ operationId: String(spec["operationId"]), method, path, spec }] : [];
    }),
  );
}

/** The responses of an operation, `$ref`s resolved: `[status, response]`. */
function responsesOf(document: Json, operation: Operation): Array<[string, Json]> {
  return Object.entries(objectAt(operation.spec, "responses")).map(([status, response]) => {
    const resolved = resolve(document, response);
    return [status, isObject(resolved) ? resolved : {}];
  });
}

/** Every example body of a media type (`example`, or each of `examples` with `$ref`s resolved). */
function examplesOf(document: Json, media: Json): unknown[] {
  if ("example" in media) {
    return [media["example"]];
  }
  return Object.values(objectAt(media, "examples")).map((example) => {
    const resolved = resolve(document, example);
    return isObject(resolved) ? resolved["value"] : undefined;
  });
}

function jsonMedia(response: Json): Json | undefined {
  const media = objectAt(response, "content")["application/json"];
  return isObject(media) ? media : undefined;
}

/** True when a request schema accepts no unknown property: closed objects, or a oneOf/anyOf of closed objects. */
function isClosed(document: Json, schema: unknown): boolean {
  const resolved = resolve(document, schema);
  if (!isObject(resolved)) {
    return false;
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    const branches = resolved[keyword];
    if (Array.isArray(branches)) {
      return branches.length > 0 && branches.every((branch) => isClosed(document, branch));
    }
  }
  return resolved["type"] === "object" && resolved["additionalProperties"] === false;
}

/** Every property name a schema can answer, through `$ref`s, compositions, nested objects and arrays. */
function propertyNames(
  document: Json,
  schema: unknown,
  found = new Set<string>(),
  seen = new Set<unknown>(),
) {
  const resolved = resolve(document, schema);
  if (!isObject(resolved) || seen.has(resolved)) {
    return found;
  }
  seen.add(resolved);
  for (const [name, child] of Object.entries(objectAt(resolved, "properties"))) {
    found.add(name);
    propertyNames(document, child, found, seen);
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    const branches = resolved[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch) => propertyNames(document, branch, found, seen));
    }
  }
  for (const keyword of ["items", "additionalProperties"]) {
    if (isObject(resolved[keyword])) {
      propertyNames(document, resolved[keyword], found, seen);
    }
  }
  return found;
}

/** Schema annotations, left out when the shapes of the two documents are compared. */
const ANNOTATIONS = new Set(["description", "examples", "example", "additionalProperties"]);

/** A schema without its annotations, at any depth; `$ref`s stay as they are. */
function shape(schema: unknown): unknown {
  return JSON.parse(
    JSON.stringify(schema, (key, value: unknown) => (ANNOTATIONS.has(key) ? undefined : value)),
  );
}

/** The rows of a Markdown table section of the inventory, keyed by the operationId of the first cell. */
function inventoryRows(file: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const id = /^`([a-z][A-Za-z]+)`$/.exec(cells[1] ?? "")?.[1];
    if (id !== undefined && cells.length > 4) {
      rows.set(id, cells.slice(1, -1));
    }
  }
  return rows;
}

/** The error catalogue of api-inventory §3: code -> status. */
function inventoryCatalogue(): Map<string, number> {
  const text = readFileSync(INVENTORY, "utf8");
  const section = text.slice(text.indexOf("## 3. Error catalogue"), text.indexOf("## 4. "));
  const codes = new Map<string, number>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const status = Number(cells[2]);
    if (Number.isInteger(status) && status >= 400) {
      for (const [, code] of (cells[1] ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
        codes.set(code ?? "", status);
      }
    }
  }
  return codes;
}

let platform: Json;
let ota: Json;
let operations: Operation[];
let checker: ResponseChecker;

beforeAll(() => {
  platform = readYaml(PLATFORM_DOCUMENT);
  ota = readYaml(OTA_DOCUMENT);
  operations = operationsOf(platform);
  checker = createResponseChecker(structuredClone(platform), { label: "platform" });
});

function operation(operationId: string): Operation {
  const found = operations.find((candidate) => candidate.operationId === operationId);
  if (found === undefined) {
    throw new Error(`the platform document has no operation ${operationId}`);
  }
  return found;
}

describe("the identity, plans and internal slice (PBE-005)", () => {
  it("lists the 24 operations of the slice in the operations index, each with its scope [PBE-005 AC2]", () => {
    expect(SLICE).toHaveLength(24);
    expect(new Set(SLICE.map((entry) => entry.operationId)).size).toBe(24);
    for (const entry of SLICE) {
      expect(platformOperations).toContainEqual(expect.objectContaining({ ...entry, sdkMethod: null }));
    }
    for (const entry of platformOperations) {
      expect(SCOPES).toContain(entry.scope);
    }
    // The index is generated from the document: both list the same operations in the same order.
    expect(platformOperations.map((entry) => entry.operationId)).toEqual(
      operations.map((entry) => entry.operationId),
    );
  });

  it("puts REAUTH_REQUIRED, TENANT_KEY_UNAVAILABLE and LIVE_PRECONDITIONS_UNMET in PlatformErrorCode [PBE-005 AC2]", () => {
    // Compiles only while the three codes are members of the generated union.
    const required: readonly PlatformErrorCode[] = [
      "REAUTH_REQUIRED",
      "TENANT_KEY_UNAVAILABLE",
      "LIVE_PRECONDITIONS_UNMET",
    ];
    expect(PLATFORM_ERROR_CODES).toEqual(expect.arrayContaining([...required]));
    expect(required.map((code) => [ERROR_CATALOGUE[code].status, ERROR_CATALOGUE[code].source])).toEqual([
      [401, "platform"],
      [409, "platform"],
      [422, "platform"],
    ]);
  });

  it("documents each slice operation with the method, path, scope and flags of the API inventory", () => {
    const rows = new Map([...inventoryRows(INVENTORY), ...inventoryRows(INVENTORY_ADMIN)]);
    for (const entry of SLICE) {
      const row = rows.get(entry.operationId);
      expect(row, entry.operationId).toBeDefined();
      const [, route = "", auth = ""] = row ?? [];
      const [method = "", path = ""] = route.replaceAll("`", "").split(" ");
      expect([entry.method, entry.path], entry.operationId).toEqual([
        method.toLowerCase(),
        path.split("?")[0],
      ]);

      const marks = auth.replaceAll("`", "").split(/,\s*/);
      const scope = marks.includes("portal*")
        ? "portal_unverified"
        : marks.find((mark) => (SCOPES as readonly string[]).includes(mark));
      const spec = operation(entry.operationId).spec;
      expect([spec["x-scope"], entry.scope], entry.operationId).toEqual([scope, scope]);
      expect(spec["x-mfa-step-up"] === true, `${entry.operationId} x-mfa-step-up`).toBe(
        marks.includes("MFA↑"),
      );
      expect(spec["x-idempotent"] === true, `${entry.operationId} x-idempotent`).toBe(marks.includes("Idem"));
      expect("x-feature" in spec, `${entry.operationId} x-feature`).toBe(
        marks.some((mark) => mark.startsWith("F:")),
      );
      expect(spec["x-reason-required"], `${entry.operationId} x-reason-required`).toBeUndefined();
      expect(spec["x-internal"] === true, `${entry.operationId} x-internal`).toBe(entry.internal);
    }
  });

  it("documents Cache-Control: no-store on the slice answers that carry tokens, the TOTP secret or recovery codes", () => {
    const noStore = SLICE.filter((entry) =>
      responsesOf(platform, operation(entry.operationId)).some(
        ([status, response]) =>
          status.startsWith("2") &&
          objectAt(objectAt(response, "headers"), "Cache-Control")["$ref"] === "#/components/headers/NoStore",
      ),
    ).map((entry) => entry.operationId);
    expect(noStore).toEqual([...SLICE_NO_STORE]);
  });

  it("documents the health answers that HealthService gives today", async () => {
    const up = new HealthService(
      { query: () => Promise.resolve({}) },
      { ping: () => Promise.resolve("PONG") },
    );
    const redisDown = new HealthService(
      { query: () => Promise.resolve({}) },
      { ping: () => Promise.reject(new Error("connection refused")) },
    );
    const ready = (await up.ready()).report;
    const unavailable = (await redisDown.ready()).report;

    expect(checker.check("healthLive", { status: 200, body: up.live() })).toEqual([]);
    expect(checker.check("healthReady", { status: 200, body: ready })).toEqual([]);
    expect(checker.check("healthReady", { status: 503, body: unavailable })).toEqual([]);
    expect(unavailable.checks.redis).toBe("down");
  });
});

describe("the error catalogue", () => {
  it("lists every code of api-inventory §3 with its status", () => {
    const catalogue = objectAt(platform, "x-error-catalogue");
    const inventory = inventoryCatalogue();
    expect(inventory.size).toBeGreaterThanOrEqual(52);
    for (const [code, status] of inventory) {
      expect([code, objectAt(catalogue, code)["status"]]).toEqual([code, status]);
    }
  });

  it("lists no code that api-inventory §3 does not list", () => {
    // A new code goes into api-inventory §3 and the document in the same task (openapi/README.md §5).
    const inventory = inventoryCatalogue();
    const missing = Object.keys(objectAt(platform, "x-error-catalogue")).filter(
      (code) => !inventory.has(code),
    );
    expect(missing).toEqual([]);
  });

  it("gives a code of both catalogues the OTA status, and every code a message", () => {
    const catalogue = objectAt(platform, "x-error-catalogue");
    const otaCatalogue = objectAt(ota, "x-error-catalogue");
    for (const [code, entry] of Object.entries(catalogue)) {
      expect(
        isObject(entry) && typeof entry["description"] === "string" && entry["description"].length > 0,
      ).toBe(true);
      if (code in otaCatalogue) {
        expect([code, objectAt(catalogue, code)["status"]]).toEqual([
          code,
          objectAt(otaCatalogue, code)["status"],
        ]);
      }
    }
  });

  it("uses the error envelope and the money of the OTA document, without the console-only supplier field", () => {
    const schemas = objectAt(objectAt(platform, "components"), "schemas");
    const otaSchemas = objectAt(objectAt(ota, "components"), "schemas");
    const otaError = objectAt(otaSchemas, "Error");
    const { supplier, ...otaErrorProperties } = objectAt(otaError, "properties");

    expect(supplier).toBeDefined();
    expect(shape(schemas["Error"])).toEqual(shape({ ...otaError, properties: otaErrorProperties }));
    for (const name of ["ErrorResponse", "FieldError", "Money"]) {
      expect([name, shape(schemas[name])]).toEqual([name, shape(otaSchemas[name])]);
    }
    // The platform closes them: a body with a field outside the envelope does not match.
    for (const name of ["ErrorResponse", "Error", "FieldError", "Money"]) {
      expect([name, objectAt(schemas, name)["additionalProperties"]]).toEqual([name, false]);
    }
  });
});

describe("the conventions of every operation", () => {
  it("gives every operation an x-scope of the platform list and marks internal and webhook ones x-internal", () => {
    for (const { operationId, spec } of operations) {
      expect([operationId, (SCOPES as readonly unknown[]).includes(spec["x-scope"])]).toEqual([
        operationId,
        true,
      ]);
      if (spec["x-scope"] === "internal" || spec["x-scope"] === "webhook") {
        expect([operationId, spec["x-internal"]]).toEqual([operationId, true]);
      }
      if (spec["x-scope"] === "public" || spec["x-scope"] === "internal" || spec["x-scope"] === "webhook") {
        expect([operationId, spec["security"]]).toEqual([operationId, []]);
      }
    }
  });

  it("documents X-Request-Id on every response and lists x-platform-tables on every operation", () => {
    for (const op of operations) {
      const tables: unknown = op.spec["x-platform-tables"];
      const listed =
        Array.isArray(tables) &&
        tables.every((table: unknown) => typeof table === "string" && /^[a-z][a-z_]*$/.test(table));
      expect([op.operationId, listed]).toEqual([op.operationId, true]);
      for (const [status, response] of responsesOf(platform, op)) {
        const header = objectAt(objectAt(response, "headers"), "X-Request-Id");
        expect([op.operationId, status, header["$ref"]]).toEqual([
          op.operationId,
          status,
          "#/components/headers/X-Request-Id",
        ]);
      }
    }
  });

  it("takes the Idempotency-Key parameter exactly on the x-idempotent operations", () => {
    const reference = "#/components/parameters/IdempotencyKey";
    for (const op of operations) {
      const pathItem = objectAt(objectAt(platform, "paths"), op.path);
      const parameters = [pathItem["parameters"], op.spec["parameters"]].flatMap((list: unknown) =>
        Array.isArray(list) ? (list as unknown[]) : [],
      );
      const takesKey = parameters.some((parameter) => isObject(parameter) && parameter["$ref"] === reference);
      expect([op.operationId, takesKey]).toEqual([op.operationId, op.spec["x-idempotent"] === true]);
    }
  });

  it("closes every request body with additionalProperties: false", () => {
    for (const { operationId, spec } of operations) {
      const body = resolve(platform, spec["requestBody"]);
      if (body !== undefined) {
        const media = objectAt(objectAt(body, "content"), "application/json");
        expect([operationId, isClosed(platform, media["schema"])]).toEqual([operationId, true]);
      }
    }
  });

  it("documents Cache-Control: no-store on every 2xx answer that carries a secret", () => {
    for (const op of operations) {
      for (const [status, response] of responsesOf(platform, op)) {
        const media = jsonMedia(response);
        if (!status.startsWith("2") || media === undefined) {
          continue;
        }
        const secrets = [...propertyNames(platform, media["schema"])].filter((name) =>
          SECRET_PROPERTIES.has(name),
        );
        if (secrets.length > 0) {
          const header = resolve(platform, objectAt(response, "headers")["Cache-Control"]);
          expect([op.operationId, status, objectAt(header, "schema")["const"]]).toEqual([
            op.operationId,
            status,
            "no-store",
          ]);
        }
      }
    }
  });

  it("answers errors with catalogue codes of the response's status, exactly the codes of x-error-codes", () => {
    const catalogue = objectAt(platform, "x-error-catalogue");
    for (const op of operations) {
      const answered = new Set<string>();
      for (const [status, response] of responsesOf(platform, op)) {
        const media = jsonMedia(response);
        const schema = media?.["schema"];
        if (
          Number(status) < 400 ||
          !isObject(schema) ||
          schema["$ref"] !== "#/components/schemas/ErrorResponse"
        ) {
          continue;
        }
        const examples = examplesOf(platform, media ?? {});
        expect([op.operationId, status, examples.length > 0]).toEqual([op.operationId, status, true]);
        for (const example of examples) {
          const error = objectAt(example, "error");
          const code = String(error["code"]);
          answered.add(code);
          expect([op.operationId, code, error["status"], objectAt(catalogue, code)["status"]]).toEqual([
            op.operationId,
            code,
            Number(status),
            Number(status),
          ]);
        }
      }
      const listed = op.spec["x-error-codes"];
      expect([op.operationId, Array.isArray(listed)]).toEqual([op.operationId, true]);
      expect([op.operationId, [...answered].sort()]).toEqual([
        op.operationId,
        [...(listed as string[])].sort(),
      ]);
    }
  });

  it("validates every response example with the Ajv response checker of @velexis/testing", () => {
    let checked = 0;
    for (const op of operations) {
      for (const [status, response] of responsesOf(platform, op)) {
        const media = jsonMedia(response);
        for (const body of media === undefined ? [undefined] : examplesOf(platform, media)) {
          expect([
            op.operationId,
            status,
            checker.check(op.operationId, { status: Number(status), body }),
          ]).toEqual([op.operationId, status, []]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(operations.length);
  });

  it("refuses answers with an undocumented field, a number for money or an undocumented status", () => {
    const session = objectAt(resolve(platform, { $ref: "#/components/examples/PortalSession" }), "value");
    const leaky = { ...session, account: { ...objectAt(session, "account"), passwordHash: "not-a-hash" } };
    expect(checker.check("verifyMfa", { status: 200, body: leaky })).toEqual([
      expect.objectContaining({ path: "/account/passwordHash", keyword: "additionalProperties" }),
    ]);

    const [, ok = {}] =
      responsesOf(platform, operation("listPlans")).find(([status]) => status === "200") ?? [];
    const [plans] = examplesOf(platform, jsonMedia(ok) ?? {});
    const data = isObject(plans) ? plans["data"] : undefined;
    const plan = Array.isArray(data) && isObject(data[0]) ? data[0] : {};
    expect(plan).toMatchObject({ code: "early_access", monthlyPrice: { amount: "0.00" } });
    const numeric = { data: [{ ...plan, monthlyPrice: { amount: 49, currency: "EUR" } }] };
    expect(checker.check("listPlans", { status: 200, body: numeric })).toEqual([
      expect.objectContaining({ path: "/data/0/monthlyPrice/amount", keyword: "type" }),
    ]);

    expect(checker.check("getMe", { status: 418, body: {} })).toEqual([
      expect.objectContaining({ keyword: "status" }),
    ]);
  });
});
