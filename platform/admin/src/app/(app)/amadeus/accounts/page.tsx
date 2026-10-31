import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AccountActions, CreateAccountForm } from "@/app/(app)/amadeus/accounts/account-form";
import { DateTime } from "@/components/date-time";
import { MaskedValue } from "@/components/masked-value";
import { StatusBadge, toneClasses } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  AMADEUS_ACCOUNT_STRINGS as S,
  DASHBOARD_STRINGS,
  STATUS_LABELS,
  SUPPLIER_ENVIRONMENT_LABELS,
  formatCount,
} from "@/lib/strings";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type Account = Schemas["AdminAmadeusAccount"];
type Environment = Schemas["Environment"];
type OfficeStatus = Schemas["AmadeusOfficeStatus"];

/** One Velexis Amadeus account per environment (ADR-0012): the page has a section for each, in this order. */
const ENVIRONMENTS: readonly Environment[] = ["test", "live"];

// Every value of the platform document has a label: a new one fails the type check until it has one.
const ENVIRONMENT_LABELS: Readonly<Record<Environment, string>> = SUPPLIER_ENVIRONMENT_LABELS;
const OFFICE_STATUS_LABELS: Readonly<Record<OfficeStatus, string>> = STATUS_LABELS.amadeusOffice;

/** The statuses of `officeCounts`, in the order of an office's life (PADR-0012 item 1). */
const OFFICE_STATUSES: readonly OfficeStatus[] = ["available", "assigned", "releasing", "retired"];

/** Below this many available offices the pool level is a warning (PADR-0012 item 6), as on the dashboard. */
const OFFICE_POOL_LOW = 3;

/** Values shorter than this show no characters at all when masked. */
const MASK_MIN_LENGTH = 8;

/**
 * The last four characters of the client id, computed here on the server so the whole value never reaches the page
 * (README §2: credentials are masked, as on the tenant page); `null` for a value too short to show any of it.
 */
function lastFour(value: string): string | null {
  return value.length >= MASK_MIN_LENGTH ? value.slice(-4) : null;
}

/** The office pool filtered in the URL, as the dashboard links it. */
function poolHref(environment: Environment, status: OfficeStatus): string {
  return `/amadeus/offices?${new URLSearchParams({ environment, status }).toString()}`;
}

