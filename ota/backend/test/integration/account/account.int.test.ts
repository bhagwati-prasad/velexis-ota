// account.get, account.update and account.delete through the API's whole pipeline, with the worker sending the
// verification e-mail of an address change to Mailpit (OBE-035; the document's getAccount, updateAccount and
// deleteAccount, db README §7, flows/my-bookings-and-guest-lookup.md §3 step 9), against PostgreSQL 16, Redis 7 and
// Mailpit, in both modes: the hosted storefront's edge (cookies, CSRF) and key callers (bearer tokens).
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned), writes the platform rows of
// two active tenants with a secret key each as the platform does, seeds their storefront settings as provisioning does,
// inserts customers with Argon2id password identities, and starts both processes in-process: the API (createTestApp)
// and the worker (WorkerModule.forRoot, whose ota-notifications consumer sends the outbox's e-mails through Mailpit's
// SMTP port). The schedulers the worker registers are removed: no background job touches the bookings this file seeds,
// and the `notify` job that follows each commit is what sends. `ota-payments` is paused: the `payment.void` jobs a
// deletion queues are read from the queue and never run (there is no Stripe here). Every client calls from IP
// addresses of its own and every customer has an address of its own (`uniqueEmail`), so the limits of architecture §8
// and the sign-in lockout never mix the scenarios, and every e-mail is found by its recipient. Scenarios that sign
// in, wait for Mailpit or hash passwords run in their `beforeAll` hook with a budget of their own; the tests only read
// what they left. Passwords are made up per run; no value is a secret.
import { randomBytes, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { hashApiKey } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
  type TenantSchema,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import {
  extractLinks,
  mailpit,
  uniqueEmail,
  waitForMessage,
  type MailpitMessage,
} from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDeadlock } from "../../../src/account/account.service";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { APP_DIR, loadWorkerConfig } from "../../../src/config";
import { hashCustomerPassword } from "../../../src/identity/sign-in.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import {
  edgeHeaders,
  newApiKey,
  newCsrfToken,
  testApiCredentials,
  testWorkerVariables,
} from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/**
 * Cloning the template, hashing the test password with Argon2id (19 MiB), starting the API's graph (it parses the OTA
 * document and compiles its validators) and the worker's (BullMQ connections, the scheduler registration): a few
 * seconds alone, more while every package's integration tests run on a 4-CPU CI runner. The bound only stops a
 * start-up that hangs.
 */
const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/**
 * A scenario signs in a few times, verifies a password or six (Argon2id) and may wait for the worker to send an e-mail
 * through Mailpit: about a second locally; the bound allows for CI load and only stops a scenario that hangs.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for one e-mail. */
const MAIL_WAIT_MS = 20_000;
/** The subjects of the account e-mails of FIX-W29-OTA (OADR-0013 item 4 as revised on 2026-10-24). */
const EMAIL_CHANGED_SUBJECT = /account is being changed$/;
const ACCOUNT_DELETED_SUBJECT = /account has been deleted$/;

const ALPHA_HOST = "alpha.ota.example.com";
const BETA_HOST = "beta.ota.example.com";
const TERMS_VERSION = "2026-09-01";
const PRIVACY_VERSION = "2026-08-15";
type Schema = "tenant_alpha" | "tenant_beta";

/** The password of every inserted customer, made up for this run, and its Argon2id hash (made once, below). */
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;
const WRONG = `${PASSWORD}-wrong`;
let passwordHash = "";

const quietPoolLogger = { error: (): void => undefined };

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let worker: INestApplicationContext;
const workerSink = new MemorySink();
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaKey: string;
/** A secret live key of tenant_alpha (its storefront stays in test): requests in the live environment. */
let alphaLiveKey: string;
let betaKey: string;
/** `ota-payments`, paused for the whole file: the `payment.void` jobs a deletion queues stay there (no Stripe here). */
let paymentsQueue: Queue;
/** The priced offer every seeded checkout of tenant_alpha was opened with. */
let alphaPricedOfferId = "";
/** Every password and token this file used: none may reach a log line. */
const secrets: string[] = [PASSWORD, WRONG];

/** The development SMTP_URL (Mailpit) of the environment. */
function mailpitSmtpUrl(): string {
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig({ SMTP_URL: env.url({ protocols: ["smtp:"] }) }).SMTP_URL;
}

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one client. */
const newIp = (): string => {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
};

function inTenant<T>(schema: Schema, fn: (trx: TenantTransaction) => Promise<T>): Promise<T> {
  return tenantTx(tenantDb, schema as TenantSchema, fn);
}

/** Inserts a secret key of `environment` for `tenantId`, as the platform does; the key. */
async function issueKey(tenantId: string, environment: "test" | "live"): Promise<string> {
  const apiKey = newApiKey("sk", environment);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: `Server (${environment})`,
      kind: "secret",
      environment,
      prefix: apiKey.slice(0, 14),
      key_hash: hashApiKey(apiKey, testApiCredentials().pepper),
      last4: apiKey.slice(-4),
    })
    .execute();
  return apiKey;
}

/** Inserts an active tenant of a provisioned test schema and a secret test key of it, as the platform does. */
async function insertTenant(
  key: "alpha" | "beta",
): Promise<{ readonly tenantId: string; readonly testKey: string }> {
  const tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id: tenantId, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  return { tenantId, testKey: await issueKey(tenantId, "test") };
}

/** Inserts an active customer with a password identity (PASSWORD) for `email` into `schema`; its id. */
async function insertCustomer(schema: Schema, email: string): Promise<string> {
  const id = newId("cus");
  await inTenant(schema, async (trx) => {
    await trx
      .insertInto("customers")
      .values({
        id,
        email,
        status: "active",
        first_name: "Anna",
        last_name: "Berg",
        email_verified_at: new Date(),
        marketing_consent: false,
      })
      .execute();
    await trx
      .insertInto("customer_identities")
      .values({
        id: newId("cid"),
        customer_id: id,
        provider: "password",
        provider_subject: email.toLowerCase(),
        password_hash: passwordHash,
        email,
        email_verified_at: new Date(),
      })
      .execute();
  });
  return id;
}

/** What a seeded booking looks like. */
interface BookingSeed {
  readonly customerId: string;
  readonly status: "pending" | "confirmed" | "ticketed" | "cancelled" | "failed";
  readonly ticketingStatus?: string;
  readonly environment?: "test" | "live";
  /** Seconds before now the booking was made (the order of `details.bookingIds`). */
  readonly ageSeconds: number;
  /** A payment of the booking in this state. */
  readonly payment?: "authorized" | "captured";
  /** A refund of that (captured) payment in this state. */
  readonly refund?: "pending" | "succeeded";
  /** The checkout the booking was claimed for (`bookings.checkout_id`). */
  readonly checkoutId?: string;
}

/** Inserts a booking of tenant_alpha (with its payment and refund) as the orchestrator leaves one; its id. */
async function insertBooking(seed: BookingSeed): Promise<string> {
  const id = newId("bkg");
  const now = Date.now();
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  const departure = new Date(now + 30 * 86_400_000);
  const decided = seed.status !== "pending" && seed.status !== "failed";
  await inTenant("tenant_alpha", async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: seed.environment ?? "test",
        reference: newBookingReference(),
        customer_id: seed.customerId,
        checkout_id: seed.checkoutId ?? null,
        status: seed.status,
        ticketing_status:
          seed.ticketingStatus ??
          (seed.status === "ticketed" ? "issued" : seed.status === "failed" ? "not_applicable" : "pending"),
        amadeus_order_id: decided ? `ORDER-${id.slice(-10)}` : null,
        record_locator: decided ? randomBytes(3).toString("hex").toUpperCase() : null,
        origin_system_code: "GDS",
        owner_office_id: office,
        queuing_office_id: office,
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 2 * 3_600_000),
        travelers_count: 1,
        currency: "EUR",
        net_amount: "98.47",
        net_base_amount: "56.00",
        net_fees_amount: "0.00",
        markup_amount: "12.00",
        taxes_amount: "42.47",
        total_amount: "110.47",
        contact_email: "contact-1@example.com",
        lead_last_name: "SAMPLE",
        create_order_started_at: seed.status === "pending" ? new Date(now) : null,
        cancelled_at: seed.status === "cancelled" ? new Date(now) : null,
        cancelled_by: seed.status === "cancelled" ? "customer" : null,
        order_snapshot: JSON.stringify({}),
        created_at: new Date(now - seed.ageSeconds * 1000),
      })
      .execute();
    if (seed.payment === undefined) {
      return;
    }
    const paymentId = newId("pay");
    const captured = seed.payment === "captured";
    await trx
      .insertInto("payments")
      .values({
        id: paymentId,
        environment: seed.environment ?? "test",
        booking_id: id,
        customer_id: seed.customerId,
        provider: "stripe",
        provider_payment_id: `pi_${randomBytes(12).toString("hex")}`,
        currency: "EUR",
        amount: "110.47",
        amount_authorized: "110.47",
        amount_captured: captured ? "110.47" : "0",
        amount_refunded: seed.refund === "succeeded" ? "50.00" : "0",
        status: captured ? (seed.refund === "succeeded" ? "partially_refunded" : "captured") : "authorized",
        authorized_at: new Date(now),
        captured_at: captured ? new Date(now) : null,
      })
      .execute();
    if (seed.refund !== undefined) {
      await trx
        .insertInto("refunds")
        .values({
          id: newId("rfd"),
          payment_id: paymentId,
          booking_id: id,
          currency: "EUR",
          amount: "50.00",
          reason: "booking_cancelled",
          status: seed.refund,
          requested_by_type: "customer",
          requested_by_id: seed.customerId,
        })
        .execute();
    }
  });
  return id;
}

