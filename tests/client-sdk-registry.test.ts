import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLIENT_SDK_FIXTURE_ROOT,
  CLIENT_SDK_NAMES,
  CLIENT_SDK_REGISTRY,
} from "../apps/runtime/src/services/client-sdk-registry.ts";
import { COMPAT_OPERATION_EXERCISERS, laneFor, loadFrozenSdk } from "./helpers/client-sdk-compat.ts";

// H-1a: the registry of frozen client SDKs and its fixtures stay one-to-one,
// content-addressed, and exactly what scripts/register-client-sdk.mjs writes.

const repoRoot = join(import.meta.dirname, "..");
const HEX64 = /^[a-f0-9]{64}$/;
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

describe("client SDK registry", () => {
  it("pairs every row with exactly one fixture, and every fixture with a row", () => {
    const dirs = readdirSync(join(repoRoot, CLIENT_SDK_FIXTURE_ROOT)).sort();
    const fixtures = CLIENT_SDK_REGISTRY.map((row) => row.fixture);
    expect(new Set(fixtures).size).toBe(fixtures.length);
    expect(fixtures.slice().sort()).toEqual(dirs.map((dir) => `${CLIENT_SDK_FIXTURE_ROOT}/${dir}`));
    for (const row of CLIENT_SDK_REGISTRY) {
      expect(row.fixture).toBe(`${CLIENT_SDK_FIXTURE_ROOT}/${row.bundleSha256.slice(0, 12)}`);
      expect(readdirSync(join(repoRoot, row.fixture)).sort()).toEqual(["kernel-sdk.vendor.json", "sdk.mjs"]);
    }
  });

  it("keys each row by its bundle and carries the manifest's provenance", async () => {
    expect(CLIENT_SDK_REGISTRY.length).toBeGreaterThan(0);
    for (const row of CLIENT_SDK_REGISTRY) {
      expect(row.bundleSha256).toMatch(HEX64);
      expect(row.contractHash).toMatch(HEX64);
      expect(row.vendorDistSha256).toMatch(HEX64);
      expect(row.sourceCommit, "40 hex, never -dirty").toMatch(/^[a-f0-9]{40}$/);
      expect(["released", "candidate"]).toContain(row.status);
      expect(sha256(readFileSync(join(repoRoot, row.fixture, "sdk.mjs")))).toBe(row.bundleSha256);
      const manifest = JSON.parse(readFileSync(join(repoRoot, row.fixture, "kernel-sdk.vendor.json"), "utf8")) as Record<string, unknown>;
      expect(manifest).toMatchObject({ contractHash: row.contractHash, sourceCommit: row.sourceCommit });
      const sdk = await loadFrozenSdk(row);
      expect(sdk.KERNEL_CONTRACT_HASH).toBe(row.contractHash);
      for (const operation of row.operations) {
        expect(sdk.kernelOperations, `${operation} is not in this SDK`).toHaveProperty([operation]);
      }
    }
  });

  it("lists clients, versions and operations the suite can drive", () => {
    for (const row of CLIENT_SDK_REGISTRY) {
      const names = row.clients.map((client) => client.name);
      expect(names).toEqual([...new Set(names)].sort());
      for (const client of row.clients) {
        expect(CLIENT_SDK_NAMES).toContain(client.name);
        expect(client.versions.length).toBeGreaterThan(0);
        for (const version of client.versions) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        // chat-extension has no lane until H-3's narrow token: fail here, not in prod.
        expect(() => laneFor(client.name)).not.toThrow();
      }
      expect(row.operations).toEqual([...new Set(row.operations)].sort());
      for (const operation of row.operations) {
        expect(COMPAT_OPERATION_EXERCISERS, `no compat exerciser for ${operation}`).toHaveProperty([operation]);
      }
    }
  });

  it("is sorted by bundle and stays in the JSON form the register script rewrites", () => {
    const keys = CLIENT_SDK_REGISTRY.map((row) => row.bundleSha256);
    expect(keys).toEqual([...new Set(keys)].sort());
    const lines = readFileSync(join(repoRoot, "apps/runtime/src/services/client-sdk-registry.ts"), "utf8").split("\n");
    const begin = lines.findIndex((line) => line.trim() === "// client-sdk-registry:begin");
    const end = lines.findIndex((line) => line.trim() === "// client-sdk-registry:end");
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const block = lines.slice(begin + 1, end).join("\n").trim().replace(/,$/, "");
    expect(JSON.parse(`[${block}]`)).toEqual(CLIENT_SDK_REGISTRY);
  });
});
