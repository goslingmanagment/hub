import { createRequire } from "node:module";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createModel, createOnlyFansPage, insertAgentKey, insertObservation, storeMediaLookSource, type Database } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createMediaLook, readMediaLook, type MediaLookPage } from "../apps/runtime/src/services/media-looks/index.ts";
import { decryptSyncWorkSecret } from "../apps/runtime/src/sync/requests/secret-params.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * Media looks (look:media, owner 2026-11-11): the caps hold before any work is
 * queued — one look in flight per page under concurrency, the daily limit of
 * looks that sent a request, 0 = off — a look's one image request goes to the
 * page's engine with its URL sealed in the work's secret and nowhere else, the
 * frames come back cut and the bytes go; a fresh look of the same file is
 * cached. And the plane's boundary: 403 without the capability, the static
 * 404 outside the grant, a fan's media and an OnlyFans page refused, nothing
 * queued for any of them.
 */

const DAY = 24 * 60 * 60 * 1000;
const OWN = "731275363459538945";
const FAN = "640000000000000001";
const SPRITE_PATH = "/m1/sprite.jpeg";
const signed = (file: string) => `https://cdn3.fansly.com${file}?ngsw-bypass=true&Expires=4102444800&Key-Pair-Id=K&Signature=S`;

interface SharpChain {
  composite(items: Array<{ input: Buffer; left: number; top: number }>): SharpChain;
  jpeg(): SharpChain;
  png(): SharpChain;
  toBuffer(): Promise<Buffer>;
}
const sharp = createRequire(path.resolve("apps/runtime/package.json"))("sharp") as
  (input: { create: { width: number; height: number; channels: 3; background: string } }) => SharpChain;

/** A 3 × 3 thumbnail sheet of 144 × 256 cells, as the page's engine would fetch it. */
async function spriteSheet(): Promise<Buffer> {
  const cell = await sharp({ create: { width: 144, height: 256, channels: 3, background: "#cc3333" } }).png().toBuffer();
  return sharp({ create: { width: 432, height: 768, channels: 3, background: "#3333cc" } })
    .composite([{ input: cell, left: 0, top: 0 }])
    .jpeg()
    .toBuffer();
}

/** A read of the page's schedule: post 100 a video of the page's own, post 200 a fan's photo. */
function scheduleBody() {
  const video = {
    id: "9001", accountId: OWN, mediaId: "7001",
    media: {
      id: "7001", accountId: OWN, mimetype: "video/mp4", width: 720, height: 1280, metadata: JSON.stringify({ duration: 6.27 }),
      locations: [{ locationId: "1", location: signed("/m1/video.mp4") }],
      variants: [
        { id: "7002", type: 1, mimetype: "image/jpeg", width: 480, height: 854, locations: [{ locationId: "1", location: signed("/m1/poster.jpeg") }] },
        { id: "7003", type: 3, mimetype: "image/jpeg", width: 480, height: 854, locations: [{ locationId: "1", location: signed("/m1/blurred.jpeg") }] },
        {
          id: "7004", type: 4, mimetype: "image/jpeg", width: 144, height: 256,
          metadata: JSON.stringify({ duration: 6.27, thumbnailDistance: 1, thumbnailCount: 7, thumbnailGrid: [3, 3], frameDistance: 30 }),
          locations: [{ locationId: "1", location: signed(SPRITE_PATH) }],
        },
      ],
    },
  };
  const fans = {
    id: "9002", accountId: FAN, mediaId: "7101",
    media: {
      id: "7101", accountId: FAN, mimetype: "image/jpeg", width: 1080, height: 1920, locations: [{ locationId: "1", location: signed("/f1/original.jpeg") }],
      variants: [{ id: "7102", type: 1, mimetype: "image/jpeg", width: 720, height: 1280, locations: [{ locationId: "1", location: signed("/f1/720.jpeg") }] }],
    },
  };
  return {
    scheduledPosts: [
      { postId: "100", status: 1, accountId: OWN, scheduledFor: Date.now() + DAY, postTemplate: JSON.stringify({ attachments: [{ pos: 0, contentId: "9001", contentType: 1 }] }) },
      { postId: "200", status: 1, accountId: OWN, scheduledFor: Date.now() + DAY, postTemplate: JSON.stringify({ attachments: [{ pos: 0, contentId: "9002", contentType: 1 }] }) },
    ],
    aggregationData: { accountMedia: [video, fans], accountMediaBundles: [] },
  };
}

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let otherPageId = 0;
let onlyfansPageId = 0;
let ownerId = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  const handles = { db: app.db as unknown as Database, pool: testDb.pool };
  ({ pageId } = await seedSyncPage(handles, { label: "lilly-1", mode: "live", guard: "fansly_sync_engine" }));
  ({ pageId: otherPageId } = await seedSyncPage(handles, { label: "lora-1", mode: "live", guard: "fansly_sync_engine" }));
  await sql("update pages set external_page_id = $1 where id = $2", [OWN, pageId]);
  const model = await createModel(app.db, { slug: "model-lora-of", name: "lora-of" });
  onlyfansPageId = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-of" }))!.id;
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
  await insertObservation(app.db, {
    source: "pull",
    producer: "sync:fansly:publish.schedule",
    platform: "fansly",
    accountId: pageId,
    kind: "posts_scheduled",
    payload: scheduleBody(),
    payloadHash: Buffer.from("a".repeat(64), "hex"),
    idempotencyKey: `fansly-sync:${pageId}:attempt:1`,
  });
});

