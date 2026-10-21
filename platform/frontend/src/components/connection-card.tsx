import type { components } from "@velexis/api-types/platform";
import type { ReactNode } from "react";

import { DateTime } from "@/components/date-time";
import { StatusBadge, type StatusKind, type StatusOf } from "@/components/status-badge";
import { CONNECTION_STRINGS, STATUS_LABELS } from "@/lib/strings";

type Schemas = components["schemas"];
/** The Amadeus connection of one environment, as `listAmadeusConnections` answers it (no secret, no ciphertext). */
export type AmadeusConnection = Schemas["AmadeusConnection"];
/** The Stripe connection of one environment, as `listPaymentConnections` answers it (no secret, no ciphertext). */
export type PaymentConnection = Schemas["PaymentConnection"];
type Environment = Schemas["Environment"];
type PendingSubmission = Schemas["PendingCredentialSubmission"];

/** The order of the cards: test first, then live. */
const ENVIRONMENT_ORDER: Readonly<Record<Environment, number>> = { test: 0, live: 1 };

/** `connections` with the test environment first, then live (an environment the portal does not know goes last). */
export function byEnvironment<Connection extends { readonly environment: Environment }>(
  connections: readonly Connection[],
): Connection[] {
  const rank = (connection: Connection) =>
    Object.hasOwn(ENVIRONMENT_ORDER, connection.environment) ? ENVIRONMENT_ORDER[connection.environment] : 2;
  return [...connections].sort((left, right) => rank(left) - rank(right));
}

/** A status in lower-case words for the summary sentence ("active", "pending", "invalid credentials"). */
function statusWords<Kind extends StatusKind>(kind: Kind, status: StatusOf<Kind>): string {
  const labels: Readonly<Record<string, string>> = STATUS_LABELS[kind];
  // A status the portal does not know yet (a newer API) still reads, in its raw form.
  return (
    Object.hasOwn(labels, status) ? (labels[status] ?? status) : status.replaceAll("_", " ")
  ).toLowerCase();
}

/**
 * The one-line summary of an Amadeus connection: whose account, its offices and its status, as the Amadeus page of
 * flows/amadeus-connection.md §B shows it ("Velexis test account, office NCE1A0955, active").
 */
export function amadeusSummary(connection: AmadeusConnection): string {
  return CONNECTION_STRINGS.summary([
    CONNECTION_STRINGS.amadeusAccount(connection.credentialSource, connection.environment),
    CONNECTION_STRINGS.amadeusOffices(connection.officeIds),
    statusWords("amadeusConnection", connection.status),
  ]);
}

/**
 * The one-line summary of a payment connection: whose Stripe account, the environment and the status, as
 * flows/stripe-payments-account.md §A has it ("Velexis Stripe account, test, active").
 */
export function paymentSummary(connection: PaymentConnection): string {
  return CONNECTION_STRINGS.summary([
    CONNECTION_STRINGS.paymentAccount[connection.accountMode] ?? connection.accountMode,
    CONNECTION_STRINGS.environment(connection.environment),
    statusWords("paymentConnection", connection.status),
  ]);
}

/** What a member should know about an Amadeus connection that is not active, or nothing. */
function amadeusNotice(connection: AmadeusConnection): { readonly id: string; readonly text: string } | null {
  switch (connection.status) {
    case "pending_verification":
      // A Velexis connection is pending while it has no office: provisioning found the pool empty (PF-50 AC2), or a
      // live office is still to be assigned (M5); the OTA's own credentials are pending while they are verified.
      return connection.credentialSource === "velexis"
        ? { id: "pending-office", text: CONNECTION_STRINGS.pendingOffice }
        : { id: "pending-credentials", text: CONNECTION_STRINGS.pendingCredentials };
    case "invalid_credentials":
      return { id: "invalid-credentials", text: CONNECTION_STRINGS.amadeusInvalid };
    case "disabled":
      return { id: "disabled", text: CONNECTION_STRINGS.amadeusDisabled };
    case "active":
      return null;
    default:
      // A status the portal does not know yet (a newer API): the badge shows it, without a notice.
      return null;
  }
}

/** What a member should know about a payment connection that is not active, or nothing. */
function paymentNotice(connection: PaymentConnection): { readonly id: string; readonly text: string } | null {
  switch (connection.status) {
    case "pending":
      return { id: "pending", text: CONNECTION_STRINGS.paymentPending };
    case "disabled":
      return { id: "disabled", text: CONNECTION_STRINGS.paymentDisabled };
    case "error":
      return { id: "error", text: CONNECTION_STRINGS.paymentError };
    case "active":
      return null;
    default:
      // A status the portal does not know yet (a newer API): the badge shows it, without a notice.
      return null;
  }
}

