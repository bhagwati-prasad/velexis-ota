// The arrangements of the platform admin's M5 journeys in support/seed.ts (PAD-015) without a stack: `pg` is a fake
// client that records its queries and answers from a script, and the platform API caller of `moveOtaToNewPlan` is a
// fake too. The journeys run them against the real database and API (specs/admin-settlements.e2e.ts,
// admin-live-office.e2e.ts, admin-domains.e2e.ts, admin-amadeus-pool.e2e.ts); these tests pin what they send. So do
// the tests of the arrangements the specs once wrote themselves (FIX-W45-PLATFORM: admin-step-up.e2e.ts,
// ota-admin/roles.e2e.ts and ota-admin/live-environment.e2e.ts), with the role each is written as.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCall } from "../support/fixtures";
import {
  AGED_MFA_MINUTES,
  ageAdminMfa,
  applyOwnLiveCredentials,
  holdVelexisLivePool,
  insertDraftSettlement,
  insertQueuedProvisioningJob,
  moveOtaToNewPlan,
  restoreVelexisLivePool,
  setTenantBillingNotice,
  setTenantLive,
  VELEXIS_LIVE_POOL_LOCK,
  type DraftSettlementInput,
  type QueuedProvisioningJobInput,
} from "../support/seed";
import { AMADEUS_STUB_URL } from "../support/stack";
import type { SignedInOwner } from "../support/tenants";

