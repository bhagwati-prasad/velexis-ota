// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope, navigation and cache of Next.js and the configuration; the real API client talks ----
// ---- to an in-memory platform behind a mocked fetch, so the tests see every call the pages and actions send, and ----
// ---- the pages show what the platform holds after each action (as a revalidation would) ----------------------------

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

import { releaseOffice } from "@/app/(app)/amadeus/offices/actions";
import AmadeusOfficesPage from "@/app/(app)/amadeus/offices/page";
import { recheckDomain, removeDomain } from "@/app/(app)/domains/actions";
import { DomainTable, checkErrorText } from "@/app/(app)/domains/domain-table";
import DomainsPage from "@/app/(app)/domains/page";
import DashboardPage from "@/app/(app)/page";
import TenantDetailPage from "@/app/(app)/tenants/[tenantId]/page";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  ASSIGN_OFFICE_STRINGS,
  CONFIRM_STRINGS,
  DASHBOARD_STRINGS as D,
  DOMAIN_ACTION_STRINGS as A,
  DOMAIN_CHECK_ERRORS,
  DOMAIN_LIST_STRINGS as L,
  ERROR_MESSAGES,
  OFFICE_ACTION_STRINGS as O,
  PAYOUT_ACCOUNT_STRINGS,
  REASON_STRINGS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key or account) ----------------------------------------------------

type Schemas = components["schemas"];
type AdminDomain = Schemas["AdminDomain"];
type Office = Schemas["AdminAmadeusOffice"];
type AmadeusConnection = Schemas["AmadeusConnection"];
type TenantDetail = Schemas["AdminTenantDetail"];
type LiveOfficeRequest = Schemas["LiveOfficeRequest"];

const ACCESS_TOKEN = "pad014-dummy-admin-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PAD-014 test)";
const ACME_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const NORDIC_ID = "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G";
const PENDING_ID = "dom_01JD0A1B2C3D4E5F6G7H8J9K0M";
const VERIFIED_ID = "dom_01JB3K5N9Q3S7W1Y5A9C3E7G1J";
const FAILED_ID = "dom_01JD0B2C3D4E5F6G7H8J9K0M1N";
const SUBDOMAIN_ID = "dom_01JA2Z7S6P1T4W8Y2A5C9E3G7J";
const TEST_ACCOUNT_ID = "ama_01JA2Y8K3M7P1R5T9W3Z7C1F5H";
const LIVE_ACCOUNT_ID = "ama_01JC5M0P2R4T6V8X0Z2B4D6F8H";
/** Releasing since nordic moved to its own Amadeus credentials. */
const RELEASING_ROW = "amo_01JA2Y9N4Q8S2V6X0Z4B8D2G6J";
/** Assigned to acme, whose test connection on it is active. */
const ASSIGNED_ROW = "amo_01JA2YA0P5R9T3W7Y1A5C9E3G7";
/** An available live office, for acme's live request. */
const LIVE_ROW = "amo_01JC5M1Q3S5V7X9Z1B3D5F7H9K";
const ACME_TEST_CONNECTION = "sc_01JA2ZB9C3E7G1J5M9Q3S7V1X5";
const ACME_LIVE_CONNECTION = "sc_01JD1L2M3N4P5Q6R7S8T9V0W1X";
const NORDIC_LIVE_CONNECTION = "sc_01JD1M3N4P5Q6R7S8T9V0W1X2Y";
const REASON = "Phishing pages reported by the registrar on 2027-03-02 (case 88231).";
const RELEASE_REASON =
  "Nordic confirmed on 2027-05-03 that no booking with future travel remains on MUC1A0100.";
/** When the owners of acme and nordic requested live access (their live connections' creation). */
const ACME_REQUESTED_AT = "2027-03-01T09:12:00Z";
const NORDIC_REQUESTED_AT = "2027-01-11T14:02:00Z";

/**
 * The budget of the warm-up hook: the first render of these pages in a fresh worker loads the module graph of the
 * tables, the tabs, the filter bar and the dialogs, and the first server action runs React's action queue for the first
 * time. On a loaded runner that takes seconds; the hook only stops one that hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * How long a step that runs a server action (a round trip through the real `lib/api.ts`) and re-renders the forms may
 * take. Testing Library's 1 s default is enough on an idle machine, not on a loaded CI runner; each test's own 5 s
 * budget is unchanged.
 */
const UI_WAIT = { timeout: 3_000 } as const;

/**
 * `LIVE_OFFICE_REQUESTS_LIMIT` of `(app)/page.tsx` (a page module exports nothing else): the `maxItems` of
 * `AdminDashboard.liveOfficeRequests`, at which the section says the oldest requests are shown.
 */
const LIVE_OFFICE_REQUESTS_LIMIT = 50;

function domain(overrides: Partial<AdminDomain> = {}): AdminDomain {
  return {
    id: PENDING_ID,
    tenantId: ACME_ID,
    tenantKey: "acme",
    hostname: "book.acme-travel.example.com",
    kind: "custom",
    purpose: "storefront",
    isPrimary: false,
    verificationStatus: "pending",
    verifiedAt: null,
    verificationDeadlineAt: "2027-03-07T10:00:00Z",
    lastCheckedAt: "2027-03-04T10:15:00Z",
    lastCheckError: "txt_missing",
    checkFailures: 0,
    tlsStatus: "pending",
    tlsExpiresAt: null,
    tlsCheckedAt: null,
    createdAt: "2027-03-04T10:00:00Z",
    ...overrides,
  };
}

/** The hosts of the fleet, newest first: a pending, a verified (primary), a failed custom domain and a sub-domain. */
function hosts(): AdminDomain[] {
  return [
    domain(),
    domain({
      id: VERIFIED_ID,
      tenantId: NORDIC_ID,
      tenantKey: "nordic",
      hostname: "travel.nordic-fares.example.com",
      isPrimary: true,
      verificationStatus: "verified",
      verifiedAt: "2026-11-18T10:25:00Z",
      verificationDeadlineAt: "2026-11-21T10:00:00Z",
      lastCheckedAt: "2027-03-04T04:10:12Z",
      lastCheckError: "cname_wrong_target",
      checkFailures: 2,
      tlsStatus: "issued",
      tlsExpiresAt: "2027-05-17T10:26:41Z",
      tlsCheckedAt: "2027-03-04T04:40:08Z",
      createdAt: "2026-11-18T10:00:00Z",
    }),
    domain({
      id: FAILED_ID,
      hostname: "old.acme-travel.example.com",
      verificationStatus: "failed",
      verificationDeadlineAt: "2026-11-05T09:00:00Z",
      lastCheckedAt: "2026-11-05T09:00:00Z",
      lastCheckError: "dns_timeout",
      tlsStatus: "failed",
      createdAt: "2026-11-02T09:00:00Z",
    }),
    domain({
      id: SUBDOMAIN_ID,
      hostname: "acme.ota.example.com",
      kind: "subdomain",
      verificationStatus: "verified",
      verifiedAt: "2026-10-14T08:20:14Z",
      verificationDeadlineAt: null,
      lastCheckedAt: null,
      lastCheckError: null,
      tlsStatus: "issued",
      tlsExpiresAt: "2027-05-02T11:04:19Z",
      tlsCheckedAt: "2027-03-04T04:40:05Z",
      createdAt: "2026-10-14T08:20:14Z",
    }),
  ];
}

function office(overrides: Partial<Office> = {}): Office {
  return {
    id: RELEASING_ROW,
    amadeusAccountId: TEST_ACCOUNT_ID,
    officeId: "MUC1A0100",
    environment: "test",
    status: "releasing",
    assignedTenant: { id: NORDIC_ID, key: "nordic" },
    assignedAt: "2026-10-16T13:40:10Z",
    releaseRequestedAt: "2027-04-02T12:00:00Z",
    releasedAt: null,
    notes: null,
    createdAt: "2026-10-02T09:20:00Z",
    version: 4,
    ...overrides,
  };
}

