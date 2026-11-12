// A fan's account state on a page (0374, fan-account-state-v1), on a real
// database: the «not seen» streak the trigger keeps for every writer, the
// answer-time guard of the page's answer, the page's periodic re-check
// (`fan-profiles.recheck`: its due set, its order, its pace — through the real
// actor and commits, only the transport scripted) and the public reader's two
// new demands.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countFanslyPublicLookupDemand,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePollRows,
  fanslyPublicLookupDemandWindows,
  getSyncPage,
  listFanslyAccountRecheckDue,
  pickFanslyPublicLookupBatch,
  recordFanPageAccountLookupAnswers,
  recordFanslyAccountProbe,
  recordOnlyfansAccountCheck,
  upsertFans,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyAccount, FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { createEngineRegistry, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { FAN_PROFILES_RECHECK_KEY } from "../apps/runtime/src/sync/fansly/resources/fan-profiles.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { countRows, makeTestActor, okResponse, ScriptedLiveTransport, seedSyncPage, waitFor } from "./helpers/sync-engine-host.ts";

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

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

async function fanslyPage(label: string): Promise<number> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  return (await createFanslyPage(db(), { modelId: model!.id, label }))!.id;
}

/** A Fansly fan linked to the page (no answer yet); his fan id. */
async function linkedFan(pageId: number, ref: string, netMills = 0): Promise<number> {
  const [fan] = await upsertFans(db(), [{ platform: "fansly", platformUserId: ref }]);
  await q(
    `insert into page_fans (fan_id, platform_account_id, total_creator_net_mills) values ($1, $2, $3)
     on conflict (fan_id, platform_account_id) do update set total_creator_net_mills = excluded.total_creator_net_mills`,
    [fan!.id, pageId, netMills],
  );
  return fan!.id;
}

/** The page's answer for the fan, written as any writer writes it (the previous image's plain UPDATE too). */
async function answer(pageId: number, ref: string, resolved: boolean, at: Date) {
  await q(
    `update page_fans set account_probe_at = $3, account_probe_resolved = $4
      where platform_account_id = $1 and fan_id = (select id from fans where platform = 'fansly' and platform_user_id = $2)`,
    [pageId, ref, at, resolved],
  );
}

/** A link of a «not seen» streak whose start is unknown (written before 0374): the trigger is skipped. */
async function unknownStart(pageId: number, ref: string, at: Date) {
  const client = await testDb!.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(
      `update page_fans set account_probe_at = $3, account_probe_resolved = false, account_miss_since = null
        where platform_account_id = $1 and fan_id = (select id from fans where platform = 'fansly' and platform_user_id = $2)`,
      [pageId, ref, at],
    );
    await client.query("commit");
  } finally {
    client.release();
  }
}

async function link(pageId: number, ref: string) {
  const rows = await q(
    `select pf.account_probe_at as at, pf.account_probe_resolved as resolved, pf.account_miss_since as since,
            pf.account_contactability as contactability
       from page_fans pf join fans f on f.id = pf.fan_id
      where pf.platform_account_id = $1 and f.platform_user_id = $2`,
    [pageId, ref],
  );
  return rows.rows[0] as { at: Date | null; resolved: boolean | null; since: Date | null; contactability: string | null };
}

async function publicCheck(ref: string, found: boolean, at: Date) {
  await q("update fans set public_checked_at = $2, public_found = $3 where platform = 'fansly' and platform_user_id = $1", [ref, at, found]);
}

