"use client";

import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { useId, useState } from "react";

import {
  migrateTenant,
  resumeTenant,
  suspendTenant,
  type JobOutcome,
  type LifecycleState,
  type MigrateState,
} from "@/app/(app)/tenants/[tenantId]/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  JOB_KIND_LABELS,
  LIFECYCLE_STRINGS as S,
  MIGRATE_STRINGS as M,
  SUSPENSION_REASON_LABELS,
  TENANT_ACTION_STRINGS as A,
} from "@/lib/strings";

/**
 * The lifecycle forms of `/tenants/[tenantId]` (README §2 tenant key actions; PADR-0014, PF-82): suspend an active
 * OTA and resume a suspended one, each with the mandatory reason of `ReasonDialog`, and re-run the tenant migrations
 * of an OTA that has a schema. After an action the form shows the OTA's new status and the job that carries the OTA
 * worker's part, with a link to the job's page; the page itself is revalidated, so its header, its jobs tab and these
 * buttons follow the new status. The props are the few fields the forms need: Next.js sends them to the browser.
 */

type Schemas = components["schemas"];

const IDLE: LifecycleState = { status: "idle" };
const IDLE_MIGRATE: MigrateState = { status: "idle" };

/** The suspension reasons an admin may choose (`SuspendTenantRequest`); `billing` belongs to billing sync. */
const ADMIN_SUSPENSION_REASONS = ["abuse", "request", "admin"] as const;
/** The preselected kind: the general "Velexis decision", which the admin changes for abuse or a request. */
const DEFAULT_SUSPENSION_REASON: (typeof ADMIN_SUSPENSION_REASONS)[number] = "admin";

/** The longest target version the field takes (`migrateTenant` checks the same bound and the pattern). */
const TARGET_VERSION_MAX_LENGTH = 128;

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** The job an action created: its id (linking to its page), kind, status and step. */
export function JobOutcomeLine({ job }: { readonly job: JobOutcome }) {
  return (
    <p className="flex flex-wrap items-center gap-2" data-job={job.id}>
      <span className="text-muted-foreground">{A.job}</span>
      <Link
        href={`/provisioning-jobs/${encodeURIComponent(job.id)}`}
        className="font-mono text-xs break-all underline underline-offset-4"
      >
        {job.id}
      </Link>
      <span>{Object.hasOwn(JOB_KIND_LABELS, job.kind) ? JOB_KIND_LABELS[job.kind] : job.kind}</span>
      <StatusBadge kind="job" status={job.status} />
      {job.step === null ? null : <span className="font-mono text-xs">{A.stepOf(job.step)}</span>}
    </p>
  );
}

