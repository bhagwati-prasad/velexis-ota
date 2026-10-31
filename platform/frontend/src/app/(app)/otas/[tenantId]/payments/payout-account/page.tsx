import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import type { PayoutValues } from "@/app/(app)/otas/[tenantId]/payments/payout-account/actions";
import { PayoutForm } from "@/app/(app)/otas/[tenantId]/payments/payout-account/payout-form";
import { DateTime } from "@/components/date-time";
import { DEFAULT_LOCALE } from "@/components/money";
import { NotAllowed } from "@/components/not-allowed";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { COUNTRY_CODES, CURRENCY_CODES, namedOptions } from "@/lib/reference-options";
import { can, otaPath } from "@/lib/roles";
import { PAYOUT_ACCOUNT_STRINGS } from "@/lib/strings";
import { requireTenant, type Tenant } from "@/lib/tenant";

export const metadata: Metadata = { title: PAYOUT_ACCOUNT_STRINGS.title };

type PayoutAccount = components["schemas"]["PayoutAccount"];

/** The OTA's payout account: the masked account, none yet (`404`), or a failure for the page to show. */
type LoadedAccount =
  | { readonly account: PayoutAccount; readonly error?: undefined }
  | { readonly account: null; readonly error?: undefined }
  | { readonly account?: undefined; readonly error: ApiError };

/**
 * `getPayoutAccount` (owners and finance members). The layout's `getTenant` of the same request found the membership,
 * so `NOT_FOUND` here means the OTA has no payout account yet. An ended session goes to sign-in and back to this page,
 * an unverified account to `/verify-pending`; other failures are returned for the page to show the portal's message.
 */
async function loadPayoutAccount(tenantId: string): Promise<LoadedAccount> {
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/payout-account", { params: { path: { tenantId } } });
  if (result.error === undefined) {
    return { account: result.data };
  }
  const { code } = result.error;
  if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
    redirect(
      `/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/payments/payout-account") }).toString()}`,
    );
  }
  if (code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
  return code === "NOT_FOUND" ? { account: null } : { error: result.error };
}

/** A country code in the portal's English ("Norway"), or the code itself when `Intl` has no name for it. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames([DEFAULT_LOCALE], { type: "region", fallback: "code" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The account number as the page shows it: dots and the last 4 characters (`last4`, the only part of a bank number the
 * API ever answers), read by screen readers as "Ending in 7947".
 */
function MaskedNumber({ last4 }: { readonly last4: string }) {
  return (
    <span className="font-mono tracking-wide" data-masked-number="">
      <span className="sr-only">{PAYOUT_ACCOUNT_STRINGS.endingIn}</span>
      <span aria-hidden="true">{PAYOUT_ACCOUNT_STRINGS.maskDots}</span>
      {last4}
    </span>
  );
}

