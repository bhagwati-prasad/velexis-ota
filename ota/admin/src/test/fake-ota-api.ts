// Test support for the OTA admin's lib tests (OADR-0018 point 10): a fake `fetch` that the real SDK calls, so tests
// check the exact requests (method, path, headers, body) without a running backend, plus builders of the console's
// staff session and profile, a cookie jar like Next.js's `cookies()` and the error `redirect()` throws.
// Test code only: nothing in src/app imports it. Every token here is a dummy value.
import type { ConsoleStaffProfile, ConsoleStaffSession, StaffPermission, StaffRole } from "@velexis/ota-sdk";
import { vi } from "vitest";

/** The service key of the mocked configuration (a dummy). */
export const TEST_SERVICE_KEY = "sk_test_ota_admin_service_key_dummy";
/** The OTA API of the mocked configuration. */
export const TEST_OTA_API_URL = "http://127.0.0.1:4000";
/** The portal of the mocked configuration. */
export const TEST_PORTAL_URL = "http://localhost:3000";

/** The configuration that tests give `@/config`'s `getConfig()`. */
export const TEST_CONFIG = Object.freeze({
  APP_ENV: "test" as const,
  LOG_LEVEL: "error" as const,
  PORT: 3002,
  PUBLIC_OTA_ADMIN_URL: "http://localhost:3002",
  PUBLIC_PORTAL_URL: TEST_PORTAL_URL,
  OTA_API_URL: TEST_OTA_API_URL,
  OTA_ADMIN_SERVICE_KEY: TEST_SERVICE_KEY,
  SENTRY_DSN: undefined,
});

export const TENANT_ID = "ten_01JA3B4C5D6E7F8G9H0J1K2M3N";
export const STAFF_ID = "stf_01JBT6V2B3K8Q4M9N5P7R1T0VX";

/** A JWT with `payload`; the signature is a dummy (the admin never checks it, the API does). */
export function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA", typ: "JWT", kid: "k1" })}.${encode(payload)}.c2lnbmF0dXJl`;
}

/** A staff access token expiring `seconds` after `now` (epoch ms). */
export function staffAccessToken(name: string, now: number, seconds: number): string {
  return jwt({
    typ: "staff",
    sub: STAFF_ID,
    tid: TENANT_ID,
    roles: ["agent"],
    sid: "asn_01JBT6V2B3K8Q4M9N5P7R1T0VY",
    jti: name,
    exp: Math.floor(now / 1000) + seconds,
  });
}

/** The permissions of each role (scope §1.3), as the API answers them. */
const PERMISSIONS: Record<StaffRole, StaffPermission[]> = {
  owner: [
    "bookings:read",
    "bookings:write",
    "bookings:issue",
    "bookings:cancel",
    "customers:read",
    "queues:read",
    "supplier_requests:read",
    "amadeus:read",
    "amadeus:write",
    "settings:read",
    "settings:write",
    "payments:read",
    "payments:capture",
    "payments:refund",
  ],
  admin: [],
  agent: [
    "bookings:read",
    "bookings:write",
    "bookings:issue",
    "bookings:cancel",
    "customers:read",
    "queues:read",
    "supplier_requests:read",
    "amadeus:read",
    "settings:read",
    "payments:read",
    "payments:capture",
  ],
  finance: [
    "bookings:read",
    "customers:read",
    "supplier_requests:read",
    "settings:read",
    "payments:read",
    "payments:capture",
    "payments:refund",
  ],
  viewer: ["bookings:read", "customers:read", "settings:read", "payments:read"],
};
PERMISSIONS.admin = PERMISSIONS.owner;

/** What a profile or a session of the builders is made of. */
export interface StaffShape {
  readonly role?: StaffRole;
  readonly environments?: ("test" | "live")[];
}

function staffMember(role: StaffRole): ConsoleStaffProfile["staff"] {
  return {
    id: STAFF_ID,
    accountId: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    email: "kari.nordmann@example.com",
    fullName: "Kari Nordmann",
    role,
    status: "active",
    locale: "en",
    timeZone: "Europe/Oslo",
    mfaEnabled: true,
    lastActiveAt: null,
    createdAt: "2026-10-01T10:02:17Z",
  };
}

function consoleTenant(): ConsoleStaffProfile["tenant"] {
  return {
    id: TENANT_ID,
    key: "demo",
    name: "Demo Travel",
    status: "active",
    environment: "test",
    defaultCurrency: "EUR",
    defaultLocale: "en",
    timeZone: "Europe/Oslo",
    storefrontUrl: "https://demo.ota.example.com",
    supplier: {
      connected: true,
      officeIds: ["OSLN12345"],
      defaultOfficeId: "OSLN12345",
      queuingOfficeId: null,
    },
  };
}

/** `console.auth.me` of a staff member. */
export function staffProfile(shape: StaffShape = {}): ConsoleStaffProfile {
  const role = shape.role ?? "agent";
  return {
    staff: staffMember(role),
    tenant: consoleTenant(),
    permissions: [...PERMISSIONS[role]],
    session: {
      id: "asn_01JBT6V2B3K8Q4M9N5P7R1T0VY",
      createdAt: "2026-10-21T08:00:00Z",
      expiresAt: "2026-10-21T20:00:00Z",
    },
    environments: shape.environments ?? ["test", "live"],
  };
}

