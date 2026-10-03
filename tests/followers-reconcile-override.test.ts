import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

// The override serves only a page the Fansly Sync Engine owns (the legacy
// followers_reconcile walk is deleted since step 4, S4-17). The end-to-end
// flow over a real quarantined walk: tests/sync-engine-levers.integration.

const dbMocks = vi.hoisted(() => ({
  closeQuarantinedWork: vi.fn(),
  countActiveLiveWorkByResource: vi.fn(),
  deactivatePageFollowsByGeneration: vi.fn(),
  getOpenWorkForKey: vi.fn(),
  getSyncPage: vi.fn(),
  listPageFollowDeactivationCandidates: vi.fn(),
  listSyncPages: vi.fn(),
  readPageFollowReconcileActivity: vi.fn(),
  rebuildFollowerRollups: vi.fn(),
  refreshFanPageFollowerState: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  recordAudit: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return { ...actual, ...dbMocks };
});

vi.mock("../apps/runtime/src/services/auth.ts", () => authMocks);

import {
  applyFollowersReconcileBlastRadiusOverride,
  previewFollowersReconcileBlastRadiusOverride,
} from "../apps/runtime/src/services/followers-reconcile-override.ts";
import {
  followersReconcileCandidateSha256,
} from "../apps/runtime/src/sync/fansly/lib/followers-reconcile-safety.ts";

const WORK_ID = 1438;
const BLOCKED_AT = "2026-08-30T00:10:00.000Z";
const SWEEP_STARTED_AT = "2026-08-29T22:00:00.000Z";
const PAGE_ROW = { id: "7", label: "lora-1", platform: "fansly", followerCount: 7_491 };

function candidates(count = 51) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    lastSeenGeneration: index < 40 ? null : 685,
  }));
}

function syncPage(input: { paused?: boolean } = {}) {
  return { pageId: 7, pageLabel: "lora-1", mode: "live", pausedAll: input.paused ?? true, pausedResources: [] };
}

/** The quarantined `followers.reconcile` row the engine apply left behind. */
function quarantinedWalk() {
  return {
    id: WORK_ID,
    state: "quarantined",
    result: { quarantine: {
      reason: "apply:quarantine:followers_reconcile_deactivation_blast_radius",
      detail: { refusal: "followers_reconcile_deactivation_blast_radius", generation: 688, fullSweepStartedAt: SWEEP_STARTED_AT },
      attemptId: 91,
      at: BLOCKED_AT,
    } },
    cursor: {
      generation: 688,
      walk: {
        generation: 688, fullSweepStartedAt: SWEEP_STARTED_AT, offset: 7_500, observedCount: 7_440,
        pageCount: 75, sourceFollowerCount: 7_491, verificationPending: true,
      },
    },
  };
}

function createApp(input: { paused?: boolean } = {}) {
  dbMocks.listSyncPages.mockResolvedValue([syncPage(input)]);
  dbMocks.getSyncPage.mockResolvedValue(syncPage(input));
  dbMocks.getOpenWorkForKey.mockResolvedValue(quarantinedWalk());
  const execute = vi.fn().mockResolvedValue({ rows: [PAGE_ROW] });
  const tx = { execute };
  const transaction = vi.fn(async (
    callback: (database: typeof tx) => Promise<unknown>,
    _options?: unknown,
  ) => callback(tx));
  return {
    app: { db: { transaction, execute } } as never,
    tx,
    transaction,
  };
}

function stubCandidates(fixtureCandidates: ReturnType<typeof candidates>) {
  dbMocks.listPageFollowDeactivationCandidates.mockResolvedValue(fixtureCandidates);
  dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
    firstSeenDuringSweepOutsideGeneration: 0,
    activeFollowerCount: 1_000,
    deactivationCandidateCount: fixtureCandidates.length,
  });
}

const echo = (candidateSha256: string) => ({
  pageLabel: "lora-1",
  blockedRequestSeq: WORK_ID,
  blockedAt: BLOCKED_AT,
  generation: 688,
  fullSweepStartedAt: SWEEP_STARTED_AT,
  candidateSha256,
});

