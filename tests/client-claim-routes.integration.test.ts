import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientBootstrapResponseSchema,
  clientFanClaimResponseSchema,
  clientSendCustodyItemSchema,
  errorResponseSchema,
  type ClientFanClaimResponse,
} from "@agency_hub_core/contracts";
import {
  CLIENT_GREETING_SEND_RATE,
  applyClientClaimAction,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
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
import { clientClaimActionInput } from "../apps/runtime/src/services/client-claim.ts";
import * as sdk from "../packages/sdk/src/index.ts";
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
const I3 = randomUUID();

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Body = Record<string, unknown>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
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
    app = createTestAppContext(testDb);

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
    // Every page has its platform account id, as on prod (the Fansly page's is 18 digits).
    for (const [label, account] of [
      ["lora-of", "100000001"], ["mia-of", "100000003"], ["lora-fansly", "500000000000000001"],
    ] as const) {
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
  });

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

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
    // The page grant and the platform's admission still hold: a reply from the preview is no Fansly send.
    expectRefused(await act(svetaToken, nextFan(), nativeBody()), 403, "forbidden");
    expectRefused(
      await act(grishaToken, nextFan(), nativeBody({ purpose: "preview-reply", group: group({ partCount: 1 }) }), { pageLabel: "lora-fansly" }),
      409,
      "client_feature_disabled",
      "platform_unsupported",
    );
    expectRefused(await act(grishaToken, nextFan(), nativeBody(), { pageLabel: "ghost-of" }), 404, "not_found");
    // A greeting sent by hand on a Fansly page is recorded the same way, with every switch off (R20 HF-2).
    expect(ok(await act(grishaToken, nextFsFan(), nativeBody({ platformMessageId: "1234567890123456001" }), { pageLabel: "lora-fansly" })).greeting)
      .toMatchObject({ state: "confirmed", source: "native-register" });

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

  // ── R20 HF-3: a manual greeting and the custody's admission by platform ──
  //
  // On Fansly the custody admits a greeting only, under `newcomers` without `previewSend`, with
  // an AI or a manual group. `newcomers` exists on Fansly since R20 HF-2, and a Fansly page takes
  // it from its own row of the owner's switches alone: the two tests below are the page without
  // its row and the full run with it. The rules over a manual group are
  // tests/client-claim.integration.test.ts.

  /** The extension's SDK, generated from this hub, as the extension calls it (over inject: no socket leaves). */
  function sdkClient(token: string) {
    return sdk.createClient({
      baseUrl: "http://hub.invalid",
      auth: { mode: "bearer", token: () => token },
      headers: { "x-client-version": EXTENSION_VERSION },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const response = await server!.inject({
          method: init?.method as "GET" | "POST",
          url: `${url.pathname}${url.search}`,
          headers: init?.headers as Record<string, string>,
          ...(typeof init?.body === "string" ? { payload: init.body } : {}),
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: { "content-type": String(response.headers["content-type"] ?? "application/json") },
        });
      },
    });
  }

  /** What an AI request leaves behind: a generation's record and its spend. */
  const aiRows = () => query<{ generations: number; usage: number }>(`
    select (select count(*) from ai_generation_content)::int as generations,
           (select count(*) from ai_usage_events)::int as usage`);

  const fingerprintOf = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const manualGroup = (text: string) => ({ kind: "manual" as const, textFingerprint: fingerprintOf(text) });
  let fsFanSeq = 5_234_567_890_123_456_000n;
  /** A Fansly fan id: 19 digits, past a double's exact integers. */
  const nextFsFan = () => String(++fsFanSeq);

  async function refusedBySdk(call: Promise<unknown>, statusCode: number, error: string, reason?: string) {
    const failure = await call.then(() => null, (caught: unknown) => caught);
    expect(failure).toBeInstanceOf(sdk.KernelApiError);
    const apiError = failure as InstanceType<typeof sdk.KernelApiError>;
    expect([apiError.status, apiError.code], apiError.message).toEqual([statusCode, error]);
    expect((apiError.body as { reason?: string }).reason).toBe(reason);
  }

  /** The bootstrap's features of the Fansly page, as grisha's extension reads them. */
  async function fanslyFeatures() {
    const response = await server!.inject({ method: "GET", url: "/api/v1/client/bootstrap", headers: bearer(grishaToken) });
    expect(response.statusCode, response.body).toBe(200);
    const bootstrap = clientBootstrapResponseSchema.parse(response.json());
    return { bootstrap, features: bootstrap.pages.find((page) => page.pageLabel === "lora-fansly")!.features };
  }
  /** What the hub holds of one fan of the Fansly page: its leases and its sends. */
  const fanslyRows = (fanRef: string) => Promise.all([
    query("select 1 from client_fan_leases where page_id = $1 and fan_ref = $2", [pageIds["lora-fansly"], fanRef]),
    query("select 1 from client_send_custody where page_id = $1 and fan_ref = $2", [pageIds["lora-fansly"], fanRef]),
  ]);

  it("[R20 HF-2] a Fansly page without its own row is flag_off, whatever the \"*\" row says; a reply is never a Fansly send", async () => {
    // Every switch on for every page by the "*" row, and OnlyFans pages' own rows: none reaches the Fansly page.
    const on = { newcomers: true, previewSend: true };
    await patchConfig([{ key: "chatExtensionEnabled", value: true }, features(on, { "lora-of": on, "mia-of": on })]);
    const before = await aiRows();
    const client = sdkClient(grishaToken);
    const params = { pageLabel: "lora-fansly", fanRef: nextFsFan() };
    const text = "Привет! Спасибо за подписку 💛";
    const leaseToken = randomUUID();
    const waitsForTheRow = [
      { action: "claim", leaseToken, instanceId: I1 },
      { action: "renew", leaseToken, instanceId: I1 },
      dispatchBody({ leaseToken, group: manualGroup(text), partIndex: 0 }),
      dispatchBody({ leaseToken, group: group({ partCount: 1 }) }),
    ] as const;
    for (const body of waitsForTheRow) {
      // The body is one the SDK lets out: the refusal is the owner's switch, never a 400.
      expect(sdk.routeSchemas.clientFanClaim.body.safeParse(body).success, JSON.stringify(body)).toBe(true);
      await refusedBySdk(client.clientFanClaim({ params, body: body as never }), 409, "client_feature_disabled", "flag_off");
    }
    // A reply from the preview has no Fansly rule: the platform refuses it, as a send and as a record.
    for (const body of [
      replyBody(),
      nativeBody({ purpose: "preview-reply", group: group({ partCount: 1 }), platformMessageId: "1234567890123456787" }),
    ]) {
      await refusedBySdk(client.clientFanClaim({ params, body: body as never }), 409, "client_feature_disabled", "platform_unsupported");
    }
    // What only ends something is never a switch's to refuse: here there is nothing to end.
    await refusedBySdk(client.clientFanClaim({ params, body: { action: "release", leaseToken, instanceId: I1 } }), 409, "claim_expired");
    await refusedBySdk(
      client.clientFanClaim({ params, body: { action: "failed", attemptId: randomUUID(), instanceId: I1, reason: "not_enqueued" } }),
      409,
      "custody_not_owned",
    );
    expect(await fanslyRows(params.fanRef)).toEqual([[], []]);
    expect(await aiRows()).toEqual(before);

    // The bootstrap says the same: «Новые» exist on the page and are off; sending from the preview does not exist there.
    const { bootstrap, features: page } = await fanslyFeatures();
    expect(bootstrap.capabilities).toEqual(expect.arrayContaining(["manual-greeting-v1", "preview-send-custody-v1"]));
    expect(bootstrap.limits).toMatchObject({ previewSendPerMinute: 30, greetingSendPerMinute: 30 });
    expect(page).toMatchObject({
      newcomers: { available: false, reason: "flag_off" },
      previewSend: { available: false, reason: "platform_unsupported" },
    });
    // The OnlyFans page reads the same rows as it always did.
    expect(bootstrap.pages.find((entry) => entry.pageLabel === "lora-of")!.features).toMatchObject({
      newcomers: { available: true }, previewSend: { available: true },
    });
    // The top-level flags are the "*" row: they are no Fansly page's.
    expect(bootstrap.flags).toMatchObject({ newcomers: true, previewSend: true });

    // The page's own row set to off under a "*" that says on: still off.
    await patchConfig([features(on, { "lora-fansly": { newcomers: false } })]);
    await refusedBySdk(
      client.clientFanClaim({ params, body: { action: "claim", leaseToken, instanceId: I1 } }),
      409,
      "client_feature_disabled",
      "flag_off",
    );
    expect(await fanslyRows(params.fanRef)).toEqual([[], []]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("OnlyFans takes a manual group for a greeting and a reply from the preview; the rules are the same (audit 2026-10-20 row 1)", async () => {
    await switchOn();
    const fan = nextFan();
    const leaseToken = randomUUID();
    ok(await act(grishaToken, fan, claimBody(I1, leaseToken)));
    const text = "Hi! So glad you're here";
    const post = (body: Body) => server!.inject({ method: "POST", url: claimUrl(fan), headers: bearer(grishaToken), payload: body });
    // Master off still refuses a new dispatch first.
    await patchConfig([{ key: "chatExtensionEnabled", value: false }]);
    expectRefused(await post(dispatchBody({ leaseToken, group: manualGroup(text), partIndex: 0 })), 409, "client_feature_disabled", "disabled");
    expect(await custodyRows(fan)).toEqual([]);
    await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
    // An AI group never takes a manual group's ref.
    const forged = await post(dispatchBody({ leaseToken, group: group({ generationRef: `manual:${fingerprintOf(text)}` }) }));
    expect(forged.statusCode, forged.body).toBe(400);
    expect(await custodyRows(fan)).toEqual([]);
    // A greeting the chatter wrote: under the live lease, one part, kept as `manual:<fingerprint>`.
    const greetingBody = dispatchBody({ leaseToken, group: manualGroup(text), partIndex: 0 });
    expect(sdk.routeSchemas.clientFanClaim.body.safeParse(greetingBody).success).toBe(true);
    const greeting = ok(await post(greetingBody));
    expect(greeting.custody).toMatchObject({ state: "dispatching" });
    expect(greeting.group).toMatchObject({ generationRef: `manual:${fingerprintOf(text)}`, variant: 0, partCount: 1 });
    // One open send holds the fan: a reply of the chatter's own waits for it.
    const own = "and one more thing";
    expectRefused(await post(replyBody({ group: manualGroup(own), partIndex: 0 })), 409, "custody_held");
    ok(await post(sentBody(greetingBody["attemptId"] as string, String(++fanSeq))));
    // A reply the chatter wrote: no lease, one part; the same text again is the same part, once.
    const reply = replyBody({ group: manualGroup(own), partIndex: 0 });
    expect(ok(await post(reply)).custody).toMatchObject({ state: "dispatching" });
    ok(await post(sentBody(reply["attemptId"] as string, String(++fanSeq))));
    expectRefused(await post(replyBody({ group: manualGroup(own), partIndex: 0 })), 409, "part_already_sent");
    // A native send of the chatter's own text is recorded too.
    expect(ok(await post(nativeBody({ purpose: "preview-reply", group: manualGroup("typed in the composer"), partIndex: 0 }))).custody)
      .toMatchObject({ state: "sent" });
    expect((await custodyRows(fan)).map((row) => row.state)).toEqual(["sent", "sent", "sent"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("an attempt started on Fansly is finished with every switch off: sent, failed and release need the page grant only", async () => {
    // The switches are at rest. The attempts were started under switches since turned off, put in
    // through the repository exactly as the route puts them in.
    const fsPage = pageIds["lora-fansly"]!;
    const start = async (fanRef: string, text: string) => {
      const leaseToken = randomUUID();
      const actor = { pageId: fsPage, fanRef, userId: userIds.grisha };
      expect((await applyClientClaimAction(app.db, clientClaimActionInput(
        { action: "claim", leaseToken, instanceId: I1 }, actor,
      ))).ok).toBe(true);
      const attemptId = randomUUID();
      expect((await applyClientClaimAction(app.db, clientClaimActionInput({
        action: "dispatch", attemptId, instanceId: I1, purpose: "greeting", group: manualGroup(text), partIndex: 0,
        textRevision: 1, leaseToken, flagRevision: 0,
      }, actor, CLIENT_GREETING_SEND_RATE))).ok).toBe(true);
      return { leaseToken, attemptId };
    };
    const post = (fanRef: string, body: Body) => server!.inject({
      method: "POST", url: claimUrl(fanRef, "lora-fansly"), headers: bearer(grishaToken), payload: body,
    });
    const sentFan = nextFsFan();
    const sentText = "Привет!";
    const sending = await start(sentFan, sentText);
    const messageId = "1234567890123456789";
    expect(ok(await post(sentFan, sentBody(sending.attemptId, messageId)))).toMatchObject({
      greeting: { state: "confirmed", source: "preview-send", messageRef: messageId },
      group: { generationRef: `manual:${fingerprintOf(sentText)}`, variant: 0, partCount: 1, sentParts: [0], heldParts: [] },
      custody: { attemptId: sending.attemptId, state: "sent" },
    });
    // The last check before the request refused it: no request was made, and the fan is free again.
    const failedFan = nextFsFan();
    const failing = await start(failedFan, "Hello!");
    expect(ok(await post(failedFan, { action: "failed", attemptId: failing.attemptId, instanceId: I1, reason: "not_enqueued" })))
      .toMatchObject({ greeting: { state: "none" }, custody: { attemptId: failing.attemptId, state: "failed" } });
    expect(ok(await post(failedFan, { ...claimBody(I1, failing.leaseToken), action: "release" })).lease.state).toBe("released");
    expect((await custodyRows(failedFan)).map((row) => row.state)).toEqual(["failed"]);
    // The status read exists on Fansly (R20 HF-2) and waits for the master switch, like on OnlyFans.
    expectRefused(await status(grishaToken, sentFan, { pageLabel: "lora-fansly" }), 409, "client_feature_disabled", "disabled");
    await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
    expect(ok(await status(grishaToken, sentFan, { pageLabel: "lora-fansly" }))).toMatchObject({
      greeting: { state: "confirmed", source: "preview-send", messageRef: messageId },
      custody: { attemptId: sending.attemptId, state: "sent" },
    });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

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
    expect((await resolve(null, attemptId, sent)).statusCode).toBe(401);
    expect((await resolve(grishaCookie, attemptId, sent)).statusCode).toBe(403);
    for (const token of [grishaToken, grishaFullToken, leadToken, ownerToken, AGENT_KEY_TOKEN]) {
      expect((await resolve(null, attemptId, sent, { headers: bearer(token) })).statusCode).toBe(403);
    }
    // A team lead only on a page of theirs; a page that does not exist is 404.
    expect((await resolve(leadCookie, attemptId, sent, { pageLabel: "mia-of" })).statusCode).toBe(403);
    expect((await resolve(ownerCookie, attemptId, sent, { pageLabel: "ghost-of" })).statusCode).toBe(404);
    // The attempt is of lora-of: on another page there is no such attempt.
    expectRefused(await resolve(ownerCookie, attemptId, sent, { pageLabel: "mia-of" }), 404, "not_found");
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

  it("rights: a device token on a granted page; never a cookie, an agent key or someone else's page", async () => {
    await switchOn();
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
    // The declared page scope answers before the handler, as on every page route.
    for (const response of foreign) expectRefused(response, 403, "forbidden");
    for (const response of missing) expectRefused(response, 404, "not_found");
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
});
