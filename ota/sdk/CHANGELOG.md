# Changelog of `@velexis/ota-sdk`

Every change that a consumer of the SDK can notice is recorded here by hand, newest first ([OADR-0016](../docs/adr/0016-sdk-packaging-and-type-contract.md) point 8). The SDK follows [semantic versioning](https://semver.org/): a change that the contract test would reject is a major version, new methods and options are minor, fixes are patches. Versions `0.x` live only in the workspace (`workspace:*` in the storefront and the OTA admin); `1.0.0` is the first npm release (M6). `VERSION` in `src/version.js` always equals `version` in `package.json` (a unit test fails otherwise), so a release changes both and adds its section here.

A method that will be removed is marked `@deprecated` in its JSDoc for at least one minor release first, and the deprecation is listed here.

## 0.1.0 (unreleased, workspace only)

### Added

- The package scaffold (SDK-001): an ES module package with `"sideEffects": false` and no runtime dependencies; `VERSION`, the only export so far; the base type aliases `Schemas`, `Paths` and `Operations` from `@velexis/api-types` (JSDoc types only); `tsc --checkJs` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and no Node globals; declaration-only emit to `dist/types/`; Vitest with a fake `fetch` for the unit tests.
