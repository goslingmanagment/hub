import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  fanDossiers,
  fans,
  pageDmMessages,
  pageDmThreads,
  pageFans,
  workboardV3FanState,
} from "@agency_hub_core/db";
import { dollarsToMills } from "@agency_hub_core/shared";

import type {
  DossierBatchClient,
  DossierDialog,
} from "../apps/runtime/src/services/workboard-v3/dossier-builder.ts";
import {
  processWb3DossierBatch,
  runWb3DossierJobForPage,
} from "../apps/runtime/src/services/workboard-v3/dossier.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

const DAY = 86_400_000;

let harness: StartedTestDatabase;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

afterEach(async () => {
  await resetIntegrationDatabase(harness.pool);
});

async function seedPage() {
  const model = await createModel(harness.db, { slug: "lora", name: "Lora" });
  const page = await createFanslyPage(harness.db, { modelId: model.id, label: "lora-main" });
  return { model, page };
}

let seq = 0;
async function insertSpender(
  pageId: number,
  opts: { withMessages: boolean; coverage?: "partial_window" | "complete" },
  now: Date,
) {
  seq += 1;
  const [fanRow] = await harness.db
    .insert(fans)
    .values({ platform: "fansly", platformUserId: `fan-${seq}`, username: `fan${seq}` })
    .returning({ id: fans.id });
  await harness.db.insert(pageFans).values({
    fanId: fanRow!.id,
    platformAccountId: pageId,
    totalCreatorNetMills: dollarsToMills(40),
  });
  await harness.db.insert(workboardV3FanState).values({
    platformAccountId: pageId,
    fanId: fanRow!.id,
    segment: "spender",
  });
  let threadId: number | null = null;
  if (opts.withMessages) {
    const [threadRow] = await harness.db
      .insert(pageDmThreads)
      .values({
        platformAccountId: pageId,
        fanId: fanRow!.id,
        platformConversationId: `conv-${seq}`,
        storedMessageCount: 2,
        messageCoverageStatus: opts.coverage ?? "partial_window",
        lastFanMessageAt: new Date(now.getTime() - 5 * DAY),
      })
      .returning({ id: pageDmThreads.id });
    threadId = threadRow!.id;
    for (const [i, m] of [
      { role: "fan" as const, text: "love your fitness sets, do you do customs?" },
      { role: "creator" as const, text: "for you — always 😘" },
    ].entries()) {
      seq += 1;
      await harness.db.insert(pageDmMessages).values({
        conversationId: threadId,
        platformAccountId: pageId,
        platformMessageId: `msg-${seq}`,
        senderRole: m.role === "creator" ? "model" : "fan",
        createdAt: new Date(now.getTime() - (10 - i) * DAY),
        content: m.text,
      });
    }
  }
  return { fanId: fanRow!.id, threadId };
}

function fakeBatchClient(store: {
  batches: Map<string, Array<{ customId: string; dialogs: DossierDialog[] }>>;
  ended: boolean;
}): DossierBatchClient {
  let batchSeq = 0;
  return {
    model: "fake-haiku",
    async createBatch(requests) {
      batchSeq += 1;
      const id = `batch-${batchSeq}`;
      store.batches.set(id, requests);
      return id;
    },
    async getBatchResults(batchId) {
      if (!store.ended) {
        return { status: "in_progress" };
      }
      const requests = store.batches.get(batchId) ?? [];
      return {
        status: "ended",
        items: requests.map((request) => ({
          customId: request.customId,
          text: JSON.stringify(
            request.dialogs.map((d) => ({
              id: d.id,
              gist: `фанат ${d.id}: любит фитнес, просил кастомы`,
              interests: ["fitness", "customs"],
              hooks: ["спрашивал про кастом"],
              ending: "warm",
              ending_note: "тёплый финал",
              language: "en",
            })),
          ),
          inputTokens: 500,
          outputTokens: 200,
        })),
      };
    },
  };
}

