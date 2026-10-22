// The `storefront` namespace (docs/velexis-sdk/sdk/src/identity.d.ts `StorefrontApi`, ota/sdk/README.md §5.2,
// OADR-0016 points 1–3): the storefront's public bootstrap configuration and, deferred until after the MVP, host → OTA
// resolution for one deployment serving several OTA domains, and the MVP additions `storefront.listPages` and
// `storefront.getPage` (SDK-012, M4; ota/sdk/docs/extensions.md §3.1): the published content pages of the hosted
// storefront. Each method is one line through the generated route table (internal/operations.js); its JSDoc carries
// the types, and `StorefrontApi` in identity.js is inferred from this factory.
//
// None of these methods calls Amadeus. `storefront.get`, `storefront.listPages` and `storefront.getPage` are cacheable
// (the API sends `Cache-Control: public, max-age=60, stale-while-revalidate=600` to key callers), so the SDK leaves the
// fetch cache mode to the caller. The page methods send `locale` as a query parameter (`Accept-Language`, the call's
// `locale` option, is the API's fallback), and work in every session mode: they are public, like `storefront.get`.

import { op } from "../internal/operations.js";

/** @typedef {import("../internal/client.js").Core} Core */
/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @typedef {import("../types.js").Schemas} Schemas */
/** @typedef {import("../identity.js").StorefrontGetParams} StorefrontGetParams */
/** @typedef {import("../identity.js").StorefrontResolveParams} StorefrontResolveParams */
/** @typedef {import("../shared.js").AuthenticationError} AuthenticationError */
/** @typedef {import("../shared.js").PermissionError} PermissionError */
/** @typedef {import("../shared.js").ValidationError} ValidationError */
/** @typedef {import("../shared.js").NotFoundError} NotFoundError */
/** @typedef {import("../shared.js").RateLimitError} RateLimitError */
/** @typedef {import("../shared.js").ServerError} ServerError */

/**
 * Params of `StorefrontApi.listPages` (an MVP addition, ota/sdk/docs/extensions.md §3.1; identity.js keeps the names
 * of the contract only).
 * @typedef {object} StorefrontListPagesParams
 * @property {string} [locale] locale of the pages (BCP 47, such as `en` or `fr-CA`), sent as a query parameter; without
 *   it the call's `Accept-Language` (the `locale` option), then the storefront's default locale
 */

/**
 * Params of `StorefrontApi.getPage` (an MVP addition, ota/sdk/docs/extensions.md §3.1).
 * @typedef {object} StorefrontGetPageParams
 * @property {string} slug slug of the page, as in its storefront path `/p/<slug>`
 * @property {string} [locale] locale of the page, sent as a query parameter; it falls back as in `listPages`
 */

/**
 * Whether a value is a plain object, the only kind of params and options `core.call` accepts.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * The request options of one `storefront.get` call. `params.locale` is the contract's shortcut for `options.locale`
 * (`Accept-Language`, the locale of the SEO and consent texts); a `locale` in the call's own options wins. Params or
 * options that are not a plain object are passed on unchanged, so `core.call` refuses them with its usual `TypeError`
 * (a copy would accept them and drop what they inherit).
 * @param {StorefrontGetParams | undefined} params
 * @param {RequestOptions | undefined} options
 * @returns {RequestOptions | undefined}
 */
function withLocale(params, options) {
  const locale = isPlainObject(params) ? params["locale"] : undefined;
  if (
    locale === undefined ||
    (options !== undefined && (!isPlainObject(options) || options.locale !== undefined))
  ) {
    return options;
  }
  return { ...options, locale: /** @type {string} */ (locale) };
}

/**
 * The `storefront` namespace of a client.
 * @param {Core} core the client's request core
 */
export function createStorefrontApi(core) {
  return {
    /**
     * Gets the storefront bootstrap configuration: OTA name, branding, verified domains, locales, currencies, markets,
     * enabled features, payment provider public config, legal links, support contact, consent, auth policy and SEO.
     * Contains no secrets. `GET /v1/storefront`; cacheable (send `If-None-Match` in `options.headers` for a `304`).
     * @param {StorefrontGetParams} [params] `locale` is a shortcut for `options.locale` (`Accept-Language`)
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["StorefrontConfig"]>}
     * @throws {AuthenticationError} `INVALID_API_KEY`
     * @throws {PermissionError} `TENANT_SUSPENDED` (render a maintenance page), `ORIGIN_NOT_ALLOWED`, `HOST_NOT_ALLOWED`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    get: (params, options) => core.call(op.storefront_get, params, withLocale(params, options)),

    /**
     * Resolves a storefront host name to its OTA (one deployment serving several OTA domains, with a hosting key or the
     * OTA's secret key; server only). `GET /v1/storefront/resolve?host=`. Deferred: the API answers
     * `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {StorefrontResolveParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["StorefrontHostResolution"]>}
     * @throws {NotFoundError} `NOT_FOUND` (unknown or unverified host, or an OTA the key may not act for)
     * @throws {ValidationError} `VALIDATION_FAILED` (malformed host)
     * @throws {PermissionError} `SCOPE_NOT_ALLOWED` (publishable key), `HOST_NOT_ALLOWED`
     * @throws {AuthenticationError} `INVALID_API_KEY`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR`
     */
    resolve: (params, options) => core.call(op.storefront_resolve, params, options),

    /**
     * Lists the published content pages of one locale for the footer and a page index: `slug`, `title`, `kind`,
     * `showInFooter` and `sortOrder` of each, by `sortOrder`, then `slug`, each slug once (a slug without a published
     * page in the locale falls back to its page of the default locale). `locale` is sent as a query parameter; without
     * it the API takes the call's `Accept-Language` (the `locale` option), then the storefront's default locale. Not
     * paginated. Public, like `get`. `GET /v1/storefront/pages`; cacheable.
     * @param {StorefrontListPagesParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["StorefrontPageList"]>}
     * @throws {ValidationError} `VALIDATION_FAILED`
     * @throws {AuthenticationError} `INVALID_API_KEY`
     * @throws {PermissionError} `TENANT_SUSPENDED`, `ORIGIN_NOT_ALLOWED`, `HOST_NOT_ALLOWED`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    listPages: (params, options) => core.call(op.storefront_listPages, params, options),

    /**
     * Gets one published content page with its body parsed on the server into blocks (`heading`, `paragraph`, `list`,
     * `image`, holding the inline nodes `text`, `strong`, `em` and `link`): render them with `createElement` and
     * `textContent` only, never `innerHTML`, and check every link again (`https:`, `mailto:`, `tel:` or `/p/<slug>`).
     * The locale falls back as in `listPages`; `locale` in the answer says which page was served. An image's `url` is a
     * same-origin `/api/v1/assets/…` path in cookie mode and an absolute URL for key callers.
     * `GET /v1/storefront/pages/{slug}`; cacheable.
     * @param {StorefrontGetPageParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["StorefrontPageContent"]>}
     * @throws {NotFoundError} `NOT_FOUND` (no published page of the slug in the locale or the default locale)
     * @throws {ValidationError} `VALIDATION_FAILED`
     * @throws {AuthenticationError} `INVALID_API_KEY`
     * @throws {PermissionError} `TENANT_SUSPENDED`, `ORIGIN_NOT_ALLOWED`, `HOST_NOT_ALLOWED`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    getPage: (params, options) => core.call(op.storefront_getPage, params, options),
  };
}
