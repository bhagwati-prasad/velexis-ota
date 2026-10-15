// Idempotent requests (PBE-009; architecture §3 step 10, conventions §2) through createTestApp, with the records in
// this file's Redis database. Test-only routes bind `createTenant`, the operation the document marks `x-idempotent`,
// so the interceptor applies to them as to the real route; a test guard puts the account into the request context, as
// the auth guard will (PBE-012). The handler counts its side effects, and can be held at a gate to make two requests
// overlap.
import { randomUUID } from "node:crypto";
import {
  Controller,
  HttpCode,
  Injectable,
  Post,
  Res,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenApiOperation, Validated } from "../../../src/common/http/openapi-operation.decorator";
import { RequestContext } from "../../../src/common/http/request-context";
import { REDIS_CLIENT } from "../../../src/common/redis/redis.module";
import { createTestApp, type TestApp } from "../../support/app";

const ACCOUNT_A = "acc_01JATESTRW0000000000000011";
const ACCOUNT_B = "acc_01JATESTRW0000000000000012";
const TEST_ACCOUNT_HEADER = "x-test-account";

interface CreateTenantBody {
  readonly key: string;
  readonly name: string;
  readonly countryCode: string;
  readonly defaultCurrency: string;
  readonly timeZone: string;
}

function body(overrides: Partial<CreateTenantBody> = {}): CreateTenantBody {
  return {
    key: "acme",
    name: "Acme Travel",
    countryCode: "NO",
    defaultCurrency: "EUR",
    timeZone: "Europe/Oslo",
    ...overrides,
  };
}

/** What the test handler did, and a gate that holds it until the test opens it. */
class SideEffects {
  readonly created: string[] = [];
  private gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;
  private entered: (() => void) | undefined;

  /** Holds the next handler call until `open()`; resolves when the handler has been entered. */
  hold(): Promise<void> {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
    return new Promise((resolve) => {
      this.entered = resolve;
    });
  }

  open(): void {
    this.openGate?.();
  }

  async run(key: string): Promise<number> {
    this.entered?.();
    this.entered = undefined;
    await this.gate;
    this.gate = undefined;
    this.created.push(key);
    return this.created.length;
  }
}

const effects = new SideEffects();

/** Puts the account of a test header into the request context, as the auth guard will (PBE-012). */
@Injectable()
class TestAccountGuard implements CanActivate {
  constructor(private readonly context: RequestContext) {}

  canActivate(execution: ExecutionContext): boolean {
    const accountId = execution.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers[
      TEST_ACCOUNT_HEADER
    ];
    if (typeof accountId === "string") {
      this.context.setActor({ type: "account", accountId });
    }
    return true;
  }
}

interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller("test/idempotent")
@UseGuards(TestAccountGuard)
class IdempotentTestController {
  @Post("tenants")
  @HttpCode(202)
  @OpenApiOperation("createTenant")
  async create(@Validated("body") input: CreateTenantBody): Promise<{ created: number; key: string }> {
    if (input.name === "Failing Travel") {
      effects.created.push(input.key);
      throw new AppError("TENANT_KEY_UNAVAILABLE");
    }
    return { created: await effects.run(input.key), key: input.key };
  }

