"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@velexis/ota-sdk/react";
import { isVelexisError } from "@velexis/ota-sdk";

/**
 * Sign-in through the auth route handler (`POST /api/auth/sign-in`): the server stores the tokens in httpOnly cookies;
 * this component only learns who signed in.
 */
export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const { signIn, pending, error } = useAuth();
  const [locked, setLocked] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setLocked(null);
    try {
      await signIn({ email: String(f.get("email")), password: String(f.get("password")), rememberMe: f.get("remember") === "on" });
      router.push(next);
      router.refresh();
    } catch (err) {
      // useAuth also exposes the error as state; ACCOUNT_LOCKED (423, a plain VelexisError) carries details.lockedUntil.
      const lockedUntil = isVelexisError(err, "ACCOUNT_LOCKED") ? err.details?.lockedUntil : undefined;
      if (typeof lockedUntil === "string") setLocked(new Date(lockedUntil).toLocaleTimeString());
    }
  }

  const message =
    error?.code === "INVALID_CREDENTIALS"
      ? "E-mail or password is wrong."
      : error?.code === "EMAIL_NOT_VERIFIED"
        ? "Please confirm your e-mail first — we just sent you a new link."
        : error?.code === "RATE_LIMITED"
          ? "Too many attempts. Please wait a moment."
          : error?.code === "ACCOUNT_LOCKED"
            ? `Your account is locked${locked ? ` until ${locked}` : ""}. Reset your password to unlock it.`
            : error?.message;

  return (
    <form onSubmit={onSubmit} className="auth-form">
      <label>
        E-mail
        <input type="email" name="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input type="password" name="password" autoComplete="current-password" required />
      </label>
      <label>
        <input type="checkbox" name="remember" defaultChecked /> Keep me signed in
      </label>
      <button type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
      {message && <p className="error" role="alert">{message}</p>}
      <p>
        New here? <Link href={`/account/sign-up?next=${encodeURIComponent(next)}`}>Create an account</Link>
      </p>
    </form>
  );
}
