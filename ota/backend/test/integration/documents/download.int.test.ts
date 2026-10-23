// The downloads of booking documents (OBE-054; OADR-0013 item 9, ADR-0017, ota/docs/flows/ticketing-and-documents.md
// §3 step 8 and §7): bookings.listDocuments, bookings.getDocumentDownloadUrl and the file endpoint
// `GET /v1/files/{storageKey}?exp=…&sig=…` (downloadFile) against PostgreSQL 16 and Redis 7.
//
// The file clones the @velexis/testing template (`tenant_alpha` and `tenant_beta` provisioned), writes the platform
// rows as the platform does (two active OTAs on test storefronts, a test and a live secret key of alpha) and starts the
// API's module graph with a storage folder of its own (STORAGE_DIR) and the API host of production as
// PUBLIC_OTA_API_URL. The documents are written as the worker's render leaves them (documents.processor.ts): rows of
// `booking_documents` (a superseded and a ready itinerary, a ready e-ticket receipt, a failed rendering) and their
// files under `tenant_<key>/documents/<bookingId>/<documentId>.pdf` with their SHA-256. Signed URLs the API did not
// issue (expired ones, another OTA's) are signed with the test process's DOCUMENT_URL_KEY_FILE, the key the API reads.
// The edge's URLs are followed as Caddy forwards them: without the `/api` prefix, with the edge headers of the host.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigService } from "@nestjs/config";
import { hashApiKey, signUrl } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
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
import request, { type Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { bookingTokenHash } from "../../../src/common/auth/booking-access.guard";
import { Clock } from "../../../src/common/clock";
import { trackerDigest } from "../../../src/common/http/rate-limits";
import { newId } from "../../../src/common/ids";
import type { ApiConfig } from "../../../src/config";
import { DOCUMENT_DOWNLOADED_EVENT } from "../../../src/documents/document-downloads.service";
import { FAILED_CONTENT_HASH } from "../../../src/documents/documents.repository";
import { TokenService } from "../../../src/identity/token.service";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { edgeHeaders, newApiKey, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type Schema = "tenant_alpha" | "tenant_beta";

const ALPHA_HOST = "alpha.ota.example.com";
const BETA_HOST = "beta.ota.example.com";
const PUBLIC_API_URL = "https://api.ota.example.com";
const DAY = 24 * 60 * 60_000;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let storageDir: string;
let storage: LocalDiskStorage;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let tokens: TokenService;
let alphaId: string;
let betaId: string;
let alphaSk: string;
let alphaLiveSk: string;

const inTenant = <T>(schema: Schema, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, schema, run);

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function insertTenant(key: "alpha" | "beta"): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  return id;
}

async function issueKey(tenantId: string, environment: "test" | "live"): Promise<string> {
  const key = newApiKey("sk", environment);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
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

/** A customer of alpha and an access token for it (bearer for keys, `__Host-vx_at` for the edge). */
async function newCustomer(): Promise<{ readonly id: string; readonly token: string }> {
  const id = newId("cus");
  await inTenant("tenant_alpha", (trx) =>
    trx
      .insertInto("customers")
      .values({
        id,
        email: `${id.toLowerCase()}@example.com`,
        email_verified_at: new Date(),
        first_name: "TESTA",
        last_name: "CUSTOMER",
      })
      .execute(),
  );
  const signed = await tokens.signCustomerToken({ sub: id, tid: alphaId, sid: newId("ses") });
  return { id, token: signed.token };
}

/** A confirmed booking of `schema`, owned by `customerId` or a guest's, with one e-ticket. */
async function insertBooking(
  schema: Schema,
  options: { readonly customerId?: string | null; readonly environment?: "test" | "live" } = {},
): Promise<{ readonly id: string; readonly ticketId: string; readonly reference: string }> {
  const id = newId("bkg");
  const ticketId = newId("tkt");
  const reference = newBookingReference();
  const departure = new Date(Date.now() + 30 * DAY);
  await inTenant(schema, async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: options.environment ?? "test",
        reference,
        customer_id: options.customerId ?? null,
        status: "ticketed",
        amadeus_order_id: `eJzTd9f3${randomBytes(6).toString("hex")}`,
        record_locator: randomBytes(3).toString("hex").toUpperCase(),
        origin_system_code: "1A",
        ticketing_status: "issued",
        trip_type: "one_way",
        origin_iata: "CDG",
        destination_iata: "LHR",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 2 * 60 * 60_000),
        currency: "EUR",
        net_amount: "200.00",
        total_amount: "236.40",
        amount_paid: "236.40",
        validating_carrier: "AF",
        contact_email: `traveller-${randomBytes(4).toString("hex")}@example.com`,
        lead_last_name: "SAMPLE",
      })
      .execute();
    await trx
      .insertInto("booking_tickets")
      .values({
        id: ticketId,
        booking_id: id,
        amadeus_traveler_id: "1",
        document_type: "ETICKET",
        document_number: `057${randomBytes(5).toString("hex").slice(0, 10).replace(/[a-f]/g, "7")}`,
        segment_ids: ["1"],
        issued_at: new Date(),
      })
      .execute();
  });
  return { id, ticketId, reference };
}

