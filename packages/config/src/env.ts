import { statSync } from "node:fs";
import { KeyFileError, readKeyFile, type KeyFileEncoding } from "./key-files";

/** What `defineConfig` gives every parser. */
export interface ParseContext {
  /**
   * Absolute form of a path-valued variable. Absolute values are only normalised; relative values are
   * resolved against the base directory of `defineConfig` (by default the workspace root).
   */
  resolvePath(value: string): string;
}

/** Outcome of parsing one variable. A `reason` never contains the value. */
export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

declare const OUTPUT: unique symbol;

/**
 * One entry of a configuration schema, made by a builder of `env`. `T` is the type of the value in the
 * object that `defineConfig` returns (it includes `undefined` for an `optional` entry).
 */
export interface EnvVar<T> {
  /** Type-level only: carries `T` for inference. Never set at runtime. */
  readonly [OUTPUT]?: T;
  /** Name of the builder, for diagnostics. */
  readonly kind: string;
  /** `true` when an unset variable becomes `undefined`. */
  readonly optional: boolean;
  /** Parses a set, non-empty raw value. */
  readonly parse: (raw: string, context: ParseContext) => ParseResult<unknown>;
  /** Value used when the variable is unset or empty; absent when the entry has no default. */
  readonly fallback?: (context: ParseContext) => ParseResult<unknown>;
}

/**
 * Presence options shared by every builder. `default` is used when the variable is unset or empty and gives
 * the type `T`; `optional: true` gives `T | undefined`. An entry with neither is required. Defaults are only
 * for values that are safe in production (conventions §8).
 */
export type PresenceOptions<V> =
  { readonly optional?: false; readonly default?: V } | { readonly optional: true; readonly default?: never };

/**
 * The value type of an entry built with options `O`: `V` only when `optional` is absent or literally `false`.
 * A non-literal `boolean` may be `true` at run time, so it gives `V | undefined` as well.
 */
export type Presence<V, O> = "optional" extends keyof O
  ? [O["optional" & keyof O]] extends [false | undefined]
    ? V
    : V | undefined
  : V;

export type StringOptions = PresenceOptions<string> & {
  /** The whole value must match. Anchor it (`/^local:v\d+$/`); the `g` and `y` flags are ignored. */
  readonly pattern?: RegExp;
};
export type IntOptions = PresenceOptions<number> & { readonly min?: number; readonly max?: number };
export type PortOptions = PresenceOptions<number>;
export type BoolOptions = PresenceOptions<boolean>;
export type UrlOptions = PresenceOptions<string> & {
  /** Allowed protocols with or without the colon, for example `["postgres:", "postgresql:"]`. */
  readonly protocols?: readonly string[];
};
export type EnumOptions<V extends string> = PresenceOptions<V>;
export type DirOptions = PresenceOptions<string>;
export type SecretFileOptions = {
  /** Minimum length of the key material in bytes, after decoding. */
  readonly minBytes: number;
  /** Default `"base64"`; `"pem"` for PEM keys such as the Ed25519 JWT keys. */
  readonly encoding?: KeyFileEncoding;
  readonly optional?: boolean;
  /** Secret files never have a default (conventions §8). */
  readonly default?: never;
};
export type ListOptions = PresenceOptions<readonly string[]> & {
  /** Default `","`. Items are trimmed and empty items are dropped. */
  readonly separator?: string;
  /** Every item must match. Anchor it; the `g` and `y` flags are ignored. */
  readonly pattern?: RegExp;
};

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (reason: string): ParseResult<never> => ({ ok: false, reason });

/** A copy without the stateful `g` and `y` flags, so `test` gives the same answer every time. */
function statelessPattern(pattern: RegExp | undefined): RegExp | undefined {
  return pattern === undefined ? undefined : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
}

/**
 * Builds an entry; validates a default with `check` once, when the schema is declared. `R` is the phantom
 * value type and comes from the builder's declared return type.
 */
