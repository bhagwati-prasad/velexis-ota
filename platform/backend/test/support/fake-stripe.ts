// FakeStripe (PBE-043): an injectable fake of the few Stripe calls the platform makes (`StripeApi` of
// src/common/stripe/stripe.client.ts), for integration and unit tests. Nothing reaches Stripe, and nothing needs a key:
//
//   const stripe = new FakeStripe();
//   t = await createTestApp({ overrides: [{ provide: StripeClient, useValue: stripe }] });
//   stripe.put(stripeFixture("customer.subscription.updated").data.object);   // what a retrieve answers
//   stripe.failNext("subscriptions.retrieve", FakeStripe.apiError(503));      // Stripe down for one call
//   stripe.failNext("customers.create", FakeStripe.apiError(500), { created: true, storedForKey: true });
//   …
//   expect(stripe.callsOf("subscriptions.retrieve")).toEqual([expect.objectContaining({ id: "sub_test_alpha_1" })]);
//
// How it behaves, so tests can rely on it:
//
// - **Retrieve** answers a copy of the object `put` stored under that id and of that `object` type, with the string
//   references named in `params.expand` replaced by the stored objects (`expand: ["subscription"]` on a Checkout
//   Session). An id it does not hold throws what the SDK throws: `StripeInvalidRequestError`, 404, `resource_missing`.
// - **Create** needs `{ idempotencyKey }` in its options, as every POST of the platform does (architecture §7): without
//   one it throws, and the test fails. The same key with the same parameters answers the object of the first call (as
//   Stripe does for 24 hours); the same key with other parameters throws `StripeIdempotencyError`. New objects get ids
//   `<prefix>_fake<n>` and Stripe's URL shapes (a Checkout Session also its `expires_at`, 24 hours after `created`),
//   and are kept, so a later retrieve finds them.
// - **Search** (`customers.search`) answers the stored Customers whose `metadata.velexis_tenant_id` is the one of the
//   query `metadata['velexis_tenant_id']:'<id>'`, the only query the platform sends (any other throws), as a
//   `search_result` page. Unlike Stripe's search, whose index may lag up to a minute, it sees a Customer at once.
// - **List** (`balanceTransactions.list`, PBE-059) answers the stored balance transactions whose `created` is in
//   `params.created` (`gt`, `gte`, `lt`, `lte`), newest first as Stripe lists them (equal times in the order they were
//   put), one page of `limit` (10 by default, at most 100) after `starting_after`, with `has_more`; an unknown
//   `starting_after` throws the SDK's 404. `expand: ["data.source"]` replaces each transaction's `source` id by the
//   stored object. The SDK's promise also pages through the results; the platform reads one page at a time.
// - **Failures** queued with `failNext(method, error)` are thrown by the next calls of that method, one each, before
//   anything else happens; the call is still recorded. For a create, `failNext(method, error, options)` plays what
//   Stripe does with an idempotency key on a failure: `created` makes (and keeps) the object before the error is
//   thrown, as when Stripe made it but its answer was a 5xx or never arrived; `storedForKey` stores the failure for
//   the call's idempotency key, so every later call with that key and the same parameters throws it again, as Stripe
//   replays a stored 5xx for 24 hours. Without `storedForKey`, a later call with the key answers the object made with
//   `created`, or makes one.
// - **Calls** are recorded in order (`calls`, `callsOf(method)`) with the id, a copy of the parameters and the
//   idempotency key, so a test asserts what the platform asked for, and that it asked for nothing (`calls` empty).
// - **Connect OAuth** (`oauth.token`, PBE-055) exchanges a code that `grantConnectCode(code, {stripeUserId,
//   livemode})` made, once: it needs an idempotency key (a POST), takes `grant_type: "authorization_code"` only, and
//   answers Stripe's `OAuthToken` with the account id, the mode and fresh fake tokens (`grantConnectCode` returns them,
//   so a test can look for them where they must never be). A code it does not hold, or one exchanged already, throws
//   the SDK's `StripeInvalidGrantError` (400 `invalid_grant`) with Stripe's message, which names the code. The
//   connected account itself is an `account` object put with `put`, read with `accounts.retrieve(id)`.
// - `notConfigured()` makes `api()` throw StripeNotConfiguredError, as the application does without STRIPE_SECRET_KEY.
import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import {
  StripeClient,
  StripeNotConfiguredError,
  type StripeApi,
} from "../../src/common/stripe/stripe.client";

