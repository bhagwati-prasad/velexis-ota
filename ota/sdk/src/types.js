// Base type aliases of the SDK (ADR-0019, ota/sdk/docs/types-and-builds.md §1). Schema types come only from the
// types generated from the OTA OpenAPI document, the `@velexis/api-types` module that the contract in
// docs/velexis-sdk/sdk/src/ imports too. The import is a JSDoc type only: the SDK has no runtime dependency.
// The public modules build their aliases on these, for example
// `/** @typedef {import("./types.js").Schemas["FlightOffer"]} FlightOffer */`.

/**
 * Every component schema of the OTA booking API, by name (`Schemas["Money"]`).
 * @typedef {import("@velexis/api-types").components["schemas"]} Schemas
 */

/**
 * Every path of the OTA booking API, with its operations by HTTP method (`Paths["/v1/storefront"]["get"]`).
 * @typedef {import("@velexis/api-types").paths} Paths
 */

/**
 * Every operation of the OTA booking API, by `operationId`.
 * @typedef {import("@velexis/api-types").operations} Operations
 */

export {};
