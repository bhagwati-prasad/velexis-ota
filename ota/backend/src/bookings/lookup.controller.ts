// `bookings.lookup` (lookupBooking, `x-scope: customer`; OBE-047): a thin handler over GuestAccessService. The global
// guards resolved the caller (the storefront edge, or a `pk_`/`sk_` key), the tenant and its environment and the scope,
// and the CSRF guard checked the edge's POST; the validation interceptor checked the body (`bookingReference` of 5 to
// 10 letters and digits, `lastName` of 1 to 60 characters) and the required `Idempotency-Key`, and the idempotency
// interceptor stores the answer under it, so a retry with the same key gets the same token (the stored copy keeps the
// token and the cookie only in its ciphertext). The answer is `200` BookingLookupResult with `Cache-Control: no-store`;
// in edge mode the token is in `__Host-vx_bt` and `bookingToken` is `null`. Every mismatch is the same `404`, and the
// sixth failure within 15 minutes per IP or per reference `429` with `Retry-After` (guest-access.service.ts).
import { Controller, HttpCode, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import { GuestAccessService, type BookingLookupResult } from "./guest-access.service";

/** `Cache-Control` of the lookup's answers (the contract's "Caching"). */
export const LOOKUP_CACHE_CONTROL = "no-store";

@Controller("v1/bookings")
export class LookupController {
  constructor(private readonly guestAccess: GuestAccessService) {}

  @Post("lookup")
  @HttpCode(200)
  @OpenApiOperation("lookupBooking")
  async lookup(
    @OpenApiInput() input: ValidatedInput<"lookupBooking">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BookingLookupResult> {
    if (input.body === undefined) {
      throw new Error("lookupBooking without a validated body");
    }
    const result = await this.guestAccess.lookup(input.body);
    res.setHeader("Cache-Control", LOOKUP_CACHE_CONTROL);
    return result;
  }
}
