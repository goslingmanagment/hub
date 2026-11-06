import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getFreshestUsableRecapBodies,
  getFreshestUsableRecaps,
  RECAP_PERSONA_FREE_SINCE,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Which recap the three readers (Coach attach, recap status, the shared recaps
// read) select for the caller's persona definition. A recap written while the
// Recap prompt still carried the persona stays scoped to its exact definition;
// one written since serves every definition, so an edit of the persona no
// longer hides it (on production a persona edit had hidden most recaps).

const PAGE = 4242;
const CURRENT = "v1:current-definition-000000";
const OLD = "v1:older-definition-00000000";

let testDb: StartedTestDatabase | null = null;

async function recap(ref: string, conversation: string, at: Date, definition: string, mode: "full" | "short" = "full") {
  await testDb!.pool.query(
    `insert into ai_generation_content (generation_ref, feature, model, provider, page_id, conversation_ref,
       prompt_blocks, completion, params, created_at)
     values ($1, 'fan-summary', 'anthropic:test', 'anthropic', $2, $3, '[]'::jsonb, $4, $5::jsonb, $6)`,
    [ref, PAGE, conversation, `recap ${ref}`, JSON.stringify({
      summaryMode: mode, outcome: "completed", stopReason: "end_turn", personaDefinitionId: definition,
    }), at],
  );
}

const select = (conversation: string, personaDefinitionId?: string) => ({
  pageId: PAGE,
  conversationRefs: [conversation],
  ...(personaDefinitionId !== undefined ? { personaDefinitionId } : {}),
});

describe("recap selection across persona definitions", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    // Before the cutoff: the current definition's recap and a newer one of the old definition.
    await recap("pre-current", "conv-pre", new Date("2026-10-10T12:00:00Z"), CURRENT);
    await recap("pre-old", "conv-pre", new Date("2026-10-12T12:00:00Z"), OLD);
    // The same pair, then an old-definition recap written exactly at the cutoff.
    await recap("post-base-current", "conv-post", new Date("2026-10-10T12:00:00Z"), CURRENT);
    await recap("post-base-old", "conv-post", new Date("2026-10-12T12:00:00Z"), OLD);
    await recap("post-old", "conv-post", RECAP_PERSONA_FREE_SINCE, OLD);
    await recap("post-old-short", "conv-post", new Date("2026-10-20T12:00:00Z"), OLD, "short");
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("keeps a recap from before the cutoff scoped to its definition", async (context) => {
    if (!testDb) return context.skip();
    const found = await getFreshestUsableRecaps(testDb.db, select("conv-pre", CURRENT));
    expect(found.full?.generationRef).toBe("pre-current");
    const bodies = await getFreshestUsableRecapBodies(testDb.db, select("conv-pre", CURRENT));
    expect(bodies.full?.generationRef).toBe("pre-current");
    // A caller that names no definition still gets the newest of all.
    expect((await getFreshestUsableRecaps(testDb.db, select("conv-pre"))).full?.generationRef).toBe("pre-old");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("selects a recap from the cutoff on under any definition, newest first", async (context) => {
    if (!testDb) return context.skip();
    const found = await getFreshestUsableRecaps(testDb.db, select("conv-post", CURRENT));
    expect(found.full?.generationRef).toBe("post-old");
    expect(found.short?.generationRef).toBe("post-old-short");
    const bodies = await getFreshestUsableRecapBodies(testDb.db, select("conv-post", CURRENT));
    expect(bodies.full).toMatchObject({ generationRef: "post-old", personaDefinitionId: OLD });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
