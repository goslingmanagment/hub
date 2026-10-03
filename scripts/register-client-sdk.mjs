#!/usr/bin/env node
// H-1a: freeze one client's vendored @kernel/sdk as a test fixture and register
// it, so tests/client-sdk-compat.integration.test.ts runs that exact SDK against
// every hub candidate.
//
// Usage:
//   node scripts/register-client-sdk.mjs <client-vendor-dir> --client <name>
//     --version <v>[,<v>...] [--operations <key>[,<key>...]] [--candidate]
//   e.g. node scripts/register-client-sdk.mjs ../onlyfans-chat/packages/kernel-sdk \
//          --client onlyfans-chat --version 0.1.64
//
// <client-vendor-dir> is the directory scripts/vendor-sdk.mjs wrote in the
// client repo (kernel-sdk.vendor.json + dist/). The bundle is built from the
// file in the client's own checkout, so zod comes from the client's
// node_modules. The zod version that went into the bundle is read from the
// build metafile, must be the one the client's lockfile pins (a checkout with
// another zod installed would freeze a zod the client never shipped), and is
// recorded on the row.
//
// The fixture is content-addressed: tests/fixtures/client-sdks/<bundle12>/
// holds sdk.mjs (one ES2022 ESM file, zod inside) and the client's vendor
// manifest. The registry row keyed by the bundle's sha256 is written between
// the markers in apps/runtime/src/services/client-sdk-registry.ts. Running the
// script again for the same bundle (another client or version) merges into that
// row; a released row is never demoted to candidate.
//
// Every check runs before the first write: a refused run leaves the fixture
// directory and the registry exactly as they were.
//
// --hub-root <dir> points the script at another hub tree (tests only).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const REGISTRY_FILE = "apps/runtime/src/services/client-sdk-registry.ts";
const FIXTURE_ROOT = "tests/fixtures/client-sdks";
const BEGIN_MARKER = "// client-sdk-registry:begin";
const END_MARKER = "// client-sdk-registry:end";
const CLIENT_NAMES = new Set(["onlyfans-chat", "fansly-chat", "chat-extension"]);
const VALUE_OPTIONS = new Set(["--client", "--version", "--operations", "--hub-root"]);

function fail(message) {
  console.error(`register-client-sdk: ${message}`);
  process.exit(1);
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const list = (value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const sortedUnique = (items, compare) => [...new Set(items)].sort(compare);
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compareVersions = (a, b) => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
};

// ── Arguments ──
const positional = [];
const options = {};
let candidate = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--candidate") {
    candidate = true;
  } else if (VALUE_OPTIONS.has(arg)) {
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`${arg} needs a value`);
    options[arg] = value;
    i += 1;
  } else if (arg.startsWith("--")) {
    fail(`unknown option ${arg}`);
  } else {
    positional.push(arg);
  }
}
if (positional.length !== 1 || !options["--client"] || !options["--version"]) {
  fail("usage: register-client-sdk.mjs <client-vendor-dir> --client <name> --version <v>[,<v>] [--operations <keys>] [--candidate]");
}
const hubRoot = options["--hub-root"]
  ? resolve(process.cwd(), options["--hub-root"])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = resolve(process.cwd(), positional[0]);
const clientName = options["--client"];
if (!CLIENT_NAMES.has(clientName)) fail(`unknown client "${clientName}" (one of ${[...CLIENT_NAMES].join(", ")})`);
const versions = list(options["--version"]);
for (const version of versions) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`version "${version}" is not MAJOR.MINOR.PATCH`);
}
const operations = list(options["--operations"]);

// ── The client's vendor manifest: a clean, reproducible snapshot only ──
const manifestPath = join(vendorDir, "kernel-sdk.vendor.json");
if (!existsSync(manifestPath)) fail(`${manifestPath} not found — point at the directory vendor-sdk.mjs wrote`);
const manifestText = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
if (typeof manifest.sourceCommit === "string" && manifest.sourceCommit.endsWith("-dirty")) {
  fail(`sourceCommit ${manifest.sourceCommit} is dirty: a dirty vendor cannot be reproduced, so it is never registered`);
}
if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? "")) fail("manifest sourceCommit is not 40 hex");
if (!/^[a-f0-9]{64}$/.test(manifest.contractHash ?? "")) fail("manifest contractHash is not 64 hex");

