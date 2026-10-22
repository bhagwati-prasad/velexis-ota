// The booking documents' queue (OBE-053; OADR-0013 items 6 and 7, ADR-0017, ota/docs/flows/ticketing-and-documents.md
// §3 step 7 and §4) against PostgreSQL 16 and Redis 7.
//
// The file runs the real worker module graph (WorkerModule.forRoot: DocumentsModule.forWorker with its `ota-documents`
// consumer, and BookingsWorkerModule's OrderRecorder) on a clone of the @velexis/testing template (`tenant_alpha` and
// `tenant_beta` provisioned), a Redis database of its own and a storage folder of its own (STORAGE_DIR). It plays the
// platform (two active tenants, as velexis_migrator) and writes the bookings as the record step leaves them, through
// `tenantTx` as velexis_ota_app: a confirmed round trip CDG–LHR for two adults whose passports are sealed in
// `documents_ciphertext` as the record step seals them (BookingTravelerDocuments), with `document_last4` readable.
// Alpha has a square PNG logo in `storefront_assets`, stored under its storage prefix; beta has none (the logo tests at
// the end give beta asset rows that must not be embedded, and remove them from its settings again).
//
// The booking events are written with the worker's OrderRecorder.event in a TenantTx transaction, as checkout.complete,
// the ticketing job and the reconciliation write them, so the documents are asked for exactly as in production; the
// file waits for the jobs by their deduplication ids (the job keys).
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
  type TenantSchema,
} from "@velexis/db";
import { LocalDiskStorage } from "@velexis/db/storage";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { Job, type Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { BookingTravelerDocuments, OrderRecorder } from "../../../src/bookings/order-recorder";
import { MASK } from "../../../src/checkout/traveler-documents";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import {
  DOCUMENT_RENDER_JOB,
  DOCUMENT_STORAGE,
  DocumentRenderService,
  documentRenderJob,
  documentRenderKey,
  type DocumentRenderJobData,
  type DocumentRenderJobResult,
} from "../../../src/documents/documents.processor";
import { DocumentsRepository, FAILED_CONTENT_HASH } from "../../../src/documents/documents.repository";
import { jobTenant } from "../../../src/jobs/fan-out";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { PlatformCache } from "../../../src/tenancy/platform-cache";
import { TenantContext } from "../../../src/tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildStoredPassport } from "../../builders/bookings";
import { testWorkerVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { pdfText } from "../../support/pdf-text";

/**
 * Cloning the template, opening the pools, starting the worker graph and the first render (pdfmake, pdfkit and the
 * fonts are loaded once) take a few seconds locally and longer on a busy 4-CPU runner: all of it happens once, here.
 */
const SETUP_TIMEOUT_MS = 30_000;
/** How long a test waits at most for the worker to finish the jobs it asked for (they take a few hundred ms). */
const JOB_WAIT = { timeout: 4000, interval: 25 } as const;

const quietPoolLogger = { error: (): void => undefined };

type TenantKey = "alpha" | "beta";

let db: TestDatabase;
let redis: TestRedis;
let storageDir: string;
let storage: LocalDiskStorage;
let sink: MemorySink;
let app: INestApplicationContext;
let migratorPool: ReturnType<typeof createPool>;
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let documents: Queue;
const tenants: Record<TenantKey, string> = { alpha: "", beta: "" };

const tx = <T>(key: TenantKey, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, `tenant_${key}`, run);

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A PNG of one colour, built by hand (signature, IHDR, IDAT, IEND). */
function pngLogo(size: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x2a)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function insertTenant(key: TenantKey): Promise<void> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  tenants[key] = id;
}

/** Alpha's square logo: the asset row and its file under alpha's storage prefix. */
async function insertLogo(): Promise<void> {
  const bytes = pngLogo(32);
  const hash = sha256(bytes);
  const assetId = newId("ast");
  const storageKey = `tenant_alpha/assets/${hash}.png`;
  await storage.put(storageKey, bytes, "image/png");
  await tx("alpha", async (trx) => {
    await trx
      .insertInto("storefront_assets")
      .values({
        id: assetId,
        kind: "logo_square",
        content_type: "image/png",
        file_extension: "png",
        file_name: "logo.png",
        size_bytes: bytes.length,
        width: 32,
        height: 32,
        storage_key: storageKey,
        content_hash: hash,
      })
      .execute();
    await trx.updateTable("storefront_settings").set({ logo_square_asset_id: assetId }).execute();
  });
}

interface SeededBooking {
  readonly id: string;
  readonly key: TenantKey;
  readonly reference: string;
  /** The travellers' full passport numbers (sealed in the database, never in a document). */
  readonly passports: readonly string[];
  readonly travelerIds: readonly string[];
}

/** A confirmed round trip of two adults, as the record step leaves it (see the file header). */
async function insertBooking(key: TenantKey): Promise<SeededBooking> {
  const id = newId("bkg");
  const reference = newBookingReference();
  const sealer = app.get(BookingTravelerDocuments, { strict: false });
  const passports = [buildStoredPassport(), buildStoredPassport()];
  const travelerIds = passports.map(() => newId("btr"));
  const departure = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  await tx(key, async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference,
        status: "confirmed",
        amadeus_order_id: `eJzTd9f3${randomBytes(6).toString("hex")}`,
        record_locator: randomBytes(3).toString("hex").toUpperCase(),
        origin_system_code: "1A",
        ticketing_status: "pending",
        trip_type: "round_trip",
        origin_iata: "CDG",
        destination_iata: "LHR",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 7 * 24 * 60 * 60_000),
        currency: "EUR",
        net_amount: "200.00",
        total_amount: "236.40",
        amount_paid: "236.40",
        validating_carrier: "AF",
        contact_email: `traveller-${randomBytes(4).toString("hex")}@example.com`,
        lead_last_name: "SAMPLE",
      })
      .execute();
    for (const [index, passport] of passports.entries()) {
      const travelerId = travelerIds[index] ?? "";
      const sealed = await sealer.seal(`tenant_${key}` as TenantSchema, travelerId, [passport], []);
      await trx
        .insertInto("booking_travelers")
        .values({
          id: travelerId,
          booking_id: id,
          amadeus_traveler_id: String(index + 1),
          traveler_type: "ADULT",
          first_name: `TESTA${"BC"[index] ?? ""}`,
          last_name: "SAMPLE",
          documents_ciphertext: sealed.documentsCiphertext,
          encryption_key_id: sealed.encryptionKeyId,
          document_type: passport.documentType,
          document_last4: passport.number.slice(-4),
          // One millisecond apart: the travellers' order.
          created_at: new Date(Date.now() + index),
        })
        .execute();
    }
    for (const [index, [from, to, flight, day]] of (
      [
        ["CDG", "LHR", "1080", 30],
        ["LHR", "CDG", "1081", 37],
      ] as const
    ).entries()) {
      const local = new Date(Date.now() + day * 24 * 60 * 60_000).toISOString().slice(0, 10);
      await trx
        .insertInto("booking_segments")
        .values({
          id: newId("seg"),
          booking_id: id,
          amadeus_flight_offer_id: "1",
          amadeus_segment_id: String(index + 1),
          itinerary_index: index,
          segment_index: 0,
          carrier_code: "AF",
          flight_number: flight,
          departure_iata: from,
          departure_local: `${local}T09:30:00`,
          departure_at: new Date(`${local}T08:30:00Z`),
          arrival_iata: to,
          arrival_local: `${local}T10:00:00`,
          arrival_at: new Date(`${local}T09:00:00Z`),
          cabin: "ECONOMY",
          booking_class: "Y",
          included_checked_bags: JSON.stringify({ quantity: 1 }),
        })
        .execute();
    }
  });
  return { id, key, reference, passports: passports.map((passport) => passport.number), travelerIds };
}

