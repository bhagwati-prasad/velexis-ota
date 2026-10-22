// Storefront, customer identity, account and reference data (mirrors docs/velexis-sdk/sdk/src/identity.d.ts,
// ADR-0019, OADR-0016 point 1): the typedefs of identity.d.ts with the same names, in the same order, and the
// factories of its namespaces. The namespace types are inferred from the factories in ./namespaces/, so each method
// is documented once, there. SDK-005 brings `storefront` and `reference`; SDK-008 `auth` and `account` with their
// typedefs (`AuthGetSessionParams` … `SavedTravelerUpdateParams`, `AuthApi`, `AccountApi` and its sub-namespaces), in
// their places of the contract's order. `auth.signIn`, `auth.refresh` and `auth.changePassword` resolve with
// `AuthSessionResult | AuthSessionInfo`, the approved cookie-mode deviation of OADR-0006.
//
// identity.d.ts also declares `EndUserContext` and `EndUserSource` and augments `RequestOptions` (`endUser`, `host`)
// and `VelexisClientOptions` (`hostingKey`, `host`, `endUser`). They live in shared.js, whose option typedefs need
// them and which JavaScript cannot augment; declaring the two types here again would make `export *` of both modules
// in index.js ambiguous (TS2308). Schema types come only from `@velexis/api-types` through ./types.js.

export { createStorefrontApi } from "./namespaces/storefront.js";
export { createAuthApi } from "./namespaces/auth.js";
export { createAccountApi } from "./namespaces/account.js";
export { createReferenceApi } from "./namespaces/reference.js";

/* ------------------------------------------------------------------------------------------------
 * Parameter types
 * ---------------------------------------------------------------------------------------------- */

/**
 * Params of `StorefrontApi.get`.
 * @typedef {object} StorefrontGetParams
 * @property {string} [locale] locale of the localised texts (SEO, consent categories); a shortcut for
 *   `options.locale` (`Accept-Language`)
 */

/**
 * Params of `StorefrontApi.resolve`.
 * @typedef {object} StorefrontResolveParams
 * @property {string} host the host of the visitor's request (the `Host` header); upper case, a port and a trailing
 *   dot are tolerated
 */

/** Params of `AuthApi.getSession` (none). @typedef {Record<string, never>} AuthGetSessionParams */

/** Params of `AccountApi.get` (none). @typedef {Record<string, never>} AccountGetParams */

/** Params of `AccountPreferencesApi.get` (none). @typedef {Record<string, never>} AccountPreferencesGetParams */

/**
 * Optimistic-concurrency precondition sent as `If-Match`.
 * @typedef {object} AccountIfMatch
 * @property {string | number} ifMatch the resource's `version` of the last read (a number, sent as `"<version>"`) or
 *   the raw `ETag` string of that read
 */

/** Params of `AccountApi.update`: the fields to change plus `ifMatch`. @typedef {import("./types.js").Schemas["CustomerUpdateRequest"] & AccountIfMatch} AccountUpdateParams */

/** Params of `AccountPreferencesApi.update`: the preferences to change plus `ifMatch`. @typedef {import("./types.js").Schemas["CustomerPreferencesUpdateRequest"] & AccountIfMatch} AccountPreferencesUpdateParams */

/**
 * Params of `AccountDataExportsApi.get`.
 * @typedef {object} AccountDataExportGetParams
 * @property {string} dataExportId the data export id (`dex_…`)
 */

/** Params of `AccountSavedTravelersApi.list`. @typedef {import("./shared.js").ListParams} SavedTravelerListParams */

/**
 * Params of `AccountSavedTravelersApi.get` and `AccountSavedTravelersApi.delete`.
 * @typedef {object} SavedTravelerRefParams
 * @property {string} savedTravelerId the saved traveller id (`trv_…`)
 */