describe("the «not seen» streak (page_fans.account_miss_since)", () => {
  it("starts at the first miss, is kept through misses, cleared by a seen answer, and starts anew at the next miss — for every writer", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await fanslyPage("streak-1");
    const FAN = "720000000000000001";
    const fanId = await linkedFan(pageId, FAN);
    expect(await link(pageId, FAN)).toMatchObject({ at: null, resolved: null, since: null });

    const t1 = new Date("2026-11-01T10:00:00.000Z");
    const t2 = new Date("2026-11-03T10:00:00.000Z");
    const t3 = new Date("2026-11-05T10:00:00.000Z");
    const t4 = new Date("2026-11-07T10:00:00.000Z");
    const t5 = new Date("2026-11-09T10:00:00.000Z");
    await recordFanPageAccountLookupAnswers(db(), { platformAccountId: pageId, answeredAt: t1, resolvedFanIds: [], unresolvedFanIds: [fanId] });
    expect(await link(pageId, FAN)).toEqual({ at: t1, resolved: false, since: t1, contactability: null });
    // Not seen again: the latest check moves, the start stays.
    await recordFanslyAccountProbe(db(), { platformAccountId: pageId, platformUserId: FAN, probedAt: t2, resolved: false });
    expect(await link(pageId, FAN)).toMatchObject({ at: t2, resolved: false, since: t1 });
    // Seen: no streak.
    await recordFanPageAccountLookupAnswers(db(), { platformAccountId: pageId, answeredAt: t3, resolvedFanIds: [fanId], unresolvedFanIds: [] });
    expect(await link(pageId, FAN)).toMatchObject({ at: t3, resolved: true, since: null });
    // The previous image's writer (a plain UPDATE that never names the column): a new streak.
    await answer(pageId, FAN, false, t4);
    expect(await link(pageId, FAN)).toMatchObject({ at: t4, resolved: false, since: t4 });
    // Nobody writes the start by hand: false → false keeps it.
    await q("update page_fans set account_miss_since = $2 where platform_account_id = $1", [pageId, t1]);
    expect((await link(pageId, FAN)).since).toEqual(t4);

    // A streak from before 0374 keeps an unknown start through further misses.
    await unknownStart(pageId, FAN, t4);
    await answer(pageId, FAN, false, t5);
    expect(await link(pageId, FAN)).toMatchObject({ at: t5, resolved: false, since: null });

    // An inserted «not seen» row starts its streak at its own answer.
    const OTHER = "720000000000000002";
    const [other] = await upsertFans(db(), [{ platform: "fansly", platformUserId: OTHER }]);
    await q("insert into page_fans (fan_id, platform_account_id, account_probe_at, account_probe_resolved) values ($1, $2, $3, false)", [other!.id, pageId, t2]);
    expect((await link(pageId, OTHER)).since).toEqual(t2);
  });
});

describe("the page's answer is dated when it arrived and never replaces a newer one", () => {
  it("each writer keeps a newer answer, and applies one at the same instant or later", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await fanslyPage("guard-1");
    const FAN = "730000000000000001";
    const fanId = await linkedFan(pageId, FAN);
    const newer = new Date("2026-11-05T10:00:00.000Z");
    const older = new Date("2026-11-04T10:00:00.000Z");

    await recordFanPageAccountLookupAnswers(db(), { platformAccountId: pageId, answeredAt: newer, resolvedFanIds: [fanId], unresolvedFanIds: [] });
    await recordFanPageAccountLookupAnswers(db(), { platformAccountId: pageId, answeredAt: older, resolvedFanIds: [], unresolvedFanIds: [fanId] });
    expect(await link(pageId, FAN)).toMatchObject({ at: newer, resolved: true, since: null });
    await recordFanslyAccountProbe(db(), { platformAccountId: pageId, platformUserId: FAN, probedAt: older, resolved: false });
    expect(await link(pageId, FAN)).toMatchObject({ at: newer, resolved: true });
    // The same answer applied again (a re-apply from the journal) is the same answer.
    await recordFanslyAccountProbe(db(), { platformAccountId: pageId, platformUserId: FAN, probedAt: newer, resolved: false });
    expect(await link(pageId, FAN)).toMatchObject({ at: newer, resolved: false, since: newer });

    // OnlyFans: the same guard.
    const model = await createModel(db(), { slug: "of-guard", name: "OF" });
    const ofPage = (await createOnlyFansPage(db(), { modelId: model!.id, label: "of-guard" }))!.id;
    const [ofFan] = await upsertFans(db(), [{ platform: "onlyfans", platformUserId: "7001" }]);
    await q("insert into page_fans (fan_id, platform_account_id) values ($1, $2)", [ofFan!.id, ofPage]);
    await recordOnlyfansAccountCheck(db(), {
      platformAccountId: ofPage, answeredAt: newer, askedFanIds: [ofFan!.id], answers: [{ fanId: ofFan!.id, contactability: "contactable" }],
    });
    await recordOnlyfansAccountCheck(db(), {
      platformAccountId: ofPage, answeredAt: older, askedFanIds: [ofFan!.id], answers: [{ fanId: ofFan!.id, contactability: "gone" }],
    });
    const ofLink = (await q("select account_probe_at as at, account_probe_resolved as resolved, account_contactability as c from page_fans where platform_account_id = $1", [ofPage])).rows[0];
    expect(ofLink).toEqual({ at: newer, resolved: true, c: "contactable" });
  });
});

