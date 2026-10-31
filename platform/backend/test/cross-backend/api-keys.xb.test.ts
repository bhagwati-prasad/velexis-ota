// API key acceptance, revocation and suspension across the backends (PBE-036; platform/docs/flows/api-keys.md "Tests
// that prove it", PADR-0017 item 2, PADR-0005, PADR-0014 item 5, scope PF-30 AC3 and PF-82). The stack of ./stack.ts
// runs the platform API and worker, the BUILT OTA worker and the BUILT OTA API (`startStack({ otaApi: true })`) on one
// database clone and one Redis database, on ports the system gives. The OTA side is the real one: the OTA API verifies
// the key against `platform.api_keys` with the shared pepper (OF-01, OADR-0009 rule 1.3), resolves the tenant through
// its platform caches (`apikey:<prefix>`, `tenant:<id>`, 60 s) and drops a cached row when the platform's
// `vx:invalidate` event about it arrives (platform architecture §6.3).
//
// The journey goes through the public APIs: a person signs up and creates an OTA, the real OTA worker sets it up, and
// the owner creates two secret test keys with createApiKey. Each key calls getStorefront (`GET /v1/storefront`,
// `storefront.get`) on the OTA API as a storefront's server code would, which also fills the OTA's caches. Then:
//
// - the owner revokes one key (revokeApiKey): the OTA API refuses it (`401 INVALID_API_KEY`) within one second, while
//   the other key keeps working;
// - a platform admin suspends the OTA (adminSuspendTenant): the OTA API answers the other key `403 TENANT_SUSPENDED`
//   within one second (60 seconds is the documented bound, PADR-0014 item 5).
//
// Both changes are made while the OTA's cached row has more than the bound left to live (its PTTL is recorded), so an
// answer that changes within one second shows the invalidation at work, not an expired cache entry. The first calls
// normally fill those entries, but the setup's last post-step (notify.step.ts) publishes its `tenant` and `connection`
// events after `active` is visible, and an event that reaches the OTA API during a fill keeps that fill from being
// written (the OTA's cache generations): so each change first asks the OTA API again until the entry is cached
// (`cachedTtl`), instead of depending on that timing. The time is taken from the platform call (sent before its commit,
// so the bound is counted on the safe side) to the first answer of the OTA API that shows the change; the OTA API is
// asked every 25 ms from the platform's answer on, and given up on after 10 s, so a miss says how late the change came,
// or that it never came. The keys exist only in this process's memory: never logged or printed, and an error names an
// outcome (`401 INVALID_API_KEY`), never a body.
//
// The stack and the journey are expensive (two Nest module graphs, two OTA processes, Argon2id hashes, Mailpit, the
// setup itself): they run in setup hooks with explicit bounds, and the tests check what happened.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail } from "@velexis/testing/mailpit";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../src/auth/token.service";
import { insertAccount, testId } from "../builders/platform-rows";
import {
  callOtaApi,
  createOta,
  OTA_API_ENTRY,
  OTA_WORKER_ENTRY,
  OtaBuildMissingError,
  outcomeOf,
  requireOtaApi,
  SETUP_TIMEOUT_MS,
  signUpOwner,
  startStack,
  waitForSetup,
  type CreatedOta,
  type OtaAnswer,
  type PortalOwner,
  type Stack,
} from "./stack";

/**
 * Starting the stack: the template clone, the API's and the worker's module graphs, the stub, `dev:seed` and the two
 * OTA processes, a few seconds each locally; each OTA process's readiness wait fails by itself after 60 s. The OTA
 * document's response checker is parsed here too.
 */
const STACK_TIMEOUT_MS = 240_000;
/**
 * The journey: sign-up and sign-in (Argon2id each), the verification e-mail (at most 20 s), createTenant, the setup (at
 * most 60 s, then waitForSetup fails by itself), two createApiKey calls and the first OTA API calls.
 */
