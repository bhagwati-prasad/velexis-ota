// Vitest for the platform backend (README §8): unit tests next to the code (`src/**/*.test.ts`) and contract tests
// (`test/contract/**/*.test.ts`: the OpenAPI document, migration files, route parity, …), none of which needs a
// service. The integration tests (`test/integration`, PostgreSQL and Redis) run with vitest.int.config.ts through
// `pnpm test:int`.
//
// NestJS resolves constructor dependencies from TypeScript's decorator metadata (`emitDecoratorMetadata`). esbuild,
// Vite's default TypeScript transform, does not emit it, so the plugin below compiles the package's TypeScript files
// with the TypeScript compiler and the options of tsconfig.json instead: the tests run the same decorator output as
// the `tsc` build of dist/, without another dependency.
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { defineConfig, type Plugin } from "vitest/config";

const PACKAGE_DIR = fileURLToPath(new URL(".", import.meta.url));

/** The compiler options of tsconfig.json, emitting ES modules with source maps for Vite. */
function compilerOptions(): ts.CompilerOptions {
  const file = ts.findConfigFile(PACKAGE_DIR, (path) => ts.sys.fileExists(path), "tsconfig.json");
  if (file === undefined) {
    throw new Error(`vitest.config.ts: no tsconfig.json in ${PACKAGE_DIR}`);
  }
  const { config, error } = ts.readConfigFile(file, (path) => ts.sys.readFile(path));
  if (error !== undefined) {
    throw new Error(`vitest.config.ts: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
  }
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, PACKAGE_DIR);
  return {
    ...options,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: false,
    sourceMap: true,
    inlineSourceMap: false,
    inlineSources: true,
    declaration: false,
    declarationMap: false,
  };
}

/** Compiles the package's `.ts` files with `ts.transpileModule`, which emits decorator metadata as `tsc` does. */
export function typescriptWithDecoratorMetadata(): Plugin {
  const options = compilerOptions();
  return {
    name: "velexis:typescript-decorator-metadata",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?", 1)[0] ?? id;
      if (!file.endsWith(".ts") || file.includes("/node_modules/")) {
        return null;
      }
      const output = ts.transpileModule(code, { compilerOptions: options, fileName: file });
      return {
        // Vite takes the map from `map`; the comment would point at a file that does not exist.
        code: output.outputText.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n"),
        map: output.sourceMapText ?? null,
      };
    },
  };
}

export default defineConfig({
  // TypeScript is compiled by the plugin above; esbuild would drop the decorator metadata.
  esbuild: false,
  plugins: [typescriptWithDecoratorMetadata()],
  test: {
    name: "@velexis/platform-backend",
    include: ["src/**/*.test.ts", "test/contract/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
