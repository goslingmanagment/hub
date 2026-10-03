import type { Pool } from "pg";

import { createFanslyPage, createModel, ensureSyncPage, type Database } from "@agency_hub_core/db";

import type { RouteAdmissionIntervals } from "../../apps/runtime/src/sync/engine/route-policy.ts";
import { FAMILY_BUDGETS, familyOfRoute, intervalMsOf, routeBudget, type FanslyRoute } from "../../apps/runtime/src/sync/fansly/routes.ts";
import type { AcceptanceCheckName, CheckVerdict, PageVerdict } from "../../apps/runtime/src/sync/switch/acceptance-rules.ts";

// The shared fixtures of the live-hour acceptance (step 3b A6, plan PR 1-11):
// one database with a page per scenario, all switched within seconds of each
// other an hour and a quarter ago, so `pnpm cli sync switch check` judges one
// complete shared window. Each page starts from a healthy hour — the legacy
// engine reading /message every 2.5 s until 45 s before live (denser than the
// route's budget: not the budget's sends), then an engine send every 5 s
// rotating over four routes well inside their budgets, each attempt recording
// the pause and the route and family intervals its admission applied (as the
// runtime does), the first media request 17 s after live, ten-plus samples of
// every latency SLO — and its scenario changes only what it is about.

/** What an admission on `route` records at the table's `current` rates. */
export function currentIntervals(route: FanslyRoute): RouteAdmissionIntervals {
  const family = familyOfRoute(route);
  return {
    routeIntervalMs: intervalMsOf(routeBudget(route).currentPerMin),
    familyIntervalMs: family === null ? null : intervalMsOf(FAMILY_BUDGETS[family].currentPerMin),
  };
}

/** A send every this many seconds, rotating over `ROTATION`. */
const SEND_EVERY_S = 5;
const FIRST_SEND_S = 2;
const SENDS = 719;
/** slot % 4 → route: each route every 20 s (3/min), the messaging family 6/min. */
const ROTATION = [
  { operation: "messages.page", resource: "dm-messages.history" },
  { operation: "group.detail", resource: "dm-conversations.detail" },
  { operation: "transactions.page", resource: "transactions.insurance" },
  { operation: "media.offer_stats", resource: "media-stats.walk" },
] as const;

/** The instant (seconds after T_i) of slot `slot`. */
export function slotAt(slot: number): number {
  return FIRST_SEND_S + SEND_EVERY_S * slot;
}

/** The first slot ≥ `fromSlot` of `operation`. */
function slotOf(operation: (typeof ROTATION)[number]["operation"], fromSlot: number): number {
  const index = ROTATION.findIndex((entry) => entry.operation === operation);
  let slot = fromSlot;
  while (slot % ROTATION.length !== index) slot += 1;
  return slot;
}

export interface AcceptanceScenario {
  label: string;
  expected: PageVerdict;
  /** Checks whose verdict the scenario is about. */
  expectedChecks: Partial<Record<AcceptanceCheckName, CheckVerdict>>;
  /** Route → state of its 429s. */
  expectedRoutes?: Record<string, "recovered" | "unproven" | "repeated" | "hold_broken">;
  apply?(page: SeededPage): Promise<void>;
}

export interface SeededPage {
  pool: Pool;
  pageId: number;
  label: string;
  /** T_i. */
  liveAt: Date;
  /** Change the engine attempt of `slot`. */
  setSlot(slot: number, columns: Record<string, string | number | null>): Promise<void>;
  slotOf(operation: (typeof ROTATION)[number]["operation"], fromSlot: number): number;
}

/** One episode of an engine latch, in seconds after T_i: resolved, or open and
 *  last seen at `lastSeenS`. */
interface LatchEpisode {
  openedS: number;
  resolvedS: number | null;
  lastSeenS?: number;
}

/**
 * An engine latch (`fansly_sync_engine:<page>:<subKey>`) as its producers
 * leave it: the row holds the newest episode (a resolve stamps `last_seen_at`
 * too), and the paging sweep's `notification_incident_cycles` every episode.
 */
