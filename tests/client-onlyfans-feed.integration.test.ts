import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { clientOnlyfansFeedResponseSchema, errorResponseSchema, type ClientOnlyfansFeedResponse } from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { takeOnlyfansFeedMoney } from "../apps/runtime/src/services/client-onlyfans-feed.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// onlyfans-feed-v1: what a chatter's ChatSpace already received, as a route.
//   POST /api/v1/client/pages/:pageLabel/onlyfans-feed   (clientOnlyfansFeed)
// On real rows: every record is journaled under the person, a repeat writes
// nothing, a socket message is news for the page's chats and a history page's
// is not, and money — held until the page's writer is `chatspace`, then
// replayed — counts one purchase once however many ways it was seen.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = { owner: "owner-secret", grisha: "grisha-secret", "chatspace-server": "server-secret" } as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/3.15.0";
const CREATOR = "433999001";
const HOST = "onlymonster:36408";
const FAN = "518588958";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let ownerCookie = "";
let grishaToken = "";
let serverToken = "";
let pageId = 0;
let seq = 7_200_000_000;
const nextId = () => String(++seq);
const now = () => new Date().toISOString();

const query = <Row extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  testDb!.pool.query<Row>(text, values).then((result) => result.rows);

function report(records: readonly Record<string, unknown>[], body: { creatorRef?: string; hostAccountRef?: string } = {}) {
  return server!.inject({
    method: "POST",
    url: "/api/v1/client/pages/lora-of/onlyfans-feed",
    headers: { authorization: `Bearer ${grishaToken}`, "x-client-version": EXTENSION_VERSION },
    payload: { hostAccountRef: body.hostAccountRef ?? HOST, creatorRef: body.creatorRef ?? CREATOR, records },
  });
}

async function ok(records: readonly Record<string, unknown>[]): Promise<ClientOnlyfansFeedResponse> {
  const response = await report(records);
  expect(response.statusCode, response.body).toBe(200);
  return clientOnlyfansFeedResponseSchema.parse(response.json());
}

const message = (over: Record<string, unknown> = {}) => ({
  kind: "message", messageRef: nextId(), fanRef: FAN, fromFan: true, sentAt: now(), observedAt: now(), via: "socket",
  textHtml: "<p>hey there</p>", price: null, isFree: true, isOpened: null, isNew: true, isTip: false, tipText: null,
  mediaCount: 0, media: [], automatic: false, changedAt: null,
  fan: {
    username: "u518588958", name: "Mike", displayName: null, subscribedOn: true, subscribedOnExpiredNow: false,
    subscribeAt: null, expiredAt: null, renewedAt: null, subscriptionStatus: null, subscribePrice: null, regularPrice: null, spend: null,
  },
  ...over,
});
const tip = (over: Record<string, unknown> = {}) => ({ kind: "tip", fanRef: FAN, tipRef: nextId(), amountGross: 5, observedAt: now(), ...over });
const ledger = (over: Record<string, unknown> = {}) => ({
  kind: "ledger", transactionRef: `om${nextId()}`, fanRef: FAN, createdAt: now(), amountGross: 5, amountNet: 4,
  description: "Tip from Mike", status: null, observedAt: now(), ...over,
});

const money = () => query<{ transaction_id: string; source: string; gross: string; net: string; canonical_type: string; is_active: boolean }>(
  `select transaction_id, source, gross_amount_mills::text as gross, creator_net_amount_mills::text as net, canonical_type::text, is_active
   from transactions where platform_account_id = $1 order by id`,
  [pageId],
);
const setWriter = (writer: string | null) => testDb!.pool.query("update pages set transactions_writer = $1 where id = $2", [writer, pageId]);

