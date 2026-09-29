import { expect, it } from "vitest";
import {
  claimFanEarningsRotation, settleFanEarningsReceipt, upsertTransaction,
} from "@agency_hub_core/db";
import { runMigrations } from "../packages/db/src/migrate-runner.ts";
import { startIntegrationTestDatabase } from "./helpers/db.ts";
import { earningsShadowFixture } from "./helpers/earnings-shadow-fixture.ts";

const hour = 3_600_000;

it("proves a stuck signal's baseline only from retained insert and capture evidence", async () => {
  const db = await startIntegrationTestDatabase({ through: "0216_ofapi_media_preview_variant.sql" });
  if (!db) throw new Error("Docker Postgres required");
  try {
    const f = await earningsShadowFixture(db);
    const t0 = new Date(Date.now() - 48 * hour);
    const insert = async (transactionId: string, fanRef: string, createdAt: Date) => {
      await upsertTransaction(db.db, {
        ...f.transaction, transactionId, correlationAccountId: fanRef, fanId: null,
      });
      await db.pool.query("update transactions set created_at = $1 where transaction_id = $2",
        [createdAt, transactionId]);
    };
    const endpointRows = async (fanRef: string, created: Date, content: number, requested = content) => {
      for (const plane of ["fan_earnings_lifetime", "fan_earnings_monthly"]) {
        await db.pool.query(`insert into subject_refresh_state (page_id, plane, subject_ref, created_at,
          requested_revision, applied_revision, earnings_content_revision, dirty_reason,
          last_content_fingerprint, last_checked_at, last_refresh_outcome, refresh_checks)
          values ($1, $2, $3, $4, $5, 0, $6, $7, $8, now(), 'unconfirmed', 3)`,
        [f.page.id, plane, fanRef, created, requested, content,
          requested > content ? "transaction_status_change" : "semantic_transaction_change", "a".repeat(64)]);
      }
    };
    const capture = async (fanRef: string, capturedAt: Date) => {
      for (const endpoint of ["fan_earnings_stats", "fan_earnings_monthly"]) {
        await db.pool.query(`insert into sync_raw_payloads (page_id, endpoint, request_params,
          response_payload, mapper_version, payload_kind, retain_until, captured_at)
          values ($1, $2, $3, '[]'::jsonb, 'test', 'mapping_critical', now() + interval '1 year', $4)`,
        [f.page.id, endpoint, { correlationAccountId: fanRef }, capturedAt]);
      }
    };
    // fan-a: two inserts (the first created both rows), a status revision,
    // and every capture of the fan came after the newest insert.
    await insert("a-1", "fan-a", t0);
    await insert("a-2", "fan-a", new Date(t0.getTime() + hour));
    await endpointRows("fan-a", t0, 2, 3);
    await capture("fan-a", new Date(t0.getTime() + 10 * hour));
    await capture("fan-a", new Date(t0.getTime() + 34 * hour));
    // fan-b: the fan was first read between its two inserts.
    await insert("b-1", "fan-b", t0);
    await insert("b-2", "fan-b", new Date(t0.getTime() + 2 * hour));
    await endpointRows("fan-b", t0, 2);
    await capture("fan-b", new Date(t0.getTime() + hour));
    // fan-c: one insert cannot account for two content revisions.
    await insert("c-1", "fan-c", t0);
    await endpointRows("fan-c", t0, 2);
    await capture("fan-c", new Date(t0.getTime() + 10 * hour));
    // fan-d: the read landed inside the one-hour margin after its insert.
    await insert("d-1", "fan-d", t0);
    await endpointRows("fan-d", t0, 1);
    await capture("fan-d", new Date(t0.getTime() + 50 * 60_000));
    // fan-e: rows predate the insert (created by a rotation read).
    await insert("e-1", "fan-e", t0);
    await endpointRows("fan-e", new Date(t0.getTime() - hour), 1);
    await capture("fan-e", new Date(t0.getTime() + 10 * hour));

    const client = await db.pool.connect();
    try { await runMigrations({ db: client }); } finally { client.release(); }

    const rows = (await db.pool.query(`select subject_ref, plane, earnings_content_signal_at,
      content_baseline_at, content_baseline_revision from subject_refresh_state
      where page_id = $1 order by subject_ref, plane`, [f.page.id])).rows;
    expect(rows.filter((row) => row.subject_ref === "fan-a")).toEqual([
      { subject_ref: "fan-a", plane: "fan_earnings_lifetime", earnings_content_signal_at: new Date(t0.getTime() + hour),
        content_baseline_at: new Date(t0.getTime() + 10 * hour), content_baseline_revision: 2n },
      { subject_ref: "fan-a", plane: "fan_earnings_monthly", earnings_content_signal_at: new Date(t0.getTime() + hour),
        content_baseline_at: new Date(t0.getTime() + 10 * hour), content_baseline_revision: 2n },
    ]);
    expect(rows.filter((row) => row.subject_ref !== "fan-a")).toHaveLength(8);
    expect(rows.filter((row) => row.subject_ref !== "fan-a").every((row) =>
      row.earnings_content_signal_at === null && row.content_baseline_at === null
      && row.content_baseline_revision === null)).toBe(true);

    // The next ordinary unchanged read acknowledges only the proven signal.
    const read = async (fanRef: string) => {
      const claim = await claimFanEarningsRotation(db.db, {
        pageId: f.page.id, fanRef, window: "lifetime", now: new Date(),
      });
      if (!claim) throw new Error("Claim unavailable");
      return settleFanEarningsReceipt(db.db, claim, {
        outcome: "observed", observationId: await f.observation(), fingerprint: "a".repeat(64), checkedAt: new Date(),
      });
    };
    for (const fanRef of ["fan-a", "fan-b", "fan-c", "fan-d", "fan-e"]) expect(await read(fanRef)).toBe(true);
    const settled = (await db.pool.query(`select subject_ref, applied_revision, last_refresh_outcome
      from subject_refresh_state where page_id = $1 and plane = 'fan_earnings_lifetime'
      order by subject_ref`, [f.page.id])).rows;
    expect(settled).toEqual([
      { subject_ref: "fan-a", applied_revision: 3n, last_refresh_outcome: "observed" },
      { subject_ref: "fan-b", applied_revision: 0n, last_refresh_outcome: "unconfirmed" },
      { subject_ref: "fan-c", applied_revision: 0n, last_refresh_outcome: "unconfirmed" },
      { subject_ref: "fan-d", applied_revision: 0n, last_refresh_outcome: "unconfirmed" },
      { subject_ref: "fan-e", applied_revision: 0n, last_refresh_outcome: "unconfirmed" },
    ]);

    const status = (await db.pool.query("select fansly_earnings_refresh_status($1, 'fan-a') as rows",
      [f.page.label])).rows[0].rows;
    expect(status[0]).toMatchObject({
      plane: "fan_earnings_lifetime", appliedRevision: 3, contentRevision: 2, contentBaselineRevision: 2,
      contentSignalAt: expect.any(String), contentBaselineAt: expect.any(String),
    });
  } finally { await db.stop(); }
}, 60000);
