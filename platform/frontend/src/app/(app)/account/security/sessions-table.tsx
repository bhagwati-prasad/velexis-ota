"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { components } from "@velexis/api-types/platform";
import {
  createContext,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import {
  revokeAccountSession,
  signOutEverywhere,
  type SessionsState,
} from "@/app/(app)/account/security/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SECURITY_STRINGS } from "@/lib/strings";

/**
 * The sessions of `/account/security` (README §2; PF-06): every active refresh family of the account (`listSessions`:
 * portal and platform admin, newest sign-in first) with its device, where it signs in to, the IP address and the
 * times of the sign-in and the last use. The session of this browser (`current`) is marked and has no "Revoke": it
 * ends with "Sign out". Revoking another session asks in a `ConfirmDialog` and removes its row [PF-06 AC1]; "Sign out
 * everywhere" asks too, ends every session (this one included) and goes to sign-in [PF-06 AC2].
 *
 * The columns are module constants whose cells read the table's state from a context, as in `MembersTable`, so a
 * revocation that starts or ends never remounts the cells.
 */

type AccountSession = components["schemas"]["AccountSession"];

const IDLE: SessionsState = Object.freeze({ status: "idle" });

/** Browsers by a token of their user agent, most specific first (Edge and Opera also name Chrome and Safari). */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

/** Operating systems by a token of the user agent; Android names Linux, iOS names Mac OS X, so they come first. */
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b|\biPad\b|\biPod\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMacintosh\b|\bMac OS X\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

function firstMatch(userAgent: string, table: readonly (readonly [RegExp, string])[]): string | undefined {
  return table.find(([pattern]) => pattern.test(userAgent))?.[1];
}

/**
 * The device of a session in words, from the user agent of its sign-in ("Safari on macOS", "Firefox on Windows"); the
 * browser or the system alone when only one is known, "Unknown device" otherwise. The user agent is the browser's
 * own claim: the words help a person recognise a session, they prove nothing.
 */
export function deviceOf(userAgent: string | null): string {
  if (userAgent === null || userAgent === "") {
    return SECURITY_STRINGS.unknownDevice;
  }
  const browser = firstMatch(userAgent, BROWSERS);
  const system = firstMatch(userAgent, SYSTEMS);
  if (browser !== undefined && system !== undefined) {
    return SECURITY_STRINGS.deviceOn(browser, system);
  }
  return browser ?? system ?? SECURITY_STRINGS.unknownDevice;
}

/** What the cells need: the time zone of the dates, whether a revocation runs, and how to start one. */
interface SessionsTableState {
  readonly timeZone: string;
  readonly revoking: boolean;
  readonly revoke: (session: AccountSession) => void;
}

const SessionsTableContext = createContext<SessionsTableState | null>(null);

function useSessionsTable(): SessionsTableState {
  const state = useContext(SessionsTableContext);
  if (state === null) {
    throw new Error("A sessions table cell renders outside SessionsTable.");
  }
  return state;
}

function DeviceCell({ session }: { readonly session: AccountSession }) {
  return (
    <span className="grid gap-0.5" title={session.userAgent ?? undefined}>
      <span className="font-medium">{deviceOf(session.userAgent)}</span>
      {session.current ? (
        <span className="text-sm text-muted-foreground" data-current="true">
          {SECURITY_STRINGS.thisBrowser}
        </span>
      ) : null}
    </span>
  );
}

function SignedInCell({ session }: { readonly session: AccountSession }) {
  const { timeZone } = useSessionsTable();
  return <DateTime value={session.createdAt} timeZone={timeZone} />;
}

function LastUsedCell({ session }: { readonly session: AccountSession }) {
  const { timeZone } = useSessionsTable();
  return session.lastUsedAt === null ? (
    <span className="text-muted-foreground">{SECURITY_STRINGS.notUsedYet}</span>
  ) : (
    <DateTime value={session.lastUsedAt} timeZone={timeZone} />
  );
}

/** "Revoke" for every session but this browser's, which ends with "Sign out". */
function ActionsCell({ session }: { readonly session: AccountSession }) {
  const { revoking, revoke } = useSessionsTable();
  if (session.current) {
    return null;
  }
  const device = deviceOf(session.userAgent);
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" size="sm" variant="outline" disabled={revoking}>
          {SECURITY_STRINGS.revoke}
          <span className="sr-only">{SECURITY_STRINGS.revokeWhich(device)}</span>
        </Button>
      }
      title={SECURITY_STRINGS.revokeTitle}
      description={SECURITY_STRINGS.revokeDescription(device)}
      confirmLabel={SECURITY_STRINGS.revokeConfirm}
      onConfirm={() => revoke(session)}
    />
  );
}