/** A document row as the render writes it, and its file unless it failed; created `agoMs` before now. */
interface SeededDocument {
  readonly id: string;
  readonly storageKey: string;
  readonly fileName: string;
  readonly bytes: Buffer;
}

async function insertDocument(
  schema: Schema,
  bookingId: string,
  document: {
    readonly kind: "itinerary" | "e_ticket_receipt";
    readonly status: "ready" | "superseded" | "failed";
    readonly agoMs: number;
    readonly ticketId?: string;
    readonly fileName: string;
  },
): Promise<SeededDocument> {
  const id = newId("doc");
  const storageKey = `${schema}/documents/${bookingId}/${id}.pdf`;
  const bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(64), Buffer.from("\n%%EOF\n")]);
  const failed = document.status === "failed";
  if (!failed) {
    await storage.put(storageKey, bytes, "application/pdf");
  }
  const createdAt = new Date(Date.now() - document.agoMs);
  await inTenant(schema, (trx) =>
    trx
      .insertInto("booking_documents")
      .values({
        id,
        booking_id: bookingId,
        booking_ticket_id: document.ticketId ?? null,
        kind: document.kind,
        status: document.status,
        locale: "en",
        file_name: document.fileName,
        content_type: "application/pdf",
        size_bytes: failed ? null : bytes.length,
        storage_key: storageKey,
        content_hash: failed ? FAILED_CONTENT_HASH : sha256(bytes),
        generated_by: "system",
        created_at: createdAt,
        updated_at: createdAt,
      })
      .execute(),
  );
  return { id, storageKey, fileName: document.fileName, bytes };
}

/** A guest token of the booking, as GuestAccessService issues it (only its hash is stored). */
async function insertGuestToken(bookingId: string): Promise<string> {
  const token = `vxbt_test_${randomBytes(32).toString("base64url")}`;
  await inTenant("tenant_alpha", (trx) =>
    trx
      .insertInto("booking_access_tokens")
      .values({
        id: newId("bat"),
        booking_id: bookingId,
        token_hash: bookingTokenHash(token),
        issued_via: "lookup",
        expires_at: new Date(Date.now() + 30 * DAY),
      })
      .execute(),
  );
  return token;
}

// ---- Requests ------------------------------------------------------------------------------------------------------

const bearer = (token: string, key = alphaSk): Record<string, string> => ({
  "X-Api-Key": key,
  Authorization: `Bearer ${token}`,
});
const edgeCustomer = (token: string, host = ALPHA_HOST): Record<string, string> => ({
  ...edgeHeaders(host),
  Cookie: `__Host-vx_at=${token}`,
});
const get = (path: string, headers: Record<string, string> = {}) =>
  request(api.server).get(path).set(headers);

