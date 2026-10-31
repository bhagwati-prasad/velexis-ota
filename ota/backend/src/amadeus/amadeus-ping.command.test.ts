import { AppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, runCli } from "../cli";
import { AMADEUS_PING_USAGE, describeFailure, pingArgumentsOf } from "./amadeus-ping.command";
import { AmadeusConnectionUnusableError } from "./connection-resolver";
import { AmadeusRateLimitedError } from "./rate-limiter";
import { AmadeusCredentialsRefusedError, AmadeusTokenRequestError } from "./token-provider";

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

describe("amadeus:ping arguments", () => {
  it("takes one tenant key and the environment, in either form and order", () => {
    expect(pingArgumentsOf(["--tenant", "demo", "--env", "test"])).toEqual({
      key: "demo",
      environment: "test",
    });
    expect(pingArgumentsOf(["--env=live", "--tenant=alpha_travel"])).toEqual({
      key: "alpha_travel",
      environment: "live",
    });
  });

  it("refuses anything else", () => {
    for (const args of [
      [],
      ["--tenant", "demo"],
      ["--env", "test"],
      ["--tenant", "demo", "--env", "staging"],
      ["--tenant", "demo", "--env"],
      ["--tenant", "demo", "--tenant", "other", "--env", "test"],
      ["--tenant", "Demo; DROP", "--env", "test"],
      ["--tenant", "demo", "--env", "test", "--verbose"],
      ["--tenant=demo=x", "--env=test"],
      ["--tenant=demo", "--env=test=live"],
      ["--tenant=", "--env=test"],
      ["demo", "test"],
    ]) {
      expect([args, pingArgumentsOf(args)]).toEqual([args, undefined]);
    }
  });

  it("is listed by help, and refuses missing arguments with the usage before reading any configuration", async () => {
    const help = await run(["help"]);
    expect(CLI_COMMANDS).toContain("amadeus:ping");
    expect(help.stdout).toContain("amadeus:ping               --tenant <key> --env <test|live>");

    // No variable is given: a command that went on would fail on the missing configuration, not with the usage.
    const { code, stdout, stderr } = await run(["amadeus:ping", "--tenant", "demo"], {});
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(`amadeus:ping: name one tenant and the environment.\n${AMADEUS_PING_USAGE}\n`);
  });

  it("names the missing variables, never a value, and exits 1 without connecting", async () => {
    const { code, stdout, stderr } = await run(["amadeus:ping", "--tenant", "demo", "--env", "test"], {
      APP_ENV: "test",
      REDIS_URL: "redis://:dummy-redis-password@127.0.0.1:1/0",
    });

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("amadeus:ping: the configuration is invalid:");
    for (const variable of ["DATABASE_URL", "MASTER_KEY_DIR", "MASTER_KEY_CURRENT"]) {
      expect(stderr).toContain(variable);
    }
    expect(stderr).not.toContain("dummy-redis-password");
  });
});

describe("describeFailure", () => {
  it("names the code and why the connection is unusable or the credentials were refused [OBE-025 AC2]", () => {
    expect(
      describeFailure(
        new AppError("SUPPLIER_NOT_CONFIGURED", {
          cause: new AmadeusCredentialsRefusedError("ama_01JA4C8Q0D5N7R2T6V9X3Z1B4F", "test"),
        }),
      ),
    ).toBe("SUPPLIER_NOT_CONFIGURED (credentials_refused)");
    expect(
      describeFailure(
        new AppError("SUPPLIER_NOT_CONFIGURED", {
          cause: new AmadeusConnectionUnusableError(
            "connection_not_active",
            "ten_01JA4C8Q0D5N7R2T6V9X3Z1B4F",
            "test",
          ),
        }),
      ),
    ).toBe("SUPPLIER_NOT_CONFIGURED (connection_not_active)");
  });

  it("names the token request's status, the rate limit and the supplier's code, nothing of a body", () => {
    expect(
      describeFailure(
        new AppError("SUPPLIER_UNAVAILABLE", {
          cause: new AmadeusTokenRequestError("token request", 503, true),
        }),
      ),
    ).toBe("SUPPLIER_UNAVAILABLE (token request HTTP 503)");
    expect(
      describeFailure(
        new AppError("SUPPLIER_TIMEOUT", {
          cause: new AmadeusTokenRequestError("token request", null, true),
        }),
      ),
    ).toBe("SUPPLIER_TIMEOUT (token request without an answer)");
    expect(
      describeFailure(
        new AppError("RATE_LIMITED", {
          cause: new AmadeusRateLimitedError("credential", 1500),
        }),
      ),
    ).toBe("RATE_LIMITED (Velexis rate limit)");
    expect(
      describeFailure(
        new AppError("SUPPLIER_ERROR", {
          supplier: {
            provider: "amadeus",
            status: 400,
            code: 4926,
            title: "INVALID DATA RECEIVED",
            detail: "a detail that may quote the request",
          },
        }),
      ),
    ).toBe("SUPPLIER_ERROR (Amadeus HTTP 400, code 4926)");
    expect(describeFailure(new AppError("SERVICE_UNAVAILABLE"))).toBe("SERVICE_UNAVAILABLE");
  });

  it("gives the class and code of any other error, never its message", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432 password=secret"), {
      code: "ECONNREFUSED",
    });
    expect(describeFailure(refused)).toBe("Error ECONNREFUSED");
    expect(describeFailure("a string")).toBe("Error");
  });
});
