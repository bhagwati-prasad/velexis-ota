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
// The OTA admin's journeys of OAD-016 add (the end of this file):
//
//   const owned = await newOwnerWithActiveOta("Olga Owner", "sso");  // an owner's OTA, set up, with its test office
//   await switchAirlineCardOn(owned.schema);                         // its test storefront takes the airline card
//   const edge = new EdgeApi(owned.storefrontHost, ip);              // the OTA API as that OTA's storefront edge
//   await bookAirlineCardTrip(edge, { …, completionScenario: "ticketing-failed" });  // left in manual review
//   const order = await createStubOrder({ officeId, … });            // an Amadeus order made outside Velexis
//   await openConsoleFromPortal(page, owned.ota.id);                 // portal → "Open console" → /bookings
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
import { expect, type BrowserContext, type Page } from "@playwright/test";
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
import { expectNoSeriousA11yViolations } from "./a11y";
import { createVerifiedAccount, signInWithApi, type SessionTokens } from "./fixtures";
import { buildAccount, stack, withDatabase } from "./seed";
import {
  AMADEUS_STUB_URL,
  DEMO_TENANT_KEY,
  OTA_ADMIN_URL,
  OTA_API_URL,
  PORTAL_URL,
  REPO_ROOT,
  serviceEnv,
  stackDatabaseUrl,
  STOREFRONT_BASE_DOMAIN,
  STOREFRONT_URL,
  SUSPENDED_TENANT_KEY,
} from "./stack";
import { CSRF_COOKIE } from "./storefront-guards";
import { createOtaWithApi, uniqueOtaKey, waitForOtaStatus, type Ota, type SignedInOwner } from "./tenants";

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
 * Sets `storefront_settings.airline_card_enabled_test` of the OTA of `schema`, the switch of the OTA admin, when it is
 * off (a new OTA has it off). Callers drop or wait out the storefront.get entries that may hold the old value.
 */
