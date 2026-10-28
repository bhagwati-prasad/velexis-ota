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
  /**
   * A new idempotency key for the form's next submission (`crypto.randomUUID()` of the server action), after a failure
   * that used up the key the form sent: the API stored its final answer under that key, or refused the key as another
   * request's (`withNextActionKey`). Absent: the next submission sends the same key again, so a retry replays the
   * first request or waits for it (OADR-0018 point 5, revision of 2026-10-27, FIX-W31-OTA). Not shown.
   */
  readonly nextActionKey?: string;
}

/**
 * The hidden field of a confirmation dialog's idempotency key (README §7: rendered once with the page, sent as the
 * SDK's `idempotencyKey`). Here rather than in the dialog's client module, so the server actions' schemas can read it.
 */
export const ACTION_KEY_FIELD = "actionKey";

/** What `keepsActionKey` reads of a failed call: the shape of an SDK `VelexisError` (lib/errors.ts). */
export interface KeyedCallFailure {
  readonly status: number;
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Whether a form sends the same idempotency key again after its call failed with `failure` (OADR-0018 point 5,
 * revision of 2026-10-27, FIX-W31-OTA, lead decision (1) of 2026-10-27). The OTA API stores a final `4xx` under the key
 * for 24 hours (`idempotency.service.ts` `outcomeDisposition`), so a corrected resubmission with that key would only
 * get `409 IDEMPOTENCY_KEY_REUSED`: after one, and after `409 IDEMPOTENCY_KEY_REUSED` itself, the form needs a new
 * key. It keeps the key after `412 PRECONDITION_FAILED` (the page is out of date: a reload renders a new one), after
 * the API's transient answers that it never stores (`429`, `409 CONFLICT` with `details.reason =
 * idempotency_key_in_use`: the first request with the key still runs), after `503`, `504` and every other `5xx`, and
 * after a timeout or a network error (`status` 0): a retry then replays the first request's answer, waits for it, or
 * runs it once.
 */
export function keepsActionKey(failure: KeyedCallFailure): boolean {
  if (failure.code === "IDEMPOTENCY_KEY_REUSED") {
    return false;
  }
  if (failure.status < 400 || failure.status >= 500) {
    return true;
  }
  if (failure.status === 412 || failure.status === 429) {
    return true;
  }
  return failure.code === "CONFLICT" && failure.details?.["reason"] === "idempotency_key_in_use";
}

/**
 * `state` with a new idempotency key for the next submission (`nextActionKey`) when the call that failed with
 * `failure` used up the key it sent (`keepsActionKey`); `state` as it is otherwise. For the failure of a call that
 * carried the form's key only: a refusal before the call (the form's own validation, a permission) used no key.
 */
export function withNextActionKey(
  state: ActionState,
  failure: KeyedCallFailure,
  newKey: () => string = () => crypto.randomUUID(),
): ActionState {
  return keepsActionKey(failure) ? state : { ...state, nextActionKey: newKey() };
}

/** The key of a form's next submission: the action's new key when its state brings one, else `current`. */
export function actionKeyAfter(current: string, state: ActionState): string {
  return state.nextActionKey ?? current;
}
/** The field of a staff action's reason (`reason` of the console operations, stored in `staff_actions.reason`). */
export const REASON_FIELD = "reason";
/** The shortest reason the confirmation dialog accepts (some operations' `reason` has `minLength: 3`). */
export const REASON_MIN_LENGTH = 3;
/** The longest reason of the console operations (`maxLength: 500`). */
export const REASON_MAX_LENGTH = 500;

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
