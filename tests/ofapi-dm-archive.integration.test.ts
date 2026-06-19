import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  findDmMessageArchiveByPlatformMessageId,
  getOfapiWebhookEventById,
  setPageOfapiAccountId,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  archiveOfapiDmEvent,
  cleanupExpiredDmMessageArchive,
} from "../apps/runtime/src/services/ofapi-dm-archive.ts";
import { sweepOfapiDmProjections } from "../apps/runtime/src/services/ofapi-dm-projection.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");
const WEBHOOK_URL = "/api/v1/ofapi/webhook";
const SIGNING_SECRET = "test-signing-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 7);
const RECEIVED_ACCOUNT = "acct_01000000000000000000000000000000";
const SENT_ACCOUNT = "acct_02000000000000000000000000000000";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let idempotencyCounter = 0;

function nextIdempotencyKey() {
  idempotencyCounter += 1;
  return `archive_evt_${String(idempotencyCounter).padStart(32, "0")}`;
}

async function loadFixtureEnvelope(name: string) {
  const raw = JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  return raw as { event: string; account_id?: string | null; payload: Record<string, unknown> };
}

async function seedWebhookConfig() {
  await upsertOfapiWebhookConfig(appContext.db, {
    externalWebhookId: "wh_archive_test",
    endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook",
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    encryptedSigningSecret: JSON.stringify(encryptJson(SIGNING_SECRET, ENCRYPTION_KEY, 1)),
  });
}

async function seedOnlyFansPage(label: string, ofapiAccountId: string) {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label,
  });
  await setPageOfapiAccountId(appContext.db, {
    pageId: page.id,
    ofapiAccountId,
  });
  return page;
}

async function deliverAndProcess(envelope: Record<string, unknown>) {
  if (!server) {
    throw new Error("server not started");
  }

  const body = JSON.stringify(envelope);
  const response = await server.inject({
    method: "POST",
    url: WEBHOOK_URL,
    payload: body,
    headers: {
      "content-type": "application/json",
      signature: createHmac("sha256", SIGNING_SECRET).update(body).digest("hex"),
      "x-ofapi-idempotency-key": nextIdempotencyKey(),
    },
  });
  expect(response.statusCode).toBe(200);

  const { rows } = await testDb!.pool.query<{ id: number }>(
    "select max(id)::int as id from ofapi_webhook_events",
  );
  const eventId = rows[0]!.id;
  await processOfapiWebhookEvent(appContext, eventId);
  return eventId;
}

async function archiveRow(accountId: string, messageId: string) {
  return findDmMessageArchiveByPlatformMessageId(appContext.db, {
    platform: "onlyfans",
    ofapiAccountId: accountId,
    platformMessageId: messageId,
  });
}

async function archiveCount() {
  const { rows } = await testDb!.pool.query<{ count: string }>(
    "select count(*)::int as count from dm_message_archive",
  );
  return Number(rows[0]!.count);
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
});

afterAll(async () => {
  await server?.close();
  server = null;
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }

  idempotencyCounter = 0;
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    ofapiDmProjectionEnabled: true,
    ofapiDmColdArchiveEnabled: true,
    ofapiDmColdArchiveRetentionDays: 30,
  });
  if (server) {
    await server.close();
  }
  server = await buildApiServer(appContext);
  await server.ready();
  await seedWebhookConfig();
});

