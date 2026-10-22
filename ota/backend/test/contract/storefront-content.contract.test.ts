// Contract test of OBE-091: the content pages, storefront assets and their public endpoints of
// ota/docs/api-changes-console-and-internal.md §2.4, §2.5 and §4 in the OTA document
// (openapi/velexis-ota-booking-api.openapi.yaml), as OADR-0012 points 2, 3, 5 and 7 decide them.
//
// - The 8 console operations (`console.settings.pages.*`, `console.settings.assets.*`) with their `x-sdk-method`,
//   `x-permission` (`settings:read` or `settings:write`) and `x-milestone: M4`, and the 3 public ones:
//   `listStorefrontPages` and `getStorefrontPage` (`storefront.listPages`, `storefront.getPage`) and `getPublicAsset`
//   (`x-sdk-exclude`, no credential), with their pending entries (OBE-071, OBE-072).
// - Their schemas: the page and its Markdown subset, the block tree the storefront renders with `textContent`, the
//   asset with the kinds and types of migration 0002, the multipart upload, and `ASSET_INVALID` (422).
// - Their rows of ota/sdk/docs/extensions.md §3.1 and §3.2 and the two pending SDK methods.
//
// Requests are validated with the API's own validators (loadOpenApiDocument), responses with the checker every
// integration test uses; the pending routes are the API's own (createTestApp). Totals are asserted once, by OBE-075.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { components } from "@velexis/api-types";
import { otaOperations } from "@velexis/api-types/operations";
import { AppError, ERROR_CATALOGUE, OTA_ERROR_CODES, type ErrorCode } from "@velexis/errors";
import { responseChecker, type ResponseChecker } from "@velexis/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "../../src/common/auth/roles";
import { toRoutePath } from "../../src/common/http/not-implemented.controller";
import {
  loadOpenApiDocument,
  type OpenApiDocument,
  type RawRequest,
} from "../../src/common/http/openapi-validation.interceptor";
import { PENDING_OPERATIONS } from "../../src/common/http/pending-operations";
import { APP_DIR } from "../../src/config";
import { edgeHeaders } from "../helpers/api-env";
import { createTestApp, type TestApp } from "../support/create-test-app";

const REPO_ROOT = join(APP_DIR, "..", "..");
const EXTENSIONS_DOCUMENT = join(REPO_ROOT, "ota", "sdk", "docs", "extensions.md");
const SDK_PENDING_LIST = join(REPO_ROOT, "ota", "sdk", "test", "contract", "pending-namespaces.js");
/** The SDK's storefront namespace, which SDK-012 gives the two page methods. */
const SDK_STOREFRONT_NAMESPACE = join(REPO_ROOT, "ota", "sdk", "src", "namespaces", "storefront.js");
/** The migration that creates `storefront_pages` and `storefront_assets` (data-model-migration-0002.md). */
const MIGRATION_0002 = join(APP_DIR, "migrations", "tenant", "0002_add_mvp_tenant_deltas.sql");

/**
 * Parsing and compiling the 45,000-line document and starting the application (for its pending routes) take a few
 * seconds alone, and several times longer while Turborepo runs every package's tests at once on a CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;

type Json = Record<string, unknown>;
type Method = "get" | "post" | "patch" | "delete";

/** One operation of OBE-091, as api-changes part 2 §2.4, §2.5 and §4 list it, and the plan task that implements it. */
interface Expected {
  readonly operationId: string;
  readonly method: Method;
  readonly path: string;
  /** `null` for the plain image URL (`x-sdk-exclude`). */
  readonly sdkMethod: string | null;
  readonly scope: "console" | "both";
  readonly tag: "Console settings" | "Storefront";
  /** `null` for the public operations, which no console permission guards. */
  readonly permission: "settings:read" | "settings:write" | null;
  readonly task: "OBE-071" | "OBE-072";
}

const PAGES = "/v1/console/settings/pages";
const ASSETS = "/v1/console/settings/assets";

const consoleRow = (
  operationId: string,
  method: Method,
  path: string,
  sdkMethod: string,
  permission: "settings:read" | "settings:write",
  task: Expected["task"],
): Expected => ({
  operationId,
  method,
  path,
  sdkMethod,
  scope: "console",
  tag: "Console settings",
  permission,
  task,
});

/** The 11 operations of OBE-091: 5 page and 3 asset operations of the console, 3 public ones. */
const OBE_091_OPERATIONS: readonly Expected[] = [
  // §2.4 Content pages
  consoleRow(
    "consoleListStorefrontPages",
    "get",
    PAGES,
    "console.settings.pages.list",
    "settings:read",
    "OBE-072",
  ),
  consoleRow(
    "consoleCreateStorefrontPage",
    "post",
    PAGES,
    "console.settings.pages.create",
    "settings:write",
    "OBE-072",
  ),
  consoleRow(
    "consoleGetStorefrontPage",
    "get",
    `${PAGES}/{pageId}`,
    "console.settings.pages.get",
    "settings:read",
    "OBE-072",
  ),
  consoleRow(
    "consoleUpdateStorefrontPage",
    "patch",
    `${PAGES}/{pageId}`,
    "console.settings.pages.update",
    "settings:write",
    "OBE-072",
  ),
  consoleRow(
    "consoleDeleteStorefrontPage",
    "delete",
    `${PAGES}/{pageId}`,
    "console.settings.pages.delete",
    "settings:write",
    "OBE-072",
  ),
  // §2.5 Storefront assets
  consoleRow(
    "consoleListStorefrontAssets",
    "get",
    ASSETS,
    "console.settings.assets.list",
    "settings:read",
    "OBE-071",
  ),
  consoleRow(
    "consoleUploadStorefrontAsset",
    "post",
    ASSETS,
    "console.settings.assets.upload",
    "settings:write",
    "OBE-071",
  ),
  consoleRow(
    "consoleDeleteStorefrontAsset",
    "delete",
    `${ASSETS}/{assetId}`,
    "console.settings.assets.delete",
    "settings:write",
    "OBE-071",
  ),
  // §4.1 Pages, §4.2 Assets
  {
    operationId: "listStorefrontPages",
    method: "get",
    path: "/v1/storefront/pages",
    sdkMethod: "storefront.listPages",
    scope: "both",
    tag: "Storefront",
    permission: null,
    task: "OBE-072",
  },
  {
    operationId: "getStorefrontPage",
    method: "get",
    path: "/v1/storefront/pages/{slug}",
    sdkMethod: "storefront.getPage",
    scope: "both",
    tag: "Storefront",
    permission: null,
    task: "OBE-072",
  },
  {
    operationId: "getPublicAsset",
    method: "get",
    path: "/v1/assets/{tenantKey}/{assetId}.{ext}",
    sdkMethod: null,
    scope: "both",
    tag: "Storefront",
    permission: null,
    task: "OBE-071",
  },
];

