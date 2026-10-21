// The booking access guard (OBE-046; architecture §3 step 8 "booking token", ota/docs/flows/my-bookings-and-guest-lookup.md
// §3 steps 5 and 8 and §4, the contract's "Access" of bookings.get and the operations under it): who may use one
// booking through the customer operations on `/v1/bookings/{bookingId}…`. It runs on those handlers only
// (`@UseGuards(BookingAccessGuard)`), after the global guards: the caller, the tenant and its environment, the scope
// and the signed-in customer (customer guard, optional on these operations) are known.
//
//   no signed-in customer and no guest token for the booking            → 401 UNAUTHENTICATED (the page offers the
//                                                                          lookup; nothing about the booking is read)
//   unknown id, or a booking of the other environment (a test booking
//   seen from a live storefront or with a live key)                     → 404 NOT_FOUND
//   the signed-in customer owns the booking                             → allowed, `via: customer`
//   a presented guest token of this booking, not revoked, not expired   → allowed, `via: booking_token`
//   anyone else: another customer, a token of another booking, a token
//   that expired or was revoked                                         → 404 NOT_FOUND (the same answer as an
//                                                                          unknown id)
//
// Guest tokens are compared by their SHA-256 (`booking_access_tokens.token_hash`, never the token) in the same read as
// the booking. Where a request presents them is `presentedBookingTokens`: none until OBE-047 adds its sources, the
// `bkg_<id>.<token>` entry of the requested booking in the edge's `__Host-vx_bt` cookie and the `X-Booking-Token` header
// of key callers. Tokens are never logged.
//
// A path id that is not a booking id is left to the validation interceptor (`400 VALIDATION_FAILED`). The decision is
// kept in the request context (`BookingAccessContext`), and the services ask it again for the booking they read
// (`require`), so a handler that lost its guard answers 404 instead of serving the booking.
import { createHash } from "node:crypto";
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import type { Request } from "express";
import { ClsService } from "nestjs-cls";
import { BookingsRepository } from "../../bookings/bookings.repository";
import { CallerContext, type Caller } from "../../tenancy/caller-resolver";
import { TenantContext } from "../../tenancy/tenant-context";
import { TenantTx } from "../../tenancy/tenant-tx";
import { Clock } from "../clock";
import { CustomerContext } from "./customer.guard";

/** A booking id of the path (`BookingId` of the document). */
export const BOOKING_ID_PATTERN = /^bkg_[0-9A-Za-z]{16,40}$/;

/** How a request was let in to a booking. */
export type BookingAccessVia = "customer" | "booking_token";

/** The access the guard granted for the current request. */
export interface BookingAccess {
  readonly bookingId: string;
  readonly via: BookingAccessVia;
}

const ACCESS_KEY = "bookings.access";

/** The booking access of the current request in the request context (nestjs-cls), set by `BookingAccessGuard`. */
@Injectable()
export class BookingAccessContext {
  constructor(private readonly cls: ClsService) {}

  /** Records the access of the current request; outside a request it throws: there is nowhere to keep it. */
  set(access: BookingAccess): void {
    if (!this.cls.isActive()) {
      throw new Error("BookingAccessContext.set outside a request context");
    }
    this.cls.set(ACCESS_KEY, Object.freeze({ ...access }));
  }

  /** The access granted for `bookingId`; `404 NOT_FOUND` when the guard did not grant this booking. */
  require(bookingId: string): BookingAccess {
    const access: unknown = this.cls.isActive() ? this.cls.get(ACCESS_KEY) : undefined;
    if (typeof access !== "object" || access === null || (access as BookingAccess).bookingId !== bookingId) {
      throw new AppError("NOT_FOUND");
    }
    return access as BookingAccess;
  }
}

/**
 * The guest booking tokens a request presents for `bookingId` (raw tokens, compared by hash). None until OBE-047 adds
 * the `__Host-vx_bt` cookie of the edge and the `X-Booking-Token` header of key callers.
 */
export function presentedBookingTokens(
  _req: Request,
  _caller: Caller,
  _bookingId: string,
): readonly string[] {
  return [];
}

/** The SHA-256 (hex) of a guest token, as `booking_access_tokens.token_hash` stores it. */
export function bookingTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

@Injectable()
export class BookingAccessGuard implements CanActivate {
  constructor(
    private readonly callers: CallerContext,
    private readonly tenants: TenantContext,
    private readonly customers: CustomerContext,
    private readonly tx: TenantTx,
    private readonly repository: BookingsRepository,
    private readonly access: BookingAccessContext,
    private readonly clock: Clock,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    if (execution.getType() !== "http") {
      return true;
    }
    const req = execution.switchToHttp().getRequest<Request>();
    const bookingId = req.params["bookingId"];
    if (typeof bookingId !== "string" || !BOOKING_ID_PATTERN.test(bookingId)) {
      // Not a booking id: the validation interceptor answers 400 before the handler.
      return true;
    }
    const caller = this.callers.get();
    if (caller === undefined) {
      throw new Error(
        "BookingAccessGuard ran without a caller in the request context; CallerGuard must run first",
      );
    }
    const customer = this.customers.get();
    const tokens = presentedBookingTokens(req, caller, bookingId);
    if (customer === undefined && tokens.length === 0) {
      throw new AppError("UNAUTHENTICATED");
    }
    const tenant = this.tenants.require();
    const now = this.clock.now();
    const row = await this.tx.run((trx) =>
      this.repository.bookingAccess(trx, bookingId, tokens.map(bookingTokenHash), now),
    );
    if (row === undefined || row.environment !== tenant.environment) {
      throw new AppError("NOT_FOUND");
    }
    if (customer !== undefined && row.customerId !== null && row.customerId === customer.customerId) {
      this.access.set({ bookingId, via: "customer" });
      return true;
    }
    if (row.tokenGranted) {
      this.access.set({ bookingId, via: "booking_token" });
      return true;
    }
    throw new AppError("NOT_FOUND");
  }
}