async function engineLatch(page: SeededPage, subKey: string, errorCode: string, episodes: readonly LatchEpisode[]): Promise<void> {
  const at = (seconds: number) => new Date(page.liveAt.getTime() + seconds * 1_000);
  const newest = episodes.at(-1)!;
  const resolvedAt = newest.resolvedS === null ? null : at(newest.resolvedS);
  const latch = await page.pool.query<{ id: string; incidentKey: string }>(
    `insert into notification_incidents (incident_key, kind, platform_account_id, status, opened_at, last_seen_at, resolved_at,
                                         error_code, error_summary)
     values ($1, 'fansly_sync_engine', $2, $3, $4, $5, $6, $7, $7)
     returning id, incident_key as "incidentKey"`,
    [`fansly_sync_engine:${page.pageId}:${subKey}`, page.pageId, resolvedAt === null ? "open" : "resolved",
      at(newest.openedS), resolvedAt ?? at(newest.lastSeenS ?? newest.openedS), resolvedAt, errorCode],
  );
  for (const episode of episodes) {
    await page.pool.query(
      `insert into notification_incident_cycles (notification_incident_id, incident_key, kind, platform_account_id, opened_at, resolved_at)
       values ($1, $2, 'fansly_sync_engine', $3, $4, $5)`,
      [latch.rows[0]!.id, latch.rows[0]!.incidentKey, page.pageId, at(episode.openedS),
        episode.resolvedS === null ? null : at(episode.resolvedS)],
    );
  }
}

async function setSlot(pool: Pool, pageId: number, liveAt: Date, slot: number, columns: Record<string, string | number | null>): Promise<void> {
  const names = Object.keys(columns);
  const assignments = names.map((name, index) => `${name} = $${index + 4}`).join(", ");
  const result = await pool.query(
    `update sync_attempts set ${assignments}
      where page_id = $1 and admitted_at = $2::timestamptz + make_interval(secs => $3::double precision)`,
    [pageId, liveAt, slotAt(slot), ...names.map((name) => columns[name])],
  );
  if (result.rowCount !== 1) throw new Error(`No attempt in slot ${slot} of page ${pageId}`);
}

