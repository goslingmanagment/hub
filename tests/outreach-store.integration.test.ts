import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  clientOutreachesResponseSchema,
  clientOutreachSaveResponseSchema,
  clientOutreachSchema,
  clientOutreachSendResponseSchema,
  clientOutreachTouchesResponseSchema,
} from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, listOnlineCandidates } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// «Рассылки» kept by Hub (docs/plans/2026-11-01-outreach-store/spec.md): an
// outreach saved by one person is listed, read and continued by everyone
// granted the page; a fan's version stays as it is once his send is claimed;
// a fan's send is claimed once per outreach (`taken`) and once at a time per
// page (`busy`); a claim past its ticket reads uncertain and is never claimed
// again, a late report still lands; the archive proves an uncertain send;
// what came of a send is Hub's; the touches of the last 3 days; an outreach's
// send holds the fan out of «Онлайн» and fan queues; another page's outreach
// is not found; a person without the page is refused; an outreach untouched
// for 90 days goes.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const VERSION = "chat-extension/3.16.0";
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let page = 0;
let otherPage = 0;
const tokens: Record<string, string> = {};
const fanIds = new Map<string, number>();
let messageSeq = 9_800_000_000;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const client = (who: string, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}`, "x-client-version": VERSION }, ...(payload ? { payload } : {}) });

/** A follower of `pageId` with his chat (group `9<ref>`). */
async function fan(ref: string, pageId = page) {
  const id = Number((await q(
    "insert into fans (platform, platform_user_id, username, first_seen_at) values ('fansly', $1, $2, now() - interval '200 days') returning id",
    [ref, `fan${ref}`],
  )).rows[0].id);
  await q("insert into page_fans (fan_id, platform_account_id, is_follower, follower_since) values ($1, $2, true, now() - interval '30 days')", [id, pageId]);
  await q(`insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, last_message_at, is_visible)
           values ($1, $2, $3, $4, now() - interval '10 days', true)`, [pageId, id, `9${ref}`, ref]);
  fanIds.set(ref, id);
  return id;
}

/** A message of the page's archive in the fan's chat, `minutesAgo` (negative: from now on). */
async function archived(ref: string, input: { byPage: boolean; minutesAgo: number; text: string }) {
  messageSeq += 1;
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain)
           values ($1, 'fansly', $2, $3, $4, $5, now() - interval '1 minute' * $6, $7)`,
    [page, `9${ref}`, String(messageSeq), input.byPage ? "creator" : "fan", input.byPage, input.minutesAgo, input.text]);
  return String(messageSeq);
}

