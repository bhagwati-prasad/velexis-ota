// The customer guard (OBE-031; architecture §3 step 8, ADR-0008, OADR-0006 points 1 and 5, OADR-0009): who the
// signed-in customer of a request is. It runs after the caller, tenant and scope guards and before the CSRF guard and
// the rate limits (`APP_GUARD` order of app.module.ts), on handlers bound to an operation of the OTA document.
//
// Which operations need a customer comes from the document itself, per caller, from each operation's `security`
// alternatives: for a key caller those with `apiKey`, for the storefront edge those with `storefrontEdge`.
//
//   every alternative of the caller has the customer's scheme   → required (getSession, account.*, changePassword)
//   some do                                                     → optional (flights.*, signOut, bookings.get, …)
//   none do                                                     → not read (signIn, storefront.get, console.*)
//
// The customer's credential depends on the caller, never both (OADR-0006 point 1):
//
//   - a key caller (`pk_`, `sk_`) sends `Authorization: Bearer <access token>` (`customerAuth`); cookies are ignored;
//   - the storefront edge sends the `__Host-vx_at` cookie (`customerCookie`); an `Authorization` header is ignored.
//
// A token that is presented must be valid, also on an optional operation: `401 TOKEN_EXPIRED` for an expired customer
// token of this tenant (the SDK in cookie mode then calls auth.refresh once and retries), `401 UNAUTHENTICATED` for
// anything else, a token of another tenant included (`tid` must equal the tenant the tenant guard resolved; OF-01
// AC2). A required operation without a token is `401 UNAUTHENTICATED`; an optional one goes on as a guest. Refusals are
// logged as `customer.token_refused` with the reason, never the token. One exception (OBE-033): on auth.signOut an
// expired token of this tenant counts as no token, because the document ends the session of the refresh token "when
// the access token has already expired" (`EXPIRED_TOKEN_AS_GUEST`); the guard records that it saw one
// (`CustomerContext.presentedExpiredToken`), and the handler answers `401 TOKEN_EXPIRED` itself when no refresh token
// comes with it either.
//
// A verified token makes the customer the request's actor (`TenantContext.setActor`, `customer`/`cus_…`) and puts
// `{customerId, sessionId, accessTokenExpiresAt}` into the request context (`CustomerContext`), where services read
// it. Tokens are stateless for their 15 minutes (ADR-0008 "Access tokens"): revoking a session stops its refresh
// token, and sign-out, password change and account deletion also clear the edge's cookies. One thing is checked on
// every request all the same (FIX-W29-SECURITY, ADR-0008's note of 2026-10-24): the token's customer must still be
// allowed to hold a session, neither deleted nor disabled (`CustomerAccess.mayAct`: a Redis key cached for a minute,
// revoked by account.delete, read from the database when missing or revoked or when Redis cannot answer). A token of
// such a customer is refused with `401 UNAUTHENTICATED` (logged with the reason `customer_inactive`), the answer
// account.* gives it (OBE-035), on every operation, an optional one included, but account.delete
// (`INACTIVE_CUSTOMER_OPERATIONS`): its idempotent replay answers the stored deletion to the customer that made it, so a
// client whose answer was lost learns that its account is deleted, and a new deletion is refused by the service with
// the same `401 UNAUTHENTICATED`.
//
// In console scope (the scope guard marked it: a `console:automation` key, later a staff token) the bearer token is a
// staff token, which the staff guards of OBE-059 and OBE-060 check; this guard leaves such requests alone.
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AppError } from "@velexis/errors";
import type { Request } from "express";
import { ClsService } from "nestjs-cls";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { CustomerAccess } from "../../identity/customer-access";
import { bearerTokenOf, TokenService } from "../../identity/token.service";
import { CallerContext } from "../../tenancy/caller-resolver";
import { TenantContext } from "../../tenancy/tenant-context";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";
import { OpenApiDocument } from "../http/openapi-validation.interceptor";
import { RequestContext } from "../http/request-context";

/** The cookie of the edge's customer access token (OADR-0006 point 2; `STOREFRONT_COOKIES.accessToken`). */
export const CUSTOMER_ACCESS_COOKIE = "__Host-vx_at";

/** Whether an operation needs a signed-in customer, for one kind of caller. */
export type CustomerRequirement = "required" | "optional" | "none";

/** The callers that can present a customer token. */
export type CustomerCaller = "key" | "edge";

