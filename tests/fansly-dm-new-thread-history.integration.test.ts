// The first read of a Fansly thread whose history began after the page's DM
// onboarding walks past the 25-message start window to the provider's end;
// a thread with history older than onboarding still stops at the window (deep
// backfill of old threads stays off). Real Postgres, because the onboarding
// boundary is read off page_dm_threads.first_seen_at.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  getCheckpoint,
  getPageDmConversationById,
  getPageDmOnboardedAt,
  startSyncRun,
  upsertFans,
  upsertPageDmConversation,
} from "@agency_hub_core/db";
import type { HttpRequestEvent } from "@agency_hub_core/shared";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { fanslyDmMessagesChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { fakeTelemetry, PAGE_ACCOUNT_ID, seedThreadInput } from "./helpers/fansly-dm-sweep.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const ONBOARDED_AT = new Date("2026-04-04T14:00:00.000Z");

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });

async function seedPage(label: string) {
  const model = await createModel(testDb.db, { slug: label, name: label });
  if (!model) throw new Error("Expected model seed");
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label });
  if (!page) throw new Error("Expected page seed");
  // The page's DM onboarding: the first conversation Hub ever listed on it.
  // Unbound, so the message picker never offers it.
  const imported = await upsertPageDmConversation(testDb.db, seedThreadInput(page.id, "imported", 1));
  if (!imported) throw new Error("Expected imported thread seed");
  await testDb.pool.query("update page_dm_threads set first_seen_at = $2 where id = $1", [imported.id, ONBOARDED_AT]);
  return page;
}

/** A thread first listed after onboarding, never read yet. */
async function seedFirstRead(pageId: number, group: string) {
  const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: `fan-${group}` }]);
  if (!fan) throw new Error("Expected fan seed");
  const thread = await upsertPageDmConversation(testDb.db, {
    ...seedThreadInput(pageId, group, 1),
    fanId: fan.id,
    lastMessageId: "m-30",
    messageCoverageStatus: "pending_backfill",
  });
  if (!thread) throw new Error("Expected conversation seed");
  return thread;
}

/** Thirty messages m-1 (oldest) .. m-30 (head), served 25 per page from the
 *  head; `sentAt(n)` dates message n. */
function historyAdapter(group: string, sentAt: (n: number) => Date) {
  const calls: Array<string | null> = [];
  const adapter = {
    async getMessagesPage(
      context: { requestObserver?: { onRequestEvent(event: HttpRequestEvent): Promise<void> } | null },
      params: { groupId: string; before?: string | null; limit?: number },
    ) {
      const before = params.before ?? null;
      calls.push(before);
      await context.requestObserver?.onRequestEvent({
        state: "started", requestId: `history-${calls.length}`, operation: "messages",
        endpointTemplate: "/message", method: "GET", attemptNumber: 1, timestamp: new Date(),
      });
      const top = before === null ? 30 : Number(before.slice(2)) - 1;
      const numbers = Array.from({ length: Math.min(params.limit ?? 25, top) }, (_, i) => top - i);
      const messages = numbers.map((n) => ({
        id: `m-${n}`, senderId: `fan-${group}`, content: `message ${n}`, createdAt: sentAt(n).getTime(),
      }));
      return {
        items: messages, groupId: params.groupId, before, done: numbers.at(-1) === 1,
        raw: { response: { messages } },
      };
    },
  };
  return { adapter, calls };
}

async function runMessagesChunk(page: { id: number; label: string }, adapter: unknown) {
  const app = createTestAppContext(testDb, { syncSharedRateLimitEnabled: true, adapter: adapter as never });
  const run = await startSyncRun(testDb.db, { platformAccountId: page.id, stream: "dm_messages", trigger: "manual" });
  if (!run) throw new Error("Expected message sync run seed");
  return fanslyDmMessagesChunk(app, {
    pageContext: {
      page: { ...page, platformAccountId: PAGE_ACCOUNT_ID }, platform: "fansly",
      session: { authorization: "token" }, proxy: null, egressKey: "direct",
    },
    streamState: { stream: "dm_messages" }, syncRunId: run.id,
    telemetry: { ...fakeTelemetry(), recordDmMessagesChunkSummary: vi.fn(async () => {}) },
    budget: new SyncChunkBudget(5),
  } as never);
}

describe("Fansly first read of a thread that began after DM onboarding", () => {
  it("dates the onboarding from the page's earliest listed conversation, per page", async () => {
    const page = await seedPage("onboarded");
    await seedFirstRead(page.id, "fresh");
    const model = await createModel(testDb.db, { slug: "empty", name: "empty" });
    const emptyPage = model ? await createFanslyPage(testDb.db, { modelId: model.id, label: "empty" }) : null;
    if (!emptyPage) throw new Error("Expected empty page seed");

    expect(await getPageDmOnboardedAt(testDb.db, page.id)).toEqual(ONBOARDED_AT);
    expect(await getPageDmOnboardedAt(testDb.db, emptyPage.id)).toBeNull();
  });

  it("reads a new dialog of more than 25 messages to its first message", async () => {
    const page = await seedPage("new-dialog");
    const thread = await seedFirstRead(page.id, "fresh");
    const { adapter, calls } = historyAdapter("fresh", (n) => new Date(Date.UTC(2026, 8, 20, 12, n)));

    const result = await runMessagesChunk(page, adapter);

    expect(result.satisfied).toBe(true);
    expect(calls).toEqual([null, "m-6"]);
    expect(await getPageDmConversationById(testDb.db, thread.id)).toMatchObject({
      storedMessageCount: 30, newestStoredMessageId: "m-30", oldestStoredMessageId: "m-1",
      messageCoverageStatus: "complete",
    });
    expect(await getCheckpoint(testDb.db, page.id, "dm_messages"))
      .toMatchObject({ state: { currentConversationId: null } });
  });

  it("stops at the start window when the history reaches back before onboarding", async () => {
    const page = await seedPage("old-history");
    const thread = await seedFirstRead(page.id, "resurfaced");
    // m-1..m-10 predate the page's onboarding; the head page ends at m-6.
    const { adapter, calls } = historyAdapter("resurfaced", (n) => n <= 10
      ? new Date(Date.UTC(2026, 2, 1, 12, n))
      : new Date(Date.UTC(2026, 8, 20, 12, n)));

    const result = await runMessagesChunk(page, adapter);

    expect(result.satisfied).toBe(true);
    expect(calls).toEqual([null]);
    expect(await getPageDmConversationById(testDb.db, thread.id)).toMatchObject({
      storedMessageCount: 25, oldestStoredMessageId: "m-6", messageCoverageStatus: "partial_window",
    });
  });
});
