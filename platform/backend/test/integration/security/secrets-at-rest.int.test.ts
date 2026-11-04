// Secrets at rest (PBE-062 step 3; conventions §12 "no card data, passwords, tokens or decrypted secrets are logged,
// queued or persisted outside the allowed ciphertext columns", ADR-0010, ADR-0016, platform architecture §8): the main
// flows of the platform run once through the API (createTestApp) and the worker's module graph (WorkerModule, as
// dist/worker.js builds it, with the API's FakeClock), and then every place a secret could land is scanned:
//
// - every `text`, `character`, `text[]` and `jsonb` column of every table of the `platform` schema (the catalog says
//   which, so a column a later migration adds is scanned too);
// - every log line of the API and the worker, captured at `trace`;
// - every key and value of this file's Redis database: the BullMQ jobs (prefix `vx`: their data, results, errors and
//   options), the idempotent replays, the challenges, the console tokens, the deny markers and the rate-limit counters.
//
// The scan looks for the secret patterns of conventions §12 (`sk_test_`/`sk_live_`/`rk_…` keys, `whsec_` signing
// secrets, `ptk_` console tokens, the single-use tokens of the platform, access tokens, IBAN-shaped strings with a
// valid ISO 13616 checksum, TOTP set-up URLs) and for every secret value the flows made or sent, whatever its shape:
// passwords, TOTP secrets and recovery codes, verification, reset, invitation, MFA challenge and refresh tokens, API
// keys, the OTA's Amadeus client secret, its Stripe keys, the Connect code, state and OAuth tokens, the IBAN and BIC,
// and the configuration's own secrets (the BFF key, the Stripe secrets, the key files of the JWT signing key, the API
// key pepper and the master keys, the passwords of the service URLs). It expects none. The `bytea` ciphertext columns
// (`*_ciphertext`, ADR-0010) are the only allowed place, and only as envelopes: their bytes must not hold a value in
// clear either. The visible parts that the design keeps on purpose (an API key's 14-character prefix, `last4`, a
// publishable key, SHA-256 digests) do not match the patterns.
//
// The flows: a sign-up verified from its e-mail, a sign-in, MFA set up and enabled, a sign-in with MFA and a refresh;
// an OTA created and provisioned (the fake OTA worker of test/support answers `tenant.provisioned`, the worker runs the
// post-steps, which assign a Velexis office and keep the initial keys encrypted) and its initial keys revealed; an API
// key created and rolled; the OTA's own Amadeus credentials verified against the Amadeus stub; Stripe Connect started
// and completed, then the OTA's own Stripe keys verified (FakeStripe in both processes); the payout account set; a
// member invited from the e-mail's link, looked up and accepted; a console token; a password reset from its e-mail.
// The e-mails go through SMTP to Mailpit (shared: every recipient is a `uniqueEmail`), where the tokens are read as a
// person would read them. Every secret is random per run; documentation IBANs, example.com mailboxes only.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import { extractLinks, uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { normaliseRecoveryCode, totpCode } from "../../../src/accounts/mfa.service";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURE_VARIABLES,
  FEATURES,
  featuresFor,
  FeatureSwitches,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { StripeClient } from "../../../src/common/stripe/stripe.client";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  testId,
} from "../../builders/platform-rows";
import { createTestApp, LogSink, TEST_BFF_KEY, type TestApp } from "../../support/app";
import { FakeOtaWorker, schemaNamesFrom } from "../../support/fake-ota-worker";
import { FakeStripe } from "../../support/fake-stripe";

/**
 * The database clone, the API's and the worker's module graphs, the stub, the fake OTA worker and the platform
 * document; the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 90_000;
/** The flows: a dozen e-mails through SMTP, three verifications in the worker, a provisioning; seconds locally. */
const FLOWS_TIMEOUT_MS = 120_000;
/** How long a flow waits for the worker or Mailpit (milliseconds in practice). */
const WAIT = { timeout: 20_000, interval: 25 } as const;
const MAIL_WAIT_MS = 20_000;
/** One TOTP time step: a code is accepted once per account per step, so the flows move the clock between codes. */
const STEP_MS = 30 * 1000;
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.62";
const INVITEE_IP = "198.51.100.62";
/** A zone of the reference data for createTenant; the template of @velexis/testing has none, beforeAll adds it. */
const TIME_ZONE = "Europe/Paris";
/** The Stripe settings of the application: the development values of `.env.example`. */
const STRIPE_ENV = Object.freeze({
  STRIPE_SECRET_KEY: "sk_test_replace_me",
  STRIPE_CONNECT_CLIENT_ID: "ca_replace_me",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_replace_me",
  STRIPE_BILLING_WEBHOOK_SECRET: "whsec_replace_me",
});
/** The one client id the Amadeus stub accepts (not a secret); its secret is random per run. */
const OWN_CLIENT_ID = "fjord-own-amadeus-client";
const OWN_OFFICES = ["OSLN12345", "OSLN12346"] as const;
/** The ISO 13616 documentation IBAN and BIC, as an owner types them. */
const IBAN_TYPED = "GB82 WEST 1234 5698 7654 32";
const IBAN = "GB82WEST12345698765432";
const BIC = "WESTGB2L";

