import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  BULLMQ_PREFIX,
  INVALIDATION_CHANNEL,
  INVALIDATION_CONTRACT_VERSION,
  INVALIDATION_EVENT_SCHEMA,
  INVALIDATION_EVENT_SCHEMAS,
  INVALIDATION_TYPES,
  JOB_CONTRACT_VERSION,
  MessageValidationError,
  OTA_PROVISIONING_STEPS,
  OTA_QUEUES,
  OTA_TENANT_OPS,
  PLATFORM_QUEUES,
  PLATFORM_TENANT_EVENTS,
  TENANT_EVENT_NAMES,
  TENANT_EVENT_SCHEMAS,
  TENANT_JOB_SCHEMAS,
  TENANT_OPS_JOB_NAMES,
  TENANT_OPS_JOB_SCHEMAS,
  TENANT_SUSPENSION_REASONS,
  bullmqJobId,
  isInvalidationType,
  isTenantJobName,
  parseBullmqJobId,
  tenantProvisionJobSchema,
  validateInvalidation,
  validateJob,
  type InvalidationEvent,
  type JsonSchema,
  type MessageValidationIssue,
  type TenantEvent,
  type TenantMigratedEvent,
  type TenantMigrateJob,
  type TenantOpsJob,
  type TenantProvisionedEvent,
  type TenantProvisionJob,
} from "./index.js";

// Tests of task PBE-004: the queue names and BullMQ job ids, the `tenant.*` messages of `ota-tenant-ops` and
// `platform-tenant-events`, the `vx:invalidate` events, their validators and the shared fixtures of
// @velexis/api-types/jobs (ADR-0009, PADR-0001, PADR-0016 item 3, platform/docs/architecture.md §5 and §6).

const PACKAGE_DIR = join(__dirname, "..", "..");
const FIXTURES_DIR = join(PACKAGE_DIR, "fixtures", "jobs");
const JOBS_DIR = __dirname;

/** The fixture files and the message each one holds. */
const FIXTURES = {
  "tenant-provision.json": "tenant.provision",
  "tenant-provisioned.json": "tenant.provisioned",
  "tenant-provision-failed.json": "tenant.provision_failed",
  "tenant-migrated-fanout.json": "tenant.migrated",
} as const;
type FixtureFile = keyof typeof FIXTURES;
const FIXTURE_FILES = Object.keys(FIXTURES) as FixtureFile[];

type Json = Record<string, unknown>;

function readFixture(file: FixtureFile): Json {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as Json;
}

/** The issues of a refused message, or a failure when the message was accepted. */
function issuesOf(run: () => unknown): MessageValidationIssue[] {
  try {
    run();
  } catch (error) {
    if (error instanceof MessageValidationError) {
      return [...error.issues];
    }
    throw error;
  }
  throw new Error("the message was accepted");
}

/** `path keyword` of each issue, for compact assertions. */
function pathsOf(issues: readonly MessageValidationIssue[]): string[] {
  return issues.map((issue) => `${issue.path} ${issue.keyword}`);
}

/** A fresh Ajv 2020 instance in strict mode with ajv-formats, as a consumer of the exported schemas sets it up. */
function consumerAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv;
}

const TENANT_ID = "ten_01M4T9E68084G7ZWYRD6Z1RV0W";
const JOB_ID = "job_01M4T9HVE0355QAKGD2AVSQWH2";
const ACCOUNT_ID = "acc_01M4T98PF0FK6SY9541SJ3EQHB";
const AMADEUS_ACCOUNT_ID = "ama_01M4DDJ8E0GP1XF3A7QYFR6F0D";
const CHECKSUM = "cfa4d48672d69c947e5e96c0906d2b55c0df213c9cb38b72f30824ff9ae048cc";

const envelope = {
  v: 1,
  jobId: JOB_ID,
  tenantId: TENANT_ID,
  requestedAt: "2026-10-13T09:30:00.000Z",
  requestId: "6f1c2b7e-0d4a-4c9e-8b3f-2a5d9e7c1b40",
} as const;

/** One valid message per name, besides the fixtures. */
const VALID_MESSAGES: ReadonlyArray<Json & { name: string }> = [
  { ...envelope, name: "tenant.provision", payload: {} },
  { ...envelope, name: "tenant.migrate", payload: {} },
  { ...envelope, name: "tenant.migrate", payload: { targetVersion: "0003_add_loyalty" } },
  ...TENANT_SUSPENSION_REASONS.map((reason) => ({
    ...envelope,
    name: "tenant.suspend",
    payload: { reason },
  })),
  { ...envelope, name: "tenant.resume", payload: {} },
  {
    ...envelope,
    name: "tenant.provisioned",
    payload: {
      schemaName: "tenant_acme",
      schemaVersion: "0002_add_loyalty",
      migrations: [
        {
          version: "0001_baseline",
          checksum: CHECKSUM,
          phase: "expand",
          appliedAt: "2026-10-13T09:30:03.871Z",
          durationMs: 412,
        },
        {
          version: "0002_add_loyalty",
          checksum: "0".repeat(64),
          phase: "migrate",
          appliedAt: "2026-10-13T09:30:03.902Z",
          durationMs: null,
        },
      ],
      steps: [],
    },
  },
  {
    ...envelope,
    name: "tenant.provision_failed",
    payload: {
      error: { code: "TENANT_NOT_PROVISIONING", message: "The tenant is not in status provisioning." },
      retryable: false,
      steps: [],
    },
  },
  {
    ...envelope,
    name: "tenant.migrated",
    payload: {
      schemaVersion: "0001_baseline",
      migrations: [
        {
          version: "0001_baseline",
          checksum: CHECKSUM,
          phase: "expand",
          appliedAt: "2026-10-13T09:30:03Z",
          durationMs: 0,
        },
      ],
    },
  },
  {
    ...envelope,
    name: "tenant.migration_failed",
    payload: {
      version: "0002_add_loyalty",
      error: { code: "CHECKSUM_MISMATCH", message: "0001_baseline changed since it was applied." },
      retryable: false,
    },
  },
  {
    ...envelope,
    name: "tenant.migration_failed",
    jobId: null,
    payload: { version: null, error: { code: "55P03", message: "lock timeout" } },
  },
  { ...envelope, name: "tenant.suspended", payload: {} },
  { ...envelope, name: "tenant.resumed", payload: {} },
];

