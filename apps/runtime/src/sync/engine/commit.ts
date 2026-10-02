import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  capturePayloadRefFromColumns,
  captureAttempt,
  clearPageHold,
  countRecentFailedSubjects,
  getSyncPage,
  getSyncWork,
  insertAdmission,
  insertObservation,
  lastRateLimitAt,
  listUnfinishedAttempts,
  lockAttemptForApply,
  lockOwnedPage,
  markApplied,
  markAttemptQuarantined,
  markAttemptSent,
  markDeferred,
  markWorkRunning,
  OwnershipLostError,
  PlatformAccountIdentityConflictError,
  PlatformAccountIdentityImmutableError,
  quarantineWork,
  recordApplyFailure,
  recordSyncPageIdentity,
  recoverUnfinishedAttempts,
  setNetworkFailureStreak,
  setPageHold,
  setResourceHold,
  settleAttemptWithoutCapture,
  settleWork,
  tryAcquireDmArchiveWriterFenceLock,
  upsertDemands,
  type Database,
  type RecoverUnfinishedAttemptsResult,
  type SyncAttemptRow,
  type SyncPageRow,
  type SyncWorkRow,
  type UpsertDemandInput,
} from "@agency_hub_core/db";
import {
  buildFanslyWireTarget,
  fanslyWireSpec,
  type FanslyWireId,
  type FanslyWireOutcome,
  type FanslyWireRead,
} from "@agency_hub_core/fansly";

import { isCapturePayloadUnavailable, resolveCapturePayloadRow } from "../../services/payload-reader.ts";
import { fanslyCdnTokenStripApplies, stripFanslySignedCdnTokens } from "../../services/sync/fansly-cdn-tokens.ts";
import { replaceJournalLoneSurrogates } from "../../services/sync/journal-lone-surrogates.ts";
import { WrongTransactionsWriterError } from "../../services/transactions-writer-gate.ts";
import {
  classifyWireOutcome,
  escalateResourceHold,
  onOutcome,
  RATE_LIMIT_LADDER_RESET_MS,
  RESOURCE_BREAKER_WINDOW_MS,
  RESOURCE_HOLD_EXEMPT_KEYS,
  resourceFileOf,
  type AlertDecision,
  type OutcomeDecision,
  type PageErrorState,
  type ResourceHoldEntry,
} from "./errors.ts";
import { FLOOR_LOOKBACK_MS, type Admission, type SlotGrant } from "./pacer.ts";
import type { AlertSink, Clock, Metrics, Rng } from "./ports.ts";
import {
  demandToUpsert,
  nextPollDueAt,
  WAIT_RECHECK_MS,
  type DemandSignal,
  type EngineRegistry,
  type EngineResourceSpec,
  type RequestPlan,
  type ResourceModule,
  type ShadowResult,
  type StepPlan,
  type WorkOutcome,
} from "./resource.ts";
import type { WorkClass } from "./scheduler.ts";

// The transactions of one step (plan §8, design §3.7). Each runs as ONE short
// transaction that starts with the generation fence (`lockOwnedPage`, I7):
//
//   admit   (tx 1)  the work becomes `running`, the attempt is journaled and
//                   counted BEFORE anything is sent; for a live page also the
//                   live gate (I17);
//   capture (tx 2)  live: the raw answer is committed to `observations` before
//                   anything parses it (I8), with the outcome and every error
//                   consequence (`errors.onOutcome`);
//   apply   (tx 3)  live: erasure fence → the resource's writes → the work's
//                   cursor/proof and `applied_revision` (I11) → follow-ups →
//                   `applied`. A failing apply is classified, never thrown out
//                   of the actor;
//   shadow  (tx 2') shadow: the simulated outcome, the work's estimated
//                   progress and shadow follow-ups — nothing else (I14).
//
// Lock order (design §3.7): sync_pages → erasure fence → hot tables →
// domain_event_seq → sync_work → history_requests → history_request_items.

/** Where a test may crash the actor (design §10, `sync-commit-crash`). */
export type SyncFaultPoint = "after_admit" | "after_send" | "after_capture" | "in_apply" | "after_apply";
export type SyncFaultHook = (point: SyncFaultPoint) => void | Promise<void>;

/** Thrown by a test's fault hook to stand for the death of the process at
 *  that point: never classified, never caught — the actor's run rejects with
 *  it and whatever transaction was open rolls back. */
export class SyncCrashFault extends Error {
  constructor(readonly point: SyncFaultPoint) {
    super(`simulated crash at ${point}`);
    this.name = "SyncCrashFault";
  }
}

/** A typed reason to retry an apply later without counting it (§3.7.3). */
export class ApplyDeferred extends Error {
  constructor(readonly reason: string) {
    super(`apply deferred: ${reason}`);
    this.name = "ApplyDeferred";
  }
}

/** A resource refuses to apply an answer it cannot vouch for (an empty first
 *  page against known members, unmapped rows, a deactivation past its safety
 *  ceiling): deterministic — the step's writes roll back, the work and the
 *  attempt are quarantined with the raw answer kept, alert 2. Never retried
 *  on its own; the owner re-applies or overrides it. */
export class ApplyQuarantine extends Error {
  constructor(readonly reason: string, readonly detail: Readonly<Record<string, unknown>> = {}) {
    super(`apply quarantined: ${reason}`);
    this.name = "ApplyQuarantine";
  }
}

/** A journaled answer the wire contract refuses (on re-parse from the journal,
 *  or by a resource's own deeper check): deterministic, quarantined. */
export class FanslyContractViolationError extends Error {
  constructor(readonly field: string, readonly detail: string) {
    super(`Fansly answer violates its contract at ${field}: ${detail}`);
    this.name = "FanslyContractViolationError";
  }
}

export interface SyncLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** The journal body of a 2xx answer (`observations.payload`). */
export interface CaptureCodec {
  prepare(input: {
    spec: FanslyWireId;
    kind: string;
    response: unknown;
    /** The wire contract accepted `response` (false: journaled, then quarantined). */
    contractAccepted: boolean;
    /** The request the answer serves (a walk's position, for kinds whose
     *  journal names it). */
    request: RequestPlan;
    module: ResourceModule;
  }): unknown;
}

