// The OTA side of the end-to-end stack (OFE-008): data of the demo OTA and of the suspended OTA that the storefront
// journeys cannot create through a page or a public operation (PADR-0017 item 5), and the check that the storefront
// sees selling prices only (OF-02 AC1).
//
//   const searchId = searchIdOf(page.url());          // the srch_ id the results page wrote into the address
//   await expireSearch(searchId);                       // its expires_at (and its offers') one hour in the past
//   await withSuspendedTenant(async () => { … });      // the OTA of SUSPENDED_STOREFRONT_URL, suspended meanwhile
//
// The M3 journeys of OFE-019 add (the last part of this file):
//
//   await enableAirlineCard();                          // the demo OTA's test storefront offers the airline card
//   await enableSelfServiceCancellation();              // and lets its customers cancel online
//   const api = new StorefrontApi(context, ip);         // the OTA API through the preview, as the browser's SDK calls it
//   const trip = await bookAirlineCardTrip(api, { … }); // a booking through the API, paid with the airline card
//   await moveBookingIntoThePast(trip.bookingId);       // its flight 30 days ago: a past trip
//   await expireAccessToken(context);                   // the access token in the cookie, as the API sees it 16 min later
//
// Tenant data goes through `tenantTx` of @velexis/db as velexis_ota_app, the OTA backend's own role, never through
// schema-qualified SQL or a session-level search_path (ADR-0004). The platform row of the suspended OTA is written as
// velexis_migrator, as the OTA backend's development seed writes the demo OTA's (ota/backend/README.md §5): the platform
// API has no operation that creates a suspended OTA, and the demo OTA stays active for every other journey. After the
// change the platform's `tenant` invalidation is published, as the platform does after its commit, so the OTA API
// reads the new status at once instead of after the 60 s of its cache.
import { createPrivateKey, randomInt, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type BrowserContext } from "@playwright/test";
import { INVALIDATION_CHANNEL, type TenantInvalidation } from "@velexis/api-types/jobs";
import {
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Transaction,
  type TenantDatabase,
} from "@velexis/db";
import Redis from "ioredis";
import { stack, withDatabase } from "./seed";
import {
  DEMO_TENANT_KEY,
  REPO_ROOT,
  serviceEnv,
  stackDatabaseUrl,
  STOREFRONT_URL,
  SUSPENDED_TENANT_KEY,
} from "./stack";
import { CSRF_COOKIE } from "./storefront-guards";

/** The schema of the demo OTA that the OTA backend's `dev:seed` provisions. */
export const DEMO_TENANT_SCHEMA = `tenant_${DEMO_TENANT_KEY}`;

/** A search id as the API writes it: `srch_` and a ULID. */
const SEARCH_ID = /^srch_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The `search=srch_…` id of a results page address, or a readable error when it has none (yet). */
export function searchIdOf(address: string): string {
  const id = new URL(address).searchParams.get("search");
  if (id === null || !SEARCH_ID.test(id)) {
    throw new Error(`the address ${new URL(address).pathname} has no search=srch_… id`);
  }
  return id;
}

/**
 * Runs `fn` in one `tenantTx` on `schema` of the stack's database as velexis_ota_app, with a pool of its own that is
 * closed afterwards. The DSN carries a development password: it is never logged.
 */
export async function withTenantTx<T>(
  schema: string,
  fn: (trx: Transaction<TenantDatabase>) => Promise<T>,
): Promise<T> {
  // A dropped idle connection of this short-lived pool does not matter: the transaction itself reports its errors.
  const pool = createPool(stackDatabaseUrl(stack(), "ota"), {
    applicationName: "velexis-e2e-ota",
    logger: { error: () => undefined },
    max: 1,
  });
  try {
    return await tenantTx(createTenantDb(pool, { appEnv: "test" }), schema, fn);
  } finally {
    await pool.end();
  }
}

/**
 * Moves the expiry of the demo OTA's search `searchId` and of its offers one hour into the past, as if their time to
 * live (`offer_ttl_minutes`) had run out: `flights.getSearch` then answers `status: "expired"` and
 * `flights.listResults` `410 SEARCH_EXPIRED`. Throws when the search is not there.
 */
