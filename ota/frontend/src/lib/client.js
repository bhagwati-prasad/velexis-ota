// The storefront's single SDK client (ota/frontend/README.md §1, §2, conventions §4). Every booking function goes
// through it; pages never call `fetch` for the API (ESLint `no-restricted-syntax`).
//
// Cookie mode (ota/sdk/README.md §4.1, OADR-0006): same-origin calls to `/api` (Caddy strips the prefix and adds the
// edge credential), the session in httpOnly cookies, `X-CSRF-Token` on writes. No key or token is ever in JavaScript:
// the SDK refuses them in this mode. A per-visitor currency is a derived client, `client.withOptions({ currency })`.
//
// Its transport (`storefrontFetch`, the SDK's `fetch` option) is the browser's `fetch`, looked up per request as the
// SDK does, with one look at every `403`: an answer `TENANT_SUSPENDED`, of any call, drops the cached storefront.get
// copy (lib/config-cache.js; OADR-0015 point 7 as revised on 2026-10-29, FIX-W33-OTA), so the next page of an open tab
// asks storefront.get again and shows the unavailable state. The SDK still reads the answer itself (a clone is read
// here) and raises the error the page renders.

import { createVelexisClient } from "@velexis/ota-sdk";

import { clearCachedConfig } from "./config-cache.js";

/** The options of the storefront client: same-origin `/api`, cookie session. */
export const CLIENT_OPTIONS = Object.freeze({ baseUrl: "/api", session: /** @type {const} */ ("cookie") });

/** The status and code of the API's answer for a suspended or not-yet-provisioned OTA. */
const SUSPENDED_STATUS = 403;
const SUSPENDED_CODE = "TENANT_SUSPENDED";

/**
 * Drops the cached configuration when `response` is the API's `403 TENANT_SUSPENDED`; reads a clone of the body, and
 * ignores a body it cannot read.
 * @param {Response} response
 */
async function forgetConfigWhenSuspended(response) {
  if (response.status !== SUSPENDED_STATUS) {
    return;
  }
  try {
    const body = await response.clone().json();
    if (body?.error?.code === SUSPENDED_CODE) {
      clearCachedConfig();
    }
  } catch {
    // Not the API's JSON error: nothing to forget.
  }
}

/**
 * The storefront client's `fetch`: the browser's, and the cached configuration dropped on `403 TENANT_SUSPENDED` (see
 * the file header).
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function storefrontFetch(input, init) {
  const response = await globalThis.fetch(input, init);
  await forgetConfigWhenSuspended(response);
  return response;
}

/** The storefront's SDK client. Creating it performs no request. */
export const client = createVelexisClient({ ...CLIENT_OPTIONS, fetch: storefrontFetch });
