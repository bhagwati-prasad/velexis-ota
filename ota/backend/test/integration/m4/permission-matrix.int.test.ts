// The permission matrix of the console (OBE-075 step 1; ota/docs/scope.md §1.3 and OF-09 AC2, OADR-0011 points 5 and 6,
// flows/console-operations.md §6): every console operation of the OTA document, called by each of the five roles in
// both environments, is allowed or refused `403 FORBIDDEN` exactly as scope §1.3 says, and a viewer never reaches the
// live environment. The roles' permissions are written out below from scope §1.3 itself, not taken from the code's
// role matrix (common/auth/roles.ts), and each operation's permission is its `x-permission` in the document.
//
// The file clones the @velexis/testing template (tenant_alpha provisioned) and writes alpha's platform rows as the
// platform does: a live OTA (so live is open to every role but the viewer), an account and a membership of each role,
// portal tokens as the platform's createConsoleToken stores them. Each role signs in through the OTA admin's service key
// in the test environment and, but the viewer, in the live one, each session with an end-user IP address of its own.
//
// The requests of the matrix reach no use case: the permission guard runs before request validation (app.module.ts),
// so a refused role is answered before anything looks at the request, and an allowed one goes on to the validation,
// which refuses the matrix's placeholder path value (`~`, which no path parameter's schema takes) and body (`[]`, which no
// request body's schema takes); the reads without a path parameter or a required query parameter answer `200`. So an
// allowed call answers the same whatever the role, and a refused one is told apart by its code. Each call's
// `staff_actions` rows are read by its request id: a refusal writes one `denied` row, a validation refusal one `failed`
// row, a successful list none (OADR-0011 point 8 as decided on 2026-10-21).
//
// The staff-session operations (`x-permission: none`) are open to every role; the deferred operations answer
// `501 NOT_IMPLEMENTED` to every role from the route-parity allow-list; `allowUnpaid` issuance stays owner and admin only
// (the use case's refusal, before the booking is read). All requests run in `beforeAll` hooks with budgets of their own;
// the tests read what they answered. Tokens and names are made up per run.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { otaOperations, type ApiOperation, type OtaOperationId } from "@velexis/api-types/operations";
import { sha256Hex } from "@velexis/crypto";
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
import { loadOpenApiDocument } from "../../../src/common/http/openapi-validation.interceptor";
import { PENDING_OPERATIONS } from "../../../src/common/http/pending-operations";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Role = "owner" | "admin" | "agent" | "finance" | "viewer";
type Environment = "test" | "live";
type JsonObject = Record<string, unknown>;

const ROLES: readonly Role[] = ["owner", "admin", "agent", "finance", "viewer"];
const ENVIRONMENTS: readonly Environment[] = ["test", "live"];
const EVERY_ROLE: readonly Role[] = ROLES;

/**
 * Scope §1.3, row by row: the roles that hold each permission. `amadeus:write` is the permission of the deferred raw
 * writes. Written out here so that the test proves the code's matrix rather than reading it back.
 */
const SCOPE_MATRIX: Readonly<Record<string, readonly Role[]>> = {
  "bookings:read": EVERY_ROLE,
  "customers:read": EVERY_ROLE,
  "bookings:write": ["owner", "admin", "agent"],
  "bookings:issue": ["owner", "admin", "agent"],
  "bookings:cancel": ["owner", "admin", "agent"],
  "queues:read": ["owner", "admin", "agent"],
  "amadeus:read": ["owner", "admin", "agent"],
  "supplier_requests:read": ["owner", "admin", "agent", "finance"],
  "amadeus:write": ["owner", "admin"],
  "payments:read": EVERY_ROLE,
  "settings:read": EVERY_ROLE,
  "payments:capture": ["owner", "admin", "agent", "finance"],
  "payments:refund": ["owner", "admin", "finance"],
  "settings:write": ["owner", "admin"],
};
/** Scope §1.3's last row: the roles that may use the live environment in the OTA admin (the viewer: test only). */
const LIVE_ROLES: readonly Role[] = ["owner", "admin", "agent", "finance"];

/** `allowUnpaid` issuance (scope §1.3, after the table): owner and admin only. */
const ALLOW_UNPAID_ROLES: readonly Role[] = ["owner", "admin"];