describe("OFAPI DM cold archive", () => {
  it("archives future message-shaped webhooks once with sanitized media metadata", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedOnlyFansPage("archive-sent", SENT_ACCOUNT);
    const eventId = await deliverAndProcess(await loadFixtureEnvelope("messages_sent.json"));
    const row = await archiveRow(SENT_ACCOUNT, "1000027");

    expect(row).not.toBeNull();
    expect(row!.sourceJournalId).toBe(eventId);
    expect(row!.sourceEventType).toBe("messages.sent");
    expect(row!.senderRole).toBe("model");
    expect(row!.isSentByMe).toBe(true);
    expect(row!.platformConversationId).toBe("1000003");
    expect(row!.fanPlatformUserId).toBe("1000003");
    expect(row!.priceMills).toBe(25000n);
    expect(row!.tipAmountMills).toBe(0n);
    expect(row!.textPlain).toBe("Sample fan message text used in anonymized fixtures.");
    expect(row!.retainUntil.getTime()).toBeGreaterThan(row!.sourceReceivedAt.getTime());
    expect(row!.retainUntil.getTime() - row!.sourceReceivedAt.getTime())
      .toBe(30 * 24 * 60 * 60 * 1000);

    expect(row!.mediaMetadata).toHaveLength(2);
    expect(row!.mediaMetadata[0]).toMatchObject({
      id: "1000015",
      type: "video",
      isReady: true,
      locked: false,
      width: 1080,
      height: 1920,
      durationSeconds: 52,
    });
    const serializedMedia = JSON.stringify(row!.mediaMetadata);
    expect(serializedMedia).not.toContain("http");
    expect(serializedMedia).not.toContain("cdn2");
    expect(serializedMedia).not.toContain("Signature");
    expect(serializedMedia).not.toContain("url");

    const journalRow = await getOfapiWebhookEventById(appContext.db, eventId);
    await archiveOfapiDmEvent(appContext, journalRow!);
    expect(await archiveCount()).toBe(1);
  });

  it("does not archive when the cold archive flag is off", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    appContext.config.ofapiDmColdArchiveEnabled = false;
    await seedOnlyFansPage("archive-off", RECEIVED_ACCOUNT);
    await deliverAndProcess(await loadFixtureEnvelope("messages_received.json"));

    expect(await archiveRow(RECEIVED_ACCOUNT, "1000006")).toBeNull();
  });

  it("keeps the archive forward-only when the flag is enabled after a retained journal row", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    appContext.config.ofapiDmProjectionEnabled = false;
    appContext.config.ofapiDmColdArchiveEnabled = false;
    await seedOnlyFansPage("archive-forward-only", RECEIVED_ACCOUNT);
    const eventId = await deliverAndProcess(await loadFixtureEnvelope("messages_received.json"));

    expect((await getOfapiWebhookEventById(appContext.db, eventId))!.projectionStatus).toBe("pending");
    expect(await archiveCount()).toBe(0);

    appContext.config.ofapiDmProjectionEnabled = true;
    appContext.config.ofapiDmColdArchiveEnabled = true;
    expect(await sweepOfapiDmProjections(appContext)).toBe(1);

    expect((await getOfapiWebhookEventById(appContext.db, eventId))!.projectionStatus)
      .toBe("projected");
    expect(await archiveRow(RECEIVED_ACCOUNT, "1000006")).toBeNull();
  });

  it("records delete events as tombstones and preserves them when the message arrives later", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedOnlyFansPage("archive-delete", RECEIVED_ACCOUNT);
    const deleted = await loadFixtureEnvelope("messages_deleted.json");
    await deliverAndProcess(deleted);

    const tombstone = await archiveRow(RECEIVED_ACCOUNT, "1000001");
    expect(tombstone).not.toBeNull();
    expect(tombstone!.deletedAt).not.toBeNull();
    expect(tombstone!.platformConversationId).toBeNull();
    expect(tombstone!.sourceEventType).toBe("messages.deleted");

    const received = await loadFixtureEnvelope("messages_received.json");
    received.payload.id = "1000001";
    await deliverAndProcess(received);

    const hydratedTombstone = await archiveRow(RECEIVED_ACCOUNT, "1000001");
    expect(hydratedTombstone).not.toBeNull();
    expect(hydratedTombstone!.deletedAt?.toISOString())
      .toBe(tombstone!.deletedAt?.toISOString());
    expect(hydratedTombstone!.platformConversationId).toBe("1000005");
    expect(hydratedTombstone!.textPlain)
      .toBe("Sample fan message text used in anonymized fixtures.");
  });

  it("purges expired archive rows and exposes owner-only status metrics", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedOnlyFansPage("archive-status", RECEIVED_ACCOUNT);
    await deliverAndProcess(await loadFixtureEnvelope("messages_received.json"));

    await createUserAccount(appContext, {
      username: "owner",
      role: "owner",
      password: "owner-secret",
    }, { source: "cli" });
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: "owner-secret" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const status = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/dm-archive/status",
      headers: { cookie },
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      enabled: true,
      retentionDays: 30,
      rowCount: 1,
      tombstoneCount: 0,
      acl: "owner_admin_endpoint_only",
      audit: "source_journal_metadata_on_each_row",
      purgePolicy: "daily_retention_purge_by_retain_until",
      exportPolicy: "no_raw_transcript_export_endpoint_yet",
      mediaPolicy: "stable_metadata_only_no_signed_urls",
    });

    const row = await archiveRow(RECEIVED_ACCOUNT, "1000006");
    expect(row).not.toBeNull();
    expect(await cleanupExpiredDmMessageArchive(
      appContext,
      new Date(row!.retainUntil.getTime() + 1000),
    )).toBe(1);
    expect(await archiveCount()).toBe(0);
  });
});
