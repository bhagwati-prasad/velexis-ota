// The response headers of the OTA API (OBE-084 step 2; ota/docs/security-review.md §3.3, architecture §3 step 3,
// common/http/http.module.ts `HELMET_OPTIONS`, the document's `Cache-Control` of each operation, OADR-0012 point 3,
// OADR-0013 item 9): every kind of answer carries helmet's headers for a JSON API, aligned with Caddy's
// `security_headers`, and never `X-Powered-By`; every answer with personal data or a session is never cached
// (`Cache-Control` with `no-store`), every error included; the downloads of booking documents and the public images
// carry `X-Content-Type-Options: nosniff`, their own type and their own caching.
//
// The file clones the @velexis/testing template and writes alpha's platform rows as the platform does (an active OTA on
// its test storefront, an owner and a portal token for it); alpha's customer gets a token as the API signs one, and owns
// a ticketed booking with a ready itinerary whose file lies in a storage folder of the file's own (STORAGE_DIR); the
// owner uploads a storefront image through the console. All requests run in a `beforeAll` hook; the tests read what
// the API answered.
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@velexis/crypto";
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
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { STOREFRONT_COOKIES } from "../../../src/common/http/cookie-writer";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { hashCustomerPassword } from "../../../src/identity/sign-in.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildPng } from "../../builders/images";
import { newCsrfToken, TEST_STOREFRONT_BASE_DOMAIN, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const HOST = `alpha.${TEST_STOREFRONT_BASE_DOMAIN}`;
const DAY = 24 * 60 * 60_000;
const PASSWORD = `Fjord-${randomBytes(9).toString("base64url")}`;
const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/** About forty requests and an image upload: well under a second; the budget only stops a hang. */
const REQUESTS_TIMEOUT_MS = 60_000;

/** helmet's headers of a JSON answer (HELMET_OPTIONS), as Caddy's `security_headers` sends them on the public hosts. */
const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  // helmet joins the directives without a space; Caddy's `security_headers` replaces nothing of it on the API hosts.
  "content-security-policy": "default-src 'none';frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let storageDir: string;
let alphaId = "";
let customerToken = "";
let staffToken = "";
let bookingId = "";
let documentPath = "";
let assetPath = "";

const inAlpha = <T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", fn);

// ---- Fixtures ------------------------------------------------------------------------------------------------------

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** An owner of alpha signed in through the OTA admin's service key: its access token. */
async function ownerSession(): Promise<string> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: `owner.${randomBytes(4).toString("hex")}@example.com`,
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
    .values({ id: staffId, tenant_id: alphaId, account_id: accountId, role: "owner", status: "active" })
    .execute();
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  await redis.client.set(
    redisKeys.portalToken(sha256Hex(token)).key,
    JSON.stringify({
      v: 1,
      accountId,
      tenantId: alphaId,
      membershipId: staffId,
      role: "owner",
      mfa: true,
      issuedAt: new Date().toISOString(),
      requestId: randomUUID(),
    }),
    "EX",
    300,
    "NX",
  );
  const res = await request(api.server)
    .post("/v1/console/auth/sign-in")
    .set({ ...service(), "Idempotency-Key": randomUUID() })
    .send({ grantType: "portal_token", portalToken: token });
  const access = (res.body as { session?: { accessToken?: string } }).session?.accessToken;
  if (res.status !== 200 || access === undefined) {
    throw new Error(`the staff sign-in answered ${res.status} ${JSON.stringify(res.body)}`);
  }
  return access;
}