/** The path and query the API receives for a URL it issued: the edge's without `/api`, a key caller's without origin. */
function forwardedPath(url: string): string {
  if (url.startsWith("/api/")) {
    return url.slice("/api".length);
  }
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/** A file URL signed with the API's key, valid until `expiresAt`: what the API would have issued for `storageKey`. */
const signedPath = (storageKey: string, expiresAt = new Date(Date.now() + 120_000)): string =>
  signUrl(`/v1/files/${storageKey}`, { expiresAt, key: testApiCredentials().documentUrlKey });

/** A binary answer's bytes (Supertest buffers `application/pdf` with this parser). */
function binary(res: request.Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
}

const download = (path: string, headers: Record<string, string> = {}) =>
  request(api.server).get(path).set(headers).buffer(true).parse(binary);

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly details?: JsonObject };
}
interface PageBody {
  readonly data: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly status: string }>;
  readonly page: { readonly nextCursor: string | null; readonly limit: number };
}
interface UrlBody {
  readonly documentId: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly fileName: string;
  readonly contentType: string;
}

const answer = (res: Response): [number, string | undefined] => [
  res.status,
  (res.body as Partial<ErrorBody>).error?.code,
];

async function downloadEvents(bookingId: string) {
  return await inTenant("tenant_alpha", (trx) =>
    trx
      .selectFrom("booking_events")
      .select(["actor_type as actorType", "actor_id as actorId", "visible_to_customer as visible", "data"])
      .where("booking_id", "=", bookingId)
      .where("type", "=", DOCUMENT_DOWNLOADED_EVENT)
      .orderBy("created_at")
      .execute(),
  );
}

// ---- The fixtures --------------------------------------------------------------------------------------------------

let customer: { readonly id: string; readonly token: string };
let otherCustomer: { readonly id: string; readonly token: string };
/** Alpha's booking of `customer`, with every kind of row. */
let owned: { readonly id: string; readonly ticketId: string; readonly reference: string };
let itineraryOld: SeededDocument;
let itinerary: SeededDocument;
let receipt: SeededDocument;
let failed: SeededDocument;
/** Alpha's guest booking, opened by `guestToken`. */
let guestBooking: { readonly id: string };
let guestToken: string;
let guestItinerary: SeededDocument;
/** Alpha's live booking of `customer`. */
let liveItinerary: SeededDocument;
/** Beta's booking and its itinerary. */
let betaItinerary: SeededDocument;

