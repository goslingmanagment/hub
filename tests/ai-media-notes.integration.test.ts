import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertAiMediaDescriptionCandidate,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// AI media describer — the prompt side (H2) through the real feature route:
// ready descriptions land in the numbered labels, the flag-off prompt is
// byte-identical to a legacy client's, fan-summary never gets notes, and the
// generation path makes no network call.

const FAN = "700700700";
const GROUP = "9001900190019";
const SINCE = "2026-09-01T00:00:00Z";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let api: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let token = "";
let pageId = 0;
let capture: { input?: AiGatewayProviderInput };

const LEGACY_TRANSCRIPT = "[10:00] Fan: [Photo] look at this\n[10:01] Model: nice";
const NUMBERED_TRANSCRIPT = "[10:00] Fan: [Photo #1] look at this\n[10:01] Model: nice";
const sentAt = Date.parse("2026-09-28T10:00:00Z");

function provider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      capture.input = input;
      yield { type: "content_delta", text: "ok" };
      yield {
        type: "usage",
        providerResponseId: "msg",
        cacheHit: false,
        usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, costMicroUsd: 1, costApproximate: false },
      };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await api?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await api?.close();
  await resetIntegrationDatabase(testDb.pool);
  capture = {};
  app = createTestAppContext(testDb, { aiGatewayProvider: provider() });
  app.config.chatMuseAiGatewayEnabled = true;
  const persona = createBundledPersonalities()[0]!;
  await seedBundledAiPersona(app.db, {
    key: persona.id,
    displayName: persona.name,
    systemBlock: persona.content,
    bundledVersion: persona.builtinVersion!,
  });
  const model = await createModel(app.db, { slug: "notes", name: "Notes" });
  const page = await createFanslyPage(app.db, { modelId: model!.id, label: "notes-fs" });
  pageId = page!.id;
  await storeProxyConfig(app.db, pageId, { url: "socks5://proxy.example:1080", encryptedAuth: null, keyVersion: null });
  await createUserAccount(app, { username: "notes-chatter", role: "chatter" }, { source: "cli" });
  await assignPageToUser(app, { userId: await fixtureUserId(app, "notes-chatter"), pageLabel: "notes-fs" }, { source: "cli" });
  token = (await issueChatterDeviceToken(app, { username: "notes-chatter", pageLabel: "notes-fs" }, { source: "cli" })).key;
  api = await buildApiServer(app);
  await api.ready();
});

function enable() {
  Object.assign(app.config, {
    aiMediaDescribeEnabled: true,
    aiMediaDescribePagePolicies: JSON.stringify({ "notes-fs": { since: SINCE } }),
  });
}

async function generate(feature: string, clientContext: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  capture = {};
  const response = await api!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${feature}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: "notes-fs",
      platform: "fansly",
      conversationRef: FAN,
      fanRef: FAN,
      clientContext: { messageCount: 40, fanDisplayName: "Bob", ...clientContext },
      ...extra,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return JSON.stringify(capture.input!.body.prompt);
}

const media = {
  groupRef: GROUP,
  items: [{ n: 1, placement: "inline", messageId: "5001", sentAt, sender: "fan", kind: "photo", mediaId: "8001", paid: false }],
};

async function seedDescribed(description: string) {
  const result = await upsertAiMediaDescriptionCandidate(app.db, {
    pageId,
    platform: "fansly",
    mediaRef: "8001",
    variant: "full",
    mediaKind: "photo",
    senderRole: "fan",
    fanPlatformUserId: FAN,
    status: "pending",
    sourceObservationId: 1,
    link: { messageRef: "5001", conversationRef: GROUP, fanPlatformUserId: FAN, senderRole: "fan", messageAt: new Date(sentAt) },
    observedAt: new Date(),
  });
  if (result.status !== "applied") throw new Error("seed failed");
  await testDb!.pool.query(
    `update ai_media_descriptions set status = 'described', description = $2 where id = $1`,
    [result.descriptionId, description],
  );
}

describe("image notes in feature prompts", () => {
  it("is byte-identical to a legacy client while the flag is off", async () => {
    await seedDescribed("A mirror selfie.");
    const legacy = await generate("fast-reply", { transcript: LEGACY_TRANSCRIPT });
    const numbered = await generate("fast-reply", { transcript: NUMBERED_TRANSCRIPT, media });
    expect(numbered).toBe(legacy);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fills a ready description into the numbered label, with no network on the path", async () => {
    enable();
    await seedDescribed("A mirror selfie in a grey hoodie.");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network on the generation path"));
    try {
      const prompt = await generate("fast-reply", { transcript: NUMBERED_TRANSCRIPT, media });
      expect(prompt).toContain("[Photo #1: A mirror selfie in a grey hoodie.] look at this");
      expect(prompt).toContain("Image notes:");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    const manifest = await testDb!.pool.query(`select params->'contextManifest'->'mediaNotes' as notes from ai_generation_content order by id desc limit 1`);
    expect(manifest.rows[0].notes).toMatchObject({ described: 1, mismatch: false });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("never gives fan-summary (full or short) a description", async () => {
    enable();
    await seedDescribed("A mirror selfie.");
    const legacyFull = await generate("fan-summary", { transcript: LEGACY_TRANSCRIPT });
    const full = await generate("fan-summary", { transcript: NUMBERED_TRANSCRIPT, media });
    expect(full).toBe(legacyFull);
    const short = await generate("fan-summary", { transcript: NUMBERED_TRANSCRIPT, media }, { summaryMode: "short" });
    expect(short).not.toContain("mirror selfie");
    expect(short).not.toContain("[Photo #1");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("asks for a missing description in the background, after the enable boundary only", async () => {
    enable();
    const items = [
      { n: 1, placement: "inline", messageId: "5001", sentAt, sender: "fan", kind: "photo", mediaId: "8001", paid: false },
      { n: 2, placement: "inline", messageId: "4001", sentAt: Date.parse("2026-08-01T00:00:00Z"), sender: "fan", kind: "photo", mediaId: "7001", paid: false },
    ];
    await generate("fast-reply", {
      transcript: "[09:00] Fan: [Photo #1] old\n[10:00] Fan: [Photo #2] new",
      media: { groupRef: GROUP, items: [items[1], items[0]].map((entry, index) => ({ ...entry, n: index + 1 })) },
    });
    await vi.waitFor(async () => {
      const rows = await testDb!.pool.query(`select media_ref, status from ai_media_descriptions order by media_ref`);
      expect(rows.rows).toEqual([{ media_ref: "8001", status: "pending" }]);
    });
    const links = await testDb!.pool.query(`select conversation_ref, fan_platform_user_id from ai_media_description_links`);
    expect(links.rows).toEqual([{ conversation_ref: GROUP, fan_platform_user_id: FAN }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects an unknown field inside clientContext.media", async () => {
    const response = await api!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "notes-fs",
        platform: "fansly",
        conversationRef: FAN,
        clientContext: {
          transcript: NUMBERED_TRANSCRIPT,
          messageCount: 40,
          fanDisplayName: "Bob",
          media: { ...media, items: [{ ...media.items[0], url: "https://cdn3.fansly.com/x" }] },
        },
      },
    });
    expect(response.statusCode).toBe(400);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
