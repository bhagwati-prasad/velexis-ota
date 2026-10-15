// AuditService.record on PostgreSQL (PBE-010; PADR-0006, Audit): the platform API with AuditModule on this file's own
// database clone (createTestApp), and test-only routes that change a row and audit it in one transaction of
// velexis_platform_app, as the modules of later tasks will. Proves that the audit row commits and rolls back with the
// change, carries the request context of PADR-0019 (request id, the end user's IP and user agent), stores `before`,
// `after` and `details` redacted, snapshots the actor's e-mail and the tenant key, and that the app role cannot
// change a stored row.
import { Body, Controller, Injectable, Post, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createPlatformDb,
  createPool,
  type Kysely,
  type PlatformDatabase,
  type ReferenceDatabase,
} from "@velexis/db";
import { AppError } from "@velexis/errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditModule } from "../../../src/audit/audit.module";
import { AuditService, type AuditEntry } from "../../../src/audit/audit.service";
import { RequestContext } from "../../../src/common/http/request-context";
import type { PlatformBackendConfig } from "../../../src/config";
import { createTestApp, type TestApp } from "../../support/app";
import { insertAccount, insertTenant, testId, type PlatformRow } from "../../builders/platform-rows";

// Test values only: documentation addresses (RFC 5737), made-up secrets and a made-up IBAN.
const PERSON_IP = "203.0.113.7";
const PERSON_AGENT = "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/131.0";
const CLIENT_SECRET = "test-only-client-secret-8c1d2e";
const IBAN = "XX00TEST0000111122223333";

type PlatformDb = Kysely<PlatformDatabase & ReferenceDatabase>;
type AuditRow = PlatformRow<"platform_audit_log">;

/** The test's own pool of velexis_platform_app on the application's DATABASE_URL, ended with the application. */
@Injectable()
class AuditTestDatabase implements OnApplicationShutdown {
  readonly pool: ReturnType<typeof createPool>;
  readonly db: PlatformDb;

  constructor(config: ConfigService<PlatformBackendConfig, true>) {
    this.pool = createPool(config.get("DATABASE_URL", { infer: true }), {
      applicationName: "platform-int-audit",
      logger: { error: () => undefined },
      max: 4,
    });
    this.db = createPlatformDb(this.pool);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

interface ChangeRequest {
  /** The tenant whose name the route changes (the state change the audit row records). */
  readonly tenantId: string;
  readonly name: string;
  /** The audit entry the route records in the same transaction. */
  readonly entry: AuditEntry;
  /** Throw after both writes, so the transaction rolls back. */
  readonly fail?: boolean;
}

interface ChangeAnswer {
  readonly requestId: string | null;
  readonly auditId: string;
}

/** Test-only route: a tenant rename and its audit row, in one transaction of velexis_platform_app. */
@Controller("test/audit")
class AuditTestController {
  constructor(
    private readonly database: AuditTestDatabase,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  @Post("change")
  async change(@Body() body: ChangeRequest): Promise<ChangeAnswer> {
    return this.database.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("platform.tenants")
        .set({ name: body.name })
        .where("id", "=", body.tenantId)
        .executeTakeFirstOrThrow();
      const recorded = await this.audit.record(trx, body.entry);
      if (body.fail === true) {
        throw new AppError("CONFLICT", { message: "The test route rolls its transaction back." });
      }
      return { requestId: this.context.requestId ?? null, auditId: recorded.id };
    });
  }
}

let t: TestApp;
let db: PlatformDb;
let admin: PlatformRow<"accounts">;
let tenant: PlatformRow<"tenants">;

beforeAll(async () => {
  t = await createTestApp({
    imports: [AuditModule],
    controllers: [AuditTestController],
    providers: [AuditTestDatabase],
  });
  const database = t.app.get(AuditTestDatabase);
  db = database.db;
  admin = await insertAccount(database.pool, {
    email: "lena.holm@velexis.example.com",
    is_platform_admin: true,
  });
  tenant = await insertTenant(database.pool, { key: "acme" });
});

afterAll(async () => {
  await t.close();
});

function suspension(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    actorType: "platform_admin",
    actorAccountId: admin.id,
    action: "tenant.suspended",
    targetType: "tenant",
    targetId: tenant.id,
    tenantId: tenant.id,
    details: { reason: "Card testing reported by Stripe." },
    ...overrides,
  };
}

