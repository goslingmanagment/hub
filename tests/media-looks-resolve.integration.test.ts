import { createRequire } from "node:module";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSyncPage,
  getSyncWork,
  insertAgentKey,
  insertObservation,
  NEVER_CANONICALIZED_PARSE_VERSION,
  storeMediaLookSource,
  type Database,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createMediaLook, readMediaLook, type MediaLookPage } from "../apps/runtime/src/services/media-looks/index.ts";
import type { ApplyInput } from "../apps/runtime/src/sync/engine/resource.ts";
import { stripFanslySignedCdnTokens } from "../apps/runtime/src/sync/fansly/lib/cdn-tokens.ts";
import { mediaLookResolveModule } from "../apps/runtime/src/sync/fansly/resources/media-look-resolve.ts";
import { createSyncWorkSecretBox, decryptSyncWorkSecret } from "../apps/runtime/src/sync/requests/secret-params.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * A media look of a PUBLISHED post or a VAULT file (owner 2026-11-11): the
 * page's engine reads the post or the file's vault page first
 * (`media-look.resolve`); its apply takes the signed location from the answer
 * in memory and writes it nowhere but sealed into the image work's secret — a
 * re-apply from the journal (its tokens stripped) fails the look and queues
 * nothing. Only a post Hub has among this page's own posts, only a file of the
 * page's own account in its vault; one look in flight per page across the read
 * and the image; two requests, one look.
 */

const DAY = 24 * 60 * 60 * 1000;
const HASH = "f".repeat(64);
const OWN = "731275363459538945";
const FAN = "640000000000000001";
const ALBUM = "928408212237991937";
const MEMBER = "941543463445344263";
const signed = (file: string) => `https://cdn3.fansly.com${file}?ngsw-bypass=true&Expires=4102444800&Key-Pair-Id=K&Signature=S`;

function video(id: string, accountId = OWN) {
  return {
    id, accountId, mimetype: "video/mp4", width: 720, height: 1280, metadata: JSON.stringify({ duration: 6.6 }),
    locations: [{ locationId: "1", location: signed(`/${id}/video.mp4`) }],
    variants: [
      { id: `${id}1`, type: 1, mimetype: "image/jpeg", width: 480, height: 854, locations: [{ locationId: "1", location: signed(`/${id}/poster.jpeg`) }] },
      {
        id: `${id}4`, type: 4, mimetype: "image/jpeg", width: 144, height: 256,
        metadata: JSON.stringify({ thumbnailDistance: 1, thumbnailCount: 7, thumbnailGrid: [3, 3] }),
        locations: [{ locationId: "1", location: signed(`/${id}/sprite.jpeg`) }],
      },
    ],
  };
}

/** `GET /post?ids=500` as the page's engine would hold it in memory. */
const postAnswer = (owner = OWN) => ({
  posts: [{ id: "500", accountId: OWN, attachments: [{ pos: 0, contentId: "901", contentType: 1 }] }],
  accountMediaBundles: [],
  accountMedia: [{ id: "901", accountId: owner, mediaId: "701", media: video("701", owner) }],
});
/** `GET /media/vaultnew?albumId=…&before=<member + 1>`. */
const vaultAnswer = () => ({
  media: [video("703")],
  albumMedia: [{ id: MEMBER, albumId: ALBUM, mediaId: "703", accountId: OWN }],
});

interface SharpChain {
  composite(items: Array<{ input: Buffer; left: number; top: number }>): SharpChain;
  jpeg(): SharpChain;
  png(): SharpChain;
  toBuffer(): Promise<Buffer>;
}
const sharp = createRequire(path.resolve("apps/runtime/package.json"))("sharp") as
  (input: { create: { width: number; height: number; channels: 3; background: string } }) => SharpChain;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let otherPageId = 0;
let keyId = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

