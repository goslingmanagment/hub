import { fanslyPageHoldInForce, isIndefinite, type FanslyPageHoldKind } from "@agency_hub_core/shared";

import { heldByScope, resourceFilesHeld, type HoldSet, type RouteAdmissionView } from "./admission.ts";
import type { ResourceHoldKind } from "./errors.ts";
import { TAKEOVER_FACTOR } from "./pacer.ts";
import { WORK_CLASSES, type WorkClass } from "./scheduler.ts";

// "Почему ждёт" (plan §10, design §3.9): one closed dictionary of reasons a
// piece of work is not being served, and the page status the owner API, the
// agent CLI and `pnpm cli sync status` show. Durable reasons (written on the
// work row when they arise) are `running`, `quarantined`, `blocked_by_vendor`,
// `subject_breaker`, `dependency` and `not_due` — and `pacer` for a request
// its route's budget or hold put off (step 3b, `engine/route-policy.ts`); the
// dynamic ones (pauses, holds, ownership, route budgets and holds, pacer,
// class share) are computed here, so serving a slot never writes a row just
// to say why the others wait. What holds a row — the page, its subject's
// breaker, its file's breaker, its route — is the hold evaluator's answer
// (`engine/admission.ts`); `route_budget` and `route_hold` are computed only
// (a row put off by its route stores `pacer`).

export const WAITING_REASONS = [
  "not_due",
  "pacer",
  "class_share",
  "page_hold",
  "route_budget",
  "route_hold",
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
  /** False: the key makes no request (`http: false`), so its steps run
   *  before the HTTP gate (ruling 9) — no page hold and no pacer slot stops
   *  it. Absent: a key that sends. */
  http?: boolean;
}

export interface StatusPageOwner {
  generation: bigint;
  host: string | null;
  acquiredAt: Date | null;
  heartbeatAt: Date | null;
  releasedAt: Date | null;
  releaseGeneration: bigint | null;
}

/** The page fields the explanation reads; names follow the `sync_pages` row,
 *  `holds` is its hold set (`holdSetOf(page.holds)`). */
export interface StatusPage {
  mode: SyncPageModeView;
  pausedAll: boolean;
  pausedRequests: boolean;
  pausedResources: readonly string[];
  holds: HoldSet;
  owner: StatusPageOwner;
}

/** What only the running engine knows (or the caller estimates). */
export interface RuntimeSnapshot {
  /** When the page's next slot opens by the pacer; null = open now, or not
   *  known (no actor in this process: use `estimateSlotOpensAt`). */
  slotOpensAt: Date | null;
  /** The page's route admission as its clocks stand (`routeAdmissionView`;
   *  absent or null: not read, or the page's route state does not read). */
  routes?: RouteAdmissionView | null;
}

export interface WorkExplanation {
  reason: WaitingReason;
  until: Date | null;
  detail: Record<string, unknown>;
}

/** Whether an owner runs the page's loop, and when not, why: the page is in
 *  a mode no actor runs in (`mode`), nobody ever took it (`never_owned`), its
 *  owner let it go (`released`), or its owner stopped beating
 *  (`heartbeat_stale`). */
export type OwnerRunState =
  | { running: true }
  | { running: false; why: "mode" | "never_owned" | "released" }
  | { running: false; why: "heartbeat_stale"; heartbeatAgeMs: number };

/** The page's owner as its row says: running a loop — a fresh heartbeat of
 *  the current generation that was not released, in the mode an actor runs
 *  in — or not, and why. */
export function ownerRunState(page: Pick<StatusPage, "mode" | "owner">, now: Date): OwnerRunState {
  if (page.mode !== "live") return { running: false, why: "mode" };
  const { owner } = page;
  if (owner.generation === 0n || owner.heartbeatAt === null) return { running: false, why: "never_owned" };
  if (owner.releasedAt !== null && owner.releaseGeneration === owner.generation) return { running: false, why: "released" };
  const heartbeatAgeMs = now.getTime() - owner.heartbeatAt.getTime();
  return heartbeatAgeMs <= OWNER_HEARTBEAT_FRESH_MS ? { running: true } : { running: false, why: "heartbeat_stale", heartbeatAgeMs };
}

/** The page has an owner that is running a loop (`ownerRunState`). */
export function ownerRunning(page: Pick<StatusPage, "mode" | "owner">, now: Date): boolean {
  return ownerRunState(page, now).running;
}

/** Until when the route its request planned put the work off — the row's own
 *  record of the final check before an admission (`deferForRoute`:
 *  `waiting_reason = 'pacer'`, due when the route opens). Null: no route put it
 *  off, its time has come, or its key sends nothing. */
export function routePutOffUntil(work: Pick<StatusWork, "dueAt" | "waitingReason" | "http">, now: Date): Date | null {
  return work.http !== false && work.waitingReason === "pacer" && work.dueAt.getTime() > now.getTime() ? work.dueAt : null;
}

