// The OTA side of the end-to-end stack (OFE-008): data of the demo OTA and of the suspended OTA that the storefront
// journeys cannot create through a page or a public operation (PADR-0017 item 5), and the check that the storefront
// sees selling prices only (OF-02 AC1).
//
//   const searchId = searchIdOf(page.url());          // the srch_ id the results page wrote into the address
//   await expireSearch(searchId);                       // its expires_at (and its offers') one hour in the past
//   await withSuspendedTenant(async () => { … });      // the OTA of SUSPENDED_STOREFRONT_URL, suspended meanwhile
//
// Tenant data goes through `tenantTx` of @velexis/db as velexis_ota_app, the OTA backend's own role, never through
// schema-qualified SQL or a session-level search_path (ADR-0004). The platform row of the suspended OTA is written as
// velexis_migrator, as the OTA backend's development seed writes the demo OTA's (ota/backend/README.md §5): the platform
// API has no operation that creates a suspended OTA, and the demo OTA stays active for every other journey. After the
// change the platform's `tenant` invalidation is published, as the platform does after its commit, so the OTA API
// reads the new status at once instead of after the 60 s of its cache.
import { randomInt } from "node:crypto";
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
import { DEMO_TENANT_KEY, stackDatabaseUrl, SUSPENDED_TENANT_KEY } from "./stack";

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
