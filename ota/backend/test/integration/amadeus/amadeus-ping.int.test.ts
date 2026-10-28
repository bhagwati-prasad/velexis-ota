// `node dist/cli.js amadeus:ping` (OBE-025; README §5) against PostgreSQL 16, Redis 7 and the Amadeus stub, through
// `runCli` as the command line runs it. The file clones the @velexis/testing template (tenant_alpha provisioned), writes
// the platform rows as velexis_migrator does for the platform (the Velexis test account with its client secret
// encrypted with the test KEK, the tenant `alpha` with an active connection on it, the tenant `beta` whose connection
// still waits for an office), and starts two stubs: one that accepts the account's credentials, and one that accepts
// other credentials only, which is Amadeus refusing ours. The command reads the variables it is given, never the
// process environment.
import { randomBytes } from "node:crypto";
import { decryptValue, encryptValue, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
} from "@velexis/db";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { startAmadeusStub, TOKEN_OPERATION, type AmadeusStub } from "@velexis/testing/amadeus";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AMADEUS_PING_OPERATION } from "../../../src/amadeus/amadeus-ping.command";
import { tokenAad } from "../../../src/amadeus/token-provider";
import { runCli } from "../../../src/cli";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { TEST_MASTER_KEY_CURRENT, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

let db: TestDatabase;
let redis: TestRedis;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
/** The stub that accepts the account's credentials. */
let stub: AmadeusStub;
/** A stub that accepts other credentials only: Amadeus refusing the account's. */
let refusing: AmadeusStub;
let accountId: string;
let clientSecret: string;
let alphaOffice: string;

/** A random Amadeus office id (`^[A-Z0-9]{9}$`). */
const newOffice = (): string => `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;

/** Inserts a tenant and its test connection on the account, with `office` (none: waiting for one). */
async function insertTenant(key: string, office: string | null): Promise<void> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: id,
      environment: "test",
      credential_source: "velexis",
      amadeus_account_id: accountId,
      office_ids: office === null ? [] : [office],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      status: office === null ? "pending_verification" : "active",
    })
    .execute();
}

function buffer(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = [];
  return { write: (chunk) => void chunks.push(chunk), text: () => chunks.join("") };
}

/**
 * Runs `amadeus:ping` with `args` against the stub at `baseUrl`. Its log lines (at `logLevel`) go to its stderr, as
 * in a process of its own: nestjs-pino writes every line outside a request to the first logger of the process otherwise.
 */
async function ping(
  args: readonly string[],
  baseUrl: string,
  logLevel: "info" | "debug" = "info",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = buffer();
  const stderr = buffer();
  useNextApplicationLoggerOutsideRequests();
  const code = await runCli(["amadeus:ping", ...args], {
    stdout,
    stderr,
    env: {
      APP_ENV: "test",
      LOG_LEVEL: logLevel,
      DATABASE_URL: db.urlFor("ota"),
      REDIS_URL: redis.url,
      MASTER_KEY_DIR: testApiCredentials().masterKeyDir,
      MASTER_KEY_CURRENT: TEST_MASTER_KEY_CURRENT,
      AMADEUS_BASE_URL_TEST: baseUrl,
    },
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

// Cloning the template, encrypting the secret and starting the stubs take a few seconds on a busy runner: once here,
// with its own budget. Each run of the command builds its own module graph inside the test.
beforeAll(async () => {
  [db, redis, keys] = await Promise.all([createTestDatabase(), useRedis(), testKeyProvider()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });

  accountId = newId("ama");
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  clientSecret = randomBytes(24).toString("base64url");
  const { ciphertext, kekId } = await encryptValue(clientSecret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${accountId}`,
    keys,
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id: accountId,
      name: "Velexis test",
      environment: "test",
      base_url: "https://test.travel.api.amadeus.com",
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  alphaOffice = newOffice();
  await insertTenant("alpha", alphaOffice);
  await insertTenant("beta", null);
  [stub, refusing] = await Promise.all([
    startAmadeusStub({ credentials: { clientId, clientSecret } }),
    startAmadeusStub({ credentials: { clientId, clientSecret: randomBytes(24).toString("base64url") } }),
  ]);
}, 120_000);

