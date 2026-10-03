import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createModel, createOnlyFansPage, getFreshestUsableRecaps } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import {
  DEV_SEED_CHATTER_USERNAME,
  DEV_SEED_FANS,
  DEV_SEED_PAGES,
  DevSeedRefusedError,
  seedDevClientHub,
} from "../scripts/dev-seed-client.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// scripts/dev-seed-client.ts writes straight into the tables the OFAPI
// pipeline fills. This file keeps it honest as those tables move: a re-run
// converges, a foreign database is refused, and the rows read back through the
// routes a client smoke test uses (sign-in, Spenders, the AI context).

const SEEDED_TABLES = [
  "users", "pages", "models", "ai_personas", "access_grants", "user_page_assignments",
  "audit_events", "observations", "egress_endpoints", "fans", "page_fans",
  "page_subscriptions", "transactions", "fan_spend_daily", "fan_spend_lifetime",
  "revenue_daily", "message_archive", "page_dm_threads", "page_dm_messages",
  "ai_generation_content", "device_tokens",
] as const;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await server?.close();
  server = null;
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
});

async function tableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SEEDED_TABLES) {
    const result = await testDb!.pool.query<{ count: string }>(`select count(*)::text as count from ${table}`);
    counts[table] = Number(result.rows[0]!.count);
  }
  return counts;
}

describe("dev client seed", () => {
  it("seeds a keyless hub and converges on a re-run", async () => {
    const first = await seedDevClientHub(app, { now: new Date("2026-10-03T12:00:00Z") });
    const afterFirst = await tableCounts();
    const second = await seedDevClientHub(app, { now: new Date("2026-10-04T12:00:00Z") });

    expect(await tableCounts()).toEqual(afterFirst);
    expect(afterFirst).toMatchObject({
      users: 2, pages: 2, fans: 7, page_fans: 8, page_subscriptions: 8, transactions: 21,
      message_archive: 66, page_dm_threads: 7, page_dm_messages: 66, ai_generation_content: 2,
      egress_endpoints: 2, device_tokens: 0,
    });
    expect(first.users.map((user) => user.password)).toEqual(["dev-owner-password", "dev-chatter-password"]);
    expect(second.users.map((user) => user.password)).toEqual([null, null]);

    const pages = await testDb!.pool.query<{
      label: string; external_page_id: string; ofapi_account_id: string | null; platform: string;
    }>("select label, external_page_id, ofapi_account_id, platform::text from pages order by label");
    expect(pages.rows).toEqual([
      { label: "dev-lora-of", external_page_id: "990000001", ofapi_account_id: null, platform: "onlyfans" },
      { label: "dev-lora-vip-of", external_page_id: "990000002", ofapi_account_id: null, platform: "onlyfans" },
    ]);

    // Times re-anchor to the run: the head is still "2 hours ago".
    const mainId = first.pages.find((page) => page.label === DEV_SEED_PAGES.main.label)!.id;
    const thread = await testDb!.pool.query<{ unread_count: number; last_message_at: Date; stored_message_count: number }>(
      "select unread_count, last_message_at, stored_message_count from page_dm_threads where platform_account_id = $1 and platform_conversation_id = $2",
      [mainId, DEV_SEED_FANS.mark.id],
    );
    expect(thread.rows[0]).toMatchObject({ unread_count: 2, stored_message_count: 33 });
    expect(thread.rows[0]!.last_message_at.toISOString()).toBe("2026-10-04T10:00:00.000Z");

    const spend = await testDb!.pool.query<{ gross: string }>(
      `select l.gross_amount_mills::text as gross from fan_spend_lifetime l join fans f on f.id = l.fan_id
        where l.platform_account_id = $1 and f.platform_user_id = $2`,
      [mainId, DEV_SEED_FANS.mark.id],
    );
    expect(spend.rows[0]?.gross).toBe("610000");

    const recaps = await getFreshestUsableRecaps(app.db, {
      pageId: mainId,
      conversationRefs: [DEV_SEED_FANS.mark.id],
      personaDefinitionId: second.recap.personaDefinitionId,
    });
    expect(recaps.full?.completion).toMatch(/^\[dev seed\] Mark/);
    expect(recaps.short?.completion).toMatch(/^\[dev seed\]/);
  }, INTEGRATION_TEST_TIMEOUT_MS * 2);

  it("refuses a database holding pages it did not create, and writes nothing", async () => {
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-of" });

    await expect(seedDevClientHub(app)).rejects.toBeInstanceOf(DevSeedRefusedError);
    expect(await tableCounts()).toMatchObject({ users: 0, pages: 1, fans: 0, transactions: 0, message_archive: 0 });

    await seedDevClientHub(app, { allowExistingPages: true });
    expect((await tableCounts()).pages).toBe(3);
  }, INTEGRATION_TEST_TIMEOUT_MS * 2);

  it("serves the seeded chatter's sign-in, Spenders and AI context", async () => {
    await seedDevClientHub(app);
    const capture: { input?: AiGatewayProviderInput } = {};
    const provider: AiGatewayProvider = {
      provider: "anthropic",
      async *stream(input) {
        capture.input = input;
        yield { type: "content_delta", text: "hey you 😘" };
        yield {
          type: "usage",
          providerResponseId: "msg_dev_seed",
          cacheHit: false,
          usage: { inputTokens: 50, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, costMicroUsd: 100, costApproximate: false },
        };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    app.aiGatewayProvider = provider;
    app.config.chatMuseAiGatewayEnabled = true;
    server = await buildApiServer(app);
    await server.ready();

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      payload: { username: DEV_SEED_CHATTER_USERNAME, password: "dev-chatter-password", label: "dev seed test", mode: "active" },
    });
    expect(login.statusCode).toBe(200);
    const authorization = `Bearer ${login.json().token as string}`;

    const spenders = await server.inject({
      method: "GET",
      url: `/api/v2/spenders?scope=page&pageLabel=${DEV_SEED_PAGES.main.label}&period=lifetime&limit=10`,
      headers: { authorization },
    });
    expect(spenders.statusCode).toBe(200);
    const items = spenders.json().items as Array<{ fan: { platformUserId: string }; metrics: { lifetime: { scopeGrossAmountMills: number } } }>;
    expect(items.map((item) => item.fan.platformUserId)).toEqual(
      [DEV_SEED_FANS.mark.id, DEV_SEED_FANS.jake.id, DEV_SEED_FANS.sam.id, DEV_SEED_FANS.chris.id],
    );
    expect(items[0]!.metrics.lifetime.scopeGrossAmountMills).toBe(610_000);

    const reply = await server.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: DEV_SEED_PAGES.main.label,
        platform: "onlyfans",
        conversationRef: DEV_SEED_FANS.mark.id,
      },
    });
    expect(reply.statusCode).toBe(200);
    const frames = reply.body.split("\n").filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string });
    expect(frames.at(-1), reply.body).toMatchObject({ type: "done" });
    const prompt = JSON.stringify(capture.input?.body.prompt);
    expect(prompt).toContain("thinking about you. what are you up to tonight?");
    expect(prompt).toContain("Total gross (all-time): $610.00");
  }, INTEGRATION_TEST_TIMEOUT_MS * 2);
});
