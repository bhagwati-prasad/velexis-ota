"use client";

import { ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { currentMembership, membershipHref, type AccountMembership } from "@/lib/roles";
import { ROLE_LABELS, SHELL_STRINGS } from "@/lib/strings";

export interface OtaSwitcherProps {
  /** The account's memberships, from `getMe`. */
  readonly memberships: readonly AccountMembership[];
}

/**
 * The OTA switcher of the signed-in shell (README §4): a menu of every OTA the account is a member of, with its
 * key, the caller's role and its status when it is not active, plus "All OTAs" and "Create an OTA". The button
 * names the OTA of the current page.
 */
export function OtaSwitcher({ memberships }: OtaSwitcherProps) {
  const pathname = usePathname() ?? "";
  const current = currentMembership(memberships, pathname);
  const currentName = current?.tenantName ?? SHELL_STRINGS.switcherPlaceholder;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between"
          aria-label={`${SHELL_STRINGS.switcherLabel}: ${currentName}`}
        >
          <span className="truncate">{currentName}</span>
          <ChevronsUpDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>{SHELL_STRINGS.switcherMenuLabel}</DropdownMenuLabel>
        {memberships.length === 0 ? (
          <DropdownMenuItem disabled>{SHELL_STRINGS.switcherEmpty}</DropdownMenuItem>
        ) : (
          memberships.map((membership) => (
            <DropdownMenuItem key={membership.tenantId} asChild>
              <Link
                href={membershipHref(membership)}
                aria-current={membership.tenantId === current?.tenantId ? "page" : undefined}
                className="flex items-start justify-between gap-2"
              >
                <span className="grid min-w-0">
                  <span className="truncate font-medium">{membership.tenantName}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {membership.tenantKey} · {ROLE_LABELS[membership.role]}
                  </span>
                </span>
                {membership.tenantStatus === "active" ? null : (
                  <StatusBadge kind="tenant" status={membership.tenantStatus} />
                )}
              </Link>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard">{SHELL_STRINGS.switcherAll}</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/otas/new">{SHELL_STRINGS.switcherCreate}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