/**
 * The engine's journal transform: the resource's own trim, then the signed CDN
 * tokens stripped for the kinds the legacy journal strips them for, then every
 * unpaired UTF-16 surrogate replaced (json/jsonb refuse one). The served object
 * is never mutated.
 */
export const defaultCaptureCodec: CaptureCodec = {
  prepare({ kind, response, module }) {
    let body = module.journal === undefined ? response : module.journal(response);
    if (fanslyCdnTokenStripApplies("fansly", kind)) body = stripFanslySignedCdnTokens(body);
    return replaceJournalLoneSurrogates(body).value;
  },
};

/** Inline canonicalization of the captured observation inside tx 3 (the
 *  capture seam). Without one, the minutely canonicalization sweep picks the
 *  observation up as it does for every journaled fact. */
export type ObservationCanonicalizer = (
  tx: Database,
  input: { pageId: number; ownRef: string | null; observationId: number; receivedAt: Date },
) => Promise<void>;

/** The history-request hook of tx 3 (`history_*` last in the lock order). */
export type ThreadChainChangedHook = (tx: Database, input: { pageId: number; threadId: number }) => Promise<void>;

export interface CommitDeps {
  db: Database;
  pageId: number;
  /** `pages.external_page_id`: the observations' native account ref. */
  ownRef: string | null;
  generation: bigint;
  mode: "shadow" | "live";
  registry: EngineRegistry;
  clock: Clock;
  rng: Rng;
  alerts: AlertSink;
  metrics: Metrics;
  logger: SyncLogger;
  capture?: CaptureCodec;
  canonicalize?: ObservationCanonicalizer;
  onThreadChainChanged?: ThreadChainChangedHook;
  faults?: SyncFaultHook;
}

/** The work a slot picked. */
export interface PickedWork {
  work: SyncWorkRow;
  workClass: WorkClass;
  slot: number;
  nextCyclePos: number;
}

export interface AdmissionRecord {
  attemptId: number;
  admittedAt: Date;
  /** The work's demand revision at admission (I11). */
  demandRevision: number;
  work: SyncWorkRow;
  workClass: WorkClass;
  spec: EngineResourceSpec;
  request: RequestPlan;
}

const MAX_FAILED_BODY_CHARS = 64 * 1024;
/** Deferred-apply ladder by the age of the answer (design §3.7.3). */
const DEFERRED_RETRY_LADDER: ReadonlyArray<{ ageBelowMs: number; retryInMs: number }> = [
  { ageBelowMs: 5_000, retryInMs: 1_000 },
  { ageBelowMs: 30_000, retryInMs: 5_000 },
  { ageBelowMs: 300_000, retryInMs: 30_000 },
];
const DEFERRED_RETRY_CAP_MS = 60_000;
/** A journaled body unreadable for longer than this is quarantined. */
export const PAYLOAD_UNAVAILABLE_QUARANTINE_MS = 600_000;
/** How far back the capture looks for the page's newest 429 (by admission):
 *  the [A8] decay hour plus FLOOR_LOOKBACK_MS, which is far longer than an
 *  admission → completion span (send window + request timeout) and covers
 *  app/DB clock skew. An older 429 has already reset the ladder. */
export const RATE_LIMIT_LOOKBACK_MS = RATE_LIMIT_LADDER_RESET_MS + FLOOR_LOOKBACK_MS;

function inTx<T>(db: Database, body: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => body(tx as unknown as Database));
}

async function fault(d: CommitDeps, point: SyncFaultPoint): Promise<void> {
  if (d.faults !== undefined) await d.faults(point);
}

/** `sync_attempts.request`: the wire id, its parameters (the coverage
 *  evidence, design §2.9 D1) and the request line. Never a header. */
export function requestJsonOf(request: RequestPlan): { spec: FanslyWireId; params: unknown; path: string; query: Record<string, string> } {
  const target = buildFanslyWireTarget(request.spec, request.params as never);
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(target.search)) query[key] = value;
  return { spec: request.spec, params: request.params, path: target.pathname, query };
}

function requestOfAttempt(attempt: SyncAttemptRow): RequestPlan {
  const stored = attempt.request as { spec?: unknown; params?: unknown } | null;
  const spec = typeof stored?.spec === "string" ? stored.spec : attempt.operation;
  return { spec: spec as FanslyWireId, params: (stored?.params ?? {}) as never };
}

function upsertsOf(
  d: CommitDeps,
  signals: readonly DemandSignal[],
  page: Pick<SyncPageRow, "registryOverrides"> | null,
  now: Date,
): UpsertDemandInput[] {
  const upserts: UpsertDemandInput[] = [];
  for (const signal of signals) {
    const spec = d.registry.spec(signal.resource);
    if (spec === null) {
      d.metrics.increment("sync_followup_unknown_resource", { resource: signal.resource });
      continue;
    }
    const upsert = demandToUpsert(signal, spec, {
      pageId: d.pageId,
      shadow: d.mode === "shadow",
      now,
      ...(page === null ? {} : { page }),
    });
    if (upsert !== null) upserts.push(upsert);
  }
  return upserts;
}

/** A work outcome as `settleWork` input; a poll that stays open is due again
 *  after its period unless the step said otherwise. */
