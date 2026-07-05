import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendDomainEvents, createFanslyPage, createModel } from "@agency_hub_core/db";

import { startDomainEventsSmokeConsumer } from "../apps/runtime/src/services/domain-events-smoke.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Kernel Stage 21: the production conformance instrument — counts frames,
// detects seq gaps and duplicates, survives restarts through its checkpoint.

let testDb: StartedTestDatabase | null = null;
let pageId = 0;
let counter = 0;

function event(type: string) {
  counter += 1;
  return {
    type,
    occurredAt: new Date("2026-07-01T00:00:00.000Z"),
    data: { n: counter },
    schemaVersion: 1,
    observationId: counter,
    dedupKey: `smoke:${counter}`,
  };
}

async function readCheckpoint() {
  const result = await testDb!.pool.query(
    "select cursor, frames_seen, gap_count, duplicate_count from domain_events_smoke_checkpoint where id = 1",
  );
  return result.rows[0] as
    | { cursor: string; frames_seen: string; gap_count: string; duplicate_count: string }
    | undefined;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) {
    return;
  }
  const model = await createModel(testDb.db, { slug: "smoke-model", name: "Smoke" });
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "smoke" });
  pageId = page.id;
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

describe("v2 smoke consumer", () => {
  it("tails appends live, checkpoints on stop, and resumes without recount", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const app = createTestAppContext(testDb);

    // Two events exist BEFORE the first start: the instrument measures forward
    // conformance, so its first baseline is "now" and skips them.
    await appendDomainEvents(testDb.db, pageId, [event("message.received"), event("message.received")]);

    const first = startDomainEventsSmokeConsumer(app);
    await sleep(500);
    await appendDomainEvents(testDb.db, pageId, [event("message.received"), event("tip.received")]);
    await sleep(700);
    await first.stop();

    const afterFirst = await readCheckpoint();
    expect(afterFirst).toBeDefined();
    expect(Number(afterFirst!.frames_seen)).toBe(2);
    expect(Number(afterFirst!.gap_count)).toBe(0);
    expect(Number(afterFirst!.duplicate_count)).toBe(0);

    // Appends while the consumer is DOWN are replayed from the checkpoint on
    // the next start — nothing double-counted, nothing skipped.
    await appendDomainEvents(testDb.db, pageId, [event("message.received")]);
    const second = startDomainEventsSmokeConsumer(app);
    await sleep(700);
    await second.stop();

    const afterSecond = await readCheckpoint();
    expect(Number(afterSecond!.frames_seen)).toBe(3);
    expect(Number(afterSecond!.gap_count)).toBe(0);
    expect(Number(afterSecond!.duplicate_count)).toBe(0);
  });

  it("counts a synthetic account_seq gap as the bug signal", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const app = createTestAppContext(testDb);
    const consumer = startDomainEventsSmokeConsumer(app);
    await sleep(500);

    // Bypass the gapless append protocol: jump the counter forward by one and
    // write the row at head+2, then notify — the guard must flag the jump.
    const head = await testDb.pool.query(
      "select next_seq from domain_event_seq where account_id = $1",
      [pageId],
    );
    const gapSeq = Number(head.rows[0].next_seq) + 1;
    await testDb.pool.query(
      `insert into domain_events (account_id, account_seq, type, occurred_at, data, schema_version, observation_id, dedup_key)
       values ($1, $2, 'message.received', now(), '{}'::jsonb, 1, 999999, 'smoke:gap')`,
      [pageId, gapSeq],
    );
    await testDb.pool.query("update domain_event_seq set next_seq = $2 where account_id = $1", [pageId, gapSeq + 1]);
    await testDb.pool.query("select pg_notify('domain_events_appended', $1)", [`${pageId}:${gapSeq}`]);
    await sleep(700);
    await consumer.stop();

    const checkpoint = await readCheckpoint();
    expect(Number(checkpoint!.gap_count)).toBe(1);
  });
});
