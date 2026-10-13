// Readiness: the platform admin can serve pages because the platform API answers (ADR-0016). deploy.sh polls
// this path after every restart, so an invalid configuration (getConfig throws) also keeps a release from
// going live.
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/** How long the platform API has to answer `GET /health/live` before the admin reports itself not ready. */
const PLATFORM_API_TIMEOUT_MS = 2000;

type CheckStatus = "ok" | "down";

async function checkPlatformApi(baseUrl: string): Promise<CheckStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLATFORM_API_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health/live`, {
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel();
    return response.ok ? "ok" : "down";
  } catch {
    // Refused, reset, timed out (aborted) or not HTTP: the API is not usable. The cause is not exposed.
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(): Promise<Response> {
  const platformApi = await checkPlatformApi(getConfig().PLATFORM_API_URL);
  const ready = platformApi === "ok";
  return Response.json(
    { status: ready ? "ok" : "unavailable", checks: { platformApi } },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
