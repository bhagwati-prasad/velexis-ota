"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import Link from "next/link";
import {
  createContext,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  changeMemberRole,
  removeTeamMember,
  resendTeamInvitation,
  revokeTeamInvitation,
  type RoleChangeState,
  type TeamNoticeState,
} from "@/app/(app)/otas/[tenantId]/team/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { assignableRoles, canManageRole, otaPath, type TenantRole } from "@/lib/roles";
import { ROLE_LABELS, TEAM_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The tables of the team page (README §2 `/otas/[tenantId]/team`, §4; PF-20, PF-21): `MembersTable` lists the members
 * with a role selector, "Remove" and "Leave"; `InvitationsTable` lists the pending invitations with "Send again" and
 * "Revoke". Each offers only what the caller's role allows (`canManageRole`, `assignableRoles` of scope §1.2): an admin
 * never sees `owner` or `admin` in a selector, and members who are owners or admins have no selector or "Remove" for
 * an admin. The API checks every change again. Granting `owner` asks for a TOTP code first (`StepUpDialog`); removing
 * someone, leaving and revoking ask for a confirmation (`ConfirmDialog`). Nothing here is secret.
 *
 * The columns are module constants and their cells read the table's state from a context: TanStack's `flexRender`
 * renders a cell function as a component, so columns made again on every render would remount every cell (and drop a
 * role being picked) whenever a change starts or ends.
 */

type Member = components["schemas"]["Member"];
type Invitation = components["schemas"]["Invitation"];

/** A change that has not run yet. */
const IDLE: TeamNoticeState = Object.freeze({ status: "idle" });
const IDLE_ROLE_CHANGE: RoleChangeState = IDLE;

/** The codes after which the page shows a stale state: a reload shows the current team. */
const RELOAD_CODES: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "PRECONDITION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "FORBIDDEN",
  "VALIDATION_FAILED",
]);

/** The outcome of the last change of a table: a status message after a change, an alert after a refusal. */
function TeamNotice({ state, tenantId }: { readonly state: TeamNoticeState; readonly tenantId: string }) {
  if (state.status === "idle" || state.message === undefined) {
    return null;
  }
  if (state.status === "done") {
    return (
      <p role="status" data-notice="done" className="rounded-lg border px-4 py-3 text-sm font-medium">
        {state.message}
      </p>
    );
  }
  let next: ReactNode = null;
  if (state.code === "MFA_REQUIRED") {
    next = (
      <Link href="/account/security" className="font-medium underline underline-offset-4">
        {TEAM_STRINGS.mfaLink}
      </Link>
    );
  } else if (state.code !== undefined && RELOAD_CODES.has(state.code)) {
    // A full reload, so the lists and their versions are the current ones.
    next = (
      <a href={otaPath(tenantId, "/team")} className="font-medium underline underline-offset-4">
        {TEAM_STRINGS.reload}
      </a>
    );
  }
  return (
    <Alert variant="destructive" data-notice="failed" data-code={state.code}>
      <AlertDescription>
        <p>{state.message}</p>
        {next === null ? null : <p>{next}</p>}
      </AlertDescription>
    </Alert>
  );
}

// ---- Members ----------------------------------------------------------------------------------------------------

/** What the cells of `MembersTable` need: the caller, the open changes and how to start one. */
interface MembersTableState {
  readonly tenantId: string;
  readonly callerRole: TenantRole;
  /** The roles the caller may give (`assignableRoles`). */
  readonly roles: readonly TenantRole[];
  readonly selfAccountId: string | undefined;
  readonly timeZone: string;
  /** A role change is on its way (or waits for its step-up). */
  readonly changing: boolean;
  /** A removal is on its way. */
  readonly removing: boolean;
  readonly changeRole: (formData: FormData) => void;
  readonly remove: (member: Member, intent: "remove" | "leave") => void;
}

const MembersTableContext = createContext<MembersTableState | null>(null);

function useMembersTable(): MembersTableState {
  const state = useContext(MembersTableContext);
  if (state === null) {
    throw new Error("A members table cell renders outside MembersTable.");
  }
  return state;
}

