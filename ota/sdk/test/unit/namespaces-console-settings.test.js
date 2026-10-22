// The MVP additions of SDK-012 (ota/sdk/docs/extensions.md §3.1–§3.3, ota/docs/api-changes-console-and-internal.md
// §2–§4): `console.settings` (markup rules, fee rules, storefront settings, content pages, storefront images, e-mail
// templates: 25 methods), `console.payments` (4) and the storefront's `listPages` and `getPage`. Every new method is
// named by its `x-sdk-method` and sends the request of its route-table entry (method, path, query, `If-Match`,
// `Idempotency-Key`, body, `X-Velexis-Environment`, fetch cache mode) (AC2); the updates, deletes and `payments.capture`
// require `ifMatch` and `templates.put` takes it only when given; the lists resolve with a `Page`; retries follow the
// route table's retry class; and console.js declares the types of the additions after the contract's names. The
// multipart upload has its own test file (multipart.test.js, AC1). The canned responses are the examples of the
// working OpenAPI document, checked with the Ajv helper of @velexis/testing. Requests go to the fake fetch only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { responseChecker } from "@velexis/testing";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { NotFoundError, Page, VelexisError, createVelexisClient } from "../../src/index.js";
import { op } from "../../src/internal/operations.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

/** Fake keys and tokens with the right shapes; none of them works anywhere. */
const SK = "sk_test_sdk012_fake_secret";
const STAFF_AT = "at_sdk012_fake_staff";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..", "..");
/** The working contract, whose response examples are the canned answers. */
const DOCUMENT = join(REPO_ROOT, "ota", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");
const BASE_URL = "https://api.ota.example.com";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];

const MARKUP_RULE_ID = "mkr_01JA5M2K8Q4R7T0V3X6Z9B2D5F";
const FEE_RULE_ID = "fee_01JA5P4M0S6T9V2X5Z8B1D4F7H";
const PAGE_ID = "stp_01JA7Q1S3U5W7Y9A1C3E5G7J9L";
const ASSET_ID = "ast_01JA6B2C3D4E5F6G7H8J9K0M1N";
const PAYMENT_ID = "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1";
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const TEMPLATE = { templateKey: "booking.confirmed", channel: "email", locale: "en" };
const TEMPLATE_PATH = "/v1/console/settings/notification-templates/booking.confirmed/email/en";
const MONEY = { amount: "100.00", currency: "EUR" };

/** The sub-namespaces and methods SDK-012 adds to `console`, in the order of the client (extensions.md §3.2, §3.3). */
const CONSOLE_ADDITIONS = {
  settings: {
    markupRules: ["list", "create", "get", "update", "delete"],
    feeRules: ["list", "create", "get", "update", "delete"],
    storefront: ["get", "update"],
    pages: ["list", "create", "get", "update", "delete"],
    assets: ["list", "upload", "delete"],
    templates: ["list", "get", "put", "preview", "reset"],
  },
  payments: ["list", "get", "capture", "refund"],
};

/** Every new method by its `x-sdk-method` (`console.settings.markupRules.list`, `storefront.getPage`). */
const NEW_METHODS = [
  ...Object.entries(CONSOLE_ADDITIONS.settings).flatMap(([namespace, methods]) =>
    methods.map((method) => `console.settings.${namespace}.${method}`),
  ),
  ...CONSOLE_ADDITIONS.payments.map((method) => `console.payments.${method}`),
  "storefront.listPages",
  "storefront.getPage",
];

/** The types console.js declares for the additions, in their order after the contract's names. */
const CONSOLE_ADDITION_TYPES = [
  "MarkupRule",
  "MarkupRuleInput",
  "MarkupRuleUpdate",
  "FeeRule",
  "FeeRuleInput",
  "FeeRuleUpdate",
  "StorefrontSettings",
  "StorefrontSettingsUpdate",
  "StorefrontSettingsUpdateResult",
  "StorefrontPage",
  "StorefrontPageInput",
  "StorefrontPageUpdate",
  "StorefrontAsset",
  "StorefrontAssetKind",
  "NotificationTemplate",
  "NotificationTemplateList",
  "NotificationTemplateKey",
  "NotificationChannel",
  "NotificationTemplateInput",
  "NotificationTemplatePreviewRequest",
  "NotificationTemplatePreview",
  "ConsolePayment",
  "ConsolePaymentCaptureRequest",
  "ConsolePaymentRefundRequest",
  "ConsoleListMarkupRulesParams",
  "ConsoleCreateMarkupRuleParams",
  "ConsoleMarkupRuleRefParams",
  "ConsoleUpdateMarkupRuleParams",
  "ConsoleDeleteMarkupRuleParams",
  "ConsoleListFeeRulesParams",
  "ConsoleCreateFeeRuleParams",
  "ConsoleFeeRuleRefParams",
  "ConsoleUpdateFeeRuleParams",
  "ConsoleDeleteFeeRuleParams",
  "ConsoleGetStorefrontSettingsParams",
  "ConsoleUpdateStorefrontSettingsParams",
  "ConsoleListStorefrontPagesParams",
  "ConsoleCreateStorefrontPageParams",
  "ConsoleStorefrontPageRefParams",
  "ConsoleUpdateStorefrontPageParams",
  "ConsoleDeleteStorefrontPageParams",
  "ConsoleListStorefrontAssetsParams",
  "ConsoleUploadStorefrontAssetParams",
  "ConsoleDeleteStorefrontAssetParams",
  "ConsoleListNotificationTemplatesParams",
  "ConsoleNotificationTemplateRefParams",
  "ConsolePutNotificationTemplateParams",
  "ConsolePreviewNotificationTemplateParams",
  "ConsoleListPaymentsParams",
  "ConsoleGetPaymentParams",
  "ConsolePaymentRefParams",
  "ConsoleCapturePaymentParams",
  "ConsoleRefundPaymentParams",
  "ConsoleSettingsApi",
  "ConsoleSettingsMarkupRulesApi",
  "ConsoleSettingsFeeRulesApi",
  "ConsoleSettingsStorefrontApi",
  "ConsoleSettingsPagesApi",
  "ConsoleSettingsAssetsApi",
  "ConsoleSettingsTemplatesApi",
  "ConsolePaymentsApi",
];

/** @typedef {import("../../src/index.js").VelexisClient} VelexisClient */
/** @typedef {import("../helpers/fake-fetch.js").RecordedRequest} RecordedRequest */
/** @typedef {import("../../src/internal/operations.js").Operation} Operation */
/** @typedef {{ operationId: string, status: number, body: Record<string, unknown> | undefined }} Example */

/**
 * The first documented 2xx response of every new operation, by its `x-sdk-method`, filled in by the setup hook: its
 * JSON example, or no body for the deletes (204).
 * @type {Map<string, Example>}
 */
const EXAMPLES = new Map();

/**
 * The problems the Ajv helper of @velexis/testing finds in each example, by method, filled in by the setup hook.
 * @type {Map<string, unknown[]>}
 */
const EXAMPLE_PROBLEMS = new Map();

/**
 * The example of one method.
 * @param {string} method its `x-sdk-method`
 * @returns {Example}
 */
function example(method) {
  const found = EXAMPLES.get(method);
  if (found === undefined) {
    throw new Error(`the OpenAPI document has no 2xx response for ${method}`);
  }
  return found;
}