// ---- The scan ------------------------------------------------------------------------------------------------------

/** A place a secret could land, and its text. */
interface Source {
  readonly where: string;
  readonly text: string;
}

/** A secret found: the pattern or the value's kind, and where. */
interface Hit {
  readonly what: string;
  readonly where: string;
}

/** ISO 13616 mod-97 check of a compact IBAN. */
function isIban(candidate: string): boolean {
  const compact = candidate.replace(/ /g, "");
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(compact)) {
    return false;
  }
  const digits = `${compact.slice(4)}${compact.slice(0, 4)}`.replace(/[A-Z]/g, (letter) =>
    String(letter.charCodeAt(0) - 55),
  );
  let remainder = 0;
  for (const digit of digits) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/**
 * The patterns of conventions §12. The token prefixes are the platform's (`vt` verification, `pr` reset, `iv`
 * invitation, `rt` refresh, `mfa` challenge, `ptk` console). An API key's visible prefix is `sk_test_` and 6
 * characters, so only longer runs are secrets. An IBAN counts only outside base64 (its neighbours are no base64
 * characters) and with a valid checksum.
 */
const PATTERNS: ReadonlyArray<{ readonly name: string; readonly find: (text: string) => string[] }> = [
  {
    name: "Stripe or Velexis secret key",
    find: (text) => text.match(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}/g) ?? [],
  },
  { name: "webhook signing secret", find: (text) => text.match(/\bwhsec_[A-Za-z0-9+/=_-]{8,}/g) ?? [] },
  { name: "console token", find: (text) => text.match(/\bptk_[A-Za-z0-9]{20,}/g) ?? [] },
  {
    name: "verification, reset, invitation, refresh or MFA challenge token",
    find: (text) => text.match(/\b(?:vt|pr|iv|rt|mfa)_[A-Za-z0-9_-]{40,}/g) ?? [],
  },
  {
    name: "access token",
    find: (text) => text.match(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g) ?? [],
  },
  { name: "TOTP set-up URL", find: (text) => text.match(/otpauth:\/\//g) ?? [] },
  {
    name: "IBAN",
    find: (text) =>
      (text.match(/(?<![A-Za-z0-9+/])[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}(?![A-Za-z0-9+/=])/g) ?? []).filter(
        isIban,
      ),
  },
];

/** Every secret value of the flows, with its kind. */
const secrets = new Map<string, string>();

/** Remembers a secret value of the flows (and its other spellings) for the scan. */
function remember(kind: string, value: unknown): void {
  if (typeof value !== "string" || value.length < 8) {
    throw new Error(`the flows expected a ${kind}, got ${typeof value}`);
  }
  secrets.set(value, kind);
}

/** The patterns and the secret values found in `sources`, each with its place. */
function scan(sources: readonly Source[]): Hit[] {
  const hits: Hit[] = [];
  for (const { where, text } of sources) {
    for (const pattern of PATTERNS) {
      for (const found of pattern.find(text)) {
        hits.push({ what: `${pattern.name} (${found.slice(0, 12)}…)`, where });
      }
    }
    for (const [value, kind] of secrets) {
      if (text.includes(value)) {
        hits.push({ what: kind, where });
      }
    }
  }
  return hits;
}

// ---- The applications ----------------------------------------------------------------------------------------------

/**
 * The milestone switches of both processes: every one on but `stripe_billing`, so createTenant provisions the OTA at
 * once instead of waiting for a Stripe Checkout (whose card form is Stripe's own page: the platform holds no secret of
 * it, and billing-webhook.int.test.ts and checkout.int.test.ts check its logs).
 */
class FlowSwitches {
  isEnabled(feature: Feature): boolean {
    return feature !== "stripe_billing";
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(
        FEATURES.map((feature) => [FEATURE_VARIABLES[feature], this.isEnabled(feature)]),
      ) as FeatureConfig,
    );
  }
}

const switches = new FlowSwitches();
const stripe = new FakeStripe();
const workerLogs = new LogSink();
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let fake: FakeOtaWorker;
let stub: AmadeusStub;
let ownSecret = "";