// ── Digest of the vendored dist/ (what the client actually ships) ──
const distDir = join(vendorDir, "dist");
const distFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else distFiles.push(path);
  }
})(distDir);
const vendorDistSha256 = sha256(
  distFiles
    .map((file) => `${relative(distDir, file).split(sep).join("/")}\0${sha256(readFileSync(file))}\n`)
    .sort()
    .join(""),
);

// ── One ESM file, zod inside, resolved from the client's checkout ──
const built = await build({
  entryPoints: [join(distDir, "index.js")],
  absWorkingDir: vendorDir,
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "es2022",
  legalComments: "none",
  write: false,
  metafile: true,
  logLevel: "silent",
  banner: {
    js: `// Frozen @kernel/sdk ${manifest.contractHash} vendored from hub ${manifest.sourceCommit}.\n`
      + "// Generated by scripts/register-client-sdk.mjs — never edit.",
  },
});
const bundle = built.outputFiles[0].contents;
const bundleSha256 = sha256(bundle);
const fixture = `${FIXTURE_ROOT}/${bundleSha256.slice(0, 12)}`;
const fixtureDir = join(hubRoot, fixture);
const bundlePath = join(fixtureDir, "sdk.mjs");
if (existsSync(bundlePath) && sha256(readFileSync(bundlePath)) !== bundleSha256) {
  fail(`${fixture}/sdk.mjs exists with different bytes (12-hex prefix collision?)`);
}

// ── The zod inside the bundle, tied to the client's lockfile ──
const zodRoots = new Set();
for (const input of Object.keys(built.metafile.inputs)) {
  const at = input.lastIndexOf("node_modules/zod/");
  if (at >= 0) zodRoots.add(input.slice(0, at + "node_modules/zod".length));
}
const zodVersions = new Set([...zodRoots].map((root) => {
  const packagePath = resolve(vendorDir, root, "package.json");
  if (!existsSync(packagePath)) fail(`cannot read the bundled zod's version: ${packagePath} not found`);
  return JSON.parse(readFileSync(packagePath, "utf8")).version;
}));
if (zodVersions.size !== 1) {
  fail(`the bundle must hold exactly one zod; found ${zodVersions.size === 0 ? "none" : [...zodVersions].join(", ")}`);
}
const [zodVersion] = zodVersions;
if (typeof zodVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(zodVersion)) fail(`bundled zod version "${zodVersion}" is not MAJOR.MINOR.PATCH`);

function findLockfile(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    for (const name of ["pnpm-lock.yaml", "package-lock.json"]) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
    if (dirname(dir) === dir) return null;
  }
}
function lockfilePins(lockfile, version) {
  const text = readFileSync(lockfile, "utf8");
  if (lockfile.endsWith("package-lock.json")) {
    return Object.entries(JSON.parse(text).packages ?? {})
      .some(([key, entry]) => /(^|\/)node_modules\/zod$/.test(key) && entry?.version === version);
  }
  // pnpm: `zod@4.4.3:` (v9), `/zod@4.4.3:` (v6) or `/zod/3.22.4:` (v5), quoted or not.
  const v = escapeRegExp(version);
  return new RegExp(`^\\s*['"]?/?zod[@/]${v}(\\(.*\\))?['"]?:`, "m").test(text);
}
const lockfile = findLockfile(vendorDir);
if (!lockfile) fail(`no pnpm-lock.yaml or package-lock.json above ${vendorDir}: cannot tie the bundled zod to the client`);
if (!lockfilePins(lockfile, zodVersion)) {
  fail(`the bundle holds zod ${zodVersion} but ${lockfile} does not pin it: install the client's lockfile (pnpm install --frozen-lockfile) and rerun`);
}

