// The staff guard (OBE-059; architecture §3 step 8, OADR-0011 points 2 and 3, OADR-0009 point 7): who the signed-in
// staff member of a console request is. It runs after the scope guard, beside the customer guard (`APP_GUARD` order of
// app.module.ts), on handlers bound to an operation of the OTA document, and only in console scope: in customer scope
// the bearer token is a customer token, which the customer guard checks.
//
// Which operations take a staff token comes from the document itself, from each operation's `security` alternatives
// for a key caller (those with `apiKey`):
//
//   every alternative has `staffAuth`            → required (console.auth.me)
//   some do                                      → optional (console.auth.signOut, and the console operations that a
//                                                  `console:automation` key may also call alone)
//   none do                                      → not read (console.auth.signIn, console.auth.refresh)
//
// A token that is presented must be valid, also on an optional operation: a staff token of the request's tenant
// (EdDSA, `typ: staff`, `tid` equal to the tenant the tenant guard resolved), `401 TOKEN_EXPIRED` when it expired (the
// SDK refreshes and retries), `401 UNAUTHENTICATED` for anything else, a customer token and a token of another tenant
// included (`staff.token_refused` with the reason, never the token). Then the session checks of staff-sessions.ts:
// the family exists, is not revoked and was created after the account, tenant and membership cut-offs, and the cached
// membership is active with the token's role (`401 UNAUTHENTICATED`, `403 STAFF_MEMBERSHIP_INACTIVE`). A required
// operation without a token is `401 UNAUTHENTICATED`; an optional one goes on without a staff member. As for
// customers, console.auth.signOut takes an expired token of the tenant as none (`EXPIRED_STAFF_TOKEN_AS_NONE`): the
// document lets it end a session by its refresh token after the access token expired. It also takes a valid token
// whose session no longer passes the checks as none (`ENDED_STAFF_SESSION_AS_NONE`, `StaffContext.endedSession`): the
// document makes a sign-out of an already-ended session a `204`.
//
// An accepted token makes the staff member the request's actor (`TenantContext.setActor`, `staff`/`stf_…`), and puts
// the family and the membership into the request context (`StaffContext`), where services read them. The OTA admin's
// service caller (OBE-060) adds that the service key needs a staff token on every console operation but the sign-in.
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AppError, isAppError } from "@velexis/errors";
import type { Request } from "express";
import { ClsService } from "nestjs-cls";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  StaffSessions,
  StaffTokens,
  type AuthenticatedStaff,
  type StaffFamily,
} from "../../identity/staff/staff-sessions";
import { bearerTokenOf } from "../../identity/token.service";
import { CallerContext } from "../../tenancy/caller-resolver";
import type { PlatformStaffMember } from "../../tenancy/platform-read.repository";
import { TenantContext } from "../../tenancy/tenant-context";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";
import { OpenApiDocument } from "../http/openapi-validation.interceptor";
import { RequestContext } from "../http/request-context";

/** Whether an operation takes a staff token from a key caller. */
export type StaffRequirement = "required" | "optional" | "none";

/** The security schemes of the document: the key caller and its staff token. */
export const STAFF_SECURITY_SCHEMES = Object.freeze({ caller: "apiKey", staff: "staffAuth" });

/**
 * The operations on which an expired staff token of the tenant counts as no token (`StaffContext.presentedExpiredToken`
 * is then true): console.auth.signOut. Every other operation answers `401 TOKEN_EXPIRED`.
 */
export const EXPIRED_STAFF_TOKEN_AS_NONE: ReadonlySet<string> = new Set(["consoleSignOut"]);

/**
 * The operations on which a valid staff token of the tenant whose session no longer passes the checks (signed out,
 * revoked, cut off, its membership inactive or its role changed) counts as no token (`StaffContext.endedSession` then
 * names its session): console.auth.signOut, which the document makes idempotent ("always 204 for an already-revoked
 * token"). Every other operation answers what the checks answer.
 */
