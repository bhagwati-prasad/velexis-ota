"use client";

import type { components } from "@velexis/api-types/platform";

import {
  setConnectionStatus,
  type ConnectionKind,
  type ConnectionStatusState,
} from "@/app/(app)/tenants/[tenantId]/actions";
import { ActionFailureNotice } from "@/app/(app)/tenants/[tenantId]/suspend-form";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Button } from "@/components/ui/button";
import { CONNECTION_STATUS_STRINGS as C, TENANT_ACTION_STRINGS as A } from "@/lib/strings";

/**
 * "Disable connection" and "Enable connection" on a connection card of `/tenants/[tenantId]` (README §2;
 * `adminSetConnectionStatus`, **reason**). Disabling stops the OTA's Amadeus or payment calls in that environment, for
 * example for an abusive OTA whose paid bookings still settle (PADR-0014 "Negative"); a disabled connection can be
 * enabled again. The button follows the status the page was rendered with (the page is revalidated after a change);
 * the new status the API answered stays below it.
 */

type Schemas = components["schemas"];

const IDLE: ConnectionStatusState = { status: "idle" };

export interface ConnectionStatusFormProps {
  readonly tenantId: string;
  readonly kind: ConnectionKind;
  readonly environment: Schemas["Environment"];
  /** The connection's status as the page shows it. */
  readonly status: Schemas["AmadeusConnection"]["status"] | Schemas["PaymentConnection"]["status"];
  /** The connection's name ("Amadeus, Test"), so each button and dialog names its connection. */
  readonly connectionLabel: string;
}

function Outcome({ state }: { readonly state: ConnectionStatusState }) {
  if (state.status === "idle") {
    return null;
  }
  if (state.status === "failed") {
    return <ActionFailureNotice code={state.code} message={state.message} />;
  }
  return (
    <p
      role="status"
      data-notice="done"
      className="flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3 text-sm"
    >
      <span className="text-muted-foreground">{C.statusNow}</span>
      {state.kind === "amadeus" ? (
        <StatusBadge kind="amadeusConnection" status={state.connectionStatus} />
      ) : (
        <StatusBadge kind="paymentConnection" status={state.connectionStatus} />
      )}
    </p>
  );
}

export function ConnectionStatusForm({
  tenantId,
  kind,
  environment,
  status,
  connectionLabel,
}: ConnectionStatusFormProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(setConnectionStatus, IDLE);
  const disabled = status === "disabled";
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ReasonDialog
          trigger={
            <Button variant={disabled ? "outline" : "destructive"} size="sm" disabled={isPending}>
              {disabled ? C.enable : C.disable}
              <span className="sr-only">{C.of(connectionLabel)}</span>
            </Button>
          }
          title={disabled ? C.enableTitle(connectionLabel) : C.disableTitle(connectionLabel)}
          description={
            disabled ? C.enableDescription : kind === "amadeus" ? C.disableAmadeus : C.disablePayment
          }
          confirmLabel={disabled ? C.enableConfirm : C.disableConfirm}
          destructive={!disabled}
          onConfirm={dispatch}
        >
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="environment" value={environment} />
          <input type="hidden" name="status" value={disabled ? "active" : "disabled"} />
        </ReasonDialog>
        {isPending ? <span className="text-sm text-muted-foreground">{A.working}</span> : null}
      </div>
      <Outcome state={state} />
      {stepUpDialog}
    </div>
  );
}
