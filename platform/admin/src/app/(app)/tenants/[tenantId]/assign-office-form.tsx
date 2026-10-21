"use client";

import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";

import { assignAmadeusOffice, type AssignOfficeState } from "@/app/(app)/tenants/[tenantId]/actions";
import { ActionFailureNotice } from "@/app/(app)/tenants/[tenantId]/suspend-form";
import { StatusBadge } from "@/components/status-badge";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ASSIGN_OFFICE_STRINGS as O } from "@/lib/strings";

/**
 * "Assign office" on the Amadeus connection card of an OTA whose connection waits for an office (README §2;
 * `adminAssignAmadeusOffice`, PADR-0012; flows/amadeus-connection.md "Pool empty at provisioning"). The admin picks an
 * available office of the connection's environment; the API completes the OTA's `velexis` connection with it and makes
 * it `active`, and the owners get an e-mail. The form then shows the assigned office and the connection's new status,
 * and the revalidated page shows the active connection with its office. The page loads the available offices; the
 * props carry only their ids.
 */

type Schemas = components["schemas"];

const IDLE: AssignOfficeState = { status: "idle" };

const SELECT_CLASS =
  "h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** An available office of the pool: the pool entry (`amo_…`, what the API assigns) and its Amadeus office id. */
export interface OfficeOption {
  readonly id: string;
  readonly officeId: string;
}

export interface AssignOfficeFormProps {
  readonly tenantId: string;
  readonly environment: Schemas["Environment"];
  /** The environment's name ("Test"). */
  readonly environmentLabel: string;
  /**
   * The connection waits for an office (a `velexis` connection, `pending_verification`, without an office). Otherwise
   * the form shows nothing but the outcome of an assignment it made, so that outcome stays after the page follows it.
   */
  readonly needsOffice: boolean;
  /** The available offices of the environment, oldest first; `null` when they could not be loaded. */
  readonly offices: readonly OfficeOption[] | null;
}

export function AssignOfficeForm({
  tenantId,
  environment,
  environmentLabel,
  needsOffice,
  offices,
}: AssignOfficeFormProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(assignAmadeusOffice, IDLE);
  const [choice, setOfficeRowId] = useState(offices?.[0]?.id ?? "");
  // A choice the list no longer holds (the revalidated page lists the offices of now) falls back to the first.
  const officeRowId = offices?.some((office) => office.id === choice) ? choice : (offices?.[0]?.id ?? "");
  const id = useId();
  const hintId = `${id}-hint`;
  const poolHref = `/amadeus/offices?${new URLSearchParams({ environment, status: "available" }).toString()}`;

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isPending) {
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  // A fragment: on a connection that needs no office, an idle form adds nothing to the card's layout.
  return (
    <>
      {needsOffice ? (
        <section aria-labelledby={`${id}-title`} className="grid gap-3 rounded-lg border p-4">
          <h3 id={`${id}-title`} className="text-base font-semibold">
            {O.title}
          </h3>
          <p className="text-sm text-muted-foreground">{O.intro(environmentLabel)}</p>
          {offices === null ? (
            <p className="text-sm">
              {O.unavailable}{" "}
              <Link href={poolHref} className="font-medium underline underline-offset-4">
                {O.poolPage}
              </Link>
            </p>
          ) : offices.length === 0 ? (
            <p className="text-sm">
              {O.noneAvailable}{" "}
              <Link href={poolHref} className="font-medium underline underline-offset-4">
                {O.poolLink}
              </Link>
            </p>
          ) : (
            <form onSubmit={onSubmit} noValidate className="grid gap-3">
              <input type="hidden" name="tenantId" value={tenantId} />
              <div className="grid gap-2">
                <Label htmlFor={id}>{O.officeLabel}</Label>
                <p id={hintId} className="text-sm text-muted-foreground">
                  {O.officeHint}
                </p>
                <select
                  id={id}
                  name="officeRowId"
                  value={officeRowId}
                  aria-describedby={hintId}
                  className={SELECT_CLASS}
                  onChange={(event) => setOfficeRowId(event.currentTarget.value)}
                >
                  {offices.map((office) => (
                    <option key={office.id} value={office.id}>
                      {office.officeId}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Button type="submit" disabled={isPending}>
                  {isPending ? O.assigning : O.assign}
                </Button>
              </div>
            </form>
          )}
        </section>
      ) : null}
      {state.status === "failed" ? <ActionFailureNotice code={state.code} message={state.message} /> : null}
      {state.status === "done" ? (
        <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">{O.assigned(state.officeId)}</p>
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{O.statusNow}</span>
            <StatusBadge kind="amadeusConnection" status={state.connectionStatus} />
          </p>
        </div>
      ) : null}
      {stepUpDialog}
    </>
  );
}
