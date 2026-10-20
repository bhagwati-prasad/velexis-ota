import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { TenantTabs, type TenantTab } from "@/app/(app)/tenants/[tenantId]/tabs";
import { DateTime } from "@/components/date-time";
import { JsonView } from "@/components/json-view";
import { MaskedValue } from "@/components/masked-value";
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
import {
  AUDIT_ACTOR_LABELS,
  BILLING_INTERVAL_LABELS,
  BILLING_NOTICE_LABELS,
  BILLING_PROVIDER_LABELS,
  CREDENTIAL_SOURCE_LABELS,
  DOMAIN_KIND_LABELS,
  DOMAIN_PURPOSE_LABELS,
  JOB_KIND_LABELS,
  PAYMENT_ACCOUNT_MODE_LABELS,
  PAYMENT_PROVIDER_LABELS,
  ROLE_LABELS,
  SUBSCRIPTION_BANNER_LABELS,
  SUPPLIER_ENVIRONMENT_LABELS,
  SUSPENSION_REASON_LABELS,
  TENANT_DETAIL_STRINGS as S,
  TENANT_TAB_LABELS,
} from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type TenantDetail = Schemas["AdminTenantDetail"];
type AdminTenant = Schemas["AdminTenant"];
type Member = Schemas["Member"];
type Invitation = Schemas["Invitation"];
type Subscription = Schemas["Subscription"];
type AmadeusConnection = Schemas["AmadeusConnection"];
type PaymentConnection = Schemas["PaymentConnection"];
type PendingSubmission = Schemas["PendingCredentialSubmission"];
type Domain = Schemas["Domain"];
type Job = Schemas["AdminProvisioningJob"];
type AuditEntry = Schemas["AuditEntry"];

// Every value of the platform document has a label: a new one fails the type check until it has one.
const ENVIRONMENTS: Readonly<Record<Schemas["Environment"], string>> = SUPPLIER_ENVIRONMENT_LABELS;
const ROLES: Readonly<Record<Schemas["TenantRole"], string>> = ROLE_LABELS;
const SUSPENSION_REASONS: Readonly<Record<NonNullable<Schemas["SuspensionReason"]>, string>> =
  SUSPENSION_REASON_LABELS;
const BILLING_NOTICES: Readonly<Record<NonNullable<Schemas["BillingNotice"]>, string>> =
  BILLING_NOTICE_LABELS;
const BANNERS: Readonly<Record<NonNullable<Subscription["banner"]>, string>> = SUBSCRIPTION_BANNER_LABELS;
const PROVIDERS: Readonly<Record<Subscription["billingProvider"], string>> = BILLING_PROVIDER_LABELS;
const INTERVALS: Readonly<Record<Schemas["BillingInterval"], string>> = BILLING_INTERVAL_LABELS;
const CREDENTIAL_SOURCES: Readonly<Record<AmadeusConnection["credentialSource"], string>> =
  CREDENTIAL_SOURCE_LABELS;
const ACCOUNT_MODES: Readonly<Record<PaymentConnection["accountMode"], string>> = PAYMENT_ACCOUNT_MODE_LABELS;
const PAYMENT_PROVIDERS: Readonly<Record<PaymentConnection["provider"], string>> = PAYMENT_PROVIDER_LABELS;
const DOMAIN_KINDS: Readonly<Record<Domain["kind"], string>> = DOMAIN_KIND_LABELS;
const DOMAIN_PURPOSES: Readonly<Record<Domain["purpose"], string>> = DOMAIN_PURPOSE_LABELS;
const JOB_KINDS: Readonly<Record<Schemas["ProvisioningJobKind"], string>> = JOB_KIND_LABELS;
const ACTORS: Readonly<Record<Schemas["AuditActorType"], string>> = AUDIT_ACTOR_LABELS;

/** `AdminTenantId` of the platform document; another value is no tenant, and the API is not asked. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A label of `labels`, or the raw value for one this build does not know yet (a newer API). */
function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}

