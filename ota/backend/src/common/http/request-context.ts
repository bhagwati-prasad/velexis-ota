// The per-request context of the API (architecture §3, step 1). pino-http (nestjs-pino) has already read a valid
// `X-Request-Id` or generated one, returned it in the response header and bound it to every log line; nestjs-cls
// starts the AsyncLocalStorage context with that id (app.module.ts). This file is the typed view of that context for
// the HTTP pipeline: the request id, the OpenAPI operation the request was bound to, and whether the request is in
// console scope (the error filter shows the raw supplier issue only then, conventions §6), and the end user behind it
// (OBE-060: the IP and user agent the caller guard decided, which the console audit records). The tenancy module adds
// the caller and the tenant in its own context (OBE-011, OBE-012).
import { Injectable } from "@nestjs/common";
import type { OtaOperationId } from "@velexis/api-types/operations";
import { resolveRequestId } from "@velexis/logger";
import { ClsService } from "nestjs-cls";

/** The part of a request the id is read from: pino-http's `req.id`, else the header. */
export interface RequestIdSource {
  readonly id?: unknown;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * The request id of `req`: the one pino-http set from a valid `X-Request-Id` or generated (and returned in the
 * response header). The fallback (the header when valid, else a new UUID) only runs before pino-http, which the
 * middleware order of app.module.ts rules out.
 */
export function requestIdOf(req: RequestIdSource): string {
  return typeof req.id === "string" && req.id !== "" ? req.id : resolveRequestId(req.headers["x-request-id"]);
}

/** `x-scope` of an operation: who may call it (the OTA document). */
export type OperationScope = "customer" | "console" | "both";

/**
 * The person behind a request (OADR-0009 point 8): the IP address and user agent that rate limits, sessions and the
 * console audit (`staff_actions`) attribute it to. The caller guard decides them (common/auth/caller.guard.ts): the OTA
 * admin's forwarded staff member, a secret key's forwarded visitor, or the connection.
 */
export interface EndUser {
  /** An IPv4 or IPv6 address, or the connection's address as Express gives it. */
  readonly ip: string;
  /** At most 512 characters, or `null` when the request names none. */
  readonly userAgent: string | null;
}

const OPERATION_KEY = "http.operationId";
const CONSOLE_SCOPE_KEY = "http.consoleScope";
const END_USER_KEY = "http.endUser";

@Injectable()
export class RequestContext {
  constructor(private readonly cls: ClsService) {}

  /** True inside a request (the context middleware ran). */
  isActive(): boolean {
    return this.cls.isActive();
  }

  /** The request id of the current request, or `undefined` outside one. */
  requestId(): string | undefined {
    return this.cls.isActive() ? this.cls.getId() : undefined;
  }

  /**
   * Records the OpenAPI operation the request was bound to (the validation interceptor). An operation whose `x-scope`
   * is `console` puts the request in console scope; for `both`, the guard that classifies the caller decides
   * (`markConsoleScope`).
   */
  setOperation(operationId: OtaOperationId, scope: OperationScope | null): void {
    if (!this.cls.isActive()) {
      return;
    }
    this.cls.set(OPERATION_KEY, operationId);
    if (scope === "console") {
      this.cls.set(CONSOLE_SCOPE_KEY, true);
    }
  }

  /** The operation of the current request, once the validation interceptor bound it. */
  operationId(): OtaOperationId | undefined {
    if (!this.cls.isActive()) {
      return undefined;
    }
    const value: unknown = this.cls.get(OPERATION_KEY);
    return typeof value === "string" ? (value as OtaOperationId) : undefined;
  }

  /** Puts the current request in console scope: OTA staff, or a secret key used for a console operation. */
  markConsoleScope(): void {
    if (this.cls.isActive()) {
      this.cls.set(CONSOLE_SCOPE_KEY, true);
    }
  }

  /** True when the request is in console scope; customer scope (the default) never sees supplier details. */
  isConsoleScope(): boolean {
    return this.cls.isActive() && this.cls.get(CONSOLE_SCOPE_KEY) === true;
  }

  /** Records the end user of the current request (the caller guard); outside a request it does nothing. */
  setEndUser(endUser: EndUser): void {
    if (this.cls.isActive()) {
      this.cls.set(END_USER_KEY, Object.freeze({ ip: endUser.ip, userAgent: endUser.userAgent }));
    }
  }

  /** The end user of the current request, or `undefined` before the caller guard ran or outside a request. */
  endUser(): EndUser | undefined {
    if (!this.cls.isActive()) {
      return undefined;
    }
    const value: unknown = this.cls.get(END_USER_KEY);
    return typeof value === "object" && value !== null ? (value as EndUser) : undefined;
  }
}
