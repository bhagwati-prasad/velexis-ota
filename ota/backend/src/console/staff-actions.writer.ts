// The console audit (OBE-060; OADR-0011 point 8, flows/console-operations.md §3 step 7, db README §8): one
// `staff_actions` row per console call, denied attempts included (`outcome = denied`), with the actor, the role, the
// action, the target, the reason, the redacted before and after, the request id, and the end user's IP and user agent
// (for the OTA admin's service caller the staff member's forwarded ones, never the admin server's 127.0.0.1).
//
// Who writes the row:
//
// - a use case that changes data writes it in its own transaction (`record(trx, …)`), with its before and after, so
//   the row and the change commit together (the console booking, payment and settings operations of OBE-061 to
//   OBE-074; console.auth.signIn writes its `staff.sign_in` rows, succeeded or denied, with the same row builder);
// - a denial of the permission guard (`403 FORBIDDEN`, `403 ENVIRONMENT_NOT_ALLOWED`, `403 SCOPE_NOT_ALLOWED` for a
//   key-only call without `console:automation`) is written in a short transaction of its own (`recordDenial`): the
//   request ends there;
// - every other console call (reads above all) is written by `StaffActionsInterceptor` around the handler, in a short
//   transaction of its own after it: `succeeded`, or `failed` (`denied` for a `403 FORBIDDEN`,
//   `ENVIRONMENT_NOT_ALLOWED` or `OFFICE_NOT_ALLOWED` of the use case) when the handler threw, unless the use case
//   wrote its row already. A succeeded call counts any row the use case wrote (`recorded()`); a failed one only a row
//   that committed on its own (`recordAlone`), because a row written in the use case's transaction is gone when that
//   transaction rolled back with the failure (and when it had committed before a later step failed, the call has both
//   rows: what was done, and that the call failed). A read that cannot be audited fails (the database error's answer).
//
// Console calls are the requests in console scope (scope.guard.ts) on operations of the document. The four staff
// session operations (`x-permission: none`: console.auth.signIn, refresh, signOut, me) are session plumbing, not
// console work: the sign-in writes its own `staff.sign_in` row (and a denied one for a viewer asking for live), the
// other three none (the OTA admin calls console.auth.me once per page); the permission guard's denials of them are
// written as for any console call. A request whose actor is unknown (no staff member and no API key: a service request
// whose credential named nobody) has no row: `staff_actions_actor_ck` needs an actor, and the log line has the rest.
// Requests refused before the permission guard (an unknown or missing credential, a missing header, a key scoped
// `storefront`) have no row either: no actor is known yet. Nor do requests the validation interceptor refuses
// (`400 VALIDATION_FAILED`): it runs outside the audit interceptor, and their use case never ran.
//
// The actor (`ConsoleStaffAction.actor`, `staff_actions_actor_ck`): the signed-in staff member (`staff`, `stf_…`, with
// the account, e-mail and role of the membership as the staff guard read it), else the API key of a key-only call
// (`api_key`, `key_…`), else an actor the use case names (a staff member known by e-mail only, for a failed sign-in).
// The action is the operation's SDK method without `console.` (`bookings.get`, `settings.markupRules.create`) unless the
// use case names one (`staff.sign_in`, `booking.issue`); the target is the operation's last `…Id` path parameter
// (`bookingId` → `booking`). `booking_id` is set only by use cases, which know the booking exists (it references
// `bookings`).
//
// Redaction (db README §8): `before` and `after` pass the shared redactor of @velexis/logger (`redactPayload`):
// document, card, discount card and certificate numbers keep their last 4 characters, security codes and the birth and
// issuance places are dropped, and every token, secret, password and API key value becomes `[REDACTED]`. No row ever
// holds a token, a key or a full document number; the reason is the staff member's own text.
import { isIP } from "node:net";
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import type { Insertable, TenantDatabase } from "@velexis/db";
import { AppError, isAppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import type { Request } from "express";
import { ClsService } from "nestjs-cls";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { defer, lastValueFrom, type Observable } from "rxjs";
import { MAX_END_USER_AGENT_LENGTH } from "../common/auth/caller.guard";
import { isStaffSessionOperation, StaffContext } from "../common/auth/staff.guard";
import { OPENAPI_OPERATION } from "../common/http/openapi-operation.decorator";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { CallerContext } from "../tenancy/caller-resolver";
import type { StaffRole } from "../tenancy/platform-read.repository";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";

/** `staff_actions.outcome`. */
export type StaffActionOutcome = "succeeded" | "failed" | "denied";

/** Who acted (`staff_actions.actor_type` and the columns `staff_actions_actor_ck` ties to it). */
export type StaffActionActor =
  | {
      /** A staff member with a membership: `actor_id = staff_id = stf_…`. */
      readonly type: "staff";
      readonly staffId: string;
      readonly accountId: string;
      readonly email: string;
      readonly role: StaffRole;
    }
  | {
      /** A staff member known by e-mail only (a failed or denied sign-in): no actor id, no staff id. */
      readonly type: "staff_email";
      readonly email: string;
      readonly accountId: string | null;
    }
  | { readonly type: "api_key"; readonly keyId: string }
  | { readonly type: "system" };

/** One console action as a use case or the pipeline reports it. */
export interface StaffActionEntry {
  /** `booking.issue`, `staff.sign_in`, `bookings.get` … */
  readonly action: string;
  /** `succeeded` unless said otherwise. */
  readonly outcome?: StaffActionOutcome | undefined;
  readonly targetType?: string | null | undefined;
  readonly targetId?: string | null | undefined;
  /** The booking concerned; it must exist (`staff_actions.booking_id` references `bookings`). */
  readonly bookingId?: string | null | undefined;
  /** The staff member's justification. */
  readonly reason?: string | null | undefined;
  /** The state before and after; redacted here before it is written. */
  readonly before?: unknown;
  readonly after?: unknown;
  /** Who acted; the request's staff member or key when absent. */
  readonly actor?: StaffActionActor | undefined;
}

/** What a row takes from the request besides the entry. */
export interface StaffActionRequest {
  readonly actor: StaffActionActor;
  /** `X-Request-Id`; `null` outside a request. */
  readonly requestId: string | null;
  /** The end user's IP address (caller guard): kept only when it is an IPv4 or IPv6 address. */
  readonly ip: string | null;
  /** The end user's user agent (caller guard), at most 512 characters. */
  readonly userAgent: string | null;
}

/** The longest target id, reason and action kept (ids are far shorter; free text is cut, never refused). */
const MAX_TEXT = Object.freeze({ action: 100, targetType: 50, targetId: 128, reason: 2000 });

const cut = (value: string | null | undefined, length: number): string | null =>
  value === undefined || value === null || value === "" ? null : value.slice(0, length);

/** A jsonb value as it is written: the redacted copy as JSON text, or `null` (db README §8). */
function redactedJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(redactPayload(value));
}

