import { activeFanslyPageHold, isIndefinite, type FanslyPageHoldKind } from "@agency_hub_core/shared";

import {
  activeResourceHold,
  isEndpointRateLimitKind,
  type ResourceHoldEntry,
  type ResourceHoldKind,
} from "./errors.ts";
import { TAKEOVER_FACTOR } from "./pacer.ts";
import { WORK_CLASSES, type WorkClass } from "./scheduler.ts";

// "Почему ждёт" (plan §10, design §3.9): one closed dictionary of reasons a
// piece of work is not being served, and the page status the owner API, the
// agent CLI and `pnpm cli sync status` show. Durable reasons (written on the
// work row when they arise) are `running`, `quarantined`, `blocked_by_vendor`,
// `subject_breaker`, `dependency` and `not_due` — and `pacer` for a request
// an endpoint group's spacing put off (owner decision №20); the dynamic ones (pauses,
// holds, ownership, pacer, class share) are computed here, so serving a slot
// never writes a row just to say why the others wait.

export const WAITING_REASONS = [
  "not_due",
  "pacer",
  "class_share",
  "page_hold",
  "resource_hold",
  "subject_breaker",
  "blocked_by_vendor",
  "quarantined",
  "paused",
  "dependency",
  "ownership_unconfirmed",
  "running",
] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];

/** The owner heartbeat (written every 10 s) counts as fresh for three beats. */
export const OWNER_HEARTBEAT_FRESH_MS = 30_000;

export type SyncPageModeView = "off" | "shadow" | "handover" | "live";

/** The work fields the explanation reads; names follow the `sync_work` row. */
export interface StatusWork {
  id: number;
  resource: string;
  subject: string;
  class: WorkClass;
  state: "open" | "running" | "quarantined" | "done" | "cancelled" | "superseded";
  dueAt: Date;
  breakerUntil: Date | null;
  blockedByVendorAt: Date | null;
  waitingReason: WaitingReason | null;
  waitingUntil: Date | null;
}

export interface StatusPageOwner {
  generation: bigint;
  host: string | null;
  acquiredAt: Date | null;
  heartbeatAt: Date | null;
  releasedAt: Date | null;
  releaseGeneration: bigint | null;
}

/** The page fields the explanation reads; names follow the `sync_pages` row. */
export interface StatusPage {
  mode: SyncPageModeView;
  pausedAll: boolean;
  pausedRequests: boolean;
  pausedResources: readonly string[];
  holdKind: FanslyPageHoldKind | null;
  holdUntil: Date | null;
  holdSince: Date | null;
  holdDetail: Readonly<Record<string, unknown>>;
  resourceHolds: Readonly<Record<string, ResourceHoldEntry>>;
  owner: StatusPageOwner;
}

/** What only the running engine knows (or the caller estimates). */
export interface RuntimeSnapshot {
  /** When the page's next slot opens by the pacer; null = open now, or not
   *  known (no actor in this process: use `estimateSlotOpensAt`). */
  slotOpensAt: Date | null;
}

export interface WorkExplanation {
  reason: WaitingReason;
  until: Date | null;
  detail: Record<string, unknown>;
}

/** The page has an owner that is running a loop: a fresh heartbeat of the
 *  current generation that was not released, in a mode an actor runs in. */
export function ownerRunning(page: Pick<StatusPage, "mode" | "owner">, now: Date): boolean {
  if (page.mode !== "shadow" && page.mode !== "live") return false;
  const { owner } = page;
  if (owner.generation === 0n || owner.heartbeatAt === null) return false;
  if (owner.releasedAt !== null && owner.releaseGeneration === owner.generation) return false;
  return now.getTime() - owner.heartbeatAt.getTime() <= OWNER_HEARTBEAT_FRESH_MS;
}

/**
 * Why `work` is not being served now (design §3.9). Precedence, first match
 * wins: running → ownership_unconfirmed → paused → page_hold → quarantined →
 * blocked_by_vendor → subject_breaker → resource_hold → dependency → not_due →
 * pacer → class_share. Null for closed work (done, cancelled, superseded):
 * it waits for nothing.
 */
