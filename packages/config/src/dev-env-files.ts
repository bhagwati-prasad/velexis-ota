import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { findWorkspaceRoot, processEnv } from "./define-config";

export interface LoadDevEnvFilesOptions {
  /** The app's folder (the one with its `package.json`); its `.env.local` wins over the root one. */
  readonly appDir: string;
  /** Default: the nearest folder at or above `appDir` that holds `pnpm-workspace.yaml`. */
  readonly rootDir?: string;
  /** The environment to fill. Default: the process environment. Tests pass a plain object. */
  readonly env?: Record<string, string | undefined>;
}

export interface LoadDevEnvFilesResult {
  /** Absolute paths of the files that were read, in the order they were applied. Empty in production. */
  readonly files: readonly string[];
}

function readIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Development and test only: fills the environment from `<appDir>/.env.local`, then from
 * `<rootDir>/.env.local`, parsed with Node's `util.parseEnv`. A variable is set only while it is still unset,
 * so the real environment wins, then the app file, then the root file. Missing files are skipped.
 *
 * When `APP_ENV` or `NODE_ENV` is `production` it does nothing: it reads no file and logs nothing. On the VM
 * systemd provides the environment from `/etc/velexis/<app>.env`.
 *
 * Call it before `defineConfig`.
 */
export function loadDevEnvFiles(options: LoadDevEnvFilesOptions): LoadDevEnvFilesResult {
  const target = options.env ?? processEnv();
  if (target["APP_ENV"] === "production" || target["NODE_ENV"] === "production") {
    return { files: [] };
  }

  const appDir = resolve(options.appDir);
  const rootDir = options.rootDir === undefined ? findWorkspaceRoot(appDir) : resolve(options.rootDir);
  const candidates = [join(appDir, ".env.local")];
  if (rootDir !== undefined && rootDir !== appDir) {
    candidates.push(join(rootDir, ".env.local"));
  }

  const files: string[] = [];
  for (const file of candidates) {
    const content = readIfPresent(file);
    if (content === undefined) {
      continue;
    }
    files.push(file);
    for (const [name, value] of Object.entries(parseEnv(content))) {
      if (value !== undefined && target[name] === undefined) {
        target[name] = value;
      }
    }
  }
  return { files: Object.freeze(files) };
}