/**
 * Params of `AccountSavedTravelersApi.update`: the id, `ifMatch` and the fields to change (lists replace the stored
 * lists).
 * @typedef {import("./types.js").Schemas["SavedTravelerUpdateRequest"] & SavedTravelerRefParams & AccountIfMatch} SavedTravelerUpdateParams
 */

/** Location sub-types accepted by `ReferenceLocationsApi.search`. @typedef {"AIRPORT" | "CITY"} LocationSubType */

/**
 * Params of `ReferenceLocationsApi.search`.
 * @typedef {object} LocationSearchParams
 * @property {string} keyword the text typed by the user (2–50 characters): IATA code, airport or city name
 * @property {LocationSubType[]} [subType] airports and/or cities; default both; sent as `subType=AIRPORT,CITY`
 * @property {string} [countryCode] one country only (ISO 3166-1 alpha-2)
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size
 */

/**
 * Params of `ReferenceAirportsApi.get`.
 * @typedef {object} AirportGetParams
 * @property {string} iataCode the 3-letter IATA airport code, for example `"LHR"`
 */

/**
 * Params of `ReferenceAirlinesApi.list`.
 * @typedef {object} AirlineListParams
 * @property {string[]} [iataCodes] IATA designators to resolve (at most 100), for example `["BA", "U2"]`; omit to page
 *   through all active airlines
 * @property {string} [cursor] the `page.nextCursor` of the previous page
 * @property {number} [limit] the page size
 */

/**
 * Params of `ReferenceAirlinesApi.get`.
 * @typedef {object} AirlineGetParams
 * @property {string} iataCode the 2-character IATA airline designator, for example `"BA"`
 */

/** Params of `ReferenceCountriesApi.list`. @typedef {import("./shared.js").ListParams} CountryListParams */

/** Params of `ReferenceCurrenciesApi.list`. @typedef {import("./shared.js").ListParams} CurrencyListParams */

/* ------------------------------------------------------------------------------------------------
 * Namespaces (inferred from the factories)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `client.storefront`: the public bootstrap configuration of the OTA's storefront, and host → OTA resolution.
 * @typedef {ReturnType<typeof import("./namespaces/storefront.js").createStorefrontApi>} StorefrontApi
 */

/**
 * `client.auth`: customer sign-up, e-mail verification, sessions and passwords. `signIn`, `refresh` and
 * `changePassword` resolve with `AuthSessionResult` in token and server mode (and the client adopts the session) and
 * with `AuthSessionInfo`, without tokens, in cookie mode (OADR-0006).
 * @typedef {ReturnType<typeof import("./namespaces/auth.js").createAuthApi>} AuthApi
 */

/**
 * `client.account`: the signed-in customer's own data. Every method needs a customer access token (cookie mode: the
 * session cookie) and acts on that customer; responses are personal and never cached.
 * @typedef {ReturnType<typeof import("./namespaces/account.js").createAccountApi>} AccountApi
 */

/** `client.account.preferences` @typedef {AccountApi["preferences"]} AccountPreferencesApi */
/** `client.account.savedTravelers` @typedef {AccountApi["savedTravelers"]} AccountSavedTravelersApi */
/** `client.account.dataExports` @typedef {AccountApi["dataExports"]} AccountDataExportsApi */

/**
 * `client.reference`: read-only reference data (airports, cities, airlines, countries, currencies). Public: works with
 * a publishable key and needs no user token.
 * @typedef {ReturnType<typeof import("./namespaces/reference.js").createReferenceApi>} ReferenceApi
 */

/** `client.reference.locations` @typedef {ReferenceApi["locations"]} ReferenceLocationsApi */
/** `client.reference.airports` @typedef {ReferenceApi["airports"]} ReferenceAirportsApi */
/** `client.reference.airlines` @typedef {ReferenceApi["airlines"]} ReferenceAirlinesApi */
/** `client.reference.countries` @typedef {ReferenceApi["countries"]} ReferenceCountriesApi */
/** `client.reference.currencies` @typedef {ReferenceApi["currencies"]} ReferenceCurrenciesApi */
