import { createRequire } from "node:module";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  listAiMediaDescriptionsByRefs,
  storeProxyConfig,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { renderFanslyMediaNotes, QUICK_FEATURE_MEDIA_NOTE_LIMITS } from "../apps/runtime/src/modules/ai/index.ts";
import { fanslyAiMediaSource } from "../apps/runtime/src/services/ai-media-describe/fansly-source.ts";
import type { MediaDescribeClient } from "../apps/runtime/src/services/ai-media-describe/describer.ts";
import { runAiMediaDescribeSweep } from "../apps/runtime/src/services/ai-media-describe/worker.ts";
import { runAiMediaCandidatesProjection } from "../apps/runtime/src/services/projections/ai-media-candidates.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// AI media describer — the Fansly source (H3): captured DM page → canonical
// attachment event → candidate (projector) → URL from the journal → fake
// download and provider → description → the prompt label.

const sharp = createRequire(path.resolve("apps/runtime/package.json"))("sharp") as (
  input: { create: Record<string, unknown> },
) => { jpeg(): { toBuffer(): Promise<Buffer> } };

const OWN = "737077689877278720";
const FAN = "700700700";
const GROUP = "9001900190019";
// Relative to the real clock: the sweep and the accelerator gate on "now".
const SINCE = new Date(Date.now() - 24 * 3600_000).toISOString();
const AFTER = new Date(Date.now() - 3600_000).toISOString();
const BEFORE = new Date(Date.now() - 48 * 3600_000).toISOString();

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let seq = 0;

function policyUrl(host: string, epochSeconds: number, tag: string) {
  const policy = Buffer.from(JSON.stringify({
    Statement: [{ Resource: `https://${host}/*`, Condition: { DateLessThan: { "AWS:EpochTime": epochSeconds } } }],
  })).toString("base64").replace(/\+/g, "-").replace(/=/g, "_").replace(/\//g, "~");
  return `https://${host}/${tag}.jpeg?ngsw-bypass=true&Policy=${policy}&Key-Pair-Id=K1&Signature=sig`;
}

function photoMedia(id: string, expiresAt: number, price = 0) {
  return {
    id,
    accountId: FAN,
    mediaId: `file-${id}`,
    previewId: null,
    permissions: { permissionFlags: [{ price }] },
    media: {
      id: `file-${id}`,
      type: 1,
      mimetype: "image/jpeg",
      width: 4032,
      height: 2268,
      locations: [{ locationId: "1", location: policyUrl("cdn3.fansly.com", expiresAt, `${id}-orig`) }],
      variants: [
        { type: 1, mimetype: "image/jpeg", width: 1920, height: 1080, locations: [{ locationId: "1", location: policyUrl("cdn3.fansly.com", expiresAt, `${id}-1080`) }] },
        { type: 1, mimetype: "image/jpeg", width: 1280, height: 720, locations: [{ locationId: "1", location: policyUrl("cdn3.fansly.com", expiresAt, `${id}-720`) }] },
        { type: 1, mimetype: "image/jpeg", width: 854, height: 480, locations: [{ locationId: "1", location: policyUrl("cdn3.fansly.com", expiresAt, `${id}-480`) }] },
      ],
    },
  };
}

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
  seq = 0;
  app = createTestAppContext(testDb);
  Object.assign(app.config, {
    aiMediaDescribeEnabled: true,
    aiMediaDescribePagePolicies: JSON.stringify({ "fs-vision": { since: SINCE } }),
    aiMediaDescribeLiveChatOnly: true,
    aiMediaDescribeModelMedia: "teasers",
    aiMediaDescribeDailyImageLimit: 150,
    aiMediaDescribeDailyMicroUsdLimit: 1_000_000,
  });
  const model = await createModel(app.db, { slug: "fsv", name: "Fsv" });
  const page = await createFanslyPage(app.db, { modelId: model!.id, label: "fs-vision" });
  pageId = page!.id;
  await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, OWN]);
  await storeProxyConfig(app.db, pageId, { url: "socks5://proxy.example.internal:1080", encryptedAuth: null, keyVersion: null });
});