async function rawMedia(page: number, mediaRef: string, owner: string, mime = "video/mp4") {
  await sql(
    `insert into creator_raw_media (page_id, platform, media_ref, owner_account_ref, mime_type, source_kind, first_origin,
                                    first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', $2, $3, $4, 'vault_media', 'vault', now(), now(), $5, 1, 1, 1)`,
    [page, mediaRef, owner, mime, HASH],
  );
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
  // Post 500 is the page's own and published; post 600 is another page's.
  for (const [page, postRef] of [[pageId, "500"], [otherPageId, "600"]] as const) {
    await sql(
      `insert into creator_posts (account_id, platform, platform_post_id, text_plain, published_at, first_observed_at,
                                  last_observed_at, content_hash, attachment_count, attachment_refs,
                                  source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', $2, 'a post', now() - interval '3 days', now(), now(), $3, 1, $4::jsonb, 1, 1, 1)`,
      [page, postRef, HASH, JSON.stringify([{ pos: 0, contentId: "901", contentType: 1 }])],
    );
  }
  await sql(
    `insert into creator_media (page_id, platform, media_offer_ref, media_ref, first_origin, first_observed_at,
                                last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', '901', '701', 'post', now(), now(), $2, 1, 1, 1)`,
    [pageId, HASH],
  );
  // The page's own vault file 703, a fan's 704 on the page, the page's own 706 in no album, 705 another page's.
  await rawMedia(pageId, "703", OWN);
  await rawMedia(pageId, "704", FAN);
  await rawMedia(pageId, "706", OWN);
  await rawMedia(otherPageId, "705", OWN);
  await sql(
    `insert into creator_vault_album_members (page_id, platform, album_ref, media_offer_ref, member_ref, media_ref, vault_kind,
                                              first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', $2, null, $3, '703', 'creator', now(), now(), $4, 1, 1, 1)`,
    [pageId, ALBUM, MEMBER, HASH],
  );
  const owner = await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" });
  const token = `${AGENT_KEY_TOKEN_PREFIX}look-resolve`;
  keyId = (await insertAgentKey(app.db, {
    name: "look-resolve",
    keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(token),
    capabilities: ["look:media"] as never,
    pageIds: [pageId],
    expiresAt: new Date(Date.now() + 30 * DAY),
    createdBy: owner.id,
  })).id;
});

const page = (): MediaLookPage => ({ id: pageId, pageLabel: "lilly-1", platform: "fansly" });
const notFound = () => new Error("static 404");
const ask = (body: { postRef?: string; mediaRef?: string; fresh?: boolean }) => createMediaLook(app, {
  page: page(), agentKeyId: keyId, notFound, waitMs: 50,
  body: { index: 0, cover: false, fresh: false, frames: "none", ...body },
});
const works = (resource: string) => sql<{ id: string; subject: string; params: unknown; secret_params: string | null; result: unknown }>(
  "select id::text, subject, params, secret_params, result from sync_work where resource = $1 order by id", [resource],
);

/** The page's engine applying its read of the look: the answer in memory, or the journal's copy. */
async function engineReads(lookId: number, answer: unknown) {
  const [work] = await works("media-look.resolve");
  expect(work?.subject).toBe(`look:${lookId}`);
  const params = work!.params as { target: string };
  const journaled = await insertObservation(app.db, {
    source: "pull", producer: "sync:fansly:media-look.resolve", platform: "fansly", accountId: pageId,
    kind: params.target === "post" ? "posts" : "vault_media",
    payload: stripFanslySignedCdnTokens(answer), payloadHash: Buffer.from("b".repeat(64), "hex"), idempotencyKey: `look-read:${lookId}`,
  });
  const input: ApplyInput = {
    pageId,
    now: new Date(),
    ownRef: OWN,
    work: (await getSyncWork(app.db, Number(work!.id)))!,
    attempt: { id: 1 } as never,
    request: params.target === "post" ? { spec: "posts.by_ids", params: { ids: ["500"] } } : { spec: "vault.media", params: { albumId: ALBUM, before: "941543463445344264" } },
    parsed: null,
    response: answer,
    observation: { id: journaled.observationId, receivedAt: journaled.receivedAt },
    fenced: false,
    page: (await getSyncPage(app.db, pageId))!,
    secrets: createSyncWorkSecretBox(app.config),
  };
  const result = await app.db.transaction(async (tx) => mediaLookResolveModule.apply(tx as unknown as Database, input));
  // The engine settles the read's work after its apply, with its one request.
  await sql(
    `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
                                jitter_u, pause_ms, operation, request, outcome, http_status, apply_state, applied_at)
     values ($1, false, $2, 'media-look.resolve', $3, 'planned', 1, 2500, 0.1, 2750, $4, '{}'::jsonb, 'response', 200, 'applied', clock_timestamp())`,
    [pageId, work!.id, `look:${lookId}`, input.request.spec],
  );
  await sql(
    `update sync_work set state = 'done', closed_at = clock_timestamp(), close_reason = $2, applied_revision = demand_revision, result = $3::jsonb
      where id = $1`,
    [work!.id, result.work.closeReason, JSON.stringify(result.work.result)],
  );
  return { result, observation: journaled };
}

