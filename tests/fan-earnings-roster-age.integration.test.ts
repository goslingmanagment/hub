// Decision 368: an age-aware daily Fansly earnings roster. A spender whose two
// endpoints were both validly checked inside the configured window is skipped
// WITHOUT HTTP; everything dirty, failed, cooling down, half-covered or never
// checked is still read, and the key at 0 keeps today's walk byte-identical.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countFanEarningsRecoveryDebt, getCheckpoint, upsertFanPages, upsertFans,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import { earningsTargetFixture } from "./helpers/earnings-target-fixture.ts";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";

let db: Awaited<ReturnType<typeof startTestDatabase>>;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

type Fixture = Awaited<ReturnType<typeof earningsTargetFixture>>;

/** The spender roster is keyset-ordered by fan id, so the seeding order here is
 * also the walk order. Every seeded fan is a spender (page_fans net > 0). */
async function addSpenders(pageId: number, refs: string[]) {
  const fans = await upsertFans(db.db, refs.map((platformUserId) => ({
    platform: "fansly" as const, platformUserId, username: platformUserId,
  })));
  await upsertFanPages(db.db, fans.map((fan) => ({ fanId: fan.id, platformAccountId: pageId })));
  await db.pool.query(
    "update page_fans set total_creator_net_mills=100 where platform_account_id=$1", [pageId]);
  return fans;
}

/** A completed walk parks the cursor at 0 and the executor reuses it for the
 * SAME generation; the next daily walk is a new request generation. */
async function nextGeneration(f: Fixture) {
  f.execution.requestSeq++;
  await db.pool.query(`update page_sync_states set request_seq=request_seq+1, leased_seq=leased_seq+1
    where page_id=$1 and stream='fan_earnings'`, [f.page.id]);
}

/** Ordinary (non-recovery) roster: the addressed C2c lane is off so every
 * provider visit in these tests belongs to the daily walk itself. */
async function roster(hours: number, extraSpenders: string[] = []) {
  const f = await earningsTargetFixture(db);
  Object.assign(f.app.config, {
    fanslyFanEarningsTargetsEnabled: false,
    fanslyFanEarningsRosterMaxAgeHours: hours,
  });
  if (extraSpenders.length) await addSpenders(f.page.id, extraSpenders);
  return f;
}

const pairs = (refs: string[]) => refs.flatMap((fanRef) => [
  { fanRef, window: "lifetime" }, { fanRef, window: "monthly" },
]);

