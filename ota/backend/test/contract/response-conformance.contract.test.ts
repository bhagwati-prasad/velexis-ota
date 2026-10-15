// Response conformance (ADR-0006 "Checks in CI", ADR-0015): the responses the OTA document records, its examples,
// replayed through `expectResponseToMatch`, the check every integration test runs on the API's real answers; and the
// document's request, parameter and schema examples through the API's own request validators. An example that does
// not validate means the document contradicts itself, and the API would refuse (requests) or a test would reject
// (responses) data shaped like it.
//
// The Amadeus local date-times (`departure.at`, `lastTicketingDateTime`, …) carry no UTC offset, as Amadeus sends
// them; they are described by a local date-time pattern, not `format: date-time` (RFC 3339, offset required), which
// made twelve examples and real Amadeus data invalid (OBE-010).
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import { expectResponseToMatch } from "@velexis/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadOpenApiDocument,
  type OpenApiDocument,
} from "../../src/common/http/openapi-validation.interceptor";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One example of the document and where it is. */
interface Example {
  readonly where: string;
  readonly value: unknown;
}

let document: OpenApiDocument;

beforeAll(() => {
  document = loadOpenApiDocument();
});

/** The examples of a Media Type or Parameter Object: `example`, and the values of `examples` (refs resolved). */
function examplesOf(owner: JsonObject, where: string): Example[] {
  const found: Example[] = [];
  if ("example" in owner) {
    found.push({ where: `${where} example`, value: owner["example"] });
  }
  const examples = owner["examples"];
  if (isObject(examples)) {
    for (const [name, raw] of Object.entries(examples)) {
      const example = document.resolve(raw);
      if (isObject(example) && "value" in example) {
        found.push({ where: `${where} examples.${name}`, value: example["value"] });
      }
    }
  }
  return found;
}

/** The raw operation objects of the document, by id. */
function rawOperations(): Map<string, JsonObject> {
  const operations = new Map<string, JsonObject>();
  const paths = document.document["paths"] as JsonObject;
  for (const item of Object.values(paths)) {
    for (const value of Object.values(item as JsonObject)) {
      if (isObject(value) && typeof value["operationId"] === "string") {
        operations.set(value["operationId"], value);
      }
    }
  }
  return operations;
}

/** What replaying every response example gave: how many, of which operations, and the mismatches. */
interface Replay {
  readonly count: number;
  readonly operations: ReadonlySet<string>;
  readonly failures: readonly string[];
}

/** Every `application/json` example of every documented response, through `expectResponseToMatch`. */
function replayResponseExamples(): Replay {
  let count = 0;
  const operations = new Set<string>();
  const failures: string[] = [];
  for (const [operationId, operation] of rawOperations()) {
    for (const [status, raw] of Object.entries(operation["responses"] as JsonObject)) {
      const response = document.resolve(raw);
      const content = isObject(response) && isObject(response["content"]) ? response["content"] : {};
      const media = content["application/json"];
      if (!/^\d{3}$/.test(status) || !isObject(media)) {
        continue;
      }
      for (const example of examplesOf(media, `${operationId} ${status}`)) {
        try {
          expectResponseToMatch(operationId as OtaOperationId, {
            status: Number(status),
            body: example.value,
          });
        } catch (error) {
          failures.push(`${example.where}: ${error instanceof Error ? error.message : String(error)}`);
        }
        count += 1;
        operations.add(operationId);
      }
    }
  }
  return { count, operations, failures };
}

