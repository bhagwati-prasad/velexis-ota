// The rules of the folder src/supply/interface (OBE-110, its step 1): types and constants only (each constant plain
// data, never a function, a call or a read of the clock or the environment), no I/O, no Nest provider, and no
// supplier's name, in an exported name or anywhere in the code that ships. The test files of the
// folder may name a supplier: they compare the neutral types with today's mappers. TypeScript's parser (syntax only)
// reads each file, so the checks see what the compiler sees.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as supplyInterface from "./index";

const FOLDER = __dirname;

/** The suppliers the plan names (multi-supplier plan §1, §4.2) and the other large flight suppliers. */
const SUPPLIER_NAMES = [
  "amadeus",
  "pkfare",
  "duffel",
  "duffle",
  "sabre",
  "travelport",
  "galileo",
  "worldspan",
];
const SUPPLIER_NAME = new RegExp(SUPPLIER_NAMES.join("|"), "i");

/** Packages the folder may import, and only for their types. */
const TYPE_PACKAGES: ReadonlySet<string> = new Set(["@velexis/api-types", "@velexis/errors"]);

/** The folder's files that ship: every `.ts` file but the tests. */
function shippedFiles(): string[] {
  return readdirSync(FOLDER)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

function sourceOf(name: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    readFileSync(join(FOLDER, name), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);

/** The names a file exports by declaration (`export interface`, `export type`, `export const`). */
function declaredExports(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.push((declaration.name as ts.Identifier).text);
      }
    }
  }
  return names;
}

const isObjectFreeze = (node: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "Object" &&
  node.name.text === "freeze";

/**
 * The parts of a file's constants that are not plain data, as `file:line kind`. Plain data is a literal, an array, an
 * object of plain properties, `as` or `satisfies`, `Object.freeze(…)` of one value and another constant of the same
 * file. Anything else (a function, another call, `new`, a method or getter, a template with a value, a global such as
 * `Date` or `process`) is code or I/O, which the folder never holds.
 */
function impureValues(source: ts.SourceFile): string[] {
  const constants = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          constants.add(declaration.name.text);
        }
      }
    }
  }
  const problems: string[] = [];
  const refuse = (node: ts.Node): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    problems.push(`${source.fileName}:${line + 1} ${ts.SyntaxKind[node.kind]}`);
  };
  const check = (node: ts.Expression): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(node) && constants.has(node.text))
    ) {
      return;
    }
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
      check(node.expression);
    } else if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach(check);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)) {
          check(property.initializer);
        } else {
          refuse(property);
        }
      }
    } else if (ts.isCallExpression(node) && isObjectFreeze(node.expression) && node.arguments.length === 1) {
      check(node.arguments[0] as ts.Expression);
    } else {
      refuse(node);
    }
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer === undefined) {
          refuse(declaration);
        } else {
          check(declaration.initializer);
        }
      }
    }
  }
  return problems;
}

/** The names a file re-exports (`export { a, type B } from "./x"`). */
function reExports(source: ts.SourceFile): string[] {
  return source.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.exportClause !== undefined &&
    ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((element) => element.name.text)
      : [],
  );
}

describe("src/supply/interface", () => {
  it("has the files of the interface", () => {
    expect(shippedFiles()).toEqual(["adapter.ts", "capabilities.ts", "index.ts", "offers.ts", "outcomes.ts"]);
  });

  it.each(shippedFiles())("%s holds types and constants only", (name) => {
    const source = sourceOf(name);
    for (const statement of source.statements) {
      const kind = ts.SyntaxKind[statement.kind];
      if (ts.isVariableStatement(statement)) {
        expect(
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
          `${name}: ${kind} is const`,
        ).toBe(true);
        continue;
      }
      expect(
        ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement),
        `${name}: a ${kind} at the top level`,
      ).toBe(true);
    }
    // No decorator anywhere: no Nest provider, no class.
    const visit = (node: ts.Node): void => {
      expect(ts.isDecorator(node) || ts.isClassLike(node), `${name}: ${ts.SyntaxKind[node.kind]}`).toBe(
        false,
      );
      ts.forEachChild(node, visit);
    };
    visit(source);
    // Every constant is plain data: no function, no call but Object.freeze, no clock or environment read.
    expect(impureValues(source)).toEqual([]);
  });

  it("would see code or I/O in a constant", () => {
    const probe = (text: string): string[] =>
      impureValues(ts.createSourceFile("probe.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
    expect(
      probe(
        [
          'export const A = Object.freeze(["a", "b"] as const);',
          "export const B = Object.freeze({ a: A, n: 1, t: true, f: false, z: null, s: `x` } as const satisfies object);",
        ].join("\n"),
      ),
    ).toEqual([]);
    for (const text of [
      "export const F = (value: string): boolean => value.length > 0;",
      "export const G = Object.freeze({ check(value: string) { return value; } });",
      "export const T = Object.freeze({ at: Date.now() });",
      'export const E = Object.freeze({ home: process.env["HOME"] });',
      "export const M = new Map<string, string>();",
      "export const S = `${String(1)}`;",
      "export const U = Object.freeze([OTHER]);",
      "export const V = Object.freeze([1], [2]);",
    ]) {
      expect(probe(text), text).not.toEqual([]);
    }
  });

  it.each(shippedFiles())("%s imports types only, and nothing that does I/O", (name) => {
    for (const statement of sourceOf(name).statements) {
      if (!ts.isImportDeclaration(statement)) {
        continue;
      }
      const from = (statement.moduleSpecifier as ts.StringLiteral).text;
      const typeOnly = statement.importClause?.isTypeOnly === true;
      if (from.startsWith("./")) {
        expect(typeOnly, `${name} imports ${from} for its types`).toBe(true);
      } else if (from.startsWith("../")) {
        // Outside the folder: a type of the OTA backend, never its code.
        expect(typeOnly, `${name} imports ${from} for its types`).toBe(true);
      } else {
        expect(TYPE_PACKAGES.has(from), `${name} imports ${from}`).toBe(true);
        expect(typeOnly, `${name} imports ${from} for its types`).toBe(true);
      }
    }
  });

  it.each(shippedFiles())("%s names no supplier", (name) => {
    const lines = readFileSync(join(FOLDER, name), "utf8").split("\n");
    const named = lines.flatMap((line, index) => (SUPPLIER_NAME.test(line) ? [`${name}:${index + 1}`] : []));
    expect(named).toEqual([]);
  });

  it("exports every name of its files through index.ts, and no exported name contains a supplier's name", () => {
    const declared = shippedFiles()
      .filter((name) => name !== "index.ts")
      .flatMap((name) => declaredExports(sourceOf(name)));
    const exported = reExports(sourceOf("index.ts"));
    expect([...exported].sort()).toEqual([...declared].sort());
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.filter((name) => SUPPLIER_NAME.test(name))).toEqual([]);
    expect(Object.keys(supplyInterface).filter((name) => SUPPLIER_NAME.test(name))).toEqual([]);
  });

  it("would see a supplier's name in an exported name or a line", () => {
    for (const name of SUPPLIER_NAMES) {
      const capitalised = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      expect(SUPPLIER_NAME.test(`type ${capitalised}Offer = unknown;`), name).toBe(true);
      expect(SUPPLIER_NAME.test(`${name.toUpperCase()}_OUTCOMES`), name).toBe(true);
    }
    expect(SUPPLIER_NAME.test("supplierOfferRef")).toBe(false);
  });
});
