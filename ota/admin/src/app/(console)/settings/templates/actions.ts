// The server actions of the e-mail templates (OAD-015; routes.md §9, api-changes part 2 §2.6, README §7, OADR-0018
// points 4 and 5, OADR-0013 point 3): saving, previewing and resetting the OTA's template of one key, channel and
// locale through the SDK's console namespace with the client `requireStaff` hands back (the staff token of the request,
// the service key, the environment of the switch, the end-user headers). Templates are shared by the test and live
// environments.
//
//   saveTemplate      console.settings.templates.put       settings:write   `ifMatch` = the displayed version, if any
//   previewTemplate   console.settings.templates.preview   settings:read    the draft as the form holds it
//   resetTemplate     console.settings.templates.reset     settings:write   the locale's own row is deleted
//
// Each starts with `requireStaff(permission)` (a forged POST from a role without it gets "You do not have permission
// to do this (<permission>)" before any call; the API decides and audits all the same), then checks the template's
// address the form posts (key, channel, locale; one the API would refuse: "This form is out of date") and, for a save,
// the subject, the HTML and the text with the Zod mirror of NotificationTemplateInput (content-rules.ts, line breaks as
// `\n`), then makes one SDK call.
//
// - **Save** sends the three parts and `isActive`, with `ifMatch` whenever the page showed a `version`: the locale has
//   its own row then, the one provisioning seeded from the code default included (FIX-W33-OTA: not when `customised`
//   is); without one (an inherited template or the code default) it sends none and the API creates the locale's row.
//   The `PUT` has no idempotency key (the contract has none: `If-Match` makes a replay a `412`).
// - **Preview** renders the draft (the three parts as the form holds them) with the key's sample data; nothing is
//   stored, so nothing is revalidated, and the rendered HTML goes only into the sandboxed frame of preview-frame.tsx.
// - **Reset** deletes the locale's own row and answers what serves the locale then (its language's row or the code
//   default), which the page shows after its revalidation.
//
// The API's codes become the form's state, never `error.tsx`: `422 TEMPLATE_INVALID` as its problems per part and line
// (`details.errors`, content-rules.ts `templateProblemsOf`) and on the part's field, `422 UNPROCESSABLE`
// `locale_not_supported`, `412` in this page's words, the API's field errors on their fields; only redirects and bugs
// are thrown.
"use server";

import type { NotificationTemplate, NotificationTemplatePreview, StaffPermission } from "@velexis/ota-sdk";
import { revalidatePath } from "next/cache";

import { fromZod, type ActionState } from "@/lib/action-state";
import { fromVelexisError, type VelexisErrorLike } from "@/lib/errors";
import { requireStaff, type StaffContext } from "@/lib/session";

import {
  SETTINGS_READ,
  SETTINGS_WRITE,
  TEMPLATES_PATH,
  TEMPLATE_FIELDS,
  VERSION_PATTERN,
  problemFieldErrors,
  templateDraftSchema,
  templateFormInput,
  templateInputSchema,
  templatePath,
  templateProblemsOf,
  templateRefOfForm,
  textOf,
  type PreviewActionState,
  type TemplateActionState,
  type TemplateRef,
} from "../content-rules";

const STRINGS = Object.freeze({
  staleForm: "This form is out of date. Reload the page and try again.",
  savedActive: (locale: string) => `Saved. The next e-mails in ${locale} use this template.`,
  savedInactive: (locale: string) =>
    `Saved as inactive: e-mails in ${locale} keep using the template of its language or the default until you activate it.`,
  previewed: "Preview rendered below with the template's sample data. Nothing was saved or sent.",
  resetToLanguage: (locale: string, language: string) =>
    `Reset. E-mails in ${locale} use the ${language} template again.`,
  resetToDefault: (locale: string) => `Reset. E-mails in ${locale} use the default template again.`,
  changed:
    "This template changed since the page was shown (saved, created or reset elsewhere). Reload the page to see it, then make your change again.",
  localeNotSupported: (locale: string) =>
    `The storefront does not offer ${locale}. Add it to the supported languages in the storefront settings first, then save the template.`,
});

/** The hidden fields of a template form: an API field error on one of them means the form is out of date. */
const HIDDEN_FIELDS: ReadonlySet<string> = new Set([
  TEMPLATE_FIELDS.templateKey,
  TEMPLATE_FIELDS.channel,
  TEMPLATE_FIELDS.locale,
  TEMPLATE_FIELDS.version,
  "ifMatch",
]);

