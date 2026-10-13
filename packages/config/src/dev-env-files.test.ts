import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineConfig, env, loadDevEnvFiles } from "./index";

let tmp: string;
let root: string;
let appDir: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "velexis-config-dev-env-"));
  // A miniature workspace: <root>/pnpm-workspace.yaml, <root>/.env.local, <root>/apps/demo/.env.local.
  root = join(tmp, "workspace");
  appDir = join(root, "apps", "demo");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
  writeFileSync(
    join(root, ".env.local"),
    [
      "# root file: shared values",
      "SHARED=from-root",
      "APP_OVERRIDE=from-root",
      "ENV_OVERRIDE=from-root",
      'MAIL_FROM="Velexis (dev) <no-reply@mail.ota.example.com>"',
      "PORT=3100",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(appDir, ".env.local"),
    "APP_OVERRIDE=from-app\nENV_OVERRIDE=from-app\nAPP_ONLY=from-app\n",
  );
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadDevEnvFiles", () => {
  it("gives the environment precedence over the app file, and the app file over the root file [X-002 AC4]", () => {
    const target: Record<string, string | undefined> = { APP_ENV: "development", ENV_OVERRIDE: "from-env" };
    const result = loadDevEnvFiles({ appDir, env: target });

    expect(result.files).toEqual([join(appDir, ".env.local"), join(root, ".env.local")]);
    expect(target).toEqual({
      APP_ENV: "development",
      ENV_OVERRIDE: "from-env",
      APP_OVERRIDE: "from-app",
      APP_ONLY: "from-app",
      SHARED: "from-root",
      MAIL_FROM: "Velexis (dev) <no-reply@mail.ota.example.com>",
      PORT: "3100",
    });
  });

  it("reads no file when APP_ENV is production [X-002 AC4]", () => {
    const target: Record<string, string | undefined> = { APP_ENV: "production" };
    expect(loadDevEnvFiles({ appDir, env: target })).toEqual({ files: [] });
    expect(target).toEqual({ APP_ENV: "production" });

    // .env.local folders would make any read fail with EISDIR: nothing is read, so nothing throws.
    const trap = join(tmp, "trap");
    mkdirSync(join(trap, "app", ".env.local"), { recursive: true });
    mkdirSync(join(trap, ".env.local"), { recursive: true });
    const options = { appDir: join(trap, "app"), rootDir: trap };
    expect(loadDevEnvFiles({ ...options, env: { APP_ENV: "production" } })).toEqual({ files: [] });
    expect(() => loadDevEnvFiles({ ...options, env: { APP_ENV: "development" } })).toThrow(/EISDIR/);
  });

  it("reads no file when NODE_ENV is production", () => {
    const target: Record<string, string | undefined> = { NODE_ENV: "production" };
    expect(loadDevEnvFiles({ appDir, env: target })).toEqual({ files: [] });
    expect(target).toEqual({ NODE_ENV: "production" });
  });

  it("keeps a variable that the environment sets to an empty value", () => {
    const target: Record<string, string | undefined> = { SHARED: "" };
    loadDevEnvFiles({ appDir, env: target });
    expect(target["SHARED"]).toBe("");
  });

  it("skips missing files and accepts an explicit rootDir", () => {
    const lone = join(tmp, "lone");
    mkdirSync(lone);
    const target: Record<string, string | undefined> = {};
    expect(loadDevEnvFiles({ appDir: lone, rootDir: root, env: target })).toEqual({
      files: [join(root, ".env.local")],
    });
    expect(target["APP_OVERRIDE"]).toBe("from-root");

    // Outside a workspace and without files there is nothing to read.
    const empty: Record<string, string | undefined> = {};
    expect(loadDevEnvFiles({ appDir: join(lone, "missing-app"), rootDir: lone, env: empty })).toEqual({
      files: [],
    });
    expect(empty).toEqual({});
  });

  it("reads the root file only once when the app folder is the root", () => {
    expect(loadDevEnvFiles({ appDir: root, env: {} }).files).toEqual([join(root, ".env.local")]);
  });

  it("fills the process environment by default, ahead of defineConfig", () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("NODE_ENV", "test");
    const probeDir = join(tmp, "probe-app");
    mkdirSync(probeDir);
    writeFileSync(join(probeDir, ".env.local"), "VELEXIS_X002_DEV_ENV_PROBE=4100\n");
    vi.stubEnv("VELEXIS_X002_DEV_ENV_PROBE", undefined);

    const result = loadDevEnvFiles({ appDir: probeDir, rootDir: probeDir });
    expect(result.files).toEqual([join(probeDir, ".env.local")]);
    expect(defineConfig({ VELEXIS_X002_DEV_ENV_PROBE: env.port() }).VELEXIS_X002_DEV_ENV_PROBE).toBe(4100);
  });
});
