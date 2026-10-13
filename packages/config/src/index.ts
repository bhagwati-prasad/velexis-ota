// @velexis/config: typed, validated configuration from the environment and key files (X-002).
// Each app declares its schema once in src/config.ts (docs/mvp/conventions.md §8).
export {
  ConfigError,
  defineConfig,
  type ConfigOf,
  type ConfigProblem,
  type ConfigSchema,
  type DefineConfigOptions,
  type EnvSource,
} from "./define-config";
export { loadDevEnvFiles, type LoadDevEnvFilesOptions, type LoadDevEnvFilesResult } from "./dev-env-files";
export {
  env,
  type BoolOptions,
  type DirOptions,
  type EnumOptions,
  type EnvVar,
  type IntOptions,
  type ListOptions,
  type ParseContext,
  type ParseResult,
  type PortOptions,
  type Presence,
  type PresenceOptions,
  type SecretFileOptions,
  type StringOptions,
  type UrlOptions,
} from "./env";
export {
  KeyFileError,
  readKeyFile,
  type KeyFileEncoding,
  type KeyFileProblem,
  type ReadKeyFileOptions,
} from "./key-files";