const base = "/api/v1/client/pages/lora-1/outreaches";
async function save(who: string, id: string, body: Record<string, unknown>) {
  const response = await client(who, "POST", `${base}/${id}`, body);
  expect(response.statusCode, response.body).toBe(200);
  return clientOutreachSaveResponseSchema.parse(response.json());
}
async function read(who: string, id: string) {
  const response = await client(who, "GET", `${base}/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return clientOutreachSchema.parse(response.json());
}
async function send(who: string, id: string, body: Record<string, unknown>) {
  const response = await client(who, "POST", `${base}/${id}/sends`, body);
  expect(response.statusCode, response.body).toBe(200);
  return clientOutreachSendResponseSchema.parse(response.json());
}
const claim = (who: string, id: string, fanRef: string, attemptId: string, text = `Hey ${fanRef}, the new set is up`) =>
  send(who, id, { action: "claim", fanRef, attemptId, text, media: { vault: ["m1"], priceMills: 10_000 } });
const fanOf = <F extends { fanRef: string }>(outreach: { fans: F[] }, ref: string) => outreach.fans.find((one) => one.fanRef === ref);

describe("outreaches kept by Hub", () => {
  const A = randomUUID();
  const C = randomUUID();

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "dima", role: "owner", password: "dima-secret" }, { source: "cli" });
    for (const name of ["max", "vanya", "outsider"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-secret` }, { source: "cli" });
    }
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    page = (await createFanslyPage(app.db, { modelId: model!.id, label: "lora-1" }))!.id;
    otherPage = (await createFanslyPage(app.db, { modelId: model!.id, label: "lora-2" }))!.id;
    for (const name of ["max", "vanya"]) await assignPageToUser(app, { userId: await fixtureUserId(app, name), pageLabel: "lora-1" }, { source: "cli" });
    await assignPageToUser(app, { userId: await fixtureUserId(app, "max"), pageLabel: "lora-2" }, { source: "cli" });
    for (let i = 1; i <= 8; i++) await fan(`800${i}`);
    await fan("8101", otherPage);

    server = await buildApiServer(app);
    await server.ready();
    for (const name of ["max", "vanya", "outsider"]) {
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

  it("keeps an outreach one person made for the whole team of the page", async (context) => {
    if (!testDb) return context.skip();
    const createdAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    const made = await save("max", A, {
      text: "New set is up 🔥", withMedia: true, settings: { audience: "spenders", without3Days: true }, createdAt,
      order: ["8001", "8002", "8003", "8004", "8005", "8001"],
      fans: [
        { fanRef: "8001", version: "Hey 8001, the new set is up", basis: "h1", generationRef: "gen-1" },
        { fanRef: "8002", version: "Hey 8002", basis: "h1" },
        { fanRef: "8002", edit: "Hey you, 8002" },
      ],
    });
    expect(made.author).toEqual({ name: "max", isMe: true });
    expect(made.createdAt).toBe(createdAt);
    expect(made.order).toEqual(["8001", "8002", "8003", "8004", "8005"]);
    expect(made.kept).toEqual([]);
    expect(made.fans.map((one) => [one.fanRef, one.version, one.basis, one.edit])).toEqual([
      ["8001", "Hey 8001, the new set is up", "h1", null],
      ["8002", "Hey 8002", "h1", "Hey you, 8002"],
    ]);
    expect(fanOf(made, "8002")!.editedBy).toEqual({ name: "max", isMe: true });

    // A colleague lists it, opens it and continues it: the last save wins each field.
    const listed = clientOutreachesResponseSchema.parse((await client("vanya", "GET", base)).json());
    expect(listed.outreaches.map((one) => [one.outreachId, one.author.name, one.author.isMe, one.fans, one.written, one.withMedia]))
      .toEqual([[A, "max", false, 5, 2, true]]);
    const opened = await read("vanya", A);
    expect(opened.settings).toEqual({ audience: "spenders", without3Days: true });
    const changed = await save("vanya", A, { text: "New set is up", fans: [{ fanRef: "8002", edit: null }, { fanRef: "8003", version: null }] });
    expect(changed.updatedBy).toEqual({ name: "vanya", isMe: true });
    expect(changed.author).toEqual({ name: "max", isMe: false });
    expect(changed.text).toBe("New set is up");
    expect(changed.withMedia).toBe(true);
    expect(changed.createdAt).toBe(createdAt);
    expect(fanOf(changed, "8002")).toMatchObject({ version: "Hey 8002", edit: null, editedBy: null });
    // A fan left with nothing is no fan of the outreach.
    expect(fanOf(changed, "8003")).toBeUndefined();
  });

  it("refuses a fan Hub does not know on the page, another page's outreach, settings over 32 KiB", async (context) => {
    if (!testDb) return context.skip();
    const unknown = await client("max", "POST", `${base}/${A}`, { fans: [{ fanRef: "9999999", version: "hi", basis: "h1" }] });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ reason: "fan_not_found" });
    const elsewhere = await client("max", "POST", `${base}/${A}`, { fans: [{ fanRef: "8101", version: "hi", basis: "h1" }] });
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json()).toMatchObject({ reason: "fan_not_found" });

    const B = randomUUID();
    const onOther = await client("max", "POST", `/api/v1/client/pages/lora-2/outreaches/${B}`, { text: "Other page" });
    expect(onOther.statusCode, onOther.body).toBe(200);
    const saved = await client("max", "POST", `${base}/${B}`, { text: "Hijack" });
    expect(saved.statusCode).toBe(409);
    expect(saved.json()).toMatchObject({ reason: "outreach_not_found" });
    const got = await client("max", "GET", `${base}/${B}`);
    expect(got.statusCode).toBe(404);
    expect(got.json()).toMatchObject({ error: "not_found", reason: "outreach_not_found" });
    const sent = await client("max", "POST", `${base}/${B}/sends`, { action: "uncertain", fanRef: "8001", attemptId: randomUUID() });
    expect(sent.statusCode).toBe(404);
    expect((await client("max", "GET", `${base}/${randomUUID()}`)).statusCode).toBe(404);

    const big = await client("max", "POST", `${base}/${A}`, { settings: { blob: "x".repeat(33 * 1024) } });
    expect(big.statusCode).toBe(400);

    // A person without the page is refused before the route, like on every client page route.
    expect((await client("outsider", "GET", base)).statusCode).toBe(403);
  });

  it("claims a fan's send once: a second click is taken with who and when; the version stays as it went", async (context) => {
    if (!testDb) return context.skip();
    const x = randomUUID();
    const claimed = await claim("max", A, "8001", x);
    expect(claimed.outcome).toBe("ok");
    expect(claimed.fan.send).toMatchObject({ state: "sending", attemptId: x, by: { name: "max", isMe: true }, text: "Hey 8001, the new set is up" });
    expect(claimed.fan.send!.ticketUntil).not.toBeNull();
    // The same click again (a lost answer) is the same claim.
    expect((await claim("max", A, "8001", x)).outcome).toBe("ok");

    const second = await claim("vanya", A, "8001", randomUUID());
    expect(second.outcome).toBe("taken");
    expect(second.fan.send).toMatchObject({ state: "sending", by: { name: "max", isMe: false } });
    // Only the claim's own attempt reports it.
    expect((await send("vanya", A, { action: "sent", fanRef: "8001", attemptId: x })).outcome).toBe("not_yours");

    // A colleague's change to a claimed fan is kept back; the rest of the save passes.
    const kept = await save("vanya", A, { fans: [{ fanRef: "8001", version: "Other words", basis: "h2" }, { fanRef: "8004", version: "Hey 8004", basis: "h2" }] });
    expect(kept.kept).toEqual(["8001"]);
    expect(fanOf(kept, "8001")!.version).toBe("Hey 8001, the new set is up");
    expect(fanOf(kept, "8004")!.version).toBe("Hey 8004");

    const done = await send("max", A, { action: "sent", fanRef: "8001", attemptId: x, platformMessageId: "700000000001" });
    expect(done.outcome).toBe("ok");
    expect(done.fan.send).toMatchObject({ state: "sent", platformMessageId: "700000000001", ticketUntil: null, resolvedBy: null });
    expect(done.fan.outcome).toEqual({ replied: null, bought: null });
    expect((await send("max", A, { action: "sent", fanRef: "8001", attemptId: x })).outcome).toBe("ok");
    expect((await claim("max", A, "8001", randomUUID())).outcome).toBe("taken");

    // Every report is journaled first; a claim is not.
    const journal = await q(
      "select payload->>'action' as action from observations where kind = 'client.outreach_send.v1' and payload->>'fanRef' = '8001' order by id",
    );
    expect(journal.rows.map((row) => row.action)).toEqual(["sent", "sent", "sent"]);
  });

  it("holds a fan of the page for one claim at a time; a claim past its ticket is uncertain, a late report lands", async (context) => {
    if (!testDb) return context.skip();
    await save("vanya", C, { text: "Another outreach", order: ["8003"] });
    const first = randomUUID();
    expect((await claim("max", A, "8003", first)).outcome).toBe("ok");
    const busy = await claim("vanya", C, "8003", randomUUID());
    expect(busy.outcome).toBe("busy");
    expect(busy.fan.send).toBeNull();

    // The tab closed after the claim: 120 seconds later it reads uncertain everywhere, and never goes again.
    await q("update client_outreach_fans set ticket_until = now() - interval '1 second' where outreach_id = $1 and fan_ref = '8003'", [A]);
    expect(fanOf(await read("max", A), "8003")!.send).toMatchObject({ state: "uncertain", ticketUntil: null });
    expect((await claim("max", A, "8003", randomUUID())).outcome).toBe("taken");
    // The other outreach may claim him now; the expired claim is stored uncertain first.
    const other = randomUUID();
    expect((await claim("vanya", C, "8003", other)).outcome).toBe("ok");
    expect((await q("select send_state from client_outreach_fans where outreach_id = $1 and fan_ref = '8003'", [A])).rows[0].send_state)
      .toBe("uncertain");
    expect((await send("vanya", C, { action: "uncertain", fanRef: "8003", attemptId: other })).outcome).toBe("ok");

    // The late report of the first claim still lands.
    const late = await send("max", A, { action: "sent", fanRef: "8003", attemptId: first });
    expect(late.outcome).toBe("ok");
    expect(late.fan.send!.state).toBe("sent");

    // A refusal the platform proved frees the fan for a new claim.
    const refused = randomUUID();
    expect((await claim("max", A, "8004", refused)).outcome).toBe("ok");
    const failed = await send("max", A, { action: "failed", fanRef: "8004", attemptId: refused, code: "CG-FANSLY-403" });
    expect(failed.fan.send).toMatchObject({ state: "failed", code: "CG-FANSLY-403" });
    expect((await send("max", A, { action: "sent", fanRef: "8004", attemptId: refused })).outcome).toBe("not_yours");
    expect((await claim("vanya", A, "8004", randomUUID())).outcome).toBe("ok");
  });

  it("settles an uncertain send as sent when the archive holds the page's message with its text", async (context) => {
    if (!testDb) return context.skip();
    const attempt = randomUUID();
    await claim("max", A, "8005", attempt, "Hey 8005,   the NEW set is up 🔥");
    expect((await send("max", A, { action: "uncertain", fanRef: "8005", attemptId: attempt })).fan.send!.state).toBe("uncertain");
    // Another text, then the page's own message with the same words.
    await archived("8005", { byPage: true, minutesAgo: 0, text: "something else" });
    const messageRef = await archived("8005", { byPage: true, minutesAgo: -1, text: "<p>hey 8005, the new set is up 🔥</p>" });
    const settled = fanOf(await read("max", A), "8005")!;
    expect(settled.send).toMatchObject({ state: "sent", resolvedBy: "archive", platformMessageId: messageRef });
    // Nothing to report any more but the same: the archive proved it.
    expect((await send("max", A, { action: "failed", fanRef: "8005", attemptId: attempt, code: "late" })).outcome).toBe("not_yours");
  });

  it("counts what came of a send: the fan's answer within 72 hours and his money within 7 days", async (context) => {
    if (!testDb) return context.skip();
    await q(`update client_outreach_fans set clicked_at = now() - interval '3 hours', sent_at = now() - interval '3 hours'
             where outreach_id = $1 and fan_ref = '8001'`, [A]);
    await archived("8001", { byPage: false, minutesAgo: 4 * 60, text: "before the send" });
    await archived("8001", { byPage: false, minutesAgo: 120, text: "<p>wow &amp; thanks</p>" });
    await archived("8001", { byPage: false, minutesAgo: 60, text: "later" });
    for (const [id, mills, minutesAgo, type] of [["tx-1", 5_000, 90, "tip"], ["tx-2", 2_000, 30, "tip"], ["tx-3", 9_000, 20, "chargeback"]] as const) {
      await q(`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
                 gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
               values ($1, $2, $3, $4, $4::transaction_type, 'posted', 'ok', $5, $5, $5, now() - interval '1 minute' * $6, 'fansly:rest', 'USD')`,
        [page, fanIds.get("8001"), id, type, mills, minutesAgo]);
    }
    const outreach = await read("vanya", A);
    const outcome = fanOf(outreach, "8001")!.outcome!;
    expect(outcome.replied?.text).toBe("wow & thanks");
    expect(outcome.bought?.mills).toBe(7_000);
    expect(new Date(outcome.bought!.at).getTime()).toBeLessThan(Date.now() - 80 * 60_000);

    const listed = clientOutreachesResponseSchema.parse((await client("max", "GET", base)).json());
    const summary = listed.outreaches.find((one) => one.outreachId === A)!;
    expect(summary).toMatchObject({ fans: 5, sent: 3, failed: 0, replied: 1, bought: 1, boughtMills: 7_000 });
    // Vanya's claim of 8004: on its way, or uncertain once its ticket ran out.
    expect(summary.sending + summary.uncertain).toBe(1);
    expect(summary.lastSentAt).not.toBeNull();
    expect(listed.outreaches.map((one) => one.outreachId)).toEqual([A, C]);
  });

  it("answers the fans touched within 3 days by an outreach, a fan queue or «Онлайн», the latest each", async (context) => {
    if (!testDb) return context.skip();
    const maxId = await fixtureUserId(app, "max");
    const vanyaId = await fixtureUserId(app, "vanya");
    await q(`insert into online_attempts (page_id, fan_id, fan_ref, user_id, action, attempted_at)
             values ($1, $2, '8006', $3, 'sent', now() - interval '2 hours'), ($1, $4, '8007', $3, 'sent', now() - interval '4 days')`,
      [page, fanIds.get("8006"), maxId, fanIds.get("8007")]);
    const queue = Number((await q(
      "insert into fan_queues (page_id, name, scenario, requested_by_user_id, created_by_user_id) values ($1, 'Q', '{}'::jsonb, $2, $2) returning id",
      [page, vanyaId],
    )).rows[0].id);
    await q(`insert into fan_queue_items (queue_id, page_id, fan_id, fan_ref, rank, state, done_at, done_by_user_id)
             values ($1, $2, $3, '8008', 1, 'sent', now() - interval '1 hour', $4)`, [queue, page, fanIds.get("8008"), vanyaId]);

    const touches = clientOutreachTouchesResponseSchema.parse((await client("vanya", "GET", "/api/v1/client/pages/lora-1/outreach-touches")).json());
    expect(touches.hours).toBe(72);
    const byFan = new Map(touches.fans.map((one) => [one.fanRef, one]));
    expect(byFan.get("8001")).toMatchObject({ kind: "outreach", outreachId: A, by: { name: "max", isMe: false } });
    expect(byFan.get("8006")).toMatchObject({ kind: "online", outreachId: null, by: { name: "max", isMe: false } });
    expect(byFan.get("8008")).toMatchObject({ kind: "queue", by: { name: "vanya", isMe: true } });
    // The latest of two outreaches' sends: max's, reported sent after vanya's uncertain one.
    expect(byFan.get("8003")).toMatchObject({ kind: "outreach", outreachId: A, by: { name: "max", isMe: false } });
    expect(byFan.has("8007")).toBe(false);
    expect(touches.fans.map((one) => one.at)).toEqual([...touches.fans.map((one) => one.at)].sort().reverse());
  });

  it("holds a fan an outreach wrote to out of «Онлайн» and fan queues like their own sends", async (context) => {
    if (!testDb) return context.skip();
    const [row] = await listOnlineCandidates(app.db, {
      pageId: page, platform: "fansly", now: new Date(), minutes: 0, onlineRefs: [], limit: 1, fanIds: [fanIds.get("8002")!],
    });
    expect(row!.lastSentAttemptAt).toBeNull();
    const attempt = randomUUID();
    await claim("vanya", A, "8002", attempt);
    await send("vanya", A, { action: "sent", fanRef: "8002", attemptId: attempt });
    const [after] = await listOnlineCandidates(app.db, {
      pageId: page, platform: "fansly", now: new Date(), minutes: 0, onlineRefs: [], limit: 1, fanIds: [fanIds.get("8002")!],
    });
    expect(after!.lastSentAttemptAt).not.toBeNull();
    expect(Date.now() - after!.lastSentAttemptAt!.getTime()).toBeLessThan(60_000);
  });

  it("records a send made before the outreach reached Hub once, and only for a fan with no send", async (context) => {
    if (!testDb) return context.skip();
    const D = randomUUID();
    await save("max", D, { text: "From the browser", order: ["8006", "8007"] });
    const clickedAt = new Date(Date.now() - 3600_000).toISOString();
    const attempt = randomUUID();
    const body = { action: "record", fanRef: "8006", attemptId: attempt, state: "sent", clickedAt, text: "Hey 8006", media: null, platformMessageId: "700000000006" };
    const recorded = await send("max", D, body);
    expect(recorded.outcome).toBe("ok");
    expect(recorded.fan.send).toMatchObject({ state: "sent", clickedAt, sentAt: clickedAt, by: { name: "max", isMe: true } });
    expect((await send("max", D, body)).outcome).toBe("ok");
    expect((await send("max", D, { ...body, attemptId: randomUUID(), state: "uncertain" })).outcome).toBe("taken");
    const old = await client("max", "POST", `${base}/${D}/sends`, {
      ...body, fanRef: "8007", attemptId: randomUUID(), clickedAt: new Date(Date.now() - 40 * 24 * 3600_000).toISOString(),
    });
    expect(old.statusCode).toBe(400);
  });

  it("deletes the page's outreaches untouched for 90 days when its list is read", async (context) => {
    if (!testDb) return context.skip();
    await q("update client_outreaches set updated_at = now() - interval '91 days' where id = $1", [C]);
    const listed = clientOutreachesResponseSchema.parse((await client("max", "GET", base)).json());
    expect(listed.outreaches.map((one) => one.outreachId)).not.toContain(C);
    expect((await q("select count(*)::int as n from client_outreach_fans where outreach_id = $1", [C])).rows[0].n).toBe(0);
    expect((await q("select count(*)::int as n from client_outreaches where id = $1", [C])).rows[0].n).toBe(0);
  });
});
