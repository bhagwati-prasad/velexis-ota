// Playwright fixtures of the Velexis journeys (PFE-014): a signed-in portal user and a signed-in platform admin, and
// the platform API calls that arrange them (PADR-0017 item 5: through the public API where an operation exists).
//
//   import { expect, test } from "../support/fixtures";
//
//   test("lists my OTAs", async ({ portalUser }) => {
//     await portalUser.page.goto("/dashboard");
//     await expect(portalUser.page.getByRole("heading", { name: "My OTAs" })).toBeVisible();
//   });
//
// Each fixture creates its own account (`uniqueEmail`, random password), verifies it with the link that the platform
// e-mails to Mailpit, signs in through the platform API and puts the session into a new browser context as the
// httpOnly cookies the portal or the admin would have set (platform/frontend/README.md §6, platform/admin/README.md
// §4). It does not drive the sign-in pages: the journeys that test those pages (PFE-015, PAD-010) do. Tokens stay in
// the test process and in those cookies; they are never logged.
//
// Every account gets its own end-user IP from 198.18.0.0/15 (RFC 2544, never routed): the API calls carry it as
// `X-Velexis-End-User-IP` with the development `PLATFORM_BFF_KEY` (PADR-0019), and the account's browser context
// sends it as `X-Forwarded-For`, which the portal and the admin forward. So parallel journeys do not compete for one
// per-IP rate-limit bucket (two accounts draw the same IP once in about 130 000 draws).
import { randomInt } from "node:crypto";
import { test as base, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { E2E_MAIL_TIMEOUT_MS, waitForLink } from "./mailpit";
import { buildAccount, grantPlatformAdmin, stack, type AccountInput } from "./seed";
import { PLATFORM_ADMIN_URL, PLATFORM_API_URL, PORTAL_URL, serviceEnv, STACK_HOST } from "./stack";
import { Authenticator } from "./totp";

export { expect } from "@playwright/test";

/**
 * Tags of tests (`test("…", { tag: PROJECT_TAGS.portal }, …)`): a test of a spec that several projects share
 * (specs/smoke.e2e.ts) runs only in the project of its tag, and a portal journey that drives Stripe over the network
 * runs only in the nightly `portal-stripe` project (playwright.config.ts).
 */
export const PROJECT_TAGS = Object.freeze({
  portal: "@portal",
  platformAdmin: "@platform-admin",
  stripe: "@stripe",
} as const);

type Schemas = components["schemas"];

/** The terms version the fixtures accept at sign-up. */
export const E2E_TERMS_VERSION = "2026-10-01";

/** A new end-user IP in 198.18.0.0/15, the RFC 2544 benchmarking range that is never routed. */
export function uniqueTestIp(): string {
  return `198.${18 + randomInt(2)}.${randomInt(256)}.${1 + randomInt(254)}`;
}

/** A platform API error: the status and the error code, never the request or response body. */
export class PlatformApiError extends Error {
  override readonly name = "PlatformApiError";

  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`${operation} answered ${status}${code === undefined ? "" : ` ${code}`}`);
  }
}

/** The development PLATFORM_BFF_KEY of the stack (platform/backend/.env.example), shared with the portal and admin. */
function bffKey(): string {
  const key = serviceEnv("platform-api", stack())["PLATFORM_BFF_KEY"];
  if (key === undefined || key === "") {
    throw new Error("platform/backend/.env.example has no PLATFORM_BFF_KEY");
  }
  return key;
}