export const ACCEPTANCE_SCENARIOS: readonly AcceptanceScenario[] = [
  {
    // A clean hour. The handover's page stop (a legacy 429 hold imported at
    // the switch) ended 5 min before live; its latch resolved 10 clean
    // minutes later, inside the window: not the window's hold.
    label: "acc-clean",
    expected: "pass",
    expectedChecks: {
      route_budgets: "pass", route_429: "pass", page_hold: "pass", media_start: "pass", slo_confirm: "pass", open_incidents: "pass",
    },
    async apply(page) {
      await engineLatch(page, "page_stopped", "rate_limit", [{ openedS: -1_200, resolvedS: 300 }]);
    },
  },
  {
    // One 429 on `/message`, its hold kept, the route answering again 20 s
    // later at its halved rate; the per-route incident (D5, PR 1-2's
    // `route_limited:<route>`) stays open under the code its hold left
    // (`route_held`) — judged by the route rule, not as an open incident.
    label: "acc-route-429",
    expected: "accepted_with_route_429",
    expectedChecks: { route_429: "pass", route_budgets: "pass", page_hold: "pass", open_incidents: "pass" },
    expectedRoutes: { "messages.page": "recovered" },
    async apply(page) {
      const slot = page.slotOf("messages.page", 200);
      await page.setSlot(slot, { http_status: 429, error_class: "rate_limit", retry_after_ms: null });
      await engineLatch(page, "route_limited:messages.page", "route_held", [{ openedS: slotAt(slot) + 0.4, resolvedS: null, lastSeenS: slotAt(slot) + 6 }]);
    },
  },
  {
    // The same recovered 429, but it held the whole page: alert 1 opened
    // (`page_stopped`, `rate_limit`) and resolved within the window, the page
    // row's hold long cleared — only the latch still shows it.
    label: "acc-page-429",
    expected: "fail",
    expectedChecks: { page_hold: "fail", route_429: "pass", route_budgets: "pass", open_incidents: "pass" },
    expectedRoutes: { "messages.page": "recovered" },
    async apply(page) {
      const slot = page.slotOf("messages.page", 200);
      await page.setSlot(slot, { http_status: 429, error_class: "rate_limit", retry_after_ms: null });
      await engineLatch(page, "page_stopped", "rate_limit", [{ openedS: slotAt(slot) + 0.4, resolvedS: slotAt(slot) + 665 }]);
    },
  },
  {
    // The page stopped 20 min into the window (no owner for over 2 min) and
    // again after the window: the latch holds the later episode, the paging
    // sweep's record the earlier one.
    label: "acc-stop-history",
    expected: "fail",
    expectedChecks: { page_hold: "fail", auth_refusals: "pass", open_incidents: "pass" },
    async apply(page) {
      await engineLatch(page, "page_stopped", "ownership_unconfirmed", [
        { openedS: 1_200, resolvedS: 1_860 },
        { openedS: 3_960, resolvedS: 4_320 },
      ]);
    },
  },
  {
    // A second 429 on the same page+route, sent for another resource.
    label: "acc-same-route",
    expected: "fail",
    expectedChecks: { route_429: "fail" },
    expectedRoutes: { "messages.page": "repeated" },
    async apply(page) {
      await page.setSlot(page.slotOf("messages.page", 200), { http_status: 429, error_class: "rate_limit" });
      await page.setSlot(page.slotOf("messages.page", 400), { http_status: 429, error_class: "rate_limit", resource: "dm-messages.head" });
    },
  },
  {
    // One 429 each on two routes, both recovered: shown together for the owner.
    label: "acc-two-routes",
    expected: "owner_review",
    expectedChecks: { route_429: "pass", route_budgets: "pass" },
    expectedRoutes: { "messages.page": "recovered", "group.detail": "recovered" },
    async apply(page) {
      await page.setSlot(page.slotOf("messages.page", 200), { http_status: 429, error_class: "rate_limit", retry_after_ms: 10_000 });
      await page.setSlot(page.slotOf("group.detail", 300), { http_status: 429, error_class: "rate_limit" });
    },
  },
  {
    // A subject's 403 fails the page like any 401/403.
    label: "acc-auth-403",
    expected: "fail",
    expectedChecks: { auth_refusals: "fail", page_hold: "pass" },
    async apply(page) {
      await page.setSlot(page.slotOf("group.detail", 100), { http_status: 403, error_class: "subject_terminal" });
    },
  },
  {
    // Three network failures in a row held the page; the hold ended and was
    // cleared — only the journal still shows it.
    label: "acc-page-hold",
    expected: "fail",
    expectedChecks: { page_hold: "fail", auth_refusals: "pass" },
    async apply(page) {
      for (const slot of [300, 301, 302]) {
        await page.setSlot(slot, { http_status: null, outcome: "transport_error", error_class: "network" });
      }
    },
  },
  {
    // A 429 near the window's end, the route never seen answering since.
    label: "acc-late-429",
    expected: "inconclusive",
    expectedChecks: { route_429: "inconclusive" },
    expectedRoutes: { "messages.page": "unproven" },
    async apply(page) {
      await page.setSlot(page.slotOf("messages.page", SENDS - 4), { http_status: 429, error_class: "rate_limit" });
    },
  },
  {
    // Three `.find` works still open since 10 min after live: their age counts.
    label: "acc-slo-tail",
    expected: "fail",
    expectedChecks: { slo_find: "fail", nothing_stuck: "fail" },
    async apply(page) {
      await page.pool.query(
        `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, first_demand_at, due_at)
         select $1, false, 'dm-conversations.find', 'open-' || n, 'trigger', 'urgent', 'open',
                $2::timestamptz + interval '10 minutes', $2::timestamptz + interval '10 minutes'
           from generate_series(1, 3) as n`,
        [page.pageId, page.liveAt],
      );
    },
  },
  {
    // Five fan messages only: the message SLOs show count and max.
    label: "acc-small-sample",
    expected: "inconclusive",
    expectedChecks: { slo_visible: "inconclusive", slo_confirm: "inconclusive", slo_confirm_fast: "inconclusive", confirm_mismatches: "pass" },
    async apply(page) {
      await page.pool.query(`delete from dm_live_messages where page_id = $1 and platform_message_id::int > 5`, [page.pageId]);
    },
  },
  {
    // The media statistics read every 5 s for two minutes: each pair closer
    // than the 12 s its admissions recorded.
    label: "acc-budget",
    expected: "fail",
    expectedChecks: { route_budgets: "fail", pace_combined: "pass", route_429: "pass" },
    async apply(page) {
      const media = currentIntervals("media.offer_stats");
      for (let slot = 100; slot < 124; slot += 1) {
        await page.setSlot(slot, {
          operation: "media.offer_stats", resource: "media-stats.walk",
          route_interval_ms: media.routeIntervalMs, family_interval_ms: media.familyIntervalMs,
        });
      }
    },
  },
  {
    // One media 429, recovered; the admissions after it recorded the halved
    // rate (2.5/min: 24 s), but the route went on every 20 s.
    label: "acc-slowdown",
    expected: "fail",
    expectedChecks: { route_budgets: "fail", route_429: "pass" },
    expectedRoutes: { "media.offer_stats": "recovered" },
    async apply(page) {
      const slot = page.slotOf("media.offer_stats", 200);
      await page.setSlot(slot, { http_status: 429, error_class: "rate_limit" });
      await page.pool.query(
        `update sync_attempts set route_interval_ms = 24000
          where page_id = $1 and operation = 'media.offer_stats' and admitted_at > $2::timestamptz + make_interval(secs => $3::double precision)`,
        [page.pageId, page.liveAt, slotAt(slot)],
      );
    },
  },
  {
    // The arena's counterexample (G1): fifteen sends of one 4 s route 2.8 s
    // apart — fourteen pairs closer than its interval, though no 60 s or
    // 300 s span holds more than ⌈W/T⌉ + 1 of them (15 ≤ 16) — and each ≥ the
    // page's pause. The rotation's sends of those 45 s are not there.
    label: "acc-route-gap",
    expected: "fail",
    expectedChecks: { route_budgets: "fail", pace_combined: "pass", route_429: "pass" },
    async apply(page) {
      await page.pool.query(
        `delete from sync_attempts
          where page_id = $1 and admitted_at between $2::timestamptz + interval '999 seconds' and $2::timestamptz + interval '1044 seconds'`,
        [page.pageId, page.liveAt],
      );
      const notifications = currentIntervals("notifications.page");
      await page.pool.query(
        `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                    admitted_at, sent_at, send_mark, completed_at, operation, request, outcome, http_status,
                                    route_interval_ms, family_interval_ms)
         select $1, false, 'notifications.forward', '', 'planned', 1, 2500, 0, 2500,
                $2::timestamptz + make_interval(secs => 1001 + 2.8 * i),
                $2::timestamptz + make_interval(secs => 1001 + 2.8 * i + 0.1), 'request_start',
                $2::timestamptz + make_interval(secs => 1001 + 2.8 * i + 0.4),
                'notifications.page', '{}'::jsonb, 'response', 200, $3, $4
           from generate_series(0, 14) as i`,
        [page.pageId, page.liveAt, notifications.routeIntervalMs, notifications.familyIntervalMs],
      );
    },
  },
];