/** The requirement of an operation for each kind of caller. */
export type CustomerRequirements = Readonly<Record<CustomerCaller, CustomerRequirement>>;

/** The security schemes of the document that identify each kind of caller and its customer. */
export const CUSTOMER_SECURITY_SCHEMES: Readonly<
  Record<CustomerCaller, { readonly caller: string; readonly customer: string }>
> = Object.freeze({
  key: Object.freeze({ caller: "apiKey", customer: "customerAuth" }),
  edge: Object.freeze({ caller: "storefrontEdge", customer: "customerCookie" }),
});

const NONE: CustomerRequirements = Object.freeze({ key: "none", edge: "none" });

/**
 * The operations on which an expired customer token of the tenant counts as no token (the request goes on as a guest
 * and `CustomerContext.presentedExpiredToken()` is true): auth.signOut, which the document lets end a session by its
 * refresh token when the access token has expired. Every other operation answers `401 TOKEN_EXPIRED`.
 */
export const EXPIRED_TOKEN_AS_GUEST: ReadonlySet<string> = new Set(["signOut"]);

/**
 * The operations on which the valid token of a customer that may no longer act (deleted or disabled) still reaches the
 * handler: account.delete, whose idempotent replay answers the stored deletion to the customer that made it (OBE-035);
 * anything else of it is refused by AccountService with `401 UNAUTHENTICATED`. Every other operation refuses such a
 * token in the guard (FIX-W29-SECURITY).
 */
