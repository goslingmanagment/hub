import {
  countLegacyFanslyAttempts,
  countSyncAttemptsByKey,
  listSyncAdmissions,
  readLedgerTransactionsCreatedAt,
  readLegacyMessageArrivals,
  readSyncJournalMetrics,
  type Database,
  type FanslyWsLivePayloadResolver,
  type SyncPageRow,
} from "@agency_hub_core/db";

import { quantileOf } from "../engine/metrics.ts";
import { effectivePeriodMs, resourceDisabled, runsIn, type CoalesceSpec, type DemandSignal } from "../engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, type LegacyRef, type ResourceSpec } from "../fansly/registry.ts";
import { decodedReceiptsInWindow } from "../fansly/ws/money-frames.ts";
import { routeReceiptsOffline } from "../fansly/ws/route-receipt.ts";
import { FANSLY_PAYOUT_TRANSACTION_TYPE, FANSLY_TRANSACTION_STATUS_NEW } from "../fansly/ws/router.ts";
import type { WsItem } from "../fansly/ws/decode.ts";

// The shadow report, part A (design §3.12): the live one-hour window of all
// pages in shadow. A1 demand against a computed expectation, A2 the legacy
// engine's volume of the same hour explained through the registry's coverage
// matrix, A3 the live-path decisions (socket frame → shadow admission vs the
// legacy arrival), A4 the pacer's self-check. Reads only.

const HOUR_MS = 3_600_000;
/** Plan §13: the steady-state band of one page's requests per hour. */
export const STEADY_STATE_BAND_PER_HOUR = { min: 40, max: 100 } as const;
/** A resource outside this ratio of its expectation is listed with its reason. */
export const EXPECTATION_RATIO_BAND = { min: 0.5, max: 2 } as const;
/** A3 targets: shadow admission after the frame, p95. */
export const LIVE_PATH_TARGET_P95_MS = { messages: 30_000, transactions: 15_000 } as const;
/** A3: fewer frames than this over all pages ⇒ the offline decision replay. */
export const LIVE_PATH_MIN_SAMPLE = { messages: 50, transactions: 5 } as const;
/** The offline decision replay reads the receipts of this long before the window. */
export const OFFLINE_DECISIONS_LOOKBACK_MS = 24 * HOUR_MS;
/** A frame's shadow admission is looked for up to this long after the window. */
const ADMISSION_SEARCH_MS = 15 * 60_000;
/** One-time backlogs of a first shadow run (design §3.12 A1). */
const ONE_TIME_BACKLOG_KEYS: ReadonlySet<string> = new Set(["media-stats.walk", "catalog.vault"]);
/** Why the legacy volume of a stream or sender differs from the engine's (design §3.12 A2). */
const LEGACY_VOLUME_NOTES: Readonly<Record<string, string>> = {
  "stream:followers": "followers.head reuses pages.follower_count; the full reconcile is daily (the owner's floor)",
  "stream:followers_reconcile": "the reconcile walk runs at most daily (the owner's floor)",
  "stream:dm_conversations": "the full list sweep is daily instead of 6-hourly; the socket and .head every 30 min cover discovery (A14)",
  "stream:dm_messages": "only chats with demand are read (socket, list follow-ups); no B1 5 % cap, no history walk without a request",
  "stream:media_stats": "owner decision №6 tiers (30 / 90 days / monthly)",
  "stream:catalog": "owner decision №6: the vault walk is a daily incremental and a weekly full sweep",
  "stream:transactions": "the head is read on socket money news; the insurance poll every 5 min, the rescan hourly",
  "stream:notifications": "one forward poll every 30 min",
  "sender:ws_hint": "a socket hint is dm-messages.head demand, coalesced per chat",
  "sender:ai_accelerator": "readers' fast lanes read the chat head the engine keeps fresh; no request of their own",
  "sender:ai_fast_lane": "readers' fast lanes read the chat head the engine keeps fresh; no request of their own",
  "sender:targeted_backfill": "history is read only for history requests (none in shadow)",
};

type Quantiles = { p50: number; p95: number } | null;

function quantiles(values: readonly number[]): Quantiles {
  const p50 = quantileOf(values, 0.5);
  const p95 = quantileOf(values, 0.95);
  return p50 === null || p95 === null ? null : { p50, p95 };
}

