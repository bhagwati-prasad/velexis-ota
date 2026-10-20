// Test support: a fake of the Stripe API on the loopback interface (OBE-038), so payment tests mock Stripe at the HTTP
// layer: the real `stripe` SDK client of the application sends its requests here (the test provides
// STRIPE_API_ENDPOINT, src/payments/stripe/stripe-client.factory.ts) and the fake answers them as Stripe would, enough
// for the PaymentIntents the payment gateway creates, updates, reads, captures and cancels and for refunds. It never
// talks to Stripe and holds no key: the tests build their keys at run time.
//
//   stripe = await startFakeStripe();
//   api = await createTestApp({ imports: [stripeEndpointModule(stripe.endpoint)], env: { STRIPE_SECRET_KEY_TEST: … } });
//   …
//   expect(stripe.requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/payment_intents" });
//
// Like Stripe it replays the answer of a POST with a known `Idempotency-Key` and the same body, a 500 included, and
// refuses the same key with another body (400 `idempotency_error`, kept for nothing). `fail(n, "drop")` closes the
// connections of the next `n` requests before they are handled (Stripe unreachable), `fail(n, "lost")` handles them
// (and keeps their answers for their keys) but closes the connections instead of answering (the answer is lost), and
// `fail(n, "server_error")` answers them with a 500 `api_error`, which a POST's key keeps. `onRequest` runs before
// each answer, for assertions about what the caller had done before it called Stripe.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Global, Module, type DynamicModule } from "@nestjs/common";
import { STRIPE_API_ENDPOINT, type StripeApiEndpoint } from "../../src/payments/stripe/stripe-client.factory";

/** A form-decoded request body or query (`a[b][0]=c` → `{ a: { b: ["c"] } }`). */
export type FormValue = string | FormValue[] | { [key: string]: FormValue };

/** One request the fake received. */
export interface FakeStripeRequest {
  readonly method: string;
  /** The path without the query (`/v1/payment_intents`). */
  readonly path: string;
  readonly query: Record<string, FormValue>;
  /** Headers by lower-case name. */
  readonly headers: Readonly<Record<string, string>>;
  readonly form: Record<string, FormValue>;
  /** The raw body, as sent. */
  readonly body: string;
}

/** A PaymentIntent as the fake keeps it (the JSON of Stripe's API, the fields the gateway reads). */
export type FakePaymentIntent = Record<string, unknown> & {
  readonly id: string;
  status: string;
  amount: number;
};

/** How the next requests fail. */
export type FakeStripeFailure = "drop" | "lost" | "server_error";

export interface FakeStripe {
  readonly endpoint: StripeApiEndpoint;
  /** Every request so far, in order. */
  readonly requests: FakeStripeRequest[];
  /** The PaymentIntents by id. */
  readonly intents: Map<string, FakePaymentIntent>;
  /** The next `count` requests fail as `failure` says. */
  fail(count: number, failure: FakeStripeFailure): void;
  /** Runs before each answer (after the request was recorded); its rejection fails that request with a 500. */
  onRequest(hook: ((request: FakeStripeRequest) => Promise<void> | void) | undefined): void;
  /** Changes a stored PaymentIntent (a confirmation in the browser, a capture elsewhere). */
  update(id: string, patch: Record<string, unknown>): void;
  /** Forgets the requests, the replays and the failures (not the PaymentIntents). */
  reset(): void;
  close(): Promise<void>;
}

const isPlainObject = (value: unknown): value is Record<string, FormValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Objects whose keys are all indices become arrays (stripe-node encodes arrays as `a[0]=x`). */
function arrays(value: FormValue): FormValue {
  if (!isPlainObject(value)) {
    return Array.isArray(value) ? value.map(arrays) : value;
  }
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
    return keys.sort((a, b) => Number(a) - Number(b)).map((key) => arrays(value[key] as FormValue));
  }
  return Object.fromEntries(keys.map((key) => [key, arrays(value[key] as FormValue)]));
}