describe("response conformance", () => {
  let replay: Replay;

  // The check compiles one validator per documented response of every operation: about 2 s, and much longer on a
  // machine that runs every package's tests at once. That happens once, in this hook with its own budget (as
  // lint-rules.test.ts loads ESLint's configuration), so the tests below assert on its outcome.
  beforeAll(() => {
    replay = replayResponseExamples();
  }, 60_000);

  it("replays every response example of the OTA document through expectResponseToMatch", () => {
    expect(replay.failures).toEqual([]);
    // Every operation documents at least its error envelopes with examples.
    expect(replay.operations.size).toBe(otaOperations.length);
    expect(replay.count).toBeGreaterThan(1500);
  });

  it("accepts the Amadeus local date-times of the examples that RFC 3339 date-time refused", () => {
    // These are the examples that failed while the fields were `format: date-time`.
    const cases: ReadonlyArray<readonly [OtaOperationId, number, string]> = [
      ["getFlightOffer", 200, "example"],
      ["priceFlightOffers", 201, "examples.priced"],
      ["getPricedOffer", 200, "examples.priced"],
      ["consoleFindBookingByRecordLocator", 200, "examples.notImported"],
      ["consoleListQueue", 200, "example"],
      ["consoleAmadeusGetQueue", 200, "example"],
      ["consoleAmadeusGetFlightOrder", 200, "example"],
    ];
    const operations = rawOperations();
    for (const [operationId, status, name] of cases) {
      const response = document.resolve(
        (operations.get(operationId)?.["responses"] as JsonObject)[String(status)],
      );
      const media = ((response as JsonObject)["content"] as JsonObject)["application/json"] as JsonObject;
      const example = examplesOf(media, operationId).find((entry) => entry.where.endsWith(` ${name}`));
      expect(example, `${operationId} ${status} ${name}`).toBeDefined();
      expect(() => expectResponseToMatch(operationId, { status, body: example?.value })).not.toThrow();
    }
  });
});

