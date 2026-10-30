// The SDK in server mode against a running OTA API (SDK-014; ota/sdk/README.md §4.3 and §8.1): a client with the
// secret test key dev:seed printed, the way a third-party server uses it (naming its visitor with the SDK's `endUser`,
// a new address each run, so the API's per-IP limits never stop a repeated run), makes one call of each customer namespace
// against the demo OTA and the Amadeus stub (the journey of the token-mode file), and account.preferences.get, a
// deferred method, surfaces the API's `501 NOT_IMPLEMENTED` as a ServerError.
//
// The console namespace with a staff token minted through a test portal token. dev:seed's secret key is scoped
// `storefront`, so the API refuses it every console operation, the staff session's included (403 SCOPE_NOT_ALLOWED,
// `storefront_key`): the tests prove that refusal for console.auth.signIn and for a console call that carries a staff
// token. The staff session itself is the OTA admin's way in (OADR-0011 point 4, OADR-0018): a server-mode client with
// the stack's OTA admin service key, `sessionKind: "staff"` and `environment: "test"` signs a test staff member of the
// demo OTA in with a portal token stored as the platform stores it (test/smoke/smoke-env.js), then calls
// console.auth.me, console.bookings.list, console.customers.list (which finds the customer this file signed up),
// console.bookings.create, a deferred method (501), and the raw Amadeus reads that only custom consoles call
// (getFlightOffers and getQueue against the stub through the demo OTA's office, getFlightOrder of an order the stub
// does not have: 404), and signs out. The member and its account are deleted afterwards.
//
// Every call is made once in the set-up hook (each request sent once, with a short timeout); the tests read what each
// call gave. Assertions never print a key, a token or a password.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVelexisClient, NotFoundError, PermissionError, ServerError } from "../../src/index.js";
import {
  CALLS_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
  customerJourney,
  daysAhead,
  newPortalToken,
  newSmokeEndUser,
  openTestStaffSession,
  readSmokeSettings,
  refusalOf,
  REQUEST_TIMEOUT_MS,
  resultOf,
  settle,
  signOutCustomer,
  SMOKE_STAFF_ROLE,
} from "./smoke-env.js";

/** An Amadeus flight-order id the stub does not have (its shape: base64url). */
const UNKNOWN_FLIGHT_ORDER_ID = "eJzTd9cPNfX09DUFAAsGAkQ";

/** @typedef {import("./smoke-env.js").Outcome} Outcome */

/** @type {Record<string, Outcome>} */
let outcomes = {};
/** @type {string} */
let email = "";
/** @type {(() => Promise<void>) | undefined} */
let closeStaffSession;
/** @type {Array<{ method: string, path: string, status: number, requestId: string | null }>} */
const responses = [];

