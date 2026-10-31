// The live environment of a live tenant (OBE-081; ADR-0018 "Environment", OADR-0009 point 2, OADR-0011 point 5,
// PBE-061's effects, ota/backend/README.md §3), through the API's whole pipeline against PostgreSQL 16, Redis 7, two
// Amadeus stubs and a fake of the Stripe API.
//
// The file clones the @velexis/testing template (tenant_alpha provisioned) and writes the platform rows as the platform
// does: the Velexis Amadeus accounts of both environments (the test one served by a stub, the live one by a second
// stub on another port, each accepting only its own credentials), alpha `active` in `test` with its active supplier
// connections of both environments (the live office assigned before go-live, PBE-061's `amadeus_live` precondition),
// its `velexis` test payment connection and a verified custom storefront domain, and the accounts and memberships of
// an owner and a viewer. The OTA admin's service key signs them in with portal tokens, as console-access.int.test.ts
// does. Visitors of the hosted storefront are the edge (Caddy's headers) from addresses of their own, each with its
// CSRF cookie and the guest booking cookie (`__Host-vx_bt`) checkout.complete sets; a signed-in customer (customers
// are shared by test and live) carries an access token signed by the API's own key in `__Host-vx_at`.
//
// A guest and a customer book on the test storefront first. Then alpha goes live as the platform's goLive does it
// (PBE-061 step 2: one transaction sets `storefront_environment = 'live'`, `live_enabled_at` and
// `live_enabled_by_account_id` and writes the live `velexis` payment row, and after the commit the `tenant` and
// `connection` invalidations are published): the storefront (both of its hosts) follows within one second of the
// invalidation, and from then on searches, prices and books through the live Amadeus connection (the second stub),
// pays with the Velexis account's live keys, and never shows the test bookings, not even to a request that asks for
// `test` with the console's environment header; staff open the live console (owner, not viewer), which reads live rows
// only. Last, an API started without the Velexis live keys (step 3) serves a live tenant that uses its own Stripe
// account (`api_keys`) and answers `424 PAYMENT_PROVIDER_NOT_CONFIGURED` for `velexis` and `connect_standard`.
//
// The describes run in order and build on each other (one go-live per file). Every key is built at run time; none is
// real, and none reaches a log line. The answers the criteria rest on are checked against the OTA document.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { encryptValue, sha256Hex, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { TokenService } from "../../../src/identity/token.service";
import { connectionSecretAad } from "../../../src/payments/stripe/stripe-client.factory";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildStripeConfirmation } from "../../builders/bookings";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import { journeyAmadeusLimitsModule } from "../../helpers/amadeus-limits";
import { edgeHeaders, newCsrfToken, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import {
  startFakeStripe,
  stripeEndpointModule,
  type FakeStripe,
  type FakeStripeRequest,
} from "../../helpers/fake-stripe";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Environment = "test" | "live";
type Role = "owner" | "viewer";
type Mode = "velexis" | "connect_standard" | "api_keys";

const ALPHA_HOST = "alpha.ota.example.com";
/** alpha's verified custom storefront domain (`host:<hostname>` holds only the tenant id, as `tenantkey:` does). */
const CUSTOM_HOST = "book.alpha-travel.example";
const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const DESCRIPTOR = "ALPHA TRAVEL";

/** The Velexis account's Stripe keys of both environments: Stripe's shapes, random, never a real key. */
const VELEXIS_KEYS = {
  test: {
    secret: `sk_test_${randomBytes(20).toString("hex")}`,
    publishable: `pk_test_${randomBytes(20).toString("hex")}`,
  },
  live: {
    secret: `sk_live_${randomBytes(20).toString("hex")}`,
    publishable: `pk_live_${randomBytes(20).toString("hex")}`,
  },
} as const;
/** The OTA's own live account (`api_keys`) and the one it connects through Connect OAuth. */
const OTA_LIVE_SECRET_KEY = `sk_live_${randomBytes(20).toString("hex")}`;
const OTA_LIVE_PUBLISHABLE_KEY = `pk_live_${randomBytes(20).toString("hex")}`;
const OTA_LIVE_WEBHOOK_SECRET = `whsec_${randomBytes(20).toString("hex")}`;
const OWN_ACCOUNT = `acct_${randomBytes(8).toString("hex")}OwnKeys`;
const CONNECT_ACCOUNT = `acct_${randomBytes(8).toString("hex")}Connect`;

/** The Velexis Amadeus credentials of each environment; each stub accepts only its own. */
const AMADEUS_CREDENTIALS = {
  test: {
    clientId: `velexis-test-${randomBytes(4).toString("hex")}`,
    clientSecret: randomBytes(24).toString("base64url"),
  },
  live: {
    clientId: `velexis-live-${randomBytes(4).toString("hex")}`,
    clientSecret: randomBytes(24).toString("base64url"),
  },
} as const;
/** alpha's offices: one of the test pool, one of the live pool. */
const OFFICES = {
  test: `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`,
  live: `MAD1A${randomBytes(2).toString("hex").toUpperCase()}`,
} as const;

let db: TestDatabase;
let redis: TestRedis;
/** The API with the Velexis account's keys of both environments. */
let api: TestApp;
/** The same API without the Velexis live keys (step 3). */
let withoutLiveKeys: TestApp;
let stubs: Record<Environment, AmadeusStub>;
let stripe: FakeStripe;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let owner: Member;
let viewer: Member;
/** The live payment row that go-live writes. */
let livePaymentConnectionId: string;

const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", run);
const idempotencyKey = (): string => randomBytes(16).toString("hex");
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

// ---- Platform rows -------------------------------------------------------------------------------------------------

/** The Velexis Amadeus account of `environment`, its secret sealed as the platform seals it. */
async function insertAmadeusAccount(environment: Environment): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(AMADEUS_CREDENTIALS[environment].clientSecret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${id}`,
    keys,
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id,
      name: `Velexis ${environment}`,
      environment,
      base_url:
        environment === "test" ? "https://test.travel.api.amadeus.com" : "https://travel.api.amadeus.com",
      client_id: AMADEUS_CREDENTIALS[environment].clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

/**
 * alpha in test, with an active supplier connection in each environment, its `velexis` test payment row and its
 * verified custom storefront domain.
 */
async function insertAlpha(accounts: Record<Environment, string>): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id,
      key: "alpha",
      name: "Alpha Travel",
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/Madrid",
    })
    .execute();
  for (const environment of ["test", "live"] as const) {
    const office = OFFICES[environment];
    await migrator
      .insertInto("platform.supplier_connections")
      .values({
        id: newId("sc"),
        tenant_id: id,
        environment,
        credential_source: "velexis",
        amadeus_account_id: accounts[environment],
        office_ids: [office],
        default_office_id: office,
        queuing_office_id: office,
        owner_office_id: office,
        status: "active",
      })
      .execute();
  }
  await insertPaymentConnection(id, "test");
  await migrator
    .insertInto("platform.tenant_domains")
    .values({
      id: newId("dom"),
      tenant_id: id,
      hostname: CUSTOM_HOST,
      kind: "custom",
      verification_token: `velexis-verify-${newId("tok")}`,
      purpose: "storefront",
      verification_status: "verified",
    })
    .execute();
  return id;
}

/** A `velexis` payment row of `environment`, as provisioning (test) and goLive (live) write it. */
async function insertPaymentConnection(
  tenantId: string,
  environment: Environment,
  trx: Kysely<PlatformDatabase> = migrator,
): Promise<string> {
  const id = newId("ppc");
  await trx
    .insertInto("platform.payment_provider_connections")
    .values({
      id,
      tenant_id: tenantId,
      provider: "stripe",
      environment,
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
      statement_descriptor_suffix: DESCRIPTOR,
    })
    .execute();
  return id;
}

/** A portal account and its membership in alpha. */
interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly role: Role;
}

/** An active account with MFA (PADR-0008's rule for live OTAs) and its membership with `role` in alpha. */
async function insertMember(role: Role): Promise<Member> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: `staff.${randomBytes(4).toString("hex")}@example.com`,
      full_name: "Maria Lopez",
      status: "active",
      email_verified_at: new Date(),
      locale: "en-GB",
      time_zone: "Europe/Paris",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: alphaId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, role };
}

/** Publishes an invalidation on `vx:invalidate`, as the platform does after its commit. */
async function publish(event: InvalidationEvent): Promise<void> {
  await redis.client.publish(INVALIDATION_CHANNEL, JSON.stringify(event));
}

/**
 * Switches alpha's live payment row in place to `mode`, as the platform's payments page does (PADR-0011 point 1), and
 * waits until the API's subscriber has dropped the cached row after the `connection` invalidation: a marker in the
 * cached row's key (an entry that does not parse, a miss for any reader) is what the subscriber must delete.
 */
async function switchLiveConnection(mode: Mode): Promise<void> {
  const own = mode === "api_keys";
  // The OTA's secret key and webhook signing secret, each sealed with its column's associated data (ADR-0010).
  const seal = (value: string, aad: string) =>
    encryptValue(Buffer.from(value, "utf8"), { aad, keys }).then(({ ciphertext, kekId }) => ({
      ciphertext: Buffer.from(ciphertext),
      kekId,
    }));
  const secret = own
    ? await seal(OTA_LIVE_SECRET_KEY, connectionSecretAad(livePaymentConnectionId))
    : undefined;
  const webhook = own
    ? await seal(
        OTA_LIVE_WEBHOOK_SECRET,
        `platform.payment_provider_connections.webhook_secret_ciphertext:${livePaymentConnectionId}`,
      )
    : undefined;
  await migrator
    .updateTable("platform.payment_provider_connections")
    .set({
      account_mode: mode,
      account_reference: mode === "connect_standard" ? CONNECT_ACCOUNT : own ? OWN_ACCOUNT : null,
      publishable_key: own ? OTA_LIVE_PUBLISHABLE_KEY : null,
      secret_ciphertext: secret?.ciphertext ?? null,
      webhook_secret_ciphertext: webhook?.ciphertext ?? null,
      encryption_key_id: secret?.kekId ?? null,
      version: sql<number>`version + 1`,
      updated_at: new Date(),
    })
    .where("id", "=", livePaymentConnectionId)
    .execute();
  const cached = redisKeys.conn("payment", alphaId, "live").key;
  await redis.client.set(cached, "invalidation-pending", "EX", 60);
  await publish({ v: 1, type: "connection", tenantId: alphaId });
  // Not a bound of a criterion: generous, well under the 60 s the cached row would otherwise live.
  await vi.waitFor(
    async () => {
      expect(await redis.client.exists(cached)).toBe(0);
    },
    { timeout: 5000, interval: 20 },
  );
}

// ---- The hosted storefront -----------------------------------------------------------------------------------------

let visitorCount = 0;

/** Who a visitor is and where: the API graph, the storefront host (alpha's sub-domain) and a customer's token. */
interface VisitorOptions {
  readonly app?: TestApp;
  readonly host?: string;
  /** A signed-in customer's access token (`__Host-vx_at`); a guest without it. */
  readonly customerToken?: string;
}

/** A visitor of alpha's hosted storefront: Caddy's edge headers, an address of its own, its cookies. */
class Visitor {
  readonly ip: string;
  readonly csrf = newCsrfToken();
  readonly host: string;
  readonly customerToken: string | undefined;
  /** The `__Host-vx_bt` value checkout.complete or bookings.lookup set last. */
  bookingTokens: string | undefined;
  private readonly app: TestApp;

  constructor(options: VisitorOptions = {}) {
    visitorCount += 1;
    this.ip = `203.0.113.${visitorCount}`;
    this.app = options.app ?? api;
    this.host = options.host ?? ALPHA_HOST;
    this.customerToken = options.customerToken;
  }

  private headers(): Record<string, string> {
    const cookies = [`__Host-vx_csrf=${this.csrf}`];
    if (this.bookingTokens !== undefined) {
      cookies.push(`__Host-vx_bt=${this.bookingTokens}`);
    }
    if (this.customerToken !== undefined) {
      cookies.push(`__Host-vx_at=${this.customerToken}`);
    }
    return { ...edgeHeaders(this.host), "X-Forwarded-For": this.ip, Cookie: cookies.join("; ") };
  }

  /** The headers of a state-changing request: the CSRF pair and the storefront's `Origin`. */
  private writeHeaders(): Record<string, string> {
    return { ...this.headers(), Origin: `https://${this.host}`, "X-CSRF-Token": this.csrf };
  }

  /** A read; `extra` adds headers a browser could send through Caddy. */
  get(path: string, extra: Record<string, string> = {}): Promise<Response> {
    return request(this.app.server)
      .get(path)
      .set({ ...this.headers(), ...extra })
      .then((res) => res);
  }

  post(path: string, body: object, extra: Record<string, string> = {}): Promise<Response> {
    return request(this.app.server)
      .post(path)
      .set({ ...this.writeHeaders(), "Idempotency-Key": idempotencyKey(), ...extra })
      .send(body)
      .then((res) => res);
  }

  put(path: string, body: object): Promise<Response> {
    return request(this.app.server)
      .put(path)
      .set(this.writeHeaders())
      .send(body)
      .then((res) => res);
  }

  /** storefront.get, checked against the document. */
  async storefront(): Promise<StorefrontBody> {
    const res = await this.get("/v1/storefront");
    expect(res.status).toBe(200);
    expectResponseToMatch("getStorefront", res);
    return res.body as StorefrontBody;
  }

  /** Keeps the guest booking cookie an answer sets. */
  keepBookingCookie(res: Response): void {
    const raw: unknown = res.headers["set-cookie"];
    const headers = Array.isArray(raw) ? (raw as string[]) : typeof raw === "string" ? [raw] : [];
    const header = headers.find((value) => value.startsWith("__Host-vx_bt="));
    expect(header).toBeDefined();
    this.bookingTokens = header?.slice("__Host-vx_bt=".length).split(";", 1)[0];
  }
}

