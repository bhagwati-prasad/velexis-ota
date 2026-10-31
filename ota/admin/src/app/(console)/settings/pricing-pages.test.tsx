// The markup and fee rule pages as Next.js renders them on the server (OAD-013): the real pages, `getConsoleRequest`
// and the SDK against the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a detached happy-dom
// document (a server-mode SDK client refuses to run in a browser-like test environment, rightly). What each role is
// offered (owners and admins write, every other role reads), the requests a URL gives, the API's codes handled on the
// server, and the forms the pages render posted as they are to the real server actions, so the page, the form and
// the action agree on every field. Every token, id and name here is a dummy; the OTA is in Europe/Oslo.
import type { FeeRule, MarkupRule, StaffRole } from "@velexis/ota-sdk";
import { within } from "@testing-library/dom";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  apiError,
  fakeOtaApi,
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
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/settings/markups",
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    redirect: fakeRedirect,
  };
});

import { INITIAL_ACTION_STATE } from "@/lib/action-state";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import FeeRulePage from "./fees/[id]/page";
import NewFeeRulePage from "./fees/new/page";
import FeeRulesPage from "./fees/page";
import MarkupRulePage from "./markups/[id]/page";
import NewMarkupRulePage from "./markups/new/page";
import MarkupRulesPage from "./markups/page";
import { createFeeRule, createMarkupRule, updateFeeRule, updateMarkupRule } from "./pricing-actions";

const ME = "GET /v1/console/auth/me";
const MARKUPS = "/v1/console/settings/markup-rules";
const FEES = "/v1/console/settings/fee-rules";
const MARKUP_ID = "mkr_01JA4H9Z1B3D5F7H9K1M3P5R7V";
const STACKED_ID = "mkr_01JA4H9Z1B3D5F7H9K1M3P5R7X";
const DEFAULT_ID = "mkr_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
const FEE_ID = "fee_01JA4H9Z1B3D5F7H9K1M3P5R7W";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member of `role`. */
function signedIn(role: StaffRole): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`pricing-pages-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-pricing-pages-${sequence}`,
      [ENVIRONMENT_COOKIE]: "test",
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
  api.on(ME, () => Response.json(staffProfile({ role }), { headers: { "X-Request-Id": "req_me" } }));
}

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
    max: null,
    priority: 100,
    stackable: false,
    isDefault: false,
    isActive: true,
    activeFrom: "2026-11-01T00:00:00Z",
    activeUntil: null,
    version: 7,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
    ...overrides,
  };
}

const STACKED = markupRule({
  id: STACKED_ID,
  name: "AF promotion",
  description: null,
  scope: { carriers: ["AF"] },
  calculation: "fixed",
  percentage: null,
  fixed: { amount: "-10.00", currency: "EUR" },
  appliesPer: "booking",
  min: null,
  priority: 50,
  stackable: true,
  activeFrom: null,
});

const DEFAULT_RULE = markupRule({
  id: DEFAULT_ID,
  name: "Default markup",
  description: null,
  scope: {},
  percentage: "0.0000",
  min: null,
  priority: 1000,
  isDefault: true,
  activeFrom: null,
  version: 1,
});

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

/** A page of rules as the list operations answer it. */
function pageAnswer(data: readonly (MarkupRule | FeeRule)[], nextCursor: string | null = null): Response {
  return Response.json(
    { data, page: { nextCursor, limit: 50 } },
    { headers: { "X-Request-Id": "req_list" } },
  );
}

function ruleAnswer(rule: MarkupRule | FeeRule): Response {
  return Response.json(rule, { headers: { ETag: `"${rule.version}"`, "X-Request-Id": "req_rule" } });
}

