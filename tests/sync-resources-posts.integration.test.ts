import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensurePollRows, getSyncPage, upsertDemand, type Database } from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { createEngineRegistry, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  statusResponse,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The timeline's coverage (`capture_coverage`, plane `posts`, ContentOps
// entry E7) through the real actor and commits against a real database: a
// scripted live transport answers the timeline and its tips. Pinned: the
// empty page that ends a full walk proves the floor; a refresh that reaches
// the head the claim holds moves it; a refresh with no floor captures its
// window and asks for the backfill that proves it; a refused session says so
// and keeps the chain.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const OWN_ID = "300000000000000001";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HEAD_TOLERANCE_MS = 18 * HOUR;

type Responder = (req: FanslyWireRequest, index: number) => FanslyWireOutcome;

function param(req: FanslyWireRequest, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}

function post(id: string, ageMs: number) {
  return { id, accountId: OWN_ID, content: `post ${id}`, createdAt: Math.floor((Date.now() - ageMs) / 1000) };
}

/** The timeline by `before`, every tips read empty. */
function timeline(pages: Record<string, unknown[]>): Responder {
  return (req) => {
    if (req.spec === "posts.tips") return okResponse([]);
    if (req.spec === "posts.timeline") return okResponse({ posts: pages[param(req, "before") ?? ""] ?? [] });
    return statusResponse(404);
  };
}

/** Every standing poll parked far ahead: only the work a test makes due runs. */
async function quietRegistry(pageId: number): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return registry;
}

async function makeDue(pageId: number, resource: string) {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), { pageId, resource, kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
}

async function seedPage() {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await testDb!.pool.query(
    "update pages set external_page_id = $2, metadata = $3::jsonb, last_verified_at = clock_timestamp() where id = $1",
    [pageId, OWN_ID, JSON.stringify({ accountCreatedAt: "2025-01-01T00:00:00.000Z" })],
  );
  return pageId;
}

async function runLive(
  pageId: number,
  respond: Responder,
  until: () => Promise<boolean>,
  onHit?: (req: FanslyWireRequest) => Promise<void>,
) {
  const registry = await quietRegistry(pageId);
  const transport = new ScriptedLiveTransport();
  transport.respond = respond;
  if (onHit !== undefined) transport.onHit = (req) => onHit(req);
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    registry,
    alerts: new RecordingAlerts(),
    metrics: new RecordingMetrics(),
    transport,
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 30_000, "the work to settle");
  } finally {
    stop.abort();
    await run;
  }
}

async function coverage(pageId: number) {
  const result = await testDb!.pool.query<{
    status: string; proof: string; reason: string | null; proofObservationId: string | null;
    oldest: Date | null; newest: Date | null; nextProbeAt: Date | null; cursor: Record<string, unknown>;
  }>(
    `select status, proof, reason_code as reason, proof_observation_id::text as "proofObservationId",
            oldest_captured_at as oldest, newest_captured_at as newest, next_probe_at as "nextProbeAt", cursor
       from capture_coverage where page_id = $1 and plane = 'posts' and scope_ref = ''`,
    [pageId],
  );
  return result.rows[0] ?? null;
}

/** The timeline reads of a key, oldest first. */
async function timelineReads(pageId: number, resource: string) {
  const result = await testDb!.pool.query<{ before: string | null; admittedAt: Date; observationId: string | null }>(
    `select request->'params'->>'before' as before, admitted_at as "admittedAt", observation_id::text as "observationId"
       from sync_attempts where page_id = $1 and resource = $2 and operation = 'posts.timeline' order by id`,
    [pageId, resource],
  );
  return result.rows;
}

async function backfills(pageId: number) {
  const result = await testDb!.pool.query<{ state: string; closeReason: string | null; reasons: string[] }>(
    `select state, close_reason as "closeReason", coalesce(array(select jsonb_array_elements_text(demand->'reasons')), '{}') as reasons
       from sync_work where page_id = $1 and resource = 'posts.backfill' and not shadow order by id`,
    [pageId],
  );
  return result.rows;
}

function within1ms(actual: Date | null | undefined, expected: Date) {
  expect(Math.abs((actual?.getTime() ?? Number.NaN) - expected.getTime())).toBeLessThanOrEqual(1);
}

