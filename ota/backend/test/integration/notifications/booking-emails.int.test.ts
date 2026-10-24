// The booking and staff e-mails end to end (OBE-055; OADR-0013 items 5 and 8, ota/docs/flows/ticketing-and-documents.md
// §3 step 7) against PostgreSQL 16, Redis 7, Mailpit and the Amadeus stub.
//
// The file runs the real worker module graph (WorkerModule.forRoot: the record step's OrderRecorder, the `ota-ticketing`
// consumer, the `ota-documents` consumer that renders the PDFs into a storage folder of its own, the `ota-notifications`
// consumer that sends through Mailpit's SMTP port) on a clone of the @velexis/testing template (`tenant_alpha` and
// `tenant_beta` provisioned) and a Redis database of its own. It plays the platform as velexis_migrator: both tenants
// active on the Velexis test Amadeus account, whose `base_url` is the stub's; alpha has an `ops_alert_email`, beta has
// none and two owners (and members who must not get its alerts: an admin, a removed owner, owners whose account is
// erased or not verified). The worker reads the platform as velexis_ota_app, as in production.
//
// The booking flow: an order is created on the stub through the worker's Amadeus client and recorded with the worker's
// OrderRecorder.record in a TenantTx transaction, as checkout.complete records an order whose issuance did not happen
// yet (`confirmed`, `ticketing_status = failed`, the next attempt due); the record step queues `booking.confirmed` and
// asks for the itinerary, and the worker sends the e-mail once the itinerary is ready. Then a `ticketing.issue` job
// issues the order on the stub, stores the e-tickets and writes `booking.ticketed`, which asks for the receipts and
// queues `booking.ticketed`, sent with them. The schedulers the worker registers are removed, so no sweep fires on its
// own: an e-mail waiting for its documents is claimed again by the delayed `notify` its drain adds. A wait past the
// 2 minutes is not waited for: the worker's Clock is moved ahead. Every scenario runs in a `beforeAll` hook with an
// explicit budget (it waits for jobs, documents and Mailpit) and its tests read what it left; every e-mail goes to a
// recipient of its own (`uniqueEmail`).
//
// FIX-W28-NOTIFY (OADR-0013 item 4 as revised on 2026-10-23): the `booking.updated` e-mails of a contacts change, queued
// by BookingUpdatedEmails (the API's writer of bookings.update and of the staff patch) on the worker's outbox for a
// booking whose itinerary is ready: the new address gets it attached, the previous one a notice without attachment.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { encryptValue } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
  type TenantSchema,
} from "@velexis/db";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import { mailpit, uniqueEmail, waitForMessage, type MailpitMessage } from "@velexis/testing/mailpit";
import type { Job, Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { BookingUpdatedEmails } from "../../../src/bookings/booking-updated-emails";
import { BookingsRepository } from "../../../src/bookings/bookings.repository";
import { OrderRecorder, readCreatedOrder, type CreatedOrder } from "../../../src/bookings/order-recorder";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import {
  ticketingJob,
  ticketingJobId,
  type TicketingJobResult,
} from "../../../src/bookings/ticketing.processor";
import type { CheckoutContactRow, CheckoutTravelerRow } from "../../../src/checkout/checkout.repository";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import { jobTenant, minuteBucket } from "../../../src/jobs/fan-out";
import { ATTACHMENT_WAIT_MS } from "../../../src/notifications/attachments";
import { CLAIM_LEASE_MS } from "../../../src/notifications/notifications.processor";
import type { NotificationRow } from "../../../src/notifications/outbox.repository";
import { OutboxService } from "../../../src/notifications/outbox.service";
import { StaffRecipients } from "../../../src/notifications/staff-recipients";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { PlatformCache } from "../../../src/tenancy/platform-cache";
import { TenantContext } from "../../../src/tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderRequestInput } from "../../builders/bookings";
import { testKeyProvider, testWorkerVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

/**
 * Cloning the template, starting the stub and the worker graph (BullMQ connections, the scheduler registration, the key
 * files): a few seconds locally, longer on a busy 4-CPU runner. The bound only stops a start-up that hangs.
 */
const SETUP_TIMEOUT_MS = 60_000;
/**
 * A scenario waits for the worker's jobs: a first PDF render (pdfmake loads its fonts once), the documents, the e-mail
 * that waits for them (claimed again 5 s later) and Mailpit. Well under 15 s locally; the bound allows for CI load.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for one e-mail in Mailpit. */
const MAIL_WAIT_MS = 30_000;
/** How long a scenario waits at most for a job or a row. */
const JOB_WAIT = { timeout: 15_000, interval: 25 } as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const quietPoolLogger = { error: (): void => undefined };

type TenantKey = "alpha" | "beta";

let db: TestDatabase;
let redis: TestRedis;
let stub: AmadeusStub;
let storageDir: string;
let app: INestApplicationContext;
const sink = new MemorySink();
let migratorPool: ReturnType<typeof createPool>;
/** velexis_migrator, the owner of the platform tables: writes the platform rows as the platform does. */
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
/** `tenantTx` as velexis_ota_app: reads the tenant rows back. */
let tenantDb: TenantDb;
let ticketing: Queue;

const tenants: Record<TenantKey, { id: string; office: string }> = {
  alpha: { id: "", office: "" },
  beta: { id: "", office: "" },
};

/** Alpha's alert address (`storefront_settings.ops_alert_email`). */
const ALPHA_OPS = uniqueEmail("obe055-alpha-ops");
/** Beta's owners, who get its alerts, and the members and accounts who must not. */
const BETA_FOUNDER = uniqueEmail("obe055-beta-founder");
const BETA_PARTNER = uniqueEmail("obe055-beta-partner");
const NOT_ALERTED = {
  admin: uniqueEmail("obe055-beta-admin"),
  removed: uniqueEmail("obe055-removed-owner"),
  erased: uniqueEmail("obe055-erased-owner"),
  unverified: uniqueEmail("obe055-unverified"),
};
/** The account of BETA_PARTNER, whose alerts carry it in their dedupe key. */
let betaPartnerAccountId = "";
/** Every address this file sends to: none of them may reach a log line. */
const addresses: string[] = [ALPHA_OPS, BETA_FOUNDER, BETA_PARTNER, ...Object.values(NOT_ALERTED)];

const tx = <T>(key: TenantKey, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, `tenant_${key}`, run);

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function insertAccount(clientId: string, secret: string): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(secret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${id}`,
    keys: await testKeyProvider(),
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id,
      name: "Velexis test",
      environment: "test",
      base_url: stub.url,
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

async function insertTenant(key: TenantKey, amadeusAccountId: string): Promise<void> {
  const id = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
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
      amadeus_account_id: amadeusAccountId,
      office_ids: [office],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      status: "active",
    })
    .execute();
  tenants[key] = { id, office };
}

/** A portal account and its membership of `key`, as the platform writes them. */
async function insertMember(
  key: TenantKey,
  email: string,
  member: {
    readonly role: "owner" | "admin";
    readonly membership?: "active" | "removed";
    readonly account?: "active" | "deleted" | "pending_verification";
    readonly createdAt: Date;
  },
): Promise<string> {
  const accountId = newId("acc");
  const account = member.account ?? "active";
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email,
      full_name: "Test Owner",
      status: account,
      email_verified_at: account === "pending_verification" ? null : member.createdAt,
      deleted_at: account === "deleted" ? member.createdAt : null,
    })
    .execute();
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({
      id: newId("stf"),
      tenant_id: tenants[key].id,
      account_id: accountId,
      role: member.role,
      status: member.membership ?? "active",
      created_at: member.createdAt,
    })
    .execute();
  return accountId;
}

/** Runs `run` in a TenantTx transaction of the worker, in a job context of `key`. */
async function inWorker<T>(key: TenantKey, run: (trx: TenantTransaction) => Promise<T>): Promise<T> {
  const tenant = await app.get(PlatformCache, { strict: false }).tenantById(tenants[key].id);
  if (tenant === null) {
    throw new Error(`tenant ${key} is not readable`);
  }
  const requestId = `obe055-test-${randomBytes(4).toString("hex")}`;
  return app
    .get(TenantContext, { strict: false })
    .run(jobTenant(tenant, { id: requestId, name: "test" }), () =>
      app.get(TenantTx, { strict: false }).run(run),
    );
}

/** An order of the stub's priced offer 2 for one traveller, created as `key` through the worker's Amadeus client. */
async function createOrder(key: TenantKey): Promise<CreatedOrder> {
  const tenant = await app.get(PlatformCache, { strict: false }).tenantById(tenants[key].id);
  if (tenant === null) {
    throw new Error(`tenant ${key} is not readable`);
  }
  const requestId = `obe055-test-${randomBytes(4).toString("hex")}`;
  const office = tenants[key].office;
  const request = buildCreateOrderRequest(
    buildOrderRequestInput({
      reference: newBookingReference(),
      queue: null,
      offices: { queuing: office, owner: office },
      issue: false,
    }),
  );
  const client = app.get(AmadeusClient, { strict: false });
  const reply = await app
    .get(TenantContext, { strict: false })
    .run(jobTenant(tenant, { id: requestId, name: "setup" }), () =>
      client.createFlightOrders(
        { tenantId: tenant.id, environment: "test", operation: "test.setup", requestId },
        {
          body: request.body as unknown as Parameters<AmadeusClient["createFlightOrders"]>[1]["body"],
          query: request.query,
        },
      ),
    );
  const order = readCreatedOrder(reply.body);
  if (order === undefined || order.records.length === 0 || order.tickets.length > 0) {
    throw new Error("the stub did not create an order without tickets");
  }
  return order;
}

interface FlowBooking {
  readonly id: string;
  readonly key: TenantKey;
  readonly reference: string;
  readonly traveller: string;
}

/** A pending booking row of `key`, as checkout.complete writes it before Flight Create Orders. */
async function insertPendingBooking(key: TenantKey, traveller: string): Promise<FlowBooking> {
  const id = newId("bkg");
  const reference = newBookingReference();
  const departure = new Date(Date.now() + 60 * DAY);
  await tx(key, (trx) =>
    trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference,
        status: "pending",
        ticketing_status: "pending",
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 2 * HOUR),
        currency: "EUR",
        net_amount: "100.00",
        total_amount: "115.00",
        amount_paid: "115.00",
        contact_email: traveller,
        lead_last_name: "SAMPLE",
      })
      .execute(),
  );
  return { id, key, reference, traveller };
}

/** The checkout's traveller and contact of a booking, as the record step reads them. */
function checkoutRows(traveller: string): {
  travelers: CheckoutTravelerRow[];
  contacts: CheckoutContactRow[];
} {
  return {
    travelers: [
      {
        id: newId("ctr"),
        amadeusTravelerId: "1",
        travelerType: "ADULT",
        associatedAdultId: null,
        savedTravelerId: null,
        firstName: "TESTA",
        middleName: null,
        lastName: "SAMPLE",
        secondLastName: null,
        dateOfBirth: "1988-04-12",
        gender: "FEMALE",
        contact: null,
        documentsCiphertext: null,
        discountEligibilityCiphertext: null,
        encryptionKeyId: null,
        loyaltyPrograms: [],
        emergencyContact: null,
        saveToProfile: false,
        position: 0,
      },
    ],
    contacts: [
      {
        id: newId("cco"),
        purpose: "STANDARD",
        isPrimary: true,
        firstName: "TESTA",
        lastName: "SAMPLE",
        companyName: null,
        email: traveller,
        phones: [],
        address: null,
        language: "en",
      },
    ],
  };
}

/**
 * The record step of `order` on the pending booking, in the worker (see the file header): `confirmed`, the issuance
 * asked for and not done (the next attempt is the ticketing job's), the outbox `booking.confirmed`, the itinerary asked.
 */
async function recordOrder(booking: FlowBooking, order: CreatedOrder): Promise<void> {
  const rows = checkoutRows(booking.traveller);
  await inWorker(booking.key, async (trx) => {
    const repository = app.get(BookingsRepository, { strict: false });
    const row = await repository.booking(trx, booking.id, true);
    const settings = await repository.settings(trx);
    if (row === undefined || settings === undefined) {
      throw new Error("the booking or the settings are missing");
    }
    await app.get(OrderRecorder, { strict: false }).record(trx, {
      schema: `tenant_${booking.key}` as TenantSchema,
      tenantKey: booking.key,
      booking: row,
      order,
      travelers: rows.travelers.map((traveler) => ({ row: traveler, documents: [], discounts: [] })),
      contacts: rows.contacts,
      remarks: [],
      settings,
      policy: "issue_at_booking",
      issueRequested: true,
      locale: "en",
      actor: { type: "system", id: null },
      requestId: `obe055-record-${randomBytes(4).toString("hex")}`,
      supplierRequestId: null,
      now: new Date(),
    });
  });
}

/** Makes the booking's next issuance attempt due and runs it with a `ticketing.issue` job; its result. */
async function issueTickets(booking: FlowBooking): Promise<TicketingJobResult> {
  await tx(booking.key, (trx) =>
    trx
      .updateTable("bookings")
      .set({ ticketing_next_attempt_at: new Date(Date.now() - 1000) })
      .where("id", "=", booking.id)
      .execute(),
  );
  const bucket = minuteBucket(new Date());
  const job = ticketingJob(tenants[booking.key].id, booking.id, bucket);
  await ticketing.add(job.name, job.data, job.opts);
  return (await finished(ticketing, ticketingJobId(booking.id, bucket))).returnvalue as TicketingJobResult;
}

/** The job with this id once the worker has finished it, completed. */
async function finished(queue: Queue, id: string): Promise<Job> {
  const job = await vi.waitFor(async () => {
    const found = await queue.getJob(id);
    if (found?.finishedOn === undefined) {
      throw new Error(`job ${id} has not finished`);
    }
    return found;
  }, JOB_WAIT);
  expect(await job.getState(), `job ${id}: ${job.failedReason ?? ""}`).toBe("completed");
  return job;
}

/** The notifications of a booking (or every staff row of `key` without one), oldest first. */
async function notificationsOf(key: TenantKey, bookingId: string): Promise<NotificationRow[]> {
  return await tx(key, (trx) =>
    trx
      .selectFrom("notifications")
      .selectAll()
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );
}

/** The ready documents of a booking, by kind. */
async function readyDocumentsOf(booking: FlowBooking) {
  return await tx(booking.key, (trx) =>
    trx
      .selectFrom("booking_documents")
      .select([
        "kind",
        "file_name as fileName",
        "content_hash as contentHash",
        "booking_ticket_id as ticketId",
      ])
      .where("booking_id", "=", booking.id)
      .where("status", "=", "ready")
      .orderBy("created_at")
      .execute(),
  );
}

/** The bytes of an attachment of a Mailpit message (`GET /api/v1/message/{id}/part/{partId}`). */
async function attachmentBytes(message: MailpitMessage, partId: string): Promise<Buffer> {
  const base = mailpit.apiUrl.endsWith("/") ? mailpit.apiUrl : `${mailpit.apiUrl}/`;
  const response = await fetch(new URL(`api/v1/message/${message.ID}/part/${partId}`, base));
  if (!response.ok) {
    throw new Error(`Mailpit answered ${response.status} for an attachment`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Points the worker's Clock `ms` ahead of real time until the returned function is called. */
function workerClockAhead(ms: number): () => void {
  const spy = vi.spyOn(app.get(Clock), "now").mockImplementation(() => new Date(Date.now() + ms));
  return () => spy.mockRestore();
}

beforeAll(async () => {
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  storageDir = mkdtempSync(join(tmpdir(), "velexis-obe055-storage-"));
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

  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  const accountId = await insertAccount(clientId, secret);
  await insertTenant("alpha", accountId);
  await insertTenant("beta", accountId);
  for (const key of ["alpha", "beta"] as const) {
    await tx(key, async (trx) => {
      await seedStorefrontSettings(trx, {
        name: `${key} Travel`,
        defaultCurrency: "EUR",
        defaultLocale: "en",
      });
      await trx
        .updateTable("storefront_settings")
        .set({
          support_email: `help@${key}-travel.example`,
          time_zone: "Europe/Madrid",
          ops_alert_email: key === "alpha" ? ALPHA_OPS : null,
        })
        .execute();
    });
  }
  const founded = new Date(Date.now() - 30 * DAY);
  const later = (days: number) => new Date(founded.getTime() + days * DAY);
  await insertMember("beta", BETA_FOUNDER, { role: "owner", createdAt: founded });
  await insertMember("beta", NOT_ALERTED.admin, { role: "admin", createdAt: later(1) });
  await insertMember("beta", NOT_ALERTED.removed, {
    role: "owner",
    membership: "removed",
    createdAt: later(2),
  });
  await insertMember("beta", NOT_ALERTED.erased, { role: "owner", account: "deleted", createdAt: later(3) });
  await insertMember("beta", NOT_ALERTED.unverified, {
    role: "owner",
    account: "pending_verification",
    createdAt: later(4),
  });
  betaPartnerAccountId = await insertMember("beta", BETA_PARTNER, { role: "owner", createdAt: later(5) });

  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    LOG_LEVEL: "debug",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
    STORAGE_DIR: storageDir,
  });
  useNextApplicationLoggerOutsideRequests();
  app = await createWorkerApp(WorkerModule.forRoot(config, { logger: createWorkerLogger(config, sink) }));
  await app.init();
  ticketing = app.get<Queue>(getQueueToken(OTA_QUEUE.ticketing), { strict: false });
  const maintenance = app.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  // No scheduler iteration may fire while the file runs.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await stub?.stop();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
  if (storageDir !== undefined) {
    rmSync(storageDir, { recursive: true, force: true });
  }
}, SETUP_TIMEOUT_MS);

describe("[OBE-055 AC2] a booking flow", () => {
  const traveller = uniqueEmail("obe055-traveller");
  let booking: FlowBooking;
  let confirmation: MailpitMessage;
  /** The booking's itinerary when the confirmation arrived (ticketing supersedes it with a new one). */
  let itinerary: Awaited<ReturnType<typeof readyDocumentsOf>>;
  let eTickets: MailpitMessage;
  let ticketed: TicketingJobResult;

  beforeAll(async () => {
    addresses.push(traveller);
    const order = await createOrder("alpha");
    booking = await insertPendingBooking("alpha", traveller);
    await recordOrder(booking, order);
    confirmation = await waitForMessage({ to: traveller, subject: /is confirmed$/, timeoutMs: MAIL_WAIT_MS });
    itinerary = (await readyDocumentsOf(booking)).filter((row) => row.kind === "itinerary");
    ticketed = await issueTickets(booking);
    eTickets = await waitForMessage({
      to: traveller,
      subject: /^Your e-tickets for booking /,
      timeoutMs: MAIL_WAIT_MS,
    });
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-055 AC2] sends the confirmation with the itinerary attached, the PDF the documents module stored", async () => {
    expect(confirmation.Subject).toBe(`Your booking ${booking.reference} with alpha Travel is confirmed`);
    expect(confirmation.Attachments).toHaveLength(1);
    const [attachment] = confirmation.Attachments;
    expect(attachment).toMatchObject({ ContentType: "application/pdf" });
    expect(attachment?.FileName).toBe(`${booking.reference}-itinerary.pdf`);
    const bytes = await attachmentBytes(confirmation, attachment?.PartID ?? "");
    expect(itinerary.map((row) => row.contentHash)).toEqual([sha256(bytes)]);
    expect(confirmation.Text).toContain("Your itinerary is attached to this e-mail as a PDF.");
    expect(confirmation.Text).toContain("This e-mail is not an invoice.");
    expect(confirmation.Text).toContain(`https://alpha.ota.example.com/booking.html?id=${booking.id}`);
  });

  it("[OBE-055 AC2] after ticketing sends the e-ticket e-mail with one receipt per e-ticket", async () => {
    expect(ticketed).toMatchObject({ outcome: "ticketed" });
    const tickets = await tx("alpha", (trx) =>
      trx
        .selectFrom("booking_tickets")
        .select(["id", "document_number as number"])
        .where("booking_id", "=", booking.id)
        .where("document_type", "=", "ETICKET")
        .execute(),
    );
    const receipts = (await readyDocumentsOf(booking)).filter((row) => row.kind === "e_ticket_receipt");
    expect(tickets.length).toBeGreaterThan(0);

    expect(eTickets.Attachments).toHaveLength(tickets.length);
    const hashes: string[] = [];
    for (const attachment of eTickets.Attachments) {
      expect(attachment.ContentType).toBe("application/pdf");
      expect(attachment.FileName).toMatch(new RegExp(`^${booking.reference}-eticket-\\d+\\.pdf$`));
      hashes.push(sha256(await attachmentBytes(eTickets, attachment.PartID)));
    }
    expect(hashes.sort()).toEqual(
      receipts
        .filter((row) => tickets.some((ticket) => ticket.id === row.ticketId))
        .map((row) => row.contentHash)
        .sort(),
    );
    for (const ticket of tickets) {
      expect(eTickets.Text).toContain(`- TESTA SAMPLE: ${ticket.number}`);
    }
    expect(eTickets.Text).toContain("The e-ticket receipts are attached to this e-mail as PDFs.");
  });

  it("[OBE-055 AC2] queues each e-mail once, sends it after one attempt and erases nothing it did not hold", async () => {
    const rows = await notificationsOf("alpha", booking.id);

    expect(rows.map((row) => [row.template_key, row.status, row.attempts, row.recipient])).toEqual([
      ["booking.confirmed", "sent", 1, traveller],
      ["booking.ticketed", "sent", 1, traveller],
    ]);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      `booking.confirmed:${booking.id}`,
      expect.stringMatching(new RegExp(`^booking\\.ticketed:${booking.id}:v\\d+$`)) as unknown,
    ]);
    // The e-mails waited for their documents without using an attempt.
    expect(sink.text()).toContain("notifications.waiting_for_documents");
  });
});

