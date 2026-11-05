import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  RequestMethod,
  UseInterceptors,
  type CallHandler,
  type DynamicModule,
  type ExecutionContext,
  type ForwardReference,
  type NestInterceptor,
  type Provider,
  type Type,
} from "@nestjs/common";
import {
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from "@nestjs/common/constants";
import { APP_INTERCEPTOR, MetadataScanner } from "@nestjs/core";
import {
  AnyFilesInterceptor,
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
  MulterModule,
  NoFilesInterceptor,
} from "@nestjs/platform-express";
import { platformOperations } from "@velexis/api-types/operations";
import { createLogger } from "@velexis/logger";
import type { Observable } from "rxjs";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PENDING_OPERATIONS } from "../test/contract/pending-operations";
import { createTestJwtKeyFile } from "../test/support/jwt-key";
import { createTestMasterKeyDir, testCryptoAndMailEnv } from "../test/support/master-key";
import { AppModule } from "./app.module";
import { usage, CLI_COMMANDS, EXIT_OK, EXIT_USAGE } from "./cli";
import { boundOperationId } from "./common/http/openapi-operation.decorator";
import { APP_DIR, parseConfig } from "./config";
import { startApi } from "./main";
import { startWorker } from "./worker";

/** A pino destination that keeps the parsed lines. */
function logSink(): { readonly lines: Record<string, unknown>[]; write(line: string): void } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
}

/** The development PLATFORM_BFF_KEY of platform/backend/.env.example (a dummy value). */
const BFF_KEY = "dev_bff_key_change_me_0123456789abcdef";

/** A JWT signing key of mode 0600 in a temporary folder (JWT_PRIVATE_KEY_FILE must name a valid key file). */
const jwtKey = createTestJwtKeyFile();
/** A master key folder (MASTER_KEY_DIR must name an existing folder). */
const masterKeys = createTestMasterKeyDir();

afterAll(() => {
  jwtKey.remove();
  masterKeys.remove();
});

/** Everything but DATABASE_URL. */
const WITHOUT_DATABASE_URL = {
  APP_ENV: "test",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  PLATFORM_BFF_KEY: BFF_KEY,
  JWT_PRIVATE_KEY_FILE: jwtKey.path,
  ...testCryptoAndMailEnv(masterKeys),
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
} as const;

/** The one line the entry points log when DATABASE_URL is missing. */
function configInvalidLine(app: string): unknown {
  return expect.objectContaining({
    level: 60,
    app,
    msg: "config.invalid",
    err: expect.objectContaining({
      type: "ConfigError",
      message: "Invalid configuration (1 problem):\n  - DATABASE_URL is required but missing",
    }),
  });
}

// The entry points exit with code 1 when these functions resolve to undefined (`process.exit(1)` in main.ts and
// worker.ts); nothing is created before the configuration is valid, so no connection is attempted here.
describe.each([
  ["startApi", "platform-api", startApi],
  ["startWorker", "platform-worker", startWorker],
] as const)("%s", (_name, app, start) => {
  it("[PBE-001 AC3] refuses to start without DATABASE_URL, logging the ConfigError that names it", async () => {
    const logs = logSink();

    await expect(start({ env: WITHOUT_DATABASE_URL, logDestination: logs })).resolves.toBeUndefined();

    expect(logs.lines).toEqual([configInvalidLine(app)]);
  });
});

/** tsconfig.build.json, parsed: the sources of the build (src/ without the tests) and their compiler options. */
function buildConfig(): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(APP_DIR, "tsconfig.build.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (parsed === undefined) {
    throw new Error("tsconfig.build.json cannot be read");
  }
  return parsed;
}

/**
 * Compiles the sources of the build (tsconfig.build.json: src/ without the tests) to CommonJS in `outDir`, as `tsc`
 * compiles them to dist/, so the entry points run as processes without depending on an earlier build.
 */