function refKey(ref: LegacyRef): string {
  return "stream" in ref ? `stream:${ref.stream}` : `sender:${ref.sender}`;
}

// ── coalescing (pure) ─────────────────────────────────────────────────────────

export interface CoalescedSignal {
  resource: string;
  subject: string;
  atMs: number;
  /** An explicit due time of the signal (`dueAt`), else the coalescing rule's. */
  dueAtMs: number | null;
  fast: boolean;
}

export interface SimulatedReads {
  reads: number;
  /** Per signal: when its read became due, after the signal. */
  dueLagsMs: number[];
}

/**
 * Reads the engine would make for these signals under the registry's
 * coalescing (design §4.4): a signal joins the open read of its key while that
 * read is not yet due; a quiet window moves the due time later up to the
 * read's cap; a key without a coalescing rule reads at the signal (or its
 * explicit due time). A head walk of more than one page counts as one read.
 */
export function simulateCoalescedReads(
  signals: readonly CoalescedSignal[],
  coalesceOf: (resource: string) => CoalesceSpec | undefined,
): Map<string, SimulatedReads> {
  const byKey = new Map<string, CoalescedSignal[]>();
  for (const signal of signals) {
    const key = `${signal.resource}\u0000${signal.subject}`;
    byKey.set(key, [...(byKey.get(key) ?? []), signal]);
  }
  const reads = new Map<string, SimulatedReads>();
  for (const keySignals of byKey.values()) {
    const resource = keySignals[0]!.resource;
    const spec = coalesceOf(resource);
    const total = reads.get(resource) ?? { reads: 0, dueLagsMs: [] };
    let open: { firstMs: number; dueMs: number; fast: boolean; members: number[] } | null = null;
    const close = () => {
      if (open === null) return;
      total.reads += 1;
      for (const atMs of open.members) total.dueLagsMs.push(Math.max(0, open.dueMs - atMs));
      open = null;
    };
    for (const signal of [...keySignals].sort((a, b) => a.atMs - b.atMs)) {
      if (open !== null && signal.atMs < open.dueMs) {
        const fast: boolean = open.fast || signal.fast;
        const window = fast && spec?.fast !== undefined ? spec.fast : spec;
        let due: number = open.dueMs;
        if (window !== undefined) {
          // A further signal moves the read later (quiet window), never past
          // the cap; the first fast signal shortens it to the fast window.
          if (spec?.extendOnSignal === true) due = Math.max(due, signal.atMs + window.quietMs);
          due = Math.min(due, open.firstMs + window.maxMs);
          if (fast && !open.fast) due = Math.min(due, signal.atMs + window.quietMs);
        }
        if (signal.dueAtMs !== null) due = Math.min(due, Math.max(signal.dueAtMs, signal.atMs));
        open = { firstMs: open.firstMs, dueMs: due, fast, members: [...open.members, signal.atMs] };
        continue;
      }
      close();
      const window = signal.fast && spec?.fast !== undefined ? spec.fast : spec;
      const due = signal.dueAtMs !== null ? Math.max(signal.dueAtMs, signal.atMs) : signal.atMs + (window?.quietMs ?? 0);
      open = { firstMs: signal.atMs, dueMs: due, fast: signal.fast, members: [signal.atMs] };
    }
    close();
    reads.set(resource, total);
  }
  return reads;
}

function coalescedSignalsOf(atMs: number, signals: readonly DemandSignal[]): CoalescedSignal[] {
  return signals.map((signal) => ({
    resource: signal.resource,
    subject: signal.subject ?? "",
    atMs,
    dueAtMs: signal.dueAt === undefined ? null : signal.dueAt.getTime(),
    fast: signal.coalesce === "fast",
  }));
}

// ── part A ───────────────────────────────────────────────────────────────────

export interface ShadowWindowInput {
  window: { start: Date; end: Date };
  /** The pages the report covers (all six in shadow for the acceptance). */
  pages: readonly SyncPageRow[];
  resolvePayload?: FanslyWsLivePayloadResolver;
  maxListed: number;
}

