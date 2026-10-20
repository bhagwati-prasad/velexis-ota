// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { Component, Suspense, type ReactNode } from "react";
import type * as ReactModule from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope of Next.js and the configuration; the real API client talks to a mocked fetch ----

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  pathname: "/dashboard",
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  redirect: navigation.redirect,
  notFound: navigation.notFound,
}));

const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => nextCache);

/**
 * React's `cache()` as Next.js runs it on the server: one memo per request (see ota-dashboard.test.tsx). Every
 * `routes()` call starts a new request.
 */
const requestScope = vi.hoisted(() => {
  const memos = new Set<Map<string, unknown>>();
  return {
    memos,
    next(): void {
      for (const memo of memos) {
        memo.clear();
      }
    },
  };
});
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    cache: <Args extends unknown[], Result>(fn: (...args: Args) => Result) => {
      const memo = new Map<string, unknown>();
      requestScope.memos.add(memo);
      return (...args: Args): Result => {
        const key = JSON.stringify(args);
        if (!memo.has(key)) {
          memo.set(key, fn(...args));
        }
        return memo.get(key) as Result;
      };
    },
  };
});

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import OtaLayout from "@/app/(app)/otas/[tenantId]/layout";
import {
  changeMemberRole,
  inviteMember,
  removeTeamMember,
  resendTeamInvitation,
  revokeTeamInvitation,
} from "@/app/(app)/otas/[tenantId]/team/actions";
import TeamPage from "@/app/(app)/otas/[tenantId]/team/page";
import { acceptInvitation, signOutForInvitation } from "@/app/(auth)/invitations/accept/actions";
import AcceptInvitationPage from "@/app/(auth)/invitations/accept/page";
import SignInPage from "@/app/(auth)/sign-in/page";
import SignUpPage from "@/app/(auth)/sign-up/page";
import { fieldId } from "@/components/form-field";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { TENANT_ROLES, assignableRoles, canManageRole, type TenantRole } from "@/lib/roles";
import { ACCESS_TOKEN_COOKIE, INVITATION_COOKIE, REFRESH_TOKEN_COOKIE, prefillEmail } from "@/lib/session";
import {
  ERROR_MESSAGES,
  INVITATION_STRINGS,
  ROLE_LABELS,
  SIGN_IN_STRINGS,
  SIGN_UP_STRINGS,
  STEP_UP_STRINGS,
  TEAM_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token) -----------------------------------------------------------------

type Schemas = components["schemas"];
type Tenant = Schemas["Tenant"];
type Member = Schemas["Member"];
type Invitation = Schemas["Invitation"];
type Account = Schemas["Account"];
type InvitationPreview = Schemas["InvitationPreview"];

const ACCESS_TOKEN = "pfe012-dummy-access-token";
const REFRESH_TOKEN = "pfe012-dummy-refresh-token";
/** An invitation token as the e-mail link carries it (`iv_` + 43 characters; a dummy, never a real one). */
const INVITE_TOKEN = "iv_PFE012dummyInvitationTokenNeverRealValue00";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PFE-012 test)";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const TENANT_PATH = `/v1/tenants/${TENANT_ID}`;
const MEMBERS_PATH = `${TENANT_PATH}/members`;
const INVITATIONS_PATH = `${TENANT_PATH}/invitations`;
const TEAM_PAGE = `/otas/${TENANT_ID}/team`;
const INVITED = "jo@acme-travel.example.com";

/** The dates the pages show; the tests never read their text, so any instant will do (no fixed calendar date). */
const NOW = Date.now();
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

const FEATURES_OFF: Schemas["MilestoneFeatures"] = {
  stripeBilling: false,
  ownStripe: false,
  settlements: false,
  ownAmadeus: false,
  customDomains: false,
  liveSwitch: false,
};

/** The five members of the OTA, one per role, oldest first. */
const ANNA = member("stf_01JA2ZA1C5E9G3J7K2M6P0R4T8", "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X", "Anna Berg", "owner");
const BEA = member("stf_01JA2ZA1C5E9G3J7K2M6P0R4T9", "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1Y", "Bea Lind", "admin");
const JONAS = member(
  "stf_01JB3K7P2R6T0W4Y8A2C6E0G4J",
  "acc_01JB3K6M0P4R8T2W6Y0A4C8E2G",
  "Jonas Dahl",
  "agent",
);
const FRIDA = member(
  "stf_01JB3K7P2R6T0W4Y8A2C6E0G4K",
  "acc_01JB3K6M0P4R8T2W6Y0A4C8E2H",
  "Frida Holm",
  "finance",
);
const VIGGO = member(
  "stf_01JB3K7P2R6T0W4Y8A2C6E0G4M",
  "acc_01JB3K6M0P4R8T2W6Y0A4C8E2J",
  "Viggo Strand",
  "viewer",
);
const MEMBERS = [ANNA, BEA, JONAS, FRIDA, VIGGO] as const;

function member(id: string, accountId: string, fullName: string, role: TenantRole): Member {
  return {
    id,
    accountId,
    fullName,
    email: `${fullName.split(" ")[0]?.toLowerCase() ?? "someone"}@acme-travel.example.com`,
    role,
    status: "active",
    mfaEnabled: role === "owner",
    createdAt: iso(-30 * DAY_MS),
    version: 1,
  };
}

/** A pending invitation for an agent, and one for an admin (only owners manage that one). */
const AGENT_INVITATION: Invitation = {
  id: "ivt_01JA2ZF4H8K2M6P0R4T8W2Y6A0",
  email: INVITED,
  role: "agent",
  status: "pending",
  invitedBy: { accountId: ANNA.accountId, fullName: ANNA.fullName },
  expiresAt: iso(6 * DAY_MS),
  createdAt: iso(-DAY_MS),
};
const ADMIN_INVITATION: Invitation = {
  id: "ivt_01JA2ZF4H8K2M6P0R4T8W2Y6A1",
  email: "kim@acme-travel.example.com",
  role: "admin",
  status: "pending",
  invitedBy: null,
  expiresAt: iso(5 * DAY_MS),
  createdAt: iso(-2 * DAY_MS),
};

