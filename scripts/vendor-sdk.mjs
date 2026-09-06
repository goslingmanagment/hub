#!/usr/bin/env node
// Kernel Stage 20 Task 6 / Stage 24 enabler: produce a self-contained COMPILED
// bundle of @kernel/sdk for consumption OUTSIDE this pnpm workspace (client
// repos can't resolve workspace:* deps, and shipping core's .ts source would
// subject it to the consumer's compiler flags). The script stages the runtime
// subset — sdk entrypoints + contracts (routes/sdk-runtime/cursor/policy/hash) +
// the three dependency-free shared modules — rewrites imports to relative
// paths, compiles it HERE (core's tsc, zod, @types/node), and ships js+d.ts.
// Consumers only see declarations (skipLibCheck applies), so their strictness
// flags never re-litigate core source. Only external dependency: zod.
//
// Usage: node scripts/vendor-sdk.mjs <target-dir>
//   e.g. node scripts/vendor-sdk.mjs ../of-desktop/packages/kernel-sdk
//
// The output is a generated artifact: regenerate (never hand-edit) after any
// contracts change, and commit the refresh in the consuming repo. The vendor
// manifest records the contract hash + source commit so drift CI can compare
// against core@main (stage-20 §2).

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const allowDirty = args.includes("--allow-dirty");
const targetArg = args.find((arg) => !arg.startsWith("--"));
if (!targetArg) {
  console.error("Usage: node scripts/vendor-sdk.mjs <target-dir> [--allow-dirty]");
  process.exit(1);
}
const target = resolve(process.cwd(), targetArg);

// The vendor manifest's sourceCommit is a PROVENANCE claim: "re-run the vendor
// at this commit and you get these bytes back". The script reads the WORKING
// TREE, so an uncommitted edit would otherwise ship inside an artifact stamped
// with a clean sha — a lie that only surfaces when the next clean re-vendor
// silently drops an export the clients import (#140 near-miss).
//
// The check covers the WHOLE tree, not just the staged sources: this script
// itself decides which files are copied, how their imports are rewritten and
// which compiler options produce the bytes, and package.json / pnpm-lock.yaml /
// tsconfig pin the tsc + zod that emit them. An uncommitted edit to ANY of those
// makes the artifact unreproducible from the sha, so "sources are clean" is too
// narrow a promise to keep. Refuse by default; --allow-dirty is for local
// experiments and stamps "<sha>-dirty" so the artifact can never pass as a
// snapshot.
const dirtyTree = execSync("git status --porcelain", { cwd: coreRoot }).toString().trim();
if (dirtyTree && !allowDirty) {
  console.error(
    "vendor-sdk: refusing to vendor from a dirty tree — the manifest's sourceCommit would not reproduce these bytes.\n" +
      "Commit (or stash) the working tree first, or pass --allow-dirty to stamp the artifact as dirty.\n" +
      dirtyTree,
  );
  process.exit(1);
}

/** Stage a source file with import rewrites: workspace package specifiers to
 * relative paths, and `.ts` extensions dropped (the emitted js/d.ts must use
 * extensionless relative imports for bundler-resolution consumers). */
function stageFile(sourcePath, destPath, specifierRewrites) {
  let content = readFileSync(join(coreRoot, sourcePath), "utf8");
  for (const [from, to] of specifierRewrites) {
    content = content.replaceAll(`from "${from}"`, `from "${to}"`);
  }
  content = content.replace(/(from\s+"\.[^"]*)\.ts"/g, '$1"');
  writeFileSync(destPath, content);
}

const meta = readFileSync(join(coreRoot, "packages/sdk/src/meta.ts"), "utf8");
const hashMatch = meta.match(/KERNEL_CONTRACT_HASH = "([0-9a-f]{64})"/);
if (!hashMatch) {
  console.error("KERNEL_CONTRACT_HASH not found in packages/sdk/src/meta.ts — run pnpm contracts:generate first");
  process.exit(1);
}
const contractHash = hashMatch[1];
const headCommit = execSync("git rev-parse HEAD", { cwd: coreRoot }).toString().trim();
const sourceCommit = dirtyTree ? `${headCommit}-dirty` : headCommit;

// ── Stage the source subset inside core ──
const staging = mkdtempSync(join(tmpdir(), "kernel-sdk-vendor-"));
mkdirSync(join(staging, "src/contracts"), { recursive: true });
mkdirSync(join(staging, "src/shared"), { recursive: true });

// shared subset: exactly what the contract registry reaches; every module here
// is dependency-free (or types-only on each other). ai-stop-reason carries the
// coach-chat isOutputExhausted predicate (spec §8) the contracts barrel
// re-exports so out-of-workspace consumers (the extension) can apply it.
for (const file of ["types.ts", "time.ts", "spender-retention.ts", "ai-stop-reason.ts", "ofapi-vendor-usage.ts", "ofapi-collection-registry.ts", "ofapi-extended-commands.ts", "ofapi-read-catalog.ts", "ofapi-export-profiles.ts"]) {
  stageFile(`packages/shared/src/${file}`, join(staging, `src/shared/${file}`), []);
}
writeFileSync(
  join(staging, "src/shared/index.ts"),
  'export * from "./types";\nexport * from "./time";\nexport * from "./spender-retention";\nexport * from "./ai-stop-reason";\nexport * from "./ofapi-vendor-usage";\nexport * from "./ofapi-collection-registry";\nexport * from "./ofapi-extended-commands";\nexport * from "./ofapi-read-catalog";\nexport * from "./ofapi-export-profiles";\n',
);