export async function expireSearch(searchId: string): Promise<void> {
  await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    const expired = sql<Date>`now() - interval '1 hour'`;
    const search = await trx
      .updateTable("flight_searches")
      .set({ expires_at: expired, updated_at: sql<Date>`now()` })
      .where("id", "=", searchId)
      .executeTakeFirst();
    if (search.numUpdatedRows !== 1n) {
      throw new Error(`the demo OTA has no search ${searchId}`);
    }
    await trx
      .updateTable("flight_offers")
      .set({ expires_at: expired })
      .where("search_id", "=", searchId)
      .execute();
  });
}

/** Publishes the platform's `tenant` invalidation of `tenantId` on the stack's Redis (OADR-0009 point 4). */
export async function publishTenantInvalidation(tenantId: string): Promise<void> {
  const redis = new Redis(stack().redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    const event: TenantInvalidation = { v: 1, type: "tenant", id: tenantId };
    await redis.publish(INVALIDATION_CHANNEL, JSON.stringify(event));
  } finally {
    redis.disconnect();
  }
}

/** Crockford's base 32, the alphabet of ULIDs. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new tenant id: `ten_` and 26 characters of a ULID (a leading `0`, so it is a valid one). */
export function newTenantId(): string {
  let id = "0";
  while (id.length < 26) {
    id += CROCKFORD[randomInt(CROCKFORD.length)] ?? "0";
  }
  return `ten_${id}`;
}

/**
 * Runs `fn` while the OTA SUSPENDED_TENANT_KEY ("Suspended Travel", storefront `test`) is `suspended`, the state the
 * platform's `adminSuspendTenant` leaves an OTA in: its row is created the first time (or set back to `suspended`), and
 * afterwards, also when `fn` fails, it is set `deleted`, which no schedule of the OTA worker visits. It has no schema:
 * the OTA API refuses a suspended OTA's host before it reads any tenant data (`403 TENANT_SUSPENDED`). The OTA
 * worker's every-minute schedules do target suspended OTAs (OADR-0014 point 4), so a fan-out that falls into the few
 * seconds of `fn` gives it a job that fails on the missing schema; BullMQ's retry finds it `deleted` and skips it.
 * Only the preview on SUSPENDED_STOREFRONT_URL serves its host, so no other journey ever meets it.
 */