/** Inserts the search, offer and priced offer the seeded checkouts of tenant_alpha are opened with; its `prc_` id. */
async function insertPricedOffer(): Promise<string> {
  const searchId = newId("srch");
  const offerId = newId("off");
  const pricedOfferId = newId("prc");
  const expires = new Date(Date.now() + 3_600_000);
  await inTenant("tenant_alpha", async (trx) => {
    await trx
      .insertInto("flight_searches")
      .values({
        id: searchId,
        environment: "test",
        criteria: JSON.stringify({
          mode: "simple",
          originLocationCode: "MAD",
          destinationLocationCode: "ORY",
        }),
        amadeus_request: JSON.stringify({ originLocationCode: "MAD", destinationLocationCode: "ORY" }),
        status: "completed",
        result_count: 1,
        expires_at: expires,
      })
      .execute();
    await trx
      .insertInto("flight_offers")
      .values({
        id: offerId,
        environment: "test",
        search_id: searchId,
        amadeus_offer_id: "1",
        payload: JSON.stringify({ type: "flight-offer", id: "1" }),
        currency: "EUR",
        net_total: "100.00",
        markup_amount: "10.00",
        selling_total: "110.00",
        first_departure_local: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19),
        expires_at: expires,
      })
      .execute();
    await trx
      .insertInto("priced_offers")
      .values({
        id: pricedOfferId,
        environment: "test",
        offer_id: offerId,
        offer_ids: [offerId],
        amadeus_request: JSON.stringify({ data: { type: "flight-offers-pricing" } }),
        response: JSON.stringify({ data: { type: "flight-offers-pricing" } }),
        currency: "EUR",
        net_total: "100.00",
        markup_amount: "10.00",
        fee_amount: "5.00",
        selling_total: "115.00",
        expires_at: expires,
      })
      .execute();
  });
  return pricedOfferId;
}

/** Inserts checkout `id` of `customerId` in `status` in `trx`, as checkout.create and the payment steps leave one. */
async function insertCheckoutRow(
  trx: TenantTransaction,
  id: string,
  customerId: string,
  status: "open" | "payment_pending" | "completed",
): Promise<void> {
  await trx
    .insertInto("checkouts")
    .values({
      id,
      environment: "test",
      customer_id: customerId,
      base_priced_offer_id: alphaPricedOfferId,
      priced_offer_id: alphaPricedOfferId,
      status,
      currency: "EUR",
      offer_amount: "115.00",
      total_amount: "115.00",
      expires_at: new Date(Date.now() + 30 * 60_000),
      completed_at: status === "completed" ? new Date() : null,
    })
    .execute();
}

/** Inserts a checkout of `customerId` in `status` into tenant_alpha; its id. */
async function insertCheckout(
  customerId: string,
  status: "open" | "payment_pending" | "completed",
): Promise<string> {
  const id = newId("chk");
  await inTenant("tenant_alpha", (trx) => insertCheckoutRow(trx, id, customerId, status));
  return id;
}

/** How long a scenario waits at most for a request to block on a lock that the test holds. */
const LOCK_WAIT_MS = 15_000;

/** Resolves once another backend of the test database waits for a lock that backend `pid` holds. */
async function untilBlockedBy(pid: number): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const { rows } = await sql<{ blocked: number }>`
      SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE ${pid}::int = ANY (pg_blocking_pids(pid))
    `.execute(migrator);
    if ((rows[0]?.blocked ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`untilBlockedBy: no backend waited for ${pid} within ${LOCK_WAIT_MS} ms`);
    }
    await new Promise((resolveLater) => setTimeout(resolveLater, 10));
  }
}

/**
 * Inserts a Stripe payment of checkout `checkoutId` (tenant_alpha's test environment) in `status`, as the payment steps
 * leave one, linked to `bookingId` when the checkout was claimed; its id.
 */
async function insertCheckoutPayment(
  checkoutId: string,
  customerId: string,
  status: "requires_payment_method" | "authorized" | "captured",
  bookingId: string | null = null,
): Promise<string> {
  const id = newId("pay");
  const now = new Date();
  const authorized = status !== "requires_payment_method";
  await inTenant("tenant_alpha", (trx) =>
    trx
      .insertInto("payments")
      .values({
        id,
        environment: "test",
        checkout_id: checkoutId,
        booking_id: bookingId,
        customer_id: customerId,
        provider: "stripe",
        provider_payment_id: `pi_${randomBytes(12).toString("hex")}`,
        currency: "EUR",
        amount: "115.00",
        amount_authorized: authorized ? "115.00" : "0",
        amount_captured: status === "captured" ? "115.00" : "0",
        amount_refunded: "0",
        status,
        authorized_at: authorized ? now : null,
        captured_at: status === "captured" ? now : null,
      })
      .execute(),
  );
  return id;
}

/** The `payment.void` job the API queued for payment `paymentId` (`payment-void-<pay_id>`), if any. */
async function voidJobOf(paymentId: string): Promise<{ name: string; data: unknown } | undefined> {
  const job = await paymentsQueue.getJob(`payment-void-${paymentId}`);
  return job === undefined ? undefined : { name: job.name, data: job.data as unknown };
}

/** The customer, its identity, sessions, consents and notifications in `schema`. */
async function customerState(schema: Schema, customerId: string) {
  return inTenant(schema, async (trx) => ({
    customer: await trx
      .selectFrom("customers")
      .selectAll()
      .where("id", "=", customerId)
      .executeTakeFirstOrThrow(),
    identity: await trx
      .selectFrom("customer_identities")
      .selectAll()
      .where("customer_id", "=", customerId)
      .executeTakeFirstOrThrow(),
    sessions: await trx
      .selectFrom("customer_sessions")
      .selectAll()
      .where("customer_id", "=", customerId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute(),
    consents: await trx
      .selectFrom("customer_consents")
      .selectAll()
      .where("customer_id", "=", customerId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute(),
    notifications: await trx
      .selectFrom("notifications")
      .selectAll()
      .where("customer_id", "=", customerId)
      .execute(),
  }));
}

/** The status and customer of the checkouts `ids` of tenant_alpha, by id. */
async function checkoutStates(ids: readonly string[]): Promise<Record<string, string>> {
  const rows = await inTenant("tenant_alpha", (trx) =>
    trx
      .selectFrom("checkouts")
      .select(["id", "status"])
      .where("id", "in", [...ids])
      .execute(),
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

/** The verification token of the newest e-mail to `to` that the worker sent: read from its link. */
async function verificationTokenOfMail(to: string): Promise<{ token: string; link: string }> {
  let message = await waitForMessage({ to, timeoutMs: MAIL_WAIT_MS });
  const [newest] = await mailpit.search({ to });
  if (newest !== undefined) {
    message = await mailpit.get(newest.ID);
  }
  const link = extractLinks(message).find((url) => url.includes("/account/verify.html?token="));
  if (link === undefined) {
    throw new Error("verificationTokenOfMail: the e-mail holds no verification link");
  }
  const token = new URL(link).searchParams.get("token") ?? "";
  secrets.push(token);
  return { token, link };
}

/** A `Set-Cookie` header parsed: the value and the attributes as written. */
interface SetCookie {
  readonly value: string;
  readonly attributes: readonly string[];
}

/** The cookies an answer sets, by name. */
function setCookies(res: Response): Map<string, SetCookie> {
  const header = res.headers["set-cookie"] as unknown;
  const lines = Array.isArray(header) ? (header as string[]) : typeof header === "string" ? [header] : [];
  const cookies = new Map<string, SetCookie>();
  for (const line of lines) {
    const [pair = "", ...attributes] = line.split("; ");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), { value: pair.slice(index + 1), attributes });
  }
  return cookies;
}

/** The browser of one storefront visitor: the cookies the API set, sent back on every request. */
class Visitor {
  readonly jar = new Map<string, string>();
  readonly ip = newIp();

  constructor(readonly host = ALPHA_HOST) {
    this.jar.set("__Host-vx_csrf", newCsrfToken());
  }

  /**
   * A visitor with the browser state of `other` (its cookie jar copied), e.g. the cookies before a deletion, calling
   * `host` (`other`'s by default).
   */
  static copyOf(other: Visitor, host = other.host): Visitor {
    const copy = new Visitor(host);
    copy.jar.clear();
    for (const [name, value] of other.jar) {
      copy.jar.set(name, value);
    }
    return copy;
  }

  /** Keeps what an answer set: a cookie with `Max-Age=0` is removed, as a browser does. */
  remember(res: Response): void {
    for (const [name, cookie] of setCookies(res)) {
      if (cookie.attributes.includes("Max-Age=0")) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, cookie.value);
      }
    }
  }

  headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      ...edgeHeaders(this.host),
      Origin: `https://${this.host}`,
      "X-CSRF-Token": this.jar.get("__Host-vx_csrf") ?? "",
      "X-Forwarded-For": this.ip,
      "User-Agent": "Mozilla/5.0 (storefront test)",
      Cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join("; "),
      ...extra,
    };
  }

  async post(path: string, body: unknown, idempotencyKey = randomUUID()): Promise<Response> {
    const res = await request(api.server)
      .post(path)
      .set(this.headers({ "Idempotency-Key": idempotencyKey }))
      .send(body as object);
    this.remember(res);
    return res;
  }

  async patch(path: string, body: unknown, ifMatch: string): Promise<Response> {
    const res = await request(api.server)
      .patch(path)
      .set(this.headers({ "If-Match": ifMatch }))
      .send(body as object);
    this.remember(res);
    return res;
  }

  async get(path: string): Promise<Response> {
    const res = await request(api.server).get(path).set(this.headers());
    this.remember(res);
    return res;
  }
}

