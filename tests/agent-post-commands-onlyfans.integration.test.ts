import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createModel, createOnlyFansPage, insertAgentKey, savePublicationQueueSnapshot, setPageOfapiAccountId } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { deletePagePost, withdrawPagePost, type PostCommandActor, type PostCommandPage } from "../apps/runtime/src/services/post-commands.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/**
 * Any post of an OnlyFans page by its id (owner 2026-11-11, 0369), against a
 * stub OnlyFansAPI: a post put in the schedule by hand comes off only after a
 * fresh read of its day, whole, shows it exactly once — then ONE `post_delete`
 * as the key's owner, OnlyFans' answer its outcome; a published post of the
 * page's own goes the same way. One delete per post whichever action asked (on
 * OnlyFans both are the same request): a repeat sends nothing; a lost answer is
 * unknown and never sent again.
 */

const ACCOUNT = "acct_24000000000000000000000000000001";
const DAY = 24 * 60 * 60_000;
const HASH = "f".repeat(64);
const TOKEN = `${AGENT_KEY_TOKEN_PREFIX}of-post-commands`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let page: PostCommandPage;
let actor: PostCommandActor;
let deleted: string[] = [];
let schedule: Array<Record<string, unknown>> = [];
let deleteAnswer: (postId: string) => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  app.config.publishingEnabled = false;
  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  const pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "lora-of" })).id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: ACCOUNT });
  const ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
  await testDb.pool.query("insert into page_publishing_settings (page_id, enabled, updated_by_user_id) values ($1, false, $2)", [pageId, ownerId]);
  const key = await insertAgentKey(app.db, {
    name: "of-post-commands",
    keyPrefix: TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(TOKEN),
    capabilities: ["withdraw:publications", "delete:posts"] as never,
    pageIds: [pageId],
    expiresAt: new Date(Date.now() + 30 * DAY),
    createdBy: ownerId,
  });
  page = { id: pageId, pageLabel: "lora-of", platform: "onlyfans" };
  actor = { agentKeyId: key.id, ownerUserId: ownerId, allowedPageIds: [pageId] };

  deleted = [];
  schedule = [];
  deleteAnswer = (postId) => {
    schedule = schedule.filter((entry) => String((entry.entity as { id: number }).id) !== postId);
    return json({ data: { success: true } });
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/whoami")) return json({ team: { slug: "agency" } });
    const rest = url.pathname.slice(url.pathname.indexOf(ACCOUNT) + ACCOUNT.length);
    if (method === "DELETE" && rest.startsWith("/posts/")) {
      const postId = rest.slice("/posts/".length);
      deleted.push(postId);
      return deleteAnswer(postId);
    }
    if (method !== "GET") throw new Error(`unexpected OFAPI write ${method} ${url.pathname}`);
    const inWindow = (entry: Record<string, unknown>) => {
      const day = String(entry.publishDateTime).slice(0, 10);
      return day >= (url.searchParams.get("publishDateStart") ?? "") && day <= (url.searchParams.get("publishDateEnd") ?? "9999");
    };
    if (rest === "/queue/counts") {
      const list: Record<string, { post: number }> = {};
      for (const entry of schedule.filter(inWindow)) {
        const day = String(entry.publishDateTime).slice(0, 10);
        list[day] = { post: (list[day]?.post ?? 0) + 1 };
      }
      return json({ data: { list, syncInProcess: false } });
    }
    if (rest === "/queue") return json({ data: { list: schedule.filter(inWindow), syncInProcess: false } });
    throw new Error(`unexpected OFAPI request ${method} ${url.pathname}`);
  }));
  app.ofapi = createOfapiClient({ apiKey: "synthetic-key", restDelayMs: 0, ...ofapiCredentialPolicy(app.db, app.config, app.logger) });
});

