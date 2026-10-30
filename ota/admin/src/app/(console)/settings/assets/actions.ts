// The server actions of the storefront images (OAD-014; routes.md §9, api-changes part 2 §2.5, README §7 and §10,
// OADR-0018 points 4 and 5, OADR-0012 points 2 and 3): uploading and deleting the OTA's images through the SDK's
// console namespace with the client `requireStaff` hands back (the staff token of the request, the service key, the
// environment of the switch, the end-user headers). Images are shared by the test and live environments.
//
//   uploadAsset   console.settings.assets.upload   settings:write   multipart/form-data, the dialog's idempotency key
//   deleteAsset   console.settings.assets.delete   settings:write   no `If-Match` (an image never changes)
//
// Each starts with `requireStaff("settings:write")` (owners and admins; an agent's, a finance member's or a viewer's
// forged POST gets "You do not have permission to do this (settings:write)" before any call; the API decides and
// audits all the same).
//
// - **Upload.** The browser posts the file to this action (the server-action body limit is 2 MB, next.config.ts); the
//   action checks the dialog's key, the kind and the file, refuses an SVG (by its type, its name or its first bytes)
//   and a file above 1 MB before any call (asset-rules.ts `fileProblemOf`, which the dialog runs in the browser too),
//   and the SDK sends the kind, the optional name and the file as `multipart/form-data` with the key as
//   `Idempotency-Key`: a double submit or a retry after a timeout replays the same upload. The API reads the type from
//   the bytes; its `422 ASSET_INVALID` is answered in the admin's words for `details.reason` (`type`, `size`,
//   `dimensions`) on the file field, its `409 CONFLICT` `asset_exists` as "this file is already your <kind>", and the
//   key after a failure is lib/action-state.ts's (`withNextActionKey`: a final `4xx` the API stored under the key
//   brings a new one, everything else keeps it). The file is stored as it is, so its metadata stays (the dialog says
//   so).
// - **Delete** sends the asset id; `409 CONFLICT` `asset_in_use` says where the image is used (the storefront settings'
//   fields, the content pages) and what to do first, `404` that it is gone. It carries no idempotency key (the
//   contract has none), so its answers bring none.
//
// A success revalidates the assets page and the storefront settings, whose pickers list the images. The API's codes
// become the dialog's state, never `error.tsx`; only redirects and bugs are thrown.
"use server";

import type { StaffPermission, StorefrontAsset } from "@velexis/ota-sdk";
import { revalidatePath } from "next/cache";

