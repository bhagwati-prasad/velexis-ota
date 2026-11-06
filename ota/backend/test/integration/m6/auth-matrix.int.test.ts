// The authentication matrix of the OTA API (OBE-084 step 1; ota/docs/security-review.md §3.1, architecture §3 and
// §3.1, OADR-0009, OADR-0011 points 4 to 6): EVERY operation of the operations index (`otaOperations` of
// @velexis/api-types/operations, generated from the OTA document) is called with each credential below, and each
// answer must be the one the operation's own contract metadata calls for: its `x-scope`, `x-edge-only`,
// `x-permission`, its `security` alternatives (which say where a customer or a staff token is required), and whether it
// is still pending (the route-parity allow-list). The expectations are computed from that metadata and the documented
// rules of the guards (the table of `expectedAnswer` below), never read back from the code. A new operation of the
// document joins the matrix by itself; one the matrix cannot classify fails the coverage test.
//
// The credentials ("columns"):
//
//   none            no credential at all
//   edge            the hosted storefront of tenant alpha through Caddy (X-Velexis-Edge, X-Velexis-Host, the CSRF pair
//                   on writes), without a customer
//   pk              alpha's publishable key from its listed storefront origin
//   skStorefront    alpha's secret key scoped `storefront`
//   skConsole       alpha's secret key scoped `console` (console calls with a staff token only), without a token
//   service         the OTA admin's service key on a direct loopback connection, with X-Velexis-End-User-IP and
//                   X-Velexis-Environment, without a staff token
//   wrongTenant     the right credential for alpha with tenant beta's token where the operation reads one (a customer
//                   access cookie, a staff token, a portal or refresh token), else beta's publishable key from alpha's
//                   storefront origin
//   right           the operation's own credential: nothing for the public, webhook and health routes; the storefront
//                   edge (with alpha's signed-in customer) for customer and both operations; the service key with an
//                   owner's staff token for console operations
//   permOnly        (console operations with an `x-permission`) a `console:automation` key holding exactly that one
//                   permission
//   permMissing     (same) a `console:automation` key holding every other permission but that one
//   serviceViaApi   the service key with the X-Forwarded-For and X-Forwarded-Host that Caddy adds on
//                   api.ota.example.com: never the service caller (`401 INVALID_API_KEY`)
//   serviceViaEdge  the same through the storefront's /api/* (Caddy's edge headers as well): `400 INVALID_REQUEST`
//   pkOtherOrigin   alpha's publishable key from an origin it does not list: `403 ORIGIN_NOT_ALLOWED` (FIX-W45-OTA)
//   serviceNoIp     the OTA admin's service key on a direct loopback connection without X-Velexis-End-User-IP:
//                   `400 VALIDATION_FAILED` (FIX-W45-OTA)
//
// The requests reach no use case: every path parameter is a placeholder no schema takes (`~`) and every body `[]`, so
// an allowed call ends in the request validation (`400 VALIDATION_FAILED`), or `200` for a read without a path
// parameter or a required query parameter, the same answer whatever the allowed credential. A refused call is told
// apart by its code, and every guard runs before the validation (architecture §3). Two exceptions: the customer
// operations on one booking name a booking id of the right shape that no booking has, because their booking access
// guard runs before the validation (an allowed caller gets its `404 NOT_FOUND`); and the wrong-tenant session operations
// of the console (sign-in, refresh) send a real body with beta's portal or refresh token, which the handler refuses.
// Every answer but a pending operation's `501` (route parity) is also checked against the document
// (`expectResponseToMatch`: a status the operation lists and a body of that response's schema). The document lists
// all of them since OBE-095 closed finding OTA-SR-05: the `400`s of a path value and of the edge header beside an API
// key, and the credential refusals (`401`, `403`) of the Stripe receivers, were missing before. And every error code an
// answer carries, that `501` aside, is one of the operation's `x-error-codes` (FIX-W45-OTA, lead decision (9e) of
// 2026-11-06): the generic refusals of the guards included, which the last four columns meet on every operation (the
// caller guard checks a credential on every route, the 501 ones, the public files, the receivers and health included).
//
// Every request has an end-user IP address of its own (X-Forwarded-For through "Caddy", X-Velexis-End-User-IP for the
// key servers and the service caller), so no per-IP limit of architecture §8 ever answers 429 here. All requests run in
// `beforeAll` hooks with budgets of their own; the tests read what they answered. Keys, tokens and names are made up per
// run.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { otaOperations, type ApiOperation, type OtaOperationId } from "@velexis/api-types/operations";
import { hashApiKey, sha256Hex } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STOREFRONT_COOKIES } from "../../../src/common/http/cookie-writer";
import { loadOpenApiDocument } from "../../../src/common/http/openapi-validation.interceptor";
import { PENDING_OPERATIONS } from "../../../src/common/http/pending-operations";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { hashCustomerPassword } from "../../../src/identity/sign-in.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import {
  newApiKey,
  newCsrfToken,
  TEST_STOREFRONT_BASE_DOMAIN,
  testApiCredentials,
} from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type Operation = ApiOperation<OtaOperationId>;

/** The credentials of the matrix (see the file header). */
const COLUMNS = [
  "none",
  "edge",
  "pk",
  "skStorefront",
  "skConsole",
  "service",
  "wrongTenant",
  "right",
  "permOnly",
  "permMissing",
  "serviceViaApi",
  "serviceViaEdge",
  "pkOtherOrigin",
  "serviceNoIp",
] as const;
type Column = (typeof COLUMNS)[number];

/** The permission columns apply to console operations with an `x-permission` other than `none` only. */
const PERMISSION_COLUMNS: ReadonlySet<Column> = new Set<Column>(["permOnly", "permMissing"]);

/** The placeholder of every path parameter: a value no path parameter's schema takes. */
const PLACEHOLDER = "~";

/** An origin that no publishable key of the matrix lists (the `pkOtherOrigin` column). */
const OTHER_ORIGIN = "https://elsewhere.example.com";

