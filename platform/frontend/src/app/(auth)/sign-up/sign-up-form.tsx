"use client";

import Link from "next/link";
import { useActionState, useMemo } from "react";

import { signUp, type SignUpField, type SignUpState } from "@/app/(auth)/sign-up/actions";
import { resendVerificationLink, type ResendState } from "@/app/(auth)/verify-pending/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField, fieldId } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SIGN_UP_STRINGS, VERIFICATION_STRINGS } from "@/lib/strings";

/**
 * The client forms of sign-up and e-mail verification (README §2 Auth, PF-01, PF-02): `SignUpForm` on `/sign-up`
 * and `ResendVerificationForm` ("send a new link") on `/sign-up/check-email` and `/verify-pending`. Both run a
 * server action through `useActionState`; they hold no token and call no API themselves.
 */

/** The state before the first submission. */
const INITIAL_SIGN_UP_STATE: SignUpState = Object.freeze({
  status: "idle",
  fieldErrors: Object.freeze({}),
  values: Object.freeze({ fullName: "", email: "", acceptTerms: false }),
});

/** The order of the fields in the form and in the error summary. */
const FIELD_ORDER: readonly SignUpField[] = ["fullName", "email", "password", "acceptTerms"];

/** The entries of the error summary: the field errors in form order, then a problem of no field. */
function summaryOf(state: SignUpState): FormErrorItem[] {
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

/**
 * The sign-up form: full name, e-mail, password and the terms checkbox. After a refused submission the fields
 * keep what was typed, except the password, which is never sent back to the browser. `email` prefills the address
 * (`?email=` of an invitation's sign-up link, PFE-012).
 */
export function SignUpForm({ email }: { readonly email?: string | undefined } = {}) {
  const [state, dispatch, pending] = useActionState(
    signUp,
    email === undefined
      ? INITIAL_SIGN_UP_STATE
      : { ...INITIAL_SIGN_UP_STATE, values: { ...INITIAL_SIGN_UP_STATE.values, email } },
  );
  // A new array per answer, so the summary takes the focus again after each refused submission.
  const summary = useMemo(() => summaryOf(state), [state]);
  return (
    <form action={dispatch} noValidate className="grid gap-5">
      <FormErrorSummary errors={summary} />
      <FormField
        label={SIGN_UP_STRINGS.fullNameLabel}
        name="fullName"
        autoComplete="name"
        required
        maxLength={200}
        defaultValue={state.values.fullName}
        error={state.fieldErrors.fullName}
      />
      <FormField
        label={SIGN_UP_STRINGS.emailLabel}
        name="email"
        type="email"
        autoComplete="email"
        required
        maxLength={254}
        description={SIGN_UP_STRINGS.emailHint}
        defaultValue={state.values.email}
        error={state.fieldErrors.email}
      />
      <FormField
        label={SIGN_UP_STRINGS.passwordLabel}
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        maxLength={256}
        description={SIGN_UP_STRINGS.passwordHint}
        error={state.fieldErrors.password}
      />
      <TermsField defaultChecked={state.values.acceptTerms} error={state.fieldErrors.acceptTerms} />
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? SIGN_UP_STRINGS.submitting : SIGN_UP_STRINGS.submit}
      </Button>
    </form>
  );
}

/** The terms checkbox, with its error linked like a `FormField`'s (`aria-describedby`, `aria-invalid`). */
function TermsField({ defaultChecked, error }: { defaultChecked: boolean; error: string | undefined }) {
  const id = fieldId("acceptTerms");
  const errorId = error === undefined ? undefined : `${id}-error`;
  return (
    <div className="grid gap-2" data-invalid={errorId === undefined ? undefined : true}>
      <div className="flex items-start gap-3">
        <input
          id={id}
          name="acceptTerms"
          type="checkbox"
          required
          defaultChecked={defaultChecked}
          aria-describedby={errorId}
          aria-invalid={errorId === undefined ? undefined : true}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
        <Label htmlFor={id} className="block leading-snug font-normal">
          {SIGN_UP_STRINGS.termsBefore}
          {/* New tabs, so reading the terms does not lose what was typed. */}
          <Link
            href="/legal/terms"
            target="_blank"
            rel="noreferrer"
            prefetch={false}
            className="underline underline-offset-4"
          >
            {SIGN_UP_STRINGS.termsLink}
          </Link>
          {SIGN_UP_STRINGS.termsBetween}
          <Link
            href="/legal/privacy"
            target="_blank"
            rel="noreferrer"
            prefetch={false}
            className="underline underline-offset-4"
          >
            {SIGN_UP_STRINGS.privacyLink}
          </Link>
        </Label>
      </div>
      {errorId === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The state of the "send a new link" form before its first submission. */
const INITIAL_RESEND_STATE: ResendState = Object.freeze({ status: "idle" });

export interface ResendVerificationFormProps {
  /**
   * Ask for the address: a visitor without a session. Without it, the link goes to the signed-in account's own
   * address, which the action reads on the server.
   */
  readonly askForEmail: boolean;
}

/**
 * "Send a new link" (`resendVerification`, PF-02 AC2). The confirmation is the same whether or not the address
 * has an account; more than 3 links an hour show the 3-per-hour message.
 */
export function ResendVerificationForm({ askForEmail }: ResendVerificationFormProps) {
  const [state, dispatch, pending] = useActionState(resendVerificationLink, INITIAL_RESEND_STATE);
  return (
    <form action={dispatch} noValidate className="grid gap-4">
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
      {askForEmail ? (
        <FormField
          id="resend-email"
          label={VERIFICATION_STRINGS.resendEmailLabel}
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          description={VERIFICATION_STRINGS.resendEmailHint}
          defaultValue={state.email ?? ""}
          error={state.fieldError}
        />
      ) : null}
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? VERIFICATION_STRINGS.resending : VERIFICATION_STRINGS.resend}
        </Button>
      </div>
    </form>
  );
}
