// ConnectionsService without a database or Redis (PBE-040; platform/docs/api-inventory-resources.md §3
// `updateAmadeusConnection`, flows/amadeus-connection.md §E, scope PF-53): the rules of the settings update (every
// office id of the body within the connection's offices, the changed fields), the order of its refusals, and what a
// valid change writes, audits and publishes. The repository, the audit and the publisher are stand-ins that record
// their calls; the integration test (test/integration/connections/amadeus-settings.int.test.ts) runs the same through
// the HTTP pipeline on PostgreSQL and Redis.
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { describe, expect, it } from "vitest";
import type { AuditService } from "../audit/audit.service";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import type { PlatformDb } from "../common/database";
import type { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import {
  ConnectionsService,
  NOT_A_CONNECTION_OFFICE,
  officeProblems,
  settingsChanges,
  type UpdateAmadeusConnectionRequest,
} from "./connections.service";
import type {
  SupplierConnectionSettings,
  SupplierConnectionsRepository,
  SupplierConnectionView,
} from "./supplier-connections.repository";

const TENANT_ID = "ten_01JATESTRW0000000000000001";
const ACCOUNT_ID = "acc_01JATESTRW0000000000000001";
const CONNECTION_ID = "sc_01JATESTRW0000000000000001";
const OWNER: TenantMembership = {
  membershipId: "stf_01JATESTRW0000000000000001",
  tenantId: TENANT_ID,
  accountId: ACCOUNT_ID,
  role: "owner",
};
/** The connection's two offices, and one that is not the connection's. */
const NICE = "NCE1A0955";
const PARIS = "PAR1A0001";
const FOREIGN = "LON1A0777";

/**
 * A stored `velexis` test connection with two offices, Nice as every default, no ticketing defaults or queues, as the
 * service locks it: without the client secret's ciphertext.
 */
function storedConnection(overrides: Partial<SupplierConnectionView> = {}): SupplierConnectionView {
  const at = new Date("2026-10-01T09:00:00.000Z");
  return {
    id: CONNECTION_ID,
    tenant_id: TENANT_ID,
    provider: "amadeus",
    environment: "test",
    credential_source: "velexis",
    amadeus_account_id: "ama_01JATESTRW0000000000000001",
    base_url: null,
    client_id: null,
    encryption_key_id: null,
    office_ids: [NICE, PARIS],
    default_office_id: NICE,
    queuing_office_id: NICE,
    owner_office_id: NICE,
    ticketing_defaults: {},
    monitored_queues: [],
    status: "active",
    last_verified_at: at,
    last_error: null,
    created_by_account_id: null,
    version: 3,
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

interface Harness {
  readonly service: ConnectionsService;
  readonly clock: FakeClock;
  /** The settings written, with the connection id. */
  readonly written: Array<{ id: string; settings: SupplierConnectionSettings; now: Date }>;
  readonly audited: unknown[];
  readonly published: unknown[];
  /** The repository reads in order: `tenant` (FOR SHARE), `connection` (FOR UPDATE). */
  readonly reads: string[];
}

function harness(
  options: {
    readonly tenantStatus?: string | undefined;
    readonly connection?: SupplierConnectionView | undefined;
  } = {},
): Harness {
  const clock = new FakeClock("2026-10-29T12:00:00.000Z");
  const written: Harness["written"] = [];
  const audited: unknown[] = [];
  const published: unknown[] = [];
  const reads: string[] = [];
  const tenantStatus = "tenantStatus" in options ? options.tenantStatus : "active";
  const connection = "connection" in options ? options.connection : storedConnection();
  const db = {
    transaction: () => ({ execute: (fn: (trx: object) => Promise<unknown>) => fn({}) }),
  } as unknown as PlatformDb;
  const repository = {
    tenantStatusForShare: () => {
      reads.push("tenant");
      return Promise.resolve(tenantStatus);
    },
    lockViewForTenant: () => {
      reads.push("connection");
      return Promise.resolve(connection);
    },
    updateSettings: (_trx: unknown, id: string, settings: SupplierConnectionSettings, now: Date) => {
      written.push({ id, settings, now });
      const stored = connection ?? storedConnection();
      return Promise.resolve({ ...stored, ...settings, version: stored.version + 1, updated_at: now });
    },
  } as unknown as SupplierConnectionsRepository;
  const service = new ConnectionsService(
    repository,
    {
      record: (_trx: unknown, entry: unknown) => Promise.resolve(void audited.push(entry)),
    } as unknown as AuditService,
    {
      publishAfterCommit: (_trx: unknown, event: unknown) => void published.push(event),
    } as unknown as InvalidationPublisher,
    clock,
    db,
  );
  return { service, clock, written, audited, published, reads };
}

/** The refusal of a call, or `undefined` when it resolved. */
async function refusalOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("officeProblems", () => {
  it("[PBE-040 AC1] names each office of the body outside the connection's offices, at its field, without the value", () => {
    const request: UpdateAmadeusConnectionRequest = {
      defaultOfficeId: FOREIGN,
      queuingOfficeId: PARIS,
      ownerOfficeId: FOREIGN,
      ticketingDefaults: {
        automatedProcess: [
          { code: "IMMEDIATE", officeId: NICE },
          { code: "DELAYED", delay: "2D" },
          { code: "ERROR", officeId: FOREIGN },
        ],
      },
      monitoredQueues: [
        { officeId: FOREIGN, queueId: 8, category: 0 },
        { officeId: PARIS, queueId: 1, category: 0 },
      ],
    };

    const problems = officeProblems(request, [NICE, PARIS]);

    expect(problems).toEqual(
      [
        "/defaultOfficeId",
        "/ownerOfficeId",
        "/ticketingDefaults/automatedProcess/2/officeId",
        "/monitoredQueues/0/officeId",
      ].map((path) => ({ path, code: "unknown", message: NOT_A_CONNECTION_OFFICE })),
    );
    expect(JSON.stringify(problems)).not.toContain(FOREIGN);
  });

  it("finds nothing when every office of the body is the connection's, or the body names none", () => {
    expect(
      officeProblems(
        {
          defaultOfficeId: PARIS,
          queuingOfficeId: NICE,
          ownerOfficeId: PARIS,
          ticketingDefaults: { automatedProcess: [{ code: "IMMEDIATE", officeId: PARIS }] },
          monitoredQueues: [{ officeId: NICE, queueId: 8, category: 0 }],
        },
        [NICE, PARIS],
      ),
    ).toEqual([]);
    expect(officeProblems({ ticketingDefaults: { issue: true }, monitoredQueues: [] }, [])).toEqual([]);
  });

  it("refuses every office of a connection that has none yet", () => {
    expect(officeProblems({ defaultOfficeId: NICE }, []).map(({ path }) => path)).toEqual([
      "/defaultOfficeId",
    ]);
  });
});

describe("settingsChanges", () => {
  it("keeps only the sent fields that differ, with the stored and the requested values", () => {
    const current = storedConnection({
      ticketing_defaults: { issue: false },
      monitored_queues: [{ officeId: NICE, queueId: 8, category: 0 }],
    });

    const changes = settingsChanges(current, {
      defaultOfficeId: NICE,
      queuingOfficeId: PARIS,
      ticketingDefaults: { issue: true },
      monitoredQueues: [{ officeId: NICE, queueId: 8, category: 0 }],
    });

    expect(changes).toEqual({
      columns: { queuing_office_id: PARIS, ticketing_defaults: { issue: true } },
      before: { queuingOfficeId: NICE, ticketingDefaults: { issue: false } },
      after: { queuingOfficeId: PARIS, ticketingDefaults: { issue: true } },
    });
  });

  it("compares the jsonb settings by value: an object's keys in any order, a list in its order", () => {
    const current = storedConnection({
      // PostgreSQL's jsonb answers an object's keys in its own order.
      ticketing_defaults: { issue: true, ticketingAgreement: { delay: "2D", option: "DELAY_TO_CANCEL" } },
      monitored_queues: [
        { category: 0, officeId: NICE, queueId: 8 },
        { category: 1, officeId: PARIS, queueId: 2 },
      ],
    });
    const same = {
      ticketingDefaults: { ticketingAgreement: { option: "DELAY_TO_CANCEL", delay: "2D" }, issue: true },
      monitoredQueues: [
        { officeId: NICE, queueId: 8, category: 0 },
        { officeId: PARIS, queueId: 2, category: 1 },
      ],
    } satisfies UpdateAmadeusConnectionRequest;

    expect(settingsChanges(current, same).columns).toEqual({});
    const reordered = settingsChanges(current, { monitoredQueues: [...same.monitoredQueues].reverse() });
    expect(Object.keys(reordered.columns)).toEqual(["monitored_queues"]);
    // Clearing is a change: `{}` and `[]` replace what is stored.
    expect(settingsChanges(current, { ticketingDefaults: {}, monitoredQueues: [] }).columns).toEqual({
      ticketing_defaults: {},
      monitored_queues: [],
    });
  });
});

describe("ConnectionsService.updateSettings", () => {
  it("[PBE-040 AC1] writes a valid change with version + 1, audits it once and publishes the connection invalidation", async () => {
    const h = harness();
    const request: UpdateAmadeusConnectionRequest = {
      defaultOfficeId: PARIS,
      ticketingDefaults: {
        ticketingAgreement: { option: "DELAY_TO_CANCEL", delay: "2D" },
        automatedProcess: [{ code: "IMMEDIATE", queue: { number: "8", category: "0" }, officeId: NICE }],
        issue: false,
      },
      monitoredQueues: [{ officeId: PARIS, queueId: 8, category: 0 }],
    };

    const row = await h.service.updateSettings(OWNER, "test", 3, request);

    expect(h.reads).toEqual(["tenant", "connection"]);
    expect(h.written).toEqual([
      {
        id: CONNECTION_ID,
        settings: {
          default_office_id: PARIS,
          ticketing_defaults: request.ticketingDefaults,
          monitored_queues: request.monitoredQueues,
        },
        now: h.clock.now(),
      },
    ]);
    expect(row.version).toBe(4);
    expect(h.audited).toEqual([
      {
        actorType: "account",
        actorAccountId: ACCOUNT_ID,
        action: "amadeus.settings_updated",
        targetType: "supplier_connection",
        targetId: CONNECTION_ID,
        tenantId: TENANT_ID,
        before: { defaultOfficeId: NICE, ticketingDefaults: {}, monitoredQueues: [] },
        after: {
          defaultOfficeId: PARIS,
          ticketingDefaults: request.ticketingDefaults,
          monitoredQueues: request.monitoredQueues,
        },
        details: { environment: "test" },
      },
    ]);
    expect(h.published).toEqual([{ v: 1, type: "connection", tenantId: TENANT_ID }]);
  });

  it("[PBE-040 AC1] answers VALIDATION_FAILED for a default office outside office_ids, and writes nothing", async () => {
    const h = harness();

    const refusal = await refusalOf(h.service.updateSettings(OWNER, "test", 3, { defaultOfficeId: FOREIGN }));

    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [{ path: "/defaultOfficeId", code: "unknown", message: NOT_A_CONNECTION_OFFICE }],
    });
    expect([h.written, h.audited, h.published]).toEqual([[], [], []]);
  });

  it("[PBE-040 AC1] answers PRECONDITION_FAILED for a stale version, and writes nothing", async () => {
    const h = harness();

    for (const version of [2, 4]) {
      const refusal = await refusalOf(
        h.service.updateSettings(OWNER, "test", version, { ownerOfficeId: PARIS }),
      );
      expect([version, refusal]).toEqual([version, expect.objectContaining({ code: "PRECONDITION_FAILED" })]);
    }
    expect([h.written, h.audited, h.published]).toEqual([[], [], []]);
  });

  it("refuses in the order 404 (tenant, then connection), 412, 409 TENANT_NOT_ACTIVE, 400", async () => {
    const outcome = async (h: Harness, version: number, request: UpdateAmadeusConnectionRequest) => {
      const refusal = (await refusalOf(h.service.updateSettings(OWNER, "test", version, request))) as
        AppError | undefined;
      return [refusal?.code, refusal?.details];
    };
    const foreign = { defaultOfficeId: FOREIGN };

    // A tenant that is gone or that members no longer see, and an environment without a connection.
    expect(await outcome(harness({ tenantStatus: undefined }), 3, foreign)).toEqual(["NOT_FOUND", undefined]);
    expect(await outcome(harness({ tenantStatus: "deprovisioning" }), 3, foreign)).toEqual([
      "NOT_FOUND",
      undefined,
    ]);
    expect(await outcome(harness({ connection: undefined }), 2, foreign)).toEqual(["NOT_FOUND", undefined]);
    // A stale version before the tenant's status, the status before the offices.
    const suspended = harness({ tenantStatus: "suspended" });
    expect(await outcome(suspended, 2, foreign)).toEqual(["PRECONDITION_FAILED", undefined]);
    expect(await outcome(suspended, 3, foreign)).toEqual(["TENANT_NOT_ACTIVE", { status: "suspended" }]);
    expect(await outcome(harness(), 3, foreign)).toEqual(["VALIDATION_FAILED", undefined]);
    expect([suspended.written, suspended.audited, suspended.published]).toEqual([[], [], []]);
  });

  it("answers the connection as it is for settings it already has: no write, no audit row, no invalidation", async () => {
    const stored = storedConnection({
      ticketing_defaults: { issue: true, ticketingAgreement: { option: "CONFIRM" } },
    });
    const h = harness({ connection: stored });

    const row = await h.service.updateSettings(OWNER, "test", 3, {
      defaultOfficeId: NICE,
      ticketingDefaults: { ticketingAgreement: { option: "CONFIRM" }, issue: true },
      monitoredQueues: [],
    });

    expect(row).toBe(stored);
    expect([h.written, h.audited, h.published]).toEqual([[], [], []]);
  });
});
