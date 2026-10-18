import { beforeAll, describe, expect, it } from "vitest";
import { CLI_COMMANDS, EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli, usage, type CliCommand } from "./cli";

/** stdout and stderr as strings. */
function buffers(): {
  stdout: { text: string; write(text: string): void };
  stderr: { text: string; write(text: string): void };
} {
  const buffer = () => ({
    text: "",
    write(text: string) {
      this.text += text;
    },
  });
  return { stdout: buffer(), stderr: buffer() };
}

describe("runCli", () => {
  it("prints every command for help, -h and --help", async () => {
    for (const word of ["help", "-h", "--help"]) {
      const output = buffers();

      expect(await runCli([word], output)).toBe(EXIT_OK);
      expect(output.stdout.text).toBe(usage(CLI_COMMANDS));
      expect(output.stdout.text).toContain("Usage: node dist/cli.js <command> [arguments]");
      expect(output.stdout.text).toMatch(/^ {2}help {2,}Show this list of commands\.$/m);
      expect(output.stderr.text).toBe("");
    }
  });

  it("answers a usage error without a command", async () => {
    const output = buffers();

    expect(await runCli([], output)).toBe(EXIT_USAGE);
    expect(output.stderr.text).toBe(`No command given.\n\n${usage(CLI_COMMANDS)}`);
    expect(output.stdout.text).toBe("");
  });

  it("answers a usage error for an unknown command, naming it", async () => {
    const output = buffers();

    expect(await runCli(["admin:nope", "someone@example.com"], output)).toBe(EXIT_USAGE);
    expect(output.stderr.text).toMatch(/^Unknown command "admin:nope"\.\n/);
  });

  it("does not echo an unknown first argument that does not look like a command", async () => {
    const output = buffers();

    expect(await runCli(["Secret-Value 1!"], output)).toBe(EXIT_USAGE);
    expect(output.stderr.text).toMatch(/^Unknown command\.\n/);
    expect(output.stderr.text).not.toContain("Secret-Value");
  });

  it("runs a registered command with the remaining arguments and returns its exit code", async () => {
    const seen: string[][] = [];
    const grant: CliCommand = {
      name: "admin:grant",
      args: "<email>",
      summary: "Grant platform admin.",
      run(args, context) {
        seen.push([...args]);
        context.stdout.write("granted\n");
        return Promise.resolve(EXIT_FAILED);
      },
    };
    // The registered admin:grant (PBE-028) is replaced by the stand-in.
    const commands = [...CLI_COMMANDS.filter((command) => command.name !== grant.name), grant];
    const output = buffers();

    expect(await runCli(["admin:grant", "someone@example.com"], output, commands)).toBe(EXIT_FAILED);
    expect(seen).toEqual([["someone@example.com"]]);
    expect(output.stdout.text).toBe("granted\n");
  });

  it("lists the commands of the run in help, aligned", async () => {
    const commands: CliCommand[] = [
      ...CLI_COMMANDS.filter((command) => command.name === "help"),
      { name: "admin:grant", args: "<email>", summary: "Grant platform admin.", run: () => EXIT_OK },
    ];
    const output = buffers();

    await runCli(["help"], output, commands);

    expect(output.stdout.text).toContain("  help                 Show this list of commands.\n");
    expect(output.stdout.text).toContain("  admin:grant <email>  Grant platform admin.\n");
  });
});

describe("the admin commands (PBE-028)", () => {
  const usageErrors: Array<{ name: string; code: number; stdout: string; stderr: string }> = [];

  beforeAll(async () => {
    // The first run loads admin/admin-cli.commands.ts (Nest and the modules of the CLI's application context): a few
    // seconds of compiling under a loaded CI runner, bounded here rather than in a test.
    for (const name of ["admin:grant", "admin:reset-mfa"]) {
      const output = buffers();
      const code = await runCli([name], output);
      usageErrors.push({ name, code, stdout: output.stdout.text, stderr: output.stderr.text });
    }
  }, 60_000);

  it("[PBE-028] registers admin:grant and admin:reset-mfa, which take an e-mail address and an operator", () => {
    expect(CLI_COMMANDS.map((command) => `${command.name} ${command.args}`.trim())).toEqual([
      "help",
      "admin:grant <email> [--operator <name>]",
      "admin:reset-mfa <email> [--operator <name>]",
    ]);
  });

  it("[PBE-028] answers a usage error for missing arguments before any configuration is read", () => {
    for (const run of usageErrors) {
      expect(run.code, run.name).toBe(EXIT_USAGE);
      expect(run.stderr).toContain(`Usage: node dist/cli.js ${run.name} <email> [--operator <name>]`);
      expect(run.stdout).toBe("");
    }
  });
});
