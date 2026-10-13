import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { aiFeatureStreamFrameSchema, spenderListResponseSchema } from "@agency_hub_core/contracts";
import {
  createModel,
  createOnlyFansPage,
  ensurePollRows,
  getSyncPage,
  recalculateFanPageSpend,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertDemand,
  upsertFanPage,
  upsertFans,
  upsertTransaction,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyAccount, FanslyAccountNote, FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createEngineRegistry, demandToUpsert, pollsFor } from "../apps/runtime/src/sync/engine/resource.ts";
import { upsertHydratedFansForPage } from "../apps/runtime/src/sync/fansly/lib/fan-hydration.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { FAN_PROFILES_LOOKUP_KEY, lookupFollowups } from "../apps/runtime/src/sync/fansly/resources/fan-profiles.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  releasedCustomName,
  releasedFanContext,
  type ReleasedFanslyAccount,
} from "./helpers/fansly-chat-fan-profile.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  countRows,
  makeTestActor,
  okResponse,
  ScriptedLiveTransport,
  seedSyncPage,
  waitFor,
} from "./helpers/sync-engine-host.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension R20 HF-7б: the fan's profile in the AI context of a Fansly
// page, through the real stores and the real route.
//
// The released Fansly extension (fansly-chat 2.10.1) reads the fan's account
// from Fansly at every generation and sends the name, the saved name and the
// bio in `clientContext`. Its successor sends no context: the hub forms the
// same values from what its Sync Engine stored. The reference below is that
// equality, end to end: one `/account?ids=` answer goes (a) through the
// engine's own lookup walk (the real actor, journal and apply; only the
// transport is scripted) into the hub's stores and out into the prompt of a
// request without `clientContext`, and (b) through the released client's rules
// (tests/helpers/fansly-chat-fan-profile.ts) into a request shaped as the
// released client sends it. Both prompts hold the same lines about the fan.
//
// Predicate of the new behaviour: a Fansly page, a request without
// `clientContext`. A request with `clientContext` and every OnlyFans request
// are answered as before; their tests below pass on the code before this
// change as well.

const GROUP = "650000000000000001";
const FAN = "700000000000000001";
const FAN_BARE = "700000000000000002";
const FAN_CRM = "700000000000000003";
const FAN_UNKNOWN = "700000000000000009";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;

/** A Fansly page on the Sync Engine and what Fansly serves its session. */
interface LivePage {
  pageId: number;
  label: string;
  /** What `/account?ids=` answers for an id; an id missing here has no account. */
  accounts: Map<string, FanslyAccount>;
}

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let token = "";
let fs: LivePage;
let fs2: LivePage;
let ofPageId = 0;
const provider: { input?: AiGatewayProviderInput } = {};
const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);

function db(): Database {
  return testDb!.db as unknown as Database;
}

function capturingProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      provider.input = input;
      yield { type: "content_delta", text: "sure thing" };
      yield {
        type: "usage",
        providerResponseId: "msg_fan_profile",
        cacheHit: false,
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costMicroUsd: 100,
          costApproximate: false,
        },
      };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

// ── Fansly's side: the accounts `/account?ids=` serves ──────────────────────

/** A note as Fansly serves it: `createdAt` in seconds, `updatedAt` always null. */
function servedNote(note: Record<string, unknown>): FanslyAccountNote {
  return { contentId: null, updatedAt: null, ...note } as unknown as FanslyAccountNote;
}

/** The page's own name for a fan: Fansly's "Custom Username" note. */
function customNameNote(fanId: string, name: string | null) {
  return servedNote({
    id: `note-name-${fanId}`,
    accountId: fanId,
    contentType: 12002,
    title: "Custom Username",
    note: name,
    createdAt: 1_790_000_000,
  });
}

/** The notes panel's own blob on the fan: never a name. */
function crmNote(fanId: string) {
  return servedNote({
    id: `note-crm-${fanId}`,
    accountId: fanId,
    contentType: 12000,
    title: null,
    note: "{\"age\":\"31\",\"job\":\"welder\"}",
    createdAt: 1_789_000_000,
  });
}

/** The account with everything: both names, a bio, a saved name beside the
 *  notes panel's blob. `about` comes untrimmed, as Fansly serves it. */
const ACCOUNT = {
  id: FAN,
  username: "mike_runs",
  displayName: "Mike",
  about: "  marathoner from Austin, two cats \n",
  createdAt: 1_770_000_000_000,
  notes: [crmNote(FAN), customNameNote(FAN, "Mike VIP")],
} satisfies FanslyAccount & ReleasedFanslyAccount;

