// The storefront's runtime configuration (ota/frontend/README.md §2 point 3, OADR-0015 point 7, OADR-0012 §7):
// `storefront.get` once per page, its answer kept in `sessionStorage` for 5 minutes. sessionStorage is per origin, so
// two OTAs never share an entry, and the backend's own cache has the same lifetime, so settings changes reach
// travellers within about 5 minutes.
//
// Storage is a convenience, never a requirement: every access is wrapped in `try/catch`, because a browser with
// storage blocked throws on `window.sessionStorage` itself, and a full or private-mode storage throws on `setItem`.
// Without storage the page simply asks the API. The entry holds only the public configuration (no secrets, no
// session data). Errors (`TENANT_SUSPENDED`, `HOST_NOT_ALLOWED`, …) are never cached: boot() renders their state.
// Since FIX-W33-OTA (OADR-0015 point 7 as revised on 2026-10-29) any API call that answers `403 TENANT_SUSPENDED`
// drops the cached entry too (lib/client.js), so an open tab that still holds it asks storefront.get again on its next
// page and shows the unavailable state instead of the cached storefront.

import { client as storefrontClient } from "./client.js";
import { CONFIG_STORAGE_KEY, clearCachedConfig, pageStorage } from "./config-cache.js";

export { CONFIG_STORAGE_KEY, clearCachedConfig };

/** How long a cached configuration is used: 5 minutes. */
export const CONFIG_TTL_MS = 5 * 60 * 1000;

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {Awaited<ReturnType<VelexisClient["storefront"]["get"]>>} StorefrontConfig */
/** @typedef {import("./config-cache.js").ConfigStorage} ConfigStorage */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The cached configuration when it is younger than 5 minutes, else `null` (and a stale or unreadable entry removed).
 * @param {ConfigStorage | null} storage
 * @param {number} now
 * @returns {StorefrontConfig | null}
 */
function readCached(storage, now) {
  if (!storage) {
    return null;
  }
  /** @type {string | null} */
  let text = null;
  try {
    text = storage.getItem(CONFIG_STORAGE_KEY);
  } catch {
    // Storage refused: ask the API.
  }
  if (text === null) {
    return null;
  }
  try {
    const entry = JSON.parse(text);
    const age = isRecord(entry) && typeof entry["storedAt"] === "number" ? now - entry["storedAt"] : -1;
    if (age >= 0 && age < CONFIG_TTL_MS && isRecord(entry["config"])) {
      return /** @type {StorefrontConfig} */ (entry["config"]);
    }
  } catch {
    // The entry is not JSON: removed below like a stale one.
  }
  clearCachedConfig(storage);
  return null;
}

/**
 * Keeps the configuration for the next pages; a storage that refuses it changes nothing.
 * @param {ConfigStorage | null} storage
 * @param {StorefrontConfig} config
 * @param {number} now
 */
function writeCached(storage, config, now) {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ storedAt: now, config }));
  } catch {
    // Quota exceeded, private mode or storage blocked: the page works without the cache.
  }
}

/**
 * The storefront configuration: from sessionStorage when cached less than 5 minutes ago, else from `storefront.get`
 * (then cached). Errors of `storefront.get` are thrown as the SDK raised them and never cached.
 * @param {{ client?: Pick<VelexisClient, "storefront">, storage?: ConfigStorage | null, now?: () => number }} [deps]
 *   for tests: the SDK client, the storage (`null` for none) and the clock; default the storefront client, the
 *   page's sessionStorage and `Date.now`
 * @returns {Promise<StorefrontConfig>}
 */
export async function loadConfig({
  client = storefrontClient,
  storage = pageStorage(),
  now = Date.now,
} = {}) {
  const cached = readCached(storage, now());
  if (cached) {
    return cached;
  }
  const config = await client.storefront.get();
  writeCached(storage, config, now());
  return config;
}