async function seedObservation(payload: Record<string, unknown>): Promise<number> {
  const key = `vision-${Math.random()}`;
  const { rows } = await testDb!.pool.query(
    `insert into observations (source, producer, platform, account_id, kind, payload, payload_hash, idempotency_key, observed_at, received_at, parse_version)
     values ('pull', 'sync:fansly:dm_messages', 'fansly', $1, 'dm_messages', $2::jsonb, sha256($3::bytea), $3, now(), now(), 1)
     returning id::text as id`,
    [pageId, JSON.stringify(payload), key],
  );
  await testDb!.pool.query(
    `insert into observation_keys (source, idempotency_key, observation_id, received_at) values ('pull', $1, $2, now())`,
    [key, Number(rows[0].id)],
  );
  return Number(rows[0].id);
}

async function seedEvent(type: string, observationId: number, data: Record<string, unknown>, refs: { conversationRef?: string; messageRef?: string } = {}) {
  seq += 1;
  const dedup = `vision:${seq}:${Math.random()}`;
  const { rows } = await testDb!.pool.query(
    `insert into domain_events (account_id, account_seq, type, occurred_at, conversation_ref, message_ref, data, schema_version, observation_id, dedup_key)
     values ($1, $2, $3, now(), $4, $5, $6::jsonb, 1, $7, $8) returning id::text as id`,
    [pageId, seq, type, refs.conversationRef ?? null, refs.messageRef ?? null, JSON.stringify(data), observationId, dedup],
  );
  await testDb!.pool.query(
    `insert into domain_event_keys (account_id, dedup_key, event_id, occurred_at) values ($1, $2, $3, now())`,
    [pageId, dedup, Number(rows[0].id)],
  );
}

function attachmentsEvent(messageId: string, attachments: Array<Record<string, unknown>>, sender = FAN, createdAt = AFTER) {
  return {
    messageId,
    conversationRef: GROUP,
    senderRef: sender,
    messageCreatedAt: createdAt,
    attachments,
    buyerRefs: [],
    contentHash: "a".repeat(64),
  };
}

async function markLive() {
  await testDb!.pool.query(
    `insert into ai_usage_events (user_id, client_event_id, feature, model, page_id, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, conversation_id, completed_at, is_cache_hit, is_regeneration)
     values ($1, 'live-1', 'fast-reply', 'm', $2, 1, 1, 0, 0, $3, now(), false, false)`,
    [null, pageId, FAN],
  );
  // A chatter row (user_id not null) is what makes a chat live.
  await testDb!.pool.query(`insert into users (username, role) values ('live-chatter', 'chatter')`);
  await testDb!.pool.query(
    `update ai_usage_events set user_id = (select id from users where username = 'live-chatter') where client_event_id = 'live-1'`,
  );
}

