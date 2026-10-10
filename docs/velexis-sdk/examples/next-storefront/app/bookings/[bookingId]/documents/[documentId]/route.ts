/**
 * Document download: asks Velexis for a 5-minute signed URL with the customer / guest token (server-side) and
 * redirects the browser to it. The URL is never cached or stored.
 */
import { isVelexisError } from "@velexis/ota-sdk";
import { customerClient } from "@/lib/velexis";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ bookingId: string; documentId: string }> }) {
  const { bookingId, documentId } = await context.params;
  try {
    const vx = await customerClient({ bookingId });
    const { url } = await vx.bookings.getDocumentDownloadUrl({ bookingId, documentId });
    return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (e) {
    if (isVelexisError(e, "DOCUMENT_NOT_READY")) {
      const retry = String(e.details?.retryAfterSeconds ?? 10);
      return new Response("The document is being generated — try again in a few seconds.", { status: 409, headers: { "Retry-After": retry } });
    }
    if (isVelexisError(e, "NOT_FOUND") || isVelexisError(e, "UNAUTHENTICATED")) return new Response("Not found", { status: 404 });
    throw e;
  }
}
