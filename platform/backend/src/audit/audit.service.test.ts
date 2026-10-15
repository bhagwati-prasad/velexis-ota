// Unit tests of the audit module (PBE-010): the action list against the flows and the OpenAPI document, the entry
// rules, the redaction of `before`, `after` and `details`, and what AuditService.record hands to the repository from
// the request context. The insert itself, the transaction and the table privileges are proven by
// test/integration/audit/audit.int.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Test } from "@nestjs/testing";
import { REDACT_CENSOR } from "@velexis/logger";
import type { ClsService } from "nestjs-cls";
import { describe, expect, it, vi } from "vitest";
import { PlatformOpenApi } from "../common/http/openapi-validation.interceptor";
import { RequestContext, type RequestContextStore } from "../common/http/request-context";
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  isAuditAction,
  isAuditTargetType,
  type AuditAction,
} from "./audit-actions";
import { AuditModule } from "./audit.module";
import { AuditRepository, type AuditRowInsert, type PlatformTransaction } from "./audit.repository";
import {
  assertValidAuditEntry,
  auditDetails,
  AuditService,
  InvalidAuditEntryError,
  type AuditEntry,
} from "./audit.service";

// Test values only: made-up ids, a made-up client secret and IBAN, documentation addresses (RFC 5737).
const ACCOUNT_ID = "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const CLIENT_SECRET = "test-only-client-secret-5d7e9f";
const IBAN = "XX00TEST0000111122223333";
const PLATFORM_DOCS = resolve(__dirname, "..", "..", "..", "docs");

type JsonObject = Record<string, unknown>;

function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    current = (current as JsonObject | undefined)?.[key];
  }
  return current;
}

/** The dotted action names the flows say are audited ("audit `x.y`", "audits `x.y`", the Tables touched rows). */
function actionsNamedInFlows(): Set<string> {
  const named = new Set<string>();
  const dir = join(PLATFORM_DOCS, "flows");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const match of text.matchAll(/\baudits?:? +`?([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`?/gi)) {
      named.add(match[1] ?? "");
    }
    for (const row of text.matchAll(/^\| `platform_audit_log` \|(.*)\|$/gm)) {
      for (const name of (row[1] ?? "").matchAll(/`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`/g)) {
        named.add(name[1] ?? "");
      }
    }
  }
  return named;
}

/** Changes to a valid entry; `undefined` removes the property. */
type EntryOverrides = { readonly [K in keyof AuditEntry]?: AuditEntry[K] | undefined };

function validEntry(overrides: EntryOverrides = {}): AuditEntry {
  const entry = {
    actorType: "platform_admin",
    actorAccountId: ACCOUNT_ID,
    action: "tenant.suspended",
    targetType: "tenant",
    targetId: TENANT_ID,
    tenantId: TENANT_ID,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  ) as unknown as AuditEntry;
}

/** A RequestContext over a stand-in for nestjs-cls: active with `store`, or outside a request. */
function requestContext(store?: Partial<RequestContextStore>): RequestContext {
  const cls = {
    isActive: () => store !== undefined,
    get: (key: keyof RequestContextStore) => store?.[key],
  };
  return new RequestContext(cls as unknown as ClsService<RequestContextStore>);
}

function serviceWith(context?: RequestContext): {
  service: AuditService;
  inserts: AuditRowInsert[];
  trx: PlatformTransaction;
} {
  const inserts: AuditRowInsert[] = [];
  const repository = {
    insert: vi.fn((_trx: PlatformTransaction, row: AuditRowInsert) => {
      inserts.push(row);
      return Promise.resolve({ id: "1", createdAt: new Date("2026-01-15T10:00:00.000Z") });
    }),
  };
  return {
    service: new AuditService(repository as unknown as AuditRepository, context),
    inserts,
    trx: {} as PlatformTransaction,
  };
}

describe("audit-actions.ts", () => {
  const document = PlatformOpenApi.load().document;

  it("names every action the flows audit and every action the plan names (PADR-0006 item 6)", () => {
    const named = actionsNamedInFlows();
    expect(named.size).toBeGreaterThanOrEqual(20);
    // PBE-010's examples, and the actions later tasks of platform/docs/plans/agent-tasks.md audit by name.
    const listed = [
      "account.signed_up",
      "auth.sign_in",
      "auth.locked",
      "tenant.created",
      "tenant.activated",
      "tenant.suspended",
      "console.token_issued",
      "api_key.created",
      "amadeus.credentials_applied",
      "payments.connect_connected",
      "account.email_verified",
      "tenant.updated",
      "tenant.provisioning_failed",
      "tenant.went_live",
      "amadeus.settings_updated",
      "amadeus.credentials_submitted",
      "payments.descriptor_updated",
    ];
    for (const action of [...named, ...listed]) {
      expect(AUDIT_ACTIONS, `${action} is audited in the docs`).toContain(action);
    }
  });

  it("holds each action once, each matching the OpenAPI document's action pattern and length", () => {
    const schema = at(document, "components", "schemas", "AuditEntry", "properties", "action") as JsonObject;
    const parameter = at(document, "components", "parameters", "AuditAction", "schema") as JsonObject;
    const pattern = new RegExp(String(schema["pattern"]));
    expect(parameter["pattern"]).toBe(schema["pattern"]);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(pattern);
      expect(action.length).toBeLessThanOrEqual(Number(parameter["maxLength"]));
    }
  });

  it("holds each target type once, each matching the targetType filter of adminListAudit", () => {
    const parameter = at(document, "components", "parameters", "AuditTargetType", "schema") as JsonObject;
    expect(new Set(AUDIT_TARGET_TYPES).size).toBe(AUDIT_TARGET_TYPES.length);
    for (const targetType of AUDIT_TARGET_TYPES) {
      expect(targetType).toMatch(new RegExp(String(parameter["pattern"])));
      expect(targetType.length).toBeLessThanOrEqual(Number(parameter["maxLength"]));
    }
  });

  it("tells actions and target types from other strings at run time", () => {
    expect(isAuditAction("tenant.suspended")).toBe(true);
    expect(isAuditAction("tenant.suspend")).toBe(false);
    expect(isAuditAction(42)).toBe(false);
    expect(isAuditTargetType("api_key")).toBe(true);
    expect(isAuditTargetType("apikey")).toBe(false);
  });
});