describe("the OnlyFans feed route", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    const grisha = await fixtureUserId(app, "grisha");
    await setUserPassword(app, { userId: grisha, password: PASSWORDS.grisha }, AUDIT);
    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    pageId = (await createOnlyFansPage(app.db, { modelId: lora!.id, label: "lora-of" }))!.id;
    await testDb.pool.query("update pages set external_page_id = $1 where id = $2", [CREATOR, pageId]);
    await assignPageToUser(app, { userId: grisha, pageLabel: "lora-of" }, AUDIT);
    await createUserAccount(app, { username: "chatspace-server", role: "chatter" }, AUDIT);
    const steady = await fixtureUserId(app, "chatspace-server");
    await setUserPassword(app, { userId: steady, password: PASSWORDS["chatspace-server"] }, AUDIT);
    await assignPageToUser(app, { userId: steady, pageLabel: "lora-of" }, AUDIT);

    server = await buildApiServer(app);
    await server.ready();
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: PASSWORDS.owner } });
    const header = login.headers["set-cookie"];
    ownerCookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
    const tokenOf = async (username: keyof typeof PASSWORDS) => {
      const signIn = await server!.inject({
        method: "POST",
        url: "/api/v1/auth/device-tokens/password",
        headers: { "x-client-version": EXTENSION_VERSION },
        payload: { username, password: PASSWORDS[username], label: "Firefox · ChatSpace", mode: "active", client: "chat-extension" },
      });
      expect(signIn.statusCode, signIn.body).toBe(200);
      return signIn.json<{ token: string }>().token;
    };
    grishaToken = await tokenOf("grisha");
    serverToken = await tokenOf("chatspace-server");
    const patched = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie: ownerCookie },
      payload: { patches: [{ key: "chatExtensionEnabled", value: true }, { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { ofFeed: true, ofPoll: true } }) }] },
    });
    expect(patched.statusCode, patched.body).toBe(200);
  }, 120_000);

  beforeEach((context) => {
    if (!testDb || !server) context.skip();
  });

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("journals each record under the person and makes a socket message news, a history page's not", async () => {
    const live = message();
    expect(await ok([live])).toMatchObject({ taken: 1, duplicates: 0 });
    // Another tab reports the same message the same way: nothing changes.
    expect(await ok([{ ...live, observedAt: now(), via: "history" }])).toMatchObject({ taken: 0, duplicates: 1 });
    const older = message({ via: "history", sentAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect(await ok([older])).toMatchObject({ taken: 1 });

    const [thread] = await query<{ unread_count: number; last_message_id: string; partner_username: string | null }>(
      "select unread_count, last_message_id, partner_username from page_dm_threads where platform_account_id = $1 and platform_conversation_id = $2",
      [pageId, FAN],
    );
    expect(thread).toEqual({ unread_count: 1, last_message_id: live.messageRef, partner_username: "u518588958" });
    const journal = await query<{ actor_principal_id: string; producer: string }>(
      "select actor_principal_id::text, producer from observations where kind = 'client.onlyfans_feed.v1' and account_id = $1",
      [pageId],
    );
    expect(journal).toHaveLength(2);
    expect(new Set(journal.map((row) => row.producer))).toEqual(new Set(["chat-extension@3.15.0"]));
    expect(new Set(journal.map((row) => row.actor_principal_id)).size).toBe(1);

    // The chat list's own count wins.
    expect(await ok([{ kind: "chat", fanRef: FAN, unreadCount: 0, lastMessageRef: live.messageRef, observedAt: now() }])).toMatchObject({ taken: 1 });
    const [read] = await query<{ unread_count: number }>("select unread_count from page_dm_threads where platform_account_id = $1", [pageId]);
    expect(read!.unread_count).toBe(0);
  });

  it("reaches the archive the AI context and the feed read, with OFAPI's own event key", async () => {
    const sent = message({ fromFan: false, fan: null, textHtml: "<p>miss you</p>", price: 12.5, isFree: false, isOpened: false, mediaCount: 2,
      media: [{ ref: "77", type: "photo", canView: true, duration: null }, { ref: "78", type: "video", canView: true, duration: 12 }] });
    expect(await ok([sent])).toMatchObject({ taken: 1 });
    await runCanonicalization(app, {});
    await runMessageArchiveProjection(app, { accountId: pageId });
    const [archived] = await query<{ text_plain: string; is_sent_by_me: boolean; price_mills: string; is_opened: boolean; media: number; origin_class: string }>(
      `select text_plain, is_sent_by_me, price_mills::text, is_opened, jsonb_array_length(media_metadata) as media, origin_class
       from message_archive where account_id = $1 and message_ref = $2`,
      [pageId, sent.messageRef],
    );
    expect(archived).toEqual({ text_plain: "miss you", is_sent_by_me: true, price_mills: "12500", is_opened: false, media: 2, origin_class: "chatspace_feed" });
    const keys = await query<{ dedup_key: string }>("select dedup_key from domain_event_keys where account_id = $1 and dedup_key like $2", [pageId, `%${sent.messageRef}%`]);
    expect(keys.map((row) => row.dedup_key)).toContain(`msg:sent:${sent.messageRef}`);

    // The fan bought it: the archive and the page's chats know.
    expect(await ok([{ kind: "ppv", fanRef: FAN, contentType: "message", contentRef: sent.messageRef, priceGross: 12.5, observedAt: now() }])).toMatchObject({ taken: 0, held: 1 });
    await runCanonicalization(app, {});
    await runMessageArchiveProjection(app, { accountId: pageId });
    const [opened] = await query<{ is_opened: boolean }>("select is_opened from message_archive where account_id = $1 and message_ref = $2", [pageId, sent.messageRef]);
    expect(opened!.is_opened).toBe(true);
    const [bought] = await query<{ purchased_at: Date | null }>(
      "select purchased_at from page_dm_messages where platform_account_id = $1 and platform_message_id = $2", [pageId, sent.messageRef],
    );
    expect(bought!.purchased_at).not.toBeNull();
  });

  it("lends the page's poll to one tab at a time, the always-on tab first, and reads back to what the feed brought", async () => {
    const poll = (token: string) => server!.inject({
      method: "POST",
      url: "/api/v1/client/pages/lora-of/onlyfans-feed/poll",
      headers: { authorization: `Bearer ${token}`, "x-client-version": EXTENSION_VERSION },
      payload: { hostAccountRef: HOST, creatorRef: CREATOR },
    }).then((response) => {
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ granted: boolean; holder: string | null; cursors: { subscribers: string | null; ledger: string | null } }>();
    });
    // The always-on tab asks first: it holds the poll; a chatter's tab is not lent it, now or once it is due again.
    expect(await poll(serverToken)).toMatchObject({ granted: true, holder: "server", cursors: { subscribers: null } });
    expect(await poll(grishaToken)).toMatchObject({ granted: false, holder: "server" });
    await testDb!.pool.query("update onlyfans_feed_poll_leases set next_at = now() - interval '1 second' where platform_account_id = $1", [pageId]);
    expect(await poll(grishaToken)).toMatchObject({ granted: false });
    // The always-on tab is gone for a while: a chatter's tab takes over.
    await testDb!.pool.query("update onlyfans_feed_poll_leases set server_seen_at = now() - interval '20 minutes' where platform_account_id = $1", [pageId]);
    expect(await poll(grishaToken)).toMatchObject({ granted: true, holder: "tab" });
    expect(await poll(grishaToken)).toMatchObject({ granted: false });

    // What the poll read reaches «Новые» under OFAPI's own key, and the hub's cursor moves to it.
    const createdAt = "2026-10-31T21:05:00.000Z";
    expect(await ok([{ kind: "subscriber", notificationRef: "88001", fanRef: FAN, subType: "new_subscriber", createdAt, observedAt: now() }])).toMatchObject({ taken: 1 });
    await runCanonicalization(app, {});
    const [event] = await query<{ type: string; sub_type: string }>(
      "select e.type, e.data->>'subType' as sub_type from domain_events e join domain_event_keys k on k.account_id = e.account_id and k.dedup_key = $2 where e.account_id = $1 and e.id = k.event_id",
      [pageId, `sub:started:${FAN}:${createdAt}`],
    );
    expect(event).toEqual({ type: "subscription.started", sub_type: "new_subscriber" });
    await testDb!.pool.query("update onlyfans_feed_poll_leases set next_at = now() - interval '1 second' where platform_account_id = $1", [pageId]);
    expect((await poll(grishaToken)).cursors.subscribers).toBe("88001");
  });

  it("refuses a report whose account is not the page's", async () => {
    const response = await report([message()], { creatorRef: "999" });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorResponseSchema.parse(response.json()).reason).toBe("binding_mismatch");
  });

  it("holds money while OFAPI writes, then the cutoff applies it once", async () => {
    await setWriter("ofapi");
    const held = tip();
    expect(await ok([held])).toMatchObject({ held: 1, taken: 0 });
    expect(await money()).toEqual([]);

    const first = await takeOnlyfansFeedMoney(app, { pageLabel: "lora-of", since: new Date(Date.now() - 3_600_000), dryRun: false });
    // The tip, and the purchase held in the test before (the page had no writer then).
    expect(first).toMatchObject({ previousWriter: "ofapi", records: 2, written: 2 });
    const again = await takeOnlyfansFeedMoney(app, { pageLabel: "lora-of", since: new Date(Date.now() - 3_600_000), dryRun: false });
    expect(again).toMatchObject({ previousWriter: "chatspace", written: 0, known: 2 });
    const rows = await money();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.transaction_id === `chatspace:tip:${held.tipRef}`)).toEqual({
      transaction_id: `chatspace:tip:${held.tipRef}`, source: "chatspace:ws", gross: "5000", net: "4000", canonical_type: "tip", is_active: true,
    });
    expect(rows.find((row) => row.canonical_type === "message_purchase")).toMatchObject({ source: "chatspace:ws", gross: "12500", net: "10000" });
  });

  it("counts a purchase the socket and the ledger both saw once, two equal tips twice, and a chargeback beside it", async () => {
    await testDb!.pool.query("delete from onlyfans_feed_money_claims where platform_account_id = $1", [pageId]);
    await testDb!.pool.query("delete from transactions where platform_account_id = $1", [pageId]);
    await setWriter("chatspace");

    const one = tip();
    const two = tip();
    expect(await ok([one, two])).toMatchObject({ taken: 2 });
    // The ledger lists both under its own ids, with their nets: each claims one row, none is added.
    expect(await ok([ledger({ amountNet: 4.1 }), ledger({ amountNet: 4.1 })])).toMatchObject({ taken: 2 });
    let rows = await money();
    expect(rows.map((row) => [row.source, row.gross, row.net])).toEqual([
      ["chatspace:ws", "5000", "4100"],
      ["chatspace:ws", "5000", "4100"],
    ]);

    // A purchase an earlier writer counted: the socket's sighting claims it.
    await testDb!.pool.query(
      `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, correlation_account_id, occurred_at, source)
       values ($1, 'e940b5fb905ba0815d5842a7bde1118c', 'ofapi:message', 'message_purchase', 'posted', 'done', 25000, 25000, 20000, $2, now(), 'ofapi:webhook')`,
      [pageId, FAN],
    );
    expect(await ok([{ kind: "ppv", fanRef: FAN, contentType: "message", contentRef: nextId(), priceGross: 25, observedAt: now() }])).toMatchObject({ taken: 1 });
    rows = await money();
    expect(rows).toHaveLength(3);

    // The ledger shows that purchase charged back, under OnlyFans' own id: the reversal is written beside it.
    expect(await ok([ledger({
      transactionRef: "e940b5fb905ba0815d5842a7bde1118c", amountGross: 25, amountNet: 20, description: "Payment for message from Mike", status: "undo",
    })])).toMatchObject({ taken: 1 });
    rows = await money();
    expect(rows.at(-1)).toMatchObject({
      transaction_id: "e940b5fb905ba0815d5842a7bde1118c:reversal", source: "chatspace:ledger", gross: "-25000", net: "-20000", canonical_type: "chargeback",
    });
    expect(rows).toHaveLength(4);
  });
});