const CONSOLE_OPERATIONS = OBE_091_OPERATIONS.filter(({ scope }) => scope === "console");

/** The error codes every console operation can answer (api-changes part 2 §1, OADR-0011). */
const CONSOLE_ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "INVALID_API_KEY",
  "TOKEN_EXPIRED",
  "FORBIDDEN",
  "SCOPE_NOT_ALLOWED",
  "TENANT_SUSPENDED",
  "STAFF_MEMBERSHIP_INACTIVE",
  "ENVIRONMENT_NOT_ALLOWED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
];

const IDEMPOTENCY = { "idempotency-key": "6a0c2f4e-8b1d-4d3a-9e5f-7c2b1a0d9e8f" };
const IF_MATCH = { "if-match": '"4"' };
const PAGE_ID = "stp_01JA7Q1S3U5W7Y9A1C3E5G7J9L";
const ASSET_ID = "ast_01JA6B2C3D4E5F6G7H8J9K0M1N";

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

let document: OpenApiDocument;
let working: Json;
let checker: ResponseChecker;
let migration: string;

beforeAll(() => {
  document = loadOpenApiDocument();
  working = document.document as Json;
  checker = responseChecker("ota");
  migration = readFileSync(MIGRATION_0002, "utf8");
}, SETUP_TIMEOUT_MS);

/** The raw operation object of the document at `method` `path`. */
function specOf(expected: Pick<Expected, "method" | "path">): Json {
  return objectAt(working, "paths", expected.path, expected.method);
}

function operation(operationId: string): Json {
  const expected = OBE_091_OPERATIONS.find((candidate) => candidate.operationId === operationId);
  if (expected === undefined) {
    throw new Error(`${operationId} is not an operation of OBE-091`);
  }
  return specOf(expected);
}

const schemaOf = (name: string): Json => objectAt(working, "components", "schemas", name);