describe("auditDetails", () => {
  it("stores before and after values holding clientSecret or iban redacted, and leaves the caller's objects unchanged [PBE-010 AC2]", () => {
    const before = { status: "active", clientSecret: CLIENT_SECRET, bank: { iban: IBAN, last4: "3333" } };
    const after = { status: "disabled", clientSecret: CLIENT_SECRET, iban: IBAN };
    const details = { reason: "Rotated after a suspected leak.", settings: { clientSecret: CLIENT_SECRET } };
    const snapshot = structuredClone({ before, after, details });

    const stored = auditDetails({ before, after, details });

    expect(stored).toEqual({
      reason: "Rotated after a suspected leak.",
      settings: { clientSecret: REDACT_CENSOR },
      before: { status: "active", clientSecret: REDACT_CENSOR, bank: { iban: REDACT_CENSOR, last4: "3333" } },
      after: { status: "disabled", clientSecret: REDACT_CENSOR, iban: REDACT_CENSOR },
    });
    expect(JSON.stringify(stored)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(stored)).not.toContain(IBAN);
    expect({ before, after, details }).toEqual(snapshot);
  });

  it("builds the details of the OpenAPI example: the details first, then before and after", () => {
    const example = at(
      PlatformOpenApi.load().document,
      "paths",
      "/v1/admin/audit-log",
      "get",
      "responses",
      "200",
      "content",
      "application/json",
      "example",
      "data",
    ) as JsonObject[];
    const expected = example[0]?.["details"] as JsonObject;

    const stored = auditDetails({
      details: { reason: expected["reason"] },
      before: { status: "active" },
      after: { status: "suspended", suspensionReason: "abuse" },
    });

    expect(stored).toEqual(expected);
    expect(Object.keys(stored)).toEqual(["reason", "before", "after"]);
  });

  it("stores an empty object without details, before and after", () => {
    expect(auditDetails({})).toEqual({});
  });
});

describe("assertValidAuditEntry", () => {
  it("accepts an admin, an account, a system and an API key actor", () => {
    expect(() => assertValidAuditEntry(validEntry())).not.toThrow();
    expect(() => assertValidAuditEntry(validEntry({ actorType: "account" }))).not.toThrow();
    expect(() =>
      assertValidAuditEntry(
        validEntry({ actorType: "system", actorAccountId: undefined, actorLabel: "provisioning.activate" }),
      ),
    ).not.toThrow();
    expect(() =>
      assertValidAuditEntry(
        validEntry({ actorType: "api_key", actorAccountId: undefined, actorLabel: "vx_pk_t1" }),
      ),
    ).not.toThrow();
  });

  const invalid: ReadonlyArray<[string, EntryOverrides | JsonObject, RegExp]> = [
    ["an unknown action", { action: "tenant.suspend" as AuditAction }, /unknown audit action/],
    ["an unknown target type", { targetType: "tenants" }, /unknown audit target type/],
    ["an unknown actor type", { actorType: "staff" }, /unknown actor type/],
    ["an admin without an account id", { actorAccountId: undefined }, /needs its acc_ id/],
    [
      "an account actor with another id",
      { actorType: "account", actorAccountId: TENANT_ID },
      /needs its acc_ id/,
    ],
    ["a system actor with an account id", { actorType: "system" }, /has no account id/],
    ["a tenant id that is not a ten_ id", { tenantId: ACCOUNT_ID }, /ten_ id/],
    ["before that is not a plain object", { before: ["active"] }, /before must be a plain object/],
    ["after that is a date", { after: new Date() }, /after must be a plain object/],
    ["details that hold before", { details: { before: { status: "active" } } }, /details cannot hold before/],
  ];
  for (const [name, overrides, message] of invalid) {
    it(`refuses ${name}`, () => {
      expect(() => assertValidAuditEntry(validEntry(overrides as EntryOverrides))).toThrow(
        expect.objectContaining({ name: "InvalidAuditEntryError", message: expect.stringMatching(message) }),
      );
    });
  }
});

