import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  API_DOCUMENTS,
  createResponseChecker,
  expectResponseToMatch,
  responseChecker,
  ResponseMismatchError,
  type ResponseChecker,
} from "./openapi-response.js";

// Tests of task X-015 step 4: expectResponseToMatch and the response checker, against the OTA document of the
// repository and against small fixture documents for the cases the OTA document does not have.

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
// Parsing the 40,000-line OTA document takes about half a second, more on a busy runner.
const PARSE_TIMEOUT_MS = 60_000;

type JsonObject = Record<string, unknown>;

/** The message of the error `fn` throws (fails the test when it does not throw). */
function thrown(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected a throw");
}

/** A small OpenAPI 3.1 document with the response shapes the OTA document does not use. */
const FIXTURE = {
  openapi: "3.1.0",
  info: { title: "Fixture", version: "1" },
  paths: {
    "/v1/items": {
      get: {
        operationId: "listItems",
        "x-sdk-method": "items.list",
        responses: {
          "200": {
            description: "Items.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ItemPage" } } },
          },
          "4XX": { $ref: "#/components/responses/Problem" },
          default: { description: "Anything else, without a body." },
        },
      },
      post: {
        operationId: "createItem",
        responses: {
          "201": {
            description: "Created.",
            content: {
              "application/vnd.velexis.item+json; charset=utf-8": {
                schema: { $ref: "#/components/schemas/Item" },
              },
            },
          },
          "202": { description: "Accepted, any body.", content: { "application/json": {} } },
        },
      },
    },
    "/v1/items/{id}/pdf": {
      get: {
        operationId: "getItemPdf",
        responses: {
          "200": {
            description: "A PDF.",
            content: {
              "application/pdf": { schema: { type: "string", contentMediaType: "application/pdf" } },
            },
          },
        },
      },
    },
  },
  components: {
    responses: {
      Problem: { $ref: "#/components/responses/ProblemBody" },
      ProblemBody: {
        description: "An error.",
        content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
      },
    },
    schemas: {
      ItemPage: {
        type: "object",
        required: ["data"],
        additionalProperties: false,
        properties: { data: { type: "array", items: { $ref: "#/components/schemas/Item" } } },
      },
      Item: {
        type: "object",
        required: ["id", "price", "status", "createdAt"],
        additionalProperties: false,
        "x-risk-personal-data-field": false,
        discriminator: { propertyName: "status" },
        example: { id: "itm_1" },
        properties: {
          id: { type: "string", pattern: "^itm_[0-9a-z]+$" },
          price: { type: "string", pattern: "^\\d+\\.\\d{2}$", "x-examples": ["12.30"] },
          status: { type: "string", enum: ["draft", "live"] },
          createdAt: { type: "string", format: "date-time" },
          note: { type: ["string", "null"] },
          kind: { const: "item" },
        },
      },
      Problem: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
      },
    },
  },
};

const ITEM = { id: "itm_1", price: "12.30", status: "live", createdAt: "2026-10-12T09:00:00Z" };