/** One term and its value of the card's details. */
interface Detail {
  readonly id: string;
  readonly term: string;
  readonly value: ReactNode;
}

function Details({ details }: { readonly details: readonly Detail[] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
      {details.map((detail) => (
        <div key={detail.id} className="contents" data-detail={detail.id}>
          <dt className="text-muted-foreground">{detail.term}</dt>
          <dd className="min-w-0 break-all">{detail.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The latest submission of the OTA's own credentials or keys (M5), while it is open or after it failed. */
function Submission({ submission }: { readonly submission: PendingSubmission }) {
  return (
    <div className="grid gap-2 rounded-lg border px-4 py-3 text-sm" data-submission={submission.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{CONNECTION_STRINGS.submissionTitle}</span>
        <StatusBadge kind="credentialSubmission" status={submission.status} />
      </div>
      {/* The error code gets its own words with the M5 forms (PFE-023, PFE-024); it is never shown raw. */}
      <p>
        {submission.status === "failed"
          ? CONNECTION_STRINGS.submissionFailed
          : CONNECTION_STRINGS.submissionOpen}
      </p>
    </div>
  );
}

/** The frame of a card: the environment as its heading, the status badge, the summary, a notice and the details. */
function Card({
  kind,
  environment,
  badge,
  summary,
  notice,
  notes,
  details,
  submission,
}: {
  readonly kind: "amadeus" | "payment";
  readonly environment: Environment;
  readonly badge: ReactNode;
  readonly summary: string;
  readonly notice: { readonly id: string; readonly text: string } | null;
  readonly notes: readonly string[];
  readonly details: readonly Detail[];
  readonly submission: PendingSubmission | null;
}) {
  const headingId = `${kind}-connection-${environment}`;
  return (
    <section
      aria-labelledby={headingId}
      data-connection={kind}
      data-environment={environment}
      className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-lg font-semibold tracking-tight">
          {CONNECTION_STRINGS.title(environment)}
        </h2>
        {badge}
      </div>
      <p className="font-medium" data-summary="">
        {summary}
      </p>
      {notice === null ? null : (
        <p className="rounded-lg border px-4 py-3 text-sm" data-notice={notice.id}>
          {notice.text}
        </p>
      )}
      {notes.map((note) => (
        <p key={note} className="text-sm text-muted-foreground">
          {note}
        </p>
      ))}
      <Details details={details} />
      {submission === null ? null : <Submission submission={submission} />}
    </section>
  );
}

function office(officeId: string | null): ReactNode {
  return officeId ?? <span className="text-muted-foreground">{CONNECTION_STRINGS.officeNotSet}</span>;
}

function yesNo(value: boolean | undefined): string {
  return value === true ? CONNECTION_STRINGS.yes : CONNECTION_STRINGS.no;
}

function AmadeusCard({
  connection,
  timeZone,
}: {
  readonly connection: AmadeusConnection;
  readonly timeZone: string;
}) {
  const details: Detail[] = [
    {
      id: "account",
      term: CONNECTION_STRINGS.account,
      value: CONNECTION_STRINGS.amadeusAccount(connection.credentialSource, connection.environment),
    },
  ];
  if (connection.clientId !== null) {
    // The client id of the OTA's own credentials is not a secret (the secret is never answered).
    details.push({ id: "clientId", term: CONNECTION_STRINGS.clientId, value: connection.clientId });
  }
  details.push(
    {
      id: "offices",
      term: CONNECTION_STRINGS.offices,
      value:
        connection.officeIds.length === 0 ? (
          <span className="text-muted-foreground">{CONNECTION_STRINGS.officesNone}</span>
        ) : (
          connection.officeIds.join(", ")
        ),
    },
    {
      id: "defaultOffice",
      term: CONNECTION_STRINGS.defaultOffice,
      value: office(connection.defaultOfficeId),
    },
    {
      id: "queuingOffice",
      term: CONNECTION_STRINGS.queuingOffice,
      value: office(connection.queuingOfficeId),
    },
    { id: "ownerOffice", term: CONNECTION_STRINGS.ownerOffice, value: office(connection.ownerOfficeId) },
  );
  if (connection.lastVerifiedAt !== null) {
    details.push({
      id: "lastVerifiedAt",
      term: CONNECTION_STRINGS.lastVerified,
      value: <DateTime value={connection.lastVerifiedAt} timeZone={timeZone} />,
    });
  }
  return (
    <Card
      kind="amadeus"
      environment={connection.environment}
      badge={<StatusBadge kind="amadeusConnection" status={connection.status} />}
      summary={amadeusSummary(connection)}
      notice={amadeusNotice(connection)}
      notes={[]}
      details={details}
      submission={connection.pendingSubmission}
    />
  );
}

function PaymentCard({
  connection,
  timeZone,
}: {
  readonly connection: PaymentConnection;
  readonly timeZone: string;
}) {
  const details: Detail[] = [
    {
      id: "account",
      term: CONNECTION_STRINGS.account,
      value: CONNECTION_STRINGS.paymentAccount[connection.accountMode] ?? connection.accountMode,
    },
  ];
  if (connection.accountReference !== null) {
    details.push({
      id: "accountReference",
      term: CONNECTION_STRINGS.stripeAccount,
      value: connection.accountReference,
    });
  }
  if (connection.publishableKey !== null) {
    // A publishable key is public by design (the storefront's browser uses it); secrets are never answered.
    details.push({
      id: "publishableKey",
      term: CONNECTION_STRINGS.publishableKey,
      value: connection.publishableKey,
    });
  }
  details.push({
    id: "statementDescriptorSuffix",
    term: CONNECTION_STRINGS.descriptor,
    value: connection.statementDescriptorSuffix ?? (
      <span className="text-muted-foreground">{CONNECTION_STRINGS.descriptorNotSet}</span>
    ),
  });
  if (connection.accountMode !== "velexis") {
    // The capabilities of the OTA's own account (Stripe Connect, M5); Velexis's account has none of its own here.
    details.push(
      {
        id: "chargesEnabled",
        term: CONNECTION_STRINGS.chargesEnabled,
        value: yesNo(connection.capabilities.chargesEnabled),
      },
      {
        id: "payoutsEnabled",
        term: CONNECTION_STRINGS.payoutsEnabled,
        value: yesNo(connection.capabilities.payoutsEnabled),
      },
      {
        id: "detailsSubmitted",
        term: CONNECTION_STRINGS.detailsSubmitted,
        value: yesNo(connection.capabilities.detailsSubmitted),
      },
    );
  }
  if (connection.connectedAt !== null) {
    details.push({
      id: "connectedAt",
      term: CONNECTION_STRINGS.connectedAt,
      value: <DateTime value={connection.connectedAt} timeZone={timeZone} />,
    });
  }
  if (connection.disconnectedAt !== null) {
    details.push({
      id: "disconnectedAt",
      term: CONNECTION_STRINGS.disconnectedAt,
      value: <DateTime value={connection.disconnectedAt} timeZone={timeZone} />,
    });
  }
  if (connection.webhookUrl !== null) {
    // Shown as text to copy into Stripe, not as a link.
    details.push({ id: "webhookUrl", term: CONNECTION_STRINGS.webhookUrl, value: connection.webhookUrl });
  }
  const notes = [
    ...(connection.accountMode === "velexis" ? [CONNECTION_STRINGS.velexisMode] : []),
    ...(connection.environment === "test" ? [CONNECTION_STRINGS.testPayments] : []),
  ];
  return (
    <Card
      kind="payment"
      environment={connection.environment}
      badge={<StatusBadge kind="paymentConnection" status={connection.status} />}
      summary={paymentSummary(connection)}
      notice={paymentNotice(connection)}
      notes={notes}
      details={details}
      submission={connection.pendingSubmission}
    />
  );
}

export type ConnectionCardProps =
  | {
      readonly kind: "amadeus";
      readonly connection: AmadeusConnection;
      /** The IANA zone of the dates (the OTA's); UTC when absent. */
      readonly timeZone?: string;
    }
  | {
      readonly kind: "payment";
      readonly connection: PaymentConnection;
      /** The IANA zone of the dates (the OTA's); UTC when absent. */
      readonly timeZone?: string;
    };

/**
 * The Amadeus or Stripe connection of one environment (README §4): the environment as the card's heading, the
 * status in words (`StatusBadge`), a one-line summary ("Velexis test account, office NCE1A0955, active"; "Velexis
 * Stripe account, test, active"), what a connection that is not active means for the OTA, the details the API
 * answers (offices; account mode, statement suffix, capabilities), and the state of a pending submission of the OTA's
 * own credentials (M5). It shows what the list operations answer and nothing more: they never hold a secret. A server
 * component; it holds no state.
 */
export function ConnectionCard(props: ConnectionCardProps) {
  const timeZone = props.timeZone ?? "UTC";
  return props.kind === "amadeus" ? (
    <AmadeusCard connection={props.connection} timeZone={timeZone} />
  ) : (
    <PaymentCard connection={props.connection} timeZone={timeZone} />
  );
}