// ---- Masking ------------------------------------------------------------------------------------------------------

/** Values shorter than this show no characters at all when masked. */
const MASK_MIN_LENGTH = 8;

/** The visible prefixes of Stripe identifiers (`pk_test_`, `acct_`); the rest of the value stays masked. */
const STRIPE_PREFIX = /^(?:pk_(?:test|live)_|acct_)/;

/**
 * The masked shape of an identifier for `MaskedValue`: its Stripe prefix and its last four characters, computed here
 * on the server so the whole value never reaches the page (README §2: connections are masked).
 */
function masked(value: string): { prefix: string | undefined; last4: string | undefined } {
  const prefix = STRIPE_PREFIX.exec(value)?.[0];
  const rest = prefix === undefined ? value : value.slice(prefix.length);
  return { prefix, last4: rest.length >= MASK_MIN_LENGTH ? rest.slice(-4) : undefined };
}

function Masked({ label, value }: { readonly label: string; readonly value: string | null }) {
  if (value === null) {
    return <Muted>{S.none}</Muted>;
  }
  const { prefix, last4 } = masked(value);
  return <MaskedValue label={label} prefix={prefix} last4={last4} />;
}

// ---- Small building blocks ----------------------------------------------------------------------------------------

function Muted({ children }: { readonly children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>;
}

/** A text value, or "Not set" for `null`. */
function Text({ value, empty = S.notSet }: { readonly value: string | null; readonly empty?: string }) {
  return value === null || value === "" ? <Muted>{empty}</Muted> : <>{value}</>;
}

/** An instant, or `empty` ("Not yet" by default) for `null`. */
function When({ value, empty = S.notYet }: { readonly value: string | null; readonly empty?: string }) {
  return value === null ? <Muted>{empty}</Muted> : <DateTime value={value} />;
}

function YesNo({ value }: { readonly value: boolean }) {
  return <>{value ? S.yes : S.no}</>;
}

/** A description list of label and value pairs. */
function Fields({ children }: { readonly children: ReactNode }) {
  return <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">{children}</dl>;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Panel({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

const LINK_CLASS = "font-medium underline underline-offset-4";

// ---- Overview -----------------------------------------------------------------------------------------------------

function OverviewPanel({ tenant }: { readonly tenant: AdminTenant }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel id="tenant-overview" title={TENANT_TAB_LABELS.overview}>
        <Fields>
          <Field label={S.name}>{tenant.name}</Field>
          <Field label={S.key}>
            <Mono>{tenant.key}</Mono>
          </Field>
          <Field label={S.id}>
            <Mono>{tenant.id}</Mono>
          </Field>
          <Field label={S.legalName}>
            <Text value={tenant.legalName} />
          </Field>
          <Field label={S.status}>
            <StatusBadge kind="tenant" status={tenant.status} />
          </Field>
          {tenant.suspensionReason === null ? null : (
            <Field label={S.suspensionReason}>{labelOf(SUSPENSION_REASONS, tenant.suspensionReason)}</Field>
          )}
          {tenant.suspendedAt === null ? null : (
            <Field label={S.suspendedAt}>
              <DateTime value={tenant.suspendedAt} />
            </Field>
          )}
          {tenant.billingNotice === null ? null : (
            <Field label={S.billingNotice}>{labelOf(BILLING_NOTICES, tenant.billingNotice)}</Field>
          )}
          <Field label={S.plan}>
            <Mono>{tenant.planCode}</Mono>
          </Field>
          <Field label={S.defaultCurrency}>{tenant.defaultCurrency}</Field>
          <Field label={S.country}>
            <Text value={tenant.countryCode} />
          </Field>
          <Field label={S.timeZone}>{tenant.timeZone}</Field>
          <Field label={S.supportEmail}>
            <Text value={tenant.supportEmail} />
          </Field>
          <Field label={S.storefrontEnvironment}>{labelOf(ENVIRONMENTS, tenant.storefrontEnvironment)}</Field>
          <Field label={S.primaryHost}>
            <Mono>{tenant.primaryHost}</Mono>
          </Field>
          <Field label={S.schemaVersion}>
            {tenant.schemaVersion === null ? <Muted>{S.notYet}</Muted> : <Mono>{tenant.schemaVersion}</Mono>}
          </Field>
          <Field label={S.created}>
            <DateTime value={tenant.createdAt} />
          </Field>
          <Field label={S.activated}>
            <When value={tenant.activatedAt} />
          </Field>
          <Field label={S.liveSince}>
            <When value={tenant.liveEnabledAt} />
          </Field>
          <Field label={S.version}>{tenant.version}</Field>
        </Fields>
      </Panel>
      <Panel id="tenant-notes" title={S.notesTitle}>
        <p className="text-sm text-muted-foreground">{S.notesHint}</p>
        {tenant.notes === null || tenant.notes === "" ? (
          <p className="text-sm text-muted-foreground">{S.noNotes}</p>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{tenant.notes}</p>
        )}
      </Panel>
    </div>
  );
}

// ---- Members and invitations --------------------------------------------------------------------------------------

function MembersPanel({
  members,
  invitations,
}: {
  readonly members: readonly Member[];
  readonly invitations: readonly Invitation[];
}) {
  return (
    <div className="grid gap-6">
      <Panel id="tenant-members" title={S.membersTitle}>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{S.membersEmpty}</p>
        ) : (
          <Table>
            <TableCaption className="sr-only">{S.membersCaption}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{S.memberName}</TableHead>
                <TableHead scope="col">{S.memberEmail}</TableHead>
                <TableHead scope="col">{S.memberRole}</TableHead>
                <TableHead scope="col">{S.memberStatus}</TableHead>
                <TableHead scope="col">{S.memberMfa}</TableHead>
                <TableHead scope="col">{S.memberJoined}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>
                    <Link href={`/accounts/${encodeURIComponent(member.accountId)}`} className={LINK_CLASS}>
                      {member.fullName}
                    </Link>
                  </TableCell>
                  <TableCell className="break-all">{member.email}</TableCell>
                  <TableCell>{labelOf(ROLES, member.role)}</TableCell>
                  <TableCell>
                    <StatusBadge kind="membership" status={member.status} />
                  </TableCell>
                  <TableCell>{member.mfaEnabled ? S.mfaOn : S.mfaOff}</TableCell>
                  <TableCell>
                    <DateTime value={member.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
      <Panel id="tenant-invitations" title={S.invitationsTitle}>
        {invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{S.invitationsEmpty}</p>
        ) : (
          <Table>
            <TableCaption className="sr-only">{S.invitationsCaption}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{S.invitationEmail}</TableHead>
                <TableHead scope="col">{S.invitationRole}</TableHead>
                <TableHead scope="col">{S.invitationStatus}</TableHead>
                <TableHead scope="col">{S.invitedBy}</TableHead>
                <TableHead scope="col">{S.invitationSent}</TableHead>
                <TableHead scope="col">{S.invitationExpires}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell className="break-all">{invitation.email}</TableCell>
                  <TableCell>{labelOf(ROLES, invitation.role)}</TableCell>
                  <TableCell>
                    <StatusBadge kind="invitation" status={invitation.status} />
                  </TableCell>
                  <TableCell>
                    {invitation.invitedBy === null ? (
                      <Muted>{S.inviterRemoved}</Muted>
                    ) : (
                      <Link
                        href={`/accounts/${encodeURIComponent(invitation.invitedBy.accountId)}`}
                        className={LINK_CLASS}
                      >
                        {invitation.invitedBy.fullName}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>
                    <DateTime value={invitation.createdAt} />
                  </TableCell>
                  <TableCell>
                    <DateTime value={invitation.expiresAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}

// ---- Subscription and invoices ------------------------------------------------------------------------------------

function SubscriptionPanel({ subscription }: { readonly subscription: Subscription | null }) {
  if (subscription === null) {
    return (
      <Panel id="tenant-subscription" title={S.subscriptionTitle}>
        <p className="text-sm text-muted-foreground">{S.noSubscription}</p>
      </Panel>
    );
  }
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel id="tenant-subscription" title={S.subscriptionTitle}>
        <Fields>
          <Field label={S.subscriptionPlan}>
            {subscription.planName} <Mono>{subscription.planCode}</Mono>
          </Field>
          <Field label={S.subscriptionStatus}>
            <StatusBadge kind="subscription" status={subscription.status} />
          </Field>
          <Field label={S.billingProvider}>{labelOf(PROVIDERS, subscription.billingProvider)}</Field>
          <Field label={S.billingInterval}>{labelOf(INTERVALS, subscription.billingInterval)}</Field>
          <Field label={S.trialEnds}>
            <When value={subscription.trialEndsAt} empty={S.none} />
          </Field>
          <Field label={S.periodEnds}>
            <When value={subscription.currentPeriodEnd} empty={S.none} />
          </Field>
          <Field label={S.cancelAtPeriodEnd}>
            <YesNo value={subscription.cancelAtPeriodEnd} />
          </Field>
          <Field label={S.banner}>
            {subscription.banner === null ? <Muted>{S.none}</Muted> : labelOf(BANNERS, subscription.banner)}
          </Field>
          <Field label={S.subscriptionId}>
            <Mono>{subscription.id}</Mono>
          </Field>
        </Fields>
      </Panel>
      <Panel id="tenant-invoices" title={S.invoicesTitle}>
        <p className="text-sm text-muted-foreground">{S.invoicesIntro}</p>
        <p className="text-sm">
          <Link href={`/subscriptions/${encodeURIComponent(subscription.id)}`} className={LINK_CLASS}>
            {S.invoicesLink}
          </Link>
        </p>
      </Panel>
    </div>
  );
}

// ---- Connections (masked) -----------------------------------------------------------------------------------------

function Submission({ submission }: { readonly submission: PendingSubmission | null }) {
  if (submission === null) {
    return <Muted>{S.none}</Muted>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <StatusBadge kind="credentialSubmission" status={submission.status} />
      {submission.errorCode === null ? null : <Mono>{submission.errorCode}</Mono>}
    </span>
  );
}

function OfficeId({ value }: { readonly value: string | null }) {
  return value === null ? <Muted>{S.notSet}</Muted> : <Mono>{value}</Mono>;
}

function AmadeusConnectionCard({ connection }: { readonly connection: AmadeusConnection }) {
  const environment = labelOf(ENVIRONMENTS, connection.environment);
  return (
    <Panel id={`connection-${connection.id}`} title={S.connectionTitle(S.amadeusTitle, environment)}>
      <Fields>
        <Field label={S.connectionStatus}>
          <StatusBadge kind="amadeusConnection" status={connection.status} />
        </Field>
        <Field label={S.credentialSource}>{labelOf(CREDENTIAL_SOURCES, connection.credentialSource)}</Field>
        <Field label={S.offices}>
          {connection.officeIds.length === 0 ? (
            <Muted>{S.none}</Muted>
          ) : (
            <Mono>{connection.officeIds.join(", ")}</Mono>
          )}
        </Field>
        <Field label={S.defaultOffice}>
          <OfficeId value={connection.defaultOfficeId} />
        </Field>
        <Field label={S.queuingOffice}>
          <OfficeId value={connection.queuingOfficeId} />
        </Field>
        <Field label={S.ownerOffice}>
          <OfficeId value={connection.ownerOfficeId} />
        </Field>
        <Field label={S.clientId}>
          <Masked label={S.clientId} value={connection.clientId} />
        </Field>
        <Field label={S.lastVerified}>
          <When value={connection.lastVerifiedAt} />
        </Field>
        <Field label={S.lastError}>
          <Text value={connection.lastError} empty={S.none} />
        </Field>
        <Field label={S.pendingSubmission}>
          <Submission submission={connection.pendingSubmission} />
        </Field>
        <Field label={S.connectionId}>
          <Mono>{connection.id}</Mono>
        </Field>
      </Fields>
    </Panel>
  );
}

function PaymentConnectionCard({ connection }: { readonly connection: PaymentConnection }) {
  const environment = labelOf(ENVIRONMENTS, connection.environment);
  const provider = labelOf(PAYMENT_PROVIDERS, connection.provider);
  const { chargesEnabled, payoutsEnabled, detailsSubmitted } = connection.capabilities;
  return (
    <Panel id={`connection-${connection.id}`} title={S.connectionTitle(provider, environment)}>
      <Fields>
        <Field label={S.connectionStatus}>
          <StatusBadge kind="paymentConnection" status={connection.status} />
        </Field>
        <Field label={S.accountMode}>{labelOf(ACCOUNT_MODES, connection.accountMode)}</Field>
        <Field label={S.accountReference}>
          <Masked label={S.accountReference} value={connection.accountReference} />
        </Field>
        <Field label={S.publishableKey}>
          <Masked label={S.publishableKey} value={connection.publishableKey} />
        </Field>
        <Field label={S.statementDescriptor}>
          <Text value={connection.statementDescriptorSuffix} />
        </Field>
        {chargesEnabled === undefined ? null : (
          <Field label={S.chargesEnabled}>
            <YesNo value={chargesEnabled} />
          </Field>
        )}
        {payoutsEnabled === undefined ? null : (
          <Field label={S.payoutsEnabled}>
            <YesNo value={payoutsEnabled} />
          </Field>
        )}
        {detailsSubmitted === undefined ? null : (
          <Field label={S.detailsSubmitted}>
            <YesNo value={detailsSubmitted} />
          </Field>
        )}
        {connection.connectedAt === null ? null : (
          <Field label={S.connectedAt}>
            <DateTime value={connection.connectedAt} />
          </Field>
        )}
        {connection.disconnectedAt === null ? null : (
          <Field label={S.disconnectedAt}>
            <DateTime value={connection.disconnectedAt} />
          </Field>
        )}
        <Field label={S.pendingSubmission}>
          <Submission submission={connection.pendingSubmission} />
        </Field>
        <Field label={S.connectionId}>
          <Mono>{connection.id}</Mono>
        </Field>
      </Fields>
    </Panel>
  );
}

function ConnectionsPanel({
  amadeus,
  payments,
}: {
  readonly amadeus: readonly AmadeusConnection[];
  readonly payments: readonly PaymentConnection[];
}) {
  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground">{S.connectionsIntro}</p>
      <div className="grid gap-6 lg:grid-cols-2">
        {amadeus.length === 0 ? (
          <Panel id="tenant-amadeus" title={S.amadeusTitle}>
            <p className="text-sm text-muted-foreground">{S.amadeusEmpty}</p>
          </Panel>
        ) : (
          amadeus.map((connection) => <AmadeusConnectionCard key={connection.id} connection={connection} />)
        )}
        {payments.length === 0 ? (
          <Panel id="tenant-payments" title={S.paymentsTitle}>
            <p className="text-sm text-muted-foreground">{S.paymentsEmpty}</p>
          </Panel>
        ) : (
          payments.map((connection) => <PaymentConnectionCard key={connection.id} connection={connection} />)
        )}
      </div>
    </div>
  );
}

// ---- Domains ------------------------------------------------------------------------------------------------------

function DomainsPanel({ domains }: { readonly domains: readonly Domain[] }) {
  if (domains.length === 0) {
    return <p className="text-sm text-muted-foreground">{S.domainsEmpty}</p>;
  }
  return (
    <Table>
      <TableCaption className="sr-only">{S.domainsCaption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{S.hostname}</TableHead>
          <TableHead scope="col">{S.domainKind}</TableHead>
          <TableHead scope="col">{S.domainPurpose}</TableHead>
          <TableHead scope="col">{S.primary}</TableHead>
          <TableHead scope="col">{S.verification}</TableHead>
          <TableHead scope="col">{S.tls}</TableHead>
          <TableHead scope="col">{S.tlsExpires}</TableHead>
          <TableHead scope="col">{S.lastChecked}</TableHead>
          <TableHead scope="col">{S.lastCheckError}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {domains.map((domain) => (
          <TableRow key={domain.id}>
            <TableCell>
              <Mono>{domain.hostname}</Mono>
            </TableCell>
            <TableCell>{labelOf(DOMAIN_KINDS, domain.kind)}</TableCell>
            <TableCell>{labelOf(DOMAIN_PURPOSES, domain.purpose)}</TableCell>
            <TableCell>
              <YesNo value={domain.isPrimary} />
            </TableCell>
            <TableCell>
              <StatusBadge kind="domain" status={domain.verificationStatus} />
            </TableCell>
            <TableCell>
              <StatusBadge kind="tls" status={domain.tlsStatus} />
            </TableCell>
            <TableCell>
              <When value={domain.tlsExpiresAt} empty={S.none} />
            </TableCell>
            <TableCell>
              <When value={domain.lastCheckedAt} />
            </TableCell>
            <TableCell className="whitespace-normal">
              <Text value={domain.lastCheckError} empty={S.none} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---- Provisioning jobs --------------------------------------------------------------------------------------------

function JobsPanel({ tenantId, jobs }: { readonly tenantId: string; readonly jobs: readonly Job[] }) {
  return (
    <div className="grid gap-4">
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{S.jobsEmpty}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{S.jobsCaption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{S.job}</TableHead>
              <TableHead scope="col">{S.jobKind}</TableHead>
              <TableHead scope="col">{S.jobStatus}</TableHead>
              <TableHead scope="col">{S.jobStep}</TableHead>
              <TableHead scope="col">{S.jobAttempts}</TableHead>
              <TableHead scope="col">{S.jobError}</TableHead>
              <TableHead scope="col">{S.jobScheduled}</TableHead>
              <TableHead scope="col">{S.jobStarted}</TableHead>
              <TableHead scope="col">{S.jobFinished}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  <Link href={`/provisioning-jobs/${encodeURIComponent(job.id)}`} className={LINK_CLASS}>
                    <Mono>{job.id}</Mono>
                  </Link>
                </TableCell>
                <TableCell>{labelOf(JOB_KINDS, job.kind)}</TableCell>
                <TableCell>
                  <StatusBadge kind="job" status={job.status} />
                </TableCell>
                <TableCell>
                  {job.step === null ? <Muted>{S.notYet}</Muted> : <Mono>{job.step}</Mono>}
                </TableCell>
                <TableCell className="tabular-nums">{S.attemptsOf(job.attempt, job.maxAttempts)}</TableCell>
                <TableCell className="whitespace-normal">
                  <Text value={job.error} empty={S.none} />
                </TableCell>
                <TableCell>
                  <DateTime value={job.scheduledAt} />
                </TableCell>
                <TableCell>
                  <When value={job.startedAt} />
                </TableCell>
                <TableCell>
                  <When value={job.finishedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-sm">
        <Link
          href={`/provisioning-jobs?${new URLSearchParams({ tenantId }).toString()}`}
          className={LINK_CLASS}
        >
          {S.allJobs}
        </Link>
      </p>
    </div>
  );
}

// ---- Audit --------------------------------------------------------------------------------------------------------

function AuditPanel({ tenantId, rows }: { readonly tenantId: string; readonly rows: readonly AuditEntry[] }) {
  return (
    <div className="grid gap-4">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{S.auditEmpty}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{S.auditCaption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{S.auditWhen}</TableHead>
              <TableHead scope="col">{S.auditActor}</TableHead>
              <TableHead scope="col">{S.auditAction}</TableHead>
              <TableHead scope="col">{S.auditTarget}</TableHead>
              <TableHead scope="col">{S.auditRequest}</TableHead>
              <TableHead scope="col">{S.auditIp}</TableHead>
              <TableHead scope="col">{S.auditDetails}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="align-top">
                <TableCell>
                  <DateTime value={row.createdAt} />
                </TableCell>
                <TableCell>
                  <span className="grid gap-0.5">
                    <span>{labelOf(ACTORS, row.actorType)}</span>
                    {row.actorLabel === null ? null : (
                      <span className="text-xs break-all text-muted-foreground">{row.actorLabel}</span>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <Mono>{row.action}</Mono>
                </TableCell>
                <TableCell>
                  {row.targetType === null && row.targetId === null ? (
                    <Muted>{S.none}</Muted>
                  ) : (
                    <Mono>{[row.targetType, row.targetId].filter((part) => part !== null).join(" ")}</Mono>
                  )}
                </TableCell>
                <TableCell>
                  {row.requestId === null ? <Muted>{S.none}</Muted> : <Mono>{row.requestId}</Mono>}
                </TableCell>
                <TableCell>
                  {row.ipAddress === null ? <Muted>{S.none}</Muted> : <Mono>{row.ipAddress}</Mono>}
                </TableCell>
                <TableCell className="min-w-64 whitespace-normal">
                  <JsonView value={row.details} label={S.auditDetailsOf(row.id)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-sm">
        <Link href={`/audit?${new URLSearchParams({ tenantId }).toString()}`} className={LINK_CLASS}>
          {S.fullAudit}
        </Link>
      </p>
    </div>
  );
}

// ---- The page -----------------------------------------------------------------------------------------------------

/**
 * The tabs of the detail page, each panel rendered here on the server from the fields it shows. Only that rendered
 * output goes to the client component of the tabs, never the API answer, so a property the page does not show
 * (whatever the API might answer one day) never reaches the browser.
 */
function tabsOf(detail: TenantDetail): TenantTab[] {
  const { tenant } = detail;
  return [
    { id: "overview", content: <OverviewPanel tenant={tenant} /> },
    { id: "members", content: <MembersPanel members={detail.members} invitations={detail.invitations} /> },
    { id: "subscription", content: <SubscriptionPanel subscription={detail.subscription} /> },
    {
      id: "connections",
      content: <ConnectionsPanel amadeus={detail.amadeusConnections} payments={detail.paymentConnections} />,
    },
    { id: "domains", content: <DomainsPanel domains={detail.domains} /> },
    { id: "jobs", content: <JobsPanel tenantId={tenant.id} jobs={detail.recentJobs} /> },
    { id: "audit", content: <AuditPanel tenantId={tenant.id} rows={detail.recentAudit} /> },
  ];
}

function BackLink() {
  return (
    <Link href="/tenants" className="text-sm font-medium underline underline-offset-4">
      {S.backToList}
    </Link>
  );
}

/**
 * `/tenants/[tenantId]` (README §2, PF-81): the control-plane view of one OTA from `adminGetTenant`, in tabs:
 * overview (with the internal notes), members and invitations, subscription and invoices, connections (masked:
 * Stripe account, publishable key and client id show their prefix and last four characters only), domains, the
 * last 20 tenant jobs and the last 50 audit rows. The API answers no secret, ciphertext, hash or token, and the page
 * renders only the fields it names. An id that is no tenant id, and an unknown one, render the not-found page. The
 * actions (suspend, resume, migrate, connections, notes, assign an office) arrive with PAD-005.
 */
export default async function TenantDetailPage({
  params,
}: Readonly<{ params: Promise<{ tenantId: string }> }>) {
  const { tenantId } = await params;
  if (!TENANT_ID.test(tenantId)) {
    notFound();
  }
  const api = await platformApi();
  const result = await api.GET("/v1/admin/tenants/{tenantId}", { params: { path: { tenantId } } });
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
  const detail = result.data;
  const { tenant } = detail;
  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <BackLink />
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{tenant.name}</h1>
          <StatusBadge kind="tenant" status={tenant.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{tenant.key}</span> ·{" "}
          <span className="font-mono">{tenant.primaryHost}</span>
        </p>
      </div>
      <TenantTabs tabs={tabsOf(detail)} />
    </div>
  );
}