export interface DemandRow {
  resource: string;
  class: string;
  kind: string;
  observed: number;
  /** Polls due in the window plus the reads its socket frames imply; null when
   *  neither models the key (walks, apply follow-ups). */
  expected: number | null;
  ratio: number | null;
  verdict: "ok" | "outside" | "not_modelled";
  reason: string;
}

export interface PageDemand {
  page: string;
  mode: SyncPageRow["mode"];
  attempts: { urgent: number; requests: number; planned: number };
  /** Urgent + planned attempts of keys that are not walks. */
  steadyState: number;
  band: { min: number; max: number };
  inBand: boolean;
  walks: Array<{ resource: string; observed: number; oneTimeBacklog: boolean }>;
  resources: DemandRow[];
  outside: DemandRow[];
}

export interface LegacyVolumeRow {
  ref: string;
  shadowKeys: string[];
  basis: "window" | "7d_rate";
  legacy: number;
  shadow: number;
  ratio: number | null;
  note: string | null;
  explained: boolean;
}

export interface LiveDecision {
  /** Frames the router reads (a fan message REST already confirmed, or one in
   *  an excluded chat, is read by nothing and counted in `notRead`). */
  frames: number;
  notRead: number;
  /** Frame received → the first shadow admission of its key after it. */
  shadowAdmissionLagMs: Quantiles;
  /** Frame received → the legacy store held it. */
  legacyArrivalLagMs: Quantiles;
  withoutShadowAdmission: number;
  withoutLegacyArrival: number;
  targetP95Ms: number;
  meetsTarget: boolean | null;
}

export interface OfflineDecisions {
  from: Date;
  to: Date;
  receipts: number;
  fanMessageFrames: number;
  transactionFrames: number;
  /** Per resource: the signals routed, the reads after coalescing, the due lag. */
  byResource: Array<{ resource: string; signals: number; reads: number; dueLagMs: Quantiles }>;
}

export interface ShadowWindowReport {
  window: { start: Date; end: Date };
  demand: PageDemand[];
  legacy: LegacyVolumeRow[];
  livePath: { fanMessages: LiveDecision; transactions: LiveDecision; unreadableReceipts: number; offline: OfflineDecisions | null };
  pacer: { pages: Array<{ page: string; sends: number; minGapMs: number | null; violations: number }>; violations: number };
  verdict: { a1: boolean; a2: boolean; a3: boolean | null; a4: boolean };
}

/** A socket frame of the window: its page, time, the work key it routes to
 *  (resource, subject) and the id the legacy store keys it by. */
interface FrameFact { pageId: number; atMs: number; resource: string; subject: string; ref: string }

interface WindowFrames {
  receipts: number;
  unreadable: number;
  fanMessages: Array<Omit<FrameFact, "resource"> & { item: WsItem }>;
  transactions: FrameFact[];
  /** Per page, the decoded receipts (routing input). */
  byPage: Map<number, Array<{ atMs: number; items: WsItem[] }>>;
}

async function readWindowFrames(
  db: Database,
  input: { from: Date; to: Date; pageIds: readonly number[]; resolvePayload?: FanslyWsLivePayloadResolver },
): Promise<WindowFrames> {
  const frames: WindowFrames = { receipts: 0, unreadable: 0, fanMessages: [], transactions: [], byPage: new Map() };
  for await (const batch of decodedReceiptsInWindow(db, input)) {
    for (const receipt of batch) {
      frames.receipts += 1;
      if (receipt.decoded === null) {
        frames.unreadable += 1;
        continue;
      }
      const atMs = receipt.receivedAt.getTime();
      frames.byPage.set(receipt.pageId, [...(frames.byPage.get(receipt.pageId) ?? []), { atMs, items: receipt.decoded.items }]);
      for (const item of receipt.decoded.items) {
        if (item.kind === "message_created" && !item.isOwn) {
          frames.fanMessages.push({ pageId: receipt.pageId, atMs, subject: item.message.groupId, ref: item.message.id, item });
        } else if (item.kind === "transaction" && item.status === FANSLY_TRANSACTION_STATUS_NEW && item.type !== FANSLY_PAYOUT_TRANSACTION_TYPE) {
          frames.transactions.push({ pageId: receipt.pageId, atMs, resource: "transactions.head", subject: "", ref: item.id });
        }
      }
    }
  }
  return frames;
}

