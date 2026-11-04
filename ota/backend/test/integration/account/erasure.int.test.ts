// `customers.erase` against PostgreSQL 16 and Redis 7 (OBE-087; db README §7 "End-customer erasure inside a tenant",
// ota/docs/data-model.md §6, OADR-0014 points 2, 4 and 5). The worker's module graph runs in-process
// (WorkerModule.forRoot, as dist/worker.js builds it) on a clone of the @velexis/testing template (`tenant_alpha` and
// `tenant_beta` provisioned) and a Redis database of its own: the `ota-maintenance` consumer with the fan-out, the
// runner and the erasure's handler, which JobsModule provides.
//
// The file plays the platform (velexis_migrator: alpha `active`, beta `suspended`) and the API (`tenantTx` as
// velexis_ota_app: customers as sign-up and account.delete leave them, with their identities, sessions, reset
// tokens, consents, preferences and saved travellers, and the searches, checkouts, bookings, payments, refunds,
// events and e-mails of their trips). It removes the schedulers the worker registered at start-up and plays the
// scheduler instead: each run adds a `fan-out` job with the `prevMillis` of an iteration due at the FakeClock's minute,
// as BullMQ's scheduler adds them, and waits for the per-tenant jobs, whose ids it knows. The erasure reads the time
// from `Clock`, which the file points at its FakeClock; the clock only moves forward, a minute or more between runs, so
// every run has a bucket of its own. Each scenario does its work in its `beforeAll` hook, with a budget of its own; its
// tests read what it left. Names, addresses and numbers are made up per run; nothing is a real person's.
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
} from "@velexis/db";
import { createTestDatabase, FakeClock, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import type { Job, Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ERASURE_DUE_AFTER_MS } from "../../../src/account/account.mapper";
import { CUSTOMERS_ERASE_JOB } from "../../../src/account/erasure.processor";
import { ERASURE_BATCH, type ErasureCounts } from "../../../src/account/erasure.service";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import { minuteBucket, tenantJobId, type TenantJobResult } from "../../../src/jobs/fan-out";
import { FAN_OUT_JOB } from "../../../src/jobs/schedulers";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { testWorkerVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

/**
 * Cloning the template and starting the worker's graph (BullMQ connections, the scheduler registration): a few seconds
 * alone, more while every package's integration tests run on a 4-CPU CI runner. The bound only stops a hang.
 */
const SETUP_TIMEOUT_MS = 90_000;
/**
 * A scenario writes its rows, runs one or two iterations and waits for the worker each time; the bound only stops a
 * hang.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/**
 * How long a scenario waits at most for one job of the worker (an erasure takes milliseconds, a batch of 100 about a
 * second).
 */
const WAIT_MS = 30_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const quietPoolLogger = { error: (): void => undefined };

type TenantKey = "alpha" | "beta";

let db: TestDatabase;
let redis: TestRedis;
let worker: INestApplicationContext;
const sink = new MemorySink();
let migratorPool: ReturnType<typeof createPool>;
/** velexis_migrator, the owner of the platform tables: inserts the tenants as the platform does. */
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
/** `tenantTx` as velexis_ota_app: writes the tenant rows as the API does. */
let tenantDb: TenantDb;
let maintenance: Queue;
const tenantIds: Record<TenantKey, string> = { alpha: "", beta: "" };
/** The priced offer every checkout and booking of a tenant is opened with. */
const pricedOfferIds: Record<TenantKey, string> = { alpha: "", beta: "" };

/** Tomorrow at this minute: the file's first run; the clock only moves forward from here. */
const BASE = new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS + DAY_MS);
const clock = new FakeClock(BASE);

const txOf =
  (tenant: TenantKey) =>
  <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
    tenantTx(tenantDb, `tenant_${tenant}`, run);

/** The clock's instant moved by `ms` (negative: in the past). */
const fromNow = (ms: number): Date => new Date(clock.now().getTime() + ms);
/** A fresh SHA-256-shaped hex value, as the token tables store hashes. */
const hash = (): string => randomBytes(32).toString("hex");
/** A fresh Stripe-shaped id of this run. */
const stripeId = (prefix: string): string => `${prefix}_test_${randomBytes(10).toString("hex")}`;
/** A fresh booking reference (`bookings.reference`: 6 to 10 upper-case letters and digits). */
const bookingReference = (): string => `VX${randomBytes(3).toString("hex").toUpperCase()}`;
/** A made-up word of this run: names and addresses that no log line may ever show. */
const madeUp = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

async function insertTenant(key: TenantKey, status: "active" | "suspended"): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status, plan_code: "early_access" })
    .execute();
  return id;
}

