import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  admitAiMediaAcceleratorReadOutcome,
  claimAiMediaAcceleratorRead,
  createFanslyPage,
  createModel,
  ensureSyncProviderRateLimitProfile,
  insertSyncRequestAttempt,
  requestAiMediaAcceleratorRead,
  reserveSyncProviderRateLimit,
  startSyncRun,
  storeProxyConfig,
} from "@agency_hub_core/db";
import { FanslyApiError, type FanslyMessagesPageResponse, type FanslyRequestContext } from "@agency_hub_core/fansly";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createFanslyFastLane,
  type FanslyFastLaneDeps,
} from "../apps/runtime/src/services/ai-media-describe/fansly-fast-lane.ts";
import type { ResolvedFanslyPageContext } from "../apps/runtime/src/services/page-context.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { serviceFrame } from "./helpers/fansly-ws-fixtures.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// AI media describer — Fansly fast lane (H2): a committed B0 frame → one
// head read (a fake adapter) → journal → the canonical parser → a due
// candidate, with the gates that keep it off the wire beside ordinary sync.

const OWN = "737077689877278720";
const FAN = "700700700";
const GROUP = "9001900190019";
const GENERATION = "gen-1";
const SINCE = new Date(Date.now() - 24 * 3600_000).toISOString();

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let page: Awaited<ReturnType<typeof createFanslyPage>>;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  Object.assign(app.config, {
    aiMediaDescribeEnabled: true,
    aiMediaDescribePagePolicies: JSON.stringify({ "fs-fast": { since: SINCE } }),
    aiMediaDescribeLiveChatOnly: false,
    aiMediaDescribeFanslyFastLaneMode: "serve",
    aiMediaDescribeFanslyFastLanePages: "*",
    aiMediaDescribeFanslyAcceleratorDailyLimit: 150,
    fanslyWsCaptureEnabled: true,
    fanslyWsCapturePageAllowlist: "fs-fast",
    syncSharedRateLimitEnabled: true,
  });
  const model = await createModel(app.db, { slug: "fsf", name: "Fsf" });
  page = await createFanslyPage(app.db, { modelId: model!.id, label: "fs-fast" });
  pageId = page!.id;
  await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, OWN]);
  await storeProxyConfig(app.db, pageId, { url: "socks5://proxy.example.internal:1080", encryptedAuth: null, keyVersion: null });
});

function mediaFrame(messageId: string, contentType = 1, contentId = "8001") {
  return serviceFrame({
    type: 1,
    message: {
      id: messageId, groupId: GROUP, senderId: FAN, createdAt: Math.floor(Date.now() / 1000),
      attachments: [{ contentType, contentId, pos: 0 }],
    },
  });
}

function headPage(messageId: string, mediaId = "8001"): FanslyMessagesPageResponse {
  const raw = {
    messages: [{
      id: messageId, groupId: GROUP, senderId: FAN, content: "", createdAt: Math.floor(Date.now() / 1000),
      attachments: [{ contentType: 1, contentId: mediaId, pos: 0 }],
    }],
    accountMedia: [{
      id: mediaId, accountId: FAN, mediaId: `file-${mediaId}`,
      media: { id: `file-${mediaId}`, type: 1, mimetype: "image/jpeg", width: 1280, height: 720, locations: [] },
    }],
  };
  return {
    items: [{ id: messageId, senderId: FAN }] as unknown as FanslyMessagesPageResponse["items"],
    groupId: GROUP,
    before: null,
    done: true,
    raw: raw as unknown as FanslyMessagesPageResponse["raw"],
  };
}

function lane(options: {
  respond?: (context: FanslyRequestContext) => Promise<FanslyMessagesPageResponse>;
  generation?: string;
} = {}) {
  const calls: Array<{ groupId: string; timeoutMs: number | null | undefined }> = [];
  const deps: FanslyFastLaneDeps = {
    coalesceMs: 0,
    sleep: async () => undefined,
    readGeneration: async () => options.generation ?? GENERATION,
    resolveContext: async () => ({
      page: page!, platform: "fansly", session: {} as never, proxy: null, egressKey: "socks5://proxy.example.internal:1080",
    }) as unknown as ResolvedFanslyPageContext,
    fetchHead: async (context, params) => {
      calls.push({ groupId: params.groupId, timeoutMs: context.requestTimeoutMs });
      // What the adapter does before it dispatches: the admission hook.
      await context.requestObserver?.onRequestEvent({
        state: "started", requestId: `messages:${calls.length}`, operation: "messages",
        endpointTemplate: "/message", method: "GET", attemptNumber: 1, timestamp: new Date(),
      });
      return options.respond ? options.respond(context) : headPage(String(1000 + calls.length));
    },
  };
  const fast = createFanslyFastLane(app, deps);
  return { fast, calls };
}

