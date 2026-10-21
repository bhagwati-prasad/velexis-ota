"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { QUEUE_DETAIL_STRINGS } from "@/lib/strings";

/**
 * The server action of `/queues/[queue]` (README §2, §4; ADR-0009 item 11, PF-84): retry one failed job of a
 * **platform** queue (`adminRetryQueueJob`). OTA queues (`ota-*`, `ota-tenant-ops` included) are view only: the page
 * offers no retry for them, and this action refuses them without calling the API, which would answer `403 FORBIDDEN`
 * (`ota_queue`) anyway.
 *
 * The form is checked before the call (the queue by the `QueueName` pattern and its `platform-` owner, the job id by
 * the `QueueJobId` pattern), so an action called with made-up fields sends nothing. An ended session goes to
 * `/sign-in` and back to the queue; `REAUTH_REQUIRED` returns the previous state with `stepUp: true` for
 * `useStepUpAction`. A success revalidates the queue's page and the queue list, so the job leaves the failed list and
 * the counts follow. The state carries only the job id and the admin's own words.
 */

/** The state of the retry form of a queue's failed jobs. */
export type QueueRetryState = { readonly stepUp?: true } & (
  | { readonly status: "idle" }
  | { readonly status: "done"; readonly jobId: string }
  | {
      readonly status: "failed";
      readonly jobId: string;
      /** The error code, for tests and the `data-code` of the notice; never shown. */
      readonly code: PlatformErrorCode;
      readonly message: string;
    }
);

/** `QueueName` of the platform document, limited to the platform's own queues (ADR-0009 item 4: `<owner>-<topic>`). */
const PLATFORM_QUEUE = /^platform-[a-z][a-z0-9-]*$/;
const QUEUE_NAME_MAX_LENGTH = 64;
/** `QueueJobId` of the platform document: a BullMQ id, or a custom one such as `<jobId>-<attempt>`. */
const QUEUE_JOB_ID = /^[A-Za-z0-9_.:-]{1,255}$/;

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function queuePath(queue: string): string {
  return `/queues/${queue}`;
}

/** Codes the retry words its own way; the others get the catalogue's message. */
const RETRY_CODES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  NOT_FOUND: QUEUE_DETAIL_STRINGS.jobGone,
  // The fields are checked before the call, so the API refusing the request means the form is out of date.
  VALIDATION_FAILED: QUEUE_DETAIL_STRINGS.formExpired,
  // The API cannot reach Redis (or the admin cannot reach the API).
  SERVICE_UNAVAILABLE: QUEUE_DETAIL_STRINGS.unavailable,
};

/** The admin's message for a failed retry. */
function messageOf(error: ApiError): string {
  if (error.code === "FORBIDDEN" && error.details["reason"] === "ota_queue") {
    return QUEUE_DETAIL_STRINGS.otaQueue;
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return QUEUE_DETAIL_STRINGS.rateLimitedFor(error.retryAfterSeconds);
  }
  return RETRY_CODES[error.code] ?? errorMessage(error);
}

/**
 * Moves one failed job of a platform queue back to waiting with a new attempt budget (`adminRetryQueueJob`), from
 * the fields `queue` and `jobId`; the platform worker runs it again, and the API writes the audit row. A job that is no
 * longer failed (retried by someone else, or removed by BullMQ) answers `NOT_FOUND`, worded for the admin.
 */
export async function retryQueueJob(previous: QueueRetryState, formData: FormData): Promise<QueueRetryState> {
  const queue = text(formData, "queue");
  const jobId = text(formData, "jobId");
  if (!QUEUE_JOB_ID.test(jobId)) {
    return {
      status: "failed",
      jobId: "",
      code: "VALIDATION_FAILED",
      message: QUEUE_DETAIL_STRINGS.formExpired,
    };
  }
  if (queue.length > QUEUE_NAME_MAX_LENGTH || !PLATFORM_QUEUE.test(queue)) {
    // An OTA queue, or no queue name at all: nothing is retried here.
    return {
      status: "failed",
      jobId,
      code: queue.startsWith("ota-") ? "FORBIDDEN" : "VALIDATION_FAILED",
      message: queue.startsWith("ota-") ? QUEUE_DETAIL_STRINGS.otaQueue : QUEUE_DETAIL_STRINGS.formExpired,
    };
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/queues/{queue}/jobs/{jobId}/retry", {
    params: { path: { queue, jobId } },
  });
  if (result.error !== undefined) {
    const { error } = result;
    if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: queuePath(queue) }).toString()}`);
    }
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    return { status: "failed", jobId, code: error.code, message: messageOf(error) };
  }
  revalidatePath(queuePath(queue));
  revalidatePath("/queues");
  return { status: "done", jobId };
}
