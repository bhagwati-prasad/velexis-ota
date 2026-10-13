// Readiness: the OTA admin can serve pages because the OTA API answers its liveness probe (ADR-0016).
// deploy/scripts/deploy.sh polls this path on 127.0.0.1:3002 after every restart, so an invalid configuration
// (getConfig throws a ConfigError naming the variables) also keeps a release from going live.
//
// This probe is the one call to the OTA API that does not go through the SDK (OADR-0018 point 1): /health/live
// is an operational endpoint outside the API contract, and the request carries no key, token or cookie.
import { getConfig } from "@/config";

export const dynamic = "force-dynamic";

/** How long the OTA API has to answer `GET /health/live` before the admin reports itself not ready. */
const OTA_API_TIMEOUT_MS = 2000;

/** `timeout`: no answer within the budget; `down`: refused, reset, not HTTP, or an answer other than 2xx. */
type CheckStatus = "ok" | "timeout" | "down";

async function checkOtaApi(baseUrl: string): Promise<CheckStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OTA_API_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health/live`, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    // Only the status matters: release the connection without reading the body.
    void response.body?.cancel().catch(() => undefined);
    return response.ok ? "ok" : "down";
  } catch {
    // The cause is not exposed: the answer says only whether the API is usable.
    return controller.signal.aborted ? "timeout" : "down";
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(): Promise<Response> {
  const otaApi = await checkOtaApi(getConfig().OTA_API_URL);
  const ready = otaApi === "ok";
  return Response.json(
    { status: ready ? "ok" : "unavailable", checks: { otaApi } },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
