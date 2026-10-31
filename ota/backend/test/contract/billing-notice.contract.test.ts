// Contract test of OBE-076: the billing notice of the console session (ota/docs/api-changes-console-and-internal.md
// §3.1) in the OTA document (openapi/velexis-ota-booking-api.openapi.yaml).
//
// `ConsoleTenant` gains the optional, nullable `billingNotice` (`past_due`, `trial_ending`), the banner state that the
// platform's billing sync keeps in `platform.tenants.billing_notice` (ADR-0013 point 7). `ConsoleTenant` is the
// `tenant` of `ConsoleStaffSession` (consoleSignIn, consoleRefreshSession) and of `ConsoleStaffProfile` (consoleGetMe),
// so all three answers carry it. The change is additive: the frozen copy under docs/velexis-sdk/openapi/ has no such
// field and every property of its `ConsoleTenant` is still there as it was. Answers are checked with the checker every
// integration test uses. OBE-082 fills the field; `pnpm contracts:lint` and the SDK's contract test (both sides read
// `ConsoleTenant` from the generated @velexis/api-types) cover the rest of the acceptance.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { components } from "@velexis/api-types";
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
const API_CHANGES = join(REPO_ROOT, "ota", "docs", "api-changes-console-and-internal.md");
const CHANGE_LOG = join(APP_DIR, "openapi", "README.md");

/** Parsing two 40,000-line documents and compiling the response validators take a few seconds on a busy runner. */
const DOCUMENT_TIMEOUT_MS = 60_000;

type Json = Record<string, unknown>;
type ConsoleTenant = components["schemas"]["ConsoleTenant"];
type BillingNotice = ConsoleTenant["billingNotice"];

/** The values of api-changes part 2 §3.1, as `platform.tenants.billing_notice` allows them. */
const NOTICES = ["past_due", "trial_ending"] as const satisfies readonly NonNullable<BillingNotice>[];

/** The three answers that carry a `ConsoleTenant`: sign-in, refresh (`ConsoleStaffSession`) and me (`ConsoleStaffProfile`). */
const SESSION_ANSWERS = [
  { operationId: "consoleSignIn", schema: "ConsoleStaffSession" },
  { operationId: "consoleRefreshSession", schema: "ConsoleStaffSession" },
  { operationId: "consoleGetMe", schema: "ConsoleStaffProfile" },
] as const;

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

let working: Json;
let frozen: Json;
let checker: ResponseChecker;

beforeAll(() => {
  working = readYaml(WORKING_DOCUMENT);
  frozen = readYaml(FROZEN_DOCUMENT);
  checker = responseChecker("ota");
  // Compiles the validators of the three operations here, not in the first test that checks an answer.
  for (const { operationId } of SESSION_ANSWERS) {
    checker.check(operationId, { status: 200, body: {} });
  }
}, DOCUMENT_TIMEOUT_MS);

const schemaOf = (document: Json, name: string): Json => objectAt(document, "components", "schemas", name);

/** The 200 answer's example of an operation of the working document, `$ref` resolved. */
function exampleOf(operationId: string): Json {
  for (const item of Object.values(objectAt(working, "paths"))) {
    for (const spec of Object.values(isObject(item) ? item : {})) {
      if (!isObject(spec) || spec["operationId"] !== operationId) {
        continue;
      }
      const examples = objectAt(spec, "responses", "200", "content", "application/json", "examples");
      const first = Object.values(examples)[0];
      const ref = isObject(first) ? first["$ref"] : undefined;
      const value =
        typeof ref === "string"
          ? objectAt(working, "components", "examples", ref.replace("#/components/examples/", ""))["value"]
          : isObject(first)
            ? first["value"]
            : undefined;
      if (!isObject(value)) {
        throw new Error(`${operationId} 200 has no example`);
      }
      return structuredClone(value);
    }
  }
  throw new Error(`the OTA document has no operation ${operationId}`);
}

/** An answer of `operationId` whose tenant has `billingNotice` set to `notice`, or left out for `undefined`. */
function answerWith(operationId: string, notice: unknown): Json {
  const body = exampleOf(operationId);
  const tenant = objectAt(body, "tenant");
  delete tenant["billingNotice"];
  if (notice !== undefined) {
    tenant["billingNotice"] = notice;
  }
  return body;
}

