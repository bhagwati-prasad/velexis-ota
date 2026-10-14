// The platform API calls and the cookies of support/fixtures.ts, and the builders of support/seed.ts, without a
// stack: `fetch` is a fake platform API and the Mailpit client a fake whose `waitForMessage` the tests answer. The
// fixtures run against the real API for the first time in PFE-015 and PAD-010, once the operations exist; these
// tests pin what they send meanwhile (PADR-0019 headers, the request bodies) and that a refusal never leaks a body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MailpitModule from "@velexis/testing/mailpit";
import type { MailpitMessage } from "@velexis/testing/mailpit";
import {
  addSessionCookies,
  createVerifiedAccount,
  PlatformApiError,
  signInWithApi,
  uniqueTestIp,
  type PortalAccount,
} from "../support/fixtures";
import { buildAccount, newPassword } from "../support/seed";
import { exampleEnv, PLATFORM_API_URL } from "../support/stack";
import { Authenticator, totpCode } from "../support/totp";

const { waitForMessage } = vi.hoisted(() => ({ waitForMessage: vi.fn() }));

vi.mock("@velexis/testing/mailpit", async (importOriginal) => {
  const actual = await importOriginal<typeof MailpitModule>();
  return {
    ...actual,
    mailpitApiUrl: () => "http://127.0.0.1:8025",
    createMailpitClient: () => ({ waitForMessage }),
  };
});

/** 198.18.0.0/15 with a host part of 1 to 254. */
const TEST_IP = /^198\.(18|19)\.(\d{1,3})\.(\d{1,3})$/;

interface ApiRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Replaces `fetch` with a fake platform API: `answer` gets each request and returns status and JSON body. */
function fakePlatformApi(answer: (request: ApiRequest) => { status: number; body?: unknown }): ApiRequest[] {
  const requests: ApiRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      const request: ApiRequest = {
        url,
        method: init.method ?? "GET",
        headers: { ...(init.headers as Record<string, string>) },
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);
      const { status, body } = answer(request);
      const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
      return Promise.resolve(new Response(text, { status }));
    }),
  );
  return requests;
}

const path = (request: ApiRequest | undefined): string => request?.url.replace(PLATFORM_API_URL, "") ?? "";

/** The verification e-mail of `email`, with the link the platform sends. */
function verificationEmail(email: string, token: string): MailpitMessage {
  const html = `<a href="http://127.0.0.1:3000/verify-email?token=${token}">Verify</a>`;
  return {
    ID: "m1",
    MessageID: "m1@example.com",
    From: null,
    To: [{ Name: "", Address: email }],
    Cc: [],
    Bcc: [],
    ReplyTo: [],
    ReturnPath: "",
    Subject: "Verify your e-mail address",
    Date: "2026-10-14T12:00:00Z",
    Tags: [],
    Text: "",
    HTML: html,
    Size: html.length,
    Inline: [],
    Attachments: [],
  };
}

const LATER = "2026-10-14T12:15:00.000Z";
const SESSION = {
  accessToken: "access-token",
  accessTokenExpiresAt: LATER,
  refreshToken: "refresh-token",
  refreshTokenExpiresAt: "2026-11-13T12:00:00.000Z",
};

beforeEach(() => {
  // The stack the global setup would have started (support/seed.ts `stack()` reads it in a test worker).
  vi.stubEnv(
    "TEST_DATABASE_ADMIN_URL",
    "postgres://velexis_test_admin:dev_test_admin@127.0.0.1:5432/postgres",
  );
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379/0");
  vi.stubEnv("SMTP_URL", "smtp://127.0.0.1:1025");
  vi.stubEnv("MAILPIT_API_URL", "http://127.0.0.1:8025");
  vi.stubEnv("E2E_STRIPE", "false");
  vi.stubEnv("E2E_DATABASE_NAME", "velexis_e2e_unit_000000");
  waitForMessage.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createVerifiedAccount", () => {
  it("signs up and verifies with the e-mailed token as a first-party caller for the account's own IP", async () => {
    const requests = fakePlatformApi((request) =>
      path(request) === "/v1/auth/sign-up"
        ? { status: 202, body: { status: "verification_sent" } }
        : { status: 200, body: { status: "verified" } },
    );
    const input = buildAccount({ fullName: "Anna Berg" });
    waitForMessage.mockResolvedValue(verificationEmail(input.email, "verify-token-1"));

    const account = await createVerifiedAccount(input);

    expect(account).toMatchObject(input);
    expect(account.endUserIp).toMatch(TEST_IP);
    expect(requests.map((request) => `${request.method} ${path(request)}`)).toEqual([
      "POST /v1/auth/sign-up",
      "POST /v1/auth/verify-email",
    ]);
    const bffKey = exampleEnv(["platform/backend/.env.example"])["PLATFORM_BFF_KEY"];
    for (const request of requests) {
      // PADR-0019: the development BFF key, the end user's IP and agent, and no X-Forwarded-For (the API would then
      // ignore the end-user headers).
      expect(request.headers).toMatchObject({
        "X-Velexis-Bff-Key": bffKey,
        "X-Velexis-End-User-IP": account.endUserIp,
        "X-Velexis-End-User-Agent": "velexis-e2e",
        "Content-Type": "application/json",
      });
      expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain("x-forwarded-for");
    }
    expect(requests[0]?.body).toEqual({
      email: input.email,
      password: input.password,
      fullName: "Anna Berg",
      acceptTerms: true,
      termsVersion: "2026-10-01",
    });
    expect(waitForMessage).toHaveBeenCalledWith({ to: input.email, timeoutMs: 15_000 });
    expect(requests[1]?.body).toEqual({ token: "verify-token-1" });
  });

  it("fails with the operation, status and error code, never the request or response body", async () => {
    fakePlatformApi(() => ({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "echo of a body", status: 404, requestId: "r1" } },
    }));
    const input = buildAccount();
    const failure = createVerifiedAccount(input);
    await expect(failure).rejects.toBeInstanceOf(PlatformApiError);
    await expect(failure).rejects.toThrow(/^signUp answered 404 NOT_FOUND$/);
    expect(waitForMessage).not.toHaveBeenCalled();

    fakePlatformApi(() => ({ status: 502, body: "<html>Bad gateway</html>" }));
    await expect(createVerifiedAccount(buildAccount())).rejects.toThrow(/^signUp answered 502$/);
  });
});

