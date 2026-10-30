import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertAgentKey,
  readPublicationDayVolume,
  type Database,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { verifyApprovedPublication } from "../apps/runtime/src/services/publications.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * Publications over HTTP (docs/plans/2026-10-23-wall-posts, plan PR 1 "Готово"):
 * an agent drafts through its key, the owner approves a batch, an edit after
 * approval returns the publication to draft, and a price outside the page's
 * range, another model's file and a second copy of a file in the same batch
 * are not approved. Also: who may call what, the agent's replay, the check
 * before a send, and the person's answer to "unknown".
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT = `${AGENT_KEY_TOKEN_PREFIX}publications-drafts`;
const READER = `${AGENT_KEY_TOKEN_PREFIX}publications-reader`;
/** A second drafting key on the same page: its publications are not the first's. */
const OTHER_AGENT = `${AGENT_KEY_TOKEN_PREFIX}publications-other`;
/** ContentOps' key: exactly its scopes (owner 2026-10-29). */
const CONTENTOPS = `${AGENT_KEY_TOKEN_PREFIX}publications-contentops`;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("a small picture, not a real one")]);
const HASH = "a".repeat(64);

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
let leadCookie = "";
let lillyPageId = 0;
let loraPageId = 0;
let lillyFileId = 0;
let loraFileId = 0;
let filesRoot = "";

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

async function login(username: string, password: string) {
  const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(raw ?? "").split(";")[0] ?? "";
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb);
  filesRoot = await mkdtemp(path.join(tmpdir(), "publications-files-"));
  appContext.config.publicationFilesDir = filesRoot;

  const lilly = await createModel(db(), { slug: "lilly", name: "Lilly" });
  const lora = await createModel(db(), { slug: "lora", name: "Lora" });
  lillyPageId = (await createFanslyPage(db(), { modelId: lilly.id, label: "lilly-1" })).id;
  loraPageId = (await createOnlyFansPage(db(), { modelId: lora.id, label: "lora-of" })).id;
  await sql("update pages set username = 'lora' where id = $1", [loraPageId]);

  await sql(
    `insert into page_walls (page_id, platform, wall_ref, name, default_wall, main_wall, first_observed_at, last_observed_at,
                             content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'wall-main', 'Main', true, true, now(), now(), $2, 1, 1, 1)`,
    [lillyPageId, HASH],
  );
  for (const ref of ["m1", "m2", "m3"]) {
    await sql(
      `insert into creator_raw_media (page_id, platform, media_ref, source_kind, first_origin, first_observed_at,
                                      last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', $2, 'vault_media', 'vault', now(), now(), $3, 1, 1, 1)`,
      [lillyPageId, ref, HASH],
    );
  }
  lillyFileId = Number((await sql(
    "insert into publication_files (model_id, content_sha256, byte_size) values ($1, $2, 100) returning id",
    [lilly.id, "1".repeat(64)],
  )).rows[0].id);
  loraFileId = Number((await sql(
    "insert into publication_files (model_id, content_sha256, byte_size) values ($1, $2, 100) returning id",
    [lora.id, "2".repeat(64)],
  )).rows[0].id);

  const owner = await createUserAccount(appContext, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  await createUserAccount(appContext, { username: "lead", role: "team_lead", password: "lead-secret" }, { source: "cli" });
  for (const [token, name, capabilities] of [
    [AGENT, "publications-drafts", ["write:publication_drafts"]],
    [READER, "publications-reader", ["read:datasets"]],
    [OTHER_AGENT, "publications-other", ["write:publication_drafts"]],
    [CONTENTOPS, "publications-contentops", ["read:content", "write:publication_drafts", "approve:publications"]],
  ] as const) {
    await insertAgentKey(testDb.db, {
      name,
      keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(token),
      capabilities: [...capabilities] as never,
      pageIds: [lillyPageId],
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      createdBy: owner?.id ?? 0,
    });
  }

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
  ownerCookie = await login("owner", "owner-secret");
  leadCookie = await login("lead", "lead-secret");
  expect(ownerCookie).not.toBe("");
});