/** A search with one offer and its priced offer, valid for a year: what a checkout and a booking are opened with. */
async function insertPricedOffer(tenant: TenantKey): Promise<string> {
  const searchId = newId("srch");
  const offerId = newId("off");
  const pricedOfferId = newId("prc");
  const expires = fromNow(365 * DAY_MS);
  await txOf(tenant)(async (trx) => {
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
        net_total: "400.00",
        markup_amount: "40.00",
        selling_total: "440.00",
        first_departure_local: new Date(expires.getTime() - DAY_MS).toISOString().slice(0, 19),
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
        net_total: "400.00",
        markup_amount: "40.00",
        fee_amount: "0.00",
        selling_total: "440.00",
        expires_at: expires,
      })
      .execute();
  });
  return pricedOfferId;
}

// ---- Customers and their trips ----------------------------------------------------------------------------------

interface CustomerSeed {
  /** The id to use (another tenant's customer id, for the isolation case); a fresh one otherwise. */
  readonly id?: string;
  /** When account.delete deleted it, relative to the clock; `null`: an active customer. */
  readonly deletedInMs: number | null;
}

/** A seeded customer: its id, the values no log line may show, and the ids of the rows of its trip. */
interface SeededCustomer {
  readonly id: string;
  /** Names, the address it signed up with, the placeholder, the phone number. */
  readonly personalData: readonly string[];
  readonly searchId: string;
  readonly checkoutId: string;
  readonly bookingId: string;
  readonly paymentId: string;
  readonly refundId: string;
  readonly notificationId: string;
}

/**
 * A customer as sign-up, its use of the storefront and (when `deletedInMs` is given) account.delete leave it, in one
 * transaction: the customer, a password identity, a session, a reset token, two consent events, preferences, a saved
 * traveller with a document; a search, a completed checkout, a ticketed booking with a traveller, a contact and an
 * event, its captured and partly refunded Stripe payment, the refund, and the confirmation e-mail.
 */
