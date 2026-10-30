"use client";

// The dialogs of the assets page (OAD-014; routes.md §9, README §9 and §10, OADR-0012 points 2 and 3): uploading an
// image and deleting one, both on `ConfirmDialog` (the environment badge, the idempotency key rendered with the page
// and the new one after a final refusal, the action's message and request id), without a reason (the contract's
// upload and delete take none). The page is a server component; this module never imports the SDK or the session
// code.
//
// - **Upload**: the kind (with what each is for), the file (`accept`: PNG, JPEG, WebP, ICO; never SVG), an optional
//   name, and the notice that the file is stored as it is, with its metadata. A file is checked when it is chosen and
//   again before the dialog posts it (asset-rules.ts `fileProblemOf`): an SVG or a file above 1 MB is refused in the
//   browser, without crossing the network (a body above the server action's 2 MB limit would fail before the action
//   could answer); the server action checks it again and the API checks the rest.
// - **Delete**: the image's name and what deleting does; an image in use is refused by the API with where it is used.
import { TriangleAlertIcon, UploadIcon } from "lucide-react";
import { useId, useState, type ChangeEvent } from "react";

import { RadioField, TextField } from "@/app/(console)/bookings/[bookingId]/patch-form";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { actionFailure, fieldError, type ActionState } from "@/lib/action-state";
import type { StaffEnvironment } from "@/lib/permissions";

import { deleteAsset, uploadAsset } from "./actions";
import {
  ACCEPTED_FILE_TYPES,
  ASSET_FIELDS,
  ASSET_INVALID_MESSAGES,
  ASSET_KINDS,
  MAX_FILE_NAME_LENGTH,
  UPLOAD_LABEL,
  fileProblemOf,
  type AssetKind,
} from "./asset-rules";

export const UPLOAD_STRINGS = Object.freeze({
  upload: UPLOAD_LABEL,
  uploadTitle: "Upload an image for the storefront",
  uploadSummary:
    "PNG, JPEG or WebP (an ICO file for a favicon), at most 1 MB; no SVG. Logos at most 2000 × 2000 pixels. Images are shared by the test and live environments.",
  confirmUpload: "Upload",
  kind: "What the image is for",
  file: "Image file",
  fileHint: "PNG, JPEG or WebP; ICO for a favicon. At most 1 MB. SVG files are not accepted.",
  fileName: "Name shown in the console",
  fileNameHint: "Optional; the file's own name by default.",
  metadata:
    "The image is stored exactly as uploaded: it is not re-encoded, so metadata in the file (camera, location, author) stays in it and anyone can read it from the image's public address. Remove it before uploading if it should not be public.",
  delete: "Delete",
  deleteLabel: (fileName: string) => `Delete ${fileName}`,
  deleteTitle: (fileName: string) => `Delete the image ${fileName}?`,
  deleteSummary:
    "The image and its file are deleted and its public address stops working; browsers may keep a copy for a while. An image the storefront settings or a content page use cannot be deleted: choose another one there first.",
  confirmDelete: "Delete image",
});

/**
 * The file input, checked as soon as a file is chosen; the dialog's state brings the action's refusal. A file chosen
 * after that refusal replaces it (its own check, or nothing), until the next submission brings a new state.
 */
