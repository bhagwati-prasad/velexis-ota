// The pure parts of the platform admin's tenant jobs (PBE-031, PADR-0001): the list's cursor, the mapping of a job row
// to the list and detail answers, and the stripping of ciphertexts from a job's input and output. The
// routes themselves are in test/integration/admin/admin-jobs.int.test.ts.
import { describe, expect, it } from "vitest";
import type { AdminJobDetailRow } from "../provisioning/provisioning-jobs.repository";
import {
  decodeJobCursor,
  encodeJobCursor,
  toAdminProvisioningJob,
  toAdminProvisioningJobDetail,
  withoutCiphertexts,
} from "./admin-jobs.service";

const JOB_ID = "job_01JATESTRW0000000000000007";

function row(overrides: Partial<AdminJobDetailRow> = {}): AdminJobDetailRow {
  return {
    id: JOB_ID,
    tenant_id: "ten_01JATESTRW0000000000000001",
    tenant_key: "nordic",
    kind: "provision",
    status: "running",
    step: "dispatch",
    attempt: 2,
    max_attempts: 5,
    error: null,
    scheduled_at: new Date("2026-10-16T14:31:12.000Z"),
    started_at: new Date("2026-10-16T13:40:03.000Z"),
    finished_at: null,
    steps: [],
    payload: {},
    result: null,
    locked_until: new Date("2026-10-16T14:46:12.000Z"),
    ...overrides,
  };
}

describe("the job list cursor", () => {
  it("round-trips the last job's id and refuses anything else", () => {
    expect(decodeJobCursor(encodeJobCursor(JOB_ID))).toBe(JOB_ID);
    for (const cursor of [
      "",
      "not base64 !",
      Buffer.from("[]").toString("base64url"),
      Buffer.from(JSON.stringify({ id: "ten_01JATESTRW0000000000000007" })).toString("base64url"),
      Buffer.from(JSON.stringify({ id: JOB_ID, more: 1 })).toString("base64url"),
      "x".repeat(513),
    ]) {
      expect(decodeJobCursor(cursor), cursor).toBeUndefined();
    }
  });
});

describe("withoutCiphertexts", () => {
  it("drops every key that names a ciphertext, at any depth, and keeps the ids the page shows", () => {
    expect(
      withoutCiphertexts({
        schemaVersion: "0002_add_mvp_tenant_deltas",
        apiKeyIds: ["key_01JATESTRW0000000000000001"],
        reveal_ciphertext: "AAAA",
        nested: {
          revealCiphertext: "BBBB",
          keep: 1,
          list: [{ clientSecretCiphertext: "CCCC", officeId: "x" }],
        },
      }),
    ).toEqual({
      schemaVersion: "0002_add_mvp_tenant_deltas",
      apiKeyIds: ["key_01JATESTRW0000000000000001"],
      nested: { keep: 1, list: [{ officeId: "x" }] },
    });
  });
});

describe("toAdminProvisioningJob and toAdminProvisioningJobDetail", () => {
  it("map a job row to the list answer, the error cut to 1,000 characters", () => {
    expect(toAdminProvisioningJob(row({ status: "failed", error: "E".repeat(1200) }))).toEqual({
      id: JOB_ID,
      tenantId: "ten_01JATESTRW0000000000000001",
      tenantKey: "nordic",
      kind: "provision",
      status: "failed",
      step: "dispatch",
      attempt: 2,
      maxAttempts: 5,
      error: "E".repeat(1000),
      scheduledAt: "2026-10-16T14:31:12.000Z",
      startedAt: "2026-10-16T13:40:03.000Z",
      finishedAt: null,
    });
  });

  it("answer the lease of a running job only, the step log's well-formed entries and the BullMQ state", () => {
    const steps = [
      {
        step: "create_schema",
        status: "succeeded",
        startedAt: "2026-10-16T14:31:13Z",
        finishedAt: "2026-10-16T14:31:13Z",
      },
      { step: "broken" },
      {
        step: "run_migrations",
        status: "failed",
        startedAt: "2026-10-16T14:31:13Z",
        finishedAt: "2026-10-16T14:31:44Z",
        error: { code: "LOCK_TIMEOUT", message: "The tenant schema lock was not granted within 30 seconds." },
      },
    ];
    const running = toAdminProvisioningJobDetail(
      row({ steps, payload: { targetVersion: "0002" } }),
      "active",
    );
    expect(running).toMatchObject({
      lockedUntil: "2026-10-16T14:46:12.000Z",
      bullmqState: "active",
      payload: { targetVersion: "0002" },
      result: null,
      steps: [steps[0], steps[2]],
    });
    const failed = toAdminProvisioningJobDetail(row({ status: "failed", payload: "x", result: [] }), null);
    expect(failed).toMatchObject({ lockedUntil: null, bullmqState: null, payload: {}, result: null });
  });
});
