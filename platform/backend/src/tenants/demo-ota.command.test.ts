// `tenants:create-demo` without a database (PBE-075; tenants/demo-ota.command.ts, its file header): the argument checks
// and their usage errors (exit 2, nothing echoed, before any configuration is read), the exit code and the text of
// every outcome, what the command's service makes of createTenant's refusals, and when it sets the demo OTA's manual
// subscription `active` through the admin's manual edit. The integration test
// test/integration/tenants/demo-ota.int.test.ts runs the command with APP_ENV=production on PostgreSQL and Redis.
import { AppError } from "@velexis/errors";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AccountsRepository } from "../auth/accounts.repository";
import type { SubscriptionsRepository } from "../billing/subscriptions.repository";
import type { SubscriptionsService } from "../billing/subscriptions.service";
import { CLI_COMMANDS, EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli, usage } from "../cli";
import type { PlatformDb } from "../common/database";
import type { LifecycleService } from "../provisioning/lifecycle.service";
import {
  activationReport,
  checkReport,
  creationReport,
  DEFAULT_DEMO_OTA_KEY,
  DEFAULT_DEMO_OTA_NAME,
  DEMO_OTA_ARGUMENTS,
  DEMO_OTA_COMMAND,
  DEMO_OTA_SUBSCRIPTION_REASON,
  DEMO_OTA_USAGE,
  demoOtaActorLabel,
  demoOtaAuditDetails,
  DemoOtaService,
  otaLine,
  parseDemoOtaArguments,
  type DemoOta,
  type DemoOtaArguments,
} from "./demo-ota.command";

const REQUIRED = ["--country", "NO", "--currency", "EUR", "--time-zone", "Europe/Oslo"];
const operator = (): string => "default-user";

const ARGS: DemoOtaArguments = {
  email: "dev.one@example.com",
  key: "demo",
  name: "Velexis demo",
  countryCode: "NO",
  defaultCurrency: "EUR",
  timeZone: "Europe/Oslo",
  operator: "Developer One",
};

const OTA: DemoOta = {
  id: "ten_01J9ZK3Q5V8W2X4Y6Z8A0B2C4D",
  key: "demo",
  name: "Velexis demo",
  status: "provisioning",
};

/** The problem of a parse, or `undefined` when it parsed. */
function problemOf(args: readonly string[]): string | undefined {
  const parsed = parseDemoOtaArguments(args, operator);
  return "problem" in parsed ? parsed.problem : undefined;
}

/** A writable buffer pair for runCli. */
function buffers() {
  const stdout = { text: "", write: (part: string) => (stdout.text += part) };
  const stderr = { text: "", write: (part: string) => (stderr.text += part) };
  return { stdout, stderr };
}

