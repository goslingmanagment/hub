import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getFreshestUsableRecaps,
  insertAiGenerationContent,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Task 6 (spec §5): the two-slot recap selection reader. pageId has no FK, so
// rows insert freely without seeding a page; usability is decided purely by the
// params/completion columns the fan-summary gateway writes.

const PAGE_ID = 1;

let testDb: StartedTestDatabase | null = null;

const row = (
  over: Partial<Parameters<typeof insertAiGenerationContent>[1]> = {},
): Parameters<typeof insertAiGenerationContent>[1] => ({
  usageEventId: null,
  generationRef: randomUUID(),
  feature: "fan-summary",
  model: "m",
  provider: "anthropic",
  userId: null,
  pageId: PAGE_ID,
  conversationRef: "group-1",
  fanRef: null,
  promptBlocks: [],
  completion: "profile text",
  params: { summaryMode: "full", outcome: "completed", stopReason: "end_turn" },
  ...over,
});

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
});

describe("getFreshestUsableRecaps", () => {
  it("returns the newest usable per slot and skips unusable rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    await insertAiGenerationContent(db, row({ params: { summaryMode: "full", outcome: "completed", stopReason: "end_turn" } }));
    await insertAiGenerationContent(db, row({ params: { summaryMode: "short", outcome: "completed", stopReason: "end_turn" }, completion: "short profile" }));
    // unusable: exhausted, failed, empty, legacy (no summaryMode), other feature
    await insertAiGenerationContent(db, row({ params: { summaryMode: "short", outcome: "completed", stopReason: "max_tokens" } }));
    await insertAiGenerationContent(db, row({ params: { summaryMode: "full", outcome: "failed", stopReason: null } }));
    await insertAiGenerationContent(db, row({ completion: "", params: { summaryMode: "full", outcome: "completed", stopReason: null } }));
    await insertAiGenerationContent(db, row({ params: { outcome: "completed", stopReason: null } })); // legacy
    await insertAiGenerationContent(db, row({ feature: "help-me" }));

    const out = await getFreshestUsableRecaps(db, {
      pageId: PAGE_ID, conversationRefs: ["group-1", "fan-42"],
    });
    expect(out.full?.completion).toBe("profile text");
    expect(out.short?.completion).toBe("short profile");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("searches legacy refs too", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    await insertAiGenerationContent(db, row({ conversationRef: "fan-42" }));
    const out = await getFreshestUsableRecaps(db, {
      pageId: PAGE_ID, conversationRefs: ["group-1", "fan-42"],
    });
    expect(out.full).not.toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