const page = (): MediaLookPage => ({ id: pageId, pageLabel: "lilly-1", platform: "fansly" });
const notFound = () => new Error("static 404");
const ask = (body: { postRef?: string; publicationId?: number; fresh?: boolean; cover?: boolean }, waitMs = 50) => createMediaLook(app, {
  page: page(),
  agentKeyId: keyIds.get(LOOKER)!,
  body: { index: 0, cover: false, fresh: false, frames: "none", ...body },
  notFound,
  waitMs,
});
const codeOf = (error: unknown) => (error as { code?: string }).code;
const lookWorks = () => sql<{ id: string; subject: string; secret_params: string | null }>(
  "select id::text, subject, secret_params from sync_work where resource = 'media-look.fetch' order by id",
);

/** The page's engine answering a look's work: its bytes onto the look, one request sent, the work closed. */
async function engineAnswers(lookId: number, bytes: Buffer) {
  const [work] = await sql<{ id: string }>("select id::text from sync_work where resource = 'media-look.fetch' and subject = $1", [`look:${lookId}`]);
  expect(await storeMediaLookSource(app.db, { pageId, lookId, contentType: "image/jpeg", bytes })).toBe(true);
  await sql(
    `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
                                jitter_u, pause_ms, operation, request, outcome, http_status, apply_state, applied_at)
     values ($1, false, $2, 'media-look.fetch', $3, 'planned', 1, 2500, 0.1, 2750, 'cdn.media', '{}'::jsonb, 'response', 200, 'applied', clock_timestamp())`,
    [pageId, work!.id, `look:${lookId}`],
  );
  await sql(
    `update sync_work set state = 'done', closed_at = clock_timestamp(), close_reason = 'downloaded', applied_revision = demand_revision,
                          secret_params = null, result = $2::jsonb
      where id = $1`,
    [work!.id, JSON.stringify({ lookId, contentType: "image/jpeg", bytes: bytes.length, hops: 1 })],
  );
}

// --- the keys ------------------------------------------------------------------

const LOOKER = `${AGENT_KEY_TOKEN_PREFIX}look-media`;
const NO_RIGHT = `${AGENT_KEY_TOKEN_PREFIX}look-none`;
const OUTSIDE = `${AGENT_KEY_TOKEN_PREFIX}look-outside`;
const keyIds = new Map<string, number>();

