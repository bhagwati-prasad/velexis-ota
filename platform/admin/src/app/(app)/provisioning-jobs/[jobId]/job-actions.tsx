"use client";

import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { useState } from "react";

import {
  cancelProvisioningJob,
  retryProvisioningJob,
  type JobActionState,
  type JobOutcome,
} from "@/app/(app)/provisioning-jobs/[jobId]/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { JOB_ACTION_STRINGS as S, JOB_KIND_LABELS } from "@/lib/strings";

type Schemas = components["schemas"];

const IDLE: JobActionState = { status: "idle" };

/** The job an action created or changed: its id (linking to its page), kind, status and step. */
function JobOutcomeLine({ job }: { readonly job: JobOutcome }) {
  return (
    <p className="flex flex-wrap items-center gap-2" data-job={job.id}>
      <span className="text-muted-foreground">{S.job}</span>
      <Link
        href={`/provisioning-jobs/${encodeURIComponent(job.id)}`}
        className="font-mono text-xs break-all underline underline-offset-4"
      >
        {job.id}
      </Link>
      <span>{Object.hasOwn(JOB_KIND_LABELS, job.kind) ? JOB_KIND_LABELS[job.kind] : job.kind}</span>
      <StatusBadge kind="job" status={job.status} />
      {job.step === null ? null : <span className="font-mono text-xs">{S.stepOf(job.step)}</span>}
    </p>
  );
}

function Outcome({ state }: { readonly state: JobActionState | undefined }) {
  if (state === undefined || state.status === "idle") {
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
    <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
      <p className="font-medium">{state.action === "retry" ? S.retried : S.canceled}</p>
      <JobOutcomeLine job={state.job} />
    </div>
  );
}

export interface JobActionsProps {
  readonly jobId: string;
  readonly kind: Schemas["ProvisioningJobKind"];
  /** The job's status as the page was rendered with it: it decides which action is offered. */
  readonly status: Schemas["ProvisioningJobStatus"];
}

/**
 * The actions of a tenant job (README §2, PF-83), offered only in the states the API allows them: **Retry** on a
 * `failed` job (`ConfirmDialog`; the answer is the new job, linked) and **Cancel job** on a `queued` one (`ReasonDialog`,
 * 5–500 characters kept in the audit log). A `running`, `succeeded` or `canceled` job offers neither. The outcome of
 * the last action stays below the buttons while the revalidated page shows the job as it is now; a step-up, should
 * the API ask for one, runs the action again with the same form data.
 */
export function JobActions({ jobId, kind, status }: JobActionsProps) {
  const retry = useStepUpAction(retryProvisioningJob, IDLE);
  const cancel = useStepUpAction(cancelProvisioningJob, IDLE);
  // The outcome shown is the one of the action that ran last.
  const [latest, setLatest] = useState<"retry" | "cancel" | undefined>(undefined);
  const pending = retry.isPending || cancel.isPending;
  const outcome = latest === "retry" ? retry.state : latest === "cancel" ? cancel.state : undefined;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {status === "failed" ? (
          <ConfirmDialog
            trigger={<Button disabled={pending}>{S.retry}</Button>}
            title={S.retryTitle}
            description={kind === "provision" ? S.retryProvisionDescription : S.retryDescription}
            confirmLabel={S.retryConfirm}
            destructive={false}
            onConfirm={() => {
              const formData = new FormData();
              formData.set("jobId", jobId);
              setLatest("retry");
              retry.dispatch(formData);
            }}
          />
        ) : status === "queued" ? (
          <ReasonDialog
            trigger={
              <Button variant="destructive" disabled={pending}>
                {S.cancel}
              </Button>
            }
            title={S.cancelTitle}
            description={S.cancelDescription}
            confirmLabel={S.cancelConfirm}
            cancelLabel={S.keepJob}
            onConfirm={(formData) => {
              setLatest("cancel");
              cancel.dispatch(formData);
            }}
          >
            <input type="hidden" name="jobId" value={jobId} />
          </ReasonDialog>
        ) : (
          <p className="text-sm text-muted-foreground">{S.noAction}</p>
        )}
        {pending ? <span className="text-sm text-muted-foreground">{S.working}</span> : null}
      </div>
      <Outcome state={outcome} />
      {retry.stepUpDialog}
      {cancel.stepUpDialog}
    </div>
  );
}
