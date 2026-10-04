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

import { moneyFramesMissing, readMoneyFrames, type MoneyFrame } from "../fansly/ws/money-frames.ts";
import { collectPageAlerts, SYNC_MONEY_FRAME_MS, SYNC_MONEY_LOOKBACK_MS } from "./alerts.ts";
import type { EngineRegistry } from "./resource.ts";

// The Fansly Sync Engine's golden signals (plan §10, design §9.5), computed
// from the database: the pace (smallest gap between two actual sends vs the
// setting, violations), sends by class and resource, holds, breakers,
// quarantine, the overlay's confirmation lag and REST mismatches, the money
// lag from a socket frame to the ledger, history requests and the ETA's fact
// over forecast. Live pages (`handover`/`live`) and shadow pages are separate
// journals; a shadow page's families are `sync_shadow_*`, and its alerts 1–4
// are counted here only (D14).
//
// `computeSyncMetrics` serves one page (status);
// `sampleSyncEngineMetrics` is the ops sampler's compact set (aggregates over
// pages, design §9.4 [A11]): per-page series would double the sample table
// for figures the page status already shows.

export type SyncJournal = "live" | "shadow";

export function journalOf(page: Pick<SyncPageRow, "mode">): SyncJournal {
  return page.mode === "handover" || page.mode === "live" ? "live" : "shadow";
}

export interface SyncPageMetrics {
  pageId: number;
  pageLabel: string | null;
  mode: SyncPageRow["mode"];
  journal: SyncJournal;
  window: { since: Date; until: Date };
  sends: { urgent: number; requests: number; planned: number; total: number; byResource: Record<string, number> };
  /** `sync_min_send_gap_ms{page}`; null with fewer than two sends. */
  minSendGapMs: number | null;
  /** `sync_pace_violations{page}`: pairs closer than the setting in force for the later send. */
  paceViolations: number;
  /** `sync_holds{page,kind}`: the page hold and the resource files held, in force at `until`. */
  holds: { page: SyncPageRow["holdKind"]; resources: string[] };
  breakersOpen: number;
  blockedByVendor: number;
  quarantined: number;
}

function inForce(until: string | Date | null | undefined, now: Date): boolean {
  if (until === null || until === undefined) return false;
  const at = until instanceof Date ? until : new Date(until);
  return !Number.isNaN(at.getTime()) && at.getTime() > now.getTime();
}

/** The holds of a page in force at `now`. */
export function holdsInForce(page: SyncPageRow, now: Date): SyncPageMetrics["holds"] {
  return {
    page: page.holdKind !== null && inForce(page.holdUntil, now) ? page.holdKind : null,
    resources: Object.entries(page.resourceHolds)
      .filter(([, hold]) => inForce(hold.until, now))
      .map(([file]) => file)
      .sort(),
  };
}

/** One page's families over [now − windowMs, now) of its journal. */
export async function computeSyncMetrics(
  db: Database,
  input: { page: SyncPageRow; windowMs: number; now?: Date },
): Promise<SyncPageMetrics> {
  const until = input.now ?? input.page.dbNow;
  const since = new Date(until.getTime() - input.windowMs);
  const journal = journalOf(input.page);
  const shadow = journal === "shadow";
  const [row] = await readSyncJournalMetrics(db, { pageIds: [input.page.pageId], shadow, since, until });
  const counts = await countSendsSince(db, { pageId: input.page.pageId, since, shadow });
  return {
    pageId: input.page.pageId,
    pageLabel: input.page.pageLabel,
    mode: input.page.mode,
    journal,
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
    holds: holdsInForce(input.page, until),
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
  /** `money_lag`: a socket frame of a new ledger row (not a settlement, not a
   *  payout) → the ledger row; frames still missing after 5 min counted apart. */
  moneyLag: { p50Ms: number | null; p95Ms: number | null; frames: number; missing: number };
  /** `history_requests_open`, `history_reads_done/remaining`,
   *  `history_eta_fact_over_forecast`. */
  history: { requestsOpen: number; readsDone: number; readsRemaining: number; factOverForecast: { p50: number | null; p95: number | null } };
}

/** The families that are not per journal, over [now − windowMs, now). */
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
 * The ops sampler's set (every `SYNC_METRICS_SAMPLE_EVERY_MINUTES`): per
 * journal with at least one page in it (`sync_` for handover/live,
 * `sync_shadow_` for shadow) the smallest send gap of the hour over its pages,
 * pace violations, sends, holds, open breakers, vendor-blocked subjects,
 * quarantined work and the alert conditions that hold; and the global
 * families. Threshold-free: the engine's alerts page, not the sample latch.
 */
export async function sampleSyncEngineMetrics(
  db: Database,
  input: { registry: Pick<EngineRegistry, "spec">; settingMs: number; resolvePayload?: FanslyWsLivePayloadResolver },
): Promise<OpsMetricSampleInput[]> {
  const pages = await listSyncPages(db);
  const now = pages[0]?.dbNow ?? new Date();
  const engaged = pages.filter((page) => page.mode !== "off");
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
  for (const journal of ["live", "shadow"] as const) {
    const members = engaged.filter((page) => journalOf(page) === journal);
    if (members.length === 0) continue;
    const prefix = journal === "live" ? "sync_" : "sync_shadow_";
    const rows = await readSyncJournalMetrics(db, {
      pageIds: members.map((page) => page.pageId),
      shadow: journal === "shadow",
      since: new Date(now.getTime() - SYNC_METRICS_WINDOW_MS),
      until: now,
    });
    const gaps = rows.map((row) => row.minGapMs).filter((gap): gap is number => gap !== null);
    let holds = 0;
    let conditions = 0;
    for (const page of members) {
      const held = holdsInForce(page, now);
      holds += (held.page === null ? 0 : 1) + held.resources.length;
      conditions += (await collectPageAlerts(db, { page, registry: input.registry, money })).length;
    }
    const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
    samples.push(
      ...gauge(`${prefix}min_send_gap_ms`, gaps.length === 0 ? null : Math.min(...gaps)),
      ...gauge(`${prefix}pace_violations`, sum((row) => row.paceViolations)),
      ...gauge(`${prefix}sends`, sum((row) => row.sends.urgent + row.sends.requests + row.sends.planned)),
      ...gauge(`${prefix}holds`, holds),
      ...gauge(`${prefix}breakers_open`, sum((row) => row.breakersOpen)),
      ...gauge(`${prefix}blocked_by_vendor`, sum((row) => row.blockedByVendor)),
      ...gauge(`${prefix}quarantined`, sum((row) => row.quarantined)),
      ...gauge(`${prefix}alerts`, conditions),
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
