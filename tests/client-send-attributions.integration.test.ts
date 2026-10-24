import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientSendAttributionsResponseSchema,
  errorResponseSchema,
  type ClientSendAttributionsResponse,
} from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  assignPageToUser,
  createUserAccount,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// send-attribution-v1: who sent each outgoing message, as a route.
//   POST /api/v1/client/pages/:pageLabel/send-attributions   (clientSendAttributions)
// The shapes and the pure rules are tests/client-send-attributions-contract.test.ts;
// this file holds what the route does on real rows: the person is the token's,
// the first report wins, a repeat changes nothing, a page that is not the
// caller's is refused, no switch stands in the way, nothing leaves the process,
// and erasure takes a fan's rows and a page's. Every test runs under the
// no-outbound trap.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = { owner: "owner-secret", grisha: "grisha-secret", nikita: "nikita-secret" } as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}sendattrib0000000000`;
const SOURCE = "chatspace-extension";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Fact = {
  platformMessageId: string; fanRef: string; conversationRef?: string; observedAt: string; priced: boolean; withMedia: boolean;
  composedWith?: string; edited?: boolean;
};

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
let grishaCookie = "";
let ownerToken = "";
/** Narrow chat-extension tokens of two chatters of lora-of. */
let grishaToken = "";
let nikitaToken = "";
/** A full device token of a chatter of mia-of only. */
let svetaToken = "";
const userIds: Record<"owner" | "grisha" | "nikita" | "sveta", number> = { owner: 0, grisha: 0, nikita: 0, sveta: 0 };
const pageIds: Record<string, number> = {};
let seq = 7_100_000_000;
const nextId = () => String(++seq);

function bearer(token: string, clientVersion: string | null = EXTENSION_VERSION): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(clientVersion === null ? {} : { "x-client-version": clientVersion }) };
}

const fact = (over: Partial<Fact> = {}): Fact => ({
  platformMessageId: nextId(),
  fanRef: "518588958",
  observedAt: new Date().toISOString(),
  priced: false,
  withMedia: false,
  ...over,
});

function report(headers: Record<string, string>, facts: readonly Fact[], options: { pageLabel?: string; source?: string } = {}) {
  return server!.inject({
    method: "POST",
    url: `/api/v1/client/pages/${options.pageLabel ?? "lora-of"}/send-attributions`,
    headers,
    payload: { source: options.source ?? SOURCE, facts },
  });
}

function ok(response: InjectResponse): ClientSendAttributionsResponse {
  expect(response.statusCode, response.body).toBe(200);
  const body = clientSendAttributionsResponseSchema.parse(response.json());
  expect(response.json()).toEqual(body);
  // Nobody is named in an answer: the first reporter of a message stays the hub's.
  expect(response.body).not.toMatch(/grisha|nikita|sveta|userId/i);
  return body;
}

const outcomes = (body: ClientSendAttributionsResponse) => body.results.map((result) => result.outcome);

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode });
  expect(body.reason, response.body).toBe(reason);
}

const query = <Row extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  testDb!.pool.query<Row>(text, values).then((result) => result.rows);

const rowsOf = (ids: readonly string[]) => query<{
  platform: string; page_id: string; platform_message_id: string; fan_ref: string; conversation_ref: string | null;
  user_id: string; source: string; priced: boolean; with_media: boolean; observed_at: Date; client_version: string | null;
}>(
  `select platform, page_id::text, platform_message_id, fan_ref, conversation_ref, user_id::text, source, priced,
     with_media, observed_at, client_version
   from client_send_attributions where platform_message_id = any($1::text[]) order by platform_message_id`,
  [ids],
);

async function patchConfig(patches: Array<{ key: string; value: unknown }>) {
  const response = await server!.inject({ method: "PATCH", url: "/api/v1/admin/config", headers: { cookie: ownerCookie }, payload: { patches } });
  expect(response.statusCode, response.body).toBe(200);
}

async function loginCookie(username: "owner" | "grisha"): Promise<string> {
  const login = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORDS[username] } });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}