function settleInputOf(
  d: CommitDeps,
  work: SyncWorkRow,
  spec: EngineResourceSpec | null,
  outcome: WorkOutcome,
  servedRevision: number,
  page: Pick<SyncPageRow, "registryOverrides"> | null,
  now: Date,
) {
  let nextDueAt = outcome.nextDueAt ?? null;
  let close = outcome.close ?? null;
  if (spec !== null && spec.kind === "poll") {
    // A poll is the page's standing row: "done" means "done this round".
    if (close === "done") close = null;
    if (close === null && nextDueAt === null && page !== null) {
      nextDueAt = nextPollDueAt(spec, page, now, d.rng.next());
    }
  }
  return {
    workId: work.id,
    generation: d.generation,
    servedRevision,
    satisfiesRevision: outcome.satisfiesRevision,
    ...(close === null ? {} : { close }),
    closeReason: outcome.closeReason ?? null,
    nextDueAt,
    waitingReason: outcome.waitingReason ?? null,
    ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
    ...(outcome.proof === undefined ? {} : { proof: outcome.proof }),
    ...(outcome.result === undefined ? {} : { result: outcome.result }),
  };
}

// ── tx 1: admission ─────────────────────────────────────────────────────────

/**
 * Admit one request (tx 1). Null when the work is no longer open (another
 * step took it): nothing was written and the slot is not consumed. Throws
 * `OwnershipLostError` for a foreign generation and `LiveGateClosedError` for
 * a live admission without its gates (I17).
 */
export async function admit(
  d: CommitDeps,
  picked: PickedWork,
  request: RequestPlan,
  grant: SlotGrant,
  module: ResourceModule,
): Promise<AdmissionRecord | null> {
  const spec = d.registry.spec(picked.work.resource);
  if (spec === null) throw new Error(`No registry entry for ${picked.work.resource}`);
  return inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, {
      pageId: d.pageId,
      generation: d.generation,
      lock: "no_key_update",
      live: d.mode === "live",
    });
    const running = await markWorkRunning(tx, { workId: picked.work.id, generation: d.generation });
    if (running === null) return null;
    const admitted = await insertAdmission(tx, {
      pageId: d.pageId,
      shadow: d.mode === "shadow",
      workId: picked.work.id,
      resource: picked.work.resource,
      subject: picked.work.subject,
      class: picked.workClass,
      slot: picked.slot,
      nextCyclePos: picked.nextCyclePos,
      generation: d.generation,
      demandRevision: running.demandRevision,
      settingMs: grant.settingMs,
      jitterU: grant.jitterU,
      pauseMs: grant.pauseMs,
      operation: request.spec,
      request: requestJsonOf(request),
      evidence: spec.evidence,
    });
    // Claims are live-only: a shadow step never touches another table.
    if (d.mode === "live" && module.onAdmit !== undefined) await module.onAdmit(tx, picked.work, request);
    return {
      attemptId: admitted.attemptId,
      admittedAt: admitted.admittedAt,
      demandRevision: running.demandRevision,
      work: picked.work,
      workClass: picked.workClass,
      spec,
      request,
    };
  });
}

/** Best effort right after `onRequestStart` (never awaited by the send): the
 *  send instant, so a takeover after a crash sees it. Live only. */
export function markSentBestEffort(d: CommitDeps, attemptId: number, sentAt: Date): void {
  markAttemptSent(d.db, { attemptId, sentAt }).catch((error: unknown) => {
    d.logger.debug({ attemptId, err: errorName(error) }, "Fansly sync: best-effort send mark failed");
  });
}

// ── a refusal before sending ────────────────────────────────────────────────

/** The send check refused the dispatch (or it was cancelled before it):
 *  nothing reached Fansly. The attempt is closed, the work is open again. */
export async function settleNotSent(
  d: CommitDeps,
  admission: AdmissionRecord,
  outcome: Extract<FanslyWireOutcome, { kind: "aborted_before_send" }>,
): Promise<void> {
  const refusal = outcome.refusal;
  d.metrics.increment("sync_send_refused", { reason: refusal, shadow: d.mode === "shadow" });
  await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    await settleAttemptWithoutCapture(tx, {
      attemptId: admission.attemptId,
      outcome: "aborted_before_send",
      errorClass: `not_sent:${refusal}`,
    });
    await settleWork(tx, {
      workId: admission.work.id,
      generation: d.generation,
      servedRevision: admission.demandRevision,
      satisfiesRevision: false,
      nextDueAt: null,
      waitingReason: null,
      lastErrorClass: "not_sent",
    });
  });
}

// ── tx 2': shadow ───────────────────────────────────────────────────────────

/**
 * Settle a shadow step: the attempt as `shadow` with its simulated send
 * instant, the work's estimated progress, shadow follow-ups. The page's live
 * send facts (`last_send_at`, `last_completed_at`) are never written: they are
 * the takeover truth of live owners. A pace self-check violation in shadow is
 * a pacer bug: metric and log, never a page.
 */
export async function settleShadow(
  d: CommitDeps,
  admission: AdmissionRecord,
  armed: Admission,
  simulatedLatencyMs: number,
  result: ShadowResult,
): Promise<void> {
  const now = d.clock.wallNow();
  const page = await getSyncPage(d.db, d.pageId);
  await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    await settleAttemptWithoutCapture(tx, {
      attemptId: admission.attemptId,
      outcome: "shadow",
      sentAt: armed.sentWall,
      sendMonoOffsetMs: armed.sentMono === null ? null : armed.sentMono - armed.issuedMono,
      gapPrevMs: armed.gapPrevMs,
      durationMs: simulatedLatencyMs,
    });
    await settleWork(tx, settleInputOf(d, admission.work, admission.spec, result.work, admission.demandRevision, page, now));
    const upserts = upsertsOf(d, result.followups, page, now);
    if (upserts.length > 0) await upsertDemands(tx, upserts);
  });
  for (const [name, by] of Object.entries(result.counters ?? {})) {
    d.metrics.increment("sync_shadow_effect", { resource: admission.work.resource, effect: name }, by);
  }
  if (armed.gapPrevMs !== null && armed.gapPrevMs < armed.settingMs) {
    d.metrics.increment("sync_shadow_pace_violations", { pageId: d.pageId });
    d.logger.error(
      { pageId: d.pageId, attemptId: admission.attemptId, gapMs: armed.gapPrevMs, settingMs: armed.settingMs },
      "Fansly sync shadow: two simulated sends closer than the setting (pacer bug)",
    );
  }
}