const JOURNEY_TIMEOUT_MS = 150_000;
/** One change and the wait for the OTA API (GIVE_UP_MS at most, then the answers before and after). */
const CHANGE_TIMEOUT_MS = 30_000;
/** Stopping the OTA processes (SIGTERM, at most 10 s each before SIGKILL), the module graphs, the database. */
const STOP_TIMEOUT_MS = 60_000;
/** The acceptance bound: the OTA API follows a revocation [PF-30 AC3] and a suspension [PF-82] within one second. */
const PROPAGATION_BOUND_MS = 1_000;
/** How long a hook keeps asking the OTA API after a change before it gives up: well past the bound. */
const GIVE_UP_MS = 10_000;
/** The pause between two calls of the OTA API while a hook waits for a change. */
const OTA_POLL_MS = 25;
/** How many calls of the OTA API a hook makes at most to have a row cached before a change (`cachedTtl`). */
const WARM_UP_CALLS = 20;
/** Documentation addresses (RFC 5737) of the person and the platform admin. */
const PERSON_IP = "203.0.113.36";
const ADMIN_IP = "198.51.100.36";
/** The new OTA (the clone is this file's own, so the key is free). */
const OTA_KEY = "xbkeys";
const OTA_NAME = "Cross Backend Keys Travel";
/** The admin's written reason of the suspension (5–500 characters). */
const SUSPENSION_REASON = "Cross-backend proof that a suspension reaches the OTA API (PBE-036).";
/** The OTA's platform row caches (ota/backend/src/common/redis/redis.keys.ts), in the stack's Redis database. */
const otaCacheKeys = {
  apiKey: (prefix: string): string => `apikey:${prefix}`,
  tenant: (tenantId: string): string => `tenant:${tenantId}`,
};

/** A key createApiKey answered: the full key stays in this process's memory only. */
interface CreatedKey {
  readonly response: Response;
  readonly id: string;
  readonly prefix: string;
  readonly key: string;
}

/** How the OTA API followed one change of the platform. */
interface Propagation {
  /** The platform's answer to the change. */
  readonly change: Response;
  /** The PTTL (ms) of the OTA's cached row just before the change: how long it would still have served the old row. */
  readonly cachedTtlMs: number;
  /** From the platform call to the first OTA answer with the new outcome; `undefined` when none came in time. */
  readonly elapsedMs: number | undefined;
  /** The last answer of the OTA API. */
  readonly last: OtaAnswer;
  /** How many calls of the OTA API it took. */
  readonly calls: number;
}

/** `X-Api-Key` headers of a key, as a storefront's server code sends them. */
function keyHeaders(key: CreatedKey): Record<string, string> {
  return { "X-Api-Key": key.key };
}

/**
 * Calls getStorefront with `key` every OTA_POLL_MS until the OTA API answers `outcome`, and gives up GIVE_UP_MS after
 * `since` (the `performance.now()` of the platform call). Usable in hooks: it never throws for a late change, it
 * reports it.
 */
async function follow(
  stack: Stack,
  key: CreatedKey,
  outcome: string,
  since: number,
): Promise<Omit<Propagation, "change" | "cachedTtlMs">> {
  const api = requireOtaApi(stack);
  let calls = 0;
  for (;;) {
    const last = await callOtaApi(api, "/v1/storefront", keyHeaders(key));
    calls += 1;
    const now = performance.now();
    if (outcomeOf(last) === outcome) {
      return { elapsedMs: now - since, last, calls };
    }
    if (now - since >= GIVE_UP_MS) {
      return { elapsedMs: undefined, last, calls };
    }
    await delay(OTA_POLL_MS);
  }
}

/** The PTTL of a key of the stack's Redis database, in ms (`-2` when it does not exist, `-1` without a TTL). */
function pttl(stack: Stack, key: string): Promise<number> {
  return stack.api.redis.client.pttl(key);
}

/**
 * The PTTL of the OTA's cache entry `cacheKey` once it has more than the bound left to live: calls getStorefront with
 * `key` (at most WARM_UP_CALLS times) while it has not (see the file header). Answers the last PTTL, so an OTA API that
 * never caches the row still fails the test's check.
 */
async function cachedTtl(stack: Stack, key: CreatedKey, cacheKey: string): Promise<number> {
  let ttl = await pttl(stack, cacheKey);
  for (let calls = 0; ttl <= PROPAGATION_BOUND_MS && calls < WARM_UP_CALLS; calls += 1) {
    await callOtaApi(requireOtaApi(stack), "/v1/storefront", keyHeaders(key));
    ttl = await pttl(stack, cacheKey);
  }
  return ttl;
}