async function narrowTokenOf(username: "grisha" | "nikita"): Promise<string> {
  const signIn = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/device-tokens/password",
    headers: { "x-client-version": EXTENSION_VERSION },
    payload: { username, password: PASSWORDS[username], label: "Firefox · macOS · ChatSpace", mode: "active", client: "chat-extension" },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  return signIn.json<{ token: string }>().token;
}

describe("chat-extension send attribution route", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);

    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    for (const username of ["grisha", "nikita", "sveta"]) {
      await createUserAccount(app, { username, role: "chatter" }, AUDIT);
    }
    for (const username of ["owner", "grisha", "nikita", "sveta"] as const) {
      userIds[username] = await fixtureUserId(app, username);
    }
    await setUserPassword(app, { userId: userIds.grisha, password: PASSWORDS.grisha }, AUDIT);
    await setUserPassword(app, { userId: userIds.nikita, password: PASSWORDS.nikita }, AUDIT);

    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const [label, create] of [
      ["lora-of", createOnlyFansPage],
      ["mia-of", createOnlyFansPage],
      ["lora-fansly", createFanslyPage],
    ] as const) {
      pageIds[label] = (await create(app.db, { modelId: lora!.id, label }))!.id;
    }
    for (const [userId, labels] of [
      [userIds.grisha, ["lora-of", "lora-fansly"]],
      [userIds.nikita, ["lora-of"]],
      [userIds.sveta, ["mia-of"]],
    ] as const) {
      for (const pageLabel of labels) await assignPageToUser(app, { userId, pageLabel }, AUDIT);
    }
    // A chat with unread messages, so the trap's unread check has something to hold.
    await testDb.pool.query(
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, '518588958', 3)",
      [pageIds["lora-of"]],
    );

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: userIds.owner, label: "owner client" })).token;
    svetaToken = (await issueDeviceTokenForUserId(app, { userId: userIds.sveta, label: "sveta client" })).token;
    await insertAgentKey(app.db, {
      name: "send-attribution-probe",
      keyPrefix: AGENT_KEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY_TOKEN),
      capabilities: ["read:messages"],
      pageIds: [pageIds["lora-of"]!],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: null,
    });

    server = await buildApiServer(app);
    await server.ready();
    grishaToken = await narrowTokenOf("grisha");
    nikitaToken = await narrowTokenOf("nikita");
    ownerCookie = await loginCookie("owner");
    grishaCookie = await loginCookie("grisha");
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    await testDb.pool.query("delete from config_settings where key like 'chatExtension%'");
    trap = await armNoOutboundTrap(testDb);
  });

  afterEach(async () => {
    await trap?.restore();
    trap = null;
  });

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("records the token's person for each message: ids, the two marks, the time and the version — and no text anywhere", async () => {
    // The row keeps the client's time as it was given, a minute before the report.
    const ppv = fact({ priced: true, withMedia: true, observedAt: new Date(Date.now() - 60_000).toISOString() });
    const plain = fact({ fanRef: "518588959" });
    const body = ok(await report(bearer(grishaToken), [ppv, plain]));
    expect(body.pageLabel).toBe("lora-of");
    expect(body.results).toEqual([
      { platformMessageId: ppv.platformMessageId, outcome: "recorded" },
      { platformMessageId: plain.platformMessageId, outcome: "recorded" },
    ]);
    const rows = await rowsOf([ppv.platformMessageId, plain.platformMessageId]);
    expect(rows.map((row) => ({ ...row, observed_at: new Date(row.observed_at).toISOString() }))).toEqual([
      {
        platform: "onlyfans", page_id: String(pageIds["lora-of"]), platform_message_id: ppv.platformMessageId, fan_ref: ppv.fanRef,
        conversation_ref: null, user_id: String(userIds.grisha), source: SOURCE, priced: true, with_media: true,
        observed_at: ppv.observedAt, client_version: EXTENSION_VERSION,
      },
      {
        platform: "onlyfans", page_id: String(pageIds["lora-of"]), platform_message_id: plain.platformMessageId, fan_ref: plain.fanRef,
        conversation_ref: null, user_id: String(userIds.grisha), source: SOURCE, priced: false, with_media: false,
        observed_at: plain.observedAt, client_version: EXTENSION_VERSION,
      },
    ]);
    // The table has no place for a text: ids, marks, times and who.
    const columns = (await query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'client_send_attributions' order by ordinal_position",
    )).map((row) => row.column_name);
    expect(columns).toEqual([
      "platform", "page_id", "platform_message_id", "fan_ref", "conversation_ref", "user_id", "source", "priced",
      "with_media", "observed_at", "recorded_at", "client_version", "composed_with", "edited", "observation_id",
    ]);
    // Each fact was journaled first, under the person who reported it, and its row names that entry.
    const journaled = await query<{ id: string; kind: string; source: string; producer: string; account_id: string; actor_principal_id: string; message_id: string }>(
      `select o.id::text, o.kind, o.source, o.producer, o.account_id::text, o.actor_principal_id::text,
         o.payload->'fact'->>'platformMessageId' as message_id
       from observations o where o.kind = 'client.send_attribution.v1' and o.payload->'fact'->>'platformMessageId' = any($1::text[])
       order by message_id`,
      [[ppv.platformMessageId, plain.platformMessageId]],
    );
    expect(journaled.map(({ id: _id, ...row }) => row)).toEqual([ppv, plain].map((sent) => ({
      kind: "client.send_attribution.v1", source: "client_capture", producer: "chat-extension@1.4.2",
      account_id: String(pageIds["lora-of"]), actor_principal_id: String(userIds.grisha), message_id: sent.platformMessageId,
    })));
    const links = await query<{ platform_message_id: string; observation_id: string }>(
      "select platform_message_id, observation_id::text from client_send_attributions where platform_message_id = any($1::text[]) order by platform_message_id",
      [[ppv.platformMessageId, plain.platformMessageId]],
    );
    expect(links.map((row) => row.observation_id)).toEqual(journaled.map((row) => row.id));
    // An unreadable version is not kept; the report is still taken.
    const unversioned = fact();
    expect(outcomes(ok(await report(bearer(grishaToken, "chat extension; drop"), [unversioned])))).toEqual(["recorded"]);
    expect((await rowsOf([unversioned.platformMessageId]))[0]).toMatchObject({ client_version: null });
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes the first report of a message: a repeat is `duplicate`, another person's or another fan's is a `conflict`, and nothing changes", async () => {
    const first = fact({ priced: true });
    expect(outcomes(ok(await report(bearer(grishaToken), [first])))).toEqual(["recorded"]);
    const stored = await rowsOf([first.platformMessageId]);

    // The same report again (its answer was lost): read as a repeat. Its marks and time are the first one's.
    expect(outcomes(ok(await report(bearer(grishaToken), [{ ...first, priced: false, observedAt: new Date().toISOString() }]))))
      .toEqual(["duplicate"]);
    // Another chatter of the page says the same message was theirs: the first report stands.
    expect(outcomes(ok(await report(bearer(nikitaToken), [first])))).toEqual(["conflict"]);
    // The same person, the same message, another fan: not the same send.
    expect(outcomes(ok(await report(bearer(grishaToken), [{ ...first, fanRef: "518588960" }])))).toEqual(["conflict"]);
    expect(await rowsOf([first.platformMessageId])).toEqual(stored);

    // One message twice in one report: one row, the first fact is the report.
    const twice = fact();
    expect(outcomes(ok(await report(bearer(grishaToken), [twice, twice, { ...twice, fanRef: "518588961" }]))))
      .toEqual(["recorded", "duplicate", "conflict"]);
    expect(await rowsOf([twice.platformMessageId])).toHaveLength(1);

    // The same message id on another page is another message.
    const shared = fact();
    expect(outcomes(ok(await report(bearer(grishaToken), [shared])))).toEqual(["recorded"]);
    expect(outcomes(ok(await report(bearer(svetaToken), [shared], { pageLabel: "mia-of" })))).toEqual(["recorded"]);
    expect((await rowsOf([shared.platformMessageId])).map((row) => [row.page_id, row.user_id])).toEqual(expect.arrayContaining([
      [String(pageIds["lora-of"]), String(userIds.grisha)],
      [String(pageIds["mia-of"]), String(userIds.sveta)],
    ]));
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("records exactly one of two people reporting the same message at once", async () => {
    const message = fact();
    const answers = await Promise.all([
      report(bearer(grishaToken), [message]),
      report(bearer(nikitaToken), [message]),
    ]);
    expect(answers.map((answer) => outcomes(ok(answer))[0]).sort()).toEqual(["conflict", "recorded"]);
    const [row] = await rowsOf([message.platformMessageId]);
    const winner = outcomes(ok(answers[0]!))[0] === "recorded" ? userIds.grisha : userIds.nikita;
    expect(row).toMatchObject({ user_id: String(winner) });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rights: a device token on a granted page; never a cookie, an agent key or someone else's page", async () => {
    const call = (headers: Record<string, string>, pageLabel = "lora-of") => report(headers, [fact()], { pageLabel });
    expect((await call({ "x-client-version": EXTENSION_VERSION })).statusCode).toBe(401);
    expect((await call({ authorization: "Bearer agency_hub_device_nosuchtoken" })).statusCode).toBe(401);
    for (const cookie of [ownerCookie, grishaCookie]) {
      expect((await call({ cookie, "x-client-version": EXTENSION_VERSION })).statusCode).toBe(403);
    }
    expect((await call(bearer(AGENT_KEY_TOKEN))).statusCode).toBe(403);
    // The narrow token, a full token of the page's chatter, the owner's.
    for (const token of [grishaToken, nikitaToken, ownerToken]) {
      expect(outcomes(ok(await call(bearer(token))))).toEqual(["recorded"]);
    }

    // A page that is not the caller's, and one that does not exist: nothing is written.
    const before = (await query<{ n: number }>("select count(*)::int as n from client_send_attributions"))[0]!.n;
    const foreign = await call(bearer(svetaToken));
    const missing = await call(bearer(grishaToken), "ghost-of");
    // The declared page scope answers before the handler, as on every page route.
    expectRefused(foreign, 403, "forbidden");
    expectRefused(missing, 404, "not_found");
    expect((await query<{ n: number }>("select count(*)::int as n from client_send_attributions"))[0]!.n).toBe(before);

    // A key the client never sends, a person in the body, an empty report, a text: 400.
    for (const payload of [
      { source: SOURCE, facts: [{ ...fact(), userId: userIds.nikita }] },
      { source: SOURCE, facts: [{ ...fact(), text: "hey" }] },
      { source: SOURCE, facts: [fact()], userId: userIds.nikita },
      { source: SOURCE, facts: [] },
      { facts: [fact()] },
    ]) {
      const response = await server!.inject({
        method: "POST", url: "/api/v1/client/pages/lora-of/send-attributions", headers: bearer(grishaToken), payload,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes on a page only the clients its platform admits; Fansly's facts name their chat and say how the text was written", async () => {
    expectRefused(await report(bearer(grishaToken), [fact()], { pageLabel: "lora-fansly" }), 409, "client_feature_disabled", "platform_unsupported");
    expectRefused(await report(bearer(grishaToken), [fact()], { source: "fansly-extension" }), 409, "client_feature_disabled", "platform_unsupported");

    const fansly = { pageLabel: "lora-fansly", source: "fansly-extension" };
    // A Fansly fact without its chat: the whole report is refused, nothing journaled.
    const chatless = fact();
    expect((await report(bearer(grishaToken), [fact({ conversationRef: "810272281019305984" }), chatless], fansly)).statusCode).toBe(400);
    expect(await query("select 1 from observations where payload->'fact'->>'platformMessageId' = $1", [chatless.platformMessageId])).toEqual([]);

    const reply = fact({ conversationRef: "810272281019305984", composedWith: "reply", edited: true });
    const media = fact({ conversationRef: "810272281019305984", withMedia: true, priced: true, composedWith: "voice-clone" });
    expect(outcomes(ok(await report(bearer(grishaToken), [reply, media], fansly)))).toEqual(["recorded", "recorded"]);
    const rows = await query<{ platform: string; conversation_ref: string; source: string; composed_with: string; edited: boolean | null }>(
      `select platform, conversation_ref, source, composed_with, edited from client_send_attributions
       where platform_message_id = any($1::text[]) order by platform_message_id`,
      [[reply.platformMessageId, media.platformMessageId]],
    );
    // A value the hub does not know is kept as `unknown`; a client that does not say leaves both empty.
    expect(rows).toEqual([
      { platform: "fansly", conversation_ref: "810272281019305984", source: "fansly-extension", composed_with: "reply", edited: true },
      { platform: "fansly", conversation_ref: "810272281019305984", source: "fansly-extension", composed_with: "unknown", edited: null },
    ]);
    // The same message reported for another chat is a conflict: the first chat stands.
    expect(outcomes(ok(await report(bearer(grishaToken), [{ ...reply, conversationRef: "810272281019305985" }], fansly)))).toEqual(["conflict"]);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("needs no switch: a send that happened is recorded while the extension is off and the client is below the minimum", async () => {
    await patchConfig([
      { key: "chatExtensionEnabled", value: false },
      { key: "chatExtensionMinVersion", value: "9.0.0" },
    ]);
    expect(outcomes(ok(await report(bearer(grishaToken), [fact()])))).toEqual(["recorded"]);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("stores nothing of a fact observed out of range, and refuses a report whose time is not a time", async () => {
    const ahead = fact({ observedAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    const old = fact({ observedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString() });
    const fine = fact();
    expect(outcomes(ok(await report(bearer(grishaToken), [ahead, fine, old])))).toEqual(["out_of_range", "recorded", "out_of_range"]);
    expect((await rowsOf([ahead.platformMessageId, fine.platformMessageId, old.platformMessageId])).map((row) => row.platform_message_id))
      .toEqual([fine.platformMessageId]);
    // Shaped like a time, and not one: the whole report is 400, nothing is written.
    const shaped = fact({ observedAt: "2026-13-45T25:61:61Z" });
    const other = fact();
    expectRefused(await report(bearer(grishaToken), [other, shaped]), 400, "bad_request");
    expect(await rowsOf([other.platformMessageId, shaped.platformMessageId])).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("erases a fan's rows with the fan and a page's with the page, keeping the rest", async () => {
    const fanA = "618588958";
    const fanB = "618588959";
    const a = fact({ fanRef: fanA });
    const b = fact({ fanRef: fanB });
    expect(outcomes(ok(await report(bearer(grishaToken), [a, b])))).toEqual(["recorded", "recorded"]);
    const mia = fact({ fanRef: fanA });
    expect(outcomes(ok(await report(bearer(svetaToken), [mia], { pageLabel: "mia-of" })))).toEqual(["recorded"]);
    await trap?.restore();
    trap = null;

    const scope = { scopeType: "fan", platform: "onlyfans", fanRef: fanA } as const;
    const plan = await planErasure(app, scope);
    expect(plan.targets.find((entry) => entry.target === "client_send_attributions")).toMatchObject({ rows: 2, action: "delete" });
    await executeErasure(app, scope, { initiatedBy: userIds.owner });
    expect((await rowsOf([a.platformMessageId, b.platformMessageId, mia.platformMessageId])).map((row) => row.platform_message_id))
      .toEqual([b.platformMessageId]);

    await executeErasure(app, { scopeType: "page", pageLabel: "mia-of" }, { initiatedBy: userIds.owner });
    expect(await rowsOf([b.platformMessageId])).toHaveLength(1);
    await executeErasure(app, { scopeType: "page", pageLabel: "lora-of" }, { initiatedBy: userIds.owner });
    expect(await rowsOf([b.platformMessageId])).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