const toShared = [["@agency_hub_core/shared", "../shared/index"]];
for (const file of [
  // House primitives (mills, platformEnum, the error body): routes.ts and
  // routes-agent.ts both import them, so the vendored copy needs the module.
  "primitives.ts",
  "routes.ts",
  // The Agent Read Plane operations. routes.ts spreads them into routeSchemas,
  // so a vendored SDK without this file cannot compile at all.
  "routes-agent.ts",
  // Owner administration of the plane's keys (slice B). routes.ts spreads these
  // into routeSchemas too, so the same rule applies: no file, no compile.
  "routes-agent-keys.ts",
  "routes-ofapi-vendor.ts",
  "ofapi-vendor-usage.ts",
  "routes-ofapi-collection.ts",
  "ofapi-smart-links.ts",
  "ofapi-extended-commands.ts",
  "routes-ofapi-banned-words.ts",
  "routes-ofapi-read-collections.ts",
  "routes-ofapi-exports.ts",
    "routes-ofapi-media.ts",
  "sdk-runtime.ts",
  "domain-event-cursor.ts",
  "authorization-policy.ts",
  "contract-hash.ts",
  // Agent Read Plane vocabularies. The barrel re-exports all three, and this
  // staging list is a fixed whitelist — omitting a barrel dependency fails the
  // vendor compile outright (TS2307) and breaks every client re-vendor. That
  // has now happened twice, so tests/vendor-sdk-staging.test.ts DERIVES the
  // requirement from the barrel instead of pinning names one at a time.
  "agent-read-registry.ts",
  "agent-read-capabilities.ts",
  "agent-read-datasets.ts",
  "index.ts",
]) {
  stageFile(`packages/contracts/src/${file}`, join(staging, `src/contracts/${file}`), toShared);
}

const toContracts = [["@agency_hub_core/contracts", "./contracts/index"]];
for (const file of ["index.ts", "meta.ts", "operations.ts"]) {
  stageFile(`packages/sdk/src/${file}`, join(staging, `src/${file}`), toContracts);
}

// ── Compile with core's toolchain ──
writeFileSync(join(staging, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022", "DOM", "DOM.AsyncIterable"],
    module: "ESNext",
    moduleResolution: "bundler",
    types: ["node"],
    strict: true,
    declaration: true,
    outDir: "dist",
    rootDir: "src",
    skipLibCheck: true,
    esModuleInterop: true,
    isolatedModules: true,
  },
  include: ["src"],
}, null, 2));

// Resolve zod + @types/node from core's tree (pnpm layout — resolve real
// paths through a package that declares them).
writeFileSync(join(staging, "package.json"), JSON.stringify({ name: "kernel-sdk-staging", type: "module" }, null, 2));
const contractsRequire = createRequire(join(coreRoot, "packages/contracts/package.json"));
const zodDir = dirname(contractsRequire.resolve("zod/package.json"));
const rootRequire = createRequire(join(coreRoot, "package.json"));
const typesNodeDir = dirname(rootRequire.resolve("@types/node/package.json"));
cpSync(zodDir, join(staging, "node_modules/zod"), { recursive: true, dereference: true });
cpSync(typesNodeDir, join(staging, "node_modules/@types/node"), { recursive: true, dereference: true });

try {
  execSync(`${join(coreRoot, "node_modules/.bin/tsc")} -p ${staging}`, { stdio: "inherit" });
} catch {
  console.error(`\nVendor compile failed — staged sources left at ${staging} for inspection`);
  process.exit(1);
}

// ── Ship the compiled package ──
rmSync(join(target, "dist"), { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(staging, "dist"), join(target, "dist"), { recursive: true });
rmSync(staging, { recursive: true, force: true });

writeFileSync(join(target, "package.json"), JSON.stringify({
  name: "@kernel/sdk",
  version: "0.1.0",
  private: true,
  description: "Vendored kernel API client (generated by core scripts/vendor-sdk.mjs — do not edit).",
  type: "module",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
  },
  dependencies: { zod: "^4.1.5" },
}, null, 2) + "\n");

writeFileSync(join(target, "kernel-sdk.vendor.json"), JSON.stringify({
  contractHash,
  sourceCommit,
  source: "core scripts/vendor-sdk.mjs",
}, null, 2) + "\n");

writeFileSync(join(target, "README.md"), `# @kernel/sdk (vendored)

GENERATED — do not edit. This is a self-contained compiled snapshot of the
kernel SDK (\`packages/sdk\` + its contracts runtime) produced by the core
repo's \`scripts/vendor-sdk.mjs\`. Regenerate from core to update:

\`\`\`sh
# from the core repo root
node scripts/vendor-sdk.mjs <path-to-this-directory>
\`\`\`

- Contract hash: \`${contractHash}\`
- Core commit: \`${sourceCommit}\`

The contract hash is exported at runtime as \`KERNEL_CONTRACT_HASH\`; drift CI
compares it against core@main (stage-20 §2). Distribution via git-tag installs
(DP 10) replaces this vendoring at the Stage 20 release step — the consuming
import surface (\`@kernel/sdk\`) stays identical.
`);

console.log(`Vendored @kernel/sdk → ${target}`);
console.log(`  contract hash: ${contractHash}`);
console.log(`  core commit:   ${sourceCommit}`);
