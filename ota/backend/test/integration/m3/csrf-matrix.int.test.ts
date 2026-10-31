// The CSRF matrix of the hosted storefront (OBE-057 step 2; ota/docs/scope.md OF-03 AC2, OADR-0006 points 1 and 3,
// common/auth/csrf.guard.ts, ota/docs/flows/my-bookings-and-guest-lookup.md §4 and §7, docs/mvp/conventions.md §12):
// every state-changing customer operation, called as the storefront edge with each way a request can fail the
// double-submit and `Origin` check, answers `403 CSRF_TOKEN_INVALID`; the same calls with the matching header pass the
// check, reads need no header, and key callers (`sk_`, `pk_`) are never checked.
//
// The file clones the @velexis/testing template (tenant_alpha provisioned), writes alpha's platform rows as the
// platform does (an active OTA on a test storefront with a secret and a publishable test key, the latter for a
// third-party storefront's origin) and seeds its settings as provisioning does. Customers are inserted as sign-up leaves
// them and get access tokens signed with the API's own key (TokenService): every request carries a valid customer
// credential (the `__Host-vx_at` cookie on the edge, `Authorization: Bearer` with a key), so the customer guard, which
// runs before the CSRF guard, lets each one reach the check, also on operations that require a customer.
//
// The operations are taken from the OTA document: every `POST`, `PUT`, `PATCH` and `DELETE` of customer scope
// (`x-scope` customer or both) that is implemented (not in pending-operations.ts; a pending route answers `501` and
// changes nothing, checked below). Their path parameters are a placeholder and their bodies empty: the guards answer
// before the request is validated, so a refusal never depends on the body. The calls that pass the check (the matching
// header on the edge, every key call, every read) go on to the validation and the handlers; each of them gets a
// customer and an end-user IP address of its own, so no per-address or per-customer limit links two of them and a key
// call answers exactly what the same call without any CSRF material answers. Every refusal is also sent by a visitor
// without a session (no `__Host-vx_at`): the storefront's anonymous writes (search, prices, checkout, sign-in, sign-up,
// lookup) are checked from the first call (OADR-0006 point 3), and an operation that needs a session answers that
// visitor `401` in the customer guard, which runs first. A last table sends complete, valid bodies without the header
// from an attacker's page, to a signed-in victim and to an anonymous one (login CSRF), and checks that nothing changed.
//
// All requests run in `beforeAll` hooks with budgets of their own; the tests read what they answered. Passwords and keys
// are made up per run; no value is a secret.
import { randomBytes, randomUUID } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import { hashApiKey } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
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
import { CSRF_TOKEN_PATTERN, type CsrfRefusal } from "../../../src/common/auth/csrf.guard";
import { customerRequirements } from "../../../src/common/auth/customer.guard";
import { Clock } from "../../../src/common/clock";
import { loadOpenApiDocument } from "../../../src/common/http/openapi-validation.interceptor";
import { PENDING_OPERATIONS } from "../../../src/common/http/pending-operations";
import { newId } from "../../../src/common/ids";
import type { ApiConfig } from "../../../src/config";
import { hashCustomerPassword } from "../../../src/identity/sign-in.service";
import { TokenService } from "../../../src/identity/token.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { dateFromToday } from "../../builders/checkouts";
import { edgeHeaders, newApiKey, newCsrfToken, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/**
 * Cloning the template, hashing the test password with Argon2id (19 MiB) and starting the API's graph (it parses the
 * OTA document and compiles its validators): a few seconds alone, more on a busy 4-CPU CI runner. The bound only stops
 * a start-up that hangs.
 */
const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/**
 * The matrix: about nine hundred requests, most of them refused by a guard, the others answered by the validation or a
 * handler that writes a row: a few seconds locally; the bound allows for CI load and only stops a run that hangs.
 */
const MATRIX_TIMEOUT_MS = 120_000;

const ALPHA_HOST = "alpha.ota.example.com";
/** The storefront's own origin: what the browser sends from its pages. */
const OWN_ORIGIN = `https://${ALPHA_HOST}`;
/** The origin of a third-party storefront that uses alpha's publishable key (the key's allowed origin). */
const THIRD_PARTY_ORIGIN = "https://shop.alpha-travel.example";
const TERMS_VERSION = "2026-09-01";
const PRIVACY_VERSION = "2026-08-15";

/** The password of the customer of the valid-body table, made up for this run. */
const PASSWORD = `Fjord-${randomBytes(9).toString("base64url")}`;

const quietPoolLogger = { error: (): void => undefined };

type Method = "get" | "post" | "put" | "patch" | "delete";
const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(["post", "put", "patch", "delete"]);

/** One operation of the document: its id, method and path with a placeholder for every path parameter. */
interface Operation {
  readonly operationId: OtaOperationId;
  readonly method: Method;
  readonly path: string;
}

/** The operations a customer-scope caller may call (`x-scope` customer or both), the webhooks and probes left out. */
const customerScope = otaOperations.filter(
  (operation) => (operation.scope === "customer" || operation.scope === "both") && !operation.internal,
);
const asOperation = (operation: (typeof customerScope)[number]): Operation => ({
  operationId: operation.operationId,
  method: operation.method as Method,
  path: operation.path.replace(/\{[^}]+\}/g, "x0"),
});
const implemented = (operation: (typeof customerScope)[number]): boolean =>
  !Object.hasOwn(PENDING_OPERATIONS, operation.operationId);

