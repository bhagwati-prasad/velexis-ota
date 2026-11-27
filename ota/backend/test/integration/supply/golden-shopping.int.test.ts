// The golden baseline of today's Amadeus search, pricing and upsell (OBE-109; multi-supplier plan §4.2 "Proof", plan
// key E2-01; ADR-0030 items 1 and 13, OADR-0019 items 1 and 3). Before the supplier interface and the ingestion engine
// change the shopping code, this file records what flights.search, flights.price and flights.upsell do today against
// the Amadeus stub, and fails on any difference afterwards.
//
// The scenarios are those of the three shopping files (test/integration/shopping/search.int.test.ts,
// pricing.int.test.ts and offer-upsell.int.test.ts), with their set-up: the template clone (tenant_alpha and
// tenant_beta), the two tenants on the Velexis test Amadeus account, their keys, provisioning's settings and default
// markup rule, alpha's 10 % markup rule, and for pricing alpha's 10.00 EUR booking service fee and 1 % ticketing fee.
// Each scenario is one request to the API in-process (Supertest), after the set-up it needs (a search to price or to
// upsell), and its file under test/supply/golden/ holds:
//   - the request the test sends (its caller, never a key, its method, path, stub scenario and body);
//   - every Amadeus request the API sends during it: method, path, query and body, read by a spy on
//     `globalThis.fetch` that passes every call through (the stub's `requests()` records no body). The token request
//     is left out, since its body holds the client secret; no header is recorded, so no `Authorization` either;
//   - the API answer: status and body;
//   - the rows of both tenants that the request wrote to flight_searches, flight_offers, offer_upsells, priced_offers
//     and supplier_requests, on the columns listed in COLUMNS (the columns of today: a column a later migration adds
//     is not compared).
// `GoldenPlaceholders` replaces what differs from run to run, and only that: generated ids (`off_…`, numbered by first
// appearance, so a reference keeps pointing at the same placeholder), timestamps with a time zone (created, updated
// and expiry times), durations, request ids and the result cursor (which encodes a search id). The office ids and
// the last ticketing date of the offers to price are fixed values here (random or relative to today in the shopping
// files), so they need no placeholder. Dates and local times without a zone (the fixture's departures) stay as they
// are.
//
// An Amadeus body is stored as its parsed value, for a readable diff; the test first checks that the body is exactly
// `JSON.stringify` of that value, so an equal file means a byte-equal body. The files are JSON as Prettier prints it
// (`printGolden`), so `pnpm format:check` accepts them.
//
// Before any comparison, `expectNoSecrets` fails when a golden text would hold the test account's client id or
// secret, an API key of the set-up, the token request or a card number, so a recording cannot write one either.
//
// A difference fails the test, and the test never rewrites a golden file by itself: `toMatchFileSnapshot` compares,
// and a missing file fails too unless the run updates snapshots. A new recording is an explicit run that CI never does:
//   pnpm --filter @velexis/ota-backend test:int golden-shopping -u
// and a golden file changes only in a task whose block names the difference (README §8).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { encryptValue, hashApiKey, type KeyProvider } from "@velexis/crypto";
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
import { holdsCardNumber } from "@velexis/logger";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import {
  OAUTH_TOKEN_PATH,
  startAmadeusStub,
  stubScenario,
  type AmadeusStub,
  type StubScenario,
} from "@velexis/testing/amadeus";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeWriteHeaders, newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/** The golden files, one per scenario: `<operation>/<scenario>.json`. */
const GOLDEN_DIR = resolve(__dirname, "..", "..", "supply", "golden");

const ALPHA_HOST = "alpha.ota.example.com";
/** Fixed office ids of the two connections (the shopping files draw them at random). */
const OFFICES = Object.freeze({ alpha: "NCE1A0001", beta: "NCE1A0002" });
/**
 * The last ticketing day given to the offers that the price scenarios price. The stub echoes the posted offers, and
 * a priced offer expires at the end of that day at the latest (OADR-0002 point 3): a fixed day far ahead keeps the
 * priced offers' expiry at the 30-minute TTL whatever day the test runs (pricing.int.test.ts takes today + 60 days).
 */
const LAST_TICKETING_DATE = "2099-12-31";

/** A one-way SIMPLE search Madrid → Paris Orly for one adult. */
const SIMPLE = Object.freeze({
  mode: "simple",
  originLocationCode: "MAD",
  destinationLocationCode: "ORY",
  departureDate: "2027-01-15",
  adults: 1,
});

/** An ADVANCED search Madrid → Paris for one adult, as search.int.test.ts sends it. */
const advanced = (searchCriteria?: Readonly<Record<string, unknown>>, limit = 2) => ({
  mode: "advanced",
  query: {
    originDestinations: [
      {
        id: "1",
        originLocationCode: "MAD",
        destinationLocationCode: "PAR",
        departureDateTimeRange: { date: "2027-01-15" },
      },
    ],
    travelers: [{ id: "1", travelerType: "ADULT" }],
    sources: ["GDS"],
    ...(searchCriteria === undefined ? {} : { searchCriteria }),
  },
  resultOptions: { limit },
});

/** The synthetic traveller of pricing.int.test.ts (no real person). */
const TRAVELER = Object.freeze({
  id: "1",
  dateOfBirth: "1990-02-15",
  gender: "FEMALE",
  name: { firstName: "TESTA", lastName: "SAMPLE" },
  documents: [
    {
      documentType: "PASSPORT",
      number: "X98765432",
      expiryDate: "2031-05-01",
      issuanceCountry: "ES",
      nationality: "ES",
      holder: true,
    },
  ],
});

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let accountId: string;
/** The Velexis test account's client id and secret, random per run (the only pair the stub accepts). */
let clientId: string;
let clientSecret: string;
let alphaSk: string;
let alphaConsole: string;
let betaSk: string;

// --- Set-up, as the shopping files do it ---------------------------------------------------------------------------