/** What the flows did, for the checks. */
const flow = {
  ownerId: "",
  tenantId: "",
  invitationAccepted: false,
  apiKeysIssued: 0,
  ownAmadeus: "",
  connect: "",
  ownStripe: "",
  payoutStatus: "",
  consoleToken: false,
  passwordReset: 0,
};

/** The scanned places, read after the flows. */
let rowSources: Source[] = [];
let ciphertextSources: Source[] = [];
let logSources: Source[] = [];
let redisSources: Source[] = [];

beforeAll(async () => {
  // The expensive set-up, once: the stub (its specifications), the clone, both module graphs, the fake OTA worker and
  // the platform document of expectResponseToMatch.
  ownSecret = `own-${randomBytes(18).toString("hex")}`;
  remember("Amadeus client secret", ownSecret);
  stub = await startAmadeusStub({ credentials: { clientId: OWN_CLIENT_ID, clientSecret: ownSecret } });
  t = await createTestApp({
    env: {
      LOG_LEVEL: "trace",
      AMADEUS_BASE_URL_TEST: stub.url,
      AMADEUS_BASE_URL_LIVE: stub.url,
      OPS_ALERT_EMAIL: uniqueEmail("sar-ops"),
      ...STRIPE_ENV,
    },
    overrides: [
      { provide: FeatureSwitches, useValue: switches },
      { provide: StripeClient, useValue: stripe },
    ],
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  responseChecker("platform");
  // The configuration's secrets (development values) must not land anywhere either.
  remember("BFF key", TEST_BFF_KEY);
  for (const [name, value] of Object.entries(STRIPE_ENV)) {
    if (name !== "STRIPE_CONNECT_CLIENT_ID") {
      remember("Stripe secret of the configuration", value);
    }
  }
  // So must the key files the application read (the JWT signing key's base64 body, the API key pepper, every master
  // key; made for this run by test/support) and the passwords of the service URLs, when they have one.
  const masterKeys = readdirSync(t.config.MASTER_KEY_DIR)
    .filter((file) => /^master-v\d+\.key$/.test(file))
    .map((file) => join(t.config.MASTER_KEY_DIR, file));
  expect(masterKeys.length, "the master key files of the configuration").toBeGreaterThan(0);
  for (const file of [t.config.JWT_PRIVATE_KEY_FILE, t.config.API_KEY_PEPPER_FILE, ...masterKeys]) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length > 0 && !line.startsWith("-----")) {
        remember("key file of the configuration", line.trim());
      }
    }
  }
  for (const url of [t.config.DATABASE_URL, t.config.REDIS_URL, t.config.SMTP_URL]) {
    const password = decodeURIComponent(new URL(url).password);
    if (password.length >= 8) {
      remember("service password of the configuration", password);
    }
  }

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .overrideProvider(StripeClient)
    .useValue(stripe)
    .overrideProvider(FeatureSwitches)
    .useValue(switches)
    .compile();
  await worker.init();
  fake = await FakeOtaWorker.start({
    redisUrl: t.redis.url,
    schemaNameOf: schemaNamesFrom(pool),
    now: () => t.clock.now(),
  });

  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ($1, 'FR', 60, 120) ON CONFLICT DO NOTHING",
    [TIME_ZONE],
  );
  // The Velexis test account and one free office of the pool, which provisioning assigns.
  const velexis = await insertAmadeusAccount(pool, { id: testId("ama", 62_000), base_url: stub.url });
  await insertAmadeusOffice(pool, velexis, { id: testId("amo", 62_000), office_id: "PARFR6200" });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fake?.close();
  await worker?.close();
  await t?.close();
  await stub?.stop();
}, SETUP_TIMEOUT_MS);

// ---- The flows -----------------------------------------------------------------------------------------------------

/** The token of a message's link to `path` (`/verify-email`, `/reset-password`, `/invitations/accept`). */
function tokenOfLink(message: Parameters<typeof extractLinks>[0], path: string): string {
  const link = extractLinks(message).find((url) => new URL(url).pathname === path);
  const token = link === undefined ? null : new URL(link).searchParams.get("token");
  if (token === null) {
    throw new Error(`no ${path} link in the message`);
  }
  return token;
}

function expectStatus(res: Response, status: number, what: string): void {
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(status);
}

/** Waits (in a hook: `vi.waitFor`) until `read` answers `expected`; the last answer names what was waited for. */
async function until(what: string, read: () => Promise<unknown>, expected: unknown): Promise<void> {
  await vi.waitFor(async () => {
    const value = await read();
    if (value !== expected) {
      throw new Error(`${what} is ${String(value)}, not ${String(expected)} yet`);
    }
  }, WAIT);
}

