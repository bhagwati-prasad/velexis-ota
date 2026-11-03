"use client";

import type { components } from "@velexis/api-types/platform";
import Link from "next/link";

import { switchToVelexis, type UseVelexisState } from "@/app/(app)/otas/[tenantId]/payments/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { otaPath } from "@/lib/roles";
import { USE_VELEXIS_STRINGS } from "@/lib/strings";

/**
 * "Use Velexis payments" on a card of the OTA's own Stripe account (README §2 `/otas/[tenantId]/payments`;
 * flows/stripe-payments-account.md §E; PADR-0011 items 6 and 7), for owners: `useVelexisPayments` is owners only and
 * behind no switch, so an OTA can always come back. The button opens `ConfirmDialog`, which warns that payments taken
 * before stay on the account they were taken with (and, for the live environment, that a verified payout account is
 * needed); confirming runs `switchToVelexis` through `useStepUpAction`, so `REAUTH_REQUIRED` opens `StepUpDialog` and
 * the same switch runs again after the code. A cancelled step-up changes nothing and says so.
 *
 * The page renders it in the same place of the card whatever the connection's mode, so the confirmation of a switch
 * stays in view after the revalidation turns the card into a Velexis-mode card: in `velexis` mode it shows only that
 * confirmation, and nothing before a switch.
 */

type Schemas = components["schemas"];
type Environment = Schemas["Environment"];
type AccountMode = Schemas["PaymentConnection"]["accountMode"];
type TenantStatus = Schemas["TenantStatus"];

const STRINGS = USE_VELEXIS_STRINGS;

const IDLE: UseVelexisState = { status: "idle" };

export interface UseVelexisDialogProps {
  readonly tenantId: string;
  readonly environment: Environment;
  /** The connection's mode: nothing to switch in `velexis` mode. */
  readonly accountMode: AccountMode;
  /** While the OTA is not `active` the API refuses the switch (PADR-0014 item 5): the button is disabled, with why. */
  readonly tenantStatus: TenantStatus;
}

/** The "Use Velexis payments" choice of one connection (see the module comment). */
export function UseVelexisDialog({
  tenantId,
  environment,
  accountMode,
  tenantStatus,
}: UseVelexisDialogProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(switchToVelexis, IDLE);

  if (accountMode === "velexis") {
    // After a switch: the confirmation, in the place the button was.
    return state.status === "switched" ? (
      <p role="status" className="text-sm" data-use-velexis-done={environment}>
        {STRINGS.switched(environment)}
      </p>
    ) : null;
  }

  function onConfirm(): void {
    // The step-up's re-submission sends the same data again (`useStepUpAction`).
    const data = new FormData();
    data.set("tenantId", tenantId);
    data.set("environment", environment);
    dispatch(data);
  }

  return (
    <div className="grid gap-3" data-use-velexis={environment}>
      <ConfirmDialog
        trigger={
          <Button type="button" variant="outline" disabled={isPending || tenantStatus !== "active"}>
            {isPending ? STRINGS.switching : STRINGS.button}
          </Button>
        }
        title={STRINGS.title(environment)}
        description={
          <span className="grid gap-2">
            <span>{STRINGS.description}</span>
            {accountMode === "connect_standard" ? <span>{STRINGS.connectNote}</span> : null}
            {environment === "live" ? <span>{STRINGS.liveNote}</span> : null}
            <span>{STRINGS.stepUpNote}</span>
          </span>
        }
        confirmLabel={STRINGS.confirm}
        onConfirm={onConfirm}
      />
      {tenantStatus === "active" ? null : (
        <p className="text-sm text-muted-foreground" data-use-velexis-read-only="">
          {STRINGS.readOnly[tenantStatus]}
        </p>
      )}
      {state.message === undefined ? null : (
        <Alert variant="destructive" data-use-velexis-problem={state.code}>
          <AlertDescription>
            <p>{state.message}</p>
            {state.payoutAccount === true ? (
              <Link
                href={otaPath(tenantId, "/payments/payout-account")}
                className="font-medium underline underline-offset-4"
              >
                {STRINGS.payoutAccountLink}
              </Link>
            ) : null}
            {state.code === "MFA_REQUIRED" ? (
              <Link href="/account/security" className="font-medium underline underline-offset-4">
                {STRINGS.mfaLink}
              </Link>
            ) : null}
            {state.reload === true ? (
              <a href={otaPath(tenantId, "/payments")} className="font-medium underline underline-offset-4">
                {STRINGS.reload}
              </a>
            ) : null}
          </AlertDescription>
        </Alert>
      )}
      {stepUpDialog}
    </div>
  );
}