function frameInput(frame: string) {
  return { pageId, label: "fs-fast", generation: GENERATION, ownRef: OWN, observationId: 1, frame, receivedAt: new Date() };
}

async function reads() {
  const { rows } = await testDb!.pool.query(
    `select lane, status, outcome, http_status, dispatched_at is not null as dispatched, frame_received_at is not null as framed
     from ai_media_accelerator_reads order by id`,
  );
  return rows;
}

describe("Fansly fast lane", () => {
  it("reads a new chat's head once, journals it and makes the fan photo due", async () => {
    const { fast, calls } = lane({ respond: async () => headPage("5001") });
    fast.onCaptured(frameInput(mediaFrame("5001")));
    await fast.idle();
    await fast.stop();

    expect(calls).toEqual([{ groupId: GROUP, timeoutMs: 5000 }]);
    expect(await reads()).toEqual([{ lane: "fast", status: "done", outcome: "fast_lane", http_status: 200, dispatched: true, framed: true }]);
    const journal = await testDb!.pool.query(`select id from observations where account_id = $1 and kind = 'dm_messages'`, [pageId]);
    expect(journal.rows).toHaveLength(1);
    const described = await testDb!.pool.query(
      `select media_ref, status, source_observation_id from ai_media_descriptions where page_id = $1`, [pageId],
    );
    expect(described.rows).toEqual([{ media_ref: "8001", status: "pending", source_observation_id: journal.rows[0].id }]);
    // No roster row existed and none was written.
    const roster = await testDb!.pool.query(`select count(*)::int as n from page_dm_threads`);
    expect(roster.rows[0].n).toBe(0);
  });

  it("shadow files nothing and sends nothing (the in-chunk accelerator keeps its requests); tips never route", async () => {
    app.config.aiMediaDescribeFanslyFastLaneMode = "shadow";
    const { fast, calls } = lane();
    fast.onCaptured(frameInput(mediaFrame("5002")));
    fast.onCaptured(frameInput(mediaFrame("5003", 7, "77")));
    await fast.idle();
    await fast.stop();
    expect(calls).toHaveLength(0);
    expect(await reads()).toEqual([]);
  });

  it("is off for a page the hub's socket does not capture", async () => {
    app.config.fanslyWsCapturePageAllowlist = "other-page";
    const { fast, calls } = lane();
    fast.onCaptured(frameInput(mediaFrame("5010")));
    await fast.idle();
    await fast.stop();
    expect(calls).toHaveLength(0);
    expect(await reads()).toEqual([]);
  });

  it("stays off the wire while a sync request of the egress is unfinished", async () => {
    const run = await startSyncRun(app.db, { platformAccountId: pageId, stream: "dm_conversations", trigger: "worker" });
    await insertSyncRequestAttempt(app.db, {
      syncRunId: run!.id, platformAccountId: pageId, provider: "fansly", stream: "dm_conversations",
      operation: "groups", logicalRequestId: "busy-1", attemptNumber: 1,
    });
    const { fast, calls } = lane();
    fast.onCaptured(frameInput(mediaFrame("5004")));
    await fast.idle();
    await fast.stop();
    // Refused before a pacing slot is even reserved (first look and two
    // retries), then handed to the in-chunk accelerator, still pending.
    expect(calls).toHaveLength(0);
    expect(await reads()).toEqual([{ lane: "chunk", status: "pending", outcome: "handoff_egress_busy", http_status: null, dispatched: false, framed: true }]);
    const admitted = await testDb!.pool.query(`select count(*)::int as n from ai_media_accelerator_reads where admitted_at is not null`);
    expect(admitted.rows[0].n).toBe(0);
  });

  it("respects a page cooling down, a changed session generation and the cap", async () => {
    await testDb!.pool.query(
      `insert into page_sync_states (page_id, stream, status, cadence_seconds, slot_offset_seconds, retry_kind, retry_at) values ($1, 'followers', 'retrying', 3600, 0, 'rate_limit', now() + interval '10 minutes')`,
      [pageId],
    );
    const cooling = lane();
    cooling.fast.onCaptured(frameInput(mediaFrame("5005")));
    await cooling.fast.idle();
    await cooling.fast.stop();
    expect(cooling.calls).toHaveLength(0);
    await testDb!.pool.query(`delete from page_sync_states`);

    const rotated = lane({ generation: "gen-2" });
    rotated.fast.onCaptured(frameInput(mediaFrame("5006")));
    await rotated.fast.idle();
    await rotated.fast.stop();
    expect(rotated.calls).toHaveLength(0);

    app.config.aiMediaDescribeFanslyAcceleratorDailyLimit = 0;
    const capped = lane();
    capped.fast.onCaptured(frameInput(mediaFrame("5007")));
    await capped.fast.idle();
    await capped.fast.stop();
    expect(capped.calls).toHaveLength(0);

    expect((await reads()).map((row) => [row.lane, row.status, row.outcome])).toEqual([
      ["chunk", "pending", "handoff_page_cooldown"],
      ["chunk", "pending", "handoff_generation_changed"],
      ["chunk", "pending", "handoff_budget_exhausted"],
    ]);
  });

  it("a 429 fails the read, records the status and pauses the lane for the egress", async () => {
    const first = lane({
      respond: async () => {
        throw new FanslyApiError("rate limited", 429, undefined, undefined, new Date(Date.now() + 120_000));
      },
    });
    first.fast.onCaptured(frameInput(mediaFrame("5008")));
    await first.fast.idle();
    await first.fast.stop();
    const health = await testDb!.pool.query(`select reason, cooldown_until > now() + interval '14 minutes' as long from ai_media_fast_lane_health`);
    expect(health.rows).toEqual([{ reason: "fansly_429", long: true }]);

    const second = lane();
    second.fast.onCaptured(frameInput(mediaFrame("5009")));
    await second.fast.idle();
    await second.fast.stop();
    expect(second.calls).toHaveLength(0);
    expect((await reads()).map((row) => [row.status, row.outcome, row.http_status])).toEqual([
      ["failed", "fansly_429", 429],
      ["pending", "handoff_lane_cooldown", null],
    ]);
  });

  it("covers only the requests whose messages the response carried", async () => {
    const now = new Date();
    // 6002 is filed first; every head read carries 6001 only.
    await requestAiMediaAcceleratorRead(app.db, { pageId, groupRef: GROUP, messageRef: "6002", now, lane: "fast", generation: GENERATION });
    const { fast } = lane({ respond: async () => headPage("6001") });
    fast.onCaptured(frameInput(mediaFrame("6001")));
    await fast.idle();
    await fast.stop();
    const rows = await testDb!.pool.query(`select message_ref, status, outcome from ai_media_accelerator_reads order by message_ref`);
    expect(rows.rows).toEqual([
      { message_ref: "6001", status: "done", outcome: "covered" },
      { message_ref: "6002", status: "done", outcome: "fast_lane_not_in_head" },
    ]);
  });

  it("stays off the egress for 15 minutes after a sync request met a 429", async () => {
    const run = await startSyncRun(app.db, { platformAccountId: pageId, stream: "followers", trigger: "worker" });
    await insertSyncRequestAttempt(app.db, {
      syncRunId: run!.id, platformAccountId: pageId, provider: "fansly", stream: "followers",
      operation: "followers", logicalRequestId: "429-1", attemptNumber: 1,
    });
    // The in-process retry of that 429 leaves no page cooldown yet.
    await testDb!.pool.query(`update sync_http_attempts set state = 'retry', http_status = 429, finished_at = now()`);
    const { fast, calls } = lane({ respond: async () => headPage("6101") });
    fast.onCaptured(frameInput(mediaFrame("6101")));
    await fast.idle();
    await fast.stop();
    expect(calls).toHaveLength(0);
    expect((await reads()).map((row) => [row.lane, row.status, row.outcome])).toEqual([["chunk", "pending", "handoff_recent_rate_limit"]]);
  });

  it("re-checks at dispatch: a cooldown that appeared during the pacing wait stops the read", async () => {
    const staged = createFanslyFastLane(app, {
      coalesceMs: 0,
      sleep: async () => undefined,
      readGeneration: async () => GENERATION,
      resolveContext: async () => ({
        page: page!, platform: "fansly", session: {} as never, proxy: null, egressKey: "socks5://proxy.example.internal:1080",
      }) as unknown as ResolvedFanslyPageContext,
      fetchHead: async (context) => {
        // While this read waited for its slot, a sync stream of the page hit a 5xx.
        await testDb!.pool.query(
          `insert into page_sync_states (page_id, stream, status, cadence_seconds, slot_offset_seconds, retry_kind, retry_at)
           values ($1, 'dm_conversations', 'retrying', 3600, 0, 'provider_5xx', now() + interval '5 minutes')`, [pageId],
        );
        await context.requestObserver?.onRequestEvent({
          state: "started", requestId: "messages:late", operation: "messages",
          endpointTemplate: "/message", method: "GET", attemptNumber: 1, timestamp: new Date(),
        });
        throw new Error("must not dispatch");
      },
    });
    staged.onCaptured(frameInput(mediaFrame("6201")));
    await staged.idle();
    await staged.stop();
    expect((await reads()).map((row) => [row.lane, row.status, row.outcome, row.dispatched])).toEqual([["chunk", "pending", "handoff_page_cooldown", false]]);
    const admitted = await testDb!.pool.query(`select count(*)::int as n from ai_media_accelerator_reads where admitted_at is not null`);
    expect(admitted.rows[0].n).toBe(0);
  });
});

