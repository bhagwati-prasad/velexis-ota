"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  saveTenantNotes,
  type NotesField,
  type NotesState,
  type NotesValues,
} from "@/app/(app)/tenants/[tenantId]/actions";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NOTES_STRINGS as N, TENANT_ACTION_STRINGS as A } from "@/lib/strings";

/**
 * "Edit notes and legal name" on the overview of `/tenants/[tenantId]` (README §2; `adminUpdateTenant`). The page
 * shows the notes and the legal name; this button opens a form with both, which `saveTenantNotes` sends with the
 * version the page was rendered with in `If-Match`. When someone else changed the OTA in the meantime the API answers
 * `412 PRECONDITION_FAILED`: the form keeps what was typed and asks to reload the page (a full reload, which loads the
 * current values and version) instead of overwriting the other change. The props are the values the page already
 * shows and the version.
 */

/** The `LegalName` and notes limits of `UpdateAdminTenantRequest` (the action checks them again). */
const LEGAL_NAME_MAX = 200;
const NOTES_MAX = 4000;

export interface NotesFormProps {
  readonly tenantId: string;
  /** The tenant version the page was rendered with (`AdminTenant.version`, the `ETag` of `adminGetTenant`). */
  readonly version: number;
  readonly notes: string | null;
  readonly legalName: string | null;
}

/** A version of the two values. */
interface Edition {
  readonly version: number;
  readonly values: NotesValues;
}

export function NotesForm({ tenantId, version, notes, legalName }: NotesFormProps) {
  const [editing, setEditing] = useState(false);
  // What this form saved last: newer than the props until the revalidated page arrives with the new version.
  const [saved, setSaved] = useState<Edition | undefined>(undefined);
  const [justSaved, setJustSaved] = useState(false);
  const current: Edition =
    saved !== undefined && saved.version > version
      ? saved
      : { version, values: { notes: notes ?? "", legalName: legalName ?? "" } };

  if (!editing) {
    return (
      <div className="grid gap-3">
        {justSaved ? (
          <p role="status" data-notice="saved" className="rounded-lg border px-4 py-3 text-sm font-medium">
            {N.saved}
          </p>
        ) : null}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setJustSaved(false);
              setEditing(true);
            }}
          >
            {N.edit}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <NotesEditor
      tenantId={tenantId}
      initial={current}
      onCancel={() => setEditing(false)}
      onSaved={(edition) => {
        setSaved(edition);
        setJustSaved(true);
        setEditing(false);
      }}
    />
  );
}

interface NotesEditorProps {
  readonly tenantId: string;
  readonly initial: Edition;
  readonly onCancel: () => void;
  readonly onSaved: (edition: Edition) => void;
}

function NotesEditor({ tenantId, initial, onCancel, onSaved }: NotesEditorProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction<NotesState, FormData>(
    saveTenantNotes,
    {
      status: "idle",
      version: initial.version,
      values: initial.values,
      fieldErrors: {},
    },
  );
  const [values, setValues] = useState<NotesValues>(state.values);
  const titleId = useId();
  const fieldIds = { legalName: useId(), notes: useId() } as const;

  // Each answer of the action sets the fields, in the render that shows it: what was sent after a failure.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setValues(state.values);
  }

  // A save closes the form, once per answer.
  const handled = useRef(state);
  useEffect(() => {
    if (handled.current === state) {
      return;
    }
    handled.current = state;
    if (state.status === "saved") {
      onSaved({ version: state.version, values: state.values });
    }
  }, [state, onSaved]);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isPending) {
      // A second save while one is on its way would carry the same version and be refused as stale.
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  function setValue(field: NotesField, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  function described(field: NotesField): { "aria-describedby": string; "aria-invalid"?: true } {
    const id = fieldIds[field];
    return state.fieldErrors[field] === undefined
      ? { "aria-describedby": `${id}-hint` }
      : { "aria-describedby": `${id}-hint ${id}-error`, "aria-invalid": true };
  }

  return (
    <>
      <form
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
        className="grid gap-4 rounded-lg border p-4"
      >
        <h3 id={titleId} className="text-base font-semibold">
          {N.formTitle}
        </h3>
        <input type="hidden" name="tenantId" value={tenantId} />
        <input type="hidden" name="version" value={String(state.version)} />
        {state.status === "failed" && state.message !== undefined ? (
          <Alert variant="destructive" data-notice="failed" data-code={state.code}>
            <AlertDescription>
              <p>{state.message}</p>
              {state.code === "PRECONDITION_FAILED" ? (
                // A full reload, so the page shows the OTA as it is now, with its new version.
                <a
                  href={`/tenants/${encodeURIComponent(tenantId)}`}
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  {A.reload}
                </a>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-2">
          <Label htmlFor={fieldIds.legalName}>{N.legalNameLabel}</Label>
          <p id={`${fieldIds.legalName}-hint`} className="text-sm text-muted-foreground">
            {N.legalNameHint}
          </p>
          <Input
            id={fieldIds.legalName}
            name="legalName"
            value={values.legalName}
            maxLength={LEGAL_NAME_MAX}
            autoComplete="organization"
            autoFocus
            {...described("legalName")}
            onChange={(event) => setValue("legalName", event.currentTarget.value)}
          />
          {state.fieldErrors.legalName === undefined ? null : (
            <p id={`${fieldIds.legalName}-error`} className="text-sm font-medium text-destructive">
              {state.fieldErrors.legalName}
            </p>
          )}
        </div>
        <div className="grid gap-2">
          <Label htmlFor={fieldIds.notes}>{N.notesLabel}</Label>
          <p id={`${fieldIds.notes}-hint`} className="text-sm text-muted-foreground">
            {N.notesHint}
          </p>
          <Textarea
            id={fieldIds.notes}
            name="notes"
            value={values.notes}
            rows={6}
            maxLength={NOTES_MAX}
            {...described("notes")}
            onChange={(event) => setValue("notes", event.currentTarget.value)}
          />
          {state.fieldErrors.notes === undefined ? null : (
            <p id={`${fieldIds.notes}-error`} className="text-sm font-medium text-destructive">
              {state.fieldErrors.notes}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={isPending}>
            {isPending ? N.saving : N.save}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            {N.cancel}
          </Button>
        </div>
      </form>
      {stepUpDialog}
    </>
  );
}
