// Rows ↔ API schemas of AccountsModule's own routes (PBE-016; platform/docs/api-inventory.md §5):
//
// - `AccountSession` of listSessions from an active family of `account_sessions` (SessionsRepository): the sign-in's
//   time, user agent and IP, the last refresh, and `current` for the family of the calling access token (`sid`);
// - the profile of updateMe: the columns an `UpdateMeRequest` asks for (`profileRequestOf`, the name trimmed) and the
//   ones that really change, with the before and after values of the audit row (`profileChanges`).
//
// The `Account` of getMe and updateMe is `toAccount` of auth/sessions.service.ts, the one `PortalSession.account` uses,
// so the portal sees the same account after a sign-in, a refresh and a profile change.
import type { components } from "@velexis/api-types/platform";
import type { AccountProfileChanges, ProfileAccount } from "../auth/accounts.repository";
import type { ActiveFamily } from "../auth/sessions.repository";

export type AccountSession = components["schemas"]["AccountSession"];
export type AccountSessionList = components["schemas"]["AccountSessionList"];
export type UpdateMeRequest = components["schemas"]["UpdateMeRequest"];

/** The profile fields of `UpdateMeRequest` and their columns, in the order of the schema. */
export const PROFILE_FIELDS = Object.freeze([
  ["fullName", "full_name"],
  ["locale", "locale"],
  ["timeZone", "time_zone"],
] as const satisfies ReadonlyArray<readonly [keyof UpdateMeRequest, keyof AccountProfileChanges]>);

/** One `AccountSession` for `family`; `current` when it is the family of the caller's access token. */
export function toAccountSession(family: ActiveFamily, currentFamilyId: string): AccountSession {
  return {
    familyId: family.family_id,
    audience: family.audience as AccountSession["audience"],
    userAgent: family.user_agent,
    ipAddress: family.ip_address,
    createdAt: family.signed_in_at.toISOString(),
    lastUsedAt: family.last_used_at === null ? null : family.last_used_at.toISOString(),
    current: family.family_id === currentFamilyId,
  };
}

/** The columns an update request asks for: the fields it carries, the full name trimmed. */
export function profileRequestOf(request: UpdateMeRequest): AccountProfileChanges {
  const requested: AccountProfileChanges = {};
  if (request.fullName !== undefined) {
    requested.full_name = request.fullName.trim();
  }
  if (request.locale !== undefined) {
    requested.locale = request.locale;
  }
  if (request.timeZone !== undefined) {
    requested.time_zone = request.timeZone;
  }
  return requested;
}

/** The columns to write and the audit row's `before` and `after`, by API field name. */
export interface ProfileChanges {
  readonly changes: AccountProfileChanges;
  readonly before: Readonly<Record<string, string>>;
  readonly after: Readonly<Record<string, string>>;
}

/** What `requested` changes in `current`: only fields whose value differs; `undefined` when nothing does. */
export function profileChanges(
  current: Pick<ProfileAccount, "full_name" | "locale" | "time_zone">,
  requested: AccountProfileChanges,
): ProfileChanges | undefined {
  const changes: AccountProfileChanges = {};
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const [field, column] of PROFILE_FIELDS) {
    const value = requested[column];
    if (value !== undefined && value !== current[column]) {
      changes[column] = value;
      before[field] = current[column];
      after[field] = value;
    }
  }
  return Object.keys(changes).length === 0 ? undefined : { changes, before, after };
}