// ── no-HTTP outcomes ────────────────────────────────────────────────────────

/** A plan that needs no request: done, wait, quarantine (design §3.5). The
 *  slot is not consumed. */
export async function commitNoHttp(
  d: CommitDeps,
  work: SyncWorkRow,
  plan: Exclude<StepPlan, { kind: "request" }>,
): Promise<void> {
  const now = d.clock.wallNow();
  const spec = d.registry.spec(work.resource);
  const page = await getSyncPage(d.db, d.pageId);
  await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    switch (plan.kind) {
      case "done":
        await settleWork(tx, settleInputOf(d, work, spec, {
          close: "done",
          closeReason: plan.reason,
          satisfiesRevision: true,
          ...(plan.cursor === undefined ? {} : { cursor: plan.cursor }),
          ...(plan.proof === undefined ? {} : { proof: plan.proof }),
          ...(plan.result === undefined ? {} : { result: plan.result }),
        }, work.demandRevision, page, now));
        return;
      case "wait": {
        const until = plan.until ?? new Date(now.getTime() + WAIT_RECHECK_MS);
        await settleWork(tx, {
          workId: work.id,
          generation: d.generation,
          servedRevision: work.demandRevision,
          satisfiesRevision: false,
          nextDueAt: until,
          waitingReason: plan.reason,
          waitingUntil: until,
        });
        const upserts = upsertsOf(d, plan.enqueue ?? [], page, now);
        if (upserts.length > 0) await upsertDemands(tx, upserts);
        return;
      }
      case "quarantine":
        await quarantineWork(tx, { workId: work.id, generation: d.generation, errorClass: `plan:${plan.reason}` });
        return;
    }
  });
  if (plan.kind === "quarantine") {
    await openAlerts(d, [{ subKey: "live_degraded", detail: "quarantined" }], { resource: work.resource });
  }
}

/** A plan threw: the work waits a minute (an unexpected error of a module
 *  never stops the page). */
export async function deferAfterPlanError(d: CommitDeps, work: SyncWorkRow, error: unknown): Promise<void> {
  d.metrics.increment("sync_plan_errors", { resource: work.resource });
  d.logger.error({ pageId: d.pageId, workId: work.id, resource: work.resource, err: errorName(error) },
    "Fansly sync: a resource's plan failed; the work waits");
  const until = new Date(d.clock.wallNow().getTime() + WAIT_RECHECK_MS);
  await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    await settleWork(tx, {
      workId: work.id,
      generation: d.generation,
      servedRevision: work.demandRevision,
      satisfiesRevision: false,
      nextDueAt: until,
      waitingReason: "dependency",
      waitingUntil: until,
      lastErrorClass: `plan:${errorName(error)}`,
    });
  });
}

// ── tx 2: capture (live) ────────────────────────────────────────────────────

export interface CaptureResult {
  /** A 2xx-ok answer was captured: apply it now (tx 3). */
  applyNow: boolean;
  /** The served answer and the contract's value, for the apply right after. */
  inMemory: { response: unknown; parsed: unknown } | null;
}

function pageErrorState(page: SyncPageRow): PageErrorState {
  return {
    holdKind: page.holdKind,
    holdUntil: page.holdUntil,
    holdSince: page.holdSince,
    holdStep: page.holdStep,
    holdDetail: page.holdDetail,
    networkFailureStreak: page.networkFailureStreak,
    resourceHolds: page.resourceHolds as Record<string, ResourceHoldEntry>,
    credentialsGeneration: page.credentialsGeneration,
  };
}

function failedBody(outcome: Extract<FanslyWireOutcome, { kind: "response" }>): Record<string, unknown> {
  const text = outcome.bodyText.length > MAX_FAILED_BODY_CHARS
    ? outcome.bodyText.slice(0, MAX_FAILED_BODY_CHARS)
    : outcome.bodyText;
  return replaceJournalLoneSurrogates({
    status: outcome.status,
    contentType: outcome.headers["content-type"] ?? null,
    retryAfter: outcome.headers["retry-after"] ?? null,
    bodyText: text,
    truncated: text.length < outcome.bodyText.length,
  }).value;
}

/**
 * Capture a live outcome (tx 2): the raw answer as an observation (2xx under
 * the spec's kind, anything else under `<kind>:failed`; a transport error or
 * timeout journals nothing), the attempt's outcome and send instant, the
 * page's send facts, and every consequence `onOutcome` decides (holds, the
 * network streak, breakers, quarantine). Alerts open after the commit.
 */