/** A booking id of the document's shape (`BookingId`) that no booking has, for the operations on one booking. */
const UNKNOWN_BOOKING_ID = `bkg_${randomBytes(12).toString("hex")}`;

const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/**
 * The matrix: about seventeen hundred requests, each answered by a guard or the request validation, a few seconds
 * locally; the bound allows for a busy 4-CPU runner and only stops a run that hangs.
 */
const MATRIX_TIMEOUT_MS = 180_000;

// ---- The contract metadata the expectations come from ------------------------------------------------------------

const DOCUMENT = (): JsonObject => loadOpenApiDocument().document as JsonObject;

/** The operation object of `operation` in the document. */
function specOf(operation: Operation): JsonObject {
  const paths = DOCUMENT()["paths"] as Record<string, JsonObject>;
  return ((paths[operation.path] ?? {})[operation.method] ?? {}) as JsonObject;
}

/** The `security` alternatives of an operation (its own, else the document's), each as its scheme names. */
function securityOf(operation: Operation): string[][] {
  const own = specOf(operation)["security"] as JsonObject[] | undefined;
  const alternatives = own ?? (DOCUMENT()["security"] as JsonObject[] | undefined) ?? [];
  return alternatives.map((alternative) => Object.keys(alternative));
}

/** Whether a token is required, optional or not read for a caller's scheme (as the document's alternatives say). */
type Requirement = "required" | "optional" | "none";

/**
 * Whether the alternatives with `callerScheme` (`apiKey` or `storefrontEdge`) carry `tokenScheme` in all, some or
 * none of them; `none` also when the caller's scheme has no alternative at all.
 */
function requirementOf(
  operation: Operation,
  callerScheme: string,
  tokenSchemes: readonly string[],
): Requirement {
  const alternatives = securityOf(operation).filter((schemes) => schemes.includes(callerScheme));
  const withToken = alternatives.filter((schemes) => tokenSchemes.some((scheme) => schemes.includes(scheme)));
  if (withToken.length === 0) {
    return "none";
  }
  return withToken.length === alternatives.length ? "required" : "optional";
}

/** The customer's token on the storefront edge (cookie) and for keys (bearer); a guest booking token opens a booking too. */
const edgeCustomer = (operation: Operation): Requirement =>
  requirementOf(operation, "storefrontEdge", ["customerCookie", "bookingCookie"]);
const keyCustomer = (operation: Operation): Requirement =>
  requirementOf(operation, "apiKey", ["customerAuth", "bookingToken"]);
/** Whether a key caller's console call takes a staff token. */
const keyStaff = (operation: Operation): Requirement => requirementOf(operation, "apiKey", ["staffAuth"]);

/** An operation the API answers without any credential: `security: []` (public files, webhooks, health). */
const isOpen = (operation: Operation): boolean => securityOf(operation).length === 0;
const isPending = (operation: Operation): boolean => Object.hasOwn(PENDING_OPERATIONS, operation.operationId);
/**
 * A pending operation's `501 NOT_IMPLEMENTED` (route parity): the one answer of the matrix that the document does not
 * list; every other answer, the pending operations' guard refusals included, is a documented response (OBE-095).
 */
const isPendingAnswer = (operation: Operation, res: Response): boolean =>
  isPending(operation) && res.status === 501;
/** The error codes the document lists for an operation (`x-error-codes`). */
const errorCodesOf = (operation: Operation): readonly string[] =>
  (specOf(operation)["x-error-codes"] as string[] | undefined) ?? [];
/** A console operation whose `x-permission` the permission guard checks (not the four staff-session operations). */
const isGuardedConsole = (operation: Operation): boolean =>
  operation.scope === "console" && operation.permission !== null && operation.permission !== "none";

/** The required query parameters of an operation in the document (its path item's included). */
function requiredQueryParameters(operation: Operation): string[] {
  const document = DOCUMENT();
  const item = ((document["paths"] as Record<string, JsonObject>)[operation.path] ?? {}) as JsonObject;
  const parameters = [
    ...((item["parameters"] as JsonObject[] | undefined) ?? []),
    ...((specOf(operation)["parameters"] as JsonObject[] | undefined) ?? []),
  ];
  const components = (document["components"] as JsonObject)["parameters"] as Record<string, JsonObject>;
  return parameters
    .map((parameter) =>
      typeof parameter["$ref"] === "string"
        ? (components[parameter["$ref"].replace("#/components/parameters/", "")] ?? {})
        : parameter,
    )
    .filter((parameter) => parameter["in"] === "query" && parameter["required"] === true)
    .map((parameter) => String(parameter["name"]));
}

/** `[status, error code]` of an answer: the code is `undefined` for a success. */
type Answer = readonly [number, string | undefined];

const VALIDATION: Answer = [400, "VALIDATION_FAILED"];
const OK: Answer = [200, undefined];
const INVALID_API_KEY: Answer = [401, "INVALID_API_KEY"];
const UNAUTHENTICATED: Answer = [401, "UNAUTHENTICATED"];
const SCOPE_NOT_ALLOWED: Answer = [403, "SCOPE_NOT_ALLOWED"];
const FORBIDDEN: Answer = [403, "FORBIDDEN"];
const ORIGIN_NOT_ALLOWED: Answer = [403, "ORIGIN_NOT_ALLOWED"];
const NOT_IMPLEMENTED: Answer = [501, "NOT_IMPLEMENTED"];
const INVALID_REQUEST: Answer = [400, "INVALID_REQUEST"];
const NOT_FOUND: Answer = [404, "NOT_FOUND"];

/**
 * A customer operation on one booking (`/v1/bookings/{bookingId}…`): the booking access guard runs before the
 * validation, so its path carries a booking id of the right shape that no booking has (`UNKNOWN_BOOKING_ID`), and an
 * allowed caller is answered `404 NOT_FOUND` (the guard's answer to an unknown id).
 */
