// The file endpoint of booking documents, `GET /v1/files/{storageKey}?exp=…&sig=…` (downloadFile; `security: []`,
// `x-sdk-exclude`; OBE-054, OADR-0013 item 9, ADR-0017): what the signed URLs of bookings.getDocumentDownloadUrl point
// at. A thin handler over DocumentDownloadsService.file.
//
// The route is public (`@PublicRoute()`): a browser follows the URL without a credential, and one that comes with it
// (the storefront edge's header, an API key) is classified and its tenant resolved by the global guards as on any
// route. `{storageKey}` holds several path segments (`tenant_<key>/documents/<bookingId>/<documentId>.pdf`), so the
// route is Express 5's named wildcard `*storageKey`; the validation interceptor reads the segments back as one path
// value. The handler passes the request's URL as received (`req.originalUrl`: the signed path and its `exp` and `sig`)
// to the service, which checks the signature on exactly those characters; the rate limit (120 per minute per IP,
// `publicDownloads` of rate-limits.ts) ran before.
//
// The answer is the file's bytes with its content type, `Content-Disposition: attachment; filename="<fileName>"` (the
// file name of the document row, kept to `[A-Za-z0-9._-]`), `Cache-Control: private, no-store` and
// `X-Content-Type-Options: nosniff`; helmet's `Content-Security-Policy: default-src 'none'` stays, so a file opened
// directly runs nothing.
import { Controller, Get, Req, Res, StreamableFile } from "@nestjs/common";
import type { Request, Response } from "express";
import { PublicRoute } from "../common/auth/caller.guard";
import { OpenApiOperation } from "../common/http/openapi-operation.decorator";
import { DocumentDownloadsService, DOCUMENTS_CACHE_CONTROL } from "./document-downloads.service";

/** `attachment; filename="<name>"` with every character outside `[A-Za-z0-9._-]` replaced by `_`. */
export function attachmentDisposition(fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return `attachment; filename="${safe === "" ? "document.pdf" : safe}"`;
}

@Controller("v1/files")
@PublicRoute()
export class FilesController {
  constructor(private readonly downloads: DocumentDownloadsService) {}

  @Get("*storageKey")
  @OpenApiOperation("downloadFile")
  async download(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.downloads.file(req.originalUrl);
    res.setHeader("Cache-Control", DOCUMENTS_CACHE_CONTROL);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return new StreamableFile(file.bytes, {
      type: file.contentType,
      disposition: attachmentDisposition(file.fileName),
      length: file.bytes.length,
    });
  }
}
