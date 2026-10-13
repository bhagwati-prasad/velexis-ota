import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EnvVar, ParseContext, ParseResult } from "./env";

/** Variables to validate: by default `process.env`. Tests pass a plain object. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** A configuration schema: variable name → `env` builder. */
export type ConfigSchema = Readonly<Record<string, EnvVar<unknown>>>;

/** The frozen, fully typed object that `defineConfig` returns for schema `S`. */
export type ConfigOf<S extends ConfigSchema> = {
  readonly [K in keyof S]: S[K] extends EnvVar<infer T> ? T : never;
};

export interface DefineConfigOptions {
  /**
   * Base directory of relative paths in `env.dir()` and `env.secretFile()` values. Default: the workspace
   * root (the nearest folder above the current directory that holds `pnpm-workspace.yaml`, where the
   * `.local/` paths of `.env.example` live), or the current directory when there is none. On the VM every
   * path is absolute.
   */
  readonly baseDir?: string;
}

/** One rejected variable: its name and the reason, never its value. */
export interface ConfigProblem {
  readonly variable: string;
  readonly reason: string;
}

function formatProblems(problems: readonly ConfigProblem[]): string {
  const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
  return [
    `Invalid configuration (${count}):`,
    ...problems.map(({ variable, reason }) => `  - ${variable} ${reason}`),
  ].join("\n");
}

/**
 * Thrown by `defineConfig` with every problem of the configuration at once. The message lists each
 * variable by name with the reason; it never contains a value, because values may be secrets.
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    super(formatProblems(problems));
    this.problems = Object.freeze(problems.map((problem) => Object.freeze({ ...problem })));
  }
}

/** The nearest folder at or above `startDir` that holds `pnpm-workspace.yaml`, or `undefined`. */
export function findWorkspaceRoot(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * The live process environment. `@velexis/config` reads `process.env` only in this file (ESLint
 * `n/no-process-env` everywhere else); `loadDevEnvFiles` gets it from here. Not exported by the package.
 */
export function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function parseEntry(
  spec: EnvVar<unknown>,
  raw: string | undefined,
  context: ParseContext,
): ParseResult<unknown> {
  try {
    // An empty value counts as unset, so `SENTRY_DSN=` switches an optional feature off.
    if (raw === undefined || raw === "") {
      if (spec.fallback !== undefined) {
        return spec.fallback(context);
      }
      return spec.optional
        ? { ok: true, value: undefined }
        : { ok: false, reason: "is required but missing" };
    }
    return spec.parse(raw, context);
  } catch (error) {
    // Never pass an unexpected error's message on: it could quote the value.
    const kind = error instanceof Error ? error.name : typeof error;
    return { ok: false, reason: `could not be validated (${kind})` };
  }
}

/**
 * Validates every variable of `schema` against `source` (default `process.env`) and returns a deep-frozen,
 * fully typed object. All problems are collected first and thrown as one `ConfigError` that names each
 * variable and the reason, never the value. Variables not in the schema are ignored.
 *
 * This is the only file of the repository that reads `process.env`.
 */
export function defineConfig<S extends ConfigSchema>(
  schema: S,
  source: EnvSource = process.env,
  options: DefineConfigOptions = {},
): ConfigOf<S> {
  let baseDir: string | undefined;
  const context: ParseContext = {
    resolvePath(value) {
      if (isAbsolute(value)) {
        return resolve(value);
      }
      baseDir ??=
        options.baseDir === undefined
          ? (findWorkspaceRoot(process.cwd()) ?? process.cwd())
          : resolve(options.baseDir);
      return resolve(baseDir, value);
    },
  };

  const values: Record<string, unknown> = {};
  const problems: ConfigProblem[] = [];
  for (const [variable, spec] of Object.entries(schema)) {
    const result = parseEntry(spec, source[variable], context);
    if (result.ok) {
      values[variable] = result.value;
    } else {
      problems.push({ variable, reason: result.reason });
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return deepFreeze(values) as ConfigOf<S>;
}