// Cloning the template, the platform rows, the documents and the API's module graph take several seconds alone and much
// longer on a busy 4-CPU runner: all of it happens once here, with its own budget.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["listBookingDocuments", [200, 400, 401, 404]],
    ["getBookingDocumentDownloadUrl", [200, 404, 409]],
    ["downloadFile", [400, 403, 404, 429, 500]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  storageDir = mkdtempSync(join(tmpdir(), "velexis-ota-downloads-"));
  storage = new LocalDiskStorage(storageDir);
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
  alphaId = await insertTenant("alpha");
  betaId = await insertTenant("beta");
  alphaSk = await issueKey(alphaId, "test");
  alphaLiveSk = await issueKey(alphaId, "live");
  tokens = new TokenService(
    { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>,
    new Clock(),
  );
  customer = await newCustomer();
  otherCustomer = await newCustomer();

  owned = await insertBooking("tenant_alpha", { customerId: customer.id });
  itineraryOld = await insertDocument("tenant_alpha", owned.id, {
    kind: "itinerary",
    status: "superseded",
    agoMs: 3 * 60_000,
    fileName: `${owned.reference}-itinerary.pdf`,
  });
  itinerary = await insertDocument("tenant_alpha", owned.id, {
    kind: "itinerary",
    status: "ready",
    agoMs: 2 * 60_000,
    fileName: `${owned.reference}-itinerary.pdf`,
  });
  receipt = await insertDocument("tenant_alpha", owned.id, {
    kind: "e_ticket_receipt",
    status: "ready",
    agoMs: 60_000,
    ticketId: owned.ticketId,
    fileName: `${owned.reference}-eticket.pdf`,
  });
  failed = await insertDocument("tenant_alpha", owned.id, {
    kind: "itinerary",
    status: "failed",
    agoMs: 30_000,
    fileName: `${owned.reference}-itinerary.pdf`,
  });

  guestBooking = await insertBooking("tenant_alpha");
  guestToken = await insertGuestToken(guestBooking.id);
  guestItinerary = await insertDocument("tenant_alpha", guestBooking.id, {
    kind: "itinerary",
    status: "ready",
    agoMs: 60_000,
    fileName: "GUEST-itinerary.pdf",
  });

  const live = await insertBooking("tenant_alpha", { customerId: customer.id, environment: "live" });
  liveItinerary = await insertDocument("tenant_alpha", live.id, {
    kind: "itinerary",
    status: "ready",
    agoMs: 60_000,
    fileName: "LIVE-itinerary.pdf",
  });

  const beta = await insertBooking("tenant_beta");
  betaItinerary = await insertDocument("tenant_beta", beta.id, {
    kind: "itinerary",
    status: "ready",
    agoMs: 60_000,
    fileName: "BETA-itinerary.pdf",
  });

  api = await createTestApp({
    database: db,
    redis,
    env: { STORAGE_DIR: storageDir, PUBLIC_OTA_API_URL: PUBLIC_API_URL },
  });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
  if (storageDir !== undefined) {
    rmSync(storageDir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  // No cached platform rows and no rate-limit counters from the previous test.
  await redis.client.flushdb();
});

// ---- bookings.listDocuments ----------------------------------------------------------------------------------------

describe("bookings.listDocuments", () => {
  it("lists the ready documents only, newest first, to the owner with a key or through the storefront", async () => {
    for (const headers of [bearer(customer.token), edgeCustomer(customer.token)]) {
      const res = await get(`/v1/bookings/${owned.id}/documents`, headers);

      expect(res.status).toBe(200);
      expectResponseToMatch("listBookingDocuments", res);
      const body = res.body as PageBody;
      // The superseded itinerary and the failed rendering are not listed.
      expect(body.data.map((document) => document.id)).toEqual([receipt.id, itinerary.id]);
      expect(body.data.map((document) => document.status)).toEqual(["ready", "ready"]);
      expect(body.page).toEqual({ nextCursor: null, limit: 20 });
      expect(res.headers["cache-control"]).toBe("private, no-store");
    }
  });

  it("filters by kind and pages with a cursor of that filter only", async () => {
    const itineraries = await get(
      `/v1/bookings/${owned.id}/documents?kind=itinerary`,
      bearer(customer.token),
    );
    expect((itineraries.body as PageBody).data.map((document) => document.id)).toEqual([itinerary.id]);

    const first = await get(`/v1/bookings/${owned.id}/documents?limit=1`, bearer(customer.token));
    const firstBody = first.body as PageBody;
    expect(firstBody.data.map((document) => document.id)).toEqual([receipt.id]);
    expect(firstBody.page.nextCursor).toEqual(expect.any(String));
    const cursor = encodeURIComponent(firstBody.page.nextCursor ?? "");
    const second = await get(
      `/v1/bookings/${owned.id}/documents?limit=1&cursor=${cursor}`,
      bearer(customer.token),
    );
    expect((second.body as PageBody).data.map((document) => document.id)).toEqual([itinerary.id]);
    expect((second.body as PageBody).page.nextCursor).toBeNull();

    // A cursor of the unfiltered list is not one of the itineraries' list.
    const mixed = await get(
      `/v1/bookings/${owned.id}/documents?kind=itinerary&cursor=${cursor}`,
      bearer(customer.token),
    );
    expect(answer(mixed)).toEqual([400, "VALIDATION_FAILED"]);
    expectResponseToMatch("listBookingDocuments", mixed);
  });

  it("opens a guest's booking with its token only: 401 without a credential, 404 for anyone else", async () => {
    const withHeader = await get(`/v1/bookings/${guestBooking.id}/documents`, {
      "X-Api-Key": alphaSk,
      "X-Booking-Token": guestToken,
    });
    const withCookie = await get(`/v1/bookings/${guestBooking.id}/documents`, {
      ...edgeHeaders(ALPHA_HOST),
      Cookie: `__Host-vx_bt=${guestBooking.id}.${guestToken}`,
    });
    expect([withHeader.status, withCookie.status]).toEqual([200, 200]);
    expect((withHeader.body as PageBody).data.map((document) => document.id)).toEqual([guestItinerary.id]);

    const anonymous = await get(`/v1/bookings/${guestBooking.id}/documents`, edgeHeaders(ALPHA_HOST));
    const otherCustomerList = await get(`/v1/bookings/${owned.id}/documents`, bearer(otherCustomer.token));
    const tokenOfAnother = await get(`/v1/bookings/${owned.id}/documents`, {
      "X-Api-Key": alphaSk,
      "X-Booking-Token": guestToken,
    });
    const liveKey = await get(`/v1/bookings/${owned.id}/documents`, bearer(customer.token, alphaLiveSk));

    expect(answer(anonymous)).toEqual([401, "UNAUTHENTICATED"]);
    expect([answer(otherCustomerList), answer(tokenOfAnother), answer(liveKey)]).toEqual([
      [404, "NOT_FOUND"],
      [404, "NOT_FOUND"],
      [404, "NOT_FOUND"],
    ]);
    expectResponseToMatch("listBookingDocuments", anonymous);
    expectResponseToMatch("listBookingDocuments", otherCustomerList);
  });
});

// ---- bookings.getDocumentDownloadUrl -------------------------------------------------------------------------------

describe("bookings.getDocumentDownloadUrl", () => {
  it("gives the edge a same-origin path and a key caller an absolute URL on api.ota.example.com [OBE-054 AC2]", async () => {
    const before = Date.now();
    const edge = await get(
      `/v1/bookings/${owned.id}/documents/${itinerary.id}/download-url`,
      edgeCustomer(customer.token),
    );
    const key = await get(
      `/v1/bookings/${owned.id}/documents/${itinerary.id}/download-url`,
      bearer(customer.token),
    );
    const after = Date.now();

    for (const res of [edge, key]) {
      expect(res.status).toBe(200);
      expectResponseToMatch("getBookingDocumentDownloadUrl", res);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const edgeBody = edge.body as UrlBody;
    const keyBody = key.body as UrlBody;
    const signedPrefix = `/v1/files/tenant_alpha/documents/${owned.id}/${itinerary.id}.pdf?exp=`;
    expect(edgeBody.url.startsWith(`/api${signedPrefix}`)).toBe(true);
    expect(keyBody.url.startsWith(`${PUBLIC_API_URL}${signedPrefix}`)).toBe(true);
    expect(new URL(keyBody.url).host).toBe("api.ota.example.com");
    for (const body of [edgeBody, keyBody]) {
      expect(body).toMatchObject({
        documentId: itinerary.id,
        fileName: itinerary.fileName,
        contentType: "application/pdf",
      });
      // `expiresAt` is the signed `exp`, five minutes after the call (rounded down to the second).
      const exp = Number(new URL(body.url, "https://alpha.ota.example.com").searchParams.get("exp")) * 1000;
      expect(new Date(body.expiresAt).getTime()).toBe(exp);
      expect(exp > before && exp <= after + 300_000).toBe(true);
    }
  });

  it("writes a staff-only document.downloaded event on every call", async () => {
    const guest = await get(`/v1/bookings/${guestBooking.id}/documents/${guestItinerary.id}/download-url`, {
      "X-Api-Key": alphaSk,
      "X-Booking-Token": guestToken,
    });
    const again = await get(`/v1/bookings/${guestBooking.id}/documents/${guestItinerary.id}/download-url`, {
      "X-Api-Key": alphaSk,
      "X-Booking-Token": guestToken,
    });
    expect([guest.status, again.status]).toEqual([200, 200]);

    const events = await downloadEvents(guestBooking.id);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        actorType: "api_key",
        visible: false,
        data: { documentId: guestItinerary.id, kind: "itinerary", via: "booking_token" },
      });
    }
    // Not on the customer's timeline.
    const timeline = await get(`/v1/bookings/${guestBooking.id}/events`, {
      "X-Api-Key": alphaSk,
      "X-Booking-Token": guestToken,
    });
    expect(JSON.stringify(timeline.body)).not.toContain(DOCUMENT_DOWNLOADED_EVENT);
  });

  it("answers 409 DOCUMENT_NOT_READY for a failed rendering, serves a superseded version, and 404 elsewhere", async () => {
    const notReady = await get(
      `/v1/bookings/${owned.id}/documents/${failed.id}/download-url`,
      bearer(customer.token),
    );
    expect(answer(notReady)).toEqual([409, "DOCUMENT_NOT_READY"]);
    expect((notReady.body as ErrorBody).error.details).toEqual({
      documentId: failed.id,
      status: "failed",
      retryAfterSeconds: 30,
    });
    expectResponseToMatch("getBookingDocumentDownloadUrl", notReady);

    const superseded = await get(
      `/v1/bookings/${owned.id}/documents/${itineraryOld.id}/download-url`,
      bearer(customer.token),
    );
    expect(superseded.status).toBe(200);

    // Another booking's document through this booking, and an unknown document.
    const foreign = await get(
      `/v1/bookings/${owned.id}/documents/${guestItinerary.id}/download-url`,
      bearer(customer.token),
    );
    const unknown = await get(
      `/v1/bookings/${owned.id}/documents/${newId("doc")}/download-url`,
      bearer(customer.token),
    );
    expect([answer(foreign), answer(unknown)]).toEqual([
      [404, "NOT_FOUND"],
      [404, "NOT_FOUND"],
    ]);
    expectResponseToMatch("getBookingDocumentDownloadUrl", foreign);
  });

  it("answers 404 for a failed rendering that a newer version superseded: it has no file, so no URL and no event", async () => {
    // The render job supersedes every earlier row of a document, a failed one too (documents.processor.ts).
    const replaced = await insertDocument("tenant_alpha", owned.id, {
      kind: "itinerary",
      status: "failed",
      agoMs: 6 * 60_000,
      fileName: `${owned.reference}-itinerary.pdf`,
    });
    await inTenant("tenant_alpha", (trx) =>
      trx
        .updateTable("booking_documents")
        .set({ status: "superseded" })
        .where("id", "=", replaced.id)
        .execute(),
    );

    const res = await get(
      `/v1/bookings/${owned.id}/documents/${replaced.id}/download-url`,
      bearer(customer.token),
    );
    expect(answer(res)).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("getBookingDocumentDownloadUrl", res);
    const events = await downloadEvents(owned.id);
    expect(events.filter((event) => (event.data as JsonObject)["documentId"] === replaced.id)).toEqual([]);

    // A link to its key is a file that does not exist, not a file that went missing from storage.
    const linked = await get(signedPath(replaced.storageKey));
    expect(answer(linked)).toEqual([404, "NOT_FOUND"]);
    const missing = api.sink
      .records()
      .filter((line) => line["msg"] === "documents.file_missing" && line["documentId"] === replaced.id);
    expect(missing).toEqual([]);
  });
});

