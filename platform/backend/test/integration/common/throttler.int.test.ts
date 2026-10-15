// The rate limits of the platform API (PBE-009; api-inventory §2 "Rate limits", architecture §3 step 4, PADR-0019)
// through createTestApp, with the counters in this file's Redis database. Test-only routes bind the operations of the
// inventory's rows, so they get the limits those operations get; the portal and admin servers' calls are made as they
// make them, with the BFF key and the forwarded end-user IP (TestApp.bffHeaders).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Post,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from "@nestjs/common";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_ROUTES } from "../../../src/app.module";
import {
  OPERATION_RATE_LIMITS,
  RATE_LIMITS,
  trackerDigest,
  type RateLimit,
} from "../../../src/common/http/throttler.config";
import { OpenApiOperation } from "../../../src/common/http/openapi-operation.decorator";
import { RequestContext } from "../../../src/common/http/request-context";
import { REDIS_CLIENT } from "../../../src/common/redis/redis.module";
import { APP_DIR } from "../../../src/config";
import { createTestApp, TEST_BFF_KEY, type TestApp } from "../../support/app";

// Documentation addresses (RFC 5737, RFC 3849), example.com mailboxes and made-up passwords only.
const PERSON_A = "203.0.113.7";
const PERSON_B = "2001:db8::42";
const PERSON_C = "198.51.100.23";
const PERSON_D = "198.51.100.77";
const PASSWORD = "Northern-Lights-Test-2026!";
const ACCOUNT_A = "acc_01JATESTRW0000000000000001";
const ACCOUNT_B = "acc_01JATESTRW0000000000000002";
/** The header the test middleware reads the authenticated account from (the auth guard's job, PBE-012). */
const TEST_ACCOUNT_HEADER = "x-test-account";

function signUpBody(n: number): Record<string, unknown> {
  return {
    email: `person${n}@example.com`,
    password: PASSWORD,
    fullName: `Person ${n}`,
    acceptTerms: true,
    termsVersion: "2026-10-01",
  };
}

/** Test-only routes bound to the operations of the inventory's rows. */
@Controller("test/limits")
class LimitedTestController {
  @Post("sign-up")
  @HttpCode(202)
  @OpenApiOperation("signUp")
  signUp(): { status: "verification_sent" } {
    return { status: "verification_sent" };
  }

  @Post("password-reset")
  @HttpCode(202)
  @OpenApiOperation("requestPasswordReset")
  requestPasswordReset(@Body() _body: unknown): void {}

  @Get("key-availability")
  @OpenApiOperation("checkTenantKey")
  checkTenantKey(): { ok: true } {
    return { ok: true };
  }

  /** Bound to no operation of a specific row: "everything else authenticated". */
  @Get("other")
  other(): { ok: true } {
    return { ok: true };
  }
}

/** Sets the account of the request context from a test header, as the auth guard will (PBE-012). */
@Injectable()
class TestAccountMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContext) {}

  use(req: { headers: Record<string, unknown> }, _res: unknown, next: () => void): void {
    const accountId = req.headers[TEST_ACCOUNT_HEADER];
    if (typeof accountId === "string") {
      this.context.setActor({ type: "account", accountId });
    }
    next();
  }
}

/** Mounted after AppModule's middleware (same distance, imported after it), so the request context exists. */
@Module({ providers: [TestAccountMiddleware] })
class TestAccountModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TestAccountMiddleware).forRoutes(ALL_ROUTES);
  }
}

