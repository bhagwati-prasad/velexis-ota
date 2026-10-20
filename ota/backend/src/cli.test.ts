import { beforeAll, describe, expect, it } from "vitest";
import { CLI_COMMANDS, runCli } from "./cli";

function buffer(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = [];
  return { write: (chunk) => void chunks.push(chunk), text: () => chunks.join("") };
}

async function run(
  argv: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = buffer();
  const stderr = buffer();
  const code = await runCli(argv, { stdout, stderr, env });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe("runCli", () => {
  // The command modules load on first use with Nest, pg and BullMQ behind them (about 1.5 s here, several times that
  // on a loaded CI runner): loaded once in this hook with its own budget, so the tests measure only the commands.
  beforeAll(async () => {
    await Promise.all([
      import("./dev/dev-seed.command.js"),
      import("./provisioning/report-migrations.command.js"),
    ]);
  }, 60_000);

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

  it("lists the deploy report and the development seed (OBE-007)", async () => {
    const { stdout } = await run(["help"]);

    expect(CLI_COMMANDS).toEqual(expect.arrayContaining(["tenants:report-migrations", "dev:seed"]));
    expect(stdout).toContain("tenants:report-migrations  --report <file>");
  });

  it("refuses dev:seed with APP_ENV=production and exit code 1 before reading anything else [OBE-007 AC3]", async () => {
    // Only APP_ENV is given: a command that went on would fail on the missing DSNs, not with the refusal.
    const { code, stdout, stderr } = await run(["dev:seed"], { APP_ENV: "production" });

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "dev:seed creates development data and refuses APP_ENV=production; nothing was written.\n",
    );
  });
});
