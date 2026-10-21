"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import {
  assignOfficeToTenant,
  retireOffice,
  saveOfficeNotes,
  type AssignOfficeState,
  type OfficeNotesState,
  type RetireOfficeState,
} from "@/app/(app)/amadeus/offices/actions";
import { DataTable, listHref, type ListPage } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { isStepUpRequired, useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AMADEUS_OFFICE_STRINGS as L,
  OFFICE_ACTION_STRINGS as S,
  SUPPLIER_ENVIRONMENT_LABELS,
} from "@/lib/strings";

/**
 * The office pool table of `/amadeus/offices` (README §2; PADR-0012; PF-90) and the actions on each office: **Assign**
 * an available office to an OTA (by its key or tenant id), **Retire** an available office (`ReasonDialog`) and **Edit
 * notes** of any office (`If-Match`). Releasing an office comes with PAD-014. The outcome of the last action stays above
 * the table while the revalidated page shows the pool as it is now; the assign and notes dialogs show their refusals
 * themselves. The rows hold only the fields the table shows.
 */

type Schemas = components["schemas"];

/** One office as the table shows it: the fields of `AdminAmadeusOffice` it needs, and nothing else. */
export interface OfficeRow {
  readonly id: string;
  readonly officeId: string;
  readonly environment: Schemas["Environment"];
  readonly status: Schemas["AmadeusOfficeStatus"];
  readonly assignedTenant: { readonly id: string; readonly key: string } | null;
  readonly assignedAt: string | null;
  readonly releaseRequestedAt: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  /** The office version the page was rendered with (`If-Match` of the notes). */
  readonly version: number;
}

const IDLE_ASSIGN: AssignOfficeState = { status: "idle" };
const IDLE_RETIRE: RetireOfficeState = { status: "idle" };
const IDLE_NOTES: OfficeNotesState = { status: "idle" };

/** `maxLength` of the notes (`UpdateAmadeusOfficeRequest.notes`; the action checks it again, in code points). */
const NOTES_MAX = 2000;
/**
 * The longest OTA field: a tenant id (`ten_` and 26 characters) and a key both have at most 30 characters; the rest is
 * room for white space around a pasted value, which the action trims.
 */
const TENANT_FIELD_MAX = 64;

const LINK_CLASS = "font-medium underline-offset-4 hover:underline focus-visible:underline";

const ENVIRONMENT_LABELS: Readonly<Record<string, string>> = SUPPLIER_ENVIRONMENT_LABELS;

/**
 * The action has just succeeded. A step-up request is the previous state with `stepUp: true` (README §4), so after an
 * earlier success it still reads `done`; it is no answer yet.
 */
function isDone(state: AssignOfficeState | RetireOfficeState | OfficeNotesState): boolean {
  return state.status === "done" && !isStepUpRequired(state);
}