/** One query a fake client received. */
interface Query {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** What a fake client answers to `text`: rows and a row count. */
type Answer = { readonly rows?: readonly Record<string, unknown>[]; readonly rowCount?: number };

const { clients, script } = vi.hoisted(() => {
  /** Every fake client made, in order, with its queries. */
  const clients: Array<{ queries: Query[]; ended: boolean; connectionString: string }> = [];
  /** The answer to each query (`BEGIN`, `COMMIT` and `ROLLBACK` answer nothing unless scripted). */
  const script: { answer: (text: string, values: readonly unknown[]) => Answer } = {
    answer: () => ({ rows: [], rowCount: 0 }),
  };
  return { clients, script };
});

vi.mock("pg", () => {
  class Client {
    private readonly record: { queries: Query[]; ended: boolean; connectionString: string };

    constructor(options: { connectionString: string }) {
      this.record = { queries: [], ended: false, connectionString: options.connectionString };
      clients.push(this.record);
    }

    async connect(): Promise<void> {}

    async query(text: string, values: readonly unknown[] = []): Promise<Answer> {
      this.record.queries.push({ text, values });
      return await Promise.resolve(script.answer(text, values));
    }

    async end(): Promise<void> {
      this.record.ended = true;
    }
  }
  return { default: { Client } };
});

/** The SQL of every query, whitespace collapsed, in order, of all clients. */
const statements = (): string[] =>
  clients.flatMap((client) => client.queries.map((query) => query.text.replace(/\s+/g, " ").trim()));

beforeEach(() => {
  // The stack the global setup would have started (support/seed.ts `stack()` reads it in a test worker).
  vi.stubEnv(
    "TEST_DATABASE_ADMIN_URL",
    "postgres://velexis_test_admin:dev_test_admin@127.0.0.1:5432/postgres",
  );
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379/0");
  vi.stubEnv("SMTP_URL", "smtp://127.0.0.1:1025");
  vi.stubEnv("MAILPIT_API_URL", "http://127.0.0.1:8025");
  vi.stubEnv("E2E_STRIPE", "false");
  vi.stubEnv("E2E_DATABASE_NAME", "velexis_e2e_unit_000000");
  clients.length = 0;
  script.answer = () => ({ rows: [], rowCount: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("moveOtaToNewPlan", () => {
  it("creates the plan as the admin and moves the OTA's manual trial to it with If-Match and the reason [PAD-015 AC1]", async () => {
    const calls: ApiCall[] = [];
    const answers: Record<string, unknown> = {
      adminCreatePlan: { code: "e2eadom_x" },
      getSubscription: { id: "sub_1" },
      adminGetSubscription: { subscription: { id: "sub_1", version: 3 } },
      adminUpdateManualSubscription: { id: "sub_1", planCode: "e2eadom_x", version: 4 },
    };
    const call = async <T>(apiCall: ApiCall): Promise<T> => {
      calls.push(apiCall);
      return await Promise.resolve(answers[apiCall.operation] as T);
    };
    const owner: SignedInOwner = {
      account: { email: "o@example.com", password: "p", fullName: "O", endUserIp: "198.18.0.2" },
      accessToken: "owner-token",
    };
    const plan = { code: "e2eadom_x", name: "E2E" } as Parameters<typeof moveOtaToNewPlan>[1]["plan"];

    const updated = await moveOtaToNewPlan(call, {
      admin: { endUserIp: "198.18.0.1", accessToken: "admin-token" },
      owner,
      tenantId: "ten_1",
      plan,
      reason: "The journey needs a plan of its own.",
    });

    expect(updated).toEqual(answers["adminUpdateManualSubscription"]);
    expect(calls.map((apiCall) => `${apiCall.operation} ${apiCall.method} ${apiCall.path}`)).toEqual([
      "adminCreatePlan POST /v1/admin/plans",
      "getSubscription GET /v1/tenants/ten_1/subscription",
      "adminGetSubscription GET /v1/admin/subscriptions/sub_1",
      "adminUpdateManualSubscription PATCH /v1/admin/subscriptions/sub_1",
    ]);
    expect(calls[0]).toMatchObject({ accessToken: "admin-token", endUserIp: "198.18.0.1", body: plan });
    expect(calls[1]).toMatchObject({ accessToken: "owner-token", endUserIp: "198.18.0.2" });
    expect(calls[3]).toMatchObject({
      accessToken: "admin-token",
      headers: { "If-Match": '"3"' },
      body: { planCode: "e2eadom_x", reason: "The journey needs a plan of its own." },
    });
    // Without `status`, the trial keeps its status.
    expect(calls[3]?.body).toEqual({ planCode: "e2eadom_x", reason: "The journey needs a plan of its own." });
  });

  it("moves the trial to the plan and makes it active in the same edit when a status is given [OFE-022 AC1]", async () => {
    // support/ota.ts `meetLivePreconditions` (FIX-W49-PLATFORM): `active` marks the manual subscription paid outside
    // Stripe, which goLive accepts.
    const calls: ApiCall[] = [];
    const call = async <T>(apiCall: ApiCall): Promise<T> => {
      calls.push(apiCall);
      const answers: Record<string, unknown> = {
        getSubscription: { id: "sub_2" },
        adminGetSubscription: { subscription: { id: "sub_2", version: 1 } },
        adminUpdateManualSubscription: { id: "sub_2", status: "active", version: 2 },
      };
      return await Promise.resolve(answers[apiCall.operation] as T);
    };
    const owner: SignedInOwner = {
      account: { email: "o@example.com", password: "p", fullName: "O", endUserIp: "198.18.0.2" },
      accessToken: "owner-token",
    };

    await moveOtaToNewPlan(call, {
      admin: { endUserIp: "198.18.0.1", accessToken: "admin-token" },
      owner,
      tenantId: "ten_2",
      plan: { code: "e2elive_x", name: "E2E" } as Parameters<typeof moveOtaToNewPlan>[1]["plan"],
      reason: "The journey's OTA goes live.",
      status: "active",
    });

    expect(calls.at(-1)).toMatchObject({
      operation: "adminUpdateManualSubscription",
      method: "PATCH",
      path: "/v1/admin/subscriptions/sub_2",
      accessToken: "admin-token",
      headers: { "If-Match": '"1"' },
    });
    expect(calls.at(-1)?.body).toEqual({
      planCode: "e2elive_x",
      status: "active",
      reason: "The journey's OTA goes live.",
    });
  });
});

describe("holdVelexisLivePool", () => {
  it("asks for the live pool's advisory lock until it is free, and releases it once [PAD-015 AC1]", async () => {
    let tries = 0;
    script.answer = (text) => {
      if (text.includes("pg_try_advisory_lock")) {
        tries += 1;
        return { rows: [{ held: tries >= 2 }] };
      }
      return { rows: [] };
    };
    const hold = await holdVelexisLivePool(10_000);
    expect(tries).toBe(2);
    const [client] = clients;
    expect(client?.connectionString).toContain("velexis_platform_app");
    expect(client?.connectionString).toContain("velexis_e2e_unit_000000");
    expect(client?.queries.map((query) => query.values)).toEqual([
      [VELEXIS_LIVE_POOL_LOCK],
      [VELEXIS_LIVE_POOL_LOCK],
    ]);
    expect(client?.ended).toBe(false);

    await hold.release();
    await hold.release();
    expect(client?.queries.at(-1)?.text).toContain("pg_advisory_unlock(hashtextextended($1, 0))");
    expect(client?.queries.filter((query) => query.text.includes("pg_advisory_unlock"))).toHaveLength(1);
    expect(client?.ended).toBe(true);
  });

  it("fails with the reason when another journey keeps the pool, and closes its connection [PAD-015 AC1]", async () => {
    script.answer = () => ({ rows: [{ held: false }] });
    await expect(holdVelexisLivePool(0)).rejects.toThrow(
      /^the Velexis live pool is still held by another journey after 0 s/,
    );
    expect(clients[0]?.ended).toBe(true);
  });
});

describe("restoreVelexisLivePool", () => {
  it("deletes the journey's offices, and the live account it created after the OTA's connection on it [PAD-015 AC1]", async () => {
    script.answer = () => ({ rowCount: 1 });
    const deleted = await restoreVelexisLivePool({
      accountId: "ama_1",
      createdAccount: true,
      officeRowIds: ["amo_1"],
      tenantId: "ten_1",
    });
    expect(deleted).toBe(3);
    expect(statements()).toEqual([
      "BEGIN",
      "DELETE FROM platform.supplier_connections WHERE tenant_id = $1 AND provider = 'amadeus' AND environment = 'live' AND amadeus_account_id = $2",
      "DELETE FROM platform.amadeus_offices WHERE amadeus_account_id = $1 AND id = ANY($2::text[])",
      "DELETE FROM platform.amadeus_accounts WHERE id = $1 AND environment = 'live'",
      "COMMIT",
    ]);
    expect(clients[0]?.queries[2]?.values).toEqual(["ama_1", ["amo_1"]]);
  });

  it("leaves another journey's account and the OTA's connection alone, deleting only its offices [PAD-015 AC1]", async () => {
    script.answer = () => ({ rowCount: 1 });
    await restoreVelexisLivePool({
      accountId: "ama_2",
      createdAccount: false,
      officeRowIds: ["amo_2"],
      tenantId: "ten_2",
    });
    expect(statements()).toEqual([
      "BEGIN",
      "DELETE FROM platform.amadeus_offices WHERE amadeus_account_id = $1 AND id = ANY($2::text[])",
      "COMMIT",
    ]);
  });
});

describe("insertDraftSettlement", () => {
  it("writes the draft of the test environment and each of its lines in one transaction [PAD-015 AC1]", async () => {
    const periodStart = new Date(Date.UTC(2026, 0, 1));
    const input: DraftSettlementInput = {
      id: "stl_01JC7T1V5X9Z3B7D1F5H9K3N7Q",
      tenantId: "ten_1",
      currency: "EUR",
      periodStart,
      periodEnd: new Date(Date.UTC(2026, 1, 1)),
      feeBps: 150,
      totals: {
        gross: "100.00",
        refunds: "0.00",
        disputes: "0.00",
        stripeFees: "1.50",
        velexisFees: "1.50",
        adjustments: "0.00",
        net: "97.00",
      },
      lines: [
        {
          id: "sln_1",
          lineType: "charge",
          amount: "100.00",
          stripeFee: "1.50",
          balanceTransactionId: "txn_e2e1",
          paymentIntentId: "pi_e2e1",
          description: "Booking payment",
          occurredAt: new Date(Date.UTC(2026, 0, 5)),
        },
      ],
    };
    await insertDraftSettlement(input);
    const sql = statements();
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toMatch(
      /^INSERT INTO platform\.settlements \(.*\) VALUES \(\$1, \$2, 'test', \$3, \$4, \$5, 'draft',/,
    );
    expect(sql[2]).toMatch(/^INSERT INTO platform\.settlement_lines /);
    expect(sql[3]).toBe("COMMIT");
    const [, settlement, line] = clients[0]?.queries ?? [];
    expect(settlement?.values).toEqual([
      input.id,
      "ten_1",
      "EUR",
      periodStart,
      input.periodEnd,
      "100.00",
      "0.00",
      "0.00",
      "1.50",
      "1.50",
      "0.00",
      "97.00",
      150,
      1,
    ]);
    expect(line?.values.slice(0, 6)).toEqual(["sln_1", input.id, "ten_1", "charge", "txn_e2e1", "pi_e2e1"]);
  });

  it("rolls back and fails when a row is refused [PAD-015 AC1]", async () => {
    script.answer = (text) => {
      if (text.includes("settlement_lines")) {
        throw new Error("duplicate key value violates unique constraint");
      }
      return { rowCount: 1 };
    };
    await expect(
      insertDraftSettlement({
        id: "stl_x",
        tenantId: "ten_1",
        currency: "EUR",
        periodStart: new Date(0),
        periodEnd: new Date(1),
        feeBps: 0,
        totals: {
          gross: "1.00",
          refunds: "0.00",
          disputes: "0.00",
          stripeFees: "0.00",
          velexisFees: "0.00",
          adjustments: "0.00",
          net: "1.00",
        },
        lines: [
          {
            id: "sln_x",
            lineType: "charge",
            amount: "1.00",
            stripeFee: "0.00",
            balanceTransactionId: "txn_e2ex",
            paymentIntentId: "pi_e2ex",
            description: "x",
            occurredAt: new Date(0),
          },
        ],
      }),
    ).rejects.toThrow(/duplicate key/);
    expect(statements().at(-1)).toBe("ROLLBACK");
  });
});

describe("applyOwnLiveCredentials", () => {
  const sealed = { ciphertext: Buffer.from("sealed"), kekId: "kek-1" };

  it("switches the active Velexis live connection to the OTA's own credentials and sets its offices releasing [PAD-015 AC1]", async () => {
    script.answer = (text) => {
      if (text.startsWith("SELECT")) {
        return {
          rows: [
            {
              id: "sc_1",
              credential_source: "velexis",
              amadeus_account_id: "ama_live",
              status: "active",
              version: 2,
            },
          ],
        };
      }
      if (text.includes("UPDATE platform.supplier_connections")) {
        return { rowCount: 1 };
      }
      if (text.includes("UPDATE platform.amadeus_offices")) {
        return { rows: [{ id: "amo_1" }], rowCount: 1 };
      }
      return { rowCount: 0 };
    };
    const seal = vi.fn(async () => await Promise.resolve(sealed as never));

    const applied = await applyOwnLiveCredentials({ tenantId: "ten_1", officeId: "E2LABC123", seal });

    expect(applied).toEqual({
      connectionId: "sc_1",
      accountId: "ama_live",
      releasingOfficeRowIds: ["amo_1"],
    });
    // The secret is sealed for the connection's own row (its associated data), before the transaction.
    expect(seal).toHaveBeenCalledWith("sc_1");
    expect(statements().slice(1)).toEqual([
      "BEGIN",
      expect.stringMatching(
        /^UPDATE platform\.supplier_connections SET credential_source = 'tenant', amadeus_account_id = NULL,/,
      ),
      expect.stringMatching(
        /^UPDATE platform\.amadeus_offices SET status = 'releasing', release_requested_at = now\(\),/,
      ),
      "COMMIT",
    ]);
    const update = clients[1]?.queries[1];
    expect(update?.text).toContain("WHERE id = $1 AND version = $2 AND credential_source = 'velexis'");
    expect(update?.values.slice(0, 3)).toEqual(["sc_1", 2, AMADEUS_STUB_URL]);
    expect(update?.values[3]).toMatch(/^e2e-own-live-[0-9a-f]{12}$/);
    expect(update?.values.slice(4)).toEqual([sealed.ciphertext, "kek-1", "E2LABC123"]);
    expect(clients[1]?.queries[2]?.values).toEqual(["ama_live", "ten_1"]);
  });

  it("refuses an office id that is no Amadeus office id, and a connection that is not on the Velexis account [PAD-015 AC1]", async () => {
    const seal = vi.fn();
    await expect(applyOwnLiveCredentials({ tenantId: "ten_1", officeId: "e2l", seal })).rejects.toThrow(
      TypeError,
    );
    script.answer = () => ({
      rows: [
        { id: "sc_1", credential_source: "tenant", amadeus_account_id: null, status: "active", version: 1 },
      ],
    });
    await expect(applyOwnLiveCredentials({ tenantId: "ten_1", officeId: "E2LABC123", seal })).rejects.toThrow(
      "the OTA ten_1 has no active live connection on the Velexis account to replace",
    );
    expect(seal).not.toHaveBeenCalled();
  });

  it("rolls back when the connection changed in between [PAD-015 AC1]", async () => {
    script.answer = (text) =>
      text.startsWith("SELECT")
        ? {
            rows: [
              {
                id: "sc_1",
                credential_source: "velexis",
                amadeus_account_id: "ama",
                status: "active",
                version: 1,
              },
            ],
          }
        : { rowCount: 0 };
    await expect(
      applyOwnLiveCredentials({
        tenantId: "ten_1",
        officeId: "E2LABC123",
        seal: async () => await Promise.resolve(sealed as never),
      }),
    ).rejects.toThrow(/changed while its credentials were applied/);
    expect(statements().at(-1)).toBe("ROLLBACK");
  });
});

describe("ageAdminMfa", () => {
  it("moves the TOTP verification of the account's open admin sessions back, 20 minutes by default [PAD-015 AC1]", async () => {
    script.answer = () => ({ rowCount: 2 });
    expect(await ageAdminMfa("Admin@Example.com")).toBe(2);
    expect(AGED_MFA_MINUTES).toBeGreaterThan(15);
    const [query] = clients[0]?.queries ?? [];
    expect(query?.values).toEqual(["Admin@Example.com", AGED_MFA_MINUTES]);
    expect(query?.text).toContain("s.audience = 'platform_admin'");
    expect(query?.text).toContain("s.revoked_at IS NULL");
  });

  it("fails when the account has no open admin session [PAD-015 AC1]", async () => {
    script.answer = () => ({ rowCount: 0 });
    await expect(ageAdminMfa("nobody@example.com", 30)).rejects.toThrow(
      "nobody@example.com has no open platform admin session with a TOTP verification",
    );
  });
});

describe("insertQueuedProvisioningJob", () => {
  const input: QueuedProvisioningJobInput = {
    id: "job_01JC7T1V5X9Z3B7D1F5H9K3N7Q",
    tenantId: "ten_1",
    kind: "migrate",
    attempt: 1,
    dueInSeconds: 86_400,
    error: "ATTEMPT_LOST: the attempt's message was lost",
  };

  it("writes a queued job at its dispatch step with the lost attempt, due after its backoff, as the platform API's own role [FIX-W45-PLATFORM AC4]", async () => {
    script.answer = () => ({ rowCount: 1 });
    await insertQueuedProvisioningJob(input);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.connectionString).toContain("velexis_platform_app");
    expect(clients[0]?.ended).toBe(true);
    const sql = statements();
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(
      /^INSERT INTO platform\.provisioning_jobs \(id, tenant_id, kind, status, step, payload, attempt, scheduled_at, started_at, error\) VALUES \(\$1, \$2, \$3, 'queued', 'dispatch', '\{\}'::jsonb, \$4, now\(\) \+ make_interval\(secs => \$5::int\), now\(\), \$6\)$/,
    );
    expect(clients[0]?.queries[0]?.values).toEqual([
      input.id,
      "ten_1",
      "migrate",
      1,
      86_400,
      "ATTEMPT_LOST: the attempt's message was lost",
    ]);
  });

  it("refuses an attempt below 1 and a backoff that is not whole seconds, without a connection [FIX-W45-PLATFORM AC4]", async () => {
    await expect(insertQueuedProvisioningJob({ ...input, attempt: 0 })).rejects.toThrow(
      "not an attempt number: 0",
    );
    await expect(insertQueuedProvisioningJob({ ...input, dueInSeconds: 0.5 })).rejects.toThrow(
      "not a backoff in whole seconds: 0.5",
    );
    expect(clients).toHaveLength(0);
  });
});

describe("setTenantLive", () => {
  it("makes the active test OTA live with the next version, as the platform API's own role [FIX-W45-PLATFORM AC4] [FIX-W46-PLATFORM AC1]", async () => {
    script.answer = () => ({ rowCount: 1 });
    await setTenantLive("ten_1");
    expect(clients).toHaveLength(1);
    // velexis_platform_app, the role of every other helper here (lead decision (11a)); never the migrator any more.
    expect(clients[0]?.connectionString).toContain("velexis_platform_app");
    expect(clients[0]?.connectionString).not.toContain("velexis_migrator");
    expect(clients[0]?.connectionString).toContain("velexis_e2e_unit_000000");
    expect(clients[0]?.ended).toBe(true);
    expect(statements()).toEqual([
      "UPDATE platform.tenants SET storefront_environment = 'live', live_enabled_at = now(), version = version + 1, " +
        "updated_at = now() WHERE id = $1 AND status = 'active' AND storefront_environment = 'test'",
    ]);
    expect(clients[0]?.queries[0]?.values).toEqual(["ten_1"]);
  });

  it("fails when no active test OTA was changed [FIX-W45-PLATFORM AC4]", async () => {
    script.answer = () => ({ rowCount: 0 });
    await expect(setTenantLive("ten_1")).rejects.toThrow("the OTA ten_1 is not an active test OTA");
    expect(clients[0]?.ended).toBe(true);
  });
});

describe("setTenantBillingNotice", () => {
  it("sets or clears the active OTA's billing notice with the next version, as the platform API's own role [FIX-W45-PLATFORM AC4] [FIX-W46-PLATFORM AC1]", async () => {
    script.answer = () => ({ rowCount: 1 });
    await setTenantBillingNotice("ten_1", "past_due");
    await setTenantBillingNotice("ten_1", null);
    expect(clients.map((client) => client.connectionString.includes("velexis_platform_app"))).toEqual([
      true,
      true,
    ]);
    expect(clients.some((client) => client.connectionString.includes("velexis_migrator"))).toBe(false);
    expect(clients.every((client) => client.ended)).toBe(true);
    expect(statements()).toEqual([
      "UPDATE platform.tenants SET billing_notice = $2, version = version + 1, updated_at = now() " +
        "WHERE id = $1 AND status = 'active'",
      "UPDATE platform.tenants SET billing_notice = $2, version = version + 1, updated_at = now() " +
        "WHERE id = $1 AND status = 'active'",
    ]);
    expect(clients.map((client) => client.queries[0]?.values)).toEqual([
      ["ten_1", "past_due"],
      ["ten_1", null],
    ]);
  });

  it("fails when the OTA is not active [FIX-W45-PLATFORM AC4]", async () => {
    script.answer = () => ({ rowCount: 0 });
    await expect(setTenantBillingNotice("ten_1", "trial_ending")).rejects.toThrow(
      "the OTA ten_1 is not an active OTA",
    );
    expect(clients[0]?.ended).toBe(true);
  });
});
