"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { TENANT_ROLES, otaPath, type TenantRole } from "@/lib/roles";
import { ERROR_MESSAGES, ROLE_LABELS, TEAM_STRINGS } from "@/lib/strings";
import { ifMatchOf, isTenantId } from "@/lib/tenant";

/**
 * The server actions of the team page (README §2 `/otas/[tenantId]/team`; platform/docs/flows/team-and-ota-admin-sso.md
 * §A and §B; PF-20, PF-21): invite, change a role, remove a member or leave, resend and revoke an invitation. Each one
 * checks the ids of the form first (a submission without them is refused without a call), calls the platform API
 * with the session and the end-user headers, and answers the portal's own text, never the API's. The role matrix of
 * scope §1.2 is the API's to enforce: the page only offers what the caller's role allows (`assignableRoles`), and a
 * refusal (`403 FORBIDDEN`) reads as a stale page. After a change the OTA's pages are rendered again, so the lists,
 * the shell and the caller's own role show the new state.
 */

type Member = components["schemas"]["Member"];

/** The outcome of a change, shown once above the table or the form that made it. */
export interface TeamNoticeState {
  readonly status: "idle" | "done" | "failed";
  /** The error code of a failure, for the page (reload and MFA links) and the tests; never shown. */
  readonly code?: PlatformErrorCode;
  readonly message?: string;
}

/**
 * The outcome of a role change. `stepUp` asks `StepUpDialog` for a TOTP code: granting `owner` needs a step-up within
 * 15 minutes (`401 REAUTH_REQUIRED`), after which the same submission runs again.
 */
export interface RoleChangeState extends TeamNoticeState {
  readonly stepUp?: true;
}

/** The fields of the invite form. */
export type InviteField = "email" | "role";

/** What the invite form shows after a submission. */
export interface InviteState {
  readonly status: "idle" | "invited" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** What the fields show: what was sent after a failure, an empty address (and the same role) after a success. */
  readonly values: Readonly<Record<InviteField, string>>;
  /** Messages per field, in the portal's own words. */
  readonly fieldErrors: Readonly<Partial<Record<InviteField, string>>>;
  /** The outcome that belongs to no field (seat limit, rate limit, a stale page, the confirmation). */
  readonly message?: string;
}

/** A member id (`MembershipId`) and an invitation id (`InvitationId`) of the platform document. */
const MEMBER_ID = /^stf_[0-9A-HJKMNP-TV-Z]{26}$/;
const INVITATION_ID = /^ivt_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A member version as the form carries it (`Member.version`, at least 1). */
const VERSION = /^[1-9][0-9]{0,14}$/;
/** `EmailAddress` of the platform document. */
const EMAIL_MAX = 254;

function isRole(value: unknown): value is TenantRole {
  return typeof value === "string" && (TENANT_ROLES as readonly string[]).includes(value);
}

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The team page of `tenantId`. */
function teamPath(tenantId: string): string {
  return otaPath(tenantId, "/team");
}

/**
 * The answers that leave the page: an ended session goes to sign-in and back to the team page (the middleware renews
 * an access token that is only expired), an unverified account to `/verify-pending`.
 */
function leaveOnSessionEnd(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: teamPath(tenantId) }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

/** The messages of a failed change that every team action shares. */
const SHARED_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  LAST_OWNER: ERROR_MESSAGES.LAST_OWNER,
  FORBIDDEN: TEAM_STRINGS.forbidden,
  RATE_LIMITED: TEAM_STRINGS.rateLimited,
  // The form's ids, the version or the role were refused: the page is out of date.
  VALIDATION_FAILED: TEAM_STRINGS.formExpired,
};

function failed(
  error: ApiError,
  messages: Readonly<Partial<Record<PlatformErrorCode, string>>>,
): TeamNoticeState {
  return {
    status: "failed",
    code: error.code,
    message: messages[error.code] ?? SHARED_MESSAGES[error.code] ?? errorMessage(error),
  };
}

const FORM_EXPIRED: TeamNoticeState = Object.freeze({
  status: "failed",
  code: "VALIDATION_FAILED",
  message: TEAM_STRINGS.formExpired,
});

/** Renders the OTA's pages again: the team lists, and the shell and overview, which show the caller's role. */
function refreshOta(tenantId: string): void {
  revalidatePath(otaPath(tenantId), "layout");
}

// ---- Members --------------------------------------------------------------------------------------------------

const ROLE_CHANGE_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  PRECONDITION_FAILED: TEAM_STRINGS.stale,
  MFA_REQUIRED: TEAM_STRINGS.mfaRequired,
  NOT_FOUND: TEAM_STRINGS.memberGone,
  REAUTH_REQUIRED: TEAM_STRINGS.stepUpCancelled,
};

