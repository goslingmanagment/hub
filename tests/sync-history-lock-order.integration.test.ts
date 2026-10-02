import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSyncPage,
  lockOwnedPage,
  lockWorkRows,
  pickRequests,
  settleWork,
  upsertFans,
  writeThreadChain,
  type Database,
} from "@agency_hub_core/db";

import { admit, type CommitDeps } from "../apps/runtime/src/sync/engine/commit.ts";
import { createEngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  cancelHistoryRequest,
  onHistoryThreadChainChanged,
  submitHistoryRequest,
  type HistoryServiceContext,
} from "../apps/runtime/src/sync/requests/history.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { makeTestActor, seedSyncPage, testConfig } from "./helpers/sync-engine-host.ts";

// Lock order of the history requests (design §3.7, §7.1.5, SK11): intake and
// cancel take their sync_work rows first (id order, then new rows by key),
// then history_requests, then history_request_items — the order of the
// actor's admission (sync_pages → sync_work → requests → items) and of its
// apply hook (sync_pages → sync_work → requests → items). 200 rounds of an
// intake, a cancel, an admission and an apply racing on one chat: never a
// deadlock (40P01).

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

const EPOCH_MS = 1561494359900;
const OWN = "300000000000000001";
const FAN = "510000000000000001";
const BASE_MS = Date.now() - 6 * 3_600_000;
const msg = (k: number) => ((BigInt(BASE_MS + k * 1000 - EPOCH_MS) << 22n)).toString();
const GROUP_A = "710000000000000001";
const GROUP_B = "710000000000000002";

async function seedThread(pageId: number, groupId: string): Promise<number> {
  const [fan] = await upsertFans(db(), [{ platform: "fansly" as const, platformUserId: `${FAN}${groupId.slice(-1)}` }]);
  const inserted = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
            stored_message_count, message_coverage_status, is_visible, last_message_at)
     values ($1, $2, $3, $4, 10, 'partial_window', true, now()) returning id::text as id`,
    [pageId, groupId, fan!.id, fan!.platformUserId],
  );
  const threadId = Number(inserted.rows[0]!.id);
  await db().transaction(async (tx) => {
    await writeThreadChain(tx as unknown as Database, threadId, {
      source: "journal_rebuild",
      chain: {
        epoch: 0, state: "partial", headId: msg(40), headAt: new Date(Date.now() - 3_600_000), oldestId: msg(31),
        oldestCreatedAtMs: BASE_MS + 31_000, count: 10, upwardCount: 0, proof: null, proofWitness: null, provenAt: null,
      },
    });
  });
  return threadId;
}

function isDeadlock(error: unknown): boolean {
  for (let link: unknown = error, depth = 0; link !== null && link !== undefined && depth < 6; depth += 1) {
    if ((link as { code?: unknown }).code === "40P01") return true;
    link = (link as { cause?: unknown }).cause;
  }
  return false;
}

describe("history requests vs the actor: lock order", () => {
  it("200 rounds of intake, cancel, admission and apply on the same chats never deadlock", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, OWN]);
    await testDb.pool.query(
      `update sync_pages set requests_enabled_at = clock_timestamp() - interval '1 minute',
              legacy_imported_at = clock_timestamp(), mode_changed_at = clock_timestamp() - interval '1 day'
        where page_id = $1`,
      [pageId],
    );
    const threadA = await seedThread(pageId, GROUP_A);
    const threadB = await seedThread(pageId, GROUP_B);
    const ctx: HistoryServiceContext = { db: db(), rawConfig: testConfig(testDb.connectionString) };
    const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
    const { deps } = await makeTestActor({ db: db(), pageId, mode: "live", registry });
    const commit: CommitDeps = deps;
    const module = await registry.module("dm-messages.history");
    const grant = { settingMs: 2_000, jitterU: 0.1, pauseMs: 2_200, earliestMono: 0 };

    const file = (groups: readonly string[]) => submitHistoryRequest(ctx, {
      pageId,
      requester: { kind: "owner_cli", userId: null },
      // Both chats, in either order: the work rows are locked in id order
      // whatever the request's order.
      fans: groups.map((conversationRef) => ({ kind: "conversation" as const, conversationRef })),
      depth: { kind: "latest", count: 1_000 },
      reason: "lock order",
      idempotencyKey: randomUUID(),
    });

    /** One admission (tx 1) of the next requests turn, then its apply-like
     *  tx 3: page FOR SHARE → the work row → the history hook. */
    const admitAndApply = async (): Promise<string> => {
      const picked = await pickRequests(db(), { pageId, shadow: false });
      if (picked === null) return "idle";
      const groupId = picked.work.subject;
      const admitted = await admit(commit, {
        work: picked.work,
        workClass: "requests",
        slot: 1,
        nextCyclePos: 2,
        requestTurn: { requestId: picked.requestId, itemId: picked.itemId },
      }, { spec: "messages.page", params: { groupId, before: null } }, grant, module);
      if (admitted === null) return "lost_race";
      await db().transaction(async (raw) => {
        const tx = raw as unknown as Database;
        await lockOwnedPage(tx, { pageId, generation: commit.generation, lock: "share" });
        await lockWorkRows(tx, [picked.work.id]);
        await settleWork(tx, {
          workId: picked.work.id,
          generation: commit.generation,
          servedRevision: admitted.demandRevision,
          satisfiesRevision: false,
          nextDueAt: new Date(Date.now() - 1_000),
        });
        await onHistoryThreadChainChanged(tx, { pageId, threadId: groupId === GROUP_A ? threadA : threadB });
      });
      return "admitted";
    };

    let previous = await file([GROUP_A, GROUP_B]);
    const outcomes = { deadlocks: 0, admitted: 0, cancelled: 0, filed: 0, otherErrors: [] as string[] };
    for (let round = 0; round < 200; round += 1) {
      const toCancel = previous.request.ref;
      const results = await Promise.allSettled([
        file(round % 2 === 0 ? [GROUP_A, GROUP_B] : [GROUP_B, GROUP_A]),
        cancelHistoryRequest(ctx, toCancel, { reason: "round" }),
        admitAndApply(),
      ]);
      for (const result of results) {
        if (result.status === "fulfilled") continue;
        if (isDeadlock(result.reason)) outcomes.deadlocks += 1;
        else outcomes.otherErrors.push(String((result.reason as Error)?.message ?? result.reason));
      }
      if (results[0].status === "fulfilled") {
        outcomes.filed += 1;
        previous = results[0].value;
      }
      if (results[1].status === "fulfilled" && results[1].value.disposition === "cancelled") outcomes.cancelled += 1;
      if (results[2].status === "fulfilled" && results[2].value === "admitted") outcomes.admitted += 1;
    }

    expect(outcomes.deadlocks).toBe(0);
    expect(outcomes.otherErrors).toEqual([]);
    expect(outcomes.filed).toBe(200);
    expect(outcomes.cancelled).toBe(200);
    expect(outcomes.admitted).toBeGreaterThan(0);
    // Consistency: every open fan rides on an open (or running) work row of
    // its chat, and only the last request is still open.
    const orphans = await testDb.pool.query(
      `select i.id from history_request_items i left join sync_work w on w.id = i.work_id
        where i.state in ('queued', 'loading', 'blocked') and (w.id is null or w.state not in ('open', 'running'))`,
    );
    expect(orphans.rows).toEqual([]);
    const open = await testDb.pool.query<{ n: number }>("select count(*)::int as n from history_requests where state = 'open'");
    expect(open.rows[0]!.n).toBe(1);
    expect((await getSyncPage(db(), pageId))!.mode).toBe("live");
  }, 300_000);
});
