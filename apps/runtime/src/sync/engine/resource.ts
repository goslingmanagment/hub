import {
  SYNC_WORK_PARAM_IDS_CAP,
  type Database,
  type SyncAttemptRow,
  type SyncPageRow,
  type SyncWaitingReason,
  type SyncWorkKind,
  type SyncWorkRow,
  type UpsertDemandInput,
} from "@agency_hub_core/db";
import type { FanslyWireId, FanslyWireParams } from "@agency_hub_core/fansly";

import { noopMetrics, type Metrics, type SettingsSource } from "./ports.ts";
import type { WorkClass } from "./scheduler.ts";

// The resource contract of the Fansly Sync Engine (design §4.1): what a
// registry entry declares and what its module does, as far as the engine runs
// it. The actor asks a module to PLAN one step (read-only), admits the one
// request a plan asks for, and hands the answer to the module's APPLY (live)
// or SHADOW (shadow: no answer, an estimate). The registry
// (`sync/fansly/registry.ts`) lists every entry; this file only defines the
// shape and the generic rules every entry shares (poll rows, demand → work
// row, a module that is not implemented yet).

/** A registry key `<file>.<variant>` (= `sync_work.resource`). */
export type ResourceKey = string;

/** Poll period: due = previous completion + everyMs × (0.9 … 1.1), random
 *  phase at creation (design §4.2). */
export interface PeriodSpec {
  everyMs: number;
  /** Followers reconcile: a demand earlier than this after the last full
   *  sweep waits (enforced by the resource's plan). */
  minIntervalMs?: number;
}

/** Coalescing of demand signals into one read (design §4.4). */
export interface CoalesceSpec {
  quietMs: number;
  maxMs: number;
  /** A further signal moves the due time later, up to the cap. */
  extendOnSignal: boolean;
  /** Attachments, tips, incomplete frames: a shorter window. */
  fast?: { quietMs: number; maxMs: number };
}

export interface SloSpec {
  /** When the result of urgent work is due (its deadline). */
  resultMs?: number;
  /** A planned resource not refreshed for this long is stale (alert 4);
   *  default 3 × period. */
  staleAfterMs?: number;
}

/** The fields of a registry entry the engine reads. The registry's own
 *  `ResourceSpec` (triggers, proof, walk, legacy coverage …) extends it. */
export interface EngineResourceSpec {
  key: ResourceKey;
  kind: SyncWorkKind;
  class: WorkClass;
  period?: PeriodSpec;
  coalesce?: CoalesceSpec;
  slo?: SloSpec;
  /** False only for entries applied from the socket (no request). */
  http: boolean;
  /** Never runs in shadow (socket connect, media download, repair). */
  liveOnly?: boolean;
  /** `sync_attempts.evidence`: the request parameters are coverage evidence
   *  and are never pruned (design §2.9). A shadow attempt never is. */
  evidence: boolean;
  /** The erasure fence the apply takes (I15). */
  fence: "dm_archive" | "none";
  /** HTTP statuses that are this resource's final answer for a subject
   *  (closed with a receipt, no breaker): purchases 404/410/422, … */
  terminalStatuses?: readonly number[];
  /** A walk over a `subject_refresh_state` plane: a subject failure breaks
   *  the queue subject, the walk row goes on (design §4.3). */
  subjectQueue?: boolean;
  /** Owner decision №6: a frequency change needs the owner (`--owner-approved`). */
  ownerProtected?: true;
  /** A goal the page always keeps one open row of — a walk over a queue other
   *  writers fill (the `subject_refresh_state` planes the projectors seed,
   *  design §4.3): created like a poll row (random phase over `recheckMs`)
   *  and never closed by its module, which re-checks its queue at least every
   *  `recheckMs` while nothing in it is due. */
  standing?: { recheckMs: number };
  /** The entry's code. Absent while it has not landed: the key's work waits
   *  on `dependency` and counts `not_implemented` (design §12, S2-07a). */
  module?: () => Promise<ResourceModule>;
}

