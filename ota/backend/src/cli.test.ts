import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, runCli } from "./cli";

function buffer(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = [];
  return { write: (chunk) => void chunks.push(chunk), text: () => chunks.join("") };
}

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = buffer();
  const stderr = buffer();
  const code = await runCli(argv, { stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe("runCli", () => {
  it("lists every command on help, with exit code 0", async () => {
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const { code, stdout, stderr } = await run(argv);

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("Usage: node dist/cli.js <command> [arguments]");
      for (const command of CLI_COMMANDS) {
        expect(stdout).toContain(`  ${command}`);
      }
    }
    expect(CLI_COMMANDS).toContain("help");
  });

  it("prints the usage on stderr with exit code 1 without a command", async () => {
    const { code, stdout, stderr } = await run([]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage:");
  });

  it("refuses an unknown command with exit code 1", async () => {
    const { code, stdout, stderr } = await run(["tenants:drop-everything"]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('cli: unknown command "tenants:drop-everything"');
    expect(stderr).toContain("Commands:");
  });
});
