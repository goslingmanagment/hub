import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getCheckpoint, markFanEarningsDirty, upsertCheckpoint } from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { captureFanEarningsEndpoint } from "../apps/runtime/src/services/sync/fan-earnings-capture.ts";
import { executeFanEarningsChunk } from "../apps/runtime/src/services/sync/fan-earnings.ts";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { earningsShadowFixture } from "./helpers/earnings-shadow-fixture.ts";
import { earningsShadowAdapter, type EarningsVisit } from "./helpers/earnings-shadow-adapter.ts";

let db: StartedTestDatabase;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres required");
  db = started;
}, 120000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

describe("earnings shadow preserves daily capture", () => {
  it.each([false, true])("makes exactly the same daily requests with shadow %s", async (shadow) => {
    const f = await earningsShadowFixture(db, shadow);
    const visits: EarningsVisit[] = [];
    f.app.adapter = earningsShadowAdapter(visits);
    const result = await executeFanEarningsChunk(f.app, await f.chunkInput());
    expect(result).toMatchObject({ satisfied: true, stats: { fansFetched: 2 } });
    expect(visits).toEqual(["fan-a", "fan-b"].flatMap((fanRef) => [
      { fanRef, window: "lifetime" }, { fanRef, window: "monthly" },
    ]));
    const rows = await f.rows();
    expect(rows).toHaveLength(shadow ? 4 : 0);
    expect(rows.every((row) => row.refresh_checks === 1n && row.last_checked_observation_id != null)).toBe(true);
    const count = await db.pool.query("select count(*)::int n from observations where account_id = $1", [f.page.id]);
    expect(count.rows[0].n).toBe(4);
  });

  it("journals lifetime before calling a failing monthly endpoint", async () => {
    const f = await earningsShadowFixture(db);
    const failure = new FanslyApiError("monthly rejected", 404);
    f.app.adapter = earningsShadowAdapter([], async ({ window }) => {
      if (window !== "monthly") return;
      const raw = await db.pool.query("select endpoint from sync_raw_payloads where page_id = $1", [f.page.id]);
      const captured = await db.pool.query("select kind from observations where account_id = $1", [f.page.id]);
      expect(raw.rows).toEqual([{ endpoint: "fan_earnings_stats" }]);
      expect(captured.rows).toEqual([{ kind: "fan_earnings_stats" }]);
      throw failure;
    });
    await expect(executeFanEarningsChunk(f.app, await f.chunkInput())).rejects.toBe(failure);
    expect((await f.rows()).map((row) => [row.plane, row.last_refresh_outcome, row.refresh_checks]))
      .toEqual([["fan_earnings_lifetime", "observed", 1n], ["fan_earnings_monthly", "rejected", 0n]]);
  });

  it.each([404, 429])("preserves HTTP %s when storing its failure receipt also fails", async (status) => {
    const f = await earningsShadowFixture(db);
    const retryAt = new Date(Date.now() + 3_600_000);
    const failure = new FanslyApiError("provider failure", status, undefined, undefined, retryAt);
    const visits: EarningsVisit[] = [];
    f.app.adapter = earningsShadowAdapter(visits, async ({ fanRef }) => {
      if (fanRef === "fan-b") throw failure;
    });
    await db.pool.query(`create function reject_failure_receipt() returns trigger language plpgsql as $$
      begin if new.last_refresh_outcome in ('failed', 'rejected') then
        raise exception 'injected receipt failure'; end if; return new; end $$;
      create trigger reject_failure_receipt before update on subject_refresh_state
      for each row execute function reject_failure_receipt()`);
    try {
      await expect(executeFanEarningsChunk(f.app, await f.chunkInput())).rejects.toBe(failure);
      expect(failure.retryAfterAt).toEqual(retryAt);
      expect(visits).toHaveLength(3);
      const failed = (await f.rows()).find((row) => row.subject_ref === "fan-b");
      expect(failed).toMatchObject({ refresh_visits: 1n, refresh_receipts: 0n, last_checked_at: null });
      if (status === 404) {
        expect((await getCheckpoint(db.db, f.page.id, "fan_earnings"))?.state)
          .toMatchObject({ cursorFanId: f.fans[0]!.id });
      }
    } finally {
      await db.pool.query("drop trigger reject_failure_receipt on subject_refresh_state; drop function reject_failure_receipt()");
    }
  });

  it("captures malformed bytes and leaves invalid receipts unconfirmed", async () => {
    const f = await earningsShadowFixture(db);
    const input = await f.chunkInput();
    const payload = { unexpected: "provider shape" };
    await expect(captureFanEarningsEndpoint(f.app, {
      pageId: f.page.id, syncRunId: input.syncRunId,
      fan: { fanId: f.fans[0]!.id, platformUserId: "fan-a" },
      window: "lifetime", after: new Date(0), before: new Date(), shadow: true,
      fetch: async () => ({ items: payload, raw: payload }),
    })).rejects.toThrow("response was not an array");
    expect((await f.rows())[0]).toMatchObject({ last_refresh_outcome: "invalid", last_checked_at: null });
    const observations = await db.pool.query("select payload from observations where account_id = $1", [f.page.id]);
    expect(observations.rows).toEqual([{ payload }]);
  });

  it("preserves the last completed independent sweep across a partial next walk", async () => {
    const f = await earningsShadowFixture(db);
    const completedAt = "2026-09-09T00:00:00.000Z";
    await upsertCheckpoint(db.db, {
      platformAccountId: f.page.id, stream: "fan_earnings", state: { cursorFanId: 0, completedAt },
    });
    f.app.adapter = earningsShadowAdapter([]);
    await executeFanEarningsChunk(f.app, await f.chunkInput(2));
    expect((await getCheckpoint(db.db, f.page.id, "fan_earnings"))?.state)
      .toEqual({ cursorFanId: f.fans[0]!.id, completedAt });
    const report = await db.pool.query("select fansly_earnings_shadow_report($1) report", [f.page.label]);
    expect(new Date(report.rows[0].report.last_completed_daily_spender_sweep).toISOString()).toBe(completedAt);
  });

  it("retains dirty zero, negative and absent fans without expanding daily requests", async () => {
    const f = await earningsShadowFixture(db);
    await db.pool.query("update page_fans set total_creator_net_mills = -1 where fan_id = $1", [f.fans[0]!.id]);
    await db.pool.query("update page_fans set total_creator_net_mills = 0 where fan_id = $1", [f.fans[1]!.id]);
    await db.db.transaction((tx) => markFanEarningsDirty(tx, {
      pageId: f.page.id, fanRefs: ["fan-a", "fan-b", "not-in-roster"], now: new Date(),
    }));
    const visits: EarningsVisit[] = [];
    f.app.adapter = earningsShadowAdapter(visits);
    await executeFanEarningsChunk(f.app, await f.chunkInput());
    expect(visits).toEqual([]);
    expect((await f.rows()).map((row) => row.requested_revision - row.applied_revision))
      .toEqual([1n, 1n, 1n, 1n, 1n, 1n]);
    const report = await db.pool.query("select fansly_earnings_shadow_report($1) report", [f.page.label]);
    expect(report.rows[0].report.endpoints.map((endpoint: { pending_outside_daily_spenders: number }) =>
      endpoint.pending_outside_daily_spenders)).toEqual([3, 3]);
  });
});
