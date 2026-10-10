"use client";

import { useActionState } from "react";
import { signUpAction } from "../actions";
import { fieldError, initialFormState } from "@/lib/action-state";
import { ErrorMessage } from "@/components/error-message";

/** Sign-up via a server action (`auth.signUp` + httpOnly session cookies). */
export function SignUpForm({ termsVersion, termsUrl, privacyUrl, next, minLength }: { termsVersion: string; termsUrl: string; privacyUrl: string; next: string; minLength: number }) {
  const [state, action, pending] = useActionState(signUpAction, initialFormState);
  if (state.ok && state.message) return <p className="notice">{state.message}</p>;
  return (
    <form action={action} className="auth-form">
      <input type="hidden" name="termsVersion" value={termsVersion} />
      <input type="hidden" name="next" value={next} />
      <label>
        First name
        <input name="firstName" autoComplete="given-name" required />
      </label>
      <label>
        Last name
        <input name="lastName" autoComplete="family-name" required />
      </label>
      <label>
        E-mail
        <input type="email" name="email" autoComplete="email" required />
        {fieldError(state.error, "/email") && <span className="error">{fieldError(state.error, "/email")}</span>}
      </label>
      <label>
        Password
        <input type="password" name="password" autoComplete="new-password" minLength={minLength} required />
        {fieldError(state.error, "/password") && <span className="error">{fieldError(state.error, "/password")}</span>}
      </label>
      <label>
        <input type="checkbox" name="marketing" /> Send me travel deals (optional)
      </label>
      <p className="muted">
        By creating an account you accept the <a href={termsUrl}>terms</a> and our <a href={privacyUrl}>privacy policy</a>.
      </p>
      <button type="submit" disabled={pending}>{pending ? "Creating account…" : "Create account"}</button>
      {state.message && <p className="error">{state.message}</p>}
      <ErrorMessage error={state.error} />
    </form>
  );
}
