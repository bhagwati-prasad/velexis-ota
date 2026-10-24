// Who gets an OTA's staff alerts, without PostgreSQL (OBE-055; OADR-0013 item 5): `ops_alert_email`, else the owners
// read from the platform, else Velexis ops (OPS_ALERT_EMAIL, in both processes since FIX-W28-NOTIFY); one outbox row per
// recipient. The platform's tables, the outbox and Mailpit are used in
// test/integration/notifications/booking-emails.int.test.ts.
import { ConfigService } from "@nestjs/config";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { testApiVariables, testWorkerVariables } from "../../test/helpers/api-env";
import { loadApiConfig, loadWorkerConfig } from "../config";
import type { PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { TenantContext } from "../tenancy/tenant-context";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import type { EnqueueNotificationInput, OutboxService } from "./outbox.service";
import {
  MAX_OWNER_RECIPIENTS,
  ownerRecipients,
  staffDedupeKey,
  StaffRecipients,
  type StaffAlertInput,
} from "./staff-recipients";

const TENANT_ID = "ten_01J9ZA2B4C6D8E0F2G4H6J8K0M";
const OPS = "ops@alpha-travel.example";
const VELEXIS_OPS = "ops@velexis.example";

const OWNERS = [
  { accountId: "acc_01J9ZA2B4C6D8E0F2G4H6J8K01", email: "founder@alpha-travel.example" },
  { accountId: "acc_01J9ZA2B4C6D8E0F2G4H6J8K02", email: "partner@alpha-travel.example" },
];

const ALERT: StaffAlertInput = {
  templateKey: "staff.manual_review",
  locale: "en",
  bookingId: "bkg_01J9ZA2B4C6D8E0F2G4H6J8K0M",
  dedupeKey: "staff.manual_review:bkg_01J9ZA2B4C6D8E0F2G4H6J8K0M:capture_failed",
  data: {
    booking: {
      reference: "VX7K2M9Q",
      recordLocator: "",
      consoleUrl: "https://admin.ota.example.com/bookings/bkg_1",
    },
    review: { reason: "The capture failed." },
  },
};

/** A transaction whose only query, the settings row, answers `opsAlertEmail` (no row for `undefined`). */
function trxWith(opsAlertEmail: string | null | undefined): TenantTransaction {
  const query = {
    select: () => query,
    executeTakeFirst: () =>
      Promise.resolve(opsAlertEmail === undefined ? undefined : { ops_alert_email: opsAlertEmail }),
  };
  return { selectFrom: vi.fn(() => query) } as unknown as TenantTransaction;
}

function recipientsWith(options: {
  readonly owners?: readonly { accountId: string; email: string }[] | Error;
  readonly fallback?: string;
  /** A process's ConfigService instead of the stub that answers `fallback`. */
  readonly config?: ConfigService;
}) {
  const platform = {
    ownerEmails: vi.fn(() =>
      options.owners instanceof Error
        ? Promise.reject(options.owners)
        : Promise.resolve(options.owners ?? []),
    ),
  } as unknown as PlatformReadRepository;
  const tenants = { require: () => ({ tenantId: TENANT_ID }) } as unknown as TenantContext;
  const queued: EnqueueNotificationInput[] = [];
  const outbox = {
    enqueue: vi.fn((_trx: unknown, input: EnqueueNotificationInput) => {
      queued.push(input);
      return Promise.resolve({ notificationId: `ntf_${queued.length}`, queued: true });
    }),
  } as unknown as OutboxService;
  const config =
    options.config ??
    ({
      get: (name: string) => (name === "OPS_ALERT_EMAIL" ? options.fallback : undefined),
    } as unknown as ConfigService);
  const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as PinoLogger;
  return {
    service: new StaffRecipients(platform, tenants, outbox, config, logger),
    platform,
    queued,
    logger,
  };
}

describe("StaffRecipients.resolve", () => {
  it("[OBE-055 AC3] is the OTA's ops_alert_email when it is set, without reading the owners", async () => {
    const { service, platform } = recipientsWith({ owners: OWNERS, fallback: VELEXIS_OPS });

    expect(await service.resolve(trxWith(OPS))).toEqual([
      { email: OPS, source: "ops_alert_email", accountId: null },
    ]);
    expect(platform.ownerEmails).not.toHaveBeenCalled();
  });

  it("[OBE-055 AC3] is the owners' e-mails when ops_alert_email is not set, the founder first", async () => {
    const { service, platform } = recipientsWith({ owners: OWNERS, fallback: VELEXIS_OPS });

    for (const settings of [null, undefined]) {
      expect(await service.resolve(trxWith(settings))).toEqual([
        { email: OWNERS[0]?.email, source: "owner", accountId: OWNERS[0]?.accountId },
        { email: OWNERS[1]?.email, source: "owner", accountId: OWNERS[1]?.accountId },
      ]);
    }
    expect(platform.ownerEmails).toHaveBeenCalledWith(TENANT_ID, MAX_OWNER_RECIPIENTS);
  });

  it("skips an ops_alert_email that is not one address (logged, never the value) and takes the owners", async () => {
    const { service, logger } = recipientsWith({ owners: OWNERS });

    expect(
      (await service.resolve(trxWith("Ops <ops@alpha-travel.example>"))).map((entry) => entry.source),
    ).toEqual(["owner", "owner"]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      "notifications.ops_alert_email_invalid",
    );
  });

  it("falls back to Velexis ops (OPS_ALERT_EMAIL) without owners, or when they cannot be read", async () => {
    const none = recipientsWith({ owners: [], fallback: VELEXIS_OPS });
    const failing = recipientsWith({ owners: new Error("statement timeout"), fallback: VELEXIS_OPS });

    expect(await none.service.resolve(trxWith(null))).toEqual([
      { email: VELEXIS_OPS, source: "velexis_ops", accountId: null },
    ]);
    expect(await failing.service.resolve(trxWith(null))).toEqual([
      { email: VELEXIS_OPS, source: "velexis_ops", accountId: null },
    ]);
    expect(vi.mocked(failing.logger.error)).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, code: "Error" },
      "notifications.staff_owners_unreadable",
    );
  });

  it("is nobody in a process without OPS_ALERT_EMAIL (it is optional) for an OTA without an address or owners", async () => {
    const { service } = recipientsWith({ owners: [] });

    expect(await service.resolve(trxWith(null))).toEqual([]);
  });

  it("[FIX-W28-NOTIFY AC2] falls back to OPS_ALERT_EMAIL in the API as in the worker: each reads it from its own configuration", async () => {
    const services = {
      APP_ENV: "test",
      DATABASE_URL: "postgres://velexis_ota_app:dummy-ota-password@127.0.0.1:5432/velexis",
      REDIS_URL: "redis://:dummy-redis-password@127.0.0.1:6379/0",
      OPS_ALERT_EMAIL: VELEXIS_OPS,
    };
    const api = loadApiConfig({ ...services, ...testApiVariables() });
    const worker = loadWorkerConfig({
      ...services,
      ...testWorkerVariables(),
      OPS_ALERT_EMAIL: VELEXIS_OPS,
      DATABASE_PROVISIONER_URL: "postgres://velexis_provisioner:dummy-password@127.0.0.1:5432/velexis",
    });

    for (const config of [api, worker]) {
      const { service } = recipientsWith({ owners: [], config: new ConfigService(config) });

      expect(await service.resolve(trxWith(null))).toEqual([
        { email: VELEXIS_OPS, source: "velexis_ops", accountId: null },
      ]);
    }
  });
});