/**
 * A deep copy of an example body with some top-level fields replaced.
 * @param {string} method
 * @param {Record<string, unknown>} [changes]
 * @returns {Record<string, unknown>}
 */
const bodyOf = (method, changes = {}) => ({ ...structuredClone(example(method).body), ...changes });

/**
 * The canned answer of one method: its documented status and example.
 * @param {string} method
 */
function answerOf(method) {
  const { status, body } = example(method);
  return body === undefined ? { status } : { status, body: structuredClone(body) };
}

/**
 * Resolves the local `$ref`s of a parsed document node (responses and examples refer to components).
 * @param {Record<string, unknown>} document
 * @param {unknown} node
 * @returns {Record<string, any>}
 */
function deref(document, node) {
  let current = /** @type {Record<string, any>} */ (node);
  while (current !== null && typeof current === "object" && typeof current["$ref"] === "string") {
    current = current["$ref"]
      .slice(2)
      .split("/")
      .reduce((/** @type {Record<string, any>} */ value, /** @type {string} */ key) => value[key], document);
  }
  return current;
}

/**
 * The first 2xx response of every new operation of a parsed document: its first JSON example, or no body.
 * @param {Record<string, any>} document
 * @returns {Map<string, Example>}
 */
function examplesOf(document) {
  /** @type {Map<string, Example>} */
  const examples = new Map();
  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      const sdkMethod = operation?.["x-sdk-method"];
      if (typeof sdkMethod !== "string" || !NEW_METHODS.includes(sdkMethod)) {
        continue;
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        if (!/^2\d\d$/.test(status) || examples.has(sdkMethod)) {
          continue;
        }
        const media = deref(document, response)?.content?.["application/json"];
        const first = Object.values(media?.examples ?? {})[0];
        const body = first === undefined ? media?.example : deref(document, first).value;
        examples.set(sdkMethod, { operationId: operation.operationId, status: Number(status), body });
      }
    }
  }
  return examples;
}

/**
 * The setup hook parses the OTA document (about half a second alone) and compiles the response schemas of the examples
 * with Ajv; both take much longer while Turborepo runs every package's tests at once on a CI runner, so the hook gets
 * its own budget and the tests below only use the parsed examples and the validators' results.
 */
const SETUP_TIMEOUT_MS = 60_000;

beforeAll(() => {
  for (const [method, found] of examplesOf(parse(readFileSync(DOCUMENT, "utf8")))) {
    EXAMPLES.set(method, found);
  }
  const checker = responseChecker("ota");
  for (const [method, found] of EXAMPLES) {
    EXAMPLE_PROBLEMS.set(
      method,
      checker.check(found.operationId, { status: found.status, body: found.body }),
    );
  }
}, SETUP_TIMEOUT_MS);

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A server-mode client as the OTA admin builds it (OADR-0018 point 1): secret key, staff access token, staff session,
 * live environment.
 * @param {typeof globalThis.fetch} fetch
 * @param {Partial<import("../../src/index.js").VelexisClientOptions>} [extra]
 */
const staffClient = (fetch, extra = {}) =>
  createVelexisClient({
    secretKey: SK,
    accessToken: STAFF_AT,
    sessionKind: "staff",
    environment: "live",
    fetch,
    ...extra,
  });

/**
 * The method of a client at a dotted path (`console.settings.pages.get`), bound to nothing (namespace methods are
 * arrows).
 * @param {object} client
 * @param {string} path
 * @returns {((params?: unknown, options?: unknown) => Promise<unknown>) | undefined}
 */
function methodAt(client, path) {
  /** @type {unknown} */
  let current = client;
  for (const name of path.split(".")) {
    current =
      current !== null && typeof current === "object"
        ? /** @type {Record<string, unknown>} */ (current)[name]
        : undefined;
  }
  return typeof current === "function"
    ? /** @type {(params?: unknown, options?: unknown) => Promise<unknown>} */ (current)
    : undefined;
}

/**
 * The route-table entry of a method.
 * @param {string} method its `x-sdk-method`
 * @returns {Operation}
 */
const entryOf = (method) => op[/** @type {keyof typeof op} */ (method.replace(/\./g, "_"))];

describe("the canned responses", () => {
  it("are the documented 2xx responses of the 31 new operations and match their response schemas [SDK-012]", () => {
    expect([...EXAMPLES.keys()].sort()).toEqual([...NEW_METHODS].sort());
    // Every operation but the four deletes (204, no body) has a JSON example.
    expect(
      [...EXAMPLES]
        .filter(([, found]) => found.body === undefined)
        .map(([method, found]) => [method, found.status]),
    ).toEqual([
      ["console.settings.markupRules.delete", 204],
      ["console.settings.feeRules.delete", 204],
      ["console.settings.pages.delete", 204],
      ["console.settings.assets.delete", 204],
    ]);
    expect(Object.fromEntries(EXAMPLE_PROBLEMS)).toEqual(
      Object.fromEntries(NEW_METHODS.map((method) => [method, []])),
    );
  });
});

describe("the new namespaces", () => {
  it("console.settings has six sub-namespaces with 25 methods and console.payments 4, each named by its x-sdk-method [SDK-012 AC2]", () => {
    const client = createVelexisClient({ secretKey: SK, fetch: createFakeFetch().fetch });

    expect(Object.keys(client.console).slice(-2)).toEqual(["settings", "payments"]);
    expect(Object.keys(client.console.settings)).toEqual(Object.keys(CONSOLE_ADDITIONS.settings));
    for (const [namespace, methods] of Object.entries(CONSOLE_ADDITIONS.settings)) {
      const api = /** @type {Record<string, unknown>} */ (
        client.console.settings[/** @type {keyof VelexisClient["console"]["settings"]} */ (namespace)]
      );
      expect(Object.keys(api), namespace).toEqual(methods);
    }
    expect(Object.keys(client.console.payments)).toEqual(CONSOLE_ADDITIONS.payments);
    expect(NEW_METHODS).toHaveLength(31);
    for (const method of NEW_METHODS) {
      expect(typeof methodAt(client, method), method).toBe("function");
      expect(op, method).toHaveProperty(method.replace(/\./g, "_"));
    }
  });

  it("storefront has listPages and getPage after the contract's get and resolve [SDK-012 AC2]", () => {
    const client = createVelexisClient({ secretKey: SK, fetch: createFakeFetch().fetch });

    expect(Object.keys(client.storefront)).toEqual(["get", "resolve", "listPages", "getPage"]);
  });

  it("are rebuilt by withOptions on the new client's options [SDK-012]", async () => {
    const fake = createFakeFetch([answerOf("console.settings.storefront.get")]);
    const client = staffClient(fake.fetch);

    await client.withOptions({ environment: "test" }).console.settings.storefront.get();

    expect(fake.requests[0]?.headers["x-velexis-environment"]).toBe("test");
    expect(Object.keys(client.withOptions({ locale: "de-DE" }).console.settings)).toEqual(
      Object.keys(CONSOLE_ADDITIONS.settings),
    );
  });
});