describe("expectResponseToMatch on the OTA document", () => {
  let document: { components: { schemas: Record<string, JsonObject>; examples: Record<string, JsonObject> } };
  let paths: Record<string, Record<string, { operationId?: string; responses?: JsonObject }>>;

  beforeAll(() => {
    const parsed = parse(readFileSync(join(REPO_ROOT, API_DOCUMENTS.ota), "utf8")) as JsonObject;
    document = parsed as typeof document;
    paths = parsed["paths"] as typeof paths;
    // Warm the cached checker inside the hook's time budget, and compile the getBooking 200 validator the first tests
    // use (the Booking schema pulls in much of the document, so Ajv takes seconds on a busy runner), so that work
    // runs here under PARSE_TIMEOUT_MS and not inside a test body on the default bound.
    responseChecker("ota").check("getBooking", { status: 200, body: {} });
    // The same for the platform document, which the last test of this block reads once it exists.
    if (existsSync(join(REPO_ROOT, API_DOCUMENTS.platform))) {
      responseChecker("platform");
    }
  }, PARSE_TIMEOUT_MS);

  it("fails getBooking 200 with { foo: 1 }, naming the missing required properties [X-015 AC4]", () => {
    const error = thrown(() => expectResponseToMatch("getBooking", { status: 200, body: { foo: 1 } }));
    expect(error).toBeInstanceOf(ResponseMismatchError);
    const required = document.components.schemas["Booking"]?.["required"] as string[];
    expect(required.length).toBeGreaterThan(10);
    expect(error.message).toMatch(
      /^getBooking \(GET \/v1\/bookings\/\{bookingId\}\): the 200 response does not match the OTA document, \d+ problems:\n/,
    );
    for (const property of required) {
      expect(error.message).toContain(`\n  - /${property}: required property is missing`);
    }
    const mismatch = error as ResponseMismatchError;
    expect(mismatch.operationId).toBe("getBooking");
    expect(mismatch.status).toBe(200);
    expect(mismatch.problems.filter((problem) => problem.keyword === "required").map((p) => p.path)).toEqual(
      required.map((property) => `/${property}`),
    );
  });

  it("passes the document's own booking example, so the check is not vacuous", () => {
    const example = document.components.examples["BookingExample"]?.["value"];
    expect(example).toBeDefined();
    expect(() => expectResponseToMatch("getBooking", { status: 200, body: example })).not.toThrow();
    // One wrong value is enough to fail, and the path names it.
    const broken = { ...(example as JsonObject), status: "teleported" };
    const error = thrown(() => expectResponseToMatch("getBooking", { status: 200, body: broken }));
    expect(error.message).toContain("\n  - /status: must be equal to one of the allowed values: ");
    expect(error.message).not.toContain("teleported");
  });

  it("checks error responses against the shared error envelope", () => {
    const body = {
      error: {
        code: "NOT_FOUND",
        message: "Not found.",
        status: 404,
        requestId: "req_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
      },
    };
    expect(() => expectResponseToMatch("getBooking", { status: 404, body })).not.toThrow();
    const error = thrown(() =>
      expectResponseToMatch("getBooking", {
        status: 404,
        body: { error: { ...body.error, code: "not_found" } },
      }),
    );
    expect(error.message).toContain("\n  - /error/code: ");
  });

  it("fails a status the operation does not document, listing the documented ones", () => {
    const error = thrown(() => expectResponseToMatch("getBooking", { status: 418, body: {} }));
    expect(error).toBeInstanceOf(ResponseMismatchError);
    expect(error.message).toContain(
      "\n  - (status): 418 is not a documented status of getBooking (documented: 200, 400, 401,",
    );
  });

  it("accepts an empty body, and only an empty body, for a response documented without content", () => {
    // signOut answers 204, getStorefront 304: both without content in the document.
    for (const body of [undefined, null, "", {}]) {
      expect(() => expectResponseToMatch("signOut", { status: 204, body })).not.toThrow();
    }
    expect(() => expectResponseToMatch("getStorefront", { status: 304 })).not.toThrow();
    const error = thrown(() => expectResponseToMatch("signOut", { status: 204, body: { signedOut: true } }));
    expect(error.message).toContain("(body): the 204 response is documented without a body, but it has one");
  });

  it("rejects an unknown operationId at compile time and at run time", () => {
    const error = thrown(() =>
      // @ts-expect-error -- "getBookng" is not an operationId of the OTA document
      expectResponseToMatch("getBookng", { status: 200, body: {} }),
    );
    expect(error).not.toBeInstanceOf(ResponseMismatchError);
    expect(error.message).toBe('expectResponseToMatch: the OTA document has no operation "getBookng"');
  });

  it(
    "compiles the schema of every documented JSON response of the OTA document in strict mode",
    () => {
      const checker = responseChecker("ota");
      let compiled = 0;
      for (const item of Object.values(paths)) {
        for (const operation of Object.values(item)) {
          if (typeof operation.operationId !== "string") {
            continue;
          }
          for (const [status, response] of Object.entries(operation.responses ?? {})) {
            const content = (response as JsonObject)["content"];
            const types = content !== null && typeof content === "object" ? Object.keys(content) : [];
            if (types.length > 0 && !types.some((type) => /^application\/([\w.+-]+\+)?json\b/i.test(type))) {
              // Documented with other media types only (getPublicAsset's images): the checker refuses to judge it,
              // as for the fixture's PDF, so its test checks that body another way.
              expect(() =>
                checker.check(String(operation.operationId), { status: Number(status), body: "" }),
              ).toThrow("has no JSON content");
              continue;
            }
            // A body that matches nothing: every schema is compiled and run; compile errors would throw.
            checker.check(operation.operationId, { status: Number(status), body: Symbol.for("nothing") });
            compiled += 1;
          }
        }
      }
      expect(compiled).toBeGreaterThan(800);
      expect(checker.operationIds()).toContain("getBooking");
    },
    PARSE_TIMEOUT_MS,
  );

  it("reads the documents that packages/api-types/redocly.yaml lists", () => {
    const redocly = parse(readFileSync(join(REPO_ROOT, "packages/api-types/redocly.yaml"), "utf8")) as {
      apis: Record<string, { root: string }>;
    };
    const roots = Object.fromEntries(
      Object.entries(redocly.apis).map(([name, api]) => [
        name,
        join("packages/api-types", api.root).replaceAll("\\", "/"),
      ]),
    );
    expect(roots).toEqual({ ...API_DOCUMENTS });
  });

  it("checks against the platform document once it exists (the platform plan creates it in M1)", () => {
    if (existsSync(join(REPO_ROOT, API_DOCUMENTS.platform))) {
      expect(responseChecker("platform").operationIds().length).toBeGreaterThan(0);
      return;
    }
    const error = thrown(() =>
      expectResponseToMatch("listPlans" as never, { status: 200, body: {} }, { document: "platform" }),
    );
    expect(error.message).toBe(
      "expectResponseToMatch: the platform document platform/backend/openapi/velexis-platform-api.openapi.yaml " +
        "does not exist yet; the platform plan creates it in M1 (ADR-0006)",
    );
  });
});

