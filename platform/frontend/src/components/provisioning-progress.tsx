"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import type {
  SetupPoll,
  SetupProgress,
  SetupRetry,
  SetupReveal,
  SetupStep,
} from "@/app/(app)/otas/[tenantId]/setup/actions";
import { SecretRevealPanel, type SecretValue } from "@/components/secret-reveal-panel";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ERROR_MESSAGES, SETUP_STEP_LABELS, SETUP_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The live progress of an OTA's set-up (README §4 `ProvisioningProgress`, §5 polling; flow provisioning.md; PF-11).
 *
 * It starts from the progress the page read on the server and calls the `poll` server action (`getProvisioning`)
 * every 2 seconds, one call at a time, until the set-up reaches a final state: the OTA is `active`, `failed` (or
 * otherwise out of set-up), or its job `failed` or was `canceled` (PF-11 AC1). A read that may pass (rate limit, API
 * unavailable) is tried again; any other failure stops the polling with its message. The steps show with
 * `StatusBadge`.
 *
 * - **Active:** the storefront link, the OTA dashboard link and, for owners, "Reveal the test keys" (`reveal`,
 *   `revealInitialKeys`): the two keys show once in `SecretRevealPanel`, in React state only, and
 *   `KEYS_ALREADY_REVEALED` explains how to get new keys (PF-11 AC3).
 * - **Failed:** where the set-up stopped, the attempts and the job id for support and, for owners only, "Retry the
 *   set-up" (`retry`, `retryProvisioning`), which starts polling again for the new job (PF-11 AC2).
 *
 * The role only decides what is offered; the API enforces it again. The actions come from the page, bound to the OTA.
 * When one of them ends the request with `redirect()` (an ended session goes to sign-in), Next.js rejects the call
 * with that redirect; it is thrown again while rendering, so the router's redirect boundary navigates, as it does for
 * a form's action.
 */

/** How long the page waits between two reads of the progress (README §5). */
export const SETUP_POLL_INTERVAL_MS = 2_000;

/** The longest wait a `Retry-After` may ask for between two reads. */
const MAX_POLL_DELAY_MS = 60_000;

/** The steps of a set-up, in the order they run (the labels' order). */
const KNOWN_STEPS: readonly string[] = Object.keys(SETUP_STEP_LABELS);

/**
 * The set-up is over: the OTA left `provisioning` (`active`, `failed`, `suspended`), or its job ended without
 * activating it. Nothing changes on its own any more, so polling stops.
 */
