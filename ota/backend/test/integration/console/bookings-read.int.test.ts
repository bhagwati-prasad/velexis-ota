// The console bookings reads (OBE-061; ota/docs/flows/console-operations.md §2 "Bookings list and detail" and §3
// step 3, db README §10 "B4 Console"): console.bookings.list with its filters, the needs-attention filters, sorts,
// cursors and totalCount, and console.bookings.get in console scope (net amounts, markup, every remark, the whole
// timeline, notes, Amadeus calls, staff actions, consoleActions, refresh), against PostgreSQL 16, Redis 7 and the
// Amadeus stub, through the API's whole pipeline.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: alpha in test and beta live, both on the Velexis test Amadeus account (the stub); accounts and
// memberships; a secret test key of alpha for customer calls and one scoped `console:automation` with `bookings:read`
// only. Staff sign in through the OTA admin's service key with portal tokens, as console-access.int.test.ts does, each
// admin client with an end-user IP address of its own. Bookings are rows inserted the way the record step writes them
// (synthetic travellers, flights moved relative to now, so no calendar date is fixed); the refreshed ones point at
// orders created in the stub through its own HTTP API. Every answer is checked against the OTA document.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { encryptValue, hashApiKey, sha256Hex, type KeyProvider } from "@velexis/crypto";
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
import { redactPayload } from "@velexis/logger";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { orderSegmentsOf } from "../../../src/bookings/order-diff";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { BookingTravelerDocuments, readCreatedOrder } from "../../../src/bookings/order-recorder";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import type { ApiConfig } from "../../../src/config";
import { TokenService } from "../../../src/identity/token.service";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import {
  buildOrderRequestInput,
  buildStoredPassport,
  newRecordLocator,
  pricedFlightOffer,
} from "../../builders/bookings";
import { newDocumentNumber } from "../../builders/checkouts";
import { newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type Schema = "tenant_alpha" | "tenant_beta";
type Role = "owner" | "admin" | "agent" | "finance" | "viewer";
type Environment = "test" | "live";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let tokens: TokenService;
let amadeusAccountId: string;
let alphaId: string;
let betaId: string;
let alphaSk: string;
let alphaAutomationKey: string;
let office: string;
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };
let alphaMarkupRule: { readonly id: string; readonly name: string };

// ---- Platform rows -------------------------------------------------------------------------------------------------

async function insertAmadeusAccount(clientId: string, secret: string): Promise<string> {
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

/** An active tenant of a provisioned schema with its test Amadeus connection (the stub). */
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
  return id;
}

/** A secret test key of `tenantId` with `scopes` (none: a storefront server key), as the platform issues it. */
async function issueKey(tenantId: string, scopes: string[] = []): Promise<string> {
  const key = newApiKey("sk", "test");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: `Server (${scopes.join(", ") || "storefront"})`,
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      ...(scopes.length > 0 ? { scopes } : {}),
    })
    .execute();
  return key;
}

/** A portal account and its membership in one tenant. */
interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: Role;
}

