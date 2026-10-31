// `GET /otas/<tenantId>/payments/settlements/<settlementId>/lines.csv` (README §2 route handlers; flows/
// stripe-payments-account.md §F step 5; PF-63 AC3): the CSV file of a statement's lines, streamed from the platform
// API's `downloadSettlementLines` with the user's session, server-side: the access token stays in its httpOnly cookie
// and never reaches browser JavaScript. Owners and finance members get the file; the API refuses other roles (`403`)
// and answers `404` for a draft, a voided draft or another OTA's statement, so a draft's lines never reach the portal.
//
// The handler first reads the statement (`getSettlement`) for the file's name, `velexis-statement-<yyyy-mm>-
// <currency>.csv` as the API names it, then hands the API's body to the browser as it arrives: it is never buffered,
// parsed or logged here (the lines are the OTA's payment records), and a failure in the middle aborts the answer, so a
// cut file is never taken for a complete one. The answer is an attachment with `Cache-Control: no-store`. The
// middleware has already renewed the session and sent a request without one to sign-in; an ended session here goes
// there too, back to the statement's page. Refusals answer a short plain-text explanation in the portal's words, never
// the API's. `HEAD` answers `405`, so a link checker never makes the two API calls.
import { redirect } from "next/navigation";

import {
  isSettlementId,
  isShownStatus,
  statementFileName,
  statementPath,
} from "@/app/(app)/otas/[tenantId]/payments/settlements/statements";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { SETTLEMENTS_STRINGS } from "@/lib/strings";
import { isTenantId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/** The content type of the file, as the API sends it. */
const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/** A plain-text answer without a file: the portal's words, never the API's, and nothing cached. */
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

/** The answer of a refused call: sign-in for an ended session, else the portal's words for the code. */
function refused(error: ApiError, tenantId: string, settlementId: string): Response {
  const { code } = error;
  if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
    // A sign-in cannot come back to a download; it comes back to the statement's page.
    redirect(`/sign-in?${new URLSearchParams({ next: statementPath(tenantId, settlementId) }).toString()}`);
  }
  if (code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
  if (code === "NOT_FOUND" || code === "VALIDATION_FAILED") {
    return plainText(404, SETTLEMENTS_STRINGS.csvNotFound);
  }
  if (code === "FORBIDDEN") {
    return plainText(403, SETTLEMENTS_STRINGS.csvForbidden);
  }
  // Only an HTTP error status: 503 for an unreachable API, the API's own for the rest.
  const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
  return plainText(status, SETTLEMENTS_STRINGS.csvFailed(errorMessage(error)), error.retryAfterSeconds);
}

/**
 * `HEAD` answers `405`: without its own handler Next.js runs `GET` for it, which would read the statement and open the
 * file's stream for an answer that carries no file.
 */
export function HEAD(): Response {
  return new Response(null, { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ tenantId: string; settlementId: string }> },
): Promise<Response> {
  const { tenantId, settlementId } = await params;
  if (!isTenantId(tenantId) || !isSettlementId(settlementId)) {
    // Ids the API would refuse: answered as it answers a statement the caller cannot see, without a call.
    return plainText(404, SETTLEMENTS_STRINGS.csvNotFound);
  }

  const api = await platformApi();
  const statement = await api.GET("/v1/tenants/{tenantId}/settlements/{settlementId}", {
    params: { path: { tenantId, settlementId } },
  });
  if (statement.error !== undefined) {
    return refused(statement.error, tenantId, settlementId);
  }
  if (!isShownStatus(statement.data.status)) {
    // The API never answers a draft to the portal; a status the portal does not show is not served either.
    return plainText(404, SETTLEMENTS_STRINGS.csvNotFound);
  }

  const lines = await api.GET("/v1/tenants/{tenantId}/settlements/{settlementId}/lines.csv", {
    params: { path: { tenantId, settlementId } },
    // The body as a stream, never read here (openapi-fetch skips its own parsing).
    parseAs: "stream",
  });
  if (lines.error !== undefined) {
    return refused(lines.error, tenantId, settlementId);
  }
  if (lines.data === null || lines.data === undefined) {
    // A success without a body: there is no file to hand on.
    return plainText(502, SETTLEMENTS_STRINGS.csvFailed(errorMessage("INTERNAL_ERROR")));
  }
  return new Response(lines.data, {
    status: 200,
    headers: {
      "Content-Type": CSV_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${statementFileName(statement.data)}"`,
      "Cache-Control": "no-store",
    },
  });
}
