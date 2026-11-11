import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicationContentBody } from "@agency_hub_core/contracts";
import {
  admitFanslyWriteCommand,
  fanslyScheduleReadWanted,
  insertAgentKey,
  savePublicationQueueSnapshot,
  settleFanslyWriteCommand,
  type Database,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { runFanslyPublishingTick } from "../apps/runtime/src/services/publications-fansly.ts";
import {
  followFanslyWithdrawals,
  withdrawAllFanslyPublications,
  withdrawFanslyPublications,
} from "../apps/runtime/src/services/publications-fansly-withdraw.ts";
import { approvePublications, createPublicationDraft, getPublicationDetail, replaceWithdrawnPublication } from "../apps/runtime/src/services/publications.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * Withdrawal of a Fansly post from its schedule (plan PR 9, spec §8.2, §8.4):
 * refused without a request when too close to its time, when the page is
 * stopped, or while the cancel route is unverified; otherwise one cancel
 * command, queued once, a fresh read of the schedule asked for; "Снят" only by
 * a complete read after Fansly's answer — never before the stand confirms the
 * list is whole; a lost answer "Неизвестно"; works while publishing is off;
 * a replacement only for a withdrawn post. And the same withdrawal by an
 * agent key with withdraw:publications (owner 2026-11-11): any Hub post of its
 * pages, the owner's refusals, the owner's audit naming the key, the plane's
 * 403 and static 404; and the page's schedule as the owner reads it.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HASH = "f".repeat(64);
const VERIFIED = { scheduleListWhole: true, scheduledPostKeepsId: true, storyListRead: true, immediatePost: false };

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let ownerId = 0;
let attemptId = 9000;
const isSendable = () => true;

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
  app.config.publishingEnabled = true;
  ({ pageId } = await seedSyncPage({ db: app.db as unknown as Database, pool: testDb.pool }, { label: "lilly-1", mode: "live", guard: "fansly_sync_engine" }));
  await sql("update sync_pages set transport = 'browser' where page_id = $1", [pageId]);
  await sql(
    `insert into page_walls (page_id, platform, wall_ref, name, default_wall, main_wall, first_observed_at, last_observed_at,
                             content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'wall-main', 'Main', true, true, now(), now(), $2, 1, 1, 1)`,
    [pageId, HASH],
  );
  await sql("insert into page_publishing_settings (page_id, enabled) values ($1, true)", [pageId]);
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
});

async function settleCommand(id: string | number, to: "answered" | "rejected" | "unknown", result: Record<string, unknown> | null, reason: string | null = null) {
  attemptId += 1;
  expect(await admitFanslyWriteCommand(app.db, {
    id: Number(id), attemptId, workId: 1,
    request: { spec: "publish.post", method: "POST", host: "api", pathAndQuery: "/api/v1/post", body: "{}", fingerprint: "e".repeat(64) },
  })).toBe(true);
  expect(await settleFanslyWriteCommand(app.db, { id: Number(id), attemptId, to, reason, result })).toBe(true);
}

/** A text post's body, `days` ahead. */
function textPost(postRef: string, days: number): PublicationContentBody {
  return {
    kind: "fyp_post", text: `post ${postRef}`, media: [], previews: [],
    publishAt: new Date(Date.now() + days * DAY).toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null, repost: false, pinWallRefs: [], replyLock: [], subscribersOnly: false, extraAttachments: [],
  };
}

/** A text post Hub put in Fansly's schedule as `postRef`, `days` ahead. */
async function scheduledPost(postRef: string, days = 2): Promise<number> {
  const body = textPost(postRef, days);
  const draft = await createPublicationDraft(app.db, { pageId, body, author: { kind: "human", userId: ownerId }, idempotencyKey: null });
  const [approved] = await approvePublications(app.db, { items: [{ id: draft.id, version: draft.version }], userId: ownerId });
  expect(approved?.outcome).toBe("approved");
  await runFanslyPublishingTick(app, { isSendable });
  const [queued] = await sql<{ id: string }>("select id::text from fansly_write_commands where publication_id = $1 and state = 'queued'", [draft.id]);
  await settleCommand(queued!.id, "answered", { postId: postRef });
  await runFanslyPublishingTick(app, { isSendable });
  expect((await sql("select status from publications where id = $1", [draft.id]))[0]).toEqual({ status: "scheduled" });
  return draft.id;
}