async function issueKeys() {
  for (const [token, name, capabilities, pageIds] of [
    [LOOKER, "look-media", ["look:media"], [pageId, onlyfansPageId]],
    [NO_RIGHT, "look-none", ["read:content"], [pageId]],
    [OUTSIDE, "look-outside", ["look:media"], [otherPageId]],
  ] as const) {
    const key = await insertAgentKey(app.db, {
      name,
      keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(token),
      capabilities: [...capabilities] as never,
      pageIds: [...pageIds],
      expiresAt: new Date(Date.now() + 30 * DAY),
      createdBy: ownerId,
    });
    keyIds.set(token, key.id);
  }
}

let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function startApi() {
  await issueKeys();
  server = await buildApiServer(app);
  await server.ready();
}

const asAgent = (token: string, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

describe("a media look's caps hold before any work is queued", () => {
  it("one look in flight per page, under concurrency; its URL only in the work's sealed secret", async () => {
    await issueKeys();
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => ask({ postRef: "100", fresh: true })));
    const answered = settled.filter((result) => result.status === "fulfilled");
    expect(answered).toHaveLength(1);
    const look = (answered[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof ask>>>).value;
    expect(look.wire).toMatchObject({ status: "queued", coverage: "per_second", media: { type: "video", durationMs: 6270 }, cached: false, budget: { usedToday: 1, limit: 40 } });
    for (const result of settled) {
      if (result.status === "rejected") expect(codeOf(result.reason)).toBe("media_look_in_flight");
    }
    const works = await lookWorks();
    expect(works).toEqual([expect.objectContaining({ subject: `look:${look.wire.lookId}` })]);
    // The URL: sealed in the work's secret, the sheet's — and nowhere else.
    const secret = decryptSyncWorkSecret<{ url: string }>(app.config, works[0]!.secret_params!);
    expect(new URL(secret.url).pathname).toBe(SPRITE_PATH);
    const rows = await sql<{ row: string }>("select row_to_json(l)::text as row from media_looks l");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).not.toContain("fansly.com");
    expect(JSON.stringify(look.wire)).not.toContain("fansly.com");
  });

  it("the engine's answer is cut into frames and its bytes go; the same file again is cached and costs nothing", async () => {
    await issueKeys();
    const first = await ask({ postRef: "100" });
    expect(first.wire.status).toBe("queued");
    await engineAnswers(first.wire.lookId, await spriteSheet());
    const read = await readMediaLook(app, { page: page(), lookId: first.wire.lookId, frames: "inline", notFound });
    expect(read.wire).toMatchObject({ status: "ready", failure: null, coverage: "per_second", frameIntervalMs: 1000, cached: false });
    expect(read.wire.frames.map((frame) => [frame.index, frame.atMs, frame.width, frame.height])).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((index) => [index, index * 1000, 144, 256]),
    );
    expect(read.wire.frames.every((frame) => typeof frame.jpegBase64 === "string" && frame.jpegBase64.length > 0)).toBe(true);
    expect(await sql("select status, requests_sent, source_bytes is null as dropped, frames_expire_at > now() as kept from media_looks"))
      .toEqual([{ status: "ready", requests_sent: 1, dropped: true, kept: true }]);

    const again = await ask({ postRef: "100" });
    expect(again).toMatchObject({ cached: true, wire: { lookId: first.wire.lookId, status: "ready", cached: true } });
    expect(await lookWorks()).toHaveLength(1);
  });

  it("the daily limit counts the looks that sent a request; 0 turns looks off", async () => {
    await issueKeys();
    app.config.mediaLookDailyLimitPerPage = 2;
    const first = await ask({ postRef: "100", fresh: true });
    await sql("update media_looks set status = 'failed', failure = 'fetch_http_403', requests_sent = 1 where id = $1", [first.wire.lookId]);
    const second = await ask({ postRef: "100", fresh: true });
    expect(second.wire).toMatchObject({ status: "queued", budget: { usedToday: 2, limit: 2 } });
    await sql("update media_looks set status = 'failed', failure = 'fetch_timeout', requests_sent = 1 where id = $1", [second.wire.lookId]);
    await expect(ask({ postRef: "100", fresh: true })).rejects.toMatchObject({ statusCode: 429, code: "media_look_daily_limit" });
    expect(await lookWorks()).toHaveLength(2);
    // A look that never sent a request does not count.
    await sql("update media_looks set requests_sent = 0 where id = $1", [second.wire.lookId]);
    expect((await ask({ postRef: "100", fresh: true })).wire.status).toBe("queued");
    await sql("update media_looks set status = 'failed', failure = 'fetch_timeout', requests_sent = 1 where status = 'queued'");
    app.config.mediaLookDailyLimitPerPage = 0;
    await expect(ask({ postRef: "100", fresh: true })).rejects.toMatchObject({ statusCode: 503, code: "media_look_off" });
  });
});

