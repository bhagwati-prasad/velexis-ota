import type { PlatformErrorCode } from "@velexis/errors";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { platformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { SHELL_STRINGS } from "@/lib/strings";

/** Answers of `adminGetMe` that mean the admin session is over: sign in again. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/**
 * The signed-in console: every page of README §2 except the sign-in steps (README §3 and §4). The middleware has
 * already sent requests without an admin session to `/sign-in` and refreshed an expiring access token; this layout
 * loads the admin once per request (`adminGetMe`: name, e-mail address and the milestone switches of PADR-0015) and
 * renders `AdminShell` around the page with `APP_ENV`. A session the API no longer accepts goes to `/sign-in`; any
 * other failure (the API unreachable, the account no longer an admin) shows the admin's message for its code instead
 * of the shell.
 */
export default async function ConsoleLayout({ children }: Readonly<{ children: ReactNode }>) {
  const api = await platformApi();
  const me = await api.GET("/v1/admin/me");
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
        {/* The session cookies can still be cleared, for example after the admin role was revoked. */}
        <form action="/sign-out" method="post" className="mt-6">
          <Button type="submit" variant="outline">
            {SHELL_STRINGS.signOut}
          </Button>
        </form>
      </main>
    );
  }
  const admin = me.data;
  return (
    <AdminShell
      admin={{ fullName: admin.fullName, email: admin.email }}
      features={admin.features}
      environment={getConfig().APP_ENV}
    >
      {children}
    </AdminShell>
  );
}