describe("posts: the timeline's coverage", () => {
  it("backfill: the empty page that ends the full walk proves the floor; a refresh that reaches its head moves it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const oldest = post("898", 30 * DAY);
    await makeDue(pageId, "posts.backfill");
    await runLive(
      pageId,
      timeline({ "0": [post("900", 20 * DAY), post("899", 21 * DAY)], "899": [oldest], "898": [] }),
      async () => (await backfills(pageId))[0]?.state === "done",
    );

    const reads = await timelineReads(pageId, "posts.backfill");
    expect(reads.map((read) => read.before)).toEqual(["0", "899", "898"]);
    const floor = await coverage(pageId);
    expect(floor).toMatchObject({
      status: "provider_exhausted", proof: "empty_window", reason: "timeline_exhausted", proofObservationId: reads[2]!.observationId,
      oldest: new Date(oldest.createdAt * 1000),
    });
    within1ms(floor!.newest, reads[0]!.admittedAt);
    expect(floor!.nextProbeAt!.getTime() - floor!.newest!.getTime()).toBe(HEAD_TOLERANCE_MS);
    expect(floor!.cursor).toMatchObject({ floor: { observationId: Number(reads[2]!.observationId) }, lastWalk: { resource: "posts.backfill", end: "timeline_exhausted" } });

    await makeDue(pageId, "posts.refresh");
    await runLive(
      pageId,
      timeline({ "0": [post("901", HOUR), post("900", 20 * DAY)], "900": [post("899", 21 * DAY), oldest] }),
      async () => ((await coverage(pageId))?.newest?.getTime() ?? 0) > floor!.newest!.getTime(),
    );
    const refreshReads = await timelineReads(pageId, "posts.refresh");
    expect(refreshReads.map((read) => read.before)).toEqual(["0", "900"]);
    const moved = await coverage(pageId);
    expect(moved).toMatchObject({
      status: "provider_exhausted", proof: "empty_window", reason: "timeline_exhausted",
      proofObservationId: floor!.proofObservationId, oldest: floor!.oldest,
    });
    within1ms(moved!.newest, refreshReads[0]!.admittedAt);
    // The floor holds: no second backfill.
    expect(await backfills(pageId)).toHaveLength(1);
  });

  it("refresh: no floor yet — the window is captured and a backfill asked for, which then proves the floor", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await makeDue(pageId, "posts.refresh");
    let heads = 0;
    const seen: { beforeBackfill: Awaited<ReturnType<typeof coverage>> } = { beforeBackfill: null };
    await runLive(
      pageId,
      timeline({ "0": [post("901", HOUR), post("900", 20 * DAY)], "900": [post("899", 21 * DAY)], "899": [] }),
      async () => (await backfills(pageId))[0]?.state === "done",
      async (req) => {
        // The second head read is the backfill's: the refresh's claim is in.
        if (req.spec === "posts.timeline" && param(req, "before") === "0" && ++heads === 2) seen.beforeBackfill = await coverage(pageId);
      },
    );

    const refreshHead = (await timelineReads(pageId, "posts.refresh"))[0]!;
    expect(seen.beforeBackfill).toMatchObject({ status: "window_captured", proof: "none", reason: "floor_unproven", proofObservationId: null });
    within1ms(seen.beforeBackfill?.newest, refreshHead.admittedAt);
    within1ms(seen.beforeBackfill?.oldest, new Date(refreshHead.admittedAt.getTime() - 14 * DAY));
    expect(await backfills(pageId)).toEqual([
      { state: "done", closeReason: "walk_timeline_exhausted", reasons: ["posts_coverage:floor_unproven"] },
    ]);
    const reads = await timelineReads(pageId, "posts.backfill");
    const proven = await coverage(pageId);
    expect(proven).toMatchObject({ status: "provider_exhausted", proof: "empty_window", proofObservationId: reads.at(-1)!.observationId });
    within1ms(proven!.newest, reads[0]!.admittedAt);
  });

  it("a refresh the session is refused for marks the claim auth_blocked; the floor and the head stay", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const chain = {
      floor: { observationId: 1, oldestAt: new Date(Date.now() - 30 * DAY).toISOString(), provenAt: new Date(Date.now() - DAY).toISOString() },
      headAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    };
    await testDb.pool.query(
      `insert into capture_coverage (page_id, platform, plane, scope_ref, status, acquisition_mode, proof,
                                     oldest_captured_at, newest_captured_at, proof_observation_id, reason_code, cursor)
       values ($1, 'fansly', 'posts', '', 'provider_exhausted', 'retroactive', 'empty_window', $2, $3, 1, 'timeline_exhausted', $4::jsonb)`,
      [pageId, chain.floor.oldestAt, chain.headAt, JSON.stringify(chain)],
    );
    await makeDue(pageId, "posts.refresh");
    await runLive(pageId, () => statusResponse(401), async () => (await coverage(pageId))?.status !== "provider_exhausted");

    expect(await coverage(pageId)).toMatchObject({
      status: "auth_blocked", proof: "none", reason: "session_refused", proofObservationId: "1",
      oldest: new Date(chain.floor.oldestAt), newest: new Date(chain.headAt), cursor: chain,
    });
  });
});