describe("the rate limits with Redis up", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ controllers: [LimitedTestController], imports: [TestAccountModule] });
  });

  afterAll(async () => {
    await t?.close();
  });

  it("[PBE-009 AC3] answers 429 RATE_LIMITED with Retry-After on the sixth sign-up from one IP within an hour", async () => {
    const answers = [];
    for (let n = 1; n <= 6; n += 1) {
      answers.push(await t.http.post("/test/limits/sign-up").set(t.bffHeaders(PERSON_A)).send(signUpBody(n)));
    }

    expect(answers.map((res) => res.status)).toEqual([202, 202, 202, 202, 202, 429]);
    const limited = answers[5];
    if (limited === undefined) {
      throw new Error("no sixth answer");
    }
    expectResponseToMatch("signUp", limited, { document: "platform" });
    expect(limited.body).toMatchObject({ error: { code: "RATE_LIMITED", status: 429 } });
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(3500);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    // No X-RateLimit-* headers, and no Retry-After on the answers that passed.
    expect(Object.keys(limited.headers).filter((name) => name.startsWith("x-ratelimit"))).toEqual([]);
    expect(answers[4]?.headers["retry-after"]).toBeUndefined();
  });

  it("[PBE-009 AC3] keeps the counter in Redis under the IP's digest, for the hour of the window", async () => {
    const counter = `rl:sign_up:${trackerDigest("ip", PERSON_A)}`;

    expect(await t.redis.client.get(counter)).toBe("6");
    const ttl = await t.redis.client.ttl(counter);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
    const keys = await t.redis.client.keys("rl:*");
    expect(keys.join(" ")).not.toContain(PERSON_A);
  });

  it("[PBE-009 AC4] gives two end users behind the BFF key separate buckets: one is throttled, the other passes", async () => {
    // PERSON_A has used up the hour in the test above.
    const throttled = await t.http
      .post("/test/limits/sign-up")
      .set(t.bffHeaders(PERSON_A))
      .send(signUpBody(7));
    const other = await t.http.post("/test/limits/sign-up").set(t.bffHeaders(PERSON_B)).send(signUpBody(8));

    expect(throttled.status).toBe(429);
    expect(other.status).toBe(202);
  });

  it("[PBE-009 AC4] counts a forged X-Velexis-End-User-IP without the BFF key against the caller's own address", async () => {
    // Without the key the forwarded headers are ignored (PADR-0019): every call counts for 127.0.0.1, whatever it
    // claims, so changing the header does not buy a fresh bucket.
    const statuses: number[] = [];
    for (let n = 1; n <= 6; n += 1) {
      const res = await t.http
        .post("/test/limits/sign-up")
        .set("X-Velexis-End-User-IP", `192.0.2.${n}`)
        .send(signUpBody(100 + n));
      statuses.push(res.status);
    }
    const wrongKey = await t.http
      .post("/test/limits/sign-up")
      .set({ ...t.bffHeaders(PERSON_D), "X-Velexis-Bff-Key": `${TEST_BFF_KEY.slice(0, -1)}x` })
      .send(signUpBody(107));

    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    expect(wrongKey.status).toBe(429);
  });

  it("counts an IPv6 end user per /64, so new addresses of the same network buy no fresh bucket", async () => {
    // 2001:db8:0:7::/64 is one network (RFC 3849 documentation prefix); 2001:db8:0:8::/64 is another.
    const statuses: number[] = [];
    for (let n = 1; n <= 6; n += 1) {
      const res = await t.http
        .post("/test/limits/sign-up")
        .set(t.bffHeaders(`2001:db8:0:7::${n.toString(16)}`))
        .send(signUpBody(200 + n));
      statuses.push(res.status);
    }
    const otherNetwork = await t.http
      .post("/test/limits/sign-up")
      .set(t.bffHeaders("2001:db8:0:8::1"))
      .send(signUpBody(207));

    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    expect(otherNetwork.status).toBe(202);
    expect(await t.redis.client.get(`rl:sign_up:${trackerDigest("ip", "2001:db8:0:7::/64")}`)).toBe("6");
  });

  it("counts the password-reset requests of one e-mail address from any IP, and of one IP for any address", async () => {
    const reset = (ip: string, email: string): Promise<{ status: number }> =>
      t.http.post("/test/limits/password-reset").set(t.bffHeaders(ip)).send({ email });

    // 3 per e-mail per hour, whatever the IP and however the address is written.
    const sameAddress = [
      await reset(PERSON_B, "anna.berg@example.com"),
      await reset(PERSON_C, "Anna.Berg@Example.com"),
      await reset(PERSON_D, "anna.berg@EXAMPLE.COM"),
      await reset(PERSON_A, "anna.berg@example.com"),
    ];
    expect(sameAddress.map((res) => res.status)).toEqual([202, 202, 202, 429]);

    // 10 per IP per hour, whatever the address: PERSON_C has used one above.
    const sameIp: number[] = [];
    for (let n = 1; n <= 10; n += 1) {
      sameIp.push((await reset(PERSON_C, `reader${n}@example.com`)).status);
    }
    expect(sameIp).toEqual([202, 202, 202, 202, 202, 202, 202, 202, 202, 429]);
  });

  it("counts per account once the account is known: the 31st key check of one account is refused, another passes", async () => {
    const check = (accountId: string): Promise<{ status: number }> =>
      t.http
        .get("/test/limits/key-availability?key=acme")
        .set(t.bffHeaders(PERSON_B))
        .set(TEST_ACCOUNT_HEADER, accountId);

    const statuses: number[] = [];
    for (let n = 1; n <= 31; n += 1) {
      statuses.push((await check(ACCOUNT_A)).status);
    }
    const other = await check(ACCOUNT_B);

    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(other.status).toBe(200);
  });

  it("counts every other request of an account against `authenticated`, and nothing for a request without one", async () => {
    const counter = `rl:authenticated:${trackerDigest("account", ACCOUNT_B)}`;
    const before = Number((await t.redis.client.get(counter)) ?? "0");

    const signedIn = await t.http.get("/test/limits/other").set(TEST_ACCOUNT_HEADER, ACCOUNT_B);
    const anonymous = await t.http.get("/test/limits/other");

    expect([signedIn.status, anonymous.status]).toEqual([200, 200]);
    expect(Number(await t.redis.client.get(counter))).toBe(before + 1);
    expect(await t.redis.client.ttl(counter)).toBeGreaterThan(0);
    // The key check of ACCOUNT_B above counted against key_availability only.
    expect(before).toBe(0);
  });
});

