// Cookie sessions on the hosted storefront and bearer tokens for key callers, for every M2 and M3 customer operation
// (OBE-057 step 1; ota/docs/scope.md OF-03 AC1, OADR-0006 points 1, 2, 4, 5, 6 and 9, ADR-0008,
// ota/docs/flows/my-bookings-and-guest-lookup.md §7, docs/mvp/conventions.md §12), through the API's whole pipeline
// against PostgreSQL 16, Redis 7, the Amadeus stub and the fake Stripe API of test/helpers/fake-stripe.ts.
//
// The file clones the @velexis/testing template (tenant_alpha provisioned) and writes alpha's platform rows as the
// platform does: a test storefront on the Velexis test Amadeus account (the stub), the `velexis` test Stripe connection
// and a secret test key. Its settings are seeded as provisioning seeds them, with legal versions and the airline card on
// for its test environment (AIRLINE_CARD_ENABLED=true). The API runs in-process with a storage folder of its own.
//
// Two journeys run once, in `beforeAll` hooks with budgets of their own; the tests only read what they recorded:
//
//   - the edge journey, as the storefront's pages call the API through Caddy: browsers with a cookie jar that keep
//     what each answer sets, send it back, and copy `__Host-vx_csrf` into `X-CSRF-Token` on every write. It calls
//     every M2 and M3 operation of customer scope at least once, and each call must succeed: a customer signs up,
//     verifies the address, refreshes, changes the password, edits the account, shops, books, reads, downloads,
//     changes and cancels the booking; a guest books with a card and with the airline card and looks the booking up;
//     a third customer signs out, resets the password, signs in and deletes the account;
//   - the bearer journey, a third-party storefront's server with the secret key: the same auth and booking-access
//     operations, which answer their tokens in the body (OADR-0006: token-mode callers see no change).
//
// The one-time e-mail tokens (verification, password reset) are made by the test and stored hashed as the API stores
// them, so no worker or Mailpit is needed. No worker runs: ticketing, the void of the cancelled booking's payment and
// the e-mails stay queued. A ready itinerary of the customer's booking is written as the document render writes it.
//
// What counts as a token: the customer access JWT, the refresh token (`rt_…`), the guest booking token (`vxbt_…`) and
// the one-time e-mail tokens (`vt_…`, `pr_…`), by their shapes and by every value the run saw (cookies, bearer
// answers). Stripe's PaymentIntent client secret, which Stripe.js needs in the page to confirm the card, is not a
// credential of the OTA API and is not counted. Card values are test data only: Visa's documented test PAN.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import { encryptValue, generateToken, hashApiKey, sha256Hex, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type ReferenceDatabase,
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
import { BOOKING_TOKEN_PATTERN } from "../../../src/common/auth/booking-access.guard";
import { CSRF_TOKEN_PATTERN } from "../../../src/common/auth/csrf.guard";
import { parseBookingTokens, STOREFRONT_COOKIES } from "../../../src/common/http/cookie-writer";
import { PENDING_OPERATIONS } from "../../../src/common/http/pending-operations";
import { newId } from "../../../src/common/ids";
import { REFRESH_TOKEN_PATTERN } from "../../../src/identity/sessions.service";
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
import { edgeHeaders, newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { walkJson } from "../../support/json-walk";

/**
 * Cloning the template, starting the stub, the fake Stripe API and the API's graph (it parses the OTA document and
 * compiles its validators): a few seconds alone, more on a busy 4-CPU CI runner. The bound only stops a start that hangs.
 */
const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/**
 * A journey makes about a hundred calls (four searches and prices through the stub, three bookings, a cancellation)
 * and several Argon2id hashes (sign-up, password change, reset, sign-in, deletion): a few seconds locally; the bound
 * allows for CI load and only stops a journey that hangs.
 */
const JOURNEY_TIMEOUT_MS = 120_000;

const ALPHA_HOST = "alpha.ota.example.com";
const TERMS_VERSION = "2026-09-01";
const PRIVACY_VERSION = "2026-08-15";
const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const DAY_MS = 86_400_000;
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/** Passwords made up for this run: long enough and not on the breached list. */
const PASSWORD = `Fjord-${randomBytes(9).toString("base64url")}`;
const CHANGED_PASSWORD = `Glacier-${randomBytes(9).toString("base64url")}`;
const RESET_PASSWORD = `Tundra-${randomBytes(9).toString("base64url")}`;

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const STRIPE_SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const STRIPE_PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

/** Test data only: Visa's documented test PAN and a made-up security code, three years ahead. */
const TEST_PAN = "4111111111111111";
const TEST_CVV = "123";
const EXPIRY_YEAR = new Date().getUTCFullYear() + 3;

const quietPoolLogger = { error: (): void => undefined };

/** The M2 and M3 operations of customer scope: the storefront's whole API until M4. */
const CUSTOMER_OPERATIONS: readonly OtaOperationId[] = otaOperations
  .filter(
    (operation) =>
      (operation.milestone === "M2" || operation.milestone === "M3") &&
      operation.scope !== "console" &&
      !operation.internal,
  )
  .map((operation) => operation.operationId);

/**
 * The auth and booking-access operations (OADR-0006 point 9): the customer's session and account, and the operations
 * that give a guest access to a booking. Both journeys call each of them.
 */
const AUTH_AND_ACCESS_OPERATIONS: readonly OtaOperationId[] = Object.freeze([
  "signUp",
  "verifyEmail",
  "resendEmailVerification",
  "signIn",
  "refreshSession",
  "signOut",
  "requestPasswordReset",
  "resetPassword",
  "changePassword",
  "getSession",
  "getAccount",
  "updateAccount",
  "deleteAccount",
  "completeCheckout",
  "completeCheckoutWithAirlineCard",
  "lookupBooking",
  "getBooking",
]);

/** The success status of each operation the journeys call; 200 for the others. */
const SUCCESS: Readonly<Partial<Record<OtaOperationId, number>>> = Object.freeze({
  signUp: 201,
  resendEmailVerification: 202,
  signOut: 204,
  requestPasswordReset: 202,
  deleteAccount: 202,
  createFlightSearch: 201,
  priceFlightOffers: 201,
  createCheckout: 201,
  createCheckoutPayment: 201,
  completeCheckout: 201,
  completeCheckoutWithAirlineCard: 201,
});
const successOf = (operationId: OtaOperationId): number => SUCCESS[operationId] ?? 200;

/** The four cookies of OADR-0006 point 2, by name. */
const COOKIE_NAMES: ReadonlySet<string> = new Set(Object.values(STOREFRONT_COOKIES));
const CSRF = STOREFRONT_COOKIES.csrf;
const ACCESS = STOREFRONT_COOKIES.accessToken;
const REFRESH = STOREFRONT_COOKIES.refreshToken;
const GUEST = STOREFRONT_COOKIES.bookingTokens;

/** The shapes of the OTA's credentials: what must never be in an edge answer, whatever its value. */
const TOKEN_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ["access JWT", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/],
  ["refresh token", /\brt_[A-Za-z0-9_-]{20,}/],
  ["guest booking token", /\bvxbt_(?:test|live)_[A-Za-z0-9_-]{20,}/],
  ["e-mail token", /\b(?:vt|pr)_[A-Za-z0-9_-]{32,}/],
];
/** Keys of the contract's token fields that an edge answer never has (OADR-0006 point 4). */
const TOKEN_KEYS: ReadonlySet<string> = new Set(["accessToken", "refreshToken", "tokenType", "idToken"]);
/** Keys of the contract's token fields that an edge answer has with `null` only. */
const NULL_TOKEN_KEYS: ReadonlySet<string> = new Set(["bookingToken", "bookingTokenExpiresAt", "token"]);

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let stripe: FakeStripe;
let keys: KeyProvider;
let migratorPool: OtaPool;
/** velexis_migrator, the owner of the platform and reference tables: it writes what the platform and the loader do. */
let migrator: Kysely<PlatformDatabase & ReferenceDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let storageDir: string;
let storage: LocalDiskStorage;
let alphaSk = "";

