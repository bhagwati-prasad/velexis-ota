// Customer isolation between two OTAs, between two customers of one OTA, and between a live storefront and the test
// environment (OBE-057 step 3; ota/docs/scope.md OF-01 AC2, OF-03 and OF-07, OADR-0006 points 1 and 6, ADR-0004,
// ADR-0008, ota/docs/flows/my-bookings-and-guest-lookup.md §4 and §7, docs/mvp/conventions.md §12), through the API's
// whole pipeline against PostgreSQL 16, Redis 7, the Amadeus stub and the fake Stripe API.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: alpha sells on a test storefront, beta on a live one (`storefront_environment = live`), both on
// the Velexis test Amadeus account (the stub) with the `velexis` test Stripe connection and a secret test key; beta also
// has a live secret key. Their settings are seeded as provisioning seeds them, with the airline card on in every
// environment (AIRLINE_CARD_ENABLED=true), so that a completion with the airline card reaches the checkout it names.
// Customers are inserted as sign-up leaves them, with one made-up password (one Argon2id hash), and sign in through the
// API: their storefront cookies (a browser's jar) and their bearer tokens are real sessions.
//
// Each OTA then gets, through the API, what a customer and a guest leave behind: alpha's customer books with alpha's
// key (search, offer, priced offer, checkout, payment, booking) and its guest books on alpha's storefront (the
// `__Host-vx_bt` cookie) and looks the booking up with the key (`X-Booking-Token`); beta's customer and guest book with
// beta's test key, so their bookings are test bookings of an OTA whose storefront is live. Each customer booking gets a
// ready itinerary, written as the document render writes it, and a signed download URL from the API.
//
// The scenarios run in `beforeAll` hooks with budgets of their own; the tests read what they answered:
//
//   - credentials of one OTA at the other, both ways: the customer's cookies at the other storefront and its bearer
//     token with the other's key, on every operation that reads them (the customer guard's sweep, placeholder ids:
//     the guard answers before validation), its refresh token, and its guest cookie and guest token on the bookings
//     and payments of both OTAs;
//   - ids of one OTA at the other, both ways, with the other OTA's own valid credentials and complete, valid requests
//     (so a refusal can only come from the lookup): searches, offers, priced offers, checkouts, payments, bookings,
//     documents, signed file URLs and the lookup by reference; the same ids answer at their own OTA;
//   - beta's test bookings from its live storefront and with its live key (OBE-046 AC2's rule, end to end);
//   - another customer of the same OTA on the customer's checkout, payment and bookings;
//   - a deleted customer's kept cookies and bearer token on every customer operation (FIX-W29-SECURITY, lead addition
//     to OBE-057), at its own OTA and at the other, and its kept refresh token and password, which open no session;
//   - the one-time e-mail tokens and a sign-out by refresh token of one OTA at the other: no access to anything, the
//     contract's answer for an unknown token, and the token or session still works at its own OTA.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OtaOperationId } from "@velexis/api-types/operations";
import { encryptValue, generateToken, hashApiKey, sha256Hex, type KeyProvider } from "@velexis/crypto";
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
import { LocalDiskStorage } from "@velexis/db/storage";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  customerRequirements,
  INACTIVE_CUSTOMER_OPERATIONS,
  type CustomerCaller,
} from "../../../src/common/auth/customer.guard";
import { parseBookingTokens, STOREFRONT_COOKIES } from "../../../src/common/http/cookie-writer";
import { loadOpenApiDocument } from "../../../src/common/http/openapi-validation.interceptor";
import { PENDING_OPERATIONS } from "../../../src/common/http/pending-operations";
import { newId } from "../../../src/common/ids";
import { hashCustomerPassword } from "../../../src/identity/sign-in.service";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildStripeConfirmation } from "../../builders/bookings";
import {
  buildContactInput,
  buildRemarkInput,
  buildTravelerInput,
  dateFromToday,
} from "../../builders/checkouts";
import {
  edgeHeaders,
  newApiKey,
  newCsrfToken,
  testApiCredentials,
  testKeyProvider,
} from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/**
 * Cloning the template, hashing the test password with Argon2id (19 MiB), starting the stub, the fake Stripe API and
 * the API's graph (it parses the OTA document and compiles its validators): a few seconds alone, more on a busy 4-CPU
 * CI runner. The bound only stops a start that hangs.
 */
const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/**
 * A scenario hook: the bookings of both OTAs (four whole checkouts through the stub and the fake Stripe API), a few
 * sign-ins (Argon2id) and sweeps of a few hundred requests: seconds locally; the bound allows for CI load and only
 * stops a hook that hangs.
 */
const SCENARIO_TIMEOUT_MS = 120_000;

const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const TERMS_VERSION = "2026-09-01";
const PRIVACY_VERSION = "2026-08-15";
const DAY_MS = 86_400_000;

/** The password of every inserted customer, made up for this run, and its Argon2id hash (made once, below). */
const PASSWORD = `Fjord-${randomBytes(9).toString("base64url")}`;
let passwordHash = "";

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const STRIPE_SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const STRIPE_PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

/** Test data only: Visa's documented test PAN and a made-up security code, three years ahead. */
const TEST_PAN = "4111111111111111";
const cardOf = (): Record<string, unknown> => ({
  brand: "VISA",
  holderName: "Anna Berg",
  number: TEST_PAN,
  expiryMonth: 12,
  expiryYear: new Date().getUTCFullYear() + 3,
  securityCode: "123",
});

const quietPoolLogger = { error: (): void => undefined };

type Method = "get" | "post" | "put" | "patch" | "delete";

/** An OTA of this file. */
interface Tenant {
  readonly key: "alpha" | "beta";
  readonly schema: "tenant_alpha" | "tenant_beta";
  /** The storefront's host (its sub-domain), which Caddy forwards as `X-Velexis-Host`. */
  readonly host: string;
  /** The environment its storefront serves. */
  readonly storefront: "test" | "live";
  id: string;
  testSk: string;
  liveSk: string;
}

const alpha: Tenant = {
  key: "alpha",
  schema: "tenant_alpha",
  host: "alpha.ota.example.com",
  storefront: "test",
  id: "",
  testSk: "",
  liveSk: "",
};
const beta: Tenant = {
  key: "beta",
  schema: "tenant_beta",
  host: "beta.ota.example.com",
  storefront: "live",
  id: "",
  testSk: "",
  liveSk: "",
};

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let stripe: FakeStripe;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let storageDir: string;
let storage: LocalDiskStorage;

const inTenant = <T>(tenant: Tenant, fn: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, tenant.schema, fn);

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one client, so the per-IP limits never mix the clients. */
const newIp = (): string => {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
};

// ---- The callers ----------------------------------------------------------------------------------------------------

/** A client of the API: a storefront's browser (edge) or a storefront's server with a key. */
interface Caller {
  call(
    operationId: OtaOperationId,
    method: Method,
    path: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<Response>;
}

async function send(
  method: Method,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  const sent = request(api.server)[method](path).set(headers);
  return method === "get" || method === "delete" ? await sent : await sent.send(body as object);
}

const cookieHeader = (jar: ReadonlyMap<string, string>): string =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

/** The browser of one visitor of `host`'s storefront: the cookies the API set, sent back on every request. */
class Visitor implements Caller {
  readonly jar = new Map<string, string>([[STOREFRONT_COOKIES.csrf, newCsrfToken()]]);
  readonly ip = newIp();

  constructor(readonly host: string) {}

