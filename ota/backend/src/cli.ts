// dist/cli.js: one-off commands of the OTA backend (README §5), run as `node dist/cli.js <command> [args]` (on the VM
// through `velexis-run ota`). This file is the command registry: later tasks add `dev:seed`,
// `tenants:report-migrations` and `amadeus:ping` to COMMANDS. Exit codes: 0 success, 1 error or unknown command.

/** Where the CLI writes: `process.stdout` and `process.stderr`, or a test's buffers. */
export interface TextSink {
  write(chunk: string): unknown;
}

/** The streams of one run. */
export interface CliStreams {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
}

/** `runCli` options: the default streams are `process.stdout` and `process.stderr`. */
export type CliIo = Partial<CliStreams>;

/** One command: a one-line summary for `help`, and its implementation. */
export interface CliCommand {
  readonly summary: string;
  run(args: readonly string[], io: CliStreams): Promise<number>;
}

const PROGRAM = "node dist/cli.js";

function usage(): string {
  const width = Math.max(...[...COMMANDS.keys()].map((name) => name.length));
  const lines = [...COMMANDS.entries()].map(
    ([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`,
  );
  return `Usage: ${PROGRAM} <command> [arguments]\n\nCommands:\n${lines.join("\n")}\n`;
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
]);

/** The command names, in the order `help` lists them. */
export const CLI_COMMANDS: readonly string[] = [...COMMANDS.keys()];

/**
 * Runs the CLI with `argv` (without `node` and the script) and resolves to the exit code. `--help` and `-h` are
 * `help`; no command or an unknown one prints the usage on stderr and exits 1. A command that throws is reported as
 * one line on stderr (its message only) with exit code 1.
 */
export async function runCli(argv: readonly string[], options: CliIo = {}): Promise<number> {
  const io: CliStreams = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
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