// ---- Queues -------------------------------------------------------------------------------------------------

describe("@velexis/api-types/jobs queues", () => {
  it('returns job_01HZX-2 for bullmqJobId("job_01HZX", 2) [PBE-004 AC2]', () => {
    expect(bullmqJobId("job_01HZX", 2)).toBe("job_01HZX-2");
    expect(bullmqJobId(JOB_ID, 1)).toBe(`${JOB_ID}-1`);
    expect(bullmqJobId(JOB_ID, 5)).toBe(`${JOB_ID}-5`);
  });

  it("refuses a job id or an attempt that cannot form a BullMQ job id", () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => bullmqJobId(JOB_ID, attempt), String(attempt)).toThrow(/invalid attempt/);
    }
    // BullMQ refuses ":" in custom ids and integer-only ids; "-" would make the attempt ambiguous.
    for (const jobId of ["", "123", "job:01HZX", "job-01HZX", " job_01HZX", "job_01HZX\n"]) {
      expect(() => bullmqJobId(jobId, 1), JSON.stringify(jobId)).toThrow(TypeError);
    }
  });

  it("reads a BullMQ job id back into the job id and the attempt", () => {
    expect(parseBullmqJobId("job_01HZX-2")).toEqual({ jobId: "job_01HZX", attempt: 2 });
    expect(parseBullmqJobId(bullmqJobId(JOB_ID, 12))).toEqual({ jobId: JOB_ID, attempt: 12 });
    for (const id of ["1", "job_01HZX", "job_01HZX-0", "job_01HZX-02", "job-01HZX-2", "job_01HZX-2a", ""]) {
      expect(parseBullmqJobId(id), id).toBeNull();
    }
    expect(parseBullmqJobId(`job_x-${"9".repeat(20)}`)).toBeNull();
  });

  it("names the two cross-backend queues and the vx prefix of ADR-0009", () => {
    expect(OTA_TENANT_OPS).toBe("ota-tenant-ops");
    expect(PLATFORM_TENANT_EVENTS).toBe("platform-tenant-events");
    expect(BULLMQ_PREFIX).toBe("vx");
  });

  it("lists the eight queues of platform architecture §5 once each, by consumer", () => {
    // platform/docs/architecture.md §5, in the order of its table.
    const section5 = [
      "ota-tenant-ops",
      "platform-tenant-events",
      "platform-emails",
      "platform-stripe-events",
      "platform-domains",
      "platform-connections",
      "platform-settlements",
      "platform-maintenance",
    ];
    expect([...PLATFORM_QUEUES]).toEqual(section5.filter((name) => name.startsWith("platform-")));
    // The OTA plan appends its own queues to OTA_QUEUES (OBE-002); ota-tenant-ops stays first.
    expect(OTA_QUEUES[0]).toBe(OTA_TENANT_OPS);
    const all = [...PLATFORM_QUEUES, ...OTA_QUEUES];
    expect(new Set(all).size).toBe(all.length);
    expect(section5.filter((name) => !all.includes(name as (typeof all)[number]))).toEqual([]);
    // Each queue belongs to the backend whose worker consumes it (`<owner>-<topic>`, ADR-0009 item 4).
    expect(PLATFORM_QUEUES.every((name) => name.startsWith("platform-"))).toBe(true);
    expect(OTA_QUEUES.every((name) => name.startsWith("ota-"))).toBe(true);
    expect(Object.isFrozen(PLATFORM_QUEUES)).toBe(true);
    expect(Object.isFrozen(OTA_QUEUES)).toBe(true);
  });
});

// ---- Fixtures -----------------------------------------------------------------------------------------------

