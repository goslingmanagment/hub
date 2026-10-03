import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, createOnlyFansPage, seedBundledAiPersona, storeProxyConfig } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { CLIENT_SDK_REGISTRY } from "../apps/runtime/src/services/client-sdk-registry.ts";
import {
  COMPAT_FANS,
  COMPAT_FEATURES,
  COMPAT_LEAD,
  COMPAT_OPERATION_EXERCISERS,
  COMPAT_PAGES,
  call,
  failure,
  laneFor,
  loadFrozenSdk,
  streamFeature,
  type CompatContext,
  type CompatFeature,
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

const CHATTER = "compat-chatter";
const OF_ARCHIVE_MARKER = "compat archive marker";
// Every row and client generates on the same chatter and pages today.
const AI_REQUEST_LIMIT = 10_000;

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let baseUrl = "";
let chatterToken = "";
const capture: { input?: AiGatewayProviderInput } = {};

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  appContext = createTestAppContext(testDb);
  appContext.config.chatMuseAiGatewayEnabled = true;
  appContext.config.chatMuseAiGatewayDailyRequestLimit = AI_REQUEST_LIMIT;
  appContext.aiGatewayProvider = {
    provider: "anthropic",
    async *stream(input) {
      capture.input = input;
      yield { type: "content_delta", text: "compat reply" };
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
  const ofPage = await createOnlyFansPage(appContext.db, { modelId: model!.id, label: COMPAT_PAGES.onlyfans });
  const fsPage = await createFanslyPage(appContext.db, { modelId: model!.id, label: COMPAT_PAGES.fansly });
  for (const page of [ofPage!, fsPage!]) {
    await storeProxyConfig(appContext.db, page.id, {
      url: "socks5://proxy.example:1080", encryptedAuth: null, keyVersion: null, rateLimitScopeKey: "compat-ai-proxy",
    });
  }
  await createUserAccount(appContext, { username: COMPAT_LEAD.username, role: "team_lead", password: COMPAT_LEAD.password }, { source: "cli" });
  await createUserAccount(appContext, { username: CHATTER, role: "chatter" }, { source: "cli" });
  chatterToken = (await issueChatterDeviceToken(appContext, { username: CHATTER, pageLabel: COMPAT_PAGES.onlyfans }, { source: "cli" })).key;
  await assignPageToUser(appContext, { userId: await fixtureUserId(appContext, CHATTER), pageLabel: COMPAT_PAGES.fansly }, { source: "cli" });

  // OnlyFans: the hub reads the conversation from its own archive (36 rows,
  // enough for the 30-message Recap gate). Fansly: a visible thread, so the
  // conversation-profile read resolves the fan behind the group id (a Fansly
  // fan must already be on the page; the hub creates only OnlyFans fans).
  await testDb.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, is_sent_by_me, occurred_at, text_plain)
     select $1, 'onlyfans', $2, (5000 + g)::text, case when g % 2 = 0 then null else $2 end,
            g % 2 = 0, now() - interval '3 days' + (g || ' minutes')::interval, $3 || ' ' || g
     from generate_series(1, 36) g`,
    [ofPage!.id, COMPAT_FANS.onlyfans, OF_ARCHIVE_MARKER],
  );
  const fan = await testDb.pool.query<{ id: string }>(
    `insert into fans (platform, platform_user_id, username) values ('fansly', $1, 'compatfan') returning id::text`,
    [COMPAT_FANS.fansly],
  );
  await testDb.pool.query(
    `insert into page_fans (fan_id, platform_account_id) values ($1, $2)`,
    [Number(fan.rows[0]!.id), fsPage!.id],
  );
  await testDb.pool.query(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id)
     values ($1, $2, $3, $4)`,
    [fsPage!.id, Number(fan.rows[0]!.id), COMPAT_FANS.fanslyGroup, COMPAT_FANS.fansly],
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
      const optionsFor = (token: string | null): FrozenClientOptions => ({
        baseUrl,
        ...(token ? { auth: { mode: "bearer" as const, token: () => token } } : {}),
        headers: { "x-client-version": header },
      });
      const body = (feature: CompatFeature) => lane.featureBody(feature, persona);
      const ready = (context: { skip: () => void }) => {
        if (!server) context.skip();
        return Boolean(server);
      };

      beforeAll(async () => {
        if (!server) return;
        const sdk = await loadFrozenSdk(row);
        expect(sdk.KERNEL_CONTRACT_HASH).toBe(row.contractHash);
        options = optionsFor(chatterToken);
        ctx = { sdk, lane, client: sdk.createClient(options), clientFor: (token) => sdk.createClient(optionsFor(token)) };
        const catalog = await call<{ personas: CompatPersona[] }>(sdk, ctx.client, "aiPersonaCatalog");
        const key = createBundledPersonalities()[0]!.id;
        persona = catalog.personas.find((item) => item.key === key)!;
        expect(persona?.definitionId).toEqual(expect.any(String));
      });

      it("reads health as the client does, a degraded 503 included", async (context) => {
        if (!ready(context)) return;
        const raw = ctx.client.raw as (key: string) => Promise<Response>;
        expect(await call(ctx.sdk, ctx.client, "health")).toMatchObject({ status: "ok" });
        const healthy = await raw("health");
        expect(ctx.sdk.routeSchemas.health!.response[200]!.safeParse(await healthy.json()).success).toBe(true);

        const query = appContext.pool.query.bind(appContext.pool) as (...args: unknown[]) => unknown;
        const down = vi.spyOn(appContext.pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) =>
          text === "select 1" ? Promise.reject(new Error("compat: database down")) : query(text, ...rest)) as never);
        try {
          expect(await failure(ctx.sdk, call(ctx.sdk, ctx.client, "health"))).toMatchObject({ status: 503, category: "server" });
          const degraded = await raw("health");
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
        expect(await call(sdk, ctx.client, "me")).toMatchObject({ authMethod: "device_token", user: { username: CHATTER } });
        const pages = await call<Array<{ label: string }>>(sdk, ctx.client, "pages");
        expect(pages.map((page) => page.label)).toEqual(expect.arrayContaining(Object.values(COMPAT_PAGES)));
        const recapStatus = await call(sdk, ctx.client, "aiRecapStatus", {
          query: { pageLabel, conversationRef: COMPAT_FANS[lane.platform], personaDefinitionId: persona.definitionId },
        });
        expect(recapStatus).toHaveProperty("full");
        const spenders = await call(sdk, ctx.client, "spenders", { query: { scope: "page", pageLabel, period: "30d", limit: 10, offset: 0 } });
        expect(spenders).toMatchObject({ items: expect.any(Array) });

        const clientEventId = randomUUID();
        const ingested = await call(sdk, ctx.client, "ingestObservations", {
          body: { events: [{ clientEventId, kind: "ai_acceptance", observedAt: new Date().toISOString(), payload: { suggestionId: "compat", outcome: "inserted" }, pageLabel }] },
        });
        expect(ingested).toEqual({ accepted: 1, duplicates: 0 });
        const { rows } = await testDb!.pool.query(
          `select kind, producer from observations where idempotency_key like '%:' || $1`, [clientEventId],
        );
        // The producer an old client is journaled under never moves.
        expect(rows).toEqual([{ kind: "desktop.ai_acceptance", producer: `desktop@${header}` }]);
      }, INTEGRATION_TEST_TIMEOUT_MS);

      it("streams Reply, Ping and Recap with and without the prompt echo", async (context) => {
        if (!ready(context)) return;
        try {
          for (const echoEnabled of [false, true]) {
            appContext.config.chatMuseAiPromptDebugEchoEnabled = echoEnabled;
            for (const feature of COMPAT_FEATURES) {
              for (const askEcho of [false, true]) {
                const frames = await streamFeature(ctx.sdk, options, feature, body(feature), askEcho);
                expect(frames.map((frame) => frame.type), `${feature} switch=${echoEnabled} ask=${askEcho}`).toEqual([
                  "meta", ...(echoEnabled && askEcho ? ["debug_input_v1"] : []), "content_delta", "usage", "done",
                ]);
              }
            }
          }
        } finally {
          appContext.config.chatMuseAiPromptDebugEchoEnabled = false;
        }
      }, INTEGRATION_TEST_TIMEOUT_MS);

      it("carries the errors the client branches on", async (context) => {
        if (!ready(context)) return;
        const { sdk } = ctx;
        const revoked = await issueDeviceTokenForUsername(appContext, { username: CHATTER, label: "compat revoked" });
        await testDb!.pool.query("update device_tokens set revoked_at = now() where id = $1", [revoked.id]);
        expect(await failure(sdk, call(sdk, ctx.clientFor(revoked.token), "me")))
          .toMatchObject({ status: 401, category: "auth", body: { reason: "token_revoked" } });
        expect(await failure(sdk, streamFeature(sdk, optionsFor(revoked.token), "fast-reply", body("fast-reply"))))
          .toMatchObject({ status: 401, category: "auth", body: { reason: "token_revoked" } });
        const expired = await issueDeviceTokenForUsername(appContext, {
          username: CHATTER, label: "compat expired", expiresAt: new Date(Date.now() - 60_000),
        });
        expect(await failure(sdk, call(sdk, ctx.clientFor(expired.token), "me")))
          .toMatchObject({ status: 401, category: "auth", body: { reason: "token_expired" } });

        const stale = { ...body("fast-reply"), expectedPersonaDefinitionId: "compat-stale-definition" };
        expect(await failure(sdk, streamFeature(sdk, options, "fast-reply", stale)))
          .toMatchObject({ status: 409, category: "conflict", code: "persona_definition_changed" });

        appContext.config.chatMuseAiGatewayDailyRequestLimit = 0;
        try {
          expect(await failure(sdk, streamFeature(sdk, options, "fast-reply", body("fast-reply"))))
            .toMatchObject({ status: 429, category: "rate_limit", code: "quota_denied" });
        } finally {
          appContext.config.chatMuseAiGatewayDailyRequestLimit = AI_REQUEST_LIMIT;
        }
      }, INTEGRATION_TEST_TIMEOUT_MS);

      if (client.name === "onlyfans-chat") {
        it("assembles OnlyFans context hub-side from the archive", async (context) => {
          if (!ready(context)) return;
          await streamFeature(ctx.sdk, options, "fast-reply", body("fast-reply"));
          expect(promptText()).toContain(`${OF_ARCHIVE_MARKER} 35`);
        }, INTEGRATION_TEST_TIMEOUT_MS);
      }

      if (client.name === "fansly-chat") {
        it("serves the clientContext path: 3000-message Recap, personal-count Hi, Split only on Reply", async (context) => {
          if (!ready(context)) return;
          const { sdk } = ctx;
          await streamFeature(sdk, options, "fan-summary", body("fan-summary"));
          expect(promptText()).toContain("compat fansly line 2999");
          const recapStatus = await call(sdk, ctx.client, "aiRecapStatus", {
            query: { pageLabel: COMPAT_PAGES.fansly, conversationRef: COMPAT_FANS.fanslyGroup, fanRef: COMPAT_FANS.fansly, personaDefinitionId: persona.definitionId },
          });
          expect(recapStatus).toMatchObject({ full: { requestedCount: 3000, keptCount: 3000 } });

          // 35 messages, 2 personal: the Hi gate counts the personal ones.
          expect((await streamFeature(sdk, options, "hi-greeting", body("hi-greeting"))).at(-1)?.type).toBe("done");

          // The Split toggle rides every Fansly request; only Reply may change.
          for (const feature of [...COMPAT_FEATURES, "hi-greeting"] as const) {
            const split = body(feature);
            await streamFeature(sdk, options, feature, split);
            const withSplit = promptOf();
            await streamFeature(sdk, options, feature, { ...split, clientRequestId: randomUUID(), replyMode: "default" });
            if (feature === "fast-reply") expect(withSplit, feature).not.toEqual(promptOf());
            else expect(withSplit, feature).toEqual(promptOf());
          }
        }, INTEGRATION_TEST_TIMEOUT_MS);
      }

      it("serves the operations this row lists", async (context) => {
        if (!ready(context)) return;
        for (const operation of row.operations) {
          const exercise = COMPAT_OPERATION_EXERCISERS[operation];
          expect(exercise, `no exerciser for ${operation}`).toBeDefined();
          await exercise!(ctx);
        }
      }, INTEGRATION_TEST_TIMEOUT_MS);
    });
  }
}
