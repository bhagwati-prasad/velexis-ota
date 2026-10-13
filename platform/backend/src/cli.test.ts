import { describe, expect, it } from "vitest";
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
      expect(output.stdout.text).toMatch(/^ {2}help {2}Show this list of commands\.$/m);
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
    const commands = [...CLI_COMMANDS, grant];
    const output = buffers();

    expect(await runCli(["admin:grant", "someone@example.com"], output, commands)).toBe(EXIT_FAILED);
    expect(seen).toEqual([["someone@example.com"]]);
    expect(output.stdout.text).toBe("granted\n");
  });

  it("lists the commands of the run in help, aligned", async () => {
    const commands: CliCommand[] = [
      ...CLI_COMMANDS,
      { name: "admin:grant", args: "<email>", summary: "Grant platform admin.", run: () => EXIT_OK },
    ];
    const output = buffers();

    await runCli(["help"], output, commands);

    expect(output.stdout.text).toContain("  help                 Show this list of commands.\n");
    expect(output.stdout.text).toContain("  admin:grant <email>  Grant platform admin.\n");
  });
});