/** The calls of StripeApi, as `<resource>.<method>`. */
export const FAKE_STRIPE_METHODS = Object.freeze([
  // Connect Standard (PBE-055).
  "oauth.token",
  "accounts.retrieve",
  "customers.create",
  "customers.retrieve",
  "customers.search",
  "checkout.sessions.create",
  "checkout.sessions.retrieve",
  "billingPortal.sessions.create",
  "subscriptions.retrieve",
  "invoices.retrieve",
  "prices.retrieve",
  "balanceTransactions.list",
  "charges.retrieve",
  "paymentIntents.retrieve",
] as const);

/** The default and the highest `limit` of a Stripe list call. */
export const STRIPE_LIST_DEFAULT_LIMIT = 10;
export const STRIPE_LIST_MAX_LIMIT = 100;

/** One call of StripeApi. */
export type FakeStripeMethod = (typeof FAKE_STRIPE_METHODS)[number];

/** A recorded call. */
export interface FakeStripeCall {
  readonly method: FakeStripeMethod;
  /** The id of a retrieve; `undefined` for a create. */
  readonly id: string | undefined;
  /** A copy of the parameters (`undefined` when none were passed). */
  readonly params: unknown;
  /** `options.idempotencyKey`, or `undefined`. */
  readonly idempotencyKey: string | undefined;
}

/** What a failure of a create leaves behind at Stripe (`failNext`, file header). */
export interface FakeStripeFailureOptions {
  /** Stripe made the object before it failed: it is kept, so a retrieve or a search finds it. */
  readonly created?: boolean;
  /** Stripe stored the failure for the idempotency key: later calls with the key throw it again. */
  readonly storedForKey?: boolean;
}

/** What Stripe answers for a Connect OAuth code made with `grantConnectCode` (PBE-055). */
export interface FakeConnectGrant {
  /** `acct_…`: the account the person connected (`stripe_user_id`). */
  readonly stripeUserId: string;
  /** `livemode` of the answer: Stripe answers the mode of the platform key that exchanges the code. */
  readonly livemode: boolean;
}

/** The tokens the fake hands out for a code: what the platform must discard, never store, log or answer. */
export interface FakeConnectTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly publishableKey: string;
}

/** A code `grantConnectCode` made and not exchanged yet. */
interface ConnectCode extends FakeConnectGrant, FakeConnectTokens {}

/** A failure queued by `failNext`. */
interface QueuedFailure extends FakeStripeFailureOptions {
  readonly error: Error;
}

/** What Stripe keeps for an idempotency key: the parameters, and the object made or the failure answered. */
interface KeyRecord {
  readonly params: string;
  readonly id?: string;
  readonly error?: Error;
}

/** A Stripe object the fake can hold: an id and Stripe's `object` type. */
export interface FakeStripeObject {
  readonly id: string;
  readonly object: string;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What `create` makes for each resource: the `object` type, the id prefix and the URL, when Stripe gives one. */
const CREATED = {
  "customers.create": { object: "customer", prefix: "cus", url: undefined },
  "checkout.sessions.create": {
    object: "checkout.session",
    prefix: "cs",
    url: (id: string) => `https://checkout.stripe.com/c/pay/${id}`,
  },
  "billingPortal.sessions.create": {
    object: "billing_portal.session",
    prefix: "bps",
    url: (id: string) => `https://billing.stripe.com/p/session/${id}`,
  },
} as const satisfies Partial<
  Record<FakeStripeMethod, { object: string; prefix: string; url: ((id: string) => string) | undefined }>
>;

type CreateMethod = keyof typeof CREATED;

/** How long a created Checkout Session lives, as Stripe's default: 24 hours (`expires_at = created + 86400`). */
export const CHECKOUT_SESSION_LIFETIME_SECONDS = 24 * 60 * 60;

/** `compute()` as a promise: what it returns resolves it, what it throws rejects it (as the SDK's calls do). */
function settle<T>(compute: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(compute());
  });
}