function compileSources(outDir: string): void {
  const parsed = buildConfig();
  const compilerOptions: ts.CompilerOptions = {
    ...parsed.options,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    sourceMap: false,
  };
  for (const file of parsed.fileNames) {
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions,
      fileName: file,
    });
    const target = join(outDir, relative(join(APP_DIR, "src"), file).replace(/\.ts$/, ".js"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, outputText);
  }
}

// `node dist/main.js`, `node dist/worker.js` and `node dist/cli.js` as systemd and operators run them: the
// `require.main === module` blocks turn the start functions' results into the process's exit code.
describe("the entry points as processes", () => {
  let outDir: string;
  /** What each process gave, by entry point and arguments: the processes run in the setup hook, the tests read them. */
  const runs = new Map<string, SpawnSyncReturns<string>>();

  /** Runs `<entry>.js` of the compiled sources with only `env`; packages resolve from this package's node_modules. */
  function run(
    entry: string,
    args: readonly string[],
    env: Record<string, string>,
  ): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [join(outDir, `${entry}.js`), ...args], {
      env: { ...env, NODE_PATH: join(APP_DIR, "node_modules") },
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  /** The process run in the setup hook for `key`. */
  function ran(key: string): SpawnSyncReturns<string> {
    const result = runs.get(key);
    if (result === undefined) {
      throw new Error(`no process ran for ${key}`);
    }
    return result;
  }

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "velexis-platform-backend-entry-"));
    compileSources(outDir);
    for (const entry of ["main", "worker"]) {
      // As on the VM (APP_ENV and NODE_ENV production): no .env.local file is read.
      runs.set(
        entry,
        run(entry, [], {
          APP_ENV: "production",
          NODE_ENV: "production",
          REDIS_URL: "redis://127.0.0.1:6379/0",
          PLATFORM_BFF_KEY: BFF_KEY,
          JWT_PRIVATE_KEY_FILE: jwtKey.path,
          ...testCryptoAndMailEnv(masterKeys),
          // APP_ENV=production takes an https OTA API URL only (FIX-W39-PLATFORM).
          PUBLIC_OTA_API_URL: "https://api.ota.example.com",
          STOREFRONT_BASE_DOMAIN: "ota.example.com",
        }),
      );
    }
    runs.set("cli help", run("cli", ["help"], {}));
    runs.set("cli", run("cli", [], {}));
    // Transpiling every source file takes seconds, and each process about a second to load the application's modules,
    // several times that on a machine that runs the other packages' tests at the same time (a `next build` among
    // them), so the processes run here rather than inside the tests' 5 s bound. 180 s bounds the transpiling and the
    // four processes, each of which spawnSync stops after 30 s, on a slow CI runner.
  }, 180_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it.each([
    ["main", "platform-api"],
    ["worker", "platform-worker"],
  ])(
    "[PBE-001 AC3] node dist/%s.js exits 1 without DATABASE_URL, after one fatal line whose ConfigError names it",
    (entry, app) => {
      const result = ran(entry);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown),
      ).toEqual([configInvalidLine(app)]);
    },
  );

  it("node dist/cli.js exits 0 for help and 2 without a command, with no configuration at all", () => {
    const help = ran("cli help");
    const none = ran("cli");

    expect([help.status, help.stdout, help.stderr]).toEqual([EXIT_OK, usage(CLI_COMMANDS), ""]);
    expect([none.status, none.stdout, none.stderr]).toEqual([
      EXIT_USAGE,
      "",
      `No command given.\n\n${usage(CLI_COMMANDS)}`,
    ]);
  });
});

// The API keeps multipart parsing unreachable (PBE-069, finding F-3 of platform/docs/security-review.md). `multer`, a
// dependency of @nestjs/platform-express (2.5.0 through OBE-094's root `pnpm.overrides` entry), parses a request body
// only inside NestJS's file interceptors (FileInterceptor, FilesInterceptor, FileFieldsInterceptor, AnyFilesInterceptor
// and NoFilesInterceptor), and the API's own body parser reads JSON only (common/http/raw-body.ts). The walk below reads
// the module graph that startApi builds (`AppModule.forRoot`), statically as the route parity test does: nothing is
// instantiated and no service is needed. It fails when a route, its controller or the whole application (an
// `APP_INTERCEPTOR` provider) binds a file interceptor, or when a module registers MulterModule. What the graph does
// not show (an interceptor that main.ts binds with `useGlobalInterceptors`, a middleware) is covered by a scan of the
// API's own sources, which fails when one imports a file interceptor, multer or busboy. So no multer advisory reaches
// the API, whatever multer's version.

