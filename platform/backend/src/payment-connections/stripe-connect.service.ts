// Stripe Connect Standard OAuth (PBE-055; platform/docs/flows/stripe-payments-account.md §C and "Failure handling",
// PADR-0011 items 1, 2 and 8, ADR-0011 §A `connect_standard`, scope PF-61 AC1): an owner or admin connects the OTA's
// own Stripe account, so its customers' card payments land there (direct charges with Velexis's key and
// `Stripe-Account`), instead of on the Velexis account.
//
// `start` (`startStripeConnect`, owners and admins; TOTP step-up and `FEATURE_OWN_STRIPE` by the operation's
// `x-mfa-step-up` and `x-feature`, checked by the guards before the handler):
//
// 1. the OTA must be `active` (`409 TENANT_NOT_ACTIVE` with `details.status`, PADR-0014 item 5), read fresh with the
//    caller's membership and e-mail address;
// 2. a 256-bit `state` from the CSPRNG (43 base64url characters, the document's `StripeConnectState`) is stored as
//    `SET stripe:oauth:<sha256 hex> {tenantId, accountId, membershipId} EX 600 NX` (`redisKeys.stripeOAuthState`): Redis
//    unreachable answers `503 SERVICE_UNAVAILABLE`, because the state lives only there;
// 3. the answer is Stripe's authorize URL (`response_type=code`, `client_id` = STRIPE_CONNECT_CLIENT_ID,
//    `scope=read_write`, the state, `redirect_uri` = `<PUBLIC_PORTAL_URL>/connect/stripe/callback` and
//    `stripe_user[email]`, the caller's address: the person who is sent to Stripe, an owner or an admin) and when the
//    state expires. The controller sends it `no-store`: the URL holds the single-use state.
//
// `complete` (`completeStripeConnect`, any signed-in portal account; the OTA is the state's), in this order:
//
// 1. `GETDEL` of the state's key: an unknown, expired or used state answers `400 CONNECT_STATE_INVALID`, and so does a
//    state another account started (logged as `stripe_connect.state_account_mismatch`, without the state); the state
//    is spent either way (single use, PADR-0011 item 2). Redis unreachable answers `503`;
// 2. the starting account must still hold the active membership that started it (the state's `membershipId`), as an
//    owner or admin (`403 FORBIDDEN`), and the OTA must be `active` (`409 TENANT_NOT_ACTIVE`); the account itself is
//    not read (`connectMember`);
// 3. `{state, error}` (the person declined, or Stripe reported another error) changes nothing: `422 UNPROCESSABLE` with
//    `details.reason` `access_denied`, or `oauth_error` for any other error; Stripe's description is never echoed;
// 4. `stripe.oauth.token({grant_type: "authorization_code", code})` with Velexis's secret key and the idempotency key
//    `connect_oauth:<sha256 of the state>` (one exchange per state, architecture §7). Only `stripe_user_id` and
//    `livemode` are kept: the access and refresh tokens and the publishable key of the answer are discarded at once,
//    never stored, logged or answered (PADR-0011 item 2). A code Stripe refuses (`invalid_grant`: unknown, expired,
//    used, or of the other mode) answers `422 UNPROCESSABLE` with `oauth_error` (the 422 of the document: "Stripe
//    reported another error"); any other failure, or an answer without an `acct_…`, `502 PROVIDER_ERROR`;
// 5. `livemode` must be the deployment's (`APP_ENV=production` is live): else `422 UNPROCESSABLE`, `livemode_mismatch`;
// 6. an `acct_…` that another OTA's `connect_standard` connection holds answers `409 STRIPE_ACCOUNT_ALREADY_CONNECTED`
//    (one account per OTA: Connect events are routed by `event.account`);
// 7. `stripe.accounts.retrieve(acct_…)` for `charges_enabled`, `payouts_enabled` and `details_submitted` (`502` when it
//    fails);
// 8. one transaction (`runInTransaction`): the tenant `FOR SHARE` (`409 TENANT_NOT_ACTIVE` when it stopped being
//    `active`), the duplicate check again, then the **test** connection, locked, becomes `connect_standard` with the
//    `acct_…`, no publishable key, no secrets, the capabilities, `connected_at`, and `active` when charges are enabled
//    (`pending` otherwise), `version + 1`; the **live** connection the same when the OTA is live (go-live creates it in
//    this mode otherwise). A connection that is missing is inserted in this mode. Each connection writes one audit row
//    `payments.connect_connected` (mode, account and status before and after, the capabilities, the environment), and
//    `{type: "connection", tenantId}` is published after the commit. Another OTA connecting the same account at the
//    same moment loses on `payment_provider_connections_connect_uq` and answers `409` too.
//
// The answer is the OTA's connections after the switch, `test` first, read without the ciphertexts. No transaction is
// open during a Stripe call. Stripe's errors reach the logs only as StripeConnectFailure (operation, type, status and
// code), never with Stripe's message, which may quote the code. The code and the state are never logged: no line here
// names them, and the logger redacts `oauth.code` and `oauth.state`. "Now" is the injected Clock's time.
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { AuditService } from "../audit/audit.service";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { redisKeys, setKeyIfAbsent, STRIPE_OAUTH_STATE_TTL_SECONDS } from "../common/redis/redis-keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { idempotencyKey, StripeClient, StripeNotConfiguredError } from "../common/stripe/stripe.client";
import type { PlatformBackendConfig } from "../config";
import { TENANT_ACTIONS } from "../memberships/tenant-roles";
import {
  PaymentConnectionsRepository,
  type ConnectCapabilities,
  type PaymentConnectionView,
  type PaymentEnvironment,
} from "./payment-connections.repository";