function entry<V, R>(
  kind: string,
  options: PresenceOptions<V> | undefined,
  parse: (raw: string, context: ParseContext) => ParseResult<V>,
  check?: (value: V) => string | undefined,
): EnvVar<R> {
  const optional = options?.optional === true;
  const defaultValue = options?.default;
  if (defaultValue === undefined) {
    return { kind, optional, parse };
  }
  const problem = check?.(defaultValue);
  if (problem !== undefined) {
    throw new TypeError(`env.${kind}(): the default ${problem}`);
  }
  const frozen = Array.isArray(defaultValue) ? (Object.freeze([...defaultValue]) as V) : defaultValue;
  return { kind, optional, parse, fallback: () => ok(frozen) };
}

function describePattern(pattern: RegExp): string {
  return `/${pattern.source}/${pattern.flags}`;
}

/** A string, optionally matching `pattern`. */
function string<const O extends StringOptions = Record<never, never>>(
  options?: O,
): EnvVar<Presence<string, O>> {
  const pattern = statelessPattern(options?.pattern);
  const check = (value: string) =>
    pattern !== undefined && !pattern.test(value) ? `does not match ${describePattern(pattern)}` : undefined;
  return entry(
    "string",
    options,
    (raw) => {
      const problem = check(raw);
      return problem === undefined ? ok(raw) : fail(problem);
    },
    check,
  );
}

function intRule(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) {
    return `an integer between ${min} and ${max}`;
  }
  if (min !== undefined) {
    return `an integer of at least ${min}`;
  }
  if (max !== undefined) {
    return `an integer of at most ${max}`;
  }
  return "an integer";
}

function integerParser(kind: string, rule: string, min: number | undefined, max: number | undefined) {
  const check = (value: number) =>
    !Number.isSafeInteger(value) || (min !== undefined && value < min) || (max !== undefined && value > max)
      ? `is not ${rule}`
      : undefined;
  const parse = (raw: string): ParseResult<number> => {
    if (!/^[-+]?\d+$/.test(raw)) {
      return fail(`must be ${rule}`);
    }
    const value = Number(raw);
    return check(value) === undefined ? ok(value) : fail(`must be ${rule}`);
  };
  return { kind, check, parse };
}

/** A safe integer in `[min, max]`. Only decimal digits with an optional sign are accepted. */
function int<const O extends IntOptions = Record<never, never>>(options?: O): EnvVar<Presence<number, O>> {
  const min = options?.min;
  const max = options?.max;
  if (min !== undefined && max !== undefined && min > max) {
    throw new TypeError("env.int(): min must not be greater than max");
  }
  const rule = intRule(min, max);
  const parser = integerParser("int", rule, min, max);
  return entry(parser.kind, options, parser.parse, parser.check);
}

/** A TCP port, 1 to 65535. */
function port<const O extends PortOptions = Record<never, never>>(options?: O): EnvVar<Presence<number, O>> {
  const parser = integerParser("port", "a port number between 1 and 65535", 1, 65535);
  return entry(parser.kind, options, parser.parse, parser.check);
}

/** A boolean written as exactly `true`, `false`, `1` or `0`. */
function bool<const O extends BoolOptions = Record<never, never>>(options?: O): EnvVar<Presence<boolean, O>> {
  return entry("bool", options, (raw) => {
    if (raw === "true" || raw === "1") {
      return ok(true);
    }
    if (raw === "false" || raw === "0") {
      return ok(false);
    }
    return fail("must be one of true, false, 1, 0");
  });
}

/** An absolute URL, optionally limited to `protocols`. The value is returned as written. */
function url<const O extends UrlOptions = Record<never, never>>(options?: O): EnvVar<Presence<string, O>> {
  const protocols = options?.protocols?.map((p) => (p.endsWith(":") ? p : `${p}:`).toLowerCase());
  if (protocols?.length === 0) {
    throw new TypeError("env.url(): protocols must not be empty");
  }
  const check = (value: string): string | undefined => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return "must be an absolute URL";
    }
    if (protocols !== undefined && !protocols.includes(parsed.protocol)) {
      return `must use one of the protocols ${protocols.join(", ")}`;
    }
    return undefined;
  };
  return entry(
    "url",
    options,
    (raw) => {
      const problem = check(raw);
      return problem === undefined ? ok(raw) : fail(problem);
    },
    check,
  );
}

