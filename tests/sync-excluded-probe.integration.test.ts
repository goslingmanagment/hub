import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSyncPage,
  insertAuditEvent,
  insertObservation,
  NEVER_CANONICALIZED_PARSE_VERSION,
  upsertFans,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyMessagingGroupsPage, FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
  FANSLY_WS_LIVE_FIELD,
} from "@agency_hub_core/shared";

import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { withErasureExecutionLock } from "../apps/runtime/src/services/erasure/index.ts";
import { RESOURCE_BREAKER_SUBJECTS } from "../apps/runtime/src/sync/engine/errors.ts";
import { createEngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  liftExcludedChats,
  readExcludedProbeReport,
  recordExcludedProbeReport,
  requestExcludedChatProbes,
  SYNC_DM_EXCLUSION_PROBE_AUDIT_EVENT,
  unliftExcludedChats,
} from "../apps/runtime/src/sync/excluded.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { applyListPage } from "../apps/runtime/src/sync/fansly/resources/dm-conversations.ts";
import { fanProfilesProbeModule } from "../apps/runtime/src/sync/fansly/resources/fan-profiles.ts";
import { EXCLUDED_CHAT_PROBE_KEY } from "../apps/runtime/src/sync/fansly/resources/probe.ts";
import { requestSyncProbe } from "../apps/runtime/src/sync/inspect.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  countRows,
  makeTestActor,
  okResponse,
  RecordingAlerts,
  ScriptedLiveTransport,
  seedSyncPage,
  statusResponse,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Owner decision №8 (step-3 design S3-06): the probe of the chats the legacy
// engine excluded from message sync, through the real actor and commits
// against a real database (a scripted transport plays Fansly's `/message`),
// and the explicit lift. Pinned: a served chat closes `served: true` with what
// the page showed, its observation is stamped never-canonicalized and a
// driver pass turns it into nothing (no events, no messages, no archive rows),
// nor does a version bump of the DM family that replays DM history; a 403 closes the
// probe `served: false` without holding the page, and the next probe goes
// out; a 500 carrying Fansly's own error envelope closes it `served: false`
// too, while a proxy's 502 stays on the subject's ladder, and failing probes
// (excluded chats and `probe.manual`) never hold the `probe` file; the
// migration that closes the probes the old rule left open; a 401 holds the
// page; the report and its record; the lift — live
// only, on a recorded verdict of ≥ 10 chats, ≥ 80 % served, no page-level
// error — clears the reason from bound threads of that reason only; the next
// list pass keeps them lifted on that page and excludes them on a page
// without the lift; unlift; the account probe excludes no chat, lifted or
// not; the migration that takes the unresolvable reason off every thread.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const EPOCH_MS = 1561494359900;
const OWN = "300000000000000001";
/** A second page's own account (external ids are unique per platform). */
const OWN_2 = "300000000000000002";
const HOUR = 3_600_000;
const MISSING = FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS;
const UNRESOLVABLE = FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP;
const BASE_MS = Date.now() - 6 * HOUR;
const ACTOR = "test";
const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined };

const snowflake = (ms: number, seq = 0) => ((BigInt(ms - EPOCH_MS) << 22n) | BigInt(seq)).toString();
const groupOf = (n: number) => `7100000000000${String(n).padStart(5, "0")}`;
const fanOf = (n: number) => `5100000000000${String(n).padStart(5, "0")}`;
/** Message k of chat n (sent BASE + k s; the chat is the snowflake sequence). */
const msgOf = (n: number, k: number) => snowflake(BASE_MS + k * 1000, n);

async function seedPage(label: string, mode: "live" | "off" = "live", ownRef = OWN): Promise<number> {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, {
    label,
    mode,
    guard: mode === "live" ? "fansly_sync_engine" : null,
  });
  await testDb!.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, ownRef]);
  await testDb!.pool.query("update sync_pages set mode_changed_at = clock_timestamp() - interval '1 day' where page_id = $1", [pageId]);
  return pageId;
}

interface ThreadSeed {
  reason?: string | null;
  bound?: boolean;
  visible?: boolean;
  /** The chat's head time (the sample orders by it). */
  ageMs?: number;
  /** The newest message the hub holds (k); default none. */
  storedHead?: number;
}