/** Decodes `application/x-www-form-urlencoded` with bracketed keys, as Stripe's API reads it. */
export function decodeForm(text: string): Record<string, FormValue> {
  const root: Record<string, FormValue> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const parts = key.split(/\[|\]\[|\]/).filter((part) => part !== "");
    let target: Record<string, FormValue> = root;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        target[part] = value;
        return;
      }
      const next = target[part];
      if (!isPlainObject(next)) {
        target[part] = {};
      }
      target = target[part] as Record<string, FormValue>;
    });
  }
  return arrays(root) as Record<string, FormValue>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Request-Id": `req_${randomBytes(8).toString("hex")}`,
  });
  res.end(text);
}

function stripeError(
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
  code?: string,
): void {
  send(res, status, { error: { type, message, ...(code === undefined ? {} : { code }) } });
}

function headersOf(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(req.headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(", ") : (value ?? ""),
    ]),
  );
}

const text = (value: FormValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Starts the fake on 127.0.0.1 and a free port. Close it in `afterAll`. */
export async function startFakeStripe(): Promise<FakeStripe> {
  const requests: FakeStripeRequest[] = [];
  const intents = new Map<string, FakePaymentIntent>();
  const replays = new Map<
    string,
    { readonly body: string; readonly status: number; readonly answer: unknown }
  >();
  let failures: FakeStripeFailure[] = [];
  let hook: ((request: FakeStripeRequest) => Promise<void> | void) | undefined;

  const intentAnswer = (intent: FakePaymentIntent, expand: readonly string[]): unknown => {
    const answer: Record<string, unknown> = { ...intent };
    for (const field of ["payment_method", "latest_charge"]) {
      const value = intent[field];
      if (!expand.includes(field) && isPlainObject(value)) {
        answer[field] = (value as { id?: string }).id ?? null;
      }
    }
    return answer;
  };

  /** The answer of one request: status and JSON body. */
  const handle = (request: FakeStripeRequest): { status: number; body: unknown } => {
    const { method, path, form, query } = request;
    const expandOf = (value: FormValue | undefined): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    if (method === "POST" && path === "/v1/payment_intents") {
      const id = `pi_test_${randomBytes(12).toString("hex")}`;
      const amount = Number(text(form["amount"]));
      const intent: FakePaymentIntent = {
        id,
        object: "payment_intent",
        status: "requires_payment_method",
        amount,
        amount_capturable: 0,
        amount_received: 0,
        currency: text(form["currency"]) ?? "eur",
        capture_method: text(form["capture_method"]) ?? "automatic_async",
        client_secret: `${id}_secret_${randomBytes(12).toString("hex")}`,
        metadata: isPlainObject(form["metadata"]) ? form["metadata"] : {},
        payment_method: null,
        latest_charge: null,
        last_payment_error: null,
        statement_descriptor_suffix: text(form["statement_descriptor_suffix"]) ?? null,
        payment_method_types: Array.isArray(form["payment_method_types"]) ? form["payment_method_types"] : [],
        livemode: false,
      };
      intents.set(id, intent);
      return { status: 200, body: intentAnswer(intent, []) };
    }
    const match = /^\/v1\/payment_intents\/([A-Za-z0-9_]+)(?:\/(cancel|capture))?$/.exec(path);
    if (match !== null) {
      const intent = intents.get(match[1] ?? "");
      if (intent === undefined) {
        return {
          status: 404,
          body: {
            error: {
              type: "invalid_request_error",
              code: "resource_missing",
              message: "No such payment_intent",
            },
          },
        };
      }
      const action = match[2];
      if (method === "GET" && action === undefined) {
        return { status: 200, body: intentAnswer(intent, expandOf(query["expand"])) };
      }
      if (method === "POST" && action === undefined) {
        const amount = text(form["amount"]);
        if (amount !== undefined) {
          intent.amount = Number(amount);
        }
        return { status: 200, body: intentAnswer(intent, []) };
      }
      if (method === "POST" && action === "cancel") {
        intent.status = "canceled";
        return { status: 200, body: intentAnswer(intent, []) };
      }
      if (method === "POST" && action === "capture") {
        const captured = Number(text(form["amount_to_capture"]) ?? intent.amount);
        intent.status = "succeeded";
        intent["amount_received"] = captured;
        intent["amount_capturable"] = 0;
        return { status: 200, body: intentAnswer(intent, []) };
      }
    }
    if (method === "POST" && path === "/v1/refunds") {
      return {
        status: 200,
        body: {
          id: `re_test_${randomBytes(12).toString("hex")}`,
          object: "refund",
          amount: Number(text(form["amount"])),
          status: "pending",
          payment_intent: text(form["payment_intent"]) ?? null,
          metadata: isPlainObject(form["metadata"]) ? form["metadata"] : {},
        },
      };
    }
    return {
      status: 404,
      body: {
        error: { type: "invalid_request_error", message: `Unrecognized request URL (${method}: ${path})` },
      },
    };
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const request: FakeStripeRequest = {
          method: req.method ?? "GET",
          path: url.pathname,
          query: decodeForm(url.search.slice(1)),
          headers: headersOf(req),
          form: decodeForm(body),
          body,
        };
        requests.push(request);
        const failure = failures.shift();
        if (failure === "drop") {
          req.socket.destroy();
          return;
        }
        try {
          await hook?.(request);
        } catch {
          stripeError(res, 500, "api_error", "The test's hook failed");
          return;
        }
        const key = request.method === "POST" ? request.headers["idempotency-key"] : undefined;
        const replay = key === undefined ? undefined : replays.get(key);
        let answer: { status: number; body: unknown };
        if (replay !== undefined && replay.body !== body) {
          answer = {
            status: 400,
            body: {
              error: {
                type: "idempotency_error",
                message:
                  "Keys for idempotent requests can only be used with the same parameters they were first used with.",
              },
            },
          };
        } else if (replay !== undefined) {
          answer = { status: replay.status, body: replay.answer };
        } else {
          answer =
            failure === "server_error"
              ? {
                  status: 500,
                  body: { error: { type: "api_error", message: "An unexpected error occurred" } },
                }
              : handle(request);
          if (key !== undefined) {
            replays.set(key, { body, status: answer.status, answer: answer.body });
          }
        }
        if (failure === "lost") {
          req.socket.destroy();
          return;
        }
        send(res, answer.status, answer.body);
      })();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const { port } = server.address() as { port: number };
  return {
    endpoint: Object.freeze({ host: "127.0.0.1", port, protocol: "http" as const }),
    requests,
    intents,
    fail(count, failure) {
      failures = [...failures, ...Array.from({ length: count }, () => failure)];
    },
    onRequest(next) {
      hook = next;
    },
    update(id, patch) {
      const intent = intents.get(id);
      if (intent === undefined) {
        throw new Error(`fake Stripe: no PaymentIntent ${id}`);
      }
      Object.assign(intent, patch);
    },
    reset() {
      requests.length = 0;
      replays.clear();
      failures = [];
      hook = undefined;
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

/**
 * A global module that provides STRIPE_API_ENDPOINT, for `createTestApp({ imports: [stripeEndpointModule(…)] })`: the
 * application's Stripe clients then send every request to the fake.
 */
export function stripeEndpointModule(endpoint: StripeApiEndpoint): DynamicModule {
  @Global()
  @Module({})
  class FakeStripeEndpointModule {}
  return {
    module: FakeStripeEndpointModule,
    providers: [{ provide: STRIPE_API_ENDPOINT, useValue: endpoint }],
    exports: [STRIPE_API_ENDPOINT],
    global: true,
  };
}
