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

import type { OutcomeDecision } from "./errors.ts";
import { noopMetrics, type LivePageSocket, type Metrics, type SecretBox, type SettingsSource } from "./ports.ts";
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

/** One age tier of a subject-queue walk: items up to `maxAgeDays` old (null:
 *  every older item) are due again `everyMs` after a visit. */
export interface TierSpec { maxAgeDays: number | null; everyMs: number }

/** A goal re-evaluated on a cadence: an incremental look every `everyMs`, a
 *  full sweep every `fullEveryMs`. */
export interface CadenceSpec { everyMs: number; fullEveryMs?: number }

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
  /** False only for entries applied from the socket (no request). Such an
   *  entry's every step runs before the HTTP gate (`beforeGateKeys`). */
  http: boolean;
  /** Its plan may settle a step without a request — a closure, a wait — and
   *  decides so read-only and cheaply: the actor plans its due work before
   *  the page's HTTP gate (ruling 9, `stepBeforeGate`) and commits such a
   *  step there; a plan that asks for a request is left for its slot. */
  planBeforeGate?: true;
  /** Every wire route its steps may send: the route admission leaves the key
   *  out of a pick while all of them are closed (`engine/route-policy.ts`).
   *  Absent or empty (a probe whose route is the owner's, a write without a
   *  request): only the planned request's route is checked. */
  operations?: readonly FanslyWireId[];
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
  /** 401/403 answers that are about the subject, not the page's session
   *  (design G16, E8): closed with a receipt (`subject_terminal`) instead of
   *  holding the whole page `auth`. A CDN hop carries no session (its 401/403
   *  is the signed URL's); an excluded chat may be forbidden while the session
   *  is fine. Pinned per key by tests/sync-registry-coverage.test.ts. */
  subjectScopedAuthStatuses?: readonly (401 | 403)[];
  /** A walk over a `subject_refresh_state` plane: a subject failure breaks
   *  the queue subject, the walk row goes on (design §4.3). */
  subjectQueue?: boolean;
  /** Owner decision №6: a frequency change needs the owner (`--owner-approved`). */
  ownerProtected?: true;
  /** Goals re-evaluated on a cadence (a walk's due subjects, a daily
   *  incremental / weekly full sweep); polls use `period`. */
  cadence?: CadenceSpec;
  /** Subject-queue walks by age tier (owner decision №6 for media stats). */
  tiers?: readonly TierSpec[];
  /** What a page override may change besides a poll's period (design §4.2;
   *  owner decision №6: "changed per page by an override, without a
   *  deploy"): the `cadence` periods or the age `tiers`. Set only where the
   *  module reads them back through `effectiveCadence` / `effectiveTiers`, so
   *  an override the owner CLI accepts is never one the engine ignores. */
  pageOverride?: "cadence" | "tiers";
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
  /**
   * The resource's own account of the step: where in its walk this request
   * belongs, as the plan decided it (a media visit's windows, an album walk's
   * proof header). Never sent; stored with the attempt
   * (`sync_attempts.request.step`) and handed back with the request to the
   * apply, the shadow estimate and a journal re-apply, so a decision the
   * read-only plan took is the one the step folds its answer into.
   */
  step?: unknown;
  /**
   * A shadow step's place in its walk when its parameters cannot name it: a
   * window cut at the step's clock (a media visit's window, the fan earnings
   * roster's whole history up to now) names the subject and the step instead,
   * and a subject-queue walk names its shadow pass (each pass re-reads the
   * subjects an earlier one read: shadow records no visit). Never sent and
   * never read back by the resource; journaled with the attempt
   * (`sync_attempts.request.position`), where the shadow report's
   * endless-walk check (`report/shadow-routes.ts`) takes it for the request's
   * identity in place of its parameters.
   */
  position?: unknown;
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
  /** A write the page needs that makes no request (design §3.3 item 3, E6):
   *  the module's `applyLocal` runs in one generation-fenced transaction, under
   *  the erasure fence when the entry declares one. Live only. */
  | { kind: "local"; reason: string }
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
  /** The page's socket owner (live pages of a process that runs one; absent
   *  or null otherwise): what `ws.connect` plans by. */
  socket?: LivePageSocket | null;
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
  /** The page as the apply transaction reads it (its registry overrides). */
  page: SyncPageRow;
  /** The live settings (absent: the registry defaults). */
  settings?: SettingsSource;
}