/** The component parameters an operation references, by component name, and its inline ones by `in:name`. */
function parametersOf(spec: Json): string[] {
  return ((spec["parameters"] as Json[] | undefined) ?? []).map((parameter) =>
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

/** The JSON request example `name` of an operation. */
function requestExample(operationId: string, name: string): unknown {
  return objectAt(operation(operationId), "requestBody", "content", "application/json", "examples", name)[
    "value"
  ];
}

/** The value of `components.examples.<name>`. */
const componentExample = (name: string): Json => objectAt(working, "components", "examples", name, "value");

/** The value of the example `name` of a component response. */
const responseExample = (response: string, name: string): Json =>
  objectAt(
    working,
    "components",
    "responses",
    response,
    "content",
    "application/json",
    "examples",
    name,
    "value",
  );

/** The values of a `CHECK (<column> IN ('a','b'))` of a table of migration 0002. */
function checkValues(table: string, column: string): string[] {
  const start = migration.indexOf(`CREATE TABLE ${table} (`);
  const block = migration.slice(start, migration.indexOf(");\n", start));
  const match = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(block);
  if (start < 0 || match === null) {
    throw new Error(`migration 0002 has no CHECK of ${table}.${column}`);
  }
  return [...(match[1] ?? "").matchAll(/'([^']+)'/g)].map((value) => value[1] ?? "");
}

describe("the 11 operations of OBE-091 (api-changes part 2 §2.4, §2.5, §4)", () => {
  it("adds each operation with its x-sdk-method, x-scope, x-permission and x-milestone M4 [OBE-091 AC1]", () => {
    expect(OBE_091_OPERATIONS).toHaveLength(11);
    expect(new Set(OBE_091_OPERATIONS.map(({ operationId }) => operationId)).size).toBe(11);
    for (const expected of OBE_091_OPERATIONS) {
      const spec = specOf(expected);
      expect([expected.path, expected.method, spec["operationId"]]).toEqual([
        expected.path,
        expected.method,
        expected.operationId,
      ]);
      expect([expected.operationId, spec]).toEqual([
        expected.operationId,
        expect.objectContaining({
          "x-scope": expected.scope,
          "x-milestone": "M4",
          "x-amadeus": [],
          tags: [expected.tag],
        }),
      ]);
      expect([expected.operationId, spec["x-sdk-method"], spec["x-permission"]]).toEqual([
        expected.operationId,
        expected.sdkMethod ?? undefined,
        expected.permission ?? undefined,
      ]);
      // The operations index carries the same, for the scope and permission guards (OBE-013, OBE-060).
      expect(otaOperations.find((entry) => entry.operationId === expected.operationId)).toEqual({
        operationId: expected.operationId,
        method: expected.method,
        path: expected.path,
        sdkMethod: expected.sdkMethod,
        scope: expected.scope,
        tags: [expected.tag],
        internal: false,
        milestone: "M4",
        edgeOnly: false,
        permission: expected.permission,
      });
    }
    // The tags say what they now hold.
    const tags = new Map((working["tags"] as Json[]).map((tag) => [tag["name"], String(tag["description"])]));
    expect(tags.get("Console settings")).toContain("content pages and uploaded images");
    expect(tags.get("Storefront")).toEqual(
      expect.stringContaining("storefront.listPages and storefront.getPage"),
    );
    expect(tags.get("Storefront")).toContain("getPublicAsset");
  });

  it("gives the console operations the console credentials, headers, errors and staff_actions; settings:write is the owner's and admin's [OBE-091 AC1]", () => {
    for (const expected of CONSOLE_OPERATIONS) {
      const spec = specOf(expected);
      // A staff token with the service or a secret key, or a console:automation key alone.
      expect([expected.operationId, spec["security"]]).toEqual([
        expected.operationId,
        [{ apiKey: [], staffAuth: [] }, { apiKey: [] }],
      ]);
      expect([expected.operationId, parametersOf(spec)]).toEqual([
        expected.operationId,
        expect.arrayContaining(["VelexisEnvironment", "CustomerEndUserIp", "CustomerEndUserAgent"]),
      ]);
      expect([expected.operationId, spec["x-error-codes"]]).toEqual([
        expected.operationId,
        expect.arrayContaining(CONSOLE_ERROR_CODES),
      ]);
      // Changes and refused calls write staff_actions (OADR-0011 point 8 as decided on 2026-10-21).
      expect([expected.operationId, spec["x-tenant-tables"]]).toEqual([
        expected.operationId,
        expect.arrayContaining(["staff_actions"]),
      ]);
      expect([expected.operationId, objectAt(spec, "responses", "403")]).toEqual([
        expected.operationId,
        { $ref: "#/components/responses/ConsoleForbidden" },
      ]);
      const audit =
        expected.permission === "settings:read" ? "Not audited per call." : "`staff_actions` records";
      expect([expected.operationId, String(spec["description"])]).toEqual([
        expected.operationId,
        expect.stringContaining(audit),
      ]);
    }
    // scope §1.3: every role reads the settings, only owner and admin change them.
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect([role, permissions.includes("settings:read")]).toEqual([role, true]);
      expect([role, permissions.includes("settings:write")]).toEqual([
        role,
        ["owner", "admin"].includes(role),
      ]);
    }
  });

  it("takes If-Match on page updates and deletes, an Idempotency-Key on creates and uploads, and returns the page version as ETag [OBE-091 AC1]", () => {
    for (const operationId of ["consoleUpdateStorefrontPage", "consoleDeleteStorefrontPage"]) {
      expect([operationId, parametersOf(operation(operationId))]).toEqual([
        operationId,
        expect.arrayContaining(["IfMatch"]),
      ]);
      expect([operationId, "412" in objectAt(operation(operationId), "responses")]).toEqual([
        operationId,
        true,
      ]);
    }
    expect(
      problems("consoleUpdateStorefrontPage", { params: { pageId: PAGE_ID }, ...withBody({ title: "FAQ" }) }),
    ).toEqual(["/header/If-Match required"]);
    expect(
      problems("consoleDeleteStorefrontPage", { params: { pageId: PAGE_ID }, headers: IF_MATCH }),
    ).toEqual([]);
    // Assets never change: no If-Match on their delete.
    expect(parametersOf(operation("consoleDeleteStorefrontAsset"))).not.toContain("IfMatch");
    expect(problems("consoleDeleteStorefrontAsset", { params: { assetId: ASSET_ID } })).toEqual([]);

    for (const operationId of ["consoleCreateStorefrontPage", "consoleUploadStorefrontAsset"]) {
      expect([operationId, parametersOf(operation(operationId))]).toEqual([
        operationId,
        expect.arrayContaining(["IdempotencyKey"]),
      ]);
      expect([operationId, "201" in objectAt(operation(operationId), "responses")]).toEqual([
        operationId,
        true,
      ]);
    }
    expect(
      problems(
        "consoleCreateStorefrontPage",
        withBody(requestExample("consoleCreateStorefrontPage", "terms")),
      ),
    ).toEqual(["/header/Idempotency-Key required"]);
    expect(objectAt(operation("consoleCreateStorefrontPage"), "responses", "201", "headers")).toMatchObject({
      ETag: { $ref: "#/components/headers/ETag" },
      Location: { $ref: "#/components/headers/Location" },
    });
    for (const operationId of ["consoleGetStorefrontPage", "consoleUpdateStorefrontPage"]) {
      expect([operationId, objectAt(operation(operationId), "responses", "200", "headers")]).toEqual([
        operationId,
        expect.objectContaining({ ETag: { $ref: "#/components/headers/ETag" } }),
      ]);
    }
    // The path ids are the migration's prefixes.
    expect(problems("consoleGetStorefrontPage", { params: { pageId: "pag_1" } })).toEqual([
      "/path/pageId pattern",
    ]);
    expect(
      problems("consoleDeleteStorefrontAsset", { params: { assetId: "stp_01JA7Q1S3U5W7Y9A1C3E5G7J9L" } }),
    ).toEqual(["/path/assetId pattern"]);
  });

  it("lists the 11 operations in pending-operations.ts with OBE-071 and OBE-072 until those are done [OBE-091 AC1]", () => {
    // A task that implements its operations removes their entries (pending-operations.ts); route parity
    // (route-parity.contract.test.ts) then requires their handlers.
    const implemented: ReadonlySet<Expected["task"]> = new Set<Expected["task"]>();
    for (const { operationId, task } of OBE_091_OPERATIONS) {
      expect([operationId, PENDING_OPERATIONS[operationId as keyof typeof PENDING_OPERATIONS]]).toEqual([
        operationId,
        implemented.has(task) ? undefined : task,
      ]);
    }
  });

  describe("their routes", () => {
    let api: TestApp;

    // Starting the application compiles the whole document and every module: its own budget (see SETUP_TIMEOUT_MS).
    beforeAll(async () => {
      api = await createTestApp();
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await api?.close();
    });

    it("answers 501 NOT_IMPLEMENTED on the pending routes, the asset URL with its extension included [OBE-091 AC1]", async () => {
      // The public asset's last segment holds two parameters (`{assetId}.{ext}`, `:assetId.:ext` for Express).
      expect(toRoutePath("/v1/assets/{tenantKey}/{assetId}.{ext}")).toBe(
        "/v1/assets/:tenantKey/:assetId.:ext",
      );
      const urls: ReadonlyArray<readonly [string, string]> = [
        ["getPublicAsset", `/v1/assets/acme/${ASSET_ID}.png`],
        ["listStorefrontPages", "/v1/storefront/pages?locale=en"],
        ["getStorefrontPage", "/v1/storefront/pages/terms"],
      ];
      for (const [operationId, url] of urls) {
        const res = await request(api.server).get(url).set(edgeHeaders());
        expect([operationId, res.status, (res.body as Json)["error"]]).toEqual([
          operationId,
          501,
          expect.objectContaining({ code: "NOT_IMPLEMENTED", details: { milestone: "M4", operationId } }),
        ]);
      }
    });
  });
});

describe("content pages (§2.4, §4.1; OADR-0012 points 5 and 7)", () => {
  it("defines StorefrontPage, StorefrontPageInput and StorefrontPageUpdate as §2.4 sketches them [OBE-091 AC1]", () => {
    expect(schemaOf("StorefrontPage")["required"]).toEqual([
      "id",
      "slug",
      "locale",
      "kind",
      "title",
      "bodyMarkdown",
      "isPublished",
      "showInFooter",
      "sortOrder",
      "publishedAt",
      "version",
      "createdAt",
      "updatedAt",
    ]);
    // The kinds and the slug rule of the table (migration 0002).
    expect(schemaOf("StorefrontPageKind")["enum"]).toEqual(checkValues("storefront_pages", "kind"));
    expect(schemaOf("StorefrontPageSlug")).toMatchObject({
      pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
      maxLength: 64,
    });
    expect(migration).toContain("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 64");
    expect(schemaOf("StorefrontPageMarkdown")["maxLength"]).toBe(50_000);
    expect(objectAt(schemaOf("StorefrontPage"), "properties", "title")).toMatchObject({ maxLength: 120 });
    // The Markdown subset, rule by rule (OADR-0012 point 5).
    const subset = String(schemaOf("StorefrontPageMarkdown")["description"]);
    for (const rule of [
      "`##`, `###` and `####`",
      "`https:`, `mailto:` or `tel:`",
      "`/p/<slug>`",
      "`page_image`",
    ]) {
      expect([rule, subset.includes(rule)]).toEqual([rule, true]);
    }
    expect(subset).toContain('`details.reason = "markdown_not_allowed"` and the 1-based `details.line`');
    expect(subset).toContain("HTML, tables, code");
    expect(subset).toContain("`javascript:`");
    // The block tree's limits on `alt` and `href` are limits of the subset, so a saved body never parses into a
    // block that storefront.getPage's schema refuses.
    const altLimit = objectAt(schemaOf("StorefrontPageImageBlock"), "properties", "alt")["maxLength"];
    const hrefLimit = objectAt(schemaOf("StorefrontPageLink"), "properties", "href")["maxLength"];
    expect([altLimit, hrefLimit]).toEqual([300, 2048]);
    expect(subset).toContain(`an alt text of at most ${String(altLimit)} characters`);
    expect(subset).toContain(`URL of at most ${String(hrefLimit)} characters`);

    // create: slug, locale and title; update: any subset of the writable fields, slug and locale fixed.
    expect(schemaOf("StorefrontPageInput")).toMatchObject({
      additionalProperties: false,
      required: ["slug", "locale", "title"],
    });
    const update = schemaOf("StorefrontPageUpdate");
    expect(update).toMatchObject({ additionalProperties: false, minProperties: 1 });
    expect(Object.keys(objectAt(update, "properties"))).toEqual([
      "kind",
      "title",
      "bodyMarkdown",
      "isPublished",
      "showInFooter",
      "sortOrder",
    ]);
    // The generated types follow (this compiles only while they do).
    const input: components["schemas"]["StorefrontPageInput"] = {
      slug: "terms",
      locale: "en",
      title: "Terms",
    };
    const kind: components["schemas"]["StorefrontPageKind"] = "refund_policy";
    expect([input.slug, kind]).toEqual(["terms", "refund_policy"]);

    for (const name of ["terms", "draft"]) {
      expect([
        name,
        problems(
          "consoleCreateStorefrontPage",
          withBody(requestExample("consoleCreateStorefrontPage", name), IDEMPOTENCY),
        ),
      ]).toEqual([name, []]);
    }
    const page = { slug: "terms", locale: "en", title: "Terms" };
    expect(
      problems("consoleCreateStorefrontPage", withBody({ ...page, slug: "Terms_1" }, IDEMPOTENCY)),
    ).toEqual(["/slug pattern"]);
    expect(
      problems(
        "consoleCreateStorefrontPage",
        withBody({ ...page, bodyMarkdown: "x".repeat(50_001) }, IDEMPOTENCY),
      ),
    ).toEqual(["/bodyMarkdown maxLength"]);
    expect(problems("consoleCreateStorefrontPage", withBody({ ...page, kind: "blog" }, IDEMPOTENCY))).toEqual(
      ["/kind enum"],
    );
    const params = { params: { pageId: PAGE_ID } };
    for (const name of ["publish", "retitle"]) {
      expect([
        name,
        problems("consoleUpdateStorefrontPage", {
          ...params,
          ...withBody(requestExample("consoleUpdateStorefrontPage", name), IF_MATCH),
        }),
      ]).toEqual([name, []]);
    }
    expect(
      problems("consoleUpdateStorefrontPage", { ...params, ...withBody({ slug: "faq" }, IF_MATCH) }),
    ).toEqual(["/slug additionalProperties"]);
    expect(problems("consoleUpdateStorefrontPage", { ...params, ...withBody({}, IF_MATCH) })).toEqual([
      " minProperties",
    ]);

    expect(
      checker.check("consoleGetStorefrontPage", {
        status: 200,
        body: componentExample("StorefrontPageExample"),
      }),
    ).toEqual([]);
    expect(
      checker.check("consoleListStorefrontPages", {
        status: 200,
        body: componentExample("StorefrontPagePageExample"),
      }),
    ).toEqual([]);
    expect(
      problems("consoleListStorefrontPages", { query: { locale: "fr", published: "false", limit: "50" } }),
    ).toEqual([]);
  });

  it("answers 409 CONFLICT page_exists and page_linked and 422 UNPROCESSABLE with details.reason and details.line [OBE-091 AC1]", () => {
    expect(objectAt(operation("consoleCreateStorefrontPage"), "responses")).toMatchObject({
      "409": { $ref: "#/components/responses/StorefrontPageConflict" },
      "422": { $ref: "#/components/responses/StorefrontPageUnprocessable" },
    });
    expect(objectAt(operation("consoleUpdateStorefrontPage"), "responses", "422")).toEqual({
      $ref: "#/components/responses/StorefrontPageUnprocessable",
    });
    expect(objectAt(operation("consoleDeleteStorefrontPage"), "responses", "409")).toEqual({
      $ref: "#/components/responses/StorefrontPageConflict",
    });
    const conflicts = {
      CONFLICT: ["consoleCreateStorefrontPage", "page_exists"],
      CONFLICT_PAGE_LINKED: ["consoleDeleteStorefrontPage", "page_linked"],
    } as const;
    for (const [name, [operationId, reason]] of Object.entries(conflicts)) {
      const body = responseExample("StorefrontPageConflict", name);
      expect([name, objectAt(body, "error")["code"], objectAt(body, "error", "details")["reason"]]).toEqual([
        name,
        "CONFLICT",
        reason,
      ]);
      expect([name, checker.check(operationId, { status: 409, body })]).toEqual([name, []]);
    }
    const refusals = {
      UNPROCESSABLE: "markdown_not_allowed",
      UNPROCESSABLE_ASSET_KIND: "asset_kind",
      UNPROCESSABLE_LOCALE: "locale_not_supported",
    } as const;
    for (const [name, reason] of Object.entries(refusals)) {
      const body = responseExample("StorefrontPageUnprocessable", name);
      expect([name, objectAt(body, "error", "details")["reason"]]).toEqual([name, reason]);
      expect([name, checker.check("consoleUpdateStorefrontPage", { status: 422, body })]).toEqual([name, []]);
    }
    // A Markdown refusal names its line.
    expect(
      objectAt(responseExample("StorefrontPageUnprocessable", "UNPROCESSABLE"), "error", "details"),
    ).toEqual({
      reason: "markdown_not_allowed",
      line: 7,
    });
    const create = String(operation("consoleCreateStorefrontPage")["description"]);
    for (const reason of [
      "locale_not_supported",
      "markdown_not_allowed",
      "asset_not_found",
      "asset_kind",
      "page_exists",
    ]) {
      expect([reason, create.includes(`${reason}`)]).toEqual([reason, true]);
    }
    const deletion = String(operation("consoleDeleteStorefrontPage")["description"]).replace(/\s+/g, " ");
    expect(deletion).toContain("`legal.links[].pageSlug`");
    // OADR-0012 point 6: a linked page cannot be deleted, whichever locale it is in (a legal link names a slug).
    expect(deletion).toContain("cannot be deleted, in any locale");
    expect(operation("consoleCreateStorefrontPage")["x-error-codes"]).toEqual(
      expect.arrayContaining(["CONFLICT", "IDEMPOTENCY_KEY_REUSED", "UNPROCESSABLE"]),
    );
  });

  it("serves the published pages to the storefront by key or edge, in the request's locale [OBE-091 AC1]", () => {
    for (const operationId of ["listStorefrontPages", "getStorefrontPage"]) {
      const spec = operation(operationId);
      // Anonymous like storefront.get: a key, or the hosted storefront's edge (api-changes §2).
      expect([operationId, spec["security"]]).toEqual([
        operationId,
        [{ apiKey: [] }, { storefrontEdge: [] }],
      ]);
      expect([operationId, spec["x-error-codes"]]).toEqual([
        operationId,
        expect.arrayContaining(["HOST_NOT_ALLOWED", "TENANT_SUSPENDED", "INVALID_API_KEY"]),
      ]);
      expect([operationId, parametersOf(spec)]).toEqual([
        operationId,
        expect.arrayContaining(["StorefrontPageLocale", "AcceptLanguage", "StorefrontHostHeader"]),
      ]);
      // Reads: no CSRF header (api-changes §2.3).
      expect(parametersOf(spec)).not.toContain("CsrfToken");
      expect([operationId, spec["x-tenant-tables"]]).toEqual([
        operationId,
        expect.arrayContaining(["storefront_pages", "storefront_settings"]),
      ]);
      // Cached per tenant, environment and locale for 5 minutes, deleted on page changes (OADR-0012 point 7).
      expect([operationId, String(spec["description"])]).toEqual([
        operationId,
        expect.stringContaining("for 5 minutes"),
      ]);
    }
    expect(objectAt(working, "components", "parameters", "StorefrontPageLocale")).toMatchObject({
      name: "locale",
      in: "query",
      required: false,
      schema: { $ref: "#/components/schemas/LocaleCode" },
    });
    expect(objectAt(operation("getStorefrontPage"), "responses", "404")).toEqual({
      $ref: "#/components/responses/NotFound",
    });
    // The list holds what §4.1 lists, nothing of the page body.
    expect(Object.keys(objectAt(schemaOf("StorefrontPageSummary"), "properties"))).toEqual([
      "slug",
      "title",
      "kind",
      "showInFooter",
      "sortOrder",
    ]);
    expect(schemaOf("StorefrontPageContent")["required"]).toEqual([
      "slug",
      "locale",
      "title",
      "kind",
      "blocks",
      "updatedAt",
    ]);
    const list = objectAt(
      operation("listStorefrontPages"),
      "responses",
      "200",
      "content",
      "application/json",
    )["example"];
    expect(checker.check("listStorefrontPages", { status: 200, body: list })).toEqual([]);
    expect(problems("getStorefrontPage", { params: { slug: "terms" }, query: { locale: "fr-CA" } })).toEqual(
      [],
    );
    expect(problems("getStorefrontPage", { params: { slug: "../terms" } })).toEqual(["/path/slug pattern"]);
  });

  it("gives the storefront the body as a block tree that holds no HTML, with safe links and caller-specific image URLs [OBE-091 AC1]", () => {
    const tree = (name: string): string[] =>
      ((schemaOf(name)["oneOf"] as Json[]) ?? []).map((variant) =>
        String(variant["$ref"]).replace("#/components/schemas/", ""),
      );
    const typeOf = (name: string): unknown => objectAt(schemaOf(name), "properties", "type")["enum"];
    // §4.1: heading, paragraph, list, image, with inline text, strong, em, link.
    expect(tree("StorefrontPageBlock").map(typeOf)).toEqual([
      ["heading"],
      ["paragraph"],
      ["list"],
      ["image"],
    ]);
    expect(tree("StorefrontPageInline").map(typeOf)).toEqual([["text"], ["strong"], ["em"], ["link"]]);
    for (const name of [
      ...tree("StorefrontPageBlock"),
      ...tree("StorefrontPageInline"),
      "StorefrontPageListItem",
    ]) {
      expect([name, schemaOf(name)["additionalProperties"]]).toEqual([name, false]);
    }
    expect(objectAt(schemaOf("StorefrontPageHeadingBlock"), "properties", "level")).toMatchObject({
      minimum: 2,
      maximum: 4,
    });

    const page = componentExample("StorefrontPageContentExample");
    expect(checker.check("getStorefrontPage", { status: 200, body: page })).toEqual([]);
    const blocks = page["blocks"] as Json[];
    expect(blocks.map((block) => block["type"])).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
      "heading",
      "list",
      "image",
    ]);
    const withBlock = (block: unknown): Json => ({ ...page, blocks: [block] });
    const paragraph = (inline: unknown): Json => withBlock({ type: "paragraph", content: [inline] });
    const link = (href: string): Json =>
      paragraph({ type: "link", href, content: [{ type: "text", text: "click" }] });
    // Nothing that is not a block of the subset, and no HTML anywhere.
    for (const [label, body] of [
      ["an HTML block", withBlock({ type: "html", html: "<p>x</p>" })],
      ["a level-1 heading", withBlock({ type: "heading", level: 1, content: [{ type: "text", text: "x" }] })],
      ["a level-5 heading", withBlock({ type: "heading", level: 5, content: [{ type: "text", text: "x" }] })],
      ["an html field on text", paragraph({ type: "text", text: "x", html: "<b>x</b>" })],
      ["a code span", paragraph({ type: "code", text: "x" })],
      ["a javascript: link", link("javascript:alert(1)")],
      ["a data: link", link("data:text/html,x")],
      ["an http: link", link("http://example.com/")],
      ["another relative link", link("/checkout")],
      ["an empty paragraph", withBlock({ type: "paragraph", content: [] })],
    ] as const) {
      expect([label, checker.check("getStorefrontPage", { status: 200, body }).length > 0]).toEqual([
        label,
        true,
      ]);
    }
    for (const href of [
      "https://www.acmetravel.com/",
      "mailto:help@acmetravel.com",
      "tel:+442071234567",
      "/p/faq",
    ]) {
      expect([href, checker.check("getStorefrontPage", { status: 200, body: link(href) })]).toEqual([
        href,
        [],
      ]);
    }
    // The edge gets a same-origin image path, key callers an absolute URL (OADR-0012 point 3).
    const image = blocks[6] as Json;
    const edgeImage = { ...image, url: `/api/v1/assets/acme/${String(image["assetId"])}.jpg` };
    expect(checker.check("getStorefrontPage", { status: 200, body: withBlock(edgeImage) })).toEqual([]);
    expect(
      String(objectAt(schemaOf("StorefrontPageImageBlock"), "properties", "url")["description"]),
    ).toContain("/api/v1/assets/<tenantKey>/<assetId>.<ext>");
  });
});