/** The keys that read a fan message: the chat's head, or finding the chat. */
const FAN_MESSAGE_READ_KEYS: ReadonlySet<string> = new Set(["dm-messages.head", "dm-conversations.find"]);

/** Each fan-message frame with the key the router sends it to; frames no key
 *  reads (already confirmed, an excluded chat) are counted apart. */
async function routedFanFrames(
  db: Database,
  frames: WindowFrames["fanMessages"],
): Promise<{ routed: FrameFact[]; notRead: number }> {
  const routed: FrameFact[] = [];
  let notRead = 0;
  const pageIds = [...new Set(frames.map((frame) => frame.pageId))];
  for (const pageId of pageIds) {
    const ofPage = frames.filter((frame) => frame.pageId === pageId).sort((a, b) => a.atMs - b.atMs);
    const decisions = await routeReceiptsOffline(db, { pageId, receipts: ofPage.map((frame) => ({ atMs: frame.atMs, items: [frame.item] })) });
    ofPage.forEach((frame, index) => {
      const signal = decisions[index]?.signals.find((entry) => FAN_MESSAGE_READ_KEYS.has(entry.resource) && entry.subject === frame.subject);
      if (signal === undefined) notRead += 1;
      else routed.push({ pageId, atMs: frame.atMs, resource: signal.resource, subject: frame.subject, ref: frame.ref });
    });
  }
  return { routed, notRead };
}

/** The reads the frames of each page imply, per page and resource. */
async function impliedReads(
  db: Database,
  byPage: Map<number, Array<{ atMs: number; items: WsItem[] }>>,
): Promise<{ byPage: Map<number, Map<string, SimulatedReads>>; signals: Map<string, number> }> {
  const coalesceOf = (resource: string) => FANSLY_RESOURCE_SPECS.find((spec) => spec.key === resource)?.coalesce;
  const result = new Map<number, Map<string, SimulatedReads>>();
  const signalCounts = new Map<string, number>();
  for (const [pageId, receipts] of byPage) {
    const routed = await routeReceiptsOffline(db, { pageId, receipts });
    const signals = routed.flatMap((receipt) => coalescedSignalsOf(receipt.atMs, receipt.signals));
    for (const signal of signals) signalCounts.set(signal.resource, (signalCounts.get(signal.resource) ?? 0) + 1);
    result.set(pageId, simulateCoalescedReads(signals, coalesceOf));
  }
  return { byPage: result, signals: signalCounts };
}

function demandOfPage(
  page: SyncPageRow,
  input: { windowMs: number; observed: Map<string, { class: string; attempts: number }>; reads: Map<string, SimulatedReads> | undefined },
): PageDemand {
  const hours = input.windowMs / HOUR_MS;
  const rows: DemandRow[] = [];
  const keys = new Set([...input.observed.keys(), ...(input.reads?.keys() ?? [])]);
  for (const spec of FANSLY_RESOURCE_SPECS) {
    if (spec.kind === "poll" && spec.period !== undefined && runsIn(spec, true) && !resourceDisabled(page, spec.key)) keys.add(spec.key);
  }
  const walks: PageDemand["walks"] = [];
  let steadyState = 0;
  const attempts = { urgent: 0, requests: 0, planned: 0 };
  for (const key of [...keys].sort()) {
    const spec = FANSLY_RESOURCE_SPECS.find((entry) => entry.key === key);
    const observedRow = input.observed.get(key);
    const observed = observedRow?.attempts ?? 0;
    const workClass = observedRow?.class ?? spec?.class ?? "planned";
    if (workClass === "urgent" || workClass === "requests" || workClass === "planned") attempts[workClass] += observed;
    if (spec?.kind === "goal") {
      walks.push({ resource: key, observed, oneTimeBacklog: ONE_TIME_BACKLOG_KEYS.has(key) });
      continue;
    }
    if (workClass !== "requests") steadyState += observed;
    rows.push(demandRow(page, spec, key, workClass, observed, input.windowMs, input.reads?.get(key)));
  }
  const band = { min: STEADY_STATE_BAND_PER_HOUR.min * hours, max: STEADY_STATE_BAND_PER_HOUR.max * hours };
  return {
    page: page.pageLabel ?? String(page.pageId),
    mode: page.mode,
    attempts,
    steadyState,
    band,
    inBand: steadyState >= band.min && steadyState <= band.max,
    walks,
    resources: rows,
    outside: rows.filter((row) => row.verdict === "outside"),
  };
}