export type StripeConnectStart = components["schemas"]["StripeConnectStart"];
export type CompleteStripeConnectRequest = components["schemas"]["CompleteStripeConnectRequest"];

/** Stripe's Connect OAuth authorize endpoint (PADR-0011 item 2). */
export const STRIPE_CONNECT_AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";
/** The portal's fixed callback page, the `redirect_uri` registered with Stripe. */
export const STRIPE_CONNECT_CALLBACK_PATH = "/connect/stripe/callback";
/** The random bytes of a state: 256 bits. */
export const CONNECT_STATE_BYTES = 32;
/** A state as `start` makes it: 43 base64url characters (within the document's `StripeConnectState`). */
export const CONNECT_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The constraint that keeps one `acct_…` per OTA (migration 0002). */
export const CONNECT_ACCOUNT_INDEX = "payment_provider_connections_connect_uq";
/** Stripe's account ids, as `payment_provider_connections_mode_ck` takes them. */
const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;

/** The roles that may connect a Stripe account, from scope §1.2 (`changeConnections`: owners and admins). */
const CONNECT_ROLES: ReadonlySet<string> = new Set(TENANT_ACTIONS.changeConnections.roles);
const UNIQUE_VIOLATION = "23505";

/** The id patterns of the state's value (`ten_`, `acc_`, `stf_` and a ULID). */
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const STATE_IDS = {
  tenantId: new RegExp(`^ten_${ULID}$`),
  accountId: new RegExp(`^acc_${ULID}$`),
  membershipId: new RegExp(`^stf_${ULID}$`),
} as const;

/** The value of `stripe:oauth:<sha256(state)>` (PADR-0011 item 2). */
export interface StripeOAuthStateValue {
  readonly tenantId: string;
  readonly accountId: string;
  /** `stf_…`: the membership that started it. */
  readonly membershipId: string;
}

/** The OTA of a completed connection and its connections after the switch, `test` first. */
export interface CompletedConnection {
  readonly tenantId: string;
  readonly connections: readonly PaymentConnectionView[];
}

/** A new state: 256 bits from the CSPRNG as base64url. Hand it out once; store only its SHA-256. */
export function generateConnectState(): string {
  const bytes = randomBytes(CONNECT_STATE_BYTES);
  const state = bytes.toString("base64url");
  bytes.fill(0);
  return state;
}