const cancels = (publicationId: number) => sql<{ id: string; state: string; not_after: Date }>(
  "select id::text, state, not_after from fansly_write_commands where publication_id = $1 and step = 'post_cancel' order by id", [publicationId],
);
const status = async (id: number) => (await sql<{ status: string; status_reason: string | null }>("select status, status_reason from publications where id = $1", [id]))[0]!;

/** The page's schedule as a read taken now would leave it. */
async function readSchedule(postRefs: string[], complete = false) {
  await savePublicationQueueSnapshot(app.db, {
    pageId, answeredRequestAt: null, readAt: new Date(Date.now() + 1000), windowFrom: null, windowTo: null, complete,
    incompleteReasons: complete ? [] : ["list_whole_unverified"], postsPerDay: {},
    entries: postRefs.map((postRef) => ({ queueId: postRef, postRef, publishAt: null, text: "", mediaCount: 0 })), evidence: {},
  });
}

describe("a Fansly withdrawal is refused without a request (spec §8.2, §8.4)", () => {
  it("while the cancel route is unverified, too close to the time, or the page stopped — the schedule stays", async () => {
    const id = await scheduledPost("p1");
    // A cancel route not verified (the contract verified it: as if it had not).
    expect((await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable: () => false }))[0]).toMatchObject({ outcome: "refused", reason: "route_unverified" });
    const close = new Date(Date.now() + 2 * DAY - 10 * MIN);
    expect((await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable, now: close }))[0])
      .toMatchObject({ outcome: "refused", reason: "too_close_to_publish_time" });
    await sql("update page_publishing_settings set enabled = false, autostop_reason = 'browser_login_lost', autostopped_at = now() where page_id = $1", [pageId]);
    expect((await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable }))[0])
      .toMatchObject({ outcome: "refused", reason: "publishing_stopped_schedule_stays" });
    expect(await sql("select id from publication_dispatches where kind = 'withdraw'")).toEqual([]);
    expect(await cancels(id)).toEqual([]);
    expect(await status(id)).toMatchObject({ status: "scheduled" });
  });
});

