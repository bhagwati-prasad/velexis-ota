import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "@velexis/logger";
import { AuthenticationError } from "@velexis/ota-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  TEST_PORTAL_URL,
  apiError,
  fakeOtaApi,
  fakeRedirect,
  redirectOf,
  staffAccessToken,
  staffProfile,
  staffSession,
  type FakeOtaApi,
} from "@/test/fake-ota-api";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", () => ({ redirect: vi.fn(fakeRedirect) }));

import { createRefreshDedup } from "./refresh-dedup";
import {
  ENVIRONMENT_COOKIE,
  PAGE_PATH_HEADER,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
  requireStaff,
} from "./session";
import {
  END_USER_AGENT_HEADER,
  END_USER_IP_HEADER,
  MAX_USER_AGENT_LENGTH,
  RESPONSE_LOG_MESSAGE,
  createConsoleClient,
  endUserAgent,
  endUserHeaders,
  endUserIp,
  getConsole,
  getConsoleRequest,
  getStaff,
  refreshStaffSession,
} from "./velexis";

const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const SRC_DIR = join(APP_DIR, "src");
const BOOKING_ID = "bkg_01JBT7A1B2C3D4E5F6G7H8J9K0";

/** The browser's request as Caddy forwards it: the browser sent the left-most entry, Caddy appended the real one. */
const STAFF_IP = "203.0.113.7";
const FORGED_IP = "6.6.6.6";
const BROWSER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";

let tokenSequence = 0;
/** A refresh token no other test uses: the process-wide de-duplication map outlives each test. */
function uniqueRefreshToken(): string {
  tokenSequence += 1;
  return `staff-refresh-token-velexis-test-${tokenSequence}-${Date.now()}`;
}

describe("end-user headers", () => {
  it("[OAD-002 AC2] takes the right-most X-Forwarded-For entry and never a browser-supplied left-most one", () => {
    expect(endUserIp(new Headers({ "X-Forwarded-For": `${FORGED_IP}, ${STAFF_IP}` }))).toBe(STAFF_IP);
    expect(
      endUserIp(
        new Headers([
          ["X-Forwarded-For", `${FORGED_IP}, 10.0.0.9`],
          ["X-Forwarded-For", "2001:db8::7"],
        ]),
      ),
    ).toBe("2001:db8::7");
    expect(endUserIp(new Headers({ "X-Forwarded-For": ` ${STAFF_IP} ` }))).toBe(STAFF_IP);
  });

  it("[OAD-002 AC2] uses 127.0.0.1 without X-Forwarded-For (local development without Caddy)", () => {
    expect(endUserIp(new Headers())).toBe("127.0.0.1");
    expect(endUserIp(new Headers({ "X-Forwarded-For": " , " }))).toBe("127.0.0.1");
  });

  it("[OAD-002 AC2] forwards the browser's User-Agent cut to 512 characters, without control characters", () => {
    const long = `Mozilla/5.0 ${"x".repeat(600)}`;

    expect(MAX_USER_AGENT_LENGTH).toBe(512);
    expect(endUserAgent(new Headers({ "User-Agent": long }))).toBe(long.slice(0, 512));
    expect(endUserAgent(new Headers({ "User-Agent": "Agenté/1.0" }))).toBe("Agent/1.0");
    expect(endUserAgent(new Headers())).toBe("");
    expect(endUserHeaders(new Headers({ "X-Forwarded-For": STAFF_IP, "User-Agent": "A/1" }))).toEqual({
      [END_USER_IP_HEADER]: STAFF_IP,
      [END_USER_AGENT_HEADER]: "A/1",
    });
  });
});