describe("Fansly candidates projector", () => {
  it("fast-forwards pages without a policy and never reads their history", async () => {
    app.config.aiMediaDescribePagePolicies = "{}";
    const observationId = await seedObservation({ accountMedia: [] });
    await seedEvent("message.attachments_observed", observationId, attachmentsEvent("5001", [{ contentType: 1, contentRef: "8001", mediaOfferRef: "8001", mimeType: "image/jpeg" }]));
    const result = await runAiMediaCandidatesProjection(app, { accountId: pageId });
    expect(result).toMatchObject({ candidates: 0, fastForwarded: 1 });
    const rows = await testDb!.pool.query(`select count(*)::int as n from ai_media_descriptions`);
    expect(rows.rows[0].n).toBe(0);
  });

  it("writes fan media after the boundary: pending in a live chat, dormant otherwise; never creator media", async () => {
    const observationId = await seedObservation({ accountMedia: [] });
    await seedEvent("message.attachments_observed", observationId, attachmentsEvent("5001", [{ contentType: 1, contentRef: "8001", mediaOfferRef: "8001", mimeType: "image/jpeg" }]));
    await seedEvent("message.attachments_observed", observationId, attachmentsEvent("4001", [{ contentType: 1, contentRef: "7001", mediaOfferRef: "7001", mimeType: "image/jpeg" }], FAN, BEFORE));
    await seedEvent("message.attachments_observed", observationId, attachmentsEvent("6001", [{ contentType: 1, contentRef: "9001", mediaOfferRef: "9001", mimeType: "image/jpeg", priceMills: "10000" }], OWN));
    await seedEvent("message.attachments_observed", observationId, attachmentsEvent("5002", [{ contentType: 2, contentRef: "B1", bundleRef: "B1" }]));
    await runAiMediaCandidatesProjection(app, { accountId: pageId });
    const rows = await testDb!.pool.query(`select media_ref, media_kind, status, source_observation_id from ai_media_descriptions order by media_ref`);
    expect(rows.rows.map((row) => [row.media_ref, row.media_kind, row.status])).toEqual([
      ["8001", "photo", "dormant"],
      ["B1", "bundle", "dormant"],
    ]);

    // A generation in the conversation makes the chat live: the next media is due at once.
    await markLive();
    await seedEvent("message.attachments_observed", observationId, attachmentsEvent("5003", [{ contentType: 1, contentRef: "8002", mediaOfferRef: "8002", mimeType: "video/mp4" }]));
    await runAiMediaCandidatesProjection(app, { accountId: pageId });
    const live = await testDb!.pool.query(`select variant, status from ai_media_descriptions where media_ref = '8002'`);
    expect(live.rows[0]).toEqual({ variant: "poster", status: "pending" });
  });

  // Step 4 (S4-14): the in-chunk accelerator and its request filers are gone
  // (and its keys since S4-26), so a socket signal of fan media queues no
  // accelerator read.
  it("files no accelerator read for a fan media WS signal", async () => {
    const observationId = await seedObservation({ frame: "x" });
    await seedEvent("fansly.ws_signal_observed", observationId, {
      path: [],
      outcome: "hint",
      hint: { type: "message_created", groupRef: GROUP, messageRef: "5102", hasAttachments: true, senderRef: FAN },
      generation: null,
      receivedAt: new Date().toISOString(),
    });
    const result = await runAiMediaCandidatesProjection(app, { accountId: pageId });
    expect(result).toMatchObject({ eventsSeen: 1, candidates: 0 });
    expect(result).not.toHaveProperty("accelerations");
    expect((await testDb!.pool.query(`select count(*)::int as n from ai_media_accelerator_reads`)).rows[0].n).toBe(0);
  });
});

