import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, createOnlyFansPage, insertAgentKey, savePublicationQueueSnapshot, type Database } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * The page's media for the agents who draft (wall posts, plan PR 10): the
 * files of a Fansly page (what Hub collected) and of an OnlyFans page (the
 * sendable vault of its current OnlyFansAPI account), newest first by media
 * id, each with its last post on the page — on Fansly through the offer or
 * the bundle that wraps it, on OnlyFans by the vault id — and its nearest
 * live publication; a type filter, a cursor that carries the listing, the
 * grant, and the audit row.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT = `${AGENT_KEY_TOKEN_PREFIX}publication-media`;
const READER = `${AGENT_KEY_TOKEN_PREFIX}publication-media-reader`;
const HASH = "a".repeat(64);

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
let lillyPageId = 0;
let loraPageId = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function sql(text: string, values: unknown[] = []) {
  return testDb!.pool.query(text, values);
}

const ago = (days: number) => new Date(Date.now() - days * DAY_MS);

async function rawMedia(pageId: number, platform: string, ref: string, extra: { mime?: string | null; mediaType?: number | null; durationMs?: number | null } = {}) {
  await sql(
    `insert into creator_raw_media (page_id, platform, media_ref, mime_type, media_type, duration_ms, created_at_platform,
                                    source_kind, first_origin, first_observed_at, last_observed_at, content_hash,
                                    source_event_id, source_observation_id, source_account_seq)
     values ($1, $2, $3, $4, $5, $6, now(), 'vault_media', 'vault', now(), now(), $7, 1, 1, 1)`,
    [pageId, platform, ref, extra.mime ?? null, extra.mediaType ?? null, extra.durationMs ?? null, HASH],
  );
}

async function offer(pageId: number, offerRef: string, mediaRef: string) {
  await sql(
    `insert into creator_media (page_id, platform, media_offer_ref, media_ref, first_origin, first_observed_at,
                                last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', $2, $3, 'vault', now(), now(), $4, 1, 1, 1)`,
    [pageId, offerRef, mediaRef, HASH],
  );
}

async function post(pageId: number, platform: string, postRef: string, contentId: string, publishedAt: Date) {
  await sql(
    `insert into creator_posts (account_id, platform, platform_post_id, text_plain, published_at, first_observed_at,
                                last_observed_at, content_hash, attachment_count, attachment_refs,
                                source_event_id, source_observation_id, source_account_seq)
     values ($1, $2, $3, 'a post', $4, now(), now(), $5, 1, $6::jsonb, 1, 1, 1)`,
    [pageId, platform, postRef, publishedAt, HASH, JSON.stringify([{ contentId, contentType: 1, pos: 0 }])],
  );
}

async function catalog(pageId: number, accountId: string, ref: string, extra: { kind?: string; ready?: boolean; provider?: string; duration?: number } = {}) {
  await sql(
    `insert into ofapi_media_catalog (account_id, page_id, media_ref, material_kind, is_ready, has_error, can_view,
                                      provider_type, byte_size, duration, width, height, metadata,
                                      observation_id, observation_received_at)
     values ($1, $2, $3, $4, $5, false, true, $6, 0, $7, 750, 1000, '{}'::jsonb, 1, now())`,
    [accountId, pageId, ref, extra.kind ?? "vault", extra.ready ?? true, extra.provider ?? "photo", extra.duration ?? 0],
  );
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb);

  const lilly = await createModel(db(), { slug: "lilly", name: "Lilly" });
  const lora = await createModel(db(), { slug: "lora", name: "Lora" });
  lillyPageId = (await createFanslyPage(db(), { modelId: lilly.id, label: "lilly-1" })).id;
  loraPageId = (await createOnlyFansPage(db(), { modelId: lora.id, label: "lora-of" })).id;
  await sql("update pages set ofapi_account_id = 'acct_now' where id = $1", [loraPageId]);
  await sql(
    `insert into page_walls (page_id, platform, wall_ref, name, default_wall, main_wall, first_observed_at, last_observed_at,
                             content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'wall-main', 'Main', true, true, now(), now(), $2, 1, 1, 1)`,
    [lillyPageId, HASH],
  );

  // Fansly: four files; ids grow with uploads, so "1000" is the newest.
  await rawMedia(lillyPageId, "fansly", "100", { mime: "image/jpeg", mediaType: 1 });
  await rawMedia(lillyPageId, "fansly", "200", { mime: "video/mp4", mediaType: 2, durationMs: 15_000 });
  await rawMedia(lillyPageId, "fansly", "300", { mime: null, mediaType: 1 });
  await rawMedia(lillyPageId, "fansly", "1000", { mime: "video/mp4", mediaType: 2, durationMs: 9_000 });
  // "200" went out twice through its offer; "300" once inside a bundle.
  await offer(lillyPageId, "o-200", "200");
  await offer(lillyPageId, "o-300", "300");
  await offer(lillyPageId, "o-100", "100");
  await sql(
    `insert into creator_media_bundles (page_id, platform, bundle_ref, member_refs, first_observed_at, last_observed_at,
                                        content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'b-1', array['o-300'], now(), now(), $2, 1, 1, 1)`,
    [lillyPageId, HASH],
  );
  await post(lillyPageId, "fansly", "p-old", "o-200", ago(60));
  await post(lillyPageId, "fansly", "p-new", "o-200", ago(5));
  await post(lillyPageId, "fansly", "p-bundle", "b-1", ago(40));

  // OnlyFans: the sendable vault of the current account, and what is not.
  await catalog(loraPageId, "acct_now", "5001");
  await catalog(loraPageId, "acct_now", "5002", { provider: "video", duration: 12.5 });
  await catalog(loraPageId, "acct_now", "5003", { ready: false });
  await catalog(loraPageId, "acct_now", "5004", { kind: "cdn" });
  await catalog(loraPageId, "acct_old", "5005");
  await post(loraPageId, "onlyfans", "of-1", "5001", ago(3));

  const owner = await createUserAccount(appContext, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  for (const [token, name, capabilities] of [
    [AGENT, "publication-media", ["write:publication_drafts"]],
    [READER, "publication-media-reader", ["read:datasets"]],
  ] as const) {
    await insertAgentKey(testDb.db, {
      name,
      keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(token),
      capabilities: [...capabilities] as never,
      pageIds: [lillyPageId, loraPageId],
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      createdBy: owner?.id ?? 0,
    });
  }

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
  const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: "owner-secret" } });
  const setCookie = login.headers["set-cookie"];
  ownerCookie = String((Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "").split(";")[0] ?? "";
  expect(ownerCookie).not.toBe("");
});

