"use client";

import Link from "next/link";
import { useActionState, useMemo } from "react";

import { signIn, type SignInField, type SignInState } from "@/app/(auth)/sign-in/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField, fieldId } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { SIGN_IN_STRINGS } from "@/lib/strings";

/**
 * The sign-in form of `/sign-in` (README §2 Auth, PF-03): e-mail and password, posted to the `signIn` server action
 * through `useActionState`. It holds no token and calls no API itself; the session cookies are written on the
 * server.
 */

/** The state before the first submission. */
const INITIAL_STATE: SignInState = Object.freeze({
  status: "idle",
  fieldErrors: Object.freeze({}),
  values: Object.freeze({ email: "" }),
});

const FIELD_ORDER: readonly SignInField[] = ["email", "password"];

/** The entries of the error summary: the field errors in form order, then a problem of no field. */
function summaryOf(state: SignInState): FormErrorItem[] {
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

export interface SignInFormProps {
  /** The validated return path after sign-in (`safeNextPath`); the action checks it again. */
  readonly next?: string | undefined;
  /** The address to prefill: `?email=` of an invitation's sign-in link (PFE-012). */
  readonly email?: string | undefined;
}

/** E-mail and password. After a refused submission the address stays; the password never comes back. */
export function SignInForm({ next, email }: SignInFormProps) {
  const [state, dispatch, pending] = useActionState(
    signIn,
    email === undefined ? INITIAL_STATE : { ...INITIAL_STATE, values: { email } },
  );
  // A new array per answer, so the summary takes the focus again after each refused submission.
  const summary = useMemo(() => summaryOf(state), [state]);
  return (
    <form action={dispatch} noValidate className="grid gap-5">
      <FormErrorSummary errors={summary} />
      {next === undefined ? null : <input type="hidden" name="next" value={next} />}
      <FormField
        label={SIGN_IN_STRINGS.emailLabel}
        name="email"
        type="email"
        autoComplete="username"
        required
        maxLength={254}
        defaultValue={state.values.email}
        error={state.fieldErrors.email}
      />
      <FormField
        label={SIGN_IN_STRINGS.passwordLabel}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={256}
        error={state.fieldErrors.password}
      />
      <p className="-mt-2 text-sm">
        <Link href="/forgot-password" prefetch={false} className="underline underline-offset-4">
          {SIGN_IN_STRINGS.forgotPassword}
        </Link>
      </p>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? SIGN_IN_STRINGS.submitting : SIGN_IN_STRINGS.submit}
      </Button>
    </form>
  );
}
