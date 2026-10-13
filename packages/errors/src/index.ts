// @velexis/errors: one error model for both APIs (conventions §6, task X-009). The catalogue is generated from
// the `x-error-catalogue` of the OTA and platform OpenAPI documents by scripts/generate.mjs; AppError takes only
// its codes, and toErrorEnvelope writes the envelope of every error answer. Pure TypeScript, no NestJS.
export {
  AppError,
  isAppError,
  isErrorCode,
  isFieldErrorCode,
  httpStatusFor,
  FIELD_ERROR_CODES,
  type AppErrorOptions,
  type FieldErrorCode,
  type FieldError,
  type SupplierIssue,
} from "./app-error.js";
export {
  toErrorEnvelope,
  type ErrorEnvelope,
  type ErrorEnvelopeOptions,
  type ErrorBody,
  type ErrorResponse,
} from "./envelope.js";
export {
  ERROR_CATALOGUE,
  OTA_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  type ErrorCode,
  type OtaErrorCode,
  type PlatformErrorCode,
  type ErrorCatalogueEntry,
  type ErrorSource,
} from "./generated/catalogue.js";