afterEach(async () => {
  await server?.close();
  server = null;
});

function agent(url: string, token = AGENT) {
  return server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

interface MediaItem {
  mediaRef: string;
  type: string | null;
  durationMs: number | null;
  lastPost: { at: string; postRef: string } | null;
  nearestPublication: { id: number; status: string } | null;
  repostWithinThreshold: boolean;
}

describe("publication media: the page's files for a draft", () => {
  it("Fansly: newest first, the last post through an offer or a bundle, the nearest live publication", async () => {
    // A live publication of "100": drafted and approved by the owner.
    const drafted = await server!.inject({
      method: "POST", url: "/api/v1/admin/publications", headers: { cookie: ownerCookie },
      payload: { pageLabel: "lilly-1", kind: "fyp_post", text: "x", media: [{ source: "vault", mediaRef: "100" }], publishAt: new Date(Date.now() + DAY_MS).toISOString() },
    });
    expect(drafted.statusCode, drafted.body).toBe(200);
    const approved = await server!.inject({
      method: "POST", url: "/api/v1/admin/publications/approve", headers: { cookie: ownerCookie },
      payload: { items: [{ id: drafted.json().id, version: drafted.json().version }] },
    });
    expect(approved.json().results[0].outcome, approved.body).toBe("approved");

    const response = await agent("/api/v1/agent/pages/lilly-1/publication-media");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { platform: string; repostThresholdDays: number; media: MediaItem[]; nextCursor: string | null };
    expect(body).toMatchObject({ platform: "fansly", repostThresholdDays: 30, nextCursor: null });
    expect(body.media.map((item) => item.mediaRef)).toEqual(["1000", "300", "200", "100"]);
    const byRef = new Map(body.media.map((item) => [item.mediaRef, item]));
    expect(byRef.get("1000")).toMatchObject({ type: "video", durationMs: 9_000, lastPost: null, nearestPublication: null, repostWithinThreshold: false });
    expect(byRef.get("300")).toMatchObject({ type: "image", lastPost: { postRef: "p-bundle" }, repostWithinThreshold: false });
    expect(byRef.get("200")).toMatchObject({ lastPost: { postRef: "p-new" }, repostWithinThreshold: true });
    expect(byRef.get("100")).toMatchObject({
      lastPost: null, nearestPublication: { id: drafted.json().id, status: "approved" }, repostWithinThreshold: true,
    });

    // Planned 40 days ahead, the fresh post of "200" is outside the threshold.
    const later = await agent(`/api/v1/agent/pages/lilly-1/publication-media?type=video&publishAt=${encodeURIComponent(new Date(Date.now() + 40 * DAY_MS).toISOString())}`);
    expect((later.json().media as MediaItem[]).map((item) => `${item.mediaRef}:${item.repostWithinThreshold}`)).toEqual(["1000:false", "200:false"]);
  });

  it("the cursor carries the listing and continues after the last file", async () => {
    const first = await agent("/api/v1/agent/pages/lilly-1/publication-media?limit=3");
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json().media as MediaItem[]).map((item) => item.mediaRef)).toEqual(["1000", "300", "200"]);
    const cursor = first.json().nextCursor as string;
    expect(cursor).toEqual(expect.any(String));

    const second = await agent(`/api/v1/agent/pages/lilly-1/publication-media?cursor=${cursor}`);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ media: [{ mediaRef: "100" }], nextCursor: null });

    const resent = await agent(`/api/v1/agent/pages/lilly-1/publication-media?cursor=${cursor}&type=image`);
    expect(resent.statusCode).toBe(400);
    const otherPage = await agent(`/api/v1/agent/pages/lora-of/publication-media?cursor=${cursor}`);
    expect(otherPage.statusCode).toBe(400);

    const audit = await sql(
      "select operation, page_ids, verbatim_text, request_summary from agent_read_audit where operation = 'agentPublicationMedia' order by id",
    );
    expect(audit.rows.map((row) => row.request_summary)).toEqual([
      { limit: 3, returned: 3, cursorConsumed: false },
      { limit: 3, returned: 1, cursorConsumed: true },
    ]);
    expect(audit.rows[0]).toMatchObject({ verbatim_text: false });
  });

  it("OnlyFans: only the ready vault of the page's current account; the last post by vault id", async () => {
    const response = await agent("/api/v1/agent/pages/lora-of/publication-media");
    expect(response.statusCode, response.body).toBe(200);
    const media = response.json().media as MediaItem[];
    expect(media.map((item) => item.mediaRef)).toEqual(["5002", "5001"]);
    expect(media[0]).toMatchObject({ type: "video", durationMs: 12_500, lastPost: null });
    expect(media[1]).toMatchObject({ type: "image", lastPost: { postRef: "of-1" }, repostWithinThreshold: true });
  });

  it("a file booked in the platform's own schedule by hand repeats, in the listing and in the draft's check (spec §8.1)", async () => {
    const at = new Date(Math.floor((Date.now() + 2 * DAY_MS) / 1000) * 1000);
    await savePublicationQueueSnapshot(db(), {
      pageId: lillyPageId, answeredRequestAt: null, readAt: new Date(), windowFrom: null, windowTo: null,
      complete: true, incompleteReasons: [], postsPerDay: {},
      entries: [
        // "1000" named by its media id; "300" only by the bundle that wraps its offer.
        { queueId: "sp-1", postRef: "sp-1", publishAt: at.toISOString(), text: "", mediaCount: 1, mediaRefs: ["1000"], attachmentRefs: ["am-x"] },
        { queueId: "sp-2", postRef: "sp-2", publishAt: at.toISOString(), text: "", mediaCount: 1, mediaRefs: [], attachmentRefs: ["b-1"] },
      ],
      evidence: {},
    });
    const listed = async () => new Map((((await agent("/api/v1/agent/pages/lilly-1/publication-media")).json().media) as Array<MediaItem & { platformSchedule: unknown }>)
      .map((item) => [item.mediaRef, item]));
    const byRef = await listed();
    expect(byRef.get("1000")).toMatchObject({ platformSchedule: { at: at.toISOString(), postRef: "sp-1" }, repostWithinThreshold: true });
    expect(byRef.get("300")).toMatchObject({ platformSchedule: { postRef: "sp-2" }, repostWithinThreshold: true });
    expect(byRef.get("100")).toMatchObject({ platformSchedule: null });

    // The draft's own check finds the same booking.
    const drafted = await server!.inject({
      method: "POST", url: "/api/v1/admin/publications", headers: { cookie: ownerCookie },
      payload: { pageLabel: "lilly-1", kind: "fyp_post", text: "x", media: [{ source: "vault", mediaRef: "1000" }], publishAt: new Date(at.getTime() + DAY_MS).toISOString() },
    });
    expect(drafted.statusCode, drafted.body).toBe(200);
    expect(drafted.json().findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "repost_within_threshold", severity: "blocking", postRef: "sp-1" })]));

    // An entry that is Hub's own post is a publication, not a hand booking.
    await sql("update publications set platform_post_ref = 'sp-1' where id = $1", [drafted.json().id]);
    expect((await listed()).get("1000")).toMatchObject({ platformSchedule: null });
  });

  it("a key without write:publication_drafts is 403; a page outside the grant 404", async () => {
    expect((await agent("/api/v1/agent/pages/lilly-1/publication-media", READER)).statusCode).toBe(403);
    expect((await agent("/api/v1/agent/pages/nobody-1/publication-media")).statusCode).toBe(404);
  });
});
