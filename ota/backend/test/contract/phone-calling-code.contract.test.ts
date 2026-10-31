// The phone's country calling code of the OTA document (FIX-W30-OTA, lead decision (1) of 2026-10-26): the document
// had copied Amadeus's `Phone.countryCallingCode` pattern `[0-9+]{2,5}`, which refuses the `1` of the United States,
// Canada and the rest of North America while Amadeus's own description gives `"1" for US`. `AmadeusPhone` is the one
// schema with `countryCallingCode`, reached by every phone a request can carry (checkout contacts and travellers,
// account.update's phone, saved travellers, the console's booking patch and create): its pattern is now one to three
// digits with an optional leading `+`. The bodies are checked here with the API's own request validators (Ajv on the
// document, as the validation interceptor runs them), and every example of the document still validates
// (response-conformance.contract.test.ts). The API's answers through the whole pipeline are in
// test/integration/checkout/checkout.int.test.ts and test/integration/account/account.int.test.ts.
import type { ValidateFunction } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadOpenApiDocument,
  toFieldErrors,
  type OpenApiDocument,
} from "../../src/common/http/openapi-validation.interceptor";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Codes a traveller or a contact may give: the US and Canada (`1`), with or without `+`, and longer ITU codes. */
const ACCEPTED = ["1", "+1", "7", "44", "+44", "353", "+371", "998"];
/** Letters, four digits and more, a `+` alone or twice, an empty value, spaces: never an ITU calling code. */
const REFUSED = ["", "+", "++1", "1+", "1a", "ab", "0044", "1234", "+1234", " 1", "1 ", "44-1"];

let document: OpenApiDocument;
/** AmadeusPhone's validator. */
let validPhone: ValidateFunction;
/**
 * The bodies of three operations that carry a phone, each built around one calling code, where its code is, and the
 * validator of the operation's request body.
 */
let bodies: ReadonlyArray<{
  readonly operationId: string;
  readonly path: string;
  readonly body: (code: string) => unknown;
  readonly validate: ValidateFunction;
}>;

/** The compiled validator of the request body of `operationId`. */
function bodyValidator(operationId: string): ValidateFunction {
  const schema = document.operation(operationId).body?.schema;
  if (schema === undefined) {
    throw new Error(`${operationId} has no request body`);
  }
  return document.compile(schema);
}

// Parsing the document and compiling its validators is one-time work (about 1.5 s, several times that on a loaded
// CI machine): here, with the budget the other contract tests give it.
beforeAll(() => {
  document = loadOpenApiDocument();
  validPhone = document.compile({ $ref: "#/components/schemas/AmadeusPhone" });
  bodies = [
    {
      operationId: "setCheckoutContacts",
      validate: bodyValidator("setCheckoutContacts"),
      path: "/contacts/0/phones/0/countryCallingCode",
      body: (code) => ({
        contacts: [{ phones: [{ deviceType: "MOBILE", countryCallingCode: code, number: "2025550143" }] }],
      }),
    },
    {
      operationId: "setCheckoutTravelers",
      validate: bodyValidator("setCheckoutTravelers"),
      path: "/travelers/0/contact/phones/0/countryCallingCode",
      body: (code) => ({
        travelers: [
          {
            travelerId: "1",
            contact: { phones: [{ deviceType: "MOBILE", countryCallingCode: code, number: "2025550143" }] },
          },
        ],
      }),
    },
    {
      operationId: "updateAccount",
      validate: bodyValidator("updateAccount"),
      path: "/phone/countryCallingCode",
      body: (code) => ({ phone: { deviceType: "MOBILE", countryCallingCode: code, number: "2025550143" } }),
    },
  ];
}, 60_000);

/** The field errors of `body` against a request body validator, as `[path, code]` pairs. */
function errorsOf(validate: ValidateFunction, body: unknown): [string, string][] {
  return validate(body) ? [] : toFieldErrors(validate.errors ?? []).map((error) => [error.path, error.code]);
}

/** The schemas of the document that declare a `countryCallingCode` property. */
function schemasWithCallingCode(): string[] {
  const components = isObject(document.document["components"]) ? document.document["components"] : {};
  const schemas = isObject(components["schemas"]) ? components["schemas"] : {};
  const found = new Set<string>();
  const walk = (name: string, value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(name, item));
    } else if (isObject(value)) {
      if (isObject(value["properties"]) && "countryCallingCode" in value["properties"]) {
        found.add(name);
      }
      Object.values(value).forEach((item) => walk(name, item));
    }
  };
  for (const [name, schema] of Object.entries(schemas)) {
    walk(name, schema);
  }
  return [...found].sort();
}

describe("the phone's country calling code (FIX-W30-OTA)", () => {
  it("[FIX-W30-OTA AC1] is declared by AmadeusPhone alone, with one to three digits and an optional leading +", () => {
    expect(schemasWithCallingCode()).toEqual(["AmadeusPhone"]);
    const phone = document.resolve({ $ref: "#/components/schemas/AmadeusPhone" }) as {
      properties: { countryCallingCode: { pattern: string } };
    };
    expect(phone.properties.countryCallingCode.pattern).toBe("^\\+?[0-9]{1,3}$");
    expect(
      ACCEPTED.filter((code) => !validPhone({ countryCallingCode: code, number: "2025550143" })),
    ).toEqual([]);
    expect(REFUSED.filter((code) => validPhone({ countryCallingCode: code, number: "2025550143" }))).toEqual(
      [],
    );
  });

  it("[FIX-W30-OTA AC1] lets a US contact (1) through checkout contacts, travellers and account.update", () => {
    for (const { operationId, body, validate } of bodies) {
      for (const code of ["1", "+1"]) {
        expect([operationId, code, errorsOf(validate, body(code))]).toEqual([operationId, code, []]);
      }
    }
  });

  it("[FIX-W30-OTA AC1] still refuses letters and four digits, with a field error on the code's path", () => {
    for (const { operationId, path, body, validate } of bodies) {
      for (const code of ["1a", "ab", "1234", "0044"]) {
        const errors = errorsOf(validate, body(code));
        expect([operationId, code, errors]).toEqual([
          operationId,
          code,
          expect.arrayContaining([[path, "pattern"]]),
        ]);
        // Nothing else is refused: account.update's `phone` (AmadeusPhone or null) adds only its `oneOf` on `/phone`.
        expect(errors.filter(([at]) => !path.startsWith(at))).toEqual([]);
      }
    }
  });
});
