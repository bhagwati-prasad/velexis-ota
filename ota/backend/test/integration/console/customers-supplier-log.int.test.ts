// The console customers and the supplier log (OBE-066; ota/docs/flows/console-operations.md §2 "Customers" and
// "Supplier log", §3 step 7, OADR-0011 point 8 as decided on 2026-10-21, db README §7, §8 and §10):
// console.customers.list and get, and console.supplierRequests.list, against PostgreSQL 16 and Redis 7 through the
// API's whole pipeline (guards, validation, the audit interceptor). No Amadeus call is made.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does (alpha in test, beta live; accounts and memberships of each role). Staff sign in through the OTA
// admin's service key with portal tokens, each admin client with an end-user IP address of its own. Customers, bookings,
// payments, sessions and saved travellers are rows inserted as sign-up, the booking orchestration and the webhooks leave
// them; a deleted account is written by account.delete's own repository (AccountRepository.markDeleted: the
// `…@deleted.invalid` placeholder, the names, phone and date of birth kept until the erasure job). The supplier log's
// rows are written by the Amadeus client's own writer (SupplierRequestsRepository.insert, which redacts the bodies), and
// one as a row of before FIX-W26-SECURITY and FIX-W29-SECURITY would still hold it. Card and document numbers are made
// up per run (the card is Visa's documented test number); every customer address of the run shares one random prefix,
// so a list narrowed to it shows this file's customers only. Every answer is checked against the OTA document.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { sha256Hex } from "@velexis/crypto";
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
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountRepository } from "../../../src/account/account.repository";
import { DELETED_ADDRESS_KEY_BYTES, deletedAddress } from "../../../src/account/account.service";
import {
  SupplierRequestsRepository,
  type SupplierRequestRecord,
} from "../../../src/amadeus/supplier-requests.repository";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { newDocumentNumber } from "../../builders/checkouts";
import { testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Role = "owner" | "admin" | "agent" | "finance" | "viewer";
type Environment = "test" | "live";
type Schema = "tenant_alpha" | "tenant_beta";
type JsonObject = Record<string, unknown>;

/** A block's own rows (customers, bookings, payments, calls): a few dozen inserts; the bound only stops a hang. */
const BLOCK_SETUP_TIMEOUT_MS = 30_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CUSTOMERS = "/v1/console/customers";
const SUPPLIER_LOG = "/v1/console/supplier-requests";

/** The prefix of every customer address of this run (`q` narrows a list to this file's customers). */
const RUN = `obe066${randomBytes(3).toString("hex")}`;

/** Visa's documented test card number, never stored in full by the writer. */
const PAN = "4111111111111111";
/** The card's other made-up values: a holder and an expiry no traveller name or document date shares. */
const CARD_HOLDER = "MAXIMILIAN KARDHOLDER";
const CARD_EXPIRY = "2031-07";
const CARD_CVV = "987";

const quietPoolLogger = { error: (): void => undefined };

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let betaId: string;

const inTenant = <T>(schema: Schema, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, schema, run);

const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> => inTenant("tenant_alpha", run);

// ---- Platform rows and staff sessions ------------------------------------------------------------------------------

/** An active tenant of a provisioned schema; `live` makes it a live tenant (its staff may choose `live`). */
async function insertTenant(key: "alpha" | "beta", live: boolean): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id,
      key,
      name: `${key} Travel`,
      status: "active",
      plan_code: "early_access",
      ...(live ? { storefront_environment: "live", live_enabled_at: new Date() } : {}),
    })
    .execute();
  return id;
}

interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly tenantId: string;
  readonly role: Role;
}

