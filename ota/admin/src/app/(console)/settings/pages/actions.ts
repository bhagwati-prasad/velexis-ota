// The server actions of the content pages (OAD-015; routes.md §9, api-changes part 2 §2.4, README §7, OADR-0018 points 4
// and 5, OADR-0012 points 5 to 7): creating, changing and deleting the OTA's storefront pages through the SDK's console
// namespace with the client `requireStaff` hands back (the staff token of the request, the service key, the environment
// of the switch, the end-user headers). Pages are shared by the test and live environments, so the environment changes
// nothing here.
//
//   createPage   console.settings.pages.create   settings:write   the form's idempotency key
//   updatePage   console.settings.pages.update   settings:write   `ifMatch` = the displayed version
//   deletePage   console.settings.pages.delete   settings:write   `ifMatch` = the displayed version
//
// Each starts with `requireStaff("settings:write")` (owners and admins; an agent's, a finance member's or a viewer's
// forged POST gets "You do not have permission to do this (settings:write)" before any call; the API decides and
// audits all the same), then checks the form's hidden fields (one that does not parse: "This form is out of date") and
// its values with the Zod mirror of StorefrontPageInput (content-rules.ts: the address, the language, the kind, the
// title trimmed on one line, the body with its line breaks as `\n` and at most 50 000 characters, the footer order),
// naming every problem at once, then makes one SDK call.
//
// - **Create** sends every field under the idempotency key the page rendered with the form (a double submit creates one
//   page; the key after a failure is lib/action-state.ts's `withNextActionKey`: a final `4xx` the API stored under the
//   key brings a new one, everything else keeps it), then opens the new page's own form.
// - **Update** sends the writable fields (StorefrontPageUpdate: kind, title, body, published, footer, order; the
//   address and the language are fixed) with `ifMatch` = the version the page displayed, and revalidates the list and
//   the page, whose new render brings the new version.
// - **Delete** sends `ifMatch` = the displayed version and, after a success, goes to the list.
//
// An update and a delete carry no idempotency key (the contract has none: `If-Match` makes a replay a `412`), so their
// answers bring no new one. The API's codes become the form's state, never `error.tsx`: a refused body
// (`422 UNPROCESSABLE` `markdown_not_allowed`, `asset_not_found`, `asset_kind`) on the body with its `details.line`
// (`bodyLine`, which the form shows next to that line), `locale_not_supported` on the language, `409 CONFLICT`
// `page_exists` on the address and `page_linked` in the dialog, the API's field errors on their fields, `412` and `404`
// in this page's words; only redirects and bugs are thrown.
//
// The API deletes its page caches of both environments on every change (`t:<tenantId>:<env>:pages:<locale>`,
// OADR-0012 point 7 as confirmed on 2026-10-30), so the next storefront.getPage reads the change; the storefront's own
// copy lasts 5 minutes, which the messages say.
"use server";

