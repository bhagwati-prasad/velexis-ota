// The signed-in shell of the console (README §4 to §6, OADR-0018 points 4 and 6, routes.md §1): every page of the
// route map renders inside it. The middleware has already refreshed an expiring access token and sent requests
// without a session to the portal; this layout loads the request's console once (`getConsoleRequest`:
// `console.auth.me` and the environment the request works in) and renders
//
// - the OTA's name and the navigation, filtered by `can()` (README §8);
// - the TEST / LIVE switch when the session lists `live` and the role may open it (`canOpenEnvironment`; a viewer
//   never sees it), else the environment badge; the whole shell turns a warning colour in live mode;
// - the staff member, "Back to the portal" (the portal's console page of this OTA, PADR-0007 §5) and "Sign out"
//   (a plain POST to the route handler, which checks `Origin`);
// - the banner of a refused live environment (routes.md §1: the request already fell back to test, and the banner
//   resets the cookie);
// - the page as `<main id="main-content">`, the target of the root layout's skip link.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the shell knows are handled
// here, on the server: `TOKEN_EXPIRED` and an ended session redirect (lib/velexis.ts), `403 TENANT_SUSPENDED` renders
// the full page "This OTA is suspended" with a link to the portal, and any other API error renders the console's
// message for its code with the request id instead of the shell.
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { ConsoleNav } from "@/components/console-nav";
import { EnvironmentBadge, EnvironmentBanner, EnvironmentSwitch } from "@/components/env-banner";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { getConfig } from "@/config";
import { SIGN_OUT_PATH } from "@/lib/auth-routes";
import { isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { canOpenEnvironment } from "@/lib/permissions";
import { portalConsoleUrl, readSessionCookies } from "@/lib/session";
import { cn } from "@/lib/utils";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

const SHELL_STRINGS = Object.freeze({
  productName: "Velexis OTA admin",
  backToPortal: "Back to the portal",
  signedInAs: "Signed in as",
  signOut: "Sign out",
  suspendedTitle: "This OTA is suspended",
  unavailableTitle: "The console is unavailable",
  retry: "Try again",
  roles: {
    owner: "Owner",
    admin: "Admin",
    agent: "Agent",
    finance: "Finance",
    viewer: "Viewer",
  },
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";

/** The full page instead of the shell when `console.auth.me` failed with an API error. */
function ConsoleUnavailable({
  error,
  portal,
}: {
  readonly error: VelexisErrorLike;
  readonly portal: string;
}) {
  const suspended = error.code === "TENANT_SUSPENDED";
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16 focus:outline-none"
    >
      <ErrorState
        level={1}
        title={suspended ? SHELL_STRINGS.suspendedTitle : SHELL_STRINGS.unavailableTitle}
        error={error}
      >
        {suspended ? null : (
          // The same URL again: a server component does not know its path, and a new request is what helps.
          <a href="" className={LINK_CLASS}>
            {SHELL_STRINGS.retry}
          </a>
        )}
        <a href={portal} className={LINK_CLASS}>
          {SHELL_STRINGS.backToPortal}
        </a>
      </ErrorState>
    </main>
  );
}

export default async function ConsoleLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { PUBLIC_PORTAL_URL } = getConfig();
  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // Next.js's redirects (to /auth/refresh or the portal) and bugs go on; API errors get the full page.
    if (!isVelexisErrorLike(error)) {
      throw error;
    }
    const { tenantId } = readSessionCookies(await cookies());
    return <ConsoleUnavailable error={error} portal={portalConsoleUrl(PUBLIC_PORTAL_URL, tenantId)} />;
  }

  const { staff, environment, liveRefused } = request;
  const live = environment === "live";
  const portal = portalConsoleUrl(PUBLIC_PORTAL_URL, staff.tenant.id);
  // What the navigation needs of the profile, and nothing more, crosses into the client component.
  const holder = { staff: { role: staff.staff.role }, permissions: staff.permissions };
  return (
    <div data-environment={environment} className="min-h-dvh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <div
        className={cn(
          "border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:border-r md:border-b-0",
          live && "border-amber-500 bg-amber-50",
        )}
      >
        <div className="flex flex-col gap-4 p-4 md:sticky md:top-0 md:max-h-dvh md:overflow-y-auto">
          <div className="grid gap-0.5 px-3">
            <p className="text-xs text-muted-foreground">{SHELL_STRINGS.productName}</p>
            <p className="text-lg font-semibold tracking-tight">{staff.tenant.name}</p>
          </div>
          <ConsoleNav profile={holder} />
        </div>
      </div>
      <div className="flex min-w-0 flex-col">
        <header
          className={cn(
            "flex flex-wrap items-center justify-between gap-4 border-b px-6 py-3",
            live && "border-amber-500 bg-amber-100",
          )}
        >
          {canOpenEnvironment(staff, "live") ? (
            <EnvironmentSwitch environment={environment} />
          ) : (
            <EnvironmentBadge environment={environment} />
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-4">
            <a href={portal} className={LINK_CLASS}>
              {SHELL_STRINGS.backToPortal}
            </a>
            <div className="min-w-0 text-right text-sm">
              <p className="truncate font-medium">
                <span className="sr-only">{SHELL_STRINGS.signedInAs} </span>
                {staff.staff.fullName}
              </p>
              <p className="truncate text-muted-foreground">{SHELL_STRINGS.roles[staff.staff.role]}</p>
            </div>
            {/* A plain POST to the sign-out route handler (README §3), which checks Origin and clears the cookies. */}
            <form action={SIGN_OUT_PATH} method="post">
              <Button type="submit" variant="outline" size="sm">
                {SHELL_STRINGS.signOut}
              </Button>
            </form>
          </div>
        </header>
        <EnvironmentBanner environment={environment} liveRefused={liveRefused} />
        <main id="main-content" tabIndex={-1} className="flex-1 px-6 py-8 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