/** One physical request a plan asks for. */
export interface RequestPlan<I extends FanslyWireId = FanslyWireId> {
  spec: I;
  params: FanslyWireParams<I>;
}

/** A demand for work (a follow-up of an apply, a router signal, an owner
 *  request). Kind and class come from the registry entry of `resource`. */
export interface DemandSignal {
  /** Default: the page of the actor that emits it. */
  pageId?: number;
  resource: ResourceKey;
  subject?: string;
  /** Earliest run; default: now, or the end of the coalescing quiet window. */
  dueAt?: Date;
  coalesce?: "normal" | "fast";
  demand?: { messageIds?: readonly string[]; txIds?: readonly string[]; reason: string };
  /** Non-secret parameters, written when the row is created. */
  params?: unknown;
  /** Subject ids the work serves in batches (fan ids of `fan-profiles.lookup`):
   *  merged into the open row's `params.ids`, first come first kept, at most
   *  `SYNC_WORK_PARAM_IDS_CAP`. */
  ids?: readonly string[];
  /** Result due in this many ms (urgent ordering); default: the SLO. */
  deadlineMs?: number;
}

/** What a step does to its work row (apply, shadow, no-HTTP). */
export interface WorkOutcome<C = unknown> {
  cursor?: C;
  proof?: unknown;
  result?: unknown;
  /** Close the work (honoured only when no newer demand arrived, I11). */
  close?: "done" | "cancelled";
  closeReason?: string;
  /** Next run while the row stays open. Default for a poll: the period. */
  nextDueAt?: Date;
  waitingReason?: SyncWaitingReason;
  /** The step satisfied the demand the attempt was admitted at (I11). */
  satisfiesRevision: boolean;
}

export type StepPlan<C = unknown> =
  /** Exactly one physical request. */
  | { kind: "request"; request: RequestPlan }
  /** The goal is met without a request. */
  | { kind: "done"; cursor?: C; proof?: unknown; result?: unknown; reason: string }
  /** Not now: a dependency, or not due. `until` null = re-check after
   *  `WAIT_RECHECK_MS`. */
  | { kind: "wait"; reason: "not_due" | "dependency"; until: Date | null; enqueue?: readonly DemandSignal[] }
  | { kind: "quarantine"; reason: string };

export interface PlanContext {
  db: Database;
  pageId: number;
  shadow: boolean;
  now: Date;
  page: SyncPageRow;
  registry: EngineRegistry;
  /** The live settings (absent: the registry defaults). */
  settings?: SettingsSource;
}

export interface ShadowContext {
  db: Database;
  pageId: number;
  now: Date;
  page: SyncPageRow;
  settings?: SettingsSource;
}

export interface ApplyInput {
  pageId: number;
  /** The engine clock at the apply (stamps, presence buckets). */
  now: Date;
  /** The page's native Fansly account id (`pages.external_page_id`). */
  ownRef: string | null;
  work: SyncWorkRow;
  attempt: SyncAttemptRow;
  request: RequestPlan;
  /** The value the wire contract accepted. */
  parsed: unknown;
  /** The served answer (the envelope's `response`): in memory right after the
   *  capture, else read back from the journal. */
  response: unknown;
  observation: { id: number; receivedAt: Date };
  /** The erasure fence is held (resources with `fence: 'dm_archive'`). */
  fenced: boolean;
  /** The live settings (absent: the registry defaults). */
  settings?: SettingsSource;
}

export interface ApplyResult<C = unknown> {
  work: WorkOutcome<C>;
  followups: readonly DemandSignal[];
  /** A thread's chain moved: history requests re-check satisfaction (S2-11a). */
  threadChainChanged?: { threadId: number };
  /** Outcomes worth counting that are not work (a refused empty snapshot, a
   *  restarted walk, …): `sync_apply_effect{resource, effect}` after commit. */
  counters?: Readonly<Record<string, number>>;
  /** The account the page's credentials answered for (`/account/me`):
   *  `sync_pages.identity_account_id`, written by the engine right after the
   *  apply commits (the page row is the actor's, never a resource's). */
  pageIdentity?: { accountId: string };
}

