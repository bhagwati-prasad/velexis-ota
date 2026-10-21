// `GET /audit/export.csv` (README §2 route handlers, PF-85): the CSV file of the audit search, streamed from the platform
// API's `adminExportAudit` with the admin's token. It reads the same URL parameters as `/audit` (`audit-filters.ts`),
// so the file holds the rows of the list the admin sees: the period of two UTC days becomes the API's `from` (inclusive)
// and `to` (the start of the day after the last day, exclusive), at most one year, as the API requires.
//
// The body is never buffered here: the API's stream is handed to the browser as it arrives (up to 100 000 rows), and a
// failure in the middle of it aborts the answer, so a cut file is never taken for a complete one. The answer is an
// attachment named as the API names it, `Cache-Control: no-store` (the file holds e-mail and IP addresses). The API
// writes the export's own audit row (`audit.exported`). The middleware has already refreshed the session and sent a
// request without one to `/sign-in`; an ended session here goes there too, back to the audit page with its filters.
// Filters the page would not link and API refusals answer a short plain-text explanation instead of a file. `HEAD`
// answers `405`, so only a `GET` ever starts an export.
import { redirect } from "next/navigation";

import {
  auditExportQuery,
  auditHref,
  exportDisposition,
  exportProblem,
  parseAuditFilters,
  searchParamsRecord,
} from "@/app/(app)/audit/audit-filters";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { AUDIT_STRINGS } from "@/lib/strings";

export const dynamic = "force-dynamic";

/** The content type of the file, as the API sends it. */
const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/** A plain-text answer without a file: the admin's words, never the API's, and nothing cached. */
function plainText(status: number, message: string, retryAfterSeconds?: number): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...(retryAfterSeconds === undefined ? {} : { "Retry-After": String(retryAfterSeconds) }),
    },
  });
}

/** The answer of a refused export. */
function refused(error: ApiError): Response {
  if (error.code === "VALIDATION_FAILED") {
    return plainText(400, AUDIT_STRINGS.exportInvalid);
  }
  // Only an HTTP error status: 503 for an unreachable API, the API's own for the rest.
  const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
  return plainText(status, AUDIT_STRINGS.exportFailed(errorMessage(error)), error.retryAfterSeconds);
}

/**
 * `HEAD` answers `405`: without its own handler Next.js runs `GET` for it, which would start an export (and write its
 * `audit.exported` row) for an answer that carries no file.
 */
export function HEAD(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const parsed = parseAuditFilters(searchParamsRecord(query));
  if (!parsed.ok || exportProblem(parsed.filters) !== undefined) {
    return plainText(400, AUDIT_STRINGS.exportInvalid);
  }
  const { filters } = parsed;
  const from = filters.from;
  const to = filters.to;
  if (from === undefined || to === undefined) {
    return plainText(400, AUDIT_STRINGS.exportInvalid);
  }

  const api = await platformApi();
  const result = await api.GET("/v1/admin/audit-log.csv", {
    params: { query: auditExportQuery({ ...filters, from, to }) },
    // The body as a stream, never read here (openapi-fetch skips its own parsing).
    parseAs: "stream",
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: auditHref(filters) }).toString()}`);
    }
    return refused(result.error);
  }
  if (result.data === null || result.data === undefined) {
    return refused({ code: "INTERNAL_ERROR", status: 502, fieldErrors: [], details: {} });
  }
  return new Response(result.data, {
    status: 200,
    headers: {
      "Content-Type": CSV_CONTENT_TYPE,
      "Content-Disposition": exportDisposition({ from, to }),
      "Cache-Control": "no-store",
    },
  });
}