/** The injection token from which every file interceptor of @nestjs/platform-express reads its multer options. */
const MULTER_OPTIONS_TOKEN = "MULTER_MODULE_OPTIONS";

type ModuleEntry = Type | DynamicModule | Promise<DynamicModule> | ForwardReference | undefined;

/** The parts of a module graph that can bind an interceptor. */
interface ModuleGraph {
  /** Every module class of the graph, once (a dynamic module by its class). */
  readonly modules: readonly Type[];
  readonly controllers: readonly Type[];
  /** Every provider, with the name of the module that declares it. */
  readonly providers: readonly { readonly module: string; readonly provider: Provider }[];
}

/** Walks a module graph through the modules' metadata and the dynamic module objects, instantiating nothing. */
async function moduleGraph(root: ModuleEntry): Promise<ModuleGraph> {
  const seen = new Set<unknown>();
  const modules = new Set<Type>();
  const controllers = new Set<Type>();
  const providers: { module: string; provider: Provider }[] = [];
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
    modules.add(moduleClass);
    for (const controller of [...metadata(MODULE_METADATA.CONTROLLERS), ...(dynamic?.controllers ?? [])]) {
      controllers.add(controller as Type);
    }
    for (const provider of [...metadata(MODULE_METADATA.PROVIDERS), ...(dynamic?.providers ?? [])]) {
      providers.push({ module: moduleClass.name, provider: provider as Provider });
    }
    for (const imported of [...metadata(MODULE_METADATA.IMPORTS), ...(dynamic?.imports ?? [])]) {
      await visit(imported as ModuleEntry);
    }
  };
  await visit(root);
  return { modules: [...modules], controllers: [...controllers], providers };
}

/** One route of a controller with every interceptor `@UseInterceptors` binds to it (the controller's, then its own). */
interface InterceptedRoute {
  /** `HealthController.live`. */
  readonly handler: string;
  /** `GET /health/live`, in Nest's path syntax. */
  readonly route: string;
  readonly operationId: string | undefined;
  readonly interceptors: readonly unknown[];
}

/** The interceptors `@UseInterceptors` put on a controller class or on a handler (classes or instances). */
function interceptorsOn(target: object): unknown[] {
  return (Reflect.getMetadata(INTERCEPTORS_METADATA, target) as unknown[] | undefined) ?? [];
}