export async function withSuspendedTenant<T>(fn: (tenantId: string) => Promise<T>): Promise<T> {
  const tenantId = await withDatabase("migrator", async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO platform.tenants (id, key, name, status, plan_code, storefront_environment, suspended_at,
                                     suspension_reason)
       VALUES ($1, $2, 'Suspended Travel', 'suspended', 'early_access', 'test', now(), 'admin')
       ON CONFLICT (key) DO UPDATE
         SET status = 'suspended', suspended_at = now(), suspension_reason = 'admin', deleted_at = NULL,
             version = platform.tenants.version + 1, updated_at = now()
       RETURNING id`,
      [newTenantId(), SUSPENDED_TENANT_KEY],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error(`the tenant ${SUSPENDED_TENANT_KEY} was not written`);
    }
    return id;
  });
  await publishTenantInvalidation(tenantId);
  try {
    return await fn(tenantId);
  } finally {
    await withDatabase("migrator", async (client) => {
      await client.query(
        `UPDATE platform.tenants
            SET status = 'deleted', deleted_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1`,
        [tenantId],
      );
    });
    await publishTenantInvalidation(tenantId);
  }
}

/** Keys of net amounts (`netPrice`, `netBase`, `netTotal`, …), at any depth: console scope only. */
export const NET_FIELD = /^net/i;

/**
 * Keys the OTA document keeps to console scope: `markup*` (OfferMarkup), `margin*` (Amadeus `price.margins`),
 * `diagnostics` (FlightSearchDiagnostics) and `supplier*` (the error envelope's SupplierIssue); also `amadeus` inside
 * `dictionaries` (the verbatim Amadeus dictionaries), which `customerScopeLeaks` checks by its parent.
 */
export const CONSOLE_ONLY_FIELD = /^(?:markup|margin|diagnostics$|supplier)/i;

/** Why a value must not be in a customer-scope answer. */
export type LeakReason = "net_field" | "console_only_field" | "amadeus_price";

/** One value of an answer that customer scope must not see: its JSON pointer (RFC 6901) and why. */
export interface CustomerScopeLeak {
  readonly pointer: string;
  readonly reason: LeakReason;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A key escaped for a JSON pointer (RFC 6901: `~` → `~0`, `/` → `~1`). */
const pointerSegment = (key: string | number): string => String(key).replace(/~/g, "~0").replace(/\//g, "~1");

/** `value.price.total.amount` and `value.amadeus.price.grandTotal` when both are strings. */
function sellingAndAmadeusTotal(value: unknown): { selling: string; amadeus: string } | undefined {
  if (!isObject(value) || !isObject(value["price"]) || !isObject(value["amadeus"])) {
    return undefined;
  }
  const total = value["price"]["total"];
  const amadeusPrice = value["amadeus"]["price"];
  const selling = isObject(total) ? total["amount"] : undefined;
  const amadeus = isObject(amadeusPrice) ? amadeusPrice["grandTotal"] : undefined;
  return typeof selling === "string" && typeof amadeus === "string" ? { selling, amadeus } : undefined;
}

/**
 * Every value of a storefront (customer-scope) answer that only console scope may see, in document order; empty for
 * a clean answer (OF-02 AC1: selling prices only). The rules of the OTA backend's own walk
 * (ota/backend/test/support/json-walk.ts `customerScopeLeaks`, OBE-026), deliberately stricter than the document:
 *
 *   net_field            a key `net*`, at any depth
 *   console_only_field   a key of CONSOLE_ONLY_FIELD, or `amadeus` inside `dictionaries`
 *   amadeus_price        an offer whose embedded Amadeus `amadeus.price.grandTotal` differs from its selling
 *                        `price.total.amount`: the Amadeus block was not rewritten to the selling price
 */
export function customerScopeLeaks(value: unknown): CustomerScopeLeak[] {
  const leaks: CustomerScopeLeak[] = [];
  const walk = (
    current: unknown,
    pointer: string,
    key: string | number | null,
    parentKey: string | number | null,
  ) => {
    if (typeof key === "string") {
      if (NET_FIELD.test(key)) {
        leaks.push({ pointer, reason: "net_field" });
      } else if (CONSOLE_ONLY_FIELD.test(key) || (key === "amadeus" && parentKey === "dictionaries")) {
        leaks.push({ pointer, reason: "console_only_field" });
      }
    }
    const prices = sellingAndAmadeusTotal(current);
    if (prices !== undefined && prices.selling !== prices.amadeus) {
      leaks.push({ pointer: `${pointer}/amadeus/price/grandTotal`, reason: "amadeus_price" });
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${pointer}/${index}`, index, key));
    } else if (isObject(current)) {
      for (const [name, item] of Object.entries(current)) {
        walk(item, `${pointer}/${pointerSegment(name)}`, name, key);
      }
    }
  };
  walk(value, "", null, null);
  return leaks;
}

// ---- The M3 journeys of the storefront (OFE-019) ---------------------------------------------------------------------

/** The cookies of a customer session on the storefront (OADR-0006 point 2): both httpOnly. */
export const ACCESS_COOKIE = "__Host-vx_at";
export const REFRESH_COOKIE = "__Host-vx_rt";

/** How long a customer access token of the OTA API lives (ota/backend token.service.ts, ADR-0008). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** How old `expireAccessToken` makes the token: its 15 minutes and one more, beyond the API's 30 s of clock skew. */
export const EXPIRED_TOKEN_AGE_SECONDS = ACCESS_TOKEN_TTL_SECONDS + 60;

/** How long the airline card's switch may take to show in storefront.get (a cache entry filled meanwhile is dropped). */
const AIRLINE_CARD_SWITCH_WAIT_MS = 10_000;

/** The demo OTA's tenant id: its platform row, read as the OTA backend's own role. */
export async function demoTenantId(): Promise<string> {
  return await withDatabase("ota", async (client) => {
    const { rows } = await client.query<{ id: string }>("SELECT id FROM platform.tenants WHERE key = $1", [
      DEMO_TENANT_KEY,
    ]);
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error(`the stack has no tenant ${DEMO_TENANT_KEY}`);
    }
    return id;
  });
}

/**
 * Deletes the storefront.get entries of `tenantId`'s test environment (`t:<tenantId>:test:sf:<locale>`, 5 minutes) on
 * the stack's Redis, as the settings change of the OTA admin does after its commit (OBE-070).
 */
