import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  seedBundledAiPersona,
  setPageOfapiAccountId,
  storeProxyConfig,
  upsertVoiceProfile,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import {
  assignPageToUser,
  createUserAccount,
  setDeviceTokenHarvestCapabilityForUserId,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { CLIENT_SDK_REGISTRY } from "../apps/runtime/src/services/client-sdk-registry.ts";
import {
  COMPAT_ARCHIVE,
  COMPAT_CHATTER,
  COMPAT_COMPLETION,
  COMPAT_FANS,
  COMPAT_OF_ACCOUNT,
  COMPAT_OPERATION_EXERCISERS,
  COMPAT_OWNER,
  COMPAT_PAGES,
  SPLIT_FEATURES,
  call,
  failure,
  generationRefOf,
  laneFor,
  loadFrozenSdk,
  raw,
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

for (const row of CLIENT_SDK_REGISTRY) {
  for (const client of row.clients) {
    const lane = laneFor(client.name);
    const version = client.versions[client.versions.length - 1]!;
    const header = lane.clientVersion(version);

    describe(`frozen SDK ${row.bundleSha256.slice(0, 12)} (${row.status}) as ${client.name} ${version}`, () => {
      let ctx: CompatContext;
      let options: FrozenClientOptions;
      let persona: CompatPersona;
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
        options = optionsFor(chatterToken);
        ctx = {
          sdk, lane, options, pageIds, pool: testDb!.pool,
          client: sdk.createClient(options),
          clientFor: (token) => sdk.createClient(optionsFor(token)),
        };
        const catalog = await call<{ personas: CompatPersona[] }>(sdk, ctx.client, "aiPersonaCatalog");
        const key = createBundledPersonalities()[0]!.id;
        persona = catalog.personas.find((item) => item.key === key)!;
        expect(persona?.definitionId).toEqual(expect.any(String));
      });

      it("reads health as the client does, a degraded 503 included", async (context) => {
        if (!ready(context)) return;
        expect(await call(ctx.sdk, ctx.client, "health")).toMatchObject({ status: "ok" });
        const healthy = await raw(ctx.client, "health");
        expect(ctx.sdk.routeSchemas.health!.response[200]!.safeParse(await healthy.json()).success).toBe(true);

        const query = appContext.pool.query.bind(appContext.pool) as (...args: unknown[]) => unknown;
        const down = vi.spyOn(appContext.pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) =>
          text === "select 1" ? Promise.reject(new Error("compat: database down")) : query(text, ...rest)) as never);
        try {
          expect(await failure(ctx.sdk, call(ctx.sdk, ctx.client, "health"))).toMatchObject({ status: 503, category: "server" });
          const degraded = await raw(ctx.client, "health");
          const payload = await degraded.json() as unknown;
          expect(degraded.status).toBe(503);
          expect(payload).toMatchObject({ status: "degraded" });
          expect(ctx.sdk.routeSchemas.health!.response[200]!.safeParse(payload).success).toBe(true);
          expect(ctx.sdk.routeSchemas.health!.response[503]!.safeParse(payload).success).toBe(true);
        } finally {
          down.mockRestore();
        }
      }, INTEGRATION_TEST_TIMEOUT_MS);

      it("answers the shared reads and the capture lane", async (context) => {
        if (!ready(context)) return;
        const { sdk } = ctx;
        const pageLabel = COMPAT_PAGES[lane.platform];
        expect(await call(sdk, ctx.client, "me")).toMatchObject({ authMethod: "device_token", user: { username: COMPAT_CHATTER.username } });
        const pages = await call<Array<{ label: string }>>(sdk, ctx.client, "pages");
        expect(pages.map((page) => page.label)).toEqual(expect.arrayContaining(Object.values(COMPAT_PAGES)));
        const recapStatus = await call(sdk, ctx.client, "aiRecapStatus", {
          query: { pageLabel, conversationRef: COMPAT_FANS[lane.platform], personaDefinitionId: persona.definitionId },
        });
        expect(recapStatus).toHaveProperty("full");
        const spenders = await call(sdk, ctx.client, "spenders", { query: { scope: "page", pageLabel, period: "30d", limit: 10, offset: 0 } });
        expect(spenders).toMatchObject({ items: expect.any(Array) });

        // The acceptance event as the client's reporter sends it, for a real generation.
        const generationRef = generationRefOf(await streamFeature(sdk, options, reply.feature, reply.body(persona)));
        const clientEventId = randomUUID();
        const event = lane.acceptanceEvent({ clientEventId, generationRef, feature: reply.feature });
        expect(await call(sdk, ctx.client, "ingestObservations", { body: { events: [event] } })).toEqual({ accepted: 1, duplicates: 0 });
        const { rows } = await testDb!.pool.query(
          `select kind, producer, payload from observations where idempotency_key like '%:' || $1`, [clientEventId],
        );
        // The producer an old client is journaled under never moves.
        expect(rows).toEqual([{ kind: "desktop.ai_acceptance", producer: `desktop@${header}`, payload: event.payload }]);
      }, INTEGRATION_TEST_TIMEOUT_MS);

      it("streams every AI request the client makes, with and without the prompt echo", async (context) => {
        if (!ready(context)) return;
        try {
          for (const echoEnabled of [false, true]) {
            appContext.config.chatMuseAiPromptDebugEchoEnabled = echoEnabled;
            for (const request of lane.calls) {
              for (const askEcho of [false, true]) {
                const frames = await streamFeature(ctx.sdk, options, request.feature, request.body(persona), askEcho);
                const what = `${request.name} switch=${echoEnabled} ask=${askEcho}`;
                expect(frames.map((frame) => frame.type), what).toEqual([
                  "meta", ...(echoEnabled && askEcho ? ["debug_input_v1"] : []), "content_delta", "usage", "done",
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

      // H-10's promise: a client that does not advertise split-all-v1 keeps its
      // prompts. Released clients send replyMode on Reply and Fix only; the suite
      // sends it on every request so a hub that starts honoring it elsewhere fails.
      it("lets the Split toggle change only the Reply and Fix prompts", async (context) => {
        if (!ready(context)) return;
        for (const request of lane.calls) {
          await streamFeature(ctx.sdk, options, request.feature, { ...request.body(persona), replyMode: "preferSplit" });
          const split = promptOf();
          await streamFeature(ctx.sdk, options, request.feature, { ...request.body(persona), replyMode: "default" });
          if (SPLIT_FEATURES.has(request.feature)) expect(split, request.name).not.toEqual(promptOf());
          else expect(split, request.name).toEqual(promptOf());
        }
      }, AI_TEST_TIMEOUT_MS);

      it("carries the errors the client branches on", async (context) => {
        if (!ready(context)) return;
        const { sdk } = ctx;
        const revoked = await issueDeviceTokenForUsername(appContext, { username: COMPAT_CHATTER.username, label: "compat revoked" });
        await testDb!.pool.query("update device_tokens set revoked_at = now() where id = $1", [revoked.id]);
        expect(await failure(sdk, call(sdk, ctx.clientFor(revoked.token), "me")))
          .toMatchObject({ status: 401, category: "auth", body: { reason: "token_revoked" } });
        expect(await failure(sdk, streamFeature(sdk, optionsFor(revoked.token), reply.feature, reply.body(persona))))
          .toMatchObject({ status: 401, category: "auth", body: { reason: "token_revoked" } });
        const expired = await issueDeviceTokenForUsername(appContext, {
          username: COMPAT_CHATTER.username, label: "compat expired", expiresAt: new Date(Date.now() - 60_000),
        });
        expect(await failure(sdk, call(sdk, ctx.clientFor(expired.token), "me")))
          .toMatchObject({ status: 401, category: "auth", body: { reason: "token_expired" } });

        const stale = { ...reply.body(persona), expectedPersonaDefinitionId: "compat-stale-definition" };
        expect(await failure(sdk, streamFeature(sdk, options, reply.feature, stale)))
          .toMatchObject({ status: 409, category: "conflict", code: "persona_definition_changed" });

        appContext.config.chatMuseAiGatewayDailyRequestLimit = 0;
        try {
          expect(await failure(sdk, streamFeature(sdk, options, reply.feature, reply.body(persona))))
            .toMatchObject({ status: 429, category: "rate_limit", code: "quota_denied" });
        } finally {
          appContext.config.chatMuseAiGatewayDailyRequestLimit = AI_REQUEST_LIMIT;
        }
      }, INTEGRATION_TEST_TIMEOUT_MS);

      if (lane.harvest) {
        it("journals the harvest lane under its own producer and verbatim kinds", async (context) => {
          if (!ready(context)) return;
          const machineId = randomUUID();
          const token = await issueDeviceTokenForUsername(appContext, { username: COMPAT_CHATTER.username, label: "compat harvest" });
          await setDeviceTokenHarvestCapabilityForUserId(appContext, {
            userId: await fixtureUserId(appContext, COMPAT_CHATTER.username), deviceTokenId: token.id, machineId,
          }, { source: "cli", actorUserId: await fixtureUserId(appContext, COMPAT_OWNER.username) });
          // onlyfans-chat apps/desktop/src/main/harvest/index.ts toRevision.
          const row = { account_id: COMPAT_OF_ACCOUNT, chat_id: COMPAT_FANS.onlyfans, message_id: "5001", created_at: "2026-09-30T10:00:00.000Z", is_sent_by_me: 0 };
          const event = {
            clientEventId: randomUUID(),
            kind: "harvest.messages",
            observedAt: row.created_at,
            payload: {
              table: "messages", machineId, schemaVersion: 42, harvestFormatVersion: 1,
              rowKey: JSON.stringify([row.account_id, row.chat_id, row.message_id]), contentHash: "a".repeat(64),
              ofapiAccountId: COMPAT_OF_ACCOUNT, row,
            },
          };
          const harvester = ctx.sdk.createClient(optionsFor(token.token, `harvest-${version}`));
          expect(await call(ctx.sdk, harvester, "ingestObservations", { body: { events: [event] } })).toEqual({ accepted: 1, duplicates: 0 });
          const { rows } = await testDb!.pool.query(
            `select kind, producer, account_id::int as account_id from observations where idempotency_key = $1`, [`${machineId}:${event.clientEventId}`],
          );
          expect(rows).toEqual([{ kind: "harvest.messages", producer: `desktop-harvest@${version}`, account_id: pageIds.onlyfans }]);
        }, INTEGRATION_TEST_TIMEOUT_MS);
      }

      if (lane.platform === "fansly") {
        it("keeps both Recap slots the extension reads: a 3000-message full and a 300-window short", async (context) => {
          if (!ready(context)) return;
          for (const name of ["Recap", "Short Recap"]) {
            const request = lane.calls.find((item) => item.name === name)!;
            await streamFeature(ctx.sdk, options, request.feature, request.body(persona));
          }
          const recapStatus = await call(ctx.sdk, ctx.client, "aiRecapStatus", {
            query: { pageLabel: COMPAT_PAGES.fansly, conversationRef: COMPAT_FANS.fanslyGroup, fanRef: COMPAT_FANS.fansly, personaDefinitionId: persona.definitionId },
          });
          expect(recapStatus).toMatchObject({
            full: { requestedCount: 3000, keptCount: 3000, transcriptCoverage: null },
            short: { requestedCount: 300, keptCount: 120, transcriptCoverage: "window" },
          });
        }, INTEGRATION_TEST_TIMEOUT_MS);
      }

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