describe("request and schema examples", () => {
  it("validates every request body example with the operation's body schema", () => {
    let checked = 0;
    for (const [operationId, operation] of rawOperations()) {
      const body = document.resolve(operation["requestBody"]);
      const media =
        isObject(body) && isObject(body["content"]) ? body["content"]["application/json"] : undefined;
      if (!isObject(media)) {
        continue;
      }
      const validate = document.compile(media["schema"]);
      for (const example of examplesOf(media, `${operationId} request`)) {
        expect([example.where, validate(example.value), validate.errors ?? []]).toEqual([
          example.where,
          true,
          [],
        ]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("validates every parameter example with the parameter's schema", () => {
    let checked = 0;
    for (const [operationId, operation] of rawOperations()) {
      for (const raw of (operation["parameters"] as unknown[] | undefined) ?? []) {
        const parameter = document.resolve(raw) as JsonObject;
        const validate = document.compile(parameter["schema"]);
        const where = `${operationId} ${String(parameter["in"])} ${String(parameter["name"])}`;
        const examples = [
          ...("example" in parameter ? [parameter["example"]] : []),
          ...(Array.isArray(parameter["examples"]) ? parameter["examples"] : []),
          ...examplesOf(
            { examples: isObject(parameter["examples"]) ? parameter["examples"] : {} },
            where,
          ).map((example) => example.value),
        ];
        for (const value of examples) {
          expect([where, validate(value)]).toEqual([where, true]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("validates every example of components.schemas with the schema that carries it", () => {
    const schemas = (document.document["components"] as JsonObject)["schemas"] as JsonObject;
    const failures: string[] = [];
    let checked = 0;
    const visit = (schema: unknown, pointer: string): void => {
      if (!isObject(schema)) {
        return;
      }
      const examples = [
        ...(Array.isArray(schema["examples"]) ? schema["examples"] : []),
        ...("example" in schema ? [schema["example"]] : []),
      ];
      if (examples.length > 0) {
        const validate = document.compile(schema);
        examples.forEach((value, index) => {
          checked += 1;
          if (!validate(value)) {
            failures.push(`${pointer} example ${index}`);
          }
        });
      }
      for (const keyword of ["properties", "patternProperties", "$defs", "dependentSchemas"]) {
        const children = schema[keyword];
        if (isObject(children)) {
          for (const [name, child] of Object.entries(children)) {
            visit(child, `${pointer}/${keyword}/${name}`);
          }
        }
      }
      for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
        const children = schema[keyword];
        if (Array.isArray(children)) {
          children.forEach((child, index) => visit(child, `${pointer}/${keyword}/${index}`));
        }
      }
      for (const keyword of ["items", "not", "if", "then", "else", "additionalProperties", "contains"]) {
        visit(schema[keyword], `${pointer}/${keyword}`);
      }
    };
    for (const [name, schema] of Object.entries(schemas)) {
      visit(schema, `#/components/schemas/${name}`);
    }

    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(300);
  });
});

describe("Amadeus local date-times", () => {
  /** The fields that carry an Amadeus local date-time, and their pattern (OBE-010). */
  const LOCAL_DATE_TIME_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["AmadeusAutomatedProcess", ["allOf", "1", "properties", "dateTime"]],
    ["AmadeusFlightEndPoint", ["allOf", "1", "properties", "at"]],
    ["AmadeusFlightOffer", ["properties", "lastTicketingDateTime"]],
    ["AmadeusFlightStop", ["allOf", "1", "properties", "arrivalAt"]],
    ["AmadeusFlightStop", ["allOf", "1", "properties", "departureAt"]],
    ["AmadeusPnr", ["allOf", "1", "properties", "creation", "properties", "dateTime"]],
    [
      "AmadeusPnr",
      [
        "allOf",
        "1",
        "properties",
        "products",
        "items",
        "properties",
        "airSegment",
        "properties",
        "segment",
        "properties",
        "arrival",
        "properties",
        "localDateTime",
      ],
    ],
  ];
  const LOCAL_DATE_TIME =
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})?$";

  function fieldSchema(schema: string, path: readonly string[]): JsonObject {
    let current: unknown = ((document.document["components"] as JsonObject)["schemas"] as JsonObject)[schema];
    for (const segment of path) {
      current = Array.isArray(current) ? current[Number(segment)] : (current as JsonObject)[segment];
    }
    return current as JsonObject;
  }

  it("describes the seven Amadeus local date-time fields with the local pattern, not format: date-time", () => {
    for (const [schema, path] of LOCAL_DATE_TIME_FIELDS) {
      const field = fieldSchema(schema, path);
      expect([schema, ...path, field["type"], field["pattern"], field["format"]]).toEqual([
        schema,
        ...path,
        "string",
        LOCAL_DATE_TIME,
        undefined,
      ]);
    }
  });

  it("leaves no format: date-time in an Amadeus schema and keeps it on the Velexis timestamps", () => {
    const schemas = (document.document["components"] as JsonObject)["schemas"] as JsonObject;
    const dateTimes = (value: unknown): number =>
      Array.isArray(value)
        ? value.reduce<number>((sum, item) => sum + dateTimes(item), 0)
        : isObject(value)
          ? Object.entries(value).reduce(
              (sum, [key, child]) => sum + (key === "format" && child === "date-time" ? 1 : dateTimes(child)),
              0,
            )
          : 0;

    for (const [name, schema] of Object.entries(schemas)) {
      if (name.startsWith("Amadeus")) {
        expect([name, dateTimes(schema)]).toEqual([name, 0]);
      }
    }
    expect(fieldSchema("Booking", ["properties", "createdAt"])["format"]).toBe("date-time");
    expect(fieldSchema("PricedOffer", ["properties", "expiresAt"])["format"]).toBe("date-time");
  });

  it("accepts local date-times as Amadeus writes them, and RFC 3339 date-times with Z or ±hh:mm", () => {
    const validate = document.compile(
      fieldSchema("AmadeusFlightEndPoint", ["allOf", "1", "properties", "at"]),
    );

    for (const value of [
      "2026-11-20T10:25:00",
      "2026-11-20T10:25",
      "2018-08-21T10:15:00.000",
      "2026-11-20T10:25:00Z",
      "2026-11-20T10:25:00.123+01:00",
      "2026-11-20T10:25:00-05:00",
    ]) {
      expect([value, validate(value)]).toEqual([value, true]);
    }
    for (const value of [
      "2026-11-20",
      "2026-11-20 10:25:00",
      "20261120T102500",
      "2026-11-20T10",
      "tomorrow",
    ]) {
      expect([value, validate(value)]).toEqual([value, false]);
    }
  });
});
