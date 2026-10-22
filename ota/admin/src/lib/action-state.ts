// The state of a server action as forms read it with `useActionState` (README §7, conventions §3): plain,
// serialisable data that crosses from the server action to the browser. It carries messages in the admin's own
// words, the field errors keyed by form field name and the API's request id, never an error object, a stack, a
// token, a card number or what the person typed into a secret field.
//
// No server-only import: client components (forms, dialogs) read these types and helpers too.
import type { ZodError } from "zod";

/** Messages per form field name (`reason`, `contacts.0.email`), the first problem of each field. */
export type FieldErrors = Readonly<Record<string, string>>;

/**
 * What a form shows after a submission. `ok` is `undefined` before the first submission, `true` after a success
 * and `false` after a failure. `requestId` is the API's `X-Request-Id` of a failed call, shown so staff can quote
 * it to support.
 */
export interface ActionState {
  readonly ok?: boolean;
  readonly message?: string;
  /** The error code of a failure (the API's or the action's own), for tests and conditional UI; not shown. */
  readonly code?: string;
  readonly requestId?: string;
  readonly fieldErrors?: FieldErrors;
}

/** The state before the first submission: `useActionState(action, INITIAL_ACTION_STATE)`. */
export const INITIAL_ACTION_STATE: ActionState = Object.freeze({});

/** The message of a form whose fields did not pass the form's own validation. */
export const INVALID_FORM_MESSAGE = "Check the highlighted fields and try again.";

/** A successful submission, with an optional confirmation message. */
export function actionSuccess(message?: string): ActionState {
  return message === undefined ? { ok: true } : { ok: true, message };
}

/** What a failure may carry besides its message. */
export interface FailureDetails {
  readonly code?: string | undefined;
  readonly requestId?: string | null | undefined;
  readonly fieldErrors?: FieldErrors | undefined;
}

/** A failed submission: the message, and the code, request id and field errors when there are any. */
export function actionFailure(message: string, details: FailureDetails = {}): ActionState {
  const { code, requestId, fieldErrors } = details;
  return {
    ok: false,
    message,
    ...(code === undefined ? {} : { code }),
    ...(requestId === undefined || requestId === null || requestId === "" ? {} : { requestId }),
    ...(fieldErrors === undefined || Object.keys(fieldErrors).length === 0
      ? {}
      : { fieldErrors: Object.freeze({ ...fieldErrors }) }),
  };
}

/**
 * The form field name of a path: segments joined with dots (`["contacts", 0, "email"]` → `contacts.0.email`), the
 * names forms use for nested inputs. The empty path is the form itself.
 */
export function fieldName(path: readonly (string | number)[]): string {
  return path.map(String).join(".");
}

/**
 * The state of a form that failed its Zod schema (`schema.safeParse(...)`): one message per field, the first issue
 * of each, in the schema's words. Issues without a path (refinements of the whole form) become the message.
 */
export function fromZod(error: ZodError, message: string = INVALID_FORM_MESSAGE): ActionState {
  const fieldErrors: Record<string, string> = {};
  let formMessage: string | undefined;
  for (const issue of error.issues) {
    const name = fieldName(issue.path);
    if (name === "") {
      formMessage ??= issue.message;
    } else if (!Object.hasOwn(fieldErrors, name)) {
      fieldErrors[name] = issue.message;
    }
  }
  return actionFailure(formMessage ?? message, { code: "VALIDATION_FAILED", fieldErrors });
}

/** The message of one field in `state`, or `undefined` when the field has none. */
export function fieldError(state: ActionState, name: string): string | undefined {
  const errors = state.fieldErrors;
  return errors !== undefined && Object.hasOwn(errors, name) ? errors[name] : undefined;
}

/**
 * The element id of a field's error message, for `aria-describedby` on the input (conventions §3). Characters that
 * are awkward in ids and CSS selectors become `-`.
 */
export function fieldErrorId(name: string): string {
  return `${name.replace(/[^A-Za-z0-9_-]/g, "-")}-error`;
}
