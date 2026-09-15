import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getCheckpoint } from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { executeFanEarningsChunk } from "../apps/runtime/src/services/sync/fan-earnings.ts";
import { earningsTargetFixture } from "./helpers/earnings-target-fixture.ts";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";

let db: Awaited<ReturnType<typeof startTestDatabase>>;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });
async function fixture() {
  const f = await earningsTargetFixture(db);
  Object.assign(f.app.config, { fanslyFanEarningsRecoveryEnabled: true,
    fanslyFanEarningsRecoveryPageAllowlist: f.page.label });
  return f;
}
const readCheckpoint = (pageId: number) => getCheckpoint(db.db, pageId, "fan_earnings");

describe("C2c independent daily recovery", () => {
  it.each([400, 404, 410])("retains endpoint HTTP %s debt while monthly and other fans proceed", async status => {
    const f = await fixture();
    f.beforeResponse.mockImplementation(async (fan, window) => {
      if (fan === "fan-a" && window === "lifetime") throw new FanslyApiError("gone", status);
    });
    expect(await f.chunk(10)).toMatchObject({ satisfied: true, qualityHold: "fan_earnings_unconfirmed_coverage",
      stats: { fansFetched: 2, rejectedEndpoints: 1, unconfirmedEndpoints: 1 } });
    expect(f.visits).toHaveLength(4);
    expect((await f.rows()).find(row => row.subject_ref === "fan-a" && row.plane === "fan_earnings_lifetime"))
      .toMatchObject({ consecutive_failures: 1, last_checked_at: null, last_refresh_outcome: "rejected" });
    expect((await f.rows()).filter(row => row.last_refresh_outcome === "observed")).toHaveLength(3);
    expect((await readCheckpoint(f.page.id))?.cursorLastSucceededAt).toBeNull();
    expect(await f.chunk(10)).toMatchObject({ qualityHold: "fan_earnings_unconfirmed_coverage",
      stats: { reusedCompletedWalk: true } });
    expect(f.visits).toHaveLength(4);
  });

  it.each(["flag", "allowlist", "targets", "budget"])("keeps legacy rejection behavior with disabled %s", async gate => {
    const f = await fixture();
    if (gate === "flag") f.app.config.fanslyFanEarningsRecoveryEnabled = false;
    if (gate === "allowlist") f.app.config.fanslyFanEarningsRecoveryPageAllowlist = "";
    if (gate === "targets") f.app.config.fanslyFanEarningsTargetsEnabled = false;
    if (gate === "budget") f.app.config.fanslyFanEarningsTargetsDailyAttemptLimit = 0;
    const error = new FanslyApiError("gone", 404);
    f.beforeResponse.mockRejectedValueOnce(error);
    await expect(f.chunk(10)).rejects.toBe(error);
    expect(f.visits).toHaveLength(1);
  });

  it.each([401, 403, 429, 500])("stops all work for provider HTTP %s", async status => {
    const f = await fixture();
    const error = new FanslyApiError("provider failed", status);
    f.beforeResponse.mockRejectedValueOnce(error);
    await expect(f.chunk(10)).rejects.toBe(error);
    expect(f.visits).toHaveLength(1);
    expect(await readCheckpoint(f.page.id)).toBeNull();
  });

  it("preserves an absolute cooldown even on a fan-scoped status", async () => {
    const f = await fixture();
    const at = new Date(Date.now() + 3_600_000);
    const error = new FanslyApiError("wait", 404, undefined, undefined, at);
    f.beforeResponse.mockRejectedValueOnce(error);
    await expect(f.chunk(10)).rejects.toBe(error);
    expect(f.visits).toHaveLength(1);
    expect((await f.rows())[0].retry_after_at).toEqual(at);
  });

  it("does not cross a rejection when its debt receipt cannot commit", async () => {
    const f = await fixture();
    await db.pool.query(`create function reject_recovery_receipt() returns trigger language plpgsql as $$ begin
      if new.refresh_receipts > old.refresh_receipts then raise exception 'injected receipt failure'; end if;
      return new; end $$;
      create trigger reject_recovery_receipt before update on subject_refresh_state
      for each row execute function reject_recovery_receipt()`);
    try {
      f.beforeResponse.mockRejectedValueOnce(new FanslyApiError("gone", 404));
      await expect(f.chunk(10)).rejects.toMatchObject({ cause: { message: "injected receipt failure" } });
      expect(f.visits).toHaveLength(1);
      expect(await readCheckpoint(f.page.id)).toBeNull();
    } finally {
      await db.pool.query(`drop trigger reject_recovery_receipt on subject_refresh_state;
        drop function reject_recovery_receipt()`);
    }
  });

  it.each([401, 429])("keeps HTTP %s policy even when its failure receipt cannot commit", async status => {
    const f = await fixture();
    const retryAt = new Date(Date.now() + 3_600_000);
    const error = new FanslyApiError("provider policy", status, undefined, undefined, retryAt);
    await db.pool.query(`create function fail_policy_receipt() returns trigger language plpgsql as $$ begin
      if new.refresh_receipts > old.refresh_receipts then raise exception 'receipt DB unavailable'; end if;
      return new; end $$;
      create trigger fail_policy_receipt before update on subject_refresh_state
      for each row execute function fail_policy_receipt()`);
    try {
      f.beforeResponse.mockRejectedValueOnce(error);
      await expect(f.chunk(10)).rejects.toBe(error);
      expect(f.visits).toHaveLength(1);
      expect(await readCheckpoint(f.page.id)).toBeNull();
    } finally {
      await db.pool.query(`drop trigger fail_policy_receipt on subject_refresh_state;
        drop function fail_policy_receipt()`);
    }
  });

  it("certifies a fresh later read despite a historical missing-receipt audit gap", async () => {
    const f = await fixture();
    await db.pool.query(`create function lose_success_receipt() returns trigger language plpgsql as $$ begin
      if new.refresh_receipts > old.refresh_receipts then raise exception 'lost receipt'; end if;
      return new; end $$;
      create trigger lose_success_receipt before update on subject_refresh_state
      for each row execute function lose_success_receipt()`);
    try {
      await expect(f.chunk(10)).rejects.toMatchObject({ cause: { message: "lost receipt" } });
    } finally {
      await db.pool.query(`drop trigger lose_success_receipt on subject_refresh_state;
        drop function lose_success_receipt()`);
    }
    await db.pool.query("update subject_refresh_state set claim_expires_at=now()-interval '1 second'");
    const result = await f.chunk(10);
    expect(result).toMatchObject({ satisfied: true, stats: { unconfirmedEndpoints: 0 } });
    expect(result.qualityHold).toBeUndefined();
    expect((await f.rows()).some(row => row.refresh_visits > row.refresh_receipts)).toBe(true);
  });

  it.each(["flag", "allowlist"])("cancels age-only admission when recovery %s turns off before transport", async gate => {
    const f = await fixture();
    await f.chunk(10);
    await db.pool.query(`update subject_refresh_state set last_checked_at=now()-interval '25 hours',next_due_at=null`);
    f.beforeDispatch.mockImplementation(async () => {
      if (gate === "flag") f.app.config.fanslyFanEarningsRecoveryEnabled = false;
      else f.app.config.fanslyFanEarningsRecoveryPageAllowlist = "";
    });
    await f.step();
    await f.step();
    expect(f.visits).toHaveLength(4);
    expect(await f.attempts()).toBe(0);
    expect((await f.rows()).every(row => row.refresh_visits === 1n && row.refresh_receipts === 1n
      && row.claim_token === null && row.next_due_at === null)).toBe(true);
  });

  it("resumes the independent roster after a deferred fan, and disabling starts legacy at zero", async () => {
    const f = await fixture();
    f.beforeResponse.mockImplementation(async (fan, window) => {
      if (fan === "fan-a" && window === "lifetime") throw new FanslyApiError("gone", 404);
    });
    expect(await f.chunk(2)).toMatchObject({ satisfied: false });
    expect((await readCheckpoint(f.page.id))?.state).toMatchObject({ recoveryCursorFanId: f.fans[0]!.id });
    expect(await f.chunk(2)).toMatchObject({ satisfied: false });
    expect(f.visits.slice(2).map(v => v.fanRef)).toEqual(["fan-b", "fan-b"]);
    f.app.config.fanslyFanEarningsRecoveryEnabled = false;
    await expect(f.chunk(2)).rejects.toBeInstanceOf(FanslyApiError);
    expect(f.visits.at(-1)?.fanRef).toBe("fan-a");
  });

  it("certifies a fully checked roster once and preserves its read time on settlement retry", async () => {
    const f = await fixture();
    const result = await f.chunk(10);
    expect(result).toMatchObject({ satisfied: true, stats: { unconfirmedEndpoints: 0 } });
    expect(result.qualityHold).toBeUndefined();
    const completed = await readCheckpoint(f.page.id);
    expect(await f.chunk(10)).toMatchObject({ succeededAt: completed?.cursorLastSucceededAt,
      stats: { reusedCompletedWalk: true } });
    expect(f.visits).toHaveLength(4);
    expect(await readCheckpoint(f.page.id)).toEqual(completed);
  });

  it("rechecks known zero-net endpoints after 24h without a dirty signal and obeys the cap", async () => {
    const f = await fixture();
    await f.chunk(10);
    await db.pool.query("update page_fans set total_creator_net_mills=0 where platform_account_id=$1", [f.page.id]);
    await db.pool.query(`update subject_refresh_state set last_checked_at=now()-interval '25 hours',
      last_content_fingerprint='old',next_due_at=null where page_id=$1`, [f.page.id]);
    f.app.config.fanslyFanEarningsTargetsDailyAttemptLimit = 1;
    await f.step();
    await f.step();
    expect(await f.attempts()).toBe(1);
    expect(f.visits).toHaveLength(5);
    expect((await f.rows()).filter(row => row.unsignaled_changes === 1n)).toHaveLength(1);
    // Missing coverage is still debt; one fresh endpoint cannot certify the page.
    const input = await f.chunkInput(10);
    f.execution.requestSeq++;
    await db.pool.query(`update page_sync_states set request_seq=request_seq+1, leased_seq=leased_seq+1
      where page_id=$1 and stream='fan_earnings'`, [f.page.id]);
    expect(await f.owned(() => executeFanEarningsChunk(f.app, input))).toMatchObject({
      qualityHold: "fan_earnings_unconfirmed_coverage", stats: { unconfirmedEndpoints: 3 },
    });
  });
});
