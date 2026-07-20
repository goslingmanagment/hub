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
const PERSONA_A = `v1:${"a".repeat(43)}`;
const PERSONA_B = `v1:${"b".repeat(43)}`;

const completedParams = (mode: "full" | "short", personaDefinitionId = PERSONA_A) => ({
  summaryMode: mode,
  personaDefinitionId,
  outcome: "completed",
  stopReason: "end_turn",
});

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
  params: completedParams("full"),
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
    await insertAiGenerationContent(db, row({ params: completedParams("full") }));
    await insertAiGenerationContent(db, row({ params: completedParams("short"), completion: "short profile" }));
    // unusable: exhausted, failed, empty/whitespace, legacy (no summaryMode),
    // other feature
    await insertAiGenerationContent(db, row({ params: { ...completedParams("short"), stopReason: "max_tokens" } }));
    await insertAiGenerationContent(db, row({ params: { ...completedParams("full"), outcome: "failed", stopReason: null } }));
    await insertAiGenerationContent(db, row({ completion: "", params: { ...completedParams("full"), stopReason: null } }));
    await insertAiGenerationContent(db, row({ completion: " \t\n ", params: completedParams("full") }));
    await insertAiGenerationContent(db, row({ completion: " \t\n ", params: completedParams("short") }));
    await insertAiGenerationContent(db, row({ params: { outcome: "completed", stopReason: null } })); // legacy
    await insertAiGenerationContent(db, row({ feature: "help-me" }));
    // P1-5b: a MODERN row (summaryMode present) with a NULL stopReason is now
    // fail-closed unusable — the CLI/HTTP paths always thread a stopReason, so a
    // NULL means a truncated write that never recorded its terminal reason.
    // Inserted LAST (highest id / newest) so it WOULD win each slot if selectable;
    // the assertions below prove it is skipped for the older valid rows.
    await insertAiGenerationContent(db, row({ params: { ...completedParams("full"), stopReason: null }, completion: "full null stopreason" }));
    await insertAiGenerationContent(db, row({ params: { ...completedParams("short"), stopReason: null }, completion: "short null stopreason" }));

    const out = await getFreshestUsableRecaps(db, {
      pageId: PAGE_ID, conversationRefs: ["group-1", "fan-42"],
      personaDefinitionId: PERSONA_A,
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
      personaDefinitionId: PERSONA_A,
    });
    expect(out.full).not.toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("selects only the requested persona definition and excludes legacy rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    await insertAiGenerationContent(db, row({
      completion: "persona A recap",
      params: completedParams("full", PERSONA_A),
    }));
    await insertAiGenerationContent(db, row({
      completion: "persona B recap",
      params: completedParams("full", PERSONA_B),
    }));
    // Newest but pre-provenance: it must not shadow either persona's slot.
    await insertAiGenerationContent(db, row({
      completion: "legacy recap",
      params: { summaryMode: "full", outcome: "completed", stopReason: "end_turn" },
    }));

    const forA = await getFreshestUsableRecaps(db, {
      pageId: PAGE_ID,
      conversationRefs: ["group-1"],
      personaDefinitionId: PERSONA_A,
    });
    const forB = await getFreshestUsableRecaps(db, {
      pageId: PAGE_ID,
      conversationRefs: ["group-1"],
      personaDefinitionId: PERSONA_B,
    });
    expect(forA.full?.completion).toBe("persona A recap");
    expect(forB.full?.completion).toBe("persona B recap");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("preserves persona-agnostic selection when rollout callers omit the definition", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    await insertAiGenerationContent(db, row({
      completion: "legacy rollout recap",
      params: { summaryMode: "full", outcome: "completed", stopReason: "end_turn" },
    }));
    const out = await getFreshestUsableRecaps(db, {
      pageId: PAGE_ID,
      conversationRefs: ["group-1"],
    });
    expect(out.full?.completion).toBe("legacy rollout recap");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