import { ACTION_KEY_FIELD, actionFailure, withNextActionKey, type ActionState } from "@/lib/action-state";
import { fromVelexisError, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { requireStaff, type StaffContext } from "@/lib/session";

import {
  ASSETS_PATH,
  ASSET_FIELDS,
  ASSET_ID_PATTERN,
  ASSET_INVALID_MESSAGES,
  MAX_FILE_NAME_LENGTH,
  assetExistsMessage,
  assetKindLabel,
  fileProblemOf,
  inUseMessage,
  isAssetKind,
  type AssetInvalidReason,
} from "./asset-rules";

/** The permission of every write here (scope §1.3: owner and admin). */
const WRITE_PERMISSION: StaffPermission = "settings:write";

/** The storefront settings, whose image pickers list the images. */
const STOREFRONT_SETTINGS_PATH = "/settings/storefront";

/** An idempotency key as the page renders it (`crypto.randomUUID()`). */
const ACTION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many first bytes of a file the SVG check reads. */
const HEAD_BYTES = 256;

const STRINGS = Object.freeze({
  staleForm: "This form is out of date. Reload the page and try again.",
  chooseKind: "Choose what the image is for.",
  chooseFile: "Choose an image file.",
  fileName: `Use at most ${MAX_FILE_NAME_LENGTH} characters.`,
  uploaded: (fileName: string, kind: string) =>
    `Uploaded ${fileName} as ${kind.toLowerCase()}. Choose it in the storefront settings to use it.`,
  deleted: "Image deleted. Its public address no longer works; browsers may keep a copy for a while.",
  gone: "This image no longer exists. Reload the page to see the current images.",
  busy: "This upload is still being processed. Send the same form again in a moment.",
});

/** The state of an upload: lib/action-state.ts's, and the uploaded image after a success. */
export interface UploadActionState extends ActionState {
  readonly asset?: Pick<StorefrontAsset, "id" | "kind" | "fileName">;
}

/** The staff context of an action, or the state of its refusal (a missing permission, an ended or refused session). */
async function staffFor(
  permission: StaffPermission,
): Promise<{ readonly context: StaffContext } | { readonly state: ActionState }> {
  try {
    return { context: await requireStaff(permission) };
  } catch (error) {
    return { state: fromVelexisError(error) };
  }
}

/** The refusal of a file, by the API's reason, on the file field (`ASSET_INVALID`, as the API names it). */
function invalidFile(reason: AssetInvalidReason, requestId?: string | null): ActionState {
  const message = ASSET_INVALID_MESSAGES[reason];
  return actionFailure(message, {
    code: "ASSET_INVALID",
    requestId,
    fieldErrors: { [ASSET_FIELDS.file]: message },
  });
}

/** The state of a failed upload, in this page's words for the codes it knows. */
function uploadFailureOf(error: VelexisErrorLike): ActionState {
  const base = fromVelexisError(error);
  const reason = error.details?.["reason"];
  if (
    error.code === "ASSET_INVALID" &&
    typeof reason === "string" &&
    Object.hasOwn(ASSET_INVALID_MESSAGES, reason)
  ) {
    return invalidFile(reason as AssetInvalidReason, error.requestId);
  }
  if (error.code === "CONFLICT" && reason === "asset_exists") {
    const message = assetExistsMessage(error.details);
    return { ...base, message, fieldErrors: Object.freeze({ [ASSET_FIELDS.file]: message }) };
  }
  if (error.code === "CONFLICT" && reason === "idempotency_key_in_use") {
    return { ...base, message: STRINGS.busy };
  }
  return base;
}

/**
 * "Upload" of the assets page (`console.settings.assets.upload`, `settings:write`): the file, its kind and the
 * optional name shown in the console, as `multipart/form-data` under the dialog's idempotency key. An SVG or a file
 * above 1 MB is refused before any call; the API checks the rest from the bytes.
 */
export async function uploadAsset(_state: ActionState, form: FormData): Promise<UploadActionState> {
  const staff = await staffFor(WRITE_PERMISSION);
  if ("state" in staff) {
    return staff.state;
  }
  const key = form.get(ACTION_KEY_FIELD);
  if (typeof key !== "string" || !ACTION_KEY.test(key)) {
    return { ok: false, code: "VALIDATION_FAILED", message: STRINGS.staleForm };
  }
  const kind = form.get(ASSET_FIELDS.kind);
  const file = form.get(ASSET_FIELDS.file);
  const nameField = form.get(ASSET_FIELDS.fileName);
  const fileName = typeof nameField === "string" ? nameField.trim() : "";
  const fieldErrors: Record<string, string> = {};
  if (!isAssetKind(kind)) {
    fieldErrors[ASSET_FIELDS.kind] = STRINGS.chooseKind;
  }
  if (!(file instanceof File) || file.size === 0) {
    fieldErrors[ASSET_FIELDS.file] = STRINGS.chooseFile;
  }
  if ([...fileName].length > MAX_FILE_NAME_LENGTH) {
    fieldErrors[ASSET_FIELDS.fileName] = STRINGS.fileName;
  }
  if (Object.keys(fieldErrors).length > 0 || !isAssetKind(kind) || !(file instanceof File)) {
    return actionFailure("Check the highlighted fields and try again.", {
      code: "VALIDATION_FAILED",
      fieldErrors,
    });
  }
  const problem = fileProblemOf({
    name: file.name,
    type: file.type,
    size: file.size,
    head: await file.slice(0, HEAD_BYTES).text(),
  });
  if (problem !== undefined) {
    // Refused before the call: the key was not used, so the next submission sends it again.
    return invalidFile(problem);
  }

  let asset: StorefrontAsset;
  try {
    asset = await staff.context.console.settings.assets.upload(
      { file, kind, ...(fileName === "" ? {} : { fileName }) },
      { idempotencyKey: key },
    );
  } catch (error) {
    if (!isVelexisErrorLike(error)) {
      throw error;
    }
    return withNextActionKey(uploadFailureOf(error), error);
  }
  revalidatePath(ASSETS_PATH);
  revalidatePath(STOREFRONT_SETTINGS_PATH);
  return {
    ok: true,
    message: STRINGS.uploaded(asset.fileName, assetKindLabel(asset.kind)),
    asset: { id: asset.id, kind: asset.kind, fileName: asset.fileName },
  };
}

/**
 * "Delete image" of the assets page (`console.settings.assets.delete`, `settings:write`): the asset id. An image the
 * storefront settings or a content page use is refused with where it is used.
 */
export async function deleteAsset(_state: ActionState, form: FormData): Promise<ActionState> {
  const staff = await staffFor(WRITE_PERMISSION);
  if ("state" in staff) {
    return staff.state;
  }
  const assetId = form.get(ASSET_FIELDS.assetId);
  if (typeof assetId !== "string" || !ASSET_ID_PATTERN.test(assetId)) {
    return { ok: false, code: "VALIDATION_FAILED", message: STRINGS.staleForm };
  }
  try {
    await staff.context.console.settings.assets.delete({ assetId });
  } catch (error) {
    const base = fromVelexisError(error);
    const apiError = error as VelexisErrorLike;
    if (apiError.code === "CONFLICT" && apiError.details?.["reason"] === "asset_in_use") {
      return { ...base, message: inUseMessage(apiError.details) };
    }
    if (apiError.code === "NOT_FOUND") {
      revalidatePath(ASSETS_PATH);
      return { ...base, message: STRINGS.gone };
    }
    return base;
  }
  revalidatePath(ASSETS_PATH);
  revalidatePath(STOREFRONT_SETTINGS_PATH);
  return { ok: true, message: STRINGS.deleted };
}
