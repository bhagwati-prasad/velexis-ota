// The auth matrix of the platform API (PBE-062 step 1; conventions §12 "every endpoint has the right guard", platform
// architecture §3 steps 4 to 8 and §8, scope §1.2, PADR-0008, PADR-0009, PADR-0019): every operation of the operations
// index (`@velexis/api-types/operations`), called by every kind of caller, answers exactly what the matrix says.
//
// The matrix is generated: one row per operation of the index, whose expected answers come from the API inventories
// (platform/docs/api-inventory*.md), not from the code. An inventory row's auth notation (part 1 §2: `public`,
// `portal*`, `portal`, `portal: owner, admin`, `member`, `admin`, `internal`, `webhook`) gives who may call the
// operation; the document's `x-mfa-step-up` gives the step-up. The test fails when an operation of the index has no
// inventory row (no matrix row), when an inventory row's notation does not match the operation's `x-scope`, and when a
// tenant path (`/v1/tenants/{tenantId}/…`) has no roles or another path has some. The code's own role matrix
// (memberships/tenant-roles.ts) is not read: the matrix proves it.
//
// The callers (scope §1.2; architecture §3.1):
//
// - `noToken`: the portal or admin server for a person without a session (the BFF key and a forwarded end-user IP);
// - `throughProxy`: an internet client through Caddy (`X-Forwarded-For`, no BFF key, no token);
// - `unverified`: a portal token of an account whose e-mail is not verified (`ev = false`);
// - `portal`: a portal token of a verified account that is no member of the OTA: the non-member of the tenant paths;
// - `platformAdmin`: an admin token of an active platform admin;
// - `owner`, `admin`, `agent`, `finance`, `viewer`: portal tokens of active members of the OTA, one per role;
// - `ownerWithoutStepUp` and `platformAdminWithoutStepUp`: an owner's and an admin's token whose last TOTP step-up is
//   20 minutes old, for the operations marked `x-mfa-step-up` (PADR-0008 "Sensitive actions");
// - `disabledAccount` and `erasedAccount` (PBE-067, lead decision (5a) of 2026-11-05, security review F-1): unexpired
//   portal tokens of owners of the OTA whose account was disabled, or erased (`status = 'deleted'`, `deleted_at` set),
//   after the token was signed. Each would pass every other guard (a verified e-mail, an owner's membership, MFA and a
//   step-up of now), so the matrix proves that PortalAuthGuard's read of the account refuses them with `401
//   UNAUTHENTICATED` on every `portal_unverified` and `portal` operation, the sensitive actions included;
// - `liveAdminWithoutMfa` (PBE-071, PADR-0008 revision of 2026-11-05): a portal token (verified e-mail, step-up of now)
//   of an active admin of another OTA, a live one, who has no MFA. MfaEnrolmentGuard refuses it with `403
//   MFA_REQUIRED` (`details.reason = enrolment_required`) on every `portal` operation, the matrix OTA's tenant paths
//   included (the guard runs before TenantRoleGuard), and lets it through on the `portal_unverified` operations, which
//   are all its enrolment needs.
//
// Every other account has MFA, and every other token a step-up of now (the FakeClock's time), so the step-up guard lets
// them through; every milestone switch is on (a stand-in for FeatureSwitches), so FeatureGuard does. Each request sends
// the JSON body `[]`, which no operation takes: request validation, which runs after every guard (common.module.ts
// API_GUARDS, then the validation interceptor), refuses it with `400 VALIDATION_FAILED` and a body field error. So an
// allowed call answers that `400` whatever the operation, no handler runs, and nothing the matrix does changes state;
// a refused call is told apart by its status and code. Path parameters other than the OTA's `tenantId` get a value of
// their own per request (the domain check's limit counts per `domainId`, before the guards), and every request comes
// from an end-user IP of its own (an IPv6 /64 of the documentation prefix), so no per-IP limit is reached; no account
// makes more than one request per operation, so none reaches a per-account limit.
//
// The requests run in the `beforeAll` hook with a budget of their own; the tests read what they answered. A refusal
// whose status the document does not list for its operation is reported by the contract test below.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  platformOperations,
  type ApiOperation,
  type PlatformOperationId,
} from "@velexis/api-types/operations";
import { responseChecker } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURE_VARIABLES,
  FEATURES,
  featuresFor,
  FeatureSwitches,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import { PlatformOpenApi } from "../../../src/common/http/openapi-validation.interceptor";
