// Own Stripe, own Amadeus and go-live across the backends (OBE-083; ota/docs/scope.md OF-12 AC1 and AC2, PADR-0017
// item 2). The stack of ./stack.ts runs the BUILT platform API, worker and `dev:seed` and the BUILT OTA API and worker on
// one database clone and one Redis database, with the Velexis Amadeus stub, the stubs of an OTA's own test and live
// credentials and the fake Stripe API in this process, and the platform's M5 switches on (Stripe billing aside: its
// Checkout cannot run here, stack.ts).
//
// One owner signs up through the portal's API (Mailpit carries the verification link), turns MFA on and steps up (a TOTP
// code of the setup's secret), and creates two OTAs, which the real OTA worker sets up: **alpha** moves to its own
// accounts step by step, **beta** stays on Velexis's throughout. Each has a secret test key and calls the OTA API as a
// storefront's server does. Then, in setup hooks with budgets of their own (the tests check what they recorded):
//
// 1. Baseline: alpha takes the card payment of a checkout the way every OTA starts: the search and the pricing reach
//    the Velexis stub, the PaymentIntent is created with the Velexis Stripe key and no `Stripe-Account`. An order is made on the
//    Velexis stub for alpha's assigned Velexis office, as checkout.complete made one earlier.
// 2. Own Amadeus (plan step 2): the owner submits alpha's own test credentials (submitAmadeusCredentials); the platform
//    worker verifies them against the own stub, which accepts only them, switches the connection and moves the Velexis
//    office to `releasing`. Once the platform has said `applied` and the OTA has dropped its cached connection (the
//    `connection` invalidation), alpha's next search reaches the own stub and answers 200 there (a stub hands out its own
//    tokens and refuses any other, so only the own credentials can have served it), and nothing reaches the Velexis
//    stub. The earlier booking (the order of step 1, two days old, owned by the office that is now `releasing`, and
//    still is once the sync has run) is synchronised by the OTA worker's `booking.sync` job through the Velexis stub
//    [OF-12 AC2]. Its row, as checkout.complete leaves one, is written after the switch, so that no sync scan of the
//    OTA worker can have read the order before it (a scan that takes it after the switch proves the same as the job).
// 3. Own Stripe (plan step 3): the owner submits alpha's own Stripe test keys (submitStripeApiKeys); the platform worker
//    verifies them with `GET /v1/account` at the fake Stripe API, which knows only that key, and switches the payment
//    connection to `api_keys`. The next PaymentIntent of alpha is created with alpha's own secret key and answers its
//    own publishable key. Then alpha's test connection becomes `connect_standard` with a connected account, as the
//    platform's Connect callback leaves it (a fixture: the OAuth runs on Stripe's pages), with the `connection`
//    invalidation the platform publishes: the next PaymentIntent is created with the Velexis key and `Stripe-Account:
//    <acct_…>`. Meanwhile beta's search still reaches the Velexis stub and its PaymentIntent uses the Velexis key without
//    `Stripe-Account`: the same processes, never restarted or reconfigured, serve both OTAs differently from data alone
//    (the connection resolver and the payment gateway are the only branches) [OF-12 AC1].
// 4. Go-live (plan step 4): the owner submits alpha's own live Amadeus credentials (an active live connection), and
//    goLive answers `422 LIVE_PRECONDITIONS_UNMET` with only the plan's live mode and the subscription missing. The
//    plan and the subscription are then written as the billing sync leaves them for a paid plan (a plan with
//    `liveMode`, an `active` Stripe subscription; Stripe Checkout cannot run here, stack.ts), and goLive switches alpha
//    to live with every precondition met. The storefront configuration the OTA API answers on alpha's storefront host
//    reports `environment: live` within one second of the goLive call, while the OTA's cached tenant row had more than
//    that second left to live (so the `tenant` invalidation did it, not an expiry).
//
// Keys, secrets and the TOTP secret exist only in this process's memory (and the stack's processes): never logged or
// printed; an error names an outcome (`401 INVALID_API_KEY`), never a body. The stack and the journeys are expensive
// (four Node processes, Argon2id, Mailpit, the setups): they run in setup hooks with explicit bounds, and the tests
// check what happened.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { BULLMQ_PREFIX, INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { sql, tenantTx } from "@velexis/db";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { TOKEN_OPERATION, type AmadeusStub } from "@velexis/testing/amadeus";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBookingReference } from "../../src/bookings/booking-reference";
import { bookingSyncJob } from "../../src/bookings/booking-sync.processor";
import { orderSegmentsOf, type OrderSegment } from "../../src/bookings/order-diff";
import { readCreatedOrder } from "../../src/bookings/order-recorder";
import { buildCreateOrderRequest } from "../../src/bookings/order-request.builder";
import { newId } from "../../src/common/ids";
import { OTA_QUEUE } from "../../src/common/queues/queue-names";
import { redisKeys } from "../../src/common/redis/redis.keys";
import { minuteBucket } from "../../src/jobs/fan-out";
import { buildOrderRequestInput, pricedFlightOffer } from "../builders/bookings";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../builders/checkouts";
import type { FakeStripeRequest } from "../helpers/fake-stripe";
import {
  assertBuilt,
  BuildMissingError,
  createOta,
  createSecretKey,
  enableMfaWithStepUp,
  expectStatus,
  httpCall,
  newStripeKeys,
  outcomeOf,
  platformCall,
  randomBase62,
  REPO_ROOT,
  signUpOwner,
  startStack,
  waitForSetup,
  waitForSubmission,
  type CreatedKey,
  type CreatedOta,
  type HttpAnswer,
  type PortalOwner,
  type Stack,
  type StripeKeyPair,
  type Submission,
} from "./stack";

/**
 * Starting the stack: the template clone, three stubs, `dev:seed` and four Node processes, a few seconds each locally;
 * each readiness wait fails by itself after 60 s. Both API documents' response checkers are parsed here too.
 */