/** The barest account Fansly serves: a username; no `about`, no `notes`. */
const ACCOUNT_BARE = {
  id: FAN_BARE,
  username: "quiet_guy",
  displayName: null,
  createdAt: 1_771_000_000_000,
} satisfies FanslyAccount & ReleasedFanslyAccount;

/** A fan the notes panel wrote about, never renamed. */
const ACCOUNT_CRM = {
  id: FAN_CRM,
  username: "noted_fan",
  displayName: "Noted",
  createdAt: 1_772_000_000_000,
  notes: [crmNote(FAN_CRM)],
} satisfies FanslyAccount & ReleasedFanslyAccount;

function answer(page: LivePage, req: FanslyWireRequest): FanslyWireOutcome {
  if (req.spec === "accounts.by_ids") {
    const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",");
    return okResponse(ids.flatMap((id) => page.accounts.get(id) ?? []));
  }
  throw new Error(`unexpected ${req.spec}`);
}

/** A live page on the real registry, its standing polls parked far ahead:
 *  only the lookup walk a test asks for runs. */
async function seedLivePage(label: string): Promise<LivePage> {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { label, mode: "live", guard: "fansly_sync_engine" });
  const syncPage = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    polls: pollsFor(registry, syncPage!).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return { pageId, label, accounts: new Map() };
}

/**
 * One account lookup of the page, as the Sync Engine runs it: the lookup walk
 * is asked for these fans the way an apply's follow-up asks it, and the page's
 * actor sends `/account?ids=`, journals the answer and applies it.
 */
async function lookUp(page: LivePage, accounts: readonly FanslyAccount[], alsoAsk: readonly string[] = []) {
  for (const account of accounts) {
    page.accounts.set(account.id, account);
  }
  const [signal] = lookupFollowups([...accounts.map((account) => account.id), ...alsoAsk], "test");
  const upsert = demandToUpsert(signal!, registry.spec(FAN_PROFILES_LOOKUP_KEY)!, { pageId: page.pageId, now: new Date() });
  await upsertDemand(db(), upsert!);
  const transport = new ScriptedLiveTransport();
  transport.respond = (req) => answer(page, req);
  const { actor, stop, abort } = await makeTestActor({ db: db(), pageId: page.pageId, registry, transport });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => {
      const open = await countRows(
        testDb!.pool,
        "select count(*)::int as n from sync_work where page_id = $1 and resource = $2 and state in ('open', 'running')",
        [page.pageId, FAN_PROFILES_LOOKUP_KEY],
      );
      return open === 0 ? true : null;
    }, 30_000, "the lookup walk to close");
  } finally {
    stop.abort();
    await run;
  }
}

/** A day passes: the page's lookups are due again (owner decision 2026-09-30). */
async function aDayLater(page: LivePage) {
  await testDb!.pool.query(
    "update page_fans set account_lookup_at = account_lookup_at - interval '25 hours' where platform_account_id = $1",
    [page.pageId],
  );
}

/** The accounts a list serves beside its rows (the inbox, the followers), as
 *  their applies store them: no lookup, and never an `about`. */
async function servedWithAList(page: LivePage, accounts: FanslyAccount[]) {
  await upsertHydratedFansForPage(db(), { platformAccountId: page.pageId, accounts });
}

async function storedFan(page: LivePage, fanRef: string) {
  const { rows } = await testDb!.pool.query<{
    username: string | null;
    metadata: Record<string, unknown>;
    page_alias: string | null;
  }>(
    `select f.username, f.metadata, pf.page_alias
       from fans f
       left join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = $2
      where f.platform = 'fansly' and f.platform_user_id = $1`,
    [fanRef, page.pageId],
  );
  return rows[0] ?? null;
}

// ── the hub's side: the chat and the requests ───────────────────────────────

/** The page's chat with a fan: its thread and four old messages (three from
 *  the fan). Few enough for Hi, silent long enough for Ping. */
async function seedChat(page: LivePage, group: string, fan: string) {
  await testDb!.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
     values ($1, $2, $3)`,
    [page.pageId, group, fan],
  );
  const lines: Array<[ref: string, mine: boolean, text: string]> = [
    ["8001", false, "hey there"],
    ["8002", true, "hi you"],
    ["8003", false, "how was your day"],
    ["8004", false, "talk soon"],
  ];
  for (const [index, [ref, mine, text]] of lines.entries()) {
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
         fan_native_id, is_sent_by_me, occurred_at, text_plain)
       values ($1, 'fansly', $2, $3, $4, $5, now() - interval '12 days 1 hour' + make_interval(mins => $6), $7)`,
      [page.pageId, group, `${ref}${fan.slice(-2)}`, fan, mine, index, text],
    );
  }
}

