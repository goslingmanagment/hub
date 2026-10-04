import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  clientAiUsageResponseSchema,
  clientBootstrapResponseSchema,
  errorResponseSchema,
  type ClientAiUsageResponse,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  deletePageByLabel,
  finalizeAiGatewayUsageEvent,
  insertAgentKey,
  insertAiUsageEvents,
  listUserPageDailyUsage,
  reserveAiGatewayUsageEvent,
  type InsertAiUsageEventInput,
} from "@agency_hub_core/db";
import { sha256Hex, type AiUsageFeature } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  assignPageToUser,
  createUserAccount,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// chat-extension H-15: GET /api/v1/client/pages/:pageLabel/ai-usage, the
// caller's own AI spend on one page, by day. The wire shape is
// tests/client-ai-usage-contract.test.ts.
//
// The clock is pinned (only `Date` is faked) at an instant where the hub's two
// day boundaries disagree: 22:30 UTC on 3 October is already 01:30 on 4 October
// in Moscow. Report days are Moscow days by default; the quota's day is UTC.

const NOW = "2026-10-03T22:30:00.000Z";
const PASSWORDS = { owner: "owner-secret", grisha: "grisha-secret" } as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** A live Agent Read Plane key granted lora-of: refused by its kind, not by the page. */
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}clientaiusage000000`;
/** The test app's quota limits (tests/helpers/runtime.ts defaults). */
const REQUEST_LIMIT = 200;
const MICRO_USD_LIMIT = 5_000_000;

/**
 * The answer as the chat extension froze it (its contracts v1,
 * packages/contracts/src/hub/usage.ts: AiUsageReportSchema), restated here: it
 * is stricter than the hub's own response schema (instants by pattern, tokens
 * of 1 to 64 characters), and a body it refused would be lost on the client.
 */
const frozenInstant = z.string().max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
const frozenToken = z.string().min(1).max(64);
const frozenCount = z.number().int().min(0);
const frozenTotals = z.object({
  requestCount: frozenCount,
  costMicroUsd: frozenCount,
  costApproximate: z.boolean(),
  tokens: z.object({ input: frozenCount, output: frozenCount, cacheWrite: frozenCount, cacheRead: frozenCount }),
  completed: frozenCount,
  failed: frozenCount,
  cancelled: frozenCount,
  quotaDenied: frozenCount,
  openReservations: frozenCount,
  regenerations: frozenCount,
});
const frozenClientReportSchema = z.object({
  scope: z.object({ pageLabel: z.string(), userId: z.number().int().min(1) }),
  timeZone: z.string(),
  asOf: frozenInstant,
  moneyUnit: z.literal("micro-USD"),
  days: z.array(z.object({
    date: z.string(),
    from: frozenInstant,
    toExclusive: frozenInstant,
    coverage: frozenToken,
    coverageReasons: z.array(frozenToken),
    totals: frozenTotals,
    features: z.array(frozenTotals.extend({ feature: frozenToken })),
  })),
  quota: z.object({
    dayBoundary: z.literal("UTC"),
    remainingRequestsToday: frozenCount.nullable(),
    remainingMicroUsdToday: frozenCount.nullable(),
  }).nullable(),
});

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Outcome = "completed" | "failed" | "cancelled" | "quota_denied" | "open";

interface SeedRow {
  at: string;
  feature?: AiUsageFeature;
  outcome?: Outcome;
  cost?: number;
  approximate?: boolean;
  regeneration?: boolean;
  /** input, output, cache write, cache read. */
  tokens?: readonly [number, number, number, number];
}

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
/** authPolicyEnforcement "log" (the test default): the handler's own guards answer. */
let server: ApiServer | null = null;
/** authPolicyEnforcement "enforce": the declared policy answers before the handler. */
let enforceServer: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
let ownerToken = "";
/** Grisha's narrow chat-extension token, issued by the real password sign-in. */
let narrowToken = "";
/** Grisha's full device token. */
let fullToken = "";
let nikitaToken = "";
let ownerId = 0;
let grishaId = 0;
let nikitaId = 0;
let seedSequence = 0;
const pageIds: Record<string, number> = {};

/** Ledger rows in the shape the gateway leaves them in, by outcome; no page = a legacy client-reported row. */
async function seed(userId: number, pageLabel: string | null, rows: readonly SeedRow[]) {
  const events = rows.map((row): InsertAiUsageEventInput => {
    const outcome = row.outcome ?? "completed";
    const [inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens] = row.tokens ?? [0, 0, 0, 0];
    seedSequence += 1;
    return {
      clientEventId: `seed-${seedSequence}`,
      feature: row.feature ?? "fast-reply",
      model: "anthropic:claude-test",
      pageId: pageLabel === null ? null : pageIds[pageLabel]!,
      // A legacy client-reported row (no page) carries no gateway columns at all.
      provider: pageLabel === null ? null : "anthropic",
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      costMicroUsd: row.cost ?? 0,
      costApproximate: row.approximate ?? false,
      quotaAccepted: pageLabel === null ? null : outcome !== "quota_denied",
      gatewayOutcome: pageLabel === null || outcome === "open" ? null : outcome,
      errorCode: outcome === "failed" ? "provider_stream_failed" : null,
      failurePhase: outcome === "failed" ? "stream" : null,
      isCacheHit: false,
      isRegeneration: row.regeneration ?? false,
      completedAt: new Date(row.at),
    };
  });
  await insertAiUsageEvents(app.db, { userId, events });
}

function totals(input: Partial<{
  requestCount: number;
  costMicroUsd: number;
  costApproximate: boolean;
  tokens: readonly [number, number, number, number];
  completed: number;
  failed: number;
  cancelled: number;
  quotaDenied: number;
  openReservations: number;
  regenerations: number;
}> = {}) {
  const [input_, output, cacheWrite, cacheRead] = input.tokens ?? [0, 0, 0, 0];
  return {
    requestCount: input.requestCount ?? 0,
    costMicroUsd: input.costMicroUsd ?? 0,
    costApproximate: input.costApproximate ?? false,
    tokens: { input: input_, output, cacheWrite, cacheRead },
    completed: input.completed ?? 0,
    failed: input.failed ?? 0,
    cancelled: input.cancelled ?? 0,
    quotaDenied: input.quotaDenied ?? 0,
    openReservations: input.openReservations ?? 0,
    regenerations: input.regenerations ?? 0,
  };
}

async function usage(
  token: string,
  pageLabel: string,
  query: string,
  options: { via?: ApiServer; clientVersion?: string | null } = {},
): Promise<InjectResponse> {
  const clientVersion = options.clientVersion === undefined ? EXTENSION_VERSION : options.clientVersion;
  return (options.via ?? server!).inject({
    method: "GET",
    url: `/api/v1/client/pages/${pageLabel}/ai-usage?${query}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(clientVersion === null ? {} : { "x-client-version": clientVersion }),
    },
  });
}

