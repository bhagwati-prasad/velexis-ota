// Route parity (ADR-0006 "Checks in CI", OBE-010): the API's routes and the OTA document's operations match one to one.
//
// - Every operation has exactly one handler, or one entry in pending-operations.ts (answered 501), never both.
// - Every handler is the handler of an operation (same method and path), or one of UNDOCUMENTED_ROUTES.
// - A handler that names an operation with @OpenApiOperation names the one of its route; the handler of an operation
//   that is not `x-internal` names it (so its requests are validated).
// - Every pending entry names an operation and the plan task of the operation's milestone (or "deferred"), and its
//   route answers 501 NOT_IMPLEMENTED with `details.milestone`.
// - No route hides another: Express tries routes in registration order, so a route with a parameter registered before
//   one with a literal segment in the same place (a pending 501 route of HttpModule before the handler of a module
//   imported after it, say) would answer the literal route's requests.
//
// The routes are read from the application itself (its controllers and their Nest route metadata, and the order of
// Express' router), as main.ts builds it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Controller, Get, RequestMethod, type INestApplication, type Type } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { MetadataScanner, ModulesContainer } from "@nestjs/core";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_OPERATION, OpenApiOperation } from "../../src/common/http/openapi-operation.decorator";
import {
  compareRoutePaths,
  createNotImplementedController,
  PENDING_OPERATION,
  pendingRoutes,
  toRoutePath,
} from "../../src/common/http/not-implemented.controller";
import { loadOpenApiDocument } from "../../src/common/http/openapi-validation.interceptor";
import { PENDING_OPERATIONS, UNDOCUMENTED_ROUTES } from "../../src/common/http/pending-operations";
import { APP_DIR } from "../../src/config";
import { edgeHeaders } from "../helpers/api-env";
import { createTestApp, type TestApp } from "../support/create-test-app";

/** One route of a controller method, with the path written as in the document (`/v1/bookings/{bookingId}`). */
interface HandlerRoute {
  readonly handler: string;
  readonly method: string;
  readonly path: string;
  /** `@OpenApiOperation(…)` of the handler. */
  readonly operationId?: string | undefined;
  /** The pending operation a 501 handler of the not-implemented controller answers for. */
  readonly pending?: string | undefined;
}

interface DocumentOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly internal: boolean;
}

interface ParityInput {
  readonly operations: readonly DocumentOperation[];
  readonly routes: readonly HandlerRoute[];
  readonly pending: Readonly<Record<string, string | undefined>>;
  readonly undocumented: readonly string[];
}

const routeKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