interface Answer {
  /** The user blocks the provider received, joined. */
  prompt: string;
  /** Whether the request carried an image (the fan's avatar). */
  images: boolean;
  manifest: Record<string, unknown> | undefined;
}

async function ask(input: {
  feature: string;
  page?: string;
  platform?: string;
  body: Record<string, unknown>;
}): Promise<Answer> {
  delete provider.input;
  const response: InjectResponse = await server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${input.feature}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: input.page ?? fs.label,
      platform: input.platform ?? "fansly",
      ...input.body,
    },
  });
  expect(response.statusCode, `${input.feature}: ${response.body}`).toBe(200);
  const frames = response.body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => aiFeatureStreamFrameSchema.parse(JSON.parse(line.slice("data: ".length))) as Record<string, unknown>);
  expect(frames.at(-1)?.type).toBe("done");
  const meta = frames.find((frame) => frame.type === "meta");
  const { rows } = await testDb!.pool.query<{ params: { contextManifest?: Record<string, unknown> } }>(
    `select params from ai_generation_content where generation_ref = $1`,
    [meta!["requestId"]],
  );
  const prompt = provider.input!.body.prompt;
  return {
    prompt: prompt.userBlocks.map((block) => block.text).join("\n"),
    images: prompt.images !== undefined && prompt.images.length > 0,
    manifest: rows[0]?.params.contextManifest,
  };
}

/** What each feature's request names besides the conversation. */
const FEATURE_FIELDS: Record<string, Record<string, unknown>> = {
  "hi-greeting": { variantCount: 3 },
  ping: {},
  "help-me": {},
  "coach-chat": { chatterQuestion: "what next?" },
  "fan-notes-fill": { noteFields: ["Name", "Job"] },
};
const FEATURES = Object.keys(FEATURE_FIELDS);

/** The request of the chat-extension: the group and the fan, no context. */
function hubRequest(feature: string, fan: string, group = GROUP) {
  return { feature, body: { conversationRef: group, fanRef: fan, isRegeneration: false, ...FEATURE_FIELDS[feature] } };
}

const CLIENT_TRANSCRIPT = "[10:00] Fan: CLIENT_LINE_ONE\n[10:01] Model: CLIENT_LINE_TWO";

/**
 * The request of the released Fansly extension for the same chat (fansly-chat
 * ff30d00, src/background/operations.ts `buildConversationRefs` and the
 * `clientContext` it builds): Coach and the notes fill name the group and the
 * fan, every other feature the fan alone; the fan fields are `fan`'s.
 */
function releasedRequest(feature: string, fanId: string, fan: object, group = GROUP) {
  const canonical = feature === "coach-chat" || feature === "fan-notes-fill";
  return {
    feature,
    body: {
      ...(canonical ? { conversationRef: group, fanRef: fanId } : { conversationRef: fanId }),
      isRegeneration: false,
      ...FEATURE_FIELDS[feature],
      clientContext: {
        transcript: CLIENT_TRANSCRIPT,
        messageCount: 4,
        fanSpendingData: "",
        fanSubscriptionData: "",
        ...fan,
        ...(feature === "hi-greeting" ? { personalMessageCount: 4 } : {}),
        ...(feature === "ping" ? { pingSegment: "segment-a", fanSilenceDays: 12 } : {}),
      },
    },
  };
}

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `the prompt holds "${start.trim()}"`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, `the prompt holds "${end.trim()}" after it`).toBeGreaterThanOrEqual(0);
  return text.slice(from + start.length, to);
}

/** The prompt's text about who the fan is: the Fan Profile section of Hi, the
 *  Fan section of Ping, the bio line of the features that only read the bio. */
function fanSection(feature: string, prompt: string): string {
  if (feature === "hi-greeting") {
    return between(prompt, "## Fan Profile\n", "\n## Your Task");
  }
  if (feature === "ping") {
    return between(prompt, "## Fan\n", "\n## Your Task");
  }
  return prompt.split("\n").filter((line) => line.startsWith("Fan bio: ")).join("\n");
}