export function isFinalProgress(progress: SetupProgress): boolean {
  return (
    progress.tenantStatus !== "provisioning" ||
    progress.jobStatus === "failed" ||
    progress.jobStatus === "canceled"
  );
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

/** How the set-up ended, or `running` while it is not over. */
type Outcome = "running" | "active" | "failed" | "canceled" | "suspended";

function outcomeOf(progress: SetupProgress): Outcome {
  if (progress.tenantStatus === "active") {
    return "active";
  }
  if (progress.tenantStatus === "failed" || progress.jobStatus === "failed") {
    return "failed";
  }
  if (progress.jobStatus === "canceled") {
    return "canceled";
  }
  return progress.tenantStatus === "suspended" ? "suspended" : "running";
}

/** The state of one step on screen: finished (`succeeded`, `failed`, `skipped`), or not finished yet. */
type StepState = SetupStep["status"] | "running" | "waiting" | "not_run";

interface StepRow {
  readonly step: string;
  readonly state: StepState;
}

/** The label of a step; a step the portal does not know yet shows its own name. */
export function stepLabel(step: string): string {
  return SETUP_STEP_LABELS[step] ?? step.replaceAll("_", " ");
}

/**
 * The step log with one entry per step: its latest, at the place where the step first ran. The log only grows: a
 * failed attempt of the OTA worker, each try of a post-step and every new attempt append their steps again (flow
 * provisioning.md, "Failure handling"), so a step may be in it several times.
 */
function latestSteps(steps: readonly SetupStep[]): SetupStep[] {
  const latest = new Map<string, SetupStep>();
  for (const entry of steps) {
    latest.set(entry.step, entry);
  }
  return [...latest.values()];
}

/**
 * The steps to show, each once: the finished ones in the order they ran, then the steps still to come. While the job
 * runs, a step whose last try failed runs again, so it is one of those, and the first of them is in progress. Once
 * the job failed, the step it stopped at is failed and the others did not run (a failure an earlier attempt left
 * further on included: the last attempt did not get that far).
 */
function stepRows(progress: SetupProgress): StepRow[] {
  const outcome = outcomeOf(progress);
  const attemptRuns = outcome === "running" && progress.jobStatus === "running";
  const latest = latestSteps(progress.steps);
  const finished: StepRow[] = latest
    .filter((entry) => !(attemptRuns && entry.status === "failed"))
    .map((entry) => ({ step: entry.step, state: entry.status }));
  const done = new Set(finished.map((row) => row.step));
  const remaining = [...new Set([...KNOWN_STEPS, ...latest.map((entry) => entry.step)])].filter(
    (step) => !done.has(step),
  );
  if (outcome === "active") {
    return finished;
  }
  if (outcome === "failed") {
    const stoppedAt = stoppedStep(progress);
    return [
      ...finished.map((row): StepRow =>
        row.state === "failed" && row.step !== stoppedAt ? { ...row, state: "not_run" } : row,
      ),
      ...remaining.map((step): StepRow => ({ step, state: step === stoppedAt ? "failed" : "not_run" })),
    ];
  }
  if (outcome !== "running") {
    return [...finished, ...remaining.map((step): StepRow => ({ step, state: "not_run" }))];
  }
  return [
    ...finished,
    ...remaining.map((step, index): StepRow => ({
      step,
      state: attemptRuns && index === 0 ? "running" : "waiting",
    })),
  ];
}

/**
 * Where a failed set-up stopped: its last failed step; otherwise the step the job reports, when that one did not
 * finish; otherwise the first step that did not run.
 */
function stoppedStep(progress: SetupProgress): string | undefined {
  const failed = [...progress.steps].reverse().find((entry) => entry.status === "failed");
  if (failed !== undefined) {
    return failed.step;
  }
  const done = new Set(progress.steps.map((entry) => entry.step));
  const { currentStep } = progress;
  if (currentStep !== null && Object.hasOwn(SETUP_STEP_LABELS, currentStep) && !done.has(currentStep)) {
    return currentStep;
  }
  return KNOWN_STEPS.find((step) => !done.has(step));
}

/** The one-line summary of the progress, read out when it changes. */
function summaryOf(progress: SetupProgress, rows: readonly StepRow[]): string {
  switch (outcomeOf(progress)) {
    case "active":
      return SETUP_STRINGS.summaryActive;
    case "failed":
      return SETUP_STRINGS.summaryFailed;
    case "canceled":
      return SETUP_STRINGS.summaryCanceled;
    case "suspended":
      return SETUP_STRINGS.summarySuspended;
    case "running":
      break;
  }
  if (progress.jobStatus === "queued") {
    return progress.attempt > 0 && progress.hasError
      ? SETUP_STRINGS.summaryRetrying(progress.attempt, progress.maxAttempts)
      : SETUP_STRINGS.summaryQueued;
  }
  const done = rows.filter((row) => row.state === "succeeded" || row.state === "skipped").length;
  return SETUP_STRINGS.summaryRunning(done, Math.max(rows.length, KNOWN_STEPS.length));
}

/** The status of one step: a `StatusBadge` once it finished, otherwise where it stands. */
function StepStatus({ state }: { readonly state: StepState }) {
  switch (state) {
    case "succeeded":
    case "failed":
    case "skipped":
      return <StatusBadge kind="jobStep" status={state} />;
    case "running":
      return (
        <Badge variant="outline" data-status="running" className="border-transparent bg-sky-100 text-sky-900">
          <LoaderCircle aria-hidden="true" className="animate-spin" />
          {SETUP_STRINGS.stepRunning}
        </Badge>
      );
    case "waiting":
      return (
        <span data-status="waiting" className="text-xs text-muted-foreground">
          {SETUP_STRINGS.stepWaiting}
        </span>
      );
    case "not_run":
      return (
        <span data-status="not_run" className="text-xs text-muted-foreground">
          {SETUP_STRINGS.stepNotRun}
        </span>
      );
  }
}

export interface ProvisioningProgressProps {
  /** The progress the page read on the server. */
  readonly initial: SetupProgress;
  /** The caller is an owner of the OTA: retry and reveal are offered (scope §1.2; the API checks it again). */
  readonly isOwner: boolean;
  /** `https://<primary host>/`. */
  readonly storefrontUrl: string;
  /** The OTA dashboard (`/otas/<tenantId>`). */
  readonly dashboardHref: string;
  /** The API keys page (`/otas/<tenantId>/api-keys`), where new keys are made. */
  readonly apiKeysHref: string;
  /** Reads the progress (`getSetupProgress` bound to the OTA). */
  readonly poll: () => Promise<SetupPoll>;
  /** Retries a failed set-up (`retrySetup` bound to the OTA). */
  readonly retry: () => Promise<SetupRetry>;
  /** Reveals the test keys once (`revealSetupKeys` bound to the OTA). */
  readonly reveal: () => Promise<SetupReveal>;
}

/** The progress, and what can be done once the set-up is over (see the module comment). */
export function ProvisioningProgress({
  initial,
  isOwner,
  storefrontUrl,
  dashboardHref,
  apiKeysHref,
  poll,
  retry,
  reveal,
}: ProvisioningProgressProps) {
  const [progress, setProgress] = useState<SetupProgress>(initial);
  /** A read that failed but is tried again. */
  const [pollNote, setPollNote] = useState<string | undefined>(undefined);
  /** A read that failed for good: polling stopped. */
  const [pollStopped, setPollStopped] = useState<string | undefined>(undefined);
  /** Bumped by a retry, so polling starts again for the new job. */
  const [generation, setGeneration] = useState(0);

  const [retryPending, startRetry] = useTransition();
  const [retryError, setRetryError] = useState<string | undefined>(undefined);

  const [revealPending, startReveal] = useTransition();
  /** The revealed keys, in memory only; emptied once the person stored them. */
  const [revealed, setRevealed] = useState<readonly SecretValue[] | undefined>(undefined);
  /** The reveal answered `KEYS_ALREADY_REVEALED`, or succeeded: the keys cannot be revealed (again). */
  const [keysGone, setKeysGone] = useState(false);
  const [revealError, setRevealError] = useState<string | undefined>(undefined);
  /** The `redirect()` an action ended with, thrown again while rendering (see the module comment). */
  const [navigation, setNavigation] = useState<{ readonly error: unknown } | undefined>(undefined);

  const polling = !isFinalProgress(progress) && pollStopped === undefined && navigation === undefined;

  useEffect(() => {
    if (!polling) {
      return undefined;
    }
    // One read at a time: the next one is scheduled when the previous answer arrived. A newer effect (a retry, or
    // the page going away) cancels the chain, and a late answer of the old chain changes nothing.
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        poll().then(
          (result) => {
            if (!current) {
              return;
            }
            if (result.status === "ok") {
              setPollNote(undefined);
              setProgress(result.progress);
              if (!isFinalProgress(result.progress)) {
                schedule(SETUP_POLL_INTERVAL_MS);
              }
              return;
            }
            if (result.transient) {
              setPollNote(SETUP_STRINGS.pollFailed);
              const wait = (result.retryAfterSeconds ?? 0) * 1_000;
              schedule(Math.min(Math.max(SETUP_POLL_INTERVAL_MS, wait), MAX_POLL_DELAY_MS));
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
            setPollNote(SETUP_STRINGS.pollFailed);
            schedule(SETUP_POLL_INTERVAL_MS);
          },
        );
      }, delay);
    };
    schedule(SETUP_POLL_INTERVAL_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [polling, poll, generation]);

  // The updates after an `await` run in a transition of their own, so they show together with the end of "pending".
  function onRetry(): void {
    setRetryError(undefined);
    startRetry(async () => {
      let result: SetupRetry;
      try {
        result = await retry();
      } catch (error) {
        startRetry(() =>
          isNavigation(error) ? setNavigation({ error }) : setRetryError(ERROR_MESSAGES.SERVICE_UNAVAILABLE),
        );
        return;
      }
      if (result.status === "ok") {
        const { progress: next } = result;
        startRetry(() => {
          setProgress(next);
          setPollNote(undefined);
          setPollStopped(undefined);
          setGeneration((value) => value + 1);
        });
        return;
      }
      const { message } = result;
      if (result.code !== "PROVISIONING_NOT_RETRYABLE") {
        startRetry(() => setRetryError(message));
        return;
      }
      // Someone else may have retried already: show where the set-up stands now.
      let fresh: SetupPoll | undefined;
      try {
        fresh = await poll();
      } catch (error) {
        if (isNavigation(error)) {
          startRetry(() => setNavigation({ error }));
          return;
        }
      }
      startRetry(() => {
        setRetryError(message);
        if (fresh?.status === "ok") {
          setProgress(fresh.progress);
        }
      });
    });
  }

  function onReveal(): void {
    setRevealError(undefined);
    startReveal(async () => {
      let result: SetupReveal;
      try {
        result = await reveal();
      } catch (error) {
        startReveal(() =>
          isNavigation(error) ? setNavigation({ error }) : setRevealError(ERROR_MESSAGES.SERVICE_UNAVAILABLE),
        );
        return;
      }
      if (result.status === "revealed") {
        const { keys } = result;
        startReveal(() => {
          setRevealed(keys);
          setKeysGone(true);
        });
        return;
      }
      const { alreadyRevealed, message } = result;
      startReveal(() => {
        if (alreadyRevealed) {
          setKeysGone(true);
        }
        setRevealError(message);
      });
    });
  }

  if (navigation !== undefined) {
    // While rendering, where the router's redirect boundary catches it and navigates.
    throw navigation.error;
  }

  const rows = stepRows(progress);
  const outcome = outcomeOf(progress);
  const summary = summaryOf(progress, rows);
  const keysAvailable = progress.initialKeysAvailable && !keysGone;
  const stoppedAt = outcome === "failed" ? stoppedStep(progress) : undefined;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge kind="tenant" status={progress.tenantStatus} />
        <p id="setup-summary" role="status" className="font-medium">
          {summary}
        </p>
      </div>
      {pollNote === undefined ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {pollNote}
        </p>
      )}
      {retryError === undefined || outcome === "failed" ? null : (
        // A refused retry of a set-up that is no longer failed (someone else retried): the message stays in view.
        <p role="alert" className="text-sm text-destructive">
          {retryError}
        </p>
      )}
      {pollStopped === undefined ? null : (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{SETUP_STRINGS.pollStoppedTitle}</AlertTitle>
          <AlertDescription>{pollStopped}</AlertDescription>
        </Alert>
      )}

      {outcome === "active" ? (
        <section aria-labelledby="setup-ready-title" className="grid gap-4 rounded-xl border p-5">
          <h2 id="setup-ready-title" className="text-xl font-semibold tracking-tight">
            {SETUP_STRINGS.readyTitle}
          </h2>
          <p className="text-muted-foreground">{SETUP_STRINGS.readyText}</p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <a href={storefrontUrl}>{SETUP_STRINGS.storefrontLink}</a>
            </Button>
            <Button asChild variant="outline">
              <Link href={dashboardHref}>{SETUP_STRINGS.dashboardLink}</Link>
            </Button>
          </div>
          {isOwner ? (
            <section aria-labelledby="setup-keys-title" className="grid gap-3 border-t pt-4">
              <h3 id="setup-keys-title" className="text-lg font-semibold">
                {SETUP_STRINGS.keysTitle}
              </h3>
              {revealed === undefined ? null : (
                <SecretRevealPanel
                  title={SETUP_STRINGS.revealedTitle}
                  secrets={revealed}
                  onDismiss={() => setRevealed([])}
                >
                  <p className="text-sm text-muted-foreground">{SETUP_STRINGS.revealedHint}</p>
                </SecretRevealPanel>
              )}
              {keysAvailable ? (
                <>
                  <p className="text-sm text-muted-foreground">{SETUP_STRINGS.keysIntro}</p>
                  <div>
                    <Button type="button" onClick={onReveal} disabled={revealPending}>
                      {revealPending ? SETUP_STRINGS.revealing : SETUP_STRINGS.reveal}
                    </Button>
                  </div>
                  {revealError === undefined ? null : (
                    <p role="alert" className="text-sm text-destructive">
                      {revealError}
                    </p>
                  )}
                </>
              ) : revealed === undefined ? (
                // Shown already, or the 24 hours passed: new keys come from the API keys page.
                <p role={revealError === undefined ? undefined : "alert"} className="text-sm">
                  {revealError ?? ERROR_MESSAGES.KEYS_ALREADY_REVEALED}{" "}
                  <Link href={apiKeysHref} className="font-medium underline underline-offset-4">
                    {SETUP_STRINGS.apiKeysLink}
                  </Link>
                </p>
              ) : null}
            </section>
          ) : keysAvailable ? (
            <p className="text-sm text-muted-foreground">{SETUP_STRINGS.keysOwnerOnly}</p>
          ) : null}
        </section>
      ) : null}

      {outcome === "failed" ? (
        <section
          aria-labelledby="setup-failed-title"
          className="grid gap-3 rounded-xl border border-destructive/40 p-5"
        >
          <h2 id="setup-failed-title" className="text-xl font-semibold tracking-tight text-destructive">
            {SETUP_STRINGS.failedTitle}
          </h2>
          {stoppedAt === undefined ? null : <p>{SETUP_STRINGS.failedAt(stepLabel(stoppedAt))}</p>}
          <p>{SETUP_STRINGS.failedAttempts(progress.attempt, progress.maxAttempts)}</p>
          <p>{SETUP_STRINGS.failedHelp}</p>
          <p className="text-sm text-muted-foreground">{SETUP_STRINGS.failedReference(progress.jobId)}</p>
          {progress.tenantStatus !== "failed" ? null : isOwner ? (
            <div className="grid gap-2">
              <div>
                <Button type="button" onClick={onRetry} disabled={retryPending}>
                  {retryPending ? SETUP_STRINGS.retrying : SETUP_STRINGS.retry}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{SETUP_STRINGS.retryHint}</p>
              {retryError === undefined ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {retryError}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{SETUP_STRINGS.retryOwnerOnly}</p>
          )}
        </section>
      ) : null}

      {outcome === "canceled" || outcome === "suspended" ? (
        <p className="rounded-xl border p-5">
          {outcome === "canceled" ? SETUP_STRINGS.canceledText : SETUP_STRINGS.suspendedText}{" "}
          {outcome === "suspended" ? (
            <Link href={dashboardHref} className="font-medium underline underline-offset-4">
              {SETUP_STRINGS.dashboardLink}
            </Link>
          ) : null}
        </p>
      ) : null}

      <section aria-labelledby="setup-steps-title" className="grid gap-3">
        <h2 id="setup-steps-title" className="text-lg font-semibold tracking-tight">
          {SETUP_STRINGS.stepsTitle}
        </h2>
        <ol className="grid gap-2">
          {rows.map((row) => (
            <li
              key={row.step}
              data-step={row.step}
              data-state={row.state}
              className={cn(
                "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2 text-sm",
                row.state === "waiting" || row.state === "not_run" ? "text-muted-foreground" : undefined,
              )}
            >
              <span>{stepLabel(row.step)}</span>
              <StepStatus state={row.state} />
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
