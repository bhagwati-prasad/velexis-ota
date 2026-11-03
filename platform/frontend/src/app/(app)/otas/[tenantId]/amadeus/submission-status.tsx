"use client";

import type { components } from "@velexis/api-types/platform";
import { LoaderCircle } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { useEffect, useState } from "react";

import { getSubmissionStatus, type SubmissionView } from "@/app/(app)/otas/[tenantId]/amadeus/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SUBMISSION_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The verification of submitted Amadeus credentials (README §2 `/otas/[tenantId]/amadeus`, §5 polling; PADR-0010;
 * flows/amadeus-connection.md §D; PF-52 AC2). It starts from the submission the page or the form has (`pending`,
 * `verifying`, or a `failed` one the page found) and reads it with the `getSubmissionStatus` server action
 * (`getCredentialSubmission`) every 2 seconds, one read at a time, until it is final: `applied` (the connection uses
 * the credentials now; the action revalidates the page, so the connection card shows "Your own Amadeus credentials"),
 * `failed` (the reason in words: each `errorCode` has its own, an unknown one the general words; the code itself is
 * never shown, nor the API's `errorMessage`) or `superseded` (newer credentials replaced it). The connection keeps
 * working as it did until the verification succeeds, and the text says so.
 *
 * A read that may pass (rate limit, API unavailable, the portal unreachable) is tried again with a note, after its
 * `Retry-After` (at most a minute); any other failure stops polling with the portal's message. When the action ends with
 * `redirect()` (an ended session goes to sign-in), the redirect is thrown again while rendering, so the router's
 * redirect boundary navigates, as for a form's action. The submission never holds a secret.
 *
 * The parent renders it with `key={submission.id}`, so a new submission starts a fresh component.
 */

type Environment = components["schemas"]["Environment"];

/** How long the page waits between two reads of a submission (README §5). */
export const SUBMISSION_POLL_INTERVAL_MS = 2_000;

/** The longest wait a `Retry-After` may ask for between two reads. */
const MAX_POLL_DELAY_MS = 60_000;

const STRINGS = SUBMISSION_STRINGS;

/** The submission changes no more: polling stops (`applied`, `failed`, `superseded`). */
export function isFinalSubmission(status: string): boolean {
  return status === "applied" || status === "failed" || status === "superseded";
}

/** Why a submission failed, in words: the verification result's own words, or the general ones. Never the code. */
export function submissionReason(errorCode: string | null): string {
  return errorCode !== null && Object.hasOwn(STRINGS.reasons, errorCode)
    ? (STRINGS.reasons[errorCode] ?? STRINGS.reasonUnknown)
    : STRINGS.reasonUnknown;
}

/**
 * The call of a server action was rejected with Next.js's `redirect()` or `notFound()`, which the router must handle,
 * rather than failing on its own (the portal could not be reached).
 */
function isNavigation(error: unknown): boolean {
  try {
    unstable_rethrow(error);
  } catch {
    return true;
  }
  return false;
}

/** The colours of a status, as `StatusBadge` has them; the label always says it in words. */
const TONE_CLASSES: Readonly<Record<string, string>> = {
  pending: "border-transparent bg-sky-100 text-sky-900",
  verifying: "border-transparent bg-sky-100 text-sky-900",
  applied: "border-transparent bg-emerald-100 text-emerald-900",
  failed: "border-transparent bg-red-100 text-red-900",
  superseded: "border-transparent bg-secondary text-secondary-foreground",
};

/** A status in words; one the portal does not know yet (a newer API) in its raw form. */
function statusLabel(status: string): string {
  return Object.hasOwn(STRINGS.statuses, status)
    ? (STRINGS.statuses[status] ?? status)
    : status.replaceAll("_", " ");
}

/** What the submission means for the connection, in words (a live region reads it when it changes). */
function SubmissionMessage({
  submission,
  environment,
}: {
  readonly submission: SubmissionView;
  readonly environment: Environment;
}) {
  switch (submission.status) {
    case "applied":
      return <p>{STRINGS.applied(environment)}</p>;
    case "failed":
      return (
        <>
          <p>{STRINGS.failed}</p>
          <p data-submission-reason="">{submissionReason(submission.errorCode)}</p>
        </>
      );
    case "superseded":
      return <p>{STRINGS.superseded}</p>;
    case "pending":
    case "verifying":
      return <p>{STRINGS.open}</p>;
  }
}

export interface SubmissionStatusProps {
  readonly tenantId: string;
  /** The environment of the connection the credentials are for. */
  readonly environment: Environment;
  /** The submission to follow, as the page or the form has it. */
  readonly submission: SubmissionView;
}

/** The status of one submission, polled until it is final (see the module comment). */
export function SubmissionStatus({ tenantId, environment, submission: initial }: SubmissionStatusProps) {
  const [submission, setSubmission] = useState<SubmissionView>(initial);
  /** A read that failed but is tried again. */
  const [pollNote, setPollNote] = useState<string | undefined>(undefined);
  /** A read that failed for good: polling stopped. */
  const [pollStopped, setPollStopped] = useState<string | undefined>(undefined);
  /** The `redirect()` an action ended with, thrown again while rendering (see the module comment). */
  const [navigation, setNavigation] = useState<{ readonly error: unknown } | undefined>(undefined);

  const polling =
    !isFinalSubmission(submission.status) && pollStopped === undefined && navigation === undefined;
  const submissionId = submission.id;

  useEffect(() => {
    if (!polling) {
      return undefined;
    }
    // One read at a time: the next one is scheduled when the previous answer arrived. The cleanup (the component going
    // away) cancels the chain, and a late answer of the old chain changes nothing.
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        getSubmissionStatus(tenantId, submissionId).then(
          (result) => {
            if (!current) {
              return;
            }
            if (result.status === "ok") {
              setPollNote(undefined);
              setSubmission(result.submission);
              if (!isFinalSubmission(result.submission.status)) {
                schedule(SUBMISSION_POLL_INTERVAL_MS);
              }
              return;
            }
            if (result.transient) {
              setPollNote(STRINGS.pollFailed);
              const wait = (result.retryAfterSeconds ?? 0) * 1_000;
              schedule(Math.min(Math.max(SUBMISSION_POLL_INTERVAL_MS, wait), MAX_POLL_DELAY_MS));
              return;
            }
            setPollNote(undefined);
            setPollStopped(result.message);
          },
          (error: unknown) => {
            if (!current) {
              return;
            }
            if (isNavigation(error)) {
              // The session ended: the router leaves the page, and no read follows.
              setNavigation({ error });
              return;
            }
            // The portal itself could not be reached: try again.
            setPollNote(STRINGS.pollFailed);
            schedule(SUBMISSION_POLL_INTERVAL_MS);
          },
        );
      }, delay);
    };
    schedule(SUBMISSION_POLL_INTERVAL_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [polling, tenantId, submissionId]);

  if (navigation !== undefined) {
    // While rendering, where the router's redirect boundary catches it and navigates.
    throw navigation.error;
  }

  const { status } = submission;
  const final = isFinalSubmission(status);
  return (
    <div
      className="grid gap-2 rounded-lg border px-4 py-3 text-sm"
      data-submission-status={status}
      data-environment={environment}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{STRINGS.title}</span>
        <Badge
          variant="outline"
          data-status={status}
          className={cn(TONE_CLASSES[status] ?? TONE_CLASSES["superseded"])}
        >
          {final ? null : <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {statusLabel(status)}
        </Badge>
      </div>
      {/* A live region from the first render, so each new status is read out. */}
      <div role="status" className="grid gap-1" data-submission-message="">
        <SubmissionMessage submission={submission} environment={environment} />
      </div>
      {pollNote === undefined ? null : (
        <p className="text-muted-foreground" data-poll-note="">
          {pollNote}
        </p>
      )}
      {pollStopped === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>{STRINGS.pollStoppedTitle}</AlertTitle>
          <AlertDescription>{pollStopped}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
