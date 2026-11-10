import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type { ConfigOverrideRecord, Database } from "@agency_hub_core/db";
import { FANSLY_PAUSE_MAX_MS, FANSLY_PAUSE_MIN_MS, loadConfig } from "@agency_hub_core/shared";

// The stored global scope, read by both repository functions — so the whole-scope
// read and the one-row read see exactly the same rows.
const store = vi.hoisted(() => ({
  rows: new Map<string, { value: unknown; version: number }>(),
  failWith: null as Error | null,
  oneRowReads: 0,
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getConfigOverrides: async () => {
      if (store.failWith) throw store.failWith;
      return new Map(store.rows) as Map<string, ConfigOverrideRecord>;
    },
    getConfigOverride: async (_db: unknown, key: string) => {
      store.oneRowReads += 1;
      if (store.failWith) throw store.failWith;
      return (store.rows.get(key) ?? null) as ConfigOverrideRecord | null;
    },
  };
});

const { loadEffectiveConfig, loadEffectiveConfigField } = await import("../apps/runtime/src/services/effective-config.ts");

const db = {} as Database;
const config = loadConfig({
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  FANSLY_DEFAULT_DELAY_MS: "3100",
}, { loadDotEnv: false });

async function bothReads(): Promise<{ whole: number; field: number }> {
  return {
    whole: (await loadEffectiveConfig(db, config)).fanslyDefaultDelayMs,
    field: await loadEffectiveConfigField(db, config, "fanslyDefaultDelayMs"),
  };
}

beforeEach(() => {
  store.rows.clear();
  store.failWith = null;
  store.oneRowReads = 0;
  // Other rows of the scope, as on production: they must not change the pause.
  store.rows.set("fanslyRepliesRewalkCycleDays", { value: 9, version: 2 });
  store.rows.set("someRetiredKey", { value: "x", version: 1 });
});

describe("loadEffectiveConfigField(fanslyDefaultDelayMs) equals loadEffectiveConfig", () => {
  it("no stored row: the boot value", async () => {
    expect(await bothReads()).toEqual({ whole: 3100, field: 3100 });
  });

  it("a valid stored row: the stored value", async () => {
    for (const value of [FANSLY_PAUSE_MIN_MS, 2500, 4200, FANSLY_PAUSE_MAX_MS]) {
      store.rows.set("fanslyDefaultDelayMs", { value, version: 5 });
      expect(await bothReads(), String(value)).toEqual({ whole: value, field: value });
    }
  });

  it("an out-of-range or malformed stored row is ignored: the boot value stays", async () => {
    for (const value of [0, 1500, FANSLY_PAUSE_MIN_MS - 1, FANSLY_PAUSE_MAX_MS + 1, 250_000, "2500x", null, true]) {
      store.rows.set("fanslyDefaultDelayMs", { value, version: 5 });
      expect(await bothReads(), String(value)).toEqual({ whole: 3100, field: 3100 });
    }
  });

  it("reads the row fresh on every call: a change applies from the next read", async () => {
    store.rows.set("fanslyDefaultDelayMs", { value: 2500, version: 1 });
    expect(await loadEffectiveConfigField(db, config, "fanslyDefaultDelayMs")).toBe(2500);
    store.rows.set("fanslyDefaultDelayMs", { value: 7000, version: 2 });
    expect(await loadEffectiveConfigField(db, config, "fanslyDefaultDelayMs")).toBe(7000);
    store.rows.delete("fanslyDefaultDelayMs");
    expect(await loadEffectiveConfigField(db, config, "fanslyDefaultDelayMs")).toBe(3100);
    expect(store.oneRowReads).toBe(3);
  });

  it("a database error throws", async () => {
    store.failWith = new Error("connection terminated");
    await expect(loadEffectiveConfigField(db, config, "fanslyDefaultDelayMs")).rejects.toThrow("connection terminated");
  });
});