const opensBooking = (operation: Operation): boolean =>
  operation.scope === "customer" && operation.path.startsWith("/v1/bookings/{bookingId}");

/**
 * What an allowed matrix call answers: `200` for a read without a path parameter or a required query parameter, else
 * the request validation's refusal of the placeholder or the body.
 */
function allowedAnswer(operation: Operation): Answer {
  if (opensBooking(operation)) {
    return NOT_FOUND;
  }
  return operation.method === "get" &&
    !operation.path.includes("{") &&
    requiredQueryParameters(operation).length === 0
    ? OK
    : VALIDATION;
}

/** The documented answer of `operation` to the credential of `column` (see the file header). */
interface Expected {
  readonly answer: Answer;
  /** `details.reason` of a `SCOPE_NOT_ALLOWED`, `details.requiredPermission` of a `FORBIDDEN`, … when they are part of it. */
  readonly details?: JsonObject;
  /** The rule of the table below that decided it, for the failure message. */
  readonly rule: string;
}

const expect_ = (answer: Answer, rule: string, details?: JsonObject): Expected =>
  details === undefined ? { answer, rule } : { answer, rule, details };

/**
 * The table of the matrix: the answer the documented rules give `operation` for `column`. Each line names the rule it
 * follows (architecture §3.1 and the guards' file headers, which quote the document).
 */
function expectedAnswer(operation: Operation, column: Column): Expected {
  // The service key that came through Caddy is no service caller (OADR-0009 rule 1.2): with the edge headers beside it
  // it is an ambiguous request, else an unknown `sk_` key; on every route, the 501 ones included (caller guard).
  if (column === "serviceViaEdge") {
    return expect_(INVALID_REQUEST, "edge header and X-Api-Key together", { reason: "edge_with_api_key" });
  }
  if (column === "serviceViaApi") {
    return expect_(INVALID_API_KEY, "service key through Caddy is an unknown key");
  }
  // The caller guard checks a credential on every route before anything else: a publishable key's origin allow-list
  // (api-key.verifier.ts) and the service caller's end-user address (caller.guard.ts endUserOf).
  if (column === "pkOtherOrigin") {
    return expect_(ORIGIN_NOT_ALLOWED, "a publishable key from an origin it does not list");
  }
  if (column === "serviceNoIp") {
    return expect_(VALIDATION, "the service key without X-Velexis-End-User-IP");
  }
  // A pending operation: the caller guard runs, nothing else (the 501 routes skip tenant, scope and validation).
  if (isPending(operation)) {
    if (column === "none") {
      return expect_(INVALID_API_KEY, "pending: a credential is required");
    }
    if (column === "wrongTenant") {
      return expect_(ORIGIN_NOT_ALLOWED, "pending: beta's publishable key from alpha's origin");
    }
    return expect_(NOT_IMPLEMENTED, "pending: 501 for any accepted credential", {
      milestone: "deferred",
      operationId: operation.operationId,
    });
  }
  if (isOpen(operation)) {
    return expectedOpen(operation, column);
  }
  if (column === "none") {
    return expect_(INVALID_API_KEY, "no credential on an authenticated route");
  }
  if (operation.scope === "console") {
    return expectedConsole(operation, column);
  }
  return expectedCustomer(operation, column);
}

/** The public routes (`security: []`): files and images, webhooks, health. */
function expectedOpen(operation: Operation, column: Column): Expected {
  const internal = operation.scope === "internal";
  if (column === "none" || column === "right") {
    return expect_(openAnswer(operation), "no credential needed (security: [])");
  }
  if (column === "wrongTenant") {
    // A credential sent to a public route is still checked (caller guard): a publishable key from an origin it does not list.
    return expect_(
      ORIGIN_NOT_ALLOWED,
      "a key on a public route is still checked: beta's pk from alpha's origin",
    );
  }
  if (PERMISSION_COLUMNS.has(column)) {
    throw new Error(`${operation.operationId}: no ${column} column on a public route`);
  }
  if (internal && isHealth(operation)) {
    // The health endpoints bind no operation: a valid credential is checked and then ignored.
    return expect_(openAnswer(operation), "health: a valid credential changes nothing");
  }
  if (internal) {
    // A webhook receiver bound to an `x-scope: internal` operation: no credential's scope reaches it.
    return expect_(SCOPE_NOT_ALLOWED, "x-scope internal: no credential's scope", { reason: "no_scope" });
  }
  // getPublicAsset and downloadFile (`x-scope: both`): the path names the tenant (or the signature the file); a valid
  // credential changes nothing, the service caller is console-only all the same.
  if (column === "service") {
    return expect_(SCOPE_NOT_ALLOWED, "service key: console operations only", {
      reason: "service_console_only",
    });
  }
  return expect_(openAnswer(operation), "public route: a valid credential changes nothing");
}

const isHealth = (operation: Operation): boolean => operation.path.startsWith("/health/");

/** What an open route answers to a matrix call (placeholder path values, `[]` bodies). */
function openAnswer(operation: Operation): Answer {
  if (isHealth(operation)) {
    return OK;
  }
  return VALIDATION;
}

