import { beforeEach, describe, expect, it, vi } from "vitest";

const effectiveConfigMocks = vi.hoisted(() => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/effective-config.ts", () => effectiveConfigMocks);

const { startTieringWorker, TIERING_QUEUE } = await import(
  "../apps/runtime/src/services/tiering/index.ts"
);

/**
 * Retention tiering detaches aged monthly partitions. A detached month is
 * invisible to the read plane, which would then mint capture floors that are
 * simply false, and it makes an observation replay fail with the documented 23514.
 * So the SCHEDULE ships off and the owner opens it deliberately.
 *
 * Two properties matter and both are pinned here: the gate is on the SCHEDULED
 * callback (the owner CLI run stays ungated — it is an explicit act), and it reads
 * the EFFECTIVE config on every cycle, because the boot-time config never sees a
 * dashboard flip and a boot-time read would make the switch a lie until restart.
 */

const TIERING_MUST_NOT_RUN = "the tiering cycle must not touch the database while gated off";

function appStub(config: Record<string, unknown>) {
  return {
    // Any database access from the cycle body is a gate failure. listTierablePartitions
    // is the cycle's first act, so this rejection is what "it ran" looks like.
    db: {
      execute: () => {
        throw new Error(TIERING_MUST_NOT_RUN);
      },
    },
    config,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

function captureHandler() {
  let handler: (() => Promise<unknown>) | null = null;
  const boss = {
    work: vi.fn((_queue: string, callback: () => Promise<unknown>) => {
      handler = callback;
      return Promise.resolve("worker-id");
    }),
  };
  return {
    boss,
    run: async () => {
      if (!handler) {
        throw new Error("startTieringWorker registered no handler");
      }
      return handler();
    },
  };
}

describe("scheduled retention tiering gate", () => {
  beforeEach(() => {
    effectiveConfigMocks.loadEffectiveConfig.mockReset();
  });

  it("no-ops when the flag is off, without touching the database", async () => {
    effectiveConfigMocks.loadEffectiveConfig.mockResolvedValue({ retentionTieringEnabled: false });
    const { boss, run } = captureHandler();

    startTieringWorker(appStub({ retentionTieringEnabled: false }), boss as never);
    await expect(run()).resolves.toBeUndefined();

    expect(boss.work).toHaveBeenCalledWith(TIERING_QUEUE, expect.any(Function));
  });

  it("treats a missing flag as off (fail closed)", async () => {
    // An older config object, or a process that has not been redeployed, must not
    // be read as consent to detach partitions.
    effectiveConfigMocks.loadEffectiveConfig.mockResolvedValue({});
    const gate = captureHandler();

    startTieringWorker(appStub({}), gate.boss as never);
    await expect(gate.run()).resolves.toBeUndefined();
  });
});
