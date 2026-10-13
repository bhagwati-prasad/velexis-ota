// Liveness: the platform admin process is up and serving requests (ADR-0016). No dependency is checked here.
// The static headers of next.config.ts (X-Robots-Tag: noindex and the others) apply to this response too.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
