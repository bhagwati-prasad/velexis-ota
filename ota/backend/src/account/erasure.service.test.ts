// The erasure of deleted customers without a database (OBE-087): when an erasure falls due (the cut-off of
// `erasureCutoff`, the instant account.delete's answer promises), the `customers.erase` schedule and its handler, and
// what CustomerErasureService does with a job's batch (one transaction per customer, the counts, `more`, the log lines,
// a failure) over a fake repository and a fake TenantTx. The statements themselves run against PostgreSQL in
// test/integration/account/erasure.int.test.ts.
import { Reflector } from "@nestjs/core";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../common/clock";
import { TENANT_JOB_METADATA } from "../jobs/fan-out";
import { scheduleById } from "../jobs/schedulers";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import { ERASURE_DUE_AFTER_MS, toAccountDeletion } from "./account.mapper";
import { CUSTOMERS_ERASE_JOB, CustomerErasureProcessor } from "./erasure.processor";
import {
  CustomerErasureService,
  ERASED_FIELDS,
  ERASURE_BATCH,
  ErasureIncompleteError,
  erasureCutoff,
  type CustomerErasureRepository,
  type ErasedCustomer,
} from "./erasure.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const TENANT_ID = "ten_01JERASURETEST0000000000";
/** The job's instant: any instant will do, the cut-offs are relative to it. */
const NOW = new Date("2026-11-04T03:50:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** A transaction object only the fake repository sees. */
const TRX = { fake: "trx" } as unknown as TenantTransaction;

/** What one fake erasure detached and deleted: one of each, the same for every customer. */
const ONE_OF_EACH: ErasedCustomer = {
  checkoutsDetached: 1,
  bookingsDetached: 2,
  paymentsDetached: 2,
  savedTravelerDocuments: 1,
  savedTravelers: 1,
  preferences: 1,
  dataExports: 0,
  sessions: 3,
  passwordResets: 1,
  consents: 2,
  identities: 1,
};

interface LogRecord {
  readonly level: "info" | "error";
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

interface Harness {
  readonly service: CustomerErasureService;
  readonly repository: { dueCustomers: ReturnType<typeof vi.fn>; erase: ReturnType<typeof vi.fn> };
  readonly transactions: () => number;
  readonly lines: LogRecord[];
}

/**
 * The service over a fake TenantTx (counts its transactions), a fake repository whose due customers are `due` and
 * whose erasure of a customer answers `erase(customerId)`, a FakeClock at NOW and a recording logger.
 */
function harness(
  due: readonly string[],
  erase: (customerId: string) => Promise<ErasedCustomer | undefined> = () => Promise.resolve(ONE_OF_EACH),
): Harness {
  let transactions = 0;
  const tx = {
    run: <T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> => {
      transactions += 1;
      return fn(TRX);
    },
  } as unknown as TenantTx;
  const repository = {
    dueCustomers: vi.fn((_trx: TenantTransaction, _cutoff: Date, limit: number) =>
      Promise.resolve(due.slice(0, limit)),
    ),
    erase: vi.fn((_trx: TenantTransaction, customerId: string) => erase(customerId)),
  };
  const lines: LogRecord[] = [];
  const record =
    (level: LogRecord["level"]) =>
    (fields: Record<string, unknown>, msg: string): void => {
      lines.push({ level, msg, fields });
    };
  const logger = { info: record("info"), error: record("error") } as unknown as PinoLogger;
  const clock = new FakeClock(NOW) as unknown as Clock;
  const service = new CustomerErasureService(
    tx,
    repository as unknown as CustomerErasureRepository,
    clock,
    logger,
  );
  return { service, repository, transactions: () => transactions, lines };
}

const customerIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `cus_01JERASURE${String(index).padStart(14, "0")}`);

describe("erasureCutoff", () => {
  it("[OBE-087 AC1] makes a customer deleted 31 days ago due and leaves one deleted 29 days ago", () => {
    const cutoff = erasureCutoff(NOW);
    expect(ago(31 * DAY_MS).getTime()).toBeLessThanOrEqual(cutoff.getTime());
    expect(ago(29 * DAY_MS).getTime()).toBeGreaterThan(cutoff.getTime());
  });

  it("falls due at the erasureDueBy that account.delete's answer promised: 30 days after the deletion", () => {
    expect(ERASURE_DUE_AFTER_MS).toBe(30 * DAY_MS);
    const deletedAt = ago(30 * DAY_MS);
    const promised = toAccountDeletion({ requestedAt: deletedAt, hasBookings: true }).erasureDueBy;
    expect(new Date(promised).getTime()).toBe(NOW.getTime());
    expect(erasureCutoff(NOW).getTime()).toBe(deletedAt.getTime());
    expect(() => erasureCutoff(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("the customers.erase schedule", () => {
  it("runs daily at 03:50 UTC for active and suspended tenants (OADR-0014 point 4), handled by the erasure processor", () => {
    expect(CUSTOMERS_ERASE_JOB).toBe("customers.erase");
    expect(scheduleById(CUSTOMERS_ERASE_JOB)).toMatchObject({
      pattern: "50 3 * * *",
      milestone: "M6",
      statuses: ["active", "suspended"],
    });
    expect(new Reflector().get(TENANT_JOB_METADATA, CustomerErasureProcessor)).toBe(CUSTOMERS_ERASE_JOB);
  });
});

describe("CustomerErasureService.eraseDue", () => {
  it("[OBE-087 AC1] asks for 100 customers due at the job's instant and erases each in a transaction of its own", async () => {
    const due = customerIds(3);
    const { service, repository, transactions } = harness(due);

    const run = await service.eraseDue(TENANT_ID);

    expect(repository.dueCustomers).toHaveBeenCalledTimes(1);
    expect(repository.dueCustomers).toHaveBeenCalledWith(TRX, ago(30 * DAY_MS), ERASURE_BATCH);
    expect(ERASURE_BATCH).toBe(100);
    expect(repository.erase.mock.calls).toEqual(due.map((id) => [TRX, id, ago(30 * DAY_MS)]));
    // The read of the batch, then one transaction per customer.
    expect(transactions()).toBe(1 + due.length);
    expect(run.more).toBe(false);
    expect(run.counts).toEqual({
      customers: 3,
      failed: 0,
      ...Object.fromEntries(ERASED_FIELDS.map((field) => [field, 3 * ONE_OF_EACH[field]])),
    });
  });

  it("logs each erasure with the tenant, the customer id and counts only, and the job's totals", async () => {
    const due = customerIds(2);
    const { service, lines } = harness(due);

    await service.eraseDue(TENANT_ID);

    expect(lines.map(({ level, msg }) => [level, msg])).toEqual([
      ["info", "customer.erased"],
      ["info", "customer.erased"],
      ["info", "customers.erasure_done"],
    ]);
    for (const [index, line] of lines.slice(0, 2).entries()) {
      expect(line.fields).toEqual({ tenantId: TENANT_ID, customerId: due[index], ...ONE_OF_EACH });
    }
    expect(Object.keys(lines[2]?.fields ?? {}).sort()).toEqual(
      ["tenantId", "customers", "failed", "more", ...ERASED_FIELDS].sort(),
    );
    for (const { fields } of lines) {
      for (const [key, value] of Object.entries(fields)) {
        if (key !== "tenantId" && key !== "customerId") {
          expect(typeof value === "number" || typeof value === "boolean", key).toBe(true);
        }
      }
    }
  });

  it("asks for more after a full batch of 100 (OADR-0014 point 2), and not after a smaller one", async () => {
    const full = harness(customerIds(ERASURE_BATCH + 5));
    const fullRun = await full.service.eraseDue(TENANT_ID);
    expect(full.repository.erase).toHaveBeenCalledTimes(ERASURE_BATCH);
    expect(fullRun).toMatchObject({ more: true, counts: { customers: ERASURE_BATCH } });

    const partial = harness(customerIds(ERASURE_BATCH - 1));
    expect(await partial.service.eraseDue(TENANT_ID)).toMatchObject({
      more: false,
      counts: { customers: ERASURE_BATCH - 1 },
    });

    const none = harness([]);
    expect(await none.service.eraseDue(TENANT_ID)).toMatchObject({ more: false, counts: { customers: 0 } });
    expect(none.repository.erase).not.toHaveBeenCalled();
  });

  it("neither counts nor logs a customer another job erased meanwhile (idempotent)", async () => {
    const due = customerIds(3);
    const gone = due[1];
    const { service, lines } = harness(due, (customerId) =>
      Promise.resolve(customerId === gone ? undefined : ONE_OF_EACH),
    );

    const run = await service.eraseDue(TENANT_ID);

    expect(run.counts.customers).toBe(2);
    expect(run.counts.sessions).toBe(2 * ONE_OF_EACH.sessions);
    expect(
      lines.filter(({ msg }) => msg === "customer.erased").map(({ fields }) => fields["customerId"]),
    ).toEqual([due[0], due[2]]);
  });

  it("erases the others when one erasure fails, logs its code but never its message, then fails the job", async () => {
    const due = customerIds(3);
    const failing = due[1];
    const failure = Object.assign(new Error('update or delete on "customers" violates … "Anna Berg"'), {
      code: "40P01",
    });
    const { service, repository, lines } = harness(due, (customerId) =>
      customerId === failing ? Promise.reject(failure) : Promise.resolve(ONE_OF_EACH),
    );

    const error = await service.eraseDue(TENANT_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ErasureIncompleteError);
    expect(error).toMatchObject({ failed: 1, attempted: 3 });
    expect(repository.erase).toHaveBeenCalledTimes(3);
    expect(lines.map(({ level, msg }) => [level, msg])).toEqual([
      ["info", "customer.erased"],
      ["error", "customer.erasure_failed"],
      ["info", "customer.erased"],
      ["info", "customers.erasure_done"],
    ]);
    expect(lines[1]?.fields).toEqual({ tenantId: TENANT_ID, customerId: failing, code: "40P01" });
    expect(lines[3]?.fields).toMatchObject({ customers: 2, failed: 1, more: false });
    expect(JSON.stringify(lines)).not.toContain("Anna");
    expect(String((error as Error).message)).not.toContain("Anna");
  });
});

describe("CustomerErasureProcessor", () => {
  it("runs the tenant's erasure and answers its counts and whether more is due", async () => {
    const counts = {
      customers: 100,
      failed: 0,
      ...Object.fromEntries(ERASED_FIELDS.map((field) => [field, 0])),
    } as Awaited<ReturnType<CustomerErasureService["eraseDue"]>>["counts"];
    const eraseDue = vi.fn(() => Promise.resolve({ counts, more: true }));
    const processor = new CustomerErasureProcessor({ eraseDue } as unknown as CustomerErasureService);

    const outcome = await processor.run({ id: TENANT_ID } as PlatformTenant);

    expect(eraseDue).toHaveBeenCalledWith(TENANT_ID);
    expect(outcome).toEqual({ more: true, counts });
  });
});