// ── The bundle must load and carry the manifest's contract (from a temp copy) ──
const scratch = mkdtempSync(join(tmpdir(), "register-client-sdk-"));
let sdk;
try {
  const scratchBundle = join(scratch, "sdk.mjs");
  writeFileSync(scratchBundle, bundle);
  sdk = await import(pathToFileURL(scratchBundle).href);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (sdk.KERNEL_CONTRACT_HASH !== manifest.contractHash) {
  fail(`bundle KERNEL_CONTRACT_HASH ${sdk.KERNEL_CONTRACT_HASH} != manifest ${manifest.contractHash}`);
}
if (typeof sdk.createClient !== "function" || typeof sdk.streamAiFeature !== "function") {
  fail("bundle does not export createClient and streamAiFeature");
}
const unknownOperations = operations.filter((key) => !Object.hasOwn(sdk.kernelOperations ?? {}, key));
if (unknownOperations.length > 0) fail(`operations not in this SDK: ${unknownOperations.join(", ")}`);

// ── The next registry rows ──
const registryPath = join(hubRoot, REGISTRY_FILE);
const lines = readFileSync(registryPath, "utf8").split("\n");
const begin = lines.findIndex((line) => line.trim() === BEGIN_MARKER);
const end = lines.findIndex((line) => line.trim() === END_MARKER);
if (begin < 0 || end < begin) fail(`registry markers not found in ${REGISTRY_FILE}`);
const block = lines.slice(begin + 1, end).join("\n").trim().replace(/,$/, "");
const rows = JSON.parse(`[${block}]`);

const existing = rows.find((row) => row.bundleSha256 === bundleSha256);
if (existing && (existing.contractHash !== manifest.contractHash
  || existing.sourceCommit !== manifest.sourceCommit
  || existing.vendorDistSha256 !== vendorDistSha256
  || (existing.zodVersion !== undefined && existing.zodVersion !== zodVersion))) {
  fail(`row ${bundleSha256.slice(0, 12)} already registered with different provenance`);
}
const clients = [...(existing?.clients ?? [])];
const current = clients.find((client) => client.name === clientName);
if (current) current.versions = [...current.versions, ...versions];
else clients.push({ name: clientName, versions });
const row = {
  bundleSha256,
  contractHash: manifest.contractHash,
  sourceCommit: manifest.sourceCommit,
  vendorDistSha256,
  zodVersion,
  status: existing?.status === "released" || !candidate ? "released" : "candidate",
  clients: clients
    .map((client) => ({ name: client.name, versions: sortedUnique(client.versions, compareVersions) }))
    .sort((a, b) => byCodeUnits(a.name, b.name)),
  operations: sortedUnique([...(existing?.operations ?? []), ...operations]),
  fixture,
};
const nextRows = [...rows.filter((item) => item.bundleSha256 !== bundleSha256), row]
  .sort((a, b) => byCodeUnits(a.bundleSha256, b.bundleSha256));
const rendered = nextRows.flatMap((item) => `${JSON.stringify(item, null, 2)},`.split("\n").map((line) => `  ${line}`));

// ── All checks passed: write the fixture, then the registry ──
mkdirSync(fixtureDir, { recursive: true });
writeFileSync(bundlePath, bundle);
writeFileSync(join(fixtureDir, "kernel-sdk.vendor.json"), manifestText);
writeFileSync(registryPath, [...lines.slice(0, begin + 1), ...rendered, ...lines.slice(end)].join("\n"));

console.log(`Registered ${clientName} ${versions.join(", ")} → ${fixture}`);
console.log(`  bundle:   ${bundleSha256}`);
console.log(`  contract: ${manifest.contractHash}`);
console.log(`  source:   ${manifest.sourceCommit}`);
console.log(`  zod:      ${zodVersion} (${relative(vendorDir, lockfile) || lockfile})`);
console.log(`  status:   ${row.status}; operations: ${row.operations.length}`);