function pool(): Office[] {
  return [
    office(),
    office({
      id: ASSIGNED_ROW,
      officeId: "NCE1A0955",
      status: "assigned",
      assignedTenant: { id: ACME_ID, key: "acme" },
      assignedAt: "2026-10-14T08:20:16Z",
      releaseRequestedAt: null,
      version: 2,
    }),
    office({
      id: LIVE_ROW,
      amadeusAccountId: LIVE_ACCOUNT_ID,
      officeId: "LIV1A0001",
      environment: "live",
      status: "available",
      assignedTenant: null,
      assignedAt: null,
      releaseRequestedAt: null,
      notes: "Live onboarding of acme signed on 2027-03-02; ticketing agreement TA-118.",
      version: 1,
    }),
  ];
}

function account(environment: "test" | "live"): Schemas["AdminAmadeusAccount"] {
  return {
    id: environment === "test" ? TEST_ACCOUNT_ID : LIVE_ACCOUNT_ID,
    name: environment === "test" ? "Velexis test" : "Velexis live",
    environment,
    baseUrl:
      environment === "test" ? "https://test.travel.api.amadeus.com" : "https://travel.api.amadeus.com",
    clientId: "pad014-dummy-client-id-1234",
    status: "active",
    lastVerifiedAt: "2026-10-20T06:00:04Z",
    lastError: null,
    officeCounts: { available: 1, assigned: 1, releasing: 0, retired: 0 },
    createdAt: "2026-10-02T09:15:00Z",
    version: 3,
  };
}

function connection(overrides: Partial<AmadeusConnection> = {}): AmadeusConnection {
  return {
    id: ACME_TEST_CONNECTION,
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

/** The live connection of an owner's request: Velexis credentials, no office yet (`requestLiveAmadeus`). */
function waitingLiveConnection(id: string): AmadeusConnection {
  return connection({
    id,
    environment: "live",
    status: "pending_verification",
    officeIds: [],
    defaultOfficeId: null,
    queuingOfficeId: null,
    ownerOfficeId: null,
    lastVerifiedAt: null,
  });
}

function tenantDetail(
  tenantId: string,
  key: string,
  name: string,
  amadeusConnections: AmadeusConnection[],
): TenantDetail {
  return {
    tenant: {
      id: tenantId,
      key,
      name,
      legalName: null,
      status: "active",
      suspensionReason: null,
      suspendedAt: null,
      billingNotice: null,
      planCode: "growth",
      defaultCurrency: "EUR",
      countryCode: "NO",
      timeZone: "Europe/Oslo",
      supportEmail: null,
      storefrontEnvironment: "test",
      liveEnabledAt: null,
      primaryHost: `${key}.ota.example.com`,
      schemaVersion: "0001_baseline",
      notes: null,
      createdAt: "2026-10-14T08:20:11Z",
      activatedAt: "2026-10-14T08:20:16Z",
      version: 3,
    },
    members: [],
    invitations: [],
    subscription: null,
    amadeusConnections,
    paymentConnections: [],
    domains: [],
    recentJobs: [],
    recentAudit: [],
  };
}

function dashboard(overrides: Partial<Schemas["AdminDashboard"]> = {}): Schemas["AdminDashboard"] {
  return {
    tenantsByStatus: { provisioning: 0, active: 2, suspended: 0, failed: 0 },
    provisioningFailed24h: 0,
    jobsFailedByQueue: {
      "platform-tenant-events": 0,
      "platform-emails": 0,
      "platform-stripe-events": 0,
      "platform-domains": 0,
      "platform-connections": 0,
      "platform-settlements": 0,
      "platform-maintenance": 0,
    },
    officePool: [
      { environment: "test", available: 4, assigned: 1 },
      { environment: "live", available: 1, assigned: 0 },
    ],
    domainsPending: 3,
    settlementsToReview: 9,
    stripeEventsFailed: 1,
    subscriptionsPastDue: 2,
    liveOfficeRequests: [],
    ...overrides,
  };
}

/** One request of `AdminDashboard.liveOfficeRequests`. */
function liveOfficeRequest(
  tenantId: string,
  tenantKey: string,
  tenantName: string,
  connectionId: string,
  requestedAt: string,
): LiveOfficeRequest {
  return { tenantId, tenantKey, tenantName, connectionId, requestedAt };
}

// ---- The in-memory platform ----------------------------------------------------------------------------------------

interface Platform {
  domains: AdminDomain[];
  offices: Office[];
  tenants: Map<string, TenantDetail>;
  /** When each live connection was requested (its creation), by connection id. */
  liveRequestedAt: Map<string, string>;
  /**
   * The dashboard's counters; its `liveOfficeRequests` are the live connections of `tenants` that wait for an office,
   * oldest request first (the API's rule), unless a test sets `liveOfficeRequests` below.
   */
  dashboard: Schemas["AdminDashboard"];
  /** The live office requests the dashboard answers as they are, instead of the ones of `tenants`. */
  liveOfficeRequests: LiveOfficeRequest[] | undefined;
  /** The checks each re-check queued, by host id. */
  rechecks: string[];
  overrides: Record<string, Route>;
}

type Route = (request: Request) => Response | Promise<Response>;

let platform: Platform;

function freshPlatform(): Platform {
  return {
    domains: hosts(),
    offices: pool(),
    tenants: new Map([
      [
        ACME_ID,
        tenantDetail(ACME_ID, "acme", "Acme Travel", [
          connection(),
          waitingLiveConnection(ACME_LIVE_CONNECTION),
        ]),
      ],
      [
        NORDIC_ID,
        tenantDetail(NORDIC_ID, "nordic", "Nordic Fares", [
          // Served already: an office was assigned, the connection is active.
          connection({
            id: NORDIC_LIVE_CONNECTION,
            environment: "live",
            officeIds: ["LIV1A0002"],
            defaultOfficeId: "LIV1A0002",
            queuingOfficeId: "LIV1A0002",
            ownerOfficeId: "LIV1A0002",
          }),
        ]),
      ],
    ]),
    liveRequestedAt: new Map([
      [ACME_LIVE_CONNECTION, ACME_REQUESTED_AT],
      [NORDIC_LIVE_CONNECTION, NORDIC_REQUESTED_AT],
    ]),
    dashboard: dashboard(),
    liveOfficeRequests: undefined,
    rechecks: [],
    overrides: {},
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An error envelope of the platform API; its `message` must never reach the page. */
function apiError(
  code: string,
  status: number,
  extra: { details?: Record<string, unknown>; fieldErrors?: unknown[] } = {},
  headers: Record<string, string> = {},
): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pad014",
        ...extra,
      },
    },
    status,
    headers,
  );
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const text = await request.clone().text();
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** A reason as `AdminReason` takes it: 5–500 characters once trimmed. */
function validReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 5 && value.trim().length <= 500;
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { "content-length": "0" } });
}

/**
 * The live office requests of the in-memory platform, as the API reads them from the connections: each OTA's `live`
 * Velexis connection that is `pending_verification` without an office, oldest request first, then by connection id.
 */
