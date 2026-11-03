import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DescriptorForm } from "@/app/(app)/otas/[tenantId]/payments/descriptor-form";
import {
  CONNECT_STRIPE_ANCHOR,
  STRIPE_CONNECT_OUTCOME_WORDS,
  stripeConnectOutcomeOf,
  type StripeConnectOutcome,
} from "@/app/(app)/otas/[tenantId]/payments/stripe-connect";
import { ConnectStripeForm, StripeKeysForm } from "@/app/(app)/otas/[tenantId]/payments/stripe-keys-form";
import { UseVelexisDialog } from "@/app/(app)/otas/[tenantId]/payments/use-velexis-dialog";
import { byEnvironment, ConnectionCard, type PaymentConnection } from "@/components/connection-card";
import { NotAllowed } from "@/components/not-allowed";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath, type MilestoneFeatures } from "@/lib/roles";
import {
  DESCRIPTOR_STRINGS,
  PAYMENTS_STRINGS,
  STRIPE_ACCOUNT_STRINGS,
  USE_VELEXIS_STRINGS,
} from "@/lib/strings";
import { requireTenant, type Tenant } from "@/lib/tenant";

export const metadata: Metadata = { title: PAYMENTS_STRINGS.title };

type PaymentConnectionList = components["schemas"]["PaymentConnectionList"];
type Environment = components["schemas"]["Environment"];

const ACCOUNT = STRIPE_ACCOUNT_STRINGS;

/**
 * `listPaymentConnections` (owners, admins and finance members). An ended session goes to sign-in and back to this
 * page, an unverified account to `/verify-pending`, an OTA the caller is no member of (any more) to the not-found
 * page; other failures (a role changed in the meantime, a rate limit, the API down) are returned for the page to show
 * the portal's message.
 */
async function loadConnections(tenantId: string): Promise<ApiResult<PaymentConnectionList>> {
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/payment-connections", {
    params: { path: { tenantId } },
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/payments") }).toString()}`);
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
    if (code === "NOT_FOUND") {
      notFound();
    }
  }
  return result;
}

/** Answers of `getMe` that mean the session is over: sign in again. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/** Every M5 switch off: what the page assumes when `getMe` fails. */
const NO_FEATURES: MilestoneFeatures = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};

/**
 * The milestone switches of PADR-0015 from `getMe` (`features.ownStripe` for Stripe Connect and the OTA's own keys;
 * PFE-024). An ended session goes to sign-in and back to this page, an unverified account to `/verify-pending`; any
 * other failure hides the own account's section, as a switch that is off does, and the rest of the page stays.
 */