/**
 * Writes the booking event `type` with the worker's OrderRecorder in a TenantTx transaction of the booking's tenant,
 * after `change` (the state change the event records); `fail` rolls the transaction back after the event.
 */
async function bookingEvent(
  booking: SeededBooking,
  type: string,
  change: (trx: TenantTransaction) => Promise<void> = () => Promise.resolve(),
  options: { readonly fail?: boolean } = {},
): Promise<void> {
  const tenant = await app.get(PlatformCache, { strict: false }).tenantById(tenants[booking.key]);
  if (tenant === null) {
    throw new Error(`tenant ${booking.key} is not readable`);
  }
  const requestId = `documents-test-${randomBytes(4).toString("hex")}`;
  const recorder = app.get(OrderRecorder, { strict: false });
  await app
    .get(TenantContext, { strict: false })
    .run(jobTenant(tenant, { id: requestId, name: "test" }), () =>
      app.get(TenantTx, { strict: false }).run(async (trx) => {
        await change(trx);
        await recorder.event(trx, booking.id, {
          type,
          actor: { type: "system", id: null },
          summary: `Test event ${type}.`,
          visibleToCustomer: true,
          requestId,
          now: new Date(),
        });
        if (options.fail === true) {
          throw new Error("rolled back in the test");
        }
      }),
    );
}

