import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// The integration fingerprint may omit dashboard src/public only while the
// backend, integration tests and their helpers do not consume those paths.
// All these files, including this pin, remain fingerprint inputs. If a new
// dependency is intentional, restore its inputs to the integration fingerprint.
// This is a source-boundary ratchet, not a claim to solve arbitrary dynamic JS.
function dashboardDependencies(source: string, filename: string): string[] {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(parsed);

  const staticText = (node: ts.Node | undefined, seen = new Set<string>()): string => {
    if (!node) return "?";
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return "?";
      const next = new Set(seen).add(node.text);
      return staticText(bindings.get(node.text), next);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return staticText(node.expression, seen);
    }
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans.map(span => staticText(span.expression, seen) + span.literal.text).join("");
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return staticText(node.left, seen) + staticText(node.right, seen);
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      if (name === "join" || name === "resolve") {
        if (ts.isPropertyAccessExpression(node.expression) && ts.isArrayLiteralExpression(node.expression.expression)) {
          return node.expression.expression.elements.map(item => staticText(item, seen)).join(staticText(node.arguments[0], seen));
        }
        return node.arguments.map(item => staticText(item, seen)).join("/");
      }
    }
    return "?";
  };

  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    const text = staticText(node).replaceAll("\\", "/");
    // Inspect expressions, not comments; direct/relative imports, @/ aliases,
    // URL literals, concatenation and path.join/resolve fragments all count.
    if (text.startsWith("@/") || /(?:^|\/)dashboard\/(?:src|public)(?:\/|$)/.test(text)) {
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      hits.add(`${filename}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...hits];
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", "dist", ".git"].includes(entry.name)) return [];
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(name);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [name] : [];
  });
}

describe("CI backend integration dependency boundary", () => {
  it.each([
    'import { x } from "../apps/dashboard/src/lib/x.ts";',
    'export { x } from "../../dashboard/src/lib/x.ts";',
    'await import("@/lib/x");',
    'require("@/lib/x");',
    'readFileSync(new URL("../apps/dashboard/public/input.json", import.meta.url));',
    'readFileSync(path.join(root, "apps", "dashboard", "src", "input.ts"));',
    'readFileSync(resolve("apps", "dashboard", "public", "input.json"));',
    'const area = "public"; const file = path.join(root, "apps", "dashboard", area, "input.json"); readFileSync(file);',
    'const area = "dashboard"; const file = `${root}/apps/${area}/src/input.ts`; readFile(file);',
    'const file = "apps/" + "dashboard/" + "src/input.ts"; readFile(file);',
    'readFile(["apps", "dashboard", "public", "input.json"].join("/"));',
    'const self = self; const file = path.join(self, "apps", "dashboard", "src", "x.ts");',
  ])("rejects a dependency on an omitted dashboard input: %s", source => {
    expect(dashboardDependencies(source, "boundary-fixture.ts").length).toBeGreaterThan(0);
  });

  it.each([
    'import { db } from "@agency_hub_core/db";',
    'readFileSync(path.join(root, "apps", "dashboard", "dist", "index.html"));',
    'readFileSync("apps/dashboard/package.json");',
    'readFileSync("apps/dashboard/index.html");',
    '// Documentation refers to apps/dashboard/src/lib/x.ts, but no input is read.\nexport const x = 1;',
  ])("permits inputs that stay fingerprinted and comments: %s", source => {
    expect(dashboardDependencies(source, "boundary-fixture.ts")).toEqual([]);
  });

  it("backend, integration specs and helpers do not consume omitted dashboard inputs", () => {
    const testInputs = sourceFiles("tests").filter(file =>
      file.endsWith(".integration.test.ts") || file.startsWith(`tests${path.sep}helpers${path.sep}`)
      || ["tests/schema-guard.test.ts", "tests/http-client.test.ts", "tests/network.test.ts"].includes(file),
    );
    const backendInputs = [...sourceFiles("apps/runtime"), ...sourceFiles("packages")];
    const violations = [...backendInputs, ...testInputs].flatMap(file =>
      dashboardDependencies(readFileSync(file, "utf8"), file),
    );
    expect(violations).toEqual([]);
  });
});