/**
 * One method called with sample parameters, and the request it must send.
 * @typedef {object} RouteCase
 * @property {string} method the `x-sdk-method`
 * @property {(client: VelexisClient) => Promise<unknown>} call
 * @property {"GET" | "POST" | "PUT" | "PATCH" | "DELETE"} http
 * @property {string} path the path with its parameters filled in
 * @property {[string, string][]} query the decoded query parameters, in order
 * @property {Record<string, unknown>} [body] the JSON body; none when absent (and no `form`)
 * @property {[string, string][]} [form] the `multipart/form-data` parts as name and text, in order
 * @property {string} [ifMatch] the `If-Match` the call must carry; none when absent
 */

/** A markup rule as the console creates it. */
const MARKUP_RULE_INPUT = {
  name: "Long-haul economy",
  scope: { originCountries: ["FR"], cabins: ["ECONOMY"], minNet: "400.00" },
  calculation: "percentage",
  percentage: "4.0000",
  appliesPer: "traveler",
  min: { amount: "15.00", currency: "EUR" },
};

/** A fee rule as the console creates it. */
const FEE_RULE_INPUT = {
  name: "Amex surcharge",
  label: "Card fee",
  feeType: "payment_card",
  scope: { cardBrands: ["AMERICAN_EXPRESS"] },
  calculation: "percentage",
  percentage: "1.5000",
};

/** The bytes of the file of the upload case (a PNG signature; the server sniffs, the SDK sends what it is given). */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @type {RouteCase[]} */
const CASES = [
  {
    method: "console.settings.markupRules.list",
    call: (client) => client.console.settings.markupRules.list({ active: false, cursor: "cur_1", limit: 20 }),
    http: "GET",
    path: "/v1/console/settings/markup-rules",
    query: [
      ["active", "false"],
      ["cursor", "cur_1"],
      ["limit", "20"],
    ],
  },
  {
    method: "console.settings.markupRules.create",
    call: (client) => client.console.settings.markupRules.create(/** @type {never} */ (MARKUP_RULE_INPUT)),
    http: "POST",
    path: "/v1/console/settings/markup-rules",
    query: [],
    body: MARKUP_RULE_INPUT,
  },
  {
    method: "console.settings.markupRules.get",
    call: (client) => client.console.settings.markupRules.get({ markupRuleId: MARKUP_RULE_ID }),
    http: "GET",
    path: `/v1/console/settings/markup-rules/${MARKUP_RULE_ID}`,
    query: [],
  },
  {
    method: "console.settings.markupRules.update",
    call: (client) =>
      client.console.settings.markupRules.update({
        markupRuleId: MARKUP_RULE_ID,
        ifMatch: 3,
        percentage: "4.5000",
        isActive: false,
      }),
    http: "PATCH",
    path: `/v1/console/settings/markup-rules/${MARKUP_RULE_ID}`,
    query: [],
    body: { percentage: "4.5000", isActive: false },
    ifMatch: '"3"',
  },
  {
    method: "console.settings.markupRules.delete",
    call: (client) =>
      client.console.settings.markupRules.delete({ markupRuleId: MARKUP_RULE_ID, ifMatch: '"4"' }),
    http: "DELETE",
    path: `/v1/console/settings/markup-rules/${MARKUP_RULE_ID}`,
    query: [],
    ifMatch: '"4"',
  },
  {
    method: "console.settings.feeRules.list",
    call: (client) => client.console.settings.feeRules.list({ active: true, limit: 10 }),
    http: "GET",
    path: "/v1/console/settings/fee-rules",
    query: [
      ["active", "true"],
      ["limit", "10"],
    ],
  },
  {
    method: "console.settings.feeRules.create",
    call: (client) => client.console.settings.feeRules.create(/** @type {never} */ (FEE_RULE_INPUT)),
    http: "POST",
    path: "/v1/console/settings/fee-rules",
    query: [],
    body: FEE_RULE_INPUT,
  },
  {
    method: "console.settings.feeRules.get",
    call: (client) => client.console.settings.feeRules.get({ feeRuleId: FEE_RULE_ID }),
    http: "GET",
    path: `/v1/console/settings/fee-rules/${FEE_RULE_ID}`,
    query: [],
  },
  {
    method: "console.settings.feeRules.update",
    call: (client) =>
      client.console.settings.feeRules.update({
        feeRuleId: FEE_RULE_ID,
        ifMatch: 2,
        label: "Card surcharge",
      }),
    http: "PATCH",
    path: `/v1/console/settings/fee-rules/${FEE_RULE_ID}`,
    query: [],
    body: { label: "Card surcharge" },
    ifMatch: '"2"',
  },
  {
    method: "console.settings.feeRules.delete",
    call: (client) => client.console.settings.feeRules.delete({ feeRuleId: FEE_RULE_ID, ifMatch: 5 }),
    http: "DELETE",
    path: `/v1/console/settings/fee-rules/${FEE_RULE_ID}`,
    query: [],
    ifMatch: '"5"',
  },
  {
    method: "console.settings.storefront.get",
    call: (client) => client.console.settings.storefront.get(),
    http: "GET",
    path: "/v1/console/settings/storefront",
    query: [],
  },
  {
    method: "console.settings.storefront.update",
    call: (client) =>
      client.console.settings.storefront.update({
        ifMatch: 12,
        brand: { name: "Acme Travel", legalName: "Acme Travel Ltd", timeZone: "Europe/London" },
      }),
    http: "PATCH",
    path: "/v1/console/settings/storefront",
    query: [],
    body: { brand: { name: "Acme Travel", legalName: "Acme Travel Ltd", timeZone: "Europe/London" } },
    ifMatch: '"12"',
  },
  {
    method: "console.settings.pages.list",
    call: (client) => client.console.settings.pages.list({ locale: "en", published: true, limit: 50 }),
    http: "GET",
    path: "/v1/console/settings/pages",
    query: [
      ["locale", "en"],
      ["published", "true"],
      ["limit", "50"],
    ],
  },
  {
    method: "console.settings.pages.create",
    call: (client) =>
      client.console.settings.pages.create({
        slug: "terms",
        locale: "en",
        title: "Terms and conditions",
        kind: "terms",
        bodyMarkdown: "## Who we are\n\nAcme Travel Ltd.",
        isPublished: true,
      }),
    http: "POST",
    path: "/v1/console/settings/pages",
    query: [],
    body: {
      slug: "terms",
      locale: "en",
      title: "Terms and conditions",
      kind: "terms",
      bodyMarkdown: "## Who we are\n\nAcme Travel Ltd.",
      isPublished: true,
    },
  },
  {
    method: "console.settings.pages.get",
    call: (client) => client.console.settings.pages.get({ pageId: PAGE_ID }),
    http: "GET",
    path: `/v1/console/settings/pages/${PAGE_ID}`,
    query: [],
  },
  {
    method: "console.settings.pages.update",
    call: (client) =>
      client.console.settings.pages.update({ pageId: PAGE_ID, ifMatch: 2, isPublished: false }),
    http: "PATCH",
    path: `/v1/console/settings/pages/${PAGE_ID}`,
    query: [],
    body: { isPublished: false },
    ifMatch: '"2"',
  },
  {
    method: "console.settings.pages.delete",
    call: (client) => client.console.settings.pages.delete({ pageId: PAGE_ID, ifMatch: 3 }),
    http: "DELETE",
    path: `/v1/console/settings/pages/${PAGE_ID}`,
    query: [],
    ifMatch: '"3"',
  },
  {
    method: "console.settings.assets.list",
    call: (client) => client.console.settings.assets.list({ kind: "page_image", limit: 10 }),
    http: "GET",
    path: "/v1/console/settings/assets",
    query: [
      ["kind", "page_image"],
      ["limit", "10"],
    ],
  },
  {
    method: "console.settings.assets.upload",
    call: (client) =>
      client.console.settings.assets.upload({
        file: new File([PNG_SIGNATURE], "acme-logo.png", { type: "image/png" }),
        kind: "logo",
        fileName: "Acme logo",
      }),
    http: "POST",
    path: "/v1/console/settings/assets",
    query: [],
    form: [
      ["kind", "logo"],
      ["fileName", "Acme logo"],
      ["file", new TextDecoder().decode(PNG_SIGNATURE)],
    ],
  },
  {
    method: "console.settings.assets.delete",
    call: (client) => client.console.settings.assets.delete({ assetId: ASSET_ID }),
    http: "DELETE",
    path: `/v1/console/settings/assets/${ASSET_ID}`,
    query: [],
  },
  {
    method: "console.settings.templates.list",
    call: (client) => client.console.settings.templates.list(),
    http: "GET",
    path: "/v1/console/settings/notification-templates",
    query: [],
  },
  {
    method: "console.settings.templates.get",
    call: (client) => client.console.settings.templates.get(/** @type {never} */ (TEMPLATE)),
    http: "GET",
    path: TEMPLATE_PATH,
    query: [],
  },
  {
    method: "console.settings.templates.put",
    call: (client) =>
      client.console.settings.templates.put({
        templateKey: "booking.confirmed",
        channel: "email",
        locale: "en",
        ifMatch: 5,
        subject: "Your trip {{booking.reference}} is confirmed",
        bodyHtml: "<p>Hello {{booking.contact.firstName}}</p>",
        bodyText: "Hello {{booking.contact.firstName}}",
        isActive: true,
      }),
    http: "PUT",
    path: TEMPLATE_PATH,
    query: [],
    body: {
      subject: "Your trip {{booking.reference}} is confirmed",
      bodyHtml: "<p>Hello {{booking.contact.firstName}}</p>",
      bodyText: "Hello {{booking.contact.firstName}}",
      isActive: true,
    },
    ifMatch: '"5"',
  },
  {
    method: "console.settings.templates.preview",
    call: (client) =>
      client.console.settings.templates.preview({
        templateKey: "booking.confirmed",
        channel: "email",
        locale: "en",
        subject: "Trip {{booking.reference}}",
        variables: { booking: { reference: "VX7K2Q" } },
      }),
    http: "POST",
    path: `${TEMPLATE_PATH}/preview`,
    query: [],
    body: { subject: "Trip {{booking.reference}}", variables: { booking: { reference: "VX7K2Q" } } },
  },
  {
    method: "console.settings.templates.reset",
    call: (client) =>
      client.console.settings.templates.reset({
        templateKey: "booking.confirmed",
        channel: "email",
        locale: "en",
      }),
    http: "POST",
    path: `${TEMPLATE_PATH}/reset`,
    query: [],
  },
  {
    method: "console.payments.list",
    call: (client) =>
      client.console.payments.list({
        status: ["authorized", "captured"],
        provider: "stripe",
        method: ["card"],
        bookingId: BOOKING_ID,
        createdFrom: "2026-10-01T00:00:00Z",
        limit: 25,
      }),
    http: "GET",
    path: "/v1/console/payments",
    query: [
      ["status", "authorized,captured"],
      ["provider", "stripe"],
      ["method", "card"],
      ["bookingId", BOOKING_ID],
      ["createdFrom", "2026-10-01T00:00:00Z"],
      ["limit", "25"],
    ],
  },
  {
    method: "console.payments.get",
    call: (client) => client.console.payments.get({ paymentId: PAYMENT_ID, refresh: true }),
    http: "GET",
    path: `/v1/console/payments/${PAYMENT_ID}`,
    query: [["refresh", "true"]],
  },
  {
    method: "console.payments.capture",
    call: (client) =>
      client.console.payments.capture({
        paymentId: PAYMENT_ID,
        ifMatch: 7,
        amount: MONEY,
        reason: "Manual review passed",
      }),
    http: "POST",
    path: `/v1/console/payments/${PAYMENT_ID}/capture`,
    query: [],
    body: { amount: MONEY, reason: "Manual review passed" },
    ifMatch: '"7"',
  },
  {
    method: "console.payments.refund",
    call: (client) =>
      client.console.payments.refund({
        paymentId: PAYMENT_ID,
        amount: MONEY,
        reason: "customer_request",
        reasonNote: "Trip cancelled by the traveller",
      }),
    http: "POST",
    path: `/v1/console/payments/${PAYMENT_ID}/refunds`,
    query: [],
    body: { amount: MONEY, reason: "customer_request", reasonNote: "Trip cancelled by the traveller" },
  },
  {
    method: "storefront.listPages",
    call: (client) => client.storefront.listPages({ locale: "fr" }),
    http: "GET",
    path: "/v1/storefront/pages",
    query: [["locale", "fr"]],
  },
  {
    method: "storefront.getPage",
    call: (client) => client.storefront.getPage({ slug: "terms", locale: "en" }),
    http: "GET",
    path: "/v1/storefront/pages/terms",
    query: [["locale", "en"]],
  },
];

