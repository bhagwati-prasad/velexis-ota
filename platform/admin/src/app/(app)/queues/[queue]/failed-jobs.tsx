"use client";

import type { components } from "@velexis/api-types/platform";
import Link from "next/link";

import { retryQueueJob, type QueueRetryState } from "@/app/(app)/queues/[queue]/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DateTime } from "@/components/date-time";
import { JsonView } from "@/components/json-view";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { QUEUE_DETAIL_STRINGS as S, formatCount } from "@/lib/strings";

/** One failed job as the table shows it: the fields of `FailedQueueJob`, and its provisioning job if it has one. */
export interface FailedJobRow {
  readonly id: components["schemas"]["FailedQueueJob"]["id"];
  readonly name: string;
  readonly failedReason: string | null;
  readonly attemptsMade: number;
  readonly failedAt: string | null;
  /** The job data, ids only (queue messages never carry secrets, tokens or card data). */
  readonly data: Readonly<Record<string, unknown>>;
  /** The tenant job of a dispatch attempt on `ota-tenant-ops` (`<jobId>-<attempt>`), which can be retried on its page. */
  readonly provisioningJobId: string | null;
}

const IDLE: QueueRetryState = { status: "idle" };

function Outcome({ state }: { readonly state: QueueRetryState }) {
  if (state.status === "idle") {
    return null;
  }
  if (state.status === "failed") {
    return (
      <Alert variant="destructive" data-notice="failed" data-code={state.code}>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <p role="status" data-notice="done" className="rounded-lg border px-4 py-3 text-sm font-medium">
      {S.retried(state.jobId)}
    </p>
  );
}

export interface FailedJobListProps {
  /** The queue (`QueueName`). */
  readonly queue: string;
  /** A platform queue: each failed job gets "Retry". OTA queues are view only. */
  readonly retryable: boolean;
  /** The failed jobs of `adminListFailedQueueJobs`, most recent failure first. */
  readonly jobs: readonly FailedJobRow[];
}

/**
 * The failed jobs of one queue (README §2, PF-84): id, name, failure reason, attempts, failure time and the id-only
 * data in `JsonView`. On a platform queue each row has **Retry** (`ConfirmDialog`, then `retryQueueJob`); an OTA queue
 * has no retry button at all. The outcome of the last retry stays above the table while the revalidated page drops
 * the retried job from the list, and a step-up, should the API ask for one, retries the same job again.
 */
export function FailedJobList({ queue, retryable, jobs }: FailedJobListProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(retryQueueJob, IDLE);
  return (
    <div className="grid gap-4">
      <Outcome state={state} />
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{S.empty}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{S.caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{S.columnId}</TableHead>
              <TableHead scope="col">{S.columnName}</TableHead>
              <TableHead scope="col">{S.columnReason}</TableHead>
              <TableHead scope="col" className="text-right">
                {S.columnAttempts}
              </TableHead>
              <TableHead scope="col">{S.columnFailedAt}</TableHead>
              <TableHead scope="col">{S.columnData}</TableHead>
              {retryable ? <TableHead scope="col">{S.columnAction}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id} className="align-top" data-job={job.id}>
                <TableCell>
                  <span className="grid gap-1">
                    <span className="font-mono text-xs break-all">{job.id}</span>
                    {job.provisioningJobId === null ? null : (
                      <Link
                        href={`/provisioning-jobs/${encodeURIComponent(job.provisioningJobId)}`}
                        className="text-xs font-medium underline underline-offset-4"
                      >
                        {S.provisioningJob}
                      </Link>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{job.name}</span>
                </TableCell>
                <TableCell className="max-w-md whitespace-normal">
                  {job.failedReason === null ? (
                    <span className="text-muted-foreground">{S.noReason}</span>
                  ) : (
                    <span className="break-words whitespace-pre-wrap">{job.failedReason}</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(job.attemptsMade)}</TableCell>
                <TableCell>
                  {job.failedAt === null ? (
                    <span className="text-muted-foreground">{S.unknownTime}</span>
                  ) : (
                    <DateTime value={job.failedAt} />
                  )}
                </TableCell>
                <TableCell className="min-w-64 whitespace-normal">
                  <JsonView value={job.data} label={S.dataLabel(job.id)} />
                </TableCell>
                {retryable ? (
                  <TableCell>
                    <ConfirmDialog
                      trigger={
                        <Button variant="outline" size="sm" disabled={isPending}>
                          {S.retry}
                          <span className="sr-only">{S.retryJobSuffix(job.id)}</span>
                        </Button>
                      }
                      title={S.retryTitle(job.id)}
                      description={S.retryDescription}
                      confirmLabel={S.retryConfirm}
                      destructive={false}
                      onConfirm={() => {
                        const formData = new FormData();
                        formData.set("queue", queue);
                        formData.set("jobId", job.id);
                        dispatch(formData);
                      }}
                    />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {isPending ? <p className="text-sm text-muted-foreground">{S.working}</p> : null}
      {stepUpDialog}
    </div>
  );
}