function Muted({ children }: { readonly children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** The offices of the account's pool in each status, each linking to the pool filtered by it. */
function OfficeCounts({ account, label }: { readonly account: Account; readonly label: string }) {
  const environment = account.environment;
  const low = account.officeCounts.available < OFFICE_POOL_LOW;
  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium">{S.offices}</h3>
      <ul className="flex flex-wrap gap-3" aria-label={S.officesCaption(label)}>
        {OFFICE_STATUSES.map((status) => (
          <li key={status}>
            <Link
              href={poolHref(environment, status)}
              className="group grid gap-0.5 rounded-lg border px-3 py-2 outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              data-count={account.officeCounts[status]}
            >
              <span className="text-lg font-semibold tabular-nums">
                {formatCount(account.officeCounts[status])}
              </span>{" "}
              {/* The hover's foreground on hover: muted text on bg-accent is 4.35:1, under WCAG 1.4.3's 4.5:1. */}
              <span className="text-xs text-muted-foreground group-hover:text-accent-foreground">
                {OFFICE_STATUS_LABELS[status]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {low ? (
        // Words, not only colour: the warning says what is wrong and what to do.
        <p
          className={cn("rounded-lg px-4 py-3 text-sm", toneClasses("warning"))}
          data-warning="office-pool-low"
        >
          {DASHBOARD_STRINGS.poolLow(label, account.officeCounts.available)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The account of one environment: its fields (the client id masked, the secret never: the API does not answer it),
 * the offices of its pool, and the actions. Only the fields the actions need reach the client component.
 */
function AccountDetails({ account, label }: { readonly account: Account; readonly label: string }) {
  const clientIdLast4 = lastFour(account.clientId);
  return (
    <div className="grid gap-5">
      {account.status === "pending_verification" ? (
        <p role="status" className={cn("rounded-lg px-4 py-3 text-sm", toneClasses("info"))}>
          {S.verifying}
        </p>
      ) : null}
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={S.name}>{account.name}</Field>
        <Field label={S.status}>
          <StatusBadge kind="amadeusAccount" status={account.status} />
        </Field>
        <Field label={S.baseUrl}>
          <span className="font-mono text-xs break-all">{account.baseUrl}</span>
        </Field>
        <Field label={S.clientId}>
          <MaskedValue label={S.clientId} last4={clientIdLast4} />
        </Field>
        <Field label={S.clientSecret}>
          <Muted>{S.secretStored}</Muted>
        </Field>
        <Field label={S.lastVerified}>
          {account.lastVerifiedAt === null ? (
            <Muted>{S.never}</Muted>
          ) : (
            <DateTime value={account.lastVerifiedAt} />
          )}
        </Field>
        <Field label={S.lastError}>
          {account.lastError === null ? (
            <Muted>{S.none}</Muted>
          ) : (
            <span className="break-words">{account.lastError}</span>
          )}
        </Field>
        <Field label={S.created}>
          <DateTime value={account.createdAt} />
        </Field>
        <Field label={S.accountId}>
          <span className="font-mono text-xs break-all">{account.id}</span>
        </Field>
      </dl>
      <OfficeCounts account={account} label={label} />
      <AccountActions
        accountId={account.id}
        environment={account.environment}
        environmentLabel={label}
        status={account.status}
        version={account.version}
        name={account.name}
        baseUrl={account.baseUrl}
        clientIdLast4={clientIdLast4}
      />
    </div>
  );
}

function EnvironmentSection({
  environment,
  account,
}: {
  readonly environment: Environment;
  readonly account: Account | undefined;
}) {
  const label = ENVIRONMENT_LABELS[environment];
  const headingId = `amadeus-account-${environment}`;
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-4 rounded-xl border p-6"
      data-environment={environment}
    >
      <h2 id={headingId} className="text-xl font-semibold tracking-tight">
        {S.environmentTitle(label)}
      </h2>
      {account === undefined ? (
        <p className="text-sm text-muted-foreground">
          {S.noAccount(label)} {environment === "test" ? S.noAccountTest : S.noAccountLive}
        </p>
      ) : null}
      {/* Rendered with an account too, so the outcome of a creation stays while the page follows it. */}
      <CreateAccountForm
        environment={environment}
        environmentLabel={label}
        hasAccount={account !== undefined}
      />
      {account === undefined ? null : <AccountDetails account={account} label={label} />}
    </section>
  );
}

/**
 * `/amadeus/accounts` (README §2, flows/amadeus-connection.md §A, PF-90): the Velexis Amadeus account of each
 * environment from `adminListAmadeusAccounts`, with its verification state, last verification and last error, the
 * offices of its pool by status (each linking to the pool filtered by it, with a warning below three available), and
 * its actions: verify, edit the details, rotate the secret (step-up) and disable. An environment without an account
 * offers to create one (step-up); the account then shows `pending_verification` until the verification job has run,
 * and the page asks the API again on its own until the result is in. The client secret is never part of the page: the
 * API never answers it, and its fields are never pre-filled.
 */
export default async function AmadeusAccountsPage() {
  const api = await platformApi();
  const result = await api.GET("/v1/admin/amadeus-accounts");
  if (
    result.error !== undefined &&
    (result.error.code === "UNAUTHENTICATED" || result.error.code === "TOKEN_EXPIRED")
  ) {
    redirect("/sign-in");
  }
  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      {result.error === undefined ? (
        ENVIRONMENTS.map((environment) => (
          <EnvironmentSection
            key={environment}
            environment={environment}
            account={result.data.data.find((account) => account.environment === environment)}
          />
        ))
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(result.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