/** The status of a credential submission, read until it is `applied` (the worker's verification). */
async function waitForApplied(submissionId: string): Promise<string> {
  await until(
    `the submission ${submissionId}`,
    async () => {
      const { rows } = await pool.query("SELECT status FROM platform.credential_submissions WHERE id = $1", [
        submissionId,
      ]);
      return (rows[0] as { status?: string } | undefined)?.status;
    },
    "applied",
  );
  return "applied";
}

/** Every e-mail of the outbox has been sent (or given up), so its secret data was purged. */
async function waitForOutbox(): Promise<void> {
  await until(
    "the open e-mails of the outbox",
    async () => {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS open FROM platform.email_outbox WHERE status NOT IN ('sent', 'failed')",
      );
      return (rows[0] as { open: number }).open;
    },
    0,
  );
}

beforeAll(async () => {
  const bff = (ip = PERSON_IP): Record<string, string> => t.bffHeaders(ip);
  const ownerEmail = uniqueEmail("sar-owner");
  const password = `Fjord-${randomBytes(12).toString("base64url")}-Pass`;
  remember("password", password);

  // Sign-up, verified from the e-mail's link.
  expectStatus(
    await t.http.post("/v1/auth/sign-up").set(bff()).send({
      email: ownerEmail,
      password,
      fullName: "Solveig Hansen",
      acceptTerms: true,
      termsVersion: "2026-10-01",
    }),
    202,
    "signUp",
  );
  const verifyMail = await waitForMessage({
    to: ownerEmail,
    subject: /Confirm your e-mail/,
    timeoutMs: MAIL_WAIT_MS,
  });
  const verifyToken = tokenOfLink(verifyMail, "/verify-email");
  remember("verification token", verifyToken);
  expectStatus(
    await t.http.post("/v1/auth/verify-email").set(bff()).send({ token: verifyToken }),
    200,
    "verifyEmail",
  );

  // Sign-in with the password.
  const first = await t.http.post("/v1/auth/sign-in").set(bff()).send({ email: ownerEmail, password });
  expectStatus(first, 200, "signIn");
  const firstSession = first.body as { accessToken: string; refreshToken: string; account: { id: string } };
  remember("access token", firstSession.accessToken);
  remember("refresh token", firstSession.refreshToken);
  flow.ownerId = firstSession.account.id;
  const signedIn = { ...bff(), Authorization: `Bearer ${firstSession.accessToken}` };

  // MFA: set up, enabled with a code, ten recovery codes shown once.
  const setUp = await t.http.post("/v1/me/mfa/setup").set(signedIn).send();
  expectStatus(setUp, 200, "startMfaSetup");
  const { secret, otpauthUrl } = setUp.body as { secret: string; otpauthUrl: string };
  remember("TOTP secret", secret);
  remember("TOTP set-up URL", otpauthUrl);
  const enabled = await t.http
    .post("/v1/me/mfa/enable")
    .set(signedIn)
    .send({ code: totpCode(secret, t.clock.now()) });
  expectStatus(enabled, 200, "enableMfa");
  for (const code of (enabled.body as { recoveryCodes: string[] }).recoveryCodes) {
    remember("recovery code", code);
    remember("recovery code", normaliseRecoveryCode(code) ?? code);
  }

  // Sign-in with MFA (the next time step), then a refresh of the session.
  t.clock.advance(STEP_MS);
  const challenge = await t.http.post("/v1/auth/sign-in").set(bff()).send({ email: ownerEmail, password });
  expectStatus(challenge, 200, "signIn (MFA)");
  const { mfaChallengeToken } = challenge.body as { mfaChallengeToken: string };
  remember("MFA challenge token", mfaChallengeToken);
  const verified = await t.http
    .post("/v1/auth/mfa/verify")
    .set(bff())
    .send({ mfaChallengeToken, code: totpCode(secret, t.clock.now()) });
  expectStatus(verified, 200, "verifyMfa");
  const mfaSession = verified.body as { accessToken: string; refreshToken: string };
  remember("access token", mfaSession.accessToken);
  remember("refresh token", mfaSession.refreshToken);
  const refreshed = await t.http
    .post("/v1/auth/refresh")
    .set(bff())
    .send({ refreshToken: mfaSession.refreshToken });
  expectStatus(refreshed, 200, "refreshSession");
  const session = refreshed.body as { accessToken: string; refreshToken: string };
  remember("access token", session.accessToken);
  remember("refresh token", session.refreshToken);
  // The refreshed token keeps the family's step-up: the sensitive actions below are within its 15 minutes.
  const owner = { ...bff(), Authorization: `Bearer ${session.accessToken}` };

  // An OTA, provisioned through the fake OTA worker and the worker's post-steps; its initial keys revealed once.
  const created = await t.http.post("/v1/tenants").set(owner).set("Idempotency-Key", randomUUID()).send({
    key: "fjordsecure",
    name: "Fjord Secure Travel",
    countryCode: "FR",
    defaultCurrency: "EUR",
    timeZone: TIME_ZONE,
  });
  expectStatus(created, 202, "createTenant");
  const { tenant, provisioningJob } = created.body as {
    tenant: { id: string };
    provisioningJob: { id: string };
  };
  flow.tenantId = tenant.id;
  await until(
    "the provisioning job",
    async () => {
      const { rows } = await pool.query("SELECT status, step FROM platform.provisioning_jobs WHERE id = $1", [
        provisioningJob.id,
      ]);
      const job = rows[0] as { status: string; step: string | null };
      return `${job.status}/${job.step ?? ""}`;
    },
    "succeeded/notify",
  );
  const base = `/v1/tenants/${tenant.id}`;
  const revealed = await t.http.post(`${base}/initial-keys/reveal`).set(owner).send();
  expectStatus(revealed, 200, "revealInitialKeys");
  for (const key of (revealed.body as { keys: Array<{ key: string; kind: string }> }).keys) {
    if (key.kind === "secret") {
      remember("initial secret API key", key.key);
    }
    flow.apiKeysIssued += 1;
  }

  // An API key, created and rolled.
  const apiKey = await t.http
    .post(`${base}/api-keys`)
    .set(owner)
    .send({ name: "Back office sync", kind: "secret", environment: "test" });
  expectStatus(apiKey, 201, "createApiKey");
  const createdKey = apiKey.body as { apiKey: { id: string }; key: string };
  remember("secret API key", createdKey.key);
  const rolled = await t.http
    .post(`${base}/api-keys/${createdKey.apiKey.id}/roll`)
    .set(owner)
    .send({ expireOldIn: "now" });
  expectStatus(rolled, 201, "rollApiKey");
  remember("secret API key", (rolled.body as { key: string }).key);
  flow.apiKeysIssued += 2;

  // The OTA's own Amadeus credentials, verified by the worker against the stub.
  const ownAmadeus = await t.http
    .put(`${base}/amadeus-connections/test/credentials`)
    .set(owner)
    .send({
      clientId: OWN_CLIENT_ID,
      clientSecret: ownSecret,
      officeIds: [...OWN_OFFICES],
      defaultOfficeId: OWN_OFFICES[0],
      ownerOfficeId: OWN_OFFICES[1],
    });
  expectStatus(ownAmadeus, 202, "submitAmadeusCredentials");
  flow.ownAmadeus = await waitForApplied((ownAmadeus.body as { submission: { id: string } }).submission.id);

  // Stripe Connect: started (the state of the authorize URL), completed with the code Stripe sends back.
  const started = await t.http.post(`${base}/payment-connections/stripe-connect/start`).set(owner).send();
  expectStatus(started, 200, "startStripeConnect");
  const state =
    new URL((started.body as { authorizeUrl: string }).authorizeUrl).searchParams.get("state") ?? "";
  remember("Connect state", state);
  const code = `ac_${randomBytes(12).toString("hex")}`;
  remember("Connect code", code);
  const connectAccount = "acct_1QSecretsAtRest62";
  const grant = stripe.grantConnectCode(code, { stripeUserId: connectAccount, livemode: false });
  remember("Connect access token", grant.accessToken);
  remember("Connect refresh token", grant.refreshToken);
  stripe.put({
    id: connectAccount,
    object: "account",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
  } as never);
  const completed = await t.http
    .post("/v1/payment-connections/stripe-connect/callback")
    .set(owner)
    .send({ state, code });
  expectStatus(completed, 200, "completeStripeConnect");
  flow.connect = "connected";

  // The OTA's own Stripe keys, verified by the worker (GET /v1/account with the key).
  const keys = {
    publishableKey: `pk_test_${randomBytes(12).toString("hex")}`,
    secretKey: `sk_test_${randomBytes(18).toString("hex")}`,
    webhookSecret: `whsec_${randomBytes(18).toString("hex")}`,
  };
  remember("Stripe secret key", keys.secretKey);
  remember("Stripe webhook secret", keys.webhookSecret);
  stripe.grantOwnKey(keys.secretKey, { accountId: "acct_1QSecretsAtRestKeys62" });
  const ownStripe = await t.http.put(`${base}/payment-connections/test/api-keys`).set(owner).send(keys);
  expectStatus(ownStripe, 202, "submitStripeApiKeys");
  flow.ownStripe = await waitForApplied((ownStripe.body as { submission: { id: string } }).submission.id);

  // The payout account.
  for (const spelling of [IBAN, IBAN_TYPED, IBAN_TYPED.toLowerCase()]) {
    remember("IBAN", spelling);
  }
  remember("BIC", BIC);
  remember("BIC", BIC.toLowerCase());
  const payout = await t.http.put(`${base}/payout-account`).set(owner).send({
    accountHolderName: "Fjord Secure Travel SAS",
    countryCode: "GB",
    currency: "GBP",
    scheme: "iban",
    iban: IBAN_TYPED.toLowerCase(),
    bic: BIC.toLowerCase(),
  });
  expect([200, 201], `setPayoutAccount: ${JSON.stringify(payout.body)}`).toContain(payout.status);
  flow.payoutStatus = (payout.body as { status: string }).status;

  // An invitation, accepted from the e-mail's link by the person it names.
  const inviteeEmail = uniqueEmail("sar-invitee");
  expectStatus(
    await t.http.post(`${base}/invitations`).set(owner).send({ email: inviteeEmail, role: "agent" }),
    201,
    "createInvitation",
  );
  const invitation = await waitForMessage({
    to: inviteeEmail,
    subject: /invited you/,
    timeoutMs: MAIL_WAIT_MS,
  });
  const invitationToken = tokenOfLink(invitation, "/invitations/accept");
  remember("invitation token", invitationToken);
  expectStatus(
    await t.http.post("/v1/invitations/lookup").set(bff(INVITEE_IP)).send({ token: invitationToken }),
    200,
    "lookupInvitation",
  );
  const invitee = await insertAccount(pool, { email: inviteeEmail });
  const { token: inviteeToken } = await t.app.get(TokenService).sign({
    aud: "portal",
    sub: invitee.id,
    sid: testId("asn", 62_001),
    ev: true,
    amr: ["pwd"],
  });
  remember("access token", inviteeToken);
  const accepted = await t.http
    .post("/v1/invitations/accept")
    .set({ ...bff(INVITEE_IP), Authorization: `Bearer ${inviteeToken}` })
    .send({ token: invitationToken });
  expectStatus(accepted, 200, "acceptInvitation");
  flow.invitationAccepted = true;

  // A console token for the OTA admin.
  const consoleToken = await t.http.post(`${base}/console-token`).set(owner).send();
  expectStatus(consoleToken, 201, "createConsoleToken");
  remember("console token", (consoleToken.body as { portalToken: string }).portalToken);
  flow.consoleToken = true;

  // A password reset from the e-mail's link.
  expectStatus(
    await t.http.post("/v1/auth/password-reset").set(bff()).send({ email: ownerEmail }),
    202,
    "requestPasswordReset",
  );
  const resetMail = await waitForMessage({
    to: ownerEmail,
    subject: /Reset your Velexis password/,
    timeoutMs: MAIL_WAIT_MS,
  });
  const resetToken = tokenOfLink(resetMail, "/reset-password");
  remember("reset token", resetToken);
  const newPassword = `Fjord-${randomBytes(12).toString("base64url")}-New`;
  remember("password", newPassword);
  const reset = await t.http
    .post("/v1/auth/password-reset/confirm")
    .set(bff())
    .send({ token: resetToken, newPassword });
  expectStatus(reset, 204, "confirmPasswordReset");
  flow.passwordReset += 1;

  // Every e-mail sent, so the outbox kept no secret data; then everything is read for the scan.
  await waitForOutbox();
  rowSources = await textColumns();
  ciphertextSources = await ciphertextColumns();
  logSources = [
    ...t.logs.lines.map((line, index) => ({ where: `API log line ${index}`, text: JSON.stringify(line) })),
    ...workerLogs.lines.map((line, index) => ({
      where: `worker log line ${index}`,
      text: JSON.stringify(line),
    })),
  ];
  redisSources = await redisValues();
}, FLOWS_TIMEOUT_MS);