export function explainWork(
  work: StatusWork,
  page: StatusPage,
  runtime: RuntimeSnapshot,
  now: Date,
): WorkExplanation | null {
  if (work.state === "done" || work.state === "cancelled" || work.state === "superseded") return null;
  const at = now.getTime();
  const after = (instant: Date | null): boolean => instant !== null && instant.getTime() > at;

  if (work.state === "running") return { reason: "running", until: null, detail: {} };
  if (!ownerRunning(page, now)) {
    return {
      reason: "ownership_unconfirmed",
      until: null,
      detail: { mode: page.mode, ownerHeartbeatAt: page.owner.heartbeatAt?.toISOString() ?? null },
    };
  }
  if (page.pausedAll) return { reason: "paused", until: null, detail: { scope: "page" } };
  if (work.class === "requests" && page.pausedRequests) {
    return { reason: "paused", until: null, detail: { scope: "requests" } };
  }
  if (page.pausedResources.includes(work.resource)) {
    return { reason: "paused", until: null, detail: { scope: "resource" } };
  }
  const hold = activeFanslyPageHold(page, now);
  if (hold !== null) {
    return { reason: "page_hold", until: hold.until, detail: { kind: hold.kind } };
  }
  if (work.state === "quarantined") return { reason: "quarantined", until: null, detail: {} };
  if (work.blockedByVendorAt !== null) {
    return {
      reason: "blocked_by_vendor",
      until: work.breakerUntil,
      detail: { since: work.blockedByVendorAt.toISOString() },
    };
  }
  if (after(work.breakerUntil)) {
    return { reason: "subject_breaker", until: work.breakerUntil, detail: {} };
  }
  const resourceHold = activeResourceHold(page.resourceHolds, work.resource, now);
  if (resourceHold !== null) {
    return {
      reason: "resource_hold",
      until: resourceHold.until,
      detail: { file: resourceHold.file, step: resourceHold.step, kind: resourceHold.kind },
    };
  }
  if (work.waitingReason === "dependency" && after(work.dueAt)) {
    return { reason: "dependency", until: work.waitingUntil ?? work.dueAt, detail: {} };
  }
  // An endpoint group's spacing (owner decision №20): due again when it ends.
  if (work.waitingReason === "pacer" && after(work.dueAt)) return { reason: "pacer", until: work.dueAt, detail: { spacing: true } };
  if (after(work.dueAt)) return { reason: "not_due", until: work.dueAt, detail: {} };
  if (after(runtime.slotOpensAt)) return { reason: "pacer", until: runtime.slotOpensAt, detail: {} };
  return { reason: "class_share", until: null, detail: { class: work.class } };
}

/**
 * When the page's next slot opens at the latest, from the facts in the
 * database: the last actual send + S × 1.2 (the largest jitter), and not
 * before the last completion. For a status read outside the actor.
 */
export function estimateSlotOpensAt(input: {
  lastSendAt: Date | null;
  lastCompletedAt: Date | null;
  settingMs: number;
}): Date | null {
  const candidates: number[] = [];
  if (input.lastSendAt !== null) {
    candidates.push(input.lastSendAt.getTime() + Math.ceil(input.settingMs * TAKEOVER_FACTOR));
  }
  if (input.lastCompletedAt !== null) candidates.push(input.lastCompletedAt.getTime());
  return candidates.length === 0 ? null : new Date(Math.max(...candidates));
}

// ── page status ─────────────────────────────────────────────────────────────

/** A runnable row waits only for its slot (`pacer`) or for other work
 *  (`class_share`); everything else is a wait reason of its own. */
export function isRunnableReason(reason: WaitingReason): boolean {
  return reason === "pacer" || reason === "class_share";
}

export interface ClassQueueStatus {
  runnable: number;
  waitingByReason: Partial<Record<WaitingReason, number>>;
}

export type QueueStatus = Record<WorkClass, ClassQueueStatus>;

/** Count the open work of a page by class: runnable, and waiting by reason. */
export function summarizeQueue(
  works: readonly StatusWork[],
  page: StatusPage,
  runtime: RuntimeSnapshot,
  now: Date,
): QueueStatus {
  const queue = Object.fromEntries(
    WORK_CLASSES.map((workClass) => [workClass, { runnable: 0, waitingByReason: {} }]),
  ) as QueueStatus;
  for (const work of works) {
    const explanation = explainWork(work, page, runtime, now);
    if (explanation === null) continue;
    const entry = queue[work.class];
    if (isRunnableReason(explanation.reason)) entry.runnable += 1;
    entry.waitingByReason[explanation.reason] = (entry.waitingByReason[explanation.reason] ?? 0) + 1;
  }
  return queue;
}

