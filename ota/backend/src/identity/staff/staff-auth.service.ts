// The four staff-session operations of the console (OBE-059; OADR-0011 points 1–3 and 5, PADR-0007,
// flows/console-operations.md §1, §3 step 1 and §4; the document's consoleSignIn, consoleRefreshSession,
// consoleSignOut and consoleGetMe). The sessions themselves are staff-sessions.ts; this service checks the grants and
// builds the answers.
//
// - console.auth.signIn. `grantType: password` answers `403 FEATURE_DISABLED` (`details.feature: "passwordGrant"`,
//   OADR-0011 point 1). `grantType: portal_token`: the token is taken with `GETDEL` (so it works once); an unknown,
//   used, expired or unreadable token, a token of another tenant than the request's, and a token issued at or before
//   the account's `staffdeny:acct:<accountId>` cut-off (flows/console-operations.md §1) answer
//   `401 PORTAL_TOKEN_INVALID`. Then, from the platform tables (past the 60 s caches): the membership named by the
//   token must still be the account's membership in this tenant, `active`, of an `active` account
//   (`403 STAFF_MEMBERSHIP_INACTIVE`), and the tenant `active` (`403 TENANT_SUSPENDED`). A live tenant
//   (`storefront_environment = live`, in the tenant row just read) also needs a token whose `mfa` flag is true, else
//   `403 MFA_REQUIRED` (FIX-W23-STAFF): PADR-0008's MFA rule for live OTAs, which the platform checks before it issues
//   the token; this is the backstop behind that check (a platform fault, or an OTA that went live within the token's
//   60 s). A viewer asking for `live` is refused (`403 ENVIRONMENT_NOT_ALLOWED`, OBE-060) with a denied
//   `staff.sign_in` row; that the tenant is live, when the OTA admin asks for it, is the permission guard's check,
//   before the token is taken. Every refusal of this service leaves the token used (`GETDEL`) and opens nothing. Its
//   403 refusals of a staff member it knows each write one denied `staff.sign_in` row without a target (OADR-0011
//   point 8 as decided on 2026-10-21): `STAFF_MEMBERSHIP_INACTIVE` as the membership the portal token names (its
//   account, the account's e-mail when the account still has a membership here, and the membership's role, or the
//   token's when the membership is another), `TENANT_SUSPENDED` (unless the tenant row is gone) and `MFA_REQUIRED` as
//   the membership just read; the `401 PORTAL_TOKEN_INVALID` refusals name nobody the audit could trust, and have the
//   log line only. Success opens a family with the membership's current role, writes one `staff_actions` row
//   `staff.sign_in` (the console audit's row of console/staff-actions.writer.ts: actor, role, the session as target,
//   request id, the end user's IP and user agent) and answers `ConsoleStaffSession`. The rate limit (10 per minute per
//   end-user IP) is the operation's throttler (rate-limits.ts). For the OTA admin's service caller the request's tenant
//   is the portal token's, which the tenant guard read (OBE-060).
// - console.auth.refresh. The family of the refresh token must pass the revocation checks of staff-sessions.ts and
//   its membership must be active with the family's role; then it rotates. A rotated token presented again revokes the
//   family (`401 REFRESH_TOKEN_REUSED`); an unknown, ended or revoked one is `401 REFRESH_TOKEN_INVALID`; a removed or
//   suspended member `403 STAFF_MEMBERSHIP_INACTIVE` (the family is revoked); a changed role ends the family too
//   (`401 REFRESH_TOKEN_INVALID`: a new sign-in through the portal); a viewer's family refreshed for `live` is
//   `403 ENVIRONMENT_NOT_ALLOWED` and stays as it was. The answer carries the current permissions.
// - console.auth.signOut. `scope: current` (the default) ends the session of the access token, else the family of the
//   refresh token in the body (a token the family issued; anything else changes nothing and still answers 204);
//   `scope: all` also writes the membership's cut-off `staffdeny:member:<staffId>`, which ends every other session of
//   the staff member in this OTA, and needs the access token or the family's current refresh token. An expired access
//   token counts as none (the staff guard); without a refresh token beside it the answer is `401 TOKEN_EXPIRED`
//   (refresh, then retry); no credential at all is `401 UNAUTHENTICATED`. A valid access token whose session has
//   already ended (signed out, revoked, cut off, its member removed) ends that family again and answers 204, as the
//   document's "always 204 for an already-revoked token" says (`scope: all` then needs another credential).
// - console.auth.me. The staff member, the tenant (the request's environment and the Amadeus connection of it, never
//   its credentials), the role's permissions, the session and the environments, read on every call.
//
// The tenant of the three answers (`toConsoleTenant`) carries `storefrontUrl`, the OTA's storefront origin for the
// console's environment: `https://<key>.<STOREFRONT_BASE_DOMAIN>` (notifications/renderer.ts `storefrontUrl`, the
// sub-domain the storefront and the e-mails use), the primary custom domain once OBE-080 resolves them (lead decision
// (2f) of 2026-10-30, third batch, FIX-W36-OTA). The OTA admin links published content pages with it.
//
// Permissions follow the role matrix of scope §1.3 (`ROLE_PERMISSIONS`); `environments` is `["test"]`, or
// `["test", "live"]` for a live tenant (`storefront_environment = live`) and a role other than `viewer` (point 5).
//
// The platform's `account_sessions`, `last_login_at` and `last_active_at`, which the contract's descriptions mention,
// are never written: the OTA backend never writes a platform table (ADR-0003, OADR-0011 point 2). No token is logged.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { parseAmadeusConnection, AMADEUS_OFFICE_ID } from "../../amadeus/connection-resolver";
import { assertRoleEnvironment, environmentsOf, permissionsOf } from "../../common/auth/roles";
import { Clock } from "../../common/clock";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotentInput,
} from "../../common/http/idempotency.service";
import { IdGenerator } from "../../common/ids";
import type { SharedConfig } from "../../config";
import { staffActionRow, type StaffActionActor } from "../../console/staff-actions.writer";
import { storefrontUrl } from "../../notifications/renderer";
import { PlatformCache } from "../../tenancy/platform-cache";
import {
  PlatformReadRepository,
  type PlatformAmadeusConnection,
  type PlatformStaffMember,
  type StaffRole,
} from "../../tenancy/platform-read.repository";
import { UnexpectedPlatformValueError, type PlatformTenant } from "../../tenancy/platform-read.types";
import { TenantContext, type TenantEnvironment } from "../../tenancy/tenant-context";
import { TenantTx } from "../../tenancy/tenant-tx";
import {
  familyProblem,
  membershipProblem,
  parseRefreshToken,
  StaffSessions,
  StaffTokens,
  type PortalTokenGrant,
  type StaffFamily,
} from "./staff-sessions";

