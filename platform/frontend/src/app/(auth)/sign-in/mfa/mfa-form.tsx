"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";

import { verifyMfa, type MfaMethod, type MfaState } from "@/app/(auth)/sign-in/mfa/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField, fieldId } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { MFA_STRINGS } from "@/lib/strings";

/**
 * The form of `/sign-in/mfa` (README §2 Auth, PF-04 AC2): a code of the authenticator app, or, after "Use a
 * recovery code instead", one recovery code. The hidden field `method` tells the `verifyMfa` action which one was
 * sent. The challenge itself stays in its httpOnly cookie; this component never sees it.
 */

/** The state before the first submission. */
const INITIAL_STATE: MfaState = Object.freeze({ status: "idle", method: "totp" });

/** The form field of each method. */
const FIELD_NAME: Readonly<Record<MfaMethod, string>> = Object.freeze({
  totp: "code",
  recovery: "recoveryCode",
});

/** The entries of the error summary: the field error of the shown method, then a problem of no field. */
function summaryOf(state: MfaState, method: MfaMethod): FormErrorItem[] {
  const items: FormErrorItem[] = [];
  if (state.fieldError !== undefined && state.method === method) {
    items.push({ message: state.fieldError, fieldId: fieldId(FIELD_NAME[method]) });
  }
  if (state.message !== undefined) {
    items.push({ message: state.message });
  }
  return items;
}

export function MfaForm() {
  const [state, dispatch, pending] = useActionState(verifyMfa, INITIAL_STATE);
  const [method, setMethod] = useState<MfaMethod>("totp");
  const switched = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // A new array per answer, so the summary takes the focus again after each refused submission.
  const summary = useMemo(() => summaryOf(state, method), [state, method]);

  // After a switch the new field takes the focus, so a keyboard user can type the other code at once.
  useEffect(() => {
    if (switched.current) {
      input.current?.focus();
    }
  }, [method]);

  function toggle(): void {
    switched.current = true;
    setMethod((current) => (current === "totp" ? "recovery" : "totp"));
  }

  const error = state.method === method ? state.fieldError : undefined;
  return (
    <form action={dispatch} noValidate className="grid gap-5">
      <FormErrorSummary errors={summary} />
      <p>{method === "totp" ? MFA_STRINGS.totpIntro : MFA_STRINGS.recoveryIntro}</p>
      <input type="hidden" name="method" value={method} />
      {method === "totp" ? (
        <FormField
          key="totp"
          ref={input}
          label={MFA_STRINGS.codeLabel}
          name={FIELD_NAME.totp}
          description={MFA_STRINGS.codeHint}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          required
          error={error}
        />
      ) : (
        <FormField
          key="recovery"
          ref={input}
          label={MFA_STRINGS.recoveryLabel}
          name={FIELD_NAME.recovery}
          description={MFA_STRINGS.recoveryHint}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={24}
          required
          error={error}
        />
      )}
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? MFA_STRINGS.submitting : MFA_STRINGS.submit}
        </Button>
        <Button type="button" variant="link" className="px-0" onClick={toggle}>
          {method === "totp" ? MFA_STRINGS.useRecoveryCode : MFA_STRINGS.useAuthenticator}
        </Button>
      </div>
    </form>
  );
}