export async function dropStorefrontCache(tenantId: string): Promise<void> {
  const redis = new Redis(stack().redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `t:${tenantId}:test:sf:*`, "COUNT", 100);
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } finally {
    redis.disconnect();
  }
}

/** Whether storefront.get, asked through the preview as the storefront edge, offers the airline card now. */
export async function storefrontOffersAirlineCard(): Promise<boolean> {
  const answer = await fetch(`${STOREFRONT_URL}/api/v1/storefront`, {
    headers: { accept: "application/json" },
  });
  if (!answer.ok) {
    return false;
  }
  const config = (await answer.json()) as { payment?: { supportedMethods?: unknown } };
  const methods = config.payment?.supportedMethods;
  return Array.isArray(methods) && methods.includes("airline_card");
}

/**
 * Turns the airline card on for the demo OTA's test storefront (`storefront_settings.airline_card_enabled_test`, the
 * switch of the OTA admin; AIRLINE_CARD_ENABLED is true in ota/backend/.env.example, which the stack's OTA processes
 * get) and waits until storefront.get offers it: each poll drops the cached entries first, so an entry that a request
 * of another journey filled from the old row meanwhile goes too. It stays on: no journey needs it off.
 */
export async function enableAirlineCard(): Promise<void> {
  await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    await trx
      .updateTable("storefront_settings")
      .set({
        airline_card_enabled_test: true,
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where("airline_card_enabled_test", "=", false)
      .execute();
  });
  const tenantId = await demoTenantId();
  await expect
    .poll(
      async () => {
        await dropStorefrontCache(tenantId);
        return await storefrontOffersAirlineCard();
      },
      { timeout: AIRLINE_CARD_SWITCH_WAIT_MS },
    )
    .toBe(true);
}

/**
 * Offers self-service cancellation on the demo OTA's storefront (`storefront_settings.features.selfServiceCancellation`,
 * the switch of the OTA admin; off for a new OTA): bookings.get then allows `canCancel` and bookings.cancel takes the
 * customer's cancellation (ota/docs/flows/change-and-cancel.md §3). The bookings operations read the row per request;
 * the storefront.get entries are dropped as the OTA admin's change does. It stays on: no journey needs it off.
 */
export async function enableSelfServiceCancellation(): Promise<void> {
  await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    await trx
      .updateTable("storefront_settings")
      .set({
        features: sql`features || '{"selfServiceCancellation": true}'::jsonb`,
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where(sql<boolean>`coalesce((features ->> 'selfServiceCancellation')::boolean, false) = false`)
      .execute();
  });
  await dropStorefrontCache(await demoTenantId());
}

/** A refusal of the OTA API to a seed call: the operation, the status and the error code, never a body. */
export class StorefrontApiError extends Error {
  override readonly name = "StorefrontApiError";

  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`${operation} answered ${status}${code === undefined ? "" : ` ${code}`}`);
  }
}

/** The `error.code` of an OTA API error envelope, when the answer is one. */
export function errorCodeOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const error = (body as { error?: unknown }).error;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The methods of the OTA API that a seed calls. */
export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH";

/** What `StorefrontApi` needs of a browser context: its request API (which shares its cookies) and its cookies. */
export type StorefrontApiContext = Pick<BrowserContext, "request" | "cookies">;

/**
 * The OTA API as the storefront's SDK in cookie mode calls it from a browser context (OADR-0006): through the preview's
 * `/api/*` proxy, which adds the edge headers Caddy adds (the storefront edge caller, the only one the airline card
 * takes), with the context's cookies (the session, the guest tokens) and on every write the `__Host-vx_csrf` value as
 * `X-CSRF-Token`, a new `Idempotency-Key` on every POST, and the context's end-user IP as `X-Forwarded-For`, so the
 * per-IP limits count this journey alone. For data a page would make with many steps (PADR-0017 item 5).
 */
export class StorefrontApi {
  constructor(
    private readonly context: StorefrontApiContext,
    private readonly endUserIp: string,
  ) {}

  /** The value of the context's cookie `name` on the storefront, if it has one. */
  async cookie(name: string): Promise<string | undefined> {
    return (await this.context.cookies(STOREFRONT_URL)).find((cookie) => cookie.name === name)?.value;
  }