describe("a Fansly withdrawal (spec §8.2)", () => {
  it("one cancel, queued once, a fresh read asked; withdrawn only by a complete read after Fansly's answer; then a replacement", async () => {
    const id = await scheduledPost("p1");
    // Publishing off does not stop a withdrawal.
    app.config.publishingEnabled = false;
    await sql("update page_publishing_settings set enabled = false where page_id = $1", [pageId]);
    const [first] = await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable });
    expect(first).toMatchObject({ outcome: "accepted" });
    const [cancel] = await cancels(id);
    expect(cancel).toMatchObject({ state: "queued" });
    const publishAt = new Date((await sql<{ publish_at: Date }>("select publish_at from publications where id = $1", [id]))[0]!.publish_at);
    expect(cancel!.not_after.getTime()).toBe(publishAt.getTime() - 15 * MIN);
    expect(await sql("select kind from sync_work where resource = 'publish.schedule'")).toEqual([{ kind: "poll" }]);
    expect((await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable }))[0]).toMatchObject({ outcome: "refused", reason: "withdraw_in_progress" });
    expect((await getPublicationDetail(app.db, id)).withdrawal).toMatchObject({ state: "dispatching" });

    await settleCommand(cancel!.id, "answered", { cancelled: true });
    // No read after the answer yet: the job asks for one and waits.
    expect(await followFanslyWithdrawals(app)).toMatchObject({ followed: 1, readsAsked: 1, withdrawn: 0, unknown: 0 });
    await readSchedule([], true);
    await followFanslyWithdrawals(app, { facts: VERIFIED });
    expect(await status(id)).toMatchObject({ status: "withdrawn", status_reason: "withdrawn" });
    const replacement = await replaceWithdrawnPublication(app.db, { id, userId: ownerId });
    expect(replacement).toMatchObject({ status: "draft", previousPublicationId: id });
  });

  it("until the stand confirms the list is whole, a read without the post is not a confirmation: unknown, no replacement", async () => {
    const id = await scheduledPost("p1");
    await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable });
    await settleCommand((await cancels(id))[0]!.id, "answered", { cancelled: true });
    await readSchedule([]);
    await followFanslyWithdrawals(app);
    expect(await status(id)).toMatchObject({ status: "unknown", status_reason: "withdraw_unconfirmed_incomplete" });
    await expect(replaceWithdrawnPublication(app.db, { id, userId: ownerId })).rejects.toThrow(/only a withdrawn publication/);
  });

  it("Fansly's answer listing the post as taken off, and a read after it without the post: withdrawn, the list's wholeness unclaimed", async () => {
    const id = await scheduledPost("p1");
    await withdrawFanslyPublications(app, { ids: [id], userId: ownerId, isSendable });
    await settleCommand((await cancels(id))[0]!.id, "answered", { cancelled: true, listedStatus: 3 });
    await readSchedule([]);
    await followFanslyWithdrawals(app);
    expect(await status(id)).toMatchObject({ status: "withdrawn", status_reason: "withdrawn_cancel_acknowledged" });
  });

  it("a lost answer is unknown and never sent again; Fansly's refusal leaves the post scheduled", async () => {
    const lost = await scheduledPost("p1");
    const refused = await scheduledPost("p2", 3);
    expect((await withdrawAllFanslyPublications(app, { pageId, userId: ownerId, isSendable })).map((result) => result.outcome)).toEqual(["accepted", "accepted"]);
    await settleCommand((await cancels(lost))[0]!.id, "unknown", null, "no_answer:timeout");
    await settleCommand((await cancels(refused))[0]!.id, "rejected", null, "fansly_http_400");
    await followFanslyWithdrawals(app);
    expect(await status(lost)).toMatchObject({ status: "unknown", status_reason: "withdraw_no_answer:timeout" });
    expect(await status(refused)).toMatchObject({ status: "scheduled" });
    expect((await getPublicationDetail(app.db, refused)).withdrawal).toMatchObject({ state: "rejected", errorCode: "fansly_http_400" });
    // The rejected one went: no second cancel.
    expect((await withdrawFanslyPublications(app, { ids: [refused], userId: ownerId, isSendable }))[0]).toMatchObject({ outcome: "refused", reason: "withdraw_already_sent" });
    expect(await cancels(lost)).toHaveLength(1);
  });
});

// --- An agent key's withdrawal and the page's schedule, over HTTP ------------

/** Only withdraws, on lilly-1. */
const WITHDRAWER = `${AGENT_KEY_TOKEN_PREFIX}withdraw-only`;
/** Only drafts, on lilly-1. */
const DRAFTER = `${AGENT_KEY_TOKEN_PREFIX}withdraw-drafter`;
/** Neither, on lilly-1. */
const READER = `${AGENT_KEY_TOKEN_PREFIX}withdraw-reader`;
/** Withdraws, on another page. */
const OUTSIDE = `${AGENT_KEY_TOKEN_PREFIX}withdraw-outside`;

let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
let otherPageId = 0;
const keyIds = new Map<string, number>();

afterEach(async () => {
  await server?.close();
  server = null;
});

async function startApi() {
  const other = await seedSyncPage({ db: app.db as unknown as Database, pool: testDb!.pool }, { label: "lora-1" });
  otherPageId = other.pageId;
  for (const [token, name, capabilities, pageIds] of [
    [WITHDRAWER, "withdraw-only", ["withdraw:publications"], [pageId]],
    [DRAFTER, "withdraw-drafter", ["write:publication_drafts"], [pageId]],
    [READER, "withdraw-reader", ["read:datasets"], [pageId]],
    [OUTSIDE, "withdraw-outside", ["withdraw:publications"], [other.pageId]],
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
  server = await buildApiServer(app);
  await server.ready();
  const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: "owner-password-for-tests" } });
  ownerCookie = String([login.headers["set-cookie"]].flat()[0] ?? "").split(";")[0] ?? "";
  expect(ownerCookie).not.toBe("");
}

const asAgent = (token: string, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
const asOwner = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: ownerCookie }, ...(payload ? { payload } : {}) });
const outcomes = (response: { json(): unknown }) =>
  (response.json() as { results: Array<{ outcome: string; reason: string | null }> }).results.map(({ outcome, reason }) => ({ outcome, reason }));
