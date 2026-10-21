"use client";

import Link from "next/link";
import { useId, useState } from "react";

import { grantAdmin, revokeAdmin, type AdminActionState } from "@/app/(app)/admins/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DateTime } from "@/components/date-time";
import { ReasonDialog } from "@/components/reason-dialog";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ADMIN_LIST_STRINGS as S } from "@/lib/strings";

/** Whether a row's rights can be revoked here: never one's own, never the last admin's (PF-86). */
export type RevokeRule = "allowed" | "self" | "last_admin";

/** One platform admin as the list shows it. */
export interface AdminRow {
  readonly accountId: string;
  readonly email: string;
  readonly fullName: string;
  readonly mfaEnabled: boolean;
  readonly lastLoginAt: string | null;
  readonly revoke: RevokeRule;
}

const IDLE: AdminActionState = { status: "idle" };

function Outcome({ state }: { readonly state: AdminActionState | undefined }) {
  if (state === undefined || state.status === "idle") {
    return null;
  }
  if (state.status === "failed") {
    return (
      <Alert variant="destructive" data-notice="failed" data-code={state.code}>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <p
      role="status"
      data-notice="done"
      data-account={state.accountId}
      className="rounded-lg border px-4 py-3 text-sm font-medium"
    >
      {state.action === "grant" ? S.granted(state.name) : S.revoked(state.name)}
    </p>
  );
}

/** The e-mail field of the grant dialog; its value travels in the dialog's `FormData` with the reason. */
function EmailField() {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{S.emailLabel}</Label>
      <p id={hintId} className="text-sm text-muted-foreground">
        {S.emailHint}
      </p>
      <Input
        id={id}
        name="email"
        type="email"
        maxLength={254}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={hintId}
      />
    </div>
  );
}

/** The note next to a revoke button that is disabled. */
const REVOKE_NOTES: Readonly<Record<Exclude<RevokeRule, "allowed">, string>> = {
  self: S.selfNote,
  last_admin: S.lastAdminNote,
};

export interface AdminListProps {
  /** The platform admins, by name, each with whether it can be revoked here. */
  readonly admins: readonly AdminRow[];
}

/**
 * The platform admins and their two actions (README §2 `/admins`, PF-86):
 *
 * - **Grant admin rights** (`ReasonDialog` with the account's e-mail address; the API asks for the step-up, so
 *   `StepUpDialog` follows and the same address and reason go again);
 * - **Revoke** per row (`ConfirmDialog`, then the step-up the API asks for). The button is disabled, with a note, on
 *   the admin's own row and on the last admin's: revoking oneself is not offered.
 *
 * The outcome of the last action stays above the table while the revalidated page shows the admins as they are now.
 */
export function AdminList({ admins }: AdminListProps) {
  const grant = useStepUpAction(grantAdmin, IDLE);
  const revoke = useStepUpAction(revokeAdmin, IDLE);
  const [latest, setLatest] = useState<"grant" | "revoke" | undefined>(undefined);
  const pending = grant.isPending || revoke.isPending;
  const outcome = latest === "grant" ? grant.state : latest === "revoke" ? revoke.state : undefined;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <ReasonDialog
          trigger={<Button disabled={pending}>{S.grant}</Button>}
          title={S.grantTitle}
          description={S.grantDescription}
          confirmLabel={S.grantConfirm}
          destructive={false}
          onConfirm={(formData) => {
            setLatest("grant");
            grant.dispatch(formData);
          }}
        >
          <EmailField />
        </ReasonDialog>
        {pending ? <span className="text-sm text-muted-foreground">{S.working}</span> : null}
      </div>
      <Outcome state={outcome} />
      {admins.length === 0 ? (
        <p className="text-sm text-muted-foreground">{S.empty}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{S.caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{S.columnName}</TableHead>
              <TableHead scope="col">{S.columnEmail}</TableHead>
              <TableHead scope="col">{S.columnMfa}</TableHead>
              <TableHead scope="col">{S.columnLastLogin}</TableHead>
              <TableHead scope="col">{S.columnAction}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {admins.map((admin) => {
              const noteId = `revoke-note-${admin.accountId}`;
              return (
                <TableRow key={admin.accountId} className="align-top" data-admin={admin.accountId}>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/accounts/${encodeURIComponent(admin.accountId)}`}
                        className="font-medium underline-offset-4 hover:underline focus-visible:underline"
                      >
                        {admin.fullName}
                      </Link>
                      {admin.revoke === "self" ? <Badge variant="secondary">{S.you}</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell className="break-all">{admin.email}</TableCell>
                  <TableCell>
                    {admin.mfaEnabled ? S.mfaOn : <span className="text-muted-foreground">{S.mfaOff}</span>}
                  </TableCell>
                  <TableCell>
                    {admin.lastLoginAt === null ? (
                      <span className="text-muted-foreground">{S.never}</span>
                    ) : (
                      <DateTime value={admin.lastLoginAt} />
                    )}
                  </TableCell>
                  <TableCell>
                    {admin.revoke === "allowed" ? (
                      <ConfirmDialog
                        trigger={
                          <Button variant="outline" size="sm" disabled={pending}>
                            {S.revoke}
                            <span className="sr-only">{S.revokeSuffix(admin.fullName)}</span>
                          </Button>
                        }
                        title={S.revokeTitle(admin.fullName)}
                        description={S.revokeDescription}
                        confirmLabel={S.revokeConfirm}
                        onConfirm={() => {
                          const formData = new FormData();
                          formData.set("accountId", admin.accountId);
                          formData.set("name", admin.fullName);
                          setLatest("revoke");
                          revoke.dispatch(formData);
                        }}
                      />
                    ) : (
                      <span className="grid gap-1">
                        <Button variant="outline" size="sm" disabled aria-describedby={noteId}>
                          {S.revoke}
                          <span className="sr-only">{S.revokeSuffix(admin.fullName)}</span>
                        </Button>
                        <span
                          id={noteId}
                          className="max-w-48 text-xs whitespace-normal text-muted-foreground"
                        >
                          {REVOKE_NOTES[admin.revoke]}
                        </span>
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {grant.stepUpDialog}
      {revoke.stepUpDialog}
    </div>
  );
}