/** The booking's version. */
async function versionOf(booking: SeededBooking): Promise<number> {
  return await tx(booking.key, async (trx) => {
    const row = await trx
      .selectFrom("bookings")
      .select("version")
      .where("id", "=", booking.id)
      .executeTakeFirstOrThrow();
    return row.version;
  });
}

/** The finished job of a key (its deduplication id), waiting for it; its result. */
async function finished(key: string): Promise<DocumentRenderJobResult> {
  const job = await vi.waitFor(async () => {
    const id = await documents.getDeduplicationJobId(key);
    const found = id === null ? undefined : await Job.fromId(documents, id);
    const state = await found?.getState();
    if (found === undefined || (state !== "completed" && state !== "failed")) {
      throw new Error(`job ${key} has not finished`);
    }
    return found;
  }, JOB_WAIT);
  expect(await job.getState(), `job ${key}: ${job.failedReason ?? ""}`).toBe("completed");
  return job.returnvalue as DocumentRenderJobResult;
}

/** The key of a document of the booking at its current version. */
async function keyOf(
  booking: SeededBooking,
  kind: DocumentRenderJobData["kind"],
  ticketId?: string,
): Promise<string> {
  return documentRenderKey({
    bookingId: booking.id,
    kind,
    bookingVersion: await versionOf(booking),
    ...(ticketId === undefined ? {} : { ticketId }),
  });
}

/** The booking's `booking_documents` rows, oldest first. */
async function documentsOf(booking: SeededBooking) {
  return await tx(booking.key, (trx) =>
    trx
      .selectFrom("booking_documents")
      .select([
        "id",
        "kind",
        "status",
        "booking_ticket_id as ticketId",
        "storage_key as storageKey",
        "content_hash as contentHash",
        "size_bytes as sizeBytes",
        "file_name as fileName",
        "content_type as contentType",
        "locale",
      ])
      .where("booking_id", "=", booking.id)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );
}

/** The stored file of a document row. */
async function fileOf(row: { readonly storageKey: string }): Promise<Buffer> {
  const bytes = await storage.get(row.storageKey);
  if (bytes === null) {
    throw new Error(`nothing stored at ${row.storageKey}`);
  }
  return bytes;
}

/** Stores the booking's e-tickets (and an EMD, which gets no receipt), `ticketed`, as the ticketing job does. */
async function ticketsStored(booking: SeededBooking): Promise<Array<{ id: string; number: string }>> {
  const tickets = booking.travelerIds.map((travelerId, index) => ({
    id: newId("tkt"),
    travelerId,
    number: `057-${randomBytes(5).readUIntBE(0, 5).toString().padStart(10, "0").slice(0, 10)}`,
    amadeus: String(index + 1),
  }));
  await bookingEvent(booking, "booking.ticketed", async (trx) => {
    for (const ticket of tickets) {
      await trx
        .insertInto("booking_tickets")
        .values({
          id: ticket.id,
          booking_id: booking.id,
          booking_traveler_id: ticket.travelerId,
          amadeus_traveler_id: ticket.amadeus,
          document_type: "ETICKET",
          document_number: ticket.number,
          status: "ISSUED",
          segment_ids: ["1", "2"],
          validating_carrier: "AF",
          issued_at: new Date(),
        })
        .execute();
    }
    await trx
      .insertInto("booking_tickets")
      .values({
        id: newId("tkt"),
        booking_id: booking.id,
        amadeus_traveler_id: "1",
        document_type: "EMD",
        document_number: "057-9999999999",
        status: "ISSUED",
        issued_at: new Date(),
      })
      .execute();
    await trx
      .updateTable("bookings")
      .set({ status: "ticketed", ticketing_status: "issued", version: sql`version + 1` })
      .where("id", "=", booking.id)
      .execute();
  });
  return tickets.map(({ id, number }) => ({ id, number }));
}