  /** The CSRF value the context holds, after a storefront.get that issues it when it holds none. */
  private async csrfToken(): Promise<string> {
    let value = await this.cookie(CSRF_COOKIE);
    if (value === undefined) {
      await this.call("getStorefront", "GET", "/v1/storefront");
      value = await this.cookie(CSRF_COOKIE);
    }
    if (value === undefined) {
      throw new Error(`storefront.get set no ${CSRF_COOKIE} cookie`);
    }
    return value;
  }

  /**
   * Calls `method path` of the OTA API (`/v1/…`) with `body` and returns the JSON answer; a status other than
   * `expected` throws a StorefrontApiError that names `operation`, the status and the error code only.
   */
  async call(
    operation: string,
    method: ApiMethod,
    path: string,
    body?: unknown,
    expected = 200,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json", "x-forwarded-for": this.endUserIp };
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      headers["x-csrf-token"] = await this.csrfToken();
    }
    if (method === "POST") {
      headers["idempotency-key"] = randomUUID();
    }
    const response = await this.context.request.fetch(`${STOREFRONT_URL}/api${path}`, {
      method,
      headers,
      failOnStatusCode: false,
      ...(body === undefined ? {} : { data: JSON.stringify(body) }),
    });
    const status = response.status();
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      answer = undefined;
    }
    if (status !== expected) {
      throw new StorefrontApiError(operation, status, errorCodeOf(answer));
    }
    return answer;
  }
}

/** What a seed calls of the OTA API (a fake in the unit tests). */
export type SeedApi = Pick<StorefrontApi, "call">;

/** The traveller of a seeded booking: synthetic. */
export interface SeedTraveller {
  readonly firstName: string;
  readonly lastName: string;
  /** `YYYY-MM-DD`. */
  readonly dateOfBirth: string;
  readonly gender: "FEMALE" | "MALE";
}

/** What `bookAirlineCardTrip` books. */
export interface AirlineCardTripInput {
  /** The departure the search asks for, days from today (the stub answers its fixture's flights whatever the date). */
  readonly daysAhead: number;
  readonly traveller: SeedTraveller;
  /** The booking's contact e-mail address. */
  readonly email: string;
}

/** A booking that `bookAirlineCardTrip` made. */
export interface SeededBooking {
  readonly bookingId: string;
  readonly reference: string;
  readonly checkoutId: string;
  readonly paymentId: string;
}

/**
 * The card the Amadeus stub's Flight Create Orders accepts: Visa's documented test number (OADR-0017), a security code
 * and an expiry three years ahead. Test data only; it lives in this process's memory for the one request that sends it.
 */
export function airlineTestCard(holderName: string): {
  readonly brand: "VISA";
  readonly holderName: string;
  readonly number: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly securityCode: string;
} {
  return {
    brand: "VISA",
    holderName,
    number: "4111111111111111",
    expiryMonth: 11,
    expiryYear: new Date().getUTCFullYear() + 3,
    securityCode: "853",
  };
}