import { APP_DIR } from "../../../src/config";
import { insertAccount, testId, type PlatformRow } from "../../builders/platform-rows";
import { insertMember, insertOta } from "../../builders/tenants";
import { PENDING_OPERATIONS } from "../../contract/pending-operations";
import { createTestApp, type TestApp } from "../../support/app";

/** The database clone, the Nest module graph and the Ajv validators of the document take seconds on a loaded runner. */
const SETUP_TIMEOUT_MS = 60_000;
/**
 * The matrix: about 2 000 requests, each answered by a guard or the request validation, a few seconds locally; the
 * bound allows for a busy 4-CPU runner and only stops a run that hangs.
 */
const MATRIX_TIMEOUT_MS = 120_000;
/** Requests in flight at once: enough to keep the API busy, few enough for the database pool. */
const CONCURRENCY = 8;
const FAMILY = testId("asn", 62_000);
/** How old the last step-up of the `…WithoutStepUp` callers is: past the 15 minutes of PADR-0008. */
const STALE_STEP_UP_SECONDS = 20 * 60;

// ---- The matrix ----------------------------------------------------------------------------------------------------

/** The five roles of scope §1.2, written out here: the matrix does not read the code's role list. */
const ROLES = ["owner", "admin", "agent", "finance", "viewer"] as const;
type Role = (typeof ROLES)[number];

const CALLERS = [
  "noToken",
  "throughProxy",
  "unverified",
  "portal",
  "platformAdmin",
  ...ROLES,
  "ownerWithoutStepUp",
  "platformAdminWithoutStepUp",
  "disabledAccount",
  "erasedAccount",
  "liveAdminWithoutMfa",
] as const;
type Caller = (typeof CALLERS)[number];

/** The portal tokens of accounts disabled or erased after the token was signed (PBE-067). */
const REVOKED_ACCOUNT_CALLERS: readonly Caller[] = ["disabledAccount", "erasedAccount"];

/** Who may call an operation, as an API inventory's auth column writes it (part 1 §2). */
type Gate =
  | { readonly kind: "public" | "internal" | "webhook" | "admin" }
  | { readonly kind: "portal"; readonly verified: boolean; readonly roles?: readonly Role[] };

/** One row of an inventory table. */
interface InventoryRow {
  readonly file: string;
  readonly operationId: string;
  readonly auth: string;
  /** The row's cells, for the step-up mark, which part 3 writes in the path or purpose cell. */
  readonly cells: readonly string[];
}

/** What a caller is answered: `allowed` (every guard passed), or the refusal's status and code. */
type Answer = "allowed" | `${number} ${string}`;

/** One row of the matrix: an operation of the index and who may call it. */
interface MatrixRow {
  readonly operation: ApiOperation<PlatformOperationId>;
  /** The inventory row, or `undefined` when the inventories do not list the operation (the test then fails). */
  readonly inventory: InventoryRow | undefined;
  readonly gate: Gate | undefined;
  /** `x-mfa-step-up: true` in the document. */
  readonly stepUp: boolean;
}

const DOCS = join(APP_DIR, "..", "docs");
const INVENTORY_FILES = ["api-inventory.md", "api-inventory-resources.md", "api-inventory-admin.md"] as const;

/**
 * Every row of the operation tables of the three inventories. A table whose header has an `Auth` column gives the
 * notation there; the admin tables of part 3 (§2 to §7) have none: their operations are `admin`, except those whose
 * path cell says `(public)` (part 3 §1).
 */