/** Customer and both operations. */
function expectedCustomer(operation: Operation, column: Column): Expected {
  const edgeOnly = operation.edgeOnly;
  switch (column) {
    case "edge":
      return edgeCustomer(operation) === "required"
        ? expect_(UNAUTHENTICATED, "edge without the customer cookie the operation requires")
        : expect_(allowedAnswer(operation), "edge, customer scope");
    case "pk":
    case "skStorefront":
    case "skConsole":
      if (edgeOnly) {
        return expect_(SCOPE_NOT_ALLOWED, "x-edge-only: keys are refused", { reason: "edge_only" });
      }
      return keyCustomer(operation) === "required"
        ? expect_(UNAUTHENTICATED, "key without the customer token the operation requires")
        : expect_(allowedAnswer(operation), "key, customer scope (any key scope)");
    case "service":
      return expect_(SCOPE_NOT_ALLOWED, "service key: console operations only", {
        reason: edgeOnly ? "edge_only" : "service_console_only",
      });
    case "wrongTenant":
      return edgeCustomer(operation) === "none"
        ? expect_(ORIGIN_NOT_ALLOWED, "beta's publishable key from alpha's storefront origin")
        : expect_(
            UNAUTHENTICATED,
            "beta's customer cookie on alpha's storefront (tid must equal the tenant)",
          );
    case "right":
      return expect_(allowedAnswer(operation), "the storefront edge with alpha's customer");
    case "none":
    case "permOnly":
    case "permMissing":
    case "serviceViaApi":
    case "serviceViaEdge":
    case "pkOtherOrigin":
    case "serviceNoIp":
      // Decided before (expectedAnswer) or not a column of a customer operation (columnsOf).
      throw new Error(`${operation.operationId}: no ${column} column on a customer operation`);
  }
}

/** Console operations. */
function expectedConsole(operation: Operation, column: Column): Expected {
  const session = operation.permission === "none";
  const permission = String(operation.permission);
  switch (column) {
    case "edge":
    case "pk":
      return expect_(SCOPE_NOT_ALLOWED, "edge and pk_ never reach console scope", {
        reason: "console_operation",
      });
    case "skStorefront":
      return expect_(SCOPE_NOT_ALLOWED, "a key scoped storefront is refused on console operations", {
        reason: "storefront_key",
      });
    case "skConsole":
      if (keyStaff(operation) === "required") {
        return expect_(UNAUTHENTICATED, "a staff token is required (console.auth.me)");
      }
      if (session) {
        return expect_(
          allowedAnswer(operation),
          "staff-session operation: any secret key not scoped storefront",
        );
      }
      return expect_(SCOPE_NOT_ALLOWED, "key-only console call without console:automation", {
        requiredScope: "console:automation",
      });
    case "service":
      if (session && keyStaff(operation) !== "required") {
        return expect_(
          allowedAnswer(operation),
          "service key: the staff-session operations need no staff token",
        );
      }
      return expect_(UNAUTHENTICATED, "service key: every other console operation needs the staff token");
    case "wrongTenant":
      if (keyStaff(operation) === "none") {
        // console.auth.signIn and refresh: beta's portal or refresh token with alpha's key, refused by the handler.
        return expect_(
          [401, operation.operationId === "consoleSignIn" ? "PORTAL_TOKEN_INVALID" : "REFRESH_TOKEN_INVALID"],
          "beta's portal or refresh token with alpha's secret key",
        );
      }
      return expect_(
        UNAUTHENTICATED,
        "beta's staff token with alpha's console key (tid must equal the tenant)",
      );
    case "right":
      return expect_(allowedAnswer(operation), "the service key with an owner's staff token");
    case "permOnly":
      return expect_(allowedAnswer(operation), "a console:automation key with exactly the x-permission");
    case "permMissing":
      return expect_(FORBIDDEN, "a console:automation key without the x-permission", {
        requiredPermission: permission,
      });
    case "none":
    case "serviceViaApi":
    case "serviceViaEdge":
    case "pkOtherOrigin":
    case "serviceNoIp":
      // Decided before (expectedAnswer).
      throw new Error(`${operation.operationId}: no ${column} column on a console operation`);
  }
}

/** The columns `operation` is called with. */
function columnsOf(operation: Operation): Column[] {
  return COLUMNS.filter(
    (column) => !PERMISSION_COLUMNS.has(column) || (isGuardedConsole(operation) && !isPending(operation)),
  );
}

// ---- Fixtures ------------------------------------------------------------------------------------------------------

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;

const PASSWORD = `Fjord-${randomBytes(9).toString("base64url")}`;

interface Tenant {
  readonly key: "alpha" | "beta";
  readonly schema: "tenant_alpha" | "tenant_beta";
  readonly host: string;
  readonly origin: string;
  id: string;
  pk: string;
  skStorefront: string;
  skConsole: string;
  /** The signed-in customer's access token (the `__Host-vx_at` cookie the edge sign-in set). */
  customerAccess: string;
  /** The owner's staff session, signed in through the OTA admin's service key. */
  staffAccess: string;
  staffRefresh: string;
}

const newTenant = (key: "alpha" | "beta"): Tenant => ({
  key,
  schema: key === "alpha" ? "tenant_alpha" : "tenant_beta",
  host: `${key}.${TEST_STOREFRONT_BASE_DOMAIN}`,
  origin: `https://${key}.${TEST_STOREFRONT_BASE_DOMAIN}`,
  id: "",
  pk: "",
  skStorefront: "",
  skConsole: "",
  customerAccess: "",
  staffAccess: "",
  staffRefresh: "",
});
const alpha = newTenant("alpha");
const beta = newTenant("beta");

/** The `console:automation` keys of alpha by permission: holding only it, and holding every other one. */
const permissionKeys = new Map<string, { readonly only: string; readonly missing: string }>();

/** Issues a test key of `tenant` as the platform does. */
async function issueKey(tenant: Tenant, kind: "pk" | "sk", scopes: readonly string[] = []): Promise<string> {
  const key = newApiKey(kind);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenant.id,
      name: kind === "pk" ? "Storefront (test)" : `Server ${scopes.join(" ") || "(unscoped)"}`,
      kind: kind === "pk" ? "publishable" : "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      scopes: [...scopes],
      ...(kind === "pk" ? { allowed_origins: [tenant.origin] } : {}),
    })
    .execute();
  return key;
}

/** Writes `tenant`'s platform row (active, test storefront) and seeds its storefront settings as provisioning does. */
async function insertTenant(tenant: Tenant): Promise<void> {
  tenant.id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: tenant.id,
      key: tenant.key,
      name: `${tenant.key} Travel`,
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/Madrid",
      storefront_environment: "test",
    })
    .execute();
  await tenantTx(tenantDb, tenant.schema, (trx) =>
    seedStorefrontSettings(trx, {
      name: `${tenant.key} Travel`,
      defaultCurrency: "EUR",
      defaultLocale: "en",
    }),
  );
}