function demandRow(
  page: SyncPageRow,
  spec: ResourceSpec | undefined,
  key: string,
  workClass: string,
  observed: number,
  windowMs: number,
  reads: SimulatedReads | undefined,
): DemandRow {
  const kind = spec?.kind ?? "unknown";
  const periodMs = spec === undefined || spec.kind !== "poll" || resourceDisabled(page, key) ? null : effectivePeriodMs(spec, page);
  const polls = periodMs === null ? null : windowMs / periodMs;
  const socket = reads?.reads ?? null;
  const expected = polls === null && socket === null ? null : (polls ?? 0) + (socket ?? 0);
  const basis = `polls ${polls === null ? "—" : polls.toFixed(2)}, socket reads ${socket ?? "—"}`;
  if (expected === null) {
    const triggers = spec?.triggers ?? [];
    const reason = spec === undefined
      ? "not in the registry"
      : triggers.some((trigger) => trigger.startsWith("apply:")) ? "follow-up of applies (the shadow estimate)"
        : triggers.includes("owner") ? "owner-triggered"
          : "demand not modelled by the report";
    return { resource: key, class: workClass, kind, observed, expected: null, ratio: null, verdict: "not_modelled", reason };
  }
  if (expected < 1 && observed <= 1) {
    return { resource: key, class: workClass, kind, observed, expected, ratio: null, verdict: "ok", reason: `at most one run expected (${basis})` };
  }
  const ratio = expected === 0 ? null : observed / expected;
  const inside = ratio !== null && ratio >= EXPECTATION_RATIO_BAND.min && ratio <= EXPECTATION_RATIO_BAND.max;
  return {
    resource: key,
    class: workClass,
    kind,
    observed,
    expected,
    ratio,
    verdict: inside ? "ok" : "outside",
    reason: inside ? basis : `observed ${observed} vs expected ${expected.toFixed(2)} (${basis})`,
  };
}

async function legacyVolume(
  db: Database,
  input: { pages: readonly SyncPageRow[]; window: { start: Date; end: Date }; observed: Map<number, Map<string, { class: string; attempts: number }>> },
): Promise<LegacyVolumeRow[]> {
  const pageIds = input.pages.map((page) => page.pageId);
  const windowMs = input.window.end.getTime() - input.window.start.getTime();
  const inWindow = await countLegacyFanslyAttempts(db, { pageIds, from: input.window.start, to: input.window.end });
  const weekFrom = new Date(input.window.end.getTime() - 7 * 24 * HOUR_MS);
  const inWeek = await countLegacyFanslyAttempts(db, { pageIds, from: weekFrom, to: input.window.end });
  const legacyOf = (counts: typeof inWindow, ref: string) =>
    counts.streams.filter((row) => `stream:${row.stream}` === ref).reduce((total, row) => total + row.attempts, 0)
    + counts.senders.filter((row) => `sender:${row.source}` === ref).reduce((total, row) => total + row.attempts, 0);
  const keysByRef = new Map<string, ResourceSpec[]>();
  for (const spec of FANSLY_RESOURCE_SPECS) {
    for (const ref of spec.legacy) keysByRef.set(refKey(ref), [...(keysByRef.get(refKey(ref)) ?? []), spec]);
  }
  const rows: LegacyVolumeRow[] = [];
  for (const [ref, specs] of [...keysByRef].sort(([a], [b]) => a.localeCompare(b))) {
    const keys = specs.map((spec) => spec.key);
    // A stream whose keys all run less often than the window is compared as
    // a rate over the legacy week (one hour holds at most one of their runs).
    const longPeriod = specs.every((spec) => spec.kind === "poll" && (spec.period?.everyMs ?? 0) > windowMs);
    let legacy: number;
    let shadow = 0;
    if (longPeriod) {
      legacy = legacyOf(inWeek, ref) * (windowMs / (7 * 24 * HOUR_MS));
      for (const page of input.pages) {
        for (const spec of specs) {
          const period = resourceDisabled(page, spec.key) ? null : effectivePeriodMs(spec, page);
          if (period !== null) shadow += windowMs / period;
        }
      }
    } else {
      legacy = legacyOf(inWindow, ref);
      for (const observed of input.observed.values()) {
        for (const key of keys) shadow += observed.get(key)?.attempts ?? 0;
      }
    }
    const ratio = legacy === 0 ? null : shadow / legacy;
    const note = LEGACY_VOLUME_NOTES[ref] ?? null;
    const inside = ratio !== null && ratio >= EXPECTATION_RATIO_BAND.min && ratio <= EXPECTATION_RATIO_BAND.max;
    rows.push({
      ref,
      shadowKeys: keys,
      basis: longPeriod ? "7d_rate" : "window",
      legacy: Math.round(legacy * 100) / 100,
      shadow: Math.round(shadow * 100) / 100,
      ratio,
      note,
      explained: inside || note !== null || (legacy === 0 && shadow === 0),
    });
  }
  return rows;
}

