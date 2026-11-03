"use client";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { LoaderCircle } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The verification of submitted credentials (README §2 `/otas/[tenantId]/amadeus` and `/otas/[tenantId]/payments`, §5
 * polling; PADR-0010; flows/amadeus-connection.md §D, flows/stripe-payments-account.md §D; PF-52 AC2, PF-62 AC1): one
 * component for the OTA's own Amadeus credentials (PFE-023) and its own Stripe keys (PFE-024), since FIX-W40-PLATFORM
 * (lead decision (2h) of 2026-11-03) in place of PFE-023's `SubmissionStatus` and PFE-024's `KeysSubmissionStatus`,
 * with the same behaviour. The caller gives the submission (`submission`, its id and status), the read (`poll`: the
 * page's server action over `getCredentialSubmission`) and the words of its kind (`wording`).
 *
 * It starts from the submission the page or the form has (`pending`, `verifying`, or a `failed` one the page found)
 * and reads it with `poll` every 2 seconds, one read at a time, until it is final: `applied` (the connection uses the
 * credentials now; the action revalidates the page, so the connection card shows them), `failed` (the reason in words:
 * each `errorCode` has its own, an unknown one the general words; the code itself is never shown, nor the API's
 * `errorMessage`) or `superseded` (newer credentials replaced it). The connection keeps working as it did until the
 * verification succeeds, and the text says so.
 *
 * A read that may pass (rate limit, API unavailable, the portal unreachable) is tried again with a note, after its
 * `Retry-After` (at most a minute); any other failure stops polling with the portal's message. When the action ends with
 * `redirect()` (an ended session goes to sign-in), the redirect is thrown again while rendering, so the router's
 * redirect boundary navigates, as for a form's action. The submission never holds a secret.
 *
 * The parent renders it with `key={submission.id}`, so a new submission starts a fresh component.
 */

type CredentialSubmission = components["schemas"]["CredentialSubmission"];
type Environment = components["schemas"]["Environment"];

/** What the component shows of a submission: its id, status and error code (never a secret). */
export type FollowedSubmission = Pick<CredentialSubmission, "id" | "status" | "errorCode">;

/** The answer of one read of a submission (the server actions' `SubmissionPoll` and `KeysSubmissionPoll`). */
export type SubmissionPollResult =
  | { readonly status: "ok"; readonly submission: FollowedSubmission }
  | {
      readonly status: "failed";
      /** The error code, for tests; never shown. */
      readonly code: PlatformErrorCode;
      readonly message: string;
      /** The read may work when tried again (rate limit, API unavailable): polling goes on. */
      readonly transient: boolean;
      /** The wait of `Retry-After`, when the API sent one. */
      readonly retryAfterSeconds?: number;
    };

/** One read of the submission `submissionId` of the OTA `tenantId` (a server action). */
export type SubmissionPoll = (tenantId: string, submissionId: string) => Promise<SubmissionPollResult>;

/** The words of one kind of submission (`SUBMISSION_STRINGS`, `STRIPE_KEYS_SUBMISSION_STRINGS` of `lib/strings.ts`). */
export interface SubmissionWording {
  /** The heading of the block. */
  readonly title: string;
  /** A submission's status in words (`CredentialSubmission.status`). */
  readonly statuses: Readonly<Record<string, string>>;
  /** While the submission is `pending` or `verifying`. */
  readonly open: string;
  /** Once it is `applied`. */
  readonly applied: (environment: Environment) => string;
  /** Once it `failed`, before the reason. */
  readonly failed: string;
  /** Once newer credentials `superseded` it. */
  readonly superseded: string;
  /** Why a submission failed, per `errorCode`. */
  readonly reasons: Readonly<Record<string, string>>;
  /** A failure without a code, or with one the portal has no words for. */
  readonly reasonUnknown: string;
  /** A read that failed and is tried again. */
  readonly pollFailed: string;
  /** The title of the alert of a read that failed for good. */
  readonly pollStoppedTitle: string;
}

/** How long the page waits between two reads of a submission (README §5). */
export const SUBMISSION_POLL_INTERVAL_MS = 2_000;

/** The longest wait a `Retry-After` may ask for between two reads. */
const MAX_POLL_DELAY_MS = 60_000;

/** The submission changes no more: polling stops (`applied`, `failed`, `superseded`). */
export function isFinalSubmission(status: string): boolean {
  return status === "applied" || status === "failed" || status === "superseded";
}

/** Why a submission failed, in the words of its kind: the verification result's own words, or the general ones. */
export function submissionReason(wording: SubmissionWording, errorCode: string | null): string {
  return errorCode !== null && Object.hasOwn(wording.reasons, errorCode)
    ? (wording.reasons[errorCode] ?? wording.reasonUnknown)
    : wording.reasonUnknown;
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
function statusLabel(wording: SubmissionWording, status: string): string {
  return Object.hasOwn(wording.statuses, status)
    ? (wording.statuses[status] ?? status)
    : status.replaceAll("_", " ");
}

/** What the submission means for the connection, in words (a live region reads it when it changes). */
function SubmissionMessage({
  submission,
  environment,
  wording,
}: {
  readonly submission: FollowedSubmission;
  readonly environment: Environment;
  readonly wording: SubmissionWording;
}) {
  switch (submission.status) {
    case "applied":
      return <p>{wording.applied(environment)}</p>;
    case "failed":
      return (
        <>
          <p>{wording.failed}</p>
          <p data-submission-reason="">{submissionReason(wording, submission.errorCode)}</p>
        </>
      );
    case "superseded":
      return <p>{wording.superseded}</p>;
    case "pending":
    case "verifying":
      return <p>{wording.open}</p>;
  }
}

export interface SubmissionStatusProps {
  readonly tenantId: string;
  /** The environment of the connection the credentials are for. */
  readonly environment: Environment;
  /** The submission to follow, as the page or the form has it. */
  readonly submission: FollowedSubmission;
  /** One read of the submission: the page's server action. */
  readonly poll: SubmissionPoll;
  /** The words of the kind of credentials. */
  readonly wording: SubmissionWording;
}

/** The status of one submission, polled until it is final (see the module comment). */
export function SubmissionStatus({
  tenantId,
  environment,
  submission: initial,
  poll,
  wording,
}: SubmissionStatusProps) {
  const [submission, setSubmission] = useState<FollowedSubmission>(initial);
  /** A read that failed but is tried again. */
  const [pollNote, setPollNote] = useState<string | undefined>(undefined);
  /** A read that failed for good: polling stopped. */
  const [pollStopped, setPollStopped] = useState<string | undefined>(undefined);
  /** The `redirect()` an action ended with, thrown again while rendering (see the module comment). */
  const [navigation, setNavigation] = useState<{ readonly error: unknown } | undefined>(undefined);

  const polling =
    !isFinalSubmission(submission.status) && pollStopped === undefined && navigation === undefined;
  const submissionId = submission.id;
  const pollFailed = wording.pollFailed;

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
        poll(tenantId, submissionId).then(
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
              setPollNote(pollFailed);
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
            setPollNote(pollFailed);
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
  }, [polling, poll, pollFailed, tenantId, submissionId]);

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
        <span className="font-medium">{wording.title}</span>
        <Badge
          variant="outline"
          data-status={status}
          className={cn(TONE_CLASSES[status] ?? TONE_CLASSES["superseded"])}
        >
          {final ? null : <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {statusLabel(wording, status)}
        </Badge>
      </div>
      {/* A live region from the first render, so each new status is read out. */}
      <div role="status" className="grid gap-1" data-submission-message="">
        <SubmissionMessage submission={submission} environment={environment} wording={wording} />
      </div>
      {pollNote === undefined ? null : (
        <p className="text-muted-foreground" data-poll-note="">
          {pollNote}
        </p>
      )}
      {pollStopped === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>{wording.pollStoppedTitle}</AlertTitle>
          <AlertDescription>{pollStopped}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
