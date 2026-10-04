import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// H-1a: scripts/register-client-sdk.mjs against a scratch hub tree and a fake
// client vendor dir. A refused run writes nothing; a rerun is byte-identical;
// a released row is never demoted; the bundled zod must be the lockfile's.

const SCRIPT = join(import.meta.dirname, "../scripts/register-client-sdk.mjs");
const REGISTRY = "apps/runtime/src/services/client-sdk-registry.ts";
const FIXTURES = "tests/fixtures/client-sdks";
const CONTRACT = "c".repeat(64);
const SOURCE = "a".repeat(40);
const EMPTY_REGISTRY = [
  "export const CLIENT_SDK_REGISTRY = [",
  "  // client-sdk-registry:begin",
  "  // client-sdk-registry:end",
  "];",
  "",
].join("\n");

let scratch = "";
let hubRoot = "";
let vendorDir = "";

function writeVendor(input: { sourceCommit?: string; contractHash?: string; bundledContract?: string; zod?: string; lockedZod?: string } = {}) {
  const clientRoot = join(scratch, "client");
  vendorDir = join(clientRoot, "packages/kernel-sdk");
  rmSync(clientRoot, { recursive: true, force: true });
  mkdirSync(join(vendorDir, "dist"), { recursive: true });
  mkdirSync(join(clientRoot, "node_modules/zod"), { recursive: true });
  writeFileSync(join(vendorDir, "kernel-sdk.vendor.json"), `${JSON.stringify({
    contractHash: input.contractHash ?? CONTRACT,
    sourceCommit: input.sourceCommit ?? SOURCE,
    source: "core scripts/vendor-sdk.mjs",
  }, null, 2)}\n`);
  writeFileSync(join(vendorDir, "dist/index.js"), [
    `import { z } from "zod";`,
    `export const KERNEL_CONTRACT_HASH = ${JSON.stringify(input.bundledContract ?? input.contractHash ?? CONTRACT)};`,
    `export const kernelOperations = { me: { method: "GET", path: "/api/v1/me" }, pages: { method: "GET", path: "/api/v1/pages" } };`,
    `export const schema = z;`,
    `export function createClient() { return {}; }`,
    `export function streamAiFeature() { return {}; }`,
    "",
  ].join("\n"));
  const zod = input.zod ?? "4.4.3";
  writeFileSync(join(clientRoot, "node_modules/zod/package.json"), JSON.stringify({ name: "zod", version: zod, main: "index.js" }));
  writeFileSync(join(clientRoot, "node_modules/zod/index.js"), `export const z = { fake: ${JSON.stringify(zod)} };\n`);
  writeFileSync(join(clientRoot, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    "packages:",
    "",
    `  zod@${input.lockedZod ?? zod}:`,
    "    resolution: {integrity: sha512-fake}",
    "",
  ].join("\n"));
}

function register(...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, vendorDir, "--hub-root", hubRoot, ...args], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

function registryText() {
  return readFileSync(join(hubRoot, REGISTRY), "utf8");
}

function rows(): Array<Record<string, unknown>> {
  const lines = registryText().split("\n");
  const begin = lines.findIndex((line) => line.trim() === "// client-sdk-registry:begin");
  const end = lines.findIndex((line) => line.trim() === "// client-sdk-registry:end");
  return JSON.parse(`[${lines.slice(begin + 1, end).join("\n").trim().replace(/,$/, "")}]`) as Array<Record<string, unknown>>;
}

function fixtureDirs() {
  return existsSync(join(hubRoot, FIXTURES)) ? readdirSync(join(hubRoot, FIXTURES)) : [];
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "register-client-sdk-test-"));
  hubRoot = join(scratch, "hub");
  mkdirSync(join(hubRoot, "apps/runtime/src/services"), { recursive: true });
  writeFileSync(join(hubRoot, REGISTRY), EMPTY_REGISTRY);
  writeVendor();
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("register-client-sdk.mjs", () => {
  it("registers a clean vendor: one row, one fixture, zod from the lockfile", () => {
    expect(register("--client", "onlyfans-chat", "--version", "0.1.64", "--operations", "pages")).toMatchObject({ status: 0 });
    const [row] = rows();
    expect(row).toMatchObject({
      contractHash: CONTRACT,
      sourceCommit: SOURCE,
      zodVersion: "4.4.3",
      status: "released",
      clients: [{ name: "onlyfans-chat", versions: ["0.1.64"] }],
      operations: ["pages"],
    });
    expect(fixtureDirs()).toEqual([(row!.bundleSha256 as string).slice(0, 12)]);
    expect(readdirSync(join(hubRoot, row!.fixture as string)).sort()).toEqual(["kernel-sdk.vendor.json", "sdk.mjs"]);
  });

  it("rewrites byte-identically on a rerun", () => {
    expect(register("--client", "fansly-chat", "--version", "2.7.1")).toMatchObject({ status: 0 });
    const registry = registryText();
    const [row] = rows();
    const bundle = readFileSync(join(hubRoot, row!.fixture as string, "sdk.mjs"));
    expect(register("--client", "fansly-chat", "--version", "2.7.1")).toMatchObject({ status: 0 });
    expect(registryText()).toBe(registry);
    expect(readFileSync(join(hubRoot, row!.fixture as string, "sdk.mjs")).equals(bundle)).toBe(true);
  });

  it("merges clients into the bundle's row and never demotes a released row", () => {
    expect(register("--client", "onlyfans-chat", "--version", "0.1.64", "--candidate")).toMatchObject({ status: 0 });
    expect(rows()).toMatchObject([{ status: "candidate" }]);
    expect(register("--client", "fansly-chat", "--version", "2.7.1,2.6.0")).toMatchObject({ status: 0 });
    expect(register("--client", "fansly-chat", "--version", "2.7.0", "--candidate")).toMatchObject({ status: 0 });
    expect(rows()).toMatchObject([{
      status: "released",
      clients: [
        { name: "fansly-chat", versions: ["2.6.0", "2.7.0", "2.7.1"] },
        { name: "onlyfans-chat", versions: ["0.1.64"] },
      ],
    }]);
  });

  it.each([
    ["a dirty vendor", { sourceCommit: `${SOURCE}-dirty` }, [], /dirty/],
    ["a bundle whose contract hash is not the manifest's", { bundledContract: "d".repeat(64) }, [], /KERNEL_CONTRACT_HASH/],
    ["an operation the SDK lacks", {}, ["--operations", "bogusOp"], /operations not in this SDK: bogusOp/],
    ["a zod the lockfile does not pin", { zod: "4.4.4", lockedZod: "4.4.3" }, [], /does not pin it/],
  ] as const)("refuses %s and writes nothing", (_name, vendor, extra, message) => {
    writeVendor(vendor);
    const result = register("--client", "onlyfans-chat", "--version", "0.1.64", ...extra);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(fixtureDirs()).toEqual([]);
    expect(registryText()).toBe(EMPTY_REGISTRY);
  });

  it("refuses a second registration of the same bundle with other provenance", () => {
    expect(register("--client", "onlyfans-chat", "--version", "0.1.64")).toMatchObject({ status: 0 });
    const registry = registryText();
    const row = rows()[0]!;
    writeFileSync(join(hubRoot, REGISTRY), registry.replace(SOURCE, "b".repeat(40)));
    const tampered = registryText();
    const result = register("--client", "fansly-chat", "--version", "2.7.1");
    expect(result).toMatchObject({ status: 1, stderr: expect.stringMatching(/different provenance/) });
    expect(registryText()).toBe(tampered);
    expect(fixtureDirs()).toEqual([(row.bundleSha256 as string).slice(0, 12)]);
  });
});