describe("each new method sends the request of its route-table entry", () => {
  it("covers all 31 methods [SDK-012 AC2]", () => {
    expect(CASES.map((testCase) => testCase.method).sort()).toEqual([...NEW_METHODS].sort());
  });

  it.each(CASES)("$method → $http $path [SDK-012 AC2]", async (testCase) => {
    const entry = entryOf(testCase.method);
    const answer = answerOf(testCase.method);
    const fake = createFakeFetch([answer]);
    const isConsole = testCase.method.startsWith("console.");
    // Console calls as the OTA admin makes them; the storefront's public calls with a key and no token. Both clients
    // have the live environment, which only console operations may send.
    const client = isConsole
      ? staffClient(fake.fetch)
      : createVelexisClient({ secretKey: SK, environment: "live", fetch: fake.fetch });

    const result = await testCase.call(client);

    expect(fake.requests).toHaveLength(1);
    const request = /** @type {RecordedRequest} */ (fake.requests[0]);
    // The route table: method, path template and query parameter names (in the table's order).
    expect(request.method).toBe(testCase.http);
    expect(entry.method).toBe(testCase.http);
    expect(testCase.path).toMatch(new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, "[^/]+")}$`));
    expect(request.url.split("?")[0]).toBe(`${BASE_URL}${testCase.path}`);
    expect([...request.searchParams]).toEqual(testCase.query);
    const queryNames = testCase.query.map(([name]) => name);
    expect(entry.queryParams.filter((name) => queryNames.includes(name))).toEqual(queryNames);
    expect(request.url).not.toMatch(/%2C/i);
    // The body: the params that are not path, query or header params (never `ifMatch`), as JSON, or the form of the
    // upload, whose Content-Type fetch sets; none for a GET, a DELETE or the template reset.
    if (testCase.form !== undefined) {
      expect(entry.body).toBe("multipart");
      expect(request.body).toBeInstanceOf(FormData);
      const parts = [.../** @type {FormData} */ (request.body).entries()];
      expect(
        await Promise.all(
          parts.map(async ([name, value]) => [name, typeof value === "string" ? value : await value.text()]),
        ),
      ).toEqual(testCase.form);
      expect(request.headers).not.toHaveProperty("content-type");
    } else if (testCase.body === undefined) {
      expect(request.body).toBeNull();
      expect(request.headers).not.toHaveProperty("content-type");
    } else {
      expect(entry.body).toBe("json");
      expect(request.json).toEqual(testCase.body);
      expect(request.headers["content-type"]).toBe("application/json");
    }
    // The headers: the key, the staff token and the live environment on console calls only, one generated
    // Idempotency-Key where the operation takes one, If-Match exactly where the call gives it.
    expect(entry.environment).toBe(isConsole);
    expect(request.headers).toMatchObject({ accept: "application/json", "x-api-key": SK });
    if (isConsole) {
      expect(request.headers).toMatchObject({
        authorization: `Bearer ${STAFF_AT}`,
        "x-velexis-environment": "live",
      });
    } else {
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.headers).not.toHaveProperty("x-velexis-environment");
      // `locale` is a query parameter of the page methods, not the Accept-Language of the call.
      expect(request.headers).not.toHaveProperty("accept-language");
    }
    if (entry.idempotency === "none") {
      expect(request.headers).not.toHaveProperty("idempotency-key");
    } else {
      expect(request.headers["idempotency-key"]).toMatch(UUID_V4);
    }
    expect(request.headers["if-match"]).toBe(testCase.ifMatch);
    // Console data is personal and live: no-store unless the call chooses; the storefront's pages are cacheable.
    expect(request.init.cache).toBe(isConsole ? "no-store" : undefined);
    // The result: the response body, a Page of it for a list, nothing for a 204.
    if (entry.queryParams.includes("cursor")) {
      expect(result).toBeInstanceOf(Page);
      expect(JSON.parse(JSON.stringify(result))).toEqual(answer.body);
    } else if (answer.body === undefined) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toEqual(answer.body);
    }
  });

  it("give the creates, the upload, the capture and the refund an Idempotency-Key, and nothing a reviewed timeout [SDK-012 AC2]", () => {
    const keyed = NEW_METHODS.filter((method) => entryOf(method).idempotency !== "none");
    expect(keyed.sort()).toEqual(
      [
        "console.settings.markupRules.create",
        "console.settings.feeRules.create",
        "console.settings.pages.create",
        "console.settings.assets.upload",
        "console.payments.capture",
        "console.payments.refund",
      ].sort(),
    );
    for (const method of keyed) {
      expect(entryOf(method).idempotency, method).toBe("required");
    }
    expect(NEW_METHODS.filter((method) => entryOf(method).timeoutMs !== null)).toEqual([]);
  });
});

/**
 * The methods that require `ifMatch`, with what the version belongs to and a call with a given `ifMatch`.
 * @type {{ method: string, resource: string, call: (client: VelexisClient, ifMatch: unknown) => Promise<unknown> }[]}
 */
const IF_MATCH_REQUIRED = [
  {
    method: "console.settings.markupRules.update",
    resource: "markup rule",
    call: (client, ifMatch) =>
      client.console.settings.markupRules.update(
        /** @type {never} */ ({ markupRuleId: MARKUP_RULE_ID, ifMatch, isActive: false }),
      ),
  },
  {
    method: "console.settings.markupRules.delete",
    resource: "markup rule",
    call: (client, ifMatch) =>
      client.console.settings.markupRules.delete(
        /** @type {never} */ ({ markupRuleId: MARKUP_RULE_ID, ifMatch }),
      ),
  },
  {
    method: "console.settings.feeRules.update",
    resource: "fee rule",
    call: (client, ifMatch) =>
      client.console.settings.feeRules.update(
        /** @type {never} */ ({ feeRuleId: FEE_RULE_ID, ifMatch, priority: 5 }),
      ),
  },
  {
    method: "console.settings.feeRules.delete",
    resource: "fee rule",
    call: (client, ifMatch) =>
      client.console.settings.feeRules.delete(/** @type {never} */ ({ feeRuleId: FEE_RULE_ID, ifMatch })),
  },
  {
    method: "console.settings.storefront.update",
    resource: "storefront settings",
    call: (client, ifMatch) =>
      client.console.settings.storefront.update(
        /** @type {never} */ ({ ifMatch, support: { email: "help@example.com" } }),
      ),
  },
  {
    method: "console.settings.pages.update",
    resource: "page",
    call: (client, ifMatch) =>
      client.console.settings.pages.update(/** @type {never} */ ({ pageId: PAGE_ID, ifMatch, sortOrder: 5 })),
  },
  {
    method: "console.settings.pages.delete",
    resource: "page",
    call: (client, ifMatch) =>
      client.console.settings.pages.delete(/** @type {never} */ ({ pageId: PAGE_ID, ifMatch })),
  },
  {
    method: "console.payments.capture",
    resource: "payment",
    call: (client, ifMatch) =>
      client.console.payments.capture(
        /** @type {never} */ ({ paymentId: PAYMENT_ID, ifMatch, reason: "Paid" }),
      ),
  },
];

/** Values that are not an `ifMatch`: no version number and no ETag that can be a header value. */
const BAD_IF_MATCH = [
  ["an empty string", ""],
  ["blank", "   "],
  ["negative", -1],
  ["a fraction", 1.5],
  ["not a number", Number.NaN],
  ["an object", { version: 3 }],
  ["a header line break", '"3"\r\nX-Other: 1'],
  ["not ASCII", '"3€"'],
];

describe("ifMatch", () => {
  it("is required by exactly the updates, the deletes with a version and payments.capture; templates.put takes it optionally [SDK-012]", () => {
    expect(NEW_METHODS.filter((method) => "ifMatch" in entryOf(method).headerParams).sort()).toEqual(
      [...IF_MATCH_REQUIRED.map(({ method }) => method), "console.settings.templates.put"].sort(),
    );
  });

  it.each(IF_MATCH_REQUIRED)(
    "$method sends a version number as its ETag and an ETag as it is, never in the body [SDK-012]",
    async ({ method, call }) => {
      const answer = answerOf(method);
      const fake = createFakeFetch([answer, structuredClone(answer), structuredClone(answer)]);
      const client = staffClient(fake.fetch);

      for (const ifMatch of [0, '"12"', 'W/"12"']) {
        await call(client, ifMatch);
      }

      expect(fake.requests.map((request) => request.headers["if-match"])).toEqual(['"0"', '"12"', 'W/"12"']);
      for (const request of fake.requests) {
        expect(request.json ?? {}).not.toHaveProperty("ifMatch");
        expect(request.url).not.toContain("ifMatch");
      }
    },
  );

  it.each(IF_MATCH_REQUIRED)(
    "$method refuses a missing or malformed ifMatch with a TypeError that names whose version it is, before any request [SDK-012]",
    async ({ method, resource, call }) => {
      const entry = entryOf(method);
      const fake = createFakeFetch();
      const client = staffClient(fake.fetch);

      for (const ifMatch of [undefined, null, ...BAD_IF_MATCH.map(([, value]) => value)]) {
        const error = await call(client, ifMatch).catch((/** @type {unknown} */ caught) => caught);
        expect(error, String(ifMatch)).toBeInstanceOf(TypeError);
        expect(/** @type {TypeError} */ (error).message).toBe(
          `Velexis SDK: ${entry.method} ${entry.path} needs "ifMatch", the ${resource} version (a whole number) or its ETag (a string)`,
        );
      }
      expect(fake.requests).toHaveLength(0);
    },
  );

  it.each(IF_MATCH_REQUIRED)(
    "$method refuses a call without params with the same TypeError, before any request [SDK-012]",
    async ({ method, resource }) => {
      // settings.storefront.update has no path parameter, so only the ifMatch check keeps it from going out without
      // If-Match; the others would also miss their id.
      const entry = entryOf(method);
      const fake = createFakeFetch();
      const client = staffClient(fake.fetch);
      const call = methodAt(client, method);
      expect(call, method).toBeDefined();

      const error = await /** @type {NonNullable<typeof call>} */ (call)().catch(
        (/** @type {unknown} */ caught) => caught,
      );

      expect(error).toBeInstanceOf(TypeError);
      expect(/** @type {TypeError} */ (error).message).toBe(
        `Velexis SDK: ${entry.method} ${entry.path} needs "ifMatch", the ${resource} version (a whole number) or its ETag (a string)`,
      );
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("templates.put sends If-Match only when the call gives one, and refuses a malformed one before any request [SDK-012]", async () => {
    const answer = answerOf("console.settings.templates.put");
    const fake = createFakeFetch(Array.from({ length: 4 }, () => structuredClone(answer)));
    const client = staffClient(fake.fetch);
    const template = {
      ...TEMPLATE,
      channel: /** @type {const} */ ("email"),
      templateKey: /** @type {const} */ ("booking.confirmed"),
      subject: "Trip {{booking.reference}}",
      bodyHtml: "<p>{{booking.reference}}</p>",
      bodyText: "{{booking.reference}}",
    };

    // The OTA has no template of its own yet: no If-Match. Then the version of its template, or the ETag.
    await client.console.settings.templates.put(template);
    await client.console.settings.templates.put({ ...template, ifMatch: /** @type {never} */ (null) });
    await client.console.settings.templates.put({ ...template, ifMatch: 1 });
    await client.console.settings.templates.put({ ...template, ifMatch: '"2"' });

    expect(fake.requests.map((request) => request.headers["if-match"])).toEqual([
      undefined,
      undefined,
      '"1"',
      '"2"',
    ]);
    for (const request of fake.requests) {
      expect(request.json).toEqual({
        subject: template.subject,
        bodyHtml: template.bodyHtml,
        bodyText: template.bodyText,
      });
    }
    const entry = op.console_settings_templates_put;
    for (const [, ifMatch] of BAD_IF_MATCH) {
      const error = await client.console.settings.templates
        .put({ ...template, ifMatch: /** @type {never} */ (ifMatch) })
        .catch((/** @type {unknown} */ caught) => caught);
      expect(error).toBeInstanceOf(TypeError);
      expect(/** @type {TypeError} */ (error).message).toBe(
        `Velexis SDK: ${entry.method} ${entry.path}: "ifMatch", when given, must be the template version (a whole number) or its ETag (a string)`,
      );
    }
    expect(fake.requests).toHaveLength(4);
  });

  it("leaves a stale version to the API: PRECONDITION_FAILED is a VelexisError and the PATCH is not retried [SDK-012]", async () => {
    const fake = createFakeFetch([errorResponse(412, "PRECONDITION_FAILED")]);
    const client = staffClient(fake.fetch, { maxRetries: 2 });

    const error = await client.console.settings.pages
      .update({ pageId: PAGE_ID, ifMatch: 2, title: "Terms" })
      .catch((/** @type {unknown} */ caught) => caught);

    expect(error).toBeInstanceOf(VelexisError);
    expect(error).toMatchObject({ code: "PRECONDITION_FAILED", status: 412 });
    expect(fake.requests).toHaveLength(1);
  });

  it("does not change the caller's params [SDK-012]", async () => {
    const fake = createFakeFetch([answerOf("console.settings.markupRules.update")]);
    const client = staffClient(fake.fetch);
    const params = { markupRuleId: MARKUP_RULE_ID, ifMatch: 3, isActive: false };

    await client.console.settings.markupRules.update(params);

    expect(params).toEqual({ markupRuleId: MARKUP_RULE_ID, ifMatch: 3, isActive: false });
  });
});

describe("the lists", () => {
  it("markupRules.list returns a Page that iterates across cursors with the same filters [SDK-012]", async () => {
    const [rule] = /** @type {Record<string, unknown>[]} */ (
      bodyOf("console.settings.markupRules.list")["data"]
    );
    /** @param {string} id */
    const row = (id) => ({ ...structuredClone(rule), id });
    const pages = [
      { data: [row("mkr_01JA5K9B2C4D6F8H0J2L4N6Q8S")], page: { nextCursor: "cur_2", limit: 1 } },
      { data: [row("mkr_01JA5M2K8Q4R7T0V3X6Z9B2D5F")], page: { nextCursor: null, limit: 1 } },
    ];
    const checker = responseChecker("ota");
    for (const body of pages) {
      expect(checker.check("consoleListMarkupRules", { status: 200, body })).toEqual([]);
    }
    const fake = createFakeFetch(pages.map((body) => ({ body })));
    const client = staffClient(fake.fetch);

    const page = await client.console.settings.markupRules.list({ active: true, limit: 1 });

    expect(page).toBeInstanceOf(Page);
    /** @type {string[]} */
    const ids = [];
    for await (const markupRule of page) {
      ids.push(markupRule.id);
    }
    expect(ids).toEqual(["mkr_01JA5K9B2C4D6F8H0J2L4N6Q8S", "mkr_01JA5M2K8Q4R7T0V3X6Z9B2D5F"]);
    expect(fake.requests.map((request) => `${request.path}?${request.searchParams}`)).toEqual([
      "/v1/console/settings/markup-rules?active=true&limit=1",
      "/v1/console/settings/markup-rules?active=true&cursor=cur_2&limit=1",
    ]);
    for (const request of fake.requests) {
      expect(request.headers["x-velexis-environment"]).toBe("live");
      expect(request.init.cache).toBe("no-store");
    }
  });

  it("payments.list sends one status, provider or method as it is and several comma-separated [SDK-012]", async () => {
    const fake = createFakeFetch([answerOf("console.payments.list"), answerOf("console.payments.list")]);
    const client = staffClient(fake.fetch);

    await client.console.payments.list({
      status: "authorized",
      provider: ["stripe", "airline"],
      method: "card",
    });
    await client.console.payments.list({
      status: ["captured", "partially_refunded"],
      method: ["card", "airline_card"],
    });

    expect(fake.requests.map((request) => [...request.searchParams])).toEqual([
      [
        ["status", "authorized"],
        ["provider", "stripe,airline"],
        ["method", "card"],
      ],
      [
        ["status", "captured,partially_refunded"],
        ["method", "card,airline_card"],
      ],
    ]);
  });

  it("the other lists resolve with a Page without params, and templates.list with its unpaginated body [SDK-012]", async () => {
    const fake = createFakeFetch([
      answerOf("console.settings.feeRules.list"),
      answerOf("console.settings.pages.list"),
      answerOf("console.settings.assets.list"),
      answerOf("console.payments.list"),
      answerOf("console.settings.templates.list"),
    ]);
    const client = staffClient(fake.fetch);

    const pages = [
      await client.console.settings.feeRules.list(),
      await client.console.settings.pages.list(),
      await client.console.settings.assets.list(),
      await client.console.payments.list(),
    ];
    const templates = await client.console.settings.templates.list();

    for (const page of pages) {
      expect(page).toBeInstanceOf(Page);
    }
    expect(templates).not.toBeInstanceOf(Page);
    expect(templates).toEqual(example("console.settings.templates.list").body);
    expect(fake.requests.map((request) => request.url)).toEqual([
      `${BASE_URL}/v1/console/settings/fee-rules`,
      `${BASE_URL}/v1/console/settings/pages`,
      `${BASE_URL}/v1/console/settings/assets`,
      `${BASE_URL}/v1/console/payments`,
      `${BASE_URL}/v1/console/settings/notification-templates`,
    ]);
  });
});

describe("retries", () => {
  it("a create, the capture and the refund are sent again after 503 with the same Idempotency-Key [SDK-012]", async () => {
    vi.useFakeTimers();
    const busy = () => errorResponse(503, "SERVICE_UNAVAILABLE", { headers: { "retry-after": "1" } });
    const fake = createFakeFetch([
      busy(),
      answerOf("console.settings.pages.create"),
      busy(),
      answerOf("console.payments.capture"),
      busy(),
      answerOf("console.payments.refund"),
    ]);
    const client = staffClient(fake.fetch);

    const created = client.console.settings.pages.create({ slug: "faq", locale: "en", title: "FAQ" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(created).resolves.toEqual(example("console.settings.pages.create").body);
    const captured = client.console.payments.capture(
      { paymentId: PAYMENT_ID, ifMatch: 7, reason: "Manual review passed" },
      { idempotencyKey: `capture-${PAYMENT_ID}-7` },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(captured).resolves.toEqual(example("console.payments.capture").body);
    const refunded = client.console.payments.refund({
      paymentId: PAYMENT_ID,
      amount: MONEY,
      reason: "goodwill",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(refunded).resolves.toEqual(example("console.payments.refund").body);

    const keys = fake.requests.map((request) => request.headers["idempotency-key"]);
    expect(keys[0]).toMatch(UUID_V4);
    expect(keys[1]).toBe(keys[0]);
    expect(keys.slice(2, 4)).toEqual([`capture-${PAYMENT_ID}-7`, `capture-${PAYMENT_ID}-7`]);
    expect(fake.requests.slice(2, 4).map((request) => request.headers["if-match"])).toEqual(['"7"', '"7"']);
    expect(keys[4]).toMatch(UUID_V4);
    expect(keys[5]).toBe(keys[4]);
    expect(new Set([keys[0], keys[4]]).size).toBe(2);
    expect(fake.requests).toHaveLength(6);
  });

  it("templates.preview and templates.reset are safe to repeat without a key; an update (PATCH) is not retried [SDK-012]", async () => {
    vi.useFakeTimers();
    const busy = () => errorResponse(503, "SERVICE_UNAVAILABLE", { headers: { "retry-after": "1" } });
    const fake = createFakeFetch([
      busy(),
      answerOf("console.settings.templates.preview"),
      busy(),
      answerOf("console.settings.templates.reset"),
      busy(),
    ]);
    const client = staffClient(fake.fetch);
    const template = /** @type {const} */ ({
      templateKey: "booking.confirmed",
      channel: "email",
      locale: "en",
    });

    const preview = client.console.settings.templates.preview(template);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(preview).resolves.toEqual(example("console.settings.templates.preview").body);
    const reset = client.console.settings.templates.reset(template);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reset).resolves.toEqual(example("console.settings.templates.reset").body);
    const updated = await client.console.settings.storefront
      .update({ ifMatch: 4, support: { email: "help@example.com" } })
      .catch((/** @type {unknown} */ caught) => caught);

    expect(updated).toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST ${TEMPLATE_PATH}/preview`,
      `POST ${TEMPLATE_PATH}/preview`,
      `POST ${TEMPLATE_PATH}/reset`,
      `POST ${TEMPLATE_PATH}/reset`,
      "PATCH /v1/console/settings/storefront",
    ]);
    // The preview has a JSON body even without a draft; neither call carries an Idempotency-Key.
    expect(fake.requests[0]?.json).toEqual({});
    for (const request of fake.requests) {
      expect(request.headers).not.toHaveProperty("idempotency-key");
    }
  });
});