  /** A browser of `host` that holds a copy of `jar` (another storefront's cookies, or cookies kept from before). */
  static holding(host: string, jar: ReadonlyMap<string, string>): Visitor {
    const visitor = new Visitor(host);
    for (const [name, value] of jar) {
      visitor.jar.set(name, value);
    }
    return visitor;
  }

  headers(write: boolean): Record<string, string> {
    return {
      ...edgeHeaders(this.host),
      "X-Forwarded-For": this.ip,
      "User-Agent": "Mozilla/5.0 (storefront isolation test)",
      Cookie: cookieHeader(this.jar),
      ...(write
        ? { Origin: `https://${this.host}`, "X-CSRF-Token": this.jar.get(STOREFRONT_COOKIES.csrf) ?? "" }
        : {}),
    };
  }

  /** Keeps what an answer set: a cookie with `Max-Age=0` is removed, as a browser does. */
  remember(res: Response): void {
    const header = res.headers["set-cookie"] as unknown;
    for (const line of Array.isArray(header) ? (header as string[]) : []) {
      const [pair = "", ...attributes] = line.split("; ");
      const index = pair.indexOf("=");
      if (attributes.includes("Max-Age=0")) {
        this.jar.delete(pair.slice(0, index));
      } else {
        this.jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
    }
  }

  async call(
    _operationId: OtaOperationId,
    method: Method,
    path: string,
    body: unknown = {},
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const res = await send(
      method,
      path,
      {
        ...this.headers(method !== "get"),
        ...(method === "post" ? { "Idempotency-Key": randomUUID() } : {}),
        ...headers,
      },
      body,
    );
    this.remember(res);
    return res;
  }
}

/** A storefront's server with a secret key, calling for one visitor (bearer mode). */
class KeyClient implements Caller {
  readonly ip = newIp();
  /** The visitor's customer access token, sent as `Authorization: Bearer` while set. */
  accessToken: string | undefined;
  /** The visitor's refresh token. */
  refreshToken: string | undefined;
  /** The visitor's guest booking token, sent as `X-Booking-Token` while set. */
  bookingToken: string | undefined;

  constructor(readonly apiKey: string) {}

  /** A server with `apiKey` that holds a copy of another client's tokens. */
  static holding(apiKey: string, other: KeyClient): KeyClient {
    const client = new KeyClient(apiKey);
    client.accessToken = other.accessToken;
    client.refreshToken = other.refreshToken;
    client.bookingToken = other.bookingToken;
    return client;
  }

  async call(
    _operationId: OtaOperationId,
    method: Method,
    path: string,
    body: unknown = {},
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    return await send(
      method,
      path,
      {
        "X-Api-Key": this.apiKey,
        "X-Velexis-End-User-IP": this.ip,
        "X-Velexis-End-User-Agent": "Mozilla/5.0 (third-party storefront test)",
        ...(this.accessToken === undefined ? {} : { Authorization: `Bearer ${this.accessToken}` }),
        ...(this.bookingToken === undefined ? {} : { "X-Booking-Token": this.bookingToken }),
        ...(method === "post" ? { "Idempotency-Key": randomUUID() } : {}),
        ...headers,
      },
      body,
    );
  }
}

/** `[status, error code]` of an answer (`undefined` code for a success). */
const outcome = (res: Response): [number, unknown] => [
  res.status,
  (res.body as { error?: { code?: unknown } } | undefined)?.error?.code,
];

/** A string field of an answer that the next step needs; throws with the step's status and code when it is missing. */
function required(res: Response, what: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${what} answered ${res.status} (${String(outcome(res)[1])}); the scenario cannot go on`);
  }
  return value;
}

/** Minor units of a decimal amount with two decimals (`"110.47"` → 11047), without a JS number in between. */
function minorUnits(amount: string): number {
  const [units = "0", cents = ""] = amount.split(".");
  return Number.parseInt(`${units}${cents.padEnd(2, "0").slice(0, 2)}`, 10);
}

// ---- The fixtures ---------------------------------------------------------------------------------------------------

async function insertAmadeusAccount(clientId: string, secret: string): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(secret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${id}`,
    keys,
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id,
      name: "Velexis test",
      environment: "test",
      base_url: "https://test.travel.api.amadeus.com",
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

async function issueKey(tenant: Tenant, environment: "test" | "live"): Promise<string> {
  const key = newApiKey("sk", environment);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenant.id,
      name: `Server (${environment})`,
      kind: "secret",
      environment,
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
    })
    .execute();
  return key;
}

/** An OTA's platform rows (tenant, Amadeus and Stripe test connections, keys) and its seeded settings. */
async function insertTenant(tenant: Tenant, accountId: string): Promise<void> {
  tenant.id = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: tenant.id,
      key: tenant.key,
      name: `${tenant.key} Travel`,
      status: "active",
      plan_code: "early_access",
      ...(tenant.storefront === "live"
        ? { storefront_environment: "live", live_enabled_at: new Date() }
        : {}),
    })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: tenant.id,
      environment: "test",
      credential_source: "velexis",
      amadeus_account_id: accountId,
      office_ids: [office],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      status: "active",
    })
    .execute();
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id: newId("ppc"),
      tenant_id: tenant.id,
      provider: "stripe",
      environment: "test",
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
      statement_descriptor_suffix: `${tenant.key.toUpperCase()} TRAVEL`,
    })
    .execute();
  tenant.testSk = await issueKey(tenant, "test");
  tenant.liveSk = await issueKey(tenant, "live");
  await inTenant(tenant, async (trx) => {
    await seedStorefrontSettings(trx, {
      name: `${tenant.key} Travel`,
      defaultCurrency: "EUR",
      defaultLocale: "en",
    });
    await seedDefaultMarkupRule(trx);
    await trx
      .updateTable("storefront_settings")
      .set({
        terms_version: TERMS_VERSION,
        privacy_version: PRIVACY_VERSION,
        airline_card_enabled_test: true,
        airline_card_enabled_live: true,
      })
      .execute();
  });
}

/** Inserts an active, verified customer of `tenant` with a password identity (PASSWORD); its id and address. */
async function insertCustomer(
  tenant: Tenant,
  label: string,
  verified = true,
): Promise<{ readonly id: string; readonly email: string }> {
  const id = newId("cus");
  const email = `${label}-${randomBytes(4).toString("hex")}@example.com`;
  await inTenant(tenant, async (trx) => {
    await trx
      .insertInto("customers")
      .values({
        id,
        email,
        status: "active",
        first_name: "Anna",
        last_name: "Berg",
        email_verified_at: verified ? new Date() : null,
      })
      .execute();
    await trx
      .insertInto("customer_identities")
      .values({
        id: newId("cid"),
        customer_id: id,
        provider: "password",
        provider_subject: email,
        password_hash: passwordHash,
        email,
        email_verified_at: verified ? new Date() : null,
      })
      .execute();
  });
  return { id, email };
}

/** A customer signed in on `tenant`'s storefront (cookies) and through its test key (bearer tokens). */
interface SignedIn {
  readonly id: string;
  readonly email: string;
  readonly browser: Visitor;
  readonly server: KeyClient;
}

async function signedIn(tenant: Tenant, label: string): Promise<SignedIn> {
  const { id, email } = await insertCustomer(tenant, label);
  const browser = new Visitor(tenant.host);
  const edge = await browser.call("signIn", "post", "/v1/auth/sign-in", { email, password: PASSWORD });
  required(edge, `${label}: edge sign-in`, browser.jar.get(STOREFRONT_COOKIES.accessToken));
  const server = new KeyClient(tenant.testSk);
  const bearer = await server.call("signIn", "post", "/v1/auth/sign-in", { email, password: PASSWORD });
  const session = (bearer.body as { session?: { accessToken?: string; refreshToken?: string } }).session;
  server.accessToken = required(bearer, `${label}: bearer sign-in`, session?.accessToken);
  server.refreshToken = session?.refreshToken;
  return { id, email, browser, server };
}

