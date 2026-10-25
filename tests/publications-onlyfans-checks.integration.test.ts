import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicationContentBody } from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage, setPageOfapiAccountId } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { listOfapiActions } from "../apps/runtime/src/services/ofapi-actions.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { runOnlyfansPublishingTick } from "../apps/runtime/src/services/publications-onlyfans.ts";
import { runOnlyfansChecksTick } from "../apps/runtime/src/services/publications-onlyfans-checks.ts";
import { approvePublications, createPublicationDraft } from "../apps/runtime/src/services/publications.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/**
 * Did it go out (plan PR 5a), against a stub OnlyFansAPI: a fresh read 10
 * minutes after the time settles a post as published; an id that turns out
 * to be a schedule id is replaced by the real post's, found by its content;
 * "not published" needs the id read, a complete schedule and the recent posts
 * all to say so, and pages the owner; anything less is unknown; an unknown one
 * is found by reading only. No check ever sends the post again.
 */

const ACCOUNT = "acct_23000000000000000000000000000000";
const MIN = 60_000;
const HOUR = 60 * MIN;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let ownerId = 0;
let created: Array<Record<string, unknown>> = [];
let reads: string[] = [];
let createAnswer: () => Response;
let postById: (id: string) => Response;
let postsList: () => Response;
let queueCounts: () => Response;
let queueList: () => Response;
let storyById: (id: string) => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bodyOf = (init?: RequestInit) => JSON.parse(
  typeof init?.body === "string" ? init.body : Buffer.from(init?.body as Uint8Array).toString("utf8"),
) as Record<string, unknown>;
const notFound = () => json({ error: "Post not found" }, 404);
const emptyCounts = () => json({ data: { list: {}, syncInProcess: false } });

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(() => vi.unstubAllGlobals());

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  app.config.ofapiExpectedTeamSlug = "agency";
  app.config.publishingEnabled = true;
  app.config.publishingOnlyfansEnabled = true;
  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "lora-of" })).id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: ACCOUNT });
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
  for (let ref = 101; ref <= 105; ref += 1) {
    await testDb.pool.query(
      `insert into ofapi_media_catalog (account_id, page_id, media_ref, material_kind, is_ready, has_error, can_view,
                                        metadata, observation_id, observation_received_at)
       values ($1, $2, $3, 'vault', true, false, true, '{}', 1, now())`,
      [ACCOUNT, pageId, String(ref)],
    );
  }
  await testDb.pool.query("insert into page_publishing_settings (page_id, enabled) values ($1, true)", [pageId]);

  created = [];
  reads = [];
  createAnswer = () => json({ data: { id: 700000 + created.length, responseType: "post" } });
  postById = () => notFound();
  postsList = () => json({ data: { list: [], hasMore: false } });
  queueCounts = emptyCounts;
  queueList = () => json({ data: { list: [], syncInProcess: false } });
  storyById = () => notFound();
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    if (path.endsWith("/whoami")) return json({ team: { slug: "agency" } });
    const rest = path.slice(path.indexOf(ACCOUNT) + ACCOUNT.length);
    if (method === "POST" && rest === "/posts") {
      created.push(bodyOf(init));
      return createAnswer();
    }
    if (method === "POST" && rest === "/stories") {
      created.push(bodyOf(init));
      return json({ data: { id: 880001, isReady: false, media: [] } });
    }
    reads.push(`${method} ${rest}`);
    if (method !== "GET") throw new Error(`unexpected OFAPI write ${method} ${path}`);
    if (rest === "/posts") return postsList();
    if (rest.startsWith("/posts/")) return postById(rest.slice("/posts/".length));
    if (rest === "/queue/counts") return queueCounts();
    if (rest === "/queue") return queueList();
    if (rest.startsWith("/stories/")) return storyById(rest.slice("/stories/".length));
    if (rest === "/stories") return json({ data: [] });
    throw new Error(`unexpected OFAPI request ${method} ${path}`);
  }));
  app.ofapi = createOfapiClient({ apiKey: "synthetic-key", restDelayMs: 0, ...ofapiCredentialPolicy(app.db, app.config, app.logger) });
});

function body(overrides: Partial<PublicationContentBody> = {}): PublicationContentBody {
  return {
    kind: "subscriber_post", text: "new set", media: [{ source: "vault", mediaRef: "101" }], previews: [],
    publishAt: new Date(Date.now() + 3 * MIN).toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null,
    repost: false, pinWallRefs: [], replyLock: [], subscribersOnly: false, ...overrides,
  };
}