const withdrawAudits = () => sql<{ source: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
  "select source, actor_user_id::text, metadata from audit_events where event_type = 'admin.publication_withdraw' order by id",
);

describe("an agent key takes a post off the schedule (withdraw:publications, owner 2026-11-11)", () => {
  it("a key that only withdraws takes off a post a person drafted and approved; the owner's audit names the key", async () => {
    const id = await scheduledPost("p1");
    await startApi();
    const response = await asAgent(WITHDRAWER, "POST", `/api/v1/agent/publications/${id}/withdraw`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().results).toEqual([expect.objectContaining({ id, outcome: "accepted", reason: "schedule_read_then_cancel" })]);
    // The owner's path: one cancel queued, the read before it asked for.
    expect(await cancels(id)).toEqual([expect.objectContaining({ state: "queued" })]);
    expect(await sql("select kind from sync_work where resource = 'publish.schedule'")).toEqual([{ kind: "poll" }]);
    // Who did it: the owner's audit row is the key's (source agent_key, the key in the metadata) ...
    expect(await withdrawAudits()).toEqual([{
      source: "agent_key",
      actor_user_id: null,
      metadata: { pageLabel: "lilly-1", results: [{ id, outcome: "accepted", reason: "schedule_read_then_cancel" }], actorAgentKeyId: keyIds.get(WITHDRAWER) },
    }]);
    // ... the agent audit names the post, and the screen's refresh is asked as the key's owner.
    expect(await sql<{ request_summary: Record<string, unknown> }>(
      "select request_summary from agent_read_audit where agent_key_id = $1 and operation = 'agentPublicationWithdraw'", [keyIds.get(WITHDRAWER)],
    )).toEqual([{ request_summary: { publicationId: id, outcome: "accepted", reasonCode: "schedule_read_then_cancel" } }]);
    expect(await sql("select refresh_requested_by_user_id::int as by from publication_queue_snapshots where page_id = $1", [pageId]))
      .toEqual([{ by: ownerId }]);
    // A second press is the owner's refusal too: one cancel per post.
    expect(outcomes(await asAgent(WITHDRAWER, "POST", `/api/v1/agent/publications/${id}/withdraw`)))
      .toEqual([{ outcome: "refused", reason: "withdraw_in_progress" }]);
    expect(await cancels(id)).toHaveLength(1);
  });

  it("a post not handed yet, gone out or too close to its time gets the owner's refusal, and nothing is sent", async () => {
    const published = await scheduledPost("p2", 3);
    const close = await scheduledPost("p3", 4);
    await sql("update publications set status = 'published' where id = $1", [published]);
    await sql("update publications set publish_at = now() + interval '10 minutes' where id = $1", [close]);
    // Created after the ticks above, so Hub never hands them to Fansly.
    const draft = await createPublicationDraft(app.db, { pageId, body: textPost("d1", 5), author: { kind: "human", userId: ownerId }, idempotencyKey: null });
    const approvedDraft = await createPublicationDraft(app.db, { pageId, body: textPost("d2", 6), author: { kind: "human", userId: ownerId }, idempotencyKey: null });
    expect((await approvePublications(app.db, { items: [{ id: approvedDraft.id, version: approvedDraft.version }], userId: ownerId }))[0]?.outcome).toBe("approved");
    await startApi();
    for (const [id, reason] of [
      [draft.id, "status_draft"],
      [approvedDraft.id, "status_approved"],
      [published, "status_published"],
      [close, "too_close_to_publish_time"],
    ] as const) {
      const byAgent = await asAgent(WITHDRAWER, "POST", `/api/v1/agent/publications/${id}/withdraw`);
      expect(byAgent.statusCode, byAgent.body).toBe(200);
      expect(outcomes(byAgent), String(id)).toEqual([{ outcome: "refused", reason }]);
      expect(outcomes(byAgent), String(id)).toEqual(outcomes(await asOwner("POST", `/api/v1/admin/publications/${id}/withdraw`)));
    }
    expect(await sql("select id from publication_dispatches where kind = 'withdraw'")).toEqual([]);
    expect(await sql("select id from fansly_write_commands where step = 'post_cancel'")).toEqual([]);
  });

  it("without the capability it is 403; a post outside the key's pages is the same 404 as none; the page's «Снять всё» stays the owner's", async () => {
    const id = await scheduledPost("p1");
    await startApi();
    const noRight = await asAgent(DRAFTER, "POST", `/api/v1/agent/publications/${id}/withdraw`);
    expect(noRight.statusCode).toBe(403);
    expect(noRight.json().error).toBe("agent_capability_missing");
    const outside = await asAgent(OUTSIDE, "POST", `/api/v1/agent/publications/${id}/withdraw`);
    const none = await asAgent(OUTSIDE, "POST", `/api/v1/agent/publications/${id + 1000}/withdraw`);
    expect(outside.statusCode).toBe(404);
    expect(none.statusCode).toBe(404);
    expect(outside.body).toBe(none.body);
    expect((await asAgent(WITHDRAWER, "POST", "/api/v1/admin/publications/withdraw-page", { pageLabel: "lilly-1" })).statusCode).toBe(403);
    expect(await cancels(id)).toEqual([]);
    expect(await sql("select id from publication_dispatches where kind = 'withdraw'")).toEqual([]);
    expect(await withdrawAudits()).toEqual([]);
    expect(await status(id)).toMatchObject({ status: "scheduled" });
  });
});

