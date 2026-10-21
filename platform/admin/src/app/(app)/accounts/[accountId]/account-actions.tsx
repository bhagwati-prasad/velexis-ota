"use client";

import type { components } from "@velexis/api-types/platform";
import { useState } from "react";

import {
  disableAccount,
  enableAccount,
  resetAccountMfa,
  unlockAccount,
  type AccountActionKind,
  type AccountActionState,
} from "@/app/(app)/accounts/[accountId]/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ACCOUNT_ACTION_STRINGS as S } from "@/lib/strings";

const IDLE: AccountActionState = { status: "idle" };

/** What each action says when it is done. */
const DONE: Readonly<Record<AccountActionKind, string>> = {
  unlock: S.unlocked,
  disable: S.disabled,
  enable: S.enabled,
  resetMfa: S.mfaReset,
};

function Outcome({ state }: { readonly state: AccountActionState | undefined }) {
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
    <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
      <p className="font-medium">{DONE[state.action]}</p>
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{S.statusNow}</span>
        <StatusBadge kind="account" status={state.account.status} />
      </p>
    </div>
  );
}

function Note({ children }: { readonly children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export interface AccountActionsProps {
  readonly accountId: string;
  /** The account's name, for the dialogs' questions. */
  readonly name: string;
  /** The status the page was rendered with: it decides which actions are offered. */
  readonly status: components["schemas"]["AccountStatus"];
  readonly mfaEnabled: boolean;
  readonly isPlatformAdmin: boolean;
  /** A lockout or failed sign-ins to clear (the page decides it from the account). */
  readonly locked: boolean;
  /** The account is the signed-in admin's own. */
  readonly self: boolean;
}

/**
 * The support actions of an account (README §2, PF-87), each asking for exactly what its operation of the platform
 * API requires (`actions.ts`):
 *
 * - **Unlock** (`ConfirmDialog`, no reason) while there is a lockout or failed sign-ins to clear;
 * - **Disable** (`ReasonDialog`) on an account that is not disabled or deleted, never on the admin's own account (the
 *   API refuses it, and the last active platform admin, with `FORBIDDEN`);
 * - **Enable** (`ReasonDialog`) on a disabled account;
 * - **Reset two-factor** (`ReasonDialog`, then the step-up the API asks for with `REAUTH_REQUIRED`: `StepUpDialog` and
 *   the same reason again) on an account with two-factor authentication that is not a platform admin.
 *
 * The outcome of the last action stays below the buttons while the revalidated page shows the account as it is now.
 */
export function AccountActions({
  accountId,
  name,
  status,
  mfaEnabled,
  isPlatformAdmin,
  locked,
  self,
}: AccountActionsProps) {
  const unlock = useStepUpAction(unlockAccount, IDLE);
  const disable = useStepUpAction(disableAccount, IDLE);
  const enable = useStepUpAction(enableAccount, IDLE);
  const resetMfa = useStepUpAction(resetAccountMfa, IDLE);
  const actions = { unlock, disable, enable, resetMfa } as const;
  // The outcome shown is the one of the action that ran last.
  const [latest, setLatest] = useState<AccountActionKind | undefined>(undefined);
  const pending = Object.values(actions).some((action) => action.isPending);
  const outcome = latest === undefined ? undefined : actions[latest].state;

  if (status === "deleted") {
    return <Note>{S.noAction}</Note>;
  }

  const idField = <input type="hidden" name="accountId" value={accountId} />;
  const canDisable = status !== "disabled" && !self;
  const canResetMfa = mfaEnabled && !isPlatformAdmin;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {locked ? (
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={pending}>
                {S.unlock}
              </Button>
            }
            title={S.unlockTitle(name)}
            description={S.unlockDescription}
            confirmLabel={S.unlockConfirm}
            destructive={false}
            onConfirm={() => {
              const formData = new FormData();
              formData.set("accountId", accountId);
              setLatest("unlock");
              unlock.dispatch(formData);
            }}
          />
        ) : null}
        {canDisable ? (
          <ReasonDialog
            trigger={
              <Button variant="destructive" disabled={pending}>
                {S.disable}
              </Button>
            }
            title={S.disableTitle(name)}
            description={S.disableDescription}
            confirmLabel={S.disableConfirm}
            onConfirm={(formData) => {
              setLatest("disable");
              disable.dispatch(formData);
            }}
          >
            {idField}
          </ReasonDialog>
        ) : null}
        {status === "disabled" ? (
          <ReasonDialog
            trigger={<Button disabled={pending}>{S.enable}</Button>}
            title={S.enableTitle(name)}
            description={S.enableDescription}
            confirmLabel={S.enableConfirm}
            destructive={false}
            onConfirm={(formData) => {
              setLatest("enable");
              enable.dispatch(formData);
            }}
          >
            {idField}
          </ReasonDialog>
        ) : null}
        {canResetMfa ? (
          <ReasonDialog
            trigger={
              <Button variant="destructive" disabled={pending}>
                {S.resetMfa}
              </Button>
            }
            title={S.resetMfaTitle(name)}
            description={S.resetMfaDescription}
            confirmLabel={S.resetMfaConfirm}
            onConfirm={(formData) => {
              setLatest("resetMfa");
              resetMfa.dispatch(formData);
            }}
          >
            {idField}
          </ReasonDialog>
        ) : null}
        {pending ? <span className="text-sm text-muted-foreground">{S.working}</span> : null}
      </div>
      {self && status !== "disabled" ? <Note>{S.selfNote}</Note> : null}
      {mfaEnabled && isPlatformAdmin ? <Note>{S.adminResetNote}</Note> : null}
      <Outcome state={outcome} />
      {unlock.stepUpDialog}
      {disable.stepUpDialog}
      {enable.stepUpDialog}
      {resetMfa.stepUpDialog}
    </div>
  );
}