beforeAll(async () => {
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  storageDir = mkdtempSync(join(tmpdir(), "velexis-ota-documents-"));
  storage = new LocalDiskStorage(storageDir);
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
  for (const key of ["alpha", "beta"] as const) {
    await insertTenant(key);
    await tx(key, async (trx) => {
      await seedStorefrontSettings(trx, {
        name: `${key} Travel`,
        defaultCurrency: "EUR",
        defaultLocale: "en",
      });
      await trx
        .updateTable("storefront_settings")
        .set({ support_email: `help@${key}-travel.example`, time_zone: "Europe/Paris" })
        .execute();
    });
  }
  await insertLogo();

  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
    STORAGE_DIR: storageDir,
  });
  sink = new MemorySink();
  useNextApplicationLoggerOutsideRequests();
  app = await createWorkerApp(WorkerModule.forRoot(config, { logger: createWorkerLogger(config, sink) }));
  await app.init();
  documents = app.get<Queue>(getQueueToken(OTA_QUEUE.documents));
  const maintenance = app.get<Queue>(getQueueToken(OTA_QUEUE.maintenance));
  // No scheduler iteration may fire during the file.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
  if (storageDir !== undefined) {
    rmSync(storageDir, { recursive: true, force: true });
  }
});

describe("an order recorded (booking.created)", () => {
  let booking: SeededBooking;
  let itineraryKey: string;
  let first: DocumentRenderJobResult;

  beforeAll(async () => {
    booking = await insertBooking("alpha");
    itineraryKey = await keyOf(booking, "itinerary");
    await bookingEvent(booking, "booking.created");
    first = await finished(itineraryKey);
  }, SETUP_TIMEOUT_MS);

  it("[OBE-053 AC1] renders the itinerary once per booking version: one row, its SHA-256 and the stored file", async () => {
    expect(first).toMatchObject({ tenantId: tenants.alpha, bookingId: booking.id, outcome: "rendered" });
    const rows = await documentsOf(booking);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined || first.outcome !== "rendered") {
      throw new Error("no itinerary");
    }
    expect(row).toMatchObject({
      id: first.documentId,
      kind: "itinerary",
      status: "ready",
      ticketId: null,
      contentType: "application/pdf",
      locale: "en",
      fileName: `${booking.reference}-itinerary.pdf`,
      storageKey: `tenant_alpha/documents/${booking.id}/${first.documentId}.pdf`,
    });
    const bytes = await fileOf(row);
    expect(row.contentHash).toBe(sha256(bytes));
    expect(row.sizeBytes).toBe(bytes.length);
    expect(statSync(join(storageDir, ...row.storageKey.split("/"))).mode & 0o777).toBe(0o600);
  });

  it("[OBE-053 AC1] a second job of the same key is not added, and rendering the version again is a no-op with the same hash", async () => {
    const data: DocumentRenderJobData = {
      tenantId: tenants.alpha,
      bookingId: booking.id,
      kind: "itinerary",
      bookingVersion: await versionOf(booking),
    };
    const firstJobId = await documents.getDeduplicationJobId(itineraryKey);
    const again = documentRenderJob(data);
    const added = await documents.add(again.name, again.data, again.opts);
    expect(added.id).toBe(firstJobId);

    const tenant = await app.get(PlatformCache, { strict: false }).tenantById(tenants.alpha);
    if (tenant === null || first.outcome !== "rendered") {
      throw new Error("no tenant or itinerary");
    }
    const rerendered = await app
      .get(TenantContext, { strict: false })
      .run(jobTenant(tenant, { id: "rerender", name: DOCUMENT_RENDER_JOB }), () =>
        app.get(DocumentRenderService).render(tenant, data),
      );

    expect(rerendered).toEqual({
      outcome: "unchanged",
      documentId: first.documentId,
      contentHash: first.contentHash,
      superseded: 0,
    });
    const rows = await documentsOf(booking);
    expect(rows.map((row) => [row.id, row.status, row.contentHash])).toEqual([
      [first.documentId, "ready", first.contentHash],
    ]);
  });

  it("shows the booking, alpha's logo and the travellers' passports masked", async () => {
    const [row] = await documentsOf(booking);
    if (row === undefined) {
      throw new Error("no itinerary");
    }
    const bytes = await fileOf(row);
    const text = pdfText(bytes);

    expect(bytes.toString("latin1")).toMatch(/\/Subtype \/Image/);
    for (const expected of [
      booking.reference,
      "alpha Travel",
      "Paris (CDG)",
      "London (LHR)",
      "AF 1080",
      "EUR 236.40",
    ]) {
      expect(text, expected).toContain(expected);
    }
    for (const passport of booking.passports) {
      expect(text).toContain(`Passport ${MASK}${passport.slice(-4)}`);
    }
  });
});

