# `@velexis/config`

Typed configuration for every Velexis Node app: each app declares its environment variables once in `src/config.ts`, and `@velexis/config` validates them at start-up, checks key files, and returns a frozen, fully typed object. A bad configuration stops the process with one `ConfigError` that lists **every** problem by variable name and **never prints a value**, because values are often secrets ([conventions §8](../../docs/mvp/conventions.md#8-configuration), [ADR-0010](../../docs/mvp/adr/0010-secrets-envelope-encryption.md)).

This package is the only code in the repository that reads `process.env` (in `src/define-config.ts`). ESLint's `n/no-process-env` rule is active in every other package and app; only tool configuration files (`*.config.*`, `vitest.*`, `next.config.*`, `playwright.config.*`) are exempt, as in the root `eslint.config.mjs`.

## Usage

```ts
// platform/backend/src/config.ts
import { resolve } from "node:path";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";

// Development and test only: <app>/.env.local, then the root .env.local. Does nothing in production.
loadDevEnvFiles({ appDir: resolve(__dirname, "..") }); // the app folder (src/ and dist/ are one level down)

export const config = defineConfig({
  APP_ENV: env.enum(["development", "test", "production"]),
  LOG_LEVEL: env.enum(["debug", "info", "warn", "error"], { default: "info" }),
  PORT: env.port({ default: 3100 }),
  DATABASE_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
  REDIS_URL: env.url({ protocols: ["redis:", "rediss:"] }),
  MASTER_KEY_DIR: env.dir(),
  MASTER_KEY_CURRENT: env.string({ pattern: /^local:v\d+$/ }),
  API_KEY_PEPPER_FILE: env.secretFile({ minBytes: 32 }), // exists, mode 0400 or 0600, >= 32 bytes decoded
  JWT_PRIVATE_KEY_FILE: env.secretFile({ minBytes: 32, encoding: "pem" }),
  AIRLINE_CARD_ENABLED: env.bool({ default: false }), // switches that widen access default to false only
  SENTRY_DSN: env.url({ optional: true }), // string | undefined; empty means off
});
export type AppConfig = typeof config; // fully inferred and deep-frozen
```

```ts
// Reading a key where it is used: the config holds the checked path, never the key itself.
import { readKeyFile } from "@velexis/config";

const pepper = readKeyFile(config.API_KEY_PEPPER_FILE, { minBytes: 32 }); // Buffer of the decoded key
const jwtPem = readKeyFile(config.JWT_PRIVATE_KEY_FILE, { minBytes: 32, encoding: "pem" }); // PEM text
```

NestJS apps pass the object on: `ConfigModule.forRoot({ isGlobal: true, load: [() => config] })`. Unit tests of an app's `config.ts` call `defineConfig(schema, { ...variables })` with a plain object instead of the process environment.

A failing configuration throws, for example:

```text
ConfigError: Invalid configuration (3 problems):
  - APP_ENV must be one of development, test, production
  - DATABASE_URL is required but missing
  - API_KEY_PEPPER_FILE must name a valid key file: the file is accessible by group or others (mode 0644); restrict it to mode 0400 or 0600
```

`error.problems` holds the same list as `{ variable, reason }` objects.

## Builders

Every builder takes either `default` (the value type is `T`) or `optional: true` (the value type is `T | undefined`; an `optional` flag computed at run time gives `T | undefined` too); with neither, the variable is required. An **empty value counts as unset**, so `SENTRY_DSN=` switches an optional feature off. Defaults are only for values that are safe in production; URLs, credentials and switches that widen access have no default except `false` (conventions §8). A default that breaks the builder's own rule (`env.port({ default: 70000 })`) throws a `TypeError` when the schema is declared.

| Builder | Value type | Accepts |
|---|---|---|
| `env.string({ pattern })` | `string` | Any string; with `pattern`, only matching values (anchor the pattern) |
| `env.int({ min, max })` | `number` | Decimal safe integers with an optional sign, inside `[min, max]` |
| `env.port()` | `number` | Integers from 1 to 65535 |
| `env.bool()` | `boolean` | Exactly `true`, `false`, `1` or `0` |
| `env.url({ protocols })` | `string` | Absolute URLs, returned as written; with `protocols` (`"postgres:"` or `"postgres"`), only those |
| `env.enum(values)` | literal union of `values` | One of `values` |
| `env.dir()` | `string` (absolute path) | An existing directory |
| `env.secretFile({ minBytes, encoding })` | `string` (absolute path) | A key file that passes `readKeyFile` (below); never a default |
| `env.list({ separator, pattern })` | `readonly string[]` | A list separated by `,` (or `separator`), trimmed, without empty items, at least one item |

**Relative paths** in `env.dir()` and `env.secretFile()` values resolve against the workspace root (the folder of `pnpm-workspace.yaml`), so the `.local/keys/...` paths of the root [`.env.example`](../../.env.example) work from any app folder. Pass `defineConfig(schema, source, { baseDir })` to choose another base. On the VM every path is absolute (`/etc/velexis/keys/<zone>/...`).

## Key files: `readKeyFile(path, { minBytes, encoding })`

The checks of [ADR-0010](../../docs/mvp/adr/0010-secrets-envelope-encryption.md) (Key material on the VM) for the master key, the API key pepper, the JWT signing keys and the document URL key. `readKeyFile` throws a `KeyFileError` (with `problem`, `path` and a path-free `detail`) when the file:

- is missing or is not a regular file (a FIFO or a directory never blocks start-up);
- grants any access to group or others (`mode & 0o077`): use mode `0400` (VM) or `0600` (`pnpm dev:keys`);
- is empty, is not valid base64 (`encoding: "base64"`, the default), or holds no PEM block (`encoding: "pem"`);
- is shorter than `minBytes` after decoding the base64 value or the PEM body.

It returns the decoded bytes as a `Buffer` for base64 files, and the PEM text for PEM files. The file's content never appears in an error. `env.secretFile` runs the same checks at start-up and keeps only the path.

## Development env files: `loadDevEnvFiles({ appDir, rootDir })`

Development and test only. It reads `<appDir>/.env.local`, then `<rootDir>/.env.local`, with Node's `util.parseEnv`, and sets only variables that are still unset. The precedence is therefore: the real environment, then the app file, then the root file ([`local-development.md`](../../docs/mvp/local-development.md) §2). Missing files are skipped; `rootDir` defaults to the nearest folder above `appDir` that holds `pnpm-workspace.yaml`. It returns `{ files }`, the files it read.

When `APP_ENV` or `NODE_ENV` is `production` it does nothing: it reads no file and logs nothing. On the VM systemd provides the environment from `/etc/velexis/<app>.env`.

## Scripts

| Script | Does |
|---|---|
| `pnpm --filter @velexis/config build` | `tsc -b` to `dist/` (CommonJS and declarations) |
| `pnpm --filter @velexis/config test` | Vitest, including the type tests (`expectTypeOf`, checked by `tsc`) |
| `pnpm --filter @velexis/config typecheck` | `tsc --noEmit` |
| `pnpm --filter @velexis/config lint` | ESLint with the root flat config |
| `pnpm --filter @velexis/config clean` | Removes the build output |