afterAll(async () => {
  await stub?.stop();
  await refusing?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

// Each run starts without a cached token and without the refused-credentials flag of an earlier one.
beforeEach(async () => {
  await redis.client.del(
    redisKeys.amadeusToken(accountId, "test").key,
    redisKeys.amadeusBadCredentials(accountId).key,
  );
  stub.clearRequests();
  refusing.clearRequests();
});

describe("amadeus:ping", () => {
  it("[OBE-025 AC2] prints ok and exits 0 against the stub, with the status and duration of each step and never the token", async () => {
    // At debug, every log line of the run reaches stderr: the token request's and the call's among them.
    const { code, stdout, stderr } = await ping(["--tenant", "alpha", "--env", "test"], stub.url, "debug");

    expect(code).toBe(0);
    const logged = stderr
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as { msg: string }).msg);
    expect(logged).toEqual(expect.arrayContaining(["amadeus.token_request", "amadeus.call"]));
    const lines = stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("ok");
    expect(lines[0]).toMatch(
      /^amadeus:ping: tenant alpha \(ten_[0-9A-Z]{26}, active\), Amadeus test environment$/,
    );
    expect(lines[1]).toMatch(
      new RegExp(
        `^amadeus:ping: connection sc_[0-9A-Z]{26} \\(velexis, credential set ${accountId}, office ${alphaOffice}\\) ` +
          `at ${stub.url.replace(/[.]/g, "\\.")}: ok in [0-9]+ ms$`,
      ),
    );
    expect(lines[2]).toMatch(/^amadeus:ping: token: ok in [0-9]+ ms$/);
    const read =
      /^amadeus:ping: Flight Offers Search \(MAD-BCN on [0-9-]+, request id (amadeus-ping-[0-9a-f]{16})\): HTTP 200 in [0-9]+ ms \(Amadeus [0-9]+ ms, ama-request-id .+, supplier request (sreq_[0-9A-Z]{26})\)$/.exec(
        lines[3] ?? "",
      );
    expect(read).not.toBeNull();
    expect(lines).toHaveLength(5);

    // One token request and one read, of one offer at most.
    const requests = stub.requests();
    expect(requests.map((request) => request.operation)).toEqual([TOKEN_OPERATION, "getFlightOffers"]);
    expect(requests[1]?.query).toMatchObject({
      originLocationCode: "MAD",
      destinationLocationCode: "BCN",
      max: "1",
    });

    // The read is recorded in the tenant's supplier_requests under the printed request id.
    const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .selectFrom("supplier_requests")
        .select(["id", "operation", "amadeus_operation_id", "http_status", "office_id"])
        .where("request_id", "=", read?.[1] ?? "")
        .execute(),
    );
    expect(rows).toEqual([
      {
        id: read?.[2],
        operation: AMADEUS_PING_OPERATION,
        amadeus_operation_id: "getFlightOffers",
        http_status: 200,
        office_id: alphaOffice,
      },
    ]);

    // The token the command obtained (cached, encrypted, in Redis) and the client secret appear nowhere.
    const stored = await redis.client.get(redisKeys.amadeusToken(accountId, "test").key);
    expect(stored).not.toBeNull();
    const token = (
      await decryptValue(Buffer.from(stored ?? "", "base64"), { aad: tokenAad(accountId, "test"), keys })
    ).toString("utf8");
    expect(token.length).toBeGreaterThan(8);
    expect(stdout + stderr).not.toContain(token);
    expect(stdout + stderr).not.toContain(clientSecret);
  });

  it("[OBE-025 AC2] exits 1 with SUPPLIER_NOT_CONFIGURED when Amadeus refuses the credentials, before any read", async () => {
    const { code, stdout, stderr } = await ping(["--tenant", "alpha", "--env", "test"], refusing.url);

    expect(code).toBe(1);
    expect(stderr).toMatch(
      /^amadeus:ping: token failed after [0-9]+ ms: SUPPLIER_NOT_CONFIGURED \(credentials_refused\)$/m,
    );
    // The token provider's alert line (an error, so above the command's default `warn`) names the credential set only.
    expect(stderr).toContain('"msg":"amadeus.credentials_refused"');
    expect(stdout).toContain(": connection sc_");
    expect(stdout).not.toContain("token: ok");
    expect(stdout.trimEnd().split("\n").at(-1)).not.toBe("ok");
    expect(refusing.requests().map((request) => request.operation)).toEqual([TOKEN_OPERATION]);
    expect(stdout + stderr).not.toContain(clientSecret);
  });

  it("exits 1 with SUPPLIER_NOT_CONFIGURED when the connection cannot serve calls, without calling Amadeus", async () => {
    const { code, stdout, stderr } = await ping(["--tenant=beta", "--env=test"], stub.url);

    expect(code).toBe(1);
    expect(stdout).toMatch(/^amadeus:ping: tenant beta \(ten_[0-9A-Z]{26}, active\)/);
    expect(stderr).toMatch(
      /^amadeus:ping: connection failed after [0-9]+ ms: SUPPLIER_NOT_CONFIGURED \(connection_not_active\)$/m,
    );
    expect(stub.requests()).toEqual([]);
  });

  it("exits 1 for a tenant key that names no tenant, and for an environment without a connection", async () => {
    const unknown = await ping(["--tenant", "nobody", "--env", "test"], stub.url);
    expect(unknown).toEqual({ code: 1, stdout: "", stderr: "amadeus:ping: no tenant has the key nobody.\n" });

    const live = await ping(["--tenant", "alpha", "--env", "live"], stub.url);
    expect(live.code).toBe(1);
    expect(live.stderr).toMatch(
      /connection failed after [0-9]+ ms: SUPPLIER_NOT_CONFIGURED \(no_connection\)$/m,
    );
    expect(stub.requests()).toEqual([]);
  });
});
