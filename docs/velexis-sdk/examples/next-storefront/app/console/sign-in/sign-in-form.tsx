"use client";

import { useActionState } from "react";
import { signInStaffAction, type StaffSignInState } from "./actions";
import { ErrorMessage } from "@/components/error-message";

export function StaffSignInForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<StaffSignInState, FormData>(signInStaffAction, {});
  return (
    <form action={action} className="auth-form">
      <input type="hidden" name="next" value={next} />
      <label>
        E-mail
        <input type="email" name="email" autoComplete="username" required />
      </label>
      <label>
        Password
        <input type="password" name="password" autoComplete="current-password" required />
      </label>
      {state.needMfa && (
        <label>
          Authenticator code
          <input name="mfaCode" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" autoFocus required />
        </label>
      )}
      <button type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
      {state.message && <p className="error" role="alert">{state.message}</p>}
      <ErrorMessage error={state.error} />
    </form>
  );
}