function Muted({ children }: { readonly children: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** A dialog that is open, for the office it was opened on. */
interface OpenDialog {
  readonly kind: "assign" | "notes";
  readonly office: OfficeRow;
  /** The state of its action when it opened: an older answer is not this dialog's to show. */
  readonly openedWith: AssignOfficeState | OfficeNotesState;
}

type ActionId = "assign" | "retire" | "notes";

export interface OfficeTableProps {
  /** The offices of the page, oldest first. */
  readonly offices: readonly OfficeRow[];
  /** The `page` of the answer: "Next page" while there is one, keeping the filters of the URL. */
  readonly page: ListPage;
}

export function OfficeTable({ offices, page }: OfficeTableProps) {
  const assign = useStepUpAction(assignOfficeToTenant, IDLE_ASSIGN);
  const retire = useStepUpAction(retireOffice, IDLE_RETIRE);
  const notes = useStepUpAction(saveOfficeNotes, IDLE_NOTES);
  const [dialog, setDialog] = useState<OpenDialog | undefined>(undefined);
  // The outcome shown is the one of the action that ran last.
  const [latest, setLatest] = useState<ActionId | undefined>(undefined);
  const pending = assign.isPending || retire.isPending || notes.isPending;

  // A success closes its dialog, once per answer (a step-up request, the previous state, is no answer yet).
  const [answered, setAnswered] = useState({ assign: assign.state, notes: notes.state });
  if (answered.assign !== assign.state || answered.notes !== notes.state) {
    if (
      (answered.assign !== assign.state && isDone(assign.state)) ||
      (answered.notes !== notes.state && isDone(notes.state))
    ) {
      setDialog(undefined);
    }
    setAnswered({ assign: assign.state, notes: notes.state });
  }

  function open(kind: "assign" | "notes", office: OfficeRow): void {
    setLatest(kind);
    setDialog({ kind, office, openedWith: kind === "assign" ? assign.state : notes.state });
  }

  const columns: ColumnDef<OfficeRow>[] = [
    {
      id: "office",
      header: L.columnOffice,
      cell: ({ row }) => <span className="font-mono">{row.original.officeId}</span>,
    },
    {
      id: "environment",
      header: L.columnEnvironment,
      cell: ({ row }) => ENVIRONMENT_LABELS[row.original.environment] ?? row.original.environment,
    },
    {
      id: "status",
      header: L.columnStatus,
      cell: ({ row }) => (
        <span className="grid gap-1">
          <StatusBadge kind="amadeusOffice" status={row.original.status} />
          {row.original.releaseRequestedAt === null ? null : (
            <span className="text-xs text-muted-foreground">
              {L.releasingSince} <DateTime value={row.original.releaseRequestedAt} mode="date" />
            </span>
          )}
        </span>
      ),
    },
    {
      id: "ota",
      header: L.columnOta,
      cell: ({ row }) =>
        row.original.assignedTenant === null ? (
          <Muted>{L.noOta}</Muted>
        ) : (
          <Link
            href={`/tenants/${encodeURIComponent(row.original.assignedTenant.id)}`}
            className={`${LINK_CLASS} font-mono`}
          >
            {row.original.assignedTenant.key}
          </Link>
        ),
    },
    {
      id: "assigned",
      header: L.columnAssigned,
      cell: ({ row }) =>
        row.original.assignedAt === null ? (
          <Muted>{L.noOta}</Muted>
        ) : (
          <DateTime value={row.original.assignedAt} />
        ),
    },
    {
      id: "notes",
      header: L.columnNotes,
      cell: ({ row }) =>
        row.original.notes === null ? (
          <Muted>{L.noNotes}</Muted>
        ) : (
          <span className="block max-w-xs break-words whitespace-pre-wrap">{row.original.notes}</span>
        ),
    },
    {
      id: "added",
      header: L.columnAdded,
      cell: ({ row }) => <DateTime value={row.original.createdAt} />,
    },
    {
      id: "actions",
      header: L.columnActions,
      cell: ({ row }) => {
        const office = row.original;
        return (
          <span className="flex flex-wrap gap-2">
            {office.status === "available" ? (
              <>
                <Button size="sm" disabled={pending} onClick={() => open("assign", office)}>
                  {S.assign}
                  <span className="sr-only">{S.officeSuffix(office.officeId)}</span>
                </Button>
                <ReasonDialog
                  trigger={
                    <Button variant="outline" size="sm" disabled={pending}>
                      {S.retire}
                      <span className="sr-only">{S.officeSuffix(office.officeId)}</span>
                    </Button>
                  }
                  title={S.retireTitle(office.officeId)}
                  description={S.retireDescription}
                  confirmLabel={S.retireConfirm}
                  onConfirm={(formData) => {
                    setLatest("retire");
                    retire.dispatch(formData);
                  }}
                >
                  <input type="hidden" name="officeRowId" value={office.id} />
                </ReasonDialog>
              </>
            ) : null}
            <Button variant="outline" size="sm" disabled={pending} onClick={() => open("notes", office)}>
              {S.editNotes}
              <span className="sr-only">{S.notesSuffix(office.officeId)}</span>
            </Button>
          </span>
        );
      },
    },
  ];

  const outcome =
    latest === undefined || dialog !== undefined
      ? undefined
      : { assign: assign.state, retire: retire.state, notes: notes.state }[latest];
  return (
    <div className="grid gap-4">
      {outcome === undefined || latest === undefined ? null : <Outcome action={latest} state={outcome} />}
      {pending ? <p className="text-sm text-muted-foreground">{S.working}</p> : null}
      <DataTable
        columns={columns}
        data={offices}
        caption={L.caption}
        emptyMessage={L.empty}
        getRowId={(row) => row.id}
        page={page}
      />
      <Dialog
        open={dialog !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setDialog(undefined);
          }
        }}
      >
        {dialog === undefined ? null : (
          // A text being typed is not thrown away by a click outside; Escape and "Cancel" still close the dialog.
          <DialogContent onInteractOutside={(event) => event.preventDefault()}>
            {dialog.kind === "assign" ? (
              <AssignForm
                office={dialog.office}
                state={assign.state === dialog.openedWith ? IDLE_ASSIGN : assign.state}
                isPending={assign.isPending}
                dispatch={assign.dispatch}
                onCancel={() => setDialog(undefined)}
              />
            ) : (
              <NotesForm
                office={dialog.office}
                state={notes.state === dialog.openedWith ? IDLE_NOTES : notes.state}
                isPending={notes.isPending}
                dispatch={notes.dispatch}
                onCancel={() => setDialog(undefined)}
              />
            )}
          </DialogContent>
        )}
      </Dialog>
      {assign.stepUpDialog}
      {retire.stepUpDialog}
      {notes.stepUpDialog}
    </div>
  );
}

