// A legacy (non-recovery) shadow walk crosses one fan's deterministic rejection
// once its receipt is durable, at most three fans in a row across the walk's
// chunks, and finishes that generation with a quality hold. Nothing is retried
// and no extra request is made.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getCheckpoint, upsertFanPages, upsertFans } from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import { executeFanEarningsChunk } from "../apps/runtime/src/services/sync/fan-earnings.ts";
import { earningsTargetFixture } from "./helpers/earnings-target-fixture.ts";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";

let db: Awaited<ReturnType<typeof startTestDatabase>>;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

type Fixture = Awaited<ReturnType<typeof earningsTargetFixture>>;
const HOLD = "fan_earnings_unconfirmed_coverage";

/** Shadow page, recovery and addressed targets off: only the daily walk runs. */
async function legacy(extraSpenders: string[] = ["fan-c"]) {
  const f = await earningsTargetFixture(db);
  f.app.config.fanslyFanEarningsTargetsEnabled = false;
  const fans = await upsertFans(db.db, extraSpenders.map((platformUserId) => ({
    platform: "fansly" as const, platformUserId, username: platformUserId,
  })));
  await upsertFanPages(db.db, fans.map((fan) => ({ fanId: fan.id, platformAccountId: f.page.id })));
  await db.pool.query("update page_fans set total_creator_net_mills=100 where platform_account_id=$1", [f.page.id]);
  return { ...f, allFans: [...f.fans, ...fans] };
}

function reject(f: Fixture, refs: string[], status: number, window = "lifetime", retryAfterAt?: Date) {
  f.beforeResponse.mockImplementation(async (fanRef, visited) => {
    if (refs.includes(fanRef) && visited === window) {
      throw new FanslyApiError("gone", status, undefined, undefined, retryAfterAt);
    }
  });
}

async function nextGeneration(f: Fixture) {
  f.execution.requestSeq++;
  await db.pool.query(`update page_sync_states set request_seq=request_seq+1, leased_seq=leased_seq+1
    where page_id=$1 and stream='fan_earnings'`, [f.page.id]);
}

const checkpoint = (f: Fixture) => getCheckpoint(db.db, f.page.id, "fan_earnings");
const endpoint = async (f: Fixture, fanRef: string, plane: string) =>
  (await f.rows()).find((row) => row.subject_ref === fanRef && row.plane === `fan_earnings_${plane}`);

