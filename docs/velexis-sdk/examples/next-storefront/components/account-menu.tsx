"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, useSession } from "@velexis/ota-sdk/react";

/** Header account menu: the session is read through the proxy (`GET /v1/auth/session` with the httpOnly token). */
export function AccountMenu() {
  const { customer, status } = useSession();
  const { signOut, pending } = useAuth();
  const router = useRouter();

  if (status === "loading") return <span className="account-menu muted">…</span>;
  if (!customer) {
    return (
      <span className="account-menu">
        <Link href="/account/sign-in">Sign in</Link> · <Link href="/account/sign-up">Create account</Link>
      </span>
    );
  }
  return (
    <span className="account-menu">
      <Link href="/account">Hi {customer.firstName}</Link>
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          await signOut("current");
          router.push("/");
          router.refresh();
        }}
      >
        Sign out
      </button>
    </span>
  );
}