/** Inserts the Velexis test Amadeus account with `secret` encrypted as the platform encrypts it. */
async function insertAccount(clientId: string, secret: string): Promise<string> {
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

/** Inserts a tenant of a provisioned test schema and its connection, with its fixed office, on the shared account. */
async function insertTenant(key: "alpha" | "beta"): Promise<string> {
  const id = newId("ten");
  const office = OFFICES[key];
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: id,
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
  return id;
}

/** Issues a secret test key of a tenant as the platform does. */
async function issueKey(tenantId: string, scopes: readonly string[] = []): Promise<string> {
  const key = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      ...(scopes.length === 0 ? {} : { scopes: [...scopes] }),
    })
    .execute();
  return key;
}

/** Settings and the default markup rule as provisioning seeds them. */
async function seedTenant(schema: Schema, name: string): Promise<void> {
  await tenantTx(tenantDb, schema, async (trx) => {
    await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
  });
}

/** Alpha's 10 % markup rule, as all three shopping files give it. */
async function seedAlphaMarkup(): Promise<void> {
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx
      .insertInto("markup_rules")
      .values({
        id: newId("mkr"),
        name: "Ten percent",
        scope: JSON.stringify({}),
        calculation: "percentage",
        percentage: "10",
        priority: 10,
        stackable: false,
        is_default: false,
        is_active: true,
      })
      .execute(),
  );
}

/** Alpha's 10.00 EUR booking service fee and 1 % ticketing fee, as pricing.int.test.ts gives them. */
async function seedAlphaFees(): Promise<void> {
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx
      .insertInto("fee_rules")
      .values([
        {
          id: newId("fee"),
          name: "Booking fee",
          label: "Booking service fee",
          fee_type: "booking_service",
          scope: JSON.stringify({}),
          calculation: "fixed",
          fixed_amount: "10.00",
          currency: "EUR",
          applies_per: "booking",
        },
        {
          id: newId("fee"),
          name: "Ticketing",
          label: "Ticketing fee",
          fee_type: "ticketing",
          scope: JSON.stringify({}),
          calculation: "percentage",
          percentage: "1",
          applies_per: "booking",
        },
      ])
      .execute(),
  );
}

// --- Callers and requests -------------------------------------------------------------------------------------------

/** Who sends a scenario's request: a name for the golden file and the headers, which hold the key. */
interface Caller {
  readonly name: string;
  readonly headers: () => Readonly<Record<string, string>>;
}

const ALPHA: Caller = { name: "alpha, secret key", headers: () => ({ "X-Api-Key": alphaSk }) };
const ALPHA_CONSOLE: Caller = {
  name: "alpha, console:automation key, console scope",
  headers: () => ({ "X-Api-Key": alphaConsole, "X-Velexis-Scope": "console" }),
};
const BETA: Caller = { name: "beta, secret key", headers: () => ({ "X-Api-Key": betaSk }) };
const ALPHA_STOREFRONT: Caller = {
  name: `alpha's hosted storefront (${ALPHA_HOST}), with the CSRF header`,
  headers: () => edgeWriteHeaders(ALPHA_HOST),
};

/** One request of a scenario. `body` undefined sends none. */
interface ApiCall {
  readonly caller: Caller;
  readonly path: string;
  readonly body?: unknown;
  readonly scenario?: StubScenario;
}

/** Sends a POST of the API in-process, with a new Idempotency-Key. */
async function post(call: ApiCall): Promise<request.Response> {
  const req = request(api.server)
    .post(call.path)
    .set({
      ...call.caller.headers(),
      "Idempotency-Key": randomBytes(16).toString("hex"),
      ...(call.scenario === undefined ? {} : stubScenario(call.scenario)),
    });
  return call.body === undefined ? await req : await req.send(call.body as object);
}

/** A completed search of `caller` (set-up of a scenario): its id and its offers' ids by Amadeus offer id. */
async function searchFor(
  body: unknown,
  caller: Caller = ALPHA,
  schema: Schema = "tenant_alpha",
): Promise<{ searchId: string; offers: Map<string, string> }> {
  const res = await post({ caller, path: "/v1/flight-searches", body });
  expect(res.status).toBe(201);
  const searchId = (res.body as { id: string }).id;
  const rows = await tenantTx(tenantDb, schema, (trx) =>
    trx
      .selectFrom("flight_offers")
      .select(["id", "amadeus_offer_id"])
      .where("search_id", "=", searchId)
      .execute(),
  );
  return { searchId, offers: new Map(rows.map((row) => [row.amadeus_offer_id, row.id])) };
}

/** Alpha's offer `amadeusId` of a search; fails when the search has none. */
function offerOf(offers: ReadonlyMap<string, string>, amadeusId: string): string {
  const id = offers.get(amadeusId);
  expect(id).toMatch(/^off_/);
  return id ?? "";
}

/**
 * The offers of a new search of alpha on `date` with LAST_TICKETING_DATE as their last ticketing day (in the payload
 * the stub echoes and in the column), as pricing.int.test.ts prepares the offers it prices.
 */
async function offersToPrice(date: string): Promise<Map<string, string>> {
  const { searchId, offers } = await searchFor({ ...SIMPLE, departureDate: date });
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx
      .updateTable("flight_offers")
      .set({
        payload: sql`jsonb_set(payload, '{lastTicketingDate}', to_jsonb(${LAST_TICKETING_DATE}::text))`,
        last_ticketing_date: LAST_TICKETING_DATE,
      })
      .where("search_id", "=", searchId)
      .execute(),
  );
  return offers;
}

/** Expires an offer of alpha (set-up of the OFFER_EXPIRED scenarios). */
async function expireOffer(offerId: string): Promise<void> {
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx
      .updateTable("flight_offers")
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where("id", "=", offerId)
      .execute(),
  );
}

// --- What a scenario records ----------------------------------------------------------------------------------------

type Schema = "tenant_alpha" | "tenant_beta";
const SCHEMAS: readonly Schema[] = ["tenant_alpha", "tenant_beta"];