/**
 * The columns of the platform schema whose type is one of `types` (`udt_name`), from the catalog, with their names
 * quoted by PostgreSQL (`quote_ident`): the scan's queries never splice a raw identifier into SQL.
 */
async function columnsOfTypes(
  types: readonly string[],
): Promise<Array<{ readonly where: string; readonly table: string; readonly column: string }>> {
  const { rows } = await pool.query(
    "SELECT table_name, column_name, quote_ident(table_name) AS table_ident, " +
      "quote_ident(column_name) AS column_ident FROM information_schema.columns " +
      "WHERE table_schema = 'platform' AND udt_name = ANY($1::text[]) ORDER BY table_name, ordinal_position",
    [types],
  );
  return (
    rows as Array<{ table_name: string; column_name: string; table_ident: string; column_ident: string }>
  ).map((row) => ({
    where: `platform.${row.table_name}.${row.column_name}`,
    table: row.table_ident,
    column: row.column_ident,
  }));
}

/** Every value of every text, character, text[] and jsonb column of the platform schema, from the catalog. */
async function textColumns(): Promise<Source[]> {
  const sources: Source[] = [];
  for (const { where, table, column } of await columnsOfTypes([
    "text",
    "bpchar",
    "varchar",
    "_text",
    "jsonb",
    "json",
  ])) {
    const { rows } = await pool.query(
      `SELECT ${column}::text AS value FROM platform.${table} WHERE ${column} IS NOT NULL`,
    );
    for (const { value } of rows as Array<{ value: string }>) {
      sources.push({ where, text: value });
    }
  }
  return sources;
}

