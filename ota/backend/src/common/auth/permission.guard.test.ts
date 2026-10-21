// The console access rules (OBE-060; OADR-0011 points 4 to 6, scope §1.3): the role matrix of roles.ts, the console
// access check over every console operation of the document, and the permission guard with a minimal execution
// context and a recording audit writer. The guard in the API's pipeline, with the OTA admin's service key, staff
// sessions and staff_actions rows in PostgreSQL: test/integration/console/console-access.int.test.ts.
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import { AppError, isAppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import type { StaffActionsWriter } from "../../console/staff-actions.writer";
import type { CallerContext, KeyCaller, ServiceCaller } from "../../tenancy/caller-resolver";
import type { PlatformCache } from "../../tenancy/platform-cache";
import type { StaffRole } from "../../tenancy/platform-read.repository";
import type { RequestTenant, TenantContext, TenantEnvironment } from "../../tenancy/tenant-context";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";
import type { RequestContext } from "../http/request-context";
import { newId } from "../ids";
import { assertConsoleAccess, PermissionGuard, type ConsoleAccessRequest } from "./permission.guard";
import {
  assertRoleEnvironment,
  environmentsOf,
  LIVE_ROLES,
  permissionsOf,
  roleHasPermission,
  ROLE_PERMISSIONS,
  STAFF_PERMISSIONS,
} from "./roles";
import { scopedOperation } from "./scope.guard";
import type { StaffContext, StaffPrincipal } from "./staff.guard";

const ROLES: readonly StaffRole[] = ["owner", "admin", "agent", "finance", "viewer"];

/** ota/docs/scope.md §1.3, row by row: the roles that hold each permission. */
const SCOPE_TABLE: Readonly<Record<string, readonly StaffRole[]>> = {
  "bookings:read": ["owner", "admin", "agent", "finance", "viewer"],
  "customers:read": ["owner", "admin", "agent", "finance", "viewer"],
  "bookings:write": ["owner", "admin", "agent"],
  "bookings:issue": ["owner", "admin", "agent"],
  "bookings:cancel": ["owner", "admin", "agent"],
  "queues:read": ["owner", "admin", "agent"],
  "amadeus:read": ["owner", "admin", "agent"],
  "supplier_requests:read": ["owner", "admin", "agent", "finance"],
  "amadeus:write": ["owner", "admin"],
  "payments:read": ["owner", "admin", "agent", "finance", "viewer"],
  "settings:read": ["owner", "admin", "agent", "finance", "viewer"],
  "payments:capture": ["owner", "admin", "agent", "finance"],
  "payments:refund": ["owner", "admin", "finance"],
  "settings:write": ["owner", "admin"],
};

const SERVICE: ServiceCaller = { type: "service", id: "service" };

function key(scopes: readonly string[]): KeyCaller {
  const keyId = newId("key");
  return {
    type: "key",
    id: keyId,
    keyId,
    kind: "secret",
    tenantId: newId("ten"),
    environment: "test",
    scopes,
  };
}

/** The code and details of what `assertConsoleAccess` throws, or `"allowed"`. */
function verdict(request: ConsoleAccessRequest): "allowed" | { code: string; details: unknown } {
  try {
    assertConsoleAccess(request);
    return "allowed";
  } catch (error) {
    if (!isAppError(error)) {
      throw error;
    }
    return { code: error.code, details: error.details };
  }
}

/** Every console operation with a permission of the document. */
const CONSOLE_OPERATIONS = otaOperations.filter(
  (operation) =>
    operation.scope === "console" && operation.permission !== null && operation.permission !== "none",
);

describe("the role matrix (roles.ts)", () => {
  it("is scope §1.3 row by row, in the document's StaffPermission order [OBE-060]", () => {
    expect(Object.keys(SCOPE_TABLE).sort()).toEqual([...STAFF_PERMISSIONS].sort());
    for (const role of ROLES) {
      const expected = STAFF_PERMISSIONS.filter((permission) => SCOPE_TABLE[permission]?.includes(role));
      expect([role, permissionsOf(role)]).toEqual([role, expected]);
      expect([role, [...ROLE_PERMISSIONS[role]]]).toEqual([role, expected]);
    }
    expect(roleHasPermission("agent", "settings:write")).toBe(false);
    expect(roleHasPermission("admin", "settings:write")).toBe(true);
    expect(roleHasPermission("owner", "no:such")).toBe(false);
  });

  it("opens live to every role but viewer, and only on a live tenant", () => {
    expect(LIVE_ROLES).toEqual(["owner", "admin", "agent", "finance"]);
    for (const role of ROLES) {
      expect([role, environmentsOf(role, "test")]).toEqual([role, ["test"]]);
      expect([role, environmentsOf(role, "live")]).toEqual([
        role,
        role === "viewer" ? ["test"] : ["test", "live"],
      ]);
      expect(() => assertRoleEnvironment(role, "test")).not.toThrow();
    }
    expect(() => assertRoleEnvironment("viewer", "live")).toThrow(
      expect.objectContaining({
        code: "ENVIRONMENT_NOT_ALLOWED",
        status: 403,
        details: { environment: "live", environments: ["test"] },
      }),
    );
    expect(() => assertRoleEnvironment("finance", "live")).not.toThrow();
  });
});

describe("assertConsoleAccess", () => {
  const request = (
    operationId: OtaOperationId,
    change: Partial<Omit<ConsoleAccessRequest, "operation">> = {},
  ): ConsoleAccessRequest => ({
    operation: scopedOperation(operationId),
    caller: SERVICE,
    role: "agent",
    environment: "test",
    ...change,
  });

  it("gives each role exactly the permissions of scope §1.3 on every console operation [OBE-060 AC3]", () => {
    expect(CONSOLE_OPERATIONS.length).toBeGreaterThan(40);
    for (const operation of CONSOLE_OPERATIONS) {
      const permission = operation.permission ?? "";
      for (const role of ROLES) {
        const expected = SCOPE_TABLE[permission]?.includes(role)
          ? "allowed"
          : { code: "FORBIDDEN", details: { requiredPermission: permission } };
        expect([operation.operationId, role, verdict(request(operation.operationId, { role }))]).toEqual([
          operation.operationId,
          role,
          expected,
        ]);
      }
    }
  });

  it("answers an agent's settings write with 403 FORBIDDEN naming settings:write [OBE-060 AC3]", () => {
    expect(verdict(request("consoleCreateMarkupRule"))).toEqual({
      code: "FORBIDDEN",
      details: { requiredPermission: "settings:write" },
    });
    expect(verdict(request("consoleCreateMarkupRule", { role: "admin" }))).toBe("allowed");
  });

  it("refuses live to a viewer on every operation, the staff-session ones included [OBE-060 AC3]", () => {
    for (const operationId of ["consoleGetMe", "consoleListBookings"] as const) {
      expect(verdict(request(operationId, { role: "viewer", environment: "live" }))).toEqual({
        code: "ENVIRONMENT_NOT_ALLOWED",
        details: { environment: "live", environments: ["test"] },
      });
      expect(verdict(request(operationId, { role: "viewer", environment: "test" }))).toBe("allowed");
      expect(verdict(request(operationId, { role: "finance", environment: "live" }))).toBe("allowed");
      // A custom console's live key with a viewer's staff token: the same rule.
      expect(
        verdict(request(operationId, { caller: key(["console"]), role: "viewer", environment: "live" })),
      ).toEqual({
        code: "ENVIRONMENT_NOT_ALLOWED",
        details: { environment: "live", environments: ["test"] },
      });
    }
  });

  it("lets the staff-session operations through without a permission", () => {
    for (const operationId of [
      "consoleSignIn",
      "consoleRefreshSession",
      "consoleSignOut",
      "consoleGetMe",
    ] as const) {
      expect(verdict(request(operationId, { role: undefined }))).toBe("allowed");
      expect(verdict(request(operationId, { role: "viewer" }))).toBe("allowed");
    }
  });

  it("gives a key-only call exactly the permissions on the key, with console:automation", () => {
    const environment: TenantEnvironment = "test";
    const reader = key(["console:automation", "bookings:read"]);
    const plain = key(["console", "bookings:read"]);

    expect(verdict({ ...request("consoleListBookings"), caller: reader, role: undefined, environment })).toBe(
      "allowed",
    );
    expect(verdict({ ...request("consoleIssueBooking"), caller: reader, role: undefined })).toEqual({
      code: "FORBIDDEN",
      details: { requiredPermission: "bookings:issue" },
    });
    expect(verdict({ ...request("consoleListBookings"), caller: plain, role: undefined })).toEqual({
      code: "SCOPE_NOT_ALLOWED",
      details: { requiredScope: "console:automation" },
    });
    // With a staff token the role decides, not the key's list.
    expect(verdict({ ...request("consoleIssueBooking"), caller: plain, role: "agent" })).toBe("allowed");
    // A shared operation in console scope has no x-permission, and still needs console:automation without a staff
    // member (the scope guard refuses it first in the pipeline).
    expect(scopedOperation("createFlightSearch").permission).toBeNull();
    expect(verdict({ ...request("createFlightSearch"), caller: plain, role: undefined })).toEqual({
      code: "SCOPE_NOT_ALLOWED",
      details: { requiredScope: "console:automation" },
    });
    expect(verdict({ ...request("createFlightSearch"), caller: reader, role: undefined })).toBe("allowed");
  });

  it("never lets the service caller act without a staff member", () => {
    expect(verdict(request("consoleListBookings", { role: undefined }))).toEqual({
      code: "UNAUTHENTICATED",
      details: undefined,
    });
  });
});

describe("PermissionGuard", () => {
  const TENANT_ID = newId("ten");

  class Handlers {
    bound(): void {}
    unbound(): void {}
  }
  Reflect.defineMetadata(OPENAPI_OPERATION, "consoleCreateMarkupRule", Handlers.prototype.bound);

  function principal(role: StaffRole): StaffPrincipal {
    return {
      family: { id: newId("asn"), staffId: newId("stf"), role } as StaffPrincipal["family"],
      member: {
        role,
        accountId: newId("acc"),
        account: { email: "agent@example.com" },
      } as StaffPrincipal["member"],
      accessTokenExpiresAt: new Date(),
    };
  }

  function harness(
    role: StaffRole | undefined,
    options: {
      consoleScope?: boolean;
      environment?: TenantEnvironment;
      caller?: ServiceCaller | KeyCaller;
      tenantLive?: boolean;
      tenantUnreadable?: boolean;
    } = {},
  ) {
    const denials: Array<{ operationId: string; params: unknown; code: string }> = [];
    const tenantLookups: string[] = [];
    const platform = {
      tenantById: (tenantId: string) => {
        tenantLookups.push(tenantId);
        if (options.tenantUnreadable === true) {
          return Promise.reject(new AppError("SERVICE_UNAVAILABLE"));
        }
        return Promise.resolve({
          id: tenantId,
          storefrontEnvironment: options.tenantLive === false ? "test" : "live",
        });
      },
    } as unknown as PlatformCache;
    const writer = {
      recordDenial: (operationId: string, params: unknown, error: AppError) => {
        denials.push({ operationId, params, code: error.code });
        return Promise.resolve();
      },
    } as unknown as StaffActionsWriter;
    const guard = new PermissionGuard(
      new Reflector(),
      { get: () => options.caller ?? SERVICE } as unknown as CallerContext,
      {
        get: () => ({ tenantId: TENANT_ID, environment: options.environment ?? "test" }) as RequestTenant,
      } as unknown as TenantContext,
      { isConsoleScope: () => options.consoleScope ?? true } as unknown as RequestContext,
      { get: () => (role === undefined ? undefined : principal(role)) } as unknown as StaffContext,
      writer,
      platform,
    );
    return { guard, denials, tenantLookups };
  }

  function execution(handler: () => void): ExecutionContext {
    return {
      getType: () => "http",
      getHandler: () => handler,
      getClass: () => Handlers,
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, params: { markupRuleId: "mkr_1" } }) }),
    } as unknown as ExecutionContext;
  }

  it("refuses with the rule's error and records the denial [OBE-060 AC3]", async () => {
    const { guard, denials } = harness("agent");

    await expect(guard.canActivate(execution(Handlers.prototype.bound))).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { requiredPermission: "settings:write" },
    });
    expect(denials).toEqual([
      { operationId: "consoleCreateMarkupRule", params: { markupRuleId: "mkr_1" }, code: "FORBIDDEN" },
    ]);
  });

  it("records an environment refusal too, and lets an allowed request through without a row", async () => {
    const viewer = harness("viewer", { environment: "live" });
    await expect(viewer.guard.canActivate(execution(Handlers.prototype.bound))).rejects.toMatchObject({
      code: "ENVIRONMENT_NOT_ALLOWED",
    });
    expect(viewer.denials.map((denial) => denial.code)).toEqual(["ENVIRONMENT_NOT_ALLOWED"]);

    const admin = harness("admin", { environment: "live" });
    await expect(admin.guard.canActivate(execution(Handlers.prototype.bound))).resolves.toBe(true);
    expect(admin.denials).toEqual([]);
  });

  it("refuses the OTA admin live on a tenant that is not live, for every role, and records the denial", async () => {
    for (const role of ["owner", "admin"] as const) {
      const notLive = harness(role, { environment: "live", tenantLive: false });
      await expect(notLive.guard.canActivate(execution(Handlers.prototype.bound))).rejects.toMatchObject({
        code: "ENVIRONMENT_NOT_ALLOWED",
        details: { environment: "live", environments: ["test"] },
      });
      expect([role, notLive.denials.map((denial) => denial.code)]).toEqual([
        role,
        ["ENVIRONMENT_NOT_ALLOWED"],
      ]);
      expect(notLive.tenantLookups).toEqual([TENANT_ID]);
    }
    // In test nothing is looked up, and a key's environment is the key's own.
    const test = harness("admin", { tenantLive: false });
    await expect(test.guard.canActivate(execution(Handlers.prototype.bound))).resolves.toBe(true);
    const liveKey = harness("admin", { environment: "live", tenantLive: false, caller: key(["console"]) });
    await expect(liveKey.guard.canActivate(execution(Handlers.prototype.bound))).resolves.toBe(true);
    expect([...test.tenantLookups, ...liveKey.tenantLookups]).toEqual([]);
    // A platform table that cannot be read is a 503, not a denial.
    const unreadable = harness("admin", { environment: "live", tenantUnreadable: true });
    await expect(unreadable.guard.canActivate(execution(Handlers.prototype.bound))).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(unreadable.denials).toEqual([]);
  });

  it("records a key-only call without console:automation as a denial of the key", async () => {
    const consoleKey = harness(undefined, { caller: key(["console"]) });

    await expect(consoleKey.guard.canActivate(execution(Handlers.prototype.bound))).rejects.toMatchObject({
      code: "SCOPE_NOT_ALLOWED",
      details: { requiredScope: "console:automation" },
    });
    expect(consoleKey.denials.map((denial) => denial.code)).toEqual(["SCOPE_NOT_ALLOWED"]);
  });

  it("leaves customer scope, unbound handlers and the missing staff member's 401 without a row", async () => {
    const customer = harness("agent", { consoleScope: false });
    await expect(customer.guard.canActivate(execution(Handlers.prototype.bound))).resolves.toBe(true);
    const unbound = harness("viewer");
    await expect(unbound.guard.canActivate(execution(Handlers.prototype.unbound))).resolves.toBe(true);
    const nobody = harness(undefined);
    await expect(nobody.guard.canActivate(execution(Handlers.prototype.bound))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect([...customer.denials, ...unbound.denials, ...nobody.denials]).toEqual([]);
  });
});