export async function capture(
  d: CommitDeps,
  admission: AdmissionRecord,
  armed: Admission,
  outcome: Exclude<FanslyWireOutcome, { kind: "aborted_before_send" }>,
  module: ResourceModule,
): Promise<CaptureResult> {
  const now = d.clock.wallNow();
  const wireSpec = fanslyWireSpec(admission.request.spec);
  const classified = classifyWireOutcome(outcome, wireSpec, admission.request.params as never, {
    now,
    ...(admission.spec.terminalStatuses === undefined ? {} : { terminalStatuses: admission.spec.terminalStatuses }),
  });
  const read: FanslyWireRead<unknown> | null = classified.read;
  const sent = armed.sentMono !== null;
  const durationMs = armed.sentMono === null ? null : d.clock.monoNow() - armed.sentMono;
  let observationPayload: { kind: string; payload: unknown } | null = null;
  if (outcome.kind === "response" && read !== null) {
    observationPayload = read.kind === "accepted" || read.kind === "contract_violation"
      ? {
        kind: wireSpec.kind,
        payload: (d.capture ?? defaultCaptureCodec).prepare({
          spec: admission.request.spec,
          kind: wireSpec.kind,
          response: read.response,
          contractAccepted: read.kind === "accepted",
          request: admission.request,
          module,
        }),
      }
      : { kind: `${wireSpec.kind}:failed`, payload: failedBody(outcome) };
  }

  const committed = await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    let observation: { id: number; receivedAt: Date } | null = null;
    if (observationPayload !== null) {
      const inserted = await insertObservation(tx, {
        source: "pull",
        producer: `fansly-sync:${admission.work.resource}`,
        platform: "fansly",
        accountId: d.pageId,
        nativeAccountRef: d.ownRef,
        kind: observationPayload.kind,
        payload: observationPayload.payload,
        payloadHash: createHash("sha256").update(JSON.stringify(observationPayload.payload ?? null)).digest(),
        idempotencyKey: `fansly-sync:${d.pageId}:attempt:${admission.attemptId}`,
      });
      observation = { id: inserted.observationId, receivedAt: inserted.receivedAt };
    }
    const captured = await captureAttempt(tx, {
      attemptId: admission.attemptId,
      pageId: d.pageId,
      outcome: outcome.kind,
      sent,
      sentAt: armed.sentWall,
      sendMark: armed.sendMark,
      sendMonoOffsetMs: armed.sentMono === null ? null : armed.sentMono - armed.issuedMono,
      gapPrevMs: armed.gapPrevMs,
      httpStatus: classified.httpStatus,
      retryAfterMs: classified.retryAfterMs,
      errorClass: classified.errorClass === "ok" ? null : classified.errorClass,
      durationMs,
      responseBytes: outcome.kind === "response" ? outcome.bodyBytes : null,
      observation,
      applyState: classified.errorClass === "ok" ? "captured" : "none",
    });
    if (!captured.captured) return { decision: null, paceGapMs: null };

    const page = await getSyncPage(tx, d.pageId);
    if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
    const file = resourceFileOf(admission.work.resource);
    const decision = onOutcome({
      errorClass: classified.errorClass,
      now,
      resource: admission.work.resource,
      subject: admission.work.subject,
      httpStatus: classified.httpStatus,
      retryAfterMs: classified.retryAfterMs,
      page: pageErrorState(page),
      // The newest 429 matters only while the 429 ladder is above step 0
      // (`rateLimitStep`); the steady state reads nothing.
      lastRateLimitAt: page.holdStep > 0
        ? await lastRateLimitAt(tx, { pageId: d.pageId, withinMs: RATE_LIMIT_LOOKBACK_MS, excludeAttemptId: admission.attemptId })
        : null,
      subjectState: {
        failureCount: admission.work.failureCount,
        breakerUntil: admission.work.breakerUntil,
        blockedByVendorAt: admission.work.blockedByVendorAt,
      },
      subjectQueue: admission.spec.subjectQueue === true,
      recentFailedSubjects: classified.errorClass === "subject_failure" || classified.errorClass === "envelope_unsuccessful"
        ? await countRecentFailedSubjects(tx, {
          pageId: d.pageId,
          file,
          windowMs: RESOURCE_BREAKER_WINDOW_MS,
          exemptKeys: [...RESOURCE_HOLD_EXEMPT_KEYS],
        })
        : 0,
    });
    await writeOutcomeDecision(tx, d, {
      attemptId: admission.attemptId,
      work: admission.work,
      demandRevision: admission.demandRevision,
      subjectQueue: admission.spec.subjectQueue === true,
      request: admission.request,
    }, decision, module);
    return { decision, paceGapMs: captured.paceGapMs };
  });

  if (committed.decision === null) return { applyNow: false, inMemory: null };
  if (committed.decision.errorClass === "rate_limit_list") {
    d.metrics.increment("sync_list_rate_limited", { pageId: d.pageId, resource: admission.work.resource });
  }
  const alerts = [...committed.decision.alerts];
  // "Проверка, а не вера" (plan §2.4): this send against the page's previous
  // recorded send of ANY owner; closer than the setting opens alert 1.
  if (committed.paceGapMs !== null && committed.paceGapMs < armed.settingMs) {
    alerts.push({ subKey: "page_stopped", detail: "pace_violation" });
    d.metrics.increment("sync_pace_violations", { pageId: d.pageId });
  }
  await openAlerts(d, alerts, { resource: admission.work.resource, attemptId: admission.attemptId });
  const applyNow = committed.decision.work.action === "apply";
  return {
    applyNow,
    inMemory: applyNow && read !== null && read.kind === "accepted" ? { response: read.response, parsed: read.value } : null,
  };
}

/** What an outcome decision is written against: the attempt and its work. */
interface OutcomeTarget {
  attemptId: number;
  /** Null when the attempt's work row is gone: only the page and the attempt
   *  take the decision. */
  work: SyncWorkRow | null;
  /** The work's demand revision the attempt served (I11). */
  demandRevision: number;
  subjectQueue: boolean;
  /** The request the attempt sent (a subject-queue walk's subject). */
  request: RequestPlan;
}