/** One of `values`; the type is their literal union. */
function enumOf<
  const V extends readonly [string, ...string[]],
  const O extends EnumOptions<V[number]> = Record<never, never>,
>(values: V, options?: O): EnvVar<Presence<V[number], O>> {
  if (values.length === 0) {
    throw new TypeError("env.enum(): values must not be empty");
  }
  const allowed: readonly string[] = values;
  const isValue = (raw: string): raw is V[number] => allowed.includes(raw);
  const rule = `must be one of ${values.join(", ")}`;
  return entry(
    "enum",
    options,
    (raw: string) => (isValue(raw) ? ok(raw) : fail(rule)),
    (value) => (isValue(value) ? undefined : "is not one of the values"),
  );
}

function checkDir(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? undefined : "must name a directory, not a file";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return code === "ENOENT" || code === "ENOTDIR"
      ? "must name an existing directory"
      : `names a directory that cannot be checked (${code})`;
  }
}

/** An existing directory. The value is its absolute path; relative paths resolve against the base directory. */
function dir<const O extends DirOptions = Record<never, never>>(options?: O): EnvVar<Presence<string, O>> {
  const parse = (raw: string, context: ParseContext): ParseResult<string> => {
    const path = context.resolvePath(raw);
    const problem = checkDir(path);
    return problem === undefined ? ok(path) : fail(problem);
  };
  const optional = options?.optional === true;
  const defaultPath = options?.default;
  // A default directory is checked like a value, when the configuration is loaded.
  return defaultPath === undefined
    ? { kind: "dir", optional, parse }
    : { kind: "dir", optional, parse, fallback: (context) => parse(defaultPath, context) };
}

/**
 * A key file checked with `readKeyFile` (exists, mode 0400 or 0600, at least `minBytes` after decoding).
 * The value is the file's absolute path, not its content: read the key with `readKeyFile` where it is used.
 */
function secretFile<const O extends SecretFileOptions>(options: O): EnvVar<Presence<string, O>> {
  const { minBytes, encoding = "base64" } = options;
  if (!Number.isSafeInteger(minBytes) || minBytes < 1) {
    throw new TypeError("env.secretFile(): minBytes must be a positive integer");
  }
  return {
    kind: "secretFile",
    optional: options.optional === true,
    parse: (raw, context) => {
      const path = context.resolvePath(raw);
      try {
        const key = readKeyFile(path, { minBytes, encoding });
        if (Buffer.isBuffer(key)) {
          key.fill(0);
        }
        return ok(path);
      } catch (error) {
        if (error instanceof KeyFileError) {
          return fail(`must name a valid key file: the file ${error.detail}`);
        }
        throw error;
      }
    },
  };
}

/** A separated list of strings (comma by default), trimmed, without empty items. */
function list<const O extends ListOptions = Record<never, never>>(
  options?: O,
): EnvVar<Presence<readonly string[], O>> {
  const separator = options?.separator ?? ",";
  if (separator.length === 0) {
    throw new TypeError("env.list(): separator must not be empty");
  }
  const pattern = statelessPattern(options?.pattern);
  const check = (items: readonly string[]): string | undefined => {
    if (items.length === 0) {
      return "must contain at least one item";
    }
    if (pattern !== undefined) {
      const index = items.findIndex((item) => !pattern.test(item));
      if (index !== -1) {
        return `has an item (number ${index + 1}) that does not match ${describePattern(pattern)}`;
      }
    }
    return undefined;
  };
  return entry(
    "list",
    options,
    (raw) => {
      const items = raw
        .split(separator)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const problem = check(items);
      return problem === undefined ? ok(Object.freeze(items)) : fail(problem);
    },
    (items) => (items.length === 0 ? undefined : check(items)),
  );
}

/**
 * The schema builders: `string`, `int`, `port`, `bool`, `url`, `enum`, `dir`, `secretFile` and `list`.
 * Each returns an `EnvVar` whose value type `defineConfig` infers.
 */
export const env = {
  string,
  int,
  port,
  bool,
  url,
  enum: enumOf,
  dir,
  secretFile,
  list,
} as const;