describe("tickets stored (booking.ticketed)", () => {
  let booking: SeededBooking;
  let tickets: Array<{ id: string; number: string }>;
  let firstItinerary: string;

  beforeAll(async () => {
    booking = await insertBooking("alpha");
    const created = await keyOf(booking, "itinerary");
    await bookingEvent(booking, "booking.created");
    const result = await finished(created);
    firstItinerary = result.outcome === "rendered" ? result.documentId : "";
    tickets = await ticketsStored(booking);
    await finished(await keyOf(booking, "itinerary"));
    for (const ticket of tickets) {
      await finished(await keyOf(booking, "e_ticket_receipt", ticket.id));
    }
  }, SETUP_TIMEOUT_MS);

  it("[OBE-053 AC2] gives one receipt per e-ticket, and the earlier itinerary becomes superseded", async () => {
    const rows = await documentsOf(booking);
    const receipts = rows.filter((row) => row.kind === "e_ticket_receipt");
    const itineraries = rows.filter((row) => row.kind === "itinerary");

    expect(receipts.map((row) => [row.ticketId, row.status]).sort()).toEqual(
      tickets.map((ticket) => [ticket.id, "ready"]).sort(),
    );
    expect(itineraries.map((row) => [row.id === firstItinerary, row.status])).toEqual([
      [true, "superseded"],
      [false, "ready"],
    ]);
    for (const row of receipts) {
      const ticket = tickets.find((candidate) => candidate.id === row.ticketId);
      const bytes = await fileOf(row);
      expect(row.contentHash).toBe(sha256(bytes));
      expect(row.fileName).toBe(
        `${booking.reference}-eticket-${(ticket?.number ?? "").replace("-", "")}.pdf`,
      );
      expect(pdfText(bytes)).toContain(`Ticket ${ticket?.number ?? "missing"}`);
    }
    const current = itineraries.find((row) => row.status === "ready");
    const text = pdfText(await fileOf(current ?? { storageKey: "missing" }));
    for (const ticket of tickets) {
      expect(text).toContain(ticket.number);
    }
  });

  it("[OBE-053 AC3] shows no traveller's document number in full in any document, only the masked form", async () => {
    const rows = (await documentsOf(booking)).filter((row) => row.status !== "failed");
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const bytes = await fileOf(row);
      const text = pdfText(bytes);
      for (const passport of booking.passports) {
        expect(text, row.kind).not.toContain(passport);
        expect(bytes.toString("latin1"), row.kind).not.toContain(passport);
      }
      // The itinerary shows every traveller's document masked, a receipt its passenger's.
      const masked = booking.passports.filter((passport) => text.includes(`${MASK}${passport.slice(-4)}`));
      expect(masked, row.kind).toHaveLength(row.kind === "itinerary" ? 2 : 1);
    }
    // Nor does any log line of the worker carry one, or a traveller's name.
    for (const passport of booking.passports) {
      expect(sink.text()).not.toContain(passport);
    }
    expect(sink.text()).not.toContain("TESTAB");
  });
});