describe("an agent key reads its page's schedule as the owner does", () => {
  it("the owner's entry for the page, Hub's posts and the ones put there by hand; refresh is the owner's «Обновить»", async () => {
    const id = await scheduledPost("p1");
    await savePublicationQueueSnapshot(app.db, {
      pageId, answeredRequestAt: null, readAt: new Date(), windowFrom: null, windowTo: null, complete: false,
      incompleteReasons: ["list_whole_unverified"], postsPerDay: {},
      entries: [
        { queueId: "p1", postRef: "p1", publishAt: null, text: "post p1", mediaCount: 0, mediaRefs: ["m1"], attachmentRefs: ["a1"] },
        { queueId: "hand-1", postRef: "hand-1", publishAt: null, text: "by hand", mediaCount: 1, mediaRefs: [], attachmentRefs: [] },
      ],
      evidence: {},
    });
    await startApi();
    const owners = (await asOwner("GET", "/api/v1/admin/publications/queue")).json() as { pages: Array<{ pageLabel: string; entries: unknown[] }> };
    const ownersPage = owners.pages.find((page) => page.pageLabel === "lilly-1");
    expect(ownersPage?.entries).toEqual([
      { queueId: "p1", postRef: "p1", publishAt: null, text: "post p1", mediaCount: 0, publicationId: id },
      { queueId: "hand-1", postRef: "hand-1", publishAt: null, text: "by hand", mediaCount: 1, publicationId: null },
    ]);
    for (const token of [WITHDRAWER, DRAFTER]) {
      const response = await asAgent(token, "GET", "/api/v1/agent/pages/lilly-1/publication-queue");
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(ownersPage);
    }
    expect((await asAgent(READER, "GET", "/api/v1/agent/pages/lilly-1/publication-queue")).statusCode).toBe(403);
    expect((await asAgent(OUTSIDE, "GET", "/api/v1/agent/pages/lilly-1/publication-queue")).statusCode).toBe(404);

    const refreshed = await asAgent(WITHDRAWER, "POST", "/api/v1/agent/pages/lilly-1/publication-queue/refresh");
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(await sql(
      "select refresh_requested_by_user_id::int as by from publication_queue_snapshots where page_id = $1 and refresh_requested_at is not null", [pageId],
    )).toEqual([{ by: ownerId }]);
    expect((await asAgent(READER, "POST", "/api/v1/agent/pages/lilly-1/publication-queue/refresh")).statusCode).toBe(403);
    expect((await asAgent(OUTSIDE, "POST", "/api/v1/agent/pages/lilly-1/publication-queue/refresh")).statusCode).toBe(404);

    // A page with publishing off and no Hub post on it: its schedule is read only once someone asks.
    expect(await fanslyScheduleReadWanted(app.db, otherPageId)).toBe(false);
    expect((await asAgent(OUTSIDE, "POST", "/api/v1/agent/pages/lora-1/publication-queue/refresh")).statusCode).toBe(200);
    expect(await fanslyScheduleReadWanted(app.db, otherPageId)).toBe(true);
  });
});
