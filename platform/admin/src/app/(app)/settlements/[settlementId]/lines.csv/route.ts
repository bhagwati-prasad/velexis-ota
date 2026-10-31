// `GET /settlements/[settlementId]/lines.csv` (README §2 route handlers, PF-91): every line of one statement as a CSV
// file, streamed from the platform API's `adminDownloadSettlementLines` with the admin's session, which stays on the
// server (the bearer token is the httpOnly `__Host-vxa_at` cookie, read by `lib/api.ts`; no token reaches browser
// JavaScript). The statement is read first (`adminGetSettlement`): an unknown one answers `404` before any file, and its
// OTA key, month and currency give the file the API's own name, `velexis-settlement-<key>-<yyyy-mm>-<currency>.csv`.
//
// The body is never buffered here: the API's stream is handed to the browser as it arrives, and a failure in the middle
// of it aborts the answer, so a cut file is never taken for a complete one. The answer is an attachment, `Cache-Control:
// no-store` (the file holds an OTA's payment records). The middleware has already refreshed the session and sent a
// request without one to `/sign-in`; an ended session here goes there too, back to the statement. An id that is no
// statement id answers `404` without a call, and API refusals a short plain-text explanation in the admin's words.
// `HEAD` answers `405`, so only a `GET` ever reads the file.
import { redirect } from "next/navigation";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** The content type of the file, as the API sends it. */
const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/** `AdminSettlementId` of the platform document. */
const SETTLEMENT_ID = /^stl_[0-9A-HJKMNP-TV-Z]{26}$/;
/** The parts of the API's file name, each checked against its pattern before it goes into a header. */
const TENANT_KEY = /^[a-z][a-z0-9]{2,29}$/;
const MONTH = /^([0-9]{4})-([0-9]{2})-01T00:00:00(?:\.000)?Z$/;
const CURRENCY = /^[A-Z]{3}$/;

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

/** The answer of a refused call: its HTTP status (503 for an unreachable API) with the admin's message. */
function refused(error: ApiError): Response {
  const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
  return plainText(status, errorMessage(error), error.retryAfterSeconds);
}

/**
 * The `Content-Disposition` of the file, named as the API names it (`velexis-settlement-acme-2027-02-EUR.csv`), or a
 * name made of the statement id when a part does not have its documented shape (it then never reaches the header).
 */
function linesDisposition(statement: {
  readonly id: string;
  readonly tenantKey: string;
  readonly periodStart: string;
  readonly currency: string;
}): string {
  const month = MONTH.exec(statement.periodStart);
  const name =
    month !== null && TENANT_KEY.test(statement.tenantKey) && CURRENCY.test(statement.currency)
      ? `velexis-settlement-${statement.tenantKey}-${month[1]}-${month[2]}-${statement.currency}.csv`
      : `velexis-settlement-${statement.id}.csv`;
  return `attachment; filename="${name}"`;
}

/**
 * `HEAD` answers `405`: without its own handler Next.js runs `GET` for it, which would read the statement's payment
 * records for an answer that carries no file.
 */
export function HEAD(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store" },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ settlementId: string }> },
): Promise<Response> {
  const { settlementId } = await params;
  if (!SETTLEMENT_ID.test(settlementId)) {
    return plainText(404, errorMessage("NOT_FOUND"));
  }
  const signIn = `/sign-in?${new URLSearchParams({ next: `/settlements/${settlementId}` }).toString()}`;

  const api = await platformApi();
  const statement = await api.GET("/v1/admin/settlements/{settlementId}", {
    params: { path: { settlementId } },
  });
  if (statement.error !== undefined) {
    const { code } = statement.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(signIn);
    }
    return refused(statement.error);
  }

  const result = await api.GET("/v1/admin/settlements/{settlementId}/lines.csv", {
    params: { path: { settlementId } },
    // The body as a stream, never read here (openapi-fetch skips its own parsing).
    parseAs: "stream",
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(signIn);
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
      "Content-Disposition": linesDisposition(statement.data),
      "Cache-Control": "no-store",
    },
  });
}