async function seedCustomer(tenant: TenantKey, seed: CustomerSeed): Promise<SeededCustomer> {
  const id = seed.id ?? newId("cus");
  const firstName = madeUp("Ingrid");
  const lastName = madeUp("Halvorsen");
  const address = `${madeUp("traveller.")}@example.com`;
  const placeholder = `${hash()}@deleted.invalid`;
  const phone = `7700${String(randomBytes(3).readUIntBE(0, 3)).padStart(6, "0")}`;
  const deletedAt = seed.deletedInMs === null ? null : fromNow(seed.deletedInMs);
  const signedUpAt = fromNow(-400 * DAY_MS);
  const ids = {
    searchId: newId("srch"),
    checkoutId: newId("chk"),
    bookingId: newId("bkg"),
    paymentId: newId("pay"),
    refundId: newId("rfd"),
    notificationId: newId("ntf"),
  };
  await txOf(tenant)(async (trx) => {
    await trx
      .insertInto("customers")
      .values({
        id,
        email: deletedAt === null ? address : placeholder,
        email_verified_at: signedUpAt,
        first_name: firstName,
        last_name: lastName,
        date_of_birth: "1988-04-17",
        phone_country_code: "44",
        phone_number: phone,
        status: deletedAt === null ? "active" : "deleted",
        marketing_consent: false,
        deleted_at: deletedAt,
        created_at: signedUpAt,
        updated_at: deletedAt ?? signedUpAt,
      })
      .execute();
    const identityId = newId("cid");
    await trx
      .insertInto("customer_identities")
      .values({
        id: identityId,
        customer_id: id,
        provider: "password",
        provider_subject: deletedAt === null ? address : placeholder,
        password_hash: "argon2id-hash-of-a-made-up-password",
        email: deletedAt === null ? address : placeholder,
        email_verified_at: signedUpAt,
        disabled_at: deletedAt,
      })
      .execute();
    const sessionStart = fromNow(-(seed.deletedInMs === null ? 1 : 40) * DAY_MS);
    await trx
      .insertInto("customer_sessions")
      .values({
        id: newId("ses"),
        customer_id: id,
        identity_id: identityId,
        refresh_token_hash: hash(),
        family_id: newId("ses"),
        remember_me: true,
        family_expires_at: new Date(sessionStart.getTime() + 30 * DAY_MS),
        expires_at: new Date(sessionStart.getTime() + 30 * DAY_MS),
        user_agent: "Mozilla/5.0 (made up)",
        ip_address: "192.0.2.10",
        revoked_at: deletedAt,
        revoke_reason: deletedAt === null ? null : "account_deleted",
      })
      .execute();
    await trx
      .insertInto("customer_password_resets")
      .values({
        id: newId("pwr"),
        customer_id: id,
        token_hash: hash(),
        requested_ip: "192.0.2.10",
        expires_at: new Date(sessionStart.getTime() + HOUR_MS),
      })
      .execute();
    await trx
      .insertInto("customer_consents")
      .values([
        {
          id: newId("ccn"),
          customer_id: id,
          kind: "terms",
          policy_version: "2026-01",
          granted: true,
          source: "sign_up",
          created_at: signedUpAt,
          updated_at: signedUpAt,
        },
        {
          id: newId("ccn"),
          customer_id: id,
          kind: "marketing",
          policy_version: null,
          granted: false,
          source: "account",
        },
      ])
      .execute();
    await trx
      .insertInto("customer_preferences")
      .values({ id: newId("cpf"), customer_id: id, locale: "en", currency: "EUR", home_airport: "MAD" })
      .execute();
    const travelerId = newId("trv");
    await trx
      .insertInto("saved_travelers")
      .values({
        id: travelerId,
        customer_id: id,
        is_self: true,
        first_name: firstName,
        last_name: lastName,
        date_of_birth: "1988-04-17",
        email: address,
      })
      .execute();
    await trx
      .insertInto("saved_traveler_documents")
      .values({
        id: newId("tdc"),
        saved_traveler_id: travelerId,
        document_type: "PASSPORT",
        // Random bytes in place of a ciphertext: no document number exists anywhere in this file.
        number_ciphertext: randomBytes(48),
        encryption_key_id: "local:v1",
        number_last4: "0042",
        expiry_date: "2031-01-31",
        issuance_country: "NO",
      })
      .execute();
    await trx
      .insertInto("flight_searches")
      .values({
        id: ids.searchId,
        environment: "test",
        customer_id: id,
        criteria: JSON.stringify({
          mode: "simple",
          originLocationCode: "OSL",
          destinationLocationCode: "MAD",
        }),
        amadeus_request: JSON.stringify({ originLocationCode: "OSL", destinationLocationCode: "MAD" }),
        status: "completed",
        result_count: 1,
        expires_at: fromNow(365 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("checkouts")
      .values({
        id: ids.checkoutId,
        environment: "test",
        customer_id: id,
        is_guest: false,
        base_priced_offer_id: pricedOfferIds[tenant],
        priced_offer_id: pricedOfferIds[tenant],
        status: "completed",
        currency: "EUR",
        offer_amount: "440.00",
        total_amount: "440.00",
        expires_at: fromNow(-60 * DAY_MS),
        version: 4,
      })
      .execute();
    const departure = fromNow(-50 * DAY_MS);
    await trx
      .insertInto("bookings")
      .values({
        id: ids.bookingId,
        environment: "test",
        reference: bookingReference(),
        customer_id: id,
        checkout_id: ids.checkoutId,
        priced_offer_id: pricedOfferIds[tenant],
        status: "ticketed",
        ticketing_status: "issued",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 3 * HOUR_MS),
        currency: "EUR",
        net_amount: "400.00",
        markup_amount: "40.00",
        total_amount: "440.00",
        amount_paid: "440.00",
        amount_refunded: "40.00",
        contact_email: address,
        lead_last_name: lastName.toUpperCase(),
        version: 7,
        created_at: fromNow(-60 * DAY_MS),
        updated_at: fromNow(-55 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("booking_travelers")
      .values({
        id: newId("btr"),
        booking_id: ids.bookingId,
        amadeus_traveler_id: "1",
        traveler_type: "ADULT",
        first_name: firstName,
        last_name: lastName,
      })
      .execute();
    await trx
      .insertInto("booking_contacts")
      .values({ id: newId("bco"), booking_id: ids.bookingId, is_primary: true, email: address })
      .execute();
    await trx
      .insertInto("booking_events")
      .values({
        id: newId("evt"),
        booking_id: ids.bookingId,
        type: "booking.created",
        actor_type: "customer",
        actor_id: id,
        status_to: "confirmed",
      })
      .execute();
    await trx
      .insertInto("payments")
      .values({
        id: ids.paymentId,
        environment: "test",
        checkout_id: ids.checkoutId,
        booking_id: ids.bookingId,
        customer_id: id,
        provider: "stripe",
        provider_connection_id: newId("ppc"),
        provider_payment_id: stripeId("pi"),
        method: "card",
        capture_method: "manual",
        currency: "EUR",
        amount: "440.00",
        amount_authorized: "440.00",
        amount_captured: "440.00",
        amount_refunded: "40.00",
        status: "partially_refunded",
        card_brand: "VISA",
        card_last4: "4242",
        authorized_at: fromNow(-60 * DAY_MS),
        captured_at: fromNow(-60 * DAY_MS),
        metadata: JSON.stringify({ connection: { accountMode: "velexis", accountReference: null } }),
        version: 5,
      })
      .execute();
    await trx
      .insertInto("refunds")
      .values({
        id: ids.refundId,
        payment_id: ids.paymentId,
        booking_id: ids.bookingId,
        currency: "EUR",
        amount: "40.00",
        reason: "customer_request",
        status: "succeeded",
        provider_refund_id: stripeId("re"),
        requested_by_type: "customer",
        requested_by_id: id,
        processed_at: fromNow(-55 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("notifications")
      .values({
        id: ids.notificationId,
        template_key: "booking.confirmed",
        channel: "email",
        recipient: address,
        recipient_type: "customer",
        customer_id: id,
        booking_id: ids.bookingId,
        payload: JSON.stringify({ booking: { reference: "VXSAMPLE" } }),
        status: "sent",
        sent_at: fromNow(-60 * DAY_MS),
      })
      .execute();
  });
  return { id, personalData: [firstName, lastName, address, placeholder, phone], ...ids };
}

/**
 * A minimal deleted customer (the batch scenario): the row and its disabled identity, deleted `deletedInMs` from the
 * clock.
 */
async function insertDeletedCustomer(trx: TenantTransaction, deletedInMs: number): Promise<string> {
  const id = newId("cus");
  const placeholder = `${hash()}@deleted.invalid`;
  const deletedAt = fromNow(deletedInMs);
  await trx
    .insertInto("customers")
    .values({ id, email: placeholder, first_name: madeUp("Batch"), status: "deleted", deleted_at: deletedAt })
    .execute();
  await trx
    .insertInto("customer_identities")
    .values({
      id: newId("cid"),
      customer_id: id,
      provider: "password",
      provider_subject: placeholder,
      password_hash: "argon2id-hash-of-a-made-up-password",
      email: placeholder,
      disabled_at: deletedAt,
    })
    .execute();
  return id;
}

/** The customer's own rows, per table: what an erasure deletes. */
async function ownRowsOf(tenant: TenantKey, customerId: string): Promise<Record<string, number>> {
  return await txOf(tenant)(async (trx) => {
    const count = async (
      table:
        | "customer_identities"
        | "customer_sessions"
        | "customer_password_resets"
        | "customer_consents"
        | "customer_preferences"
        | "customer_data_exports"
        | "saved_travelers",
    ): Promise<number> => {
      const rows = await trx.selectFrom(table).select("id").where("customer_id", "=", customerId).execute();
      return rows.length;
    };
    const customers = await trx.selectFrom("customers").select("id").where("id", "=", customerId).execute();
    const documents = await trx
      .selectFrom("saved_traveler_documents as d")
      .innerJoin("saved_travelers as t", "t.id", "d.saved_traveler_id")
      .select("d.id")
      .where("t.customer_id", "=", customerId)
      .execute();
    return {
      customers: customers.length,
      identities: await count("customer_identities"),
      sessions: await count("customer_sessions"),
      passwordResets: await count("customer_password_resets"),
      consents: await count("customer_consents"),
      preferences: await count("customer_preferences"),
      dataExports: await count("customer_data_exports"),
      savedTravelers: await count("saved_travelers"),
      savedTravelerDocuments: documents.length,
    };
  });
}

/** Every column of the rows of a seeded customer's trip and of the customer itself, as the database holds them. */
async function recordsOf(tenant: TenantKey, seeded: SeededCustomer): Promise<Record<string, unknown>> {
  return await txOf(tenant)(async (trx) => ({
    customer: await trx.selectFrom("customers").selectAll().where("id", "=", seeded.id).executeTakeFirst(),
    search: await trx
      .selectFrom("flight_searches")
      .selectAll()
      .where("id", "=", seeded.searchId)
      .executeTakeFirstOrThrow(),
    checkout: await trx
      .selectFrom("checkouts")
      .selectAll()
      .where("id", "=", seeded.checkoutId)
      .executeTakeFirstOrThrow(),
    booking: await trx
      .selectFrom("bookings")
      .selectAll()
      .where("id", "=", seeded.bookingId)
      .executeTakeFirstOrThrow(),
    travelers: await trx
      .selectFrom("booking_travelers")
      .selectAll()
      .where("booking_id", "=", seeded.bookingId)
      .execute(),
    contacts: await trx
      .selectFrom("booking_contacts")
      .selectAll()
      .where("booking_id", "=", seeded.bookingId)
      .execute(),
    events: await trx
      .selectFrom("booking_events")
      .selectAll()
      .where("booking_id", "=", seeded.bookingId)
      .execute(),
    payment: await trx
      .selectFrom("payments")
      .selectAll()
      .where("id", "=", seeded.paymentId)
      .executeTakeFirstOrThrow(),
    refund: await trx
      .selectFrom("refunds")
      .selectAll()
      .where("id", "=", seeded.refundId)
      .executeTakeFirstOrThrow(),
    notification: await trx
      .selectFrom("notifications")
      .selectAll()
      .where("id", "=", seeded.notificationId)
      .executeTakeFirstOrThrow(),
  }));
}

/** What a seeded customer has before any erasure: one of each, two consent events, no data export. */
const SEEDED_OWN_ROWS = {
  customers: 1,
  identities: 1,
  sessions: 1,
  passwordResets: 1,
  consents: 2,
  preferences: 1,
  dataExports: 0,
  savedTravelers: 1,
  savedTravelerDocuments: 1,
};

/** What is left of an erased customer's own rows: nothing. */
const NO_OWN_ROWS = Object.fromEntries(Object.keys(SEEDED_OWN_ROWS).map((table) => [table, 0]));

// ---- The scheduler's side ---------------------------------------------------------------------------------------

/** Calls `check` every 25 ms until it returns a value other than `undefined`, at most WAIT_MS. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor: ${what} did not happen within ${WAIT_MS} ms`);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
}

/**
 * The job `id` of `ota-maintenance` once it has finished (completed or failed). The state is read first and the job
 * after it: BullMQ writes a job's result and moves it to its final set in one step.
 */
async function finished(id: string): Promise<Job> {
  return await waitFor(`the job ${id}`, async () => {
    const state = await maintenance.getJobState(id);
    return state === "completed" || state === "failed" ? await maintenance.getJob(id) : undefined;
  });
}

/** The per-tenant jobs of one run, by tenant. */
type RunJobs = Record<TenantKey, Job>;

/**
 * One `customers.erase` iteration due at the clock's minute: its `fan-out` job, then the per-tenant jobs of both
 * tenants (alpha `active`, beta `suspended`), whose ids the fan-out builds.
 */
async function iteration(): Promise<RunJobs> {
  const due = clock.now();
  const fanOut = await maintenance.add(
    FAN_OUT_JOB,
    { task: CUSTOMERS_ERASE_JOB },
    { prevMillis: due.getTime() },
  );
  await finished(fanOut.id ?? "");
  return {
    alpha: await finished(tenantJobId(CUSTOMERS_ERASE_JOB, tenantIds.alpha, minuteBucket(due))),
    beta: await finished(tenantJobId(CUSTOMERS_ERASE_JOB, tenantIds.beta, minuteBucket(due))),
  };
}

/** The result a per-tenant job completed with. */
function resultOf(job: Job): TenantJobResult {
  return job.returnvalue as TenantJobResult;
}

/** The counts of a job that erased `customers` seeded customers (each with one of each row) and nothing else. */
function seededCounts(customers: number): ErasureCounts {
  return {
    customers,
    failed: 0,
    checkoutsDetached: customers,
    bookingsDetached: customers,
    paymentsDetached: customers,
    savedTravelerDocuments: customers,
    savedTravelers: customers,
    preferences: customers,
    dataExports: 0,
    sessions: customers,
    passwordResets: customers,
    consents: 2 * customers,
    identities: customers,
  };
}

/** A completed per-tenant job's result with these counts. */
function done(tenant: TenantKey, counts: ErasureCounts, continued = false): TenantJobResult {
  return { task: CUSTOMERS_ERASE_JOB, tenantId: tenantIds[tenant], outcome: "done", counts, continued };
}

/** The `customer.erased` lines logged so far. */
const erasedLines = (): Record<string, unknown>[] =>
  sink.records().filter((record) => record["msg"] === "customer.erased");

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
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
  tenantIds.alpha = await insertTenant("alpha", "active");
  tenantIds.beta = await insertTenant("beta", "suspended");
  for (const tenant of ["alpha", "beta"] as const) {
    pricedOfferIds[tenant] = await insertPricedOffer(tenant);
  }

  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(WorkerModule.forRoot(config, { logger: createWorkerLogger(config, sink) }));
  await worker.init();
  maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  // From here on the file plays the scheduler: no iteration of the real ones may fire while it runs.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
}, SETUP_TIMEOUT_MS);

describe("customers.erase: who is erased, what goes and what stays", () => {
  /** Alpha: deleted 31 days ago, due. */
  let due: SeededCustomer;
  /** Alpha: deleted 29 days ago, not due yet. */
  let recent: SeededCustomer;
  /** Alpha: an active customer. */
  let active: SeededCustomer;
  /** Beta (suspended): deleted 31 days ago, due. */
  let suspendedDue: SeededCustomer;
  /** Beta: a customer with the id of alpha's due one, deleted 29 days ago: another tenant's row. */
  let twin: SeededCustomer;
  const before: Record<string, Record<string, unknown>> = {};
  const after: Record<string, Record<string, unknown>> = {};
  const ownBefore: Record<string, Record<string, number>> = {};
  const ownAfter: Record<string, Record<string, number>> = {};
  let run: RunJobs;

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    due = await seedCustomer("alpha", { deletedInMs: -31 * DAY_MS });
    recent = await seedCustomer("alpha", { deletedInMs: -29 * DAY_MS });
    active = await seedCustomer("alpha", { deletedInMs: null });
    suspendedDue = await seedCustomer("beta", { deletedInMs: -31 * DAY_MS });
    twin = await seedCustomer("beta", { id: due.id, deletedInMs: -29 * DAY_MS });
    const seeded = { due, recent, active, suspendedDue, twin };
    const tenantOf = (name: string): TenantKey =>
      name === "suspendedDue" || name === "twin" ? "beta" : "alpha";
    for (const [name, customer] of Object.entries(seeded)) {
      before[name] = await recordsOf(tenantOf(name), customer);
      ownBefore[name] = await ownRowsOf(tenantOf(name), customer.id);
    }

    run = await iteration();

    for (const [name, customer] of Object.entries(seeded)) {
      after[name] = await recordsOf(tenantOf(name), customer);
      ownAfter[name] = await ownRowsOf(tenantOf(name), customer.id);
    }
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-087 AC1] erases a customer deleted 31 days ago: the row, its identities, consents, sessions and saved data are gone", () => {
    expect(ownBefore["due"]).toEqual(SEEDED_OWN_ROWS);
    expect(ownAfter["due"]).toEqual(NO_OWN_ROWS);
    expect(after["due"]?.["customer"]).toBeUndefined();
    expect(resultOf(run.alpha)).toEqual(done("alpha", seededCounts(1)));
  });

  it("[OBE-087 AC1] leaves a customer deleted 29 days ago untouched, and an active one too", () => {
    expect(ownAfter["recent"]).toEqual(SEEDED_OWN_ROWS);
    expect(after["recent"]).toEqual(before["recent"]);
    expect((after["recent"]?.["booking"] as { customer_id: string | null }).customer_id).toBe(recent.id);
    expect(ownAfter["active"]).toEqual(SEEDED_OWN_ROWS);
    expect(after["active"]).toEqual(before["active"]);
  });

  it("[OBE-087 AC2] keeps the booking, payment and refund with their amounts and references; only customer_id is detached", () => {
    const was = before["due"] ?? {};
    const is = after["due"] ?? {};
    // Every column as it was (amounts, references, statuses, version, updated_at), customer_id now NULL.
    expect(is["booking"]).toEqual({ ...(was["booking"] as object), customer_id: null });
    expect(is["payment"]).toEqual({ ...(was["payment"] as object), customer_id: null });
    expect(is["refund"]).toEqual(was["refund"]);
    expect(is["booking"]).toMatchObject({
      reference: (was["booking"] as { reference: string }).reference,
      total_amount: "440.00",
      amount_paid: "440.00",
      amount_refunded: "40.00",
      status: "ticketed",
      version: 7,
    });
    expect(is["payment"]).toMatchObject({
      provider_payment_id: (was["payment"] as { provider_payment_id: string }).provider_payment_id,
      amount: "440.00",
      amount_captured: "440.00",
      amount_refunded: "40.00",
      card_last4: "4242",
    });
    expect(is["refund"]).toMatchObject({
      amount: "40.00",
      payment_id: due.paymentId,
      booking_id: due.bookingId,
      status: "succeeded",
    });
    // The booking's travellers, contact and timeline are its financial and audit record (db README §7).
    expect(is["travelers"]).toEqual(was["travelers"]);
    expect(is["contacts"]).toEqual(was["contacts"]);
    expect(is["events"]).toEqual(was["events"]);
  });

  it("detaches the checkout, the search and the e-mail record too, and keeps the checkout's guest flag and status", () => {
    const was = before["due"] ?? {};
    const is = after["due"] ?? {};
    expect(is["checkout"]).toEqual({ ...(was["checkout"] as object), customer_id: null });
    expect(is["checkout"]).toMatchObject({ is_guest: false, status: "completed", version: 4 });
    expect(is["search"]).toEqual({ ...(was["search"] as object), customer_id: null });
    expect(is["notification"]).toEqual({ ...(was["notification"] as object), customer_id: null });
  });

  it("erases a suspended tenant's due customers (OADR-0014 point 4) in that tenant's schema only", () => {
    expect(ownAfter["suspendedDue"]).toEqual(NO_OWN_ROWS);
    expect(after["suspendedDue"]?.["booking"]).toMatchObject({ customer_id: null, total_amount: "440.00" });
    expect(resultOf(run.beta)).toEqual(done("beta", seededCounts(1)));
    // Beta's customer with the id alpha's erasure deleted is another row, in another schema, and not due yet.
    expect(twin.id).toBe(due.id);
    expect(ownAfter["twin"]).toEqual(SEEDED_OWN_ROWS);
    expect(after["twin"]).toEqual(before["twin"]);
  });

  it("logs one customer.erased line per erasure with the tenant, the id and counts, never a name, an address or a phone number", () => {
    // The two tenants' jobs may run side by side (the queue's concurrency is 2): their lines are read per tenant.
    const lines = erasedLines();
    expect(lines).toHaveLength(2);
    const ofTenant = (tenant: TenantKey) => lines.filter((line) => line["tenantId"] === tenantIds[tenant]);
    for (const [tenant, customer] of [
      ["alpha", due],
      ["beta", suspendedDue],
    ] as const) {
      expect(ofTenant(tenant)).toEqual([
        expect.objectContaining({
          customerId: customer.id,
          checkoutsDetached: 1,
          bookingsDetached: 1,
          paymentsDetached: 1,
          sessions: 1,
          consents: 2,
          identities: 1,
        }),
      ]);
    }
    const text = sink.text();
    for (const customer of [due, recent, active, suspendedDue, twin]) {
      for (const value of customer.personalData) {
        expect(text).not.toContain(value);
      }
    }
    expect(text).not.toContain("1988-04-17");
  });
});

describe("customers.erase: idempotent", () => {
  let again: RunJobs;
  let unchanged: { before: Record<string, number>; after: Record<string, number> };
  let later: RunJobs;
  let recentAfter: Record<string, number>;

  /** How many rows each table holds in alpha: what a run that erases nothing must leave as it is. */
  async function tableSizes(): Promise<Record<string, number>> {
    return await txOf("alpha")(async (trx) => {
      const sizes: Record<string, number> = {};
      for (const table of [
        "customers",
        "customer_identities",
        "customer_sessions",
        "customer_password_resets",
        "customer_consents",
        "customer_preferences",
        "saved_travelers",
        "saved_traveler_documents",
        "checkouts",
        "bookings",
        "payments",
        "refunds",
        "notifications",
      ] as const) {
        const rows = await trx.selectFrom(table).select("id").execute();
        sizes[table] = rows.length;
      }
      const attached = await trx
        .selectFrom("bookings")
        .select("id")
        .where("customer_id", "is not", null)
        .execute();
      sizes["bookingsWithCustomer"] = attached.length;
      return sizes;
    });
  }

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    const sizesBefore = await tableSizes();
    clock.advance(MINUTE_MS);
    again = await iteration();
    unchanged = { before: sizesBefore, after: await tableSizes() };

    // Two days on, the customer deleted 29 days ago is 31 days past its deletion.
    clock.advance(2 * DAY_MS);
    later = await iteration();
    recentAfter = await txOf("alpha")(async (trx) => {
      const rows = await trx.selectFrom("customers").select("id").where("status", "=", "deleted").execute();
      return { deletedCustomers: rows.length };
    });
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-087 AC1] a second run erases nothing and changes nothing", () => {
    expect(resultOf(again.alpha)).toEqual(done("alpha", seededCounts(0)));
    expect(resultOf(again.beta)).toEqual(done("beta", seededCounts(0)));
    expect(unchanged.after).toEqual(unchanged.before);
  });

  it("[OBE-087 AC1] erases the customer deleted 29 days ago once 30 days have passed", () => {
    // Alpha's customer deleted 29 days ago and beta's twin, both 31 days past their deletion now.
    expect(resultOf(later.alpha)).toEqual(done("alpha", seededCounts(1)));
    expect(resultOf(later.beta)).toEqual(done("beta", seededCounts(1)));
    expect(recentAfter).toEqual({ deletedCustomers: 0 });
  });
});