/** A refused action: the admin's message, with the code for tests. */
export function ActionFailureNotice({ code, message }: { readonly code: string; readonly message: string }) {
  return (
    <Alert variant="destructive" data-notice="failed" data-code={code}>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function LifecycleOutcome({ state }: { readonly state: LifecycleState | undefined }) {
  if (state === undefined || state.status === "idle") {
    return null;
  }
  if (state.status === "failed") {
    return <ActionFailureNotice code={state.code} message={state.message} />;
  }
  return (
    <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
      <p className="font-medium">{state.action === "suspend" ? S.suspended : S.resumed}</p>
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{S.newStatus}</span>
        <StatusBadge kind="tenant" status={state.tenantStatus} />
      </p>
      <JobOutcomeLine job={state.job} />
    </div>
  );
}

/** The kind of suspension, inside the reason dialog's form (`suspensionReason` of `SuspendTenantRequest`). */
function SuspensionReasonField() {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{S.suspensionReasonLabel}</Label>
      <p id={hintId} className="text-sm text-muted-foreground">
        {S.suspensionReasonHint}
      </p>
      <select
        id={id}
        name="suspensionReason"
        defaultValue={DEFAULT_SUSPENSION_REASON}
        aria-describedby={hintId}
        className={SELECT_CLASS}
      >
        {ADMIN_SUSPENSION_REASONS.map((reason) => (
          <option key={reason} value={reason}>
            {SUSPENSION_REASON_LABELS[reason]}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface SuspendResumeFormProps {
  readonly tenantId: string;
  /** The OTA's name, for the dialogs' questions. */
  readonly tenantName: string;
  readonly status: Schemas["TenantStatus"];
  /** Why a suspended OTA is suspended: a `billing` suspension resumes only with a valid subscription. */
  readonly suspensionReason: Schemas["SuspensionReason"];
}

/**
 * "Suspend" on an active OTA and "Resume" on a suspended one, each behind `ReasonDialog` (5–500 characters, stored in
 * the audit log); suspending also asks for the kind (`abuse`, `request`, `admin`). The buttons follow the status the
 * page was rendered with; the outcome of the last action stays below them.
 */
export function SuspendResumeForm({
  tenantId,
  tenantName,
  status,
  suspensionReason,
}: SuspendResumeFormProps) {
  const suspend = useStepUpAction(suspendTenant, IDLE);
  const resume = useStepUpAction(resumeTenant, IDLE);
  // The outcome shown is the one of the action that ran last.
  const [latest, setLatest] = useState<"suspend" | "resume" | undefined>(undefined);
  const pending = suspend.isPending || resume.isPending;
  const outcome = latest === "suspend" ? suspend.state : latest === "resume" ? resume.state : undefined;

  // The two dialogs have their own keys: without them React keeps the one <button> when the status changes and only
  // swaps its classes, and the Button's `transition-all` then fades the outline "Resume" into the destructive "Suspend"
  // for 150 ms, with colours in between that do not keep 4.5:1 (axe found one in e2e run 41015776555).
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {status === "active" ? (
          <ReasonDialog
            key="suspend"
            trigger={
              <Button variant="destructive" disabled={pending}>
                {S.suspend}
              </Button>
            }
            title={S.suspendTitle(tenantName)}
            description={S.suspendDescription}
            confirmLabel={S.suspendConfirm}
            onConfirm={(formData) => {
              setLatest("suspend");
              suspend.dispatch(formData);
            }}
          >
            <input type="hidden" name="tenantId" value={tenantId} />
            <SuspensionReasonField />
          </ReasonDialog>
        ) : status === "suspended" ? (
          <ReasonDialog
            key="resume"
            trigger={
              <Button variant="outline" disabled={pending}>
                {S.resume}
              </Button>
            }
            title={S.resumeTitle(tenantName)}
            description={
              suspensionReason === "billing"
                ? `${S.resumeDescription} ${S.resumeBillingDescription}`
                : S.resumeDescription
            }
            confirmLabel={S.resumeConfirm}
            destructive={false}
            onConfirm={(formData) => {
              setLatest("resume");
              resume.dispatch(formData);
            }}
          >
            <input type="hidden" name="tenantId" value={tenantId} />
          </ReasonDialog>
        ) : (
          <p className="text-sm text-muted-foreground">{S.notApplicable}</p>
        )}
        {pending ? <span className="text-sm text-muted-foreground">{A.working}</span> : null}
      </div>
      <LifecycleOutcome state={outcome} />
      {suspend.stepUpDialog}
      {resume.stepUpDialog}
    </div>
  );
}

export interface MigrateFormProps {
  readonly tenantId: string;
  readonly tenantName: string;
  /** The OTA's schema version; `null` before its schema exists, when there is nothing to migrate. */
  readonly schemaVersion: string | null;
}

/**
 * "Migrate": a `migrate` job for one OTA (`adminMigrateTenant`), for example after a failed deploy fan-out, with an
 * optional target version; `ConfirmDialog` asks first. The job's answer arrives later on the job's page.
 */
export function MigrateForm({ tenantId, tenantName, schemaVersion }: MigrateFormProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(migrateTenant, IDLE_MIGRATE);
  const [targetVersion, setTargetVersion] = useState("");
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  if (schemaVersion === null) {
    return <p className="text-sm text-muted-foreground">{M.noSchema}</p>;
  }
  const fieldError = state.status === "failed" ? state.fieldError : undefined;
  const target = targetVersion.trim();
  return (
    <div className="grid gap-3">
      <p className="text-sm">{M.intro(schemaVersion)}</p>
      <div className="grid max-w-md gap-2">
        <Label htmlFor={id}>{M.targetVersionLabel}</Label>
        <p id={hintId} className="text-sm text-muted-foreground">
          {M.targetVersionHint}
        </p>
        <Input
          id={id}
          name="targetVersion"
          value={targetVersion}
          maxLength={TARGET_VERSION_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={fieldError === undefined ? hintId : `${hintId} ${errorId}`}
          {...(fieldError === undefined ? {} : { "aria-invalid": true })}
          onChange={(event) => setTargetVersion(event.currentTarget.value)}
        />
        {fieldError === undefined ? null : (
          <p id={errorId} className="text-sm font-medium text-destructive">
            {fieldError}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ConfirmDialog
          trigger={
            <Button variant="outline" disabled={isPending}>
              {M.migrate}
            </Button>
          }
          title={M.migrateTitle(tenantName)}
          description={target === "" ? M.migrateAll : M.migrateTo(target)}
          confirmLabel={M.migrateConfirm}
          destructive={false}
          onConfirm={() => {
            const formData = new FormData();
            formData.set("tenantId", tenantId);
            formData.set("targetVersion", target);
            dispatch(formData);
          }}
        />
        {isPending ? <span className="text-sm text-muted-foreground">{A.working}</span> : null}
      </div>
      {/* A problem with the target version shows at its field only. */}
      {state.status === "failed" && fieldError === undefined ? (
        <ActionFailureNotice code={state.code} message={state.message} />
      ) : null}
      {state.status === "done" ? (
        <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">{M.started}</p>
          <JobOutcomeLine job={state.job} />
        </div>
      ) : null}
      {stepUpDialog}
    </div>
  );
}