import type { StaffPermission, StorefrontPage } from "@velexis/ota-sdk";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ACTION_KEY_FIELD, fromZod, withNextActionKey, type ActionState } from "@/lib/action-state";
import { fromVelexisError, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { requireStaff, type StaffContext } from "@/lib/session";

import {
  ACTION_KEY_PATTERN,
  HIDDEN_PAGE_FIELDS,
  PAGE_FIELDS,
  PAGE_ID_PATTERN,
  PAGE_REFUSALS,
  PAGES_PATH,
  SETTINGS_WRITE,
  VERSION_PATTERN,
  bodyRefusalMessage,
  isBodyReason,
  newPageSchema,
  pageChangesSchema,
  pageFormInput,
  pagePath,
  type PageActionState,
} from "../content-rules";

/** The permission of every write here (scope §1.3: owner and admin). */
const WRITE_PERMISSION: StaffPermission = SETTINGS_WRITE;

const STRINGS = Object.freeze({
  savedPublished: "Saved. The storefront shows the change within 5 minutes.",
  savedDraft:
    "Saved as a draft: the storefront does not show this page (a page that was published disappears within 5 minutes).",
});

/** A text field of the form that matches `pattern`, or `undefined`. */
function hiddenOf(form: FormData, name: string, pattern: RegExp): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/** The state of a form whose hidden fields are not the page's. */
function staleForm(): ActionState {
  return { ok: false, code: "VALIDATION_FAILED", message: PAGE_REFUSALS.staleForm };
}

/** The staff context of an action, or the state of its refusal (a missing permission, an ended or refused session). */
async function staffFor(): Promise<{ readonly context: StaffContext } | { readonly state: ActionState }> {
  try {
    return { context: await requireStaff(WRITE_PERMISSION) };
  } catch (error) {
    return { state: fromVelexisError(error) };
  }
}

/** A positive whole number, or `undefined`. */
function lineOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

type Operation = "create" | "update" | "delete";

/**
 * The state of a failed call: lib/errors.ts's message, request id and field errors (the body's JSON pointers are the
 * form's field names: `/title` → `title`), and this page's words for the codes it knows. A field error of a hidden
 * field (`If-Match`, the page id) means the form is out of date. Redirects and bugs are thrown again
 * (`fromVelexisError`).
 */
function failureOf(operation: Operation, error: unknown): PageActionState {
  const base = fromVelexisError(error);
  const apiError = error as VelexisErrorLike;
  const fieldErrors: Record<string, string> = { ...base.fieldErrors };
  let state: PageActionState = base;
  if (Object.keys(fieldErrors).some((name) => HIDDEN_PAGE_FIELDS.has(name))) {
    state = { ...state, message: PAGE_REFUSALS.staleForm };
  }
  const details = apiError.details;
  const reason = details?.["reason"];
  if (apiError.code === "UNPROCESSABLE" && isBodyReason(reason)) {
    const line = lineOf(details?.["line"]);
    const message = bodyRefusalMessage(reason, line);
    return {
      ...state,
      message,
      fieldErrors: Object.freeze({ ...fieldErrors, [PAGE_FIELDS.bodyMarkdown]: message }),
      ...(line === undefined ? {} : { bodyLine: line }),
    };
  }
  if (apiError.code === "UNPROCESSABLE" && reason === "locale_not_supported") {
    const message = PAGE_REFUSALS.localeNotSupported;
    return {
      ...state,
      message,
      fieldErrors: Object.freeze({ ...fieldErrors, [PAGE_FIELDS.locale]: message }),
    };
  }
  if (apiError.code === "CONFLICT" && reason === "page_exists") {
    const slug = details?.["slug"];
    const locale = details?.["locale"];
    const message =
      typeof slug === "string" && typeof locale === "string"
        ? PAGE_REFUSALS.pageExists(slug, locale)
        : PAGE_REFUSALS.pageExistsUnnamed;
    return { ...state, message, fieldErrors: Object.freeze({ ...fieldErrors, [PAGE_FIELDS.slug]: message }) };
  }
  if (apiError.code === "CONFLICT" && reason === "page_linked") {
    const slug = details?.["slug"];
    return {
      ...state,
      message: typeof slug === "string" ? PAGE_REFUSALS.pageLinked(slug) : PAGE_REFUSALS.pageLinkedUnnamed,
    };
  }
  if (apiError.code === "CONFLICT" && reason === "idempotency_key_in_use") {
    return { ...state, message: PAGE_REFUSALS.busy };
  }
  if (apiError.code === "NOT_FOUND" && operation !== "create") {
    return { ...state, message: PAGE_REFUSALS.gone };
  }
  return state;
}

/**
 * "Create page" (`console.settings.pages.create`, `settings:write`): the address, the language, the kind, the title,
 * the body, published, footer and order, under the form's idempotency key; then the new page's own form.
 */
export async function createPage(_state: ActionState, form: FormData): Promise<PageActionState> {
  const staff = await staffFor();
  if ("state" in staff) {
    return staff.state;
  }
  const key = hiddenOf(form, ACTION_KEY_FIELD, ACTION_KEY_PATTERN);
  if (key === undefined) {
    return staleForm();
  }
  const parsed = newPageSchema.safeParse(pageFormInput(form));
  if (!parsed.success) {
    return fromZod(parsed.error);
  }
  let page: StorefrontPage;
  try {
    page = await staff.context.console.settings.pages.create(parsed.data, { idempotencyKey: key });
  } catch (error) {
    const state = failureOf("create", error);
    // `failureOf` threw anything that is not an API error, so `error` has the API error's shape here.
    return isVelexisErrorLike(error) ? withNextActionKey(state, error) : state;
  }
  revalidatePath(PAGES_PATH);
  redirect(pagePath(page.id));
}

/**
 * "Save" of a page's form (`console.settings.pages.update`, `settings:write`): its kind, title, body, published, footer
 * and order, with `ifMatch` = the version the page displayed.
 */
export async function updatePage(_state: ActionState, form: FormData): Promise<PageActionState> {
  const staff = await staffFor();
  if ("state" in staff) {
    return staff.state;
  }
  const pageId = hiddenOf(form, PAGE_FIELDS.pageId, PAGE_ID_PATTERN);
  const version = hiddenOf(form, PAGE_FIELDS.version, VERSION_PATTERN);
  if (pageId === undefined || version === undefined) {
    return staleForm();
  }
  const parsed = pageChangesSchema.safeParse(pageFormInput(form));
  if (!parsed.success) {
    return fromZod(parsed.error);
  }
  let page: StorefrontPage;
  try {
    page = await staff.context.console.settings.pages.update({
      pageId,
      ifMatch: Number(version),
      ...parsed.data,
    });
  } catch (error) {
    return failureOf("update", error);
  }
  revalidatePath(PAGES_PATH);
  revalidatePath(pagePath(pageId));
  return { ok: true, message: page.isPublished ? STRINGS.savedPublished : STRINGS.savedDraft };
}

/**
 * "Delete page" (`console.settings.pages.delete`, `settings:write`): `ifMatch` = the displayed version; then the list.
 * A page whose address a legal link of the storefront settings names is refused (`409 page_linked`).
 */
export async function deletePage(_state: ActionState, form: FormData): Promise<ActionState> {
  const staff = await staffFor();
  if ("state" in staff) {
    return staff.state;
  }
  const pageId = hiddenOf(form, PAGE_FIELDS.pageId, PAGE_ID_PATTERN);
  const version = hiddenOf(form, PAGE_FIELDS.version, VERSION_PATTERN);
  if (pageId === undefined || version === undefined) {
    return staleForm();
  }
  try {
    await staff.context.console.settings.pages.delete({ pageId, ifMatch: Number(version) });
  } catch (error) {
    const state = failureOf("delete", error);
    if (state.code === "NOT_FOUND") {
      revalidatePath(PAGES_PATH);
    }
    return state;
  }
  revalidatePath(PAGES_PATH);
  revalidatePath(pagePath(pageId));
  redirect(PAGES_PATH);
}
