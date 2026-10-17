// OutboxService without a database (PBE-011; PADR-0013 items 2 and 7): the ids of e-mails queued with an idempotency
// key, the links into the portal and the admin, the refusal of a transaction that runInTransaction did not open, and
// the enqueue after the commit that never fails the caller (Redis failing or not answering).
import type { ConfigService } from "@nestjs/config";
import { FakeClock } from "@velexis/testing";
import type { Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvelopeService } from "../common/crypto.provider";
import { IdGenerator } from "../common/ids";
import { NotInTransactionError } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import type { OutboxRepository, OutboxTransaction } from "./outbox.repository";
import {
  EMAIL_SEND_JOB,
  ENQUEUE_TIMEOUT_MS,
  idempotentEmailId,
  InvalidEmailError,
  OutboxService,
  publicBase,
} from "./outbox.service";

const EMAIL_ID = /^eml_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const CONFIG: Record<string, string> = {
  PUBLIC_PORTAL_URL: "https://platform.example.com/",
  PUBLIC_PLATFORM_ADMIN_URL: "https://admin.platform.example.com",
  OPS_ALERT_EMAIL: "ops@example.com",
};

interface Harness {
  readonly service: OutboxService;
  readonly added: Array<{ name: string; data: unknown; opts: unknown }>;
  readonly warnings: Array<{ fields: Record<string, unknown>; msg: string }>;
}

function harness(add: (name: string, data: unknown, opts: unknown) => Promise<unknown>): Harness {
  const added: Harness["added"] = [];
  const warnings: Harness["warnings"] = [];
  const clock = new FakeClock();
  const queue = {
    add: (name: string, data: unknown, opts: unknown) => {
      added.push({ name, data, opts });
      return add(name, data, opts);
    },
  } as unknown as Queue;
  const logger = {
    warn: (fields: Record<string, unknown>, msg: string) => warnings.push({ fields, msg }),
  } as unknown as PinoLogger;
  const config = { get: (key: string) => CONFIG[key] } as unknown as ConfigService<
    PlatformBackendConfig,
    true
  >;
  const service = new OutboxService(
    { insertIfAbsent: () => Promise.resolve(true) } as unknown as OutboxRepository,
    {} as EnvelopeService,
    new IdGenerator(clock),
    clock,
    queue,
    logger,
    config,
  );
  return { service, added, warnings };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("idempotentEmailId", () => {
  it("derives one e-mail id per template, recipient (in any case) and key", () => {
    const id = idempotentEmailId("tenant.welcome", "ana@example.com", "job_1");

    expect(id).toMatch(EMAIL_ID);
    expect(idempotentEmailId("tenant.welcome", "Ana@Example.com", "job_1")).toBe(id);
    expect(
      new Set([
        id,
        idempotentEmailId("tenant.resumed", "ana@example.com", "job_1"),
        idempotentEmailId("tenant.welcome", "lena@example.com", "job_1"),
        idempotentEmailId("tenant.welcome", "ana@example.com", "job_2"),
      ]).size,
    ).toBe(4);
  });
});

describe("links", () => {
  it("builds links on PUBLIC_PORTAL_URL and PUBLIC_PLATFORM_ADMIN_URL only", () => {
    const { service } = harness(() => Promise.resolve());

    expect(publicBase("https://platform.example.com/portal/?x=1#y")).toBe(
      "https://platform.example.com/portal",
    );
    expect(service.portalLink("/verify-email", { token: "a b&c" })).toBe(
      "https://platform.example.com/verify-email?token=a+b%26c",
    );
    expect(service.adminLink("/tenants/ten_1")).toBe("https://admin.platform.example.com/tenants/ten_1");
    for (const path of ["verify-email", "//evil.example.net/x", "/x?y=1", "/x#y", "/x y"]) {
      expect(() => service.portalLink(path)).toThrow(InvalidEmailError);
    }
  });
});

describe("OutboxService.queue", () => {
  it("refuses a transaction that runInTransaction did not open, before anything is queued", async () => {
    const { service, added } = harness(() => Promise.resolve());

    await expect(
      service.queue({} as OutboxTransaction, {
        templateKey: "auth.password_changed",
        to: "ana@example.com",
        data: { fullName: "Ana Lima" },
      }),
    ).rejects.toBeInstanceOf(NotInTransactionError);
    expect(added).toEqual([]);
  });
});

describe("OutboxService.enqueue", () => {
  it("adds email.send with the e-mail id as payload and job id", async () => {
    const { service, added } = harness(() => Promise.resolve());

    await expect(service.enqueue("eml_01JTESTENQ0E0E000000000000", "auth.verify_email")).resolves.toBe(true);
    expect(added).toEqual([
      {
        name: EMAIL_SEND_JOB,
        data: { emailId: "eml_01JTESTENQ0E0E000000000000" },
        opts: { jobId: "eml_01JTESTENQ0E0E000000000000" },
      },
    ]);
  });

  it("logs a Redis failure and resolves to false, so the caller's committed request succeeds", async () => {
    const { service, warnings } = harness(() => Promise.reject(new Error("Connection is closed.")));

    await expect(service.enqueue("eml_01JTESTENQ0E0E000000000001", "auth.verify_email")).resolves.toBe(false);
    expect(warnings.map((warning) => warning.msg)).toEqual(["email.enqueue_failed"]);
    expect(warnings[0]?.fields).toMatchObject({ emailId: "eml_01JTESTENQ0E0E000000000001" });
  });

  it("gives up after ENQUEUE_TIMEOUT_MS when Redis does not answer, and leaves the row to the sweep", async () => {
    vi.useFakeTimers();
    const { service, warnings } = harness(() => new Promise(() => undefined));

    const result = service.enqueue("eml_01JTESTENQ0E0E000000000002", "auth.verify_email");
    await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);

    await expect(result).resolves.toBe(false);
    expect(warnings.map((warning) => warning.msg)).toEqual(["email.enqueue_timeout"]);
  });
});