export const ENDED_STAFF_SESSION_AS_NONE: ReadonlySet<string> = new Set(["consoleSignOut"]);

/** The refusals of `StaffSessions.authenticate` that mean the token's session has ended (not a failure to check). */
const ENDED_SESSION_CODES: ReadonlySet<string> = new Set(["UNAUTHENTICATED", "STAFF_MEMBERSHIP_INACTIVE"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The requirement of an operation's `security` list: among the alternatives that name `apiKey`, `required` when every
 * one names `staffAuth` too, `optional` when some do, `none` when none do or there is no list.
 */
export function staffRequirementOf(security: unknown): StaffRequirement {
  if (!Array.isArray(security)) {
    return "none";
  }
  const alternatives = security
    .filter(isObject)
    .map((alternative) => Object.keys(alternative))
    .filter((names) => names.includes(STAFF_SECURITY_SCHEMES.caller));
  const withStaff = alternatives.filter((names) => names.includes(STAFF_SECURITY_SCHEMES.staff)).length;
  if (withStaff === 0) {
    return "none";
  }
  return withStaff === alternatives.length ? "required" : "optional";
}

/** The requirements of every operation of an OpenAPI document, by `operationId`. */
export function staffRequirements(document: unknown): ReadonlyMap<string, StaffRequirement> {
  const requirements = new Map<string, StaffRequirement>();
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
      requirements.set(operation["operationId"], staffRequirementOf(security));
    }
  }
  return requirements;
}

/** The signed-in staff member of a request. */
export interface StaffPrincipal {
  /** The session (refresh family) of the token, `asn_…`, with the role and times it was opened with. */
  readonly family: StaffFamily;
  /** The membership as the checks read it (cached 60 s): role, status, account. */
  readonly member: PlatformStaffMember;
  /** When the presented access token expires. */
  readonly accessTokenExpiresAt: Date;
}

/** The session named by a valid staff token whose session checks failed (`StaffContext.endedSession`). */
export interface EndedStaffSession {
  /** The token's `sid`, `asn_…`. */
  readonly familyId: string;
  /** The token's `sub`, `stf_…`. */
  readonly staffId: string;
}

const STAFF_KEY = "identity.staff";
const EXPIRED_TOKEN_KEY = "identity.staff_token_expired";
const ENDED_SESSION_KEY = "identity.staff_session_ended";

/** The signed-in staff member of the current request in the request context (nestjs-cls), set by `StaffGuard`. */
@Injectable()
export class StaffContext {
  constructor(private readonly cls: ClsService) {}

  /** Records the staff member of the current request; outside a request it throws: there is nowhere to keep it. */
  set(staff: StaffPrincipal): void {
    if (!this.cls.isActive()) {
      throw new Error("StaffContext.set outside a request context");
    }
    this.cls.set(STAFF_KEY, Object.freeze({ ...staff }));
  }

  /** The signed-in staff member, or `undefined` without one, before the guard ran, or outside a request. */
  get(): StaffPrincipal | undefined {
    if (!this.cls.isActive()) {
      return undefined;
    }
    const staff: unknown = this.cls.get(STAFF_KEY);
    return isObject(staff) ? (staff as unknown as StaffPrincipal) : undefined;
  }

  /** The signed-in staff member; `401 UNAUTHENTICATED` when the request has none. */
  require(): StaffPrincipal {
    const staff = this.get();
    if (staff === undefined) {
      throw new AppError("UNAUTHENTICATED");
    }
    return staff;
  }

  /** Records that the request presented an expired token, which an `EXPIRED_STAFF_TOKEN_AS_NONE` operation ignored. */
  markExpiredToken(): void {
    if (!this.cls.isActive()) {
      throw new Error("StaffContext.markExpiredToken outside a request context");
    }
    this.cls.set(EXPIRED_TOKEN_KEY, true);
  }