describe("SDK clients", () => {
  let api: FakeOtaApi;

  beforeEach(() => {
    api = fakeOtaApi();
    api.on("GET /v1/console/bookings", () =>
      Response.json({ data: [], page: { nextCursor: null, limit: 5 } }),
    );
    api.on(`POST /v1/console/bookings/${BOOKING_ID}/notes`, () =>
      Response.json({ id: "bnt_01JBT7A1B2C3D4E5F6G7H8J9K1" }, { status: 201 }),
    );
    vi.stubGlobal("fetch", api.fetch);
    nextHeaders.headers.mockResolvedValue(
      new Headers({ "X-Forwarded-For": `${FORGED_IP}, 10.0.0.9, ${STAFF_IP}`, "User-Agent": BROWSER_AGENT }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Cookies of a staff session whose access token expires in `seconds`. */
  function signedIn(seconds: number): CookieJar {
    const refreshToken = uniqueRefreshToken();
    const jar = new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(refreshToken, Date.now(), seconds),
      [STAFF_REFRESH_TOKEN_COOKIE]: refreshToken,
      [ENVIRONMENT_COOKIE]: "live",
      [TENANT_COOKIE]: TENANT_ID,
    });
    nextHeaders.cookies.mockResolvedValue(jar);
    return jar;
  }

  it("[OAD-002 AC2] every SDK request carries the staff member's X-Velexis-End-User-IP and -Agent", async () => {
    // Server components: getConsole() and getStaff().
    signedIn(900);
    const client = await getConsole();
    await getStaff();
    await client.bookings.list({ limit: 5 });
    await client.bookings.addNote({
      bookingId: BOOKING_ID,
      text: "Called the customer",
      visibleToCustomer: false,
    });
    await client.bookings.get({ bookingId: BOOKING_ID }).catch(() => undefined);
    // A server action whose token expires within 60 s: the refresh and console.auth.me of requireStaff().
    signedIn(30);
    await requireStaff("bookings:write");
    // The middleware's and route handlers' refresh.
    await refreshStaffSession(uniqueRefreshToken(), await nextHeaders.headers(), {
      dedup: createRefreshDedup(),
    });

    expect(api.requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      // getConsole() and getStaff() each start with console.auth.me (`getConsoleRequest` decides the environment
      // of the request, OAD-004); React's `cache` makes it one call per server request, which a test has not.
      "GET /v1/console/auth/me",
      "GET /v1/console/auth/me",
      "GET /v1/console/bookings",
      `POST /v1/console/bookings/${BOOKING_ID}/notes`,
      `GET /v1/console/bookings/${BOOKING_ID}`,
      "POST /v1/console/auth/refresh",
      "GET /v1/console/auth/me",
      "POST /v1/console/auth/refresh",
    ]);
    for (const request of api.requests) {
      const what = `${request.method} ${request.url.pathname}`;
      expect(request.headers.get(END_USER_IP_HEADER), what).toBe(STAFF_IP);
      expect(request.headers.get(END_USER_AGENT_HEADER), what).toBe(BROWSER_AGENT);
      expect([...request.headers.values()].join("\n"), what).not.toContain(FORGED_IP);
    }
  });

  it("[OAD-002 AC2] sends 127.0.0.1 and the agent when the request did not come through Caddy", async () => {
    signedIn(900);
    nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": BROWSER_AGENT }));

    await getStaff();

    expect(api.requests[0]?.headers.get(END_USER_IP_HEADER)).toBe("127.0.0.1");
    expect(api.requests[0]?.headers.get(END_USER_AGENT_HEADER)).toBe(BROWSER_AGENT);
  });

  it("builds a server-mode staff client: service key, staff token, environment, no refresh of its own", async () => {
    const accessToken = staffAccessToken("a", Date.now(), 900);
    api.on("GET /v1/console/auth/me", () => apiError("TOKEN_EXPIRED", 401));
    const client = createConsoleClient(
      { accessToken, environment: "live", incoming: new Headers() },
      { fetch: api.fetch },
    );

    const error = await client.auth.me().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({ code: "TOKEN_EXPIRED" });
    // Server components never refresh: one request, no POST /v1/console/auth/refresh.
    expect(api.requests).toHaveLength(1);
    const [request] = api.requests;
    expect(request?.url.toString()).toBe(`${TEST_CONFIG.OTA_API_URL}/v1/console/auth/me`);
    expect(request?.headers.get("X-Api-Key")).toBe(TEST_CONFIG.OTA_ADMIN_SERVICE_KEY);
    expect(request?.headers.get("Authorization")).toBe(`Bearer ${accessToken}`);
    expect(request?.headers.get("X-Velexis-Environment")).toBe("live");
  });

  it("logs one line per response with method, path, status, request id and duration, never a body or a token", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      app: "ota-admin",
      env: "test",
      level: "info",
      destination: { write: (line: string) => void lines.push(line) },
    });
    const accessToken = staffAccessToken("logged", Date.now(), 900);
    api.on("GET /v1/console/bookings", () =>
      apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }),
    );
    const client = createConsoleClient(
      { accessToken, environment: "test", incoming: new Headers() },
      { fetch: api.fetch, logger },
    );

    await client.auth.me();
    await client.bookings.list({ limit: 5, q: "kari.nordmann@example.com" }).catch(() => undefined);

    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      level: 30,
      msg: RESPONSE_LOG_MESSAGE,
      method: "GET",
      path: "/v1/console/auth/me",
      status: 200,
      requestId: "req_me",
    });
    expect(typeof entries[0]?.["durationMs"]).toBe("number");
    expect(entries[1]).toMatchObject({ level: 40, path: "/v1/console/bookings", status: 503 });
    const logged = lines.join("\n");
    for (const secret of [
      accessToken,
      TEST_CONFIG.OTA_ADMIN_SERVICE_KEY,
      "kari.nordmann@example.com",
      "Kari Nordmann",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("redirects a server component with a refresh token only to /auth/refresh, and without a session to the portal", async () => {
    const jar = signedIn(900);
    jar.entries.delete(STAFF_ACCESS_TOKEN_COOKIE);
    expect(await redirectOf(() => getConsole())).toBe("/auth/refresh");

    nextHeaders.cookies.mockResolvedValue(new CookieJar({ [TENANT_COOKIE]: TENANT_ID }));
    expect(await redirectOf(() => getConsole())).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);
    expect(api.requests).toEqual([]);
  });

  it("[FIX-W33-OTA] [OAD-002] sends a server component to /auth/refresh with the page's path as ?next=, a same-origin path only", async () => {
    const page = "/bookings?status=confirmed&q=VX7K2Q";
    const withPage = (value: string) =>
      nextHeaders.headers.mockResolvedValue(
        new Headers({ "X-Forwarded-For": STAFF_IP, "User-Agent": BROWSER_AGENT, [PAGE_PATH_HEADER]: value }),
      );
    const back = `/auth/refresh?${new URLSearchParams({ next: page }).toString()}`;

    // A refresh token only (the middleware could not refresh).
    withPage(page);
    const jar = signedIn(900);
    jar.entries.delete(STAFF_ACCESS_TOKEN_COOKIE);
    expect(await redirectOf(() => getConsole())).toBe(back);
    // An access token the API refuses as expired.
    signedIn(900);
    api.on("GET /v1/console/auth/me", () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => getStaff())).toBe(back);
    // Anything but a path on the admin is dropped, as /auth/refresh drops it.
    for (const unsafe of [
      "https://evil.example/",
      "//evil.example/bookings",
      "/\\evil.example",
      "/a/..//evil.example",
    ]) {
      withPage(unsafe);
      expect(await redirectOf(() => getStaff()), unsafe).toBe("/auth/refresh");
    }
  });

  it("getStaff() is console.auth.me, and sends an expired or ended session away", async () => {
    signedIn(900);
    expect(await getStaff()).toEqual(staffProfile());

    api.on("GET /v1/console/auth/me", () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => getStaff())).toBe("/auth/refresh");

    api.on("GET /v1/console/auth/me", () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));
    expect(await redirectOf(() => getStaff())).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);

    api.on("GET /v1/console/auth/me", () => apiError("TENANT_SUSPENDED", 403));
    await expect(getStaff()).rejects.toMatchObject({ code: "TENANT_SUSPENDED" });
  });

  it("[OAD-004] works in the environment of the cookie when the session allows it", async () => {
    signedIn(900);

    const request = await getConsoleRequest();
    await request.console.bookings.list({ limit: 5 });

    expect(request).toMatchObject({ environment: "live", liveRefused: false, staff: staffProfile() });
    expect(api.requests.map((sent) => sent.headers.get("X-Velexis-Environment"))).toEqual(["live", "live"]);
  });

  it("[OAD-004] falls back to test when the API refuses the live cookie (ENVIRONMENT_NOT_ALLOWED)", async () => {
    signedIn(900);
    const viewer = staffProfile({ role: "viewer", environments: ["test"] });
    api.on("GET /v1/console/auth/me", (request) =>
      request.headers.get("X-Velexis-Environment") === "live"
        ? apiError("ENVIRONMENT_NOT_ALLOWED", 403, {
            details: { environment: "live", environments: ["test"] },
          })
        : Response.json(viewer),
    );

    const request = await getConsoleRequest();
    await request.console.bookings.list({ limit: 5 });

    expect(request).toMatchObject({ environment: "test", liveRefused: true, staff: viewer });
    expect(
      api.requests.map((sent) => [sent.url.pathname, sent.headers.get("X-Velexis-Environment")]),
    ).toEqual([
      ["/v1/console/auth/me", "live"],
      ["/v1/console/auth/me", "test"],
      ["/v1/console/bookings", "test"],
    ]);
    // getConsole() and getStaff() are the same request's.
    expect(await getStaff()).toEqual(viewer);
    await (await getConsole()).bookings.list({ limit: 5 });
    expect(api.requests.at(-1)?.headers.get("X-Velexis-Environment")).toBe("test");
  });

  it("[OAD-004] falls back to test when the profile no longer allows live", async () => {
    signedIn(900);
    api.on("GET /v1/console/auth/me", () => Response.json(staffProfile({ environments: ["test"] })));

    const request = await getConsoleRequest();

    expect(request).toMatchObject({ environment: "test", liveRefused: true });
    expect(api.requests.map((sent) => sent.headers.get("X-Velexis-Environment"))).toEqual(["live", "test"]);
  });

  it("[OAD-004] asks once in a test session, and keeps the session rules for the other refusals", async () => {
    const jar = signedIn(900);
    jar.set(ENVIRONMENT_COOKIE, "test");
    expect(await getConsoleRequest()).toMatchObject({ environment: "test", liveRefused: false });
    expect(api.requests).toHaveLength(1);

    // A test session is never refused for its environment: the refusal is thrown like any other.
    api.on("GET /v1/console/auth/me", () => apiError("ENVIRONMENT_NOT_ALLOWED", 403));
    await expect(getConsoleRequest()).rejects.toMatchObject({ code: "ENVIRONMENT_NOT_ALLOWED" });

    // After the fallback, an expired token still goes to /auth/refresh, a suspended OTA still throws.
    jar.set(ENVIRONMENT_COOKIE, "live");
    let call = 0;
    api.on("GET /v1/console/auth/me", () => {
      call += 1;
      return call === 1 ? apiError("ENVIRONMENT_NOT_ALLOWED", 403) : apiError("TOKEN_EXPIRED", 401);
    });
    expect(await redirectOf(() => getConsoleRequest())).toBe("/auth/refresh");
    api.on("GET /v1/console/auth/me", () => apiError("TENANT_SUSPENDED", 403));
    await expect(getConsoleRequest()).rejects.toMatchObject({ code: "TENANT_SUSPENDED" });
  });

  it("refreshes with the dedicated session result, never with an access token", async () => {
    const rotated = staffSession(Date.now(), { refreshToken: "staff-refresh-token-after" });
    api.on("POST /v1/console/auth/refresh", () => Response.json(rotated));

    const outcome = await refreshStaffSession(uniqueRefreshToken(), new Headers(), {
      dedup: createRefreshDedup(),
    });

    expect(outcome).toEqual({ ok: true, session: rotated });
    expect(api.requests[0]?.headers.has("Authorization")).toBe(false);
  });
});