/** The state of a form whose hidden fields are not the page's. */
function staleForm(): ActionState {
  return { ok: false, code: "VALIDATION_FAILED", message: STRINGS.staleForm };
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

/**
 * The state of a failed call: lib/errors.ts's message, request id and field errors, and this page's words for the codes
 * it knows (`422 TEMPLATE_INVALID` with its problems per part and line, `locale_not_supported`, `412`). Redirects and
 * bugs are thrown again (`fromVelexisError`).
 */
function failureOf(ref: TemplateRef, error: unknown): TemplateActionState {
  const base = fromVelexisError(error);
  const apiError = error as VelexisErrorLike;
  let state: TemplateActionState = base;
  if (Object.keys(base.fieldErrors ?? {}).some((name) => HIDDEN_FIELDS.has(name))) {
    state = { ...state, message: STRINGS.staleForm };
  }
  if (apiError.code === "TEMPLATE_INVALID") {
    const problems = templateProblemsOf(apiError.details);
    const fieldErrors = problemFieldErrors(problems);
    return {
      ...state,
      ...(problems.length === 0 ? {} : { problems: Object.freeze(problems) }),
      ...(Object.keys(fieldErrors).length === 0 ? {} : { fieldErrors: Object.freeze(fieldErrors) }),
    };
  }
  if (apiError.code === "UNPROCESSABLE" && apiError.details?.["reason"] === "locale_not_supported") {
    return { ...state, message: STRINGS.localeNotSupported(ref.locale) };
  }
  if (apiError.code === "PRECONDITION_FAILED") {
    return { ...state, message: STRINGS.changed };
  }
  return state;
}

/**
 * "Save" of a template's page (`console.settings.templates.put`, `settings:write`): the subject, the HTML, the text and
 * `isActive`, with `ifMatch` = the version the page showed when the locale has its own row.
 */
export async function saveTemplate(_state: ActionState, form: FormData): Promise<TemplateActionState> {
  const staff = await staffFor(SETTINGS_WRITE);
  if ("state" in staff) {
    return staff.state;
  }
  const ref = templateRefOfForm(form);
  const version = textOf(form, TEMPLATE_FIELDS.version);
  if (ref === undefined || (version !== "" && !VERSION_PATTERN.test(version))) {
    return staleForm();
  }
  const parsed = templateInputSchema.safeParse(templateFormInput(form));
  if (!parsed.success) {
    return fromZod(parsed.error);
  }
  let saved: NotificationTemplate;
  try {
    saved = await staff.context.console.settings.templates.put({
      ...ref,
      ...(version === "" ? {} : { ifMatch: Number(version) }),
      ...parsed.data,
    });
  } catch (error) {
    return failureOf(ref, error);
  }
  revalidatePath(TEMPLATES_PATH);
  revalidatePath(templatePath(ref));
  return {
    ok: true,
    message: saved.isActive ? STRINGS.savedActive(ref.locale) : STRINGS.savedInactive(ref.locale),
  };
}

/**
 * "Preview" of a template's page (`console.settings.templates.preview`, `settings:read`, every role): the draft's
 * subject, HTML and text rendered with the key's sample data. Nothing is stored.
 */
export async function previewTemplate(_state: ActionState, form: FormData): Promise<PreviewActionState> {
  const staff = await staffFor(SETTINGS_READ);
  if ("state" in staff) {
    return staff.state;
  }
  const ref = templateRefOfForm(form);
  if (ref === undefined) {
    return staleForm();
  }
  const parsed = templateDraftSchema.safeParse(templateFormInput(form));
  if (!parsed.success) {
    return fromZod(parsed.error);
  }
  let rendered: NotificationTemplatePreview;
  try {
    rendered = await staff.context.console.settings.templates.preview({ ...ref, ...parsed.data });
  } catch (error) {
    return failureOf(ref, error);
  }
  return {
    ok: true,
    message: STRINGS.previewed,
    preview: { subject: rendered.subject, html: rendered.html, text: rendered.text },
  };
}

/**
 * "Reset to default" of a template's page (`console.settings.templates.reset`, `settings:write`): deletes the locale's
 * own row; e-mails use its language's row or the code default again.
 */
export async function resetTemplate(_state: ActionState, form: FormData): Promise<ActionState> {
  const staff = await staffFor(SETTINGS_WRITE);
  if ("state" in staff) {
    return staff.state;
  }
  const ref = templateRefOfForm(form);
  if (ref === undefined) {
    return staleForm();
  }
  let serving: NotificationTemplate;
  try {
    serving = await staff.context.console.settings.templates.reset(ref);
  } catch (error) {
    return failureOf(ref, error);
  }
  revalidatePath(TEMPLATES_PATH);
  revalidatePath(templatePath(ref));
  return {
    ok: true,
    message:
      serving.inheritedFrom === null
        ? STRINGS.resetToDefault(ref.locale)
        : STRINGS.resetToLanguage(ref.locale, serving.inheritedFrom),
  };
}