/** One call of the platform API (`callPlatformApi`). */
export interface ApiCall {
  /** The operationId, for error messages. */
  readonly operation: string;
  readonly method: "GET" | "POST";
  /** The path under PLATFORM_API_URL, for example `/v1/auth/sign-in`. */
  readonly path: string;
  readonly endUserIp: string;
  readonly body?: unknown;
  readonly accessToken?: string;
  /** Headers of the operation itself, such as `Idempotency-Key`; the PADR-0019 headers below always win. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Calls the platform API as a first-party caller on behalf of the end user at `endUserIp` (PADR-0019) and resolves to
 * the JSON answer; a refusal rejects with a `PlatformApiError` (operation, status and code, never a body).
 */
export async function callPlatformApi<T>(call: ApiCall): Promise<T> {
  const headers: Record<string, string> = {
    ...call.headers,
    Accept: "application/json",
    "X-Velexis-Bff-Key": bffKey(),
    "X-Velexis-End-User-IP": call.endUserIp,
    "X-Velexis-End-User-Agent": "velexis-e2e",
  };
  if (call.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (call.accessToken !== undefined) {
    headers["Authorization"] = `Bearer ${call.accessToken}`;
  }
  const response = await fetch(`${PLATFORM_API_URL}${call.path}`, {
    method: call.method,
    headers,
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let code: string | undefined;
    try {
      code = (JSON.parse(text) as Partial<Schemas["ErrorResponse"]>).error?.code;
    } catch {
      code = undefined;
    }
    throw new PlatformApiError(call.operation, response.status, code);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/** A portal account of a journey: what the person typed, their end-user IP and, once enabled, their authenticator. */
export interface PortalAccount extends AccountInput {
  readonly endUserIp: string;
  /** The account's authenticator app, once MFA is enabled (`enableMfa`). */
  readonly authenticator?: Authenticator;
  /** The ten recovery codes `enableMfa` showed once. */
  readonly recoveryCodes?: readonly string[];
}

/** An account with MFA enabled. */
export interface MfaAccount extends PortalAccount {
  readonly authenticator: Authenticator;
  readonly recoveryCodes: readonly string[];
}

/** The tokens of a portal or admin session (`PortalSession`, and `AdminSession` of the admin surface). */
export interface SessionTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
}

/**
 * Signs up `input` through `signUp`, opens the verification link that arrives in Mailpit and verifies the address
 * through `verifyEmail` (the link is `PUBLIC_PORTAL_URL/verify-email?token=…`). Resolves to an active, verified
 * account without MFA.
 */
export async function createVerifiedAccount(input: AccountInput = buildAccount()): Promise<PortalAccount> {
  const account: PortalAccount = { ...input, endUserIp: uniqueTestIp() };
  const signUp: Schemas["SignUpRequest"] = {
    email: account.email,
    password: account.password,
    fullName: account.fullName,
    acceptTerms: true,
    termsVersion: E2E_TERMS_VERSION,
  };
  await callPlatformApi({
    operation: "signUp",
    method: "POST",
    path: "/v1/auth/sign-up",
    endUserIp: account.endUserIp,
    body: signUp,
  });
  const link = await waitForLink({
    to: account.email,
    path: "/verify-email",
    origin: PORTAL_URL,
    timeoutMs: E2E_MAIL_TIMEOUT_MS,
  });
  const token = link.searchParams.get("token");
  if (token === null) {
    throw new Error(`the verification e-mail to ${account.email} has a link without a token`);
  }
  const verify: Schemas["VerifyEmailRequest"] = { token };
  await callPlatformApi({
    operation: "verifyEmail",
    method: "POST",
    path: "/v1/auth/verify-email",
    endUserIp: account.endUserIp,
    body: verify,
  });
  return account;
}

/** A portal session for `account` through `signIn`, and `verifyMfa` with its next TOTP code when MFA is on. */
export async function signInWithApi(account: PortalAccount): Promise<SessionTokens> {
  const signIn: Schemas["SignInRequest"] = { email: account.email, password: account.password };
  const result = await callPlatformApi<Schemas["SignInResult"]>({
    operation: "signIn",
    method: "POST",
    path: "/v1/auth/sign-in",
    endUserIp: account.endUserIp,
    body: signIn,
  });
  if (!("mfaRequired" in result)) {
    return result;
  }
  if (account.authenticator === undefined) {
    throw new Error(`${account.email} has MFA on, but the journey has no authenticator for it`);
  }
  const verify: Schemas["VerifyMfaWithCode"] = {
    mfaChallengeToken: result.mfaChallengeToken,
    code: await account.authenticator.nextCode(),
  };
  return await callPlatformApi<Schemas["PortalSession"]>({
    operation: "verifyMfa",
    method: "POST",
    path: "/v1/auth/mfa/verify",
    endUserIp: account.endUserIp,
    body: verify,
  });
}

/** Enables TOTP MFA for `account` (MFA off) through `startMfaSetup` and `enableMfa`. */
export async function enableMfa(account: PortalAccount): Promise<MfaAccount> {
  const { accessToken } = await signInWithApi(account);
  const setup = await callPlatformApi<Schemas["MfaSetup"]>({
    operation: "startMfaSetup",
    method: "POST",
    path: "/v1/me/mfa/setup",
    endUserIp: account.endUserIp,
    accessToken,
  });
  const authenticator = new Authenticator(setup.secret);
  const enable: Schemas["TotpCodeRequest"] = { code: await authenticator.nextCode() };
  const { recoveryCodes } = await callPlatformApi<Schemas["RecoveryCodes"]>({
    operation: "enableMfa",
    method: "POST",
    path: "/v1/me/mfa/enable",
    endUserIp: account.endUserIp,
    accessToken,
    body: enable,
  });
  return { ...account, authenticator, recoveryCodes };
}

/**
 * An admin session for `account` (a platform admin with MFA) through `adminSignIn` and `adminVerifyMfa`
 * (`POST /v1/admin/auth/sign-in` and `/v1/admin/auth/mfa/verify`, platform/docs/api-inventory-admin.md).
 */
export async function signInToAdminWithApi(account: MfaAccount): Promise<SessionTokens> {
  const challenge = await callPlatformApi<{ readonly mfaChallengeToken: string }>({
    operation: "adminSignIn",
    method: "POST",
    path: "/v1/admin/auth/sign-in",
    endUserIp: account.endUserIp,
    body: { email: account.email, password: account.password },
  });
  return await callPlatformApi<SessionTokens>({
    operation: "adminVerifyMfa",
    method: "POST",
    path: "/v1/admin/auth/mfa/verify",
    endUserIp: account.endUserIp,
    body: { mfaChallengeToken: challenge.mfaChallengeToken, code: await account.authenticator.nextCode() },
  });
}

/** The session cookies of the portal (README §6) and of the admin (README §4). */
const SESSION_COOKIES = {
  portal: { access: "__Host-vxp_at", refresh: "__Host-vxp_rt", sameSite: "Lax" },
  admin: { access: "__Host-vxa_at", refresh: "__Host-vxa_rt", sameSite: "Strict" },
} as const;

/**
 * Puts `session` into `context` as the httpOnly session cookies of `app`. `__Host-` cookies need `Secure`, `Path=/`
 * and no `Domain` attribute; Chromium accepts them on http://127.0.0.1 and sends them back to every port of it.
 */
export async function addSessionCookies(
  context: Pick<BrowserContext, "addCookies">,
  app: keyof typeof SESSION_COOKIES,
  session: SessionTokens,
): Promise<void> {
  const names = SESSION_COOKIES[app];
  const cookie = (name: string, value: string, expiresAt: string) => ({
    name,
    value,
    domain: STACK_HOST,
    path: "/",
    expires: Math.floor(Date.parse(expiresAt) / 1000),
    httpOnly: true,
    secure: true,
    sameSite: names.sameSite,
  });
  await context.addCookies([
    cookie(names.access, session.accessToken, session.accessTokenExpiresAt),
    cookie(names.refresh, session.refreshToken, session.refreshTokenExpiresAt),
  ]);
}

/** A new browser context for `account` on `baseURL`: its own cookies and its end-user IP as `X-Forwarded-For`. */
export async function newAccountContext(
  browser: Browser,
  account: PortalAccount,
  baseURL: string,
): Promise<BrowserContext> {
  return await browser.newContext({ baseURL, extraHTTPHeaders: { "X-Forwarded-For": account.endUserIp } });
}

/** A signed-in person in a browser context of their own. */
export interface SignedIn<A extends PortalAccount> {
  readonly account: A;
  readonly context: BrowserContext;
  /** A page of `context`, on about:blank: the journey navigates. */
  readonly page: Page;
}

export interface E2eFixtures {
  /** A verified portal account without MFA, signed in to the portal (base URL PORTAL_URL). */
  portalUser: SignedIn<PortalAccount>;
  /** A platform admin with MFA (`admin:grant`), signed in to the platform admin (base URL PLATFORM_ADMIN_URL). */
  admin: SignedIn<MfaAccount>;
}

/** `test` with the fixtures of this file; import `test` and `expect` from here in every spec. */
export const test = base.extend<E2eFixtures>({
  portalUser: async ({ browser }, use) => {
    const account = await createVerifiedAccount(buildAccount({ fullName: "Portal User" }));
    const context = await newAccountContext(browser, account, PORTAL_URL);
    try {
      await addSessionCookies(context, "portal", await signInWithApi(account));
      await use({ account, context, page: await context.newPage() });
    } finally {
      await context.close();
    }
  },
  admin: async ({ browser }, use) => {
    const account = await enableMfa(
      await createVerifiedAccount(buildAccount({ fullName: "Platform Admin" })),
    );
    await grantPlatformAdmin(account.email);
    const context = await newAccountContext(browser, account, PLATFORM_ADMIN_URL);
    try {
      await addSessionCookies(context, "admin", await signInToAdminWithApi(account));
      await use({ account, context, page: await context.newPage() });
    } finally {
      await context.close();
    }
  },
});