describe("the page's re-check (fan-profiles.recheck)", () => {
  it("derives its due ids: a browser's word first, then open episodes' partners, then paying fans, the oldest first, each once", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await fanslyPage("recheck-due");
    const otherPage = await fanslyPage("recheck-other");
    const id = (n: number) => `74000000000000000${n}`;
    const [SIGNAL_OLD, SIGNAL_NEW, SIGNAL_ANSWERED, PARTNER, PARTNER_UNLINKED, PARTNER_FRESH, PAYER_NEVER, PAYER_GONE] =
      [1, 2, 3, 4, 5, 6, 7, 8].map(id) as [string, string, string, string, string, string, string, string];
    const PAYER_FRESH = "740000000000000010";
    const NOT_PAYING = "740000000000000011";
    const ENDED_PARTNER = "740000000000000012";
    const OTHER_PAGE_SIGNAL = "740000000000000013";

    // A browser's word newer than the page's answer, or with none; one the page answered after is not due.
    await linkedFan(pageId, SIGNAL_OLD, 5_000);
    await answer(pageId, SIGNAL_OLD, true, ago(3 * HOUR));
    await linkedFan(pageId, SIGNAL_NEW);
    await linkedFan(pageId, SIGNAL_ANSWERED);
    await answer(pageId, SIGNAL_ANSWERED, true, ago(4 * HOUR));
    const signal = async (page: number, ref: string, at: Date) => q(
      `update page_fans set account_client_seen = false, account_client_seen_at = $3
        where platform_account_id = $1 and fan_id = (select id from fans where platform_user_id = $2)`,
      [page, ref, at],
    );
    await signal(pageId, SIGNAL_OLD, ago(2 * HOUR));
    await signal(pageId, SIGNAL_NEW, ago(HOUR));
    await signal(pageId, SIGNAL_ANSWERED, ago(5 * HOUR));
    await linkedFan(otherPage, OTHER_PAGE_SIGNAL);
    await signal(otherPage, OTHER_PAGE_SIGNAL, ago(HOUR));

    // Open episodes (refusing or established): the partner's answer absent or older than the opening.
    const thread = async (group: string, partner: string, fanId: number | null) => Number((await q(
      `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id)
       values ($1, $2, $3, $4) returning id`,
      [pageId, fanId, group, partner],
    )).rows[0].id);
    const episode = async (threadId: number, openedAt: Date, ended = false) => q(
      `insert into page_dm_thread_unavailability (thread_id, state, opened_at, refusals, last_refusal_at, first_attempt_id,
              last_attempt_id, first_observation_id, first_observation_received_at, last_observation_id,
              last_observation_received_at, ended_at, end_reason)
       values ($1, 'refusing', $2, 1, $2, 1, 1, 1, $2, 1, $2, $3, $4)`,
      [threadId, openedAt, ended ? new Date() : null, ended ? "read_served" : null],
    );
    const partnerFan = await linkedFan(pageId, PARTNER);
    await answer(pageId, PARTNER, true, ago(11 * HOUR));
    await episode(await thread("750000000000000001", PARTNER, partnerFan), ago(10 * HOUR));
    // A partner with no link to the page is not asked: nothing would keep his answer.
    await episode(await thread("750000000000000002", PARTNER_UNLINKED, null), ago(20 * HOUR));
    const freshFan = await linkedFan(pageId, PARTNER_FRESH);
    await answer(pageId, PARTNER_FRESH, false, ago(HOUR));
    await episode(await thread("750000000000000003", PARTNER_FRESH, freshFan), ago(2 * HOUR));
    const endedFan = await linkedFan(pageId, ENDED_PARTNER);
    await episode(await thread("750000000000000004", ENDED_PARTNER, endedFan), ago(30 * HOUR), true);

    // Paying fans: never asked first, then the oldest answer over 72 hours, a gone one too.
    await linkedFan(pageId, PAYER_NEVER, 1_000);
    await linkedFan(pageId, PAYER_GONE, 1_000);
    await answer(pageId, PAYER_GONE, false, ago(100 * HOUR));
    await linkedFan(pageId, PAYER_FRESH, 1_000);
    await answer(pageId, PAYER_FRESH, true, ago(10 * HOUR));
    await linkedFan(pageId, NOT_PAYING);

    const due = await listFanslyAccountRecheckDue(db(), { pageId, now: new Date(), limit: 100 });
    expect(due).toEqual([
      { platformUserId: SIGNAL_OLD, reason: "client_signal" },
      { platformUserId: SIGNAL_NEW, reason: "client_signal" },
      { platformUserId: PARTNER, reason: "episode_partner" },
      { platformUserId: PAYER_NEVER, reason: "payer" },
      { platformUserId: PAYER_GONE, reason: "payer" },
    ]);
    expect(await listFanslyAccountRecheckDue(db(), { pageId, now: new Date(), limit: 2 })).toEqual(due.slice(0, 2));
  });

  it("asks the due ids through the page, dates the answer by its arrival, and asks at most once in 5 minutes", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const registry: EngineRegistry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
    // Every standing row parked ahead: only what the test makes due runs.
    await ensurePollRows(db(), {
      pageId,
      polls: pollsFor(registry, (await getSyncPage(db(), pageId))!).map((poll) => ({ ...poll, phase: 0.999 })),
    });
    const SEEN = "760000000000000001";
    const GONE = "760000000000000002";
    await linkedFan(pageId, SEEN, 10_000);
    await linkedFan(pageId, GONE, 10_000);

    const lookups: string[][] = [];
    const accounts = new Map<string, FanslyAccount>([[SEEN, { id: SEEN, username: "seen_fan", displayName: "Seen", createdAt: 1_770_000_000_000, notes: [] }]]);
    const respond = (req: FanslyWireRequest): FanslyWireOutcome => {
      if (req.spec !== "accounts.by_ids") throw new Error(`unexpected ${req.spec}`);
      const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",");
      lookups.push(ids);
      return okResponse(ids.flatMap((asked) => accounts.get(asked) ?? []));
    };
    const run = async (settled: () => Promise<boolean>) => {
      const transport = new ScriptedLiveTransport();
      transport.respond = respond;
      const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry, transport });
      const running = actor.run({ stop: stop.signal, abort: abort.signal });
      try {
        await waitFor(async () => ((await settled()) ? true : null), 30_000, "the re-check to settle");
      } finally {
        stop.abort();
        await running;
      }
    };
    const applied = () => countRows(
      testDb!.pool,
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and apply_state = 'applied'",
      [pageId, FAN_PROFILES_RECHECK_KEY],
    );
    const makeDue = () => q(
      "update sync_work set due_at = clock_timestamp(), waiting_reason = null, waiting_until = null where page_id = $1 and resource = $2 and state = 'open'",
      [pageId, FAN_PROFILES_RECHECK_KEY],
    );
    const resting = async () => {
      const rows = (await q(
        "select waiting_reason, due_at from sync_work where page_id = $1 and resource = $2 and state = 'open'",
        [pageId, FAN_PROFILES_RECHECK_KEY],
      )).rows;
      return rows.length === 1 && rows[0].waiting_reason === "not_due" && rows[0].due_at.getTime() > Date.now() + 2 * 60_000;
    };
    const lastArrival = async () => (await q(
      "select observation_received_at as at from sync_attempts where page_id = $1 and resource = $2 order by id desc limit 1",
      [pageId, FAN_PROFILES_RECHECK_KEY],
    )).rows[0].at as Date;

    // Two paying fans never asked: one request names both.
    await makeDue();
    await run(async () => (await applied()) === 1);
    expect(lookups).toEqual([[SEEN, GONE]]);
    const first = await lastArrival();
    expect(await link(pageId, SEEN)).toMatchObject({ at: first, resolved: true, since: null });
    expect(await link(pageId, GONE)).toMatchObject({ at: first, resolved: false, since: first });
    // The walk row stays open.
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_work where page_id = $1 and resource = $2 and state = 'open'",
      [pageId, FAN_PROFILES_RECHECK_KEY])).toBe(1);

    // A browser's word arrives at once (after the page's answer): within 5 minutes of the last request nothing is
    // asked, the row waits.
    await q(
      `update page_fans set account_client_seen = false, account_client_seen_at = account_probe_at + interval '1 millisecond'
        where platform_account_id = $1 and fan_id = (select id from fans where platform_user_id = $2)`,
      [pageId, SEEN],
    );
    await makeDue();
    await run(resting);
    expect(lookups).toHaveLength(1);

    // 5 minutes on, the word is asked about — alone: the payers' answers are fresh.
    await q("update sync_attempts set admitted_at = admitted_at - interval '6 minutes' where page_id = $1 and resource = $2", [pageId, FAN_PROFILES_RECHECK_KEY]);
    await makeDue();
    await run(async () => (await applied()) === 2);
    expect(lookups).toEqual([[SEEN, GONE], [SEEN]]);
    const second = await lastArrival();
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(await link(pageId, SEEN)).toMatchObject({ at: second, resolved: true });
    expect(await listFanslyAccountRecheckDue(db(), { pageId, now: new Date(), limit: 100 })).toEqual([]);

    // A pass with nothing due asks nothing.
    await q("update sync_attempts set admitted_at = admitted_at - interval '6 minutes' where page_id = $1 and resource = $2", [pageId, FAN_PROFILES_RECHECK_KEY]);
    await makeDue();
    await run(resting);
    expect(lookups).toHaveLength(2);
  });
});