async function liveDecision(
  db: Database,
  input: {
    frames: FrameFact[];
    notRead: number;
    pageIds: readonly number[];
    window: { start: Date; end: Date };
    target: number;
    kind: "messages" | "transactions";
  },
): Promise<LiveDecision> {
  const admissions = await listSyncAdmissions(db, {
    pageIds: input.pageIds,
    shadow: true,
    resources: [...new Set(input.frames.map((frame) => frame.resource))],
    from: input.window.start,
    to: new Date(input.window.end.getTime() + ADMISSION_SEARCH_MS),
  });
  const keyOf = (pageId: number, resource: string, subject: string) => `${pageId}\u0000${resource}\u0000${subject}`;
  const byKey = new Map<string, number[]>();
  for (const admission of admissions) {
    const key = keyOf(admission.pageId, admission.resource, admission.subject);
    byKey.set(key, [...(byKey.get(key) ?? []), admission.admittedAt.getTime()]);
  }
  const arrivals = new Map<number, Map<string, Date>>();
  for (const pageId of input.pageIds) {
    const refs = input.frames.filter((frame) => frame.pageId === pageId).map((frame) => frame.ref);
    if (refs.length === 0) continue;
    arrivals.set(pageId, input.kind === "messages"
      ? await readLegacyMessageArrivals(db, { pageId, messageIds: refs })
      : await readLedgerTransactionsCreatedAt(db, { pageId, transactionIds: refs }));
  }
  const shadowLags: number[] = [];
  const legacyLags: number[] = [];
  let withoutShadow = 0;
  let withoutLegacy = 0;
  for (const frame of input.frames) {
    const admitted = byKey.get(keyOf(frame.pageId, frame.resource, frame.subject))?.find((at) => at >= frame.atMs);
    if (admitted === undefined) withoutShadow += 1;
    else shadowLags.push(admitted - frame.atMs);
    const arrived = arrivals.get(frame.pageId)?.get(frame.ref);
    if (arrived === undefined) withoutLegacy += 1;
    else legacyLags.push(Math.max(0, arrived.getTime() - frame.atMs));
  }
  const shadowQ = quantiles(shadowLags);
  return {
    frames: input.frames.length,
    notRead: input.notRead,
    shadowAdmissionLagMs: shadowQ,
    legacyArrivalLagMs: quantiles(legacyLags),
    withoutShadowAdmission: withoutShadow,
    withoutLegacyArrival: withoutLegacy,
    targetP95Ms: input.target,
    meetsTarget: shadowQ === null ? null : shadowQ.p95 <= input.target && withoutShadow === 0,
  };
}

async function offlineDecisions(
  db: Database,
  input: { pageIds: readonly number[]; to: Date; resolvePayload?: FanslyWsLivePayloadResolver },
): Promise<OfflineDecisions> {
  const from = new Date(input.to.getTime() - OFFLINE_DECISIONS_LOOKBACK_MS);
  const frames = await readWindowFrames(db, {
    from,
    to: input.to,
    pageIds: input.pageIds,
    ...(input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload }),
  });
  const implied = await impliedReads(db, frames.byPage);
  const merged = new Map<string, { reads: number; dueLagsMs: number[] }>();
  for (const reads of implied.byPage.values()) {
    for (const [resource, simulated] of reads) {
      const current = merged.get(resource) ?? { reads: 0, dueLagsMs: [] };
      merged.set(resource, { reads: current.reads + simulated.reads, dueLagsMs: [...current.dueLagsMs, ...simulated.dueLagsMs] });
    }
  }
  return {
    from,
    to: input.to,
    receipts: frames.receipts,
    fanMessageFrames: frames.fanMessages.length,
    transactionFrames: frames.transactions.length,
    byResource: [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([resource, simulated]) => ({
      resource,
      signals: implied.signals.get(resource) ?? 0,
      reads: simulated.reads,
      dueLagMs: quantiles(simulated.dueLagsMs),
    })),
  };
}