/** api-inventory §2: the rows of the rate-limit table, `| group | limit |`. */
function inventoryRows(): Array<{ readonly group: string; readonly text: string }> {
  const inventory = readFileSync(join(APP_DIR, "..", "docs", "api-inventory.md"), "utf8");
  const table = inventory.split("| Endpoint group | Limit |")[1]?.split("\n\n")[0] ?? "";
  return table
    .split("\n")
    .slice(2)
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4)
    .map((cells) => ({ group: cells[1] ?? "", text: cells[2] ?? "" }));
}

const UNIT_SECONDS: Readonly<Record<string, number>> = { minute: 60, hour: 3600, "10 minutes": 600 };
const TRACKER_WORD: Readonly<Record<string, RateLimit["by"]>> = {
  IP: "ip",
  account: "account",
  "e-mail": "email",
  domain: "domain",
};

describe("the named throttlers", () => {
  it("are one per limit of the rate-limit table of api-inventory §2, with its numbers", () => {
    const rows = inventoryRows();
    expect(rows.map((row) => row.group)).toHaveLength(9);

    const fromDocument = rows.flatMap((row) =>
      [...row.text.matchAll(/(\d+) per (IP|account|e-mail|domain) per (minute|hour|10 minutes)/g)].map(
        ([, limit, tracker, unit]) => ({
          row: row.group,
          limit: Number(limit),
          by: TRACKER_WORD[tracker ?? ""],
          windowSeconds: UNIT_SECONDS[unit ?? ""],
        }),
      ),
    );
    const limits = Object.values(RATE_LIMITS).map(({ row, limit, by, windowSeconds }) => ({
      row,
      limit,
      by,
      windowSeconds,
    }));

    expect(limits).toEqual(fromDocument);
    expect(new Set(Object.values(RATE_LIMITS).map((limit) => limit.name)).size).toBe(limits.length);
  });

  it("name only operations of the platform document", () => {
    const document = readFileSync(join(APP_DIR, "openapi", "velexis-platform-api.openapi.yaml"), "utf8");

    for (const operationId of Object.keys(OPERATION_RATE_LIMITS)) {
      expect(document, operationId).toContain(`operationId: ${operationId}\n`);
    }
  });
});

describe("the rate limits with Redis down", () => {
  let t: TestApp;
  let unreachable: Redis;

  beforeAll(async () => {
    // A command client on a port where nothing listens: every rate-limit counter fails.
    unreachable = new Redis("redis://127.0.0.1:1/0", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    unreachable.on("error", () => {
      // Expected: nothing listens there. The guards log the failure of each command.
    });
    t = await createTestApp({
      controllers: [LimitedTestController],
      imports: [TestAccountModule],
      overrides: [{ provide: REDIS_CLIENT, useValue: unreachable }],
    });
  });

  afterAll(async () => {
    await t?.close();
    unreachable?.disconnect();
  });

  it("refuses a request of a specific row with 503 SERVICE_UNAVAILABLE and logs why", async () => {
    const before = t.logs.lines.length;

    const res = await t.http.post("/test/limits/sign-up").set(t.bffHeaders(PERSON_A)).send(signUpBody(1));

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE", status: 503 } });
    expect(
      t.logs.lines.slice(before).filter((line) => line["msg"] === "throttler.store_unavailable"),
    ).toEqual([expect.objectContaining({ level: 40, throttler: "sign_up" })]);
  });

  it("lets an authenticated request through `authenticated` with a warning, so a Redis outage takes no page down", async () => {
    const before = t.logs.lines.length;

    const res = await t.http.get("/test/limits/other").set(TEST_ACCOUNT_HEADER, ACCOUNT_A);

    expect(res.status).toBe(200);
    expect(
      t.logs.lines.slice(before).filter((line) => line["msg"] === "throttler.store_unavailable"),
    ).toEqual([expect.objectContaining({ level: 40, throttler: "authenticated" })]);
  });
});