/** Approved and sent: the publication is "scheduled" (or what the create's answer made it). */
async function sent(overrides: Partial<PublicationContentBody> = {}) {
  const content = body(overrides);
  const draft = await createPublicationDraft(app.db, { pageId, body: content, author: { kind: "human", userId: ownerId }, idempotencyKey: null });
  const [result] = await approvePublications(app.db, { items: [{ id: draft.id, version: draft.version }], userId: ownerId });
  expect(result?.outcome, JSON.stringify(result)).toBe("approved");
  await runOnlyfansPublishingTick(app);
  return { id: draft.id, publishAt: new Date(content.publishAt) };
}

async function statusOf(id: number) {
  const row = await testDb!.pool.query<{ status: string; platform_post_ref: string | null; status_reason: string | null }>(
    "select status, platform_post_ref, status_reason from publications where id = $1", [id],
  );
  return row.rows[0];
}

async function checksOf(id: number) {
  const rows = await testDb!.pool.query<{ kind: string; outcome: string; reason: string | null; evidence: Record<string, unknown> }>(
    "select kind, outcome, reason, evidence from publication_checks where publication_id = $1 order by id", [id],
  );
  return rows.rows;
}

const postAt = (id: number, publishAt: Date, extra: Record<string, unknown> = {}) => ({
  responseType: "post", id, postedAt: publishAt.toISOString(), rawText: "new set", text: "<p>new set</p>", media: [{ id: 101 }], ...extra,
});

describe("did the OnlyFans post go out", () => {
  it("nothing is read before 10 minutes after its time; then the id read settles it as published, once", async () => {
    const { id, publishAt } = await sent();
    expect(await statusOf(id)).toMatchObject({ status: "scheduled", platform_post_ref: "700001" });
    postById = (ref) => json({ data: postAt(Number(ref), publishAt) });

    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + 5 * MIN));
    expect(reads).toEqual([]);

    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + 11 * MIN));
    expect(reads).toEqual(["GET /posts/700001"]);
    expect(await statusOf(id)).toMatchObject({ status: "published", platform_post_ref: "700001", status_reason: "read_by_id" });
    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + 30 * MIN));
    expect(reads).toHaveLength(1);
    expect(created).toHaveLength(1);
    // Hub's own reads stay off the owner's action list; its sends stay on it.
    expect((await listOfapiActions(app, pageId)).intents.map((intent) => intent.action)).toEqual(["post_create"]);
  });

  it("the create's id was a schedule id: the real post is found by its content and its id recorded", async () => {
    const { id, publishAt } = await sent();
    postById = () => notFound();
    postsList = () => json({ data: { list: [postAt(990001, publishAt), postAt(990000, new Date(publishAt.getTime() - HOUR), { rawText: "older" })], hasMore: false } });

    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + 11 * MIN));
    expect(reads).toEqual(["GET /posts/700001", "GET /queue/counts", "GET /posts"]);
    expect(await statusOf(id)).toMatchObject({ status: "published", platform_post_ref: "990001", status_reason: "matched_by_content" });
    const [check] = await checksOf(id);
    expect(check).toMatchObject({ kind: "verify", outcome: "published", evidence: expect.objectContaining({ createRef: "700001", postRef: "990001" }) });
  });

  it("absent by id, from a complete schedule and from the recent posts: not published, and the owner is paged", async () => {
    const { id, publishAt } = await sent();
    postsList = () => json({ data: { list: [postAt(990000, new Date(publishAt.getTime() - HOUR), { rawText: "older" })], hasMore: false } });

    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + 11 * MIN));
    expect(await statusOf(id)).toMatchObject({ status: "not_published", status_reason: "absent_by_id_schedule_and_posts" });
    const incidents = await testDb!.pool.query("select kind::text as kind, status::text as status from notification_incidents");
    expect(incidents.rows).toEqual([{ kind: "publication_not_published", status: "open" }]);
    expect(created).toHaveLength(1);
  });

  it("a schedule still syncing proves nothing: unknown, not 'not published'", async () => {
    const { id, publishAt } = await sent();
    queueCounts = () => json({ data: { list: {}, syncInProcess: true } });

    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + 11 * MIN));
    expect(await statusOf(id)).toMatchObject({ status: "unknown", status_reason: "schedule_incomplete:sync_in_process" });
    const incidents = await testDb!.pool.query("select count(*)::int as n from notification_incidents");
    expect(incidents.rows[0].n).toBe(0);
  });

  it("a post still in the schedule after its time, or a post that could be it, is unknown", async () => {
    const first = await sent();
    queueCounts = () => json({ data: { list: { [first.publishAt.toISOString().slice(0, 10)]: { post: 1 } }, syncInProcess: false } });
    queueList = () => json({ data: { list: [{ id: 55, type: "post", publishDateTime: first.publishAt.toISOString(), entity: postAt(700001, first.publishAt) }], syncInProcess: false } });
    await runOnlyfansChecksTick(app, new Date(first.publishAt.getTime() + 11 * MIN));
    expect(await statusOf(first.id)).toMatchObject({ status: "unknown", status_reason: "still_in_schedule" });

    queueCounts = emptyCounts;
    const second = await sent({ media: [{ source: "vault", mediaRef: "102" }], publishAt: new Date(Date.now() + 4 * MIN).toISOString() });
    // A post at the time with one file and another caption, its media ids not given: it could be this one.
    postsList = () => json({ data: { list: [{ responseType: "post", id: 990002, postedAt: second.publishAt.toISOString(), rawText: "reworded", mediaCount: 1 }], hasMore: false } });
    await runOnlyfansChecksTick(app, new Date(second.publishAt.getTime() + 11 * MIN));
    expect(await statusOf(second.id)).toMatchObject({ status: "unknown", status_reason: "posts_could_be_unproven" });
  });

  it("failed reads are tried again later and never send anything; the post stays scheduled meanwhile", async () => {
    const { id, publishAt } = await sent();
    postById = () => json({ error: "upstream" }, 502);
    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + 11 * MIN));
    expect(await statusOf(id)).toMatchObject({ status: "scheduled" });
    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + 15 * MIN));
    expect(reads).toHaveLength(1);
    postById = (ref) => json({ data: postAt(Number(ref), publishAt) });
    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + 22 * MIN));
    expect(await statusOf(id)).toMatchObject({ status: "published" });
    expect((await checksOf(id)).map((check) => check.outcome)).toEqual(["read_failed", "published"]);
    expect(created).toHaveLength(1);
  });
});