interface StorefrontBody {
  readonly environment: Environment;
  readonly seo: { readonly robots: { readonly index: boolean } };
  readonly payment: {
    readonly environment: Environment;
    readonly accountMode: Mode;
    readonly publishableKey: string;
    readonly supportedMethods: readonly string[];
  };
}

interface Booked {
  readonly searchId: string;
  readonly checkoutId: string;
  readonly paymentId: string;
  readonly intentId: string;
  readonly bookingId: string;
  readonly reference: string;
  readonly lastName: string;
}

let searchCount = 0;

/** A new search of the stub's Madrid–Paris Orly offers by `visitor`; its offer 2 moved 60 days ahead. */
async function searchAndPrice(visitor: Visitor): Promise<{ searchId: string; pricedOfferId: string }> {
  searchCount += 1;
  const searched = await visitor.post("/v1/flight-searches", {
    mode: "simple",
    originLocationCode: "MAD",
    destinationLocationCode: "ORY",
    departureDate: dateFromToday(60 + searchCount),
    adults: 1,
  });
  expect(answer(searched)).toEqual([201, undefined]);
  expectResponseToMatch("createFlightSearch", searched);
  const searchId = (searched.body as { id: string }).id;
  const offerId = await alphaTx(async (trx) => {
    await trx
      .updateTable("flight_offers")
      .set({
        payload: sql`jsonb_set(jsonb_set(jsonb_set(payload,
          '{itineraries,0,segments,0,departure,at}', to_jsonb(${`${FLIGHT_DATE}T07:15:00`}::text)),
          '{itineraries,0,segments,0,arrival,at}', to_jsonb(${`${FLIGHT_DATE}T09:20:00`}::text)),
          '{lastTicketingDate}', to_jsonb(${LAST_TICKETING_DATE}::text))`,
        last_ticketing_date: LAST_TICKETING_DATE,
      })
      .where("search_id", "=", searchId)
      .execute();
    const row = await trx
      .selectFrom("flight_offers")
      .select("id")
      .where("search_id", "=", searchId)
      .where("amadeus_offer_id", "=", "2")
      .executeTakeFirstOrThrow();
    return row.id;
  });
  const priced = await visitor.post("/v1/priced-offers", { offerIds: [offerId] });
  expect(answer(priced)).toEqual([201, undefined]);
  return { searchId, pricedOfferId: (priced.body as { id: string }).id };
}