beforeEach(() => {
  for (const mock of [...Object.values(dbMocks), ...Object.values(authMocks)]) {
    mock.mockReset();
  }
  dbMocks.countActiveLiveWorkByResource.mockResolvedValue([]);
  dbMocks.closeQuarantinedWork.mockResolvedValue(true);
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

  it("refuses a Fansly page the engine does not own before it opens a transaction (409 legacy_sync_retired)", async () => {
    const { app, transaction } = createApp();
    dbMocks.listSyncPages.mockResolvedValue([]);
    const refused = { statusCode: 409, code: "legacy_sync_retired", name: "LegacySyncRetiredError" };

    await expect(previewFollowersReconcileBlastRadiusOverride(app, { pageLabel: "lora-1" }))
      .rejects.toMatchObject(refused);
    await expect(applyFollowersReconcileBlastRadiusOverride(app, echo("0".repeat(64)), { source: "api", actorUserId: 1 }))
      .rejects.toMatchObject(refused);

    expect(transaction).not.toHaveBeenCalled();
    expect(dbMocks.getOpenWorkForKey).not.toHaveBeenCalled();
    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  });

  it("keeps 404 for an unknown page and 400 for a page on another platform", async () => {
    const { app } = createApp();
    dbMocks.listSyncPages.mockResolvedValue([]);
    const execute = (app as unknown as { db: { execute: ReturnType<typeof vi.fn> } }).db.execute;

    execute.mockResolvedValueOnce({ rows: [] });
    await expect(previewFollowersReconcileBlastRadiusOverride(app, { pageLabel: "lora-1" }))
      .rejects.toMatchObject({ statusCode: 404 });
    execute.mockResolvedValueOnce({ rows: [{ ...PAGE_ROW, platform: "onlyfans" }] });
    await expect(previewFollowersReconcileBlastRadiusOverride(app, { pageLabel: "lora-1" }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("previews the quarantined walk's exact hash-bound candidate set without exposing row ids", async () => {
    const fixtureCandidates = candidates();
    const { app, transaction } = createApp({ paused: false });
    stubCandidates(fixtureCandidates);

    const result = await previewFollowersReconcileBlastRadiusOverride(app, {
      pageLabel: "lora-1",
    });

    expect(result).toEqual(expect.objectContaining({
      action: "preview",
      pageLabel: "lora-1",
      blockedRequestSeq: WORK_ID,
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
    expect(dbMocks.listPageFollowDeactivationCandidates).toHaveBeenCalledWith(
      expect.anything(),
      { platformAccountId: 7, generation: 688, fullSweepStartedAt: new Date(SWEEP_STARTED_AT) },
      { lock: false },
    );
  });

  it("applies only the echoed set in one serializable transaction, closes the walk and audits there", async () => {
    const fixtureCandidates = candidates();
    const candidateSha256 = followersReconcileCandidateSha256(fixtureCandidates);
    const { app, tx, transaction } = createApp();
    stubCandidates(fixtureCandidates);
    dbMocks.deactivatePageFollowsByGeneration.mockResolvedValue(
      fixtureCandidates.map((candidate) => candidate.id),
    );

    const result = await applyFollowersReconcileBlastRadiusOverride(app, echo(candidateSha256), {
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
    expect(dbMocks.closeQuarantinedWork).toHaveBeenCalledWith(tx, expect.objectContaining({
      workId: WORK_ID,
      to: "done",
      closeReason: "blast_radius_override_applied",
      cursor: expect.objectContaining({ walk: null, lastFullSweepStartedAt: SWEEP_STARTED_AT }),
    }));
    expect(authMocks.recordAudit).toHaveBeenCalledWith({ db: tx }, expect.objectContaining({
      eventType: "admin.followers_reconcile_blast_radius_override_applied",
      actorUserId: 1,
      platformAccountId: 7,
      metadata: expect.objectContaining({
        engine: { mode: "live", workId: WORK_ID, resource: "followers.reconcile" },
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
    const { app } = createApp();
    stubCandidates(candidates());

    await expect(applyFollowersReconcileBlastRadiusOverride(app, echo("0".repeat(64)), {
      source: "api", actorUserId: 1,
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
    expect(dbMocks.closeQuarantinedWork).not.toHaveBeenCalled();
    expect(authMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejects a changed walk binding before reading candidates", async () => {
    const { app } = createApp();

    await expect(applyFollowersReconcileBlastRadiusOverride(app, {
      ...echo("0".repeat(64)),
      blockedRequestSeq: WORK_ID - 1,
    }, { source: "api", actorUserId: 1 })).rejects.toMatchObject({ statusCode: 409 });

    expect(dbMocks.listPageFollowDeactivationCandidates).not.toHaveBeenCalled();
    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  });

  it("rolls back when the guarded helper does not update the exact approved ids", async () => {
    const fixtureCandidates = candidates();
    const { app } = createApp();
    stubCandidates(fixtureCandidates);
    dbMocks.deactivatePageFollowsByGeneration.mockResolvedValue([
      ...fixtureCandidates.slice(0, -1).map((candidate) => candidate.id),
      9_999,
    ]);

    await expect(applyFollowersReconcileBlastRadiusOverride(app, echo(
      followersReconcileCandidateSha256(fixtureCandidates),
    ), { source: "api", actorUserId: 1 })).rejects.toMatchObject({ statusCode: 409 });

    expect(dbMocks.refreshFanPageFollowerState).not.toHaveBeenCalled();
    expect(dbMocks.rebuildFollowerRollups).not.toHaveBeenCalled();
    expect(dbMocks.closeQuarantinedWork).not.toHaveBeenCalled();
    expect(authMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejects apply unless the whole audience is paused and no audience read is in flight", async () => {
    const candidateSha256 = followersReconcileCandidateSha256(candidates());
    const notPaused = createApp({ paused: false });
    await expect(applyFollowersReconcileBlastRadiusOverride(notPaused.app, echo(candidateSha256), {
      source: "api", actorUserId: 1,
    })).rejects.toMatchObject({ statusCode: 409 });

    const reading = createApp();
    dbMocks.countActiveLiveWorkByResource.mockResolvedValue([{ resource: "followers.head", running: 1 }]);
    await expect(applyFollowersReconcileBlastRadiusOverride(reading.app, echo(candidateSha256), {
      source: "api", actorUserId: 1,
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(dbMocks.listPageFollowDeactivationCandidates).not.toHaveBeenCalled();
    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  });

  it("rejects an override once the exact set is within the normal ceiling", async () => {
    const fixtureCandidates = candidates(50);
    const { app } = createApp();
    stubCandidates(fixtureCandidates);

    await expect(applyFollowersReconcileBlastRadiusOverride(app, echo(
      followersReconcileCandidateSha256(fixtureCandidates),
    ), { source: "api", actorUserId: 1 })).rejects.toMatchObject({ statusCode: 409 });

    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
    expect(authMocks.recordAudit).not.toHaveBeenCalled();
  });

  it.each(["40001", "40P01"])("maps a %s refusal to a fresh-preview response", async (code) => {
    const { app, transaction } = createApp();
    transaction.mockRejectedValue({ code });

    await expect(applyFollowersReconcileBlastRadiusOverride(app, echo("0".repeat(64)), {
      source: "api", actorUserId: 1,
    })).rejects.toMatchObject({
      statusCode: 409,
      message: "Follower reconcile changed concurrently; preview again",
    });
  });
});