/** A server of a third-party storefront with a secret key, calling for one visitor. */
class KeyClient {
  readonly ip = newIp();

  constructor(readonly apiKey = alphaKey) {}

  headers(accessToken?: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      "X-Api-Key": this.apiKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": "Mozilla/5.0 (third-party storefront test)",
      ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
      ...extra,
    };
  }

  post(path: string, body: unknown, accessToken?: string, idempotencyKey = randomUUID()): Promise<Response> {
    return request(api.server)
      .post(path)
      .set(this.headers(accessToken, { "Idempotency-Key": idempotencyKey }))
      .send(body as object);
  }

  patch(path: string, body: unknown, accessToken: string, ifMatch: string): Promise<Response> {
    return request(api.server)
      .patch(path)
      .set(this.headers(accessToken, { "If-Match": ifMatch }))
      .send(body as object);
  }

  get(path: string, accessToken?: string): Promise<Response> {
    return request(api.server).get(path).set(this.headers(accessToken));
  }
}

/** A key caller's session: the tokens of a bearer sign-in. */
interface BearerSession {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** Signs `email` in with `password` through a new key client of `apiKey`; the session's tokens. */
async function bearerSignIn(email: string, apiKey = alphaKey): Promise<BearerSession> {
  const res = await new KeyClient(apiKey).post("/v1/auth/sign-in", { email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`bearerSignIn: sign-in answered ${res.status}`);
  }
  const session = {
    accessToken: res.body.session.accessToken as string,
    refreshToken: res.body.session.refreshToken as string,
  };
  secrets.push(session.accessToken, session.refreshToken);
  return session;
}

/** Signs a new storefront visitor of `host` in as `email`; the visitor holds the session cookies. */
async function edgeSignIn(email: string, host = ALPHA_HOST): Promise<Visitor> {
  const visitor = new Visitor(host);
  const res = await visitor.post("/v1/auth/sign-in", { email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`edgeSignIn: sign-in answered ${res.status}`);
  }
  secrets.push(visitor.jar.get("__Host-vx_at") ?? "", visitor.jar.get("__Host-vx_rt") ?? "");
  return visitor;
}

/** `[status, error code]` of an answer. */
function outcome(res: Response | undefined): [number | undefined, unknown] {
  return [res?.status, res?.body?.error?.code];
}

/** Every log line both applications wrote. */
function allLogText(): string {
  return `${api.sink.text()}\n${workerSink.text()}`;
}

beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of the operations the tests check (Customer is large) compile on their first check: here,
  // with every status the tests below check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["getAccount", [200, 401]],
    ["updateAccount", [200, 400, 409, 412, 422, 429]],
    ["deleteAccount", [202, 403, 409, 422]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, passwordHash] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    hashCustomerPassword(PASSWORD),
  ]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const alpha = await insertTenant("alpha");
  alphaKey = alpha.testKey;
  alphaLiveKey = await issueKey(alpha.tenantId, "live");
  betaKey = (await insertTenant("beta")).testKey;
  // The settings rows as provisioning seeds them (customer accounts on), with published legal versions.
  for (const [schema, name] of [
    ["tenant_alpha", "Alpha Travel"],
    ["tenant_beta", "Beta Travel"],
  ] as const) {
    await inTenant(schema, async (trx) => {
      await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
      await trx
        .updateTable("storefront_settings")
        .set({ terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION })
        .execute();
    });
  }
  alphaPricedOfferId = await insertPricedOffer();

  api = await createTestApp({ database: db, redis, env: { LOG_LEVEL: "debug" } });
  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    LOG_LEVEL: "debug",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
    SMTP_URL: mailpitSmtpUrl(),
  });
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(
    WorkerModule.forRoot(config, { logger: createWorkerLogger(config, workerSink) }),
  );
  await worker.init();
  // No scheduler iteration may fire while the file runs: each commit's `notify` job sends the e-mails.
  const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
  // The voids a deletion queues are read from the queue, never run: this file has no Stripe to call.
  paymentsQueue = worker.get<Queue>(getQueueToken(OTA_QUEUE.payments), { strict: false });
  await paymentsQueue.pause();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
}, SETUP_TIMEOUT_MS);

describe("account.get in both modes, and tenant isolation", () => {
  const email = uniqueEmail("obe035-get");
  let alphaId = "";
  let betaId = "";
  const answers: Record<string, Response> = {};

  beforeAll(async () => {
    alphaId = await insertCustomer("tenant_alpha", email);
    // The same address at tenant B is another customer of another OTA.
    betaId = await insertCustomer("tenant_beta", email);
    const alpha = await bearerSignIn(email);
    const beta = await bearerSignIn(email, betaKey);
    const visitor = await edgeSignIn(email);

    answers["bearer"] = await new KeyClient().get("/v1/account", alpha.accessToken);
    answers["edge"] = await visitor.get("/v1/account");
    answers["betaOwn"] = await new KeyClient(betaKey).get("/v1/account", beta.accessToken);
    answers["alphaTokenAtBeta"] = await new KeyClient(betaKey).get("/v1/account", alpha.accessToken);
    // Tenant A's cookies sent to tenant B's storefront host (a browser never does: they are host-only).
    answers["alphaCookieAtBeta"] = await Visitor.copyOf(visitor, BETA_HOST).get("/v1/account");
    answers["noToken"] = await new KeyClient().get("/v1/account");
    // A signed-out session no longer reads the account, although its access token has not expired.
    await new KeyClient().post("/v1/auth/sign-out", {}, alpha.accessToken);
    answers["signedOut"] = await new KeyClient().get("/v1/account", alpha.accessToken);
  }, SCENARIO_TIMEOUT_MS);

  it("answers the signed-in customer with its ETag, never cached, to key callers and the edge", () => {
    for (const res of [answers["bearer"], answers["edge"]]) {
      expect(res?.status).toBe(200);
      expectResponseToMatch("getAccount", res as Response);
      expect(res?.headers["etag"]).toBe('"1"');
      expect(res?.headers["cache-control"]).toBe("private, no-store");
      expect(res?.headers["set-cookie"]).toBeUndefined();
      expect(res?.body).toMatchObject({
        id: alphaId,
        email,
        emailVerified: true,
        pendingEmail: null,
        firstName: "Anna",
        lastName: "Berg",
        phone: null,
        dateOfBirth: null,
        status: "active",
        marketingConsent: { granted: false },
        version: 1,
      });
      expect(JSON.stringify(res?.body)).not.toMatch(/password|token|identity/i);
    }
  });

  it("[OBE-035 AC1] tenant B cannot read tenant A's customer: A's token or cookie at B answers 401", () => {
    expect([answers["betaOwn"]?.status, answers["betaOwn"]?.body.id]).toEqual([200, betaId]);
    expect(betaId).not.toBe(alphaId);
    expect(outcome(answers["alphaTokenAtBeta"])).toEqual([401, "UNAUTHENTICATED"]);
    expect(outcome(answers["alphaCookieAtBeta"])).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("getAccount", answers["alphaTokenAtBeta"] as Response);
    expect(JSON.stringify(answers["alphaTokenAtBeta"]?.body)).not.toContain(alphaId);
  });

  it("answers 401 without a token and once the session is signed out", () => {
    expect(outcome(answers["noToken"])).toEqual([401, "UNAUTHENTICATED"]);
    expect(outcome(answers["signedOut"])).toEqual([401, "UNAUTHENTICATED"]);
  });
});