/** A guest checkout of `visitor` with its traveller and contact. */
async function newCheckout(
  visitor: Visitor,
): Promise<{ searchId: string; checkoutId: string; lastName: string }> {
  const { searchId, pricedOfferId } = await searchAndPrice(visitor);
  const created = await visitor.post("/v1/checkouts", { pricedOfferId });
  expect(answer(created)).toEqual([201, undefined]);
  const checkoutId = (created.body as { id: string }).id;
  const traveler = buildTravelerInput();
  expect((await visitor.put(`/v1/checkouts/${checkoutId}/travelers`, { travelers: [traveler] })).status).toBe(
    200,
  );
  expect(
    (await visitor.put(`/v1/checkouts/${checkoutId}/contacts`, { contacts: [buildContactInput()] })).status,
  ).toBe(200);
  return { searchId, checkoutId, lastName: traveler.name?.lastName ?? "" };
}

/** checkout.createPayment of the storefront (a card, the terms accepted). */
const createPayment = (visitor: Visitor, checkoutId: string): Promise<Response> =>
  visitor.post(`/v1/checkouts/${checkoutId}/payments`, { method: "card", termsAccepted: true });

/**
 * A booking on the storefront as `visitor` sees it: search, price, checkout, a card payment that Stripe.js confirms in
 * the browser (on the fake), and checkout.complete, which sets the guest booking cookie for a guest (a customer's
 * booking gets none: it is in their trips).
 */
