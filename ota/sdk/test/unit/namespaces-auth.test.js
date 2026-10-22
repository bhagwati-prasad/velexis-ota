// The `auth` and `account` namespaces (task SDK-008, docs/velexis-sdk/sdk/src/identity.d.ts `AuthApi` and `AccountApi`,
// guide B1, ota/sdk/README.md §4 and §5.2, ota/sdk/docs/extensions.md §6): the ten `auth.*` and twelve `account.*`
// methods are named exactly by their `x-sdk-method` and send the request their route-table entry describes (method,
// path, query, headers, body); `signIn`, `refresh` and `changePassword` are typed `AuthSessionResult | AuthSessionInfo`
// (the approved deviation of OADR-0006, which the contract test checks); in token and server mode their results feed
// the client's session (`onSessionRefreshed`, and the tokens the client sends from then on), while cookie mode stores
// nothing and hands page code no token; cookie-mode `auth.refresh` sends an empty body and token mode the refresh token
// (AC2); the nine deferred `account.*` methods surface `501 NOT_IMPLEMENTED` as a `ServerError` (AC3). The canned
// responses are the examples of the working OpenAPI document and test/fixtures/auth-session-info.json, checked with the
// Ajv helper of @velexis/testing, so the fake answers cannot drift from the contract. Requests go to the fake fetch
// only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { responseChecker } from "@velexis/testing";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import {
  AuthenticationError,
  Page,
  ServerError,
  VelexisError,
  createVelexisClient,
} from "../../src/index.js";
import { op } from "../../src/internal/operations.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

/** Fake keys and tokens with the right shapes; none of them works anywhere. */
const SK = "sk_test_sdk008_fake_secret";
const PK = "pk_test_sdk008_fake";
const AT = "at_sdk008_first";
const RT = "rt_sdk008_first_00000000000000000000";
const STAFF_AT = "at_sdk008_staff";
const STAFF_RT = "rt_sdk008_staff_00000000000000000000";
const CSRF = "csrf_sdk008_fake";
/** Fake passwords of the request bodies; never a real one. */
const PASSWORD = "Fjord-Lights-2026";
const NEW_PASSWORD = "Aurora-Borealis-2027";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..", "..");
/** The working contract, whose response examples are the canned answers. */
const DOCUMENT = join(SDK_ROOT, "..", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");
const BASE_URL = "https://api.ota.example.com";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];

const SAVED_TRAVELER_ID = "trv_01JA4C9N2Q5T8W1Z4C7F0H3L6P";
const DATA_EXPORT_ID = "dex_9Zx3Cv6Bn2Mq8Wl4";

/** `GET /v1/auth/session` (getSession, 200), and cookie mode's answer to sign-in, refresh and password change. */
const SESSION_INFO = JSON.parse(
  readFileSync(join(SDK_ROOT, "test", "fixtures", "auth-session-info.json"), "utf8"),
);

/** The ten methods of `AuthApi`, as the contract names them (identity.d.ts). */
const AUTH_METHODS = [
  "signUp",
  "verifyEmail",
  "resendVerification",
  "signIn",
  "refresh",
  "signOut",
  "requestPasswordReset",
  "resetPassword",
  "changePassword",
  "getSession",
];

/** The twelve methods of `AccountApi` and its sub-namespaces, as the contract names them (identity.d.ts). */
const ACCOUNT_METHODS = [
  "get",
  "update",
  "delete",
  "preferences.get",
  "preferences.update",
  "savedTravelers.list",
  "savedTravelers.create",
  "savedTravelers.get",
  "savedTravelers.update",
  "savedTravelers.delete",
  "dataExports.create",
  "dataExports.get",
];

/** Every method of both namespaces by its `x-sdk-method`. */
const ALL_METHODS = [
  ...AUTH_METHODS.map((name) => `auth.${name}`),
  ...ACCOUNT_METHODS.map((name) => `account.${name}`),
];

/** The account methods that are deferred until after the MVP (scope.md §3, pending-operations.ts of the backend). */
const DEFERRED = ACCOUNT_METHODS.filter((name) => !["get", "update", "delete"].includes(name)).map(
  (name) => `account.${name}`,
);

/** The methods that resolve with a session (the approved cookie-mode deviation of OADR-0006). */
const SESSION_METHODS = ["auth.signIn", "auth.refresh", "auth.changePassword"];

/** @typedef {import("../../src/index.js").VelexisClient} VelexisClient */
/** @typedef {import("../helpers/fake-fetch.js").RecordedRequest} RecordedRequest */
/** @typedef {import("../helpers/fake-fetch.js").Answer} Answer */
/** @typedef {{ operationId: string, status: number, body: Record<string, any> | undefined }} Example */
/** @typedef {(params?: unknown, options?: unknown) => Promise<any>} AnyMethod */

/**
 * The first documented 2xx response of every `auth.*` and `account.*` operation, by `x-sdk-method`, filled in by the
 * setup hook: its JSON example, or no body for a `204`.
 * @type {Map<string, Example>}
 */
const EXAMPLES = new Map();

/**
 * The problems the Ajv helper of @velexis/testing finds in each canned response, by name, filled in by the setup hook.
 * @type {Map<string, unknown[]>}
 */
const PROBLEMS = new Map();

/**
 * The example of one method.
 * @param {string} method the `x-sdk-method`, for example `auth.signIn`
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
 * The canned answer of one method: its documented status and a copy of its example.
 * @param {string} method
 * @returns {import("../helpers/fake-fetch.js").CannedResponse}
 */
function answerOf(method) {
  const { status, body } = example(method);
  return body === undefined ? { status } : { status, body: structuredClone(body) };
}

/**
 * The method of a client at a dotted path (`auth.signIn`, `account.savedTravelers.list`).
 * @param {VelexisClient} client
 * @param {string} path
 * @returns {AnyMethod}
 */
function methodOf(client, path) {
  /** @type {any} */
  let owner = client;
  const names = path.split(".");
  const last = /** @type {string} */ (names.pop());
  for (const name of names) {
    owner = owner[name];
  }
  return (...args) => owner[last](...args);
}

/**
 * The `AuthSessionResult` of the n-th session the fake API opens: the documented sign-in answer with tokens of its own.
 * @param {number} n
 */