/**
 * Changes the role of the member `memberId` to `role` (`updateMember`, `PATCH /v1/tenants/{tenantId}/members/{memberId}`)
 * with the member's `version` in `If-Match`, from the hidden fields `tenantId`, `memberId` and `version`. Granting
 * `owner` answers `REAUTH_REQUIRED` without a recent step-up: the state then asks for one, and `useStepUpAction` sends
 * the same submission again after the code. `LAST_OWNER`, a stale version, `MFA_REQUIRED` (the caller has no MFA) and
 * the other refusals come back as the portal's message.
 */
export async function changeMemberRole(
  _previous: RoleChangeState,
  formData: FormData,
): Promise<RoleChangeState> {
  const tenantId = text(formData, "tenantId");
  const memberId = text(formData, "memberId");
  const version = text(formData, "version");
  const role = text(formData, "role");
  if (!isTenantId(tenantId) || !MEMBER_ID.test(memberId) || !VERSION.test(version) || !isRole(role)) {
    return FORM_EXPIRED;
  }
  const api = await platformApi();
  const result = await api.PATCH("/v1/tenants/{tenantId}/members/{memberId}", {
    params: { path: { tenantId, memberId }, header: { "If-Match": ifMatchOf(Number(version)) } },
    body: { role },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    const outcome = failed(result.error, ROLE_CHANGE_MESSAGES);
    return result.error.code === "REAUTH_REQUIRED" ? { ...outcome, stepUp: true } : outcome;
  }
  const member: Member = result.data;
  refreshOta(tenantId);
  return { status: "done", message: TEAM_STRINGS.roleChanged(member.fullName, ROLE_LABELS[member.role]) };
}

const REMOVAL_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  NOT_FOUND: TEAM_STRINGS.memberGone,
};

/**
 * Removes the member `memberId` from the OTA (`removeMember`, `DELETE /v1/tenants/{tenantId}/members/{memberId}`), from
 * the hidden fields `tenantId`, `memberId` and `intent`. With `intent=leave` the caller removes themself: afterwards
 * the OTA is not theirs to see any more, so the browser goes to `/dashboard`. The last owner can neither be removed
 * nor leave (`LAST_OWNER`).
 */
export async function removeTeamMember(
  _previous: TeamNoticeState,
  formData: FormData,
): Promise<TeamNoticeState> {
  const tenantId = text(formData, "tenantId");
  const memberId = text(formData, "memberId");
  const leaving = text(formData, "intent") === "leave";
  if (!isTenantId(tenantId) || !MEMBER_ID.test(memberId)) {
    return FORM_EXPIRED;
  }
  const api = await platformApi();
  const result = await api.DELETE("/v1/tenants/{tenantId}/members/{memberId}", {
    params: { path: { tenantId, memberId } },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    return failed(result.error, REMOVAL_MESSAGES);
  }
  refreshOta(tenantId);
  if (leaving) {
    redirect("/dashboard");
  }
  return { status: "done", message: TEAM_STRINGS.removed };
}

// ---- Invitations ----------------------------------------------------------------------------------------------

const INVITATION_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  // `409 CONFLICT` with `details.reason = "not_pending"`: accepted, revoked or expired in the meantime.
  CONFLICT: TEAM_STRINGS.notPending,
  NOT_FOUND: TEAM_STRINGS.invitationGone,
};

/** The ids of an invitation change, or `undefined` when the form does not carry valid ones. */
function invitationIds(formData: FormData): { tenantId: string; invitationId: string } | undefined {
  const tenantId = text(formData, "tenantId");
  const invitationId = text(formData, "invitationId");
  return isTenantId(tenantId) && INVITATION_ID.test(invitationId) ? { tenantId, invitationId } : undefined;
}

/**
 * Sends the pending invitation `invitationId` again (`resendInvitation`): a new link that works for 7 days, and the
 * old one stops working.
 */
export async function resendTeamInvitation(
  _previous: TeamNoticeState,
  formData: FormData,
): Promise<TeamNoticeState> {
  const ids = invitationIds(formData);
  if (ids === undefined) {
    return FORM_EXPIRED;
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/invitations/{invitationId}/resend", {
    params: { path: ids },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, ids.tenantId);
    return failed(result.error, INVITATION_MESSAGES);
  }
  refreshOta(ids.tenantId);
  return { status: "done", message: TEAM_STRINGS.resent };
}

/** Revokes the pending invitation `invitationId` (`revokeInvitation`): its link stops working, its seat is free. */
export async function revokeTeamInvitation(
  _previous: TeamNoticeState,
  formData: FormData,
): Promise<TeamNoticeState> {
  const ids = invitationIds(formData);
  if (ids === undefined) {
    return FORM_EXPIRED;
  }
  const api = await platformApi();
  const result = await api.DELETE("/v1/tenants/{tenantId}/invitations/{invitationId}", {
    params: { path: ids },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, ids.tenantId);
    return failed(result.error, INVITATION_MESSAGES);
  }
  refreshOta(ids.tenantId);
  return { status: "done", message: TEAM_STRINGS.revoked };
}