/** The permissions scope §1.3 gives `role`. */
const permissionsOf = (role: Role): string[] =>
  Object.entries(SCOPE_MATRIX)
    .filter(([, roles]) => roles.includes(role))
    .map(([permission]) => permission);

/** The placeholder of every path parameter: a value no path parameter's schema takes. */
const PLACEHOLDER = "~";

/** Every console operation of the document (`x-scope: console`). */
const CONSOLE: readonly ApiOperation<OtaOperationId>[] = otaOperations.filter(
  (operation) => operation.scope === "console",
);
const isPending = (operation: ApiOperation<OtaOperationId>): boolean =>
  Object.hasOwn(PENDING_OPERATIONS, operation.operationId);
/** The deferred console operations: their routes answer 501 from the route-parity allow-list. */
const DEFERRED = CONSOLE.filter(isPending);
/** The staff-session operations (`x-permission: none`): console.auth.signIn, refresh, signOut and me. */
const SESSION = CONSOLE.filter((operation) => !isPending(operation) && operation.permission === "none");
/** The console operations whose permission the permission guard checks: the rows of the matrix. */
const GUARDED = CONSOLE.filter((operation) => !isPending(operation) && operation.permission !== "none");

const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/**
 * The matrix: about six hundred requests, each answered by a guard or the request validation, a few seconds locally; the
 * bound allows for a busy 4-CPU runner and only stops a run that hangs.
 */
const MATRIX_TIMEOUT_MS = 120_000;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;

// ---- Platform rows -------------------------------------------------------------------------------------------------

interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly email: string;
  readonly role: Role;
}

async function insertMember(role: Role): Promise<Member> {
  const email = `staff.${randomBytes(4).toString("hex")}@example.com`;
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email,
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
    .values({ id: staffId, tenant_id: alphaId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, email, role };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stores a portal token for `member` as the platform's API does (PADR-0007 item 1); the live tenant needs MFA. */
async function portalTokenFor(member: Member): Promise<string> {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: alphaId,
    membershipId: member.staffId,
    role: member.role,
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 60, "NX")).toBe(
    "OK",
  );
  return token;
}

// ---- The OTA admin -------------------------------------------------------------------------------------------------

let ipCounter = 0;

/** The OTA admin's server for one staff member in one environment: the service key, its IP and user agent. */
class AdminSession {
  readonly ip: string;
  readonly userAgent = `Mozilla/5.0 (OTA admin matrix ${randomBytes(3).toString("hex")})`;
  accessToken = "";
  refreshToken = "";
  /** The answer of the sign-in. */
  signIn: Response | undefined;

  constructor(
    readonly member: Member,
    readonly environment: Environment,
  ) {
    ipCounter += 1;
    this.ip = `198.51.100.${ipCounter}`;
  }

  /** The OTA admin's headers in `environment` (the session's own by default), with the staff token once signed in. */
  headers(environment: Environment = this.environment): Record<string, string> {
    return {
      "X-Api-Key": testApiCredentials().serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": this.userAgent,
      "X-Velexis-Environment": environment,
      ...(this.accessToken === "" ? {} : { Authorization: `Bearer ${this.accessToken}` }),
    };
  }

  /** console.auth.signIn with a new portal token; keeps the tokens of a 200. */
  async open(): Promise<Response> {
    const res = await request(api.server)
      .post("/v1/console/auth/sign-in")
      .set({ ...this.headers(), "Idempotency-Key": randomUUID() })
      .send({ grantType: "portal_token", portalToken: await portalTokenFor(this.member) });
    this.signIn = res;
    if (res.status === 200) {
      const session = res.body.session as { accessToken: string; refreshToken: string };
      this.accessToken = session.accessToken;
      this.refreshToken = session.refreshToken;
    }
    return res;
  }
}

/** The request of `operation` the matrix sends (see the file header), in `environment`. */
function matrixRequest(
  session: AdminSession,
  operation: ApiOperation<OtaOperationId>,
  environment: Environment,
): Promise<Response> {
  const path = operation.path.replace(/\{[^}]+\}/g, PLACEHOLDER);
  const headers = { ...session.headers(environment), "Idempotency-Key": randomUUID(), "If-Match": '"1"' };
  const agent = request(api.server);
  switch (operation.method) {
    case "get":
      return agent.get(path).set(session.headers(environment)).then();
    case "post":
      // The asset upload takes multipart/form-data only (the body parsers refuse anything else before the guards).
      return operation.operationId === "consoleUploadStorefrontAsset"
        ? agent.post(path).set(headers).field("kind", PLACEHOLDER).then()
        : agent.post(path).set(headers).send([]).then();
    case "put":
      return agent.put(path).set(headers).send([]).then();
    case "patch":
      return agent.patch(path).set(headers).send([]).then();
    case "delete":
      return agent.delete(path).set(headers).then();
    case "head":
    case "options":
    case "trace":
      throw new Error(`no request of the matrix for ${operation.method}`);
  }
}