export interface ShadowResult<C = unknown> {
  work: WorkOutcome<C>;
  /** Demand the live apply would have created: upserted as shadow work. */
  followups: readonly DemandSignal[];
  /** Effects that are not work (subject-queue writes, …), counted only. */
  counters?: Readonly<Record<string, number>>;
}

/** One journaled observation offered to a resource's replay (the shadow
 *  report, design §3.12 B5): the body as the journal holds it. */
export interface ReplayObservation {
  id: number;
  receivedAt: Date;
  kind: string;
  pageId: number;
  payload: unknown;
}

export interface ReplayContext {
  /** Read-only: a replay never writes. */
  db: Database;
  pageId: number;
}

/** What a replay concluded about one observation: the new wire contract and
 *  the resource's intended effects against what legacy stored. */
export type ReplayVerdict =
  | { kind: "match"; detail?: Readonly<Record<string, unknown>> }
  | { kind: "mismatch"; reason: string; detail?: Readonly<Record<string, unknown>> }
  | { kind: "not_replayable"; reason: string };

/** What the step-3 switch carries over from the legacy engine for one key
 *  (design §11.1 C): the cursor its live work row starts from. */
export interface LegacyImport {
  cursors: ReadonlyArray<{ resource: ResourceKey; subject: string; cursor: unknown }>;
  /** Where each imported value came from (the switch report). */
  notes: Readonly<Record<string, unknown>>;
}

