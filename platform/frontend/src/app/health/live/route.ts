// Liveness: the portal process is up and serving requests (ADR-0016). No dependency is checked here.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