async function book(visitor: Visitor): Promise<Booked> {
  const { searchId, checkoutId, lastName } = await newCheckout(visitor);
  const paid = await createPayment(visitor, checkoutId);
  expect(answer(paid)).toEqual([201, undefined]);
  expectResponseToMatch("createCheckoutPayment", paid);
  const payment = paid.body as { id: string; providerPaymentId: string; amount: { amount: string } };
  stripe.update(
    payment.providerPaymentId,
    buildStripeConfirmation(Math.round(Number(payment.amount.amount) * 100)),
  );
  const completed = await visitor.post(`/v1/checkouts/${checkoutId}/complete`, {});
  expect(answer(completed)).toEqual([201, undefined]);
  expectResponseToMatch("completeCheckout", completed);
  if (visitor.customerToken === undefined) {
    visitor.keepBookingCookie(completed);
  }
  const booking = (completed.body as { booking: { id: string; reference: string } }).booking;
  return {
    searchId,
    checkoutId,
    paymentId: payment.id,
    intentId: payment.providerPaymentId,
    bookingId: booking.id,
    reference: booking.reference,
    lastName,
  };
}

/**
 * A customer of alpha (an account with a verified address: customers are shared by test and live) and an access token
 * for them, signed by the API's own key as auth.signIn would.
 */
async function newCustomerToken(): Promise<string> {
  const id = newId("cus");
  await alphaTx((trx) =>
    trx
      .insertInto("customers")
      .values({
        id,
        email: `${id.toLowerCase()}@example.com`,
        email_verified_at: new Date(),
        first_name: "TESTA",
        last_name: "CUSTOMER",
      })
      .execute(),
  );
  const signed = await api.app
    .get(TokenService)
    .signCustomerToken({ sub: id, tid: alphaId, sid: newId("ses") });
  return signed.token;
}

/** The ids of a signed-in customer's trips (bookings.list, every timeframe) on the storefront. */
async function tripIds(customer: Visitor): Promise<string[]> {
  const res = await customer.get("/v1/bookings?timeframe=all&limit=50");
  expect(answer(res)).toEqual([200, undefined]);
  expectResponseToMatch("listBookings", res);
  return (res.body as { data: Array<{ id: string }> }).data.map((item) => item.id);
}

/** The environment of a row of alpha's schema. */
async function environmentOf(
  table: "flight_searches" | "checkouts" | "payments" | "bookings",
  id: string,
): Promise<string> {
  const row = await alphaTx((trx) =>
    trx.selectFrom(table).select("environment").where("id", "=", id).executeTakeFirstOrThrow(),
  );
  return row.environment;
}

/** The operations each stub answered since its log was last cleared (token requests included). */
const stubOperations = (environment: Environment): string[] =>
  stubs[environment].requests().map((req) => String(req.operation));

/** The `Authorization` header and the metadata of a PaymentIntent creation the fake received. */
const intentCreations = (): Array<[string | undefined, unknown]> =>
  stripe.requests
    .filter((req: FakeStripeRequest) => req.method === "POST" && req.path === "/v1/payment_intents")
    .map((req) => [req.headers["authorization"], req.form["metadata"]]);

// ---- The OTA admin -------------------------------------------------------------------------------------------------

let adminCount = 0;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stores a portal token for `member` as the platform's createConsoleToken does (PADR-0007). */
async function portalTokenFor(member: Member): Promise<string> {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: alphaId,
    membershipId: member.staffId,
    role: member.role,
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 60, "NX")).toBe(
    "OK",
  );
  return token;
}

/** The console lists the file reads, by operation. */
const CONSOLE_LISTS = {
  consoleListBookings: "/v1/console/bookings",
  consoleListPayments: "/v1/console/payments",
  consoleListSupplierRequests: "/v1/console/supplier-requests",
} as const;
type ConsoleList = keyof typeof CONSOLE_LISTS;

/** A staff member signed in through the OTA admin (its service key, the staff member's IP and user agent). */
class Staff {
  private readonly ip: string;
  private accessToken = "";

  constructor(readonly member: Member) {
    adminCount += 1;
    this.ip = `198.51.100.${adminCount}`;
  }

  private headers(environment: Environment): Record<string, string> {
    return {
      "X-Api-Key": testApiCredentials().serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": "Mozilla/5.0 (live environment test)",
      "X-Velexis-Environment": environment,
    };
  }

  /** console.auth.signIn with a new portal token, asking for `environment`. */
  async signIn(environment: Environment = "test"): Promise<Response> {
    const res = await request(api.server)
      .post("/v1/console/auth/sign-in")
      .set({ ...this.headers(environment), "Idempotency-Key": randomUUID() })
      .send({ grantType: "portal_token", portalToken: await portalTokenFor(this.member) });
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleSignIn", res);
    this.accessToken = (res.body as { session: { accessToken: string } }).session.accessToken;
    return res;
  }