/** What a booking of an OTA left behind, with the ids of every step that led to it. */
interface Booked {
  readonly tenant: Tenant;
  readonly searchId: string;
  readonly offerId: string;
  readonly pricedOfferId: string;
  readonly checkoutId: string;
  readonly paymentId: string;
  readonly bookingId: string;
  readonly reference: string;
  /** A guest booking's token: in a guest cookie entry for the edge, `X-Booking-Token` for keys. */
  bookingToken?: string;
  /** A customer booking's ready itinerary and the path of its signed URL. */
  documentId?: string;
  filePath?: string;
}

let searchCount = 0;

/** A whole checkout of `caller` at `tenant` (its customer's, or a guest's), paid by card and completed. */
async function book(tenant: Tenant, caller: Caller): Promise<Booked> {
  searchCount += 1;
  const searched = await caller.call("createFlightSearch", "post", "/v1/flight-searches", {
    mode: "simple",
    originLocationCode: "MAD",
    destinationLocationCode: "ORY",
    departureDate: dateFromToday(60 + searchCount),
    adults: 1,
  });
  const searchId = required(searched, "createFlightSearch", (searched.body as { id?: unknown }).id);
  // The stub's flights moved 60 days ahead, as a priced offer must still be sellable.
  const offerId = await inTenant(tenant, async (trx) => {
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
  const priced = await caller.call("priceFlightOffers", "post", "/v1/priced-offers", { offerIds: [offerId] });
  const pricedOfferId = required(priced, "priceFlightOffers", (priced.body as { id?: unknown }).id);
  const created = await caller.call("createCheckout", "post", "/v1/checkouts", { pricedOfferId });
  const checkoutId = required(created, "createCheckout", (created.body as { id?: unknown }).id);
  await caller.call("setCheckoutTravelers", "put", `/v1/checkouts/${checkoutId}/travelers`, {
    travelers: [buildTravelerInput()],
  });
  await caller.call("setCheckoutContacts", "put", `/v1/checkouts/${checkoutId}/contacts`, {
    contacts: [buildContactInput()],
  });
  const paid = await caller.call("createCheckoutPayment", "post", `/v1/checkouts/${checkoutId}/payments`, {
    method: "card",
    termsAccepted: true,
  });
  const payment = paid.body as {
    id?: string;
    amount?: { amount: string };
    providerPaymentId?: string | null;
  };
  const paymentId = required(paid, "createCheckoutPayment", payment.id);
  stripe.update(
    payment.providerPaymentId ?? "",
    buildStripeConfirmation(minorUnits(payment.amount?.amount ?? "0")),
  );
  const completed = await caller.call("completeCheckout", "post", `/v1/checkouts/${checkoutId}/complete`);
  const booking = (completed.body as { booking?: { id?: string; reference?: string } }).booking;
  const token = (completed.body as { bookingToken?: string | null }).bookingToken;
  return {
    tenant,
    searchId,
    offerId,
    pricedOfferId,
    checkoutId,
    paymentId,
    bookingId: required(completed, "completeCheckout", booking?.id),
    reference: required(completed, "completeCheckout", booking?.reference),
    ...(typeof token === "string" ? { bookingToken: token } : {}),
  };
}

/** A ready itinerary of `booked`, as the document render writes it (the row and its file); its id. */
async function insertItinerary(booked: Booked): Promise<string> {
  const id = newId("doc");
  const storageKey = `${booked.tenant.schema}/documents/${booked.bookingId}/${id}.pdf`;
  const bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(64), Buffer.from("\n%%EOF\n")]);
  await storage.put(storageKey, bytes, "application/pdf");
  await inTenant(booked.tenant, (trx) =>
    trx
      .insertInto("booking_documents")
      .values({
        id,
        booking_id: booked.bookingId,
        kind: "itinerary",
        status: "ready",
        locale: "en",
        file_name: "itinerary.pdf",
        content_type: "application/pdf",
        size_bytes: bytes.length,
        storage_key: storageKey,
        content_hash: createHash("sha256").update(bytes).digest("hex"),
        generated_by: "system",
      })
      .execute(),
  );
  return id;
}

// ---- The requests ---------------------------------------------------------------------------------------------------