describe("[PBE-036] a portal key on the OTA API, its revocation and a suspension", () => {
  let stack: Stack;
  let owner: PortalOwner;
  let ota: CreatedOta;
  let adminHeaders: Record<string, string>;

  /** The key that the owner revokes, and the one that stays. */
  let revoked: CreatedKey;
  let kept: CreatedKey;
  /** The first answers of the OTA API to each key. */
  let acceptedRevoked: OtaAnswer;
  let acceptedKept: OtaAnswer;

  let revocation: Propagation;
  /** The kept key once the other one is refused. */
  let keptAfterRevocation: OtaAnswer;
  let suspension: Propagation;

  beforeAll(async () => {
    stack = await startStack({ otaApi: true });
    // Parses both documents here, not in the first test that checks an answer.
    responseChecker("platform");
    responseChecker("ota");
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.stop();
  }, STOP_TIMEOUT_MS);

  /** Creates a secret test key with the `storefront` scope through the portal's API, as the OTA's owner. */
  async function createKey(name: string): Promise<CreatedKey> {
    const response = await stack.api.http
      .post(`/v1/tenants/${ota.tenantId}/api-keys`)
      .set(owner.headers)
      .send({ name, kind: "secret", environment: "test", scopes: ["storefront"] });
    if (response.status !== 201) {
      throw new Error(`createApiKey answered ${outcomeOf(response)}, not 201`);
    }
    const { apiKey, key } = response.body as { apiKey: { id: string; prefix: string }; key: string };
    return { response, id: apiKey.id, prefix: apiKey.prefix, key };
  }

  beforeAll(async () => {
    owner = await signUpOwner(stack, { label: "xb-keys-owner", ip: PERSON_IP });
    ota = await createOta(stack, owner, { key: OTA_KEY, name: OTA_NAME });
    await waitForSetup(stack, owner, ota.tenantId, { timeoutMs: SETUP_TIMEOUT_MS });

    revoked = await createKey("Storefront server (to revoke)");
    kept = await createKey("Storefront server");
    const api = requireOtaApi(stack);
    acceptedRevoked = await callOtaApi(api, "/v1/storefront", keyHeaders(revoked));
    acceptedKept = await callOtaApi(api, "/v1/storefront", keyHeaders(kept));

    // A platform admin of this clone, written with the builders as the integration tests do (dev:seed's admin signs
    // in with a password and a TOTP secret that the stack drops); the token comes from the API's TokenService, on the
    // stack's real Clock, with a step-up now.
    const admin = await insertAccount(stack.pool, {
      email: uniqueEmail("xb-keys-admin"),
      is_platform_admin: true,
      mfa_enabled: true,
    });
    const { token } = await stack.api.app.get(TokenService).sign({
      aud: "platform_admin",
      sub: admin.id,
      sid: testId("asn", 36),
      ev: true,
      amr: ["pwd", "otp"],
      mfa_at: Math.floor(Date.now() / 1000),
    });
    adminHeaders = { Authorization: `Bearer ${token}`, ...stack.api.bffHeaders(ADMIN_IP) };
  }, JOURNEY_TIMEOUT_MS);

  beforeAll(async () => {
    const cachedTtlMs = await cachedTtl(stack, revoked, otaCacheKeys.apiKey(revoked.prefix));
    const since = performance.now();
    const change = await stack.api.http
      .post(`/v1/tenants/${ota.tenantId}/api-keys/${revoked.id}/revoke`)
      .set(owner.headers);
    revocation = { change, cachedTtlMs, ...(await follow(stack, revoked, "401 INVALID_API_KEY", since)) };
    keptAfterRevocation = await callOtaApi(requireOtaApi(stack), "/v1/storefront", keyHeaders(kept));
  }, CHANGE_TIMEOUT_MS);

  beforeAll(async () => {
    const cachedTtlMs = await cachedTtl(stack, kept, otaCacheKeys.tenant(ota.tenantId));
    const since = performance.now();
    const change = await stack.api.http
      .post(`/v1/admin/tenants/${ota.tenantId}/suspend`)
      .set(adminHeaders)
      .send({ suspensionReason: "admin", reason: SUSPENSION_REASON });
    suspension = { change, cachedTtlMs, ...(await follow(stack, kept, "403 TENANT_SUSPENDED", since)) };
  }, CHANGE_TIMEOUT_MS);

  it("[PBE-036 AC2] a secret key created through createApiKey authenticates getStorefront on the OTA API [PF-30 AC3]", () => {
    for (const key of [revoked, kept]) {
      expectResponseToMatch("createApiKey", key.response, { document: "platform" });
      expect(key.key).toMatch(/^sk_test_[A-Za-z0-9]{40}$/);
      expect(key.key.slice(0, 14)).toBe(key.prefix);
    }
    for (const answer of [acceptedRevoked, acceptedKept]) {
      expect(outcomeOf(answer)).toBe("200");
      expectResponseToMatch("getStorefront", answer);
      expect(answer.body).toMatchObject({ tenantKey: OTA_KEY, name: OTA_NAME, environment: "test" });
    }
    // The answer is the public storefront configuration: it never carries the key.
    expect(JSON.stringify(acceptedKept.body)).not.toContain(kept.key);
    expect(requireOtaApi(stack).exitDescription()).toBeUndefined();
  });

  it("[PBE-036 AC2] the key stops working on the OTA API within one second of revokeApiKey, and the other key keeps working [PF-30 AC3]", () => {
    expect(outcomeOf(revocation.change)).toBe("200");
    expectResponseToMatch("revokeApiKey", revocation.change, { document: "platform" });
    // The OTA had cached the key's row and would have served it past the bound without the invalidation.
    expect(
      revocation.cachedTtlMs,
      "the PTTL of the OTA's apikey:<prefix> entry before revokeApiKey",
    ).toBeGreaterThan(PROPAGATION_BOUND_MS);

    expect(outcomeOf(revocation.last)).toBe("401 INVALID_API_KEY");
    expectResponseToMatch("getStorefront", revocation.last);
    expect(revocation.elapsedMs, "the OTA API still accepted the revoked key after 10 s").toBeDefined();
    expect(revocation.elapsedMs).toBeLessThan(PROPAGATION_BOUND_MS);

    expect(outcomeOf(keptAfterRevocation)).toBe("200");
  });

  it("[PBE-036 AC3] a suspension is visible on the OTA API within one second of adminSuspendTenant [PF-82]", () => {
    expect(outcomeOf(suspension.change)).toBe("202");
    expectResponseToMatch("adminSuspendTenant", suspension.change, { document: "platform" });
    expect(suspension.change.body).toMatchObject({ tenant: { id: ota.tenantId, status: "suspended" } });
    // The OTA had cached the tenant's row (active) and would have served it past the bound without the invalidation.
    expect(
      suspension.cachedTtlMs,
      "the PTTL of the OTA's tenant:<id> entry before adminSuspendTenant",
    ).toBeGreaterThan(PROPAGATION_BOUND_MS);

    expect(outcomeOf(suspension.last)).toBe("403 TENANT_SUSPENDED");
    expectResponseToMatch("getStorefront", suspension.last);
    expect(suspension.elapsedMs, "the OTA API still served the suspended OTA after 10 s").toBeDefined();
    expect(suspension.elapsedMs).toBeLessThan(PROPAGATION_BOUND_MS);
    expect(stack.otaWorker.exitDescription()).toBeUndefined();
    expect(requireOtaApi(stack).exitDescription()).toBeUndefined();
  });
});

describe("[PBE-036] the gate on the OTA API build", () => {
  it("[PBE-036 AC2] fails at once, naming dist/main.js and the build command, when only the OTA worker is built", async () => {
    // An OTA backend folder with dist/worker.js only: startStack({ otaApi: true }) must refuse before it creates a
    // database or starts a process (the services' settings are invalid for the test, as in PBE-035's gate test).
    for (const variable of ["TEST_DATABASE_ADMIN_URL", "REDIS_URL", "SMTP_URL", "MAILPIT_API_URL"]) {
      vi.stubEnv(variable, "not-a-url");
    }
    const dir = mkdtempSync(join(tmpdir(), "velexis-xb-no-ota-api-build-"));
    try {
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, OTA_WORKER_ENTRY), "// not run\n");
      const attempt = startStack({ otaBackendDir: dir, otaApi: true });
      await expect(attempt).rejects.toBeInstanceOf(OtaBuildMissingError);
      await expect(attempt).rejects.toThrow(
        `test:xb runs the built OTA backend, and ${join(dir, OTA_API_ENTRY)} is missing. Build it first: ` +
          "pnpm --filter @velexis/ota-backend build (in CI, test:xb runs after the Build step).",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