/** A `ConsoleStaffSession` with new tokens, as `console.auth.signIn` and `.refresh` answer it. */
export function staffSession(
  now: number,
  shape: StaffShape & { readonly accessToken?: string; readonly refreshToken?: string } = {},
): ConsoleStaffSession {
  const role = shape.role ?? "agent";
  return {
    session: {
      accessToken: shape.accessToken ?? staffAccessToken("rotated", now, 900),
      accessTokenExpiresAt: new Date(now + 900_000).toISOString(),
      refreshToken: shape.refreshToken ?? "staff-refresh-token-rotated",
      refreshTokenExpiresAt: new Date(now + 11 * 3600_000).toISOString(),
      tokenType: "Bearer",
      subject: { type: "staff", id: STAFF_ID, roles: [role] },
    },
    staff: staffMember(role),
    tenant: consoleTenant(),
    permissions: [...PERMISSIONS[role]],
    environments: shape.environments ?? ["test", "live"],
  };
}

/** One request the fake API received. */
export interface SentRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
}

/** A handler of the fake API: the answer to one request. */
export type FakeHandler = (request: SentRequest) => Response | Promise<Response>;

/** The API's error envelope as a response, with `extra` fields in the envelope and extra response headers. */
export function apiError(
  code: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    {
      error: {
        code,
        status,
        message: `The API refused the request (${code}).`,
        requestId: "req_fake_1",
        ...extra,
      },
    },
    { status, headers: { "X-Request-Id": "req_fake_1", ...headers } },
  );
}

/**
 * `429 RATE_LIMITED` with `Retry-After: 60`: the SDK ends the call at once instead of waiting (a wait above 30 s),
 * so a test sees a failure that may pass without the SDK's back-off.
 */
export function rateLimited(): Response {
  return apiError("RATE_LIMITED", 429, { details: { retryAfterSeconds: 60 } }, { "Retry-After": "60" });
}

/** A fake OTA API: `fetch` for the SDK, the requests it received, and handlers by `"<METHOD> <path>"`. */
export interface FakeOtaApi {
  readonly fetch: typeof fetch & ReturnType<typeof vi.fn>;
  readonly requests: SentRequest[];
  /** Sets the handler of `"<METHOD> <path>"` (path without the query). */
  on(route: string, handler: FakeHandler): void;
  /** The requests of one route. */
  sent(route: string): SentRequest[];
}

/**
 * A fake OTA API with `GET /v1/console/auth/me` answering `profile`, `POST /v1/console/auth/refresh` answering
 * `session`, and `404 NOT_FOUND` for every other route until `on()` sets it.
 */
export function fakeOtaApi(
  defaults: { readonly profile?: ConsoleStaffProfile; readonly session?: ConsoleStaffSession } = {},
): FakeOtaApi {
  const requests: SentRequest[] = [];
  const handlers = new Map<string, FakeHandler>();
  handlers.set("GET /v1/console/auth/me", () =>
    Response.json(defaults.profile ?? staffProfile(), { headers: { "X-Request-Id": "req_me" } }),
  );
  handlers.set("POST /v1/console/auth/refresh", () =>
    Response.json(defaults.session ?? staffSession(Date.now()), {
      headers: { "X-Request-Id": "req_refresh" },
    }),
  );
  const routeOf = (request: SentRequest) => `${request.method} ${request.url.pathname}`;
  const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const text = typeof init?.body === "string" ? init.body : undefined;
    const request: SentRequest = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: text === undefined ? undefined : (JSON.parse(text) as unknown),
    };
    requests.push(request);
    const handler = handlers.get(routeOf(request));
    return handler === undefined ? apiError("NOT_FOUND", 404) : handler(request);
  });
  return {
    fetch: fakeFetch as unknown as FakeOtaApi["fetch"],
    requests,
    on(route, handler) {
      handlers.set(route, handler);
    },
    sent(route) {
      return requests.filter((request) => routeOf(request) === route);
    },
  };
}

/** A promise and the function that resolves it, so fake answers can overlap like parallel requests. */
export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** One cookie the jar holds, with the attributes it was set with. */
export interface JarEntry {
  readonly value: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/** Next.js's `cookies()` in a test: reads the request's cookies and records what the code sets. */
export class CookieJar {
  readonly entries = new Map<string, JarEntry>();
  readonly writes: {
    readonly name: string;
    readonly value: string;
    readonly options: Record<string, unknown>;
  }[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      this.entries.set(name, { value, options: {} });
    }
  }

  get(name: string): { name: string; value: string } | undefined {
    const entry = this.entries.get(name);
    return entry === undefined ? undefined : { name, value: entry.value };
  }

  set(name: string, value: string, options: Record<string, unknown> = {}): this {
    this.writes.push({ name, value, options });
    this.entries.set(name, { value, options });
    return this;
  }
}

/** What the mocked `redirect()` of next/navigation throws. */
export class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

/** The mocked `redirect()`: throws, as Next.js's does. */
export function fakeRedirect(url: string): never {
  throw new RedirectSignal(url);
}

/** The URL a call redirected to, or a failure when it did not redirect. */
export async function redirectOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof RedirectSignal) {
      return error.url;
    }
    throw error;
  }
  throw new Error("expected a redirect");
}