const alphaTx = <T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", fn);

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one client, so the per-IP limits never mix the clients. */
const newIp = (): string => {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
};

/** An address of its own for each customer of this run. */
const newEmail = (label: string): string => `${label}-${randomBytes(5).toString("hex")}@example.com`;

// ---- What the journeys saw ------------------------------------------------------------------------------------------

type Mode = "edge" | "key";
type Method = "get" | "post" | "put" | "patch" | "delete";

/** One call of a journey and its answer. */
interface Exchange {
  readonly mode: Mode;
  readonly operationId: OtaOperationId;
  /**
   * A call beside the journey, which proves a refusal (`refresh_token_in_body`, `kept_cookie_after_deletion`, …):
   * `undefined` for a step of the journey, which must succeed.
   */
  readonly extra: string | undefined;
  readonly res: Response;
}

const exchanges: Exchange[] = [];
/** The one-time e-mail tokens the test made (verification and reset): never in any answer. */
const emailTokens: string[] = [];

const journeyOf = (mode: Mode): Exchange[] =>
  exchanges.filter((exchange) => exchange.mode === mode && exchange.extra === undefined);
const answersOf = (mode: Mode, operationId: OtaOperationId): Response[] =>
  journeyOf(mode)
    .filter((exchange) => exchange.operationId === operationId)
    .map((exchange) => exchange.res);
/** The first answer of `operationId` in the journey of `mode`; throws when the journey has none. */
const first = (mode: Mode, operationId: OtaOperationId): Response => {
  const [res] = answersOf(mode, operationId);
  if (res === undefined) {
    throw new Error(`the ${mode} journey has no ${operationId}`);
  }
  return res;
};
const extraOf = (label: string): Response => {
  const found = exchanges.find((exchange) => exchange.extra === label);
  if (found === undefined) {
    throw new Error(`no call ${label}`);
  }
  return found.res;
};

/** A `Set-Cookie` line parsed: name, value and the attributes as written. */
interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly attributes: readonly string[];
}

function setCookiesOf(res: Response): SetCookie[] {
  const header = res.headers["set-cookie"] as unknown;
  const lines = Array.isArray(header) ? (header as string[]) : typeof header === "string" ? [header] : [];
  return lines.map((line) => {
    const [pair = "", ...attributes] = line.split("; ");
    const index = pair.indexOf("=");
    return { name: pair.slice(0, index), value: pair.slice(index + 1), attributes };
  });
}

const cookieOf = (res: Response, name: string): SetCookie | undefined =>
  setCookiesOf(res).find((cookie) => cookie.name === name);

/** The text of an answer's body (a binary download as Latin-1, byte for byte). */
function bodyText(res: Response): string {
  const body: unknown = res.body;
  return Buffer.isBuffer(body) ? body.toString("latin1") : (res.text ?? "");
}

/** Every header of an answer but `Set-Cookie`, as text. */
function headerText(res: Response): string {
  return Object.entries(res.headers as Record<string, unknown>)
    .filter(([name]) => name !== "set-cookie")
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join("\n");
}

/** A binary answer's bytes (Supertest buffers `application/pdf` with this parser). */
function binary(res: request.Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
}

/** A string field of an answer that the next step needs; throws with the step's status and code when it is missing. */
function required(res: Response, operationId: OtaOperationId, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    const code = (res.body as { error?: { code?: string } } | undefined)?.error?.code ?? "no error code";
    throw new Error(`${operationId} answered ${res.status} (${code}); the journey cannot go on`);
  }
  return value;
}

/** Minor units of a decimal amount with two decimals (`"110.47"` → 11047), without a JS number in between. */
function minorUnits(amount: string): number {
  const [units = "0", cents = ""] = amount.split(".");
  return Number.parseInt(`${units}${cents.padEnd(2, "0").slice(0, 2)}`, 10);
}

// ---- The callers ----------------------------------------------------------------------------------------------------

interface CallOptions {
  /** More headers (`If-Match`, …). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Records the call as a refusal beside the journey (see `Exchange.extra`). */
  readonly extra?: string;
}

/** A client of the API: the storefront's browser (edge) or a third-party storefront's server (key). */
interface Caller {
  readonly mode: Mode;
  call(
    operationId: OtaOperationId,
    method: Method,
    path: string,
    body?: unknown,
    options?: CallOptions,
  ): Promise<Response>;
}

async function send(
  caller: Caller,
  operationId: OtaOperationId,
  method: Method,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  extra: string | undefined,
): Promise<Response> {
  let test = request(api.server)[method](path).set(headers);
  if (operationId === "downloadFile") {
    test = test.buffer(true).parse(binary);
  }
  const res = method === "get" || method === "delete" ? await test : await test.send(body as object);
  exchanges.push({ mode: caller.mode, operationId, extra, res });
  return res;
}

/** The browser of one storefront visitor: the cookies the API set, sent back on every request. */
class Visitor implements Caller {
  readonly mode = "edge" as const;
  readonly jar = new Map<string, string>();
  readonly ip = newIp();

