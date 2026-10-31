// Console token redemption across the backends (PFE-019; platform/docs/flows/team-and-ota-admin-sso.md "Tests that
// prove it", PADR-0007, PADR-0017 item 2, scope PF-21 AC3 and PF-22 AC1, AC2). The stack of ./stack.ts runs the
// platform API and worker, the BUILT OTA worker and the BUILT OTA API (`startStack({ otaApi: true })`) on one database
// clone and one Redis database. The OTA side is the real one: `consoleSignIn` takes the portal token from Redis with
// `GETDEL` (OBE-059), re-reads the membership, the account and the tenant from the platform tables, and opens a staff
// session; its staff guard re-checks the cached membership on every console call, which the platform's `membership`
// invalidation (`vx:invalidate`) drops after a removal.
//
// The journey goes through the public APIs: a person signs up and creates an OTA, the real OTA worker sets it up, and
// the owner invites a second person as `agent` (createInvitation), who signs up and accepts with the token of the
// invitation e-mail (acceptInvitation). Then, as the member:
//
// - createConsoleToken gives a one-time token, which `POST /v1/console/auth/sign-in` (`grantType: "portal_token"`)
//   redeems once on the OTA API into a staff session of that member in that OTA; the same token posted again (a new
//   attempt, so a new Idempotency-Key, as the OTA admin's /sso sends one per request) is refused, `401
//   PORTAL_TOKEN_INVALID`;
// - a token issued while the member was active is refused once the owner has removed them (removeMember), `403
//   STAFF_MEMBERSHIP_INACTIVE`, and the removed member gets no new token (`404 NOT_FOUND`);
// - the staff session the first token opened ends: `console.auth.me` with its access token answers `403
//   STAFF_MEMBERSHIP_INACTIVE` within 60 seconds of removeMember [PF-21 AC3] (the invalidation makes it about a second).
//
// The OTA API is called as the OTA admin's server calls it (ota/admin/README.md §3): the OTA admin's service key
// (OTA_ADMIN_SERVICE_KEY, the dummy development value of the `.env.example` files the stack's OTA processes start
// from), `X-Velexis-Environment: test`, the staff member's end-user IP and user agent, on a direct loopback connection.
// Tokens exist only in this process's memory: never logged or printed, and an error names an outcome (`401
// PORTAL_TOKEN_INVALID`), never a body.
//
// The stack and the journey are expensive (two Nest module graphs, two OTA processes, Argon2id hashes, Mailpit, the
// setup itself): they run in setup hooks with explicit bounds, and the tests check what happened.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { sha256Hex } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { extractLinks, mailpit } from "@velexis/testing/mailpit";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redisKeys } from "../../src/common/redis/redis-keys";
import {
  createOta,
  MAIL_TIMEOUT_MS,
  OTA_CALL_TIMEOUT_MS,
  outcomeOf,
  requireOtaApi,
  SETUP_TIMEOUT_MS,
  signUpOwner,
  startStack,
  waitForSetup,
  type CreatedOta,
  type PortalOwner,
  type Stack,
} from "./stack";

/**
 * Starting the stack: the template clone, the API's and the worker's module graphs, the stub, `dev:seed` and the two
 * OTA processes, a few seconds each locally; each OTA process's readiness wait fails by itself after 60 s. Both
 * documents' response checkers are parsed here too.
 */
const STACK_TIMEOUT_MS = 240_000;
/**
 * The journey: two sign-ups and sign-ins (Argon2id each) with their verification e-mails (at most 20 s each),
 * createTenant, the setup (at most 60 s, then waitForSetup fails by itself), the invitation e-mail (at most 20 s) and
 * acceptInvitation.
 */
const JOURNEY_TIMEOUT_MS = 180_000;
/** One createConsoleToken call, two consoleSignIn calls and one console.auth.me, each a few milliseconds locally. */
const REDEEM_TIMEOUT_MS = 30_000;
/** PF-21 AC3: a removed member loses OTA admin access within 60 seconds. */
const PF21_BOUND_MS = 60_000;
/**
 * The removal: a createConsoleToken call, removeMember, the wait for the session's end (PF21_BOUND_MS at most, then
 * the hook records that it never ended) and two calls after it.
 */
const REMOVAL_TIMEOUT_MS = PF21_BOUND_MS + 30_000;
/** Stopping the OTA processes (SIGTERM, at most 10 s each before SIGKILL), the module graphs, the database. */
const STOP_TIMEOUT_MS = 60_000;
/**
 * The pause between two console.auth.me calls while the hook waits for the session to end: at most 240 calls in the
 * 60 s, well under the console's 600 per minute per staff session (OADR-0011 point 9), so even a session that only the
 * membership cache's expiry ends is never refused with a 429 first.
 */