describe("customers.erase: batches", () => {
  /** The deleted customers of the scenario, oldest deletion first. */
  let deleted: string[];
  let first: Job;
  let continuation: Job;
  let left: number;

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    clock.advance(MINUTE_MS);
    // One more than a batch, deleted a second apart between 40 and 39 days ago, inserted newest first.
    deleted = await txOf("alpha")(async (trx) => {
      const ids: string[] = [];
      for (let index = ERASURE_BATCH; index >= 0; index -= 1) {
        ids.unshift(await insertDeletedCustomer(trx, -40 * DAY_MS + index * 1000));
      }
      return ids;
    });
    const dueAt = clock.now();
    await maintenance.add(FAN_OUT_JOB, { task: CUSTOMERS_ERASE_JOB }, { prevMillis: dueAt.getTime() });
    const bucket = minuteBucket(dueAt);
    first = await finished(tenantJobId(CUSTOMERS_ERASE_JOB, tenantIds.alpha, bucket));
    continuation = await finished(tenantJobId(CUSTOMERS_ERASE_JOB, tenantIds.alpha, bucket, 1));
    await finished(tenantJobId(CUSTOMERS_ERASE_JOB, tenantIds.beta, bucket));
    left = await txOf("alpha")(async (trx) => {
      const rows = await trx.selectFrom("customers").select("id").where("id", "in", deleted).execute();
      return rows.length;
    });
  }, SCENARIO_TIMEOUT_MS);

  it("erases 100 customers per job, oldest deletion first, and continues with the rest (OADR-0014 point 2)", () => {
    const minimal = (customers: number): ErasureCounts => ({
      ...seededCounts(0),
      customers,
      identities: customers,
    });
    expect(resultOf(first)).toEqual(done("alpha", minimal(ERASURE_BATCH), true));
    expect(resultOf(continuation)).toEqual(done("alpha", minimal(1)));
    expect(left).toBe(0);
    const order = erasedLines()
      .map((line) => line["customerId"])
      .filter((id): id is string => typeof id === "string" && deleted.includes(id));
    expect(order).toEqual(deleted);
  });
});

