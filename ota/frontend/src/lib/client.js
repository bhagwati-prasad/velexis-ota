// The storefront's single SDK client (ota/frontend/README.md §1, §2, conventions §4). Every booking function goes
// through it; pages never call `fetch` for the API (ESLint `no-restricted-syntax`).
//
// Cookie mode (ota/sdk/README.md §4.1, OADR-0006): same-origin calls to `/api` (Caddy strips the prefix and adds the
// edge credential), the session in httpOnly cookies, `X-CSRF-Token` on writes. No key or token is ever in JavaScript:
// the SDK refuses them in this mode. A per-visitor currency is a derived client, `client.withOptions({ currency })`.

import { createVelexisClient } from "@velexis/ota-sdk";

/** The options of the storefront client: same-origin `/api`, cookie session. */
export const CLIENT_OPTIONS = Object.freeze({ baseUrl: "/api", session: /** @type {const} */ ("cookie") });

/** The storefront's SDK client. Creating it performs no request. */
export const client = createVelexisClient({ ...CLIENT_OPTIONS });