const SESSION_POLL_MS = 250;
/** PADR-0007: a portal token lives 60 seconds in Redis. */
const PORTAL_TOKEN_TTL_MS = 60_000;
/** Documentation addresses (RFC 5737) of the owner and the member in the portal, and of the member at the console. */
const OWNER_IP = "203.0.113.37";
const MEMBER_IP = "203.0.113.38";
const STAFF_IP = "198.51.100.38";
const STAFF_USER_AGENT = "Mozilla/5.0 (PFE-019 cross-backend test)";
/** The new OTA (the clone is this file's own, so the key is free). */
const OTA_KEY = "xbconsole";
const OTA_NAME = "Cross Backend Console Travel";
/** The inviter's name in the invitation e-mail's subject (`team.invitation.subject.hbs`). */
const OWNER_NAME = "Olga Owner";
/** `PortalToken` of the platform document: `ptk_` and 43 base62 characters (PADR-0007 item 1). */
const PORTAL_TOKEN = /^ptk_[0-9A-Za-z]{43}$/;

/** An answer of the OTA API: the status, the headers and the parsed JSON body (`undefined` without one). */
interface OtaHttpAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

/**
 * Calls the OTA API as the OTA admin's server does (see the file header), with `accessToken` as the staff bearer when
 * given. Never logs a header or the body (they hold tokens); a body that is not JSON fails with the status only.
 */