const STACK_TIMEOUT_MS = 240_000;
/**
 * The journey's start: sign-up and sign-in (Argon2id each), the verification e-mail (at most 20 s), MFA, two OTAs and
 * their setups (at most 60 s each, then waitForSetup fails by itself), two keys.
 */
const JOURNEY_TIMEOUT_MS = 200_000;
/** One step: a few OTA calls (each at most 10 s), a credential submission (at most 30 s), a sync job (at most 30 s). */
const STEP_TIMEOUT_MS = 120_000;
/** Stopping four processes (SIGTERM, at most 10 s each before SIGKILL), the fakes, the pools, the database. */
const STOP_TIMEOUT_MS = 60_000;
/** The acceptance bound of plan step 4: the storefront configuration reports `live` within one second of goLive. */
const PROPAGATION_BOUND_MS = 1_000;
/** How long a hook keeps asking the OTA API after goLive before it gives up: well past the bound. */
const GIVE_UP_MS = 10_000;
/** The pause between two reads while a hook waits for a state (a cache entry, a storefront answer, a booking). */
const WAIT_POLL_MS = 25;
/** How long a hook waits for the OTA's state to follow the platform (an invalidation, a cache entry, a sync). */
const FOLLOW_TIMEOUT_MS = 30_000;
/** How many storefront calls a hook makes at most to have the tenant row cached before goLive. */
const WARM_UP_CALLS = 20;

/** Documentation addresses (RFC 5737) of the owner and of the storefronts' visitors. */
const OWNER_IP = "203.0.113.83";
const VISITOR_IP = "198.51.100.83";
/** The two OTAs (the clone is this file's own, so the keys are free). */
const ALPHA = { key: "xbalpha", name: "Own Accounts Travel" } as const;
const BETA = { key: "xbbeta", name: "Velexis Accounts Travel" } as const;

/** The stub operations of a flight offers search (the OTA's simple search uses one of them). */
const SEARCH_OPERATIONS: ReadonlySet<string> = new Set(["getFlightOffers", "searchFlightOffers"]);

type JsonObject = Record<string, unknown>;

/** True while `pid` names a running process (signal 0 checks that it exists and sends nothing). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** An OTA of the journey: what createTenant answered and its secret test key. */
interface JourneyOta {
  readonly ota: CreatedOta;
  readonly key: CreatedKey;
}

/** A checkout payment through the OTA API, and the PaymentIntent request it sent to the fake Stripe API. */
interface PaymentRun {
  readonly search: HttpAnswer;
  readonly payment: HttpAnswer;
  readonly intent: FakeStripeRequest | undefined;
}

/** What the Amadeus stubs saw during a step: the operations each answered, with their statuses. */
interface StubTraffic {
  readonly velexis: readonly StubCall[];
  readonly ownTest: readonly StubCall[];
}

interface StubCall {
  readonly operation: string | undefined;
  readonly path: string;
  /** `undefined` while the stub has not answered it. */
  readonly status: number | undefined;
}

