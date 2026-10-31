// dist/cli.js: one-off commands of the OTA backend (README §5), run as `node dist/cli.js <command> [args]` (on the VM
// through `velexis-run ota`). This file is the command registry: OBE-007 adds `tenants:report-migrations`
// (provisioning/report-migrations.command.ts, the deploy step after the tenant fan-out) and `dev:seed`
// (dev/dev-seed.command.ts, development only); FIX-W30-OTA adds `tenants:scrub-card-copies`
// (payments/airline-card/scrub-card-copies.command.ts, the one-off scrub of the card copies stored before
// FIX-W29-SECURITY); OBE-025 adds `amadeus:ping` (amadeus/amadeus-ping.command.ts, the support check of one OTA's
// Amadeus connection). A command's module is loaded only when it runs, so `help` needs neither a configuration nor a
// connection. Exit codes: 0 success, 1 error or unknown command.
import type { EnvSource } from "@velexis/config";
import type * as AmadeusPingCommand from "./amadeus/amadeus-ping.command";
import type * as DevSeedCommand from "./dev/dev-seed.command";
import type * as ScrubCardCopiesCommand from "./payments/airline-card/scrub-card-copies.command";
import type * as ReportMigrationsCommand from "./provisioning/report-migrations.command";

/** Where the CLI writes: `process.stdout` and `process.stderr`, or a test's buffers. */
export interface TextSink {
  write(chunk: string): unknown;
}

/** The streams of one run. */
export interface CliStreams {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
}

/** What a command gets besides its arguments: the streams and, in tests, its configuration variables. */
export interface CliContext extends CliStreams {
  /** The configuration variables instead of the process environment and the `.env.local` files (tests). */
  readonly env?: EnvSource | undefined;
}

/** `runCli` options: the default streams are `process.stdout` and `process.stderr`. */
export type CliIo = Partial<CliStreams> & { readonly env?: EnvSource | undefined };

/** One command: a one-line summary for `help`, and its implementation. */
export interface CliCommand {
  readonly summary: string;
  run(args: readonly string[], io: CliContext): Promise<number>;
}

const PROGRAM = "node dist/cli.js";

function usage(): string {
  const width = Math.max(...[...COMMANDS.keys()].map((name) => name.length));
  const lines = [...COMMANDS.entries()].map(
    ([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`,
  );
  return `Usage: ${PROGRAM} <command> [arguments]\n\nCommands:\n${lines.join("\n")}\n`;
}

/** The deploy report command, loaded when it runs (provisioning/report-migrations.command.ts). */
function reportMigrationsCommand(): Promise<typeof ReportMigrationsCommand> {
  return import("./provisioning/report-migrations.command.js");
}

/** The development seed, loaded when it runs (dev/dev-seed.command.ts). */
function devSeedCommand(): Promise<typeof DevSeedCommand> {
  return import("./dev/dev-seed.command.js");
}

/** The scrub of the stored card copies, loaded when it runs (payments/airline-card/scrub-card-copies.command.ts). */
function scrubCardCopiesCommand(): Promise<typeof ScrubCardCopiesCommand> {
  return import("./payments/airline-card/scrub-card-copies.command.js");
}

/** The support check of an OTA's Amadeus connection, loaded when it runs (amadeus/amadeus-ping.command.ts). */
function amadeusPingCommand(): Promise<typeof AmadeusPingCommand> {
  return import("./amadeus/amadeus-ping.command.js");
}

const COMMANDS: ReadonlyMap<string, CliCommand> = new Map<string, CliCommand>([
  [
    "help",
    {
      summary: "List the commands",
      run(_args, io) {
        io.stdout.write(usage());
        return Promise.resolve(0);
      },
    },
  ],
  [
    "tenants:report-migrations",
    {
      summary:
        "--report <file>: publish tenant.migrated / tenant.migration_failed per schema of a deploy fan-out report",
      async run(args, io) {
        return (await reportMigrationsCommand()).runReportMigrations(args, io);
      },
    },
  ],
  [
    "dev:seed",
    {
      summary: "Development only: the demo OTA (tenant_demo) with its host, connections and test API keys",
      async run(args, io) {
        return (await devSeedCommand()).runDevSeed(args, io);
      },
    },
  ],
  [
    "tenants:scrub-card-copies",
    {
      summary:
        "--tenant <key> | --all [--batch-size <n>]: drop the card holder and expiry from card copies stored before 2026-10-24",
      async run(args, io) {
        return (await scrubCardCopiesCommand()).runScrubCardCopies(args, io);
      },
    },
  ],
  [
    "amadeus:ping",
    {
      summary:
        "--tenant <key> --env <test|live>: resolve an OTA's Amadeus connection, get a token and run one cheap read",
      async run(args, io) {
        return (await amadeusPingCommand()).runAmadeusPing(args, io);
      },
    },
  ],
]);

/** The command names, in the order `help` lists them. */
export const CLI_COMMANDS: readonly string[] = [...COMMANDS.keys()];

/**
 * Runs the CLI with `argv` (without `node` and the script) and resolves to the exit code. `--help` and `-h` are
 * `help`; no command or an unknown one prints the usage on stderr and exits 1. A command that throws is reported as
 * one line on stderr (its message only) with exit code 1.
 */
export async function runCli(argv: readonly string[], options: CliIo = {}): Promise<number> {
  const io: CliContext = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    env: options.env,
  };
  const [name, ...args] = argv;
  if (name === undefined) {
    io.stderr.write(usage());
    return 1;
  }
  const command = COMMANDS.get(name === "--help" || name === "-h" ? "help" : name);
  if (command === undefined) {
    io.stderr.write(`cli: unknown command "${name}"\n\n${usage()}`);
    return 1;
  }
  try {
    return await command.run(args, io);
  } catch (error) {
    io.stderr.write(`cli: ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