describe("customers.erase: the 30-day boundary", () => {
  /** Alpha: deleted exactly 30 days before the run, so its erasureDueBy is the run's instant. */
  let onTheDay: SeededCustomer;
  /** Alpha: deleted one second less than 30 days before the run. */
  let aSecondShort: SeededCustomer;
  let run: RunJobs;
  const ownAfter: Record<string, Record<string, number>> = {};

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    clock.advance(MINUTE_MS);
    onTheDay = await seedCustomer("alpha", { deletedInMs: -ERASURE_DUE_AFTER_MS });
    aSecondShort = await seedCustomer("alpha", { deletedInMs: -ERASURE_DUE_AFTER_MS + 1000 });

    run = await iteration();

    ownAfter["onTheDay"] = await ownRowsOf("alpha", onTheDay.id);
    ownAfter["aSecondShort"] = await ownRowsOf("alpha", aSecondShort.id);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-087 AC1] erases a customer at its erasureDueBy (30 days after the deletion) and leaves one a second short of it", () => {
    expect(ownAfter["onTheDay"]).toEqual(NO_OWN_ROWS);
    expect(ownAfter["aSecondShort"]).toEqual(SEEDED_OWN_ROWS);
    expect(resultOf(run.alpha)).toEqual(done("alpha", seededCounts(1)));
    expect(resultOf(run.beta)).toEqual(done("beta", seededCounts(0)));
  });
});