describe("the storefront's content pages", () => {
  it("send locale as a query parameter, the call's locale option as Accept-Language, and leave the cache mode to the caller [SDK-012 AC2]", async () => {
    const fake = createFakeFetch([answerOf("storefront.listPages"), answerOf("storefront.getPage")]);
    const client = createVelexisClient({ secretKey: SK, fetch: fake.fetch });

    const list = await client.storefront.listPages(undefined, { locale: "fr-CA", next: { revalidate: 60 } });
    const page = await client.storefront.getPage({ slug: "about-us" }, { cache: "force-cache" });

    expect(list).toEqual(example("storefront.listPages").body);
    expect(page).toEqual(example("storefront.getPage").body);
    expect(fake.requests).toHaveLength(2);
    const first = /** @type {RecordedRequest} */ (fake.requests[0]);
    const second = /** @type {RecordedRequest} */ (fake.requests[1]);
    expect(first.url).toBe(`${BASE_URL}/v1/storefront/pages`);
    expect(first.headers["accept-language"]).toBe("fr-CA");
    expect(/** @type {{ next?: unknown }} */ (first.init).next).toEqual({ revalidate: 60 });
    expect(first.init.cache).toBeUndefined();
    expect(second.url).toBe(`${BASE_URL}/v1/storefront/pages/about-us`);
    expect(second.headers).not.toHaveProperty("accept-language");
    expect(second.init.cache).toBe("force-cache");
  });

  it("getPage URI-encodes the slug, refuses a missing one or a dot segment, and maps 404 to NotFoundError [SDK-012]", async () => {
    const fake = createFakeFetch([errorResponse(404, "NOT_FOUND"), errorResponse(404, "NOT_FOUND")]);
    const client = createVelexisClient({ secretKey: SK, fetch: fake.fetch, maxRetries: 2 });

    for (const params of [{}, { slug: "" }, { slug: "." }, { slug: ".." }]) {
      await expect(client.storefront.getPage(/** @type {never} */ (params))).rejects.toBeInstanceOf(
        TypeError,
      );
    }
    const missing = await client.storefront.getPage({ slug: "faq/../terms" }).catch((caught) => caught);
    const draft = await client.storefront.getPage({ slug: "draft", locale: "de" }).catch((caught) => caught);

    expect(missing).toBeInstanceOf(NotFoundError);
    expect(draft).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(fake.requests.map((request) => request.url)).toEqual([
      `${BASE_URL}/v1/storefront/pages/faq%2F..%2Fterms`,
      `${BASE_URL}/v1/storefront/pages/draft?locale=de`,
    ]);
  });
});