/**
 * Why `work` is not being served now (design §3.9). Precedence, first match
 * wins: running → ownership_unconfirmed → paused → page_hold → quarantined →
 * blocked_by_vendor → subject_breaker → resource_hold → dependency → not_due →
 * route_hold / route_budget → pacer → class_share. What holds the row — the
 * page, its subject, its file, its route — is `heldByScope`'s answer. A key
 * without requests (`http: false`) never waits on the page hold, the route
 * admission or the pacer (ruling 9): due, it waits for its turn among the
 * steps before the gate (`class_share`). Null for closed work (done,
 * cancelled, superseded): it waits for nothing.
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
  const sends = work.http !== false;
  // Its planned route's budget or hold put the request off (the row stores
  // `pacer`): due again when the route opens.
  const putOffUntil = routePutOffUntil(work, now);
  const held = heldByScope(page.holds, sends ? runtime.routes ?? null : null, { work: { ...work, putOffUntil } }, now);
  if (held.page !== null && sends) {
    // Rows of the hold set this build cannot read close the page's admission.
    if (held.page.kind === "unreadable") return { reason: "page_hold", until: held.page.until, detail: { holdSet: held.page.diagnostic } };
    return { reason: "page_hold", until: held.page.until, detail: { kind: held.page.kind } };
  }
  if (work.state === "quarantined") return { reason: "quarantined", until: null, detail: {} };
  if (held.subject !== null) {
    return held.subject.kind === "blocked_by_vendor"
      ? { reason: "blocked_by_vendor", until: held.subject.until, detail: { since: work.blockedByVendorAt!.toISOString() } }
      : { reason: "subject_breaker", until: held.subject.until, detail: {} };
  }
  if (held.resource !== null) {
    return {
      reason: "resource_hold",
      until: held.resource.until,
      detail: { file: held.resource.file, step: held.resource.step, kind: "breaker" satisfies ResourceHoldKind },
    };
  }
  if (work.waitingReason === "dependency" && after(work.dueAt)) {
    return { reason: "dependency", until: work.waitingUntil ?? work.dueAt, detail: {} };
  }
  if (putOffUntil === null && after(work.dueAt)) return { reason: "not_due", until: work.dueAt, detail: {} };
  // The route its request planned put it off, or every route of its key is
  // closed (the pick leaves it out until one opens): by a 429's hold of a
  // route (`route_hold`, with the routes held), else by the routes' budgets.
  if (held.route !== null) {
    return held.route.scope === "route_hold"
      ? { reason: "route_hold", until: held.route.until, detail: { routes: held.route.routes, held: held.route.held } }
      : { reason: "route_budget", until: held.route.until, detail: { routes: held.route.routes } };
  }
  if (sends && after(runtime.slotOpensAt)) return { reason: "pacer", until: runtime.slotOpensAt, detail: {} };
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

/** A runnable row waits only for its slot (`pacer`), for its route's budget
 *  to admit the next send (`route_budget`: the route's own pace, as the page's
 *  is the pacer's) or for other work (`class_share`); everything else is a
 *  wait reason of its own. */
export function isRunnableReason(reason: WaitingReason): boolean {
  return reason === "pacer" || reason === "route_budget" || reason === "class_share";
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

/** One route or family of a page in its status: its budget, its effective
 *  rate, its newest send, its hold and slowdown, and when it next admits one. */
export interface RouteBudgetStatusView {
  /** A canonical route (`fansly/routes.ts`) or a family (`family:<name>`). */
  name: string;
  family: string | null;
  ceilingPerMin: number;
  currentPerMin: number;
  /** The page's own rate on the route (a slowdown after a 429 only lowers it). */
  effectivePerMin: number;
  intervalMs: number;
  lastSendAt: string | null;
  holdUntil: string | null;
  /** The route's stored state after its 429s (null: none, or a family): the
   *  ladder step its next 429 takes, its newest 429, and the revision a
   *  `sync route raise` compares against. */
  ladderStep: number | null;
  last429At: string | null;
  revision: number | null;
  /** Null: open now. */
  opensAt: string | null;
}

export interface RouteStatusView {
  /** The budget table's hash (`ROUTE_POLICY_HASH`). */
  policyHash: string;
  /** A route state this build cannot read: the page admits nothing. */
  stateError: string | null;
  /** The routes the page sent on within the longest interval, or holds state
   *  for, and the families. */
  routes: RouteBudgetStatusView[];
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
    /** `kind`: the file's breaker (a 429 holds a route: `routes`). */
    resources: Array<{ file: string; until: string; step: number; kind: ResourceHoldKind }>;
  };
  breakers: { open: number; blockedByVendor: number };
  quarantined: number;
  requests: RequestProgressView[];
  ws: WsStatusView | null;
  /** The route budgets (owner CLI; not on the agent wire). */
  routes: RouteStatusView | null;
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
  routes?: RouteStatusView | null;
}

/** Assemble the page status from the page row, its open work and the
 *  aggregates the caller read (sends, requests, socket). */
export function buildPageStatus(input: PageStatusInput): PageStatus {
  const { page, now } = input;
  const at = now.getTime();
  // The page's own holds in force: the credentials hold when there is one,
  // else the network hold (the later end of the two counts).
  const hold = fanslyPageHoldInForce(page.holds.page, now);
  const resources = resourceFilesHeld(page.holds, now).map((file) => {
    const entry = page.holds.resources[file]!;
    return { file, until: entry.until.toISOString(), step: entry.step, kind: "breaker" as const };
  });
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
          since: (hold.credentials ?? hold.timed)!.since?.toISOString() ?? null,
        },
      resources,
    },
    breakers: { open: breakersOpen, blockedByVendor },
    quarantined,
    requests: [...(input.requests ?? [])],
    ws: input.ws ?? null,
    routes: input.routes ?? null,
  };
}
