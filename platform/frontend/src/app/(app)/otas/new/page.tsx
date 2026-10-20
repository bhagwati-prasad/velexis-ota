import { randomUUID } from "node:crypto";

import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { EARLY_ACCESS_PLAN_CODE, wizardPlans, type Plan } from "@/app/(app)/otas/new/plan-picker";
import { Wizard } from "@/app/(app)/otas/new/wizard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { createPlatformApi, platformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
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

function planStep(loaded: readonly Plan[] | undefined, stripeBilling: boolean): PlanStep {
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
  return {
    plans,
    defaultPlanCode: plans.length === 1 ? (plans[0]?.code ?? "") : "",
    ...(plans.length === 0 ? { unavailable: WIZARD_STRINGS.plansMissing } : {}),
  };
}

/**
 * `/otas/new` (README §2 Signed in; flow signup-and-create-ota.md step 5; PF-10): the create-OTA wizard for a
 * verified account. The page loads the account (`getMe`: the M5 switch and the time zone to preselect) and the
 * public plans, builds the country, currency and time zone lists, and makes the wizard's one `Idempotency-Key`
 * (a UUID): a new one each time the page opens, the same one for every submit of that wizard (PF-10 AC2).
 */
export default async function NewOtaPage() {
  const settings = getConfig();
  const api = await platformApi();
  const [me, plans] = await Promise.all([api.GET("/v1/me"), listPlans()]);
  if (me.error !== undefined) {
    if (SESSION_ENDED.has(me.error.code)) {
      redirect(`/sign-in?${new URLSearchParams({ next: "/otas/new" }).toString()}`);
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

  const timeZones = timeZoneOptions(account.timeZone);
  const defaultTimeZone = timeZones.some((zone) => zone.value === account.timeZone)
    ? account.timeZone
    : FALLBACK_TIME_ZONE;
  const plan = planStep(plans.data?.data, account.features.stripeBilling);

  return (
    <div className="mx-auto grid max-w-2xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{WIZARD_STRINGS.title}</h1>
        <p className="text-muted-foreground">{WIZARD_STRINGS.intro}</p>
      </div>
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
      />
    </div>
  );
}
