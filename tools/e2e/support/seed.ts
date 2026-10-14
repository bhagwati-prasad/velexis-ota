// Test data that journeys cannot create through the UI or the public API (PADR-0017 item 5; PFE-014).
//
// Arrange data through the platform API where an operation exists (support/fixtures.ts does that for accounts and
// sessions). This file is for the rest, against the stack's own database (`velexis_e2e_<runId>`, support/stack.ts):
//   - `runPlatformCli` runs `platform/backend/dist/cli.js` with the stack's environment: `admin:grant <email>`
//     (PBE-028) makes an account a platform admin, which no screen can do;
//   - `withDatabase(role, fn)` hands a connected `pg` client to `fn`, as one of the roles of @velexis/testing
//     (`platform`, `ota`, `migrator`, `provisioner`), for rows that only Stripe or an operator would create (a draft
//     settlement, a payout account under review). Platform rows are written as `platform`, the API's own role.
//     Tenant schemas belong to the OTA plan's helpers: through `tenantTx` of @velexis/db, never with
//     schema-qualified SQL (ADR-0004);
//   - builders (`defineBuilder` of @velexis/testing) give each journey unique, valid input.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineBuilder, type TestRole } from "@velexis/testing";
import pg from "pg";
import { uniqueEmail } from "./mailpit";
import {
  childEnv,
  REPO_ROOT,
  runningStackContext,
  serviceEnv,
  stackDatabaseUrl,
  type StackContext,
} from "./stack";

const run = promisify(execFile);

let context: StackContext | undefined;

/** The stack of this run (the global setup passes its database name to the workers). */
export function stack(): StackContext {
  context ??= runningStackContext();
  return context;
}

/** The name of the stack's database. */
export function stackDatabaseName(): string {
  return stack().databaseName;
}

/**
 * Runs `fn` with a client connected to the stack's database as `role`, and closes the client afterwards. The DSN
 * carries a development password: it is never logged.
 */
export async function withDatabase<T>(role: TestRole, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: stackDatabaseUrl(stack(), role),
    application_name: "velexis-e2e-seed",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The output of a platform CLI command. */
export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `node platform/backend/dist/cli.js <args>` with the environment of the stack's platform API, and resolves to
 * its output. Rejects with the exit code and stderr when the command fails.
 */
export async function runPlatformCli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [join(REPO_ROOT, "platform/backend/dist/cli.js"), ...args],
      {
        cwd: join(REPO_ROOT, "platform/backend"),
        env: childEnv(serviceEnv("platform-cli", stack())),
        timeout: 60_000,
      },
    );
    return { stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    throw new Error(
      `platform CLI \`${args[0] ?? ""}\` failed (exit code ${String(failure.code)}): ${String(failure.stderr ?? "")}`,
    );
  }
}

/** Makes the verified account with MFA of `email` a platform admin: `admin:grant` of the platform CLI (PBE-028). */
export async function grantPlatformAdmin(email: string): Promise<void> {
  await runPlatformCli(["admin:grant", email]);
}

/** What a person types to sign up: unique for every build. */
export interface AccountInput {
  /** `<label>+<uuid>@example.com`, its own Mailpit inbox. */
  readonly email: string;
  /** 10+ characters, random, so never on a breached-password list. */
  readonly password: string;
  readonly fullName: string;
}

/** A random password the platform's rules accept: 24 characters of letters, digits, `-` and `_`, plus `!`. */
export function newPassword(): string {
  return `E2e-${randomBytes(15).toString("base64url")}!`;
}

/** Sign-up input with a unique e-mail address and a random password: `buildAccount({ fullName: "Owner" })`. */
export const buildAccount = defineBuilder<AccountInput>((n) => ({
  email: uniqueEmail("account"),
  password: newPassword(),
  fullName: `E2E Person ${n}`,
}));
