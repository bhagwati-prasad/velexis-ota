// MfaEnrolmentGuard (platform/docs/architecture.md §3 step 5b; PADR-0008, revision of 2026-11-05, lead decision (5b);
// platform/docs/security-review.md §9; scope PF-04 AC4): MFA is mandatory for the owners and admins of a live OTA.
//
// The rule: an account that holds an **active** `owner` or `admin` membership of a **live** OTA
// (`tenants.storefront_environment = 'live'`, in a status members see: MEMBER_VISIBLE_TENANT_STATUSES, not deleted)
// and has MFA off answers `403 MFA_REQUIRED` with `details.reason = enrolment_required` on **every** operation of
// the `portal` scope, reads included, and those of its other (test) OTAs too, until it turns MFA on. The operations of
// `portal_unverified` stay open (`getMe`, which says so in `mfaEnrolmentRequired`, `updateMe`, `startMfaSetup`,
// `enableMfa`, the sessions, sign-out and `listTenants`): they are all an enrolment needs. `public`, `internal`,
// `webhook` and `platform_admin` operations pass untouched.
//
// Why (PADR-0008's note under the MFA table): every sensitive action already needs MFA and a recent step-up, but a
// stolen owner or admin password alone still opened the Stripe Customer Portal (change the card, cancel the
// subscription, which suspends the OTA), invited members who stay after a password reset, revoked or rolled API keys,
// removed members, added custom domains, edited the OTA and read everything of it. A live OTA takes real money from
// real travellers, so its owners and admins get the second factor its back office already demands (a live OTA's
// console needs MFA for every member, PF-22 AC3). Agents, finance members and viewers cannot change money, credentials
// or the team, and test-only OTAs keep MFA optional for the "OTA in minutes" promise (decisions.md §2), so neither is
// gated. Going live itself needs the acting owner's MFA and a step-up (`goLive`), so a live OTA always starts with an
// owner who has MFA; an admin of it, an account granted `owner` or `admin` on a live OTA (granting is not refused)
// and an account whose MFA support reset meet this guard at their next portal request, and the portal sends them to
// the enrolment (PFE-030).
//
// The read: the account's `mfa_enabled` is the one PortalAuthGuard read for this request (`portalAccountStateOf`,
// PBE-067's per-request read of `AccountAuthStates`), so an account with MFA costs no further query; for one without
// MFA the guard asks MfaEnrolmentLookup for an active owner or admin membership of a live OTA: one indexed query
// (the partial index of active memberships by account, and the tenants' primary key) on every such request, no cache,
// as TenantRoleGuard reads memberships, so a go-live, a role change, a removal or turning MFA on acts at the account's
// next request. The lookup is the MembershipsModule's (layer 1): this layer-0 guard depends on the abstract class,
// which MembershipsModule provides with its repository, as it provides TenantMembershipLookup. `getMe`, `updateMe`
// and the `PortalSession` answers read `mfaEnrolmentRequired` through the same lookup (`requiresMfaEnrolment`), and
// `disableMfa` refuses such an account with `409 CONFLICT` (`mfa_mandatory`) through it too.
//
// It runs after AccountRateLimitGuard and before TenantRoleGuard (API_GUARDS of common.module.ts), so the refusal
// comes before the role, switch and step-up guards: an owner or admin who must enrol learns nothing else first, and
// even a tenant path of an OTA it is no member of answers the enrolment, not `404`.
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import type { PlatformTransaction } from "../../audit/audit.repository";
import type { PlatformDb } from "../database";
import { accessTokenOf, OperationPolicies } from "./decorators";
import { portalAccountStateOf } from "./portal-auth.guard";
import type { TenantRole } from "./tenant-role.guard";

/** The roles whose members must have MFA in a live OTA (PADR-0008, revision of 2026-11-05). */
export const MFA_MANDATORY_ROLES = Object.freeze(["owner", "admin"] as const satisfies readonly TenantRole[]);

/** `tenants.storefront_environment` of a live OTA (migration 0002). */
export const LIVE_STOREFRONT_ENVIRONMENT = "live";

/** The `details` of the guard's `403 MFA_REQUIRED`, as the document's `MfaEnrolmentRequired` example shows them. */
export const MFA_ENROLMENT_REQUIRED = Object.freeze({ reason: "enrolment_required" } as const);

/**
 * The read the rule needs: whether an account holds an **active** `owner` or `admin` membership of a live OTA that
 * members may see. MembershipsModule provides it (memberships.repository.ts); unit tests pass a stand-in.
 */
export abstract class MfaEnrolmentLookup {
  /**
   * True when `accountId` holds an active owner or admin membership of a live OTA that members may see; one indexed
   * read on `db` (the pool unless the caller passes its transaction).
   */
  abstract holdsMfaMandatoryRole(accountId: string, db?: PlatformDb | PlatformTransaction): Promise<boolean>;
}

/**
 * True when the account must enrol in MFA before any `portal` operation: it has MFA off and holds an active owner or
 * admin membership of a live OTA. An account with MFA on is never looked up. `db` is the caller's transaction, if any.
 */
export async function requiresMfaEnrolment(
  lookup: MfaEnrolmentLookup,
  account: { readonly id: string; readonly mfaEnabled: boolean },
  db?: PlatformDb | PlatformTransaction,
): Promise<boolean> {
  return !account.mfaEnabled && (await lookup.holdsMfaMandatoryRole(account.id, db));
}

@Injectable()
export class MfaEnrolmentGuard implements CanActivate {
  constructor(
    private readonly policies: OperationPolicies,
    private readonly lookup: MfaEnrolmentLookup,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http" || this.policies.forContext(context).scope !== "portal") {
      return true;
    }
    const request = context.switchToHttp().getRequest<object>();
    const claims = accessTokenOf(request);
    const account = portalAccountStateOf(request);
    if (claims === undefined || claims.aud !== "portal" || account === undefined) {
      // A `portal` operation that PortalAuthGuard did not cover: refuse, never wave through.
      throw new AppError("UNAUTHENTICATED");
    }
    if (await requiresMfaEnrolment(this.lookup, { id: claims.sub, mfaEnabled: account.mfaEnabled })) {
      throw new AppError("MFA_REQUIRED", { details: MFA_ENROLMENT_REQUIRED });
    }
    return true;
  }
}