describe("the plane's boundary of a media look", () => {
  it("403 without look:media, the static 404 outside the grant, a fan's file and an OnlyFans page refused — nothing queued", async () => {
    await startApi();
    const body = { postRef: "100" };
    const noRight = await asAgent(NO_RIGHT, "POST", "/api/v1/agent/pages/lilly-1/media-looks", body);
    expect(noRight.statusCode).toBe(403);
    expect(noRight.json().error).toBe("agent_capability_missing");
    const outside = await asAgent(OUTSIDE, "POST", "/api/v1/agent/pages/lilly-1/media-looks", body);
    const none = await asAgent(OUTSIDE, "POST", "/api/v1/agent/pages/no-such-page/media-looks", body);
    expect(outside.statusCode).toBe(404);
    expect(outside.body).toBe(none.body);
    const fans = await asAgent(LOOKER, "POST", "/api/v1/agent/pages/lilly-1/media-looks", { postRef: "200" });
    expect(fans.statusCode, fans.body).toBe(409);
    expect(fans.json().error).toBe("media_look_foreign_media");
    const onlyfans = await asAgent(LOOKER, "POST", "/api/v1/agent/pages/lora-of/media-looks", body);
    expect(onlyfans.statusCode, onlyfans.body).toBe(409);
    expect(onlyfans.json().error).toBe("media_look_fansly_only");
    const notWaiting = await asAgent(LOOKER, "POST", "/api/v1/agent/pages/lilly-1/media-looks", { postRef: "300" });
    // Neither waiting in the schedule nor among the page's posts Hub has seen.
    expect(notWaiting.json().error).toBe("media_look_post_not_seen");
    const both = await asAgent(LOOKER, "POST", "/api/v1/agent/pages/lilly-1/media-looks", { postRef: "100", publicationId: 1 });
    expect(both.statusCode).toBe(400);
    expect(await lookWorks()).toEqual([]);
    expect(await sql("select id from media_looks")).toEqual([]);

    // A look of another page reads as one that does not exist.
    const [foreign] = await sql<{ id: string }>(
      `insert into media_looks (page_id, post_ref, attachment_index, media_ref, media_type, variant, status, source_kind)
       values ($1, '100', 0, '7001', 'video', 'cover', 'failed', 'schedule_read') returning id::text`,
      [otherPageId],
    );
    const theirs = await asAgent(LOOKER, "GET", `/api/v1/agent/pages/lilly-1/media-looks/${foreign!.id}`);
    const missing = await asAgent(LOOKER, "GET", `/api/v1/agent/pages/lilly-1/media-looks/${Number(foreign!.id) + 1000}`);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.body).toBe(missing.body);
    expect((await asAgent(NO_RIGHT, "GET", `/api/v1/agent/pages/lilly-1/media-looks/${foreign!.id}`)).statusCode).toBe(403);
  });
});
