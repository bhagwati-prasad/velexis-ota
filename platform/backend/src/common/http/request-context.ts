// The request context of the platform API (platform/docs/architecture.md §3, step 3): one nestjs-cls store per
// request, `{requestId, ip, userAgent, actor?}`. pino-http has set the request id first (a valid `X-Request-Id` from
// Caddy or a new UUID), the ClsMiddleware takes it as the context id, and EndUserMiddleware (end-user.ts) fills the
// end user's IP and user agent as PADR-0019 says. Guards add the actor (PBE-012). The throttler, the audit log,
// sessions and tokens read the IP and user agent only from here, never `req.ip` or the raw headers (PADR-0019 item 4).
import { Injectable, type DynamicModule } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { REQUEST_ID_HEADER, resolveRequestId } from "@velexis/logger";
import { ClsModule, ClsService, type ClsStore } from "nestjs-cls";

/** Who acts in a request: the `actorType` of `platform_audit_log` (`account`, `platform_admin`, `api_key`, `system`). */
export type ActorType = components["schemas"]["AuditActorType"];

/** The authenticated caller, set by the auth guards (PBE-012). */
export interface RequestActor {
  readonly type: ActorType;
  /** `acc_…` of a portal account or a platform admin. */
  readonly accountId?: string;
}

/** The end user of a request: the person behind the portal or admin server, or the direct caller (§3.2). */
export interface EndUser {
  /** An IPv4 or IPv6 address (`net.isIP`), IPv4-mapped IPv6 addresses written as IPv4. */
  readonly ip: string;
  /** At most 512 characters; `undefined` when the caller sent none. */
  readonly userAgent: string | undefined;
}

/** The store of one request. */
export interface RequestContextStore extends ClsStore {
  requestId: string;
  ip?: string;
  userAgent?: string | undefined;
  actor?: RequestActor;
}

interface RequestWithId {
  readonly id?: unknown;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/**
 * The id of the request context: the one pino-http has already taken from a valid `X-Request-Id` or generated (and
 * returned in the response header), so the context, the log lines and the response agree. The fallback only runs if
 * the middleware order were broken; the integration tests prove it is not.
 */
export function requestIdOf(req: RequestWithId): string {
  return typeof req.id === "string" ? req.id : resolveRequestId(req.headers[REQUEST_ID_HEADER]);
}

/**
 * The nestjs-cls module of the API, global. Its middleware is not mounted by nestjs-cls: AppModule mounts it in the
 * order of `API_REQUEST_MIDDLEWARE` (common.module.ts), after pino-http and the body parser.
 */
export function requestContextModule(): DynamicModule {
  return ClsModule.forRoot({
    global: true,
    middleware: {
      mount: false,
      generateId: true,
      idGenerator: requestIdOf,
      setup: (cls) => {
        cls.set("requestId", cls.getId());
      },
    },
  });
}

/**
 * Typed access to the request context. Outside a request (a job, a CLI command) every getter returns `undefined` and
 * the setters throw: the context exists only inside the API's request pipeline.
 */
@Injectable()
export class RequestContext {
  constructor(private readonly cls: ClsService<RequestContextStore>) {}

  /** True inside a request of the API. */
  get active(): boolean {
    return this.cls.isActive();
  }

  get requestId(): string | undefined {
    return this.cls.isActive() ? this.cls.get("requestId") : undefined;
  }

  /** The end user's IP (PADR-0019): the forwarded one for the portal and admin servers, else Express's `req.ip`. */
  get ip(): string | undefined {
    return this.cls.isActive() ? this.cls.get("ip") : undefined;
  }

  /** The end user's user agent, at most 512 characters. */
  get userAgent(): string | undefined {
    return this.cls.isActive() ? this.cls.get("userAgent") : undefined;
  }

  get actor(): RequestActor | undefined {
    return this.cls.isActive() ? this.cls.get("actor") : undefined;
  }

  /** Set once per request by EndUserMiddleware. */
  setEndUser(endUser: EndUser): void {
    this.cls.set("ip", endUser.ip);
    this.cls.set("userAgent", endUser.userAgent);
  }

  /** Set by the auth guards once the caller is known. */
  setActor(actor: RequestActor): void {
    this.cls.set("actor", actor);
  }
}