describe("an unknown publication is found by reading only", () => {
  it("a lost create answer: the post is found in OnlyFans' schedule by its content and is scheduled again", async () => {
    createAnswer = () => json({ error: "upstream" }, 502);
    const { id, publishAt } = await sent({ publishAt: new Date(Date.now() + 2 * HOUR).toISOString() });
    expect(await statusOf(id)).toMatchObject({ status: "unknown", platform_post_ref: null });
    const day = publishAt.toISOString().slice(0, 10);
    queueCounts = () => json({ data: { list: { [day]: { post: 1 } }, syncInProcess: false } });
    queueList = () => json({ data: { list: [{ id: 56, type: "post", publishDateTime: publishAt.toISOString(), entity: postAt(990003, publishAt) }], syncInProcess: false } });

    await runOnlyfansChecksTick(app, new Date(Date.now() + 5 * MIN));
    expect(reads).toEqual([]);
    await runOnlyfansChecksTick(app, new Date(Date.now() + 11 * MIN));
    expect(await statusOf(id)).toMatchObject({ status: "scheduled", platform_post_ref: "990003", status_reason: "found_in_schedule" });
    expect(created).toHaveLength(1);
  });

  it("not found stays unknown: Hub never decides 'it did not go out' by itself", async () => {
    createAnswer = () => json({ error: "upstream" }, 502);
    const { id } = await sent({ publishAt: new Date(Date.now() + 2 * HOUR).toISOString() });
    await runOnlyfansChecksTick(app, new Date(Date.now() + 11 * MIN));
    expect(await statusOf(id)).toMatchObject({ status: "unknown" });
    expect((await checksOf(id)).map((check) => check.outcome)).toEqual(["not_found"]);
    expect(created).toHaveLength(1);
  });
});

describe("an OnlyFans story", () => {
  it("still preparing at the send is read at +1 h and goes published when ready", async () => {
    const { id, publishAt } = await sent({ kind: "story", text: "", publishAt: new Date(Date.now() + 2 * MIN).toISOString() });
    await runOnlyfansPublishingTick(app, new Date(publishAt.getTime() + MIN));
    expect(await statusOf(id)).toMatchObject({ status: "processing", platform_post_ref: "880001" });
    storyById = (ref) => json({ data: { id: Number(ref), isReady: true, media: [{ id: 101 }], createdAt: publishAt.toISOString() } });

    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + 30 * MIN));
    expect(reads).toEqual([]);
    await runOnlyfansChecksTick(app, new Date(publishAt.getTime() + HOUR + MIN));
    expect(reads).toEqual(["GET /stories/880001"]);
    expect(await statusOf(id)).toMatchObject({ status: "published", status_reason: "read_by_id" });
  });
});