describe("a cancellation (booking.cancelled)", () => {
  let booking: SeededBooking;

  beforeAll(async () => {
    booking = await insertBooking("alpha");
    const created = await keyOf(booking, "itinerary");
    await bookingEvent(booking, "booking.created");
    await finished(created);
    await bookingEvent(booking, "booking.cancelled", async (trx) => {
      await trx
        .updateTable("bookings")
        .set({
          status: "cancelled",
          cancelled_at: new Date(),
          cancelled_by: "staff",
          version: sql`version + 1`,
        })
        .where("id", "=", booking.id)
        .execute();
    });
    await finished(await keyOf(booking, "itinerary"));
  }, SETUP_TIMEOUT_MS);

  it("renders a new itinerary marked cancelled and supersedes the earlier one", async () => {
    const rows = await documentsOf(booking);

    expect(rows.map((row) => [row.kind, row.status])).toEqual([
      ["itinerary", "superseded"],
      ["itinerary", "ready"],
    ]);
    const text = pdfText(await fileOf(rows[1] ?? { storageKey: "missing" }));
    expect(text).toContain("This booking was cancelled on");
    expect(text).toContain("CANCELLED");
  });
});

describe("the request after the commit", () => {
  it("is dropped with a transaction that rolls back", async () => {
    const booking = await insertBooking("alpha");
    const key = await keyOf(booking, "itinerary");

    await expect(bookingEvent(booking, "booking.created", undefined, { fail: true })).rejects.toThrow(
      "rolled back in the test",
    );

    expect(await documents.getDeduplicationJobId(key)).toBe(null);
    expect(await documentsOf(booking)).toEqual([]);
  });

  it("is not made for an event that changes no document", async () => {
    const booking = await insertBooking("alpha");
    const key = await keyOf(booking, "itinerary");

    await bookingEvent(booking, "booking.ticketing_failed");

    expect(await documents.getDeduplicationJobId(key)).toBe(null);
  });

  it("never fails the event's transaction when Redis refuses the jobs: the event stays committed and the failure is logged", async () => {
    const booking = await insertBooking("alpha");
    const key = await keyOf(booking, "itinerary");
    const addBulk = vi.spyOn(documents, "addBulk").mockRejectedValueOnce(new Error("refused in the test"));
    try {
      await expect(bookingEvent(booking, "booking.created")).resolves.toBeUndefined();
      expect(addBulk).toHaveBeenCalledTimes(1);
    } finally {
      addBulk.mockRestore();
    }

    expect(await documents.getDeduplicationJobId(key)).toBe(null);
    const events = await tx(booking.key, (trx) =>
      trx.selectFrom("booking_events").select("type").where("booking_id", "=", booking.id).execute(),
    );
    expect(events.map((event) => event.type)).toEqual(["booking.created"]);
    expect(sink.records()).toContainEqual(
      expect.objectContaining({ msg: "documents.enqueue_failed", tenantId: tenants.alpha, jobs: 1 }),
    );
  });
});

