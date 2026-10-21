"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { JOB_ACTION_STRINGS, REASON_MAX_LENGTH, REASON_MIN_LENGTH, REASON_STRINGS } from "@/lib/strings";

/**
 * The server actions of `/provisioning-jobs/[jobId]` (README §2, §4; PADR-0001 item 7, PF-83): retry a `failed` job
 * (`adminRetryProvisioningJob`, a confirmation) and cancel a `queued` one (`adminCancelProvisioningJob`, **reason**).
 *
 * Each action checks its form before it calls the platform API (the job id by its pattern, the reason as `AdminReason`
 * counts it: 5 to 500 code points after trimming), so an action called with made-up fields sends nothing. An ended
 * session goes to `/sign-in` and back to the job; `REAUTH_REQUIRED` returns the previous state with `stepUp: true`, so
 * `useStepUpAction` asks for a TOTP code and runs the action again with the same form data. A success revalidates the
 * job's page, the job list and the OTA's page, so they show the job as it is now. The states carry only what the form
 * shows, in the admin's own words: never the API's message.
 */

type Schemas = components["schemas"];

/** What the form shows of a job an action created or changed. */
export interface JobOutcome {
  readonly id: string;
  readonly kind: Schemas["ProvisioningJobKind"];
  readonly status: Schemas["ProvisioningJobStatus"];
  readonly step: string | null;
}

/** A refused action, in the admin's words. */
export interface JobActionFailure {
  readonly status: "failed";
  /** The error code, for tests and the `data-code` of the notice; never shown. */
  readonly code: PlatformErrorCode;
  readonly message: string;
}

/** The state of the retry and cancel forms of a job. */
export type JobActionState = { readonly stepUp?: true } & (
  | { readonly status: "idle" }
  | {
      readonly status: "done";
      readonly action: "retry" | "cancel";
      /** The new job of a retry (the failed one stays as history), or the canceled job. */
      readonly job: JobOutcome;
    }
  | JobActionFailure
);

/** `ProvisioningJobId` of the platform document. */
const JOB_ID = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * What is wrong with `value` as an `AdminReason` (5–500 code points after trimming), or `undefined`: the rule of
 * `reasonProblem` in `ReasonDialog`, which a server module cannot import (it is a client module).
 */
function reasonProblem(value: string): string | undefined {
  const length = [...value.trim()].length;
  if (length === 0) {
    return REASON_STRINGS.required;
  }
  if (length < REASON_MIN_LENGTH) {
    return REASON_STRINGS.tooShort;
  }
  return length > REASON_MAX_LENGTH ? REASON_STRINGS.tooLong : undefined;
}

function invalid(message: string): JobActionFailure {
  return { status: "failed", code: "VALIDATION_FAILED", message };
}

function jobPath(jobId: string): string {
  return `/provisioning-jobs/${jobId}`;
}

/** Codes both actions word their own way; the others get the catalogue's message. */
const ACTION_CODES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  NOT_FOUND: JOB_ACTION_STRINGS.jobGone,
  // The job id is checked before the call, so the API refusing the request means the form is out of date.
  VALIDATION_FAILED: JOB_ACTION_STRINGS.formExpired,
};

/** The admin's message for a failed call; `reasons` words the `details.reason` of `reasonCode`. */
function messageOf(
  error: ApiError,
  reasonCode: PlatformErrorCode,
  reasons: Readonly<Record<string, string>>,
): string {
  const reason = error.details["reason"];
  if (error.code === reasonCode && typeof reason === "string" && Object.hasOwn(reasons, reason)) {
    return reasons[reason] ?? errorMessage(error);
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return JOB_ACTION_STRINGS.rateLimitedFor(error.retryAfterSeconds);
  }
  return ACTION_CODES[error.code] ?? errorMessage(error);
}

/**
 * The state after a failed call: sign-in (and back to the job) for an ended session, a step-up request for
 * `REAUTH_REQUIRED`, otherwise the failure in the admin's words.
 */