const SELECT_CLASSES = cn(
  "border-input flex h-8 min-w-0 rounded-md border bg-transparent px-2 py-1 text-sm shadow-xs outline-none",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/** The id of a member's role selector. */
function roleSelectId(memberId: string): string {
  return `member-role-${memberId}`;
}

/**
 * A member's role selector and its button. The row is keyed by the member's version, so the selector starts from the
 * saved role again after every change; "Change role" stays disabled until another role is picked.
 */
function RoleForm({ member }: { readonly member: Member }) {
  const { tenantId, roles, changing, changeRole } = useMembersTable();
  const [role, setRole] = useState<TenantRole>(member.role);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    // Sent by hand, not through `action`, so React never resets the selector behind the person's back.
    event.preventDefault();
    if (!changing && role !== member.role) {
      changeRole(new FormData(event.currentTarget));
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2" data-role-form={member.id}>
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="memberId" value={member.id} />
      <input type="hidden" name="version" value={String(member.version)} />
      <label htmlFor={roleSelectId(member.id)} className="sr-only">
        {TEAM_STRINGS.roleOf(member.fullName)}
      </label>
      <select
        id={roleSelectId(member.id)}
        name="role"
        value={role}
        onChange={(event) => setRole(event.target.value as TenantRole)}
        className={SELECT_CLASSES}
      >
        {roles.map((option) => (
          <option key={option} value={option}>
            {ROLE_LABELS[option]}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" variant="outline" disabled={changing || role === member.role}>
        {TEAM_STRINGS.changeRole}
        <span className="sr-only">{TEAM_STRINGS.changeRoleOf(member.fullName)}</span>
      </Button>
    </form>
  );
}

function MemberNameCell({ member }: { readonly member: Member }) {
  const { selfAccountId } = useMembersTable();
  return (
    <span className="font-medium">
      {member.fullName}
      {member.accountId === selfAccountId ? (
        <span className="ml-1 font-normal text-muted-foreground" data-self="true">
          {TEAM_STRINGS.you}
        </span>
      ) : null}
    </span>
  );
}

function MemberRoleCell({ member }: { readonly member: Member }) {
  const { callerRole } = useMembersTable();
  return canManageRole(callerRole, member.role) ? (
    <RoleForm member={member} />
  ) : (
    <span data-role={member.role}>{ROLE_LABELS[member.role]}</span>
  );
}

function MemberJoinedCell({ member }: { readonly member: Member }) {
  const { timeZone } = useMembersTable();
  return <DateTime value={member.createdAt} mode="date" timeZone={timeZone} />;
}

/** "Leave" on the caller's own row; "Remove" on the rows the caller's role may manage; nothing elsewhere. */
function MemberActionsCell({ member }: { readonly member: Member }) {
  const { callerRole, selfAccountId, removing, remove } = useMembersTable();
  if (member.accountId === selfAccountId) {
    return (
      <ConfirmDialog
        trigger={
          <Button type="button" size="sm" variant="outline" disabled={removing}>
            {TEAM_STRINGS.leave}
          </Button>
        }
        title={TEAM_STRINGS.leaveTitle}
        description={TEAM_STRINGS.leaveDescription}
        confirmLabel={TEAM_STRINGS.leaveConfirm}
        onConfirm={() => remove(member, "leave")}
      />
    );
  }
  if (!canManageRole(callerRole, member.role)) {
    return null;
  }
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" size="sm" variant="outline" disabled={removing}>
          {TEAM_STRINGS.remove}
          <span className="sr-only">{TEAM_STRINGS.removeWho(member.fullName)}</span>
        </Button>
      }
      title={TEAM_STRINGS.removeTitle(member.fullName)}
      description={TEAM_STRINGS.removeDescription}
      confirmLabel={TEAM_STRINGS.removeConfirm}
      onConfirm={() => remove(member, "remove")}
    />
  );
}

const MEMBER_COLUMNS: ColumnDef<Member>[] = [
  { id: "name", header: TEAM_STRINGS.name, cell: ({ row }) => <MemberNameCell member={row.original} /> },
  { id: "email", header: TEAM_STRINGS.email, cell: ({ row }) => row.original.email },
  { id: "role", header: TEAM_STRINGS.role, cell: ({ row }) => <MemberRoleCell member={row.original} /> },
  {
    id: "mfa",
    header: TEAM_STRINGS.mfa,
    cell: ({ row }) => (row.original.mfaEnabled ? TEAM_STRINGS.mfaOn : TEAM_STRINGS.mfaOff),
  },
  {
    id: "joined",
    header: TEAM_STRINGS.joined,
    cell: ({ row }) => <MemberJoinedCell member={row.original} />,
  },
  {
    id: "actions",
    header: TEAM_STRINGS.actions,
    cell: ({ row }) => <MemberActionsCell member={row.original} />,
  },
];

/** The version in the row id: a changed member's row starts again from its saved role. */
const memberRowId = (member: Member): string => `${member.id}:${member.version}`;

export interface MembersTableProps {
  readonly tenantId: string;
  /** The active members of `listMembers`, oldest first. */
  readonly members: readonly Member[];
  /** The caller's role in the OTA (`getTenant` `myRole`). */
  readonly callerRole: TenantRole;
  /** The signed-in account (`getMe`): its row is marked and offers "Leave". Unknown when `getMe` failed. */
  readonly selfAccountId?: string | undefined;
  /** The time zone of the dates (the account's); UTC by default. */
  readonly timeZone?: string | undefined;
}

/** The members of the OTA, with the changes the caller's role allows. */
export function MembersTable({ tenantId, members, callerRole, selfAccountId, timeZone }: MembersTableProps) {
  const roleChange = useStepUpAction(changeMemberRole, IDLE_ROLE_CHANGE);
  const [removal, dispatchRemoval, removing] = useActionState(removeTeamMember, IDLE);
  // The notice of the change made last; the older notice of the other kind goes.
  const [latest, setLatest] = useState<"role" | "removal">("role");
  const { dispatch: dispatchRoleChange, isPending: changing } = roleChange;

  const changeRole = useCallback(
    (formData: FormData) => {
      setLatest("role");
      dispatchRoleChange(formData);
    },
    [dispatchRoleChange],
  );
  const remove = useCallback(
    (member: Member, intent: "remove" | "leave") => {
      const formData = new FormData();
      formData.set("tenantId", tenantId);
      formData.set("memberId", member.id);
      formData.set("intent", intent);
      setLatest("removal");
      startTransition(() => dispatchRemoval(formData));
    },
    [tenantId, dispatchRemoval],
  );
  const context = useMemo<MembersTableState>(
    () => ({
      tenantId,
      callerRole,
      roles: assignableRoles(callerRole),
      selfAccountId,
      timeZone: timeZone ?? "UTC",
      changing,
      removing,
      changeRole,
      remove,
    }),
    [tenantId, callerRole, selfAccountId, timeZone, changing, removing, changeRole, remove],
  );

  return (
    <MembersTableContext.Provider value={context}>
      <div className="grid gap-4">
        <TeamNotice state={latest === "role" ? roleChange.state : removal} tenantId={tenantId} />
        <DataTable
          columns={MEMBER_COLUMNS}
          data={members}
          caption={TEAM_STRINGS.membersCaption}
          emptyMessage={TEAM_STRINGS.membersEmpty}
          getRowId={memberRowId}
        />
      </div>
      {roleChange.stepUpDialog}
    </MembersTableContext.Provider>
  );
}

// ---- Invitations ------------------------------------------------------------------------------------------------

/** What the cells of `InvitationsTable` need. */
interface InvitationsTableState {
  readonly callerRole: TenantRole;
  readonly timeZone: string;
  readonly resending: boolean;
  readonly revoking: boolean;
  readonly resend: (invitation: Invitation) => void;
  readonly revoke: (invitation: Invitation) => void;
}

const InvitationsTableContext = createContext<InvitationsTableState | null>(null);

function useInvitationsTable(): InvitationsTableState {
  const state = useContext(InvitationsTableContext);
  if (state === null) {
    throw new Error("An invitations table cell renders outside InvitationsTable.");
  }
  return state;
}

function InvitationExpiresCell({ invitation }: { readonly invitation: Invitation }) {
  const { timeZone } = useInvitationsTable();
  return <DateTime value={invitation.expiresAt} timeZone={timeZone} />;
}

/** "Send again" and "Revoke" for the invitations whose role the caller may manage. */
function InvitationActionsCell({ invitation }: { readonly invitation: Invitation }) {
  const { callerRole, resending, revoking, resend, revoke } = useInvitationsTable();
  if (!canManageRole(callerRole, invitation.role)) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={resending}
        onClick={() => resend(invitation)}
      >
        {TEAM_STRINGS.resend}
        <span className="sr-only">{TEAM_STRINGS.invitationTo(invitation.email)}</span>
      </Button>
      <ConfirmDialog
        trigger={
          <Button type="button" size="sm" variant="outline" disabled={revoking}>
            {TEAM_STRINGS.revoke}
            <span className="sr-only">{TEAM_STRINGS.invitationTo(invitation.email)}</span>
          </Button>
        }
        title={TEAM_STRINGS.revokeTitle}
        description={TEAM_STRINGS.revokeDescription(invitation.email)}
        confirmLabel={TEAM_STRINGS.revokeConfirm}
        onConfirm={() => revoke(invitation)}
      />
    </div>
  );
}

const INVITATION_COLUMNS: ColumnDef<Invitation>[] = [
  { id: "email", header: TEAM_STRINGS.email, cell: ({ row }) => row.original.email },
  {
    id: "role",
    header: TEAM_STRINGS.role,
    cell: ({ row }) => <span data-role={row.original.role}>{ROLE_LABELS[row.original.role]}</span>,
  },
  {
    id: "invitedBy",
    header: TEAM_STRINGS.invitedBy,
    cell: ({ row }) => row.original.invitedBy?.fullName ?? TEAM_STRINGS.formerMember,
  },
  {
    id: "expires",
    header: TEAM_STRINGS.expires,
    cell: ({ row }) => <InvitationExpiresCell invitation={row.original} />,
  },
  {
    id: "actions",
    header: TEAM_STRINGS.actions,
    cell: ({ row }) => <InvitationActionsCell invitation={row.original} />,
  },
];

const invitationRowId = (invitation: Invitation): string => invitation.id;

export interface InvitationsTableProps {
  readonly tenantId: string;
  /** The pending invitations of `listInvitations`, newest first. */
  readonly invitations: readonly Invitation[];
  /** The caller's role in the OTA; only owners resend or revoke invitations for owners and admins. */
  readonly callerRole: TenantRole;
  /** The time zone of the expiry (the account's); UTC by default. */
  readonly timeZone?: string | undefined;
}

/** The pending invitations, with "Send again" and "Revoke" where the caller's role allows them. */
export function InvitationsTable({ tenantId, invitations, callerRole, timeZone }: InvitationsTableProps) {
  const [resent, dispatchResend, resending] = useActionState(resendTeamInvitation, IDLE);
  const [revoked, dispatchRevoke, revoking] = useActionState(revokeTeamInvitation, IDLE);
  const [latest, setLatest] = useState<"resend" | "revoke">("resend");

  const idsOf = useCallback(
    (invitation: Invitation): FormData => {
      const formData = new FormData();
      formData.set("tenantId", tenantId);
      formData.set("invitationId", invitation.id);
      return formData;
    },
    [tenantId],
  );
  const resend = useCallback(
    (invitation: Invitation) => {
      setLatest("resend");
      startTransition(() => dispatchResend(idsOf(invitation)));
    },
    [idsOf, dispatchResend],
  );
  const revoke = useCallback(
    (invitation: Invitation) => {
      setLatest("revoke");
      startTransition(() => dispatchRevoke(idsOf(invitation)));
    },
    [idsOf, dispatchRevoke],
  );
  const context = useMemo<InvitationsTableState>(
    () => ({ callerRole, timeZone: timeZone ?? "UTC", resending, revoking, resend, revoke }),
    [callerRole, timeZone, resending, revoking, resend, revoke],
  );

  return (
    <InvitationsTableContext.Provider value={context}>
      <div className="grid gap-4">
        <TeamNotice state={latest === "resend" ? resent : revoked} tenantId={tenantId} />
        <DataTable
          columns={INVITATION_COLUMNS}
          data={invitations}
          caption={TEAM_STRINGS.invitationsCaption}
          emptyMessage={TEAM_STRINGS.invitationsEmpty}
          getRowId={invitationRowId}
        />
      </div>
    </InvitationsTableContext.Provider>
  );
}