/** A ticketed booking of `customerId` with a ready itinerary whose file is in the storage folder. */
async function insertBookingWithDocument(customerId: string): Promise<{ id: string; storageKey: string }> {
  const id = newId("bkg");
  const departure = new Date(Date.now() + 30 * DAY);
  await inAlpha(async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: newBookingReference(),
        customer_id: customerId,
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
  });
  const documentId = newId("doc");
  const storageKey = `tenant_alpha/documents/${id}/${documentId}.pdf`;
  const bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(64), Buffer.from("\n%%EOF\n")]);
  await new LocalDiskStorage(storageDir).put(storageKey, bytes, "application/pdf");
  await inAlpha((trx) =>
    trx
      .insertInto("booking_documents")
      .values({
        id: documentId,
        booking_id: id,
        booking_ticket_id: null,
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
  return { id, storageKey };
}

// ---- Requests -------------------------------------------------------------------------------------------------------

/** The storefront edge of alpha (through Caddy), with alpha's customer when `customer` is set, and the CSRF pair. */
function edge(customer = false): Record<string, string> {
  const csrf = newCsrfToken();
  return {
    "X-Velexis-Edge": testApiCredentials().edgeSecret,
    "X-Velexis-Host": HOST,
    "X-Forwarded-For": "203.0.113.40",
    Origin: `https://${HOST}`,
    "X-CSRF-Token": csrf,
    Cookie: [
      `${STOREFRONT_COOKIES.csrf}=${csrf}`,
      ...(customer ? [`${STOREFRONT_COOKIES.accessToken}=${customerToken}`] : []),
    ].join("; "),
  };
}

/** The OTA admin's server with the owner's staff token (once there is one). */
function service(bearer?: string): Record<string, string> {
  return {
    "X-Api-Key": testApiCredentials().serviceKey,
    "X-Velexis-End-User-IP": "198.51.100.40",
    "X-Velexis-End-User-Agent": "Mozilla/5.0 (headers)",
    "X-Velexis-Environment": "test",
    ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
  };
}

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  request(api.server).get(path).set(headers).then();
const post = (path: string, headers: Record<string, string>, body: unknown = []): Promise<Response> =>
  request(api.server)
    .post(path)
    .set({ ...headers, "Idempotency-Key": randomUUID() })
    .send(body as object)
    .then();

/** Every answer the tests read, by a label that says what it is. */
const answers = new Map<string, Response>();
const answerOf = (label: string): Response => {
  const res = answers.get(label);
  if (res === undefined) {
    throw new Error(`no answer ${label}`);
  }
  return res;
};

beforeAll(async () => {
  preloadOpenApiDocument();
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  storageDir = mkdtempSync(join(tmpdir(), "velexis-ota-headers-"));
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
  alphaId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: alphaId,
      key: "alpha",
      name: "Alpha Travel",
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/Madrid",
      storefront_environment: "test",
    })
    .execute();
  await inAlpha((trx) =>
    seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" }),
  );
  const customerId = newId("cus");
  const email = `${customerId.toLowerCase()}@example.com`;
  const passwordHash = await hashCustomerPassword(PASSWORD);
  await inAlpha(async (trx) => {
    await trx
      .insertInto("customers")
      .values({
        id: customerId,
        email,
        status: "active",
        email_verified_at: new Date(),
        first_name: "TESTA",
        last_name: "CUSTOMER",
      })
      .execute();
    await trx
      .insertInto("customer_identities")
      .values({
        id: newId("cid"),
        customer_id: customerId,
        provider: "password",
        provider_subject: email,
        password_hash: passwordHash,
        email,
        email_verified_at: new Date(),
      })
      .execute();
  });
  api = await createTestApp({ database: db, redis, env: { STORAGE_DIR: storageDir } });
  // The customer signs in on the storefront: its session and the access cookie the browser keeps.
  const signIn = await post("/v1/auth/sign-in", edge(), { email, password: PASSWORD });
  const cookie = ([] as string[])
    .concat((signIn.headers["set-cookie"] as string[] | string | undefined) ?? [])
    .find((entry) => entry.startsWith(`${STOREFRONT_COOKIES.accessToken}=`));
  if (signIn.status !== 200 || cookie === undefined) {
    throw new Error(`the customer sign-in answered ${signIn.status} ${JSON.stringify(signIn.body)}`);
  }
  customerToken = cookie.slice(STOREFRONT_COOKIES.accessToken.length + 1).split(";", 1)[0] ?? "";
  answers.set("auth.signIn", signIn);
  staffToken = await ownerSession();
  const booking = await insertBookingWithDocument(customerId);
  bookingId = booking.id;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
  if (storageDir !== undefined) {
    rmSync(storageDir, { recursive: true, force: true });
  }
});

