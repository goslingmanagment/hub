import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  appendDomainEvents,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  seedBundledAiPersona,
  setPageOfapiAccountId,
  storeProxyConfig,
  upsertFanPages,
  upsertFans,
  upsertTransaction,
  upsertVoiceProfile,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import {
  assignPageToUser,
  createUserAccount,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { CLIENT_SDK_REGISTRY } from "../apps/runtime/src/services/client-sdk-registry.ts";
import {
  COMPAT_ARCHIVE,
  COMPAT_CHATTER,
  COMPAT_COMPLETION,
  COMPAT_FANS,
  COMPAT_OF_ACCOUNT,
  COMPAT_OF_PLATFORM_ACCOUNT,
  COMPAT_OF_TIP_MILLS,
  COMPAT_OPERATION_EXERCISERS,
  COMPAT_OWNER,
  COMPAT_PAGES,
  call,
  failure,
  generationRefOf,
  laneFor,
  loadFrozenSdk,
  keepOwnerSwitches,
  raw,
  signIn,
  streamFeature,
  type CompatContext,
  type CompatPersona,
  type FrozenClientOptions,
} from "./helpers/client-sdk-compat.ts";
import { issueChatterDeviceToken, issueDeviceTokenForUsername } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real verify.
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// H-1a: every registered frozen client SDK (apps/runtime/src/services/
// client-sdk-registry.ts) against THIS hub, over a real listening server, the
// way each released client calls it. The bundles validate every answer with
// the zod schemas they shipped with; a `contract` KernelApiError anywhere
// (undeclared_status, response_validation_failed, frame_validation_failed)
// means this candidate would break a client already in the field.

// Every row and client generates on the same chatter and pages today.
const AI_REQUEST_LIMIT = 10_000;
const AI_TEST_TIMEOUT_MS = Math.max(INTEGRATION_TEST_TIMEOUT_MS, 120_000);

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let baseUrl = "";
let chatterToken = "";
const pageIds = { onlyfans: 0, fansly: 0 };
const capture: { input?: AiGatewayProviderInput } = {};

async function seedOnlyFansChat(pageId: number, fan: string, marker: string, messages: number, firstMessageId: number) {
  // Odd n from the fan, even n from the model, three days back.
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, is_sent_by_me, occurred_at, text_plain)
     select $1, 'onlyfans', $2, ($5::int + g)::text, case when g % 2 = 0 then null else $2 end,
            g % 2 = 0, now() - interval '3 days' + (g || ' minutes')::interval, $3 || ' ' || g
     from generate_series(1, $4::int) g`,
    [pageId, fan, marker, messages, firstMessageId],
  );
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  appContext = createTestAppContext(testDb);
  appContext.config.chatMuseAiGatewayEnabled = true;
  appContext.config.chatMuseAiGatewayDailyRequestLimit = AI_REQUEST_LIMIT;
  // The desktop's send path queues into the command outbox; no worker runs.
  appContext.config.ofapiDesktopCommandOutboxEnabled = true;
  // The extension's voice lane (inert in prod until the owner lists a page).
  appContext.config.voiceNotesEnabled = true;
  appContext.config.voiceNotesRetrievalEnabled = true;
  appContext.config.voiceNotesPageAllowlist = COMPAT_PAGES.fansly;
  appContext.config.voiceNotesScriptMaxChars = 600;
  appContext.config.voiceNotesDailyCharBudget = 100_000;
  appContext.config.voiceNotesGlobalDailyCharBudget = 100_000;
  appContext.config.voiceNotesMaxConcurrentSyntheses = 2;
  appContext.voiceTtsProvider = {
    async synthesize() {
      return {
        ok: true, audio: Buffer.from("compat-mp3-bytes"), characterCost: COMPAT_COMPLETION.length,
        requestId: "compat-tts", traceId: "compat-trace", region: "us-east-1",
      };
    },
  };
  appContext.aiGatewayProvider = {
    provider: "anthropic",
    async *stream(input) {
      capture.input = input;
      yield { type: "content_delta", text: COMPAT_COMPLETION };
      yield {
        type: "usage",
        providerResponseId: "msg_compat",
        cacheHit: false,
        usage: { inputTokens: 40, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 0, costMicroUsd: 90, costApproximate: false },
      };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  const persona = createBundledPersonalities()[0]!;
  await seedBundledAiPersona(appContext.db, {
    key: persona.id,
    displayName: persona.name,
    systemBlock: persona.content,
    bundledVersion: persona.builtinVersion!,
  });
  const model = await createModel(appContext.db, { slug: "compat", name: "Compat" });
  const ofPage = (await createOnlyFansPage(appContext.db, { modelId: model!.id, label: COMPAT_PAGES.onlyfans }))!;
  const fsPage = (await createFanslyPage(appContext.db, { modelId: model!.id, label: COMPAT_PAGES.fansly }))!;
  pageIds.onlyfans = ofPage.id;
  pageIds.fansly = fsPage.id;
  for (const page of [ofPage, fsPage]) {
    await storeProxyConfig(appContext.db, page.id, {
      url: "socks5://proxy.example:1080", encryptedAuth: null, keyVersion: null, rateLimitScopeKey: "compat-ai-proxy",
    });
  }
  await setPageOfapiAccountId(appContext.db, { pageId: ofPage.id, ofapiAccountId: COMPAT_OF_ACCOUNT });
  // The OnlyFans creator id: chat-extension's page switches bind by it (H-2b).
  await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [ofPage.id, COMPAT_OF_PLATFORM_ACCOUNT]);
  await upsertVoiceProfile(appContext.db, {
    platformAccountId: fsPage.id, voiceId: "compat-voice", model: "eleven_v3", settings: { stability: 0.5 }, outputFormat: "mp3_44100_128",
  });

  await createUserAccount(appContext, { ...COMPAT_OWNER, role: "owner" }, { source: "cli" });
  await createUserAccount(appContext, { username: COMPAT_CHATTER.username, role: "chatter" }, { source: "cli" });
  // Before any token: setting a password ends every session and token.
  await setUserPassword(appContext, {
    userId: await fixtureUserId(appContext, COMPAT_CHATTER.username), password: COMPAT_CHATTER.password,
  }, { source: "cli" });
  chatterToken = (await issueChatterDeviceToken(appContext, {
    username: COMPAT_CHATTER.username, pageLabel: COMPAT_PAGES.onlyfans,
  }, { source: "cli" })).key;
  await assignPageToUser(appContext, {
    userId: await fixtureUserId(appContext, COMPAT_CHATTER.username), pageLabel: COMPAT_PAGES.fansly,
  }, { source: "cli" });

  // OnlyFans: the hub reads conversations from its own archive. 36 messages
  // clear the 30-message Recap/Review gate; the follower's 4 stay under Hi's 10.
  await seedOnlyFansChat(ofPage.id, COMPAT_FANS.onlyfans, COMPAT_ARCHIVE.onlyfans, 36, 5000);
  await seedOnlyFansChat(ofPage.id, COMPAT_FANS.onlyfansFollower, COMPAT_ARCHIVE.onlyfansFollower, 4, 6000);
  // chat-extension's page reads on OnlyFans: the fan on the page, a paid tip
  // in the spender projections (Spenders, the fan panel, the stats, «ждут
  // ответа»), the chat's thread with the fan's message last (the dossier read
  // by conversation, «ждут ответа»), and one new subscriber («Новые»).
  const [ofFan] = await upsertFans(appContext.db, [{ platform: "onlyfans", platformUserId: COMPAT_FANS.onlyfans, username: "compatoffan" }]);
  await upsertFanPages(appContext.db, [{ fanId: ofFan!.id, platformAccountId: ofPage.id }]);
  await upsertTransaction(appContext.db, {
    platformAccountId: ofPage.id, source: "ofapi:webhook", fanId: ofFan!.id, transactionId: "compat-tip-1",
    rawType: "tip", canonicalType: "tip", transactionState: "posted", rawStatus: "ok",
    grossAmountMills: COMPAT_OF_TIP_MILLS, sourceDestinationAmountMills: COMPAT_OF_TIP_MILLS,
    creatorNetAmountMills: (COMPAT_OF_TIP_MILLS * 8n) / 10n, occurredAt: new Date(Date.now() - 2 * 86_400_000),
  });
  await rebuildSpenderProjections(appContext.db, ofPage.id);
  await rebuildRevenueRollups(appContext.db, ofPage.id);
  await testDb.pool.query(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id,
       unread_count, last_message_sender_role, last_message_at, last_fan_message_at, last_model_message_at, is_visible)
     values ($1, $2, $3, $3, 1, 'fan'::dm_sender_role, now() - interval '1 hour', now() - interval '1 hour',
       now() - interval '2 hours', true)`,
    [ofPage.id, ofFan!.id, COMPAT_FANS.onlyfans],
  );
  const subscribedAt = new Date(Date.now() - 3_600_000);
  await appendDomainEvents(appContext.db, ofPage.id, [{
    type: "subscription.started", occurredAt: subscribedAt, fanIdentityRef: COMPAT_FANS.onlyfansNewSubscriber,
    data: { subType: "new_subscriber", notificationId: "compat-1" }, schemaVersion: 1, observationId: 1,
    dedupKey: `sub:started:${COMPAT_FANS.onlyfansNewSubscriber}:${subscribedAt.toISOString()}`,
  }]);
  // Fansly: a visible thread, so the conversation-profile read resolves the
  // fan behind the group id (a Fansly fan must already be on the page; the
  // hub creates only OnlyFans fans).
  const fan = await testDb.pool.query<{ id: string }>(
    `insert into fans (platform, platform_user_id, username) values ('fansly', $1, 'compatfan') returning id::text`,
    [COMPAT_FANS.fansly],
  );
  await testDb.pool.query(
    `insert into page_fans (fan_id, platform_account_id) values ($1, $2)`,
    [Number(fan.rows[0]!.id), fsPage.id],
  );
  await testDb.pool.query(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id)
     values ($1, $2, $3, $4)`,
    [fsPage.id, Number(fan.rows[0]!.id), COMPAT_FANS.fanslyGroup, COMPAT_FANS.fansly],
  );

  server = await buildApiServer(appContext);
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

function promptOf(): AiGatewayProviderInput["body"]["prompt"] {
  return capture.input!.body.prompt;
}

function promptText(): string {
  const prompt = promptOf();
  return [...prompt.systemBlocks, ...prompt.userBlocks].map((block) => block.text).join("\n");
}

// Only the newest frozen bundle of each client runs: the older ones are
// releases no chatter keeps once the next one ships.
function isNewerVersion(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

const NEWEST_BUNDLE_PER_CLIENT = new Map<string, { bundleSha256: string; version: string }>();
for (const row of CLIENT_SDK_REGISTRY) {
  for (const client of row.clients) {
    const version = client.versions[client.versions.length - 1]!;
    const newest = NEWEST_BUNDLE_PER_CLIENT.get(client.name);
    if (!newest || isNewerVersion(version, newest.version)) {
      NEWEST_BUNDLE_PER_CLIENT.set(client.name, { bundleSha256: row.bundleSha256, version });
    }
  }
}

for (const row of CLIENT_SDK_REGISTRY) {
  for (const client of row.clients) {
    if (NEWEST_BUNDLE_PER_CLIENT.get(client.name)?.bundleSha256 !== row.bundleSha256) continue;
    const lane = laneFor(client.name);
    const version = client.versions[client.versions.length - 1]!;
    const header = lane.clientVersion(version);

    describe(`frozen SDK ${row.bundleSha256.slice(0, 12)} (${row.status}) as ${client.name} ${version}`, () => {
      let ctx: CompatContext;
      let options: FrozenClientOptions;
      let persona: CompatPersona;
      let restoreSwitches: (() => void) | null = null;
      const optionsFor = (token: string | null, clientVersion = header): FrozenClientOptions => ({
        baseUrl,
        ...(token ? { auth: { mode: "bearer" as const, token: () => token } } : {}),
        headers: { "x-client-version": clientVersion },
      });
      const reply = lane.calls[0]!;
      const ready = (context: { skip: () => void }) => {
        if (!server) context.skip();
        return Boolean(server);
      };

      beforeAll(async () => {
        if (!server) return;
        const sdk = await loadFrozenSdk(row);
        expect(sdk.KERNEL_CONTRACT_HASH).toBe(row.contractHash);
        if (lane.ownerSwitches) {
          restoreSwitches = keepOwnerSwitches(appContext.config);
          Object.assign(appContext.config, lane.ownerSwitches);
        }
        // A narrow client signs in itself, as it does in the field; the others
        // hold the fixture's full chatter token.
        const token = lane.tokenClient === null
          ? chatterToken
          : await signIn(sdk, sdk.createClient(optionsFor(null)), lane, "active");
        options = optionsFor(token);
        const client = sdk.createClient(options);
        const catalog = await call<{ personas: CompatPersona[] }>(sdk, client, "aiPersonaCatalog");
        const key = createBundledPersonalities()[0]!.id;
        persona = catalog.personas.find((item) => item.key === key)!;
        expect(persona?.definitionId).toEqual(expect.any(String));
        ctx = {
          sdk, lane, options, pageIds, persona, client, pool: testDb!.pool,
          seed: sdk.createClient(optionsFor(chatterToken)),
          clientFor: (other) => sdk.createClient(optionsFor(other)),
        };
      });

      afterAll(() => {
        restoreSwitches?.();
      });

      it("reads health as the client does, a degraded 503 included", async (context) => {
        if (!ready(context)) return;
        expect(await call(ctx.sdk, ctx.client, "health")).toMatchObject({ status: "ok" });
        const healthy = await raw(ctx.client, "health");
        const healthyBody = await healthy.json() as { compatibleClientSdks?: string[] };
        expect(ctx.sdk.routeSchemas.health!.response[200]!.safeParse(healthyBody).success).toBe(true);
        // H-1b: the hub serves this row, so a release gate for its clients passes.
        expect(healthyBody.compatibleClientSdks).toContain(row.contractHash);

        const query = appContext.pool.query.bind(appContext.pool) as (...args: unknown[]) => unknown;
        const down = vi.spyOn(appContext.pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) =>
          text === "select 1" ? Promise.reject(new Error("compat: database down")) : query(text, ...rest)) as never);
        try {
          expect(await failure(ctx.sdk, call(ctx.sdk, ctx.client, "health"))).toMatchObject({ status: 503, category: "server" });
          const degraded = await raw(ctx.client, "health");
          const payload = await degraded.json() as unknown;
          expect(degraded.status).toBe(503);
          expect(payload).toMatchObject({ status: "degraded", compatibleClientSdks: expect.arrayContaining([row.contractHash]) });
          expect(ctx.sdk.routeSchemas.health!.response[200]!.safeParse(payload).success).toBe(true);
          expect(ctx.sdk.routeSchemas.health!.response[503]!.safeParse(payload).success).toBe(true);
        } finally {
          down.mockRestore();
        }
      }, INTEGRATION_TEST_TIMEOUT_MS);

      it("answers the shared reads and the capture lane", async (context) => {
        if (!ready(context)) return;
        const { sdk } = ctx;
        expect(await call(sdk, ctx.client, "me")).toMatchObject({ authMethod: "device_token", user: { username: COMPAT_CHATTER.username } });
        // Skipped for a client whose token is refused it: asserted below instead.
        if (!lane.refusedSharedOperations.includes("pages")) {
          const pages = await call<Array<{ label: string }>>(sdk, ctx.client, "pages");
          expect(pages.map((page) => page.label)).toEqual(expect.arrayContaining(Object.values(COMPAT_PAGES)));
        }
        const reads = lane.sharedReads(persona);
        const recapStatus = await call(sdk, ctx.client, "aiRecapStatus", { query: reads.aiRecapStatus });
        expect(recapStatus).toHaveProperty("full");
        const spenders = await call(sdk, ctx.client, "spenders", { query: reads.spenders });
        expect(spenders).toMatchObject({ items: expect.any(Array) });

        // The acceptance event as the client's reporter sends it, for a real generation.
        const generationRef = generationRefOf(await streamFeature(sdk, options, reply.feature, reply.body(persona), false, reply.capabilities));
        const clientEventId = randomUUID();
        const event = lane.acceptanceEvent({ clientEventId, generationRef, feature: reply.feature });
        expect(await call(sdk, ctx.client, "ingestObservations", { body: { events: [event] } })).toEqual({ accepted: 1, duplicates: 0 });
        const { rows } = await testDb!.pool.query(
          `select kind, producer, payload from observations where idempotency_key like '%:' || $1`, [clientEventId],
        );
        // The producer an old client is journaled under never moves.
        expect(rows).toEqual([{ kind: "desktop.ai_acceptance", producer: lane.producer({ version, header }), payload: event.payload }]);

        if (lane.healthEvent) {
          // H-11b: its own batch; never journaled, folded into hourly rollups
          // only while the owner's health intake is on.
          const health = lane.healthEvent(version);
          const restore = keepOwnerSwitches(appContext.config);
          appContext.config.chatExtensionHealthIngestEnabled = true;
          try {
            expect(await call(sdk, ctx.client, "ingestObservations", { body: { events: [health] } })).toEqual({ accepted: 1, duplicates: 0 });
          } finally {
            restore();
          }
          const journaled = await testDb!.pool.query(
            "select 1 from observations where idempotency_key like '%:' || $1", [health.clientEventId],
          );
          expect(journaled.rowCount).toBe(0);
          const folded = await testDb!.pool.query(
            "select 1 from client_health_receipts where client_event_id = $1", [health.clientEventId],
          );
          expect(folded.rowCount, "the health intake folded the report").toBe(1);
        }
      }, INTEGRATION_TEST_TIMEOUT_MS);

      it("streams every AI request the client makes, with and without the prompt echo", async (context) => {
        if (!ready(context)) return;
        try {
          for (const echoEnabled of [false, true]) {
            appContext.config.chatMuseAiPromptDebugEchoEnabled = echoEnabled;
            for (const request of lane.calls) {
              for (const askEcho of [false, true]) {
                const frames = await streamFeature(
                  ctx.sdk, options, request.feature, request.body(persona), askEcho, request.capabilities,
                );
                const what = `${request.name} switch=${echoEnabled} ask=${askEcho}`;
                expect(frames.map((frame) => frame.type), what).toEqual([
                  "meta",
                  ...(echoEnabled && askEcho ? ["debug_input_v1"] : []),
                  // H-4b: only a caller that advertised context-v1 gets it.
                  ...(request.capabilities?.includes("context-v1") ? ["context_v1"] : []),
                  "content_delta", "usage", "done",
                ]);
                // Desktop: the hub's OnlyFans archive; Fansly: the clientContext sent.
                expect(promptText(), what).toContain(request.promptMarker);
              }
            }
          }
        } finally {
          appContext.config.chatMuseAiPromptDebugEchoEnabled = false;
        }
      }, AI_TEST_TIMEOUT_MS);

      it("carries the errors the client branches on", async (context) => {
        if (!ready(context)) return;
        const { sdk } = ctx;
        // The client's own kind of token: a narrow one for chat-extension.
        const profile = lane.tokenClient === null ? {} : { clientProfile: lane.tokenClient };
        const revoked = await issueDeviceTokenForUsername(appContext, { username: COMPAT_CHATTER.username, label: "compat revoked", ...profile });
        await testDb!.pool.query("update device_tokens set revoked_at = now() where id = $1", [revoked.id]);
        expect(await failure(sdk, call(sdk, ctx.clientFor(revoked.token), "me")))
          .toMatchObject({ status: 401, category: "auth", body: { reason: "token_revoked" } });
        expect(await failure(sdk, streamFeature(sdk, optionsFor(revoked.token), reply.feature, reply.body(persona), false, reply.capabilities)))
          .toMatchObject({ status: 401, category: "auth", body: { reason: "token_revoked" } });
        const expired = await issueDeviceTokenForUsername(appContext, {
          username: COMPAT_CHATTER.username, label: "compat expired", expiresAt: new Date(Date.now() - 60_000), ...profile,
        });
        expect(await failure(sdk, call(sdk, ctx.clientFor(expired.token), "me")))
          .toMatchObject({ status: 401, category: "auth", body: { reason: "token_expired" } });

        const stale = { ...reply.body(persona), expectedPersonaDefinitionId: "compat-stale-definition" };
        expect(await failure(sdk, streamFeature(sdk, options, reply.feature, stale, false, reply.capabilities)))
          .toMatchObject({ status: 409, category: "conflict", code: "persona_definition_changed" });

        appContext.config.chatMuseAiGatewayDailyRequestLimit = 0;
        try {
          expect(await failure(sdk, streamFeature(sdk, options, reply.feature, reply.body(persona), false, reply.capabilities)))
            .toMatchObject({ status: 429, category: "rate_limit", code: "quota_denied" });
        } finally {
          appContext.config.chatMuseAiGatewayDailyRequestLimit = AI_REQUEST_LIMIT;
        }
      }, INTEGRATION_TEST_TIMEOUT_MS);

      it("serves the operations this row lists", async (context) => {
        if (!ready(context)) return;
        for (const operation of row.operations) {
          const exercise = COMPAT_OPERATION_EXERCISERS[operation];
          expect(exercise, `no exerciser for ${operation}`).toBeDefined();
          await exercise!(ctx);
        }
      }, AI_TEST_TIMEOUT_MS);
    });
  }
}