describe("age-aware fan-earnings roster", () => {
  it("reads every spender on every walk while the key is zero", async () => {
    const f = await roster(0);
    expect(await f.chunk(20)).toMatchObject({
      satisfied: true, stats: { fansFetched: 2, fansFresh: 0, walkCompleted: true },
    });
    expect(f.visits).toEqual(pairs(["fan-a", "fan-b"]));

    await nextGeneration(f);
    expect(await f.chunk(20)).toMatchObject({
      satisfied: true, stats: { fansFetched: 2, fansFresh: 0, walkCompleted: true },
    });
    expect(f.visits).toEqual(pairs(["fan-a", "fan-b", "fan-a", "fan-b"]));
    expect(await f.attempts()).toBe(0);
  });

  it("skips only fully fresh spenders and still reads every other class", async () => {
    const f = await roster(48, ["fan-c", "fan-d", "fan-f"]);
    await f.chunk(40);
    expect(f.visits).toEqual(pairs(["fan-a", "fan-b", "fan-c", "fan-d", "fan-f"]));

    // fan-b keeps a receipt for one plane only.
    await db.pool.query(`delete from subject_refresh_state
      where page_id=$1 and subject_ref='fan-b' and plane='fan_earnings_monthly'`, [f.page.id]);
    // fan-c's last receipt failed after an earlier valid check.
    await db.pool.query(`update subject_refresh_state set last_refresh_outcome='failed',
      consecutive_failures=1 where page_id=$1 and subject_ref='fan-c'
        and plane='fan_earnings_lifetime'`, [f.page.id]);
    // fan-d carries a dirty transaction signal.
    await f.dirty(["fan-d"]);
    // fan-f is inside a provider cooldown.
    await db.pool.query(`update subject_refresh_state set retry_after_at=now()+interval '1 hour'
      where page_id=$1 and subject_ref='fan-f' and plane='fan_earnings_monthly'`, [f.page.id]);
    // fan-e was never checked at all.
    await addSpenders(f.page.id, ["fan-e"]);

    await nextGeneration(f);
    expect(await f.chunk(40)).toMatchObject({
      satisfied: true, stats: { fansFetched: 5, fansFresh: 1, walkCompleted: true },
    });
    expect(f.visits.slice(10)).toEqual(pairs(["fan-b", "fan-c", "fan-d", "fan-f", "fan-e"]));
    expect((await getCheckpoint(db.db, f.page.id, "fan_earnings"))?.state)
      .toMatchObject({ cursorFanId: 0 });
  });

  it("advances the persisted cursor across skipped fans and stops at a rejection", async () => {
    const f = await roster(48, ["fan-c"]);
    await f.chunk(40);
    const completed = await getCheckpoint(db.db, f.page.id, "fan_earnings");

    await f.dirty(["fan-c"]);
    f.beforeResponse.mockImplementation(async (fanRef) => {
      if (fanRef === "fan-c") throw new FanslyApiError("gone", 404);
    });
    await nextGeneration(f);
    await expect(f.chunk(40)).rejects.toThrow("gone");

    // fan-a and fan-b were skipped, so the contiguous prefix covers them; the
    // rejected fan stays the next keyset row and this run stamps no success.
    expect(f.visits.slice(6)).toEqual([{ fanRef: "fan-c", window: "lifetime" }]);
    const checkpoint = await getCheckpoint(db.db, f.page.id, "fan_earnings");
    expect(checkpoint?.state).toMatchObject({ cursorFanId: f.fans[1]!.id });
    expect(checkpoint?.cursorLastSucceededRunId).toBe(completed?.cursorLastSucceededRunId);
    expect(checkpoint?.cursorLastSucceededAt).toEqual(completed?.cursorLastSucceededAt);
  });

  it("does not report skipped spenders as unconfirmed coverage in recovery mode", async () => {
    const f = await earningsTargetFixture(db);
    Object.assign(f.app.config, {
      fanslyFanEarningsRecoveryEnabled: true,
      fanslyFanEarningsRecoveryPageAllowlist: f.page.label,
      fanslyFanEarningsRosterMaxAgeHours: 48,
    });
    expect(await f.chunk(20)).toMatchObject({
      satisfied: true, stats: { fansFetched: 2, walkCompleted: true, unconfirmedEndpoints: 0 },
    });
    expect(f.visits).toHaveLength(4);

    // Older than the 24h recovery/target age, younger than the 48h roster.
    await db.pool.query(
      "update subject_refresh_state set last_checked_at=now()-interval '30 hours' where page_id=$1",
      [f.page.id]);
    await nextGeneration(f);
    const second = await f.chunk(20);
    expect(second.qualityHold).toBeUndefined();
    expect(second).toMatchObject({
      satisfied: true,
      stats: { fansFetched: 0, fansFresh: 2, walkCompleted: true, unconfirmedEndpoints: 0 },
    });
    // Neither the roster nor the addressed lane re-read inside the roster age.
    expect(f.visits).toHaveLength(4);
    expect(await f.attempts()).toBe(0);
  });

  it("reads everything again as soon as the key returns to zero", async () => {
    const f = await roster(48);
    await f.chunk(20);
    expect(f.visits).toHaveLength(4);

    await nextGeneration(f);
    expect(await f.chunk(20)).toMatchObject({
      satisfied: true, stats: { fansFetched: 0, fansFresh: 2, walkCompleted: true },
    });
    expect(f.visits).toHaveLength(4);

    f.app.config.fanslyFanEarningsRosterMaxAgeHours = 0;
    await nextGeneration(f);
    expect(await f.chunk(20)).toMatchObject({
      satisfied: true, stats: { fansFetched: 2, fansFresh: 0, walkCompleted: true },
    });
    expect(f.visits).toEqual(pairs(["fan-a", "fan-b", "fan-a", "fan-b"]));
  });
  it("never skips a page that is not in the shadow allowlist", async () => {
    // Receipts alone are not enough: only a shadow page dirties a fan when a new
    // transaction arrives, so only a shadow page may trust one.
    const f = await roster(48);
    await f.chunk(20);
    expect(f.visits).toHaveLength(4);

    f.app.config.fanslyFanEarningsShadowPageAllowlist = "none";
    await nextGeneration(f);
    expect(await f.chunk(20)).toMatchObject({
      satisfied: true, stats: { fansFetched: 2, fansFresh: 0, walkCompleted: true },
    });
    expect(f.visits).toHaveLength(8);
  });

  it("never skips in recovery mode without the shadow allowlist", async () => {
    // Recovery writes receipts of its own; without the shadow write path nothing
    // would re-read a skipped fan before the window expired.
    const f = await earningsTargetFixture(db);
    Object.assign(f.app.config, {
      fanslyFanEarningsShadowPageAllowlist: "none",
      fanslyFanEarningsRecoveryEnabled: true,
      fanslyFanEarningsRecoveryPageAllowlist: f.page.label,
      fanslyFanEarningsRosterMaxAgeHours: 48,
    });
    expect(await f.chunk(20)).toMatchObject({ satisfied: true, stats: { fansFetched: 2 } });
    expect(f.visits).toHaveLength(4);

    await nextGeneration(f);
    expect(await f.chunk(20)).toMatchObject({
      satisfied: true, stats: { fansFetched: 2, fansFresh: 0, walkCompleted: true },
    });
    expect(f.visits).toHaveLength(8);
  });

  it("anchors recovery coverage debt to the walk start, not its completion", async () => {
    const f = await earningsTargetFixture(db);
    Object.assign(f.app.config, {
      fanslyFanEarningsRecoveryEnabled: true,
      fanslyFanEarningsRecoveryPageAllowlist: f.page.label,
      fanslyFanEarningsRosterMaxAgeHours: 48,
    });
    await addSpenders(f.page.id, ["fan-c"]);
    await f.chunk(20);
    expect(f.visits).toHaveLength(6);

    // fan-a is one hour short of the 48h window; fan-b and fan-c must be read.
    await db.pool.query(
      "update subject_refresh_state set last_checked_at=now()-interval '47 hours' where page_id=$1",
      [f.page.id]);
    await db.pool.query(`delete from subject_refresh_state where page_id=$1
      and subject_ref in ('fan-b','fan-c')`, [f.page.id]);

    // Two-request chunks: the addressed lane needs three, so every visit below
    // belongs to the roster and the walk spans three chunks.
    await nextGeneration(f);
    expect(await f.chunk(2)).toMatchObject({ satisfied: false, stats: { fansFetched: 1, fansFresh: 1 } });
    expect(await f.chunk(2)).toMatchObject({ satisfied: false, stats: { fansFetched: 1, fansFresh: 0 } });

    // Simulate two hours passing inside the walk: fan-a's receipts and the
    // walk's own start move back, the wall clock plays the later moment.
    const running = await getCheckpoint(db.db, f.page.id, "fan_earnings");
    const startedAt = (running?.state as { walkStartedAt?: string } | null)?.walkStartedAt;
    expect(typeof startedAt).toBe("string");
    const shifted = new Date(Date.parse(startedAt!) - 2 * 3_600_000).toISOString();
    await db.pool.query(
      "update subject_refresh_state set last_checked_at=last_checked_at-interval '2 hours' where page_id=$1",
      [f.page.id]);
    await db.pool.query(`update page_sync_cursors
      set state=jsonb_set(state,'{walkStartedAt}',to_jsonb($2::text))
      where page_id=$1 and stream='fan_earnings'`, [f.page.id, shifted]);

    // Counted at completion fan-a has drifted past 48h and would hold the run;
    // counted at the walk's start it is exactly what the roster skipped.
    const window = 48 * 3_600_000;
    expect(await countFanEarningsRecoveryDebt(db.db, f.page.id, new Date(), window))
      .toBeGreaterThan(0);
    expect(await countFanEarningsRecoveryDebt(db.db, f.page.id, new Date(shifted), window)).toBe(0);

    const completion = await f.chunk(2);
    expect(completion.qualityHold).toBeUndefined();
    expect(completion.succeededAt).toBeInstanceOf(Date);
    expect(completion).toMatchObject({
      satisfied: true, stats: { walkCompleted: true, unconfirmedEndpoints: 0 },
    });
    expect(f.visits.slice(6).map((visit) => visit.fanRef))
      .toEqual(["fan-b", "fan-b", "fan-c", "fan-c"]);
    expect(await f.attempts()).toBe(0);
  });
});