/** A server component's `searchParams` for a query string, as Next.js parses it. */
function searchParamsOf(search: string): Record<string, string | string[]> {
  const query = new URLSearchParams(search);
  const record: Record<string, string | string[]> = {};
  for (const name of new Set(query.keys())) {
    const values = query.getAll(name);
    record[name] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return record;
}

/** A page's element rendered to HTML on the "server" and parsed into a detached document. */
async function render(element: Promise<React.ReactElement>): Promise<HTMLElement> {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(await element);
  return document.body as unknown as HTMLElement;
}

const markupList = (search = "") =>
  render(MarkupRulesPage({ searchParams: Promise.resolve(searchParamsOf(search)) }));
const feeList = (search = "") =>
  render(FeeRulesPage({ searchParams: Promise.resolve(searchParamsOf(search)) }));
const markupPage = (id: string) => render(MarkupRulePage({ params: Promise.resolve({ id }) }));
const feePage = (id: string) => render(FeeRulePage({ params: Promise.resolve({ id }) }));

/** The requests besides `console.auth.me`. */
function apiRequests(): SentRequest[] {
  return api.requests.filter((request) => `${request.method} ${request.url.pathname}` !== ME);
}

/** The one request of `route`. */
function only(route: string): SentRequest {
  const sent = api.sent(route);
  expect(sent, route).toHaveLength(1);
  return sent[0] as SentRequest;
}

/** The fields a rendered form posts, as a Node `FormData` (happy-dom reads the inputs as a browser would). */
function formDataOf(form: HTMLFormElement): FormData {
  // happy-dom 17 selects the option before the one marked `selected` when it parses server-rendered HTML; a browser
  // selects the marked one, so the select is set to it first.
  for (const select of form.querySelectorAll("select")) {
    const marked = select.querySelector<HTMLOptionElement>("option[selected]");
    if (marked !== null) {
      select.value = marked.value;
    }
  }
  const window = form.ownerDocument.defaultView as unknown as { FormData: new (form: unknown) => FormData };
  const posted = new FormData();
  for (const [name, value] of new window.FormData(form).entries()) {
    posted.append(name, String(value));
  }
  return posted;
}

/** The input named `name` of a form. */
function inputOf(form: HTMLElement, name: string): HTMLInputElement {
  const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (input === null) {
    throw new Error(`no input ${name}`);
  }
  return input;
}

// Once per file: the first server render and the SDK's first call are the slowest in a fresh worker.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn("owner");
  api.on(`GET ${MARKUPS}`, () => pageAnswer([markupRule()]));
  api.on(`GET ${MARKUPS}/${MARKUP_ID}`, () => ruleAnswer(markupRule()));
  await markupList();
  await markupPage(MARKUP_ID);
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
  nextCache.revalidatePath.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Lists ------------------------------------------------------------------------------------------------------

describe("/settings/markups and /settings/fees", () => {
  it("[OAD-013 AC1] lists the rules read only for an agent, a finance member and a viewer; owners and admins get New", async () => {
    for (const role of ["agent", "finance", "viewer", "owner", "admin"] as const) {
      signedIn(role);
      api.on(`GET ${MARKUPS}`, () => pageAnswer([STACKED, markupRule(), DEFAULT_RULE]));
      api.on(`GET ${FEES}`, () => pageAnswer([feeRule()]));
      const writes = role === "owner" || role === "admin";

      for (const [page, newPath, label] of [
        [await markupList(), "/settings/markups/new", "New markup rule"],
        [await feeList(), "/settings/fees/new", "New fee rule"],
      ] as const) {
        const create = within(page).queryByRole("link", { name: label });
        expect(create?.getAttribute("href") ?? null, role).toBe(writes ? newPath : null);
        if (!writes) {
          // The gate's disabled button names the permission.
          const disabled = within(page).getByRole("button", { name: label });
          expect(disabled.hasAttribute("disabled")).toBe(true);
          expect(page.textContent).toContain("Needs the permission settings:write");
          expect(page.textContent).toContain("Read only: changing");
        }
        // Every role opens a rule's page; the list itself writes nothing.
        expect(page.querySelector("form")).toBeNull();
      }
    }
  });

  it("shows the rules in the API's order with what they do, and explains first match and stacking", async () => {
    signedIn("agent");
    api.on(`GET ${MARKUPS}`, () => pageAnswer([STACKED, markupRule(), DEFAULT_RULE]));

    const page = await markupList();

    expect(Object.fromEntries(only(`GET ${MARKUPS}`).url.searchParams)).toEqual({ limit: "50" });
    const rows = within(page).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("link").textContent)).toEqual([
      "AF promotion",
      "Long-haul economy",
      "Default markup",
    ]);
    expect(within(page).getByRole("link", { name: "Long-haul economy" }).getAttribute("href")).toBe(
      `/settings/markups/${MARKUP_ID}`,
    );
    expect(rows[0]?.textContent).toContain("Airlines: AF");
    expect(rows[0]?.textContent).toContain("-€10.00, per booking");
    expect(rows[0]?.textContent).toContain("Stackable");
    expect(rows[1]?.textContent).toContain(
      "Origin countries: FR · Cabins: Economy · Net total: 400.00 or more",
    );
    expect(rows[1]?.textContent).toContain("4 % of the net price, per traveller");
    expect(rows[1]?.textContent).toContain("at least €15.00 per unit");
    expect(rows[2]?.textContent).toContain("Every offer");
    expect(rows[2]?.textContent).toContain("Default");
    const explainer = page.querySelector("details");
    expect(explainer?.textContent).toContain(
      "The first matching rule that is not stackable is the base markup",
    );
    expect(explainer?.textContent).toContain("Every matching stackable rule with a lower priority number");
  });

  it("sends the URL's active filter and cursor, and links the next and the first page", async () => {
    signedIn("owner");
    api.on(`GET ${FEES}`, () => pageAnswer([feeRule()], "c_next"));

    const page = await feeList("active=false&cursor=c_this");

    expect(Object.fromEntries(only(`GET ${FEES}`).url.searchParams)).toEqual({
      active: "false",
      cursor: "c_this",
      limit: "50",
    });
    const paging = within(page).getByRole("navigation", { name: "Pages" });
    expect(within(paging).getByRole("link", { name: "Next page" }).getAttribute("href")).toBe(
      "/settings/fees?active=false&cursor=c_next",
    );
    expect(within(paging).getByRole("link", { name: "First page" }).getAttribute("href")).toBe(
      "/settings/fees?active=false",
    );
    const filter = within(page).getByRole("navigation", { name: "Rule filter" });
    expect(within(filter).getByRole("link", { name: "Inactive" }).getAttribute("aria-current")).toBe("page");
    expect(page.textContent).toContain("Card fee · “Card payment fee”");
    expect(page.textContent).toContain("Card brands: Visa, Mastercard");
    expect(page.querySelector("details")?.textContent).toContain(
      "for each fee type, the first matching rule applies",
    );
  });

  it("never sends a filter the API would refuse, and handles the API's codes on the server", async () => {
    signedIn("owner");
    const refused = await markupList("active=maybe");
    expect(within(refused).getByRole("alert").textContent).toContain(
      "This link has a filter the list cannot use",
    );
    expect(apiRequests()).toEqual([]);

    api.on(`GET ${MARKUPS}`, () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => markupList("active=true"))).toBe(
      `/auth/refresh?next=${encodeURIComponent("/settings/markups?active=true")}`,
    );

    api.on(`GET ${MARKUPS}`, () =>
      apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/query/cursor", code: "cursor" }] }),
    );
    const failed = await markupList("cursor=stale");
    const alert = within(failed).getByRole("alert");
    expect(alert.textContent).toContain("The markup rules could not be loaded");
    expect(alert.textContent).toContain("req_fake_1");
    expect(within(alert).getByRole("link", { name: "First page" }).getAttribute("href")).toBe(
      "/settings/markups",
    );
  });
});

