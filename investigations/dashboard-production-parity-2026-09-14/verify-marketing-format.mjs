import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pass an existing local TypeScript module path; this script installs nothing.
const compilerPath = process.argv[2];
if (!compilerPath) throw new Error("Pass the installed TypeScript module path");
const { default: ts } = await import(pathToFileURL(resolve(compilerPath)).href);
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const sourcePath = "apps/dashboard/src/pages/OfapiMarketing.tsx";
const production = "380326368fe39a6a9d22eb73b0b955f8ecd7c3cc";
const before = execFileSync("git", ["show", `${production}:${sourcePath}`], {
  cwd: root, encoding: "utf8",
});
const after = readFileSync(resolve(root, sourcePath), "utf8");
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  removeComments: true,
};
const sha256 = value => createHash("sha256").update(value).digest("hex");

function canonical(node) {
  const children = [];
  ts.forEachChild(node, child => { children.push(canonical(child)); });
  return [node.kind, children.length ? null : node.getText(), children];
}

function emittedAst(source) {
  const result = ts.transpileModule(source, {
    fileName: sourcePath, compilerOptions, reportDiagnostics: true,
  });
  if (result.diagnostics.length) throw new Error("Transpile diagnostics were returned");
  const parsed = ts.createSourceFile("output.js", result.outputText,
    ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw new Error("Emitted JavaScript failed parsing");
  return JSON.stringify(canonical(parsed));
}

const beforeAst = emittedAst(before);
const afterAst = emittedAst(after);
if (beforeAst !== afterAst) throw new Error("Emitted JavaScript AST differs");
const receipt = {
  checkedAt: new Date().toISOString(), sourcePath, production,
  typescriptVersion: ts.version, compilerModule: resolve(compilerPath),
  compilerOptions, productionSha256: sha256(before), candidateSha256: sha256(after),
  canonicalEmittedAstSha256: sha256(afterAst), equal: true,
  comparison: "Recursive emitted-JavaScript node kinds and leaf text; positions/trivia ignored",
  scope: "Offline transpilation/AST comparison, including rendered JSX text; not a test-suite run",
};
writeFileSync(resolve(directory, "formatting-verification.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