export interface ResourceModule<C = unknown> {
  /** Read-only: what the next step of this work is. */
  plan(work: SyncWorkRow, ctx: PlanContext): Promise<StepPlan<C>>;
  /** Claims in the admission transaction (live only, never in shadow). */
  onAdmit?(tx: Database, work: SyncWorkRow, request: RequestPlan): Promise<void>;
  /** Live: apply the captured answer (tx 3). */
  apply(tx: Database, input: ApplyInput): Promise<ApplyResult<C>>;
  /** Shadow: estimate the outcome of the step without an answer. */
  shadow(work: SyncWorkRow, request: RequestPlan, ctx: ShadowContext): Promise<ShadowResult<C>>;
  /** The resource's own journal trim of the served answer (default: as served). */
  journal?(response: unknown): unknown;
  /** Read-only: one legacy observation of a kind this resource owns through
   *  the new contract and the resource's intended effects (design §3.12 B5). */
  replay?(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict>;
  /** One-time, at the step-3 switch of the page: the legacy state this key's
   *  live work starts from. */
  importLegacy?(tx: Database, page: { pageId: number }): Promise<LegacyImport>;
  /** A subject-queue walk's subject outcome (the breaker lives on the queue
   *  row). `request` names the subject(s) the failed step asked for; the
   *  breaker fields are the work row's ladder, which a queue walk replaces by
   *  its own queue row's (design §4.3). Runs in the capture transaction. */
  onSubjectOutcome?(
    tx: Database,
    work: SyncWorkRow,
    outcome: { kind: "failure" | "terminal" | "ok"; failureCount: number; breakerUntil: Date | null; blockedByVendorAt: Date | null },
    request: RequestPlan,
  ): Promise<void>;
}

export interface EngineRegistry {
  readonly specs: readonly EngineResourceSpec[];
  spec(key: ResourceKey): EngineResourceSpec | null;
  /** The module of `key`; an entry whose module is not implemented yet (or
   *  an unknown key) waits on `dependency` and counts `not_implemented`. */
  module(key: ResourceKey): Promise<ResourceModule>;
}

/** A plan that waits with no instant re-checks after this long. */
export const WAIT_RECHECK_MS = 60_000;
/** A module that is not implemented re-checks after this long. */
export const NOT_IMPLEMENTED_RECHECK_MS = 3_600_000;
/** Poll jitter: every period is ±10 % (design §4.4). */
export const POLL_JITTER = 0.1;

const KEY_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

export class NotImplementedResourceError extends Error {
  constructor(readonly resource: string, detail: string) {
    super(`Fansly sync resource ${resource} is not implemented: ${detail}`);
    this.name = "NotImplementedResourceError";
  }
}

/** The stand-in module of a registry entry (or an unknown key) whose code
 *  has not landed: it never asks for a request. */
export function notImplementedModule(key: ResourceKey, metrics: Metrics = noopMetrics): ResourceModule {
  return {
    async plan(_work, ctx) {
      metrics.increment("sync_not_implemented", { resource: key });
      return { kind: "wait", reason: "dependency", until: new Date(ctx.now.getTime() + NOT_IMPLEMENTED_RECHECK_MS) };
    },
    async apply() {
      throw new NotImplementedResourceError(key, "apply");
    },
    async shadow() {
      throw new NotImplementedResourceError(key, "shadow");
    },
  };
}

/** Build the engine's view of a registry table. Keys are unique and well
 *  formed; a module is loaded once. */
export function createEngineRegistry(
  specs: readonly EngineResourceSpec[],
  options: { metrics?: Metrics } = {},
): EngineRegistry {
  const metrics = options.metrics ?? noopMetrics;
  const byKey = new Map<string, EngineResourceSpec>();
  for (const spec of specs) {
    if (!KEY_PATTERN.test(spec.key)) throw new Error(`Not a sync resource key ('<file>.<variant>'): ${spec.key}`);
    if (byKey.has(spec.key)) throw new Error(`Duplicate sync resource key: ${spec.key}`);
    if (spec.kind === "poll" && (spec.period === undefined || !(spec.period.everyMs > 0))) {
      throw new Error(`Sync poll ${spec.key} needs a positive period`);
    }
    if (spec.standing !== undefined && (spec.kind !== "goal" || !(spec.standing.recheckMs > 0))) {
      throw new Error(`Sync standing walk ${spec.key} must be a goal with a positive re-check period`);
    }
    byKey.set(spec.key, spec);
  }
  const modules = new Map<string, Promise<ResourceModule>>();
  return {
    specs: [...byKey.values()],
    spec: (key) => byKey.get(key) ?? null,
    module(key) {
      let loaded = modules.get(key);
      if (loaded === undefined) {
        const spec = byKey.get(key);
        loaded = spec?.module === undefined ? Promise.resolve(notImplementedModule(key, metrics)) : spec.module();
        // A failed load is not cached: the next step tries again.
        loaded.catch(() => modules.delete(key));
        modules.set(key, loaded);
      }
      return loaded;
    },
  };
}

/** `sync_pages.registry_overrides[key]` as the engine reads it. */
export type RegistryOverride = { everyMs: number } | { enabled: false };

export function registryOverride(page: Pick<SyncPageRow, "registryOverrides">, key: ResourceKey): RegistryOverride | null {
  const raw = page.registryOverrides[key];
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.enabled === false) return { enabled: false };
  if (typeof record.everyMs === "number" && Number.isSafeInteger(record.everyMs) && record.everyMs > 0) {
    return { everyMs: record.everyMs };
  }
  return null;
}

/** A key the owner switched off for the page (`{enabled:false}`). */
export function resourceDisabled(page: Pick<SyncPageRow, "registryOverrides">, key: ResourceKey): boolean {
  const override = registryOverride(page, key);
  return override !== null && "enabled" in override;
}

/** `effectivePeriod` (design §4.2): the page's override, else the entry's. */
export function effectivePeriodMs(spec: EngineResourceSpec, page: Pick<SyncPageRow, "registryOverrides">): number | null {
  const override = registryOverride(page, spec.key);
  if (override !== null && "everyMs" in override) return override.everyMs;
  return spec.period?.everyMs ?? null;
}

/** Whether an entry runs on a page in this mode. */
export function runsIn(spec: EngineResourceSpec, shadow: boolean): boolean {
  return !(shadow && spec.liveOnly === true);
}

