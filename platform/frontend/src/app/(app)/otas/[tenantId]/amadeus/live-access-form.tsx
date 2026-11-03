"use client";

import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import {
  startTransition,
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { requestLiveAccess, type LiveRequestState } from "@/app/(app)/otas/[tenantId]/amadeus/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { otaPath } from "@/lib/roles";
import { AMADEUS_LIVE_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * "Request live access" (README §2 `/otas/[tenantId]/amadeus`; flows/amadeus-connection.md §C; PF-51 AC1): what the
 * request starts (Velexis's operations team is told, the commercial onboarding with the contract and the ticketing
 * agreement, then a live office and the owners' e-mail) and, for owners while the plan has live mode, the request
 * itself with an optional note for Velexis (`requestLiveAccess`, `requestLiveAmadeus`; no step-up). The page renders
 * it while `features.liveSwitch` is on and the OTA has no live connection, or its live Velexis connection still waits
 * for an office; it keeps its place in the page, so after the request (which revalidates the page, so the live
 * connection's card appears) the confirmation stays in view. While the OTA is not `active` nothing can be requested
 * (PADR-0014 item 5), and the section says why.
 */

type TenantStatus = components["schemas"]["TenantStatus"];

const STRINGS = AMADEUS_LIVE_STRINGS;

/** `RequestLiveAmadeusRequest.note`: at most 1000 characters. */
const NOTE_MAX = 1_000;

const TEXTAREA_CLASSES = cn(
  "border-input flex min-h-24 w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

export interface LiveAccessFormProps {
  readonly tenantId: string;
  readonly tenantStatus: TenantStatus;
  /** The caller is an owner: only owners may request live access (scope §1.2; the API checks it again). */
  readonly isOwner: boolean;
  /** The OTA's live Velexis connection exists and waits for its office: the request was made. */
  readonly requested: boolean;
  /** `listPlans` says the OTA's plan has no live mode (unknown plans are left to the API). */
  readonly planWithoutLive: boolean;
}

const IDLE: LiveRequestState = { status: "idle", note: "" };

/** The live access section of the Amadeus page (see the module comment). */
export function LiveAccessForm({
  tenantId,
  tenantStatus,
  isOwner,
  requested,
  planWithoutLive,
}: LiveAccessFormProps) {
  const [state, dispatch, isPending] = useActionState(requestLiveAccess, IDLE);
  const [note, setNote] = useState(state.note);
  const confirmation = useRef<HTMLDivElement>(null);

  // Each answer sets the note in the render that shows it: empty after the request, as sent after a refusal.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setNote(state.note);
  }
  // The button goes with the request: the confirmation that takes its place takes the focus.
  useEffect(() => {
    if (state.status === "requested") {
      confirmation.current?.focus();
    }
  }, [state]);

  const summary = useMemo<FormErrorItem[]>(() => {
    const items: FormErrorItem[] = [];
    if (state.fieldError !== undefined) {
      items.push({ message: state.fieldError, fieldId: "live-access-note" });
    }
    if (state.message !== undefined) {
      items.push({ message: state.message });
    }
    return items;
  }, [state]);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    // React would reset the note after the action; the component's state already holds it.
    event.preventDefault();
    if (isPending) {
      return;
    }
    const data = new FormData(event.currentTarget);
    // `useActionState`'s dispatch outside a form's action runs in a transition of its own.
    startTransition(() => dispatch(data));
  }

  const done = requested || state.status === "requested";
  let content: ReactNode;
  if (done) {
    content = (
      <div
        ref={confirmation}
        tabIndex={-1}
        role={state.status === "requested" ? "status" : undefined}
        className="grid gap-1 rounded-lg border px-4 py-3 text-sm focus:outline-none"
        data-live-requested=""
      >
        <p className="font-medium">{STRINGS.requestedTitle}</p>
        <p>{STRINGS.requested}</p>
      </div>
    );
  } else if (!isOwner) {
    content = <p className="text-sm text-muted-foreground">{STRINGS.ownerOnly}</p>;
  } else if (tenantStatus !== "active") {
    content = (
      <Alert>
        <AlertTitle>{STRINGS.readOnlyTitle}</AlertTitle>
        <AlertDescription>{STRINGS.readOnly[tenantStatus]}</AlertDescription>
      </Alert>
    );
  } else if (planWithoutLive) {
    content = (
      <p className="text-sm" data-plan-without-live="">
        {STRINGS.planWithoutLive}{" "}
        <Link href={otaPath(tenantId, "/billing")} className="font-medium underline underline-offset-4">
          {STRINGS.billingLink}
        </Link>
      </p>
    );
  } else {
    content = (
      // `action` keeps a form sent before the page hydrated from going out as a GET with the note in the URL.
      <form
        action={dispatch}
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="live-access-title"
        className="grid gap-4"
        data-live-access-form=""
      >
        <input type="hidden" name="tenantId" value={tenantId} />
        <FormErrorSummary errors={summary} />
        {state.billing === true ? (
          <p className="text-sm">
            <Link href={otaPath(tenantId, "/billing")} className="font-medium underline underline-offset-4">
              {STRINGS.billingLink}
            </Link>
          </p>
        ) : null}
        {state.reload === true ? (
          <p className="text-sm">
            {/* A full reload, so the page shows the connections and the role as they are now. */}
            <a href={otaPath(tenantId, "/amadeus")} className="font-medium underline underline-offset-4">
              {STRINGS.reload}
            </a>
          </p>
        ) : null}
        <FormField
          id="live-access-note"
          name="note"
          label={STRINGS.noteLabel}
          description={STRINGS.noteHint}
          error={state.fieldError}
        >
          {(control) => (
            <textarea
              {...control}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              maxLength={NOTE_MAX}
              className={TEXTAREA_CLASSES}
            />
          )}
        </FormField>
        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? STRINGS.submitting : STRINGS.submit}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <section
      aria-labelledby="live-access-title"
      data-live-access=""
      className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="grid gap-1">
        <h2 id="live-access-title" className="text-lg font-semibold tracking-tight">
          {STRINGS.title}
        </h2>
        <p className="text-sm text-muted-foreground">{STRINGS.intro}</p>
      </div>
      <div className="grid gap-2 text-sm">
        <h3 className="font-medium">{STRINGS.stepsLabel}</h3>
        <ol className="grid list-decimal gap-1 pl-5">
          {STRINGS.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
      {content}
    </section>
  );
}
