import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

const dbMocks = vi.hoisted(() => ({
  deactivatePageFollowsByGeneration: vi.fn(),
  listPageFollowDeactivationCandidates: vi.fn(),
  readPageFollowReconcileActivity: vi.fn(),
  rebuildFollowerRollups: vi.fn(),
  refreshFanPageFollowerState: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  recordAudit: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  // The page is the legacy engine's (the engine branch:
  // tests/sync-engine-levers.integration.test.ts).
  return { ...actual, ...dbMocks, listSyncPages: async () => [] };
});

vi.mock("../apps/runtime/src/services/auth.ts", () => authMocks);

import {
  applyFollowersReconcileBlastRadiusOverride,
  previewFollowersReconcileBlastRadiusOverride,
} from "../apps/runtime/src/services/followers-reconcile-override.ts";
import {
  followersReconcileCandidateSha256,
} from "../apps/runtime/src/services/sync/followers-reconcile-safety.ts";

const BLOCKED_AT = "2026-08-30T00:10:00.000Z";
const SWEEP_STARTED_AT = "2026-08-29T22:00:00.000Z";

function candidates(count = 51) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    lastSeenGeneration: index < 40 ? null : 685,
  }));
}

type TestAudienceRow = {
  stream: string;
  status: "blocked" | "paused";
  requestSeq: number;
  appliedSeq: number;
  blockerKind: string | null;
  blockerCode: string | null;
  blockedAt: Date | null;
  leasedSeq: number | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseHeartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
};

function audienceRows(input?: {
  status?: "blocked" | "paused";
  withLease?: boolean;
}) {
  const status = input?.status ?? "paused";
  const base = (stream: string): TestAudienceRow => ({
    stream,
    status,
    requestSeq: stream === "followers_reconcile" ? 1438 : 100,
    appliedSeq: stream === "followers_reconcile" ? 844 : 100,
    blockerKind: stream === "followers_reconcile" ? "provider_bad_data" : null,
    blockerCode: stream === "followers_reconcile"
      ? "followers_reconcile_deactivation_blast_radius"
      : null,
    blockedAt: stream === "followers_reconcile" ? new Date(BLOCKED_AT) : null,
    leasedSeq: null,
    leaseOwner: null,
    leaseToken: null,
    leaseHeartbeatAt: null,
    leaseExpiresAt: null,
  });
  const rows = [
    base("followers"),
    base("followers_reconcile"),
    base("subscribers"),
  ];
  if (input?.withLease) {
    rows[0] = {
      ...rows[0]!,
      leasedSeq: 100,
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
      leaseHeartbeatAt: new Date(BLOCKED_AT),
      leaseExpiresAt: new Date("2026-08-30T00:20:00.000Z"),
    };
  }
  return rows;
}

function cursorRow(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      revision: 1438,
      generation: 688,
      fullSweepStartedAt: SWEEP_STARTED_AT,
      verificationPending: true,
      ...overrides,
    },
  };
}

function createApp(input?: {
  status?: "blocked" | "paused";
  withLease?: boolean;
  cursorOverrides?: Record<string, unknown>;
}) {
  const execute = vi.fn()
    .mockResolvedValueOnce({
      rows: [{ id: "7", label: "lora-1", platform: "fansly", followerCount: 7_491 }],
    })
    .mockResolvedValueOnce({ rows: audienceRows(input) })
    .mockResolvedValueOnce({ rows: [cursorRow(input?.cursorOverrides)] });
  const tx = { execute };
  const transaction = vi.fn(async (
    callback: (database: typeof tx) => Promise<unknown>,
    _options?: unknown,
  ) => callback(tx));
  return {
    app: { db: { transaction } } as never,
    tx,
    transaction,
  };
}

beforeEach(() => {
  for (const mock of [...Object.values(dbMocks), ...Object.values(authMocks)]) {
    mock.mockReset();
  }
  dbMocks.rebuildFollowerRollups.mockResolvedValue(undefined);
  dbMocks.refreshFanPageFollowerState.mockResolvedValue(undefined);
  authMocks.recordAudit.mockResolvedValue(undefined);
});