/**
 * The answer of a route that journals nothing (`capture: 'none' | 'bytes'` —
 * the WebSocket Upgrade, a CDN hop), applied once, from memory, right after
 * its capture (`ResourceModule.applyAnswer`). There is no observation to
 * re-apply from: when this apply cannot run (a crash, a busy erasure fence, an
 * error) the attempt is skipped and the work is read again.
 */
export interface AnswerApplyInput {
  pageId: number;
  now: Date;
  ownRef: string | null;
  work: SyncWorkRow;
  attempt: SyncAttemptRow;
  request: RequestPlan;
  /** The value the route's contract accepted (the answer itself). */
  parsed: unknown;
  /** The erasure fence is held (resources with `fence: 'dm_archive'`). */
  fenced: boolean;
  page: SyncPageRow;
  /** The live owner generation (writes a module makes outside the work row,
   *  e.g. the work's next secret parameters, are fenced by it). */
  generation: bigint;
  /** The box of the work's secret parameters (null: none in this process). */
  secrets: SecretBox | null;
}

/** What the outcome hook knows of the step besides the decision. */
export interface OutcomeStep {
  request: RequestPlan;
  /** The answer's status, when one came back. */
  httpStatus: number | null;
  /** How the send ended (a response, or the wire failing). */
  outcome: "response" | "transport_error" | "timeout";
}

export interface ApplyResult<C = unknown> {
  work: WorkOutcome<C>;
  followups: readonly DemandSignal[];
  /** A thread's chain moved: history requests re-check satisfaction (S2-11a). */
  threadChainChanged?: { threadId: number };
  /** The apply canonicalized its own observation in this transaction (the DM
   *  apply: its erasure fence drops drafts the generic hook cannot know of,
   *  and the overlay confirmation must precede the appends): the commit's
   *  `canonicalize` hook does not run for it. */
  canonicalized?: true;
  /** Outcomes worth counting that are not work (a refused empty snapshot, a
   *  restarted walk, …): `sync_apply_effect{resource, effect}` after commit. */
  counters?: Readonly<Record<string, number>>;
  /** The account the page's credentials answered for (`/account/me`):
   *  `sync_pages.identity_account_id`, written by the engine right after the
   *  apply commits (the page row is the actor's, never a resource's). */
  pageIdentity?: { accountId: string };
}

/** What a `local` step's write sees (`ResourceModule.applyLocal`). */
export interface LocalApplyInput {
  pageId: number;
  /** The work as the slot picked it. */
  work: SyncWorkRow;
  /** The engine clock at the step. */
  now: Date;
  /** The page's native Fansly account id (`pages.external_page_id`). */
  ownRef: string | null;
}

/** A standing walk's look re-run (`ResourceModule.dueAtLook`): how many
 *  subjects were due at the look and untouched since, a few of them, and how
 *  many subjects its queue holds at all (null: the check did not pick, e.g.
 *  a pass that has ended or a visit in flight). */
export interface LookCheck {
  count: number;
  examples: string[];
  queued: number | null;
}

/** A queue walk's queue at an instant (`ResourceModule.queueNextDueAt`). */
export type QueueNextDue = { nextDueAt: Date | null } | { unjudgeable: string };

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
 *  the resource's intended effects against what legacy stored. A match that
 *  needed a named, checked legacy rule to hold (an older key scheme legacy
 *  stored the same fact under, rows legacy never stored) names each rule in
 *  `via`; the shadow report counts the observations of every rule, so no
 *  such allowance is silent. */
export type ReplayVerdict =
  | { kind: "match"; detail?: Readonly<Record<string, unknown>>; via?: readonly string[] }
  | { kind: "mismatch"; reason: string; detail?: Readonly<Record<string, unknown>> }
  | { kind: "not_replayable"; reason: string };

/** What the step-3 switch carries over from the legacy engine for one key
 *  (design §11.1 C): the cursor its live work row starts from, and — for a key
 *  whose continuity hangs on when legacy last read (the hourly stats' 25-hour
 *  window, A15) — when that row is first due. The switch's import writes
 *  both; without `dueAt` the row keeps its own schedule (a poll's random
 *  phase). A `dueAt` in the past means at once. */