/** The routes of a controller, as Nest registers them, with their interceptors. */
function interceptedRoutesOf(controller: Type): InterceptedRoute[] {
  const prefixes = [
    (Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined) ?? "/",
  ].flat();
  const prototype = controller.prototype as Record<string, unknown>;
  return new MetadataScanner().getAllMethodNames(prototype).flatMap((name) => {
    const handler = prototype[name];
    const method: unknown =
      typeof handler === "function" ? Reflect.getMetadata(METHOD_METADATA, handler) : undefined;
    if (typeof handler !== "function" || typeof method !== "number") {
      return [];
    }
    const paths = [
      (Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined) ?? "/",
    ].flat();
    const interceptors = [...interceptorsOn(controller), ...interceptorsOn(handler)];
    return prefixes.flatMap((prefix) =>
      paths.map((path) => {
        const routePath = `/${prefix}/${path}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
        return {
          handler: `${controller.name}.${name}`,
          route: `${String(RequestMethod[method])} ${routePath}`,
          operationId: boundOperationId(handler),
          interceptors,
        };
      }),
    );
  });
}

/** An `APP_INTERCEPTOR` provider: a global interceptor, which runs on every route. */
interface GlobalInterceptor {
  /** `CommonModule: OpenApiValidationInterceptor`, or `ClsRootModule: useFactory clsInterceptorFactory`. */
  readonly label: string;
  readonly module: string;
  readonly how: "useClass" | "useValue" | "useExisting" | "useFactory";
  /** The class or the instance; `undefined` for a factory or a token that is no class, which the walk cannot read. */
  readonly interceptor: unknown;
  /** `ClsRootModule.clsInterceptorFactory`, for a factory or a token that is no class. */
  readonly opaque?: string;
}

function globalInterceptorsOf(graph: ModuleGraph): GlobalInterceptor[] {
  return graph.providers.flatMap(({ module, provider }): GlobalInterceptor[] => {
    if (typeof provider === "function" || provider.provide !== APP_INTERCEPTOR) {
      return [];
    }
    const known = (how: GlobalInterceptor["how"], interceptor: unknown): GlobalInterceptor => ({
      label: `${module}: ${classOf(interceptor)?.name ?? String(interceptor)}`,
      module,
      how,
      interceptor,
    });
    const opaque = (how: GlobalInterceptor["how"], name: string): GlobalInterceptor => ({
      label: `${module}: ${how} ${name}`,
      module,
      how,
      interceptor: undefined,
      opaque: `${module}.${name}`,
    });
    if ("useClass" in provider) {
      return [known("useClass", provider.useClass)];
    }
    if ("useValue" in provider) {
      return [known("useValue", provider.useValue)];
    }
    if ("useExisting" in provider) {
      const existing: unknown = provider.useExisting;
      return [
        typeof existing === "function"
          ? known("useExisting", existing)
          : opaque("useExisting", String(existing)),
      ];
    }
    return [opaque("useFactory", provider.useFactory.name || "(anonymous)")];
  });
}

/**
 * The global interceptors that a factory provides, which the walk cannot read: each was read in its package and
 * parses no body. A new factory (or a token that is no class) fails the check until someone reads what it returns
 * and lists it here, or provides the interceptor with `useClass`.
 */
const READ_INTERCEPTOR_FACTORIES: ReadonlySet<string> = new Set([
  // nestjs-cls 5.4.3, the request context (common/http/request-context.ts): returns its ClsInterceptor when
  // `interceptor.mount` is set, and a pass-through otherwise (the API does not set it); neither reads the body.
  "ClsRootModule.clsInterceptorFactory",
]);

/** The class of an interceptor given as a class or as an instance. */
function classOf(interceptor: unknown): { readonly name: string } | undefined {
  if (typeof interceptor === "function") {
    return interceptor;
  }
  return typeof interceptor === "object" && interceptor !== null ? interceptor.constructor : undefined;
}

/**
 * True for the file interceptors of @nestjs/platform-express: each is a mixin class with a random name whose
 * constructor injects the multer options (`MULTER_MODULE_OPTIONS`) and creates a multer instance from them.
 */
function isFileInterceptor(interceptor: unknown): boolean {
  const type = classOf(interceptor);
  const dependencies =
    type === undefined
      ? undefined
      : (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, type) as readonly { param: unknown }[] | undefined);
  return (dependencies ?? []).some(({ param }) => param === MULTER_OPTIONS_TOKEN);
}

/** Every way the graph lets multer parse a request body; empty when no route can reach it. */
function multipartProblems(graph: ModuleGraph): string[] {
  const problems: string[] = [];
  if (graph.modules.includes(MulterModule)) {
    problems.push("the module graph imports MulterModule, the options of the file interceptors");
  }
  for (const { module, how, interceptor, opaque } of globalInterceptorsOf(graph)) {
    if (opaque !== undefined) {
      if (!READ_INTERCEPTOR_FACTORIES.has(opaque)) {
        problems.push(
          `${opaque} (${how}) provides an APP_INTERCEPTOR the walk cannot read: provide it with useClass, or read what it returns and list it in READ_INTERCEPTOR_FACTORIES`,
        );
      }
    } else if (isFileInterceptor(interceptor)) {
      problems.push(
        `${module} provides a file interceptor as APP_INTERCEPTOR (${how}): multer would parse the multipart body of every route`,
      );
    }
  }
  for (const { handler, route, interceptors } of graph.controllers.flatMap(interceptedRoutesOf)) {
    if (interceptors.some(isFileInterceptor)) {
      problems.push(`${handler} (${route}) uses a file interceptor: multer parses its multipart body`);
    }
  }
  return problems;
}

const PLATFORM_EXPRESS = "@nestjs/platform-express";
/** The exports of @nestjs/platform-express that run multer: their files hold the package's only `require("multer")`. */
const FILE_INTERCEPTORS: ReadonlySet<string> = new Set([
  "FileInterceptor",
  "FilesInterceptor",
  "FileFieldsInterceptor",
  "AnyFilesInterceptor",
  "NoFilesInterceptor",
]);
/** multer, its multipart parser busboy, and the multer folder of @nestjs/platform-express. */
const MULTER_MODULES = /^(?:multer|busboy)(?:\/|$)|^@nestjs\/platform-express\/multer(?:\/|$)/;

/**
 * Every place in a source text that can reach multer without the module graph (an interceptor that main.ts binds
 * with `useGlobalInterceptors`, a middleware), as `<file>:<line> <what>`: a file interceptor imported or re-exported
 * from @nestjs/platform-express, the whole package (a bare, namespace or default import, `export *`, `require`,
 * `import()` or `import … = require`), or anything of multer, busboy or the package's multer folder. Type-only imports
 * load no code and are left alone.
 */
function multerImportsIn(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest);
  const found: string[] = [];
  const report = (node: ts.Node, what: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${fileName}:${line + 1} ${what}`);
  };
  /** A reference to a whole module, which reaches every export of it. */
  const whole = (node: ts.Node, how: string, specifier: string): void => {
    if (specifier === PLATFORM_EXPRESS || MULTER_MODULES.test(specifier)) {
      report(node, `${how} ${specifier}`);
    }
  };
  const named = (
    how: string,
    specifier: string,
    elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[],
  ): void => {
    for (const element of elements) {
      const name = (element.propertyName ?? element.name).text;
      const reaches =
        MULTER_MODULES.test(specifier) || (specifier === PLATFORM_EXPRESS && FILE_INTERCEPTORS.has(name));
      if (reaches && !element.isTypeOnly) {
        report(element, `${how} ${name} from ${specifier}`);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause === undefined) {
        whole(node, "imports", specifier);
      } else if (!clause.isTypeOnly) {
        if (clause.name !== undefined) {
          whole(clause.name, "imports the default export of", specifier);
        }
        if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
          whole(clause.namedBindings, "imports * from", specifier);
        } else if (clause.namedBindings !== undefined) {
          named("imports", specifier, clause.namedBindings.elements);
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
        whole(node, "re-exports * from", node.moduleSpecifier.text);
      } else {
        named("re-exports", node.moduleSpecifier.text, node.exportClause.elements);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      whole(node, "imports", node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const [argument] = node.arguments;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((dynamicImport || isRequire) && argument !== undefined && ts.isStringLiteralLike(argument)) {
        whole(node, dynamicImport ? "imports" : "requires", argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** A test-only interceptor that parses nothing. */
@Injectable()
class PassThroughInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}

/** Test-only routes with each file interceptor of @nestjs/platform-express on the handler (the walk runs none). */
@Controller("test-uploads")
class UploadsController {
  @Post("file")
  @UseInterceptors(FileInterceptor("file"))
  file(): void {}

  @Post("files")
  @UseInterceptors(PassThroughInterceptor, FilesInterceptor("files", 2))
  files(): void {}

  @Post("fields")
  @UseInterceptors(FileFieldsInterceptor([{ name: "logo" }, { name: "icon" }]))
  fields(): void {}

  @Post("any")
  @UseInterceptors(AnyFilesInterceptor())
  any(): void {}

  @Post("none")
  @UseInterceptors(NoFilesInterceptor())
  none(): void {}

  @Post("instance")
  @UseInterceptors(new (FileInterceptor("file"))())
  instance(): void {}

  @Post("json")
  @UseInterceptors(PassThroughInterceptor)
  json(): void {}

  @Get()
  list(): void {}
}

/** A test-only controller whose file interceptor covers every route. */
@Controller("test-uploads/everything")
@UseInterceptors(AnyFilesInterceptor())
class UploadEverythingController {
  @Get()
  list(): void {}

  @Post(":id")
  upload(): void {}
}

@Module({ controllers: [UploadsController, UploadEverythingController] })
class UploadRoutesModule {}

/** A test-only factory of a global interceptor, which the walk cannot read. */
const passThroughFactory = (): PassThroughInterceptor => new PassThroughInterceptor();

/** Test-only global interceptors: two file interceptors, one from an unread factory, one that parses nothing. */
@Module({
  imports: [MulterModule.register({ limits: { fileSize: 1024 } })],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: FileInterceptor("file") },
    { provide: APP_INTERCEPTOR, useValue: new (AnyFilesInterceptor())() },
    { provide: APP_INTERCEPTOR, useFactory: passThroughFactory },
    { provide: APP_INTERCEPTOR, useClass: PassThroughInterceptor },
  ],
})
class GlobalUploadsModule {}

describe("the API (startApi): no multipart route", () => {
  let api: DynamicModule;
  let graph: ModuleGraph;
  /** The sources of the build that were scanned, relative to the package (`src/main.ts`). */
  let scanned: string[];
  /** What the scan of those sources found (`multerImportsIn`). */
  let sourceProblems: string[];

  beforeAll(async () => {
    // As main.ts builds it, with development values; nothing connects, since nothing is instantiated.
    const config = parseConfig({
      ...WITHOUT_DATABASE_URL,
      DATABASE_URL: "postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis",
    });
    api = AppModule.forRoot(config, createLogger({ app: "platform-api", env: "test", level: "silent" }));
    graph = await moduleGraph(api);
    const sources = buildConfig().fileNames;
    scanned = sources.map((file) => relative(APP_DIR, file));
    sourceProblems = sources.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      // Every import the scan reports names one of these modules in a string literal, so a file that mentions none of
      // them has nothing to report and is not parsed.
      return /platform-express|multer|busboy/.test(text)
        ? multerImportsIn(relative(APP_DIR, file), text)
        : [];
    });
    // Reading the build's sources (over 200 files) takes a fraction of a second idle, several times that while the
    // other packages' tests run, so it runs here rather than inside the tests' 5 s bound; 60 s bounds it on a slow CI
    // runner.
  }, 60_000);

  it("[PBE-069 AC1] binds no file interceptor to any route of the API, so multer never parses a request body", () => {
    expect(multipartProblems(graph)).toEqual([]);
    // The walk reached every route (every documented operation is bound, none is pending: PADR-0016 item 2) and the
    // global interceptors, so the check above covered each of them.
    const pending = new Set<string>(PENDING_OPERATIONS.map(({ operationId }) => operationId));
    expect(
      graph.controllers
        .flatMap(interceptedRoutesOf)
        .map(({ operationId }) => operationId)
        .sort(),
    ).toEqual(
      platformOperations
        .map(({ operationId }) => operationId)
        .filter((operationId) => !pending.has(operationId))
        .sort(),
    );
    expect(globalInterceptorsOf(graph).map(({ label }) => label)).toEqual([
      "CommonModule: OpenApiValidationInterceptor",
      "CommonModule: IdempotencyInterceptor",
      "ClsRootModule: useFactory clsInterceptorFactory",
    ]);
  });

  it("[PBE-069 AC1] fails for a route with any file interceptor, bound on the handler or on its controller", async () => {
    const problems = multipartProblems(await moduleGraph({ module: UploadRoutesModule, imports: [api] }));

    expect(problems).toEqual([
      "UploadsController.file (POST /test-uploads/file) uses a file interceptor: multer parses its multipart body",
      "UploadsController.files (POST /test-uploads/files) uses a file interceptor: multer parses its multipart body",
      "UploadsController.fields (POST /test-uploads/fields) uses a file interceptor: multer parses its multipart body",
      "UploadsController.any (POST /test-uploads/any) uses a file interceptor: multer parses its multipart body",
      "UploadsController.none (POST /test-uploads/none) uses a file interceptor: multer parses its multipart body",
      "UploadsController.instance (POST /test-uploads/instance) uses a file interceptor: multer parses its multipart body",
      "UploadEverythingController.list (GET /test-uploads/everything) uses a file interceptor: multer parses its multipart body",
      "UploadEverythingController.upload (POST /test-uploads/everything/:id) uses a file interceptor: multer parses its multipart body",
    ]);
  });

  it("[PBE-069 AC1] fails for a global file interceptor, a global interceptor it cannot read, and MulterModule", async () => {
    const problems = multipartProblems(await moduleGraph({ module: GlobalUploadsModule, imports: [api] }));

    expect(problems).toEqual([
      "the module graph imports MulterModule, the options of the file interceptors",
      "GlobalUploadsModule provides a file interceptor as APP_INTERCEPTOR (useClass): multer would parse the multipart body of every route",
      "GlobalUploadsModule provides a file interceptor as APP_INTERCEPTOR (useValue): multer would parse the multipart body of every route",
      "GlobalUploadsModule.passThroughFactory (useFactory) provides an APP_INTERCEPTOR the walk cannot read: provide it with useClass, or read what it returns and list it in READ_INTERCEPTOR_FACTORIES",
    ]);
  });

  it("[PBE-069 AC1] imports no file interceptor, multer or busboy in the API's sources, main.ts included", () => {
    expect(sourceProblems).toEqual([]);
    // The scan read the sources of the build: main.ts, which creates and configures the application outside the
    // module graph (where `useGlobalInterceptors` or `app.use` would bind a parser), and the modules.
    expect(scanned).toEqual(
      expect.arrayContaining(["src/main.ts", "src/app.module.ts", "src/common/http/raw-body.ts"]),
    );
    expect(scanned.filter((file) => file.endsWith(".test.ts"))).toEqual([]);
  });

  it("[PBE-069 AC1] the source scan fails for every import that reaches multer and leaves type-only imports alone", () => {
    const text = [
      'import type { NestExpressApplication } from "@nestjs/platform-express";',
      'import { ExpressAdapter, type FileInterceptor as Typed } from "@nestjs/platform-express";',
      'import { AnyFilesInterceptor, type NestExpressApplication as App } from "@nestjs/platform-express";',
      'import { FileInterceptor as Upload } from "@nestjs/platform-express";',
      'import * as platform from "@nestjs/platform-express";',
      'import multer from "multer";',
      'import { FilesInterceptor } from "@nestjs/platform-express/multer";',
      'export { NoFilesInterceptor } from "@nestjs/platform-express";',
      'export * from "@nestjs/platform-express";',
      'import busboy = require("busboy");',
      'const later = () => import("@nestjs/platform-express");',
      'const parser = require("multer/lib/make-middleware");',
      'type Options = import("multer").Options;',
      'export type { FileFieldsInterceptor } from "@nestjs/platform-express";',
    ].join("\n");

    expect(multerImportsIn("src/example.ts", text)).toEqual([
      "src/example.ts:3 imports AnyFilesInterceptor from @nestjs/platform-express",
      "src/example.ts:4 imports FileInterceptor from @nestjs/platform-express",
      "src/example.ts:5 imports * from @nestjs/platform-express",
      "src/example.ts:6 imports the default export of multer",
      "src/example.ts:7 imports FilesInterceptor from @nestjs/platform-express/multer",
      "src/example.ts:8 re-exports NoFilesInterceptor from @nestjs/platform-express",
      "src/example.ts:9 re-exports * from @nestjs/platform-express",
      "src/example.ts:10 imports busboy",
      "src/example.ts:11 imports @nestjs/platform-express",
      "src/example.ts:12 requires multer/lib/make-middleware",
    ]);
  });
});
