// `bookings.listDocuments` and `bookings.getDocumentDownloadUrl` (listBookingDocuments, getBookingDocumentDownloadUrl;
// `x-scope: customer`; OBE-054, OADR-0013 item 9): thin handlers over DocumentDownloadsService. The global guards
// resolved the caller, the tenant and its environment, the scope and the signed-in customer (optional here: a guest
// booking token opens these operations too); `BookingAccessGuard` lets in the owning customer or the holder of the
// booking's guest token (404 for anyone else); the validation interceptor checked the input against the OTA document.
// The list answers `Cache-Control: private, no-store`, the download URL `no-store` (it expires). BookingsModule
// registers this controller (its booking access guard reads the booking through the bookings module), over the
// DocumentDownloadsService that the global DocumentsModule exports.
import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { BookingAccessGuard } from "../common/auth/booking-access.guard";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  DocumentDownloadsService,
  DOCUMENTS_CACHE_CONTROL,
  DOWNLOAD_URL_CACHE_CONTROL,
  type DocumentDownloadUrl,
  type DocumentPage,
} from "./document-downloads.service";

@Controller("v1/bookings")
export class DocumentsController {
  constructor(private readonly downloads: DocumentDownloadsService) {}

  @Get(":bookingId/documents")
  @OpenApiOperation("listBookingDocuments")
  @UseGuards(BookingAccessGuard)
  async list(
    @OpenApiInput() input: ValidatedInput<"listBookingDocuments">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentPage> {
    res.setHeader("Cache-Control", DOCUMENTS_CACHE_CONTROL);
    return await this.downloads.list(input.path.bookingId, {
      kinds: input.query?.kind,
      cursor: input.query?.cursor,
      limit: input.query?.limit,
    });
  }

  @Get(":bookingId/documents/:documentId/download-url")
  @OpenApiOperation("getBookingDocumentDownloadUrl")
  @UseGuards(BookingAccessGuard)
  async downloadUrl(
    @OpenApiInput() input: ValidatedInput<"getBookingDocumentDownloadUrl">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentDownloadUrl> {
    res.setHeader("Cache-Control", DOWNLOAD_URL_CACHE_CONTROL);
    return await this.downloads.downloadUrl(input.path.bookingId, input.path.documentId);
  }
}