afterEach(async () => {
  await server?.close();
  server = null;
  if (filesRoot !== "") await rm(filesRoot, { recursive: true, force: true });
});

const tomorrow = (hours = 0) => new Date(Date.now() + DAY_MS + hours * 3_600_000).toISOString();

function draft(overrides: Record<string, unknown> = {}) {
  return {
    kind: "fyp_post",
    text: "new post",
    media: [{ source: "vault", mediaRef: "m1" }],
    publishAt: tomorrow(),
    ...overrides,
  };
}

function owner(method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) {
  return server!.inject({ method, url, headers: { cookie: ownerCookie }, ...(payload ? { payload } : {}) });
}

function agent(method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>, token = AGENT) {
  return server!.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}

async function ownerDraft(overrides: Record<string, unknown> = {}) {
  const response = await owner("POST", "/api/v1/admin/publications", { pageLabel: "lilly-1", ...draft(overrides) });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { id: number; version: number; status: string; findings: Array<{ code: string }> };
}

describe("publications: an agent drafts, a person approves", () => {
  it("the agent drafts through its key; the owner approves a batch; an edit returns it to draft", async () => {
    const created = await agent("POST", "/api/v1/agent/pages/lilly-1/publications", { ...draft(), idempotencyKey: "post-1" });
    expect(created.statusCode, created.body).toBe(200);
    const first = created.json();
    expect(first).toMatchObject({ status: "draft", author: { kind: "agent" }, wallRefs: ["wall-main"], blocked: false });

    const second = await ownerDraft({ media: [{ source: "vault", mediaRef: "m2" }], publishAt: tomorrow(2) });
    const approved = await owner("POST", "/api/v1/admin/publications/approve", {
      items: [{ id: first.id, version: first.version }, { id: second.id, version: second.version }],
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().results.map((result: { outcome: string }) => result.outcome)).toEqual(["approved", "approved"]);
    const revisions = await sql("select count(*)::int as n from publication_revisions");
    expect(revisions.rows[0].n).toBe(2);

    // The agent edits what it drafted: back to draft, the approval dropped.
    const edited = await agent("PUT", `/api/v1/agent/publications/${first.id}`, { ...draft({ text: "edited" }), version: first.version });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ status: "draft", approvedRevisionId: null, text: "edited" });
    const detail = (await owner("GET", `/api/v1/admin/publications/${first.id}`)).json();
    expect(detail.events.map((event: { toStatus: string; actorKind: string }) => `${event.toStatus}:${event.actorKind}`))
      .toEqual(["draft:agent", "approved:human", "draft:agent"]);

    // An agent cannot approve: the owner's route refuses its key.
    const byAgent = await agent("POST", "/api/v1/admin/publications/approve", { items: [{ id: first.id, version: 2 }] });
    expect(byAgent.statusCode).toBe(403);
  });

  it("a price outside the range, another model's file and a second copy in one batch are not approved", async () => {
    const settings = await owner("PUT", "/api/v1/admin/publications/settings/lilly-1", {
      enabled: false, paidPriceMinMills: 5_000, paidPriceMaxMills: 30_000, repostThresholdDays: 30, dailyLimit: null,
    });
    expect(settings.statusCode, settings.body).toBe(200);

    const pricey = await ownerDraft({ kind: "paid_post", priceMills: 45_000, media: [{ source: "vault", mediaRef: "m3" }] });
    expect(pricey.findings.map((finding) => finding.code)).toContain("price_out_of_range");
    const foreign = await ownerDraft({ media: [{ source: "file", fileId: loraFileId }] });
    expect(foreign.findings.map((finding) => finding.code)).toContain("file_of_another_model");
    const own = await ownerDraft({ media: [{ source: "file", fileId: lillyFileId }], publishAt: tomorrow(1) });
    const copyA = await ownerDraft({ media: [{ source: "vault", mediaRef: "m1" }], publishAt: tomorrow(3) });
    const copyB = await ownerDraft({ media: [{ source: "vault", mediaRef: "m1" }], publishAt: tomorrow(5) });

    const response = await owner("POST", "/api/v1/admin/publications/approve", {
      items: [pricey, foreign, own, copyA, copyB].map((item) => ({ id: item.id, version: item.version })),
    });
    const results = response.json().results as Array<{ outcome: string; reason: string | null; publication: { findings: Array<{ code: string }> } }>;
    expect(results.map((result) => `${result.outcome}:${result.reason}`)).toEqual([
      "refused:blocking_findings",
      "refused:blocking_findings",
      // The model's own new file: the page's browser uploads it (plan PR 8).
      "approved:null",
      "approved:null",
      "refused:blocking_findings",
    ]);
    expect(results[2]?.publication.findings.map((finding) => finding.code)).toEqual([]);
    expect(results[4]?.publication.findings.map((finding) => finding.code)).toContain("repost_within_threshold");

    // Marked as a repost, the second copy passes with a warning.
    const repost = await owner("PUT", `/api/v1/admin/publications/${copyB.id}`, {
      ...draft({ media: [{ source: "vault", mediaRef: "m1" }], publishAt: tomorrow(5), repost: true }), version: copyB.version,
    });
    const again = await owner("POST", "/api/v1/admin/publications/approve", { items: [{ id: copyB.id, version: repost.json().version }] });
    expect(again.json().results[0]).toMatchObject({ outcome: "approved" });

    // A stale version is refused without touching the row.
    const stale = await owner("POST", "/api/v1/admin/publications/approve", { items: [{ id: pricey.id, version: pricey.version + 5 }] });
    expect(stale.json().results[0]).toMatchObject({ outcome: "refused", reason: "version_conflict" });
  });

  it("the agent's replay answers the same draft; another body under the same key is a 409", async () => {
    const replayed = { ...draft(), idempotencyKey: "k-1" };
    const one = await agent("POST", "/api/v1/agent/pages/lilly-1/publications", replayed);
    const two = await agent("POST", "/api/v1/agent/pages/lilly-1/publications", replayed);
    expect([one.statusCode, two.statusCode], two.body).toEqual([200, 200]);
    expect(two.json().id).toBe(one.json().id);
    const other = await agent("POST", "/api/v1/agent/pages/lilly-1/publications", { ...replayed, text: "other" });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe("idempotency_mismatch");
  });
});

