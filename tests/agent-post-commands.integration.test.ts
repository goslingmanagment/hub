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
import { approvePublications, createPublicationDraft } from "../apps/runtime/src/services/publications.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * Any post of a Fansly page by the platform's id (owner 2026-11-11, 0369): an
 * agent key takes a post off the schedule — one put there by hand too — only
 * once Hub's own fresh read of THIS page's schedule shows it, and, with
 * delete:posts, deletes a published one only when Hub has it among THIS page's
 * own posts and not in the schedule. One command per post: a repeat sends
 * nothing and answers its state; after an unknown end nothing is sent again.
 * A withdrawal is never a delete. A deletion takes a slot of the key's daily
 * ceiling before its command, held under concurrent requests and never given
 * back for an unknown end; the owner's audit names the key and the reason.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HASH = "f".repeat(64);
const REASON = "Дима 11.11: удалить, нарезка из кастома";

/** Withdraws, on lilly-1. */
const WITHDRAWER = `${AGENT_KEY_TOKEN_PREFIX}post-withdrawer`;
/** Deletes, on lilly-1. */
const DELETER = `${AGENT_KEY_TOKEN_PREFIX}post-deleter`;
/** Neither, on lilly-1. */
const READER = `${AGENT_KEY_TOKEN_PREFIX}post-reader`;
/** Both, on lora-1 only. */
const OUTSIDE = `${AGENT_KEY_TOKEN_PREFIX}post-outside`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let otherPageId = 0;
let ownerId = 0;
let attemptId = 9000;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const keyIds = new Map<string, number>();

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(async () => {
  await server?.close();
  server = null;
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
  // Publishing off everywhere: a withdrawal and a deletion still go.
  app.config.publishingEnabled = false;
  ({ pageId } = await seedSyncPage({ db: app.db as unknown as Database, pool: testDb.pool }, { label: "lilly-1", mode: "live", guard: "fansly_sync_engine" }));
  ({ pageId: otherPageId } = await seedSyncPage({ db: app.db as unknown as Database, pool: testDb.pool }, { label: "lora-1" }));
  await sql("update sync_pages set transport = 'browser' where page_id = $1", [pageId]);
  await sql(
    `insert into page_walls (page_id, platform, wall_ref, name, default_wall, main_wall, first_observed_at, last_observed_at,
                             content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'wall-main', 'Main', true, true, now(), now(), $2, 1, 1, 1)`,
    [pageId, HASH],
  );
  await sql("insert into page_publishing_settings (page_id, enabled) values ($1, false)", [pageId]);
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
  for (const [token, name, capabilities, pageIds] of [
    [WITHDRAWER, "post-withdrawer", ["withdraw:publications"], [pageId]],
    [DELETER, "post-deleter", ["delete:posts"], [pageId]],
    [READER, "post-reader", ["read:datasets"], [pageId]],
    [OUTSIDE, "post-outside", ["withdraw:publications", "delete:posts"], [otherPageId]],
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
});

async function startApi() {
  server = await buildApiServer(app);
  await server.ready();
}

const asAgent = (token: string, url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
const withdraw = (token: string, postRef: string, page = "lilly-1") => asAgent(token, `/api/v1/agent/pages/${page}/posts/${postRef}/withdraw`);
const remove = (token: string, postRef: string, page = "lilly-1", reason: string | null = REASON) =>
  asAgent(token, `/api/v1/agent/pages/${page}/posts/${postRef}/delete`, reason === null ? {} : { reason });

/** Hub's read of the page's schedule: these posts waiting, read at `readAt`. */
async function readSchedule(posts: Array<{ postRef: string; publishAt: Date | null }>, readAt = new Date(Date.now() + 1000)) {
  await savePublicationQueueSnapshot(app.db, {
    pageId, answeredRequestAt: null, readAt, windowFrom: null, windowTo: null, complete: false,
    incompleteReasons: ["list_whole_unverified"], postsPerDay: {},
    entries: posts.map(({ postRef, publishAt }) => ({ queueId: postRef, postRef, publishAt: publishAt?.toISOString() ?? null, text: "", mediaCount: 0 })),
    evidence: {},
  });
}

/** A post of the page's own account, synced by Hub. */
async function ownPost(page: number, postRef: string) {
  await sql(
    `insert into creator_posts (account_id, platform, platform_post_id, text_plain, published_at, first_observed_at,
                                last_observed_at, content_hash, attachment_count, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', $2, 'a post', now() - interval '1 day', now(), now(), $3, 0, 1, 1, 1)`,
    [page, postRef, HASH],
  );
}

const commands = () => sql<{ id: string; step: string; post_ref: string | null; publication_id: string | null; dispatch_id: string | null; state: string }>(
  "select id::text, step, post_ref, publication_id::text, dispatch_id::text, state from fansly_write_commands order by id",
);
const slots = () => sql<{ post_ref: string; released_at: Date | null }>("select post_ref, released_at from agent_post_delete_slots order by id");
const audits = (event: string) => sql<{ source: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
  "select source, actor_user_id::text, metadata from audit_events where event_type = $1 order by id", [event],
);
const agentAudits = (token: string, operation: string) => sql<{ request_summary: Record<string, unknown> }>(
  "select request_summary from agent_read_audit where agent_key_id = $1 and operation = $2 order by id", [keyIds.get(token), operation],
);

async function settle(id: string, to: "answered" | "unknown", result: Record<string, unknown> | null, reason: string | null = null) {
  attemptId += 1;
  expect(await admitFanslyWriteCommand(app.db, {
    id: Number(id), attemptId, workId: 1,
    request: { spec: "publish.post", method: "POST", host: "api", pathAndQuery: "/api/v1/post", body: "", fingerprint: "e".repeat(64) },
  })).toBe(true);
  expect(await settleFanslyWriteCommand(app.db, { id: Number(id), attemptId, to, reason, result })).toBe(true);
}

describe("post-withdraw: any post in the page's schedule, by its id", () => {
  it("a post put there by hand: one cancel of it, never a delete; a repeat sends nothing and answers its state", async () => {
    await readSchedule([{ postRef: "8100", publishAt: new Date(Date.now() + 2 * DAY) }]);
    await startApi();
    const first = await withdraw(WITHDRAWER, "8100");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      pageLabel: "lilly-1", platform: "fansly", postRef: "8100", action: "withdraw",
      outcome: "accepted", reason: "schedule_read_then_cancel", repeat: false, publicationId: null, command: { state: "queued" },
    });
    // One cancel of the post itself, with no publication; no delete.
    expect(await commands()).toEqual([expect.objectContaining({ step: "post_cancel", post_ref: "8100", publication_id: null, dispatch_id: null, state: "queued" })]);
    // The cancel waits for a read taken after it: asked for, and wanted with publishing off.
    expect(await sql("select kind from sync_work where resource = 'publish.schedule'")).toEqual([{ kind: "poll" }]);
    expect(await fanslyScheduleReadWanted(app.db, pageId)).toBe(true);
    // Who did it: the owner's audit names the key; the agent audit closed identifiers only.
    expect(await audits("admin.page_post_withdraw")).toEqual([{
      source: "agent_key", actor_user_id: null,
      metadata: expect.objectContaining({ pageLabel: "lilly-1", postRef: "8100", outcome: "accepted", repeat: false, actorAgentKeyId: keyIds.get(WITHDRAWER) }),
    }]);
    expect(await agentAudits(WITHDRAWER, "agentPostWithdraw")).toEqual([{
      request_summary: { postRef: "8100", outcome: "accepted", reasonCode: "schedule_read_then_cancel", repeat: false, publicationId: null },
    }]);

    // Again: the stored command, nothing new.
    const again = await withdraw(WITHDRAWER, "8100");
    expect(again.json()).toMatchObject({ outcome: "accepted", reason: "command_queued", repeat: true });
    expect(await commands()).toHaveLength(1);

    // Fansly took it off (its answer lists it at status 3) and the read after no longer shows it: withdrawn.
    await settle((await commands())[0]!.id, "answered", { cancelled: true, listedStatus: 3 });
    await readSchedule([]);
    expect((await withdraw(WITHDRAWER, "8100")).json()).toMatchObject({ outcome: "withdrawn", reason: "withdrawn_cancel_acknowledged", repeat: true });
    expect((await commands()).map((row) => row.step)).toEqual(["post_cancel"]);
  });

  it("a lost answer is unknown and never sent again: asking again only answers it", async () => {
    await readSchedule([{ postRef: "8101", publishAt: new Date(Date.now() + 2 * DAY) }]);
    await startApi();
    expect((await withdraw(WITHDRAWER, "8101")).json()).toMatchObject({ outcome: "accepted" });
    await settle((await commands())[0]!.id, "unknown", null, "no_answer:timeout");
    await readSchedule([{ postRef: "8101", publishAt: new Date(Date.now() + 2 * DAY) }]);
    for (let i = 0; i < 2; i += 1) {
      const answer = (await withdraw(WITHDRAWER, "8101")).json();
      expect(answer).toMatchObject({ outcome: "unknown", reason: "withdraw_no_answer:timeout", repeat: true });
      expect(answer.check).toEqual(expect.any(String));
    }
    expect(await commands()).toHaveLength(1);
  });

  it("refused with nothing written: no read, a stale read, not in it, too close; 403 without the right; 404 off the grant", async () => {
    await startApi();
    expect((await withdraw(WITHDRAWER, "8200")).json()).toMatchObject({ outcome: "refused", reason: "schedule_not_read_refresh_first" });
    await readSchedule([{ postRef: "8200", publishAt: new Date(Date.now() + 2 * DAY) }], new Date(Date.now() - 2 * 60 * MIN));
    expect((await withdraw(WITHDRAWER, "8200")).json()).toMatchObject({ outcome: "refused", reason: "schedule_stale_refresh_first" });
    await readSchedule([
      { postRef: "8200", publishAt: new Date(Date.now() + 2 * DAY) },
      { postRef: "8201", publishAt: new Date(Date.now() + 10 * MIN) },
    ]);
    expect((await withdraw(WITHDRAWER, "8299")).json()).toMatchObject({ outcome: "refused", reason: "not_in_schedule" });
    expect((await withdraw(WITHDRAWER, "8201")).json()).toMatchObject({ outcome: "refused", reason: "too_close_to_publish_time" });
    const noRight = await withdraw(READER, "8200");
    expect(noRight.statusCode).toBe(403);
    expect(noRight.json().error).toBe("agent_capability_missing");
    expect((await withdraw(DELETER, "8200")).statusCode).toBe(403);
    // A page outside the grant: the same static 404 as a page that does not exist.
    const outside = await withdraw(OUTSIDE, "8200");
    const none = await withdraw(OUTSIDE, "8200", "no-such-page");
    expect(outside.statusCode).toBe(404);
    expect(outside.body).toBe(none.body);
    expect(await commands()).toEqual([]);
  });

  it("a Hub post by its id goes through its publication's withdrawal, the one cancel the owner's «Снять» would make", async () => {
    await sql("update page_publishing_settings set enabled = true where page_id = $1", [pageId]);
    app.config.publishingEnabled = true;
    const body: PublicationContentBody = {
      kind: "fyp_post", text: "post", media: [], previews: [], publishAt: new Date(Date.now() + 2 * DAY).toISOString(), expiresAt: null,
      wallRefs: [], tierRefs: [], priceMills: null, repost: false, pinWallRefs: [], replyLock: [], subscribersOnly: false, extraAttachments: [],
    };
    const draft = await createPublicationDraft(app.db, { pageId, body, author: { kind: "human", userId: ownerId }, idempotencyKey: null });
    await approvePublications(app.db, { items: [{ id: draft.id, version: draft.version }], userId: ownerId });
    await runFanslyPublishingTick(app, { isSendable: () => true });
    const [created] = await sql<{ id: string }>("select id::text from fansly_write_commands where publication_id = $1 and state = 'queued'", [draft.id]);
    await settle(created!.id, "answered", { postId: "8300" });
    await runFanslyPublishingTick(app, { isSendable: () => true });
    expect((await sql("select status from publications where id = $1", [draft.id]))[0]).toEqual({ status: "scheduled" });
    await startApi();
    const answer = (await withdraw(WITHDRAWER, "8300")).json();
    expect(answer).toMatchObject({ outcome: "accepted", reason: "schedule_read_then_cancel", publicationId: draft.id, repeat: false });
    const cancels = await sql<{ post_ref: string; dispatch_id: string | null }>(
      "select post_ref, dispatch_id::text from fansly_write_commands where publication_id = $1 and step = 'post_cancel'", [draft.id],
    );
    expect(cancels).toEqual([{ post_ref: "8300", dispatch_id: expect.any(String) }]);
    // Again by its id: the publication's own withdrawal answers, nothing new.
    expect((await withdraw(WITHDRAWER, "8300")).json()).toMatchObject({ repeat: true, outcome: "accepted", publicationId: draft.id });
    expect(await sql("select id from fansly_write_commands where step = 'post_cancel'")).toHaveLength(1);
  });
});

describe("post-delete: a published post of the page, on the owner's word", () => {
  it("only a post Hub has among THIS page's own posts, never one in the schedule; another page's post is the static 404", async () => {
    await ownPost(otherPageId, "9100");
    await ownPost(pageId, "9102");
    await readSchedule([{ postRef: "9102", publishAt: new Date(Date.now() + DAY) }]);
    await startApi();
    for (const [postRef, reason] of [
      ["9199", "post_not_seen_on_page"],
      // Hub has it, but on another page: not this page's post.
      ["9100", "post_not_seen_on_page"],
      ["9102", "post_in_schedule_use_withdraw"],
    ] as const) {
      const answer = await remove(DELETER, postRef);
      expect(answer.statusCode, answer.body).toBe(200);
      expect(answer.json(), postRef).toMatchObject({ outcome: "refused", reason, repeat: false });
    }
    // On a page outside the key's grant: the plane's static 404.
    const outside = await remove(DELETER, "9100", "lora-1");
    expect(outside.statusCode).toBe(404);
    expect(outside.body).toBe((await remove(DELETER, "9100", "no-such-page")).body);
    // No right, or no reason: nothing.
    expect((await remove(WITHDRAWER, "9102")).statusCode).toBe(403);
    expect((await remove(READER, "9102")).statusCode).toBe(403);
    expect((await remove(DELETER, "9102", "lilly-1", null)).statusCode).toBe(400);
    expect(await commands()).toEqual([]);
    expect(await slots()).toEqual([]);
  });

  it("one delete of the post, its slot taken; a repeat sends nothing; the owner's audit names the key and the reason", async () => {
    await ownPost(pageId, "9200");
    await startApi();
    const first = await remove(DELETER, "9200");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      outcome: "accepted", reason: "delete_then_read", repeat: false, publicationId: null, dailyLimit: { limit: 10, used: 1 },
    });
    expect(await commands()).toEqual([expect.objectContaining({ step: "post_delete", post_ref: "9200", publication_id: null, state: "queued" })]);
    expect(await slots()).toEqual([{ post_ref: "9200", released_at: null }]);
    expect(await audits("admin.page_post_delete")).toEqual([{
      source: "agent_key", actor_user_id: null,
      metadata: expect.objectContaining({ postRef: "9200", outcome: "accepted", deleteReason: REASON, actorAgentKeyId: keyIds.get(DELETER) }),
    }]);
    // The agent audit: the reason's digest and length, never its words.
    const [summary] = await agentAudits(DELETER, "agentPostDelete");
    expect(summary!.request_summary).toEqual({
      postRef: "9200", outcome: "accepted", reasonCode: "delete_then_read", repeat: false, publicationId: null,
      reasonSha256: sha256Hex(REASON), reasonLength: REASON.length, dailyUsed: 1,
    });

    // Again: the stored command, no second one, no second slot.
    expect((await remove(DELETER, "9200")).json()).toMatchObject({ outcome: "accepted", reason: "command_queued", repeat: true });
    expect(await commands()).toHaveLength(1);
    expect(await slots()).toHaveLength(1);

    // Fansly answered: a read of the post by its id is asked, and decides.
    await settle((await commands())[0]!.id, "answered", { deleted: true, postId: "9200" });
    expect((await remove(DELETER, "9200")).json()).toMatchObject({ outcome: "accepted", reason: "delete_answered_read_pending", repeat: true });
    const [read] = await sql<{ id: string }>("select id::text from sync_work where resource = 'publish.verify' and subject = 'post:9200'");
    expect(read).toBeDefined();
    await sql(
      "update sync_work set state = 'done', closed_at = now(), close_reason = 'reads_taken', result = $2::jsonb where id = $1",
      [read!.id, JSON.stringify({ v: 1, publicationId: 0, mode: "deleted", byId: { ref: "9200", found: null, answered: 0 } })],
    );
    expect((await remove(DELETER, "9200")).json()).toMatchObject({ outcome: "deleted", reason: "deleted_confirmed_by_read", repeat: true });
    expect(await commands()).toHaveLength(1);
  });

  it("the daily ceiling holds under concurrent requests, and an unknown end does not give its slot back", async () => {
    app.config.agentPostDeleteDailyLimitPerKey = 2;
    const refs = ["9301", "9302", "9303", "9304", "9305"];
    for (const ref of refs) await ownPost(pageId, ref);
    await startApi();
    const answers = await Promise.all(refs.map(async (ref) => (await remove(DELETER, ref)).json() as { outcome: string; reason: string }));
    expect(answers.filter((answer) => answer.outcome === "accepted")).toHaveLength(2);
    expect(answers.filter((answer) => answer.outcome === "refused").map((answer) => answer.reason))
      .toEqual(["daily_delete_limit_reached", "daily_delete_limit_reached", "daily_delete_limit_reached"]);
    expect(await commands()).toHaveLength(2);
    expect((await slots()).filter((slot) => slot.released_at === null)).toHaveLength(2);

    // A lost answer: unknown, never sent again, and its slot stays taken.
    const [lost] = await commands();
    await settle(lost!.id, "unknown", null, "no_answer:timeout");
    const repeat = (await remove(DELETER, lost!.post_ref!)).json();
    expect(repeat).toMatchObject({ outcome: "unknown", repeat: true, dailyLimit: { limit: 2, used: 2 } });
    expect(repeat.check).toEqual(expect.any(String));
    await ownPost(pageId, "9306");
    expect((await remove(DELETER, "9306")).json()).toMatchObject({ outcome: "refused", reason: "daily_delete_limit_reached" });
    expect(await commands()).toHaveLength(2);
  });
});
