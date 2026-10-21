// The console audit (OBE-060; OADR-0011 point 8, db README §8): the staff_actions row builder and its redaction, the
// action and target of a console call, and StaffActionsWriter and StaffActionsInterceptor over a recording
// transaction, without a database. The rows in PostgreSQL, through the API's pipeline:
// test/integration/console/console-access.int.test.ts. Every id, token and number here is made up on the spot.
import { randomBytes } from "node:crypto";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AppError } from "@velexis/errors";
import type { ClsService } from "nestjs-cls";
import type { PinoLogger } from "nestjs-pino";
import { lastValueFrom, of, throwError } from "rxjs";
import { describe, expect, it } from "vitest";
import type { StaffContext, StaffPrincipal } from "../common/auth/staff.guard";
import { OPENAPI_OPERATION } from "../common/http/openapi-operation.decorator";
import type { RequestContext } from "../common/http/request-context";
import { newId, type IdGenerator } from "../common/ids";
import type { Caller, CallerContext } from "../tenancy/caller-resolver";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import {
  auditedParams,
  consoleAction,
  consoleTarget,
  failureOutcome,
  StaffActionsInterceptor,
  StaffActionsWriter,
  staffActionRow,
  type StaffActionActor,
  type StaffActionRequest,
} from "./staff-actions.writer";

const STAFF_ID = "stf_01JA2Z9W5K7Q3M8N4P6R2T0V1D";
const ACCOUNT_ID = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1C";
const STAFF: StaffActionActor = {
  type: "staff",
  staffId: STAFF_ID,
  accountId: ACCOUNT_ID,
  email: "maria.lopez@example.com",
  role: "agent",
};
const REQUEST: StaffActionRequest = {
  actor: STAFF,
  requestId: "req-console-1",
  ip: "203.0.113.24",
  userAgent: "Mozilla/5.0 (console test)",
};

