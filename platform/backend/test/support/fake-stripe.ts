// FakeStripe (PBE-043): an injectable fake of the few Stripe calls the platform makes (`StripeApi` of
// src/common/stripe/stripe.client.ts), for integration and unit tests. Nothing reaches Stripe, and nothing needs a key:
//
//   const stripe = new FakeStripe();
//   t = await createTestApp({ overrides: [{ provide: StripeClient, useValue: stripe }] });
//   stripe.put(stripeFixture("customer.subscription.updated").data.object);   // what a retrieve answers
//   stripe.failNext("subscriptions.retrieve", FakeStripe.apiError(503));      // Stripe down for one call
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
//   `<prefix>_fake_<n>` and Stripe's URL shapes, and are kept, so a later retrieve finds them.
// - **Failures** queued with `failNext(method, error)` are thrown by the next calls of that method, one each, before
//   anything else happens; the call is still recorded.
// - **Calls** are recorded in order (`calls`, `callsOf(method)`) with the id, a copy of the parameters and the
//   idempotency key, so a test asserts what the platform asked for, and that it asked for nothing (`calls` empty).
// - `notConfigured()` makes `api()` throw StripeNotConfiguredError, as the application does without STRIPE_SECRET_KEY.
import Stripe from "stripe";
import {
  StripeClient,
  StripeNotConfiguredError,
  type StripeApi,
} from "../../src/common/stripe/stripe.client";

/** The calls of StripeApi, as `<resource>.<method>`. */
export const FAKE_STRIPE_METHODS = Object.freeze([
  "customers.create",
  "customers.retrieve",
  "checkout.sessions.create",
  "checkout.sessions.retrieve",
  "billingPortal.sessions.create",
  "subscriptions.retrieve",
  "invoices.retrieve",
  "prices.retrieve",
] as const);

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
  private readonly failures = new Map<FakeStripeMethod, Error[]>();
  private readonly byIdempotencyKey = new Map<string, { readonly params: string; readonly id: string }>();
  private sequence = 0;
  private configured = true;
  private readonly resources: StripeApi;

  constructor() {
    super();
    this.resources = {
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

  /** The next call of `method` throws `error` (several calls queue several errors, in order). */
  failNext(method: FakeStripeMethod, error: Error): this {
    const queued = this.failures.get(method) ?? [];
    queued.push(error);
    this.failures.set(method, queued);
    return this;
  }

  /** The recorded calls of `method`. */
  callsOf(method: FakeStripeMethod): FakeStripeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** Forgets every call, object, failure and idempotency key. */
  reset(): this {
    this.calls.length = 0;
    this.objects.clear();
    this.failures.clear();
    this.byIdempotencyKey.clear();
    this.configured = true;
    return this;
  }

  private record(method: FakeStripeMethod, id: string | undefined, params: unknown, options: unknown): void {
    const idempotencyKey = isRecord(options) ? options["idempotencyKey"] : undefined;
    this.calls.push({
      method,
      id,
      params: params === undefined ? undefined : structuredClone(params),
      idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined,
    });
    const failure = this.failures.get(method)?.shift();
    if (failure !== undefined) {
      throw failure;
    }
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

  private create<T>(method: CreateMethod, params: unknown, options: unknown): Promise<Stripe.Response<T>> {
    return settle(() => this.createNow<T>(method, params, options));
  }

  private createNow<T>(method: CreateMethod, params: unknown, options: unknown): Stripe.Response<T> {
    this.record(method, undefined, params, options);
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
      const object = this.objects.get(earlier.id);
      if (object === undefined) {
        throw new Error(`FakeStripe: the object of idempotency key ${key} was removed`);
      }
      return this.response<T>(structuredClone(object));
    }
    this.sequence += 1;
    const shape = CREATED[method];
    const id = `${shape.prefix}_fake_${this.sequence}`;
    const object: Json = {
      ...(isRecord(params) ? structuredClone(params) : {}),
      id,
      object: shape.object,
      livemode: false,
      created: 1_800_000_000 + this.sequence,
      ...(shape.url === undefined ? {} : { url: shape.url(id) }),
    };
    this.objects.set(id, object);
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