type Schemas = components["schemas"];
export type ConsoleSignInRequest = Schemas["ConsoleSignInRequest"];
export type ConsoleStaffSession = Schemas["ConsoleStaffSession"];
export type ConsoleStaffProfile = Schemas["ConsoleStaffProfile"];
export type ConsoleTenant = Schemas["ConsoleTenant"];
export type StaffMember = Schemas["StaffMember"];
// The role matrix of scope §1.3 lives in common/auth/roles.ts since OBE-060 (the permission guard checks it too).
export {
  environmentsOf,
  permissionsOf,
  ROLE_PERMISSIONS,
  STAFF_PERMISSIONS,
  type ConsoleEnvironment,
  type StaffPermission,
} from "../../common/auth/roles";

/**
 * Whether a portal token is refused for the MFA rule of live OTAs (PADR-0008): the tenant is live
 * (`storefront_environment = live`) and the token does not say that the account has MFA enabled.
 */
export function mfaRequiredFor(
  tenant: Pick<PlatformTenant, "storefrontEnvironment">,
  grant: Pick<PortalTokenGrant, "mfa">,
): boolean {
  return tenant.storefrontEnvironment === "live" && grant.mfa !== true;
}

/** The console audit's actor of a membership the sign-in read (console/staff-actions.writer.ts). */
export function staffActorOf(member: PlatformStaffMember): StaffActionActor {
  return {
    type: "staff",
    staffId: member.id,
    accountId: member.accountId,
    email: member.account.email,
    role: member.role,
  };
}

/** The contract's `StaffMember` of a membership. */
export function toStaffMember(member: PlatformStaffMember): StaffMember {
  return {
    id: member.id,
    accountId: member.accountId,
    email: member.account.email,
    fullName: member.account.fullName,
    role: member.role,
    status: member.status === "active" ? "active" : "suspended",
    locale: member.account.locale,
    timeZone: member.account.timeZone,
    mfaEnabled: member.account.mfaEnabled,
    lastActiveAt: member.lastActiveAt,
    createdAt: member.createdAt,
  };
}