describe("staffActionRow", () => {
  it("writes the actor columns staff_actions_actor_ck expects for each kind of actor", () => {
    const keyId = newId("key");
    const rows = {
      staff: staffActionRow("sact_1", { action: "bookings.get" }, REQUEST),
      key: staffActionRow("sact_2", { action: "bookings.list", actor: { type: "api_key", keyId } }, REQUEST),
      email: staffActionRow(
        "sact_3",
        {
          action: "staff.sign_in",
          outcome: "denied",
          actor: { type: "staff_email", email: "former@example.com", accountId: null },
        },
        REQUEST,
      ),
      system: staffActionRow("sact_4", { action: "booking.sync", actor: { type: "system" } }, REQUEST),
    };

    expect(rows.staff).toMatchObject({
      actor_type: "staff",
      actor_id: STAFF_ID,
      staff_id: STAFF_ID,
      account_id: ACCOUNT_ID,
      staff_email: "maria.lopez@example.com",
      staff_role: "agent",
      outcome: "succeeded",
      request_id: "req-console-1",
      ip_address: "203.0.113.24",
      user_agent: "Mozilla/5.0 (console test)",
    });
    expect(rows.key).toMatchObject({
      actor_type: "api_key",
      actor_id: keyId,
      staff_id: null,
      staff_role: null,
    });
    expect(rows.email).toMatchObject({
      actor_type: "staff",
      actor_id: null,
      staff_id: null,
      outcome: "denied",
    });
    expect(rows.system).toMatchObject({ actor_type: "system", actor_id: null, staff_id: null });
    expect(() =>
      staffActionRow(
        "sact_5",
        { action: "staff.sign_in", actor: { type: "staff_email", email: "x@example.com", accountId: null } },
        REQUEST,
      ),
    ).toThrow(TypeError);
  });

  it("keeps no token and no full document number in before and after [OBE-060 AC4]", () => {
    const passport = `P${randomBytes(4).toString("hex").toUpperCase()}`;
    const accessToken = `eyJ${randomBytes(24).toString("base64url")}`;
    const refreshToken = `srt_${randomBytes(24).toString("base64url")}`;
    const before = {
      travelers: [
        {
          id: "1",
          name: { firstName: "ANNA", lastName: "BERG" },
          documents: [
            { documentType: "PASSPORT", number: passport, birthPlace: "Madrid", issuanceCountry: "ES" },
          ],
          discountEligibility: [{ subtype: "SPANISH_RESIDENT", cardNumber: "12345678Z" }],
        },
      ],
      formOfPayments: [
        { creditCard: { number: "4242424242424242", securityCode: "123", holder: "ANNA BERG" } },
      ],
      session: { accessToken, refreshToken },
      bookingToken: `bt_${randomBytes(16).toString("hex")}`,
    };
    const after = { ...before, remarks: ["VELEXIS VX7K2M"] };

    const row = staffActionRow("sact_1", { action: "booking.patch", before, after }, REQUEST);
    const text = JSON.stringify(row);

    expect(typeof row.before).toBe("string");
    for (const secret of [
      passport,
      accessToken,
      refreshToken,
      "4242424242424242",
      "12345678Z",
      before.bookingToken,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("securityCode");
    expect(text).not.toContain("Madrid");
    const parsed = JSON.parse(String(row.after)) as typeof before;
    expect(parsed.travelers[0]?.documents[0]?.number).toMatch(new RegExp(`${passport.slice(-4)}$`));
    expect(parsed.travelers[0]?.documents[0]?.number).not.toBe(passport);
    expect(parsed.formOfPayments[0]?.creditCard.number).toMatch(/4242$/);
    expect(parsed.session).toEqual({ accessToken: "[REDACTED]", refreshToken: "[REDACTED]" });
    expect(parsed.travelers[0]?.name).toEqual({ firstName: "ANNA", lastName: "BERG" });
  });

  it("keeps the IP only when it is an address, and cuts the user agent and the free text", () => {
    const row = staffActionRow(
      "sact_1",
      { action: "booking.cancel", reason: "x".repeat(5000), targetType: "booking", targetId: "bkg_1" },
      { ...REQUEST, ip: "unknown", userAgent: "a".repeat(700) },
    );

    expect(row.ip_address).toBeNull();
    expect(row.user_agent).toHaveLength(512);
    expect(row.reason).toHaveLength(2000);
    expect([row.target_type, row.target_id, row.before, row.after, row.booking_id]).toEqual([
      "booking",
      "bkg_1",
      null,
      null,
      null,
    ]);
    expect(staffActionRow("sact_2", { action: "x" }, { ...REQUEST, ip: "2001:db8::7" }).ip_address).toBe(
      "2001:db8::7",
    );
  });
});

describe("the action, target and outcome of a console call", () => {
  it("names the action after the SDK method and the target after the last …Id path parameter", () => {
    expect(consoleAction("consoleGetBooking")).toBe("bookings.get");
    expect(consoleAction("consoleCreateMarkupRule")).toBe("settings.markupRules.create");
    expect(consoleAction("createFlightSearch")).toBe("flights.search");
    expect(consoleTarget("consoleGetBooking", { bookingId: "bkg_01JA" })).toEqual({
      targetType: "booking",
      targetId: "bkg_01JA",
    });
    expect(consoleTarget("consoleUpdateMarkupRule", { markupRuleId: "mkr_1" })).toEqual({
      targetType: "markup_rule",
      targetId: "mkr_1",
    });
    expect(consoleTarget("consoleListBookings", {})).toEqual({ targetType: null, targetId: null });
    expect(consoleTarget("consoleGetBooking", undefined)).toEqual({ targetType: null, targetId: null });
  });

  it("counts permission refusals of a use case as denials and everything else as failures", () => {
    expect(failureOutcome(new AppError("FORBIDDEN"))).toBe("denied");
    expect(failureOutcome(new AppError("OFFICE_NOT_ALLOWED"))).toBe("denied");
    expect(failureOutcome(new AppError("NOT_FOUND"))).toBe("failed");
    expect(failureOutcome(new Error("boom"))).toBe("failed");
    expect(failureOutcome(new AppError("VALIDATION_FAILED", { fieldErrors: [] }))).toBe("failed");
  });

  it("never takes a path parameter that request validation refused as the target, and keeps the others [FIX-W24-ADR AC3]", () => {
    const params = { bookingId: `pasted ${randomBytes(4).toString("hex")}`, queueId: "12" };
    const refusedPath = new AppError("VALIDATION_FAILED", {
      fieldErrors: [
        { path: "/path/bookingId", code: "pattern", message: "does not have the expected format" },
        { path: "/query/limit", code: "type", message: "must be of type integer" },
      ],
    });
    const refusedQuery = new AppError("VALIDATION_FAILED", {
      fieldErrors: [{ path: "/query/limit", code: "type", message: "must be of type integer" }],
    });

    expect(auditedParams(params, refusedPath)).toEqual({ queueId: "12" });
    expect(consoleTarget("consoleGetBooking", auditedParams(params, refusedPath))).toEqual({
      targetType: null,
      targetId: null,
    });
    expect(auditedParams(params, refusedQuery)).toEqual(params);
    expect(auditedParams(params, new AppError("NOT_FOUND"))).toBe(params);
    expect(auditedParams(undefined, refusedPath)).toBeUndefined();
  });
});

/** A writer over a recording transaction, with the request's caller, staff member and end user. */
function writerHarness(
  options: { caller?: Caller; principal?: boolean; tenant?: boolean; failing?: boolean } = {},
) {
  const rows: Array<Record<string, unknown>> = [];
  const store = new Map<string, unknown>();
  const cls = {
    isActive: () => true,
    get: (name: string) => store.get(name),
    set: (name: string, value: unknown) => store.set(name, value),
  } as unknown as ClsService;
  const trx = {
    insertInto: () => ({
      values: (row: Record<string, unknown>) => ({
        execute: () => {
          if (options.failing === true) {
            return Promise.reject(new Error("connection lost"));
          }
          rows.push(row);
          return Promise.resolve([]);
        },
      }),
    }),
  };
  const tx = { run: (fn: (t: unknown) => Promise<unknown>) => fn(trx) } as unknown as TenantTx;
  const principal: StaffPrincipal = {
    family: { id: newId("asn"), staffId: STAFF_ID, role: "agent" } as StaffPrincipal["family"],
    member: {
      role: "agent",
      accountId: ACCOUNT_ID,
      account: { email: "maria.lopez@example.com" },
    } as StaffPrincipal["member"],
    accessTokenExpiresAt: new Date(),
  };
  const lines: string[] = [];
  const logger = {
    info: (_fields: unknown, msg: string) => lines.push(msg),
    error: (_fields: unknown, msg: string) => lines.push(msg),
  } as unknown as PinoLogger;
  const writer = new StaffActionsWriter(
    tx,
    { newId: (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}` } as unknown as IdGenerator,
    {
      get: () =>
        options.tenant === false
          ? undefined
          : ({ requestId: "req-console-2", environment: "test" } as RequestTenant),
    } as unknown as TenantContext,
    { get: () => options.caller ?? { type: "service", id: "service" } } as unknown as CallerContext,
    { get: () => (options.principal === false ? undefined : principal) } as unknown as StaffContext,
    {
      endUser: () => ({ ip: "198.51.100.77", userAgent: "Mozilla/5.0 (staff)" }),
      requestId: () => "req-console-2",
    } as unknown as RequestContext,
    cls,
    logger,
  );
  return { writer, rows, lines, cls };
}

describe("StaffActionsWriter", () => {
  it("records the request's staff member with the forwarded IP and user agent, once per request", async () => {
    const { writer, rows } = writerHarness();

    expect(writer.recorded()).toBe(false);
    await writer.recordAlone({ action: "booking.issue", targetType: "booking", targetId: "bkg_1" });
    await writer.recordCall("consoleIssueBooking", { bookingId: "bkg_1" }, "succeeded");

    expect(writer.recorded()).toBe(true);
    expect(rows).toEqual([
      expect.objectContaining({
        actor_type: "staff",
        staff_id: STAFF_ID,
        action: "booking.issue",
        request_id: "req-console-2",
        ip_address: "198.51.100.77",
        user_agent: "Mozilla/5.0 (staff)",
      }),
    ]);
  });

  it("records a key-only call as the key, and nothing for a request without an actor or a tenant", async () => {
    const keyId = newId("key");
    const keyCaller: Caller = {
      type: "key",
      id: keyId,
      keyId,
      kind: "secret",
      tenantId: newId("ten"),
      environment: "test",
      scopes: ["console:automation"],
    };
    const automation = writerHarness({ caller: keyCaller, principal: false });
    await automation.writer.recordCall("consoleListBookings", {}, "succeeded");
    expect(automation.rows).toEqual([expect.objectContaining({ actor_type: "api_key", actor_id: keyId })]);

    const nobody = writerHarness({ principal: false });
    await nobody.writer.recordCall("consoleListBookings", {}, "succeeded");
    await nobody.writer.recordDenial("consoleListBookings", {}, new AppError("FORBIDDEN"));
    await expect(nobody.writer.recordAlone({ action: "x" })).rejects.toThrow(TypeError);
    const noTenant = writerHarness({ tenant: false });
    await noTenant.writer.recordCall("consoleListBookings", {}, "succeeded");
    expect([...nobody.rows, ...noTenant.rows]).toEqual([]);
  });

  it("writes the failure row of a call whose use case wrote its row in a transaction that rolled back", async () => {
    // The use case's transaction: its row is gone when the failure rolls it back.
    const useCaseRows: unknown[] = [];
    const useCaseTrx = {
      insertInto: () => ({
        values: (row: unknown) => ({
          execute: () => {
            useCaseRows.push(row);
            return Promise.resolve([]);
          },
        }),
      }),
    } as unknown as TenantTransaction;
    const entry = { action: "booking.cancel", targetType: "booking", targetId: "bkg_1" };

    const failed = writerHarness();
    await failed.writer.record(useCaseTrx, entry);
    expect([failed.writer.recorded(), failed.writer.recordedAlone()]).toEqual([true, false]);
    await failed.writer.recordCall("consoleCancelBooking", { bookingId: "bkg_1" }, "failed");
    expect(failed.rows).toEqual([
      expect.objectContaining({
        action: consoleAction("consoleCancelBooking"),
        target_id: "bkg_1",
        outcome: "failed",
      }),
    ]);

    // A succeeded call counts the use case's row; a failed one a row the use case committed on its own.
    const succeeded = writerHarness();
    await succeeded.writer.record(useCaseTrx, entry);
    await succeeded.writer.recordCall("consoleCancelBooking", { bookingId: "bkg_1" }, "succeeded");
    const alone = writerHarness();
    await alone.writer.recordAlone({ ...entry, outcome: "denied" });
    await alone.writer.recordCall("consoleCancelBooking", { bookingId: "bkg_1" }, "denied");

    expect(succeeded.rows).toEqual([]);
    expect(alone.rows).toEqual([expect.objectContaining({ action: "booking.cancel", outcome: "denied" })]);
    expect(useCaseRows).toHaveLength(2);
  });

  it("writes a denial as denied, and keeps the refusal when the row cannot be written", async () => {
    const { writer, rows } = writerHarness();
    await writer.recordDenial(
      "consoleCreateMarkupRule",
      {},
      new AppError("FORBIDDEN", { details: { requiredPermission: "settings:write" } }),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        action: "settings.markupRules.create",
        outcome: "denied",
        staff_role: "agent",
      }),
    ]);

    const failing = writerHarness({ failing: true });
    await expect(
      failing.writer.recordDenial("consoleCreateMarkupRule", {}, new AppError("FORBIDDEN")),
    ).resolves.toBe(undefined);
    expect(failing.lines).toEqual(["staff_actions.write_failed"]);
  });
});

describe("StaffActionsInterceptor", () => {
  class Handlers {
    list(): void {}
    me(): void {}
    get(): void {}
  }
  Reflect.defineMetadata(OPENAPI_OPERATION, "consoleListBookings", Handlers.prototype.list);
  Reflect.defineMetadata(OPENAPI_OPERATION, "consoleGetMe", Handlers.prototype.me);
  Reflect.defineMetadata(OPENAPI_OPERATION, "consoleGetBooking", Handlers.prototype.get);

  function interceptor(consoleScope = true) {
    const harness = writerHarness();
    const context = { isConsoleScope: () => consoleScope } as unknown as RequestContext;
    const logger = { error: () => undefined } as unknown as PinoLogger;
    return {
      ...harness,
      interceptor: new StaffActionsInterceptor(new Reflector(), context, harness.writer, logger),
    };
  }

  const execution = (handler: () => void, params: Record<string, string> = {}): ExecutionContext =>
    ({
      getType: () => "http",
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ params }) }),
    }) as unknown as ExecutionContext;

  const answering = (value: unknown): CallHandler => ({ handle: () => of(value) });
  const failing = (error: unknown): CallHandler => ({ handle: () => throwError(() => error) });

  it("writes one succeeded row after a console call, and passes the answer on", async () => {
    const { interceptor: audit, rows } = interceptor();

    const body = await lastValueFrom(
      audit.intercept(execution(Handlers.prototype.list), answering({ data: [] })),
    );

    expect(body).toEqual({ data: [] });
    expect(rows).toEqual([expect.objectContaining({ action: "bookings.list", outcome: "succeeded" })]);
  });

  it("writes a failed or denied row for a call whose handler threw, and rethrows its error", async () => {
    const notFound = interceptor();
    await expect(
      lastValueFrom(
        notFound.interceptor.intercept(
          execution(Handlers.prototype.list),
          failing(new AppError("NOT_FOUND")),
        ),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const office = interceptor();
    await expect(
      lastValueFrom(
        office.interceptor.intercept(
          execution(Handlers.prototype.list),
          failing(new AppError("OFFICE_NOT_ALLOWED")),
        ),
      ),
    ).rejects.toMatchObject({ code: "OFFICE_NOT_ALLOWED" });

    expect([...notFound.rows, ...office.rows].map((row) => row["outcome"])).toEqual(["failed", "denied"]);
  });

  it("writes a failed row for a call that request validation refused inside it, with nothing of the request [FIX-W24-ADR AC3]", async () => {
    // The validation interceptor runs inside this one (app.module.ts): its refusal arrives as the handler's error.
    const pasted = `4111 ${randomBytes(4).toString("hex")}`;
    const refusal = (path: string) =>
      new AppError("VALIDATION_FAILED", {
        fieldErrors: [{ path, code: "pattern", message: "does not have the expected format" }],
      });
    const badQuery = interceptor();
    await expect(
      lastValueFrom(
        badQuery.interceptor.intercept(execution(Handlers.prototype.list), failing(refusal("/query/limit"))),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const badBody = interceptor();
    await expect(
      lastValueFrom(
        badBody.interceptor.intercept(
          execution(Handlers.prototype.get, { bookingId: "bkg_01JA2Z9W5K7Q3M8N4P6R2T0V1E" }),
          failing(refusal("/name")),
        ),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const badPath = interceptor();
    await expect(
      lastValueFrom(
        badPath.interceptor.intercept(
          execution(Handlers.prototype.get, { bookingId: pasted }),
          failing(refusal("/path/bookingId")),
        ),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const rows = [...badQuery.rows, ...badBody.rows, ...badPath.rows];
    expect(rows.map((row) => [row["action"], row["outcome"], row["target_type"], row["target_id"]])).toEqual([
      ["bookings.list", "failed", null, null],
      ["bookings.get", "failed", "booking", "bkg_01JA2Z9W5K7Q3M8N4P6R2T0V1E"],
      ["bookings.get", "failed", null, null],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ actor_type: "staff", before: null, after: null, reason: null });
    }
    expect(JSON.stringify(rows)).not.toContain(pasted);
  });

  it("leaves customer scope and the staff-session operations alone", async () => {
    const customer = interceptor(false);
    await lastValueFrom(customer.interceptor.intercept(execution(Handlers.prototype.list), answering({})));
    const me = interceptor();
    await lastValueFrom(me.interceptor.intercept(execution(Handlers.prototype.me), answering({})));

    expect([...customer.rows, ...me.rows]).toEqual([]);
  });
});
