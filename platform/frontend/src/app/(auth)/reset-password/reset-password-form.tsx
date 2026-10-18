"use client";

import Link from "next/link";
import { useActionState, useMemo } from "react";

import { confirmPasswordReset, type ResetPasswordState } from "@/app/(auth)/reset-password/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField, fieldId } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PASSWORD_RESET_STRINGS } from "@/lib/strings";

/** The state before the first submission. */
const INITIAL_STATE: ResetPasswordState = Object.freeze({ status: "idle" });

/** The entries of the error summary: the password problem, then a problem of no field. */
function summaryOf(state: ResetPasswordState): FormErrorItem[] {
  const items: FormErrorItem[] = [];
  if (state.fieldError !== undefined) {
    items.push({ message: state.fieldError, fieldId: fieldId("newPassword") });
  }
  if (state.message !== undefined && state.status === "failed") {
    items.push({ message: state.message });
  }
  return items;
}

/**
 * The new-password form of `/reset-password` (README §2 Auth, PF-05). It carries only the new password: the reset
 * token stays in its httpOnly cookie, which the `confirmPasswordReset` action reads on the server. When the token
 * turns out to be used or expired, the form gives way to the message and a link to ask for a new one.
 */
export function ResetPasswordForm() {
  const [state, dispatch, pending] = useActionState(confirmPasswordReset, INITIAL_STATE);
  const summary = useMemo(() => summaryOf(state), [state]);
  if (state.status === "expired") {
    return (
      <div className="grid gap-4">
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
        <p>
          <Link href="/forgot-password" prefetch={false} className="font-medium underline underline-offset-4">
            {PASSWORD_RESET_STRINGS.requestNewLink}
          </Link>
        </p>
      </div>
    );
  }
  return (
    <form action={dispatch} noValidate className="grid gap-5">
      <FormErrorSummary errors={summary} />
      <FormField
        label={PASSWORD_RESET_STRINGS.newPasswordLabel}
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        maxLength={256}
        description={PASSWORD_RESET_STRINGS.newPasswordHint}
        error={state.fieldError}
      />
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? PASSWORD_RESET_STRINGS.resetSubmitting : PASSWORD_RESET_STRINGS.resetSubmit}
      </Button>
    </form>
  );
}
