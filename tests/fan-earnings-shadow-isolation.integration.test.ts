import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquirePageSyncLease, getCheckpoint, runWithPageSyncExecutionContext,
} from "@agency_hub_core/db";
import { executeFanEarningsChunk } from "../apps/runtime/src/services/sync/fan-earnings.ts";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { earningsShadowFixture } from "./helpers/earnings-shadow-fixture.ts";
import { earningsShadowAdapter, type EarningsVisit } from "./helpers/earnings-shadow-adapter.ts";

let db: StartedTestDatabase;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

describe("C2b diagnostics do not restart captured earnings walks", () => {
  it.each(["lifetime", "monthly"])("finishes the same generation when its %s receipt cannot be stored", async (window) => {
    const f = await earningsShadowFixture(db);
    await db.pool.query(`update page_sync_states set applied_seq = request_seq
      where page_id = $1 and stream <> 'fan_earnings'`, [f.page.id]);
    const leaseToken = "shadow-isolation-test";
    const lease = await acquirePageSyncLease(db.db, {
      pageId: f.page.id, workerId: "shadow-isolation-test", leaseToken, leaseTtlMs: 60_000,
    });
    if (!lease || lease.stream !== "fan_earnings") throw new Error("Expected earnings page lease");
    const visits: EarningsVisit[] = [];
    f.app.adapter = earningsShadowAdapter(visits);
    await db.pool.query(`create function reject_success_receipt() returns trigger language plpgsql as $$
      begin if new.last_refresh_outcome = 'observed' and
        new.plane = 'fan_earnings_${window}' then
        raise exception 'injected diagnostic receipt failure';
      end if; return new; end $$;
      create trigger reject_success_receipt before update on subject_refresh_state
      for each row execute function reject_success_receipt()`);
    try {
      await runWithPageSyncExecutionContext({
        pageId: f.page.id, stream: lease.stream,
        requestSeq: lease.leasedSeq ?? lease.requestSeq, leaseToken,
      }, async () => {
        const first = await executeFanEarningsChunk(f.app, await f.chunkInput());
        expect(first).toMatchObject({ satisfied: true, stats: { fansFetched: 2 } });
        const checkpoint = await getCheckpoint(db.db, f.page.id, "fan_earnings");
        expect(checkpoint?.state).toMatchObject({ cursorFanId: 0, completedAt: expect.any(String) });
        const second = await executeFanEarningsChunk(f.app, await f.chunkInput());
        expect(second).toMatchObject({ stats: { fansFetched: 0, reusedCompletedWalk: true } });
        expect(await getCheckpoint(db.db, f.page.id, "fan_earnings")).toEqual(checkpoint);
      });
      expect(visits).toEqual(["fan-a", "fan-b"].flatMap(fanRef => [
        { fanRef, window: "lifetime" }, { fanRef, window: "monthly" },
      ]));
      const captured = await db.pool.query(
        "select count(*)::int n from observations where account_id = $1", [f.page.id],
      );
      expect(captured.rows[0].n).toBe(4);
      const missing = (await f.rows()).filter(row => row.plane === `fan_earnings_${window}`);
      expect(missing).toHaveLength(2);
      for (const row of missing) {
        expect(row).toMatchObject({ refresh_visits: 1n, refresh_receipts: 0n, last_checked_at: null });
      }
    } finally {
      await db.pool.query(`drop trigger reject_success_receipt on subject_refresh_state;
        drop function reject_success_receipt()`);
    }
  });
});
