import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  agentFanQueueDetailSchema,
  agentFanQueuePreviewResponseSchema,
  agentFanQueueSchema,
  clientFanQueuesResponseSchema,
  clientFanQueueTakeResponseSchema,
} from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fan queues (docs/plans/2026-10-29-fan-queues/spec.md): an agent previews a
// rule and creates a queue on a person's word; two chatters taking portions at
// once never get one fan; a fan who wrote, bought or was written to since he
// was queued leaves at the take; the daily portion stops the take unless
// «Ещё 10», the page's limit stops it for good; «Не предлагать» is the team's
// mark; a fan already queued joins no other queue; a people queue hands each
// person their own fans; only the asker, the owner or a team lead changes a
// queue.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const VERSION = "chat-extension/3.9.0";
const AGENT = `${AGENT_KEY_TOKEN_PREFIX}fan-queues-gengar`;
const DAY = 24 * 60;
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let page = 0;
const tokens: Record<string, string> = {};
const fanIds = new Map<string, number>();
let messageSeq = 9_700_000_000;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

/** A Fansly follower of the page: seen `seenMinutesAgo`, paid `spentMills`, followed `followedDaysAgo`. */
async function follower(ref: string, input: { seenMinutesAgo?: number; spentMills?: number; followedDaysAgo?: number; alias?: string } = {}) {
  const id = Number((await q(
    "insert into fans (platform, platform_user_id, username, first_seen_at) values ('fansly', $1, $2, now() - interval '200 days') returning id",
    [ref, `fan${ref}`],
  )).rows[0].id);
  await q(`insert into page_fans (fan_id, platform_account_id, is_follower, follower_since, page_alias, external_presence_at,
             external_presence_observed_at, external_presence_source)
           values ($1, $2, true, now() - interval '1 day' * $3, $4,
             case when $5::int is null then null else now() - interval '1 minute' * $5 end,
             case when $5::int is null then null else now() - interval '1 minute' * $5 end, 'fansly_followers_last_seen')`,
    [id, page, input.followedDaysAgo ?? 120, input.alias ?? null, input.seenMinutesAgo ?? null]);
  if ((input.spentMills ?? 0) > 0) {
    await q(`insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills, last_transaction_at, updated_at)
             values ($1, $2, $3, $3, now() - interval '40 days', now())`, [page, id, input.spentMills]);
  }
  fanIds.set(ref, id);
  return id;
}

