"use client";

import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, type ReactNode } from "react";

import { toneClasses, type StatusTone } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ENVIRONMENT_LABELS, NAV_LABELS, NAV_SECTION_LABELS, SHELL_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** The milestone switches of PADR-0015, from `adminGetMe`. */
export type MilestoneFeatures = components["schemas"]["MilestoneFeatures"];

/**
 * `APP_ENV` of the admin process, shown as a badge in the shell. The values of `ADMIN_CONFIG_SCHEMA` (lib/config.ts,
 * which client code never imports, not even for a type); the layout passes `getConfig().APP_ENV`, so the type check
 * fails if the two ever differ.
 */
export type AppEnvironment = keyof typeof ENVIRONMENT_LABELS;

/** One entry of the navigation: an area of README §2. */
export type NavId = keyof typeof NAV_LABELS;
/** One group of entries. */
export type NavSectionId = keyof typeof NAV_SECTION_LABELS;

interface NavRule {
  readonly href: string;
  /**
   * The milestone switches of an M5 area (PADR-0015 item 3): the entry shows when one of them is on, and is hidden
   * while all are off. M1 areas have none and always show.
   */
  readonly features?: readonly (keyof MilestoneFeatures)[];
}

/** Every area of README §2, grouped as the navigation shows them. */
const NAV_SECTIONS: readonly { readonly id: NavSectionId; readonly entries: readonly NavId[] }[] = [
  { id: "overview", entries: ["dashboard"] },
  { id: "tenants", entries: ["tenants", "provisioningJobs", "queues"] },
  { id: "billing", entries: ["plans", "subscriptions", "invoices", "stripeEvents"] },
  { id: "amadeus", entries: ["amadeusAccounts", "amadeusOffices"] },
  { id: "payments", entries: ["settlements", "domains"] },
  { id: "people", entries: ["accounts", "admins", "audit"] },
];

/**
 * Where each area lives and which switch it needs. Invoices come from Stripe Billing; the Stripe event inbox serves
 * both Stripe Billing and the OTAs' own Stripe accounts (the dashboard counts its failures while either is on).
 */
const NAV_RULES: Readonly<Record<NavId, NavRule>> = {
  dashboard: { href: "/" },
  tenants: { href: "/tenants" },
  provisioningJobs: { href: "/provisioning-jobs" },
  queues: { href: "/queues" },
  plans: { href: "/plans" },
  subscriptions: { href: "/subscriptions" },
  invoices: { href: "/invoices", features: ["stripeBilling"] },
  stripeEvents: { href: "/stripe-events", features: ["stripeBilling", "ownStripe"] },
  amadeusAccounts: { href: "/amadeus/accounts" },
  amadeusOffices: { href: "/amadeus/offices" },
  settlements: { href: "/settlements", features: ["settlements"] },
  domains: { href: "/domains", features: ["customDomains"] },
  accounts: { href: "/accounts" },
  admins: { href: "/admins" },
  audit: { href: "/audit" },
};

/** A navigation entry to render. */
export interface NavEntry {
  readonly id: NavId;
  readonly href: string;
}

/** A group of entries to render; a group whose areas are all switched off is left out. */
export interface NavSection {
  readonly id: NavSectionId;
  readonly entries: readonly NavEntry[];
}

function isVisible(rule: NavRule, features: MilestoneFeatures): boolean {
  return rule.features === undefined || rule.features.some((feature) => features[feature]);
}

/** The navigation with the milestone switches of `features` applied (PADR-0015 item 3). */
export function adminNavigation(features: MilestoneFeatures): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    id: section.id,
    entries: section.entries
      .filter((id) => isVisible(NAV_RULES[id], features))
      .map((id) => ({ id, href: NAV_RULES[id].href })),
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

const ENVIRONMENT_TONES: Readonly<Record<AppEnvironment, StatusTone>> = {
  development: "info",
  test: "warning",
  production: "danger",
};

/** The `APP_ENV` badge: production stands out, so nobody takes it for a test system. */
export function EnvironmentBadge({
  environment,
  className,
}: {
  readonly environment: AppEnvironment;
  readonly className?: string;
}) {
  return (
    <Badge
      variant="outline"
      data-environment={environment}
      className={cn(toneClasses(ENVIRONMENT_TONES[environment]), className)}
    >
      <span className="sr-only">{SHELL_STRINGS.environmentLabel}: </span>
      {ENVIRONMENT_LABELS[environment]}
    </Badge>
  );
}

function SideNav({ sections }: { readonly sections: readonly NavSection[] }) {
  const pathname = usePathname() ?? "";
  const idPrefix = useId();
  const current = currentNavEntry(sections, pathname)?.href;
  return (
    <nav aria-label={SHELL_STRINGS.navigationLabel} className="grid gap-5">
      {sections.map((section) => {
        const headingId = `${idPrefix}-${section.id}`;
        return (
          <section key={section.id} aria-labelledby={headingId} className="grid gap-1">
            <h2
              id={headingId}
              className="px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase"
            >
              {NAV_SECTION_LABELS[section.id]}
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
                      {NAV_LABELS[entry.id]}
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

export interface AdminShellProps {
  /** The signed-in admin, from `adminGetMe`. */
  readonly admin: { readonly fullName: string; readonly email: string };
  /** The milestone switches of `adminGetMe` (PADR-0015): the M5 areas are hidden while theirs are off. */
  readonly features: MilestoneFeatures;
  /** `APP_ENV` of this process. */
  readonly environment: AppEnvironment;
  readonly children: ReactNode;
}

/**
 * The signed-in layout of the platform admin (README §3): the sidebar with the product name and the navigation of
 * every area of README §2 (M5 areas only with their switch on), a header with the environment badge, the signed-in
 * admin and "Sign out", and the page as `<main id="main-content">`, the target of the
 * root layout's skip link (pages inside the shell render no `<main>` of their own). It holds no token or secret: the
 * name, the e-mail address, the switches and `APP_ENV` are all it gets.
 */
export function AdminShell({ admin, features, environment, children }: AdminShellProps) {
  const sections = adminNavigation(features);
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:border-r md:border-b-0">
        <div className="flex flex-col gap-4 p-4 md:sticky md:top-0 md:max-h-dvh md:overflow-y-auto">
          <Link href="/" className="px-3 text-lg font-semibold tracking-tight">
            {SHELL_STRINGS.productName}
          </Link>
          <SideNav sections={sections} />
        </div>
      </div>
      <div className="flex min-w-0 flex-col">
        <header className="flex items-center justify-between gap-4 border-b px-6 py-3">
          <EnvironmentBadge environment={environment} />
          <div className="flex min-w-0 items-center gap-4">
            <div className="min-w-0 text-right text-sm">
              <p className="truncate font-medium">
                <span className="sr-only">{SHELL_STRINGS.signedInAs} </span>
                {admin.fullName}
              </p>
              <p className="truncate text-muted-foreground">{admin.email}</p>
            </div>
            {/* A plain POST to the sign-out route handler (README §4), which checks Origin and clears the cookies. */}
            <form action="/sign-out" method="post">
              <Button type="submit" variant="outline" size="sm">
                {SHELL_STRINGS.signOut}
              </Button>
            </form>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="flex-1 px-6 py-8 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
