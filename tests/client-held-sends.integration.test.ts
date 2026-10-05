import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientSendCustodyListResponseSchema,
  errorResponseSchema,
  type ClientSendCustodyListResponse,
} from "@agency_hub_core/contracts";
import {
  createModel,
  createOnlyFansPage,
  explainClientSendCustodyListQuery,
  insertAgentKey,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  assignPageToUser,
  createUserAccount,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension H-7e: the cabinet's list of held sends.
//   GET /api/v1/client-send-custody?state=held|resolved&pageLabel=&limit=&offset=   (clientSendCustodyList)
// What a send is, how it comes to be held and how the resolve ends it are
// tests/client-claim-routes.integration.test.ts (H-7b); this file holds the
// list: which sends it shows in which state, what it says of each, who may
// read it and on which pages, its paging, and that it only reads. The sends
// here are made through the real claim route and resolved through the real
// resolve route, so the list is checked against what those two leave behind.
// Every test runs under the no-outbound trap.

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = {
  owner: "owner-secret", lead: "lead-secret", idle: "idle-secret",
  grisha: "grisha-secret", nikita: "nikita-secret", sveta: "sveta-secret",
} as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}heldsends0000000000`;
/** Client installs: grisha's, nikita's, sveta's. */
const I1 = randomUUID();
const I2 = randomUUID();
const I3 = randomUUID();
const LIST_URL = "/api/v1/client-send-custody";
const NARROW_REFUSAL = { error: "forbidden", message: "This route is not available to this client", statusCode: 403 };

/** Every key of one item, and of its two objects: a new one is a decision, not an accident. */
const ITEM_KEYS = [
  "attemptId", "createdAt", "fanRef", "generationRef", "greeting", "instanceId", "pageLabel", "partCount", "partIndex",
  "purpose", "resolution", "state", "ticketExpiresAt", "updatedAt", "userId", "username", "variant",
];
const GREETING_KEYS = ["at", "firstPartIsThisAttempt", "source", "state"];
const RESOLUTION_KEYS = ["at", "note", "outcome", "platformMessageId", "userId", "username"];

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Body = Record<string, unknown>;
type Item = ClientSendCustodyListResponse["items"][number];

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
const cookies: Record<"owner" | "lead" | "idle" | "grisha", string> = { owner: "", lead: "", idle: "", grisha: "" };
/** Narrow chat-extension tokens. */
const narrow: Record<"grisha" | "nikita" | "sveta", string> = { grisha: "", nikita: "", sveta: "" };
let ownerToken = "";
let leadToken = "";
let grishaFullToken = "";
const userIds: Record<keyof typeof PASSWORDS, number> = { owner: 0, lead: 0, idle: 0, grisha: 0, nikita: 0, sveta: 0 };
const pageIds: Record<string, number> = {};
let fanSeq = 710_000_000;
const nextFan = () => String(++fanSeq);

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "x-client-version": EXTENSION_VERSION });

const query = <Row extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  testDb!.pool.query<Row>(text, values).then((result) => result.rows);

function act(token: string, pageLabel: string, fan: string, body: Body) {
  return server!.inject({
    method: "POST",
    url: `/api/v1/client/pages/${pageLabel}/fans/${fan}/claim`,
    headers: bearer(token),
    payload: body,
  });
}

function resolve(cookie: string, pageLabel: string, attemptId: string, body: Body) {
  return server!.inject({
    method: "POST",
    url: `/api/v1/pages/${pageLabel}/client-send-custody/${attemptId}/resolve`,
    headers: { cookie },
    payload: body,
  });
}

function list(cookie: string | null, search = "", headers: Record<string, string> = {}) {
  return server!.inject({ method: "GET", url: `${LIST_URL}${search}`, headers: { ...(cookie === null ? {} : { cookie }), ...headers } });
}

/** No key anywhere in the answer that could carry the text of a message. */
function expectNoMessageText(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoMessageText(entry, `${path}[${index}]`));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      expect(key, `${path}.${key}`).not.toMatch(/text|body|content|html|caption|preview|draft/i);
      expectNoMessageText(entry, `${path}.${key}`);
    }
  }
}

/** A 200 whose body is the declared shape and nothing more, with no text of a message in it. */
function ok(response: InjectResponse): ClientSendCustodyListResponse {
  expect(response.statusCode, response.body).toBe(200);
  const body = clientSendCustodyListResponseSchema.parse(response.json());
  expect(response.json()).toEqual(body);
  for (const item of body.items) {
    expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    expect(Object.keys(item.greeting).sort()).toEqual(GREETING_KEYS);
    if (item.resolution !== null) expect(Object.keys(item.resolution).sort()).toEqual(RESOLUTION_KEYS);
  }
  expectNoMessageText(response.json());
  return body;
}

function expectRefused(response: InjectResponse, statusCode: number, error: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(errorResponseSchema.parse(response.json())).toMatchObject({ error, statusCode });
}

const attemptsOf = (body: ClientSendCustodyListResponse) => body.items.map((item) => item.attemptId);

interface Send { fan: string; attemptId: string; group: { generationRef: string; variant: number; partCount: number } }

/** The first part of a greeting dispatched from the preview: a lease, then the dispatch under it. */
async function dispatchGreeting(
  who: keyof typeof narrow,
  instanceId: string,
  pageLabel: string,
  over: { variant?: number; partCount?: number } = {},
): Promise<Send> {
  const fan = nextFan();
  const leaseToken = randomUUID();
  const claimed = await act(narrow[who], pageLabel, fan, { action: "claim", leaseToken, instanceId });
  expect(claimed.statusCode, claimed.body).toBe(200);
  const group = { generationRef: randomUUID(), variant: over.variant ?? 0, partCount: over.partCount ?? 3 };
  const attemptId = randomUUID();
  const dispatched = await act(narrow[who], pageLabel, fan, {
    action: "dispatch", attemptId, instanceId, purpose: "greeting", group, partIndex: 0, textRevision: 1, flagRevision: 0,
    leaseToken,
  });
  expect(dispatched.statusCode, dispatched.body).toBe(200);
  return { fan, attemptId, group };
}

/** A reply dispatched from the Spenders preview: no lease. */
async function dispatchReply(who: keyof typeof narrow, instanceId: string, pageLabel: string, fan = nextFan()): Promise<Send> {
  const group = { generationRef: randomUUID(), variant: 0, partCount: 1 };
  const attemptId = randomUUID();
  const dispatched = await act(narrow[who], pageLabel, fan, {
    action: "dispatch", attemptId, instanceId, purpose: "preview-reply", group, partIndex: 0, textRevision: 4, flagRevision: 0,
  });
  expect(dispatched.statusCode, dispatched.body).toBe(200);
  return { fan, attemptId, group };
}

/** Past the ticket and dispatched this long ago: the dispatch never reported. */
const hold = (attemptId: string, minutesAgo: number) => query(
  `update client_send_custody
   set created_at = now() - make_interval(mins => $2), updated_at = now() - make_interval(mins => $2),
       ticket_expires_at = now() - make_interval(mins => $2) + interval '10 seconds'
   where attempt_id = $1`,
  [attemptId, minutesAgo],
);

async function switchOn() {
  const response = await server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: cookies.owner },
    payload: {
      patches: [
        { key: "chatExtensionEnabled", value: true },
        { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { newcomers: true, previewSend: true } }) },
      ],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function loginCookie(username: keyof typeof cookies): Promise<string> {
  const login = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: PASSWORDS[username] },
  });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}

async function narrowTokenOf(username: keyof typeof narrow): Promise<string> {
  const signIn = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/device-tokens/password",
    headers: { "x-client-version": EXTENSION_VERSION },
    payload: {
      username, password: PASSWORDS[username], label: "Firefox · macOS · ChatSpace", mode: "active", client: "chat-extension",
    },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  expect(signIn.json()).toMatchObject({ client: "chat-extension" });
  return signIn.json<{ token: string }>().token;
}

describe("GET /api/v1/client-send-custody (H-7e)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb, { authPolicyEnforcement: "log" });

    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    // Two team leads: one of lora-of, one with no page at all.
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    await createUserAccount(app, { username: "idle", role: "team_lead", password: PASSWORDS.idle }, AUDIT);
    for (const username of ["grisha", "nikita", "sveta"] as const) {
      await createUserAccount(app, { username, role: "chatter" }, AUDIT);
    }
    for (const username of Object.keys(PASSWORDS) as Array<keyof typeof PASSWORDS>) {
      userIds[username] = await fixtureUserId(app, username);
    }
    // A chatter is created without a password; setting one ends every sign-in,
    // so it comes before the tokens below.
    for (const username of ["grisha", "nikita", "sveta"] as const) {
      await setUserPassword(app, { userId: userIds[username], password: PASSWORDS[username] }, AUDIT);
    }

    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const [label, account] of [["lora-of", "100000001"], ["mia-of", "100000003"], ["gone-of", "100000005"]] as const) {
      pageIds[label] = (await createOnlyFansPage(app.db, { modelId: lora!.id, label }))!.id;
      await testDb.pool.query("update pages set external_page_id = $1 where id = $2", [account, pageIds[label]]);
    }
    for (const [userId, labels] of [
      [userIds.grisha, ["lora-of", "gone-of"]],
      [userIds.nikita, ["lora-of"]],
      [userIds.lead, ["lora-of"]],
      [userIds.sveta, ["mia-of"]],
    ] as const) {
      for (const pageLabel of labels) {
        await assignPageToUser(app, { userId, pageLabel }, AUDIT);
      }
    }
    // A chat with unread messages, so the trap's unread check has something to hold.
    await testDb.pool.query(
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, '710000001', 3)",
      [pageIds["lora-of"]],
    );

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: userIds.owner, label: "owner client" })).token;
    leadToken = (await issueDeviceTokenForUserId(app, { userId: userIds.lead, label: "lead client" })).token;
    grishaFullToken = (await issueDeviceTokenForUserId(app, { userId: userIds.grisha, label: "grisha desktop" })).token;
    await insertAgentKey(app.db, {
      name: "held-sends-probe",
      keyPrefix: AGENT_KEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY_TOKEN),
      capabilities: ["read:messages"],
      pageIds: [pageIds["lora-of"]!],
      dailyRequestBudget: 5000,
      dailyRowBudget: 500_000,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: null,
    });

    server = await buildApiServer(app);
    await server.ready();

    for (const username of ["grisha", "nikita", "sveta"] as const) narrow[username] = await narrowTokenOf(username);
    for (const username of ["owner", "lead", "idle", "grisha"] as const) cookies[username] = await loginCookie(username);
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    // Every test starts with no send on record and the switches at rest.
    await testDb.pool.query("delete from client_send_custody");
    await testDb.pool.query("delete from client_greetings");
    await testDb.pool.query("delete from client_fan_leases");
    await testDb.pool.query("delete from config_settings where key like 'chatExtension%'");
    await testDb.pool.query("update pages set status = 'active' where id = $1", [pageIds["gone-of"]]);
    trap = await armNoOutboundTrap(testDb);
  });

  afterEach(async () => {
    await trap?.restore();
    trap = null;
    if (testDb) app.config.authPolicyEnforcement = "log";
  });

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("lists the sends past their ticket that nobody ended, the longest held first, and says of each what the resolver needs", async () => {
    await switchOn();
    // Held: a greeting of grisha's on lora-of, a reply of nikita's on lora-of, a greeting of sveta's on mia-of.
    const greeting = await dispatchGreeting("grisha", I1, "lora-of", { variant: 2, partCount: 3 });
    const reply = await dispatchReply("nikita", I2, "lora-of");
    const mia = await dispatchGreeting("sveta", I3, "mia-of");
    await hold(greeting.attemptId, 90);
    await hold(reply.attemptId, 30);
    await hold(mia.attemptId, 60);
    // Not held: one still inside its ticket, one reported sent, one failed with proof.
    const flying = await dispatchReply("grisha", I1, "lora-of");
    const sent = await dispatchReply("grisha", I1, "lora-of");
    expect((await act(narrow.grisha, "lora-of", sent.fan, {
      action: "sent", attemptId: sent.attemptId, instanceId: I1, platformMessageId: "8801", evidence: "receipt+echo",
    })).statusCode).toBe(200);
    const failed = await dispatchReply("nikita", I2, "lora-of");
    expect((await act(narrow.nikita, "lora-of", failed.fan, {
      action: "failed", attemptId: failed.attemptId, instanceId: I2, reason: "not_enqueued",
    })).statusCode).toBe(200);
    const sends = () => query("select attempt_id::text, state, updated_at from client_send_custody order by attempt_id");
    const audits = () => query<{ n: number }>("select count(*)::int as n from audit_events");
    const sendsBefore = await sends();
    const auditsBefore = await audits();

    // The owner reads every page. `held` is the default.
    const all = ok(await list(cookies.owner));
    expect(all).toMatchObject({ limit: 50, offset: 0, total: 3 });
    expect(attemptsOf(all)).toEqual([greeting.attemptId, mia.attemptId, reply.attemptId]);
    expect(attemptsOf(ok(await list(cookies.owner, "?state=held")))).toEqual(attemptsOf(all));
    for (const attemptId of [flying.attemptId, sent.attemptId, failed.attemptId]) expect(attemptsOf(all)).not.toContain(attemptId);
    expect(Date.parse(all.serverNow)).toBeGreaterThan(Date.now() - 60_000);

    const [first, second, third] = all.items as [Item, Item, Item];
    expect(first).toMatchObject({
      attemptId: greeting.attemptId, pageLabel: "lora-of", fanRef: greeting.fan, purpose: "greeting", state: "uncertain-held",
      generationRef: greeting.group.generationRef, variant: 2, partIndex: 0, partCount: 3,
      userId: userIds.grisha, username: "grisha", instanceId: I1,
      greeting: { state: "none", at: null, source: null, firstPartIsThisAttempt: false },
      resolution: null,
    });
    // The ticket ran out 10 s after the dispatch, and nothing was recorded since: no report followed.
    expect(Date.parse(first.ticketExpiresAt!) - Date.parse(first.createdAt)).toBe(10_000);
    expect(first.updatedAt).toBe(first.createdAt);
    expect(Date.parse(all.serverNow) - Date.parse(first.createdAt)).toBeGreaterThanOrEqual(90 * 60_000);
    expect(second).toMatchObject({
      attemptId: mia.attemptId, pageLabel: "mia-of", fanRef: mia.fan, purpose: "greeting", state: "uncertain-held",
      userId: userIds.sveta, username: "sveta", instanceId: I3, variant: 0, partIndex: 0, partCount: 3,
    });
    expect(third).toMatchObject({
      attemptId: reply.attemptId, pageLabel: "lora-of", fanRef: reply.fan, purpose: "preview-reply", state: "uncertain-held",
      generationRef: reply.group.generationRef, variant: 0, partIndex: 0, partCount: 1,
      userId: userIds.nikita, username: "nikita", instanceId: I2,
    });

    // A team lead reads the pages assigned to them, and one page narrows the owner's list.
    const leads = ok(await list(cookies.lead));
    expect(leads.total).toBe(2);
    expect(attemptsOf(leads)).toEqual([greeting.attemptId, reply.attemptId]);
    expect(attemptsOf(ok(await list(cookies.lead, "?pageLabel=lora-of")))).toEqual([greeting.attemptId, reply.attemptId]);
    const onMia = ok(await list(cookies.owner, "?pageLabel=mia-of"));
    expect(onMia.total).toBe(1);
    expect(attemptsOf(onMia)).toEqual([mia.attemptId]);
    // A team lead with no page reads an empty list, not everyone's.
    expect(ok(await list(cookies.idle))).toMatchObject({ items: [], total: 0 });

    // Reading changed no send and left no audit row.
    expect(await sends()).toEqual(sendsBefore);
    expect(await audits()).toEqual(auditsBefore);

    // The send inside its ticket joins the list when the ticket runs out, after the ones held longer.
    await query("update client_send_custody set ticket_expires_at = now() - interval '1 second' where attempt_id = $1", [flying.attemptId]);
    expect(attemptsOf(ok(await list(cookies.owner)))).toEqual([greeting.attemptId, mia.attemptId, reply.attemptId, flying.attemptId]);

    // The list stays readable while the extension is switched off, like the resolve stays possible.
    const off = await server!.inject({
      method: "PATCH", url: "/api/v1/admin/config", headers: { cookie: cookies.owner },
      payload: { patches: [{ key: "chatExtensionEnabled", value: false }] },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(ok(await list(cookies.lead)).total).toBe(3);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("says whether the fan's greeting is on record, as the claim status read answers it", async () => {
    await switchOn();
    // A desktop new-follower command OnlyFans confirmed, and one still queued: the desktop's rows, made before the trap counts.
    const desktopFan = nextFan();
    const queuedFan = nextFan();
    for (const [fan, state, messageId, finishedAt] of [
      [desktopFan, "confirmed", "9001", new Date("2026-09-21T10:00:00Z")],
      [queuedFan, "queued", null, null],
    ] as const) {
      await query(
        `insert into ofapi_commands (id, client_command_id, page_id, chatter_user_id, ofapi_account_id, conversation_id,
           outreach_purpose, kind, payload, payload_hash, state, attempt_count, verifier_result, platform_message_id,
           attempt_finished_at, dedupe_expires_at)
         values ($1, $2, $3, $4, 'acct_held', $5, 'new-follower', 'send_text_message_v1', '{}'::jsonb, $6, $7, $8, $9, $10, $11,
           now() + interval '1 day')`,
        [randomUUID(), randomUUID(), pageIds["lora-of"], userIds.nikita, fan, "a".repeat(64), state,
          state === "confirmed" ? 1 : 0, state === "confirmed" ? JSON.stringify({ source: "ofapi_response" }) : null,
          messageId, finishedAt],
      );
    }
    await trap!.restore();
    trap = await armNoOutboundTrap(testDb!);

    // 1. The person sent the held part by hand from the composer: the greeting is recorded over this very attempt.
    const byHand = await dispatchGreeting("grisha", I1, "lora-of");
    await hold(byHand.attemptId, 50);
    const native = await act(narrow.grisha, "lora-of", byHand.fan, {
      action: "registerNativeSend", attemptId: randomUUID(), instanceId: I1, purpose: "greeting", group: byHand.group,
      partIndex: 0, platformMessageId: "8811",
    });
    expect(native.statusCode, native.body).toBe(200);
    // 2. A fan greeted earlier from the preview, then a reply to them held: a greeting, but not this attempt's.
    const greeted = await dispatchGreeting("nikita", I2, "lora-of");
    expect((await act(narrow.nikita, "lora-of", greeted.fan, {
      action: "sent", attemptId: greeted.attemptId, instanceId: I2, platformMessageId: "8812", evidence: "receipt+echo",
    })).statusCode).toBe(200);
    const afterGreeting = await dispatchReply("nikita", I2, "lora-of", greeted.fan);
    await hold(afterGreeting.attemptId, 40);
    // 3. A fan the desktop greeted; 4. one whose desktop greeting is still queued; 5. one nobody greeted.
    const afterDesktop = await dispatchReply("grisha", I1, "lora-of", desktopFan);
    await hold(afterDesktop.attemptId, 30);
    const afterQueued = await dispatchReply("grisha", I1, "lora-of", queuedFan);
    await hold(afterQueued.attemptId, 20);
    const ungreeted = await dispatchGreeting("nikita", I2, "lora-of");
    await hold(ungreeted.attemptId, 10);

    const held = ok(await list(cookies.lead));
    expect(attemptsOf(held)).toEqual([
      byHand.attemptId, afterGreeting.attemptId, afterDesktop.attemptId, afterQueued.attemptId, ungreeted.attemptId,
    ]);
    const greetings = held.items.map((item) => item.greeting);
    expect(greetings[0]).toMatchObject({ state: "confirmed", source: "native-register", firstPartIsThisAttempt: true });
    expect(greetings[1]).toMatchObject({ state: "confirmed", source: "preview-send", firstPartIsThisAttempt: false });
    expect(greetings[2]).toEqual({
      state: "confirmed", at: "2026-09-21T10:00:00.000Z", source: "desktop-outbox", firstPartIsThisAttempt: false,
    });
    expect(greetings[3]).toEqual({ state: "none", at: null, source: null, firstPartIsThisAttempt: false });
    expect(greetings[4]).toEqual({ state: "none", at: null, source: null, firstPartIsThisAttempt: false });
    // The same answer as the claim status read gives the dispatcher's client for each fan.
    for (const item of held.items) {
      const status = await server!.inject({
        method: "GET", url: `/api/v1/client/pages/lora-of/fans/${item.fanRef}/claim`, headers: bearer(narrow.grisha),
      });
      expect(status.statusCode, status.body).toBe(200);
      const claim = status.json<{ greeting: { state: string; at: string | null; source: string | null }; custody: { attemptId: string; state: string } }>();
      expect({ state: item.greeting.state, at: item.greeting.at, source: item.greeting.source }).toEqual({
        state: claim.greeting.state, at: claim.greeting.at, source: claim.greeting.source,
      });
      expect(claim.custody).toMatchObject({ attemptId: item.attemptId, state: item.state });
    }
    // The greeting's message id is not the held send's proof, and the list does not offer it as one.
    expect(JSON.stringify(held)).not.toContain("8811");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("lists the sends resolved by hand, the last resolved first, each with its resolver, outcome and note", async () => {
    await switchOn();
    const greeting = await dispatchGreeting("grisha", I1, "lora-of");
    const reply = await dispatchReply("nikita", I2, "lora-of");
    const mia = await dispatchGreeting("sveta", I3, "mia-of");
    await hold(greeting.attemptId, 90);
    await hold(reply.attemptId, 60);
    await hold(mia.attemptId, 30);
    expect(ok(await list(cookies.owner, "?state=resolved"))).toMatchObject({ items: [], total: 0 });

    // The team lead found the greeting in the chat; the owner found nothing of sveta's.
    const sentResolve = await resolve(cookies.lead, "lora-of", greeting.attemptId, {
      outcome: "sent", platformMessageId: "9911", note: "  the message is in the chat  ",
    });
    expect(sentResolve.statusCode, sentResolve.body).toBe(200);
    const notSentResolve = await resolve(cookies.owner, "mia-of", mia.attemptId, { outcome: "not_sent", note: "nothing in the chat" });
    expect(notSentResolve.statusCode, notSentResolve.body).toBe(200);

    // What is still held, and what is resolved.
    const held = ok(await list(cookies.owner));
    expect(held.total).toBe(1);
    expect(attemptsOf(held)).toEqual([reply.attemptId]);
    const resolved = ok(await list(cookies.owner, "?state=resolved"));
    expect(resolved.total).toBe(2);
    expect(attemptsOf(resolved)).toEqual([mia.attemptId, greeting.attemptId]);
    const [last, first] = resolved.items as [Item, Item];
    expect(last).toMatchObject({
      attemptId: mia.attemptId, pageLabel: "mia-of", fanRef: mia.fan, state: "resolved-not-sent", purpose: "greeting",
      userId: userIds.sveta, username: "sveta", instanceId: I3,
      // "Not sent" confirms no greeting: the fan may be greeted again.
      greeting: { state: "none", at: null, source: null, firstPartIsThisAttempt: false },
      resolution: { outcome: "not_sent", userId: userIds.owner, username: "owner", note: "nothing in the chat", platformMessageId: null },
    });
    expect(first).toMatchObject({
      attemptId: greeting.attemptId, pageLabel: "lora-of", fanRef: greeting.fan, state: "resolved-sent", purpose: "greeting",
      userId: userIds.grisha, username: "grisha", instanceId: I1,
      // The first part of a greeting resolved as sent is the fan's greeting.
      greeting: { state: "confirmed", source: "resolve", firstPartIsThisAttempt: true },
      resolution: { outcome: "sent", userId: userIds.lead, username: "lead", note: "the message is in the chat", platformMessageId: "9911" },
    });
    for (const item of resolved.items) {
      // The resolve is the attempt's last recorded change, after its ticket ran out.
      expect(item.updatedAt).toBe(item.resolution!.at);
      expect(Date.parse(item.resolution!.at)).toBeGreaterThan(Date.parse(item.ticketExpiresAt!));
      // The trail the list shows is the audit trail: one audit event per resolve, same person, same outcome.
      expect(await query(
        `select actor_user_id::text as actor, metadata->>'outcome' as outcome from audit_events
         where event_type = 'client.send_custody_resolved' and metadata->>'attemptId' = $1`,
        [item.attemptId],
      )).toEqual([{ actor: String(item.resolution!.userId), outcome: item.resolution!.outcome }]);
    }

    // A team lead reads the resolves of their pages only, and a page narrows either list.
    const leads = ok(await list(cookies.lead, "?state=resolved"));
    expect(leads.total).toBe(1);
    expect(attemptsOf(leads)).toEqual([greeting.attemptId]);
    expect(attemptsOf(ok(await list(cookies.owner, "?state=resolved&pageLabel=mia-of")))).toEqual([mia.attemptId]);
    expect(ok(await list(cookies.owner, "?state=held&pageLabel=mia-of"))).toMatchObject({ items: [], total: 0 });
    // A send the client itself reported is in neither list: only a person's resolve is.
    const reported = await dispatchReply("grisha", I1, "lora-of");
    expect((await act(narrow.grisha, "lora-of", reported.fan, {
      action: "sent", attemptId: reported.attemptId, instanceId: I1, platformMessageId: "9912", evidence: "receipt+echo",
    })).statusCode).toBe(200);
    expect(attemptsOf(ok(await list(cookies.owner, "?state=resolved")))).toEqual([mia.attemptId, greeting.attemptId]);
    expect(attemptsOf(ok(await list(cookies.owner)))).toEqual([reply.attemptId]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("pages the list by limit and offset in one fixed order, and refuses a query it does not declare", async () => {
    // Seven held replies on lora-of, one a minute, the two oldest dispatched in the same instant.
    await query(
      `insert into client_send_custody (attempt_id, page_id, fan_ref, user_id, instance_id, purpose, origin, generation_ref,
         variant, part_count, part_index, text_revision, request_hash, state, ticket_hash, ticket_expires_at, created_at, updated_at)
       select gen_random_uuid(), $1, (720000000 + g)::text, $2, $3, 'preview-reply', 'preview-send', 'gen-page-' || g,
         0, 1, 0, 1, sha256(g::text::bytea), 'dispatching', sha256(g::text::bytea), at + interval '10 seconds', at, at
       from (select g, date_trunc('minute', now()) - (least(g, 6) || ' minutes')::interval as at from generate_series(1, 7) g) rows`,
      [pageIds["lora-of"], userIds.grisha, I1],
    );
    const expected = (await query<{ attempt_id: string }>(
      "select attempt_id::text from client_send_custody order by created_at, attempt_id",
    )).map((row) => row.attempt_id);
    expect(expected).toHaveLength(7);

    const whole = ok(await list(cookies.owner));
    expect(whole).toMatchObject({ limit: 50, offset: 0, total: 7 });
    expect(attemptsOf(whole)).toEqual(expected);
    // The oldest is the first: fan 720000006 or 720000007, the two of one instant, by attempt id.
    expect(["720000006", "720000007"]).toContain(whole.items[0]!.fanRef);
    expect(whole.items.at(-1)!.fanRef).toBe("720000001");

    const walked: string[] = [];
    for (const offset of [0, 3, 6]) {
      const page = ok(await list(cookies.lead, `?limit=3&offset=${offset}`));
      expect(page).toMatchObject({ limit: 3, offset, total: 7 });
      expect(page.items).toHaveLength(offset === 6 ? 1 : 3);
      walked.push(...attemptsOf(page));
    }
    expect(walked).toEqual(expected);
    // One by one over the two of one instant: the order holds between requests.
    expect([
      ...attemptsOf(ok(await list(cookies.owner, "?limit=1&offset=0"))),
      ...attemptsOf(ok(await list(cookies.owner, "?limit=1&offset=1"))),
    ]).toEqual(expected.slice(0, 2));
    // Past the end: nothing, and the total still says how many there are.
    expect(ok(await list(cookies.owner, "?limit=3&offset=7"))).toMatchObject({ items: [], limit: 3, offset: 7, total: 7 });
    expect(ok(await list(cookies.owner, "?limit=100&offset=0")).items).toHaveLength(7);

    for (const search of [
      "?limit=0", "?limit=101", "?limit=two", "?offset=-1", "?offset=100001", "?state=all", "?state=dispatching", "?state=",
      "?pageLabel=", `?pageLabel=${"x".repeat(121)}`, "?userId=1", "?fanRef=720000001", "?cursor=abc",
    ]) {
      expect((await list(cookies.owner, search)).statusCode, search).toBe(400);
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  for (const mode of ["log", "enforce"] as const) {
    it(`rights (${mode}): the owner's and a team lead's cookie; never a chatter, a device token, the extension's token or an agent key`, async () => {
      await switchOn();
      const onLora = await dispatchGreeting("grisha", I1, "lora-of");
      const onMia = await dispatchGreeting("sveta", I3, "mia-of");
      await hold(onLora.attemptId, 20);
      await hold(onMia.attemptId, 10);
      const resolved = await resolve(cookies.owner, "mia-of", onMia.attemptId, { outcome: "sent", note: "seen in the chat" });
      expect(resolved.statusCode, resolved.body).toBe(200);
      app.config.authPolicyEnforcement = mode;

      for (const search of ["", "?state=resolved", "?pageLabel=lora-of"]) {
        expectRefused(await list(null, search), 401, "unauthorized");
        expectRefused(await list(null, search, { authorization: "Bearer agency_hub_device_nosuchtoken" }), 401, "unauthorized");
        // A chatter has no dashboard, by cookie or by any token.
        expectRefused(await list(cookies.grisha, search), 403, "forbidden");
        // A device token is a client's credential, whoever holds it: the owner's and the team lead's too.
        for (const token of [grishaFullToken, leadToken, ownerToken]) {
          expectRefused(await list(null, search, bearer(token)), 403, "forbidden");
        }
        // The extension's narrow token: the route is on no list of its profile.
        for (const token of [narrow.grisha, narrow.nikita, narrow.sveta]) {
          const refused = await list(null, search, bearer(token));
          expect(refused.statusCode, refused.body).toBe(403);
          expect(refused.json()).toEqual(NARROW_REFUSAL);
        }
        expectRefused(await list(null, search, bearer(AGENT_KEY_TOKEN)), 403, "forbidden");
      }

      // The owner: every page. A team lead: the pages assigned to them, in either state.
      expect(attemptsOf(ok(await list(cookies.owner)))).toEqual([onLora.attemptId]);
      expect(attemptsOf(ok(await list(cookies.owner, "?state=resolved")))).toEqual([onMia.attemptId]);
      expect(attemptsOf(ok(await list(cookies.lead)))).toEqual([onLora.attemptId]);
      expect(ok(await list(cookies.lead, "?state=resolved"))).toMatchObject({ items: [], total: 0 });
      expect(ok(await list(cookies.idle))).toMatchObject({ items: [], total: 0 });
      expect(ok(await list(cookies.idle, "?state=resolved"))).toMatchObject({ items: [], total: 0 });
      // One page: a page that is not the team lead's is 403, one that does not exist is 404, for anyone.
      expect(attemptsOf(ok(await list(cookies.lead, "?pageLabel=lora-of")))).toEqual([onLora.attemptId]);
      for (const cookie of [cookies.lead, cookies.idle]) {
        expectRefused(await list(cookie, "?pageLabel=mia-of"), 403, "forbidden");
        expectRefused(await list(cookie, "?state=resolved&pageLabel=mia-of"), 403, "forbidden");
      }
      expectRefused(await list(cookies.idle, "?pageLabel=lora-of"), 403, "forbidden");
      for (const cookie of [cookies.owner, cookies.lead, cookies.idle]) {
        expectRefused(await list(cookie, "?pageLabel=ghost-of"), 404, "not_found");
      }
      // Nothing of mia-of reaches the team lead of lora-of by any spelling of the query.
      for (const search of ["", "?state=resolved", "?limit=100", "?pageLabel=lora-of", "?state=resolved&pageLabel=lora-of"]) {
        const body = await list(cookies.lead, search);
        expect(body.body, search).not.toContain(onMia.attemptId);
        expect(body.body, search).not.toContain(onMia.fan);
        expect(body.body, search).not.toContain("mia-of");
      }

      await trap!.assertNoOutbound();
    }, INTEGRATION_TEST_TIMEOUT_MS);
  }

  it("lists no send of a deleted page: the resolve could not reach it", async () => {
    await switchOn();
    const gone = await dispatchReply("grisha", I1, "gone-of");
    const kept = await dispatchReply("grisha", I1, "lora-of");
    await hold(gone.attemptId, 20);
    await hold(kept.attemptId, 10);
    expect(attemptsOf(ok(await list(cookies.owner)))).toEqual([gone.attemptId, kept.attemptId]);
    const done = await resolve(cookies.owner, "gone-of", gone.attemptId, { outcome: "not_sent", note: "nothing in the chat" });
    expect(done.statusCode, done.body).toBe(200);
    expect(attemptsOf(ok(await list(cookies.owner, "?state=resolved")))).toEqual([gone.attemptId]);

    await query("update pages set status = 'deleted' where id = $1", [pageIds["gone-of"]]);
    expect(ok(await list(cookies.owner))).toMatchObject({ total: 1 });
    expect(attemptsOf(ok(await list(cookies.owner)))).toEqual([kept.attemptId]);
    expect(ok(await list(cookies.owner, "?state=resolved"))).toMatchObject({ items: [], total: 0 });
    expectRefused(await list(cookies.owner, "?pageLabel=gone-of"), 404, "not_found");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads the held sends through the open-send index, not by walking every send ever made", async () => {
    // 20,000 finished sends to 4,000 fans of lora-of, in every final state, and three still held.
    await query(
      `insert into client_send_custody (attempt_id, page_id, fan_ref, user_id, instance_id, purpose, origin, generation_ref,
         variant, part_count, part_index, text_revision, request_hash, state, ticket_hash, ticket_expires_at,
         platform_message_id, failure_reason, resolved_by_user_id, resolved_at, resolution_note, created_at, updated_at)
       select gen_random_uuid(), $1, (730000000 + g % 4000)::text, $2, $3, 'preview-reply', 'preview-send', 'gen-plan-' || g,
         0, 1, 0, 1, sha256(g::text::bytea), state, sha256(g::text::bytea), at + interval '10 seconds',
         case state when 'sent' then (740000000 + g)::text end,
         case state when 'failed' then 'not_enqueued' end,
         case state when 'resolved_not_sent' then $4::bigint end,
         case state when 'resolved_not_sent' then at + interval '1 hour' end,
         case state when 'resolved_not_sent' then 'not in the chat' end,
         at, at
       from (select g, (array['sent', 'failed', 'resolved_not_sent'])[1 + g % 3] as state,
               now() - interval '1 day' - (g || ' seconds')::interval as at
             from generate_series(1, 20000) g) rows`,
      [pageIds["lora-of"], userIds.grisha, I1, userIds.owner],
    );
    await query(
      `insert into client_send_custody (attempt_id, page_id, fan_ref, user_id, instance_id, purpose, origin, generation_ref,
         variant, part_count, part_index, text_revision, request_hash, state, ticket_hash, ticket_expires_at, created_at, updated_at)
       select gen_random_uuid(), $1, (750000000 + g)::text, $2, $3, 'preview-reply', 'preview-send', 'gen-held-' || g,
         0, 1, 0, 1, sha256(g::text::bytea), 'dispatching', sha256(g::text::bytea), now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour'
       from generate_series(1, 3) g`,
      [pageIds["lora-of"], userIds.grisha, I1],
    );
    await query("analyze client_send_custody");

    for (const pages of ["all", [pageIds["lora-of"]!]] as const) {
      const plan = await explainClientSendCustodyListQuery(app.db, { state: "held", pages, limit: 50, offset: 0 });
      expect(plan, plan).toContain("client_send_custody_one_open");
      expect(plan, plan).not.toMatch(/Seq Scan on client_send_custody/);
    }
    const held = ok(await list(cookies.owner));
    expect(held.total).toBe(3);
    expect(held.items.map((item) => item.fanRef).sort()).toEqual(["750000001", "750000002", "750000003"]);
    // The hand-resolved ones are all there to page through, the last resolved first.
    const resolved = ok(await list(cookies.lead, "?state=resolved&limit=2"));
    expect(resolved.total).toBe(6667);
    expect(resolved.items.map((item) => item.resolution!.at)).toEqual(
      [...resolved.items.map((item) => item.resolution!.at)].sort().reverse(),
    );

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