async function loadFeatures(tenantId: string): Promise<MilestoneFeatures> {
  const api = await platformApi();
  const me = await api.GET("/v1/me");
  if (me.error === undefined) {
    return me.data.features;
  }
  if (SESSION_ENDED.has(me.error.code)) {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/payments") }).toString()}`);
  }
  if (me.error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
  return NO_FEATURES;
}

/** The environments of the OTA's own keys, in the page's order. */
const ENVIRONMENTS: readonly Environment[] = ["test", "live"];

/** Velexis was disconnected from the OTA's Stripe account in Stripe (`account.application.deauthorized`). */
function isDeauthorized(connection: PaymentConnection): boolean {
  return connection.status === "disabled" && connection.disconnectedAt !== null;
}

/** A platform admin disabled the connection (`adminSetConnectionStatus`: `disabled`, no `disconnectedAt`). */
function isDisabledByVelexis(connection: PaymentConnection): boolean {
  return connection.status === "disabled" && connection.disconnectedAt === null;
}

/**
 * `useVelexisPayments` is the owners' alone (the platform document: owners return the OTA to the Velexis account);
 * scope §1.2 has no row of its own for it, so the page asks for the owner role itself, as the API does.
 */
function mayUseVelexis(tenant: Tenant): boolean {
  return tenant.myRole === "owner";
}

/**
 * What a Velexis-mode card adds for the caller (PFE-016; flows/stripe-payments-account.md §A item 3): owners and admins
 * the statement suffix form, finance members a note that only owners and admins change it (they read the suffix in the
 * card's details). Cards of the OTA's own Stripe account add nothing here: the OTA backend sends no suffix for them.
 */
function descriptorPart(tenant: Tenant, connection: PaymentConnection) {
  if (connection.accountMode !== "velexis") {
    return null;
  }
  if (!can(tenant.myRole, "manageConnections")) {
    return (
      <p className="text-sm text-muted-foreground" data-descriptor-role-note="">
        {DESCRIPTOR_STRINGS.roleNote}
      </p>
    );
  }
  return (
    <DescriptorForm
      tenantId={tenant.id}
      environment={connection.environment}
      version={connection.version}
      suffix={connection.statementDescriptorSuffix}
      tenantStatus={tenant.status}
    />
  );
}

/**
 * What a card adds about the OTA's own Stripe account (PFE-024; flows §C step 5, §E; PF-61 AC2):
 *
 * - a Connect account whose onboarding Stripe has not finished (`pending`) says what to do in Stripe;
 * - a connection Velexis was disconnected from in Stripe (`disabled` with `disconnectedAt`) explains it and offers the
 *   ways on, because nothing falls back to Velexis on its own: "Connect Stripe again" (a link to the section's button,
 *   for owners and admins while `features.ownStripe` is on) and "Use Velexis payments" (owners);
 * - a connection a platform admin disabled says to contact support (no reconnect: the API refuses it);
 * - "Use Velexis payments" for owners on every card of the OTA's own account. For owners the part is rendered in the
 *   same place of every card, so the confirmation of a switch stays in view when the card turns into a Velexis one.
 */
function ownAccountPart(tenant: Tenant, connection: PaymentConnection, features: MilestoneFeatures) {
  const manage = can(tenant.myRole, "manageConnections");
  const pending = connection.accountMode === "connect_standard" && connection.status === "pending";
  const deauthorized = isDeauthorized(connection);
  const byVelexis = isDisabledByVelexis(connection);
  const owner = mayUseVelexis(tenant);
  if (!pending && !deauthorized && !byVelexis && !owner) {
    return null;
  }
  const reconnect = deauthorized && manage && features.ownStripe && tenant.status === "active";
  return (
    <div className="grid gap-3 text-sm empty:hidden" data-own-account={connection.environment}>
      {pending ? (
        <p className="rounded-lg border px-4 py-3" data-own-account-notice="pending">
          {ACCOUNT.connectPending}
        </p>
      ) : null}
      {deauthorized ? (
        <div className="grid gap-2 rounded-lg border px-4 py-3" data-own-account-notice="deauthorized">
          <p className="font-medium">{ACCOUNT.choicesTitle}</p>
          <p>{manage ? ACCOUNT.deauthorized : ACCOUNT.deauthorizedReadOnly}</p>
          {reconnect ? (
            <p>
              <a href={`#${CONNECT_STRIPE_ANCHOR}`} className="font-medium underline underline-offset-4">
                {ACCOUNT.reconnectLink}
              </a>
            </p>
          ) : null}
          {manage && !owner ? <p className="text-muted-foreground">{USE_VELEXIS_STRINGS.ownerOnly}</p> : null}
        </div>
      ) : null}
      {byVelexis ? (
        <p className="rounded-lg border px-4 py-3" data-own-account-notice="disabled-by-velexis">
          {ACCOUNT.disabledByVelexis}
        </p>
      ) : null}
      {owner ? (
        <UseVelexisDialog
          tenantId={tenant.id}
          environment={connection.environment}
          accountMode={connection.accountMode}
          tenantStatus={tenant.status}
        />
      ) : null}
    </div>
  );
}

/** The outcome of a Stripe Connect callback (`?stripeConnect=`), in the portal's words. */
function ConnectOutcomeNotice({ outcome }: { readonly outcome: StripeConnectOutcome }) {
  const words = STRIPE_CONNECT_OUTCOME_WORDS[outcome];
  const problem = words.tone === "error";
  return (
    <Alert
      variant={problem ? "destructive" : "default"}
      // A problem is an alert; a connection that went through, or was declined, a status message.
      role={problem ? "alert" : "status"}
      data-stripe-connect-outcome={outcome}
    >
      <AlertTitle>{words.title}</AlertTitle>
      <AlertDescription>{words.text}</AlertDescription>
    </Alert>
  );
}

/**
 * The OTA's own Stripe account (PFE-024; flows §C and §D; PF-61, PF-62), while `features.ownStripe` is on: "Connect
 * with Stripe" (one OAuth for both environments) and the own keys of each environment, for owners and admins; finance
 * members read that only owners and admins connect one. While the OTA is not `active`, or a platform admin disabled one
 * of its payment connections (the callback would refuse the connection), "Connect with Stripe" says why instead.
 */
function OwnStripeSection({
  tenant,
  connections,
}: {
  readonly tenant: Tenant;
  readonly connections: readonly PaymentConnection[];
}) {
  const titleId = "own-stripe-title";
  const connectTitleId = "connect-stripe-title";
  const manage = can(tenant.myRole, "manageConnections");
  const blocked =
    tenant.status !== "active"
      ? ACCOUNT.readOnly[tenant.status]
      : connections.some(isDisabledByVelexis)
        ? ACCOUNT.connectDisabledByVelexis
        : null;
  const reconnect = connections.some(
    (connection) => connection.accountMode === "connect_standard" && isDeauthorized(connection),
  );
  return (
    <section
      aria-labelledby={titleId}
      data-own-stripe=""
      className="grid content-start gap-5 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="grid gap-1">
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {ACCOUNT.title}
        </h2>
        <p className="text-sm text-muted-foreground">{ACCOUNT.intro}</p>
      </div>
      {!manage ? (
        <p className="text-sm text-muted-foreground" data-own-stripe-role-note="">
          {ACCOUNT.roleNote}
        </p>
      ) : (
        <>
          <div
            id={CONNECT_STRIPE_ANCHOR}
            role="group"
            aria-labelledby={connectTitleId}
            className="grid gap-3 rounded-lg border p-4"
            data-connect-stripe=""
          >
            <h3 id={connectTitleId} className="font-semibold tracking-tight">
              {ACCOUNT.connectTitle}
            </h3>
            <p className="text-sm text-muted-foreground">{ACCOUNT.connectIntro}</p>
            {blocked !== null ? (
              <Alert>
                <AlertTitle>{ACCOUNT.readOnlyTitle}</AlertTitle>
                <AlertDescription>{blocked}</AlertDescription>
              </Alert>
            ) : (
              <ConnectStripeForm tenantId={tenant.id} reconnect={reconnect} />
            )}
          </div>
          {ENVIRONMENTS.map((environment) => (
            <StripeKeysForm
              key={environment}
              tenantId={tenant.id}
              environment={environment}
              tenantStatus={tenant.status}
              connection={connections.find((connection) => connection.environment === environment) ?? null}
            />
          ))}
        </>
      )}
    </section>
  );
}

/**
 * `/otas/[tenantId]/payments` (README §2 Signed in; flows/stripe-payments-account.md §A, §C to §E; PF-60 to PF-62): the
 * OTA's Stripe connections for owners, admins and finance members: one `ConnectionCard` per environment, test first
 * ("Velexis Stripe account, test, active"), with the account mode, the status, the card statement suffix and, for the
 * OTA's own account (M5), its capabilities. On each Velexis-mode card owners and admins change the suffix
 * (`DescriptorForm`, PFE-016); a card of the OTA's own account explains an unfinished Stripe onboarding or a
 * disconnection with the ways on, and owners return it to Velexis payments (`UseVelexisDialog`, PFE-024). While
 * `features.ownStripe` is on, owners and admins connect their own Stripe account or enter its keys
 * (`OwnStripeSection`). After Stripe's Connect page the callback comes back here with `?stripeConnect=<outcome>`, which
 * the page says in its own words. The tenant comes from the layout's `getTenant` (the same request's cached answer);
 * another role gets the not-allowed page without a call. The connections (`listPaymentConnections`) and the M5 switches
 * (`getMe`) are read side by side. Payout account and settlements are PFE-025's pages.
 */
export default async function PaymentsPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ tenantId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { tenantId } = await params;
  const loaded = await requireTenant(tenantId);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  if (!can(tenant.myRole, "viewConnections")) {
    return <NotAllowed tenantId={tenant.id} role={tenant.myRole} />;
  }
  const [connections, features, query] = await Promise.all([
    loadConnections(tenant.id),
    loadFeatures(tenant.id),
    searchParams ?? Promise.resolve({}),
  ]);
  const outcome = stripeConnectOutcomeOf(query);
  const ordered = connections.error === undefined ? byEnvironment(connections.data.data) : [];

  return (
    <div className="mx-auto grid max-w-4xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{PAYMENTS_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAYMENTS_STRINGS.intro}</p>
      </div>
      {outcome === undefined ? null : <ConnectOutcomeNotice outcome={outcome} />}
      {connections.error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>{PAYMENTS_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(connections.error)}</AlertDescription>
        </Alert>
      ) : ordered.length === 0 ? (
        <p className="text-muted-foreground">{PAYMENTS_STRINGS.empty}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {ordered.map((connection) => (
            <ConnectionCard
              key={connection.id}
              kind="payment"
              connection={connection}
              timeZone={tenant.timeZone}
            >
              {ownAccountPart(tenant, connection, features)}
              {descriptorPart(tenant, connection)}
            </ConnectionCard>
          ))}
        </div>
      )}
      {/* Without the connections the page cannot tell what the OTA has: the section waits for a page that has them. */}
      {features.ownStripe && connections.error === undefined ? (
        <OwnStripeSection tenant={tenant} connections={ordered} />
      ) : null}
    </div>
  );
}
