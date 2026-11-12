#!/usr/bin/env node
// Vendor Hub's look (packages/look: token values, formats, the dictionary) into
// a client as a compiled, dependency-free `@hub/look` package: the same contract
// as scripts/vendor-hotkeys.mjs and vendor-sdk.mjs. Compile HERE with Hub's tsc,
// ship js + d.ts, the values as tokens.json and Workboard's CSS copy, and stamp
// a manifest the client can verify.
//
// Usage: node scripts/vendor-look.mjs <target-dir> [--allow-dirty]
//   e.g. node scripts/vendor-look.mjs ../chat-extension/vendor/hub-look
//        node scripts/vendor-look.mjs ../contentops/vendor/hub-look
//        node scripts/vendor-look.mjs ../taskindex/vendor/hub-look
//
// The look reads three dependency-free modules of packages/shared (money, time,
// types): they are staged beside it, so the copy imports nothing from outside.
// Every client vendors from the same clean hub commit; the manifest's sha256
// says whether two clients carry the same look.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lookRoot = join(coreRoot, "packages/look");
const args = process.argv.slice(2);
const allowDirty = args.includes("--allow-dirty");
const targetArg = args.find((arg) => !arg.startsWith("--"));
if (!targetArg) {
  console.error("Usage: node scripts/vendor-look.mjs <target-dir> [--allow-dirty]");
  process.exit(1);
}
const target = resolve(process.cwd(), targetArg);

// Same provenance rule as vendor-sdk.mjs: the manifest's sourceCommit must
// reproduce these bytes, so a dirty tree is refused (or stamped "-dirty").
const dirtyTree = execSync("git status --porcelain", { cwd: coreRoot }).toString().trim();
if (dirtyTree && !allowDirty) {
  console.error(
    "vendor-look: refusing to vendor from a dirty tree: the manifest's sourceCommit would not reproduce these bytes.\n" +
      "Commit (or stash) the working tree first, or pass --allow-dirty to stamp the artifact as dirty.\n" +
      dirtyTree,
  );
  process.exit(1);
}
const headCommit = execSync("git rev-parse HEAD", { cwd: coreRoot }).toString().trim();
const sourceCommit = dirtyTree ? `${headCommit}-dirty` : headCommit;

// ── Stage: the look's sources, and the shared modules it reads, as relative `.js` imports ──
const SHARED_FILES = ["money.ts", "time.ts", "types.ts"];
const staging = mkdtempSync(join(tmpdir(), "hub-look-vendor-"));
mkdirSync(join(staging, "src/shared"), { recursive: true });
for (const file of readdirSync(join(lookRoot, "src"))) {
  if (!file.endsWith(".ts")) continue;
  const content = readFileSync(join(lookRoot, "src", file), "utf8")
    .replaceAll('from "@agency_hub_core/shared"', 'from "./shared/index.js"')
    .replace(/(from\s+"\.[^"]*)\.ts"/g, '$1.js"');
  if (/(from|import)\s*\(?\s*"@agency_hub_core\//.test(content)) {
    console.error(`vendor-look: packages/look/src/${file} imports another workspace package; only @agency_hub_core/shared (${SHARED_FILES.join(", ")}) is staged.`);
    process.exit(1);
  }
  writeFileSync(join(staging, "src", file), content);
}
for (const file of SHARED_FILES) {
  const content = readFileSync(join(coreRoot, "packages/shared/src", file), "utf8").replace(/(from\s+"\.[^"]*)\.ts"/g, '$1.js"');
  writeFileSync(join(staging, "src/shared", file), content);
}
writeFileSync(join(staging, "src/shared/index.ts"), SHARED_FILES.map((file) => `export * from "./${file.replace(/\.ts$/, ".js")}";\n`).join(""));
writeFileSync(join(staging, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022"],
    module: "ESNext",
    moduleResolution: "bundler",
    types: [],
    strict: true,
    declaration: true,
    outDir: "dist",
    rootDir: "src",
    skipLibCheck: true,
    isolatedModules: true,
  },
  include: ["src"],
}, null, 2));
writeFileSync(join(staging, "package.json"), JSON.stringify({ name: "hub-look-staging", type: "module" }, null, 2));

const tsc = join(dirname(createRequire(join(coreRoot, "package.json")).resolve("typescript/package.json")), "bin/tsc");
try {
  execSync(`node ${tsc} -p ${staging}`, { stdio: "inherit" });
} catch {
  console.error(`\nVendor compile failed: staged sources left at ${staging} for inspection`);
  process.exit(1);
}

// ── The values as data and Workboard's CSS copy, from the compiled module itself ──
const look = await import(pathToFileURL(join(staging, "dist/index.js")).href);
const tokensJson = `${JSON.stringify(look.TOKENS, null, 2)}\n`;
const uiCss = [
  "/*",
  " * Vendored from Hub (packages/look, scripts/vendor-look.mjs): do not edit.",
  " * Hub's token values as `--ui-*` custom properties, light and dark through light-dark().",
  " */",
  look.renderUiTokensCss().replace(/^\/\*[\s\S]*?\*\/\n/, ""),
].join("\n");

// ── Ship ──
for (const part of ["dist", "css"]) rmSync(join(target, part), { recursive: true, force: true });
mkdirSync(join(target, "css"), { recursive: true });
cpSync(join(staging, "dist"), join(target, "dist"), { recursive: true });
rmSync(staging, { recursive: true, force: true });
writeFileSync(join(target, "tokens.json"), tokensJson);
writeFileSync(join(target, "css/ui-tokens.css"), uiCss);

writeFileSync(join(target, "package.json"), `${JSON.stringify({
  name: "@hub/look",
  version: look.LOOK_VERSION,
  private: true,
  description: "Vendored Hub look: token values, formats, the dictionary (generated by hub scripts/vendor-look.mjs: do not edit).",
  type: "module",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
    "./tokens.json": "./tokens.json",
    "./css/ui-tokens.css": "./css/ui-tokens.css",
  },
}, null, 2)}\n`);
writeFileSync(join(target, "README.md"), [
  "# @hub/look (vendored)",
  "",
  "Generated by hub `scripts/vendor-look.mjs` from `packages/look`: do not edit. What is inside and why: that",
  "package's README in the hub repo. Re-vendor from a clean hub commit; the manifest's sha256 says whether two",
  "clients carry the same look.",
  "",
  "- `import { formatMills, formatDateTimeMsk, WORDS, COLORS } from \"@hub/look\"`: formats, words, values.",
  "- `tokens.json`: every value as data (colours as `[light, dark]`).",
  "- `css/ui-tokens.css`: the values as Hub's `--ui-*` custom properties.",
  "",
].join("\n"));

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
const files = {};
for (const path of [...listFiles(join(target, "dist")), ...listFiles(join(target, "css")), join(target, "tokens.json")].sort()) {
  files[relative(target, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
}
const sha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
writeFileSync(join(target, "hub-look.vendor.json"), `${JSON.stringify({
  lookVersion: look.LOOK_VERSION,
  sha256,
  sourceCommit,
  source: "hub scripts/vendor-look.mjs",
  files,
}, null, 2)}\n`);

console.log(`vendored @hub/look v${look.LOOK_VERSION} (sha256 ${sha256.slice(0, 12)}…) → ${target}`);