/** `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];
const requestIdOf = (res: Response): string => String(res.headers["x-request-id"]);

/** The required query parameters of an operation in the document (its path item's included). */
function requiredQueryParameters(operation: ApiOperation<OtaOperationId>): string[] {
  const document = loadOpenApiDocument().document as JsonObject;
  const paths = document["paths"] as Record<string, JsonObject>;
  const item = paths[operation.path] ?? {};
  const spec = (item[operation.method] ?? {}) as JsonObject;
  const parameters = [
    ...((item["parameters"] as JsonObject[] | undefined) ?? []),
    ...((spec["parameters"] as JsonObject[] | undefined) ?? []),
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

/**
 * What an allowed role's matrix call answers: `200` for a read without a path parameter or a required query parameter,
 * else the request validation's refusal of the placeholder or the body.
 */
function allowedAnswer(operation: ApiOperation<OtaOperationId>): [number, unknown] {
  return operation.method === "get" &&
    !operation.path.includes("{") &&
    requiredQueryParameters(operation).length === 0
    ? [200, undefined]
    : [400, "VALIDATION_FAILED"];
}

// ---- What the matrix answered --------------------------------------------------------------------------------------

/** One cell of the matrix: an operation, a role and an environment, and the answer. */
interface Cell {
  readonly operation: ApiOperation<OtaOperationId>;
  readonly role: Role;
  readonly environment: Environment;
  readonly session: AdminSession;
  readonly res: Response;
  /**
   * The booking id the call's path names when it is one of the right shape (the allowUnpaid rows), else `null`: the
   * matrix's own calls send the placeholder or no path parameter at all.
   */
  readonly bookingId: string | null;
}

/** The sessions of the matrix: every role in test, every live role in live. */
const sessions: AdminSession[] = [];
/** The viewer's sign-in in the live environment (refused). */
let viewerLiveSignIn: Response;
const cells: Cell[] = [];
const allowUnpaidCells: Cell[] = [];
const deferredCells: Cell[] = [];
/** The staff-session operations after the matrix: me, refresh and sign-out of every session, me again. */
const sessionCalls: Array<{
  readonly session: AdminSession;
  readonly me: Response;
  readonly viewerLiveMe: Response | undefined;
  readonly refresh: Response;
  readonly refreshedMe: Response;
  readonly signOut: Response;
  readonly afterSignOut: Response;
}> = [];
/** The tenant's `staff_actions` rows after every call, by request id. */
const rowsByRequest = new Map<string, Array<Record<string, unknown>>>();

const sessionOf = (role: Role, environment: Environment): AdminSession => {
  const found = sessions.find(
    (session) => session.member.role === role && session.environment === environment,
  );
  if (found === undefined) {
    throw new Error(`no ${environment} session of the ${role}`);
  }
  return found;
};

const rowsOf = (res: Response): Array<Record<string, unknown>> => rowsByRequest.get(requestIdOf(res)) ?? [];

// Cloning the template, building the API's graph and compiling the response validators of the console operations:
// several seconds alone, longer on a busy runner. The budget only stops a start-up that hangs.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const operation of [...GUARDED, ...SESSION]) {
    for (const status of [200, 204, 400, 401, 403, 404]) {
      checker.check(operation.operationId, { status, body: {} });
    }
  }
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
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
  alphaId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: alphaId,
      key: "alpha",
      name: "Alpha Travel",
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/Madrid",
      storefront_environment: "live",
      live_enabled_at: new Date(),
    })
    .execute();
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" }),
  );
  api = await createTestApp({ database: db, redis });
  for (const role of ROLES) {
    const member = await insertMember(role);
    for (const environment of ENVIRONMENTS) {
      const session = new AdminSession(member, environment);
      const res = await session.open();
      if (environment === "live" && !LIVE_ROLES.includes(role)) {
        viewerLiveSignIn = res;
      } else {
        expect([role, environment, ...answer(res)]).toEqual([role, environment, 200, undefined]);
        sessions.push(session);
      }
    }
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

// The matrix itself, the allowUnpaid and deferred rows, then the session operations, and the rows they wrote.
beforeAll(async () => {
  for (const operation of GUARDED) {
    for (const session of sessions) {
      cells.push({
        operation,
        role: session.member.role,
        environment: session.environment,
        session,
        res: await matrixRequest(session, operation, session.environment),
        bookingId: null,
      });
    }
    // The viewer's test session asking for live data (the OTA admin's switch, which the viewer's admin never shows).
    const viewer = sessionOf("viewer", "test");
    cells.push({
      operation,
      role: "viewer",
      environment: "live",
      session: viewer,
      res: await matrixRequest(viewer, operation, "live"),
      bookingId: null,
    });
  }
  const issue = otaOperations.find((operation) => operation.operationId === "consoleIssueBooking");
  if (issue === undefined) {
    throw new Error("the document has no consoleIssueBooking");
  }
  for (const role of ROLES) {
    const session = sessionOf(role, "test");
    // A booking id of the right shape that no booking has: the allowUnpaid refusal comes before the booking is read.
    const bookingId = newId("bkg");
    const res = await request(api.server)
      .post(`/v1/console/bookings/${bookingId}/issuance`)
      .set({ ...session.headers(), "Idempotency-Key": randomUUID(), "If-Match": '"1"' })
      .send({ allowUnpaid: true, reason: "Corporate account settles monthly" });
    allowUnpaidCells.push({ operation: issue, role, environment: "test", session, res, bookingId });
  }
  for (const operation of DEFERRED) {
    for (const role of ROLES) {
      const session = sessionOf(role, "test");
      deferredCells.push({
        operation,
        role,
        environment: "test",
        session,
        res: await matrixRequest(session, operation, "test"),
        bookingId: null,
      });
    }
  }
  for (const session of sessions) {
    const me = await request(api.server).get("/v1/console/auth/me").set(session.headers());
    const viewerLiveMe =
      session.member.role === "viewer"
        ? await request(api.server).get("/v1/console/auth/me").set(session.headers("live"))
        : undefined;
    const refresh = await request(api.server)
      .post("/v1/console/auth/refresh")
      .set({ ...session.headers(), "Idempotency-Key": randomUUID() })
      .send({ refreshToken: session.refreshToken });
    const rotated = refresh.body.session as { accessToken: string; refreshToken: string } | undefined;
    session.accessToken = rotated?.accessToken ?? session.accessToken;
    const refreshedMe = await request(api.server).get("/v1/console/auth/me").set(session.headers());
    const signOut = await request(api.server)
      .post("/v1/console/auth/sign-out")
      .set({ ...session.headers(), "Idempotency-Key": randomUUID() })
      .send({ refreshToken: rotated?.refreshToken ?? session.refreshToken });
    const afterSignOut = await request(api.server).get("/v1/console/auth/me").set(session.headers());
    sessionCalls.push({ session, me, viewerLiveMe, refresh, refreshedMe, signOut, afterSignOut });
  }
  const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx.selectFrom("staff_actions").selectAll().orderBy("created_at").orderBy("id").execute(),
  );
  for (const row of rows as Array<Record<string, unknown>>) {
    const key = String(row["request_id"]);
    rowsByRequest.set(key, [...(rowsByRequest.get(key) ?? []), row]);
  }
}, MATRIX_TIMEOUT_MS);

