import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureFanslyPageSendGuard,
  ensureSyncProviderRateLimitProfile,
} from "@agency_hub_core/db";
import { FanslyAdapter, type FanslySendSource } from "@agency_hub_core/fansly";

import {
  createFanslySendGuards,
  type FanslySendGuardRegistry,
} from "../apps/runtime/src/services/fansly-send-guard/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { startFakeFanslyNetwork, type FakeFanslyNetwork } from "./helpers/fansly-send-guard-network.ts";
import { silentFanslySendGuardLogger } from "./helpers/fansly-send-guard.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Plan §2.3 / §2.5 p.4: the legacy endpoint pauses are gone. Requests for
// messages, the chat list and followers are paced by the page's send guard
// alone — S × (1 + u) from the previous completion, one request in flight —
// whatever the env still says (production: 7500 / 5000 / 5000) and whatever
// rows the retired `sync_rate_limits` scopes left behind. Real adapter, real
// database-backed guard, a fake Fansly behind a CONNECT proxy.

const S_MS = 400;
const RETIRED_SCOPES = [
  { scope: "dm_conversations", minSpacingMs: 5_000 },
  { scope: "dm_messages", minSpacingMs: 7_500 },
  { scope: "followers_page", minSpacingMs: 5_000 },
];

let testDb: StartedTestDatabase | null = null;
let network: FakeFanslyNetwork | null = null;
let adapter: FanslyAdapter | null = null;
let registry: FanslySendGuardRegistry | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

afterEach(async () => {
  await registry?.close();
  await adapter?.close();
  await network?.close();
  registry = null;
  adapter = null;
  network = null;
});

function answer(path: string) {
  if (path.startsWith("/messaging/groups")) {
    return { success: true, response: { data: [], aggregationData: { groups: [], accounts: [] } } };
  }
  if (path.includes("/followersnew")) {
    return {
      success: true,
      response: { followers: [{ id: "follow-1", followerId: "fan-1" }], aggregationData: { accounts: [] } },
    };
  }
  return { success: true, response: { messages: [] } };
}

