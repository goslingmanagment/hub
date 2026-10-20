import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  insertAgentKey,
  setConfigOverride,
  type Database,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsThread } from "./helpers/fansly-ws-capture.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fixture passwords hash at minimum cost (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * `agentThreadAvailability` (arena "vanished chat", plan §5) against a real
 * database and the real server: a chat's open unavailability episode, or null
 * — "no open episode recorded", never "Fansly serves the chat".
 *
 *  - the page's grant like the transcript: a page outside it and a page that
 *    does not exist answer the same bytes; `read:messages` is required;
 *  - a ref the granted page holds no thread for is the plane's static 404;
 *  - no episode, an ended one → null; a refusing and an established episode →
 *    their fields, `cause: unchecked`, the owner's note with its date;
 *  - every answer passes the strict contract, and the `hub` CLI reads it over
 *    a listening server — and tells a hub without the route (its router's 404)
 *    from the plane's 404.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MESSAGES = `${AGENT_KEY_TOKEN_PREFIX}availability-messages-token`;
const NO_MESSAGES = `${AGENT_KEY_TOKEN_PREFIX}availability-datasets-token`;

const GROUP = {
  none: "810272281019300001",
  established: "810272281019300002",
  refusing: "810272281019300003",
  ended: "810272281019300004",
  otherPage: "810272281019300005",
  unknown: "810272281019300099",
} as const;

const OPENED_AT = "2026-10-06T08:00:00.000Z";
const ESTABLISHED_AT = "2026-10-06T15:11:00.000Z";
const LAST_REFUSAL_AT = "2026-10-08T15:20:00.000Z";
const RETRY_NOT_BEFORE = "2026-10-09T15:20:00.000Z";
const NOTE = { text: "06.10: the profile does not open from lora-1", at: "2026-10-06T22:14:00.000Z" };

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function insertKey(token: string, capabilities: string[], pageIds: number[], ownerId: number) {
  await insertAgentKey(testDb!.db, {
    name: token.slice(AGENT_KEY_TOKEN_PREFIX.length),
    keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(token),
    capabilities: capabilities as never,
    pageIds,
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: ownerId,
  });
}

/** An episode as the page's actor (and the owner's note) leaves it. */
async function episode(threadId: number, input: {
  state: "refusing" | "established";
  refusals: number;
  ended?: true;
  note?: { text: string; at: string };
}): Promise<void> {
  const established = input.state === "established";
  await testDb!.pool.query(
    `insert into page_dm_thread_unavailability (thread_id, state, opened_at, established_at, ended_at, end_reason, refusals,
            last_refusal_at, last_http_status, retry_not_before, first_attempt_id, last_attempt_id, first_observation_id,
            first_observation_received_at, last_observation_id, last_observation_received_at, owner_note, owner_note_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 500, $9, 41, 45, 901, $3, 905, $8, $10, $11)`,
    [
      threadId, input.state, OPENED_AT, established ? ESTABLISHED_AT : null,
      input.ended ? LAST_REFUSAL_AT : null, input.ended ? "read_served" : null, input.refusals, LAST_REFUSAL_AT,
      established ? RETRY_NOT_BEFORE : null, input.note?.text ?? null, input.note?.at ?? null,
    ],
  );
}

async function boot() {
  const appContext = createTestAppContext(testDb!);
  server = await buildApiServer(appContext);
  await server.ready();
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  const handles = { db: db(), pool: testDb.pool };
  const model = await createModel(db(), { slug: "lora", name: "Lora" });
  const granted = (await createFanslyPage(db(), { modelId: model!.id, label: "lora-1" }))!.id;
  const hidden = (await createFanslyPage(db(), { modelId: model!.id, label: "lora-2" }))!.id;

  await seedWsThread(handles, { pageId: granted, groupId: GROUP.none, fanRef: "200000000000000001" });
  await episode(await seedWsThread(handles, { pageId: granted, groupId: GROUP.established, fanRef: "200000000000000002" }), {
    state: "established", refusals: 8, note: NOTE,
  });
  await episode(await seedWsThread(handles, { pageId: granted, groupId: GROUP.refusing, fanRef: "200000000000000003" }), {
    state: "refusing", refusals: 2,
  });
  await episode(await seedWsThread(handles, { pageId: granted, groupId: GROUP.ended, fanRef: "200000000000000004" }), {
    state: "established", refusals: 5, ended: true,
  });
  // The other page's chat has an episode: its 404 is not "nothing there".
  await episode(await seedWsThread(handles, { pageId: hidden, groupId: GROUP.otherPage, fanRef: "200000000000000005" }), {
    state: "established", refusals: 6,
  });

  const owner = await createUserAccount(createTestAppContext(testDb), {
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await insertKey(MESSAGES, ["read:messages"], [granted], owner!.id);
  await insertKey(NO_MESSAGES, ["read:datasets"], [granted], owner!.id);
  await setConfigOverride(testDb.db, { key: "agentReadPlaneMode", value: "full", userId: null, groupId: randomUUID() });
});

function availability(pageLabel: string, conversationRef: string, token = MESSAGES) {
  return server!.inject({
    method: "GET",
    url: `/api/v1/agent/pages/${pageLabel}/threads/${conversationRef}/availability`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("agentThreadAvailability over HTTP", () => {
  it("a page the key may not read answers the bytes of a page that does not exist", async (context) => {
    if (!testDb) return context.skip();
    await boot();
    const hidden = await availability("lora-2", GROUP.otherPage);
    const missing = await availability("no-such-page-at-all", GROUP.otherPage);
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);
    expect(hidden.json()).toMatchObject({ error: "not_found" });
  });

  it("a ref the granted page holds no thread for is the plane's static 404 (another page's chat included)", async (context) => {
    if (!testDb) return context.skip();
    await boot();
    const unknown = await availability("lora-1", GROUP.unknown);
    const elsewhere = await availability("lora-1", GROUP.otherPage);
    const hiddenPage = await availability("lora-2", GROUP.otherPage);
    expect(unknown.statusCode).toBe(404);
    expect(elsewhere.statusCode).toBe(404);
    expect(unknown.body).toBe(hiddenPage.body);
    expect(elsewhere.body).toBe(hiddenPage.body);
  });

  it("needs read:messages", async (context) => {
    if (!testDb) return context.skip();
    await boot();
    const response = await availability("lora-1", GROUP.established, NO_MESSAGES);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "agent_capability_missing" });
  });
});
