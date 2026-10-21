import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { FailedJobList, type FailedJobRow } from "@/app/(app)/queues/[queue]/failed-jobs";
import { toneClasses } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { QUEUE_DETAIL_STRINGS as S, QUEUE_LIST_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: QUEUE_LIST_STRINGS.title };

type FailedQueueJob = components["schemas"]["FailedQueueJob"];

/** `QueueName` of the platform document; another value is no queue, and the API is not asked. */
const QUEUE_NAME = /^(platform|ota)-[a-z][a-z0-9-]*$/;
const QUEUE_NAME_MAX_LENGTH = 64;

/** The queue of every dispatch attempt of a tenant job (`OTA_TENANT_OPS` of `@velexis/api-types/jobs`). */
const TENANT_OPS_QUEUE = "ota-tenant-ops";
/** The BullMQ id of a dispatch attempt, `<jobId>-<attempt>` (`bullmqJobId` of `@velexis/api-types/jobs`). */
const DISPATCH_ATTEMPT_ID = /^(job_[0-9A-HJKMNP-TV-Z]{26})-[1-9][0-9]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The fields of one failed job that the table shows. The rows go to a client component, so everything they hold is
 * sent to the browser: only these fields go, whatever else an answer might carry. A dispatch attempt of a tenant job
 * also names that job, whose page can retry it.
 */
function rowOf(queue: string, job: FailedQueueJob): FailedJobRow {
  const attempt = queue === TENANT_OPS_QUEUE ? DISPATCH_ATTEMPT_ID.exec(job.id) : null;
  return {
    id: job.id,
    name: job.name,
    failedReason: job.failedReason,
    attemptsMade: job.attemptsMade,
    failedAt: job.failedAt,
    data: isRecord(job.data) ? job.data : {},
    provisioningJobId: attempt?.[1] ?? null,
  };
}

function BackLink() {
  return (
    <Link href="/queues" className="text-sm font-medium underline underline-offset-4">
      {S.backToList}
    </Link>
  );
}

/**
 * `/queues/[queue]` (README §2, PF-84): the failed jobs of one queue of either backend from
 * `adminListFailedQueueJobs`, most recent failure first (at most 50), with their reason, attempts, failure time and
 * id-only data (`JsonView`). The owner is the name's prefix (`<owner>-<topic>`, ADR-0009 item 4): a **platform**
 * queue offers **Retry** on each job (`adminRetryQueueJob`), an **OTA** queue (`ota-*`, `ota-tenant-ops` included)
 * shows its failures with no retry button, since the OTA admin or the developer retries those. A failed dispatch
 * attempt of `ota-tenant-ops` links to its provisioning job, which can be retried there. A value that is no queue name
 * renders the not-found page without a call, and so does a queue neither backend has.
 */
export default async function QueuePage({ params }: Readonly<{ params: Promise<{ queue: string }> }>) {
  const { queue } = await params;
  if (queue.length > QUEUE_NAME_MAX_LENGTH || !QUEUE_NAME.test(queue)) {
    notFound();
  }
  const api = await platformApi();
  const result = await api.GET("/v1/admin/queues/{queue}/failed", { params: { path: { queue } } });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect("/sign-in");
    }
    if (code === "NOT_FOUND" || code === "VALIDATION_FAILED") {
      notFound();
    }
  }
  const retryable = queue.startsWith("platform-");
  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <BackLink />
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-3xl font-semibold tracking-tight">{queue}</h1>
          <Badge
            variant="outline"
            data-owner={retryable ? "platform" : "ota"}
            className={toneClasses(retryable ? "info" : "neutral")}
          >
            {retryable ? S.platformOwner : S.otaOwner}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{retryable ? S.platformIntro : S.otaNotice}</p>
      </div>
      <section aria-labelledby="queue-failed" className="grid gap-3">
        <div className="grid gap-1">
          <h2 id="queue-failed" className="text-lg font-semibold tracking-tight">
            {S.failedTitle}
          </h2>
          <p className="text-sm text-muted-foreground">{S.failedIntro}</p>
        </div>
        {result.error === undefined ? (
          <FailedJobList
            queue={queue}
            retryable={retryable}
            jobs={result.data.data.map((job) => rowOf(queue, job))}
          />
        ) : (
          <Alert variant="destructive">
            <AlertTitle>{S.unavailableTitle}</AlertTitle>
            <AlertDescription>
              {result.error.code === "SERVICE_UNAVAILABLE" ? S.unavailable : errorMessage(result.error)}
            </AlertDescription>
          </Alert>
        )}
      </section>
    </div>
  );
}