/** The tables a scenario's rows are read from. */
type Table = "flight_searches" | "flight_offers" | "offer_upsells" | "priced_offers" | "supplier_requests";

/** The names of a whitespace-separated list. */
const names = (list: string): readonly string[] => list.trim().split(/\s+/);

/**
 * The columns a row is compared on: every column of today, in the order of the tenant baseline (0001). A column that
 * a later migration adds is not compared.
 */
const COLUMNS: Readonly<Record<Table, readonly string[]>> = {
  flight_searches: names(`
    id environment kind mode channel customer_id staff_id criteria amadeus_request origin_iata destination_iata
    departure_date return_date adults children infants cabin currency status result_count dictionaries warnings facets
    highlights one_way_combinations availability_data error_code duration_ms expires_at created_at updated_at`),
  flight_offers: names(`
    id environment origin search_id upsell_id amadeus_offer_id source position payload currency net_total
    markup_amount selling_total markup_rule_id validating_carrier marketing_carriers origin_iata destination_iata
    first_departure_local last_arrival_local itinerary_departure_minutes itinerary_arrival_minutes
    itinerary_duration_minutes max_stops total_duration_minutes main_cabin min_checked_bags refundable changeable
    branded_fares best_score bookable_seats last_ticketing_date instant_ticketing_required expires_at created_at
    updated_at`),
  offer_upsells: names(`
    id base_offer_id amadeus_request warnings dictionaries status result_count expires_at created_at updated_at`),
  priced_offers: names(`
    id environment offer_id parent_priced_offer_id offer_ids include_credit_card_fees include_bags
    include_other_services include_detailed_fare_rules force_class amadeus_request response booking_requirements
    price_changed currency net_total taxes_total markup_amount fee_amount selling_total markup_rule_id
    last_ticketing_date expires_at created_at updated_at`),
  supplier_requests: names(`
    id environment provider operation amadeus_api amadeus_operation_id http_method path office_id http_status outcome
    error_codes duration_ms correlation_id request_id redacted request_body response_body truncated booking_id
    search_id staff_id created_at updated_at`),
};

const TABLES = Object.keys(COLUMNS) as Table[];

/** The order of a scenario's rows: by creation, then by what tells rows of one insert apart. */
const ORDER: Readonly<Record<Table, string>> = {
  flight_searches: "created_at",
  flight_offers: "created_at, search_id, upsell_id, amadeus_offer_id",
  offer_upsells: "created_at",
  priced_offers: "created_at",
  supplier_requests: "created_at",
};

type RowIds = Readonly<Record<Schema, Readonly<Record<Table, readonly string[]>>>>;

/** The ids of every row of the recorded tables of both tenants, before a scenario's request. */
async function rowIds(): Promise<RowIds> {
  const result: Partial<Record<Schema, Record<Table, string[]>>> = {};
  for (const schema of SCHEMAS) {
    result[schema] = await tenantTx(tenantDb, schema, async (trx) => {
      const ids: Partial<Record<Table, string[]>> = {};
      for (const table of TABLES) {
        const { rows } = await sql<{ id: string }>`SELECT id FROM ${sql.table(table)}`.execute(trx);
        ids[table] = rows.map((row) => row.id);
      }
      return ids as Record<Table, string[]>;
    });
  }
  return result as RowIds;
}

/** The rows of both tenants that are not in `before`, on the columns of COLUMNS. */
async function newRows(before: RowIds): Promise<Record<Schema, Record<Table, unknown[]>>> {
  const result: Partial<Record<Schema, Record<Table, unknown[]>>> = {};
  for (const schema of SCHEMAS) {
    result[schema] = await tenantTx(tenantDb, schema, async (trx) => {
      const rows: Partial<Record<Table, unknown[]>> = {};
      for (const table of TABLES) {
        const columns = sql.join(COLUMNS[table].map((column) => sql.ref(column)));
        const query = sql<Record<string, unknown>>`
          SELECT ${columns} FROM ${sql.table(table)}
          WHERE id <> ALL(${[...before[schema][table]]}::text[])
          ORDER BY ${sql.raw(ORDER[table])}`;
        rows[table] = (await query.execute(trx)).rows;
      }
      return rows as Record<Table, unknown[]>;
    });
  }
  return result as Record<Schema, Record<Table, unknown[]>>;
}

/** One Amadeus request as the spy saw it; `body` is the text sent, `null` for none. */
interface AmadeusCall {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: string | null;
}

/**
 * Records the Amadeus requests from now on: a spy on `globalThis.fetch` (the module's AMADEUS_FETCH calls it at each
 * request) that passes every call through. Only requests to the stub count, and never the token request.
 */
function recordAmadeusCalls(): { readonly calls: AmadeusCall[]; restore(): void } {
  const realFetch = globalThis.fetch;
  const calls: AmadeusCall[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === new URL(stub.url).origin && url.pathname !== OAUTH_TOKEN_PATH) {
      const body = init?.body;
      if (body !== undefined && body !== null && typeof body !== "string") {
        throw new TypeError(`An Amadeus request to ${url.pathname} has a body that is not text`);
      }
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
        body: body ?? null,
      });
    }
    return realFetch(input, init);
  });
  return { calls, restore: () => spy.mockRestore() };
}

/**
 * An Amadeus request as its golden file holds it: the body parsed. The body must be exactly `JSON.stringify` of its
 * value, so that the parsed value in the file stands for every byte of it. A body that is no JSON (a token request's
 * form, which holds the client secret) fails without quoting it, as the parser's message would.
 */
function amadeusCallRecord(call: AmadeusCall): Record<string, unknown> {
  let body: unknown = null;
  if (call.body !== null) {
    try {
      body = JSON.parse(call.body) as unknown;
    } catch {
      throw new Error(`The body sent to ${call.path} is not JSON`);
    }
    if (JSON.stringify(body) !== call.body) {
      throw new Error(`The body sent to ${call.path} is not JSON.stringify's text of its value`);
    }
  }
  return { method: call.method, path: call.path, query: call.query, body };
}