beforeAll(async () => {
  const settings = readSmokeSettings();
  /** @param {{ method: string, path: string, status: number, requestId: string | null }} info */
  const onResponse = (info) => {
    responses.push(info);
  };
  // Both server-mode clients name this run's end user (`endUser`: X-Velexis-End-User-IP and -Agent), as a server
  // forwards its visitor: the API's per-IP limits count the run apart (the sign-up's 5 an hour), and the service key
  // requires it.
  const common = {
    baseUrl: settings.OTA_API_URL,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    onResponse,
    endUser: newSmokeEndUser(),
  };
  const server = createVelexisClient({ ...common, secretKey: settings.SDK_SMOKE_SECRET_KEY });
  // The OTA admin's client (ota/admin/src/lib/velexis.ts): the service key on a direct loopback connection, and the
  // staff session's kind and environment.
  const service = createVelexisClient({
    ...common,
    secretKey: settings.OTA_ADMIN_SERVICE_KEY,
    sessionKind: "staff",
    environment: "test",
  });

  const journey = await customerJourney(server, { label: "server" });
  outcomes = { ...journey.outcomes };
  email = journey.email;
  const accessToken = journey.accessToken;
  if (accessToken !== undefined) {
    outcomes["account.preferences.get"] = await settle(() =>
      server.account.preferences.get({}, { accessToken }),
    );
  }
  // A portal token nobody stored: the scope guard refuses the key before anything reads the token.
  outcomes["console.auth.signIn (secret key)"] = await settle(() =>
    server.console.auth.signIn({ grantType: "portal_token", portalToken: newPortalToken() }),
  );

  const opened = await settle(() => openTestStaffSession(settings, service));
  outcomes["console.auth.signIn"] = opened;
  if (opened.ok) {
    closeStaffSession = opened.value.close;
    const staffToken = opened.value.session.session.accessToken;
    const staff = service.withOptions({ accessToken: staffToken });
    outcomes["console.auth.me"] = await settle(() => staff.console.auth.me());
    outcomes["console.bookings.list"] = await settle(() => staff.console.bookings.list());
    outcomes["console.customers.list"] = await settle(() => staff.console.customers.list({ email }));
    outcomes["console.bookings.create"] = await settle(() =>
      staff.console.bookings.create(/** @type {never} */ ({})),
    );
    outcomes["console.bookings.list (secret key)"] = await settle(() =>
      server.console.bookings.list({}, { accessToken: staffToken }),
    );
    // The raw Amadeus reads (ota/docs/plans/implementation-plan.md: API only, smoke-tested here).
    outcomes["console.amadeus.getFlightOffers"] = await settle(() =>
      staff.console.amadeus.getFlightOffers({
        originLocationCode: "PAR",
        destinationLocationCode: "NYC",
        departureDate: daysAhead(30),
        adults: 1,
        max: 1,
      }),
    );
    outcomes["console.amadeus.getQueue"] = await settle(() =>
      staff.console.amadeus.getQueue({ queueId: 50, max: 10, category: 0 }),
    );
    outcomes["console.amadeus.getFlightOrder"] = await settle(() =>
      staff.console.amadeus.getFlightOrder({ flightOrderId: UNKNOWN_FLIGHT_ORDER_ID }),
    );
  }
  const signedOut = await signOutCustomer(server, accessToken);
  if (signedOut !== undefined) {
    outcomes["auth.signOut"] = signedOut;
  }
}, CALLS_TIMEOUT_MS);

afterAll(async () => {
  await closeStaffSession?.();
}, CLOSE_TIMEOUT_MS);

describe("server mode: the secret test key of dev:seed", () => {
  it("storefront.get and reference.locations.search answer the secret key [SDK-014 AC1]", () => {
    const storefront = resultOf(outcomes["storefront.get"]);
    const locations = resultOf(outcomes["reference.locations.search"]);
    expect([storefront.tenantKey, storefront.environment]).toEqual(["demo", "test"]);
    expect(locations.data[0]).toMatchObject({ iataCode: "PAR" });
  });

  it("flights.search completes against the Amadeus stub and flights.price prices its first offer [SDK-014 AC1]", () => {
    const search = resultOf(outcomes["flights.search"]);
    const priced = resultOf(outcomes["flights.price"]);
    expect(search.status).toBe("completed");
    expect(search.offers.length).toBeGreaterThan(0);
    expect(priced.id).toMatch(/^prc_/);
    expect([priced.status, priced.offerIds]).toEqual(["active", [search.offers[0].id]]);
  });

  it("checkout.create opens a guest checkout of the priced offer [SDK-014 AC1]", () => {
    const priced = resultOf(outcomes["flights.price"]);
    const checkout = resultOf(outcomes["checkout.create"]);
    expect([checkout.status, checkout.isGuest, checkout.pricedOfferId]).toEqual(["open", true, priced.id]);
  });

  it("auth.signUp, account.get, bookings.list and auth.signOut serve a customer of the secret key [SDK-014 AC1]", () => {
    const signedUp = resultOf(outcomes["auth.signUp"]);
    const account = resultOf(outcomes["account.get"]);
    const bookings = resultOf(outcomes["bookings.list"]);
    expect(signedUp.customer.email).toBe(email);
    // The tokens' types only: a failed assertion must not print a token.
    expect([typeof signedUp.session?.accessToken, typeof signedUp.session?.refreshToken]).toEqual([
      "string",
      "string",
    ]);
    expect([account.id, account.email]).toEqual([signedUp.customer.id, email]);
    expect(bookings.data).toEqual([]);
    expect(resultOf(outcomes["auth.signOut"])).toBeUndefined();
  });

  it("account.preferences.get, a deferred method, surfaces the API's 501 as ServerError NOT_IMPLEMENTED [SDK-014 AC1]", () => {
    const error = refusalOf(outcomes["account.preferences.get"]);
    expect(error).toBeInstanceOf(ServerError);
    expect([error.status, error.code, error.retryable]).toEqual([501, "NOT_IMPLEMENTED", false]);
    expect(error.details).toMatchObject({ milestone: "deferred", operationId: "getAccountPreferences" });
  });

  it("refuses the storefront-scoped secret key on the console, with or without a staff token [SDK-014 AC1]", () => {
    for (const name of ["console.auth.signIn (secret key)", "console.bookings.list (secret key)"]) {
      const error = refusalOf(outcomes[name]);
      expect(error, name).toBeInstanceOf(PermissionError);
      expect([error.status, error.code, error.details?.reason], name).toEqual([
        403,
        "SCOPE_NOT_ALLOWED",
        "storefront_key",
      ]);
    }
  });
});

