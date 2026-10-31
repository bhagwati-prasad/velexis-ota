// The console audit (OBE-060; OADR-0011 point 8 as decided on 2026-10-21, flows/console-operations.md §3 step 7,
// db README §8): `staff_actions` rows with the actor, the role, the action, the target, the reason, the redacted before
// and after, the request id, and the end user's IP and user agent (for the OTA admin's service caller the staff
// member's forwarded ones, never the admin server's 127.0.0.1). Point 8 asks for one row per state-changing console
// call, one per refused console call (`outcome = denied` for a permission refusal, `failed` for any other), and one per
// successful read that returns personal data of one person or a supplier record: viewing a customer (`customer.view`),
// the PNR lookup (`pnr.lookup`), the order retrieve (`order.retrieve`) and the raw Amadeus reads
// (`amadeus.<operationId>`). Every other successful read (lists such as bookings, queues and the customer search) and
// the staff-session calls console.auth.refresh, signOut and me need none.
//
// Reads (`isConsoleRead`): an operation whose `x-permission` is a read permission (`bookings:read`, `customers:read`,
// `queues:read`, `supplier_requests:read`, `amadeus:read`, `payments:read`, `settings:read`), so a POST that changes
// nothing (the raw Amadeus searches, a template preview) is a read too; an operation without one (a shared `both`
// operation that a `console:automation` key calls in console scope) is a read when it is a GET or a HEAD. A read that
// is audited opts in with `@AuditedRead()` on its handler, which its implementation attaches (OBE-062, OBE-064, OBE-066
// and OBE-067): the interceptor then writes its `succeeded` row, with the decorator's action when it names one, unless
// the use case wrote its own (with a target, reason or before and after the decorator cannot know). The opt-in is the
// handler's, not the document's, so that the code that returns the personal data is the code that says so.
//
// Who writes the row:
//
// - a use case that changes data writes it in its own transaction (`record(trx, …)`), with its before and after, so
//   the row and the change commit together (the console booking, payment and settings operations of OBE-061 to
//   OBE-074; console.auth.signIn writes its `staff.sign_in` rows, succeeded or denied, with the same row builder);
// - a denial of the permission guard (`403 FORBIDDEN`, `403 ENVIRONMENT_NOT_ALLOWED`, `403 SCOPE_NOT_ALLOWED` for a
//   key-only call without `console:automation`) and the staff guard's `403 STAFF_MEMBERSHIP_INACTIVE` for a verified
//   staff token are written in a short transaction of their own (`recordDenial`): the request ends there. Both guards
//   run before request validation, so a path value becomes the target only when it passes that parameter's schema in
//   the document (`RequestValidator.validPathParameters`); otherwise the row has no target;
// - every other console call is written by `StaffActionsInterceptor` around the handler, in a short transaction of its
//   own after it: `failed` (`denied` for a `403 FORBIDDEN`, `ENVIRONMENT_NOT_ALLOWED` or `OFFICE_NOT_ALLOWED` of the use
//   case) when it was refused or its handler threw, else `succeeded` for a call that is not a read and for an opted-in
//   read, unless the use case wrote its row already. A succeeded call counts any row the use case wrote
//   (`recorded()`); a failed one only a row that committed on its own (`recordAlone`), because a row written in the use
//   case's transaction is gone when that transaction rolled back with the failure (and when it had committed before a
//   later step failed, the call has both rows: what was done, and that the call failed). A call that cannot be audited
//   fails (the database error's answer).
//
// The interceptor wraps the validation and idempotency interceptors: Nest applies the global enhancers of a module
// before those of the modules it imports, so the interceptors of app.module.ts (key usage, then this one) run outside
// those of HttpModule (validation, then idempotency). A console call that request validation refuses
// (`400 VALIDATION_FAILED`, or `400 INVALID_REQUEST` for a body sent without a JSON media type) or the idempotency
// interceptor refuses (a missing, reused or in-progress `Idempotency-Key`) reaches it as a failure, its use case never
// having run, and is recorded as `failed` with its action and target only: the row never holds the request's body,
// query or headers, and a path parameter that validation refused is not taken as the target (`auditedParams`). An
// idempotent replay of a state-changing call reaches it as a success of a call whose use case did not run in this
// request, and keeps its `succeeded` row.
//
// Console calls are the requests in console scope (scope.guard.ts) on operations of the document. The four staff
// session operations (`x-permission: none`: console.auth.signIn, refresh, signOut, me) are session plumbing, not
// console work: the sign-in writes its own `staff.sign_in` row, and a denied one for each of its 403 refusals of a
// staff member it knows (a viewer asking for live, `STAFF_MEMBERSHIP_INACTIVE`, `TENANT_SUSPENDED`, `MFA_REQUIRED`); the
// other three write none (the OTA admin calls console.auth.me once per page); the guards' denials of them are written as
// for any console call. A request whose actor is unknown (no staff member and no API key: a service request whose
// credential named nobody) has no row: `staff_actions_actor_ck` needs an actor, and the log line has the rest. Requests
// refused before the staff member or key is known (an unknown, missing, expired or revoked credential, a missing
// header, a key scoped `storefront`, a body the body parsers refuse: malformed JSON or too large, answered
// `400 INVALID_REQUEST` by middleware before any guard) have no row either, nor does a call the rate limits refuse
// (`429 RATE_LIMITED`): the rate-limit guard logs it instead (`rate_limit.exceeded` with the staff member or key, the
// operation and the limit; rate-limits.ts), so that a client asking again and again never fills the table. The same
// holds for every `429` (point 8 says it of every one): one raised inside a console use case (the console's resync
// throttle of 10 s per booking, an empty Amadeus bucket's `RATE_LIMITED`) writes no `failed` row either, only the line
// `staff_actions.rate_limited` (the operation, the code, the staff member or key, the `Retry-After` seconds when the
// error has them; `rateLimitedCall`), decided in this one place (`StaffActionsInterceptor`, `isRateLimitRefusal`;
// lead decision (2d) of 2026-10-30, third batch, FIX-W36-OTA: before, such a call was recorded `failed`). A row the
// use case wrote on its own before the `429` (a step that committed) stays.
//
// The actor (`ConsoleStaffAction.actor`, `staff_actions_actor_ck`): the signed-in staff member (`staff`, `stf_…`, with
// the account, e-mail and role of the membership as the staff guard read it), else the API key of a key-only call
// (`api_key`, `key_…`), else an actor the guard or the use case names (the staff member of a verified staff token whose
// membership the staff guard refused, known by its id and role only; a staff member known by e-mail only, for a failed
// sign-in). The action is the operation's SDK method without `console.` (`bookings.get`,
// `settings.markupRules.create`) unless the use case or `@AuditedRead` names one (`staff.sign_in`, `booking.issue`,
// `customer.view`); the target is the operation's last `…Id` path parameter (`bookingId` → `booking`). `booking_id` is
// set only by use cases, which know the booking exists (it references `bookings`).
//
// Redaction (db README §8): `before` and `after` pass the shared redactor of @velexis/logger (`redactPayload`):
// document, card, discount card and certificate numbers keep their last 4 characters, security codes and the birth and
// issuance places are dropped, and every token, secret, password and API key value becomes `[REDACTED]`. No row ever
// holds a token, a key or a full document number; the reason is the staff member's own text.
import { isIP } from "node:net";
import {
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
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
import { isStaffSessionOperation, StaffContext, StaffRefusalAudit } from "../common/auth/staff.guard";
import { OPENAPI_OPERATION } from "../common/http/openapi-operation.decorator";
import { OpenApiDocument } from "../common/http/openapi-validation.interceptor";
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
      /**
       * A staff member with a membership: `actor_id = staff_id = stf_…`. The account and e-mail are `null` when the
       * request knows the membership by its verified staff token only (the staff guard's refusal of its membership).
       */
      readonly type: "staff";
      readonly staffId: string;
      readonly accountId: string | null;
      readonly email: string | null;
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

/** A read permission of the role matrix (roles.ts): `bookings:read`, `customers:read`, `amadeus:read` … */
const READ_PERMISSION = /^[a-z_]+:read$/;

/**
 * Whether a console call of `operationId` is a read (see the file header): its `x-permission` is a read permission,
 * or, for an operation without one, it is a GET or a HEAD. The staff-session operations (`x-permission: none`) and ids
 * the document does not have are not reads.
 */
export function isConsoleRead(operationId: string): boolean {
  const operation = OPERATIONS.get(operationId as OtaOperationId);
  if (operation === undefined || operation.permission === "none") {
    return false;
  }
  if (operation.permission !== null) {
    return READ_PERMISSION.test(operation.permission);
  }
  return operation.method === "get" || operation.method === "head";
}

/** Metadata key of `@AuditedRead` on a handler. */
export const AUDITED_READ = "velexis:console:audited-read";

/** What `@AuditedRead` records on a handler. */
export interface AuditedReadOptions {
  /**
   * The action of the read's `succeeded` row (`customer.view`, `pnr.lookup`, `order.retrieve`); the operation's SDK
   * method without `console.` when absent (`amadeus.searchFlightOffers`). Refusals and failures of the call keep the
   * action every refused console call has (`consoleAction`).
   */
  readonly action?: string | undefined;
}

/**
 * Opts the successful calls of a console read in to the audit (OADR-0011 point 8 as decided on 2026-10-21; see the
 * file header): put it on the handler of a read that returns personal data of one person or a supplier record, next to
 * `@OpenApiOperation`. On a handler that is not a read it changes nothing: every successful change is audited anyway.
 *
 *   @Get("v1/console/customers/:customerId")
 *   @OpenApiOperation("consoleGetCustomer")
 *   @AuditedRead({ action: "customer.view" })
 *   get(…) { … }
 */
export function AuditedRead(options: AuditedReadOptions = {}): MethodDecorator {
  return SetMetadata(AUDITED_READ, Object.freeze({ action: options.action ?? null }));
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

/** `/path/<name>` of a field error: a path parameter that request validation refused. */
const PATH_POINTER = /^\/path\/([^/]+)/;

/**
 * The path parameters of a console call that `error` ended, as the audit may record them: without those a
 * `400 VALIDATION_FAILED` names (`/path/<name>`), whose value is the caller's text rather than an id, so the row's
 * target never holds it; every parameter otherwise. (A body pointer of the same shape drops the parameter too, which
 * only costs the row its target.)
 */
export function auditedParams(
  params: Readonly<Record<string, unknown>> | undefined,
  error: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (params === undefined || !isAppError(error) || error.code !== "VALIDATION_FAILED") {
    return params;
  }
  const refused = new Set(
    (error.fieldErrors ?? []).flatMap((fieldError) => {
      const name = PATH_POINTER.exec(fieldError.path)?.[1];
      return name === undefined ? [] : [name.replaceAll("~1", "/").replaceAll("~0", "~")];
    }),
  );
  return Object.fromEntries(Object.entries(params).filter(([name]) => !refused.has(name)));
}

/**
 * Whether `error` is a `429` (`RATE_LIMITED` or any code the catalogue answers with 429), which a console call never
 * records as a `staff_actions` row, only as a log line (see the file header; OADR-0011 point 8 as decided on
 * 2026-10-21, lead decision (2d) of 2026-10-30, third batch).
 */
export function isRateLimitRefusal(error: unknown): error is AppError {
  return isAppError(error) && error.status === 429;
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
export class StaffActionsWriter implements StaffRefusalAudit {
  constructor(
    private readonly tx: TenantTx,
    private readonly ids: IdGenerator,
    private readonly tenants: TenantContext,
    private readonly callers: CallerContext,
    private readonly staff: StaffContext,
    private readonly context: RequestContext,
    private readonly cls: ClsService,
    private readonly document: OpenApiDocument,
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
   * audited. Returns the row's id (`sact_…`, which the raw Amadeus reads answer as `call.staffActionId`). Throws a
   * `TypeError` when the entry names no actor and the request has none.
   */
  async record(trx: TenantTransaction, entry: StaffActionEntry): Promise<string> {
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
    return row.id;
  }

  /** Writes the row of `entry` in a short transaction of its own (audited reads, denials); returns its id. */
  async recordAlone(entry: StaffActionEntry): Promise<string> {
    const id = await this.tx.run((trx) => this.record(trx, entry));
    if (this.cls.isActive()) {
      this.cls.set(COMMITTED_KEY, true);
    }
    return id;
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
   * The row of a console call `operationId` that a guard refused with `error` (`outcome = denied`), in a transaction
   * of its own: the permission guard's denials, and the staff guard's refusal of a verified staff token's membership,
   * which names `actor` (the request has no staff member then). `params` are the request's path parameters as the
   * router gave them: the guards run before request validation, so a value becomes the target only when it passes its
   * parameter's schema in the document, and the row has no target otherwise. Without an actor or a tenant there is no
   * row; a row that cannot be written is logged, and the refusal stands.
   */
  async recordDenial(
    operationId: string,
    params: Readonly<Record<string, unknown>> | undefined,
    error: AppError,
    actor: StaffActionActor | undefined = this.requestActor(),
  ): Promise<void> {
    if (actor === undefined || this.tenants.get() === undefined) {
      this.logger.info({ operationId, code: error.code }, "staff_actions.denial_without_actor");
      return;
    }
    try {
      await this.recordAlone({
        action: consoleAction(operationId),
        ...consoleTarget(operationId, this.validPathParameters(operationId, params)),
        outcome: "denied",
        actor,
      });
    } catch (writeError) {
      this.logger.error({ err: writeError, operationId }, "staff_actions.write_failed");
    }
  }

  /**
   * The log line of a console call that a `429` ended (`isRateLimitRefusal`), which writes no row: the operation, the
   * code, the staff member (`stf_…`) or the key (`key_…`), and the seconds of `Retry-After` when the error has them.
   * Never an IP address, an e-mail address, a token or a request value.
   */
  rateLimitedCall(operationId: string, error: AppError): void {
    const actor = this.requestActor();
    const retryAfterSeconds = error.details?.["retryAfterSeconds"];
    this.logger.info(
      {
        operationId,
        code: error.code,
        ...(actor?.type === "staff" ? { staffId: actor.staffId } : {}),
        ...(actor?.type === "api_key" ? { keyId: actor.keyId } : {}),
        ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}),
      },
      "staff_actions.rate_limited",
    );
  }

  /**
   * The row of a console call that the pipeline audits (`StaffActionsInterceptor`), unless its use case wrote one:
   * for a succeeded call any row, for a failed or denied one a row that committed on its own (a row of the use case's
   * transaction rolled back with the failure; see the file header). `action` replaces the operation's (an opted-in
   * read's). Nothing without an actor.
   */
  async recordCall(
    operationId: string,
    params: Readonly<Record<string, unknown>> | undefined,
    outcome: StaffActionOutcome,
    action: string | null = null,
  ): Promise<void> {
    const actor = this.requestActor();
    const audited = outcome === "succeeded" ? this.recorded() : this.recordedAlone();
    if (audited || actor === undefined || this.tenants.get() === undefined) {
      return;
    }
    await this.recordAlone({
      action: action ?? consoleAction(operationId),
      ...consoleTarget(operationId, params),
      outcome,
      actor,
    });
  }

  /** The path parameters of `params` that pass their schema of `operationId` in the document (none for an unknown id). */
  private validPathParameters(
    operationId: string,
    params: Readonly<Record<string, unknown>> | undefined,
  ): Readonly<Record<string, string>> {
    try {
      return this.document.validator(operationId).validPathParameters(params);
    } catch {
      return {};
    }
  }
}

/**
 * Audits every console call the use case did not audit itself and the rule asks for (see the file header): global
 * (`APP_INTERCEPTOR` in app.module.ts, outside HttpModule's validation and idempotency interceptors, so their refusals
 * are recorded as failures), on handlers bound to an operation, in console scope, except the staff-session operations.
 * A successful read is recorded only when its handler carries `@AuditedRead`.
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
    const read = isConsoleRead(operationId);
    const optIn = this.reflector.get<{ readonly action: string | null } | undefined>(
      AUDITED_READ,
      execution.getHandler(),
    );
    return defer(async () => {
      let body: unknown;
      try {
        body = await lastValueFrom(next.handle(), { defaultValue: undefined });
      } catch (error) {
        if (isRateLimitRefusal(error)) {
          // A `429` is a log line, never a row (see the file header).
          this.writer.rateLimitedCall(operationId, error);
          throw error;
        }
        await this.writer
          .recordCall(operationId, auditedParams(params, error), failureOutcome(error))
          .catch((writeError: unknown) => {
            // The call's own error is the answer; the audit gap is logged.
            this.logger.error({ err: writeError, operationId }, "staff_actions.write_failed");
          });
        throw error;
      }
      if (!read || optIn !== undefined) {
        await this.writer.recordCall(operationId, params, "succeeded", read ? (optIn?.action ?? null) : null);
      }
      return body;
    });
  }
}