/** The actor columns of `staff_actions_actor_ck`. */
function actorColumns(
  actor: StaffActionActor,
): Pick<
  Insertable<TenantDatabase["staff_actions"]>,
  "actor_type" | "actor_id" | "staff_id" | "account_id" | "staff_email" | "staff_role"
> {
  switch (actor.type) {
    case "staff":
      return {
        actor_type: "staff",
        actor_id: actor.staffId,
        staff_id: actor.staffId,
        account_id: actor.accountId,
        staff_email: actor.email,
        staff_role: actor.role,
      };
    case "staff_email":
      return {
        actor_type: "staff",
        actor_id: null,
        staff_id: null,
        account_id: actor.accountId,
        staff_email: actor.email,
        staff_role: null,
      };
    case "api_key":
      return {
        actor_type: "api_key",
        actor_id: actor.keyId,
        staff_id: null,
        account_id: null,
        staff_email: null,
        staff_role: null,
      };
    case "system":
      return {
        actor_type: "system",
        actor_id: null,
        staff_id: null,
        account_id: null,
        staff_email: null,
        staff_role: null,
      };
  }
}

/**
 * The `staff_actions` row of `entry` (see the file header): the actor's columns, the redacted before and after, the
 * request id and the end user. A failed or denied entry of a staff member known by e-mail only is the only kind
 * `staff_actions_actor_ck` accepts without a staff id; a succeeded one is refused here with a `TypeError`.
 */