/** The page's engine answering the look's image request: its bytes on the look, one request, the work closed. */
async function engineFetches(lookId: number) {
  const [work] = await works("media-look.fetch");
  const cell = await sharp({ create: { width: 144, height: 256, channels: 3, background: "#cc3333" } }).png().toBuffer();
  const sheet = await sharp({ create: { width: 432, height: 768, channels: 3, background: "#3333cc" } })
    .composite([{ input: cell, left: 0, top: 0 }]).jpeg().toBuffer();
  expect(await storeMediaLookSource(app.db, { pageId, lookId, contentType: "image/jpeg", bytes: sheet })).toBe(true);
  await sql(
    `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
                                jitter_u, pause_ms, operation, request, outcome, http_status, apply_state, applied_at)
     values ($1, false, $2, 'media-look.fetch', $3, 'planned', 1, 2500, 0.1, 2750, 'cdn.media', '{}'::jsonb, 'response', 200, 'applied', clock_timestamp())`,
    [pageId, work!.id, `look:${lookId}`],
  );
  await sql(
    `update sync_work set state = 'done', closed_at = clock_timestamp(), close_reason = 'downloaded', applied_revision = demand_revision,
                          secret_params = null where id = $1`,
    [work!.id],
  );
}

describe("a look of a published post: one read, then the image", () => {
  it("the read's apply takes the URL from the answer in memory and writes it only sealed into the image's work", async () => {
    const first = await ask({ postRef: "500" });
    expect(first.wire).toMatchObject({ status: "queued", source: "post_read", target: { postRef: "500", index: 0, mediaRef: null }, media: { type: null } });
    // The read is queued, its parameters name the post and nothing else.
    expect(await works("media-look.resolve")).toEqual([expect.objectContaining({
      subject: `look:${first.wire.lookId}`, params: { target: "post", postRef: "500", index: 0, cover: false }, secret_params: null,
    })]);
    expect(await works("media-look.fetch")).toEqual([]);
    // One look in flight per page, through the read …
    await expect(ask({ postRef: "500", fresh: true })).rejects.toMatchObject({ code: "media_look_in_flight" });

    const { result, observation } = await engineReads(first.wire.lookId, postAnswer());
    expect(result).toMatchObject({ canonicalized: true, work: { close: "done", closeReason: "look_resolved" } });
    expect(JSON.stringify(result)).not.toContain("fansly.com");
    // Journaled, never canonicalized.
    expect(await sql("select parse_version from observations where id = $1", [observation.observationId]))
      .toEqual([{ parse_version: NEVER_CANONICALIZED_PARSE_VERSION }]);
    // The look names its file; the URL is in the image work's sealed secret and nowhere else.
    const [fetch] = await works("media-look.fetch");
    expect(fetch).toMatchObject({ subject: `look:${first.wire.lookId}` });
    expect(new URL(decryptSyncWorkSecret<{ url: string }>(app.config, fetch!.secret_params!).url).pathname).toBe("/701/sprite.jpeg");
    const stored = await sql<{ row: string }>("select row_to_json(l)::text as row from media_looks l");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.row).not.toContain("fansly.com");
    expect(JSON.stringify(await sql("select params, result from sync_work"))).not.toContain("fansly.com");
    // … and through the image.
    await expect(ask({ postRef: "500", fresh: true })).rejects.toMatchObject({ code: "media_look_in_flight" });

    await engineFetches(first.wire.lookId);
    const read = await readMediaLook(app, { page: page(), lookId: first.wire.lookId, frames: "none", notFound });
    // Two requests, one look.
    expect(read.wire).toMatchObject({
      status: "ready", source: "post_read", requestsSent: 2, coverage: "per_second",
      target: { postRef: "500", index: 0, mediaRef: "701" }, media: { type: "video" }, budget: { usedToday: 1 },
    });
    expect(read.wire.frames).toHaveLength(7);
    // The same file again: cached, nothing read.
    const again = await ask({ postRef: "500" });
    expect(again).toMatchObject({ cached: true, wire: { lookId: first.wire.lookId, cached: true } });
    expect(await works("media-look.resolve")).toHaveLength(1);
  });

  it("a file the answer names under another account is refused after the read; nothing is queued", async () => {
    const look = await ask({ postRef: "500" });
    await engineReads(look.wire.lookId, postAnswer(FAN));
    expect(await sql("select status, failure, requests_sent from media_looks")).toEqual([{ status: "failed", failure: "foreign_media", requests_sent: 1 }]);
    expect(await works("media-look.fetch")).toEqual([]);
  });
});

