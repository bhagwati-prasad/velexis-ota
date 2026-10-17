// The origin and scope rules of API keys (PADR-0005 items 5 and 6): the matrix of valid and refused origins and
// scopes, the default scope of a secret key, and the lists of the OTA contract they are checked against.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@velexis/errors";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_DIR } from "../config";
import {
  apiKeyAccess,
  checkedApiKeyAccess,
  CONSOLE_API_KEY_SCOPES,
  DEFAULT_SECRET_KEY_SCOPES,
  MAX_ALLOWED_ORIGINS,
  originProblems,
  scopeProblems,
  STAFF_PERMISSIONS,
  type ApiKeyAccessRequest,
} from "./api-key-rules";

const OTA_DOCUMENT = join(
  APP_DIR,
  "..",
  "..",
  "ota",
  "backend",
  "openapi",
  "velexis-ota-booking-api.openapi.yaml",
);

/** The `enum` of the schema `name` of the OTA document: its block of `components.schemas`, parsed on its own. */
function otaEnum(document: string, name: string): unknown {
  const start = document.indexOf(`\n    ${name}:\n`);
  if (start < 0) {
    throw new Error(`the OTA document has no schema ${name}`);
  }
  const rest = document.slice(start + 1);
  const end = rest.slice(1).search(/\n {4}[A-Za-z]/);
  const block = parse(end < 0 ? rest : rest.slice(0, end + 1)) as Record<string, { enum?: unknown }>;
  return block[name]?.enum;
}

/** The field errors of `checkedApiKeyAccess(request)`, which must throw `VALIDATION_FAILED`. */
function refusal(request: ApiKeyAccessRequest): Array<{ path: string; code: string; message?: string }> {
  try {
    checkedApiKeyAccess(request);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe("VALIDATION_FAILED");
    return [...(appError.fieldErrors ?? [])];
  }
  throw new Error("checkedApiKeyAccess accepted the request");
}

describe("the lists of the OTA contract", () => {
  let document: string;

  // The OTA document is about 40,000 lines: it is read once, here. Only the two schema blocks are parsed.
  beforeAll(() => {
    document = readFileSync(OTA_DOCUMENT, "utf8");
  }, 30_000);

  it("are the enums of ConsoleApiKeyScope and StaffPermission in the OTA document, in its order", () => {
    expect([...CONSOLE_API_KEY_SCOPES]).toEqual(otaEnum(document, "ConsoleApiKeyScope"));
    expect([...STAFF_PERMISSIONS]).toEqual(otaEnum(document, "StaffPermission"));
    expect(Object.isFrozen(CONSOLE_API_KEY_SCOPES) && Object.isFrozen(STAFF_PERMISSIONS)).toBe(true);
  });
});

describe("origins of publishable keys", () => {
  it.each([
    ["https://www.acme-travel.com", "test"],
    ["https://book.acme-travel.example.com", "live"],
    ["https://acme.example.com:8443", "live"],
    ["https://127.0.0.1:8443", "test"],
    ["http://localhost:5173", "test"],
    ["http://127.0.0.1:3000", "test"],
  ] as const)("accepts %s on a %s key", (origin, environment) => {
    expect(originProblems([origin], environment)).toEqual([]);
  });

  it.each([
    ["https://*.acme.com", "test", "wildcard"],
    ["*", "test", "wildcard"],
    ["https://acme.*", "live", "wildcard"],
    ["http://localhost:5173", "live", "insecureOrigin"],
    ["http://127.0.0.1:3000", "live", "insecureOrigin"],
    ["http://localhost", "test", "insecureOrigin"],
    ["http://www.acme-travel.com", "test", "insecureOrigin"],
    ["http://[::1]:5173", "test", "insecureOrigin"],
    ["ftp://files.acme.com", "test", "insecureOrigin"],
    ["https://WWW.Acme-Travel.com", "live", "notCanonical"],
    ["https://acme.com:443", "live", "notCanonical"],
    ["https://user@acme.com", "live", "origin"],
    ["https://acme.com/", "live", "origin"],
    ["https://acme.com/shop", "live", "origin"],
    ["https://acme.com?x=1", "live", "origin"],
    ["https://", "live", "origin"],
    ["acme.com", "live", "origin"],
  ] as const)("refuses %s on a %s key (%s)", (origin, environment, code) => {
    const problems = originProblems(["https://ok.example.com", origin], environment);

    expect(problems.map(({ path, code: c }) => ({ path, code: c }))).toEqual([
      { path: "/allowedOrigins/1", code },
    ]);
  });

  it("never echoes a refused origin in a message", () => {
    const refused = [
      "https://*.secret-value-1.example.com",
      "http://secret-value-2.example.com",
      "https://Secret-Value-3.example.com",
      "https://secret-value-4.example.com/path",
      "https://secret-value-5.example.com:443",
    ];
    const problems = originProblems(refused, "test");

    expect(problems).toHaveLength(refused.length);
    expect(JSON.stringify(problems.map(({ message }) => message)).toLowerCase()).not.toContain(
      "secret-value",
    );
  });

  it(`refuses more than ${MAX_ALLOWED_ORIGINS} origins at the list's path`, () => {
    const origins = Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_, n) => `https://shop${n}.example.com`);

    expect(originProblems(origins.slice(0, MAX_ALLOWED_ORIGINS), "test")).toEqual([]);
    expect(originProblems(origins, "test")).toEqual([
      { path: "/allowedOrigins", code: "maxItems", message: "At most 20 origins are allowed." },
    ]);
  });

  it("[PBE-021 AC2] answers VALIDATION_FAILED for a publishable key with https://*.acme.com", () => {
    expect(
      refusal({ kind: "publishable", environment: "test", allowedOrigins: ["https://*.acme.com"] }),
    ).toEqual([
      {
        path: "/allowedOrigins/0",
        code: "wildcard",
        message: "Wildcards are not allowed: list each origin exactly.",
      },
    ]);
  });

  it("gives a publishable key its origins and no scopes; an empty list means no browser origin", () => {
    expect(
      checkedApiKeyAccess({
        kind: "publishable",
        environment: "test",
        allowedOrigins: ["https://www.acme-travel.com", "http://localhost:5173"],
      }),
    ).toEqual({ allowedOrigins: ["https://www.acme-travel.com", "http://localhost:5173"], scopes: [] });
    expect(checkedApiKeyAccess({ kind: "publishable", environment: "live" })).toEqual({
      allowedOrigins: [],
      scopes: [],
    });
    expect(checkedApiKeyAccess({ kind: "publishable", environment: "live", scopes: [] })).toEqual({
      allowedOrigins: [],
      scopes: [],
    });
  });

  it("refuses scopes on a publishable key, even storefront", () => {
    expect(
      refusal({ kind: "publishable", environment: "test", scopes: ["storefront"] }).map(({ path, code }) => ({
        path,
        code,
      })),
    ).toEqual([{ path: "/scopes", code: "notAllowed" }]);
  });
});

