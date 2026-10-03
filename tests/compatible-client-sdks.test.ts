import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { KERNEL_CONTRACT_HASH, healthResponseSchema, routeSchemas } from "@agency_hub_core/contracts";

import { CLIENT_SDK_REGISTRY } from "../apps/runtime/src/services/client-sdk-registry.ts";
import {
  describeCompatibleClientSdks,
  listCompatibleClientSdks,
  registeredClientSdkContractHashes,
} from "../apps/runtime/src/services/compatible-client-sdks.ts";
import { getSystemHealth } from "../apps/runtime/src/services/health.ts";
import { loadFrozenSdk } from "./helpers/client-sdk-compat.ts";

// H-1b: /api/v1/health lists the client SDK contract hashes this hub serves
// (its own first, then the frozen SDKs of its registry, each hash once), and
// startup prints the same set for the deploy gate.

const repoRoot = join(import.meta.dirname, "..");
const exec = promisify(execFile);
const hash = (digit: string) => digit.repeat(64);

function healthApp(probe: () => Promise<unknown>) {
  return {
    pool: { query: vi.fn(probe) },
    logger: { error: vi.fn() },
  } as never;
}

describe("compatible client SDKs", () => {
  it("puts the own hash first, then each registered hash once, sorted", () => {
    // Rows are keyed by bundle: two builds may share a contract hash.
    const rows = [{ contractHash: hash("c") }, { contractHash: hash("b") }, { contractHash: hash("c") }];
    expect(registeredClientSdkContractHashes(rows)).toEqual([hash("b"), hash("c")]);
    expect(listCompatibleClientSdks(hash("d"), rows)).toEqual([hash("d"), hash("b"), hash("c")]);
    // A client vendored from this very hub: its hash is listed once, first.
    expect(listCompatibleClientSdks(hash("c"), rows)).toEqual([hash("c"), hash("b")]);
    expect(listCompatibleClientSdks(hash("a"), [])).toEqual([hash("a")]);
    expect(describeCompatibleClientSdks(hash("c"), rows)).toEqual({ own: hash("c"), registered: [hash("b"), hash("c")] });
  });

  it("lists this hub and every registry row within the health schema's bound", () => {
    const list = listCompatibleClientSdks();
    expect(list[0]).toBe(KERNEL_CONTRACT_HASH);
    expect(new Set(list).size).toBe(list.length);
    for (const row of CLIENT_SDK_REGISTRY) expect(list).toContain(row.contractHash);
    // The fleet's SDK today (desktop 0.1.64, Fansly 2.6.0-2.7.1).
    expect(list).toContain("b95b765c12f50905cb8f98c2d9644cf5adc4234299cd6516f0cd649b39235aab");
    // Past 64 hashes health would fail its own response schema: retire rows first.
    expect(healthResponseSchema.shape.compatibleClientSdks.safeParse(list).success).toBe(true);
    expect(describeCompatibleClientSdks()).toEqual({ own: KERNEL_CONTRACT_HASH, registered: list.slice(1).sort() });
  });

  it("sends the list in both health bodies; every frozen SDK still reads them", async () => {
    const healthy = await getSystemHealth(healthApp(async () => ({ rows: [{ "?column?": 1 }] })));
    const degraded = await getSystemHealth(healthApp(async () => {
      throw new Error("database down");
    }));
    expect(healthy.statusCode).toBe(200);
    expect(degraded.statusCode).toBe(503);

    for (const result of [healthy, degraded]) {
      expect(result.body.compatibleClientSdks).toEqual(listCompatibleClientSdks());
      expect(result.body.capabilities).toEqual(["desktop-lifecycle-v2"]);
      const schema = routeSchemas.health.response[result.statusCode as 200 | 503];
      expect(schema.parse(result.body)).toMatchObject({ compatibleClientSdks: listCompatibleClientSdks() });
      const body = JSON.parse(JSON.stringify(result.body)) as Record<string, unknown>;

      for (const row of CLIENT_SDK_REGISTRY) {
        const sdk = await loadFrozenSdk(row);
        for (const status of [200, 503] as const) {
          // Fansly 2.7.1 reads the raw body with response[200], the SDK's typed
          // call by status: a non-strict object drops the key it does not know.
          const parsed = sdk.routeSchemas.health!.response[status]!.safeParse(body) as { success: boolean; data?: object };
          expect(parsed.success, `${row.fixture} health ${status}`).toBe(true);
          expect(parsed.data).not.toHaveProperty("compatibleClientSdks");
          expect(parsed.data).toMatchObject({ contractHash: KERNEL_CONTRACT_HASH, capabilities: ["desktop-lifecycle-v2"] });
        }
      }
    }
  });

  it("prints {own, registered} as one stdout line from startup", async () => {
    const { stdout } = await exec(process.execPath, ["--import", "tsx/esm", "apps/runtime/src/startup.ts", "print-compatible-client-sdks"], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: "invalid-must-not-be-used", AGENCY_HUB_ROLE: "api" },
      timeout: 60_000,
      maxBuffer: 1 << 20,
    });
    expect(stdout.endsWith("\n")).toBe(true);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual(describeCompatibleClientSdks());
  }, 90_000);
});