  /** A console read in `environment` with the staff token. */
  get(path: string, environment: Environment): Promise<Response> {
    return request(api.server)
      .get(path)
      .set({ ...this.headers(environment), Authorization: `Bearer ${this.accessToken}` })
      .then((res) => res);
  }

  /** The ids of a console list in `environment` (`consoleListBookings` and the others of `CONSOLE_LISTS`). */
  async listIds(list: ConsoleList, environment: Environment, query = ""): Promise<string[]> {
    const res = await this.get(`${CONSOLE_LISTS[list]}?limit=100${query}`, environment);
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch(list, res);
    return (res.body as { data: Array<{ id: string }> }).data.map((item) => item.id);
  }

  /** The ids of console.bookings.list in `environment`. */
  bookingIds(environment: Environment): Promise<string[]> {
    return this.listIds("consoleListBookings", environment);
  }
}

// ---- Setup ---------------------------------------------------------------------------------------------------------

// Cloning the template, starting two stubs and the fake Stripe API, and building two API module graphs take several
// seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own timeout.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["getStorefront", [200]],
    ["createFlightSearch", [201]],
    ["getFlightSearch", [200, 404]],
    ["getCheckout", [200, 404]],
    ["createCheckoutPayment", [201, 424]],
    ["completeCheckout", [201]],
    ["getBooking", [200, 404]],
    ["listBookings", [200]],
    ["lookupBooking", [200, 404]],
    ["consoleSignIn", [200]],
    ["consoleGetMe", [200, 403]],
    ["consoleListBookings", [200, 403]],
    ["consoleListPayments", [200]],
    ["consoleListSupplierRequests", [200]],
    ["consoleGetBooking", [200, 404]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, keys, stripe] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    testKeyProvider(),
    startFakeStripe(),
  ]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alphaId = await insertAlpha({
    test: await insertAmadeusAccount("test"),
    live: await insertAmadeusAccount("live"),
  });
  owner = await insertMember("owner");
  viewer = await insertMember("viewer");
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
  });
  // The second stub listens on a port of its own: the live connection's requests can only reach it.
  const [testStub, liveStub] = await Promise.all([
    startAmadeusStub({ credentials: AMADEUS_CREDENTIALS.test }),
    startAmadeusStub({ credentials: AMADEUS_CREDENTIALS.live }),
  ]);
  stubs = { test: testStub, live: liveStub };
  expect(liveStub.port).not.toBe(testStub.port);
  const amadeus = { AMADEUS_BASE_URL_TEST: testStub.url, AMADEUS_BASE_URL_LIVE: liveStub.url };
  const testKeys = {
    STRIPE_SECRET_KEY_TEST: VELEXIS_KEYS.test.secret,
    STRIPE_PUBLISHABLE_KEY_TEST: VELEXIS_KEYS.test.publishable,
  };
  // One tenant's searches, prices and bookings one after the other: buckets the file cannot empty.
  [api, withoutLiveKeys] = await Promise.all([
    createTestApp({
      database: db,
      redis,
      imports: [stripeEndpointModule(stripe.endpoint), journeyAmadeusLimitsModule()],
      env: {
        ...amadeus,
        ...testKeys,
        STRIPE_SECRET_KEY_LIVE: VELEXIS_KEYS.live.secret,
        STRIPE_PUBLISHABLE_KEY_LIVE: VELEXIS_KEYS.live.publishable,
      },
    }),
    createTestApp({
      database: db,
      redis,
      imports: [stripeEndpointModule(stripe.endpoint), journeyAmadeusLimitsModule()],
      env: { ...amadeus, ...testKeys },
    }),
  ]);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await withoutLiveKeys?.close();
  await stubs?.test.stop();
  await stubs?.live.stop();
  await stripe?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

// ---- Before go-live ------------------------------------------------------------------------------------------------

/** The guest booking made on the test storefront, and its visitor (who holds its booking cookie). */
let testBooking: Booked;
let testGuest: Visitor;
/** The signed-in customer's booking made on the test storefront, and the customer. */
let customerTestBooking: Booked;
let customer: Visitor;
let customerToken: string;
let ownerStaff: Staff;
let viewerStaff: Staff;
/** Both test bookings' ids, sorted: what the test console lists before and after go-live. */
const testBookingIds = (): string[] => [testBooking.bookingId, customerTestBooking.bookingId].sort();
const sorted = (ids: readonly string[]): string[] => [...ids].sort();

