import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendProjectionOnlyDomainEvents, createFanslyPage, createOnlyFansPage, createModel, createUser,
  ensureDomainEventPartitions, insertAgentKey, insertObservation, setConfigOverride, markObservationParsed,
} from "@agency_hub_core/db";
import type { AgentDatasetQueryResponse } from "@agency_hub_core/contracts";
import { sha256Hex } from "@agency_hub_core/shared";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { AGENT_KEY_TOKEN_PREFIX } from "../apps/runtime/src/services/auth.ts";
import { runCanonicalization, resetCanonicalizeSweepCursors } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { buildOnlyFansPostDrafts } from "../apps/runtime/src/services/canonicalize/onlyfans-post-media.ts";
import { buildPostObservedDraft } from "../apps/runtime/src/services/canonicalize/posts.ts";
import { parseStrictOfapiPostPage } from "../apps/runtime/src/services/ofapi-capture-contract.ts";
import { runMediaPlaneProjection, rebuildMediaPlaneProjection } from "../apps/runtime/src/services/projections/media-plane.ts";
import { runCreatorPostsProjection, rebuildCreatorPostsProjection } from "../apps/runtime/src/services/projections/creator-posts.ts";
import { runFanslyCatalogProjection, rebuildFanslyCatalogProjection } from "../apps/runtime/src/services/projections/fansly-catalog.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let db: StartedTestDatabase;
let server: Awaited<ReturnType<typeof buildApiServer>> | undefined;
let pageId: number;
const TOKEN = `${AGENT_KEY_TOKEN_PREFIX}content-media-fixture`;
const fixture = JSON.parse(readFileSync("tests/fixtures/fansly-catalog/content-media-vault.json", "utf8"));
const date = (day: number) => new Date(`2026-09-${String(day).padStart(2, "0")}T10:00:00Z`);
const app = () => createTestAppContext(db, { authPolicyEnforcement: "enforce" });
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Content media integration requires PostgreSQL");
  db = started;
}, 180_000);
afterAll(async () => { await server?.close(); await db?.stop(); });
beforeEach(async () => {
  await server?.close(); server = undefined;
  await resetIntegrationDatabase(db.pool); resetCanonicalizeSweepCursors();
  const model = (await createModel(db.db, { slug: "media", name: "Media" }))!;
  pageId = (await createFanslyPage(db.db, { modelId: model.id, label: "media-page" }))!.id;
  await db.pool.query("update pages set external_page_id = 'creator-1' where id = $1", [pageId]);
  await ensureDomainEventPartitions(db.db);
  const owner = await createUser(db.db, { username: "owner", role: "owner", passwordHash: null });
  await insertAgentKey(db.db, { name: "media", keyPrefix: TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(TOKEN), capabilities: ["read:datasets", "read:messages"], pageIds: [pageId],
    dailyRequestBudget: 5000, dailyRowBudget: 500000, expiresAt: new Date(Date.now() + 86400000), createdBy: owner?.id ?? null });
  await setConfigOverride(db.db, { key: "agentReadPlaneMode", value: "full", userId: owner?.id ?? null, groupId: randomUUID() });
  server = await buildApiServer(app()); await server.ready();
});