describe("signInWithApi", () => {
  // RFC 6238's SHA-1 secret, 10 s into step 100.
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const clock = { now: () => (100 * 30 + 10) * 1000, sleep: () => Promise.resolve() };
  const account = (extra: Partial<PortalAccount> = {}): PortalAccount => ({
    ...buildAccount(),
    endUserIp: uniqueTestIp(),
    ...extra,
  });

  it("returns the session of an account without MFA", async () => {
    const requests = fakePlatformApi(() => ({ status: 200, body: { ...SESSION, account: {} } }));
    const person = account();
    expect(await signInWithApi(person)).toMatchObject(SESSION);
    expect(requests[0]?.body).toEqual({ email: person.email, password: person.password });
  });

  it("answers the MFA challenge with the authenticator's next code", async () => {
    const requests = fakePlatformApi((request) =>
      path(request) === "/v1/auth/sign-in"
        ? { status: 200, body: { mfaRequired: true, mfaChallengeToken: "challenge-1", expiresIn: 300 } }
        : { status: 200, body: { ...SESSION, account: {} } },
    );
    const person = account({ authenticator: new Authenticator(SECRET, clock) });
    expect(await signInWithApi(person)).toMatchObject(SESSION);
    expect(path(requests[1])).toBe("/v1/auth/mfa/verify");
    expect(requests[1]?.body).toEqual({
      mfaChallengeToken: "challenge-1",
      code: totpCode(SECRET, 100 * 30_000),
    });
  });

  it("refuses an MFA challenge for an account the journey has no authenticator for", async () => {
    fakePlatformApi(() => ({
      status: 200,
      body: { mfaRequired: true, mfaChallengeToken: "challenge-1", expiresIn: 300 },
    }));
    const person = account();
    await expect(signInWithApi(person)).rejects.toThrow(
      `${person.email} has MFA on, but the journey has no authenticator for it`,
    );
  });
});

describe("addSessionCookies", () => {
  it.each([
    ["portal", "__Host-vxp_at", "__Host-vxp_rt", "Lax"],
    ["admin", "__Host-vxa_at", "__Host-vxa_rt", "Strict"],
  ] as const)(
    "puts the %s session into host-only, httpOnly, Secure cookies",
    async (app, access, refresh, sameSite) => {
      const addCookies = vi.fn(() => Promise.resolve());
      await addSessionCookies({ addCookies }, app, SESSION);
      const attributes = { domain: "127.0.0.1", path: "/", httpOnly: true, secure: true, sameSite };
      expect(addCookies).toHaveBeenCalledWith([
        {
          name: access,
          value: "access-token",
          expires: Date.parse(LATER) / 1000,
          ...attributes,
        },
        {
          name: refresh,
          value: "refresh-token",
          expires: Date.parse(SESSION.refreshTokenExpiresAt) / 1000,
          ...attributes,
        },
      ]);
    },
  );
});

describe("uniqueTestIp", () => {
  it("draws from 198.18.0.0/15 (RFC 2544, never routed), never a network or broadcast address", () => {
    for (let draw = 0; draw < 2_000; draw += 1) {
      const [, , third, fourth] = TEST_IP.exec(uniqueTestIp()) ?? [];
      expect(Number(third)).toBeLessThanOrEqual(255);
      expect(Number(fourth)).toBeGreaterThanOrEqual(1);
      expect(Number(fourth)).toBeLessThanOrEqual(254);
    }
  });
});

describe("seed builders", () => {
  it("give every account its own address and a long random password", () => {
    const first = buildAccount();
    const second = buildAccount({ fullName: "Owner" });
    expect(first.email).not.toBe(second.email);
    expect(first.email).toMatch(/^account\+.+@example\.com$/);
    expect(second.fullName).toBe("Owner");
    expect(first.password).not.toBe(second.password);
    expect(newPassword()).toMatch(/^E2e-[A-Za-z0-9_-]{20}!$/);
  });
});