describe("AuditService.record", () => {
  it("takes the request id, the end user's IP and user agent from the request context", async () => {
    const context = requestContext({
      requestId: "req-audit-unit-1",
      ip: "203.0.113.7",
      userAgent: "Firefox/131.0",
    });
    const { service, inserts, trx } = serviceWith(context);

    const recorded = await service.record(
      trx,
      validEntry({ requestId: "job-request-id", details: { reason: "abuse" } }),
    );

    expect(recorded).toEqual({ id: "1", createdAt: new Date("2026-01-15T10:00:00.000Z") });
    expect(inserts).toEqual([
      {
        actorType: "platform_admin",
        actorAccountId: ACCOUNT_ID,
        actorLabel: null,
        action: "tenant.suspended",
        targetType: "tenant",
        targetId: TENANT_ID,
        tenantId: TENANT_ID,
        tenantKey: null,
        requestId: "req-audit-unit-1",
        ipAddress: "203.0.113.7",
        userAgent: "Firefox/131.0",
        detailsJson: JSON.stringify({ reason: "abuse" }),
      },
    ]);
  });

  it("outside a request uses the job's request id and stores no IP or user agent", async () => {
    for (const context of [undefined, requestContext()]) {
      const { service, inserts, trx } = serviceWith(context);

      await service.record(trx, {
        actorType: "system",
        actorLabel: "provisioning.activate",
        action: "tenant.activated",
        targetType: "tenant",
        targetId: TENANT_ID,
        tenantId: TENANT_ID,
        tenantKey: "acme",
        requestId: "req-from-the-job-1",
        after: { status: "active" },
      });

      expect(inserts[0]).toMatchObject({
        actorType: "system",
        actorAccountId: null,
        actorLabel: "provisioning.activate",
        tenantKey: "acme",
        requestId: "req-from-the-job-1",
        ipAddress: null,
        userAgent: null,
        detailsJson: JSON.stringify({ after: { status: "active" } }),
      });
    }
  });

  it("writes before and after holding clientSecret or iban redacted [PBE-010 AC2]", async () => {
    const { service, inserts, trx } = serviceWith(requestContext({ requestId: "req-audit-unit-2" }));

    await service.record(
      trx,
      validEntry({
        action: "amadeus_account.updated",
        targetType: "amadeus_account",
        targetId: "ama_01JA2ZB2C4D6E8F0G2H4J6K8M0",
        tenantId: undefined,
        before: { clientId: "client-1", clientSecret: CLIENT_SECRET },
        after: { clientId: "client-2", clientSecret: CLIENT_SECRET, payout: { iban: IBAN } },
      }),
    );

    const details = JSON.parse(inserts[0]?.detailsJson ?? "{}") as JsonObject;
    expect(details).toEqual({
      before: { clientId: "client-1", clientSecret: REDACT_CENSOR },
      after: { clientId: "client-2", clientSecret: REDACT_CENSOR, payout: { iban: REDACT_CENSOR } },
    });
    expect(inserts[0]?.detailsJson).not.toContain(CLIENT_SECRET);
    expect(inserts[0]?.detailsJson).not.toContain(IBAN);
  });

  it("refuses an invalid entry before the repository is called", async () => {
    const { service, inserts, trx } = serviceWith(requestContext({ requestId: "req-audit-unit-3" }));

    await expect(service.record(trx, validEntry({ actorAccountId: undefined }))).rejects.toBeInstanceOf(
      InvalidAuditEntryError,
    );
    expect(inserts).toEqual([]);
  });
});

describe("AuditModule", () => {
  it("builds without the API's request context, as the worker and the CLI import it, and records without IP or user agent", async () => {
    const inserts: AuditRowInsert[] = [];
    // No CommonModule.forApi(): the graph has no RequestContext provider, as in WorkerModule and the CLI.
    const moduleRef = await Test.createTestingModule({ imports: [AuditModule] })
      .overrideProvider(AuditRepository)
      .useValue({
        insert: (_trx: PlatformTransaction, row: AuditRowInsert) => {
          inserts.push(row);
          return Promise.resolve({ id: "7", createdAt: new Date("2026-01-15T10:00:00.000Z") });
        },
      })
      .compile();
    try {
      await moduleRef.get(AuditService).record({} as PlatformTransaction, {
        actorType: "system",
        actorLabel: "admin:grant by lena",
        action: "admin.granted",
        targetType: "account",
        targetId: ACCOUNT_ID,
        requestId: "req-from-the-cli-1",
        details: { reason: "First platform admin." },
      });
    } finally {
      await moduleRef.close();
    }

    expect(inserts).toEqual([
      {
        actorType: "system",
        actorAccountId: null,
        actorLabel: "admin:grant by lena",
        action: "admin.granted",
        targetType: "account",
        targetId: ACCOUNT_ID,
        tenantId: null,
        tenantKey: null,
        requestId: "req-from-the-cli-1",
        ipAddress: null,
        userAgent: null,
        detailsJson: JSON.stringify({ reason: "First platform admin." }),
      },
    ]);
  });
});