function sessionResult(n) {
  const body = /** @type {Record<string, any>} */ (structuredClone(example("auth.signIn").body));
  return {
    ...body,
    session: {
      ...body["session"],
      accessToken: `at_sdk008_${n}`,
      refreshToken: `rt_sdk008_${n}_000000000000000000000`,
    },
  };
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
 * The first 2xx response of every `auth.*` and `account.*` operation of a parsed document: its first JSON example
 * (`example` or the first of `examples`), or no body when it has none (`204`).
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
      if (typeof sdkMethod !== "string" || !ALL_METHODS.includes(sdkMethod)) {
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
 * Stubs a browser page, which cookie mode needs, with the CSRF cookie by default. Without it (`csrf: false`) every
 * write first asks `GET /v1/storefront` for the cookie, so a test that expects no request at all proves that a call
 * is refused before that request too.
 * @param {{ csrf?: boolean }} [page]
 */
function stubBrowserPage({ csrf = true } = {}) {
  vi.stubGlobal("document", { cookie: csrf ? `__Host-vx_csrf=${CSRF}` : "" });
}

/**
 * A fake customer API: `POST /v1/auth/sign-in` opens the next session; `POST /v1/auth/refresh` rotates it while the
 * presented refresh token is the current one (`401 REFRESH_TOKEN_REUSED` otherwise, as the backend revokes the
 * family); `POST /v1/auth/password/change` rotates it for the current access token; every other call answers 200 with
 * the current access token and `401 TOKEN_EXPIRED` with any other. `expire()` lets the current access token expire.
 * @param {{ accessToken?: string, refreshToken?: string }} [start] the session the client starts with
 */
function fakeApi(start = {}) {
  /** @type {{ accessToken: string | null, refreshToken: string | null, opened: number }} */
  const state = {
    accessToken: start.accessToken ?? null,
    refreshToken: start.refreshToken ?? null,
    opened: 0,
  };
  const open = () => {
    state.opened += 1;
    const body = sessionResult(state.opened);
    state.accessToken = body.session.accessToken;
    state.refreshToken = body.session.refreshToken;
    return { body };
  };
  /** @type {Answer} */
  const answer = (request) => {
    if (request.path === "/v1/auth/sign-in") {
      return open();
    }
    if (request.path === "/v1/auth/refresh") {
      const presented = /** @type {{ refreshToken?: string }} */ (request.json).refreshToken;
      return presented === state.refreshToken ? open() : errorResponse(401, "REFRESH_TOKEN_REUSED");
    }
    if (request.headers["authorization"] !== `Bearer ${state.accessToken}`) {
      return errorResponse(401, "TOKEN_EXPIRED");
    }
    return request.path === "/v1/auth/password/change" ? open() : { body: SESSION_INFO };
  };
  return {
    state,
    expire: () => {
      state.accessToken = null;
    },
    answers: (/** @type {number} */ count) => Array.from({ length: count }, () => answer),
  };
}

/**
 * The setup hook parses the OTA document (about half a second alone) and compiles the response schemas of the examples
 * and the fixture with Ajv; both take much longer while Turborepo runs every package's tests at once on a CI runner,
 * so the hook gets its own budget and the tests below only use the parsed examples and the validators' results.
 */
const SETUP_TIMEOUT_MS = 60_000;

beforeAll(() => {
  for (const [method, found] of examplesOf(parse(readFileSync(DOCUMENT, "utf8")))) {
    EXAMPLES.set(method, found);
  }
  const checker = responseChecker("ota");
  for (const [method, found] of EXAMPLES) {
    PROBLEMS.set(method, checker.check(found.operationId, { status: found.status, body: found.body }));
  }
  // The fixture is what the edge receives from sign-in, refresh and password change, and what getSession answers.
  for (const operationId of ["getSession", "signIn", "refreshSession", "changePassword"]) {
    PROBLEMS.set(`fixture:${operationId}`, checker.check(operationId, { status: 200, body: SESSION_INFO }));
  }
}, SETUP_TIMEOUT_MS);

describe("the canned responses", () => {
  it("are the documented examples of all 22 operations and match their response schemas [SDK-008]", () => {
    expect([...EXAMPLES.keys()].sort()).toEqual([...ALL_METHODS].sort());
    expect([...EXAMPLES].filter(([, found]) => found.body === undefined).map(([method]) => method)).toEqual([
      "auth.signOut",
      "account.savedTravelers.delete",
    ]);
    for (const method of ALL_METHODS) {
      expect(PROBLEMS.get(method), method).toEqual([]);
    }
  });

  it("include an AuthSessionInfo fixture that is a valid answer of getSession, signIn, refresh and changePassword [SDK-008]", () => {
    for (const operationId of ["getSession", "signIn", "refreshSession", "changePassword"]) {
      expect(PROBLEMS.get(`fixture:${operationId}`), operationId).toEqual([]);
    }
    expect(Object.keys(SESSION_INFO.session)).not.toEqual(expect.arrayContaining(["accessToken"]));
    expect(JSON.stringify(SESSION_INFO)).not.toMatch(/"(?:accessToken|refreshToken)"/);
  });
});

describe("the auth and account namespaces", () => {
  it("offer the ten methods of AuthApi and the twelve of AccountApi, each named by its x-sdk-method [SDK-008]", () => {
    const client = createVelexisClient({ publishableKey: PK, fetch: createFakeFetch().fetch });

    expect(Object.keys(client.auth).sort()).toEqual([...AUTH_METHODS].sort());
    expect(Object.keys(client.account)).toEqual([
      "get",
      "update",
      "delete",
      "preferences",
      "savedTravelers",
      "dataExports",
    ]);
    expect(Object.keys(client.account.preferences)).toEqual(["get", "update"]);
    expect(Object.keys(client.account.savedTravelers)).toEqual(["list", "create", "get", "update", "delete"]);
    expect(Object.keys(client.account.dataExports)).toEqual(["create", "get"]);
    for (const method of ALL_METHODS) {
      expect(typeof methodOf(client, method)).toBe("function");
      expect(op, method).toHaveProperty(method.replaceAll(".", "_"));
    }
  });

  it("are rebuilt by withOptions on the new client's options [SDK-008]", async () => {
    const fake = createFakeFetch([answerOf("account.get")]);
    const client = createVelexisClient({
      publishableKey: PK,
      accessToken: AT,
      fetch: fake.fetch,
      locale: "en-GB",
    });

    await client.withOptions({ locale: "de-DE" }).account.get();

    expect(fake.requests[0]?.headers["accept-language"]).toBe("de-DE");
    expect(fake.requests[0]?.headers["authorization"]).toBe(`Bearer ${AT}`);
    expect(Object.keys(client.withOptions({ currency: "EUR" }).auth).sort()).toEqual(
      [...AUTH_METHODS].sort(),
    );
  });
});

/**
 * One method called with sample parameters, and the request it must send.
 * @typedef {object} RouteCase
 * @property {string} method the `x-sdk-method`
 * @property {(client: VelexisClient) => Promise<unknown>} call
 * @property {"GET" | "POST" | "PATCH" | "DELETE"} http
 * @property {string} path the path with its parameters filled in
 * @property {[string, string][]} query the decoded query parameters, in order
 * @property {Record<string, unknown>} [body] the JSON body; none when absent
 * @property {Record<string, string>} [headers] headers the call must carry besides the common ones
 */

const NAME = { firstName: "MIA", lastName: "LUND" };
const DOCUMENTS = [
  {
    documentType: "PASSPORT",
    number: "128840457",
    expiryDate: "2031-01-15",
    issuanceCountry: "SE",
    nationality: "SE",
    holder: true,
  },
];

/** @type {RouteCase[]} */
const CASES = [
  {
    method: "auth.signUp",
    call: (client) =>
      client.auth.signUp({
        email: "mia.lund@example.com",
        password: PASSWORD,
        firstName: "Mia",
        lastName: "Lund",
        marketingConsent: false,
        termsVersion: "2026-09-01",
      }),
    http: "POST",
    path: "/v1/auth/sign-up",
    query: [],
    body: {
      email: "mia.lund@example.com",
      password: PASSWORD,
      firstName: "Mia",
      lastName: "Lund",
      marketingConsent: false,
      termsVersion: "2026-09-01",
    },
  },
  {
    method: "auth.verifyEmail",
    call: (client) => client.auth.verifyEmail({ token: "evt_sdk008_fake_verification_token" }),
    http: "POST",
    path: "/v1/auth/email-verification/confirm",
    query: [],
    body: { token: "evt_sdk008_fake_verification_token" },
  },
  {
    method: "auth.resendVerification",
    call: (client) =>
      client.auth.resendVerification({ email: "mia.lund@example.com", returnPath: "/account" }),
    http: "POST",
    path: "/v1/auth/email-verification/resend",
    query: [],
    body: { email: "mia.lund@example.com", returnPath: "/account" },
  },
  {
    method: "auth.signIn",
    call: (client) =>
      client.auth.signIn({ email: "mia.lund@example.com", password: PASSWORD, rememberMe: true }),
    http: "POST",
    path: "/v1/auth/sign-in",
    query: [],
    body: { email: "mia.lund@example.com", password: PASSWORD, rememberMe: true },
  },
  {
    method: "auth.refresh",
    call: (client) => client.auth.refresh({ refreshToken: RT }),
    http: "POST",
    path: "/v1/auth/refresh",
    query: [],
    body: { refreshToken: RT },
  },
  {
    method: "auth.signOut",
    call: (client) => client.auth.signOut({ scope: "all" }),
    http: "POST",
    path: "/v1/auth/sign-out",
    query: [],
    body: { scope: "all" },
  },
  {
    method: "auth.requestPasswordReset",
    call: (client) => client.auth.requestPasswordReset({ email: "mia.lund@example.com" }),
    http: "POST",
    path: "/v1/auth/password-resets",
    query: [],
    body: { email: "mia.lund@example.com" },
  },
  {
    method: "auth.resetPassword",
    call: (client) =>
      client.auth.resetPassword({
        token: "prt_sdk008_fake_reset_token",
        newPassword: NEW_PASSWORD,
        signIn: true,
      }),
    http: "POST",
    path: "/v1/auth/password-resets/confirm",
    query: [],
    body: { token: "prt_sdk008_fake_reset_token", newPassword: NEW_PASSWORD, signIn: true },
  },
  {
    method: "auth.changePassword",
    call: (client) =>
      client.auth.changePassword({
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        signOutOtherSessions: true,
      }),
    http: "POST",
    path: "/v1/auth/password/change",
    query: [],
    body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, signOutOtherSessions: true },
  },
  {
    method: "auth.getSession",
    call: (client) => client.auth.getSession(),
    http: "GET",
    path: "/v1/auth/session",
    query: [],
  },
  {
    method: "account.get",
    call: (client) => client.account.get({}),
    http: "GET",
    path: "/v1/account",
    query: [],
  },
  {
    method: "account.update",
    call: (client) => client.account.update({ ifMatch: 3, firstName: "Mia", marketingConsent: true }),
    http: "PATCH",
    path: "/v1/account",
    query: [],
    body: { firstName: "Mia", marketingConsent: true },
    headers: { "if-match": '"3"' },
  },
  {
    method: "account.delete",
    call: (client) =>
      client.account.delete({ currentPassword: PASSWORD, exportData: false, reason: "no_longer_needed" }),
    http: "POST",
    path: "/v1/account/deletion",
    query: [],
    body: { currentPassword: PASSWORD, exportData: false, reason: "no_longer_needed" },
  },
  {
    method: "account.preferences.get",
    call: (client) => client.account.preferences.get(),
    http: "GET",
    path: "/v1/account/preferences",
    query: [],
  },
  {
    method: "account.preferences.update",
    call: (client) => client.account.preferences.update({ ifMatch: '"7"', currency: "SEK" }),
    http: "PATCH",
    path: "/v1/account/preferences",
    query: [],
    body: { currency: "SEK" },
    headers: { "if-match": '"7"' },
  },
  {
    method: "account.savedTravelers.list",
    call: (client) => client.account.savedTravelers.list({ cursor: "cur_2", limit: 20 }),
    http: "GET",
    path: "/v1/account/saved-travelers",
    query: [
      ["cursor", "cur_2"],
      ["limit", "20"],
    ],
  },
  {
    method: "account.savedTravelers.create",
    call: (client) =>
      client.account.savedTravelers.create({
        name: NAME,
        dateOfBirth: "1991-06-02",
        gender: "FEMALE",
        documents: DOCUMENTS,
      }),
    http: "POST",
    path: "/v1/account/saved-travelers",
    query: [],
    body: { name: NAME, dateOfBirth: "1991-06-02", gender: "FEMALE", documents: DOCUMENTS },
  },
  {
    method: "account.savedTravelers.get",
    call: (client) => client.account.savedTravelers.get({ savedTravelerId: SAVED_TRAVELER_ID }),
    http: "GET",
    path: `/v1/account/saved-travelers/${SAVED_TRAVELER_ID}`,
    query: [],
  },
  {
    method: "account.savedTravelers.update",
    call: (client) =>
      client.account.savedTravelers.update({
        savedTravelerId: SAVED_TRAVELER_ID,
        ifMatch: 2,
        loyaltyPrograms: [{ programOwner: "SK", id: "41234567" }],
      }),
    http: "PATCH",
    path: `/v1/account/saved-travelers/${SAVED_TRAVELER_ID}`,
    query: [],
    body: { loyaltyPrograms: [{ programOwner: "SK", id: "41234567" }] },
    headers: { "if-match": '"2"' },
  },
  {
    method: "account.savedTravelers.delete",
    call: (client) => client.account.savedTravelers.delete({ savedTravelerId: SAVED_TRAVELER_ID }),
    http: "DELETE",
    path: `/v1/account/saved-travelers/${SAVED_TRAVELER_ID}`,
    query: [],
  },
  {
    method: "account.dataExports.create",
    call: (client) => client.account.dataExports.create({ format: "json", includeBookings: true }),
    http: "POST",
    path: "/v1/account/data-exports",
    query: [],
    body: { format: "json", includeBookings: true },
  },
  {
    method: "account.dataExports.get",
    call: (client) => client.account.dataExports.get({ dataExportId: DATA_EXPORT_ID }),
    http: "GET",
    path: `/v1/account/data-exports/${DATA_EXPORT_ID}`,
    query: [],
  },
];

describe("each auth and account method sends the request of its route-table entry", () => {
  it("covers all 22 methods [SDK-008]", () => {
    expect(CASES.map((testCase) => testCase.method).sort()).toEqual([...ALL_METHODS].sort());
  });

  it.each(CASES)("$method → $http $path [SDK-008]", async (testCase) => {
    const entry = op[/** @type {keyof typeof op} */ (testCase.method.replaceAll(".", "_"))];
    const answer = answerOf(testCase.method);
    const fake = createFakeFetch([answer]);
    // A server-mode client with a customer token and an environment: the token goes with every call, the environment
    // header with none of them (they are customer operations).
    const client = createVelexisClient({
      secretKey: SK,
      accessToken: AT,
      environment: "test",
      fetch: fake.fetch,
    });

    const result = await testCase.call(client);

    expect(fake.requests).toHaveLength(1);
    const request = /** @type {RecordedRequest} */ (fake.requests[0]);
    // The route table: method, path template and query parameter names (in the table's order).
    expect(request.method).toBe(testCase.http);
    expect(entry.method).toBe(testCase.http);
    expect(testCase.path).toMatch(new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, "[^/]+")}$`));
    expect(request.url.split("?")[0]).toBe(`${BASE_URL}${testCase.path}`);
    expect([...request.searchParams]).toEqual(testCase.query);
    // The body: the params that are not path, query or header params, as JSON (never `ifMatch`); none without one.
    if (testCase.body === undefined) {
      expect(request.body).toBeNull();
      expect(request.headers).not.toHaveProperty("content-type");
    } else {
      expect(request.json).toEqual(testCase.body);
      expect(request.headers["content-type"]).toBe("application/json");
    }
    // The headers: the key, the customer token, JSON, one generated Idempotency-Key where the operation takes one,
    // If-Match only where the operation requires it, never the environment header.
    expect(request.headers).toMatchObject({
      accept: "application/json",
      "x-api-key": SK,
      authorization: `Bearer ${AT}`,
      ...testCase.headers,
    });
    if (entry.idempotency === "none") {
      expect(request.headers).not.toHaveProperty("idempotency-key");
    } else {
      expect(request.headers["idempotency-key"]).toMatch(UUID_V4);
    }
    expect(Boolean(testCase.headers?.["if-match"])).toBe("ifMatch" in entry.headerParams);
    expect(request.headers).not.toHaveProperty("x-velexis-environment");
    // Sessions and accounts are personal: no-store unless the call chooses a cache mode itself.
    expect(request.init.cache).toBe("no-store");
    // The result: the response body (a Page of it for a list, nothing for a 204).
    if (entry.queryParams.includes("cursor")) {
      expect(result).toBeInstanceOf(Page);
      expect(JSON.parse(JSON.stringify(result))).toEqual(answer.body);
    } else {
      expect(result).toEqual(answer.body);
    }
  });

  it("keep the call's own cache mode and add no-store otherwise [SDK-008]", async () => {
    const fake = createFakeFetch([
      answerOf("auth.getSession"),
      answerOf("account.get"),
      answerOf("account.get"),
    ]);
    const client = createVelexisClient({ secretKey: SK, accessToken: AT, fetch: fake.fetch });

    await client.auth.getSession({}, { cache: "default" });
    await client.account.get(undefined, { next: { revalidate: 0 } });
    await client.account.get();

    expect(fake.requests.map((request) => request.init.cache)).toEqual(["default", undefined, "no-store"]);
  });
});

describe("session results in token and server mode", () => {
  it("auth.signIn feeds the session: onSessionRefreshed gets result.session and the next calls send its token [SDK-008]", async () => {
    const api = fakeApi();
    const fake = createFakeFetch(api.answers(2));
    /** @type {{ accessToken?: string, refreshToken?: string }} */
    const store = {};
    const onSessionRefreshed = vi.fn((/** @type {Record<string, any>} */ session) => {
      store.accessToken = session["accessToken"];
      store.refreshToken = session["refreshToken"];
    });
    // A browser app's client: its token sources read the integrator's store, which onSessionRefreshed writes.
    const client = createVelexisClient({
      publishableKey: PK,
      accessToken: () => store.accessToken,
      refreshToken: () => store.refreshToken,
      onSessionRefreshed,
      fetch: fake.fetch,
    });

    const result = await client.auth.signIn({ email: "mia.lund@example.com", password: PASSWORD });
    const me = await client.auth.getSession();

    expect(result).toEqual(sessionResult(1));
    expect(onSessionRefreshed).toHaveBeenCalledTimes(1);
    expect(onSessionRefreshed).toHaveBeenCalledWith(sessionResult(1).session);
    expect(me).toEqual(SESSION_INFO);
    const [signIn, getSession] = fake.requests;
    expect(signIn?.headers).not.toHaveProperty("authorization");
    expect(signIn?.init.credentials).toBe("omit");
    expect(getSession?.headers["authorization"]).toBe("Bearer at_sdk008_1");
  });

  it("auth.signIn replaces string tokens: the client sends the new session from then on [SDK-008]", async () => {
    const api = fakeApi({ accessToken: AT, refreshToken: RT });
    const fake = createFakeFetch(api.answers(5));
    const client = createVelexisClient({
      publishableKey: PK,
      accessToken: AT,
      refreshToken: RT,
      fetch: fake.fetch,
    });

    await client.auth.signIn({ email: "mia.lund@example.com", password: PASSWORD });
    // withOptions starts from the client's current session.
    await client.withOptions({ locale: "sv-SE" }).account.get();
    // The new access token expires: the automatic refresh presents the new refresh token, not the configured one.
    api.expire();
    await client.account.get();

    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /v1/auth/sign-in",
      "GET /v1/account",
      "GET /v1/account",
      "POST /v1/auth/refresh",
      "GET /v1/account",
    ]);
    expect(fake.requests[1]?.headers["authorization"]).toBe("Bearer at_sdk008_1");
    expect(fake.requests[2]?.headers["authorization"]).toBe("Bearer at_sdk008_1");
    expect(fake.requests[3]?.json).toEqual({ refreshToken: "rt_sdk008_1_000000000000000000000" });
    expect(fake.requests[4]?.headers["authorization"]).toBe("Bearer at_sdk008_2");
    expect(fake.requests.slice(1).map((request) => request.headers["authorization"])).not.toContain(
      `Bearer ${AT}`,
    );
  });

  it("an explicit auth.refresh sends the refresh token, and the client never presents the rotated one again [SDK-008 AC2]", async () => {
    const api = fakeApi({ accessToken: AT, refreshToken: RT });
    const fake = createFakeFetch(api.answers(5));
    const onSessionRefreshed = vi.fn();
    const onSessionExpired = vi.fn();
    const client = createVelexisClient({
      publishableKey: PK,
      accessToken: AT,
      refreshToken: RT,
      onSessionRefreshed,
      onSessionExpired,
      fetch: fake.fetch,
    });

    const refreshed = await client.auth.refresh({ refreshToken: RT });
    await client.account.get();
    api.expire();
    // Without the session fed, this refresh would present RT again: REFRESH_TOKEN_REUSED and a revoked family.
    await client.account.get();

    expect(refreshed).toEqual(sessionResult(1));
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/auth/refresh",
      json: { refreshToken: RT },
    });
    expect(fake.requests[0]?.headers["x-api-key"]).toBe(PK);
    expect(fake.requests[0]?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(fake.requests[1]?.headers["authorization"]).toBe("Bearer at_sdk008_1");
    expect(fake.requests[3]).toMatchObject({
      path: "/v1/auth/refresh",
      json: { refreshToken: "rt_sdk008_1_000000000000000000000" },
    });
    expect(fake.requests[4]?.headers["authorization"]).toBe("Bearer at_sdk008_2");
    expect(onSessionRefreshed.mock.calls).toEqual([[sessionResult(1).session], [sessionResult(2).session]]);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it("server mode: a token source that still gives the replaced tokens gets the new ones, also when the hook fails [SDK-008]", async () => {
    const api = fakeApi({ accessToken: AT, refreshToken: RT });
    const fake = createFakeFetch(api.answers(3));
    // The integrator's store never learns the new tokens: the hook rejects.
    const onSessionRefreshed = vi.fn(async () => {
      throw new Error("the cookie store is read-only here");
    });
    const client = createVelexisClient({
      secretKey: SK,
      accessToken: () => AT,
      refreshToken: () => RT,
      onSessionRefreshed,
      fetch: fake.fetch,
    });

    await expect(client.auth.refresh({ refreshToken: RT })).resolves.toEqual(sessionResult(1));
    await client.account.get();
    await client.auth.refresh({ refreshToken: "rt_sdk008_1_000000000000000000000" });

    expect(onSessionRefreshed).toHaveBeenCalledTimes(2);
    expect(fake.requests[1]?.headers["authorization"]).toBe("Bearer at_sdk008_1");
    expect(fake.requests[1]?.headers["x-api-key"]).toBe(SK);
    expect(api.state.opened).toBe(2);
  });

  it("auth.changePassword feeds the rotated session, so the old refresh token is never presented again [SDK-008]", async () => {
    const api = fakeApi({ accessToken: AT, refreshToken: RT });
    const fake = createFakeFetch(api.answers(4));
    const onSessionRefreshed = vi.fn();
    const client = createVelexisClient({
      secretKey: SK,
      accessToken: AT,
      refreshToken: RT,
      onSessionRefreshed,
      fetch: fake.fetch,
    });

    await client.auth.changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    api.expire();
    await client.account.get();

    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /v1/auth/password/change",
      "GET /v1/account",
      "POST /v1/auth/refresh",
      "GET /v1/account",
    ]);
    expect(fake.requests[0]?.headers["authorization"]).toBe(`Bearer ${AT}`);
    expect(fake.requests[2]?.json).toEqual({ refreshToken: "rt_sdk008_1_000000000000000000000" });
    expect(onSessionRefreshed.mock.calls).toEqual([[sessionResult(1).session], [sessionResult(2).session]]);
  });

  it("a client without token options reports a session but never sends it: a shared server client keeps none [SDK-008]", async () => {
    const api = fakeApi();
    const fake = createFakeFetch(api.answers(4));
    const onSessionRefreshed = vi.fn();
    const shared = createVelexisClient({ secretKey: SK, onSessionRefreshed, fetch: fake.fetch });

    await shared.auth.signIn({ email: "mia.lund@example.com", password: PASSWORD });
    await shared.auth.signIn({ email: "leo.berg@example.com", password: PASSWORD });
    await expect(shared.account.get()).rejects.toBeInstanceOf(AuthenticationError);
    await expect(shared.withOptions({}).account.get()).rejects.toBeInstanceOf(AuthenticationError);

    expect(onSessionRefreshed.mock.calls).toEqual([[sessionResult(1).session], [sessionResult(2).session]]);
    for (const request of fake.requests) {
      expect(request.headers).not.toHaveProperty("authorization");
    }
  });

  it("auth.signUp and auth.resetPassword resolve with their session but do not feed the client's [SDK-008]", async () => {
    const signedUp = example("auth.signUp").body;
    const reset = example("auth.resetPassword").body;
    expect(signedUp?.["session"]?.["accessToken"]).toEqual(expect.any(String));
    expect(reset?.["session"]?.["accessToken"]).toEqual(expect.any(String));
    const fake = createFakeFetch([
      answerOf("auth.signUp"),
      answerOf("auth.resetPassword"),
      answerOf("account.get"),
    ]);
    const onSessionRefreshed = vi.fn();
    const client = createVelexisClient({
      publishableKey: PK,
      accessToken: AT,
      onSessionRefreshed,
      fetch: fake.fetch,
    });

    await expect(/** @type {RouteCase} */ (CASES[0]).call(client)).resolves.toEqual(signedUp);
    await expect(
      client.auth.resetPassword({ token: "prt_sdk008_fake", newPassword: NEW_PASSWORD }),
    ).resolves.toEqual(reset);
    await client.account.get();

    expect(onSessionRefreshed).not.toHaveBeenCalled();
    expect(fake.requests[2]?.headers["authorization"]).toBe(`Bearer ${AT}`);
  });

  it("a staff client keeps its staff session: a customer's sign-in result is not its session [SDK-008]", async () => {
    const fake = createFakeFetch([{ body: sessionResult(1) }, answerOf("account.get")]);
    const onSessionRefreshed = vi.fn();
    const staff = createVelexisClient({
      secretKey: SK,
      sessionKind: "staff",
      accessToken: STAFF_AT,
      refreshToken: STAFF_RT,
      onSessionRefreshed,
      fetch: fake.fetch,
    });

    await staff.auth.signIn({ email: "mia.lund@example.com", password: PASSWORD });
    await staff.account.get();

    expect(onSessionRefreshed).not.toHaveBeenCalled();
    expect(fake.requests[1]?.headers["authorization"]).toBe(`Bearer ${STAFF_AT}`);
  });

  it("a call with its own access token or Authorization header is not the client's session: its result feeds nothing [SDK-008]", async () => {
    const OTHER_AT = "at_sdk008_other_session";
    const fake = createFakeFetch([
      { body: sessionResult(1) },
      { body: sessionResult(2) },
      { body: sessionResult(3) },
      answerOf("account.get"),
      answerOf("account.get"),
      { body: sessionResult(4) },
    ]);
    const onSessionRefreshed = vi.fn();
    // A client bound to one customer's session, used for a call made as another session.
    const client = createVelexisClient({
      secretKey: SK,
      accessToken: AT,
      refreshToken: RT,
      onSessionRefreshed,
      fetch: fake.fetch,
    });

    await client.auth.changePassword(
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { accessToken: OTHER_AT },
    );
    await client.auth.changePassword(
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { headers: { authorization: `Bearer ${OTHER_AT}` } },
    );
    await client.auth.refresh(
      { refreshToken: "rt_sdk008_other_000000000000000000" },
      { accessToken: OTHER_AT },
    );
    await client.account.get();
    await client.withOptions({ locale: "sv-SE" }).account.get();
    // A client whose own Authorization header wins over the session's has no session the SDK keeps.
    const fixed = createVelexisClient({
      publishableKey: PK,
      accessToken: AT,
      refreshToken: RT,
      headers: { Authorization: `Bearer ${OTHER_AT}` },
      onSessionRefreshed,
      fetch: fake.fetch,
    });
    await fixed.auth.signIn({ email: "mia.lund@example.com", password: PASSWORD });

    expect(fake.requests[0]?.headers["authorization"]).toBe(`Bearer ${OTHER_AT}`);
    expect(fake.requests[1]?.headers["authorization"]).toBe(`Bearer ${OTHER_AT}`);
    expect(fake.requests[2]?.headers["authorization"]).toBe(`Bearer ${OTHER_AT}`);
    // The client still sends its own session, and withOptions starts from it.
    expect(fake.requests[3]?.headers["authorization"]).toBe(`Bearer ${AT}`);
    expect(fake.requests[4]?.headers["authorization"]).toBe(`Bearer ${AT}`);
    expect(fake.requests[5]?.path).toBe("/v1/auth/sign-in");
    expect(onSessionRefreshed).not.toHaveBeenCalled();
  });

  it("a refused sign-in or refresh changes nothing and calls no hook [SDK-008]", async () => {
    const fake = createFakeFetch([
      errorResponse(401, "INVALID_CREDENTIALS", { details: { remainingAttempts: 4 } }),
      errorResponse(401, "REFRESH_TOKEN_INVALID"),
      answerOf("account.get"),
    ]);
    const onSessionRefreshed = vi.fn();
    const onSessionExpired = vi.fn();
    const client = createVelexisClient({
      publishableKey: PK,
      accessToken: AT,
      refreshToken: RT,
      onSessionRefreshed,
      onSessionExpired,
      fetch: fake.fetch,
    });

    await expect(
      client.auth.signIn({ email: "mia.lund@example.com", password: "wrong" }),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    await expect(client.auth.refresh({ refreshToken: RT })).rejects.toBeInstanceOf(AuthenticationError);
    await client.account.get();

    expect(onSessionRefreshed).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(fake.requests[2]?.headers["authorization"]).toBe(`Bearer ${AT}`);
  });
});

describe("cookie mode", () => {
  it("auth.refresh sends an empty body with the CSRF header and no credential; token mode sends the refresh token [SDK-008 AC2]", async () => {
    stubBrowserPage();
    const cookieFake = createFakeFetch([{ body: SESSION_INFO }, { body: SESSION_INFO }]);
    const onSessionRefreshed = vi.fn();
    const onSessionExpired = vi.fn();
    const cookie = createVelexisClient({
      session: "cookie",
      onSessionRefreshed,
      onSessionExpired,
      fetch: cookieFake.fetch,
    });

    await expect(cookie.auth.refresh()).resolves.toEqual(SESSION_INFO);
    await expect(cookie.auth.refresh({})).resolves.toEqual(SESSION_INFO);

    for (const request of cookieFake.requests) {
      expect(`${request.method} ${request.url}`).toBe("POST /api/v1/auth/refresh");
      expect(request.body).toBe("{}");
      expect(request.json).toEqual({});
      expect(request.headers["x-csrf-token"]).toBe(CSRF);
      expect(request.headers["idempotency-key"]).toMatch(UUID_V4);
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.headers).not.toHaveProperty("x-api-key");
      expect(request.init).toMatchObject({
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
      });
    }
    expect(onSessionRefreshed).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    const tokenFake = createFakeFetch([{ body: sessionResult(1) }]);
    const token = createVelexisClient({ publishableKey: PK, fetch: tokenFake.fetch });

    await expect(token.auth.refresh({ refreshToken: RT })).resolves.toEqual(sessionResult(1));

    expect(tokenFake.requests[0]?.json).toEqual({ refreshToken: RT });
    expect(tokenFake.requests[0]?.headers["x-api-key"]).toBe(PK);
    expect(tokenFake.requests[0]?.init.credentials).toBe("omit");
  });

  it.each([
    ["auth.refresh", { refreshToken: RT }, "POST /v1/auth/refresh"],
    ["auth.signOut", { scope: "current", refreshToken: RT }, "POST /v1/auth/sign-out"],
    ["auth.refresh", { refreshToken: null }, "POST /v1/auth/refresh"],
  ])(
    "%s with a refreshToken param is a TypeError before any request [SDK-008 AC2]",
    async (method, params, route) => {
      // Without the CSRF cookie a write would first ask GET /v1/storefront for it: none of that happens either.
      stubBrowserPage({ csrf: false });
      const fake = createFakeFetch();
      const client = createVelexisClient({ session: "cookie", fetch: fake.fetch });

      const error = await methodOf(client, method)(params).catch((/** @type {unknown} */ caught) => caught);

      expect(error).toBeInstanceOf(TypeError);
      expect(/** @type {TypeError} */ (error).message).toBe(
        `Velexis SDK: ${route} takes no "refreshToken" with session "cookie"; the browser sends the __Host-vx_rt cookie`,
      );
      expect(/** @type {TypeError} */ (error).message).not.toContain(RT);
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("auth.signOut without a token is sent as it is, with the CSRF header [SDK-008]", async () => {
    stubBrowserPage();
    const fake = createFakeFetch([{ status: 204 }]);
    const client = createVelexisClient({ session: "cookie", fetch: fake.fetch });

    await expect(client.auth.signOut({ scope: "all" })).resolves.toBeUndefined();

    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/v1/auth/sign-out",
      json: { scope: "all" },
    });
    expect(fake.requests[0]?.headers["x-csrf-token"]).toBe(CSRF);
  });

  it.each(SESSION_METHODS)(
    "%s stores nothing and resolves without token fields, whatever the response says [SDK-008]",
    async (method) => {
      stubBrowserPage();
      // The edge answers AuthSessionInfo; a misrouted answer with tokens must not reach page code either.
      const fake = createFakeFetch([
        { body: SESSION_INFO },
        { body: sessionResult(9) },
        answerOf("auth.getSession"),
      ]);
      const onSessionRefreshed = vi.fn();
      const client = createVelexisClient({ session: "cookie", onSessionRefreshed, fetch: fake.fetch });
      const params = /** @type {RouteCase} */ (CASES.find((testCase) => testCase.method === method));
      const call = () =>
        method === "auth.refresh" ? client.auth.refresh() : /** @type {RouteCase} */ (params).call(client);

      const edge = await call();
      const misrouted = await call();
      await client.auth.getSession();

      expect(edge).toEqual(SESSION_INFO);
      const expected = sessionResult(9);
      const withoutTokens = Object.fromEntries(
        Object.entries(expected.session).filter(([name]) => !["accessToken", "refreshToken"].includes(name)),
      );
      expect(misrouted).toEqual({ ...expected, session: withoutTokens });
      expect(JSON.stringify([edge, misrouted])).not.toMatch(/at_sdk008_9|rt_sdk008_9/);
      expect(onSessionRefreshed).not.toHaveBeenCalled();
      for (const request of fake.requests) {
        expect(request.headers).not.toHaveProperty("authorization");
        expect(request.headers).not.toHaveProperty("x-api-key");
      }
    },
  );

  it.each(["auth.signUp", "auth.resetPassword"])(
    "%s resolves with session: null whatever the response says [SDK-008]",
    async (method) => {
      stubBrowserPage();
      const misrouted = answerOf(method);
      expect(misrouted.body?.["session"]?.["refreshToken"]).toEqual(expect.any(String));
      const fake = createFakeFetch([misrouted]);
      const onSessionRefreshed = vi.fn();
      const client = createVelexisClient({ session: "cookie", onSessionRefreshed, fetch: fake.fetch });

      const result = await /** @type {RouteCase} */ (
        CASES.find((testCase) => testCase.method === method)
      ).call(client);

      expect(result).toEqual({ ...misrouted.body, session: null });
      expect(onSessionRefreshed).not.toHaveBeenCalled();
    },
  );
});

describe("If-Match on the account updates", () => {
  const UPDATES = ["account.update", "account.preferences.update", "account.savedTravelers.update"];

  it.each(UPDATES)("%s sends a version as its ETag and an ETag as it is [SDK-008]", async (method) => {
    const fake = createFakeFetch([answerOf(method), answerOf(method)]);
    const client = createVelexisClient({ publishableKey: PK, accessToken: AT, fetch: fake.fetch });
    const update = methodOf(client, method);
    const ref = method === "account.savedTravelers.update" ? { savedTravelerId: SAVED_TRAVELER_ID } : {};

    await update({ ...ref, ifMatch: 0, marketingConsent: true });
    await update({ ...ref, ifMatch: 'W/"12"', marketingConsent: true });

    expect(fake.requests.map((request) => request.headers["if-match"])).toEqual(['"0"', 'W/"12"']);
    for (const request of fake.requests) {
      expect(request.json).toEqual({ marketingConsent: true });
    }
  });

  it.each(
    UPDATES.flatMap((method) =>
      [undefined, null, "", "  ", -1, 1.5, "a\nb", { version: 3 }].map((ifMatch) => [method, ifMatch]),
    ),
  )("%s with ifMatch %j is a TypeError before any request [SDK-008]", async (method, ifMatch) => {
    stubBrowserPage({ csrf: false });
    const fake = createFakeFetch();
    const client = createVelexisClient({ session: "cookie", fetch: fake.fetch });

    const error = await methodOf(
      client,
      /** @type {string} */ (method),
    )({
      savedTravelerId: SAVED_TRAVELER_ID,
      ifMatch,
    }).catch((/** @type {unknown} */ caught) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(/** @type {TypeError} */ (error).message).toMatch(
      /^Velexis SDK: PATCH \/v1\/account\S* needs "ifMatch", the version of the last read \(a whole number\) or its ETag \(a string\)$/,
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe("account.savedTravelers.list", () => {
  it("returns a Page that iterates across cursors with the same params [SDK-008]", async () => {
    const page = /** @type {Record<string, any>} */ (example("account.savedTravelers.list").body);
    const [traveler] = page["data"];
    const second = { ...traveler, id: "trv_01JA4C9N2Q5T8W1Z4C7F0H3L6Q" };
    const fake = createFakeFetch([
      { body: { ...page, data: [traveler], page: { nextCursor: "cur_2", limit: 1 } } },
      { body: { ...page, data: [second], page: { nextCursor: null, limit: 1 } } },
    ]);
    const client = createVelexisClient({ publishableKey: PK, accessToken: AT, fetch: fake.fetch });

    const first = await client.account.savedTravelers.list({ limit: 1 });
    /** @type {unknown[]} */
    const all = [];
    for await (const item of first) {
      all.push(item);
    }

    expect(first).toBeInstanceOf(Page);
    expect(all).toEqual([traveler, second]);
    expect(fake.requests.map((request) => [...request.searchParams])).toEqual([
      [["limit", "1"]],
      [
        ["cursor", "cur_2"],
        ["limit", "1"],
      ],
    ]);
  });
});

describe("deferred methods", () => {
  it("are the nine account methods of preferences, savedTravelers and dataExports [SDK-008 AC3]", () => {
    expect(DEFERRED).toHaveLength(9);
  });

  it.each(DEFERRED)(
    "%s surfaces 501 NOT_IMPLEMENTED as a ServerError after one request [SDK-008 AC3]",
    async (method) => {
      const fake = createFakeFetch([
        errorResponse(501, "NOT_IMPLEMENTED", { details: { milestone: "deferred" } }),
      ]);
      const client = createVelexisClient({
        publishableKey: PK,
        accessToken: AT,
        fetch: fake.fetch,
        maxRetries: 2,
      });
      const testCase = /** @type {RouteCase} */ (CASES.find((candidate) => candidate.method === method));

      const error = await testCase.call(client).catch((/** @type {unknown} */ caught) => caught);

      expect(error).toBeInstanceOf(ServerError);
      expect(error).toBeInstanceOf(VelexisError);
      expect(error).toMatchObject({
        code: "NOT_IMPLEMENTED",
        status: 501,
        retryable: false,
        details: { milestone: "deferred" },
      });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.path).toBe(testCase.path);
    },
  );
});

describe("the namespace types", () => {
  const NAMESPACE_FILES = ["auth.js", "account.js"].map((name) => join(SDK_ROOT, "src", "namespaces", name));
  const PUBLIC_FILES = ["identity.js", "index.js"].map((name) => join(SDK_ROOT, "src", name));
  const FACTORIES = [
    ["auth.js", "createAuthApi", "auth"],
    ["account.js", "createAccountApi", "account"],
  ];

  /** @type {string[]} */
  const diagnostics = [];
  /**
   * Every method: its name, its params' and awaited result's types as text, the result's members, and for each member
   * type of the result whether its `session` carries tokens (`AuthSessionResult`) or not (`AuthSessionInfo`).
   * @type {{ name: string, types: string[], resultMembers: string[], sessions: string[], loose: boolean }[]}
   */
  const signatures = [];
  /** @type {{ sdk: string[], contract: string[] }} */
  const mirror = { sdk: [], contract: [] };
  /** @type {string[]} the names the package root exports */
  const rootExports = [];
  /** @type {Map<string, string>} the text of each namespace file, as the program read it */
  const namespaceSources = new Map();

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
    for (const file of [...NAMESPACE_FILES, ...PUBLIC_FILES]) {
      const source = program.getSourceFile(file);
      if (source === undefined) {
        throw new Error(`${file} is not part of the SDK's type check`);
      }
      if (NAMESPACE_FILES.includes(file)) {
        namespaceSources.set(file, source.text);
      }
      for (const diagnostic of [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source),
      ]) {
        diagnostics.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
      }
    }
    for (const [fileName, factoryName, namespace] of FACTORIES) {
      const source = /** @type {ts.SourceFile} */ (
        program.getSourceFile(join(SDK_ROOT, "src", "namespaces", /** @type {string} */ (fileName)))
      );
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
          const params = method
            .getParameters()
            .map((parameter) => checker.getTypeOfSymbolAtLocation(parameter, source));
          const result = checker.getAwaitedType(method.getReturnType()) ?? method.getReturnType();
          const types = [...params, result];
          const variants = result.isUnion() ? result.types : [result];
          const sessions = variants.flatMap((variant) => {
            const session = variant.getProperty("session");
            if (session === undefined) {
              return [];
            }
            const sessionType = checker.getNonNullableType(
              checker.getTypeOfSymbolAtLocation(session, source),
            );
            return [sessionType.getProperty("accessToken") === undefined ? "without tokens" : "with tokens"];
          });
          signatures.push({
            name,
            types: types.map((item) => checker.typeToString(item)),
            resultMembers: result.getProperties().map((symbol) => symbol.name),
            sessions: sessions.sort(),
            loose: types.some(isLoose) || params.length !== 2,
          });
        }
      };
      walk(/** @type {ts.Signature} */ (signature).getReturnType(), /** @type {string} */ (namespace));
    }
    /** @param {string} file */
    const exportsOf = (file) =>
      checker.getExportsOfModule(
        /** @type {ts.Symbol} */ (
          checker.getSymbolAtLocation(/** @type {ts.SourceFile} */ (program.getSourceFile(file)))
        ),
      );
    mirror.sdk = exportsOf(join(SDK_ROOT, "src", "identity.js"))
      .filter((symbol) => (symbol.flags & ts.SymbolFlags.TypeAlias) !== 0)
      .map((symbol) => ({ name: symbol.name, start: symbol.declarations?.[0]?.getStart() ?? -1 }))
      .sort((left, right) => left.start - right.start)
      .map((entry) => entry.name);
    const contractFile = join(REPO_ROOT, "docs", "velexis-sdk", "sdk", "src", "identity.d.ts");
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

  it("type-check without a diagnostic in the two namespace files, identity.js and index.js [SDK-008]", () => {
    expect(diagnostics).toEqual([]);
  });

  it("give every method typed params, options and an awaited result, never any or unknown [SDK-008]", () => {
    expect(signatures.map((signature) => signature.name).sort()).toEqual([...ALL_METHODS].sort());
    expect(signatures.filter((signature) => signature.loose)).toEqual([]);
    const byName = Object.fromEntries(signatures.map((signature) => [signature.name, signature]));
    for (const method of ["auth.signOut", "account.savedTravelers.delete"]) {
      expect(byName[method]?.types[2], method).toBe("void");
    }
    // The approved cookie-mode deviation (OADR-0006): the session methods resolve with the union of the token-mode
    // answer (AuthSessionResult, a session with tokens) and the cookie-mode one (AuthSessionInfo, without).
    for (const method of SESSION_METHODS) {
      expect(byName[method]?.sessions, method).toEqual(["with tokens", "without tokens"]);
      expect(byName[method]?.resultMembers, method).toEqual(["session", "customer"]);
    }
    expect(byName["auth.getSession"]?.sessions).toEqual(["without tokens"]);
    expect(byName["auth.signUp"]?.sessions).toEqual(["with tokens"]);
    expect(byName["auth.resetPassword"]?.sessions).toEqual(["with tokens"]);
    expect(byName["account.savedTravelers.list"]?.resultMembers).toEqual(
      expect.arrayContaining(["data", "page", "next"]),
    );
  });

  it("declare no any and suppress no check in the two namespace files [SDK-008]", () => {
    expect([...namespaceSources.keys()]).toEqual(NAMESPACE_FILES);
    for (const file of NAMESPACE_FILES) {
      const source = namespaceSources.get(file) ?? "";
      const types = [
        ...source.matchAll(/@(?:param|returns|type|typedef|template|throws)\s*\{([^}]*)\}/g),
      ].map((match) => match[1] ?? "");
      expect(types.length, file).toBeGreaterThan(0);
      expect(
        types.filter((type) => /\bany\b|\bFunction\b|\bObject\b/.test(type)),
        file,
      ).toEqual([]);
      expect(source, file).not.toMatch(/@ts-(?:ignore|expect-error|nocheck)/);
    }
  });

  it("declare every type name of identity.d.ts in the contract's order, exported from the root [SDK-008]", () => {
    // EndUserContext and EndUserSource are declared in shared.js, which the root re-exports as well (identity.js).
    const inShared = ["EndUserContext", "EndUserSource"];
    expect(mirror.contract).toHaveLength(33);
    expect(mirror.sdk).toEqual(mirror.contract.filter((name) => !inShared.includes(name)));
    expect(rootExports).toEqual(
      expect.arrayContaining([...mirror.contract, "createAuthApi", "createAccountApi"]),
    );
  });
});