/** The portal's callback URL: PUBLIC_PORTAL_URL with `/connect/stripe/callback` after its path, no query or fragment. */
export function connectCallbackUrl(portalUrl: string): string {
  const url = new URL(portalUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${STRIPE_CONNECT_CALLBACK_PATH}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Stripe's authorize URL of a Connect Standard OAuth, with the parameters of PADR-0011 item 2 in its order. */
export function stripeConnectAuthorizeUrl(input: {
  readonly clientId: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly email: string;
}): string {
  const url = new URL(STRIPE_CONNECT_AUTHORIZE_URL);
  url.search = new URLSearchParams([
    ["response_type", "code"],
    ["client_id", input.clientId],
    ["scope", "read_write"],
    ["state", input.state],
    ["redirect_uri", input.redirectUri],
    ["stripe_user[email]", input.email],
  ]).toString();
  return url.toString();
}

/** The value of a state's key, or `undefined` when it is missing or not of `start`'s shape. */
export function parseConnectState(raw: string | null): StripeOAuthStateValue | undefined {
  if (raw === null) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const [name, pattern] of Object.entries(STATE_IDS)) {
    const id = record[name];
    if (typeof id !== "string" || !pattern.test(id)) {
      return undefined;
    }
  }
  return {
    tenantId: record["tenantId"] as string,
    accountId: record["accountId"] as string,
    membershipId: record["membershipId"] as string,
  };
}

/** The `details.reason` of a `{state, error}` callback: `access_denied` when the person declined, else `oauth_error`. */
export function oauthErrorReason(error: string): "access_denied" | "oauth_error" {
  return error === "access_denied" ? "access_denied" : "oauth_error";
}

/** The Stripe calls of the Connect OAuth. */
export type StripeConnectOperation = "oauth.token" | "accounts.retrieve";

/** A Stripe call of the Connect OAuth that failed, or answered something unusable. */
export class StripeConnectFailure extends Error {
  override readonly name = "StripeConnectFailure";

  constructor(
    readonly operation: StripeConnectOperation,
    /** `<type> <status> (<code>)`, for example `invalid_grant 400`; never Stripe's message, which may quote the code. */
    readonly summary: string,
    /** True when Stripe refused the authorisation code itself (`invalid_grant`). */
    readonly invalidGrant = false,
  ) {
    super(`Stripe ${operation} failed: ${summary}`);
  }
}

/** True when `value` is a short lower-case identifier of Stripe (an error type or code), safe to log. */
const isStripeIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z_]{1,60}$/.test(value);

/** The StripeConnectFailure of an error thrown by the SDK (or by StripeClient) during `operation`. */
export function stripeConnectFailureOf(
  operation: StripeConnectOperation,
  error: unknown,
): StripeConnectFailure {
  if (error instanceof StripeConnectFailure) {
    return error;
  }
  if (error instanceof StripeNotConfiguredError) {
    return new StripeConnectFailure(operation, "not_configured (STRIPE_SECRET_KEY is not set)");
  }
  if (error instanceof Stripe.errors.StripeError) {
    const connection = error instanceof Stripe.errors.StripeConnectionError;
    const rawType: unknown = error.rawType;
    const type = connection ? "connection_error" : isStripeIdentifier(rawType) ? rawType : "error";
    const status = error.statusCode === undefined ? "no_status" : String(error.statusCode);
    const code = isStripeIdentifier(error.code) ? ` (${error.code})` : "";
    return new StripeConnectFailure(
      operation,
      `${type} ${status}${code}`,
      error instanceof Stripe.errors.StripeInvalidGrantError,
    );
  }
  const name = error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "Error";
  return new StripeConnectFailure(operation, `unexpected ${name}`);
}

/**
 * The API's answer to a failed Stripe call: `422 UNPROCESSABLE` (`oauth_error`) for a code Stripe refused, else `502
 * PROVIDER_ERROR` (`details.provider = stripe`); the failure is the logged cause.
 */
export function connectProviderError(failure: StripeConnectFailure): AppError {
  return failure.invalidGrant
    ? new AppError("UNPROCESSABLE", { details: { reason: "oauth_error" }, cause: failure })
    : new AppError("PROVIDER_ERROR", { details: { provider: "stripe" }, cause: failure });
}

/** The capabilities of a retrieved account: its three flags, `false` where Stripe gives none. */
export function connectCapabilitiesOf(
  account: Pick<Stripe.Account, "charges_enabled" | "payouts_enabled" | "details_submitted">,
): ConnectCapabilities {
  return {
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    detailsSubmitted: account.details_submitted === true,
  };
}

/** A Redis error reduced to its name and message (an ioredis reply error lists the command's arguments, the key too). */
function redisFailure(error: unknown): Error {
  const failure = new Error(error instanceof Error ? error.message : "Redis command failed");
  failure.name = error instanceof Error ? error.name : "Error";
  return failure;
}