export async function switchAirlineCardOn(schema: string): Promise<void> {
  await withTenantTx(schema, async (trx) => {
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
}

/**
 * Turns the airline card on for the demo OTA's test storefront (`storefront_settings.airline_card_enabled_test`, the
 * switch of the OTA admin; AIRLINE_CARD_ENABLED is true in ota/backend/.env.example, which the stack's OTA processes
 * get) and waits until storefront.get offers it: each poll drops the cached entries first, so an entry that a request
 * of another journey filled from the old row meanwhile goes too. It stays on: no journey needs it off.
 */
export async function enableAirlineCard(): Promise<void> {
  await switchAirlineCardOn(DEMO_TENANT_SCHEMA);
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
   * `expected` throws a StorefrontApiError that names `operation`, the status and the error code only. `extra` adds
   * headers of the call's own (the stub's `X-Stub-Scenario`); the client's own headers win over them.
   */
  async call(
    operation: string,
    method: ApiMethod,
    path: string,
    body?: unknown,
    expected = 200,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      ...extra,
      accept: "application/json",
      "x-forwarded-for": this.endUserIp,
    };
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
  /**
   * The Amadeus stub's scenario for the completion alone (`X-Stub-Scenario`, which the OTA API forwards outside
   * production): `ticketing-failed` makes Flight Create Orders store the order without its tickets, so the airline-card
   * booking waits in `manual_review` for the staff (OAD-016). Default: none, the airline issues the tickets.
   */
  readonly completionScenario?: "ticketing-failed";
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
 * Books a one-way trip from Madrid to Paris through the OTA API, as the storefront's pages would (on the demo OTA with
 * `StorefrontApi`, on a journey's own OTA with `EdgeApi`), paid with the airline card so that no Stripe is needed
 * (ota/docs/flows/checkout-airline-card.md): flights.search, the first offer priced, checkout.create (for the customer
 * of the context's session, or a guest), the traveller and the contact, checkout.createPayment `airline_card` with the
 * terms accepted, checkout.updatePayment with the card's brand and BIN (the airline's card fee),
 * checkout.completeWithAirlineCard for the quoted total. The OTA issues the tickets at completion
 * (`issue_after_payment`, the demo OTA's and a new OTA's policy). Needs the airline card switched on first
 * (`enableAirlineCard()` for the demo OTA, `switchAirlineCardOn(schema)` for a journey's own).
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
    input.completionScenario === undefined ? {} : { "x-stub-scenario": input.completionScenario },
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

// ---- The OTA admin's journeys (OAD-016) ------------------------------------------------------------------------------

/** The schema of the OTA `key` (ADR-0004: `tenant_<key>`). */
export function tenantSchemaOf(key: string): string {
  if (!/^[a-z][a-z0-9]{2,29}$/.test(key)) {
    throw new TypeError("not an OTA key");
  }
  return `tenant_${key}`;
}

/** The storefront host of the OTA `key`, which `createTenant` registers: `<key>.<STOREFRONT_BASE_DOMAIN>`. */
export function storefrontHostOf(key: string): string {
  return `${key}.${STOREFRONT_BASE_DOMAIN}`;
}

/** An OTA's Amadeus test connection, as the platform's set-up left it (`platform.supplier_connections`). */
export interface AmadeusTestConnection {
  readonly status: string;
  /** The office of its calls (the default, queuing and owner office of a connection on the Velexis account). */
  readonly officeId: string;
  /** Every office of the connection: the OTA's orders are the orders of these offices (ADR-0012). */
  readonly officeIds: readonly string[];
}

/**
 * The Amadeus test connection of `tenantId` when it is `active` with an office, else `undefined` (none, or one that
 * waits for an office: `pending_verification`, PADR-0012). Read as velexis_ota_app, which reads the platform's tables
 * and never writes them.
 */
export async function activeAmadeusConnectionOf(
  tenantId: string,
): Promise<AmadeusTestConnection | undefined> {
  const row = await withDatabase("ota", async (client) => {
    const { rows } = await client.query<{
      status: string;
      default_office_id: string | null;
      office_ids: string[];
    }>(
      `SELECT status, default_office_id, office_ids
         FROM platform.supplier_connections
        WHERE tenant_id = $1 AND provider = 'amadeus' AND environment = 'test'`,
      [tenantId],
    );
    return rows[0];
  });
  return row?.status === "active" && row.default_office_id !== null
    ? { status: row.status, officeId: row.default_office_id, officeIds: row.office_ids }
    : undefined;
}

/** How long `waitForUnheldTestOffice` waits: the bound of a hold (support/tenants.ts `withAvailableOfficesHeld`). */
const POOL_HOLD_WAIT_MS = 45_000;

/**
 * Waits until the Velexis test pool has an available office that no transaction holds: one that the set-up step of a
 * new OTA (`FOR UPDATE SKIP LOCKED`) would take now. Checked in a transaction of the platform API's own role that
 * locks it with `SKIP LOCKED` and rolls back, so nothing is written or kept held.
 */
async function waitForUnheldTestOffice(): Promise<void> {
  await expect
    .poll(
      async () =>
        await withDatabase("platform", async (client) => {
          await client.query("BEGIN");
          try {
            const { rowCount } = await client.query(
              `SELECT o.id
                 FROM platform.amadeus_offices o
                 JOIN platform.amadeus_accounts a ON a.id = o.amadeus_account_id
                WHERE a.environment = 'test' AND o.status = 'available'
                LIMIT 1
                  FOR UPDATE OF o SKIP LOCKED`,
            );
            return (rowCount ?? 0) > 0;
          } finally {
            await client.query("ROLLBACK");
          }
        }),
      {
        timeout: POOL_HOLD_WAIT_MS,
        message: "the Velexis test pool has an available office that no other journey holds",
      },
    )
    .toBe(true);
}

/** An OTA of an OTA admin journey: a new owner's, set up by the OTA worker, with its Amadeus test office. */
export interface OwnedOta {
  readonly owner: SignedInOwner;
  /** The owner's portal session, for the browser context's cookies (`addSessionCookies(context, "portal", …)`). */
  readonly session: SessionTokens;
  readonly ota: Ota;
  /** `tenant_<key>`. */
  readonly schema: string;
  /** `<key>.ota.example.com`, the host its storefront edge calls name (`EdgeApi`). */
  readonly storefrontHost: string;
  readonly connection: AmadeusTestConnection;
}

/** How many OTAs `newOwnerWithActiveOta` sets up at most to get one with an office (see there). */
const OFFICE_SETUP_ATTEMPTS = 3;

/**
 * A new portal account (`fullName`), verified and signed in, that creates an OTA through `createTenant` (a key of
 * `keyPrefix` and 10 random hex digits) and waits for the OTA worker to set it up (`active`, about 2 s locally) with
 * its Amadeus test connection on an office of the Velexis test pool (ten from the platform's dev:seed).
 *
 * The set-up passes over offices that another transaction holds, and admin-amadeus-pool.e2e.ts holds every available
 * one while its own OTA is set up (`withAvailableOfficesHeld`): an OTA set up in those seconds gets a connection that
 * waits for an office (`pending_verification`), which only an admin's assignment would end. So when that happens, the
 * owner waits until an available office is free of holds again and sets up another OTA (at most
 * OFFICE_SETUP_ATTEMPTS OTAs); the one without an office is left as it is. A pool without an available office fails
 * at once with that reason.
 */
export async function newOwnerWithActiveOta(fullName: string, keyPrefix: string): Promise<OwnedOta> {
  const account = await createVerifiedAccount(buildAccount({ fullName }));
  const session = await signInWithApi(account);
  const owner: SignedInOwner = { account, accessToken: session.accessToken };
  for (let attempt = 1; ; attempt += 1) {
    const created = await createOtaWithApi(owner, { key: uniqueOtaKey(keyPrefix) });
    const ota = await waitForOtaStatus(owner, created.id, "active");
    // The connection is written by the set-up's `assign_amadeus_office` step, before the one that activates the OTA.
    const connection = await activeAmadeusConnectionOf(ota.id);
    if (connection !== undefined) {
      return {
        owner,
        session,
        ota,
        schema: tenantSchemaOf(ota.key),
        storefrontHost: storefrontHostOf(ota.key),
        connection,
      };
    }
    if (attempt === OFFICE_SETUP_ATTEMPTS) {
      throw new Error(
        `${OFFICE_SETUP_ATTEMPTS} OTAs were set up without an Amadeus test office: the Velexis test pool had none ` +
          "available (tools/e2e/README.md, Troubleshooting)",
      );
    }
    await waitForUnheldTestOffice();
  }
}

/** The `fetch` the API clients of this section use (the global one; a fake in the unit tests). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** What `EdgeApi` needs besides the host and the end-user IP; the defaults are the stack's. */
export interface EdgeApiOptions {
  /** The OTA API (default OTA_API_URL). */
  readonly baseUrl?: string;
  /** VELEXIS_EDGE_SECRET (default: the development value of ota/backend/.env.example that the stack's API gets). */
  readonly edgeSecret?: string;
  readonly fetch?: FetchLike;
}

/** The development edge secret of the stack's OTA API (never logged). */
function stackEdgeSecret(): string {
  const secret = serviceEnv("ota-api", stack())["VELEXIS_EDGE_SECRET"];
  if (secret === undefined || secret === "") {
    throw new Error("ota/backend/.env.example names no VELEXIS_EDGE_SECRET");
  }
  return secret;
}

/** The value of the cookie `name` among `Set-Cookie` header values, if one sets it. */
export function setCookieValue(setCookies: readonly string[], name: string): string | undefined {
  for (const header of setCookies) {
    const [pair = ""] = header.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/**
 * The OTA API as the hosted storefront of any OTA's host calls it through Caddy (OADR-0009 rule 1.1), from the test
 * process: `X-Velexis-Edge` with the stack's development secret, `X-Velexis-Host` and `Origin: https://<host>` as Caddy
 * and the storefront previews send them, the journey's end-user IP as `X-Forwarded-For` (the client address the API
 * takes behind a loopback proxy, so per-IP limits count this journey alone), and on every write the CSRF double submit
 * of OADR-0006 point 3: the `__Host-vx_csrf` value that storefront.get issued, as the cookie and as `X-CSRF-Token`, and
 * a new `Idempotency-Key` on every POST. For an OTA whose storefront no preview serves (a journey's own OTA), so its
 * bookings are made as a traveller's browser would make them (PADR-0017 item 5), with the airline card and no Stripe.
 * The secret, the CSRF value and the answers stay in this process; a refusal names the operation, status and code only.
 */
export class EdgeApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly edgeSecret: string | undefined;
  private csrf: string | undefined;

  constructor(
    readonly host: string,
    private readonly endUserIp: string,
    options: EdgeApiOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? OTA_API_URL;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.edgeSecret = options.edgeSecret;
  }

  /** The edge headers of every call: what Caddy adds in front of the storefront. */
  private edgeHeaders(): Record<string, string> {
    return {
      accept: "application/json",
      "x-velexis-edge": this.edgeSecret ?? stackEdgeSecret(),
      "x-velexis-host": this.host,
      origin: `https://${this.host}`,
      "x-forwarded-for": this.endUserIp,
    };
  }

  /** The CSRF value storefront.get issued to this client (asked for once, before the first write). */
  private async csrfToken(): Promise<string> {
    if (this.csrf === undefined) {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/storefront`, {
        method: "GET",
        headers: this.edgeHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel();
      if (response.status !== 200) {
        throw new StorefrontApiError("storefront.get", response.status, undefined);
      }
      this.csrf = setCookieValue(response.headers.getSetCookie(), CSRF_COOKIE);
      if (this.csrf === undefined) {
        throw new Error(`storefront.get set no ${CSRF_COOKIE} cookie`);
      }
    }
    return this.csrf;
  }

  /**
   * Calls `method path` of the OTA API (`/v1/…`) with `body` as the storefront edge of `host`, and returns the JSON
   * answer; a status other than `expected` throws a StorefrontApiError (operation, status and error code only).
   * `extra` adds headers of the call's own (the stub's `X-Stub-Scenario`); the edge's own headers win over them.
   */
  async call(
    operation: string,
    method: ApiMethod,
    path: string,
    body?: unknown,
    expected = 200,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { ...extra, ...this.edgeHeaders() };
    if (method !== "GET") {
      const csrf = await this.csrfToken();
      headers["content-type"] = "application/json";
      headers["cookie"] = `${CSRF_COOKIE}=${csrf}`;
      headers["x-csrf-token"] = csrf;
    }
    if (method === "POST") {
      headers["idempotency-key"] = randomUUID();
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // The airline-card completion waits for Flight Create Orders: the SDK's 60 s of a long operation.
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let answer: unknown;
    try {
      answer = text === "" ? undefined : JSON.parse(text);
    } catch {
      answer = undefined;
    }
    if (response.status !== expected) {
      throw new StorefrontApiError(operation, response.status, errorCodeOf(answer));
    }
    return answer;
  }
}

/** An Amadeus order made in the stub outside Velexis, as an agent books one in a GDS terminal. */
export interface StubOrderInput {
  /** The office that holds it: its queuing and owner office. */
  readonly officeId: string;
  readonly traveller: SeedTraveller;
  /** The traveller's contact e-mail address: one of the journey's own, since an import may e-mail it. */
  readonly email: string;
  /** Its flight's departure, days from today (the times of day of the stub's offer are kept). */
  readonly daysAhead: number;
}

/** An order of the stub: its Amadeus id and its record locator. */
export interface StubOrder {
  readonly id: string;
  readonly recordLocator: string;
}

/** What `createStubOrder` needs besides the order; the defaults are the stack's stub and the global `fetch`. */
export interface StubOrderOptions {
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
}

/** The test client of the stub's token endpoint: any non-empty pair gets a token from the stub CLI. */
const STUB_TERMINAL_CLIENT = { id: "e2e-gds-terminal", secret: "e2e-gds-terminal-dummy" } as const;

const DAY_MS = 86_400_000;

/** A local Amadeus time (`YYYY-MM-DDTHH:MM:SS`) or date moved `days` days, its time of day kept. */
export function shiftLocal(value: string, days: number): string {
  const time = Date.parse(`${value.length === 10 ? `${value}T00:00:00` : value}Z`);
  if (!Number.isFinite(time)) {
    throw new TypeError("not a local Amadeus time");
  }
  const shifted = new Date(time + days * DAY_MS).toISOString();
  return value.length === 10 ? shifted.slice(0, 10) : shifted.slice(0, 19);
}

/**
 * The first offer of a stub search with its flights moved to depart `daysAhead` days from today (`now`): every
 * segment's local times and the last ticketing date by the same whole days, never a fixed calendar date.
 */
export function offerDepartingIn(
  offer: Record<string, unknown>,
  daysAhead: number,
  now = new Date(),
): unknown {
  const itineraries = Array.isArray(offer["itineraries"]) ? (offer["itineraries"] as unknown[]) : [];
  const segments = itineraries.flatMap((itinerary) => {
    const list = objectOf(itinerary)["segments"];
    return Array.isArray(list) ? (list as unknown[]).map(objectOf) : [];
  });
  const first = objectOf(segments[0]?.["departure"])["at"];
  if (typeof first !== "string") {
    throw new Error("the stub's offer has no departure");
  }
  const target = Date.parse(`${departureDate(daysAhead, now)}T00:00:00Z`);
  const days = Math.round((target - Date.parse(`${first.slice(0, 10)}T00:00:00Z`)) / DAY_MS);
  const moved = structuredClone(offer);
  for (const itinerary of (moved["itineraries"] as unknown[] | undefined) ?? []) {
    for (const segment of (objectOf(itinerary)["segments"] as unknown[] | undefined) ?? []) {
      for (const end of ["departure", "arrival"] as const) {
        const point = objectOf(objectOf(segment)[end]);
        if (typeof point["at"] === "string") {
          point["at"] = shiftLocal(point["at"], days);
        }
      }
    }
  }
  if (typeof moved["lastTicketingDate"] === "string") {
    moved["lastTicketingDate"] = shiftLocal(moved["lastTicketingDate"], days);
  }
  return moved;
}

/**
 * Creates an Amadeus order in the stack's stub directly, as a GDS terminal or another Amadeus client would, so Velexis
 * knows nothing of it (ota/docs/flows/console-operations.md §2 "PNR lookup and import"): a token, a search (the stub
 * answers its fixture's flights from Madrid to Paris), and Flight Create Orders of its first offer for one adult,
 * queued and owned by `officeId`, without issuing it. The stub keeps the order in memory and answers it to every
 * by-reference read; which OTA may see it is the OTA API's office isolation (ADR-0012).
 */
export async function createStubOrder(
  input: StubOrderInput,
  options: StubOrderOptions = {},
): Promise<StubOrder> {
  const baseUrl = options.baseUrl ?? AMADEUS_STUB_URL;
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const json = async (operation: string, response: Response, expected: number): Promise<unknown> => {
    const text = await response.text();
    if (response.status !== expected) {
      throw new Error(`the stub's ${operation} answered ${response.status}`);
    }
    return JSON.parse(text) as unknown;
  };
  const token = field(
    await json(
      "token",
      await send(`${baseUrl}/v1/security/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: STUB_TERMINAL_CLIENT.id,
          client_secret: STUB_TERMINAL_CLIENT.secret,
        }).toString(),
      }),
      200,
    ),
    "the stub's token",
    (value) => value["access_token"],
  );
  const authorization = { authorization: `Bearer ${token}` };
  const query = new URLSearchParams({
    originLocationCode: "MAD",
    destinationLocationCode: "PAR",
    departureDate: departureDate(input.daysAhead),
    adults: "1",
    max: "1",
  });
  const search = objectOf(
    await json(
      "getFlightOffers",
      await send(`${baseUrl}/v2/shopping/flight-offers?${query.toString()}`, {
        method: "GET",
        headers: authorization,
      }),
      200,
    ),
  );
  const offers = Array.isArray(search["data"]) ? (search["data"] as unknown[]) : [];
  const offer = offerDepartingIn(objectOf(offers[0]), input.daysAhead);
  const { traveller } = input;
  const order = objectOf(
    objectOf(
      await json(
        "createFlightOrders",
        await send(`${baseUrl}/v1/booking/flight-orders`, {
          method: "POST",
          headers: { ...authorization, "content-type": "application/vnd.amadeus+json" },
          body: JSON.stringify({
            data: {
              type: "flight-order",
              queuingOfficeId: input.officeId,
              ownerOfficeId: input.officeId,
              flightOffers: [offer],
              travelers: [
                {
                  id: "1",
                  dateOfBirth: traveller.dateOfBirth,
                  gender: traveller.gender,
                  name: {
                    firstName: traveller.firstName.toUpperCase(),
                    lastName: traveller.lastName.toUpperCase(),
                  },
                  contact: {
                    emailAddress: input.email,
                    phones: [{ deviceType: "MOBILE", countryCallingCode: "34", number: "600000000" }],
                  },
                },
              ],
              ticketingAgreement: { option: "CONFIRM" },
            },
          }),
        }),
        201,
      ),
    )["data"],
  );
  const records = Array.isArray(order["associatedRecords"]) ? (order["associatedRecords"] as unknown[]) : [];
  return {
    id: field(order, "the stub's createFlightOrders", (value) => value["id"]),
    recordLocator: field(records[0], "the stub's createFlightOrders", (value) => value["reference"]),
  };
}

/** The cookies of a staff session that the OTA admin sets at its single sign-on (ota/admin/README.md §4). */
export const STAFF_COOKIES = Object.freeze([
  "__Host-vx_staff_at",
  "__Host-vx_staff_rt",
  "__Host-vx_env",
  "__Host-vx_tenant",
] as const);

/** What `scriptReadableCookieNames` needs of a page: running a function in its document (a Playwright `Page`). */
export interface DocumentEvaluator {
  evaluate<R>(pageFunction: () => R): Promise<R>;
}

/** The names of the cookies JavaScript of `page`'s document can read (`document.cookie`); values never leave it. */
export async function scriptReadableCookieNames(page: DocumentEvaluator): Promise<string[]> {
  return await page.evaluate(() =>
    document.cookie
      .split(";")
      .map((pair) => pair.split("=")[0]?.trim() ?? "")
      .filter((name) => name !== ""),
  );
}

/** The portal's page of an OTA, where its owner finds "Open console" (platform/frontend/README.md §2). */
export function portalOtaPath(tenantId: string): string {
  return `${PORTAL_URL}/otas/${encodeURIComponent(tenantId)}`;
}

/**
 * The single sign-on from the portal into the OTA admin (ota/admin/README.md §3, PADR-0007 §4), in `page` of a context
 * with the portal session's cookies: the portal's page of the OTA (axe once its title is in place), "Open console", whose
 * form posts to the launch route, whose hand-off page submits the one-time `portalToken` to the OTA admin's `/sso`,
 * which sets the staff session's cookies and answers `303` to `/bookings`. Resolves on `/bookings` of the OTA admin.
 */
export async function openConsoleFromPortal(page: Page, tenantId: string): Promise<void> {
  await page.goto(portalOtaPath(tenantId));
  await expect(page).toHaveTitle("Overview · Velexis");
  await expectNoSeriousA11yViolations(page);
  await page
    .getByRole("main")
    .getByRole("button", { name: /^Open console/ })
    .click();
  await page.waitForURL(`${OTA_ADMIN_URL}/bookings`);
}