describe("[FIX-W28-NOTIFY AC1] the booking.updated e-mails of a contacts change", () => {
  const previous = uniqueEmail("fixw28-previous");
  const next = uniqueEmail("fixw28-next");
  let booking: FlowBooking;
  let itinerary: Awaited<ReturnType<typeof readyDocumentsOf>>;
  let updated: MailpitMessage;
  let notice: MailpitMessage;

  beforeAll(async () => {
    addresses.push(previous, next);
    const order = await createOrder("alpha");
    booking = await insertPendingBooking("alpha", previous);
    await recordOrder(booking, order);
    // The confirmation waits for the itinerary: once it arrived, the itinerary is ready.
    await waitForMessage({ to: previous, subject: /is confirmed$/, timeoutMs: MAIL_WAIT_MS });
    itinerary = (await readyDocumentsOf(booking)).filter((row) => row.kind === "itinerary");
    const emails = new BookingUpdatedEmails(
      app.get(OutboxService, { strict: false }),
      app.get(BookingsRepository, { strict: false }),
      app.get(ConfigService),
      { error: vi.fn() } as unknown as PinoLogger,
    );
    // As bookings.update queues them after the contacts changed to `next` (the API's call, on this worker's outbox).
    await inWorker("alpha", async (trx) => {
      const repository = app.get(BookingsRepository, { strict: false });
      const row = await repository.booking(trx, booking.id);
      if (row === undefined) {
        throw new Error("the booking is missing");
      }
      const children = await repository.children(trx, booking.id);
      await emails.send(trx, {
        tenantKey: "alpha",
        booking: row,
        travelers: children.travelers,
        segments: children.segments,
        contact: { email: next, firstName: "TESTB", lastName: "SAMPLE", language: "en" },
        previousEmail: previous,
        previousLanguage: "en",
        contactsChanged: true,
        dedupePrefix: "booking.contacts_updated",
        version: row.version + 1,
      });
    });
    [updated, notice] = await Promise.all([
      waitForMessage({ to: next, subject: /has been updated$/, timeoutMs: MAIL_WAIT_MS }),
      waitForMessage({ to: previous, subject: /were changed$/, timeoutMs: MAIL_WAIT_MS }),
    ]);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W28-NOTIFY AC1] sends the new address the booking as it is now with the ready itinerary attached", async () => {
    expect(updated.Subject).toBe(`Your booking ${booking.reference} with alpha Travel has been updated`);
    expect(updated.Attachments).toHaveLength(1);
    const [attachment] = updated.Attachments;
    expect(attachment?.FileName).toBe(`${booking.reference}-itinerary.pdf`);
    const bytes = await attachmentBytes(updated, attachment?.PartID ?? "");
    expect(itinerary.map((row) => row.contentHash)).toEqual([sha256(bytes)]);
    expect(updated.Text).toContain("Hello TESTB,");
    expect(updated.Text).toContain("- TESTA SAMPLE");
    expect(updated.Text).toContain("Your current itinerary is attached to this e-mail as a PDF.");
    expect(updated.Text).toContain(`https://alpha.ota.example.com/booking.html?id=${booking.id}`);
  });

  it("[FIX-W28-NOTIFY AC1] sends the previous address a notice with the reference only and no attachment", async () => {
    expect(notice.Subject).toBe(
      `The contact details of booking ${booking.reference} with alpha Travel were changed`,
    );
    expect(notice.Attachments).toEqual([]);
    for (const part of [notice.Text, notice.HTML]) {
      expect(part).toContain(booking.reference);
      for (const absent of [next, "TESTA", "TESTB", "itinerary", "booking.html", booking.id, "115.00"]) {
        expect([absent, part.includes(absent)]).toEqual([absent, false]);
      }
    }
    // Both rows share one transaction's time: by dedupe key, `…:new` before `…:old`.
    const rows = (await notificationsOf("alpha", booking.id))
      .filter((row) => row.template_key === "booking.updated")
      .sort((a, b) => (a.dedupe_key ?? "").localeCompare(b.dedupe_key ?? ""));
    expect(rows.map((row) => [row.recipient, row.status, row.attempts])).toEqual([
      [next, "sent", 1],
      [previous, "sent", 1],
    ]);
  });
});

