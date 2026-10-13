// @velexis/api-types/jobs: the contracts of the cross-backend queue messages (ADR-0009 item 3, PADR-0001 item 9).
// X-008 provides the envelope and its JSON Schema. The platform plan adds the queue names, the `tenant.*`
// messages, the `vx:invalidate` events and the Ajv validator here (PBE-004); see packages/api-types/README.md.
export {
  JOB_CONTRACT_VERSION,
  JOB_SCHEMA_DIALECT,
  JOB_ENVELOPE_SCHEMA,
  EMPTY_JOB_PAYLOAD_SCHEMA,
  jobMessageSchema,
  type JobName,
  type JobPayload,
  type EmptyJobPayload,
  type JobEnvelope,
  type JsonSchema,
  type JobMessageSchemaOptions,
} from "./envelope.js";
