// The SDK route table (OADR-0016 point 2, ota/sdk/docs/types-and-builds.md §5, task SDK-002):
// scripts/generate-operations.mjs turns the working OpenAPI document into src/internal/operations.js, one frozen
// entry per `x-sdk-method`. These tests check the committed table against the document and the reviewed
// overrides, check a sample of every namespace, prove that the generator is deterministic, and run it on small
// scratch documents to prove that it refuses what core.call could only guess at.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { op } from "../../src/internal/operations.js";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..", "..");
const GENERATOR = join(SDK_ROOT, "scripts", "generate-operations.mjs");
const OVERRIDES = join(SDK_ROOT, "scripts", "operation-overrides.json");
const TABLE = join(SDK_ROOT, "src", "internal", "operations.js");
/** The working contract, which grows with the spec tasks. */
const DOCUMENT = join(REPO_ROOT, "ota", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");
/** The frozen original design with its 96 operations, never edited (decisions.md §3). */
const ORIGINAL = join(REPO_ROOT, "docs", "velexis-sdk", "openapi", "velexis-ota-booking-api.openapi.yaml");

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const NAMESPACES = [
  "storefront",
  "auth",
  "account",
  "reference",
  "flights",
  "checkout",
  "bookings",
  "console",
];

const scratch = mkdtempSync(join(tmpdir(), "sdk-002-operations-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Each run parses the whole document in a child process, which takes about half a second alone and much longer
 * while Turborepo runs every package's tests at once. So the runs happen in setup hooks (with budgets made of this
 * one) and never inside a test's 5 s, and a run that hangs is killed after it.
 */
const GENERATOR_TIMEOUT_MS = 60_000;

/**
 * Runs the generator with the given arguments; resolves to its exit status (null when it was killed) and output,
 * as spawnSync gives them.
 * @param {...string} args
 * @returns {Promise<{ status: number | null; stdout: string; stderr: string }>}
 */
const generate = (...args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GENERATOR, ...args], { timeout: GENERATOR_TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

/**
 * Runs declared in a describe block and made in its setup hook: `plan` declares one (an async function, next to the
 * test that reads it) and returns the function that gives its result; `makeAll` makes every declared run, at most
 * as many at a time as there are CPUs.
 */
function plannedRuns() {
  /** @type {Array<{ run: () => Promise<unknown>; made: boolean; result: unknown }>} */
  const planned = [];
  return {
    /**
     * @template T
     * @param {() => Promise<T>} run
     * @returns {() => T}
     */
    plan(run) {
      const entry = { run, made: false, result: /** @type {unknown} */ (undefined) };
      planned.push(entry);
      return () => {
        if (!entry.made) {
          throw new Error("the planned run of the generator was not made");
        }
        return /** @type {T} */ (entry.result);
      };
    },
    async makeAll() {
      let next = 0;
      const worker = async () => {
        while (next < planned.length) {
          const entry = planned[next];
          next += 1;
          entry.result = await entry.run();
          entry.made = true;
        }
      };
      await Promise.all(Array.from({ length: Math.min(availableParallelism(), planned.length) }, worker));
    },
  };
}

/** Every operation of a parsed document, with its resolved parameters (path-level ones merged). */
function operationsOf(document) {
  const resolveParameter = (raw) =>
    raw.$ref ? document.components.parameters[raw.$ref.split("/").pop()] : raw;
  const result = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) {
        continue;
      }
      const parameters = new Map();
      for (const raw of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        const parameter = resolveParameter(raw);
        parameters.set(`${parameter.in}:${parameter.name.toLowerCase()}`, parameter);
      }
      result.push({
        sdkMethod: operation["x-sdk-method"],
        skipped: operation["x-internal"] === true || operation["x-sdk-exclude"] === true,
        scope: operation["x-scope"],
        byDesign: operation["x-idempotent-by-design"] === true,
        bodyTypes: Object.keys(operation.requestBody?.content ?? {}),
        method: method.toUpperCase(),
        path,
        parameters: [...parameters.values()],
      });
    }
  }
  return result;
}

const keyOf = (sdkMethod) => sdkMethod.replaceAll(".", "_");

let documentOperations = [];
let originalOperations = [];
const overrides = JSON.parse(readFileSync(OVERRIDES, "utf8")).operations;