describe("storefront assets (§2.5, §4.2; OADR-0012 points 2 and 3)", () => {
  it("defines StorefrontAsset with the kinds and types of migration 0002, and lists and deletes them [OBE-091 AC1]", () => {
    expect(schemaOf("StorefrontAsset")["required"]).toEqual([
      "id",
      "kind",
      "contentType",
      "sizeBytes",
      "width",
      "height",
      "fileName",
      "url",
      "createdAt",
    ]);
    expect(schemaOf("StorefrontAssetKind")["enum"]).toEqual(checkValues("storefront_assets", "kind"));
    const properties = objectAt(schemaOf("StorefrontAsset"), "properties");
    // No SVG, no CSS: the four image types of the table.
    expect(objectAt(properties, "contentType")["enum"]).toEqual(
      checkValues("storefront_assets", "content_type"),
    );
    expect(objectAt(properties, "contentType")["enum"]).not.toContain("image/svg+xml");
    expect(objectAt(properties, "sizeBytes")).toMatchObject({ minimum: 1, maximum: 1_048_576 });
    expect(migration).toContain("CHECK (size_bytes BETWEEN 1 AND 1048576)");
    expect(objectAt(properties, "fileName")).toMatchObject({ maxLength: 200 });
    const kind: components["schemas"]["StorefrontAssetKind"] = "page_image";
    expect(kind).toBe("page_image");

    expect(
      checker.check("consoleUploadStorefrontAsset", {
        status: 201,
        body: componentExample("StorefrontAssetExample"),
      }),
    ).toEqual([]);
    expect(
      checker.check("consoleListStorefrontAssets", {
        status: 200,
        body: componentExample("StorefrontAssetPageExample"),
      }),
    ).toEqual([]);
    expect(problems("consoleListStorefrontAssets", { query: { kind: "favicon" } })).toEqual([]);
    expect(problems("consoleListStorefrontAssets", { query: { kind: "stylesheet" } })).toEqual([
      "/query/kind enum",
    ]);

    // A deletion that settings or a page still need answers 409 asset_in_use, with where it is used.
    expect(objectAt(operation("consoleDeleteStorefrontAsset"), "responses", "409")).toEqual({
      $ref: "#/components/responses/StorefrontAssetConflict",
    });
    const inUse = responseExample("StorefrontAssetConflict", "CONFLICT");
    expect(objectAt(inUse, "error", "details")).toMatchObject({
      reason: "asset_in_use",
      settingsPaths: ["/branding/logoAssetId"],
    });
    expect(checker.check("consoleDeleteStorefrontAsset", { status: 409, body: inUse })).toEqual([]);
    expect(operation("consoleDeleteStorefrontAsset")["x-tenant-tables"]).toEqual(
      expect.arrayContaining(["storefront_assets", "storefront_settings", "storefront_pages"]),
    );
  });

  it("uploads a multipart file and kind, which the upload's handler parses: the API validates its headers only [OBE-091 AC1]", () => {
    const body = objectAt(operation("consoleUploadStorefrontAsset"), "requestBody");
    expect(body["required"]).toBe(true);
    expect(Object.keys(objectAt(body, "content"))).toEqual(["multipart/form-data"]);
    expect(objectAt(body, "content", "multipart/form-data", "schema")).toEqual({
      $ref: "#/components/schemas/StorefrontAssetUpload",
    });
    const upload = schemaOf("StorefrontAssetUpload");
    expect(upload).toMatchObject({ additionalProperties: false, required: ["file", "kind"] });
    expect(Object.keys(objectAt(upload, "properties"))).toEqual(["file", "kind", "fileName"]);
    expect(objectAt(upload, "properties", "file")).toMatchObject({ type: "string" });
    expect(objectAt(upload, "properties", "kind")).toEqual({
      $ref: "#/components/schemas/StorefrontAssetKind",
    });

    // The multipart stream is not JSON: the validator neither parses nor refuses it, and still checks the headers.
    const multipart = { "content-type": "multipart/form-data; boundary=x", "content-length": "2048" };
    expect(document.operation("consoleUploadStorefrontAsset").body).toBeUndefined();
    expect(
      problems("consoleUploadStorefrontAsset", { headers: { ...multipart, ...IDEMPOTENCY }, bodySent: true }),
    ).toEqual([]);
    expect(problems("consoleUploadStorefrontAsset", { headers: multipart, bodySent: true })).toEqual([
      "/header/Idempotency-Key required",
    ]);
    // A JSON operation still refuses a body that is not JSON.
    expect(() =>
      problems("consoleCreateStorefrontPage", { headers: { ...multipart, ...IDEMPOTENCY }, bodySent: true }),
    ).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST", details: { reason: "unsupported_media_type" } }),
    );
  });

  it("adds ASSET_INVALID (422) and answers it with details.reason type, size or dimensions [OBE-091 AC1]", () => {
    // Compiles only while the code is a member of the generated union.
    const code: ErrorCode = "ASSET_INVALID";
    expect([ERROR_CATALOGUE[code].status, ERROR_CATALOGUE[code].source]).toEqual([422, "ota"]);
    expect(OTA_ERROR_CODES).toContain(code);
    expect(objectAt(working, "x-error-catalogue", code)).toEqual({
      status: 422,
      description: "The uploaded file has a type, size or dimensions that are not allowed (details.reason).",
    });
    const spec = operation("consoleUploadStorefrontAsset");
    expect(spec["x-error-codes"]).toEqual(
      expect.arrayContaining(["ASSET_INVALID", "IDEMPOTENCY_KEY_REUSED"]),
    );
    expect(objectAt(spec, "responses", "422")).toEqual({
      $ref: "#/components/responses/StorefrontAssetUnprocessable",
    });
    const reasons = {
      ASSET_INVALID: "type",
      ASSET_INVALID_SIZE: "size",
      ASSET_INVALID_DIMENSIONS: "dimensions",
    };
    for (const [name, reason] of Object.entries(reasons)) {
      const body = responseExample("StorefrontAssetUnprocessable", name);
      expect([name, objectAt(body, "error")["code"], objectAt(body, "error", "details")]).toEqual([
        name,
        "ASSET_INVALID",
        { reason },
      ]);
      expect([name, checker.check("consoleUploadStorefrontAsset", { status: 422, body })]).toEqual([
        name,
        [],
      ]);
    }
    // The sniffing rules of OADR-0012 point 2, as the description states them for OBE-071.
    const description = String(spec["description"]);
    for (const rule of [
      "first bytes",
      "no SVG, no CSS",
      "1 MB",
      "2000 × 2000",
      "`favicon`",
      "not re-encoded",
    ]) {
      expect([rule, description.includes(rule)]).toEqual([rule, true]);
    }
  });

  it("serves an asset at a plain image URL without a credential, with the headers of OADR-0012 point 3 [OBE-091 AC1]", () => {
    const spec = operation("getPublicAsset");
    expect(spec["security"]).toEqual([]);
    expect(spec["x-sdk-exclude"]).toBe(true);
    expect(spec).not.toHaveProperty("x-sdk-method");
    expect(spec).not.toHaveProperty("x-internal");
    expect(
      ((spec["parameters"] as Json[]) ?? []).map((parameter) => [
        parameter["name"],
        parameter["in"],
        parameter["required"],
      ]),
    ).toEqual([
      ["tenantKey", "path", true],
      ["assetId", "path", true],
      ["ext", "path", true],
    ]);
    // The URL extensions are the table's.
    const ext = ((spec["parameters"] as Json[]) ?? []).find((parameter) => parameter["name"] === "ext");
    expect(objectAt(ext, "schema")["enum"]).toEqual(checkValues("storefront_assets", "file_extension"));
    expect(
      problems("getPublicAsset", { params: { tenantKey: "acme", assetId: ASSET_ID, ext: "png" } }),
    ).toEqual([]);
    expect(
      problems("getPublicAsset", { params: { tenantKey: "acme", assetId: ASSET_ID, ext: "svg" } }),
    ).toEqual(["/path/ext enum"]);

    const ok = objectAt(spec, "responses", "200");
    expect(Object.keys(objectAt(ok, "content"))).toEqual(checkValues("storefront_assets", "content_type"));
    expect(Object.keys(objectAt(ok, "headers"))).toEqual([
      "X-Request-Id",
      "Cache-Control",
      "X-Content-Type-Options",
      "Content-Security-Policy",
      "Content-Disposition",
    ]);
    const description = String(spec["description"]);
    for (const header of [
      "`Cache-Control: public, max-age=31536000, immutable`",
      "`X-Content-Type-Options: nosniff`",
      "`Content-Security-Policy: default-src 'none'`",
      "`Content-Disposition: inline`",
    ]) {
      expect([header, description.replace(/\s+/g, " ").includes(header)]).toEqual([header, true]);
    }
    // Active and suspended OTAs (the maintenance page shows the logo); everything unknown is 404.
    expect(description).toContain("`active` or `suspended`");
    expect(objectAt(spec, "responses", "404")).toEqual({ $ref: "#/components/responses/NotFound" });
    expect(spec["x-error-codes"]).toEqual(expect.arrayContaining(["NOT_FOUND", "RATE_LIMITED"]));
  });
});

