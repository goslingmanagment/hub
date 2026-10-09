// Arena "vanished chat" R5 (plan §7, owner decisions Р1, Р2 (а), Р3 (а)) —
// the session-less public account reader on a real database.
//
// THE NETWORK IS MOCKED: every pass sends through a fake `send` that returns a
// scripted outcome and records the request, and the no-outbound trap is armed
// for the whole suite — no request leaves the process, to Fansly or anywhere.
// The egress is the real resolver's `fansly_public` scope over a stored fake
// proxy (`*.example.internal`): its dispatcher is built and never used.

import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  setConfigOverride,
  upsertFans,
  type Database,
} from "@agency_hub_core/db";
import { fanslyWireSpec, FANSLY_SESSION_HEADER_NAMES, type FanslyWireOutcome } from "@agency_hub_core/fansly";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND, executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { saveFanslyPublicProxy } from "../apps/runtime/src/services/egress/fansly-public.ts";
import { buildSyncPublicLookupCommandGroup } from "../apps/runtime/src/sync/cli/public-lookup.ts";
import {
  FanslyPublicLookupReader,
  PUBLIC_LOOKUP_LOCK_KEY,
  PUBLIC_LOOKUP_LOCK_NAMESPACE,
  publicLookupNextSendAt,
  type PublicLookupSend,
} from "../apps/runtime/src/sync/fansly/public-lookup.ts";
import { resumeSyncPublicLookup } from "../apps/runtime/src/sync/public-lookup.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsThread } from "./helpers/fansly-ws-capture.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const FANSLY_API = "https://apiv3.fansly.com/api/v1";
/** Marked deleted; the public answer finds it: the mark goes. */
const FOUND_MARKED = "500000000000000001";
/** Marked deleted; not found: the mark stays. */
const GONE_MARKED = "500000000000000002";
/** The partner of an established episode on lora-1. */
const PARTNER = "500000000000000003";
/** Missed by the lookups of lora-1 AND lora-2, and the partner of an episode
 *  on lora-2: asked once. */
const MISSED_TWICE = "500000000000000004";
/** A fan nobody asks about. */
const BYSTANDER = "500000000000000005";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let trap: NoOutboundTrap | null = null;
let pages: { lora1: number; lora2: number };
let sends: Array<{ url: string; headers: Record<string, string> }>;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(async () => {
  await trap?.restore();
  trap = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function rows<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query(text, params)).rows as T[];
}

async function fanRow(ref: string) {
  const [row] = await rows<{
    id: string;
    public_checked_at: Date | null;
    public_found: boolean | null;
    deleted_detected_at: Date | null;
    deleted_last_detected_at: Date | null;
  }>(
    `select id::text, public_checked_at, public_found, deleted_detected_at, deleted_last_detected_at
       from fans where platform = 'fansly' and platform_user_id = $1`,
    [ref],
  );
  return row!;
}

async function enable(on = true) {
  await setConfigOverride(testDb!.db, { key: "fanslyPublicLookupEnabled", value: on, userId: null, groupId: randomUUID() });
}

async function episodeFor(pageId: number, groupId: string, fanRef: string) {
  const threadId = await seedWsThread({ db: db(), pool: testDb!.pool }, { pageId, groupId, fanRef });
  await testDb!.pool.query(
    `insert into page_dm_thread_unavailability (thread_id, state, opened_at, established_at, refusals, last_refusal_at,
            last_http_status, retry_not_before, first_attempt_id, last_attempt_id, first_observation_id,
            first_observation_received_at, last_observation_id, last_observation_received_at)
     values ($1, 'established', now() - interval '2 days', now() - interval '1 day', 5, now() - interval '1 day', 500,
             now() + interval '1 day', 1, 5, 1, now() - interval '2 days', 5, now() - interval '1 day')`,
    [threadId],
  );
  return threadId;
}

async function lookupMiss(pageId: number, fanRef: string) {
  await testDb!.pool.query(
    `insert into page_fans (fan_id, platform_account_id, account_probe_at, account_probe_resolved)
     select f.id, $1, now() - interval '3 days', false from fans f where f.platform = 'fansly' and f.platform_user_id = $2
     on conflict (fan_id, platform_account_id) do update set account_probe_at = excluded.account_probe_at,
       account_probe_resolved = false`,
    [pageId, fanRef],
  );
}