describe("[OBE-083] own Amadeus, own Stripe and go-live across the backends", () => {
  let stack: Stack;
  let owner: PortalOwner;
  let alpha: JourneyOta;
  let beta: JourneyOta;
  /** The `vx:invalidate` events of the stack's Redis since the journey started, in order. */
  const invalidations: InvalidationEvent[] = [];
  let subscriber: Redis;
  /** The process ids of the four processes when the stack had started. */
  let pids: readonly (number | undefined)[];
  let searchCount = 0;

  // Step 1.
  let alphaOffice: string;
  let baseline: PaymentRun;
  let baselineTraffic: StubTraffic;
  let earlierOrder: {
    readonly id: string;
    readonly recordLocator: string;
    readonly segments: readonly OrderSegment[];
  };

  // Step 2.
  let ownAmadeusSubmitted: HttpAnswer;
  let ownAmadeusApplied: HttpAnswer;
  let verificationTraffic: StubTraffic;
  let officeAfterSwitch: { readonly status: string; readonly assignedTenantId: string | null } | undefined;
  let searchAfterSwitch: HttpAnswer;
  let searchAfterSwitchTraffic: StubTraffic;
  let earlierBookingId: string;
  let syncTraffic: StubTraffic;
  let earlierBookingAfterSync:
    { readonly lastSyncedAt: Date | null; readonly syncError: unknown } | undefined;
  let officeAfterSync: { readonly status: string; readonly assignedTenantId: string | null } | undefined;
  const earlierBookingSyncedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  // Step 3.
  let ownStripe: StripeKeyPair;
  const ownStripeAccount = `acct_xb${randomBase62(16)}`;
  let ownStripeSubmitted: HttpAnswer;
  let ownStripeApplied: HttpAnswer;
  let accountChecks: readonly FakeStripeRequest[];
  let apiKeysConnection:
    | {
        readonly accountMode: string;
        readonly accountReference: string | null;
        readonly publishableKey: string | null;
      }
    | undefined;
  let apiKeysRun: PaymentRun;
  const connectAccount = `acct_xbconnect${randomBase62(12)}`;
  let connectRun: PaymentRun;
  let betaRun: PaymentRun;
  let betaTraffic: StubTraffic;

  // Step 4.
  let liveAmadeusApplied: HttpAnswer;
  let goLiveRefused: HttpAnswer;
  let goLive: HttpAnswer;
  let tenantCacheTtlMs: number;
  let liveStorefront: {
    readonly last: HttpAnswer;
    readonly elapsedMs: number | undefined;
    readonly calls: number;
  };

  /** The OTA API as a storefront's server calls it for one visitor, with `tenant`'s secret key. */
  function otaCall(
    tenant: JourneyOta,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<HttpAnswer> {
    return httpCall(stack.otaApi.url, method, path, {
      headers: {
        "X-Api-Key": tenant.key.key,
        "X-Velexis-End-User-IP": VISITOR_IP,
        "X-Velexis-End-User-Agent": "Mozilla/5.0 (cross-backend storefront server)",
        ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
      },
      body,
    });
  }

  /** `answer.body.id`, or a clear error naming the operation and its outcome. */
  function idOf(answer: HttpAnswer, operation: string, status: number): string {
    expectStatus(answer, status, operation);
    const id = (answer.body as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") {
      throw new Error(`${operation} answered no id`);
    }
    return id;
  }

  /** Empties the request logs of the Velexis stub and of the own test stub. */
  function clearStubs(): void {
    stack.velexisStub.clearRequests();
    stack.ownStubs.test.clearRequests();
  }

  /** What the two test stubs answered since `clearStubs`. */
  function stubTraffic(): StubTraffic {
    const of = (stub: AmadeusStub): StubCall[] =>
      stub.requests().map(({ operation, path, status }) => ({ operation, path, status }));
    return { velexis: of(stack.velexisStub), ownTest: of(stack.ownStubs.test) };
  }

  /** A simple search of the stub's Madrid–Paris Orly offers on a date of its own (no two searches alike). */
  function search(tenant: JourneyOta): Promise<HttpAnswer> {
    searchCount += 1;
    return otaCall(tenant, "POST", "/v1/flight-searches", {
      mode: "simple",
      originLocationCode: "MAD",
      destinationLocationCode: "ORY",
      departureDate: dateFromToday(60 + searchCount),
      adults: 1,
    });
  }

  /**
   * A card payment of a new checkout: a search, its offer 2 moved 60 days ahead in the OTA's store (the stub's offers
   * carry the fixture's dates; tenant data through `tenantTx`, as velexis_ota_app), the pricing, the checkout with a
   * traveller and a contact, and createCheckoutPayment; with the PaymentIntent request the fake Stripe API received for
   * the payment (`metadata.payment_id`).
   */
  async function checkoutPayment(tenant: JourneyOta): Promise<PaymentRun> {
    const searched = await search(tenant);
    const searchId = idOf(searched, "createFlightSearch", 201);
    const flightDate = dateFromToday(60);
    const offerId = await tenantTx(stack.tenantDb, tenant.ota.schemaName, async (trx) => {
      await trx
        .updateTable("flight_offers")
        .set({
          payload: sql`jsonb_set(jsonb_set(jsonb_set(payload,
            '{itineraries,0,segments,0,departure,at}', to_jsonb(${`${flightDate}T07:15:00`}::text)),
            '{itineraries,0,segments,0,arrival,at}', to_jsonb(${`${flightDate}T09:20:00`}::text)),
            '{lastTicketingDate}', to_jsonb(${dateFromToday(30)}::text))`,
          last_ticketing_date: dateFromToday(30),
        })
        .where("search_id", "=", searchId)
        .execute();
      const row = await trx
        .selectFrom("flight_offers")
        .select("id")
        .where("search_id", "=", searchId)
        .where("amadeus_offer_id", "=", "2")
        .executeTakeFirstOrThrow();
      return row.id;
    });
    const pricedOfferId = idOf(
      await otaCall(tenant, "POST", "/v1/priced-offers", { offerIds: [offerId] }),
      "priceFlightOffers",
      201,
    );
    const checkoutId = idOf(
      await otaCall(tenant, "POST", "/v1/checkouts", { pricedOfferId }),
      "createCheckout",
      201,
    );
    expectStatus(
      await otaCall(tenant, "PUT", `/v1/checkouts/${checkoutId}/travelers`, {
        travelers: [buildTravelerInput()],
      }),
      200,
      "setCheckoutTravelers",
    );
    expectStatus(
      await otaCall(tenant, "PUT", `/v1/checkouts/${checkoutId}/contacts`, {
        contacts: [buildContactInput()],
      }),
      200,
      "setCheckoutContacts",
    );
    const payment = await otaCall(tenant, "POST", `/v1/checkouts/${checkoutId}/payments`, {
      method: "card",
      termsAccepted: true,
    });
    const paymentId = idOf(payment, "createCheckoutPayment", 201);
    const intent = stack.stripe.requests.find(
      (request) =>
        request.method === "POST" &&
        request.path === "/v1/payment_intents" &&
        (request.form["metadata"] as JsonObject | undefined)?.["payment_id"] === paymentId,
    );
    return { search: searched, payment, intent };
  }

  /**
   * Waits until an event the stack's Redis carried after the first `since` ones `matches`; rejects after
   * FOLLOW_TIMEOUT_MS naming `what`.
   */
  async function invalidationSeen(
    what: string,
    since: number,
    matches: (event: InvalidationEvent) => boolean,
  ): Promise<void> {
    const started = performance.now();
    while (!invalidations.slice(since).some(matches)) {
      if (performance.now() - started >= FOLLOW_TIMEOUT_MS) {
        throw new Error(
          `no ${what} invalidation reached the stack's Redis within ${FOLLOW_TIMEOUT_MS / 1000} s`,
        );
      }
      await delay(WAIT_POLL_MS);
    }
  }

  /**
   * Waits until the OTA's cached connection `conn:<kind>:<tenantId>:test` is gone or `isNew` accepts its value: the OTA
   * has dropped the row it cached before the platform's change, so its next call reads the new row.
   */
  async function cachedConnectionFollowed(
    kind: "amadeus" | "payment",
    tenantId: string,
    isNew: (value: JsonObject) => boolean,
  ): Promise<void> {
    const key = redisKeys.conn(kind, tenantId, "test").key;
    const started = performance.now();
    for (;;) {
      const cached = await stack.redis.client.get(key);
      const value = cached === null ? undefined : (JSON.parse(cached) as { value?: JsonObject }).value;
      if (value === undefined || isNew(value)) {
        return;
      }
      if (performance.now() - started >= FOLLOW_TIMEOUT_MS) {
        throw new Error(
          `the OTA still caches the ${kind} connection of ${tenantId} as it was before the change`,
        );
      }
      await delay(WAIT_POLL_MS);
    }
  }

  /** getStorefront on alpha's storefront host, as Caddy forwards the hosted storefront's request. */
  function storefrontOfAlpha(): Promise<HttpAnswer> {
    return httpCall(stack.otaApi.url, "GET", "/v1/storefront", {
      headers: stack.edgeHeaders(alpha.ota.storefrontHost),
    });
  }

  beforeAll(async () => {
    stack = await startStack();
    pids = stack.processes().map((process) => process.pid);
    // Parses both documents here, not in the first test that checks an answer.
    responseChecker("platform");
    responseChecker("ota");
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    subscriber?.disconnect();
    await stack?.stop();
  }, STOP_TIMEOUT_MS);

  beforeAll(async () => {
    subscriber = new Redis(stack.redis.url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    subscriber.on("message", (_channel: string, message: string) => {
      invalidations.push(JSON.parse(message) as InvalidationEvent);
    });
    await subscriber.connect();
    await subscriber.subscribe(INVALIDATION_CHANNEL);

    owner = await signUpOwner(stack, { label: "xb-m5-owner", ip: OWNER_IP });
    await enableMfaWithStepUp(stack, owner);
    const alphaOta = await createOta(stack, owner, ALPHA);
    const betaOta = await createOta(stack, owner, BETA);
    await waitForSetup(stack, owner, alphaOta.tenantId);
    await waitForSetup(stack, owner, betaOta.tenantId);
    alpha = { ota: alphaOta, key: await createSecretKey(stack, owner, alphaOta.tenantId) };
    beta = { ota: betaOta, key: await createSecretKey(stack, owner, betaOta.tenantId) };
  }, JOURNEY_TIMEOUT_MS);

  // ---- Step 1: the baseline, and the order of an earlier booking -------------------------------------------------

  beforeAll(async () => {
    const connection = await stack.migrator
      .selectFrom("platform.supplier_connections")
      .select(["owner_office_id", "credential_source"])
      .where("tenant_id", "=", alpha.ota.tenantId)
      .where("environment", "=", "test")
      .executeTakeFirstOrThrow();
    if (connection.owner_office_id === null || connection.credential_source !== "velexis") {
      throw new Error("alpha's test connection is not on a Velexis office after its setup");
    }
    alphaOffice = connection.owner_office_id;

    clearStubs();
    baseline = await checkoutPayment(alpha);
    baselineTraffic = stubTraffic();

    // The order of a booking alpha made earlier through the Velexis account, as its client sent it: a token of the
    // Velexis stub (it accepts any client), then Flight Create Orders of offer 2, 60 days ahead, on alpha's office.
    const tokenAnswer = await fetch(`${stack.velexisStub.url}/v1/security/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "xb-earlier-booking",
        client_secret: randomBytes(16).toString("base64url"),
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const { access_token: token } = (await tokenAnswer.json()) as { access_token: string };
    const offer = pricedFlightOffer();
    const departure = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60 * 24 * 60 * 60 * 1000);
    const local = (instant: Date): string => instant.toISOString().slice(0, 19);
    for (const itinerary of offer["itineraries"] as JsonObject[]) {
      for (const segment of itinerary["segments"] as JsonObject[]) {
        (segment["departure"] as JsonObject)["at"] = local(departure);
        (segment["arrival"] as JsonObject)["at"] = local(new Date(departure.getTime() + 125 * 60_000));
      }
    }
    const request = buildCreateOrderRequest(
      buildOrderRequestInput({
        flightOffers: [offer],
        reference: newBookingReference(),
        queue: null,
        offices: { queuing: alphaOffice, owner: alphaOffice },
        issue: false,
      }),
    );
    const created = await fetch(`${stack.velexisStub.url}/v1/booking/flight-orders`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/vnd.amadeus+json" },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(10_000),
    });
    const order = readCreatedOrder((await created.json()) as unknown);
    const recordLocator = order?.records[0]?.reference;
    if (created.status !== 201 || order === undefined || recordLocator === undefined) {
      throw new Error(`the Velexis stub's createFlightOrders answered ${created.status}`);
    }
    earlierOrder = { id: order.id, recordLocator, segments: orderSegmentsOf(order) };
  }, STEP_TIMEOUT_MS);

  // ---- Step 2: own Amadeus credentials ---------------------------------------------------------------------------

  beforeAll(async () => {
    const ownOffices = [`XBO1A${randomBase62(4).toUpperCase()}`, `XBO2A${randomBase62(4).toUpperCase()}`];
    const since = invalidations.length;
    clearStubs();
    ownAmadeusSubmitted = await platformCall(
      stack,
      "PUT",
      `/v1/tenants/${alpha.ota.tenantId}/amadeus-connections/test/credentials`,
      {
        headers: owner.headers,
        body: {
          clientId: stack.ownAmadeus.test.clientId,
          clientSecret: stack.ownAmadeus.test.clientSecret,
          officeIds: ownOffices,
          defaultOfficeId: ownOffices[0],
        },
      },
    );
    expectStatus(ownAmadeusSubmitted, 202, "submitAmadeusCredentials");
    const submission = (ownAmadeusSubmitted.body as { submission: Submission }).submission;
    ownAmadeusApplied = await waitForSubmission(stack, owner, alpha.ota.tenantId, submission.id);
    if ((ownAmadeusApplied.body as Submission).status !== "applied") {
      throw new Error(
        `alpha's own Amadeus credentials were not applied: ${JSON.stringify(ownAmadeusApplied.body)}`,
      );
    }
    verificationTraffic = stubTraffic();
    const office = await stack.migrator
      .selectFrom("platform.amadeus_offices")
      .select(["status", "assigned_tenant_id as assignedTenantId"])
      .where("office_id", "=", alphaOffice)
      .executeTakeFirst();
    officeAfterSwitch = office;

    await invalidationSeen(
      "connection",
      since,
      (event) => event.type === "connection" && event.tenantId === alpha.ota.tenantId,
    );
    await cachedConnectionFollowed(
      "amadeus",
      alpha.ota.tenantId,
      (value) => value["credentialSource"] === "tenant",
    );
    clearStubs();
    searchAfterSwitch = await search(alpha);
    searchAfterSwitchTraffic = stubTraffic();

    // The earlier booking, as checkout.complete left it for the order of step 1 (two days ago, owned by alpha's Velexis
    // office, which is now `releasing`), then one `booking.sync` job of the OTA worker for it.
    earlierBookingId = newId("bkg");
    const departure = new Date(`${earlierOrder.segments[0]?.departureLocal ?? ""}Z`);
    await tenantTx(stack.tenantDb, alpha.ota.schemaName, async (trx) => {
      await trx
        .insertInto("bookings")
        .values({
          id: earlierBookingId,
          environment: "test",
          reference: newBookingReference(),
          status: "confirmed",
          amadeus_order_id: earlierOrder.id,
          record_locator: earlierOrder.recordLocator,
          origin_system_code: "GDS",
          queuing_office_id: alphaOffice,
          owner_office_id: alphaOffice,
          issue_requested: false,
          ticketing_status: "pending",
          trip_type: "one_way",
          origin_iata: "MAD",
          destination_iata: "ORY",
          first_departure_at: departure,
          last_arrival_at: new Date(departure.getTime() + 125 * 60_000),
          validating_carrier: "IB",
          currency: "EUR",
          net_amount: "100.00",
          total_amount: "115.00",
          amount_paid: "115.00",
          contact_email: `traveller-${randomBytes(4).toString("hex")}@example.com`,
          lead_last_name: "SAMPLE",
          last_synced_at: earlierBookingSyncedAt,
          created_at: earlierBookingSyncedAt,
          updated_at: earlierBookingSyncedAt,
        })
        .execute();
      await trx
        .insertInto("booking_travelers")
        .values({
          id: newId("btr"),
          booking_id: earlierBookingId,
          amadeus_traveler_id: "1",
          traveler_type: "ADULT",
          first_name: "TESTA",
          last_name: "SAMPLE",
        })
        .execute();
      const segments = earlierOrder.segments.map((segment) => ({
        id: newId("seg"),
        booking_id: earlierBookingId,
        amadeus_flight_offer_id: segment.amadeusFlightOfferId,
        amadeus_segment_id: segment.amadeusSegmentId,
        itinerary_index: segment.itineraryIndex,
        segment_index: segment.segmentIndex,
        carrier_code: segment.carrierCode,
        flight_number: segment.flightNumber,
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
        fare_details: JSON.stringify(segment.fareDetails),
      }));
      if (segments.length > 0) {
        await trx.insertInto("booking_segments").values(segments).execute();
      }
    });

    clearStubs();
    const connection = new Redis(stack.redis.url, { maxRetriesPerRequest: null });
    const queue = new Queue(OTA_QUEUE.bookings, { connection, prefix: BULLMQ_PREFIX });
    try {
      const job = bookingSyncJob(alpha.ota.tenantId, earlierBookingId, minuteBucket(new Date()));
      await queue.add(job.name, job.data, job.opts);
    } finally {
      await queue.close();
      connection.disconnect();
    }
    // The sync (this job, or a scan of the worker that took the booking first) records its outcome on the booking.
    const started = performance.now();
    for (;;) {
      earlierBookingAfterSync = await tenantTx(stack.tenantDb, alpha.ota.schemaName, (trx) =>
        trx
          .selectFrom("bookings")
          .select(["last_synced_at as lastSyncedAt", "sync_error as syncError"])
          .where("id", "=", earlierBookingId)
          .executeTakeFirst(),
      );
      const synced =
        (earlierBookingAfterSync?.lastSyncedAt?.getTime() ?? 0) > earlierBookingSyncedAt.getTime();
      if (synced || (earlierBookingAfterSync?.syncError ?? null) !== null) {
        break;
      }
      if (performance.now() - started >= FOLLOW_TIMEOUT_MS) {
        throw new Error("the OTA worker did not synchronise the earlier booking within 30 s");
      }
      await delay(WAIT_POLL_MS * 4);
    }
    syncTraffic = stubTraffic();
    officeAfterSync = await stack.migrator
      .selectFrom("platform.amadeus_offices")
      .select(["status", "assigned_tenant_id as assignedTenantId"])
      .where("office_id", "=", alphaOffice)
      .executeTakeFirst();
  }, STEP_TIMEOUT_MS);

  // ---- Step 3: own Stripe keys, then Connect ---------------------------------------------------------------------

  beforeAll(async () => {
    ownStripe = newStripeKeys("test");
    stack.stripe.accounts.set(ownStripe.secretKey, {
      id: ownStripeAccount,
      object: "account",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
    const since = invalidations.length;
    ownStripeSubmitted = await platformCall(
      stack,
      "PUT",
      `/v1/tenants/${alpha.ota.tenantId}/payment-connections/test/api-keys`,
      {
        headers: owner.headers,
        body: {
          publishableKey: ownStripe.publishableKey,
          secretKey: ownStripe.secretKey,
          webhookSecret: `whsec_${randomBase62(32)}`,
        },
      },
    );
    expectStatus(ownStripeSubmitted, 202, "submitStripeApiKeys");
    const submission = (ownStripeSubmitted.body as { submission: Submission }).submission;
    ownStripeApplied = await waitForSubmission(stack, owner, alpha.ota.tenantId, submission.id);
    accountChecks = stack.stripe.requests.filter(
      (request) => request.method === "GET" && request.path === "/v1/account",
    );
    if ((ownStripeApplied.body as Submission).status !== "applied") {
      throw new Error(`alpha's own Stripe keys were not applied: ${JSON.stringify(ownStripeApplied.body)}`);
    }
    apiKeysConnection = await stack.migrator
      .selectFrom("platform.payment_provider_connections")
      .select([
        "account_mode as accountMode",
        "account_reference as accountReference",
        "publishable_key as publishableKey",
      ])
      .where("tenant_id", "=", alpha.ota.tenantId)
      .where("environment", "=", "test")
      .executeTakeFirst();
    await invalidationSeen(
      "connection",
      since,
      (event) => event.type === "connection" && event.tenantId === alpha.ota.tenantId,
    );
    await cachedConnectionFollowed(
      "payment",
      alpha.ota.tenantId,
      (value) => value["accountMode"] === "api_keys",
    );
    apiKeysRun = await checkoutPayment(alpha);

    // alpha's test connection as the platform's Connect callback leaves it (PBE-055 step 3), and the `connection`
    // invalidation the platform publishes after its commit.
    const connectedAt = new Date();
    const switched = await stack.migrator
      .updateTable("platform.payment_provider_connections")
      .set((eb) => ({
        account_mode: "connect_standard",
        account_reference: connectAccount,
        publishable_key: null,
        secret_ciphertext: null,
        webhook_secret_ciphertext: null,
        encryption_key_id: null,
        capabilities: JSON.stringify({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true }),
        connected_at: connectedAt,
        disconnected_at: null,
        last_error: null,
        status: "active",
        version: eb("version", "+", 1),
        updated_at: connectedAt,
      }))
      .where("tenant_id", "=", alpha.ota.tenantId)
      .where("environment", "=", "test")
      .executeTakeFirst();
    if (switched.numUpdatedRows !== 1n) {
      throw new Error("alpha has no test payment connection to connect");
    }
    await stack.redis.client.publish(
      INVALIDATION_CHANNEL,
      JSON.stringify({
        v: 1,
        type: "connection",
        tenantId: alpha.ota.tenantId,
      } satisfies InvalidationEvent),
    );
    await cachedConnectionFollowed(
      "payment",
      alpha.ota.tenantId,
      (value) => value["accountMode"] === "connect_standard",
    );
    connectRun = await checkoutPayment(alpha);

    // beta, served by the same processes at the same time, on Velexis's accounts.
    clearStubs();
    betaRun = await checkoutPayment(beta);
    betaTraffic = stubTraffic();
  }, STEP_TIMEOUT_MS);

  // ---- Step 4: go-live -------------------------------------------------------------------------------------------

  beforeAll(async () => {
    const liveOffice = `XBL1A${randomBase62(4).toUpperCase()}`;
    const liveSubmitted = await platformCall(
      stack,
      "PUT",
      `/v1/tenants/${alpha.ota.tenantId}/amadeus-connections/live/credentials`,
      {
        headers: owner.headers,
        body: {
          clientId: stack.ownAmadeus.live.clientId,
          clientSecret: stack.ownAmadeus.live.clientSecret,
          officeIds: [liveOffice],
          defaultOfficeId: liveOffice,
        },
      },
    );
    expectStatus(liveSubmitted, 202, "submitAmadeusCredentials (live)");
    liveAmadeusApplied = await waitForSubmission(
      stack,
      owner,
      alpha.ota.tenantId,
      (liveSubmitted.body as { submission: Submission }).submission.id,
    );

    const goLiveCall = (): Promise<HttpAnswer> =>
      platformCall(stack, "POST", `/v1/tenants/${alpha.ota.tenantId}/go-live`, {
        headers: owner.headers,
        body: { confirm: true },
      });
    goLiveRefused = await goLiveCall();

    // A paid plan with live mode and its active Stripe subscription, as the billing sync leaves them (Checkout cannot
    // run here, stack.ts), and the `tenant` invalidation the platform publishes for a plan change.
    const planCode = "xblive";
    const now = new Date();
    await stack.migrator.transaction().execute(async (trx) => {
      await trx
        .insertInto("platform.plans")
        .values({
          code: planCode,
          name: "Cross-backend live",
          description: "A paid plan with live mode (OBE-083).",
          currency: "EUR",
          monthly_price: "49.00",
          per_booking_fee: "0",
          included_bookings: 0,
          limits: JSON.stringify({ staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode: true }),
          features: JSON.stringify({}),
          is_public: false,
          is_active: true,
          sort_order: 90,
          trial_days: 0,
          settlement_fee_bps: 0,
        })
        .execute();
      await trx
        .updateTable("platform.subscriptions")
        .set({ status: "canceled", canceled_at: now, updated_at: now })
        .where("tenant_id", "=", alpha.ota.tenantId)
        .execute();
      await trx
        .insertInto("platform.subscriptions")
        .values({
          id: newId("sub"),
          tenant_id: alpha.ota.tenantId,
          plan_code: planCode,
          status: "active",
          billing_interval: "month",
          billing_provider: "stripe",
          provider_customer_id: `cus_xb${randomBase62(14)}`,
          provider_subscription_id: `sub_xb${randomBase62(14)}`,
          current_period_start: now,
          current_period_end: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        })
        .execute();
      await trx
        .updateTable("platform.tenants")
        .set((eb) => ({ plan_code: planCode, version: eb("version", "+", 1), updated_at: now }))
        .where("id", "=", alpha.ota.tenantId)
        .execute();
    });
    await stack.redis.client.publish(
      INVALIDATION_CHANNEL,
      JSON.stringify({ v: 1, type: "tenant", id: alpha.ota.tenantId } satisfies InvalidationEvent),
    );

    // The OTA caches alpha's tenant row (60 s): asked until the entry has more than the bound left to live.
    const tenantCacheKey = redisKeys.tenant(alpha.ota.tenantId).key;
    tenantCacheTtlMs = await stack.redis.client.pttl(tenantCacheKey);
    for (let calls = 0; tenantCacheTtlMs <= PROPAGATION_BOUND_MS && calls < WARM_UP_CALLS; calls += 1) {
      await storefrontOfAlpha();
      tenantCacheTtlMs = await stack.redis.client.pttl(tenantCacheKey);
    }

    const since = performance.now();
    goLive = await goLiveCall();
    let calls = 0;
    for (;;) {
      const last = await storefrontOfAlpha();
      calls += 1;
      const now = performance.now();
      if ((last.body as { environment?: unknown } | undefined)?.environment === "live") {
        liveStorefront = { last, elapsedMs: now - since, calls };
        break;
      }
      if (now - since >= GIVE_UP_MS) {
        liveStorefront = { last, elapsedMs: undefined, calls };
        break;
      }
      await delay(WAIT_POLL_MS);
    }
  }, STEP_TIMEOUT_MS);

  // ---- The checks ------------------------------------------------------------------------------------------------

  it("[OBE-083 AC1] sets up two OTAs through the platform API and the real OTA worker, on Velexis's accounts", () => {
    for (const tenant of [alpha, beta]) {
      expectResponseToMatch("createApiKey", tenant.key.answer, { document: "platform" });
      expect(tenant.key.key).toMatch(/^sk_test_[A-Za-z0-9]{40}$/);
    }
    // Before any switch: alpha's search and pricing reached the Velexis stub only, and its PaymentIntent was created
    // on the Velexis account (its key, no Stripe-Account).
    expectResponseToMatch("createFlightSearch", baseline.search);
    expect(baselineTraffic.velexis.filter((call) => SEARCH_OPERATIONS.has(call.operation ?? ""))).toEqual([
      expect.objectContaining({ status: 200 }),
    ]);
    expect(baselineTraffic.velexis.filter((call) => call.operation === "quoteAirOffers")).toEqual([
      expect.objectContaining({ status: 200 }),
    ]);
    expect(baselineTraffic.ownTest).toEqual([]);
    expectResponseToMatch("createCheckoutPayment", baseline.payment);
    expect(baseline.payment.body).toMatchObject({ providerPublicKey: stack.velexisStripe.publishableKey });
    expect(baseline.intent?.headers["authorization"]).toBe(`Bearer ${stack.velexisStripe.secretKey}`);
    expect(baseline.intent?.headers["stripe-account"]).toBeUndefined();
    expect(baseline.intent?.form["capture_method"]).toBe("manual");
  });

  it("[OBE-083 AC1] own Amadeus: credentials verified by the platform serve alpha's next search [OF-12 AC1]", () => {
    expectResponseToMatch("submitAmadeusCredentials", ownAmadeusSubmitted, { document: "platform" });
    expectResponseToMatch("getCredentialSubmission", ownAmadeusApplied, { document: "platform" });
    expect(ownAmadeusApplied.body).toMatchObject({
      kind: "amadeus",
      environment: "test",
      status: "applied",
      errorCode: null,
    });
    // The platform worker verified them with a token request to the own stub, the only host that accepts them.
    expect(verificationTraffic.ownTest).toContainEqual(
      expect.objectContaining({ operation: TOKEN_OPERATION, status: 200 }),
    );
    // The Velexis office alpha had is releasing, still the tenant's (PADR-0012 point 4).
    expect(officeAfterSwitch).toEqual({ status: "releasing", assignedTenantId: alpha.ota.tenantId });

    // The next search: answered, through the own stub only (its token and its search, both 200), nothing at Velexis's.
    expect(outcomeOf(searchAfterSwitch)).toBe("201");
    expectResponseToMatch("createFlightSearch", searchAfterSwitch);
    expect(
      searchAfterSwitchTraffic.ownTest.filter((call) => SEARCH_OPERATIONS.has(call.operation ?? "")),
    ).toEqual([expect.objectContaining({ status: 200 })]);
    // Every token and search request the own stub saw was answered: its tokens are its own, so they came from it.
    expect(
      searchAfterSwitchTraffic.ownTest.filter(
        (call) =>
          (call.operation === TOKEN_OPERATION || SEARCH_OPERATIONS.has(call.operation ?? "")) &&
          call.status !== 200,
      ),
    ).toEqual([]);
    expect(
      searchAfterSwitchTraffic.velexis.filter((call) => SEARCH_OPERATIONS.has(call.operation ?? "")),
    ).toEqual([]);
  });

  it("[OBE-083 AC1] an earlier booking on the releasing Velexis office still syncs through the Velexis account [OF-12 AC2]", () => {
    expect(earlierBookingAfterSync?.syncError ?? null).toBeNull();
    expect(earlierBookingAfterSync?.lastSyncedAt?.getTime()).toBeGreaterThan(
      earlierBookingSyncedAt.getTime(),
    );
    const orderPath = `/v1/booking/flight-orders/${earlierOrder.id}`;
    expect(
      syncTraffic.velexis.filter((call) => call.operation === "getFlightOrder" && call.path === orderPath),
    ).toEqual([expect.objectContaining({ status: 200 })]);
    expect(syncTraffic.ownTest.filter((call) => call.path === orderPath)).toEqual([]);
    // The office that owns the order was still releasing (still alpha's) once the sync had run.
    expect(officeAfterSync).toEqual({ status: "releasing", assignedTenantId: alpha.ota.tenantId });
  });

  it("[OBE-083 AC1] own Stripe keys verified with GET /v1/account serve alpha's next PaymentIntent [OF-12 AC1]", () => {
    expectResponseToMatch("submitStripeApiKeys", ownStripeSubmitted, { document: "platform" });
    const submitted = ownStripeSubmitted.body as { webhookUrl: string };
    // The webhook URL the owner configures in Stripe is the OTA API's receiver for the connection.
    expect(submitted.webhookUrl).toMatch(
      new RegExp(`^${stack.otaApi.url.replace(/[.]/g, "\\.")}/webhooks/stripe/c/ppc_[0-9A-HJKMNP-TV-Z]{26}$`),
    );
    expectResponseToMatch("getCredentialSubmission", ownStripeApplied, { document: "platform" });
    expect(ownStripeApplied.body).toMatchObject({
      kind: "stripe_api_keys",
      environment: "test",
      status: "applied",
      errorCode: null,
    });
    // The platform worker's verification reached the fake Stripe API with the OTA's own key, and the connection
    // names the account it answered.
    expect(accountChecks.map((request) => request.headers["authorization"])).toContain(
      `Bearer ${ownStripe.secretKey}`,
    );
    expect(apiKeysConnection).toEqual({
      accountMode: "api_keys",
      accountReference: ownStripeAccount,
      publishableKey: ownStripe.publishableKey,
    });

    expectResponseToMatch("createCheckoutPayment", apiKeysRun.payment);
    expect(apiKeysRun.payment.body).toMatchObject({ providerPublicKey: ownStripe.publishableKey });
    expect(apiKeysRun.intent?.headers["authorization"]).toBe(`Bearer ${ownStripe.secretKey}`);
    expect(apiKeysRun.intent?.headers["stripe-account"]).toBeUndefined();
    expect(apiKeysRun.intent?.form["capture_method"]).toBe("manual");
  });

  it("[OBE-083 AC1] a Connect connection sends Stripe-Account with the Velexis key [OF-12 AC1]", () => {
    expectResponseToMatch("createCheckoutPayment", connectRun.payment);
    expect(connectRun.payment.body).toMatchObject({ providerPublicKey: stack.velexisStripe.publishableKey });
    expect(connectRun.intent?.headers["authorization"]).toBe(`Bearer ${stack.velexisStripe.secretKey}`);
    expect(connectRun.intent?.headers["stripe-account"]).toBe(connectAccount);
    expect(connectRun.intent?.form["capture_method"]).toBe("manual");
  });

  it("[OBE-083 AC1] the same processes serve beta on Velexis's accounts meanwhile: data, not code, decides [OF-12 AC1]", () => {
    expect(betaTraffic.velexis.filter((call) => SEARCH_OPERATIONS.has(call.operation ?? ""))).toEqual([
      expect.objectContaining({ status: 200 }),
    ]);
    expect(betaTraffic.ownTest.filter((call) => SEARCH_OPERATIONS.has(call.operation ?? ""))).toEqual([]);
    expectResponseToMatch("createCheckoutPayment", betaRun.payment);
    expect(betaRun.payment.body).toMatchObject({ providerPublicKey: stack.velexisStripe.publishableKey });
    expect(betaRun.intent?.headers["authorization"]).toBe(`Bearer ${stack.velexisStripe.secretKey}`);
    expect(betaRun.intent?.headers["stripe-account"]).toBeUndefined();
    // Every step ran on the processes the stack started (it never starts one again): none has exited, and each pid
    // recorded when the stack had started is still a running process of this machine.
    expect(stack.processes().map((process) => process.exitDescription())).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(pids.map((pid) => pid !== undefined && isRunning(pid))).toEqual([true, true, true, true]);
  });

  it("[OBE-083 AC1] go-live: with every precondition met, the storefront reports live within one second", () => {
    expect(liveAmadeusApplied.body).toMatchObject({
      kind: "amadeus",
      environment: "live",
      status: "applied",
    });
    // Before the plan and the subscription: the journey's own steps met every other precondition.
    expect(outcomeOf(goLiveRefused)).toBe("422 LIVE_PRECONDITIONS_UNMET");
    expectResponseToMatch("goLive", goLiveRefused, { document: "platform" });
    expect(
      (goLiveRefused.body as { error: { details: { missing: string[] } } }).error.details.missing,
    ).toEqual(["plan_live_mode", "subscription"]);

    expect(outcomeOf(goLive)).toBe("200");
    expectResponseToMatch("goLive", goLive, { document: "platform" });
    expect(goLive.body).toMatchObject({ id: alpha.ota.tenantId, storefrontEnvironment: "live" });
    // The OTA had cached alpha's tenant row and would have served it past the bound without the invalidation.
    expect(tenantCacheTtlMs, "the PTTL of the OTA's tenant:<id> entry before goLive").toBeGreaterThan(
      PROPAGATION_BOUND_MS,
    );
    expect(liveStorefront.elapsedMs, "the storefront still reported test 10 s after goLive").toBeDefined();
    expect(liveStorefront.elapsedMs).toBeLessThan(PROPAGATION_BOUND_MS);
    expectResponseToMatch("getStorefront", liveStorefront.last);
    expect(liveStorefront.last.body).toMatchObject({ tenantKey: ALPHA.key, environment: "live" });
  });
});

describe("[OBE-083] the gate and CI", () => {
  it("[OBE-083 AC2] the stack refuses at once, naming every missing entry point and the build commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "velexis-ota-xb-no-build-"));
    try {
      const missing = [join(dir, "platform-dist-main.js"), join(dir, "ota-dist-worker.js")];
      expect(() => assertBuilt(missing)).toThrow(BuildMissingError);
      expect(() => assertBuilt(missing)).toThrow(
        `test:xb runs the built backends, and ${missing.join(", ")} are missing. Build them first: ` +
          "pnpm --filter @velexis/platform-backend build && pnpm --filter @velexis/ota-backend build " +
          "(in CI, test:xb runs after the Build step).",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[OBE-083 AC2] CI runs this suite as test:xb after the Build step, next to the platform's", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "ota/backend/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:xb"]).toBe("vitest run --config vitest.xb.config.ts");
    const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const runs = (workflow.jobs["build-test"]?.steps ?? []).map((step) => step.run?.trim() ?? "");
    const build = runs.indexOf("pnpm build");
    const platformXb = runs.indexOf("pnpm --filter @velexis/platform-backend test:xb");
    const otaXb = runs.indexOf("pnpm --filter @velexis/ota-backend test:xb");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(platformXb).toBeGreaterThan(build);
    expect(otaXb).toBe(platformXb + 1);
  });
});
