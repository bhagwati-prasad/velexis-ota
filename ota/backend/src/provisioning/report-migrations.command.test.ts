// Unit tests of `tenants:report-migrations` (OBE-007 step 1): the fan-out report becomes one `tenant.migrated` or
// `tenant.migration_failed` event per schema, with `jobId: null`, built from fakes of the platform's tenants, the
// schemas' ledgers and the `platform-tenant-events` queue. The command's real wiring (PostgreSQL, BullMQ, Redis) is
// exercised by test/integration/dev/dev-seed.int.test.ts.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateJob, type TenantMigrationRecord } from "@velexis/api-types/jobs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  failedSchemaPayload,
  parseFanOutReport,
  publishReport,
  redisFailureReason,
  reportPathOf,
  reportRequestId,
  ReportFileError,
  ReportPublishError,
  runReportMigrations,
  type ReportEventQueue,
  type ReportSources,
} from "./report-migrations.command";

const CHECKSUM_1 = "a".repeat(64);
const CHECKSUM_2 = "b".repeat(64);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = new Date("2026-10-19T08:00:00.000Z");
/** A value PostgreSQL's message quotes: it must never reach an event or the output. */
const QUOTED_VALUE = "private-value-7f3a";

/** A report as `migrate.js tenants --report` writes it: three schemas migrated, one failed, one skipped. */
function fanOutReport(): Record<string, unknown> {
  const applied = (schema: string, files: unknown[]) => ({ schema, files });
  return {
    target: "0002_add_mvp_tenant_deltas",
    total: 5,
    applied: [
      applied("tenant_alpha", [
        {
          set: "tenant",
          schema: "tenant_alpha",
          file: "0002_add_mvp_tenant_deltas.sql",
          id: "0002_add_mvp_tenant_deltas",
          kind: "numbered",
          phase: "expand",
          status: "applied",
          checksum: CHECKSUM_2,
          transaction: true,
          executionMs: 41,
        },
      ]),
      applied("tenant_beta", []),
      applied("tenant_gamma", []),
    ],
    failed: [
      {
        schema: "tenant_delta",
        file: "0002_add_mvp_tenant_deltas.sql",
        error: {
          message: `invalid input syntax for type integer: "${QUOTED_VALUE}"`,
          code: "22P02",
          line: 12,
        },
        exitCode: 1,
      },
    ],
    skipped: [
      { schema: "tenant_newbie", reason: "the tenant is provisioning and its schema does not exist yet" },
    ],
  };
}

const TENANT_IDS: Readonly<Record<string, string>> = {
  tenant_alpha: "ten_01JA0000000000000000000001",
  tenant_beta: "ten_01JA0000000000000000000002",
  tenant_gamma: "ten_01JA0000000000000000000003",
  tenant_delta: "ten_01JA0000000000000000000004",
};

function ledger(upTo: 1 | 2): TenantMigrationRecord[] {
  const rows: TenantMigrationRecord[] = [
    {
      version: "0001_baseline",
      checksum: CHECKSUM_1,
      phase: "expand",
      appliedAt: "2026-10-01T10:00:00.000Z",
      durationMs: 812,
    },
  ];
  if (upTo === 2) {
    rows.push({
      version: "0002_add_mvp_tenant_deltas",
      checksum: CHECKSUM_2,
      phase: "expand",
      appliedAt: "2026-10-19T07:59:00.000Z",
      durationMs: 41,
    });
  }
  return rows;
}

function fakeSources(
  ids: Readonly<Record<string, string>> = TENANT_IDS,
  withoutLedger: readonly string[] = [],
): ReportSources & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    tenantIdOfSchema: (schema) => Promise.resolve(ids[schema] ?? null),
    ledgerOf: (schema) => {
      reads.push(schema);
      return Promise.resolve(withoutLedger.includes(schema) ? null : ledger(2));
    },
  };
}

interface Added {
  readonly name: string;
  readonly data: unknown;
  readonly options: unknown;
}

