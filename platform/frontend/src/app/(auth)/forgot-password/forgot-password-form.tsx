"use client";

import { useActionState } from "react";

import { requestPasswordReset, type ForgotPasswordState } from "@/app/(auth)/forgot-password/actions";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PASSWORD_RESET_STRINGS } from "@/lib/strings";

/** The state before the first submission. */
const INITIAL_STATE: ForgotPasswordState = Object.freeze({ status: "idle", email: "" });

/**
 * The form of `/forgot-password` (README §2 Auth, PF-05 AC1): the address to send a reset link to. The
 * confirmation reads the same for every address.
 */
export function ForgotPasswordForm() {
  const [state, dispatch, pending] = useActionState(requestPasswordReset, INITIAL_STATE);
  return (
    <form action={dispatch} noValidate className="grid gap-5">
      {state.status === "sent" && state.message !== undefined ? (
        <Alert role="status">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      {state.status === "failed" && state.message !== undefined ? (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      <FormField
        label={PASSWORD_RESET_STRINGS.emailLabel}
        name="email"
        type="email"
        autoComplete="email"
        required
        maxLength={254}
        defaultValue={state.email}
        error={state.fieldError}
      />
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? PASSWORD_RESET_STRINGS.requestSubmitting : PASSWORD_RESET_STRINGS.requestSubmit}
      </Button>
    </form>
  );
}
