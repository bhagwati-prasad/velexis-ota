// No form in the OTA admin has a card-number field (OAD-008 AC2; OADR-0018 point 8, README §10): the admin is built with
// its own Next.js, and the built pages are searched for a card field. A copy of the app's `src/` (without its tests) is
// built in the git-ignored `.next/cache`, so the test never replaces the app's own `.next` (a `pnpm build` or a running
// `next start` keeps its output). The copy's configuration differs from next.config.ts only in what does not change
// the pages: no ESLint and no type check during the build (`pnpm lint` and `pnpm typecheck` run them) and no standalone
// trace (`pnpm build` checks it).
//
// What counts as a card field, in every built page (the server's page and chunk files, its prerendered HTML and the
// browser's chunks):
// - an HTML autofill token of a payment card (`cc-number`, `cc-csc`, `cc-exp`, `cc-name`, …): browsers fill card data
//   into such a field;
// - a form control attribute (`name`, `id`, `autoComplete`) whose whole value names a card field (`cardNumber`, `cvc`,
//   `securityCode`, `holderName`, `expiryDate`, `creditCard`, `pan`, …);
// - in the browser's chunks, where every interactive form of the admin lives, any string that is such a name or a card
//   form's label ("Card number", "Security code", "CVC", "Cardholder", "Expiry date"). The server's chunks hold the
//   SDK's and the logger's lists of card keys (they keep card data out of errors and logs), so this last rule reads the
//   browser's chunks only; the server's forms are covered by the first two.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const SRC_DIR = join(APP_DIR, "src");

/** The whole value of an attribute or a string that names a card field. */
const CARD_FIELD_NAME =
  /^(?:card[-_ ]?(?:number|no|num|holder|cvc|cvv|code|expiry|exp|name)?|cc[-_ ]?(?:number|num|name|csc|cvc|cvv|exp(?:[-_ ]?(?:month|year|date))?|type)|cvc2?|cvv2?|csc|security[-_ ]?code|holder[-_ ]?name|name[-_ ]?on[-_ ]?card|exp(?:iry|iration)?[-_ ]?(?:date|month|year)|credit[-_ ]?card(?:[-_ ]?number)?|pan)$/i;
/** The label of a card form's field, anywhere in a string. */
const CARD_FIELD_LABEL =
  /card ?number|security code|\bcvc\b|\bcvv\b|card ?holder|name on (?:the )?card|expiry date|expiration date|\bexpiry\b|valid (?:thru|through|until)/i;
/** An HTML autofill token of a payment card (HTML Living Standard, "Autofill"), quoted as code or markup writes it. */
const CARD_AUTOFILL =
  /["'`]cc-(?:name|given-name|additional-name|family-name|number|exp|exp-month|exp-year|csc|type)["'`]/g;
/** A form control attribute with a literal value: `name:"…"` in JSX output, `name="…"` in markup. */
const CONTROL_ATTRIBUTE = /\b(?:name|id|autoComplete|autocomplete)\s*[:=]\s*(["'`])([^"'`]*)\1/g;
/** String literals of minified code (double, single and template quotes). */
const STRING_LITERAL = /"((?:[^"\\\n]|\\.){0,400})"|'((?:[^'\\\n]|\\.){0,400})'|`((?:[^`\\]|\\.){0,400})`/g;

/** One problem found in a built file. */
interface Finding {
  readonly file: string;
  readonly rule: "autofill" | "attribute" | "browser string";
  readonly text: string;
}

/** The card fields in the text of one built file; `browser`: a chunk the browser loads. */
function cardFieldsIn(file: string, text: string, browser: boolean): Finding[] {
  const findings: Finding[] = [];
  for (const match of text.matchAll(CARD_AUTOFILL)) {
    findings.push({ file, rule: "autofill", text: match[0] });
  }
  for (const match of text.matchAll(CONTROL_ATTRIBUTE)) {
    const value = match[2] ?? "";
    if (CARD_FIELD_NAME.test(value) || /^cc-/i.test(value)) {
      findings.push({ file, rule: "attribute", text: match[0] });
    }
  }
  if (browser) {
    for (const match of text.matchAll(STRING_LITERAL)) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      if (CARD_FIELD_NAME.test(value) || CARD_FIELD_LABEL.test(value)) {
        findings.push({ file, rule: "browser string", text: value.slice(0, 120) });
      }
    }
  }
  return findings;
}

/** Every file under `dir`. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** The output and exit code of `next build`. */
interface BuildResult {
  readonly code: number | null;
  readonly output: string;
}

/** Runs `next build` in `dir` with the app's own Next.js and collects stdout and stderr. */
function nextBuild(dir: string): Promise<BuildResult> {
  const nextBin = createRequire(join(APP_DIR, "package.json")).resolve("next/dist/bin/next");
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [nextBin, "build"], {
      cwd: dir,
      // A clean environment: the build reads no configuration (src/config.ts reads it per request), and telemetry is off.
      env: { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", rejectBuild);
    child.on("close", (code) => resolveBuild({ code, output }));
  });
}

