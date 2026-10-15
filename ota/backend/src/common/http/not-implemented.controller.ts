// The routes of the operations that have no handler yet (pending-operations.ts): each answers
// `501 NOT_IMPLEMENTED` with `details.milestone` (the operation's `x-milestone`) and `details.operationId`, in the
// error envelope, so SDK methods of pending operations surface a typed error (scope.md §3). The controller is built
// from the allow-list and the operations index of @velexis/api-types: one handler per listed operation, on the
// document's method and path. Requests to these routes are not validated: there is nothing to hand them to.
//
// Express tries routes in registration order, so a route with a literal segment (`/v1/console/bookings/by-record-
// locator`) must come before a parameter in the same place (`/v1/console/bookings/{bookingId}`). The pending routes
// are registered in that order; the route-parity test sends a request to every pending route and checks that the 501
// names that route's operation, which also catches a handler of another module that shadows one, and reads the
// router's order to fail when a route of any module is registered after a route that answers its requests (a pending
// `{bookingId}` route before an implemented `by-record-locator` handler of a module imported after HttpModule).
import { Controller, RequestMapping, RequestMethod, SetMetadata, type Type } from "@nestjs/common";
import { otaOperations, type HttpMethod, type OtaOperationId } from "@velexis/api-types/operations";
import { AppError } from "@velexis/errors";
import { PENDING_OPERATIONS, type PendingTask } from "./pending-operations";

/** Metadata key on each handler of the controller: the pending operation it answers for. */
export const PENDING_OPERATION = "velexis:pending-operation";

/** Nest's request methods; Nest has no TRACE, which no operation uses. */
const REQUEST_METHODS: Readonly<Partial<Record<HttpMethod, RequestMethod>>> = {
  get: RequestMethod.GET,
  put: RequestMethod.PUT,
  post: RequestMethod.POST,
  delete: RequestMethod.DELETE,
  options: RequestMethod.OPTIONS,
  head: RequestMethod.HEAD,
  patch: RequestMethod.PATCH,
};

/** One route of a pending operation. */
export interface PendingRoute {
  readonly operationId: OtaOperationId;
  readonly method: HttpMethod;
  /** The document's path template, `/v1/bookings/{bookingId}`. */
  readonly path: string;
  /** The operation's `x-milestone` (`M2` … `M6` or `deferred`). */
  readonly milestone: string;
  readonly task: PendingTask;
}

/** A document path template as an Express route path: `{bookingId}` becomes `:bookingId`. */
export function toRoutePath(template: string): string {
  return template.replace(/\{([^}]+)\}/g, ":$1");
}

const isParameter = (segment: string): boolean => segment.startsWith("{") || segment.startsWith(":");

/**
 * Orders two path templates by their shape: segment by segment, a literal before a parameter, then the shorter path
 * first; templates of the same shape keep document order (stable sort). Two templates the router could confuse share
 * every segment before the first one where they differ, so there the literal one comes first. The order is total (a
 * comparator that called every other pair equal would not be transitive, and the sort could then leave a parameter
 * route before a literal one when an unrelated route lies between them).
 */
export function compareRoutePaths(a: string, b: string): number {
  const left = a.split("/").map(isParameter);
  const right = b.split("/").map(isParameter);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return Number(left[index]) - Number(right[index]);
    }
  }
  return left.length - right.length;
}

/** The routes of the allow-list, from the operations index; an id the document lacks fails here. */
export function pendingRoutes(
  pending: Readonly<Partial<Record<OtaOperationId, PendingTask>>> = PENDING_OPERATIONS,
): PendingRoute[] {
  return Object.entries(pending).map(([operationId, task]) => {
    const operation = otaOperations.find((entry) => entry.operationId === operationId);
    if (operation === undefined || task === undefined) {
      throw new Error(`pending-operations.ts lists ${operationId}, which the OTA document does not have`);
    }
    return {
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      milestone: operation.milestone ?? "deferred",
      task,
    };
  });
}

/** Builds a controller with one `501` handler per route, named after its operation. */
export function createNotImplementedController(routes: readonly PendingRoute[]): Type<unknown> {
  class NotImplementedController {}
  const prototype = NotImplementedController.prototype as object;
  const ordered = [...routes].sort((a, b) => compareRoutePaths(a.path, b.path));
  for (const route of ordered) {
    const method = REQUEST_METHODS[route.method];
    if (method === undefined) {
      throw new Error(`${route.operationId}: Nest cannot route the method ${route.method.toUpperCase()}`);
    }
    const details = { milestone: route.milestone, operationId: route.operationId };
    const handler = function notImplemented(): never {
      throw new AppError("NOT_IMPLEMENTED", { details });
    };
    Object.defineProperty(prototype, route.operationId, {
      value: handler,
      configurable: true,
      writable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(prototype, route.operationId) as PropertyDescriptor;
    RequestMapping({ path: toRoutePath(route.path), method })(prototype, route.operationId, descriptor);
    SetMetadata(PENDING_OPERATION, route.operationId)(prototype, route.operationId, descriptor);
  }
  Controller()(NotImplementedController);
  return NotImplementedController;
}

/** The controller of the current allow-list. */
export const NotImplementedController = createNotImplementedController(pendingRoutes());