describe("the SDK (ota/sdk/docs/extensions.md §3.1, §3.2; SDK-006)", () => {
  it("lists the 10 SDK methods in extensions.md with their HTTP method and path [OBE-091 AC1]", () => {
    const rows = readFileSync(EXTENSIONS_DOCUMENT, "utf8").split("\n");
    for (const { sdkMethod, method, path } of OBE_091_OPERATIONS) {
      if (sdkMethod === null) {
        continue;
      }
      const row = rows.find((line) => line.startsWith(`| \`${sdkMethod}\` |`)) ?? "";
      // The table writes `…/pages` for the paths below /v1/console/settings/ after its first row.
      const http = [path, path.replace("/v1/console/settings/", "…/")].map(
        (written) => `\`${method.toUpperCase()} ${written}\``,
      );
      expect([sdkMethod, http.some((cell) => row.includes(cell))]).toEqual([sdkMethod, true]);
    }
    expect(rows).toContain(
      "| `ASSET_INVALID` | 422 | `ValidationError` | `console.settings.assets.upload` |",
    );
  });

  it("lists storefront.listPages and storefront.getPage as pending SDK methods for SDK-012 until the SDK calls them [OBE-091 AC2]", () => {
    // The SDK's parity test (ota/sdk/test/contract/parity.test.js) holds the SDK to the same rule: a method of the
    // document is a pending entry or a method of the client, never both. SDK-012 writes the two methods in the
    // storefront namespace (`core.call(op.storefront_listPages, …)`) and removes their entries, and this test follows
    // without an edit outside SDK-012's files.
    const pending = readFileSync(SDK_PENDING_LIST, "utf8");
    const namespace = readFileSync(SDK_STOREFRONT_NAMESPACE, "utf8");
    for (const entry of ["storefront.listPages", "storefront.getPage"]) {
      const listed = new RegExp(`entry: "${entry.replace(".", "\\.")}",\\s*task: "SDK-012"`).test(pending);
      const written = new RegExp(`\\bop\\.${entry.replace(".", "_")}\\b`).test(namespace);
      expect([entry, { listed, written }]).toEqual([entry, { listed: !written, written }]);
    }
  });
});
