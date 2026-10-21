// The scope guard's rules (OBE-013; architecture §3 step 7, ADR-0018 "Scope", the document's "Keys" and
// `X-Velexis-Scope`), against operations of the generated operations index, and the guard around them with a minimal
// execution context. The guard in the API's pipeline, with keys from PostgreSQL: test/integration/common.
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import { isAppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import type { CallerContext, EdgeCaller, KeyCaller } from "../../tenancy/caller-resolver";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";
import type { RequestContext } from "../http/request-context";
import { newId } from "../ids";
import {
  requestScope,
  ScopeGuard,
  scopedOperation,
  type RequestScope,
  type ScopedCaller,
  type ScopedOperation,
} from "./scope.guard";

const EDGE: EdgeCaller = { type: "edge", id: "edge", host: "demo.ota.example.com" };

function key(kind: KeyCaller["kind"], scopes: readonly string[] = []): KeyCaller {
  const keyId = newId("key");
  return { type: "key", id: keyId, keyId, kind, tenantId: newId("ten"), environment: "test", scopes };
}

const PUBLISHABLE = key("publishable");
const SECRET = key("secret");
const STOREFRONT_SECRET = key("secret", ["storefront"]);
const CONSOLE_SECRET = key("secret", ["console"]);
const AUTOMATION_READER = key("secret", ["console:automation", "bookings:read", "queues:read"]);
const AUTOMATION_QUEUES = key("secret", ["console:automation", "queues:read"]);

/** The outcome of `requestScope`: the scope, or the code, status and details of the refusal. */
function outcome(
  operationId: OtaOperationId,
  caller: ScopedCaller,
  requested?: string,
): RequestScope | { code: string; status: number; details: unknown } {
  try {
    return requestScope(scopedOperation(operationId), caller, requested);
  } catch (error) {
    if (!isAppError(error)) {
      throw error;
    }
    return { code: error.code, status: error.status, details: error.details };
  }
}

const scopeRefused = (reason: string) => ({ code: "SCOPE_NOT_ALLOWED", status: 403, details: { reason } });
const automationRequired = {
  code: "SCOPE_NOT_ALLOWED",
  status: 403,
  details: { requiredScope: "console:automation" },
};

describe("the operations index", () => {
  it("gives the guard each operation's x-scope, x-edge-only and x-permission [OBE-013]", () => {
    expect(scopedOperation("signIn")).toMatchObject({ scope: "customer", edgeOnly: false, permission: null });
    expect(scopedOperation("createFlightSearch")).toMatchObject({ scope: "both", edgeOnly: false });
    expect(scopedOperation("completeCheckoutWithAirlineCard")).toMatchObject({
      scope: "customer",
      edgeOnly: true,
    });
    expect(scopedOperation("consoleListBookings")).toMatchObject({
      scope: "console",
      permission: "bookings:read",
    });
    expect(() => scopedOperation("noSuchOperation" as OtaOperationId)).toThrow(
      /no operation "noSuchOperation"/,
    );
  });

  it("knows a scope for every operation of the OTA document", () => {
    const unscoped = otaOperations.filter(
      (operation) =>
        !operation.internal && !["customer", "both", "console"].includes(String(operation.scope)),
    );

    expect(unscoped.map((operation) => operation.operationId)).toEqual([]);
  });

  // The x-internal operations (the Stripe webhook receivers since OBE-039) have `x-scope: internal`, as in the platform
  // document: their anonymous caller is left alone by the guard, and a request that brings a credential is refused.
  it("gives every x-internal operation the scope internal, which no credential reaches [OBE-039]", () => {
    const internal = otaOperations.filter((operation) => operation.internal);

    expect(internal.map((operation) => [operation.operationId, operation.scope])).toEqual([
      ["receiveStripeVelexisWebhook", "internal"],
    ]);
    for (const caller of [EDGE, PUBLISHABLE, SECRET, AUTOMATION_READER]) {
      expect(() => requestScope(scopedOperation("receiveStripeVelexisWebhook"), caller, undefined)).toThrow(
        expect.objectContaining({ code: "SCOPE_NOT_ALLOWED", details: { reason: "no_scope" } }),
      );
    }
  });
});

describe("customer operations", () => {
  it("accept the edge and pk_ and sk_ keys of every key scope, in customer scope [OBE-013]", () => {
    for (const caller of [EDGE, PUBLISHABLE, SECRET, STOREFRONT_SECRET, CONSOLE_SECRET, AUTOMATION_READER]) {
      expect(outcome("signIn", caller)).toBe("customer");
      expect(outcome("signIn", caller, "customer")).toBe("customer");
    }
  });

  it("refuse X-Velexis-Scope: console from any caller", () => {
    for (const caller of [EDGE, PUBLISHABLE, SECRET, AUTOMATION_READER]) {
      expect(outcome("signIn", caller, "console")).toEqual(scopeRefused("console_scope_requested"));
    }
  });
});

describe("edge-only operations (x-edge-only)", () => {
  it("accept the edge and refuse every key with 403 SCOPE_NOT_ALLOWED [OBE-013] [OF-05 AC2 groundwork]", () => {
    expect(outcome("completeCheckoutWithAirlineCard", EDGE)).toBe("customer");
    for (const caller of [PUBLISHABLE, SECRET, STOREFRONT_SECRET, AUTOMATION_READER]) {
      expect(outcome("completeCheckoutWithAirlineCard", caller)).toEqual(scopeRefused("edge_only"));
    }
  });
});

describe("operations of both scopes", () => {
  it("run in customer scope for every caller by default, a secret key included", () => {
    for (const caller of [EDGE, PUBLISHABLE, SECRET, STOREFRONT_SECRET, AUTOMATION_READER]) {
      expect(outcome("createFlightSearch", caller)).toBe("customer");
      expect(outcome("createFlightSearch", caller, "customer")).toBe("customer");
    }
  });

  it("refuse X-Velexis-Scope: console from the edge, a pk_ key and secret keys without console:automation", () => {
    expect(outcome("createFlightSearch", EDGE, "console")).toEqual(scopeRefused("console_scope_requested"));
    expect(outcome("createFlightSearch", PUBLISHABLE, "console")).toEqual(
      scopeRefused("console_scope_requested"),
    );
    expect(outcome("createFlightSearch", STOREFRONT_SECRET, "console")).toEqual(
      scopeRefused("storefront_key"),
    );
    expect(outcome("createFlightSearch", SECRET, "console")).toEqual(automationRequired);
    expect(outcome("createFlightSearch", CONSOLE_SECRET, "console")).toEqual(automationRequired);
  });

  it("run in console scope for a console:automation key that asks for it", () => {
    expect(outcome("createFlightSearch", AUTOMATION_QUEUES, "console")).toBe("console");
  });
});

describe("console operations", () => {
  it("refuse the edge, pk_ keys and storefront keys with 403 SCOPE_NOT_ALLOWED [OBE-013]", () => {
    expect(outcome("consoleListBookings", EDGE)).toEqual(scopeRefused("console_operation"));
    expect(outcome("consoleListBookings", PUBLISHABLE)).toEqual(scopeRefused("console_operation"));
    expect(outcome("consoleListBookings", STOREFRONT_SECRET)).toEqual(scopeRefused("storefront_key"));
  });

  it("need console:automation from a secret key without a staff token (staff tokens join with OBE-060)", () => {
    expect(outcome("consoleListBookings", SECRET)).toEqual(automationRequired);
    expect(outcome("consoleListBookings", CONSOLE_SECRET)).toEqual(automationRequired);
  });

  it("give a console:automation key exactly the permissions listed on it", () => {
    expect(outcome("consoleListBookings", AUTOMATION_READER)).toBe("console");
    expect(outcome("consoleListQueue", AUTOMATION_QUEUES)).toBe("console");
    expect(outcome("consoleListBookings", AUTOMATION_QUEUES)).toEqual({
      code: "FORBIDDEN",
      status: 403,
      details: { requiredPermission: "bookings:read" },
    });
    // x-permission "none": the staff session operations need no permission.
    expect(outcome("consoleGetMe", AUTOMATION_QUEUES)).toBe("console");
  });

  it("let every secret key not scoped storefront reach the four staff-session operations (x-permission none)", () => {
    // console.auth.signIn is how a console backend gets its staff token: "a publishable key, or a secret key scoped
    // storefront → 403 SCOPE_NOT_ALLOWED" (the document); the portal token, refresh token or staff session is checked
    // by the staff session guards (OBE-059).
    for (const operationId of [
      "consoleSignIn",
      "consoleRefreshSession",
      "consoleSignOut",
      "consoleGetMe",
    ] as const) {
      expect(scopedOperation(operationId).permission).toBe("none");
      for (const caller of [SECRET, CONSOLE_SECRET, AUTOMATION_QUEUES]) {
        expect([operationId, outcome(operationId, caller)]).toEqual([operationId, "console"]);
      }
      expect(outcome(operationId, STOREFRONT_SECRET)).toEqual(scopeRefused("storefront_key"));
      expect(outcome(operationId, PUBLISHABLE)).toEqual(scopeRefused("console_operation"));
      expect(outcome(operationId, EDGE)).toEqual(scopeRefused("console_operation"));
    }
  });

  it("stay console scope whatever X-Velexis-Scope says", () => {
    expect(outcome("consoleListBookings", AUTOMATION_READER, "customer")).toBe("console");
  });
});

describe("the OTA admin's service caller (OBE-060)", () => {
  const SERVICE: ScopedCaller = { type: "service", id: "service" };

  it("runs console operations in console scope and refuses every other operation [OBE-060 AC1]", () => {
    for (const operationId of ["consoleListBookings", "consoleGetMe", "consoleSignIn"] as const) {
      expect(outcome(operationId, SERVICE)).toBe("console");
    }
    for (const operationId of ["signIn", "listAirlines", "createFlightSearch"] as const) {
      expect(outcome(operationId, SERVICE)).toEqual(scopeRefused("service_console_only"));
      expect(outcome(operationId, SERVICE, "console")).toEqual(scopeRefused("service_console_only"));
    }
    expect(outcome("completeCheckoutWithAirlineCard", SERVICE)).toEqual(scopeRefused("edge_only"));
  });
});

describe("secret keys with a staff token (OBE-060)", () => {
  it("run console operations in console scope for a console or unscoped key; the role decides later", () => {
    for (const caller of [SECRET, CONSOLE_SECRET, AUTOMATION_QUEUES]) {
      expect(
        requestScope(scopedOperation("consoleCreateMarkupRule"), caller, undefined, { staffToken: true }),
      ).toBe("console");
    }
    expect(() =>
      requestScope(scopedOperation("consoleListBookings"), STOREFRONT_SECRET, undefined, {
        staffToken: true,
      }),
    ).toThrow(expect.objectContaining({ code: "SCOPE_NOT_ALLOWED", details: { reason: "storefront_key" } }));
    // A bearer on a shared operation is no staff token: the key-only rules stay.
    expect(() =>
      requestScope(scopedOperation("createFlightSearch"), CONSOLE_SECRET, "console", { staffToken: true }),
    ).toThrow(expect.objectContaining({ details: { requiredScope: "console:automation" } }));
  });

  it("leave a key-only call's permission and, on console operations, its console:automation scope to the permission guard when asked to", () => {
    expect(
      requestScope(scopedOperation("consoleListBookings"), AUTOMATION_QUEUES, undefined, {
        deferPermission: true,
      }),
    ).toBe("console");
    // The permission guard answers it with the same 403 SCOPE_NOT_ALLOWED and audits it (permission.guard.test.ts).
    expect(
      requestScope(scopedOperation("consoleListBookings"), CONSOLE_SECRET, undefined, {
        deferPermission: true,
      }),
    ).toBe("console");
    // Without the deferral, and on a shared operation in any case, this guard refuses it itself.
    expect(() => requestScope(scopedOperation("consoleListBookings"), CONSOLE_SECRET, undefined)).toThrow(
      expect.objectContaining({ details: { requiredScope: "console:automation" } }),
    );
    expect(() =>
      requestScope(scopedOperation("createFlightSearch"), CONSOLE_SECRET, "console", {
        deferPermission: true,
      }),
    ).toThrow(expect.objectContaining({ details: { requiredScope: "console:automation" } }));
    // A storefront key never reaches the permission guard.
    expect(() =>
      requestScope(scopedOperation("consoleListBookings"), STOREFRONT_SECRET, undefined, {
        deferPermission: true,
      }),
    ).toThrow(expect.objectContaining({ details: { reason: "storefront_key" } }));
  });
});

describe("an operation without x-scope", () => {
  it("is refused for every caller (none exists today)", () => {
    const unscoped: ScopedOperation = {
      operationId: "unscoped",
      scope: null,
      edgeOnly: false,
      permission: null,
    };
    for (const caller of [EDGE, PUBLISHABLE, AUTOMATION_READER]) {
      expect(() => requestScope(unscoped, caller, undefined)).toThrow(
        expect.objectContaining({ code: "SCOPE_NOT_ALLOWED", details: { reason: "no_scope" } }),
      );
    }
  });
});

describe("ScopeGuard", () => {
  class Handlers {
    bound(): void {}
    unbound(): void {}
  }
  Reflect.defineMetadata(OPENAPI_OPERATION, "consoleListBookings", Handlers.prototype.bound);

  /** A guard over a fixed caller, recording whether it put the request in console scope. */
  function guard(caller: ReturnType<CallerContext["get"]>) {
    const marks: string[] = [];
    const callers = { get: () => caller } as unknown as CallerContext;
    const context = { markConsoleScope: () => marks.push("console") } as unknown as RequestContext;
    return { guard: new ScopeGuard(new Reflector(), callers, context), marks };
  }

  function execution(handler: () => void, headers: Record<string, string> = {}): ExecutionContext {
    return {
      getType: () => "http",
      getHandler: () => handler,
      getClass: () => Handlers,
      switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
  }

  it("marks the request console scope when the operation runs in it", () => {
    const { guard: scopeGuard, marks } = guard(AUTOMATION_READER);

    expect(scopeGuard.canActivate(execution(Handlers.prototype.bound))).toBe(true);
    expect(marks).toEqual(["console"]);
  });

  it("refuses with the rule's error, and leaves unbound handlers and the anonymous caller alone", () => {
    expect(() => guard(EDGE).guard.canActivate(execution(Handlers.prototype.bound))).toThrow(
      expect.objectContaining({ code: "SCOPE_NOT_ALLOWED" }),
    );
    const anonymous = guard({ type: "anonymous", id: "anonymous" });
    expect(anonymous.guard.canActivate(execution(Handlers.prototype.bound))).toBe(true);
    const unbound = guard(EDGE);
    expect(unbound.guard.canActivate(execution(Handlers.prototype.unbound))).toBe(true);
    expect([...anonymous.marks, ...unbound.marks]).toEqual([]);
  });

  it("reads X-Velexis-Scope from the request", () => {
    Reflect.defineMetadata(OPENAPI_OPERATION, "createFlightSearch", Handlers.prototype.unbound);
    try {
      const { guard: scopeGuard, marks } = guard(AUTOMATION_QUEUES);
      expect(scopeGuard.canActivate(execution(Handlers.prototype.unbound))).toBe(true);
      expect(marks).toEqual([]);
      expect(
        scopeGuard.canActivate(execution(Handlers.prototype.unbound, { "x-velexis-scope": "console" })),
      ).toBe(true);
      expect(marks).toEqual(["console"]);
    } finally {
      Reflect.deleteMetadata(OPENAPI_OPERATION, Handlers.prototype.unbound);
    }
  });

  it("throws when the caller guard has not run", () => {
    expect(() => guard(undefined).guard.canActivate(execution(Handlers.prototype.bound))).toThrow(
      /CallerGuard must run first/,
    );
  });
});
