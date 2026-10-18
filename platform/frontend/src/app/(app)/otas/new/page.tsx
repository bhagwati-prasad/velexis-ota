import { randomUUID } from "node:crypto";

import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { EARLY_ACCESS_PLAN_CODE, wizardPlans, type Plan } from "@/app/(app)/otas/new/plan-picker";
import { Wizard, type SelectOption } from "@/app/(app)/otas/new/wizard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { createPlatformApi, platformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { SHELL_STRINGS, WIZARD_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: WIZARD_STRINGS.title };

/**
 * The countries the wizard offers: the ISO 3166-1 alpha-2 codes of the reference data the API checks `countryCode`
 * against (`reference.countries`, tools/reference-data/data/countries.csv; `wizard.test.tsx` keeps the two equal).
 * Their names come from `Intl.DisplayNames`, so the list holds codes only.
 */
const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO " +
  "FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE " +
  "JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO " +
  "MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW " +
  "PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM " +
  "TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

/**
 * The currencies the wizard offers: the active ISO 4217 codes of the reference data the API checks `defaultCurrency`
 * against (`reference.currencies` with `is_active`; `wizard.test.tsx` keeps the two equal). Withdrawn currencies
 * stay out: an OTA's currency never changes.
 */
const CURRENCY_CODES = (
  "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY " +
  "COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR " +
  "ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK " +
  "MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF " +
  "SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS " +
  "VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG"
).split(" ");

/** The portal's locale (English only, ADR-0014). */
const LOCALE = "en";

/** The `TimeZone` pattern of the platform document. */
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** The zone preselected when the account's own is not offered. */
const FALLBACK_TIME_ZONE = "UTC";

/** `codes` with their English names (`Intl.DisplayNames`), sorted by name. */
function namedOptions(codes: readonly string[], type: "region" | "currency"): SelectOption[] {
  const names = new Intl.DisplayNames([LOCALE], { type, fallback: "code" });
  return codes
    .map((code) => {
      const name = names.of(code) ?? code;
      return { value: code, label: type === "currency" && name !== code ? `${name} (${code})` : name };
    })
    .sort((left, right) => left.label.localeCompare(right.label, LOCALE));
}

/**
 * The time zones the wizard offers: the canonical IANA zones of the server's `Intl`, `UTC`, and the account's own
 * zone (which the API accepted for the profile), sorted by name. Built on the server only, so the server's markup
 * and the browser's hydration use the same list.
 */
function timeZoneOptions(accountTimeZone: string): SelectOption[] {
  const zones = new Set(Intl.supportedValuesOf("timeZone"));
  zones.add(FALLBACK_TIME_ZONE);
  if (TIME_ZONE.test(accountTimeZone)) {
    zones.add(accountTimeZone);
  }
  return [...zones].sort().map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }));
}

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