/** Queues a `booking.confirmed` e-mail of `booking` as the record step (or a contacts change) does, in the worker. */
async function queueConfirmation(booking: FlowBooking): Promise<string> {
  const queued = await inWorker(booking.key, (trx) =>
    app.get(OutboxService, { strict: false }).enqueue(trx, {
      templateKey: "booking.confirmed",
      to: booking.traveller,
      locale: "en",
      bookingId: booking.id,
      dedupeKey: `booking.confirmed:${booking.id}`,
      data: {
        booking: {
          reference: booking.reference,
          recordLocator: "",
          url: `https://${booking.key}.ota.example.com/booking.html?id=${booking.id}`,
          total: { amount: "115.00", currency: "EUR" },
          contact: { firstName: "TESTA", lastName: "SAMPLE" },
          travellers: [{ firstName: "TESTA", lastName: "SAMPLE" }],
          segments: [],
        },
      },
    }),
  );
  return queued.notificationId;
}

describe("[OBE-055 step 3] a confirmation whose itinerary was never asked for", () => {
  const traveller = uniqueEmail("obe055-never-asked");
  let message: MailpitMessage;

  beforeAll(async () => {
    addresses.push(traveller);
    // No booking event asked for an itinerary (as for a contacts change of a booking whose documents are gone).
    const booking = await insertPendingBooking("alpha", traveller);
    await queueConfirmation(booking);
    message = await waitForMessage({ to: traveller, subject: /is confirmed$/, timeoutMs: MAIL_WAIT_MS });
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-055 step 3] is sent at once without attachments, pointing to the booking page", () => {
    expect(message.Attachments).toEqual([]);
    expect(message.Text).toContain("Your itinerary will be ready to download on your booking page shortly.");
  });
});