describe("followers reconcile blast-radius override", () => {
  it("has no checkpoint, state, request or freshness writer", () => {
    const source = readFileSync(new URL(
      "../apps/runtime/src/services/followers-reconcile-override.ts",
      import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(
      /\b(upsertCheckpoint|updatePageSyncTimestampCache|completePageSync|resetPageSync|requestPageSync)\b/,
    );
    expect(source).not.toMatch(/update\s+(page_sync_states|page_sync_cursors|pages)\b/i);
  });

  it("previews an exact hash-bound candidate set without exposing row ids", async () => {
    const fixtureCandidates = candidates();
    const { app, transaction } = createApp({ status: "blocked" });
    dbMocks.listPageFollowDeactivationCandidates.mockResolvedValue(fixtureCandidates);
    dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
      firstSeenDuringSweepOutsideGeneration: 0,
      activeFollowerCount: 1_000,
      deactivationCandidateCount: fixtureCandidates.length,
    });

    const result = await previewFollowersReconcileBlastRadiusOverride(app, {
      pageLabel: "lora-1",
    });

    expect(result).toEqual(expect.objectContaining({
      action: "preview",
      pageLabel: "lora-1",
      blockedRequestSeq: 1438,
      blockedAt: BLOCKED_AT,
      generation: 688,
      fullSweepStartedAt: SWEEP_STARTED_AT,
      activeFollowerCount: 1_000,
      deactivationLimit: 50,
      candidateCount: 51,
      candidateSha256: followersReconcileCandidateSha256(fixtureCandidates),
      candidateGenerationBuckets: [
        { lastSeenGeneration: null, count: 40 },
        { lastSeenGeneration: 685, count: 11 },
      ],
      audiencePaused: false,
      audienceLeaseFree: true,
      overrideRequired: true,
      readyToApply: false,
    }));
    expect(result).not.toHaveProperty("candidateIds");
    expect(transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it("applies only the echoed set in one serializable transaction and audits there", async () => {
    const fixtureCandidates = candidates();
    const candidateSha256 = followersReconcileCandidateSha256(fixtureCandidates);
    const { app, tx, transaction } = createApp();
    dbMocks.listPageFollowDeactivationCandidates.mockResolvedValue(fixtureCandidates);
    dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
      firstSeenDuringSweepOutsideGeneration: 0,
      activeFollowerCount: 1_000,
      deactivationCandidateCount: fixtureCandidates.length,
    });
    dbMocks.deactivatePageFollowsByGeneration.mockResolvedValue(
      fixtureCandidates.map((candidate) => candidate.id),
    );

    const result = await applyFollowersReconcileBlastRadiusOverride(app, {
      pageLabel: "lora-1",
      blockedRequestSeq: 1438,
      blockedAt: BLOCKED_AT,
      generation: 688,
      fullSweepStartedAt: SWEEP_STARTED_AT,
      candidateSha256,
    }, {
      source: "api",
      actorUserId: 1,
    });

    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "serializable" },
    );
    expect(dbMocks.listPageFollowDeactivationCandidates).toHaveBeenCalledWith(
      tx,
      {
        platformAccountId: 7,
        generation: 688,
        fullSweepStartedAt: new Date(SWEEP_STARTED_AT),
      },
      { lock: true },
    );
    expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
      platformAccountId: 7,
      generation: 688,
      lastSeenBefore: new Date(SWEEP_STARTED_AT),
    });
    expect(dbMocks.refreshFanPageFollowerState).toHaveBeenCalledWith(tx, 7);
    expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 7, 7_491);
    expect(authMocks.recordAudit).toHaveBeenCalledWith({ db: tx }, expect.objectContaining({
      eventType: "admin.followers_reconcile_blast_radius_override_applied",
      actorUserId: 1,
      platformAccountId: 7,
      metadata: expect.objectContaining({
        candidateSha256,
        candidateCount: 51,
        deactivatedCount: 51,
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      action: "apply",
      deactivatedCount: 51,
      audienceRemainsPaused: true,
    }));
    expect(result).not.toHaveProperty("candidateIds");
  });

  it("rejects a stale candidate hash before any mutation", async () => {
    const fixtureCandidates = candidates();
    const { app } = createApp();
    dbMocks.listPageFollowDeactivationCandidates.mockResolvedValue(fixtureCandidates);
    dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
      firstSeenDuringSweepOutsideGeneration: 0,
      activeFollowerCount: 1_000,
      deactivationCandidateCount: fixtureCandidates.length,
    });

    await expect(applyFollowersReconcileBlastRadiusOverride(app, {
      pageLabel: "lora-1",
      blockedRequestSeq: 1438,
      blockedAt: BLOCKED_AT,
      generation: 688,
      fullSweepStartedAt: SWEEP_STARTED_AT,
      candidateSha256: "0".repeat(64),
    }, { source: "api", actorUserId: 1 })).rejects.toMatchObject({ statusCode: 409 });

    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
    expect(authMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejects a changed blocker/cursor binding before reading candidates", async () => {
    const { app } = createApp();

    await expect(applyFollowersReconcileBlastRadiusOverride(app, {
      pageLabel: "lora-1",
      blockedRequestSeq: 1437,
      blockedAt: BLOCKED_AT,
      generation: 688,
      fullSweepStartedAt: SWEEP_STARTED_AT,
      candidateSha256: "0".repeat(64),
    }, { source: "api", actorUserId: 1 })).rejects.toMatchObject({ statusCode: 409 });

    expect(dbMocks.listPageFollowDeactivationCandidates).not.toHaveBeenCalled();
    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  });

  it("rolls back when the guarded helper does not update the exact approved ids", async () => {
    const fixtureCandidates = candidates();
    const { app } = createApp();
    dbMocks.listPageFollowDeactivationCandidates.mockResolvedValue(fixtureCandidates);
    dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
      firstSeenDuringSweepOutsideGeneration: 0,
      activeFollowerCount: 1_000,
      deactivationCandidateCount: fixtureCandidates.length,
    });
    dbMocks.deactivatePageFollowsByGeneration.mockResolvedValue([
      ...fixtureCandidates.slice(0, -1).map((candidate) => candidate.id),
      9_999,
    ]);

    await expect(applyFollowersReconcileBlastRadiusOverride(app, {
      pageLabel: "lora-1",
      blockedRequestSeq: 1438,
      blockedAt: BLOCKED_AT,
      generation: 688,
      fullSweepStartedAt: SWEEP_STARTED_AT,
      candidateSha256: followersReconcileCandidateSha256(fixtureCandidates),
    }, { source: "api", actorUserId: 1 })).rejects.toMatchObject({ statusCode: 409 });

    expect(dbMocks.refreshFanPageFollowerState).not.toHaveBeenCalled();
    expect(dbMocks.rebuildFollowerRollups).not.toHaveBeenCalled();
    expect(authMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejects apply unless every audience stream is paused and lease-free", async () => {
    const fixtureCandidates = candidates();
    for (const input of [
      { status: "blocked" as const },
      { status: "paused" as const, withLease: true },
    ]) {
      const { app } = createApp(input);
      await expect(applyFollowersReconcileBlastRadiusOverride(app, {
        pageLabel: "lora-1",
        blockedRequestSeq: 1438,
        blockedAt: BLOCKED_AT,
        generation: 688,
        fullSweepStartedAt: SWEEP_STARTED_AT,
        candidateSha256: followersReconcileCandidateSha256(fixtureCandidates),
      }, { source: "api", actorUserId: 1 })).rejects.toMatchObject({ statusCode: 409 });
    }

    expect(dbMocks.listPageFollowDeactivationCandidates).not.toHaveBeenCalled();
    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  });

  it("rejects an override once the exact set is within the normal ceiling", async () => {
    const fixtureCandidates = candidates(50);
    const { app } = createApp();
    dbMocks.listPageFollowDeactivationCandidates.mockResolvedValue(fixtureCandidates);
    dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
      firstSeenDuringSweepOutsideGeneration: 0,
      activeFollowerCount: 1_000,
      deactivationCandidateCount: fixtureCandidates.length,
    });

    await expect(applyFollowersReconcileBlastRadiusOverride(app, {
      pageLabel: "lora-1",
      blockedRequestSeq: 1438,
      blockedAt: BLOCKED_AT,
      generation: 688,
      fullSweepStartedAt: SWEEP_STARTED_AT,
      candidateSha256: followersReconcileCandidateSha256(fixtureCandidates),
    }, { source: "api", actorUserId: 1 })).rejects.toMatchObject({ statusCode: 409 });

    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
    expect(authMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("maps a serializable conflict to a fresh-preview response", async () => {
    const transaction = vi.fn().mockRejectedValue({ code: "40001" });
    const app = { db: { transaction } } as never;

    await expect(applyFollowersReconcileBlastRadiusOverride(app, {
      pageLabel: "lora-1",
      blockedRequestSeq: 1438,
      blockedAt: BLOCKED_AT,
      generation: 688,
      fullSweepStartedAt: SWEEP_STARTED_AT,
      candidateSha256: "0".repeat(64),
    }, { source: "api", actorUserId: 1 })).rejects.toMatchObject({
      statusCode: 409,
      message: "Follower reconcile changed concurrently; preview again",
    });
  });
});