describe("before go-live: the test storefront", () => {
  it("books a guest through the test Amadeus connection and the Velexis test keys; staff see test only", async () => {
    testGuest = new Visitor();
    const storefront = await testGuest.storefront();
    expect([
      storefront.environment,
      storefront.payment.environment,
      storefront.payment.publishableKey,
    ]).toEqual(["test", "test", VELEXIS_KEYS.test.publishable]);
    // A test storefront is never indexed.
    expect(storefront.seo.robots.index).toBe(false);
    stubs.test.clearRequests();
    stubs.live.clearRequests();
    stripe.reset();

    testBooking = await book(testGuest);

    expect(await environmentOf("bookings", testBooking.bookingId)).toBe("test");
    expect(stubOperations("test")).toEqual(
      expect.arrayContaining(["getFlightOffers", "quoteAirOffers", "createFlightOrders"]),
    );
    expect(stubOperations("live")).toEqual([]);
    expect(intentCreations()).toEqual([
      [`Bearer ${VELEXIS_KEYS.test.secret}`, expect.objectContaining({ velexis_environment: "test" })],
    ]);
    // What the live storefront must not show later is all there now: the guest reads the booking with the cookie
    // checkout.complete set, its checkout and its search, and finds it by reference and name.
    const read = await testGuest.get(`/v1/bookings/${testBooking.bookingId}`);
    expect(answer(read)).toEqual([200, undefined]);
    expectResponseToMatch("getBooking", read);
    const checkout = await testGuest.get(`/v1/checkouts/${testBooking.checkoutId}`);
    expect(answer(checkout)).toEqual([200, undefined]);
    expectResponseToMatch("getCheckout", checkout);
    const search = await testGuest.get(`/v1/flight-searches/${testBooking.searchId}`);
    expect(answer(search)).toEqual([200, undefined]);
    expectResponseToMatch("getFlightSearch", search);
    const found = await new Visitor().post("/v1/bookings/lookup", {
      bookingReference: testBooking.reference,
      lastName: testBooking.lastName,
    });
    expect(answer(found)).toEqual([200, undefined]);
    expectResponseToMatch("lookupBooking", found);
    expect((found.body as { bookingId: string }).bookingId).toBe(testBooking.bookingId);

    // The console: test only, for every role, while alpha is not live (OADR-0011 point 5).
    ownerStaff = new Staff(owner);
    viewerStaff = new Staff(viewer);
    const signedIn = await ownerStaff.signIn();
    expect((signedIn.body as { environments: string[] }).environments).toEqual(["test"]);
    expect(await ownerStaff.bookingIds("test")).toEqual([testBooking.bookingId]);
    const live = await ownerStaff.get("/v1/console/auth/me", "live");
    expect(answer(live)).toEqual([403, "ENVIRONMENT_NOT_ALLOWED"]);
    expectResponseToMatch("consoleGetMe", live);
    await viewerStaff.signIn();
  });

  it("books a signed-in customer on the test storefront: the booking is in their trips", async () => {
    // Customers are shared by test and live: the same account signs in on the live storefront later.
    customerToken = await newCustomerToken();
    customer = new Visitor({ customerToken });
    expect(await tripIds(customer)).toEqual([]);

    customerTestBooking = await book(customer);

    expect(await environmentOf("bookings", customerTestBooking.bookingId)).toBe("test");
    expect(await tripIds(customer)).toEqual([customerTestBooking.bookingId]);
    const read = await customer.get(`/v1/bookings/${customerTestBooking.bookingId}`);
    expect(answer(read)).toEqual([200, undefined]);
    expectResponseToMatch("getBooking", read);
  });
});

// ---- Go-live -------------------------------------------------------------------------------------------------------

