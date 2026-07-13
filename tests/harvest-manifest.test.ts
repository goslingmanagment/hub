import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveHarvestManifest } from "../apps/runtime/src/services/harvest-manifest.ts";

const MACHINE = "11111111-1111-4111-8111-111111111111";

const CANONICAL_TABLES = [
  { table: "messages", kind: "harvest.messages" },
  { table: "fan_transactions", kind: "harvest.fan_transactions" },
  { table: "outbox", kind: "harvest.outbox" },
  { table: "message_guard_events", kind: "harvest.message_guard_events" },
  { table: "usage_events", kind: "harvest.usage_events" },
  { table: "ai_spend_log", kind: "harvest.ai_spend_log" },
  { table: "credit_log", kind: "harvest.credit_log" },
] as const;

function tableEntries(walked: number) {
  return CANONICAL_TABLES.map((entry, index) => ({
    ...entry,
    walked: index === 0 ? walked : 0,
    uploaded: index === 0 ? walked : 0,
    duplicates: 0,
  }));
}

function manifest(walked: number, extra: Record<string, unknown> = {}) {
  return {
    machineId: MACHINE,
    harvestFormatVersion: 2,
    tables: tableEntries(walked),
    ...extra,
  };
}

describe("resolveHarvestManifest", () => {
  it("auto-follows a timestamped snapshot to the canonical cumulative manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-harvest-manifest-"));
    const latestName = `chatgoose-harvest-manifest-${MACHINE}-latest.json`;
    const timestamped = join(dir, `chatgoose-harvest-manifest-${MACHINE}-2026-07-13.json`);
    const latest = join(dir, latestName);
    await writeFile(timestamped, JSON.stringify(manifest(1, { reconcileUsing: latestName })));
    await writeFile(latest, JSON.stringify(manifest(2, { reconcileUsing: latestName })));

    const resolved = await resolveHarvestManifest(timestamped);

    expect(resolved.path).toBe(latest);
    expect(resolved.supersededPath).toBe(timestamped);
    expect(resolved.manifest.tables[0]?.walked).toBe(2);
  });

  it("also discovers the canonical sibling for a legacy v1 timestamp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-harvest-v1-manifest-"));
    const timestamped = join(dir, `chatgoose-harvest-manifest-${MACHINE}-legacy.json`);
    const latest = join(dir, `chatgoose-harvest-manifest-${MACHINE}-latest.json`);
    await writeFile(timestamped, JSON.stringify(manifest(1, { harvestFormatVersion: 1 })));
    await writeFile(latest, JSON.stringify(manifest(3)));

    const resolved = await resolveHarvestManifest(timestamped);

    expect(resolved.path).toBe(latest);
    expect(resolved.manifest.tables[0]?.walked).toBe(3);
  });

  it("keeps using a legacy v1 timestamp when no canonical sibling exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-harvest-v1-only-manifest-"));
    const timestamped = join(dir, `chatgoose-harvest-manifest-${MACHINE}-legacy.json`);
    await writeFile(timestamped, JSON.stringify(manifest(1, { harvestFormatVersion: 1 })));

    const resolved = await resolveHarvestManifest(timestamped);

    expect(resolved.path).toBe(timestamped);
    expect(resolved.supersededPath).toBeNull();
    expect(resolved.manifest.tables[0]?.walked).toBe(1);
  });

  it("rejects a canonical sibling belonging to a different machine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-harvest-machine-mismatch-"));
    const latestName = `chatgoose-harvest-manifest-${MACHINE}-latest.json`;
    const timestamped = join(dir, `chatgoose-harvest-manifest-${MACHINE}-snapshot.json`);
    const latest = join(dir, latestName);
    await writeFile(timestamped, JSON.stringify(manifest(1, { reconcileUsing: latestName })));
    await writeFile(latest, JSON.stringify({
      ...manifest(2),
      machineId: "22222222-2222-4222-8222-222222222222",
    }));

    await expect(resolveHarvestManifest(timestamped)).rejects.toThrow(/does not match/i);
  });

  it("rejects a reconcileUsing path that can escape the manifest directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-harvest-unsafe-manifest-"));
    const timestamped = join(dir, "snapshot.json");
    await writeFile(
      timestamped,
      JSON.stringify(manifest(1, { reconcileUsing: "../other/latest.json" })),
    );

    await expect(resolveHarvestManifest(timestamped)).rejects.toThrow(/unsafe/i);
  });

  it.each([
    ["empty", []],
    ["a subset", tableEntries(1).slice(0, 1)],
    [
      "a duplicate kind",
      [...tableEntries(1).slice(0, -1), { ...tableEntries(1)[0], table: "credit_log" }],
    ],
    [
      "an unknown kind",
      [...tableEntries(1).slice(0, -1), {
        table: "credit_log",
        kind: "harvest.unknown",
        walked: 0,
        uploaded: 0,
        duplicates: 0,
      }],
    ],
  ])("rejects a manifest containing %s instead of all seven canonical kinds", async (_case, tables) => {
    const dir = await mkdtemp(join(tmpdir(), "core-harvest-invalid-kinds-"));
    const timestamped = join(dir, `chatgoose-harvest-manifest-${MACHINE}-legacy.json`);
    await writeFile(timestamped, JSON.stringify(manifest(1, { tables })));

    await expect(resolveHarvestManifest(timestamped)).rejects.toThrow(/canonical harvest kind/i);
  });
});