describe("[OBE-055 step 3] a confirmation whose itinerary is not ready within 2 minutes", () => {
  const traveller = uniqueEmail("obe055-link");
  let booking: FlowBooking;
  let waiting: NotificationRow | undefined;
  let message: MailpitMessage;

  beforeAll(async () => {
    addresses.push(traveller);
    booking = await insertPendingBooking("alpha", traveller);
    // A confirmed booking whose `booking.created` asked for the itinerary, which never comes (its render job is not
    // there): the e-mail can only wait, then go with the link.
    await tx("alpha", async (trx) => {
      await trx.updateTable("bookings").set({ status: "confirmed" }).where("id", "=", booking.id).execute();
      await trx
        .insertInto("booking_events")
        .values({
          id: newId("evt"),
          booking_id: booking.id,
          type: "booking.created",
          actor_type: "system",
          summary: "Booking confirmed by the airline.",
          data: JSON.stringify({}),
          visible_to_customer: true,
          request_id: `obe055-test-${randomBytes(4).toString("hex")}`,
        })
        .execute();
    });
    const notificationId = await queueConfirmation(booking);
    // The first claim (the notify after the commit) defers it: released to the next check, seconds away, no attempt.
    // A claim holds the row with `next_attempt_at` at the end of its 5-minute lease (CLAIM_LEASE_MS), so a row due
    // again within a minute is one the claim released, not one it still holds.
    const deferred = await vi.waitFor(async () => {
      const [row] = await notificationsOf("alpha", booking.id);
      if (
        row === undefined ||
        row.updated_at.getTime() === row.created_at.getTime() ||
        row.next_attempt_at.getTime() >= Date.now() + MINUTE
      ) {
        throw new Error("the e-mail was not deferred yet");
      }
      return row;
    }, JOB_WAIT);
    expect(deferred).toMatchObject({ id: notificationId, status: "pending", attempts: 0 });
    // A minute later it still waits; past the 2 minutes it goes with the link.
    const restoreMinute = workerClockAhead(MINUTE);
    try {
      await app.get(OutboxService, { strict: false }).notify(tenants.alpha.id);
      // Released again to a check after the minute the clock moved, and before the end of a claim's lease.
      waiting = await vi.waitFor(async () => {
        const [row] = await notificationsOf("alpha", booking.id);
        const due = row?.next_attempt_at.getTime() ?? 0;
        if (row === undefined || due < Date.now() + MINUTE || due >= Date.now() + CLAIM_LEASE_MS) {
          throw new Error("the e-mail was not deferred again");
        }
        return row;
      }, JOB_WAIT);
    } finally {
      restoreMinute();
    }
    const restore = workerClockAhead(ATTACHMENT_WAIT_MS + MINUTE);
    try {
      await app.get(OutboxService, { strict: false }).notify(tenants.alpha.id);
      message = await waitForMessage({ to: traveller, subject: /is confirmed$/, timeoutMs: MAIL_WAIT_MS });
    } finally {
      restore();
    }
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-055 step 3] waits without an attempt while the 2 minutes run", () => {
    expect(waiting).toMatchObject({ status: "pending", attempts: 0, last_error: null });
  });

  it("[OBE-055 step 3] is then sent without attachments, pointing to the booking page", async () => {
    expect(message.Attachments).toEqual([]);
    expect(message.Text).toContain("Your itinerary will be ready to download on your booking page shortly.");
    expect(message.Text).toContain(`https://alpha.ota.example.com/booking.html?id=${booking.id}`);
    const [row] = await notificationsOf("alpha", booking.id);
    expect(row).toMatchObject({ status: "sent", attempts: 1 });
  });
});