export function staffActionRow(
  id: string,
  entry: StaffActionEntry,
  request: StaffActionRequest,
): Insertable<TenantDatabase["staff_actions"]> {
  const outcome = entry.outcome ?? "succeeded";
  const actor = entry.actor ?? request.actor;
  if (actor.type === "staff_email" && outcome === "succeeded") {
    throw new TypeError("staffActionRow: a staff member known by e-mail only can only fail or be denied");
  }
  return {
    id,
    ...actorColumns(actor),
    action: entry.action.slice(0, MAX_TEXT.action),
    target_type: cut(entry.targetType, MAX_TEXT.targetType),
    target_id: cut(entry.targetId, MAX_TEXT.targetId),
    booking_id: entry.bookingId ?? null,
    reason: cut(entry.reason, MAX_TEXT.reason),
    before: redactedJson(entry.before),
    after: redactedJson(entry.after),
    outcome,
    request_id: cut(request.requestId, 128),
    ip_address: request.ip !== null && isIP(request.ip) !== 0 ? request.ip : null,
    user_agent: cut(request.userAgent, MAX_END_USER_AGENT_LENGTH),
  };
}

const OPERATIONS = new Map(otaOperations.map((operation) => [operation.operationId, operation]));

/** The action of a console call without a use case's own name: the SDK method without `console.`. */
export function consoleAction(operationId: string): string {
  const method = OPERATIONS.get(operationId as OtaOperationId)?.sdkMethod ?? null;
  return method === null ? operationId : method.replace(/^console\./, "");
}

/** `markupRuleId` → `markup_rule`. */
const snakeCase = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * The target of a console call: the operation's last path parameter named `…Id` (`bookingId` → `booking`) and its
 * value in the request, or none.
 */
export function consoleTarget(
  operationId: string,
  params: Readonly<Record<string, unknown>> | undefined,
): { readonly targetType: string | null; readonly targetId: string | null } {
  const path = OPERATIONS.get(operationId as OtaOperationId)?.path ?? "";
  const names = [...path.matchAll(/\{([A-Za-z]+Id)\}/g)].map((match) => match[1] ?? "");
  const name = names.at(-1);
  const value = name === undefined ? undefined : params?.[name];
  if (name === undefined || typeof value !== "string" || value === "") {
    return { targetType: null, targetId: null };
  }
  return { targetType: snakeCase(name.slice(0, -"Id".length)), targetId: value };
}

/** The outcome of a call whose handler threw `error`. */
export function failureOutcome(error: unknown): StaffActionOutcome {
  return isAppError(error) && DENIAL_CODES.has(error.code) ? "denied" : "failed";
}

/** The refusals that are denials (`outcome = denied`) rather than failures. */
export const DENIAL_CODES: ReadonlySet<string> = new Set([
  "FORBIDDEN",
  "SCOPE_NOT_ALLOWED",
  "ENVIRONMENT_NOT_ALLOWED",
  "OFFICE_NOT_ALLOWED",
]);

/** A row of the request was written, in the use case's transaction or in one of its own. */
const RECORDED_KEY = "console.staff_action_recorded";
/** A row of the request was written in a transaction of its own that committed (`recordAlone`). */
const COMMITTED_KEY = "console.staff_action_committed";

