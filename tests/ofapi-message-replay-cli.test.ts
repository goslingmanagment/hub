import type * as DbModule from "@agency_hub_core/db";
import type * as SharedModule from "@agency_hub_core/shared";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pool: { end: vi.fn(async () => {}) },
  db: {},
  page: vi.fn(),
  replay: vi.fn(),
  bootstrap: vi.fn(async () => { throw new Error("Provider bootstrap must not run for local replay"); }),
}));

vi.mock("@agency_hub_core/db", async (original) => ({
  ...await original<typeof DbModule>(),
  createPool: () => mocks.pool,
  createDb: () => mocks.db,
  findPageByLabel: mocks.page,
}));
vi.mock("@agency_hub_core/shared", async (original) => ({
  ...await original<typeof SharedModule>(),
  loadConfig: () => ({ databaseUrl: "postgres://test", logLevel: "silent", ofapiApiKey: "configured-provider-key" }),
}));
vi.mock("../apps/runtime/src/bootstrap.ts", () => ({ createAppContext: mocks.bootstrap }));
vi.mock("../apps/runtime/src/services/ofapi-message-material-replay.ts", () => ({
  replayOfapiMessageMaterial: mocks.replay,
}));

import { buildProgram } from "../apps/runtime/src/cli.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.page.mockResolvedValue({ page: { id: 9 } });
  mocks.replay.mockResolvedValue({ stoppedAt: null });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const args = ["node", "cli", "ofapi-message-material-replay", "--page", "lora-vip-of",
  "--from", "2026-10-02T22:30:00Z", "--to", "2026-10-02T23:00:00Z"];

describe("local OFAPI material replay CLI", () => {
  it.each([false, true])("never starts provider bootstrap (execute=%s)", async (execute) => {
    await buildProgram().exitOverride().parseAsync([...args, ...(execute ? ["--execute"] : [])]);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.replay).toHaveBeenCalledWith(
      expect.objectContaining({ db: mocks.db }),
      expect.objectContaining({ pageId: 9, execute, limit: 100 }),
    );
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("closes the database without starting providers when page validation fails", async () => {
    mocks.page.mockResolvedValue(undefined);
    await expect(buildProgram().exitOverride().parseAsync(args)).rejects.toThrow("Page not found");
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.replay).not.toHaveBeenCalled();
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });
});