/** The section's lines, without the blank ones an empty slot leaves. */
function fanLines(feature: string, prompt: string): string[] {
  return fanSection(feature, prompt).split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await server?.close();
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  app.config.chatMuseAiGatewayEnabled = true;
  app.aiGatewayProvider = capturingProvider();
  delete provider.input;
  const persona = createBundledPersonalities()[0]!;
  await seedBundledAiPersona(app.db, {
    key: persona.id,
    displayName: persona.name,
    systemBlock: persona.content,
    bundledVersion: persona.builtinVersion!,
  });
  fs = await seedLivePage("fp-fs");
  fs2 = await seedLivePage("fp-fs2");
  const model = await createModel(app.db, { slug: "fp-of-model", name: "Fan Profile OF" });
  const ofPage = await createOnlyFansPage(app.db, { modelId: model!.id, label: "fp-of" });
  ofPageId = ofPage!.id;
  for (const pageId of [fs.pageId, fs2.pageId, ofPageId]) {
    await storeProxyConfig(app.db, pageId, {
      url: "socks5://proxy.example:1080",
      encryptedAuth: null,
      keyVersion: null,
      rateLimitScopeKey: "shared-ai-proxy",
    });
  }
  await createUserAccount(app, { username: "fp-chatter", role: "chatter" }, { source: "cli" });
  token = (await issueChatterDeviceToken(app, { username: "fp-chatter", pageLabel: fs.label }, { source: "cli" })).key;
  const userId = await fixtureUserId(app, "fp-chatter");
  for (const pageLabel of [fs2.label, "fp-of"]) {
    await assignPageToUser(app, { userId, pageLabel }, { source: "cli" });
  }
  server = await buildApiServer(app);
  await server.ready();
});

afterEach(() => {
  delete provider.input;
});