describe("a render that fails", () => {
  it("writes one failed row, which supersedes nothing, and the next successful render supersedes it", async () => {
    const booking = await insertBooking("beta");
    const tenant = await app.get(PlatformCache, { strict: false }).tenantById(tenants.beta);
    if (tenant === null) {
      throw new Error("beta is not readable");
    }
    const data: DocumentRenderJobData = {
      tenantId: tenants.beta,
      bookingId: booking.id,
      kind: "itinerary",
      bookingVersion: await versionOf(booking),
    };
    const render = () =>
      app
        .get(TenantContext, { strict: false })
        .run(jobTenant(tenant, { id: "failing-render", name: DOCUMENT_RENDER_JOB }), () =>
          app.get(DocumentRenderService).render(tenant, data),
        );
    const adapter = app.get<LocalDiskStorage>(DOCUMENT_STORAGE);
    const put = vi.spyOn(adapter, "put").mockRejectedValue(new Error("disk full in the test"));

    await expect(render()).rejects.toThrow("disk full in the test");
    await expect(render()).rejects.toThrow("disk full in the test");
    const failed = await documentsOf(booking);
    expect(failed.map((row) => [row.status, row.contentHash, row.sizeBytes, row.fileName])).toEqual([
      ["failed", FAILED_CONTENT_HASH, null, `${booking.reference}-itinerary.pdf`],
    ]);
    // Nothing is stored at a failed row's key.
    expect(await storage.get(failed[0]?.storageKey ?? "missing")).toBe(null);

    put.mockRestore();
    const result = await render();

    expect(result.outcome).toBe("rendered");
    const rows = await documentsOf(booking);
    expect(rows.map((row) => row.status)).toEqual(["superseded", "ready"]);
    expect(rows[1]?.storageKey).toMatch(new RegExp(`^tenant_beta/documents/${booking.id}/doc_`));
    // Beta has no logo.
    expect((await fileOf(rows[1] ?? { storageKey: "missing" })).toString("latin1")).not.toMatch(
      /\/Subtype \/Image/,
    );
  });
});

describe("a booking that changes while its document is rendered", () => {
  it("is read and rendered again, so an older render never replaces a newer one, and the older file is deleted", async () => {
    const booking = await insertBooking("beta");
    const tenant = await app.get(PlatformCache, { strict: false }).tenantById(tenants.beta);
    if (tenant === null) {
      throw new Error("beta is not readable");
    }
    const data: DocumentRenderJobData = {
      tenantId: tenants.beta,
      bookingId: booking.id,
      kind: "itinerary",
      bookingVersion: await versionOf(booking),
    };
    const repository = app.get(DocumentsRepository);
    const read = repository.renderSource.bind(repository);
    // Another writer cancels the booking right after the first read, before the document's write (T2).
    const renderSource = vi
      .spyOn(repository, "renderSource")
      .mockImplementationOnce(async (trx, bookingId) => {
        const source = await read(trx, bookingId);
        await tx("beta", (other) =>
          other
            .updateTable("bookings")
            .set({
              status: "cancelled",
              cancelled_at: new Date(),
              cancelled_by: "staff",
              version: sql`version + 1`,
            })
            .where("id", "=", bookingId)
            .execute(),
        );
        return source;
      });
    try {
      const result = await app
        .get(TenantContext, { strict: false })
        .run(jobTenant(tenant, { id: "changed-render", name: DOCUMENT_RENDER_JOB }), () =>
          app.get(DocumentRenderService).render(tenant, data),
        );

      expect(result.outcome).toBe("rendered");
      expect(renderSource).toHaveBeenCalledTimes(2);
    } finally {
      renderSource.mockRestore();
    }
    const rows = await documentsOf(booking);
    expect(rows.map((row) => row.status)).toEqual(["ready"]);
    expect(pdfText(await fileOf(rows[0] ?? { storageKey: "missing" }))).toContain("CANCELLED");
    // Only the stored version's file is left: the first round's was deleted.
    expect(readdirSync(join(storageDir, "tenant_beta", "documents", booking.id))).toEqual([
      `${rows[0]?.id ?? "missing"}.pdf`,
    ]);
  });
});

describe("tenant isolation", () => {
  it("never renders another tenant's booking: a job for alpha with beta's booking finds nothing", async () => {
    const booking = await insertBooking("beta");
    const job = documentRenderJob({
      tenantId: tenants.alpha,
      bookingId: booking.id,
      kind: "itinerary",
      bookingVersion: await versionOf(booking),
    });
    await documents.add(job.name, job.data, job.opts);

    expect(await finished(documentRenderKey(job.data))).toMatchObject({
      tenantId: tenants.alpha,
      outcome: "skipped",
      reason: "booking_not_found",
    });
    expect(await documentsOf(booking)).toEqual([]);
  });
});