/** A departure `daysAhead` days from today, `YYYY-MM-DD`: never a fixed calendar date. */
export function departureDate(daysAhead: number, now = new Date()): string {
  return new Date(now.getTime() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

/** A string field of an answer that the next step needs; throws with the operation's name when it is missing. */
function field(
  answer: unknown,
  operation: string,
  read: (value: Record<string, unknown>) => unknown,
): string {
  const value =
    typeof answer === "object" && answer !== null ? read(answer as Record<string, unknown>) : undefined;
  if (typeof value !== "string" || value === "") {
    throw new Error(`${operation} answered without the field the next step needs`);
  }
  return value;
}

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Books a one-way trip from Madrid to Paris on the demo OTA through the OTA API, as the storefront's pages would, paid
 * with the airline card so that no Stripe is needed (ota/docs/flows/checkout-airline-card.md): flights.search, the
 * first offer priced, checkout.create (for the customer of the context's session, or a guest), the traveller and the
 * contact, checkout.createPayment `airline_card` with the terms accepted, checkout.updatePayment with the card's brand
 * and BIN (the airline's card fee), checkout.completeWithAirlineCard for the quoted total. The demo OTA issues the
 * tickets at completion (`issue_after_payment`). Needs `enableAirlineCard()` first.
 */
export async function bookAirlineCardTrip(api: SeedApi, input: AirlineCardTripInput): Promise<SeededBooking> {
  const search = await api.call(
    "flights.search",
    "POST",
    "/v1/flight-searches",
    {
      mode: "simple",
      originLocationCode: "MAD",
      destinationLocationCode: "PAR",
      departureDate: departureDate(input.daysAhead),
      adults: 1,
    },
    201,
  );
  const offers = objectOf(search)["offers"];
  const offerId = field(
    Array.isArray(offers) ? offers[0] : undefined,
    "flights.search",
    (offer) => offer["id"],
  );
  const priced = await api.call("offers.price", "POST", "/v1/priced-offers", { offerIds: [offerId] }, 201);
  const pricedOfferId = field(priced, "offers.price", (value) => value["id"]);
  const checkout = await api.call("checkout.create", "POST", "/v1/checkouts", { pricedOfferId }, 201);
  const checkoutId = field(checkout, "checkout.create", (value) => value["id"]);

  const { traveller } = input;
  await api.call("checkout.setTravelers", "PUT", `/v1/checkouts/${checkoutId}/travelers`, {
    travelers: [
      {
        travelerId: "1",
        name: { firstName: traveller.firstName, lastName: traveller.lastName },
        dateOfBirth: traveller.dateOfBirth,
        gender: traveller.gender,
      },
    ],
  });
  await api.call("checkout.setContacts", "PUT", `/v1/checkouts/${checkoutId}/contacts`, {
    contacts: [
      {
        purpose: "STANDARD",
        isPrimary: true,
        addresseeName: { firstName: traveller.firstName, lastName: traveller.lastName },
        emailAddress: input.email,
        phones: [{ deviceType: "MOBILE", countryCallingCode: "34", number: "600000000" }],
        language: "en",
      },
    ],
  });

  const card = airlineTestCard(`${traveller.firstName} ${traveller.lastName}`);
  const created = await api.call(
    "checkout.createPayment",
    "POST",
    `/v1/checkouts/${checkoutId}/payments`,
    { method: "airline_card", termsAccepted: true },
    201,
  );
  const paymentId = field(created, "checkout.createPayment", (value) => value["id"]);
  // The card form's brand and BIN: the airline's card fee, which the completion's expected total must include.
  const quoted = await api.call("checkout.updatePayment", "PATCH", `/v1/payments/${paymentId}`, {
    card: { brand: card.brand, bin: card.number.slice(0, 6) },
  });
  const amount = objectOf(objectOf(quoted)["amount"]);
  const expectedTotal = {
    amount: field(amount, "checkout.updatePayment", (value) => value["amount"]),
    currency: field(amount, "checkout.updatePayment", (value) => value["currency"]),
  };
  const completed = await api.call(
    "checkout.completeWithAirlineCard",
    "POST",
    `/v1/checkouts/${checkoutId}/airline-card-completion`,
    { paymentId, expectedTotal, card },
    201,
  );
  const booking = objectOf(objectOf(completed)["booking"]);
  return {
    bookingId: field(booking, "checkout.completeWithAirlineCard", (value) => value["id"]),
    reference: field(booking, "checkout.completeWithAirlineCard", (value) => value["reference"]),
    checkoutId,
    paymentId,
  };
}

/**
 * Moves the demo OTA's booking `bookingId` into the past: its flights keep their times of day and lengths, but its
 * last arrival is `daysAgo` days before now (`bookings.first_departure_at` and `last_arrival_at`, the segments'
 * instants and local times). The API books no flight in the past, so a past trip is made this way; the background sync
 * leaves a finished trip alone (sync-schedule.ts). Throws when the booking is not there.
 */
export async function moveBookingIntoThePast(bookingId: string, daysAgo = 30): Promise<void> {
  await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    const booking = await trx
      .selectFrom("bookings")
      .select("last_arrival_at")
      .where("id", "=", bookingId)
      .executeTakeFirst();
    if (booking === undefined) {
      throw new Error(`the demo OTA has no booking ${bookingId}`);
    }
    const target = Date.now() - daysAgo * 86_400_000;
    const seconds = Math.ceil((new Date(booking.last_arrival_at).getTime() - target) / 1000);
    const shift = sql<string>`(${seconds}::integer * interval '1 second')`;
    await trx
      .updateTable("bookings")
      .set({
        first_departure_at: sql<Date>`first_departure_at - ${shift}`,
        last_arrival_at: sql<Date>`last_arrival_at - ${shift}`,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", bookingId)
      .execute();
    await trx
      .updateTable("booking_segments")
      .set({
        departure_at: sql<Date>`departure_at - ${shift}`,
        arrival_at: sql<Date>`arrival_at - ${shift}`,
        departure_local: sql<Date>`departure_local - ${shift}`,
        arrival_local: sql<Date>`arrival_local - ${shift}`,
      })
      .where("booking_id", "=", bookingId)
      .execute();
  });
}

/** One part of a JWT (base64url JSON) read as an object; `undefined` when it is not one. */
function jwtPart(part: string | undefined): Record<string, unknown> | undefined {
  if (part === undefined || !/^[A-Za-z0-9_-]+$/.test(part)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `token`, a customer access token of the OTA API, as it would be had it been issued `ageSeconds` before `now`: the
 * same header (`alg` EdDSA, the key's `kid`) and claims, `iat` = `now` − `ageSeconds` and `exp` = `iat` + 15 minutes,
 * signed again with the OTA API's Ed25519 key `privateKeyPem`. With an age over 15 minutes and 30 s the API answers
 * `401 TOKEN_EXPIRED` for it, as it does for the token itself once its clock is that much later (OBE-031). Throws for a
 * token that is not a customer access token, without quoting it.
 */
export function agedAccessToken(token: string, privateKeyPem: string, now: Date, ageSeconds: number): string {
  const [headerPart, payloadPart, signaturePart, ...rest] = token.split(".");
  const header = jwtPart(headerPart);
  const claims = jwtPart(payloadPart);
  if (
    header === undefined ||
    claims === undefined ||
    signaturePart === undefined ||
    rest.length > 0 ||
    header["alg"] !== "EdDSA" ||
    claims["typ"] !== "customer"
  ) {
    throw new Error("agedAccessToken: the value is not a customer access token of the OTA API");
  }
  const iat = Math.floor(now.getTime() / 1000) - ageSeconds;
  const payload = Buffer.from(
    JSON.stringify({ ...claims, iat, exp: iat + ACCESS_TOKEN_TTL_SECONDS }),
    "utf8",
  ).toString("base64url");
  const signingInput = `${headerPart}.${payload}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), createPrivateKey(privateKeyPem));
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * The OTA API's signing key file of the stack: JWT_PRIVATE_KEY_FILE of its `.env.example` (`pnpm dev:keys` makes the
 * development key), resolved against the repository root as @velexis/config resolves it.
 */
export function otaSigningKeyFile(): string {
  const file = serviceEnv("ota-api", stack())["JWT_PRIVATE_KEY_FILE"];
  if (file === undefined || file === "") {
    throw new Error("ota/backend/.env.example names no JWT_PRIVATE_KEY_FILE");
  }
  return resolve(REPO_ROOT, file);
}

/**
 * Makes the customer access token in `context`'s `__Host-vx_at` cookie one that has expired, as the OTA API sees its
 * token once 16 minutes have passed: the same session, re-signed with the stack's development key and issued
 * EXPIRED_TOKEN_AGE_SECONDS ago (`agedAccessToken`), in the same httpOnly cookie, which the browser keeps sending. The
 * OTA backend has neither a test clock nor a configurable token lifetime (OFE-019 step 1), so the token is aged
 * instead of the clock. The token and the key stay in this process; neither is logged.
 */
export async function expireAccessToken(
  context: Pick<BrowserContext, "cookies" | "addCookies">,
): Promise<void> {
  const cookie = (await context.cookies(STOREFRONT_URL)).find(
    (candidate) => candidate.name === ACCESS_COOKIE,
  );
  if (cookie === undefined) {
    throw new Error(`the browser holds no ${ACCESS_COOKIE} cookie: sign in first`);
  }
  const value = agedAccessToken(
    cookie.value,
    readFileSync(otaSigningKeyFile(), "utf8"),
    new Date(),
    EXPIRED_TOKEN_AGE_SECONDS,
  );
  await context.addCookies([{ ...cookie, value }]);
}