  headers(write: boolean): Record<string, string> {
    return {
      ...edgeHeaders(ALPHA_HOST),
      "X-Forwarded-For": this.ip,
      "User-Agent": "Mozilla/5.0 (storefront cookie-mode test)",
      ...(this.jar.size === 0
        ? {}
        : { Cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ") }),
      // The SDK in cookie mode copies the CSRF cookie into the header of every write; the browser adds `Origin`.
      ...(write ? { Origin: `https://${ALPHA_HOST}`, "X-CSRF-Token": this.jar.get(CSRF) ?? "" } : {}),
    };
  }

  /** Keeps what an answer set: a cookie with `Max-Age=0` is removed, as a browser does. */
  remember(res: Response): void {
    for (const cookie of setCookiesOf(res)) {
      if (cookie.attributes.includes("Max-Age=0")) {
        this.jar.delete(cookie.name);
      } else {
        this.jar.set(cookie.name, cookie.value);
      }
    }
  }

  async call(
    operationId: OtaOperationId,
    method: Method,
    path: string,
    body: unknown = {},
    options: CallOptions = {},
  ): Promise<Response> {
    const write = method !== "get";
    const headers = {
      ...this.headers(write),
      ...(method === "post" ? { "Idempotency-Key": randomUUID() } : {}),
      ...options.headers,
    };
    const res = await send(this, operationId, method, path, headers, body, options.extra);
    this.remember(res);
    return res;
  }
}

/** A third-party storefront's server with alpha's secret key, calling for one visitor (bearer mode). */
class KeyClient implements Caller {
  readonly mode = "key" as const;
  readonly ip = newIp();
  /** The visitor's customer access token, sent as `Authorization: Bearer` while set. */
  accessToken: string | undefined;
  /** The visitor's guest booking token, sent as `X-Booking-Token` while set. */
  bookingToken: string | undefined;

  async call(
    operationId: OtaOperationId,
    method: Method,
    path: string,
    body: unknown = {},
    options: CallOptions = {},
  ): Promise<Response> {
    const headers = {
      "X-Api-Key": alphaSk,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": "Mozilla/5.0 (third-party storefront test)",
      ...(this.accessToken === undefined ? {} : { Authorization: `Bearer ${this.accessToken}` }),
      ...(this.bookingToken === undefined ? {} : { "X-Booking-Token": this.bookingToken }),
      ...(method === "post" ? { "Idempotency-Key": randomUUID() } : {}),
      ...options.headers,
    };
    return await send(this, operationId, method, path, headers, body, options.extra);
  }
}

// ---- The fixtures ---------------------------------------------------------------------------------------------------

/** Inserts the Velexis test Amadeus account with `secret` encrypted as the platform encrypts it; its id. */
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

/** Alpha on a test storefront: its tenant, Amadeus and Stripe test connections and a secret test key. */
async function insertAlpha(accountId: string): Promise<void> {
  const tenantId = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id: tenantId, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: tenantId,
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
      tenant_id: tenantId,
      provider: "stripe",
      environment: "test",
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
      statement_descriptor_suffix: "ALPHA TRAVEL",
    })
    .execute();
  alphaSk = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: alphaSk.slice(0, 14),
      key_hash: hashApiKey(alphaSk, testApiCredentials().pepper),
      last4: alphaSk.slice(-4),
    })
    .execute();
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
    // The legal versions it publishes, the airline card on for its test environment and the customers' own
    // cancellations on (console settings, OBE-070).
    await trx
      .updateTable("storefront_settings")
      .set({
        terms_version: TERMS_VERSION,
        privacy_version: PRIVACY_VERSION,
        airline_card_enabled_test: true,
        features: sql`jsonb_set(features, '{selfServiceCancellation}', 'true'::jsonb)`,
      })
      .execute();
  });
}

/**
 * Moves the last synchronisation of `bookingId` (the record step's, at its creation) two minutes back, as if the
 * customer opened the fare rules a while after booking: the one Flight Order Management GET per booking and minute
 * (bookings.getFareRules without stored rules) is not throttled then.
 */
async function aWhileLater(bookingId: string): Promise<void> {
  const before = new Date(Date.now() - 2 * 60_000);
  await alphaTx((trx) =>
    trx
      .updateTable("bookings")
      .set({ last_synced_at: before, sync_claimed_at: null })
      .where("id", "=", bookingId)
      .execute(),
  );
}

/**
 * The template's reference fixture has no time zones, and reference.airports.get offers no airport without one: CDG
 * gets its time zone and position, as the reference loader writes them.
 */
async function completeReference(): Promise<void> {
  await migrator
    .insertInto("reference.time_zones")
    .values({ name: "Europe/Paris", country_code: "FR", utc_offset_minutes: 60, dst_offset_minutes: 120 })
    .execute();
  await migrator
    .updateTable("reference.airports")
    .set({ time_zone: "Europe/Paris", latitude: "49.009722", longitude: "2.547778" })
    .where("iata_code", "=", "CDG")
    .execute();
}

