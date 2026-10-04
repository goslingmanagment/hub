import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimFanEarningsRotation, countFanEarningsRecoveryDebt, markFanEarningsDirty, renewFanEarningsClaim,
  settleFanEarningsReceipt,
  withOwnedPageSyncTransaction,
  type FanEarningsClaim,
} from "@agency_hub_core/db";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { earningsShadowFixture } from "./helpers/earnings-shadow-fixture.ts";

let db: StartedTestDatabase;
let f: Awaited<ReturnType<typeof earningsShadowFixture>>;
const at = (seconds: number) => new Date(Date.now() + seconds * 1000);
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres required");
  db = started;
}, 120000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  f = await earningsShadowFixture(db);
});

async function claim(seconds = 0, window: "lifetime" | "monthly" = "lifetime") {
  const result = await claimFanEarningsRotation(db.db, { pageId: f.page.id, fanRef: "fan-a", window, now: at(seconds) });
  if (!result) throw new Error("Claim unavailable");
  return result;
}
async function dirty(statusOnly = false, seconds = 0) {
  const now = at(seconds);
  await db.db.transaction((tx) => markFanEarningsDirty(tx, {
    pageId: f.page.id, fanRefs: ["fan-a"], now, statusOnly,
  }));
  return now;
}
async function settle(token: FanEarningsClaim, fingerprint: string, seconds = 1) {
  return settleFanEarningsReceipt(db.db, token, {
    outcome: "observed", observationId: await f.observation(),
    fingerprint: fingerprint.repeat(64), checkedAt: at(seconds),
  });
}
async function lifetime() { return (await f.rows()).find((row) => row.plane === "fan_earnings_lifetime"); }