/** A Fansly answer: `success: true`, one account per found id. */
function answer(status: number, body: unknown, headers: Record<string, string> = {}): FanslyWireOutcome {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  return { kind: "response", status, headers, bodyText, bodyBytes: bodyText.length, sendMark: "request_start" };
}

function found(...ids: string[]) {
  return answer(200, { success: true, response: ids.map((id) => ({ id, username: `u${id.slice(-2)}`, flags: 16 })) });
}

/** The mocked network: one scripted outcome per send, the request recorded. */
function scripted(...outcomes: FanslyWireOutcome[]): PublicLookupSend {
  return async (_dispatcher, request, hooks) => {
    sends.push({ url: request.url, headers: request.headers });
    const next = outcomes.shift();
    if (next === undefined) throw new Error("the test sent more requests than it scripted");
    if (next.kind === "response" || ("sent" in next && next.sent)) hooks.check();
    return next;
  };
}

function reader(send: PublicLookupSend, extra: Partial<ConstructorParameters<typeof FanslyPublicLookupReader>[0]> = {}) {
  return new FanslyPublicLookupReader({
    db: db(),
    pool: testDb!.pool,
    config: app.config,
    rawConfig: app.config,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    random: () => 0,
    send,
    ...extra,
  });
}

function askedIds(index = 0): string[] {
  const url = new URL(sends[index]!.url);
  return url.searchParams.get("ids")!.split(",");
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  sends = [];
  app = createTestAppContext(testDb, { fanslyBaseUrl: FANSLY_API });
  const model = await createModel(db(), { slug: "lora", name: "Lora" });
  pages = {
    lora1: (await createFanslyPage(db(), { modelId: model!.id, label: "lora-1" }))!.id,
    lora2: (await createFanslyPage(db(), { modelId: model!.id, label: "lora-2" }))!.id,
  };
  await upsertFans(db(), [FOUND_MARKED, GONE_MARKED, PARTNER, MISSED_TWICE, BYSTANDER]
    .map((platformUserId) => ({ platform: "fansly" as const, platformUserId })));
  await testDb.pool.query(
    `update fans set deleted_detected_at = now() - interval '20 days', deleted_last_detected_at = now() - interval '20 days'
      where platform = 'fansly' and platform_user_id = any($1::text[])`,
    [[FOUND_MARKED, GONE_MARKED]],
  );
  await episodeFor(pages.lora1, "700000000000000001", PARTNER);
  await episodeFor(pages.lora2, "700000000000000002", MISSED_TWICE);
  await lookupMiss(pages.lora1, MISSED_TWICE);
  await lookupMiss(pages.lora2, MISSED_TWICE);
  trap = await armNoOutboundTrap(testDb);
});

async function withProxy() {
  await saveFanslyPublicProxy(app, {
    proxy: { url: "http://reader.example.internal:3128", username: "reader", password: "fake-password" },
    actor: "test",
    note: "the reader's own",
  });
}

async function recheckMarks() {
  const cli = cliWith([]);
  await cli.parseAsync(["public-lookup", "recheck-marks", "--note", "R2 (a)"], { from: "user" });
}

function cliWith(printed: string[]) {
  return buildSyncPublicLookupCommandGroup({
    openContext: async () => ({ db: db(), config: app.config, rawConfig: app.config, logger: app.logger, close: async () => undefined }),
    print: (line) => printed.push(line),
    readStdin: async () => "",
  });
}

