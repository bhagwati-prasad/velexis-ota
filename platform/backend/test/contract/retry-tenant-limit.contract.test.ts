// The contract of the tenant limit on the owner's retry (FIX-W67-KI002, lead decision (36e) of 2026-11-21; known issue
// KI-002; scope PF-10 AC4): `retryProvisioning` answers createTenant's `422 UNPROCESSABLE` with `details.reason =
// tenant_limit`, the platform admin's `adminRetryProvisioningJob` says it is exempt, and the change log, the inventory
// and scope PF-10 say both. The document is read as YAML here; platform-openapi.contract.test.ts holds the rules every
// operation follows (error examples agree with `x-error-codes` and the catalogue, every example is valid).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createResponseChecker, type ResponseChecker } from "@velexis/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_DIR } from "../../src/config";

const PLATFORM_DOCUMENT = join(APP_DIR, "openapi", "velexis-platform-api.openapi.yaml");
const CONTRACT_README = join(APP_DIR, "openapi", "README.md");
const PLATFORM_DOCS = join(APP_DIR, "..", "docs");

type Json = Record<string, unknown>;

interface OperationObject {
  readonly operationId: string;
  readonly description: string;
  readonly "x-error-codes": readonly string[];
  readonly "x-platform-tables": readonly string[];
  readonly responses: Readonly<Record<string, Json>>;
}

let document: Json;
let checker: ResponseChecker;

/**
 * The budget of the setup hook: parsing the document and building its response checker take a second or two alone,
 * several times that under a full parallel `pnpm test` on four CPUs. It only stops a hook that hangs.
 */
const SETUP_TIMEOUT_MS = 60_000;

beforeAll(() => {
  document = parse(readFileSync(PLATFORM_DOCUMENT, "utf8")) as Json;
  checker = createResponseChecker(structuredClone(document), { label: "platform" });
  // Compile the two validators the tests use here, out of the tests' 5 s bound.
  checker.check("retryProvisioning", { status: 422, body: undefined });
  checker.check("createTenant", { status: 422, body: undefined });
}, SETUP_TIMEOUT_MS);

/** The operation `operationId` of the document. */
function operation(operationId: string): OperationObject {
  const paths = document["paths"] as Record<string, Record<string, unknown>>;
  for (const item of Object.values(paths)) {
    for (const value of Object.values(item)) {
      if (typeof value === "object" && value !== null && (value as Json)["operationId"] === operationId) {
        return value as OperationObject;
      }
    }
  }
  throw new Error(`the platform document has no operation ${operationId}`);
}

/** The inline example `name` of the JSON body of `response`. */
function exampleOf(response: Json, name: string): Json {
  const content = response["content"] as Record<string, { examples?: Record<string, { value?: Json }> }>;
  const value = content["application/json"]?.examples?.[name]?.value;
  if (value === undefined) {
    throw new Error(`no inline example ${name}`);
  }
  return value;
}

/** The tenant limit answer createTenant gives, with the limit (lifecycle.service.ts tenantLimitError). */
function tenantLimitBody(limit: number): Json {
  return {
    error: {
      code: "UNPROCESSABLE",
      message: "The request breaks a business rule.",
      status: 422,
      requestId: "req_01JB3K9R4T8W2Y6A0C4E8G2J6M",
      details: { reason: "tenant_limit", limit },
    },
  };
}

describe("the tenant limit on the owner's retry (FIX-W67-KI002)", () => {
  it("[FIX-W67-KI002 AC4] retryProvisioning declares createTenant's 422 UNPROCESSABLE tenant_limit, with an example and the accounts it locks", () => {
    const retry = operation("retryProvisioning");
    expect(retry["x-error-codes"]).toContain("UNPROCESSABLE");
    expect(retry["x-platform-tables"]).toContain("accounts");
    expect(retry.description).toMatch(/MAX_TENANTS_PER_ACCOUNT/);
    expect(retry.description).toMatch(/422\s+UNPROCESSABLE/);
    expect(retry.description).toMatch(/tenant_limit/);
    const unprocessable = retry.responses["422"];
    expect(unprocessable).toBeDefined();
    const example = exampleOf(unprocessable as Json, "UNPROCESSABLE");
    expect(example).toMatchObject({
      error: { code: "UNPROCESSABLE", status: 422, details: { reason: "tenant_limit", limit: 3 } },
    });
    // The same body is a valid answer of both operations: the retry answers exactly createTenant's error.
    for (const operationId of ["retryProvisioning", "createTenant"]) {
      expect(checker.check(operationId, { status: 422, body: tenantLimitBody(3) }), operationId).toEqual([]);
    }
  });

  it("[FIX-W67-KI002 AC3] adminRetryProvisioningJob says MAX_TENANTS_PER_ACCOUNT does not apply to it and answers no 422", () => {
    const adminRetry = operation("adminRetryProvisioningJob");
    expect(adminRetry.description).toMatch(/`MAX_TENANTS_PER_ACCOUNT` does not apply/);
    expect(adminRetry["x-error-codes"]).not.toContain("UNPROCESSABLE");
    expect(adminRetry.responses["422"]).toBeUndefined();
  });

  it("[FIX-W67-KI002 AC4] the change log, the inventory and scope PF-10 record both rules", () => {
    const changeLog = readFileSync(CONTRACT_README, "utf8");
    expect(changeLog).toMatch(
      /^\| FIX-W67-KI002 \| M6 \| .*`retryProvisioning`, `adminRetryProvisioningJob` \|/m,
    );
    const inventory = readFileSync(join(PLATFORM_DOCS, "api-inventory.md"), "utf8");
    expect(inventory).toMatch(
      /^\| `retryProvisioning` \|.*tenant_limit.*\| `PROVISIONING_NOT_RETRYABLE`, `UNPROCESSABLE` \|/m,
    );
    const scope = readFileSync(join(PLATFORM_DOCS, "scope.md"), "utf8");
    expect(scope).toContain(
      "- *Note (2026-11-21, lead decision (36e), approved by the owner; FIX-W67-KI002).* AC4 also holds for the owner's retry",
    );
    expect(scope).toMatch(/`adminRetryProvisioningJob`, PF-83\) is exempt/);
  });
});