async function writeOutcomeDecision(
  tx: Database,
  d: CommitDeps,
  target: OutcomeTarget,
  decision: OutcomeDecision,
  module: ResourceModule | null,
): Promise<void> {
  const fenced = { pageId: d.pageId, generation: d.generation };
  const hold = decision.pageHold;
  if (hold.action === "set") {
    await setPageHold(tx, { ...fenced, kind: hold.kind, until: hold.until, step: hold.step, detail: hold.detail });
  } else if (hold.action === "clear") {
    await clearPageHold(tx, { ...fenced, resetStep: hold.resetStep });
  }
  if (decision.networkFailureStreak !== null) {
    await setNetworkFailureStreak(tx, { ...fenced, streak: decision.networkFailureStreak });
  }
  const resourceHold = decision.resourceHold;
  if (resourceHold.action === "set") {
    await setResourceHold(tx, {
      ...fenced,
      file: resourceHold.file,
      hold: {
        until: resourceHold.until,
        step: resourceHold.step,
        ...(resourceHold.kind === undefined ? {} : { kind: resourceHold.kind }),
        ...(resourceHold.lastRateLimitAt === undefined ? {} : { lastRateLimitAt: resourceHold.lastRateLimitAt }),
      },
    });
  } else if (resourceHold.action === "clear") {
    await setResourceHold(tx, { ...fenced, file: resourceHold.file, hold: null });
  }
  if (decision.quarantineAttempt) {
    await markAttemptQuarantined(tx, { attemptId: target.attemptId, error: decision.errorClass });
  }
  const work = target.work;
  if (work === null) return;
  const subjectQueue = target.subjectQueue;
  if (subjectQueue && decision.subjectBreaker !== null && module?.onSubjectOutcome !== undefined) {
    await module.onSubjectOutcome(tx, work, {
      kind: decision.subjectBreaker.terminal ? "terminal" : "failure",
      failureCount: decision.subjectBreaker.failureCount,
      breakerUntil: decision.subjectBreaker.breakerUntil,
      blockedByVendorAt: decision.subjectBreaker.blockedByVendorAt,
    }, { request: target.request, attemptId: target.attemptId });
  }
  const breaker = !subjectQueue && decision.subjectBreaker !== null
    ? {
      failureCount: decision.subjectBreaker.failureCount,
      breakerUntil: decision.subjectBreaker.breakerUntil,
      blockedByVendorAt: decision.subjectBreaker.blockedByVendorAt,
    }
    : undefined;
  const next = decision.work;
  switch (next.action) {
    case "apply":
      return;
    case "reopen":
      await settleWork(tx, {
        workId: work.id,
        generation: d.generation,
        servedRevision: target.demandRevision,
        satisfiesRevision: false,
        nextDueAt: next.dueAt,
        waitingReason: next.waitingReason,
        waitingUntil: next.waitingUntil,
        lastErrorClass: decision.attemptErrorClass,
        ...(breaker === undefined ? {} : { breaker }),
      });
      return;
    case "quarantine":
      await quarantineWork(tx, { workId: work.id, generation: d.generation, errorClass: next.reason });
      return;
    case "close":
      await settleWork(tx, {
        workId: work.id,
        generation: d.generation,
        servedRevision: target.demandRevision,
        satisfiesRevision: true,
        close: "done",
        closeReason: next.closeReason,
        lastErrorClass: decision.attemptErrorClass,
        ...(breaker === undefined ? {} : { breaker }),
      });
      return;
  }
}

// ── tx 3: apply (live) ──────────────────────────────────────────────────────

export type ApplyErrorKind = "deferred" | "deterministic" | "transient" | "other";

/** SQLSTATEs retried without counting (§3.7.3): serialization, deadlock, lock
 *  not available, statement cancelled; class 08 is connection loss. */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03", "57014", "57P01"]);
const TRANSIENT_MESSAGES = [
  "Connection terminated",
  "timeout exceeded when trying to connect",
  "Client has encountered a connection error",
  "Query read timeout",
];