/** True for the `pg` error of an `acct_…` that another OTA's connection took meanwhile (Kysely passes it through). */
function isConnectAccountConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === CONNECT_ACCOUNT_INDEX;
}

const alreadyConnected = (): AppError => new AppError("STRIPE_ACCOUNT_ALREADY_CONNECTED");

@Injectable()
export class StripeConnectService {
  private readonly clientId: string | undefined;
  private readonly callbackUrl: string;
  /** The deployment's Stripe mode: live with `APP_ENV=production`, test everywhere else. */
  private readonly live: boolean;

  constructor(
    private readonly connections: PaymentConnectionsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly stripe: StripeClient,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(StripeConnectService.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.clientId = config.get("STRIPE_CONNECT_CLIENT_ID", { infer: true });
    this.callbackUrl = connectCallbackUrl(config.get("PUBLIC_PORTAL_URL", { infer: true }));
    this.live = config.get("APP_ENV", { infer: true }) === "production";
  }

  /** startStripeConnect: a single-use state for the caller and Stripe's authorize URL (file header). */
  async start(caller: TenantMembership): Promise<StripeConnectStart> {
    const { tenantId, accountId, membershipId } = caller;
    if (this.clientId === undefined) {
      // FEATURE_OWN_STRIPE requires it (config.ts), so only a configuration bug gets here: 500, nothing stored.
      throw new Error("StripeConnectService.start: STRIPE_CONNECT_CLIENT_ID is not set");
    }
    const starter = await this.connections.connectStarter(tenantId, accountId);
    if (starter === undefined) {
      // The membership ended after TenantRoleGuard read it.
      throw new AppError("NOT_FOUND");
    }
    if (starter.tenant_status !== "active") {
      throw new AppError("TENANT_NOT_ACTIVE", { details: { status: starter.tenant_status } });
    }
    const state = generateConnectState();
    const value: StripeOAuthStateValue = { tenantId, accountId, membershipId };
    const expiresAt = new Date(this.clock.now().getTime() + STRIPE_OAUTH_STATE_TTL_SECONDS * 1000);
    let stored: boolean;
    try {
      stored = await setKeyIfAbsent(
        this.redis,
        redisKeys.stripeOAuthState(sha256Hex(state)),
        JSON.stringify(value),
      );
    } catch (error) {
      throw new AppError("SERVICE_UNAVAILABLE", { cause: redisFailure(error) });
    }
    if (!stored) {
      // A 256-bit state never repeats; if it ever did, NX kept the other one, and this one is not handed out.
      throw new Error("StripeConnectService.start: the state key exists already");
    }
    return {
      authorizeUrl: stripeConnectAuthorizeUrl({
        clientId: this.clientId,
        state,
        redirectUri: this.callbackUrl,
        email: starter.email,
      }),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * completeStripeConnect: redeems the state for `accountId` and, for an authorisation code, switches the OTA's
   * connections to the connected account (file header).
   */
  async complete(accountId: string, body: CompleteStripeConnectRequest): Promise<CompletedConnection> {
    const stateDigest = sha256Hex(body.state);
    const state = await this.redeem(stateDigest);
    if (state.accountId !== accountId) {
      this.logger.warn({ tenantId: state.tenantId }, "stripe_connect.state_account_mismatch");
      throw new AppError("CONNECT_STATE_INVALID");
    }
    const { tenantId } = state;
    const member = await this.connections.connectMember(tenantId, accountId);
    if (
      member === undefined ||
      member.membership_id !== state.membershipId ||
      !CONNECT_ROLES.has(member.role)
    ) {
      throw new AppError("FORBIDDEN");
    }
    if (member.tenant_status !== "active") {
      throw new AppError("TENANT_NOT_ACTIVE", { details: { status: member.tenant_status } });
    }
    if ("error" in body) {
      throw new AppError("UNPROCESSABLE", { details: { reason: oauthErrorReason(body.error) } });
    }
    const accountReference = await this.exchange(body.code, stateDigest);
    if ((await this.connections.connectedElsewhere(accountReference, tenantId)) !== undefined) {
      throw alreadyConnected();
    }
    const capabilities = await this.capabilitiesOf(accountReference);
    try {
      return await this.apply(tenantId, accountId, accountReference, capabilities);
    } catch (error) {
      throw isConnectAccountConflict(error) ? alreadyConnected() : error;
    }
  }

  /** `GETDEL` of the state's key: the stored value, `400 CONNECT_STATE_INVALID` without one, `503` without Redis. */
  private async redeem(stateDigest: string): Promise<StripeOAuthStateValue> {
    let raw: string | null;
    try {
      raw = await this.redis.getdel(redisKeys.stripeOAuthState(stateDigest).key);
    } catch (error) {
      throw new AppError("SERVICE_UNAVAILABLE", { cause: redisFailure(error) });
    }
    const value = parseConnectState(raw);
    if (value === undefined) {
      throw new AppError("CONNECT_STATE_INVALID");
    }
    return value;
  }

  /**
   * Exchanges the authorisation code (step 4 of the file header) and answers the connected `acct_…` when its mode is
   * the deployment's. The tokens of Stripe's answer are not kept: only two fields are read from it.
   */
  private async exchange(code: string, stateDigest: string): Promise<string> {
    let grant: { readonly stripeUserId: unknown; readonly livemode: unknown };
    try {
      const answer = await this.stripe
        .api()
        .oauth.token(
          { grant_type: "authorization_code", code },
          { idempotencyKey: idempotencyKey("connect_oauth", stateDigest) },
        );
      grant = { stripeUserId: answer.stripe_user_id, livemode: answer.livemode };
    } catch (error) {
      throw connectProviderError(stripeConnectFailureOf("oauth.token", error));
    }
    if (typeof grant.stripeUserId !== "string" || !STRIPE_ACCOUNT_ID.test(grant.stripeUserId)) {
      throw connectProviderError(new StripeConnectFailure("oauth.token", "the answer has no acct_ id"));
    }
    if (grant.livemode !== this.live) {
      throw new AppError("UNPROCESSABLE", { details: { reason: "livemode_mismatch" } });
    }
    return grant.stripeUserId;
  }

  /** The connected account's capabilities (step 7 of the file header). */
  private async capabilitiesOf(accountReference: string): Promise<ConnectCapabilities> {
    try {
      return connectCapabilitiesOf(await this.stripe.api().accounts.retrieve(accountReference));
    } catch (error) {
      throw connectProviderError(stripeConnectFailureOf("accounts.retrieve", error));
    }
  }

  /** Step 8 of the file header: the switch of the OTA's connections, in one transaction. */
  private async apply(
    tenantId: string,
    accountId: string,
    accountReference: string,
    capabilities: ConnectCapabilities,
  ): Promise<CompletedConnection> {
    return runInTransaction(this.db, async (trx) => {
      const tenant = await this.connections.tenantForShare(trx, tenantId);
      if (tenant === undefined) {
        throw new AppError("FORBIDDEN");
      }
      if (tenant.status !== "active") {
        throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenant.status } });
      }
      if ((await this.connections.connectedElsewhere(accountReference, tenantId, trx)) !== undefined) {
        throw alreadyConnected();
      }
      const environments: readonly PaymentEnvironment[] =
        tenant.storefront_environment === "live" ? ["test", "live"] : ["test"];
      const now = this.clock.now();
      const write = {
        accountReference,
        capabilities,
        status: capabilities.chargesEnabled ? ("active" as const) : ("pending" as const),
        connectedByAccountId: accountId,
        now,
      };
      let suffix: string | null = null;
      for (const environment of environments) {
        const current = await this.connections.lockForTenant(trx, tenantId, environment);
        const updated: PaymentConnectionView =
          current === undefined
            ? await this.connections.insertConnectStandard(trx, {
                ...write,
                id: this.ids.new("ppc"),
                tenantId,
                environment,
                statementDescriptorSuffix: suffix,
              })
            : await this.connections.applyConnectStandard(trx, current.id, write);
        suffix ??= updated.statement_descriptor_suffix;
        await this.audit.record(trx, {
          actorType: "account",
          actorAccountId: accountId,
          action: "payments.connect_connected",
          targetType: "payment_connection",
          targetId: updated.id,
          tenantId,
          ...(current === undefined
            ? {}
            : {
                before: {
                  accountMode: current.account_mode,
                  accountReference: current.account_reference,
                  status: current.status,
                },
              }),
          after: {
            accountMode: updated.account_mode,
            accountReference: updated.account_reference,
            status: updated.status,
            capabilities,
          },
          details: { environment },
        });
      }
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
      return { tenantId, connections: await this.connections.listForTenant(tenantId, trx) };
    });
  }
}