describe("parseDemoOtaArguments", () => {
  it("[PBE-075 AC1] takes the e-mail and the flags in any order, with the defaults for the name, key and operator", () => {
    expect(parseDemoOtaArguments([" Dev.One@Example.com ", ...REQUIRED], operator)).toEqual({
      email: "Dev.One@Example.com",
      key: DEFAULT_DEMO_OTA_KEY,
      name: DEFAULT_DEMO_OTA_NAME,
      countryCode: "NO",
      defaultCurrency: "EUR",
      timeZone: "Europe/Oslo",
      operator: "default-user",
    });
    expect(DEFAULT_DEMO_OTA_KEY).toBe("demo");
    expect(DEFAULT_DEMO_OTA_NAME).toBe("Velexis demo");
    expect(
      parseDemoOtaArguments(
        [
          "--operator",
          "Developer One",
          "--time-zone",
          "UTC",
          "--name",
          "Velexis Demo Travel",
          "dev.one@example.com",
          "--key",
          "demo",
          "--currency",
          "USD",
          "--country",
          "US",
        ],
        operator,
      ),
    ).toEqual({
      email: "dev.one@example.com",
      key: "demo",
      name: "Velexis Demo Travel",
      countryCode: "US",
      defaultCurrency: "USD",
      timeZone: "UTC",
      operator: "Developer One",
    });
  });

  it.each([["acme"], ["admin"], ["test"], ["Demo"], ["demo2"]])(
    "[PBE-075 AC2] refuses the key %j: only Velexis's own key, never echoed",
    (key) => {
      const problem = problemOf(["dev.one@example.com", ...REQUIRED, "--key", key]);
      expect(problem).toBe("--key takes only Velexis's own key (demo); create any other OTA in the portal");
      expect(problem).not.toContain(` ${key} `);
    },
  );

  it("refuses a missing or invalid e-mail address, a second one and an unknown flag", () => {
    expect(problemOf(REQUIRED)).toMatch(/^give the owner's e-mail address/);
    expect(problemOf(["not-an-address", ...REQUIRED])).toMatch(/^give the owner's e-mail address/);
    expect(problemOf(["one@example.com", "two@example.com", ...REQUIRED])).toMatch(/^unexpected argument/);
    expect(problemOf(["one@example.com", ...REQUIRED, "--force"])).toMatch(/^unexpected argument/);
    expect(problemOf(["one@example.com", ...REQUIRED, "--plan", "growth"])).toMatch(/^unexpected argument/);
  });

  it("requires the country, the currency and the time zone, in the shapes of the contract", () => {
    expect(problemOf(["one@example.com", "--country", "NO", "--currency", "EUR"])).toBe(
      "--country, --currency and --time-zone are required",
    );
    expect(
      problemOf(["one@example.com", "--country", "no", "--currency", "EUR", "--time-zone", "UTC"]),
    ).toMatch(/^--country needs/);
    expect(
      problemOf(["one@example.com", "--country", "NO", "--currency", "EURO", "--time-zone", "UTC"]),
    ).toMatch(/^--currency needs/);
    expect(
      problemOf(["one@example.com", "--country", "NO", "--currency", "EUR", "--time-zone", "Europe Oslo"]),
    ).toMatch(/^--time-zone needs/);
  });

  it("refuses a flag without a value, a flag given twice, an empty or too long name and a bad operator", () => {
    expect(problemOf(["one@example.com", ...REQUIRED, "--name"])).toBe("--name needs a value");
    expect(problemOf(["one@example.com", "--country", "--currency", "EUR"])).toBe("--country needs a value");
    expect(problemOf(["one@example.com", ...REQUIRED, "--country", "SE"])).toBe("--country is given twice");
    expect(problemOf(["one@example.com", ...REQUIRED, "--name", "  "])).toMatch(/^--name needs 1 to 100/);
    expect(problemOf(["one@example.com", ...REQUIRED, "--name", "x".repeat(101)])).toMatch(/^--name needs/);
    expect(problemOf(["one@example.com", ...REQUIRED, "--name", "Velexis\ndemo"])).toMatch(/^--name needs/);
    expect(problemOf(["one@example.com", ...REQUIRED, "--operator", "--name"])).toBe(
      "--operator needs a value",
    );
    expect(problemOf(["one@example.com", ...REQUIRED, "--operator", "-bad"])).toMatch(
      /^--operator needs one name/,
    );
    expect(problemOf(["one@example.com", ...REQUIRED, "--operator", "!bad"])).toMatch(
      /^--operator needs one name/,
    );
  });
});

describe("runCli tenants:create-demo", () => {
  let usageRun: { code: number; stdout: string; stderr: string };
  let otherKeyRun: { code: number; stdout: string; stderr: string };
  let badConfigRun: { code: number; stdout: string; stderr: string };

  beforeAll(async () => {
    // The first run loads tenants/demo-ota.command.ts (Nest and the modules of its application context): a few seconds
    // of compiling under a loaded CI runner, bounded here rather than in a test. No run reaches a database.
    let output = buffers();
    let code = await runCli(["tenants:create-demo", "Secret-Value 1!", ...REQUIRED], output);
    usageRun = { code, stdout: output.stdout.text, stderr: output.stderr.text };
    output = buffers();
    code = await runCli(
      ["tenants:create-demo", "dev.one@example.com", ...REQUIRED, "--key", "secretkeyvalue"],
      output,
    );
    otherKeyRun = { code, stdout: output.stdout.text, stderr: output.stderr.text };
    output = buffers();
    code = await runCli(["tenants:create-demo", "dev.one@example.com", ...REQUIRED, "--operator", "Dev"], {
      ...output,
      env: { APP_ENV: "production", DATABASE_URL: "not-a-dsn-Secret-Config-Value" },
    });
    badConfigRun = { code, stdout: output.stdout.text, stderr: output.stderr.text };
  }, 60_000);

  it("[PBE-075 AC2] exits 2 with the usage for a wrong argument or another key, before any configuration, never echoing it", () => {
    for (const run of [usageRun, otherKeyRun]) {
      expect(run.code).toBe(EXIT_USAGE);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/^tenants:create-demo: .+; nothing was created\.\n/);
      expect(run.stderr.endsWith(`${DEMO_OTA_USAGE}\n`)).toBe(true);
    }
    expect(usageRun.stderr).not.toContain("Secret-Value");
    expect(otherKeyRun.stderr).not.toContain("secretkeyvalue");
  });

  it("lists the command with the arguments of its module", () => {
    const command = CLI_COMMANDS.find((candidate) => candidate.name === DEMO_OTA_COMMAND);

    expect(command?.args).toBe(DEMO_OTA_ARGUMENTS);
    expect(usage(CLI_COMMANDS)).toMatch(
      /^ {2}tenants:create-demo <email> .+ {2}Create Velexis's own demo OTA /m,
    );
  });

  it("exits 1 for an invalid configuration, naming the variable and never its value", () => {
    expect(badConfigRun.code).toBe(EXIT_FAILED);
    expect(badConfigRun.stdout).toBe("");
    expect(badConfigRun.stderr).toMatch(/^The configuration is invalid:\n/);
    expect(badConfigRun.stderr).toContain("DATABASE_URL");
    expect(badConfigRun.stderr).not.toContain("Secret-Config-Value");
  });
});

describe("the reports", () => {
  it("[PBE-075 AC2] refuses an unknown e-mail, an owner without MFA and a demo OTA of another owner with exit 1", () => {
    for (const result of ["not_found", "not_verified", "not_active", "mfa_not_enabled"] as const) {
      const report = checkReport({ result }, ARGS);
      expect(report.code, result).toBe(EXIT_FAILED);
      expect(report.out, result).toEqual([]);
      expect(report.err.join("\n"), result).toMatch(/nothing was created\./);
    }
    expect(checkReport({ result: "mfa_not_enabled" }, ARGS).err).toEqual([
      "The account dev.one@example.com has no MFA; nothing was created. The person turns MFA on in the portal " +
        "first (Account, Security), then run tenants:create-demo again.",
    ]);
    expect(checkReport({ result: "other_owner", ota: OTA }, ARGS)).toEqual({
      out: [],
      err: [`The OTA demo (${OTA.id}) exists and dev.one@example.com is not its owner; nothing changed.`],
      code: EXIT_FAILED,
    });
    const failed = checkReport({ result: "wrong_status", ota: { ...OTA, status: "failed" } }, ARGS);
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.err[0]).toMatch(
      /^The OTA demo \(ten_\w+\) is failed, not active or provisioning; nothing changed\./,
    );
  });

  it("refuses with exit 1 what createTenant refused, naming the flags of unknown reference values", () => {
    for (const creation of [
      { result: "not_verified" } as const,
      { result: "key_unavailable" } as const,
      { result: "invalid_reference", flags: ["--country", "--time-zone"] } as const,
      { result: "tenant_limit", limit: 3 } as const,
    ]) {
      const report = creationReport(creation);
      expect(report.code, creation.result).toBe(EXIT_FAILED);
      expect(report.out, creation.result).toEqual([]);
      expect(report.err.join("\n"), creation.result).toMatch(/nothing was created\./);
    }
    expect(creationReport({ result: "invalid_reference", flags: ["--country", "--time-zone"] }).err).toEqual([
      "The reference data holds no such value for --country, --time-zone; nothing was created.",
    ]);
  });

  it("[PBE-075 AC1] exits 0 once the manual subscription is active, now or already, and 1 otherwise", () => {
    const activated = activationReport({ result: "activated", subscriptionId: "sub_1" }, OTA);
    expect(activated.code).toBe(EXIT_OK);
    expect(activated.out[0]).toBe(
      'Its manual subscription sub_1 is now active ("Velexis demo OTA, not billed"; audit row ' +
        "subscription.manually_updated): billing never e-mails or suspends it.",
    );
    expect(activated.out[1]).toBe(
      `Next: the owner signs in to the portal and opens /otas/${OTA.id}/setup within 24 hours of the setup to ` +
        "reveal the initial test keys once.",
    );
    expect(activationReport({ result: "already_active", subscriptionId: "sub_1" }, OTA)).toEqual({
      out: ["Its manual subscription sub_1 is active already; nothing changed."],
      err: [],
      code: EXIT_OK,
    });
    const stripe = activationReport(
      { result: "unexpected", subscription: { id: "sub_2", provider: "stripe", status: "active" } },
      OTA,
    );
    expect(stripe.code).toBe(EXIT_FAILED);
    expect(stripe.err[0]).toMatch(/has the stripe subscription sub_2 in active, not a manual one/);
    expect(activationReport({ result: "unexpected", subscription: null }, OTA).code).toBe(EXIT_FAILED);
    const failed = activationReport(
      { result: "failed", subscriptionId: "sub_1", code: "PRECONDITION_FAILED" },
      OTA,
    );
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.err[0]).toMatch(
      /\(PRECONDITION_FAILED\); the OTA stays as it is\. Run tenants:create-demo again/,
    );
  });

  it("says what was created or found, with ids and statuses only", () => {
    expect(otaLine(OTA, ARGS, { id: "job_1", status: "running" })).toBe(
      `The OTA demo "Velexis demo" (${OTA.id}) of dev.one@example.com was created: provisioning, storefront ` +
        "environment test, plan early_access; its setup job job_1 is running. Audit rows tenant.created and " +
        "tenant.reserved_key_used were written.",
    );
    expect(otaLine({ ...OTA, status: "active" }, ARGS)).toBe(
      `The OTA demo "Velexis demo" (${OTA.id}) of dev.one@example.com exists already (active); it was not ` +
        "created again.",
    );
  });

  it("names the command and its operator in the audit actor and details", () => {
    expect(demoOtaActorLabel("Developer One")).toBe("cli tenants:create-demo by Developer One");
    expect(demoOtaAuditDetails("Developer One")).toEqual({
      command: "tenants:create-demo",
      operator: "Developer One",
    });
  });
});