function tenant(myRole: TenantRole): Tenant {
  return {
    id: TENANT_ID,
    key: "acme",
    name: "Acme Travel",
    legalName: null,
    status: "active",
    suspensionReason: null,
    billingNotice: null,
    planCode: "early_access",
    defaultCurrency: "EUR",
    countryCode: "NO",
    timeZone: "Europe/Oslo",
    supportEmail: null,
    storefrontEnvironment: "test",
    liveEnabledAt: null,
    primaryHost: "acme.ota.example.com",
    schemaVersion: "0002_m1",
    createdAt: iso(-60 * DAY_MS),
    activatedAt: iso(-60 * DAY_MS),
    version: 4,
    myRole,
  };
}

/** The signed-in account of `self` (`getMe`). */
function account(self: Member, overrides: Partial<Account> = {}): Account {
  return {
    id: self.accountId,
    email: self.email,
    emailVerified: true,
    fullName: self.fullName,
    locale: "en",
    timeZone: "Europe/Oslo",
    mfaEnabled: true,
    mfaEnabledAt: null,
    isPlatformAdmin: false,
    createdAt: iso(-90 * DAY_MS),
    version: 1,
    memberships: [],
    features: FEATURES_OFF,
    ...overrides,
  };
}

function preview(overrides: Partial<InvitationPreview> = {}): InvitationPreview {
  return {
    tenantName: "Acme Travel",
    role: "agent",
    email: INVITED,
    inviterName: "Anna Berg",
    expiresAt: iso(6 * DAY_MS),
    ...overrides,
  };
}

/** A new session as `stepUp` answers it; the token values are dummies. */
function steppedUpSession(): Schemas["PortalSession"] {
  return {
    accessToken: "pfe012-stepped-up-access-token",
    accessTokenExpiresAt: iso(15 * 60 * 1000),
    refreshToken: "pfe012-stepped-up-refresh-token",
    refreshTokenExpiresAt: iso(7 * DAY_MS),
    account: account(ANNA),
  };
}

// ---- The mocked platform API ---------------------------------------------------------------------------------------

/** One call the portal made: what the tests check (the body is read before the route answers). */
interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();
let sent: Call[] = [];

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An empty `202` or `204`, as the API sends it (Express writes `Content-Length: 0`). */
function empty(status: 202 | 204): Response {
  return new Response(null, { status, headers: { "content-length": "0" } });
}

/** An error envelope of the platform API; its `message` must never reach the page. */
function apiError(code: string, status: number, details?: Record<string, unknown>): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pfe012",
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
  );
}

type Route = (call: Call) => Response | Promise<Response>;

/** The routes of a team page opened by Anna, the owner: the OTA, its members, its invitations, her account. */
function defaultRoutes(role: TenantRole, self: Member): Record<string, Route> {
  return {
    [`GET ${TENANT_PATH}`]: () => json(tenant(role), 200),
    [`GET ${MEMBERS_PATH}`]: () => json({ data: MEMBERS }, 200),
    [`GET ${INVITATIONS_PATH}`]: () => json({ data: [AGENT_INVITATION, ADMIN_INVITATION] }, 200),
    "GET /v1/me": () => json(account(self), 200),
  };
}

/**
 * Answers each call by `METHOD /path`; a new answer table is a new request, with nothing cached from the one before.
 * A call without a route fails the test.
 */
function routes(
  overrides: Record<string, Route> = {},
  role: TenantRole = "owner",
  self: Member = ANNA,
): void {
  requestScope.next();
  const table: Record<string, Route> = { ...defaultRoutes(role, self), ...overrides };
  fetchMock.mockImplementation(async (input) => {
    const text = input.method === "GET" ? "" : await input.clone().text();
    const call: Call = {
      method: input.method,
      path: new URL(input.url).pathname,
      headers: input.headers,
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
    sent.push(call);
    const route = table[`${call.method} ${call.path}`];
    if (route === undefined) {
      throw new Error(`unexpected call ${call.method} ${input.url}`);
    }
    return route(call);
  });
}

/** The calls of `METHOD /path` so far. */
function calls(method: string, path: string): Call[] {
  return sent.filter((call) => call.method === method && call.path === path);
}

/** The cookies of the request: a jar the actions write to as a browser would keep them. */
const jar = new Map<string, string>();
const cookieSet = vi.fn((name: string, value: string, options: { maxAge: number }) => {
  if (options.maxAge === 0) {
    jar.delete(name);
  } else {
    jar.set(name, value);
  }
});

function cookieStore() {
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) ?? "" } : undefined),
    has: (name: string) => jar.has(name),
    set: cookieSet,
  };
}

/** The cookies written with `maxAge: 0`, by name. */
function deletedCookies(): string[] {
  return cookieSet.mock.calls.filter(([, , options]) => options.maxAge === 0).map(([name]) => name);
}

/** The route params of `/otas/[tenantId]`, as Next.js 15 passes them. */
function params(tenantId = TENANT_ID): Promise<{ tenantId: string }> {
  return Promise.resolve({ tenantId });
}

// ---- Rendering --------------------------------------------------------------------------------------------------

/**
 * Next.js handles the `redirect()` of a server action by navigating; in a component test the action runs in the
 * page, so its redirect error reaches this boundary, which shows where the browser would go.
 */
class RedirectBoundary extends Component<{ readonly children: ReactNode }, { readonly target?: string }> {
  override state: { readonly target?: string } = {};

  static getDerivedStateFromError(error: unknown): { target: string } {
    const match = error instanceof Error ? /^NEXT_REDIRECT (.+)$/.exec(error.message) : null;
    return { target: match?.[1] ?? `not a redirect: ${String(error)}` };
  }

  override render(): ReactNode {
    return this.state.target === undefined ? (
      this.props.children
    ) : (
      <p role="status">Redirected to {this.state.target}</p>
    );
  }
}

/**
 * How long a test waits for what a server action answers (a round trip through the real `lib/api.ts` and a re-render
 * of the page). Testing Library's 1 s default is enough on an idle machine, not on a loaded CI runner; the test's own
 * 5 s budget is unchanged.
 */
const ACTION_WAIT = { timeout: 3_000 } as const;

/**
 * The budget of the hook below: the first render of the team page in a fresh worker loads the page's modules (Radix,
 * TanStack Table, the actions) and is the slowest by far on a busy CI runner.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/** The team page as the OTA layout and the page render it for one request, inside the redirect boundary. */
async function openTeam(): Promise<void> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = await TeamPage({ params: params() });
  render(<RedirectBoundary>{await OtaLayout({ children: page, params: params() })}</RedirectBoundary>);
}