function failed(
  previous: JobActionState,
  error: ApiError,
  jobId: string,
  reasonCode: PlatformErrorCode,
  reasons: Readonly<Record<string, string>>,
): JobActionState {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: jobPath(jobId) }).toString()}`);
  }
  if (error.code === "REAUTH_REQUIRED") {
    return { ...previous, stepUp: true };
  }
  return { status: "failed", code: error.code, message: messageOf(error, reasonCode, reasons) };
}

/** After a change: the job's page, the list and the OTA's page (its jobs tab) show the jobs as they are now. */
function revalidateJob(jobId: string, job: Schemas["AdminProvisioningJob"]): void {
  revalidatePath(jobPath(jobId));
  if (job.id !== jobId) {
    revalidatePath(jobPath(job.id));
  }
  revalidatePath("/provisioning-jobs");
  revalidatePath(`/tenants/${job.tenantId}`);
}

function outcomeOf(job: Schemas["AdminProvisioningJob"]): JobOutcome {
  return { id: job.id, kind: job.kind, status: job.status, step: job.step };
}

/** `PROVISIONING_NOT_RETRYABLE` by its `details.reason`. */
const NOT_RETRYABLE: Readonly<Record<string, string>> = {
  not_failed: JOB_ACTION_STRINGS.notFailed,
  tenant_not_failed: JOB_ACTION_STRINGS.tenantNotFailed,
  job_active: JOB_ACTION_STRINGS.jobActive,
};

/** `CONFLICT` of a cancel by its `details.reason`. */
const NOT_CANCELABLE: Readonly<Record<string, string>> = {
  not_queued: JOB_ACTION_STRINGS.notQueued,
};

/**
 * Retries a `failed` job (`adminRetryProvisioningJob`) from the field `jobId`: the API starts a **new** job of the
 * same kind and input (a failed `provision` job also sets its OTA back to `provisioning`) and keeps the failed one as
 * history. The answer is the new job, which the form links. A job that is not failed, an OTA that is not failed, or a
 * job of that kind already active answers `PROVISIONING_NOT_RETRYABLE`, worded by its reason.
 */
export async function retryProvisioningJob(
  previous: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const jobId = text(formData, "jobId");
  if (!JOB_ID.test(jobId)) {
    return invalid(JOB_ACTION_STRINGS.formExpired);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/provisioning-jobs/{jobId}/retry", {
    params: { path: { jobId } },
  });
  if (result.error !== undefined) {
    return failed(previous, result.error, jobId, "PROVISIONING_NOT_RETRYABLE", NOT_RETRYABLE);
  }
  revalidateJob(jobId, result.data.job);
  return { status: "done", action: "retry", job: outcomeOf(result.data.job) };
}

/**
 * Cancels a `queued` job (`adminCancelProvisioningJob`) from the fields `jobId` and `reason` (5–500 characters, kept
 * in the audit log): it becomes `canceled`, nothing more is sent to the OTA worker, and the OTA's status stays. A job
 * that was dispatched or ended in the meantime answers `CONFLICT` (`not_queued`).
 */
export async function cancelProvisioningJob(
  previous: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const jobId = text(formData, "jobId");
  if (!JOB_ID.test(jobId)) {
    return invalid(JOB_ACTION_STRINGS.formExpired);
  }
  const reason = text(formData, "reason");
  const problem = reasonProblem(reason);
  if (problem !== undefined) {
    return invalid(problem);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/provisioning-jobs/{jobId}/cancel", {
    params: { path: { jobId } },
    body: { reason: reason.trim() },
  });
  if (result.error !== undefined) {
    return failed(previous, result.error, jobId, "CONFLICT", NOT_CANCELABLE);
  }
  revalidateJob(jobId, result.data.job);
  return { status: "done", action: "cancel", job: outcomeOf(result.data.job) };
}