export class FakeStripe extends StripeClient {
  /** Every call, in order. */
  readonly calls: FakeStripeCall[] = [];
  private readonly objects = new Map<string, Json>();
  private readonly failures = new Map<FakeStripeMethod, QueuedFailure[]>();
  private readonly byIdempotencyKey = new Map<string, KeyRecord>();
  private readonly connectCodes = new Map<string, ConnectCode>();
  private sequence = 0;
  private configured = true;
  private readonly resources: StripeApi;

  constructor() {
    super();
    this.resources = {
      oauth: {
        token: (params: unknown, options?: unknown) =>
          settle(() => this.oauthTokenNow(params, options)) as Promise<Stripe.OAuthToken>,
      },
      accounts: {
        // The SDK also retrieves the platform's own account without an id; the platform always names the account.
        retrieve: ((id: unknown, params?: unknown) =>
          typeof id === "string"
            ? this.retrieve<Stripe.Account>("accounts.retrieve", "account", id, params)
            : Promise.reject(
                new Error("FakeStripe: accounts.retrieve needs the id of a connected account"),
              )) as StripeApi["accounts"]["retrieve"],
      },
      customers: {
        create: (params?: unknown, options?: unknown) =>
          this.create<Stripe.Customer>("customers.create", params, options),
        retrieve: (id: string, params?: unknown) =>
          this.retrieve<Stripe.Customer | Stripe.DeletedCustomer>(
            "customers.retrieve",
            "customer",
            id,
            params,
          ),
        // The SDK's promise also pages through the results; the platform reads one page.
        search: (params: unknown, options?: unknown) =>
          settle(() =>
            this.searchCustomersNow(params, options),
          ) as unknown as Stripe.ApiSearchResultPromise<Stripe.Customer>,
      },
      checkout: {
        sessions: {
          create: (params?: unknown, options?: unknown) =>
            this.create<Stripe.Checkout.Session>("checkout.sessions.create", params, options),
          retrieve: (id: string, params?: unknown) =>
            this.retrieve<Stripe.Checkout.Session>(
              "checkout.sessions.retrieve",
              "checkout.session",
              id,
              params,
            ),
        },
      },
      billingPortal: {
        sessions: {
          create: (params?: unknown, options?: unknown) =>
            this.create<Stripe.BillingPortal.Session>("billingPortal.sessions.create", params, options),
        },
      },
      subscriptions: {
        retrieve: (id: string, params?: unknown) =>
          this.retrieve<Stripe.Subscription>("subscriptions.retrieve", "subscription", id, params),
      },
      invoices: {
        retrieve: (id: string, params?: unknown) =>
          this.retrieve<Stripe.Invoice>("invoices.retrieve", "invoice", id, params),
      },
      prices: {
        retrieve: (id: string, params?: unknown) =>
          this.retrieve<Stripe.Price>("prices.retrieve", "price", id, params),
      },
      balanceTransactions: {
        // The SDK's promise also pages through the results; the platform reads one page at a time.
        list: (params?: unknown, options?: unknown) =>
          settle(() =>
            this.listBalanceTransactionsNow(params, options),
          ) as unknown as Stripe.ApiListPromise<Stripe.BalanceTransaction>,
      },
      charges: {
        retrieve: (id: string, params?: unknown) =>
          this.retrieve<Stripe.Charge>("charges.retrieve", "charge", id, params),
      },
      paymentIntents: {
        retrieve: (id: string, params?: unknown) =>
          this.retrieve<Stripe.PaymentIntent>("paymentIntents.retrieve", "payment_intent", id, params),
      },
    };
  }

  /** A Stripe API error as the SDK throws it: 404 `resource_missing`, 429 rate limit, 5xx `api_error`, … */
  static apiError(statusCode: number, code?: string): Stripe.errors.StripeError {
    const raw = {
      message: `Fake Stripe answered ${statusCode}`,
      statusCode,
      ...(code === undefined ? {} : { code }),
    };
    if (statusCode === 429) {
      return new Stripe.errors.StripeRateLimitError({ ...raw, type: "rate_limit_error" });
    }
    if (statusCode >= 500) {
      return new Stripe.errors.StripeAPIError({ ...raw, type: "api_error" });
    }
    return new Stripe.errors.StripeInvalidRequestError({ ...raw, type: "invalid_request_error" });
  }