const COLUMNS: ColumnDef<AccountSession>[] = [
  { id: "device", header: SECURITY_STRINGS.device, cell: ({ row }) => <DeviceCell session={row.original} /> },
  {
    id: "audience",
    header: SECURITY_STRINGS.signedInTo,
    cell: ({ row }) => SECURITY_STRINGS.audiences[row.original.audience] ?? row.original.audience,
  },
  {
    id: "ipAddress",
    header: SECURITY_STRINGS.ipAddress,
    cell: ({ row }) => row.original.ipAddress ?? SECURITY_STRINGS.unknownIp,
  },
  {
    id: "signedIn",
    header: SECURITY_STRINGS.signedInAt,
    cell: ({ row }) => <SignedInCell session={row.original} />,
  },
  {
    id: "lastUsed",
    header: SECURITY_STRINGS.lastUsed,
    cell: ({ row }) => <LastUsedCell session={row.original} />,
  },
  {
    id: "actions",
    header: SECURITY_STRINGS.actions,
    cell: ({ row }) => <ActionsCell session={row.original} />,
  },
];

const sessionRowId = (session: AccountSession): string => session.familyId;

/** The outcome of the latest revocation or sign-out: a status message, or an alert with a reload link. */
function SessionsNotice({ state }: { readonly state: SessionsState }) {
  if (state.status === "idle" || state.message === undefined) {
    return null;
  }
  if (state.status === "revoked" || state.status === "gone") {
    return (
      <p role="status" data-notice="done" className="rounded-lg border px-4 py-3 text-sm font-medium">
        {state.message}
      </p>
    );
  }
  return (
    <Alert variant="destructive" data-notice="failed" data-code={state.code}>
      <AlertDescription>
        <p>{state.message}</p>
        <p>
          <a href="/account/security" className="font-medium underline underline-offset-4">
            {SECURITY_STRINGS.sessionsReload}
          </a>
        </p>
      </AlertDescription>
    </Alert>
  );
}

export interface SessionsTableProps {
  /** The active sessions of `listSessions`, newest sign-in first. */
  readonly sessions: readonly AccountSession[];
  /** The time zone of the dates (the account's). */
  readonly timeZone: string;
}

/** The sessions table and the revocation of one session. */
export function SessionsTable({ sessions, timeZone }: SessionsTableProps) {
  const [revocation, dispatchRevocation, revoking] = useActionState(revokeAccountSession, IDLE);
  // The sessions revoked here (or found already ended): their rows go at once, before the page is rendered again.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [seen, setSeen] = useState(revocation);
  if (seen !== revocation) {
    setSeen(revocation);
    const { familyId } = revocation;
    if ((revocation.status === "revoked" || revocation.status === "gone") && familyId !== undefined) {
      setRemoved((previous) => new Set([...previous, familyId]));
    }
  }

  const revoke = useCallback(
    (session: AccountSession) => {
      const formData = new FormData();
      formData.set("familyId", session.familyId);
      startTransition(() => dispatchRevocation(formData));
    },
    [dispatchRevocation],
  );
  const context = useMemo<SessionsTableState>(
    () => ({ timeZone, revoking, revoke }),
    [timeZone, revoking, revoke],
  );
  const rows = useMemo(
    () => sessions.filter((session) => !removed.has(session.familyId)),
    [sessions, removed],
  );

  return (
    <SessionsTableContext.Provider value={context}>
      <div className="grid gap-4">
        <SessionsNotice state={revocation} />
        <DataTable
          columns={COLUMNS}
          data={rows}
          caption={SECURITY_STRINGS.sessionsCaption}
          emptyMessage={SECURITY_STRINGS.sessionsEmpty}
          getRowId={sessionRowId}
        />
      </div>
    </SessionsTableContext.Provider>
  );
}

/** "Sign out everywhere": every session of the account ends, this one included, and the browser goes to sign-in. */
export function SignOutEverywhere() {
  const [state, dispatch, pending] = useActionState(signOutEverywhere, IDLE);
  return (
    <div className="grid gap-3">
      <SessionsNotice state={state} />
      <div>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="outline" disabled={pending}>
              {pending ? SECURITY_STRINGS.signingOutEverywhere : SECURITY_STRINGS.signOutEverywhere}
            </Button>
          }
          title={SECURITY_STRINGS.signOutEverywhereTitle}
          description={SECURITY_STRINGS.signOutEverywhereDescription}
          confirmLabel={SECURITY_STRINGS.signOutEverywhereConfirm}
          onConfirm={() => startTransition(() => dispatch(new FormData()))}
        />
      </div>
    </div>
  );
}
