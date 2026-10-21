"use client";

import { useActionState, useMemo } from "react";

import {
  changeAccountPassword,
  type PasswordField,
  type PasswordState,
} from "@/app/(app)/account/security/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField, fieldId } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { SECURITY_STRINGS } from "@/lib/strings";

/**
 * The password form of `/account/security` (README §2): the current password and a new one, sent to
 * `changeAccountPassword`. The fields are uncontrolled and the form is a plain action form, so React empties them
 * after every answer: a password is never kept in the page, in the action's state or anywhere else.
 */

const IDLE: PasswordState = Object.freeze({ status: "idle", fieldErrors: Object.freeze({}) });

const FIELD_ORDER: readonly PasswordField[] = ["currentPassword", "newPassword"];

function summaryOf(state: PasswordState): FormErrorItem[] {
  const items: FormErrorItem[] = [];
  for (const field of FIELD_ORDER) {
    const message = state.fieldErrors[field];
    if (message !== undefined) {
      items.push({ message, fieldId: fieldId(field) });
    }
  }
  if (state.message !== undefined) {
    items.push({ message: state.message });
  }
  return items;
}

export function PasswordForm() {
  const [state, dispatch, pending] = useActionState(changeAccountPassword, IDLE);
  // A new array per answer, so the summary takes the focus again after each refused change.
  const summary = useMemo(() => summaryOf(state), [state]);
  return (
    <form action={dispatch} noValidate className="grid gap-5" data-form="password">
      <FormErrorSummary errors={summary} />
      {state.status === "changed" ? (
        <p role="status" className="rounded-lg border px-4 py-3 text-sm font-medium">
          {SECURITY_STRINGS.passwordChanged}
        </p>
      ) : null}
      <FormField
        label={SECURITY_STRINGS.currentPasswordLabel}
        name="currentPassword"
        type="password"
        error={state.fieldErrors.currentPassword}
        autoComplete="current-password"
        required
      />
      <FormField
        label={SECURITY_STRINGS.newPasswordLabel}
        name="newPassword"
        type="password"
        description={SECURITY_STRINGS.newPasswordHint}
        error={state.fieldErrors.newPassword}
        autoComplete="new-password"
        required
        minLength={10}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? SECURITY_STRINGS.passwordSubmitting : SECURITY_STRINGS.passwordSubmit}
        </Button>
      </div>
    </form>
  );
}