// --- Placeholders ---------------------------------------------------------------------------------------------------

/** A generated id: `<prefix>_<ULID>` (src/common/ids.ts). */
const GENERATED_ID = /\b([a-z]{2,4})_[0-9A-HJKMNP-TV-Z]{26}\b/g;
/** An ISO 8601 date-time with a time zone: created, updated and expiry times, never a fixture's local times. */
const ZONED_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})/g;
/** Keys whose value is a request id (a UUID per API request). */
const REQUEST_ID_KEYS: ReadonlySet<string> = new Set(["requestId", "request_id"]);
/** Keys whose value is a duration in milliseconds. */
const DURATION_KEYS: ReadonlySet<string> = new Set(["durationMs", "duration_ms"]);
/** The `timestamptz` columns of the recorded tables: times of the run. */
const RUN_TIME_COLUMNS: ReadonlySet<string> = new Set(["created_at", "updated_at", "expires_at"]);
/** The `date` columns of the recorded tables. */
const DATE_COLUMNS: ReadonlySet<string> = new Set(["departure_date", "return_date", "last_ticketing_date"]);

const pad = (value: number, size = 2): string => String(value).padStart(size, "0");

/**
 * Replaces what differs from run to run by fixed placeholders, and nothing else. One instance per golden file: the
 * same id or request id gets the same placeholder everywhere in it.
 */
class GoldenPlaceholders {
  private readonly seen = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  /** `<kind-n>`: the n-th distinct value of that kind in the file. */
  private numbered(value: string, kind: string): string {
    let placeholder = this.seen.get(value);
    if (placeholder === undefined) {
      const count = (this.counts.get(kind) ?? 0) + 1;
      this.counts.set(kind, count);
      placeholder = `<${kind}-${count}>`;
      this.seen.set(value, placeholder);
    }
    return placeholder;
  }

  private text(value: string, key: string | undefined): string {
    if (key !== undefined && REQUEST_ID_KEYS.has(key)) {
      return this.numbered(value, "request");
    }
    if (key === "nextCursor") {
      return this.cursor(value);
    }
    return value
      .replace(GENERATED_ID, (id, prefix: string) => this.numbered(id, prefix))
      .replace(ZONED_TIME, "<timestamp>");
  }