  /** A network failure (Stripe unreachable or the 10-second timeout), as the SDK throws it. */
  static connectionError(): Stripe.errors.StripeConnectionError {
    return new Stripe.errors.StripeConnectionError({
      message: "Fake Stripe could not be reached",
      type: "api_error",
    });
  }

  isConfigured(): boolean {
    return this.configured;
  }

  api(): StripeApi {
    if (!this.configured) {
      throw new StripeNotConfiguredError();
    }
    return this.resources;
  }

  /** Makes `api()` throw StripeNotConfiguredError (no STRIPE_SECRET_KEY). */
  notConfigured(): this {
    this.configured = false;
    return this;
  }

  /** Stores copies of Stripe objects, by id: what a retrieve answers. A later `put` of an id replaces it. */
  put(...objects: readonly FakeStripeObject[]): this {
    for (const object of objects) {
      if (typeof object.id !== "string" || typeof object.object !== "string") {
        throw new TypeError("FakeStripe.put: a Stripe object has an `id` and an `object` type");
      }
      this.objects.set(object.id, structuredClone(object) as unknown as Json);
    }
    return this;
  }

  /** The stored object of `id` (a copy), or `undefined`. */
  get(id: string): FakeStripeObject | undefined {
    const object = this.objects.get(id);
    return object === undefined ? undefined : (structuredClone(object) as unknown as FakeStripeObject);
  }

  /**
   * The next call of `method` throws `error` (several calls queue several errors, in order). The options of a create
   * say what Stripe kept of the failed call (file header).
   */
  failNext(method: FakeStripeMethod, error: Error, options: FakeStripeFailureOptions = {}): this {
    if ((options.created === true || options.storedForKey === true) && !(method in CREATED)) {
      throw new TypeError(
        `FakeStripe.failNext: ${method} makes nothing; created and storedForKey are for creates`,
      );
    }
    const queued = this.failures.get(method) ?? [];
    queued.push({ error, ...options });
    this.failures.set(method, queued);
    return this;
  }

  /** The recorded calls of `method`. */
  callsOf(method: FakeStripeMethod): FakeStripeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /**
   * Makes `code` a Connect OAuth code that `oauth.token` exchanges once for `grant` (file header), and returns the
   * tokens the exchange will hand out with it. A later grant of the same code replaces it.
   */
  grantConnectCode(code: string, grant: FakeConnectGrant): FakeConnectTokens {
    const suffix = randomBytes(12).toString("hex");
    const tokens: FakeConnectTokens = {
      accessToken: `fake_connect_access_${suffix}`,
      refreshToken: `fake_connect_refresh_${suffix}`,
      publishableKey: `fake_connect_publishable_${suffix}`,
    };
    this.connectCodes.set(code, { ...grant, ...tokens });
    return tokens;
  }

  /** Forgets every call, object, failure, idempotency key and Connect code. */
  reset(): this {
    this.calls.length = 0;
    this.objects.clear();
    this.failures.clear();
    this.byIdempotencyKey.clear();
    this.connectCodes.clear();
    this.configured = true;
    return this;
  }

