// Bug hunt 2026-10-09 (agent `resources`), scratch test — not for merge.
//
// Claim: the production host of the `sync` role passes no `canonicalize` to
// `SyncEngineHost`, so the commit's inline canonicalization
// (`engine/commit.ts` "if (d.canonicalize !== undefined …)") never runs on
// prod for any resource that does not canonicalize itself (only
// `dm-messages.*` and the probe do). Every other observation waits for the
// minutely driver, while design §3.11 (G3) and the resource specs (§5.x
// "Apply: inline canonicalization") — and the module comments — assume the
// events exist when the apply commits.
//
// This test FAILS on 71a05b5b: the captured options carry no canonicalizer.
import { describe, expect, it, vi } from "vitest";

const captured: Array<Record<string, unknown>> = [];

vi.mock("../apps/runtime/src/sync/engine/host.ts", () => ({
  SyncEngineHost: class {
    constructor(options: Record<string, unknown>) {
      captured.push(options);
    }
    async start() {}
    async stop() {}
  },
}));

describe("bughunt resources: production host wiring", () => {
  it("passes an inline canonicalizer to the engine host (design §3.11 G3)", async () => {
    const { createSyncRuntimeHost } = await import("../apps/runtime/src/sync/main.ts");
    const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
    createSyncRuntimeHost({
      db: {} as never,
      config: { databaseUrl: "postgres://unused" } as never,
      rawConfig: {} as never,
      logger: logger as never,
    } as never);
    expect(captured).toHaveLength(1);
    const options = captured[0]!;
    // Present: the hooks the history requests need.
    expect(typeof options.onThreadChainChanged).toBe("function");
    // Missing on prod: the inline canonicalizer.
    expect(typeof options.canonicalize).toBe("function");
  });
});
