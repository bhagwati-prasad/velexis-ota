"use client";

// The navigation of the console shell (README §5 and §8): every area of the route map, shown only to staff whose
// role and session hold the area's read permission (`can()` of lib/permissions.ts). Hiding is for clarity; the pages
// and the API check again. The current page is marked with `aria-current`.
import type { StaffPermission } from "@velexis/ota-sdk";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";

import { can, type PermissionHolder } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/** One area of the route map. */
export interface NavEntry {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  /** The permission that opens the area; `null` for the links any staff member has (the portal page). */
  readonly permission: StaffPermission | null;
}

/** One group of areas. */
export interface NavSection {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly NavEntry[];
}

/** The navigation label of the shell. */
export const NAV_LABEL = "Console";

/** Every area of README §5 in display order, with the permission of its main read. */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "operations",
    label: "Operations",
    entries: [
      { id: "dashboard", label: "Dashboard", href: "/", permission: "bookings:read" },
      { id: "bookings", label: "Bookings", href: "/bookings", permission: "bookings:read" },
      { id: "pnr", label: "PNR lookup", href: "/pnr", permission: "bookings:read" },
      { id: "queues", label: "Queues", href: "/queues", permission: "queues:read" },
      { id: "shopping", label: "Shopping", href: "/shopping", permission: "amadeus:read" },
    ],
  },
  {
    id: "money-and-customers",
    label: "Payments and customers",
    entries: [
      { id: "payments", label: "Payments", href: "/payments", permission: "payments:read" },
      { id: "customers", label: "Customers", href: "/customers", permission: "customers:read" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    entries: [
      { id: "markups", label: "Markups", href: "/settings/markups", permission: "settings:read" },
      { id: "fees", label: "Fees", href: "/settings/fees", permission: "settings:read" },
      { id: "storefront", label: "Storefront", href: "/settings/storefront", permission: "settings:read" },
      { id: "assets", label: "Assets", href: "/settings/assets", permission: "settings:read" },
      { id: "pages", label: "Pages", href: "/settings/pages", permission: "settings:read" },
      {
        id: "templates",
        label: "E-mail templates",
        href: "/settings/templates",
        permission: "settings:read",
      },
    ],
  },
  {
    id: "support",
    label: "Support",
    entries: [
      {
        id: "supplier-log",
        label: "Supplier log",
        href: "/supplier-log",
        permission: "supplier_requests:read",
      },
      { id: "portal", label: "Portal links", href: "/portal", permission: null },
    ],
  },
];

/** The navigation of `profile`: entries it cannot open are left out, and so are groups left empty. */
export function consoleNavigation(profile: PermissionHolder | null | undefined): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) => entry.permission === null || can(profile, entry.permission)),
  })).filter((section) => section.entries.length > 0);
}

/** `href` is the page of `pathname` or one of its parents; the dashboard `/` only matches itself. */
function matches(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The entry that is the current page: the most specific `href` that is the page or one of its parents. */
export function currentNavEntry(sections: readonly NavSection[], pathname: string): NavEntry | undefined {
  return sections
    .flatMap((section) => section.entries)
    .filter((entry) => matches(pathname, entry.href))
    .sort((left, right) => right.href.length - left.href.length)[0];
}

/** The side navigation of the shell. */
export function ConsoleNav({ profile }: { readonly profile: PermissionHolder }) {
  const pathname = usePathname() ?? "";
  const idPrefix = useId();
  const sections = consoleNavigation(profile);
  const current = currentNavEntry(sections, pathname)?.href;
  return (
    <nav aria-label={NAV_LABEL} className="grid gap-5">
      {sections.map((section) => {
        const headingId = `${idPrefix}-${section.id}`;
        return (
          <section key={section.id} aria-labelledby={headingId} className="grid gap-1">
            <h2
              id={headingId}
              className="px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase"
            >
              {section.label}
            </h2>
            <ul className="grid gap-0.5">
              {section.entries.map((entry) => {
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
                      {entry.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
