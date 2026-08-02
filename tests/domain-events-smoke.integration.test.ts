import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  appendProjectionOnlyDomainEvents,
  createFanslyPage,
  createModel,
} from "@agency_hub_core/db";

import { startDomainEventsSmokeConsumer } from "../apps/runtime/src/services/domain-events-smoke.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Kernel Stage 21: the production conformance instrument — counts frames,
// detects seq gaps and duplicates, survives restarts through its checkpoint.

let testDb: StartedTestDatabase | null = null;
let modelId = 0;
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
  if (!model) {
    throw new Error("failed to create smoke test model");
  }
  modelId = model.id;
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "smoke" });
  if (!page) {
    throw new Error("failed to create smoke test page");
  }
  pageId = page.id;
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

describe("v2 smoke consumer", () => {
  it("tails appends and projection checkpoints, then resumes without recount", async (context) => {
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
    const hidden = event("post.observed");
    await appendProjectionOnlyDomainEvents(testDb.db, pageId, [hidden], {
      occurredAt: hidden.occurredAt,
      observationId: hidden.observationId,
      dedupKey: `smoke:projection-checkpoint:${hidden.observationId}`,
    });

    // The all-account smoke subscription also sees pages created after its
    // startup snapshot. Their exact initial watermark is zero, including when
    // the first visible frame is a checkpoint hiding seq 1.
    const latePage = await createFanslyPage(testDb.db, {
      modelId,
      label: `smoke-late-${counter}`,
    });
    if (!latePage) {
      throw new Error("failed to create late smoke test page");
    }
    const lateHidden = event("post.observed");
    await appendProjectionOnlyDomainEvents(testDb.db, latePage.id, [lateHidden], {
      occurredAt: lateHidden.occurredAt,
      observationId: lateHidden.observationId,
      dedupKey: `smoke:projection-checkpoint:${lateHidden.observationId}`,
    });
    await appendDomainEvents(testDb.db, latePage.id, [event("message.received")]);
    await sleep(700);
    await first.stop();

    const afterFirst = await readCheckpoint();
    expect(afterFirst).toBeDefined();
    expect(Number(afterFirst!.frames_seen)).toBe(5);
    expect(Number(afterFirst!.gap_count)).toBe(0);
    expect(Number(afterFirst!.duplicate_count)).toBe(0);

    // Both ordinary and projection-only appends while the consumer is DOWN are
    // replayed through the same filtered/checkpointed path as the real v2 SSE
    // route — nothing double-counted, nothing skipped.
    const replayHidden = event("post.observed");
    await appendProjectionOnlyDomainEvents(testDb.db, pageId, [replayHidden], {
      occurredAt: replayHidden.occurredAt,
      observationId: replayHidden.observationId,
      dedupKey: `smoke:projection-checkpoint:${replayHidden.observationId}`,
    });
    await appendDomainEvents(testDb.db, pageId, [event("message.received")]);
    const second = startDomainEventsSmokeConsumer(app);
    await sleep(700);
    await second.stop();

    const afterSecond = await readCheckpoint();
    expect(Number(afterSecond!.frames_seen)).toBe(7);
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