describe("account.update of the profile", () => {
  const email = uniqueEmail("obe035-profile");
  let customerId = "";
  let session: BearerSession;
  const answers: Record<string, Response> = {};
  let afterFirst: Awaited<ReturnType<typeof customerState>>;
  let afterStale: Awaited<ReturnType<typeof customerState>>;
  let final: Awaited<ReturnType<typeof customerState>>;

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    session = await bearerSignIn(email);
    const client = new KeyClient();
    answers["first"] = await client.patch(
      "/v1/account",
      {
        firstName: " Annika ",
        phone: { deviceType: "MOBILE", countryCallingCode: "+44", number: "7700900123" },
        dateOfBirth: "1988-04-17",
        marketingConsent: true,
      },
      session.accessToken,
      '"1"',
    );
    afterFirst = await customerState("tenant_alpha", customerId);
    // The ETag of before the first change is stale now.
    answers["stale"] = await client.patch("/v1/account", { lastName: "Stale" }, session.accessToken, '"1"');
    afterStale = await customerState("tenant_alpha", customerId);
    answers["missingIfMatch"] = await request(api.server)
      .patch("/v1/account")
      .set(client.headers(session.accessToken))
      .send({ lastName: "NoIfMatch" });
    answers["invalid"] = await client.patch(
      "/v1/account",
      { lastName: "  ", phone: { countryCallingCode: "44" }, dateOfBirth: "2999-01-01" },
      session.accessToken,
      '"2"',
    );
    // A weak ETag works too; null clears the phone and the date of birth; the same consent appends nothing.
    answers["clear"] = await client.patch(
      "/v1/account",
      { phone: null, dateOfBirth: null, marketingConsent: true },
      session.accessToken,
      'W/"2"',
    );
    answers["nothing"] = await client.patch(
      "/v1/account",
      { firstName: "Annika" },
      session.accessToken,
      '"3"',
    );
    // The storefront edge updates with its CSRF header.
    const visitor = await edgeSignIn(email);
    answers["edge"] = await visitor.patch("/v1/account", { marketingConsent: false }, '"3"');
    answers["edgeWithoutCsrf"] = await request(api.server)
      .patch("/v1/account")
      .set(visitor.headers({ "If-Match": '"4"', "X-CSRF-Token": "" }))
      .send({ lastName: "Csrf" });
    final = await customerState("tenant_alpha", customerId);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-035] writes the changed fields, bumps the version and logs the consent change", () => {
    const res = answers["first"];
    expect(res?.status).toBe(200);
    expectResponseToMatch("updateAccount", res as Response);
    expect(res?.headers["etag"]).toBe('"2"');
    expect(res?.headers["cache-control"]).toBe("private, no-store");
    expect(res?.body).toMatchObject({
      firstName: "Annika",
      lastName: "Berg",
      phone: { countryCallingCode: "44", number: "7700900123" },
      dateOfBirth: "1988-04-17",
      marketingConsent: { granted: true, source: "account" },
      version: 2,
    });
    expect(afterFirst.customer).toMatchObject({
      first_name: "Annika",
      phone_country_code: "44",
      phone_number: "7700900123",
      marketing_consent: true,
      marketing_consent_source: "account",
      version: 2,
    });
    expect(afterFirst.consents.map((row) => [row.kind, row.granted, row.source, row.policy_version])).toEqual(
      [["marketing", true, "account", null]],
    );
  });

  it("[OBE-035 AC1] answers 412 PRECONDITION_FAILED to a stale If-Match and changes nothing", () => {
    expect(outcome(answers["stale"])).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("updateAccount", answers["stale"] as Response);
    expect(afterStale.customer).toEqual(afterFirst.customer);
    expect(afterStale.consents).toEqual(afterFirst.consents);
  });

  it("[OBE-035] needs If-Match and refuses bad fields with field errors, changing nothing", () => {
    expect(outcome(answers["missingIfMatch"])).toEqual([400, "VALIDATION_FAILED"]);
    expect(answers["missingIfMatch"]?.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/header/If-Match" }),
    ]);
    expect(outcome(answers["invalid"])).toEqual([400, "VALIDATION_FAILED"]);
    expectResponseToMatch("updateAccount", answers["invalid"] as Response);
    expect(
      (answers["invalid"]?.body.error.fieldErrors as { path: string; code: string }[]).map((item) => [
        item.path,
        item.code,
      ]),
    ).toEqual([
      ["/lastName", "blank"],
      ["/phone/number", "required"],
      ["/dateOfBirth", "in_future"],
    ]);
    expect(final.customer.last_name).toBe("Berg");
  });

  it("[OBE-035] clears the phone and the date of birth with null, accepts a weak ETag, and keeps the version of a no-op", () => {
    expect([answers["clear"]?.status, answers["clear"]?.headers["etag"]]).toEqual([200, '"3"']);
    expect(answers["clear"]?.body).toMatchObject({ phone: null, dateOfBirth: null, version: 3 });
    expect([answers["nothing"]?.status, answers["nothing"]?.body.version]).toEqual([200, 3]);
  });

  it("[OBE-035] updates through the storefront edge with its CSRF header, and refuses a write without it", () => {
    expect([answers["edge"]?.status, answers["edge"]?.body.marketingConsent.granted]).toEqual([200, false]);
    expect(answers["edge"]?.headers["set-cookie"]).toBeUndefined();
    expect(outcome(answers["edgeWithoutCsrf"])).toEqual([403, "CSRF_TOKEN_INVALID"]);
    expect(final.customer).toMatchObject({ marketing_consent: false, version: 4, last_name: "Berg" });
    expect(final.consents.map((row) => row.granted)).toEqual([true, false]);
  });
});

describe("account.update of a North American phone (FIX-W30-OTA)", () => {
  const email = uniqueEmail("fixw30-phone");
  let customerId = "";
  const answers: Record<string, Response> = {};
  let afterUs: Awaited<ReturnType<typeof customerState>>;
  let final: Awaited<ReturnType<typeof customerState>>;

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    const session = await bearerSignIn(email);
    const client = new KeyClient();
    const phone = (countryCallingCode: string) => ({
      phone: { deviceType: "MOBILE", countryCallingCode, number: "2025550143" },
    });
    answers["us"] = await client.patch("/v1/account", phone("1"), session.accessToken, '"1"');
    afterUs = await customerState("tenant_alpha", customerId);
    answers["usWithPlus"] = await client.patch("/v1/account", phone("+1"), session.accessToken, '"2"');
    answers["letters"] = await client.patch("/v1/account", phone("1a"), session.accessToken, '"2"');
    answers["fourDigits"] = await client.patch("/v1/account", phone("1234"), session.accessToken, '"2"');
    final = await customerState("tenant_alpha", customerId);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W30-OTA AC1] takes the US's calling code 1 and stores it as customers keeps it", () => {
    const res = answers["us"];
    expect(res?.status).toBe(200);
    expectResponseToMatch("updateAccount", res as Response);
    expect(res?.body).toMatchObject({ phone: { countryCallingCode: "1", number: "2025550143" }, version: 2 });
    expect(afterUs.customer).toMatchObject({
      phone_country_code: "1",
      phone_number: "2025550143",
      version: 2,
    });
    // With a leading +, the same phone: nothing changes, not even the version.
    expect([answers["usWithPlus"]?.status, answers["usWithPlus"]?.body.version]).toEqual([200, 2]);
  });

  it("[FIX-W30-OTA AC1] still refuses letters and four digits with 400 on /phone/countryCallingCode, changing nothing", () => {
    for (const name of ["letters", "fourDigits"]) {
      const res = answers[name] as Response;
      expect([name, ...outcome(res)]).toEqual([name, 400, "VALIDATION_FAILED"]);
      expectResponseToMatch("updateAccount", res);
      expect(res.body.error.fieldErrors).toContainEqual(
        expect.objectContaining({ path: "/phone/countryCallingCode", code: "pattern" }),
      );
    }
    expect(final.customer).toEqual(afterUs.customer);
  });
});