describe("publications: who may call what", () => {
  it("a key without the capability is 403, a page outside the grant 404, a team lead's session 403", async () => {
    const reader = await agent("POST", "/api/v1/agent/pages/lilly-1/publications", { ...draft(), idempotencyKey: "r-1" }, READER);
    expect(reader.statusCode).toBe(403);
    const outside = await agent("POST", "/api/v1/agent/pages/lora-of/publications", { ...draft({ kind: "subscriber_post" }), idempotencyKey: "o-1" });
    expect(outside.statusCode).toBe(404);
    const lead = await server!.inject({ method: "GET", url: "/api/v1/admin/publications", headers: { cookie: leadCookie } });
    expect(lead.statusCode).toBe(403);
    const list = await agent("GET", "/api/v1/agent/pages/lilly-1/publications");
    expect(list.statusCode, list.body).toBe(200);
  });
});

describe("publications: before a send and after an unknown outcome", () => {
  it("a changed binding returns an approved publication to draft", async () => {
    const created = await ownerDraft();
    await owner("POST", "/api/v1/admin/publications/approve", { items: [{ id: created.id, version: created.version }] });
    expect(await verifyApprovedPublication(db(), created.id)).toMatchObject({ ok: true });

    await sql("update pages set ofapi_binding_generation = ofapi_binding_generation + 1 where id = $1", [lillyPageId]);
    expect(await verifyApprovedPublication(db(), created.id)).toEqual({ ok: false, reason: "account_changed" });
    const after = (await owner("GET", `/api/v1/admin/publications/${created.id}`)).json();
    expect(after).toMatchObject({ status: "draft", statusReason: "account_changed", approvedRevisionId: null });
    expect(after.events.at(-1)).toMatchObject({ toStatus: "draft", actorKind: "hub" });
  });

  it("'it did not go out' closes the publication and drafts a linked replacement", async () => {
    const created = await ownerDraft();
    await owner("POST", "/api/v1/admin/publications/approve", { items: [{ id: created.id, version: created.version }] });
    // The sender's half (approved → submitting → unknown) arrives with PR 4b / PR 6.
    await sql("update publications set status = 'unknown' where id = $1", [created.id]);

    const answered = await owner("POST", `/api/v1/admin/publications/${created.id}/resolve`, { outcome: "did_not_go_out" });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json().publication).toMatchObject({ status: "not_published" });
    expect(answered.json().replacement).toMatchObject({ status: "draft", previousPublicationId: created.id });

    const again = await owner("POST", `/api/v1/admin/publications/${created.id}/resolve`, { outcome: "did_not_go_out" });
    expect(again.statusCode).toBe(409);
  });
});