async function capture(kind: string, payload: unknown, day = 1) {
  return insertObservation(db.db, { source: "pull", producer: "sync:fansly:catalog", platform: "fansly",
    accountId: pageId, kind, payload, payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: randomUUID(), receivedAt: date(day) });
}
async function project() {
  await runCanonicalization(app(), { kinds: ["vault_media", "posts", "vault_album_walk_completed"] });
  await runFanslyCatalogProjection(app(), { accountId: pageId });
  await runMediaPlaneProjection(app(), { accountId: pageId });
  await runCreatorPostsProjection(app(), { accountId: pageId });
}
async function query(dataset: string, extra: Record<string, unknown> = {}, label = "media-page") {
  const response = await server!.inject({ method: "POST", url: `/api/v1/agent/pages/${label}/datasets/${dataset}/query`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { ...(!extra.cursor ? { from: "2026-01-01T00:00:00Z", to: "2026-10-01T00:00:00Z" } : {}), limit: 100, ...extra } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AgentDatasetQueryResponse>();
}
async function scan(refs: string[], day: number, walkRef = randomUUID()) {
  await capture("vault_album_walk_completed", { valid: true, vaultKind: "creator", albumRef: "album-1", walkRef,
    startedAt: date(day).toISOString(), completedAt: new Date(date(day).getTime() + 60000).toISOString(),
    expectedCount: refs.length, seenMediaRefs: refs, pages: 2, observationRefs: [1, 2] }, day);
}

describe("[sync-critical] content media raw to agent API", () => {
  it("serves the new contract to the matching CLI and rejects an optional pinned old CLI", async () => {
    const baseUrl = await server!.listen({ host: "127.0.0.1", port: 0 });
    const argv = ["capabilities", "--base-url", baseUrl];
    const env = { ...process.env, HUB_AGENT_KEY: TOKEN, HUB_BASE_URL: baseUrl };
    const current = await promisify(execFile)(process.execPath, ["--import", "tsx/esm", "packages/hub-agent-cli/src/cli.ts", ...argv], { env });
    expect(current.stdout).toContain('"raw_media"');
    expect(current.stdout).toContain('"post_attachments"');
    // Optional release rehearsal: a local pinned binary, pointed explicitly
    // at the disposable server with a fixture token, never at production.
    if (process.env.CONTENT_MEDIA_OLD_CLI) {
      await expect(promisify(execFile)(process.env.CONTENT_MEDIA_OLD_CLI, argv, { env }))
        .rejects.toMatchObject({ code: 4 });
    }
  });

  it("serves a raw file without an offer and membership without an album head; enforces text access", async () => {
    await capture("vault_media", fixture); await project();
    const raw = await query("raw_media");
    expect(raw.items.map((i) => i.fields).find((f) => f.mediaRef === "file-1")).toMatchObject({
      filename: "8_43 ????????.mp4", durationMs: 522682, frameRateMilli: 30210,
      width: 720, height: 1280, originalWidth: 2160, originalHeight: 3840,
    });
    const vault = await query("vault_media");
    expect(vault.items).toHaveLength(2);
    expect(vault.items[0]!.fields.albumTitle).toBeNull();
    expect(JSON.stringify([raw, vault])).not.toContain("DO_NOT_COPY");
    await db.pool.query("update agent_keys set capabilities = ARRAY['read:datasets']::text[]");
    const refused = await server!.inject({ method: "POST", url: "/api/v1/agent/pages/media-page/datasets/raw_media/query",
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { from: "2026-01-01T00:00:00Z", to: "2026-10-01T00:00:00Z" } });
    expect(refused.statusCode).toBe(403);
  });

  it("does not rewrite the album on a member sighting or a repeated absence proof", async () => {
    const members = Array.from({ length: 250 }, (_, i) => ({
      ...fixture.albumMedia[0], id: `member-${i}`, mediaId: `file-${i}`,
    }));
    await capture("vault_media", { albumMedia: members, media: [] }); await project();
    await scan(members.map(m => m.mediaId), 2); await project();
    const versions = async () => (await db.pool.query(
      "select media_ref, xmin::text as version from creator_vault_album_members where page_id = $1", [pageId],
    )).rows as Array<{ media_ref: string; version: string }>;
    const before = new Map((await versions()).map(row => [row.media_ref, row.version]));
    await capture("vault_media", { albumMedia: [{ ...members[0], customFilename: "changed" }], media: [] }, 3);
    await project();
    expect((await versions()).filter(row => row.version !== before.get(row.media_ref)).map(row => row.media_ref)).toEqual(["file-0"]);
    const beforeScan = new Map((await versions()).map(row => [row.media_ref, row.version]));
    await scan(members.slice(0, -2).map(m => m.mediaId), 4); await project();
    expect((await versions()).filter(row => row.version !== beforeScan.get(row.media_ref))).toHaveLength(2);
    const beforeRepeat = await versions();
    await scan(members.slice(0, -2).map(m => m.mediaId), 5); await project();
    expect(await versions()).toEqual(beforeRepeat);
  });

  it("keeps rich metadata across sparse observations and preserves A-B-A sightings without a complete walk", async () => {
    await capture("vault_media", fixture, 1); await project();
    const renamed = structuredClone(fixture); renamed.media[0].filename = "B";
    renamed.albumMedia[0].customFilename = "B";
    await capture("vault_media", renamed, 2); await project();
    await capture("vault_media", fixture, 3); await project();
    expect((await query("raw_media")).items.find(i => i.fields.mediaRef === "file-1")?.fields.filename).toBe(fixture.media[0].filename);
    expect((await query("vault_media")).items.find(i => i.fields.mediaRef === "file-1")?.fields.customFilename).toBe(fixture.albumMedia[0].customFilename);
    const sparse = { posts: [], media: [{ id: "file-1" }] };
    await capture("posts", sparse, 4); await project();
    expect((await query("raw_media")).items.find(i => i.fields.mediaRef === "file-1")?.fields).toMatchObject({
      filename: fixture.media[0].filename, durationMs: 522682, originalWidth: 2160,
      lastObservedAt: date(4).toISOString(), sourceKind: "posts",
    });
    await capture("posts", { posts: [], media: [{ id: "file-1", filename: "", metadata: { duration: 0 } }] }, 5); await project();
    expect((await query("raw_media")).items.find(i => i.fields.mediaRef === "file-1")?.fields).toMatchObject({ filename: "", durationMs: 0, originalWidth: 2160 });
  });

  it("isolates identically named media, offers and posts on two populated pages", async () => {
    const firstPage = pageId;
    const model = (await createModel(db.db, { slug: "other", name: "Other" }))!;
    const second = (await createFanslyPage(db.db, { modelId: model.id, label: "other-media" }))!;
    for (const target of [firstPage, second.id]) {
      pageId = target;
      const payload = structuredClone(fixture);
      for (const file of payload.media) file.filename = `page-${target}`;
      await capture("vault_media", payload);
      await capture("posts", { posts: [{ id: "same-post", createdAt: date(1).getTime(), content: "caption",
        attachments: [{ contentType: 1, contentId: "offer-1", pos: 0 }] }],
        accountMedia: [{ id: "offer-1", accountId: "creator", mediaId: "file-1" }] });
      await project();
    }
    pageId = firstPage;
    await db.pool.query("update agent_keys set page_ids = ARRAY[$1, $2]::bigint[]", [firstPage, second.id]);
    for (const [target, label] of [[firstPage, "media-page"], [second.id, "other-media"]] as const) {
      for (const dataset of ["raw_media", "post_attachments", "vault_media"]) {
        const result = await query(dataset, {}, label);
        expect(result.items.length).toBeGreaterThan(0);
        expect(result.items.every(item => item.fields.filename === `page-${target}`)).toBe(true);
      }
    }
  });

  it("returns historical replay and relation changes through rowUpdatedAt filters", async () => {
    await capture("vault_media", fixture); await capture("posts", {
      posts: [{ id: "old-post", createdAt: date(1).getTime(), content: "caption", attachments: [{ pos: 0, contentType: 1, contentId: "offer-1" }] }],
      accountMedia: [{ id: "offer-1", accountId: "creator", mediaId: "file-1" }],
    }); await project();
    // Put the initial projection writes outside the overlap, retaining their source dates.
    for (const table of ["creator_raw_media", "creator_media", "creator_posts", "creator_vault_album_members"]) {
      await db.pool.query(`update ${table} set updated_at = '2025-01-01'`);
    }
    const extra = { filters: [{ field: "rowUpdatedAt", op: "gte", value: "2026-01-01T00:00:00Z" }],
      sort: [{ field: "rowUpdatedAt", dir: "asc" }] };
    expect((await query("post_attachments", extra)).items).toHaveLength(0);
    const changed = structuredClone(fixture); changed.media[0].filename = "reparsed";
    await capture("vault_media", changed, 2); await project();
    expect((await query("post_attachments", extra)).items[0]?.fields).toMatchObject({ filename: "reparsed", postRef: "old-post" });
    expect((await query("raw_media", extra)).items.length).toBeGreaterThan(0);
    expect((await query("vault_media", extra)).items.length).toBeGreaterThan(0);
    // Removing every slot yields no attachment row; the post still signals replacement with an empty set.
    await capture("posts", { posts: [{ id: "old-post", createdAt: date(1).getTime(), content: "caption", attachments: [] }] }, 3); await project();
    expect((await query("posts", extra)).items[0]?.fields.postRef).toBe("old-post");
    expect((await query("post_attachments", extra)).items).toHaveLength(0);
  });

  it("audits retained bodies through a read-only role without disclosing their content", async () => {
    await capture("vault_media", fixture);
    // This is the disposable Testcontainers database, never a production grant.
    await db.pool.query("create role read_only login password 'content-media-test'");
    await db.pool.query("grant usage on schema public to read_only; grant select on all tables in schema public to read_only");
    const connection = new URL(db.connectionString);
    connection.username = "read_only"; connection.password = "content-media-test";
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", "tsx/esm", "scripts/audit-content-media.ts", "--all-bodies"],
      { env: { ...process.env, CONTENT_MEDIA_DATABASE_URL: connection.toString() } });
    const report = JSON.parse(stdout);
    expect(report.monthly).toHaveLength(1);
    expect(report.monthly[0]).toMatchObject({ observations: "1", sampled: 1, readable: 1, unreadable: 0, allBodiesChecked: true,
      shapeRejected: 0, fileRecords: 3, filenames: 3, durations: 1, originalDimensions: 1, frameRates: 1 });
    expect(stdout).not.toContain(fixture.media[0].filename);
    expect(stdout).not.toContain("DO_NOT_COPY");
  });

  it("expands a bundle into two files and two preview roles, preserving unresolved slots", async () => {
    await capture("vault_media", fixture);
    await capture("posts", { posts: [{ id: "post-1", createdAt: date(1).getTime() / 1000, content: "caption",
      fypFlags: 3, inReplyTo: "parent-1", attachments: [
        { pos: 0, contentType: 2, contentId: "bundle-1" },
        { pos: 1, contentType: 1, contentId: "unknown-offer" },
      ] }], accountMedia: [
        { id: "offer-1", mediaId: "file-1", previewId: "preview-1", accountId: "creator-1" },
        { id: "offer-2", mediaId: "file-2", accountId: "creator-1" },
      ], accountMediaBundles: [{ id: "bundle-1", accountId: "creator-1", accountMediaIds: ["offer-1", "offer-2"], previewId: "preview-1" }] });
    await project();
    const result = await query("post_attachments");
    expect(result.items).toHaveLength(5);
    const fields = result.items.map((i) => i.fields);
    expect(fields.filter((f) => f.role === "main" && f.linkState === "resolved").map((f) => f.mediaRef).sort()).toEqual(["file-1", "file-2"]);
    expect(fields.filter((f) => typeof f.role === "string" && f.role.endsWith("preview")).map((f) => f.role).sort()).toEqual(["bundle_preview", "offer_preview"]);
    expect(fields.find((f) => f.contentRef === "unknown-offer")?.linkState).toBe("media_ref_missing");
    expect(result.capture.gaps.some((gap) => gap.kind === "internal_capture_gap")).toBe(true);
    const seen = new Set<string>(); let cursor: unknown;
    do {
      const part = await query("post_attachments", { limit: 2, ...(cursor ? { cursor } : {}) });
      for (const row of part.items) { expect(seen.has(row.key)).toBe(false); seen.add(row.key); }
      cursor = part.delivery.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(5);
    await rebuildMediaPlaneProjection(app(), { accountId: pageId });
    await rebuildCreatorPostsProjection(app(), { accountId: pageId });
    expect((await query("post_attachments")).items.map(row => row.key).sort()).toEqual([...seen].sort());
  });

  it("keeps a newer filename, advances sightings, and marks absence only from a full walk; rebuild is identical", async () => {
    await capture("vault_media", fixture, 1); await project();
    const changed = structuredClone(fixture); changed.media[0].filename = "renamed.mp4";
    changed.albumMedia[0].customFilename = "";
    await capture("vault_media", changed, 3); await project();
    await scan(["file-1"], 4); await project();
    // An old observation appended AFTER the full walk must not clear absence.
    await capture("vault_media", fixture, 2); await project();
    expect((await query("raw_media")).items.find((i) => i.fields.mediaRef === "file-1")!.fields.filename).toBe("renamed.mp4");
    let rows = (await query("vault_media")).items.map((i) => i.fields);
    expect(rows.find((f) => f.mediaRef === "file-2")?.missingSince).toBe("2026-09-04T10:01:00.000Z");
    expect(rows.find((f) => f.mediaRef === "file-1")?.customFilename).toBe("");
    const withoutWriteClock = (items: typeof rows) => items.map(({ rowUpdatedAt: _clock, ...fields }) => fields);
    const before = JSON.stringify(withoutWriteClock(rows));
    await rebuildFanslyCatalogProjection(app(), { accountId: pageId });
    await rebuildMediaPlaneProjection(app(), { accountId: pageId });
    await rebuildCreatorPostsProjection(app(), { accountId: pageId });
    rows = (await query("vault_media")).items.map((i) => i.fields);
    expect(JSON.stringify(withoutWriteClock(rows))).toBe(before);
    await capture("vault_media", fixture, 5); await project();
    expect((await query("vault_media")).items.every((i) => i.fields.missingSince === null)).toBe(true);
    await scan([], 6); await project();
    expect((await query("vault_media")).items.every((i) => i.fields.missingSince !== null)).toBe(true);
  });

  it("preserves OF accepted media ids, rejects overlap as fresh material, and exposes direct file links", async () => {
    // Synthetic media shape, not a claim of a successful live OF Vault crawl.
    const payload = JSON.parse(readFileSync("tests/fixtures/ofapi-posts-page.json", "utf8"));
    payload.data.list[0].media = [{ id: "of-file", type: "video", duration: 12.5, files: { full: { url: "DO_NOT_COPY" } } }];
    payload.data.list[1].media = [{ id: "boundary-file", type: "photo" }];
    const parsed = parseStrictOfapiPostPage(payload, { requiredOverlapId: null, stopAtPostId: "102", acceptStopItem: false });
    expect(parsed.accepted).toBe(true); if (!parsed.accepted) return;
    const model = (await createModel(db.db, { slug: "of", name: "OF" }))!;
    const of = (await createOnlyFansPage(db.db, { modelId: model.id, label: "of-media" }))!;
    const obs = { id: 100, source: "ofapi_capture", producer: "test", accountId: of.id, platform: "onlyfans", kind: "ofapi.posts_page.v1", payload, observedAt: null, receivedAt: date(1) };
    const drafts = buildOnlyFansPostDrafts(obs, parsed.acceptedItems);
    expect(JSON.stringify(drafts)).not.toContain("boundary-file");
    expect(JSON.stringify(drafts)).not.toContain("DO_NOT_COPY");
    await appendProjectionOnlyDomainEvents(db.db, of.id, drafts.map(d => ({ ...d, observationId: obs.id })), {
      observationId: obs.id, occurredAt: date(1), dedupKey: "of-fixture", data: { profile: "creator_posts_v1" },
    });
    await runCreatorPostsProjection(app(), { accountId: of.id }); await runMediaPlaneProjection(app(), { accountId: of.id });
    const files = await db.pool.query("select media_ref, duration_ms, provider_type from creator_raw_media where page_id = $1", [of.id]);
    expect(files.rows).toEqual([{ media_ref: "of-file", duration_ms: 12500n, provider_type: "video" }]);
    const post = await db.pool.query("select attachment_refs from creator_posts where account_id = $1", [of.id]);
    expect(post.rows[0].attachment_refs).toEqual([{ pos: 0, contentType: null, contentId: "of-file" }]);
    await db.pool.query("update agent_keys set page_ids = ARRAY[$1, $2]::bigint[]", [pageId, of.id]);
    const response = await server!.inject({ method: "POST", url: "/api/v1/agent/pages/of-media/datasets/post_attachments/query",
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { from: "2026-01-01T00:00:00Z", to: "2026-10-01T00:00:00Z" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<AgentDatasetQueryResponse>().items.map(item => item.fields)).toEqual([
      expect.objectContaining({ platform: "onlyfans", postRef: "103", role: "main", mediaRef: "of-file", linkState: "resolved" }),
    ]);
  });

  it("replays only the originally accepted OF posts and leaves failed/unsettled captures alone", async () => {
    const model = (await createModel(db.db, { slug: "old-of", name: "OF" }))!;
    const of = (await createOnlyFansPage(db.db, { modelId: model.id, label: "old-of-media" }))!;
    const body = JSON.parse(readFileSync("tests/fixtures/ofapi-posts-page.json", "utf8"));
    body.data.list[0].media = [{ id: "old-file", type: "video" }];
    body.data.list[1].media = [{ id: "must-not-materialize", type: "photo" }];
    const payload = { request: { phase: "verify_head" }, response: { status: 200, headers: {}, bodyEncoding: "utf8", body: JSON.stringify(body) } };
    const inserted = await insertObservation(db.db, { source: "ofapi_capture", producer: "test", platform: "onlyfans", accountId: of.id,
      kind: "ofapi.posts_page.v1", payload, payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: randomUUID(), receivedAt: date(1) });
    const id = inserted.observationId!;
    const original = buildPostObservedDraft({ platform: "onlyfans", observationId: id, postId: "103", textPlain: "new post",
      publishedAt: new Date(body.data.list[0].postedAt), observedAt: date(1), attachmentCount: 1 });
    await appendProjectionOnlyDomainEvents(db.db, of.id, [{ ...original, observationId: id }], {
      observationId: id, occurredAt: date(1), dedupKey: "old-of-checkpoint", data: { profile: "creator_posts_v1" },
    });
    await markObservationParsed(db.db, { observationId: id, receivedAt: date(1), parseVersion: 7 });
    await insertObservation(db.db, { source: "ofapi_capture", producer: "test", platform: "onlyfans", accountId: of.id,
      kind: "ofapi.posts_page.v1", payload, payloadHash: createHash("sha256").update("unsettled").digest(),
      idempotencyKey: randomUUID(), receivedAt: date(2) });
    expect(await runCanonicalization(app(), { kinds: ["ofapi.posts_page.v1"] })).toMatchObject({ scanned: 1, stamped: 1, errored: 0 });
    await runCreatorPostsProjection(app(), { accountId: of.id }); await runMediaPlaneProjection(app(), { accountId: of.id });
    expect((await db.pool.query("select media_ref from creator_raw_media where page_id = $1", [of.id])).rows).toEqual([{ media_ref: "old-file" }]);
    expect((await db.pool.query("select attachment_refs from creator_posts where account_id = $1", [of.id])).rows[0].attachment_refs)
      .toEqual([{ pos: 0, contentType: null, contentId: "old-file" }]);
    expect(await runCanonicalization(app(), { kinds: ["ofapi.posts_page.v1"] })).toMatchObject({ scanned: 0, stamped: 0, errored: 0 });
  });
});