async function auditRows(requestId: string): Promise<AuditRow[]> {
  return db
    .selectFrom("platform.platform_audit_log")
    .selectAll()
    .where("request_id", "=", requestId)
    .execute();
}

async function tenantName(): Promise<string> {
  const row = await db
    .selectFrom("platform.tenants")
    .select("name")
    .where("id", "=", tenant.id)
    .executeTakeFirstOrThrow();
  return row.name;
}

describe("AuditService.record in the caller's transaction", () => {
  it("leaves no row when the transaction rolls back [PBE-010 AC1]", async () => {
    const requestId = "req-audit-rolled-back-0001";
    const nameBefore = await tenantName();

    const res = await t.http
      .post("/test/audit/change")
      .set("X-Request-Id", requestId)
      .set(t.bffHeaders(PERSON_IP, PERSON_AGENT))
      .send({ tenantId: tenant.id, name: "Renamed and rolled back", entry: suspension(), fail: true });

    expect(res.status).toBe(409);
    expect(res.headers["x-request-id"]).toBe(requestId);
    expect(await auditRows(requestId)).toEqual([]);
    expect(await tenantName()).toBe(nameBefore);
  });

  it("commits the row with the change, carrying the request id, the end user's IP and user agent [PBE-010 AC1]", async () => {
    const requestId = "req-audit-committed-0001";

    const res = await t.http
      .post("/test/audit/change")
      .set("X-Request-Id", requestId)
      .set(t.bffHeaders(PERSON_IP, PERSON_AGENT))
      .send({ tenantId: tenant.id, name: "Acme Travel Committed", entry: suspension() });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ requestId, auditId: expect.stringMatching(/^[0-9]+$/) });
    expect(await tenantName()).toBe("Acme Travel Committed");
    const rows = await auditRows(requestId);
    expect(rows).toEqual([
      {
        id: (res.body as ChangeAnswer).auditId,
        tenant_id: tenant.id,
        tenant_key: "acme",
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        actor_label: "lena.holm@velexis.example.com",
        action: "tenant.suspended",
        target_type: "tenant",
        target_id: tenant.id,
        request_id: requestId,
        ip_address: PERSON_IP,
        user_agent: PERSON_AGENT,
        details: { reason: "Card testing reported by Stripe." },
        created_at: expect.any(Date),
      },
    ]);
  });

  it("stores before and after values holding clientSecret or iban redacted [PBE-010 AC2]", async () => {
    const requestId = "req-audit-redacted-0001";

    const res = await t.http
      .post("/test/audit/change")
      .set("X-Request-Id", requestId)
      .set(t.bffHeaders(PERSON_IP, PERSON_AGENT))
      .send({
        tenantId: tenant.id,
        name: "Acme Travel Redacted",
        entry: suspension({
          action: "connection.status_changed",
          targetType: "supplier_connection",
          targetId: testId("sc", 1),
          before: { status: "active", clientId: "client-1", clientSecret: CLIENT_SECRET },
          after: {
            status: "disabled",
            clientId: "client-1",
            clientSecret: CLIENT_SECRET,
            payout: { iban: IBAN },
          },
          details: { reason: "Abuse on a shared office.", iban: IBAN },
        }),
      });

    expect(res.status).toBe(201);
    const [row] = await auditRows(requestId);
    expect(row?.details).toEqual({
      reason: "Abuse on a shared office.",
      iban: "[REDACTED]",
      before: { status: "active", clientId: "client-1", clientSecret: "[REDACTED]" },
      after: {
        status: "disabled",
        clientId: "client-1",
        clientSecret: "[REDACTED]",
        payout: { iban: "[REDACTED]" },
      },
    });
    // The stored jsonb itself, as PostgreSQL prints it, holds neither value.
    const { rows: raw } = await t.app
      .get(AuditTestDatabase)
      .pool.query<{ details: string }>(
        "SELECT details::text AS details FROM platform.platform_audit_log WHERE request_id = $1",
        [requestId],
      );
    expect(raw).toHaveLength(1);
    expect(raw[0]?.details).not.toContain(CLIENT_SECRET);
    expect(raw[0]?.details).not.toContain(IBAN);
  });

  it("snapshots the key of a tenant created in the same transaction and the actor's e-mail, outside a request", async () => {
    const requestId = "req-audit-new-tenant-0001";
    const newTenantId = testId("ten", 9001);
    const audit = t.app.get(AuditService);

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("platform.tenants")
        .values({ id: newTenantId, key: "freshota", name: "Fresh OTA", plan_code: "early_access" })
        .execute();
      await audit.record(trx, {
        actorType: "account",
        actorAccountId: admin.id,
        action: "tenant.created",
        targetType: "tenant",
        targetId: newTenantId,
        tenantId: newTenantId,
        requestId,
        after: { key: "freshota", status: "provisioning" },
      });
    });

    expect(await auditRows(requestId)).toEqual([
      expect.objectContaining({
        tenant_id: newTenantId,
        tenant_key: "freshota",
        actor_type: "account",
        actor_account_id: admin.id,
        actor_label: "lena.holm@velexis.example.com",
        // Outside an HTTP request: the request id the caller (a job) carries, no IP and no user agent.
        request_id: requestId,
        ip_address: null,
        user_agent: null,
        details: { after: { key: "freshota", status: "provisioning" } },
      }),
    ]);
  });

  it("keeps the actor label and tenant key the caller gives, for a system actor without an account", async () => {
    const requestId = "req-audit-system-0001";
    const audit = t.app.get(AuditService);

    await db.transaction().execute(async (trx) =>
      audit.record(trx, {
        actorType: "system",
        actorLabel: "provisioning.activate",
        action: "tenant.activated",
        targetType: "tenant",
        targetId: tenant.id,
        tenantId: tenant.id,
        tenantKey: "acme-at-the-time",
        requestId,
        before: { status: "provisioning" },
        after: { status: "active" },
      }),
    );

    expect(await auditRows(requestId)).toEqual([
      expect.objectContaining({
        tenant_id: tenant.id,
        tenant_key: "acme-at-the-time",
        actor_type: "system",
        actor_account_id: null,
        actor_label: "provisioning.activate",
        details: { before: { status: "provisioning" }, after: { status: "active" } },
      }),
    ]);
  });
});