@Injectable()
export class StaffActionsWriter {
  constructor(
    private readonly tx: TenantTx,
    private readonly ids: IdGenerator,
    private readonly tenants: TenantContext,
    private readonly callers: CallerContext,
    private readonly staff: StaffContext,
    private readonly context: RequestContext,
    private readonly cls: ClsService,
    @InjectPinoLogger(StaffActionsWriter.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * The actor of the current request: its signed-in staff member, else the API key of a key-only call; `undefined`
   * when it has neither (a service request whose credential named nobody, a guest).
   */
  requestActor(): StaffActionActor | undefined {
    const principal = this.staff.get();
    if (principal !== undefined) {
      return {
        type: "staff",
        staffId: principal.family.staffId,
        accountId: principal.member.accountId,
        email: principal.member.account.email,
        role: principal.member.role,
      };
    }
    const caller = this.callers.get();
    return caller?.type === "key" ? { type: "api_key", keyId: caller.keyId } : undefined;
  }

  /**
   * Writes the row of `entry` in the use case's transaction `trx` (see the file header), and marks the request as
   * audited. Throws a `TypeError` when the entry names no actor and the request has none.
   */
  async record(trx: TenantTransaction, entry: StaffActionEntry): Promise<void> {
    const actor = entry.actor ?? this.requestActor();
    if (actor === undefined) {
      throw new TypeError("StaffActionsWriter.record: the request has no actor; name one in the entry");
    }
    const requestId = this.tenants.get()?.requestId ?? this.context.requestId() ?? null;
    const endUser = this.context.endUser();
    const row = staffActionRow(this.ids.newId("sact"), entry, {
      actor,
      requestId: requestId === "" ? null : requestId,
      ip: endUser?.ip ?? null,
      userAgent: endUser?.userAgent ?? null,
    });
    await trx.insertInto("staff_actions").values(row).execute();
    if (this.cls.isActive()) {
      this.cls.set(RECORDED_KEY, true);
    }
  }

  /** Writes the row of `entry` in a short transaction of its own (reads, denials). */
  async recordAlone(entry: StaffActionEntry): Promise<void> {
    await this.tx.run((trx) => this.record(trx, entry));
    if (this.cls.isActive()) {
      this.cls.set(COMMITTED_KEY, true);
    }
  }

  /** True when the current request wrote its row already (in any transaction, which may still roll back). */
  recorded(): boolean {
    return this.cls.isActive() && this.cls.get(RECORDED_KEY) === true;
  }

  /** True when the current request wrote its row in a transaction of its own that committed (`recordAlone`). */
  recordedAlone(): boolean {
    return this.cls.isActive() && this.cls.get(COMMITTED_KEY) === true;
  }

  /**
   * The row of a console call `operationId` the permission guard refused with `error` (`outcome = denied`), in a
   * transaction of its own. Without an actor or a tenant there is no row; a row that cannot be written is logged, and
   * the refusal stands.
   */
  async recordDenial(
    operationId: string,
    params: Request["params"] | undefined,
    error: AppError,
  ): Promise<void> {
    const actor = this.requestActor();
    if (actor === undefined || this.tenants.get() === undefined) {
      this.logger.info({ operationId, code: error.code }, "staff_actions.denial_without_actor");
      return;
    }
    try {
      await this.recordAlone({
        action: consoleAction(operationId),
        ...consoleTarget(operationId, params),
        outcome: "denied",
        actor,
      });
    } catch (writeError) {
      this.logger.error({ err: writeError, operationId }, "staff_actions.write_failed");
    }
  }

  /**
   * The row of a console call that the pipeline audits (`StaffActionsInterceptor`), unless its use case wrote one:
   * for a succeeded call any row, for a failed or denied one a row that committed on its own (a row of the use case's
   * transaction rolled back with the failure; see the file header). Nothing without an actor.
   */
  async recordCall(
    operationId: string,
    params: Request["params"] | undefined,
    outcome: StaffActionOutcome,
  ): Promise<void> {
    const actor = this.requestActor();
    const audited = outcome === "succeeded" ? this.recorded() : this.recordedAlone();
    if (audited || actor === undefined || this.tenants.get() === undefined) {
      return;
    }
    await this.recordAlone({
      action: consoleAction(operationId),
      ...consoleTarget(operationId, params),
      outcome,
      actor,
    });
  }
}

/**
 * Audits every console call the use case did not audit itself (see the file header): global (`APP_INTERCEPTOR` in
 * app.module.ts, after validation and idempotency), on handlers bound to an operation, in console scope, except the
 * staff-session operations.
 */
@Injectable()
export class StaffActionsInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContext,
    private readonly writer: StaffActionsWriter,
    @InjectPinoLogger(StaffActionsInterceptor.name) private readonly logger: PinoLogger,
  ) {}

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operationId =
      execution.getType() === "http"
        ? this.reflector.get<string | undefined>(OPENAPI_OPERATION, execution.getHandler())
        : undefined;
    if (operationId === undefined || !this.context.isConsoleScope() || isStaffSessionOperation(operationId)) {
      return next.handle();
    }
    const params = execution.switchToHttp().getRequest<Request>().params;
    return defer(async () => {
      let body: unknown;
      try {
        body = await lastValueFrom(next.handle(), { defaultValue: undefined });
      } catch (error) {
        await this.writer
          .recordCall(operationId, params, failureOutcome(error))
          .catch((writeError: unknown) => {
            // The call's own error is the answer; the audit gap is logged.
            this.logger.error({ err: writeError, operationId }, "staff_actions.write_failed");
          });
        throw error;
      }
      await this.writer.recordCall(operationId, params, "succeeded");
      return body;
    });
  }
}