describe("publications: the usual day counts the page's own posts", () => {
  it("promotions naming other accounts are not the page's volume", async () => {
    const day = new Date("2026-09-15T12:00:00Z");
    for (let index = 0; index < 12; index += 1) {
      const own = index < 2;
      await sql(
        `insert into creator_posts (account_id, platform, platform_post_id, text_plain, published_at, first_observed_at,
                                    last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
         values ($1, 'onlyfans', $2, $3, $4, now(), now(), $5, 1, 1, 1)`,
        [loraPageId, `post-${index}`, own ? "my new set @lora" : `FREE @someone_${index} go follow`,
          new Date(day.getTime() + index * 60_000), HASH],
      );
    }
    const volume = await readPublicationDayVolume(db(), {
      pageId: loraPageId, excludePublicationId: null, publishAt: day, now: new Date("2026-09-20T00:00:00Z"),
    });
    expect(volume.dayCount).toBe(2);
    expect(volume.usualPerDay).toBeCloseTo(2 / 30);
  });
});

async function agentDraft(key: string, token = AGENT, overrides: Record<string, unknown> = {}) {
  const response = await agent("POST", "/api/v1/agent/pages/lilly-1/publications", { ...draft(overrides), idempotencyKey: key }, token);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { id: number; version: number; status: string; updatedAt: string };
}

type Changes = { publications: Array<{ id: number; status: string; platformPostRef: string | null; updatedAt: string }>; nextCursor: string | null };

async function dbNow(): Promise<string> {
  return new Date((await sql("select now() as t")).rows[0].t).toISOString();
}

describe("publications: the agent's own changes since a time", () => {
  it("lists only this key's publications on its pages, oldest change first, and the cursor neither repeats nor skips", async () => {
    const first = await agentDraft("c-1");
    const second = await agentDraft("c-2", AGENT, { media: [{ source: "vault", mediaRef: "m2" }] });
    const third = await agentDraft("c-3", AGENT, { media: [{ source: "vault", mediaRef: "m3" }] });
    await agentDraft("other-1", OTHER_AGENT);
    await ownerDraft();
    // Approved, so Hub's sender may take it later (below, by hand).
    const approval = await owner("POST", "/api/v1/admin/publications/approve", { items: [{ id: third.id, version: third.version }] });
    expect(approval.json().results[0].outcome).toBe("approved");

    const page1 = (await agent("GET", "/api/v1/agent/publications/changes?limit=2")).json() as Changes;
    expect(page1.publications.map((publication) => publication.id)).toEqual([first.id, second.id]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await agent("GET", `/api/v1/agent/publications/changes?cursor=${page1.nextCursor}`)).json() as Changes;
    expect(page2.publications.map((publication) => publication.id)).toEqual([third.id]);
    expect(page2.nextCursor).toBeNull();
    // The cursor pins the listing.
    const both = await agent("GET", `/api/v1/agent/publications/changes?since=${encodeURIComponent(first.updatedAt)}&cursor=${page1.nextCursor}`);
    expect(both.statusCode).toBe(400);

    // What changed after a time: a status, its reason and the platform's post.
    const since = await dbNow();
    await sql(
      "update publications set status = 'published', platform_post_ref = 'post-77', status_changed_at = now(), updated_at = now() where id = $1",
      [third.id],
    );
    expect((await agent("POST", `/api/v1/agent/publications/${second.id}/cancel`)).statusCode).toBe(200);
    const changed = (await agent("GET", `/api/v1/agent/publications/changes?since=${encodeURIComponent(since)}`)).json() as Changes;
    expect(changed.publications.map(({ id, status, platformPostRef }) => ({ id, status, platformPostRef }))).toEqual([
      { id: third.id, status: "published", platformPostRef: "post-77" },
      { id: second.id, status: "cancelled", platformPostRef: null },
    ]);

    // Without write:publication_drafts it is the plane's 403.
    expect((await agent("GET", "/api/v1/agent/publications/changes", undefined, READER)).statusCode).toBe(403);
  });
});