/** Every value of every bytea column (the ciphertext columns of ADR-0010), as latin1 text for the value scan. */
async function ciphertextColumns(): Promise<Source[]> {
  const sources: Source[] = [];
  for (const { where, table, column } of await columnsOfTypes(["bytea"])) {
    const { rows } = await pool.query(
      `SELECT ${column} AS value FROM platform.${table} WHERE ${column} IS NOT NULL`,
    );
    for (const { value } of rows as Array<{ value: Buffer }>) {
      sources.push({ where, text: value.toString("latin1") });
    }
  }
  return sources;
}

/** Every key and value of this file's Redis database: strings, hashes (the BullMQ jobs), lists, sets, sorted sets. */
async function redisValues(): Promise<Source[]> {
  const redis = t.redis.client;
  const sources: Source[] = [];
  for (const key of await redis.keys("*")) {
    const type = await redis.type(key);
    let text = key;
    if (type === "string") {
      text += `\n${(await redis.get(key)) ?? ""}`;
    } else if (type === "hash") {
      text += `\n${JSON.stringify(await redis.hgetall(key))}`;
    } else if (type === "list") {
      text += `\n${(await redis.lrange(key, 0, -1)).join("\n")}`;
    } else if (type === "set") {
      text += `\n${(await redis.smembers(key)).join("\n")}`;
    } else if (type === "zset") {
      text += `\n${(await redis.zrange(key, 0, -1)).join("\n")}`;
    } else if (type === "stream") {
      text += `\n${JSON.stringify(await redis.xrange(key, "-", "+"))}`;
    }
    sources.push({ where: `redis ${key}`, text });
  }
  return sources;
}

