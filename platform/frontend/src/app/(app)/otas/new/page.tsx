import { randomUUID } from "node:crypto";

import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { EARLY_ACCESS_PLAN_CODE, wizardPlans, type Plan } from "@/app/(app)/otas/new/plan-picker";
import { Wizard } from "@/app/(app)/otas/new/wizard";
import { TenantLimitNotice, loadTenantLimit } from "@/components/tenant-limit-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { createPlatformApi, platformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { newOtaPath, planCodeOf } from "@/lib/plan-code";
import {
  COUNTRY_CODES,
  CURRENCY_CODES,
  FALLBACK_TIME_ZONE,
  namedOptions,
  timeZoneOptions,
} from "@/lib/reference-options";
import { SHELL_STRINGS, WIZARD_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: WIZARD_STRINGS.title };

/** Answers of `getMe` that mean the session is over. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/**
 * `listPlans` is public: the call carries no access token, only the end-user headers of PADR-0019, as on the
 * pricing page.
 */
async function listPlans() {
  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  return api.GET("/v1/plans");
}

/** What the plan step offers, from `listPlans` and the M5 switch (README §2 `/otas/new`). */
interface PlanStep {
  readonly plans: Plan[];
  readonly defaultPlanCode: string;
  readonly note?: string;
  readonly unavailable?: string;
}

type Query = Record<string, string | string[] | undefined>;
type SearchParams = Promise<Query>;

const NO_QUERY: Query = Object.freeze({});

/**
 * The plan step. `requested` is the plan chosen on `/pricing` (`?plan=<code>`, KI-009): from M5 it is the default when
 * the step offers it; otherwise the default stays as it was (before M5 always early access).
 */
function planStep(loaded: readonly Plan[] | undefined, stripeBilling: boolean, requested?: string): PlanStep {
  const plans = loaded === undefined ? [] : wizardPlans(loaded, stripeBilling);
  if (!stripeBilling) {
    // Before M5 the API puts every OTA on early access (PF-10 AC3); a failed listPlans hides only its details.
    return {
      plans,
      defaultPlanCode: EARLY_ACCESS_PLAN_CODE,
      note: WIZARD_STRINGS.earlyAccessOnly,
      ...(plans.length === 0 ? { unavailable: WIZARD_STRINGS.plansUnavailable } : {}),
    };
  }
  const offered = plans.some((plan) => plan.code === requested) ? requested : undefined;
  return {
    plans,
    defaultPlanCode: offered ?? (plans.length === 1 ? (plans[0]?.code ?? "") : ""),
    ...(plans.length === 0 ? { unavailable: WIZARD_STRINGS.plansMissing } : {}),
  };
}

/** A read whose failure is kept for later: `loadTenantLimit`'s, started with the page's other reads (39d). */
type Settled<T> = { readonly value: T } | { readonly failure: unknown };

const settled = <T,>(read: Promise<T>): Promise<Settled<T>> =>
  read.then(
    (value) => ({ value }),
    (failure: unknown) => ({ failure }),
  );

/**
 * `/otas/new` (README §2 Signed in; flow signup-and-create-ota.md step 5; PF-10): the create-OTA wizard for a
 * verified account. The page loads the account (`getMe`: the M5 switch and the time zone to preselect), the
 * public plans and the account's tenant limit (`listTenants`), builds the country, currency and time zone lists, and
 * makes the wizard's one `Idempotency-Key` (a UUID): a new one each time the page opens, the same one for every submit
 * of that wizard (PF-10 AC2). `plan` is the plan chosen on `/pricing` (a well-formed code only, FIX-W69-SIGNUP,
 * KI-009), preselected when the plan step offers it.
 *
 * The reads run in one `Promise.all` (lead decision (39d), FIX-W70-CONSOLE): the limit no longer waits for
 * `getMe`. `getMe`'s answer decides only what the page renders (a sign-in redirect, its error, `/verify-pending`),
 * not whether the limit may be read (the dashboard reads both in parallel too), so an unverified account or a failed
 * `getMe` costs one `listTenants` whose answer is not used. The limit's failure is kept until the account is known to
 * be verified and only then thrown, as before, so the page behaves exactly as when it read the limit after `getMe`.
 */
export default async function NewOtaPage({ searchParams }: { readonly searchParams?: SearchParams }) {
  const settings = getConfig();
  const api = await platformApi();
  const [me, plans, params, limit] = await Promise.all([
    api.GET("/v1/me"),
    listPlans(),
    searchParams ?? Promise.resolve(NO_QUERY),
    settled(loadTenantLimit(api)),
  ]);
  const requestedPlan = planCodeOf(params.plan);
  if (me.error !== undefined) {
    if (SESSION_ENDED.has(me.error.code)) {
      redirect(`/sign-in?${new URLSearchParams({ next: newOtaPath(requestedPlan) }).toString()}`);
    }
    return (
      <div className="mx-auto grid max-w-2xl gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">{WIZARD_STRINGS.title}</h1>
        <Alert variant="destructive">
          <AlertTitle>{SHELL_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(me.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  const account = me.data;
  if (!account.emailVerified) {
    redirect("/verify-pending");
  }
  // FIX-W69-LIMIT (KI-010): at the tenant limit the reason shows above the first step, for a verified account only.
  if ("failure" in limit) {
    throw limit.failure;
  }
  const tenantLimit = limit.value;

  const timeZones = timeZoneOptions(account.timeZone);
  const defaultTimeZone = timeZones.some((zone) => zone.value === account.timeZone)
    ? account.timeZone
    : FALLBACK_TIME_ZONE;
  const plan = planStep(plans.data?.data, account.features.stripeBilling, requestedPlan);

  return (
    <div className="mx-auto grid max-w-2xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{WIZARD_STRINGS.title}</h1>
        <p className="text-muted-foreground">{WIZARD_STRINGS.intro}</p>
      </div>
      <TenantLimitNotice limit={tenantLimit} />
      <Wizard
        idempotencyKey={randomUUID()}
        storefrontBaseDomain={settings.STOREFRONT_BASE_DOMAIN}
        countries={namedOptions(COUNTRY_CODES, "region")}
        currencies={namedOptions(CURRENCY_CODES, "currency")}
        timeZones={timeZones}
        defaultTimeZone={defaultTimeZone}
        plans={plan.plans}
        defaultPlanCode={plan.defaultPlanCode}
        planNote={plan.note}
        plansUnavailable={plan.unavailable}
        stripeBilling={account.features.stripeBilling}
      />
    </div>
  );
}
