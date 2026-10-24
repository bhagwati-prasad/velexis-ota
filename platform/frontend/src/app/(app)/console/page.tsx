import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  CONSOLE_QUERY,
  OpenConsoleButton,
  consolePickerPath,
  searchParam,
} from "@/components/open-console-button";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { CONSOLE_STRINGS, ROLE_LABELS } from "@/lib/strings";
import { isTenantId } from "@/lib/tenant";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: CONSOLE_STRINGS.pickerTitle };

type TenantSummary = components["schemas"]["TenantSummary"];

/** Answers that mean the session is over: sign in again and come back here. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/** One OTA of the picker: its name, status and the caller's role, and its "Open console" button. */
function ConsoleChoice({ tenant, selected }: { readonly tenant: TenantSummary; readonly selected: boolean }) {
  const nameId = `console-${tenant.id}`;
  return (
    <article
      aria-labelledby={nameId}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs",
        selected && "border-primary ring-2 ring-primary/30",
      )}
    >
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={nameId} className="text-lg font-semibold tracking-tight">
            {tenant.name}
          </h2>
          <StatusBadge kind="tenant" status={tenant.status} />
          {selected ? <Badge>{CONSOLE_STRINGS.pickerSelected}</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {CONSOLE_STRINGS.pickerRole}: {ROLE_LABELS[tenant.role]}
        </p>
      </div>
      <OpenConsoleButton
        tenantId={tenant.id}
        tenantName={tenant.name}
        variant={selected ? "default" : "outline"}
      />
    </article>
  );
}

/**
 * `/console?tenant=<id>` (README §2 Signed in, flow §C step 5, PADR-0007 point 5): where the OTA admin sends people
 * without a session, and where its tenant switcher links. The middleware sends a visitor without a session to sign-in
 * first, and back here. The page lists the account's OTAs (`listTenants`) with an "Open console" button each; the OTA
 * of `tenant` is pre-selected: first in the list, marked "Selected" (`aria-current`), and its button is the primary
 * one. With exactly one OTA the page shows that single button, as the choice unless `tenant` named another OTA. A
 * `tenant` the account is no member of (any more) gets a note, and the account's own OTAs stay listed, none selected.
 */
export default async function ConsolePickerPage({
  searchParams,
}: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = (await searchParams) ?? {};
  const requested = searchParam(query[CONSOLE_QUERY.tenant]);
  const wanted = isTenantId(requested) ? requested : undefined;

  const api = await platformApi();
  const tenants = await api.GET("/v1/tenants");
  if (tenants.error !== undefined) {
    if (SESSION_ENDED.has(tenants.error.code)) {
      redirect(`/sign-in?${new URLSearchParams({ next: consolePickerPath(wanted) }).toString()}`);
    }
    if (tenants.error.code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
  }

  const list = tenants.data?.data ?? [];
  const selected = list.find((tenant) => tenant.id === wanted);
  const ordered = selected === undefined ? list : [selected, ...list.filter((tenant) => tenant !== selected)];

  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{CONSOLE_STRINGS.pickerTitle}</h1>
        <p className="text-muted-foreground">{CONSOLE_STRINGS.pickerIntro}</p>
      </div>
      {wanted !== undefined && selected === undefined && tenants.error === undefined ? (
        <p role="status" className="rounded-lg border px-4 py-3 text-sm" data-notice="not-member">
          {CONSOLE_STRINGS.pickerNotMember}
        </p>
      ) : null}
      {tenants.error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>{CONSOLE_STRINGS.pickerUnavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(tenants.error)}</AlertDescription>
        </Alert>
      ) : ordered.length === 0 ? (
        <section aria-labelledby="console-empty" className="grid gap-3 rounded-xl border p-6">
          <h2 id="console-empty" className="text-lg font-semibold tracking-tight">
            {CONSOLE_STRINGS.pickerEmptyTitle}
          </h2>
          <p className="text-muted-foreground">{CONSOLE_STRINGS.pickerEmpty}</p>
          <p>
            <Link href="/dashboard" className="font-medium underline underline-offset-4">
              {CONSOLE_STRINGS.pickerDashboardLink}
            </Link>
          </p>
        </section>
      ) : ordered.length === 1 && ordered[0] !== undefined ? (
        // The one OTA is the choice, unless the OTA admin asked for another one, which the note above explains.
        <ConsoleChoice tenant={ordered[0]} selected={wanted === undefined || selected !== undefined} />
      ) : (
        <ul aria-label={CONSOLE_STRINGS.pickerListLabel} className="grid gap-4">
          {ordered.map((tenant) => (
            <li key={tenant.id}>
              <ConsoleChoice tenant={tenant} selected={tenant === selected} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