describe("account.update of the e-mail address", () => {
  const email = uniqueEmail("obe035-email");
  const newEmail = uniqueEmail("obe035-email-new");
  const otherEmail = uniqueEmail("obe035-email-other");
  const takenEmail = uniqueEmail("obe035-email-taken");
  let customerId = "";
  let session: BearerSession;
  const answers: Record<string, Response> = {};
  let beforeChange: Awaited<ReturnType<typeof customerState>>;
  let pending: Awaited<ReturnType<typeof customerState>>;
  let mail: { token: string; link: string };
  let notice: MailpitMessage;

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    await insertCustomer("tenant_alpha", takenEmail);
    session = await bearerSignIn(email);
    const client = new KeyClient();
    answers["noPassword"] = await client.patch(
      "/v1/account",
      { email: newEmail },
      session.accessToken,
      '"1"',
    );
    answers["wrongPassword"] = await client.patch(
      "/v1/account",
      { email: newEmail, currentPassword: WRONG },
      session.accessToken,
      '"1"',
    );
    answers["taken"] = await client.patch(
      "/v1/account",
      { email: takenEmail.toUpperCase(), currentPassword: PASSWORD },
      session.accessToken,
      '"1"',
    );
    beforeChange = await customerState("tenant_alpha", customerId);
    answers["change"] = await client.patch(
      "/v1/account",
      { email: newEmail, currentPassword: PASSWORD },
      session.accessToken,
      '"1"',
    );
    pending = await customerState("tenant_alpha", customerId);
    answers["tooSoon"] = await client.patch(
      "/v1/account",
      { email: otherEmail, currentPassword: PASSWORD },
      session.accessToken,
      '"2"',
    );
    mail = await verificationTokenOfMail(newEmail);
    notice = await waitForMessage({ to: email, subject: EMAIL_CHANGED_SUBJECT, timeoutMs: MAIL_WAIT_MS });
    answers["oldAddressBefore"] = await new KeyClient().post("/v1/auth/sign-in", {
      email,
      password: PASSWORD,
    });
    answers["newAddressBefore"] = await new KeyClient().post("/v1/auth/sign-in", {
      email: newEmail,
      password: PASSWORD,
    });
    answers["verify"] = await new KeyClient().post("/v1/auth/email-verification/confirm", {
      token: mail.token,
    });
    answers["newAddressAfter"] = await new KeyClient().post("/v1/auth/sign-in", {
      email: newEmail,
      password: PASSWORD,
    });
    answers["oldAddressAfter"] = await new KeyClient().post("/v1/auth/sign-in", {
      email,
      password: PASSWORD,
    });
    answers["account"] = await client.get("/v1/account", session.accessToken);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-035] needs the current password with a new address, and refuses a wrong one with 422, changing nothing", () => {
    expect(outcome(answers["noPassword"])).toEqual([400, "VALIDATION_FAILED"]);
    expect(outcome(answers["wrongPassword"])).toEqual([422, "CURRENT_PASSWORD_INCORRECT"]);
    expectResponseToMatch("updateAccount", answers["wrongPassword"] as Response);
    expect(answers["wrongPassword"]?.body.error.fieldErrors).toEqual([
      { path: "/currentPassword", code: "incorrect", message: expect.any(String) as string },
    ]);
    expect(beforeChange.customer).toMatchObject({ email, pending_email: null, version: 1 });
  });

  it("[OBE-035] refuses another customer's address with 409 EMAIL_ALREADY_REGISTERED", () => {
    expect(outcome(answers["taken"])).toEqual([409, "EMAIL_ALREADY_REGISTERED"]);
    expectResponseToMatch("updateAccount", answers["taken"] as Response);
    expect(answers["taken"]?.body.error.fieldErrors).toEqual([
      { path: "/email", code: "taken", message: "Already registered" },
    ]);
  });

  it("[OBE-035] keeps the new address pending and e-mails a verification link to it; sign-in keeps the old one", () => {
    expect(answers["change"]?.status).toBe(200);
    expectResponseToMatch("updateAccount", answers["change"] as Response);
    expect(answers["change"]?.body).toMatchObject({
      email,
      pendingEmail: newEmail,
      emailVerified: true,
      version: 2,
    });
    expect(pending.identity.verification_token_hash).not.toBeNull();
    expect(new URL(mail.link).origin).toBe(`https://${ALPHA_HOST}`);
    expect(mail.token).toMatch(/^vt_[A-Za-z0-9_-]{43}$/);
    expect(outcome(answers["oldAddressBefore"])).toEqual([200, undefined]);
    expect(outcome(answers["newAddressBefore"])).toEqual([401, "INVALID_CREDENTIALS"]);
  });

  it("[OBE-035] allows one verification e-mail a minute: a second change at once is 429 with Retry-After", () => {
    expect(outcome(answers["tooSoon"])).toEqual([429, "RATE_LIMITED"]);
    expectResponseToMatch("updateAccount", answers["tooSoon"] as Response);
    expect(answers["tooSoon"]?.body.error.details).toEqual({ reason: "verification_email" });
    const retryAfter = Number(answers["tooSoon"]?.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("[OBE-035] moves the address once the link is opened: sign-in then uses the new one", () => {
    expect(answers["verify"]?.status).toBe(200);
    expect(answers["verify"]?.body).toMatchObject({ verifiedEmail: newEmail, emailChanged: true });
    expect(outcome(answers["newAddressAfter"])).toEqual([200, undefined]);
    expect(outcome(answers["oldAddressAfter"])).toEqual([401, "INVALID_CREDENTIALS"]);
    expect(answers["account"]?.body).toMatchObject({ email: newEmail, pendingEmail: null, version: 3 });
    for (const res of [answers["newAddressAfter"], answers["oldAddressBefore"]]) {
      secrets.push(res?.body.session?.accessToken ?? "", res?.body.session?.refreshToken ?? "");
    }
  });

  it("[FIX-W29-OTA AC2] e-mails a security notice to the current address once: when, never the new address, no link that acts", async () => {
    expect(notice.Subject).toBe("The e-mail address of your Alpha Travel account is being changed");
    expect(notice.To.map((to) => to.Address)).toEqual([email]);
    for (const part of [notice.Text, notice.HTML]) {
      expect(part).toContain("Hello Anna,");
      expect(part).toContain("Until it is confirmed you keep signing in with this address");
      expect(part).not.toContain(newEmail);
      expect(part).not.toContain(mail.token);
      expect(part).not.toContain("token=");
    }
    // Its only link is the OTA's storefront (and a support address when the OTA has one): nothing acts on the account.
    for (const link of extractLinks(notice)) {
      expect(link === `https://${ALPHA_HOST}` || link.startsWith("mailto:"), link).toBe(true);
    }
    // The refused second change (429) queued none.
    const state = await customerState("tenant_alpha", customerId);
    expect(state.notifications.filter((row) => row.template_key === "account.email_changed")).toEqual([
      expect.objectContaining({ recipient: email, recipient_type: "customer", status: "sent" }),
    ]);
  });

  it("keeps the token and the passwords in clear nowhere: not in the outbox row, not in a log line", async () => {
    const state = await customerState("tenant_alpha", customerId);
    const [notification] = state.notifications.filter((row) => row.recipient === newEmail);
    expect(notification).toMatchObject({ template_key: "auth.verify_email", status: "sent" });
    expect(notification?.secret_payload_ciphertext).toBeNull();
    expect(JSON.stringify(state.notifications)).not.toContain(mail.token);
    const text = allLogText();
    for (const secret of secrets) {
      if (secret !== "") {
        expect(text).not.toContain(secret);
      }
    }
    expect(text).not.toContain(newEmail);
  });
});

describe("account.update: withdrawing an address change, and the re-authentication lockout", () => {
  const email = uniqueEmail("obe035-withdraw");
  const newEmail = uniqueEmail("obe035-withdraw-new");
  const lockedEmail = uniqueEmail("obe035-locked");
  let customerId = "";
  const answers: Record<string, Response> = {};
  let withdrawn: Awaited<ReturnType<typeof customerState>>;
  const wrongAttempts: Response[] = [];

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    const session = await bearerSignIn(email);
    const client = new KeyClient();
    answers["change"] = await client.patch(
      "/v1/account",
      { email: newEmail, currentPassword: PASSWORD },
      session.accessToken,
      '"1"',
    );
    answers["withdraw"] = await client.patch(
      "/v1/account",
      { email: email.toUpperCase(), currentPassword: PASSWORD },
      session.accessToken,
      '"2"',
    );
    withdrawn = await customerState("tenant_alpha", customerId);

    await insertCustomer("tenant_alpha", lockedEmail);
    const locked = await bearerSignIn(lockedEmail);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      wrongAttempts.push(
        await client.patch(
          "/v1/account",
          { email: uniqueEmail("obe035-locked-new"), currentPassword: WRONG },
          locked.accessToken,
          '"1"',
        ),
      );
    }
    answers["rightWhileLocked"] = await client.patch(
      "/v1/account",
      { email: uniqueEmail("obe035-locked-new"), currentPassword: PASSWORD },
      locked.accessToken,
      '"1"',
    );
    answers["signInWhileLocked"] = await new KeyClient().post("/v1/auth/sign-in", {
      email: lockedEmail,
      password: PASSWORD,
    });
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-035] sending the current address again withdraws the pending change and drops its link", () => {
    expect([answers["change"]?.status, answers["change"]?.body.pendingEmail]).toEqual([200, newEmail]);
    expect(answers["withdraw"]?.status).toBe(200);
    expect(answers["withdraw"]?.body).toMatchObject({ email, pendingEmail: null, version: 3 });
    expect(withdrawn.customer.pending_email).toBeNull();
    expect(withdrawn.identity.verification_token_hash).toBeNull();
  });

  it("[OBE-035] counts the re-authentication against the sign-in lockout: the fifth wrong password locks it with 429", () => {
    expect(wrongAttempts.slice(0, 4).map(outcome)).toEqual(
      Array.from({ length: 4 }, () => [422, "CURRENT_PASSWORD_INCORRECT"]),
    );
    for (const res of [wrongAttempts[4], answers["rightWhileLocked"]]) {
      expect(outcome(res)).toEqual([429, "RATE_LIMITED"]);
      expectResponseToMatch("updateAccount", res as Response);
      expect(res?.body.error.details).toEqual({ reason: "password_attempts" });
      expect(Number(res?.headers["retry-after"])).toBeGreaterThan(0);
    }
    expect(outcome(answers["signInWhileLocked"])).toEqual([423, "ACCOUNT_LOCKED"]);
  });
});

