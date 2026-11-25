import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  createOrGetOfapiCaptureJob,
  findAgentHydrationRequestByRef,
  insertAgentKey,
  listAgentObservations,
  listDispatchingAgentHydrationRequests,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  reconcileAgentHydrationDispatches,
  sweepStuckAgentHydration,
} from "../apps/runtime/src/services/agent-hydration.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}wave4b-agent-token`;

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
let ownerId = 0;
let agentKeyId = 0;
let page1Id = 0;
let page2Id = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb);

  const model = await createModel(testDb.db, { slug: "wave4b-model", name: "Wave4B Model" });
  const p1 = await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "wave4b-p1" });
  const p2 = await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "wave4b-p2" });
  page1Id = p1!.id;
  page2Id = p2!.id;

  await testDb.pool.query(
    "update pages set ofapi_account_id = 'acct_wave4b_p1' where id = $1",
    [page1Id],
  );

  const owner = await createUserAccount(
    appContext,
    { username: "owner", role: "owner", password: "owner-secret" },
    { source: "cli" },
  );
  ownerId = owner!.id;

  const key = await insertAgentKey(testDb.db, {
    name: "wave4b-agent",
    keyPrefix: AGENT_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(AGENT_TOKEN),
    capabilities: ["read:messages", "request:hydration"],
    pageIds: [page1Id, page2Id],
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: ownerId,
  });
  agentKeyId = key.id;

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();

  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "owner", password: "owner-secret" },
  });
  const setCookie = login.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  ownerCookie = String(raw ?? "").split(";")[0] ?? "";
  expect(ownerCookie).not.toBe("");
});

afterEach(async () => {
  await server?.close();
  server = null;
});