  /** The same operation answering a secret shown once: `Cache-Control: no-store`. */
  @Post("tenants-no-store")
  @HttpCode(202)
  @OpenApiOperation("createTenant")
  async createNoStore(
    @Validated("body") input: CreateTenantBody,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<{ created: number }> {
    res.setHeader("Cache-Control", "no-store");
    return { created: await effects.run(input.key) };
  }
}

function post(t: TestApp, path: string, key: string | undefined, account: string, payload: unknown) {
  const req = t.http.post(path).set(TEST_ACCOUNT_HEADER, account).set(t.bffHeaders("203.0.113.7"));
  return (key === undefined ? req : req.set("Idempotency-Key", key)).send(payload as object);
}

describe("idempotent requests with Redis up", () => {
  let t: TestApp;
  let redis: Redis;

  beforeAll(async () => {
    t = await createTestApp({ controllers: [IdempotentTestController], providers: [TestAccountGuard] });
    redis = t.app.get<Redis>(REDIS_CLIENT);
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    effects.created.length = 0;
  });

  it("[PBE-009 AC1] runs two concurrent identical requests once: one side effect, the duplicate waits and gets the same answer", async () => {
    const key = randomUUID();
    // Resolves when the duplicate found the lock held, i.e. while the first request is in its handler.
    let lockBusy: () => void = () => undefined;
    const duplicateWaits = new Promise<void>((resolve) => {
      lockBusy = resolve;
    });
    const set = redis.set.bind(redis) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(redis, "set").mockImplementation((async (...args: unknown[]) => {
      const reply = await set(...args);
      if (args.includes("NX") && reply === null) {
        lockBusy();
      }
      return reply;
    }) as never);

    const entered = effects.hold();
    const first = post(t, "/test/idempotent/tenants", key, ACCOUNT_A, body()).then((res) => res);
    await entered;
    const second = post(t, "/test/idempotent/tenants", key, ACCOUNT_A, body()).then((res) => res);
    await duplicateWaits;
    effects.open();
    const [a, b] = await Promise.all([first, second]);

    expect(effects.created).toEqual(["acme"]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(b.body).toEqual(a.body);
    expect(a.body).toEqual({ created: 1, key: "acme" });
    expect(await redis.exists(`vx:idem:${ACCOUNT_A}:${key}:lock`)).toBe(0);
  });

  it("[PBE-009 AC1] answers 409 IDEMPOTENCY_KEY_REUSED to the same key with a changed body, without running the handler", async () => {
    const key = randomUUID();
    const original = await post(t, "/test/idempotent/tenants", key, ACCOUNT_A, body());

    const changed = await post(
      t,
      "/test/idempotent/tenants",
      key,
      ACCOUNT_A,
      body({ name: "Acme Travel AS" }),
    );

    expect(original.status).toBe(202);
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED", status: 409 } });
    expectResponseToMatch("createTenant", changed, { document: "platform" });
    expect(effects.created).toEqual(["acme"]);
  });

  it("replays the stored status and body to a later retry with the same key and body, in any key order", async () => {
    const key = randomUUID();
    const first = await post(t, "/test/idempotent/tenants", key, ACCOUNT_A, body({ key: "nordic" }));
    const { timeZone, key: tenantKey, ...rest } = body({ key: "nordic" });

    const retry = await post(t, "/test/idempotent/tenants", key, ACCOUNT_A, {
      timeZone,
      ...rest,
      key: tenantKey,
    });

    expect(effects.created).toEqual(["nordic"]);
    expect([retry.status, retry.body]).toEqual([first.status, first.body]);
    const ttl = await redis.ttl(`vx:idem:${ACCOUNT_A}:${key}`);
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  it("keeps the keys of two accounts apart", async () => {
    const key = randomUUID();

    const mine = await post(t, "/test/idempotent/tenants", key, ACCOUNT_A, body());
    const theirs = await post(t, "/test/idempotent/tenants", key, ACCOUNT_B, body());

    expect([mine.status, theirs.status]).toEqual([202, 202]);
    expect(effects.created).toEqual(["acme", "acme"]);
  });

  it("requires the Idempotency-Key header (400 VALIDATION_FAILED naming it)", async () => {
    const res = await post(t, "/test/idempotent/tenants", undefined, ACCOUNT_A, body());

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: [expect.objectContaining({ path: "/header/Idempotency-Key", code: "required" })],
      },
    });
    expect(effects.created).toEqual([]);
  });

  it("stores no error answer, so a retry after a failure runs again", async () => {
    const key = randomUUID();

    const failed = await post(
      t,
      "/test/idempotent/tenants",
      key,
      ACCOUNT_A,
      body({ name: "Failing Travel" }),
    );
    const retried = await post(
      t,
      "/test/idempotent/tenants",
      key,
      ACCOUNT_A,
      body({ name: "Failing Travel" }),
    );

    expect([failed.status, retried.status]).toEqual([409, 409]);
    expect(effects.created).toEqual(["acme", "acme"]);
    expect(await redis.exists(`vx:idem:${ACCOUNT_A}:${key}`)).toBe(0);
  });

  it("never stores a `Cache-Control: no-store` answer for a replay", async () => {
    const key = randomUUID();

    const first = await post(t, "/test/idempotent/tenants-no-store", key, ACCOUNT_A, body());
    const second = await post(t, "/test/idempotent/tenants-no-store", key, ACCOUNT_A, body());

    expect([first.status, second.status]).toEqual([202, 202]);
    expect([first.body, second.body]).toEqual([{ created: 1 }, { created: 2 }]);
    expect(await redis.exists(`vx:idem:${ACCOUNT_A}:${key}`)).toBe(0);
  });
});

describe("idempotent requests with Redis down", () => {
  let t: TestApp;

  beforeAll(async () => {
    const unreachable = new Redis("redis://127.0.0.1:1/0", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    unreachable.on("error", () => {
      // Expected: nothing listens there.
    });
    t = await createTestApp({
      controllers: [IdempotentTestController],
      providers: [TestAccountGuard],
      overrides: [{ provide: REDIS_CLIENT, useValue: unreachable }],
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  it("answers 503 SERVICE_UNAVAILABLE before the handler runs", async () => {
    effects.created.length = 0;

    const res = await post(t, "/test/idempotent/tenants", randomUUID(), ACCOUNT_A, body());

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE", status: 503 } });
    expectResponseToMatch("createTenant", res, { document: "platform" });
    expect(effects.created).toEqual([]);
  });
});
