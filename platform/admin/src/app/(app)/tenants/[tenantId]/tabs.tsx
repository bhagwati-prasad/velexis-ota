"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { listHref } from "@/components/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TENANT_DETAIL_STRINGS, TENANT_TAB_LABELS } from "@/lib/strings";

/** A tab of the tenant detail page (README §2). */
export type TenantTabId = keyof typeof TENANT_TAB_LABELS;

/** The query parameter of the open tab; the overview, the first tab, has none. */
const TAB_PARAM = "tab";
const FIRST_TAB: TenantTabId = "overview";

/** One tab: its id (which names it) and its panel, rendered by the page's server component. */
export interface TenantTab {
  readonly id: TenantTabId;
  readonly content: ReactNode;
}

export interface TenantTabsProps {
  /** The tabs in display order. */
  readonly tabs: readonly TenantTab[];
}

/**
 * The tabs of `/tenants/[tenantId]` (README §2): overview, members and invitations, subscription and invoices,
 * connections, domains, provisioning jobs and audit. The panels are server-rendered from `adminGetTenant` by the page;
 * this component only switches between them. The open tab is in the URL (`?tab=audit`), so a link opens the same
 * tab; switching replaces the history entry without asking the API again.
 */
export function TenantTabs({ tabs }: TenantTabsProps) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams() ?? new URLSearchParams();
  const requested = searchParams.get(TAB_PARAM);
  const [value, setValue] = useState<string>(
    () => tabs.find((tab) => tab.id === requested)?.id ?? tabs[0]?.id ?? FIRST_TAB,
  );

  function change(next: string): void {
    setValue(next);
    // The history API, not the router: the tab is part of the shareable URL, but a switch is no new request.
    window.history.replaceState(
      null,
      "",
      listHref(pathname, searchParams, { [TAB_PARAM]: next === FIRST_TAB ? null : next }),
    );
  }

  return (
    <Tabs value={value} onValueChange={change} className="gap-6">
      <TabsList
        aria-label={TENANT_DETAIL_STRINGS.tabsLabel}
        className="h-auto w-full flex-wrap justify-start"
      >
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id} className="flex-none">
            {TENANT_TAB_LABELS[tab.id]}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} data-tab={tab.id}>
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
