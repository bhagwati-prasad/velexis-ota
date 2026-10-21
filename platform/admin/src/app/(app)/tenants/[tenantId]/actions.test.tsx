// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope, navigation and cache of Next.js and the configuration; the real API client talks ----
// ---- to a mocked fetch, so the tests see every call the forms' server actions send -----------------------------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  pathname: "/",
  searchParams: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() },
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
  redirect: navigation.redirect,
  notFound: navigation.notFound,
}));

const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => nextCache);

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import {
  assignAmadeusOffice,
  migrateTenant,
  resumeTenant,
  saveTenantNotes,
  setConnectionStatus,
  suspendTenant,
  type LifecycleState,
  type NotesState,
} from "@/app/(app)/tenants/[tenantId]/actions";
import { AssignOfficeForm } from "@/app/(app)/tenants/[tenantId]/assign-office-form";
import { ConnectionStatusForm } from "@/app/(app)/tenants/[tenantId]/connection-status-form";
import { NotesForm } from "@/app/(app)/tenants/[tenantId]/notes-form";
import TenantDetailPage from "@/app/(app)/tenants/[tenantId]/page";
import { MigrateForm, SuspendResumeForm } from "@/app/(app)/tenants/[tenantId]/suspend-form";
import { TenantTabs } from "@/app/(app)/tenants/[tenantId]/tabs";
import * as tableComponents from "@/components/ui/table";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "@/lib/session";
import {
  ASSIGN_OFFICE_STRINGS,
  CONNECTION_STATUS_STRINGS,
  LIFECYCLE_STRINGS,
  MIGRATE_STRINGS,
  NOTES_STRINGS,
  REASON_STRINGS,
  STEP_UP_STRINGS,
  TENANT_ACTION_STRINGS,
  TENANT_TAB_LABELS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key or account) ---------------------------------------------------

type Schemas = components["schemas"];

const ACCESS_TOKEN = "pad005-dummy-admin-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PAD-005 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TENANT_PATH = `/v1/admin/tenants/${TENANT_ID}`;
const PAGE_PATH = `/tenants/${TENANT_ID}`;
const OFFICES_PATH = "/v1/admin/amadeus-offices";
const OFFICE_ROW_1 = "amo_01JC8R6T0W4Y8A2C6E0G4J8M2P";
const OFFICE_ROW_2 = "amo_01JC8R6T0W4Y8A2C6E0G4J8M2Q";
const SUSPEND_JOB_ID = "job_01JB3M0S5V9X3Z7B1D5F9H3K7N";
const RESUME_JOB_ID = "job_01JB3M0S5V9X3Z7B1D5F9H3K7P";
const MIGRATE_JOB_ID = "job_01JC5N3Q7S1V5X9Z3B7D1F5H9K";
const NOTES = "Pilot customer; contact Anna for anything urgent.";
const REASON = "Card testing from the storefront reported by Stripe.";

/**
 * The budget of the warm-up hook: the first render of the page in a fresh worker loads the module graph of the tabs,
 * the dialogs and the forms, and the first dialog and action run React's action queue for the first time. On a loaded
 * runner that takes seconds; the hook only stops one that hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * How long a step that runs a server action (a round trip through the real `lib/api.ts`) and re-renders the forms
 * may take. Testing Library's 1 s default is enough on an idle machine, not on a loaded CI runner; each test's own
 * 5 s budget is unchanged.
 */
const UI_WAIT = { timeout: 3_000 } as const;

function tenant(overrides: Partial<Schemas["AdminTenant"]> = {}): Schemas["AdminTenant"] {
  return {
    id: TENANT_ID,
    key: "acme",
    name: "Acme Travel",
    legalName: "Acme Travel AS",
    status: "active",
    suspensionReason: null,
    suspendedAt: null,
    billingNotice: null,
    planCode: "early_access",
    defaultCurrency: "EUR",
    countryCode: "NO",
    timeZone: "Europe/Oslo",
    supportEmail: "support@acme-travel.example.com",
    storefrontEnvironment: "test",
    liveEnabledAt: null,
    primaryHost: "acme.ota.example.com",
    schemaVersion: "0001_baseline",
    notes: NOTES,
    createdAt: "2026-10-14T08:20:11Z",
    activatedAt: "2026-10-14T08:20:16Z",
    version: 3,
    ...overrides,
  };
}

function amadeusConnection(
  overrides: Partial<Schemas["AmadeusConnection"]> = {},
): Schemas["AmadeusConnection"] {
  return {
    id: "sc_01JA2ZB9C3E7G1J5M9Q3S7V1X5",
    environment: "test",
    credentialSource: "velexis",
    status: "active",
    officeIds: ["NCE1A0955"],
    defaultOfficeId: "NCE1A0955",
    queuingOfficeId: "NCE1A0955",
    ownerOfficeId: "NCE1A0955",
    clientId: null,
    ticketingDefaults: {},
    monitoredQueues: [],
    lastVerifiedAt: "2026-10-14T08:20:15Z",
    lastError: null,
    pendingSubmission: null,
    version: 1,
    ...overrides,
  };
}

/** The test connection of an OTA set up while the pool was empty: Velexis credentials, no office yet. */
function pendingAmadeusConnection(): Schemas["AmadeusConnection"] {
  return amadeusConnection({
    status: "pending_verification",
    officeIds: [],
    defaultOfficeId: null,
    queuingOfficeId: null,
    ownerOfficeId: null,
    lastVerifiedAt: null,
  });
}

function paymentConnection(
  overrides: Partial<Schemas["PaymentConnection"]> = {},
): Schemas["PaymentConnection"] {
  return {
    id: "ppc_01JA2ZBA4D8F2H6K0N4Q8S2V6X",
    environment: "test",
    provider: "stripe",
    accountMode: "velexis",
    status: "active",
    accountReference: null,
    publishableKey: null,
    statementDescriptorSuffix: "ACME TRAVEL",
    capabilities: {},
    connectedAt: null,
    disconnectedAt: null,
    webhookUrl: null,
    pendingSubmission: null,
    version: 1,
    ...overrides,
  };
}

function detail(overrides: Partial<Schemas["AdminTenantDetail"]> = {}): Schemas["AdminTenantDetail"] {
  return {
    tenant: tenant(),
    members: [],
    invitations: [],
    subscription: null,
    amadeusConnections: [amadeusConnection()],
    paymentConnections: [paymentConnection()],
    domains: [],
    recentJobs: [],
    recentAudit: [],
    ...overrides,
  };
}