/** The accept page for one request with the query `search`, inside the redirect boundary. */
async function openAcceptPage(search: Record<string, string> = {}): Promise<void> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = await AcceptInvitationPage({ searchParams: Promise.resolve(search) });
  render(<RedirectBoundary>{page}</RedirectBoundary>);
}

async function redirectedTo(): Promise<string> {
  const status = await screen.findByText(/^Redirected to /, {}, ACTION_WAIT);
  return status.textContent?.replace(/^Redirected to /, "") ?? "";
}

/** The members table (its caption names it). */
function membersTable(): HTMLElement {
  return screen.getByRole("table", { name: TEAM_STRINGS.membersCaption });
}

/** The role selector of a member's row, or `null` when the row has none. */
function roleSelect(name: string): HTMLSelectElement | null {
  return screen.queryByLabelText(TEAM_STRINGS.roleOf(name)) as HTMLSelectElement | null;
}

function optionsOf(select: HTMLSelectElement | null): string[] {
  return select === null ? [] : [...select.options].map((option) => option.value);
}

/** Submits the form of the button named `name`, as a click on it would. */
function submit(name: string): void {
  const button = screen.getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

/** Opens the confirmation of the button named `trigger` and confirms it with the button named `confirm`. */
async function confirmWith(trigger: string, confirm: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  const dialog = await screen.findByRole("alertdialog", {}, ACTION_WAIT);
  fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
}

/** The ids in `aria-describedby` of `element`, resolved to their text. */
function descriptionsOf(element: Element): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`);
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

/** A fresh mocked platform API and request scope: the default routes, the session cookies, the end user's headers. */
function resetPlatformApi(): void {
  fetchMock.mockReset();
  sent = [];
  vi.stubGlobal("fetch", fetchMock);
  navigation.pathname = TEAM_PAGE;
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
  nextCache.revalidatePath.mockReset();
  cookieSet.mockClear();
  jar.clear();
  jar.set(ACCESS_TOKEN_COOKIE, ACCESS_TOKEN);
  jar.set(REFRESH_TOKEN_COOKIE, REFRESH_TOKEN);
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pfe012_portal",
    }),
  );
  nextHeaders.cookies.mockImplementation(() => Promise.resolve(cookieStore()));
  routes();
}

/**
 * Once per file, before any test: the team page's first render and a role change through its action. The first run
 * of those paths in a fresh worker is the slowest, and on a busy CI runner it otherwise lands in the first test's own
 * five seconds; here it has the hook's budget. Nothing of it stays: each test gets a fresh API, fresh mocks and globals
 * (`restoreMocks`, `unstubGlobals`) and an empty document.
 */
beforeAll(async () => {
  resetPlatformApi();
  routes({
    [`PATCH ${MEMBERS_PATH}/${JONAS.id}`]: () => json({ ...JONAS, role: "finance", version: 2 }, 200),
  });
  await openTeam();
  fireEvent.change(roleSelect(JONAS.fullName) as HTMLSelectElement, { target: { value: "finance" } });
  submit(`${TEAM_STRINGS.changeRole}${TEAM_STRINGS.changeRoleOf(JONAS.fullName)}`);
  await screen.findByText(
    TEAM_STRINGS.roleChanged(JONAS.fullName, ROLE_LABELS.finance),
    {},
    {
      timeout: WARM_UP_TIMEOUT_MS,
    },
  );
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The role matrix ----------------------------------------------------------------------------------------------

describe("canManageRole and assignableRoles", () => {
  it("[PFE-012 AC1] follow scope §1.2: owners give every role, admins agent, finance and viewer, others none [PF-20 AC1, PF-21 AC1]", () => {
    expect(Object.fromEntries(TENANT_ROLES.map((role) => [role, assignableRoles(role)]))).toEqual({
      owner: ["owner", "admin", "agent", "finance", "viewer"],
      admin: ["agent", "finance", "viewer"],
      agent: [],
      finance: [],
      viewer: [],
    });
    for (const actor of TENANT_ROLES) {
      for (const target of TENANT_ROLES) {
        expect(canManageRole(actor, target)).toBe(assignableRoles(actor).includes(target));
      }
    }
  });
});

// ---- The team page --------------------------------------------------------------------------------------------------

describe("/otas/[tenantId]/team", () => {
  it("[PFE-012 AC1] an admin cannot pick owner or admin in the role selector or the invite form [PF-20 AC1, PF-21 AC1]", async () => {
    routes({}, "admin", BEA);
    await openTeam();

    // Owners and admins (Bea herself included) get no selector and no "Remove" from an admin: their role is text.
    for (const privileged of [ANNA, BEA]) {
      expect(roleSelect(privileged.fullName)).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: `${TEAM_STRINGS.remove}${TEAM_STRINGS.removeWho(privileged.fullName)}`,
        }),
      ).toBeNull();
      const row = within(membersTable()).getByText(privileged.fullName).closest("tr");
      expect(row?.querySelector("[data-role]")?.textContent).toBe(ROLE_LABELS[privileged.role]);
      expect(row?.querySelector("select")).toBeNull();
    }
    // Agents, finance members and viewers: a selector offering only those three roles, and "Remove".
    for (const staff of [JONAS, FRIDA, VIGGO]) {
      expect(optionsOf(roleSelect(staff.fullName))).toEqual(["agent", "finance", "viewer"]);
      expect(roleSelect(staff.fullName)?.value).toBe(staff.role);
      expect(
        screen.getByRole("button", {
          name: `${TEAM_STRINGS.remove}${TEAM_STRINGS.removeWho(staff.fullName)}`,
        }),
      ).toBeTruthy();
    }
    // The invite form offers the same three roles, agent preselected, and says who invites owners and admins.
    const inviteRole = screen.getByLabelText(TEAM_STRINGS.roleLabel) as HTMLSelectElement;
    expect(optionsOf(inviteRole)).toEqual(["agent", "finance", "viewer"]);
    expect(inviteRole.value).toBe("agent");
    expect(descriptionsOf(inviteRole).join(" ")).toContain(TEAM_STRINGS.roleHintAdmin);
    // No selector anywhere on the page offers a privileged role.
    for (const select of document.querySelectorAll("select")) {
      expect(optionsOf(select)).not.toContain("owner");
      expect(optionsOf(select)).not.toContain("admin");
    }
    // Her own row offers "Leave"; the admin invitation has no "Send again" or "Revoke" for her.
    expect(screen.getByRole("button", { name: TEAM_STRINGS.leave })).toBeTruthy();
    expect(screen.getByText(TEAM_STRINGS.you).closest("tr")?.textContent).toContain(BEA.fullName);
    expect(
      screen.getByRole("button", {
        name: `${TEAM_STRINGS.resend}${TEAM_STRINGS.invitationTo(AGENT_INVITATION.email)}`,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: `${TEAM_STRINGS.resend}${TEAM_STRINGS.invitationTo(ADMIN_INVITATION.email)}`,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: `${TEAM_STRINGS.revoke}${TEAM_STRINGS.invitationTo(ADMIN_INVITATION.email)}`,
      }),
    ).toBeNull();
  });

  it("[PFE-012 AC1] an owner can give every role, to every member, and manages every invitation", async () => {
    await openTeam();

    for (const someone of MEMBERS) {
      expect(optionsOf(roleSelect(someone.fullName))).toEqual([...TENANT_ROLES]);
    }
    expect(optionsOf(screen.getByLabelText(TEAM_STRINGS.roleLabel) as HTMLSelectElement)).toEqual([
      ...TENANT_ROLES,
    ]);
    // Anna's own row offers "Leave" instead of "Remove".
    expect(
      screen.queryByRole("button", {
        name: `${TEAM_STRINGS.remove}${TEAM_STRINGS.removeWho(ANNA.fullName)}`,
      }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: TEAM_STRINGS.leave })).toBeTruthy();
    for (const invitation of [AGENT_INVITATION, ADMIN_INVITATION]) {
      expect(
        screen.getByRole("button", {
          name: `${TEAM_STRINGS.revoke}${TEAM_STRINGS.invitationTo(invitation.email)}`,
        }),
      ).toBeTruthy();
    }
    // The lists come from listMembers, listInvitations and getMe, each called once with the session.
    for (const [method, path] of [
      ["GET", MEMBERS_PATH],
      ["GET", INVITATIONS_PATH],
      ["GET", "/v1/me"],
      ["GET", TENANT_PATH],
    ] as const) {
      const [call, ...more] = calls(method, path);
      expect(more).toHaveLength(0);
      expect(call?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(call?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
      expect(call?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
      expect(call?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
    }
    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([
      TEAM_STRINGS.title,
    ]);
  });

  it("shows other roles the team without changes, never asks for the invitations, and lets them leave", async () => {
    routes({}, "agent", JONAS);
    await openTeam();

    for (const someone of MEMBERS) {
      expect(screen.getByText(someone.fullName)).toBeTruthy();
      expect(roleSelect(someone.fullName)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: new RegExp(`^${TEAM_STRINGS.remove}`) })).toBeNull();
    expect(screen.queryByRole("heading", { name: TEAM_STRINGS.inviteTitle })).toBeNull();
    expect(screen.queryByRole("heading", { name: TEAM_STRINGS.invitationsTitle })).toBeNull();
    expect(document.querySelector('[data-notice="read-only"]')?.textContent).toBe(TEAM_STRINGS.readOnly);
    expect(calls("GET", INVITATIONS_PATH)).toHaveLength(0);
    expect(screen.getByRole("button", { name: TEAM_STRINGS.leave })).toBeTruthy();
  });

  it("changes a role with the member's version in If-Match and renders the OTA again", async () => {
    routes({
      [`PATCH ${MEMBERS_PATH}/${JONAS.id}`]: () => json({ ...JONAS, role: "finance", version: 2 }, 200),
    });
    await openTeam();

    const changeButton = `${TEAM_STRINGS.changeRole}${TEAM_STRINGS.changeRoleOf(JONAS.fullName)}`;
    // Nothing to send until another role is picked.
    expect((screen.getByRole("button", { name: changeButton }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(roleSelect(JONAS.fullName) as HTMLSelectElement, { target: { value: "finance" } });
    submit(changeButton);

    expect(
      await screen.findByText(TEAM_STRINGS.roleChanged(JONAS.fullName, ROLE_LABELS.finance), {}, ACTION_WAIT),
    ).toBeTruthy();
    const [patch, ...more] = calls("PATCH", `${MEMBERS_PATH}/${JONAS.id}`);
    expect(more).toHaveLength(0);
    expect(patch?.headers.get("if-match")).toBe('"1"');
    expect(patch?.body).toEqual({ role: "finance" });
    expect(patch?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/otas/${TENANT_ID}`, "layout");
  });

  it("asks for a code from the authenticator app before granting owner, then changes the role", async () => {
    let patches = 0;
    routes({
      [`PATCH ${MEMBERS_PATH}/${BEA.id}`]: () => {
        patches += 1;
        return patches === 1
          ? apiError("REAUTH_REQUIRED", 401)
          : json({ ...BEA, role: "owner", version: 2 }, 200);
      },
      "POST /v1/auth/step-up": () => json(steppedUpSession(), 200),
    });
    await openTeam();

    fireEvent.change(roleSelect(BEA.fullName) as HTMLSelectElement, { target: { value: "owner" } });
    submit(`${TEAM_STRINGS.changeRole}${TEAM_STRINGS.changeRoleOf(BEA.fullName)}`);
    const dialog = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, ACTION_WAIT);
    fireEvent.change(within(dialog).getByLabelText(STEP_UP_STRINGS.codeLabel), {
      target: { value: "492039" },
    });
    submit(STEP_UP_STRINGS.submit);

    expect(
      await screen.findByText(TEAM_STRINGS.roleChanged(BEA.fullName, ROLE_LABELS.owner), {}, ACTION_WAIT),
    ).toBeTruthy();
    expect(calls("POST", "/v1/auth/step-up")[0]?.body).toEqual({ code: "492039" });
    // The same change ran again, now with the stepped-up session the dialog stored in the cookies.
    const [first, second, ...more] = calls("PATCH", `${MEMBERS_PATH}/${BEA.id}`);
    expect(more).toHaveLength(0);
    expect(first?.body).toEqual({ role: "owner" });
    expect(second?.body).toEqual({ role: "owner" });
    expect(second?.headers.get("authorization")).toBe("Bearer pfe012-stepped-up-access-token");
  });

  it("shows LAST_OWNER when the last owner would be demoted or leave, and MFA_REQUIRED with the way to set it up", async () => {
    routes({
      [`PATCH ${MEMBERS_PATH}/${ANNA.id}`]: () => apiError("LAST_OWNER", 409),
      [`DELETE ${MEMBERS_PATH}/${ANNA.id}`]: () => apiError("LAST_OWNER", 409),
      [`PATCH ${MEMBERS_PATH}/${BEA.id}`]: () => apiError("MFA_REQUIRED", 403),
    });
    await openTeam();

    fireEvent.change(roleSelect(ANNA.fullName) as HTMLSelectElement, { target: { value: "admin" } });
    submit(`${TEAM_STRINGS.changeRole}${TEAM_STRINGS.changeRoleOf(ANNA.fullName)}`);
    expect(await screen.findByText(ERROR_MESSAGES.LAST_OWNER, {}, ACTION_WAIT)).toBeTruthy();

    await confirmWith(TEAM_STRINGS.leave, TEAM_STRINGS.leaveConfirm);
    await waitFor(() => expect(calls("DELETE", `${MEMBERS_PATH}/${ANNA.id}`)).toHaveLength(1), ACTION_WAIT);
    const alert = await screen.findByText(ERROR_MESSAGES.LAST_OWNER, {}, ACTION_WAIT);
    expect(alert.closest('[data-notice="failed"]')?.getAttribute("data-code")).toBe("LAST_OWNER");
    expect(screen.queryByText(/^Redirected to /)).toBeNull();

    fireEvent.change(roleSelect(BEA.fullName) as HTMLSelectElement, { target: { value: "owner" } });
    submit(`${TEAM_STRINGS.changeRole}${TEAM_STRINGS.changeRoleOf(BEA.fullName)}`);
    expect(await screen.findByText(TEAM_STRINGS.mfaRequired, {}, ACTION_WAIT)).toBeTruthy();
    expect(screen.getByRole("link", { name: TEAM_STRINGS.mfaLink }).getAttribute("href")).toBe(
      "/account/security",
    );
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("removes a member after confirmation, and a member who leaves goes to the dashboard", async () => {
    routes({
      [`DELETE ${MEMBERS_PATH}/${JONAS.id}`]: () => empty(204),
      [`DELETE ${MEMBERS_PATH}/${ANNA.id}`]: () => empty(204),
    });
    await openTeam();

    await confirmWith(
      `${TEAM_STRINGS.remove}${TEAM_STRINGS.removeWho(JONAS.fullName)}`,
      TEAM_STRINGS.removeConfirm,
    );
    expect(await screen.findByText(TEAM_STRINGS.removed, {}, ACTION_WAIT)).toBeTruthy();
    expect(calls("DELETE", `${MEMBERS_PATH}/${JONAS.id}`)).toHaveLength(1);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/otas/${TENANT_ID}`, "layout");

    await confirmWith(TEAM_STRINGS.leave, TEAM_STRINGS.leaveConfirm);
    expect(await redirectedTo()).toBe("/dashboard");
    expect(calls("DELETE", `${MEMBERS_PATH}/${ANNA.id}`)).toHaveLength(1);
  });

  it("resends an invitation, and explains a revocation of one that is no longer pending", async () => {
    routes({
      [`POST ${INVITATIONS_PATH}/${AGENT_INVITATION.id}/resend`]: () => empty(202),
      [`DELETE ${INVITATIONS_PATH}/${AGENT_INVITATION.id}`]: () =>
        apiError("CONFLICT", 409, { reason: "not_pending" }),
    });
    await openTeam();

    fireEvent.click(
      screen.getByRole("button", {
        name: `${TEAM_STRINGS.resend}${TEAM_STRINGS.invitationTo(AGENT_INVITATION.email)}`,
      }),
    );
    expect(await screen.findByText(TEAM_STRINGS.resent, {}, ACTION_WAIT)).toBeTruthy();
    expect(calls("POST", `${INVITATIONS_PATH}/${AGENT_INVITATION.id}/resend`)).toHaveLength(1);

    await confirmWith(
      `${TEAM_STRINGS.revoke}${TEAM_STRINGS.invitationTo(AGENT_INVITATION.email)}`,
      TEAM_STRINGS.revokeConfirm,
    );
    expect(await screen.findByText(TEAM_STRINGS.notPending, {}, ACTION_WAIT)).toBeTruthy();
    expect(screen.getByRole("link", { name: TEAM_STRINGS.reload }).getAttribute("href")).toBe(TEAM_PAGE);
  });

  it("shows the portal's message in place of a list that cannot be loaded, and sends an ended session to sign-in", async () => {
    routes({ [`GET ${MEMBERS_PATH}`]: () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openTeam();
    expect(screen.getByText(TEAM_STRINGS.membersUnavailableTitle)).toBeTruthy();
    expect(screen.getByText(ERROR_MESSAGES.SERVICE_UNAVAILABLE)).toBeTruthy();
    expect(document.body.textContent).not.toContain("The API's own text");
    cleanup();

    routes({ [`GET ${INVITATIONS_PATH}`]: () => apiError("UNAUTHENTICATED", 401) });
    await expect(TeamPage({ params: params() })).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fteam`,
    );
  });
});

