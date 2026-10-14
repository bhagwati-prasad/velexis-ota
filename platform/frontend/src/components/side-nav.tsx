"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";

import {
  accountNavigation,
  currentEntry,
  currentMembership,
  otaNavigation,
  type AccountMembership,
  type MilestoneFeatures,
  type NavEntry,
} from "@/lib/roles";
import { NAV_LABELS, ROLE_LABELS, SHELL_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

export interface SideNavProps {
  /** The account's memberships, from `getMe`. */
  readonly memberships: readonly AccountMembership[];
  /** The milestone switches, from `getMe` (PADR-0015): disabled areas have no entry. */
  readonly features: MilestoneFeatures;
}

function NavList({
  entries,
  current,
}: {
  readonly entries: readonly NavEntry<keyof typeof NAV_LABELS>[];
  readonly current: string | undefined;
}) {
  return (
    <ul className="grid gap-0.5">
      {entries.map((entry) => {
        const isCurrent = entry.href === current;
        return (
          <li key={entry.id}>
            <Link
              href={entry.href}
              aria-current={isCurrent ? "page" : undefined}
              className={cn(
                "block rounded-md px-3 py-2 text-sm text-sidebar-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50",
                isCurrent && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              )}
            >
              {NAV_LABELS[entry.id]}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The side navigation of the signed-in shell (README §4). Inside an OTA (`/otas/<tenantId>/…`) it lists that
 * OTA's pages filtered by the caller's role (`lib/roles.ts`, scope §1.2) and by the milestone switches; the
 * account pages are always there. The current page is marked with `aria-current="page"`.
 */
export function SideNav({ memberships, features }: SideNavProps) {
  const pathname = usePathname() ?? "";
  const otaHeadingId = useId();
  const accountHeadingId = useId();
  const membership = currentMembership(memberships, pathname);
  const otaEntries =
    membership === undefined ? [] : otaNavigation(membership.tenantId, membership.role, features);
  const accountEntries = accountNavigation();
  const current = currentEntry([...otaEntries, ...accountEntries], pathname)?.href;

  return (
    <nav aria-label={SHELL_STRINGS.navigationLabel} className="grid gap-6">
      {membership === undefined ? null : (
        <section aria-labelledby={otaHeadingId} className="grid gap-2">
          <div className="px-3">
            <h2 id={otaHeadingId} className="truncate text-sm font-semibold">
              <span className="sr-only">{SHELL_STRINGS.otaSection}: </span>
              {membership.tenantName}
            </h2>
            <p className="text-xs text-muted-foreground">{ROLE_LABELS[membership.role]}</p>
          </div>
          <NavList entries={otaEntries} current={current} />
        </section>
      )}
      <section aria-labelledby={accountHeadingId} className="grid gap-2">
        <h2
          id={accountHeadingId}
          className="px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          {SHELL_STRINGS.accountSection}
        </h2>
        <NavList entries={accountEntries} current={current} />
      </section>
    </nav>
  );
}