function inventoryRows(): InventoryRow[] {
  const rows: InventoryRow[] = [];
  for (const file of INVENTORY_FILES) {
    let header: string[] | undefined;
    for (const line of readFileSync(join(DOCS, file), "utf8").split("\n")) {
      if (!line.startsWith("|")) {
        header = undefined;
        continue;
      }
      // Cells are separated by unescaped pipes (`"invalid" \| "reserved"` stays in one cell).
      const cells = line
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (cells[0] === "Operation") {
        header = cells;
        continue;
      }
      if (header === undefined || /^-+$/.test(cells[0] ?? "")) {
        continue;
      }
      const authColumn = header.indexOf("Auth");
      const auth =
        authColumn >= 0
          ? (cells[authColumn] ?? "")
          : (cells[1] ?? "").includes("(public)")
            ? "public"
            : "admin";
      for (const [, operationId] of (cells[0] ?? "").matchAll(/`([A-Za-z]+)`/g)) {
        rows.push({ file, operationId: operationId ?? "", auth, cells });
      }
    }
  }
  return rows;
}

/** The gate of an inventory row's auth notation; `as \`createApiKey\`` takes that operation's. */
function gateOf(row: InventoryRow, rows: ReadonlyMap<string, InventoryRow>): Gate {
  const reference = /^as `([A-Za-z]+)`/.exec(row.auth);
  if (reference !== null) {
    const target = rows.get(reference[1] ?? "");
    if (target === undefined) {
      throw new Error(`${row.operationId}: its auth refers to ${reference[1] ?? ""}, which has no row`);
    }
    return gateOf(target, rows);
  }
  const lead = /^(?:`([^`]+)`|(public|admin)\b)/.exec(row.auth);
  const notation = lead?.[1] ?? lead?.[2] ?? "";
  if (notation === "public" || notation === "internal" || notation === "webhook" || notation === "admin") {
    return { kind: notation };
  }
  if (notation === "portal*" || notation === "portal") {
    return { kind: "portal", verified: notation === "portal" };
  }
  const members = /^portal: (.+)$/.exec(notation);
  if (members === null) {
    throw new Error(`${row.operationId}: the auth notation "${row.auth}" is not one of part 1 §2`);
  }
  const named = members[1] === "member" ? [...ROLES] : (members[1] ?? "").split(", ");
  const unknown = named.filter((role) => !(ROLES as readonly string[]).includes(role));
  if (unknown.length > 0) {
    throw new Error(
      `${row.operationId}: "${row.auth}" names roles that are not roles: ${unknown.join(", ")}`,
    );
  }
  // "or the member themself" (removeMember): every member passes the role guard; the service lets owners and admins
  // remove others and anyone remove themself (members.int.test.ts).
  const roles = row.auth.includes("or the member themself") ? [...ROLES] : (named as Role[]);
  return { kind: "portal", verified: true, roles };
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `x-mfa-step-up` of every operation of the document. */
function stepUps(): ReadonlyMap<string, boolean> {
  const api = PlatformOpenApi.load();
  const paths = isObject(api.document["paths"]) ? api.document["paths"] : {};
  const found = new Map<string, boolean>();
  for (const { operationId, method, path } of api.operations()) {
    const item = paths[path];
    const operation = isObject(item) ? item[method] : undefined;
    found.set(operationId, isObject(operation) && operation["x-mfa-step-up"] === true);
  }
  return found;
}

/** One row per operation of the index. */
function matrixRows(): MatrixRow[] {
  const inventory = inventoryRows();
  const byId = new Map(inventory.map((row) => [row.operationId, row]));
  const stepUp = stepUps();
  return platformOperations.map((operation) => {
    const row = byId.get(operation.operationId);
    return {
      operation,
      inventory: row,
      gate: row === undefined ? undefined : gateOf(row, byId),
      stepUp: stepUp.get(operation.operationId) === true,
    };
  });
}

const ROWS = matrixRows();

/** The `x-scope` an inventory notation stands for (part 1 §2, part 3 introduction). */
function scopeOf(gate: Gate): string {
  if (gate.kind === "portal") {
    return gate.verified ? "portal" : "portal_unverified";
  }
  return gate.kind === "admin" ? "platform_admin" : gate.kind;
}

/**
 * True when an inventory row marks the operation `MFA↑` without a condition: `…, MFA↑` at the end of a cell, `(MFA↑)`
 * or `(**reason**, MFA↑)`. A conditional mark (`granting owner: MFA↑`, `live secret keys MFA↑`, `MFA↑ when the secret
 * … changes`) is a check of the service, tested with its operation, and never `x-mfa-step-up`.
 */
function marksStepUp(row: InventoryRow | undefined): boolean {
  return (row?.cells ?? []).some((cell) => /(?:^|, |\()MFA↑(?:\)|,|$)/.test(cell));
}

/** True for an operation under `/v1/tenants/{tenantId}`: a TenantRoleGuard path, `404` for non-members. */
const isTenantPath = (operation: ApiOperation): boolean =>
  operation.path.startsWith("/v1/tenants/{tenantId}");

const PORTAL_CALLERS: readonly Caller[] = ["unverified", "portal", ...ROLES, "ownerWithoutStepUp"];

/** What the matrix expects `caller` to be answered on `row`. */
function expectedAnswer(row: MatrixRow, caller: Caller): Answer {
  const gate = row.gate;
  if (gate === undefined) {
    throw new Error(`${row.operation.operationId} has no row in the API inventories`);
  }
  switch (gate.kind) {
    case "public":
      return "allowed";
    case "internal":
      // Loopback without X-Forwarded-For only: through Caddy the internal surface does not exist (PADR-0009 item 1).
      return caller === "throughProxy" ? "404 NOT_FOUND" : "allowed";
    case "webhook":
      // No token opens a webhook receiver; without a Stripe signature every caller is refused.
      return "400 WEBHOOK_SIGNATURE_INVALID";
    case "admin":
      if (caller === "platformAdmin") {
        return "allowed";
      }
      if (caller === "platformAdminWithoutStepUp") {
        return row.stepUp ? "401 REAUTH_REQUIRED" : "allowed";
      }
      // A portal token, an unverified one or none: the admin surface is another audience.
      return "401 UNAUTHENTICATED";
    case "portal": {
      // PBE-071: an owner or admin of a live OTA without MFA must enrol before any `portal` operation, whatever the
      // OTA of the path; the `portal_unverified` operations of the enrolment stay open.
      if (caller === "liveAdminWithoutMfa") {
        return gate.verified ? "403 MFA_REQUIRED" : "allowed";
      }
      // PBE-067: the token of a disabled or erased account is refused at once, before the e-mail, role and step-up
      // checks, as a missing token is.
      if (!PORTAL_CALLERS.includes(caller) || REVOKED_ACCOUNT_CALLERS.includes(caller)) {
        return "401 UNAUTHENTICATED";
      }
      if (caller === "unverified") {
        return gate.verified ? "403 EMAIL_NOT_VERIFIED" : "allowed";
      }
      if (gate.roles !== undefined) {
        if (caller === "portal") {
          return "404 NOT_FOUND";
        }
        const role: Role = caller === "ownerWithoutStepUp" ? "owner" : (caller as Role);
        if (!gate.roles.includes(role)) {
          return "403 FORBIDDEN";
        }
      }
      return caller === "ownerWithoutStepUp" && row.stepUp ? "401 REAUTH_REQUIRED" : "allowed";
    }
  }
}

// ---- The application -----------------------------------------------------------------------------------------------

/** Every milestone switch on, so FeatureGuard lets every caller through (the switches have tests of their own). */
class AllSwitchesOn {
  isEnabled(_feature: Feature): boolean {
    return true;
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(FEATURES.map((feature) => [FEATURE_VARIABLES[feature], true])) as FeatureConfig,
    );
  }
}

let t: TestApp;
let tenantId = "";
/** The `Authorization` header of each token caller. */
const bearer = new Map<Caller, string>();
/** What each operation answered each caller. */
const answers = new Map<string, Map<Caller, Answer>>();
/**
 * `details.reason` of each `403 MFA_REQUIRED` answer of `liveAdminWithoutMfa`, by operation (PBE-071): the enrolment's
 * refusal names `enrolment_required`; RecentMfaGuard's and the services' `MFA_REQUIRED` name no reason.
 */
const enrolmentReasons = new Map<string, unknown>();
/** The refusals whose status or body the document does not list for the operation. */
const undocumented: string[] = [];
/** Answers of 500 or more: a crash is a finding whatever the matrix expects. */
const crashes: string[] = [];

/** A request's own end-user IP: one IPv6 /64 of the documentation prefix (RFC 3849) per request. */
let requests = 0;
function nextIp(): string {
  requests += 1;
  return `2001:db8:${Math.floor(requests / 0x10000).toString(16)}:${(requests % 0x10000).toString(16)}::62`;
}

/** The request path of `operation`: the OTA's id for a tenant path's `tenantId`, a value of its own elsewhere. */
function pathOf(operation: ApiOperation, n: number): string {
  return operation.path.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) =>
    name === "tenantId" && isTenantPath(operation) ? tenantId : `matrix${n}`,
  );
}

/** The headers of `caller`'s request. */
function headersOf(caller: Caller): Record<string, string> {
  const ip = nextIp();
  if (caller === "throughProxy") {
    return { "X-Forwarded-For": ip };
  }
  const token = bearer.get(caller);
  return { ...t.bffHeaders(ip), ...(token === undefined ? {} : { Authorization: token }) };
}

/** The answer of a response: `allowed` for the request validation's refusal of the body, else status and code. */
function answerOf(res: Response): Answer {
  const error = isObject(res.body) && isObject(res.body["error"]) ? res.body["error"] : undefined;
  const fieldErrors = Array.isArray(error?.["fieldErrors"]) ? (error["fieldErrors"] as unknown[]) : [];
  if (
    res.status === 400 &&
    error?.["code"] === "VALIDATION_FAILED" &&
    fieldErrors.some((fieldError) => isObject(fieldError) && fieldError["path"] === "")
  ) {
    return "allowed";
  }
  const code = typeof error?.["code"] === "string" ? error["code"] : "(no error envelope)";
  return `${res.status} ${code}`;
}

async function call(row: MatrixRow, caller: Caller, n: number): Promise<void> {
  const { operation } = row;
  const res = await t.http[operation.method as "get" | "post" | "put" | "patch" | "delete"](
    pathOf(operation, n),
  )
    .set(headersOf(caller))
    .send([]);
  const answer = answerOf(res);
  let byCaller = answers.get(operation.operationId);
  if (byCaller === undefined) {
    byCaller = new Map();
    answers.set(operation.operationId, byCaller);
  }
  byCaller.set(caller, answer);
  if (caller === "liveAdminWithoutMfa" && answer === "403 MFA_REQUIRED") {
    const error = isObject(res.body) && isObject(res.body["error"]) ? res.body["error"] : {};
    enrolmentReasons.set(
      operation.operationId,
      isObject(error["details"]) ? error["details"]["reason"] : undefined,
    );
  }
  if (res.status >= 500) {
    crashes.push(`${operation.operationId} for ${caller}: ${answer}`);
  }
  if (answer !== "allowed") {
    for (const problem of responseChecker("platform").check(operation.operationId, res)) {
      undocumented.push(`${operation.operationId} ${answer}: ${problem.message}`);
    }
  }
}

beforeAll(async () => {
  // The database clone, the Nest module graph and the Ajv validators of the document are the expensive part.
  t = await createTestApp({ overrides: [{ provide: FeatureSwitches, useValue: new AllSwitchesOn() }] });
  const pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  const tokens = t.app.get(TokenService);
  const now = Math.floor(t.clock.now().getTime() / 1000);
  const sign = async (
    account: PlatformRow<"accounts">,
    input: Partial<AccessTokenInput>,
  ): Promise<string> => {
    const { token } = await tokens.sign({
      aud: "portal",
      sub: account.id,
      sid: FAMILY,
      ev: true,
      amr: ["pwd", "otp"],
      mfa_at: now,
      ...input,
    });
    return `Bearer ${token}`;
  };

  const people = new Map<Role | "ownerWithoutStepUp", PlatformRow<"accounts">>();
  for (const who of [...ROLES, "ownerWithoutStepUp"] as const) {
    people.set(who, await insertAccount(pool, { mfa_enabled: true }));
  }
  const owner = people.get("owner") as PlatformRow<"accounts">;
  const { tenant } = await insertOta(pool, { members: [[owner, "owner"]] });
  tenantId = tenant.id;
  for (const role of ROLES.filter((each) => each !== "owner")) {
    await insertMember(pool, tenant, people.get(role) as PlatformRow<"accounts">, role);
  }
  const staleOwner = people.get("ownerWithoutStepUp") as PlatformRow<"accounts">;
  await insertMember(pool, tenant, staleOwner, "owner");
  // PBE-067: two more owners with MFA, whose tokens are signed while they are active; then one account is disabled
  // and the other erased, as an admin's disable or an erasure would leave them, behind the tokens' backs.
  const revoked = new Map<Caller, PlatformRow<"accounts">>();
  for (const caller of REVOKED_ACCOUNT_CALLERS) {
    const account = await insertAccount(pool, { mfa_enabled: true });
    await insertMember(pool, tenant, account, "owner");
    bearer.set(caller, await sign(account, {}));
    revoked.set(caller, account);
  }
  await pool.query("UPDATE platform.accounts SET status = 'disabled' WHERE id = $1", [
    revoked.get("disabledAccount")?.id,
  ]);
  await pool.query("UPDATE platform.accounts SET status = 'deleted', deleted_at = now() WHERE id = $1", [
    revoked.get("erasedAccount")?.id,
  ]);
  // PBE-071: an admin without MFA of another OTA, a live one whose owner has MFA (goLive needs it).
  const liveAdmin = await insertAccount(pool, { mfa_enabled: false });
  await insertOta(pool, {
    tenant: { storefront_environment: "live", live_enabled_at: t.clock.now() },
    members: [
      [await insertAccount(pool, { mfa_enabled: true }), "owner"],
      [liveAdmin, "admin"],
    ],
  });
  bearer.set("liveAdminWithoutMfa", await sign(liveAdmin, {}));

  const unverified = await insertAccount(pool, { status: "pending_verification", email_verified_at: null });
  const stranger = await insertAccount(pool, { mfa_enabled: true });
  const admin = await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true });
  const staleAdmin = await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true });

  const { token: unverifiedToken } = await tokens.sign({
    aud: "portal",
    sub: unverified.id,
    sid: FAMILY,
    ev: false,
    amr: ["pwd"],
  });
  bearer.set("unverified", `Bearer ${unverifiedToken}`);
  bearer.set("portal", await sign(stranger, {}));
  bearer.set("platformAdmin", await sign(admin, { aud: "platform_admin" }));
  bearer.set(
    "platformAdminWithoutStepUp",
    await sign(staleAdmin, { aud: "platform_admin", mfa_at: now - STALE_STEP_UP_SECONDS }),
  );
  for (const role of ROLES) {
    bearer.set(role, await sign(people.get(role) as PlatformRow<"accounts">, {}));
  }
  bearer.set("ownerWithoutStepUp", await sign(staleOwner, { mfa_at: now - STALE_STEP_UP_SECONDS }));
  // The document's checker parses the document once; parse it here, inside the set-up's budget.
  responseChecker("platform");
}, SETUP_TIMEOUT_MS);

beforeAll(async () => {
  // Every operation for every caller: the requests are the matrix, run once; the tests below read the answers.
  const work = ROWS.filter((row) => row.gate !== undefined).flatMap((row) =>
    CALLERS.map((caller) => ({ row, caller })),
  );
  let index = 0;
  const lane = async (): Promise<void> => {
    while (index < work.length) {
      const item = work[index] as (typeof work)[number];
      index += 1;
      await call(item.row, item.caller, index);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));
}, MATRIX_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

// ---- Tests ---------------------------------------------------------------------------------------------------------

describe("the auth matrix of the platform API", () => {
  it("[PBE-062 AC1] has a row for every operation of the operations index, taken from the API inventories", () => {
    const missing = ROWS.filter((row) => row.inventory === undefined).map((row) => row.operation.operationId);

    expect(missing, "operations without a row in the API inventories").toEqual([]);
    expect(ROWS.map((row) => row.operation.operationId)).toEqual(
      platformOperations.map((operation) => operation.operationId),
    );
    // The index lists every operation of the document once (route parity checks the routes against it).
    expect(new Set(ROWS.map((row) => row.operation.operationId)).size).toBe(platformOperations.length);
    expect(platformOperations.length).toBeGreaterThanOrEqual(144);
    // Every caller of every operation was asked.
    expect([...answers.values()].reduce((sum, byCaller) => sum + byCaller.size, 0)).toBe(
      platformOperations.length * CALLERS.length,
    );
  });

  it("[PBE-062 AC1] agrees with the document: the inventories' notation is the operation's x-scope, and only tenant paths name roles", () => {
    const mismatches = ROWS.flatMap((row) => {
      const gate = row.gate;
      if (gate === undefined) {
        return [];
      }
      const problems: string[] = [];
      if (scopeOf(gate) !== row.operation.scope) {
        problems.push(
          `${row.operation.operationId}: the inventory says "${row.inventory?.auth ?? ""}", the document x-scope ${String(row.operation.scope)}`,
        );
      }
      const hasRoles = gate.kind === "portal" && gate.roles !== undefined;
      if (hasRoles !== isTenantPath(row.operation)) {
        problems.push(
          `${row.operation.operationId} (${row.operation.path}): ${hasRoles ? "roles on a path without {tenantId}" : "a tenant path without roles"}`,
        );
      }
      if (row.stepUp && gate.kind !== "portal" && gate.kind !== "admin") {
        problems.push(`${row.operation.operationId}: x-mfa-step-up on a ${gate.kind} operation`);
      }
      if (row.stepUp !== marksStepUp(row.inventory)) {
        problems.push(
          `${row.operation.operationId}: x-mfa-step-up is ${String(row.stepUp)}, the inventory ${marksStepUp(row.inventory) ? "marks" : "does not mark"} MFA↑`,
        );
      }
      return problems;
    });

    expect(mismatches).toEqual([]);
    // The sensitive actions of PADR-0008 that the guard enforces, portal and admin.
    expect(ROWS.filter((row) => row.stepUp).map((row) => row.operation.operationId)).toEqual(
      expect.arrayContaining([
        "disableMfa",
        "goLive",
        "setPayoutAccount",
        "adminRevealPayoutAccount",
        "adminGrantAdmin",
      ]),
    );
  });

  it.each(ROWS.map((row) => [row.operation.operationId, row] as const))(
    "[PBE-062 AC1] %s answers every caller as the matrix says",
    (operationId, row) => {
      const expected = Object.fromEntries(CALLERS.map((caller) => [caller, expectedAnswer(row, caller)]));
      const observed = Object.fromEntries(
        CALLERS.map((caller) => [caller, answers.get(operationId)?.get(caller) ?? "(not asked)"]),
      );

      expect(observed).toEqual(expected);
    },
  );

  it("[PBE-062 AC1] crashes on no call, and every refusal is a documented answer of its operation", () => {
    expect(crashes).toEqual([]);
    expect(undocumented).toEqual([]);
  });

  it("[PBE-062 AC1] refuses non-members with 404 on every tenant path and members of other roles with 403", () => {
    const tenantRows = ROWS.filter((row) => isTenantPath(row.operation));
    expect(tenantRows.length).toBeGreaterThan(40);
    for (const row of tenantRows) {
      expect(answers.get(row.operation.operationId)?.get("portal"), row.operation.operationId).toBe(
        "404 NOT_FOUND",
      );
    }
    // Each role is refused somewhere and allowed somewhere: the matrix tells the roles apart.
    for (const role of ROLES) {
      const roleAnswers = tenantRows.map((row) => answers.get(row.operation.operationId)?.get(role));
      expect(roleAnswers, role).toContain("allowed");
      if (role !== "owner") {
        expect(roleAnswers, role).toContain("403 FORBIDDEN");
      }
    }
  });

  it("[PBE-067 AC1] refuses the unexpired tokens of a disabled and an erased account with 401 UNAUTHENTICATED on every portal operation, the sensitive actions included", () => {
    const portalRows = ROWS.filter(
      (row) => row.operation.scope === "portal" || row.operation.scope === "portal_unverified",
    );
    const ids = portalRows.map((row) => row.operation.operationId);
    // 9 `portal_unverified` and 52 `portal` operations when the review ran (security-review.md §4).
    expect(portalRows.length).toBeGreaterThanOrEqual(61);
    expect(ids).toEqual(expect.arrayContaining(["getMe", "getTenant", "createApiKey", "setPayoutAccount"]));
    expect(portalRows.filter((row) => row.stepUp).map((row) => row.operation.operationId)).toEqual(
      expect.arrayContaining(["disableMfa", "goLive", "setPayoutAccount"]),
    );

    for (const caller of REVOKED_ACCOUNT_CALLERS) {
      const observed = Object.fromEntries(ids.map((id) => [id, answers.get(id)?.get(caller)]));
      expect(observed, caller).toEqual(Object.fromEntries(ids.map((id) => [id, "401 UNAUTHENTICATED"])));
    }
  });

  it("[PBE-067 AC2] still lets the active owners' tokens, signed alike, through the account read on every portal operation", () => {
    // The owner columns differ from the revoked ones only in the account's state: none of their answers is the 401 of
    // a refused token.
    for (const row of ROWS.filter((each) => each.gate?.kind === "portal")) {
      for (const caller of ["owner", "ownerWithoutStepUp"] as const) {
        expect(
          answers.get(row.operation.operationId)?.get(caller),
          `${row.operation.operationId} ${caller}`,
        ).not.toBe("401 UNAUTHENTICATED");
      }
    }
  });

  it("[PBE-071 AC3] refuses an admin of a live OTA without MFA with 403 MFA_REQUIRED on every portal operation, and on nothing else", () => {
    const observed = Object.fromEntries(
      ROWS.map((row) => [
        row.operation.operationId,
        answers.get(row.operation.operationId)?.get("liveAdminWithoutMfa"),
      ]),
    );
    const byScope = (scope: string) =>
      ROWS.filter((row) => row.operation.scope === scope).map((row) => row.operation.operationId);

    // 52 `portal` operations and 9 `portal_unverified` ones when the column came (security-review.md §4).
    expect(byScope("portal").length).toBeGreaterThanOrEqual(52);
    expect(byScope("portal").map((id) => observed[id])).toEqual(
      byScope("portal").map(() => "403 MFA_REQUIRED"),
    );
    // Each of them the enrolment's refusal, the step-up operations included (whose own MFA_REQUIRED names no reason).
    expect(Object.fromEntries(byScope("portal").map((id) => [id, enrolmentReasons.get(id)]))).toEqual(
      Object.fromEntries(byScope("portal").map((id) => [id, "enrolment_required"])),
    );
    expect([...enrolmentReasons.keys()].sort()).toEqual([...byScope("portal")].sort());
    expect(byScope("portal_unverified").map((id) => observed[id])).toEqual(
      byScope("portal_unverified").map(() => "allowed"),
    );
    expect(byScope("platform_admin").map((id) => observed[id])).toEqual(
      byScope("platform_admin").map(() => "401 UNAUTHENTICATED"),
    );
    // The enrolment's own operations, and the reads and sensitive actions it refuses.
    expect([observed["getMe"], observed["startMfaSetup"], observed["enableMfa"]]).toEqual([
      "allowed",
      "allowed",
      "allowed",
    ]);
    expect([observed["getTenant"], observed["createCustomerPortalSession"], observed["disableMfa"]]).toEqual([
      "403 MFA_REQUIRED",
      "403 MFA_REQUIRED",
      "403 MFA_REQUIRED",
    ]);
  });

  it("[PBE-062 AC3] pending-operations.ts is empty: every operation of the document is bound (the M5 exit of PADR-0016)", () => {
    expect(PENDING_OPERATIONS).toEqual([]);
    // A bound route answers its guards; an unbound one would answer Express's 404 without the error envelope.
    const unrouted = [...answers.entries()].flatMap(([operationId, byCaller]) =>
      [...byCaller.values()].includes("404 (no error envelope)") ? [operationId] : [],
    );
    expect(unrouted).toEqual([]);
  });
});