beforeAll(async () => {
  // The owner uploads a logo through the console; its public URL is the image's address.
  const uploaded = await request(api.server)
    .post("/v1/console/settings/assets")
    .set({ ...service(staffToken), "Idempotency-Key": randomUUID() })
    .field("kind", "logo")
    .attach("file", buildPng({ width: 64, height: 32, shade: 120, sizeBytes: 2048 }), {
      filename: "logo.png",
      contentType: "image/png",
    });
  const assetUrl = String((uploaded.body as { url?: unknown }).url ?? "");
  if (uploaded.status !== 201 || !assetUrl.includes("/v1/assets/")) {
    throw new Error(`the upload answered ${uploaded.status} ${JSON.stringify(uploaded.body)}`);
  }
  assetPath = assetUrl.slice(assetUrl.indexOf("/v1/assets/"));
  // The customer's signed download link of its itinerary.
  const documents = await get(`/v1/bookings/${bookingId}/documents`, edge(true));
  const documentId = String((documents.body as { data?: Array<{ id?: unknown }> }).data?.[0]?.id ?? "");
  const link = await get(`/v1/bookings/${bookingId}/documents/${documentId}/download-url`, edge(true));
  const url = String((link.body as { url?: unknown }).url ?? "");
  documentPath = url.slice(url.indexOf("/v1/files/"));

  answers.set("bookings.listDocuments", documents);
  answers.set("bookings.getDocumentDownloadUrl", link);
  // One request after another: supertest starts the unbound server for each request it sends, so requests fired
  // together share (and close) one listener.
  const requests: Array<[string, () => Promise<Response>]> = [
    // Successful answers: public configuration, personal data, staff data, health.
    ["storefront.get", () => get("/v1/storefront", edge())],
    ["auth.getSession", () => get("/v1/auth/session", edge(true))],
    ["account.get", () => get("/v1/account", edge(true))],
    ["bookings.list", () => get("/v1/bookings", edge(true))],
    ["bookings.get", () => get(`/v1/bookings/${bookingId}`, edge(true))],
    ["bookings.listEvents", () => get(`/v1/bookings/${bookingId}/events`, edge(true))],
    ["console.auth.me", () => get("/v1/console/auth/me", service(staffToken))],
    ["console.bookings.list", () => get("/v1/console/bookings", service(staffToken))],
    ["console.bookings.get", () => get(`/v1/console/bookings/${bookingId}`, service(staffToken))],
    ["console.customers.list", () => get("/v1/console/customers", service(staffToken))],
    ["console.payments.list", () => get("/v1/console/payments", service(staffToken))],
    ["console.supplierRequests.list", () => get("/v1/console/supplier-requests", service(staffToken))],
    ["console.settings.storefront.get", () => get("/v1/console/settings/storefront", service(staffToken))],
    ["health.live", () => get("/health/live")],
    ["health.ready", () => get("/health/ready")],
    // Downloads.
    ["downloadFile", () => get(documentPath, { "X-Forwarded-For": "203.0.113.41" })],
    ["getPublicAsset", () => get(assetPath, { "X-Forwarded-For": "203.0.113.42" })],
    // Errors of every layer: the caller guard, the scope guard, the customer guard, the validation, an unknown route,
    // a pending operation, a refused sign-in, a webhook without a signature, an unknown file.
    ["error.401.caller", () => get("/v1/storefront")],
    ["error.403.scope", () => get("/v1/console/bookings", edge())],
    ["error.401.customer", () => get("/v1/account", edge())],
    ["error.400.validation", () => post("/v1/auth/sign-in", edge())],
    ["error.404.route", () => get("/v1/unknown", edge())],
    ["error.501.pending", () => get("/v1/account/preferences", edge(true))],
    [
      "error.401.signIn",
      () => post("/v1/auth/sign-in", edge(), { email: "nobody@example.com", password: "Not-the-password-1" }),
    ],
    [
      "error.400.webhook",
      () => post("/webhooks/stripe/velexis/test", { "Content-Type": "application/json" }, {}),
    ],
    [
      "error.403.file",
      () => get(`${documentPath.replace(/\.pdf/, "x.pdf")}`, { "X-Forwarded-For": "203.0.113.43" }),
    ],
  ];
  for (const [label, send] of requests) {
    answers.set(label, await send());
  }
}, REQUESTS_TIMEOUT_MS);

