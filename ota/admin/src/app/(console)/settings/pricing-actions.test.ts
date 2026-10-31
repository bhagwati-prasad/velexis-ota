// The server actions of the markup and fee rule settings (OAD-013) against the fake OTA API (OADR-0018 point 10): the
// real actions, `requireStaff` and the SDK, with the SDK's `fetch` answered by src/test/fake-ota-api.ts, so each test
// checks the exact request an action sends (method, path, `Idempotency-Key`, `If-Match`, `X-Velexis-Environment`,
// body), the state it answers and the pages it revalidates, without a running backend. Next.js's request scope
// (`cookies()`, `headers()`), `redirect()` and `revalidatePath()` are mocked. Every token, id and name here is a
// dummy; the staff profile's OTA is in Europe/Oslo, where the window's wall-clock times are typed.
import { randomUUID } from "node:crypto";

import type { FeeRule, MarkupRule, StaffRole } from "@velexis/ota-sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  apiError,
  fakeOtaApi,
  fakeRedirect,
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
  type SentRequest,
} from "@/test/fake-ota-api";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/cache", () => nextCache);
vi.mock("next/navigation", () => ({ redirect: vi.fn(fakeRedirect) }));

import { INITIAL_ACTION_STATE, type ActionState } from "@/lib/action-state";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import {
  createFeeRule,
  createMarkupRule,
  deleteFeeRule,
  deleteMarkupRule,
  updateFeeRule,
  updateMarkupRule,
} from "./pricing-actions";
import { ruleBodyOfRule, type RuleActionState } from "./pricing-rules";