describe("createResponseChecker on a fixture document", () => {
  let checker: ResponseChecker;
  beforeAll(() => {
    checker = createResponseChecker(structuredClone(FIXTURE), { label: "fixture" });
  });

  it("passes matching bodies, through component and nested $refs", () => {
    expect(
      checker.check("listItems", { status: 200, body: { data: [ITEM, { ...ITEM, note: null }] } }),
    ).toEqual([]);
    expect(checker.check("listItems", { status: 200, body: { data: [] } })).toEqual([]);
    expect(checker.operationIds()).toEqual(["listItems", "createItem", "getItemPdf"]);
  });

  it("names the path of every failing value, deep in arrays, without echoing values", () => {
    const body = {
      data: [
        ITEM,
        {
          ...ITEM,
          id: "tok_SECRET_VALUE",
          price: 12.3,
          status: "gone",
          createdAt: "yesterday",
          kind: "other",
          x: 1,
        },
      ],
    };
    const problems = checker.check("listItems", { status: 200, body });
    expect(problems).toEqual([
      {
        path: "/data/1/x",
        keyword: "additionalProperties",
        message: "property is not allowed (additionalProperties: false)",
      },
      { path: "/data/1/id", keyword: "pattern", message: 'must match pattern "^itm_[0-9a-z]+$"' },
      { path: "/data/1/price", keyword: "type", message: "must be string" },
      {
        path: "/data/1/status",
        keyword: "enum",
        message: 'must be equal to one of the allowed values: "draft", "live"',
      },
      { path: "/data/1/createdAt", keyword: "format", message: 'must match format "date-time"' },
      { path: "/data/1/kind", keyword: "const", message: 'must be equal to "item"' },
    ]);
    const error = thrown(() => checker.expectToMatch("listItems", { status: 200, body }));
    expect(error.message).toBe(
      [
        "listItems (GET /v1/items): the 200 response does not match the fixture document, 6 problems:",
        "  - /data/1/x: property is not allowed (additionalProperties: false)",
        '  - /data/1/id: must match pattern "^itm_[0-9a-z]+$"',
        "  - /data/1/price: must be string",
        '  - /data/1/status: must be equal to one of the allowed values: "draft", "live"',
        '  - /data/1/createdAt: must match format "date-time"',
        '  - /data/1/kind: must be equal to "item"',
      ].join("\n"),
    );
    expect(error.message).not.toContain("SECRET");
    expect(error.message).not.toContain("yesterday");
  });

  it("escapes property names in paths and names the body itself (body)", () => {
    const problems = checker.check("listItems", { status: 200, body: { data: [], "a/b~c": 1 } });
    expect(problems.map((problem) => problem.path)).toEqual(["/a~1b~0c"]);
    const error = thrown(() => checker.expectToMatch("listItems", { status: 200, body: [] }));
    expect(error.message).toContain("\n  - (body): must be object");
  });

  it("uses a 4XX range and a default response when the exact status is not documented", () => {
    // 404 → 4XX → a $ref to a $ref with application/problem+json.
    expect(checker.check("listItems", { status: 404, body: { title: "Not found" } })).toEqual([]);
    expect(checker.check("listItems", { status: 422, body: {} })).toEqual([
      { path: "/title", keyword: "required", message: "required property is missing" },
    ]);
    // 503 → default, documented without content.
    expect(checker.check("listItems", { status: 503, body: {} })).toEqual([]);
    expect(checker.check("listItems", { status: 503, body: { title: "x" } })).toEqual([
      {
        path: "",
        keyword: "body",
        message: "the default response is documented without a body, but it has one",
      },
    ]);
  });

  it("finds a +json media type with parameters, and accepts any body without a schema", () => {
    expect(checker.check("createItem", { status: 201, body: ITEM })).toEqual([]);
    expect(checker.check("createItem", { status: 201, body: {} })).toHaveLength(4);
    expect(checker.check("createItem", { status: 202, body: { anything: true } })).toEqual([]);
    expect(checker.check("createItem", { status: 200, body: ITEM })).toEqual([
      {
        path: "",
        keyword: "status",
        message: "200 is not a documented status of createItem (documented: 201, 202)",
      },
    ]);
  });

  it("refuses responses it cannot check: no JSON content, unknown operations", () => {
    expect(thrown(() => checker.check("getItemPdf", { status: 200, body: "%PDF" })).message).toBe(
      "expectResponseToMatch: the 200 response of getItemPdf has no JSON content (application/pdf); " +
        "check its body another way",
    );
    expect(thrown(() => checker.check("deleteItem", { status: 204 })).message).toBe(
      'expectResponseToMatch: the fixture document has no operation "deleteItem"',
    );
  });

  it("lists at most 40 problems in the message and keeps them all on the error", () => {
    const many = createResponseChecker(
      {
        ...structuredClone(FIXTURE),
        components: {
          schemas: {
            ItemPage: {
              type: "object",
              required: Array.from({ length: 45 }, (_, i) => `p${i}`),
            },
          },
        },
      },
      { label: "fixture" },
    );
    const error = thrown(() =>
      many.expectToMatch("listItems", { status: 200, body: {} }),
    ) as ResponseMismatchError;
    expect(error.problems).toHaveLength(45);
    expect(error.message.split("\n")).toHaveLength(1 + 40 + 1);
    expect(error.message).toContain("\n  - /p39: required property is missing\n  - … and 5 more");
  });

  it("refuses documents it cannot check", () => {
    expect(
      thrown(() => createResponseChecker({ ...FIXTURE, openapi: "3.0.3" }, { label: "old" })).message,
    ).toBe("The old document is not OpenAPI 3.1, whose schemas are JSON Schema draft 2020-12");
    const externalRef = structuredClone(FIXTURE);
    (externalRef.components.schemas.Problem.properties as JsonObject)["title"] = {
      $ref: "other.yaml#/Title",
    };
    expect(thrown(() => createResponseChecker(externalRef, { label: "fixture" })).message).toBe(
      "The fixture document has a schema $ref that is not into components.schemas: other.yaml#/Title",
    );
    const typo = structuredClone(FIXTURE);
    (typo.components.schemas.Problem as JsonObject)["requried"] = ["title"];
    const strict = createResponseChecker(typo, { label: "fixture" });
    // Strict mode: a misspelt keyword fails when its schema is compiled, instead of being ignored.
    expect(thrown(() => strict.check("listItems", { status: 400, body: {} })).message).toContain(
      'strict mode: unknown keyword: "requried"',
    );
  });
});