// ---- The invite form ------------------------------------------------------------------------------------------------

describe("InviteForm and inviteMember", () => {
  function fillInvite(email: string, role: TenantRole): void {
    fireEvent.change(screen.getByLabelText(TEAM_STRINGS.emailLabel), { target: { value: email } });
    fireEvent.change(screen.getByLabelText(TEAM_STRINGS.roleLabel), { target: { value: role } });
  }

  it("[PFE-012 AC2] shows the seat limit with the seats used and the plan's limit [PF-20 AC2]", async () => {
    // A plan changed to fewer seats than are taken: the two numbers differ, so swapping them cannot pass.
    routes({
      [`POST ${INVITATIONS_PATH}`]: () => apiError("PLAN_LIMIT_REACHED", 422, { limit: 3, used: 4 }),
    });
    await openTeam();

    fillInvite(INVITED, "finance");
    submit(TEAM_STRINGS.invite);

    const message = await screen.findByText(TEAM_STRINGS.seatLimit(4, 3), {}, ACTION_WAIT);
    expect(message.textContent).toContain("Your plan includes 3 team seats, and 4 are taken");
    expect(message.closest('[role="alert"]')).not.toBeNull();
    // What was typed stays for another try.
    expect((screen.getByLabelText(TEAM_STRINGS.emailLabel) as HTMLInputElement).value).toBe(INVITED);
    expect((screen.getByLabelText(TEAM_STRINGS.roleLabel) as HTMLSelectElement).value).toBe("finance");
    expect(calls("POST", INVITATIONS_PATH)[0]?.body).toEqual({ email: INVITED, role: "finance" });

    // Without the details the general message shows.
    const state = await inviteMember(
      { status: "idle", values: { email: "", role: "agent" }, fieldErrors: {} },
      formData({ tenantId: TENANT_ID, email: INVITED, role: "agent" }),
    );
    expect(state.message).toBe(TEAM_STRINGS.seatLimit(4, 3));
    routes({ [`POST ${INVITATIONS_PATH}`]: () => apiError("PLAN_LIMIT_REACHED", 422) });
    const general = await inviteMember(
      state,
      formData({ tenantId: TENANT_ID, email: INVITED, role: "agent" }),
    );
    expect(general.message).toBe(ERROR_MESSAGES.PLAN_LIMIT_REACHED);
    expect(TEAM_STRINGS.seatLimit(1, 1)).toContain("1 team seat, and 1 is taken");
  });

  it("shows ALREADY_MEMBER and INVITATION_PENDING at the address", async () => {
    let answer = "ALREADY_MEMBER";
    routes({ [`POST ${INVITATIONS_PATH}`]: () => apiError(answer, 409) });
    await openTeam();

    fillInvite(INVITED, "agent");
    submit(TEAM_STRINGS.invite);
    await screen.findByText(
      ERROR_MESSAGES.ALREADY_MEMBER,
      { selector: `#${fieldId("email")}-error` },
      ACTION_WAIT,
    );
    expect(descriptionsOf(screen.getByLabelText(TEAM_STRINGS.emailLabel))).toContain(
      ERROR_MESSAGES.ALREADY_MEMBER,
    );

    answer = "INVITATION_PENDING";
    submit(TEAM_STRINGS.invite);
    await screen.findByText(
      ERROR_MESSAGES.INVITATION_PENDING,
      { selector: `#${fieldId("email")}-error` },
      ACTION_WAIT,
    );
    expect(screen.getByLabelText(TEAM_STRINGS.emailLabel).getAttribute("aria-invalid")).toBe("true");
  });

  it("invites, confirms it, empties the address and renders the OTA again", async () => {
    routes({
      [`POST ${INVITATIONS_PATH}`]: () =>
        json({ ...AGENT_INVITATION, email: "new@acme-travel.example.com", role: "viewer" }, 201),
    });
    await openTeam();

    fillInvite("  new@acme-travel.example.com ", "viewer");
    submit(TEAM_STRINGS.invite);

    expect(await screen.findByText(TEAM_STRINGS.invited, {}, ACTION_WAIT)).toBeTruthy();
    // The address is sent trimmed, and never comes back as the API's text.
    expect(calls("POST", INVITATIONS_PATH)[0]?.body).toEqual({
      email: "new@acme-travel.example.com",
      role: "viewer",
    });
    expect((screen.getByLabelText(TEAM_STRINGS.emailLabel) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(TEAM_STRINGS.roleLabel) as HTMLSelectElement).value).toBe("viewer");
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/otas/${TENANT_ID}`, "layout");
  });

  it("checks the form before any call, and reads a refused role as a stale page", async () => {
    const idle = { status: "idle", values: { email: "", role: "agent" }, fieldErrors: {} } as const;
    const empty = await inviteMember(idle, formData({ tenantId: TENANT_ID, email: " ", role: "" }));
    expect(empty.fieldErrors).toEqual({ email: TEAM_STRINGS.emailRequired, role: TEAM_STRINGS.roleRequired });
    const invalid = await inviteMember(
      idle,
      formData({ tenantId: TENANT_ID, email: "not-an-address", role: "boss" }),
    );
    expect(invalid.fieldErrors).toEqual({
      email: TEAM_STRINGS.emailInvalid,
      role: TEAM_STRINGS.roleNotAllowed,
    });
    const noTenant = await inviteMember(idle, formData({ email: INVITED, role: "agent" }));
    expect(noTenant.message).toBe(TEAM_STRINGS.formExpired);
    expect(sent).toHaveLength(0);

    routes({ [`POST ${INVITATIONS_PATH}`]: () => apiError("FORBIDDEN", 403) });
    const forbidden = await inviteMember(
      idle,
      formData({ tenantId: TENANT_ID, email: INVITED, role: "admin" }),
    );
    expect(forbidden.message).toBe(TEAM_STRINGS.forbidden);
  });
});

// ---- The actions' guards ------------------------------------------------------------------------------------------

describe("the team actions", () => {
  it("refuse a form without valid ids or role without calling the API", async () => {
    const idle = { status: "idle" } as const;
    const valid = { tenantId: TENANT_ID, memberId: JONAS.id, version: "1", role: "finance" };
    for (const broken of [
      { ...valid, tenantId: "ten_lowercase" },
      { ...valid, memberId: "stf_1" },
      { ...valid, version: "0" },
      { ...valid, role: "boss" },
    ]) {
      expect(await changeMemberRole(idle, formData(broken))).toMatchObject({
        status: "failed",
        message: TEAM_STRINGS.formExpired,
      });
    }
    expect(await removeTeamMember(idle, formData({ tenantId: TENANT_ID, memberId: "x" }))).toMatchObject({
      message: TEAM_STRINGS.formExpired,
    });
    for (const action of [resendTeamInvitation, revokeTeamInvitation]) {
      expect(await action(idle, formData({ tenantId: TENANT_ID, invitationId: "ivt_1" }))).toMatchObject({
        message: TEAM_STRINGS.formExpired,
      });
    }
    expect(sent).toHaveLength(0);
  });

  it("send an ended session to sign-in and back to the team page, and an unverified account to /verify-pending", async () => {
    routes({ [`DELETE ${MEMBERS_PATH}/${JONAS.id}`]: () => apiError("TOKEN_EXPIRED", 401) });
    await expect(
      removeTeamMember({ status: "idle" }, formData({ tenantId: TENANT_ID, memberId: JONAS.id })),
    ).rejects.toThrow(`NEXT_REDIRECT /sign-in?next=%2Fotas%2F${TENANT_ID}%2Fteam`);

    routes({
      [`POST ${INVITATIONS_PATH}/${AGENT_INVITATION.id}/resend`]: () => apiError("EMAIL_NOT_VERIFIED", 403),
    });
    await expect(
      resendTeamInvitation(
        { status: "idle" },
        formData({ tenantId: TENANT_ID, invitationId: AGENT_INVITATION.id }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT /verify-pending");
  });
});

// ---- Invitation acceptance ------------------------------------------------------------------------------------------

describe("/invitations/accept", () => {
  /** The routes of the accept page: the public lookup, and the account of a signed-in visitor. */
  function acceptRoutes(
    overrides: Record<string, Route> = {},
    me: Account = account({ ...JONAS, email: INVITED }),
  ) {
    routes({
      "POST /v1/invitations/lookup": () => json(preview(), 200),
      "GET /v1/me": () => json(me, 200),
      ...overrides,
    });
  }

  beforeEach(() => {
    navigation.pathname = "/invitations/accept";
    jar.set(INVITATION_COOKIE, INVITE_TOKEN);
  });

  it("[PFE-012 AC2] names the invited address when the visitor is signed in with another one [PF-20 AC3]", async () => {
    acceptRoutes({}, account(JONAS, { email: "jonas.private@example.org" }));
    await openAcceptPage();

    const mismatch = document.querySelector('[data-state="mismatch"]');
    expect(mismatch?.textContent).toContain(INVITATION_STRINGS.mismatch(INVITED));
    expect(mismatch?.textContent).toContain(INVITATION_STRINGS.signedInAs("jonas.private@example.org"));
    // No "Accept": the API would refuse it. The way out signs out and comes back with the invited address.
    expect(screen.queryByRole("button", { name: INVITATION_STRINGS.accept })).toBeNull();
    const switchButton = screen.getByRole("button", { name: INVITATION_STRINGS.switchAccount });
    expect(switchButton.closest("form")?.querySelector<HTMLInputElement>('input[name="email"]')?.value).toBe(
      INVITED,
    );
    // The invitation's details, and never its token.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      INVITATION_STRINGS.title("Acme Travel"),
    );
    expect(document.querySelector('[data-field="email"]')?.textContent).toBe(INVITED);
    expect(document.querySelector('[data-field="role"]')?.textContent).toBe(ROLE_LABELS.agent);
    expect(document.body.innerHTML).not.toContain(INVITE_TOKEN);
  });

  it("[PFE-012 AC2] names the invited address when the API refuses the acceptance for the address [PF-20 AC3]", async () => {
    acceptRoutes({ "POST /v1/invitations/accept": () => apiError("INVITATION_EMAIL_MISMATCH", 403) });
    await expect(acceptInvitation()).rejects.toThrow(
      "NEXT_REDIRECT /invitations/accept?error=INVITATION_EMAIL_MISMATCH",
    );
    // The token stays: the person can sign in with the invited address and accept.
    expect(jar.get(INVITATION_COOKIE)).toBe(INVITE_TOKEN);

    // The page the action returns to, even when the account cannot be loaded to compare the addresses itself.
    acceptRoutes({ "GET /v1/me": () => apiError("SERVICE_UNAVAILABLE", 503) });
    await openAcceptPage({ error: "INVITATION_EMAIL_MISMATCH" });
    expect(document.querySelector('[data-state="mismatch"]')?.textContent).toContain(
      INVITATION_STRINGS.mismatch(INVITED),
    );
    expect(document.body.textContent).not.toContain("The API's own text");
  });

  it("accepts with the token of the cookie, deletes the cookie and continues to the OTA's dashboard", async () => {
    acceptRoutes(
      {
        "POST /v1/invitations/accept": () =>
          json(
            {
              membership: { ...JONAS, email: INVITED },
              tenant: {
                id: TENANT_ID,
                key: "acme",
                name: "Acme Travel",
                status: "active",
                role: "agent",
                planCode: "early_access",
                storefrontUrl: "https://acme.ota.example.com/",
                storefrontEnvironment: "test",
              },
            },
            200,
          ),
      },
      // The addresses are compared without letter case, as the API compares them.
      account({ ...JONAS, email: "Jo@Acme-Travel.example.com" }),
    );
    await openAcceptPage();
    expect(screen.getByText(INVITATION_STRINGS.signedInAs("Jo@Acme-Travel.example.com"))).toBeTruthy();

    submit(INVITATION_STRINGS.accept);
    expect(await redirectedTo()).toBe(`/otas/${TENANT_ID}`);
    const [accept] = calls("POST", "/v1/invitations/accept");
    expect(accept?.body).toEqual({ token: INVITE_TOKEN });
    expect(accept?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(deletedCookies()).toEqual([INVITATION_COOKIE]);
  });

  it("gives a visitor without a session sign-in and sign-up links with the invited address and a way back", async () => {
    jar.delete(ACCESS_TOKEN_COOKIE);
    jar.delete(REFRESH_TOKEN_COOKIE);
    acceptRoutes();
    await openAcceptPage();

    const back = encodeURIComponent("/invitations/accept");
    const email = encodeURIComponent(INVITED);
    expect(screen.getByRole("link", { name: INVITATION_STRINGS.signIn }).getAttribute("href")).toBe(
      `/sign-in?next=${back}&email=${email}`,
    );
    expect(screen.getByRole("link", { name: INVITATION_STRINGS.signUp }).getAttribute("href")).toBe(
      `/sign-up?email=${email}&next=${back}`,
    );
    expect(screen.queryByRole("button", { name: INVITATION_STRINGS.accept })).toBeNull();
    // lookupInvitation is public: the token in the body, no bearer token, the end user's headers.
    expect(calls("GET", "/v1/me")).toHaveLength(0);
    const [lookup, ...more] = calls("POST", "/v1/invitations/lookup");
    expect(more).toHaveLength(0);
    expect(lookup?.body).toEqual({ token: INVITE_TOKEN });
    expect(lookup?.headers.get("authorization")).toBeNull();
    expect(lookup?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
    expect(lookup?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
    expect(document.body.innerHTML).not.toContain(INVITE_TOKEN);
  });

  it("explains an unusable or missing invitation, and an unverified or already joined account", async () => {
    acceptRoutes({ "POST /v1/invitations/lookup": () => apiError("INVITATION_INVALID", 400) });
    await openAcceptPage();
    expect(document.querySelector('[data-state="invalid"]')?.textContent).toBe(INVITATION_STRINGS.invalid);
    cleanup();

    // An acceptance refused for the token deletes the cookie; the page then explains it without a call.
    acceptRoutes({ "POST /v1/invitations/accept": () => apiError("INVITATION_INVALID", 400) });
    await expect(acceptInvitation()).rejects.toThrow(
      "NEXT_REDIRECT /invitations/accept?error=INVITATION_INVALID",
    );
    expect(jar.has(INVITATION_COOKIE)).toBe(false);
    sent = [];
    await openAcceptPage({ error: "INVITATION_INVALID" });
    expect(document.querySelector('[data-state="invalid"]')).not.toBeNull();
    cleanup();
    await openAcceptPage();
    expect(document.querySelector('[data-state="link-missing"]')?.textContent).toBe(
      INVITATION_STRINGS.linkMissing,
    );
    expect(sent).toHaveLength(0);
    await expect(acceptInvitation()).rejects.toThrow("NEXT_REDIRECT /invitations/accept");
    cleanup();

    jar.set(INVITATION_COOKIE, INVITE_TOKEN);
    acceptRoutes({}, account({ ...JONAS, email: INVITED }, { emailVerified: false }));
    await openAcceptPage();
    expect(document.querySelector('[data-state="unverified"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: INVITATION_STRINGS.verifyLink }).getAttribute("href")).toBe(
      "/verify-pending",
    );
    expect(screen.queryByRole("button", { name: INVITATION_STRINGS.accept })).toBeNull();
    cleanup();

    // An unverified account with another address could never accept: the page names the invited address instead.
    acceptRoutes({}, account(JONAS, { email: "jonas.private@example.org", emailVerified: false }));
    await openAcceptPage();
    expect(document.querySelector('[data-state="unverified"]')).toBeNull();
    expect(document.querySelector('[data-state="mismatch"]')?.textContent).toContain(
      INVITATION_STRINGS.mismatch(INVITED),
    );
    cleanup();

    acceptRoutes();
    await openAcceptPage({ error: "ALREADY_MEMBER" });
    expect(document.querySelector('[data-state="member"]')?.textContent).toContain(
      INVITATION_STRINGS.alreadyMember,
    );
    expect(screen.getByRole("link", { name: INVITATION_STRINGS.dashboardLink }).getAttribute("href")).toBe(
      "/dashboard",
    );
  });

  it("sends an ended session to sign-in and back, and signs out a visitor with another address", async () => {
    acceptRoutes({ "POST /v1/invitations/accept": () => apiError("UNAUTHENTICATED", 401) });
    await expect(acceptInvitation()).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=${encodeURIComponent("/invitations/accept")}`,
    );

    acceptRoutes({ "POST /v1/auth/sign-out": () => empty(204) });
    await expect(signOutForInvitation(formData({ email: INVITED }))).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?next=${encodeURIComponent("/invitations/accept")}&email=${encodeURIComponent(INVITED)}`,
    );
    const [signOut] = calls("POST", "/v1/auth/sign-out");
    expect(signOut?.body).toEqual({ refreshToken: REFRESH_TOKEN });
    expect(signOut?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    // The session ends in this browser; the invitation waits in its cookie.
    expect(deletedCookies().sort()).toEqual([ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE].sort());
    expect(jar.get(INVITATION_COOKIE)).toBe(INVITE_TOKEN);

    // An address that is none is not put in the sign-in link.
    await expect(signOutForInvitation(formData({ email: "javascript:alert(1)" }))).rejects.toThrow(
      new RegExp(`^NEXT_REDIRECT /sign-in\\?next=${encodeURIComponent("/invitations/accept")}$`),
    );
  });
});

// ---- Sign-in and sign-up with the invited address ----------------------------------------------------------------

describe("the sign-in and sign-up links of an invitation", () => {
  it("prefill the invited address and keep the way back to the invitation", async () => {
    const back = "/invitations/accept";
    render(await SignInPage({ searchParams: Promise.resolve({ email: INVITED, next: back }) }));
    expect((screen.getByLabelText(SIGN_IN_STRINGS.emailLabel) as HTMLInputElement).value).toBe(INVITED);
    expect(document.querySelector<HTMLInputElement>('input[name="next"]')?.value).toBe(back);
    expect(screen.getByRole("link", { name: SIGN_IN_STRINGS.signUp }).getAttribute("href")).toBe(
      `/sign-up?email=${encodeURIComponent(INVITED)}&next=${encodeURIComponent(back)}`,
    );
    cleanup();

    // The page reads the query with `use()`: inside `act`, React renders it again once the query has resolved.
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <SignUpPage searchParams={Promise.resolve({ email: INVITED, next: back })} />
        </Suspense>,
      );
      await Promise.resolve();
    });
    const email = (await screen.findByLabelText(
      SIGN_UP_STRINGS.emailLabel,
      {},
      ACTION_WAIT,
    )) as HTMLInputElement;
    expect(email.value).toBe(INVITED);
    expect(screen.getByRole("link", { name: SIGN_UP_STRINGS.signIn }).getAttribute("href")).toBe(
      `/sign-in?next=${encodeURIComponent(back)}&email=${encodeURIComponent(INVITED)}`,
    );
  });

  it("prefill only a plausible address and keep only a relative way back", async () => {
    expect(prefillEmail(`  ${INVITED} `)).toBe(INVITED);
    for (const value of [undefined, null, "", "   ", "a\u0000b@example.com", `${"x".repeat(250)}@e.co`]) {
      expect(prefillEmail(value)).toBeUndefined();
    }

    // A `next` that leaves the portal is dropped from the links between the two pages; the address stays.
    const hostile = "https://evil.example/x";
    render(await SignInPage({ searchParams: Promise.resolve({ email: INVITED, next: hostile }) }));
    expect(screen.getByRole("link", { name: SIGN_IN_STRINGS.signUp }).getAttribute("href")).toBe(
      `/sign-up?email=${encodeURIComponent(INVITED)}`,
    );
    cleanup();

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <SignUpPage
            searchParams={Promise.resolve({ email: "a\u0007b@example.com", next: "//evil.example" })}
          />
        </Suspense>,
      );
      await Promise.resolve();
    });
    const signIn = await screen.findByRole("link", { name: SIGN_UP_STRINGS.signIn }, ACTION_WAIT);
    expect(signIn.getAttribute("href")).toBe("/sign-in");
    expect((screen.getByLabelText(SIGN_UP_STRINGS.emailLabel) as HTMLInputElement).value).toBe("");
  });
});