/** The customer of `email` at alpha, by its address. */
async function customerIdOf(email: string): Promise<string> {
  const row = await alphaTx((trx) =>
    trx
      .selectFrom("customers")
      .select("id")
      .where(sql<string>`lower(email)`, "=", email.toLowerCase())
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}

/** Gives the customer of `email` a verification token of the test's own, as sign-up stores one (hashed); the token. */
async function verificationTokenFor(email: string): Promise<string> {
  const customerId = await customerIdOf(email);
  const token = `vt_${randomBytes(32).toString("base64url")}`;
  emailTokens.push(token);
  await alphaTx((trx) =>
    trx
      .updateTable("customer_identities")
      .set({
        verification_token_hash: sha256Hex(token),
        verification_sent_at: new Date(),
        verification_expires_at: new Date(Date.now() + DAY_MS),
      })
      .where("customer_id", "=", customerId)
      .execute(),
  );
  return token;
}

/** Opens a password reset of the customer of `email` with a token of the test's own, stored as the API stores it. */
async function resetTokenFor(email: string): Promise<string> {
  const customerId = await customerIdOf(email);
  const { token, hash } = generateToken("pr", 32);
  emailTokens.push(token);
  await alphaTx((trx) =>
    trx
      .insertInto("customer_password_resets")
      .values({
        id: newId("pwr"),
        customer_id: customerId,
        token_hash: hash,
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .execute(),
  );
  return token;
}

/** A ready itinerary of `bookingId`, as the document render writes it: the row and its file. */
async function insertItinerary(bookingId: string): Promise<string> {
  const id = newId("doc");
  const storageKey = `tenant_alpha/documents/${bookingId}/${id}.pdf`;
  const bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(64), Buffer.from("\n%%EOF\n")]);
  await storage.put(storageKey, bytes, "application/pdf");
  await alphaTx((trx) =>
    trx
      .insertInto("booking_documents")
      .values({
        id,
        booking_id: bookingId,
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

// ---- The steps both journeys share ----------------------------------------------------------------------------------

let searchCount = 0;

/**
 * A priced offer of the stub's Madrid–Paris Orly offer 2 of a new search, its flight moved 60 days ahead (the stored
 * offers get a last ticketing day 30 days ahead). With `browse`, the caller also reads the search, its results and
 * the offer, asks for its upsells and reads the priced offer, its ancillaries and fare rules: every M2 operation.
 */
async function pricedOffer(caller: Caller, browse = false): Promise<string> {
  searchCount += 1;
  const searched = await caller.call("createFlightSearch", "post", "/v1/flight-searches", {
    mode: "simple",
    originLocationCode: "MAD",
    destinationLocationCode: "ORY",
    departureDate: dateFromToday(60 + searchCount),
    adults: 1,
  });
  const searchId = required(searched, "createFlightSearch", (searched.body as { id?: unknown }).id);
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
  if (browse) {
    await caller.call("getFlightSearch", "get", `/v1/flight-searches/${searchId}`);
    await caller.call("listFlightSearchResults", "get", `/v1/flight-searches/${searchId}/offers?limit=10`);
    await caller.call("getFlightOffer", "get", `/v1/flight-offers/${offerId}`);
    await caller.call("upsellFlightOffer", "post", `/v1/flight-offers/${offerId}/upsells`, {});
  }
  const priced = await caller.call("priceFlightOffers", "post", "/v1/priced-offers", { offerIds: [offerId] });
  const pricedOfferId = required(priced, "priceFlightOffers", (priced.body as { id?: unknown }).id);
  if (browse) {
    await caller.call("getPricedOffer", "get", `/v1/priced-offers/${pricedOfferId}`);
    await caller.call("getPricedOfferAncillaries", "get", `/v1/priced-offers/${pricedOfferId}/ancillaries`);
    await caller.call("getPricedOfferFareRules", "get", `/v1/priced-offers/${pricedOfferId}/fare-rules`);
  }
  return pricedOfferId;
}

interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}
interface PaymentBody {
  readonly id: string;
  readonly amount: MoneyBody;
  readonly providerPaymentId: string | null;
}

/** A checkout of the caller (its customer's, or a guest's) with its traveller and contact and a payment of `method`. */
async function paidCheckout(
  caller: Caller,
  method: "card" | "airline_card",
  browse = false,
): Promise<{ readonly checkoutId: string; readonly payment: PaymentBody }> {
  const pricedOfferId = await pricedOffer(caller, browse);
  const created = await caller.call("createCheckout", "post", "/v1/checkouts", { pricedOfferId });
  const checkoutId = required(created, "createCheckout", (created.body as { id?: unknown }).id);
  if (browse) {
    await caller.call("getCheckout", "get", `/v1/checkouts/${checkoutId}`);
  }
  await caller.call("setCheckoutTravelers", "put", `/v1/checkouts/${checkoutId}/travelers`, {
    travelers: [buildTravelerInput()],
  });
  await caller.call("setCheckoutContacts", "put", `/v1/checkouts/${checkoutId}/contacts`, {
    contacts: [buildContactInput()],
  });
  if (browse) {
    await caller.call("setCheckoutAncillaries", "put", `/v1/checkouts/${checkoutId}/ancillaries`, {
      selections: [],
    });
    await caller.call("setCheckoutRemarks", "put", `/v1/checkouts/${checkoutId}/remarks`, {
      remarks: [buildRemarkInput()],
    });
  }
  const created2 = await caller.call(
    "createCheckoutPayment",
    "post",
    `/v1/checkouts/${checkoutId}/payments`,
    {
      method,
      termsAccepted: true,
    },
  );
  let payment = created2.body as PaymentBody;
  required(created2, "createCheckoutPayment", payment.id);
  if (browse) {
    await caller.call("getPayment", "get", `/v1/payments/${payment.id}`);
  }
  if (browse || method === "airline_card") {
    // The card form's brand and BIN: the amount may change by the card fee, which the confirmation must match.
    const hinted = await caller.call("updatePayment", "patch", `/v1/payments/${payment.id}`, {
      card: { brand: "VISA", bin: TEST_PAN.slice(0, 6) },
    });
    payment = hinted.body as PaymentBody;
    required(hinted, "updatePayment", payment.id);
  }
  if (method === "card") {
    // Stripe.js confirms the PaymentIntent in the browser.
    stripe.update(
      payment.providerPaymentId ?? "",
      buildStripeConfirmation(minorUnits(payment.amount.amount)),
    );
  }
  return { checkoutId, payment };
}

const signUpBody = (email: string): Record<string, unknown> => ({
  email,
  password: PASSWORD,
  firstName: "Anna",
  lastName: "Berg",
  marketingConsent: false,
  termsVersion: TERMS_VERSION,
});

const cardOf = (): Record<string, unknown> => ({
  brand: "VISA",
  holderName: "Anna Berg",
  number: TEST_PAN,
  expiryMonth: 12,
  expiryYear: EXPIRY_YEAR,
  securityCode: TEST_CVV,
});

interface CompletionBody {
  readonly booking: { readonly id: string; readonly reference: string };
  readonly bookingToken: string | null;
}

// ---- Setup ----------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of every operation compile on their first check: here, for the statuses checked below.
  const checker = responseChecker("ota");
  for (const operationId of CUSTOMER_OPERATIONS) {
    // The file download's 200 is a PDF, which has no JSON schema to compile.
    const success = operationId === "downloadFile" ? [] : [successOf(operationId)];
    for (const status of new Set([...success, 400, 401, 403])) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, keys, stripe] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    testKeyProvider(),
    startFakeStripe(),
  ]);
  storageDir = mkdtempSync(join(tmpdir(), "velexis-ota-cookie-mode-"));
  storage = new LocalDiskStorage(storageDir);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase & ReferenceDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: quietPoolLogger,
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const clientSecret = randomBytes(24).toString("base64url");
  await insertAlpha(await insertAmadeusAccount(clientId, clientSecret));
  await completeReference();
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

// ---- The edge journey -----------------------------------------------------------------------------------------------

/** The customer of the edge journey, the guest, and the customer who resets the password and deletes the account. */
const customer = new Visitor();
const guest = new Visitor();
const leaver = new Visitor();
/** The edge's cookies as they were before account.delete cleared them in the browser: someone who kept a copy. */
let keptBeforeDeletion = new Map<string, string>();
/** The bookings of the edge journey. */
let customerBookingId = "";
let guestBooking: CompletionBody["booking"] | undefined;
let airlineBookingId = "";

beforeAll(async () => {
  // The customer: the storefront's bootstrap, the reference data, the account.
  await customer.call("getStorefront", "get", "/v1/storefront");
  await customer.call("searchLocations", "get", "/v1/reference/locations?keyword=cdg");
  await customer.call("getAirport", "get", "/v1/reference/airports/CDG");
  await customer.call("listAirlines", "get", "/v1/reference/airlines");
  await customer.call("getAirline", "get", "/v1/reference/airlines/AF");
  await customer.call("listCountries", "get", "/v1/reference/countries");
  await customer.call("listCurrencies", "get", "/v1/reference/currencies");
  const email = newEmail("cookie-customer");
  await customer.call("signUp", "post", "/v1/auth/sign-up", signUpBody(email));
  await customer.call("verifyEmail", "post", "/v1/auth/email-verification/confirm", {
    token: await verificationTokenFor(email),
  });
  await customer.call("resendEmailVerification", "post", "/v1/auth/email-verification/resend", {});
  await customer.call("getSession", "get", "/v1/auth/session");
  await customer.call("refreshSession", "post", "/v1/auth/refresh", {});
  await customer.call("changePassword", "post", "/v1/auth/password/change", {
    currentPassword: PASSWORD,
    newPassword: CHANGED_PASSWORD,
  });
  const account = await customer.call("getAccount", "get", "/v1/account");
  await customer.call(
    "updateAccount",
    "patch",
    "/v1/account",
    { firstName: "Anja" },
    { headers: { "If-Match": String(account.headers["etag"]) } },
  );

  // Shopping, the checkout and the booking, every M2 operation on the way.
  const paid = await paidCheckout(customer, "card", true);
  const completed = await customer.call(
    "completeCheckout",
    "post",
    `/v1/checkouts/${paid.checkoutId}/complete`,
  );
  customerBookingId = required(
    completed,
    "completeCheckout",
    (completed.body as Partial<CompletionBody>).booking?.id,
  );
  const booking = `/v1/bookings/${customerBookingId}`;
  await customer.call("listBookings", "get", "/v1/bookings?timeframe=upcoming");
  await customer.call("getBooking", "get", booking);
  await customer.call("getBookingTicketingStatus", "get", `${booking}/ticketing`);
  await customer.call("listBookingEvents", "get", `${booking}/events`);
  await aWhileLater(customerBookingId);
  await customer.call("getBookingFareRules", "get", `${booking}/fare-rules`);
  const documentId = await insertItinerary(customerBookingId);
  await customer.call("listBookingDocuments", "get", `${booking}/documents`);
  const link = await customer.call(
    "getBookingDocumentDownloadUrl",
    "get",
    `${booking}/documents/${documentId}/download-url`,
  );
  // The edge gets a same-origin `/api/v1/files/…` URL, which Caddy forwards without `/api`.
  const url = required(link, "getBookingDocumentDownloadUrl", (link.body as { url?: unknown }).url);
  await customer.call("downloadFile", "get", url.replace(/^\/api/, ""));
  // The booking's current ETag before each change (a refresh may have recorded a new version).
  const etag = async (): Promise<string> =>
    String((await customer.call("getBooking", "get", booking)).headers["etag"]);
  await customer.call(
    "updateBooking",
    "patch",
    booking,
    { contacts: [buildContactInput()] },
    { headers: { "If-Match": await etag() } },
  );
  const quoted = await customer.call("quoteBookingCancellation", "get", `${booking}/cancellation-quote`);
  await customer.call(
    "cancelBooking",
    "post",
    `${booking}/cancellation`,
    {
      reasonCode: "change_of_plans",
      comment: "Trip postponed",
      expectedRefund: (quoted.body as { estimatedRefund?: unknown }).estimatedRefund,
    },
    { headers: { "If-Match": await etag() } },
  );
  // A refresh token in the body of an edge refresh is refused (OADR-0006 point 5): the page never holds one.
  await customer.call(
    "refreshSession",
    "post",
    "/v1/auth/refresh",
    { refreshToken: `rt_${randomBytes(32).toString("base64url")}` },
    { extra: "refresh_token_in_body" },
  );

  // The guest: a card booking, its lookup, and an airline-card booking.
  await guest.call("getStorefront", "get", "/v1/storefront");
  const guestPaid = await paidCheckout(guest, "card");
  const guestCompleted = await guest.call(
    "completeCheckout",
    "post",
    `/v1/checkouts/${guestPaid.checkoutId}/complete`,
  );
  guestBooking = (guestCompleted.body as Partial<CompletionBody>).booking;
  required(guestCompleted, "completeCheckout", guestBooking?.id);
  await guest.call("getBooking", "get", `/v1/bookings/${guestBooking?.id ?? ""}`);
  await guest.call("lookupBooking", "post", "/v1/bookings/lookup", {
    bookingReference: guestBooking?.reference,
    lastName: "Sample",
  });
  const airline = await paidCheckout(guest, "airline_card");
  const airlineCompleted = await guest.call(
    "completeCheckoutWithAirlineCard",
    "post",
    `/v1/checkouts/${airline.checkoutId}/airline-card-completion`,
    { paymentId: airline.payment.id, expectedTotal: airline.payment.amount, card: cardOf() },
  );
  airlineBookingId = required(
    airlineCompleted,
    "completeCheckoutWithAirlineCard",
    (airlineCompleted.body as Partial<CompletionBody>).booking?.id,
  );
  await guest.call("getBooking", "get", `/v1/bookings/${airlineBookingId}`);

  // The leaver: sign-up, sign-out, the password reset, sign-in and the deletion of the account.
  await leaver.call("getStorefront", "get", "/v1/storefront");
  const leaverEmail = newEmail("cookie-leaver");
  await leaver.call("signUp", "post", "/v1/auth/sign-up", signUpBody(leaverEmail));
  await leaver.call("signOut", "post", "/v1/auth/sign-out", {});
  await leaver.call("requestPasswordReset", "post", "/v1/auth/password-resets", { email: leaverEmail });
  await leaver.call("resetPassword", "post", "/v1/auth/password-resets/confirm", {
    token: await resetTokenFor(leaverEmail),
    newPassword: RESET_PASSWORD,
  });
  // Without rememberMe: a family of 12 hours, where sign-up, the reset and a default sign-in open one of 30 days.
  await leaver.call("signIn", "post", "/v1/auth/sign-in", {
    email: leaverEmail,
    password: RESET_PASSWORD,
    rememberMe: false,
  });
  keptBeforeDeletion = new Map(leaver.jar);
  await leaver.call("deleteAccount", "post", "/v1/account/deletion", { currentPassword: RESET_PASSWORD });
  // The cookies of the deleted account, kept by someone, are refused (FIX-W29-SECURITY).
  const kept = new Visitor();
  for (const [name, value] of keptBeforeDeletion) {
    kept.jar.set(name, value);
  }
  await kept.call("getSession", "get", "/v1/auth/session", undefined, { extra: "kept_cookie_session" });
  await kept.call("listBookings", "get", "/v1/bookings", undefined, { extra: "kept_cookie_bookings" });
}, JOURNEY_TIMEOUT_MS);

// ---- The bearer journey ---------------------------------------------------------------------------------------------

const keyCustomer = new KeyClient();
const keyGuest = new KeyClient();

beforeAll(async () => {
  await keyCustomer.call("getStorefront", "get", "/v1/storefront");
  const email = newEmail("bearer-customer");
  const signedUp = await keyCustomer.call("signUp", "post", "/v1/auth/sign-up", signUpBody(email));
  type SessionBody = { session?: { accessToken?: string; refreshToken?: string } | null };
  const sessionOf = (res: Response) => (res.body as SessionBody).session ?? undefined;
  keyCustomer.accessToken = sessionOf(signedUp)?.accessToken;
  await keyCustomer.call("verifyEmail", "post", "/v1/auth/email-verification/confirm", {
    token: await verificationTokenFor(email),
  });
  await keyCustomer.call("resendEmailVerification", "post", "/v1/auth/email-verification/resend", {});
  await keyCustomer.call("getSession", "get", "/v1/auth/session");
  const refreshed = await keyCustomer.call("refreshSession", "post", "/v1/auth/refresh", {
    refreshToken: sessionOf(signedUp)?.refreshToken,
  });
  keyCustomer.accessToken = sessionOf(refreshed)?.accessToken;
  const changed = await keyCustomer.call("changePassword", "post", "/v1/auth/password/change", {
    currentPassword: PASSWORD,
    newPassword: CHANGED_PASSWORD,
  });
  keyCustomer.accessToken = sessionOf(changed)?.accessToken;
  const account = await keyCustomer.call("getAccount", "get", "/v1/account");
  await keyCustomer.call(
    "updateAccount",
    "patch",
    "/v1/account",
    { firstName: "Anja" },
    { headers: { "If-Match": String(account.headers["etag"]) } },
  );

  // A guest's booking through the server: the token comes in the body, the server keeps it.
  const paid = await paidCheckout(keyGuest, "card");
  const completed = await keyGuest.call(
    "completeCheckout",
    "post",
    `/v1/checkouts/${paid.checkoutId}/complete`,
  );
  const booked = completed.body as Partial<CompletionBody>;
  keyGuest.bookingToken = booked.bookingToken ?? undefined;
  await keyGuest.call("getBooking", "get", `/v1/bookings/${booked.booking?.id ?? ""}`);
  const looked = await keyGuest.call("lookupBooking", "post", "/v1/bookings/lookup", {
    bookingReference: booked.booking?.reference,
    lastName: "Sample",
  });
  keyGuest.bookingToken = (looked.body as { bookingToken?: string | null }).bookingToken ?? undefined;
  // The airline card is the storefront edge's only (`x-edge-only`): a key caller is refused before anything.
  await keyGuest.call(
    "completeCheckoutWithAirlineCard",
    "post",
    `/v1/checkouts/${paid.checkoutId}/airline-card-completion`,
    { paymentId: paid.payment.id, expectedTotal: paid.payment.amount, card: cardOf() },
  );

  await keyCustomer.call("signOut", "post", "/v1/auth/sign-out", {});
  keyCustomer.accessToken = undefined;
  await keyCustomer.call("requestPasswordReset", "post", "/v1/auth/password-resets", { email });
  const reset = await keyCustomer.call("resetPassword", "post", "/v1/auth/password-resets/confirm", {
    token: await resetTokenFor(email),
    newPassword: RESET_PASSWORD,
  });
  keyCustomer.accessToken = sessionOf(reset)?.accessToken;
  const signedIn = await keyCustomer.call("signIn", "post", "/v1/auth/sign-in", {
    email,
    password: RESET_PASSWORD,
  });
  keyCustomer.accessToken = sessionOf(signedIn)?.accessToken;
  await keyCustomer.call("deleteAccount", "post", "/v1/account/deletion", {
    currentPassword: RESET_PASSWORD,
  });
}, JOURNEY_TIMEOUT_MS);

// ---- The checks -----------------------------------------------------------------------------------------------------

/** Every token value the run saw: the edge's cookies, the bearer answers, the e-mail tokens the test made. */
function knownTokens(): string[] {
  const tokens = new Set<string>(emailTokens);
  for (const exchange of exchanges) {
    for (const cookie of setCookiesOf(exchange.res)) {
      if (cookie.name === ACCESS || cookie.name === REFRESH) {
        tokens.add(cookie.value);
      }
      if (cookie.name === GUEST) {
        for (const entry of parseBookingTokens(cookie.value)) {
          tokens.add(entry.token);
        }
      }
    }
    if (exchange.mode === "key") {
      walkJson(exchange.res.body, ({ key, value }) => {
        if (
          typeof value === "string" &&
          (key === "accessToken" || key === "refreshToken" || key === "bookingToken")
        ) {
          tokens.add(value);
        }
      });
    }
  }
  // An empty value is a removed cookie, not a token.
  return [...tokens].filter((token) => token.length >= 20);
}

/** Why an edge answer would hand a token to the page: `[operationId, what]` for each finding. */
function tokenFindings(exchange: Exchange, tokens: readonly string[]): Array<[string, string]> {
  const findings: Array<[string, string]> = [];
  const label = exchange.extra ?? exchange.operationId;
  walkJson(exchange.res.body, ({ pointer, key, value }) => {
    if (typeof key === "string" && TOKEN_KEYS.has(key)) {
      findings.push([label, `token field ${pointer}`]);
    }
    if (typeof key === "string" && NULL_TOKEN_KEYS.has(key) && value !== null) {
      findings.push([label, `non-null ${pointer}`]);
    }
  });
  const text = `${bodyText(exchange.res)}\n${headerText(exchange.res)}`;
  for (const [what, shape] of TOKEN_SHAPES) {
    if (shape.test(text)) {
      findings.push([label, what]);
    }
  }
  for (const token of tokens) {
    if (text.includes(token)) {
      findings.push([label, "a token value of the run"]);
    }
  }
  return findings;
}

describe("the edge journey", () => {
  it("[OBE-057 AC1] calls every M2 and M3 operation of customer scope, each implemented, and every call succeeds as the document says [OF-03 AC1]", () => {
    expect(CUSTOMER_OPERATIONS).toHaveLength(52);
    expect(
      CUSTOMER_OPERATIONS.filter((operationId) => Object.hasOwn(PENDING_OPERATIONS, operationId)),
    ).toEqual([]);
    const edge = journeyOf("edge");
    expect([...new Set(edge.map((exchange) => exchange.operationId))].sort()).toEqual(
      [...CUSTOMER_OPERATIONS].sort(),
    );
    const failed = edge
      .filter((exchange) => exchange.res.status !== successOf(exchange.operationId))
      .map((exchange) => [
        exchange.operationId,
        exchange.res.status,
        (exchange.res.body as { error?: { code?: string } } | undefined)?.error?.code,
      ]);
    expect(failed).toEqual([]);
    for (const exchange of edge) {
      // The file download answers the PDF's bytes, which the document describes as binary.
      if (exchange.operationId !== "downloadFile") {
        expectResponseToMatch(exchange.operationId, exchange.res);
      }
    }
  });

  it("[OBE-057 AC1] never puts a token in an answer's body or headers: no token field, no token shape, no token the run saw [OF-03 AC1]", () => {
    const tokens = knownTokens();
    // The journey saw access, refresh and guest tokens in cookies and in the bearer answers.
    expect(tokens.length).toBeGreaterThan(10);
    const edge = exchanges.filter((exchange) => exchange.mode === "edge");
    expect(edge.length).toBeGreaterThan(CUSTOMER_OPERATIONS.length);
    expect(edge.flatMap((exchange) => tokenFindings(exchange, tokens))).toEqual([]);
  });

  it("[OBE-057 AC1] sets only the four __Host- cookies with Secure, SameSite=Lax, Path=/, a Max-Age and no Domain; every one but __Host-vx_csrf is HttpOnly [OF-03 AC1]", () => {
    const cookies = exchanges
      .filter((exchange) => exchange.mode === "edge")
      .flatMap((exchange) =>
        setCookiesOf(exchange.res).map((cookie) => [exchange.operationId, cookie] as const),
      );
    expect(new Set(cookies.map(([, cookie]) => cookie.name))).toEqual(COOKIE_NAMES);
    const problems: Array<[string, string, string]> = [];
    for (const [operationId, cookie] of cookies) {
      const readable = cookie.name === CSRF;
      const expected = ["Path=/", "Secure", "SameSite=Lax", ...(readable ? [] : ["HttpOnly"])];
      const maxAge = cookie.attributes.filter((attribute) => /^Max-Age=\d+$/.test(attribute));
      const others = cookie.attributes.filter((attribute) => !/^Max-Age=\d+$/.test(attribute));
      if (!cookie.name.startsWith("__Host-") || !COOKIE_NAMES.has(cookie.name)) {
        problems.push([operationId, cookie.name, "name"]);
      }
      if (maxAge.length !== 1 || [...others].sort().join("; ") !== [...expected].sort().join("; ")) {
        problems.push([operationId, cookie.name, cookie.attributes.join("; ")]);
      }
    }
    expect(problems).toEqual([]);
  });

  it("[OBE-057 AC1] gives each cookie its OADR-0006 lifetime: 15 minutes, the rest of the refresh family (12 hours, 30 days with rememberMe), 30 days; Max-Age=0 only ends a session [OF-03 AC1]", () => {
    const maxAgeOf = (cookie: SetCookie | undefined): number =>
      Number(
        cookie?.attributes.find((attribute) => attribute.startsWith("Max-Age="))?.slice("Max-Age=".length),
      );
    const problems: Array<[string, string, number]> = [];
    for (const exchange of exchanges.filter((entry) => entry.mode === "edge")) {
      for (const cookie of setCookiesOf(exchange.res)) {
        const age = maxAgeOf(cookie);
        const ended = (cookie.name === ACCESS || cookie.name === REFRESH) && cookie.value === "" && age === 0;
        const lives =
          cookie.name === ACCESS
            ? age === 900
            : cookie.name === REFRESH
              ? age > 900 && age <= 30 * DAY_SECONDS
              : age === 30 * DAY_SECONDS;
        if (!ended && !lives) {
          problems.push([exchange.operationId, cookie.name, age]);
        }
      }
    }
    expect(problems).toEqual([]);
    // The family's rest, never extended: the leaver's sign-in without rememberMe lives at most 12 hours, the sessions
    // that sign-up, the reset and the password change open (and their refresh) longer.
    const brief = maxAgeOf(cookieOf(first("edge", "signIn"), REFRESH));
    expect(brief).toBeGreaterThan(900);
    expect(brief).toBeLessThanOrEqual(12 * HOUR_SECONDS);
    for (const operationId of ["signUp", "resetPassword", "changePassword", "refreshSession"] as const) {
      expect([
        operationId,
        maxAgeOf(cookieOf(first("edge", operationId), REFRESH)) > 12 * HOUR_SECONDS,
      ]).toEqual([operationId, true]);
    }
  });

  it("[OBE-057 AC1] leaves __Host-vx_csrf as the only cookie JavaScript can read, and its value is a random CSRF value, never a token [OF-03 AC1]", () => {
    const tokens = new Set(knownTokens());
    const readable = exchanges
      .filter((exchange) => exchange.mode === "edge")
      .flatMap((exchange) => setCookiesOf(exchange.res))
      .filter((cookie) => !cookie.attributes.includes("HttpOnly"));
    expect(readable.length).toBeGreaterThan(5);
    for (const cookie of readable) {
      expect(cookie.name).toBe(CSRF);
      expect(cookie.value).toMatch(CSRF_TOKEN_PATTERN);
      expect(tokens.has(cookie.value)).toBe(false);
    }
  });

  it("puts the session into cookies: sign-up, sign-in, reset and password change open or rotate it with a new CSRF value, refresh keeps the CSRF value, sign-out and deletion end it", () => {
    const expectSession = (res: Response, csrf: "rotated" | "kept"): void => {
      const [access, refresh] = [cookieOf(res, ACCESS), cookieOf(res, REFRESH)];
      expect(access?.value).toMatch(/^eyJ/);
      expect(access?.attributes).toContain("Max-Age=900");
      expect(refresh?.value).toMatch(REFRESH_TOKEN_PATTERN);
      const refreshAge = refresh?.attributes.find((attribute) => attribute.startsWith("Max-Age="));
      expect(Number(refreshAge?.slice("Max-Age=".length))).toBeGreaterThan(900);
      expect(cookieOf(res, CSRF) === undefined).toBe(csrf === "kept");
    };
    const expectEnded = (res: Response): void => {
      for (const name of [ACCESS, REFRESH]) {
        expect(cookieOf(res, name)).toMatchObject({
          value: "",
          attributes: expect.arrayContaining(["Max-Age=0"]),
        });
      }
      expect(cookieOf(res, CSRF)?.value).toMatch(CSRF_TOKEN_PATTERN);
    };
    const signUps = answersOf("edge", "signUp");
    expect(signUps).toHaveLength(2);
    for (const res of signUps) {
      expectSession(res, "rotated");
    }
    expectSession(first("edge", "signIn"), "rotated");
    expectSession(first("edge", "resetPassword"), "rotated");
    expectSession(first("edge", "changePassword"), "rotated");
    expectSession(first("edge", "refreshSession"), "kept");
    expectEnded(first("edge", "signOut"));
    expectEnded(first("edge", "deleteAccount"));
    // Rotation never hands out a refresh token twice (an access JWT signed in the same second for the same session
    // has the same claims, and may be the same).
    const refreshValues = exchanges.flatMap((exchange) => {
      const value = cookieOf(exchange.res, REFRESH)?.value;
      return value === undefined || value === "" ? [] : [value];
    });
    expect(refreshValues).toHaveLength(6);
    expect(new Set(refreshValues).size).toBe(refreshValues.length);
    // The rotated CSRF value differs from the one the browser had from the storefront's bootstrap.
    expect(cookieOf(first("edge", "getStorefront"), CSRF)?.value).toMatch(CSRF_TOKEN_PATTERN);
    expect(cookieOf(first("edge", "signUp"), CSRF)?.value).not.toBe(
      cookieOf(first("edge", "getStorefront"), CSRF)?.value,
    );
    // Only these operations (and the storefront's bootstrap and the guest's bookings) ever set a cookie.
    const setters = new Set(
      exchanges
        .filter((exchange) => exchange.mode === "edge" && setCookiesOf(exchange.res).length > 0)
        .map((exchange) => exchange.operationId),
    );
    expect([...setters].sort()).toEqual(
      [
        "getStorefront",
        "signUp",
        "signIn",
        "refreshSession",
        "changePassword",
        "resetPassword",
        "signOut",
        "deleteAccount",
        "completeCheckout",
        "completeCheckoutWithAirlineCard",
        "lookupBooking",
      ].sort(),
    );
    // The edge's answers carry the session's metadata, never its tokens (OADR-0006 point 4).
    for (const operationId of ["signIn", "refreshSession", "changePassword", "getSession"] as const) {
      expect(first("edge", operationId).body).toMatchObject({
        customer: { id: expect.stringMatching(/^cus_/) as string },
        session: { id: expect.stringMatching(/^ses_/) as string },
      });
    }
    for (const operationId of ["signUp", "resetPassword"] as const) {
      expect(first("edge", operationId).body).toMatchObject({ session: null });
    }
  });

  it("[OBE-057 AC1] gives a guest's bookings to __Host-vx_bt: completion, airline-card completion and lookup answer bookingToken null [OF-03 AC1]", () => {
    const completionOf = (bookingId: string | undefined): Response => {
      const found = answersOf("edge", "completeCheckout").find(
        (res) => (res.body as CompletionBody).booking.id === bookingId,
      );
      if (found === undefined) {
        throw new Error(`no completion of ${String(bookingId)}`);
      }
      return found;
    };
    const completed = completionOf(guestBooking?.id);
    const looked = first("edge", "lookupBooking");
    const airline = first("edge", "completeCheckoutWithAirlineCard");
    for (const res of [completed, looked, airline]) {
      expect(res.body).toMatchObject({ bookingToken: null });
      expect(cookieOf(res, GUEST)?.attributes).toEqual(
        expect.arrayContaining(["HttpOnly", "Max-Age=2592000"]),
      );
    }
    const entriesOf = (res: Response): string[] =>
      parseBookingTokens(cookieOf(res, GUEST)?.value).map((entry) => entry.bookingId);
    expect(entriesOf(completed)).toEqual([guestBooking?.id]);
    expect(entriesOf(looked)).toEqual([guestBooking?.id]);
    // The lookup replaced the booking's entry; the airline-card booking went in front of it.
    expect(entriesOf(airline)).toEqual([airlineBookingId, guestBooking?.id]);
    // The customer's own booking needs no guest token.
    const own = completionOf(customerBookingId);
    expect(own.body).toMatchObject({ bookingToken: null, bookingTokenExpiresAt: null });
    expect(cookieOf(own, GUEST)).toBeUndefined();
  });

  it("refuses a refresh token in the body of an edge refresh, and the cookies of a deleted account", () => {
    const inBody = extraOf("refresh_token_in_body");
    expect([inBody.status, inBody.body.error?.code]).toEqual([400, "INVALID_REQUEST"]);
    expectResponseToMatch("refreshSession", inBody);
    for (const [label, operationId] of [
      ["kept_cookie_session", "getSession"],
      ["kept_cookie_bookings", "listBookings"],
    ] as const) {
      const res = extraOf(label);
      expect([label, res.status, res.body.error?.code]).toEqual([label, 401, "UNAUTHENTICATED"]);
      expectResponseToMatch(operationId, res);
    }
    expect(keptBeforeDeletion.get(ACCESS)).toMatch(/^eyJ/);
  });
});

describe("the bearer journey", () => {
  it("[OBE-057 AC1] calls the same auth and booking-access operations as the edge, which answer their tokens in the body, and never sets a cookie", () => {
    const key = journeyOf("key");
    const called = new Set(key.map((exchange) => exchange.operationId));
    expect(AUTH_AND_ACCESS_OPERATIONS.filter((operationId) => !called.has(operationId))).toEqual([]);
    expect(
      AUTH_AND_ACCESS_OPERATIONS.filter((operationId) => answersOf("edge", operationId).length === 0),
    ).toEqual([]);
    for (const exchange of exchanges.filter((entry) => entry.mode === "key")) {
      expect([exchange.operationId, exchange.res.headers["set-cookie"]]).toEqual([
        exchange.operationId,
        undefined,
      ]);
    }
    const failed = key
      .filter(
        (exchange) =>
          exchange.operationId !== "completeCheckoutWithAirlineCard" &&
          exchange.res.status !== successOf(exchange.operationId),
      )
      .map((exchange) => [exchange.operationId, exchange.res.status, exchange.res.body.error?.code]);
    expect(failed).toEqual([]);
    for (const exchange of key) {
      expectResponseToMatch(exchange.operationId, exchange.res);
    }
  });

  it("[OBE-057 AC1] returns the session's tokens from sign-up, sign-in, refresh, password change and reset, as the contract always has", () => {
    for (const operationId of [
      "signUp",
      "signIn",
      "refreshSession",
      "changePassword",
      "resetPassword",
    ] as const) {
      expect([operationId, first("key", operationId).body.session]).toEqual([
        operationId,
        expect.objectContaining({
          accessToken: expect.stringMatching(
            /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
          ) as string,
          refreshToken: expect.stringMatching(REFRESH_TOKEN_PATTERN) as string,
          tokenType: "Bearer",
        }),
      ]);
    }
    // Each answer's refresh token is a new one.
    const refreshTokens = (
      ["signUp", "refreshSession", "changePassword", "resetPassword", "signIn"] as const
    ).map((operationId) => String(first("key", operationId).body.session?.refreshToken));
    expect(new Set(refreshTokens).size).toBe(refreshTokens.length);
  });

  it("[OBE-057 AC1] returns a guest's booking token from checkout.complete and bookings.lookup, and refuses the airline card to a key caller", () => {
    const [completed] = answersOf("key", "completeCheckout");
    const [looked] = answersOf("key", "lookupBooking");
    expect(completed?.body.bookingToken).toMatch(BOOKING_TOKEN_PATTERN);
    expect(looked?.body.bookingToken).toMatch(BOOKING_TOKEN_PATTERN);
    expect(looked?.body.bookingToken).not.toBe(completed?.body.bookingToken);
    // The token opened the booking with X-Booking-Token.
    expect(answersOf("key", "getBooking")[0]?.status).toBe(200);
    const [airline] = answersOf("key", "completeCheckoutWithAirlineCard");
    expect([airline?.status, airline?.body.error?.code]).toEqual([403, "SCOPE_NOT_ALLOWED"]);
  });

  it("ignores the edge's cookies on a key caller's request (OADR-0006 point 1)", async () => {
    const cookies = [...customer.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    expect(customer.jar.get(ACCESS)).toMatch(/^eyJ/);
    const withCookies = await request(api.server)
      .get("/v1/auth/session")
      .set({ "X-Api-Key": alphaSk, Cookie: cookies });
    const viaEdge = await request(api.server)
      .get("/v1/auth/session")
      .set({ ...edgeHeaders(ALPHA_HOST), Cookie: cookies });

    expect([withCookies.status, withCookies.body.error?.code]).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("getSession", withCookies);
    expect(withCookies.headers["set-cookie"]).toBeUndefined();
    // The same cookies are the customer's session on the storefront.
    expect(viaEdge.status).toBe(200);
  });

  it("never writes a token of either journey to a log line", () => {
    const logs = api.sink.text();
    expect(knownTokens().filter((token) => logs.includes(token))).toEqual([]);
  });
});