describe("server mode: the console with a staff token minted through a test portal token", () => {
  it("console.auth.signIn opens a staff session of the demo OTA's test environment [SDK-014 AC1]", () => {
    const opened = resultOf(outcomes["console.auth.signIn"]);
    expect([opened.session.staff.role, opened.session.tenant.key, opened.session.environments]).toEqual([
      SMOKE_STAFF_ROLE,
      "demo",
      ["test"],
    ]);
    expect([typeof opened.session.session.accessToken, typeof opened.session.session.refreshToken]).toEqual([
      "string",
      "string",
    ]);
  });

  it("console.auth.me names the staff member, console.bookings.list answers a page [SDK-014 AC1]", () => {
    const opened = resultOf(outcomes["console.auth.signIn"]);
    const me = resultOf(outcomes["console.auth.me"]);
    const bookings = resultOf(outcomes["console.bookings.list"]);
    expect([me.staff.id, me.staff.role, me.tenant.key]).toEqual([opened.staffId, SMOKE_STAFF_ROLE, "demo"]);
    expect(me.permissions).toContain("bookings:read");
    expect(Array.isArray(bookings.data)).toBe(true);
    expect(typeof bookings.next).toBe("function");
  });

  it("console.customers.list finds the customer this file signed up [SDK-014 AC1]", () => {
    const signedUp = resultOf(outcomes["auth.signUp"]);
    const customers = resultOf(outcomes["console.customers.list"]);
    expect(customers.data.map((/** @type {{ id: string }} */ customer) => customer.id)).toEqual([
      signedUp.customer.id,
    ]);
  });

  it("console.bookings.create, a deferred method, surfaces the API's 501 as ServerError NOT_IMPLEMENTED [SDK-014 AC1]", () => {
    const error = refusalOf(outcomes["console.bookings.create"]);
    expect(error).toBeInstanceOf(ServerError);
    expect([error.status, error.code]).toEqual([501, "NOT_IMPLEMENTED"]);
    expect(error.details).toMatchObject({ milestone: "deferred", operationId: "consoleCreateBooking" });
  });

  it("console.amadeus.getFlightOffers and getQueue read the stub through the demo OTA's office [SDK-014 AC1]", () => {
    const offers = resultOf(outcomes["console.amadeus.getFlightOffers"]);
    const queue = resultOf(outcomes["console.amadeus.getQueue"]);
    expect(offers.amadeus.data.length).toBeGreaterThan(0);
    expect(offers.call).toMatchObject({ environment: "test", httpMethod: "GET", httpStatus: 200 });
    expect(Array.isArray(queue.amadeus.data)).toBe(true);
    expect(typeof queue.queueSnapshotId).toBe("string");
    expect(queue.call).toMatchObject({ environment: "test", amadeusApi: "QueueList", httpStatus: 200 });
    // Both reads ran with the OTA's own office, which dev:seed assigned.
    expect(queue.call.officeId).toBe(offers.call.officeId);
  });

  it("console.amadeus.getFlightOrder of an order Amadeus does not have surfaces NotFoundError [SDK-014 AC1]", () => {
    const error = refusalOf(outcomes["console.amadeus.getFlightOrder"]);
    expect(error).toBeInstanceOf(NotFoundError);
    expect([error.status, error.code]).toEqual([404, "NOT_FOUND"]);
  });

  it("every response named its request, and no call met a server error but the deferred ones [SDK-014 AC1]", () => {
    expect(responses.length).toBeGreaterThanOrEqual(19);
    expect(responses.filter((response) => !response.requestId)).toEqual([]);
    expect(responses.filter((response) => response.status >= 500 && response.status !== 501)).toEqual([]);
    expect(responses.filter((response) => response.status === 501).map((response) => response.path)).toEqual([
      "/v1/account/preferences",
      "/v1/console/bookings",
    ]);
  });
});