describe("the operations of the matrix", () => {
  it("[OBE-075 AC1] covers every console operation of the document: 52 guarded, 4 session and 6 deferred ones", () => {
    expect(CONSOLE).toHaveLength(62);
    expect(GUARDED).toHaveLength(52);
    expect(SESSION.map((operation) => operation.operationId).sort()).toEqual(
      ["consoleGetMe", "consoleRefreshSession", "consoleSignIn", "consoleSignOut"].sort(),
    );
    expect(DEFERRED.map((operation) => operation.operationId).sort()).toEqual(
      [
        "consoleAmadeusCancelFlightOrder",
        "consoleAmadeusCreateFlightOrders",
        "consoleAmadeusIssueFlightOrder",
        "consoleAmadeusPatchFlightOrder",
        "consoleCreateBooking",
        "searchFlightAvailabilities",
      ].sort(),
    );
    // The operations OBE-072 (content pages) and OAD-014's backend (storefront settings and assets) serve are rows.
    expect(GUARDED.map((operation) => operation.operationId)).toEqual(
      expect.arrayContaining([
        "consoleListStorefrontPages",
        "consoleCreateStorefrontPage",
        "consoleGetStorefrontPage",
        "consoleUpdateStorefrontPage",
        "consoleDeleteStorefrontPage",
        "consoleGetStorefrontSettings",
        "consoleUpdateStorefrontSettings",
        "consoleListStorefrontAssets",
        "consoleUploadStorefrontAsset",
        "consoleDeleteStorefrontAsset",
      ]),
    );
    // Each row's permission is a permission of scope §1.3, and scope §1.3 has exactly the document's StaffPermission.
    const document = loadOpenApiDocument().document as JsonObject;
    const staffPermission = ((document["components"] as JsonObject)["schemas"] as Record<string, JsonObject>)[
      "StaffPermission"
    ];
    expect([...(staffPermission?.["enum"] as string[])].sort()).toEqual(Object.keys(SCOPE_MATRIX).sort());
    for (const operation of [...GUARDED, ...DEFERRED]) {
      expect([operation.operationId, Object.hasOwn(SCOPE_MATRIX, String(operation.permission))]).toEqual([
        operation.operationId,
        true,
      ]);
    }
    // Every guarded operation was called by every role in both environments.
    expect(cells).toHaveLength(GUARDED.length * ROLES.length * ENVIRONMENTS.length);
  });
});