export const INACTIVE_CUSTOMER_OPERATIONS: ReadonlySet<string> = new Set(["deleteAccount"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The requirement of an operation's `security` list for `caller`: among the alternatives that name the caller's scheme,
 * `required` when every one names the customer's scheme too, `optional` when some do, `none` when none do or the
 * caller has no alternative (or there is no list: the OTA document has no top-level `security`).
 */
export function customerRequirementOf(security: unknown, caller: CustomerCaller): CustomerRequirement {
  if (!Array.isArray(security)) {
    return "none";
  }
  const schemes = CUSTOMER_SECURITY_SCHEMES[caller];
  const alternatives = security
    .filter(isObject)
    .map((alternative) => Object.keys(alternative))
    .filter((names) => names.includes(schemes.caller));
  const withCustomer = alternatives.filter((names) => names.includes(schemes.customer)).length;
  if (withCustomer === 0) {
    return "none";
  }
  return withCustomer === alternatives.length ? "required" : "optional";
}

/** The requirements of every operation of an OpenAPI document, by `operationId`. */
export function customerRequirements(document: unknown): ReadonlyMap<string, CustomerRequirements> {
  const requirements = new Map<string, CustomerRequirements>();
  const paths = isObject(document) && isObject(document["paths"]) ? document["paths"] : {};
  for (const item of Object.values(paths)) {
    if (!isObject(item)) {
      continue;
    }
    for (const operation of Object.values(item)) {
      if (!isObject(operation) || typeof operation["operationId"] !== "string") {
        continue;
      }
      const security = operation["security"] ?? (isObject(document) ? document["security"] : undefined);
      requirements.set(
        operation["operationId"],
        Object.freeze({
          key: customerRequirementOf(security, "key"),
          edge: customerRequirementOf(security, "edge"),
        }),
      );
    }
  }
  return requirements;
}

/** The signed-in customer of a request. */
export interface CustomerPrincipal {
  /** `cus_…` (the token's `sub`). */
  readonly customerId: string;
  /** `ses_…`: the session (refresh family) of the token (`sid`). */
  readonly sessionId: string;
  /** When the presented access token expires (`AuthSessionDetails.accessTokenExpiresAt`). */
  readonly accessTokenExpiresAt: Date;
}

const CUSTOMER_KEY = "identity.customer";
const EXPIRED_TOKEN_KEY = "identity.customer_token_expired";

/** The signed-in customer of the current request in the request context (nestjs-cls), set by `CustomerGuard`. */
@Injectable()
export class CustomerContext {
  constructor(private readonly cls: ClsService) {}

  /** Records the customer of the current request; outside a request it throws: there is nowhere to keep it. */
  set(customer: CustomerPrincipal): void {
    if (!this.cls.isActive()) {
      throw new Error("CustomerContext.set outside a request context");
    }
    this.cls.set(CUSTOMER_KEY, Object.freeze({ ...customer }));
  }

  /** The signed-in customer, or `undefined` for a guest, before the guard ran, or outside a request. */
  get(): CustomerPrincipal | undefined {
    if (!this.cls.isActive()) {
      return undefined;
    }
    const customer: unknown = this.cls.get(CUSTOMER_KEY);
    return isObject(customer) ? (customer as unknown as CustomerPrincipal) : undefined;
  }

  /** The signed-in customer; `401 UNAUTHENTICATED` when the request has none. */
  require(): CustomerPrincipal {
    const customer = this.get();
    if (customer === undefined) {
      throw new AppError("UNAUTHENTICATED");
    }
    return customer;
  }

  /** Records that the request presented an expired token, which an `EXPIRED_TOKEN_AS_GUEST` operation took as none. */
  markExpiredToken(): void {
    if (!this.cls.isActive()) {
      throw new Error("CustomerContext.markExpiredToken outside a request context");
    }
    this.cls.set(EXPIRED_TOKEN_KEY, true);
  }

  /** True when the guard let the request through as a guest although it presented an expired customer token. */
  presentedExpiredToken(): boolean {
    return this.cls.isActive() && this.cls.get(EXPIRED_TOKEN_KEY) === true;
  }
}

/** The edge's access token cookie as cookie-parser gives it; anything but a non-empty string is no token. */
function accessCookieOf(cookies: unknown): string | undefined {
  const value = isObject(cookies) ? cookies[CUSTOMER_ACCESS_COOKIE] : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

@Injectable()
export class CustomerGuard implements CanActivate {
  private readonly requirements: ReadonlyMap<string, CustomerRequirements>;

  constructor(
    private readonly reflector: Reflector,
    private readonly callers: CallerContext,
    private readonly tenants: TenantContext,
    private readonly context: RequestContext,
    private readonly tokens: TokenService,
    private readonly customers: CustomerContext,
    private readonly access: CustomerAccess,
    openApi: OpenApiDocument,
    @InjectPinoLogger(CustomerGuard.name) private readonly logger: PinoLogger,
  ) {
    this.requirements = customerRequirements(openApi.document);
  }

  /** The requirement of `operationId` for `caller` (`none` for an id the document does not have). */
  requirementOf(operationId: string, caller: CustomerCaller): CustomerRequirement {
    return (this.requirements.get(operationId) ?? NONE)[caller];
  }

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    if (execution.getType() !== "http") {
      return true;
    }
    const operationId = this.reflector.get<string | undefined>(OPENAPI_OPERATION, execution.getHandler());
    if (operationId === undefined) {
      return true;
    }
    const caller = this.callers.get();
    if (caller === undefined) {
      throw new Error(
        "CustomerGuard ran without a caller in the request context; CallerGuard must run first",
      );
    }
    // The OTA admin's service caller reaches console operations only (scope guard, OBE-060): never a customer token.
    if (caller.type === "anonymous" || caller.type === "service" || this.context.isConsoleScope()) {
      return true;
    }
    const requirement = this.requirementOf(operationId, caller.type);
    if (requirement === "none") {
      return true;
    }
    const req = execution.switchToHttp().getRequest<Request>();
    const token = caller.type === "edge" ? accessCookieOf(req.cookies) : bearerTokenOf(req.headers);
    if (token === undefined) {
      if (requirement === "optional") {
        return true;
      }
      throw new AppError("UNAUTHENTICATED");
    }
    const verdict = await this.tokens.verifyCustomerToken(token, this.tenants.require().tenantId);
    if (
      !verdict.ok &&
      verdict.reason === "expired" &&
      requirement === "optional" &&
      EXPIRED_TOKEN_AS_GUEST.has(operationId)
    ) {
      this.customers.markExpiredToken();
      return true;
    }
    if (!verdict.ok) {
      this.logger.info({ reason: verdict.reason, callerType: caller.type }, "customer.token_refused");
      throw new AppError(verdict.reason === "expired" ? "TOKEN_EXPIRED" : "UNAUTHENTICATED");
    }
    const { sub, sid, exp } = verdict.claims;
    if (!INACTIVE_CUSTOMER_OPERATIONS.has(operationId) && !(await this.access.mayAct(sub))) {
      this.logger.info({ reason: "customer_inactive", callerType: caller.type }, "customer.token_refused");
      throw new AppError("UNAUTHENTICATED");
    }
    this.customers.set({ customerId: sub, sessionId: sid, accessTokenExpiresAt: new Date(exp * 1000) });
    this.tenants.setActor({ type: "customer", id: sub });
    return true;
  }
}