describe("workboard v3 dossiers (integration)", () => {
  it("writes deterministic transactions_only dossiers for spenders without stored history", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const { fanId } = await insertSpender(page.id, { withMessages: false }, now);

    const result = await runWb3DossierJobForPage(harness.db, null, { platformAccountId: page.id, now });
    expect(result.transactionsOnly).toBe(1);
    expect(result.batchId).toBeNull();

    const rows = await harness.db.select().from(fanDossiers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fanId).toBe(fanId);
    expect(rows[0]!.source).toBe("transactions_only");
    expect(rows[0]!.model).toBeNull();
    expect(rows[0]!.dossier.ending).toBeNull();
  });

  it("builds history dossiers through the batch round-trip with token accounting", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const a = await insertSpender(page.id, { withMessages: true }, now);
    const b = await insertSpender(page.id, { withMessages: true, coverage: "complete" }, now);

    const store = { batches: new Map<string, Array<{ customId: string; dialogs: DossierDialog[] }>>(), ended: false };
    const client = fakeBatchClient(store);

    const run = await runWb3DossierJobForPage(harness.db, client, { platformAccountId: page.id, now });
    expect(run.historyQueued).toBe(2);
    expect(run.batchId).toBe("batch-1");
    // Bulked 3–5 dialogs per request → both fans share one request here.
    expect(store.batches.get("batch-1")!).toHaveLength(1);
    expect(await harness.db.select().from(fanDossiers)).toHaveLength(0);

    // Still processing → poll returns done=false, nothing written.
    const pending = await processWb3DossierBatch(harness.db, client, {
      platformAccountId: page.id,
      batchId: "batch-1",
      now,
    });
    expect(pending.done).toBe(false);

    store.ended = true;
    const drained = await processWb3DossierBatch(harness.db, client, {
      platformAccountId: page.id,
      batchId: "batch-1",
      now,
    });
    expect(drained.done).toBe(true);
    expect(drained.built).toBe(2);

    const rows = await harness.db.select().from(fanDossiers);
    expect(rows).toHaveLength(2);
    const rowA = rows.find((r) => r.fanId === a.fanId)!;
    expect(rowA.source).toBe("history");
    expect(rowA.model).toBe("fake-haiku");
    expect(rowA.dossier.ending).toBe("warm");
    expect(rowA.dossier.interests).toContain("fitness");
    expect(rowA.coverageAtBuild).toBe("partial_window");
    expect(rows.find((r) => r.fanId === b.fanId)!.coverageAtBuild).toBe("complete");

    const usage = await harness.pool.query(
      "select feature, calls, input_tokens, output_tokens from wb_llm_usage_daily",
    );
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0].feature).toBe("wb3-dossier");
    expect(Number(usage.rows[0].input_tokens)).toBe(500);
    expect(Number(usage.rows[0].output_tokens)).toBe(200);
  });

  it("rebuilds dossiers for fans active after the build and upgrades transactions_only fans with new history", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const { fanId } = await insertSpender(page.id, { withMessages: false }, now);

    // First run: transactions_only placeholder.
    await runWb3DossierJobForPage(harness.db, null, { platformAccountId: page.id, now });
    expect((await harness.db.select().from(fanDossiers))[0]!.source).toBe("transactions_only");

    // Deep backfill later delivers a conversation for that fan.
    const [threadRow] = await harness.db
      .insert(pageDmThreads)
      .values({
        platformAccountId: page.id,
        fanId,
        platformConversationId: "conv-late",
        storedMessageCount: 1,
        messageCoverageStatus: "complete",
        lastFanMessageAt: new Date(now.getTime() - DAY),
      })
      .returning({ id: pageDmThreads.id });
    seq += 1;
    await harness.db.insert(pageDmMessages).values({
      conversationId: threadRow!.id,
      platformAccountId: page.id,
      platformMessageId: `msg-${seq}`,
      senderRole: "fan",
      createdAt: new Date(now.getTime() - DAY),
      content: "hey, finally found you again!",
    });

    const store = { batches: new Map<string, Array<{ customId: string; dialogs: DossierDialog[] }>>(), ended: true };
    const client = fakeBatchClient(store);
    const run = await runWb3DossierJobForPage(harness.db, client, { platformAccountId: page.id, now });
    expect(run.historyQueued).toBe(1);

    await processWb3DossierBatch(harness.db, client, {
      platformAccountId: page.id,
      batchId: run.batchId!,
      now,
    });
    const rows = await harness.db.select().from(fanDossiers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("history");
    expect(rows[0]!.coverageAtBuild).toBe("complete");
  });
});
