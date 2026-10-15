// @ts-check
// Shared ESLint flat config for the whole monorepo (ADR-0002, docs/mvp/conventions.md).
// Every workspace package runs `eslint .` from its own folder; ESLint finds this file by walking up.
// Do not copy this file into packages. Do not loosen rules to get a change through (AGENTS.md §7).
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import prettierConfig from "eslint-config-prettier";
import nodePlugin from "eslint-plugin-n";
import noUnsanitized from "eslint-plugin-no-unsanitized";
import globals from "globals";
import tseslint from "typescript-eslint";

const TS_SOURCES = ["**/*.{ts,tsx,mts,cts}"];
const TYPED_SOURCES = [
  "platform/*/src/**/*.{ts,tsx}",
  "ota/*/src/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
  "platform/*/test/**/*.ts",
  "ota/*/test/**/*.ts",
  "packages/*/test/**/*.ts",
];
const NEXT_APPS = ["platform/frontend", "platform/admin", "ota/admin"];
const BROWSER_JS = ["ota/frontend/**/*.js", "ota/sdk/src/**/*.js"];
const NODE_CODE = [
  "platform/**/*.{ts,tsx,js,mjs}",
  "ota/backend/**/*.{ts,js,mjs}",
  "ota/admin/**/*.{ts,tsx}",
  "packages/**/*.{ts,js,mjs}",
];
const TESTS = ["**/*.test.{ts,tsx,js}", "**/test/**/*.{ts,tsx,js}", "**/*.e2e.ts"];

/** Restricted import patterns per area (ADR-0002 dependency rules). */
const relativeIntoPackages = {
  group: ["**/packages/*/src/**", "../../packages/**", "../../../packages/**"],
  message:
    "Import shared code by its @velexis/* package name, never by a relative path into another package.",
};
const restrict = (/** @type {Array<{group: string[], message: string}>} */ patterns) => ({
  "no-restricted-imports": ["error", { patterns: [relativeIntoPackages, ...patterns] }],
});

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/next-env.d.ts",
      "**/src/generated/**",
      "release/**",
      ".local/**",
      // Reference material is never linted or edited (decisions.md §3).
      "docs/**",
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },

  // Base JavaScript rules for every file.
  js.configs.recommended,
  {
    rules: {
      "no-console": "error",
      eqeqeq: ["error", "always"],
      "no-implicit-coercion": "error",
      "no-param-reassign": "error",
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": "error",
      curly: ["error", "all"],
    },
  },

  // TypeScript: strict rules everywhere, type-aware rules only on sources covered by a tsconfig.
  ...tseslint.configs.strict.map((c) => ({ ...c, files: TS_SOURCES })),
  {
    files: TS_SOURCES,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "error",
      // NestJS modules and DI tokens use empty classes by design.
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    files: TYPED_SOURCES,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },

  // Node code: configuration only through @velexis/config (conventions §1).
  {
    files: NODE_CODE,
    plugins: { n: nodePlugin },
    languageOptions: { globals: { ...globals.node } },
    rules: { "n/no-process-env": "error" },
  },
  {
    files: ["packages/config/**", "**/next.config.*", "**/vitest.*", "**/playwright.config.*"],
    rules: { "n/no-process-env": "off" },
  },
  {
    // Tool configuration files only, never an application source named `*.config.ts`
    // (platform/backend/src/common/http/throttler.config.ts reads its settings through @velexis/config).
    files: ["**/*.config.{ts,mjs,js}"],
    ignores: ["**/src/**"],
    rules: { "n/no-process-env": "off" },
  },

  // Dependency rules between areas (ADR-0002 §5).
  {
    files: ["packages/**"],
    rules: restrict([
      { group: ["@velexis/platform-*", "@velexis/ota-*"], message: "Packages never depend on apps." },
    ]),
  },
  {
    files: ["platform/**"],
    rules: restrict([
      {
        group: ["@velexis/ota-*"],
        message: "platform/* never imports from ota/*. Share code through packages/*.",
      },
    ]),
  },
  {
    files: ["ota/backend/**"],
    rules: restrict([
      {
        group: ["@velexis/platform-*"],
        message: "ota/* never imports from platform/*. Share code through packages/*.",
      },
    ]),
  },
  {
    files: ["ota/admin/**", "ota/frontend/**"],
    rules: restrict([
      { group: ["@velexis/platform-*"], message: "ota/* never imports from platform/*." },
      {
        group: ["@velexis/ota-backend", "@velexis/db", "@velexis/db/*", "@velexis/crypto"],
        message: "The OTA admin and the storefront reach the OTA backend only through @velexis/ota-sdk.",
      },
    ]),
  },
  {
    files: ["ota/sdk/src/**"],
    rules: {
      // The SDK has no runtime dependencies; @velexis/api-types is used in JSDoc types only (ADR-0019).
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            relativeIntoPackages,
            {
              group: ["@*", "node:*"],
              message: "The SDK has no runtime dependencies and no Node-only APIs (ADR-0019).",
            },
          ],
        },
      ],
    },
  },

  // Browser code: the storefront and the SDK never write untrusted HTML (conventions §4).
  {
    files: BROWSER_JS,
    plugins: { "no-unsanitized": noUnsanitized },
    languageOptions: { globals: { ...globals.browser }, sourceType: "module" },
    rules: {
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='fetch']",
          message: "Storefront pages call the API only through the SDK client (src/lib/client.js).",
        },
      ],
    },
  },
  { files: ["ota/sdk/src/**/*.js"], rules: { "no-restricted-syntax": "off" } },

  // Next.js apps (portal, platform admin, OTA admin).
  {
    files: NEXT_APPS.map((app) => `${app}/**/*.{ts,tsx}`),
    plugins: { "@next/next": nextPlugin },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    // Absolute paths: each app runs `eslint .` from its own folder, and the plugin resolves rootDir from the cwd.
    settings: { next: { rootDir: NEXT_APPS.map((app) => `${import.meta.dirname}/${app}`) } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },

  // Tests: never leave focused tests behind (ADR-0015).
  {
    files: TESTS,
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "it", property: "only", message: "Do not commit focused tests." },
        { object: "test", property: "only", message: "Do not commit focused tests." },
        { object: "describe", property: "only", message: "Do not commit focused tests." },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Plain Node tools and scripts may print to the console.
  {
    files: ["tools/**/*.{js,mjs,ts}", "deploy/**/*.{js,mjs}", "**/scripts/**/*.{js,mjs,ts}"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" },
  },

  // Formatting is Prettier's job: turn off every stylistic rule that conflicts with it. Keep this last.
  prettierConfig,
);