describe("the permission matrix of scope §1.3", () => {
  it("[OBE-075 AC1] [OF-09 AC2] gives each role the permissions of scope §1.3 and the live environment to every role but the viewer", () => {
    for (const session of sessions) {
      const body = session.signIn?.body as JsonObject;
      const role = session.member.role;
      expect([role, session.environment, [...(body["permissions"] as string[])].sort()]).toEqual([
        role,
        session.environment,
        permissionsOf(role).sort(),
      ]);
      expect([role, body["environments"]]).toEqual([
        role,
        LIVE_ROLES.includes(role) ? ["test", "live"] : ["test"],
      ]);
      expect(body["tenant"]).toMatchObject({ id: alphaId, environment: session.environment });
      expectResponseToMatch("consoleSignIn", session.signIn as Response);
    }
  });

  it.each(ROLES.map((role) => [role] as const))(
    "[OBE-075 AC1] [OF-09 AC2] lets the %s call exactly the operations whose x-permission scope §1.3 gives the role, in the test environment and in live",
    (role) => {
      for (const environment of LIVE_ROLES.includes(role) ? ENVIRONMENTS : (["test"] as const)) {
        for (const cell of cells.filter(
          (entry) => entry.role === role && entry.environment === environment,
        )) {
          const { operation, res } = cell;
          const permission = String(operation.permission);
          if (SCOPE_MATRIX[permission]?.includes(role)) {
            expect([operation.operationId, environment, ...answer(res)]).toEqual([
              operation.operationId,
              environment,
              ...allowedAnswer(operation),
            ]);
          } else {
            expect([operation.operationId, environment, ...answer(res), res.body.error?.details]).toEqual([
              operation.operationId,
              environment,
              403,
              "FORBIDDEN",
              { requiredPermission: permission },
            ]);
          }
          expectResponseToMatch(operation.operationId, res);
        }
      }
    },
  );

  it("[OBE-075 AC1] [OF-09 AC2] answers an allowed call the same whatever the role and the environment", () => {
    for (const operation of GUARDED) {
      const allowed = cells.filter(
        (cell) =>
          cell.operation === operation &&
          SCOPE_MATRIX[String(operation.permission)]?.includes(cell.role) &&
          (cell.environment === "test" || LIVE_ROLES.includes(cell.role)),
      );
      expect(allowed.length).toBeGreaterThan(0);
      expect(allowed.map((cell) => [operation.operationId, ...answer(cell.res)])).toEqual(
        allowed.map(() => [operation.operationId, ...allowedAnswer(operation)]),
      );
    }
  });

  it("[OBE-075 AC1] [OF-09 AC2] limits the viewer to the test environment: every console operation in live answers 403 ENVIRONMENT_NOT_ALLOWED", () => {
    expect(answer(viewerLiveSignIn)).toEqual([403, "ENVIRONMENT_NOT_ALLOWED"]);
    expect(viewerLiveSignIn.body.error.details).toEqual({ environment: "live", environments: ["test"] });
    expectResponseToMatch("consoleSignIn", viewerLiveSignIn);
    const live = cells.filter((cell) => cell.role === "viewer" && cell.environment === "live");
    expect(live).toHaveLength(GUARDED.length);
    for (const { operation, res } of live) {
      // Reads the viewer holds in test (bookings, customers, payments, settings) are refused in live all the same.
      expect([operation.operationId, ...answer(res), res.body.error?.details]).toEqual([
        operation.operationId,
        403,
        "ENVIRONMENT_NOT_ALLOWED",
        { environment: "live", environments: ["test"] },
      ]);
      expectResponseToMatch(operation.operationId, res);
    }
    const viewer = sessionCalls.find((call) => call.session.member.role === "viewer");
    expect(answer(viewer?.viewerLiveMe as Response)).toEqual([403, "ENVIRONMENT_NOT_ALLOWED"]);
    expect(answer(viewer?.me as Response)).toEqual([200, undefined]);
  });

  it("[OBE-075 AC1] [OF-09 AC2] keeps allowUnpaid issuance to owners and admins, and issuance to the roles with bookings:issue", () => {
    const byRole = new Map(allowUnpaidCells.map((cell) => [cell.role, cell.res]));
    for (const role of ALLOW_UNPAID_ROLES) {
      // Past every refusal: the booking the id names does not exist.
      expect([role, ...answer(byRole.get(role) as Response)]).toEqual([role, 404, "NOT_FOUND"]);
    }
    expect([...answer(byRole.get("agent") as Response), byRole.get("agent")?.body.error.details]).toEqual([
      403,
      "FORBIDDEN",
      { option: "allowUnpaid", allowedRoles: ["owner", "admin"], role: "agent" },
    ]);
    for (const role of ["finance", "viewer"] as const) {
      expect([role, ...answer(byRole.get(role) as Response), byRole.get(role)?.body.error.details]).toEqual([
        role,
        403,
        "FORBIDDEN",
        { requiredPermission: "bookings:issue" },
      ]);
    }
    for (const cell of allowUnpaidCells) {
      expectResponseToMatch("consoleIssueBooking", cell.res);
    }
  });

  it("[OBE-075 AC1] answers 501 NOT_IMPLEMENTED to every role on the deferred operations, whose raw writes need amadeus:write", () => {
    expect(deferredCells).toHaveLength(DEFERRED.length * ROLES.length);
    for (const { operation, role, res } of deferredCells) {
      expect([operation.operationId, role, ...answer(res), res.body.error?.details]).toEqual([
        operation.operationId,
        role,
        501,
        "NOT_IMPLEMENTED",
        { milestone: "deferred", operationId: operation.operationId },
      ]);
      // A 501 route changes nothing and writes no row.
      expect([operation.operationId, role, rowsOf(res)]).toEqual([operation.operationId, role, []]);
    }
    for (const operation of DEFERRED.filter((entry) => entry.operationId.startsWith("consoleAmadeus"))) {
      expect([operation.operationId, operation.permission]).toEqual([operation.operationId, "amadeus:write"]);
    }
  });

  it("[OBE-075 AC1] opens the staff-session operations to every role: me, refresh and sign-out", () => {
    expect(sessionCalls).toHaveLength(sessions.length);
    for (const call of sessionCalls) {
      const role = call.session.member.role;
      expect([role, call.session.environment, ...answer(call.me)]).toEqual([
        role,
        call.session.environment,
        200,
        undefined,
      ]);
      expect([...(call.me.body.permissions as string[])].sort()).toEqual(permissionsOf(role).sort());
      expect([role, ...answer(call.refresh)]).toEqual([role, 200, undefined]);
      expect([role, ...answer(call.refreshedMe)]).toEqual([role, 200, undefined]);
      expect([role, call.signOut.status]).toEqual([role, 204]);
      expect([role, ...answer(call.afterSignOut)]).toEqual([role, 401, "UNAUTHENTICATED"]);
      expectResponseToMatch("consoleGetMe", call.me);
      expectResponseToMatch("consoleRefreshSession", call.refresh);
    }
  });
});