describe("publications: the agent cancels its own before Hub hands it to the platform", () => {
  it("cancels its draft or approved publication, answers a cancelled one as it is, and refuses the rest", async () => {
    const drafted = await agentDraft("x-1");
    const cancelled = await agent("POST", `/api/v1/agent/publications/${drafted.id}/cancel`);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
    // A retry after a lost answer is safe.
    const again = await agent("POST", `/api/v1/agent/publications/${drafted.id}/cancel`);
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe("cancelled");
    const journal = (await agent("GET", `/api/v1/agent/publications/${drafted.id}`)).json() as { events: Array<{ toStatus: string; actorKind: string }> };
    expect(journal.events.at(-1)).toMatchObject({ toStatus: "cancelled", actorKind: "agent" });

    // Approved by the owner, not yet handed to the platform: still the agent's to cancel.
    const approved = await agentDraft("x-2", AGENT, { media: [{ source: "vault", mediaRef: "m2" }] });
    const approval = await owner("POST", "/api/v1/admin/publications/approve", { items: [{ id: approved.id, version: approved.version }] });
    expect(approval.json().results[0].outcome).toBe("approved");
    const approvedCancel = await agent("POST", `/api/v1/agent/publications/${approved.id}/cancel`);
    expect(approvedCancel.statusCode, approvedCancel.body).toBe(200);
    expect(approvedCancel.json().status).toBe("cancelled");

    // Handed to the platform: the owner's, in Hub.
    const scheduled = await agentDraft("x-3", AGENT, { media: [{ source: "vault", mediaRef: "m3" }] });
    const handed = await owner("POST", "/api/v1/admin/publications/approve", { items: [{ id: scheduled.id, version: scheduled.version }] });
    expect(handed.json().results[0].outcome).toBe("approved");
    await sql("update publications set status = 'scheduled', updated_at = now() where id = $1", [scheduled.id]);
    const late = await agent("POST", `/api/v1/agent/publications/${scheduled.id}/cancel`);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("publication_handed_to_platform");

    // Someone else's publication is not this key's to cancel.
    const others = await agentDraft("x-4", OTHER_AGENT);
    const foreign = await agent("POST", `/api/v1/agent/publications/${others.id}/cancel`);
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json().error).toBe("publication_not_editable");
    const human = await ownerDraft();
    expect((await agent("POST", `/api/v1/agent/publications/${human.id}/cancel`)).statusCode).toBe(409);
    // A publication outside the grant does not exist for the key.
    const onLora = await owner("POST", "/api/v1/admin/publications", {
      pageLabel: "lora-of", kind: "subscriber_post", text: "post", media: [{ source: "file", fileId: loraFileId }], publishAt: tomorrow(),
    });
    expect(onLora.statusCode, onLora.body).toBe(200);
    expect((await agent("POST", `/api/v1/agent/publications/${onLora.json().id}/cancel`)).statusCode).toBe(404);
    expect((await agent("POST", `/api/v1/agent/publications/${drafted.id}/cancel`, undefined, READER)).statusCode).toBe(403);
  });
});

