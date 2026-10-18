// Route parity of the platform API (ADR-0006 "Checks in CI", PADR-0016 item 2). The routes are read from the API's
// module graph (`AppModule.forRoot`, walked statically: nothing is instantiated and no service is needed), the
// operations from the operations index generated from the document (`@velexis/api-types/operations`). The test fails
// when:
//
// - a route is bound with @OpenApiOperation to an operation that is not in the document, or with another method or
//   path than the operation's;
// - a route has no @OpenApiOperation, or two routes bind one operation;
// - a documented operation is neither bound nor listed in pending-operations.ts, or is both;
// - a pending entry names an operation the document lacks, appears twice, or names a task of the platform plan that
//   does not mention the operation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Controller,
  Get,
  Post,
  RequestMethod,
  type DynamicModule,
  type ForwardReference,
  type Type,
} from "@nestjs/common";
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { MetadataScanner } from "@nestjs/core";
import {
  platformOperations,
  type ApiOperation,
  type PlatformOperationId,
} from "@velexis/api-types/operations";
import { createLogger } from "@velexis/logger";
import { beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module";
import { OpenApiOperation, boundOperationId } from "../../src/common/http/openapi-operation.decorator";
import { APP_DIR, parseConfig } from "../../src/config";
import { HealthController } from "../../src/health/health.controller";
import { createTestJwtKeyFile } from "../support/jwt-key";
import { createTestMasterKeyDir, testCryptoAndMailEnv } from "../support/master-key";
import { PENDING_OPERATIONS, type PendingOperation } from "./pending-operations";

const PLAN = join(APP_DIR, "..", "docs", "plans", "agent-tasks.md");

/** One route of a controller, as Nest registers it. */
interface BoundRoute {
  /** `HealthController.live`. */
  readonly handler: string;
  /** Lower case, or `all` for `@All()`. */
  readonly method: string;
  /** In the document's syntax: `/v1/tenants/{tenantId}`. */
  readonly path: string;
  readonly operationId: string | undefined;
}

type ModuleEntry = Type | DynamicModule | Promise<DynamicModule> | ForwardReference | undefined;

/** Every controller of a module graph, found through the modules' metadata and dynamic module objects. */
async function controllersOf(root: ModuleEntry): Promise<Type[]> {
  const seen = new Set<unknown>();
  const controllers = new Set<Type>();
  const visit = async (entry: ModuleEntry): Promise<void> => {
    const resolved = await entry;
    if (resolved === undefined || seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    if ("forwardRef" in resolved) {
      await visit(resolved.forwardRef() as ModuleEntry);
      return;
    }
    const dynamic = "module" in resolved ? resolved : undefined;
    const moduleClass: Type = dynamic?.module ?? (resolved as Type);
    const metadata = (key: string): unknown[] =>
      (Reflect.getMetadata(key, moduleClass) as unknown[] | undefined) ?? [];
    for (const controller of [...metadata(MODULE_METADATA.CONTROLLERS), ...(dynamic?.controllers ?? [])]) {
      controllers.add(controller as Type);
    }
    for (const imported of [...metadata(MODULE_METADATA.IMPORTS), ...(dynamic?.imports ?? [])]) {
      await visit(imported as ModuleEntry);
    }
  };
  await visit(root);
  return [...controllers];
}

/** `["a", "/b/"]` → `/a/b`; Nest's `:name` → the document's `{name}`. */
function routePath(...parts: string[]): string {
  const joined = `/${parts.join("/")}`.replace(/\/+/g, "/");
  const trimmed = joined.length > 1 ? joined.replace(/\/$/, "") : joined;
  return trimmed.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** The routes of a controller with their method, path and bound operation. */
function routesOf(controller: Type): BoundRoute[] {
  const prefixes = [
    (Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined) ?? "/",
  ].flat();
  const prototype = controller.prototype as Record<string, unknown>;
  return new MetadataScanner().getAllMethodNames(prototype).flatMap((name) => {
    const handler = prototype[name];
    const method =
      typeof handler === "function" ? (Reflect.getMetadata(METHOD_METADATA, handler) as unknown) : undefined;
    if (typeof method !== "number") {
      return [];
    }
    const paths = [
      (Reflect.getMetadata(PATH_METADATA, handler as object) as string | string[] | undefined) ?? "/",
    ].flat();
    return prefixes.flatMap((prefix) =>
      paths.map((path) => ({
        handler: `${controller.name}.${name}`,
        method: String(RequestMethod[method]).toLowerCase(),
        path: routePath(prefix, path),
        operationId: boundOperationId(handler),
      })),
    );
  });
}

/** Every problem of PADR-0016 item 2; empty when the routes, the document and the pending list agree. */
function parityProblems(
  routes: readonly BoundRoute[],
  operations: readonly ApiOperation[],
  pending: readonly PendingOperation[],
): string[] {
  const problems: string[] = [];
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  const pendingIds = new Set<string>();
  for (const { operationId } of pending) {
    if (pendingIds.has(operationId)) {
      problems.push(`pending-operations.ts lists ${operationId} twice`);
    }
    pendingIds.add(operationId);
    if (!byId.has(operationId)) {
      problems.push(`pending-operations.ts lists ${operationId}, which is not in the document`);
    }
  }
  const boundBy = new Map<string, string[]>();
  for (const route of routes) {
    const where = `${route.handler} (${route.method.toUpperCase()} ${route.path})`;
    if (route.operationId === undefined) {
      problems.push(`${where} has no @OpenApiOperation`);
      continue;
    }
    boundBy.set(route.operationId, [...(boundBy.get(route.operationId) ?? []), where]);
    const operation = byId.get(route.operationId);
    if (operation === undefined) {
      problems.push(`${where} binds ${route.operationId}, which is not in the document`);
    } else if (operation.method !== route.method || operation.path !== route.path) {
      problems.push(
        `${where} binds ${route.operationId}, which the document has as ${operation.method.toUpperCase()} ${operation.path}`,
      );
    }
  }
  for (const [operationId, handlers] of boundBy) {
    if (handlers.length > 1) {
      problems.push(`${operationId} is bound by ${handlers.length} routes: ${handlers.join(", ")}`);
    }
    if (pendingIds.has(operationId)) {
      problems.push(
        `${operationId} is bound by ${handlers.join(", ")} and still listed in pending-operations.ts`,
      );
    }
  }
  for (const { operationId } of operations) {
    if (!boundBy.has(operationId) && !pendingIds.has(operationId)) {
      problems.push(
        `${operationId} is neither bound with @OpenApiOperation nor listed in pending-operations.ts`,
      );
    }
  }
  return problems;
}

/** The routes of the API's module graph, built as main.ts builds it (with development values). */
async function apiRoutes(): Promise<BoundRoute[]> {
  // The configuration needs a JWT key file and a key folder that exist; nothing reads them, since nothing is
  // instantiated.
  const jwtKey = createTestJwtKeyFile();
  const masterKeys = createTestMasterKeyDir();
  try {
    const config = parseConfig({
      APP_ENV: "test",
      DATABASE_URL: "postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis",
      REDIS_URL: "redis://:dev_redis@127.0.0.1:6379/0",
      PLATFORM_BFF_KEY: "dev_bff_key_change_me_0123456789abcdef",
      JWT_PRIVATE_KEY_FILE: jwtKey.path,
      ...testCryptoAndMailEnv(masterKeys),
      STOREFRONT_BASE_DOMAIN: "ota.example.com",
    });
    const logger = createLogger({ app: "platform-api", env: "test", level: "silent" });
    return (await controllersOf(AppModule.forRoot(config, logger))).flatMap(routesOf);
  } finally {
    jwtKey.remove();
    masterKeys.remove();
  }
}

/** A test-only controller that binds an operation the document lacks (a cast gets it past the compiler). */
@Controller("test-parity")
class UndocumentedController {
  @Post("rogue")
  @OpenApiOperation("rogueOperation" as PlatformOperationId)
  rogue(): void {}
}

/** Test-only controllers with the other faults. */
@Controller("v1/auth")
class FaultyController {
  @Get("sign-up")
  @OpenApiOperation("signUp")
  wrongMethod(): void {}

  @Post("unbound")
  unbound(): void {}
}

@Controller("v1/auth")
class SignUpController {
  @Post("sign-up")
  @OpenApiOperation("signUp")
  signUp(): void {}
}

/**
 * The routes without the API's own signUp route (AuthController, PBE-013): the faults below use signUp as their
 * example, as if its route were missing.
 */
function withoutSignUp(routes: readonly BoundRoute[]): BoundRoute[] {
  return routes.filter((route) => route.operationId !== "signUp");
}

describe("route parity", () => {
  let routes: BoundRoute[];

  beforeAll(async () => {
    routes = await apiRoutes();
  });

  it("[PBE-008 AC3] every route of the API binds its operation, and every documented operation is bound or pending", () => {
    expect(parityProblems(routes, platformOperations, PENDING_OPERATIONS)).toEqual([]);
    // The walk found the API's controllers: the health routes and signUp are bound to their operations.
    expect(routes).toEqual(
      expect.arrayContaining([
        { handler: "AuthController.signUp", method: "post", path: "/v1/auth/sign-up", operationId: "signUp" },
        { handler: "HealthController.live", method: "get", path: "/health/live", operationId: "healthLive" },
        {
          handler: "HealthController.ready",
          method: "get",
          path: "/health/ready",
          operationId: "healthReady",
        },
      ]),
    );
  });

  it("[PBE-008 AC3] fails when a test controller binds an operation that is not in the document", () => {
    const problems = parityProblems(
      [...routes, ...routesOf(UndocumentedController)],
      platformOperations,
      PENDING_OPERATIONS,
    );

    expect(problems).toEqual([
      "UndocumentedController.rogue (POST /test-parity/rogue) binds rogueOperation, which is not in the document",
    ]);
  });

  it("fails for a route without @OpenApiOperation and for a route whose method or path is not the operation's", () => {
    expect(
      parityProblems(
        [...withoutSignUp(routes), ...routesOf(FaultyController)],
        platformOperations,
        PENDING_OPERATIONS,
      ).sort(),
    ).toEqual([
      "FaultyController.unbound (POST /v1/auth/unbound) has no @OpenApiOperation",
      "FaultyController.wrongMethod (GET /v1/auth/sign-up) binds signUp, which the document has as POST /v1/auth/sign-up",
    ]);
  });

  it("fails for an operation that is neither bound nor pending, and for one that is both", () => {
    const signUpPending = [...PENDING_OPERATIONS, { operationId: "signUp", task: "PBE-013" } as const];

    expect(parityProblems(withoutSignUp(routes), platformOperations, PENDING_OPERATIONS)).toEqual([
      "signUp is neither bound with @OpenApiOperation nor listed in pending-operations.ts",
    ]);
    expect(
      parityProblems(
        [...withoutSignUp(routes), ...routesOf(SignUpController)],
        platformOperations,
        signUpPending,
      ),
    ).toEqual([
      "signUp is bound by SignUpController.signUp (POST /v1/auth/sign-up) and still listed in pending-operations.ts",
    ]);
    // Bound and no longer pending: what the implementing task (PBE-013) ended with.
    expect(
      parityProblems(
        [...withoutSignUp(routes), ...routesOf(SignUpController)],
        platformOperations,
        PENDING_OPERATIONS,
      ),
    ).toEqual([]);
  });

  it("fails for an operation bound twice, and for pending entries that are repeated or not in the document", () => {
    const signUpTwice = [...routesOf(SignUpController), ...routesOf(SignUpController)];

    expect(
      parityProblems([...withoutSignUp(routes), ...signUpTwice], platformOperations, PENDING_OPERATIONS),
    ).toEqual([
      "signUp is bound by 2 routes: SignUpController.signUp (POST /v1/auth/sign-up), SignUpController.signUp (POST /v1/auth/sign-up)",
    ]);
    expect(
      parityProblems([...routes, ...routesOf(SignUpController)], platformOperations, PENDING_OPERATIONS),
    ).toEqual([
      "signUp is bound by 2 routes: AuthController.signUp (POST /v1/auth/sign-up), SignUpController.signUp (POST /v1/auth/sign-up)",
    ]);
    // An operation that is still pending, listed a second time (any one: the list shrinks as tasks bind routes).
    const [pending] = PENDING_OPERATIONS;
    if (pending === undefined) {
      throw new Error("no pending operation left to repeat");
    }
    expect(
      parityProblems(routes, platformOperations, [
        ...PENDING_OPERATIONS,
        { ...pending },
        { operationId: "rogueOperation" as PlatformOperationId, task: "PBE-999" },
      ]),
    ).toEqual([
      `pending-operations.ts lists ${pending.operationId} twice`,
      "pending-operations.ts lists rogueOperation, which is not in the document",
    ]);
  });
});

describe("pending-operations.ts", () => {
  /** The task blocks of the platform plan by id (`### PBE-013 · …` up to the next heading). */
  const tasks = new Map(
    readFileSync(PLAN, "utf8")
      .split(/^### /m)
      .slice(1)
      .map((block) => [block.split(" ", 1)[0] ?? "", block] as const),
  );

  /**
   * Entries whose task describes the operation without naming it, with the step that does. Each one is a gap in the
   * plan's text, reported to the plan owner; an entry here never excuses a task that does not implement it.
   */
  const DESCRIBED_WITHOUT_NAME: Readonly<Record<string, string>> = {
    // PBE-031 step 4: "queue-inspector.ts: counts (waiting, active, delayed, failed, oldest waiting age) for every
    // queue in PLATFORM_QUEUES and OTA_QUEUES", the answer of adminListQueues (api-inventory-admin §3).
    adminListQueues: "PBE-031",
  };

  it("names, for each operation, a task of the platform plan that mentions it", () => {
    const wrong = PENDING_OPERATIONS.filter(
      ({ operationId, task }) =>
        DESCRIBED_WITHOUT_NAME[operationId] !== task &&
        !new RegExp(`\\b${operationId}\\b`).test(tasks.get(task) ?? ""),
    );

    expect(wrong).toEqual([]);
    expect(tasks.get("PBE-031")).toContain("queue-inspector.ts");
  });

  it("never names a contract task: the operations of a slice are implemented by later tasks", () => {
    const contractTasks = [
      "PBE-005",
      "PBE-006",
      "PBE-007",
      "PBE-066",
      "PBE-037",
      "PBE-041",
      "PBE-042",
      "PBE-008",
    ];

    expect(PENDING_OPERATIONS.filter(({ task }) => contractTasks.includes(task))).toEqual([]);
  });

  it("does not list the health operations, which HealthController binds", () => {
    const pending = PENDING_OPERATIONS.map(({ operationId }) => operationId);

    expect(pending).not.toContain("healthLive");
    expect(pending).not.toContain("healthReady");
    expect(routesOf(HealthController).map(({ operationId }) => operationId)).toEqual([
      "healthLive",
      "healthReady",
    ]);
  });
});