describe("the staff_actions rows of the matrix (OADR-0011 point 8)", () => {
  it("[OBE-075 AC1] [OF-09 AC1] writes one denied row per refused call, with the staff member, the action and no target for the placeholder", () => {
    const refused = [
      ...cells.filter((cell) => [403].includes(cell.res.status)),
      ...allowUnpaidCells.filter((cell) => cell.res.status === 403),
    ];
    expect(refused.length).toBeGreaterThan(GUARDED.length);
    for (const cell of refused) {
      const { operation, role, session, res, bookingId } = cell;
      expect([operation.operationId, role, cell.environment, rowsOf(res)]).toEqual([
        operation.operationId,
        role,
        cell.environment,
        [
          expect.objectContaining({
            actor_type: "staff",
            actor_id: session.member.staffId,
            staff_id: session.member.staffId,
            account_id: session.member.accountId,
            staff_email: session.member.email,
            staff_role: role,
            // The SDK method without `console.` (consoleAction of staff-actions.writer.ts).
            action: String(operation.sdkMethod).replace(/^console\./, ""),
            outcome: "denied",
            // A refused request's path value is its target only when it passes the parameter's schema: never the
            // placeholder.
            target_type: bookingId === null ? null : "booking",
            target_id: bookingId,
            before: null,
            after: null,
            ip_address: session.ip,
            user_agent: session.userAgent,
          }),
        ],
      ]);
    }
  });

  it("[OBE-075 AC1] [OF-09 AC1] writes one failed row per call the request validation refuses, and none for a successful list", () => {
    const allowed = cells.filter((cell) => cell.res.status !== 403);
    expect(allowed.length).toBeGreaterThan(0);
    for (const { operation, role, session, res } of allowed) {
      if (res.status === 200) {
        expect([operation.operationId, role, rowsOf(res)]).toEqual([operation.operationId, role, []]);
      } else {
        expect([operation.operationId, role, res.status, rowsOf(res)]).toEqual([
          operation.operationId,
          role,
          400,
          [
            expect.objectContaining({
              staff_id: session.member.staffId,
              staff_role: role,
              action: String(operation.sdkMethod).replace(/^console\./, ""),
              outcome: "failed",
              target_type: null,
              target_id: null,
              before: null,
              after: null,
            }),
          ],
        ]);
      }
    }
    // The owner's and admin's allowUnpaid issuance of a booking that does not exist failed, its id the target.
    for (const cell of allowUnpaidCells.filter((entry) => entry.res.status === 404)) {
      expect(rowsOf(cell.res)).toEqual([
        expect.objectContaining({
          action: "bookings.issue",
          outcome: "failed",
          target_type: "booking",
          target_id: cell.bookingId,
        }),
      ]);
    }
  });

  it("[OBE-075 AC1] writes a row for each sign-in (denied for the viewer in live) and none for me, refresh or sign-out", () => {
    for (const session of sessions) {
      expect(rowsOf(session.signIn as Response)).toEqual([
        expect.objectContaining({
          action: "staff.sign_in",
          outcome: "succeeded",
          staff_id: session.member.staffId,
        }),
      ]);
    }
    expect(rowsOf(viewerLiveSignIn)).toEqual([
      expect.objectContaining({ action: "staff.sign_in", outcome: "denied", staff_role: "viewer" }),
    ]);
    for (const call of sessionCalls) {
      for (const res of [call.me, call.refresh, call.refreshedMe, call.signOut, call.afterSignOut]) {
        expect([call.session.member.role, res.status, rowsOf(res)]).toEqual([
          call.session.member.role,
          res.status,
          [],
        ]);
      }
      if (call.viewerLiveMe !== undefined) {
        expect(rowsOf(call.viewerLiveMe)).toEqual([
          expect.objectContaining({ action: "auth.me", outcome: "denied", staff_role: "viewer" }),
        ]);
      }
    }
    // No row holds a token.
    const everything = JSON.stringify([...rowsByRequest.values()]);
    for (const session of sessions) {
      expect(everything).not.toContain(session.accessToken);
      expect(everything).not.toContain(session.refreshToken);
    }
    expect(everything).not.toContain(testApiCredentials().serviceKey);
  });
});