/** A DemoOtaService over fakes of createTenant and of the subscription reads and the manual edit. */
function service(
  options: {
    readonly create?: () => Promise<unknown>;
    readonly shown?: { id: string; billing_provider: string; status: string } | undefined;
    readonly update?: () => Promise<unknown>;
  } = {},
) {
  const createTenant = vi.fn(
    options.create ??
      (() =>
        Promise.resolve({
          tenant: { id: OTA.id, key: "demo", name: "Velexis demo", status: "provisioning" },
          provisioningJob: { id: "job_1", status: "running" },
          checkoutUrl: null,
        })),
  );
  const updateManual = vi.fn(options.update ?? (() => Promise.resolve({})));
  const subscriptions = {
    findShownForTenant: () => Promise.resolve(options.shown),
    findAdmin: (id: string) => Promise.resolve({ id, version: 4 }),
  } as unknown as SubscriptionsRepository;
  const demo = new DemoOtaService(
    {} as AccountsRepository,
    { createTenant } as unknown as LifecycleService,
    subscriptions,
    { updateManual } as unknown as SubscriptionsService,
    {} as PlatformDb,
  );
  return { demo, createTenant, updateManual };
}

describe("DemoOtaService", () => {
  it("[PBE-075 AC1] creates through createTenant with the option of Velexis's own OTAs, naming the command", async () => {
    const { demo, createTenant } = service();
    expect(await demo.create(ARGS, "acc_1")).toEqual({
      result: "created",
      ota: OTA,
      job: { id: "job_1", status: "running" },
    });
    expect(createTenant).toHaveBeenCalledWith(
      "acc_1",
      {
        key: "demo",
        name: "Velexis demo",
        countryCode: "NO",
        defaultCurrency: "EUR",
        timeZone: "Europe/Oslo",
      },
      "tenants:create-demo",
      {
        actorLabel: "cli tenants:create-demo by Developer One",
        details: { command: "tenants:create-demo", operator: "Developer One" },
      },
    );
  });

  it("answers createTenant's refusals as outcomes and lets any other error through", async () => {
    const refusing = (error: Error) =>
      service({ create: () => Promise.reject(error) }).demo.create(ARGS, "acc_1");
    expect(await refusing(new AppError("TENANT_KEY_UNAVAILABLE"))).toEqual({ result: "key_unavailable" });
    expect(await refusing(new AppError("EMAIL_NOT_VERIFIED"))).toEqual({ result: "not_verified" });
    expect(
      await refusing(
        new AppError("VALIDATION_FAILED", {
          fieldErrors: [
            { path: "/countryCode", code: "unknown", message: "x" },
            { path: "/timeZone", code: "unknown", message: "x" },
          ],
        }),
      ),
    ).toEqual({ result: "invalid_reference", flags: ["--country", "--time-zone"] });
    expect(
      await refusing(new AppError("UNPROCESSABLE", { details: { reason: "tenant_limit", limit: 3 } })),
    ).toEqual({ result: "tenant_limit", limit: 3 });
    await expect(refusing(new Error("database down"))).rejects.toThrow("database down");
  });

  it("[PBE-075 AC1] sets a manual trial active through the admin's manual edit, as the command, with the reason", async () => {
    for (const status of ["trialing", "past_due"]) {
      const { demo, updateManual } = service({ shown: { id: "sub_1", billing_provider: "manual", status } });
      expect(await demo.activate(OTA.id, "Developer One"), status).toEqual({
        result: "activated",
        subscriptionId: "sub_1",
      });
      expect(updateManual).toHaveBeenCalledWith(
        {
          system: {
            label: "cli tenants:create-demo by Developer One",
            details: { command: "tenants:create-demo", operator: "Developer One" },
          },
        },
        "sub_1",
        4,
        { status: "active", reason: DEMO_OTA_SUBSCRIPTION_REASON },
      );
    }
  });

  it("[PBE-075 AC1] changes nothing for a manual subscription that is active already", async () => {
    const { demo, updateManual } = service({
      shown: { id: "sub_1", billing_provider: "manual", status: "active" },
    });
    expect(await demo.activate(OTA.id, "Developer One")).toEqual({
      result: "already_active",
      subscriptionId: "sub_1",
    });
    expect(updateManual).not.toHaveBeenCalled();
  });

  it("leaves a Stripe, canceled or missing subscription alone, and reports a refused edit", async () => {
    for (const shown of [
      { id: "sub_1", billing_provider: "stripe", status: "trialing" },
      { id: "sub_1", billing_provider: "manual", status: "canceled" },
      undefined,
    ]) {
      const { demo, updateManual } = service({ shown });
      expect((await demo.activate(OTA.id, "Developer One")).result).toBe("unexpected");
      expect(updateManual).not.toHaveBeenCalled();
    }
    const { demo } = service({
      shown: { id: "sub_1", billing_provider: "manual", status: "trialing" },
      update: () => Promise.reject(new AppError("PRECONDITION_FAILED")),
    });
    expect(await demo.activate(OTA.id, "Developer One")).toEqual({
      result: "failed",
      subscriptionId: "sub_1",
      code: "PRECONDITION_FAILED",
    });
  });
});