describe("ConsoleTenant.billingNotice (api-changes-console-and-internal §3.1)", () => {
  it("adds billingNotice to ConsoleTenant as an optional string or null of past_due and trial_ending [OBE-076 AC1]", () => {
    const tenant = schemaOf(working, "ConsoleTenant");
    expect(objectAt(tenant, "properties", "billingNotice")).toMatchObject({
      type: ["string", "null"],
      enum: [...NOTICES, null],
    });
    expect(tenant["required"]).not.toContain("billingNotice");
    const description = String(objectAt(tenant, "properties", "billingNotice")["description"]);
    for (const words of ["platform.tenants.billing_notice", "past_due", "trial_ending", "TENANT_SUSPENDED"]) {
      expect([words, description.includes(words)]).toEqual([words, true]);
    }
    // Compiles only while the generated property is optional and takes exactly the two values and null.
    const optional: Record<string, never> extends Pick<ConsoleTenant, "billingNotice"> ? true : false = true;
    const onlyTheseValues: [Exclude<NonNullable<BillingNotice>, (typeof NOTICES)[number]>] extends [never]
      ? true
      : false = true;
    const none: BillingNotice = null;
    expect([optional, onlyTheseValues, none]).toEqual([true, true, null]);
  });

  it("reaches the tenant of ConsoleStaffSession (sign-in, refresh) and ConsoleStaffProfile (me) [OBE-076 AC1]", () => {
    for (const { operationId, schema } of SESSION_ANSWERS) {
      const parent = schemaOf(working, schema);
      expect([operationId, objectAt(parent, "properties", "tenant")["$ref"]]).toEqual([
        operationId,
        "#/components/schemas/ConsoleTenant",
      ]);
      expect([operationId, parent["required"]]).toEqual([operationId, expect.arrayContaining(["tenant"])]);
    }
    expect(String(schemaOf(working, "ConsoleStaffSession")["description"])).toContain("tenant.billingNotice");
  });

  it("is additive: the frozen ConsoleTenant lacks it, and its properties and required list are unchanged [OBE-076 AC1]", () => {
    const original = schemaOf(frozen, "ConsoleTenant");
    const current = schemaOf(working, "ConsoleTenant");
    const originalProperties = objectAt(original, "properties");
    const currentProperties = objectAt(current, "properties");
    expect(Object.keys(originalProperties)).not.toContain("billingNotice");
    expect(Object.keys(originalProperties).length).toBeGreaterThan(0);
    for (const [name, property] of Object.entries(originalProperties)) {
      expect([name, currentProperties[name]]).toEqual([name, property]);
    }
    expect(current["required"]).toEqual(original["required"]);
  });

  it("accepts sign-in, refresh and me answers with each notice, null or none, and refuses any other value [OBE-076 AC1]", () => {
    for (const { operationId } of SESSION_ANSWERS) {
      // The examples show the common case: no banner.
      expect([operationId, objectAt(exampleOf(operationId), "tenant")["billingNotice"]]).toEqual([
        operationId,
        null,
      ]);
      for (const notice of [...NOTICES, null, undefined]) {
        const problems = checker.check(operationId, { status: 200, body: answerWith(operationId, notice) });
        expect([operationId, notice, problems]).toEqual([operationId, notice, []]);
      }
      for (const notice of ["overdue", "PAST_DUE", "", 1, false]) {
        const problems = checker.check(operationId, { status: 200, body: answerWith(operationId, notice) });
        expect([operationId, notice, problems.length > 0]).toEqual([operationId, notice, true]);
      }
    }
  });

  it("documents the field in api-changes part 2 §3.1 and the document's change log [OBE-076]", () => {
    const changes = readFileSync(API_CHANGES, "utf8");
    const section = changes.slice(changes.indexOf("### 3.1 "), changes.indexOf("## 4. "));
    expect(section).toContain("billingNotice");
    expect(section).toContain("`past_due`, `trial_ending`, `null`");
    const log = readFileSync(CHANGE_LOG, "utf8");
    expect(log.split("\n").filter((line) => line.startsWith("| OBE-076 | M5 |"))).toHaveLength(1);
  });
});