// ---- A rule's page ----------------------------------------------------------------------------------------------

describe("/settings/markups/[id] and /settings/fees/[id]", () => {
  it("[OAD-013 AC1] shows an agent, a finance member and a viewer the rule read only: no form, no delete", async () => {
    for (const role of ["agent", "finance", "viewer"] as const) {
      signedIn(role);
      api.on(`GET ${MARKUPS}/${MARKUP_ID}`, () => ruleAnswer(markupRule()));
      api.on(`GET ${FEES}/${FEE_ID}`, () => ruleAnswer(feeRule()));

      const markup = await markupPage(MARKUP_ID);
      expect(markup.querySelector("form"), role).toBeNull();
      expect(within(markup).queryByRole("button", { name: "Delete rule" })).toBeNull();
      expect(markup.textContent).toContain(
        "Read only: changing markup rules needs the permission settings:write.",
      );
      expect(markup.querySelector("dl")?.textContent).toContain("4 % of the net price, per traveller");

      const fee = await feePage(FEE_ID);
      expect(fee.querySelector("form")).toBeNull();
      expect(within(fee).queryByRole("button", { name: "Delete rule" })).toBeNull();
      expect(fee.querySelector("dl")?.textContent).toContain("Card payment fee");
      expect(fee.querySelector("dl")?.textContent).toContain("Card fee");
    }
  });

  it("[OAD-013 AC1] gives an owner the rule's form, prefilled, and Delete; the default rule neither scope nor Delete", async () => {
    signedIn("owner");
    api.on(`GET ${MARKUPS}/${MARKUP_ID}`, () => ruleAnswer(markupRule()));
    api.on(`GET ${MARKUPS}/${DEFAULT_ID}`, () => ruleAnswer(DEFAULT_RULE));

    const page = await markupPage(MARKUP_ID);
    const form = within(page).getByRole("form", { name: "Save changes: Long-haul economy" });
    expect(inputOf(form, "name").value).toBe("Long-haul economy");
    expect(inputOf(form, "version").value).toBe("7");
    expect(inputOf(form, "scope.originCountries").value).toBe("FR");
    expect(inputOf(form, "percentage").value).toBe("4.0000");
    expect(inputOf(form, "min.amount").value).toBe("15.00");
    expect(inputOf(form, "currency").value).toBe("EUR");
    // The window in the OTA's time zone (Europe/Oslo, UTC+1 in November).
    expect(inputOf(form, "activeFrom").value).toBe("2026-11-01T01:00");
    expect(within(page).getByRole("button", { name: "Delete rule" })).toBeDefined();
    expect(page.textContent).toContain("Changes apply to the next search");

    const defaultPage = await markupPage(DEFAULT_ID);
    const defaultForm = within(defaultPage).getByRole("form");
    expect(defaultForm.querySelector('[name^="scope."]')).toBeNull();
    expect(defaultForm.textContent).toContain(
      "The default rule matches every offer: its scope cannot be narrowed.",
    );
    expect(within(defaultPage).queryByRole("button", { name: "Delete rule" })).toBeNull();
    expect(defaultPage.textContent).toContain("It cannot be deleted.");
  });

  it("[OAD-013 AC2] posts the rendered form as it is: an untouched form saves nothing, a changed field only that field", async () => {
    signedIn("owner");
    api.on(`GET ${MARKUPS}/${MARKUP_ID}`, () => ruleAnswer(markupRule()));
    api.on(`PATCH ${MARKUPS}/${MARKUP_ID}`, () => ruleAnswer(markupRule({ version: 8 })));
    const form = within(await markupPage(MARKUP_ID)).getByRole("form") as HTMLFormElement;

    expect(await updateMarkupRule(INITIAL_ACTION_STATE, formDataOf(form))).toEqual({
      ok: true,
      message: "Nothing to save: the rule is as shown.",
    });
    expect(api.sent(`PATCH ${MARKUPS}/${MARKUP_ID}`)).toEqual([]);

    inputOf(form, "percentage").value = "4.25";
    inputOf(form, "scope.carriers").value = "af, kl";
    expect(await updateMarkupRule(INITIAL_ACTION_STATE, formDataOf(form))).toMatchObject({ ok: true });
    const sent = only(`PATCH ${MARKUPS}/${MARKUP_ID}`);
    expect(sent.headers.get("If-Match")).toBe('"7"');
    expect(sent.body).toEqual({
      percentage: "4.25",
      scope: { originCountries: ["FR"], carriers: ["AF", "KL"], cabins: ["ECONOMY"], minNet: "400.00" },
    });
  });

  it("[FIX-W34-OTA AC3] posts the default rule's rendered form as it is: no priority, state or window, a changed percentage alone", async () => {
    signedIn("owner");
    api.on(`GET ${MARKUPS}/${DEFAULT_ID}`, () => ruleAnswer(DEFAULT_RULE));
    api.on(`PATCH ${MARKUPS}/${DEFAULT_ID}`, () =>
      ruleAnswer({ ...DEFAULT_RULE, percentage: "1.5000", version: 2 }),
    );
    const form = within(await markupPage(DEFAULT_ID)).getByRole("form") as HTMLFormElement;
    for (const name of ["priority", "isActive", "activeFrom", "activeUntil"]) {
      expect([name, form.querySelector(`[name="${name}"]`)]).toEqual([name, null]);
    }

    // The missing active checkbox is not "switched off": an untouched form saves nothing.
    expect(await updateMarkupRule(INITIAL_ACTION_STATE, formDataOf(form))).toEqual({
      ok: true,
      message: "Nothing to save: the rule is as shown.",
    });
    expect(api.sent(`PATCH ${MARKUPS}/${DEFAULT_ID}`)).toEqual([]);

    inputOf(form, "percentage").value = "1.5";
    expect(await updateMarkupRule(INITIAL_ACTION_STATE, formDataOf(form))).toMatchObject({ ok: true });
    const sent = only(`PATCH ${MARKUPS}/${DEFAULT_ID}`);
    expect(sent.headers.get("If-Match")).toBe('"1"');
    expect(sent.body).toEqual({ percentage: "1.5" });
  });

  it("[OAD-013 AC2] posts a fee rule's rendered form: its type, card brands and refundable flag as stored", async () => {
    signedIn("admin");
    api.on(`GET ${FEES}/${FEE_ID}`, () => ruleAnswer(feeRule()));
    api.on(`PATCH ${FEES}/${FEE_ID}`, () => ruleAnswer(feeRule({ version: 4 })));
    const page = await feePage(FEE_ID);
    const form = within(page).getByRole("form") as HTMLFormElement;

    const checkedType = form.querySelector<HTMLInputElement>('[name="feeType"]:checked');
    expect(checkedType?.value).toBe("payment_card");
    expect(
      [...form.querySelectorAll<HTMLInputElement>('[name="scope.cardBrands"]:checked')].map(
        (input) => input.value,
      ),
    ).toEqual(["VISA", "MASTERCARD"]);
    expect(within(page).getByRole("button", { name: "Delete rule" })).toBeDefined();

    inputOf(form, "label").value = "Card surcharge";
    form.querySelector<HTMLInputElement>('[name="refundable"]')!.checked = true;
    await updateFeeRule(INITIAL_ACTION_STATE, formDataOf(form));
    expect(only(`PATCH ${FEES}/${FEE_ID}`).body).toEqual({ label: "Card surcharge", refundable: true });
  });

  it("renders 'not found' for an id that is not a rule's (no request) and for the API's 404", async () => {
    signedIn("owner");
    const invalid = await markupPage("fee_01JA4H9Z1B3D5F7H9K1M3P5R7W");
    expect(within(invalid).getByRole("alert").textContent).toContain("Markup rule not found");
    expect(apiRequests()).toEqual([]);

    api.on(`GET ${FEES}/${FEE_ID}`, () => apiError("NOT_FOUND", 404));
    const missing = await feePage(FEE_ID);
    expect(within(missing).getByRole("alert").textContent).toContain("Fee rule not found");
    expect(within(missing).getByRole("link", { name: "All fee rules" }).getAttribute("href")).toBe(
      "/settings/fees",
    );

    api.on(`GET ${MARKUPS}/${MARKUP_ID}`, () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => markupPage(MARKUP_ID))).toBe(
      `/auth/refresh?next=${encodeURIComponent(`/settings/markups/${MARKUP_ID}`)}`,
    );
  });
});

