import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AccountActions } from "@/app/(app)/accounts/[accountId]/account-actions";
import { auditHref, auditRowOf } from "@/app/(app)/audit/audit-filters";
import { AuditTable } from "@/app/(app)/audit/audit-table";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ACCOUNT_ACTION_STRINGS, ACCOUNT_DETAIL_STRINGS as S, ROLE_LABELS, formatCount } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type AdminAccount = Schemas["AdminAccount"];
type Membership = Schemas["AccountMembership"];

// Every role of the platform document has a label: a new one fails the type check until it has one.
const ROLES: Readonly<Record<Schemas["TenantRole"], string>> = ROLE_LABELS;

/** `AccountId` of the platform document; another value is no account, and the API is not asked. */
const ACCOUNT_ID = /^acc_[0-9A-HJKMNP-TV-Z]{26}$/;

const LINK_CLASS = "font-medium underline underline-offset-4";

/** A label of `labels`, or the raw value for one this build does not know yet (a newer API). */
function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}

function Muted({ children }: { readonly children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** An instant, or `empty` for `null`. */
function When({ value, empty }: { readonly value: string | null; readonly empty: string }) {
  return value === null ? <Muted>{empty}</Muted> : <DateTime value={value} />;
}

/** One term and its value of a description list. */
function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Section({
  id,
  title,
  intro,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly intro?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="grid gap-1">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {intro === undefined ? null : <p className="text-sm text-muted-foreground">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/** The account has a lockout or failed sign-ins that `adminUnlockAccount` clears. */
function hasLockout(account: AdminAccount): boolean {
  return account.status === "locked" || account.lockedUntil !== null || account.failedLoginCount > 0;
}

function AccountFields({ account }: { readonly account: AdminAccount }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label={S.id}>
        <span className="font-mono text-xs break-all">{account.id}</span>
      </Field>
      <Field label={S.email}>
        <span className="break-all">{account.email}</span>
      </Field>
      <Field label={S.emailVerified}>{account.emailVerified ? S.yes : S.no}</Field>
      <Field label={S.name}>{account.fullName}</Field>
      <Field label={S.locale}>{account.locale}</Field>
      <Field label={S.timeZone}>{account.timeZone}</Field>
      <Field label={S.status}>
        <StatusBadge kind="account" status={account.status} />
      </Field>
      <Field label={S.mfa}>
        {account.mfaEnabled ? (
          <span>
            {S.mfaOn}
            {account.mfaEnabledAt === null ? null : (
              <>
                {" "}
                <Muted>
                  ({S.mfaOnSince} <DateTime value={account.mfaEnabledAt} />)
                </Muted>
              </>
            )}
          </span>
        ) : (
          <Muted>{S.mfaOff}</Muted>
        )}
      </Field>
      <Field label={S.platformAdmin}>{account.isPlatformAdmin ? S.yes : S.no}</Field>
      <Field label={S.failedLogins}>
        <span className="tabular-nums">{formatCount(account.failedLoginCount)}</span>
      </Field>
      <Field label={S.lockedUntil}>
        <When value={account.lockedUntil} empty={S.notLocked} />
      </Field>
      <Field label={S.lastLogin}>
        <When value={account.lastLoginAt} empty={S.never} />
      </Field>
      <Field label={S.created}>
        <DateTime value={account.createdAt} />
      </Field>
      <Field label={S.version}>
        <span className="tabular-nums">{account.version}</span>
      </Field>
    </dl>
  );
}

function Memberships({ memberships }: { readonly memberships: readonly Membership[] }) {
  if (memberships.length === 0) {
    return <p className="text-sm text-muted-foreground">{S.membershipsEmpty}</p>;
  }
  return (
    <Table>
      <TableCaption className="sr-only">{S.membershipsCaption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{S.membershipOta}</TableHead>
          <TableHead scope="col">{S.membershipName}</TableHead>
          <TableHead scope="col">{S.membershipStatus}</TableHead>
          <TableHead scope="col">{S.membershipRole}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {memberships.map((membership) => (
          <TableRow key={membership.membershipId}>
            <TableCell>
              <Link
                href={`/tenants/${encodeURIComponent(membership.tenantId)}`}
                className={`${LINK_CLASS} font-mono`}
              >
                {membership.tenantKey}
              </Link>
            </TableCell>
            <TableCell>{membership.tenantName}</TableCell>
            <TableCell>
              <StatusBadge kind="tenant" status={membership.tenantStatus} />
            </TableCell>
            <TableCell>{labelOf(ROLES, membership.role)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BackLink() {
  return (
    <Link href="/accounts" className="text-sm font-medium underline underline-offset-4">
      {S.backToList}
    </Link>
  );
}

/**
 * `/accounts/[accountId]` (README §2, PF-87): one account for support, from one `adminGetAccount` call: its fields
 * (never a password hash, an MFA secret, a recovery code or a token: the API answers none), the number of its active
 * sessions, its active memberships (each linking its OTA) and its last 50 audit rows, with links to every row the
 * account acted in and every row about it. An id that is no account id, and an unknown one, render the not-found page.
 *
 * The actions (`account-actions.tsx`, server actions in `actions.ts`) are offered only where the API allows them:
 * unlock while there is a lockout to clear (no reason), disable (reason; never the admin's own account, which the page
 * knows from `adminGetMe`), enable a disabled account (reason), and reset two-factor authentication (reason and
 * step-up; not for a platform admin). The client component gets the account's id, name and the flags that decide
 * which actions show, and every success revalidates this page.
 */
export default async function AccountPage({ params }: Readonly<{ params: Promise<{ accountId: string }> }>) {
  const { accountId } = await params;
  if (!ACCOUNT_ID.test(accountId)) {
    notFound();
  }
  const api = await platformApi();
  const [result, me] = await Promise.all([
    api.GET("/v1/admin/accounts/{accountId}", { params: { path: { accountId } } }),
    api.GET("/v1/admin/me"),
  ]);
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect("/sign-in");
    }
    if (code === "NOT_FOUND" || code === "VALIDATION_FAILED") {
      notFound();
    }
    return (
      <div className="mx-auto grid max-w-6xl gap-6">
        <BackLink />
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(result.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const { account, memberships, activeSessions, recentAudit } = result.data;
  // Without the admin's own id (adminGetMe failed), the page cannot tell; the API still refuses `self`.
  const self = me.data?.id === account.id;
  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <BackLink />
      <div className="grid gap-2">
        <h1 className="flex flex-wrap items-center gap-3 text-3xl font-semibold tracking-tight">
          <span>{account.fullName}</span>
          <StatusBadge kind="account" status={account.status} />
        </h1>
        <p className="break-all text-muted-foreground">{account.email}</p>
      </div>

      <Section
        id="account-actions"
        title={ACCOUNT_ACTION_STRINGS.sectionTitle}
        intro={ACCOUNT_ACTION_STRINGS.sectionIntro}
      >
        <AccountActions
          accountId={account.id}
          name={account.fullName}
          status={account.status}
          mfaEnabled={account.mfaEnabled}
          isPlatformAdmin={account.isPlatformAdmin}
          locked={hasLockout(account)}
          self={self}
        />
      </Section>

      <Section id="account-fields" title={S.accountTitle}>
        <AccountFields account={account} />
      </Section>

      <Section id="account-sessions" title={S.sessionsTitle} intro={S.sessionsHint}>
        <p className="text-sm font-medium" data-active-sessions={activeSessions}>
          {S.activeSessions(activeSessions)}
        </p>
      </Section>

      <Section id="account-memberships" title={S.membershipsTitle}>
        <Memberships memberships={memberships} />
      </Section>

      <Section id="account-audit" title={S.auditTitle} intro={S.auditIntro}>
        <AuditTable rows={recentAudit.map(auditRowOf)} />
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href={auditHref({ actorAccountId: account.id })} className={LINK_CLASS}>
            {S.actorAudit}
          </Link>
          <Link href={auditHref({ targetType: "account", targetId: account.id })} className={LINK_CLASS}>
            {S.targetAudit}
          </Link>
        </p>
      </Section>
    </div>
  );
}