/** `a`, `/a/`, `["a", "b"]` → normalised paths with a leading slash and no trailing one. */
function pathsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value ?? "/"];
  return list.map((item) => `/${String(item)}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1"));
}

function joinPaths(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

/** Every route of the application's controllers, from the Nest metadata the router registers. */
function collectRoutes(app: INestApplication): HandlerRoute[] {
  const scanner = new MetadataScanner();
  const routes: HandlerRoute[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const metatype = wrapper.metatype as Type<unknown> | null;
      if (metatype === null || typeof metatype !== "function") {
        continue;
      }
      const prototype = metatype.prototype as Record<string, unknown>;
      for (const prefix of pathsOf(Reflect.getMetadata(PATH_METADATA, metatype))) {
        for (const name of scanner.getAllMethodNames(prototype)) {
          const handler = prototype[name] as object;
          const paths: unknown = Reflect.getMetadata(PATH_METADATA, handler);
          if (paths === undefined) {
            continue;
          }
          const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
          for (const path of pathsOf(paths)) {
            routes.push({
              handler: `${metatype.name}.${name}`,
              method,
              path: joinPaths(prefix, path).replace(/:([A-Za-z0-9_]+)/g, "{$1}"),
              operationId: Reflect.getMetadata(OPENAPI_OPERATION, handler) as string | undefined,
              pending: Reflect.getMetadata(PENDING_OPERATION, handler) as string | undefined,
            });
          }
        }
      }
    }
  }
  return routes;
}

/** Every way the routes, the document and the allow-lists disagree; empty when they match. */
function routeParityProblems(input: ParityInput): string[] {
  const problems: string[] = [];
  const byRoute = new Map(
    input.operations.map((operation) => [routeKey(operation.method, operation.path), operation]),
  );
  const byId = new Map(input.operations.map((operation) => [operation.operationId, operation]));
  const handlers = new Map<string, HandlerRoute[]>();

  for (const route of input.routes) {
    const key = routeKey(route.method, route.path);
    const operation = byRoute.get(key);
    if (route.pending !== undefined) {
      const pendingOperation = byId.get(route.pending);
      if (
        pendingOperation === undefined ||
        routeKey(pendingOperation.method, pendingOperation.path) !== key
      ) {
        problems.push(`the 501 route ${key} is not the route of ${route.pending}`);
      }
      if (input.pending[route.pending] === undefined) {
        problems.push(`the 501 route ${key} of ${route.pending} has no entry in pending-operations.ts`);
      }
      continue;
    }
    if (route.operationId !== undefined && route.operationId !== operation?.operationId) {
      const bound = byId.get(route.operationId);
      const where =
        bound === undefined ? "an operation the document lacks" : routeKey(bound.method, bound.path);
      problems.push(`${route.handler} (${key}) names ${route.operationId}, whose route is ${where}`);
    }
    if (operation === undefined) {
      if (!input.undocumented.includes(key)) {
        problems.push(`${route.handler} (${key}) has no operation in the OTA document`);
      }
      continue;
    }
    if (route.operationId === undefined && !operation.internal) {
      problems.push(`${route.handler} (${key}) handles ${operation.operationId} without @OpenApiOperation`);
    }
    handlers.set(operation.operationId, [...(handlers.get(operation.operationId) ?? []), route]);
  }

  for (const operation of input.operations) {
    const own = handlers.get(operation.operationId) ?? [];
    const pending = input.pending[operation.operationId] !== undefined;
    if (own.length === 0 && !pending) {
      problems.push(`${operation.operationId} has neither a handler nor a pending entry`);
    } else if (own.length > 0 && pending) {
      problems.push(`${operation.operationId} has a handler (${own[0]?.handler}) and a pending entry`);
    } else if (own.length > 1) {
      problems.push(`${operation.operationId} has ${own.length} handlers`);
    }
    if (pending && !input.routes.some((route) => route.pending === operation.operationId)) {
      problems.push(`${operation.operationId} is pending but its 501 route is not registered`);
    }
  }
  for (const operationId of Object.keys(input.pending)) {
    if (!byId.has(operationId)) {
      problems.push(`pending-operations.ts lists ${operationId}, which the OTA document does not have`);
    }
  }
  for (const key of input.undocumented) {
    if (byRoute.has(key)) {
      problems.push(
        `${key} is in UNDOCUMENTED_ROUTES but the document has it (${byRoute.get(key)?.operationId})`,
      );
    }
    if (
      !input.routes.some((route) => route.pending === undefined && routeKey(route.method, route.path) === key)
    ) {
      problems.push(`${key} is in UNDOCUMENTED_ROUTES but no handler serves it`);
    }
  }
  return problems;
}

/** One route of Express' router: its method (`ALL` for every method) and its path written as in the document. */
interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
}

/** The routes of the application's Express router, in the order the router tries them. */
function registeredRoutes(app: INestApplication): RegisteredRoute[] {
  const instance = app.getHttpAdapter().getInstance() as { router?: { stack?: unknown } };
  const stack = instance.router?.stack;
  if (!Array.isArray(stack)) {
    throw new Error("Express' router stack is not readable");
  }
  const routes: RegisteredRoute[] = [];
  for (const layer of stack as Array<{ route?: { path?: unknown; methods?: Record<string, unknown> } }>) {
    const path = layer.route?.path;
    // Nest mounts the middleware of `forRoutes(...)` as wildcard routes (`/{*path}`) that pass every request on.
    if (typeof path !== "string" || path.includes("*")) {
      continue;
    }
    for (const method of Object.keys(layer.route?.methods ?? {})) {
      routes.push({
        method: method === "_all" ? "ALL" : method.toUpperCase(),
        path: path.replace(/:([A-Za-z0-9_]+)/g, "{$1}"),
      });
    }
  }
  return routes;
}

const isTemplateParameter = (segment: string): boolean => segment.startsWith("{");

/** True when one URL can match both templates: as many segments, each one equal (ignoring case) or a parameter. */
function overlap(a: string, b: string): boolean {
  const left = a.toLowerCase().split("/");
  const right = b.toLowerCase().split("/");
  return (
    left.length === right.length &&
    left.every(
      (segment, index) =>
        segment === right[index] || isTemplateParameter(segment) || isTemplateParameter(right[index] ?? ""),
    )
  );
}

/** Every route that an earlier route of the same method answers for: a parameter where it has a literal segment. */
function shadowedRoutes(routes: readonly RegisteredRoute[]): string[] {
  const problems: string[] = [];
  routes.forEach((later, index) => {
    for (const earlier of routes.slice(0, index)) {
      const sameMethod =
        earlier.method === later.method || earlier.method === "ALL" || later.method === "ALL";
      if (
        sameMethod &&
        overlap(earlier.path, later.path) &&
        compareRoutePaths(later.path, earlier.path) < 0
      ) {
        problems.push(
          `${routeKey(later.method, later.path)} is registered after ${routeKey(earlier.method, earlier.path)}, which answers its requests`,
        );
      }
    }
  });
  return problems;
}

const DOCUMENT_OPERATIONS: readonly DocumentOperation[] = otaOperations.map((operation) => ({
  operationId: operation.operationId,
  method: operation.method,
  path: operation.path,
  internal: operation.internal,
}));

/** A concrete URL of a path template. */
const concrete = (path: string): string => path.replace(/\{[^}]+\}/g, "x1");

/** A request as the hosted storefront sends it: with the edge credential, which the caller guard accepts (OBE-011). */
function send(server: TestApp["server"], method: string, url: string): request.Test {
  const agent = request(server);
  switch (method) {
    case "get":
      return agent.get(url).set(edgeHeaders());
    case "post":
      return agent.post(url).set(edgeHeaders());
    case "put":
      return agent.put(url).set(edgeHeaders());
    case "patch":
      return agent.patch(url).set(edgeHeaders());
    case "delete":
      return agent.delete(url).set(edgeHeaders());
    default:
      throw new Error(`no request helper for ${method}`);
  }
}

let api: TestApp;
let routes: HandlerRoute[];

// Building the app parses the OpenAPI document and compiles its request validators (the HTTP module's
// OpenApiDocument provider): a few seconds alone, several times longer on a machine that runs every package's tests
// at once, so the hook has its own budget rather than the 10 s default.
beforeAll(async () => {
  api = await createTestApp();
  routes = collectRoutes(api.app);
}, 60_000);

afterAll(async () => {
  await api.close();
});

describe("route parity", () => {
  it("gives every document operation exactly one handler or pending entry, and every handler an operation [OBE-010 AC3]", () => {
    expect(routes.length).toBeGreaterThanOrEqual(otaOperations.length);
    expect(
      routeParityProblems({
        operations: DOCUMENT_OPERATIONS,
        routes,
        pending: PENDING_OPERATIONS,
        undocumented: UNDOCUMENTED_ROUTES,
      }),
    ).toEqual([]);
  });

  it("fails for a handler without an operation [OBE-010 AC3]", async () => {
    @Controller("v1/unlisted")
    class UnlistedController {
      @Get()
      list(): object {
        return {};
      }
    }
    const probe = await createTestApp({ controllers: [UnlistedController] });
    try {
      const problems = routeParityProblems({
        operations: DOCUMENT_OPERATIONS,
        routes: collectRoutes(probe.app),
        pending: PENDING_OPERATIONS,
        undocumented: UNDOCUMENTED_ROUTES,
      });

      expect(problems).toEqual([
        "UnlistedController.list (GET /v1/unlisted) has no operation in the OTA document",
      ]);
    } finally {
      await probe.close();
    }
  });

  it("fails for an operation with neither a handler nor a pending entry [OBE-010 AC3]", () => {
    const { getStorefront: _removed, ...pending } = PENDING_OPERATIONS;

    const problems = routeParityProblems({
      operations: DOCUMENT_OPERATIONS,
      routes: routes.filter((route) => route.pending !== "getStorefront"),
      pending,
      undocumented: UNDOCUMENTED_ROUTES,
    });

    expect(problems).toEqual(["getStorefront has neither a handler nor a pending entry"]);
  });

  it("fails for a handler next to a pending entry, two handlers, a handler of another route and a missing binding", async () => {
    @Controller("v1")
    class MisboundController {
      // Implemented while still pending.
      @Get("storefront")
      @OpenApiOperation("getStorefront")
      storefront(): object {
        return {};
      }

      // Two handlers of listSavedTravelers, one without @OpenApiOperation. Deferred operations, which stay pending
      // through the MVP: the application has no handler of its own for them.
      @Get("account/saved-travelers")
      @OpenApiOperation("listSavedTravelers")
      savedTravelers(): object {
        return {};
      }

      @Get("account/saved-travelers")
      savedTravelersAgain(): object {
        return {};
      }

      // Names an operation whose route is another one.
      @Get("account/preferences")
      @OpenApiOperation("resolveStorefrontHost")
      preferences(): object {
        return {};
      }
    }
    const probe = await createTestApp({ controllers: [MisboundController] });
    try {
      const {
        listSavedTravelers: _savedTravelers,
        getAccountPreferences: _preferences,
        ...pending
      } = PENDING_OPERATIONS;
      const problems = routeParityProblems({
        operations: DOCUMENT_OPERATIONS,
        routes: collectRoutes(probe.app).filter(
          (route) => route.pending !== "listSavedTravelers" && route.pending !== "getAccountPreferences",
        ),
        pending: { ...pending, notAnOperation: "OBE-999" },
        undocumented: [...UNDOCUMENTED_ROUTES, "GET /v1/nowhere"],
      });

      expect(problems.sort()).toEqual(
        [
          "MisboundController.savedTravelersAgain (GET /v1/account/saved-travelers) handles listSavedTravelers without @OpenApiOperation",
          "MisboundController.preferences (GET /v1/account/preferences) names resolveStorefrontHost, whose route is GET /v1/storefront/resolve",
          "getStorefront has a handler (MisboundController.storefront) and a pending entry",
          "listSavedTravelers has 2 handlers",
          "pending-operations.ts lists notAnOperation, which the OTA document does not have",
          "GET /v1/nowhere is in UNDOCUMENTED_ROUTES but no handler serves it",
        ].sort(),
      );
    } finally {
      await probe.close();
    }
  });

  it("registers no route after a route of the same method that answers its requests", () => {
    const registered = registeredRoutes(api.app);

    // Every handler of the application, and nothing else, is a route of the router.
    expect(registered.map((route) => routeKey(route.method, route.path)).sort()).toEqual(
      routes.map((route) => routeKey(route.method, route.path)).sort(),
    );
    expect(shadowedRoutes(registered)).toEqual([]);
  });

  it("fails for a route registered after a route with a parameter where it has a literal segment", async () => {
    // Registered before the application's routes, so before the 501 route of consoleFindBookingByRecordLocator.
    @Controller("v1/console/bookings")
    class EarlyController {
      @Get(":bookingId")
      get(): object {
        return { answeredBy: "consoleGetBooking" };
      }
    }
    const probe = await createTestApp({ controllers: [EarlyController] });
    try {
      const hidden = await send(probe.server, "get", "/v1/console/bookings/by-record-locator");

      expect(hidden.body).toEqual({ answeredBy: "consoleGetBooking" });
      expect(shadowedRoutes(registeredRoutes(probe.app))).toEqual([
        "GET /v1/console/bookings/by-record-locator is registered after GET /v1/console/bookings/{bookingId}, which answers its requests",
      ]);
    } finally {
      await probe.close();
    }

    const literal = { method: "GET", path: "/v1/console/bookings/by-record-locator" };
    const parameter = { method: "GET", path: "/v1/console/bookings/{bookingId}" };
    expect(
      shadowedRoutes([
        literal,
        parameter,
        { method: "POST", path: "/v1/console/bookings/imports" },
        { method: "GET", path: "/v1/console/bookings/{bookingId}/events" },
      ]),
    ).toEqual([]);
  });

  it("keeps the routes of UNDOCUMENTED_ROUTES out of the document", () => {
    for (const key of UNDOCUMENTED_ROUTES) {
      expect(
        DOCUMENT_OPERATIONS.map((operation) => routeKey(operation.method, operation.path)),
      ).not.toContain(key);
    }
  });
});

describe("pending operations", () => {
  it("answers 501 NOT_IMPLEMENTED with details.milestone on every not-yet-implemented operation [OBE-010 AC3]", async () => {
    const errorResponse = loadOpenApiDocument().compile({ $ref: "#/components/schemas/ErrorResponse" });
    const pending = Object.keys(PENDING_OPERATIONS) as OtaOperationId[];
    expect(pending.length).toBeGreaterThan(0);

    for (const operationId of pending) {
      const operation = otaOperations.find((entry) => entry.operationId === operationId);
      expect(operation, operationId).toBeDefined();
      if (operation === undefined) {
        continue;
      }
      const res = await send(api.server, operation.method, concrete(operation.path));

      expect([operationId, res.status]).toEqual([operationId, 501]);
      expect(res.body).toEqual({
        error: {
          code: "NOT_IMPLEMENTED",
          message: "The operation is part of the contract but not available yet (details.milestone).",
          status: 501,
          requestId: res.headers["x-request-id"],
          details: { milestone: operation.milestone, operationId },
        },
      });
      expect(errorResponse(res.body), operationId).toBe(true);
    }
  });

  it("names the plan task of the operation's milestone, or deferred for a deferred operation", () => {
    const plan = readFileSync(join(APP_DIR, "..", "docs", "plans", "agent-tasks.md"), "utf8");
    const milestones = new Map<string, string>();
    for (const block of plan.split(/\n(?=### )/)) {
      const id = /^### (OBE-\d{3}) · /.exec(block)?.[1];
      const milestone = /^- \*\*Milestone:\*\* (\S+)$/m.exec(block)?.[1];
      if (id !== undefined && milestone !== undefined) {
        milestones.set(id, milestone);
      }
    }

    for (const [operationId, task] of Object.entries(PENDING_OPERATIONS)) {
      const milestone = otaOperations.find((operation) => operation.operationId === operationId)?.milestone;
      if (milestone === "deferred") {
        expect([operationId, task]).toEqual([operationId, "deferred"]);
      } else {
        expect([operationId, task, milestones.get(String(task))]).toEqual([operationId, task, milestone]);
      }
    }
  });

  it("registers a literal segment before a parameter in the same place", () => {
    expect(toRoutePath("/v1/bookings/{bookingId}/documents/{documentId}")).toBe(
      "/v1/bookings/:bookingId/documents/:documentId",
    );
    expect(
      compareRoutePaths("/v1/console/bookings/by-record-locator", "/v1/console/bookings/{bookingId}"),
    ).toBe(-1);
    expect(compareRoutePaths("/v1/console/bookings/{bookingId}", "/v1/console/bookings/imports")).toBe(1);
    expect(compareRoutePaths("/v1/a", "/v1/b")).toBe(0);
    const order = routes.filter((route) => route.pending !== undefined).map((route) => route.path);
    expect(order.indexOf("/v1/console/bookings/by-record-locator")).toBeLessThan(
      order.indexOf("/v1/console/bookings/{bookingId}"),
    );
  });

  it("registers a literal segment first whatever routes lie between the two in document order", () => {
    // A comparator that only orders routes differing in a parameter, and calls every other pair equal, is not
    // transitive: with an unrelated route between them the sort can leave the parameter route first.
    const sorted = ["/v1/x/{id}", "/v1/y/items", "/v1/x/items"].sort(compareRoutePaths);
    expect(sorted.indexOf("/v1/x/items")).toBeLessThan(sorted.indexOf("/v1/x/{id}"));

    const controller = createNotImplementedController(
      pendingRoutes({
        consoleGetBooking: "OBE-061",
        consoleListCustomers: "OBE-066",
        consoleFindBookingByRecordLocator: "OBE-064",
      }),
    );
    const handlers = Object.getOwnPropertyNames(controller.prototype).filter(
      (name) => name !== "constructor",
    );

    expect(handlers.indexOf("consoleFindBookingByRecordLocator")).toBeLessThan(
      handlers.indexOf("consoleGetBooking"),
    );
  });
});