describe("go-live (PBE-061's switch and its invalidations)", () => {
  it("[OBE-081 AC1] reports environment live within one second of the tenant invalidation, and searches through the live connection (the stub on the second port)", async () => {
    const visitor = new Visitor();
    const onCustomDomain = new Visitor({ host: CUSTOM_HOST });
    // Cached afresh: the edge's ways to the tenant (`tenantkey:alpha`, `host:<custom domain>`) and the tenant row they
    // lead to are filled here for their whole 60 s, so nothing but the invalidation can end them during this test.
    const cachedKeys = [
      redisKeys.tenant(alphaId).key,
      redisKeys.tenantByKey("alpha").key,
      redisKeys.host(CUSTOM_HOST).key,
    ];
    await redis.client.del(...cachedKeys);
    expect((await visitor.storefront()).environment).toBe("test");
    expect((await onCustomDomain.storefront()).environment).toBe("test");
    expect(await redis.client.exists(...cachedKeys)).toBe(cachedKeys.length);

    // PBE-061 step 2: one transaction, then the invalidations after the commit.
    await migrator.transaction().execute(async (trx) => {
      await trx
        .updateTable("platform.tenants")
        .set({
          storefront_environment: "live",
          live_enabled_at: new Date(),
          live_enabled_by_account_id: owner.accountId,
          version: sql<number>`version + 1`,
          updated_at: new Date(),
        })
        .where("id", "=", alphaId)
        .execute();
      livePaymentConnectionId = await insertPaymentConnection(alphaId, "live", trx);
    });
    // Until the platform's event, the cached row still serves.
    expect((await visitor.storefront()).environment).toBe("test");
    expect((await onCustomDomain.storefront()).environment).toBe("test");

    await publish({ v: 1, type: "tenant", id: alphaId });
    await publish({ v: 1, type: "connection", tenantId: alphaId });
    // The acceptance bound: the next storefront.get after the subscriber dropped the row reports live.
    await vi.waitFor(
      async () => {
        expect((await visitor.storefront()).environment).toBe("live");
      },
      { timeout: 1000, interval: 20 },
    );

    const storefront = await visitor.storefront();
    expect(storefront).toMatchObject({
      environment: "live",
      payment: {
        environment: "live",
        accountMode: "velexis",
        publishableKey: VELEXIS_KEYS.live.publishable,
        supportedMethods: ["card"],
      },
    });
    // A live storefront may be indexed (the settings' robots, on by default).
    expect(storefront.seo.robots.index).toBe(true);
    // The custom domain is live with the sub-domain: its cached `host:` entry holds the tenant id, not the row.
    expect(await redis.client.exists(redisKeys.host(CUSTOM_HOST).key)).toBe(1);
    expect((await onCustomDomain.storefront()).environment).toBe("live");

    // The next search goes to the live Amadeus connection: the second stub, with the live account's credentials and
    // office; the test stub sees nothing.
    stubs.test.clearRequests();
    stubs.live.clearRequests();
    const { searchId } = await searchAndPrice(visitor);
    expect(await environmentOf("flight_searches", searchId)).toBe("live");
    expect(stubOperations("live")).toEqual(
      expect.arrayContaining(["oauth2Token", "getFlightOffers", "quoteAirOffers"]),
    );
    expect(stubOperations("test")).toEqual([]);
  });

  it("[OBE-081 AC2] never shows the test bookings on the live storefront: not with the guest cookie, not by lookup, not its checkout or search, not in the customer's trips", async () => {
    const lookup = { bookingReference: testBooking.reference, lastName: testBooking.lastName };
    // The console's environment header does not choose the edge's environment (the tenant row does): a browser that
    // sends it through Caddy is still on the live storefront.
    const askTest = { "X-Velexis-Environment": "test" };
    const answers = [
      [await testGuest.get(`/v1/bookings/${testBooking.bookingId}`), "getBooking"],
      [await testGuest.get(`/v1/bookings/${testBooking.bookingId}`, askTest), "getBooking"],
      [await new Visitor().post("/v1/bookings/lookup", lookup), "lookupBooking"],
      [await new Visitor().post("/v1/bookings/lookup", lookup, askTest), "lookupBooking"],
      [await new Visitor({ host: CUSTOM_HOST }).post("/v1/bookings/lookup", lookup), "lookupBooking"],
      [await testGuest.get(`/v1/checkouts/${testBooking.checkoutId}`), "getCheckout"],
      [await testGuest.get(`/v1/flight-searches/${testBooking.searchId}`), "getFlightSearch"],
      [await customer.get(`/v1/bookings/${customerTestBooking.bookingId}`), "getBooking"],
    ] as const;

    // The same answer as an unknown id (the booking access guard, guest lookup, checkout and search reads).
    for (const [res, operationId] of answers) {
      expect(answer(res)).toEqual([404, "NOT_FOUND"]);
      expectResponseToMatch(operationId, res);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    // The same customer, signed in on the live storefront, has no trips there.
    expect(await tripIds(customer)).toEqual([]);
    // The bookings themselves are still there, in test.
    expect(
      await Promise.all([
        environmentOf("bookings", testBooking.bookingId),
        environmentOf("bookings", customerTestBooking.bookingId),
      ]),
    ).toEqual(["test", "test"]);
  });

  let liveBooking: Booked;

  it("books a guest on the live storefront through the live Amadeus connection and the Velexis live keys", async () => {
    const guest = new Visitor();
    stubs.test.clearRequests();
    stubs.live.clearRequests();
    stripe.reset();

    liveBooking = await book(guest);

    expect(
      await Promise.all([
        environmentOf("checkouts", liveBooking.checkoutId),
        environmentOf("payments", liveBooking.paymentId),
        environmentOf("bookings", liveBooking.bookingId),
      ]),
    ).toEqual(["live", "live", "live"]);
    // The order was created on the live stub, for the live office.
    expect(stubOperations("live")).toContain("createFlightOrders");
    expect(stubOperations("test")).toEqual([]);
    const created = stubs.live.requests().find((req) => req.operation === "createFlightOrders");
    expect(created?.status).toBe(201);
    const order = await alphaTx((trx) =>
      trx
        .selectFrom("bookings")
        .select("amadeus_order_id")
        .where("id", "=", liveBooking.bookingId)
        .executeTakeFirstOrThrow(),
    );
    const stored = stubs.live.orders.list().find((candidate) => candidate.id === order.amadeus_order_id);
    expect([stored?.queuingOfficeId, stored?.ownerOfficeId]).toEqual([OFFICES.live, OFFICES.live]);
    expect(stubs.test.orders.list().map((candidate) => candidate.id)).not.toContain(order.amadeus_order_id);
    // Every Stripe call went with the Velexis account's live key, the PaymentIntent tagged live.
    expect(intentCreations()).toEqual([
      [`Bearer ${VELEXIS_KEYS.live.secret}`, expect.objectContaining({ velexis_environment: "live" })],
    ]);
    expect(stripe.requests.map((req) => req.headers["authorization"])).toEqual(
      stripe.requests.map(() => `Bearer ${VELEXIS_KEYS.live.secret}`),
    );
    expect(stripe.intents.get(liveBooking.intentId)?.status).toBe("succeeded");
    // The live guest reads it with the cookie checkout.complete set.
    const read = await guest.get(`/v1/bookings/${liveBooking.bookingId}`);
    expect(answer(read)).toEqual([200, undefined]);
    expectResponseToMatch("getBooking", read);
  });

  it("[OBE-081 AC2] offers live to non-viewers in console.auth.me, and the live console reads live rows only", async () => {
    // The session opened before go-live: console.auth.me follows the tenant row.
    const me = await ownerStaff.get("/v1/console/auth/me", "test");
    expect(answer(me)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetMe", me);
    expect((me.body as { environments: string[] }).environments).toEqual(["test", "live"]);
    const liveMe = await ownerStaff.get("/v1/console/auth/me", "live");
    expect(answer(liveMe)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetMe", liveMe);
    expect(liveMe.body).toMatchObject({
      environments: ["test", "live"],
      tenant: { environment: "live", supplier: { connected: true, officeIds: [OFFICES.live] } },
    });
    // A new sign-in says so too.
    const fresh = new Staff(owner);
    expect(((await fresh.signIn("live")).body as { environments: string[] }).environments).toEqual([
      "test",
      "live",
    ]);

    // The live console: the live booking only; the test bookings are unknown there.
    expect(await ownerStaff.bookingIds("live")).toEqual([liveBooking.bookingId]);
    for (const { bookingId } of [testBooking, customerTestBooking]) {
      const testFromLive = await ownerStaff.get(`/v1/console/bookings/${bookingId}`, "live");
      expect(answer(testFromLive)).toEqual([404, "NOT_FOUND"]);
      expectResponseToMatch("consoleGetBooking", testFromLive);
    }
    const own = await ownerStaff.get(`/v1/console/bookings/${liveBooking.bookingId}`, "live");
    expect(answer(own)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetBooking", own);
    expect(own.body).toMatchObject({ id: liveBooking.bookingId, environment: "live" });
    // The test console keeps the test bookings, without the live one.
    expect(sorted(await ownerStaff.bookingIds("test"))).toEqual(testBookingIds());
    // So do the payments and the supplier log: each console holds its own environment's rows only.
    expect([
      await ownerStaff.listIds("consoleListPayments", "live"),
      sorted(await ownerStaff.listIds("consoleListPayments", "test")),
    ]).toEqual([[liveBooking.paymentId], sorted([testBooking.paymentId, customerTestBooking.paymentId])]);
    const supplierCalls = (booking: Booked, environment: Environment) =>
      ownerStaff.listIds("consoleListSupplierRequests", environment, `&bookingId=${booking.bookingId}`);
    expect(await supplierCalls(testBooking, "live")).toEqual([]);
    expect(await supplierCalls(liveBooking, "test")).toEqual([]);
    expect((await supplierCalls(testBooking, "test")).length).toBeGreaterThan(0);
    expect((await supplierCalls(liveBooking, "live")).length).toBeGreaterThan(0);

    // A viewer stays in test (OADR-0011 point 5).
    const viewerMe = await viewerStaff.get("/v1/console/auth/me", "test");
    expect(answer(viewerMe)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetMe", viewerMe);
    expect((viewerMe.body as { environments: string[] }).environments).toEqual(["test"]);
    const viewerLive = await viewerStaff.get("/v1/console/bookings?limit=100", "live");
    expect(answer(viewerLive)).toEqual([403, "ENVIRONMENT_NOT_ALLOWED"]);
    expectResponseToMatch("consoleListBookings", viewerLive);
  });
});

// ---- Live Stripe keys (step 3) -------------------------------------------------------------------------------------

describe("the Velexis live keys are needed only for velexis and connect_standard (an API without them)", () => {
  it("serves a live tenant on its own Stripe account (api_keys) without them, and answers 424 for velexis and connect_standard", async () => {
    const visitor = new Visitor({ app: withoutLiveKeys });
    const { checkoutId } = await newCheckout(visitor);

    // velexis (go-live's row) and connect_standard both use the Velexis account's live keys: none here.
    for (const mode of ["velexis", "connect_standard"] as const) {
      await switchLiveConnection(mode);
      stripe.reset();
      const storefront = await visitor.storefront();
      expect(storefront.payment).toMatchObject({ environment: "live", supportedMethods: [] });
      const refused = await createPayment(visitor, checkoutId);
      expect(answer(refused)).toEqual([424, "PAYMENT_PROVIDER_NOT_CONFIGURED"]);
      expectResponseToMatch("createCheckoutPayment", refused);
      expect(stripe.requests).toEqual([]);
    }

    // api_keys: the OTA's own live key and publishable key; the Velexis live keys are not needed.
    await switchLiveConnection("api_keys");
    stripe.reset();
    expect((await visitor.storefront()).payment).toMatchObject({
      environment: "live",
      accountMode: "api_keys",
      publishableKey: OTA_LIVE_PUBLISHABLE_KEY,
      supportedMethods: ["card"],
    });
    const paid = await createPayment(visitor, checkoutId);
    expect(answer(paid)).toEqual([201, undefined]);
    expectResponseToMatch("createCheckoutPayment", paid);
    expect((paid.body as { providerPublicKey: string }).providerPublicKey).toBe(OTA_LIVE_PUBLISHABLE_KEY);
    expect(intentCreations()).toEqual([
      [`Bearer ${OTA_LIVE_SECRET_KEY}`, expect.objectContaining({ velexis_environment: "live" })],
    ]);
    // The OTA's decrypted key never reaches a log line.
    expect(withoutLiveKeys.sink.text()).not.toContain(OTA_LIVE_SECRET_KEY);
    expect(api.sink.text()).not.toContain(OTA_LIVE_SECRET_KEY);
  });

  it("serves velexis and connect_standard on the Velexis live keys where the environment file has them", async () => {
    const visitor = new Visitor();
    const { checkoutId } = await newCheckout(visitor);
    await switchLiveConnection("connect_standard");
    stripe.reset();

    expect((await visitor.storefront()).payment).toMatchObject({
      environment: "live",
      accountMode: "connect_standard",
      publishableKey: VELEXIS_KEYS.live.publishable,
      supportedMethods: ["card"],
    });
    const paid = await createPayment(visitor, checkoutId);

    expect(answer(paid)).toEqual([201, undefined]);
    expectResponseToMatch("createCheckoutPayment", paid);
    expect(
      stripe.requests.map((req) => [req.headers["authorization"], req.headers["stripe-account"]]),
    ).toEqual([[`Bearer ${VELEXIS_KEYS.live.secret}`, CONNECT_ACCOUNT]]);
    // No secret of the file (the Velexis account's keys, the OTA's, the customer's token) reaches a log line of either
    // API.
    const secrets = [
      VELEXIS_KEYS.test.secret,
      VELEXIS_KEYS.live.secret,
      OTA_LIVE_SECRET_KEY,
      OTA_LIVE_WEBHOOK_SECRET,
      customerToken,
    ];
    for (const text of [api.sink.text(), withoutLiveKeys.sink.text()]) {
      for (const secret of secrets) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
