// The role matrix (PBE-017 step 2; platform/docs/scope.md §1.2, PADR-0009 item 5) and TenantRoleGuard's decisions.
// The matrix is compared with the documents that define it, so a change on one side fails here: the scope's table of
// portal actions, the auth column of the API inventories (`portal: owner, admin`, `member`) and the tenant operations
// of the platform OpenAPI document. test/integration/tenants/tenants.int.test.ts runs the guard through the HTTP
// pipeline and PostgreSQL.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Type } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { platformOperations } from "@velexis/api-types/operations";
import { AppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import type { AccessTokenClaims } from "../auth/token.service";
import { setAccessToken } from "../common/auth/decorators";
import {
  TenantMembershipLookup,
  tenantMembershipOf,
  TenantRoleGuard,
  TenantRoles,
  type TenantMembership,
} from "../common/auth/tenant-role.guard";
import { APP_DIR } from "../config";
import {
  canManageRole,
  canPerform,
  rolesFor,
  TENANT_ACTIONS,
  TENANT_OPERATION_ROLES,
  TENANT_ROLES,
  tenantRolesOf,
  type TenantRole,
} from "./tenant-roles";

const DOCS = join(APP_DIR, "..", "docs");
const TENANT_PATH = "/v1/tenants/{tenantId}";

/** The cells of a Markdown table row, split on the `|` that are not escaped (`\|` inside a cell). */
function cellsOf(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/** The rows of the role table of scope §1.2: the action and the roles with a ✓, in the order of the header. */
function scopeMatrix(): Array<{ label: string; roles: string[] }> {
  const text = readFileSync(join(DOCS, "scope.md"), "utf8");
  const section = text.slice(text.indexOf("### 1.2"), text.indexOf("### 1.3"));
  const rows = section.split("\n").filter((line) => line.startsWith("|"));
  const [header = "", , ...body] = rows;
  const roles = cellsOf(header).slice(1);
  return body.map((row) => {
    const [label = "", ...marks] = cellsOf(row);
    return { label, roles: roles.filter((_, index) => marks[index] === "✓") };
  });
}

/**
 * The roles the API inventories give each operation whose auth column names tenant roles (`portal: owner, admin`,
 * `portal: member` = every role), from api-inventory.md and api-inventory-resources.md. "as `createApiKey`" takes the
 * roles of that operation; "or the member themself" lets every member through (the service narrows it).
 */
function inventoryRoles(): Map<string, string[]> {
  const raw = new Map<string, string>();
  for (const file of ["api-inventory.md", "api-inventory-resources.md"]) {
    for (const line of readFileSync(join(DOCS, file), "utf8").split("\n")) {
      const cells = cellsOf(line);
      const operation = /^`([A-Za-z]+)`$/.exec(cells[0] ?? "")?.[1];
      if (line.startsWith("|") && operation !== undefined && cells[2] !== undefined) {
        raw.set(operation, cells[2]);
      }
    }
  }
  const roles = new Map<string, string[]>();
  const resolve = (auth: string): string[] | undefined => {
    const as = /^as `([A-Za-z]+)`/.exec(auth)?.[1];
    if (as !== undefined) {
      return resolve(raw.get(as) ?? "");
    }
    const named = /`portal: ([^`]+)`/.exec(auth)?.[1];
    if (named === undefined) {
      return undefined;
    }
    if (named === "member" || auth.includes("or the member themself")) {
      return [...TENANT_ROLES];
    }
    return named.split(",").map((role) => role.trim());
  };
  for (const [operation, auth] of raw) {
    const resolved = resolve(auth);
    if (resolved !== undefined) {
      roles.set(operation, resolved);
    }
  }
  return roles;
}

describe("TENANT_ACTIONS", () => {
  it("is the role table of scope §1.2, row for row and role for role", () => {
    const documented = scopeMatrix();

    expect(documented.length).toBeGreaterThan(10);
    expect(Object.values(TENANT_ACTIONS).map(({ label, roles }) => ({ label, roles: [...roles] }))).toEqual(
      documented,
    );
  });

  it("answers rolesFor and canPerform from the table", () => {
    expect(rolesFor("editProfile")).toEqual(["owner", "admin"]);
    expect(rolesFor("viewBilling")).toEqual(["owner", "finance"]);
    expect(rolesFor("viewOverview")).toEqual(TENANT_ROLES);
    expect(canPerform("finance", "viewConnections")).toBe(true);
    expect(canPerform("agent", "viewConnections")).toBe(false);
    expect(canPerform("admin", "goLive")).toBe(false);
  });

  it("is frozen, so no caller can widen a role list", () => {
    expect(Object.isFrozen(TENANT_ACTIONS)).toBe(true);
    for (const action of Object.values(TENANT_ACTIONS)) {
      expect(Object.isFrozen(action.roles), action.label).toBe(true);
    }
    expect(Object.isFrozen(TENANT_OPERATION_ROLES)).toBe(true);
    for (const roles of Object.values(TENANT_OPERATION_ROLES)) {
      expect(Object.isFrozen(roles)).toBe(true);
    }
  });
});

describe("canManageRole", () => {
  it.each<[TenantRole, TenantRole[]]>([
    ["owner", ["owner", "admin", "agent", "finance", "viewer"]],
    ["admin", ["agent", "finance", "viewer"]],
    ["agent", []],
    ["finance", []],
    ["viewer", []],
  ])("lets %s manage %j: only owners touch owners and admins", (actor, managed) => {
    expect(TENANT_ROLES.filter((target) => canManageRole(actor, target))).toEqual(managed);
  });
});

describe("TENANT_OPERATION_ROLES", () => {
  it("[PBE-017 AC4] has an entry for every portal operation of the document under /v1/tenants/{tenantId}, and only those", () => {
    const tenantOperations = platformOperations.filter(
      ({ path }) => path === TENANT_PATH || path.startsWith(`${TENANT_PATH}/`),
    );

    expect(tenantOperations.length).toBeGreaterThan(20);
    expect(tenantOperations.filter(({ scope }) => scope !== "portal")).toEqual([]);
    expect(Object.keys(TENANT_OPERATION_ROLES).sort()).toEqual(
      tenantOperations.map(({ operationId }) => operationId).sort(),
    );
  });

  it("gives each operation the roles of the API inventories' auth column", () => {
    const documented = inventoryRoles();

    for (const [operationId, roles] of Object.entries(TENANT_OPERATION_ROLES)) {
      expect([...roles].sort(), operationId).toEqual([...(documented.get(operationId) ?? ["(none)"])].sort());
    }
  });

  it("gives tenantRolesOf a copy, in the order of the matrix", () => {
    const roles = tenantRolesOf("getSubscription");
    roles.push("viewer");

    expect(tenantRolesOf("getSubscription")).toEqual(["owner", "finance"]);
    expect(tenantRolesOf("getTenant")).toEqual(["owner", "admin", "agent", "finance", "viewer"]);
    expect(tenantRolesOf("updateTenant")).toEqual(["owner", "admin"]);
  });
});

// ---- TenantRoleGuard -------------------------------------------------------------------------------------------

const TENANT = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const OWNER = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1A";
const VIEWER = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1B";
const STRANGER = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1C";

/** The memberships of TENANT, as `platform.tenant_memberships` would hold the active ones. */
class FakeMemberships extends TenantMembershipLookup {
  readonly calls: Array<[string, string]> = [];

  findActive(tenantId: string, accountId: string): Promise<TenantMembership | undefined> {
    this.calls.push([tenantId, accountId]);
    const role =
      tenantId !== TENANT ? undefined : ({ [OWNER]: "owner", [VIEWER]: "viewer" } as const)[accountId];
    return Promise.resolve(
      role === undefined
        ? undefined
        : { membershipId: `stf_${accountId.slice(4)}`, tenantId, accountId, role },
    );
  }
}

@TenantRoles("owner", "admin", "agent", "finance", "viewer")
class Routes {
  /** Any member, from the controller's decorator. */
  overview(): void {}

  @TenantRoles("owner", "admin")
  profile(): void {}

  @TenantRoles("owner")
  noTenantParameter(): void {}
}

class UndecoratedRoutes {
  open(): void {}
}

interface GuardCall {
  readonly sub?: string;
  readonly aud?: "portal" | "platform_admin";
  readonly params?: Record<string, string>;
}

async function decide(
  controller: Type,
  handler: string,
  { sub, aud = "portal", params = { tenantId: TENANT } }: GuardCall,
) {
  const memberships = new FakeMemberships();
  const guard = new TenantRoleGuard(new Reflector(), memberships);
  const request = { params };
  if (sub !== undefined) {
    setAccessToken(request, { aud, sub } as AccessTokenClaims);
  }
  const target = Reflect.get(controller.prototype as object, handler) as () => void;
  const context = new ExecutionContextHost([request, {}, () => undefined], controller, target);
  try {
    await guard.canActivate(context);
    return { result: "passed", membership: tenantMembershipOf(request), calls: memberships.calls };
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw error;
    }
    return { result: error.code, status: error.status, membership: undefined, calls: memberships.calls };
  }
}

describe("TenantRoleGuard", () => {
  it("[PBE-017 AC4] answers 404 NOT_FOUND to a non-member, whatever the roles", async () => {
    for (const handler of ["overview", "profile"]) {
      const outcome = await decide(Routes, handler, { sub: STRANGER });

      expect(outcome).toMatchObject({ result: "NOT_FOUND", status: 404 });
      expect(outcome.calls).toEqual([[TENANT, STRANGER]]);
    }
    const otherTenant = await decide(Routes, "overview", {
      sub: OWNER,
      params: { tenantId: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5G" },
    });
    expect(otherTenant.result).toBe("NOT_FOUND");
  });

  it("answers 403 FORBIDDEN to a member whose role is not declared, and lets the declared roles through", async () => {
    const viewerOnProfile = await decide(Routes, "profile", { sub: VIEWER });
    const viewerOnOverview = await decide(Routes, "overview", { sub: VIEWER });
    const ownerOnProfile = await decide(Routes, "profile", { sub: OWNER });

    expect(viewerOnProfile).toMatchObject({ result: "FORBIDDEN", status: 403, membership: undefined });
    expect(viewerOnOverview).toMatchObject({
      result: "passed",
      membership: { role: "viewer", tenantId: TENANT },
    });
    expect(ownerOnProfile).toMatchObject({
      result: "passed",
      membership: { membershipId: `stf_${OWNER.slice(4)}`, accountId: OWNER, role: "owner" },
    });
  });

  it("acts only on handlers with @TenantRoles, and refuses one that no portal token reached", async () => {
    expect(await decide(UndecoratedRoutes, "open", {})).toMatchObject({ result: "passed", calls: [] });
    expect(await decide(Routes, "overview", {})).toMatchObject({ result: "UNAUTHENTICATED", calls: [] });
    expect(await decide(Routes, "overview", { sub: OWNER, aud: "platform_admin" })).toMatchObject({
      result: "UNAUTHENTICATED",
      calls: [],
    });
  });

  it("throws a programming error for @TenantRoles on a route without {tenantId}", async () => {
    await expect(decide(Routes, "noTenantParameter", { sub: OWNER, params: {} })).rejects.toThrow(
      "no {tenantId} path parameter",
    );
  });

  it("refuses @TenantRoles() without a role or with an unknown one when the class is defined", () => {
    expect(() => TenantRoles()).toThrow(TypeError);
    expect(() => TenantRoles("owner", "superuser" as TenantRole)).toThrow(TypeError);
  });
});