describe("ownerRecipients", () => {
  it("drops addresses that are not one plain address and repeated ones, and keeps at most MAX_OWNER_RECIPIENTS", () => {
    const many = Array.from({ length: MAX_OWNER_RECIPIENTS + 3 }, (_, index) => ({
      accountId: `acc_${String(index).padStart(26, "0")}`,
      email: `owner${index}@alpha-travel.example`,
    }));

    expect(
      ownerRecipients(
        [
          { accountId: "acc_1", email: "Founder@Alpha-Travel.example" },
          { accountId: "acc_2", email: "founder@alpha-travel.example" },
          { accountId: "acc_3", email: "not an address" },
        ],
        null,
      ),
    ).toEqual([{ email: "Founder@Alpha-Travel.example", source: "owner", accountId: "acc_1" }]);
    expect(ownerRecipients(many, null)).toHaveLength(MAX_OWNER_RECIPIENTS);
    expect(ownerRecipients([{ accountId: "acc_3", email: "not an address" }], VELEXIS_OPS)).toEqual([
      { email: VELEXIS_OPS, source: "velexis_ops", accountId: null },
    ]);
  });
});

describe("StaffRecipients.enqueue", () => {
  it("[OBE-055 AC3] queues one staff row per owner, the first with the caller's dedupe key", async () => {
    const { service, queued } = recipientsWith({ owners: OWNERS });

    const result = await service.enqueue(trxWith(null), ALERT);

    expect(result.queued).toBe(true);
    expect(queued).toEqual([
      { ...ALERT, to: OWNERS[0]?.email, recipientType: "staff", dedupeKey: ALERT.dedupeKey },
      {
        ...ALERT,
        to: OWNERS[1]?.email,
        recipientType: "staff",
        dedupeKey: `${ALERT.dedupeKey}:${OWNERS[1]?.accountId ?? ""}`,
      },
    ]);
  });

  it("[OBE-055 AC3] queues one row to ops_alert_email with the caller's dedupe key", async () => {
    const { service, queued } = recipientsWith({ owners: OWNERS });

    await service.enqueue(trxWith(OPS), ALERT);

    expect(queued).toEqual([{ ...ALERT, to: OPS, recipientType: "staff", dedupeKey: ALERT.dedupeKey }]);
  });

  it("queues nothing, and says so, without any recipient", async () => {
    const { service, queued, logger } = recipientsWith({ owners: [] });

    expect(await service.enqueue(trxWith(null), ALERT)).toEqual({ queued: false, recipients: [] });
    expect(queued).toEqual([]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { bookingId: ALERT.bookingId, template: "staff.manual_review" },
      "notifications.staff_alert_without_recipient",
    );
  });

  it("refuses a key that is not a staff alert", async () => {
    const { service } = recipientsWith({ owners: OWNERS });

    await expect(
      service.enqueue(trxWith(OPS), { ...ALERT, templateKey: "booking.confirmed" }),
    ).rejects.toThrow(TypeError);
  });

  it("staffDedupeKey keeps the key for the first recipient and the alert addresses, and adds the owner's id after", () => {
    const owner = { email: "a@b.example", source: "owner" as const, accountId: "acc_2" };
    const ops = { email: OPS, source: "ops_alert_email" as const, accountId: null };

    expect(staffDedupeKey("k", owner, 0)).toBe("k");
    expect(staffDedupeKey("k", owner, 1)).toBe("k:acc_2");
    expect(staffDedupeKey("k", ops, 0)).toBe("k");
  });
});