// ---- Tests ---------------------------------------------------------------------------------------------------------

describe("secrets at rest after the main flows", () => {
  it("[PBE-062 AC2] ran the main flows: sign-up, MFA, keys, own credentials, Connect, payout account, invitations", async () => {
    const { rows } = await pool.query(
      "SELECT status, mfa_enabled, email_verified_at IS NOT NULL AS verified, mfa_secret_ciphertext IS NOT NULL AS sealed " +
        "FROM platform.accounts WHERE id = $1",
      [flow.ownerId],
    );
    expect(rows[0]).toEqual({ status: "active", mfa_enabled: true, verified: true, sealed: true });
    const { rows: tenants } = await pool.query("SELECT status FROM platform.tenants WHERE id = $1", [
      flow.tenantId,
    ]);
    expect(tenants[0]).toEqual({ status: "active" });
    expect(flow).toMatchObject({
      invitationAccepted: true,
      apiKeysIssued: 4,
      ownAmadeus: "applied",
      connect: "connected",
      ownStripe: "applied",
      payoutStatus: "pending_review",
      consoleToken: true,
      passwordReset: 1,
    });
    // The secrets the scan looks for: every kind the flows made. The service passwords are looked for when the URLs
    // have one (CI's Redis has none), so they are not counted here.
    const kinds = [...secrets.values()].filter((kind) => kind !== "service password of the configuration");
    expect(new Set(kinds)).toEqual(
      new Set([
        "Amadeus client secret",
        "BFF key",
        "Stripe secret of the configuration",
        "key file of the configuration",
        "password",
        "verification token",
        "access token",
        "refresh token",
        "TOTP secret",
        "TOTP set-up URL",
        "recovery code",
        "MFA challenge token",
        "initial secret API key",
        "secret API key",
        "Connect state",
        "Connect code",
        "Connect access token",
        "Connect refresh token",
        "Stripe secret key",
        "Stripe webhook secret",
        "IBAN",
        "BIC",
        "invitation token",
        "console token",
        "reset token",
      ]),
    );
  });

  it("[PBE-062 AC2] finds no secret in any text or jsonb column of the platform schema", () => {
    expect(rowSources.length).toBeGreaterThan(100);
    // The tables the flows wrote are among the scanned ones.
    for (const table of [
      "accounts",
      "platform_audit_log",
      "email_outbox",
      "credential_submissions",
      "api_keys",
    ]) {
      expect(
        rowSources.some((source) => source.where.startsWith(`platform.${table}.`)),
        table,
      ).toBe(true);
    }
    expect(scan(rowSources)).toEqual([]);
  });

  it("[PBE-062 AC2] finds no secret in any log line of the API or the worker, at trace", () => {
    expect(logSources.length).toBeGreaterThan(50);
    expect(scan(logSources)).toEqual([]);
  });

  it("[PBE-062 AC2] finds no secret in Redis, the BullMQ job data included", () => {
    // The jobs of the flows are there with their data: the e-mails, the verifications and the provisioning.
    const jobs = redisSources.filter(
      (source) => source.where.startsWith("redis vx:") && source.text.includes('"data":'),
    );
    for (const queue of [
      "platform-emails",
      "platform-connections",
      "platform-tenant-events",
      "ota-tenant-ops",
    ]) {
      expect(
        jobs.some((source) => source.where.startsWith(`redis vx:${queue}:`)),
        queue,
      ).toBe(true);
    }
    // The idempotent replay of createTenant is kept too, and scanned with the rest.
    expect(redisSources.some((source) => source.where.startsWith("redis vx:idem:"))).toBe(true);
    expect(scan(redisSources)).toEqual([]);
  });

  it("[PBE-062 AC2] keeps the secrets in the ciphertext columns only as envelopes: no value in clear in a bytea column", () => {
    const places = new Set(ciphertextSources.map((source) => source.where));
    for (const column of [
      "platform.accounts.mfa_secret_ciphertext",
      "platform.supplier_connections.client_secret_ciphertext",
      "platform.payment_provider_connections.secret_ciphertext",
      "platform.payment_provider_connections.webhook_secret_ciphertext",
      "platform.tenant_payout_accounts.bank_details_ciphertext",
    ]) {
      expect(places, column).toContain(column);
    }
    const inClear = [...secrets.keys()].flatMap((value) =>
      ciphertextSources.filter((source) => source.text.includes(value)).map((source) => source.where),
    );
    expect(inClear).toEqual([]);
  });

  it("[PBE-062 AC2] the scan finds each pattern it looks for in a planted text", () => {
    // Made-up values of each shape (no real key or account): the scan must see every one of them.
    const planted = [
      `sk_test_${"A1b2C3d4".repeat(3)}`,
      `rk_live_${"Z9y8X7w6".repeat(3)}`,
      "whsec_Planted0Secret0Value",
      `ptk_${"Q".repeat(43)}`,
      `iv_${"x".repeat(43)}`,
      "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhY2NfMDEifQ.c2lnbmF0dXJlLXBsYW50ZWQ",
      "otpauth://totp/Velexis:planted",
      '"iban":"NO9386011117947"',
    ].join("\n");
    const found = scan([{ where: "planted", text: planted }]).map((hit) => hit.what.split(" (")[0]);

    expect(new Set(found)).toEqual(new Set(PATTERNS.map((pattern) => pattern.name)));
    // The visible parts the design keeps are no secrets: a key's prefix, a publishable key, a masked IBAN.
    expect(
      scan([
        {
          where: "kept",
          text: '{"prefix":"sk_test_AbC123","publishableKey":"pk_test_123abc","last4":"5432"}',
        },
      ]),
    ).toEqual([]);
  });
});

describe("what the owner reads back", () => {
  it("[PBE-062 AC2] answers the payout account masked, as the document describes it: the account's digits never leave the API", async () => {
    // The flows' answers are checked by the tests of their operations; this one reads the bank account back as the
    // portal does, after the flows, from the OTA the flows made for the owner.
    const { rows } = await pool.query(
      "SELECT role FROM platform.tenant_memberships WHERE tenant_id = $1 AND account_id = $2",
      [flow.tenantId, flow.ownerId],
    );
    expect(rows).toEqual([{ role: "owner" }]);
    const { token } = await t.app.get(TokenService).sign({
      aud: "portal",
      sub: flow.ownerId,
      sid: testId("asn", 62_002),
      ev: true,
      amr: ["pwd"],
    });
    const res = await t.http
      .get(`/v1/tenants/${flow.tenantId}/payout-account`)
      .set({ ...t.bffHeaders(PERSON_IP), Authorization: `Bearer ${token}` });
    expectResponseToMatch("getPayoutAccount", res, { document: "platform" });
    expect(JSON.stringify(res.body)).not.toContain(IBAN.slice(4, -4));
  });
});