describe("Fansly requests after the endpoint pauses were retired", () => {
  it("are spaced by the page's send guard alone, and leave the retired pacing rows untouched", async (context) => {
    if (!testDb) return context.skip();
    // The env values the production env still sets: parsed, ignored.
    const app = createTestAppContext(testDb, {
      fanslyDefaultDelayMs: S_MS,
      fanslyDmMessagesDelayMs: 7_500,
      fanslyDmConversationsDelayMs: 5_000,
      followerPageDelayMs: 5_000,
      syncSharedRateLimitEnabled: true,
    });
    const model = await createModel(app.db, { slug: "pauses-retired", name: "Pauses retired" });
    const page = (await createFanslyPage(app.db, { modelId: model!.id, label: `retired-${randomUUID().slice(0, 8)}` }))!;
    await ensureFanslyPageSendGuard(app.db, page.id);
    await testDb.pool.query(
      "update fansly_page_send_guards set last_completed_at = now() - interval '1 hour', next_u = 0 where page_id = $1",
      [page.id],
    );

    network = await startFakeFanslyNetwork({
      respond: (request, response) => {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(answer(new URL(request.url ?? "/", "http://origin").pathname)));
        }, 10 + Math.random() * 30);
      },
    });
    const egressKey = network.proxyUrl;

    // What the retired limiter would have waited out: every scope of the
    // page's egress reserved an hour ahead.
    await ensureSyncProviderRateLimitProfile(app.db, { provider: "fansly", egressKey, scopes: RETIRED_SCOPES });
    await testDb.pool.query(
      `update sync_rate_limits set next_available_at = date_trunc('second', now()) + interval '1 hour',
              updated_at = date_trunc('second', now()) where egress_key = $1`,
      [egressKey],
    );
    const rowsBefore = await testDb.pool.query(
      "select provider, scope, egress_key, min_spacing_ms, next_available_at, updated_at from sync_rate_limits order by scope",
    );

    // S is read fresh from the effective config before every capture.
    registry = createFanslySendGuards({ db: app.db, config: app.config, logger: silentFanslySendGuardLogger, role: "test" });
    adapter = new FanslyAdapter({ baseUrl: network.baseUrl });
    const fansly = adapter;
    const contextFor = (source: FanslySendSource) => ({
      session: { authorization: "synthetic" },
      proxy: { url: network!.proxyUrl },
      egressKey,
      remainingAttempts: () => 1,
      sendGuard: registry!.forPage(page.id, source),
    });

    // Two senders of the page at once: a sync chunk walking messages, the
    // chat list and followers, and a targeted backfill walking one thread.
    const startedAt = performance.now();
    const chunk = contextFor("sync_stream");
    const backfill = contextFor("targeted_backfill");
    const chunkRun = (async () => {
      for (let index = 0; index < 4; index += 1) {
        await fansly.getMessagesPage(chunk, { groupId: `group-${index}`, limit: 25 });
      }
      await fansly.getMessagingGroupsPage(chunk, { offset: 0, limit: 25 });
      await fansly.getMessagingGroupsPage(chunk, { offset: 25, limit: 25 });
      await fansly.getFollowersPage(chunk, "acct-1", { offset: 0, limit: 100 });
      await fansly.getMessagesPage(chunk, { groupId: "group-9", limit: 25 });
    })();
    const backfillRun = (async () => {
      for (let index = 0; index < 4; index += 1) {
        await fansly.getMessagesPage(backfill, { groupId: "thread-1", limit: 25, before: `m-${index}` });
      }
    })();
    await Promise.all([chunkRun, backfillRun]);
    const elapsedMs = performance.now() - startedAt;

    const arrivals = [...network.arrivals].sort((left, right) => left.monotonicMs - right.monotonicMs);
    expect(arrivals).toHaveLength(12);
    const gaps = arrivals.slice(1).map((arrival, index) => arrival.monotonicMs - arrivals[index]!.monotonicMs);
    // Never closer than S: the guard counts from the previous completion.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(S_MS);
    // And nothing else spaces them: not the 7.5 s message pause, not the 5 s
    // chat-list / follower pause, not the hour the retired rows reserve.
    expect(Math.max(...gaps)).toBeLessThan(4_000);
    expect(elapsedMs).toBeLessThan(12 * 2_000);
    expect(arrivals.filter((arrival) => arrival.path.startsWith("/message?"))).toHaveLength(9);

    const journal = await testDb.pool.query<{ source: string; operation: string; setting_ms: number; pause_ms: number; outcome: string }>(
      `select source, operation, setting_ms, pause_ms, outcome
         from fansly_send_log where page_id = $1 order by captured_at`,
      [page.id],
    );
    expect(journal.rows).toHaveLength(12);
    for (const row of journal.rows) {
      expect(row.outcome).toBe("response");
      expect(row.setting_ms).toBe(S_MS);
      expect(row.pause_ms).toBeGreaterThanOrEqual(S_MS);
      expect(row.pause_ms).toBeLessThanOrEqual(Math.ceil(S_MS * 1.2));
    }
    expect(journal.rows.filter((row) => row.source === "targeted_backfill")).toHaveLength(4);
    expect(new Set(journal.rows.map((row) => row.operation))).toEqual(new Set(["messages", "messaging_groups", "followers"]));

    // The retired rows are left as they were (never deleted, never reserved),
    // and no Fansly row is created for any egress.
    const rowsAfter = await testDb.pool.query(
      "select provider, scope, egress_key, min_spacing_ms, next_available_at, updated_at from sync_rate_limits order by scope",
    );
    expect(rowsAfter.rows).toEqual(rowsBefore.rows);
    expect(rowsAfter.rows.map((row) => row.scope)).toEqual(RETIRED_SCOPES.map((entry) => entry.scope));
  }, 60_000);
});