describe("a look of a vault file: the vault page that starts at it", () => {
  it("reads from the file's own membership row; read back from the journal it fails, never read again", async () => {
    const look = await ask({ mediaRef: "703" });
    expect(look.wire).toMatchObject({ status: "queued", source: "vault_read", target: { postRef: null, index: null, mediaRef: "703" } });
    expect((await works("media-look.resolve"))[0]?.params).toEqual({
      target: "vault", mediaRef: "703", albumRef: ALBUM, before: "941543463445344264", cover: false,
    });
    // The journal's copy: its signing tokens stripped.
    await engineReads(look.wire.lookId, stripFanslySignedCdnTokens(vaultAnswer()));
    const read = await readMediaLook(app, { page: page(), lookId: look.wire.lookId, frames: "none", notFound });
    expect(read.wire).toMatchObject({ status: "failed", failure: "source_not_in_memory", requestsSent: 1 });
    expect(await works("media-look.fetch")).toEqual([]);
    expect(await works("media-look.resolve")).toHaveLength(1);
  });

  it("the answer in memory queues the image", async () => {
    const look = await ask({ mediaRef: "703" });
    await engineReads(look.wire.lookId, vaultAnswer());
    const [fetch] = await works("media-look.fetch");
    expect(new URL(decryptSyncWorkSecret<{ url: string }>(app.config, fetch!.secret_params!).url).pathname).toBe("/703/sprite.jpeg");
  });
});

describe("only what Hub has seen on this page, of its own account", () => {
  it("another page's post, an unknown post, a fan's file, another page's file and a file in no album are refused before anything is queued", async () => {
    for (const [body, code] of [
      [{ postRef: "600" }, "media_look_post_not_seen"],
      [{ postRef: "999" }, "media_look_post_not_seen"],
      [{ mediaRef: "704" }, "media_look_media_not_seen"],
      [{ mediaRef: "705" }, "media_look_media_not_seen"],
      [{ mediaRef: "799" }, "media_look_media_not_seen"],
      [{ mediaRef: "706" }, "media_look_not_in_vault"],
    ] as const) {
      await expect(ask(body), JSON.stringify(body)).rejects.toMatchObject({ statusCode: 409, code });
    }
    expect(await sql("select id from sync_work where resource like 'media-look.%'")).toEqual([]);
    expect(await sql("select id from media_looks")).toEqual([]);
  });
});
