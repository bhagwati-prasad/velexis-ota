import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { JobActions } from "@/app/(app)/provisioning-jobs/[jobId]/job-actions";
import { DateTime } from "@/components/date-time";
import { JsonView } from "@/components/json-view";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { JOB_ACTION_STRINGS, JOB_DETAIL_STRINGS as S, JOB_KIND_LABELS } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type JobDetail = Schemas["AdminProvisioningJobDetail"];
type Step = Schemas["ProvisioningStep"];

// Every kind of the platform document has a label: a new one fails the type check until it has one.
const KINDS: Readonly<Record<Schemas["ProvisioningJobKind"], string>> = JOB_KIND_LABELS;

/** `ProvisioningJobId` of the platform document; another value is no job, and the API is not asked. */
const JOB_ID = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The queue of every dispatch attempt of a tenant job (`OTA_TENANT_OPS` of `@velexis/api-types/jobs`). */
const TENANT_OPS_QUEUE = "ota-tenant-ops";

const LINK_CLASS = "font-medium underline underline-offset-4";

function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}

function Muted({ children }: { readonly children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>;
}

/** An instant, or "Not yet" for `null`. */
function When({ value, empty = S.notYet }: { readonly value: string | null; readonly empty?: string }) {
  return value === null ? <Muted>{empty}</Muted> : <DateTime value={value} />;
}

function Fields({ children }: { readonly children: ReactNode }) {
  return <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">{children}</dl>;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Panel({
  id,
  title,
  intro,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly intro?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="grid gap-1">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {intro === undefined ? null : <p className="text-sm text-muted-foreground">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/** The job's fields: OTA, kind, status, step, attempts, last error, times, lease and the BullMQ state. */
function SummaryPanel({ job }: { readonly job: JobDetail }) {
  return (
    <Panel id="job-summary" title={S.summaryTitle}>
      <Fields>
        <Field label={S.id}>
          <Mono>{job.id}</Mono>
        </Field>
        <Field label={S.ota}>
          <Link href={`/tenants/${encodeURIComponent(job.tenantId)}`} className={LINK_CLASS}>
            <span className="font-mono">{job.tenantKey}</span>
          </Link>
        </Field>
        <Field label={S.kind}>{labelOf(KINDS, job.kind)}</Field>
        <Field label={S.status}>
          <StatusBadge kind="job" status={job.status} />
        </Field>
        <Field label={S.step}>
          {job.step === null ? <Muted>{S.notYet}</Muted> : <Mono>{job.step}</Mono>}
        </Field>
        <Field label={S.attempts}>
          <span className="tabular-nums">{S.attemptsOf(job.attempt, job.maxAttempts)}</span>
        </Field>
        <Field label={S.error}>
          {job.error === null ? (
            <Muted>{S.none}</Muted>
          ) : (
            <span className="whitespace-pre-wrap" data-field="error">
              {job.error}
            </span>
          )}
        </Field>
        <Field label={S.scheduled}>
          <span className="grid gap-0.5">
            <DateTime value={job.scheduledAt} />
            <span className="text-xs text-muted-foreground">{S.scheduledHint}</span>
          </span>
        </Field>
        <Field label={S.started}>
          <When value={job.startedAt} />
        </Field>
        <Field label={S.finished}>
          <When value={job.finishedAt} />
        </Field>
        <Field label={S.lease}>
          {job.lockedUntil === null ? (
            <Muted>{S.noLease}</Muted>
          ) : (
            <span>
              {S.leaseUntil} <DateTime value={job.lockedUntil} />
            </span>
          )}
        </Field>
        <Field label={S.bullmqState}>
          {job.bullmqState === null ? (
            <Muted>{S.notDispatched}</Muted>
          ) : (
            <StatusBadge kind="bullmq" status={job.bullmqState} />
          )}
        </Field>
        {job.attempt < 1 ? null : (
          <Field label={S.bullmqJob}>
            {/* The BullMQ job of the current attempt: `<jobId>-<attempt>` on ota-tenant-ops (PADR-0001 item 3). */}
            <Mono>{`${job.id}-${job.attempt}`}</Mono> <Muted>{S.bullmqJobOn}</Muted>{" "}
            <Link href={`/queues/${TENANT_OPS_QUEUE}`} className={`${LINK_CLASS} font-mono text-xs`}>
              {TENANT_OPS_QUEUE}
            </Link>
          </Field>
        )}
      </Fields>
    </Panel>
  );
}

/** The step log: every finished step with its status, times and error. */
function StepsPanel({ steps }: { readonly steps: readonly Step[] }) {
  return (
    <Panel id="job-steps" title={S.stepsTitle} intro={S.stepsIntro}>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{S.stepsEmpty}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{S.stepsCaption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{S.stepName}</TableHead>
              <TableHead scope="col">{S.stepStatus}</TableHead>
              <TableHead scope="col">{S.stepStarted}</TableHead>
              <TableHead scope="col">{S.stepFinished}</TableHead>
              <TableHead scope="col">{S.stepError}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {steps.map((step, index) => (
              // A step can run again on a later attempt, so the name alone is no key.
              <TableRow key={`${index}:${step.step}`} className="align-top">
                <TableCell>
                  <Mono>{step.step}</Mono>
                </TableCell>
                <TableCell>
                  <StatusBadge kind="jobStep" status={step.status} />
                </TableCell>
                <TableCell>
                  <DateTime value={step.startedAt} />
                </TableCell>
                <TableCell>
                  <DateTime value={step.finishedAt} />
                </TableCell>
                <TableCell className="whitespace-normal">
                  {step.error === undefined ? (
                    <Muted>{S.none}</Muted>
                  ) : (
                    <span className="grid gap-0.5">
                      <Mono>{step.error.code}</Mono>
                      <span>{step.error.message}</span>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function BackLink() {
  return (
    <Link href="/provisioning-jobs" className="text-sm font-medium underline underline-offset-4">
      {S.backToList}
    </Link>
  );
}

/**
 * `/provisioning-jobs/[jobId]` (README §2, PF-83): one tenant job of `adminGetProvisioningJob` with its OTA, kind,
 * status, step, attempts, last error, times, lease (`lockedUntil`, only while running) and the BullMQ state of its
 * current attempt (`<jobId>-<attempt>` on `ota-tenant-ops`), its step log, its input and its result (`JsonView`; ids
 * and options only, never a ciphertext). The actions are offered only in the states the API allows them: **Retry**
 * on a failed job and **Cancel job** (reason) on a queued one (`JobActions`, which gets the id, kind and status only).
 * A value that is no job id, and an unknown job, render the not-found page.
 */
export default async function ProvisioningJobPage({
  params,
}: Readonly<{ params: Promise<{ jobId: string }> }>) {
  const { jobId } = await params;
  if (!JOB_ID.test(jobId)) {
    notFound();
  }
  const api = await platformApi();
  const result = await api.GET("/v1/admin/provisioning-jobs/{jobId}", { params: { path: { jobId } } });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect("/sign-in");
    }
    if (code === "NOT_FOUND" || code === "VALIDATION_FAILED") {
      notFound();
    }
    return (
      <div className="mx-auto grid max-w-6xl gap-6">
        <BackLink />
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(result.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  const job = result.data;
  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <BackLink />
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {S.title}: {labelOf(KINDS, job.kind)}
          </h1>
          <StatusBadge kind="job" status={job.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{job.id}</span> · <span className="font-mono">{job.tenantKey}</span>
        </p>
      </div>
      <section aria-labelledby="job-actions" className="grid gap-3">
        <h2 id="job-actions" className="text-lg font-semibold tracking-tight">
          {JOB_ACTION_STRINGS.sectionTitle}
        </h2>
        <JobActions jobId={job.id} kind={job.kind} status={job.status} />
      </section>
      <SummaryPanel job={job} />
      <StepsPanel steps={job.steps} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel id="job-payload" title={S.payloadTitle} intro={S.payloadIntro}>
          <JsonView value={job.payload} label={S.payloadLabel(job.id)} />
        </Panel>
        <Panel id="job-result" title={S.resultTitle} intro={S.resultIntro}>
          <JsonView value={job.result} label={S.resultLabel(job.id)} />
        </Panel>
      </div>
    </div>
  );
}