describe("the fan's profile the hub forms itself on Fansly (no clientContext)", () => {
  it("[AI-034] Hi reads the display name, the username, the saved name and the bio the released extension sends for the same account", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedChat(fs, GROUP, FAN);
    await lookUp(fs, [ACCOUNT]);

    const hub = await ask(hubRequest("hi-greeting", FAN));
    const released = await ask(releasedRequest("hi-greeting", FAN, releasedFanContext("hi-greeting", ACCOUNT)));
    expect(fanSection("hi-greeting", hub.prompt)).toBe(fanSection("hi-greeting", released.prompt));
    expect(fanLines("hi-greeting", hub.prompt)).toEqual([
      "Display name: Mike",
      "Username: mike_runs",
      "Name the chatter saved for this fan: Mike VIP",
      "Fan bio: marathoner from Austin, two cats",
    ]);
    // The avatar is not the hub's: the client takes it from the page.
    expect(hub.images).toBe(false);
    // The transcript is the hub's own, not a client's.
    expect(hub.prompt).toContain("how was your day");
    expect(hub.prompt).not.toContain("CLIENT_LINE_ONE");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[AI-034] Hi for a fan with a username alone names him by it, once", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedChat(fs, GROUP, FAN_BARE);
    await lookUp(fs, [ACCOUNT_BARE]);

    const hub = await ask(hubRequest("hi-greeting", FAN_BARE));
    const released = await ask(releasedRequest("hi-greeting", FAN_BARE, releasedFanContext("hi-greeting", ACCOUNT_BARE)));
    expect(fanSection("hi-greeting", hub.prompt)).toBe(fanSection("hi-greeting", released.prompt));
    expect(fanLines("hi-greeting", hub.prompt)).toEqual(["Display name: quiet_guy"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[AI-146] Ping, Help, Coach and the notes fill read the name, the saved name and the bio the released extension sends", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const BARE_GROUP = "650000000000000002";
    await seedChat(fs, GROUP, FAN);
    await seedChat(fs, BARE_GROUP, FAN_BARE);
    await lookUp(fs, [ACCOUNT, ACCOUNT_BARE]);

    for (const feature of FEATURES.filter((name) => name !== "hi-greeting")) {
      for (const [account, group] of [[ACCOUNT, GROUP], [ACCOUNT_BARE, BARE_GROUP]] as const) {
        const hub = await ask(hubRequest(feature, account.id, group));
        const released = await ask(releasedRequest(feature, account.id, releasedFanContext(feature, account), group));
        expect(fanSection(feature, hub.prompt), `${feature}: ${account.username}`)
          .toBe(fanSection(feature, released.prompt));
      }
    }
    // The name is the username, not the display name; the saved name has its own line.
    expect(fanLines("ping", (await ask(hubRequest("ping", FAN))).prompt)).toEqual([
      "Fan username: mike_runs",
      "Name the chatter saved for this fan: Mike VIP",
      "Fan bio: marathoner from Austin, two cats",
    ]);
    expect(fanLines("ping", (await ask(hubRequest("ping", FAN_BARE, BARE_GROUP))).prompt)).toEqual(["Fan username: quiet_guy"]);
    expect(fanLines("help-me", (await ask(hubRequest("help-me", FAN))).prompt)).toEqual(["Fan bio: marathoner from Austin, two cats"]);
    // A feature whose policy has no bio gets none (Reply).
    const reply = await ask({ feature: "fast-reply", body: { conversationRef: GROUP, fanRef: FAN } });
    expect(reply.prompt).not.toContain("Fan bio:");
    expect(reply.prompt).not.toContain("marathoner");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[AI-146] a renamed fan reads by the new name as soon as the hub reads the page's notes again; an emptied name leaves the prompt", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedChat(fs, GROUP, FAN);
    await lookUp(fs, [ACCOUNT]);
    const first = await ask(hubRequest("ping", FAN));
    expect(fanLines("ping", first.prompt)).toContain("Name the chatter saved for this fan: Mike VIP");
    expect(first.manifest?.["fanIdentity"]).toMatchObject({ known: true, name: "username", savedName: true, bio: true });
    const { savedNameReadAt, accountReadAt } = first.manifest!["fanIdentity"] as Record<string, string>;
    expect(Date.parse(savedNameReadAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(accountReadAt!)).toBeGreaterThan(Date.now() - 60_000);

    // The chatter renames the fan on Fansly. The hub learns it with the page's
    // inbox, whose accounts carry the notes and no `about`.
    const inbox = { id: FAN, username: ACCOUNT.username, displayName: ACCOUNT.displayName, createdAt: ACCOUNT.createdAt };
    await servedWithAList(fs, [{ ...inbox, notes: [crmNote(FAN), customNameNote(FAN, "Mikey")] }]);
    const renamed = await ask(hubRequest("ping", FAN));
    expect(fanLines("ping", renamed.prompt)).toEqual([
      "Fan username: mike_runs",
      "Name the chatter saved for this fan: Mikey",
      // The inbox says nothing about the bio: the lookup's stays.
      "Fan bio: marathoner from Austin, two cats",
    ]);
    const releasedRenamed = await ask(releasedRequest("ping", FAN, releasedFanContext("ping", {
      ...ACCOUNT,
      notes: [crmNote(FAN), customNameNote(FAN, "Mikey")],
    })));
    expect(fanSection("ping", renamed.prompt)).toBe(fanSection("ping", releasedRenamed.prompt));

    // The name is emptied: no saved-name line, as the released client sends none.
    await servedWithAList(fs, [{ ...inbox, notes: [crmNote(FAN), customNameNote(FAN, "  ")] }]);
    const emptied = await ask(hubRequest("ping", FAN));
    expect(fanLines("ping", emptied.prompt)).toEqual(["Fan username: mike_runs", "Fan bio: marathoner from Austin, two cats"]);
    expect(emptied.manifest?.["fanIdentity"]).toMatchObject({ savedName: false, bio: true });

    // A day later the account is looked up again: a new username, no bio any more.
    await aDayLater(fs);
    await lookUp(fs, [{ id: FAN, username: "mike_walks", displayName: "Mike", createdAt: ACCOUNT.createdAt, notes: [crmNote(FAN)] }]);
    const later = await ask(hubRequest("ping", FAN));
    expect(fanLines("ping", later.prompt)).toEqual(["Fan username: mike_walks"]);
    expect(later.manifest?.["fanIdentity"]).toMatchObject({ known: true, name: "username", savedName: false, bio: false });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[AI-146] names a fan the hub holds no account of \"fan\", and reads only this page's saved name of this platform's fan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const UNKNOWN_GROUP = "650000000000000003";
    await seedChat(fs, GROUP, FAN);
    await seedChat(fs, UNKNOWN_GROUP, FAN_UNKNOWN);

    // No account in the hub: the released client's failed account read.
    for (const feature of ["ping", "hi-greeting"]) {
      const hub = await ask(hubRequest(feature, FAN_UNKNOWN, UNKNOWN_GROUP));
      const released = await ask(releasedRequest(feature, FAN_UNKNOWN, releasedFanContext(feature, undefined), UNKNOWN_GROUP));
      expect(fanSection(feature, hub.prompt), feature).toBe(fanSection(feature, released.prompt));
      expect(hub.prompt).not.toContain(FAN_UNKNOWN);
      expect(hub.manifest?.["fanIdentity"]).toEqual({
        known: false, name: "fallback", savedName: false, bio: false, savedNameReadAt: null, accountReadAt: null,
      });
    }
    expect(fanLines("ping", (await ask(hubRequest("ping", FAN_UNKNOWN, UNKNOWN_GROUP))).prompt)).toEqual(["Fan username: fan"]);

    // Another page saved its own name for the same fan; this page saved none.
    await lookUp(fs2, [{ ...ACCOUNT, notes: [customNameNote(FAN, "PAGE TWO NAME")] }]);
    await lookUp(fs, [{ ...ACCOUNT, notes: [] }]);
    // An OnlyFans fan of the same native id is another person.
    const [namesake] = await upsertFans(app.db, [{
      platform: "onlyfans", platformUserId: FAN, username: "of_namesake", displayName: "OF Namesake", metadata: { about: "OF NAMESAKE BIO" },
    }]);
    await upsertFanPage(app.db, { fanId: namesake!.id, platformAccountId: fs.pageId });
    await testDb.pool.query("update page_fans set page_alias = 'OF NAMESAKE ALIAS' where fan_id = $1", [namesake!.id]);

    const ping = await ask(hubRequest("ping", FAN));
    expect(fanLines("ping", ping.prompt)).toEqual(["Fan username: mike_runs", "Fan bio: marathoner from Austin, two cats"]);
    expect(ping.prompt).not.toContain("PAGE TWO NAME");
    expect(ping.prompt).not.toContain("NAMESAKE");
    // The other page reads its own.
    await seedChat(fs2, GROUP, FAN);
    const other = await ask({ ...hubRequest("ping", FAN), page: fs2.label });
    expect(fanLines("ping", other.prompt)).toContain("Name the chatter saved for this fan: PAGE TWO NAME");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[AI-146] of several custom-name notes on one fan the hub reads the newest, the released client the first Fansly serves", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Fansly serves a fan's notes oldest first (production, 2026-10-13: the
    // first of several custom-name notes has the smallest id in 205 accounts
    // of 205). The released client takes the first; the hub's `page_alias` is
    // the newest (packages/db fan-page-identity.ts), on the Spenders board too.
    const older = { ...customNameNote(FAN, "Old Name"), id: "note-name-1", createdAt: 1_780_000_000 };
    const newer = { ...customNameNote(FAN, "New Name"), id: "note-name-2", createdAt: 1_790_000_000 };
    const account = { ...ACCOUNT, notes: [older, newer] };
    await seedChat(fs, GROUP, FAN);
    await lookUp(fs, [account]);

    expect(releasedFanContext("ping", account).fanCustomName).toBe("Old Name");
    expect(fanLines("ping", (await ask(hubRequest("ping", FAN))).prompt)).toContain("Name the chatter saved for this fan: New Name");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the account lookup stores the bio; a list's accounts and an omitted fan leave it; the next lookup decides again", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Served text: a half emoji must not fail the page's transaction.
    await lookUp(fs, [{ ...ACCOUNT, about: "  night owl \ud83d " }, ACCOUNT_BARE]);
    expect((await storedFan(fs, FAN))?.metadata).toEqual({ about: "night owl �" });
    expect((await storedFan(fs, FAN_BARE))?.metadata).toEqual({});

    // The inbox and the followers serve accounts without `about`.
    await servedWithAList(fs, [{ id: FAN, username: "mike_runs", displayName: "Mike", notes: ACCOUNT.notes }]);
    expect(await storedFan(fs, FAN)).toMatchObject({ metadata: { about: "night owl �" }, page_alias: "Mike VIP" });

    // A lookup the fan's account does not come back from (he blocked the page,
    // or a transient miss) says nothing about his bio.
    await aDayLater(fs);
    fs.accounts.delete(FAN);
    await lookUp(fs, [], [FAN]);
    expect((await storedFan(fs, FAN))?.metadata).toEqual({ about: "night owl �" });

    // The next answer is the account's state again: a new text, then none.
    await aDayLater(fs);
    await lookUp(fs, [{ ...ACCOUNT, about: "early bird" }]);
    expect((await storedFan(fs, FAN))?.metadata).toEqual({ about: "early bird" });
    await aDayLater(fs);
    await lookUp(fs, [{ id: FAN, username: "mike_runs", displayName: "Mike", notes: ACCOUNT.notes }]);
    expect((await storedFan(fs, FAN))?.metadata).toEqual({});
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the released Fansly extension (fansly-chat 2.10.1, clientContext) is answered as before", () => {
  // The fan fields the released client would send are its own reading of
  // Fansly; the hub holds a different account for the same fan. The prompt
  // keeps the client's, and the record says nothing about the hub's.
  const CLIENT_FAN = {
    fanDisplayName: "client_name",
    fanCustomName: "CLIENT SAVED",
    fanBio: "client bio text",
  };
  const HUB_ACCOUNT = {
    id: FAN,
    username: "hub_username",
    displayName: "Hub Display",
    about: "HUB BIO TEXT",
    notes: [customNameNote(FAN, "HUB SAVED")],
  } satisfies FanslyAccount;

  const forms: Array<{ name: string; request: { feature: string; body: Record<string, unknown> }; lines: string[] }> = [
    {
      name: "chat Hi",
      request: releasedRequest("hi-greeting", FAN, { ...CLIENT_FAN, fanDisplayName: "Client Display", fanUsername: "client_name" }),
      lines: ["Display name: Client Display", "Username: client_name", "Name the chatter saved for this fan: CLIENT SAVED", "Fan bio: client bio text"],
    },
    {
      // The New Followers window: the fan's id twice, one variant.
      name: "New Followers Hi",
      request: {
        feature: "hi-greeting",
        body: {
          conversationRef: FAN,
          fanRef: FAN,
          variantCount: 1,
          isRegeneration: false,
          clientContext: {
            transcript: CLIENT_TRANSCRIPT, messageCount: 2, fanSpendingData: "", fanSubscriptionData: "",
            fanDisplayName: "Client Display", fanUsername: "client_name", fanBio: "client bio text", personalMessageCount: 0,
          },
        },
      },
      lines: ["Display name: Client Display", "Username: client_name", "Fan bio: client bio text"],
    },
    {
      name: "Ping",
      request: releasedRequest("ping", FAN, CLIENT_FAN),
      lines: ["Fan username: client_name", "Name the chatter saved for this fan: CLIENT SAVED", "Fan bio: client bio text"],
    },
    {
      name: "Ping of a fan never renamed, without a bio",
      request: releasedRequest("ping", FAN, { fanDisplayName: "client_name" }),
      lines: ["Fan username: client_name"],
    },
    { name: "Help", request: releasedRequest("help-me", FAN, CLIENT_FAN), lines: ["Fan bio: client bio text"] },
    { name: "Coach", request: releasedRequest("coach-chat", FAN, CLIENT_FAN), lines: ["Fan bio: client bio text"] },
    { name: "the notes fill", request: releasedRequest("fan-notes-fill", FAN, CLIENT_FAN), lines: ["Fan bio: client bio text"] },
    {
      name: "Reply",
      request: { feature: "fast-reply", body: { conversationRef: FAN, isRegeneration: false, clientContext: { transcript: CLIENT_TRANSCRIPT, messageCount: 35, fanSpendingData: "", fanSubscriptionData: "", ...CLIENT_FAN } } },
      lines: [],
    },
  ];

  it("every form keeps the client's own fan fields, whatever the hub holds for the fan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const states: Array<{ name: string; seed: () => Promise<void> }> = [
      { name: "the hub holds no account", seed: async () => undefined },
      { name: "the hub holds another reading of the account", seed: () => lookUp(fs, [HUB_ACCOUNT]) },
    ];
    const prompts = new Map<string, string[]>();
    for (const state of states) {
      await state.seed();
      for (const form of forms) {
        const answer = await ask(form.request);
        expect(fanLines(form.request.feature, answer.prompt), `${form.name}, ${state.name}`).toEqual(form.lines);
        for (const hubValue of ["hub_username", "Hub Display", "HUB SAVED", "HUB BIO TEXT"]) {
          expect(answer.prompt, `${form.name}, ${state.name}`).not.toContain(hubValue);
        }
        expect(answer.manifest ?? {}, form.name).not.toHaveProperty("fanIdentity");
        prompts.set(form.name, [...(prompts.get(form.name) ?? []), answer.prompt]);
      }
    }
    // Byte for byte the same prompt before and after the hub learned the fan.
    for (const [name, list] of prompts) {
      expect(list, name).toHaveLength(states.length);
      expect(list[1], name).toBe(list[0]);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("OnlyFans is answered as before", () => {
  const OF_FAN = "4100001";
  const OF_UNKNOWN = "4100009";

  async function seedOnlyFansChat(fan: string) {
    const lines: Array<[ref: string, mine: boolean, text: string]> = [
      [`39980010${fan.slice(-2)}01`, false, "hey there"],
      [`39980010${fan.slice(-2)}02`, true, "hi you"],
      [`39980010${fan.slice(-2)}03`, false, "how was your day"],
    ];
    for (const [index, [ref, mine, text]] of lines.entries()) {
      await testDb!.pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref,
           fan_native_id, is_sent_by_me, occurred_at, text_plain)
         values ($1, 'onlyfans', $2, $3, $2, $4, now() - interval '12 days 1 hour' + make_interval(mins => $5), $6)`,
        [ofPageId, fan, ref, mine, index, text],
      );
    }
  }

  function onlyFansRequest(feature: string, fan: string) {
    return { feature, page: "fp-of", platform: "onlyfans", body: { conversationRef: fan, isRegeneration: false, ...FEATURE_FIELDS[feature] } };
  }

  it("one name (the page's alias, else the display name, else the username, else the id), no saved-name and no username line", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedOnlyFansChat(OF_FAN);
    await seedOnlyFansChat(OF_UNKNOWN);
    const [fan] = await upsertFans(app.db, [{
      platform: "onlyfans", platformUserId: OF_FAN, username: "of_user", displayName: "OF Display", metadata: { about: "of bio text" },
    }]);
    await upsertFanPage(app.db, { fanId: fan!.id, platformAccountId: ofPageId });
    const alias = (value: string | null) =>
      testDb!.pool.query("update page_fans set page_alias = $1 where fan_id = $2 and platform_account_id = $3", [value, fan!.id, ofPageId]);
    // A Fansly fan of the same native id is another person.
    await upsertFans(app.db, [{ platform: "fansly", platformUserId: OF_FAN, username: "fansly_namesake", displayName: "Fansly Namesake" }]);

    await alias("OF ALIAS");
    const ping = await ask(onlyFansRequest("ping", OF_FAN));
    expect(fanLines("ping", ping.prompt)).toEqual(["Fan username: OF ALIAS", "Fan bio: of bio text"]);
    expect(ping.manifest ?? {}).not.toHaveProperty("fanIdentity");
    const hi = await ask(onlyFansRequest("hi-greeting", OF_FAN));
    expect(fanLines("hi-greeting", hi.prompt)).toEqual(["Display name: OF ALIAS", "Fan bio: of bio text"]);
    expect(hi.manifest ?? {}).not.toHaveProperty("fanIdentity");
    expect(fanLines("help-me", (await ask(onlyFansRequest("help-me", OF_FAN))).prompt)).toEqual(["Fan bio: of bio text"]);

    await alias(null);
    expect(fanLines("ping", (await ask(onlyFansRequest("ping", OF_FAN))).prompt)).toEqual(["Fan username: OF Display", "Fan bio: of bio text"]);
    expect(fanLines("hi-greeting", (await ask(onlyFansRequest("hi-greeting", OF_FAN))).prompt)).toEqual(["Display name: OF Display", "Fan bio: of bio text"]);

    await testDb.pool.query("update fans set display_name = null where id = $1", [fan!.id]);
    expect(fanLines("ping", (await ask(onlyFansRequest("ping", OF_FAN))).prompt)).toEqual(["Fan username: of_user", "Fan bio: of bio text"]);

    // A fan the hub holds no account of is named by the id, as before.
    expect(fanLines("ping", (await ask(onlyFansRequest("ping", OF_UNKNOWN))).prompt)).toEqual([`Fan username: ${OF_UNKNOWN}`]);
    expect(fanLines("hi-greeting", (await ask(onlyFansRequest("hi-greeting", OF_UNKNOWN))).prompt)).toEqual([`Display name: ${OF_UNKNOWN}`]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the saved name on the Spenders board", () => {
  it("[SP-040] a Fansly page's Spenders rows carry the name the released extension read from the custom-name note", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const accounts = [ACCOUNT, ACCOUNT_BARE, ACCOUNT_CRM];
    await lookUp(fs, accounts);
    const { rows } = await testDb.pool.query<{ id: string; platform_user_id: string }>(
      "select id::text as id, platform_user_id from fans where platform = 'fansly' and platform_user_id = any($1)",
      [accounts.map((account) => account.id)],
    );
    for (const [index, row] of rows.entries()) {
      await upsertTransaction(app.db, {
        platformAccountId: fs.pageId,
        source: "fansly:rest",
        fanId: Number(row.id),
        transactionId: `tx-fan-profile-${index}`,
        rawType: 7,
        canonicalType: "tip",
        transactionState: "posted",
        rawStatus: 2,
        grossAmountMills: 20_000n + BigInt(index) * 1_000n,
        sourceDestinationAmountMills: 20_000n,
        creatorNetAmountMills: 20_000n,
        occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60_000 - index * 60_000),
      });
    }
    await recalculateFanPageSpend(app.db, fs.pageId);

    const savedNames = async () => {
      const response = await server!.inject({
        method: "GET",
        url: `/api/v2/spenders?scope=page&pageLabel=${fs.label}&period=lifetime&limit=10&offset=0`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      const list = spenderListResponseSchema.parse(response.json());
      return Object.fromEntries(list.items.map((item) => [item.fan.platformUserId, item.fan.pageAlias]));
    };
    expect(await savedNames()).toEqual({
      [FAN]: releasedCustomName(ACCOUNT),
      [FAN_BARE]: releasedCustomName(ACCOUNT_BARE),
      // The notes panel's blob is not a name.
      [FAN_CRM]: releasedCustomName(ACCOUNT_CRM),
    });
    expect(await savedNames()).toEqual({ [FAN]: "Mike VIP", [FAN_BARE]: null, [FAN_CRM]: null });

    // Renamed on Fansly: the board follows the page's notes.
    const renamed = { ...ACCOUNT, notes: [crmNote(FAN), customNameNote(FAN, "Mikey")] };
    await servedWithAList(fs, [{ id: FAN, username: ACCOUNT.username, displayName: ACCOUNT.displayName, notes: renamed.notes }]);
    expect((await savedNames())[FAN]).toBe(releasedCustomName(renamed));
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
