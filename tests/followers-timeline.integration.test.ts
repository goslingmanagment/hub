import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { followersDiagnosticFixture } from "./helpers/followers-diagnostic-fixture.ts";

const FROM = new Date(Date.now() - 3_600_000).toISOString();
const TO = new Date(Date.now() + 3_600_000).toISOString();
const TOO_LONG_END = new Date(Date.parse(FROM) + 8 * 86_400_000 + 1).toISOString();

describe("C1 restricted followers run timeline", () => {
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
  const read = async (after = 0, through: number | null = null, limit = 500) => (
    await db.pool.query("select fansly_followers_diagnostic_timeline($1, $2, $3, $4, $5) as r",
      [FROM, TO, after, through, limit])
  ).rows[0].r;
  // Seed reader outcomes directly; this does not execute reconciliation.
  const insertReconcileRun = async (
    pageId: number,
    seq: number,
    outcome: "partial" | "failed" | "skipped" | "succeeded",
    stats: Record<string, unknown>,
  ) => (await db.pool.query(`insert into sync_runs
    (page_id, stream, request_seq, leased_seq, source, outcome, stats, finished_at)
    values ($1, 'followers_reconcile', $2, $2, 'anomaly', $3, $4, now()) returning id`,
  [pageId, seq, outcome, stats])).rows[0].id;

  it("exposes the real handler's decision, counts and locked queue receipt without private material", async () => {
    const fixture = await followersDiagnosticFixture(db, "count");
    await db.pool.query("update page_sync_states set applied_seq = request_seq where page_id = $1", [fixture.page.id]);
    await fixture.runHandlerAndFinishTelemetry();
    const result = await read();
    expect(result.records).toEqual([expect.objectContaining({
      run_id: fixture.run.id, page_label: fixture.page.label, stream: "followers",
      outcome: "succeeded", decision_receipt_count: 1, decision_valid: true, queue_valid: true,
      sections: expect.objectContaining({
        decision: expect.objectContaining({ countMismatch: true, requested: true, requestedSeq: 2 }),
        counts: { activeFollowerCount: 1, sourceFollowerCount: 2, pageCount: 1, processedThisChunk: 1 },
        queueBefore: { requestedSeq: 1, appliedSeq: 1 },
      }),
    })]);
    expect(JSON.stringify(result)).not.toMatch(/test-token|fan-1|authorization|lease_token/);
  });

  it("keeps a request coalesced into outstanding work identifiable but outside known receipts", async () => {
    const fixture = await followersDiagnosticFixture(db, "count");
    await fixture.runHandlerAndFinishTelemetry();
    expect((await read()).records).toEqual([expect.objectContaining({
      run_id: fixture.run.id, decision_valid: true, queue_valid: false,
      sections: expect.objectContaining({
        decision: expect.objectContaining({ requested: true, requestedSeq: 1 }),
        queueBefore: { requestedSeq: 1, appliedSeq: 0 },
      }),
    })]);
  });

  it("keeps revisions, roster generations and uncertified completions distinct", async () => {
    const { page } = await followersDiagnosticFixture(db);
    for (const outcome of ["partial", "failed", "skipped", "succeeded"] as const) {
      await insertReconcileRun(page.id, 8, outcome, { generation: 50, nonDestructiveClose: true,
        destructiveFinalization: false, finalizationWithheld: true });
    }
    await insertReconcileRun(page.id, 10, "succeeded", { generation: 51, pageCount: 5,
      membershipProof: "new_followers_seen_during_sweep", destructiveFinalization: true });
    const rows = (await read()).records.filter((r: { stream: string }) => r.stream === "followers_reconcile");
    expect(rows.map((r: { leased_seq: number; outcome: string }) => [r.leased_seq, r.outcome]))
      .toEqual([[8, "partial"], [8, "failed"], [8, "skipped"], [8, "succeeded"], [10, "succeeded"]]);
    expect(rows[3]).toMatchObject({ membership_proof: null, sections: { statistics: {
      generation: 50, nonDestructiveClose: true, destructiveFinalization: false, finalizationWithheld: true,
    } } });
    expect(rows[4]).toMatchObject({ request_seq: 10, membership_proof: "new_followers_seen_during_sweep",
      sections: { statistics: { generation: 51, destructiveFinalization: true } } });
  });

  it("pages a pinned run cohort without admitting later inserts or the exclusive end", async () => {
    const fixture = await followersDiagnosticFixture(db);
    const second = await insertReconcileRun(fixture.page.id, 2, "partial", {});
    await db.pool.query("update sync_runs set started_at = $1 where id = $2", [FROM, fixture.run.id]);
    const first = await read(0, null, 1);
    expect(first.records.map((r: { run_id: number }) => r.run_id)).toEqual([fixture.run.id]);
    expect(first.nextRunId).toBe(fixture.run.id);
    const later = await insertReconcileRun(fixture.page.id, 3, "succeeded", {});
    const end = await insertReconcileRun(fixture.page.id, 4, "succeeded", {});
    await db.pool.query("update sync_runs set started_at = $1 where id = $2", [TO, end]);
    const last = await read(first.nextRunId, first.throughRunId, 1);
    expect(last.records.map((r: { run_id: number }) => r.run_id)).toEqual([Number(second)]);
    expect(last.nextRunId).toBeNull();
    expect((await read()).records.map((r: { run_id: number }) => r.run_id))
      .toEqual([fixture.run.id, Number(second), Number(later)]);
  });

  it("retains missing, duplicate and late evidence without making it valid", async () => {
    const fixture = await followersDiagnosticFixture(db);
    await fixture.runHandlerAndFinishTelemetry();
    await fixture.telemetry.addNote("duplicate", { followersReconcile: { schemaVersion: 1 } });
    expect((await read()).records[0]).toMatchObject({ decision_receipt_count: 2, decision_valid: false });
    await db.pool.query("update sync_run_events set emitted_at = $1", [TO]);
    await db.pool.query("update sync_runs set finished_at = $1 where id = $2", [TO, fixture.run.id]);
    expect((await read()).records[0]).toMatchObject({
      decision_receipt_count: 0, unfinished_in_window: true, sections: { decision: {}, counts: {} },
    });
  });

  it("projects allowlisted scalars even when retained JSON is malformed or contains secrets", async () => {
    const fixture = await followersDiagnosticFixture(db);
    await fixture.telemetry.addNote("private body", { followersReconcile: {
      schemaVersion: 1, requested: "secret-requested", counts: ["secret-array"],
      queueBefore: { requestedSeq: "secret-seq", appliedSeq: 2 }, authorization: "secret-token",
    } });
    await insertReconcileRun(fixture.page.id, 2, "failed", { generation: "secret-generation",
      membershipProof: "secret-proof", qualityHold: "secret-hold", lease_token: "secret-lease",
      checkpoint: { before: { followers_reconcile: { stateScalars: {
        generation: 7, snapshotRestartCount: 1, fullSweepStartedAt: FROM,
        knownFollowId: "secret-fan", authorization: "secret-auth",
      } } } } });
    const result = await read();
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.records[1]).toMatchObject({ membership_proof: null, has_quality_hold: true,
      sections: { statistics: {}, checkpointBefore: {
        generation: 7, snapshotRestartCount: 1, fullSweepStartedAt: FROM,
      } } });
  });

  it("grants only the bounded reader and leaves tables inaccessible", async () => {
    await db.pool.query(`create role followers_timeline_reader;
      grant usage on schema public to followers_timeline_reader;
      grant execute on function fansly_followers_diagnostic_timeline(timestamptz,timestamptz,bigint,bigint,integer)
        to followers_timeline_reader`);
    const client = await db.pool.connect();
    try {
      await client.query("begin read only");
      await client.query("set local role followers_timeline_reader");
      const result = await client.query("select fansly_followers_diagnostic_timeline($1,$2) as r", [FROM, TO]);
      expect(result.rows[0].r.records).toEqual([]);
      await expect(client.query("select * from sync_runs limit 1")).rejects.toThrow("permission denied");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it.each([
    { name: "missing queue", queueBefore: null },
    { name: "fractional request sequence", queueBefore: { requestedSeq: 1.5, appliedSeq: 0 } },
    { name: "negative applied sequence", queueBefore: { requestedSeq: 1, appliedSeq: -1 } },
    { name: "applied sequence ahead of requested", queueBefore: { requestedSeq: 1, appliedSeq: 2 } },
    { name: "nonconsecutive request receipt", queueBefore: { requestedSeq: 0, appliedSeq: 0 } },
    { name: "string request sequence", queueBefore: { requestedSeq: "1", appliedSeq: 0 } },
    { name: "fractional applied sequence", queueBefore: { requestedSeq: 1, appliedSeq: 0.5 } },
  ])("keeps $name unknown despite a valid OR decision", async ({ queueBefore }) => {
    const fixture = await followersDiagnosticFixture(db);
    await fixture.telemetry.addNote("queue evidence", {
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
    expect((await read()).records[0]).toMatchObject({ decision_valid: true, queue_valid: false });
  });

  it.each([
    { name: "unbounded interval", args: [null, TO, 0, null, 1] },
    { name: "reversed interval", args: [TO, FROM, 0, null, 1] },
    { name: "interval longer than eight days", args: [FROM, TOO_LONG_END, 0, null, 1] },
    { name: "negative cursor", args: [FROM, TO, -1, null, 1] },
    { name: "cursor beyond the pinned cohort", args: [FROM, TO, 2, 1, 1] },
    { name: "oversized page", args: [FROM, TO, 0, null, 501] },
    { name: "empty page", args: [FROM, TO, 0, null, 0] },
  ])("rejects $name", async ({ args }) => {
    await expect(db.pool.query("select fansly_followers_diagnostic_timeline($1,$2,$3,$4,$5)",
      args))
      .rejects.toThrow(/required/);
  });
});