async function report(token: string, pageLabel: string, query: string): Promise<ClientAiUsageResponse> {
  const response = await usage(token, pageLabel, query);
  expect(response.statusCode, response.body).toBe(200);
  // The installed client's own shape first, then the hub's (what the SDK parses with).
  frozenClientReportSchema.parse(response.json());
  return clientAiUsageResponseSchema.parse(response.json());
}

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode, ...(reason === undefined ? {} : { reason }) });
  if (reason === undefined) {
    expect(body.reason, response.body).toBeUndefined();
  }
}

async function patchConfig(patches: Array<{ key: string; value: unknown }>) {
  const response = await server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: ownerCookie },
    payload: { patches },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** The owner's master switch. No flag is needed: this route has none. */
async function switchExtensionOn() {
  await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
}

async function ledgerRowCount(): Promise<number> {
  const { rows } = await testDb!.pool.query<{ count: number }>("select count(*)::int as count from ai_usage_events");
  return rows[0]!.count;
}

describe("GET /api/v1/client/pages/:pageLabel/ai-usage", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    await resetIntegrationDatabase(testDb.pool);
    app = createTestAppContext(testDb, { chatMuseAiGatewayEnabled: true });
    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    await createUserAccount(app, { username: "nikita", role: "chatter" }, AUDIT);
    ownerId = await fixtureUserId(app, "owner");
    grishaId = await fixtureUserId(app, "grisha");
    nikitaId = await fixtureUserId(app, "nikita");
    // Setting a password ends every sign-in, so it comes before the tokens.
    await setUserPassword(app, { userId: grishaId, password: PASSWORDS.grisha }, AUDIT);

    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const [label, create] of [
      ["lora-of", createOnlyFansPage],
      ["lora-fansly", createFanslyPage],
      // An OnlyFans page the extension could not bind: no platform account id.
      ["nova-of", createOnlyFansPage],
      ["lora-old-of", createOnlyFansPage],
      ["mia-of", createOnlyFansPage],
    ] as const) {
      const page = await create(app.db, { modelId: lora!.id, label });
      pageIds[label] = page!.id;
    }
    await testDb.pool.query(`update pages set external_page_id = '100000001' where id = $1`, [pageIds["lora-of"]]);
    // A chat with unread messages, so the trap's unread check has something to hold.
    await testDb.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, '100000777', 2)`,
      [pageIds["lora-of"]],
    );
    for (const label of ["lora-of", "lora-fansly", "nova-of", "lora-old-of"]) {
      await assignPageToUser(app, { userId: grishaId, pageLabel: label }, AUDIT);
    }
    await assignPageToUser(app, { userId: nikitaId, pageLabel: "lora-of" }, AUDIT);
    await deletePageByLabel(app.db, "lora-old-of");

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: ownerId, label: "owner client" })).token;
    fullToken = (await issueDeviceTokenForUserId(app, { userId: grishaId, label: "grisha full" })).token;
    nikitaToken = (await issueDeviceTokenForUserId(app, { userId: nikitaId, label: "nikita client" })).token;
    await insertAgentKey(app.db, {
      name: "client-ai-usage-probe",
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
    enforceServer = await buildApiServer(createTestAppContext(testDb, {
      authPolicyEnforcement: "enforce",
      chatMuseAiGatewayEnabled: true,
    }));
    await enforceServer.ready();

    const narrow = await server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": EXTENSION_VERSION },
      payload: {
        username: "grisha",
        password: PASSWORDS.grisha,
        label: "Firefox · macOS · ChatSpace",
        mode: "active",
        client: "chat-extension",
      },
    });
    expect(narrow.statusCode, narrow.body).toBe(200);
    expect(narrow.json()).toMatchObject({ client: "chat-extension" });
    narrowToken = narrow.json<{ token: string }>().token;

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: PASSWORDS.owner },
    });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    ownerCookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
    trap = await armNoOutboundTrap(testDb);
  }, 120_000);

  afterEach(async () => {
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
    await enforceServer?.close();
    enforceServer = null;
    vi.useRealTimers();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("answers the caller's own rows on the page of the path, by Moscow day, and a quota counted over the UTC day", async (context) => {
    if (!server) return context.skip();
    await switchExtensionOn();

    await seed(grishaId, "lora-of", [
      // The last millisecond of 1 October in Moscow: outside a 3-day report.
      { at: "2026-10-01T20:59:59.999Z", cost: 999_999 },
      // 2 October in Moscow: [1 Oct 21:00Z, 2 Oct 21:00Z).
      { at: "2026-10-01T21:00:00.000Z", cost: 1500, tokens: [1000, 100, 0, 200] },
      { at: "2026-10-02T09:00:00.000Z", cost: 2500, regeneration: true, tokens: [2000, 150, 50, 0] },
      { at: "2026-10-02T10:00:00.000Z", feature: "fan-summary", cost: 40_000, tokens: [30_000, 900, 0, 0] },
      { at: "2026-10-02T11:00:00.000Z", outcome: "failed" },
      // 3 October in Moscow: [2 Oct 21:00Z, 3 Oct 21:00Z). Its first row is still 2 October in UTC.
      { at: "2026-10-02T21:00:00.000Z", feature: "coach-chat", cost: 9000, tokens: [5000, 500, 0, 0] },
      { at: "2026-10-03T05:00:00.000Z", outcome: "quota_denied" },
      { at: "2026-10-03T06:00:00.000Z", feature: "improve-draft", outcome: "cancelled", cost: 300, tokens: [400, 10, 0, 0] },
      { at: "2026-10-03T20:59:59.999Z", cost: 700, tokens: [600, 40, 0, 0] },
      // 4 October in Moscow, today: from 3 Oct 21:00Z. Still 3 October in UTC.
      { at: "2026-10-03T21:00:00.000Z", cost: 1100, tokens: [900, 60, 0, 0] },
      { at: "2026-10-03T22:29:00.000Z", feature: "hi-greeting", outcome: "open" },
    ]);
    // None of these is the caller's spend on this page.
    await seed(grishaId, "lora-fansly", [{ at: "2026-10-03T10:00:00.000Z", cost: 77_000 }]);
    await seed(grishaId, null, [{ at: "2026-10-03T10:00:00.000Z", cost: 66_000 }]);
    await seed(nikitaId, "lora-of", [{ at: "2026-10-03T10:00:00.000Z", cost: 88_000 }]);
    await seed(ownerId, "lora-of", [{ at: "2026-10-03T12:00:00.000Z", cost: 5000, tokens: [3000, 200, 0, 0] }]);
    // The hub's own system lane on the page (no user).
    await reserveAiGatewayUsageEvent(app.db, {
      userId: null,
      event: {
        clientEventId: "system-lane-1",
        feature: "media-describe",
        model: "anthropic:claude-test",
        pageId: pageIds["lora-of"]!,
        provider: "anthropic",
        isRegeneration: false,
        reservedAt: new Date("2026-10-03T10:00:00.000Z"),
      },
    });
    const rowsBefore = await ledgerRowCount();

    const body = await report(narrowToken, "lora-of", "date=2026-10-04&days=3");

    expect(body).toEqual({
      scope: { pageLabel: "lora-of", userId: grishaId },
      timeZone: "Europe/Moscow",
      asOf: NOW,
      moneyUnit: "micro-USD",
      days: [
        {
          date: "2026-10-02",
          from: "2026-10-01T21:00:00.000Z",
          toExclusive: "2026-10-02T21:00:00.000Z",
          coverage: "complete",
          coverageReasons: [],
          totals: totals({
            requestCount: 4, costMicroUsd: 44_000, tokens: [33_000, 1150, 50, 200], completed: 3, failed: 1, regenerations: 1,
          }),
          features: [
            { feature: "fan-summary", ...totals({ requestCount: 1, costMicroUsd: 40_000, tokens: [30_000, 900, 0, 0], completed: 1 }) },
            {
              feature: "fast-reply",
              ...totals({ requestCount: 3, costMicroUsd: 4000, tokens: [3000, 250, 50, 200], completed: 2, failed: 1, regenerations: 1 }),
            },
          ],
        },
        {
          date: "2026-10-03",
          from: "2026-10-02T21:00:00.000Z",
          toExclusive: "2026-10-03T21:00:00.000Z",
          coverage: "complete",
          coverageReasons: [],
          totals: totals({
            requestCount: 4, costMicroUsd: 10_000, tokens: [6000, 550, 0, 0], completed: 2, cancelled: 1, quotaDenied: 1,
          }),
          features: [
            { feature: "coach-chat", ...totals({ requestCount: 1, costMicroUsd: 9000, tokens: [5000, 500, 0, 0], completed: 1 }) },
            { feature: "fast-reply", ...totals({ requestCount: 2, costMicroUsd: 700, tokens: [600, 40, 0, 0], completed: 1, quotaDenied: 1 }) },
            { feature: "improve-draft", ...totals({ requestCount: 1, costMicroUsd: 300, tokens: [400, 10, 0, 0], cancelled: 1 }) },
          ],
        },
        {
          date: "2026-10-04",
          from: "2026-10-03T21:00:00.000Z",
          toExclusive: "2026-10-04T21:00:00.000Z",
          coverage: "partial",
          coverageReasons: ["day_open", "open_reservations"],
          totals: totals({ requestCount: 2, costMicroUsd: 1100, tokens: [900, 60, 0, 0], completed: 1, openReservations: 1 }),
          features: [
            { feature: "fast-reply", ...totals({ requestCount: 1, costMicroUsd: 1100, tokens: [900, 60, 0, 0], completed: 1 }) },
            { feature: "hi-greeting", ...totals({ requestCount: 1, openReservations: 1 }) },
          ],
        },
      ],
      // The quota's day is 3 October UTC: five of the caller's rows on this page
      // (05:00, 06:00, 20:59, 21:00, 22:29), 2100 micro-USD. Moscow's "today"
      // above holds two of them, so the two do not add up to the limit.
      quota: {
        dayBoundary: "UTC",
        remainingRequestsToday: REQUEST_LIMIT - 5,
        remainingMicroUsdToday: MICRO_USD_LIMIT - 2100,
      },
    });

    // Cut in UTC instead, "today" is 3 October and holds exactly what the quota counted.
    const utc = await report(narrowToken, "lora-of", "date=2026-10-03&timeZone=UTC");
    expect(utc.timeZone).toBe("UTC");
    expect(utc.days).toHaveLength(1);
    expect(utc.days[0]).toMatchObject({
      date: "2026-10-03",
      from: "2026-10-03T00:00:00.000Z",
      toExclusive: "2026-10-04T00:00:00.000Z",
      coverage: "partial",
      coverageReasons: ["day_open", "open_reservations"],
      totals: totals({
        requestCount: 5, costMicroUsd: 2100, tokens: [1900, 110, 0, 0], completed: 2, cancelled: 1, quotaDenied: 1, openReservations: 1,
      }),
    });
    expect(utc.quota).toEqual(body.quota);

    // The defaults: one day, the cabinet's zone.
    const today = await report(narrowToken, "lora-of", "date=2026-10-04");
    expect(today.timeZone).toBe("Europe/Moscow");
    expect(today.days).toEqual([body.days[2]]);

    // A read: the ledger is as it was, and nothing left the process.
    expect(await ledgerRowCount()).toBe(rowsBefore);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("an owner reads only the owner's own spend, a chatter never a colleague's", async (context) => {
    if (!server) return context.skip();
    await switchExtensionOn();

    await seed(grishaId, "lora-of", [{ at: "2026-10-03T10:00:00.000Z", cost: 1000 }]);
    await seed(nikitaId, "lora-of", [
      { at: "2026-10-03T10:00:00.000Z", cost: 20_000 },
      { at: "2026-10-03T11:00:00.000Z", cost: 30_000 },
    ]);
    await seed(ownerId, "lora-of", [{ at: "2026-10-03T12:00:00.000Z", cost: 5000 }]);

    const cases = [
      { who: "owner", token: ownerToken, userId: ownerId, requestCount: 1, costMicroUsd: 5000 },
      { who: "grisha, narrow token", token: narrowToken, userId: grishaId, requestCount: 1, costMicroUsd: 1000 },
      { who: "grisha, full token", token: fullToken, userId: grishaId, requestCount: 1, costMicroUsd: 1000 },
      { who: "nikita", token: nikitaToken, userId: nikitaId, requestCount: 2, costMicroUsd: 50_000 },
    ];
    for (const testCase of cases) {
      const body = await report(testCase.token, "lora-of", "date=2026-10-03");
      expect(body.scope, testCase.who).toEqual({ pageLabel: "lora-of", userId: testCase.userId });
      expect(body.days[0]!.totals, testCase.who).toMatchObject({
        requestCount: testCase.requestCount,
        costMicroUsd: testCase.costMicroUsd,
      });
      // The quota is the caller's own on this page too.
      expect(body.quota?.remainingMicroUsdToday, testCase.who).toBe(MICRO_USD_LIMIT - testCase.costMicroUsd);
    }

    // The owner is granted every page, and still reads only the owner's rows there.
    const elsewhere = await report(ownerToken, "mia-of", "date=2026-10-03");
    expect(elsewhere.scope).toEqual({ pageLabel: "mia-of", userId: ownerId });
    expect(elsewhere.days[0]!.totals).toEqual(totals());
    expect(elsewhere.days[0]!.features).toEqual([]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("marks a day partial while its numbers may still move or are an estimate", async (context) => {
    if (!server) return context.skip();
    await switchExtensionOn();

    // 2 October: over, and one cost in it is the hub's estimate.
    await seed(grishaId, "lora-of", [
      { at: "2026-10-02T10:00:00.000Z", cost: 1200, approximate: true },
      { at: "2026-10-02T11:00:00.000Z", feature: "ping", cost: 300 },
    ]);
    // 3 October: over, but a generation that started in its last minute has no outcome yet.
    const reservation = {
      clientEventId: "late-generation",
      feature: "fast-reply" as const,
      model: "anthropic:claude-test",
      pageId: pageIds["lora-of"]!,
      provider: "anthropic" as const,
      isRegeneration: false,
      reservedAt: new Date("2026-10-03T20:59:30.000Z"),
    };
    expect(await reserveAiGatewayUsageEvent(app.db, { userId: grishaId, event: reservation })).toBe(true);

    const open = await report(narrowToken, "lora-of", "date=2026-10-04&days=3");
    expect(open.days.map((day) => [day.date, day.coverage, day.coverageReasons])).toEqual([
      ["2026-10-02", "partial", ["approximate_cost"]],
      ["2026-10-03", "partial", ["open_reservations"]],
      ["2026-10-04", "partial", ["day_open"]],
    ]);
    expect(open.days[0]!.totals).toMatchObject({ requestCount: 2, costMicroUsd: 1500, costApproximate: true });
    // The estimate is flagged on its own feature only.
    expect(open.days[0]!.features.map((row) => [row.feature, row.costApproximate])).toEqual([
      ["fast-reply", true],
      ["ping", false],
    ]);
    expect(open.days[1]!.totals).toEqual(totals({ requestCount: 1, openReservations: 1 }));

    // The generation finishes after midnight: its row, now with a cost, belongs
    // to the day it finished in, and the day it started in closes empty.
    const finalized = await finalizeAiGatewayUsageEvent(app.db, {
      userId: grishaId,
      event: {
        clientEventId: reservation.clientEventId,
        providerResponseId: "msg_late",
        inputTokens: 800,
        outputTokens: 70,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costMicroUsd: 950,
        costApproximate: false,
        gatewayOutcome: "completed",
        durationMs: 35_000,
        isCacheHit: false,
        completedAt: new Date("2026-10-03T21:00:05.000Z"),
      },
    });
    expect(finalized).not.toBeNull();

    const settled = await report(narrowToken, "lora-of", "date=2026-10-04&days=2");
    expect(settled.days[0]).toMatchObject({ date: "2026-10-03", coverage: "complete", coverageReasons: [], totals: totals(), features: [] });
    expect(settled.days[1]).toMatchObject({
      date: "2026-10-04",
      coverage: "partial",
      coverageReasons: ["day_open"],
      totals: totals({ requestCount: 1, costMicroUsd: 950, tokens: [800, 70, 0, 0], completed: 1 }),
    });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("cuts days at the named zone's own midnights, a 25-hour day included", async (context) => {
    if (!server) return context.skip();
    await switchExtensionOn();
    // New York leaves summer time on 1 November 2026: that day is 25 hours long.
    vi.setSystemTime(new Date("2026-11-02T12:00:00.000Z"));

    await seed(grishaId, "lora-of", [
      { at: "2026-11-01T03:59:59.999Z", cost: 100 },
      { at: "2026-11-01T04:00:00.000Z", cost: 20 },
      // The 25th hour: past 04:00Z of the next day, and still 1 November in New York.
      { at: "2026-11-02T04:30:00.000Z", cost: 3 },
      { at: "2026-11-02T05:00:00.000Z", cost: 4000 },
    ]);

    const body = await report(narrowToken, "lora-of", "date=2026-11-01&days=2&timeZone=America/New_York");
    expect(body.timeZone).toBe("America/New_York");
    expect(body.days.map((day) => [day.date, day.from, day.toExclusive, day.coverage, day.totals.costMicroUsd])).toEqual([
      ["2026-10-31", "2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z", "complete", 100],
      ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", "complete", 23],
    ]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes 1 to 7 days ending no later than today and no earlier than 8 days back, in the report zone", async (context) => {
    if (!server) return context.skip();
    await switchExtensionOn();
    await seed(grishaId, "lora-of", [{ at: "2026-09-22T09:00:00.000Z", cost: 4200 }]);

    // Today in Moscow is 4 October; 26 September is 8 days back, the oldest `date`.
    const week = await report(narrowToken, "lora-of", "date=2026-09-26&days=7");
    expect(week.days.map((day) => day.date)).toEqual([
      "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26",
    ]);
    // Every day is listed, the empty ones with zeros; each starts where the previous one ends.
    expect(week.days.map((day) => day.totals.costMicroUsd)).toEqual([0, 0, 4200, 0, 0, 0, 0]);
    expect(week.days.every((day) => day.coverage === "complete" && day.coverageReasons.length === 0)).toBe(true);
    for (let index = 1; index < week.days.length; index += 1) {
      expect(week.days[index]!.from).toBe(week.days[index - 1]!.toExclusive);
    }

    expectRefused(await usage(narrowToken, "lora-of", "date=2026-09-25"), 400, "bad_request", "date_too_old");
    expectRefused(await usage(narrowToken, "lora-of", "date=2026-10-05"), 400, "bad_request", "date_in_future");
    // "Today" is the report zone's: 4 October has begun in Moscow, not yet in UTC or New York.
    expect((await usage(narrowToken, "lora-of", "date=2026-10-04")).statusCode).toBe(200);
    expectRefused(await usage(narrowToken, "lora-of", "date=2026-10-04&timeZone=UTC"), 400, "bad_request", "date_in_future");
    expectRefused(
      await usage(narrowToken, "lora-of", "date=2026-10-04&timeZone=America/New_York"), 400, "bad_request", "date_in_future",
    );
    expectRefused(await usage(narrowToken, "lora-of", "date=2026-10-03&timeZone=Mars/Olympus"), 400, "bad_request", "unknown_time_zone");

    // The request schema's own refusals (the validation envelope, no reason).
    for (const query of [
      "",
      "date=2026-02-30",
      "date=2026-10-03&days=0",
      "date=2026-10-03&days=8",
      "date=2026-10-03&days=two",
      // The page is the path's; a page or a user in the query is refused, not ignored.
      "date=2026-10-03&pageLabel=mia-of",
      `date=2026-10-03&userId=${nikitaId}`,
    ]) {
      const response = await usage(narrowToken, "lora-of", query);
      expect(response.statusCode, `${query}: ${response.body}`).toBe(400);
      expect(errorResponseSchema.safeParse(response.json()).success, query).toBe(true);
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("is off until the owner switches the extension on, and refuses an outdated extension", async (context) => {
    if (!server) return context.skip();
    await seed(grishaId, "lora-of", [{ at: "2026-10-03T10:00:00.000Z", cost: 1000 }]);

    // At rest (what a merge leaves): every caller is refused, whatever the query.
    for (const token of [narrowToken, fullToken, ownerToken]) {
      expectRefused(await usage(token, "lora-of", "date=2026-10-03"), 409, "client_feature_disabled", "disabled");
    }
    expectRefused(await usage(narrowToken, "lora-of", "date=2030-01-01"), 409, "client_feature_disabled", "disabled");
    // The bootstrap still announces what the hub serves; the switch is checked on the call.
    const bootstrap = await server.inject({
      method: "GET",
      url: "/api/v1/client/bootstrap",
      headers: { authorization: `Bearer ${narrowToken}` },
    });
    expect(clientBootstrapResponseSchema.parse(bootstrap.json()).capabilities).toContain("ai-usage-v1");

    await patchConfig([
      { key: "chatExtensionEnabled", value: true },
      { key: "chatExtensionMinVersion", value: "1.2.0" },
    ]);
    expect((await usage(narrowToken, "lora-of", "date=2026-10-03", { clientVersion: "chat-extension/1.2.0" })).statusCode).toBe(200);
    for (const clientVersion of ["chat-extension/1.1.9", "chatgoose-extension/2.7.1", "0.1.64", "chat-extension/1.2", null]) {
      expectRefused(
        await usage(narrowToken, "lora-of", "date=2026-10-03", { clientVersion }),
        409, "client_feature_disabled", "client_outdated",
      );
    }

    // The route has no flag of its own, so no flag, platform or binding is asked
    // for: a Fansly page and a page the extension cannot bind answer too.
    for (const label of ["lora-fansly", "nova-of"]) {
      const body = await report(narrowToken, label, "date=2026-10-03");
      expect(body.scope).toEqual({ pageLabel: label, userId: grishaId });
    }

    // No cache: the owner's off holds from the very next request.
    await patchConfig([{ key: "chatExtensionEnabled", value: false }]);
    expectRefused(await usage(narrowToken, "lora-of", "date=2026-10-03"), 409, "client_feature_disabled", "disabled");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reports no quota while the hub's AI gateway is off", async (context) => {
    if (!server) return context.skip();
    await switchExtensionOn();
    await seed(grishaId, "lora-of", [{ at: "2026-10-03T10:00:00.000Z", cost: 1000 }]);

    app.config.chatMuseAiGatewayEnabled = false;
    const body = await report(narrowToken, "lora-of", "date=2026-10-03");
    expect(body.quota).toBeNull();
    // The spend already in the ledger is still reported.
    expect(body.days[0]!.totals).toMatchObject({ requestCount: 1, costMicroUsd: 1000 });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds its rights-matrix row in both auth-policy modes: device tokens on a granted page only", async (context) => {
    if (!server || !enforceServer) return context.skip();
    await switchExtensionOn();

    const chatterLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "grisha", password: PASSWORDS.grisha },
    });
    expect(chatterLogin.statusCode, chatterLogin.body).toBe(200);
    const chatterHeader = chatterLogin.headers["set-cookie"];
    const chatterCookie = (Array.isArray(chatterHeader) ? chatterHeader[0] : chatterHeader)!.split(";")[0]!;

    interface Refusal { status: number; error: string; reason?: string }
    const cases: Array<{
      who: string;
      page: string;
      headers: Record<string, string>;
      /** 200, or the refusal; where the two layers answer differently, one per mode. */
      expected: 200 | Refusal | { log: Refusal; enforce: Refusal };
    }> = [
      { who: "anonymous", page: "lora-of", headers: {}, expected: { status: 401, error: "unauthorized" } },
      {
        who: "unknown bearer", page: "lora-of",
        headers: { authorization: "Bearer agency_hub_device_not-a-real-token" },
        expected: { status: 401, error: "unauthorized" },
      },
      { who: "owner cookie", page: "lora-of", headers: { cookie: ownerCookie }, expected: { status: 403, error: "forbidden" } },
      { who: "chatter cookie", page: "lora-of", headers: { cookie: chatterCookie }, expected: { status: 403, error: "forbidden" } },
      // Live and granted lora-of: refused by kind, before any page is looked at.
      {
        who: "agent key", page: "lora-of",
        headers: { authorization: `Bearer ${AGENT_KEY_TOKEN}` },
        expected: { status: 403, error: "forbidden" },
      },
      { who: "owner device token", page: "mia-of", headers: { authorization: `Bearer ${ownerToken}` }, expected: 200 },
      { who: "chatter narrow token", page: "lora-of", headers: { authorization: `Bearer ${narrowToken}` }, expected: 200 },
      { who: "chatter full token", page: "lora-of", headers: { authorization: `Bearer ${fullToken}` }, expected: 200 },
      // A page of someone else, a tombstone and a page that never existed: the
      // handler's own guard answers all three alike and reveals nothing; the
      // declared policy answers 403 / 404 before the handler runs.
      {
        who: "chatter, a page not granted", page: "mia-of",
        headers: { authorization: `Bearer ${narrowToken}` },
        expected: {
          log: { status: 409, error: "client_feature_disabled", reason: "not_granted" },
          enforce: { status: 403, error: "forbidden" },
        },
      },
      {
        who: "chatter, a tombstoned page", page: "lora-old-of",
        headers: { authorization: `Bearer ${narrowToken}` },
        expected: {
          log: { status: 409, error: "client_feature_disabled", reason: "not_granted" },
          enforce: { status: 404, error: "not_found" },
        },
      },
      {
        who: "chatter, a page that does not exist", page: "ghost-of",
        headers: { authorization: `Bearer ${narrowToken}` },
        expected: {
          log: { status: 409, error: "client_feature_disabled", reason: "not_granted" },
          enforce: { status: 404, error: "not_found" },
        },
      },
    ];

    for (const [mode, via] of [["log", server], ["enforce", enforceServer]] as const) {
      for (const testCase of cases) {
        const label = `${mode} mode, ${testCase.who}`;
        const response = await via.inject({
          method: "GET",
          url: `/api/v1/client/pages/${testCase.page}/ai-usage?date=2026-10-03`,
          headers: { "x-client-version": EXTENSION_VERSION, ...testCase.headers },
        });
        if (testCase.expected === 200) {
          expect(response.statusCode, `${label}: ${response.body}`).toBe(200);
          clientAiUsageResponseSchema.parse(response.json());
          continue;
        }
        const expected = "log" in testCase.expected ? testCase.expected[mode] : testCase.expected;
        expect(response.statusCode, `${label}: ${response.body}`).toBe(expected.status);
        // Every refusal is the declared error body, so the SDK raises a typed error.
        const error = errorResponseSchema.parse(response.json());
        expect(error, label).toMatchObject({ error: expected.error, statusCode: expected.status });
        expect(error.reason, label).toBe(expected.reason);
      }
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the query counts each ledger row once, in the day window it falls in", async (context) => {
    if (!testDb) return context.skip();

    await seed(grishaId, "lora-of", [
      { at: "2026-10-01T23:59:59.999Z", cost: 1 },
      { at: "2026-10-02T00:00:00.000Z", cost: 10 },
      { at: "2026-10-02T23:59:59.999Z", feature: "ping", cost: 100 },
      { at: "2026-10-03T00:00:00.000Z", feature: "ping", cost: 1000, approximate: true },
      { at: "2026-10-03T12:00:00.000Z", feature: "coach-chat", outcome: "open" },
      { at: "2026-10-04T00:00:00.000Z", cost: 10_000 },
    ]);
    await seed(nikitaId, "lora-of", [{ at: "2026-10-02T12:00:00.000Z", cost: 7 }]);
    await seed(grishaId, "lora-fansly", [{ at: "2026-10-02T12:00:00.000Z", cost: 70 }]);

    const rows = await listUserPageDailyUsage(app.db, {
      userId: grishaId,
      pageId: pageIds["lora-of"]!,
      dayStarts: [new Date("2026-10-02T00:00:00.000Z"), new Date("2026-10-03T00:00:00.000Z")],
      toExclusive: new Date("2026-10-04T00:00:00.000Z"),
    });

    // By day, then by feature name; only groups that have rows.
    expect(rows.map((row) => [row.dayIndex, row.feature, row.requestCount, row.costMicroUsd, row.costApproximate, row.openReservationCount]))
      .toEqual([
        [0, "fast-reply", 1, 10, false, 0],
        [0, "ping", 1, 100, false, 0],
        [1, "coach-chat", 1, 0, false, 1],
        [1, "ping", 1, 1000, true, 0],
      ]);
    expect(await listUserPageDailyUsage(app.db, {
      userId: grishaId,
      pageId: pageIds["lora-of"]!,
      dayStarts: [],
      toExclusive: new Date("2026-10-04T00:00:00.000Z"),
    })).toEqual([]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
