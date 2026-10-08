import {
  countSendsSince,
  listSyncPages,
  readSyncHistoryMetrics,
  readSyncJournalMetrics,
  readSyncOverlayMetrics,
  type Database,
  type FanslyWsLivePayloadResolver,
  type OpsMetricSampleInput,
  type SyncPageRow,
} from "@agency_hub_core/db";

import type { FanslyPageHoldKind } from "@agency_hub_core/shared";

import { moneyFramesMissing, readMoneyFrames, type MoneyFrame } from "../fansly/ws/money-frames.ts";
import { holdSetOf, pageHoldsInForce, resourceFilesHeld } from "./admission.ts";
import { collectPageAlerts, pagesOwnerAlerts, SYNC_MONEY_FRAME_MS, SYNC_MONEY_LOOKBACK_MS } from "./alerts.ts";
import type { EngineRegistry } from "./resource.ts";

// The Fansly Sync Engine's golden signals (plan §10, design §9.5), computed
// from the database: the pace (smallest gap between two actual sends vs the
// setting, violations), sends by class and resource, holds, breakers,
// quarantine, the overlay's confirmation lag, REST mismatches and the DM
// apply's `not_found` verdicts, the money lag from a socket frame to the
// ledger, history requests and the ETA's fact over forecast. The per-page
// families cover the pages the engine owns (`handover`/`live`).
//
// `computeSyncMetrics` serves one page (status);
// `sampleSyncEngineMetrics` is the ops sampler's compact set (aggregates over
// pages, design §9.4 [A11]): per-page series would double the sample table
// for figures the page status already shows.

export interface SyncPageMetrics {
  pageId: number;
  pageLabel: string | null;
  mode: SyncPageRow["mode"];
  window: { since: Date; until: Date };
  sends: { urgent: number; requests: number; planned: number; total: number; byResource: Record<string, number> };
  /** `sync_min_send_gap_ms{page}`; null with fewer than two sends. */
  minSendGapMs: number | null;
  /** `sync_pace_violations{page}`: pairs closer than the setting in force for the later send. */
  paceViolations: number;
  /** `sync_holds{page,kind}`: the page's own holds (a credentials hold, a
   *  network hold — both when both stand) and the resource files held, in
   *  force at `until`, by the hold evaluator. */
  holds: { page: FanslyPageHoldKind[]; resources: string[] };
  breakersOpen: number;
  blockedByVendor: number;
  quarantined: number;
}

/** The holds of a page in force at `now` (`engine/admission.ts`). */
function holdsOf(page: SyncPageRow, now: Date): SyncPageMetrics["holds"] {
  const holds = holdSetOf(page.holds);
  const held = pageHoldsInForce(holds, now);
  return {
    page: [held?.credentials?.kind, held?.timed?.kind].filter((kind): kind is FanslyPageHoldKind => kind !== undefined),
    resources: resourceFilesHeld(holds, now),
  };
}

/** One page's families over [now − windowMs, now). */
export async function computeSyncMetrics(
  db: Database,
  input: { page: SyncPageRow; windowMs: number; now?: Date },
): Promise<SyncPageMetrics> {
  const until = input.now ?? input.page.dbNow;
  const since = new Date(until.getTime() - input.windowMs);
  const [row] = await readSyncJournalMetrics(db, { pageIds: [input.page.pageId], since, until });
  const counts = await countSendsSince(db, { pageId: input.page.pageId, since });
  return {
    pageId: input.page.pageId,
    pageLabel: input.page.pageLabel,
    mode: input.page.mode,
    window: { since, until },
    sends: {
      urgent: row?.sends.urgent ?? 0,
      requests: row?.sends.requests ?? 0,
      planned: row?.sends.planned ?? 0,
      total: (row?.sends.urgent ?? 0) + (row?.sends.requests ?? 0) + (row?.sends.planned ?? 0),
      byResource: counts.byResource,
    },
    minSendGapMs: row?.minGapMs ?? null,
    paceViolations: row?.paceViolations ?? 0,
    holds: holdsOf(input.page, until),
    breakersOpen: row?.breakersOpen ?? 0,
    blockedByVendor: row?.blockedByVendor ?? 0,
    quarantined: row?.quarantined ?? 0,
  };
}