describe("fast lane plumbing", () => {
  it("admission is compare-and-set: the second lane to admit a request is told it was taken", async () => {
    const now = new Date();
    await requestAiMediaAcceleratorRead(app.db, { pageId, groupRef: GROUP, messageRef: "7001", now });
    const claim = await claimAiMediaAcceleratorRead(app.db, { pageId, now, perConversationGapMs: 0, staleAfterMs: 600_000 });
    await expect(admitAiMediaAcceleratorReadOutcome(app.db, { id: claim!.id, requestId: "a", limit24h: 10, now })).resolves.toBe("admitted");
    await expect(admitAiMediaAcceleratorReadOutcome(app.db, { id: claim!.id, requestId: "b", limit24h: 10, now })).resolves.toBe("taken");
  });

  it("the chunk step leaves fresh requests to a serving fast lane", async () => {
    const now = new Date();
    await requestAiMediaAcceleratorRead(app.db, { pageId, groupRef: GROUP, messageRef: "7101", now });
    await expect(claimAiMediaAcceleratorRead(app.db, { pageId, now, perConversationGapMs: 0, staleAfterMs: 600_000, minAgeMs: 60_000 })).resolves.toBeNull();
    const later = new Date(now.getTime() + 61_000);
    await expect(claimAiMediaAcceleratorRead(app.db, { pageId, now: later, perConversationGapMs: 0, staleAfterMs: 600_000, minAgeMs: 60_000 })).resolves.not.toBeNull();
  });

  it("a held reservation keeps the egress closed for the whole timeout", async () => {
    await ensureSyncProviderRateLimitProfile(app.db, {
      provider: "fansly", egressKey: "hold-egress",
      scopes: [{ scope: "global", minSpacingMs: 2600 }, { scope: "dm_messages", minSpacingMs: 7500 }],
    });
    const now = new Date("2026-09-28T12:00:00Z");
    const held = await reserveSyncProviderRateLimit(app.db, {
      scopes: [{ provider: "fansly", scope: "global", egressKey: "hold-egress" }], now, holdMs: 5500,
    });
    const next = await reserveSyncProviderRateLimit(app.db, {
      scopes: [{ provider: "fansly", scope: "global", egressKey: "hold-egress" }], now,
    });
    expect(next.getTime() - held.getTime()).toBe(5500);
  });
});