async function insertMember(role: Role, tenantId: string = alphaId): Promise<Member> {
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
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, tenantId, role };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stores a portal token for `member` as the platform's API does (PADR-0007 item 1). */
async function portalTokenFor(member: Member): Promise<string> {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: member.tenantId,
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

let ipCounter = 0;

/** A staff member signed in through the OTA admin (its service key, the staff member's IP and environment). */
class AdminSession {
  readonly ip: string;
  readonly userAgent = `Mozilla/5.0 (OTA admin test ${randomBytes(3).toString("hex")})`;
  accessToken = "";

  constructor(
    readonly member: Member,
    readonly environment: Environment = "test",
  ) {
    ipCounter += 1;
    this.ip = `198.51.100.${ipCounter}`;
  }

  headers(): Record<string, string> {
    return {
      "X-Api-Key": testApiCredentials().serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": this.userAgent,
      "X-Velexis-Environment": this.environment,
      ...(this.accessToken === "" ? {} : { Authorization: `Bearer ${this.accessToken}` }),
    };
  }

  async signIn(): Promise<this> {
    const res = await request(api.server)
      .post("/v1/console/auth/sign-in")
      .set({ ...this.headers(), "Idempotency-Key": randomUUID() })
      .send({ grantType: "portal_token", portalToken: await portalTokenFor(this.member) });
    expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
    this.accessToken = (res.body.session as { accessToken: string }).accessToken;
    return this;
  }

  get(path: string) {
    return request(api.server).get(path).set(this.headers());
  }
}

const sessions = new Map<Role, AdminSession>();

/** The signed-in staff member of `role` (one per role and file, signed in before the tests). */
function staff(role: Role): AdminSession {
  const session = sessions.get(role);
  if (session === undefined) {
    throw new Error(`no ${role} signed in`);
  }
  return session;
}

// ---- Tenant rows ---------------------------------------------------------------------------------------------------

/** What a seeded customer looks like. */
interface CustomerSeed {
  /** The tenant (alpha by default). */
  readonly schema?: Schema;
  readonly firstName: string;
  readonly lastName: string;
  /** The local part after the run's prefix (`<RUN>.<local>@example.com`). */
  readonly local: string;
  readonly status?: "active" | "pending_verification" | "disabled";
  readonly verified?: boolean;
  readonly phone?: { readonly countryCode: string; readonly number: string };
  readonly dateOfBirth?: string;
  readonly createdAgoMs?: number;
}

interface SeededCustomer {
  readonly id: string;
  readonly email: string;
}

/** A customer account as sign-up and the verification leave it. */
async function seedCustomer(seed: CustomerSeed): Promise<SeededCustomer> {
  const id = newId("cus");
  const email = `${RUN}.${seed.local}@example.com`;
  const createdAt = new Date(Date.now() - (seed.createdAgoMs ?? 0));
  await inTenant(seed.schema ?? "tenant_alpha", (trx) =>
    trx
      .insertInto("customers")
      .values({
        id,
        email,
        email_verified_at: seed.verified === false ? null : createdAt,
        first_name: seed.firstName,
        last_name: seed.lastName,
        status: seed.status ?? "active",
        phone_country_code: seed.phone?.countryCode ?? null,
        phone_number: seed.phone?.number ?? null,
        date_of_birth: seed.dateOfBirth === undefined ? null : new Date(`${seed.dateOfBirth}T00:00:00Z`),
        marketing_consent: true,
        marketing_consent_source: "sign_up",
        marketing_consent_updated_at: createdAt,
        terms_accepted_version: "2026-01",
        last_sign_in_at: createdAt,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .execute(),
  );
  return { id, email };
}

/** Deletes an account as account.delete writes it (its repository): placeholder address, names kept for erasure. */
async function deleteAccount(customer: SeededCustomer): Promise<void> {
  await alphaTx((trx) =>
    new AccountRepository().markDeleted(trx, {
      customerId: customer.id,
      placeholder: deletedAddress(customer.email, randomBytes(DELETED_ADDRESS_KEY_BYTES)),
      now: new Date(),
    }),
  );
}

/** What a seeded booking looks like. */
interface BookingSeed {
  /** The tenant (alpha by default). */
  readonly schema?: Schema;
  readonly customerId: string | null;
  readonly environment?: Environment;
  readonly status?: "pending" | "confirmed" | "ticketed" | "cancelled" | "failed";
  readonly createdAgoMs?: number;
  /** When the trip ends, relative to now (10 days ahead by default; negative: a past trip). */
  readonly arrivalInMs?: number;
  readonly currency?: string;
}

/** A booking row as the record step writes it (no flights or travellers: the summaries do not need them). */
async function seedBooking(seed: BookingSeed): Promise<string> {
  const id = newId("bkg");
  const now = Date.now();
  const arrival = new Date(now + (seed.arrivalInMs ?? 10 * DAY));
  const status = seed.status ?? "confirmed";
  const withOrder = status !== "pending" && status !== "failed";
  await inTenant(seed.schema ?? "tenant_alpha", (trx) =>
    trx
      .insertInto("bookings")
      .values({
        id,
        environment: seed.environment ?? "test",
        reference: newBookingReference(),
        channel: "storefront",
        customer_id: seed.customerId,
        status,
        ticketing_status:
          status === "ticketed" ? "issued" : status === "confirmed" ? "pending" : "not_applicable",
        amadeus_order_id: withOrder ? `ORDER-${id.slice(-10)}` : null,
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: new Date(arrival.getTime() - 2 * HOUR),
        last_arrival_at: arrival,
        currency: seed.currency ?? "EUR",
        net_amount: "98.47",
        markup_amount: "12.00",
        taxes_amount: "42.47",
        total_amount: "110.47",
        contact_email: "contact@example.com",
        lead_last_name: "SAMPLE",
        cancelled_at: status === "cancelled" ? new Date(now - HOUR) : null,
        cancelled_by: status === "cancelled" ? "customer" : null,
        created_at: new Date(now - (seed.createdAgoMs ?? 0)),
      })
      .execute(),
  );
  return id;
}

/** A card payment of a booking with what it captured and refunded. */
async function seedPayment(
  bookingId: string,
  payment: {
    readonly schema?: Schema;
    readonly captured: string;
    readonly refunded?: string;
    readonly currency?: string;
    readonly environment?: Environment;
    readonly status?: string;
  },
): Promise<void> {
  const captured = payment.captured;
  await inTenant(payment.schema ?? "tenant_alpha", (trx) =>
    trx
      .insertInto("payments")
      .values({
        id: newId("pay"),
        environment: payment.environment ?? "test",
        booking_id: bookingId,
        provider: "stripe",
        provider_payment_id: `pi_${randomBytes(12).toString("hex")}`,
        method: "card",
        capture_method: "manual",
        currency: payment.currency ?? "EUR",
        amount: captured === "0.00" ? "110.47" : captured,
        amount_authorized: captured,
        amount_captured: captured,
        amount_refunded: payment.refunded ?? "0.00",
        status:
          payment.status ??
          (payment.refunded !== undefined && payment.refunded !== "0.00" ? "partially_refunded" : "captured"),
        card_brand: "VISA",
        card_last4: "4242",
      })
      .execute(),
  );
}

/** A session row of a customer: the current generation of its family unless told otherwise. */
async function seedSession(
  customerId: string,
  state: {
    readonly familyId?: string;
    readonly rotated?: boolean;
    readonly revoked?: boolean;
    readonly endedAgoMs?: number;
  },
): Promise<string> {
  const id = newId("ses");
  const now = Date.now();
  const ends = new Date(state.endedAgoMs === undefined ? now + 12 * HOUR : now - state.endedAgoMs);
  await alphaTx((trx) =>
    trx
      .insertInto("customer_sessions")
      .values({
        id,
        customer_id: customerId,
        family_id: state.familyId ?? id,
        refresh_token_hash: sha256Hex(randomBytes(32).toString("base64url")),
        family_expires_at: ends,
        expires_at: ends,
        rotated_at: state.rotated === true ? new Date(now - MINUTE) : null,
        revoked_at: state.revoked === true ? new Date(now - MINUTE) : null,
        revoke_reason: state.revoked === true ? "logout" : null,
      })
      .execute(),
  );
  return id;
}

async function seedSavedTraveler(customerId: string): Promise<void> {
  await alphaTx((trx) =>
    trx
      .insertInto("saved_travelers")
      .values({ id: newId("trv"), customer_id: customerId, first_name: "TESTA", last_name: "TRAVELLER" })
      .execute(),
  );
}

/** The `staff_actions` rows about `targetId`, oldest first. */
const staffActionsOn = (targetId: string) =>
  alphaTx((trx) =>
    trx
      .selectFrom("staff_actions")
      .select([
        "action",
        "outcome",
        "actor_type",
        "staff_id",
        "staff_role",
        "target_type",
        "target_id",
        "ip_address",
        "user_agent",
        "before",
        "after",
      ])
      .where("target_id", "=", targetId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

/** How many `staff_actions` rows the tenant has. */
const staffActionCount = async (): Promise<number> =>
  (
    await alphaTx((trx) =>
      trx
        .selectFrom("staff_actions")
        .select(sql<number>`count(*)::int`.as("count"))
        .executeTakeFirstOrThrow(),
    )
  ).count;

// ---- Supplier requests ---------------------------------------------------------------------------------------------

/** When a seeded call was made: `agoMs` before `base` (now by default), in alpha unless `schema` says otherwise. */
interface CallTime {
  readonly agoMs?: number;
  readonly base?: number;
  readonly schema?: Schema;
}

/** One Amadeus call written by the client's own writer (SupplierRequestsRepository.insert redacts its bodies). */
async function writeCall(record: Partial<SupplierRequestRecord>, time: CallTime = {}): Promise<string> {
  const { agoMs = 0, base = Date.now(), schema = "tenant_alpha" } = time;
  const id = newId("sreq");
  await inTenant(schema, async (trx) => {
    await new SupplierRequestsRepository().insert(trx, {
      id,
      environment: "test",
      operation: "checkout.complete",
      amadeusApi: "FlightCreateOrders",
      amadeusOperationId: "createFligtOrders",
      httpMethod: "POST",
      path: "/v1/booking/flight-orders",
      officeId: "NCE1A0950",
      httpStatus: 201,
      outcome: "success",
      errorCodes: [],
      durationMs: 812,
      correlationId: null,
      requestId: null,
      requestBody: null,
      responseBody: null,
      bookingId: null,
      searchId: null,
      staffId: null,
      ...record,
    });
    const at = new Date(base - agoMs);
    await trx
      .updateTable("supplier_requests")
      .set({ created_at: at, updated_at: at })
      .where("id", "=", id)
      .execute();
  });
  return id;
}

/** The answer's text, to look for values that must never appear. */
const textOf = (res: Response): string => JSON.stringify(res.body);

// ---- Answers -------------------------------------------------------------------------------------------------------

interface PageBody<T> {
  readonly data: T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** The rows of a successful list answer, after checking it against the document. */
function rowsOf<T = JsonObject>(
  operationId: "consoleListCustomers" | "consoleListSupplierRequests",
  res: Response,
): PageBody<T> {
  expect(answer(res)).toEqual([200, undefined]);
  expectResponseToMatch(operationId, res);
  return res.body as PageBody<T>;
}

type Summary = JsonObject & { readonly id: string };
const customerPage = (res: Response) => rowsOf<Summary>("consoleListCustomers", res);
const logPage = (res: Response) => rowsOf<Summary>("consoleListSupplierRequests", res);
const ids = (page: PageBody<{ readonly id: string }>): string[] => page.data.map((row) => row.id);

// Cloning the template, building the API's module graph, compiling the response validators and the first sign-ins
// take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own budget,
// and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["consoleListCustomers", [200, 400]],
    ["consoleGetCustomer", [200, 404]],
    ["consoleListSupplierRequests", [200, 400, 403]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: quietPoolLogger,
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alphaId = await insertTenant("alpha", false);
  betaId = await insertTenant("beta", true);
  for (const [schema, name] of [
    ["tenant_alpha", "Alpha Travel"],
    ["tenant_beta", "Beta Trips"],
  ] as const) {
    await inTenant(schema, (trx) =>
      seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" }),
    );
  }
  api = await createTestApp({ database: db, redis });
  // The first sign-ins and console calls of a process open the pools' connections and warm the token and validation
  // code; done once here, so that no test pays for it.
  for (const role of ["owner", "agent", "finance", "viewer"] as const) {
    sessions.set(role, await new AdminSession(await insertMember(role)).signIn());
  }
  expect((await staff("owner").get(`${CUSTOMERS}?limit=1`)).status).toBe(200);
  expect((await staff("owner").get(`${CUSTOMERS}/${newId("cus")}`)).status).toBe(404);
  expect((await staff("owner").get(`${SUPPLIER_LOG}?limit=1&includeBodies=true`)).status).toBe(200);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

// ---- console.customers.list and get --------------------------------------------------------------------------------

describe("console.customers: deleted accounts", () => {
  /** The deleted account's personal data the row still holds (account.delete keeps it until the erasure job). */
  const kept = {
    firstName: "Gunnhild",
    lastName: "Vestergaard",
    phone: "699123456",
    dateOfBirth: "1979-03-14",
  };
  let deleted: SeededCustomer;
  let active: SeededCustomer;
  let bookingId: string;

  beforeAll(async () => {
    deleted = await seedCustomer({
      firstName: kept.firstName,
      lastName: kept.lastName,
      local: "deleted",
      phone: { countryCode: "34", number: kept.phone },
      dateOfBirth: kept.dateOfBirth,
      createdAgoMs: 40 * DAY,
    });
    active = await seedCustomer({
      firstName: "Gunnar",
      lastName: "Vesterberg",
      local: "active",
      createdAgoMs: 39 * DAY,
    });
    bookingId = await seedBooking({ customerId: deleted.id, status: "ticketed", createdAgoMs: 30 * DAY });
    await seedPayment(bookingId, { captured: "110.47" });
    await deleteAccount(deleted);
  }, BLOCK_SETUP_TIMEOUT_MS);

  /** The deleted account's kept values never appear in an answer. */
  function expectNoKeptData(res: Response): void {
    const text = textOf(res);
    for (const value of [kept.firstName, kept.lastName, kept.phone, kept.dateOfBirth, deleted.email]) {
      expect(text).not.toContain(value);
    }
  }

  it("[OBE-066 AC1] lists a deleted account only when asked for, as deleted, without its names or phone", async () => {
    const byDefault = customerPage(await staff("agent").get(`${CUSTOMERS}?q=${RUN}`));
    expect(ids(byDefault)).not.toContain(deleted.id);
    expect(ids(byDefault)).toContain(active.id);

    const res = await staff("agent").get(`${CUSTOMERS}?q=${RUN}&status=deleted`);
    const page = customerPage(res);
    expect(ids(page)).toEqual([]); // the placeholder address no longer starts with the run's prefix

    const all = customerPage(await staff("agent").get(`${CUSTOMERS}?status=deleted&limit=100`));
    const row = all.data.find((entry) => entry.id === deleted.id);
    expect(row).toMatchObject({
      status: "deleted",
      firstName: null,
      lastName: null,
      phone: null,
      bookingsCount: 1,
      totalSpent: { amount: "110.47", currency: "EUR" },
    });
    expect(row?.["email"]).toMatch(/^[0-9a-f]{64}@deleted\.invalid$/);
    expect(all.data.every((entry) => entry["status"] === "deleted")).toBe(true);
    expectNoKeptData(res);
    expectNoKeptData(await staff("agent").get(`${CUSTOMERS}?status=deleted&limit=100`));
  });

  it("[OBE-066 AC1] never finds a deleted account by its kept names, and sorts it as nameless", async () => {
    for (const q of [kept.firstName, kept.lastName, kept.lastName.slice(0, 4).toLowerCase()]) {
      const page = customerPage(
        await staff("agent").get(`${CUSTOMERS}?q=${encodeURIComponent(q)}&status=active,disabled,deleted`),
      );
      expect(ids(page)).not.toContain(deleted.id);
    }
    // Sorted by name, deleted accounts come last, whatever their kept name: Vestergaard would sort before Vesterberg's
    // neighbours otherwise.
    const sorted = customerPage(
      await staff("agent").get(`${CUSTOMERS}?status=active,deleted&sort=name&limit=100`),
    ).data;
    const firstDeleted = sorted.findIndex((entry) => entry["status"] === "deleted");
    expect(firstDeleted).toBeGreaterThan(sorted.findIndex((entry) => entry.id === active.id));
    expect(sorted.slice(firstDeleted).every((entry) => entry["status"] === "deleted")).toBe(true);
  });

  it("[OBE-066 AC1] shows a deleted account as deleted, without names, phone or date of birth, also in its bookings", async () => {
    const res = await staff("viewer").get(`${CUSTOMERS}/${deleted.id}`);

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetCustomer", res);
    expect(res.body.customer).toMatchObject({
      id: deleted.id,
      status: "deleted",
      firstName: "",
      lastName: "",
      phone: null,
      dateOfBirth: null,
      pendingEmail: null,
      marketingConsent: { granted: false, source: "account" },
    });
    expect(res.body.customer.email).toMatch(/^[0-9a-f]{64}@deleted\.invalid$/);
    expect(res.body.stats).toMatchObject({
      bookingsCount: 1,
      totalSpent: { amount: "110.47", currency: "EUR" },
    });
    // The booking is a record the deletion keeps; its customer is shown without a name.
    expect(res.body.recentBookings).toHaveLength(1);
    expect(res.body.recentBookings[0]).toMatchObject({
      id: bookingId,
      customer: { id: deleted.id, firstName: null, lastName: null },
    });
    expectNoKeptData(res);
  });
});

describe("console.customers.list: search and filters", () => {
  let elodie: SeededCustomer;
  let lukasz: SeededCustomer;
  let joerg: SeededCustomer;
  let pending: SeededCustomer;
  let disabled: SeededCustomer;
  let withBooking: SeededCustomer;

  beforeAll(async () => {
    elodie = await seedCustomer({
      firstName: "Élodie",
      lastName: "Ångström",
      local: "elodie",
      createdAgoMs: 30 * DAY,
    });
    joerg = await seedCustomer({
      firstName: "Jörg",
      lastName: "Straußberger",
      local: "joerg",
      createdAgoMs: 2 * DAY,
    });
    lukasz = await seedCustomer({
      firstName: "Łukasz",
      lastName: "Øster",
      local: "lukasz",
      createdAgoMs: 20 * DAY,
    });
    pending = await seedCustomer({
      firstName: "Pia",
      lastName: "Pending",
      local: "pending",
      status: "pending_verification",
      verified: false,
      createdAgoMs: 10 * DAY,
    });
    disabled = await seedCustomer({
      firstName: "Dora",
      lastName: "Disabled",
      local: "disabled",
      status: "disabled",
    });
    withBooking = await seedCustomer({
      firstName: "Bea",
      lastName: "Booker",
      local: "booker",
      createdAgoMs: 5 * DAY,
    });
    await seedBooking({ customerId: withBooking.id });
    // Only a live booking and a failed one: no booking in the test environment's statistics.
    await seedBooking({ customerId: lukasz.id, environment: "live" });
    await seedBooking({ customerId: lukasz.id, status: "failed" });
  }, BLOCK_SETUP_TIMEOUT_MS);

  const list = (query: string) => staff("finance").get(`${CUSTOMERS}?q=${RUN}&limit=100&${query}`);
  const listIds = async (query: string): Promise<string[]> => ids(customerPage(await list(query)));

  it("searches by e-mail and name prefixes, any case or accent, and by exact e-mail", async () => {
    const search = async (q: string) =>
      ids(customerPage(await staff("finance").get(`${CUSTOMERS}?q=${encodeURIComponent(q)}&limit=100`)));

    expect(await search(`${RUN}.ELO`)).toEqual([elodie.id]);
    expect(await search("elod")).toContain(elodie.id);
    expect(await search("ANGST")).toContain(elodie.id);
    expect(await search("ångs")).toContain(elodie.id);
    expect(await search("lukas")).toContain(lukasz.id);
    expect(await search("oste")).toContain(lukasz.id);
    expect(await search("ster")).not.toContain(lukasz.id); // a prefix, not a substring
    // `ß` as typed, as `ss` and in capitals: the names are folded as the search is.
    for (const q of ["Straußb", "strauss", "STRAUSSBERGER", "jorg"]) {
      expect(await search(q)).toEqual([joerg.id]);
    }
    expect(await search("%_")).toEqual([]); // wildcards are text
    const exact = await staff("finance").get(
      `${CUSTOMERS}?email=${encodeURIComponent(elodie.email.toUpperCase())}`,
    );
    expect(ids(customerPage(exact))).toEqual([elodie.id]);
  });

  it("filters by status (pending verification counts as active), verification, bookings and sign-up time", async () => {
    expect(await listIds("")).toEqual(expect.arrayContaining([elodie.id, pending.id, disabled.id]));
    expect(await listIds("status=disabled")).toEqual([disabled.id]);
    const pendingRow = customerPage(await list("emailVerified=false")).data;
    expect(pendingRow.map((row) => row.id)).toEqual([pending.id]);
    expect(pendingRow[0]).toMatchObject({ status: "active", emailVerified: false });
    const verified = await listIds("emailVerified=true");
    expect(verified).toEqual(expect.arrayContaining([elodie.id, lukasz.id, disabled.id]));
    expect(verified).not.toContain(pending.id);
    expect(await listIds("hasBookings=true")).toEqual([withBooking.id]);
    expect(await listIds("hasBookings=false")).toContain(lukasz.id);
    const from = new Date(Date.now() - 25 * DAY).toISOString();
    const to = new Date(Date.now() - 7 * DAY).toISOString();
    expect(new Set(await listIds(`createdFrom=${from}&createdTo=${to}`))).toEqual(
      new Set([lukasz.id, pending.id]),
    );
  });

  it("is not audited when served, and every role may list", async () => {
    const before = await staffActionCount();
    for (const role of ["owner", "agent", "finance", "viewer"] as const) {
      expect(answer(await staff(role).get(`${CUSTOMERS}?q=${RUN}`))).toEqual([200, undefined]);
    }
    expect(await staffActionCount()).toBe(before);
  });
});

describe("console.customers: statistics, sorts and cursors", () => {
  let big: SeededCustomer;
  let small: SeededCustomer;
  let none: SeededCustomer;
  /** A customer with 12 bookings, and its bookings, oldest first. */
  let busy: SeededCustomer;
  const busyBookings: string[] = [];
  /** The bookings of `big`. */
  const bigBookings: Record<string, string> = {};

  beforeAll(async () => {
    big = await seedCustomer({
      firstName: "Anna",
      lastName: "Zeta",
      local: "stats-big",
      createdAgoMs: 3 * DAY,
    });
    small = await seedCustomer({
      firstName: "Bruno",
      lastName: "Alpha",
      local: "stats-small",
      createdAgoMs: 2 * DAY,
    });
    none = await seedCustomer({
      firstName: "Carla",
      lastName: "Mid",
      local: "stats-none",
      createdAgoMs: DAY,
    });
    // big: an upcoming confirmed trip paid 100.00, a cancelled one paid 50.00 and refunded 30.00, a failed attempt, a
    // past trip paid in USD (not converted, left out of the totals) and a live booking (another environment).
    bigBookings["upcoming"] = await seedBooking({ customerId: big.id, createdAgoMs: 3 * DAY });
    await seedPayment(bigBookings["upcoming"], { captured: "100.00" });
    bigBookings["cancelled"] = await seedBooking({
      customerId: big.id,
      status: "cancelled",
      createdAgoMs: 2 * DAY,
    });
    await seedPayment(bigBookings["cancelled"], { captured: "50.00", refunded: "30.00" });
    bigBookings["failed"] = await seedBooking({ customerId: big.id, status: "failed", createdAgoMs: HOUR });
    await seedPayment(bigBookings["failed"], { captured: "0.00", status: "failed" });
    bigBookings["past"] = await seedBooking({
      customerId: big.id,
      status: "ticketed",
      createdAgoMs: 20 * DAY,
      arrivalInMs: -5 * DAY,
      currency: "USD",
    });
    await seedPayment(bigBookings["past"], { captured: "70.00", currency: "USD" });
    const live = await seedBooking({ customerId: big.id, environment: "live" });
    await seedPayment(live, { captured: "999.00", environment: "live" });
    // small: one booking paid 20.00, created after big's last counted one.
    const smallBooking = await seedBooking({ customerId: small.id, createdAgoMs: DAY });
    await seedPayment(smallBooking, { captured: "20.00" });
    // big's sessions: one live family (its rotated generation and its current one), a revoked one, an ended one.
    const family = await seedSession(big.id, { rotated: true });
    await seedSession(big.id, { familyId: family });
    await seedSession(big.id, { revoked: true });
    await seedSession(big.id, { endedAgoMs: MINUTE });
    await seedSavedTraveler(big.id);
    await seedSavedTraveler(big.id);
    busy = await seedCustomer({ firstName: "Dana", lastName: "Busy", local: "busy" });
    for (let index = 0; index < 12; index += 1) {
      busyBookings.push(await seedBooking({ customerId: busy.id, createdAgoMs: (12 - index) * MINUTE }));
    }
  }, BLOCK_SETUP_TIMEOUT_MS);

  const statsQuery = `q=${RUN}.stats&limit=100`;

  it("computes the statistics from the environment's bookings and the payments in the OTA's currency", async () => {
    const page = customerPage(await staff("owner").get(`${CUSTOMERS}?${statsQuery}`));
    const byId = new Map(page.data.map((row) => [row.id, row]));

    expect(byId.get(big.id)).toMatchObject({
      bookingsCount: 3,
      upcomingBookingsCount: 1,
      totalSpent: { amount: "120.00", currency: "EUR" },
    });
    // The last counted booking is the cancelled one, two days ago (the failed attempt does not count).
    const lastBookingAt = Date.parse(String(byId.get(big.id)?.["lastBookingAt"]));
    expect(Math.abs(lastBookingAt - (Date.now() - 2 * DAY))).toBeLessThan(HOUR);
    expect(byId.get(small.id)).toMatchObject({
      bookingsCount: 1,
      totalSpent: { amount: "20.00", currency: "EUR" },
    });
    expect(byId.get(none.id)).toMatchObject({
      bookingsCount: 0,
      upcomingBookingsCount: 0,
      totalSpent: null,
      lastBookingAt: null,
    });
  });

  it("answers an account with its statistics, its bookings of the environment, newest first, and its counts", async () => {
    const res = await staff("owner").get(`${CUSTOMERS}/${big.id}`);

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetCustomer", res);
    expect(res.body.customer).toMatchObject({
      id: big.id,
      firstName: "Anna",
      lastName: "Zeta",
      status: "active",
    });
    expect(res.body.stats).toMatchObject({
      bookingsCount: 3,
      upcomingBookingsCount: 1,
      cancelledBookingsCount: 1,
      totalSpent: { amount: "120.00", currency: "EUR" },
      totalRefunded: { amount: "30.00", currency: "EUR" },
    });
    expect((res.body.recentBookings as Summary[]).map((booking) => booking.id)).toEqual([
      bigBookings["failed"],
      bigBookings["cancelled"],
      bigBookings["upcoming"],
      bigBookings["past"],
    ]);
    expect(res.body.recentBookings[0]).toMatchObject({
      customer: { id: big.id, firstName: "Anna", lastName: "Zeta" },
      environment: "test",
    });
    expect(res.body).toMatchObject({ savedTravelersCount: 2, activeSessionsCount: 1 });
  });

  it("shows the 10 most recent bookings at most", async () => {
    const res = await staff("owner").get(`${CUSTOMERS}/${busy.id}`);

    expect(answer(res)).toEqual([200, undefined]);
    expect((res.body.recentBookings as Summary[]).map((booking) => booking.id)).toEqual(
      [...busyBookings].reverse().slice(0, 10),
    );
    expect(res.body.stats).toMatchObject({ bookingsCount: 12, upcomingBookingsCount: 12 });
  });

  /** Every page of a list of `query`, `limit` rows at a time, and the cursors it was read with. */
  async function allPages(query: string, limit: number): Promise<{ ids: string[]; cursors: string[] }> {
    const seen: string[] = [];
    const cursors: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const suffix: string = cursor === null ? "" : `&cursor=${cursor}`;
      const body = customerPage(await staff("owner").get(`${CUSTOMERS}?${query}&limit=${limit}${suffix}`));
      seen.push(...ids(body));
      cursor = body.page.nextCursor;
      if (cursor === null) {
        return { ids: seen, cursors };
      }
      cursors.push(cursor);
    }
    throw new Error("more than 20 pages");
  }

  it("sorts by name, last booking and total spent, page by page, with cursors that carry no name", async () => {
    const query = `q=${RUN}.stats`;
    const byName = await allPages(`${query}&sort=name`, 1);
    expect(byName.ids).toEqual([small.id, none.id, big.id]); // Alpha, Mid, Zeta
    for (const cursor of byName.cursors) {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      for (const name of ["Alpha", "alpha", "Mid", "mid", "Zeta", "zeta"]) {
        expect(decoded).not.toContain(name);
      }
    }
    // small booked after big's last counted booking; none has no booking and comes last.
    expect((await allPages(`${query}&sort=-lastBooking`, 1)).ids).toEqual([small.id, big.id, none.id]);
    expect((await allPages(`${query}&sort=-totalSpent`, 2)).ids).toEqual([big.id, small.id, none.id]);
    expect((await allPages(`${query}&sort=created`, 2)).ids).toEqual([big.id, small.id, none.id]);
    expect((await allPages(query, 1)).ids).toEqual([none.id, small.id, big.id]);
  });

  it("refuses a cursor of other filters or another sort", async () => {
    const first = customerPage(await staff("owner").get(`${CUSTOMERS}?q=${RUN}.stats&sort=name&limit=1`));
    const cursor = first.page.nextCursor ?? "";

    for (const query of [`q=${RUN}.stat&sort=name`, `q=${RUN}.stats&sort=created`, `q=${RUN}.stats`]) {
      const res = await staff("owner").get(`${CUSTOMERS}?${query}&limit=1&cursor=${cursor}`);
      expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
      expect(res.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/query/cursor" })]);
    }
  });
});

describe("console.customers.get: the audited read", () => {
  let customer: SeededCustomer;

  beforeAll(async () => {
    customer = await seedCustomer({
      firstName: "Viktor",
      lastName: "Viewed",
      local: "viewed",
      phone: { countryCode: "46", number: "701234567" },
      dateOfBirth: "1988-04-12",
    });
  }, BLOCK_SETUP_TIMEOUT_MS);

  it("writes customer.view with the customer, the staff member and the forwarded IP and user agent", async () => {
    const agent = staff("agent");
    const res = await agent.get(`${CUSTOMERS}/${customer.id}`);

    expect(answer(res)).toEqual([200, undefined]);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.customer).toMatchObject({
      phone: { countryCallingCode: "46", number: "701234567" },
      dateOfBirth: "1988-04-12",
    });
    expect(await staffActionsOn(customer.id)).toEqual([
      {
        action: "customer.view",
        outcome: "succeeded",
        actor_type: "staff",
        staff_id: agent.member.staffId,
        staff_role: "agent",
        target_type: "customer",
        target_id: customer.id,
        ip_address: agent.ip,
        user_agent: agent.userAgent,
        before: null,
        after: null,
      },
    ]);
  });

  it("answers 404 for an unknown customer, recorded as a failed call", async () => {
    const unknown = newId("cus");
    const res = await staff("viewer").get(`${CUSTOMERS}/${unknown}`);

    expect(answer(res)).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("consoleGetCustomer", res);
    expect(await staffActionsOn(unknown)).toEqual([
      expect.objectContaining({ action: "customers.get", outcome: "failed", target_type: "customer" }),
    ]);
  });
});

// ---- console.supplierRequests.list ---------------------------------------------------------------------------------

describe("console.supplierRequests.list: redaction", () => {
  const documentNumber = newDocumentNumber();
  const legacyDocumentNumber = newDocumentNumber();
  let bookingId: string;
  let written: string;
  let legacy: string;

  beforeAll(async () => {
    bookingId = await seedBooking({ customerId: null });
    // The create-order call of an airline-card checkout as the client records it: the writer redacts the copy.
    written = await writeCall(
      {
        bookingId,
        requestBody: {
          data: {
            type: "flight-order",
            travelers: [
              {
                id: "1",
                name: { firstName: "ANNA", lastName: "BERG" },
                documents: [{ documentType: "PASSPORT", number: documentNumber, expiryDate: "2034-02-01" }],
                contact: {
                  emailAddress: "anna.berg@example.com",
                  phones: [{ deviceType: "MOBILE", countryCallingCode: "34", number: "612345678" }],
                },
              },
            ],
            formOfPayments: [
              {
                creditCard: {
                  brand: "VISA",
                  holder: CARD_HOLDER,
                  number: PAN,
                  expiryDate: CARD_EXPIRY,
                  securityCode: CARD_CVV,
                  flightOfferIds: ["1"],
                },
              },
            ],
          },
        },
        responseBody: {
          data: { id: "eJzTd9cPNfX09DUFAAsGAkQ", formOfIdentifications: [{ number: documentNumber }] },
        },
      },
      { agoMs: 2 * MINUTE },
    );
    // A row of before FIX-W26-SECURITY and FIX-W29-SECURITY, within the 90 days rows are kept: the card's holder and
    // expiry stored next to its last 4, and a form of identification's number in full.
    legacy = newId("sreq");
    await alphaTx((trx) =>
      trx
        .insertInto("supplier_requests")
        .values({
          id: legacy,
          environment: "test",
          operation: "console.bookings.issue",
          amadeus_api: "FlightOrderIssue",
          amadeus_operation_id: "issueFlightOrder",
          http_method: "POST",
          path: "/v1/booking/flight-orders/eJzTd9cPNfX09DUFAAsGAkQ/issuance",
          outcome: "success",
          http_status: 200,
          booking_id: bookingId,
          request_body: JSON.stringify({
            data: {
              formOfPayments: [
                {
                  creditCard: { brand: "VISA", number: "1111", holder: CARD_HOLDER, expiryDate: CARD_EXPIRY },
                },
              ],
            },
          }),
          response_body: JSON.stringify({
            data: {
              formOfIdentifications: [{ identificationType: "PASSPORT", number: legacyDocumentNumber }],
            },
          }),
          created_at: new Date(Date.now() - MINUTE),
        })
        .execute(),
    );
  }, BLOCK_SETUP_TIMEOUT_MS);

  /** Values that must never appear in an answer: the card number (or its first 12 digits), holder, expiry, code. */
  function expectNoCardOrDocument(res: Response): void {
    const text = textOf(res);
    for (const value of [
      PAN,
      PAN.slice(0, 12),
      PAN.slice(-12),
      CARD_HOLDER,
      CARD_EXPIRY,
      documentNumber,
      legacyDocumentNumber,
    ]) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain(`"${CARD_CVV}"`);
    expect(text).not.toContain("securityCode");
    expect(text).not.toContain("anna.berg@example.com");
    expect(text).not.toContain("612345678");
  }

  it("[OBE-066 AC2] never shows a full card number or document number of the seeded redacted rows", async () => {
    const res = await staff("agent").get(`${SUPPLIER_LOG}?bookingId=${bookingId}&includeBodies=true`);
    const page = logPage(res);

    expect(ids(page)).toEqual([legacy, written]);
    const call = page.data[1] as unknown as JsonObject & {
      requestBody: { data: { formOfPayments: JsonObject[]; travelers: JsonObject[] } };
      responseBody: { data: { formOfIdentifications: JsonObject[] } };
    };
    expect(call).toMatchObject({
      redacted: true,
      truncated: false,
      bookingId,
      amadeusApi: "FlightCreateOrders",
    });
    // What is shown of the card and the documents: the last 4 only.
    expect(call.requestBody.data.formOfPayments).toEqual([
      { creditCard: { brand: "VISA", number: PAN.slice(-4), flightOfferIds: ["1"] } },
    ]);
    expect(call.requestBody.data.travelers[0]).toMatchObject({
      documents: [{ documentType: "PASSPORT", number: documentNumber.slice(-4) }],
    });
    expect(call.responseBody.data.formOfIdentifications).toEqual([{ number: documentNumber.slice(-4) }]);
    expectNoCardOrDocument(res);
  });

  it("[OBE-066 AC2] keeps a legacy row's card holder, expiry and full document number out of the answer", async () => {
    const res = await staff("finance").get(
      `${SUPPLIER_LOG}?bookingId=${bookingId}&includeBodies=true&limit=1`,
    );
    const page = logPage(res);

    expect(ids(page)).toEqual([legacy]);
    expect(page.data[0]).toMatchObject({
      requestBody: { data: { formOfPayments: [{ creditCard: { brand: "VISA", number: "1111" } }] } },
      responseBody: {
        data: {
          formOfIdentifications: [{ identificationType: "PASSPORT", number: legacyDocumentNumber.slice(-4) }],
        },
      },
    });
    expectNoCardOrDocument(res);
  });

  it("answers the bodies only with includeBodies, and at most 20 rows a page then", async () => {
    const res = await staff("agent").get(`${SUPPLIER_LOG}?bookingId=${bookingId}`);
    const page = logPage(res);

    expect(ids(page)).toEqual([legacy, written]);
    for (const row of page.data) {
      expect(row).not.toHaveProperty("requestBody");
      expect(row).not.toHaveProperty("responseBody");
    }
    const tooMany = await staff("agent").get(`${SUPPLIER_LOG}?includeBodies=true&limit=21`);
    expect(answer(tooMany)).toEqual([400, "VALIDATION_FAILED"]);
    expect(tooMany.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/query/limit" })]);
    expect(answer(await staff("agent").get(`${SUPPLIER_LOG}?limit=100`))).toEqual([200, undefined]);
  });
});

describe("console.supplierRequests.list: filters, environment and pages", () => {
  const requestId = `req_${randomBytes(8).toString("hex")}`;
  const correlationId = `0004${randomBytes(6).toString("hex").toUpperCase()}`;
  let bookingId: string;
  let otherBookingId: string;
  let searchId: string;
  let staffId: string;
  const calls: Record<string, string> = {};
  /** The instant the calls are dated from (the time filter's bounds are too, so the test never races the clock). */
  let base: number;

  beforeAll(async () => {
    bookingId = await seedBooking({ customerId: null });
    otherBookingId = await seedBooking({ customerId: null });
    // The flight search the search call was made for (`supplier_requests.search_id` references it).
    searchId = newId("srch");
    await alphaTx((trx) =>
      trx
        .insertInto("flight_searches")
        .values({
          id: searchId,
          environment: "test",
          criteria: JSON.stringify({}),
          amadeus_request: JSON.stringify({}),
          expires_at: new Date(Date.now() + HOUR),
        })
        .execute(),
    );
    staffId = staff("agent").member.staffId;
    base = Date.now();
    calls["search"] = await writeCall(
      {
        operation: "flights.search",
        amadeusApi: "FlightOffersSearch",
        amadeusOperationId: "searchFlightOffers",
        path: "/v2/shopping/flight-offers",
        requestId,
        bookingId,
        searchId,
      },
      { agoMs: 5 * MINUTE, base },
    );
    calls["issue"] = await writeCall(
      {
        operation: "console.bookings.issue",
        amadeusApi: "FlightOrderIssue",
        amadeusOperationId: "issueFlightOrder",
        path: "/v1/booking/flight-orders/eJzT/issuance",
        httpStatus: 400,
        outcome: "client_error",
        errorCodes: [9112, 477],
        correlationId,
        staffId,
        bookingId,
      },
      { agoMs: 4 * MINUTE, base },
    );
    calls["timeout"] = await writeCall(
      {
        operation: "bookings.sync",
        amadeusApi: "FlightOrderManagement",
        amadeusOperationId: "getFlightOrder",
        httpMethod: "GET",
        path: "/v1/booking/flight-orders/eJzT",
        httpStatus: null,
        outcome: "timeout",
        bookingId,
      },
      { agoMs: 3 * MINUTE, base },
    );
    calls["other"] = await writeCall({ bookingId: otherBookingId, requestId }, { agoMs: 2 * MINUTE, base });
    calls["live"] = await writeCall({ environment: "live", bookingId, requestId }, { agoMs: MINUTE, base });
  }, BLOCK_SETUP_TIMEOUT_MS);

  const log = (query: string) => staff("owner").get(`${SUPPLIER_LOG}?${query}`);
  const logIds = async (query: string): Promise<string[]> => ids(logPage(await log(query)));

  it("filters by booking, search, API, operation, outcome, status, error code, staff, request and correlation ids", async () => {
    expect(await logIds(`bookingId=${bookingId}`)).toEqual([
      calls["timeout"],
      calls["issue"],
      calls["search"],
    ]);
    expect(await logIds(`searchId=${searchId}`)).toEqual([calls["search"]]);
    expect(await logIds(`bookingId=${bookingId}&amadeusApi=FlightOrderIssue,FlightOffersSearch`)).toEqual([
      calls["issue"],
      calls["search"],
    ]);
    expect(await logIds(`bookingId=${bookingId}&amadeusOperationId=getFlightOrder`)).toEqual([
      calls["timeout"],
    ]);
    expect(await logIds(`bookingId=${bookingId}&outcome=client_error,timeout`)).toEqual([
      calls["timeout"],
      calls["issue"],
    ]);
    expect(await logIds(`bookingId=${bookingId}&httpStatus=400`)).toEqual([calls["issue"]]);
    expect(await logIds(`errorCode=477`)).toEqual([calls["issue"]]);
    expect(await logIds(`staffId=${staffId}`)).toEqual([calls["issue"]]);
    expect(await logIds(`correlationId=${correlationId}`)).toEqual([calls["issue"]]);
    // The live call of the same request is never shown in the test environment.
    expect(await logIds(`requestId=${requestId}`)).toEqual([calls["other"], calls["search"]]);
  });

  it("filters by call time", async () => {
    const from = new Date(base - 4.5 * MINUTE).toISOString();
    const to = new Date(base - 2.5 * MINUTE).toISOString();
    expect(await logIds(`bookingId=${bookingId}&createdFrom=${from}&createdTo=${to}`)).toEqual([
      calls["timeout"],
      calls["issue"],
    ]);
  });

  it("pages newest first with a cursor bound to the filters", async () => {
    const first = logPage(await log(`bookingId=${bookingId}&limit=2`));
    expect(ids(first)).toEqual([calls["timeout"], calls["issue"]]);
    const cursor = first.page.nextCursor ?? "";
    const second = logPage(await log(`bookingId=${bookingId}&limit=2&cursor=${cursor}`));
    expect(ids(second)).toEqual([calls["search"]]);
    expect(second.page.nextCursor).toBeNull();
    // includeBodies changes the rows' content, not the page: the same cursor serves.
    expect(
      ids(logPage(await log(`bookingId=${bookingId}&limit=2&includeBodies=true&cursor=${cursor}`))),
    ).toEqual([calls["search"]]);

    const refused = await log(`bookingId=${otherBookingId}&limit=2&cursor=${cursor}`);
    expect(answer(refused)).toEqual([400, "VALIDATION_FAILED"]);
    expect(refused.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/query/cursor" })]);
  });

  it("is refused to a viewer with a denied row, and not audited when served", async () => {
    const before = await staffActionCount();
    expect(answer(await log(`bookingId=${bookingId}`))).toEqual([200, undefined]);
    expect(await staffActionCount()).toBe(before);

    const viewer = staff("viewer");
    const refused = await viewer.get(`${SUPPLIER_LOG}?bookingId=${bookingId}`);
    expect(answer(refused)).toEqual([403, "FORBIDDEN"]);
    expectResponseToMatch("consoleListSupplierRequests", refused);
    expect(refused.body.error.details).toMatchObject({ requiredPermission: "supplier_requests:read" });
    const rows = await alphaTx((trx) =>
      trx
        .selectFrom("staff_actions")
        .select(["action", "outcome", "staff_id"])
        .where("staff_id", "=", viewer.member.staffId)
        .where("action", "=", "supplierRequests.list")
        .execute(),
    );
    expect(rows).toEqual([
      { action: "supplierRequests.list", outcome: "denied", staff_id: viewer.member.staffId },
    ]);
  });
});

// ---- Tenants and environments --------------------------------------------------------------------------------------

describe("console customers and supplier log: tenants and environments", () => {
  const requestId = `req_${randomBytes(8).toString("hex")}`;
  const isolationQuery = `q=${RUN}.iso&status=active,disabled,deleted&limit=100`;
  let alphaCustomer: SeededCustomer;
  let betaCustomer: SeededCustomer;
  let betaTestBooking: string;
  let betaLiveBooking: string;
  const calls: Record<string, string> = {};
  /** Agents of beta (a live tenant) in each environment. */
  let betaTest: AdminSession;
  let betaLive: AdminSession;

  beforeAll(async () => {
    alphaCustomer = await seedCustomer({ firstName: "Alma", lastName: "Alphason", local: "iso-alpha" });
    betaCustomer = await seedCustomer({
      schema: "tenant_beta",
      firstName: "Bert",
      lastName: "Betason",
      local: "iso-beta",
    });
    // Accounts are shared by test and live; their bookings and payments are not.
    betaTestBooking = await seedBooking({
      schema: "tenant_beta",
      customerId: betaCustomer.id,
      createdAgoMs: HOUR,
    });
    await seedPayment(betaTestBooking, { schema: "tenant_beta", captured: "40.00" });
    betaLiveBooking = await seedBooking({
      schema: "tenant_beta",
      customerId: betaCustomer.id,
      environment: "live",
    });
    await seedPayment(betaLiveBooking, { schema: "tenant_beta", captured: "300.00", environment: "live" });
    calls["alpha"] = await writeCall({ requestId }, { agoMs: 3 * MINUTE });
    calls["betaTest"] = await writeCall({ requestId }, { agoMs: 2 * MINUTE, schema: "tenant_beta" });
    calls["betaLive"] = await writeCall(
      { requestId, environment: "live" },
      { agoMs: MINUTE, schema: "tenant_beta" },
    );
    betaTest = await new AdminSession(await insertMember("agent", betaId), "test").signIn();
    betaLive = await new AdminSession(await insertMember("agent", betaId), "live").signIn();
  }, BLOCK_SETUP_TIMEOUT_MS);

  it("never shows another tenant's customers or Amadeus calls", async () => {
    const alpha = staff("agent");

    expect(ids(customerPage(await alpha.get(`${CUSTOMERS}?${isolationQuery}`)))).toEqual([alphaCustomer.id]);
    expect(ids(customerPage(await betaTest.get(`${CUSTOMERS}?${isolationQuery}`)))).toEqual([
      betaCustomer.id,
    ]);
    for (const [session, other] of [
      [alpha, betaCustomer],
      [betaTest, alphaCustomer],
    ] as const) {
      const res = await session.get(`${CUSTOMERS}/${other.id}`);
      expect(answer(res)).toEqual([404, "NOT_FOUND"]);
      expectResponseToMatch("consoleGetCustomer", res);
      expect(textOf(res)).not.toContain(other.email);
    }

    expect(ids(logPage(await alpha.get(`${SUPPLIER_LOG}?requestId=${requestId}`)))).toEqual([calls["alpha"]]);
    expect(ids(logPage(await betaTest.get(`${SUPPLIER_LOG}?requestId=${requestId}`)))).toEqual([
      calls["betaTest"],
    ]);
  });

  it("shows the account in either environment with the statistics, bookings and calls of the request's", async () => {
    const inTest = await betaTest.get(`${CUSTOMERS}/${betaCustomer.id}`);
    const inLive = await betaLive.get(`${CUSTOMERS}/${betaCustomer.id}`);

    for (const res of [inTest, inLive]) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("consoleGetCustomer", res);
      expect(res.body.customer).toMatchObject({
        id: betaCustomer.id,
        firstName: "Bert",
        lastName: "Betason",
      });
    }
    expect(inTest.body.stats).toMatchObject({
      bookingsCount: 1,
      totalSpent: { amount: "40.00", currency: "EUR" },
    });
    expect((inTest.body.recentBookings as Summary[]).map((booking) => booking.id)).toEqual([betaTestBooking]);
    expect(inLive.body.stats).toMatchObject({
      bookingsCount: 1,
      totalSpent: { amount: "300.00", currency: "EUR" },
    });
    expect((inLive.body.recentBookings as Summary[]).map((booking) => booking.id)).toEqual([betaLiveBooking]);
    expect(customerPage(await betaLive.get(`${CUSTOMERS}?${isolationQuery}`)).data).toEqual([
      expect.objectContaining({ id: betaCustomer.id, totalSpent: { amount: "300.00", currency: "EUR" } }),
    ]);

    expect(ids(logPage(await betaLive.get(`${SUPPLIER_LOG}?requestId=${requestId}`)))).toEqual([
      calls["betaLive"],
    ]);
  });
});
