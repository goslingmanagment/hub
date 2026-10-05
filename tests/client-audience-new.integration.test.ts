import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  clientAudienceNewResponseSchema,
  clientBootstrapResponseSchema,
  clientFanClaimResponseSchema,
  errorResponseSchema,
  type ClientAudienceNewItem,
  type ClientAudienceNewResponse,
} from "@agency_hub_core/contracts";
import {
  appendDomainEvents,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertAgentKey,
  saveOfapiReadSnapshot,
  supersessionDedupKey,
  upsertOfapiWebhookConfig,
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
import { canonicalizeOfapiWebhookObservation } from "../apps/runtime/src/services/canonicalize/ofapi-webhook.ts";
import {
  CLIENT_AUDIENCE_NEW_CURSOR_DOMAIN,
  CLIENT_AUDIENCE_NEW_CURSOR_TTL_MS,
} from "../apps/runtime/src/services/client-audience-new.ts";
import { OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS } from "../apps/runtime/src/services/ofapi-delivery-history-signal.ts";
import {
  OFAPI_WELCOME_TEMPLATE_OPERATION,
  ofapiWelcomeTemplateFacts,
} from "../apps/runtime/src/services/ofapi-welcome-template.ts";
import { encodeSignedCursor, signedCursorKeyRing } from "../apps/runtime/src/services/signed-cursor.ts";
import { frozenAudienceNewPageSchema, frozenAudienceNewQuerySchema } from "./helpers/client-audience-new-frozen.ts";
import { frozenClaimBodySchema, frozenErrorBodySchema } from "./helpers/client-claim-frozen.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension H-7c: GET /api/v1/client/pages/:pageLabel/audience-new, the
// "new subscribers" list of one OnlyFans page. The rules as pure functions are
// tests/client-audience-new.test.ts and the shapes
// tests/client-audience-new-contract.test.ts; this file holds them over real
// rows: the subscription events come out of the real webhook canonicalizer,
// and every 200 is parsed by the hub's schema and by the client's frozen one.
// Every test runs under the no-outbound trap: the route reads the database and
// nothing else (critic item 8).

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = {
  owner: "owner-secret", lead: "lead-secret", grisha: "grisha-secret", nikita: "nikita-secret",
} as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** A live Agent Read Plane key, granted lora-of: its refusal is about the principal kind, not a page. */
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}clientaudience000000`;
/** The pages' own OnlyFans account ids (`pages.external_page_id`). */
const CREATORS = { "lora-of": "100000001", "mia-of": "100000003" } as const;
const WEBHOOK = "wh_audience_test";
/** Client installs: grisha's and nikita's. */
const I1 = randomUUID();
const I3 = randomUUID();
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type OfPage = keyof typeof CREATORS;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
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
let fanSeq = 710_000_000;
let observationSeq = 5_000;
const nextFan = () => String(++fanSeq);

/** OnlyFans stamps a subscription notification to the whole minute. */
const minutesAgo = (minutes: number) => new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS - minutes * MINUTE_MS);

const query = <Row extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  testDb!.pool.query<Row>(text, values).then((result) => result.rows);

function bearer(token: string, clientVersion: string | null = EXTENSION_VERSION): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(clientVersion === null ? {} : { "x-client-version": clientVersion }) };
}

interface ListInput {
  pageLabel?: string;
  windowHours?: number;
  limit?: number;
  cursor?: string;
  /** A raw query string, for a request the client's schema would not let out. */
  raw?: string;
  clientVersion?: string | null;
}

function list(token: string, input: ListInput = {}) {
  const pageLabel = input.pageLabel ?? "lora-of";
  let search = input.raw;
  if (search === undefined) {
    const asked = {
      windowHours: input.windowHours ?? 48,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    };
    // As the extension asks: only what its own schema lets out.
    expect(frozenAudienceNewQuerySchema.safeParse({ pageLabel, ...asked }).success, JSON.stringify(asked)).toBe(true);
    search = `?${new URLSearchParams(Object.entries(asked).map(([key, value]) => [key, String(value)])).toString()}`;
  }
  return server!.inject({
    method: "GET",
    url: `/api/v1/client/pages/${pageLabel}/audience-new${search}`,
    headers: bearer(token, input.clientVersion),
  });
}

/** A 200 whose body is the declared shape, the client's frozen shape, and nothing more. */
async function listOk(token: string, input: ListInput = {}): Promise<ClientAudienceNewResponse> {
  const response = await list(token, input);
  expect(response.statusCode, response.body).toBe(200);
  const body = clientAudienceNewResponseSchema.parse(response.json());
  // Neither schema is strict; nothing was stripped by either.
  expect(response.json()).toEqual(body);
  expect(frozenAudienceNewPageSchema.parse(response.json())).toEqual(body);
  // Nobody of the team is ever named: not the holder of a lease, not who greeted.
  expect(response.body).not.toMatch(/grisha|nikita|userId/i);
  return body;
}

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode });
  expect(body.reason, response.body).toBe(reason);
  expect(frozenErrorBodySchema.safeParse(response.json()).success, response.body).toBe(true);
}

const refs = (body: ClientAudienceNewResponse) => body.items.map((row) => row.eventRef);
const rowOf = (body: ClientAudienceNewResponse, fan: string): ClientAudienceNewItem => {
  const row = body.items.find((entry) => entry.fanRef === fan);
  expect(row, `row of fan ${fan}`).toBeDefined();
  return row!;
};

async function patchConfig(patches: Array<{ key: string; value: unknown }>) {
  const response = await server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: ownerCookie },
    payload: { patches },
  });
  expect(response.statusCode, response.body).toBe(200);
}

const features = (flags: Record<string, boolean>, pages: Record<string, Record<string, boolean>> = {}) =>
  ({ key: "chatExtensionFeatures", value: JSON.stringify({ "*": flags, ...pages }) });

/** The owner's switches as a pilot page has them: the extension and the list on. */
async function switchOn(flags: Record<string, boolean> = { newcomers: true }) {
  await patchConfig([{ key: "chatExtensionEnabled", value: true }, features(flags)]);
}

/**
 * One subscription notification as the hub records it: the journaled webhook
 * envelope through the real canonicalizer into the events ledger. The live
 * envelope names the creator in `user_id` and the subscriber in `user`.
 */
async function notify(input: {
  fan: string;
  at: Date;
  subType?: string | null;
  kind?: "subscriptions.new" | "subscriptions.renewed" | "subscriptions.expired";
  page?: OfPage;
}): Promise<string> {
  const page = input.page ?? "lora-of";
  const kind = input.kind ?? "subscriptions.new";
  const observationId = ++observationSeq;
  const drafts = canonicalizeOfapiWebhookObservation({
    id: observationId,
    source: "webhook",
    producer: "ofapi",
    platform: "onlyfans",
    accountId: pageIds[page]!,
    kind,
    payload: {
      event: kind,
      account_id: "acct_audience_test",
      payload: {
        id: String(1_000_000 + observationId),
        type: "subscribed",
        createdAt: input.at.toISOString(),
        ...(kind === "subscriptions.expired" ? { expiredAt: input.at.toISOString() } : {}),
        ...(input.subType === null ? {} : { subType: input.subType ?? "new_subscriber" }),
        user_id: CREATORS[page],
        user: { id: Number(input.fan), name: `Fan ${input.fan}`, username: `fan${input.fan}` },
      },
    },
    observedAt: null,
    receivedAt: new Date(),
  });
  expect(drafts, kind).toHaveLength(1);
  return appendEvent(page, { ...drafts[0]!, observationId });
}

/** An event written straight into the ledger: one no live webhook would canonicalize to today. */
async function appendEvent(page: OfPage, event: Parameters<typeof appendDomainEvents>[2][number]): Promise<string> {
  const result = await appendDomainEvents(app.db, pageIds[page]!, [event]);
  expect(result.appended).toBe(1);
  return String(result.events[0]!.eventId);
}

/** The fan as the hub knows them: the fan record, and their record on the page. */
async function seedFan(fan: string, input: {
  username?: string | null;
  displayName?: string | null;
  /** `page_fans.is_subscriber`; `undefined` leaves the page without a record of the fan. */
  isSubscriber?: boolean;
  page?: OfPage;
} = {}): Promise<number> {
  const [row] = await query<{ id: string }>(
    "insert into fans (platform, platform_user_id, username, display_name) values ('onlyfans', $1, $2, $3) returning id::text",
    [fan, input.username ?? null, input.displayName ?? null],
  );
  if (input.isSubscriber !== undefined) {
    await query(
      "insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, $3)",
      [row!.id, pageIds[input.page ?? "lora-of"], input.isSubscriber],
    );
  }
  return Number(row!.id);
}

/** A subscription row as one of its two writers leaves it (the webhook projection, the subscriber sweep). */
async function seedSubscription(fan: string, fanId: number, input: {
  isCurrent?: boolean;
  canonicalStatus?: string;
  generation?: number | null;
  startedAt?: Date | null;
  endsAt?: Date | null;
  seenAt?: Date;
}) {
  await query(
    `insert into page_subscriptions (platform_subscription_id, platform_account_id, fan_id, raw_status, canonical_status,
       price_mills, renew_price_mills, source_created_at, source_updated_at, ends_at, is_current, last_seen_generation,
       last_seen_at)
     values ($1, $2, $3, 0, $4, 0, 0, $5, $5, $6, $7, $8, $9)`,
    [fan, pageIds["lora-of"], fanId, input.canonicalStatus ?? "active", input.startedAt ?? null, input.endsAt ?? null,
      input.isCurrent ?? true, input.generation ?? null, input.seenAt ?? new Date()],
  );
}

async function seedThread(fan: string, input: {
  count?: number;
  lastAt?: Date | null;
  lastFanAt?: Date | null;
  lastModelAt?: Date | null;
  coverage?: string;
  backfillComplete?: boolean;
  partnerUsername?: string | null;
  partnerDisplayName?: string | null;
  unread?: number;
  historyState?: string;
} = {}) {
  await query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id,
       partner_username, partner_display_name, unread_count, last_message_at, last_fan_message_at,
       last_model_message_at, stored_message_count, message_coverage_status, message_backfill_complete, history_state)
     values ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [pageIds["lora-of"], fan, input.partnerUsername ?? null, input.partnerDisplayName ?? null, input.unread ?? 0,
      input.lastAt ?? null, input.lastFanAt ?? null, input.lastModelAt ?? null, input.count ?? 0,
      input.coverage ?? "pending_backfill", input.backfillComplete ?? false, input.historyState ?? "none"],
  );
}

/** The page's subscriber-sweep checkpoint, as the OFAPI audience sweep writes it. */
async function seedSweep(input: {
  generation?: number;
  completedAt?: Date | null;
  startedAt?: Date | null;
  unverifiedAt?: Date | null;
  page?: OfPage;
} = {}) {
  const state = {
    version: 1,
    mode: "ofapi_audience",
    generation: input.generation ?? 91,
    offset: 0,
    pageCount: 3,
    observedFans: 240,
    sweepStartedAt: input.startedAt?.toISOString() ?? null,
    lastSweepCompletedAt: input.completedAt === undefined ? minutesAgo(600).toISOString() : input.completedAt?.toISOString() ?? null,
    lastSweepUnverifiedAt: input.unverifiedAt?.toISOString() ?? null,
  };
  await query(
    `insert into page_sync_cursors (page_id, stream, state) values ($1, 'subscribers', $2::jsonb)
     on conflict (page_id, stream) do update set state = excluded.state`,
    [pageIds[input.page ?? "lora-of"], JSON.stringify(state)],
  );
}

/** The provider's webhook delivery history is collected: the policy is on and a webhook is registered. */
async function collectDeliveryHistory() {
  await upsertOfapiWebhookConfig(app.db, {
    externalWebhookId: WEBHOOK,
    endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook",
    accountScope: "global",
    events: ["subscriptions.new"],
    encryptedSigningSecret: "{}",
  });
  await query("update ofapi_webhook_collection_policy set history_enabled = true, updated_at = now()");
}

/** One window of the delivery history; a complete one moves the frontier to its end. */
async function seedDeliveryScan(endsAt: Date, state: "complete" | "pending" | "failed" = "complete") {
  await query(
    `insert into ofapi_webhook_delivery_scans (id, webhook_id, credential_fingerprint, observed_team, window_start,
       window_end, state, completed_at)
     values ($1, $2, 'test-fingerprint', 'test-team', $3, $4, $5, case when $5 = 'complete' then now() end)`,
    [randomUUID(), WEBHOOK, new Date(endsAt.getTime() - HOUR_MS), endsAt, state],
  );
}

/** Everything the hub can vouch with: a current delivery history and a completed sweep. */
async function healthyCollectors() {
  await collectDeliveryHistory();
  await seedDeliveryScan(minutesAgo(5));
  await seedSweep();
}

/** A journaled webhook as the receiver leaves it for the projections. */
async function seedWebhookRow(input: {
  eventType: string;
  projection: "pending" | "failed" | "projected" | "skipped" | "none";
  receivedAt: Date;
  page?: OfPage;
}) {
  await query(
    `insert into ofapi_webhook_events (idempotency_key, event_type, ofapi_account_id, platform_account_id, payload,
       status, projection_status, received_at)
     values ($1, $2, 'acct_audience_test', $3, '{}'::jsonb, 'processed', $4, $5)`,
    [`evt_${randomUUID()}`, input.eventType, pageIds[input.page ?? "lora-of"], input.projection, input.receivedAt],
  );
}

/** A desktop new-follower command of the hub's outbox to this fan. */
async function seedDesktopCommand(fan: string, state: string, attempts: number, verifier: unknown) {
  await query(
    `insert into ofapi_commands (id, client_command_id, page_id, chatter_user_id, ofapi_account_id, conversation_id,
       outreach_purpose, kind, payload, payload_hash, state, attempt_count, verifier_result, platform_message_id,
       attempt_finished_at, dedupe_expires_at)
     values ($1, $2, $3, $4, 'acct_audience', $5, 'new-follower', 'send_text_message_v1', '{}'::jsonb, $6, $7, $8, $9,
       $10, $11, now() + interval '1 day')`,
    [randomUUID(), randomUUID(), pageIds["lora-of"], userIds.nikita, fan, "a".repeat(64), state, attempts,
      verifier === null ? null : JSON.stringify(verifier),
      state === "confirmed" ? "9001" : null, state === "confirmed" ? new Date("2026-09-21T10:00:00Z") : null],
  );
}

const claimUrl = (fan: string) => `/api/v1/client/pages/lora-of/fans/${fan}/claim`;

/** One action of the claim route, as the extension's own schema lets it out. */
async function act(token: string, fan: string, body: Record<string, unknown>) {
  expect(frozenClaimBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
  const response = await server!.inject({ method: "POST", url: claimUrl(fan), headers: bearer(token), payload: body });
  expect(response.statusCode, response.body).toBe(200);
  return clientFanClaimResponseSchema.parse(response.json());
}

/** The claim status read of one fan, reduced as a list row carries it. */
async function claimSummary(token: string, fan: string) {
  const response = await server!.inject({ method: "GET", url: claimUrl(fan), headers: bearer(token) });
  expect(response.statusCode, response.body).toBe(200);
  const status = clientFanClaimResponseSchema.parse(response.json());
  return {
    greeting: status.greeting.state,
    lease: status.lease.state,
    heldBy: status.lease.heldBy,
    custody: status.custody?.state ?? null,
  };
}

const claimBody = (instanceId: string, leaseToken: string = randomUUID()) => ({ action: "claim", leaseToken, instanceId });
const dispatchBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: "dispatch", attemptId: randomUUID(), instanceId: I1, purpose: "greeting",
  group: { generationRef: randomUUID(), variant: 0, partCount: 1 }, partIndex: 0, textRevision: 1, flagRevision: 0, ...over,
});

/** A lease of grisha's install on the fan, then the greeting dispatched under it. */
async function dispatchGreeting(fan: string): Promise<string> {
  const leaseToken = randomUUID();
  await act(grishaToken, fan, claimBody(I1, leaseToken));
  const body = dispatchBody({ leaseToken });
  await act(grishaToken, fan, body);
  return body.attemptId as string;
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

/** The fixtures above are the hub's own rows (chats, the desktop's commands); the trap counts from here. */
async function rearm() {
  await trap!.restore();
  trap = await armNoOutboundTrap(testDb!);
}

/** A cursor signed with this hub's keys for the list's domain: what a walk of `scope` would carry. */
function mintCursor(input: {
  scope: { pageId: number; userId: number };
  state: unknown;
  issuedAt?: Date;
  domain?: string;
}): string {
  return encodeSignedCursor(
    { domain: input.domain ?? CLIENT_AUDIENCE_NEW_CURSOR_DOMAIN, state: z.unknown() },
    { scope: input.scope, state: input.state, now: input.issuedAt ?? new Date() },
    signedCursorKeyRing(app.config),
  );
}

describe("GET /api/v1/client/pages/:pageLabel/audience-new", () => {
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
    for (const [label, account] of Object.entries(CREATORS)) {
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

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: userIds.owner, label: "owner client" })).token;
    leadToken = (await issueDeviceTokenForUserId(app, { userId: userIds.lead, label: "lead client" })).token;
    svetaToken = (await issueDeviceTokenForUserId(app, { userId: userIds.sveta, label: "sveta client" })).token;
    grishaFullToken = (await issueDeviceTokenForUserId(app, { userId: userIds.grisha, label: "grisha desktop" })).token;
    await insertAgentKey(app.db, {
      name: "client-audience-probe",
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
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    // Every test starts from an empty page with the switches at rest and no collector state.
    await testDb.pool.query(`
      delete from client_send_custody;
      delete from client_greetings;
      delete from client_fan_leases;
      delete from ofapi_commands;
      delete from domain_event_keys;
      delete from domain_events;
      delete from page_subscriptions;
      delete from page_dm_threads;
      delete from page_fans;
      delete from fans;
      delete from ofapi_webhook_events;
      delete from page_sync_cursors;
      delete from ofapi_read_snapshots;
      delete from ofapi_webhook_delivery_scans;
      delete from ofapi_webhook_config;
      update ofapi_webhook_collection_policy set history_enabled = false;
      delete from config_settings where key like 'chatExtension%';
    `);
    // A chat with unread messages, so the trap's unread check has something to hold.
    await seedThread("700000001", { unread: 3, count: 3 });
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

  it("is inert at merge: off until the owner switches the list on, then the owner's switches decide", async () => {
    const fan = nextFan();
    await notify({ fan, at: minutesAgo(3) });
    const newcomers = async () => {
      const bootstrap = await server!.inject({ method: "GET", url: "/api/v1/client/bootstrap", headers: bearer(grishaToken) });
      const announced = clientBootstrapResponseSchema.parse(bootstrap.json());
      // The hub serves both halves of the feature: the claim routes (H-7b) and this list.
      expect(announced.capabilities).toEqual(expect.arrayContaining(["audience-new-v1", "preview-send-custody-v1"]));
      expect(announced.limits.audienceWindowHours).toBe(720);
      return Object.fromEntries(announced.pages.map((page) => [page.pageLabel, page.features.newcomers]));
    };

    // The hub as it rests: nothing is served until the owner says so.
    for (const token of [grishaToken, grishaFullToken, ownerToken]) {
      const refused = await list(token);
      expectRefused(refused, 409, "client_feature_disabled", "disabled");
      expect(refused.body).not.toContain(fan);
    }
    expect(await newcomers()).toEqual({
      "lora-of": { available: false, reason: "disabled" },
      "lora-fansly": { available: false, reason: "platform_unsupported" },
    });

    // The master switch alone is not the list's flag.
    await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
    expectRefused(await list(grishaToken), 409, "client_feature_disabled", "flag_off");
    // Sending from the preview is another switch: the list needs only its own.
    await patchConfig([features({ previewSend: true })]);
    expectRefused(await list(grishaToken), 409, "client_feature_disabled", "flag_off");

    await patchConfig([features({ newcomers: true })]);
    expect(await newcomers()).toEqual({
      "lora-of": { available: true },
      "lora-fansly": { available: false, reason: "platform_unsupported" },
    });
    expect(refs(await listOk(grishaToken))).toHaveLength(1);
    // The list exists on OnlyFans only.
    expectRefused(await list(grishaToken, { pageLabel: "lora-fansly" }), 409, "client_feature_disabled", "platform_unsupported");
    // An old client's version, or none, is not the extension: refused, never passed.
    for (const clientVersion of ["chatgoose-extension/2.7.1", "0.1.64", null]) {
      expectRefused(await list(grishaFullToken, { clientVersion }), 409, "client_feature_disabled", "client_outdated");
    }
    await patchConfig([{ key: "chatExtensionMinVersion", value: "1.5.0" }]);
    expectRefused(await list(grishaToken), 409, "client_feature_disabled", "client_outdated");
    await patchConfig([{ key: "chatExtensionMinVersion", value: "1.4.2" }]);
    expect((await list(grishaToken)).statusCode).toBe(200);

    // The page's own flag wins over "*"; the master switch ends everything.
    await patchConfig([features({ newcomers: true }, { "lora-of": { newcomers: false } })]);
    expectRefused(await list(grishaToken), 409, "client_feature_disabled", "flag_off");
    await patchConfig([features({ newcomers: true }), { key: "chatExtensionEnabled", value: false }]);
    expectRefused(await list(grishaToken), 409, "client_feature_disabled", "disabled");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("lists new, trial and returning subscribers; the top-fan award and what it cannot classify are counted, not listed", async () => {
    await switchOn();
    const [fresh, trial, back, awarded, odd, bare, contradictory, gone] = Array.from({ length: 8 }, nextFan);

    const freshRef = await notify({ fan: fresh!, at: minutesAgo(10) });
    const trialRef = await notify({ fan: trial!, at: minutesAgo(20), subType: "new_subscriber_trial" });
    // A fan who came back: the first subscription 20 days ago, the return half an hour ago.
    const firstRef = await notify({ fan: back!, at: minutesAgo(20 * 24 * 60) });
    const backRef = await notify({ fan: back!, at: minutesAgo(30), kind: "subscriptions.renewed", subType: "returning_subscriber" });

    // Not rows. OnlyFans reports the top-fan award as a subscription.
    await notify({ fan: awarded!, at: minutesAgo(40), subType: "customer_award_for_model_top" });
    await notify({ fan: odd!, at: minutesAgo(41), subType: "some_later_sub_type" });
    await notify({ fan: bare!, at: minutesAgo(42), subType: null });
    // A renewed notification that calls itself new is never a row of kind new.
    await notify({ fan: contradictory!, at: minutesAgo(43), kind: "subscriptions.renewed", subType: "new_subscriber" });
    // History: an event keyed to the page's own account names no fan, and neither does a malformed id.
    await appendEvent("lora-of", {
      type: "subscription.started", occurredAt: minutesAgo(44), fanIdentityRef: CREATORS["lora-of"],
      data: { subType: "new_subscriber", notificationId: "legacy-1" }, schemaVersion: 1,
      observationId: ++observationSeq, dedupKey: `sub:started:${CREATORS["lora-of"]}:legacy`,
    });
    await appendEvent("lora-of", {
      type: "subscription.started", occurredAt: minutesAgo(45), fanIdentityRef: "0700",
      data: { subType: "new_subscriber", notificationId: "legacy-2" }, schemaVersion: 1,
      observationId: ++observationSeq, dedupKey: "sub:started:0700:legacy",
    });

    // Neither rows nor counted: an award before the window, an expiry, another page's subscriber,
    // an event a repair superseded.
    await notify({ fan: nextFan(), at: minutesAgo(3 * 24 * 60), subType: "customer_award_for_model_top" });
    await notify({ fan: gone!, at: minutesAgo(46), kind: "subscriptions.expired" });
    await notify({ fan: nextFan(), at: minutesAgo(47), page: "mia-of" });
    const supersededRef = await notify({ fan: nextFan(), at: minutesAgo(48) });
    await query(
      "insert into domain_event_keys (account_id, dedup_key, event_id, occurred_at) values ($1, $2, $3, now())",
      [pageIds["lora-of"], supersessionDedupKey(Number(supersededRef)), 9_000_000_001],
    );

    // The names: the fan record first, the chat's own copy where that has none.
    await seedFan(fresh!, { username: "fresh_fan", displayName: "Fresh Fan" });
    await seedFan(trial!, { username: null, displayName: null });
    await seedThread(trial!, { partnerUsername: "trial_fan", partnerDisplayName: "Trial Fan" });
    await rearm();

    const body = await listOk(grishaToken);
    expect(body.pageLabel).toBe("lora-of");
    expect(refs(body)).toEqual([freshRef, trialRef, backRef]);
    expect(body.items.map((row) => [row.fanRef, row.kind, row.trial])).toEqual([
      [fresh, "new", false],
      [trial, "new", true],
      [back, "returning", false],
    ]);
    expect(body.unknownCount).toBe(6);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((row) => [row.username, row.displayName])).toEqual([
      ["fresh_fan", "Fresh Fan"],
      ["trial_fan", "Trial Fan"],
      [null, null],
    ]);
    // Every date is the notification's own until a sweep has read the subscription.
    expect(body.items.map((row) => [row.subscribedAt, row.subscribedAtSource])).toEqual([
      [minutesAgo(10).toISOString(), "notification"],
      [minutesAgo(20).toISOString(), "notification"],
      [minutesAgo(30).toISOString(), "notification"],
    ]);
    // Nothing else is known of these fans.
    expect(rowOf(body, back!)).toMatchObject({
      status: { isSubscriber: null, subscriptionStatus: "unknown", endsAt: null, asOf: null, source: "none" },
      thread: null,
      claim: { greeting: "none", lease: "none", heldBy: null, custody: null },
    });
    for (const fan of [awarded, odd, bare, contradictory, gone, CREATORS["lora-of"]]) {
      expect(body.items.some((row) => row.fanRef === fan), fan).toBe(false);
    }

    // A wider window: one row per notification, and coming back never rewrites the first subscription.
    const month = await listOk(grishaToken, { windowHours: 720 });
    expect(refs(month)).toEqual([freshRef, trialRef, backRef, firstRef]);
    expect(month.items.filter((row) => row.fanRef === back).map((row) => row.kind)).toEqual(["returning", "new"]);
    // The count is the window's: the award of three days ago is in this one.
    expect(month.unknownCount).toBe(7);
    expect((await listOk(svetaToken, { pageLabel: "mia-of" })).items).toHaveLength(1);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps the window still between pages while new subscriptions arrive", async () => {
    await switchOn();
    const e1 = await notify({ fan: nextFan(), at: minutesAgo(2) });
    const e2 = await notify({ fan: nextFan(), at: minutesAgo(5) });
    // The same minute as e2 (notifications are stamped to the minute): the later event goes first.
    const e3 = await notify({ fan: nextFan(), at: minutesAgo(5) });
    const e4 = await notify({ fan: nextFan(), at: minutesAgo(9) });
    const e5 = await notify({ fan: nextFan(), at: minutesAgo(30) });

    const before = Date.now();
    const first = await listOk(grishaToken, { limit: 2 });
    expect(refs(first)).toEqual([e1, e3]);
    expect(first.nextCursor).not.toBeNull();
    // The walk's window: fixed to the hub's clock at the first page.
    expect(first.window.hours).toBe(48);
    expect(first.window.to).toBe(first.serverNow);
    expect(first.window.snapshotAt).toBe(first.serverNow);
    expect(Date.parse(first.window.to) - Date.parse(first.window.from)).toBe(48 * HOUR_MS);
    expect(Math.abs(Date.parse(first.serverNow) - before)).toBeLessThan(60_000);

    // While the client pages: a new subscriber, a notification that arrives late for a minute
    // already paged past, and an award.
    const late = await notify({ fan: nextFan(), at: minutesAgo(7) });
    const newest = await notify({ fan: nextFan(), at: minutesAgo(0) });
    await notify({ fan: nextFan(), at: minutesAgo(3), subType: "customer_award_for_model_top" });

    const second = await listOk(grishaToken, { limit: 2, cursor: first.nextCursor! });
    expect(refs(second)).toEqual([e2, e4]);
    expect(second.window).toEqual(first.window);
    expect(second.unknownCount).toBe(0);
    expect(Date.parse(second.serverNow)).toBeGreaterThanOrEqual(Date.parse(first.serverNow));
    // A page may be asked for with another size: the position is the cursor's.
    const third = await listOk(grishaToken, { limit: 50, cursor: second.nextCursor! });
    expect(refs(third)).toEqual([e5]);
    expect(third.window).toEqual(first.window);
    expect(third.nextCursor).toBeNull();
    // A cursor reads the same page again: nothing moved under it.
    expect(refs(await listOk(grishaToken, { limit: 2, cursor: first.nextCursor! }))).toEqual([e2, e4]);

    // The next walk from the first page has everything.
    const again = await listOk(grishaToken, { limit: 100 });
    expect(refs(again)).toEqual([newest, e1, e3, e2, late, e4, e5]);
    expect(again.unknownCount).toBe(1);
    expect(Date.parse(again.window.to)).toBeGreaterThan(Date.parse(first.window.to));

    // A walk of exactly one page's worth of rows ends without a cursor.
    await query("delete from domain_event_keys");
    await query("delete from domain_events");
    await notify({ fan: nextFan(), at: minutesAgo(4) });
    await notify({ fan: nextFan(), at: minutesAgo(6) });
    const exact = await listOk(grishaToken, { limit: 2 });
    expect(exact.items).toHaveLength(2);
    expect(exact.nextCursor).toBeNull();

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a cursor serves only its own walk: another window, person, page, a forged or an old one is refused", async () => {
    await switchOn();
    for (const minutes of [2, 4, 6]) {
      await notify({ fan: nextFan(), at: minutesAgo(minutes) });
      await notify({ fan: nextFan(), at: minutesAgo(minutes), page: "mia-of" });
    }
    const first = await listOk(grishaToken, { limit: 1 });
    const cursor = first.nextCursor!;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,2048}$/);
    // Opaque: no page, person or fan is readable in it.
    const readable = Buffer.from(cursor, "base64url").toString("utf8");
    expect(readable).not.toMatch(/pageId|userId|lora|grisha/);

    // The caller's own cursor with another window: told apart, so the client knows to start over.
    expectRefused(await list(grishaToken, { limit: 1, windowHours: 24, cursor }), 400, "bad_request", "cursor_window_mismatch");
    expectRefused(await list(grishaToken, { raw: `?cursor=${cursor}&windowHours=72` }), 400, "bad_request", "cursor_window_mismatch");
    // Without windowHours the hub's default (48) is the window asked for: the same walk.
    expect((await list(grishaToken, { raw: `?cursor=${cursor}` })).statusCode).toBe(200);

    // Anyone else's, another page's, a forged one: one answer, which never says why.
    const flipped = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    const ownerWalk = await listOk(ownerToken, { limit: 1 });
    const scope = { pageId: pageIds["lora-of"]!, userId: userIds.grisha };
    const position = { at: `${minutesAgo(2).toISOString().slice(0, -1)}000Z`, id: "1" };
    const state = { hours: 48, to: Date.now(), snapshotAt: Date.now(), before: position };
    const refused: Array<[string, InjectResponse]> = [
      ["another person", await list(nikitaToken, { limit: 1, cursor })],
      ["another page", await list(ownerToken, { pageLabel: "mia-of", limit: 1, cursor: ownerWalk.nextCursor! })],
      ["tampered", await list(grishaToken, { limit: 1, cursor: flipped })],
      ["not a cursor", await list(grishaToken, { limit: 1, cursor: "not-a-cursor" })],
      ["older than the walk may be", await list(grishaToken, {
        limit: 1,
        cursor: mintCursor({ scope, state, issuedAt: new Date(Date.now() - CLIENT_AUDIENCE_NEW_CURSOR_TTL_MS - MINUTE_MS) }),
      })],
      ["another route's", await list(grishaToken, {
        limit: 1, cursor: mintCursor({ scope, state, domain: "agency-hub:client-feed-cursor:v1" }),
      })],
      ["a state of another shape", await list(grishaToken, {
        limit: 1, cursor: mintCursor({ scope, state: { ...state, before: { ...position, id: "1; drop table fans" } } }),
      })],
      ["a state with an extra key", await list(grishaToken, {
        limit: 1, cursor: mintCursor({ scope, state: { ...state, pageId: pageIds["mia-of"] } }),
      })],
    ];
    for (const [label, response] of refused) {
      expect(response.statusCode, `${label}: ${response.body}`).toBe(400);
      expect(response.json(), label).toEqual({
        error: "bad_request", message: "cursor is not valid for this request", statusCode: 400, reason: "cursor_invalid",
      });
      expect(frozenErrorBodySchema.safeParse(response.json()).success, label).toBe(true);
    }
    // A cursor this hub would mint for the walk is taken: the refusals above are about the cursor, not the minting.
    expect((await list(grishaToken, { limit: 1, cursor: mintCursor({ scope, state }) })).statusCode).toBe(200);
    // The cursor is bound to the person, not to the token: the same chatter's other token continues the walk.
    expect((await list(grishaFullToken, { limit: 1, cursor })).statusCode).toBe(200);

    // The cursor adds no right and is checked after the page and the switch, never in their place.
    await patchConfig([features({ newcomers: false })]);
    expectRefused(await list(grishaToken, { limit: 1, cursor }), 409, "client_feature_disabled", "flag_off");
    expectRefused(await list(grishaToken, { limit: 1, cursor: "not-a-cursor" }), 409, "client_feature_disabled", "flag_off");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers each fan's subscription as the hub holds it now, with its time and collector, and the sweep's own start once it confirms the notification", async () => {
    await switchOn();
    const sweptAt = minutesAgo(60);
    await seedSweep({ generation: 91, completedAt: sweptAt });
    const [notified, swept, back, expired, retired, recordOnly, unknown] = Array.from({ length: 7 }, nextFan);
    const subscribed = minutesAgo(180);
    for (const fan of [notified, swept, expired, retired, recordOnly, unknown]) {
      await notify({ fan: fan!, at: subscribed });
    }
    await notify({ fan: back!, at: subscribed, kind: "subscriptions.renewed", subType: "returning_subscriber" });

    // Only the notification wrote the row: its start is the notification's time.
    const notifiedAt = minutesAgo(179);
    await seedSubscription(notified!, await seedFan(notified!, { isSubscriber: true }), {
      startedAt: subscribed, seenAt: notifiedAt,
    });
    // The newest sweep read the subscription: its own start, to the second, and its end.
    const preciseStart = new Date(subscribed.getTime() + 41_000);
    const endsAt = new Date(preciseStart.getTime() + 30 * 24 * HOUR_MS);
    await seedSubscription(swept!, await seedFan(swept!, { isSubscriber: true }), {
      generation: 91, startedAt: preciseStart, endsAt, seenAt: sweptAt,
    });
    // Came back: a sweep long ago saw the first subscription; the notification reactivated the row
    // and kept that old start.
    const oldStart = minutesAgo(200 * 24 * 60);
    await seedSubscription(back!, await seedFan(back!, { isSubscriber: true }), {
      generation: 60, startedAt: oldStart, seenAt: notifiedAt,
    });
    // Expired by its notification; retired by a sweep that no longer found it.
    const expiredAt = minutesAgo(30);
    await seedSubscription(expired!, await seedFan(expired!, { isSubscriber: false }), {
      isCurrent: false, canonicalStatus: "expired", generation: 91, startedAt: preciseStart, endsAt: expiredAt, seenAt: expiredAt,
    });
    await seedSubscription(retired!, await seedFan(retired!, { isSubscriber: false }), {
      isCurrent: false, startedAt: subscribed, seenAt: sweptAt,
    });
    // A fan record on the page and no subscription row; and nothing at all.
    await seedFan(recordOnly!, { isSubscriber: false });

    const body = await listOk(grishaToken);
    expect(rowOf(body, notified!)).toMatchObject({
      subscribedAt: subscribed.toISOString(),
      subscribedAtSource: "notification",
      status: { isSubscriber: true, subscriptionStatus: "active", endsAt: null, asOf: notifiedAt.toISOString(), source: "webhook" },
    });
    expect(rowOf(body, swept!)).toMatchObject({
      subscribedAt: preciseStart.toISOString(),
      subscribedAtSource: "subscribeAt",
      status: {
        isSubscriber: true, subscriptionStatus: "active", endsAt: endsAt.toISOString(), asOf: sweptAt.toISOString(),
        source: "sweep",
      },
    });
    // The stale start of a returning fan is never the row's date, and the old sweep does not vouch for the return.
    expect(rowOf(body, back!)).toMatchObject({
      kind: "returning",
      subscribedAt: subscribed.toISOString(),
      subscribedAtSource: "notification",
      status: { isSubscriber: true, subscriptionStatus: "active", source: "webhook" },
    });
    expect(rowOf(body, expired!)).toMatchObject({
      // The sweep read this subscription's start before it ended.
      subscribedAt: preciseStart.toISOString(),
      subscribedAtSource: "subscribeAt",
      status: {
        isSubscriber: false, subscriptionStatus: "expired", endsAt: expiredAt.toISOString(), asOf: expiredAt.toISOString(),
        source: "webhook",
      },
    });
    expect(rowOf(body, retired!).status).toEqual({
      isSubscriber: false, subscriptionStatus: "expired", endsAt: null, asOf: sweptAt.toISOString(), source: "sweep",
    });
    // No subscription row: unknown, and never "not a subscriber" off a fan record's default.
    for (const fan of [recordOnly, unknown]) {
      expect(rowOf(body, fan!).status, fan).toEqual({
        isSubscriber: null, subscriptionStatus: "unknown", endsAt: null, asOf: null, source: "none",
      });
    }

    // The same rows after the next sweep starts walking and reaches one fan: the fan it has read
    // carries its generation, the one before stays the newest whole sweep for everyone else.
    await seedSweep({ generation: 92, completedAt: sweptAt, startedAt: minutesAgo(1) });
    await query("update page_subscriptions set last_seen_generation = 92 where platform_subscription_id = $1", [back]);
    const walking = await listOk(grishaToken);
    expect(rowOf(walking, swept!).status.source).toBe("sweep");
    expect(rowOf(walking, back!).status.source).toBe("sweep");
    expect(rowOf(walking, notified!).status.source).toBe("webhook");
    // Once it completes, a current row without its generation was kept by a notification, not by the sweep.
    await seedSweep({ generation: 92, completedAt: minutesAgo(0) });
    expect(rowOf(await listOk(grishaToken), swept!).status.source).toBe("webhook");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("summarizes the chat from what the hub stores, never from the Fansly chain columns", async () => {
    await switchOn();
    const [silent, talking, proven, windowed, none] = Array.from({ length: 5 }, nextFan);
    for (const fan of [silent, talking, proven, windowed, none]) {
      await notify({ fan: fan!, at: minutesAgo(15) });
    }
    const welcomed = minutesAgo(14);
    const replied = minutesAgo(6);
    // Only the automatic welcome message so far; the chain columns claim a complete history.
    await seedThread(silent!, { count: 1, lastAt: welcomed, lastModelAt: welcomed, historyState: "complete" });
    await seedThread(talking!, { count: 4, lastAt: replied, lastFanAt: replied, lastModelAt: minutesAgo(8), unread: 2 });
    await seedThread(proven!, { count: 12, lastAt: welcomed, lastModelAt: welcomed, coverage: "complete", backfillComplete: true });
    await seedThread(windowed!, { count: 50, lastAt: welcomed, coverage: "partial_window" });
    await rearm();

    const body = await listOk(grishaToken);
    expect(rowOf(body, silent!).thread).toEqual({
      lastMessageAt: welcomed.toISOString(), lastFanMessageAt: null, lastModelMessageAt: welcomed.toISOString(),
      storedMessageCount: 1, coverage: "unknown", backfillComplete: false,
    });
    expect(rowOf(body, talking!).thread).toEqual({
      lastMessageAt: replied.toISOString(), lastFanMessageAt: replied.toISOString(),
      lastModelMessageAt: minutesAgo(8).toISOString(), storedMessageCount: 4, coverage: "unknown", backfillComplete: false,
    });
    expect(rowOf(body, proven!).thread).toMatchObject({ storedMessageCount: 12, coverage: "complete", backfillComplete: true });
    expect(rowOf(body, windowed!).thread).toMatchObject({ storedMessageCount: 50, coverage: "partial", backfillComplete: false });
    expect(rowOf(body, none!).thread).toBeNull();

    // Reading the list marks nothing read and asks OnlyFans nothing.
    expect(await query("select unread_count from page_dm_threads where platform_conversation_id = $1", [talking]))
      .toEqual([{ unread_count: 2 }]);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("carries each fan's greeting, lease and custody exactly as the claim status read answers them; a desktop greeting counts (critic 1)", async () => {
    await switchOn({ newcomers: true, previewSend: true });
    const fans = {
      free: nextFan(),
      leased: nextFan(),
      lapsed: nextFan(),
      greeted: nextFan(),
      desktopGreeted: nextFan(),
      desktopQueued: nextFan(),
      desktopCancelled: nextFan(),
      dispatching: nextFan(),
      uncertain: nextFan(),
    };
    let minute = 1;
    for (const fan of Object.values(fans)) {
      await notify({ fan, at: minutesAgo(minute += 1) });
    }
    // The desktop's outbox: confirmed by OnlyFans, still queued, cancelled before any attempt.
    await seedDesktopCommand(fans.desktopGreeted, "confirmed", 1, { source: "ofapi_response" });
    await seedDesktopCommand(fans.desktopQueued, "queued", 0, null);
    await seedDesktopCommand(fans.desktopCancelled, "cancelled", 0, null);
    await rearm();

    await act(grishaToken, fans.leased, claimBody(I1));
    const lapsedLease = randomUUID();
    await act(grishaToken, fans.lapsed, claimBody(I1, lapsedLease));
    await query("update client_fan_leases set expires_at = now() - interval '1 second' where lease_id = $1", [lapsedLease]);
    // A greeting sent from the preview and proven: receipt and echo of one message id.
    const sentAttempt = await dispatchGreeting(fans.greeted);
    await act(grishaToken, fans.greeted, {
      action: "sent", attemptId: sentAttempt, instanceId: I1, platformMessageId: "880001", evidence: "receipt+echo",
    });
    const liveAttempt = await dispatchGreeting(fans.dispatching);
    const lostAttempt = await dispatchGreeting(fans.uncertain);
    await query("update client_send_custody set ticket_expires_at = now() - interval '1 second' where attempt_id = $1", [lostAttempt]);
    // Nikita holds a lease of his own on the fan the desktop cancelled for.
    await act(nikitaToken, fans.desktopCancelled, claimBody(I3));
    // A ticket lasts 10 s and a lease 120 s: keep what is alive alive for the whole test.
    await query("update client_send_custody set ticket_expires_at = now() + interval '1 hour' where attempt_id = $1", [liveAttempt]);
    await query("update client_fan_leases set expires_at = now() + interval '1 hour' where state = 'active' and lease_id <> $1", [lapsedLease]);

    for (const token of [grishaToken, nikitaToken, ownerToken]) {
      const body = await listOk(token);
      expect(body.items).toHaveLength(Object.keys(fans).length);
      for (const [name, fan] of Object.entries(fans)) {
        expect(rowOf(body, fan).claim, `${name} as ${token === grishaToken ? "the sender" : "another person"}`)
          .toEqual(await claimSummary(token, fan));
      }
    }

    const mine = await listOk(grishaToken);
    const theirs = await listOk(nikitaToken);
    expect(rowOf(mine, fans.free).claim).toEqual({ greeting: "none", lease: "none", heldBy: null, custody: null });
    // The list names no client install, so the caller's own lease is "you, elsewhere"; nobody else is named.
    expect(rowOf(mine, fans.leased).claim).toEqual({ greeting: "none", lease: "held", heldBy: "you-elsewhere", custody: null });
    expect(rowOf(theirs, fans.leased).claim).toEqual({ greeting: "none", lease: "held", heldBy: "someone-else", custody: null });
    expect(rowOf(mine, fans.desktopCancelled).claim).toMatchObject({ lease: "held", heldBy: "someone-else" });
    expect(rowOf(mine, fans.lapsed).claim).toEqual({ greeting: "none", lease: "none", heldBy: null, custody: null });
    // Greeted for good: by the extension, and by the desktop's confirmed command.
    expect(rowOf(mine, fans.greeted).claim).toMatchObject({ greeting: "confirmed", custody: "sent" });
    // A finished send is the sender's own business: nobody else sees its custody.
    expect(rowOf(theirs, fans.greeted).claim).toMatchObject({ greeting: "confirmed", custody: null });
    for (const body of [mine, theirs]) {
      expect(rowOf(body, fans.desktopGreeted).claim).toMatchObject({ greeting: "confirmed", custody: null });
      // A command that may still greet, and one that never left, are not a greeting.
      expect(rowOf(body, fans.desktopQueued).claim.greeting).toBe("none");
      expect(rowOf(body, fans.desktopCancelled).claim.greeting).toBe("none");
      // An unresolved send holds the fan for everyone.
      expect(rowOf(body, fans.dispatching).claim.custody).toBe("dispatching");
      expect(rowOf(body, fans.uncertain).claim.custody).toBe("uncertain-held");
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("says whether it can vouch for the list: complete, partial or unknown, and why", async () => {
    await switchOn();
    await notify({ fan: nextFan(), at: minutesAgo(10) });
    const coverage = async (input: ListInput = {}) => (await listOk(grishaToken, input)).coverage;

    // Nothing collects the delivery history and no sweep ever completed: nothing is known.
    expect(await coverage()).toEqual({
      state: "unknown", deliveryFrontier: null, lastAudienceSweepAt: null,
      reasons: ["delivery_history_off", "audience_sweep_missing"],
    });
    // The collection is on; no window of it is complete yet.
    await collectDeliveryHistory();
    await seedDeliveryScan(minutesAgo(1), "pending");
    expect(await coverage()).toMatchObject({
      state: "unknown", deliveryFrontier: null, reasons: ["delivery_history_pending", "audience_sweep_missing"],
    });

    // A delivery history checked to a few minutes ago and a completed sweep: complete.
    const frontier = minutesAgo(5);
    const sweptAt = minutesAgo(600);
    await seedDeliveryScan(frontier);
    await seedSweep({ completedAt: sweptAt });
    expect(await coverage()).toEqual({
      state: "complete", deliveryFrontier: frontier.toISOString(), lastAudienceSweepAt: sweptAt.toISOString(), reasons: [],
    });
    // Another page's sweep is not this page's.
    await query("delete from page_sync_cursors");
    await seedSweep({ page: "mia-of" });
    expect((await coverage()).reasons).toEqual(["audience_sweep_missing"]);
    await seedSweep({ completedAt: sweptAt });

    // A notification of the window that is not applied to the subscriber state.
    await seedWebhookRow({ eventType: "subscriptions.new", projection: "pending", receivedAt: minutesAgo(9) });
    expect(await coverage()).toMatchObject({ state: "partial", reasons: ["subscription_projection_pending"] });
    await seedWebhookRow({ eventType: "subscriptions.expired", projection: "failed", receivedAt: minutesAgo(8) });
    expect(await coverage()).toMatchObject({
      state: "partial", reasons: ["subscription_projection_pending", "subscription_projection_failed"],
    });
    await query("update ofapi_webhook_events set projection_status = 'projected'");
    // Applied or skipped rows, other notifications, another page's backlog and one from before the window do not count.
    await seedWebhookRow({ eventType: "subscriptions.renewed", projection: "skipped", receivedAt: minutesAgo(7) });
    await seedWebhookRow({ eventType: "messages.received", projection: "pending", receivedAt: minutesAgo(7) });
    await seedWebhookRow({ eventType: "subscriptions.new", projection: "pending", receivedAt: minutesAgo(7), page: "mia-of" });
    await seedWebhookRow({ eventType: "subscriptions.new", projection: "failed", receivedAt: minutesAgo(49 * 60) });
    expect(await coverage()).toMatchObject({ state: "complete", reasons: [] });

    // The last sweep ended without a result the hub trusts.
    await seedSweep({ completedAt: sweptAt, unverifiedAt: sweptAt });
    expect(await coverage()).toMatchObject({
      state: "partial", lastAudienceSweepAt: sweptAt.toISOString(), reasons: ["audience_sweep_unverified"],
    });
    await seedSweep({ completedAt: sweptAt });

    // The delivery history stopped two hours ago: the tail of a long window is unchecked,
    // and a window that starts after it is not checked at all.
    const stale = new Date(Date.now() - 2 * HOUR_MS);
    expect(2 * HOUR_MS).toBeGreaterThan(OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS);
    await query("delete from ofapi_webhook_delivery_scans");
    await seedDeliveryScan(stale);
    expect(await coverage()).toMatchObject({
      state: "partial", deliveryFrontier: stale.toISOString(), reasons: ["delivery_history_behind"],
    });
    expect(await coverage({ windowHours: 1 })).toMatchObject({
      state: "unknown", deliveryFrontier: stale.toISOString(), reasons: ["delivery_history_before_window"],
    });
    // The owner switched the collection off: what it once checked vouches for nothing now.
    await query("update ofapi_webhook_collection_policy set history_enabled = false");
    expect(await coverage()).toMatchObject({ state: "unknown", deliveryFrontier: null, reasons: ["delivery_history_off"] });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers the page's welcome template as last collected, its price in mills, or null", async () => {
    await switchOn();
    await healthyCollectors();
    await notify({ fan: nextFan(), at: minutesAgo(10) });
    // Not collected yet (the owner has not switched the collection on).
    expect((await listOk(grishaToken)).welcomeTemplate).toBeNull();

    const collect = async (page: OfPage, ref: string, observedAt: Date, template: Record<string, unknown>) => {
      const observationId = ++observationSeq;
      await saveOfapiReadSnapshot(app.db, {
        pageId: pageIds[page]!,
        category: "account_settings",
        operation: OFAPI_WELCOME_TEMPLATE_OPERATION,
        pathname: "/settings/welcome-message",
        query: {},
        observedAt,
        observationId,
        observationReceivedAt: observedAt,
        eventId: observationId,
        granularity: "snapshot",
        coverage: { complete: true },
        // The facts as the collection's own normalizer fixes them from the provider's row.
        items: [{ nativeId: ref, welcomeTemplate: ofapiWelcomeTemplateFacts(template) }],
      });
    };
    // OnlyFans prices the template in dollars: $5 is 5000 mills.
    const firstAt = minutesAgo(26 * 60);
    await collect("lora-of", "42", firstAt, {
      isActive: true, text: "<p>Welcome!</p>", price: 5, mediaCount: 1, media: [{ id: 7, type: "photo" }],
    });
    await collect("mia-of", "77", minutesAgo(1), { isActive: false, text: "<p>Hello from Mia</p>", price: 0 });
    expect((await listOk(grishaToken)).welcomeTemplate).toEqual({
      ref: "42", observedAt: firstAt.toISOString(), enabled: true, hasText: true, hasMedia: true, priceMills: 5000,
    });
    // The owner saved another template; the newest snapshot is the answer.
    const secondAt = minutesAgo(2 * 60);
    await collect("lora-of", "43", secondAt, { text: "<p></p>", price: 0, mediaCount: 0, media: [] });
    expect((await listOk(grishaToken)).welcomeTemplate).toEqual({
      ref: "43", observedAt: secondAt.toISOString(), enabled: null, hasText: false, hasMedia: false, priceMills: 0,
    });
    expect((await listOk(svetaToken, { pageLabel: "mia-of" })).welcomeTemplate).toMatchObject({ ref: "77", enabled: false });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds its rights-matrix row in both auth-policy modes; another page's subscribers are never served", async () => {
    await switchOn();
    const loraFan = nextFan();
    const miaFan = nextFan();
    await notify({ fan: loraFan, at: minutesAgo(5) });
    await notify({ fan: miaFan, at: minutesAgo(5), page: "mia-of" });

    const version = { "x-client-version": EXTENSION_VERSION };
    const cells: Array<{ who: string; headers: Record<string, string>; page?: string; status: number }> = [
      { who: "anonymous", headers: {}, status: 401 },
      { who: "unknown bearer", headers: { authorization: "Bearer agency_hub_device_not-a-real-token" }, status: 401 },
      { who: "owner cookie", headers: { cookie: ownerCookie }, status: 403 },
      { who: "team_lead cookie", headers: { cookie: await loginCookie("lead") }, status: 403 },
      { who: "chatter cookie", headers: { cookie: await loginCookie("grisha") }, status: 403 },
      // Live and granted lora-of: refused by kind.
      { who: "agent key", headers: { authorization: `Bearer ${AGENT_KEY_TOKEN}` }, status: 403 },
      { who: "owner device token", headers: bearer(ownerToken), status: 200 },
      // The owner is granted every page.
      { who: "owner device token, mia-of", headers: bearer(ownerToken), page: "mia-of", status: 200 },
      { who: "team_lead device token", headers: bearer(leadToken), status: 200 },
      { who: "chatter device token", headers: bearer(grishaFullToken), status: 200 },
      { who: "chatter chat-extension token", headers: bearer(grishaToken), status: 200 },
    ];

    for (const mode of ["log", "enforce"] as const) {
      app.config.authPolicyEnforcement = mode;
      for (const cell of cells) {
        const label = `${mode} mode, ${cell.who}`;
        const response = await server!.inject({
          method: "GET",
          url: `/api/v1/client/pages/${cell.page ?? "lora-of"}/audience-new?windowHours=48`,
          headers: { ...version, ...cell.headers },
        });
        expect(response.statusCode, `${label}: ${response.body}`).toBe(cell.status);
        if (cell.status === 200) {
          const rows = clientAudienceNewResponseSchema.parse(response.json()).items.map((row) => row.fanRef);
          expect(rows, label).toEqual([cell.page === "mia-of" ? miaFan : loraFan]);
          continue;
        }
        // Every refusal is the declared error body, and none carries a subscriber.
        const error = errorResponseSchema.parse(response.json());
        expect(error.error, label).toBe(cell.status === 401 ? "unauthorized" : "forbidden");
        expect(response.body, label).not.toMatch(new RegExp(`${loraFan}|${miaFan}`));
      }

      // A page that is not the caller's, and one that does not exist. Enforced,
      // the declared page scope answers before the handler (403, 404); in log
      // mode the hub's own feature check answers both the same.
      for (const token of [grishaToken, grishaFullToken, leadToken]) {
        const foreign = await list(token, { pageLabel: "mia-of" });
        const missing = await list(token, { pageLabel: "ghost-of" });
        if (mode === "enforce") {
          expectRefused(foreign, 403, "forbidden");
          expectRefused(missing, 404, "not_found");
        } else {
          expectRefused(foreign, 409, "client_feature_disabled", "not_granted");
          expectRefused(missing, 409, "client_feature_disabled", "not_granted");
        }
        expect(foreign.body).not.toContain(miaFan);
      }
      // The page's own chatter still reads it.
      expect((await listOk(svetaToken, { pageLabel: "mia-of" })).items.map((row) => row.fanRef)).toEqual([miaFan]);
      expectRefused(await list(svetaToken), mode === "enforce" ? 403 : 409,
        mode === "enforce" ? "forbidden" : "client_feature_disabled",
        mode === "enforce" ? undefined : "not_granted");
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a malformed request: a bounded window and page size, a strict query", async () => {
    await switchOn();
    const fan = nextFan();
    await notify({ fan, at: minutesAgo(5) });

    for (const raw of [
      "?windowHours=0",
      "?windowHours=721",
      "?windowHours=1.5",
      "?windowHours=two",
      "?windowHours=48&limit=0",
      "?windowHours=48&limit=101",
      "?windowHours=48&cursor=",
      `?windowHours=48&cursor=${"c".repeat(2049)}`,
      // The page is the path's and the reader is the caller; naming them in the query is refused, not ignored.
      "?windowHours=48&pageLabel=mia-of",
      "?windowHours=48&userId=1",
      `?windowHours=48&fanRef=${fan}`,
      "?windowHours=48&from=2026-10-01T00:00:00.000Z",
    ]) {
      const response = await list(grishaToken, { raw });
      expect(response.statusCode, `${raw}: ${response.body}`).toBe(400);
      expect(errorResponseSchema.safeParse(response.json()).success, raw).toBe(true);
      expect(response.body, raw).not.toContain(fan);
    }
    // The bounds themselves, and the hub's defaults when the query names neither.
    expect((await listOk(grishaToken, { windowHours: 1, limit: 1 })).window.hours).toBe(1);
    expect((await listOk(grishaToken, { windowHours: 720, limit: 100 })).window.hours).toBe(720);
    const plain = await list(grishaToken, { raw: "" });
    expect(plain.statusCode, plain.body).toBe(200);
    expect(clientAudienceNewResponseSchema.parse(plain.json()).window.hours).toBe(48);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