describe("[OBE-035 AC2] account.delete in edge mode: the session cookie no longer works and sign-in answers 401", () => {
  const email = uniqueEmail("obe035-delete-edge");
  let customerId = "";
  let otherCustomerId = "";
  let visitor: Visitor;
  let stale: Visitor;
  const checkouts: Record<string, string> = {};
  const payments: Record<string, string> = {};
  const bookings: Record<string, string> = {};
  const answers: Record<string, Response> = {};
  let before: Awaited<ReturnType<typeof customerState>>;
  let afterRefusals: Awaited<ReturnType<typeof customerState>>;
  let checkoutsAfterRefusals: Record<string, string>;
  const voidJobsAfterRefusals: Record<string, unknown> = {};
  let after: Awaited<ReturnType<typeof customerState>>;
  let checkoutsAfter: Record<string, string>;
  const voidJobs: Record<string, { name: string; data: unknown } | undefined> = {};
  let bookingCustomers: Record<string, string | null>;
  let confirmation: MailpitMessage;

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    otherCustomerId = await insertCustomer("tenant_alpha", uniqueEmail("obe035-delete-other"));
    checkouts["open"] = await insertCheckout(customerId, "open");
    checkouts["paymentPending"] = await insertCheckout(customerId, "payment_pending");
    checkouts["completed"] = await insertCheckout(customerId, "completed");
    checkouts["othersOpen"] = await insertCheckout(otherCustomerId, "open");
    // A PaymentIntent not confirmed yet and an authorisation on the open checkouts, a captured payment on the completed
    // one, another customer's authorisation.
    payments["unconfirmed"] = await insertCheckoutPayment(
      checkouts["open"],
      customerId,
      "requires_payment_method",
    );
    payments["authorized"] = await insertCheckoutPayment(
      checkouts["paymentPending"],
      customerId,
      "authorized",
    );
    payments["captured"] = await insertCheckoutPayment(checkouts["completed"], customerId, "captured");
    payments["others"] = await insertCheckoutPayment(checkouts["othersOpen"], otherCustomerId, "authorized");
    // Bookings that hold nothing back: ticketed and paid, cancelled and refunded, failed with its authorisation.
    bookings["ticketed"] = await insertBooking({
      customerId,
      status: "ticketed",
      ageSeconds: 30,
      payment: "captured",
    });
    bookings["refunded"] = await insertBooking({
      customerId,
      status: "cancelled",
      ageSeconds: 20,
      payment: "captured",
      refund: "succeeded",
    });
    bookings["failed"] = await insertBooking({
      customerId,
      status: "failed",
      ageSeconds: 10,
      payment: "authorized",
    });

    visitor = await edgeSignIn(email);
    // A second session of the same customer, by key.
    const bearer = await bearerSignIn(email);
    before = await customerState("tenant_alpha", customerId);
    stale = Visitor.copyOf(visitor);
    answers["wrongPassword"] = await visitor.post("/v1/account/deletion", { currentPassword: WRONG });
    answers["exportData"] = await visitor.post("/v1/account/deletion", {
      currentPassword: PASSWORD,
      exportData: true,
    });
    afterRefusals = await customerState("tenant_alpha", customerId);
    checkoutsAfterRefusals = await checkoutStates(Object.values(checkouts));
    for (const [name, paymentId] of Object.entries(payments)) {
      voidJobsAfterRefusals[name] = await voidJobOf(paymentId);
    }
    answers["delete"] = await visitor.post("/v1/account/deletion", {
      currentPassword: PASSWORD,
      reason: "privacy_concerns",
      comment: "No longer needed, thanks.",
      exportData: false,
    });
    after = await customerState("tenant_alpha", customerId);
    checkoutsAfter = await checkoutStates(Object.values(checkouts));
    for (const [name, paymentId] of Object.entries(payments)) {
      voidJobs[name] = await voidJobOf(paymentId);
    }
    confirmation = await waitForMessage({
      to: email,
      subject: ACCOUNT_DELETED_SUBJECT,
      timeoutMs: MAIL_WAIT_MS,
    });
    bookingCustomers = Object.fromEntries(
      (
        await inTenant("tenant_alpha", (trx) =>
          trx
            .selectFrom("bookings")
            .select(["id", "customer_id"])
            .where("id", "in", Object.values(bookings))
            .execute(),
        )
      ).map((row) => [row.id, row.customer_id]),
    );

    // The cookies the browser held before the deletion, presented again.
    answers["staleAccount"] = await stale.get("/v1/account");
    answers["staleSession"] = await stale.get("/v1/auth/session");
    answers["staleRefresh"] = await stale.post("/v1/auth/refresh", {});
    answers["clearedAccount"] = await visitor.get("/v1/account");
    answers["bearerAccount"] = await new KeyClient().get("/v1/account", bearer.accessToken);
    answers["bearerRefresh"] = await new KeyClient().post("/v1/auth/refresh", {
      refreshToken: bearer.refreshToken,
    });
    answers["signIn"] = await new KeyClient().post("/v1/auth/sign-in", { email, password: PASSWORD });
    // The address is free again at once.
    answers["signUpAgain"] = await new KeyClient().post("/v1/auth/sign-up", {
      email,
      password: `Fjord-${randomBytes(9).toString("base64url")}`,
      firstName: "Anna",
      lastName: "Berg",
      marketingConsent: false,
      termsVersion: TERMS_VERSION,
    });
    secrets.push(
      answers["signUpAgain"]?.body.session?.accessToken ?? "",
      answers["signUpAgain"]?.body.session?.refreshToken ?? "",
    );
  }, SCENARIO_TIMEOUT_MS);

  it("refuses a wrong password with 422 and exportData with 403 FEATURE_DISABLED, changing nothing", () => {
    expect(outcome(answers["wrongPassword"])).toEqual([422, "CURRENT_PASSWORD_INCORRECT"]);
    expect(outcome(answers["exportData"])).toEqual([403, "FEATURE_DISABLED"]);
    expect(answers["exportData"]?.body.error.details).toEqual({ feature: "dataExports" });
    for (const res of [answers["wrongPassword"], answers["exportData"]]) {
      expectResponseToMatch("deleteAccount", res as Response);
      expect(res?.headers["set-cookie"]).toBeUndefined();
    }
    expect(before.customer.status).toBe("active");
    expect(afterRefusals.customer).toEqual(before.customer);
    expect(afterRefusals.identity).toEqual(before.identity);
    expect(afterRefusals.sessions).toEqual(before.sessions);
    expect(afterRefusals.consents).toEqual(before.consents);
    expect(checkoutsAfterRefusals).toEqual({
      [checkouts["open"] as string]: "open",
      [checkouts["paymentPending"] as string]: "payment_pending",
      [checkouts["completed"] as string]: "completed",
      [checkouts["othersOpen"] as string]: "open",
    });
    expect(Object.values(voidJobsAfterRefusals).every((job) => job === undefined)).toBe(true);
  });

  it("[OBE-035 AC2] answers 202 AccountDeletion, clears the session cookies and rotates the CSRF value", () => {
    const res = answers["delete"];
    expect(res?.status).toBe(202);
    expectResponseToMatch("deleteAccount", res as Response);
    expect(res?.headers["cache-control"]).toBe("no-store");
    expect(res?.body).toMatchObject({ status: "scheduled", dataExport: null });
    expect(
      new Date(res?.body.erasureDueBy as string).getTime() -
        new Date(res?.body.requestedAt as string).getTime(),
    ).toBe(30 * 86_400_000);
    expect((res?.body.retainedRecords as { category: string }[]).map((record) => record.category)).toEqual([
      "bookings",
      "payments",
    ]);
    const cookies = setCookies(res as Response);
    for (const name of ["__Host-vx_at", "__Host-vx_rt"]) {
      expect(cookies.get(name)?.value).toBe("");
      expect(cookies.get(name)?.attributes).toEqual(expect.arrayContaining(["Max-Age=0", "HttpOnly"]));
    }
    expect(cookies.get("__Host-vx_csrf")?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookies.get("__Host-vx_csrf")?.value).not.toBe(stale.jar.get("__Host-vx_csrf"));
    expect(visitor.jar.has("__Host-vx_at")).toBe(false);
  });

  it("[OBE-035 AC2] the old session cookie and bearer token no longer work, and sign-in answers 401", () => {
    expect(outcome(answers["staleAccount"])).toEqual([401, "UNAUTHENTICATED"]);
    expect(outcome(answers["staleSession"])).toEqual([401, "UNAUTHENTICATED"]);
    expect(outcome(answers["staleRefresh"])).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    expect(outcome(answers["clearedAccount"])).toEqual([401, "UNAUTHENTICATED"]);
    expect(outcome(answers["bearerAccount"])).toEqual([401, "UNAUTHENTICATED"]);
    expect(outcome(answers["bearerRefresh"])).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    expect(outcome(answers["signIn"])).toEqual([401, "INVALID_CREDENTIALS"]);
  });

  it("[OBE-035 AC2] soft-deletes the customer at once: placeholder address, identity disabled, sessions revoked, consent withdrawn", () => {
    expect(after.customer).toMatchObject({
      status: "deleted",
      pending_email: null,
      marketing_consent: false,
      marketing_consent_source: "account",
      version: before.customer.version + 1,
      // Kept until the erasure job (OBE-087).
      first_name: "Anna",
      last_name: "Berg",
    });
    expect(after.customer.deleted_at).toEqual(expect.any(Date));
    expect(after.customer.email).toMatch(/^[0-9a-f]{64}@deleted\.invalid$/);
    expect(after.identity.disabled_at).toEqual(expect.any(Date));
    expect(after.identity.provider_subject).toBe(after.customer.email);
    expect(after.identity.email).toBe(after.customer.email);
    expect(after.sessions.length).toBeGreaterThanOrEqual(2);
    for (const row of after.sessions) {
      expect([row.revoked_at, row.revoke_reason]).toEqual([expect.any(Date), "account_deleted"]);
    }
    expect(after.consents.map((row) => [row.kind, row.granted, row.source])).toEqual([
      ["marketing", false, "account"],
    ]);
    const stored = JSON.stringify([after.customer, after.identity]);
    expect(stored).not.toContain(email);
  });

  it("[OBE-035] abandons the customer's open checkouts only, and keeps its bookings with it until the erasure job", () => {
    expect(checkoutsAfter).toEqual({
      [checkouts["open"] as string]: "abandoned",
      [checkouts["paymentPending"] as string]: "abandoned",
      [checkouts["completed"] as string]: "completed",
      [checkouts["othersOpen"] as string]: "open",
    });
    expect(Object.values(bookingCustomers)).toEqual([customerId, customerId, customerId]);
  });

  it("[OBE-035] queues payment.void for the PaymentIntents of the abandoned checkouts only", () => {
    for (const name of ["unconfirmed", "authorized"]) {
      expect(voidJobs[name]).toEqual({
        name: "payment.void",
        data: { tenantId: expect.stringMatching(/^ten_/) as string, id: payments[name] },
      });
    }
    expect([voidJobs["captured"], voidJobs["others"]]).toEqual([undefined, undefined]);
  });

  it("[FIX-W29-OTA AC2] e-mails the deletion's confirmation to the address before it was replaced, with the kept booking records", async () => {
    expect(confirmation.Subject).toBe("Your Alpha Travel account has been deleted");
    for (const part of [confirmation.Text.replace(/\s+/g, " "), confirmation.HTML]) {
      expect(part).toContain("Hello Anna,");
      expect(part).toContain("account was deleted on");
      expect(part).toContain("The records of your bookings are kept");
    }
    for (const link of extractLinks(confirmation)) {
      expect(link === `https://${ALPHA_HOST}` || link.startsWith("mailto:"), link).toBe(true);
    }
    const state = await customerState("tenant_alpha", customerId);
    expect(state.notifications.filter((row) => row.template_key === "account.deleted")).toEqual([
      expect.objectContaining({
        recipient: email,
        dedupe_key: `account.deleted:${customerId}`,
        status: "sent",
      }),
    ]);
  });

  it("[OBE-035] frees the address: it can sign up again as a new customer", () => {
    expect(answers["signUpAgain"]?.status).toBe(201);
    expect(answers["signUpAgain"]?.body.customer.id).not.toBe(customerId);
  });
});