async function seedThread(pageId: number, n: number, seed: ThreadSeed = {}): Promise<number> {
  const [fan] = await upsertFans(db(), [{ platform: "fansly" as const, platformUserId: fanOf(n) }]);
  const metadata = seed.reason === null || seed.reason === undefined ? {} : { messageSyncExcludedReason: seed.reason };
  const stored = seed.storedHead === undefined ? null : msgOf(n, seed.storedHead);
  const inserted = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
            partner_username, conversation_flags, unread_count, last_message_id, last_message_at, last_message_sender_id,
            last_message_sender_role, newest_stored_message_id, oldest_stored_message_id, stored_message_count,
            message_coverage_status, is_visible, metadata, history_state)
     values ($1, $2, $3, $4, 'fan', 0, 0, $5, $6, $4, 'fan', $5, $5, $7, 'partial_window', $8, $9::jsonb,
             case when $7 > 0 then 'unverified' else 'none' end)
     returning id::text as id`,
    [
      pageId, groupOf(n), seed.bound === false ? null : fan!.id, fanOf(n), stored,
      new Date(Date.now() - (seed.ageMs ?? HOUR)), stored === null ? 0 : 1, seed.visible !== false, JSON.stringify(metadata),
    ],
  );
  return Number(inserted.rows[0]!.id);
}

function wireMessage(n: number, k: number) {
  return {
    id: msgOf(n, k),
    type: 1,
    dataVersion: 1,
    content: `message ${k}`,
    groupId: groupOf(n),
    senderId: k % 2 === 0 ? OWN : fanOf(n),
    correlationId: null,
    inReplyTo: null,
    inReplyToRoot: null,
    createdAt: Math.floor((BASE_MS + k * 1000) / 1000),
    attachments: [],
    embeds: [],
    interactions: [],
    likes: [],
    totalTipAmount: 0,
  };
}

/** The chat number of a `/message` request (a probe asks for the head only). */
function chatOf(req: FanslyWireRequest): number {
  const url = new URL(req.url);
  expect(url.pathname.endsWith("/message")).toBe(true);
  expect(url.searchParams.get("before")).toBeNull();
  return Number(url.searchParams.get("groupId")!.slice(-5));
}

/** What lilly-1's excluded chats answer, every time (2026-10-02 → 10-08). */
const GROUP_MESSAGES_500 = { success: false, error: { code: 500, details: "error getting group messages" } };

/** A proxy's or a gateway's own page: no Fansly envelope. */
function proxyPage(status: number): FanslyWireOutcome {
  const bodyText = `<html><head><title>${status} Bad Gateway</title></head><body><center>nginx</center></body></html>`;
  return { kind: "response", status, headers: { "content-type": "text/html" }, bodyText, bodyBytes: bodyText.length, sendMark: "request_start" };
}

/** An empty 5xx. */
function emptyStatus(status: number): FanslyWireOutcome {
  return { kind: "response", status, headers: {}, bodyText: "", bodyBytes: 0, sendMark: "request_start" };
}

/** Fansly's head page of chat n: messages 3, 2, 1 (newest first). */
function served(req: FanslyWireRequest): FanslyWireOutcome {
  const n = chatOf(req);
  return okResponse({ messages: [3, 2, 1].map((k) => wireMessage(n, k)) });
}

async function runLive(
  pageId: number,
  respond: (req: FanslyWireRequest, index: number) => FanslyWireOutcome,
  until: () => Promise<boolean>,
  alerts = new RecordingAlerts(),
) {
  const transport = new ScriptedLiveTransport();
  const requests: FanslyWireRequest[] = [];
  transport.respond = respond;
  transport.onHit = async (req) => {
    requests.push(req);
  };
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    registry: createEngineRegistry(FANSLY_RESOURCE_SPECS),
    transport,
    alerts,
    ownRef: OWN,
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 30_000, "the probes to settle");
  } finally {
    stop.abort();
    await run;
  }
  return { requests };
}

async function probeWork(pageId: number, n: number) {
  const result = await testDb!.pool.query<{
    id: string; state: string; close_reason: string | null; result: Record<string, unknown>; waiting_reason: string | null;
    failure_count: number; breaker_until: Date | null;
  }>(
    `select id::text, state, close_reason, result, waiting_reason, failure_count, breaker_until
       from sync_work where page_id = $1 and resource = $2 and subject = $3 and not shadow order by id desc limit 1`,
    [pageId, EXCLUDED_CHAT_PROBE_KEY, groupOf(n)],
  );
  return result.rows[0] ?? null;
}

async function closedProbes(pageId: number): Promise<number> {
  return scalar("select count(*)::int as n from sync_work where page_id = $1 and resource = $2 and state = 'done'", [pageId, EXCLUDED_CHAT_PROBE_KEY]);
}

async function scalar(text: string, values: unknown[]): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(text, values);
  return Number(result.rows[0]?.n ?? 0);
}

async function reasonOf(threadId: number): Promise<string | null> {
  const result = await testDb!.pool.query<{ reason: string | null }>(
    "select metadata ->> 'messageSyncExcludedReason' as reason from page_dm_threads where id = $1",
    [threadId],
  );
  return result.rows[0]?.reason ?? null;
}

/** The page's hold set (`sync_holds`), each row as `scope/key/kind`. */
async function holds(pageId: number): Promise<string[]> {
  const result = await testDb!.pool.query<{ hold: string }>(
    "select scope || '/' || key || '/' || kind as hold from sync_holds where page_id = $1 order by 1",
    [pageId],
  );
  return result.rows.map((row) => row.hold);
}

async function probe(pageLabel: string, sample = 20) {
  return requestExcludedChatProbes(db(), createFanslyRegistry(), { pageLabel, reason: MISSING, sample, actor: ACTOR });
}

describe("probe.excluded-chat", () => {
  it("a served chat closes `served: true`; its observation is stamped and a driver pass appends nothing", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("probe-served");
    const threadId = await seedThread(pageId, 1, { reason: MISSING });
    // The socket showed message 3 first (the overlay).
    await testDb.pool.query(
      `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
              is_sent_by_page, created_at, content, field_mask, decoder_version, first_visible_at, confirm_due_at)
       values ($1, $2, $3, $4, false, now(), 'message 3', $5, 1, now(), now() + interval '1 hour')`,
      [pageId, msgOf(1, 3), groupOf(1), fanOf(1), FANSLY_WS_LIVE_FIELD.content],
    );
    const request = await probe("probe-served");
    expect(request.chats).toEqual([{ chat: groupOf(1), workId: expect.any(Number), created: true }]);

    const { requests } = await runLive(pageId, served, async () => (await closedProbes(pageId)) === 1);
    expect(requests).toHaveLength(1);
    const work = await probeWork(pageId, 1);
    expect(work).toMatchObject({ state: "done", close_reason: "served" });
    expect(work!.result).toMatchObject({
      served: true,
      messages: 3,
      newestCreatedAt: new Date(Math.floor((BASE_MS + 3_000) / 1000) * 1000).toISOString(),
      oldestCreatedAt: new Date(Math.floor((BASE_MS + 1_000) / 1000) * 1000).toISOString(),
      liveIdsSeen: 1,
    });
    const observationId = Number(work!.result.observationId);
    const stamped = await testDb.pool.query<{ kind: string; parse_version: number }>(
      "select kind, parse_version from observations where id = $1",
      [observationId],
    );
    expect(stamped.rows[0]).toEqual({ kind: "dm_messages", parse_version: NEVER_CANONICALIZED_PARSE_VERSION });

    // The minutely sweep finds nothing to do with it: no events, no rows.
    await runCanonicalization({ db: db(), logger: QUIET } as never, { accountId: pageId, kinds: ["dm_messages"] });
    expect(await scalar("select count(*)::int as n from domain_events where account_id = $1", [pageId])).toBe(0);
    expect(await scalar("select count(*)::int as n from page_dm_messages where platform_account_id = $1", [pageId])).toBe(0);
    expect(await scalar("select count(*)::int as n from message_archive where account_id = $1", [pageId])).toBe(0);
    // The chat stays excluded until the owner lifts it; the page holds nothing.
    expect(await reasonOf(threadId)).toBe(MISSING);
    expect((await holds(pageId)).filter((hold) => hold.startsWith("page/"))).toEqual([]);
  });

  it("a version bump of the DM family re-parses DM history, never a probe", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("probe-bump");
    const threadId = await seedThread(pageId, 1, { reason: MISSING });
    await probe("probe-bump");
    await runLive(pageId, served, async () => (await closedProbes(pageId)) === 1);
    const observationId = Number((await probeWork(pageId, 1))!.result.observationId);
    const dmFamily = familyForObservation({ source: "pull", kind: "dm_messages", platform: "fansly" })!;
    // The family's next version: the minutely sweep replays every Fansly
    // `dm_messages` observation below it, whoever journaled it (a page-scoped
    // sweep, not one observation).
    const bump = () => runCanonicalization({ db: db(), logger: QUIET } as never, {
      accountId: pageId,
      kinds: ["dm_messages"],
      belowParseVersion: dmFamily.version + 1,
    });
    await bump();
    expect(await scalar("select count(*)::int as n from domain_events where account_id = $1", [pageId])).toBe(0);
    expect(await scalar("select count(*)::int as n from page_dm_messages where platform_account_id = $1", [pageId])).toBe(0);
    expect(await scalar("select count(*)::int as n from message_archive where account_id = $1", [pageId])).toBe(0);
    expect(await scalar("select parse_version as n from observations where id = $1", [observationId])).toBe(NEVER_CANONICALIZED_PARSE_VERSION);
    expect(await reasonOf(threadId)).toBe(MISSING);

    // Control: the stamp is what keeps it out. At the family's own version (a
    // stamp the next bump replays) the same sweep turns the probe into DM
    // events, so the sweep above would have caught a leak.
    await testDb.pool.query("update observations set parse_version = $2 where id = $1", [observationId, dmFamily.version]);
    await bump();
    expect(await scalar("select count(*)::int as n from domain_events where account_id = $1", [pageId])).toBeGreaterThan(0);
  });

  it("a 403 closes the probe `served: false` and holds nothing; the next probe still goes out", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("probe-forbidden");
    await seedThread(pageId, 1, { reason: MISSING, ageMs: HOUR });
    await seedThread(pageId, 2, { reason: MISSING, ageMs: 2 * HOUR });
    await probe("probe-forbidden");

    const { requests } = await runLive(
      pageId,
      (req, index) => (index === 0 ? statusResponse(403, { success: false, error: { code: 403 } }) : served(req)),
      async () => (await closedProbes(pageId)) === 2,
    );
    expect(requests).toHaveLength(2);
    const [forbidden, other] = requests.map(chatOf);
    expect(await probeWork(pageId, forbidden!)).toMatchObject({
      state: "done",
      close_reason: "not_served:403",
      result: { served: false, httpStatus: 403, errorClass: "subject_terminal" },
      failure_count: 0,
      breaker_until: null,
    });
    expect(await probeWork(pageId, other!)).toMatchObject({ state: "done", result: { served: true } });
    expect(await holds(pageId)).toEqual([]);

    const report = await readExcludedProbeReport(db(), { pageLabel: "probe-forbidden" });
    expect(report.summary).toMatchObject({ reason: MISSING, probed: 2, served: 1, notServed: 1, pending: 0, pageErrors: 0 });
    expect(report.liftRefusal).toMatch(/at least 10/);
  });

  it("a 500 with Fansly's error envelope closes the probe `not_served:500` in one request; a proxy's 502 stays on the subject's ladder", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("probe-500");
    await seedThread(pageId, 1, { reason: MISSING, ageMs: HOUR });
    await seedThread(pageId, 2, { reason: MISSING, ageMs: 2 * HOUR });
    await probe("probe-500");

    const { requests } = await runLive(
      pageId,
      (req) => (chatOf(req) === 1 ? statusResponse(500, GROUP_MESSAGES_500) : proxyPage(502)),
      async () => (await closedProbes(pageId)) === 1 && (await probeWork(pageId, 2))?.failure_count === 1,
    );
    expect(requests.map(chatOf).sort()).toEqual([1, 2]);
    expect(await probeWork(pageId, 1)).toMatchObject({
      state: "done",
      close_reason: "not_served:500",
      result: { served: false, httpStatus: 500, errorClass: "subject_failure" },
      waiting_reason: null,
      failure_count: 0,
      breaker_until: null,
    });
    expect(await probeWork(pageId, 2)).toMatchObject({ state: "open", waiting_reason: "subject_breaker", failure_count: 1 });
    expect(await holds(pageId)).toEqual([]);
    // Both answers journaled before anything else (capture before parse).
    const journal = await testDb.pool.query<{ kind: string; body: string }>(
      "select kind, payload ->> 'bodyText' as body from observations where account_id = $1 order by id",
      [pageId],
    );
    expect(journal.rows.map((row) => row.kind)).toEqual(["dm_messages:failed", "dm_messages:failed"]);
    expect(journal.rows.map((row) => row.body)).toContain(JSON.stringify(GROUP_MESSAGES_500));

    const report = await readExcludedProbeReport(db(), { pageLabel: "probe-500" });
    expect(report.summary).toMatchObject({ probed: 2, served: 0, notServed: 1, pending: 1, pageErrors: 0 });
    expect(report.chats.find((chat) => chat.chat === groupOf(1))).toMatchObject({
      verdict: "not_served",
      closeReason: "not_served:500",
      httpStatus: 500,
      errorClass: "subject_failure",
      attemptIds: [expect.any(Number)],
    });
  });

  it("failing probes never hold the probe file: after five failing chats, probe.manual goes out, and its own failure holds nothing", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("probe-mixed");
    for (const n of [1, 2, 3, 4, 5]) await seedThread(pageId, n, { reason: MISSING, ageMs: n * HOUR });
    await probe("probe-mixed", 5);
    const failingSubjects = () => countRows(
      testDb!.pool,
      `select count(distinct subject)::int as n from sync_attempts
        where page_id = $1 and split_part(resource, '.', 1) = 'probe' and error_class in ('subject_failure', 'envelope_unsuccessful')
          and admitted_at > now() - interval '10 minutes'`,
      [pageId],
    );
    const answered = (resource: string) => countRows(
      testDb!.pool,
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and outcome = 'response'",
      [pageId, resource],
    );
    const manualWork = async () => (await testDb!.pool.query<{ state: string; failure_count: number }>(
      "select state, failure_count from sync_work where page_id = $1 and resource = 'probe.manual' order by id desc limit 1",
      [pageId],
    )).rows[0] ?? null;

    // One chat answered by Fansly with its envelope (the most recent: probed first), four behind a
    // proxy's page or an empty 5xx — the fifth failing subject is one of theirs.
    const chatAnswers: Record<number, () => FanslyWireOutcome> = {
      1: () => statusResponse(500, GROUP_MESSAGES_500),
      2: () => proxyPage(502),
      3: () => emptyStatus(503),
      4: () => emptyStatus(504),
      5: () => proxyPage(502),
    };
    await runLive(pageId, (req) => chatAnswers[chatOf(req)]!(), async () => (await answered(EXCLUDED_CHAT_PROBE_KEY)) >= 5);
    expect(await answered(EXCLUDED_CHAT_PROBE_KEY)).toBe(5);
    // Enough distinct failing subjects of the file to hold it, by the attempts' classes …
    expect(await failingSubjects()).toBeGreaterThanOrEqual(RESOURCE_BREAKER_SUBJECTS);
    // … and nothing holds it: the probes' failures are not counted.
    expect(await holds(pageId)).toEqual([]);
    expect(await probeWork(pageId, 1)).toMatchObject({ state: "done", close_reason: "not_served:500" });
    for (const n of [2, 3, 4, 5]) {
      expect(await probeWork(pageId, n), String(n)).toMatchObject({ state: "open", waiting_reason: "subject_breaker", failure_count: 1 });
    }

    // The owner's manual probe goes out.
    const registry = createFanslyRegistry();
    await requestSyncProbe(db(), registry, { pageLabel: "probe-mixed", operation: "polls", params: {}, requestedBy: ACTOR });
    const manual = await runLive(
      pageId,
      (req) => (req.spec === "polls" ? okResponse({ polls: [] }) : statusResponse(599)),
      async () => (await manualWork())?.state === "done",
    );
    expect(manual.requests.map((req) => req.spec)).toEqual(["polls"]);
    expect(await holds(pageId)).toEqual([]);

    // A failing manual probe is one more failing subject of the file: still no hold.
    await requestSyncProbe(db(), registry, { pageLabel: "probe-mixed", operation: "polls", params: {}, requestedBy: ACTOR });
    const failed = await runLive(
      pageId,
      (req) => (req.spec === "polls" ? proxyPage(502) : statusResponse(599)),
      async () => (await manualWork())?.failure_count === 1,
    );
    expect(failed.requests.map((req) => req.spec)).toEqual(["polls"]);
    expect(await failingSubjects()).toBeGreaterThanOrEqual(RESOURCE_BREAKER_SUBJECTS + 1);
    expect(await holds(pageId)).toEqual([]);
    expect(await manualWork()).toMatchObject({ state: "open", failure_count: 1 });
  });

  it("a 401 holds the page (the session's answer, not the chat's)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("probe-401");
    await seedThread(pageId, 1, { reason: MISSING });
    await probe("probe-401");
    const alerts = new RecordingAlerts();
    await runLive(pageId, () => statusResponse(401, ""), async () => (await holds(pageId)).includes("page//auth"), alerts);
    expect(await probeWork(pageId, 1)).toMatchObject({ state: "open", waiting_reason: "page_hold" });
    const report = await readExcludedProbeReport(db(), { pageLabel: "probe-401", reason: MISSING });
    expect(report.summary).toMatchObject({ probed: 1, served: 0, pending: 1, pageErrors: 1 });
    expect(report.chats[0]).toMatchObject({ verdict: "pending", httpStatus: 401, pageErrors: 1 });
  });
});

describe("sync excluded probe / report / lift / unlift", () => {
  it("samples bound, visible chats of the reason, most recent first; only on a live page", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("sample");
    await seedThread(pageId, 1, { reason: MISSING, ageMs: 3 * HOUR });
    await seedThread(pageId, 2, { reason: MISSING, ageMs: HOUR });
    await seedThread(pageId, 3, { reason: MISSING, ageMs: 2 * HOUR });
    await seedThread(pageId, 4, { reason: MISSING, bound: false });
    await seedThread(pageId, 5, { reason: MISSING, visible: false });
    await seedThread(pageId, 6, { reason: UNRESOLVABLE });
    await seedThread(pageId, 7, { reason: null });
    const request = await probe("sample", 2);
    expect(request.chats.map((chat) => chat.chat)).toEqual([groupOf(2), groupOf(3)]);
    expect(await scalar(
      "select count(*)::int as n from audit_events where platform_account_id = $1 and event_type = 'admin.sync_dm_exclusion_probe_request'",
      [pageId],
    )).toBe(1);
    // Asked again: the open probes take the demand.
    expect((await probe("sample", 2)).chats.map((chat) => chat.created)).toEqual([false, false]);

    await seedPage("sample-off", "off", OWN_2);
    await expect(probe("sample-off")).rejects.toThrow(/sample-off is off/);
    await expect(requestExcludedChatProbes(db(), createFanslyRegistry(), { pageLabel: "sample", reason: UNRESOLVABLE, sample: 5, actor: ACTOR }))
      .resolves.toMatchObject({ chats: [{ chat: groupOf(6) }] });
  });

  it("lifts on a recorded verdict: bound threads of the reason lose it, nothing else changes; unlift keeps the threads", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("lift");
    const probed = await Promise.all(Array.from({ length: 10 }, (_, index) => seedThread(pageId, index + 1, { reason: MISSING, ageMs: (index + 1) * 60_000 })));
    const unbound = await seedThread(pageId, 20, { reason: MISSING, bound: false });
    const hidden = await seedThread(pageId, 21, { reason: MISSING, visible: false });
    const other = await seedThread(pageId, 22, { reason: UNRESOLVABLE });
    const plain = await seedThread(pageId, 23, { reason: null });
    await probe("lift", 10);

    // Nothing recorded yet: no lift.
    await expect(liftExcludedChats(db(), { pageLabel: "lift", reason: MISSING, evidencePageLabel: "lift", actor: ACTOR }))
      .rejects.toThrow(/no recorded probe/);

    // Nine of ten served (90 %), one forbidden.
    await runLive(
      pageId,
      (req, index) => (index === 4 ? statusResponse(403, { success: false }) : served(req)),
      async () => (await closedProbes(pageId)) === 10,
    );
    const report = await readExcludedProbeReport(db(), { pageLabel: "lift" });
    expect(report.summary).toMatchObject({ probed: 10, served: 9, notServed: 1, pending: 0, unanswered: 0, pageErrors: 0 });
    expect(report.liftRefusal).toBeNull();
    for (const chat of report.chats) {
      expect(chat.attemptIds, chat.chat).toHaveLength(1);
      expect(chat.observationId, chat.chat).not.toBeNull();
    }
    const auditId = await recordExcludedProbeReport(db(), report, ACTOR);
    const recorded = await testDb.pool.query<{ metadata: Record<string, unknown> }>("select metadata from audit_events where id = $1", [auditId]);
    expect(recorded.rows[0]!.metadata).toMatchObject({
      reason: MISSING, probed: 10, served: 9, notServed: 1, pageErrors: 0, workIds: report.summary.workIds,
    });

    const lifted = await liftExcludedChats(db(), { pageLabel: "lift", reason: MISSING, evidencePageLabel: "lift", actor: ACTOR });
    expect(lifted).toMatchObject({ added: true, lifted: [MISSING], threadsLifted: 11, unboundKept: 1, evidence: { auditId, probed: 10, served: 9 } });
    for (const threadId of [...probed, hidden]) expect(await reasonOf(threadId)).toBeNull();
    expect(await reasonOf(unbound)).toBe(MISSING);
    expect(await reasonOf(other)).toBe(UNRESOLVABLE);
    expect(await reasonOf(plain)).toBeNull();
    expect((await getSyncPage(db(), pageId))!.liftedDmExclusions).toEqual([MISSING]);
    expect(await scalar(
      "select count(*)::int as n from audit_events where platform_account_id = $1 and event_type = 'admin.sync_dm_exclusion_lift'",
      [pageId],
    )).toBe(1);
    // Idempotent.
    await expect(liftExcludedChats(db(), { pageLabel: "lift", reason: MISSING, evidencePageLabel: "lift", actor: ACTOR }))
      .resolves.toMatchObject({ added: false, lifted: [MISSING], threadsLifted: 0, unboundKept: 1 });

    // Unlift takes it off the page's list; the threads wait for the next list pass.
    await expect(unliftExcludedChats(db(), { pageLabel: "lift", reason: MISSING, actor: ACTOR }))
      .resolves.toMatchObject({ removed: true, lifted: [] });
    expect((await getSyncPage(db(), pageId))!.liftedDmExclusions).toEqual([]);
    expect(await reasonOf(probed[0]!)).toBeNull();
  });

  it("refuses a lift on a page that is not live, and on evidence of too few chats, too few served or a page error", async (context) => {
    if (!testDb) return context.skip();
    const live = await seedPage("lift-live");
    await seedPage("lift-off", "off", OWN_2);
    const thread = await seedThread(live, 1, { reason: MISSING });
    const evidence = async (summary: Record<string, unknown>) => insertAuditEvent(db(), {
      platformAccountId: live,
      source: "cli",
      eventType: SYNC_DM_EXCLUSION_PROBE_AUDIT_EVENT,
      metadata: { reason: MISSING, ...summary },
    });
    const lift = (pageLabel: string) => liftExcludedChats(db(), { pageLabel, reason: MISSING, evidencePageLabel: "lift-live", actor: ACTOR });

    await evidence({ probed: 20, served: 20, pageErrors: 0 });
    await expect(lift("lift-off")).rejects.toThrow(/lift-off is off/);
    await evidence({ probed: 9, served: 9, pageErrors: 0 });
    await expect(lift("lift-live")).rejects.toThrow(/at least 10/);
    await evidence({ probed: 20, served: 15, pageErrors: 0 });
    await expect(lift("lift-live")).rejects.toThrow(/15 of 20/);
    await evidence({ probed: 20, served: 20, pageErrors: 2 });
    await expect(lift("lift-live")).rejects.toThrow(/page-level/);
    // A recorded probe of the other reason is no evidence for this one.
    await insertAuditEvent(db(), {
      platformAccountId: live,
      source: "cli",
      eventType: SYNC_DM_EXCLUSION_PROBE_AUDIT_EVENT,
      metadata: { reason: UNRESOLVABLE, probed: 20, served: 20, pageErrors: 0 },
    });
    await expect(lift("lift-live")).rejects.toThrow(/page-level/);
    expect(await reasonOf(thread)).toBe(MISSING);
    expect((await getSyncPage(db(), live))!.liftedDmExclusions).toEqual([]);
  });
});

/** One `/messaging/groups` page: chats whose partner the page's accounts omit
 *  (the aggregation-missing case), heads at message 5. */
function listPageMissingPartners(chats: readonly number[], ownRef: string): FanslyMessagingGroupsPage {
  return {
    data: chats.map((n) => ({
      groupId: groupOf(n),
      partnerAccountId: fanOf(n),
      partnerUsername: null,
      flags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: msgOf(n, 5),
      lastUnreadMessageId: null,
    })),
    aggregationData: {
      accounts: [{ id: "599999999999999999", username: "someone", displayName: null }],
      groups: chats.map((n) => ({
        id: groupOf(n),
        type: 1,
        groupFlags: 0,
        users: [
          { groupId: groupOf(n), userId: ownRef, type: 0, permissionFlags: 0 },
          { groupId: groupOf(n), userId: fanOf(n), type: 0, permissionFlags: 0 },
        ],
        lastMessage: { ...wireMessage(n, 5), senderId: fanOf(n) },
      })),
    },
  } as unknown as FanslyMessagingGroupsPage;
}

describe("the conversation list after a lift", () => {
  it("keeps the lifted bound chats lifted (and reads their new messages); an unbound one and a page without the lift stay excluded", async (context) => {
    if (!testDb) return context.skip();
    const lifted = await seedPage("list-lifted");
    const other = await seedPage("list-off", "off", OWN_2);
    const liftedBound = await seedThread(lifted, 1, { reason: null, storedHead: 3 });
    const liftedUnbound = await seedThread(lifted, 2, { reason: MISSING, bound: false });
    const offBound = await seedThread(other, 1, { reason: null, storedHead: 3 });
    await testDb.pool.query("update sync_pages set lifted_dm_exclusions = array[$2]::text[] where page_id = $1", [lifted, MISSING]);

    const pass = (pageId: number, ownRef: string) => db().transaction(async (tx) => applyListPage(tx as unknown as Database, {
      pageId,
      now: new Date(),
      key: "dm-conversations.head",
      page: listPageMissingPartners([1, 2], ownRef),
      generation: null,
      classOf: () => "planned",
    }));
    const onLifted = await pass(lifted, OWN);
    const onOff = await pass(other, OWN_2);

    expect(await reasonOf(liftedBound)).toBeNull();
    expect(await reasonOf(liftedUnbound)).toBe(MISSING);
    expect(await reasonOf(offBound)).toBe(MISSING);
    expect(onLifted.counters).toMatchObject({ partner_missing_from_accounts: 2, partner_missing_lifted: 1 });
    expect(onOff.counters.partner_missing_lifted).toBeUndefined();
    // A lifted chat is an ordinary chat: its newer list head asks for a read.
    expect(onLifted.followups).toEqual([expect.objectContaining({ resource: "dm-messages.catchup", subject: groupOf(1) })]);
    expect(onOff.followups).toEqual([]);
    // The pass never unbinds.
    expect(await scalar("select count(*)::int as n from page_dm_threads where id = $1 and fan_id is not null", [liftedBound])).toBe(1);
  });

  it("the account probe excludes no chat: an unresolved answer is the page's fact, lifted or not", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("probe-unresolvable");
    const threadId = await seedThread(pageId, 1, { reason: null });
    const apply = async () => db().transaction(async (tx) => {
      const page = await getSyncPage(tx as unknown as Database, pageId);
      return fanProfilesProbeModule.apply(tx as unknown as Database, {
        pageId,
        now: new Date(),
        ownRef: OWN,
        // A row an older image asked for names the chat.
        work: { subject: fanOf(1), params: { conversationId: threadId } },
        parsed: [],
        page,
      } as never);
    });
    for (const lifted of [[UNRESOLVABLE], []]) {
      await testDb.pool.query("update sync_pages set lifted_dm_exclusions = $2::text[] where page_id = $1", [pageId, lifted]);
      expect((await apply()).work).toMatchObject({ close: "done", closeReason: "probe_unresolved", result: { resolution: "unresolved" } });
      expect(await reasonOf(threadId)).toBeNull();
    }
  });
});

describe("the migration that takes the unresolvable exclusion off (arena \"vanished chat\", M3b)", () => {
  // Found by its name, not its number: the number is the next free one at merge.
  const found = readdirSync("packages/db/migrations").filter((file) => file.endsWith("_retire_dm_unresolvable_exclusion.sql"));
  const migrationSql = found.length === 1 ? readFileSync(`packages/db/migrations/${found[0]}`, "utf8") : "";

  async function threadRows(): Promise<Array<{ id: string; metadata: Record<string, unknown>; updated_at: Date }>> {
    return (await testDb!.pool.query<{ id: string; metadata: Record<string, unknown>; updated_at: Date }>(
      "select id::text, metadata, updated_at from page_dm_threads order by id",
    )).rows;
  }

  async function pageRows(): Promise<Array<{ page_id: number; lifted_dm_exclusions: string[]; updated_at: Date }>> {
    return (await testDb!.pool.query<{ page_id: number; lifted_dm_exclusions: string[]; updated_at: Date }>(
      "select page_id::int as page_id, lifted_dm_exclusions, updated_at from sync_pages order by page_id",
    )).rows;
  }

  it("lifts the reason on every page, takes it off every thread that carries it, keeps the rest, and asks for no work", async (context) => {
    if (!testDb) return context.skip();
    expect(found).toHaveLength(1);
    const first = await seedPage("migrate-a");
    const second = await seedPage("migrate-b", "live", OWN_2);
    const third = await seedPage("migrate-c", "off", "300000000000000003");
    const bound = await seedThread(first, 1, { reason: UNRESOLVABLE, storedHead: 3 });
    const hidden = await seedThread(first, 2, { reason: UNRESOLVABLE, visible: false });
    const unbound = await seedThread(first, 3, { reason: UNRESOLVABLE, bound: false });
    const missing = await seedThread(first, 4, { reason: MISSING });
    const plain = await seedThread(first, 5, { reason: null });
    const elsewhere = await seedThread(second, 6, { reason: UNRESOLVABLE });
    await testDb.pool.query(
      "update page_dm_threads set metadata = metadata || '{\"unresolvedIdentity\": true, \"keep\": \"me\"}'::jsonb where id = $1",
      [bound],
    );
    // The owner lifted the other reason on one page, this one on another.
    await testDb.pool.query("update sync_pages set lifted_dm_exclusions = array[$2]::text[] where page_id = $1", [first, MISSING]);
    await testDb.pool.query("update sync_pages set lifted_dm_exclusions = array[$2]::text[] where page_id = $1", [second, UNRESOLVABLE]);
    const epoch = "2026-01-01T00:00:00Z";
    await testDb.pool.query("update page_dm_threads set updated_at = $1", [epoch]);
    await testDb.pool.query("update sync_pages set updated_at = $1", [epoch]);
    const work = "select count(*)::int as n from sync_work";
    const workBefore = await scalar(work, []);

    await testDb.pool.query(migrationSql);

    expect((await threadRows()).map((row) => [Number(row.id), row.metadata])).toEqual([
      [bound, { unresolvedIdentity: true, keep: "me" }],
      [hidden, {}],
      [unbound, {}],
      [missing, { messageSyncExcludedReason: MISSING }],
      [plain, {}],
      [elsewhere, {}],
    ]);
    const touched = (await threadRows()).filter((row) => row.updated_at.getTime() !== Date.parse(epoch)).map((row) => Number(row.id));
    expect(touched).toEqual([bound, hidden, unbound, elsewhere]);
    // Every page lifts it — any mode, appended once, the owner's own lifts kept.
    expect((await pageRows()).map((row) => [row.page_id, row.lifted_dm_exclusions, row.updated_at.getTime() !== Date.parse(epoch)])).toEqual([
      [first, [MISSING, UNRESOLVABLE], true],
      [second, [UNRESOLVABLE], false],
      [third, [UNRESOLVABLE], true],
    ]);
    // No work, no demand.
    expect(await scalar(work, [])).toBe(workBefore);

    // Once is all: a second run changes nothing.
    const after = { threads: await threadRows(), pages: await pageRows() };
    await testDb.pool.query(migrationSql);
    expect({ threads: await threadRows(), pages: await pageRows() }).toEqual(after);

    // This release reads the lift for nothing: a list pass over a lifted page
    // assigns the aggregation miss as before and asks for no probe; the owner
    // may take the retired reason off, and still nothing assigns it.
    const pass = () => db().transaction(async (tx) => applyListPage(tx as unknown as Database, {
      pageId: first,
      now: new Date(),
      key: "dm-conversations.head",
      page: listPageMissingPartners([1, 4, 5], OWN),
      generation: null,
      classOf: () => "planned",
    }));
    await unliftExcludedChats(db(), { pageLabel: "migrate-a", reason: UNRESOLVABLE, actor: ACTOR });
    const listed = await pass();
    expect(listed.followups.filter((followup) => followup.resource === "fan-profiles.probe")).toEqual([]);
    for (const threadId of [bound, missing, plain]) expect(await reasonOf(threadId)).not.toBe(UNRESOLVABLE);
  });

  it("waits for an actor transaction in flight, so a reason it read before is never written back", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("migrate-race");
    const threadId = await seedThread(pageId, 1, { reason: UNRESOLVABLE });
    const actor = await testDb.pool.connect();
    const runner = await testDb.pool.connect();
    try {
      // The previous image's list apply: the generation fence on its page row
      // (lockOwnedPage, `for share` for an apply), then the chat as it is.
      await actor.query("begin");
      await actor.query("select sp.page_id from sync_pages sp where sp.page_id = $1 for share of sp", [pageId]);
      const read = await actor.query<{ metadata: Record<string, unknown> }>("select metadata from page_dm_threads where id = $1", [threadId]);
      expect(read.rows[0]!.metadata).toEqual({ messageSyncExcludedReason: UNRESOLVABLE });

      let migrated = false;
      const migration = (async () => {
        await runner.query("begin");
        await runner.query(migrationSql);
        await runner.query("commit");
        migrated = true;
      })();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(migrated).toBe(false);

      // Its list writer writes back the reason it read (the old keep rule).
      await actor.query(
        `update page_dm_threads set metadata = (metadata - 'messageSyncExcludedReason') || $2::jsonb, updated_at = clock_timestamp()
          where id = $1`,
        [threadId, JSON.stringify(read.rows[0]!.metadata)],
      );
      await actor.query("commit");
      await migration;
      expect(migrated).toBe(true);
      expect(await reasonOf(threadId)).toBeNull();

      // The next apply starts after the commit and reads the lift with the
      // chat cleared: the previous image's list keeps no lifted reason on a
      // bound chat, and its probe assigns none.
      await actor.query("begin");
      const page = await actor.query<{ lifted: string[] }>(
        "select sp.lifted_dm_exclusions as lifted from sync_pages sp where sp.page_id = $1 for share of sp",
        [pageId],
      );
      expect(page.rows[0]!.lifted).toEqual([UNRESOLVABLE]);
      const thread = await actor.query<{ metadata: Record<string, unknown>; bound: boolean }>(
        "select metadata, fan_id is not null as bound from page_dm_threads where id = $1",
        [threadId],
      );
      expect(thread.rows[0]).toEqual({ metadata: {}, bound: true });
      await actor.query("commit");
    } finally {
      actor.release();
      runner.release();
    }
  });

  it("waits for an erasure in flight (its execution lock) while holding no row, so the erasure's own row locks never wait on it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("migrate-erasure");
    const first = await seedThread(pageId, 1, { reason: UNRESOLVABLE });
    const second = await seedThread(pageId, 2, { reason: UNRESOLVABLE });
    const runner = await testDb.pool.connect();
    const erasing = await testDb.pool.connect();
    try {
      let migrated = false;
      let migration: Promise<void> = Promise.resolve();
      await withErasureExecutionLock({ pool: testDb.pool } as never, async () => {
        migration = (async () => {
          await runner.query("begin");
          await runner.query(migrationSql);
          await runner.query("commit");
          migrated = true;
        })();
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(migrated).toBe(false);
        // The erasure's own locks meanwhile — a fan's threads in id order, the
        // page row — are free: the migration waits before taking any row.
        await erasing.query("begin");
        await erasing.query("set local lock_timeout = '2s'");
        await erasing.query("select t.id from page_dm_threads t where t.id = any($1::bigint[]) order by t.id for update of t", [[first, second]]);
        await erasing.query("select sp.page_id from sync_pages sp where sp.page_id = $1 for update", [pageId]);
        await erasing.query("commit");
        expect(migrated).toBe(false);
      });
      await migration;
      expect(migrated).toBe(true);
      expect(await reasonOf(first)).toBeNull();
      expect(await reasonOf(second)).toBeNull();
    } finally {
      runner.release();
      erasing.release();
    }
  });

  it("holds the actor back until it commits: an apply that starts meanwhile reads the lift and the cleared chat", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("migrate-race-2");
    const threadId = await seedThread(pageId, 1, { reason: UNRESOLVABLE });
    const actor = await testDb.pool.connect();
    const runner = await testDb.pool.connect();
    try {
      await runner.query("begin");
      await runner.query(migrationSql);
      let fenced = false;
      const apply = (async () => {
        await actor.query("begin");
        await actor.query("select sp.page_id from sync_pages sp where sp.page_id = $1 for share of sp", [pageId]);
        fenced = true;
        const seen = await actor.query<{ lifted: string[]; metadata: Record<string, unknown> }>(
          `select sp.lifted_dm_exclusions as lifted, t.metadata
             from sync_pages sp join page_dm_threads t on t.platform_account_id = sp.page_id
            where sp.page_id = $1 and t.id = $2`,
          [pageId, threadId],
        );
        await actor.query("commit");
        return seen.rows[0]!;
      })();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fenced).toBe(false);
      await runner.query("commit");
      expect(await apply).toEqual({ lifted: [UNRESOLVABLE], metadata: {} });
    } finally {
      actor.release();
      runner.release();
    }
  });
});

describe("the migration that closes the probes Fansly answered with its error envelope", () => {
  // Found by its name, not its number: the number is the next free one at merge.
  const found = readdirSync("packages/db/migrations").filter((file) => file.endsWith("_sync_excluded_probe_not_served.sql"));
  const migrationSql = found.length === 1 ? readFileSync(`packages/db/migrations/${found[0]}`, "utf8") : "";

  interface RecordedAnswer {
    status: number;
    body: string;
    /** The demand revision the attempt served (default 1). */
    demandRevision?: number;
    /** No HTTP answer at all (a transport error): nothing journaled. */
    transport?: boolean;
  }

  /** One recorded attempt of a work, as the capture writes it: the raw answer
   *  journaled under `dm_messages:failed`, the attempt pointing at it. */
  async function recordAttempt(pageId: number, workId: number, resource: string, subject: string, k: number, recorded: RecordedAnswer) {
    let observation: { observationId: number; receivedAt: Date } | null = null;
    if (recorded.transport !== true) {
      const payload = { status: recorded.status, contentType: "application/json; charset=utf-8", retryAfter: null, bodyText: recorded.body, truncated: false };
      observation = await insertObservation(db(), {
        source: "pull",
        producer: `fansly-sync:${resource}`,
        platform: "fansly",
        accountId: pageId,
        nativeAccountRef: OWN,
        kind: "dm_messages:failed",
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `test:${workId}:${k}`,
      });
    }
    const inserted = await testDb!.pool.query<{ id: string }>(
      `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, demand_revision,
              setting_ms, jitter_u, pause_ms, operation, request, outcome, send_mark, sent_at, completed_at, http_status,
              error_class, observation_id, observation_received_at, apply_state)
       values ($1, false, $2, $3, $4, 'planned', 1, $5, 2500, 0.1, 2750, 'messages.page', '{}'::jsonb, $6, 'request_start',
               clock_timestamp(), clock_timestamp(), $7, $8, $9, $10, 'none')
       returning id::text as id`,
      [
        pageId, workId, resource, subject, recorded.demandRevision ?? 1,
        recorded.transport === true ? "transport_error" : "response",
        recorded.transport === true ? null : recorded.status,
        recorded.transport === true ? "network" : recorded.status === 403 ? "subject_terminal" : "subject_failure",
        observation?.observationId ?? null, observation?.receivedAt ?? null,
      ],
    );
    return Number(inserted.rows[0]!.id);
  }

  interface WorkSnapshot {
    id: string; state: string; close_reason: string | null; result: Record<string, unknown> | null; failure_count: number;
    breaker_until: Date | null; blocked_by_vendor_at: Date | null; waiting_reason: string | null; applied_revision: string;
    updated_at: Date;
  }

  async function workById(workId: number): Promise<WorkSnapshot> {
    return (await testDb!.pool.query<WorkSnapshot>(
      `select id::text, state, close_reason, result, failure_count, breaker_until, blocked_by_vendor_at, waiting_reason,
              applied_revision::text, updated_at
         from sync_work where id = $1`,
      [workId],
    )).rows[0]!;
  }

  it("closes an open probe whose latest answer is Fansly's error envelope, with its evidence; leaves every other probe", async (context) => {
    if (!testDb) return context.skip();
    expect(found).toHaveLength(1);
    const pageId = await seedPage("migrate");
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await seedThread(pageId, n, { reason: MISSING, ageMs: n * HOUR });
    const request = await probe("migrate", 7);
    const workOf = new Map(request.chats.map((chat) => [Number(chat.chat.slice(-5)), chat.workId]));
    const envelope = JSON.stringify(GROUP_MESSAGES_500);
    const html = "<html><body>502 Bad Gateway</body></html>";
    const record = async (n: number, answers: RecordedAnswer[]) => {
      const ids: number[] = [];
      for (const [k, recorded] of answers.entries()) ids.push(await recordAttempt(pageId, workOf.get(n)!, EXCLUDED_CHAT_PROBE_KEY, groupOf(n), k, recorded));
      return ids;
    };
    // The old rule's state of a probe that failed on the subject's ladder.
    const blocked = async (n: number, failures: number) => testDb!.pool.query(
      `update sync_work set failure_count = $2, breaker_until = now() + interval '1 day', blocked_by_vendor_at = now() - interval '1 day',
              waiting_reason = 'blocked_by_vendor', waiting_until = now() + interval '1 day', last_error_class = 'subject_failure',
              updated_at = '2026-01-01T00:00:00Z'
        where id = $1`,
      [workOf.get(n)!, failures],
    );

    // 1: lilly-1's case — every answer the 500 with the envelope (a transport error between).
    const lilly = await record(1, [
      { status: 500, body: envelope }, { status: 0, body: "", transport: true }, { status: 500, body: envelope }, { status: 500, body: envelope },
    ]);
    await blocked(1, 4);
    // 2: the envelope, then a proxy's page: its latest answer is no chat's answer — left to the engine.
    await record(2, [{ status: 500, body: envelope }, { status: 502, body: html }]);
    await blocked(2, 2);
    // 3: closed meanwhile by a 403 (the old rule's own close): not open, untouched.
    await record(3, [{ status: 500, body: envelope }, { status: 403, body: JSON.stringify({ success: false }) }]);
    await testDb.pool.query(
      `update sync_work set state = 'done', closed_at = now(), close_reason = 'not_served:403', applied_revision = 1,
              result = '{"served": false, "httpStatus": 403, "errorClass": "subject_terminal"}'::jsonb, updated_at = '2026-01-01T00:00:00Z'
        where id = $1`,
      [workOf.get(3)!],
    );
    // 4: a bare `success: false` and 5: an envelope without details — not Fansly's error envelope.
    await record(4, [{ status: 500, body: JSON.stringify({ success: false }) }]);
    await blocked(4, 1);
    await record(5, [{ status: 500, body: JSON.stringify({ success: false, error: { code: 500 } }) }]);
    await blocked(5, 1);
    // 6: the envelope answered an older demand; the owner asked again since.
    await record(6, [{ status: 500, body: envelope, demandRevision: 1 }]);
    await blocked(6, 1);
    await testDb.pool.query("update sync_work set demand_revision = 2 where id = $1", [workOf.get(6)!]);
    // 7: never answered (no attempt yet).
    await testDb.pool.query("update sync_work set updated_at = '2026-01-01T00:00:00Z' where id = $1", [workOf.get(7)!]);
    // A manual probe answered the same 500 is no excluded-chat probe.
    await upsertManualProbe(pageId);
    const manualId = Number((await testDb.pool.query<{ id: string }>(
      "select id::text from sync_work where page_id = $1 and resource = 'probe.manual'",
      [pageId],
    )).rows[0]!.id);
    await recordAttempt(pageId, manualId, "probe.manual", "", 0, { status: 500, body: envelope });
    await testDb.pool.query("update sync_work set updated_at = '2026-01-01T00:00:00Z' where id = $1", [manualId]);
    const before = new Map(await Promise.all([2, 3, 4, 5, 6, 7].map(async (n) => [n, await workById(workOf.get(n)!)] as const)));

    await testDb.pool.query(migrationSql);

    expect(await workById(workOf.get(1)!)).toMatchObject({
      state: "done",
      close_reason: "not_served:500",
      result: {
        served: false,
        httpStatus: 500,
        errorClass: "subject_failure",
        attemptId: lilly[3],
        observationId: expect.any(Number),
        attemptIds: lilly,
        closedBy: "migration sync_excluded_probe_not_served",
      },
      failure_count: 0,
      breaker_until: null,
      blocked_by_vendor_at: null,
      waiting_reason: null,
      applied_revision: "1",
    });
    const observationId = Number((await workById(workOf.get(1)!)).result!.observationId);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts where id = $1 and observation_id = $2", [lilly[3], observationId])).toBe(1);
    for (const [n, row] of before) expect(await workById(workOf.get(n)!), String(n)).toEqual(row);
    expect((await workById(manualId)).state).toBe("open");
    expect(await holds(pageId)).toEqual([]);

    // Once is all: a second run changes nothing.
    const closed = await workById(workOf.get(1)!);
    await testDb.pool.query(migrationSql);
    expect(await workById(workOf.get(1)!)).toEqual(closed);

    // The report reads it finished, and keeps its evidence once the journal of attempts is trimmed (30 days).
    const report = await readExcludedProbeReport(db(), { pageLabel: "migrate" });
    expect(report.chats.find((chat) => chat.chat === groupOf(1))).toMatchObject({ verdict: "not_served", httpStatus: 500, attemptIds: lilly, observationId });
    expect(report.summary).toMatchObject({ probed: 7, served: 0, notServed: 2, pending: 5 });
    await testDb.pool.query("delete from sync_attempts where work_id = $1", [workOf.get(1)!]);
    const trimmed = await readExcludedProbeReport(db(), { pageLabel: "migrate" });
    expect(trimmed.chats.find((chat) => chat.chat === groupOf(1))).toMatchObject({ verdict: "not_served", attemptIds: lilly, observationId });
  });

  async function upsertManualProbe(pageId: number) {
    await testDb!.pool.query(
      `insert into sync_work (page_id, resource, subject, kind, class, params)
       values ($1, 'probe.manual', '', 'trigger', 'planned', '{"operation": "messages.page", "params": {}}'::jsonb)`,
      [pageId],
    );
  }
});