describe("a job that is not document.render", () => {
  it("fails at once without retries", async () => {
    const bogus = await documents.add(DOCUMENT_RENDER_JOB, { tenantId: tenants.alpha, bookingId: "bkg_x" });

    const state = await vi.waitFor(async () => {
      const current = await bogus.getState();
      if (current !== "failed") {
        throw new Error(`job ${bogus.id ?? ""} is ${current}`);
      }
      return current;
    }, JOB_WAIT);

    expect(state).toBe("failed");
    expect((await Job.fromId(documents, bogus.id ?? ""))?.attemptsMade).toBe(1);
  });
});

describe("the square logo", () => {
  it("is embedded only from the tenant's own storage prefix, with its SHA-256 and as PNG or JPEG; otherwise the document is rendered without it", async () => {
    const booking = await insertBooking("beta");
    const tenant = await app.get(PlatformCache, { strict: false }).tenantById(tenants.beta);
    if (tenant === null) {
      throw new Error("beta is not readable");
    }
    const data: DocumentRenderJobData = {
      tenantId: tenants.beta,
      bookingId: booking.id,
      kind: "itinerary",
      bookingVersion: await versionOf(booking),
    };
    // Alpha's logo, which is in storage: never read for beta.
    const alphaLogo = await tx("alpha", (trx) =>
      trx
        .selectFrom("storefront_assets")
        .select(["storage_key as storageKey", "content_hash as contentHash"])
        .where("kind", "=", "logo_square")
        .executeTakeFirstOrThrow(),
    );
    // A file under beta's own prefix whose bytes are not the ones an asset row names.
    const other = pngLogo(16);
    const otherKey = `tenant_beta/assets/${sha256(other)}.png`;
    await storage.put(otherKey, other, "image/png");
    const cases = [
      { reason: "foreign_key", contentType: "image/png", ...alphaLogo },
      { reason: "content", contentType: "image/png", storageKey: otherKey, contentHash: sha256(pngLogo(32)) },
      {
        reason: "missing",
        contentType: "image/png",
        storageKey: `tenant_beta/assets/${"0".repeat(64)}.png`,
        contentHash: "0".repeat(64),
      },
      {
        reason: "format",
        contentType: "image/webp",
        storageKey: `tenant_beta/assets/${"1".repeat(64)}.webp`,
        contentHash: "1".repeat(64),
      },
    ] as const;
    try {
      for (const entry of cases) {
        const assetId = newId("ast");
        await tx("beta", async (trx) => {
          await trx
            .insertInto("storefront_assets")
            .values({
              id: assetId,
              kind: "logo_square",
              content_type: entry.contentType,
              file_extension: entry.contentType === "image/webp" ? "webp" : "png",
              file_name: "logo.png",
              size_bytes: other.length,
              storage_key: entry.storageKey,
              content_hash: entry.contentHash,
            })
            .execute();
          await trx.updateTable("storefront_settings").set({ logo_square_asset_id: assetId }).execute();
        });

        const result = await app
          .get(TenantContext, { strict: false })
          .run(jobTenant(tenant, { id: `logo-${entry.reason}`, name: DOCUMENT_RENDER_JOB }), () =>
            app.get(DocumentRenderService).render(tenant, data),
          );

        expect(["rendered", "unchanged"], entry.reason).toContain(result.outcome);
        expect(sink.records(), entry.reason).toContainEqual(
          expect.objectContaining({
            msg: "documents.logo_skipped",
            bookingId: booking.id,
            reason: entry.reason,
          }),
        );
      }
    } finally {
      await tx("beta", (trx) =>
        trx.updateTable("storefront_settings").set({ logo_square_asset_id: null }).execute(),
      );
    }
    // Every render gave the same document, without a logo: one ready row, and no image in its file.
    const rows = await documentsOf(booking);
    expect(rows.map((row) => row.status)).toEqual(["ready"]);
    expect((await fileOf(rows[0] ?? { storageKey: "missing" })).toString("latin1")).not.toMatch(
      /\/Subtype \/Image/,
    );
  });
});