describe("account.delete by a key caller, its replay, and the bookings that hold it back", () => {
  const email = uniqueEmail("obe035-delete-key");
  const blockedEmail = uniqueEmail("obe035-delete-blocked");
  let customerId = "";
  let blockedId = "";
  const blocking: string[] = [];
  const answers: Record<string, Response> = {};
  let blockedBefore: Awaited<ReturnType<typeof customerState>>;
  let blockedAfter: Awaited<ReturnType<typeof customerState>>;

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    const session = await bearerSignIn(email);
    const key = randomUUID();
    const client = new KeyClient();
    answers["delete"] = await client.post(
      "/v1/account/deletion",
      { currentPassword: PASSWORD, reason: "no_longer_needed" },
      session.accessToken,
      key,
    );
    answers["replay"] = await client.post(
      "/v1/account/deletion",
      { currentPassword: PASSWORD, reason: "no_longer_needed" },
      session.accessToken,
      key,
    );

    blockedId = await insertCustomer("tenant_alpha", blockedEmail);
    // Oldest first: being created, waiting for tickets, a refund on its way, a live booking waiting for tickets.
    blocking.push(
      await insertBooking({
        customerId: blockedId,
        status: "pending",
        ageSeconds: 60,
        payment: "authorized",
      }),
    );
    blocking.push(
      await insertBooking({
        customerId: blockedId,
        status: "confirmed",
        ageSeconds: 50,
        payment: "captured",
      }),
    );
    await insertBooking({ customerId: blockedId, status: "ticketed", ageSeconds: 40, payment: "captured" });
    blocking.push(
      await insertBooking({
        customerId: blockedId,
        status: "cancelled",
        ageSeconds: 30,
        payment: "captured",
        refund: "pending",
      }),
    );
    await insertBooking({ customerId: blockedId, status: "failed", ageSeconds: 20, payment: "authorized" });
    blocking.push(
      await insertBooking({
        customerId: blockedId,
        status: "confirmed",
        environment: "live",
        ageSeconds: 10,
      }),
    );
    const blockedSession = await bearerSignIn(blockedEmail);
    blockedBefore = await customerState("tenant_alpha", blockedId);
    answers["blocked"] = await client.post(
      "/v1/account/deletion",
      { currentPassword: PASSWORD },
      blockedSession.accessToken,
    );
    blockedAfter = await customerState("tenant_alpha", blockedId);
    answers["blockedAccount"] = await client.get("/v1/account", blockedSession.accessToken);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-035 AC2] deletes for a key caller without a cookie, and the bearer token stops working", async () => {
    expect(answers["delete"]?.status).toBe(202);
    expectResponseToMatch("deleteAccount", answers["delete"] as Response);
    expect(answers["delete"]?.headers["set-cookie"]).toBeUndefined();
    expect(answers["delete"]?.body.retainedRecords).toEqual([]);
    const state = await customerState("tenant_alpha", customerId);
    expect(state.customer.status).toBe("deleted");
  });

  it("[OBE-035] replays a stored deletion to the same key with the same answer", () => {
    expect(answers["replay"]?.status).toBe(202);
    expect(answers["replay"]?.body).toEqual(answers["delete"]?.body);
  });

  it("[FIX-W29-OTA AC2] confirms a deletion without bookings once, replay included, and keeps none of its records", async () => {
    const confirmation = await waitForMessage({
      to: email,
      subject: ACCOUNT_DELETED_SUBJECT,
      timeoutMs: MAIL_WAIT_MS,
    });
    expect(confirmation.Text).not.toContain("The records of your bookings are kept");
    const state = await customerState("tenant_alpha", customerId);
    expect(state.notifications.filter((row) => row.template_key === "account.deleted")).toHaveLength(1);
  });

  it("[OBE-035] answers 409 ACCOUNT_DELETION_BLOCKED with the bookings that wait for payment, tickets or a refund", () => {
    expect(outcome(answers["blocked"])).toEqual([409, "ACCOUNT_DELETION_BLOCKED"]);
    expectResponseToMatch("deleteAccount", answers["blocked"] as Response);
    expect(answers["blocked"]?.body.error.details).toEqual({ bookingIds: blocking });
    expect(blockedAfter.customer).toEqual(blockedBefore.customer);
    expect(blockedAfter.identity).toEqual(blockedBefore.identity);
    expect(blockedAfter.sessions.every((row) => row.revoked_at === null)).toBe(true);
    expect([answers["blockedAccount"]?.status, answers["blockedAccount"]?.body.status]).toEqual([
      200,
      "active",
    ]);
  });
});