/** The database's clock. */
async function dbNow(pool: Pool): Promise<Date> {
  const result = await pool.query<{ now: Date }>("select clock_timestamp() as now");
  return result.rows[0]!.now;
}

async function seedHealthyPage(db: Database, pool: Pool, label: string, liveAt: Date): Promise<number> {
  const model = await createModel(db, { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db, { modelId: model!.id, label });
  const pageId = page!.id;
  await ensureSyncPage(db, { pageId });
  await pool.query(
    `update sync_pages set mode = 'live', mode_changed_at = $2, mode_changed_by = 'test', legacy_imported_at = $2 where page_id = $1`,
    [pageId, liveAt],
  );
  // The guard handed 30 s before live; the legacy engine's last send 40 s before.
  await pool.query(
    `insert into fansly_page_send_guards (page_id, last_completed_at, next_u, owner_engine, engine_switched_at)
     values ($1, $2::timestamptz - interval '40 seconds', 0, 'fansly_sync_engine', $2::timestamptz - interval '30 seconds')
     on conflict (page_id) do update set last_completed_at = excluded.last_completed_at, owner_engine = excluded.owner_engine,
                                         engine_switched_at = excluded.engine_switched_at`,
    [pageId, liveAt],
  );
  // The legacy engine's last 255 s before the switch: /message every 2.5 s.
  await pool.query(
    `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance,
                                  setting_ms, jitter_u, pause_ms, captured_at, sent_at, completed_at, outcome, http_status)
     select $1, gen_random_uuid(), 'sync_stream', 'messages', 'worker-1', 1, 'worker', gen_random_uuid(), 2500, 0, 2500,
            $2::timestamptz - make_interval(secs => 300 - 2.5 * i),
            $2::timestamptz - make_interval(secs => 300 - 2.5 * i - 0.05),
            $2::timestamptz - make_interval(secs => 300 - 2.5 * i - 0.3), 'response', 200
       from generate_series(0, 102) as i`,
    [pageId, liveAt],
  );
  const intervals = ROTATION.map((entry) => currentIntervals(entry.operation));
  await pool.query(
    `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                admitted_at, sent_at, send_mark, completed_at, operation, request, outcome, http_status,
                                route_interval_ms, family_interval_ms)
     select $1, false, r.resource, '', 'planned', 1, 2500, 0, 2500,
            $2::timestamptz + make_interval(secs => $3 + $4 * i),
            $2::timestamptz + make_interval(secs => $3 + $4 * i + 0.1), 'request_start',
            $2::timestamptz + make_interval(secs => $3 + $4 * i + 0.4),
            r.operation, '{}'::jsonb, 'response', 200, r.route_interval_ms, r.family_interval_ms
       from generate_series(0, $5 - 1) as i
       cross join lateral (select ($6::text[])[i % cardinality($6::text[]) + 1] as operation,
                                  ($7::text[])[i % cardinality($7::text[]) + 1] as resource,
                                  ($8::int[])[i % cardinality($8::int[]) + 1] as route_interval_ms,
                                  ($9::int[])[i % cardinality($9::int[]) + 1] as family_interval_ms) as r`,
    [pageId, liveAt, FIRST_SEND_S, SEND_EVERY_S, SENDS, ROTATION.map((entry) => entry.operation), ROTATION.map((entry) => entry.resource),
      intervals.map((entry) => entry.routeIntervalMs), intervals.map((entry) => entry.familyIntervalMs)],
  );
  // Twelve fan messages, visible 1 s after they were sent, confirmed 5 s later.
  await pool.query(
    `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id, is_sent_by_page,
                                   created_at, first_visible_at, confirmed_at, confirm_outcome, confirm_source, attachments, decoder_version)
     select $1, n::text, '1001', '2002', false,
            $2::timestamptz + make_interval(mins => n) - interval '1 second', $2::timestamptz + make_interval(mins => n),
            $2::timestamptz + make_interval(mins => n) + interval '5 seconds', 'match', 'message_archive',
            '[{"contentType": 1, "contentId": "m"}]'::jsonb, 1
       from generate_series(1, 12) as n`,
    [pageId, liveAt],
  );
  // Served works: 12 finds (3 s), 12 money heads (2 s), 2 deletions (1 s), a repair (20 s).
  await pool.query(
    `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, first_demand_at, due_at, closed_at, close_reason)
     select $1, false, w.resource, w.resource || '-' || n, w.kind, 'urgent', 'done',
            $2::timestamptz + make_interval(mins => n), $2::timestamptz + make_interval(mins => n),
            $2::timestamptz + make_interval(mins => n, secs => w.seconds), 'done'
       from (values ('dm-conversations.find', 'trigger', 12, 3), ('transactions.head', 'trigger', 12, 2),
                    ('dm-live.deletions', 'trigger', 2, 1), ('repair.ws-gap', 'repair', 1, 20)) as w(resource, kind, count, seconds)
       cross join lateral generate_series(1, w.count) as n`,
    [pageId, liveAt],
  );
  return pageId;
}

export interface SeededAcceptance {
  /** Before every T_i: the check's `since`. */
  since: Date;
  pages: Array<AcceptanceScenario & { pageId: number }>;
}

/** Seed every scenario's page; page i went live i seconds after the first,
 *  75 minutes ago, so the shared window [T_i, T* + 1 h) is complete. */
export async function seedAcceptanceScenarios(db: Database, pool: Pool): Promise<SeededAcceptance> {
  const now = await dbNow(pool);
  const first = new Date(Math.floor((now.getTime() - 75 * 60_000) / 1_000) * 1_000);
  const pages: SeededAcceptance["pages"] = [];
  for (const [index, scenario] of ACCEPTANCE_SCENARIOS.entries()) {
    const liveAt = new Date(first.getTime() + index * 1_000);
    const pageId = await seedHealthyPage(db, pool, scenario.label, liveAt);
    await scenario.apply?.({
      pool,
      pageId,
      label: scenario.label,
      liveAt,
      setSlot: (slot, columns) => setSlot(pool, pageId, liveAt, slot, columns),
      slotOf,
    });
    pages.push({ ...scenario, pageId });
  }
  return { since: new Date(first.getTime() - 60_000), pages };
}