/** The JSON answers (every answer but the two downloads). */
const jsonLabels = (): string[] =>
  [...answers.keys()].filter((label) => !["downloadFile", "getPublicAsset"].includes(label));

describe("helmet's headers on every answer", () => {
  it("[OBE-084 AC1] gives every JSON answer, successful or refused, helmet's security headers and no X-Powered-By", () => {
    expect(answers.size).toBeGreaterThan(25);
    for (const label of jsonLabels()) {
      const res = answerOf(label);
      expect([label, res.headers["content-type"]]).toEqual([
        label,
        expect.stringMatching(/^application\/json/),
      ]);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect([label, name, res.headers[name]]).toEqual([label, name, value]);
      }
      expect([label, res.headers["x-powered-by"], res.headers["server"]]).toEqual([
        label,
        undefined,
        undefined,
      ]);
    }
  });

  it("[OBE-084 AC1] reaches every layer that answers: the guards, the validation, the routes, the 501s and the handlers", () => {
    expect(
      [...answers.entries()]
        .filter(([label]) => label.startsWith("error."))
        .map(([label, res]) => [label, res.status]),
    ).toEqual([
      ["error.401.caller", 401],
      ["error.403.scope", 403],
      ["error.401.customer", 401],
      ["error.400.validation", 400],
      ["error.404.route", 404],
      ["error.501.pending", 501],
      ["error.401.signIn", 401],
      ["error.400.webhook", 400],
      ["error.403.file", 403],
    ]);
    for (const label of jsonLabels().filter((entry) => !entry.startsWith("error."))) {
      expect([label, answerOf(label).status]).toEqual([label, 200]);
    }
  });
});

describe("Cache-Control on personal data and sessions", () => {
  it("[OBE-084 AC1] never lets a cache keep a customer's session, account or bookings: private, no-store", () => {
    for (const label of [
      "auth.getSession",
      "account.get",
      "bookings.list",
      "bookings.get",
      "bookings.listDocuments",
      "bookings.listEvents",
    ]) {
      expect([label, answerOf(label).headers["cache-control"]]).toEqual([label, "private, no-store"]);
    }
    // The signed download link is a bearer URL: no cache keeps it at all.
    expect(answerOf("bookings.getDocumentDownloadUrl").headers["cache-control"]).toBe("no-store");
  });

  it("[OBE-084 AC1] never lets a cache keep the console's answers: private, no-store", () => {
    for (const label of [
      "console.auth.me",
      "console.bookings.list",
      "console.bookings.get",
      "console.customers.list",
      "console.payments.list",
      "console.supplierRequests.list",
      "console.settings.storefront.get",
    ]) {
      expect([label, answerOf(label).headers["cache-control"]]).toEqual([label, "private, no-store"]);
    }
  });

  it("[OBE-084 AC1] answers a sign-in, which opens a session, no-store", () => {
    expect(answerOf("auth.signIn").headers["cache-control"]).toBe("no-store");
  });

  it("[OBE-084 AC1] answers every error no-store, and health no-store", () => {
    for (const label of [...answers.keys()].filter((entry) => entry.startsWith("error."))) {
      expect([label, answerOf(label).headers["cache-control"]]).toEqual([label, "no-store"]);
    }
    for (const label of ["health.live", "health.ready"]) {
      expect([label, answerOf(label).headers["cache-control"]]).toEqual([label, "no-store"]);
    }
  });
});

describe("nosniff and their own headers on files and images", () => {
  it("[OBE-084 AC1] serves a booking document as a PDF attachment with nosniff, never cached, never framed", () => {
    const res = answerOf("downloadFile");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="itinerary\.pdf"/);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["content-security-policy"]).toBe(SECURITY_HEADERS["content-security-policy"]);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("[OBE-084 AC1] serves a public image with its sniffed type, nosniff, its own CSP and immutable caching", () => {
    const res = answerOf("getPublicAsset");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