const ME = "GET /v1/console/auth/me";
const MARKUPS = "/v1/console/settings/markup-rules";
const FEES = "/v1/console/settings/fee-rules";
const MARKUP_ID = "mkr_01JA4H9Z1B3D5F7H9K1M3P5R7V";
const DEFAULT_MARKUP_ID = "mkr_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
const FEE_ID = "fee_01JA4H9Z1B3D5F7H9K1M3P5R7W";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member of `role` whose switch says `environment`. */
function signedIn(role: StaffRole = "owner", environment: "test" | "live" = "test"): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`pricing-actions-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-pricing-actions-${sequence}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
  api.on(ME, () => Response.json(staffProfile({ role }), { headers: { "X-Request-Id": "req_me" } }));
}

/** A markup rule as the API answers it. */
function markupRule(overrides: Partial<MarkupRule> = {}): MarkupRule {
  return {
    id: MARKUP_ID,
    name: "Long-haul economy",
    description: "4 % on economy from France above 400 EUR net.",
    scope: { originCountries: ["FR"], cabins: ["ECONOMY"], minNet: "400.00" },
    calculation: "percentage",
    percentage: "4.0000",
    fixed: null,
    appliesPer: "traveler",
    min: { amount: "15.00", currency: "EUR" },
    max: { amount: "50.00", currency: "EUR" },
    priority: 100,
    stackable: false,
    isDefault: false,
    isActive: true,
    activeFrom: null,
    activeUntil: null,
    version: 7,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
    ...overrides,
  };
}

/** A fee rule as the API answers it. */
function feeRule(overrides: Partial<FeeRule> = {}): FeeRule {
  return {
    id: FEE_ID,
    name: "Card fee",
    label: "Card payment fee",
    feeType: "payment_card",
    scope: { cardBrands: ["VISA", "MASTERCARD"] },
    calculation: "percentage",
    percentage: "1.5000",
    fixed: null,
    appliesPer: "booking",
    min: null,
    max: null,
    refundable: false,
    priority: 100,
    isActive: true,
    activeFrom: null,
    activeUntil: null,
    version: 3,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
    ...overrides,
  };
}

/** An answer of the API with the rule and its ETag. */
function ruleAnswer(rule: MarkupRule | FeeRule, status = 200): Response {
  return Response.json(rule, {
    status,
    headers: { ETag: `"${rule.version}"`, "X-Request-Id": "req_rule" },
  });
}

/** A form of fields (a list value repeats the field, as checkboxes post). */
function formOf(fields: Readonly<Record<string, string | readonly string[]>>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === "string" ? [value] : value) {
      form.append(name, item);
    }
  }
  return form;
}

/** The form of a markup rule's page for `rule`, as the shared form renders it, with `changes`. */
function markupEditForm(
  rule: MarkupRule,
  changes: Readonly<Record<string, string | readonly string[] | null>> = {},
): FormData {
  const fields: Record<string, string | readonly string[] | null> = {
    ruleId: rule.id,
    version: String(rule.version),
    original: JSON.stringify(ruleBodyOfRule("markup", rule)),
    name: rule.name,
    description: rule.description ?? "",
    "scope.origins": (rule.scope.origins ?? []).join(", "),
    "scope.destinations": (rule.scope.destinations ?? []).join(", "),
    "scope.originCountries": (rule.scope.originCountries ?? []).join(", "),
    "scope.destinationCountries": (rule.scope.destinationCountries ?? []).join(", "),
    "scope.carriers": (rule.scope.carriers ?? []).join(", "),
    "scope.cabins": rule.scope.cabins ?? [],
    "scope.travelerTypes": rule.scope.travelerTypes ?? [],
    "scope.tripTypes": rule.scope.tripTypes ?? [],
    "scope.sources": rule.scope.sources ?? [],
    "scope.channels": rule.scope.channels ?? [],
    "scope.minNet": rule.scope.minNet ?? "",
    "scope.maxNet": rule.scope.maxNet ?? "",
    calculation: rule.calculation,
    percentage: rule.percentage ?? "",
    "fixed.amount": rule.fixed?.amount ?? "",
    currency: (rule.fixed ?? rule.min ?? rule.max)?.currency ?? "EUR",
    appliesPer: rule.appliesPer,
    "min.amount": rule.min?.amount ?? "",
    "max.amount": rule.max?.amount ?? "",
    ...(rule.stackable ? { stackable: "true" } : {}),
    // The default rule's form has no priority, active or window inputs (FIX-W34-OTA) and marks itself instead.
    ...(rule.isDefault
      ? { defaultRule: "true" }
      : {
          priority: String(rule.priority),
          ...(rule.isActive ? { isActive: "true" } : {}),
          activeFrom: "",
          activeUntil: "",
        }),
    ...changes,
  };
  return formOf(
    Object.fromEntries(
      Object.entries(fields).filter(
        (entry): entry is [string, string | readonly string[]] =>
          entry[1] !== null &&
          // The default rule's form has no scope fields: its catch-all scope is not editable.
          !(rule.isDefault && entry[0].startsWith("scope.") && !Object.hasOwn(changes, entry[0])),
      ),
    ),
  );
}

/** The one request of `route`, failing the test when there is not exactly one. */
function only(route: string): SentRequest {
  const sent = api.sent(route);
  expect(sent, route).toHaveLength(1);
  return sent[0] as SentRequest;
}

/** The requests besides `console.auth.me`. */
function actionRequests(): SentRequest[] {
  return api.requests.filter((request) => `${request.method} ${request.url.pathname}` !== ME);
}

/** The paths the action revalidated. */
function revalidated(): string[] {
  return nextCache.revalidatePath.mock.calls.map(([path]) => String(path));
}

/** The fields of a new markup rule's form (`extra` replaces or adds). */
function newMarkupForm(
  key: string,
  extra: Readonly<Record<string, string | readonly string[]>> = {},
): FormData {
  return formOf({
    actionKey: key,
    name: "Long-haul economy",
    description: "",
    "scope.origins": "",
    "scope.destinations": "",
    "scope.originCountries": "",
    "scope.destinationCountries": "",
    "scope.carriers": "",
    "scope.minNet": "",
    "scope.maxNet": "",
    calculation: "percentage",
    percentage: "4",
    "fixed.amount": "",
    currency: "EUR",
    appliesPer: "traveler",
    "min.amount": "",
    "max.amount": "",
    priority: "100",
    isActive: "true",
    activeFrom: "",
    activeUntil: "",
    ...extra,
  });
}

const run = (
  action: (state: ActionState, form: FormData) => Promise<ActionState>,
  form: FormData,
): Promise<RuleActionState> => action(INITIAL_ACTION_STATE, form) as Promise<RuleActionState>;

// Once per file: the first SDK call and the first Zod parse of a fresh worker are the slowest; on a busy CI runner they
// would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  api.on(`POST ${MARKUPS}`, () => ruleAnswer(markupRule(), 201));
  await run(createMarkupRule, newMarkupForm(randomUUID()));
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(
    new Headers({ "User-Agent": "Mozilla/5.0 Test", "X-Forwarded-For": "203.0.113.7" }),
  );
  nextCache.revalidatePath.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Markup rules -----------------------------------------------------------------------------------------------

describe("createMarkupRule", () => {
  it("[OAD-013 AC2] creates the rule with the form's values, under the page's idempotency key", async () => {
    signedIn("owner", "live");
    api.on(`POST ${MARKUPS}`, () => ruleAnswer(markupRule(), 201));
    const key = randomUUID();

    const state = await run(
      createMarkupRule,
      newMarkupForm(key, {
        description: "  Long-haul from France.  ",
        "scope.origins": "par, NYC;par",
        "scope.originCountries": "fr",
        // Posted in another order than the form's; sent in the form's.
        "scope.cabins": ["BUSINESS", "ECONOMY"],
        "scope.travelerTypes": ["ADULT"],
        "scope.channels": ["storefront"],
        "scope.minNet": "400.00",
        calculation: "percentage_plus_fixed",
        percentage: "4.5",
        "fixed.amount": "15.00",
        currency: "eur",
        "min.amount": "10",
        priority: "50",
        stackable: "true",
        // Wall-clock times in Europe/Oslo (CET, UTC+1, in November).
        activeFrom: "2026-11-01T00:00",
        activeUntil: "2026-12-01T00:00",
      }),
    );

    const sent = only(`POST ${MARKUPS}`);
    expect(sent.headers.get("Idempotency-Key")).toBe(key);
    expect(sent.headers.get("If-Match")).toBeNull();
    expect(sent.headers.get("X-Velexis-Environment")).toBe("live");
    expect(sent.headers.get("X-Api-Key")).toBe(TEST_CONFIG.OTA_ADMIN_SERVICE_KEY);
    expect(sent.headers.get("X-Velexis-End-User-IP")).toBe("203.0.113.7");
    expect(sent.body).toEqual({
      name: "Long-haul economy",
      description: "Long-haul from France.",
      scope: {
        origins: ["PAR", "NYC"],
        originCountries: ["FR"],
        cabins: ["ECONOMY", "BUSINESS"],
        travelerTypes: ["ADULT"],
        channels: ["storefront"],
        minNet: "400.00",
      },
      calculation: "percentage_plus_fixed",
      percentage: "4.5",
      fixed: { amount: "15.00", currency: "EUR" },
      appliesPer: "traveler",
      min: { amount: "10", currency: "EUR" },
      priority: 50,
      stackable: true,
      isActive: true,
      activeFrom: "2026-10-31T23:00:00Z",
      activeUntil: "2026-11-30T23:00:00Z",
    });
    expect(state).toEqual({
      ok: true,
      message: "Markup rule created. It applies to the next search; offers already shown keep their prices.",
      rule: { id: MARKUP_ID, name: "Long-haul economy" },
    });
    expect(revalidated()).toEqual(["/settings/markups"]);
  });

  it("[OAD-013 AC2] sends only what the calculation uses, and the defaults the form posts", async () => {
    signedIn("admin");
    api.on(`POST ${MARKUPS}`, () => ruleAnswer(markupRule(), 201));

    // A fixed amount typed before switching to a percentage is not sent; nor are empty optional fields.
    await run(
      createMarkupRule,
      newMarkupForm(randomUUID(), { percentage: "-5", "fixed.amount": "12.00", appliesPer: "booking" }),
    );

    expect(only(`POST ${MARKUPS}`).body).toEqual({
      name: "Long-haul economy",
      scope: {},
      calculation: "percentage",
      percentage: "-5",
      appliesPer: "booking",
      priority: 100,
      stackable: false,
      isActive: true,
    });
  });

  it("[OAD-013 AC2] answers the API's warnings with the new rule, as the API sent them", async () => {
    signedIn("owner");
    const warnings = [
      {
        code: "fixed_currency_not_default",
        message:
          "The rule's amounts are not in the storefront's default currency: they apply only to offers in their currency, without conversion.",
        path: "/fixed/currency",
      },
      {
        code: "sells_below_net",
        message: "The rule can make a negative markup: matching offers can be sold below the net price.",
        path: "/fixed/amount",
      },
    ];
    api.on(`POST ${MARKUPS}`, () => ruleAnswer(markupRule({ warnings }), 201));

    const state = await run(
      createMarkupRule,
      newMarkupForm(randomUUID(), { calculation: "fixed", "fixed.amount": "-10.00", currency: "USD" }),
    );

    expect(state).toMatchObject({ ok: true, rule: { id: MARKUP_ID }, warnings });
  });

  it("sends the same key on a double submit, so the API creates one rule", async () => {
    signedIn("owner");
    api.on(`POST ${MARKUPS}`, () => ruleAnswer(markupRule(), 201));
    const key = randomUUID();

    await Promise.all([run(createMarkupRule, newMarkupForm(key)), run(createMarkupRule, newMarkupForm(key))]);

    expect(api.sent(`POST ${MARKUPS}`).map((request) => request.headers.get("Idempotency-Key"))).toEqual([
      key,
      key,
    ]);
  });

  it("[OAD-013 AC1] refuses an agent, a finance member and a viewer before any call, naming the permission", async () => {
    for (const role of ["agent", "finance", "viewer"] as const) {
      api = fakeOtaApi();
      vi.stubGlobal("fetch", api.fetch);
      signedIn(role);

      const state = await run(createMarkupRule, newMarkupForm(randomUUID()));

      expect(state).toEqual({
        ok: false,
        code: "FORBIDDEN",
        message: "You do not have permission to do this (settings:write).",
      });
      expect(actionRequests()).toEqual([]);
    }
  });

  it("checks the form first, as the API would: no request, the key kept", async () => {
    signedIn("owner");

    const state = await run(
      createMarkupRule,
      newMarkupForm(randomUUID(), {
        name: "  ",
        "scope.origins": "PARIS",
        calculation: "percentage_plus_fixed",
        percentage: "-100.5",
        "fixed.amount": "",
        currency: "",
        "max.amount": "50.123",
        priority: "100001",
        activeFrom: "2026-11-01T00:00",
        activeUntil: "2026-10-01T00:00",
      }),
    );

    expect(state).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      fieldErrors: {
        name: "Enter a name.",
        "scope.origins": "Enter codes like PAR, NYC, separated by commas.",
        percentage: "Enter a percentage from -100 to 999.9999, like 4 or 4.5; a negative one is a discount.",
        "fixed.amount": "Enter the fixed amount.",
        "max.amount": "Enter an amount with at most two decimals, like 15.00; a negative one is a discount.",
        currency: "Enter the currency of the amounts, like EUR.",
        priority: "Enter a whole number from 0 to 100,000.",
        activeUntil: "The end of the window is after its start.",
      },
    });
    expect(state.nextActionKey).toBeUndefined();
    expect(actionRequests()).toEqual([]);
  });

  it("asks for a reload without the page's key", async () => {
    signedIn("owner");

    expect(await run(createMarkupRule, newMarkupForm("not-a-key"))).toMatchObject({
      ok: false,
      message: "This form is out of date. Reload the page and try again.",
    });
    expect(actionRequests()).toEqual([]);
  });

  it("puts the API's field errors on the form's fields; a final 4xx brings a new key, a 503 keeps it", async () => {
    signedIn("owner");
    api.on(`POST ${MARKUPS}`, () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [
          { path: "/scope/origins/1", code: "pattern" },
          {
            path: "/max/currency",
            code: "currency",
            message: "The fixed amount and the caps share one currency: the currency of the first one set.",
          },
          { path: "/fixed", code: "required", message: "A fixed rule needs a fixed amount." },
        ],
      }),
    );

    const refused = await run(createMarkupRule, newMarkupForm(randomUUID()));

    expect(refused).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      requestId: "req_fake_1",
      fieldErrors: {
        "scope.origins": "Not in the expected format.",
        currency: "The fixed amount and the caps share one currency: the currency of the first one set.",
        "fixed.amount": "A fixed rule needs a fixed amount.",
      },
    });
    expect(refused.nextActionKey).toMatch(/^[0-9a-f-]{36}$/);

    api.on(`POST ${MARKUPS}`, () => apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }));
    expect((await run(createMarkupRule, newMarkupForm(randomUUID()))).nextActionKey).toBeUndefined();
  });
});

describe("updateMarkupRule", () => {
  it("[OAD-013 AC2] sends only the changed fields, with If-Match = the displayed version", async () => {
    signedIn("owner");
    const rule = markupRule();
    api.on(`PATCH ${MARKUPS}/${MARKUP_ID}`, () =>
      ruleAnswer(markupRule({ percentage: "4.5000", max: null, version: 8 })),
    );

    const state = await run(updateMarkupRule, markupEditForm(rule, { percentage: "4.5", "max.amount": "" }));

    const sent = only(`PATCH ${MARKUPS}/${MARKUP_ID}`);
    expect(sent.headers.get("If-Match")).toBe('"7"');
    expect(sent.headers.get("Idempotency-Key")).toBeNull();
    expect(sent.body).toEqual({ percentage: "4.5", max: null });
    expect(state).toEqual({
      ok: true,
      message: "Saved. The change applies to the next search; offers already shown keep their prices.",
      rule: { id: MARKUP_ID, name: "Long-haul economy" },
    });
    expect(revalidated()).toEqual([`/settings/markups/${MARKUP_ID}`, "/settings/markups"]);
  });

  it("[OAD-013 AC2] replaces the scope as a whole and sends a cleared or a new window", async () => {
    signedIn("admin");
    const rule = markupRule({ activeFrom: "2026-11-01T00:00:00Z", activeUntil: "2026-12-01T00:00:00Z" });
    api.on(`PATCH ${MARKUPS}/${MARKUP_ID}`, () => ruleAnswer(markupRule({ version: 8 })));

    await run(
      updateMarkupRule,
      markupEditForm(rule, {
        "scope.carriers": "af",
        "scope.cabins": ["ECONOMY", "PREMIUM_ECONOMY"],
        // The window as the form shows it in Europe/Oslo: the start kept, the end cleared.
        activeFrom: "2026-11-01T01:00",
        activeUntil: "",
      }),
    );

    expect(only(`PATCH ${MARKUPS}/${MARKUP_ID}`).body).toEqual({
      scope: {
        originCountries: ["FR"],
        carriers: ["AF"],
        cabins: ["ECONOMY", "PREMIUM_ECONOMY"],
        minNet: "400.00",
      },
      activeUntil: null,
    });
  });

  it("makes no call for a form sent unchanged (the same values written another way included)", async () => {
    signedIn("owner");

    const state = await run(
      updateMarkupRule,
      markupEditForm(markupRule(), { percentage: "4", "min.amount": "15", "scope.originCountries": "fr" }),
    );

    expect(state).toEqual({ ok: true, message: "Nothing to save: the rule is as shown." });
    expect(actionRequests()).toEqual([]);
    expect(revalidated()).toEqual([]);
  });

  it("makes no call for an unchanged rule stored with a value its calculation ignores and a blank description", async () => {
    signedIn("owner");
    // Written through the API: a fixed rule keeps a percentage it never applies, which the form neither sends nor clears.
    const rule = markupRule({
      calculation: "fixed",
      percentage: "3.0000",
      fixed: { amount: "12.00", currency: "EUR" },
      description: "",
    });

    expect(await run(updateMarkupRule, markupEditForm(rule))).toEqual({
      ok: true,
      message: "Nothing to save: the rule is as shown.",
    });
    expect(actionRequests()).toEqual([]);
  });

  it("compares the window as the form shows it: the hour the clocks go back unchanged, a second changed", async () => {
    signedIn("owner");
    // 02:30 happens twice in Europe/Oslo on 2026-10-25; the stored start is the first (CEST, UTC+2), which the form
    // shows as 02:30 like the second. The end has seconds, which the form shows and posts.
    const rule = markupRule({ activeFrom: "2026-10-25T00:30:00Z", activeUntil: "2026-12-01T10:00:30Z" });
    const shown = { activeFrom: "2026-10-25T02:30", activeUntil: "2026-12-01T11:00:30" };

    expect(await run(updateMarkupRule, markupEditForm(rule, shown))).toEqual({
      ok: true,
      message: "Nothing to save: the rule is as shown.",
    });
    expect(actionRequests()).toEqual([]);

    api.on(`PATCH ${MARKUPS}/${MARKUP_ID}`, () => ruleAnswer(markupRule({ version: 8 })));
    await run(updateMarkupRule, markupEditForm(rule, { ...shown, activeUntil: "2026-12-01T11:00:45" }));
    expect(only(`PATCH ${MARKUPS}/${MARKUP_ID}`).body).toEqual({ activeUntil: "2026-12-01T10:00:45Z" });
  });

  it("never sends the default rule's scope: its form has no scope fields", async () => {
    signedIn("owner");
    const rule = markupRule({
      id: DEFAULT_MARKUP_ID,
      name: "Default",
      description: null,
      scope: {},
      percentage: "0.0000",
      min: null,
      max: null,
      priority: 1000,
      isDefault: true,
    });
    api.on(`PATCH ${MARKUPS}/${DEFAULT_MARKUP_ID}`, () => ruleAnswer({ ...rule, percentage: "2.0000" }));

    await run(updateMarkupRule, markupEditForm(rule, { percentage: "2" }));

    expect(only(`PATCH ${MARKUPS}/${DEFAULT_MARKUP_ID}`).body).toEqual({ percentage: "2" });
  });

  it("[FIX-W34-OTA AC3] never sends the default rule's priority, active flag or window: its form has none, a forged POST included", async () => {
    signedIn("owner");
    const rule = markupRule({
      id: DEFAULT_MARKUP_ID,
      name: "Default",
      description: null,
      scope: {},
      percentage: "0.0000",
      min: null,
      max: null,
      priority: 1000,
      isDefault: true,
    });
    api.on(`PATCH ${MARKUPS}/${DEFAULT_MARKUP_ID}`, () => ruleAnswer({ ...rule, percentage: "2.0000" }));

    // As the form posts it: no priority, active or window field, and the marker.
    expect(await run(updateMarkupRule, markupEditForm(rule, { percentage: "2" }))).toMatchObject({
      ok: true,
    });
    expect(only(`PATCH ${MARKUPS}/${DEFAULT_MARKUP_ID}`).body).toEqual({ percentage: "2" });

    // A forged POST with the fixed fields changed: still the percentage alone.
    api.requests.length = 0;
    await run(
      updateMarkupRule,
      markupEditForm(rule, {
        percentage: "3",
        priority: "5",
        activeFrom: "2027-01-01T00:00",
        activeUntil: "2027-02-01T00:00",
        "scope.carriers": "AF",
      }),
    );
    expect(only(`PATCH ${MARKUPS}/${DEFAULT_MARKUP_ID}`).body).toEqual({ percentage: "3" });

    // Nothing else changed: no call at all (the missing active checkbox is not "switched off").
    api.requests.length = 0;
    expect(await run(updateMarkupRule, markupEditForm(rule))).toMatchObject({
      ok: true,
      message: "Nothing to save: the rule is as shown.",
    });
    expect(actionRequests()).toEqual([]);
  });

  it("answers the API's refusals in this page's words, without a key", async () => {
    signedIn("owner");
    const cases: readonly (readonly [Response, string])[] = [
      [apiError("PRECONDITION_FAILED", 412), "This record changed; reload to see the latest version."],
      [
        apiError("CONFLICT", 409, { details: { reason: "default_rule" } }),
        "The default rule always matches every offer: its scope stays empty, it stays active with no validity window, and its priority stays 1000. Change its percentage instead.",
      ],
      [apiError("NOT_FOUND", 404), "This markup rule no longer exists. Go back to the list of markup rules."],
    ];
    for (const [answer, message] of cases) {
      api.on(`PATCH ${MARKUPS}/${MARKUP_ID}`, () => answer.clone());

      const state = await run(updateMarkupRule, markupEditForm(markupRule(), { name: "Renamed" }));

      expect(state).toMatchObject({ ok: false, message, requestId: "req_fake_1" });
      expect(state.nextActionKey).toBeUndefined();
    }
  });

  it("asks for a reload when a hidden field is not the page's, before any call", async () => {
    signedIn("owner");
    for (const changes of [
      { ruleId: "fee_01JA4H9Z1B3D5F7H9K1M3P5R7W" },
      { version: "seven" },
      { original: "{" },
    ]) {
      expect(
        await run(updateMarkupRule, markupEditForm(markupRule(), { ...changes, name: "Renamed" })),
      ).toMatchObject({ ok: false, message: "This form is out of date. Reload the page and try again." });
    }
    expect(actionRequests()).toEqual([]);
  });

  it("[OAD-013 AC1] refuses an agent before any call", async () => {
    signedIn("agent");

    expect(await run(updateMarkupRule, markupEditForm(markupRule(), { name: "Renamed" }))).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "You do not have permission to do this (settings:write).",
    });
    expect(actionRequests()).toEqual([]);
  });
});

describe("deleteMarkupRule", () => {
  it("[OAD-013 AC2] deletes with If-Match = the displayed version, then goes to the list", async () => {
    signedIn("owner");
    api.on(`DELETE ${MARKUPS}/${MARKUP_ID}`, () => new Response(null, { status: 204 }));

    const to = await redirectOf(() =>
      run(deleteMarkupRule, formOf({ ruleId: MARKUP_ID, version: "7", actionKey: randomUUID() })),
    );

    expect(to).toBe("/settings/markups");
    const sent = only(`DELETE ${MARKUPS}/${MARKUP_ID}`);
    expect(sent.headers.get("If-Match")).toBe('"7"');
    expect(sent.body).toBeUndefined();
    expect(revalidated()).toEqual(["/settings/markups", `/settings/markups/${MARKUP_ID}`]);
  });

  it("explains that the default rule cannot be deleted, and asks for a reload after a 412", async () => {
    signedIn("owner");
    api.on(`DELETE ${MARKUPS}/${DEFAULT_MARKUP_ID}`, () =>
      apiError("CONFLICT", 409, { details: { reason: "default_rule" } }),
    );
    expect(await run(deleteMarkupRule, formOf({ ruleId: DEFAULT_MARKUP_ID, version: "1" }))).toMatchObject({
      ok: false,
      code: "CONFLICT",
      message:
        "The default rule cannot be deleted: it is the catch-all that every offer matches. Change its percentage instead.",
    });

    api.on(`DELETE ${MARKUPS}/${MARKUP_ID}`, () => apiError("PRECONDITION_FAILED", 412));
    expect(await run(deleteMarkupRule, formOf({ ruleId: MARKUP_ID, version: "6" }))).toMatchObject({
      ok: false,
      message: "This record changed; reload to see the latest version.",
    });
    expect(revalidated()).toEqual([]);
  });

  it("[OAD-013 AC1] refuses a finance member before any call, and a form without the rule's version", async () => {
    signedIn("finance");
    expect(await run(deleteMarkupRule, formOf({ ruleId: MARKUP_ID, version: "7" }))).toMatchObject({
      code: "FORBIDDEN",
      message: "You do not have permission to do this (settings:write).",
    });

    signedIn("owner");
    expect(await run(deleteMarkupRule, formOf({ ruleId: MARKUP_ID }))).toMatchObject({
      message: "This form is out of date. Reload the page and try again.",
    });
    expect(actionRequests()).toEqual([]);
  });
});

// ---- Fee rules --------------------------------------------------------------------------------------------------

/** The fields of a new fee rule's form. */
function newFeeForm(key: string, extra: Readonly<Record<string, string | readonly string[]>> = {}): FormData {
  return formOf({
    actionKey: key,
    name: "Card fee",
    label: "Card payment fee",
    feeType: "payment_card",
    "scope.origins": "",
    "scope.destinations": "",
    "scope.originCountries": "",
    "scope.destinationCountries": "",
    "scope.carriers": "",
    "scope.minNet": "",
    "scope.maxNet": "",
    calculation: "percentage",
    percentage: "1.5",
    "fixed.amount": "",
    currency: "EUR",
    appliesPer: "booking",
    "min.amount": "",
    "max.amount": "",
    priority: "100",
    isActive: "true",
    activeFrom: "",
    activeUntil: "",
    ...extra,
  });
}

describe("fee rules", () => {
  it("[OAD-013 AC2] creates a fee rule with its label, type, card brands, caps and refundable flag", async () => {
    signedIn("owner");
    api.on(`POST ${FEES}`, () => ruleAnswer(feeRule(), 201));
    const key = randomUUID();

    const state = await run(
      createFeeRule,
      newFeeForm(key, {
        "scope.cardBrands": ["MASTERCARD", "VISA"],
        "scope.channels": ["storefront"],
        "min.amount": "2.00",
        refundable: "true",
        priority: "20",
      }),
    );

    const sent = only(`POST ${FEES}`);
    expect(sent.headers.get("Idempotency-Key")).toBe(key);
    expect(sent.body).toEqual({
      name: "Card fee",
      label: "Card payment fee",
      feeType: "payment_card",
      scope: { channels: ["storefront"], cardBrands: ["VISA", "MASTERCARD"] },
      calculation: "percentage",
      percentage: "1.5",
      appliesPer: "booking",
      min: { amount: "2.00", currency: "EUR" },
      priority: 20,
      refundable: true,
      isActive: true,
    });
    expect(state).toEqual({
      ok: true,
      message: "Fee rule created. It applies from the next pricing; offers already priced keep their fees.",
      rule: { id: FEE_ID, name: "Card fee" },
    });
    expect(revalidated()).toEqual(["/settings/fees"]);
  });

  it("checks a fee's own bounds: a fee type, a percentage of at most 100, no negative amount", async () => {
    signedIn("owner");

    const state = await run(
      createFeeRule,
      newFeeForm(randomUUID(), {
        feeType: "",
        label: "",
        calculation: "percentage_plus_fixed",
        percentage: "150",
        "fixed.amount": "-1.00",
      }),
    );

    expect(state.fieldErrors).toEqual({
      label: "Enter the label travellers see.",
      feeType: "Choose what the fee is charged for.",
      percentage: "Enter a percentage from 0 to 100, like 1.5.",
      "fixed.amount": "Enter an amount of zero or more with at most two decimals, like 15.00.",
    });
    expect(actionRequests()).toEqual([]);
  });

  it("[OAD-013 AC2] updates the changed fields of a fee rule with If-Match", async () => {
    signedIn("admin");
    const rule = feeRule();
    api.on(`PATCH ${FEES}/${FEE_ID}`, () => ruleAnswer(feeRule({ label: "Card surcharge", version: 4 })));
    const form = formOf({
      ruleId: rule.id,
      version: String(rule.version),
      original: JSON.stringify(ruleBodyOfRule("fee", rule)),
      name: rule.name,
      label: "Card surcharge",
      feeType: rule.feeType,
      "scope.origins": "",
      "scope.destinations": "",
      "scope.originCountries": "",
      "scope.destinationCountries": "",
      "scope.carriers": "",
      "scope.cardBrands": ["VISA", "MASTERCARD"],
      "scope.minNet": "",
      "scope.maxNet": "",
      calculation: rule.calculation,
      percentage: "1.5000",
      "fixed.amount": "",
      currency: "EUR",
      appliesPer: rule.appliesPer,
      "min.amount": "",
      "max.amount": "",
      priority: "100",
      refundable: "true",
      isActive: "true",
      activeFrom: "",
      activeUntil: "",
    });

    const state = await run(updateFeeRule, form);

    const sent = only(`PATCH ${FEES}/${FEE_ID}`);
    expect(sent.headers.get("If-Match")).toBe('"3"');
    expect(sent.body).toEqual({ label: "Card surcharge", refundable: true });
    expect(state).toMatchObject({
      ok: true,
      message: "Saved. The change applies from the next pricing; offers already priced keep their fees.",
    });
    expect(revalidated()).toEqual([`/settings/fees/${FEE_ID}`, "/settings/fees"]);
  });

  it("[OAD-013 AC2] deletes a fee rule with If-Match, then goes to the list", async () => {
    signedIn("owner");
    api.on(`DELETE ${FEES}/${FEE_ID}`, () => new Response(null, { status: 204 }));

    expect(await redirectOf(() => run(deleteFeeRule, formOf({ ruleId: FEE_ID, version: "3" })))).toBe(
      "/settings/fees",
    );
    expect(only(`DELETE ${FEES}/${FEE_ID}`).headers.get("If-Match")).toBe('"3"');
  });

  it("[OAD-013 AC1] refuses a viewer's fee writes before any call", async () => {
    signedIn("viewer");
    for (const action of [createFeeRule, updateFeeRule, deleteFeeRule]) {
      expect(await run(action, newFeeForm(randomUUID()))).toMatchObject({
        code: "FORBIDDEN",
        message: "You do not have permission to do this (settings:write).",
      });
    }
    expect(actionRequests()).toEqual([]);
  });
});