async function insertMember(tenantId: string, role: Role): Promise<Member> {
  const email = `staff.${randomBytes(4).toString("hex")}@example.com`;
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email,
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
  return { accountId, staffId, tenantId, email, role };
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
    readonly environment: Environment,
  ) {
    ipCounter += 1;
    this.ip = `198.51.100.${ipCounter}`;
  }

  headers(environment: Environment = this.environment): Record<string, string> {
    return {
      "X-Api-Key": testApiCredentials().serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": this.userAgent,
      "X-Velexis-Environment": environment,
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

  get(path: string, environment: Environment = this.environment) {
    return request(api.server)
      .get(path)
      .set({ ...this.headers(environment), Authorization: `Bearer ${this.accessToken}` });
  }
}

/** Signs a new staff member of `role` in through a new admin client. */
async function staffSession(tenantId: string, role: Role, environment: Environment = "test") {
  return await new AdminSession(await insertMember(tenantId, role), environment).signIn();
}

// ---- Tenant rows ---------------------------------------------------------------------------------------------------

const inTenant = <T>(schema: Schema, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, schema as TenantSchema, run);

/** A customer of alpha and an access token for it. */
async function newCustomer(): Promise<{
  readonly id: string;
  readonly email: string;
  readonly token: string;
}> {
  const id = newId("cus");
  const email = `${id.toLowerCase()}@example.com`;
  await inTenant("tenant_alpha", (trx) =>
    trx
      .insertInto("customers")
      .values({ id, email, email_verified_at: new Date(), first_name: "Testa", last_name: "Customer" })
      .execute(),
  );
  const signed = await tokens.signCustomerToken({ sub: id, tid: alphaId, sid: newId("ses") });
  return { id, email, token: signed.token };
}

const local = (date: Date): string => date.toISOString().slice(0, 19);

/** What a seeded booking looks like. */
interface BookingSeed {
  readonly schema?: Schema;
  readonly environment?: Environment;
  readonly status?: string;
  readonly ticketingStatus?: string;
  readonly channel?: "storefront" | "console" | "import";
  readonly customerId?: string | null;
  readonly tags?: readonly string[];
  /** The first departure, relative to now (10 days by default); each flight lasts 2 hours. */
  readonly departInMs?: number;
  /** A return flight this long after the outbound departure. */
  readonly returnAfterMs?: number;
  readonly ticketingDeadlineInMs?: number;
  readonly reconcileOutcome?: "found" | "not_found" | "manual_review";
  readonly createdAgoMs?: number;
  readonly amadeusOrderId?: string | null;
  readonly recordLocator?: string;
  readonly snapshot?: JsonObject;
  readonly totalAmount?: string;
  readonly travelerLastName?: string;
  readonly contactEmail?: string;
  readonly associatedRecords?: readonly string[];
  readonly markupRuleId?: string;
  readonly lastSyncedAgoMs?: number;
  readonly formOfPayments?: readonly JsonObject[];
  readonly failure?: { readonly code: string; readonly message: string };
  /** Who cancelled a cancelled booking (`staff` by default) and the typed reason (`cancel_reason`). */
  readonly cancelledBy?: string;
  readonly cancelReason?: string;
}

/** The segments of a stored order snapshot (a stub order's `data`), or `undefined` when it holds no readable order. */
function snapshotSegmentsOf(snapshot: JsonObject | undefined) {
  const order = snapshot === undefined ? undefined : readCreatedOrder({ data: snapshot });
  return order === undefined || order.offers.length === 0 ? undefined : orderSegmentsOf(order);
}

/**
 * A booking as the record step writes it: the bookings row (net 98.47 + markup 12.00 = 110.47 EUR unless told
 * otherwise), its MAD–ORY flight (segment "3" of offer "2", the stub's offer) and, with a return, ORY–MAD; one adult
 * traveller, and its associated records. Pending and failed bookings have no flight or traveller rows. A booking of a
 * stub order (`snapshot`) holds that order's segments, their local times read as UTC (the fixture's airports have no
 * time zone in the template's reference data), as the record step stores them: since FIX-W27-SYNC a refresh records
 * the order through the background sync's diff, so other segments would be a schedule change.
 */
async function seedBooking(seed: BookingSeed = {}): Promise<string> {
  const id = newId("bkg");
  const schema = seed.schema ?? "tenant_alpha";
  const now = Date.now();
  const ordered = snapshotSegmentsOf(seed.snapshot);
  const orderedFirst = ordered?.[0];
  const outbound =
    orderedFirst === undefined
      ? new Date(now + (seed.departInMs ?? 10 * DAY))
      : new Date(`${orderedFirst.departureLocal}Z`);
  const inbound =
    seed.returnAfterMs === undefined ? undefined : new Date(outbound.getTime() + seed.returnAfterMs);
  const lastArrival =
    ordered !== undefined && ordered.length > 0
      ? new Date(Math.max(...ordered.map((segment) => new Date(`${segment.arrivalLocal}Z`).getTime())))
      : new Date((inbound ?? outbound).getTime() + 2 * HOUR);
  const status = seed.status ?? "confirmed";
  const withOrder = status !== "pending" && status !== "failed";
  const recordLocator = withOrder ? (seed.recordLocator ?? newRecordLocator()) : null;
  await inTenant(schema, async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: seed.environment ?? "test",
        reference: newBookingReference(),
        channel: seed.channel ?? "storefront",
        customer_id: seed.customerId ?? null,
        status,
        ticketing_status:
          seed.ticketingStatus ??
          (status === "ticketed" ? "issued" : status === "failed" ? "not_applicable" : "pending"),
        amadeus_order_id: withOrder
          ? seed.amadeusOrderId === undefined
            ? `ORDER-${id.slice(-10)}`
            : seed.amadeusOrderId
          : null,
        record_locator: recordLocator,
        origin_system_code: "GDS",
        owner_office_id: office,
        queuing_office_id: office,
        ticketing_deadline_at:
          seed.ticketingDeadlineInMs === undefined ? null : new Date(now + seed.ticketingDeadlineInMs),
        trip_type: inbound === undefined ? "one_way" : "round_trip",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: outbound,
        last_arrival_at: lastArrival,
        validating_carrier: "IB",
        travelers_count: 1,
        currency: "EUR",
        markup_rule_id: seed.markupRuleId ?? null,
        net_amount: "98.47",
        net_base_amount: "56.00",
        net_fees_amount: "0.00",
        net_services_amount: "0.00",
        markup_amount: "12.00",
        taxes_amount: "42.47",
        total_amount: seed.totalAmount ?? "110.47",
        contact_email: seed.contactEmail ?? "contact-1@example.com",
        lead_last_name: (seed.travelerLastName ?? "SAMPLE").toUpperCase(),
        form_of_payments: JSON.stringify(seed.formOfPayments ?? []),
        order_snapshot: JSON.stringify(seed.snapshot ?? {}),
        last_synced_at: seed.lastSyncedAgoMs === undefined ? null : new Date(now - seed.lastSyncedAgoMs),
        cancelled_at: status === "cancelled" ? new Date(now - HOUR) : null,
        cancelled_by: status === "cancelled" ? (seed.cancelledBy ?? "staff") : null,
        cancel_reason: seed.cancelReason ?? null,
        failure_code: seed.failure?.code ?? null,
        failure_message: seed.failure?.message ?? null,
        tags: [...(seed.tags ?? [])],
        create_order_started_at: seed.reconcileOutcome === undefined ? null : new Date(now - HOUR),
        reconcile_outcome: seed.reconcileOutcome ?? null,
        created_at: new Date(now - (seed.createdAgoMs ?? 0)),
      })
      .execute();
    if (!withOrder) {
      return;
    }
    if (ordered !== undefined && ordered.length > 0) {
      await trx
        .insertInto("booking_segments")
        .values(
          ordered.map((segment) => ({
            id: newId("seg"),
            booking_id: id,
            amadeus_flight_offer_id: segment.amadeusFlightOfferId,
            amadeus_segment_id: segment.amadeusSegmentId,
            itinerary_index: segment.itineraryIndex,
            segment_index: segment.segmentIndex,
            carrier_code: segment.carrierCode,
            flight_number: segment.flightNumber,
            operating_carrier_code: segment.operatingCarrierCode,
            aircraft_code: segment.aircraftCode,
            departure_iata: segment.departureIata,
            departure_terminal: segment.departureTerminal,
            departure_local: segment.departureLocal,
            departure_at: new Date(`${segment.departureLocal}Z`),
            arrival_iata: segment.arrivalIata,
            arrival_terminal: segment.arrivalTerminal,
            arrival_local: segment.arrivalLocal,
            arrival_at: new Date(`${segment.arrivalLocal}Z`),
            duration_minutes: segment.durationMinutes,
            cabin: segment.cabin,
            booking_class: segment.bookingClass,
            fare_basis: segment.fareBasis,
            ...(segment.status === null ? {} : { status: segment.status }),
            ...(segment.isFlown === null ? {} : { is_flown: segment.isFlown }),
          })),
        )
        .execute();
    }
    const flights =
      ordered !== undefined && ordered.length > 0
        ? []
        : [
            { from: "MAD", to: "ORY", at: outbound, segmentId: "3", itinerary: 0 },
            ...(inbound === undefined
              ? []
              : [{ from: "ORY", to: "MAD", at: inbound, segmentId: "4", itinerary: 1 }]),
          ];
    for (const flight of flights) {
      await trx
        .insertInto("booking_segments")
        .values({
          id: newId("seg"),
          booking_id: id,
          amadeus_flight_offer_id: "2",
          amadeus_segment_id: flight.segmentId,
          itinerary_index: flight.itinerary,
          segment_index: 0,
          carrier_code: "IB",
          flight_number: "3436",
          departure_iata: flight.from,
          departure_local: local(flight.at),
          departure_at: flight.at,
          arrival_iata: flight.to,
          arrival_local: local(new Date(flight.at.getTime() + 2 * HOUR)),
          arrival_at: new Date(flight.at.getTime() + 2 * HOUR),
          duration_minutes: 120,
          cabin: "ECONOMY",
          booking_class: "Q",
          is_flown: flight.at.getTime() + 2 * HOUR < now,
        })
        .execute();
    }
    await trx
      .insertInto("booking_travelers")
      .values({
        id: newId("btr"),
        booking_id: id,
        amadeus_traveler_id: "1",
        traveler_type: "ADULT",
        first_name: "TESTA",
        last_name: seed.travelerLastName ?? "SAMPLE",
        date_of_birth: "1988-04-12",
        gender: "FEMALE",
      })
      .execute();
    const records = [recordLocator, ...(seed.associatedRecords ?? [])].filter(
      (reference): reference is string => reference !== null,
    );
    await trx
      .insertInto("booking_associated_records")
      .values(
        records.map((reference, index) => ({
          id: newId("bar"),
          booking_id: id,
          reference,
          origin_system_code: index === 0 ? "GDS" : "IB",
          flight_offer_id: "2",
          is_primary: index === 0,
        })),
      )
      .execute();
  });
  return id;
}