function waitingLiveRequests(): LiveOfficeRequest[] {
  const requests: LiveOfficeRequest[] = [];
  for (const detail of platform.tenants.values()) {
    for (const candidate of detail.amadeusConnections) {
      if (
        candidate.environment === "live" &&
        candidate.credentialSource === "velexis" &&
        candidate.status === "pending_verification" &&
        candidate.officeIds.length === 0
      ) {
        requests.push(
          liveOfficeRequest(
            detail.tenant.id,
            detail.tenant.key,
            detail.tenant.name,
            candidate.id,
            platform.liveRequestedAt.get(candidate.id) ?? "2027-01-01T00:00:00Z",
          ),
        );
      }
    }
  }
  return requests.sort(
    (a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.connectionId.localeCompare(b.connectionId),
  );
}

/** Answers one call as the platform API would. */
async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const key = `${request.method} ${path}`;
  const override = platform.overrides[key];
  if (override !== undefined) {
    return override(request);
  }
  const query = url.searchParams;

  if (key === "GET /v1/admin/dashboard") {
    return json(
      { ...platform.dashboard, liveOfficeRequests: platform.liveOfficeRequests ?? waitingLiveRequests() },
      200,
    );
  }

  if (key === "GET /v1/admin/domains") {
    if (query.get("cursor") === "stale") {
      return apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "never shown" }],
      });
    }
    const rows = platform.domains.filter(
      (row) =>
        (query.get("kind") === null || row.kind === query.get("kind")) &&
        (query.get("verificationStatus") === null ||
          row.verificationStatus === query.get("verificationStatus")) &&
        (query.get("tlsStatus") === null || row.tlsStatus === query.get("tlsStatus")),
    );
    return json({ data: rows, page: { nextCursor: null, limit: 50 } }, 200);
  }

  const domainMatch = /^\/v1\/admin\/domains\/(dom_[0-9A-Z]{26})\/(recheck|remove)$/.exec(path);
  if (domainMatch !== null && request.method === "POST") {
    const [, domainId = "", action] = domainMatch;
    const row = platform.domains.find((candidate) => candidate.id === domainId);
    if (row === undefined) {
      return apiError("NOT_FOUND", 404);
    }
    if (action === "recheck") {
      platform.rechecks.push(domainId);
      // The queued checks run before the admin reloads: the DNS check passes, the certificate is issued.
      platform.domains = platform.domains.map((candidate) =>
        candidate.id === domainId
          ? {
              ...candidate,
              lastCheckedAt: "2027-03-04T11:00:00Z",
              lastCheckError: null,
              tlsStatus: "issued",
              tlsExpiresAt: "2027-06-02T11:00:00Z",
              tlsCheckedAt: "2027-03-04T11:00:02Z",
            }
          : candidate,
      );
      return empty(202);
    }
    const body = await bodyOf(request);
    if (!validReason(body["reason"])) {
      return apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/reason", code: "minLength" }] });
    }
    if (row.kind === "subdomain") {
      return apiError("CONFLICT", 409, { details: { reason: "subdomain" } });
    }
    platform.domains = platform.domains.filter((candidate) => candidate.id !== domainId);
    return empty(204);
  }

  if (key === "GET /v1/admin/amadeus-accounts") {
    return json({ data: [account("test"), account("live")] }, 200);
  }

  if (key === "GET /v1/admin/amadeus-offices") {
    const rows = platform.offices.filter(
      (row) =>
        (query.get("environment") === null || row.environment === query.get("environment")) &&
        (query.get("status") === null || row.status === query.get("status")),
    );
    return json({ data: rows, page: { nextCursor: null, limit: Number(query.get("limit") ?? 50) } }, 200);
  }

  const officeMatch = /^\/v1\/admin\/amadeus-offices\/(amo_[0-9A-Z]{26})\/(release|assign)$/.exec(path);
  if (officeMatch !== null && request.method === "POST") {
    const [, officeRowId = "", action] = officeMatch;
    const row = platform.offices.find((candidate) => candidate.id === officeRowId);
    if (row === undefined) {
      return apiError("NOT_FOUND", 404);
    }
    const body = await bodyOf(request);
    if (action === "release") {
      if (body["confirmNoOpenBookings"] !== true || !validReason(body["reason"])) {
        return apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [{ path: "/confirmNoOpenBookings", code: "const" }],
        });
      }
      if (row.status !== "assigned" && row.status !== "releasing") {
        return apiError("CONFLICT", 409, { details: { reason: "not_assigned" } });
      }
      const tenant = row.assignedTenant === null ? undefined : platform.tenants.get(row.assignedTenant.id);
      const backsActive = tenant?.amadeusConnections.some(
        (candidate) =>
          candidate.credentialSource === "velexis" &&
          candidate.status === "active" &&
          candidate.officeIds.includes(row.officeId),
      );
      if (row.status === "assigned" && backsActive === true) {
        return apiError("CONFLICT", 409, { details: { reason: "connection_active" } });
      }
      const released: Office = {
        ...row,
        status: "available",
        assignedTenant: null,
        assignedAt: null,
        releaseRequestedAt: null,
        releasedAt: "2027-05-03T14:20:09Z",
        version: row.version + 1,
      };
      platform.offices = platform.offices.map((candidate) =>
        candidate.id === row.id ? released : candidate,
      );
      return json(released, 200);
    }
    // assign: completes the OTA's waiting `velexis` connection of the office's environment.
    const tenantId = String(body["tenantId"]);
    const tenant = platform.tenants.get(tenantId);
    if (tenant === undefined) {
      return apiError("NOT_FOUND", 404);
    }
    if (row.status !== "available") {
      return apiError("AMADEUS_OFFICE_UNAVAILABLE", 409);
    }
    const assigned: Office = {
      ...row,
      status: "assigned",
      assignedTenant: { id: tenantId, key: tenant.tenant.key },
      assignedAt: "2027-03-04T09:30:00Z",
      version: row.version + 1,
    };
    platform.offices = platform.offices.map((candidate) => (candidate.id === row.id ? assigned : candidate));
    let completed: AmadeusConnection | undefined;
    const amadeusConnections = tenant.amadeusConnections.map((candidate) => {
      if (candidate.environment !== row.environment || candidate.credentialSource !== "velexis") {
        return candidate;
      }
      completed = {
        ...candidate,
        status: "active",
        officeIds: [row.officeId],
        defaultOfficeId: row.officeId,
        queuingOfficeId: row.officeId,
        ownerOfficeId: row.officeId,
        version: candidate.version + 1,
      };
      return completed;
    });
    platform.tenants.set(tenantId, { ...tenant, amadeusConnections });
    return json({ office: assigned, connection: completed }, 200);
  }

  const payoutMatch = /^\/v1\/admin\/tenants\/(ten_[0-9A-Z]{26})\/payout-account$/.exec(path);
  if (payoutMatch !== null) {
    return apiError("NOT_FOUND", 404);
  }

  const tenantMatch = /^\/v1\/admin\/tenants\/(ten_[0-9A-Z]{26})$/.exec(path);
  if (tenantMatch !== null && request.method === "GET") {
    const detail = platform.tenants.get(tenantMatch[1] ?? "");
    return detail === undefined ? apiError("NOT_FOUND", 404) : json(detail, 200);
  }
  throw new Error(`unexpected call ${request.method} ${request.url}`);
}

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

/** The calls of `METHOD /path` so far. */
function calls(method: string, path: string): Request[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => input.method === method && new URL(input.url).pathname === path);
}

/** The JSON bodies of the calls of `METHOD /path` so far (`null` for a call without a body). */
async function bodies(method: string, path: string): Promise<unknown[]> {
  return Promise.all(
    calls(method, path).map(async (request) => {
      const text = await request.clone().text();
      return text === "" ? null : (JSON.parse(text) as unknown);
    }),
  );
}

