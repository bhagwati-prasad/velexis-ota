// @velexis/api-types/operations: the operations index of the OTA and platform OpenAPI documents (X-008).
// scripts/generate.mjs writes the entries and their type, `ApiOperation`, into ./generated/operations.ts.
// Route-parity tests compare it with the bound routes, SDK-parity tests with the SDK methods (ADR-0006).
export {
  otaOperations,
  platformOperations,
  type ApiOperation,
  type HttpMethod,
  type OtaOperationId,
  type PlatformOperationId,
} from "./generated/operations.js";