describe("the public reader's demand: a renewed page miss, a marked fan a page sees", () => {
  it("asks after its present classes, each by its own freshness", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await fanslyPage("reader-1");
    const NEVER_CHECKED = "770000000000000001";
    const RENEWED = "770000000000000002";
    const CHECKED_AFTER = "770000000000000003";
    const START_UNKNOWN = "770000000000000004";
    const RENEWED_TODAY = "770000000000000005";
    const MARKED_SEEN = "770000000000000006";
    const MARKED_UNCHECKED = "770000000000000007";
    const MARKED_ANSWER_OLDER = "770000000000000008";
    for (const ref of [NEVER_CHECKED, RENEWED, CHECKED_AFTER, START_UNKNOWN, RENEWED_TODAY, MARKED_SEEN, MARKED_UNCHECKED, MARKED_ANSWER_OLDER]) {
      await linkedFan(pageId, ref);
    }
    // A page lookup miss never checked: the present class, first.
    await answer(pageId, NEVER_CHECKED, false, ago(DAY));
    // Seen, then not seen 2 days ago; checked 5 days ago (found): that check says nothing of the new streak.
    await answer(pageId, RENEWED, true, ago(10 * DAY));
    await answer(pageId, RENEWED, false, ago(2 * DAY));
    await publicCheck(RENEWED, true, ago(5 * DAY));
    // Checked after the streak began: nothing to ask.
    await answer(pageId, CHECKED_AFTER, false, ago(2 * DAY));
    await publicCheck(CHECKED_AFTER, true, ago(DAY));
    // The start is unknown: the 7-day rule alone.
    await unknownStart(pageId, START_UNKNOWN, ago(2 * DAY));
    await publicCheck(START_UNKNOWN, false, ago(5 * DAY));
    // The streak is newer than the check, but the check is under a day old.
    await answer(pageId, RENEWED_TODAY, false, ago(3 * HOUR));
    await publicCheck(RENEWED_TODAY, true, ago(5 * HOUR));
    // The legacy mark on fans the page sees.
    await q("update fans set deleted_detected_at = now() - interval '30 days' where platform_user_id = any($1::text[])", [[MARKED_SEEN, MARKED_UNCHECKED, MARKED_ANSWER_OLDER]]);
    await answer(pageId, MARKED_SEEN, true, ago(DAY));
    await publicCheck(MARKED_SEEN, false, ago(3 * DAY));
    await answer(pageId, MARKED_UNCHECKED, true, ago(2 * DAY));
    await answer(pageId, MARKED_ANSWER_OLDER, true, ago(5 * DAY));
    await publicCheck(MARKED_ANSWER_OLDER, false, ago(3 * DAY));

    const windows = fanslyPublicLookupDemandWindows(new Date());
    const batch = await pickFanslyPublicLookupBatch(db(), { limit: 100, ...windows });
    expect(batch.map((candidate) => [candidate.platformUserId, candidate.demands])).toEqual([
      [NEVER_CHECKED, ["page_lookup_miss"]],
      [RENEWED, ["page_miss_renewed"]],
      [MARKED_UNCHECKED, ["marked_seen"]],
      [MARKED_SEEN, ["marked_seen"]],
    ]);
    const demand = await countFanslyPublicLookupDemand(db(), windows);
    expect(demand.total).toBe(4);
    expect(demand.byDemand).toMatchObject({ page_lookup_miss: 1, page_miss_renewed: 1, marked_seen: 2 });
  });
});