/** One request of a scenario: its operation, method, path and, for a write, a complete and valid body. */
interface IdRequest {
  readonly operationId: OtaOperationId;
  readonly method: Method;
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Every operation on the ids of a customer's booking (`owned`) and its guest booking (`guest`), with valid inputs. */
function idRequests(owned: Booked, guest: Booked): IdRequest[] {
  const booking = `/v1/bookings/${owned.bookingId}`;
  return [
    { operationId: "getFlightSearch", method: "get", path: `/v1/flight-searches/${owned.searchId}` },
    {
      operationId: "listFlightSearchResults",
      method: "get",
      path: `/v1/flight-searches/${owned.searchId}/offers`,
    },
    { operationId: "getFlightOffer", method: "get", path: `/v1/flight-offers/${owned.offerId}` },
    {
      operationId: "upsellFlightOffer",
      method: "post",
      path: `/v1/flight-offers/${owned.offerId}/upsells`,
      body: {},
    },
    {
      operationId: "priceFlightOffers",
      method: "post",
      path: "/v1/priced-offers",
      body: { offerIds: [owned.offerId] },
    },
    { operationId: "getPricedOffer", method: "get", path: `/v1/priced-offers/${owned.pricedOfferId}` },
    {
      operationId: "getPricedOfferAncillaries",
      method: "get",
      path: `/v1/priced-offers/${owned.pricedOfferId}/ancillaries`,
    },
    {
      operationId: "getPricedOfferFareRules",
      method: "get",
      path: `/v1/priced-offers/${owned.pricedOfferId}/fare-rules`,
    },
    {
      operationId: "createCheckout",
      method: "post",
      path: "/v1/checkouts",
      body: { pricedOfferId: owned.pricedOfferId },
    },
    ...checkoutRequests(owned),
    { operationId: "getPayment", method: "get", path: `/v1/payments/${guest.paymentId}` },
    ...bookingRequests(owned),
    ...bookingRequests(guest),
    {
      operationId: "getBookingDocumentDownloadUrl",
      method: "get",
      path: `${booking}/documents/${owned.documentId ?? ""}/download-url`,
    },
    { operationId: "downloadFile", method: "get", path: owned.filePath ?? "" },
    {
      operationId: "lookupBooking",
      method: "post",
      path: "/v1/bookings/lookup",
      body: { bookingReference: guest.reference, lastName: "Sample" },
    },
    {
      operationId: "lookupBooking",
      method: "post",
      path: "/v1/bookings/lookup",
      body: { bookingReference: owned.reference, lastName: "Sample" },
    },
  ];
}

/** Every operation on a checkout and its payment, with valid inputs. */
function checkoutRequests(owned: Booked): IdRequest[] {
  const checkout = `/v1/checkouts/${owned.checkoutId}`;
  return [
    { operationId: "getCheckout", method: "get", path: checkout },
    {
      operationId: "setCheckoutTravelers",
      method: "put",
      path: `${checkout}/travelers`,
      body: { travelers: [buildTravelerInput()] },
    },
    {
      operationId: "setCheckoutContacts",
      method: "put",
      path: `${checkout}/contacts`,
      body: { contacts: [buildContactInput()] },
    },
    {
      operationId: "setCheckoutAncillaries",
      method: "put",
      path: `${checkout}/ancillaries`,
      body: { selections: [] },
    },
    {
      operationId: "setCheckoutRemarks",
      method: "put",
      path: `${checkout}/remarks`,
      body: { remarks: [buildRemarkInput()] },
    },
    {
      operationId: "createCheckoutPayment",
      method: "post",
      path: `${checkout}/payments`,
      body: { method: "card", termsAccepted: true },
    },
    { operationId: "getPayment", method: "get", path: `/v1/payments/${owned.paymentId}` },
    {
      operationId: "updatePayment",
      method: "patch",
      path: `/v1/payments/${owned.paymentId}`,
      body: { card: { brand: "VISA", bin: TEST_PAN.slice(0, 6) } },
    },
    { operationId: "completeCheckout", method: "post", path: `${checkout}/complete`, body: {} },
    {
      operationId: "completeCheckoutWithAirlineCard",
      method: "post",
      path: `${checkout}/airline-card-completion`,
      body: {
        paymentId: owned.paymentId,
        expectedTotal: { amount: "100.00", currency: "EUR" },
        card: cardOf(),
      },
    },
  ];
}

/** Every operation on a booking, with valid inputs. */
function bookingRequests(owned: Booked): IdRequest[] {
  const booking = `/v1/bookings/${owned.bookingId}`;
  return [
    { operationId: "getBooking", method: "get", path: booking },
    {
      operationId: "updateBooking",
      method: "patch",
      path: booking,
      body: { contacts: [buildContactInput()] },
      headers: { "If-Match": '"1"' },
    },
    { operationId: "quoteBookingCancellation", method: "get", path: `${booking}/cancellation-quote` },
    {
      operationId: "cancelBooking",
      method: "post",
      path: `${booking}/cancellation`,
      body: { reasonCode: "change_of_plans", expectedRefund: { amount: "100.00", currency: "EUR" } },
      headers: { "If-Match": '"1"' },
    },
    { operationId: "getBookingFareRules", method: "get", path: `${booking}/fare-rules` },
    { operationId: "getBookingTicketingStatus", method: "get", path: `${booking}/ticketing` },
    { operationId: "listBookingEvents", method: "get", path: `${booking}/events` },
    { operationId: "listBookingDocuments", method: "get", path: `${booking}/documents` },
  ];
}

/** What one request of a scenario answered. */
interface Answer {
  readonly label: string;
  readonly operationId: OtaOperationId;
  readonly res: Response;
}

/** Sends every request of `requests` as `caller` (the edge-only airline card left out for a key caller). */
async function sendAll(label: string, caller: Caller, requests: readonly IdRequest[]): Promise<Answer[]> {
  const answers: Answer[] = [];
  for (const entry of requests) {
    if (caller instanceof KeyClient && entry.operationId === "completeCheckoutWithAirlineCard") {
      continue;
    }
    const res = await caller.call(entry.operationId, entry.method, entry.path, entry.body, entry.headers);
    answers.push({ label, operationId: entry.operationId, res });
  }
  return answers;
}

/** One operation of the document on which a caller may present a customer token, its ids a placeholder. */
interface SweptOperation {
  readonly operationId: OtaOperationId;
  readonly method: Method;
  readonly path: string;
}

/**
 * The implemented operations on which `caller` may present a customer's token (its security names the customer's
 * scheme for the caller: required or optional), the ids of their paths a placeholder: the customer guard answers before
 * the request is validated. `inactiveRule` leaves out account.delete, whose idempotent replay the guard lets reach a
 * deleted customer's own deletion (`INACTIVE_CUSTOMER_OPERATIONS`).
 */
function sweptOperations(caller: CustomerCaller, inactiveRule: boolean): SweptOperation[] {
  const document = loadOpenApiDocument().document as { paths: Record<string, Record<string, unknown>> };
  const requirements = customerRequirements(document);
  const operations: SweptOperation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const operationId = (operation as { operationId?: unknown } | null)?.operationId;
      if (
        typeof operationId !== "string" ||
        Object.hasOwn(PENDING_OPERATIONS, operationId) ||
        (inactiveRule && INACTIVE_CUSTOMER_OPERATIONS.has(operationId)) ||
        (requirements.get(operationId)?.[caller] ?? "none") === "none"
      ) {
        continue;
      }
      operations.push({
        operationId: operationId as OtaOperationId,
        method: method as Method,
        path: path.replace(/\{[^}]+\}/g, "x0"),
      });
    }
  }
  return operations;
}

/** Sends every operation of the sweep with an empty body as `caller`. */
async function sweep(
  label: string,
  caller: Caller,
  operations: readonly SweptOperation[],
): Promise<Answer[]> {
  const answers: Answer[] = [];
  for (const operation of operations) {
    const res = await caller.call(
      operation.operationId,
      operation.method,
      operation.path,
      {},
      { "If-Match": '"1"' },
    );
    answers.push({ label, operationId: operation.operationId, res });
  }
  return answers;
}

/** The answers that are not one of `allowed` (`[status, code]`), as `[label, operationId, status, code]`. */
function unexpected(
  answers: readonly Answer[],
  allowed: ReadonlyArray<readonly [number, string]>,
): unknown[] {
  return answers
    .filter(({ res }) => !allowed.some(([status, code]) => res.status === status && outcome(res)[1] === code))
    .map(({ label, operationId, res }) => [label, operationId, ...outcome(res)]);
}

const NOT_FOUND = [404, "NOT_FOUND"] as const;
const UNAUTHENTICATED = [401, "UNAUTHENTICATED"] as const;

/** The reads of the ids at their own OTA that read stored rows only (no Amadeus call). */
const OWN_READS: ReadonlySet<OtaOperationId> = new Set<OtaOperationId>([
  "getFlightSearch",
  "getPricedOffer",
  "getCheckout",
  "getPayment",
  "getBooking",
  "getBookingTicketingStatus",
  "listBookingEvents",
  "listBookingDocuments",
  "getBookingDocumentDownloadUrl",
]);

// ---- Setup ----------------------------------------------------------------------------------------------------------

/** The customers and the bookings of both OTAs. */
let alphaCustomer: SignedIn;
let alphaOther: SignedIn;
let betaCustomer: SignedIn;
let alphaOwned: Booked;
let alphaGuest: Booked;
let betaOwned: Booked;
let betaGuest: Booked;
/** The guest cookie of alpha's guest booking, as alpha's storefront wrote it. */
let alphaGuestCookie = "";

beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators compile on their first check: here, for the statuses checked below.
  const checker = responseChecker("ota");
  for (const operationId of [
    "getBooking",
    "getCheckout",
    "getPayment",
    "listBookings",
    "lookupBooking",
    "createCheckout",
    "completeCheckout",
    "verifyEmail",
    "resetPassword",
    "refreshSession",
    "signIn",
  ] as const) {
    for (const status of [200, 201, 400, 401, 404]) {
      checker.check(operationId, { status, body: {} });
    }
  }
  // The refusals of every operation the sweeps and the scenarios call, so no test compiles one.
  for (const caller of ["edge", "key"] as const) {
    for (const { operationId } of sweptOperations(caller, false)) {
      for (const status of [401, 404]) {
        checker.check(operationId, { status, body: {} });
      }
    }
  }
  [db, redis, keys, stripe, passwordHash] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    testKeyProvider(),
    startFakeStripe(),
    hashCustomerPassword(PASSWORD),
  ]);
  storageDir = mkdtempSync(join(tmpdir(), "velexis-ota-isolation-"));
  storage = new LocalDiskStorage(storageDir);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: quietPoolLogger,
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const clientSecret = randomBytes(24).toString("base64url");
  const accountId = await insertAmadeusAccount(clientId, clientSecret);
  await insertTenant(alpha, accountId);
  await insertTenant(beta, accountId);
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret } });
  api = await createTestApp({
    database: db,
    redis,
    imports: [stripeEndpointModule(stripe.endpoint)],
    env: {
      AMADEUS_BASE_URL_TEST: stub.url,
      STRIPE_SECRET_KEY_TEST: STRIPE_SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY_TEST: STRIPE_PUBLISHABLE_KEY,
      AIRLINE_CARD_ENABLED: "true",
      STORAGE_DIR: storageDir,
    },
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await stripe?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
  if (storageDir !== undefined) {
    rmSync(storageDir, { recursive: true, force: true });
  }
});

// The customers and the bookings both OTAs hold.
beforeAll(async () => {
  alphaCustomer = await signedIn(alpha, "alpha-customer");
  alphaOther = await signedIn(alpha, "alpha-other");
  betaCustomer = await signedIn(beta, "beta-customer");

  alphaOwned = await book(alpha, alphaCustomer.server);
  const guestBrowser = new Visitor(alpha.host);
  alphaGuest = await book(alpha, guestBrowser);
  const guestCookie = guestBrowser.jar.get(STOREFRONT_COOKIES.bookingTokens);
  if (guestCookie === undefined || parseBookingTokens(guestCookie)[0]?.bookingId !== alphaGuest.bookingId) {
    throw new Error("alpha's storefront wrote no guest cookie of the guest's booking");
  }
  alphaGuestCookie = guestCookie;
  const looked = await new KeyClient(alpha.testSk).call("lookupBooking", "post", "/v1/bookings/lookup", {
    bookingReference: alphaGuest.reference,
    lastName: "Sample",
  });
  alphaGuest.bookingToken = required(
    looked,
    "lookupBooking",
    (looked.body as { bookingToken?: unknown }).bookingToken,
  );
  betaOwned = await book(beta, betaCustomer.server);
  betaGuest = await book(beta, new KeyClient(beta.testSk));

  for (const [owned, owner] of [
    [alphaOwned, alphaCustomer],
    [betaOwned, betaCustomer],
  ] as const) {
    owned.documentId = await insertItinerary(owned);
    const link = await owner.server.call(
      "getBookingDocumentDownloadUrl",
      "get",
      `/v1/bookings/${owned.bookingId}/documents/${owned.documentId}/download-url`,
    );
    // A key caller's absolute URL on the API host: the path and the signature are what the file endpoint reads.
    const url = new URL(
      required(link, "getBookingDocumentDownloadUrl", (link.body as { url?: unknown }).url),
    );
    owned.filePath = `${url.pathname}${url.search}`;
  }
}, SCENARIO_TIMEOUT_MS);

// ---- Credentials of one OTA at the other ----------------------------------------------------------------------------

describe("customer credentials of tenant A at tenant B", () => {
  const answers: Answer[] = [];
  const refreshes: Answer[] = [];
  let edgeSwept: SweptOperation[] = [];
  let keySwept: SweptOperation[] = [];
  const atHome: Answer[] = [];

  beforeAll(async () => {
    edgeSwept = sweptOperations("edge", false);
    keySwept = sweptOperations("key", false);
    for (const [holder, other] of [
      [alphaCustomer, beta],
      [betaCustomer, alpha],
    ] as const) {
      const label = `${holder.email.split("-")[0] ?? ""} at ${other.key}`;
      // The holder's whole jar at the other storefront: as if a browser sent one host's cookies to another.
      answers.push(
        ...(await sweep(`${label} (edge)`, Visitor.holding(other.host, holder.browser.jar), edgeSwept)),
      );
      answers.push(
        ...(await sweep(`${label} (key)`, KeyClient.holding(other.testSk, holder.server), keySwept)),
      );
      // The refresh tokens: the cookie at the other storefront (without the access cookie), the body with its key.
      const refreshCookie = new Map([
        [STOREFRONT_COOKIES.refreshToken, holder.browser.jar.get(STOREFRONT_COOKIES.refreshToken) ?? ""],
      ]);
      refreshes.push({
        label: `${label} (edge)`,
        operationId: "refreshSession",
        res: await Visitor.holding(other.host, refreshCookie).call(
          "refreshSession",
          "post",
          "/v1/auth/refresh",
          {},
        ),
      });
      refreshes.push({
        label: `${label} (key)`,
        operationId: "refreshSession",
        res: await new KeyClient(other.testSk).call("refreshSession", "post", "/v1/auth/refresh", {
          refreshToken: holder.server.refreshToken,
        }),
      });
    }
    // Their sessions still work at their own OTA.
    for (const holder of [alphaCustomer, betaCustomer]) {
      atHome.push({
        label: holder.email,
        operationId: "getSession",
        res: await holder.browser.call("getSession", "get", "/v1/auth/session"),
      });
      atHome.push({
        label: holder.email,
        operationId: "getSession",
        res: await holder.server.call("getSession", "get", "/v1/auth/session"),
      });
    }
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-057 AC3] refuses A's storefront cookies at B's storefront and A's bearer token with B's key with 401 on every operation that reads them, both ways [OF-01 AC2]", () => {
    // Every operation of customer scope that takes the customer's credential, both callers.
    expect(edgeSwept.map((operation) => operation.operationId)).toEqual(
      expect.arrayContaining([
        "getSession",
        "getAccount",
        "listBookings",
        "createCheckout",
        "getBooking",
        "deleteAccount",
      ]),
    );
    expect(edgeSwept.length).toBeGreaterThan(30);
    expect(keySwept.length).toBeGreaterThan(30);
    expect(answers).toHaveLength(2 * (edgeSwept.length + keySwept.length));
    expect(unexpected(answers, [UNAUTHENTICATED])).toEqual([]);
    for (const { operationId, res } of answers) {
      expectResponseToMatch(operationId, res);
    }
    // Each refused for its tenant (`tid`), logged without the token.
    const reasons = api.sink
      .records()
      .filter((line) => line["msg"] === "customer.token_refused" && line["reason"] === "other_tenant");
    expect(reasons.length).toBeGreaterThanOrEqual(answers.length);
    for (const holder of [alphaCustomer, betaCustomer]) {
      expect(api.sink.text()).not.toContain(holder.browser.jar.get(STOREFRONT_COOKIES.accessToken));
      expect(api.sink.text()).not.toContain(holder.server.accessToken);
    }
  });

  it("[OBE-057 AC3] refuses A's refresh token at B with 401 REFRESH_TOKEN_INVALID, in the cookie and in the body", () => {
    expect(refreshes).toHaveLength(4);
    expect(unexpected(refreshes, [[401, "REFRESH_TOKEN_INVALID"]])).toEqual([]);
    for (const { res } of refreshes) {
      expectResponseToMatch("refreshSession", res);
    }
  });

  it("leaves the customers' sessions working at their own OTA", () => {
    expect(atHome.map(({ res }) => res.status)).toEqual([200, 200, 200, 200]);
  });
});