/** One standing row of a page: a poll, or a standing walk (`kind: 'goal'`). */
export interface StandingRow {
  resource: string;
  class: WorkClass;
  everyMs: number;
  kind?: "goal";
}

/** The standing rows a page should have (`ensurePollRows`): every enabled poll
 *  entry that runs in this mode, with its effective period, and every enabled
 *  standing walk with its re-check period. */
export function pollsFor(
  registry: EngineRegistry,
  page: Pick<SyncPageRow, "registryOverrides">,
  shadow: boolean,
): StandingRow[] {
  const polls: StandingRow[] = [];
  for (const spec of registry.specs) {
    if (!runsIn(spec, shadow) || resourceDisabled(page, spec.key)) continue;
    if (spec.kind === "poll") {
      const everyMs = effectivePeriodMs(spec, page);
      if (everyMs !== null) polls.push({ resource: spec.key, class: spec.class, everyMs });
    } else if (spec.kind === "goal" && spec.standing !== undefined) {
      polls.push({ resource: spec.key, class: spec.class, everyMs: spec.standing.recheckMs, kind: "goal" });
    }
  }
  return polls;
}

/** The next due time of a poll after a completed step: completion + period ×
 *  (0.9 … 1.1). Null when the entry has no period. */
export function nextPollDueAt(
  spec: EngineResourceSpec,
  page: Pick<SyncPageRow, "registryOverrides">,
  now: Date,
  random: number,
): Date | null {
  const everyMs = effectivePeriodMs(spec, page);
  if (everyMs === null) return null;
  const factor = 1 - POLL_JITTER + 2 * POLL_JITTER * Math.min(Math.max(random, 0), 1);
  return new Date(now.getTime() + Math.round(everyMs * factor));
}

/**
 * A demand signal as the work row it creates or bumps (`upsertDemand`): kind
 * and class from the entry, the coalescing window and the deadline from its
 * coalescing and SLO rules. Null when the entry does not run in this mode or
 * the owner switched it off for the page.
 */
export function demandToUpsert(
  signal: DemandSignal,
  spec: EngineResourceSpec,
  input: { pageId: number; shadow: boolean; now: Date; page?: Pick<SyncPageRow, "registryOverrides"> },
): UpsertDemandInput | null {
  if (!runsIn(spec, input.shadow)) return null;
  if (input.page !== undefined && resourceDisabled(input.page, spec.key)) return null;
  const at = input.now.getTime();
  const window = spec.coalesce === undefined
    ? null
    : signal.coalesce === "fast" && spec.coalesce.fast !== undefined
      ? spec.coalesce.fast
      : { quietMs: spec.coalesce.quietMs, maxMs: spec.coalesce.maxMs };
  const dueAt = signal.dueAt ?? (window === null ? input.now : new Date(at + window.quietMs));
  const deadlineMs = signal.deadlineMs ?? spec.slo?.resultMs;
  const upsert: UpsertDemandInput = {
    pageId: signal.pageId ?? input.pageId,
    shadow: input.shadow,
    resource: spec.key,
    subject: signal.subject ?? "",
    kind: spec.kind,
    class: spec.class,
    dueAt,
    coalesceUntil: window === null ? null : new Date(at + window.maxMs),
    deadlineAt: deadlineMs === undefined ? null : new Date(at + deadlineMs),
    extendOnSignal: spec.coalesce?.extendOnSignal === true,
  };
  if (signal.demand !== undefined) {
    upsert.demand = {
      messageIds: signal.demand.messageIds ?? [],
      txIds: signal.demand.txIds ?? [],
      reasons: [signal.demand.reason],
    };
  }
  if (signal.params !== undefined) upsert.params = signal.params;
  if (signal.ids !== undefined && signal.ids.length > 0) {
    upsert.mergeParamIds = { key: "ids", ids: signal.ids, cap: SYNC_WORK_PARAM_IDS_CAP };
  }
  return upsert;
}
