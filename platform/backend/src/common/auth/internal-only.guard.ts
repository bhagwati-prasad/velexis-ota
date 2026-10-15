// InternalOnlyGuard (platform/docs/architecture.md §3 step 5, PADR-0009 item 1): the guard of every operation whose
// `x-scope` is `internal` (Caddy's TLS `ask` gate, `/health/ready`). Such a request must come straight from the VM:
// the socket peer is loopback and there is no `X-Forwarded-For`, which Caddy sets on every request it proxies. Anything
// else answers `404 NOT_FOUND`, as if the route did not exist, so the internal surface cannot be probed through Caddy
// (which also refuses `/internal/*` and `/health/*` except `/health/live` publicly). No token is involved.
//
// The peer is the socket's address, never Express's `req.ip`, which `trust proxy` takes from `X-Forwarded-For`.
import type { IncomingHttpHeaders } from "node:http";
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { isLoopbackAddress } from "../http/end-user";
import { OperationPolicies } from "./decorators";

/** The parts of a request the guard reads. */
export interface InternalRequest {
  readonly headers: IncomingHttpHeaders;
  readonly socket: { readonly remoteAddress?: string | undefined };
}

/** True when the request came from the VM itself: a loopback peer and no `X-Forwarded-For`. */
export function isInternalRequest(request: InternalRequest): boolean {
  return isLoopbackAddress(request.socket.remoteAddress) && request.headers["x-forwarded-for"] === undefined;
}

@Injectable()
export class InternalOnlyGuard implements CanActivate {
  constructor(private readonly policies: OperationPolicies) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http" || this.policies.forContext(context).scope !== "internal") {
      return true;
    }
    if (!isInternalRequest(context.switchToHttp().getRequest<InternalRequest>())) {
      throw new AppError("NOT_FOUND");
    }
    return true;
  }
}