describe("account.delete in the live environment while a test booking is still pending (FIX-W29-OTA)", () => {
  const email = uniqueEmail("obe035-delete-live");
  let customerId = "";
  let pendingBooking = "";
  const checkouts: Record<string, string> = {};
  const payments: Record<string, string> = {};
  let answer: Response;
  let before: Awaited<ReturnType<typeof customerState>>;
  let state: Awaited<ReturnType<typeof customerState>>;
  let checkoutsAfter: Record<string, string>;
  const voidJobs: Record<string, { name: string; data: unknown } | undefined> = {};

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    // A test checkout that checkout.complete claimed: its booking is `pending` (an unknown outcome being reconciled),
    // with the authorisation it is made with; another test checkout waiting for its payment; and a test booking
    // waiting for its tickets, which holds back only a deletion in the test environment.
    checkouts["claimed"] = await insertCheckout(customerId, "payment_pending");
    pendingBooking = await insertBooking({
      customerId,
      status: "pending",
      ageSeconds: 30,
      checkoutId: checkouts["claimed"],
    });
    payments["claimed"] = await insertCheckoutPayment(
      checkouts["claimed"],
      customerId,
      "authorized",
      pendingBooking,
    );
    checkouts["waiting"] = await insertCheckout(customerId, "payment_pending");
    payments["waiting"] = await insertCheckoutPayment(checkouts["waiting"], customerId, "authorized");
    await insertBooking({ customerId, status: "confirmed", ageSeconds: 20, payment: "captured" });
    const session = await bearerSignIn(email);
    before = await customerState("tenant_alpha", customerId);
    answer = await new KeyClient(alphaLiveKey).post(
      "/v1/account/deletion",
      { currentPassword: PASSWORD },
      session.accessToken,
    );
    state = await customerState("tenant_alpha", customerId);
    checkoutsAfter = await checkoutStates(Object.values(checkouts));
    for (const [name, paymentId] of Object.entries(payments)) {
      voidJobs[name] = await voidJobOf(paymentId);
    }
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W29-OTA AC2] answers 409 ACCOUNT_DELETION_BLOCKED with the pending test booking, whatever the environment, and changes nothing", () => {
    expect(outcome(answer)).toEqual([409, "ACCOUNT_DELETION_BLOCKED"]);
    expectResponseToMatch("deleteAccount", answer);
    // The test booking waiting for its tickets does not hold back a deletion in the live environment.
    expect(answer.body.error.details).toEqual({ bookingIds: [pendingBooking] });
    expect(state.customer).toEqual(before.customer);
    expect(state.notifications.filter((row) => row.template_key === "account.deleted")).toEqual([]);
    expect(checkoutsAfter).toEqual({
      [checkouts["claimed"] as string]: "payment_pending",
      [checkouts["waiting"] as string]: "payment_pending",
    });
    expect(voidJobs).toEqual({ claimed: undefined, waiting: undefined });
  });
});

describe("account.delete while a checkout.create of the customer runs (the lock order)", () => {
  const email = uniqueEmail("obe035-delete-race");
  let customerId = "";
  let older = "";
  const newer = newId("chk");
  let createCommitted = false;
  let answer: Response;
  let state: Awaited<ReturnType<typeof customerState>>;
  let checkoutsAfter: Record<string, string>;

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    older = await insertCheckout(customerId, "open");
    const session = await bearerSignIn(email);
    let deletion: Promise<Response> | undefined;
    // What checkout.create does in one transaction: it inserts the new checkout (whose foreign key takes the customer's
    // FOR KEY SHARE) and then abandons the customer's other open checkouts of the same offer. The deletion, sent in
    // between, locks the older checkout and then waits for the customer: a deadlock, which PostgreSQL ends after its
    // deadlock_timeout (1 s) by rolling back the transaction that waited first, the deletion's.
    try {
      await inTenant("tenant_alpha", async (trx) => {
        await insertCheckoutRow(trx, newer, customerId, "open");
        const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
        deletion = Promise.resolve(
          new KeyClient().post("/v1/account/deletion", { currentPassword: PASSWORD }, session.accessToken),
        );
        await untilBlockedBy(rows[0]?.pid ?? 0);
        await trx
          .updateTable("checkouts")
          .set({ status: "abandoned", version: sql<number>`version + 1`, updated_at: new Date() })
          .where("id", "=", older)
          .where("status", "=", "open")
          .execute();
      });
      createCommitted = true;
    } catch (error) {
      // Only on a machine so slow that the deadlock check of the deletion ran before the update waited: then this
      // transaction is the one rolled back, and the deletion goes on alone.
      if (!isDeadlock(error)) {
        throw error;
      }
    }
    answer = await (deletion as Promise<Response>);
    state = await customerState("tenant_alpha", customerId);
    checkoutsAfter = await checkoutStates([older, newer]);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-035] deletes the account although its transaction met a deadlock, and abandons the new checkout too", () => {
    expect(answer.status).toBe(202);
    expectResponseToMatch("deleteAccount", answer);
    expect(state.customer.status).toBe("deleted");
    expect(checkoutsAfter).toEqual(
      createCommitted ? { [older]: "abandoned", [newer]: "abandoned" } : { [older]: "abandoned" },
    );
    if (createCommitted) {
      // The deletion was the transaction PostgreSQL rolled back, and its second attempt deleted the account.
      expect(api.sink.text()).toContain("customer.account_deletion_deadlock");
    }
  });
});

describe("[OBE-035 AC3] the deferred account operations", () => {
  const email = uniqueEmail("obe035-deferred");
  const answers: Record<string, Response> = {};

  beforeAll(async () => {
    await insertCustomer("tenant_alpha", email);
    const session = await bearerSignIn(email);
    const visitor = await edgeSignIn(email);
    answers["bearer"] = await new KeyClient().get("/v1/account/preferences", session.accessToken);
    answers["edge"] = await visitor.get("/v1/account/preferences");
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-035 AC3] account.preferences.get answers 501 NOT_IMPLEMENTED, for key callers and the edge", () => {
    for (const res of [answers["bearer"], answers["edge"]]) {
      expect(outcome(res)).toEqual([501, "NOT_IMPLEMENTED"]);
      expect(res?.body.error.details).toEqual({
        milestone: "deferred",
        operationId: "getAccountPreferences",
      });
    }
  });
});