const INVITE_FORM = z.object({
  email: z
    .string()
    .trim()
    .min(1, TEAM_STRINGS.emailRequired)
    .max(EMAIL_MAX, TEAM_STRINGS.emailInvalid)
    .email(TEAM_STRINGS.emailInvalid),
  role: z
    .string()
    .min(1, TEAM_STRINGS.roleRequired)
    .refine((value): value is TenantRole => isRole(value), TEAM_STRINGS.roleNotAllowed),
});

const INVITE_FIELDS: readonly InviteField[] = ["email", "role"];

function isInviteField(value: unknown): value is InviteField {
  return typeof value === "string" && (INVITE_FIELDS as readonly string[]).includes(value);
}

/** The message at a field for the API's field error on it (the API's own text is never shown). */
const API_FIELD_MESSAGES: Readonly<Record<InviteField, string>> = {
  email: TEAM_STRINGS.emailInvalid,
  role: TEAM_STRINGS.roleNotAllowed,
};

/** A whole number of `details` (`limit`, `used`), or `undefined`. */
function count(details: Readonly<Record<string, unknown>>, name: string): number | undefined {
  const value = details[name];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The problems of a refused `createInvitation`, at the fields where they belong. */
function inviteProblems(error: ApiError): Pick<InviteState, "fieldErrors" | "message"> {
  const { code } = error;
  if (code === "ALREADY_MEMBER" || code === "INVITATION_PENDING") {
    return { fieldErrors: { email: ERROR_MESSAGES[code] } };
  }
  if (code === "PLAN_LIMIT_REACHED") {
    // The seats are the plan's `staffSeats`: active members plus pending invitations (PF-20 AC2).
    const used = count(error.details, "used");
    const limit = count(error.details, "limit");
    return {
      fieldErrors: {},
      message:
        used === undefined || limit === undefined
          ? ERROR_MESSAGES.PLAN_LIMIT_REACHED
          : TEAM_STRINGS.seatLimit(used, limit),
    };
  }
  if (code === "VALIDATION_FAILED") {
    const fieldErrors: Partial<Record<InviteField, string>> = {};
    for (const fieldError of error.fieldErrors) {
      const field = fieldError.path.replace(/^\//, "");
      if (isInviteField(field) && fieldErrors[field] === undefined) {
        fieldErrors[field] = API_FIELD_MESSAGES[field];
      }
    }
    return Object.keys(fieldErrors).length > 0
      ? { fieldErrors }
      : { fieldErrors: {}, message: TEAM_STRINGS.formExpired };
  }
  // NOT_FOUND: the caller is no member of the OTA any more (TenantRoleGuard answers so for a non-member).
  const message = code === "NOT_FOUND" ? TEAM_STRINGS.notMember : SHARED_MESSAGES[code];
  return { fieldErrors: {}, message: message ?? errorMessage(error) };
}

/**
 * Invites the address of the field `email` with the role of the field `role` (`createInvitation`, `POST
 * /v1/tenants/{tenantId}/invitations`), for the OTA of the hidden field `tenantId`. The API e-mails the link (7 days)
 * and answers the invitation without its token. `ALREADY_MEMBER` and `INVITATION_PENDING` show at the address,
 * `PLAN_LIMIT_REACHED` names the seats used and the plan's limit, `FORBIDDEN` (an admin inviting an owner or an admin,
 * which the form does not offer) reads as a stale page.
 */
export async function inviteMember(previous: InviteState, formData: FormData): Promise<InviteState> {
  const values = { email: text(formData, "email"), role: text(formData, "role") };
  const tenantId = text(formData, "tenantId");
  if (!isTenantId(tenantId)) {
    return {
      status: "failed",
      code: "VALIDATION_FAILED",
      values,
      fieldErrors: {},
      message: TEAM_STRINGS.formExpired,
    };
  }
  const parsed = INVITE_FORM.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<InviteField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (isInviteField(field) && fieldErrors[field] === undefined) {
        fieldErrors[field] = issue.message;
      }
    }
    return { status: "failed", code: "VALIDATION_FAILED", values, fieldErrors };
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/invitations", {
    params: { path: { tenantId } },
    body: { email: parsed.data.email, role: parsed.data.role },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    const problems = inviteProblems(result.error);
    return {
      status: "failed",
      code: result.error.code,
      values,
      fieldErrors: problems.fieldErrors,
      ...(problems.message === undefined ? {} : { message: problems.message }),
    };
  }
  refreshOta(tenantId);
  // The next invitation starts from an empty address and the same role.
  return {
    status: "invited",
    values: { email: "", role: isRole(values.role) ? values.role : previous.values.role },
    fieldErrors: {},
    message: TEAM_STRINGS.invited,
  };
}
