// Liveness: the OTA admin process is up and serving requests (ADR-0016). It reads no configuration and calls
// nothing, so it answers even when a dependency is down.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