  /** True when the guard let the request through without a staff member although it presented an expired token. */
  presentedExpiredToken(): boolean {
    return this.cls.isActive() && this.cls.get(EXPIRED_TOKEN_KEY) === true;
  }

  /**
   * Records the session of a valid token whose session checks failed, which an `ENDED_STAFF_SESSION_AS_NONE`
   * operation let through without a staff member.
   */
  markEndedSession(session: EndedStaffSession): void {
    if (!this.cls.isActive()) {
      throw new Error("StaffContext.markEndedSession outside a request context");
    }
    this.cls.set(ENDED_SESSION_KEY, Object.freeze({ familyId: session.familyId, staffId: session.staffId }));
  }

  /** The session of the token the guard took as none because the session has ended, or `undefined`. */
  endedSession(): EndedStaffSession | undefined {
    if (!this.cls.isActive()) {
      return undefined;
    }
    const session: unknown = this.cls.get(ENDED_SESSION_KEY);
    return isObject(session) ? (session as unknown as EndedStaffSession) : undefined;
  }
}

@Injectable()
export class StaffGuard implements CanActivate {
  private readonly requirements: ReadonlyMap<string, StaffRequirement>;

  constructor(
    private readonly reflector: Reflector,
    private readonly callers: CallerContext,
    private readonly tenants: TenantContext,
    private readonly context: RequestContext,
    private readonly tokens: StaffTokens,
    private readonly sessions: StaffSessions,
    private readonly staff: StaffContext,
    openApi: OpenApiDocument,
    @InjectPinoLogger(StaffGuard.name) private readonly logger: PinoLogger,
  ) {
    this.requirements = staffRequirements(openApi.document);
  }

  /** The requirement of `operationId` (`none` for an id the document does not have). */
  requirementOf(operationId: string): StaffRequirement {
    return this.requirements.get(operationId) ?? "none";
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
      throw new Error("StaffGuard ran without a caller in the request context; CallerGuard must run first");
    }
    if (caller.type !== "key" || !this.context.isConsoleScope()) {
      return true;
    }
    const requirement = this.requirementOf(operationId);
    if (requirement === "none") {
      return true;
    }
    const token = bearerTokenOf(execution.switchToHttp().getRequest<Request>().headers);
    if (token === undefined) {
      if (requirement === "optional") {
        return true;
      }
      throw new AppError("UNAUTHENTICATED");
    }
    const tenantId = this.tenants.require().tenantId;
    const verdict = await this.tokens.verify(token, tenantId);
    if (
      !verdict.ok &&
      verdict.reason === "expired" &&
      requirement === "optional" &&
      EXPIRED_STAFF_TOKEN_AS_NONE.has(operationId)
    ) {
      this.staff.markExpiredToken();
      return true;
    }
    if (!verdict.ok) {
      this.logger.info({ reason: verdict.reason, callerType: caller.type }, "staff.token_refused");
      throw new AppError(verdict.reason === "expired" ? "TOKEN_EXPIRED" : "UNAUTHENTICATED");
    }
    let authenticated: AuthenticatedStaff;
    try {
      authenticated = await this.sessions.authenticate(verdict.claims, tenantId);
    } catch (error) {
      if (
        requirement === "optional" &&
        ENDED_STAFF_SESSION_AS_NONE.has(operationId) &&
        isAppError(error) &&
        ENDED_SESSION_CODES.has(error.code)
      ) {
        // A signed token of this tenant whose session has ended: there is no session left to act as, only one to
        // sign out of again (the handler answers 204).
        this.staff.markEndedSession({ familyId: verdict.claims.sid, staffId: verdict.claims.sub });
        return true;
      }
      throw error;
    }
    const { family, member } = authenticated;
    this.staff.set({ family, member, accessTokenExpiresAt: new Date(verdict.claims.exp * 1000) });
    this.tenants.setActor({ type: "staff", id: verdict.claims.sub });
    return true;
  }
}
