// dist/cli.js: one-off operator commands of the platform backend (README §5), run on the VM with
// `sudo velexis-run platform node dist/cli.js <command>` and locally with `node dist/cli.js <command>`. This file is
// the command dispatcher; each command is one entry of CLI_COMMANDS. PBE-028 adds `admin:grant` and
// `admin:reset-mfa` (admin/admin-cli.commands.ts, loaded only when one of them runs), PBE-034 adds `dev:seed`
// (dev/dev-seed.command.ts, loaded the same way; development only). A command that needs the database or Redis loads
// the configuration itself (`loadConfig`), so `help` works without any.
//
// Exit codes: 0 done, 1 the command failed, 2 usage error (no or unknown command, or wrong arguments).
import type { EnvSource } from "@velexis/config";
import { createLogger } from "@velexis/logger";
import type * as AdminCliCommands from "./admin/admin-cli.commands";
import { PLATFORM_PROCESSES } from "./config";
import type * as DevSeedCommand from "./dev/dev-seed.command";

/** Where the CLI writes (the process's stdout and stderr; tests pass buffers). */
export interface CliOutput {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

/** How `runCli` runs: where it writes, and where the commands read their configuration. */
export interface CliOptions extends CliOutput {
  /**
   * The configuration variables of the commands that need one, instead of the process environment and the
   * `.env.local` files (tests).
   */
  readonly env?: EnvSource;
}

/** What a command gets besides its arguments. */
export interface CliContext extends CliOptions {
  /** Every command of this run, for `help`. */
  readonly commands: readonly CliCommand[];
}

export interface CliCommand {
  /** The command word, for example `help` or `admin:grant`. */
  readonly name: string;
  /** The arguments after the name, for the usage text, for example `<email>`. */
  readonly args: string;
  /** One line for the usage text. */
  readonly summary: string;
  /** Runs the command with the arguments after its name; resolves to the exit code. */
  run(args: readonly string[], context: CliContext): Promise<number> | number;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** The usage text: every command with its arguments and summary. */
export function usage(commands: readonly CliCommand[]): string {
  const synopses = commands.map((command) => `${command.name} ${command.args}`.trim());
  const width = Math.max(0, ...synopses.map((synopsis) => synopsis.length));
  const lines = commands.map(
    (command, index) => `  ${(synopses[index] ?? "").padEnd(width)}  ${command.summary}`,
  );
  return ["Usage: node dist/cli.js <command> [arguments]", "", "Commands:", ...lines, ""].join("\n");
}

const helpCommand: CliCommand = {
  name: "help",
  args: "",
  summary: "Show this list of commands.",
  run(_args, context) {
    context.stdout.write(usage(context.commands));
    return EXIT_OK;
  },
};

/** The admin bootstrap commands, loaded when one runs: `help` needs neither Nest nor the configuration. */
function adminCommands(): Promise<typeof AdminCliCommands> {
  return import("./admin/admin-cli.commands.js");
}

/** `admin:grant <email>`: the first platform admin (PADR-0006 item 6; admin/admin-cli.commands.ts). */
const adminGrantCommand: CliCommand = {
  name: "admin:grant",
  args: "<email> [--operator <name>]",
  summary: "Make the verified account with MFA of <email> a platform admin (audited as system).",
  async run(args, context) {
    return (await adminCommands()).runAdminGrant(args, context);
  },
};

/** `admin:reset-mfa <email>`: the emergency MFA reset of a platform admin (admin/admin-cli.commands.ts). */
const adminResetMfaCommand: CliCommand = {
  name: "admin:reset-mfa",
  args: "<email> [--operator <name>]",
  summary: "Turn MFA off for the platform admin <email> and revoke its sessions (audited as system).",
  async run(args, context) {
    return (await adminCommands()).runAdminResetMfa(args, context);
  },
};

/** The development seed, loaded when it runs (PBE-034; dev/dev-seed.command.ts). */
function devSeedCommands(): Promise<typeof DevSeedCommand> {
  return import("./dev/dev-seed.command.js");
}

/**
 * `dev:seed`: development data, refused when APP_ENV=production (README §5 and §6; dev/dev-seed.command.ts): the
 * platform admin admin@example.com with MFA, the Velexis test Amadeus account at the stub and 20 test offices.
 */
const devSeedCommand: CliCommand = {
  name: "dev:seed",
  args: "",
  summary:
    "Development only: a platform admin with MFA, the test Amadeus account at the stub, 20 test offices.",
  async run(args, context) {
    return (await devSeedCommands()).runDevSeed(args, context);
  },
};

/** Every command of the CLI. Later tasks append theirs. */
export const CLI_COMMANDS: readonly CliCommand[] = [
  helpCommand,
  adminGrantCommand,
  adminResetMfaCommand,
  devSeedCommand,
];

/** `-h` and `--help` are spellings of `help`. */
const HELP_ALIASES: ReadonlySet<string> = new Set(["-h", "--help"]);

/** What a command word looks like. Anything else is not echoed back: it may be a secret typed in the wrong place. */
const COMMAND_WORD = /^[a-z][a-z0-9:-]{0,39}$/;

/**
 * Runs the command named by `argv[0]` with the remaining arguments and resolves to its exit code. Without a command,
 * or with an unknown one, it writes the problem and the usage text to stderr and resolves to EXIT_USAGE.
 */
export async function runCli(
  argv: readonly string[],
  output: CliOptions = { stdout: process.stdout, stderr: process.stderr },
  commands: readonly CliCommand[] = CLI_COMMANDS,
): Promise<number> {
  const [word, ...args] = argv;
  if (word === undefined) {
    output.stderr.write(`No command given.\n\n${usage(commands)}`);
    return EXIT_USAGE;
  }
  const name = HELP_ALIASES.has(word) ? "help" : word;
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) {
    const shown = COMMAND_WORD.test(word) ? ` "${word}"` : "";
    output.stderr.write(`Unknown command${shown}.\n\n${usage(commands)}`);
    return EXIT_USAGE;
  }
  return command.run(args, {
    stdout: output.stdout,
    stderr: output.stderr,
    ...(output.env === undefined ? {} : { env: output.env }),
    commands,
  });
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // `err` keeps type, message, stack and code only (@velexis/logger), never the command's arguments.
      createLogger({ app: PLATFORM_PROCESSES.cli, env: "unknown" }).fatal(
        { err: error },
        "cli.command_failed",
      );
      process.exitCode = EXIT_FAILED;
    },
  );
}