/**
 * The contract's `ConsoleTenant`: the tenant in the request's environment, with its Amadeus connection of that
 * environment (offices only, never credentials; `connected` when the connection is `active`) and its storefront origin
 * on `storefrontBaseDomain` (STOREFRONT_BASE_DOMAIN; see the file header).
 */
export function toConsoleTenant(
  tenant: PlatformTenant,
  timeZone: string,
  environment: TenantEnvironment,
  connection: PlatformAmadeusConnection | null,
  storefrontBaseDomain: string,
): ConsoleTenant {
  return {
    id: tenant.id,
    key: tenant.key,
    name: tenant.name,
    status: tenant.status === "active" ? "active" : "suspended",
    environment,
    defaultCurrency: tenant.defaultCurrency.trim(),
    defaultLocale: tenant.defaultLocale,
    timeZone,
    storefrontUrl: storefrontUrl(tenant.key, storefrontBaseDomain),
    supplier: {
      connected: connection?.status === "active",
      officeIds: (connection?.officeIds ?? []).filter((office) => AMADEUS_OFFICE_ID.test(office)),
      defaultOfficeId: connection?.defaultOfficeId ?? null,
      queuingOfficeId: connection?.queuingOfficeId ?? null,
    },
  };
}

/** What `signIn` takes: the validated body and the staff member's end-user context. */
export interface StaffSignInInput {
  readonly body: ConsoleSignInRequest;
  /** The staff member's user agent (trimmed, at most 512 characters), or `null`. */
  readonly userAgent: string | null;
  /** The staff member's IP address, or `null` when it is not one. */
  readonly ip: string | null;
}

/** The signed-in staff member of a request, as the staff guard found it (`StaffContext`). */
export interface StaffSessionPrincipal {
  readonly family: StaffFamily;
  readonly member: PlatformStaffMember;
}

/** `scope` of console.auth.signOut. */
export type StaffSignOutScope = "current" | "all";

/** What `signOut` takes. */
export interface StaffSignOutInput {
  readonly scope: StaffSignOutScope;
  /** The signed-in staff member of the request (a valid access token), when there is one. */
  readonly principal: StaffSessionPrincipal | undefined;
  /** The body's refresh token, when there is one. */
  readonly refreshToken: string | undefined;
  /**
   * The session of a valid access token whose session had already ended (the staff guard's
   * `ENDED_STAFF_SESSION_AS_NONE`), when the request presented one.
   */
  readonly endedSession?: { readonly familyId: string; readonly staffId: string } | undefined;
}

/**
 * The idempotency request hash of console.auth.signIn (idempotency.service.ts): the portal token stays in it (random,
 * so the key alone never replays a session), the password and TOTP code of the refused password grant never do (no
 * safe unkeyed hash exists for them).
 */
@Injectable()
@IdempotencyHooksFor(["consoleSignIn"])
export class ConsoleSignInIdempotencyHooks implements IdempotencyHooks {
  hashInput(input: IdempotentInput): unknown {
    const body =
      typeof input.body === "object" && input.body !== null && !Array.isArray(input.body)
        ? (input.body as Record<string, unknown>)
        : {};
    const { password: _password, mfaCode: _mfaCode, ...rest } = body;
    return { path: input.path, query: input.query, body: rest };
  }
}

