// `bookings.list`, `bookings.get`, `bookings.getTicketingStatus`, `bookings.listEvents` and `bookings.getFareRules`
// (listBookings, getBooking, getBookingTicketingStatus, listBookingEvents, getBookingFareRules; `x-scope: customer`;
// OBE-046): thin handlers over CustomerBookingsService. The global guards resolved the caller, the tenant and its
// environment, the scope and the signed-in customer (required by bookings.list, optional on the others, which a guest
// booking token opens too); `BookingAccessGuard` lets in the owning customer or the holder of the booking's guest
// token (404 for anyone else); the validation interceptor checked the input against the OTA document. Answers are
// `Cache-Control: private, no-store` (`no-store` for the ticketing status), bookings.get with `ETag: "<version>"`.
//
// bookings.update (OBE-048), bookings.quoteCancellation and bookings.cancel (OBE-049) join this controller.
import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { BookingAccessGuard } from "../common/auth/booking-access.guard";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  BOOKING_CACHE_CONTROL,
  bookingEtagOf,
  TICKETING_CACHE_CONTROL,
  type BookingEvent,
  type BookingFareRules,
  type BookingSummary,
  type BookingTicketingStatus,
} from "./bookings.mapper";
import { CustomerBookingsService, type Page } from "./customer-bookings.service";
import type { Booking } from "./order-recorder";

@Controller("v1/bookings")
export class CustomerBookingsController {
  constructor(private readonly bookings: CustomerBookingsService) {}

  @Get()
  @OpenApiOperation("listBookings")
  async list(
    @OpenApiInput() input: ValidatedInput<"listBookings">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Page<BookingSummary>> {
    res.setHeader("Cache-Control", BOOKING_CACHE_CONTROL);
    return await this.bookings.list(input.query ?? {});
  }

  @Get(":bookingId")
  @OpenApiOperation("getBooking")
  @UseGuards(BookingAccessGuard)
  async get(
    @OpenApiInput() input: ValidatedInput<"getBooking">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Booking> {
    const booking = await this.bookings.get(input.path.bookingId, {
      refresh: input.query?.refresh === true,
      include: input.query?.include,
      fareRules: input.query?.fareRules,
    });
    res.setHeader("ETag", bookingEtagOf(booking.version));
    res.setHeader("Cache-Control", BOOKING_CACHE_CONTROL);
    return booking;
  }

  @Get(":bookingId/ticketing")
  @OpenApiOperation("getBookingTicketingStatus")
  @UseGuards(BookingAccessGuard)
  async ticketingStatus(
    @OpenApiInput() input: ValidatedInput<"getBookingTicketingStatus">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BookingTicketingStatus> {
    res.setHeader("Cache-Control", TICKETING_CACHE_CONTROL);
    return await this.bookings.ticketingStatus(input.path.bookingId, input.query?.refresh === true);
  }

  @Get(":bookingId/events")
  @OpenApiOperation("listBookingEvents")
  @UseGuards(BookingAccessGuard)
  async events(
    @OpenApiInput() input: ValidatedInput<"listBookingEvents">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Page<BookingEvent>> {
    res.setHeader("Cache-Control", BOOKING_CACHE_CONTROL);
    return await this.bookings.events(input.path.bookingId, {
      cursor: input.query?.cursor,
      limit: input.query?.limit,
    });
  }

  @Get(":bookingId/fare-rules")
  @OpenApiOperation("getBookingFareRules")
  @UseGuards(BookingAccessGuard)
  async fareRules(
    @OpenApiInput() input: ValidatedInput<"getBookingFareRules">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BookingFareRules> {
    res.setHeader("Cache-Control", BOOKING_CACHE_CONTROL);
    return await this.bookings.fareRules(input.path.bookingId, {
      types: input.query?.types,
      refresh: input.query?.refresh === true,
    });
  }
}
