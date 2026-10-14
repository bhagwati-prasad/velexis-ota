import type { PlatformErrorCode } from "@velexis/errors";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { SHELL_STRINGS } from "@/lib/strings";

/** Answers of `getMe` that mean the session is over: sign in again (the middleware's `/sign-in`). */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/**
 * The signed-in area (`/dashboard`, `/otas`, `/console`, `/account`; README §2 and §4). The middleware has
 * already sent requests without a session to `/sign-in`; this layout loads the account once per request
 * (`getMe`: memberships and milestone switches) and renders the shell around the page. A session the API no
 * longer accepts goes to `/sign-in`, an unverified account to `/verify-pending`, and any other failure shows the
 * portal's message for its code instead of the shell.
 */
export default async function SignedInLayout({ children }: Readonly<{ children: ReactNode }>) {
  const api = await platformApi();
  const me = await api.GET("/v1/me");
  if (me.error !== undefined) {
    if (SESSION_ENDED.has(me.error.code)) {
      redirect("/sign-in");
    }
    return (
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-24 focus:outline-none"
      >
        <Alert variant="destructive">
          <AlertTitle>{SHELL_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(me.error)}</AlertDescription>
        </Alert>
      </main>
    );
  }
  const account = me.data;
  if (!account.emailVerified) {
    redirect("/verify-pending");
  }
  return (
    <AppShell
      account={{ fullName: account.fullName, email: account.email }}
      memberships={account.memberships}
      features={account.features}
    >
      {children}
    </AppShell>
  );
}