  /** `oauth.token`: exchanges a code of `grantConnectCode` once (file header). */
  private oauthTokenNow(params: unknown, options: unknown): Stripe.Response<Stripe.OAuthToken> {
    this.record("oauth.token", undefined, params, options);
    const key = isRecord(options) ? options["idempotencyKey"] : undefined;
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(
        "FakeStripe: oauth.token without an idempotency key (every POST needs one, architecture §7)",
      );
    }
    const query = isRecord(params) ? params : {};
    if (query["grant_type"] !== "authorization_code") {
      throw new Error("FakeStripe: oauth.token knows only grant_type authorization_code");
    }
    const code = query["code"];
    const granted = typeof code === "string" ? this.connectCodes.get(code) : undefined;
    if (typeof code !== "string" || granted === undefined) {
      // Stripe's OAuth error, as the SDK throws it: its description names the code.
      throw new Stripe.errors.StripeInvalidGrantError({
        type: "invalid_grant",
        message: `Authorization code does not exist: ${String(code)}`,
        statusCode: 400,
      });
    }
    this.connectCodes.delete(code);
    return this.response<Stripe.OAuthToken>({
      access_token: granted.accessToken,
      livemode: granted.livemode,
      refresh_token: granted.refreshToken,
      scope: "read_write",
      stripe_publishable_key: granted.publishableKey,
      stripe_user_id: granted.stripeUserId,
      token_type: "bearer",
    });
  }

  /**
   * Records a call and takes the next failure queued for its method: a plain one is thrown here, before anything
   * else happens; one with options is answered to the create, which plays it.
   */
  private record(
    method: FakeStripeMethod,
    id: string | undefined,
    params: unknown,
    options: unknown,
  ): QueuedFailure | undefined {
    const idempotencyKey = isRecord(options) ? options["idempotencyKey"] : undefined;
    this.calls.push({
      method,
      id,
      params: params === undefined ? undefined : structuredClone(params),
      idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined,
    });
    const failure = this.failures.get(method)?.shift();
    if (failure !== undefined && failure.created !== true && failure.storedForKey !== true) {
      throw failure.error;
    }
    return failure;
  }

  private retrieve<T>(
    method: FakeStripeMethod,
    objectType: string,
    id: string,
    params: unknown,
  ): Promise<Stripe.Response<T>> {
    return settle(() => this.retrieveNow<T>(method, objectType, id, params));
  }

  private retrieveNow<T>(
    method: FakeStripeMethod,
    objectType: string,
    id: string,
    params: unknown,
  ): Stripe.Response<T> {
    this.record(method, id, params, undefined);
    const stored = this.objects.get(id);
    if (stored === undefined || stored["object"] !== objectType) {
      throw FakeStripe.apiError(404, "resource_missing");
    }
    const answer = structuredClone(stored);
    const expand = isRecord(params) ? params["expand"] : undefined;
    for (const path of Array.isArray(expand) ? expand : []) {
      const reference = typeof path === "string" ? answer[path] : undefined;
      const expanded = typeof reference === "string" ? this.objects.get(reference) : undefined;
      if (typeof path === "string" && expanded !== undefined) {
        answer[path] = structuredClone(expanded);
      }
    }
    return this.response<T>(answer);
  }

  /** `customers.search` with the one query the platform sends (file header). */
  private searchCustomersNow(params: unknown, options: unknown): Stripe.ApiSearchResult<Stripe.Customer> {
    this.record("customers.search", undefined, params, options);
    const query = isRecord(params) ? params["query"] : undefined;
    const match =
      typeof query === "string" ? /^metadata\['velexis_tenant_id'\]:'([^'\\]+)'$/.exec(query) : null;
    if (match === null) {
      throw new Error(
        "FakeStripe: customers.search knows only the query metadata['velexis_tenant_id']:'<id>'",
      );
    }
    const data = [...this.objects.values()]
      .filter((object) => {
        const metadata = object["metadata"];
        return (
          object["object"] === "customer" &&
          object["deleted"] !== true &&
          isRecord(metadata) &&
          metadata["velexis_tenant_id"] === match[1]
        );
      })
      .map((object) => structuredClone(object));
    return this.response<Stripe.ApiSearchResult<Stripe.Customer>>({
      object: "search_result",
      url: "/v1/customers/search",
      has_more: false,
      next_page: null,
      data,
    });
  }

  /** `balanceTransactions.list`: one page of the stored balance transactions (file header). */
  private listBalanceTransactionsNow(
    params: unknown,
    options: unknown,
  ): Stripe.ApiList<Stripe.BalanceTransaction> {
    this.record("balanceTransactions.list", undefined, params, options);
    const query = isRecord(params) ? params : {};
    const created = isRecord(query["created"]) ? query["created"] : {};
    const bound = (name: string): number | undefined => {
      const value = created[name];
      return typeof value === "number" ? value : undefined;
    };
    const [gt, gte, lt, lte] = [bound("gt"), bound("gte"), bound("lt"), bound("lte")];
    const limit = typeof query["limit"] === "number" ? query["limit"] : STRIPE_LIST_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > STRIPE_LIST_MAX_LIMIT) {
      throw FakeStripe.apiError(400, "parameter_invalid_integer");
    }
    const all = [...this.objects.values()]
      .filter((object) => {
        const time = object["created"];
        return (
          object["object"] === "balance_transaction" &&
          typeof time === "number" &&
          (gt === undefined || time > gt) &&
          (gte === undefined || time >= gte) &&
          (lt === undefined || time < lt) &&
          (lte === undefined || time <= lte)
        );
      })
      // Newest first; Array.prototype.sort is stable, so equal times keep the order they were put in.
      .sort((a, b) => (b["created"] as number) - (a["created"] as number));
    let start = 0;
    const after = query["starting_after"];
    if (typeof after === "string") {
      const index = all.findIndex((object) => object["id"] === after);
      if (index < 0) {
        throw FakeStripe.apiError(404, "resource_missing");
      }
      start = index + 1;
    }
    const expand = Array.isArray(query["expand"]) ? query["expand"] : [];
    const data = all.slice(start, start + limit).map((object) => {
      const answer = structuredClone(object);
      const source = answer["source"];
      const expanded = typeof source === "string" ? this.objects.get(source) : undefined;
      if (expand.includes("data.source") && expanded !== undefined) {
        answer["source"] = structuredClone(expanded);
      }
      return answer;
    });
    return this.response<Stripe.ApiList<Stripe.BalanceTransaction>>({
      object: "list",
      url: "/v1/balance_transactions",
      has_more: start + limit < all.length,
      data,
    });
  }

  private create<T>(method: CreateMethod, params: unknown, options: unknown): Promise<Stripe.Response<T>> {
    return settle(() => this.createNow<T>(method, params, options));
  }

  private createNow<T>(method: CreateMethod, params: unknown, options: unknown): Stripe.Response<T> {
    const failure = this.record(method, undefined, params, options);
    const key = isRecord(options) ? options["idempotencyKey"] : undefined;
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(
        `FakeStripe: ${method} without an idempotency key (every POST needs one, architecture §7)`,
      );
    }
    const serialised = JSON.stringify(params ?? null);
    const earlier = this.byIdempotencyKey.get(`${method} ${key}`);
    if (earlier !== undefined) {
      if (earlier.params !== serialised) {
        throw new Stripe.errors.StripeIdempotencyError({
          message:
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          type: "idempotency_error",
          statusCode: 400,
        });
      }
      if (earlier.error !== undefined) {
        // Stripe replays the stored failure of the key.
        throw earlier.error;
      }
      const object = earlier.id === undefined ? undefined : this.objects.get(earlier.id);
      if (object === undefined) {
        throw new Error(`FakeStripe: the object of idempotency key ${key} was removed`);
      }
      return this.response<T>(structuredClone(object));
    }
    if (failure !== undefined && failure.created !== true) {
      // storedForKey without created: nothing was made, the failure is what the key answers from now on.
      this.byIdempotencyKey.set(`${method} ${key}`, { params: serialised, error: failure.error });
      throw failure.error;
    }
    this.sequence += 1;
    const shape = CREATED[method];
    // Stripe's shape, `<prefix>_` and letters and digits only, as the `cus_` CHECK of `billing_customers` wants it.
    const id = `${shape.prefix}_fake${this.sequence}`;
    const created = 1_800_000_000 + this.sequence;
    const object: Json = {
      ...(isRecord(params) ? structuredClone(params) : {}),
      id,
      object: shape.object,
      livemode: false,
      created,
      ...(shape.url === undefined ? {} : { url: shape.url(id) }),
      // Stripe expires a Checkout Session 24 hours after its creation unless `expires_at` says otherwise.
      ...(method === "checkout.sessions.create" && !(isRecord(params) && "expires_at" in params)
        ? { expires_at: created + CHECKOUT_SESSION_LIFETIME_SECONDS }
        : {}),
    };
    this.objects.set(id, object);
    if (failure !== undefined) {
      // Made, but the answer was a failure: the key replays the failure when Stripe stored it, else the object.
      this.byIdempotencyKey.set(
        `${method} ${key}`,
        failure.storedForKey === true
          ? { params: serialised, error: failure.error }
          : { params: serialised, id },
      );
      throw failure.error;
    }
    this.byIdempotencyKey.set(`${method} ${key}`, { params: serialised, id });
    return this.response<T>(structuredClone(object));
  }

  private response<T>(object: Json): Stripe.Response<T> {
    this.sequence += 1;
    return {
      ...object,
      lastResponse: { headers: {}, requestId: `req_fake_${this.sequence}`, statusCode: 200 },
    } as unknown as Stripe.Response<T>;
  }
}