function sortedQuery(search: string): [string, string][] {
  return [...new URLSearchParams(search).entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The query of each call of `GET path`, as sorted entries. */
function queriesOf(path: string): [string, string][][] {
  return calls("GET", path).map((request) => sortedQuery(new URL(request.url).search));
}

/** Every call so far, as `METHOD /path`. */
function callKeys(): string[] {
  return fetchMock.mock.calls.map(([input]) => `${input.method} ${new URL(input.url).pathname}`);
}

/** The instant a live office request row shows (its `<time>` element's `dateTime`). */
function requestedAtOf(row: HTMLElement): string | null {
  return row.querySelector("time")?.getAttribute("datetime") ?? null;
}

/** Every call carries the admin session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

/** The cookie store of the request. */
const cookieStore = {
  get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
  has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
  set: vi.fn(),
};

function resetPlatformApi(): void {
  platform = freshPlatform();
  fetchMock.mockReset();
  fetchMock.mockImplementation(answer);
  vi.stubGlobal("fetch", fetchMock);
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pad014_admin",
    }),
  );
  cookieStore.set.mockReset();
  nextHeaders.cookies.mockResolvedValue(cookieStore);
  nextCache.revalidatePath.mockReset();
  for (const method of Object.values(navigation.router)) {
    method.mockReset();
  }
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
}

// ---- Rendering and interaction ---------------------------------------------------------------------------------------

/** The page's `searchParams` as Next.js 15 passes them: a repeated parameter is an array. */
function searchParamsOf(search: string): Promise<Record<string, string | string[]>> {
  const record: Record<string, string | string[]> = {};
  for (const [name, value] of new URLSearchParams(search).entries()) {
    const current = record[name];
    record[name] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
  }
  return Promise.resolve(record);
}

function setUrl(pathname: string, search = ""): void {
  navigation.pathname = pathname;
  navigation.searchParams = new URLSearchParams(search);
}

interface View {
  /** Renders the page again, as Next.js does after an action revalidated it. */
  readonly rerender: () => Promise<void>;
}

async function open(pathname: string, search: string, page: () => Promise<ReactElement>): Promise<View> {
  setUrl(pathname, search);
  const view = render(await page());
  return {
    rerender: async () => {
      view.rerender(await page());
    },
  };
}

function openDomains(search = ""): Promise<View> {
  return open("/domains", search, () => DomainsPage({ searchParams: searchParamsOf(search) }));
}

function openOffices(search = ""): Promise<View> {
  return open("/amadeus/offices", search, () => AmadeusOfficesPage({ searchParams: searchParamsOf(search) }));
}

function openDashboard(): Promise<View> {
  return open("/", "", () => DashboardPage());
}

function openTenant(tenantId: string, search: string): Promise<View> {
  return open(`/tenants/${tenantId}`, search, () =>
    TenantDetailPage({ params: Promise.resolve({ tenantId }) }),
  );
}

function link(name: string | RegExp, container: HTMLElement = document.body): HTMLAnchorElement {
  return within(container).getByRole("link", { name }) as HTMLAnchorElement;
}

function hrefOf(element: HTMLAnchorElement): string | null {
  return element.getAttribute("href");
}

/** The table row that shows `text` (a host name or an office id; its buttons name it too, for screen readers). */
function rowOf(text: string): HTMLElement {
  const [cell] = within(screen.getByRole("table")).getAllByText(text);
  const row = cell?.closest("tr") ?? null;
  if (row === null) {
    throw new Error(`no row of ${text}`);
  }
  return row;
}