/** Inserts an active, verified customer of `tenant` with PASSWORD and signs it in through the storefront edge. */
async function signInCustomer(tenant: Tenant, passwordHash: string): Promise<void> {
  const id = newId("cus");
  const email = `matrix-${randomBytes(4).toString("hex")}@example.com`;
  await tenantTx(tenantDb, tenant.schema, async (trx) => {
    await trx
      .insertInto("customers")
      .values({
        id,
        email,
        status: "active",
        first_name: "Anna",
        last_name: "Berg",
        email_verified_at: new Date(),
      })
      .execute();
    await trx
      .insertInto("customer_identities")
      .values({
        id: newId("cid"),
        customer_id: id,
        provider: "password",
        provider_subject: email,
        password_hash: passwordHash,
        email,
        email_verified_at: new Date(),
      })
      .execute();
  });
  const res = await request(api.server)
    .post("/v1/auth/sign-in")
    .set({ ...edgeHeaders(tenant, true), "Idempotency-Key": randomUUID() })
    .send({ email, password: PASSWORD });
  const cookie = setCookie(res, STOREFRONT_COOKIES.accessToken);
  if (res.status !== 200 || cookie === undefined) {
    throw new Error(`${tenant.key}: the customer sign-in answered ${res.status} ${JSON.stringify(res.body)}`);
  }
  tenant.customerAccess = cookie;
}

/** The value of the `name` cookie a response set. */
function setCookie(res: Response, name: string): string | undefined {
  const cookies = ([] as string[]).concat((res.headers["set-cookie"] as string[] | string | undefined) ?? []);
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found?.slice(name.length + 1).split(";", 1)[0];
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** An owner of `tenant` and a portal token for it, stored as the platform's createConsoleToken stores one. */
async function ownerPortalToken(tenant: Tenant): Promise<string> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: `owner.${randomBytes(4).toString("hex")}@example.com`,
      full_name: "Maria Lopez",
      status: "active",
      email_verified_at: new Date(),
      locale: "en-GB",
      time_zone: "Europe/Paris",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: tenant.id, account_id: accountId, role: "owner", status: "active" })
    .execute();
  return portalToken(tenant, accountId, staffId);
}

const memberships = new Map<string, { readonly accountId: string; readonly staffId: string }>();

async function portalToken(tenant: Tenant, accountId: string, staffId: string): Promise<string> {
  memberships.set(tenant.key, { accountId, staffId });
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  const value = JSON.stringify({
    v: 1,
    accountId,
    tenantId: tenant.id,
    membershipId: staffId,
    role: "owner",
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 300, "NX")).toBe(
    "OK",
  );
  return token;
}

/** Signs `tenant`'s owner in through the OTA admin's service key. */
async function signInStaff(tenant: Tenant): Promise<void> {
  const res = await request(api.server)
    .post("/v1/console/auth/sign-in")
    .set({ ...serviceHeaders(), "Idempotency-Key": randomUUID() })
    .send({ grantType: "portal_token", portalToken: await ownerPortalToken(tenant) });
  const session = (res.body as { session?: { accessToken?: string; refreshToken?: string } }).session;
  if (res.status !== 200 || session?.accessToken === undefined || session.refreshToken === undefined) {
    throw new Error(`${tenant.key}: the staff sign-in answered ${res.status} ${JSON.stringify(res.body)}`);
  }
  tenant.staffAccess = session.accessToken;
  tenant.staffRefresh = session.refreshToken;
}

// ---- Headers of each credential -------------------------------------------------------------------------------------

let ipCounter = 0;
/** A new end-user address (an IPv6 /64 of its own in the documentation range), so no per-IP limit is ever reached. */
const newIp = (): string => {
  ipCounter += 1;
  return `2001:db8:${(ipCounter >> 16) & 0xffff}:${ipCounter & 0xffff}::1`;
};

const isWrite = (method: string): boolean => !["get", "head", "options"].includes(method);

/** The headers Caddy adds to a storefront's `/api/*` request, from a new client address; the CSRF pair on writes. */
function edgeHeaders(tenant: Tenant, write: boolean, customerAccess?: string): Record<string, string> {
  const csrf = newCsrfToken();
  const cookies = [
    ...(write ? [`${STOREFRONT_COOKIES.csrf}=${csrf}`] : []),
    ...(customerAccess === undefined ? [] : [`${STOREFRONT_COOKIES.accessToken}=${customerAccess}`]),
  ];
  return {
    "X-Velexis-Edge": testApiCredentials().edgeSecret,
    "X-Velexis-Host": tenant.host,
    "X-Forwarded-For": newIp(),
    "X-Forwarded-Host": tenant.host,
    ...(write ? { Origin: tenant.origin, "X-CSRF-Token": csrf } : {}),
    ...(cookies.length === 0 ? {} : { Cookie: cookies.join("; ") }),
  };
}

/** A publishable key from `origin`, through Caddy (the browser's address). */
const pkHeaders = (key: string, origin: string): Record<string, string> => ({
  "X-Api-Key": key,
  Origin: origin,
  "X-Forwarded-For": newIp(),
  "X-Forwarded-Host": `api.${TEST_STOREFRONT_BASE_DOMAIN}`,
});

/** A secret key from a storefront or console server, which forwards its end user's address. */
const skHeaders = (key: string, bearer?: string): Record<string, string> => ({
  "X-Api-Key": key,
  "X-Velexis-End-User-IP": newIp(),
  "X-Velexis-End-User-Agent": "Mozilla/5.0 (auth matrix)",
  ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
});