describe("legacy fan-earnings walk crossing", () => {
  it.each([[400, "lifetime"], [410, "monthly"]] as const)(
    "crosses a durable HTTP %s %s rejection and holds the finished generation",
    async (status, window) => {
      const f = await legacy();
      reject(f, ["fan-b"], status, window);
      const input = await f.chunkInput(20);
      const result = await f.owned(() => executeFanEarningsChunk(f.app, input));
      expect(result).toMatchObject({
        satisfied: true, qualityHold: HOLD,
        stats: { fansFetched: 2, fansSkipped: 1, fansCrossed: 1, walkCompleted: true },
      });
      // The crossed fan is not retried, and its other endpoint is not requested.
      expect(f.visits.map((visit) => `${visit.fanRef}:${visit.window}`)).toEqual([
        "fan-a:lifetime", "fan-a:monthly", "fan-b:lifetime",
        ...(window === "monthly" ? ["fan-b:monthly"] : []), "fan-c:lifetime", "fan-c:monthly",
      ]);
      const telemetry = input.telemetry as unknown as { addAnomaly: unknown };
      expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
        code: "fan_earnings_fan_rejected",
        details: expect.objectContaining({ platformUserId: "fan-b", status, window, crossed: true }),
      }));
      expect(await endpoint(f, "fan-b", window)).toMatchObject({
        last_refresh_outcome: "rejected", consecutive_failures: 1, consecutive_rejections: 1,
        claim_token: null,
      });
      const held = await checkpoint(f);
      expect(held?.state).toMatchObject({ cursorFanId: 0, qualityHold: HOLD, crossedFans: 1 });
      expect(held?.state).not.toHaveProperty("completedAt");
      expect(held?.cursorLastSucceededRunId ?? null).toBeNull();

      // A settlement retry of the same generation stays held without refetching.
      expect(await f.chunk(20)).toMatchObject({
        satisfied: true, qualityHold: HOLD, stats: { fansFetched: 0, reusedCompletedWalk: true },
      });
      expect(f.visits).toHaveLength(window === "monthly" ? 6 : 5);

      // The next generation reads the crossed fan again and can certify.
      f.beforeResponse.mockReset();
      await nextGeneration(f);
      const next = await f.chunk(20);
      expect(next).toMatchObject({ satisfied: true, stats: { fansFetched: 3, fansCrossed: 0 } });
      expect(next.qualityHold).toBeUndefined();
      expect((await checkpoint(f))?.state).toEqual({ cursorFanId: 0, completedAt: expect.any(String) });
    },
  );

  it("crosses a 404 only on its endpoint's third rejected receipt in a row", async () => {
    const f = await legacy();
    reject(f, ["fan-b"], 404);
    await expect(f.chunk(20)).rejects.toThrow("gone");
    await expect(f.chunk(20)).rejects.toThrow("gone");
    expect((await checkpoint(f))?.state).toMatchObject({ cursorFanId: f.fans[0]!.id });
    expect(await f.chunk(20)).toMatchObject({
      satisfied: true, qualityHold: HOLD, stats: { fansFetched: 1, fansCrossed: 1 },
    });
    expect(f.visits.map((visit) => visit.fanRef)).toEqual([
      "fan-a", "fan-a", "fan-b", "fan-b", "fan-b", "fan-c", "fan-c",
    ]);
    expect(await endpoint(f, "fan-b", "lifetime")).toMatchObject({
      consecutive_failures: 3, consecutive_rejections: 3,
    });
  });

  it("does not count 5xx failures toward a 404's three rejections", async () => {
    const f = await legacy();
    reject(f, ["fan-b"], 503);
    await expect(f.chunk(20)).rejects.toThrow("gone");
    await expect(f.chunk(20)).rejects.toThrow("gone");
    reject(f, ["fan-b"], 404);
    await expect(f.chunk(20)).rejects.toThrow("gone");
    expect(await endpoint(f, "fan-b", "lifetime")).toMatchObject({
      last_refresh_outcome: "rejected", consecutive_failures: 3, consecutive_rejections: 1,
    });
    expect((await checkpoint(f))?.state).toEqual({ cursorFanId: f.fans[0]!.id });
    await expect(f.chunk(20)).rejects.toThrow("gone");
    expect(await f.chunk(20)).toMatchObject({
      satisfied: true, qualityHold: HOLD, stats: { fansCrossed: 1 },
    });
    expect(await endpoint(f, "fan-b", "lifetime")).toMatchObject({
      consecutive_failures: 5, consecutive_rejections: 3,
    });
  });

  it("keeps the stop under a provider cooldown", async () => {
    const f = await legacy();
    reject(f, ["fan-b"], 410, "lifetime", new Date(Date.now() + 3_600_000));
    await expect(f.chunk(20)).rejects.toThrow("gone");
    expect(f.visits.map((visit) => visit.fanRef)).toEqual(["fan-a", "fan-a", "fan-b"]);
    expect((await checkpoint(f))?.state).toEqual({ cursorFanId: f.fans[0]!.id });
  });

  it("keeps the stop when the rejection receipt cannot commit", async () => {
    const f = await legacy();
    await db.pool.query(`create function reject_crossing_receipt() returns trigger language plpgsql as $$
      begin if new.last_refresh_outcome = 'rejected' then raise exception 'receipt unavailable'; end if;
      return new; end $$;
      create trigger reject_crossing_receipt before update on subject_refresh_state
      for each row execute function reject_crossing_receipt()`);
    try {
      reject(f, ["fan-b"], 400);
      await expect(f.chunk(20)).rejects.toThrow("gone");
      expect(f.visits.map((visit) => visit.fanRef)).toEqual(["fan-a", "fan-a", "fan-b"]);
      expect((await checkpoint(f))?.state).toEqual({ cursorFanId: f.fans[0]!.id });
    } finally {
      await db.pool.query(`drop trigger reject_crossing_receipt on subject_refresh_state;
        drop function reject_crossing_receipt()`);
    }
  });

  it("keeps the stop on a page without shadow receipts", async () => {
    const f = await legacy();
    f.app.config.fanslyFanEarningsShadowPageAllowlist = "none";
    reject(f, ["fan-b"], 400);
    await expect(f.chunk(20)).rejects.toThrow("gone");
    expect(f.visits.map((visit) => visit.fanRef)).toEqual(["fan-a", "fan-a", "fan-b"]);
    expect(await f.rows()).toEqual([]);
  });

  it("stops a burst after three crossings in a row across default-budget chunks", async () => {
    const f = await legacy(["fan-c", "fan-d", "fan-e", "fan-f"]);
    reject(f, f.allFans.map((fan) => fan.platformUserId), 400, "monthly");
    // Both calls per fan: a five-request chunk crosses at most two such fans.
    expect(await f.chunk()).toMatchObject({ satisfied: false, stats: { fansCrossed: 2 } });
    expect((await checkpoint(f))?.state).toEqual({
      cursorFanId: f.allFans[1]!.id, crossedFans: 2, consecutiveCrossings: 2,
    });
    const input = await f.chunkInput(5);
    await expect(f.owned(() => executeFanEarningsChunk(f.app, input))).rejects.toThrow("gone");
    const telemetry = input.telemetry as unknown as { addAnomaly: unknown };
    expect(telemetry.addAnomaly).toHaveBeenLastCalledWith(expect.objectContaining({
      details: expect.objectContaining({ platformUserId: "fan-d", crossed: false, consecutiveCrossings: 3 }),
    }));
    const stopped = await checkpoint(f);
    expect(stopped?.state).toEqual({
      cursorFanId: f.allFans[2]!.id, crossedFans: 3, consecutiveCrossings: 3,
    });
    expect(stopped?.cursorLastSucceededRunId ?? null).toBeNull();

    // A retry stops on the same fan while the provider still rejects it.
    await expect(f.chunk()).rejects.toThrow("gone");
    expect(f.visits.slice(-2)).toEqual([
      { fanRef: "fan-d", window: "lifetime" }, { fanRef: "fan-d", window: "monthly" },
    ]);
    expect((await checkpoint(f))?.state).toEqual(stopped?.state);

    // Once the provider answers, the run resets and the walk finishes held.
    f.beforeResponse.mockReset();
    expect(await f.chunk()).toMatchObject({ satisfied: false, stats: { fansFetched: 2 } });
    expect((await checkpoint(f))?.state).toEqual({ cursorFanId: f.allFans[4]!.id, crossedFans: 3 });
    expect(await f.chunk()).toMatchObject({
      satisfied: true, qualityHold: HOLD, stats: { fansFetched: 1, fansCrossed: 0 },
    });
    expect((await checkpoint(f))?.state).toMatchObject({ cursorFanId: 0, crossedFans: 3 });
  });

  it("resets the run of crossings when a fan reads successfully", async () => {
    const f = await legacy(["fan-c", "fan-d", "fan-e"]);
    reject(f, ["fan-a", "fan-b", "fan-c", "fan-e"], 400);
    expect(await f.chunk(40)).toMatchObject({
      satisfied: true, qualityHold: HOLD, stats: { fansFetched: 1, fansCrossed: 4 },
    });
    expect((await checkpoint(f))?.state).toMatchObject({ cursorFanId: 0, crossedFans: 4 });
  });

  it("carries a crossing through a partial chunk without stamping success", async () => {
    const f = await legacy();
    reject(f, ["fan-b"], 400);
    expect(await f.chunk(4)).toMatchObject({ satisfied: false, stats: { fansFetched: 1, fansCrossed: 1 } });
    const partial = await checkpoint(f);
    expect(partial?.state).toEqual({
      cursorFanId: f.fans[1]!.id, crossedFans: 1, consecutiveCrossings: 1,
    });
    expect(partial?.cursorLastSucceededRunId ?? null).toBeNull();
    expect(await f.chunk(20)).toMatchObject({
      satisfied: true, qualityHold: HOLD, stats: { fansFetched: 1, fansCrossed: 0 },
    });
  });
});
