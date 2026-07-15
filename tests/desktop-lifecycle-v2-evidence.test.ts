import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  DESKTOP_LIFECYCLE_V2_EVIDENCE,
  type DesktopLifecycleV2Evidence,
  type DesktopLifecycleV2InventoryItem,
  validateDesktopLifecycleV2Evidence,
  verifyDesktopLifecycleV2Inventory,
} from "../apps/runtime/src/services/desktop-lifecycle-v2-evidence.ts";

const item: DesktopLifecycleV2InventoryItem = {
  machineId: "58201c28-5c87-44da-979e-d075c1025be3",
  userId: 3,
  username: "Dmitriy",
  role: "chatter",
  tokenId: 5,
  keyPrefix: "device_abc123",
  label: "ChatGoose Desktop 0.1.42 on studio-mac",
  createdAt: "2026-07-15T00:05:00.000Z",
};

function evidenceWithInventory(
  inventory: readonly DesktopLifecycleV2InventoryItem[] = [item],
): DesktopLifecycleV2Evidence {
  return {
    ...DESKTOP_LIFECYCLE_V2_EVIDENCE,
    harvestInventory: inventory,
  };
}

function validRow() {
  return {
    token_id: item.tokenId,
    user_id: item.userId,
    username: item.username,
    role: item.role,
    disabled_at: null,
    label: item.label,
    key_prefix: item.keyPrefix,
    harvest_machine_id: item.machineId,
    created_at: new Date(item.createdAt),
    expires_at: new Date("2026-10-15T00:05:00.000Z"),
    last_used_at: new Date("2026-07-15T00:06:00.000Z"),
    revoked_at: null,
  };
}

function poolReturning(row: Record<string, unknown>) {
  const query = vi.fn(async (statement: string, _parameters?: unknown[]) => {
    if (/^\s*select\b/i.test(statement)) {
      return { rowCount: 1, rows: [row] };
    }
    return { rowCount: null, rows: [] };
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
  } as unknown as Pick<Pool, "connect">;
  return { pool, query, release };
}

describe("desktop lifecycle v2 evidence", () => {
  it("rejects an empty or ambiguous harvest inventory", () => {
    expect(() => validateDesktopLifecycleV2Evidence(evidenceWithInventory([])))
      .toThrow("harvest inventory is empty");
    expect(() => validateDesktopLifecycleV2Evidence(evidenceWithInventory([item, item])))
      .toThrow("duplicate inventory machine UUID");
  });

  it("accepts the exact active chatter token binding using a read-only query", async () => {
    const { pool, query, release } = poolReturning(validRow());
    await expect(verifyDesktopLifecycleV2Inventory(
      pool,
      evidenceWithInventory(),
      new Date("2026-07-15T00:10:00.000Z"),
    )).resolves.toEqual([{
      machineId: item.machineId,
      tokenId: item.tokenId,
      username: item.username,
    }]);

    const statements = query.mock.calls.map(([statement]) => String(statement).trim());
    expect(statements[0]).toBe("begin transaction read only");
    expect(statements).toContain("set local statement_timeout = '5s'");
    expect(statements).toContain("set local lock_timeout = '5s'");
    expect(statements.at(-1)).toBe("commit");
    expect(statements.join("\n")).not.toMatch(/\b(insert|update|delete)\b/i);
    const selectCall = query.mock.calls.find(([statement]) => /^\s*select\b/i.test(String(statement)));
    expect(selectCall).toBeDefined();
    const [statement, parameters] = selectCall!;
    expect(String(statement).trimStart()).toMatch(/^select\b/i);
    expect(parameters).toEqual([item.tokenId]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["wrong machine", { harvest_machine_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, "machine binding mismatch"],
    ["wrong user", { user_id: 99 }, "userId mismatch"],
    ["wrong prefix", { key_prefix: "device_wrong" }, "keyPrefix mismatch"],
    ["wrong label", { label: "Firefox extension" }, "label mismatch"],
    ["wrong createdAt", { created_at: new Date("2026-07-15T00:05:01.000Z") }, "createdAt mismatch"],
    ["revoked", { revoked_at: new Date("2026-07-15T00:09:00.000Z") }, "is revoked"],
    ["disabled user", { disabled_at: new Date("2026-07-15T00:09:00.000Z") }, "user is disabled"],
    ["never authenticated", { last_used_at: null }, "has never authenticated"],
    ["expiring", { expires_at: new Date("2026-07-15T12:00:00.000Z") }, "expires inside safety margin"],
  ])("rejects %s", async (_name, patch, message) => {
    const { pool, query, release } = poolReturning({ ...validRow(), ...patch });
    await expect(verifyDesktopLifecycleV2Inventory(
      pool,
      evidenceWithInventory(),
      new Date("2026-07-15T00:10:00.000Z"),
    )).rejects.toThrow(String(message));
    expect(query.mock.calls.map(([statement]) => String(statement).trim())).toContain("rollback");
    expect(release).toHaveBeenCalledOnce();
  });
});