/** Every implemented state-changing operation of customer scope: the rows of the matrix. */
const STATE_CHANGING: readonly Operation[] = customerScope
  .filter((operation) => STATE_CHANGING_METHODS.has(operation.method) && implemented(operation))
  .map(asOperation);
/** The state-changing operations of customer scope that are still pending (`501`, changing nothing). */
const PENDING_STATE_CHANGING: readonly Operation[] = customerScope
  .filter((operation) => STATE_CHANGING_METHODS.has(operation.method) && !implemented(operation))
  .map(asOperation);
/** Every implemented read of customer scope. */
const READS: readonly Operation[] = customerScope
  .filter((operation) => operation.method === "get" && implemented(operation))
  .map(asOperation);

/** The CSRF material of one request: the `__Host-vx_csrf` cookie it sends (`null`: none) and its headers. */
interface Material {
  readonly csrfCookie: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

/** One way an edge request can fail the check, and the `details.reason` it is refused with. */
interface Refusal {
  readonly name: string;
  readonly reason: CsrfRefusal;
  readonly material: (csrf: string) => Material;
}

/** The ways an edge write can fail the double-submit and `Origin` check (OADR-0006 point 3). */
const REFUSALS: readonly Refusal[] = [
  {
    name: "no X-CSRF-Token",
    reason: "token_missing",
    material: (csrf) => ({ csrfCookie: csrf, headers: { Origin: OWN_ORIGIN } }),
  },
  {
    name: "X-CSRF-Token without the CSRF cookie",
    reason: "token_missing",
    material: (csrf) => ({ csrfCookie: null, headers: { Origin: OWN_ORIGIN, "X-CSRF-Token": csrf } }),
  },
  {
    name: "an X-CSRF-Token different from the cookie",
    reason: "token_mismatch",
    material: (csrf) => ({
      csrfCookie: csrf,
      headers: { Origin: OWN_ORIGIN, "X-CSRF-Token": newCsrfToken() },
    }),
  },
  {
    name: "a header equal to the cookie that is no CSRF value",
    reason: "token_mismatch",
    material: () => ({ csrfCookie: "planted", headers: { Origin: OWN_ORIGIN, "X-CSRF-Token": "planted" } }),
  },
  {
    name: "a foreign Origin",
    reason: "origin_mismatch",
    material: (csrf) => ({
      csrfCookie: csrf,
      headers: { Origin: "https://attacker.example", "X-CSRF-Token": csrf },
    }),
  },
  {
    name: "another storefront's Origin",
    reason: "origin_mismatch",
    material: (csrf) => ({
      csrfCookie: csrf,
      headers: { Origin: "https://beta.ota.example.com", "X-CSRF-Token": csrf },
    }),
  },
  {
    name: "the storefront's host over http",
    reason: "origin_mismatch",
    material: (csrf) => ({
      csrfCookie: csrf,
      headers: { Origin: `http://${ALPHA_HOST}`, "X-CSRF-Token": csrf },
    }),
  },
  {
    name: "Origin: null",
    reason: "origin_mismatch",
    material: (csrf) => ({ csrfCookie: csrf, headers: { Origin: "null", "X-CSRF-Token": csrf } }),
  },
  {
    name: "no Origin and Sec-Fetch-Site: cross-site",
    reason: "origin_mismatch",
    material: (csrf) => ({
      csrfCookie: csrf,
      headers: { "X-CSRF-Token": csrf, "Sec-Fetch-Site": "cross-site" },
    }),
  },
  {
    name: "no Origin and Sec-Fetch-Site: same-site",
    reason: "origin_mismatch",
    material: (csrf) => ({
      csrfCookie: csrf,
      headers: { "X-CSRF-Token": csrf, "Sec-Fetch-Site": "same-site" },
    }),
  },
  {
    name: "no Origin and no Sec-Fetch-Site",
    reason: "origin_mismatch",
    material: (csrf) => ({ csrfCookie: csrf, headers: { "X-CSRF-Token": csrf } }),
  },
];

/** The ways an edge write passes the check. */
const PASSES: ReadonlyArray<{ readonly name: string; readonly material: (csrf: string) => Material }> = [
  {
    name: "the matching header and the storefront's Origin",
    material: (csrf) => ({ csrfCookie: csrf, headers: { Origin: OWN_ORIGIN, "X-CSRF-Token": csrf } }),
  },
  {
    name: "the matching header, no Origin and Sec-Fetch-Site: same-origin",
    material: (csrf) => ({
      csrfCookie: csrf,
      headers: { "X-CSRF-Token": csrf, "Sec-Fetch-Site": "same-origin" },
    }),
  },
];

type KeyKind = "sk" | "pk";

/**
 * The CSRF material of the matrix on a key call, the first one none at all (the baseline). A publishable key is used
 * from its allowed origin, the third-party storefront's; a foreign `Origin` is the key's own refusal
 * (`403 ORIGIN_NOT_ALLOWED`, api-key.verifier.ts), not a CSRF check, so that row is a secret key's only.
 */
const KEY_VARIATIONS: ReadonlyArray<{
  readonly name: string;
  readonly kinds: readonly KeyKind[];
  readonly material: (csrf: string) => Material;
}> = [
  {
    name: "no CSRF material at all",
    kinds: ["sk", "pk"],
    material: () => ({ csrfCookie: null, headers: {} }),
  },
  {
    name: "the CSRF cookie without X-CSRF-Token",
    kinds: ["sk", "pk"],
    material: (csrf) => ({ csrfCookie: csrf, headers: {} }),
  },
  {
    name: "an X-CSRF-Token different from the cookie",
    kinds: ["sk", "pk"],
    material: (csrf) => ({ csrfCookie: csrf, headers: { "X-CSRF-Token": newCsrfToken() } }),
  },
  {
    name: "a foreign Origin",
    kinds: ["sk"],
    material: (csrf) => ({
      csrfCookie: csrf,
      headers: { Origin: "https://attacker.example", "X-CSRF-Token": csrf },
    }),
  },
  {
    name: "no Origin and Sec-Fetch-Site: cross-site",
    kinds: ["sk", "pk"],
    material: (csrf) => ({
      csrfCookie: csrf,
      headers: { "X-CSRF-Token": csrf, "Sec-Fetch-Site": "cross-site" },
    }),
  },
];

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let tokens: TokenService;
let alphaId = "";
let alphaSk = "";
let alphaPk = "";

const alphaTx = <T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", fn);

let ipCounter = 0;
/**
 * A new documentation address (RFC 3849, IPv6) for one request, in a /64 of its own (the rate limits count an IPv6
 * address for its /64), so no per-address limit links two requests.
 */
const newIp = (): string => {
  ipCounter += 1;
  return `2001:db8:${ipCounter.toString(16)}::1`;
};

/** A customer of alpha and its access token. */
interface Customer {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

/** The customers inserted for the matrix, handed out one per request that passes the check. */
const customerPool: Customer[] = [];
/** The customer of the requests the guard refuses: they never reach anything a customer could change. */
let refusedCustomer: Customer;
/**
 * The state-changing operations the storefront edge may call only with a session (`customerCookie` in every edge
 * alternative of their `security`): read from the document in the first `beforeAll`.
 */
let sessionOnly: ReadonlySet<OtaOperationId> = new Set();

function nextCustomer(): Customer {
  const customer = customerPool.pop();
  if (customer === undefined) {
    throw new Error("the customer pool of the matrix is empty: insert more");
  }
  return customer;
}

/** Inserts `count` active, verified customers of alpha (with the test password) and signs an access token for each. */
async function insertCustomers(count: number, passwordHash: string): Promise<Customer[]> {
  const rows = Array.from({ length: count }, () => {
    const id = newId("cus");
    return { id, email: `csrf-${id.toLowerCase()}@example.com` };
  });
  await alphaTx(async (trx) => {
    await trx
      .insertInto("customers")
      .values(
        rows.map((row) => ({
          id: row.id,
          email: row.email,
          status: "active",
          first_name: "Anna",
          last_name: "Berg",
          email_verified_at: new Date(),
        })),
      )
      .execute();
    await trx
      .insertInto("customer_identities")
      .values(
        rows.map((row) => ({
          id: newId("cid"),
          customer_id: row.id,
          provider: "password",
          provider_subject: row.email,
          password_hash: passwordHash,
          email: row.email,
          email_verified_at: new Date(),
        })),
      )
      .execute();
  });
  return await Promise.all(
    rows.map(async (row) => ({
      ...row,
      token: (await tokens.signCustomerToken({ sub: row.id, tid: alphaId, sid: newId("ses") })).token,
    })),
  );
}

/**
 * The cookie header of a request: the CSRF cookie of its material, if any, and the customer's access cookie (none for
 * a visitor without a session, `customer` undefined).
 */
const cookieHeader = (material: Material, customer: Customer | undefined): string =>
  [
    ...(material.csrfCookie === null ? [] : [`__Host-vx_csrf=${material.csrfCookie}`]),
    ...(customer === undefined ? [] : [`__Host-vx_at=${customer.token}`]),
  ].join("; ");

/** Sends `operation` with `headers` and an empty JSON body (none for a read). */
async function send(operation: Operation, headers: Record<string, string>): Promise<Response> {
  const sent = request(api.server)[operation.method](operation.path).set(headers);
  return operation.method === "get" ? await sent : await sent.send({});
}

/**
 * The storefront edge's request of `operation` with `material`, for `customer` or, when it is undefined, for a visitor
 * without a session.
 */
function edgeRequest(
  operation: Operation,
  material: Material,
  customer: Customer | undefined,
): Promise<Response> {
  const cookie = cookieHeader(material, customer);
  return send(operation, {
    ...edgeHeaders(ALPHA_HOST),
    "X-Forwarded-For": newIp(),
    "User-Agent": "Mozilla/5.0 (storefront CSRF test)",
    ...(cookie === "" ? {} : { Cookie: cookie }),
    "Idempotency-Key": randomUUID(),
    "If-Match": '"1"',
    ...material.headers,
  });
}

/**
 * A key caller's request of `operation` for `customer` with `material`: a secret key's server forwards the visitor's
 * address, a browser with the publishable key sends its page's origin. The cookies are sent too: a key caller's are
 * never read (OADR-0006 point 1).
 */
function keyRequest(
  kind: KeyKind,
  operation: Operation,
  material: Material,
  customer: Customer,
): Promise<Response> {
  const caller =
    kind === "sk"
      ? { "X-Api-Key": alphaSk, "X-Velexis-End-User-IP": newIp() }
      : { "X-Api-Key": alphaPk, "X-Forwarded-For": newIp(), Origin: THIRD_PARTY_ORIGIN };
  const headers: Record<string, string> = {
    ...caller,
    Authorization: `Bearer ${customer.token}`,
    Cookie: cookieHeader(material, customer),
    "Idempotency-Key": randomUUID(),
    "If-Match": '"1"',
    ...material.headers,
  };
  // The cross-site row of a browser has no `Origin` at all.
  if (material.headers["Sec-Fetch-Site"] === "cross-site" && material.headers["Origin"] === undefined) {
    delete headers["Origin"];
  }
  return send(operation, headers);
}

/** `[status, error code]` of an answer (`undefined` code for a success). */
const outcome = (res: Response): [number, unknown] => [
  res.status,
  (res.body as { error?: { code?: unknown } } | undefined)?.error?.code,
];

/** What one table cell answered. */
interface Cell {
  readonly variation: string;
  readonly operation: Operation;
  readonly res: Response;
}

const refused: Cell[] = [];
/** The refusals of the matrix sent by a visitor without a session. */
const anonymous: Cell[] = [];
const passed: Cell[] = [];
const keyCells: Array<Cell & { readonly kind: KeyKind }> = [];
const reads: Cell[] = [];
const pending: Cell[] = [];

beforeAll(async () => {
  preloadOpenApiDocument();
  const requirements = customerRequirements(loadOpenApiDocument().document);
  sessionOnly = new Set(
    STATE_CHANGING.map((operation) => operation.operationId).filter(
      (operationId) => requirements.get(operationId)?.edge === "required",
    ),
  );
  // The response validators of every operation compile on their first check: here, for the statuses checked below.
  // The file and image downloads answer 200 with no JSON (a PDF, an image: OBE-054, OBE-071), which no check judges.
  const checker = responseChecker("ota");
  const withoutJsonOk: ReadonlySet<string> = new Set(["downloadFile", "getPublicAsset"]);
  for (const operation of [...STATE_CHANGING, ...READS]) {
    for (const status of [200, 201, 202, 204, 400, 401, 403, 404, 409, 422]) {
      if (!withoutJsonOk.has(operation.operationId) || status !== 200) {
        checker.check(operation.operationId, { status, body: {} });
      }
    }
  }
  const passwordHash = await hashCustomerPassword(PASSWORD);
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alphaId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id: alphaId, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  for (const kind of ["sk", "pk"] as const) {
    const key = newApiKey(kind);
    await migrator
      .insertInto("platform.api_keys")
      .values({
        id: newId("key"),
        tenant_id: alphaId,
        name: kind === "pk" ? "Third-party storefront (test)" : "Server (test)",
        kind: kind === "pk" ? "publishable" : "secret",
        environment: "test",
        prefix: key.slice(0, 14),
        key_hash: hashApiKey(key, testApiCredentials().pepper),
        last4: key.slice(-4),
        ...(kind === "pk" ? { allowed_origins: [THIRD_PARTY_ORIGIN] } : {}),
      })
      .execute();
    if (kind === "sk") {
      alphaSk = key;
    } else {
      alphaPk = key;
    }
  }
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await trx
      .updateTable("storefront_settings")
      .set({ terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION })
      .execute();
  });
  tokens = new TokenService(
    { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>,
    new Clock(),
  );
  // One customer per request that passes the check, one for all the refused ones and the victim of the forged ones.
  const needed =
    STATE_CHANGING.length * (PASSES.length + KEY_VARIATIONS.reduce((sum, row) => sum + row.kinds.length, 0)) +
    READS.length +
    2;
  customerPool.push(...(await insertCustomers(needed, passwordHash)));
  refusedCustomer = nextCustomer();
  api = await createTestApp({ database: db, redis });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

// The matrix: every refusal (for a customer and for a visitor without a session), every pass and every key variation
// on every state-changing operation, every read, and the pending routes.
beforeAll(async () => {
  for (const operation of STATE_CHANGING) {
    for (const refusal of REFUSALS) {
      const res = await edgeRequest(operation, refusal.material(newCsrfToken()), refusedCustomer);
      refused.push({ variation: refusal.name, operation, res });
      const withoutSession = await edgeRequest(operation, refusal.material(newCsrfToken()), undefined);
      anonymous.push({ variation: refusal.name, operation, res: withoutSession });
    }
    for (const pass of PASSES) {
      const res = await edgeRequest(operation, pass.material(newCsrfToken()), nextCustomer());
      passed.push({ variation: pass.name, operation, res });
    }
    for (const variation of KEY_VARIATIONS) {
      for (const kind of variation.kinds) {
        const res = await keyRequest(kind, operation, variation.material(newCsrfToken()), nextCustomer());
        keyCells.push({ variation: variation.name, kind, operation, res });
      }
    }
  }
  // Reads from the worst place a write can come from: no CSRF cookie or header, a foreign page, cross-site.
  for (const operation of READS) {
    const material = {
      csrfCookie: null,
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    };
    reads.push({
      variation: "a cross-site read",
      operation,
      res: await edgeRequest(operation, material, nextCustomer()),
    });
  }
  for (const operation of PENDING_STATE_CHANGING) {
    for (const material of [REFUSALS[0], PASSES[0]].map((row) => row?.material(newCsrfToken()))) {
      if (material !== undefined) {
        pending.push({
          variation: "pending",
          operation,
          res: await edgeRequest(operation, material, refusedCustomer),
        });
      }
    }
  }
}, MATRIX_TIMEOUT_MS);

describe("the CSRF matrix", () => {
  it("[OBE-057 AC2] covers every implemented state-changing operation of customer scope", () => {
    const ids = STATE_CHANGING.map((operation) => operation.operationId);
    // The 26 of M2 and M3: searches and prices, the auth and account operations, the checkout and its payment, both
    // completions, and the booking's change, lookup and cancellation.
    expect(ids).toHaveLength(26);
    expect(ids).toEqual(
      expect.arrayContaining([
        "createFlightSearch",
        "signUp",
        "signIn",
        "refreshSession",
        "signOut",
        "deleteAccount",
        "createCheckout",
        "createCheckoutPayment",
        "updatePayment",
        "completeCheckout",
        "completeCheckoutWithAirlineCard",
        "updateBooking",
        "lookupBooking",
        "cancelBooking",
      ]),
    );
    expect(refused).toHaveLength(STATE_CHANGING.length * REFUSALS.length);
  });

  it.each(REFUSALS.map((refusal) => [refusal.name, refusal] as const))(
    "[OBE-057 AC2] answers 403 CSRF_TOKEN_INVALID to every state-changing edge call with %s [OF-03 AC2]",
    (name, refusal) => {
      const cells = refused.filter((cell) => cell.variation === name);
      expect(cells).toHaveLength(STATE_CHANGING.length);
      for (const { operation, res } of cells) {
        expect([operation.operationId, ...outcome(res), res.body.error?.details]).toEqual([
          operation.operationId,
          403,
          "CSRF_TOKEN_INVALID",
          { reason: refusal.reason },
        ]);
        expectResponseToMatch(operation.operationId, res);
        // A refusal sets no cookie and stores nothing to replay.
        expect(res.headers["set-cookie"]).toBeUndefined();
        expect(res.headers["cache-control"]).toBe("no-store");
      }
    },
  );

  it.each(REFUSALS.map((refusal) => [refusal.name, refusal] as const))(
    "[OBE-057 AC2] answers 403 CSRF_TOKEN_INVALID to every state-changing edge call of a visitor without a session with %s, and 401 where the operation needs one [OF-03 AC2]",
    (name, refusal) => {
      const cells = anonymous.filter((cell) => cell.variation === name);
      expect(cells).toHaveLength(STATE_CHANGING.length);
      for (const { operation, res } of cells) {
        // The customer guard runs before the CSRF guard (architecture §3, steps 8 and 9): an operation that needs a
        // session refuses the visitor before the check; every other one is checked from the first call.
        const expected = sessionOnly.has(operation.operationId)
          ? [operation.operationId, 401, "UNAUTHENTICATED", undefined]
          : [operation.operationId, 403, "CSRF_TOKEN_INVALID", { reason: refusal.reason }];
        expect([operation.operationId, ...outcome(res), res.body.error?.details]).toEqual(expected);
        expectResponseToMatch(operation.operationId, res);
        expect(res.headers["set-cookie"]).toBeUndefined();
        expect(res.headers["cache-control"]).toBe("no-store");
      }
    },
  );

  it("[OBE-057 AC2] checks the storefront's anonymous writes: search, prices, checkout, payment, completion, sign-up, sign-in and lookup need no session", () => {
    expect([...sessionOnly].sort()).toEqual(["changePassword", "deleteAccount", "updateAccount"]);
    const checkedAnonymously = new Set(
      anonymous
        .filter((cell) => cell.res.body?.error?.code === "CSRF_TOKEN_INVALID")
        .map((cell) => cell.operation.operationId),
    );
    expect(checkedAnonymously.size).toBe(STATE_CHANGING.length - sessionOnly.size);
    expect([...checkedAnonymously]).toEqual(
      expect.arrayContaining([
        "createFlightSearch",
        "priceFlightOffers",
        "createCheckout",
        "createCheckoutPayment",
        "completeCheckout",
        "completeCheckoutWithAirlineCard",
        "signUp",
        "signIn",
        "requestPasswordReset",
        "lookupBooking",
      ]),
    );
  });

  it("lets the same calls through with the matching header and the storefront's Origin, or Sec-Fetch-Site: same-origin without Origin", () => {
    expect(passed).toHaveLength(STATE_CHANGING.length * PASSES.length);
    for (const operation of STATE_CHANGING) {
      const cells = passed.filter((cell) => cell.operation === operation);
      for (const { res } of cells) {
        expect([operation.operationId, res.body?.error?.code]).not.toEqual([
          operation.operationId,
          "CSRF_TOKEN_INVALID",
        ]);
        expectResponseToMatch(operation.operationId, res);
      }
      // Both ways of passing reach the same validation or handler, and answer alike.
      expect(cells.map((cell) => [operation.operationId, ...outcome(cell.res)])).toEqual(
        cells.map(() => [operation.operationId, ...outcome(cells[0]?.res as Response)]),
      );
    }
  });

  it.each(KEY_VARIATIONS.slice(1).map((variation) => [variation.name] as const))(
    "[OBE-057 AC2] leaves key callers unaffected: a secret or publishable key with %s answers what it answers without any CSRF material",
    (name) => {
      for (const operation of STATE_CHANGING) {
        for (const kind of ["sk", "pk"] as const) {
          const cell = keyCells.find(
            (entry) => entry.operation === operation && entry.kind === kind && entry.variation === name,
          );
          if (cell === undefined) {
            continue;
          }
          const baseline = keyCells.find(
            (entry) =>
              entry.operation === operation &&
              entry.kind === kind &&
              entry.variation === "no CSRF material at all",
          );
          expect([kind, operation.operationId, ...outcome(cell.res)]).toEqual([
            kind,
            operation.operationId,
            ...outcome(baseline?.res as Response),
          ]);
          expect(cell.res.body?.error?.code).not.toBe("CSRF_TOKEN_INVALID");
          expect(cell.res.headers["set-cookie"]).toBeUndefined();
          expectResponseToMatch(operation.operationId, cell.res);
        }
      }
    },
  );

  it("[OBE-057 AC2] never refuses a key call for CSRF, and the key calls reached validation or their handlers", () => {
    expect(keyCells.filter((cell) => cell.res.body?.error?.code === "CSRF_TOKEN_INVALID")).toEqual([]);
    // Past the guards: a validation error, a handler's answer, or the edge-only operation's scope refusal.
    const reachedGuardsOnly = keyCells.filter(
      (cell) =>
        cell.operation.operationId !== "completeCheckoutWithAirlineCard" &&
        [401, 403].includes(cell.res.status),
    );
    expect(
      reachedGuardsOnly.map((cell) => [cell.kind, cell.operation.operationId, ...outcome(cell.res)]),
    ).toEqual([]);
    for (const cell of keyCells.filter(
      (entry) => entry.operation.operationId === "completeCheckoutWithAirlineCard",
    )) {
      expect(outcome(cell.res)).toEqual([403, "SCOPE_NOT_ALLOWED"]);
    }
  });

  it("needs no CSRF header on reads: no implemented GET of customer scope is ever refused for CSRF", () => {
    expect(reads.length).toBeGreaterThanOrEqual(26);
    expect(
      reads
        .filter((cell) => cell.res.body?.error?.code === "CSRF_TOKEN_INVALID")
        .map((cell) => cell.operation.operationId),
    ).toEqual([]);
  });

  it("answers 501 on the pending state-changing routes, with or without the header: they change nothing", () => {
    expect(PENDING_STATE_CHANGING.length).toBeGreaterThan(0);
    for (const { operation, res } of pending) {
      expect([operation.operationId, ...outcome(res)]).toEqual([
        operation.operationId,
        501,
        "NOT_IMPLEMENTED",
      ]);
    }
  });
});

describe("a forged request from another site with complete, valid bodies", () => {
  /** What the attacker's page sends: the victim's cookies (the browser adds them), no header, its own origin. */
  const forged: Material = { csrfCookie: newCsrfToken(), headers: { Origin: "https://attacker.example" } };
  let victim: Customer;
  const newEmail = `csrf-forged-${randomBytes(4).toString("hex")}@example.com`;
  const keys: string[] = [];
  /** The forged requests to the signed-in victim's browser. */
  const answers: Array<readonly [OtaOperationId, Response]> = [];
  /** The same requests to a browser without a session, where the operation allows one (login CSRF and the like). */
  const anonymousAnswers: Array<readonly [OtaOperationId, Response]> = [];
  let before: unknown;
  let after: unknown;

  /** What the victim's account and the tenant hold that a forged call would change. */
  async function state(): Promise<unknown> {
    return await alphaTx(async (trx) => {
      const customer = await trx
        .selectFrom("customers")
        .select(["status", "first_name", "version", "deleted_at"])
        .where("id", "=", victim.id)
        .executeTakeFirstOrThrow();
      const identity = await trx
        .selectFrom("customer_identities")
        .select(["password_hash as passwordHash"])
        .where("customer_id", "=", victim.id)
        .executeTakeFirstOrThrow();
      const count = async (
        table: "customer_sessions" | "customer_password_resets" | "notifications" | "flight_searches",
      ) =>
        Number(
          (
            await trx
              .selectFrom(table)
              .select(sql<string>`count(*)`.as("n"))
              .executeTakeFirstOrThrow()
          ).n,
        );
      return {
        customer,
        passwordHash: identity.passwordHash,
        newCustomers: await trx.selectFrom("customers").select("id").where("email", "=", newEmail).execute(),
        sessions: await count("customer_sessions"),
        resets: await count("customer_password_resets"),
        notifications: await count("notifications"),
        searches: await count("flight_searches"),
      };
    });
  }

  beforeAll(async () => {
    victim = nextCustomer();
    before = await state();
    /** A complete, valid body of each operation the forged requests send. */
    const bodies: Partial<Record<OtaOperationId, Record<string, unknown>>> = {
      signUp: {
        email: newEmail,
        password: PASSWORD,
        firstName: "Mallory",
        lastName: "Forge",
        marketingConsent: true,
        termsVersion: TERMS_VERSION,
      },
      signIn: { email: victim.email, password: PASSWORD },
      requestPasswordReset: { email: victim.email },
      resendEmailVerification: {},
      changePassword: {
        currentPassword: PASSWORD,
        newPassword: `Owned-${randomBytes(9).toString("base64url")}`,
      },
      updateAccount: { firstName: "Mallory" },
      deleteAccount: { currentPassword: PASSWORD },
      signOut: { scope: "all" },
      createFlightSearch: {
        mode: "simple",
        originLocationCode: "MAD",
        destinationLocationCode: "ORY",
        departureDate: dateFromToday(60),
        adults: 1,
      },
    };
    const forge = async (operation: Operation, body: object, customer: Customer | undefined) => {
      const key = randomUUID();
      keys.push(key);
      return await request(api.server)
        [operation.method](operation.path)
        .set({
          ...edgeHeaders(ALPHA_HOST),
          "X-Forwarded-For": newIp(),
          Cookie: cookieHeader(forged, customer),
          "Idempotency-Key": key,
          "If-Match": '"1"',
          ...forged.headers,
        })
        .send(body);
    };
    for (const operation of STATE_CHANGING) {
      const sent = bodies[operation.operationId];
      if (sent === undefined) {
        continue;
      }
      answers.push([operation.operationId, await forge(operation, sent, victim)]);
      if (!sessionOnly.has(operation.operationId)) {
        anonymousAnswers.push([operation.operationId, await forge(operation, sent, undefined)]);
      }
    }
    after = await state();
  }, MATRIX_TIMEOUT_MS);

  it("[OBE-057 AC2] refuses each with 403 CSRF_TOKEN_INVALID, with and without a session, and changes nothing: no account, session, reset, e-mail, search, idempotency record or cookie [OF-03 AC2]", async () => {
    expect(answers.map(([operationId]) => operationId).sort()).toEqual(
      [
        "signUp",
        "signIn",
        "requestPasswordReset",
        "resendEmailVerification",
        "changePassword",
        "updateAccount",
        "deleteAccount",
        "signOut",
        "createFlightSearch",
      ].sort(),
    );
    // Without a session: a forged sign-in would put a session of the attacker's choosing into the browser (login
    // CSRF), a forged sign-up, reset or search would act in the visitor's name.
    expect(anonymousAnswers.map(([operationId]) => operationId).sort()).toEqual(
      [
        "signUp",
        "signIn",
        "requestPasswordReset",
        "resendEmailVerification",
        "signOut",
        "createFlightSearch",
      ].sort(),
    );
    for (const [operationId, res] of [...answers, ...anonymousAnswers]) {
      expect([operationId, ...outcome(res), res.body.error?.details]).toEqual([
        operationId,
        403,
        "CSRF_TOKEN_INVALID",
        { reason: "token_missing" },
      ]);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    expect(after).toEqual(before);
    const stored = await alphaTx((trx) =>
      trx.selectFrom("idempotency_keys").select("key").where("key", "in", keys).execute(),
    );
    expect(stored).toEqual([]);
    // The victim's credential and the CSRF value never reach a log line.
    expect(api.sink.text()).not.toContain(victim.token);
    expect(forged.csrfCookie).toMatch(CSRF_TOKEN_PATTERN);
    expect(api.sink.text()).not.toContain(forged.csrfCookie ?? "");
  });
});