@Injectable()
export class StaffAuthService {
  constructor(
    private readonly sessions: StaffSessions,
    private readonly tokens: StaffTokens,
    private readonly tenants: TenantContext,
    private readonly cache: PlatformCache,
    private readonly platform: PlatformReadRepository,
    private readonly tx: TenantTx,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    config: ConfigService<SharedConfig, true>,
    @InjectPinoLogger(StaffAuthService.name) private readonly logger: PinoLogger,
  ) {
    this.storefrontBaseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** STOREFRONT_BASE_DOMAIN: the tenants' storefront sub-domains (`ConsoleTenant.storefrontUrl`). */
  private readonly storefrontBaseDomain: string;

  /** console.auth.signIn (see the file header). */
  async signIn(input: StaffSignInInput): Promise<ConsoleStaffSession> {
    if (input.body.grantType !== "portal_token") {
      throw new AppError("FEATURE_DISABLED", {
        message:
          "Console sign-in with a password is not available; open the console from the Velexis portal.",
        details: { feature: "passwordGrant" },
      });
    }
    const tenantId = this.tenants.require().tenantId;
    const grant = await this.sessions.redeemPortalToken(input.body.portalToken);
    if (grant === undefined) {
      this.logger.info({ reason: "unknown_token" }, "staff.sign_in_refused");
      throw new AppError("PORTAL_TOKEN_INVALID");
    }
    if (grant.tenantId !== tenantId) {
      this.logger.info({ reason: "other_tenant", accountId: grant.accountId }, "staff.sign_in_refused");
      throw new AppError("PORTAL_TOKEN_INVALID");
    }
    const accountCutOff = await this.sessions.accountCutOff(grant.accountId);
    if (accountCutOff !== undefined && Date.parse(grant.issuedAt) <= accountCutOff) {
      // Issued before the platform's "sign out everywhere" (password change, account disabled …): the token went with
      // the sessions it cut off.
      this.logger.info({ reason: "account_cut_off", accountId: grant.accountId }, "staff.sign_in_refused");
      throw new AppError("PORTAL_TOKEN_INVALID");
    }
    const member = await this.sessions.freshMember(grant.accountId, tenantId);
    if (
      member === null ||
      membershipProblem(member, {
        staffId: grant.membershipId,
        accountId: grant.accountId,
        tenantId,
        role: member.role,
      }) !== undefined
    ) {
      this.logger.info(
        { reason: "membership_inactive", accountId: grant.accountId, staffId: grant.membershipId },
        "staff.sign_in_refused",
      );
      // The portal token the platform issued names the membership: the refusal is its denied row.
      await this.recordRefusedSignIn(
        {
          type: "staff",
          staffId: grant.membershipId,
          accountId: grant.accountId,
          email: member?.account.email ?? null,
          role: member !== null && member.id === grant.membershipId ? member.role : grant.role,
        },
        input,
      );
      throw new AppError("STAFF_MEMBERSHIP_INACTIVE");
    }
    const tenant = await this.freshTenant(tenantId);
    if (tenant === null || tenant.status !== "active") {
      this.logger.info({ reason: "tenant_not_active", staffId: member.id }, "staff.sign_in_refused");
      if (tenant !== null) {
        // A suspended tenant keeps its schema; a tenant row that is gone may not have one, and has the log line only.
        await this.recordRefusedSignIn(staffActorOf(member), input);
      }
      throw new AppError("TENANT_SUSPENDED");
    }
    if (mfaRequiredFor(tenant, grant)) {
      // The platform issues no such token for a live OTA (PADR-0008), so this one is a warning: the OTA went live within
      // the token's 60 s, or the platform's check failed. The token is used up; no session is opened.
      this.logger.warn({ reason: "mfa_required", staffId: member.id }, "staff.sign_in_refused");
      await this.recordRefusedSignIn(staffActorOf(member), input);
      throw new AppError("MFA_REQUIRED");
    }
    // OADR-0011 point 5 (OBE-060): a viewer is limited to test, whatever environment the request asked for; the refusal
    // is a denied `staff.sign_in` row (point 8).
    await this.assertSignInEnvironment(member, input);
    const issued = await this.sessions.open(member, input.userAgent);
    try {
      await this.recordSignIn(staffActorOf(member), issued.family, input);
    } catch (error) {
      // No audit row, no session: the family that was just opened is ended again.
      await this.sessions.revoke(issued.family.id).catch(() => undefined);
      throw error;
    }
    this.logger.info(
      { staffId: member.id, familyId: issued.family.id, role: member.role },
      "staff.signed_in",
    );
    return this.sessionAnswer(issued.family, issued.refreshToken, member, tenant);
  }

  /** console.auth.refresh (see the file header). */
  async refresh(refreshToken: string): Promise<ConsoleStaffSession> {
    const tenantId = this.tenants.require().tenantId;
    const presented = parseRefreshToken(refreshToken);
    if (presented === undefined) {
      throw new AppError("REFRESH_TOKEN_INVALID");
    }
    const state = await this.sessions.state(presented.familyId, tenantId);
    const problem = familyProblem(state, tenantId, this.clock.now());
    const family = state.family;
    if (problem !== undefined || family === undefined) {
      if (problem !== "missing" && problem !== "other_tenant") {
        await this.sessions.revoke(presented.familyId);
      }
      this.logger.info({ reason: problem, familyId: presented.familyId }, "staff.refresh_refused");
      throw new AppError("REFRESH_TOKEN_INVALID");
    }
    const member = await this.sessions.member(family.accountId, tenantId);
    const membership = membershipProblem(member, family);
    if (membership !== undefined || member === null) {
      await this.sessions.revoke(family.id);
      this.logger.info(
        { reason: membership, familyId: family.id, staffId: family.staffId },
        "staff.refresh_refused",
      );
      throw new AppError(
        membership === "role_changed" ? "REFRESH_TOKEN_INVALID" : "STAFF_MEMBERSHIP_INACTIVE",
      );
    }
    this.assertEnvironment(family.role, family.staffId, "staff.refresh_refused");
    const rotation = await this.sessions.rotate(family.id, presented.hash);
    if (rotation.outcome === "reused") {
      // Ids only: the token is never logged.
      this.logger.warn({ staffId: family.staffId, familyId: family.id }, "staff.refresh_token_reused");
      throw new AppError("REFRESH_TOKEN_REUSED");
    }
    if (rotation.outcome !== "rotated") {
      this.logger.info({ reason: rotation.outcome, familyId: family.id }, "staff.refresh_refused");
      throw new AppError("REFRESH_TOKEN_INVALID");
    }
    return this.sessionAnswer(family, rotation.refreshToken, member, await this.cachedTenant(tenantId));
  }

  /** console.auth.signOut (see the file header). */
  async signOut(input: StaffSignOutInput): Promise<void> {
    const target = await this.signOutTarget(input);
    if (target === undefined) {
      this.logger.info({ scope: input.scope, revoked: 0 }, "staff.signed_out");
      return;
    }
    if (input.scope === "all") {
      await this.sessions.revokeMember(target.staffId);
    }
    await this.sessions.revoke(target.familyId);
    this.logger.info(
      { scope: input.scope, staffId: target.staffId, familyId: target.familyId, revoked: 1 },
      "staff.signed_out",
    );
  }

  /** console.auth.me for the signed-in staff member of the request. */
  async me(principal: StaffSessionPrincipal): Promise<ConsoleStaffProfile> {
    const { tenantId, environment } = this.tenants.require();
    const { family, member } = principal;
    const tenant = await this.cachedTenant(tenantId);
    return {
      staff: toStaffMember(member),
      tenant: toConsoleTenant(
        tenant,
        member.tenantTimeZone,
        environment,
        await this.connection(tenantId),
        this.storefrontBaseDomain,
      ),
      permissions: permissionsOf(member.role),
      session: {
        id: family.id,
        createdAt: family.createdAt.toISOString(),
        expiresAt: family.expiresAt.toISOString(),
        userAgent: family.userAgent,
      },
      environments: environmentsOf(member.role, tenant.storefrontEnvironment),
    };
  }

  /**
   * Whose session signOut ends: the access token's, else the family that issued the body's refresh token, else (for
   * `scope: current`) the ended session of a valid access token. `undefined` (a no-op) for a `current` sign-out with a
   * refresh token no family of this tenant issued; `401 UNAUTHENTICATED` without any credential, and for `scope: all`
   * without the access token of a live session or the family's current refresh token.
   */
  private async signOutTarget(
    input: StaffSignOutInput,
  ): Promise<{ readonly familyId: string; readonly staffId: string } | undefined> {
    if (input.principal !== undefined) {
      return { familyId: input.principal.family.id, staffId: input.principal.family.staffId };
    }
    if (input.refreshToken === undefined) {
      if (input.endedSession !== undefined && input.scope === "current") {
        // Signed out already (or revoked, cut off, its member removed): ending it again is the document's idempotent
        // 204. `scope: all` needs a session that still holds.
        return input.endedSession;
      }
      throw new AppError("UNAUTHENTICATED");
    }
    const tenantId = this.tenants.require().tenantId;
    const presented = parseRefreshToken(input.refreshToken);
    const state =
      presented === undefined ? undefined : await this.sessions.state(presented.familyId, tenantId);
    const family = state?.family;
    const issued =
      presented === undefined || family === undefined || family.tenantId !== tenantId
        ? "none"
        : await this.sessions.issuedByFamily(family.id, presented.hash);
    if (
      input.scope === "all" &&
      (issued !== "current" ||
        state === undefined ||
        familyProblem(state, tenantId, this.clock.now()) !== undefined)
    ) {
      throw new AppError("UNAUTHENTICATED");
    }
    return issued === "none" || family === undefined
      ? undefined
      : { familyId: family.id, staffId: family.staffId };
  }

  /** `ConsoleStaffSession` with a new access token for `family` and its refresh token. */
  private async sessionAnswer(
    family: StaffFamily,
    refreshToken: string,
    member: PlatformStaffMember,
    tenant: PlatformTenant,
  ): Promise<ConsoleStaffSession> {
    const { environment } = this.tenants.require();
    const access = await this.tokens.sign({
      sub: family.staffId,
      tid: family.tenantId,
      sid: family.id,
      role: family.role,
    });
    return {
      session: {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt.toISOString(),
        refreshToken,
        refreshTokenExpiresAt: family.expiresAt.toISOString(),
        tokenType: "Bearer",
        subject: { type: "staff", id: family.staffId, roles: [family.role] },
      },
      staff: toStaffMember(member),
      tenant: toConsoleTenant(
        tenant,
        member.tenantTimeZone,
        environment,
        await this.connection(tenant.id),
        this.storefrontBaseDomain,
      ),
      permissions: permissionsOf(family.role),
      environments: environmentsOf(family.role, tenant.storefrontEnvironment),
    };
  }

  /**
   * The `staff_actions` row of a sign-in, in a transaction of its own (OADR-0011 point 8), built by the console audit's
   * row builder (console/staff-actions.writer.ts, OBE-060): the staff member, the session as target (none for a denied
   * sign-in, which opens no session), the outcome, the request id and the staff member's IP and user agent (for the OTA
   * admin the forwarded ones); no token, no portal token.
   */
  private async recordSignIn(
    actor: StaffActionActor,
    family: StaffFamily | undefined,
    input: StaffSignInInput,
    outcome: "succeeded" | "denied" = "succeeded",
  ): Promise<void> {
    const requestId = this.tenants.require().requestId;
    const row = staffActionRow(
      this.ids.newId("sact"),
      {
        action: "staff.sign_in",
        outcome,
        targetType: family === undefined ? null : "staff_session",
        targetId: family?.id ?? null,
      },
      {
        actor,
        requestId: requestId === "" ? null : requestId,
        ip: input.ip,
        userAgent: input.userAgent,
      },
    );
    await this.tx.run((trx) => trx.insertInto("staff_actions").values(row).execute());
  }

  /**
   * The denied `staff.sign_in` row of a sign-in refused for a staff member the request knows (OADR-0011 point 8 as
   * decided on 2026-10-21): one insert in a transaction of its own; a row that cannot be written is logged, and the
   * refusal stands.
   */
  private async recordRefusedSignIn(actor: StaffActionActor, input: StaffSignInInput): Promise<void> {
    await this.recordSignIn(actor, undefined, input, "denied").catch((writeError: unknown) => {
      this.logger.error(
        { err: writeError, staffId: actor.type === "staff" ? actor.staffId : null },
        "staff_actions.write_failed",
      );
    });
  }

  /**
   * `403 ENVIRONMENT_NOT_ALLOWED` when `role` may not act in the request's environment (live for a viewer; roles.ts):
   * nothing is opened or rotated, and the session stays as it was.
   */
  private assertEnvironment(role: StaffRole, staffId: string, event: string): void {
    try {
      assertRoleEnvironment(role, this.tenants.require().environment);
    } catch (error) {
      this.logger.info({ reason: "environment_not_allowed", staffId }, event);
      throw error;
    }
  }

  /**
   * `assertEnvironment` for a sign-in: the refusal also writes a denied `staff.sign_in` row of the staff member
   * (OADR-0011 point 8; the portal token is used up, no session is opened). A row that cannot be written is logged, and
   * the refusal stands.
   */
  private async assertSignInEnvironment(member: PlatformStaffMember, input: StaffSignInInput): Promise<void> {
    try {
      this.assertEnvironment(member.role, member.id, "staff.sign_in_refused");
    } catch (error) {
      await this.recordRefusedSignIn(staffActorOf(member), input);
      throw error;
    }
  }

  /** The tenant row from the platform tables, past the cache (console.auth.signIn). */
  private async freshTenant(tenantId: string): Promise<PlatformTenant | null> {
    try {
      return await this.platform.tenantById(tenantId);
    } catch (error) {
      if (error instanceof AppError || error instanceof UnexpectedPlatformValueError) {
        throw error;
      }
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
  }

  /** The tenant row through the cache; the tenant guard has just read it, so a missing one is a race (503). */
  private async cachedTenant(tenantId: string): Promise<PlatformTenant> {
    const tenant = await this.cache.tenantById(tenantId);
    if (tenant === null) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }
    return tenant;
  }

  /** The tenant's Amadeus connection of the request's environment, through the cache; `null` when there is none. */
  private connection(tenantId: string): Promise<PlatformAmadeusConnection | null> {
    const { environment } = this.tenants.require();
    return this.cache.connection(
      "amadeus",
      tenantId,
      environment,
      () => this.platform.amadeusConnection(tenantId, environment),
      parseAmadeusConnection,
    );
  }
}
