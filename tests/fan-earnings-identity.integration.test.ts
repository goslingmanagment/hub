import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents, createFanslyPage, createModel, insertObservation,
  listDomainEventContiguousReplayEnds, listEventsSince, markObservationParsed,
} from "@agency_hub_core/db";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  rebuildFanEarningsProjection, runFanEarningsProjection,
} from "../apps/runtime/src/services/projections/fan-earnings.ts";
import { validateV2DeliverableReplayBatch } from "../apps/runtime/src/services/sse-replay-buffer.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase;
let accountId: number;
let counter = 0;
const at = (minute: number) => new Date(Date.UTC(2026, 8, 10, 0, minute));
const app = () => ({ db: testDb.db, logger: { info() {}, warn() {}, error() {} } }) as never;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres is required");
  testDb = started;
}, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  const model = await createModel(testDb.db, { slug: "earnings-identity", name: "Earnings" });
  if (!model) throw new Error("model seed failed");
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "earnings" });
  if (!page) throw new Error("page seed failed");
  accountId = page.id;
  counter = 0;
});

async function capture(amount: number, minute: number, kind = "fan_earnings_stats") {
  counter += 1;
  const payload = [{
    correlationAccountId: "fan-1", type: 2110, totalGross: amount, totalNet: amount,
    year: 2026, month: 9,
  }];
  return insertObservation(testDb.db, {
    source: "pull", producer: "sync:fansly:fan_earnings", platform: "fansly",
    accountId, kind, payload, observedAt: at(minute),
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: `capture-${counter}`,
  });
}

async function current() {
  const rows = await testDb.pool.query(
    `select gross_mills::text, net_mills::text, "window", source_observation_id::text
     from fan_earnings_stats where account_id = $1 order by "window"`, [accountId],
  );
  return rows.rows;
}

async function project() {
  await runCanonicalization(app(), { accountId });
  await runFanEarningsProjection(app(), { accountId });
}