describe("the append-only audit trail (PADR-0006, Audit item 3)", () => {
  it("refuses UPDATE platform.platform_audit_log through the app role with a permission error [PBE-010 AC4]", async () => {
    const requestId = "req-audit-append-only-0001";
    await t.http
      .post("/test/audit/change")
      .set("X-Request-Id", requestId)
      .set(t.bffHeaders(PERSON_IP, PERSON_AGENT))
      .send({ tenantId: tenant.id, name: "Acme Travel Append Only", entry: suspension() })
      .expect(201);
    const [row] = await auditRows(requestId);
    const { rows: role } = await t.app
      .get(AuditTestDatabase)
      .pool.query<{ role: string }>("SELECT current_user AS role");
    expect(role).toEqual([{ role: "velexis_platform_app" }]);

    const update = db
      .updateTable("platform.platform_audit_log")
      .set({ action: "tenant.resumed", details: JSON.stringify({ reason: "edited" }) })
      .where("id", "=", row?.id ?? "0")
      .execute();
    const remove = db
      .deleteFrom("platform.platform_audit_log")
      .where("id", "=", row?.id ?? "0")
      .execute();

    await expect(update).rejects.toMatchObject({
      code: "42501",
      message: "permission denied for table platform_audit_log",
    });
    await expect(remove).rejects.toMatchObject({
      code: "42501",
      message: "permission denied for table platform_audit_log",
    });
    expect(await auditRows(requestId)).toEqual([row]);
  });
});