describe("@velexis/api-types/jobs fixtures", () => {
  it("are the four files of the task, published as @velexis/api-types/fixtures/jobs/*.json", () => {
    expect(readdirSync(FIXTURES_DIR).sort()).toEqual([...FIXTURE_FILES].sort());
    // Both backends' tests import them by package name (the package resolves itself through `exports`).
    const require = createRequire(__filename);
    for (const file of FIXTURE_FILES) {
      expect(require.resolve(`@velexis/api-types/fixtures/jobs/${file}`)).toBe(join(FIXTURES_DIR, file));
    }
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      files: string[];
      dependencies: Record<string, string>;
    };
    expect(manifest.files).toContain("fixtures");
    // validateJob runs in the backends, so Ajv is a runtime dependency with exact versions.
    expect(manifest.dependencies).toEqual({ ajv: "8.20.0", "ajv-formats": "3.0.1" });
  });

  it("every fixture validates with validateJob and with the exported schema [PBE-004 AC1]", () => {
    const ajv = consumerAjv();
    for (const file of FIXTURE_FILES) {
      const fixture = readFixture(file);
      expect(fixture["name"], file).toBe(FIXTURES[file]);
      expect(validateJob(FIXTURES[file], fixture), file).toBe(fixture);
      const validate = ajv.compile(TENANT_JOB_SCHEMAS[FIXTURES[file]]);
      expect(validate(fixture), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    // The fan-out report is the one fixture without a job.
    expect(readFixture("tenant-migrated-fanout.json")["jobId"]).toBeNull();
  });

  it("refuses every fixture with an extra clientSecret field [PBE-004 AC1]", () => {
    for (const file of FIXTURE_FILES) {
      const fixture = readFixture(file);
      const payload = fixture["payload"] as Json;
      expect(
        pathsOf(issuesOf(() => validateJob(FIXTURES[file], { ...fixture, clientSecret: "x" }))),
        file,
      ).toEqual(["/clientSecret additionalProperties"]);
      expect(
        pathsOf(
          issuesOf(() =>
            validateJob(FIXTURES[file], { ...fixture, payload: { ...payload, clientSecret: "x" } }),
          ),
        ),
        file,
      ).toEqual(["/payload/clientSecret additionalProperties"]);
    }
  });

  it("refuses every fixture without jobId [PBE-004 AC1]", () => {
    for (const file of FIXTURE_FILES) {
      const { jobId: _jobId, ...withoutJobId } = readFixture(file);
      expect(pathsOf(issuesOf(() => validateJob(FIXTURES[file], withoutJobId))), file).toEqual([
        "/jobId required",
      ]);
    }
  });

  it("allows a null jobId on the fan-out reports only", () => {
    for (const file of FIXTURE_FILES) {
      const fixture = { ...readFixture(file), jobId: null };
      const name = FIXTURES[file];
      if (name === "tenant.migrated") {
        expect(validateJob(name, fixture)).toBe(fixture);
      } else {
        expect(pathsOf(issuesOf(() => validateJob(name, fixture))), file).toEqual(["/jobId type"]);
      }
    }
  });
});

// ---- tenant.* messages --------------------------------------------------------------------------------------

describe("@velexis/api-types/jobs tenant.* messages", () => {
  it("defines every message of ADR-0009 item 3 on its queue, each with its schema", () => {
    expect([...TENANT_OPS_JOB_NAMES]).toEqual([
      "tenant.provision",
      "tenant.migrate",
      "tenant.suspend",
      "tenant.resume",
    ]);
    expect([...TENANT_EVENT_NAMES]).toEqual([
      "tenant.provisioned",
      "tenant.provision_failed",
      "tenant.migrated",
      "tenant.migration_failed",
      "tenant.suspended",
      "tenant.resumed",
    ]);
    expect(Object.keys(TENANT_OPS_JOB_SCHEMAS)).toEqual([...TENANT_OPS_JOB_NAMES]);
    expect(Object.keys(TENANT_EVENT_SCHEMAS)).toEqual([...TENANT_EVENT_NAMES]);
    expect(Object.keys(TENANT_JOB_SCHEMAS)).toEqual([...TENANT_OPS_JOB_NAMES, ...TENANT_EVENT_NAMES]);
    expect(TENANT_JOB_SCHEMAS["tenant.provision"]).toBe(tenantProvisionJobSchema);
    for (const name of Object.keys(TENANT_JOB_SCHEMAS)) {
      expect(isTenantJobName(name)).toBe(true);
    }
    for (const name of ["tenant.export", "constructor", "toString", "", 1, null]) {
      expect(isTenantJobName(name)).toBe(false);
    }
  });

  it("accepts a valid message of every name, also with a fresh Ajv on the exported schemas", () => {
    const ajv = consumerAjv();
    const compiled = new Map<string, ValidateFunction>();
    for (const message of VALID_MESSAGES) {
      expect(validateJob(message.name, message)).toBe(message);
      const schema = TENANT_JOB_SCHEMAS[message.name as keyof typeof TENANT_JOB_SCHEMAS];
      const validate = compiled.get(message.name) ?? ajv.compile(schema);
      compiled.set(message.name, validate);
      expect(validate(message), `${message.name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    expect([...compiled.keys()].sort()).toEqual(Object.keys(TENANT_JOB_SCHEMAS).sort());
  });

  it("closes every object of every message schema (additionalProperties: false) and freezes it", () => {
    const open: string[] = [];
    const walk = (schema: unknown, path: string): void => {
      if (Array.isArray(schema)) {
        schema.forEach((child, index) => walk(child, `${path}/${index}`));
      } else if (schema !== null && typeof schema === "object") {
        const record = schema as Json;
        const types = ([] as unknown[]).concat(record["type"]);
        if (types.includes("object") && record["additionalProperties"] !== false) {
          open.push(path);
        }
        for (const [key, child] of Object.entries(record)) {
          walk(child, `${path}/${key}`);
        }
      }
    };
    for (const [name, schema] of Object.entries(TENANT_JOB_SCHEMAS)) {
      walk(schema, name);
      expect(Object.isFrozen(schema), name).toBe(true);
      expect((schema["properties"] as Json)["payload"], name).toSatisfy(Object.isFrozen);
    }
    for (const [type, schema] of Object.entries(INVALIDATION_EVENT_SCHEMAS)) {
      walk(schema, type);
      expect(Object.isFrozen(schema), type).toBe(true);
    }
    walk(INVALIDATION_EVENT_SCHEMA["oneOf"], "invalidation");
    expect(Object.isFrozen(INVALIDATION_EVENT_SCHEMA)).toBe(true);
    expect(open).toEqual([]);
  });

  it("refuses messages that break their contract, naming the failing path", () => {
    const provisioned = readFixture("tenant-provisioned.json");
    const p = provisioned["payload"] as Json;
    const migration = (p["migrations"] as Json[])[0]!;
    const step = (p["steps"] as Json[])[0]!;
    const failed = readFixture("tenant-provision-failed.json");
    const f = failed["payload"] as Json;
    const at = (payload: Json): Json => ({ ...provisioned, payload: { ...p, ...payload } });

    const cases: Array<[string, string, Json, string[]]> = [
      [
        "tenant.provision",
        "a payload field",
        { ...envelope, name: "tenant.provision", payload: { key: "acme" } },
        ["/payload/key additionalProperties"],
      ],
      [
        "tenant.provision",
        "another message's name",
        { ...envelope, name: "tenant.resume", payload: {} },
        ["/name const"],
      ],
      [
        "tenant.provision",
        "version 2",
        { ...envelope, v: 2, name: "tenant.provision", payload: {} },
        ["/v const"],
      ],
      [
        "tenant.provision",
        "a tenant id without its prefix",
        {
          ...envelope,
          tenantId: "01M4T9E68084G7ZWYRD6Z1RV0W",
          name: "tenant.provision",
          payload: {},
        },
        ["/tenantId pattern"],
      ],
      [
        "tenant.migrate",
        "a target that is not a migration version",
        {
          ...envelope,
          name: "tenant.migrate",
          payload: { targetVersion: "latest" },
        },
        ["/payload/targetVersion pattern"],
      ],
      [
        "tenant.suspend",
        "no reason",
        { ...envelope, name: "tenant.suspend", payload: {} },
        ["/payload/reason required"],
      ],
      [
        "tenant.suspend",
        "an unknown reason",
        {
          ...envelope,
          name: "tenant.suspend",
          payload: { reason: "fraud" },
        },
        ["/payload/reason enum"],
      ],
      [
        "tenant.provisioned",
        "no schemaVersion",
        { ...provisioned, payload: { ...p, schemaVersion: undefined } },
        ["/payload/schemaVersion required"],
      ],
      [
        "tenant.provisioned",
        "a schema name that is not tenant_<key>",
        at({ schemaName: "public" }),
        ["/payload/schemaName pattern"],
      ],
      [
        "tenant.provisioned",
        "an upper-case schema name",
        at({ schemaName: "tenant_Acme" }),
        ["/payload/schemaName pattern"],
      ],
      ["tenant.provisioned", "no migrations", at({ migrations: [] }), ["/payload/migrations minItems"]],
      [
        "tenant.provisioned",
        "a repeatable file",
        at({
          migrations: [{ ...migration, version: "R__grants", phase: "repeatable" }],
        }),
        ["/payload/migrations/0/version pattern", "/payload/migrations/0/phase enum"],
      ],
      [
        "tenant.provisioned",
        "an upper-case checksum",
        at({
          migrations: [{ ...migration, checksum: CHECKSUM.toUpperCase() }],
        }),
        ["/payload/migrations/0/checksum pattern"],
      ],
      [
        "tenant.provisioned",
        "a negative or fractional duration",
        at({
          migrations: [
            { ...migration, durationMs: -1 },
            { ...migration, durationMs: 1.5 },
          ],
        }),
        ["/payload/migrations/0/durationMs minimum", "/payload/migrations/1/durationMs type"],
      ],
      [
        "tenant.provisioned",
        "a time that is not UTC",
        at({
          migrations: [{ ...migration, appliedAt: "2026-10-13T11:30:03+02:00" }],
        }),
        ["/payload/migrations/0/appliedAt pattern"],
      ],
      [
        "tenant.provisioned",
        "a step still running",
        at({ steps: [{ ...step, status: "running" }] }),
        ["/payload/steps/0/status enum"],
      ],
      [
        "tenant.provisioned",
        "a step without finishedAt",
        at({
          steps: [{ step: "create_schema", status: "succeeded", startedAt: step["startedAt"] }],
        }),
        ["/payload/steps/0/finishedAt required"],
      ],
      [
        "tenant.provision_failed",
        "no retryable",
        { ...failed, payload: { ...f, retryable: undefined } },
        ["/payload/retryable required"],
      ],
      [
        "tenant.provision_failed",
        "a lower-case error code",
        {
          ...failed,
          payload: { ...f, error: { code: "lock_timeout", message: "x" } },
        },
        ["/payload/error/code pattern"],
      ],
      [
        "tenant.provision_failed",
        "an empty or overlong error message",
        {
          ...failed,
          payload: {
            ...f,
            error: { code: "LOCK_TIMEOUT", message: "" },
            steps: [
              { ...step, status: "failed", error: { code: "LOCK_TIMEOUT", message: "x".repeat(1001) } },
            ],
          },
        },
        ["/payload/error/message minLength", "/payload/steps/0/error/message maxLength"],
      ],
      [
        "tenant.migration_failed",
        "no version key",
        {
          ...envelope,
          name: "tenant.migration_failed",
          payload: { error: { code: "LOCK_TIMEOUT", message: "x" } },
        },
        ["/payload/version required"],
      ],
      [
        "tenant.suspended",
        "a payload field",
        { ...envelope, name: "tenant.suspended", payload: { reason: "abuse" } },
        ["/payload/reason additionalProperties"],
      ],
    ];
    for (const [name, problem, message, expected] of cases) {
      // JSON drops undefined fields, as the queue does.
      const data = JSON.parse(JSON.stringify(message)) as Json;
      expect(pathsOf(issuesOf(() => validateJob(name, data))), `${name}: ${problem}`).toEqual(expected);
    }
  });

  it("refuses a name that is not a tenant.* message, and a payload that is not an object", () => {
    const unknown = issuesOf(() =>
      validateJob("tenant.export", { ...envelope, name: "tenant.export", payload: {} }),
    );
    expect(pathsOf(unknown)).toEqual(["/name name"]);
    expect(unknown[0]!.message).toContain("tenant.provision, tenant.migrate");
    expect(() => validateJob("constructor", {})).toThrow(MessageValidationError);
    expect(pathsOf(issuesOf(() => validateJob("tenant.resume", "tenant.resume")))).toEqual([" type"]);
    expect(pathsOf(issuesOf(() => validateJob("tenant.resume", null)))).toEqual([" type"]);
    expect(
      pathsOf(
        issuesOf(() => validateJob("tenant.resume", { ...envelope, name: "tenant.resume", payload: [] })),
      ),
    ).toEqual(["/payload type"]);
  });

  it("never puts a value of the message into the error", () => {
    const secret = "DoNotLogThisValue123";
    const message = {
      ...envelope,
      requestId: `${secret}!`,
      name: "tenant.provisioned",
      payload: {
        schemaName: `tenant_${secret}`,
        schemaVersion: secret,
        migrations: [
          { version: secret, checksum: secret, phase: secret, appliedAt: secret, durationMs: secret },
        ],
        steps: [
          {
            step: secret,
            status: secret,
            startedAt: secret,
            finishedAt: secret,
            error: { code: secret, message: 1 },
          },
        ],
        clientSecret: secret,
      },
    };
    let caught: unknown;
    try {
      validateJob("tenant.provisioned", message);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MessageValidationError);
    const error = caught as MessageValidationError;
    expect(error.name).toBe("MessageValidationError");
    expect(error.subject).toBe("tenant.provisioned");
    expect(error.issues.length).toBeGreaterThan(10);
    expect(error.message).toMatch(/^invalid tenant\.provisioned message: /);
    expect(error.message).toMatch(/and \d+ more$/);
    expect(error.message).not.toContain("DoNotLogThisValue");
    expect(JSON.stringify(error.issues)).not.toContain("DoNotLogThisValue");
    expect(Object.isFrozen(error.issues)).toBe(true);

    // An unknown name is quoted and shortened in the message, never echoed in full.
    const longName = `tenant.${"x".repeat(200)}`;
    expect(() => validateJob(longName, {})).toThrow(/^invalid "tenant\.x{57}…" message: /);
    // So is a stray property name in an issue path.
    const longProperty = { ...envelope, name: "tenant.resume", payload: { ["y".repeat(200)]: 1 } };
    expect(pathsOf(issuesOf(() => validateJob("tenant.resume", longProperty)))).toEqual([
      `/payload/${"y".repeat(64)}… additionalProperties`,
    ]);
  });

  it("compiles the schemas once, on the first validation", async () => {
    vi.resetModules();
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    try {
      const fresh = await import("./validate.js");
      expect(compile).not.toHaveBeenCalled();
      fresh.validateJob("tenant.provision", readFixture("tenant-provision.json"));
      const schemas = Object.keys(TENANT_JOB_SCHEMAS).length + INVALIDATION_TYPES.length + 1;
      expect(compile).toHaveBeenCalledTimes(schemas);
      fresh.validateJob("tenant.provisioned", readFixture("tenant-provisioned.json"));
      fresh.validateInvalidation({ v: 1, type: "tenant", id: TENANT_ID });
      expect(() => fresh.validateJob("tenant.resume", {})).toThrow(fresh.MessageValidationError);
      expect(compile).toHaveBeenCalledTimes(schemas);
    } finally {
      compile.mockRestore();
    }
  });
});

// ---- vx:invalidate ------------------------------------------------------------------------------------------

describe("@velexis/api-types/jobs vx:invalidate events", () => {
  const VALID_EVENTS: readonly InvalidationEvent[] = [
    { v: 1, type: "tenant", id: TENANT_ID },
    { v: 1, type: "domain", hostname: "acme.ota.example.com" },
    { v: 1, type: "domain", hostname: "xn--bcher-kva.example.net" },
    { v: 1, type: "api_key", prefix: "pk_live_3fA9x2" },
    { v: 1, type: "api_key", prefix: "sk_test_Ab12Cd" },
    { v: 1, type: "connection", tenantId: TENANT_ID },
    { v: 1, type: "membership", accountId: ACCOUNT_ID, tenantId: TENANT_ID },
    { v: 1, type: "account", accountId: ACCOUNT_ID },
    { v: 1, type: "amadeus_account", id: AMADEUS_ACCOUNT_ID },
    { v: 1, type: "plan", code: "early_access" },
  ];

  it("names the channel vx:invalidate and the eight types of platform architecture §6.3", () => {
    expect(INVALIDATION_CHANNEL).toBe("vx:invalidate");
    expect(INVALIDATION_CONTRACT_VERSION).toBe(1);
    expect([...INVALIDATION_TYPES]).toEqual([
      "tenant",
      "domain",
      "api_key",
      "connection",
      "membership",
      "account",
      "amadeus_account",
      "plan",
    ]);
    expect(Object.keys(INVALIDATION_EVENT_SCHEMAS)).toEqual([...INVALIDATION_TYPES]);
    expect(INVALIDATION_TYPES.every(isInvalidationType)).toBe(true);
    expect([undefined, "tenants", "", 1].some(isInvalidationType)).toBe(false);
  });

  it("accepts one event of every type, also with a fresh Ajv on the exported union schema", () => {
    const union = consumerAjv().compile(INVALIDATION_EVENT_SCHEMA);
    const seen = new Set<string>();
    for (const event of VALID_EVENTS) {
      expect(validateInvalidation(event)).toBe(event);
      expect(union(event), `${event.type}: ${JSON.stringify(union.errors)}`).toBe(true);
      seen.add(event.type);
    }
    expect([...seen]).toEqual([...INVALIDATION_TYPES]);
  });

  it("refuses events outside the contract, naming the failing path", () => {
    const cases: Array<[string, unknown, string[]]> = [
      ["an unknown type", { v: 1, type: "booking", id: "x" }, ["/type enum"]],
      ["no type", { v: 1, id: TENANT_ID }, ["/type required"]],
      ["version 2", { v: 2, type: "tenant", id: TENANT_ID }, ["/v const"]],
      ["no version", { type: "tenant", id: TENANT_ID }, ["/v required"]],
      [
        "a row value",
        { v: 1, type: "tenant", id: TENANT_ID, status: "suspended" },
        ["/status additionalProperties"],
      ],
      [
        "the id field of another type",
        { v: 1, type: "tenant", tenantId: TENANT_ID },
        ["/id required", "/tenantId additionalProperties"],
      ],
      [
        "an account id as tenant id",
        { v: 1, type: "connection", tenantId: ACCOUNT_ID },
        ["/tenantId pattern"],
      ],
      [
        "a membership without tenant",
        { v: 1, type: "membership", accountId: ACCOUNT_ID },
        ["/tenantId required"],
      ],
      ["an upper-case host", { v: 1, type: "domain", hostname: "Acme.example.com" }, ["/hostname pattern"]],
      ["a trailing dot", { v: 1, type: "domain", hostname: "acme.example.com." }, ["/hostname pattern"]],
      ["one label", { v: 1, type: "domain", hostname: "localhost" }, ["/hostname pattern"]],
      ["an IP address", { v: 1, type: "domain", hostname: "192.0.2.10" }, ["/hostname pattern"]],
      [
        "a label over 63 characters",
        { v: 1, type: "domain", hostname: `${"a".repeat(64)}.example.com` },
        ["/hostname pattern"],
      ],
      [
        "a host over 253 characters",
        {
          v: 1,
          type: "domain",
          hostname: `${Array.from({ length: 5 }, () => "a".repeat(50)).join(".")}.com`,
        },
        ["/hostname maxLength"],
      ],
      [
        "a full API key",
        { v: 1, type: "api_key", prefix: `sk_test_${"Ab12Cd34".repeat(5)}` },
        ["/prefix pattern"],
      ],
      ["an unknown key kind", { v: 1, type: "api_key", prefix: "xk_test_Ab12Cd" }, ["/prefix pattern"]],
      [
        "an Amadeus account id of another kind",
        { v: 1, type: "amadeus_account", id: TENANT_ID },
        ["/id pattern"],
      ],
      ["an upper-case plan code", { v: 1, type: "plan", code: "Growth" }, ["/code pattern"]],
    ];
    const union = consumerAjv().compile(INVALIDATION_EVENT_SCHEMA);
    for (const [problem, event, expected] of cases) {
      expect(pathsOf(issuesOf(() => validateInvalidation(event))), problem).toEqual(expected);
      expect(union(event), problem).toBe(false);
    }
    for (const event of [null, "tenant", [], 1]) {
      expect(pathsOf(issuesOf(() => validateInvalidation(event))), JSON.stringify(event)).toEqual([" type"]);
    }
    const error = issuesOf(() => validateInvalidation({ v: 1, type: "tenant", id: "ten_SECRETSECRET" }));
    expect(JSON.stringify(error)).not.toContain("SECRETSECRET");
  });

  it("narrows the event union on type", () => {
    const keysOf = (event: InvalidationEvent): string => {
      switch (event.type) {
        case "tenant":
          return `tenant:${event.id}`;
        case "domain":
          return `host:${event.hostname}`;
        case "api_key":
          return `apikey:${event.prefix}`;
        case "connection":
          return `conn:*:${event.tenantId}:*`;
        case "membership":
          return `member:${event.accountId}:${event.tenantId}`;
        case "account":
          return `account:${event.accountId}`;
        case "amadeus_account":
          return `amadeus:${event.id}`;
        case "plan":
          return `plan:${event.code}`;
      }
    };
    expect(keysOf(validateInvalidation({ v: 1, type: "domain", hostname: "acme.ota.example.com" }))).toBe(
      "host:acme.ota.example.com",
    );
    expect(VALID_EVENTS.map(keysOf)).toHaveLength(VALID_EVENTS.length);
  });
});

// ---- Types --------------------------------------------------------------------------------------------------

/** A TypeScript program over the jobs sources and in-memory snippets in src/jobs/. */
function createProgram(snippets: ReadonlyMap<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ["node"],
    lib: ["lib.es2023.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = snippets.get(fileName);
    return text === undefined
      ? getSourceFile(fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, text, languageVersion);
  };
  host.fileExists = (fileName) => snippets.has(fileName) || fileExists(fileName);
  return ts.createProgram({ rootNames: [...snippets.keys()], options, host });
}

function diagnosticsOf(program: ts.Program, file: string): string[] {
  const sourceFile = program.getSourceFile(file);
  if (sourceFile === undefined) {
    throw new Error(`${file} is not part of the program`);
  }
  return [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)].map(
    (diagnostic) => `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
  );
}

describe("@velexis/api-types/jobs types", () => {
  const snippet = (name: string): string => join(JOBS_DIR, `__pbe004_${name}.ts`);
  const header =
    'import type { TenantEvent, TenantMigratedEvent, TenantProvisionedEvent } from "./index.js";';
  const migrations =
    '[{ version: "0001_baseline", checksum: "c", phase: "expand", appliedAt: "t", durationMs: 1 }]';
  const base = 'v: 1, tenantId: "ten_1", requestedAt: "t", requestId: "r"';
  const SNIPPETS = new Map([
    [
      snippet("provisioned_ok"),
      [
        header,
        `export const event: TenantProvisionedEvent = { ${base}, jobId: "job_1", name: "tenant.provisioned",`,
        `  payload: { schemaName: "tenant_acme", schemaVersion: "0001_baseline", migrations: ${migrations}, steps: [] } };`,
        "",
      ].join("\n"),
    ],
    [
      snippet("provisioned_without_schema_version"),
      [
        header,
        `export const event: TenantProvisionedEvent = { ${base}, jobId: "job_1", name: "tenant.provisioned",`,
        `  payload: { schemaName: "tenant_acme", migrations: ${migrations}, steps: [] } };`,
        "",
      ].join("\n"),
    ],
    [
      snippet("provisioned_null_job"),
      [
        header,
        `export const event: TenantProvisionedEvent = { ${base}, jobId: null, name: "tenant.provisioned",`,
        `  payload: { schemaName: "tenant_acme", schemaVersion: "0001_baseline", migrations: ${migrations}, steps: [] } };`,
        "",
      ].join("\n"),
    ],
    [
      snippet("fanout_ok"),
      [
        header,
        `export const event: TenantMigratedEvent = { ${base}, jobId: null, name: "tenant.migrated",`,
        `  payload: { schemaVersion: "0001_baseline", migrations: ${migrations} } };`,
        "",
      ].join("\n"),
    ],
    [
      snippet("narrowing"),
      [
        header,
        "export function describe(event: TenantEvent): string {",
        "  switch (event.name) {",
        '    case "tenant.provisioned": return event.payload.schemaVersion;',
        '    case "tenant.provision_failed": return event.payload.error.code;',
        '    case "tenant.migrated": return event.payload.schemaVersion;',
        '    case "tenant.migration_failed": return event.payload.version ?? event.payload.error.code;',
        '    case "tenant.suspended": return event.jobId;',
        '    case "tenant.resumed": return event.jobId;',
        "  }",
        "}",
        "",
      ].join("\n"),
    ],
    [
      snippet("not_narrowed"),
      [
        header,
        "export const version = (event: TenantEvent): string => event.payload.schemaVersion;",
        "",
      ].join("\n"),
    ],
  ]);
  // Type-checking is the slow part, so every snippet is checked once here, under the long hook timeout, and the
  // tests below only read the results (a loaded machine must not push them past Vitest's 5 s test timeout).
  const diagnostics = new Map<string, string[]>();
  const diagnosticsFor = (name: string): string[] => {
    const found = diagnostics.get(snippet(name));
    if (found === undefined) {
      throw new Error(`no diagnostics for the snippet ${name}`);
    }
    return found;
  };
  beforeAll(() => {
    const program = createProgram(SNIPPETS);
    for (const file of SNIPPETS.keys()) {
      diagnostics.set(file, diagnosticsOf(program, file));
    }
  }, 60_000);

  it("narrows the event union on name [PBE-004 AC3]", () => {
    // Checked by `tsc` (typecheck and build of this package) too: an unused @ts-expect-error is an error itself.
    const describeEvent = (event: TenantEvent): string => {
      switch (event.name) {
        case "tenant.provisioned":
          return `${event.payload.schemaName} at ${event.payload.schemaVersion}`;
        case "tenant.provision_failed":
          return `${event.payload.error.code}${event.payload.retryable ? " (retryable)" : ""}`;
        case "tenant.migrated":
          return `${event.jobId ?? "fan-out"}: ${event.payload.schemaVersion}`;
        case "tenant.migration_failed":
          return `${event.payload.version ?? "-"}: ${event.payload.error.code}`;
        case "tenant.suspended":
        case "tenant.resumed": {
          const jobId: string = event.jobId;
          return `${event.name} ${jobId}`;
        }
      }
    };
    const notNarrowed = (event: TenantEvent): unknown =>
      // @ts-expect-error only tenant.provisioned and tenant.migrated have a schemaVersion
      event.payload.schemaVersion;
    const describeJob = (job: TenantOpsJob): string =>
      job.name === "tenant.suspend" ? job.payload.reason : job.name;

    const provisioned = validateJob("tenant.provisioned", readFixture("tenant-provisioned.json"));
    const failed = validateJob("tenant.provision_failed", readFixture("tenant-provision-failed.json"));
    const fanout = validateJob("tenant.migrated", readFixture("tenant-migrated-fanout.json"));
    expect([provisioned, failed, fanout].map(describeEvent)).toEqual([
      "tenant_acme at 0001_baseline",
      "LOCK_TIMEOUT (retryable)",
      "fan-out: 0001_baseline",
    ]);
    expect(notNarrowed(provisioned)).toBe("0001_baseline");
    const provision: TenantProvisionJob = validateJob(
      "tenant.provision",
      readFixture("tenant-provision.json"),
    );
    expect(describeJob(provision)).toBe("tenant.provision");
    expect(describeJob({ ...provision, name: "tenant.suspend", payload: { reason: "billing" } })).toBe(
      "billing",
    );

    // The same in snippets compiled here, so the test proves it on its own.
    expect(diagnosticsFor("narrowing")).toEqual([]);
    const errors = diagnosticsFor("not_narrowed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^TS2339: Property 'schemaVersion' does not exist on type/);
  });

  it("does not compile a tenant.provisioned without schemaVersion [PBE-004 AC3]", () => {
    const ok: TenantProvisionedEvent = {
      ...envelope,
      v: JOB_CONTRACT_VERSION,
      name: "tenant.provisioned",
      payload: { schemaName: "tenant_acme", schemaVersion: "0001_baseline", migrations: [], steps: [] },
    };
    const withoutSchemaVersion: TenantProvisionedEvent = {
      ...ok,
      // @ts-expect-error a tenant.provisioned without schemaVersion does not compile
      payload: { schemaName: "tenant_acme", migrations: [], steps: [] },
    };
    // @ts-expect-error tenant.provisioned always answers a job: jobId is never null
    const withoutJob: TenantProvisionedEvent = { ...ok, jobId: null };
    const fanout: TenantMigratedEvent = {
      ...ok,
      name: "tenant.migrated",
      jobId: null,
      payload: { schemaVersion: "0001_baseline", migrations: [] },
    };
    expect([withoutSchemaVersion.payload.schemaName, withoutJob.jobId, fanout.jobId]).toEqual([
      "tenant_acme",
      null,
      null,
    ]);
    // The schema refuses what the type refuses.
    expect(pathsOf(issuesOf(() => validateJob("tenant.provisioned", withoutSchemaVersion)))).toEqual([
      "/payload/schemaVersion required",
      "/payload/migrations minItems",
    ]);

    // The same in snippets compiled here, so the test proves it on its own.
    expect(diagnosticsFor("provisioned_ok")).toEqual([]);
    expect(diagnosticsFor("fanout_ok")).toEqual([]);
    const missing = diagnosticsFor("provisioned_without_schema_version");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/^TS2741: Property 'schemaVersion' is missing in type/);
    const nullJob = diagnosticsFor("provisioned_null_job");
    expect(nullJob).toHaveLength(1);
    expect(nullJob[0]).toMatch(/^TS2322: Type 'null' is not assignable to type 'string'/);
  });

  it("types validateJob by name and lets JSON fixtures in through it", () => {
    const data: unknown = readFixture("tenant-provision.json");
    const job: TenantProvisionJob = validateJob("tenant.provision", data);
    // @ts-expect-error validateJob("tenant.provision", …) returns a TenantProvisionJob, not a TenantMigrateJob
    const notMigrate: TenantMigrateJob = validateJob("tenant.provision", data);
    expect(notMigrate).toBe(job);
    expect(job.payload).toEqual({});
    const anyName: string = "tenant.migrated";
    const message = validateJob(anyName, readFixture("tenant-migrated-fanout.json"));
    expect(message.name).toBe("tenant.migrated");
    expect(TENANT_SUSPENSION_REASONS).toEqual(["billing", "abuse", "request", "admin"]);
    expect(OTA_PROVISIONING_STEPS).toEqual(["create_schema", "run_migrations", "seed_defaults"]);
    const schema: JsonSchema = TENANT_JOB_SCHEMAS["tenant.migrated"];
    expect((schema["properties"] as Json)["jobId"]).toMatchObject({ type: ["string", "null"] });
  });
});
