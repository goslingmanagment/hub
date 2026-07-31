import { beforeEach, describe, expect, it, vi } from "vitest";

const effectiveConfigMocks = vi.hoisted(() => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/effective-config.ts", () => effectiveConfigMocks);

const { startTieringWorker, ensureTieringSchedule, TIERING_QUEUE } = await import(
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

  it("runs the cycle once the flag is on", async () => {
    effectiveConfigMocks.loadEffectiveConfig.mockResolvedValue({ retentionTieringEnabled: true });
    const gate = captureHandler();

    startTieringWorker(appStub({ retentionTieringEnabled: true }), gate.boss as never);
    // Reaching the database IS the proof the gate opened: the stub rejects there.
    await expect(gate.run()).rejects.toThrow(TIERING_MUST_NOT_RUN);
  });

  it("reads the effective config per cycle, not once at boot", async () => {
    // The owner flips this from the dashboard; a boot-time read would keep
    // answering with the deployed value until the next restart.
    effectiveConfigMocks.loadEffectiveConfig.mockResolvedValue({ retentionTieringEnabled: false });
    const gate = captureHandler();
    startTieringWorker(appStub({ retentionTieringEnabled: false }), gate.boss as never);

    await gate.run();
    await gate.run();

    expect(effectiveConfigMocks.loadEffectiveConfig).toHaveBeenCalledTimes(2);
  });

  it("keeps the schedule itself unconditional", async () => {
    // The queue and its 04:40 UTC schedule exist either way; only the callback
    // body is gated, so opening the flag needs no schedule surgery.
    const schedule = vi.fn(async () => undefined);
    await ensureTieringSchedule({ schedule } as never);
    expect(schedule).toHaveBeenCalledWith(TIERING_QUEUE, "40 4 * * *");
  });
});