/** The names of the buttons of a row. */
function buttonsOf(row: HTMLElement): (string | null)[] {
  return within(row)
    .queryAllByRole("button")
    .map((button) => button.textContent);
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

/** The notice of the action that just answered (`data-notice="done"` or `"failed"`), once it shows. */
async function notice(kind: "done" | "failed", container: HTMLElement = document.body): Promise<HTMLElement> {
  return waitFor(() => {
    const element = container.querySelector<HTMLElement>(`[data-notice="${kind}"]`);
    if (element === null) {
      throw new Error(`no ${kind} notice yet`);
    }
    return element;
  }, UI_WAIT);
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

function revalidated(): string[] {
  return nextCache.revalidatePath.mock.calls.map(([path]) => path as string);
}

/** The `data-status` of the badges of a row, in order. */
function statusesOf(row: HTMLElement): (string | null)[] {
  return [...row.querySelectorAll("[data-status]")].map((badge) => badge.getAttribute("data-status"));
}

// ---- The platform document -------------------------------------------------------------------------------------------

function repositoryRoot(): string {
  let folder = process.cwd();
  while (!existsSync(join(folder, "pnpm-workspace.yaml"))) {
    const parent = dirname(folder);
    if (parent === folder) {
      throw new Error("No pnpm-workspace.yaml above the working directory.");
    }
    folder = parent;
  }
  return folder;
}

/** The lines of the platform OpenAPI document, read once by the warm-up hook (it is large). */
let platformDocument: readonly string[] = [];

/**
 * What an operation of the platform document requires of the admin (PADR-0006 items 4 and 5): `x-reason-required`
 * (a reason in the body) and `x-mfa-step-up` (a TOTP verification in the last 15 minutes), read from its block.
 */
function operationRequirements(operationId: string): { reason: boolean; stepUp: boolean } {
  const start = platformDocument.findIndex((text) => text.trim() === `operationId: ${operationId}`);
  expect(start).toBeGreaterThan(-1);
  const block: string[] = [];
  for (const text of platformDocument.slice(start + 1)) {
    // The next operation of the path, or the next path.
    if (/^\s+operationId:/.test(text) || /^ {2}\//.test(text)) {
      break;
    }
    block.push(text.trim());
  }
  return { reason: block.includes("x-reason-required: true"), stepUp: block.includes("x-mfa-step-up: true") };
}

/** The props of every element of `component` in a server component's output (the client props Next.js would send). */
function propsOf(node: ReactNode, component: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (isValidElement(value)) {
      const { type, props } = value as ReactElement<Record<string, unknown>>;
      if (type === component) {
        found.push(props);
      }
      visit(props["children"]);
    }
  };
  visit(node);
  return found;
}

// ---- Hooks -------------------------------------------------------------------------------------------------------------

/**
 * Once per file, before any test: the first render of these pages in a fresh worker (the tables, the filter bar, the
 * dialogs, the tenant tabs) and the first server action through the real API client are the slowest steps, and on a
 * busy CI runner they would otherwise land in the first test's own five seconds. Nothing of it stays: each test gets a
 * fresh platform and an empty document.
 */
beforeAll(async () => {
  platformDocument = readFileSync(
    join(repositoryRoot(), "platform/backend/openapi/velexis-platform-api.openapi.yaml"),
    "utf8",
  ).split("\n");
  resetPlatformApi();
  await openDomains();
  fireEvent.click(within(rowOf("book.acme-travel.example.com")).getByRole("button", { name: /^Remove/ }));
  await screen.findByRole("dialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openOffices();
  fireEvent.click(within(rowOf("MUC1A0100")).getByRole("button", { name: /^Release/ }));
  await screen.findByRole("dialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openDashboard();
  cleanup();
  await openTenant(ACME_ID, "tab=connections");
  // The payout account panel of the tab loads itself; its answer is awaited, so no call outlives the hook.
  await screen.findByText(PAYOUT_ACCOUNT_STRINGS.none, {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await recheckDomain(
    { status: "idle" },
    formData({ domainId: PENDING_ID, hostname: "book.acme-travel.example.com" }),
  );
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- /domains ----------------------------------------------------------------------------------------------------------

describe("domains/page.tsx: the storefront hosts of every OTA", () => {
  it("[PAD-014 AC1] lists every custom domain with its verification and TLS state, the filters in the URL [PF-92]", async () => {
    await openDomains("kind=custom");
    expect(queriesOf("/v1/admin/domains")).toEqual([[["kind", "custom"]]]);
    expectSessionHeaders(calls("GET", "/v1/admin/domains")[0]);
    expect(screen.getByRole("heading", { level: 1, name: L.title })).toBeTruthy();

    // A pending domain: its window's end and what the last DNS check found missing, in words.
    const pending = rowOf("book.acme-travel.example.com");
    expect(statusesOf(pending)).toEqual(["pending", "pending"]);
    expect(pending.textContent).toContain(L.deadline);
    expect(within(pending).getByText(DOMAIN_CHECK_ERRORS.txt_missing)).toBeTruthy();
    expect(within(pending).getByText(L.noTls)).toBeTruthy();
    expect(hrefOf(link("acme", pending))).toBe(`/tenants/${ACME_ID}?tab=domains`);

    // A verified primary domain: two failed daily re-checks of three, the certificate's expiry and last probe.
    const verified = rowOf("travel.nordic-fares.example.com");
    expect(statusesOf(verified)).toEqual(["verified", "issued"]);
    expect(within(verified).getByText(L.primary)).toBeTruthy();
    expect(within(verified).getByText(L.checkFailures(2))).toBeTruthy();
    expect(within(verified).getByText(DOMAIN_CHECK_ERRORS.cname_wrong_target)).toBeTruthy();
    expect(verified.textContent).toContain(L.tlsExpires);
    expect(verified.textContent).toContain(L.tlsChecked);
    expect(hrefOf(link("nordic", verified))).toBe(`/tenants/${NORDIC_ID}?tab=domains`);

    const failed = rowOf("old.acme-travel.example.com");
    expect(statusesOf(failed)).toEqual(["failed", "failed"]);
    expect(within(failed).getByText(DOMAIN_CHECK_ERRORS.dns_timeout)).toBeTruthy();
    // The filter of the URL holds: no sub-domain.
    expect(screen.queryByText("acme.ota.example.com")).toBeNull();
    expect((screen.getByLabelText(L.kindLabel) as HTMLSelectElement).value).toBe("custom");
    cleanup();

    // Without a filter every host shows, the sub-domain too; a sub-domain can be re-checked, never removed.
    await openDomains();
    const subdomain = rowOf("acme.ota.example.com");
    expect(within(subdomain).getByText(L.neverChecked)).toBeTruthy();
    expect(buttonsOf(subdomain)).toEqual([`${A.recheck}${A.hostSuffix("acme.ota.example.com")}`]);
    expect(buttonsOf(rowOf("book.acme-travel.example.com"))).toEqual([
      `${A.recheck}${A.hostSuffix("book.acme-travel.example.com")}`,
      `${A.remove}${A.hostSuffix("book.acme-travel.example.com")}`,
    ]);
    cleanup();

    // The dashboard's link: the custom domains that wait for their DNS records.
    await openDomains("kind=custom&verificationStatus=pending&tlsStatus=pending");
    expect(queriesOf("/v1/admin/domains").at(-1)).toEqual([
      ["kind", "custom"],
      ["tlsStatus", "pending"],
      ["verificationStatus", "pending"],
    ]);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    // Looking at the hosts changes nothing.
    expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("[PAD-014 AC1] re-checks a host now after a confirmation that says what is checked [PF-92]", async () => {
    expect(operationRequirements("adminRecheckDomain")).toEqual({ reason: false, stepUp: false });
    const path = `/v1/admin/domains/${PENDING_ID}/recheck`;
    const view = await openDomains("kind=custom");

    fireEvent.click(
      within(rowOf("book.acme-travel.example.com")).getByRole("button", {
        name: `${A.recheck}${A.hostSuffix("book.acme-travel.example.com")}`,
      }),
    );
    const confirm = await screen.findByRole(
      "alertdialog",
      { name: A.recheckTitle("book.acme-travel.example.com") },
      UI_WAIT,
    );
    expect(confirm.textContent).toContain(A.recheckPending);
    // Cancelling sends nothing.
    fireEvent.click(within(confirm).getByRole("button", { name: CONFIRM_STRINGS.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), UI_WAIT);
    expect(calls("POST", path)).toHaveLength(0);

    fireEvent.click(
      within(rowOf("book.acme-travel.example.com")).getByRole("button", {
        name: `${A.recheck}${A.hostSuffix("book.acme-travel.example.com")}`,
      }),
    );
    const again = await screen.findByRole("alertdialog", {}, UI_WAIT);
    fireEvent.click(within(again).getByRole("button", { name: A.recheckConfirm }));

    expect((await notice("done")).textContent).toBe(A.rechecked("book.acme-travel.example.com"));
    // The check is queued with no body: neither a reason nor a step-up is asked for.
    expect(await bodies("POST", path)).toEqual([null]);
    expectSessionHeaders(calls("POST", path)[0]);
    expect(revalidated()).toEqual(["/domains"]);

    // The reloaded list shows the result of the checks once they ran.
    await view.rerender();
    const row = rowOf("book.acme-travel.example.com");
    expect(within(row).getByText(L.checkPassed)).toBeTruthy();
    expect(statusesOf(row)).toEqual(["pending", "issued"]);

    // What the dialog says follows the kind and the status of the host.
    for (const [hostname, words] of [
      ["travel.nordic-fares.example.com", A.recheckVerified],
      ["old.acme-travel.example.com", A.recheckFailed],
    ] as const) {
      fireEvent.click(
        within(rowOf(hostname)).getByRole("button", { name: `${A.recheck}${A.hostSuffix(hostname)}` }),
      );
      const dialog = await screen.findByRole("alertdialog", { name: A.recheckTitle(hostname) }, UI_WAIT);
      expect(dialog.textContent).toContain(words);
      fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM_STRINGS.cancel }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), UI_WAIT);
    }
  });

  it("words a re-check that cannot be queued, a rate limit and a host that is gone", async () => {
    const path = `/v1/admin/domains/${VERIFIED_ID}/recheck`;
    const input = formData({ domainId: VERIFIED_ID, hostname: "travel.nordic-fares.example.com" });

    platform.overrides[`POST ${path}`] = () => apiError("SERVICE_UNAVAILABLE", 503);
    const unavailable = await recheckDomain({ status: "idle" }, input);
    expect(unavailable).toMatchObject({
      status: "failed",
      code: "SERVICE_UNAVAILABLE",
      message: A.recheckUnavailable,
    });

    platform.overrides[`POST ${path}`] = () => apiError("RATE_LIMITED", 429, {}, { "retry-after": "40" });
    const limited = await recheckDomain({ status: "idle" }, input);
    expect(limited).toMatchObject({ status: "failed", code: "RATE_LIMITED", message: A.rateLimitedFor(40) });

    platform.overrides[`POST ${path}`] = () => apiError("NOT_FOUND", 404);
    const gone = await recheckDomain({ status: "idle" }, input);
    expect(gone).toMatchObject({ status: "failed", code: "NOT_FOUND", message: A.domainGone });
    expect(JSON.stringify([unavailable, limited, gone])).not.toContain("The API's own text");

    // An ended session signs in again and comes back to the domains.
    platform.overrides[`POST ${path}`] = () => apiError("TOKEN_EXPIRED", 401);
    await expect(recheckDomain({ status: "idle" }, input)).rejects.toThrow(
      "NEXT_REDIRECT /sign-in?next=%2Fdomains",
    );

    // Made-up fields send nothing.
    fetchMock.mockClear();
    expect(
      await recheckDomain({ status: "idle" }, formData({ domainId: "dom_nope", hostname: "x.example.com" })),
    ).toMatchObject({ status: "failed", code: "VALIDATION_FAILED", message: A.formExpired });
    expect(
      await recheckDomain({ status: "idle" }, formData({ domainId: VERIFIED_ID, hostname: "Not a host!" })),
    ).toMatchObject({ status: "failed", code: "VALIDATION_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[PAD-014 AC1] removes an abusive custom domain with a trimmed reason, and says the owners get an e-mail [PF-92]", async () => {
    expect(operationRequirements("adminRemoveDomain")).toEqual({ reason: true, stepUp: false });
    const path = `/v1/admin/domains/${VERIFIED_ID}/remove`;
    const view = await openDomains();

    fireEvent.click(
      within(rowOf("travel.nordic-fares.example.com")).getByRole("button", {
        name: `${A.remove}${A.hostSuffix("travel.nordic-fares.example.com")}`,
      }),
    );
    const dialog = await screen.findByRole(
      "dialog",
      { name: A.removeTitle("travel.nordic-fares.example.com") },
      UI_WAIT,
    );
    expect(dialog.textContent).toContain(A.removeDescription("nordic"));
    // A reason that is too short is refused at the field, and nothing is sent.
    fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: "  bad " } });
    submit(A.removeConfirm, dialog);
    expect(within(dialog).getByText(REASON_STRINGS.tooShort)).toBeTruthy();
    expect(calls("POST", path)).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), {
      target: { value: `   ${REASON}  ` },
    });
    submit(A.removeConfirm, dialog);
    expect((await notice("done")).textContent).toBe(A.removed("travel.nordic-fares.example.com"));
    expect(await bodies("POST", path)).toEqual([{ reason: REASON }]);
    expectSessionHeaders(calls("POST", path)[0]);
    // The list, the dashboard's count and the OTA's domains tab follow.
    expect(revalidated()).toEqual(["/domains", "/", `/tenants/${NORDIC_ID}`]);

    await view.rerender();
    expect(within(screen.getByRole("table")).queryByText("travel.nordic-fares.example.com")).toBeNull();
    expect(screen.getByText(A.removed("travel.nordic-fares.example.com"))).toBeTruthy();
  });

  it("words the refusals of a removal, and the action checks the reason and the ids before calling the API", async () => {
    const remove = (values: Record<string, string>) => removeDomain({ status: "idle" }, formData(values));
    const base = {
      domainId: SUBDOMAIN_ID,
      hostname: "acme.ota.example.com",
      tenantId: ACME_ID,
      reason: REASON,
    };
    // The table offers no removal for a sub-domain; the API's refusal is worded all the same.
    expect(await remove(base)).toMatchObject({ status: "failed", code: "CONFLICT", message: A.subdomain });
    expect(await remove({ ...base, domainId: "dom_01JE0D4E5F6G7H8J9K0M1N2P3Q" })).toMatchObject({
      status: "failed",
      code: "NOT_FOUND",
      message: A.domainGone,
    });
    platform.overrides[`POST /v1/admin/domains/${PENDING_ID}/remove`] = () => apiError("TOKEN_EXPIRED", 401);
    await expect(remove({ ...base, domainId: PENDING_ID })).rejects.toThrow(
      "NEXT_REDIRECT /sign-in?next=%2Fdomains",
    );

    fetchMock.mockClear();
    expect(await remove({ ...base, domainId: PENDING_ID, reason: " ok  " })).toMatchObject({
      status: "failed",
      code: "VALIDATION_FAILED",
      message: REASON_STRINGS.tooShort,
    });
    expect(await remove({ ...base, domainId: PENDING_ID, reason: "x".repeat(501) })).toMatchObject({
      message: REASON_STRINGS.tooLong,
    });
    expect(await remove({ ...base, tenantId: "acme" })).toMatchObject({ message: A.formExpired });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a notice for filters the API would refuse, and sends an ended session to sign-in", async () => {
    await openDomains("kind=apex");
    expect(screen.getByText(L.invalidFilters)).toBeTruthy();
    expect(hrefOf(link(L.showAll))).toBe("/domains");
    expect(calls("GET", "/v1/admin/domains")).toHaveLength(0);
    cleanup();

    await openDomains("tlsStatus=issued&tlsStatus=failed");
    expect(screen.getByText(L.invalidFilters)).toBeTruthy();
    expect(calls("GET", "/v1/admin/domains")).toHaveLength(0);
    cleanup();

    await openDomains("cursor=stale");
    expect(screen.getByText(L.invalidFilters)).toBeTruthy();
    cleanup();

    platform.overrides["GET /v1/admin/domains"] = () => apiError("SERVICE_UNAVAILABLE", 503);
    await openDomains();
    expect(screen.getByRole("alert").textContent).toContain(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(document.body.textContent).not.toContain("The API's own text");
    cleanup();

    platform.overrides["GET /v1/admin/domains"] = () => apiError("UNAUTHENTICATED", 401);
    await expect(DomainsPage({ searchParams: searchParamsOf("") })).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });

  it("puts every lastCheckError code in words, and hands the table only the fields it shows", async () => {
    for (const [code, words] of Object.entries(DOMAIN_CHECK_ERRORS)) {
      expect(checkErrorText(code)).toBe(words);
    }
    // The six codes of the platform document (AdminDomain.lastCheckError, PADR-0004 item 2).
    expect(Object.keys(DOMAIN_CHECK_ERRORS).sort()).toEqual(
      [
        "a_wrong_address",
        "cname_missing",
        "cname_wrong_target",
        "dns_timeout",
        "txt_mismatch",
        "txt_missing",
      ].sort(),
    );
    expect(checkErrorText("ns_lame")).toBe(`${L.otherCheckError} ns_lame`);

    // An answer with a property the page does not show: it never reaches the browser.
    platform.overrides["GET /v1/admin/domains"] = () =>
      json(
        {
          data: [{ ...domain(), verificationToken: "pad014-dummy-verification-token" }],
          page: { nextCursor: "ZG9t", limit: 50 },
        },
        200,
      );
    const element = await DomainsPage({ searchParams: searchParamsOf("") });
    const [props] = propsOf(element, DomainTable);
    expect(props?.["page"]).toEqual({ nextCursor: "ZG9t" });
    const [row] = (props?.["domains"] ?? []) as Record<string, unknown>[];
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        "checkFailures",
        "createdAt",
        "hostname",
        "id",
        "isPrimary",
        "kind",
        "lastCheckError",
        "lastCheckedAt",
        "tenantId",
        "tenantKey",
        "tlsCheckedAt",
        "tlsExpiresAt",
        "tlsStatus",
        "verificationDeadlineAt",
        "verificationStatus",
        "verifiedAt",
      ].sort(),
    );
    expect(JSON.stringify(props)).not.toContain("pad014-dummy-verification-token");
  });
});

// ---- The office pool's release ------------------------------------------------------------------------------------------

describe("amadeus/offices: releasing an office", () => {
  it("[PAD-014 AC2] releases a releasing office only with the 'no open bookings' confirmation and a reason [PF-90]", async () => {
    expect(operationRequirements("adminReleaseAmadeusOffice")).toEqual({ reason: true, stepUp: false });
    const path = `/v1/admin/amadeus-offices/${RELEASING_ROW}/release`;
    const view = await openOffices();

    fireEvent.click(
      within(rowOf("MUC1A0100")).getByRole("button", { name: `${O.release}${O.officeSuffix("MUC1A0100")}` }),
    );
    const dialog = await screen.findByRole("dialog", { name: O.releaseTitle("MUC1A0100") }, UI_WAIT);
    expect(dialog.textContent).toContain(O.releaseDescriptionReleasing("nordic"));
    const confirmation = within(dialog).getByLabelText(
      O.confirmLabel("nordic", "MUC1A0100"),
    ) as HTMLInputElement;
    expect(confirmation.checked).toBe(false);

    // 1. Neither the confirmation nor a reason: refused at the box, nothing sent.
    submit(O.releaseConfirm, dialog);
    expect(within(dialog).getByText(O.confirmRequired)).toBeTruthy();
    expect(confirmation.getAttribute("aria-invalid")).toBe("true");
    // 2. A reason without the confirmation: still refused.
    fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), {
      target: { value: RELEASE_REASON },
    });
    submit(O.releaseConfirm, dialog);
    expect(within(dialog).getByText(O.confirmRequired)).toBeTruthy();
    // 3. The confirmation with a reason that is too short: refused at the reason.
    fireEvent.click(confirmation);
    expect(within(dialog).queryByText(O.confirmRequired)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: "  ok   " } });
    submit(O.releaseConfirm, dialog);
    expect(within(dialog).getByText(REASON_STRINGS.tooShort)).toBeTruthy();
    expect(calls("POST", path)).toHaveLength(0);

    // 4. Both: the release goes with `confirmNoOpenBookings: true` and the trimmed reason.
    fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), {
      target: { value: `  ${RELEASE_REASON} ` },
    });
    submit(O.releaseConfirm, dialog);
    expect((await notice("done")).textContent).toBe(O.released("MUC1A0100"));
    expect(await bodies("POST", path)).toEqual([{ confirmNoOpenBookings: true, reason: RELEASE_REASON }]);
    expectSessionHeaders(calls("POST", path)[0]);
    expect(revalidated()).toEqual(["/amadeus/offices", "/amadeus/accounts", "/", `/tenants/${NORDIC_ID}`]);

    // The revalidated pool shows the office available, with no OTA and nothing to release any more.
    await view.rerender();
    const row = rowOf("MUC1A0100");
    expect(statusesOf(row)).toEqual(["available"]);
    expect(within(row).queryByRole("link", { name: "nordic" })).toBeNull();
    expect(buttonsOf(row)).not.toContain(`${O.release}${O.officeSuffix("MUC1A0100")}`);
  });

  it("[PAD-014 AC2] words an office that backs an active connection or is no longer assigned, and the action checks the confirmation", async () => {
    await openOffices();
    // An assigned office says that only a connection that is not active gives it up.
    fireEvent.click(
      within(rowOf("NCE1A0955")).getByRole("button", { name: `${O.release}${O.officeSuffix("NCE1A0955")}` }),
    );
    const dialog = await screen.findByRole("dialog", { name: O.releaseTitle("NCE1A0955") }, UI_WAIT);
    expect(dialog.textContent).toContain(O.releaseDescriptionAssigned("acme"));
    fireEvent.click(within(dialog).getByLabelText(O.confirmLabel("acme", "NCE1A0955")));
    fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), {
      target: { value: "Acme asked to move to its own credentials." },
    });
    submit(O.releaseConfirm, dialog);
    const refused = await notice("failed");
    expect(refused.getAttribute("data-code")).toBe("CONFLICT");
    expect(refused.textContent).toBe(O.connectionActive);
    expect(statusesOf(rowOf("NCE1A0955"))).toEqual(["assigned"]);

    const release = (values: Record<string, string>) => releaseOffice({ status: "idle" }, formData(values));
    const base = {
      officeRowId: LIVE_ROW,
      tenantId: ACME_ID,
      confirmNoOpenBookings: "true",
      reason: RELEASE_REASON,
    };
    expect(await release(base)).toMatchObject({ status: "failed", code: "CONFLICT", message: O.notAssigned });
    expect(await release({ ...base, officeRowId: "amo_01JE0D4E5F6G7H8J9K0M1N2P3Q" })).toMatchObject({
      code: "NOT_FOUND",
      message: O.officeGone,
    });

    // Without the confirmation, with a reason out of bounds or made-up ids, nothing is sent.
    fetchMock.mockClear();
    for (const values of [
      { ...base, officeRowId: RELEASING_ROW, confirmNoOpenBookings: "" },
      { ...base, officeRowId: RELEASING_ROW, confirmNoOpenBookings: "false" },
      { ...base, officeRowId: RELEASING_ROW, reason: "  no " },
      { ...base, officeRowId: RELEASING_ROW, tenantId: "nordic" },
      { ...base, officeRowId: "MUC1A0100" },
    ]) {
      expect((await release(values)).status).toBe("failed");
    }
    expect(await release({ ...base, officeRowId: RELEASING_ROW, confirmNoOpenBookings: "on" })).toMatchObject(
      { code: "VALIDATION_FAILED", message: O.confirmRequired },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- The dashboard -----------------------------------------------------------------------------------------------------

describe("(app)/page.tsx: live office requests and the M5 counters", () => {
  it("[PAD-014 AC2] serves a live office request from the dashboard: the link opens the OTA, where an office is assigned [PF-90]", async () => {
    await openDashboard();
    // [FIX-W41-PLATFORM AC9] One call: the requests come with adminGetDashboard; no audit row and no OTA is read.
    expect(callKeys()).toEqual(["GET /v1/admin/dashboard"]);
    const section = screen.getByRole("region", { name: D.liveRequestsTitle });
    expect(
      within(section)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([D.liveRequestOta, D.liveRequestRequested, D.liveRequestAction]);
    // Only acme's live connection still waits for an office; nordic's was served.
    const rows = within(section).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    const [request] = rows;
    if (request === undefined) {
      throw new Error("no live request row");
    }
    expect(request.textContent).toContain("Acme Travel");
    expect(request.textContent).toContain("acme");
    expect(requestedAtOf(request)).toBe(ACME_REQUESTED_AT);
    expect(within(section).queryByText("Nordic Fares")).toBeNull();
    expect(section.querySelector('[data-notice="live-requests-oldest"]')).toBeNull();
    const assign = link(`${D.assignOffice}${D.assignOfficeFor("Acme Travel")}`, request);
    expect(hrefOf(assign)).toBe(`/tenants/${ACME_ID}?tab=connections#connection-${ACME_LIVE_CONNECTION}`);
    // The dashboard writes nothing.
    expect(fetchMock.mock.calls.every(([input]) => input.method === "GET")).toBe(true);
    cleanup();

    // The link's page: the live card asks for an office, offers the available live offices and says why it waits.
    const tenant = await openTenant(ACME_ID, "tab=connections");
    // The payout account panel of the tab loads itself (none here); awaited, so no call outlives the test.
    await screen.findByText(PAYOUT_ACCOUNT_STRINGS.none, {}, UI_WAIT);
    expect(queriesOf("/v1/admin/amadeus-offices")).toEqual([
      [
        ["environment", "live"],
        ["limit", "200"],
        ["status", "available"],
      ],
    ]);
    const card = screen.getByRole("region", { name: /Amadeus, Live/ });
    // The dashboard link's fragment names this card (its heading), so the browser scrolls to the waiting connection.
    const target = document.getElementById(`connection-${ACME_LIVE_CONNECTION}`);
    expect(target).not.toBeNull();
    expect(card.contains(target)).toBe(true);
    expect(within(card).getByText(ASSIGN_OFFICE_STRINGS.liveIntro)).toBeTruthy();
    expect(within(card).getByRole("option", { name: "LIV1A0001" })).toBeTruthy();
    submit(ASSIGN_OFFICE_STRINGS.assign, card);
    const done = await notice("done", card);
    expect(done.textContent).toContain(ASSIGN_OFFICE_STRINGS.assigned("LIV1A0001"));
    expect(within(done).getByText("Active").getAttribute("data-status")).toBe("active");
    expect(await bodies("POST", `/v1/admin/amadeus-offices/${LIVE_ROW}/assign`)).toEqual([
      { tenantId: ACME_ID },
    ]);

    await tenant.rerender();
    const served = screen.getByRole("region", { name: /Amadeus, Live/ });
    expect(within(served).getAllByText("LIV1A0001", { exact: false }).length).toBeGreaterThan(0);
    expect(within(served).queryByText(ASSIGN_OFFICE_STRINGS.liveIntro)).toBeNull();
    cleanup();

    // The served request leaves the dashboard.
    await openDashboard();
    const after = screen.getByRole("region", { name: D.liveRequestsTitle });
    expect(within(after).getByText(D.liveRequestsEmpty)).toBeTruthy();
    expect(within(after).queryByRole("table")).toBeNull();
  });

  it("[FIX-W41-PLATFORM AC9] shows the requests as adminGetDashboard answers them, oldest first, each with Assign office", async () => {
    // Nordic waits too now (its live connection after its request, no office yet), and requested before acme.
    platform.tenants.set(
      NORDIC_ID,
      tenantDetail(NORDIC_ID, "nordic", "Nordic Fares", [waitingLiveConnection(NORDIC_LIVE_CONNECTION)]),
    );
    await openDashboard();
    expect(callKeys()).toEqual(["GET /v1/admin/dashboard"]);
    const section = screen.getByRole("region", { name: D.liveRequestsTitle });
    expect(within(section).getByRole("table").querySelector("caption")?.textContent).toBe(
      D.liveRequestsCaption,
    );
    const rows = within(section).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("data-tenant-id"))).toEqual([NORDIC_ID, ACME_ID]);
    expect(rows.map(requestedAtOf)).toEqual([NORDIC_REQUESTED_AT, ACME_REQUESTED_AT]);
    expect(
      rows.map((row) =>
        hrefOf(
          within(row).getByRole("link", { name: new RegExp(`^${D.assignOffice}`) }) as HTMLAnchorElement,
        ),
      ),
    ).toEqual([
      `/tenants/${NORDIC_ID}?tab=connections#connection-${NORDIC_LIVE_CONNECTION}`,
      `/tenants/${ACME_ID}?tab=connections#connection-${ACME_LIVE_CONNECTION}`,
    ]);
    cleanup();

    // The page keeps the API's order as it is: it sorts and filters nothing itself.
    platform.liveOfficeRequests = [
      liveOfficeRequest(ACME_ID, "acme", "Acme Travel", ACME_LIVE_CONNECTION, ACME_REQUESTED_AT),
      liveOfficeRequest(NORDIC_ID, "nordic", "Nordic Fares", NORDIC_LIVE_CONNECTION, NORDIC_REQUESTED_AT),
    ];
    await openDashboard();
    expect(
      within(screen.getByRole("region", { name: D.liveRequestsTitle }))
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.getAttribute("data-tenant-id")),
    ).toEqual([ACME_ID, NORDIC_ID]);
  });

  it("[FIX-W41-PLATFORM AC9] says when the oldest requests are shown, and replaces the audit notices", async () => {
    // As many requests as the API answers at most: the section says the oldest ones are shown.
    const requests = Array.from({ length: LIVE_OFFICE_REQUESTS_LIMIT }, (_, index) =>
      liveOfficeRequest(
        `ten_01JF0000000000000000000${String(index).padStart(3, "0")}`,
        `ota${index}x`,
        `OTA ${index}`,
        `sc_01JF0000000000000000000${String(index).padStart(3, "0")}`,
        new Date(Date.UTC(2027, 0, 1, 9, index)).toISOString(),
      ),
    );
    platform.liveOfficeRequests = requests;
    await openDashboard();
    expect(callKeys()).toEqual(["GET /v1/admin/dashboard"]);
    const full = screen.getByRole("region", { name: D.liveRequestsTitle });
    expect(within(full).getAllByRole("row").slice(1)).toHaveLength(LIVE_OFFICE_REQUESTS_LIMIT);
    const oldest = full.querySelector('[data-notice="live-requests-oldest"]');
    expect(oldest?.textContent).toBe(D.liveRequestsOldest(LIVE_OFFICE_REQUESTS_LIMIT));
    expect(D.liveRequestsOldest(LIVE_OFFICE_REQUESTS_LIMIT)).toBe(
      "The 50 oldest requests are shown. Assign their offices to see the next ones.",
    );
    // Neither the "only the most recent were checked" notice nor the audit link of before.
    expect(full.querySelector('[data-notice="live-requests-truncated"]')).toBeNull();
    expect(within(full).queryByRole("link", { name: /audit/i })).toBeNull();
    cleanup();

    // One fewer: every waiting request is shown, nothing to say.
    platform.liveOfficeRequests = requests.slice(1);
    await openDashboard();
    const some = screen.getByRole("region", { name: D.liveRequestsTitle });
    expect(within(some).getAllByRole("row").slice(1)).toHaveLength(LIVE_OFFICE_REQUESTS_LIMIT - 1);
    expect(some.querySelector('[data-notice="live-requests-oldest"]')).toBeNull();
  });

  it("[FIX-W41-PLATFORM AC9] leaves the section out without a live account and a request, and signs in again once the session ended", async () => {
    // Without a Velexis live account no OTA can have requested live access: nothing shown.
    platform.dashboard = dashboard({ officePool: [{ environment: "test", available: 4, assigned: 1 }] });
    platform.liveOfficeRequests = [];
    await openDashboard();
    expect(screen.queryByRole("region", { name: D.liveRequestsTitle })).toBeNull();
    expect(screen.getByRole("region", { name: D.tenantsTitle })).toBeTruthy();
    cleanup();

    // A request the API still answers is shown all the same.
    platform.liveOfficeRequests = [
      liveOfficeRequest(ACME_ID, "acme", "Acme Travel", ACME_LIVE_CONNECTION, ACME_REQUESTED_AT),
    ];
    await openDashboard();
    const section = screen.getByRole("region", { name: D.liveRequestsTitle });
    expect(within(section).getAllByRole("row").slice(1)).toHaveLength(1);
    cleanup();

    // With a live account and no request: the section says that none waits.
    platform = freshPlatform();
    platform.liveOfficeRequests = [];
    await openDashboard();
    const none = screen.getByRole("region", { name: D.liveRequestsTitle });
    expect(within(none).getByText(D.liveRequestsEmpty)).toBeTruthy();
    expect(within(none).queryByRole("table")).toBeNull();
    cleanup();

    // An ended session signs in again.
    platform.overrides["GET /v1/admin/dashboard"] = () => apiError("TOKEN_EXPIRED", 401);
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });

  it("links each M5 counter to its filtered list while its switch is on, and leaves out the ones switched off", async () => {
    await openDashboard();
    const review = screen.getByRole("region", { name: D.m5Title });
    expect(
      within(review)
        .getAllByRole("link")
        .map((element) => [element.textContent, hrefOf(element as HTMLAnchorElement)]),
    ).toEqual([
      [`3 ${D.domainsPending(3)}`, "/domains?kind=custom&verificationStatus=pending"],
      [`9 ${D.settlementsToReview(9)}`, "/settlements?status=draft"],
      [`1 ${D.stripeEventsFailed(1)}`, "/stripe-events?status=failed"],
      [`2 ${D.subscriptionsPastDue(2)}`, "/subscriptions?status=past_due"],
    ]);
    expect(D.domainsPending(1)).toBe("custom domain waits for its DNS records");
    cleanup();

    platform.dashboard = dashboard({
      settlementsToReview: null,
      subscriptionsPastDue: null,
      stripeEventsFailed: 0,
    });
    await openDashboard();
    const some = screen.getByRole("region", { name: D.m5Title });
    expect(
      within(some)
        .getAllByRole("link")
        .map((element) => hrefOf(element as HTMLAnchorElement)),
    ).toEqual(["/domains?kind=custom&verificationStatus=pending", "/stripe-events?status=failed"]);
    cleanup();

    // Every switch off (M1): no section at all.
    platform.dashboard = dashboard({
      domainsPending: null,
      settlementsToReview: null,
      stripeEventsFailed: null,
      subscriptionsPastDue: null,
    });
    await openDashboard();
    expect(screen.queryByRole("region", { name: D.m5Title })).toBeNull();
  });
});
