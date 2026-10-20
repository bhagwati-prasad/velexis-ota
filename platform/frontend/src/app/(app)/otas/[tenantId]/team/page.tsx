import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { InviteForm } from "@/components/invite-form";
import { InvitationsTable, MembersTable } from "@/components/members-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { TEAM_STRINGS } from "@/lib/strings";
import { isTenantId, requireTenant } from "@/lib/tenant";

export const metadata: Metadata = { title: TEAM_STRINGS.title };

type MemberList = components["schemas"]["MemberList"];
type InvitationList = components["schemas"]["InvitationList"];
type Account = components["schemas"]["Account"];

/**
 * `listMembers` (any member) for the OTA, next to the tenant's load; an id that is no OTA id makes no call (the
 * tenant's load renders the not-found page for it).
 */
async function loadMembers(tenantId: string): Promise<ApiResult<MemberList> | undefined> {
  if (!isTenantId(tenantId)) {
    return undefined;
  }
  const api = await platformApi();
  return api.GET("/v1/tenants/{tenantId}/members", { params: { path: { tenantId } } });
}

/** `getMe`, for the caller's own row ("Leave") and the account's time zone of the dates. */
async function loadAccount(tenantId: string): Promise<ApiResult<Account> | undefined> {
  if (!isTenantId(tenantId)) {
    return undefined;
  }
  const api = await platformApi();
  return api.GET("/v1/me");
}

/** `listInvitations` (owners and admins only: the API refuses other roles with `403`). */
async function loadInvitations(tenantId: string): Promise<ApiResult<InvitationList>> {
  const api = await platformApi();
  return api.GET("/v1/tenants/{tenantId}/invitations", { params: { path: { tenantId } } });
}

/** Answers that mean the session is over: sign in again. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/** An ended session goes to sign-in and back to the team page, an unverified account to `/verify-pending`. */
function leaveOnSessionEnd(error: ApiError | undefined, tenantId: string): void {
  if (error === undefined) {
    return;
  }
  if (SESSION_ENDED.has(error.code)) {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/team") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

/** The portal's message for a list that could not be loaded, in place of the list. */
function Unavailable({ title, error }: { readonly title: string; readonly error: ApiError }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  );
}

/**
 * `/otas/[tenantId]/team` (README §2 Signed in; flows/team-and-ota-admin-sso.md §A, §B; PF-20, PF-21): every member
 * sees the team; owners and admins also change roles, remove members, see the pending invitations (resend, revoke)
 * and invite people. The tenant (and the caller's role) comes from the layout's `getTenant`, the members from
 * `listMembers`, the caller's own account from `getMe` (its row offers "Leave"); `listInvitations` is called only for
 * the roles that may manage the team. A list that cannot be loaded shows the portal's message in its place.
 */
export default async function TeamPage({ params }: Readonly<{ params: Promise<{ tenantId: string }> }>) {
  const { tenantId } = await params;
  const [loaded, members, account] = await Promise.all([
    requireTenant(tenantId),
    loadMembers(tenantId),
    loadAccount(tenantId),
  ]);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  const manager = can(tenant.myRole, "manageTeam");
  const invitations = manager ? await loadInvitations(tenant.id) : undefined;
  for (const result of [members, account, invitations]) {
    leaveOnSessionEnd(result?.error, tenant.id);
  }
  const me = account?.data;

  return (
    <div className="mx-auto grid max-w-5xl gap-10">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{TEAM_STRINGS.title}</h1>
        <p className="text-muted-foreground">{TEAM_STRINGS.intro}</p>
        {manager ? null : (
          <p className="rounded-lg border px-4 py-3 text-sm" data-notice="read-only">
            {TEAM_STRINGS.readOnly}
          </p>
        )}
      </div>

      <section aria-labelledby="team-members" className="grid gap-4">
        <h2 id="team-members" className="text-xl font-semibold tracking-tight">
          {TEAM_STRINGS.membersTitle}
        </h2>
        {members === undefined ? null : members.error !== undefined ? (
          <Unavailable title={TEAM_STRINGS.membersUnavailableTitle} error={members.error} />
        ) : (
          <MembersTable
            tenantId={tenant.id}
            members={members.data.data}
            callerRole={tenant.myRole}
            selfAccountId={me?.id}
            timeZone={me?.timeZone}
          />
        )}
      </section>

      {manager ? (
        <>
          <section aria-labelledby="team-invite" className="grid max-w-2xl gap-4">
            <div className="grid gap-1">
              <h2 id="team-invite" className="text-xl font-semibold tracking-tight">
                {TEAM_STRINGS.inviteTitle}
              </h2>
              <p className="text-sm text-muted-foreground">{TEAM_STRINGS.inviteIntro}</p>
            </div>
            <InviteForm tenantId={tenant.id} callerRole={tenant.myRole} />
          </section>

          <section aria-labelledby="team-invitations" className="grid gap-4">
            <div className="grid gap-1">
              <h2 id="team-invitations" className="text-xl font-semibold tracking-tight">
                {TEAM_STRINGS.invitationsTitle}
              </h2>
              <p className="text-sm text-muted-foreground">{TEAM_STRINGS.invitationsIntro}</p>
            </div>
            {invitations === undefined ? null : invitations.error !== undefined ? (
              <Unavailable title={TEAM_STRINGS.invitationsUnavailableTitle} error={invitations.error} />
            ) : (
              <InvitationsTable
                tenantId={tenant.id}
                invitations={invitations.data.data}
                callerRole={tenant.myRole}
                timeZone={me?.timeZone}
              />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