describe("guest tokens of tenant A at tenant B", () => {
  let answers: Answer[] = [];

  beforeAll(async () => {
    const alphaEntry = parseBookingTokens(alphaGuestCookie)[0];
    // Alpha's guest cookie at beta's storefront: on alpha's booking, and moved to beta's guest booking.
    const atBeta = Visitor.holding(
      beta.host,
      new Map([[STOREFRONT_COOKIES.bookingTokens, alphaGuestCookie]]),
    );
    const moved = Visitor.holding(
      beta.host,
      new Map([[STOREFRONT_COOKIES.bookingTokens, `${betaGuest.bookingId}.${alphaEntry?.token ?? ""}`]]),
    );
    // Alpha's guest token with beta's key: on alpha's booking and on beta's guest booking.
    const keyAtBeta = new KeyClient(beta.testSk);
    keyAtBeta.bookingToken = alphaGuest.bookingToken;
    answers = [
      ...(await sendAll("alpha's guest cookie at beta", atBeta, bookingRequests(alphaGuest))),
      ...(await sendAll("alpha's guest cookie moved to beta's booking", moved, bookingRequests(betaGuest))),
      ...(await sendAll("alpha's guest token with beta's key", keyAtBeta, bookingRequests(alphaGuest))),
      ...(await sendAll("alpha's guest token on beta's booking", keyAtBeta, bookingRequests(betaGuest))),
      ...(await sendAll("alpha's guest payment at beta", keyAtBeta, [
        { operationId: "getPayment", method: "get", path: `/v1/payments/${alphaGuest.paymentId}` },
      ])),
    ];
    // Beta's guest token at alpha, the other way round.
    const keyAtAlpha = new KeyClient(alpha.testSk);
    keyAtAlpha.bookingToken = betaGuest.bookingToken;
    answers.push(
      ...(await sendAll("beta's guest token with alpha's key", keyAtAlpha, bookingRequests(betaGuest))),
    );
    answers.push(
      ...(await sendAll("beta's guest token on alpha's booking", keyAtAlpha, bookingRequests(alphaGuest))),
    );
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-057 AC3] never opens a booking or payment of either OTA with the other's guest cookie or token: 404", () => {
    expect(answers.length).toBeGreaterThan(40);
    expect(unexpected(answers, [NOT_FOUND])).toEqual([]);
    for (const { operationId, res } of answers) {
      expectResponseToMatch(operationId, res);
    }
  });
});

describe("ids of tenant A at tenant B", () => {
  const answers: Answer[] = [];
  /** What B's customer's lists hold, and A's bookings, which they must not. */
  const lists: Array<{
    readonly label: string;
    readonly ids: readonly string[];
    readonly foreign: readonly string[];
  }> = [];
  const own: Answer[] = [];

  beforeAll(async () => {
    for (const [owned, guest, other, holder] of [
      [alphaOwned, alphaGuest, beta, betaCustomer],
      [betaOwned, betaGuest, alpha, alphaCustomer],
    ] as const) {
      const label = `${owned.tenant.key}'s ids at ${other.key}`;
      const requests = idRequests(owned, guest);
      // The other OTA's own customer, on its storefront and with its key: valid credentials, valid requests.
      answers.push(...(await sendAll(`${label} (edge)`, holder.browser, requests)));
      answers.push(...(await sendAll(`${label} (key)`, holder.server, requests)));
      // The signed file URL needs no credential: at the other storefront and with the other's key.
      const file = requests.filter((entry) => entry.operationId === "downloadFile");
      answers.push(...(await sendAll(`${label} (file, edge)`, new Visitor(other.host), file)));
      answers.push(...(await sendAll(`${label} (file, key)`, new KeyClient(other.testSk), file)));
      for (const timeframe of ["upcoming", "past", "cancelled"]) {
        const listed = await holder.browser.call(
          "listBookings",
          "get",
          `/v1/bookings?timeframe=${timeframe}`,
        );
        lists.push({
          label: `${other.key} ${timeframe}`,
          ids: ((listed.body as { data?: Array<{ id: string }> }).data ?? []).map((entry) => entry.id),
          foreign: [owned.bookingId, guest.bookingId],
        });
      }
    }
    // The same ids at their own OTA, read by their own customer's server: they exist.
    for (const [owned, owner] of [
      [alphaOwned, alphaCustomer],
      [betaOwned, betaCustomer],
    ] as const) {
      const reads = idRequests(owned, owned).filter((entry) => OWN_READS.has(entry.operationId));
      own.push(...(await sendAll(`${owned.tenant.key} at home`, owner.server, reads)));
    }
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-057 AC3] answers 404 to every operation on A's searches, offers, checkouts, payments, bookings, documents, file URLs and references at B, at B's storefront and with B's key, both ways", () => {
    const operations = new Set(answers.map((answer) => answer.operationId));
    expect(operations).toEqual(
      new Set([
        "getFlightSearch",
        "listFlightSearchResults",
        "getFlightOffer",
        "upsellFlightOffer",
        "priceFlightOffers",
        "getPricedOffer",
        "getPricedOfferAncillaries",
        "getPricedOfferFareRules",
        "createCheckout",
        "getCheckout",
        "setCheckoutTravelers",
        "setCheckoutContacts",
        "setCheckoutAncillaries",
        "setCheckoutRemarks",
        "createCheckoutPayment",
        "getPayment",
        "updatePayment",
        "completeCheckout",
        "completeCheckoutWithAirlineCard",
        "getBooking",
        "updateBooking",
        "quoteBookingCancellation",
        "cancelBooking",
        "getBookingFareRules",
        "getBookingTicketingStatus",
        "listBookingEvents",
        "listBookingDocuments",
        "getBookingDocumentDownloadUrl",
        "downloadFile",
        "lookupBooking",
      ]),
    );
    expect(unexpected(answers, [NOT_FOUND])).toEqual([]);
    for (const { operationId, res } of answers) {
      expectResponseToMatch(operationId, res);
    }
  });

  it("[OBE-057 AC3] lists none of A's bookings at B", () => {
    expect(lists).toHaveLength(6);
    for (const { label, ids, foreign } of lists) {
      expect([label, ids.filter((id) => foreign.includes(id))]).toEqual([label, []]);
    }
    // Each customer's own upcoming booking is listed: the lists are not empty by accident.
    expect(lists.find((entry) => entry.label === "alpha upcoming")?.ids).toContain(alphaOwned.bookingId);
  });

  it("answers the same reads at the ids' own OTA: they exist", () => {
    expect(own.length).toBeGreaterThan(10);
    expect(
      own
        .filter(({ res }) => res.status !== 200)
        .map(({ label, operationId, res }) => [label, operationId, ...outcome(res)]),
    ).toEqual([]);
  });
});

// ---- The live storefront and the test environment -------------------------------------------------------------------

