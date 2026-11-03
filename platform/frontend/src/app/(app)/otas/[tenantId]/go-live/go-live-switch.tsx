"use client";

import type { components } from "@velexis/api-types/platform";
import { CircleAlert, CircleCheck, CircleDashed } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { goLiveNow, type GoLiveState } from "@/app/(app)/otas/[tenantId]/go-live/actions";
import {
  LIVE_PRECONDITIONS,
  preconditionHref,
  statesAfterAnswer,
  type CheckedPreconditions,
  type PreconditionState,
  type PreconditionStates,
} from "@/app/(app)/otas/[tenantId]/go-live/preconditions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DateTime } from "@/components/date-time";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { otaPath } from "@/lib/roles";
import { GO_LIVE_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The checklist and the switch of the go-live page (README §2 `/otas/[tenantId]/go-live`; scope PF-14 AC1 and AC2), for
 * owners while `features.liveSwitch` is on. The six preconditions of `goLive`, in the platform document's order, each
 * with what it asks for, its state in words ("Done", "Missing", "Checked when you go live") and a link to the page that
 * completes it. The page starts the list with what it knows for sure (`initialStates`); every answer of the switch
 * then decides what it can (`LIVE_PRECONDITIONS_UNMET`: all six; `MFA_REQUIRED`: two-factor sign-in), and the list keeps
 * the latest decision of each.
 *
 * "Go live" asks in `ConfirmDialog` first, then runs `goLiveNow` through `useStepUpAction`: `REAUTH_REQUIRED` opens
 * `StepUpDialog` and the same switch runs again after the code (a cancelled step-up says nothing changed). A refusal
 * for missing preconditions focuses the summary above the list. A switch shows the live view in place of the list:
 * the live storefront's address and that the switch takes effect within 60 seconds (PF-14 AC2). The page renders this
 * component in the same place whether the OTA is live or not, so after the revalidation of the switch (the page's own
 * live view) the component keeps its state and the 60-second note stays in view.
 */

type TenantStatus = components["schemas"]["TenantStatus"];

const STRINGS = GO_LIVE_STRINGS;

const IDLE: GoLiveState = { status: "idle" };

export interface GoLiveSwitchProps {
  readonly tenantId: string;
  /** While the OTA is not `active` the API refuses the switch (PADR-0014 item 5): the button is disabled, with why. */
  readonly tenantStatus: TenantStatus;
  /** The OTA's primary storefront host (`primaryHost` of `getTenant`). */
  readonly primaryHost: string;
  /** The OTA is live already (`storefrontEnvironment = live`), since `liveEnabledAt`; `null` in test mode. */
  readonly live: { readonly liveEnabledAt: string | null } | null;
  /** The OTA's time zone, for the date it went live. */
  readonly timeZone: string;
  /** The checklist before any answer of the switch (`initialStates`). */
  readonly initial: PreconditionStates;
}

/** The icon of a state; the state is always in words next to it as well. */
function StateIcon({ state }: { readonly state: PreconditionState }) {
  if (state === "met") {
    return <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-emerald-700" />;
  }
  if (state === "missing") {
    return <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />;
  }
  return <CircleDashed aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />;
}

const STATE_CLASSES: Readonly<Record<PreconditionState, string>> = {
  met: "text-emerald-900",
  missing: "font-medium text-destructive",
  unchecked: "text-muted-foreground",
};

/** The OTA is live: its storefront, since when, the 60-second note right after the switch, and the live keys. */
function LiveView({
  tenantId,
  primaryHost,
  liveEnabledAt,
  timeZone,
  justSwitched,
}: {
  readonly tenantId: string;
  readonly primaryHost: string;
  readonly liveEnabledAt: string | null;
  readonly timeZone: string;
  readonly justSwitched: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // The button the person used is gone: the view that takes its place takes the focus.
    if (justSwitched) {
      heading.current?.focus();
    }
  }, [justSwitched]);
  const storefrontUrl = `https://${primaryHost}/`;
  return (
    <section
      aria-labelledby="go-live-live-title"
      data-go-live="live"
      className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="flex items-center gap-3">
        <CircleCheck aria-hidden="true" className="size-6 shrink-0 text-emerald-700" />
        <h2
          id="go-live-live-title"
          ref={heading}
          tabIndex={-1}
          className="text-xl font-semibold tracking-tight focus:outline-none"
        >
          {STRINGS.liveTitle}
        </h2>
      </div>
      {justSwitched ? (
        <p role="status" className="text-sm" data-go-live-note="">
          {STRINGS.liveNow}
        </p>
      ) : null}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{STRINGS.storefrontLabel}</dt>
        <dd className="min-w-0 break-all">
          <a
            href={storefrontUrl}
            className="font-medium underline underline-offset-4"
            data-live-storefront=""
          >
            {storefrontUrl}
          </a>
        </dd>
        {liveEnabledAt === null ? null : (
          <>
            <dt className="text-muted-foreground">{STRINGS.liveSince}</dt>
            <dd>
              <DateTime value={liveEnabledAt} timeZone={timeZone} />
            </dd>
          </>
        )}
      </dl>
      <p className="text-sm">
        {STRINGS.liveKeys}{" "}
        <Link href={otaPath(tenantId, "/api-keys")} className="font-medium underline underline-offset-4">
          {STRINGS.liveKeysLink}
        </Link>
      </p>
    </section>
  );
}