describe("[OBE-055 AC3] staff alerts", () => {
  let alphaAlert: MailpitMessage;
  let betaBooking: FlowBooking;
  let gaveUp: TicketingJobResult;
  let founderAlert: MailpitMessage;
  let partnerAlert: MailpitMessage;

  beforeAll(async () => {
    // Alpha has an alert address: a staff alert goes there.
    const alphaBooking = await insertPendingBooking("alpha", uniqueEmail("obe055-alpha-trav"));
    await inWorker("alpha", (trx) =>
      app.get(StaffRecipients, { strict: false }).enqueue(trx, {
        templateKey: "staff.manual_review",
        locale: "en",
        bookingId: alphaBooking.id,
        dedupeKey: `staff.manual_review:${alphaBooking.id}:obe055_test`,
        data: {
          booking: {
            reference: alphaBooking.reference,
            recordLocator: "",
            consoleUrl: `http://localhost:3002/bookings/${alphaBooking.id}`,
          },
          review: { reason: "A test of the staff alert recipients." },
        },
      }),
    );
    alphaAlert = await waitForMessage({ to: ALPHA_OPS, subject: /needs a review$/, timeoutMs: MAIL_WAIT_MS });

    // Beta has none: the ticketing job gives up a booking whose form of payment was refused, and its owners are told.
    const betaTraveller = uniqueEmail("obe055-beta-trav");
    addresses.push(betaTraveller);
    const order = await createOrder("beta");
    betaBooking = await insertPendingBooking("beta", betaTraveller);
    await recordOrder(betaBooking, order);
    await tx("beta", (trx) =>
      trx
        .updateTable("bookings")
        .set({ ticketing_error_code: "PAYMENT_DECLINED" })
        .where("id", "=", betaBooking.id)
        .execute(),
    );
    gaveUp = await issueTickets(betaBooking);
    founderAlert = await waitForMessage({
      to: BETA_FOUNDER,
      subject: /^\[Action needed\] Ticketing failed/,
      timeoutMs: MAIL_WAIT_MS,
    });
    partnerAlert = await waitForMessage({
      to: BETA_PARTNER,
      subject: /^\[Action needed\] Ticketing failed/,
      timeoutMs: MAIL_WAIT_MS,
    });
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-055 AC3] go to ops_alert_email when the OTA set it", async () => {
    expect(alphaAlert.Subject).toMatch(/^\[Action needed\] Booking [A-Z0-9]+ needs a review$/);
    expect(alphaAlert.Text).toContain("A test of the staff alert recipients.");
    const rows = await tx("alpha", (trx) =>
      trx
        .selectFrom("notifications")
        .select(["recipient", "recipient_type as recipientType", "status"])
        .where("template_key", "=", "staff.manual_review")
        .execute(),
    );
    expect(rows).toEqual([{ recipient: ALPHA_OPS, recipientType: "staff", status: "sent" }]);
  });

  it("[OBE-055 AC3] go to the owners read from the platform when it is not set, and to no other member", async () => {
    expect(gaveUp).toMatchObject({ outcome: "gave_up", reason: "payment" });
    expect(founderAlert.Text).toContain(betaBooking.reference);
    expect(partnerAlert.Text).toContain("Attempts made:");
    const rows = (await notificationsOf("beta", betaBooking.id)).filter(
      (row) => row.template_key === "staff.ticketing_failed",
    );
    expect(rows.map((row) => [row.recipient, row.recipient_type, row.status])).toEqual(
      expect.arrayContaining([
        [BETA_FOUNDER, "staff", "sent"],
        [BETA_PARTNER, "staff", "sent"],
      ]),
    );
    expect(rows).toHaveLength(2);
    // The founder's row keeps the caller's dedupe key; the partner's adds the account id.
    expect(Object.fromEntries(rows.map((row) => [row.recipient, row.dedupe_key]))).toEqual({
      [BETA_FOUNDER]: `staff.ticketing_failed:${betaBooking.id}`,
      [BETA_PARTNER]: `staff.ticketing_failed:${betaBooking.id}:${betaPartnerAccountId}`,
    });
    for (const address of Object.values(NOT_ALERTED)) {
      expect(await mailpit.search({ to: address })).toEqual([]);
    }
    // The traveller is told that the tickets are delayed, as before.
    expect((await notificationsOf("beta", betaBooking.id)).map((row) => row.template_key)).toContain(
      "booking.ticketing_delayed",
    );
  });

  it("no log line holds an e-mail address of this file", () => {
    const text = sink.text();
    for (const address of addresses) {
      expect(text).not.toContain(address);
    }
  });
});
