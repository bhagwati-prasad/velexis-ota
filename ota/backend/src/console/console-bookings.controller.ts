// `console.bookings.list` and `console.bookings.get` (consoleListBookings, consoleGetBooking; `x-scope: console`,
// `x-permission: bookings:read`; OBE-061): thin handlers over ConsoleBookingsService. The global guards resolved the
// caller (the OTA admin's service key with a staff token, a secret key with a staff token, or a `console:automation`
// key), the tenant and its environment (`X-Velexis-Environment` for the OTA admin, the key's own otherwise), the staff
// member, the rate limits and the permission (OADR-0011 points 3 to 6); the validation interceptor checked the input
// against the OTA document. Answers are `Cache-Control: private, no-store`, console.bookings.get with
// `ETag: "<version>"` (the If-Match of patch, issue and cancel).
//
// Since OBE-062: console.bookings.retrieve (`bookings:read`), patch, resync and addNote (`bookings:write`) over
// ConsoleBookingActionsService (console-booking-actions.service.ts). retrieve is an audited read (OADR-0011 point 8):
// it opts in with `@AuditedRead`, and its use case writes the `order.retrieve` row with the booking, which the
// interceptor then leaves alone. patch and resync answer the booking's new `ETag`;
// addNote answers `201` with `Location` (the booking, anchored at the note), and its `Idempotency-Key` is the
// idempotency interceptor's. Issue and cancel (OBE-063) and the PNR lookup and import (OBE-064) join this controller.
// Nest registers a controller's routes in the order of its methods, and Express tries them in that order: the literal
// `GET by-record-locator` must be declared before `GET :bookingId`, or the get handler answers it (the route-parity
// test reads the router's order and fails then).
import { Controller, Get, HttpCode, Patch, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { bookingEtagOf } from "../bookings/bookings.mapper";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  ConsoleBookingActionsService,
  type ConsoleBookingNote,
  type ConsoleBookingResyncResult,
  type ConsoleFlightOrderRetrieval,
} from "./console-booking-actions.service";
import {
  CONSOLE_BOOKING_CACHE_CONTROL,
  type ConsoleBooking,
  type ConsoleBookingPage,
} from "./console-bookings.mapper";
import { ConsoleBookingsService } from "./console-bookings.service";
import { AuditedRead } from "./staff-actions.writer";

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: string, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

@Controller("v1/console/bookings")
export class ConsoleBookingsController {
  constructor(
    private readonly bookings: ConsoleBookingsService,
    private readonly actions: ConsoleBookingActionsService,
  ) {}

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

  @Patch(":bookingId")
  @OpenApiOperation("consolePatchBooking")
  async patch(
    @OpenApiInput() input: ValidatedInput<"consolePatchBooking">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleBooking> {
    const booking = await this.actions.patch(
      input.path.bookingId,
      input.headers["If-Match"],
      bodyOf("consolePatchBooking", input.body),
    );
    res.setHeader("ETag", bookingEtagOf(booking.version));
    res.setHeader("Cache-Control", CONSOLE_BOOKING_CACHE_CONTROL);
    return booking;
  }

  @Post(":bookingId/resync")
  @HttpCode(200)
  @OpenApiOperation("consoleResyncBooking")
  async resync(
    @OpenApiInput() input: ValidatedInput<"consoleResyncBooking">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleBookingResyncResult> {
    const result = await this.actions.resync(input.path.bookingId, input.body ?? {});
    res.setHeader("ETag", bookingEtagOf(result.booking.version));
    res.setHeader("Cache-Control", CONSOLE_BOOKING_CACHE_CONTROL);
    return result;
  }

  @Post(":bookingId/notes")
  @OpenApiOperation("consoleAddBookingNote")
  async addNote(
    @OpenApiInput() input: ValidatedInput<"consoleAddBookingNote">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleBookingNote> {
    const note = await this.actions.addNote(
      input.path.bookingId,
      bodyOf("consoleAddBookingNote", input.body),
    );
    res.setHeader("Location", `/v1/console/bookings/${note.bookingId}#${note.id}`);
    res.setHeader("Cache-Control", CONSOLE_BOOKING_CACHE_CONTROL);
    return note;
  }

  @Get(":bookingId/amadeus-order")
  @OpenApiOperation("consoleRetrieveFlightOrder")
  @AuditedRead({ action: "order.retrieve" })
  async retrieve(
    @OpenApiInput() input: ValidatedInput<"consoleRetrieveFlightOrder">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleFlightOrderRetrieval> {
    res.setHeader("Cache-Control", CONSOLE_BOOKING_CACHE_CONTROL);
    return await this.actions.retrieve(input.path.bookingId, input.query ?? {});
  }
}