describe("Fansly earnings ordered snapshot replay", () => {
  it.each(["fan_earnings_stats", "fan_earnings_monthly"])(
    "%s applies provider corrections A → B → A and replays idempotently", async (kind) => {
      for (const [minute, amount] of [100, 200, 100].entries()) {
        await capture(amount, minute, kind);
        await project();
        expect((await current())[0]).toMatchObject({ gross_mills: String(amount), net_mills: String(amount) });
      }
      const before = await current();
      const replay = await runCanonicalization(app(), { accountId, belowParseVersion: 8 });
      expect(replay.appended).toBe(0);
      expect(replay.deduped).toBe(3);
      await rebuildFanEarningsProjection(app(), { accountId });
      expect(await current()).toEqual(before);
      const events = await listEventsSince(testDb.db, { accountId, afterSeq: 0, excludeProjectionOnly: true });
      expect(events.map(row => row.type)).toEqual(Array(3).fill("stream.projection_checkpoint"));
    },
  );

  it("rejects stale-after-fresh and preserves observation order when timestamps tie", async () => {
    const old = await capture(100, 1);
    await markObservationParsed(testDb.db, {
      observationId: old.observationId, receivedAt: old.receivedAt, parseVersion: 6,
    });
    await appendDomainEvents(testDb.db, accountId, [{
      type: "fan.earnings_observed", occurredAt: at(1), fanIdentityRef: "fan-1",
      data: { window: "lifetime", grossMills: 100, netMills: 100 },
      schemaVersion: 1, observationId: old.observationId, dedupKey: "legacy-tie",
    }]);
    const fresh = await capture(200, 1);
    await runCanonicalization(app(), { accountId, observationId: fresh.observationId });
    await runFanEarningsProjection(app(), { accountId });
    expect((await current())[0]).toMatchObject({ gross_mills: "200" });
    // Simulate the additive migration over a pre-v7 projection: its money and
    // event reference are real, but the new receipt-order column starts at zero.
    await testDb.pool.query("update fan_earnings_stats set source_observation_id = 0");
    // The old v6 receipt now appends AFTER the fresh receipt at the same timestamp.
    const replay = await runCanonicalization(app(), { accountId, observationId: old.observationId });
    expect(replay.appended).toBe(2);
    await capture(50, 0);
    await project();
    expect((await current())[0]).toMatchObject({ gross_mills: "200" });
    const before = await current();
    await rebuildFanEarningsProjection(app(), { accountId });
    expect(await current()).toEqual([{
      ...before[0], source_observation_id: String(fresh.observationId),
    }]);
  });

  it("refuses an equal-time overwrite when the legacy receipt cannot be resolved", async () => {
    await capture(200, 1);
    await project();
    await testDb.pool.query(
      "update fan_earnings_stats set source_observation_id = 0, source_event_id = -1",
    );
    await capture(100, 1);
    await project();
    expect((await current())[0]).toMatchObject({ gross_mills: "200" });
    await capture(300, 2);
    await project();
    expect((await current())[0]).toMatchObject({ gross_mills: "300" });
  });

  it("keeps malformed and partial receipts as debt without confusing empty with zero", async () => {
    await capture(200, 0);
    await project();
    const valid = { correlationAccountId: "fan-1", totalGross: 100, totalNet: 80 };
    const payloads = [
      { unexpected: true }, [null], [{ ...valid, totalNet: null }],
      [valid, { ...valid, totalGross: 1.5 }], [],
    ];
    for (const [index, payload] of payloads.entries()) {
      await insertObservation(testDb.db, {
        source: "pull", producer: "sync:fansly:fan_earnings", platform: "fansly",
        accountId, kind: "fan_earnings_stats", payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `shape-${index}`,
      });
    }
    const result = await runCanonicalization(app(), { accountId });
    expect(result).toMatchObject({ skippedUnparseable: 4, stamped: 1, appended: 0 });
    expect(result.unparseableSamples.map(row => row.reasonCode)).toEqual([
      "unsupported_earnings_shape", "invalid_earnings_row",
      "invalid_earnings_money", "invalid_earnings_money",
    ]);
    const versions = await testDb.pool.query(
      "select parse_version from observations where account_id = $1 order by id", [accountId],
    );
    expect(versions.rows.map(row => row.parse_version)).toEqual([7, 0, 0, 0, 0, 7]);
    await runFanEarningsProjection(app(), { accountId });
    expect((await current())[0]).toMatchObject({ gross_mills: "200" });
  });

  it("replays v6 earnings without reopening DM debt or breaking legacy SSE edges", async () => {
    const old = await capture(100, 0);
    if (old.observationId === null) throw new Error("missing observation id");
    await markObservationParsed(testDb.db, { observationId: old.observationId, receivedAt: old.receivedAt, parseVersion: 6 });
    await appendDomainEvents(testDb.db, accountId, [{
      type: "fan.earnings_observed", occurredAt: at(0), fanIdentityRef: "fan-1",
      data: { window: "lifetime", grossMills: 100, netMills: 100 },
      schemaVersion: 1, observationId: old.observationId, dedupKey: "legacy-content-key",
    }]);
    const dm = await capture(0, 0, "dm_messages");
    if (dm.observationId === null) throw new Error("missing DM id");
    await markObservationParsed(testDb.db, { observationId: dm.observationId, receivedAt: dm.receivedAt, parseVersion: 6 });
    const parsed = await runCanonicalization(app(), { accountId });
    expect(parsed.stamped).toBe(1);
    expect(parsed.appended).toBe(2);
    await appendDomainEvents(testDb.db, accountId, [{
      type: "message.received", occurredAt: at(1), data: {}, schemaVersion: 1,
      observationId: dm.observationId, dedupKey: "message-after-earnings",
    }]);
    const visible = await listEventsSince(testDb.db, { accountId, afterSeq: 0, excludeProjectionOnly: true });
    expect(visible.map(row => [row.accountSeq, row.type])).toEqual([
      [1, "fan.earnings_observed"], [3, "stream.projection_checkpoint"], [4, "message.received"],
    ]);
    expect(validateV2DeliverableReplayBatch({ rows: visible, afterSeq: 0, throughSeq: 4, limit: 100 }).ok).toBe(true);
    const ends = await listDomainEventContiguousReplayEnds(
      testDb.db, [{ accountId, afterSeq: 0, throughSeq: 4 }], { excludeProjectionOnly: true },
    );
    expect(ends.get(accountId)).toBe(4);
    // A missing legacy business event is still a real gap, not an earnings exception.
    expect(validateV2DeliverableReplayBatch({ rows: visible.slice(1), afterSeq: 0, throughSeq: 4, limit: 100 }).ok)
      .toBe(false);
    const stamps = await testDb.pool.query(
      "select kind, parse_version from observations where account_id = $1 order by id", [accountId],
    );
    expect(stamps.rows).toEqual([
      { kind: "fan_earnings_stats", parse_version: 7 }, { kind: "dm_messages", parse_version: 6 },
    ]);
  });
});