/** A copy of the app to build: `src/` without tests, the PostCSS configuration and a build configuration. */
function copyApp(dir: string): void {
  cpSync(SRC_DIR, join(dir, "src"), {
    recursive: true,
    filter: (source) => !/\.test\.tsx?$/.test(source) && relative(SRC_DIR, source).split(sep)[0] !== "test",
  });
  cpSync(join(APP_DIR, "postcss.config.mjs"), join(dir, "postcss.config.mjs"));
  writeFileSync(
    join(dir, "next.config.mjs"),
    [
      "// Built by src/app/built-pages.test.ts: next.config.ts without the build-time checks and the standalone trace.",
      "export default {",
      "  poweredByHeader: false,",
      "  reactStrictMode: true,",
      '  experimental: { serverActions: { bodySizeLimit: "2mb" } },',
      "  typescript: { ignoreBuildErrors: true },",
      "  eslint: { ignoreDuringBuilds: true },",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "dom.iterable", "ES2023"],
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "preserve",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          isolatedModules: true,
          incremental: false,
          paths: { "@/*": ["./src/*"] },
        },
        include: ["**/*.ts", "**/*.tsx"],
        exclude: ["node_modules", ".next"],
      },
      null,
      2,
    )}\n`,
  );
}

describe("the built OTA admin", () => {
  let copy: string | undefined;
  let build: BuildResult = { code: null, output: "the build did not run" };
  let pages: { readonly file: string; readonly text: string; readonly browser: boolean }[] = [];

  beforeAll(async () => {
    // Budget: one production `next build` of the whole admin without lint and type check: about 40 s alone on four
    // cores and 150 s beside the other packages of `pnpm test` (four at a time), so 10 minutes leave room for a
    // two-core CI runner (the hook's budget, never a test's own timeout). Inside the app's git-ignored .next/cache, so
    // `next`, `react` and the workspace packages resolve from ota/admin/node_modules.
    const cacheDir = join(APP_DIR, ".next", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const dir = mkdtempSync(join(cacheDir, "oad-008-built-pages-"));
    copy = dir;
    copyApp(dir);
    build = await nextBuild(dir);
    if (build.code === 0) {
      const out = join(dir, ".next");
      pages = [
        ...filesUnder(join(out, "server"))
          .filter((file) => /\.(?:js|html|rsc|body)$/.test(file))
          .map((file) => ({ file, browser: false })),
        ...filesUnder(join(out, "static"))
          .filter((file) => file.endsWith(".js"))
          .map((file) => ({ file, browser: true })),
      ].map(({ file, browser }) => ({
        file: relative(out, file),
        text: readFileSync(file, "utf8"),
        browser,
      }));
    }
  }, 600_000);

  afterAll(() => {
    // Nothing to remove when the hook failed before the copy was made (its error is the report then).
    if (copy !== undefined) {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("[OAD-008 AC2] no built page has a card-number field: no card autofill, field name or label", () => {
    // The tail of the build's output when it failed, so the reason is in the report.
    expect(build.code, build.output.slice(-4000)).toBe(0);

    const browser = pages.filter((page) => page.browser);
    const bookingPage = pages.filter((page) => page.file.includes(`bookings${sep}[bookingId]${sep}page`));
    // The search covered the admin's forms: the server's booking page and the browser's chunks with the dialogs.
    expect(bookingPage.some((page) => !page.browser)).toBe(true);
    expect(bookingPage.some((page) => page.browser)).toBe(true);
    const browserText = browser.map((page) => page.text).join("\n");
    for (const marker of [
      '"actionKey"',
      "Issue tickets",
      "Cancel the booking",
      "Reason category",
      "Add note",
    ]) {
      expect(browserText, marker).toContain(marker);
    }
    const attributes = pages.reduce(
      (count, page) => count + [...page.text.matchAll(CONTROL_ATTRIBUTE)].length,
      0,
    );
    expect(attributes).toBeGreaterThan(100);

    expect(pages.flatMap((page) => cardFieldsIn(page.file, page.text, page.browser))).toEqual([]);
  });

  it("the search finds a card field, as built code would carry one", () => {
    // Negative controls of the rules above, in the shapes of minified React output and server-rendered markup.
    expect(
      cardFieldsIn("a.js", '(0,n.jsx)("input",{name:"cardNumber",autoComplete:"cc-number"})', false),
    ).toEqual([
      { file: "a.js", rule: "autofill", text: '"cc-number"' },
      { file: "a.js", rule: "attribute", text: 'name:"cardNumber"' },
      { file: "a.js", rule: "attribute", text: 'autoComplete:"cc-number"' },
    ]);
    expect(
      cardFieldsIn("b.html", '<input id="cvc" name="security_code" inputmode="numeric">', false),
    ).toHaveLength(2);
    expect(
      cardFieldsIn("c.js", 'e.label="Card number",t=`Expiry date (${m})`,r=["pan"]', true).map(
        (found) => found.text,
      ),
    ).toEqual(["Card number", "Expiry date (${m})", "pan"]);
    // What the admin rightly has stays out: a meta tag's name, an error class, React's timers, a hidden key.
    expect(
      cardFieldsIn(
        "d.js",
        '{name:"twitter:card"},o.name="ExpiredError",e.expirationTimes=1,{type:"hidden",name:"actionKey"},"touch-pan"',
        true,
      ),
    ).toEqual([]);
  });
});