/** Part A of the shadow report over [start, end). */
export async function reportShadowWindow(db: Database, input: ShadowWindowInput): Promise<ShadowWindowReport> {
  const { start, end } = input.window;
  const windowMs = end.getTime() - start.getTime();
  if (!(windowMs > 0)) throw new Error("the report window must end after it starts");
  const pageIds = input.pages.map((page) => page.pageId);
  const resolve = input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload };

  // A1: demand against its expectation.
  const observed = new Map<number, Map<string, { class: string; attempts: number }>>();
  for (const row of await countSyncAttemptsByKey(db, { pageIds, shadow: true, from: start, to: end })) {
    const page = observed.get(row.pageId) ?? new Map<string, { class: string; attempts: number }>();
    const current = page.get(row.resource);
    page.set(row.resource, { class: row.class, attempts: (current?.attempts ?? 0) + row.attempts });
    observed.set(row.pageId, page);
  }
  const frames = await readWindowFrames(db, { from: start, to: end, pageIds, ...resolve });
  const implied = await impliedReads(db, frames.byPage);
  const demand = input.pages.map((page) => demandOfPage(page, {
    windowMs,
    observed: observed.get(page.pageId) ?? new Map(),
    reads: implied.byPage.get(page.pageId),
  }));

  // A2: the legacy engine's hour.
  const legacy = await legacyVolume(db, { pages: input.pages, window: input.window, observed });

  // A3: live-path decisions.
  const fan = await routedFanFrames(db, frames.fanMessages);
  const fanMessages = await liveDecision(db, {
    frames: fan.routed,
    notRead: fan.notRead,
    pageIds,
    window: input.window,
    target: LIVE_PATH_TARGET_P95_MS.messages,
    kind: "messages",
  });
  const transactions = await liveDecision(db, {
    frames: frames.transactions,
    notRead: 0,
    pageIds,
    window: input.window,
    target: LIVE_PATH_TARGET_P95_MS.transactions,
    kind: "transactions",
  });
  const offline = frames.fanMessages.length < LIVE_PATH_MIN_SAMPLE.messages || frames.transactions.length < LIVE_PATH_MIN_SAMPLE.transactions
    ? await offlineDecisions(db, { pageIds, to: start, ...resolve })
    : null;

  // A4: the pacer's self-check over the shadow journal.
  const pace = await readSyncJournalMetrics(db, { pageIds, shadow: true, since: start, until: end });
  const pacerPages = input.pages.map((page) => {
    const row = pace.find((entry) => entry.pageId === page.pageId);
    return {
      page: page.pageLabel ?? String(page.pageId),
      sends: (row?.sends.urgent ?? 0) + (row?.sends.requests ?? 0) + (row?.sends.planned ?? 0),
      minGapMs: row?.minGapMs ?? null,
      violations: row?.paceViolations ?? 0,
    };
  });
  const violations = pacerPages.reduce((total, row) => total + row.violations, 0);

  const decisions = [fanMessages.meetsTarget, transactions.meetsTarget].filter((value): value is boolean => value !== null);
  return {
    window: input.window,
    demand: demand.map((page) => ({ ...page, outside: page.outside.slice(0, input.maxListed) })),
    legacy,
    livePath: { fanMessages, transactions, unreadableReceipts: frames.unreadable, offline },
    pacer: { pages: pacerPages, violations },
    verdict: {
      a1: demand.every((page) => page.inBand),
      a2: legacy.every((row) => row.explained),
      a3: decisions.length === 0 ? null : decisions.every(Boolean),
      a4: violations === 0,
    },
  };
}