// ---- New rules --------------------------------------------------------------------------------------------------

describe("/settings/markups/new and /settings/fees/new", () => {
  it("[OAD-013 AC1] refuses the form to every role but owner and admin, naming the permission", async () => {
    for (const role of ["agent", "finance", "viewer"] as const) {
      signedIn(role);
      for (const page of [await render(NewMarkupRulePage()), await render(NewFeeRulePage())]) {
        expect(page.querySelector("form"), role).toBeNull();
        expect(within(page).getByRole("alert").textContent).toContain(
          "You do not have permission to do this (settings:write).",
        );
      }
    }
    expect(apiRequests()).toEqual([]);
  });

  it("[OAD-013 AC2] renders the documented defaults; posted as it is, with a name and amounts, it creates the rule", async () => {
    signedIn("owner");
    api.on(`POST ${MARKUPS}`, () => ruleAnswer(markupRule()));
    api.on(`POST ${FEES}`, () => ruleAnswer(feeRule()));

    const markupForm = within(await render(NewMarkupRulePage())).getByRole("form", {
      name: "Create markup rule",
    }) as HTMLFormElement;
    const key = inputOf(markupForm, "actionKey").value;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(inputOf(markupForm, "priority").value).toBe("100");
    expect(inputOf(markupForm, "currency").value).toBe("EUR");
    inputOf(markupForm, "name").value = "Everything";
    inputOf(markupForm, "percentage").value = "3";
    await createMarkupRule(INITIAL_ACTION_STATE, formDataOf(markupForm));
    const markup = only(`POST ${MARKUPS}`);
    expect(markup.headers.get("Idempotency-Key")).toBe(key);
    expect(markup.body).toEqual({
      name: "Everything",
      scope: {},
      calculation: "percentage",
      percentage: "3",
      appliesPer: "traveler",
      priority: 100,
      stackable: false,
      isActive: true,
    });

    const feeForm = within(await render(NewFeeRulePage())).getByRole("form", {
      name: "Create fee rule",
    }) as HTMLFormElement;
    inputOf(feeForm, "name").value = "Service fee";
    inputOf(feeForm, "label").value = "Service fee";
    feeForm.querySelector<HTMLInputElement>('[name="feeType"][value="booking_service"]')!.checked = true;
    feeForm.querySelector<HTMLInputElement>('[name="calculation"][value="fixed"]')!.checked = true;
    inputOf(feeForm, "fixed.amount").value = "12.00";
    await createFeeRule(INITIAL_ACTION_STATE, formDataOf(feeForm));
    expect(only(`POST ${FEES}`).body).toEqual({
      name: "Service fee",
      label: "Service fee",
      feeType: "booking_service",
      scope: {},
      calculation: "fixed",
      fixed: { amount: "12.00", currency: "EUR" },
      appliesPer: "booking",
      priority: 100,
      refundable: false,
      isActive: true,
    });
  });
});
