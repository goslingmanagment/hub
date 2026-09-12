import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertFanslyTransactionWithEarningsDirty, upsertTransaction } from "@agency_hub_core/db";
import { millsFromInteger } from "@agency_hub_core/shared";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { earningsShadowFixture } from "./helpers/earnings-shadow-fixture.ts";

let db: StartedTestDatabase;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres required");
  db = started;
}, 120000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

describe("Fansly semantic transaction dirty intents", () => {
  it("marks both endpoints on insert but ignores identical and bookkeeping-only upserts", async () => {
    const f = await earningsShadowFixture(db);
    await upsertFanslyTransactionWithEarningsDirty(db.db, f.transaction);
    await upsertFanslyTransactionWithEarningsDirty(db.db, f.transaction);
    await upsertFanslyTransactionWithEarningsDirty(db.db, {
      ...f.transaction, sourceUpdatedAt: new Date(), scanToken: "another-scan", newBalanceMills: millsFromInteger(99),
    });
    const rows = await f.rows();
    expect(rows.map((row) => [row.plane, row.subject_ref, row.requested_revision]))
      .toEqual([["fan_earnings_lifetime", "fan-a", 1n], ["fan_earnings_monthly", "fan-a", 1n]]);
  });

  it.each([
    { rawStatus: 2, transactionState: "posted" as const },
    { grossAmountMills: millsFromInteger(0), creatorNetAmountMills: millsFromInteger(-80) },
    { rawType: 1, canonicalType: "other" as const },
    { senderId: "new-sender" },
    { occurredAt: new Date("2026-01-02T00:00:00Z") },
    { suppressAs: "superseded_duplicate_negation" as const },
  ])("observes same-ID semantic changes and later A-B-A", async (change) => {
    const f = await earningsShadowFixture(db);
    await upsertFanslyTransactionWithEarningsDirty(db.db, f.transaction);
    await upsertFanslyTransactionWithEarningsDirty(db.db, { ...f.transaction, ...change });
    const after = await f.rows();
    expect(after.map((row) => row.requested_revision)).toEqual([2n, 2n]);
    await upsertFanslyTransactionWithEarningsDirty(db.db, f.transaction);
    const sticky = "suppressAs" in change;
    expect((await f.rows()).map((row) => row.requested_revision)).toEqual(sticky ? [2n, 2n] : [3n, 3n]);
  });

  it("dirties old and new fan bindings even when their spend is zero or negative", async () => {
    const f = await earningsShadowFixture(db);
    await db.pool.query("update page_fans set total_creator_net_mills = -1");
    await upsertFanslyTransactionWithEarningsDirty(db.db, f.transaction);
    await upsertFanslyTransactionWithEarningsDirty(db.db, {
      ...f.transaction, fanId: f.fans[1]!.id, correlationAccountId: "fan-b",
    });
    expect((await f.rows()).map((row) => [row.subject_ref, row.requested_revision]))
      .toEqual([["fan-a", 2n], ["fan-a", 2n], ["fan-b", 1n], ["fan-b", 1n]]);
  });

  it("retains a native target without a local fan and separates unknown attribution", async () => {
    const f = await earningsShadowFixture(db);
    await upsertFanslyTransactionWithEarningsDirty(db.db, {
      ...f.transaction, fanId: null, correlationAccountId: "not-in-roster",
    });
    await upsertFanslyTransactionWithEarningsDirty(db.db, {
      ...f.transaction, transactionId: "unknown", fanId: null, correlationAccountId: null,
    });
    expect((await f.rows()).map((row) => row.subject_ref)).toEqual(["not-in-roster", "not-in-roster", "unknown"]);
    await upsertFanslyTransactionWithEarningsDirty(db.db, { ...f.transaction, transactionId: "unknown" });
    const unknown = (await f.rows()).find((row) => row.subject_ref === "unknown");
    expect(unknown).toMatchObject({ requested_revision: 1n, applied_revision: 1n, last_refresh_outcome: "binding_resolved" });
  });

  it("retains the old local binding when a sparse prior transaction has no correlation ref", async () => {
    const f = await earningsShadowFixture(db);
    await upsertTransaction(db.db, { ...f.transaction, correlationAccountId: null });
    await upsertFanslyTransactionWithEarningsDirty(db.db, {
      ...f.transaction, fanId: f.fans[1]!.id, correlationAccountId: "fan-b",
    });
    expect((await f.rows()).map((row) => row.subject_ref)).toEqual(["fan-a", "fan-a", "fan-b", "fan-b"]);
  });

  it("rolls back the transaction if either endpoint's dirty intent fails", async () => {
    const f = await earningsShadowFixture(db);
    await db.pool.query(`create function reject_monthly_dirty() returns trigger language plpgsql as $$
      begin if new.plane = 'fan_earnings_monthly' then raise exception 'injected dirty failure'; end if;
      return new; end $$;
      create trigger reject_monthly_dirty before insert on subject_refresh_state
      for each row execute function reject_monthly_dirty()`);
    try {
      await expect(upsertFanslyTransactionWithEarningsDirty(db.db, f.transaction)).rejects.toThrow();
      expect((await db.pool.query("select count(*)::int n from transactions")).rows[0].n).toBe(0);
      expect(await f.rows()).toEqual([]);
    } finally {
      await db.pool.query("drop trigger reject_monthly_dirty on subject_refresh_state; drop function reject_monthly_dirty()");
    }
  });
});