  /** The result cursor (base64url JSON, facets.ts `encodeCursor`) with its search fingerprint and offer id replaced. */
  private cursor(value: string): string {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 4) {
      throw new Error("The result cursor is not the one facets.ts encodes");
    }
    const [version, , sortKeys, offerId] = decoded as unknown[];
    return `<cursor ${JSON.stringify([version, "<fingerprint>", sortKeys, this.value(offerId, undefined)])}>`;
  }

  /** A `Date` read from a row: a run time is a placeholder; a date or a local time is printed as PostgreSQL holds it. */
  private date(value: Date, key: string | undefined): string {
    if (key !== undefined && RUN_TIME_COLUMNS.has(key)) {
      return "<timestamp>";
    }
    // `date` and `timestamp` columns are read as local times of this process: their local fields are the stored ones.
    const day = `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    if (key !== undefined && DATE_COLUMNS.has(key)) {
      return day;
    }
    const millis = value.getMilliseconds() === 0 ? "" : `.${pad(value.getMilliseconds(), 3)}`;
    return `${day}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}${millis}`;
  }

  /** `value` with its placeholders, as plain JSON; `key` is the member name it is the value of. */
  value(value: unknown, key: string | undefined): unknown {
    if (typeof value === "string") {
      return this.text(value, key);
    }
    if (typeof value === "number") {
      return key !== undefined && DURATION_KEYS.has(key) ? "<duration>" : value;
    }
    if (value instanceof Date) {
      return this.date(value, key);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.value(item, undefined));
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) {
        if (child !== undefined) {
          result[name] = this.value(child, name);
        }
      }
      return result;
    }
    return value ?? null;
  }
}

// --- Printing and comparing -----------------------------------------------------------------------------------------

/** The `printWidth` of the root .prettierrc.json, which `pnpm format:check` applies to the golden files. */
const PRINT_WIDTH = 110;

/** The display width of a text as Prettier measures it (wide East Asian characters 2, combining marks 0). */
function textWidth(text: string): number {
  if (/^[\x20-\x7e]*$/.test(text)) {
    return text.length;
  }
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x300 && code <= 0x36f)) {
      continue;
    }
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(character) ? 2 : 1;
  }
  return width;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A string, number, boolean or `null` (Prettier writes `1e21` for JSON's `1e+21`). */
function printScalar(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  return typeof value === "number" ? text.replace("e+", "e") : text;
}

/** The value on one line, or `undefined` when it holds an object with members (Prettier keeps those expanded). */
function oneLine(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const items = value.map(oneLine);
    return items.every((item) => item !== undefined) ? `[${items.join(", ")}]` : undefined;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length === 0 ? "{}" : undefined;
  }
  return printScalar(value);
}

/** `value` starting at `column` of a line indented by `indent`, `after` characters (a comma) following it. */
function printValue(value: unknown, indent: string, column: number, after: number): string {
  if (Array.isArray(value)) {
    return printArray(value, indent, column, after);
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    const inner = `${indent}  `;
    const lines = entries.map(([key, child], index) => {
      const head = `${inner}${JSON.stringify(key)}: `;
      return head + printValue(child, inner, textWidth(head), index < entries.length - 1 ? 1 : 0);
    });
    return `{\n${lines.join(",\n")}\n${indent}}`;
  }
  return printScalar(value);
}

/**
 * An array as Prettier prints JSON: on one line when it fits and holds no object with members, unless every item is an
 * array of two or more; else one item per line, or numbers filled into lines.
 */
function printArray(array: readonly unknown[], indent: string, column: number, after: number): string {
  if (array.length === 0) {
    return "[]";
  }
  const line = oneLine(array);
  const brokenAlways = array.length > 1 && array.every((item) => Array.isArray(item) && item.length > 1);
  if (line !== undefined && !brokenAlways && column + textWidth(line) + after <= PRINT_WIDTH) {
    return line;
  }
  const inner = `${indent}  `;
  if (array.length > 1 && array.every((item) => typeof item === "number")) {
    let text = `[\n${inner}`;
    let at = textWidth(inner);
    array.forEach((item, index) => {
      const part = `${printScalar(item)}${index < array.length - 1 ? "," : ""}`;
      if (index > 0) {
        if (at + 1 + textWidth(part) <= PRINT_WIDTH) {
          text += " ";
          at += 1;
        } else {
          text += `\n${inner}`;
          at = textWidth(inner);
        }
      }
      text += part;
      at += textWidth(part);
    });
    return `${text}\n${indent}]`;
  }
  const lines = array.map(
    (item, index) => `${inner}${printValue(item, inner, textWidth(inner), index < array.length - 1 ? 1 : 0)}`,
  );
  return `[\n${lines.join(",\n")}\n${indent}]`;
}

/** A golden record as its file holds it: JSON as Prettier prints it (root .prettierrc.json), with a final newline. */
function printGolden(record: unknown): string {
  return `${printValue(record, "", 0, 0)}\n`;
}

/**
 * Fails, naming no value, when the golden text of `file` holds a credential of the set-up (the test account's client
 * id or secret, an API key), the token request or a token, or a card number (OBE-109 AC4). It runs before the
 * comparison, so a recording with `-u` cannot write one either.
 */
function expectNoSecrets(file: string, text: string): void {
  if ([clientId, clientSecret, alphaSk, alphaConsole, betaSk].some((value) => text.includes(value))) {
    throw new Error(`The golden text of ${file} holds a credential of the set-up`);
  }
  if (text.includes(OAUTH_TOKEN_PATH) || /\b(?:bearer|access_token|client_secret)\b/i.test(text)) {
    throw new Error(`The golden text of ${file} holds the token request or a token`);
  }
  if (holdsCardNumber(text)) {
    throw new Error(`The golden text of ${file} holds a card number`);
  }
}

/** Compares `record` with its golden file; a missing file fails unless the run updates snapshots (`-u`). */
async function expectGolden(file: string, record: unknown): Promise<void> {
  const path = join(GOLDEN_DIR, file);
  const text = printGolden(record);
  expectNoSecrets(file, text);
  if (expect.getState().snapshotState.snapshotUpdateState !== "all" && !existsSync(path)) {
    throw new Error(
      `The golden file ${file} is missing: record the baseline with -u (ota/backend/README.md §8)`,
    );
  }
  await expect(text).toMatchFileSnapshot(path);
}

/**
 * Runs one scenario: sends `call` while recording the Amadeus requests, then compares the request, the Amadeus
 * requests, the answer and the new rows of both tenants with the golden file `file`.
 */
async function scenario(file: string, title: string, call: ApiCall): Promise<request.Response> {
  const before = await rowIds();
  const amadeus = recordAmadeusCalls();
  let res: request.Response;
  try {
    res = await post(call);
  } finally {
    amadeus.restore();
  }
  const rows = await newRows(before);
  const placeholders = new GoldenPlaceholders();
  const record = placeholders.value(
    {
      scenario: title,
      request: {
        caller: call.caller.name,
        method: "POST",
        path: call.path,
        stubScenario: call.scenario ?? null,
        body: call.body ?? null,
      },
      amadeus: amadeus.calls.map(amadeusCallRecord),
      answer: { status: res.status, body: res.body as unknown },
      rows,
    },
    undefined,
  );
  await expectGolden(file, record);
  return res;
}

// --- Set-up and scenarios -------------------------------------------------------------------------------------------

// Cloning the template, starting the stub and building the API's module graph take several seconds alone and much
// longer on a busy 4-CPU runner: all of it happens once here, with its own timeout, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  [db, redis, keys] = await Promise.all([createTestDatabase(), useRedis(), testKeyProvider()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  clientSecret = randomBytes(24).toString("base64url");
  accountId = await insertAccount(clientId, clientSecret);
  const alphaId = await insertTenant("alpha");
  const betaId = await insertTenant("beta");
  alphaSk = await issueKey(alphaId);
  alphaConsole = await issueKey(alphaId, ["console:automation", "queues:read"]);
  betaSk = await issueKey(betaId);
  await seedTenant("tenant_alpha", "Alpha Travel");
  await seedTenant("tenant_beta", "Beta Trips");
  await seedAlphaMarkup();
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret } });
  api = await createTestApp({ database: db, redis, env: { AMADEUS_BASE_URL_TEST: stub.url } });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(async () => {
  // Full Amadeus buckets, no single-flight keys and no cached token from the previous scenario.
  await redis.client.flushdb();
});

describe("the golden comparison [OBE-109 AC2]", () => {
  it("refuses an Amadeus body that is not JSON.stringify's text, so the parsed body stands for its bytes", () => {
    const call = { method: "POST", path: "/v2/shopping/flight-offers", query: "" };
    expect(amadeusCallRecord({ ...call, body: '{"currencyCode":"EUR"}' })).toMatchObject({
      body: { currencyCode: "EUR" },
    });
    expect(() => amadeusCallRecord({ ...call, body: '{"currencyCode": "EUR"}' })).toThrow(/JSON.stringify/);
    // A form body (a token request's) is refused without its text in the message.
    expect(() =>
      amadeusCallRecord({ ...call, body: "grant_type=client_credentials&client_secret=x" }),
    ).toThrow(/^The body sent to \/v2\/shopping\/flight-offers is not JSON$/);
  });

  it("prints a one-character change of a request body as another golden text", () => {
    const record = (body: string) => ({
      amadeus: [amadeusCallRecord({ method: "GET", path: "/", query: "", body })],
    });
    expect(printGolden(record('{"max":"150"}'))).not.toBe(printGolden(record('{"max":"151"}')));
  });
});

describe("the golden files' contents [OBE-109 AC4]", () => {
  it("refuses a golden text with a credential of the set-up, the token request, a token or a card number", () => {
    const text = (value: string) =>
      printGolden({ request: { caller: "alpha, secret key", body: { value } } });
    expect(() =>
      expectNoSecrets("x.json", text("ADNNALB4 98.47 EUR 2027-01-15T07:15:00 411111")),
    ).not.toThrow();
    for (const leak of [clientId, clientSecret, alphaSk, alphaConsole, betaSk]) {
      expect(() => expectNoSecrets("x.json", text(`id ${leak}.`))).toThrow(/x\.json holds a credential/);
    }
    for (const leak of [`POST ${OAUTH_TOKEN_PATH}`, "Bearer abc", "access_token=abc", "client_secret=abc"]) {
      expect(() => expectNoSecrets("x.json", text(leak))).toThrow(
        /x\.json holds the token request or a token/,
      );
    }
    expect(() => expectNoSecrets("x.json", text("card 4111 1111 1111 1111"))).toThrow(
      /x\.json holds a card number/,
    );
  });
});

describe("flights.search", () => {
  it("SIMPLE mode, customer scope, the full view [OBE-109 AC1]", async () => {
    await scenario("search/simple.json", "flights.search: SIMPLE mode, customer scope, full view, by price", {
      caller: ALPHA,
      path: "/v1/flight-searches",
      body: { ...SIMPLE, resultOptions: { limit: 5, sort: "price", view: "full" } },
    });
  });

  it("ADVANCED mode with the defaults filled in [OBE-109 AC1]", async () => {
    await scenario(
      "search/advanced.json",
      "flights.search: ADVANCED mode (the POST body), two offers a page",
      {
        caller: ALPHA,
        path: "/v1/flight-searches",
        body: advanced(),
      },
    );
  });

  it("the storefront's own offers per search bound max and maxFlightOffers [OBE-109 AC1]", async () => {
    const setSearchDefaults = (value: Readonly<Record<string, unknown>>) =>
      tenantTx(tenantDb, "tenant_beta", (trx) =>
        trx
          .updateTable("storefront_settings")
          .set({ search_defaults: JSON.stringify(value) })
          .execute(),
      );
    await setSearchDefaults({ maxResults: 40 });
    try {
      await scenario(
        "search/storefront-limit-simple.json",
        "flights.search: SIMPLE mode asking for 250 offers, beta's storefront allows 40",
        { caller: BETA, path: "/v1/flight-searches", body: { ...SIMPLE, max: 250 } },
      );
      await redis.client.flushdb();
      await scenario(
        "search/storefront-limit-advanced.json",
        "flights.search: ADVANCED mode asking for 100 offers, beta's storefront allows 40",
        { caller: BETA, path: "/v1/flight-searches", body: advanced({ maxFlightOffers: 100 }, 1) },
      );
    } finally {
      await setSearchDefaults({});
    }
  });

  it("zero offers for the destination ZZZ [OBE-109 AC1]", async () => {
    await scenario(
      "search/no-offers.json",
      "flights.search: the stub's empty answer for the destination ZZZ",
      {
        caller: ALPHA,
        path: "/v1/flight-searches",
        body: { ...SIMPLE, destinationLocationCode: "ZZZ" },
      },
    );
  });

  it("Amadeus answers 5xx: 502 SUPPLIER_ERROR and a failed search [OBE-109 AC1]", async () => {
    await scenario("search/server-error.json", "flights.search: the stub's server-error scenario", {
      caller: ALPHA,
      path: "/v1/flight-searches",
      body: SIMPLE,
      scenario: "server-error",
    });
  });

  it("an asynchronous search is refused without calling Amadeus [OBE-109 AC1]", async () => {
    await scenario("search/async-refused.json", "flights.search: resultOptions.async, 403 FEATURE_DISABLED", {
      caller: ALPHA,
      path: "/v1/flight-searches",
      body: { ...SIMPLE, resultOptions: { async: true } },
    });
  });

  it("included and excluded airlines together are refused [OBE-109 AC1]", async () => {
    await scenario(
      "search/airlines-conflict.json",
      "flights.search: included and excluded airlines, 400 VALIDATION_FAILED",
      {
        caller: ALPHA,
        path: "/v1/flight-searches",
        body: { ...SIMPLE, includedAirlineCodes: ["AF"], excludedAirlineCodes: ["IB"] },
      },
    );
  });

  it("more than 9 travellers over two years old are refused [OBE-109 AC1]", async () => {
    const body = advanced();
    await scenario(
      "search/too-many-travelers.json",
      "flights.search: ADVANCED mode with 10 adults, 400 VALIDATION_FAILED",
      {
        caller: ALPHA,
        path: "/v1/flight-searches",
        body: {
          mode: "advanced",
          query: {
            ...body.query,
            travelers: Array.from({ length: 10 }, (_unused, index) => ({
              id: String(index + 1),
              travelerType: "ADULT",
            })),
          },
        },
      },
    );
  });

  it("offers that cannot be stored: 500 and a failed search [OBE-109 AC1]", async () => {
    // A fixed markup no `numeric(12,2)` selling total can hold: the insert of the offers fails.
    const ruleId = newId("mkr");
    await tenantTx(tenantDb, "tenant_beta", (trx) =>
      trx
        .insertInto("markup_rules")
        .values({
          id: ruleId,
          name: "Overflow",
          scope: JSON.stringify({}),
          calculation: "fixed",
          fixed_amount: "9999999999.99",
          fixed_currency: "EUR",
          applies_per: "booking",
          priority: 1,
          stackable: false,
          is_default: false,
          is_active: true,
        })
        .execute(),
    );
    try {
      await scenario(
        "search/offers-not-stored.json",
        "flights.search: beta's markup overflows the selling total, 500 INTERNAL_ERROR",
        { caller: BETA, path: "/v1/flight-searches", body: SIMPLE },
      );
    } finally {
      await tenantTx(tenantDb, "tenant_beta", (trx) =>
        trx.deleteFrom("markup_rules").where("id", "=", ruleId).execute(),
      );
    }
  });

  it("from the hosted storefront [OBE-109 AC1]", async () => {
    await scenario(
      "search/hosted-storefront.json",
      "flights.search: SIMPLE mode from the hosted storefront",
      {
        caller: ALPHA_STOREFRONT,
        path: "/v1/flight-searches",
        body: SIMPLE,
      },
    );
  });

  it("console scope: the verbatim offers, the net price and the markup [OBE-109 AC1]", async () => {
    await scenario("search/console.json", "flights.search: SIMPLE mode, console scope, full view, by price", {
      caller: ALPHA_CONSOLE,
      path: "/v1/flight-searches",
      body: { ...SIMPLE, resultOptions: { limit: 5, sort: "price", view: "full" } },
    });
  });
});

describe("flights.upsell", () => {
  /** Offer 2 of a new search of alpha, the offer the stub's upsell fixture belongs to (IB3436). */
  const baseOffer = async (date: string = SIMPLE.departureDate) => {
    const { offers } = await searchFor({ ...SIMPLE, departureDate: date });
    return { offerId: offerOf(offers, "2"), offers };
  };
  const upsellPath = (offerId: string) => `/v1/flight-offers/${offerId}/upsells`;

  it("the brand alternatives of an offer [OBE-109 AC1]", async () => {
    const { offerId } = await baseOffer();
    await scenario("upsell/success.json", "flights.upsell: the three fare families of offer 2", {
      caller: ALPHA,
      path: upsellPath(offerId),
    });
  });

  it("Amadeus cannot sell the segments: 409 SOLD_OUT [OBE-109 AC1]", async () => {
    const { offerId } = await baseOffer();
    await scenario("upsell/sold-out.json", "flights.upsell: the stub's sold-out scenario", {
      caller: ALPHA,
      path: upsellPath(offerId),
      scenario: "sold-out",
    });
  });

  it("with the card's brand and BIN [OBE-109 AC1]", async () => {
    const { offerId } = await baseOffer();
    await scenario("upsell/payments.json", "flights.upsell: with payments (VISA, BIN 411111)", {
      caller: ALPHA,
      path: upsellPath(offerId),
      body: { payments: [{ brand: "VISA", bin: "411111" }] },
    });
  });

  it("an identical request again is answered from offer_upsells [OBE-109 AC1]", async () => {
    const { offerId } = await baseOffer();
    const body = { payments: [{ brand: "VISA", bin: "411111" }] };
    const first = await post({ caller: ALPHA, path: upsellPath(offerId), body });
    expect(first.status).toBe(200);
    await scenario("upsell/cached.json", "flights.upsell: the same offer and payments again, another key", {
      caller: ALPHA,
      path: upsellPath(offerId),
      body,
    });
  });

  it("another tenant's offer: 404 [OBE-109 AC1]", async () => {
    const { offerId } = await baseOffer();
    await scenario("upsell/other-tenant.json", "flights.upsell: beta asks for alpha's offer, 404 NOT_FOUND", {
      caller: BETA,
      path: upsellPath(offerId),
    });
  });

  it("an expired offer: 410 OFFER_EXPIRED [OBE-109 AC1]", async () => {
    const { offerId } = await baseOffer();
    await expireOffer(offerId);
    await scenario("upsell/expired-offer.json", "flights.upsell: an expired offer, 410 OFFER_EXPIRED", {
      caller: ALPHA,
      path: upsellPath(offerId),
    });
  });

  it("offers of two searches: 422 OFFER_COMBINATION_INVALID [OBE-109 AC1]", async () => {
    const first = await baseOffer();
    const second = await baseOffer("2027-01-16");
    await scenario(
      "upsell/two-searches.json",
      "flights.upsell: combined with an offer of another search, 422 OFFER_COMBINATION_INVALID",
      {
        caller: ALPHA,
        path: upsellPath(first.offerId),
        body: { combineWithOfferIds: [offerOf(second.offers, "3")] },
      },
    );
  });

  it("a card for another offer: 400 VALIDATION_FAILED [OBE-109 AC1]", async () => {
    const { offerId, offers } = await baseOffer();
    await scenario(
      "upsell/card-for-other-offer.json",
      "flights.upsell: a payment for an offer that is not upsold, 400 VALIDATION_FAILED",
      {
        caller: ALPHA,
        path: upsellPath(offerId),
        body: { payments: [{ brand: "VISA", offerIds: [offerOf(offers, "3")] }] },
      },
    );
  });

  it("two offers of one search with their one-way combinations, console scope [OBE-109 AC1]", async () => {
    const { offerId, offers } = await baseOffer();
    await scenario("upsell/combined-console.json", "flights.upsell: offers 2 and 3 together, console scope", {
      caller: ALPHA_CONSOLE,
      path: upsellPath(offerId),
      body: { combineWithOfferIds: [offerOf(offers, "3")] },
    });
  });

  it("the storefront turned upsell off: 403 FEATURE_DISABLED [OBE-109 AC1]", async () => {
    const { offerId } = await baseOffer();
    const setFeatures = (features: Readonly<Record<string, unknown>>) =>
      tenantTx(tenantDb, "tenant_alpha", (trx) =>
        trx
          .updateTable("storefront_settings")
          .set({ features: JSON.stringify(features) })
          .execute(),
      );
    await setFeatures({ brandedFareUpsell: false });
    try {
      await scenario(
        "upsell/feature-disabled.json",
        "flights.upsell: brandedFareUpsell off, customer scope, 403 FEATURE_DISABLED",
        { caller: ALPHA, path: upsellPath(offerId) },
      );
    } finally {
      await setFeatures({});
    }
  });

  it("from the hosted storefront [OBE-109 AC1]", async () => {
    const { offerId } = await baseOffer();
    await scenario("upsell/hosted-storefront.json", "flights.upsell: from the hosted storefront", {
      caller: ALPHA_STOREFRONT,
      path: upsellPath(offerId),
      body: {},
    });
  });
});

describe("flights.price", () => {
  beforeAll(seedAlphaFees);

  const PRICE = "/v1/priced-offers";

  it("an offer with the default include [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-02");
    await scenario("price/success.json", "flights.price: offer 2, the default include", {
      caller: ALPHA,
      path: PRICE,
      body: { offerIds: [offerOf(offers, "2")] },
    });
  });

  it("the stub's higher price: 201 with priceChange [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-03");
    await scenario("price/price-changed.json", "flights.price: the stub's price-changed scenario", {
      caller: ALPHA,
      path: PRICE,
      body: { offerIds: [offerOf(offers, "2")] },
      scenario: "price-changed",
    });
  });

  it("another expectedTotal: 409 PRICE_CHANGED after storing the priced offer [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-04");
    await scenario(
      "price/price-changed-expected-total.json",
      "flights.price: price-changed with the results' total expected, 409 PRICE_CHANGED",
      {
        caller: ALPHA,
        path: PRICE,
        body: { offerIds: [offerOf(offers, "2")], expectedTotal: { amount: "108.32", currency: "EUR" } },
        scenario: "price-changed",
      },
    );
  });

  it("console scope: the net price, the markup and the verbatim answer [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-05");
    await scenario("price/console.json", "flights.price: offer 2, console scope", {
      caller: ALPHA_CONSOLE,
      path: PRICE,
      body: { offerIds: [offerOf(offers, "2")] },
    });
  });

  it("two offers of one search together [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-06");
    await scenario("price/two-offers.json", "flights.price: offers 2 and 3 together, nothing included", {
      caller: ALPHA,
      path: PRICE,
      body: { offerIds: [offerOf(offers, "2"), offerOf(offers, "3")], include: [] },
    });
  });

  it("the card hints and the travellers [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-07");
    await scenario(
      "price/card-hints-and-travelers.json",
      "flights.price: payments (VISA, BIN 411111) and a traveller",
      {
        caller: ALPHA,
        path: PRICE,
        body: {
          offerIds: [offerOf(offers, "2")],
          payments: [{ brand: "VISA", bin: "411111" }],
          travelers: [TRAVELER],
        },
      },
    );
  });

  it("Amadeus cannot sell the segments: 409 SOLD_OUT [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-08");
    await scenario("price/sold-out.json", "flights.price: the stub's sold-out scenario", {
      caller: ALPHA,
      path: PRICE,
      body: { offerIds: [offerOf(offers, "2")] },
      scenario: "sold-out",
    });
  });

  it("offers of two searches: 422 OFFER_COMBINATION_INVALID [OBE-109 AC1]", async () => {
    const first = await offersToPrice("2027-02-09");
    const second = await offersToPrice("2027-02-10");
    await scenario(
      "price/two-searches.json",
      "flights.price: offers of two searches, 422 OFFER_COMBINATION_INVALID",
      { caller: ALPHA, path: PRICE, body: { offerIds: [offerOf(first, "2"), offerOf(second, "2")] } },
    );
  });

  it("raw Amadeus offers: 403 with a secret key, 422 in console scope [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-11");
    const { payload } = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .selectFrom("flight_offers")
        .select("payload")
        .where("id", "=", offerOf(offers, "2"))
        .executeTakeFirstOrThrow(),
    );
    await scenario("price/raw-offers.json", "flights.price: amadeusFlightOffers with a secret key, 403", {
      caller: ALPHA,
      path: PRICE,
      body: { amadeusFlightOffers: [payload] },
    });
    await scenario(
      "price/raw-offers-console.json",
      "flights.price: amadeusFlightOffers in console scope, 422",
      {
        caller: ALPHA_CONSOLE,
        path: PRICE,
        body: { amadeusFlightOffers: [payload] },
      },
    );
  });

  it("requests it cannot send: extras, a card for another offer, an unknown traveller, no offer [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-12");
    const offerId = offerOf(offers, "2");
    await scenario("price/additional-services.json", "flights.price: additionalServices, 422 UNPROCESSABLE", {
      caller: ALPHA,
      path: PRICE,
      body: {
        offerIds: [offerId],
        additionalServices: [{ type: "CHECKED_BAGS", travelerId: "1", quantity: 1 }],
      },
    });
    await scenario(
      "price/card-for-other-offer.json",
      "flights.price: a payment for an offer that is not priced, 400 VALIDATION_FAILED",
      {
        caller: ALPHA,
        path: PRICE,
        body: { offerIds: [offerId], payments: [{ brand: "VISA", offerIds: [offerOf(offers, "3")] }] },
      },
    );
    await scenario("price/unknown-traveler.json", "flights.price: a traveller the offer does not have, 400", {
      caller: ALPHA,
      path: PRICE,
      body: { offerIds: [offerId], travelers: [{ ...TRAVELER, id: "7" }] },
    });
    await scenario("price/no-offer.json", "flights.price: an empty body, 400 VALIDATION_FAILED", {
      caller: ALPHA,
      path: PRICE,
      body: {},
    });
  });

  it("another tenant's offer: 404; an expired offer: 410 OFFER_EXPIRED [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-13");
    const offerId = offerOf(offers, "2");
    await scenario("price/other-tenant.json", "flights.price: beta prices alpha's offer, 404 NOT_FOUND", {
      caller: BETA,
      path: PRICE,
      body: { offerIds: [offerId] },
    });
    await expireOffer(offerId);
    await scenario("price/expired-offer.json", "flights.price: an expired offer, 410 OFFER_EXPIRED", {
      caller: ALPHA,
      path: PRICE,
      body: { offerIds: [offerId] },
    });
  });

  it("from the hosted storefront [OBE-109 AC1]", async () => {
    const offers = await offersToPrice("2027-02-14");
    await scenario("price/hosted-storefront.json", "flights.price: offer 2 from the hosted storefront", {
      caller: ALPHA_STOREFRONT,
      path: PRICE,
      body: { offerIds: [offerOf(offers, "2")] },
    });
  });
});