/** The OTA admin's server: the service key on the loopback, the staff member's address, the test environment. */
const serviceHeaders = (bearer?: string): Record<string, string> => ({
  "X-Api-Key": testApiCredentials().serviceKey,
  "X-Velexis-End-User-IP": newIp(),
  "X-Velexis-End-User-Agent": "Mozilla/5.0 (auth matrix)",
  "X-Velexis-Environment": "test",
  ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
});

/** What the request of `operation` sends for `column`: headers, and a body other than `[]` when it needs one. */
function credentialOf(
  operation: Operation,
  column: Column,
): { headers: Record<string, string>; body?: unknown } {
  const write = isWrite(operation.method);
  const console = operation.scope === "console";
  switch (column) {
    case "none":
      return { headers: {} };
    case "edge":
      return { headers: edgeHeaders(alpha, write) };
    case "pk":
      return { headers: pkHeaders(alpha.pk, alpha.origin) };
    case "skStorefront":
      return { headers: skHeaders(alpha.skStorefront) };
    case "skConsole":
      return { headers: skHeaders(alpha.skConsole) };
    case "service":
      return { headers: serviceHeaders() };
    case "serviceViaApi":
      return {
        headers: {
          ...serviceHeaders(),
          "X-Forwarded-For": newIp(),
          "X-Forwarded-Host": `api.${TEST_STOREFRONT_BASE_DOMAIN}`,
        },
      };
    case "serviceViaEdge":
      return {
        headers: {
          ...serviceHeaders(),
          "X-Velexis-Edge": testApiCredentials().edgeSecret,
          "X-Velexis-Host": alpha.host,
          "X-Forwarded-For": newIp(),
          "X-Forwarded-Host": alpha.host,
        },
      };
    case "pkOtherOrigin":
      return { headers: pkHeaders(alpha.pk, OTHER_ORIGIN) };
    case "serviceNoIp": {
      const { "X-Velexis-End-User-IP": _ip, ...withoutIp } = serviceHeaders();
      return { headers: withoutIp };
    }
    case "right":
      if (isOpen(operation)) {
        return { headers: {} };
      }
      return console
        ? { headers: serviceHeaders(alpha.staffAccess) }
        : { headers: edgeHeaders(alpha, write, alpha.customerAccess) };
    case "wrongTenant":
      return wrongTenantOf(operation, write);
    case "permOnly":
      return { headers: skHeaders(permissionKeys.get(String(operation.permission))?.only ?? "") };
    case "permMissing":
      return { headers: skHeaders(permissionKeys.get(String(operation.permission))?.missing ?? "") };
  }
}

/** The wrong-tenant credential of `operation` (see the file header). */
function wrongTenantOf(
  operation: Operation,
  write: boolean,
): { headers: Record<string, string>; body?: unknown } {
  if (operation.scope === "console" && !isPending(operation)) {
    if (operation.operationId === "consoleSignIn") {
      // A portal token of beta's owner, presented with alpha's key: the tenant of a key's sign-in is the key's.
      return {
        headers: skHeaders(alpha.skConsole),
        body: { grantType: "portal_token", portalToken: betaPortalToken },
      };
    }
    if (operation.operationId === "consoleRefreshSession") {
      return { headers: skHeaders(alpha.skConsole), body: { refreshToken: beta.staffRefresh } };
    }
    return { headers: skHeaders(alpha.skConsole, beta.staffAccess) };
  }
  if (!isPending(operation) && !isOpen(operation) && edgeCustomer(operation) !== "none") {
    return { headers: edgeHeaders(alpha, write, beta.customerAccess) };
  }
  return { headers: pkHeaders(beta.pk, alpha.origin) };
}

/** A portal token of beta's owner for the wrong-tenant sign-in (kept until the end: the key's sign-in refuses it). */
let betaPortalToken = "";

/** Sends the matrix request of `operation` for `column`. */
function send(operation: Operation, column: Column): Promise<Response> {
  const path = operation.path
    .replace("{bookingId}", opensBooking(operation) ? UNKNOWN_BOOKING_ID : PLACEHOLDER)
    .replace(/\{[^}]+\}/g, PLACEHOLDER);
  const { headers, body } = credentialOf(operation, column);
  const write = isWrite(operation.method);
  const all = write ? { ...headers, "Idempotency-Key": randomUUID(), "If-Match": '"1"' } : headers;
  const agent = request(api.server);
  switch (operation.method) {
    case "get":
      return agent.get(path).set(all).then();
    case "delete":
      return agent.delete(path).set(all).then();
    case "post":
      // The asset upload takes multipart/form-data only (the body parsers refuse anything else before the guards).
      return operation.operationId === "consoleUploadStorefrontAsset"
        ? agent.post(path).set(all).field("kind", PLACEHOLDER).then()
        : agent
            .post(path)
            .set(all)
            .send((body ?? []) as object)
            .then();
    case "put":
      return agent
        .put(path)
        .set(all)
        .send((body ?? []) as object)
        .then();
    case "patch":
      return agent
        .patch(path)
        .set(all)
        .send((body ?? []) as object)
        .then();
    case "head":
    case "options":
    case "trace":
      throw new Error(`no request of the matrix for ${operation.method}`);
  }
}

const answerOf = (res: Response): Answer => [
  res.status,
  (res.body as { error?: { code?: string } } | undefined)?.error?.code,
];

// ---- What the matrix answered --------------------------------------------------------------------------------------

interface Cell {
  readonly operation: Operation;
  readonly column: Column;
  readonly res: Response;
}

const cells: Cell[] = [];

beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of every operation, compiled once here rather than inside the first test: every answer of
  // the matrix but a pending 501 is checked against the document (the 404 of the booking access guard included).
  const checker = responseChecker("ota");
  for (const operation of otaOperations) {
    for (const status of [200, 400, 401, 403, ...(opensBooking(operation) ? [404] : [])]) {
      try {
        checker.check(operation.operationId, { status, body: {} });
      } catch {
        // An answer without JSON content (an image, a file): nothing to compile.
      }
    }
  }
  let passwordHash: string;
  [db, redis, passwordHash] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    hashCustomerPassword(PASSWORD),
  ]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-reader",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  for (const tenant of [alpha, beta]) {
    await insertTenant(tenant);
    tenant.pk = await issueKey(tenant, "pk");
    tenant.skStorefront = await issueKey(tenant, "sk", ["storefront"]);
    tenant.skConsole = await issueKey(tenant, "sk", ["console"]);
  }
  const permissions = [
    ...new Set(otaOperations.filter(isGuardedConsole).map((operation) => String(operation.permission))),
  ];
  for (const permission of permissions) {
    permissionKeys.set(permission, {
      only: await issueKey(alpha, "sk", ["console:automation", permission]),
      missing: await issueKey(alpha, "sk", [
        "console:automation",
        ...permissions.filter((other) => other !== permission),
      ]),
    });
  }
  api = await createTestApp({ database: db, redis });
  for (const tenant of [alpha, beta]) {
    await signInCustomer(tenant, passwordHash);
    await signInStaff(tenant);
  }
  const betaOwner = memberships.get("beta");
  if (betaOwner === undefined) {
    throw new Error("beta has no owner");
  }
  betaPortalToken = await portalToken(beta, betaOwner.accountId, betaOwner.staffId);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

/** Beta's own sessions after the matrix, which presented them at alpha again and again. */
let betaAfter: { readonly staffMe: Response; readonly customerSession: Response } | undefined;

// The matrix itself, then beta's sessions through beta's own credentials.
beforeAll(async () => {
  for (const operation of otaOperations) {
    for (const column of columnsOf(operation)) {
      cells.push({ operation, column, res: await send(operation, column) });
    }
  }
  betaAfter = {
    staffMe: await request(api.server).get("/v1/console/auth/me").set(serviceHeaders(beta.staffAccess)),
    customerSession: await request(api.server)
      .get("/v1/auth/session")
      .set(edgeHeaders(beta, false, beta.customerAccess)),
  };
}, MATRIX_TIMEOUT_MS);

/** The cells whose answer is not the expected one, each as a readable line. */
function mismatches(selected: readonly Cell[]): string[] {
  const lines: string[] = [];
  for (const { operation, column, res } of selected) {
    const expected = expectedAnswer(operation, column);
    const actual = answerOf(res);
    const details = (res.body as { error?: { details?: JsonObject } } | undefined)?.error?.details;
    const detailsMatch =
      expected.details === undefined ||
      Object.entries(expected.details).every(([key, value]) => details?.[key] === value);
    if (actual[0] !== expected.answer[0] || actual[1] !== expected.answer[1] || !detailsMatch) {
      lines.push(
        `${operation.operationId} [${column}]: ${actual[0]} ${String(actual[1])} ${JSON.stringify(details ?? null)}` +
          ` — expected ${expected.answer[0]} ${String(expected.answer[1])} ${JSON.stringify(expected.details ?? null)}` +
          ` (${expected.rule})`,
      );
    }
  }
  return lines;
}

/**
 * The cells whose error code the operation's `x-error-codes` does not list, each as `<operationId> [<column>]: <code>`.
 * Every answer with an error body counts, the guards' generic refusals included, but a pending operation's `501
 * NOT_IMPLEMENTED`: that one is the route-parity answer of `x-milestone`, not a response of the operation (FIX-W45-OTA).
 */
function unlistedCodes(selected: readonly Cell[]): string[] {
  return selected.flatMap(({ operation, column, res }) => {
    const code = answerOf(res)[1];
    if (code === undefined || isPendingAnswer(operation, res) || errorCodesOf(operation).includes(code)) {
      return [];
    }
    return [`${operation.operationId} [${column}]: ${code}`];
  });
}

describe("the coverage of the matrix", () => {
  it("[OBE-084 AC1] calls every operation of the operations index with every credential of the matrix", () => {
    expect(otaOperations.length).toBeGreaterThan(0);
    const called = new Set(cells.map((cell) => cell.operation.operationId));
    expect([...called].sort()).toEqual(otaOperations.map((operation) => operation.operationId).sort());
    for (const operation of otaOperations) {
      const columns = cells.filter((cell) => cell.operation === operation).map((cell) => cell.column);
      expect([operation.operationId, columns]).toEqual([operation.operationId, columnsOf(operation)]);
      // Every operation has a scope the table knows, and every cell an expectation.
      expect([
        operation.operationId,
        ["customer", "both", "console", "internal"].includes(String(operation.scope)),
      ]).toEqual([operation.operationId, true]);
    }
    // Every console operation with a permission was called with both permission keys.
    const guarded = otaOperations.filter((operation) => isGuardedConsole(operation) && !isPending(operation));
    expect(guarded.length).toBeGreaterThan(40);
    expect(cells.filter((cell) => cell.column === "permOnly")).toHaveLength(guarded.length);
  });
});

