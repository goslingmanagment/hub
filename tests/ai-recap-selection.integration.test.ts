import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendFanProfile,
  createModel,
  createOnlyFansPage,
  getFreshestUsableRecapBodies,
  getFreshestUsableRecaps,
  getLatestPromptEligibleFanProfile,
  insertAiGenerationContent,
  upsertFans,
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
    await insertAiGenerationContent(db, row({ completion: "\u00a0\u2003", params: completedParams("full") }));
    await insertAiGenerationContent(db, row({ completion: "\u00a0\u2003", params: completedParams("short") }));
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

// chat-extension H-13: a generation whose context held something only its
// caller saw carries `params.contextScope`. It is that person's draft, so no
// reader of a recap selects it: the two slots (status, Coach attach, the shared
// recaps read) and the dossier's generation proof share one predicate.
describe("usable recap selection never takes a row with a contextScope", () => {
  /** Rows are inserted oldest first, a second apart, so "newest" is unambiguous. */
  async function insertAt(secondsAgo: number, over: Parameters<typeof row>[0]) {
    const inserted = row(over);
    await insertAiGenerationContent(testDb!.db, inserted);
    await testDb!.pool.query(
      "update ai_generation_content set created_at = now() - make_interval(secs => $1) where generation_ref = $2",
      [secondsAgo, inserted.generationRef],
    );
    return inserted;
  }

  it("skips it in both slots, with and without a persona, however new it is", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    await insertAt(60, { completion: "shared full", params: completedParams("full") });
    await insertAt(50, { completion: "shared short", params: completedParams("short") });
    await insertAt(40, { completion: "draft full", params: { ...completedParams("full"), contextScope: "principal-draft" } });
    await insertAt(30, { completion: "draft short", params: { ...completedParams("short"), contextScope: "principal-draft" } });
    // Every value excludes the row, not only the one known today.
    await insertAt(20, { completion: "other scope", params: { ...completedParams("full"), contextScope: "some-later-scope" } });
    await insertAt(10, { completion: "empty scope", params: { ...completedParams("full"), contextScope: "" } });
    await insertAt(5, { completion: "object scope", params: { ...completedParams("short"), contextScope: { kind: "x" } } });

    for (const personaDefinitionId of [PERSONA_A, undefined]) {
      const input = { pageId: PAGE_ID, conversationRefs: ["group-1"], ...(personaDefinitionId ? { personaDefinitionId } : {}) };
      const rows = await getFreshestUsableRecaps(db, input);
      expect(rows.full?.completion).toBe("shared full");
      expect(rows.short?.completion).toBe("shared short");
      const bodies = await getFreshestUsableRecapBodies(db, input);
      expect(bodies.full?.completion).toBe("shared full");
      expect(bodies.short?.completion).toBe("shared short");
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves no slot when the only recaps carry a scope, and reads a JSON null as no scope", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    await insertAt(30, { completion: "draft full", params: { ...completedParams("full"), contextScope: "principal-draft" } });
    await insertAt(20, { completion: "draft short", params: { ...completedParams("short"), contextScope: "principal-draft" } });
    const input = { pageId: PAGE_ID, conversationRefs: ["group-1"], personaDefinitionId: PERSONA_A };
    expect(await getFreshestUsableRecaps(db, input)).toEqual({ full: null, short: null });
    expect(await getFreshestUsableRecapBodies(db, input)).toEqual({ full: null, short: null });

    // A writer that spells "no scope" as null wrote a shared recap.
    await insertAt(10, { completion: "null scope", params: { ...completedParams("full"), contextScope: null } });
    expect((await getFreshestUsableRecaps(db, input)).full?.completion).toBe("null scope");
    expect((await getFreshestUsableRecapBodies(db, input)).full?.completion).toBe("null scope");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the shared-recaps reader picks the same rows and carries no prompt block, user or manifest", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    const full = await insertAt(40, {
      completion: "full text",
      userId: null,
      promptBlocks: [{ role: "system", text: "PROMPT_BLOCK_SECRET" }],
      params: {
        ...completedParams("full"),
        transcriptCoverage: "full-history",
        requestedCount: 1500,
        keptCount: 1234,
        contextManifest: { source: "archive", note: "MANIFEST_SECRET" },
      },
    });
    // The newest usable short has a legacy shape: no persona, no coverage.
    const short = await insertAt(30, {
      completion: "short text",
      params: { summaryMode: "short", outcome: "completed", stopReason: "end_turn" },
    });
    // Unusable and newer: skipped by both readers alike.
    await insertAt(20, { completion: "exhausted", params: { ...completedParams("full"), stopReason: "length" } });
    await insertAt(10, { completion: " \t ", params: completedParams("short") });

    const input = { pageId: PAGE_ID, conversationRefs: ["group-1"] };
    const rows = await getFreshestUsableRecaps(db, input);
    const bodies = await getFreshestUsableRecapBodies(db, input);
    expect(rows.full?.generationRef).toBe(full.generationRef);
    expect(rows.short?.generationRef).toBe(short.generationRef);
    expect(bodies).toEqual({
      full: {
        generationRef: full.generationRef,
        createdAt: rows.full!.createdAt,
        completion: "full text",
        personaDefinitionId: PERSONA_A,
        transcriptCoverage: "full-history",
        requestedCount: 1500,
        keptCount: 1234,
      },
      short: {
        generationRef: short.generationRef,
        createdAt: rows.short!.createdAt,
        completion: "short text",
        personaDefinitionId: null,
        transcriptCoverage: null,
        requestedCount: null,
        keptCount: null,
      },
    });
    expect(JSON.stringify(bodies)).not.toMatch(/SECRET/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not prove a dossier: a profile whose only matching generation carries a scope is not prompt-eligible", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    const model = await createModel(db, { slug: "recap-scope", name: "Recap Scope" });
    const page = await createOnlyFansPage(db, { modelId: model!.id, label: "recap-scope-of" });
    const [fan] = await upsertFans(db, [{ platform: "onlyfans", platformUserId: "777000111" }]);
    const base = { fanId: fan!.id, platformAccountId: page!.id, source: "chatmuse" };
    const eligible = () => getLatestPromptEligibleFanProfile(db, {
      fanId: fan!.id,
      platformAccountId: page!.id,
      platformUserId: fan!.platformUserId,
    });
    const proof = (completion: string, params: Record<string, unknown>) => insertAiGenerationContent(db, row({
      pageId: page!.id,
      conversationRef: fan!.platformUserId,
      completion,
      params,
    }));

    await appendFanProfile(db, { ...base, body: "shared dossier" });
    await proof("shared dossier", completedParams("full"));
    await appendFanProfile(db, { ...base, body: "draft dossier" });
    await proof("draft dossier", { ...completedParams("full"), contextScope: "principal-draft" });

    // The newer profile is proven only by a scoped generation: the older,
    // properly proven one stays the prompt's dossier.
    expect(await eligible()).toMatchObject({ version: 1, body: "shared dossier" });

    // The same text from an unscoped generation is a proof.
    await proof("draft dossier", completedParams("full"));
    expect(await eligible()).toMatchObject({ version: 2, body: "draft dossier" });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