export interface RequestProgressView {
  ref: string;
  itemsReady: number;
  itemsTotal: number;
  readsDone: number;
  readsRemainingMin: number;
  etaEstimateSeconds: number | null;
}

export interface WsStatusView {
  connected: boolean;
  since: string | null;
  gapSince: string | null;
  decodeDebt: number;
}

export interface ShadowStatusView {
  attemptsLastHour: number;
  /** Shadow attempts of the hour over the computed expectation (§3.12 A1). */
  demandVsEstimate: number | null;
}

export interface PageStatus {
  pageLabel: string | null;
  mode: SyncPageModeView;
  owner: { generation: string; host: string | null; acquiredAt: string | null; heartbeatAt: string | null; running: boolean };
  pause: { settingMs: number; lastSendAt: string | null; minGapLastHourMs: number | null; violationsLastDay: number };
  sendsLastHour: { urgent: number; requests: number; planned: number; byResource: Record<string, number> };
  queue: QueueStatus;
  holds: {
    /** `until` is an ISO instant, or "infinity" for an auth / identity hold
     *  that only new credentials lift. */
    page: { kind: FanslyPageHoldKind; until: string; since: string | null } | null;
    /** `kind`: the file's breaker, or the conversation list's own 429 hold. */
    resources: Array<{ file: string; until: string; step: number; kind: ResourceHoldKind }>;
  };
  breakers: { open: number; blockedByVendor: number };
  quarantined: number;
  requests: RequestProgressView[];
  ws: WsStatusView | null;
  shadow: ShadowStatusView | null;
}

export interface PageStatusInput {
  pageLabel: string | null;
  page: StatusPage & { lastSendAt: Date | null };
  /** S as the actor reads it (the live owner key). */
  settingMs: number;
  now: Date;
  runtime: RuntimeSnapshot;
  /** The page's open, running and quarantined work. */
  works: readonly StatusWork[];
  sends: {
    lastHour: { urgent: number; requests: number; planned: number; byResource: Record<string, number> };
    minGapLastHourMs: number | null;
    violationsLastDay: number;
  };
  requests?: readonly RequestProgressView[];
  ws?: WsStatusView | null;
  shadow?: ShadowStatusView | null;
}

/** Assemble the page status from the page row, its open work and the
 *  aggregates the caller read (sends, requests, socket, shadow). */
export function buildPageStatus(input: PageStatusInput): PageStatus {
  const { page, now } = input;
  const at = now.getTime();
  const hold = activeFanslyPageHold(page, now);
  const resources = Object.entries(page.resourceHolds)
    .filter(([, entry]) => new Date(entry.until).getTime() > at)
    .map(([file, entry]) => ({
      file,
      until: new Date(entry.until).toISOString(),
      step: entry.step,
      kind: isEndpointRateLimitKind(entry.kind) ? entry.kind : "breaker" as const,
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  let breakersOpen = 0;
  let blockedByVendor = 0;
  let quarantined = 0;
  for (const work of input.works) {
    if (work.state === "quarantined") quarantined += 1;
    if (work.state === "done" || work.state === "cancelled" || work.state === "superseded") continue;
    if (work.blockedByVendorAt !== null) blockedByVendor += 1;
    else if (work.breakerUntil !== null && work.breakerUntil.getTime() > at) breakersOpen += 1;
  }
  return {
    pageLabel: input.pageLabel,
    mode: page.mode,
    owner: {
      generation: page.owner.generation.toString(),
      host: page.owner.host,
      acquiredAt: page.owner.acquiredAt?.toISOString() ?? null,
      heartbeatAt: page.owner.heartbeatAt?.toISOString() ?? null,
      running: ownerRunning(page, now),
    },
    pause: {
      settingMs: input.settingMs,
      lastSendAt: page.lastSendAt?.toISOString() ?? null,
      minGapLastHourMs: input.sends.minGapLastHourMs,
      violationsLastDay: input.sends.violationsLastDay,
    },
    sendsLastHour: input.sends.lastHour,
    queue: summarizeQueue(input.works, page, input.runtime, now),
    holds: {
      page: hold === null
        ? null
        : {
          kind: hold.kind,
          until: isIndefinite(hold.until) ? "infinity" : hold.until.toISOString(),
          since: page.holdSince?.toISOString() ?? null,
        },
      resources,
    },
    breakers: { open: breakersOpen, blockedByVendor },
    quarantined,
    requests: [...(input.requests ?? [])],
    ws: input.ws ?? null,
    shadow: input.shadow ?? null,
  };
}
