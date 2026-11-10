import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertOfapiWebhookEvent,
  setPageOfapiAccountId,
  upsertOfapiMediaLocators,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  expiresSignedUrl,
  MEDIA_ACCOUNT,
  MEDIA_FAN_ID,
  photoMedia,
  syntheticMessagesReceived,
} from "./helpers/ofapi-media-fixtures.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// OFAPI media locators and links the webhook path writes: a fan's erasure
// removes theirs and only theirs, and a deleted message's links are marked
// through the message index. No real signed URL, id or content appears here.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;

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
  // Physical: a case asserts which index the update plan uses.
  await resetIntegrationDatabase(testDb.pool, { physical: true });
  app = createTestAppContext(testDb);
  const model = await createModel(app.db, { slug: "media", name: "Media" });
  const page = await createOnlyFansPage(app.db, { modelId: model!.id, label: "media-of" });
  pageId = page!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: MEDIA_ACCOUNT });
});

async function receive(envelope: ReturnType<typeof syntheticMessagesReceived>, key: string) {
  const created = await insertOfapiWebhookEvent(app.db, {
    idempotencyKey: `evt_${key.padEnd(40, "0")}`, eventType: "messages.received", ofapiAccountId: MEDIA_ACCOUNT,
    payload: envelope as unknown as Record<string, unknown>,
  });
  await processOfapiWebhookEvent(app, created!.id);
}

describe("media locators — erasure and deleted messages", () => {
  it("erases a fan's locators and links, and only theirs", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    await receive(syntheticMessagesReceived({ media: [photoMedia(3000100, expiresSignedUrl, expiresAt)] }), "e1");
    const { ofapiMediaLocatorsFromItem } = await import("../apps/runtime/src/services/ofapi-media-locators.ts");
    await upsertOfapiMediaLocators(app.db, ofapiMediaLocatorsFromItem(photoMedia(3000101, expiresSignedUrl, expiresAt), {
      ofapiAccountId: MEDIA_ACCOUNT, pageId, source: "webhook", observedAt: new Date(), chatId: "1000777",
      messageId: "2000777", vaultMedia: false,
    }));
    const owner = await testDb!.pool.query<{ id: string }>(
      "insert into users(username, role) values('media-erasure-owner', 'owner') returning id::text");
    app.config.lakeDir = await mkdtemp(path.join(tmpdir(), "ofapi-media-erasure-"));
    const scope = { scopeType: "fan", platform: "onlyfans", fanRef: String(MEDIA_FAN_ID) } as const;
    const plan = await planErasure(app, scope);
    expect(plan.targets.find((target) => target.target === "ofapi_media_locators")).toMatchObject({ plane: "hot", action: "delete", rows: 3 });
    expect(plan.targets.find((target) => target.target === "ofapi_media_links")).toMatchObject({ plane: "hot", action: "delete", rows: 1 });
    await executeErasure(app, scope, { initiatedBy: Number(owner.rows[0]!.id) });
    const left = await testDb!.pool.query<{ media_id: string }>(
      "select distinct media_id from ofapi_media_locators union select distinct media_id from ofapi_media_links order by 1");
    expect(left.rows).toEqual([{ media_id: "3000101" }]);
  });

  it("marks a deleted message's link through the message index", async () => {
    const created = await insertOfapiWebhookEvent(app.db, {
      idempotencyKey: `evt_${"r3".padEnd(40, "0")}`, eventType: "messages.received", ofapiAccountId: MEDIA_ACCOUNT,
      payload: syntheticMessagesReceived({ messageId: 2000301, media: [photoMedia(3000206, expiresSignedUrl, new Date(Date.now() + 3_600_000))] }) as unknown as Record<string, unknown>,
    });
    await processOfapiWebhookEvent(app, created!.id);
    const client = await testDb!.pool.connect();
    try {
      await client.query("begin");
      // A tiny table would be scanned anyway: prove the statement CAN use the index.
      await client.query("set local enable_seqscan = off");
      const plan = await client.query(
        `explain update ofapi_media_links set deleted = true, updated_at = now()
         where ofapi_account_id = $1 and message_id = $2 and not deleted`, [MEDIA_ACCOUNT, "2000301"]);
      expect(plan.rows.map((row: Record<string, unknown>) => String(Object.values(row)[0])).join("\n"))
        .toContain("ofapi_media_links_message_idx");
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