function job(
  id: string,
  kind: Schemas["ProvisioningJobKind"],
  status: Schemas["ProvisioningJobStatus"],
  step: string | null,
): Schemas["AdminProvisioningJob"] {
  return {
    id,
    tenantId: TENANT_ID,
    tenantKey: "acme",
    kind,
    status,
    step,
    attempt: step === null ? 0 : 1,
    maxAttempts: 5,
    error: null,
    scheduledAt: "2026-10-20T10:00:00Z",
    startedAt: step === null ? null : "2026-10-20T10:00:00Z",
    finishedAt: null,
  };
}

function office(
  id: string,
  officeId: string,
  overrides: Partial<Schemas["AdminAmadeusOffice"]> = {},
): Schemas["AdminAmadeusOffice"] {
  return {
    id,
    amadeusAccountId: "ama_01JA2Y8K3M7P1R5T9W3Z7C1F5H",
    officeId,
    environment: "test",
    status: "available",
    assignedTenant: null,
    assignedAt: null,
    releaseRequestedAt: null,
    releasedAt: null,
    notes: null,
    createdAt: "2026-10-02T09:20:00Z",
    version: 1,
    ...overrides,
  };
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An error envelope of the platform API; its `message` must never reach the page. */
function apiError(code: string, status: number, details?: Record<string, unknown>): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pad005",
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/** Answers each call by `METHOD /path`; unexpected calls fail the test. */
function routes(overrides: Record<string, Route> = {}): void {
  const table: Record<string, Route> = {
    [`GET ${TENANT_PATH}`]: () => json(detail(), 200),
    ...overrides,
  };
  fetchMock.mockImplementation(async (input) => {
    const route = table[`${input.method} ${new URL(input.url).pathname}`];
    if (route === undefined) {
      throw new Error(`unexpected call ${input.method} ${input.url}`);
    }
    return route(input);
  });
}

/** The calls of `METHOD /path` so far. */
function calls(method: string, path: string): Request[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => input.method === method && new URL(input.url).pathname === path);
}

/** The JSON bodies of the calls of `METHOD /path` so far. */
async function bodies(method: string, path: string): Promise<unknown[]> {
  return Promise.all(calls(method, path).map((request) => request.clone().json() as Promise<unknown>));
}

/** Every mutation carries the admin session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

/** The cookie store of the request; `set` records the cookies a step-up writes. */
const cookieStore = {
  get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
  has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
  set: vi.fn(),
};

function resetPlatformApi(): void {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pad005_admin",
    }),
  );
  cookieStore.set.mockReset();
  nextHeaders.cookies.mockResolvedValue(cookieStore);
  nextCache.revalidatePath.mockReset();
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  navigation.pathname = PAGE_PATH;
  navigation.searchParams = new URLSearchParams();
  routes();
}

// ---- Rendering and interaction --------------------------------------------------------------------------------------

async function page(): Promise<ReactElement> {
  return TenantDetailPage({ params: Promise.resolve({ tenantId: TENANT_ID }) });
}

/** Renders `/tenants/<id>`; `rerender` renders it again as Next.js does after an action revalidated it. */
async function openTenant(): Promise<{ rerender: () => Promise<void> }> {
  const view = render(await page());
  return {
    rerender: async () => {
      view.rerender(await page());
    },
  };
}

/** Opens a tab with the pointer, as Radix's trigger expects (`mousedown` with the main button). */
function openTab(name: string): HTMLElement {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
  return screen.getByRole("tabpanel");
}

/** Submits the form of the button named `name` inside `container`, with that button as the submitter. */
function submit(name: string | RegExp, container: HTMLElement = document.body): void {
  const button = within(container).getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

/** The actions section above the tabs. */
function actionsSection(): HTMLElement {
  return screen.getByRole("region", { name: TENANT_ACTION_STRINGS.sectionTitle });
}

/** Opens a reason dialog with the button `trigger` and answers the dialog named `title`. */
async function openReasonDialog(trigger: string | RegExp, title: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  return screen.findByRole("dialog", { name: title }, UI_WAIT);
}

/** Types `reason` into the dialog and confirms with `confirm`. */
function confirmReason(dialog: HTMLElement, reason: string, confirm: string): void {
  fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: reason } });
  submit(confirm, dialog);
}

/** The notice of the action that just answered (`data-notice="done"`), once it shows. */
async function doneNotice(container: HTMLElement = document.body): Promise<HTMLElement> {
  return waitFor(() => {
    const notice = container.querySelector<HTMLElement>('[data-notice="done"]');
    if (notice === null) {
      throw new Error("no outcome yet");
    }
    return notice;
  }, UI_WAIT);
}

/** The failure notice of an action (`data-notice="failed"`), once it shows. */
async function failureNotice(container: HTMLElement = document.body): Promise<HTMLElement> {
  return waitFor(() => {
    const notice = container.querySelector<HTMLElement>('[data-notice="failed"]');
    if (notice === null) {
      throw new Error("no failure yet");
    }
    return notice;
  }, UI_WAIT);
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

/** The client components the page renders: Next.js sends their props, not their output, to the browser. */
const CLIENT_COMPONENTS: ReadonlySet<unknown> = new Set<unknown>([
  TenantTabs,
  Link,
  ...Object.values(tableComponents),
  SuspendResumeForm,
  MigrateForm,
  NotesForm,
  ConnectionStatusForm,
  AssignOfficeForm,
]);

/** Roughly the React Server Components payload of the page (as in tenants.test.tsx): what reaches the browser. */
function serverPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(serverPayload);
  }
  if (isValidElement(value)) {
    const { type, props } = value as ReactElement<Record<string, unknown>>;
    if (typeof type === "function" && !CLIENT_COMPONENTS.has(type)) {
      return serverPayload((type as (properties: Record<string, unknown>) => unknown)(props));
    }
    return {
      type: typeof type === "string" ? type : CLIENT_COMPONENTS.has(type) ? "client" : "other",
      props: serverPayload(props),
    };
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, serverPayload(entry)]));
  }
  return value;
}