describe("Fansly earnings revision and endpoint receipts", () => {
  it("separates first baseline, checked time, changed time and unsignaled changes", async () => {
    await settle(await claim(), "a");
    expect(await lifetime()).toMatchObject({ refresh_checks: 1n, refresh_changes: 0n, last_changed_at: null });
    await settle(await claim(2), "a", 3);
    expect(await lifetime()).toMatchObject({ refresh_checks: 2n, refresh_changes: 0n });
    await settle(await claim(4), "b", 5);
    expect(await lifetime()).toMatchObject({ refresh_checks: 3n, refresh_changes: 1n, unsignaled_changes: 1n });
  });

  it("confirms an unchanged recheck of a baseline first seen after the signal, never the first baseline", async () => {
    const signalAt = await dirty();
    expect((await lifetime()).earnings_content_signal_at).toEqual(signalAt);
    await settle(await claim(), "a");
    expect(await lifetime()).toMatchObject({
      requested_revision: 1n, applied_revision: 0n, last_refresh_outcome: "unconfirmed",
      content_baseline_revision: 1n, refresh_changes: 0n,
    });
    expect((await lifetime()).retry_after_at).toBeInstanceOf(Date);
    const baselineAt = (await lifetime()).content_baseline_at;
    expect(baselineAt).toBeInstanceOf(Date);
    await settle(await claim(2), "a", 3);
    expect(await lifetime()).toMatchObject({
      requested_revision: 1n, applied_revision: 1n, last_refresh_outcome: "observed",
      refresh_class: null, next_due_at: null, retry_after_at: null,
      content_baseline_at: baselineAt, refresh_changes: 0n, last_changed_at: null,
    });
  });

  it("keeps an unchanged recheck strict when the baseline predates the signal", async () => {
    await settle(await claim(), "a");
    await dirty();
    await settle(await claim(2), "a", 3);
    await settle(await claim(4), "a", 5);
    expect(await lifetime()).toMatchObject({
      requested_revision: 1n, applied_revision: 0n, last_refresh_outcome: "unconfirmed",
      content_baseline_revision: 0n,
    });
    await settle(await claim(6), "b", 7);
    expect(await lifetime()).toMatchObject({
      applied_revision: 1n, last_refresh_outcome: "observed", content_baseline_revision: 1n,
    });
  });

  it("keeps a content signal that arrives during the baseline fetch strict", async () => {
    await dirty();
    const r = await claim();
    await dirty(false, 1);
    await settle(r, "a");
    await settle(await claim(2), "a", 3);
    expect(await lifetime()).toMatchObject({
      requested_revision: 2n, applied_revision: 0n, content_baseline_revision: 1n,
      last_refresh_outcome: "unconfirmed",
    });
    await settle(await claim(4), "b", 5);
    expect(await lifetime()).toMatchObject({ applied_revision: 2n, content_baseline_revision: 2n });
  });

  it("settles a money signal and a later status signal both seen before the first baseline", async () => {
    const signalAt = await dirty();
    await dirty(true, 1);
    // A status-only mark keeps the money signal's revision and time.
    expect(await lifetime()).toMatchObject({
      requested_revision: 2n, earnings_content_revision: 1n, earnings_content_signal_at: signalAt,
    });
    await settle(await claim(2), "a", 3);
    expect(await lifetime()).toMatchObject({ applied_revision: 0n, last_refresh_outcome: "unconfirmed" });
    await settle(await claim(4), "a", 5);
    expect(await lifetime()).toMatchObject({ applied_revision: 2n, last_refresh_outcome: "observed" });
  });

  it("settles only claim R while a concurrent R+1 remains pending", async () => {
    await settle(await claim(), "a");
    await dirty();
    const r = await claim(2);
    await dirty();
    expect(await settle(r, "b", 3)).toBe(true);
    expect(await lifetime()).toMatchObject({ requested_revision: 2n, applied_revision: 1n, refresh_class: "dirty" });
    expect(await settle(r, "c", 4)).toBe(false);
    expect((await lifetime()).refresh_checks).toBe(2n);
  });

  it("counts unclaimed visits and rejects expired or replaced tokens", async () => {
    const first = await claim();
    expect(await claimFanEarningsRotation(db.db, {
      pageId: f.page.id, fanRef: "fan-a", window: "lifetime", now: at(1),
    })).toBeNull();
    expect(await settle(first, "a", 301)).toBe(false);
    const replacement = await claim(302);
    expect(await settle(first, "a", 303)).toBe(false);
    expect(await settle(replacement, "b", 304)).toBe(true);
    expect(await lifetime()).toMatchObject({ refresh_visits: 3n, refresh_receipts: 1n, refresh_checks: 1n });
  });

  it("renews an elapsed unchanged claim and settles only its pre-fetch revision", async () => {
    await settle(await claim(), "a");
    await dirty();
    const original = await claim(2);
    await dirty();
    const checkedAt = at(303);
    const receipt = {
      outcome: "observed" as const, observationId: await f.observation(),
      fingerprint: "b".repeat(64), checkedAt,
    };
    expect(await settleFanEarningsReceipt(db.db, original, receipt)).toBe(false);
    await withOwnedPageSyncTransaction(db.db, async (tx) => {
      expect(await renewFanEarningsClaim(tx, original, checkedAt)).toBe(true);
      expect(await settleFanEarningsReceipt(tx, original, receipt)).toBe(true);
    });
    expect(await lifetime()).toMatchObject({
      requested_revision: 2n, applied_revision: 1n, refresh_class: "dirty",
      refresh_visits: 2n, refresh_receipts: 2n, refresh_checks: 2n,
      last_checked_at: checkedAt, claim_token: null,
    });
  });

  it("cannot renew a replaced, mismatched or completed claim", async () => {
    await dirty();
    const original = await claim();
    await dirty();
    const replacement = await claim(301);
    const before = await lifetime();
    expect(await renewFanEarningsClaim(db.db, original, at(302))).toBe(false);
    expect(await renewFanEarningsClaim(db.db, {
      ...replacement, revision: original.revision,
    }, at(302))).toBe(false);
    expect(await lifetime()).toEqual(before);
    expect(await settle(replacement, "b", 303)).toBe(true);
    expect(await renewFanEarningsClaim(db.db, replacement, at(304))).toBe(false);
    expect(await lifetime()).toMatchObject({ refresh_visits: 2n, refresh_receipts: 1n, claim_token: null });
  });

  it("keeps lifetime and monthly independent and preserves valid provenance after failures", async () => {
    await settle(await claim(), "a");
    const old = await lifetime();
    await dirty();
    const life = await claim(2);
    const month = await claim(2, "monthly");
    await settle(life, "b", 3);
    const retry = at(3600);
    await settleFanEarningsReceipt(db.db, month, {
      outcome: "rejected", observationId: null, fingerprint: null, checkedAt: at(3), retryAfterAt: retry,
    });
    const rows = await f.rows();
    expect(rows.find((row) => row.plane === "fan_earnings_monthly"))
      .toMatchObject({ applied_revision: 0n, last_checked_at: null, last_refresh_outcome: "rejected", retry_after_at: retry });
    await settleFanEarningsReceipt(db.db, await claim(4), {
      outcome: "empty", observationId: await f.observation(), fingerprint: null, checkedAt: at(5),
    });
    const lifeAfter = await lifetime();
    expect(lifeAfter.refresh_checks).toBe(2n);
    expect(lifeAfter.last_checked_observation_id).not.toBe(old.last_checked_observation_id);
    expect(lifeAfter.last_checked_observation_id).not.toBe(lifeAfter.last_receipt_observation_id);
    expect(lifeAfter.last_content_fingerprint).toBe("b".repeat(64));
  });

  it("counts an endpoint's rejections in a row apart from its other failures", async () => {
    const fail = async (outcome: "rejected" | "failed", seconds: number) =>
      settleFanEarningsReceipt(db.db, await claim(seconds), {
        outcome, observationId: null, fingerprint: null, checkedAt: at(seconds + 1),
      });
    await fail("rejected", 0);
    await fail("rejected", 2);
    expect(await lifetime()).toMatchObject({ consecutive_failures: 2, consecutive_rejections: 2 });
    await fail("failed", 4);
    expect(await lifetime()).toMatchObject({ consecutive_failures: 3, consecutive_rejections: 0 });
    await fail("rejected", 6);
    expect(await lifetime()).toMatchObject({ consecutive_failures: 4, consecutive_rejections: 1 });
    await settle(await claim(8), "a", 9);
    expect(await lifetime()).toMatchObject({ consecutive_failures: 0, consecutive_rejections: 0 });
  });

  it("counts recovery debt until each endpoint holds a fresh observed receipt", async () => {
    const hour = 3_600_000;
    const debt = (seconds: number) => countFanEarningsRecoveryDebt(db.db, f.page.id, at(seconds), hour);
    await settle(await claim(), "a");
    expect(await debt(2)).toBe(0);
    const monthly = await claim(2, "monthly");
    // A claimed endpoint is not covered until its receipt settles.
    expect(await debt(2)).toBe(1);
    await settle(monthly, "a", 3);
    expect(await debt(4)).toBe(0);
    // Checked before the window: both endpoints are debt again.
    expect(await debt(4 + 3600)).toBe(2);
    // A dirty mark is debt inside the window.
    await dirty(false, 5);
    expect(await debt(6)).toBe(2);
  });

  it("reports per-endpoint ages, uncovered roster and receipt loss without fan identities", async () => {
    await dirty();
    await db.pool.query("update page_fans set total_creator_net_mills = 0");
    await claim();
    const report = (await db.pool.query("select fansly_earnings_shadow_report($1) report", [f.page.label])).rows[0].report;
    expect(report.tracked_scope_complete).toBe(false);
    expect(report.endpoints).toHaveLength(2);
    expect(report.endpoints[0]).toMatchObject({ never_checked: 1, pending_outside_daily_spenders: 1, missing_or_inflight_receipts: 1 });
    expect(JSON.stringify(report)).not.toContain("fan-a");
  });

  it("grants the report to a restricted reader without exposing the queue", async () => {
    const role = "c2b_fixture_reader";
    await db.pool.query(`create role ${role}; grant execute on function fansly_earnings_shadow_report(text) to ${role}`);
    const client = await db.pool.connect();
    try {
      await client.query("begin read only");
      await client.query(`set local role ${role}`);
      const report = await client.query("select fansly_earnings_shadow_report($1)", [f.page.label]);
      expect(report.rows).toHaveLength(1);
      await expect(client.query("select * from subject_refresh_state")).rejects.toThrow(/permission denied/);
    } finally {
      await client.query("rollback"); client.release();
      await db.pool.query(`drop owned by ${role}; drop role ${role}`);
    }
  });
});