/** Nearest-rank quantile of a sample (null when empty). */
export function quantileOf(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export interface SyncGlobalMetrics {
  /** `dm_confirm_lag` (confirmed_at − first_visible_at). */
  dmConfirmLag: { p50Ms: number | null; p95Ms: number | null };
  /** `ws_rest_mismatch{field}`. */
  wsRestMismatch: Record<string, number>;
  /** `dm_live_not_found`: `not_found` verdicts of the window, all the DM
   *  apply's (a REST read covered the message's place without it); the parity
   *  window defers a message instead. */
  dmLiveNotFound: number;
  /** `money_lag`: a socket frame of a new ledger row (not a settlement, not a
   *  payout) → the ledger row; frames still missing after 5 min counted apart. */
  moneyLag: { p50Ms: number | null; p95Ms: number | null; frames: number; missing: number };
  /** `history_requests_open`, `history_reads_done/remaining`,
   *  `history_eta_fact_over_forecast`. */
  history: { requestsOpen: number; readsDone: number; readsRemaining: number; factOverForecast: { p50: number | null; p95: number | null } };
}

/** The families that are not per page, over [now − windowMs, now). */
export async function computeSyncGlobalMetrics(
  db: Database,
  input: {
    windowMs: number;
    now: Date;
    pageIds: readonly number[];
    resolvePayload?: FanslyWsLivePayloadResolver;
    /** The window's money frames when the caller already read them. */
    moneyFrames?: readonly MoneyFrame[];
  },
): Promise<SyncGlobalMetrics> {
  const since = new Date(input.now.getTime() - input.windowMs);
  const overlay = await readSyncOverlayMetrics(db, { since });
  const frames = input.moneyFrames ?? await readMoneyFrames(db, {
    from: since,
    to: input.now,
    pageIds: input.pageIds,
    ...(input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload }),
  });
  const lags = frames
    .filter((frame) => frame.ledgerCreatedAt !== null)
    .map((frame) => Math.max(0, frame.ledgerCreatedAt!.getTime() - frame.receivedAt.getTime()));
  const missing = frames.filter((frame) =>
    frame.ledgerCreatedAt === null && input.now.getTime() - frame.receivedAt.getTime() > SYNC_MONEY_FRAME_MS).length;
  const history = await readSyncHistoryMetrics(db, { since: new Date(input.now.getTime() - 24 * 3_600_000) });
  return {
    dmConfirmLag: { p50Ms: overlay.confirmLagP50Ms, p95Ms: overlay.confirmLagP95Ms },
    wsRestMismatch: overlay.mismatchByField,
    dmLiveNotFound: overlay.notFound,
    moneyLag: { p50Ms: quantileOf(lags, 0.5), p95Ms: quantileOf(lags, 0.95), frames: frames.length, missing },
    history: {
      requestsOpen: history.requestsOpen,
      readsDone: history.readsDone,
      readsRemaining: history.readsRemaining,
      factOverForecast: { p50: quantileOf(history.factOverForecast, 0.5), p95: quantileOf(history.factOverForecast, 0.95) },
    },
  };
}

/** The sampler records the engine's families this often (they are hourly
 *  windows; minute resolution would only grow the sample table). */
export const SYNC_METRICS_SAMPLE_EVERY_MINUTES = 5;
/** The window of the sampled families. */
export const SYNC_METRICS_WINDOW_MS = 60 * 60_000;

function gauge(metric: string, value: number | null): OpsMetricSampleInput[] {
  return value === null || !Number.isFinite(value)
    ? []
    : [{ metric, quantile: "p50", valueMs: value }, { metric, quantile: "p95", valueMs: value }];
}

function pair(metric: string, p50: number | null, p95: number | null): OpsMetricSampleInput[] {
  return [
    ...(p50 === null || !Number.isFinite(p50) ? [] : [{ metric, quantile: "p50" as const, valueMs: p50 }]),
    ...(p95 === null || !Number.isFinite(p95) ? [] : [{ metric, quantile: "p95" as const, valueMs: p95 }]),
  ];
}

/** Basis points of a ratio (the sample table stores integers). */
function basisPoints(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000);
}