// ---- downloadFile --------------------------------------------------------------------------------------------------

describe("the file endpoint (downloadFile)", () => {
  it("serves the PDF at the edge's path and at the key caller's URL, without a credential for the latter [OBE-054 AC2]", async () => {
    const edge = (
      await get(`/v1/bookings/${owned.id}/documents/${receipt.id}/download-url`, edgeCustomer(customer.token))
    ).body as UrlBody;
    const key = (
      await get(`/v1/bookings/${owned.id}/documents/${receipt.id}/download-url`, bearer(customer.token))
    ).body as UrlBody;

    // The storefront's same-origin request, as Caddy forwards it, and a browser following the absolute URL.
    const fromStorefront = await download(forwardedPath(edge.url), edgeHeaders(ALPHA_HOST));
    const fromBrowser = await download(forwardedPath(key.url));

    for (const res of [fromStorefront, fromBrowser]) {
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body as Buffer, receipt.bytes)).toBe(0);
      expect(res.headers["content-type"]).toMatch(/^application\/pdf/);
      expect(res.headers["content-disposition"]).toBe(`attachment; filename="${receipt.fileName}"`);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-length"]).toBe(String(receipt.bytes.length));
    }
    // A signed URL is a credential: it never reaches the log.
    const sig = new URL(edge.url, "https://alpha.ota.example.com").searchParams.get("sig") ?? "missing";
    expect(api.sink.text()).not.toContain(sig);
    expect(api.sink.text()).not.toContain("exp=");
  });

  it("answers 403 to an expired link and to a tampered signature, path or expiry [OBE-054 AC1]", async () => {
    const issued = (
      await get(`/v1/bookings/${owned.id}/documents/${itinerary.id}/download-url`, bearer(customer.token))
    ).body as UrlBody;
    const path = forwardedPath(issued.url);
    const [base = "", query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    const sig = params.get("sig") ?? "";
    const exp = Number(params.get("exp"));
    const flipped = `${sig.charAt(5) === "A" ? "B" : "A"}`;

    const refused = [
      // Expired a second ago, signed with the API's own key.
      signedPath(itinerary.storageKey, new Date(Math.floor(Date.now() / 1000) * 1000 - 1000)),
      `${base}?exp=${exp}&sig=${sig.slice(0, 5)}${flipped}${sig.slice(6)}`,
      `${base.replace(itinerary.id, receipt.id)}?exp=${exp}&sig=${sig}`,
      `${base}?exp=${exp + 3600}&sig=${sig}`,
      `${path}&download=1`,
    ];
    for (const url of refused) {
      const res = await get(url, edgeHeaders(ALPHA_HOST));
      expect([url, answer(res)]).toEqual([url, [403, "FORBIDDEN"]]);
      expect((res.body as ErrorBody).error.message).toBe(
        "The download link is not valid or has expired; ask for a new one.",
      );
      expectResponseToMatch("downloadFile", res);
    }
    // The untouched link still works, from the storefront and without a credential.
    expect((await download(path, edgeHeaders(ALPHA_HOST))).status).toBe(200);
    expect((await download(path)).status).toBe(200);
    // A link without its signature is a malformed request.
    const unsigned = await get(`${base}?exp=${exp}`);
    expect(answer(unsigned)).toEqual([400, "VALIDATION_FAILED"]);
    expectResponseToMatch("downloadFile", unsigned);
  });

  it("answers 404 to another OTA's key through this OTA's storefront or key, and serves it to its own [OBE-054 AC1]", async () => {
    const betaLink = signedPath(betaItinerary.storageKey);

    const viaAlphaStorefront = await get(betaLink, edgeHeaders(ALPHA_HOST));
    const viaAlphaKey = await get(betaLink, { "X-Api-Key": alphaSk });
    expect([answer(viaAlphaStorefront), answer(viaAlphaKey)]).toEqual([
      [404, "NOT_FOUND"],
      [404, "NOT_FOUND"],
    ]);
    expectResponseToMatch("downloadFile", viaAlphaStorefront);

    const viaBetaStorefront = await download(betaLink, edgeHeaders(BETA_HOST));
    const withoutCredential = await download(betaLink);
    for (const res of [viaBetaStorefront, withoutCredential]) {
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body as Buffer, betaItinerary.bytes)).toBe(0);
    }
    // The refusal is a security event of the request's tenant, without the link.
    const events = api.sink.records().filter((line) => line["securityEvent"] === "documents.foreign_file");
    expect(events.map((line) => line["tenantId"])).toEqual([alphaId, alphaId]);
  });

  it("answers 404 for a suspended OTA, the other environment, a failed rendering and a missing file", async () => {
    // A suspended OTA serves nothing (PADR-0014), also without a credential.
    await migrator
      .updateTable("platform.tenants")
      .set({ status: "suspended" })
      .where("id", "=", betaId)
      .execute();
    try {
      const suspended = await get(signedPath(betaItinerary.storageKey));
      expect(answer(suspended)).toEqual([404, "NOT_FOUND"]);
    } finally {
      await migrator
        .updateTable("platform.tenants")
        .set({ status: "active" })
        .where("id", "=", betaId)
        .execute();
      await redis.client.flushdb();
    }

    // A live booking's document with alpha's test key; without a credential the signature alone decides.
    const liveLink = signedPath(liveItinerary.storageKey);
    expect(answer(await get(liveLink, { "X-Api-Key": alphaSk }))).toEqual([404, "NOT_FOUND"]);
    expect((await download(liveLink, { "X-Api-Key": alphaLiveSk })).status).toBe(200);
    expect((await download(liveLink)).status).toBe(200);

    // A failed rendering has no file, and neither has a key no document row names.
    expect(answer(await get(signedPath(failed.storageKey)))).toEqual([404, "NOT_FOUND"]);
    const unknownKey = `tenant_alpha/documents/${owned.id}/${newId("doc")}.pdf`;
    expect(answer(await get(signedPath(unknownKey)))).toEqual([404, "NOT_FOUND"]);

    // A ready row whose file is gone, and one whose file no longer has its hash.
    const gone = await insertDocument("tenant_alpha", owned.id, {
      kind: "e_ticket_receipt",
      status: "superseded",
      agoMs: 4 * 60_000,
      ticketId: owned.ticketId,
      fileName: "GONE-eticket.pdf",
    });
    await storage.delete(gone.storageKey);
    expect(answer(await get(signedPath(gone.storageKey)))).toEqual([404, "NOT_FOUND"]);
    const changed = await insertDocument("tenant_alpha", owned.id, {
      kind: "e_ticket_receipt",
      status: "superseded",
      agoMs: 5 * 60_000,
      ticketId: owned.ticketId,
      fileName: "CHANGED-eticket.pdf",
    });
    await storage.put(changed.storageKey, Buffer.from("%PDF-1.7 something else"), "application/pdf");
    const corrupt = await get(signedPath(changed.storageKey));
    expect(answer(corrupt)).toEqual([500, "INTERNAL_ERROR"]);
    expectResponseToMatch("downloadFile", corrupt);
  });

  it("counts the downloads against 120 per minute per IP", async () => {
    const link = signedPath(itinerary.storageKey);
    await redis.client.set(`rl:ota_downloads:${trackerDigest("ip", "198.51.100.54")}`, "120", "EX", 60);

    const limited = await get(link).set("X-Forwarded-For", "198.51.100.54");
    const otherIp = await download(link, { "X-Forwarded-For": "198.51.100.55" });

    expect(answer(limited)).toEqual([429, "RATE_LIMITED"]);
    expectResponseToMatch("downloadFile", limited);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(otherIp.status).toBe(200);
    expect(await redis.client.get(`rl:ota_downloads:${trackerDigest("ip", "198.51.100.55")}`)).toBe("1");
  });
});