describe("the types of the additions", () => {
  const CONSOLE_NAMESPACE = join(SDK_ROOT, "src", "namespaces", "console.js");
  const STOREFRONT_NAMESPACE = join(SDK_ROOT, "src", "namespaces", "storefront.js");
  const CHECKED_FILES = [
    CONSOLE_NAMESPACE,
    STOREFRONT_NAMESPACE,
    ...["console.js", "index.js"].map((name) => join(SDK_ROOT, "src", name)),
  ];

  /** @type {string[]} */
  const diagnostics = [];
  /** @type {{ name: string, types: string[], resultMembers: string[], loose: boolean }[]} */
  const signatures = [];
  /** @type {{ sdk: string[], contract: string[] }} */
  const mirror = { sdk: [], contract: [] };
  /** @type {string[]} */
  const rootExports = [];

  /** Whether a type is `any` or `unknown`. @param {ts.Type} type */
  const isLoose = (type) => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;

  /**
   * Building the program reads the generated OTA types (several MB of declarations) and the DOM library: a few seconds
   * alone, and much more while Turborepo runs every package's tests at once on a CI runner, so the hook gets its own
   * budget instead of Vitest's 10 s default.
   */
  beforeAll(() => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(SDK_ROOT, "tsconfig.json"),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        },
      },
    );
    if (!parsed) {
      throw new Error("tsconfig.json could not be read");
    }
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();
    for (const file of CHECKED_FILES) {
      const source = program.getSourceFile(file);
      if (source === undefined) {
        throw new Error(`${file} is not part of the SDK's type check`);
      }
      for (const diagnostic of [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source),
      ]) {
        diagnostics.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
      }
    }
    /**
     * The methods of a factory's result below some of its properties, by their dotted path.
     * @param {string} file
     * @param {string} factoryName
     * @param {string} prefix the namespace of the factory (`console`, `storefront`)
     * @param {(path: string) => boolean} keep
     */
    const collect = (file, factoryName, prefix, keep) => {
      const source = /** @type {ts.SourceFile} */ (program.getSourceFile(file));
      const moduleSymbol = /** @type {ts.Symbol} */ (checker.getSymbolAtLocation(source));
      const factory = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === factoryName);
      const [signature] = checker
        .getTypeOfSymbolAtLocation(/** @type {ts.Symbol} */ (factory), source)
        .getCallSignatures();
      /** @param {ts.Type} type @param {string} path */
      const walk = (type, path) => {
        for (const property of type.getProperties()) {
          const name = `${path}.${property.name}`;
          const propertyType = checker.getTypeOfSymbolAtLocation(property, source);
          const [method] = propertyType.getCallSignatures();
          if (method === undefined) {
            walk(propertyType, name);
            continue;
          }
          if (!keep(name)) {
            continue;
          }
          const params = method
            .getParameters()
            .map((parameter) => checker.getTypeOfSymbolAtLocation(parameter, source));
          const result = checker.getAwaitedType(method.getReturnType()) ?? method.getReturnType();
          const types = [...params, result];
          signatures.push({
            name,
            types: types.map((type) => checker.typeToString(type)),
            resultMembers: result.getProperties().map((member) => member.name),
            loose: types.some(isLoose) || params.length !== 2,
          });
        }
      };
      walk(/** @type {ts.Signature} */ (signature).getReturnType(), prefix);
    };
    collect(CONSOLE_NAMESPACE, "createConsoleApi", "console", (name) => NEW_METHODS.includes(name));
    collect(STOREFRONT_NAMESPACE, "createStorefrontApi", "storefront", (name) => NEW_METHODS.includes(name));
    /** @param {string} file */
    const exportsOf = (file) =>
      checker.getExportsOfModule(
        /** @type {ts.Symbol} */ (
          checker.getSymbolAtLocation(/** @type {ts.SourceFile} */ (program.getSourceFile(file)))
        ),
      );
    mirror.sdk = exportsOf(join(SDK_ROOT, "src", "console.js"))
      .filter((symbol) => (symbol.flags & ts.SymbolFlags.TypeAlias) !== 0)
      .map((symbol) => ({ name: symbol.name, start: symbol.declarations?.[0]?.getStart() ?? -1 }))
      .sort((left, right) => left.start - right.start)
      .map((entry) => entry.name);
    const contractFile = join(REPO_ROOT, "docs", "velexis-sdk", "sdk", "src", "console.d.ts");
    mirror.contract = ts
      .createSourceFile(contractFile, readFileSync(contractFile, "utf8"), ts.ScriptTarget.ES2022)
      .statements.filter(
        (statement) =>
          (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
          (statement.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
      )
      .map((statement) => /** @type {ts.TypeAliasDeclaration} */ (statement).name.text);
    rootExports.push(...exportsOf(join(SDK_ROOT, "src", "index.js")).map((symbol) => symbol.name));
  }, 120_000);

  it("type-check without a diagnostic in the two namespace files, console.js and index.js [SDK-012]", () => {
    expect(diagnostics).toEqual([]);
  });

  it("give every new method typed params, options and an awaited result, never any or unknown [SDK-012]", () => {
    expect(signatures.map((signature) => signature.name).sort()).toEqual([...NEW_METHODS].sort());
    expect(signatures.filter((signature) => signature.loose)).toEqual([]);
    const byName = Object.fromEntries(signatures.map((signature) => [signature.name, signature]));
    for (const method of NEW_METHODS.filter((name) => name.endsWith(".delete"))) {
      expect(byName[method]?.types[2], method).toBe("void");
    }
    for (const method of [
      "console.settings.markupRules.list",
      "console.settings.feeRules.list",
      "console.settings.pages.list",
      "console.settings.assets.list",
      "console.payments.list",
    ]) {
      expect(byName[method]?.resultMembers, method).toEqual(expect.arrayContaining(["data", "page", "next"]));
    }
    expect(byName["console.settings.assets.upload"]?.types[0]).toBe("ConsoleUploadStorefrontAssetParams");
    expect(byName["console.settings.assets.upload"]?.resultMembers).toEqual(
      expect.arrayContaining(["id", "kind", "contentType", "url"]),
    );
    expect(byName["console.settings.storefront.update"]?.resultMembers).toEqual(
      expect.arrayContaining(["branding", "version", "warnings"]),
    );
    expect(byName["console.payments.capture"]?.resultMembers).toEqual(
      expect.arrayContaining(["status", "version", "events", "refunds", "booking"]),
    );
    expect(byName["console.settings.templates.list"]?.resultMembers).toEqual(["data"]);
    expect(byName["storefront.listPages"]?.resultMembers).toEqual(["data"]);
    expect(byName["storefront.getPage"]?.resultMembers).toEqual(
      expect.arrayContaining(["slug", "locale", "blocks"]),
    );
  });

  it("declare the types of the additions after the contract's names in console.js, exported from the root [SDK-012]", () => {
    expect(mirror.contract).toHaveLength(97);
    expect(mirror.sdk.slice(0, mirror.contract.length)).toEqual(mirror.contract);
    expect(mirror.sdk.slice(mirror.contract.length)).toEqual(CONSOLE_ADDITION_TYPES);
    expect(rootExports).toEqual(expect.arrayContaining(CONSOLE_ADDITION_TYPES));
  });
});