function* errorChain(error: unknown): Generator<unknown> {
  let current = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

function sqlStateOf(error: unknown): string | null {
  for (const link of errorChain(error)) {
    const code = (link as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/** A class name for the journal: the SQLSTATE or the typed error's name,
 *  never a message (driver messages embed SQL and parameters). */
export function errorName(error: unknown): string {
  const state = sqlStateOf(error);
  if (state !== null) return state;
  if (error instanceof ApplyDeferred) return `deferred:${error.reason}`;
  if (error instanceof ApplyQuarantine) return `quarantine:${error.reason}`;
  if (error instanceof Error) return error.name || "Error";
  return "unknown";
}

/** What a deterministic apply error stops beyond its own work (§3.7.3):
 *  an identity error the whole page (§3.8, §5.1), a wrong transactions writer
 *  the resource's file (§5.6). */
export type ApplyErrorScope = "page_identity" | "resource_writer";

export function applyErrorScope(error: unknown): ApplyErrorScope | null {
  for (const link of errorChain(error)) {
    if (link instanceof PlatformAccountIdentityImmutableError || link instanceof PlatformAccountIdentityConflictError) {
      return "page_identity";
    }
    if (link instanceof WrongTransactionsWriterError) return "resource_writer";
  }
  return null;
}

/** The apply error classes of design §3.7.3. */
export function classifyApplyError(error: unknown): ApplyErrorKind {
  for (const link of errorChain(error)) {
    if (link instanceof ApplyDeferred || isCapturePayloadUnavailable(link)) return "deferred";
    if (link instanceof FanslyContractViolationError || link instanceof ApplyQuarantine) return "deterministic";
  }
  if (applyErrorScope(error) !== null) return "deterministic";
  const state = sqlStateOf(error);
  if (state !== null) {
    if (state.startsWith("22") || state.startsWith("23")) return "deterministic";
    if (TRANSIENT_SQLSTATES.has(state) || state.startsWith("08")) return "transient";
    return "other";
  }
  for (const link of errorChain(error)) {
    if (link instanceof Error && TRANSIENT_MESSAGES.some((message) => link.message.includes(message))) {
      return "transient";
    }
  }
  return "other";
}

/** When to try a deferred apply again, by the age of its answer. */
export function deferredRetryInMs(answerAgeMs: number): number {
  for (const step of DEFERRED_RETRY_LADDER) {
    if (answerAgeMs < step.ageBelowMs) return step.retryInMs;
  }
  return DEFERRED_RETRY_CAP_MS;
}

async function readJournaledResponse(
  tx: Database,
  d: CommitDeps,
  attempt: SyncAttemptRow,
): Promise<unknown> {
  if (attempt.observationId === null || attempt.observationReceivedAt === null) {
    throw new ApplyDeferred("no_observation");
  }
  const result = await tx.execute<{ payload: unknown; bucket: string | null; objectId: string | null }>(sql`
    select o.payload, to_char(o.payload_bucket_month, 'YYYY-MM-DD') as bucket, o.payload_object_id::text as "objectId"
      from observations o
     where o.id = ${attempt.observationId} and o.received_at = ${attempt.observationReceivedAt}::timestamptz
  `);
  const row = result.rows[0];
  if (!row) throw new ApplyDeferred("observation_missing");
  const resolved = await resolveCapturePayloadRow(
    { db: tx, logger: d.logger as never },
    "observation",
    attempt.observationId,
    { payload: row.payload, payloadRef: capturePayloadRefFromColumns(row.bucket, row.objectId) },
  );
  return resolved.payload;
}

export type ApplyOutcome = "applied" | "nothing" | ApplyErrorKind;

/**
 * Apply a captured answer (tx 3), from memory right after the capture or from
 * the journal after a restart (no HTTP, I8). Idempotent: an attempt that is no
 * longer `captured`/`deferred` is left alone. Every error is classified and
 * written in its own fenced transaction; only an ownership loss (foreign
 * generation) and a test crash leave this function by throwing.
 */
export async function apply(
  d: CommitDeps,
  attemptId: number,
  inMemory: { response: unknown; parsed: unknown } | null = null,
): Promise<ApplyOutcome> {
  try {
    const applied = await inTx(d.db, async (tx) => {
      await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "share" });
      const attempt = await lockAttemptForApply(tx, attemptId);
      if (attempt === null || attempt.shadow) return "nothing" as const;
      const spec = d.registry.spec(attempt.resource);
      if (spec === null) throw new ApplyDeferred("no_registry_entry");
      const module = await d.registry.module(attempt.resource);
      let fenced = false;
      if (spec.fence === "dm_archive") {
        if (!(await tryAcquireDmArchiveWriterFenceLock(tx, d.pageId))) throw new ApplyDeferred("erasure_busy");
        fenced = true;
      }
      if (attempt.workId === null) throw new ApplyDeferred("no_work");
      const work = await getSyncWork(tx, attempt.workId);
      if (work === null) throw new ApplyDeferred("work_missing");
      const request = requestOfAttempt(attempt);
      let response: unknown;
      let parsed: unknown;
      if (inMemory !== null) {
        ({ response, parsed } = inMemory);
      } else {
        response = await readJournaledResponse(tx, d, attempt);
        const reparsed = fanslyWireSpec(request.spec).parse(response, request.params as never);
        if (!reparsed.ok) throw new FanslyContractViolationError(reparsed.violation.field, reparsed.violation.detail);
        parsed = reparsed.value;
      }
      await fault(d, "in_apply");
      const result = await module.apply(tx, {
        pageId: d.pageId,
        now: d.clock.wallNow(),
        ownRef: d.ownRef,
        work,
        attempt,
        request,
        parsed,
        response,
        observation: { id: attempt.observationId!, receivedAt: attempt.observationReceivedAt! },
        fenced,
      });
      if (d.canonicalize !== undefined && result.canonicalized !== true) {
        await d.canonicalize(tx, {
          pageId: d.pageId,
          ownRef: d.ownRef,
          observationId: attempt.observationId!,
          receivedAt: attempt.observationReceivedAt!,
        });
      }
      // sync_work after every event append (lock order): the work row, then
      // the follow-ups in (resource, subject) order.
      const now = d.clock.wallNow();
      const page = await getSyncPage(tx, d.pageId);
      const settle = settleInputOf(d, work, spec, result.work, attempt.demandRevision ?? work.demandRevision, page, now);
      const breakerSet = work.failureCount !== 0 || work.breakerUntil !== null || work.blockedByVendorAt !== null;
      await settleWork(tx, {
        ...settle,
        lastErrorClass: null,
        ...(breakerSet && spec.subjectQueue !== true
          ? { breaker: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null } }
          : {}),
      });
      const upserts = upsertsOf(d, result.followups, page, now);
      if (upserts.length > 0) await upsertDemands(tx, upserts);
      if (result.threadChainChanged !== undefined && d.onThreadChainChanged !== undefined) {
        await d.onThreadChainChanged(tx, { pageId: d.pageId, threadId: result.threadChainChanged.threadId });
      }
      await markApplied(tx, { attemptId });
      return {
        outcome: "applied" as const,
        counters: result.counters ?? null,
        pageIdentity: result.pageIdentity ?? null,
        resource: attempt.resource,
      };
    });
    if (applied === "nothing") return "nothing";
    for (const [name, by] of Object.entries(applied.counters ?? {})) {
      d.metrics.increment("sync_apply_effect", { resource: applied.resource, effect: name }, by);
    }
    if (applied.pageIdentity !== null) await recordIdentity(d, applied.pageIdentity.accountId);
    return applied.outcome;
  } catch (error) {
    if (error instanceof SyncCrashFault || error instanceof OwnershipLostError) throw error;
    return recordApplyError(d, attemptId, error);
  }
}

/** The page's identity after an applied `/account/me` (status only: the
 *  identity guard is `updatePageMetadata` inside the apply). Its own small
 *  fenced transaction — tx 3 holds the page row FOR SHARE, and upgrading that
 *  lock while the heartbeat waits on the row would deadlock. A failure is
 *  logged; the next read writes it again. */
async function recordIdentity(d: CommitDeps, accountId: string): Promise<void> {
  try {
    await inTx(d.db, async (tx) => {
      await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
      await recordSyncPageIdentity(tx, { pageId: d.pageId, generation: d.generation, accountId });
    });
  } catch (error) {
    if (error instanceof OwnershipLostError) throw error;
    d.logger.warn({ pageId: d.pageId, err: errorName(error) }, "Fansly sync: the page identity could not be recorded");
  }
}

async function recordApplyError(d: CommitDeps, attemptId: number, error: unknown): Promise<ApplyErrorKind> {
  const kind = classifyApplyError(error);
  const scope = kind === "deterministic" ? applyErrorScope(error) : null;
  const name = errorName(error);
  const settled = await inTx(d.db, async (tx): Promise<{ quarantined: boolean; alerts: AlertDecision[] }> => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    const attempt = await lockAttemptForApply(tx, attemptId);
    if (attempt === null) return { quarantined: false, alerts: [] };
    const now = d.clock.wallNow();
    const answerAgeMs = Math.max(0, now.getTime() - (attempt.completedAt ?? attempt.admittedAt).getTime());
    const retryInMs = deferredRetryInMs(answerAgeMs);
    let quarantine = false;
    if (kind === "deferred" || kind === "transient") {
      const payloadGone = [...errorChain(error)].some((link) => isCapturePayloadUnavailable(link));
      if (payloadGone && answerAgeMs > PAYLOAD_UNAVAILABLE_QUARANTINE_MS) {
        quarantine = await markAttemptQuarantined(tx, { attemptId, error: name });
      } else {
        await markDeferred(tx, { attemptId, error: name, retryInMs });
      }
    } else {
      const recorded = await recordApplyFailure(tx, {
        attemptId,
        error: name,
        retryInMs,
        deterministic: kind === "deterministic",
      });
      quarantine = recorded?.quarantined === true;
    }
    if (!quarantine) return { quarantined: false, alerts: [] };

    const quarantinedAlert: AlertDecision = { subKey: "live_degraded", detail: "quarantined" };
    if (scope === "page_identity") {
      // The credentials answer for another account: no further request of
      // this page goes out with them. Through `onOutcome` like any outcome
      // (§3.8): the indefinite `identity_mismatch` hold under this credentials
      // generation (the gate admits nothing until it changes), the work
      // quarantined, alerts 1 and 2.
      const page = await getSyncPage(tx, d.pageId);
      if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
      const work = attempt.workId === null ? null : await getSyncWork(tx, attempt.workId);
      const subjectQueue = d.registry.spec(attempt.resource)?.subjectQueue === true;
      const decision = onOutcome({
        errorClass: "identity_mismatch",
        now,
        resource: attempt.resource,
        subject: attempt.subject,
        httpStatus: attempt.httpStatus,
        retryAfterMs: null,
        page: pageErrorState(page),
        // Read only by the 429 ladder.
        lastRateLimitAt: null,
        subjectState: {
          failureCount: work?.failureCount ?? 0,
          breakerUntil: work?.breakerUntil ?? null,
          blockedByVendorAt: work?.blockedByVendorAt ?? null,
        },
        subjectQueue,
        recentFailedSubjects: 0,
      });
      // The decision has no subject breaker, so no module hook is needed.
      await writeOutcomeDecision(tx, d, {
        attemptId,
        work,
        demandRevision: attempt.demandRevision ?? work?.demandRevision ?? 0,
        subjectQueue,
        request: requestOfAttempt(attempt),
      }, decision, null);
      return { quarantined: true, alerts: decision.alerts };
    }
    if (scope === "resource_writer") {
      // Another writer owns this page's ledger: the file waits on the
      // resource-hold ladder instead of failing every one of its works.
      const page = await getSyncPage(tx, d.pageId);
      if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
      const hold = escalateResourceHold(
        page.resourceHolds as Record<string, ResourceHoldEntry>,
        attempt.resource,
        now,
      );
      if (hold.action === "set") {
        await setResourceHold(tx, {
          pageId: d.pageId,
          generation: d.generation,
          file: hold.file,
          hold: { until: hold.until, step: hold.step },
        });
      }
    }
    if (attempt.workId !== null) {
      await quarantineWork(tx, { workId: attempt.workId, generation: d.generation, errorClass: `apply:${name}` });
    }
    return { quarantined: true, alerts: [quarantinedAlert] };
  });
  d.metrics.increment("sync_apply_errors", { kind, error: name });
  const log = kind === "transient" || kind === "deferred" ? d.logger.warn.bind(d.logger) : d.logger.error.bind(d.logger);
  const refusal = [...errorChain(error)].find((link): link is ApplyQuarantine => link instanceof ApplyQuarantine);
  log({
    pageId: d.pageId,
    attemptId,
    kind,
    error: name,
    quarantined: settled.quarantined,
    ...(refusal === undefined ? {} : { refusal: refusal.detail }),
  }, "Fansly sync: apply failed");
  if (settled.alerts.length > 0) await openAlerts(d, settled.alerts, { attemptId });
  return kind;
}

