// `console.bookings.list` and `console.bookings.get` (consoleListBookings, consoleGetBooking; `x-scope: console`,
// `x-permission: bookings:read`; OBE-061): thin handlers over ConsoleBookingsService. The global guards resolved the
// caller (the OTA admin's service key with a staff token, a secret key with a staff token, or a `console:automation`
// key), the tenant and its environment (`X-Velexis-Environment` for the OTA admin, the key's own otherwise), the staff
// member, the rate limits and the permission (OADR-0011 points 3 to 6); the validation interceptor checked the input
// against the OTA document. Answers are `Cache-Control: private, no-store`, console.bookings.get with
// `ETag: "<version>"` (the If-Match of patch, issue and cancel).
//
// console.bookings.retrieve, patch, resync and addNote (OBE-062), issue and cancel (OBE-063) and the PNR lookup and
// import (OBE-064) join this controller. Nest registers a controller's routes in the order of its methods, and Express
// tries them in that order: the literal `GET by-record-locator` must be declared before `GET :bookingId`, or the
// get handler answers it (the route-parity test reads the router's order and fails then).
import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { bookingEtagOf } from "../bookings/bookings.mapper";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  CONSOLE_BOOKING_CACHE_CONTROL,
  type ConsoleBooking,
  type ConsoleBookingPage,
} from "./console-bookings.mapper";
import { ConsoleBookingsService } from "./console-bookings.service";

@Controller("v1/console/bookings")
export class ConsoleBookingsController {
  constructor(private readonly bookings: ConsoleBookingsService) {}

  @Get()
  @OpenApiOperation("consoleListBookings")
  async list(
    @OpenApiInput() input: ValidatedInput<"consoleListBookings">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleBookingPage> {
    res.setHeader("Cache-Control", CONSOLE_BOOKING_CACHE_CONTROL);
    return await this.bookings.list(input.query ?? {});
  }

  @Get(":bookingId")
  @OpenApiOperation("consoleGetBooking")
  async get(
    @OpenApiInput() input: ValidatedInput<"consoleGetBooking">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleBooking> {
    const booking = await this.bookings.get(input.path.bookingId, {
      refresh: input.query?.refresh === true,
      include: input.query?.include,
      fareRules: input.query?.fareRules,
    });
    res.setHeader("ETag", bookingEtagOf(booking.version));
    res.setHeader("Cache-Control", CONSOLE_BOOKING_CACHE_CONTROL);
    return booking;
  }
}
