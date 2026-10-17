// @velexis/ota-sdk public entry (mirrors docs/velexis-sdk/sdk/src/index.d.ts, ADR-0019): `createVelexisClient`,
// `VERSION`, and everything of shared.js (the error classes, `isVelexisError`, `Page` and the shared typedefs). The
// namespaces join the client from SDK-005 on; until then it offers `withOptions` and `request`.
import { createCore } from "./internal/client.js";

export * from "./shared.js";
export { VERSION } from "./version.js";

/** @typedef {import("./shared.js").VelexisClientOptions} VelexisClientOptions */
/** @typedef {import("./shared.js").RequestOptions} RequestOptions */

/** HTTP methods accepted by `VelexisClient.request`. @typedef {"GET" | "POST" | "PUT" | "PATCH" | "DELETE"} HttpMethod */

/**
 * A configured Velexis client. All methods share the client's keys, tokens and defaults.
 * @typedef {object} VelexisClient
 * @property {(overrides: Partial<VelexisClientOptions>) => VelexisClient} withOptions a new client with some options
 *   replaced (for example a per-request access token on the server); it shares nothing mutable with this one
 * @property {<T = unknown>(method: HttpMethod, path: string, init?: { query?: Record<string, string | number | boolean | string[] | undefined>, body?: unknown, options?: RequestOptions }) => Promise<T>} request
 *   low-level escape hatch for endpoints that are not wrapped yet; applies keys, tokens, retries and error mapping
 */

/**
 * Creates a client. Pass `publishableKey` in browser code and `secretKey` only on the server.
 * @param {VelexisClientOptions} options
 * @returns {VelexisClient}
 * @throws {TypeError} when an option is unknown or invalid, before any request
 */
export function createVelexisClient(options) {
  const core = createCore(options);
  return {
    withOptions: (overrides) => createVelexisClient(core.derive(overrides)),
    request: (method, path, init) => core.request(method, path, init),
  };
}