/** Live: apply the captured/deferred attempts whose retry time passed, at most
 *  `max` per lap; never waits for one (a failing apply never blocks the page). */
export async function drainDueApplies(d: CommitDeps, max: number): Promise<number> {
  if (d.mode !== "live") return 0;
  const due = await listUnfinishedAttempts(d.db, { pageId: d.pageId, phase: "apply", dueOnly: true, limit: max });
  let applied = 0;
  for (const attempt of due) {
    if (attempt.shadow) continue;
    if ((await apply(d, attempt.id)) === "applied") applied += 1;
  }
  return applied;
}

// ── recovery ────────────────────────────────────────────────────────────────

/**
 * Recovery at actor start (design §3.7.5), under the new generation: unfinished
 * live attempts become `unknown` (the read is repeated as a new attempt; the
 * takeover floor covers a possible send), admitted shadow attempts close as
 * `shadow`, running work without a pending apply opens again, and pending
 * applies are due now (applied by `drainDueApplies` before any admission).
 */
export async function recoverUnfinished(d: CommitDeps): Promise<RecoverUnfinishedAttemptsResult> {
  return inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    return recoverUnfinishedAttempts(tx, { pageId: d.pageId });
  });
}

// ── alerts ──────────────────────────────────────────────────────────────────

/** Open the decided alerts. A shadow page's alert is a metric only (D14);
 *  the sink decides what pages the owner. Never throws. */
export async function openAlerts(
  d: CommitDeps,
  alerts: readonly AlertDecision[],
  context: Record<string, unknown> = {},
): Promise<void> {
  for (const alert of alerts) {
    d.metrics.increment("sync_alerts", { subKey: alert.subKey, detail: alert.detail, shadow: d.mode === "shadow" });
    try {
      await d.alerts.open({
        subKey: alert.subKey,
        pageId: d.pageId,
        detail: alert.detail,
        shadow: d.mode === "shadow",
        context,
      });
    } catch (error) {
      d.logger.warn({ pageId: d.pageId, subKey: alert.subKey, err: errorName(error) }, "Fansly sync: alert could not be opened");
    }
  }
}
