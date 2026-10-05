import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientBootstrapResponseSchema,
  clientFanClaimResponseSchema,
  clientSendCustodyItemSchema,
  errorResponseSchema,
  type ClientFanClaimResponse,
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
import { frozenClaimBodySchema, frozenClaimStateSchema, frozenErrorBodySchema } from "./helpers/client-claim-frozen.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension H-7b: the greeting lease and send custody as routes.
//   POST /api/v1/client/pages/:pageLabel/fans/:fanRef/claim      (clientFanClaim)
//   GET  /api/v1/client/pages/:pageLabel/fans/:fanRef/claim      (clientFanClaimStatus)
//   POST /api/v1/pages/:pageLabel/client-send-custody/:attemptId/resolve  (clientSendCustodyResolve)
// The rules on real rows without HTTP are tests/client-claim.integration.test.ts
// (H-7a); this file holds what the routes add: who may call, which of the
// owner's switches an action waits for, the switch read inside the dispatch's
// transaction, and the wire. Every test runs under the no-outbound trap: the
// routes read and write the database and nothing else (critic item 8).

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = {
  owner: "owner-secret", lead: "lead-secret", grisha: "grisha-secret", nikita: "nikita-secret",
} as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** A live Agent Read Plane key, granted lora-of: its refusal is about the principal kind, not a page. */
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}clientclaim000000000`;
/** Client installs: two of grisha's, one of nikita's. */
const I1 = randomUUID();
const I2 = randomUUID();
const I3 = randomUUID();

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Body = Record<string, unknown>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
/**
 * authPolicyEnforcement "log" (the test default): the handler's own guards
 * answer. The rights tests flip `app.config.authPolicyEnforcement` to "enforce",
 * where the declared policy answers before the handler; afterEach puts it back.
 */
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
let leadCookie = "";
let grishaCookie = "";
let ownerToken = "";
let leadToken = "";
/** Narrow chat-extension tokens of two chatters of lora-of. */
let grishaToken = "";
let nikitaToken = "";
/** A full device token of the same chatter (an old client's). */
let grishaFullToken = "";
/** A chatter of mia-of only. */
let svetaToken = "";
const userIds: Record<"owner" | "lead" | "grisha" | "nikita" | "sveta", number> = {
  owner: 0, lead: 0, grisha: 0, nikita: 0, sveta: 0,
};
const pageIds: Record<string, number> = {};
let fanSeq = 700_000_000;
const nextFan = () => String(++fanSeq);

function bearer(token: string, clientVersion: string | null = EXTENSION_VERSION): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(clientVersion === null ? {} : { "x-client-version": clientVersion }) };
}

interface CallOptions {
  pageLabel?: string;
  clientVersion?: string | null;
}

const claimUrl = (fan: string, pageLabel = "lora-of") => `/api/v1/client/pages/${pageLabel}/fans/${fan}/claim`;

/** One action, as the extension's own schema lets it out. */
function act(token: string, fan: string, body: Body, options: CallOptions = {}) {
  expect(frozenClaimBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
  return server!.inject({
    method: "POST",
    url: claimUrl(fan, options.pageLabel),
    headers: bearer(token, options.clientVersion),
    payload: body,
  });
}

function status(token: string, fan: string, options: CallOptions = {}) {
  return server!.inject({
    method: "GET",
    url: claimUrl(fan, options.pageLabel),
    headers: bearer(token, options.clientVersion),
  });
}

/** A 200 whose body is the client's frozen state and nothing more. */
function ok(response: InjectResponse): ClientFanClaimResponse {
  expect(response.statusCode, response.body).toBe(200);
  const body = clientFanClaimResponseSchema.parse(response.json());
  // Neither schema is strict; nothing was stripped by either.
  expect(response.json()).toEqual(body);
  expect(frozenClaimStateSchema.parse(response.json())).toEqual(body);
  // The holder of a lease or of a send is never named.
  expect(response.body).not.toMatch(/grisha|nikita|userId/i);
  return body;
}

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode });
  expect(body.reason, response.body).toBe(reason);
  expect(frozenErrorBodySchema.safeParse(response.json()).success, response.body).toBe(true);
  expect(response.body).not.toMatch(/grisha|nikita/i);
}

const group = (over: Body = {}) => ({ generationRef: randomUUID(), variant: 0, partCount: 3, ...over });
const claimBody = (instanceId: string, leaseToken: string = randomUUID()) => ({ action: "claim", leaseToken, instanceId });
const dispatchBody = (over: Body = {}): Body => ({
  action: "dispatch", attemptId: randomUUID(), instanceId: I1, purpose: "greeting", group: group(),
  partIndex: 0, textRevision: 1, flagRevision: 0, ...over,
});
const replyBody = (over: Body = {}) => dispatchBody({ purpose: "preview-reply", group: group({ partCount: 1 }), ...over });
const sentBody = (attemptId: string, platformMessageId: string, instanceId = I1) => ({
  action: "sent", attemptId, instanceId, platformMessageId, evidence: "receipt+echo",
});
const nativeBody = (over: Body = {}): Body => ({
  action: "registerNativeSend", attemptId: randomUUID(), instanceId: I1, purpose: "greeting", group: group(),
  partIndex: 0, platformMessageId: String(++fanSeq), ...over,
});

async function patchConfigRaw(patches: Array<{ key: string; value: unknown }>) {
  return server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: ownerCookie },
    payload: { patches },
  });
}

async function patchConfig(patches: Array<{ key: string; value: unknown }>) {
  const response = await patchConfigRaw(patches);
  expect(response.statusCode, response.body).toBe(200);
}

const features = (flags: Record<string, boolean>, pages: Record<string, Record<string, boolean>> = {}) =>
  ({ key: "chatExtensionFeatures", value: JSON.stringify({ "*": flags, ...pages }) });

/** The owner's switches as a pilot page has them: the extension, «Новые» and sending from the preview on. */
async function switchOn(flags: Record<string, boolean> = { newcomers: true, previewSend: true }) {
  await patchConfig([{ key: "chatExtensionEnabled", value: true }, features(flags)]);
}

async function loginCookie(username: keyof typeof PASSWORDS): Promise<string> {
  const login = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: PASSWORDS[username] },
  });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}

async function narrowTokenOf(username: "grisha" | "nikita"): Promise<string> {
  const signIn = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/device-tokens/password",
    headers: { "x-client-version": EXTENSION_VERSION },
    payload: {
      username,
      password: PASSWORDS[username],
      label: "Firefox · macOS · ChatSpace",
      mode: "active",
      client: "chat-extension",
    },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  expect(signIn.json()).toMatchObject({ client: "chat-extension" });
  return signIn.json<{ token: string }>().token;
}

function resolve(cookie: string | null, attemptId: string, body: Body, options: CallOptions & { headers?: Record<string, string> } = {}) {
  return server!.inject({
    method: "POST",
    url: `/api/v1/pages/${options.pageLabel ?? "lora-of"}/client-send-custody/${attemptId}/resolve`,
    headers: { ...(cookie === null ? {} : { cookie }), ...options.headers },
    payload: body,
  });
}

const query = <Row extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  testDb!.pool.query<Row>(text, values).then((result) => result.rows);

const custodyRows = (fan: string) => query<{
  attempt_id: string; state: string; origin: string; user_id: string; flag_revision: number | null;
  platform_message_id: string | null; ticket_hash: string | null;
}>(
  `select attempt_id::text, state, origin, user_id::text, flag_revision, platform_message_id,
     encode(ticket_hash, 'hex') as ticket_hash
   from client_send_custody where fan_ref = $1 order by created_at, attempt_id`,
  [fan],
);

/** Past the ticket: the dispatch never reported. */
const expireTicket = (attemptId: string) => query(
  "update client_send_custody set ticket_expires_at = now() - interval '1 second' where attempt_id = $1",
  [attemptId],
);
const expireLease = (leaseToken: string) => query(
  "update client_fan_leases set expires_at = now() - interval '1 second' where lease_id = $1",
  [leaseToken],
);
/** Moves every recorded send out of the 60 s rate window. */
const agePreviewSends = () => query("update client_send_custody set created_at = created_at - interval '2 minutes'");

/** Waits until a backend's query like `pattern` waits on a lock. */
async function waitForLockWait(pattern: string) {
  for (let tries = 0; ; tries += 1) {
    const [row] = await query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and query ilike $1`,
      [pattern],
    );
    if (row!.n > 0) return;
    if (tries > 1000) throw new Error(`no query like ${pattern} ever waited on a lock`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function bootstrapRevision(token: string): Promise<number> {
  const response = await server!.inject({ method: "GET", url: "/api/v1/client/bootstrap", headers: bearer(token) });
  expect(response.statusCode, response.body).toBe(200);
  return clientBootstrapResponseSchema.parse(response.json()).configRevision;
}

/** A lease of grisha's first install on the fan, then the first part of a greeting dispatched under it. */
async function dispatchedGreeting(fan: string, over: Body = {}) {
  const leaseToken = randomUUID();
  ok(await act(grishaToken, fan, claimBody(I1, leaseToken)));
  const body = dispatchBody({ leaseToken, ...over });
  const answer = ok(await act(grishaToken, fan, body));
  return { leaseToken, body, attemptId: body.attemptId as string, group: body.group as Body, answer };
}

describe("chat-extension claim and custody routes", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb, { authPolicyEnforcement: "log" });

    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    for (const username of ["grisha", "nikita", "sveta"]) {
      await createUserAccount(app, { username, role: "chatter" }, AUDIT);
    }
    for (const username of ["owner", "lead", "grisha", "nikita", "sveta"] as const) {
      userIds[username] = await fixtureUserId(app, username);
    }
    // A chatter is created without a password and sets one later; it ends every
    // sign-in, so it comes before the tokens below.
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
    for (const [label, account] of [["lora-of", "100000001"], ["mia-of", "100000003"]] as const) {
      await testDb.pool.query("update pages set external_page_id = $1 where id = $2", [account, pageIds[label]]);
    }
    for (const [userId, labels] of [
      [userIds.grisha, ["lora-of", "lora-fansly"]],
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
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, '700000001', 3)",
      [pageIds["lora-of"]],
    );

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: userIds.owner, label: "owner client" })).token;
    leadToken = (await issueDeviceTokenForUserId(app, { userId: userIds.lead, label: "lead client" })).token;
    svetaToken = (await issueDeviceTokenForUserId(app, { userId: userIds.sveta, label: "sveta client" })).token;
    grishaFullToken = (await issueDeviceTokenForUserId(app, { userId: userIds.grisha, label: "grisha desktop" })).token;
    await insertAgentKey(app.db, {
      name: "client-claim-probe",
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

    grishaToken = await narrowTokenOf("grisha");
    nikitaToken = await narrowTokenOf("nikita");
    ownerCookie = await loginCookie("owner");
    leadCookie = await loginCookie("lead");
    grishaCookie = await loginCookie("grisha");
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    // Every test starts with the switches at rest and outside the previous
    // tests' 60 s preview-send rate window.
    await testDb.pool.query("delete from config_settings where key like 'chatExtension%'");
    await agePreviewSends();
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

  it("is inert at merge: nothing is claimed or sent until the owner switches it on, and each action waits for its own switch", async () => {
    const fan = nextFan();
    // Everything that starts something: a lease, a send, and the status read.
    const starting = [
      claimBody(I1),
      { ...claimBody(I1), action: "renew" },
      dispatchBody({ leaseToken: randomUUID() }),
      replyBody(),
    ];
    for (const token of [grishaToken, grishaFullToken]) {
      for (const body of starting) {
        expectRefused(await act(token, fan, body), 409, "client_feature_disabled", "disabled");
      }
      expectRefused(await status(token, fan), 409, "client_feature_disabled", "disabled");
    }
    // The three actions that only end what the hub admitted wait for no switch:
    // they answer what is true, and here there is nothing to end.
    expectRefused(await act(grishaToken, fan, { ...claimBody(I1), action: "release" }), 409, "claim_expired");
    expectRefused(await act(grishaToken, fan, sentBody(randomUUID(), "7001")), 409, "custody_not_owned");
    expectRefused(
      await act(grishaToken, fan, { action: "failed", attemptId: randomUUID(), instanceId: I1, reason: "not_enqueued" }),
      409,
      "custody_not_owned",
    );
    // Nor does the report of a send that already happened: it starts nothing, and refusing it
    // would only lose the fact. The one thing the hub takes at rest; no client sends it yet.
    const atRest = nextFan();
    expect(ok(await act(grishaToken, atRest, nativeBody())).greeting).toMatchObject({ state: "confirmed", source: "native-register" });
    expect((await custodyRows(atRest)).map((row) => [row.state, row.origin])).toEqual([["sent", "native-register"]]);

    // The master switch alone: the flag-less status answers, the flagged actions do not.
    await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
    expect(ok(await status(grishaToken, fan))).toMatchObject({
      greeting: { state: "none" }, lease: { state: "none" }, group: null, custody: null,
    });
    expectRefused(await act(grishaToken, fan, claimBody(I1)), 409, "client_feature_disabled", "flag_off");
    expectRefused(await act(grishaToken, fan, replyBody()), 409, "client_feature_disabled", "flag_off");
    expectRefused(await act(grishaToken, fan, dispatchBody()), 409, "client_feature_disabled", "flag_off");

    // Nothing was claimed or recorded by the refusals above.
    expect(await query("select 1 from client_fan_leases where fan_ref = $1", [fan])).toEqual([]);
    expect(await custodyRows(fan)).toEqual([]);

    // Both flags on: the hub serves everything «Новые» needs (the list is H-7c), so the owner's switches decide.
    await patchConfig([features({ newcomers: true, previewSend: true })]);
    const replyFan = nextFan();
    expect(ok(await act(grishaToken, replyFan, replyBody())).custody).toMatchObject({ state: "dispatching" });
    expect(ok(await act(grishaToken, fan, claimBody(I1))).lease.state).toBe("owned");

    // A greeting needs both flags; a reply only `previewSend`; a lease only `newcomers`.
    await patchConfig([features({ newcomers: false, previewSend: true })]);
    expectRefused(await act(grishaToken, nextFan(), claimBody(I1)), 409, "client_feature_disabled", "flag_off");
    expectRefused(await act(grishaToken, nextFan(), dispatchBody()), 409, "client_feature_disabled", "flag_off");
    expect(ok(await act(grishaToken, nextFan(), replyBody())).custody).toMatchObject({ state: "dispatching" });
    await patchConfig([features({ newcomers: true, previewSend: false })]);
    expect(ok(await act(grishaToken, nextFan(), claimBody(I1))).lease.state).toBe("owned");
    expectRefused(await act(grishaToken, nextFan(), replyBody()), 409, "client_feature_disabled", "flag_off");
    // The page's own flag wins over "*".
    await patchConfig([features({ newcomers: true, previewSend: true }, { "lora-of": { previewSend: false } })]);
    expectRefused(await act(grishaToken, nextFan(), replyBody()), 409, "client_feature_disabled", "flag_off");
    await patchConfig([features({ newcomers: true, previewSend: true })]);

    // The features exist on OnlyFans only, and so do the flag-less status and native record.
    for (const body of [claimBody(I1), dispatchBody(), replyBody(), nativeBody()]) {
      expectRefused(await act(grishaToken, fan, body, { pageLabel: "lora-fansly" }), 409, "client_feature_disabled", "platform_unsupported");
    }
    expectRefused(await status(grishaToken, fan, { pageLabel: "lora-fansly" }), 409, "client_feature_disabled", "platform_unsupported");
    expect(await query("select 1 from client_send_custody where page_id = $1", [pageIds["lora-fansly"]])).toEqual([]);
    // An old client's version, or none, is not the extension: refused, never passed.
    for (const clientVersion of ["chatgoose-extension/2.7.1", "0.1.64", null]) {
      for (const body of [claimBody(I1), replyBody()]) {
        expectRefused(await act(grishaFullToken, nextFan(), body, { clientVersion }), 409, "client_feature_disabled", "client_outdated");
      }
      expectRefused(await status(grishaFullToken, fan, { clientVersion }), 409, "client_feature_disabled", "client_outdated");
    }
    await patchConfig([{ key: "chatExtensionMinVersion", value: "1.5.0" }]);
    expectRefused(await act(grishaToken, nextFan(), replyBody()), 409, "client_feature_disabled", "client_outdated");
    expectRefused(await status(grishaToken, fan), 409, "client_feature_disabled", "client_outdated");
    await patchConfig([{ key: "chatExtensionMinVersion", value: "1.4.2" }]);

    // The master switch ends everything that starts something.
    await patchConfig([{ key: "chatExtensionEnabled", value: false }]);
    expectRefused(await act(grishaToken, nextFan(), replyBody()), 409, "client_feature_disabled", "disabled");
    expectRefused(await status(grishaToken, fan), 409, "client_feature_disabled", "disabled");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("two people, two installs and two tabs claim at once: exactly one holds the lease, and nobody is named", async () => {
    await switchOn();
    const fan = nextFan();
    const attempts = [
      { who: "grisha", token: grishaToken, body: claimBody(I1) },
      // A second tab of the same install: its own lease token.
      { who: "grisha", token: grishaToken, body: claimBody(I1) },
      { who: "grisha", token: grishaToken, body: claimBody(I2) },
      { who: "nikita", token: nikitaToken, body: claimBody(I3) },
    ];
    const responses = await Promise.all(attempts.map((attempt) => act(attempt.token, fan, attempt.body)));
    const winners = responses.flatMap((response, index) => (response.statusCode === 200 ? [index] : []));
    expect(winners).toHaveLength(1);
    const winner = attempts[winners[0]!]!;
    const owned = ok(responses[winners[0]!]!);
    expect(owned.lease).toMatchObject({ state: "owned", leaseToken: winner.body.leaseToken, heldBy: null });
    expect(owned).toMatchObject({ greeting: { state: "none" }, group: null, custody: null });
    for (const [index, response] of responses.entries()) {
      if (index !== winners[0]) expectRefused(response, 409, "claim_busy");
    }
    expect(await query("select state from client_fan_leases where fan_ref = $1", [fan])).toEqual([{ state: "active" }]);

    // The status names no install, so the holder itself reads `you-elsewhere`.
    const other = winner.who === "grisha" ? nikitaToken : grishaToken;
    expect(ok(await status(winner.token, fan)).lease).toMatchObject({ state: "held", heldBy: "you-elsewhere", leaseToken: null });
    expect(ok(await status(other, fan)).lease).toMatchObject({ state: "held", heldBy: "someone-else", leaseToken: null });
    // The same claim again reads the lease as owned and extends nothing.
    const again = ok(await act(winner.token, fan, winner.body));
    expect(again.lease).toEqual(owned.lease);
    const renewed = ok(await act(winner.token, fan, { ...winner.body, action: "renew" }));
    expect(Date.parse(renewed.lease.expiresAt!)).toBeGreaterThan(Date.parse(owned.lease.expiresAt!));
    // Another install of the same person cannot renew or release it.
    if (winner.who === "grisha") {
      const elsewhere = winner.body.instanceId === I1 ? I2 : I1;
      expectRefused(await act(grishaToken, fan, { ...winner.body, action: "renew", instanceId: elsewhere }), 409, "claim_busy");
    }
    expect(ok(await act(winner.token, fan, { ...winner.body, action: "release" })).lease).toMatchObject({ state: "released" });
    // A token names one lease, once: it is not revived; a new one takes the fan.
    expectRefused(await act(winner.token, fan, winner.body), 409, "claim_expired");
    expect(ok(await act(other, fan, claimBody(winner.who === "grisha" ? I3 : I1))).lease.state).toBe("owned");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a lease expires by itself: the late renew is claim_expired and a greeting needs the live lease", async () => {
    await switchOn();
    const fan = nextFan();
    // No lease at all: the greeting is refused, the reply from the preview needs none.
    expectRefused(await act(grishaToken, fan, dispatchBody()), 409, "claim_expired");
    const leaseToken = randomUUID();
    ok(await act(grishaToken, fan, claimBody(I1, leaseToken)));
    await expireLease(leaseToken);
    expectRefused(await act(grishaToken, fan, { ...claimBody(I1, leaseToken), action: "renew" }), 409, "claim_expired");
    expectRefused(await act(grishaToken, fan, dispatchBody({ leaseToken })), 409, "claim_expired");
    expect(ok(await status(grishaToken, fan)).lease).toMatchObject({ state: "none", leaseToken: null });

    const theirs = randomUUID();
    expect(ok(await act(nikitaToken, fan, claimBody(I3, theirs))).lease).toMatchObject({ state: "owned", leaseToken: theirs });
    expect(await query("select state from client_fan_leases where fan_ref = $1 order by created_at", [fan]))
      .toEqual([{ state: "expired" }, { state: "active" }]);
    // The fan is someone else's now: neither the old token nor a lease-less greeting passes.
    expectRefused(await act(grishaToken, fan, dispatchBody({ leaseToken })), 409, "claim_busy");
    expectRefused(await act(grishaToken, fan, dispatchBody()), 409, "claim_busy");
    expectRefused(await act(grishaToken, fan, dispatchBody({ leaseToken: theirs })), 409, "claim_busy");
    expect(await custodyRows(fan)).toEqual([]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a dispatch answers a one-time ticket; a repeat only reads, another body conflicts, and the report confirms the greeting", async () => {
    await switchOn();
    const fan = nextFan();
    const revision = await bootstrapRevision(grishaToken);
    expect(revision).toBeGreaterThan(0);
    // The client acted on an older bootstrap: recorded, never a refusal (critic 7).
    const { body, attemptId, group: sentGroup, answer } = await dispatchedGreeting(fan, { flagRevision: revision - 1 });
    expect(answer).toMatchObject({
      greeting: { state: "none" },
      lease: { state: "owned" },
      // In flight, not held: `custody` says the part is on its way.
      group: { ...sentGroup, sentParts: [], heldParts: [] },
      custody: { attemptId, state: "dispatching" },
      flagRevision: revision,
    });
    const ticket = answer.custody!.ticket!;
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Ten seconds from the decision; `serverNow` is read a moment after it.
    const ticketLife = Date.parse(answer.custody!.ticketExpiresAt!) - Date.parse(answer.serverNow);
    expect(ticketLife).toBeGreaterThan(9_000);
    expect(ticketLife).toBeLessThanOrEqual(10_000);
    // Only the ticket's sha256 is kept.
    expect(await custodyRows(fan)).toEqual([{
      attempt_id: attemptId, state: "dispatching", origin: "preview-send", user_id: String(userIds.grisha),
      flag_revision: revision - 1, platform_message_id: null,
      ticket_hash: createHash("sha256").update(ticket).digest("hex"),
    }]);

    // A repeat reads; no second ticket ever leaves.
    const repeat = ok(await act(grishaToken, fan, body));
    expect(repeat.custody).toMatchObject({ attemptId, state: "dispatching", ticket: null });
    expectRefused(await act(grishaToken, fan, { ...body, textRevision: 2 }), 409, "attempt_conflict");
    expectRefused(await act(grishaToken, fan, { ...body, flagRevision: revision }), 409, "attempt_conflict");
    expect(ok(await status(grishaToken, fan)).custody).toEqual({ ...repeat.custody });
    // Another person sees the send, never the ticket.
    expect(ok(await status(nikitaToken, fan))).toMatchObject({
      lease: { state: "held", heldBy: "someone-else" }, custody: { attemptId, state: "dispatching", ticket: null },
    });

    // The owner switches sending off while the part is in flight.
    await patchConfig([features({ newcomers: true, previewSend: false })]);
    // A client that lost the first answer repeats: it still reads its attempt (no ticket), so it knows what to report.
    expect(ok(await act(grishaToken, fan, body)).custody).toMatchObject({ attemptId, state: "dispatching", ticket: null });
    expectRefused(await act(grishaToken, nextFan(), replyBody()), 409, "client_feature_disabled", "flag_off");

    // Only the person and the install that dispatched report the outcome (critic 12).
    expectRefused(await act(grishaToken, fan, sentBody(attemptId, "7001", I2)), 409, "custody_not_owned");
    expectRefused(await act(nikitaToken, fan, sentBody(attemptId, "7001", I1)), 409, "custody_not_owned");
    // The report ends a send the hub admitted: it waits for no switch.
    const reported = ok(await act(grishaToken, fan, sentBody(attemptId, "7001")));
    expect(reported).toMatchObject({
      greeting: { state: "confirmed", messageRef: "7001", source: "preview-send" },
      group: { ...sentGroup, sentParts: [0], heldParts: [] },
      custody: { attemptId, state: "sent", ticket: null },
    });
    expect(ok(await act(grishaToken, fan, sentBody(attemptId, "7001"))).custody).toMatchObject({ state: "sent" });
    expectRefused(await act(grishaToken, fan, sentBody(attemptId, "7002")), 409, "attempt_conflict");
    expect(await query("select owner_user_id::text, first_message_ref, source from client_greetings where fan_ref = $1", [fan]))
      .toEqual([{ owner_user_id: String(userIds.grisha), first_message_ref: "7001", source: "preview-send" }]);
    // The status names no attempt: the dispatcher reads their own last send, anyone else no send at all.
    expect(ok(await status(grishaToken, fan)).custody).toMatchObject({ attemptId, state: "sent", ticket: null });
    expect(ok(await status(nikitaToken, fan))).toMatchObject({ greeting: { state: "confirmed" }, custody: null });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads the switch inside the dispatch: off holds from the next dispatch, and a change waits for one in flight (critic 7)", async () => {
    await switchOn();
    // Off, then a dispatch at once: no cache to outlive the owner's switch.
    ok(await act(grishaToken, nextFan(), replyBody()));
    await patchConfig([features({ newcomers: true, previewSend: false })]);
    const refusedFan = nextFan();
    expectRefused(await act(grishaToken, refusedFan, replyBody()), 409, "client_feature_disabled", "flag_off");
    await patchConfig([features({ newcomers: true, previewSend: true }), { key: "chatExtensionEnabled", value: false }]);
    expectRefused(await act(grishaToken, refusedFan, replyBody()), 409, "client_feature_disabled", "disabled");
    expect(await custodyRows(refusedFan)).toEqual([]);
    await patchConfig([{ key: "chatExtensionEnabled", value: true }]);

    // A dispatch in flight: held after its switch read, at its insert, by an
    // uncommitted row that carries its attempt id on another fan.
    const [fan, attemptId] = [nextFan(), randomUUID()];
    const hash = createHash("sha256").update(attemptId).digest();
    const blocker = await testDb!.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query(
        `insert into client_send_custody (attempt_id, page_id, fan_ref, user_id, instance_id, purpose, origin,
           generation_ref, variant, part_count, part_index, text_revision, request_hash, state, ticket_hash,
           ticket_expires_at)
         values ($1, $2, $3, $4, $5, 'preview-reply', 'preview-send', 'gen-x', 0, 1, 0, 1, $6, 'dispatching', $6,
           now() + interval '10 seconds')`,
        [attemptId, pageIds["lora-of"], nextFan(), userIds.nikita, I3, hash],
      );
      const dispatching = act(grishaToken, fan, replyBody({ attemptId }));
      await waitForLockWait("insert into client_send_custody%");
      // The owner switches sending off: the write waits for the dispatch that read the switch.
      let switchedOff = false;
      const switching = patchConfigRaw([features({ newcomers: true, previewSend: false })])
        .then((response) => { switchedOff = true; return response; });
      await waitForLockWait("%config_settings%for update%");
      expect(switchedOff).toBe(false);
      await blocker.query("rollback");
      // The dispatch was decided on the switch as it stood, and it finishes first.
      const dispatched = ok(await dispatching);
      expect(dispatched.custody).toMatchObject({ attemptId, state: "dispatching" });
      expect(dispatched.custody!.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await switching).statusCode).toBe(200);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
    expectRefused(await act(grishaToken, nextFan(), replyBody()), 409, "client_feature_disabled", "flag_off");

    // The other order: a change under way. The dispatch waits for it and reads it.
    await patchConfig([features({ newcomers: true, previewSend: true })]);
    const lateFan = nextFan();
    const changing = await testDb!.pool.connect();
    try {
      await changing.query("begin");
      await changing.query("update config_settings set value = 'false'::jsonb where key = 'chatExtensionEnabled'");
      const waiting = act(grishaToken, lateFan, replyBody());
      await waitForLockWait("%config_settings%for share%");
      await changing.query("commit");
      expectRefused(await waiting, 409, "client_feature_disabled", "disabled");
    } finally {
      await changing.query("rollback").catch(() => undefined);
      changing.release();
    }
    expect(await custodyRows(lateFan)).toEqual([]);

    await trap!.assertNoOutbound();
    // Three waits for a lock to show in pg_stat_activity, each up to ~10 s on a loaded runner.
  }, 2 * INTEGRATION_TEST_TIMEOUT_MS);

  it("only the owner's stored switches admit a send: a value the environment alone sets admits none", async () => {
    const config = app.config as { chatExtensionEnabled?: boolean; chatExtensionFeatures?: string };
    const before = { ...config };
    try {
      config.chatExtensionEnabled = true;
      config.chatExtensionFeatures = JSON.stringify({ "*": { newcomers: true, previewSend: true } });
      const fan = nextFan();
      // Every other check reads the environment under the stored rows, as before.
      const leaseToken = randomUUID();
      expect(ok(await act(grishaToken, fan, claimBody(I1, leaseToken))).lease.state).toBe("owned");
      // A send has no stored row to lock, so nothing could make its switch-off wait.
      expectRefused(await act(grishaToken, fan, dispatchBody({ leaseToken })), 409, "client_feature_disabled", "disabled");
      expectRefused(await act(grishaToken, nextFan(), replyBody()), 409, "client_feature_disabled", "disabled");
      await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
      expectRefused(await act(grishaToken, nextFan(), replyBody()), 409, "client_feature_disabled", "flag_off");
      await patchConfig([features({ previewSend: true })]);
      // The stored flags are the whole of them: `newcomers` is in the environment only.
      expectRefused(await act(grishaToken, fan, dispatchBody({ leaseToken })), 409, "client_feature_disabled", "flag_off");
      expect(ok(await act(grishaToken, nextFan(), replyBody())).custody).toMatchObject({ state: "dispatching" });
    } finally {
      Object.assign(config, { chatExtensionEnabled: before.chatExtensionEnabled, chatExtensionFeatures: before.chatExtensionFeatures });
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("an id in another letter case names the same lease and the same attempt", async () => {
    await switchOn();
    const fan = nextFan();
    const leaseToken = randomUUID();
    const upper = (body: Body) => Object.fromEntries(Object.entries(body).map(([key, value]) => [
      key,
      ["leaseToken", "instanceId", "attemptId"].includes(key) ? String(value).toUpperCase() : value,
    ]));
    // The client's id form is hex in any case; the hub keeps one spelling (Postgres's).
    expect(ok(await act(grishaToken, fan, upper(claimBody(I1, leaseToken)))).lease).toMatchObject({ state: "owned", leaseToken });
    expect(ok(await act(grishaToken, fan, { ...claimBody(I1, leaseToken), action: "renew" })).lease.state).toBe("owned");
    const body = dispatchBody({ leaseToken });
    const first = ok(await act(grishaToken, fan, upper(body)));
    expect(first.custody).toMatchObject({ attemptId: body.attemptId, state: "dispatching" });
    expect(first.custody!.ticket).not.toBeNull();
    // The same attempt, spelled the other way: a repeat, never a second ticket and never a conflict.
    expect(ok(await act(grishaToken, fan, body)).custody).toMatchObject({ attemptId: body.attemptId, ticket: null });
    expect(ok(await act(grishaToken, fan, upper(sentBody(body.attemptId as string, "7401")))).custody).toMatchObject({ state: "sent" });
    expect(await custodyRows(fan)).toHaveLength(1);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a dispatch that never reports holds the fan: uncertain-held outlives the lease until the late proof", async () => {
    await switchOn();
    const fan = nextFan();
    const { leaseToken, attemptId, group: heldGroup } = await dispatchedGreeting(fan);
    // The client crashed after the dispatch: the ticket runs out, then the lease.
    await expireTicket(attemptId);
    await expireLease(leaseToken);
    expect(ok(await status(grishaToken, fan))).toMatchObject({
      greeting: { state: "none" },
      group: { ...heldGroup, sentParts: [], heldParts: [0] },
      custody: { attemptId, state: "uncertain-held", ticket: null },
    });

    // The next person takes the lease, and still cannot send anything to the fan.
    const theirs = randomUUID();
    expect(ok(await act(nikitaToken, fan, claimBody(I3, theirs))).lease.state).toBe("owned");
    expectRefused(await act(nikitaToken, fan, dispatchBody({ instanceId: I3, leaseToken: theirs })), 409, "custody_held");
    expectRefused(await act(nikitaToken, fan, replyBody({ instanceId: I3 })), 409, "custody_held");
    expectRefused(await act(grishaToken, fan, replyBody()), 409, "custody_held");
    expect(ok(await status(nikitaToken, fan))).toMatchObject({
      lease: { state: "held", heldBy: "you-elsewhere" }, custody: { attemptId, state: "uncertain-held" },
    });
    // Neither another install's report nor anyone else's frees it.
    const failed = { action: "failed", attemptId, reason: "not_enqueued" };
    expectRefused(await act(grishaToken, fan, { ...failed, instanceId: I2 }), 409, "custody_not_owned");
    expectRefused(await act(nikitaToken, fan, { ...failed, instanceId: I1 }), 409, "custody_not_owned");
    // Nor the dispatcher's own, once the ticket is over: uncertain-held never becomes failed
    // (the client's frozen transitions). Only the late proof or the manual resolve ends it.
    expectRefused(await act(grishaToken, fan, { ...failed, instanceId: I1 }), 409, "custody_held");
    expectRefused(
      await act(grishaToken, fan, { ...failed, instanceId: I1, reason: "native_rejected", httpStatus: 403 }),
      409,
      "custody_held",
    );
    expect((await custodyRows(fan))[0]).toMatchObject({ state: "dispatching" });
    // Nor does time: the dispatch is a day old and still holds the fan.
    await query("update client_send_custody set created_at = created_at - interval '1 day', ticket_expires_at = ticket_expires_at - interval '1 day' where attempt_id = $1", [attemptId]);
    await expireLease(theirs);
    expectRefused(await act(nikitaToken, fan, replyBody({ instanceId: I3 })), 409, "custody_held");

    // The late proof from the install that dispatched ends it and confirms the greeting.
    expect(ok(await act(grishaToken, fan, sentBody(attemptId, "7101")))).toMatchObject({
      greeting: { state: "confirmed", messageRef: "7101", source: "preview-send" },
      custody: { attemptId, state: "sent" },
    });
    expectRefused(await act(nikitaToken, fan, dispatchBody({ instanceId: I3 })), 409, "greeting_done");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("three parts of one greeting: the first confirmation fences everyone else and every other generation", async () => {
    await switchOn();
    const fan = nextFan();
    const { leaseToken, attemptId, group: parts } = await dispatchedGreeting(fan);
    expect(ok(await act(grishaToken, fan, sentBody(attemptId, "7201"))).greeting).toMatchObject({ state: "confirmed", messageRef: "7201" });
    ok(await act(grishaToken, fan, { ...claimBody(I1, leaseToken), action: "release" }));

    // The owner of the greeting sends the rest of the same group without a lease, from any install.
    const second = dispatchBody({ group: parts, partIndex: 1, instanceId: I2 });
    expect(ok(await act(grishaToken, fan, second))).toMatchObject({
      group: { sentParts: [0], heldParts: [] }, custody: { state: "dispatching" },
    });
    ok(await act(grishaToken, fan, sentBody(second.attemptId as string, "7202", I2)));
    // A second greeting after the confirmation (critic 13): another generation of the owner's, anyone else's at all.
    expectRefused(await act(grishaToken, fan, dispatchBody({ partIndex: 2 })), 409, "generation_mismatch");
    expectRefused(await act(grishaToken, fan, dispatchBody({ group: { ...parts, variant: 1 }, partIndex: 2 })), 409, "generation_mismatch");
    // Nobody else takes a lease on a greeted fan: it would only lead to a second greeting, by hand if not from the preview.
    const theirs = randomUUID();
    expectRefused(await act(nikitaToken, fan, claimBody(I3, theirs)), 409, "greeting_done");
    expect(await query("select state from client_fan_leases where fan_ref = $1", [fan])).toEqual([{ state: "released" }]);
    expectRefused(await act(nikitaToken, fan, dispatchBody({ instanceId: I3, leaseToken: theirs })), 409, "greeting_done");
    expectRefused(await act(nikitaToken, fan, dispatchBody({ instanceId: I3, group: parts, partIndex: 2 })), 409, "greeting_done");
    // The owner may hold the fan again while sending the rest.
    const again = randomUUID();
    expect(ok(await act(grishaToken, fan, claimBody(I1, again))).lease).toMatchObject({ state: "owned", leaseToken: again });
    // Each part once.
    expectRefused(await act(grishaToken, fan, dispatchBody({ group: parts, partIndex: 0 })), 409, "part_already_sent");

    const third = dispatchBody({ group: parts, partIndex: 2 });
    ok(await act(grishaToken, fan, third));
    expect(ok(await act(grishaToken, fan, sentBody(third.attemptId as string, "7203")))).toMatchObject({
      greeting: { state: "confirmed", messageRef: "7201", source: "preview-send" },
      group: { ...parts, sentParts: [0, 1, 2], heldParts: [] },
    });
    expect((await custodyRows(fan)).map((row) => [row.state, row.platform_message_id]))
      .toEqual([["sent", "7201"], ["sent", "7202"], ["sent", "7203"]]);
    // A reply from the preview to a greeted fan is a send of its own.
    expect(ok(await act(nikitaToken, fan, replyBody({ instanceId: I3 }))).custody).toMatchObject({ state: "dispatching" });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a failure frees the fan only with proof the native queue never took the part", async () => {
    await switchOn();
    const fan = nextFan();
    const first = replyBody();
    const attemptId = first.attemptId as string;
    ok(await act(grishaToken, fan, first));
    const rejected = { action: "failed", attemptId, instanceId: I1, reason: "native_rejected", httpStatus: 403 };
    // A 401 proves nothing about the send, and a status belongs to a native refusal only: 400 before any handler.
    for (const body of [{ ...rejected, httpStatus: 401 }, { ...rejected, httpStatus: 500 }, { ...rejected, httpStatus: undefined },
      { ...rejected, reason: "not_enqueued" }]) {
      const response = await server!.inject({ method: "POST", url: claimUrl(fan), headers: bearer(grishaToken), payload: body });
      expect(response.statusCode, response.body).toBe(400);
    }
    expectRefused(await act(grishaToken, fan, { ...rejected, instanceId: I2 }), 409, "custody_not_owned");
    expectRefused(await act(nikitaToken, fan, rejected), 409, "custody_not_owned");
    expect((await custodyRows(fan))[0]).toMatchObject({ state: "dispatching" });

    expect(ok(await act(grishaToken, fan, rejected)).custody).toMatchObject({ attemptId, state: "failed" });
    expect(ok(await act(grishaToken, fan, rejected)).custody).toMatchObject({ state: "failed" });
    expectRefused(await act(grishaToken, fan, { ...rejected, httpStatus: 422 }), 409, "attempt_conflict");
    expectRefused(await act(grishaToken, fan, sentBody(attemptId, "7301")), 409, "attempt_conflict");
    // The same part may be dispatched again, as a new attempt; a repeat of the old one reads it failed.
    expect(ok(await act(grishaToken, fan, first)).custody).toMatchObject({ attemptId, state: "failed", ticket: null });
    const again = { ...first, attemptId: randomUUID() };
    expect(ok(await act(grishaToken, fan, again)).custody).toMatchObject({ state: "dispatching" });
    // A dispatch whose answer never arrived: no ticket reached the page, the client says so.
    expect(ok(await act(grishaToken, fan, {
      action: "failed", attemptId: again.attemptId, instanceId: I1, reason: "not_enqueued",
    })).custody).toMatchObject({ state: "failed" });
    expect((await custodyRows(fan)).map((row) => row.state)).toEqual(["failed", "failed"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("registerNativeSend works with previewSend off, admits no dispatch after it and frees nobody's custody (critic 13)", async () => {
    // «Открыть и вставить»: sending from the preview is off, the chatter sent by hand.
    await switchOn({ newcomers: true, previewSend: false });
    const fan = nextFan();
    const native = nativeBody();
    const recorded = ok(await act(grishaToken, fan, native));
    expect(recorded).toMatchObject({
      greeting: { state: "confirmed", messageRef: native.platformMessageId, source: "native-register" },
      group: { ...(native.group as Body), sentParts: [0], heldParts: [] },
      custody: { attemptId: native.attemptId, state: "sent", ticket: null, ticketExpiresAt: null },
    });
    // Once per page and message: a repeat under another attempt id records nothing new.
    ok(await act(grishaToken, fan, { ...native, attemptId: randomUUID() }));
    expectRefused(await act(grishaToken, fan, { ...native, attemptId: randomUUID(), partIndex: 1 }), 409, "attempt_conflict");
    expect((await custodyRows(fan)).map((row) => [row.state, row.origin, row.ticket_hash]))
      .toEqual([["sent", "native-register", null]]);
    // The record gives no right to send: with the switch off every new dispatch is still refused.
    expectRefused(await act(grishaToken, fan, dispatchBody({ group: native.group, partIndex: 1 })), 409, "client_feature_disabled", "flag_off");
    expectRefused(await act(grishaToken, fan, replyBody()), 409, "client_feature_disabled", "flag_off");
    // And with `newcomers` off as well, the record itself is still taken.
    await patchConfig([features({ newcomers: false, previewSend: false })]);
    expect(ok(await act(grishaToken, nextFan(), nativeBody())).greeting.state).toBe("confirmed");

    // Someone else's send to another fan is not resolved.
    await patchConfig([features({ newcomers: true, previewSend: true })]);
    const heldFan = nextFan();
    const held = replyBody({ instanceId: I3 });
    ok(await act(nikitaToken, heldFan, held));
    await expireTicket(held.attemptId as string);
    await patchConfig([features({ newcomers: true, previewSend: false })]);
    // The very part that is held cannot be registered over it.
    expectRefused(
      await act(grishaToken, heldFan, nativeBody({ purpose: "preview-reply", group: held.group, partIndex: 0 })),
      409,
      "custody_held",
    );
    // A proven send of grisha's own is recorded, and the held send stays held.
    expect(ok(await act(grishaToken, heldFan, nativeBody()))).toMatchObject({
      greeting: { state: "confirmed", source: "native-register" }, custody: { state: "sent" },
    });
    expect((await custodyRows(heldFan)).map((row) => [row.attempt_id === held.attemptId, row.state, row.origin])).toEqual([
      [true, "dispatching", "preview-send"],
      [false, "sent", "native-register"],
    ]);
    expect(ok(await status(nikitaToken, heldFan)).custody).toMatchObject({ attemptId: held.attemptId, state: "uncertain-held" });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("at most six sends from the preview per person in 60 s: the seventh is 429 with the wait", async () => {
    await switchOn();
    // Seven at once, to seven fans: the count is taken under the person's own lock (critic 12).
    const responses = await Promise.all(Array.from({ length: 7 }, () => act(nikitaToken, nextFan(), replyBody({ instanceId: I3 }))));
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(6);
    const limited = responses.filter((response) => response.statusCode !== 200);
    expect(limited).toHaveLength(1);
    expectRefused(limited[0]!, 429, "preview_send_rate_limited");
    const { retryAfterMs } = limited[0]!.json<{ retryAfterMs: number }>();
    expect(retryAfterMs).toBeGreaterThan(50_000);
    expect(retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(limited[0]!.headers["retry-after"]).toBe(String(Math.ceil(retryAfterMs / 1000)));
    // Another person is not held back, and neither is a report or a native record of the limited one.
    expect(ok(await act(grishaToken, nextFan(), replyBody())).custody).toMatchObject({ state: "dispatching" });
    expect(ok(await act(nikitaToken, nextFan(), nativeBody({ instanceId: I3 }))).custody).toMatchObject({ state: "sent" });
    expectRefused(await act(nikitaToken, nextFan(), replyBody({ instanceId: I3 })), 429, "preview_send_rate_limited");
    // The window moves on.
    await agePreviewSends();
    expect(ok(await act(nikitaToken, nextFan(), replyBody({ instanceId: I3 }))).custody).toMatchObject({ state: "dispatching" });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a desktop new-follower command greets the fan or holds it; one that never left does neither (critic 1)", async () => {
    await switchOn();
    const insertCommand = async (state: string, attempts: number, verifier: unknown) => {
      const fan = nextFan();
      await query(
        `insert into ofapi_commands (id, client_command_id, page_id, chatter_user_id, ofapi_account_id, conversation_id,
           outreach_purpose, kind, payload, payload_hash, state, attempt_count, verifier_result, platform_message_id,
           attempt_finished_at, dedupe_expires_at)
         values ($1, $2, $3, $4, 'acct_claim', $5, 'new-follower', 'send_text_message_v1', '{}'::jsonb, $6, $7, $8, $9, $10, $11,
           now() + interval '1 day')`,
        [randomUUID(), randomUUID(), pageIds["lora-of"], userIds.nikita, fan, "a".repeat(64), state, attempts,
          verifier === null ? null : JSON.stringify(verifier),
          state === "confirmed" ? "9001" : null, state === "confirmed" ? new Date("2026-09-21T10:00:00Z") : null],
      );
      return fan;
    };
    const greeted = await insertCommand("confirmed", 1, { source: "ofapi_response" });
    const queued = await insertCommand("queued", 0, null);
    const indeterminate = await insertCommand("indeterminate", 1, { source: "stale_recovery" });
    const cancelledBeforeCapture = await insertCommand("cancelled", 0, null);
    const refusedLocally = await insertCommand("failed_terminal", 1, { source: "local_precondition", reason: "binding_replaced" });
    // The fixtures are the desktop's rows; the trap counts from here.
    await trap!.restore();
    trap = await armNoOutboundTrap(testDb!);

    const greet = async (fan: string) => {
      const leaseToken = randomUUID();
      ok(await act(grishaToken, fan, claimBody(I1, leaseToken)));
      return act(grishaToken, fan, dispatchBody({ leaseToken }));
    };
    // A succeeded desktop command is the fan's greeting: source desktop-outbox, in the status, on claim and on dispatch.
    expectRefused(await act(grishaToken, greeted, claimBody(I1)), 409, "greeting_done");
    expectRefused(await act(grishaToken, greeted, dispatchBody({ leaseToken: randomUUID() })), 409, "greeting_done");
    expect(await query("select 1 from client_fan_leases where fan_ref = $1", [greeted])).toEqual([]);
    expect(ok(await status(nikitaToken, greeted)).greeting).toEqual({
      state: "confirmed", at: "2026-09-21T10:00:00.000Z", messageRef: "9001", source: "desktop-outbox",
    });
    // Queued, in flight or indeterminate: it may have greeted. Held, never a second greeting.
    for (const fan of [queued, indeterminate]) {
      expectRefused(await greet(fan), 409, "custody_held");
      expect(ok(await status(grishaToken, fan)).greeting.state).toBe("none");
      expect(await custodyRows(fan)).toEqual([]);
    }
    // Cancelled before any attempt, or refused before it left the hub: the fan is free.
    for (const fan of [cancelledBeforeCapture, refusedLocally]) {
      expect(ok(await greet(fan)).custody).toMatchObject({ state: "dispatching" });
    }
    // The desktop's command holds the greeting only: a reply from the preview is another send.
    expect(ok(await act(grishaToken, queued, replyBody())).custody).toMatchObject({ state: "dispatching" });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a native send of the caller's own held part confirms the greeting: no colleague greets again", async () => {
    await switchOn();
    const fan = nextFan();
    const { leaseToken, attemptId, group: heldGroup } = await dispatchedGreeting(fan);
    // The page held the command (nothing enqueued), but the report missed the ticket.
    await expireTicket(attemptId);
    expectRefused(await act(grishaToken, fan, { action: "failed", attemptId, instanceId: I1, reason: "not_enqueued" }), 409, "custody_held");
    // The chatter pastes that very part into the composer and presses Send: receipt and echo, a message id.
    const native = nativeBody({ group: heldGroup, partIndex: 0 });
    const registered = ok(await act(grishaToken, fan, native));
    // The fan IS greeted, and the hub says so. The preview send stays held: only its own report or a resolve ends it.
    expect(registered).toMatchObject({
      greeting: { state: "confirmed", messageRef: native.platformMessageId, source: "native-register" },
      group: { ...heldGroup, sentParts: [0], heldParts: [0] },
      custody: { attemptId, state: "uncertain-held", ticket: null },
    });
    // On the greeting alone: the held send keeps the part's one custody row.
    expect((await custodyRows(fan)).map((row) => [row.attempt_id, row.state, row.platform_message_id]))
      .toEqual([[attemptId, "dispatching", null]]);
    expect(await query("select owner_user_id::text, first_message_ref, first_attempt_id::text, source from client_greetings where fan_ref = $1", [fan]))
      .toEqual([{
        owner_user_id: String(userIds.grisha), first_message_ref: native.platformMessageId, first_attempt_id: attemptId,
        source: "native-register",
      }]);
    // The same proof again reads (the client lost the answer); the same message as another part contradicts it.
    expect(ok(await act(grishaToken, fan, native)).greeting.state).toBe("confirmed");
    expect(ok(await act(grishaToken, fan, { ...native, attemptId: randomUUID() })).greeting.state).toBe("confirmed");
    expectRefused(await act(grishaToken, fan, { ...native, attemptId: randomUUID(), partIndex: 1 }), 409, "attempt_conflict");
    expect(await query("select 1 from client_greetings where fan_ref = $1", [fan])).toHaveLength(1);

    // A colleague sees a greeted fan with an unresolved send, and gets no lease when grisha's runs out.
    expect(ok(await status(nikitaToken, fan))).toMatchObject({ greeting: { state: "confirmed" }, custody: { attemptId, state: "uncertain-held" } });
    await expireLease(leaseToken);
    const theirs = randomUUID();
    expectRefused(await act(nikitaToken, fan, claimBody(I3, theirs)), 409, "greeting_done");
    // The lead answers truthfully about the PREVIEW send: it never left. The fan is still greeted.
    const resolved = await resolve(leadCookie, attemptId, { outcome: "not_sent", note: "the preview send never left" });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expectRefused(await act(nikitaToken, fan, claimBody(I3, theirs)), 409, "greeting_done");
    expectRefused(await act(nikitaToken, fan, dispatchBody({ instanceId: I3, leaseToken: theirs })), 409, "greeting_done");
    // Nor does grisha send that part a second time from the preview; the rest of the group is his to send.
    expect(ok(await status(grishaToken, fan))).toMatchObject({
      greeting: { state: "confirmed", messageRef: native.platformMessageId },
      group: { ...heldGroup, sentParts: [0], heldParts: [] },
      custody: { attemptId, state: "resolved-not-sent" },
    });
    expectRefused(await act(grishaToken, fan, dispatchBody({ group: heldGroup, partIndex: 0 })), 409, "part_already_sent");
    expectRefused(await act(grishaToken, fan, nativeBody({ group: heldGroup, partIndex: 0 })), 409, "part_already_sent");
    expect(ok(await act(grishaToken, fan, dispatchBody({ group: heldGroup, partIndex: 1 })))).toMatchObject({
      group: { sentParts: [0] }, custody: { state: "dispatching" },
    });

    // The same while the preview send is still inside its ticket, and when the hand-sent part is a held reply's
    // (no greeting to confirm there: the part stays held and nothing is written).
    const inFlight = nextFan();
    const flying = await dispatchedGreeting(inFlight);
    expect(ok(await act(grishaToken, inFlight, nativeBody({ group: flying.group, partIndex: 0 })))).toMatchObject({
      greeting: { state: "confirmed", source: "native-register" }, custody: { attemptId: flying.attemptId, state: "dispatching" },
    });
    // The preview send then proves itself too: both went out, and each is on record.
    expect(ok(await act(grishaToken, inFlight, sentBody(flying.attemptId, "7951")))).toMatchObject({
      greeting: { state: "confirmed", source: "native-register" }, custody: { state: "sent" }, group: { sentParts: [0] },
    });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a proven native send is recorded whatever the switches and the client's version say now", async () => {
    await switchOn({ newcomers: true, previewSend: false });
    const fan = nextFan();
    const leaseToken = randomUUID();
    ok(await act(grishaToken, fan, claimBody(I1, leaseToken)));
    // grisha pasted the Hi and pressed Send; the owner raises the minimum version a moment before the report lands.
    await patchConfig([{ key: "chatExtensionMinVersion", value: "1.5.0" }]);
    const native = nativeBody();
    expect(ok(await act(grishaToken, fan, native))).toMatchObject({
      greeting: { state: "confirmed", messageRef: native.platformMessageId, source: "native-register" },
      custody: { attemptId: native.attemptId, state: "sent" },
    });
    // ...or the owner used the kill switch, or the report comes from a client that names no version at all.
    await patchConfig([{ key: "chatExtensionEnabled", value: false }]);
    const second = nextFan();
    expect(ok(await act(grishaToken, second, nativeBody())).greeting.state).toBe("confirmed");
    expect(ok(await act(grishaFullToken, nextFan(), nativeBody(), { clientVersion: null })).greeting.state).toBe("confirmed");
    // The repeat of a report (the client lost the answer) reads as before.
    expect(ok(await act(grishaToken, fan, native)).custody).toMatchObject({ attemptId: native.attemptId, state: "sent" });
    // Nothing else opened with it: every action that starts something, and the status read, stay refused.
    expectRefused(await act(grishaToken, nextFan(), claimBody(I1)), 409, "client_feature_disabled", "disabled");
    expectRefused(await act(grishaToken, fan, replyBody()), 409, "client_feature_disabled", "disabled");
    expectRefused(await status(grishaToken, fan), 409, "client_feature_disabled", "disabled");
    // The page grant and the platform still hold.
    expectRefused(await act(svetaToken, nextFan(), nativeBody()), 409, "client_feature_disabled", "not_granted");
    expectRefused(await act(grishaToken, nextFan(), nativeBody(), { pageLabel: "lora-fansly" }), 409, "client_feature_disabled", "platform_unsupported");
    expectRefused(await act(grishaToken, nextFan(), nativeBody(), { pageLabel: "ghost-of" }), 409, "client_feature_disabled", "not_granted");

    // Switched back on: the colleague who takes the fans next finds them greeted.
    await patchConfig([{ key: "chatExtensionEnabled", value: true }, { key: "chatExtensionMinVersion", value: "1.4.2" }]);
    await expireLease(leaseToken);
    for (const greeted of [fan, second]) {
      expectRefused(await act(nikitaToken, greeted, claimBody(I3)), 409, "greeting_done");
    }
    await patchConfig([features({ newcomers: true, previewSend: true })]);
    expectRefused(await act(nikitaToken, fan, dispatchBody({ instanceId: I3, leaseToken: randomUUID() })), 409, "greeting_done");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a part inside its ticket is in flight, not held; past it the part is held for everyone", async () => {
    await switchOn();
    const fan = nextFan();
    const { leaseToken, attemptId, group: flying, answer } = await dispatchedGreeting(fan);
    // The client stops a row on heldParts[0]: a normal send must never read as one nobody can vouch for.
    expect(answer).toMatchObject({ group: { ...flying, sentParts: [], heldParts: [] }, custody: { state: "dispatching" } });
    const renewed = ok(await act(grishaToken, fan, { ...claimBody(I1, leaseToken), action: "renew" }));
    expect(renewed).toMatchObject({ group: { ...flying, sentParts: [], heldParts: [] }, custody: { attemptId, state: "dispatching" } });
    expect(ok(await status(nikitaToken, fan))).toMatchObject({
      group: { ...flying, sentParts: [], heldParts: [] }, custody: { attemptId, state: "dispatching" },
    });
    await expireTicket(attemptId);
    for (const token of [grishaToken, nikitaToken]) {
      expect(ok(await status(token, fan))).toMatchObject({
        group: { ...flying, sentParts: [], heldParts: [0] }, custody: { attemptId, state: "uncertain-held" },
      });
    }
    expect(ok(await act(grishaToken, fan, { ...claimBody(I1, leaseToken), action: "renew" })).group).toMatchObject({ heldParts: [0] });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a greeting under the install's own dead or missing token is claim_expired, never claim_busy", async () => {
    await switchOn();
    const fan = nextFan();
    const old = randomUUID();
    ok(await act(grishaToken, fan, claimBody(I1, old)));
    await expireLease(old);
    const fresh = randomUUID();
    ok(await act(grishaToken, fan, claimBody(I1, fresh)));
    // This very install holds the fan: the lease the request names is gone ("press Hi again"), nobody else is working on it.
    expectRefused(await act(grishaToken, fan, dispatchBody({ leaseToken: old })), 409, "claim_expired");
    expectRefused(await act(grishaToken, fan, dispatchBody()), 409, "claim_expired");
    // Another install of the same person, and another person, are elsewhere: busy.
    expectRefused(await act(grishaToken, fan, dispatchBody({ instanceId: I2, leaseToken: old })), 409, "claim_busy");
    expectRefused(await act(grishaToken, fan, dispatchBody({ instanceId: I2 })), 409, "claim_busy");
    expectRefused(await act(nikitaToken, fan, dispatchBody({ instanceId: I3 })), 409, "claim_busy");
    expect(await custodyRows(fan)).toEqual([]);
    expect(ok(await act(grishaToken, fan, dispatchBody({ leaseToken: fresh }))).custody).toMatchObject({ state: "dispatching" });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("races on one fan end in one outcome: one ticket, one lease, one owner of a message id", async () => {
    await switchOn();
    // Five dispatches at once from tabs, installs and people: one ticket, the rest see the fan held.
    const fan = nextFan();
    const racers = await Promise.all([
      act(grishaToken, fan, replyBody({ instanceId: I1 })),
      act(grishaToken, fan, replyBody({ instanceId: I1 })),
      act(grishaToken, fan, replyBody({ instanceId: I2 })),
      act(nikitaToken, fan, replyBody({ instanceId: I3 })),
      act(nikitaToken, fan, replyBody({ instanceId: I3 })),
    ]);
    const winners = racers.filter((response) => response.statusCode === 200);
    expect(winners).toHaveLength(1);
    expect(ok(winners[0]!).custody!.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const response of racers) {
      if (response.statusCode !== 200) expectRefused(response, 409, "custody_held");
    }
    expect(await custodyRows(fan)).toHaveLength(1);

    // The same attempt five times at once: every answer reads the one attempt, exactly one carries the ticket.
    const sameFan = nextFan();
    const same = replyBody({ instanceId: I3 });
    const repeats = (await Promise.all(Array.from({ length: 5 }, () => act(nikitaToken, sameFan, same)))).map(ok);
    expect(repeats.every((answer) => answer.custody!.attemptId === same.attemptId)).toBe(true);
    expect(repeats.filter((answer) => answer.custody!.ticket !== null)).toHaveLength(1);
    expect(await custodyRows(sameFan)).toHaveLength(1);
    await agePreviewSends();

    // A report, a failure and a resolve on one attempt at once: one of them ends it.
    for (let round = 0; round < 4; round += 1) {
      const raced = nextFan();
      const { attemptId } = await dispatchedGreeting(raced);
      // Odd rounds past the ticket, where a failure no longer counts and "not sent" may be resolved.
      if (round % 2 === 1) await expireTicket(attemptId);
      const outcomes = await Promise.all([
        act(grishaToken, raced, sentBody(attemptId, String(++fanSeq))),
        resolve(ownerCookie, attemptId, round % 2 === 1 ? { outcome: "not_sent", note: "race" } : { outcome: "sent", note: "race" }),
        act(grishaToken, raced, { action: "failed", attemptId, instanceId: I1, reason: "not_enqueued" }),
      ]);
      expect(outcomes.map((response) => response.statusCode).sort(), `round ${round}`).toEqual([200, 409, 409]);
      const [row] = await custodyRows(raced);
      expect(["sent", "failed", "resolved_sent", "resolved_not_sent"]).toContain(row!.state);
      // Greeted exactly when the part went out.
      expect(await query("select 1 from client_greetings where fan_ref = $1", [raced]))
        .toHaveLength(row!.state === "sent" || row!.state === "resolved_sent" ? 1 : 0);
      await agePreviewSends();
    }

    // Claims over a dead lease, at once: one new holder.
    const leased = nextFan();
    const dead = randomUUID();
    ok(await act(grishaToken, leased, claimBody(I1, dead)));
    await expireLease(dead);
    const claims = await Promise.all([
      act(grishaToken, leased, claimBody(I2)),
      act(nikitaToken, leased, claimBody(I3)),
      act(grishaToken, leased, claimBody(I1)),
      act(grishaToken, leased, claimBody(I1, dead)),
    ]);
    expect(claims.map((response) => response.statusCode).sort()).toEqual([200, 409, 409, 409]);
    expect(await query("select 1 from client_fan_leases where fan_ref = $1 and state = 'active'", [leased])).toHaveLength(1);
    // One lease token on two fans at once (a client bug): one lease, never a 500.
    const token = randomUUID();
    const twoFans = await Promise.all([act(grishaToken, nextFan(), claimBody(I1, token)), act(grishaToken, nextFan(), claimBody(I1, token))]);
    expect(twoFans.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    // One message id reported for two attempts on two fans at once: one of them owns it.
    const [fanA, fanB] = [nextFan(), nextFan()];
    const [replyA, replyB] = [replyBody({ instanceId: I1 }), replyBody({ instanceId: I3 })];
    ok(await act(grishaToken, fanA, replyA));
    ok(await act(nikitaToken, fanB, replyB));
    const message = String(++fanSeq);
    const reports = await Promise.all([
      act(grishaToken, fanA, sentBody(replyA.attemptId as string, message, I1)),
      act(nikitaToken, fanB, sentBody(replyB.attemptId as string, message, I3)),
    ]);
    expect(reports.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expectRefused(reports.find((response) => response.statusCode !== 200)!, 409, "attempt_conflict");

    await trap!.assertNoOutbound();
  }, 2 * INTEGRATION_TEST_TIMEOUT_MS);

  it("the manual resolve is the owner's and the team lead's, by cookie, audited once", async () => {
    await switchOn();
    const fan = nextFan();
    const { attemptId, group: heldGroup } = await dispatchedGreeting(fan);
    await expireTicket(attemptId);
    const sent = { outcome: "sent", platformMessageId: "7700", note: "  the message is in the chat  " };
    const audits = () => query<{ actor_user_id: string; platform_account_id: string; metadata: Body }>(
      `select actor_user_id::text, platform_account_id::text, metadata from audit_events
       where event_type = 'client.send_custody_resolved' and metadata->>'attemptId' = $1 order by id`,
      [attemptId],
    );

    // Not the extension's and not a chatter's: no credential, a chatter's cookie, any device token.
    for (const mode of ["log", "enforce"] as const) {
      app.config.authPolicyEnforcement = mode;
      expect((await resolve(null, attemptId, sent)).statusCode, mode).toBe(401);
      expect((await resolve(grishaCookie, attemptId, sent)).statusCode, mode).toBe(403);
      for (const token of [grishaToken, grishaFullToken, leadToken, ownerToken, AGENT_KEY_TOKEN]) {
        expect((await resolve(null, attemptId, sent, { headers: bearer(token) })).statusCode, mode).toBe(403);
      }
      // A team lead only on a page of theirs; a page that does not exist is 404.
      expect((await resolve(leadCookie, attemptId, sent, { pageLabel: "mia-of" })).statusCode, mode).toBe(403);
      expect((await resolve(ownerCookie, attemptId, sent, { pageLabel: "ghost-of" })).statusCode, mode).toBe(404);
      // The attempt is of lora-of: on another page there is no such attempt.
      expectRefused(await resolve(ownerCookie, attemptId, sent, { pageLabel: "mia-of" }), 404, "not_found");
    }
    app.config.authPolicyEnforcement = "log";
    expectRefused(await resolve(ownerCookie, randomUUID(), sent), 404, "not_found");
    for (const body of [
      { outcome: "not_sent", platformMessageId: "7700", note: "pasted by mistake" },
      { outcome: "sent", note: "   " },
      { outcome: "sent" },
      { ...sent, resolvedBy: "lead" },
    ]) {
      expect((await resolve(leadCookie, attemptId, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await audits()).toEqual([]);
    expect((await custodyRows(fan))[0]).toMatchObject({ state: "dispatching" });

    // The team lead looked at the chat: the part is there.
    const resolved = await resolve(leadCookie, attemptId, sent);
    expect(resolved.statusCode, resolved.body).toBe(200);
    const item = clientSendCustodyItemSchema.parse(resolved.json());
    expect(resolved.json()).toEqual(item);
    expect(item).toMatchObject({
      attemptId, fanRef: fan, userId: userIds.grisha, purpose: "greeting", state: "resolved-sent",
      generationRef: heldGroup.generationRef, partIndex: 0, partCount: 3,
    });
    expect(await audits()).toEqual([{
      actor_user_id: String(userIds.lead),
      platform_account_id: String(pageIds["lora-of"]),
      metadata: { attemptId, outcome: "sent", priorState: "uncertain-held", platformMessageIdRecorded: true },
    }]);
    // No fan id and no note in the trail: the attempt id leads to the row.
    expect(JSON.stringify((await audits())[0]!.metadata)).not.toContain(fan);
    expect(await query("select resolution_note, resolved_by_user_id::text from client_send_custody where attempt_id = $1", [attemptId]))
      .toEqual([{ resolution_note: "the message is in the chat", resolved_by_user_id: String(userIds.lead) }]);
    // The first part of a greeting resolved as sent confirms the greeting. The dispatcher's client, which
    // names no attempt when it reads, finds its own send resolved; nobody else is shown a finished send.
    expect(ok(await status(grishaToken, fan))).toMatchObject({
      greeting: { state: "confirmed", messageRef: "7700", source: "resolve" },
      group: { ...heldGroup, sentParts: [0], heldParts: [] },
      custody: { attemptId, state: "resolved-sent", ticket: null },
    });
    expect(ok(await status(nikitaToken, fan))).toMatchObject({
      greeting: { state: "confirmed", messageRef: "7700", source: "resolve" },
      group: { ...heldGroup, sentParts: [0], heldParts: [] },
      custody: null,
    });
    // The same resolve again answers the same and writes nothing; another outcome contradicts it.
    expect((await resolve(ownerCookie, attemptId, sent)).json()).toEqual(item);
    expect(await audits()).toHaveLength(1);
    expectRefused(await resolve(ownerCookie, attemptId, { outcome: "not_sent", note: "not there" }), 409, "attempt_conflict");
    // The late report of the client meets a resolved attempt.
    expectRefused(await act(grishaToken, fan, sentBody(attemptId, "7700")), 409, "attempt_conflict");

    // Not sent: the part may go again. The resolve works while the extension is switched off.
    const replyFan = nextFan();
    const reply = replyBody();
    ok(await act(grishaToken, replyFan, reply));
    await patchConfig([{ key: "chatExtensionEnabled", value: false }]);
    // Inside the ticket the page may still send the part: "not sent" would free it for a second
    // dispatch while the first can yet go out. Refused until the ticket has run out.
    expectRefused(
      await resolve(ownerCookie, reply.attemptId as string, { outcome: "not_sent", note: "nothing in the chat" }),
      409,
      "conflict",
      "ticket_live",
    );
    expect((await custodyRows(replyFan))[0]).toMatchObject({ state: "dispatching" });
    await expireTicket(reply.attemptId as string);
    const notSent = await resolve(ownerCookie, reply.attemptId as string, { outcome: "not_sent", note: "nothing in the chat" });
    expect(notSent.statusCode, notSent.body).toBe(200);
    expect(clientSendCustodyItemSchema.parse(notSent.json())).toMatchObject({
      purpose: "preview-reply", state: "resolved-not-sent", userId: userIds.grisha,
    });
    // (The status read is the client's: it answers again once the extension is switched back on, below.)
    expect(await query(
      `select actor_user_id::text, metadata from audit_events
       where event_type = 'client.send_custody_resolved' and metadata->>'attemptId' = $1`,
      [reply.attemptId],
    )).toEqual([{
      actor_user_id: String(userIds.owner),
      metadata: { attemptId: reply.attemptId, outcome: "not_sent", priorState: "uncertain-held", platformMessageIdRecorded: false },
    }]);
    await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
    expect(ok(await status(grishaToken, replyFan))).toMatchObject({
      group: { ...(reply.group as Body), sentParts: [], heldParts: [] },
      custody: { attemptId: reply.attemptId, state: "resolved-not-sent", ticket: null },
    });
    expect(ok(await act(grishaToken, replyFan, { ...reply, attemptId: randomUUID() })).custody).toMatchObject({ state: "dispatching" });

    // An attempt the client already reported is not held: nothing to resolve.
    const doneFan = nextFan();
    const done = replyBody();
    ok(await act(grishaToken, doneFan, done));
    ok(await act(grishaToken, doneFan, sentBody(done.attemptId as string, "7701")));
    expectRefused(await resolve(leadCookie, done.attemptId as string, { outcome: "sent", note: "x" }), 409, "conflict", "custody_not_held");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  for (const mode of ["log", "enforce"] as const) {
    it(`rights (${mode}): a device token on a granted page; never a cookie, an agent key or someone else's page`, async () => {
      await switchOn();
      app.config.authPolicyEnforcement = mode;
      const via = server!;
      const fan = nextFan();
      const leaseToken = randomUUID();
      ok(await act(grishaToken, fan, claimBody(I1, leaseToken)));

      for (const call of [
        (headers: Record<string, string>) => via.inject({ method: "GET", url: claimUrl(fan), headers }),
        (headers: Record<string, string>) => via.inject({ method: "POST", url: claimUrl(fan), headers, payload: claimBody(I1, leaseToken) }),
      ]) {
        expect((await call({ "x-client-version": EXTENSION_VERSION })).statusCode).toBe(401);
        expect((await call({ authorization: "Bearer agency_hub_device_nosuchtoken", "x-client-version": EXTENSION_VERSION })).statusCode).toBe(401);
        // The cabinet's cookie and an agent key are not the client's credential.
        for (const cookie of [ownerCookie, leadCookie, grishaCookie]) {
          expect((await call({ cookie, "x-client-version": EXTENSION_VERSION })).statusCode).toBe(403);
        }
        expect((await call(bearer(AGENT_KEY_TOKEN))).statusCode).toBe(403);
        // The narrow token, a full token, the team lead of the page, the owner.
        for (const token of [grishaToken, grishaFullToken, nikitaToken, leadToken, ownerToken]) {
          const response = await call(bearer(token));
          expect([200, 409], response.body).toContain(response.statusCode);
          if (response.statusCode === 409) expectRefused(response, 409, "claim_busy");
        }
      }

      // A page that is not the caller's, and one that does not exist.
      const foreign = [
        await status(svetaToken, fan),
        await act(svetaToken, fan, claimBody(I1)),
        await act(svetaToken, fan, replyBody()),
        await act(svetaToken, fan, { ...claimBody(I1, leaseToken), action: "release" }),
        await act(svetaToken, fan, sentBody(randomUUID(), "7801")),
      ];
      const missing = [
        await status(grishaToken, fan, { pageLabel: "ghost-of" }),
        await act(grishaToken, fan, replyBody(), { pageLabel: "ghost-of" }),
      ];
      if (mode === "enforce") {
        // The declared page scope answers before the handler, as on every page route.
        for (const response of foreign) expectRefused(response, 403, "forbidden");
        for (const response of missing) expectRefused(response, 404, "not_found");
      } else {
        // The hub's own check answers both the same: a missing page is not told from another person's.
        for (const response of [...foreign, ...missing]) expectRefused(response, 409, "client_feature_disabled", "not_granted");
      }
      // The lease is untouched by the stranger's release.
      expect(await query("select state from client_fan_leases where lease_id = $1", [leaseToken])).toEqual([{ state: "active" }]);
      // sveta's own page works for her, and every page for the owner's token.
      const miaFan = nextFan();
      expect(ok(await act(svetaToken, miaFan, claimBody(I3), { pageLabel: "mia-of" })).lease.state).toBe("owned");
      expect(ok(await status(ownerToken, miaFan, { pageLabel: "mia-of" })).lease).toMatchObject({ state: "held", heldBy: "someone-else" });

      // A fan id that is not one, an unknown action, a key the client never sends: 400.
      expect((await status(grishaToken, "0123")).statusCode).toBe(400);
      for (const payload of [{ action: "steal", leaseToken, instanceId: I1 }, { ...claimBody(I1), userId: userIds.nikita }, {}]) {
        const response = await via.inject({ method: "POST", url: claimUrl(fan), headers: bearer(grishaToken), payload });
        expect(response.statusCode, response.body).toBe(400);
      }

      await trap!.assertNoOutbound();
    }, INTEGRATION_TEST_TIMEOUT_MS);
  }
});