async function otaAdminCall(
  stack: Stack,
  {
    method,
    path,
    body,
    accessToken,
  }: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
    readonly accessToken?: string;
  },
): Promise<OtaHttpAnswer> {
  const serviceKey = stack.otaEnv()["OTA_ADMIN_SERVICE_KEY"];
  if (serviceKey === undefined || serviceKey === "") {
    throw new Error("the OTA API's environment has no OTA_ADMIN_SERVICE_KEY (ota/backend/.env.example)");
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Api-Key": serviceKey,
    "X-Velexis-Environment": "test",
    "X-Velexis-End-User-IP": STAFF_IP,
    "X-Velexis-End-User-Agent": STAFF_USER_AGENT,
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = randomUUID();
  }
  if (accessToken !== undefined) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  const response = await fetch(`${requireOtaApi(stack).url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(OTA_CALL_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new Error(
      `${method} ${path} on the OTA API answered ${response.status} with a body that is not JSON`,
    );
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

/** `consoleSignIn` with the portal-token grant, as the OTA admin's `/sso` sends it. */
function redeem(stack: Stack, portalToken: string): Promise<OtaHttpAnswer> {
  return otaAdminCall(stack, {
    method: "POST",
    path: "/v1/console/auth/sign-in",
    body: { grantType: "portal_token", portalToken },
  });
}

/** `consoleGetMe` with a staff access token. */
function me(stack: Stack, accessToken: string): Promise<OtaHttpAnswer> {
  return otaAdminCall(stack, { method: "GET", path: "/v1/console/auth/me", accessToken });
}

/** The parts of a ConsoleStaffSession this file reads. */
interface StaffSessionBody {
  readonly session: { readonly accessToken: string; readonly refreshToken: string };
  readonly staff: {
    readonly id: string;
    readonly accountId: string;
    readonly email: string;
    readonly role: string;
  };
  readonly tenant: { readonly id: string; readonly key: string; readonly name: string };
  readonly environments: readonly string[];
}

/** The `ConsoleStaffSession` of a successful consoleSignIn, or a clear error naming the outcome. */
function staffSessionOf(answer: OtaHttpAnswer): StaffSessionBody {
  if (answer.status !== 200) {
    throw new Error(`consoleSignIn answered ${outcomeOf(answer)}, not 200`);
  }
  return answer.body as StaffSessionBody;
}

/** A console token as createConsoleToken answered it. */
interface IssuedToken {
  readonly response: Response;
  readonly portalToken: string;
  /** The PTTL (ms) of its `ptk:<sha256>` key right after the answer. */
  readonly ttlMs: number;
}

/** The PTTL of a key of the stack's Redis database, in ms (`-2` when it does not exist, `-1` without a TTL). */
function pttl(stack: Stack, key: string): Promise<number> {
  return stack.api.redis.client.pttl(key);
}

/** The Redis key of a portal token (`ptk:<sha256 hex>`, shared by both backends). */
function portalTokenKey(portalToken: string): string {
  return redisKeys.portalToken(sha256Hex(portalToken)).key;
}

/** How the staff session that the first token opened ended after removeMember. */
interface SessionEnd {
  /** From the removeMember call to the first console.auth.me answer that refuses the session; `undefined` if none did. */
  readonly elapsedMs: number | undefined;
  readonly last: OtaHttpAnswer;
  readonly calls: number;
}

describe("[PFE-019] a console token redeemed on the OTA API, once, and never for a removed member", () => {
  let stack: Stack;
  let owner: PortalOwner;
  let member: PortalOwner;
  let ota: CreatedOta;
  /** The member's membership (`stf_…`), as acceptInvitation answered it. */
  let membershipId: string;
  let accepted: Response;

  let first: IssuedToken;
  let signedIn: OtaHttpAnswer;
  let redeemedAgain: OtaHttpAnswer;
  /** Whether the first token's key was still in Redis after its redemption. */
  let keyLeftAfterRedemption: number;
  let profile: OtaHttpAnswer;

  let second: IssuedToken;
  let removal: Response;
  let sessionEnd: SessionEnd;
  let redeemedAfterRemoval: OtaHttpAnswer;
  let tokenAfterRemoval: Response;

  beforeAll(async () => {
    stack = await startStack({ otaApi: true });
    // Parses both documents here, not in the first test that checks an answer.
    responseChecker("platform");
    responseChecker("ota");
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.stop();
  }, STOP_TIMEOUT_MS);

  /** createConsoleToken as the member, with the PTTL of the token's key right after the answer. */
  async function issueToken(): Promise<IssuedToken> {
    const response = await stack.api.http
      .post(`/v1/tenants/${ota.tenantId}/console-token`)
      .set(member.headers);
    if (response.status !== 201) {
      throw new Error(`createConsoleToken answered ${outcomeOf(response)}, not 201`);
    }
    const { portalToken } = response.body as { portalToken: string };
    return { response, portalToken, ttlMs: await pttl(stack, portalTokenKey(portalToken)) };
  }

  beforeAll(async () => {
    owner = await signUpOwner(stack, { label: "xb-console-owner", ip: OWNER_IP, fullName: OWNER_NAME });
    ota = await createOta(stack, owner, { key: OTA_KEY, name: OTA_NAME });
    await waitForSetup(stack, owner, ota.tenantId, { timeoutMs: SETUP_TIMEOUT_MS });
    member = await signUpOwner(stack, { label: "xb-console-member", ip: MEMBER_IP, fullName: "Mona Member" });

    // The owner invites the member as an agent; the member accepts with the token of the invitation e-mail.
    const invitation = await stack.api.http
      .post(`/v1/tenants/${ota.tenantId}/invitations`)
      .set(owner.headers)
      .send({ email: member.email, role: "agent" });
    if (invitation.status !== 201) {
      throw new Error(`createInvitation answered ${outcomeOf(invitation)}, not 201`);
    }
    const message = await mailpit.waitForMessage({
      to: member.email,
      subject: `${OWNER_NAME} invited you to ${OTA_NAME} on Velexis`,
      timeoutMs: MAIL_TIMEOUT_MS,
    });
    const prefix = `${stack.api.config.PUBLIC_PORTAL_URL.replace(/\/$/, "")}/invitations/accept?token=`;
    const link = extractLinks(message).find((url) => url.startsWith(prefix));
    const token = link === undefined ? null : new URL(link).searchParams.get("token");
    if (token === null) {
      throw new Error("the invitation e-mail has no /invitations/accept link");
    }
    accepted = await stack.api.http.post("/v1/invitations/accept").set(member.headers).send({ token });
    if (accepted.status !== 200) {
      throw new Error(`acceptInvitation answered ${outcomeOf(accepted)}, not 200`);
    }
    membershipId = (accepted.body as { membership: { id: string } }).membership.id;
  }, JOURNEY_TIMEOUT_MS);

  beforeAll(async () => {
    first = await issueToken();
    signedIn = await redeem(stack, first.portalToken);
    keyLeftAfterRedemption = await stack.api.redis.client.exists(portalTokenKey(first.portalToken));
    redeemedAgain = await redeem(stack, first.portalToken);
    profile = await me(stack, staffSessionOf(signedIn).session.accessToken);
  }, REDEEM_TIMEOUT_MS);

  beforeAll(async () => {
    // A token issued while the member is still active, redeemed only after the removal.
    second = await issueToken();
    const { accessToken } = staffSessionOf(signedIn).session;
    const since = performance.now();
    removal = await stack.api.http
      .delete(`/v1/tenants/${ota.tenantId}/members/${membershipId}`)
      .set(owner.headers);
    if (removal.status !== 204) {
      throw new Error(`removeMember answered ${outcomeOf(removal)}, not 204`);
    }
    // The open staff session first, so that no later sign-in attempt of the member touches its cached membership.
    let calls = 0;
    for (;;) {
      const last = await me(stack, accessToken);
      calls += 1;
      const now = performance.now();
      if (outcomeOf(last) === "403 STAFF_MEMBERSHIP_INACTIVE") {
        sessionEnd = { elapsedMs: now - since, last, calls };
        break;
      }
      if (now - since >= PF21_BOUND_MS) {
        sessionEnd = { elapsedMs: undefined, last, calls };
        break;
      }
      await delay(SESSION_POLL_MS);
    }
    redeemedAfterRemoval = await redeem(stack, second.portalToken);
    tokenAfterRemoval = await stack.api.http
      .post(`/v1/tenants/${ota.tenantId}/console-token`)
      .set(member.headers);
  }, REMOVAL_TIMEOUT_MS);

  it("[PFE-019 AC1] a token from createConsoleToken is redeemed by consoleSignIn on the OTA API into a staff session of the member in that OTA [PF-22 AC1, AC2]", () => {
    expectResponseToMatch("acceptInvitation", accepted, { document: "platform" });
    expect(accepted.body).toMatchObject({
      membership: { role: "agent", status: "active" },
      tenant: { id: ota.tenantId },
    });

    // The platform's side: a one-time token for 60 s, never stored for a replay.
    expectResponseToMatch("createConsoleToken", first.response, { document: "platform" });
    expect(first.response.headers["cache-control"]).toBe("no-store");
    expect(first.portalToken).toMatch(PORTAL_TOKEN);
    expect(first.ttlMs).toBeGreaterThan(0);
    expect(first.ttlMs).toBeLessThanOrEqual(PORTAL_TOKEN_TTL_MS);

    // The OTA's side: the member's staff session, bound to this OTA, with the member's role.
    expect(outcomeOf(signedIn)).toBe("200");
    expectResponseToMatch("consoleSignIn", signedIn);
    expect(signedIn.headers.get("cache-control")).toBe("no-store");
    const session = staffSessionOf(signedIn);
    expect(session.staff).toMatchObject({
      id: membershipId,
      accountId: member.accountId,
      email: member.email,
      role: "agent",
    });
    expect(session.tenant).toMatchObject({ id: ota.tenantId, key: OTA_KEY, name: OTA_NAME });
    expect(session.environments).toEqual(["test"]);
    // GETDEL: the token's key is gone with its first redemption.
    expect(keyLeftAfterRedemption).toBe(0);

    // The session works: console.auth.me names the same member and OTA.
    expect(outcomeOf(profile)).toBe("200");
    expectResponseToMatch("consoleGetMe", profile);
    expect(profile.body).toMatchObject({
      staff: { id: membershipId, role: "agent" },
      tenant: { id: ota.tenantId },
    });
  });

  it("[PFE-019 AC1] the same token redeemed a second time is refused [PF-22 AC2]", () => {
    expect(outcomeOf(redeemedAgain)).toBe("401 PORTAL_TOKEN_INVALID");
    expectResponseToMatch("consoleSignIn", redeemedAgain);
    // No second session: the refusal carries no token of any kind.
    expect(JSON.stringify(redeemedAgain.body)).not.toMatch(/accessToken|refreshToken/);
    expect(JSON.stringify(redeemedAgain.body)).not.toContain(first.portalToken);
  });

  it("[PFE-019 AC1] a token issued before the member's removal is refused after it, and the removed member gets no new token [PF-21 AC3]", () => {
    expectResponseToMatch("createConsoleToken", second.response, { document: "platform" });
    expect(outcomeOf(removal)).toBe("204");
    expectResponseToMatch("removeMember", removal, { document: "platform" });

    expect(outcomeOf(redeemedAfterRemoval)).toBe("403 STAFF_MEMBERSHIP_INACTIVE");
    expectResponseToMatch("consoleSignIn", redeemedAfterRemoval);
    expect(JSON.stringify(redeemedAfterRemoval.body)).not.toMatch(/accessToken|refreshToken/);

    expect(outcomeOf(tokenAfterRemoval)).toBe("404 NOT_FOUND");
    expectResponseToMatch("createConsoleToken", tokenAfterRemoval, { document: "platform" });
  });

  it("[PFE-019 AC1] the removed member's open staff session is refused within 60 seconds of removeMember [PF-21 AC3]", () => {
    expect(outcomeOf(sessionEnd.last)).toBe("403 STAFF_MEMBERSHIP_INACTIVE");
    expectResponseToMatch("consoleGetMe", sessionEnd.last);
    expect(
      sessionEnd.elapsedMs,
      "the OTA API still accepted the session 60 s after removeMember",
    ).toBeDefined();
    expect(sessionEnd.elapsedMs).toBeLessThan(PF21_BOUND_MS);
    expect(stack.otaWorker.exitDescription()).toBeUndefined();
    expect(requireOtaApi(stack).exitDescription()).toBeUndefined();
  });
});