describe("scopes of secret keys", () => {
  it("gives a secret key without scopes (absent or empty) the default storefront scope", () => {
    expect(DEFAULT_SECRET_KEY_SCOPES).toEqual(["storefront"]);
    expect(checkedApiKeyAccess({ kind: "secret", environment: "test" })).toEqual({
      allowedOrigins: [],
      scopes: ["storefront"],
    });
    expect(checkedApiKeyAccess({ kind: "secret", environment: "live", scopes: [] }).scopes).toEqual([
      "storefront",
    ]);
  });

  it.each([
    [["storefront"]],
    [["console"]],
    [["console:automation", "bookings:read"]],
    [["console:automation", "bookings:read", "queues:read", "bookings:issue"]],
    [["console", "console:automation", "payments:refund"]],
  ])("accepts %j", (scopes) => {
    expect(scopeProblems(scopes)).toEqual([]);
    expect(checkedApiKeyAccess({ kind: "secret", environment: "test", scopes }).scopes).toEqual(scopes);
  });

  it.each([
    [["storefront", "console"], "/scopes", "scopeCombination"],
    [["storefront", "bookings:read"], "/scopes", "scopeCombination"],
    [["console", "bookings:read"], "/scopes", "scopeCombination"],
    [["bookings:read"], "/scopes", "scopeCombination"],
    [["console:automation"], "/scopes", "scopeCombination"],
    [["console", "console:automation"], "/scopes", "scopeCombination"],
    [["console", "admin:everything"], "/scopes/1", "unknownScope"],
    [["Storefront"], "/scopes/0", "unknownScope"],
  ])("refuses %j at %s (%s)", (scopes, path, code) => {
    const problems = scopeProblems(scopes);

    expect(problems.map((problem) => ({ path: problem.path, code: problem.code }))).toEqual([{ path, code }]);
    for (const scope of scopes.filter((value) => value.includes("admin") || value === "Storefront")) {
      expect(problems[0]?.message).not.toContain(scope);
    }
  });

  it("[PBE-021 AC2] answers VALIDATION_FAILED for a secret key with permissions but no console:automation", () => {
    expect(
      refusal({
        kind: "secret",
        environment: "test",
        scopes: ["console", "bookings:read", "bookings:issue"],
      }),
    ).toEqual([
      {
        path: "/scopes",
        code: "scopeCombination",
        message: "Permissions are allowed only together with console:automation.",
      },
    ]);
    expect(refusal({ kind: "secret", environment: "test", scopes: ["bookings:read"] })).toHaveLength(1);
  });

  it("refuses origins on a secret key, together with its scope problems", () => {
    const { access, fieldErrors } = apiKeyAccess({
      kind: "secret",
      environment: "test",
      allowedOrigins: ["https://www.acme-travel.com"],
      scopes: ["console:automation"],
    });

    expect(fieldErrors.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: "/allowedOrigins", code: "notAllowed" },
      { path: "/scopes", code: "scopeCombination" },
    ]);
    expect(access.allowedOrigins).toEqual([]);
  });
});
