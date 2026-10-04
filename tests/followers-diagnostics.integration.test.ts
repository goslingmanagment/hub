import { requestPageSync } from "@agency_hub_core/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { followersDiagnosticFixture } from "./helpers/followers-diagnostic-fixture.ts";

const FROM = new Date(Date.now() - 3_600_000).toISOString();
const TO = new Date(Date.now() + 3_600_000).toISOString();
const TOO_LONG_END = new Date(Date.parse(FROM) + 8 * 86_400_000 + 1).toISOString();

// The decision receipts the deleted legacy followers walk wrote stay readable
// through fansly_followers_diagnostic_report (0182); the fixture writes them
// as the walk did.
describe("C1 followers decision receipts", () => {
  let db: Awaited<ReturnType<typeof startTestDatabase>>;
  beforeAll(async () => {
    db = await startTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await resetIntegrationDatabase(db.pool);
  });
  const report = async () => (await db.pool.query(
    "select fansly_followers_diagnostic_report($1, $2) as report", [FROM, TO],
  )).rows[0].report;
  const settleQueue = (pageId: number) => db.pool.query(
    "update page_sync_states set applied_seq = request_seq where page_id = $1", [pageId],
  );

  it.each(["none", "count", "missing", "unchanged", "crossed"] as const)(
    "records %s with the real queue decision", async mode => {
      const fixture = await followersDiagnosticFixture(db, mode);
      await settleQueue(fixture.page.id);
      const before = Number(await fixture.queue());
      expect((await fixture.recordWalkAndFinishTelemetry()).requested).toBe(mode !== "none");
      expect(Number(await fixture.queue()) - before).toBe(mode === "none" ? 0 : 1);
      const output = await report();
      expect(output.coverage).toEqual([expect.objectContaining({
        runs: 1, decisions: 1, missing_decisions: 0, invalid_decisions: 0, duplicate_decisions: 0,
      })]);
      expect(output.decisions).toEqual([expect.objectContaining({
        count_mismatch: mode === "count", exhausted_without_known: mode === "missing" || mode === "crossed",
        unchanged_head_with_rows: mode === "unchanged", requested: mode !== "none", decisions: 1,
      })]);
      expect(output.queue).toEqual([expect.objectContaining({
        requested: mode === "none" ? 0 : 1,
        known_queue_receipts: mode === "none" ? 0 : 1,
        unknown_queue_receipts: 0,
        requests_with_pending_work: 0,
      })]);
      expect(JSON.stringify(output)).not.toMatch(/test-token|authorization/);
    },
  );

  it("coalesces a decision into outstanding reconcile work without touching its queue row", async () => {
    const fixture = await followersDiagnosticFixture(db, "count");
    // Followers has run before; its reconcile sweep waits for a snapshot restart.
    await db.pool.query(
      "update page_sync_states set succeeded_at = now() where page_id = $1 and stream = 'followers'",
      [fixture.page.id],
    );
    await db.pool.query(`update page_sync_states
      set status = 'pending', blocker_kind = null, blocker_code = null, blocker_message = null,
          blocked_at = null, retry_at = now() + interval '15 minutes'
      where page_id = $1 and stream = 'followers_reconcile'`, [fixture.page.id]);
    const reconcileRow = async () => (await db.pool.query(
      "select to_jsonb(s) as row from page_sync_states s where page_id = $1 and stream = 'followers_reconcile'",
      [fixture.page.id],
    )).rows[0].row;
    const before = await reconcileRow();
    expect(before.request_seq).toBeGreaterThan(before.applied_seq);

    await fixture.recordWalkAndFinishTelemetry();
    expect(await reconcileRow()).toEqual(before);
    const note = await db.pool.query(
      "select details -> 'followersReconcile' as d from sync_run_events where sync_run_id = $1 and details ? 'followersReconcile'",
      [fixture.run.id],
    );
    expect(note.rows).toEqual([{ d: expect.objectContaining({
      requested: true, coalesced: true, requestedSeq: before.request_seq,
      queueBefore: { requestedSeq: before.request_seq, appliedSeq: before.applied_seq },
    }) }]);
    // The C1 report predates coalescing and keeps such receipts unknown.
    expect((await report()).queue).toEqual([expect.objectContaining({
      requested: 1, known_queue_receipts: 0, unknown_queue_receipts: 1, requests_with_pending_work: 0,
    })]);
  });

  it("distinguishes a clean queue from pending work using the locked request receipt", async () => {
    const fixture = await followersDiagnosticFixture(db, "count");
    await settleQueue(fixture.page.id);
    await fixture.recordWalkAndFinishTelemetry();
    expect((await report()).queue).toEqual([expect.objectContaining({
      requested: 1, known_queue_receipts: 1, unknown_queue_receipts: 0, requests_with_pending_work: 0,
    })]);
    const before = Number(await fixture.queue());
    const results = await Promise.all([1, 2].map(() => requestPageSync(db.db, {
      pageId: fixture.page.id, streams: ["followers_reconcile"], source: "anomaly", includeQueueState: true,
    })));
    const receipts = results.flat().sort((a, b) => a.requestedSeq - b.requestedSeq);
    expect(receipts.map(row => [row.queueBefore?.requestedSeq, row.requestedSeq])).toEqual([
      [before, before + 1], [before + 1, before + 2],
    ]);
    expect(receipts.every(row => row.queueBefore!.requestedSeq > row.queueBefore!.appliedSeq)).toBe(true);
    const coalesced = await requestPageSync(db.db, {
      pageId: fixture.page.id, streams: ["followers_reconcile"], source: "anomaly",
      includeQueueState: true, coalesceOutstanding: true,
    });
    expect(coalesced).toEqual([{
      stream: "followers_reconcile", requestedSeq: before + 2, coalesced: true,
      queueBefore: { requestedSeq: before + 2, appliedSeq: receipts[0]!.queueBefore!.appliedSeq },
    }]);
    const ordinary = await requestPageSync(db.db, {
      pageId: fixture.page.id, streams: ["followers_reconcile"], source: "anomaly",
    });
    expect(ordinary).toEqual([{ stream: "followers_reconcile", requestedSeq: before + 3 }]);
  });

  it("keeps a lost receipt unknown while its anomaly request stands", async () => {
    const fixture = await followersDiagnosticFixture(db, "count");
    await db.pool.query(`create function reject_followers_note() returns trigger language plpgsql as $$
      begin if new.details ? 'followersReconcile' then raise exception 'diagnostic unavailable'; end if;
      return new; end $$;
      create trigger reject_followers_note before insert on sync_run_events
      for each row execute function reject_followers_note()`);
    try {
      await settleQueue(fixture.page.id);
      const before = Number(await fixture.queue());
      await fixture.recordWalkAndFinishTelemetry();
      expect(Number(await fixture.queue()) - before).toBe(1);
      const result = await report();
      expect(result.decisions).toEqual([]);
      expect(result.coverage).toEqual([expect.objectContaining({ runs: 1, decisions: 0, missing_decisions: 1 })]);
    } finally {
      await db.pool.query("drop trigger reject_followers_note on sync_run_events; drop function reject_followers_note()");
    }
  });

  it("reports duplicate receipts outside the valid decision denominator", async () => {
    const fixture = await followersDiagnosticFixture(db);
    await fixture.recordWalkAndFinishTelemetry();
    await fixture.telemetry.addNote("duplicate", { followersReconcile: { schemaVersion: 1 } });
    expect((await report()).coverage).toEqual([expect.objectContaining({ decisions: 0, duplicate_decisions: 1 })]);
  });

  it.each([
    { name: "missing decision fields", diagnostic: { schemaVersion: 1 } },
    {
      name: "a string instead of a boolean",
      diagnostic: {
        schemaVersion: 1,
        countMismatch: "true",
        exhaustedWithoutKnown: false,
        unchangedHeadWithRows: false,
        requested: true,
      },
    },
    {
      name: "a request contradicting the OR branches",
      diagnostic: {
        schemaVersion: 1,
        countMismatch: true,
        exhaustedWithoutKnown: false,
        unchangedHeadWithRows: false,
        requested: false,
      },
    },
  ])("keeps $name unknown", async ({ diagnostic }) => {
    const fixture = await followersDiagnosticFixture(db);
    await fixture.telemetry.addNote("malformed", { followersReconcile: diagnostic });
    const output = await report();
    expect(output.decisions).toEqual([]);
    expect(output.coverage).toEqual([expect.objectContaining({ invalid_decisions: 1, decisions: 0 })]);
  });

  it.each([
    { name: "missing queue", queueBefore: null },
    { name: "nonnumeric request sequence", queueBefore: { requestedSeq: "broken", appliedSeq: 0 } },
    { name: "fractional request sequence", queueBefore: { requestedSeq: 1.5, appliedSeq: 0 } },
  ])("excludes $name from the coalescing denominator", async ({ queueBefore }) => {
    const fixture = await followersDiagnosticFixture(db);
    await fixture.telemetry.addNote("queue shape", {
      followersReconcile: {
        schemaVersion: 1,
        countMismatch: true,
        exhaustedWithoutKnown: false,
        unchangedHeadWithRows: false,
        requested: true,
        requestedSeq: 2,
        queueBefore,
      },
    });
    expect((await report()).queue).toEqual([expect.objectContaining({
      requested: 1, known_queue_receipts: 0, unknown_queue_receipts: 1, requests_with_pending_work: 0,
    })]);
  });

  it("does not pull a later decision into the report window", async () => {
    const fixture = await followersDiagnosticFixture(db);
    await fixture.recordWalkAndFinishTelemetry();
    await db.pool.query(
      "update sync_run_events set emitted_at = $1 where details ? 'followersReconcile'", [TO],
    );
    await db.pool.query("update sync_runs set finished_at = $1 where id = $2", [TO, fixture.run.id]);
    const output = await report();
    expect(output.decisions).toEqual([]);
    expect(output.coverage).toEqual([expect.objectContaining({ missing_decisions: 1, unfinished_in_window: 1 })]);
  });

  it("grants a bounded report without underlying table access", async () => {
    await db.pool.query(`create role followers_report_reader;
      grant usage on schema public to followers_report_reader;
      grant execute on function fansly_followers_diagnostic_report(timestamptz, timestamptz)
        to followers_report_reader`);
    const client = await db.pool.connect();
    try {
      await client.query("begin read only");
      await client.query("set local role followers_report_reader");
      expect((await client.query("select fansly_followers_diagnostic_report($1, $2) as r", [FROM, TO])).rows[0].r.coverage)
        .toEqual([]);
      await expect(client.query("select * from sync_runs limit 1")).rejects.toThrow("permission denied");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  // Window checks run before the report reads any table: one reset for all
  // cases, each check soft and labelled.
  it("refuses a reversed, unbounded or over-eight-day window", async () => {
    for (const { name, from, to } of [
      { name: "a reversed window", from: TO, to: FROM },
      { name: "an unbounded window", from: null, to: TO },
      { name: "a window longer than eight days", from: FROM, to: TOO_LONG_END },
    ]) {
      await expect.soft(db.pool.query("select fansly_followers_diagnostic_report($1, $2)", [from, to]), name)
        .rejects.toThrow("ordered report window");
    }
  });
});