async function fanWrote(ref: string, minutesAgo: number) {
  const fanId = fanIds.get(ref)!;
  await q(`insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, last_message_at,
             last_fan_message_at, is_visible)
           values ($1, $2, $3, $4, now() - interval '1 minute' * $5, now() - interval '1 minute' * $5, true)`,
    [page, fanId, `9${ref}`, ref, minutesAgo]);
  messageSeq += 1;
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain)
           values ($1, 'fansly', $2, $3, 'fan', false, now() - interval '1 minute' * $4, 'hey')`, [page, `9${ref}`, String(messageSeq), minutesAgo]);
}

async function bought(ref: string, minutesAgo: number) {
  await q(`update fan_spend_lifetime set last_transaction_at = now() - interval '1 minute' * $3 where platform_account_id = $1 and fan_id = $2`,
    [page, fanIds.get(ref)!, minutesAgo]);
  await q(`insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills, last_transaction_at, updated_at)
           values ($1, $2, 5000, 5000, now() - interval '1 minute' * $3, now()) on conflict do nothing`, [page, fanIds.get(ref)!, minutesAgo]);
}

const agent = (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${AGENT}` }, ...(payload ? { payload } : {}) });
const client = (who: string, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}`, "x-client-version": VERSION }, ...(payload ? { payload } : {}) });

const COLD_RULE = { audience: "followers", fanWrote: "never", lifetimeSpend: { max: 0 }, seen: { withinDays: 7 } };
const TEMPLATE_B = { action: "template", templates: "b", sendMode: "batch" };

async function create(body: Record<string, unknown>) {
  const response = await agent("POST", "/api/v1/agent/pages/lora-1/fan-queues", body);
  expect(response.statusCode, response.body).toBe(200);
  return agentFanQueueSchema.parse(response.json());
}
async function take(who: string, queueId: number, body: Record<string, unknown> = {}) {
  const response = await client(who, "POST", `/api/v1/client/pages/lora-1/fan-queues/${queueId}/take`, body);
  expect(response.statusCode, response.body).toBe(200);
  return clientFanQueueTakeResponseSchema.parse(response.json());
}
const done = (who: string, itemId: number, body: Record<string, unknown>) =>
  client(who, "POST", `/api/v1/client/pages/lora-1/fan-queues/items/${itemId}/done`, body);

describe("fan queues", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    const owner = await createUserAccount(app, { username: "dima", role: "owner", password: "dima-secret" }, { source: "cli" });
    for (const name of ["max", "vanya", "outsider"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-secret` }, { source: "cli" });
    }
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    page = (await createFanslyPage(app.db, { modelId: model!.id, label: "lora-1" }))!.id;
    await assignPageToUser(app, { userId: await fixtureUserId(app, "max"), pageLabel: "lora-1" }, { source: "cli" });
    await assignPageToUser(app, { userId: await fixtureUserId(app, "vanya"), pageLabel: "lora-1" }, { source: "cli" });
    await insertAgentKey(testDb.db, {
      name: "gengar",
      keyPrefix: AGENT.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT),
      capabilities: ["write:fan_queues"] as never,
      pageIds: [page],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: owner?.id ?? 0,
    });

    // Twelve cold followers seen this week, newest first by presence.
    for (let i = 1; i <= 12; i++) await follower(`80${String(i).padStart(2, "0")}`, { seenMinutesAgo: i * 30 });
    // Left out: not seen for a month, a payer, one who wrote, a 💩, one marked «Не предлагать», a deleted one.
    await follower("8101", { seenMinutesAgo: 40 * DAY });
    await follower("8102", { seenMinutesAgo: 60, spentMills: 25_000 });
    await follower("8103", { seenMinutesAgo: 60 });
    await fanWrote("8103", 5 * DAY);
    await follower("8104", { seenMinutesAgo: 60, alias: "Mike 💩" });
    await follower("8105", { seenMinutesAgo: 60 });
    await q(`insert into online_attempts (page_id, fan_id, fan_ref, user_id, action, attempted_at)
             values ($1, $2, '8105', $3, 'dismissed', now() - interval '1 day')`, [page, fanIds.get("8105"), owner?.id ?? 0]);
    await follower("8106", { seenMinutesAgo: 60 });
    await q("update fans set deleted_detected_at = now() where id = $1", [fanIds.get("8106")]);

    server = await buildApiServer(app);
    await server.ready();
    for (const name of ["max", "vanya"]) {
      const signIn = await server.inject({
        method: "POST", url: "/api/v1/auth/device-tokens/password", headers: { "x-client-version": VERSION },
        payload: { username: name, password: `${name}-secret`, label: "Firefox", mode: "active", client: "chat-extension" },
      });
      tokens[name] = signIn.json<{ token: string }>().token;
    }
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("previews a rule in Hub's words, with what it leaves out and why", async (context) => {
    if (!testDb) return context.skip();
    const response = await agent("POST", "/api/v1/agent/pages/lora-1/fan-queues/preview", { rule: COLD_RULE, dailyLimit: 5 });
    expect(response.statusCode, response.body).toBe(200);
    const preview = agentFanQueuePreviewResponseSchema.parse(response.json());
    expect(preview.count).toBe(12);
    expect(preview.excluded).toMatchObject({ unreachable: 1, dismissed: 1, markers: 1, inOtherQueues: 0 });
    expect(preview.samples.map((one) => one.fanRef)).toEqual(["8001", "8002", "8003", "8004", "8005"]);
    expect(preview.samples[0]!.why).toContain("ни разу не писал");
    expect(preview.ruleText).toContain("фолловеры страницы");
    expect(preview.ruleText).toContain("ни разу нам не писали");
    expect(preview.daysAtLimit).toBe(3);
  });

  it("creates a queue only on the word of a person of the page, and replays by its key", async (context) => {
    if (!testDb) return context.skip();
    const refused = await agent("POST", "/api/v1/agent/pages/lora-1/fan-queues", {
      name: "Холодные", rule: COLD_RULE, scenario: TEMPLATE_B, requestedBy: "outsider", idempotencyKey: "cold-outsider-1",
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "requester_not_granted" });

    const body = {
      name: "Холодные живые", goal: "Познакомиться", rule: COLD_RULE, scenario: TEMPLATE_B,
      perPerson: 3, dailyLimit: 5, requestedBy: "dima", idempotencyKey: "cold-live-0001",
    };
    const queue = await create(body);
    expect(queue.counts.pending).toBe(12);
    expect(queue.requestedBy).toBe("dima");
    const again = await create(body);
    expect(again.queueId).toBe(queue.queueId);
    expect(again.counts.pending).toBe(12);

    // A fan already queued joins no other queue.
    const preview = agentFanQueuePreviewResponseSchema.parse((await agent("POST", "/api/v1/agent/pages/lora-1/fan-queues/preview", { rule: COLD_RULE })).json());
    expect(preview.count).toBe(0);
    expect(preview.excluded.inOtherQueues).toBe(12);
  });

  it("hands two chatters different fans, re-checks each fan, and keeps the day's portion and limit", async (context) => {
    if (!testDb) return context.skip();
    const queueId = agentFanQueueSchema.array().parse(
      (await agent("GET", "/api/v1/agent/fan-queues")).json().queues,
    ).find((one) => one.name === "Холодные живые")!.queueId;
    const listed = clientFanQueuesResponseSchema.parse((await client("max", "GET", "/api/v1/client/pages/lora-1/fan-queues")).json());
    expect(listed.queues.map((one) => [one.name, one.pending, one.perPerson])).toEqual([["Холодные живые", 12, 3]]);

    // Since he was queued (just now): 8001 wrote, 8002 bought.
    await fanWrote("8001", 0);
    await bought("8002", 0);
    const [maxPortion, vanyaPortion] = await Promise.all([take("max", queueId, { count: 3 }), take("vanya", queueId, { count: 2 })]);
    const maxIds = maxPortion.items.map((item) => item.itemId);
    const vanyaIds = vanyaPortion.items.map((item) => item.itemId);
    expect(maxIds.filter((id) => vanyaIds.includes(id))).toEqual([]);
    expect(maxPortion.items.length + vanyaPortion.items.length).toBe(5);
    expect(maxPortion.dropped + vanyaPortion.dropped).toBe(2);
    expect([...maxPortion.items, ...vanyaPortion.items].map((item) => item.fanRef)).not.toContain("8001");
    expect(maxPortion.items[0]!.act).toBe("template_b");
    expect(maxPortion.items[0]!.templateId).toMatch(/^B\d$/);

    // The page's limit (5) is taken by the two portions: nothing more today.
    const more = await take("max", queueId, { count: 10, more: true });
    expect(more.items.length).toBe(3);
    expect(more.stopped).toBe("limit_reached");

    // Max sends all three: his portion (3) is done.
    for (const item of maxPortion.items) {
      const sent = await done("max", item.itemId, { outcome: "sent", act: "template", templateId: item.templateId });
      expect(sent.statusCode, sent.body).toBe(200);
      expect(sent.json()).toMatchObject({ state: "sent" });
    }
    const again = await done("max", maxPortion.items[0]!.itemId, { outcome: "sent", act: "template" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ reason: "fan_queue_item_not_leased" });
    const after = await take("max", queueId, { count: 10 });
    expect(after.items).toEqual([]);
    expect(after.stopped).toBe("portion_done");
    expect(after.today).toEqual({ mine: 3, page: 3 });

    // Vanya: «Не предлагать» marks the fan for the team; «Позже» puts the other back for three days.
    const [first, second] = vanyaPortion.items;
    expect((await done("vanya", first!.itemId, { outcome: "skipped", skipReason: "dismiss" })).json()).toMatchObject({ state: "skipped" });
    expect((await q("select action from online_attempts where fan_id = $1 order by id desc limit 1", [fanIds.get(first!.fanRef)])).rows[0].action)
      .toBe("dismissed");
    expect((await done("vanya", second!.itemId, { outcome: "skipped", skipReason: "later" })).json()).toMatchObject({ state: "pending" });
    const later = await q("select state, not_before > now() + interval '2 days' as later from fan_queue_items where id = $1", [second!.itemId]);
    expect(later.rows[0]).toEqual({ state: "pending", later: true });

    // Only the asker, the owner or a team lead changes a queue.
    const byChatter = await agent("PATCH", `/api/v1/agent/fan-queues/${queueId}`, { requestedBy: "vanya", status: "paused" });
    expect(byChatter.statusCode).toBe(403);
    const paused = await agent("PATCH", `/api/v1/agent/fan-queues/${queueId}`, { requestedBy: "dima", status: "paused" });
    expect(agentFanQueueSchema.parse(paused.json())).toMatchObject({ status: "paused", pausedBy: "dima" });
    expect((await take("vanya", queueId)).stopped).toBe("paused");

    const detail = agentFanQueueDetailSchema.parse((await agent("GET", `/api/v1/agent/fan-queues/${queueId}`)).json());
    expect(detail.results.sent).toBe(3);
    expect(detail.results.byPerson.map((one) => [one.username, one.sent])).toEqual([["max", 3]]);
    expect(detail.results.dropped).toMatchObject({ fan_wrote: 1, bought: 1 });
    expect(detail.results.skipped).toMatchObject({ dismiss: 1, later: 1 });
    expect(detail.today.byPerson.find((one) => one.username === "max")?.sent).toBe(3);
  });

  it("splits a people queue between its people and moves one person's fans to another", async (context) => {
    if (!testDb) return context.skip();
    for (let i = 1; i <= 6; i++) await follower(`82${String(i).padStart(2, "0")}`, { seenMinutesAgo: i * 10, followedDaysAgo: 30 });
    const queue = await create({
      name: "Для двоих", rule: { audience: "followers", followed: { withinDays: 60 } }, scenario: { action: "ping" },
      distribution: "people", people: ["max", "vanya"], requestedBy: "max", idempotencyKey: "people-queue-1",
    });
    expect(queue.counts.pending).toBe(6);
    const maxPortion = await take("max", queue.queueId);
    expect(maxPortion.items.length).toBe(3);
    const moved = await agent("PATCH", `/api/v1/agent/fan-queues/${queue.queueId}`, { requestedBy: "max", move: { from: "vanya", to: "max" } });
    expect(moved.statusCode, moved.body).toBe(200);
    const vanyaPortion = await take("vanya", queue.queueId);
    expect(vanyaPortion.items).toEqual([]);
    expect(vanyaPortion.stopped).toBe("empty");
    const maxAgain = await take("max", queue.queueId, { count: 10 });
    expect(maxAgain.items.length).toBe(6);
    // A short chat: Ping falls back to the guide's A text, as in «Онлайн».
    expect(maxAgain.items[0]!.act).toBe("template_a");
    const released = await client("max", "POST", `/api/v1/client/pages/lora-1/fan-queues/${queue.queueId}/release`, {});
    expect(released.json()).toEqual({ released: 6 });
  });
});