function FileField({ state }: { readonly state: ActionState }) {
  const id = useId();
  const [chosen, setChosen] = useState<
    { readonly state: ActionState; readonly problem: string | undefined } | undefined
  >(undefined);
  const error =
    chosen !== undefined && chosen.state === state ? chosen.problem : fieldError(state, ASSET_FIELDS.file);

  function check(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0];
    const found =
      file === undefined ? undefined : fileProblemOf({ name: file.name, type: file.type, size: file.size });
    setChosen({ state, problem: found === undefined ? undefined : ASSET_INVALID_MESSAGES[found] });
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{UPLOAD_STRINGS.file}</Label>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {UPLOAD_STRINGS.fileHint}
      </p>
      <input
        id={id}
        type="file"
        name={ASSET_FIELDS.file}
        accept={ACCEPTED_FILE_TYPES}
        required
        onChange={check}
        className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1 file:text-sm file:font-medium"
        aria-describedby={error === undefined ? `${id}-hint` : `${id}-hint ${id}-error`}
        {...(error === undefined ? {} : { "aria-invalid": true })}
      />
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The fields of the upload dialog. */
function UploadFields({
  state,
  defaultKind,
}: {
  readonly state: ActionState;
  readonly defaultKind: AssetKind;
}) {
  const [kind, setKind] = useState<string>(defaultKind);
  return (
    <div className="grid gap-4">
      <RadioField
        name={ASSET_FIELDS.kind}
        label={UPLOAD_STRINGS.kind}
        state={state}
        choices={ASSET_KINDS}
        value={kind}
        onChange={setKind}
        details={Object.fromEntries(ASSET_KINDS.map((choice) => [choice.value, choice.detail]))}
      />
      <FileField state={state} />
      <TextField
        name={ASSET_FIELDS.fileName}
        label={UPLOAD_STRINGS.fileName}
        hint={UPLOAD_STRINGS.fileNameHint}
        state={state}
        maxLength={MAX_FILE_NAME_LENGTH}
      />
      <p
        role="note"
        className="flex gap-2 rounded-md border border-amber-500 bg-amber-100 px-3 py-2 text-sm text-amber-950"
      >
        <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {UPLOAD_STRINGS.metadata}
      </p>
    </div>
  );
}

/**
 * The upload's action as the dialog runs it: an SVG or a file above 1 MB is refused here, in the browser, with the
 * words of the API's `ASSET_INVALID` (no call, so the key stays); anything else goes to the server action.
 */
async function checkedUpload(previous: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get(ASSET_FIELDS.file);
  if (file instanceof File && file.size > 0) {
    const problem = fileProblemOf({
      name: file.name,
      type: file.type,
      size: file.size,
      head: await file.slice(0, 256).text(),
    });
    if (problem !== undefined) {
      const message = ASSET_INVALID_MESSAGES[problem];
      return actionFailure(message, { code: "ASSET_INVALID", fieldErrors: { [ASSET_FIELDS.file]: message } });
    }
  }
  return uploadAsset(previous, form);
}

export interface UploadAssetDialogProps {
  /** The environment of the request (images are shared by both; the dialog shows it as every dialog does). */
  readonly environment: StaffEnvironment;
  /** The idempotency key rendered with the page (`crypto.randomUUID()`, once per render). */
  readonly idempotencyKey: string;
  /** The kind chosen at first: the list's filter, else a logo. */
  readonly defaultKind: AssetKind;
}

/** "Upload an image" and its dialog. */
export function UploadAssetDialog({ environment, idempotencyKey, defaultKind }: UploadAssetDialogProps) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button">
          <UploadIcon aria-hidden="true" />
          {UPLOAD_STRINGS.upload}
        </Button>
      }
      title={UPLOAD_STRINGS.uploadTitle}
      summary={<p>{UPLOAD_STRINGS.uploadSummary}</p>}
      confirmLabel={UPLOAD_STRINGS.confirmUpload}
      environment={environment}
      action={checkedUpload}
      idempotencyKey={idempotencyKey}
      askReason={false}
      destructive={false}
    >
      {(state) => <UploadFields state={state} defaultKind={defaultKind} />}
    </ConfirmDialog>
  );
}

export interface DeleteAssetDialogProps {
  readonly assetId: string;
  readonly fileName: string;
  readonly environment: StaffEnvironment;
  /** The key `ConfirmDialog` renders with its form; the delete itself takes none. */
  readonly idempotencyKey: string;
}

/** "Delete" of an image and its confirmation (no reason: the contract's `DELETE` takes none). */
export function DeleteAssetDialog({
  assetId,
  fileName,
  environment,
  idempotencyKey,
}: DeleteAssetDialogProps) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline" size="sm" aria-label={UPLOAD_STRINGS.deleteLabel(fileName)}>
          {UPLOAD_STRINGS.delete}
        </Button>
      }
      title={UPLOAD_STRINGS.deleteTitle(fileName)}
      summary={<p>{UPLOAD_STRINGS.deleteSummary}</p>}
      confirmLabel={UPLOAD_STRINGS.confirmDelete}
      environment={environment}
      action={deleteAsset}
      idempotencyKey={idempotencyKey}
      askReason={false}
      fields={{ [ASSET_FIELDS.assetId]: assetId }}
    />
  );
}
