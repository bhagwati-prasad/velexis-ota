// GET /internal/tls/ask?domain=<host> (operation tlsAsk, api-inventory-admin.md §9; ADR-0018, PADR-0004 item 6): Caddy's
// on-demand TLS gate. `200` with no body when Caddy may obtain a certificate for the host, `404 NOT_FOUND` otherwise
// (TlsAskService decides). The operation's `x-scope` is `internal`: InternalOnlyGuard answers `404` before the handler
// runs unless the request comes from loopback without `X-Forwarded-For`, and Caddy blocks `/internal/*` on the public
// hosts. `domain` has no schema constraint in the document, not even a type, so a missing or malformed host, or a
// repeated `domain` (which arrives as a list), reaches the service and is refused with `404` like any other, never
// `400` (PADR-0004 item 6: everything else, including malformed input, is `404`).
import { Controller, Get, HttpCode } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { TlsAskService } from "./tls-ask.service";

@Controller("internal/tls")
export class TlsAskController {
  constructor(private readonly tlsAsk: TlsAskService) {}

  @Get("ask")
  @HttpCode(200)
  @OpenApiOperation("tlsAsk")
  async ask(@Validated("query") query: Readonly<Record<string, unknown>>): Promise<void> {
    if (!(await this.tlsAsk.ask(query["domain"]))) {
      throw new AppError("NOT_FOUND");
    }
  }
}