describe("the authentication matrix", () => {
  it.each(COLUMNS.map((column) => [column] as const))(
    "[OBE-084 AC1] answers every operation called with the %s credential as its x-scope, x-edge-only, x-permission and security say",
    (column) => {
      const selected = cells.filter((cell) => cell.column === column);
      expect(selected.length).toBeGreaterThan(0);
      expect(mismatches(selected)).toEqual([]);
      // Every answer but a pending operation's 501 is a documented response of the operation, with the documented
      // body (the error envelope): its status is listed and its body validates (OBE-095).
      for (const { operation, res } of selected) {
        if (!isPendingAnswer(operation, res)) {
          expectResponseToMatch(operation.operationId, res);
        }
      }
      // Every error code it answered is one of the operation's x-error-codes (FIX-W45-OTA).
      expect(unlistedCodes(selected)).toEqual([]);
    },
  );

  it("[OBE-095 AC1] matches every answer but a pending operation's 501 to the OTA document: a documented status and body", () => {
    const checker = responseChecker("ota");
    const label = ({ operation, column }: Cell): string => `${operation.operationId} [${column}]`;
    const checked = cells.filter(({ operation, res }) => !isPendingAnswer(operation, res));
    const problems = checked.flatMap((cell) =>
      checker
        .check(cell.operation.operationId, cell.res)
        .map(
          (problem) => `${label(cell)} ${cell.res.status}: ${problem.path || "(body)"} ${problem.message}`,
        ),
    );
    expect(problems).toEqual([]);
    // Left out: exactly the cells the table expects a pending operation's 501 for, and nothing else.
    const leftOut = cells.filter(({ operation, res }) => isPendingAnswer(operation, res));
    expect(leftOut.length).toBeGreaterThan(0);
    expect(leftOut.map(label)).toEqual(
      cells
        .filter(
          ({ operation, column }) =>
            isPending(operation) && expectedAnswer(operation, column).answer === NOT_IMPLEMENTED,
        )
        .map(label),
    );
    expect(checked.length + leftOut.length).toBe(cells.length);
    // The answers OTA-SR-05 found undocumented are among them: the edge header beside an API key (400) and the
    // service key through Caddy (401) on every operation, the pending ones included, and every credential's refusal
    // on the Stripe receivers (`x-scope: internal`).
    for (const column of ["serviceViaEdge", "serviceViaApi"] as const) {
      expect(checked.filter((cell) => cell.column === column)).toHaveLength(otaOperations.length);
    }
    const receivers = otaOperations.filter((operation) => operation.path.startsWith("/webhooks/"));
    expect(receivers.map((operation) => operation.operationId).sort()).toEqual([
      "receiveStripeConnectWebhook",
      "receiveStripeConnectionWebhook",
      "receiveStripeVelexisWebhook",
    ]);
    for (const receiver of receivers) {
      expect(checked.filter((cell) => cell.operation === receiver).map((cell) => cell.column)).toEqual(
        columnsOf(receiver),
      );
    }
  });

  it("[FIX-W45-OTA AC2] finds every error code the matrix answered in that operation's x-error-codes", () => {
    // The whole matrix at once: each line names the operation, the column and the code the document does not list.
    expect(unlistedCodes(cells)).toEqual([]);
    // Every cell with an error code is checked but a pending operation's 501, and those are exactly the cells the
    // status check leaves out (the OBE-095 test above): the two checks cover the same cells.
    const withCode = cells.filter(({ res }) => answerOf(res)[1] !== undefined);
    const checked = withCode.filter(({ operation, res }) => !isPendingAnswer(operation, res));
    expect(checked.length).toBeGreaterThan(cells.length / 2);
    expect(withCode.length - checked.length).toBe(
      cells.filter(({ operation, res }) => isPendingAnswer(operation, res)).length,
    );
    // The generic refusals of the guards are among the codes checked. The caller guard's are met on every operation
    // (the edge header beside a key, the service key through Caddy, a publishable key from an origin it does not
    // list, the service key without the end user's address), the scope guard's on every operation bound to a handler
    // (all but the two health endpoints and the pending operations' 501 routes), the session guards' on operations of
    // every scope that reads a token.
    const answering = (code: string): string[] => [
      ...new Set(
        checked.filter(({ res }) => answerOf(res)[1] === code).map(({ operation }) => operation.operationId),
      ),
    ];
    const everyOperation = otaOperations.map((operation) => operation.operationId).sort();
    for (const code of ["INVALID_REQUEST", "INVALID_API_KEY", "ORIGIN_NOT_ALLOWED", "VALIDATION_FAILED"]) {
      expect([code, answering(code).sort()]).toEqual([code, everyOperation]);
    }
    expect(answering("SCOPE_NOT_ALLOWED").sort()).toEqual(
      otaOperations
        .filter((operation) => !isHealth(operation) && !isPending(operation))
        .map((operation) => operation.operationId)
        .sort(),
    );
    for (const code of ["UNAUTHENTICATED", "FORBIDDEN"]) {
      expect([code, answering(code).length > 0]).toEqual([code, true]);
    }
    // The service key without X-Velexis-End-User-IP is refused for that header, by the caller guard.
    for (const { operation, res } of cells.filter((cell) => cell.column === "serviceNoIp")) {
      const fieldErrors = (res.body as { error?: { fieldErrors?: { path?: string }[] } }).error?.fieldErrors;
      expect([operation.operationId, fieldErrors?.map((error) => error.path)]).toEqual([
        operation.operationId,
        ["/header/X-Velexis-End-User-IP"],
      ]);
    }
  });

  it("[OBE-084 AC1] leaves the other tenant's sessions as they were: its tokens presented at alpha changed nothing", () => {
    expect(answerOf(betaAfter?.staffMe as Response)).toEqual(OK);
    expect((betaAfter?.staffMe.body as { tenant?: { id?: string } }).tenant?.id).toBe(beta.id);
    expect(answerOf(betaAfter?.customerSession as Response)).toEqual(OK);
    expectResponseToMatch("consoleGetMe", betaAfter?.staffMe as Response);
    expectResponseToMatch("getSession", betaAfter?.customerSession as Response);
  });

  it("[OBE-084 AC1] refuses the service key that came through Caddy and logs it as a security event without its value", () => {
    const events = api.sink
      .records()
      .filter((line) => line["securityEvent"] === "caller.service_key_not_direct");
    // Exactly one event per serviceViaApi request, as forwarded (a loopback peer with Caddy's headers). The
    // serviceViaEdge requests log none: the edge header beside the key is refused before the key is compared, and no
    // other request of the file sends the service key through "Caddy".
    const viaApi = cells.filter((cell) => cell.column === "serviceViaApi");
    expect(viaApi).toHaveLength(otaOperations.length);
    expect(events).toHaveLength(viaApi.length);
    expect(events.every((line) => line["reason"] === "forwarded")).toBe(true);
    expect(api.sink.text()).not.toContain(testApiCredentials().serviceKey);
  });
});
