import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientOnlineResponseSchema, type ClientOnlineResponse } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// «Онлайн»: the page's fans seen online, the most urgent reason first — who
// waits (a mass message is no answer), the new nobody greeted, an ending
// subscription, the silent payer, the quiet, the one who never wrote — each
// with what to write; set aside, never hidden, a fan another chatter talks to
// and one the page wrote to within 48 hours. OnlyFansAPI's own «online now»
// keeps a fan whose last activity left the window. A message sent from the
// window and «Не предлагать» are journaled and shared by the team; a Fansly
// tab's report of who it saw active becomes their presence.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const VERSION = "chat-extension/0.9.0";
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let token = "";
let ofPage = 0;
let fanslyPage = 0;
let vanya = 0;
let kate = 0;
let messageSeq = 9_600_000_000;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function fan(page: number, platform: "onlyfans" | "fansly", ref: string, input: { seenMinutesAgo?: number; spentMills?: number; linked?: boolean } = {}) {
  const id = Number((await q("insert into fans (platform, platform_user_id, username, first_seen_at) values ($1, $2, $3, now() - interval '90 days') returning id", [platform, ref, `fan${ref}`])).rows[0].id);
  if (input.linked === false) return id;
  await q(`insert into page_fans (fan_id, platform_account_id, is_subscriber, external_presence_at, external_presence_observed_at, external_presence_source)
           values ($1, $2, true, case when $3::int is null then null else now() - interval '1 minute' * $3 end,
             case when $3::int is null then null else now() - interval '1 minute' * $3 end, $4)`,
    [id, page, input.seenMinutesAgo ?? null, platform === "onlyfans" ? "ofapi_last_seen" : "fansly_followers_last_seen"]);
  if ((input.spentMills ?? 0) > 0) {
    await q(`insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills, last_transaction_at, updated_at)
             values ($1, $2, $3, $3, now() - interval '30 days', now())`, [page, id, input.spentMills]);
  }
  return id;
}

async function thread(ref: string, fanId: number, input: { fanWroteMinutesAgo: number; pageWroteMinutesAgo?: number }) {
  await q(`insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, last_message_at,
             last_fan_message_at, last_model_message_at, is_visible)
           values ($1, $2, $3, $3, now() - interval '1 minute' * least($4::int, coalesce($5::int, $4::int)), now() - interval '1 minute' * $4,
             case when $5::int is null then null else now() - interval '1 minute' * $5 end, true)`,
    [ofPage, fanId, ref, input.fanWroteMinutesAgo, input.pageWroteMinutesAgo ?? null]);
}

async function message(conversation: string, input: { fromPage: boolean; minutesAgo: number; text: string }) {
  messageSeq += 1;
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain)
           values ($1, 'onlyfans', $2, $3, $4, $5, now() - interval '1 minute' * $6, $7)`,
    [ofPage, conversation, String(messageSeq), input.fromPage ? "model" : "fan", input.fromPage, input.minutesAgo, input.text]);
}

async function subscription(ref: string, fanId: number, input: { startedMinutesAgo: number; endsInDays: number; autoRenew: boolean }) {
  await q(`insert into page_subscriptions (platform_subscription_id, platform_account_id, fan_id, raw_status, canonical_status, price_mills,
             renew_price_mills, is_current, auto_renew, source_created_at, ends_at)
           values ($1, $2, $3, 1, 'active', 10000, 10000, true, $4, now() - interval '1 minute' * $5, now() + interval '1 day' * $6)`,
    [`sub-${ref}`, ofPage, fanId, input.autoRenew, input.startedMinutesAgo, input.endsInDays]);
}

const headers = () => ({ authorization: `Bearer ${token}`, "x-client-version": VERSION });
const read = async (label: string, minutes?: number) => {
  const response = await server!.inject({ method: "GET", url: `/api/v1/client/pages/${label}/online${minutes === undefined ? "" : `?minutes=${minutes}`}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200);
  return clientOnlineResponseSchema.parse(response.json());
};
const listed = (list: ClientOnlineResponse) => list.items.map((item) => [item.fanRef, item.reason, item.act, item.aside]);
const attempt = (label: string, payload: Record<string, unknown>) => server!.inject({
  method: "POST", url: `/api/v1/client/pages/${label}/online/attempts`, headers: headers(), payload,
});