/** The masked account with its review status, what that status means, and the reviewer's note of a rejection. */
function AccountDetails({
  account,
  timeZone,
}: {
  readonly account: PayoutAccount;
  readonly timeZone: string;
}) {
  return (
    <div className="grid gap-4" data-payout-account="">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{PAYOUT_ACCOUNT_STRINGS.holder}</dt>
        <dd className="font-medium break-words">{account.accountHolderName}</dd>
        <dt className="text-muted-foreground">{PAYOUT_ACCOUNT_STRINGS.country}</dt>
        <dd>{countryName(account.countryCode)}</dd>
        <dt className="text-muted-foreground">{PAYOUT_ACCOUNT_STRINGS.currency}</dt>
        <dd>{account.currency}</dd>
        <dt className="text-muted-foreground">{PAYOUT_ACCOUNT_STRINGS.scheme}</dt>
        <dd>{PAYOUT_ACCOUNT_STRINGS.schemes[account.scheme] ?? account.scheme}</dd>
        <dt className="text-muted-foreground">{PAYOUT_ACCOUNT_STRINGS.number}</dt>
        <dd>
          <MaskedNumber last4={account.last4} />
        </dd>
        <dt className="text-muted-foreground">{PAYOUT_ACCOUNT_STRINGS.status}</dt>
        <dd>
          <StatusBadge kind="payoutAccount" status={account.status} />
        </dd>
        <dt className="text-muted-foreground">{PAYOUT_ACCOUNT_STRINGS.updatedAt}</dt>
        <dd>
          <DateTime value={account.updatedAt} timeZone={timeZone} />
        </dd>
      </dl>
      {Object.hasOwn(PAYOUT_ACCOUNT_STRINGS.statusExplanations, account.status) ? (
        <p className="text-sm" data-status-explanation={account.status}>
          {PAYOUT_ACCOUNT_STRINGS.statusExplanations[account.status]}
        </p>
      ) : null}
      {account.status === "rejected" && account.reviewNote !== null ? (
        <Alert variant="destructive" data-review-note="">
          <AlertTitle>{PAYOUT_ACCOUNT_STRINGS.reviewNote}</AlertTitle>
          <AlertDescription className="break-words whitespace-pre-line">
            {account.reviewNote}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * The values the owners' form starts with: the stored account's holder, country, currency and scheme (never a bank
 * number: the API answers none), or for a first account the OTA's country and default currency and an IBAN.
 */
function initialValuesOf(account: PayoutAccount | null, tenant: Tenant): PayoutValues {
  if (account !== null) {
    return {
      accountHolderName: account.accountHolderName,
      countryCode: account.countryCode,
      currency: account.currency,
      scheme: account.scheme,
    };
  }
  return {
    accountHolderName: "",
    countryCode: tenant.countryCode ?? "",
    currency: tenant.defaultCurrency,
    scheme: "iban",
  };
}

/**
 * `/otas/[tenantId]/payments/payout-account` (README §2 Signed in; flows/stripe-payments-account.md §B; PF-64): the
 * bank account Velexis pays the OTA's settlements to, for owners and finance members. The account is shown masked
 * (holder, bank country, currency, account type and the last 4 characters of the number) with its review status, what
 * it means and the reviewer's note of a rejection. Owners get `PayoutForm` below it: saving asks for a step-up and
 * sends the account back to pending review, as the form says. Finance members read the account with a note that only
 * owners change it. The tenant comes from the layout's `getTenant`; another role gets the not-allowed page without a
 * call. A failed `getPayoutAccount` shows the portal's message in place of the account, and the form stays away, so an
 * owner never replaces an account the page could not show.
 */
export default async function PayoutAccountPage({
  params,
}: Readonly<{ params: Promise<{ tenantId: string }> }>) {
  const { tenantId } = await params;
  const loaded = await requireTenant(tenantId);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  if (!can(tenant.myRole, "viewSettlements")) {
    return <NotAllowed tenantId={tenant.id} role={tenant.myRole} />;
  }
  const loadedAccount = await loadPayoutAccount(tenant.id);
  const canEdit = can(tenant.myRole, "setPayoutAccount");

  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{PAYOUT_ACCOUNT_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAYOUT_ACCOUNT_STRINGS.intro}</p>
      </div>

      <section aria-labelledby="payout-current-title" className="grid gap-4 rounded-xl border p-6">
        <h2 id="payout-current-title" className="text-xl font-semibold tracking-tight">
          {PAYOUT_ACCOUNT_STRINGS.currentTitle}
        </h2>
        {loadedAccount.error !== undefined ? (
          <Alert variant="destructive">
            <AlertTitle>{PAYOUT_ACCOUNT_STRINGS.unavailableTitle}</AlertTitle>
            <AlertDescription>{errorMessage(loadedAccount.error)}</AlertDescription>
          </Alert>
        ) : loadedAccount.account === null ? (
          <p className="text-muted-foreground" data-payout-account-none="">
            {PAYOUT_ACCOUNT_STRINGS.none}
          </p>
        ) : (
          <AccountDetails account={loadedAccount.account} timeZone={tenant.timeZone} />
        )}
        {canEdit ? null : (
          <p className="text-sm text-muted-foreground" data-payout-role-note="">
            {PAYOUT_ACCOUNT_STRINGS.roleNote}
          </p>
        )}
      </section>

      {canEdit && loadedAccount.error === undefined ? (
        <PayoutForm
          tenantId={tenant.id}
          initialValues={initialValuesOf(loadedAccount.account, tenant)}
          hasAccount={loadedAccount.account !== null}
          countries={namedOptions(COUNTRY_CODES, "region")}
          currencies={namedOptions(CURRENCY_CODES, "currency")}
        />
      ) : null}
    </div>
  );
}
