// The SDK in token mode against a running OTA API (SDK-014; ota/sdk/README.md §4.2 and §8.1): a client with the
// publishable test key dev:seed printed, the way a third-party browser frontend uses it, makes one call of each of the
// eight namespaces against the demo OTA and the Amadeus stub. The customer namespaces succeed: storefront.get,
// reference.locations.search, flights.search and flights.price, checkout.create (a guest checkout), auth.signUp,
// account.get and bookings.list with the new customer's access token, and auth.signOut. `console.*` is refused to a
// publishable key (403 SCOPE_NOT_ALLOWED), and storefront.resolve, a deferred method, surfaces the API's
// `501 NOT_IMPLEMENTED` as a ServerError.
//
// Every call is made once in the set-up hook (each request sent once, with a short timeout); the tests read what each
// call gave, so a failed call fails its own test with the SDK's error. Assertions never print a key or a token.
import { beforeAll, describe, expect, it } from "vitest";
import { createVelexisClient, PermissionError, ServerError } from "../../src/index.js";
import {
  CALLS_TIMEOUT_MS,
  customerJourney,
  readSmokeSettings,
  refusalOf,
  REQUEST_TIMEOUT_MS,
  resultOf,
  settle,
  signOutCustomer,
} from "./smoke-env.js";

/** @typedef {import("./smoke-env.js").Outcome} Outcome */

/** @type {Record<string, Outcome>} */
let outcomes = {};
/** @type {string} */
let email = "";
/** @type {Array<{ method: string, path: string, status: number, requestId: string | null }>} */
const responses = [];

beforeAll(async () => {
  const settings = readSmokeSettings();
  const client = createVelexisClient({
    publishableKey: settings.SDK_SMOKE_PUBLISHABLE_KEY,
    baseUrl: settings.OTA_API_URL,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    onResponse: (info) => {
      responses.push(info);
    },
  });
  const journey = await customerJourney(client, { label: "token" });
  outcomes = { ...journey.outcomes };
  email = journey.email;
  outcomes["console.auth.me"] = await settle(() => client.console.auth.me());
  outcomes["storefront.resolve"] = await settle(() => client.storefront.resolve({ host: "www.example.com" }));
  const signedOut = await signOutCustomer(client, journey.accessToken);
  if (signedOut !== undefined) {
    outcomes["auth.signOut"] = signedOut;
  }
}, CALLS_TIMEOUT_MS);

describe("token mode: the publishable test key of dev:seed", () => {
  it("storefront.get reads the demo OTA's test storefront [SDK-014 AC1]", () => {
    const storefront = resultOf(outcomes["storefront.get"]);
    expect([storefront.tenantKey, storefront.name, storefront.environment]).toEqual([
      "demo",
      "Demo Travel",
      "test",
    ]);
    expect(typeof storefront.legal.termsVersion).toBe("string");
  });

  it("reference.locations.search finds Paris first, as a page [SDK-014 AC1]", () => {
    const page = resultOf(outcomes["reference.locations.search"]);
    expect(page.data[0]).toMatchObject({ iataCode: "PAR", subType: "CITY" });
    expect(typeof page.next).toBe("function");
  });

  it("flights.search completes against the Amadeus stub and flights.price prices its first offer [SDK-014 AC1]", () => {
    const search = resultOf(outcomes["flights.search"]);
    const priced = resultOf(outcomes["flights.price"]);
    expect(search.id).toMatch(/^srch_/);
    expect(search.status).toBe("completed");
    expect(search.offers.length).toBeGreaterThan(0);
    expect(priced.id).toMatch(/^prc_/);
    expect([priced.status, priced.searchId, priced.offerIds]).toEqual([
      "active",
      search.id,
      [search.offers[0].id],
    ]);
  });

  it("checkout.create opens a guest checkout of the priced offer [SDK-014 AC1]", () => {
    const priced = resultOf(outcomes["flights.price"]);
    const checkout = resultOf(outcomes["checkout.create"]);
    expect(checkout.id).toMatch(/^chk_/);
    expect([checkout.status, checkout.isGuest, checkout.customerId, checkout.pricedOfferId]).toEqual([
      "open",
      true,
      null,
      priced.id,
    ]);
  });

  it("auth.signUp opens a session whose tokens a token-mode client receives [SDK-014 AC1]", () => {
    const signedUp = resultOf(outcomes["auth.signUp"]);
    expect(signedUp.customer.id).toMatch(/^cus_/);
    expect(signedUp.customer.email).toBe(email);
    // The tokens' types only: a failed assertion must not print a token.
    expect([typeof signedUp.session?.accessToken, typeof signedUp.session?.refreshToken]).toEqual([
      "string",
      "string",
    ]);
  });

  it("account.get and bookings.list answer for the new customer's access token [SDK-014 AC1]", () => {
    const signedUp = resultOf(outcomes["auth.signUp"]);
    const account = resultOf(outcomes["account.get"]);
    const bookings = resultOf(outcomes["bookings.list"]);
    expect([account.id, account.email, account.emailVerified]).toEqual([signedUp.customer.id, email, false]);
    expect(bookings.data).toEqual([]);
    expect(typeof bookings.next).toBe("function");
  });

  it("auth.signOut ends the customer's session [SDK-014 AC1]", () => {
    expect(resultOf(outcomes["auth.signOut"])).toBeUndefined();
  });

  it("console.* is refused to a publishable key: PermissionError SCOPE_NOT_ALLOWED [SDK-014 AC1]", () => {
    const error = refusalOf(outcomes["console.auth.me"]);
    expect(error).toBeInstanceOf(PermissionError);
    expect([error.status, error.code, error.details?.reason]).toEqual([
      403,
      "SCOPE_NOT_ALLOWED",
      "console_operation",
    ]);
  });

  it("storefront.resolve, a deferred method, surfaces the API's 501 as ServerError NOT_IMPLEMENTED [SDK-014 AC1]", () => {
    const error = refusalOf(outcomes["storefront.resolve"]);
    expect(error).toBeInstanceOf(ServerError);
    expect([error.status, error.code, error.retryable]).toEqual([501, "NOT_IMPLEMENTED", false]);
    expect(error.details).toMatchObject({ milestone: "deferred", operationId: "resolveStorefrontHost" });
  });

  it("every response named its request, and no call met a server error but the deferred one [SDK-014 AC1]", () => {
    expect(responses.length).toBeGreaterThanOrEqual(11);
    expect(responses.filter((response) => !response.requestId)).toEqual([]);
    expect(responses.filter((response) => response.status >= 500 && response.status !== 501)).toEqual([]);
    expect(responses.filter((response) => response.status === 501).map((response) => response.path)).toEqual([
      "/v1/storefront/resolve",
    ]);
  });
});