/**
 * Parsing both documents takes about a second alone, and more than Vitest's 10 s hook default while Turborepo runs
 * every package's tests at once on a CI runner (it timed out there once), so the hook gets its own budget.
 */
const PARSE_TIMEOUT_MS = 60_000;

beforeAll(() => {
  documentOperations = operationsOf(parse(readFileSync(DOCUMENT, "utf8")));
  originalOperations = operationsOf(parse(readFileSync(ORIGINAL, "utf8")));
}, PARSE_TIMEOUT_MS);

describe("the committed route table", () => {
  it("has one entry per x-sdk-method of the working document, keyed with underscores [SDK-002 AC1]", () => {
    const expected = documentOperations
      .filter((operation) => operation.sdkMethod !== undefined && !operation.skipped)
      .map((operation) => keyOf(operation.sdkMethod))
      .sort();
    expect(Object.keys(op).sort()).toEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it("covers the 96 x-sdk-methods of the original contract [SDK-002 AC1]", () => {
    const original = originalOperations.map((operation) => operation.sdkMethod);
    expect(original).toHaveLength(96);
    expect(new Set(original).size).toBe(96);
    for (const sdkMethod of original) {
      expect(op, sdkMethod).toHaveProperty(keyOf(sdkMethod));
    }
  });

  it("has the method and path template of each operation", () => {
    for (const operation of documentOperations.filter((o) => o.sdkMethod !== undefined && !o.skipped)) {
      const entry = op[keyOf(operation.sdkMethod)];
      expect({ method: entry?.method, path: entry?.path }, operation.sdkMethod).toEqual({
        method: operation.method,
        path: operation.path,
      });
    }
  });

  /** Two runs of the generator on the working document into one file, with the file after each run. */
  let fresh;
  beforeAll(async () => {
    const out = join(scratch, "operations.js");
    const read = () => (existsSync(out) ? readFileSync(out, "utf8") : "");
    const first = await generate("--out", out);
    const written = read();
    const second = await generate("--out", out);
    fresh = { first, written, second, rewritten: read() };
  }, 2 * GENERATOR_TIMEOUT_MS);

  it("is what a fresh run of the generator writes, and a second run changes nothing [SDK-002 AC1]", () => {
    const { first, written, second, rewritten } = fresh;
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("wrote");
    expect(written).toBe(readFileSync(TABLE, "utf8"));

    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("unchanged");
    expect(rewritten).toBe(written);
  });

  it("starts with the generated, do-not-edit header and names its sources", () => {
    const text = readFileSync(TABLE, "utf8");
    expect(text.split("\n")[0]).toBe("// Generated by scripts/generate-operations.mjs — do not edit.");
    expect(text).toContain("ota/backend/openapi/velexis-ota-booking-api.openapi.yaml");
    expect(text).toContain("ota/sdk/scripts/operation-overrides.json");
    // Deterministic: no absolute path of this machine.
    expect(text).not.toContain(REPO_ROOT);
  });

  it("is frozen: the table, its entries and their lists", () => {
    expect(Object.isFrozen(op)).toBe(true);
    for (const [key, entry] of Object.entries(op)) {
      expect(Object.isFrozen(entry), key).toBe(true);
      expect(Object.isFrozen(entry.pathParams), key).toBe(true);
      expect(Object.isFrozen(entry.queryParams), key).toBe(true);
      expect(Object.isFrozen(entry.headerParams), key).toBe(true);
    }
  });
});

/** One sample (or more) per namespace, written from the document and the plan, not from the generated file. */
const SAMPLES = {
  storefront_get: {
    method: "GET",
    path: "/v1/storefront",
    pathParams: [],
    queryParams: [],
    headerParams: {},
    idempotency: "none",
    retry: "safe",
    timeoutMs: null,
    environment: false,
    body: null,
  },
  storefront_resolve: {
    method: "GET",
    path: "/v1/storefront/resolve",
    pathParams: [],
    queryParams: ["host"],
    headerParams: {},
    idempotency: "none",
    retry: "safe",
    timeoutMs: null,
    environment: false,
    body: null,
  },
  auth_signIn: {
    method: "POST",
    path: "/v1/auth/sign-in",
    pathParams: [],
    queryParams: [],
    headerParams: {},
    idempotency: "required",
    retry: "idempotent",
    timeoutMs: null,
    environment: false,
    body: "json",
  },
  account_update: {
    method: "PATCH",
    path: "/v1/account",
    pathParams: [],
    queryParams: [],
    headerParams: { ifMatch: "If-Match" },
    idempotency: "none",
    retry: "never",
    timeoutMs: null,
    environment: false,
    body: "json",
  },
  // The path parameter is declared on the path item, not on the operation.
  account_savedTravelers_delete: {
    method: "DELETE",
    path: "/v1/account/saved-travelers/{savedTravelerId}",
    pathParams: ["savedTravelerId"],
    queryParams: [],
    headerParams: {},
    idempotency: "none",
    retry: "idempotent",
    timeoutMs: null,
    environment: false,
    body: null,
  },
  reference_locations_search: {
    method: "GET",
    path: "/v1/reference/locations",
    pathParams: [],
    queryParams: ["keyword", "subType", "countryCode", "cursor", "limit"],
    headerParams: {},
    idempotency: "none",
    retry: "safe",
    timeoutMs: null,
    environment: false,
    body: null,
  },
  reference_airports_get: {
    method: "GET",
    path: "/v1/reference/airports/{iataCode}",
    pathParams: ["iataCode"],
    queryParams: [],
    headerParams: {},
    idempotency: "none",
    retry: "safe",
    timeoutMs: null,
    environment: false,
    body: null,
  },
  flights_search: {
    method: "POST",
    path: "/v1/flight-searches",
    pathParams: [],
    queryParams: [],
    headerParams: {},
    idempotency: "required",
    retry: "idempotent",
    timeoutMs: 60_000,
    environment: false,
    body: "json",
  },
  flights_listResults: {
    method: "GET",
    path: "/v1/flight-searches/{searchId}/offers",
    pathParams: ["searchId"],
    queryParams: [
      "stops",
      "carriers",
      "minPrice",
      "maxPrice",
      "departureWindow",
      "arrivalWindow",
      "maxDurationMinutes",
      "cabins",
      "minIncludedCheckedBags",
      "refundable",
      "changeable",
      "brandedFares",
      "sort",
      "view",
      "cursor",
      "limit",
    ],
    headerParams: {},
    idempotency: "none",
    retry: "safe",
    timeoutMs: null,
    environment: false,
    body: null,
  },
  // A console-only shopping method: it takes the OTA admin's environment header.
  flights_availability: {
    method: "POST",
    path: "/v1/flight-availabilities",
    pathParams: [],
    queryParams: [],
    headerParams: {},
    idempotency: "required",
    retry: "idempotent",
    timeoutMs: null,
    environment: true,
    body: "json",
  },
  checkout_complete: {
    method: "POST",
    path: "/v1/checkouts/{checkoutId}/complete",
    pathParams: ["checkoutId"],
    queryParams: [],
    headerParams: {},
    idempotency: "required",
    retry: "idempotent",
    timeoutMs: 90_000,
    environment: false,
    body: "json",
  },
  checkout_setTravelers: {
    method: "PUT",
    path: "/v1/checkouts/{checkoutId}/travelers",
    pathParams: ["checkoutId"],
    queryParams: [],
    headerParams: { ifMatch: "If-Match" },
    idempotency: "none",
    retry: "idempotent",
    timeoutMs: null,
    environment: false,
    body: "json",
  },
  checkout_updatePayment: {
    method: "PATCH",
    path: "/v1/payments/{paymentId}",
    pathParams: ["paymentId"],
    queryParams: [],
    headerParams: {},
    idempotency: "none",
    retry: "never",
    timeoutMs: null,
    environment: false,
    body: "json",
  },
  bookings_list: {
    method: "GET",
    path: "/v1/bookings",
    pathParams: [],
    queryParams: [
      "timeframe",
      "departureFrom",
      "departureTo",
      "createdFrom",
      "createdTo",
      "sort",
      "cursor",
      "limit",
    ],
    headerParams: {},
    idempotency: "none",
    retry: "safe",
    timeoutMs: null,
    environment: false,
    body: null,
  },
  bookings_cancel: {
    method: "POST",
    path: "/v1/bookings/{bookingId}/cancellation",
    pathParams: ["bookingId"],
    queryParams: [],
    headerParams: { ifMatch: "If-Match" },
    idempotency: "required",
    retry: "idempotent",
    timeoutMs: null,
    environment: false,
    body: "json",
  },
  bookings_getDocumentDownloadUrl: {
    method: "GET",
    path: "/v1/bookings/{bookingId}/documents/{documentId}/download-url",
    pathParams: ["bookingId", "documentId"],
    queryParams: [],
    headerParams: {},
    idempotency: "none",
    retry: "safe",
    timeoutMs: null,
    environment: false,
    body: null,
  },
  console_bookings_issue: {
    method: "POST",
    path: "/v1/console/bookings/{bookingId}/issuance",
    pathParams: ["bookingId"],
    queryParams: [],
    headerParams: { ifMatch: "If-Match" },
    idempotency: "required",
    retry: "idempotent",
    timeoutMs: 60_000,
    environment: true,
    body: "json",
  },
  console_bookings_retrieve: {
    method: "GET",
    path: "/v1/console/bookings/{bookingId}/amadeus-order",
    pathParams: ["bookingId"],
    queryParams: ["include", "fareRules", "updateSnapshot"],
    headerParams: {},
    idempotency: "none",
    retry: "safe",
    timeoutMs: 60_000,
    environment: true,
    body: null,
  },
  // A POST without an Idempotency-Key that the document marks x-idempotent-by-design.
  console_bookings_resync: {
    method: "POST",
    path: "/v1/console/bookings/{bookingId}/resync",
    pathParams: ["bookingId"],
    queryParams: [],
    headerParams: {},
    idempotency: "none",
    retry: "idempotent",
    timeoutMs: null,
    environment: true,
    body: "json",
  },
  console_bookings_patch: {
    method: "PATCH",
    path: "/v1/console/bookings/{bookingId}",
    pathParams: ["bookingId"],
    queryParams: [],
    headerParams: { ifMatch: "If-Match" },
    idempotency: "none",
    retry: "never",
    timeoutMs: null,
    environment: true,
    body: "json",
  },
  console_amadeus_cancelFlightOrder: {
    method: "DELETE",
    path: "/v1/console/amadeus/v1/booking/flight-orders/{flightOrderId}",
    pathParams: ["flightOrderId"],
    queryParams: ["reason"],
    headerParams: {},
    idempotency: "none",
    retry: "idempotent",
    timeoutMs: null,
    environment: true,
    body: null,
  },
};

describe("a sample per namespace", () => {
  it("covers every namespace of the SDK", () => {
    const sampled = new Set(Object.keys(SAMPLES).map((key) => key.split("_")[0]));
    expect([...sampled].sort()).toEqual([...NAMESPACES].sort());
    expect(new Set(Object.keys(op).map((key) => key.split("_")[0]))).toEqual(new Set(NAMESPACES));
  });

  it.each(Object.entries(SAMPLES))(
    "%s has its method, path template, params, idempotency, retry and timeout [SDK-002 AC2]",
    (key, expected) => {
      expect(op[key]).toEqual(expected);
    },
  );
});

describe("the reviewed overrides", () => {
  const SIXTY = [
    "flights.search",
    "flights.upsell",
    "flights.price",
    "console.bookings.issue",
    "console.bookings.cancel",
    "console.bookings.import",
    "console.bookings.retrieve",
  ];

  it("give 60 s to search, upsell, price and the long console booking actions [SDK-002 AC2]", () => {
    for (const sdkMethod of SIXTY) {
      expect(overrides[sdkMethod], sdkMethod).toMatchObject({ timeoutMs: 60_000 });
      expect(overrides[sdkMethod].retry, sdkMethod).toBeUndefined();
      expect(op[keyOf(sdkMethod)]?.timeoutMs, sdkMethod).toBe(60_000);
    }
  });

  it("give 90 s to checkout.complete, which stays retried with its Idempotency-Key [SDK-002 AC2]", () => {
    expect(overrides["checkout.complete"]).toMatchObject({ timeoutMs: 90_000 });
    expect(overrides["checkout.complete"].retry).toBeUndefined();
    expect(op.checkout_complete).toMatchObject({ timeoutMs: 90_000, retry: "idempotent" });
  });

  it("give 90 s and no retry to checkout.completeWithAirlineCard, once OBE-029 adds it [SDK-002 AC2]", () => {
    expect(overrides["checkout.completeWithAirlineCard"]).toMatchObject({
      timeoutMs: 90_000,
      retry: "never",
      specTask: "OBE-029",
    });
    const inDocument = documentOperations.some((o) => o.sdkMethod === "checkout.completeWithAirlineCard");
    if (inDocument) {
      expect(op).toHaveProperty("checkout_completeWithAirlineCard.timeoutMs", 90_000);
      expect(op).toHaveProperty("checkout_completeWithAirlineCard.retry", "never");
    } else {
      expect(op).not.toHaveProperty("checkout_completeWithAirlineCard");
    }
  });

  it("are the only source of timeouts: every other entry uses the client's timeoutMs", () => {
    for (const [key, entry] of Object.entries(op)) {
      const sdkMethod = Object.keys(overrides).find((name) => keyOf(name) === key);
      expect(entry.timeoutMs, key).toBe(sdkMethod ? overrides[sdkMethod].timeoutMs : null);
    }
  });

  it("each give a reason", () => {
    for (const [sdkMethod, override] of Object.entries(overrides)) {
      expect(override.reason, sdkMethod).toEqual(expect.stringMatching(/\S/));
    }
  });
});

describe("every entry", () => {
  const entries = () => Object.entries(op);

  it("fills exactly the placeholders of its path template with its path params", () => {
    for (const [key, entry] of entries()) {
      const placeholders = [...entry.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
      expect(entry.pathParams, key).toEqual(placeholders);
    }
  });

  it("uses each param name in one place only", () => {
    for (const [key, entry] of entries()) {
      const names = [...entry.pathParams, ...entry.queryParams, ...Object.keys(entry.headerParams)];
      expect(new Set(names).size, key).toBe(names.length);
    }
  });

  it("maps only If-Match to a method param; the client sets every other header", () => {
    for (const [key, entry] of entries()) {
      for (const [param, header] of Object.entries(entry.headerParams)) {
        expect([param, header], key).toEqual(["ifMatch", "If-Match"]);
      }
    }
  });

  it("has the idempotency of its Idempotency-Key parameter", () => {
    for (const operation of documentOperations.filter((o) => o.sdkMethod !== undefined && !o.skipped)) {
      const key = operation.parameters.find((p) => p.in === "header" && p.name === "Idempotency-Key");
      const expected = key === undefined ? "none" : key.required ? "required" : "optional";
      expect(op[keyOf(operation.sdkMethod)]?.idempotency, operation.sdkMethod).toBe(expected);
    }
  });

  it("is retried only when safe: GET, PUT, DELETE, an Idempotency-Key or by design, never by override", () => {
    for (const operation of documentOperations.filter((o) => o.sdkMethod !== undefined && !o.skipped)) {
      const entry = op[keyOf(operation.sdkMethod)];
      let expected = "never";
      if (overrides[operation.sdkMethod]?.retry === "never") {
        expected = "never";
      } else if (operation.method === "GET") {
        expected = "safe";
      } else if (
        operation.method === "PUT" ||
        operation.method === "DELETE" ||
        entry?.idempotency !== "none" ||
        operation.byDesign
      ) {
        expected = "idempotent";
      }
      expect(entry?.retry, operation.sdkMethod).toBe(expected);
    }
    // A PATCH without an Idempotency-Key is never retried: a second attempt after a lost answer fails If-Match.
    expect(op.account_update.retry).toBe("never");
  });

  it("takes X-Velexis-Environment exactly when the document declares it, never on a customer operation", () => {
    for (const operation of documentOperations.filter((o) => o.sdkMethod !== undefined && !o.skipped)) {
      const declared = operation.parameters.some(
        (p) => p.in === "header" && p.name.toLowerCase() === "x-velexis-environment",
      );
      const entry = op[keyOf(operation.sdkMethod)];
      expect(entry?.environment, operation.sdkMethod).toBe(declared);
      if (operation.scope === "customer") {
        expect(entry?.environment, operation.sdkMethod).toBe(false);
      }
    }
    for (const [key, entry] of entries().filter(([name]) => name.startsWith("console_"))) {
      expect(entry.environment, key).toBe(true);
    }
  });

  it("sends the body the document declares: JSON, multipart/form-data or none", () => {
    // `console.settings.assets.upload` (OBE-091) is the first multipart operation; its spec task regenerates the
    // table and runs these tests without editing them.
    const BODY = { "application/json": "json", "multipart/form-data": "multipart" };
    for (const operation of documentOperations.filter((o) => o.sdkMethod !== undefined && !o.skipped)) {
      const expected = operation.bodyTypes.length === 0 ? null : BODY[operation.bodyTypes[0]];
      expect(operation.bodyTypes.length, operation.sdkMethod).toBeLessThanOrEqual(1);
      expect(op[keyOf(operation.sdkMethod)]?.body, operation.sdkMethod).toBe(expected);
    }
  });
});

// ---- The generator on scratch documents --------------------------------------------------------------------

let counter = 0;
/** Writes a scratch file and returns its path. */
function scratchFile(name, content) {
  counter += 1;
  const file = join(scratch, `${counter}-${name}`);
  writeFileSync(file, content);
  return file;
}

const NO_OVERRIDES = JSON.stringify({ operations: {} });
const ok = { description: "OK" };

/** A small OpenAPI document with the given paths and component parameters and schemas. */
const documentWith = (paths, components = {}) =>
  stringify({ openapi: "3.1.0", info: { title: "scratch", version: "1.0.0" }, paths, components });

/** Runs the generator on a scratch document and overrides; resolves to the result and the output path. */
async function generateFrom(paths, { components, overrides: overridesJson = NO_OVERRIDES } = {}) {
  const document = scratchFile("document.yaml", documentWith(paths, components));
  const overridesFile = scratchFile("overrides.json", overridesJson);
  const out = join(scratch, `${counter}-operations.js`);
  return { ...(await generate("--document", document, "--overrides", overridesFile, "--out", out)), out };
}

/** Expects a refusal: exit 1, a message naming `pattern`, and no output file. */
function expectRefusal({ status, stderr, out }, pattern) {
  expect(status).toBe(1);
  expect(stderr).toMatch(pattern);
  expect(existsSync(out)).toBe(false);
}

const jsonBody = (properties) => ({
  required: true,
  content: { "application/json": { schema: { type: "object", properties } } },
});

describe("the generator", () => {
  // Each test declares its runs of the generator next to it; this hook makes them all, a few at a time: about 20
  // child processes, one of them on the working document, a few seconds idle and several times that while Turborepo
  // runs every package's tests at once.
  const runs = plannedRuns();
  beforeAll(() => runs.makeAll(), 3 * GENERATOR_TIMEOUT_MS);

  const duplicatedInDocument = runs.plan(async () => {
    const text = readFileSync(DOCUMENT, "utf8");
    const duplicated = text.replace("x-sdk-method: storefront.resolve", "x-sdk-method: storefront.get");
    const out = join(scratch, "duplicated-operations.js");
    const result = await generate("--document", scratchFile("duplicated.yaml", duplicated), "--out", out);
    return { text, duplicated, result: { ...result, out } };
  });
  it("exits 1 on a document with a duplicated x-sdk-method [SDK-002 AC3]", () => {
    const { text, duplicated, result } = duplicatedInDocument();
    expect(duplicated).not.toBe(text);
    expectRefusal(result, /"x-sdk-method" storefront\.get is also used by GET \/v1\/storefront/);
  });

  const duplicatedInScratch = runs.plan(() =>
    generateFrom({
      "/v1/a": { get: { operationId: "a", "x-sdk-method": "storefront.get", responses: { 200: ok } } },
      "/v1/b": { get: { operationId: "b", "x-sdk-method": "storefront.get", responses: { 200: ok } } },
    }),
  );
  it("exits 1 on a duplicated x-sdk-method in a scratch document [SDK-002 AC3]", () => {
    const result = duplicatedInScratch();
    expectRefusal(result, /storefront\.get is also used by GET \/v1\/a/);
  });

  const pathAndQuery = runs.plan(() =>
    generateFrom({
      "/v1/things/{thingId}": {
        get: {
          operationId: "getThing",
          "x-sdk-method": "bookings.get",
          parameters: [
            { name: "thingId", in: "path", required: true, schema: { type: "string" } },
            { name: "thingId", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: ok },
        },
      },
    }),
  );
  it("exits 1 when a path and a query parameter share a name", () => {
    const result = pathAndQuery();
    expectRefusal(result, /the param name "thingId" is both a path parameter and a query parameter/);
  });

  const queryAndBody = runs.plan(() =>
    generateFrom({
      "/v1/things": {
        post: {
          operationId: "createThing",
          "x-sdk-method": "bookings.create",
          parameters: [{ name: "include", in: "query", schema: { type: "string" } }],
          requestBody: jsonBody({ include: { type: "string" }, name: { type: "string" } }),
          responses: { 201: ok },
        },
      },
    }),
  );
  it("exits 1 when a query parameter and a top-level body property share a name", () => {
    const result = queryAndBody();
    expectRefusal(result, /"include" is both a query parameter and a top-level property of the request body/);
  });

  const ifMatchInBody = runs.plan(() =>
    generateFrom(
      {
        "/v1/things/{thingId}": {
          patch: {
            operationId: "updateThing",
            "x-sdk-method": "bookings.update",
            parameters: [
              { name: "thingId", in: "path", required: true, schema: { type: "string" } },
              { $ref: "#/components/parameters/IfMatch" },
            ],
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/ThingUpdate" } } },
            },
            responses: { 200: ok },
          },
        },
      },
      {
        components: {
          parameters: {
            IfMatch: { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
          },
          schemas: {
            ThingUpdate: { allOf: [{ $ref: "#/components/schemas/Versioned" }] },
            Versioned: { type: "object", properties: { ifMatch: { type: "string" } } },
          },
        },
      },
    ),
  );
  it("exits 1 when ifMatch is also a body property, found through $ref and allOf", () => {
    const result = ifMatchInBody();
    expectRefusal(
      result,
      /"ifMatch" is both the header If-Match and a top-level property of the request body/,
    );
  });

  const withoutSdkMethod = runs.plan(() =>
    generateFrom({
      "/v1/things": { get: { operationId: "listThings", responses: { 200: ok } } },
    }),
  );
  it("exits 1 on an operation without x-sdk-method that is neither x-internal nor x-sdk-exclude", () => {
    const result = withoutSdkMethod();
    expectRefusal(result, /GET \/v1\/things: every operation needs an "x-sdk-method"/);
  });

  const internalAndExcluded = runs.plan(() =>
    generateFrom({
      "/v1/things": {
        get: { operationId: "listThings", "x-sdk-method": "bookings.list", responses: { 200: ok } },
      },
      "/webhooks/stripe": {
        post: { operationId: "stripeWebhook", "x-internal": true, responses: { 200: ok } },
      },
      "/v1/assets/{assetId}": {
        get: {
          operationId: "getAsset",
          "x-sdk-exclude": true,
          parameters: [{ name: "assetId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: ok },
        },
      },
      "/internal/ping": {
        get: {
          operationId: "ping",
          "x-internal": true,
          "x-sdk-method": "storefront.ping",
          responses: { 200: ok },
        },
      },
    }),
  );
  it("skips x-internal and x-sdk-exclude operations, with or without an x-sdk-method", () => {
    const result = internalAndExcluded();
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(result.out, "utf8");
    expect(text).toContain("  bookings_list: {");
    expect(text).not.toMatch(/stripe|getAsset|assets|ping/i);
  });

  const unknownHeader = runs.plan(() =>
    generateFrom({
      "/v1/things": {
        get: {
          operationId: "listThings",
          "x-sdk-method": "bookings.list",
          parameters: [{ name: "X-Something-New", in: "header", schema: { type: "string" } }],
          responses: { 200: ok },
        },
      },
    }),
  );
  it("exits 1 on a header parameter the SDK does not know", () => {
    const result = unknownHeader();
    expectRefusal(result, /the header parameter "X-Something-New" is unknown to the SDK/);
  });

  const explodedArray = runs.plan(() =>
    generateFrom({
      "/v1/things": {
        get: {
          operationId: "listThings",
          "x-sdk-method": "bookings.list",
          parameters: [{ name: "status", in: "query", schema: { type: "array", items: { type: "string" } } }],
          responses: { 200: ok },
        },
      },
    }),
  );
  it("exits 1 on an array query parameter that is not comma-separated", () => {
    const result = explodedArray();
    expectRefusal(result, /query parameter "status" is an array without "explode: false"/);
  });

  const templateMismatch = runs.plan(() =>
    generateFrom({
      "/v1/things/{thingId}": {
        get: { operationId: "getThing", "x-sdk-method": "bookings.get", responses: { 200: ok } },
      },
    }),
  );
  it("exits 1 when the path template and the path parameters differ", () => {
    const result = templateMismatch();
    expectRefusal(result, /the path template names \{thingId\} but the path parameters are none/);
  });

  const multipartBodies = runs.plan(async () => {
    const upload = (content) => ({
      "/v1/console/settings/assets": {
        post: {
          operationId: "uploadAsset",
          "x-sdk-method": "console.settings.assets.upload",
          requestBody: { required: true, content },
          responses: { 201: ok },
        },
      },
    });
    const multipart = {
      schema: { type: "object", properties: { file: { type: "string" }, kind: { type: "string" } } },
    };
    const result = await generateFrom(upload({ "multipart/form-data": multipart }));
    const twoTypes = await generateFrom(
      upload({ "multipart/form-data": multipart, "application/json": multipart }),
    );
    return { result, twoTypes };
  });
  it("marks a multipart/form-data body as multipart, and exits 1 on a body with two media types", () => {
    const { result, twoTypes } = multipartBodies();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.out, "utf8")).toContain('    environment: false,\n    body: "multipart",\n');

    expectRefusal(twoTypes, /the request body must have exactly one media type/);
  });

  const repeatedPlaceholder = runs.plan(() =>
    generateFrom({
      "/v1/things/{thingId}/parts/{thingId}": {
        get: {
          operationId: "getPart",
          "x-sdk-method": "bookings.get",
          parameters: [
            { name: "thingId", in: "path", required: true, schema: { type: "string" } },
            { name: "partId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { 200: ok },
        },
      },
    }),
  );
  it("exits 1 when the path template repeats a placeholder and leaves a path parameter out", () => {
    const result = repeatedPlaceholder();
    expectRefusal(
      result,
      /the path template names \{thingId\}, \{thingId\} but the path parameters are thingId, partId/,
    );
  });

  const overridesOfMissingMethods = runs.plan(async () => {
    const paths = {
      "/v1/things": {
        get: { operationId: "listThings", "x-sdk-method": "bookings.list", responses: { 200: ok } },
      },
    };
    const typo = await generateFrom(paths, {
      overrides: JSON.stringify({ operations: { "bookings.lsit": { timeoutMs: 60_000, reason: "typo" } } }),
    });
    const waiting = await generateFrom(paths, {
      overrides: JSON.stringify({
        operations: { "bookings.later": { timeoutMs: 60_000, reason: "later", specTask: "OBE-999" } },
      }),
    });
    return { typo, waiting };
  });
  it("exits 1 on an override for a method the document does not have, unless it names its specTask", () => {
    const { typo, waiting } = overridesOfMissingMethods();
    expectRefusal(typo, /"bookings\.lsit" is not an x-sdk-method of the document/);

    expect(waiting.status, waiting.stderr).toBe(0);
    expect(waiting.stdout).toContain("overrides waiting for their operation: bookings.later (OBE-999)");
  });

  const appliedOverride = runs.plan(() =>
    generateFrom(
      {
        "/v1/things": {
          post: {
            operationId: "createThing",
            "x-sdk-method": "bookings.create",
            parameters: [
              { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
            ],
            requestBody: jsonBody({ name: { type: "string" } }),
            responses: { 201: ok },
          },
        },
      },
      {
        overrides: JSON.stringify({
          operations: {
            "bookings.create": { timeoutMs: 90_000, retry: "never", reason: "slow", specTask: "OBE-999" },
          },
        }),
      },
    ),
  );
  it("applies an override once its operation exists", () => {
    const result = appliedOverride();
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(result.out, "utf8");
    expect(text).toContain('    idempotency: "required",\n    retry: "never",\n    timeoutMs: 90000,');
  });

  const looserAndSilentOverrides = runs.plan(async () => {
    const paths = {
      "/v1/things": {
        get: { operationId: "listThings", "x-sdk-method": "bookings.list", responses: { 200: ok } },
      },
    };
    const looser = await generateFrom(paths, {
      overrides: JSON.stringify({
        operations: { "bookings.list": { retry: "idempotent", reason: "faster" } },
      }),
    });
    const silent = await generateFrom(paths, {
      overrides: JSON.stringify({ operations: { "bookings.list": { timeoutMs: 60_000 } } }),
    });
    return { looser, silent };
  });
  it("refuses an override that would make a call retried, or that gives no reason", () => {
    const { looser, silent } = looserAndSilentOverrides();
    expectRefusal(looser, /"retry" can only be overridden to "never"/);

    expectRefusal(silent, /every override needs a "reason"/);
  });
});