/** A post put in OnlyFans' schedule by hand (entry `queueId`, post `postId`), and Hub's fresh read of it. */
async function byHand(queueId: number, postId: number, at = new Date(Date.now() + 2 * DAY)) {
  schedule.push({ id: queueId, type: "post", publishDateTime: at.toISOString(), entity: { responseType: "post", id: postId, rawText: "by hand" } });
  await savePublicationQueueSnapshot(app.db, {
    pageId: page.id, answeredRequestAt: null, readAt: new Date(), windowFrom: null, windowTo: null, complete: true, incompleteReasons: [], postsPerDay: {},
    entries: schedule.map((entry) => ({
      queueId: String(entry.id), postRef: String((entry.entity as { id: number }).id), publishAt: String(entry.publishDateTime), text: "by hand", mediaCount: 0,
    })),
    evidence: {},
  });
}

async function ownPost(postRef: string) {
  await testDb!.pool.query(
    `insert into creator_posts (account_id, platform, platform_post_id, text_plain, published_at, first_observed_at,
                                last_observed_at, content_hash, attachment_count, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'onlyfans', $2, 'a post', now() - interval '1 day', now(), now(), $3, 0, 1, 1, 1)`,
    [page.id, postRef, HASH],
  );
}

describe("an OnlyFans post by its id", () => {
  it("one put in the schedule by hand: a fresh read shows it, one delete, OnlyFans' answer; a repeat — or its deletion — sends nothing", async () => {
    await byHand(60, 800001);
    const first = await withdrawPagePost(app, { page, postRef: "800001", actor });
    expect(first).toMatchObject({ outcome: "withdrawn", reason: "onlyfans_confirmed_delete", repeat: false, publicationId: null });
    expect(deleted).toEqual(["800001"]);
    expect(await withdrawPagePost(app, { page, postRef: "800001", actor })).toMatchObject({ outcome: "withdrawn", repeat: true });
    // On OnlyFans taking it off the wall is the same request: the stored one answers.
    await ownPost("800001");
    expect(await deletePagePost(app, { page, postRef: "800001", actor })).toMatchObject({ outcome: "deleted", repeat: true });
    expect(deleted).toEqual(["800001"]);
  });

  it("a fresh read that does not show it, or a post Hub's read never showed: nothing is sent", async () => {
    await byHand(61, 800002);
    // Gone from OnlyFans' schedule since Hub's read: the read before the send refuses.
    schedule = [];
    expect(await withdrawPagePost(app, { page, postRef: "800002", actor })).toMatchObject({ outcome: "refused", reason: "not_in_schedule" });
    expect(await withdrawPagePost(app, { page, postRef: "800999", actor })).toMatchObject({ outcome: "refused", reason: "not_in_schedule" });
    expect(deleted).toEqual([]);
  });

  it("a published post of the page's own: one delete, its slot taken; a lost answer is unknown and never sent again", async () => {
    await ownPost("800010");
    expect(await deletePagePost(app, { page, postRef: "800010", actor })).toMatchObject({ outcome: "deleted", dailyLimit: { limit: 10, used: 1 } });
    await ownPost("800011");
    deleteAnswer = () => json({ error: "upstream" }, 502);
    const lost = await deletePagePost(app, { page, postRef: "800011", actor });
    expect(lost).toMatchObject({ outcome: "unknown", reason: "delete_vendor_http_502", dailyLimit: { limit: 10, used: 2 } });
    expect(lost.check).toEqual(expect.any(String));
    expect(await deletePagePost(app, { page, postRef: "800011", actor })).toMatchObject({ outcome: "unknown", repeat: true, dailyLimit: { used: 2 } });
    expect(deleted).toEqual(["800010", "800011"]);
    // A post Hub does not have on this page: nothing, no slot.
    expect(await deletePagePost(app, { page, postRef: "800099", actor })).toMatchObject({ outcome: "refused", reason: "post_not_seen_on_page", dailyLimit: { used: 2 } });
    expect(deleted).toEqual(["800010", "800011"]);
  });
});