describe("«Онлайн»", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    for (const name of ["vanya", "kate"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
    }
    vanya = await fixtureUserId(app, "vanya");
    kate = await fixtureUserId(app, "kate");
    await setUserPassword(app, { userId: vanya, password: "vanya-secret" }, { source: "cli" });
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    ofPage = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-of" }))!.id;
    fanslyPage = (await createFanslyPage(app.db, { modelId: model!.id, label: "lora-1" }))!.id;
    await assignPageToUser(app, { userId: vanya, pageLabel: "lora-of" }, { source: "cli" });
    await assignPageToUser(app, { userId: vanya, pageLabel: "lora-1" }, { source: "cli" });

    // Waits: wrote 20 minutes ago, the page last wrote two hours ago.
    await thread("7001", await fan(ofPage, "onlyfans", "7001", { seenMinutesAgo: 2 }), { fanWroteMinutesAgo: 20, pageWroteMinutesAgo: 120 });
    // New: subscribed yesterday, nobody wrote.
    await subscription("7002", await fan(ofPage, "onlyfans", "7002", { seenMinutesAgo: 5 }), { startedMinutesAgo: 24 * 60, endsInDays: 29, autoRenew: true });
    // A silent payer with a long chat: Ping.
    const silent = await fan(ofPage, "onlyfans", "7003", { seenMinutesAgo: 3, spentMills: 50_000 });
    await thread("7003", silent, { fanWroteMinutesAgo: 12 * 24 * 60, pageWroteMinutesAgo: 12 * 24 * 60 - 5 });
    for (let i = 0; i < 10; i++) await message("7003", { fromPage: i % 2 === 1, minutesAgo: 13 * 24 * 60 - i * 60, text: `line ${i}` });
    // Quiet, never paid, two messages: the guide's A text.
    const quiet = await fan(ofPage, "onlyfans", "7004", { seenMinutesAgo: 4 });
    await thread("7004", quiet, { fanWroteMinutesAgo: 9 * 24 * 60, pageWroteMinutesAgo: 9 * 24 * 60 - 3 });
    await message("7004", { fromPage: false, minutesAgo: 9 * 24 * 60, text: "hey" });
    await message("7004", { fromPage: true, minutesAgo: 9 * 24 * 60 - 3, text: "hiii" });
    // Never wrote: the guide's B text.
    await fan(ofPage, "onlyfans", "7005", { seenMinutesAgo: 4 });
    // An ending subscription without renewal; the page wrote ten hours ago: set aside.
    const ending = await fan(ofPage, "onlyfans", "7006", { seenMinutesAgo: 6, spentMills: 20_000 });
    await subscription("7006", ending, { startedMinutesAgo: 60 * 24 * 60, endsInDays: 2, autoRenew: false });
    await thread("7006", ending, { fanWroteMinutesAgo: 3 * 24 * 60, pageWroteMinutesAgo: 600 });
    await message("7006", { fromPage: false, minutesAgo: 3 * 24 * 60, text: "busy week" });
    await message("7006", { fromPage: true, minutesAgo: 600, text: "how was your week?" });
    // Waits, but Kate is talking to him right now.
    await thread("7007", await fan(ofPage, "onlyfans", "7007", { seenMinutesAgo: 1 }), { fanWroteMinutesAgo: 3, pageWroteMinutesAgo: 5 });
    await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at)
             values ('onlyfans', $1, '9500000101', '7007', $2, 'chatspace-extension', false, false, now() - interval '5 minutes')`, [ofPage, kate]);
    // Last active 45 minutes ago, but OnlyFansAPI says online since 40 minutes ago.
    await fan(ofPage, "onlyfans", "7008", { seenMinutesAgo: 45 });
    await q(`insert into ofapi_webhook_events (idempotency_key, event_type, platform_account_id, payload, received_at)
             values ('evt-7008', 'users.online', $1, $2, now() - interval '40 minutes')`,
      [ofPage, JSON.stringify({ event: "users.online", account_id: "acct_x", payload: { fan: { id: "7008" } } })]);
    // Left the window, no online state: not listed.
    await fan(ofPage, "onlyfans", "7009", { seenMinutesAgo: 50 });
    // Wrote yesterday; the page's only message since went to five chats in one hour: a mass message, no answer.
    await thread("7010", await fan(ofPage, "onlyfans", "7010", { seenMinutesAgo: 7 }), { fanWroteMinutesAgo: 24 * 60, pageWroteMinutesAgo: 20 * 60 });
    await message("7010", { fromPage: false, minutesAgo: 24 * 60, text: "you up?" });
    for (const chat of ["7010", "7011", "7012", "7013", "7014"]) await message(chat, { fromPage: true, minutesAgo: 20 * 60, text: "the new set is up" });

    server = await buildApiServer(app);
    await server.ready();
    const signIn = await server.inject({
      method: "POST", url: "/api/v1/auth/device-tokens/password", headers: { "x-client-version": VERSION },
      payload: { username: "vanya", password: "vanya-secret", label: "Firefox", mode: "active", client: "chat-extension" },
    });
    token = signIn.json<{ token: string }>().token;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("lists who to write to now, why and with what; journals what the chatters did; keeps a Fansly tab's report", async (context) => {
    if (!testDb || !server) return context.skip();
    const trap = await armNoOutboundTrap(testDb);
    try {
      const list = await read("lora-of");
      expect(listed(list)).toEqual([
        ["7001", "waiting", "reply", null],
        ["7010", "waiting", "reply", null],
        ["7007", "waiting", "reply", "in_conversation"],
        ["7002", "new_unattended", "hi", null],
        ["7006", "expiring", "template_a", "wrote_recently"],
        ["7003", "silent", "ping", null],
        ["7004", "quiet", "template_a", null],
        ["7005", "never_wrote", "template_b", null],
        ["7008", "never_wrote", "template_b", null],
      ]);
      expect(list.items.find((item) => item.fanRef === "7007")?.asideBy).toBe("kate");
      expect(list.items.find((item) => item.fanRef === "7008")?.onlineSince).not.toBeNull();
      expect(list.items.find((item) => item.fanRef === "7005")).toMatchObject({ greetingName: "Fan", onlineSince: null, messageCount: 0 });
      expect(list.templates.map((template) => template.id)).toContain("B5");
      // A wider window takes the one who left.
      expect((await read("lora-of", 60)).items.map((item) => item.fanRef)).toContain("7009");

      // A Ping went to the silent payer from the window: set aside for three weeks, journaled under the chatter.
      const sent = await attempt("lora-of", { fanRef: "7003", action: "sent", act: "ping", reason: "silent" });
      expect(sent.statusCode, sent.body).toBe(200);
      expect((await read("lora-of")).items.find((item) => item.fanRef === "7003")?.aside).toBe("attempted_recently");
      // «Не предлагать» for the whole team, and its undo.
      expect((await attempt("lora-of", { fanRef: "7005", action: "dismissed" })).statusCode).toBe(200);
      expect((await read("lora-of")).items.find((item) => item.fanRef === "7005")).toMatchObject({ aside: "dismissed", asideBy: "vanya" });
      expect((await attempt("lora-of", { fanRef: "7005", action: "restored" })).statusCode).toBe(200);
      expect((await read("lora-of")).items.find((item) => item.fanRef === "7005")?.aside).toBeNull();
      expect((await attempt("lora-of", { fanRef: "999999", action: "dismissed" })).statusCode).toBe(409);
      expect((await q("select action, act, reason, user_id::text as who from online_attempts order by id")).rows).toEqual([
        { action: "sent", act: "ping", reason: "silent", who: String(vanya) },
        { action: "dismissed", act: null, reason: null, who: String(vanya) },
        { action: "restored", act: null, reason: null, who: String(vanya) },
      ]);
      expect(Number((await q("select count(*) from observations where kind = 'client.online_attempt.v1'")).rows[0].count)).toBe(3);

      // OnlyFansAPI reports an OnlyFans page's presence: a tab's report is refused there.
      const onOf = await server!.inject({
        method: "POST", url: "/api/v1/client/pages/lora-of/online/presence", headers: headers(),
        payload: { seen: [{ fanRef: "7005", lastSeenAt: new Date().toISOString() }] },
      });
      expect(onOf.statusCode).toBe(409);

      // A Fansly tab saw three fans: only the one linked to the page is kept, a moment in the future is not.
      const linked = "438766025723355136";
      await fan(fanslyPage, "fansly", linked);
      await fan(fanslyPage, "fansly", "438766025723355137", { linked: false });
      const minuteAgo = new Date(Date.now() - 60_000).toISOString();
      const report = await server!.inject({
        method: "POST", url: "/api/v1/client/pages/lora-1/online/presence", headers: headers(),
        payload: { seen: [
          { fanRef: linked, lastSeenAt: minuteAgo },
          { fanRef: "438766025723355137", lastSeenAt: minuteAgo },
          { fanRef: "438766025723355138", lastSeenAt: minuteAgo },
          { fanRef: linked, lastSeenAt: new Date(Date.now() + 10 * 60_000).toISOString() },
        ] },
      });
      expect(report.statusCode, report.body).toBe(200);
      expect(report.json()).toMatchObject({ recorded: 1, skipped: 3 });
      expect((await q(`select pf.external_presence_source as source, pf.external_presence_at = $2::timestamptz as exact
                       from page_fans pf join fans f on f.id = pf.fan_id where pf.platform_account_id = $1 and f.platform_user_id = $3`,
      [fanslyPage, minuteAgo, linked])).rows).toEqual([{ source: "fansly_extension_last_seen", exact: true }]);
      expect(Number((await q("select count(*) from observations where kind = 'client.online_presence.v1'")).rows[0].count)).toBe(1);
      expect(listed(await read("lora-1"))).toEqual([[linked, "never_wrote", "template_b", null]]);
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