describe("publications: the ContentOps key with exactly its scopes", () => {
  it("reads the page's posts, uploads a file once by its SHA-256, drafts with Hub's checks, approves, follows and cancels", async () => {
    // read:content alone reads the page's own material.
    const posts = await agent("POST", "/api/v1/agent/pages/lilly-1/datasets/posts/query", {
      from: "2026-01-01T00:00:00Z", to: "2026-12-01T00:00:00Z",
    }, CONTENTOPS);
    expect(posts.statusCode, posts.body).toBe(200);

    const upload = (name: string) => server!.inject({
      method: "POST",
      url: `/api/v1/agent/pages/lilly-1/publication-files?name=${encodeURIComponent(name)}`,
      headers: { authorization: `Bearer ${CONTENTOPS}`, "content-type": "application/octet-stream" },
      payload: JPEG,
    });
    const uploaded = await upload("lilly-ppv-0042-platform.jpg");
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const file = uploaded.json() as { created: boolean; file: { id: number; sha256: string } };
    expect(file.created).toBe(true);
    expect(file.file.sha256).toBe(createHash("sha256").update(JPEG).digest("hex"));
    const replay = (await upload("lilly-ppv-0042-platform.jpg")).json() as typeof file;
    expect(replay).toMatchObject({ created: false, file: { id: file.file.id } });

    // The plan row's fields: caption, a tier of the audience, a file and a vault file.
    const body = {
      kind: "subscriber_post",
      text: "caption from the plan",
      media: [{ source: "file", fileId: file.file.id }, { source: "vault", mediaRef: "m1" }],
      tierRefs: ["tier-missing"],
      repost: false,
      publishAt: tomorrow(2),
    };
    const drafted = await agent("POST", "/api/v1/agent/pages/lilly-1/publications", { ...body, idempotencyKey: "plan-row-1" }, CONTENTOPS);
    expect(drafted.statusCode, drafted.body).toBe(200);
    const draftWire = drafted.json() as { id: number; version: number; blocked: boolean; findings: Array<{ code: string }> };
    expect(draftWire.findings.map((finding) => finding.code)).toContain("tier_not_on_page");
    expect(draftWire.blocked).toBe(true);
    const refused = await agent("POST", "/api/v1/agent/publications/approve", { items: [{ id: draftWire.id, version: draftWire.version }] }, CONTENTOPS);
    expect(refused.json().results[0]).toMatchObject({ outcome: "refused", reason: "blocking_findings" });

    const edited = await agent("PUT", `/api/v1/agent/publications/${draftWire.id}`, { ...body, tierRefs: [], version: draftWire.version }, CONTENTOPS);
    expect(edited.statusCode, edited.body).toBe(200);
    const editedWire = edited.json() as { version: number; blocked: boolean };
    expect(editedWire.blocked).toBe(false);
    const approved = await agent("POST", "/api/v1/agent/publications/approve", { items: [{ id: draftWire.id, version: editedWire.version }] }, CONTENTOPS);
    expect(approved.json().results[0]).toMatchObject({ outcome: "approved" });

    // A vault album: its text is the album's name.
    const album = await agent("POST", "/api/v1/agent/pages/lilly-1/publications", {
      kind: "vault_album", text: "PPV", media: [{ source: "file", fileId: file.file.id }], publishAt: tomorrow(3), idempotencyKey: "plan-row-2",
    }, CONTENTOPS);
    expect(album.statusCode, album.body).toBe(200);

    const changes = (await agent("GET", "/api/v1/agent/publications/changes", undefined, CONTENTOPS)).json() as Changes;
    expect(changes.publications.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: draftWire.id, status: "approved" },
      { id: album.json().id, status: "draft" },
    ]);
    const cancel = await agent("POST", `/api/v1/agent/publications/${draftWire.id}/cancel`, undefined, CONTENTOPS);
    expect(cancel.json().status).toBe("cancelled");

    // And nothing of the conversations.
    expect((await agent("POST", "/api/v1/agent/pages/lilly-1/datasets/dm_threads/query", {
      from: "2026-01-01T00:00:00Z", to: "2026-12-01T00:00:00Z",
    }, CONTENTOPS)).statusCode).toBe(403);
  });
});