/** The go-live checklist and switch (see the module comment). */
export function GoLiveSwitch({
  tenantId,
  tenantStatus,
  primaryHost,
  live,
  timeZone,
  initial,
}: GoLiveSwitchProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(goLiveNow, IDLE);
  const summary = useRef<HTMLDivElement>(null);

  // The latest decision of each precondition, from every answer so far: a later refusal for another reason (a rate
  // limit) keeps what the last check found.
  const [checked, setChecked] = useState<CheckedPreconditions>({});
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    if (state.checked !== undefined) {
      const decided = state.checked;
      setChecked((previous) => ({ ...previous, ...decided }));
    }
  }

  useEffect(() => {
    // A refusal for missing preconditions: the summary above the list takes the focus, once per answer.
    if (state.status === "unmet") {
      summary.current?.focus();
    }
  }, [state]);

  if (state.status === "live" || live !== null) {
    return (
      <LiveView
        tenantId={tenantId}
        primaryHost={state.live?.primaryHost ?? primaryHost}
        liveEnabledAt={state.live?.liveEnabledAt ?? live?.liveEnabledAt ?? null}
        timeZone={timeZone}
        justSwitched={state.status === "live"}
      />
    );
  }

  const states = statesAfterAnswer(initial, checked);
  const missingCount = LIVE_PRECONDITIONS.filter((precondition) => states[precondition] === "missing").length;
  const active = tenantStatus === "active";

  function onConfirm(): void {
    // The step-up's re-submission sends the same data again (`useStepUpAction`).
    const data = new FormData();
    data.set("tenantId", tenantId);
    dispatch(data);
  }

  return (
    <div className="grid gap-6">
      <section
        aria-labelledby="go-live-checklist-title"
        data-go-live="checklist"
        className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
      >
        <div className="grid gap-1">
          <h2 id="go-live-checklist-title" className="text-xl font-semibold tracking-tight">
            {STRINGS.checklistTitle}
          </h2>
          <p className="text-sm text-muted-foreground">{STRINGS.checklistIntro}</p>
        </div>
        {state.status === "unmet" ? (
          <div ref={summary} tabIndex={-1} className="focus:outline-none" data-go-live-unmet="">
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>{STRINGS.unmetTitle}</AlertTitle>
              <AlertDescription>
                {missingCount > 0 ? <p>{STRINGS.unmet(missingCount)}</p> : null}
                {state.otherMissing === true ? <p>{STRINGS.otherMissing}</p> : null}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        <ol aria-labelledby="go-live-checklist-title" className="grid gap-2">
          {LIVE_PRECONDITIONS.map((precondition) => {
            const words = STRINGS.preconditions[precondition];
            const itemState = states[precondition];
            return (
              <li
                key={precondition}
                data-precondition={precondition}
                data-state={itemState}
                className="flex items-start gap-3 rounded-lg border px-3 py-3"
              >
                <StateIcon state={itemState} />
                <div className="grid min-w-0 flex-1 gap-1">
                  <p className="font-medium">{words.title}</p>
                  <p className="text-sm text-muted-foreground">{words.text}</p>
                  <p className="text-sm">
                    <Link
                      href={preconditionHref(tenantId, precondition)}
                      className="font-medium underline underline-offset-4"
                    >
                      {words.link}
                    </Link>
                  </p>
                </div>
                <span data-state-label="" className={cn("shrink-0 text-sm", STATE_CLASSES[itemState])}>
                  {STRINGS.states[itemState]}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="grid justify-items-start gap-3" data-go-live="switch">
        {active ? null : (
          <Alert role="status" data-go-live-read-only="">
            <AlertTitle>{STRINGS.readOnlyTitle}</AlertTitle>
            <AlertDescription>{STRINGS.readOnly[tenantStatus]}</AlertDescription>
          </Alert>
        )}
        <ConfirmDialog
          trigger={
            <Button type="button" disabled={isPending || !active}>
              {isPending ? STRINGS.goingLive : STRINGS.goLive}
            </Button>
          }
          title={STRINGS.confirmTitle}
          description={STRINGS.confirmText}
          confirmLabel={STRINGS.confirmLabel}
          destructive={false}
          onConfirm={onConfirm}
        />
        {state.message === undefined ? null : (
          <Alert variant="destructive" data-go-live-problem={state.code}>
            <AlertDescription>
              <p>{state.message}</p>
              {state.security === true ? (
                <Link href="/account/security" className="font-medium underline underline-offset-4">
                  {STRINGS.securityLink}
                </Link>
              ) : null}
              {state.reload === true ? (
                // A full reload, so the page shows the OTA, the role and the switch as they are now.
                <a href={otaPath(tenantId, "/go-live")} className="font-medium underline underline-offset-4">
                  {STRINGS.reload}
                </a>
              ) : null}
            </AlertDescription>
          </Alert>
        )}
      </div>
      {stepUpDialog}
    </div>
  );
}