describe("event → candidate → description → prompt", () => {
  it("describes a live chat's fan photo from the captured page and fills its label", async () => {
    await markLive();
    const expires = Math.floor(Date.now() / 1000) + 6 * 24 * 3600;
    const observationId = await seedObservation({ messages: [], accountMedia: [photoMedia("8001", expires)] });
    await seedEvent("message.attachments_observed", observationId, attachmentsEvent("5001", [{ contentType: 1, contentRef: "8001", mediaOfferRef: "8001", mimeType: "image/jpeg" }]), { conversationRef: GROUP, messageRef: "5001" });
    await runAiMediaCandidatesProjection(app, { accountId: pageId });

    const image = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#446688" } }).jpeg().toBuffer();
    const downloads: string[] = [];
    const client: MediaDescribeClient = {
      async create() {
        return { id: "msg", stop_reason: "end_turn", content: [{ type: "text", text: "A blue wall in soft light." }], usage: { input_tokens: 900, output_tokens: 10 } };
      },
    };
    const result = await runAiMediaDescribeSweep(app, {
      sources: new Map([["fansly", fanslyAiMediaSource]]),
      clientFactory: () => client,
      download: async ({ url }) => {
        downloads.push(url);
        return { ok: true, bytes: image, contentType: "image/jpeg" };
      },
    });
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toContain("8001-720");

    const descriptions = await listAiMediaDescriptionsByRefs(app.db, { pageId, platform: "fansly", mediaRefs: ["8001"] });
    const rendered = renderFanslyMediaNotes({
      transcript: "[11:00] Fan: [Photo #1] hey",
      items: [{ n: 1, placement: "inline", messageId: "5001", sentAt: Date.parse(AFTER), sender: "fan", kind: "photo", mediaId: "8001", paid: false }],
      active: true,
      descriptions,
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
    });
    expect(rendered.transcript).toContain("[Photo #1: A blue wall in soft light.] hey");
  });

  it("skips a PPV body and a creator's free media while the mode is teasers", async () => {
    const observationId = await seedObservation({ accountMedia: [photoMedia("9001", Math.floor(Date.now() / 1000) + 3600, 10_000)] });
    const row = {
      id: 0, pageId, platform: "fansly" as const, mediaRef: "9001", variant: "full" as const, mediaKind: "photo" as const,
      senderRole: "model" as const, fanPlatformUserId: null, status: "pending" as const, description: null,
      sourceObservationId: observationId, contentSha256: null, attempts: 1, firstMessageAt: new Date(AFTER), nextAttemptAt: new Date(), leaseToken: null,
    };
    await expect(fanslyAiMediaSource.resolve(app, row, { now: new Date(), modelMedia: "teasers" }))
      .resolves.toMatchObject({ kind: "skip", reason: "creator_media_off" });
    await expect(fanslyAiMediaSource.resolve(app, row, { now: new Date(), modelMedia: "teasers+free" }))
      .resolves.toMatchObject({ kind: "skip", reason: "ppv_body" });
    // A free-looking file inside a priced bundle is a PPV body too, whoever
    // the row says sent it.
    const bundled = await seedObservation({
      accountMedia: [photoMedia("9101", Math.floor(Date.now() / 1000) + 3600)],
      accountMediaBundles: [{ id: "PB1", accountMediaIds: ["9101"], permissions: { permissionFlags: [{ price: 25_000 }] } }],
    });
    await expect(fanslyAiMediaSource.resolve(app, { ...row, mediaRef: "9101", senderRole: "fan", sourceObservationId: bundled }, { now: new Date(), modelMedia: "teasers" }))
      .resolves.toMatchObject({ kind: "skip", reason: "ppv_body" });
  });

  it("treats an expired capture as unavailable and expands a bundle into its files", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = await seedObservation({ accountMedia: [photoMedia("8101", past)] });
    const base = {
      id: 0, pageId, platform: "fansly" as const, variant: "full" as const, senderRole: "fan" as const,
      fanPlatformUserId: FAN, status: "pending" as const, description: null, contentSha256: null, attempts: 1,
      firstMessageAt: new Date(AFTER), nextAttemptAt: new Date(), leaseToken: null,
    };
    await expect(fanslyAiMediaSource.resolve(app, { ...base, mediaRef: "8101", mediaKind: "photo", sourceObservationId: expired }, { now: new Date(), modelMedia: "teasers" }))
      .resolves.toMatchObject({ kind: "unavailable", reason: "source_expired" });

    const future = Math.floor(Date.now() / 1000) + 3600;
    const bundleObservation = await seedObservation({
      accountMedia: [photoMedia("8201", future), photoMedia("8202", future)],
      accountMediaBundles: [{ id: "B7", accountMediaIds: ["8201", "8202"] }],
    });
    await expect(fanslyAiMediaSource.resolve(app, { ...base, mediaRef: "B7", mediaKind: "bundle", sourceObservationId: bundleObservation }, { now: new Date(), modelMedia: "teasers" }))
      .resolves.toMatchObject({ kind: "expand", members: [{ mediaRef: "8201", mediaKind: "photo" }, { mediaRef: "8202", mediaKind: "photo" }] });
  });
});