describe("the public reader's gates: nothing is journaled or sent", () => {
  it("is off by default, sends nothing without its own proxy, and refuses a session-bearing spec before anything is written", async () => {
    await recheckMarks();
    const off = reader(scripted());
    expect(await off.runOnce()).toEqual({ kind: "disabled" });

    await enable();
    expect(await reader(scripted()).runOnce()).toEqual({ kind: "no_egress", reason: "not_configured" });

    await withProxy();
    // A page's spec (it carries the page's session) handed to the reader.
    const refused = await reader(scripted(found()), { spec: fanslyWireSpec("accounts.by_ids") as never }).runOnce();
    expect(refused.kind).toBe("refused");
    expect(refused.kind === "refused" && refused.error.name).toBe("FanslyCredentialsRefusedError");

    expect(sends).toEqual([]);
    expect(await rows("select 1 from fansly_send_log")).toEqual([]);
    expect(await rows("select 1 from observations where kind like 'account_lookup_public%'")).toEqual([]);
    expect((await fanRow(FOUND_MARKED)).public_checked_at).toBeNull();
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("one pass at a time across processes: a held lock makes the pass busy", async () => {
    await enable();
    await withProxy();
    const holder = await testDb!.pool.connect();
    try {
      await holder.query("select pg_advisory_lock($1, $2)", [PUBLIC_LOOKUP_LOCK_NAMESPACE, PUBLIC_LOOKUP_LOCK_KEY]);
      expect(await reader(scripted(found())).runOnce()).toEqual({ kind: "busy" });
      await holder.query("select pg_advisory_unlock($1, $2)", [PUBLIC_LOOKUP_LOCK_NAMESPACE, PUBLIC_LOOKUP_LOCK_KEY]);
    } finally {
      holder.release();
    }
    expect(sends).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("one request: the demand, the journal before the parse, the answer", () => {
  it("asks each fan once across pages and reasons, journals the raw answer page-less, then writes found / not found and the marks", async () => {
    await enable();
    await withProxy();
    await recheckMarks();
    const pass = await reader(scripted(found(FOUND_MARKED, PARTNER))).runOnce();
    expect(pass).toMatchObject({ kind: "answered", ids: 4 });

    // One request; the owner's queue first, then the partners, each id once.
    expect(sends).toHaveLength(1);
    const ids = askedIds();
    expect(ids.slice(0, 2).sort()).toEqual([FOUND_MARKED, GONE_MARKED].sort());
    expect(ids.slice(2).sort()).toEqual([MISSED_TWICE, PARTNER].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(BYSTANDER);
    // Session-less: nothing of a session on the request, Fansly's API only.
    expect(new URL(sends[0]!.url).origin).toBe("https://apiv3.fansly.com");
    expect(new URL(sends[0]!.url).pathname).toBe("/api/v1/account");
    for (const name of Object.keys(sends[0]!.headers)) expect(FANSLY_SESSION_HEADER_NAMES.has(name), name).toBe(false);

    // The send journal: page-less, its own source; no page's journal moved.
    const journal = await rows<{ page_id: string | null; source: string; operation: string; outcome: string; http_status: number; sent_at: Date | null }>(
      "select page_id, source, operation, outcome, http_status, sent_at from fansly_send_log",
    );
    expect(journal).toEqual([{
      page_id: null, source: "public_lookup", operation: "account_lookup_public", outcome: "response", http_status: 200,
      sent_at: expect.any(Date),
    }]);
    expect(await rows("select 1 from sync_attempts")).toEqual([]);

    // The raw answer, page-less, under the PR10 contract: every asked id named.
    const [observation] = await rows<{ id: string; account_id: string | null; native_account_ref: string | null; platform: string; kind: string; payload: { requestedIds: string[]; status: number; answer: { success: boolean; response: Array<{ id: string }> } }; received_at: Date }>(
      "select id::text, account_id, native_account_ref, platform, kind, payload, received_at from observations where kind like 'account_lookup_public%'",
    );
    expect(observation).toMatchObject({ account_id: null, native_account_ref: null, platform: "fansly", kind: ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND });
    expect(observation!.payload.requestedIds).toEqual(ids);
    expect(observation!.payload.answer.response.map((account) => account.id).sort()).toEqual([FOUND_MARKED, PARTNER].sort());
    expect(pass.kind === "answered" && pass.observationId).toBe(Number(observation!.id));

    // The answer: found / not found on every asked fan; the found mark goes,
    // the missing one stays; nobody else is touched.
    const foundMarked = await fanRow(FOUND_MARKED);
    expect(foundMarked).toMatchObject({ public_found: true, deleted_detected_at: null, deleted_last_detected_at: null });
    // Journaled before it was read: the raw answer is older than the verdict.
    expect(observation!.received_at.getTime()).toBeLessThanOrEqual(foundMarked.public_checked_at!.getTime());
    expect(await fanRow(GONE_MARKED)).toMatchObject({ public_found: false, deleted_detected_at: expect.any(Date) });
    expect(await fanRow(PARTNER)).toMatchObject({ public_found: true, deleted_detected_at: null });
    expect(await fanRow(MISSED_TWICE)).toMatchObject({ public_found: false, deleted_detected_at: null });
    expect(await fanRow(BYSTANDER)).toMatchObject({ public_checked_at: null, public_found: null });
    // Page facts are the pages' own.
    expect(await rows("select account_probe_resolved from page_fans where account_probe_resolved is distinct from false")).toEqual([]);
    expect(pass.kind === "answered" && pass.applied).toEqual({ written: 4, found: 2, notFound: 2, marksCleared: 1, queueDone: 2 });
    expect(await rows("select fan_id::text, found, mark_cleared from fansly_public_lookup_queue order by found")).toEqual([
      { fan_id: (await fanRow(GONE_MARKED)).id, found: false, mark_cleared: false },
      { fan_id: foundMarked.id, found: true, mark_cleared: true },
    ]);

    // Nothing is due again: the next pass waits a minute (its budget) and,
    // once the minute has passed, has nobody to ask (checked under 7 days).
    expect(await reader(scripted()).runOnce()).toMatchObject({ kind: "wait", why: "minute_budget" });
    await testDb!.pool.query("update fansly_send_log set captured_at = captured_at - interval '2 minutes', completed_at = completed_at - interval '2 minutes'");
    expect(await reader(scripted()).runOnce()).toEqual({ kind: "idle" });
    // A week later the partner and the miss are asked again; the queue is done.
    await testDb!.pool.query("update fans set public_checked_at = public_checked_at - interval '8 days' where public_checked_at is not null");
    await reader(scripted(found(PARTNER))).runOnce();
    expect(askedIds(1).sort()).toEqual([MISSED_TWICE, PARTNER].sort());
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("asks at most fanslyPublicLookupBatchSize ids a request", async () => {
    await enable();
    await withProxy();
    await recheckMarks();
    await setConfigOverride(testDb!.db, { key: "fanslyPublicLookupBatchSize", value: 2, userId: null, groupId: randomUUID() });
    await reader(scripted(found())).runOnce();
    expect(askedIds().sort()).toEqual([FOUND_MARKED, GONE_MARKED].sort());
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the budget and the pace, from the reader's own journal", () => {
  async function journalRow(capturedAgoMs: number, completedAgoMs: number | null) {
    await testDb!.pool.query(
      `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role,
              holder_instance, captured_at, completed_at, outcome, http_status)
       values (null, $1::uuid, 'public_lookup', 'account_lookup_public', 'test', 1, 'sync', $2::uuid,
               clock_timestamp() - $3::double precision * interval '1 millisecond',
               case when $4::double precision is null then null
                    else clock_timestamp() - $4::double precision * interval '1 millisecond' end,
               case when $4::double precision is null then null else 'response' end,
               case when $4::double precision is null then null else 200 end)`,
      [randomUUID(), randomUUID(), capturedAgoMs, completedAgoMs],
    );
  }

  beforeEach(async () => {
    await enable();
    await withProxy();
    await recheckMarks();
  });

  it("1 a minute", async () => {
    await journalRow(30_000, 29_000);
    expect(await reader(scripted()).runOnce()).toMatchObject({ kind: "wait", why: "minute_budget" });
    expect(sends).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("50 a day: the 51st waits for the oldest to leave the 24 hours", async () => {
    for (let index = 0; index < 50; index += 1) await journalRow(23 * 3_600_000 - index * 60_000, 23 * 3_600_000 - index * 60_000 - 500);
    const pass = await reader(scripted()).runOnce();
    expect(pass).toMatchObject({ kind: "wait", why: "day_budget" });
    // The oldest was journaled 23 h ago: one more hour.
    expect(pass.kind === "wait" && pass.until.getTime() - Date.now()).toBeGreaterThan(3_500_000);
    expect(sends).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("S × (1 + u) after its own previous completion, whatever the minute budget says", async () => {
    await setConfigOverride(testDb!.db, { key: "fanslyDefaultDelayMs", value: 60_000, userId: null, groupId: randomUUID() });
    await journalRow(70_000, 50_000);
    const pass = await reader(scripted(), { random: () => 0.5 }).runOnce();
    expect(pass).toMatchObject({ kind: "wait", why: "pace" });
    // completed 50 s ago + 60 s × 1.1 = 16 s ahead.
    const ahead = pass.kind === "wait" ? pass.until.getTime() - Date.now() : 0;
    expect(ahead).toBeGreaterThan(14_000);
    expect(ahead).toBeLessThanOrEqual(16_100);
    expect(sends).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("an attempt still in flight holds the next", async () => {
    await journalRow(5_000, null);
    expect(await reader(scripted()).runOnce()).toMatchObject({ kind: "wait" });
    expect(sends).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the rule itself: the latest hold wins, none holds when all have passed", () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const clocks = {
      lastCapturedAt: new Date("2026-10-09T11:59:30.000Z"),
      lastCompletedAt: new Date("2026-10-09T11:59:31.000Z"),
      inFlightSince: null,
      sentLastDay: 3,
      oldestLastDay: new Date("2026-10-09T01:00:00.000Z"),
    };
    expect(publicLookupNextSendAt({ now, clocks, settingMs: 2_500, u: 0.1, retryNotBefore: null }))
      .toEqual({ at: new Date("2026-10-09T12:00:30.000Z"), why: "minute_budget" });
    expect(publicLookupNextSendAt({ now, clocks, settingMs: 60_000, u: 0.2, retryNotBefore: null }))
      .toEqual({ at: new Date("2026-10-09T12:00:43.000Z"), why: "pace" });
    expect(publicLookupNextSendAt({ now, clocks, settingMs: 2_500, u: 0, retryNotBefore: new Date("2026-10-09T13:00:00.000Z") }))
      .toEqual({ at: new Date("2026-10-09T13:00:00.000Z"), why: "retry_after" });
    expect(publicLookupNextSendAt({ now, clocks: { ...clocks, sentLastDay: 50 }, settingMs: 2_500, u: 0, retryNotBefore: null }))
      .toEqual({ at: new Date("2026-10-10T01:00:00.000Z"), why: "day_budget" });
    const later = new Date("2026-10-09T12:05:00.000Z");
    expect(publicLookupNextSendAt({ now: later, clocks, settingMs: 2_500, u: 0.2, retryNotBefore: null }))
      .toEqual({ at: later, why: null });
  });
});

describe("the stop rules: the first failure stops the reader, raises the owner's incident and changes no fan", () => {
  beforeEach(async () => {
    await enable();
    await withProxy();
    await recheckMarks();
  });

  async function incident() {
    const [row] = await rows<{ status: string; error_code: string; error_summary: string; platform_account_id: string | null }>(
      `select status, error_code, error_summary, platform_account_id from notification_incidents
        where kind = 'fansly_sync_engine' and incident_key like '%public_lookup%'`,
    );
    return row ?? null;
  }

  async function fansUntouched() {
    for (const ref of [FOUND_MARKED, GONE_MARKED, PARTNER, MISSED_TWICE]) {
      expect(await fanRow(ref), ref).toMatchObject({ public_checked_at: null, public_found: null });
    }
    expect((await fanRow(FOUND_MARKED)).deleted_detected_at).toBeInstanceOf(Date);
    expect(await rows("select 1 from fansly_public_lookup_queue where done_at is not null")).toEqual([]);
  }

  it.each([
    ["a 429 (its Retry-After kept)", answer(429, "", { "retry-after": "120" }), "rate_limited", 429, "account_lookup_public:failed"],
    ["a 401", answer(401, { success: false, error: { code: 401, details: "unauthorized" } }), "auth_refused", 401, "account_lookup_public:failed"],
    ["a 403", answer(403, "<html>forbidden</html>"), "auth_refused", 403, "account_lookup_public:failed"],
    ["a 500", answer(500, { success: false, error: { code: 500, details: "error" } }), "off_contract", 500, "account_lookup_public:failed"],
    ["a 2xx proxy page", answer(200, "<html>proxy</html>"), "off_contract", 200, "account_lookup_public:failed"],
    ["an account without an id", answer(200, { success: true, response: [{ username: "x" }] }), "off_contract", 200, "account_lookup_public"],
    ["an account nobody asked for", found("599999999999999999"), "off_contract", 200, "account_lookup_public"],
  ] as const)("%s", async (_label, outcome, reason, status, kind) => {
    const pass = await reader(scripted(outcome)).runOnce();
    expect(pass).toMatchObject({ kind: "failed", firstBatch: true, failure: { reason, httpStatus: status } });

    // Journaled before it was read, the requested ids with it — even an
    // answer the contract then refused.
    const journaled = await rows<{ kind: string; payload: { requestedIds: string[] } }>(
      "select kind, payload from observations where kind like 'account_lookup_public%'",
    );
    expect(journaled).toHaveLength(1);
    expect(journaled[0]!.kind).toBe(kind);
    expect(journaled[0]!.payload.requestedIds).toEqual(askedIds());
    await fansUntouched();

    const state = (await rows<{ stop_reason: string; stop_http_status: number; retry_not_before: Date | null; stop_detail: string }>(
      "select stop_reason, stop_http_status, retry_not_before, stop_detail from fansly_public_lookup_state",
    ))[0]!;
    expect(state).toMatchObject({ stop_reason: reason, stop_http_status: status });
    expect(state.stop_detail).toMatch(/^first batch: /);
    if (status === 429) {
      expect(state.retry_not_before!.getTime() - Date.now()).toBeGreaterThan(100_000);
    }
    // The owner's incident: global (no page), it says it was the FIRST batch.
    expect(await incident()).toMatchObject({ status: "open", error_code: reason, platform_account_id: null });
    expect((await incident())!.error_summary).toContain("FIRST batch");

    // Stopped: nothing more is sent, whatever the budget.
    await testDb!.pool.query("update fansly_send_log set captured_at = captured_at - interval '1 hour', completed_at = completed_at - interval '1 hour'");
    expect(await reader(scripted(found())).runOnce()).toEqual({ kind: "stopped", reason });
    expect(sends).toHaveLength(1);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a network failure (sent or not): stopped, nothing journaled as an answer", async () => {
    const pass = await reader(scripted({ kind: "transport_error", sent: false, message: "ECONNREFUSED proxy" })).runOnce();
    expect(pass).toMatchObject({ kind: "failed", failure: { reason: "network", httpStatus: null }, observationId: null });
    expect(await rows("select 1 from observations where kind like 'account_lookup_public%'")).toEqual([]);
    expect(await rows("select outcome from fansly_send_log")).toEqual([{ outcome: "transport_error" }]);
    await fansUntouched();
    expect(await incident()).toMatchObject({ status: "open", error_code: "network" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("after an accepted batch a stop is not the first batch's; resume clears it, resolves the incident and still waits for Retry-After", async () => {
    await reader(scripted(found(FOUND_MARKED))).runOnce();
    await testDb!.pool.query("update fansly_send_log set captured_at = captured_at - interval '2 minutes', completed_at = completed_at - interval '2 minutes'");
    await testDb!.pool.query("update fans set public_checked_at = null, public_found = null where platform_user_id = $1", [PARTNER]);
    const pass = await reader(scripted(answer(429, "", { "retry-after": "600" }))).runOnce();
    expect(pass).toMatchObject({ kind: "failed", firstBatch: false, failure: { reason: "rate_limited" } });
    expect((await incident())!.error_summary).not.toContain("FIRST batch");

    const resumed = await resumeSyncPublicLookup({ db: db(), logger: app.logger }, { note: "checked", actor: "test" });
    expect(resumed.resumed.stopReason).toBe("rate_limited");
    expect(resumed.retryNotBefore).not.toBeNull();
    expect(await incident()).toMatchObject({ status: "resolved" });
    expect(await rows("select event_type from audit_events where event_type = 'admin.fansly_public_lookup_resume'")).toHaveLength(1);
    await testDb!.pool.query("update fansly_send_log set captured_at = captured_at - interval '2 minutes', completed_at = completed_at - interval '2 minutes'");
    expect(await reader(scripted()).runOnce()).toMatchObject({ kind: "wait", why: "retry_after" });
    await expect(resumeSyncPublicLookup({ db: db(), logger: app.logger }, { note: "again", actor: "test" }))
      .rejects.toThrow(/not stopped/);
    expect(sends).toHaveLength(2);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("erasure and the owner's CLI", () => {
  it("a fan erasure takes the page-less raw answer that names the fan, and the fan's queue row (PR10's path)", async () => {
    await enable();
    await withProxy();
    await recheckMarks();
    const pass = await reader(scripted(found(FOUND_MARKED, PARTNER))).runOnce();
    expect(pass.kind).toBe("answered");
    const owner = (await rows<{ id: string }>("insert into users (username, role) values ('owner-erasure', 'owner') returning id::text"))[0]!;
    const appStub = { db: testDb!.db, pool: testDb!.pool, config: { lakeDir: "/nonexistent-lake-dir" }, logger: app.logger } as never;
    await trap!.restore();
    await executeErasure(appStub, { scopeType: "fan", platform: "fansly", fanRef: GONE_MARKED }, { initiatedBy: Number(owner.id) });
    // The whole batch goes with any fan it names (the module's verdict).
    expect(await rows("select 1 from observations where kind like 'account_lookup_public%'")).toEqual([]);
    expect(await rows("select 1 from fans where platform_user_id = $1", [GONE_MARKED])).toEqual([]);
    expect(await rows("select 1 from fansly_public_lookup_queue q join fans f on f.id = q.fan_id where f.platform_user_id = $1", [FOUND_MARKED])).toHaveLength(1);
    expect(await rows("select count(*)::int as n from fansly_public_lookup_queue")).toEqual([{ n: 1 }]);
    // The bystander's verdict stays; its evidence may not (contract item 4).
    expect(await fanRow(FOUND_MARKED)).toMatchObject({ public_found: true });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("status, queue, enable, disable and recheck-marks: read-only views and audited levers, no request", async () => {
    const printed: string[] = [];
    const cli = cliWith(printed);
    await cli.parseAsync(["public-lookup", "status"], { from: "user" });
    expect(printed.join("\n")).toContain("public account reader: off (fanslyPublicLookupEnabled), 100 ids a request");
    expect(printed.join("\n")).toContain("next pass: nothing: the reader is off");

    await cli.parseAsync(["public-lookup", "recheck-marks", "--note", "R2 (a)"], { from: "user" });
    expect(printed.at(-1)).toMatch(/^2 fans carry the deleted mark: 2 queued, 0 were already pending — about 1 request\(s\) of 100 ids/);
    await cli.parseAsync(["public-lookup", "recheck-marks", "--note", "again"], { from: "user" });
    expect(printed.at(-1)).toMatch(/2 queued|0 queued, 2 were already pending/);

    printed.length = 0;
    await cli.parseAsync(["public-lookup", "queue", "--limit", "10"], { from: "user" });
    expect(printed[0]).toBe("4 fan(s) next (owner's re-check first, then episode partners, then page lookup misses)");
    // MISSED_TWICE is named by two pages' misses and an episode: one row, both reasons.
    expect(printed.slice(2).map((line) => line.split("\t")[3]).sort()).toEqual([
      "deleted_mark", "deleted_mark", "episode_partner", "episode_partner,page_lookup_miss",
    ]);
    expect(printed.slice(2, 4).map((line) => line.split("\t")[3])).toEqual(["deleted_mark", "deleted_mark"]);

    await cli.parseAsync(["public-lookup", "enable", "--note", "go"], { from: "user" });
    expect(printed.at(-1)).toBe("next pass: nothing: no proxy of its own (sync public-lookup proxy set)");
    await withProxy();
    printed.length = 0;
    await cli.parseAsync(["public-lookup", "status", "--json"], { from: "user" });
    const status = JSON.parse(printed.join("\n"));
    expect(status).toMatchObject({
      enabled: true,
      batchSize: 100,
      state: { stopped: false },
      demand: { total: 4, byDemand: { deleted_mark: 2, episode_partner: 2, page_lookup_miss: 1 } },
      progress: { queuePending: 2, marksRemaining: 2 },
      next: "one request of up to 100 ids, now",
    });
    await cli.parseAsync(["public-lookup", "disable", "--note", "stop"], { from: "user" });
    expect(await rows("select event_type from audit_events where event_type in ('admin.config_update', 'admin.fansly_public_lookup_recheck_marks') order by id"))
      .toEqual([
        { event_type: "admin.fansly_public_lookup_recheck_marks" },
        { event_type: "admin.fansly_public_lookup_recheck_marks" },
        { event_type: "admin.config_update" },
        { event_type: "admin.config_update" },
      ]);
    await expect(cli.parseAsync(["public-lookup", "resume", "--note", "nothing"], { from: "user" })).rejects.toThrow(/not stopped/);
    expect(sends).toEqual([]);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