function fakeQueue(refuseAt?: number): ReportEventQueue & { added: Added[] } {
  const added: Added[] = [];
  return {
    added,
    add(name, data, options) {
      if (refuseAt !== undefined && added.length === refuseAt) {
        return Promise.reject(
          Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), { code: "ECONNREFUSED" }),
        );
      }
      added.push({ name, data, options });
      return Promise.resolve({ id: String(added.length) });
    },
  };
}

const clock = { now: () => NOW };

function buffer(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = [];
  return { write: (chunk) => void chunks.push(chunk), text: () => chunks.join("") };
}

let folder: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "ota-report-migrations-"));
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("publishReport", () => {
  it("publishes 4 valid events with jobId null for 3 applied and 1 failed schema [OBE-007 AC1]", async () => {
    const report = parseFanOutReport(JSON.stringify(fanOutReport()));
    const queue = fakeQueue();

    const outcome = await publishReport(report, {
      sources: fakeSources(),
      queue,
      clock,
      requestId: `deploy-${SHA}`,
    });

    expect(queue.added.map((job) => job.name)).toEqual([
      "tenant.migrated",
      "tenant.migrated",
      "tenant.migrated",
      "tenant.migration_failed",
    ]);
    expect(outcome.events).toHaveLength(4);
    expect(outcome.schemas).toEqual(["tenant_alpha", "tenant_beta", "tenant_gamma", "tenant_delta"]);
    expect(outcome.unknownSchemas).toEqual([]);
    expect(outcome.missingLedgers).toEqual([]);
    for (const job of queue.added) {
      // Every event is a valid message of platform-tenant-events, and no BullMQ id is forced on it.
      expect(() => validateJob(job.name, job.data)).not.toThrow();
      expect(job.data).toMatchObject({
        v: 1,
        jobId: null,
        requestId: `deploy-${SHA}`,
        requestedAt: NOW.toISOString(),
      });
      expect(job.options).toBeUndefined();
    }
    expect(queue.added.map((job) => (job.data as { tenantId: string }).tenantId)).toEqual([
      TENANT_IDS["tenant_alpha"],
      TENANT_IDS["tenant_beta"],
      TENANT_IDS["tenant_gamma"],
      TENANT_IDS["tenant_delta"],
    ]);
    // Each tenant.migrated carries the schema's full ledger, also when this run applied nothing to it.
    for (const job of queue.added.slice(0, 3)) {
      expect((job.data as { payload: unknown }).payload).toEqual({
        schemaVersion: "0002_add_mvp_tenant_deltas",
        migrations: ledger(2),
      });
    }
    expect((queue.added[3]?.data as { payload: unknown }).payload).toEqual({
      version: "0002_add_mvp_tenant_deltas",
      error: {
        code: "MIGRATION_FAILED",
        message: expect.stringContaining("0002_add_mvp_tenant_deltas.sql") as unknown,
      },
    });
  });

  it("publishes the same 4 events again when it runs a second time with the same report [OBE-007 AC1]", async () => {
    const report = parseFanOutReport(JSON.stringify(fanOutReport()));
    const first = fakeQueue();
    const second = fakeQueue();

    await publishReport(report, { sources: fakeSources(), queue: first, clock, requestId: `deploy-${SHA}` });
    await publishReport(report, { sources: fakeSources(), queue: second, clock, requestId: `deploy-${SHA}` });

    expect(second.added).toHaveLength(4);
    expect(second.added).toEqual(first.added);
  });

  it("never passes PostgreSQL's message of a failed schema on [OBE-007 AC1]", async () => {
    const queue = fakeQueue();

    await publishReport(parseFanOutReport(JSON.stringify(fanOutReport())), {
      sources: fakeSources(),
      queue,
      clock,
      requestId: "migrations-report-0123456789abcdef",
    });

    expect(JSON.stringify(queue.added)).not.toContain(QUOTED_VALUE);
    expect(JSON.stringify(queue.added)).not.toContain("invalid input syntax");
  });

  it("skips a schema whose tenant is gone and reads no ledger for it", async () => {
    const { tenant_beta: _gone, ...remaining } = TENANT_IDS;
    const sources = fakeSources(remaining);
    const queue = fakeQueue();

    const outcome = await publishReport(parseFanOutReport(JSON.stringify(fanOutReport())), {
      sources,
      queue,
      clock,
      requestId: `deploy-${SHA}`,
    });

    expect(outcome.unknownSchemas).toEqual(["tenant_beta"]);
    expect(outcome.schemas).toEqual(["tenant_alpha", "tenant_gamma", "tenant_delta"]);
    expect(queue.added).toHaveLength(3);
    expect(sources.reads).toEqual(["tenant_alpha", "tenant_gamma"]);
  });

  it("skips an applied schema whose ledger is gone instead of sending another ledger for it", async () => {
    const queue = fakeQueue();

    const outcome = await publishReport(parseFanOutReport(JSON.stringify(fanOutReport())), {
      sources: fakeSources(TENANT_IDS, ["tenant_gamma"]),
      queue,
      clock,
      requestId: `deploy-${SHA}`,
    });

    expect(outcome.missingLedgers).toEqual(["tenant_gamma"]);
    expect(outcome.unknownSchemas).toEqual([]);
    expect(outcome.schemas).toEqual(["tenant_alpha", "tenant_beta", "tenant_delta"]);
    expect(queue.added.map((job) => (job.data as { tenantId: string }).tenantId)).toEqual([
      TENANT_IDS["tenant_alpha"],
      TENANT_IDS["tenant_beta"],
      TENANT_IDS["tenant_delta"],
    ]);
  });

  it("adds nothing when an event cannot be built, and reports how many Redis took before it refused", async () => {
    const report = parseFanOutReport(JSON.stringify(fanOutReport()));
    const broken = fakeQueue();
    const failingLedger: ReportSources = {
      tenantIdOfSchema: (schema) => Promise.resolve(TENANT_IDS[schema] ?? null),
      ledgerOf: (schema) =>
        schema === "tenant_gamma"
          ? Promise.reject(new Error("relation does not exist"))
          : Promise.resolve(ledger(1)),
    };
    await expect(
      publishReport(report, { sources: failingLedger, queue: broken, clock, requestId: `deploy-${SHA}` }),
    ).rejects.toThrow("relation does not exist");
    expect(broken.added).toEqual([]);

    const refusing = fakeQueue(2);
    const refusal = await publishReport(report, {
      sources: fakeSources(),
      queue: refusing,
      clock,
      requestId: `deploy-${SHA}`,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ReportPublishError);
    expect(refusal).toMatchObject({ published: 2, total: 4 });
    expect(redisFailureReason((refusal as ReportPublishError).cause)).toBe("ECONNREFUSED");
  });
});

describe("failedSchemaPayload", () => {
  const failure = (overrides: Record<string, unknown>) =>
    parseFanOutReport(
      JSON.stringify({
        applied: [],
        failed: [{ schema: "tenant_delta", file: null, error: { message: "x" }, exitCode: 1, ...overrides }],
      }),
    ).failed[0]!;

  it("names an edited applied file a checksum mismatch", () => {
    expect(failedSchemaPayload(failure({ file: "0001_baseline.sql", exitCode: 2 }))).toMatchObject({
      version: "0001_baseline",
      error: { code: "CHECKSUM_MISMATCH" },
    });
  });

  it("maps the transient SQLSTATEs as the worker's classifier does", () => {
    expect(failedSchemaPayload(failure({ error: { message: "x", code: "55P03" } }))).toMatchObject({
      version: null,
      error: { code: "LOCK_TIMEOUT" },
    });
    expect(failedSchemaPayload(failure({ error: { message: "x", code: "40P01" } })).error.code).toBe(
      "DEADLOCK",
    );
    expect(failedSchemaPayload(failure({ error: { message: "x", code: "08006" } })).error.code).toBe(
      "CONNECTION_LOST",
    );
  });

  it("names a failing file with its SQLSTATE and line, and anything else by its SQLSTATE or as unexpected", () => {
    const failed = failedSchemaPayload(
      failure({ file: "0003_add_x.sql", error: { message: "x", code: "42P01", line: 7 } }),
    );
    expect(failed.version).toBe("0003_add_x");
    expect(failed.error.code).toBe("MIGRATION_FAILED");
    expect(failed.error.message).toContain(
      "0003_add_x.sql failed in the deploy fan-out (SQLSTATE 42P01, line 7)",
    );
    expect(failedSchemaPayload(failure({ error: { message: "x", code: "42501" } })).error.code).toBe("42501");
    expect(failedSchemaPayload(failure({})).error.code).toBe("UNEXPECTED_ERROR");
  });
});

describe("parseFanOutReport", () => {
  it("refuses what is not a fan-out report, without quoting it", () => {
    for (const text of [
      "not json",
      JSON.stringify({ applied: [] }),
      JSON.stringify({ applied: [{ schema: "public" }], failed: [] }),
      JSON.stringify({
        applied: [],
        failed: [{ schema: "tenant_x", file: "../../etc/passwd", error: {}, exitCode: 1 }],
      }),
      JSON.stringify({
        applied: [],
        failed: [{ schema: "tenant_x", file: null, error: { code: "nope" }, exitCode: 1 }],
      }),
    ]) {
      expect(() => parseFanOutReport(text)).toThrow(ReportFileError);
    }
    const error = (() => {
      try {
        parseFanOutReport(`{"applied": "${QUOTED_VALUE}", "failed": []}`);
        return undefined;
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error).toBeInstanceOf(ReportFileError);
    expect(error?.message).not.toContain(QUOTED_VALUE);
  });
});

describe("reportRequestId and reportPathOf", () => {
  it("ties the events of the deploy's report to its release, and any other report to its content", () => {
    expect(reportRequestId(`/var/lib/velexis/migrate-${SHA}.json`, "{}")).toBe(`deploy-${SHA}`);
    const other = reportRequestId("/tmp/report.json", "{}");
    expect(other).toMatch(/^migrations-report-[0-9a-f]{16}$/);
    expect(reportRequestId("/tmp/report.json", "{}")).toBe(other);
    expect(reportRequestId("/tmp/report.json", '{"applied":[]}')).not.toBe(other);
  });

  it("accepts exactly --report <file> or --report=<file>", () => {
    expect(reportPathOf(["--report", "/r.json"])).toBe("/r.json");
    expect(reportPathOf(["--report=/r.json"])).toBe("/r.json");
    expect(reportPathOf([])).toBeUndefined();
    expect(reportPathOf(["--report"])).toBeUndefined();
    expect(reportPathOf(["/r.json"])).toBeUndefined();
    expect(reportPathOf(["--report", "/r.json", "--extra"])).toBeUndefined();
  });
});

describe("runReportMigrations", () => {
  async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const stdout = buffer();
    const stderr = buffer();
    // No service is reachable: every case below must end before the command connects.
    const env = {
      APP_ENV: "test",
      DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:9/none",
      REDIS_URL: "redis://:nothing@127.0.0.1:9/0",
    };
    const code = await runReportMigrations(args, { stdout, stderr, env });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("exits 1 on a missing or unreadable report [OBE-007 AC1]", async () => {
    const missing = await run(["--report", join(folder, "missing.json")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("cannot be read (ENOENT)");

    const garbage = join(folder, "garbage.json");
    await writeFile(garbage, `{"applied": "${QUOTED_VALUE}"`);
    const unreadable = await run([`--report=${garbage}`]);
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toContain("it is not JSON");
    expect(unreadable.stderr).not.toContain(QUOTED_VALUE);
  });

  it("exits 1 with the usage without --report", async () => {
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: node dist/cli.js tenants:report-migrations --report <file>");
  });

  it("exits 0 without connecting when the report names no migrated or failed schema", async () => {
    const empty = join(folder, `migrate-${SHA}.json`);
    await writeFile(
      empty,
      JSON.stringify({ target: "0002_x", total: 1, applied: [], failed: [], skipped: [] }),
    );
    const result = await run(["--report", empty]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("nothing to publish");
  });
});