describe("beta's test bookings from its live storefront", () => {
  let answers: Answer[] = [];
  const lists: Array<{ readonly label: string; readonly ids: readonly string[] }> = [];
  let withTestKey: Answer[] = [];

  beforeAll(async () => {
    const liveServer = KeyClient.holding(beta.liveSk, betaCustomer.server);
    const liveGuestServer = new KeyClient(beta.liveSk);
    liveGuestServer.bookingToken = betaGuest.bookingToken;
    const liveGuestBrowser = Visitor.holding(
      beta.host,
      new Map([[STOREFRONT_COOKIES.bookingTokens, `${betaGuest.bookingId}.${betaGuest.bookingToken ?? ""}`]]),
    );
    const documentUrl = {
      operationId: "getBookingDocumentDownloadUrl",
      method: "get",
      path: `/v1/bookings/${betaOwned.bookingId}/documents/${betaOwned.documentId ?? ""}/download-url`,
    } as const;
    answers = [
      ...(await sendAll("the customer's on the live storefront", betaCustomer.browser, [
        ...bookingRequests(betaOwned),
        documentUrl,
      ])),
      ...(await sendAll("the customer's with the live key", liveServer, [
        ...bookingRequests(betaOwned),
        documentUrl,
      ])),
      ...(await sendAll("the guest's on the live storefront", liveGuestBrowser, bookingRequests(betaGuest))),
      ...(await sendAll("the guest's with the live key", liveGuestServer, bookingRequests(betaGuest))),
      ...(await sendAll("the lookup on the live storefront", betaCustomer.browser, [
        {
          operationId: "lookupBooking",
          method: "post",
          path: "/v1/bookings/lookup",
          body: { bookingReference: betaGuest.reference, lastName: "Sample" },
        },
      ])),
      ...(await sendAll("the lookup with the live key", new KeyClient(beta.liveSk), [
        {
          operationId: "lookupBooking",
          method: "post",
          path: "/v1/bookings/lookup",
          body: { bookingReference: betaOwned.reference, lastName: "Sample" },
        },
      ])),
    ];
    for (const [label, caller] of [
      ["live storefront", betaCustomer.browser],
      ["live key", liveServer],
      ["test key", betaCustomer.server],
    ] as const) {
      for (const timeframe of ["upcoming", "past", "cancelled"]) {
        const listed = await caller.call("listBookings", "get", `/v1/bookings?timeframe=${timeframe}`);
        lists.push({
          label: `${label} ${timeframe}`,
          ids: ((listed.body as { data?: Array<{ id: string }> }).data ?? []).map((entry) => entry.id),
        });
      }
    }
    // The same bookings in their own environment: beta's test key.
    const testGuestServer = new KeyClient(beta.testSk);
    testGuestServer.bookingToken = betaGuest.bookingToken;
    withTestKey = [
      ...(await sendAll("the customer's with the test key", betaCustomer.server, [
        { operationId: "getBooking", method: "get", path: `/v1/bookings/${betaOwned.bookingId}` },
      ])),
      ...(await sendAll("the guest's with the test key", testGuestServer, [
        { operationId: "getBooking", method: "get", path: `/v1/bookings/${betaGuest.bookingId}` },
      ])),
    ];
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-057 AC3] never opens or finds a test booking from beta's live storefront or with its live key: 404 for the customer's, the guest's and the lookup [OF-07]", () => {
    expect(answers.length).toBeGreaterThan(30);
    expect(unexpected(answers, [NOT_FOUND])).toEqual([]);
    for (const { operationId, res } of answers) {
      expectResponseToMatch(operationId, res);
    }
  });

  it("[OBE-057 AC3] lists no test booking on the live storefront or with the live key, and lists it with the test key", () => {
    const testBookings = [betaOwned.bookingId];
    for (const { label, ids } of lists.filter((entry) => !entry.label.startsWith("test key"))) {
      expect([label, ids.filter((id) => testBookings.includes(id))]).toEqual([label, []]);
    }
    expect(lists.find((entry) => entry.label === "test key upcoming")?.ids).toContain(betaOwned.bookingId);
    expect(withTestKey.map(({ res }) => res.status)).toEqual([200, 200]);
  });
});

// ---- Another customer of the same OTA -------------------------------------------------------------------------------

describe("another customer of the same OTA", () => {
  let answers: Answer[] = [];
  const listed: string[] = [];

  beforeAll(async () => {
    // On the storefront: the checkout, its payment and the booking of the customer. A secret key is the OTA's own
    // server, which may read any checkout of its OTA (checkout.service.ts); the bookings stay the customer's.
    answers = [
      ...(await sendAll("on the storefront", alphaOther.browser, [
        ...checkoutRequests(alphaOwned),
        ...bookingRequests(alphaOwned),
      ])),
      ...(await sendAll("with the key", alphaOther.server, bookingRequests(alphaOwned))),
    ];
    for (const timeframe of ["upcoming", "past", "cancelled"]) {
      const res = await alphaOther.browser.call("listBookings", "get", `/v1/bookings?timeframe=${timeframe}`);
      listed.push(...((res.body as { data?: Array<{ id: string }> }).data ?? []).map((entry) => entry.id));
    }
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-057 AC3] never opens the customer's checkout, payment or booking for another customer of the OTA: 404", () => {
    expect(answers).toHaveLength(
      checkoutRequests(alphaOwned).length + 2 * bookingRequests(alphaOwned).length,
    );
    expect(unexpected(answers, [NOT_FOUND])).toEqual([]);
    expect(listed).not.toContain(alphaOwned.bookingId);
  });
});

// ---- A deleted customer ---------------------------------------------------------------------------------------------

describe("a deleted customer's kept credentials", () => {
  let deletion: Response;
  let answers: Answer[] = [];
  let swept: { edge: number; key: number } = { edge: 0, key: 0 };
  /** The kept refresh token at both OTAs, and a sign-in with the deleted account's address and password. */
  const refreshes: Answer[] = [];
  let keptRefreshTokens: string[] = [];
  let signIn: Response;

  beforeAll(async () => {
    const leaver = await signedIn(alpha, "alpha-leaver");
    const kept = new Map(leaver.browser.jar);
    deletion = await leaver.browser.call("deleteAccount", "post", "/v1/account/deletion", {
      currentPassword: PASSWORD,
    });
    // Someone who kept the cookies and the bearer token from before the deletion, at alpha and at beta.
    const edge = sweptOperations("edge", true);
    const key = sweptOperations("key", true);
    swept = { edge: edge.length, key: key.length };
    answers = [
      ...(await sweep("kept cookies at alpha", Visitor.holding(alpha.host, kept), edge)),
      ...(await sweep("kept bearer token at alpha", KeyClient.holding(alpha.testSk, leaver.server), key)),
      ...(await sweep(
        "kept cookies at beta",
        Visitor.holding(beta.host, kept),
        sweptOperations("edge", false),
      )),
      ...(await sweep(
        "kept bearer token at beta",
        KeyClient.holding(beta.testSk, leaver.server),
        sweptOperations("key", false),
      )),
    ];
    // account.delete at alpha, left out of the sweeps there (the guard lets its idempotent replay through): a new
    // deletion, with a complete body and a key of its own, is refused by the service alike.
    const newDeletion: IdRequest = {
      operationId: "deleteAccount",
      method: "post",
      path: "/v1/account/deletion",
      body: { currentPassword: PASSWORD },
    };
    answers.push(
      ...(await sendAll("new deletion with kept cookies at alpha", Visitor.holding(alpha.host, kept), [
        newDeletion,
      ])),
      ...(await sendAll(
        "new deletion with kept bearer token at alpha",
        KeyClient.holding(alpha.testSk, leaver.server),
        [newDeletion],
      )),
    );
    // The credentials that would open a new session: the kept refresh token (the cookie alone at each storefront, the
    // body with each OTA's key), whose family account.delete revoked, and the account's address and password.
    keptRefreshTokens = [kept.get(STOREFRONT_COOKIES.refreshToken) ?? "", leaver.server.refreshToken ?? ""];
    const refreshCookie = new Map([[STOREFRONT_COOKIES.refreshToken, keptRefreshTokens[0] ?? ""]]);
    for (const tenant of [alpha, beta]) {
      refreshes.push(
        {
          label: `kept refresh cookie at ${tenant.key}`,
          operationId: "refreshSession",
          res: await Visitor.holding(tenant.host, refreshCookie).call(
            "refreshSession",
            "post",
            "/v1/auth/refresh",
            {},
          ),
        },
        {
          label: `kept refresh token at ${tenant.key}`,
          operationId: "refreshSession",
          res: await new KeyClient(tenant.testSk).call("refreshSession", "post", "/v1/auth/refresh", {
            refreshToken: leaver.server.refreshToken,
          }),
        },
      );
    }
    signIn = await new Visitor(alpha.host).call("signIn", "post", "/v1/auth/sign-in", {
      email: leaver.email,
      password: PASSWORD,
    });
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-057 AC3] [FIX-W29-SECURITY] refuses them with 401 UNAUTHENTICATED on every customer operation, at its own OTA and at the other", () => {
    expect(deletion.status).toBe(202);
    expect(swept.edge).toBeGreaterThan(30);
    expect(swept.key).toBeGreaterThan(30);
    // The own OTA's sweeps leave account.delete out and send it once more with a complete body (two calls); the
    // other's sweeps include it (two calls).
    expect(answers).toHaveLength(2 * (swept.edge + swept.key) + 4);
    expect(
      answers.filter((answer) => answer.operationId === "deleteAccount").map((answer) => answer.label),
    ).toEqual([
      "kept cookies at beta",
      "kept bearer token at beta",
      "new deletion with kept cookies at alpha",
      "new deletion with kept bearer token at alpha",
    ]);
    expect(unexpected(answers, [UNAUTHENTICATED])).toEqual([]);
    for (const { operationId, res } of answers) {
      expectResponseToMatch(operationId, res);
    }
  });

  it("[OBE-057 AC3] [FIX-W29-SECURITY] opens no new session for them: the kept refresh token answers 401 REFRESH_TOKEN_INVALID at both OTAs, and sign-in 401 INVALID_CREDENTIALS", () => {
    expect(keptRefreshTokens.map((token) => token.startsWith("rt_"))).toEqual([true, true]);
    expect(refreshes).toHaveLength(4);
    expect(unexpected(refreshes, [[401, "REFRESH_TOKEN_INVALID"]])).toEqual([]);
    for (const { label, res } of refreshes) {
      expectResponseToMatch("refreshSession", res);
      // No session cookie with a value: at most their removal.
      const lines = (res.headers["set-cookie"] as string[] | undefined) ?? [];
      expect([label, lines.filter((line) => /^__Host-vx_(?:at|rt)=[^;]/.test(line))]).toEqual([label, []]);
    }
    expect(outcome(signIn)).toEqual([401, "INVALID_CREDENTIALS"]);
    expectResponseToMatch("signIn", signIn);
    expect(signIn.headers["set-cookie"]).toBeUndefined();
  });
});