/** The outcome of the last action, once its dialog is closed: done in words, or a refusal. */
function Outcome({
  action,
  state,
}: {
  readonly action: ActionId;
  readonly state: AssignOfficeState | RetireOfficeState | OfficeNotesState;
}) {
  if (state.status === "idle" || isStepUpRequired(state)) {
    return null;
  }
  if (state.status === "failed") {
    return (
      <Alert variant="destructive" data-notice="failed" data-code={state.code}>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  if ("connectionStatus" in state) {
    return (
      <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
        <p className="font-medium">{S.assigned(state.officeId, state.tenantKey)}</p>
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">{S.connectionNow}</span>
          <StatusBadge kind="amadeusConnection" status={state.connectionStatus} />
        </p>
        <p>
          <Link
            href={`/tenants/${encodeURIComponent(state.tenantId)}`}
            className="font-medium underline underline-offset-4"
          >
            {S.openTenant} <span className="font-mono">{state.tenantKey}</span>
          </Link>
        </p>
      </div>
    );
  }
  return (
    <p role="status" data-notice="done" className="rounded-lg border px-4 py-3 text-sm font-medium">
      {action === "retire" ? S.retired(state.officeId) : S.notesSaved(state.officeId)}
    </p>
  );
}

interface DialogFormProps<State> {
  readonly office: OfficeRow;
  /** The action's state, or idle when its last answer is older than this dialog. */
  readonly state: State;
  readonly isPending: boolean;
  readonly dispatch: (formData: FormData) => void;
  readonly onCancel: () => void;
}

/** The assign dialog: the OTA by its key or tenant id. */
function AssignForm({ office, state, isPending, dispatch, onCancel }: DialogFormProps<AssignOfficeState>) {
  const id = useId();
  const [tenant, setTenant] = useState("");
  const failure = state.status === "failed" ? state : undefined;
  const fieldError = failure?.fieldError;
  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!isPending) {
      dispatch(new FormData(event.currentTarget));
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>{S.assignTitle(office.officeId)}</DialogTitle>
        <DialogDescription>{S.assignIntro}</DialogDescription>
      </DialogHeader>
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        {failure !== undefined && fieldError === undefined ? (
          <Alert variant="destructive" data-notice="failed" data-code={failure.code}>
            <AlertDescription>{failure.message}</AlertDescription>
          </Alert>
        ) : null}
        <input type="hidden" name="officeRowId" value={office.id} />
        <div className="grid gap-2">
          <Label htmlFor={id}>{S.tenantLabel}</Label>
          <p id={`${id}-hint`} className="text-sm text-muted-foreground">
            {S.tenantHint}
          </p>
          <Input
            id={id}
            name="tenant"
            value={tenant}
            maxLength={TENANT_FIELD_MAX}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            autoFocus
            aria-describedby={fieldError === undefined ? `${id}-hint` : `${id}-hint ${id}-error`}
            {...(fieldError === undefined ? {} : { "aria-invalid": true })}
            onChange={(event) => setTenant(event.currentTarget.value)}
          />
          {fieldError === undefined ? null : (
            <p id={`${id}-error`} className="text-sm font-medium text-destructive">
              {fieldError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {S.cancel}
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? S.assigning : S.assignConfirm}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/** The notes dialog: the notes as the page shows them, saved with the office's version in `If-Match`. */
function NotesForm({ office, state, isPending, dispatch, onCancel }: DialogFormProps<OfficeNotesState>) {
  const id = useId();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams() ?? new URLSearchParams();
  const [notes, setNotes] = useState(office.notes ?? "");
  const failure = state.status === "failed" ? state : undefined;
  const fieldError = failure?.fieldError;
  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!isPending) {
      // A second save while one is on its way would carry the same version and be refused as stale.
      dispatch(new FormData(event.currentTarget));
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>{S.notesTitle(office.officeId)}</DialogTitle>
        <DialogDescription>{S.notesHint}</DialogDescription>
      </DialogHeader>
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        {failure !== undefined && fieldError === undefined ? (
          <Alert variant="destructive" data-notice="failed" data-code={failure.code}>
            <AlertDescription>
              <p>{failure.message}</p>
              {failure.code === "PRECONDITION_FAILED" ? (
                // A full reload of this list, so it shows the office as it is now, with its new version.
                <a
                  href={listHref(pathname, searchParams, {})}
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  {S.reload}
                </a>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <input type="hidden" name="officeRowId" value={office.id} />
        <input type="hidden" name="version" value={String(office.version)} />
        <div className="grid gap-2">
          <Label htmlFor={id}>{S.notesLabel}</Label>
          <Textarea
            id={id}
            name="notes"
            value={notes}
            rows={6}
            maxLength={NOTES_MAX}
            autoFocus
            {...(fieldError === undefined
              ? {}
              : { "aria-describedby": `${id}-error`, "aria-invalid": true as const })}
            onChange={(event) => setNotes(event.currentTarget.value)}
          />
          {fieldError === undefined ? null : (
            <p id={`${id}-error`} className="text-sm font-medium text-destructive">
              {fieldError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {S.cancel}
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? S.saving : S.saveNotes}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