/** The output and exit code of `next build` for a fixture app. */
interface BuildResult {
  readonly code: number | null;
  readonly output: string;
}

/** Runs `next build <dir>` with the app's own Next.js and collects stdout and stderr. */
function nextBuild(dir: string): Promise<BuildResult> {
  const nextBin = createRequire(join(APP_DIR, "package.json")).resolve("next/dist/bin/next");
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [nextBin, "build", dir], {
      cwd: dir,
      // A clean environment: the fixture needs no configuration, and telemetry stays off.
      env: { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", rejectBuild);
    child.on("close", (code) => resolveBuild({ code, output }));
  });
}

/** Writes `files` under `dir`. */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

describe("client components and lib/velexis.ts", () => {
  let fixture: string;
  let build: BuildResult;

  beforeAll(async () => {
    // A two-page Next.js app whose client component imports lib/velexis.ts, built with the app's Next.js inside the
    // app's git-ignored .next/cache (so `react` and `next` resolve from ota/admin/node_modules). Budget: one
    // `next build` that stops at the compile step, about 6 s alone and well under 2 minutes on a busy CI runner.
    const cacheDir = join(APP_DIR, ".next", "cache");
    mkdirSync(cacheDir, { recursive: true });
    fixture = mkdtempSync(join(cacheDir, "oad-002-server-only-"));
    writeFiles(fixture, {
      "next.config.mjs": [
        "// Fixture of src/lib/velexis.test.ts: `@/` is the OTA admin's src/, as in its tsconfig.json.",
        "export default {",
        "  typescript: { ignoreBuildErrors: true },",
        "  eslint: { ignoreDuringBuilds: true },",
        "  webpack(config) {",
        `    config.resolve.alias = { ...config.resolve.alias, "@": ${JSON.stringify(SRC_DIR)} };`,
        "    return config;",
        "  },",
        "};",
        "",
      ].join("\n"),
      "app/layout.tsx":
        "export default function Layout({ children }: { children: React.ReactNode }) {\n" +
        '  return <html lang="en"><body>{children}</body></html>;\n}\n',
      "app/page.tsx":
        'import { StaffBadge } from "./staff-badge";\n\n' +
        "export default function Page() {\n  return <StaffBadge />;\n}\n",
      "app/staff-badge.tsx":
        '"use client";\n\nimport { getStaff } from "@/lib/velexis";\n\n' +
        "export function StaffBadge() {\n" +
        "  return <button onClick={() => void getStaff()}>Who am I?</button>;\n}\n",
    });
    build = await nextBuild(fixture);
  }, 120_000);

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it("[OAD-002 AC3] a client component that imports lib/velexis.ts fails the build with the server-only error", () => {
    // eslint-disable-next-line no-control-regex -- the terminal colour codes of the build output
    const output = build.output.replace(/\u001b\[[0-9;]*m/g, "");

    expect(build.code).not.toBe(0);
    expect(output).toContain('You\'re importing a component that needs "server-only"');
    expect(output).toContain(join(SRC_DIR, "lib", "velexis.ts"));
    expect(output).toMatch(/Import trace for requested module:[\s\S]*staff-badge\.tsx/);
  });
});