export interface LegacyImport {
  cursors: ReadonlyArray<{ resource: ResourceKey; subject: string; cursor: unknown; dueAt?: Date }>;
  /** Demand the legacy state leaves open (a head debt's catch-up read),
   *  raised through the registry like any follow-up. */
  demands?: readonly DemandSignal[];
  /** Subject breakers the legacy engine had armed (a quarantined chat),
   *  merged monotonically into the key's open work, else into a closed row of
   *  the key that its next demand inherits (`importWorkBreaker`). */
  breakers?: ReadonlyArray<{
    resource: ResourceKey;
    subject: string;
    failureCount: number;
    breakerUntil: Date | null;
    lastErrorClass: string | null;
  }>;
  /** Where each imported value came from (the switch report). */
  notes: Readonly<Record<string, unknown>>;
}

/** What `importLegacy` knows of the switch. */
export interface LegacyImportPage {
  pageId: number;
  /** When the current switch began (its first audit row): legacy failures
   *  after it are the switch's own fences, not the vendor's. Absent: none. */
  switchStartedAt?: Date | null;
}

export interface ResourceModule<C = unknown> {
  /** Read-only: what the next step of this work is. */
  plan(work: SyncWorkRow, ctx: PlanContext): Promise<StepPlan<C>>;
  /** Claims in the admission transaction (live only, never in shadow). */
  onAdmit?(tx: Database, work: SyncWorkRow, request: RequestPlan): Promise<void>;
  /** Live: apply the captured answer (tx 3). */
  apply(tx: Database, input: ApplyInput): Promise<ApplyResult<C>>;
  /** Live, a route that journals nothing (`capture`): apply its in-memory
   *  answer (tx 3). Required for such routes; `apply` is never called for them. */
  applyAnswer?(tx: Database, input: AnswerApplyInput): Promise<ApplyResult<C>>;
  /** Live: the write of a `local` plan, in the commit's fenced transaction
   *  (after the page lock and the erasure fence, before the work row). */
  applyLocal?(tx: Database, input: LocalApplyInput): Promise<ApplyResult<C>>;
  /** The module's word on an outcome's consequences (`errors.onOutcome`), in
   *  the capture transaction: a failed WebSocket handshake goes to the
   *  socket's reconnect ladder instead of the page's network streak; a CDN
   *  hop's final answer closes its download with the describer's failure.
   *  Pure. */
  outcome?(decision: OutcomeDecision, step: OutcomeStep): OutcomeDecision;
  /** Shadow: estimate the outcome of the step without an answer. */
  shadow(work: SyncWorkRow, request: RequestPlan, ctx: ShadowContext): Promise<ShadowResult<C>>;
  /** Read-only (the shadow report, rule A1.rate-assumed): the steps a shadow
   *  run of this key would take if it started at `ctx.now` from the work
   *  row's cursor — the estimate its `shadow()` fixes at a run's start, by
   *  the same helper. A multi-step key on a period longer than the report
   *  window implements it (pinned by tests/sync-registry-coverage.test.ts). */
  estimateRunSteps?(work: Pick<SyncWorkRow, "cursor">, ctx: ShadowContext): Promise<number>;
  /** Read-only, a standing walk (the shadow report, rule A1.floor-idle): the
   *  subjects its own shadow pick finds due at `ctx.now` from the work row's
   *  cursor, among those no writer has changed since — what a look at that
   *  instant that found nothing due should have read. */
  dueAtLook?(work: Pick<SyncWorkRow, "cursor">, ctx: ShadowContext): Promise<LookCheck>;
  /** Read-only, a subject-queue walk without a standing row (the shadow
   *  report, rule A1.floor-queue): the earliest instant from which the
   *  shadow's driver asks for a walk of the page's queue as it stood at
   *  `ctx.now` (in the past: a subject is due already; null: no subject comes
   *  due without a new write) — or why the queue at that instant cannot be
   *  told from the rows as they stand now (a writer changed them since). */
  queueNextDueAt?(ctx: ShadowContext): Promise<QueueNextDue>;
  /** The resource's own journal trim of the served answer (default: as served). */
  journal?(response: unknown): unknown;
  /** Read-only: one legacy observation of a kind this resource owns through
   *  the new contract and the resource's intended effects (design §3.12 B5). */
  replay?(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict>;
  /** One-time, at the step-3 switch of the page: the legacy state this key's
   *  live work starts from. */
  importLegacy?(tx: Database, page: LegacyImportPage): Promise<LegacyImport>;
  /** A subject-queue walk's subject outcome (the breaker lives on the queue
   *  row). `step.request` names the subject(s) the failed step asked for (the
   *  walk row's own subject is the page's); the breaker fields are the work
   *  row's ladder, which a queue walk replaces by its own queue row's (design
   *  §4.3). Runs in the capture transaction. */
  onSubjectOutcome?(
    tx: Database,
    work: SyncWorkRow,
    outcome: { kind: "failure" | "terminal" | "ok"; failureCount: number; breakerUntil: Date | null; blockedByVendorAt: Date | null },
    step: { request: RequestPlan; attemptId: number },
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

/** `sync_pages.registry_overrides[key]` as the engine reads it (the shapes
 *  `setRegistryOverride` stores): a poll's period, a cadence goal's
 *  incremental (`everyMs`) and full (`fullEveryMs`) periods, a tiered walk's
 *  age tiers, or the key switched off. */
export type RegistryOverride =
  | { everyMs?: number; fullEveryMs?: number }
  | { tiers: ReadonlyArray<{ maxAgeDays: number | null; everyMs: number }> }
  | { enabled: false };

function positiveMs(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The page's override of `key`, or null. A stored value of no known shape
 *  (or with a bad number) is not an override: the registry's value stands. */
export function registryOverride(page: Pick<SyncPageRow, "registryOverrides">, key: ResourceKey): RegistryOverride | null {
  const raw = page.registryOverrides[key];
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.enabled === false) return { enabled: false };
  if (Array.isArray(record.tiers)) {
    const tiers = record.tiers.map((entry: unknown) => {
      const tier = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : {};
      const everyMs = positiveMs(tier.everyMs);
      const maxAgeDays = tier.maxAgeDays === null ? null : positiveMs(tier.maxAgeDays);
      return everyMs === null || (maxAgeDays === null && tier.maxAgeDays !== null) ? null : { maxAgeDays, everyMs };
    });
    if (tiers.length === 0 || tiers.some((tier) => tier === null)) return null;
    return { tiers: tiers as Array<{ maxAgeDays: number | null; everyMs: number }> };
  }
  const everyMs = positiveMs(record.everyMs);
  const fullEveryMs = positiveMs(record.fullEveryMs);
  if ((record.everyMs !== undefined && everyMs === null) || (record.fullEveryMs !== undefined && fullEveryMs === null)) return null;
  if (everyMs === null && fullEveryMs === null) return null;
  return { ...(everyMs === null ? {} : { everyMs }), ...(fullEveryMs === null ? {} : { fullEveryMs }) };
}

/** A key the owner switched off for the page (`{enabled:false}`). */
export function resourceDisabled(page: Pick<SyncPageRow, "registryOverrides">, key: ResourceKey): boolean {
  const override = registryOverride(page, key);
  return override !== null && "enabled" in override;
}

/** Why `override` cannot be `spec`'s page override (null: it can). A poll
 *  takes its period; an entry with `pageOverride` its cadence periods or its
 *  tiers; any entry can be switched off. */
export function registryOverrideProblem(spec: EngineResourceSpec, override: RegistryOverride): string | null {
  if ("enabled" in override) return null;
  if ("tiers" in override) {
    if (spec.pageOverride !== "tiers" || spec.tiers === undefined) return "it has no age tiers a page can change";
    return tierOverrideProblem(spec.tiers, override.tiers);
  }
  if (spec.kind === "poll") {
    if (override.fullEveryMs !== undefined) return "a poll has no full sweep: its override is its period";
    return override.everyMs === undefined ? "a poll's override is its period" : null;
  }
  if (spec.pageOverride === "cadence" && spec.cadence !== undefined) {
    if (override.fullEveryMs !== undefined && spec.cadence.fullEveryMs === undefined) return "it has no full sweep";
    return null;
  }
  return "it is not a poll: it has no period";
}

/** Why `tiers` cannot replace an entry's `base` tiers (null: they can): as
 *  many tiers, ages rising, the last one open-ended, every period positive. */
export function tierOverrideProblem(base: readonly TierSpec[], tiers: readonly TierSpec[]): string | null {
  if (tiers.length !== base.length) return `${base.length} tiers expected, received ${tiers.length}`;
  let previous = 0;
  for (const [index, tier] of tiers.entries()) {
    if (!Number.isSafeInteger(tier.everyMs) || tier.everyMs <= 0) return `tier ${index + 1}: everyMs must be a positive integer`;
    if (index === tiers.length - 1) {
      if (tier.maxAgeDays !== null) return "the last tier takes every older item: its maxAgeDays is null";
    } else if (tier.maxAgeDays === null || !Number.isSafeInteger(tier.maxAgeDays) || tier.maxAgeDays <= previous) {
      return `tier ${index + 1}: maxAgeDays must be an integer above ${previous}`;
    } else {
      previous = tier.maxAgeDays;
    }
  }
  return null;
}

/** A tiered walk's age tiers on a page: the page's override (owner decision
 *  №6), else the entry's. An override that does not fit the entry's tiers is
 *  not one. Null for an entry without tiers. */
export function effectiveTiers(spec: EngineResourceSpec, page: Pick<SyncPageRow, "registryOverrides">): readonly TierSpec[] | null {
  if (spec.tiers === undefined) return null;
  const override = spec.pageOverride === "tiers" ? registryOverride(page, spec.key) : null;
  if (override !== null && "tiers" in override && tierOverrideProblem(spec.tiers, override.tiers) === null) return override.tiers;
  return spec.tiers;
}

/** A cadence goal's periods on a page: each one the page overrides (owner
 *  decision №6), else the entry's. Null for an entry without a cadence. */
export function effectiveCadence(spec: EngineResourceSpec, page: Pick<SyncPageRow, "registryOverrides">): CadenceSpec | null {
  if (spec.cadence === undefined) return null;
  const override = spec.pageOverride === "cadence" ? registryOverride(page, spec.key) : null;
  if (override === null || "enabled" in override || "tiers" in override) return spec.cadence;
  const fullEveryMs = spec.cadence.fullEveryMs === undefined ? undefined : override.fullEveryMs ?? spec.cadence.fullEveryMs;
  return { everyMs: override.everyMs ?? spec.cadence.everyMs, ...(fullEveryMs === undefined ? {} : { fullEveryMs }) };
}

/** `effectivePeriod` (design §4.2): the page's override, else the entry's. */
export function effectivePeriodMs(spec: EngineResourceSpec, page: Pick<SyncPageRow, "registryOverrides">): number | null {
  const override = registryOverride(page, spec.key);
  if (spec.period === undefined) return null;
  if (override !== null && "everyMs" in override && override.everyMs !== undefined) return override.everyMs;
  return spec.period.everyMs;
}

/** Whether an entry runs on a page in this mode. */
export function runsIn(spec: EngineResourceSpec, shadow: boolean): boolean {
  return !(shadow && spec.liveOnly === true);
}

/** Whether the actor plans an entry's due work before the HTTP gate (ruling
 *  9): an entry without HTTP always, any other only when it says so. */
export function plansBeforeGate(spec: EngineResourceSpec): boolean {
  return !spec.http || spec.planBeforeGate === true;
}

/**
 * The keys whose due work the actor plans before the page's HTTP gate, in
 * the order it plans them: the entries without HTTP first (every step of
 * theirs is one the gate never needed to stop), then those that plan before
 * the gate by choice. Keys that do not run in this mode, that the owner
 * switched off for the page or paused are left out, as a pick leaves them out.
 */
export function beforeGateKeys(
  registry: EngineRegistry,
  page: Pick<SyncPageRow, "pausedResources" | "registryOverrides">,
  shadow: boolean,
): string[] {
  const specs = registry.specs.filter((spec) =>
    plansBeforeGate(spec) && runsIn(spec, shadow) && !resourceDisabled(page, spec.key) && !page.pausedResources.includes(spec.key));
  return [...specs.filter((spec) => !spec.http), ...specs.filter((spec) => spec.http)].map((spec) => spec.key);
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
