// Where the storefront keeps its runtime configuration between pages (OADR-0015 point 7): the sessionStorage entry of
// lib/config.js, and the one way to forget it. Its own module, so that lib/client.js can drop the entry when the API
// answers TENANT_SUSPENDED (OADR-0015 point 7 as revised on 2026-10-29, FIX-W33-OTA) without importing lib/config.js,
// which imports the client.
//
// Every access is wrapped in `try/catch`: a browser with storage blocked throws on `window.sessionStorage` itself.

/** The sessionStorage key of the cached configuration. */
export const CONFIG_STORAGE_KEY = "vx.storefront.config";

/** @typedef {Pick<Storage, "getItem" | "setItem" | "removeItem">} ConfigStorage */

/**
 * The page's sessionStorage, or `null` when the browser refuses access to it.
 * @returns {ConfigStorage | null}
 */
export function pageStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Forgets the cached configuration (after a "Retry" on a full-page state, or when the API says the OTA is suspended).
 * @param {ConfigStorage | null} [storage]
 */
export function clearCachedConfig(storage = pageStorage()) {
  try {
    storage?.removeItem(CONFIG_STORAGE_KEY);
  } catch {
    // Storage refused: there is nothing to forget.
  }
}
