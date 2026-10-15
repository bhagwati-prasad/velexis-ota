// AdminAuthGuard (platform/docs/architecture.md §3 step 5 and §3.1, PADR-0006, PADR-0009 item 4): the guard of every
// operation whose `x-scope` is `platform_admin`. It verifies an access token of the audience `platform_admin`, so a
// portal token never works here, and then re-reads the account on every request: only an account that still exists,
// is `active` and is a platform admin passes. Anything else answers `401 UNAUTHENTICATED`, as a missing token does
// (`TOKEN_EXPIRED` for an expired one), so a revoked admin loses access at once, not when the token expires.
//
// `AccountAuthStates` is that read (one indexed query by primary key, no cache), shared with RecentMfaGuard.
import type { IncomingHttpHeaders } from "node:http";
import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { bearerTokenOf, TokenService } from "../../auth/token.service";
import { PLATFORM_DB, type PlatformDb } from "../database";
import { RequestContext } from "../http/request-context";
import { OperationPolicies, setAccessToken } from "./decorators";

/** The lifecycle states of `platform.accounts.status` (migration 0001). */
export type AccountStatus = "pending_verification" | "active" | "locked" | "disabled" | "deleted";

/** What the guards need to know about an account, read fresh on each request. */
export interface AccountAuthState {
  readonly status: AccountStatus;
  readonly isPlatformAdmin: boolean;
  readonly mfaEnabled: boolean;
}

/** Reads the AccountAuthState of an account from `platform.accounts`; replaceable in tests. */
@Injectable()
export class AccountAuthStates {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** The state of `accountId`; `undefined` when there is no such account or it was erased (`deleted_at`). */
  async read(accountId: string): Promise<AccountAuthState | undefined> {
    const row = await this.db
      .selectFrom("platform.accounts")
      .select(["status", "is_platform_admin", "mfa_enabled", "deleted_at"])
      .where("id", "=", accountId)
      .executeTakeFirst();
    if (row === undefined || row.deleted_at !== null) {
      return undefined;
    }
    return {
      status: row.status as AccountStatus,
      isPlatformAdmin: row.is_platform_admin,
      mfaEnabled: row.mfa_enabled,
    };
  }
}

/** True when the account may use the admin surface now: it exists, is active and is a platform admin. */
export function isActivePlatformAdmin(state: AccountAuthState | undefined): boolean {
  return state !== undefined && state.status === "active" && state.isPlatformAdmin;
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly policies: OperationPolicies,
    private readonly tokens: TokenService,
    private readonly accounts: AccountAuthStates,
    private readonly context: RequestContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http" || this.policies.forContext(context).scope !== "platform_admin") {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ readonly headers: IncomingHttpHeaders }>();
    const claims = await this.tokens.verify(bearerTokenOf(request.headers), "platform_admin");
    if (!isActivePlatformAdmin(await this.accounts.read(claims.sub))) {
      throw new AppError("UNAUTHENTICATED");
    }
    setAccessToken(request, claims);
    this.context.setActor({ type: "platform_admin", accountId: claims.sub });
    return true;
  }
}