async function seedOnlyFansThread(pageId: number, conversationRef: string, fanRef: string) {
  const { rows } = await testDb!.pool.query<{ id: string }>(
    `insert into fans (platform, platform_user_id, username, first_seen_at)
     values ('onlyfans', $1, $2, '2026-01-05T00:00:00Z')
     returning id`,
    [fanRef, `fan-${fanRef}`],
  );
  const { rows: threadRows } = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
       oldest_stored_message_id, newest_stored_message_id, last_message_id)
     values ($1, $2, $3, $4, 4, 'partial_window', '2026-03-02T00:00:00Z', 'm-1', 'm-4', 'm-4')
     returning id`,
    [pageId, Number(rows[0]!.id), conversationRef, fanRef],
  );
  return Number(threadRows[0]!.id);
}

describe("agent read plane Wave 4B fixes", () => {
  it("drops unused domain_events_smoke_checkpoint table in migration 0450 (BL-A10)", async () => {
    const { rows } = await testDb!.pool.query<{ reg: string | null }>(
      "select to_regclass('public.domain_events_smoke_checkpoint')::text as reg",
    );
    expect(rows[0]?.reg).toBeNull();
  });

  it("paginates observations by native (received_at, id) before detoasting payload (BL-A13)", async () => {
    const timestamps = [
      "2026-03-10T10:00:00.000000Z",
      "2026-03-10T11:00:00.123456Z",
      "2026-03-10T11:00:00.123456Z", // exact microsecond tie
      "2026-03-10T12:00:00.654321Z",
      "2026-03-10T13:00:00.000000Z",
    ];
    const seededIds: number[] = [];
    for (let i = 0; i < timestamps.length; i += 1) {
      const payload = { seq: i, body: `payload-${i}-${"x".repeat(20 * (i + 1))}` };
      const hash = createHash("sha256").update(JSON.stringify(payload)).digest();
      const targetPageId = i % 2 === 0 ? page1Id : page2Id;
      const { rows } = await testDb!.pool.query<{ id: string }>(
        `insert into observations (
           account_id, received_at, observed_at, source, producer, platform,
           native_account_ref, kind, idempotency_key, payload, payload_hash, parse_version
         ) values (
           $1, $2::timestamptz, $2::timestamptz, 'pull', 'test-producer', 'onlyfans',
           'acct_wave4b_p1', 'dm_messages', $3, $4::jsonb, $5, 1
         ) returning id`,
        [targetPageId, timestamps[i], `wave4b-obs-${i}`, JSON.stringify(payload), hash],
      );
      seededIds.push(Number(rows[0]!.id));
    }

    const from = new Date("2026-03-10T00:00:00.000Z");
    const to = new Date("2026-03-11T00:00:00.000Z");

    // Walk descending with limit 2 across all 5 observations.
    const descWalk: number[] = [];
    let after: { sortValue: string | null; key: string } | undefined;
    for (let page = 0; page < 4; page += 1) {
      const res = await listAgentObservations(testDb!.db, {
        pageIds: [page1Id, page2Id],
        from,
        to,
        sortDir: "desc",
        limit: 2,
        after,
      });
      for (const row of res.rows) {
        descWalk.push(row.observationRef);
        expect(row.payloadBytes).toBeGreaterThan(20);
      }
      if (res.rows.length < 2) break;
      const last = res.rows.at(-1)!;
      after = { sortValue: last.sortValue, key: last.keysetKey };
    }
    expect(descWalk).toEqual([...seededIds].reverse());

    // Walk ascending filtered by pageLabel.
    const ascP1: number[] = [];
    let ascAfter: { sortValue: string | null; key: string } | undefined;
    for (let page = 0; page < 4; page += 1) {
      const res = await listAgentObservations(testDb!.db, {
        pageIds: [page1Id, page2Id],
        pageLabel: "wave4b-p1",
        from,
        to,
        sortDir: "asc",
        limit: 2,
        after: ascAfter,
      });
      for (const row of res.rows) {
        expect(row.pageLabel).toBe("wave4b-p1");
        ascP1.push(row.observationRef);
      }
      if (res.rows.length < 2) break;
      const last = res.rows.at(-1)!;
      ascAfter = { sortValue: last.sortValue, key: last.keysetKey };
    }
    expect(ascP1).toEqual([seededIds[0], seededIds[2], seededIds[4]]);
  });

  it("degrades #8 coverage cleanly when readAgentJournalFloor hits statement_timeout (BL-A13)", async () => {
    await seedOnlyFansThread(page1Id, "cov-chat-1", "90001");

    const baseDb = appContext.db;
    const proxyDb = new Proxy(baseDb, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              const wrappedTx = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "execute") {
                    return async (query: unknown) => {
                      const chunks = JSON.stringify(query);
                      if (chunks.includes("pg_class") && chunks.includes("observations_")) {
                        const err = new Error("canceling statement due to statement timeout") as Error & { code: string };
                        err.code = "57014";
                        throw err;
                      }
                      return txTarget.execute(query as Parameters<typeof txTarget.execute>[0]);
                    };
                  }
                  return Reflect.get(txTarget, txProp, txReceiver);
                },
              });
              return fn(wrappedTx);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const proxyServer = await buildApiServer({ ...appContext, db: proxyDb });
    await proxyServer.ready();
    try {
      const res = await proxyServer.inject({
        method: "GET",
        url: "/api/v1/agent/coverage?from=2026-03-01T00:00:00.000Z&to=2026-03-05T00:00:00.000Z&limit=20",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const response = res.json();
      expect(response.items).toHaveLength(1);
      expect(response.journalFloor).toEqual({
        observationsFirstReceivedAt: null,
        detachedPartitions: [],
      });
      expect(response.capture.sourceErrors).toContainEqual({
        source: "observations",
        code: "statement_timeout",
        excludedFromCounts: true,
      });
      expect(response.conclusion.blockers).toContain("source_errors_present");
    } finally {
      await proxyServer.close();
    }
  });

  it("cursor-paginates the owner hydration approval queue with frozen snapshot and scope binding (BL-C1)", async () => {
    const filedRefs: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const conv = `queue-chat-${i}`;
      await seedOnlyFansThread(page1Id, conv, `9100${i}`);
      const res = await server!.inject({
        method: "POST",
        url: `/api/v1/agent/pages/wave4b-p1/threads/${conv}/hydration-requests`,
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        payload: {
          target: { kind: "thread_backfill_before", beforeAt: "2026-02-01T00:00:00Z" },
          reason: `Missing january rows #${i}`,
          maxCalls: 3,
          idempotencyKey: randomUUID(),
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      filedRefs.push(res.json().request.requestRef as string);
    }

    // Pin two requests to the exact same microsecond created_at to verify (created_at, id) tiebreak.
    await testDb!.pool.query(
      `update agent_hydration_requests
       set created_at = '2026-03-10T12:00:00.123456Z'::timestamptz
       where request_ref in ($1::uuid, $2::uuid)`,
      [filedRefs[2], filedRefs[3]],
    );

    const p1 = await server!.inject({
      method: "GET",
      url: "/api/v1/agent/hydration-requests?state=requested&limit=2",
      headers: { cookie: ownerCookie },
    });
    expect(p1.statusCode, p1.body).toBe(200);
    const body1 = p1.json();
    expect(body1.items).toHaveLength(2);
    expect(body1.delivery.nextCursor).toEqual(expect.any(String));
    expect(body1.delivery.cappedBy).toBe("limit");
    expect(body1.delivery.snapshotExhausted).toBe(false);
    expect(body1.delivery.matchedInScope.exact).toBe(false);

    // Insert a 6th request mid-traversal: frozen maxId keeps the walk stable.
    await seedOnlyFansThread(page1Id, "queue-chat-late", "91099");
    const lateRes = await server!.inject({
      method: "POST",
      url: "/api/v1/agent/pages/wave4b-p1/threads/queue-chat-late/hydration-requests",
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: {
        target: { kind: "thread_backfill_before", beforeAt: "2026-02-01T00:00:00Z" },
        reason: "Arrived after page 1",
        maxCalls: 3,
        idempotencyKey: randomUUID(),
      },
    });
    expect(lateRes.statusCode).toBe(200);
    const lateRef = lateRes.json().request.requestRef as string;

    const p2 = await server!.inject({
      method: "GET",
      url: `/api/v1/agent/hydration-requests?state=requested&limit=2&cursor=${encodeURIComponent(body1.delivery.nextCursor)}`,
      headers: { cookie: ownerCookie },
    });
    expect(p2.statusCode, p2.body).toBe(200);
    const body2 = p2.json();
    expect(body2.items).toHaveLength(2);
    expect(body2.delivery.nextCursor).toEqual(expect.any(String));

    const p3 = await server!.inject({
      method: "GET",
      url: `/api/v1/agent/hydration-requests?state=requested&limit=2&cursor=${encodeURIComponent(body2.delivery.nextCursor)}`,
      headers: { cookie: ownerCookie },
    });
    expect(p3.statusCode, p3.body).toBe(200);
    const body3 = p3.json();
    expect(body3.items).toHaveLength(1);
    expect(body3.delivery.nextCursor).toBeNull();
    expect(body3.delivery.cappedBy).toBeNull();
    // Filtered by mutable `state=requested`: rows can change state during pagination, so not a frozen snapshot.
    expect(body3.delivery.snapshotExhausted).toBe(false);

    // Unfiltered queue is append-only under id <= highWater, so exhaustion is genuinely a frozen snapshot.
    const unfiltered = await server!.inject({
      method: "GET",
      url: "/api/v1/agent/hydration-requests?limit=50",
      headers: { cookie: ownerCookie },
    });
    expect(unfiltered.statusCode, unfiltered.body).toBe(200);
    expect(unfiltered.json().delivery.snapshotExhausted).toBe(true);

    const walkedRefs = [
      ...body1.items.map((x: { requestRef: string }) => x.requestRef),
      ...body2.items.map((x: { requestRef: string }) => x.requestRef),
      ...body3.items.map((x: { requestRef: string }) => x.requestRef),
    ];
    expect(new Set(walkedRefs).size).toBe(5);
    expect(walkedRefs.sort()).toEqual([...filedRefs].sort());
    expect(walkedRefs).not.toContain(lateRef);

    // Replaying cursor under a different state filter or tampered returns 400 agent_cursor_invalid.
    const wrongState = await server!.inject({
      method: "GET",
      url: `/api/v1/agent/hydration-requests?state=approved&limit=2&cursor=${encodeURIComponent(body1.delivery.nextCursor)}`,
      headers: { cookie: ownerCookie },
    });
    expect(wrongState.statusCode).toBe(400);
    expect(wrongState.json().error).toBe("agent_cursor_invalid");

    const tampered = await server!.inject({
      method: "GET",
      url: `/api/v1/agent/hydration-requests?state=requested&limit=2&cursor=${encodeURIComponent(`${body1.delivery.nextCursor}x`)}`,
      headers: { cookie: ownerCookie },
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error).toBe("agent_cursor_invalid");
  });

  it("prioritizes terminal capture jobs and paginates sweeps so live dispatches never starve settlement (BL-C2)", async () => {
    const baseTime = new Date("2026-03-10T10:00:00.000Z");
    const liveRefs: string[] = [];

    // Seed 25 older dispatching requests backed by LIVE `ready` capture jobs (> SWEEP_BATCH_LIMIT=20).
    for (let i = 0; i < 25; i += 1) {
      const conv = `live-chat-${i}`;
      const threadId = await seedOnlyFansThread(page1Id, conv, `920${String(i).padStart(2, "0")}`);
      const { job } = await createOrGetOfapiCaptureJob(testDb!.db, {
        pageId: page1Id,
        ofapiAccountId: "acct_wave4b_p1",
        kind: "chat_paginate",
        goal: "history_to_exhaustion",
        activeSlotKey: `page:${page1Id}:chat:${conv}`,
        target: { conversationRef: conv },
        budgetScope: "bulk",
        originPrincipalId: ownerId,
        createdBy: "owner",
        maxCalls: 5,
        maxCredits: 3,
        maxPages: 4,
        maxItems: 100,
      });
      const reqRef = randomUUID();
      liveRefs.push(reqRef);
      const dispatchedAt = new Date(baseTime.getTime() + i * 1000);
      await testDb!.pool.query(
        `insert into agent_hydration_requests (
           request_ref, agent_key_id, page_id, conversation_ref, thread_id, state,
           target_kind, target_before_at, reason_sha256, reason_length, idempotency_key,
           request_fingerprint, coverage_fingerprint, lane_order_evaluated,
           lane_selected, lane_cost_note, admissible,
           dispatched_at, dispatch_deadline_at, execution_lane, execution_ref, dispatch_count
         ) values (
           $1::uuid, $2, $3, $4, $5, 'dispatching',
           'thread_backfill_before', '2026-02-01T00:00:00Z'::timestamptz, $6, 10, $7,
           $6, $6, array['free_local_replay', 'vendor_paid_high'],
           'vendor_paid_high', 'ofapi_credits', true,
           $8, $9, 'vendor_paid_high', $10, 1
         )`,
        [
          reqRef,
          agentKeyId,
          page1Id,
          conv,
          threadId,
          sha256Hex(`live-${i}`),
          randomUUID(),
          dispatchedAt,
          new Date(Date.now() + 60 * 60_000),
          job.id,
        ],
      );
    }

    // Seed 1 NEWER dispatching request backed by a COMPLETED capture job.
    const doneConv = "done-chat-newer";
    const doneThreadId = await seedOnlyFansThread(page1Id, doneConv, "92999");
    const { job: doneJob } = await createOrGetOfapiCaptureJob(testDb!.db, {
      pageId: page1Id,
      ofapiAccountId: "acct_wave4b_p1",
      kind: "chat_paginate",
      goal: "history_to_exhaustion",
      activeSlotKey: `page:${page1Id}:chat:${doneConv}`,
      target: { conversationRef: doneConv },
      budgetScope: "bulk",
      originPrincipalId: ownerId,
      createdBy: "owner",
      maxCalls: 5,
      maxCredits: 3,
      maxPages: 4,
      maxItems: 100,
    });
    const obsHash = createHash("sha256").update("{}").digest();
    const { rows: termObsRows } = await testDb!.pool.query<{ id: string; received_at: string }>(
      `insert into observations (
         account_id, received_at, observed_at, source, producer, platform,
         native_account_ref, kind, idempotency_key, payload, payload_hash, parse_version
       ) values (
         $1, '2026-03-10T12:00:00Z'::timestamptz, '2026-03-10T12:00:00Z'::timestamptz,
         'pull', 'test-producer', 'onlyfans', 'acct_wave4b_p1', 'dm_messages',
         'wave4b-terminal-obs', '{}'::jsonb, $2, 1
       ) returning id, received_at`,
      [page1Id, obsHash],
    );
    await testDb!.pool.query(
      `update ofapi_capture_jobs
       set state = 'complete',
           accepted_items = 7,
           accepted_pages = 2,
           spent_credits = 1,
           terminal_observation_id = $2,
           terminal_observation_received_at = $3,
           completed_at = now()
       where id = $1::uuid`,
      [doneJob.id, Number(termObsRows[0]!.id), termObsRows[0]!.received_at],
    );
    const doneRef = randomUUID();
    await testDb!.pool.query(
      `insert into agent_hydration_requests (
         request_ref, agent_key_id, page_id, conversation_ref, thread_id, state,
         target_kind, target_before_at, reason_sha256, reason_length, idempotency_key,
         request_fingerprint, coverage_fingerprint, lane_order_evaluated,
         lane_selected, lane_cost_note, admissible,
         dispatched_at, dispatch_deadline_at, execution_lane, execution_ref, dispatch_count
       ) values (
         $1::uuid, $2, $3, $4, $5, 'dispatching',
         'thread_backfill_before', '2026-02-01T00:00:00Z'::timestamptz, $6, 10, $7,
         $6, $6, array['free_local_replay', 'vendor_paid_high'],
         'vendor_paid_high', 'ofapi_credits', true,
         $8, $9, 'vendor_paid_high', $10, 1
       )`,
      [
        doneRef,
        agentKeyId,
        page1Id,
        doneConv,
        doneThreadId,
        sha256Hex("done-newer"),
        randomUUID(),
        new Date(baseTime.getTime() + 60_000),
        new Date(Date.now() + 60 * 60_000),
        doneJob.id,
      ],
    );

    // Also seed a dispatching request with a non-UUID execution_ref so the LEFT JOIN cast stays safe.
    const nonUuidRef = randomUUID();
    await testDb!.pool.query(
      `insert into agent_hydration_requests (
         request_ref, agent_key_id, page_id, conversation_ref, thread_id, state,
         target_kind, target_before_at, reason_sha256, reason_length, idempotency_key,
         request_fingerprint, coverage_fingerprint, lane_order_evaluated,
         lane_selected, lane_cost_note, admissible,
         dispatched_at, dispatch_deadline_at, execution_lane, execution_ref, dispatch_count
       ) values (
         $1::uuid, $2, $3, $4, $5, 'dispatching',
         'thread_backfill_before', '2026-02-01T00:00:00Z'::timestamptz, $6, 10, $7,
         $6, $6, array['free_local_replay', 'vendor_paid_high'],
         'vendor_paid_high', 'ofapi_credits', true,
         $8, $9, 'vendor_paid_high', 'non-uuid-legacy-ref', 1
       )`,
      [
        nonUuidRef,
        agentKeyId,
        page1Id,
        doneConv,
        doneThreadId,
        sha256Hex("non-uuid-ref"),
        randomUUID(),
        new Date(baseTime.getTime() + 120_000),
        new Date(Date.now() + 60 * 60_000),
      ],
    );

    // Verify terminal capture job sorts FIRST ahead of all 25 older live jobs (and non-UUID ref does not throw).
    const topBatch = await listDispatchingAgentHydrationRequests(testDb!.db, { limit: 1 });
    expect(topBatch[0]?.requestRef).toBe(doneRef);

    // Reconciliation must settle the newer completed request on the very first pass.
    const reconciled = await reconcileAgentHydrationDispatches(appContext);
    expect(reconciled).toBe(1);
    const settled = await findAgentHydrationRequestByRef(testDb!.db, doneRef);
    expect(settled.request).toMatchObject({
      state: "completed",
      acceptedItems: 7,
      acceptedPages: 2,
    });

    // Now put all 25 live dispatches past their deadline, and point the 25th (newest deadline)
    // to a missing capture job (`gone`). The stuck sweep must walk past the 24 running jobs
    // and sweep the 25th instead of starving behind the first 20.
    const orphanRef = liveRefs[24]!;
    await testDb!.pool.query(
      `update agent_hydration_requests
       set dispatch_deadline_at = $1::timestamptz + (id * interval '1 second')
       where state = 'dispatching'`,
      [new Date(Date.now() - 2 * 60 * 60_000)],
    );
    await testDb!.pool.query(
      `update agent_hydration_requests
       set execution_ref = $1
       where request_ref = $2::uuid`,
      [randomUUID(), orphanRef],
    );

    const swept = await sweepStuckAgentHydration(appContext);
    expect(swept).toBe(2);
    const failed = await findAgentHydrationRequestByRef(testDb!.db, orphanRef);
    expect(failed.request).toMatchObject({
      state: "failed",
      lastError: "timeout",
    });
    const failedNonUuid = await findAgentHydrationRequestByRef(testDb!.db, nonUuidRef);
    expect(failedNonUuid.request).toMatchObject({
      state: "failed",
      lastError: "timeout",
    });
  });
});