/**
 * The ops sampler's set (every `SYNC_METRICS_SAMPLE_EVERY_MINUTES`): over the
 * pages the engine owns (`sync_*`, none without one) the smallest send gap of
 * the hour, pace violations, sends, holds, open breakers, vendor-blocked
 * subjects, quarantined work and the alert conditions that hold; and the
 * global families. Threshold-free: the engine's alerts page, not the sample
 * latch.
 */
export async function sampleSyncEngineMetrics(
  db: Database,
  input: { registry: Pick<EngineRegistry, "spec">; settingMs: number; resolvePayload?: FanslyWsLivePayloadResolver },
): Promise<OpsMetricSampleInput[]> {
  const pages = await listSyncPages(db);
  const now = pages[0]?.dbNow ?? new Date();
  const engaged = pages.filter(pagesOwnerAlerts);
  const resolve = input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload };
  const samples: OpsMetricSampleInput[] = [...gauge("sync_setting_ms", input.settingMs)];
  // One read of the socket's money news serves the money lag and alert 3.
  const moneyFrames = await readMoneyFrames(db, {
    from: new Date(now.getTime() - Math.max(SYNC_METRICS_WINDOW_MS, SYNC_MONEY_LOOKBACK_MS)),
    to: now,
    pageIds: pages.map((page) => page.pageId),
    ...resolve,
  });
  const engagedIds = new Set(engaged.map((page) => page.pageId));
  const money = moneyFramesMissing(moneyFrames.filter((frame) => engagedIds.has(frame.pageId)), now, SYNC_MONEY_FRAME_MS);
  if (engaged.length > 0) {
    const rows = await readSyncJournalMetrics(db, {
      pageIds: engaged.map((page) => page.pageId),
      since: new Date(now.getTime() - SYNC_METRICS_WINDOW_MS),
      until: now,
    });
    const gaps = rows.map((row) => row.minGapMs).filter((gap): gap is number => gap !== null);
    let holds = 0;
    let conditions = 0;
    for (const page of engaged) {
      const held = holdsOf(page, now);
      holds += held.page.length + held.resources.length;
      conditions += (await collectPageAlerts(db, { page, registry: input.registry, money })).length;
    }
    const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
    samples.push(
      ...gauge("sync_min_send_gap_ms", gaps.length === 0 ? null : Math.min(...gaps)),
      ...gauge("sync_pace_violations", sum((row) => row.paceViolations)),
      ...gauge("sync_sends", sum((row) => row.sends.urgent + row.sends.requests + row.sends.planned)),
      ...gauge("sync_holds", holds),
      ...gauge("sync_breakers_open", sum((row) => row.breakersOpen)),
      ...gauge("sync_blocked_by_vendor", sum((row) => row.blockedByVendor)),
      ...gauge("sync_quarantined", sum((row) => row.quarantined)),
      ...gauge("sync_alerts", conditions),
    );
  }
  const windowFrom = now.getTime() - SYNC_METRICS_WINDOW_MS;
  const global = await computeSyncGlobalMetrics(db, {
    windowMs: SYNC_METRICS_WINDOW_MS,
    now,
    pageIds: pages.map((page) => page.pageId),
    moneyFrames: moneyFrames.filter((frame) => frame.receivedAt.getTime() >= windowFrom),
  });
  samples.push(
    ...pair("dm_confirm_lag", global.dmConfirmLag.p50Ms, global.dmConfirmLag.p95Ms),
    ...pair("money_lag", global.moneyLag.p50Ms, global.moneyLag.p95Ms),
    ...gauge("money_frames_missing", global.moneyLag.missing),
    ...gauge("ws_rest_mismatch", Object.values(global.wsRestMismatch).reduce((total, n) => total + n, 0)),
    ...gauge("dm_live_not_found", global.dmLiveNotFound),
    ...gauge("history_requests_open", global.history.requestsOpen),
    ...gauge("history_reads_done", global.history.readsDone),
    ...gauge("history_reads_remaining", global.history.readsRemaining),
    ...pair("history_eta_fact_over_forecast_bp",
      basisPoints(global.history.factOverForecast.p50), basisPoints(global.history.factOverForecast.p95)),
  );
  return samples;
}

/** Whether the minutely sampler's run at `now` records the engine's set. */
export function syncMetricsDue(now: Date): boolean {
  return now.getUTCMinutes() % SYNC_METRICS_SAMPLE_EVERY_MINUTES === 0;
}