// ---- One-time tokens and sign-out of one OTA at the other -----------------------------------------------------------

describe("one-time e-mail tokens and a sign-out of tenant A at tenant B", () => {
  /** The error body without its `requestId`: what an unknown token's answer must equal. */
  const withoutRequestId = (res: Response): string =>
    res.text.replace(/"requestId":"[^"]*"/, '"requestId":""');
  const atBeta: Array<{ readonly label: string; readonly res: Response; readonly madeUp: Response }> = [];
  let atAlpha: Response[] = [];
  let signOuts: Response[] = [];
  let afterSignOut: Response[] = [];

  beforeAll(async () => {
    const { id } = await insertCustomer(alpha, "alpha-tokens", false);
    const verification = `vt_${randomBytes(32).toString("base64url")}`;
    const reset = generateToken("pr", 32);
    await inTenant(alpha, async (trx) => {
      await trx
        .updateTable("customer_identities")
        .set({
          verification_token_hash: sha256Hex(verification),
          verification_sent_at: new Date(),
          verification_expires_at: new Date(Date.now() + DAY_MS),
        })
        .where("customer_id", "=", id)
        .execute();
      await trx
        .insertInto("customer_password_resets")
        .values({
          id: newId("pwr"),
          customer_id: id,
          token_hash: reset.hash,
          expires_at: new Date(Date.now() + 3_600_000),
        })
        .execute();
    });
    const newPassword = `Tundra-${randomBytes(9).toString("base64url")}`;
    for (const [label, caller, madeUpCaller] of [
      ["edge", new Visitor(beta.host), new Visitor(beta.host)],
      ["key", new KeyClient(beta.testSk), new KeyClient(beta.testSk)],
    ] as const) {
      atBeta.push({
        label: `verification (${label})`,
        res: await caller.call("verifyEmail", "post", "/v1/auth/email-verification/confirm", {
          token: verification,
        }),
        madeUp: await madeUpCaller.call("verifyEmail", "post", "/v1/auth/email-verification/confirm", {
          token: `vt_${randomBytes(32).toString("base64url")}`,
        }),
      });
      atBeta.push({
        label: `reset (${label})`,
        res: await caller.call("resetPassword", "post", "/v1/auth/password-resets/confirm", {
          token: reset.token,
          newPassword,
        }),
        madeUp: await madeUpCaller.call("resetPassword", "post", "/v1/auth/password-resets/confirm", {
          token: generateToken("pr", 32).token,
          newPassword,
        }),
      });
    }
    // The tokens still work at alpha, once each.
    const home = new KeyClient(alpha.testSk);
    atAlpha = [
      await home.call("verifyEmail", "post", "/v1/auth/email-verification/confirm", { token: verification }),
      await home.call("resetPassword", "post", "/v1/auth/password-resets/confirm", {
        token: reset.token,
        newPassword,
        signIn: false,
      }),
    ];

    // A sign-out at beta with alpha's refresh token alone (no access token): the cookie and the body.
    const holder = await signedIn(alpha, "alpha-signout");
    signOuts = [
      await Visitor.holding(
        beta.host,
        new Map([
          [STOREFRONT_COOKIES.refreshToken, holder.browser.jar.get(STOREFRONT_COOKIES.refreshToken) ?? ""],
        ]),
      ).call("signOut", "post", "/v1/auth/sign-out", {}),
      await new KeyClient(beta.testSk).call("signOut", "post", "/v1/auth/sign-out", {
        refreshToken: holder.server.refreshToken,
      }),
    ];
    // Both sessions go on at alpha: each refresh token still rotates.
    afterSignOut = [
      await holder.browser.call("refreshSession", "post", "/v1/auth/refresh", {}),
      await new KeyClient(alpha.testSk).call("refreshSession", "post", "/v1/auth/refresh", {
        refreshToken: holder.server.refreshToken,
      }),
    ];
  }, SCENARIO_TIMEOUT_MS);

  it("refuses A's verification and reset tokens at B exactly like made-up tokens, and they still work at A", () => {
    expect(atBeta).toHaveLength(4);
    for (const { label, res, madeUp } of atBeta) {
      const code = label.startsWith("verification")
        ? "VERIFICATION_TOKEN_INVALID"
        : "PASSWORD_RESET_TOKEN_INVALID";
      expect([label, ...outcome(res), res.body.error?.details]).toEqual([
        label,
        400,
        code,
        { reason: "unknown" },
      ]);
      expect(withoutRequestId(res)).toBe(withoutRequestId(madeUp));
    }
    expect(atAlpha.map((res) => res.status)).toEqual([200, 200]);
  });

  it("ends nothing at A when B gets a sign-out with A's refresh token: the answer of an unknown token, and A's sessions refresh", () => {
    expect(signOuts.map((res) => res.status)).toEqual([204, 204]);
    expect(afterSignOut.map((res) => res.status)).toEqual([200, 200]);
  });
});