/** Appends an event to a booking. */
async function seedEvent(
  bookingId: string,
  event: {
    readonly type: string;
    readonly actorType?: string;
    readonly actorId?: string | null;
    readonly visible?: boolean;
    readonly agoMs?: number;
    readonly summary?: string;
    readonly data?: JsonObject;
  },
  schema: Schema = "tenant_alpha",
): Promise<string> {
  const id = newId("evt");
  const createdAt = new Date(Date.now() - (event.agoMs ?? 0));
  await inTenant(schema, (trx) =>
    trx
      .insertInto("booking_events")
      .values({
        id,
        booking_id: bookingId,
        type: event.type,
        actor_type: event.actorType ?? "system",
        actor_id: event.actorId ?? null,
        summary: event.summary ?? event.type,
        data: JSON.stringify(event.data ?? {}),
        visible_to_customer: event.visible ?? false,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .execute(),
  );
  return id;
}

/** A Stripe payment of a booking in `status`, with the amounts it has captured and refunded. */
async function seedPayment(
  bookingId: string,
  payment: { readonly status: string; readonly captured?: string; readonly refunded?: string },
): Promise<string> {
  const id = newId("pay");
  await inTenant("tenant_alpha", (trx) =>
    trx
      .insertInto("payments")
      .values({
        id,
        environment: "test",
        booking_id: bookingId,
        provider: "stripe",
        provider_payment_id: `pi_${randomBytes(12).toString("hex")}`,
        method: "card",
        capture_method: "manual",
        currency: "EUR",
        amount: "110.47",
        amount_authorized: payment.status === "failed" ? "0.00" : "110.47",
        amount_captured: payment.captured ?? "0.00",
        amount_refunded: payment.refunded ?? "0.00",
        status: payment.status,
        card_brand: "VISA",
        card_last4: "4242",
      })
      .execute(),
  );
  return id;
}

// ---- The stub's orders ---------------------------------------------------------------------------------------------

async function stubFetch(path: string, init: { method: string; body?: unknown }): Promise<JsonObject> {
  const tokenRes = await fetch(`${stub.url}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: stubCredentials.clientId,
      client_secret: stubCredentials.clientSecret,
    }).toString(),
  });
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };
  const res = await fetch(`${stub.url}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/vnd.amadeus+json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as JsonObject;
}

/** The fixture's offer 2 with its flight (2 h 05 min) departing at `departure` (a local time, UTC reading). */
function offerDepartingAt(departure: Date): JsonObject {
  const offer = pricedFlightOffer();
  for (const itinerary of offer["itineraries"] as JsonObject[]) {
    for (const segment of itinerary["segments"] as JsonObject[]) {
      (segment["departure"] as JsonObject)["at"] = local(departure);
      (segment["arrival"] as JsonObject)["at"] = local(new Date(departure.getTime() + 125 * MINUTE));
    }
  }
  return offer;
}

/** An order of the stub with a fresh passport number, its flight 10 days after now (to the minute); its `data`. */
async function newStubOrder(documentNumber = newDocumentNumber()): Promise<JsonObject> {
  const departure = new Date(Math.floor((Date.now() + 10 * DAY) / MINUTE) * MINUTE);
  const input = buildOrderRequestInput({ flightOffers: [offerDepartingAt(departure)] });
  const traveler = input.travelers[0];
  const document = traveler?.documents[0];
  if (traveler === undefined || document === undefined) {
    throw new Error("the order request builder has no traveller with a document");
  }
  const built = buildCreateOrderRequest({
    ...input,
    travelers: [{ ...traveler, documents: [{ ...document, number: documentNumber }] }],
    remarks: [{ text: "Vegetarian meal please", travelerIds: ["1"] }],
    offices: { queuing: office, owner: office },
  });
  const created = await stubFetch("/v1/booking/flight-orders", { method: "POST", body: built.body });
  return created["data"] as JsonObject;
}

const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

/** The `supplierSync` block of a console.bookings.get answer. */
const supplierSyncOf = (res: Response): JsonObject => (res.body as { supplierSync: JsonObject }).supplierSync;

// ---- Answers -------------------------------------------------------------------------------------------------------

interface PageBody {
  readonly data: Array<JsonObject & { readonly id: string }>;
  readonly page: { readonly nextCursor: string | null; readonly limit: number };
  readonly totalCount: number | null;
}

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** The ids of a list answer, after checking it against the document. */
function listIds(res: Response): string[] {
  expect(answer(res)).toEqual([200, undefined]);
  expectResponseToMatch("consoleListBookings", res);
  return (res.body as PageBody).data.map((row) => row.id);
}

const sorted = (ids: readonly (string | undefined)[]): string[] => [...(ids as string[])].sort();

// Cloning the template, starting the stub, building the API's module graph and compiling the response validators of
// both operations take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with
// its own budget, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["consoleListBookings", [200, 400, 401, 403]],
    ["consoleGetBooking", [200, 403, 404]],
    ["getBooking", [200]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
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
  stubCredentials = {
    clientId: `velexis-test-${randomBytes(4).toString("hex")}`,
    clientSecret: randomBytes(24).toString("base64url"),
  };
  office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  amadeusAccountId = await insertAmadeusAccount(stubCredentials.clientId, stubCredentials.clientSecret);
  alphaId = await insertTenant("alpha", false);
  betaId = await insertTenant("beta", true);
  alphaSk = await issueKey(alphaId);
  alphaAutomationKey = await issueKey(alphaId, ["console:automation", "bookings:read"]);
  for (const [schema, name] of [
    ["tenant_alpha", "Alpha Travel"],
    ["tenant_beta", "Beta Trips"],
  ] as const) {
    await inTenant(schema, async (trx) => {
      await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
      await seedDefaultMarkupRule(trx);
    });
  }
  alphaMarkupRule = await inTenant("tenant_alpha", (trx) =>
    trx.selectFrom("markup_rules").select(["id", "name"]).executeTakeFirstOrThrow(),
  );
  tokens = new TokenService(
    { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>,
    new Clock(),
  );
  stub = await startAmadeusStub({ credentials: stubCredentials });
  api = await createTestApp({ database: db, redis, env: { AMADEUS_BASE_URL_TEST: stub.url } });
  // The first sign-in and console calls of a process open the pools' connections and warm the token and validation
  // code; done once here, so that no test pays for it.
  const warmUp = await staffSession(alphaId, "owner");
  expect((await warmUp.get("/v1/console/bookings?limit=1")).status).toBe(200);
  expect((await warmUp.get(`/v1/console/bookings/${newId("bkg")}`)).status).toBe(404);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(() => {
  stub.clearRequests();
});

describe("console.bookings.list: the needs-attention filters", () => {
  /** A tag of this block's bookings only, so the other tests' bookings never mix in. */
  const tag = `attention-${randomBytes(3).toString("hex")}`;
  let agent: AdminSession;
  let seeded: Record<string, string>;

  // Twelve bookings and a staff sign-in: the setup of this block, under its own budget.
  beforeAll(async () => {
    agent = await staffSession(alphaId, "agent");
    const tags = [tag];
    seeded = {
      ticketingFailed: await seedBooking({ tags, ticketingStatus: "failed" }),
      ticketingManual: await seedBooking({ tags, ticketingStatus: "manual_review" }),
      ticketingPending: await seedBooking({ tags }),
      reconcileManual: await seedBooking({ tags, status: "pending", reconcileOutcome: "manual_review" }),
      reconcileFound: await seedBooking({ tags, reconcileOutcome: "found" }),
      deadlineSoon: await seedBooking({ tags, ticketingDeadlineInMs: 6 * HOUR }),
      deadlineLater: await seedBooking({ tags, ticketingDeadlineInMs: 3 * DAY }),
      deadlineSoonTicketed: await seedBooking({ tags, status: "ticketed", ticketingDeadlineInMs: 6 * HOUR }),
      cancellationRequested: await seedBooking({ tags }),
      cancellationDone: await seedBooking({ tags, status: "cancelled", ticketingStatus: "not_applicable" }),
      scheduleChanged: await seedBooking({ tags }),
      // A live booking that matches every filter: never seen in the test environment.
      live: await seedBooking({
        tags,
        environment: "live",
        ticketingStatus: "failed",
        ticketingDeadlineInMs: 6 * HOUR,
      }),
    };
    for (const name of ["cancellationRequested", "cancellationDone", "live"]) {
      await seedEvent(seeded[name] ?? "", { type: "booking.cancellation_requested", actorType: "customer" });
    }
    for (const name of ["scheduleChanged", "live"]) {
      await seedEvent(seeded[name] ?? "", { type: "booking.schedule_changed", actorType: "supplier" });
    }
  }, 30_000);

  const list = (query: string) => agent.get(`/v1/console/bookings?tag=${tag}&${query}`);

  it("[OBE-061 AC1] ticketingStatus=failed,manual_review returns the ticketing problems only", async () => {
    const ids = listIds(await list("ticketingStatus=failed,manual_review"));

    expect(sorted(ids)).toEqual(sorted([seeded["ticketingFailed"], seeded["ticketingManual"]]));
  });

  it("[OBE-061 AC1] reconcileOutcome=manual_review returns the bookings the reconciliation left to staff only", async () => {
    const res = await list("reconcileOutcome=manual_review");

    expect(listIds(res)).toEqual([seeded["reconcileManual"]]);
    expect((res.body as PageBody).data[0]).toMatchObject({
      status: "pending",
      recordLocator: null,
      amadeusOrderId: null,
      syncStatus: "not_applicable",
    });
    expect(listIds(await list("reconcileOutcome=found,not_found"))).toEqual([seeded["reconcileFound"]]);
  });

  it("[OBE-061 AC1] a ticketing deadline within 24 h returns the confirmed bookings due to issue only", async () => {
    const before = new Date(Date.now() + DAY).toISOString();

    const ids = listIds(
      await list(
        `status=confirmed,partially_ticketed&ticketingDeadlineBefore=${before}&sort=ticketingDeadline`,
      ),
    );

    expect(ids).toEqual([seeded["deadlineSoon"]]);
    // Without the status filter the ticketed booking with a near deadline is there too.
    expect(sorted(listIds(await list(`ticketingDeadlineBefore=${before}`)))).toEqual(
      sorted([seeded["deadlineSoon"], seeded["deadlineSoonTicketed"]]),
    );
  });

  it("[OBE-061 AC1] cancellationRequested=true returns the open cancellation requests only", async () => {
    expect(listIds(await list("cancellationRequested=true"))).toEqual([seeded["cancellationRequested"]]);
    const open = listIds(await list("cancellationRequested=false&limit=100"));
    expect(open).not.toContain(seeded["cancellationRequested"]);
    // A request the booking was cancelled for is closed.
    expect(open).toContain(seeded["cancellationDone"]);
    expect(open).toHaveLength(10);
  });

  it("[OBE-061 AC1] hasScheduleChange=true returns the schedule changes only, with the row's flag set", async () => {
    const res = await list("hasScheduleChange=true");

    expect(listIds(res)).toEqual([seeded["scheduleChanged"]]);
    expect((res.body as PageBody).data[0]?.["hasScheduleChange"]).toBe(true);
    const unchanged = (await list("hasScheduleChange=false&limit=100")).body as PageBody;
    expect(unchanged.data.map((row) => row.id)).not.toContain(seeded["scheduleChanged"]);
    expect(unchanged.data.every((row) => row["hasScheduleChange"] === false)).toBe(true);
    expect(unchanged.totalCount).toBe(10);
  });

  it("[OBE-061 AC2] never lists the live booking in the test environment, whatever the filters", async () => {
    const all = listIds(await list("limit=100"));

    expect(all).toHaveLength(11);
    expect(all).not.toContain(seeded["live"]);
    expect((await list("limit=1")).body).toMatchObject({ totalCount: 11 });
  });
});

describe("console.bookings.list: filters, sorts and pages", () => {
  const tag = `list-${randomBytes(3).toString("hex")}`;
  let agent: AdminSession;
  let customer: { readonly id: string; readonly email: string };
  let seeded: Record<string, string>;
  const airlineLocator = newRecordLocator();

  // Seven bookings with their payments and a staff sign-in: the setup of this block, under its own budget.
  beforeAll(async () => {
    agent = await staffSession(alphaId, "agent");
    customer = await newCustomer();
    const tags = [tag];
    seeded = {
      paid: await seedBooking({
        tags,
        customerId: customer.id,
        createdAgoMs: 6 * HOUR,
        departInMs: 20 * DAY,
        totalAmount: "300.00",
        ticketingDeadlineInMs: 2 * DAY,
      }),
      authorized: await seedBooking({
        tags,
        createdAgoMs: 5 * HOUR,
        departInMs: 5 * DAY,
        totalAmount: "150.00",
        travelerLastName: "MULLER",
        ticketingDeadlineInMs: DAY,
      }),
      partlyRefunded: await seedBooking({
        tags,
        createdAgoMs: 4 * HOUR,
        departInMs: 30 * DAY,
        totalAmount: "200.00",
        associatedRecords: [airlineLocator],
      }),
      refunded: await seedBooking({
        tags,
        status: "cancelled",
        ticketingStatus: "not_applicable",
        createdAgoMs: 3 * HOUR,
        totalAmount: "110.47",
        travelerLastName: "Müller",
      }),
      unpaid: await seedBooking({
        tags,
        createdAgoMs: 2 * HOUR,
        departInMs: 15 * DAY,
        totalAmount: "99.00",
        contactEmail: "Guest.Contact@Example.com",
      }),
      failedAttempt: await seedBooking({ tags, createdAgoMs: 90 * MINUTE, totalAmount: "120.00" }),
      console: await seedBooking({ tags, channel: "console", createdAgoMs: HOUR, totalAmount: "500.00" }),
    };
    await seedPayment(seeded["paid"] ?? "", { status: "captured", captured: "110.47" });
    await seedPayment(seeded["authorized"] ?? "", { status: "authorized" });
    await seedPayment(seeded["partlyRefunded"] ?? "", {
      status: "partially_refunded",
      captured: "110.47",
      refunded: "10.00",
    });
    await seedPayment(seeded["refunded"] ?? "", {
      status: "refunded",
      captured: "110.47",
      refunded: "110.47",
    });
    await seedPayment(seeded["failedAttempt"] ?? "", { status: "failed" });
  }, 30_000);

  const list = (query = "") => agent.get(`/v1/console/bookings?tag=${tag}${query === "" ? "" : `&${query}`}`);

  it("lists every booking of the environment newest first, with net, markup and the derived payment state", async () => {
    const res = await list();

    expect(listIds(res)).toEqual(
      ["console", "failedAttempt", "unpaid", "refunded", "partlyRefunded", "authorized", "paid"].map(
        (name) => seeded[name],
      ),
    );
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const rows = new Map((res.body as PageBody).data.map((row) => [row.id, row]));
    expect(rows.get(seeded["paid"] ?? "")).toMatchObject({
      channel: "storefront",
      environment: "test",
      customer: { id: customer.id, email: customer.email, firstName: "Testa", lastName: "Customer" },
      isGuest: false,
      leadTravelerName: "TESTA SAMPLE",
      originCode: "MAD",
      destinationCode: "ORY",
      validatingCarrier: "IB",
      paymentStatus: "paid",
      total: { amount: "300.00", currency: "EUR" },
      net: { amount: "98.47", currency: "EUR" },
      markup: { amount: "12.00", currency: "EUR" },
      syncStatus: "stale",
      tags: [tag],
    });
    expect(
      ["authorized", "partlyRefunded", "refunded", "unpaid", "failedAttempt", "console"].map(
        (name) => rows.get(seeded[name] ?? "")?.["paymentStatus"],
      ),
    ).toEqual(["authorized", "partially_refunded", "refunded", "unpaid", "failed", "not_applicable"]);
    expect(rows.get(seeded["unpaid"] ?? "")).toMatchObject({ customer: null, isGuest: true });
    expect((res.body as PageBody).totalCount).toBe(7);
  });

  it("filters by payment state, channel, customer, e-mail, traveller name, record locator, reference and free text", async () => {
    const [paidRow] = (await list(`customerId=${customer.id}`)).body.data as JsonObject[];
    const reference = String(paidRow?.["reference"]);

    expect(sorted(listIds(await list("paymentStatus=paid,refunded")))).toEqual(
      sorted([seeded["paid"], seeded["refunded"]]),
    );
    expect(listIds(await list("source=console"))).toEqual([seeded["console"]]);
    expect(listIds(await list(`customerEmail=${customer.email.toUpperCase()}`))).toEqual([seeded["paid"]]);
    expect(listIds(await list("customerEmail=guest.contact@example.com"))).toEqual([seeded["unpaid"]]);
    // A last-name prefix in any case and with or without accents.
    expect(listIds(await list(`travelerLastName=${encodeURIComponent("müll")}`))).toEqual([
      seeded["refunded"],
      seeded["authorized"],
    ]);
    expect(listIds(await list(`recordLocator=${airlineLocator}`))).toEqual([seeded["partlyRefunded"]]);
    expect(listIds(await list(`reference=${reference}`))).toEqual([seeded["paid"]]);
    expect(listIds(await list(`q=${reference.slice(0, 7).toLowerCase()}`))).toEqual([seeded["paid"]]);
    expect(listIds(await list(`q=${airlineLocator}`))).toEqual([seeded["partlyRefunded"]]);
    expect(listIds(await list("q=guest.contact"))).toEqual([seeded["unpaid"]]);
  });

  it("filters by first departure and booking time", async () => {
    const date = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 10);

    const departing = await list(`departureFrom=${date(14 * DAY)}&departureTo=${date(21 * DAY)}`);
    const booked = await list(
      `createdFrom=${new Date(Date.now() - 5.5 * HOUR).toISOString()}&createdTo=${new Date(Date.now() - 2.5 * HOUR).toISOString()}`,
    );

    expect(sorted(listIds(departing))).toEqual(sorted([seeded["paid"], seeded["unpaid"]]));
    expect(listIds(booked)).toEqual([seeded["refunded"], seeded["partlyRefunded"], seeded["authorized"]]);
  });

  it("pages with a cursor of the same filters and sort, and refuses one of other filters", async () => {
    const first = await list("limit=3");
    const cursor = (first.body as PageBody).page.nextCursor ?? "";
    expect(listIds(first)).toHaveLength(3);
    expect(first.body as PageBody).toMatchObject({ page: { limit: 3 }, totalCount: 7 });
    expect(cursor).not.toBe("");

    const second = await list(`limit=3&cursor=${cursor}`);
    const third = await list(`limit=3&cursor=${(second.body as PageBody).page.nextCursor ?? ""}`);
    const mismatch = await list(`limit=3&sort=total&cursor=${cursor}`);
    const forged = await list(`cursor=${Buffer.from('[1,"x",null,"bkg_1"]').toString("base64url")}`);

    expect([...listIds(first), ...listIds(second), ...listIds(third)]).toEqual(listIds(await list()));
    expect((third.body as PageBody).page.nextCursor).toBeNull();
    for (const res of [mismatch, forged]) {
      expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
      expectResponseToMatch("consoleListBookings", res);
      expect(res.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/query/cursor" })]);
    }
  });

  it("sorts by total and by ticketing deadline with the bookings without one last, in pages", async () => {
    const byTotal = listIds(await list("sort=-total"));
    const deadlines: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Response = await list(
        `sort=ticketingDeadline&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      deadlines.push(...listIds(page));
      cursor = (page.body as PageBody).page.nextCursor;
    } while (cursor !== null);
    const descending = listIds(await list("sort=-ticketingDeadline&limit=3"));

    expect(byTotal).toEqual(
      ["console", "paid", "partlyRefunded", "authorized", "failedAttempt", "refunded", "unpaid"].map(
        (name) => seeded[name],
      ),
    );
    expect(deadlines.slice(0, 2)).toEqual([seeded["authorized"], seeded["paid"]]);
    expect(sorted(deadlines.slice(2))).toEqual(
      sorted(
        ["partlyRefunded", "refunded", "unpaid", "failedAttempt", "console"].map((name) => seeded[name]),
      ),
    );
    expect(descending.slice(0, 2)).toEqual([seeded["paid"], seeded["authorized"]]);
  });

  it("sorts by first departure and by creation both ways, and pages the deadlines downwards into the undated ones", async () => {
    /** Every id of a sort, read in pages of `limit`. */
    const paged = async (sort: string, limit: number): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Response = await list(
          `sort=${sort}&limit=${limit}${cursor === null ? "" : `&cursor=${cursor}`}`,
        );
        ids.push(...listIds(page));
        cursor = (page.body as PageBody).page.nextCursor;
      } while (cursor !== null);
      return ids;
    };

    const byDeparture = listIds(await list("sort=departure"));
    const created = listIds(await list("sort=created"));

    // 5, 10 (three bookings), 15, 20 and 30 days ahead.
    expect(byDeparture[0]).toBe(seeded["authorized"]);
    expect(sorted(byDeparture.slice(1, 4))).toEqual(
      sorted(["refunded", "failedAttempt", "console"].map((name) => seeded[name])),
    );
    expect(byDeparture.slice(4)).toEqual(["unpaid", "paid", "partlyRefunded"].map((name) => seeded[name]));
    // The id breaks ties in the sort's direction, so the descending pages are the ascending list reversed.
    expect(await paged("-departure", 3)).toEqual([...byDeparture].reverse());
    expect(created).toEqual(
      ["paid", "authorized", "partlyRefunded", "refunded", "unpaid", "failedAttempt", "console"].map(
        (name) => seeded[name],
      ),
    );
    expect(await paged("created", 2)).toEqual(created);
    expect(await paged("-ticketingDeadline", 1)).toEqual(listIds(await list("sort=-ticketingDeadline")));
  });

  it("answers a console:automation key with bookings:read, and refuses a key-only call without that scope", async () => {
    const keyOnly = await request(api.server)
      .get(`/v1/console/bookings?tag=${tag}&limit=1`)
      .set("X-Api-Key", alphaAutomationKey);
    const customerKey = await request(api.server)
      .get(`/v1/console/bookings?tag=${tag}`)
      .set("X-Api-Key", alphaSk);
    const anonymous = await request(api.server).get("/v1/console/bookings");

    expect(listIds(keyOnly)).toEqual([seeded["console"]]);
    expect(answer(customerKey)).toEqual([403, "SCOPE_NOT_ALLOWED"]);
    expect(customerKey.body.error.details).toEqual({ requiredScope: "console:automation" });
    expectResponseToMatch("consoleListBookings", customerKey);
    expect(answer(anonymous)[0]).toBe(401);
  });
});

describe("console.bookings.get", () => {
  it("[OBE-061 AC2] answers the console view with net amounts, markup, payments, every remark, events, notes and staff actions, which customer scope never shows", async () => {
    const agent = await staffSession(alphaId, "agent");
    const customer = await newCustomer();
    const order = await newStubOrder();
    // Stripe's documented Visa test number, stored as the record step stores forms of payment (through the redactor).
    const testCardNumber = "4242424242424242";
    const bookingId = await seedBooking({
      customerId: customer.id,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
      lastSyncedAgoMs: HOUR,
      ticketingDeadlineInMs: 2 * DAY,
      markupRuleId: alphaMarkupRule.id,
      tags: ["vip"],
      formOfPayments: redactPayload([
        {
          creditCard: {
            brand: "VISA",
            holder: "TESTA SAMPLE",
            number: testCardNumber,
            expiryDate: "2030-12",
            securityCode: "123",
            flightOfferIds: ["2"],
          },
        },
        { other: { method: "ACCOUNT", flightOfferIds: ["2"] } },
      ]),
    });
    // The traveller's passport, sealed as the record step seals it.
    const passport = buildStoredPassport();
    const travelerRow = await inTenant("tenant_alpha", (trx) =>
      trx
        .selectFrom("booking_travelers")
        .select("id")
        .where("booking_id", "=", bookingId)
        .executeTakeFirstOrThrow(),
    );
    const sealed = await api.app
      .get(BookingTravelerDocuments, { strict: false })
      .seal("tenant_alpha" as TenantSchema, travelerRow.id, [passport], []);
    const staffToken = `eyJ${randomBytes(24).toString("base64url")}`;
    await inTenant("tenant_alpha", async (trx) => {
      await trx
        .updateTable("booking_travelers")
        .set({
          documents_ciphertext: sealed.documentsCiphertext,
          encryption_key_id: sealed.encryptionKeyId,
          document_type: "PASSPORT",
          document_last4: passport.number.slice(-4),
        })
        .where("id", "=", travelerRow.id)
        .execute();
      await trx
        .insertInto("booking_remarks")
        .values([
          {
            id: newId("rmk"),
            booking_id: bookingId,
            kind: "general",
            sub_type: "GENERAL_MISCELLANEOUS",
            text: "VEGETARIAN MEAL PLEASE",
            traveler_ids: ["1"],
            visible_to_customer: true,
            created_at: new Date(Date.now() - 3 * MINUTE),
          },
          {
            id: newId("rmk"),
            booking_id: bookingId,
            kind: "general",
            sub_type: "BACKOFFICE",
            text: "VELEXIS VX7K2M9Q",
            visible_to_customer: false,
            created_at: new Date(Date.now() - 2 * MINUTE),
          },
          {
            id: newId("rmk"),
            booking_id: bookingId,
            kind: "general",
            sub_type: "CONFIDENTIAL",
            text: "CALL BEFORE ISSUING",
            visible_to_customer: false,
            created_by_staff_id: agent.member.staffId,
            created_at: new Date(Date.now() - MINUTE),
          },
        ])
        .execute();
      await trx
        .insertInto("supplier_requests")
        .values({
          id: newId("sreq"),
          environment: "test",
          operation: "bookings.get",
          amadeus_api: "FlightOrderManagement",
          amadeus_operation_id: "getFlightOrder",
          http_method: "GET",
          path: `/v1/booking/flight-orders/${String(order["id"])}`,
          office_id: office,
          http_status: 200,
          outcome: "success",
          duration_ms: 420,
          request_body: JSON.stringify({ secret: staffToken }),
          booking_id: bookingId,
        })
        .execute();
      await trx
        .insertInto("staff_actions")
        .values({
          id: newId("sact"),
          actor_type: "staff",
          actor_id: agent.member.staffId,
          staff_id: agent.member.staffId,
          account_id: agent.member.accountId,
          staff_email: agent.member.email,
          staff_role: "agent",
          action: "booking.note",
          target_type: "booking",
          target_id: bookingId,
          booking_id: bookingId,
          reason: "Customer called",
          before: JSON.stringify({ accessToken: staffToken }),
          after: JSON.stringify({ accessToken: staffToken }),
          outcome: "succeeded",
          request_id: "req_01JA4F7H1J4M7P0S3V6Y9B2E5H",
        })
        .execute();
    });
    await seedPayment(bookingId, { status: "captured", captured: "110.47" });
    await seedEvent(bookingId, {
      type: "booking.created",
      actorType: "customer",
      actorId: customer.id,
      visible: true,
      agoMs: 2 * HOUR,
      summary: "Booking created from checkout",
    });
    const noteId = await seedEvent(bookingId, {
      type: "staff.note",
      actorType: "staff",
      actorId: agent.member.staffId,
      agoMs: HOUR,
      summary: "Note added",
      data: { text: "Customer asked for a window seat." },
    });

    const res = await agent.get(`/v1/console/bookings/${bookingId}`);
    const customerView = await request(api.server)
      .get(`/v1/bookings/${bookingId}`)
      .set({ "X-Api-Key": alphaSk, Authorization: `Bearer ${customer.token}` });

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetBooking", res);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const booking = res.body as JsonObject;
    expect(booking).toMatchObject({
      id: bookingId,
      status: "confirmed",
      environment: "test",
      amadeusOrderId: order["id"],
      queuingOfficeId: office,
      ownerOfficeId: office,
      customer: { id: customer.id, email: customer.email },
      contactEmail: "contact-1@example.com",
      paymentStatus: "paid",
      pricing: {
        currency: "EUR",
        net: { amount: "98.47", currency: "EUR" },
        netBase: { amount: "56.00" },
        netTaxes: { amount: "42.47" },
        markup: { amount: "12.00" },
        serviceFees: { amount: "0.00" },
        cardFees: null,
        selling: { amount: "110.47" },
        margin: { amount: "12.00" },
        marginPercent: "10.86",
        pricingMode: "markup_rules",
        markupRuleId: alphaMarkupRule.id,
        markupRuleName: alphaMarkupRule.name,
      },
      // Synchronised an hour ago, its ticketing deadline 2 days away: the background sync is due 6 hours after the last
      // one (FIX-W27-SYNC AC5); no synchronisation recorded a difference yet.
      supplierSync: {
        status: "fresh",
        lastError: null,
        nextScheduledSyncAt: new Date(
          new Date(String(supplierSyncOf(res).lastSyncedAt)).getTime() + 6 * HOUR,
        ).toISOString(),
        differences: [],
      },
      formOfPayments: [
        {
          kind: "creditCard",
          brand: "VISA",
          last4: "4242",
          // The redactor keeps no holder and no expiry of a card (FIX-W29-SECURITY).
          holder: null,
          expiryDate: null,
          method: null,
          cardFriendlyName: null,
          flightOfferIds: ["2"],
        },
        {
          kind: "other",
          method: "ACCOUNT",
          brand: null,
          last4: null,
          holder: null,
          expiryDate: null,
          flightOfferIds: ["2"],
        },
      ],
      issueRequested: false,
      tags: ["vip"],
      failure: null,
      notes: [
        {
          id: noteId,
          bookingId,
          text: "Customer asked for a window seat.",
          visibleToCustomer: false,
          author: { type: "staff", id: agent.member.staffId },
        },
      ],
      consoleActions: {
        canIssue: true,
        canPatch: true,
        canCancel: true,
        canResync: true,
        canRetrieve: true,
        canAddNote: true,
        reasons: {},
      },
    });
    expect((booking["supplierSync"] as JsonObject)["lastSupplierRequestId"]).toMatch(/^sreq_/);
    // Every remark, with who wrote it; the customer sees only their own request.
    expect(
      (booking["remarks"] as JsonObject[]).map((remark) => [remark["subType"], remark["source"]]),
    ).toEqual([
      ["GENERAL_MISCELLANEOUS", "customer"],
      ["BACKOFFICE", "system"],
      ["CONFIDENTIAL", "staff"],
    ]);
    expect(
      (booking["events"] as JsonObject[]).map((event) => [event["type"], event["visibleToCustomer"]]),
    ).toEqual([
      ["staff.note", false],
      ["booking.created", true],
    ]);
    expect((booking["events"] as JsonObject[])[1]?.["actor"]).toMatchObject({
      type: "customer",
      id: customer.id,
      name: "Testa Customer",
    });
    expect(booking["recentSupplierRequests"]).toEqual([
      expect.objectContaining({ amadeusOperationId: "getFlightOrder", httpStatus: 200, bookingId }),
    ]);
    expect(booking["recentStaffActions"]).toEqual([
      expect.objectContaining({
        action: "booking.note",
        reason: "Customer called",
        outcome: "succeeded",
        actor: expect.objectContaining({ type: "staff", email: agent.member.email, role: "agent" }),
      }),
    ]);
    expect(booking["payments"]).toEqual([expect.objectContaining({ status: "captured" })]);
    // The verbatim order with net prices and the offices; the customer's has selling prices and no offices.
    const consoleOrder = (booking["amadeus"] as { order: JsonObject }).order;
    const customerOrder = (customerView.body as { amadeus: { order: JsonObject } }).amadeus.order;
    const grandTotal = (orderBody: JsonObject) =>
      ((orderBody["flightOffers"] as JsonObject[])[0]?.["price"] as JsonObject)["grandTotal"];
    expect(grandTotal(consoleOrder)).toBe(grandTotal(order));
    expect(grandTotal(customerOrder)).not.toBe(grandTotal(order));
    expect(consoleOrder["queuingOfficeId"]).toBe(office);
    // Customer scope never shows net amounts, markups, offices or staff data.
    expect(answer(customerView)).toEqual([200, undefined]);
    expectResponseToMatch("getBooking", customerView);
    for (const field of [
      "pricing",
      "paymentStatus",
      "supplierSync",
      "events",
      "notes",
      "recentStaffActions",
    ]) {
      expect(customerView.body).not.toHaveProperty(field);
    }
    const customerBody = JSON.stringify(customerView.body);
    for (const consoleOnly of ["98.47", office, "CALL BEFORE ISSUING", "VELEXIS", "Customer called"]) {
      expect(customerBody).not.toContain(consoleOnly);
    }
    expect(JSON.stringify(booking)).toContain("98.47");
    // Documents are decrypted for the masked display only: never answered in full, never logged.
    const traveler = (booking["travelers"] as JsonObject[])[0] as { documents: JsonObject[] };
    expect(traveler.documents).toEqual([
      expect.objectContaining({
        documentType: "PASSPORT",
        numberMasked: expect.stringMatching(new RegExp(`${passport.number.slice(-4)}$`)),
      }),
    ]);
    expect(traveler.documents[0]).not.toHaveProperty("number");
    for (const secret of [passport.number, staffToken, testCardNumber]) {
      expect(JSON.stringify(booking)).not.toContain(secret);
      expect(api.sink.text()).not.toContain(secret);
    }
    // No Amadeus call without refresh.
    expect(amadeusCalls("getFlightOrder")).toHaveLength(0);
  });

  it("[FIX-W28-CANCEL AC3] shows the cancellation as its rows tell it: the customer's reason and comment, a staff member's reason, a request waiting for the staff", async () => {
    const agent = await staffSession(alphaId, "agent");
    const requestedAt = new Date(Date.now() - 2 * HOUR).toISOString();
    const byCustomer = await seedBooking({
      status: "cancelled",
      ticketingStatus: "not_applicable",
      cancelledBy: "customer",
      cancelReason: "illness",
    });
    await seedEvent(byCustomer, {
      type: "booking.cancelled",
      actorType: "customer",
      visible: true,
      data: {
        cancelledBy: "customer",
        reasonCode: "illness",
        comment: "Sick",
        requestedAt,
        ticketsVoided: false,
        estimatedRefund: { amount: "0.00", currency: "EUR" },
        refundStatus: "not_applicable",
      },
    });
    const byStaff = await seedBooking({
      status: "cancelled",
      ticketingStatus: "not_applicable",
      cancelReason: "duplicate",
    });
    await seedEvent(byStaff, {
      type: "booking.cancelled",
      actorType: "staff",
      data: { cancelledBy: "staff", reason: "Booked twice by the agency" },
    });
    const requested = await seedBooking({ ticketingStatus: "pending" });
    await seedEvent(requested, {
      type: "booking.cancellation_requested",
      actorType: "customer",
      visible: true,
      data: {
        mode: "request_only",
        cause: "request_only",
        reasonCode: "found_cheaper",
        comment: "Cheaper elsewhere",
        requestedAt,
        amountPaid: "0.00",
        estimatedRefund: { amount: "0.00", currency: "EUR" },
      },
    });
    // Self-service cancellation on for this test, so canCancel names the pending request (the OTA's switch comes
    // first otherwise).
    const features = async (on: boolean) =>
      await inTenant("tenant_alpha", (trx) =>
        trx
          .updateTable("storefront_settings")
          .set({
            features: sql`jsonb_set(features, '{selfServiceCancellation}', ${JSON.stringify(on)}::jsonb)`,
          })
          .execute(),
      );
    await features(true);
    let customerRes: Response;
    let staffRes: Response;
    let requestRes: Response;
    try {
      customerRes = await agent.get(`/v1/console/bookings/${byCustomer}`);
      staffRes = await agent.get(`/v1/console/bookings/${byStaff}`);
      requestRes = await agent.get(`/v1/console/bookings/${requested}`);
    } finally {
      await features(false);
    }
    for (const res of [customerRes, staffRes, requestRes]) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("consoleGetBooking", res);
    }
    expect(customerRes.body.cancellation).toMatchObject({
      status: "cancelled",
      cancelledBy: "customer",
      reasonCode: "illness",
      comment: "Sick",
      requestedAt,
      estimatedRefund: { amount: "0.00", currency: "EUR" },
      refund: null,
      refundStatus: "not_applicable",
    });
    // Console scope shows the staff member's reason; customer scope never would.
    expect(staffRes.body.cancellation).toMatchObject({
      status: "cancelled",
      cancelledBy: "staff",
      reasonCode: "duplicate",
      comment: "Booked twice by the agency",
    });
    expect(requestRes.body.cancellation).toMatchObject({
      status: "pending",
      cancelledAt: null,
      cancelledBy: "customer",
      reasonCode: "found_cheaper",
      comment: "Cheaper elsewhere",
      requestedAt,
      refund: null,
      refundStatus: "not_applicable",
    });
    expect(requestRes.body.allowedActions).toMatchObject({
      canCancel: false,
      reasons: { canCancel: "pending" },
    });
  });

  it("answers what each role and key may do now, and why not", async () => {
    const viewer = await staffSession(alphaId, "viewer");
    const finance = await staffSession(alphaId, "finance");
    const confirmed = await seedBooking({ ticketingDeadlineInMs: 2 * DAY });
    const pending = await seedBooking({ status: "pending", reconcileOutcome: "manual_review" });
    const ticketed = await seedBooking({ status: "ticketed" });
    const failed = await seedBooking({
      status: "failed",
      failure: { code: "SOLD_OUT", message: "Amadeus 34651: no seats left in Q." },
    });

    const actions = async (session: AdminSession, bookingId: string) => {
      const res = await session.get(`/v1/console/bookings/${bookingId}`);
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("consoleGetBooking", res);
      return res.body as JsonObject;
    };
    const viewed = await actions(viewer, confirmed);
    const financed = await actions(finance, confirmed);
    const pendingView = await actions(finance, pending);
    const ticketedView = await actions(finance, ticketed);
    const failedView = await actions(finance, failed);
    const keyView = await request(api.server)
      .get(`/v1/console/bookings/${confirmed}`)
      .set("X-Api-Key", alphaAutomationKey);

    expect(viewed["consoleActions"]).toEqual({
      canIssue: false,
      canPatch: false,
      canCancel: false,
      canResync: false,
      canRetrieve: true,
      canAddNote: false,
      reasons: {
        canIssue: "no_permission",
        canPatch: "no_permission",
        canCancel: "no_permission",
        canResync: "no_permission",
        canAddNote: "no_permission",
      },
    });
    expect(financed["consoleActions"]).toMatchObject({ canIssue: false, canRetrieve: true });
    expect(pendingView).toMatchObject({
      status: "pending",
      amadeusOrderId: null,
      supplierSync: { status: "not_applicable" },
      syncStatus: "fresh",
      consoleActions: { canRetrieve: false, reasons: { canRetrieve: "pending" } },
    });
    expect(ticketedView["consoleActions"]).toMatchObject({ canRetrieve: true });
    expect(failedView).toMatchObject({
      failure: { code: "SOLD_OUT", message: "Amadeus 34651: no seats left in Q." },
      consoleActions: { canRetrieve: false, reasons: { canRetrieve: "failed" } },
    });
    expect(answer(keyView)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetBooking", keyView);
    expect(keyView.body.consoleActions).toMatchObject({
      canRetrieve: true,
      canIssue: false,
      reasons: { canIssue: "no_permission", canAddNote: "no_permission" },
    });
    // An agent may issue a confirmed booking before its deadline, not a ticketed, overdue, flown or cancelled one.
    const agent = await staffSession(alphaId, "agent");
    const overdue = await seedBooking({ ticketingDeadlineInMs: -HOUR });
    const flown = await seedBooking({ departInMs: -2 * DAY });
    const cancelled = await seedBooking({ status: "cancelled", ticketingStatus: "not_applicable" });
    expect((await actions(agent, confirmed))["consoleActions"]).toMatchObject({
      canIssue: true,
      reasons: {},
    });
    expect((await actions(agent, ticketed))["consoleActions"]).toMatchObject({
      canIssue: false,
      canCancel: true,
      reasons: { canIssue: "already_ticketed" },
    });
    expect((await actions(agent, overdue))["consoleActions"]).toMatchObject({
      canIssue: false,
      reasons: { canIssue: "deadline_passed" },
    });
    expect((await actions(agent, flown))["consoleActions"]).toMatchObject({
      canIssue: false,
      canCancel: false,
      canPatch: true,
      reasons: { canIssue: "flown", canCancel: "flown" },
    });
    expect((await actions(agent, cancelled))["consoleActions"]).toMatchObject({
      canIssue: false,
      canPatch: false,
      canCancel: false,
      canResync: true,
      canAddNote: true,
      reasons: { canIssue: "cancelled", canPatch: "cancelled", canCancel: "cancelled" },
    });
  });

  it("[OBE-061 AC2] answers 404 for a booking of the other environment or another tenant, and serves it in its own", async () => {
    const testAgent = await staffSession(betaId, "agent", "test");
    const liveAgent = await staffSession(betaId, "agent", "live");
    const testBooking = await seedBooking({ schema: "tenant_beta" });
    const liveBooking = await seedBooking({ schema: "tenant_beta", environment: "live" });
    const alphaBooking = await seedBooking();

    const liveFromTest = await testAgent.get(`/v1/console/bookings/${liveBooking}?refresh=true`);
    const testFromLive = await liveAgent.get(`/v1/console/bookings/${testBooking}`);
    const otherTenant = await testAgent.get(`/v1/console/bookings/${alphaBooking}`);
    const unknown = await testAgent.get(`/v1/console/bookings/${newId("bkg")}`);
    const ownLive = await liveAgent.get(`/v1/console/bookings/${liveBooking}`);
    const ownTest = await testAgent.get(`/v1/console/bookings/${testBooking}`);

    for (const res of [liveFromTest, testFromLive, otherTenant, unknown]) {
      expect(answer(res)).toEqual([404, "NOT_FOUND"]);
      expectResponseToMatch("consoleGetBooking", res);
    }
    // The same answer as an id that does not exist, apart from the request id; no Amadeus call.
    const withoutRequestId = (res: Response) => ({ ...res.body.error, requestId: undefined });
    expect(withoutRequestId(liveFromTest)).toEqual(withoutRequestId(unknown));
    expect(amadeusCalls("getFlightOrder")).toHaveLength(0);
    expect(answer(ownLive)).toEqual([200, undefined]);
    expect(ownLive.body).toMatchObject({ id: liveBooking, environment: "live" });
    expect(answer(ownTest)).toEqual([200, undefined]);
    expect(ownTest.body).toMatchObject({ id: testBooking, environment: "test" });
    // Lists too: test-environment staff never see the live booking, live staff never the test one.
    const testIds = listIds(await testAgent.get("/v1/console/bookings?limit=100"));
    const liveIds = listIds(await liveAgent.get("/v1/console/bookings?limit=100"));
    expect(testIds).toContain(testBooking);
    expect(testIds).not.toContain(liveBooking);
    expect(testIds).not.toContain(alphaBooking);
    expect(liveIds).toEqual([liveBooking]);
  });

  it("refreshes from Flight Order Management with refresh=true at most once in 10 seconds", async () => {
    const agent = await staffSession(alphaId, "agent");
    // The stub answers the GET with the full passport number: it must reach neither the answer nor the logs.
    const documentNumber = newDocumentNumber();
    const order = await newStubOrder(documentNumber);
    const bookingId = await seedBooking({
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });
    const pending = await seedBooking({ status: "pending" });

    const first = await agent.get(`/v1/console/bookings/${bookingId}?refresh=true`);
    const second = await agent.get(`/v1/console/bookings/${bookingId}?refresh=true`);
    const withoutOrder = await agent.get(`/v1/console/bookings/${pending}?refresh=true`);

    expect(answer(first)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetBooking", first);
    expect(first.body).toMatchObject({
      syncStatus: "refreshed",
      supplierSync: { status: "refreshed", lastError: null },
      consoleActions: { canResync: false, reasons: { canResync: "throttled" } },
    });
    expect(first.body.supplierSync.lastSyncedAt).not.toBeNull();
    // The refreshed order is the console's net order, its documents cut to their last 4 characters.
    const refreshedOrder = (first.body.amadeus as { order: JsonObject }).order;
    expect(
      ((refreshedOrder["travelers"] as JsonObject[])[0]?.["documents"] as JsonObject[])[0],
    ).toMatchObject({
      number: documentNumber.slice(-4),
    });
    for (const res of [first, second]) {
      expect(JSON.stringify(res.body)).not.toContain(documentNumber);
    }
    expect(api.sink.text()).not.toContain(documentNumber);
    expect(answer(second)).toEqual([200, undefined]);
    expect(second.body).toMatchObject({ syncStatus: "throttled", supplierSync: { status: "throttled" } });
    expect(withoutOrder.body).toMatchObject({ supplierSync: { status: "not_applicable" } });
    expect(amadeusCalls("getFlightOrder")).toHaveLength(1);
    // The call is logged as the console's, with the staff member, and listed with the booking.
    const logged = await inTenant("tenant_alpha", (trx) =>
      trx
        .selectFrom("supplier_requests")
        .select(["id", "operation", "staff_id"])
        .where("booking_id", "=", bookingId)
        .execute(),
    );
    expect(logged).toEqual([
      { id: expect.any(String), operation: "console.bookings.get", staff_id: agent.member.staffId },
    ]);
    expect(first.body.supplierSync.lastSupplierRequestId).toBe(logged[0]?.id);
    expect(first.body.recentSupplierRequests).toEqual([
      expect.objectContaining({ id: logged[0]?.id, operation: "console.bookings.get" }),
    ]);
    // The claim is the booking's column since FIX-W27-SYNC: nothing of it on the timeline.
    expect((first.body.events as JsonObject[]).map((event) => event["type"])).not.toContain(
      "booking.sync_requested",
    );
  });

  it("[FIX-W27-SYNC AC5] fills nextScheduledSyncAt from the sync's schedule and differences from the last diff", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await newStubOrder();
    // Waits for its tickets, its ticketing deadline 20 hours away: hourly in the 24 h before it.
    const nearDeadline = await seedBooking({
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
      ticketingDeadlineInMs: 20 * HOUR,
    });
    const [segment] = snapshotSegmentsOf(redactPayload(order)) ?? [];
    if (segment === undefined) {
      throw new Error("the stub order has no segment");
    }
    const departure = local(new Date(new Date(`${segment.departureLocal}Z`).getTime() + HOUR));
    stub.orders.changeSegment(order["id"] as string, segment.amadeusSegmentId, { departureAt: departure });
    const ticketed = await seedBooking({ status: "ticketed", lastSyncedAgoMs: 2 * HOUR });
    const pending = await seedBooking({ status: "pending" });

    // The staff refresh sees the airline's change first: the diff of the background sync records it.
    const refreshed = await agent.get(`/v1/console/bookings/${nearDeadline}?refresh=true`);
    const read = await Promise.all([ticketed, pending].map((id) => agent.get(`/v1/console/bookings/${id}`)));

    expect(answer(refreshed)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetBooking", refreshed);
    const sync = supplierSyncOf(refreshed);
    expect(sync).toMatchObject({
      status: "refreshed",
      differences: [
        {
          path: "/itineraries/0/segments/0/departure/at",
          label: `${segment.carrierCode}${segment.flightNumber} departure time`,
          before: segment.departureLocal,
          after: departure,
        },
      ],
    });
    // Refreshed now (and claimed now): next due an hour later, the deadline's hourly rhythm.
    expect(sync.nextScheduledSyncAt).toBe(
      new Date(new Date(String(sync.lastSyncedAt)).getTime() + HOUR).toISOString(),
    );
    expect((refreshed.body.events as JsonObject[]).map((event) => event["type"])).toContain(
      "booking.schedule_changed",
    );
    // A ticketed booking synchronised 2 hours ago: every 6 hours. A pending one has no order to synchronise.
    for (const res of read) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("consoleGetBooking", res);
    }
    const [ticketedSync, pendingSync] = read.map(supplierSyncOf);
    expect(ticketedSync).toMatchObject({ status: "fresh", differences: [] });
    expect(ticketedSync?.nextScheduledSyncAt).toBe(
      new Date(new Date(String(ticketedSync?.lastSyncedAt)).getTime() + 6 * HOUR).toISOString(),
    );
    expect(pendingSync).toMatchObject({
      status: "not_applicable",
      nextScheduledSyncAt: null,
      differences: [],
    });
  });
});