/**
 * Once per file, before any test: the first render of the page with its forms, a reason dialog and a server action
 * through the real API client are the slowest steps in a fresh worker, and on a busy CI runner they would otherwise
 * land in the first test's own five seconds. Nothing of it stays: each test gets a fresh API and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routes({ [`POST ${TENANT_PATH}/suspend`]: () => apiError("CONFLICT", 409, { reason: "not_active" }) });
  await openTenant();
  const dialog = await openReasonDialog(
    LIFECYCLE_STRINGS.suspend,
    LIFECYCLE_STRINGS.suspendTitle("Acme Travel"),
  );
  confirmReason(dialog, "Warm-up reason", LIFECYCLE_STRINGS.suspendConfirm);
  await screen.findByText(LIFECYCLE_STRINGS.notActive, {}, { timeout: WARM_UP_TIMEOUT_MS });
  for (const label of Object.values(TENANT_TAB_LABELS)) {
    openTab(label);
  }
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- Suspend and resume ------------------------------------------------------------------------------------------

describe("suspend and resume (PADR-0014, PF-82)", () => {
  it("[PAD-005 AC1] suspending requires a reason and shows the new status and the suspend job [PF-82]", async () => {
    routes({
      [`POST ${TENANT_PATH}/suspend`]: () =>
        json(
          {
            tenant: tenant({
              status: "suspended",
              suspensionReason: "abuse",
              suspendedAt: "2026-10-20T10:00:00Z",
              version: 4,
            }),
            job: job(SUSPEND_JOB_ID, "suspend", "running", "dispatch"),
          },
          202,
        ),
    });
    await openTenant();
    expect(within(actionsSection()).queryByRole("button", { name: LIFECYCLE_STRINGS.resume })).toBeNull();

    const dialog = await openReasonDialog(
      LIFECYCLE_STRINGS.suspend,
      LIFECYCLE_STRINGS.suspendTitle("Acme Travel"),
    );
    expect(within(dialog).getByText(LIFECYCLE_STRINGS.suspendDescription)).toBeTruthy();
    // The admin chooses the kind; billing is not offered (billing sync sets it).
    const kind = within(dialog).getByLabelText(LIFECYCLE_STRINGS.suspensionReasonLabel) as HTMLSelectElement;
    expect([...kind.options].map((option) => option.value)).toEqual(["abuse", "request", "admin"]);
    fireEvent.change(kind, { target: { value: "abuse" } });

    // No reason, then four characters: refused at the field, nothing is sent.
    submit(LIFECYCLE_STRINGS.suspendConfirm, dialog);
    expect(within(dialog).getByText(REASON_STRINGS.required)).toBeTruthy();
    confirmReason(dialog, "Card", LIFECYCLE_STRINGS.suspendConfirm);
    expect(within(dialog).getByText(REASON_STRINGS.tooShort)).toBeTruthy();
    expect(calls("POST", `${TENANT_PATH}/suspend`)).toHaveLength(0);

    confirmReason(dialog, `  ${REASON}  `, LIFECYCLE_STRINGS.suspendConfirm);
    const notice = await doneNotice(actionsSection());

    expect(await bodies("POST", `${TENANT_PATH}/suspend`)).toEqual([
      { suspensionReason: "abuse", reason: REASON },
    ]);
    expectSessionHeaders(calls("POST", `${TENANT_PATH}/suspend`)[0]);
    // The new status and the job, with a link to the job's page.
    expect(notice.getAttribute("role")).toBe("status");
    expect(within(notice).getByText(LIFECYCLE_STRINGS.suspended)).toBeTruthy();
    expect(within(notice).getByText("Suspended")).toBeTruthy();
    expect(within(notice).getByRole("link", { name: SUSPEND_JOB_ID }).getAttribute("href")).toBe(
      `/provisioning-jobs/${SUSPEND_JOB_ID}`,
    );
    expect(within(notice).getByText("Suspension")).toBeTruthy();
    expect(within(notice).getByText("Running")).toBeTruthy();
    expect(within(notice).getByText(TENANT_ACTION_STRINGS.stepOf("dispatch"))).toBeTruthy();
    // The page is revalidated, so its header and its jobs tab follow.
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAGE_PATH);
  });

  it("[PAD-005 AC1] resuming requires a reason and shows the new status and the resume job [PF-82]", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () =>
        json(
          detail({
            tenant: tenant({
              status: "suspended",
              suspensionReason: "abuse",
              suspendedAt: "2026-10-19T10:00:00Z",
            }),
          }),
          200,
        ),
      [`POST ${TENANT_PATH}/resume`]: () =>
        json({ tenant: tenant({ version: 5 }), job: job(RESUME_JOB_ID, "resume", "queued", null) }, 202),
    });
    await openTenant();
    expect(within(actionsSection()).queryByRole("button", { name: LIFECYCLE_STRINGS.suspend })).toBeNull();

    const dialog = await openReasonDialog(
      LIFECYCLE_STRINGS.resume,
      LIFECYCLE_STRINGS.resumeTitle("Acme Travel"),
    );
    expect(within(dialog).getByText(LIFECYCLE_STRINGS.resumeDescription)).toBeTruthy();
    submit(LIFECYCLE_STRINGS.resumeConfirm, dialog);
    expect(within(dialog).getByText(REASON_STRINGS.required)).toBeTruthy();
    expect(calls("POST", `${TENANT_PATH}/resume`)).toHaveLength(0);

    confirmReason(dialog, "The OTA removed the test scripts.", LIFECYCLE_STRINGS.resumeConfirm);
    const notice = await doneNotice(actionsSection());

    expect(await bodies("POST", `${TENANT_PATH}/resume`)).toEqual([
      { reason: "The OTA removed the test scripts." },
    ]);
    expectSessionHeaders(calls("POST", `${TENANT_PATH}/resume`)[0]);
    expect(within(notice).getByText(LIFECYCLE_STRINGS.resumed)).toBeTruthy();
    expect(within(notice).getByText("Active")).toBeTruthy();
    expect(within(notice).getByRole("link", { name: RESUME_JOB_ID }).getAttribute("href")).toBe(
      `/provisioning-jobs/${RESUME_JOB_ID}`,
    );
    expect(within(notice).getByText("Resumption")).toBeTruthy();
    expect(within(notice).getByText("Queued")).toBeTruthy();
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAGE_PATH);
  });

  it("[PAD-005 AC1] the server actions refuse a missing reason, a short one and the billing kind without calling the API", async () => {
    const idle: LifecycleState = { status: "idle" };
    for (const [action, fields] of [
      [suspendTenant, { tenantId: TENANT_ID, suspensionReason: "abuse" }],
      [suspendTenant, { tenantId: TENANT_ID, suspensionReason: "abuse", reason: "  abcd  " }],
      [suspendTenant, { tenantId: TENANT_ID, suspensionReason: "billing", reason: REASON }],
      [suspendTenant, { tenantId: "acme", suspensionReason: "abuse", reason: REASON }],
      [resumeTenant, { tenantId: TENANT_ID }],
      [resumeTenant, { tenantId: TENANT_ID, reason: "x".repeat(501) }],
    ] as const) {
      const state = await action(idle, formData(fields));
      expect(state).toMatchObject({ status: "failed", code: "VALIDATION_FAILED" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await suspendTenant(idle, formData({ tenantId: TENANT_ID, suspensionReason: "abuse" }))).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      message: REASON_STRINGS.required,
    });
    expect(
      await suspendTenant(
        idle,
        formData({ tenantId: TENANT_ID, suspensionReason: "billing", reason: REASON }),
      ),
    ).toMatchObject({ message: LIFECYCLE_STRINGS.suspensionReasonInvalid });
  });

  it("explains a billing suspension, and words the conflicts the API answers, never with its own text", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () =>
        json(detail({ tenant: tenant({ status: "suspended", suspensionReason: "billing" }) }), 200),
      [`POST ${TENANT_PATH}/resume`]: () => apiError("CONFLICT", 409, { reason: "subscription_not_active" }),
      [`POST ${TENANT_PATH}/suspend`]: () => apiError("CONFLICT", 409, { reason: "not_active" }),
    });
    await openTenant();

    const dialog = await openReasonDialog(
      LIFECYCLE_STRINGS.resume,
      LIFECYCLE_STRINGS.resumeTitle("Acme Travel"),
    );
    expect(dialog.textContent).toContain(LIFECYCLE_STRINGS.resumeBillingDescription);
    confirmReason(dialog, "Paid by bank transfer.", LIFECYCLE_STRINGS.resumeConfirm);
    const notice = await failureNotice(actionsSection());
    expect(notice.textContent).toBe(LIFECYCLE_STRINGS.subscriptionNotActive);
    expect(notice.getAttribute("data-code")).toBe("CONFLICT");
    expect(document.body.textContent).not.toContain("The API's own text");
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // A suspension of an OTA that is no longer active, from a stale page.
    expect(
      await suspendTenant(
        { status: "idle" },
        formData({ tenantId: TENANT_ID, suspensionReason: "admin", reason: REASON }),
      ),
    ).toEqual({ status: "failed", code: "CONFLICT", message: LIFECYCLE_STRINGS.notActive });
  });

  it("offers neither action for an OTA in set-up, and sends an ended session to sign-in and back", async () => {
    routes({
      [`GET ${TENANT_PATH}`]: () =>
        json(detail({ tenant: tenant({ status: "provisioning", schemaVersion: null }) }), 200),
      [`POST ${TENANT_PATH}/suspend`]: () => apiError("TOKEN_EXPIRED", 401),
    });
    await openTenant();
    const section = actionsSection();
    expect(within(section).getByText(LIFECYCLE_STRINGS.notApplicable)).toBeTruthy();
    expect(within(section).queryByRole("button", { name: LIFECYCLE_STRINGS.suspend })).toBeNull();
    expect(within(section).queryByRole("button", { name: LIFECYCLE_STRINGS.resume })).toBeNull();
    // Without a schema there is nothing to migrate either.
    expect(within(section).getByText(MIGRATE_STRINGS.noSchema)).toBeTruthy();
    expect(within(section).queryByRole("button", { name: MIGRATE_STRINGS.migrate })).toBeNull();

    await expect(
      suspendTenant(
        { status: "idle" },
        formData({ tenantId: TENANT_ID, suspensionReason: "admin", reason: REASON }),
      ),
    ).rejects.toThrow(`NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: PAGE_PATH }).toString()}`);
  });

  it("asks for a step-up on REAUTH_REQUIRED and suspends again with the same reason after the code", async () => {
    let attempts = 0;
    routes({
      [`POST ${TENANT_PATH}/suspend`]: () => {
        attempts += 1;
        return attempts === 1
          ? apiError("REAUTH_REQUIRED", 401)
          : json(
              {
                tenant: tenant({ status: "suspended", suspensionReason: "request", version: 4 }),
                job: job(SUSPEND_JOB_ID, "suspend", "running", "dispatch"),
              },
              202,
            );
      },
      "POST /v1/admin/auth/step-up": () =>
        json(
          {
            accessToken: "pad005-stepped-up-access-token",
            accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
            refreshToken: "pad005-stepped-up-refresh-token",
            refreshTokenExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
            admin: {
              id: "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9",
              email: "lena.holm@velexis.example.com",
              fullName: "Lena Holm",
              features: {},
            },
          },
          200,
        ),
    });
    await openTenant();
    const dialog = await openReasonDialog(
      LIFECYCLE_STRINGS.suspend,
      LIFECYCLE_STRINGS.suspendTitle("Acme Travel"),
    );
    fireEvent.change(within(dialog).getByLabelText(LIFECYCLE_STRINGS.suspensionReasonLabel), {
      target: { value: "request" },
    });
    confirmReason(dialog, "The OTA asked to pause its storefront.", LIFECYCLE_STRINGS.suspendConfirm);

    const stepUp = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
    fireEvent.change(within(stepUp).getByLabelText(STEP_UP_STRINGS.codeLabel), {
      target: { value: "492039" },
    });
    submit(STEP_UP_STRINGS.submit, stepUp);
    // The modal dialog hides the rest of the page from the accessibility tree until it closes.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);

    const notice = await doneNotice(actionsSection());
    expect(within(notice).getByText(LIFECYCLE_STRINGS.suspended)).toBeTruthy();
    expect(await bodies("POST", "/v1/admin/auth/step-up")).toEqual([{ code: "492039" }]);
    expect(cookieStore.set.mock.calls.map(([name]) => name as string)).toEqual([
      ACCESS_TOKEN_COOKIE,
      REFRESH_TOKEN_COOKIE,
    ]);
    // Both attempts sent the same kind and reason.
    const sent = { suspensionReason: "request", reason: "The OTA asked to pause its storefront." };
    expect(await bodies("POST", `${TENANT_PATH}/suspend`)).toEqual([sent, sent]);
  });
});

// ---- Migrate -----------------------------------------------------------------------------------------------------

describe("migrate", () => {
  it("migrates after a confirmation, to the latest or to a target version, and shows the job", async () => {
    routes({
      [`POST ${TENANT_PATH}/migrate`]: () =>
        json({ job: job(MIGRATE_JOB_ID, "migrate", "running", "dispatch") }, 202),
    });
    await openTenant();
    const section = actionsSection();
    expect(within(section).getByText(MIGRATE_STRINGS.intro("0001_baseline"))).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: MIGRATE_STRINGS.migrate }));
    const confirm = await screen.findByRole(
      "alertdialog",
      { name: MIGRATE_STRINGS.migrateTitle("Acme Travel") },
      UI_WAIT,
    );
    expect(within(confirm).getByText(MIGRATE_STRINGS.migrateAll)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: MIGRATE_STRINGS.migrateConfirm }));

    const notice = await doneNotice(section);
    expect(within(notice).getByText(MIGRATE_STRINGS.started)).toBeTruthy();
    expect(within(notice).getByRole("link", { name: MIGRATE_JOB_ID }).getAttribute("href")).toBe(
      `/provisioning-jobs/${MIGRATE_JOB_ID}`,
    );
    expect(within(notice).getByText("Migration")).toBeTruthy();
    expectSessionHeaders(calls("POST", `${TENANT_PATH}/migrate`)[0]);

    fireEvent.change(within(section).getByLabelText(MIGRATE_STRINGS.targetVersionLabel), {
      target: { value: " 0002_add_ticketing_queue " },
    });
    fireEvent.click(within(section).getByRole("button", { name: MIGRATE_STRINGS.migrate }));
    const second = await screen.findByRole("alertdialog", {}, UI_WAIT);
    expect(within(second).getByText(MIGRATE_STRINGS.migrateTo("0002_add_ticketing_queue"))).toBeTruthy();
    fireEvent.click(within(second).getByRole("button", { name: MIGRATE_STRINGS.migrateConfirm }));
    await waitFor(() => expect(calls("POST", `${TENANT_PATH}/migrate`)).toHaveLength(2), UI_WAIT);

    expect(await bodies("POST", `${TENANT_PATH}/migrate`)).toEqual([
      {},
      { targetVersion: "0002_add_ticketing_queue" },
    ]);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAGE_PATH);
  });

  it("refuses a malformed target version at its field without a call, and words an active migration", async () => {
    routes({
      [`POST ${TENANT_PATH}/migrate`]: () => apiError("CONFLICT", 409, { reason: "migrate_job_active" }),
    });
    await openTenant();
    const section = actionsSection();
    const field = within(section).getByLabelText(MIGRATE_STRINGS.targetVersionLabel);

    fireEvent.change(field, { target: { value: "latest" } });
    fireEvent.click(within(section).getByRole("button", { name: MIGRATE_STRINGS.migrate }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", {}, UI_WAIT)).getByRole("button", {
        name: MIGRATE_STRINGS.migrateConfirm,
      }),
    );
    await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"), UI_WAIT);
    // At the field, read with it, and not again in a notice.
    expect(within(section).getAllByText(MIGRATE_STRINGS.targetVersionInvalid)).toHaveLength(1);
    expect(
      field
        .getAttribute("aria-describedby")
        ?.split(" ")
        .map((id) => document.getElementById(id)?.textContent),
    ).toEqual([MIGRATE_STRINGS.targetVersionHint, MIGRATE_STRINGS.targetVersionInvalid]);
    expect(section.querySelector('[data-notice="failed"]')).toBeNull();
    expect(calls("POST", `${TENANT_PATH}/migrate`)).toHaveLength(0);

    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(within(section).getByRole("button", { name: MIGRATE_STRINGS.migrate }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", {}, UI_WAIT)).getByRole("button", {
        name: MIGRATE_STRINGS.migrateConfirm,
      }),
    );
    await waitFor(
      () =>
        expect(section.querySelector('[data-notice="failed"]')?.textContent).toBe(
          MIGRATE_STRINGS.migrateJobActive,
        ),
      UI_WAIT,
    );
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(
      await migrateTenant({ status: "idle" }, formData({ tenantId: "ten_short", targetVersion: "" })),
    ).toMatchObject({ status: "failed", message: TENANT_ACTION_STRINGS.formExpired });
    expect(calls("POST", `${TENANT_PATH}/migrate`)).toHaveLength(1);

    // A target version the API refuses shows at the field too, in the admin's words.
    routes({
      [`POST ${TENANT_PATH}/migrate`]: () =>
        json(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "The API's own text, never shown",
              status: 400,
              fieldErrors: [
                { path: "/targetVersion", code: "pattern", message: "The API's own text, never shown" },
              ],
            },
          },
          400,
        ),
    });
    expect(
      await migrateTenant({ status: "idle" }, formData({ tenantId: TENANT_ID, targetVersion: "0002_x" })),
    ).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      message: MIGRATE_STRINGS.targetVersionInvalid,
      fieldError: MIGRATE_STRINGS.targetVersionInvalid,
    });
  });
});

// ---- Connections ---------------------------------------------------------------------------------------------------

describe("connection status", () => {
  it("disables a connection with a reason and shows its new status", async () => {
    routes({
      [`POST ${TENANT_PATH}/connections/amadeus/test/status`]: () =>
        json(amadeusConnection({ status: "disabled", version: 2 }), 200),
    });
    await openTenant();
    const connections = openTab(TENANT_TAB_LABELS.connections);
    const card = within(connections).getByRole("region", { name: "Amadeus, Test" });

    const trigger = within(card).getByRole("button", {
      name: `${CONNECTION_STATUS_STRINGS.disable}${CONNECTION_STATUS_STRINGS.of("Amadeus, Test")}`,
    });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole(
      "dialog",
      { name: CONNECTION_STATUS_STRINGS.disableTitle("Amadeus, Test") },
      UI_WAIT,
    );
    expect(within(dialog).getByText(CONNECTION_STATUS_STRINGS.disableAmadeus)).toBeTruthy();
    confirmReason(dialog, "abc", CONNECTION_STATUS_STRINGS.disableConfirm);
    expect(calls("POST", `${TENANT_PATH}/connections/amadeus/test/status`)).toHaveLength(0);
    confirmReason(
      dialog,
      "Stop new searches while the abuse case is reviewed.",
      CONNECTION_STATUS_STRINGS.disableConfirm,
    );

    const notice = await doneNotice(card);
    expect(within(notice).getByText("Disabled")).toBeTruthy();
    expect(await bodies("POST", `${TENANT_PATH}/connections/amadeus/test/status`)).toEqual([
      { status: "disabled", reason: "Stop new searches while the abuse case is reviewed." },
    ]);
    expectSessionHeaders(calls("POST", `${TENANT_PATH}/connections/amadeus/test/status`)[0]);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAGE_PATH);
  });

  it("enables a disabled payment connection, and words the conflicts", async () => {
    let answer: Response = apiError("CONFLICT", 409, { reason: "deauthorized", status: "disabled" });
    routes({
      [`GET ${TENANT_PATH}`]: () =>
        json(detail({ paymentConnections: [paymentConnection({ status: "disabled" })] }), 200),
      [`POST ${TENANT_PATH}/connections/payment/test/status`]: () => answer,
    });
    await openTenant();
    const card = within(openTab(TENANT_TAB_LABELS.connections)).getByRole("region", { name: "Stripe, Test" });
    const name = `${CONNECTION_STATUS_STRINGS.enable}${CONNECTION_STATUS_STRINGS.of("Stripe, Test")}`;

    fireEvent.click(within(card).getByRole("button", { name }));
    let dialog = await screen.findByRole(
      "dialog",
      { name: CONNECTION_STATUS_STRINGS.enableTitle("Stripe, Test") },
      UI_WAIT,
    );
    confirmReason(dialog, "The abuse case is closed.", CONNECTION_STATUS_STRINGS.enableConfirm);
    expect((await failureNotice(card)).textContent).toBe(CONNECTION_STATUS_STRINGS.deauthorized);
    expect(document.body.textContent).not.toContain("The API's own text");

    answer = json(paymentConnection({ status: "active", version: 3 }), 200);
    fireEvent.click(within(card).getByRole("button", { name }));
    dialog = await screen.findByRole(
      "dialog",
      { name: CONNECTION_STATUS_STRINGS.enableTitle("Stripe, Test") },
      UI_WAIT,
    );
    confirmReason(dialog, "The abuse case is closed.", CONNECTION_STATUS_STRINGS.enableConfirm);
    const notice = await doneNotice(card);
    expect(within(notice).getByText("Active")).toBeTruthy();
    expect(card.querySelector('[data-notice="failed"]')).toBeNull();
    expect(await bodies("POST", `${TENANT_PATH}/connections/payment/test/status`)).toEqual([
      { status: "active", reason: "The abuse case is closed." },
      { status: "active", reason: "The abuse case is closed." },
    ]);

    // Fields the form never sends that way (a made-up kind) are refused before any call.
    expect(
      await setConnectionStatus(
        { status: "idle" },
        formData({
          tenantId: TENANT_ID,
          kind: "domain",
          environment: "test",
          status: "disabled",
          reason: REASON,
        }),
      ),
    ).toMatchObject({ status: "failed", message: TENANT_ACTION_STRINGS.formExpired });
    expect(calls("POST", `${TENANT_PATH}/connections/payment/test/status`)).toHaveLength(2);
  });
});

// ---- Notes and legal name ------------------------------------------------------------------------------------------

describe("notes and legal name", () => {
  async function openEditor(): Promise<HTMLElement> {
    await openTenant();
    fireEvent.click(screen.getByRole("button", { name: NOTES_STRINGS.edit }));
    return screen.getByRole("form", { name: NOTES_STRINGS.formTitle });
  }

  it("[PAD-005 AC2] a stale notes edit shows the reload message (412) and keeps what was typed", async () => {
    routes({ [`PATCH ${TENANT_PATH}`]: () => apiError("PRECONDITION_FAILED", 412) });
    const form = await openEditor();
    const notes = within(form).getByLabelText(NOTES_STRINGS.notesLabel) as HTMLTextAreaElement;
    expect(notes.value).toBe(NOTES);
    expect((within(form).getByLabelText(NOTES_STRINGS.legalNameLabel) as HTMLInputElement).value).toBe(
      "Acme Travel AS",
    );

    fireEvent.change(notes, { target: { value: "Moved to the Growth plan in November." } });
    submit(NOTES_STRINGS.save, form);
    const notice = await failureNotice(form);

    // The edit was sent against the version the page showed.
    const [patch] = calls("PATCH", TENANT_PATH);
    expect(patch?.headers.get("if-match")).toBe('"3"');
    expectSessionHeaders(patch);
    expect(await bodies("PATCH", TENANT_PATH)).toEqual([
      { notes: "Moved to the Growth plan in November.", legalName: "Acme Travel AS" },
    ]);
    // The reload message, with a full reload of the page, and the typed text still there.
    expect(notice.getAttribute("data-code")).toBe("PRECONDITION_FAILED");
    expect(within(notice).getByText(NOTES_STRINGS.stale)).toBeTruthy();
    expect(
      within(notice).getByRole("link", { name: TENANT_ACTION_STRINGS.reload }).getAttribute("href"),
    ).toBe(PAGE_PATH);
    expect(notes.value).toBe("Moved to the Growth plan in November.");
    expect(document.body.textContent).not.toContain("The API's own text");
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("saves with If-Match, clears an emptied field, and sends the saved version next time", async () => {
    let version = 3;
    routes({
      [`PATCH ${TENANT_PATH}`]: async (request) => {
        const body = (await request.clone().json()) as { notes: string | null; legalName: string | null };
        version += 1;
        return json(tenant({ notes: body.notes, legalName: body.legalName, version }), 200);
      },
    });
    const form = await openEditor();
    fireEvent.change(within(form).getByLabelText(NOTES_STRINGS.legalNameLabel), { target: { value: "  " } });
    fireEvent.change(within(form).getByLabelText(NOTES_STRINGS.notesLabel), {
      target: { value: "  Pilot customer.  " },
    });
    submit(NOTES_STRINGS.save, form);

    expect(await screen.findByText(NOTES_STRINGS.saved, {}, UI_WAIT)).toBeTruthy();
    expect(screen.queryByRole("form", { name: NOTES_STRINGS.formTitle })).toBeNull();
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAGE_PATH);

    // Edited again before the revalidated page arrived: the form starts from what was saved, with its version.
    fireEvent.click(screen.getByRole("button", { name: NOTES_STRINGS.edit }));
    const again = screen.getByRole("form", { name: NOTES_STRINGS.formTitle });
    expect((within(again).getByLabelText(NOTES_STRINGS.notesLabel) as HTMLTextAreaElement).value).toBe(
      "Pilot customer.",
    );
    submit(NOTES_STRINGS.save, again);
    await waitFor(() => expect(calls("PATCH", TENANT_PATH)).toHaveLength(2), UI_WAIT);

    expect(calls("PATCH", TENANT_PATH).map((request) => request.headers.get("if-match"))).toEqual([
      '"3"',
      '"4"',
    ]);
    expect(await bodies("PATCH", TENANT_PATH)).toEqual([
      { notes: "Pilot customer.", legalName: null },
      { notes: "Pilot customer.", legalName: null },
    ]);
  });

  it("refuses notes or a legal name that are too long at their field, and a form without its version", async () => {
    const previous: NotesState = {
      status: "idle",
      version: 3,
      values: { notes: NOTES, legalName: "Acme Travel AS" },
      fieldErrors: {},
    };
    const tooLong = await saveTenantNotes(
      previous,
      formData({ tenantId: TENANT_ID, version: "3", notes: "😀".repeat(4001), legalName: "x".repeat(201) }),
    );
    expect(tooLong).toMatchObject({
      status: "failed",
      code: "VALIDATION_FAILED",
      version: 3,
      fieldErrors: { notes: NOTES_STRINGS.notesTooLong, legalName: NOTES_STRINGS.legalNameTooLong },
    });
    expect(
      await saveTenantNotes(previous, formData({ tenantId: TENANT_ID, notes: "x", legalName: "" })),
    ).toMatchObject({ status: "failed", message: TENANT_ACTION_STRINGS.formExpired });
    // Exactly 4,000 code points pass the check.
    routes({ [`PATCH ${TENANT_PATH}`]: () => json(tenant({ notes: "😀".repeat(4000), version: 4 }), 200) });
    expect(
      await saveTenantNotes(
        previous,
        formData({
          tenantId: TENANT_ID,
          version: "3",
          notes: "😀".repeat(4000),
          legalName: "Acme Travel AS",
        }),
      ),
    ).toMatchObject({ status: "saved", version: 4 });
    expect(calls("PATCH", TENANT_PATH)).toHaveLength(1);
  });

  it("words a rate limit with its wait and puts the API's field errors at their fields, keeping what was typed", async () => {
    const previous: NotesState = {
      status: "idle",
      version: 3,
      values: { notes: NOTES, legalName: "Acme Travel AS" },
      fieldErrors: {},
    };
    const typed = { tenantId: TENANT_ID, version: "3", notes: "Typed notes.", legalName: "Typed AS" };
    let answer: Response = new Response(
      JSON.stringify({
        error: { code: "RATE_LIMITED", message: "The API's own text, never shown", status: 429 },
      }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "90" } },
    );
    routes({ [`PATCH ${TENANT_PATH}`]: () => answer });

    expect(await saveTenantNotes(previous, formData(typed))).toEqual({
      status: "failed",
      code: "RATE_LIMITED",
      version: 3,
      values: { notes: "Typed notes.", legalName: "Typed AS" },
      fieldErrors: {},
      message: TENANT_ACTION_STRINGS.rateLimitedFor(90),
    });
    expect(TENANT_ACTION_STRINGS.rateLimitedFor(90)).toContain("2 minutes");

    answer = json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "The API's own text, never shown",
          status: 400,
          fieldErrors: [
            { path: "/legalName", code: "maxLength", message: "The API's own text, never shown" },
          ],
        },
      },
      400,
    );
    expect(await saveTenantNotes(previous, formData(typed))).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      version: 3,
      values: { notes: "Typed notes.", legalName: "Typed AS" },
      fieldErrors: { legalName: NOTES_STRINGS.legalNameTooLong },
    });
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });
});

// ---- Assign an office ---------------------------------------------------------------------------------------------

describe("assign an office", () => {
  /** An OTA whose test connection waits for an office, and the pool's available offices of test. */
  function pendingRoutes(overrides: Record<string, Route> = {}): void {
    routes({
      [`GET ${TENANT_PATH}`]: () => json(detail({ amadeusConnections: [pendingAmadeusConnection()] }), 200),
      [`GET ${OFFICES_PATH}`]: () =>
        json(
          {
            data: [
              office(OFFICE_ROW_1, "PAR1A0001", { notes: "PAD005-SENTINEL-OFFICE-NOTES" }),
              office(OFFICE_ROW_2, "PAR1A0002"),
            ],
            page: { nextCursor: null, limit: 200 },
          },
          200,
        ),
      ...overrides,
    });
  }

  it("[PAD-005 AC3] assigning an office turns the connection active on the page", async () => {
    pendingRoutes({
      [`POST ${OFFICES_PATH}/${OFFICE_ROW_2}/assign`]: () =>
        json(
          {
            office: office(OFFICE_ROW_2, "PAR1A0002", {
              status: "assigned",
              assignedTenant: { id: TENANT_ID, key: "acme" },
              assignedAt: "2026-10-20T10:12:30Z",
              version: 2,
            }),
            connection: amadeusConnection({
              officeIds: ["PAR1A0002"],
              defaultOfficeId: "PAR1A0002",
              queuingOfficeId: "PAR1A0002",
              ownerOfficeId: "PAR1A0002",
              lastVerifiedAt: null,
              version: 2,
            }),
          },
          200,
        ),
    });
    const view = await openTenant();
    // The page asks the pool for the available offices of the connection's environment.
    const [list] = calls("GET", OFFICES_PATH);
    expect([...new URL(list?.url ?? "").searchParams.entries()].sort()).toEqual([
      ["environment", "test"],
      ["limit", "200"],
      ["status", "available"],
    ]);
    expectSessionHeaders(list);

    let card = within(openTab(TENANT_TAB_LABELS.connections)).getByRole("region", { name: "Amadeus, Test" });
    expect(within(card).getByText("Pending")).toBeTruthy();
    const assign = within(card).getByRole("region", { name: ASSIGN_OFFICE_STRINGS.title });
    const select = within(assign).getByLabelText(ASSIGN_OFFICE_STRINGS.officeLabel) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["PAR1A0001", "PAR1A0002"]);
    fireEvent.change(select, { target: { value: OFFICE_ROW_2 } });
    submit(ASSIGN_OFFICE_STRINGS.assign, assign);

    const notice = await doneNotice(card);
    expect(await bodies("POST", `${OFFICES_PATH}/${OFFICE_ROW_2}/assign`)).toEqual([{ tenantId: TENANT_ID }]);
    expectSessionHeaders(calls("POST", `${OFFICES_PATH}/${OFFICE_ROW_2}/assign`)[0]);
    expect(within(notice).getByText(ASSIGN_OFFICE_STRINGS.assigned("PAR1A0002"))).toBeTruthy();
    expect(within(notice).getByText("Active")).toBeTruthy();
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(PAGE_PATH);

    // Next.js renders the revalidated page with the action's answer: the card shows the active connection and its
    // office, the picker is gone (no office list is loaded), and the outcome stays.
    fetchMock.mockClear();
    routes({
      [`GET ${TENANT_PATH}`]: () =>
        json(
          detail({
            amadeusConnections: [
              amadeusConnection({
                officeIds: ["PAR1A0002"],
                defaultOfficeId: "PAR1A0002",
                queuingOfficeId: "PAR1A0002",
                ownerOfficeId: "PAR1A0002",
                version: 2,
              }),
            ],
          }),
          200,
        ),
    });
    await view.rerender();
    expect(calls("GET", OFFICES_PATH)).toHaveLength(0);
    card = within(screen.getByRole("tabpanel")).getByRole("region", { name: "Amadeus, Test" });
    const status = within(card).getByText("Status").nextElementSibling as HTMLElement;
    expect(within(status).getByText("Active")).toBeTruthy();
    expect(within(card).getAllByText("PAR1A0002").length).toBeGreaterThan(0);
    expect(within(card).queryByRole("region", { name: ASSIGN_OFFICE_STRINGS.title })).toBeNull();
    expect(within(card).getByText(ASSIGN_OFFICE_STRINGS.assigned("PAR1A0002"))).toBeTruthy();
  });

  it("says when no office is available or the list cannot be loaded, and words an office another OTA got", async () => {
    pendingRoutes({
      [`GET ${OFFICES_PATH}`]: () => json({ data: [], page: { nextCursor: null, limit: 200 } }, 200),
    });
    await openTenant();
    let card = within(openTab(TENANT_TAB_LABELS.connections)).getByRole("region", { name: "Amadeus, Test" });
    expect(within(card).getByText(ASSIGN_OFFICE_STRINGS.noneAvailable, { exact: false })).toBeTruthy();
    expect(
      within(card).getByRole("link", { name: ASSIGN_OFFICE_STRINGS.poolLink }).getAttribute("href"),
    ).toBe("/amadeus/offices?environment=test&status=available");
    expect(within(card).queryByRole("button", { name: ASSIGN_OFFICE_STRINGS.assign })).toBeNull();
    cleanup();

    // The tenant still shows when the pool cannot be listed.
    pendingRoutes({ [`GET ${OFFICES_PATH}`]: () => apiError("INTERNAL_ERROR", 500) });
    await openTenant();
    card = within(openTab(TENANT_TAB_LABELS.connections)).getByRole("region", { name: "Amadeus, Test" });
    expect(within(card).getByText(ASSIGN_OFFICE_STRINGS.unavailable, { exact: false })).toBeTruthy();
    cleanup();

    pendingRoutes({
      [`POST ${OFFICES_PATH}/${OFFICE_ROW_1}/assign`]: () => apiError("AMADEUS_OFFICE_UNAVAILABLE", 409),
    });
    await openTenant();
    card = within(openTab(TENANT_TAB_LABELS.connections)).getByRole("region", { name: "Amadeus, Test" });
    submit(ASSIGN_OFFICE_STRINGS.assign, card);
    expect((await failureNotice(card)).textContent).toBe(ASSIGN_OFFICE_STRINGS.officeUnavailable);
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();

    // A made-up pool entry is refused before any call.
    expect(
      await assignAmadeusOffice(
        { status: "idle" },
        formData({ tenantId: TENANT_ID, officeRowId: "NCE1A0955" }),
      ),
    ).toMatchObject({ status: "failed", message: ASSIGN_OFFICE_STRINGS.officeInvalid });
    expect(calls("POST", `${OFFICES_PATH}/NCE1A0955/assign`)).toHaveLength(0);
  });

  it("offers no office for an active connection or the OTA's own credentials, and hands the forms only ids and statuses", async () => {
    pendingRoutes();
    const tree = await page();
    // What Next.js would send to the browser: the forms' props hold the office ids, never other fields of the pool.
    const payload = JSON.stringify(serverPayload(tree));
    expect(payload).toContain(OFFICE_ROW_1);
    expect(payload).toContain("PAR1A0001");
    expect(payload).not.toContain("PAD005-SENTINEL-OFFICE-NOTES");
    expect(payload).not.toContain("ama_01JA2Y8K3M7P1R5T9W3Z7C1F5H");

    // An active connection and one with the OTA's own credentials need no office: the pool is not asked.
    fetchMock.mockClear();
    routes({
      [`GET ${TENANT_PATH}`]: () =>
        json(
          detail({
            amadeusConnections: [
              amadeusConnection(),
              amadeusConnection({
                id: "sc_01JA2ZB9C3E7G1J5M9Q3S7V1X6",
                environment: "live",
                credentialSource: "tenant",
                status: "pending_verification",
                officeIds: [],
              }),
            ],
          }),
          200,
        ),
    });
    await openTenant();
    expect(calls("GET", OFFICES_PATH)).toHaveLength(0);
    openTab(TENANT_TAB_LABELS.connections);
    expect(screen.queryByRole("region", { name: ASSIGN_OFFICE_STRINGS.title })).toBeNull();
  });
});
