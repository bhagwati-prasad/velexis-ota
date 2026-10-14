import Link from "next/link";
import type { ReactNode } from "react";

import { OtaSwitcher } from "@/components/ota-switcher";
import { SideNav } from "@/components/side-nav";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import type { AccountMembership, MilestoneFeatures } from "@/lib/roles";
import { SHELL_STRINGS } from "@/lib/strings";

export interface AppShellProps {
  /** Who is signed in, shown in the header. */
  readonly account: { readonly fullName: string; readonly email: string };
  /** The account's memberships, for the OTA switcher and the role-filtered navigation. */
  readonly memberships: readonly AccountMembership[];
  /** The milestone switches of `getMe` (PADR-0015). */
  readonly features: MilestoneFeatures;
  readonly children: ReactNode;
}

/**
 * The signed-in layout of the portal (README §4): the sidebar with the OTA switcher and the side navigation, a
 * header with the account and "Sign out", and the page as `<main id="main-content">`, the target of the root
 * layout's skip link (pages inside the shell render no `<main>` of their own). A server component; only the
 * switcher, the navigation and the toaster run in the browser, with the memberships and switches as props
 * (no token or secret).
 */
export function AppShell({ account, memberships, features, children }: AppShellProps) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:border-r md:border-b-0">
        <div className="flex flex-col gap-4 p-4 md:sticky md:top-0 md:max-h-dvh md:overflow-y-auto">
          <Link href="/dashboard" className="px-3 text-lg font-semibold tracking-tight">
            {SHELL_STRINGS.productName}
          </Link>
          <OtaSwitcher memberships={memberships} />
          <SideNav memberships={memberships} features={features} />
        </div>
      </div>
      <div className="flex min-w-0 flex-col">
        <header className="flex items-center justify-end gap-4 border-b px-6 py-3">
          <div className="min-w-0 text-right text-sm">
            <p className="truncate font-medium">{account.fullName}</p>
            <p className="truncate text-muted-foreground">{account.email}</p>
          </div>
          {/* A plain POST to the sign-out route handler (README §2), which checks Origin and clears the cookies. */}
          <form action="/sign-out" method="post">
            <Button type="submit" variant="outline" size="sm">
              {SHELL_STRINGS.signOut}
            </Button>
          </form>
        </header>
        <main id="main-content" tabIndex={-1} className="flex-1 px-6 py-8 focus:outline-none">
          {children}
        </main>
      </div>
      <Toaster />
    </div>
  );
}
