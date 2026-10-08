import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  capturePayloadRefFromColumns,
  captureAttempt,
  clearPageHold,
  closeQuarantinedWork,
  countRecentFailedSubjects,
  getOpenWorkForKey,
  getSyncAttempt,
  getSyncPage,
  getSyncWork,
  insertAdmission,
  insertAuditEvent,
  insertObservation,
  listUnfinishedAttempts,
  lockAttemptForApply,
  lockOwnedPage,
  lockWorkRows,
  markApplied,
  markAttemptQuarantined,
  markHistoryTurnServed,
  markAttemptSent,
  markDeferred,
  markWorkRunning,
  OwnershipLostError,
  PlatformAccountIdentityConflictError,
  PlatformAccountIdentityImmutableError,
  quarantineWork,
  recordApplyFailure,
  recordSyncPageIdentityProof,
  recoverUnfinishedAttempts,
  setNetworkFailureStreak,
  setPageHold,
  setResourceHold,
  settleAttemptWithoutCapture,
  settleWork,
  skipAttemptApply,
  writeSyncRouteState,
  SYNC_APPLY_ERROR_PAYLOAD_UNAVAILABLE,
  tryAcquireDmArchiveWriterFenceLock,
  upsertDemands,
  type Database,
  type RecoverUnfinishedAttemptsResult,
  type SettleWorkResult,
  type SyncAttemptRow,
  type SyncPageRow,
  type SyncWorkRow,
  type UpsertDemandInput,
} from "@agency_hub_core/db";
import {
  buildFanslyWireTarget,
  FANSLY_WIRE_IDS,
  fanslyWireSpec,
  isFanslyErrorEnvelope,
  type FanslyWireId,
  type FanslyWireOutcome,
  type FanslyWireRead,
  type FanslyWireRequest,
} from "@agency_hub_core/fansly";
import { proofClearsCredentialsHold, type FanslyPageHoldOperation } from "@agency_hub_core/shared";

import { isCapturePayloadUnavailable, resolveCapturePayloadRow } from "../../services/payload-reader.ts";
import { WrongTransactionsWriterError } from "../../services/transactions-writer-gate.ts";
import { fanslyCdnTokenStripApplies, stripFanslySignedCdnTokens } from "../fansly/lib/cdn-tokens.ts";
import { replaceJournalLoneSurrogates } from "../fansly/lib/journal-lone-surrogates.ts";
import { routeOfWireId } from "../fansly/routes.ts";
import { holdSetOf, whyHeld, type HoldSet } from "./admission.ts";
import {
  classifyWireOutcome,
  escalateResourceHold,
  IDENTITY_CHECK_KEY,
  identityCandidateOf,
  onOutcome,
  RESOURCE_BREAKER_UNCOUNTED_KEYS,
  RESOURCE_BREAKER_WINDOW_MS,
  resourceFileOf,
  type AlertDecision,
  type OutcomeDecision,
  type PageErrorState,
  VERIFY_KEY,
} from "./errors.ts";
import type { Admission, SlotGrant } from "./pacer.ts";
import type { AlertSink, Clock, Metrics, Rng, SecretBox, SettingsSource } from "./ports.ts";
import {
  demandToUpsert,
  nextPollDueAt,
  WAIT_RECHECK_MS,
  type ApplyResult,
  type DemandSignal,
  type EngineRegistry,
  type EngineResourceSpec,
  type RequestPlan,
  type ResourceModule,
  type StepPlan,
  type WorkOutcome,
} from "./resource.ts";
import type { RouteAdmissionIntervals } from "./route-policy.ts";
import { judgePaceGap } from "./send-audit.ts";
import type { WorkClass } from "./scheduler.ts";

// The transactions of one step (plan §8, design §3.7). Each runs as ONE short
// transaction that starts with the generation fence (`lockOwnedPage`, I7):
//
//   admit   (tx 1)  the work becomes `running`, the attempt is journaled and
//                   counted BEFORE anything is sent, behind the live gate
//                   (I17);
//   capture (tx 2)  the raw answer is committed to `observations` before
//                   anything parses it (I8), with the outcome and every error
//                   consequence (`errors.onOutcome`);
//   apply   (tx 3)  erasure fence → the resource's writes → the work's
//                   cursor/proof and `applied_revision` (I11) → follow-ups →
//                   `applied`. A failing apply is classified, never thrown out
//                   of the actor.
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
    /** The page's native account id (`pages.external_page_id`): the receiver
     *  a scoped answer is checked against (absent: no scope check). */
    ownRef?: string | null;
    module: ResourceModule;
  }): unknown;
  /**
   * The answer an apply from the journal works on (tx 3 after a restart, a
   * transient apply error or a deferral, I8): the journal body with every
   * envelope `prepare` put around the served answer taken off again, so the
   * re-parse and the apply see what the in-memory apply saw. Trims and token
   * strips stay (design §3.11: the apply prefers the in-memory answer for
   * them). A body that is not this request's answer throws `ApplyQuarantine`.
   */
  served(input: { spec: FanslyWireId; kind: string; payload: unknown; request: RequestPlan }): unknown;
}

/**
 * The engine's journal transform: the resource's own trim, then the signed CDN
 * tokens stripped for the kinds the legacy journal strips them for, then every
 * unpaired UTF-16 surrogate replaced (json/jsonb refuse one). The served object
 * is never mutated. It adds no envelope, so the journal body is the answer.
 */
export const defaultCaptureCodec: CaptureCodec = {
  prepare({ kind, response, module }) {
    let body = module.journal === undefined ? response : module.journal(response);
    if (fanslyCdnTokenStripApplies("fansly", kind)) body = stripFanslySignedCdnTokens(body);
    return replaceJournalLoneSurrogates(body).value;
  },
  served({ payload }) {
    return payload;
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

/** Runs in the transaction that closed a work row (done or cancelled), after
 *  every sync_work write of it: the history requests settle the fans that
 *  rode on it (`history_*` last in the lock order). */
export type WorkClosedHook = (
  tx: Database,
  input: { pageId: number; workId: number; resource: string; subject: string; closeReason: string | null },
) => Promise<void>;

/** Runs in the capture transaction of a refusal that leaves a chat's
 *  unavailability episode established (arena "vanished chat" §2.4), after the
 *  work row is settled: the history requests refuse the chat's open fans that
 *  need its head (`history_*` last in the lock order). Under a savepoint. */
export type ChatUnavailableHook = (tx: Database, input: { pageId: number; threadId: number }) => Promise<void>;

export interface CommitDeps {
  db: Database;
  pageId: number;
  /** `pages.external_page_id`: the observations' native account ref. */
  ownRef: string | null;
  generation: bigint;
  registry: EngineRegistry;
  clock: Clock;
  rng: Rng;
  alerts: AlertSink;
  metrics: Metrics;
  logger: SyncLogger;
  capture?: CaptureCodec;
  canonicalize?: ObservationCanonicalizer;
  onThreadChainChanged?: ThreadChainChangedHook;
  onWorkClosed?: WorkClosedHook;
  onChatUnavailable?: ChatUnavailableHook;
  /** The live settings resources read (absent: the registry defaults). */
  settings?: SettingsSource;
  /** The box of the works' secret parameters (the host's; absent where a
   *  test reads and writes none). */
  secrets?: SecretBox;
  faults?: SyncFaultHook;
}

/** The history request and fan whose turn a requests-class read is. */
export interface RequestTurn {
  requestId: number;
  itemId: number;
}

/** The work a slot picked. */
export interface PickedWork {
  work: SyncWorkRow;
  workClass: WorkClass;
  slot: number;
  nextCyclePos: number;
  /** Requests class: whose turn it is (the admission stamps it, §3.7.1). */
  requestTurn?: RequestTurn | null;
}

export interface AdmissionRecord {
  attemptId: number;
  admittedAt: Date;
  /** The work's demand revision at admission (I11). */
  demandRevision: number;
  /** The work's demand at that revision, read under the admission's row lock
   *  (`work` is the pick's snapshot, which may be older). */
  demand: SyncWorkRow["demand"];
  work: SyncWorkRow;
  workClass: WorkClass;
  spec: EngineResourceSpec;
  request: RequestPlan;
  /** The digest of the credentials the prepared request carries (null: a
   *  route without a session, or a stand-in transport). */
  credentialsGeneration?: string | null;
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

function inTx<T>(db: Database, body: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => body(tx as unknown as Database));
}

async function fault(d: CommitDeps, point: SyncFaultPoint): Promise<void> {
  if (d.faults !== undefined) await d.faults(point);
}

/** The wire routes whose answer is never journaled (`capture`: the
 *  WebSocket Upgrade, a CDN hop): applied from memory or not at all. */
export const ANSWER_IN_MEMORY_OPERATIONS: readonly FanslyWireId[] =
  FANSLY_WIRE_IDS.filter((id) => fanslyWireSpec(id).capture !== undefined);

export function isAnswerInMemory(operation: string): boolean {
  return (ANSWER_IN_MEMORY_OPERATIONS as readonly string[]).includes(operation);
}

/** `sync_attempts.request` of an API route: the wire id, its parameters (the
 *  coverage evidence, design §2.9 D1), the request line and — when the
 *  resource keeps it — its account of the step (`RequestPlan.step`). Never a
 *  header. A route of another host keeps no request line (design J7): the
 *  Upgrade has nothing to name, and a CDN hop names only its hop and the
 *  sha256 of its URL path — the signed URL itself stays in the work's
 *  ciphertext. */
export function requestJsonOf(
  request: RequestPlan,
  sent?: Pick<FanslyWireRequest, "url" | "credentialsGeneration"> | null,
): {
  spec: FanslyWireId;
  params: unknown;
  path?: string;
  query?: Record<string, string>;
  host?: "cdn" | "ws";
  hop?: number;
  pathSha256?: string | null;
  step?: unknown;
  credentialsGeneration?: string;
} {
  const host = fanslyWireSpec(request.spec).host;
  const step = request.step === undefined ? {} : { step: request.step };
  // Not a secret: the sha256 of the stored (or candidate) credentials, so an
  // auth hold names the credentials that failed (step-3 §3.5 item 3) — the
  // Upgrade is sent with the page's stored session too.
  const credentials = sent?.credentialsGeneration === undefined ? {} : { credentialsGeneration: sent.credentialsGeneration };
  if (host === "ws") return { spec: request.spec, host, params: {}, ...step, ...credentials };
  if (host === "cdn") {
    const hop = Number((request.params as { hop?: unknown }).hop ?? 0);
    let pathSha256: string | null = null;
    if (sent !== undefined && sent !== null) {
      try {
        pathSha256 = createHash("sha256").update(new URL(sent.url).pathname).digest("hex");
      } catch {
        pathSha256 = null;
      }
    }
    return { spec: request.spec, host, params: { hop }, hop, pathSha256, ...step };
  }
  const target = buildFanslyWireTarget(request.spec, request.params as never);
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(target.search)) query[key] = value;
  return {
    spec: request.spec,
    params: request.params,
    path: target.pathname,
    query,
    ...step,
    ...credentials,
  };
}

/** The credentials digest an attempt's request carried (null: none journaled). */
export function credentialsGenerationOfAttempt(attempt: Pick<SyncAttemptRow, "request">): string | null {
  const stored = attempt.request as { credentialsGeneration?: unknown } | null;
  return typeof stored?.credentialsGeneration === "string" ? stored.credentialsGeneration : null;
}

/** The request an attempt sent, as its plan made it (`step` included). */
export function requestOfAttempt(attempt: Pick<SyncAttemptRow, "request" | "operation">): RequestPlan {
  const stored = attempt.request as { spec?: unknown; params?: unknown; step?: unknown } | null;
  const spec = typeof stored?.spec === "string" ? stored.spec : attempt.operation;
  return {
    spec: spec as FanslyWireId,
    params: (stored?.params ?? {}) as never,
    ...(stored?.step === undefined ? {} : { step: stored.step }),
  };
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
    const upsert = demandToUpsert(signal, spec, { pageId: d.pageId, now, ...(page === null ? {} : { page }) });
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

/** Run the work-closed hook when a settle closed the row. */
async function afterSettle(
  tx: Database,
  d: CommitDeps,
  work: Pick<SyncWorkRow, "id" | "resource" | "subject">,
  settled: SettleWorkResult | null,
  closeReason: string | null,
): Promise<void> {
  if (settled === null || d.onWorkClosed === undefined) return;
  if (settled.state !== "done" && settled.state !== "cancelled") return;
  await d.onWorkClosed(tx, { pageId: d.pageId, workId: work.id, resource: work.resource, subject: work.subject, closeReason });
}

// ── tx 1: admission ─────────────────────────────────────────────────────────

/** What a picked work's request is to the page holds: a candidate identity
 *  check, the verify of the stored credentials with the digest its request
 *  carries (A3), or any other request. */
export function pageHoldOperationOf(
  work: Pick<SyncWorkRow, "resource" | "params">,
  prepared: Pick<FanslyWireRequest, "credentialsGeneration"> | null,
): FanslyPageHoldOperation {
  if (work.resource === IDENTITY_CHECK_KEY && identityCandidateOf(work) !== null) return { kind: "candidate_check" };
  if (work.resource === VERIFY_KEY) return { kind: "verify", digest: prepared?.credentialsGeneration ?? null };
  return { kind: "request" };
}

/** A page hold refused the request at its admission (tx 1 rolled back:
 *  nothing was written, the slot is not consumed). `until` null: no instant
 *  ends it (rows of the hold set this build cannot read). */
export class AdmissionHeldError extends Error {
  constructor(readonly kind: string, readonly until: Date | null) {
    super(`The page is held (${kind}) until ${until === null ? "it is repaired" : until.toISOString()}`);
    this.name = "AdmissionHeldError";
  }
}

/**
 * Admit one request (tx 1). Null when the work is no longer open (another
 * step took it): nothing was written and the slot is not consumed. Throws
 * `AdmissionHeldError` when a page hold refuses the request now,
 * `OwnershipLostError` for a foreign generation and `LiveGateClosedError` for
 * an admission without its gates (I17).
 */
export async function admit(
  d: CommitDeps,
  picked: PickedWork,
  request: RequestPlan,
  grant: SlotGrant,
  /** The route's and its family's intervals the route check applied (I19):
   *  recorded on the attempt for the send audit. */
  intervals: RouteAdmissionIntervals,
  module: ResourceModule,
  /** The request the transport built for the plan (a CDN hop's path digest,
   *  the digest of the credentials it carries). */
  prepared: Pick<FanslyWireRequest, "url" | "credentialsGeneration"> | null = null,
): Promise<AdmissionRecord | null> {
  const spec = d.registry.spec(picked.work.resource);
  if (spec === null) throw new Error(`No registry entry for ${picked.work.resource}`);
  return inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update", live: true });
    // The final word of the page holds, under the row lock (ruling 5): the
    // gate and the pick judged a snapshot; a hold written since refuses
    // here, before anything is counted. The work stays open.
    const page = await getSyncPage(tx, d.pageId);
    if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
    const held = whyHeld(holdSetOf(page.holds), null, { operation: pageHoldOperationOf(picked.work, prepared) }, d.clock.wallNow());
    if (held !== null) throw new AdmissionHeldError(held.kind, held.until);
    const running = await markWorkRunning(tx, { workId: picked.work.id, generation: d.generation });
    if (running === null) return null;
    const admitted = await insertAdmission(tx, {
      pageId: d.pageId,
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
      request: requestJsonOf(request, prepared),
      evidence: spec.evidence,
      routeIntervalMs: intervals.routeIntervalMs,
      familyIntervalMs: intervals.familyIntervalMs,
    });
    // A requests-class read is the turn of one request and one fan: the round
    // robin's stamps and the fan's read count (history_* after sync_work).
    if (picked.requestTurn !== undefined && picked.requestTurn !== null) {
      await markHistoryTurnServed(tx, picked.requestTurn);
    }
    if (module.onAdmit !== undefined) await module.onAdmit(tx, picked.work, request);
    return {
      attemptId: admitted.attemptId,
      admittedAt: admitted.admittedAt,
      demandRevision: running.demandRevision,
      demand: running.demand,
      work: picked.work,
      workClass: picked.workClass,
      spec,
      request,
      credentialsGeneration: prepared?.credentialsGeneration ?? null,
    };
  });
}

/** Best effort right after `onRequestStart` (never awaited by the send): the
 *  send instant, so a takeover after a crash sees it. */
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
  d.metrics.increment("sync_send_refused", { reason: refusal });
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

// ── no-HTTP outcomes ────────────────────────────────────────────────────────

/** A plan that needs no request and writes nothing of its own: done, wait,
 *  quarantine (design §3.5) — at a slot, or before the HTTP gate (ruling 9).
 *  No slot is consumed. A `local` plan is `applyLocal`'s. */
export async function commitNoHttp(
  d: CommitDeps,
  work: SyncWorkRow,
  plan: Exclude<StepPlan, { kind: "request" | "local" }>,
): Promise<void> {
  const now = d.clock.wallNow();
  const spec = d.registry.spec(work.resource);
  const page = await getSyncPage(d.db, d.pageId);
  await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    switch (plan.kind) {
      case "done": {
        const settled = await settleWork(tx, settleInputOf(d, work, spec, {
          close: "done",
          closeReason: plan.reason,
          satisfiesRevision: true,
          ...(plan.cursor === undefined ? {} : { cursor: plan.cursor }),
          ...(plan.proof === undefined ? {} : { proof: plan.proof }),
          ...(plan.result === undefined ? {} : { result: plan.result }),
        }, work.demandRevision, page, now));
        await afterSettle(tx, d, work, settled, plan.reason);
        return;
      }
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

/**
 * A request whose route its budget or hold keeps closed (step 3b, plan PR
 * 1-1: the final check of the planned route): nothing is admitted or sent,
 * the slot stays open for other work, and the row is due again when the route
 * opens (`waiting_reason = 'pacer'`: it waits for its route's pace, not for
 * its schedule). A demand bump pulls it forward; its next plan meets the same
 * clocks.
 */
export async function deferForRoute(d: CommitDeps, work: SyncWorkRow, until: Date): Promise<void> {
  await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    await settleWork(tx, {
      workId: work.id,
      generation: d.generation,
      servedRevision: work.demandRevision,
      satisfiesRevision: false,
      nextDueAt: until,
      waitingReason: "pacer",
      waitingUntil: until,
    });
  });
}

/** A `local` step whose erasure fence is busy waits this long (an erasure in
 *  flight holds the fence for seconds). */
export const LOCAL_FENCE_BUSY_RETRY_MS = 1_000;

/** A `local` plan of a module that has no `applyLocal`: a module bug. */
export class LocalStepRefusedError extends Error {
  constructor(readonly resource: string, readonly why: string) {
    super(`Fansly sync: ${resource} planned a local write ${why}`);
    this.name = "LocalStepRefusedError";
  }
}

export type LocalOutcome = "applied" | "fence_busy" | "nothing" | ApplyErrorKind;

/**
 * Commit a `local` step (design §3.3 item 3, E6): ONE transaction —
 * `lockOwnedPage` (I7) → the erasure fence when the entry declares one (busy:
 * the work waits a second on `dependency`) → the module's `applyLocal` → the
 * work row (`settleWork`, I11 against the revision the plan read) → its
 * follow-ups → the work-closed hook (lock order of §3.7). Nothing is admitted
 * or sent: before the HTTP gate (ruling 9) no hold or slot is waited for, at a
 * slot the slot stays open. A failing write rolls back whole and is classified
 * like an apply error: retried (deferred, transient, other) or quarantined
 * (deterministic).
 */
export async function applyLocal(d: CommitDeps, work: SyncWorkRow, module: ResourceModule): Promise<LocalOutcome> {
  try {
    const write = module.applyLocal;
    if (write === undefined) throw new LocalStepRefusedError(work.resource, "but has no applyLocal");
    const spec = d.registry.spec(work.resource);
    if (spec === null) throw new ApplyDeferred("no_registry_entry");
    const settled = await inTx(d.db, async (tx): Promise<LocalOutcome> => {
      await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
      const now = d.clock.wallNow();
      if (spec.fence === "dm_archive" && !(await tryAcquireDmArchiveWriterFenceLock(tx, d.pageId))) {
        const until = new Date(now.getTime() + LOCAL_FENCE_BUSY_RETRY_MS);
        const busy = await settleWork(tx, {
          workId: work.id,
          generation: d.generation,
          servedRevision: work.demandRevision,
          satisfiesRevision: false,
          nextDueAt: until,
          waitingReason: "dependency",
          waitingUntil: until,
          lastErrorClass: "local:erasure_busy",
        });
        return busy === null ? "nothing" : "fence_busy";
      }
      const page = await getSyncPage(tx, d.pageId);
      if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
      const result = await write(tx, { pageId: d.pageId, work, now, ownRef: d.ownRef });
      const done = await settleWork(tx, {
        ...settleInputOf(d, work, spec, result.work, work.demandRevision, page, now),
        lastErrorClass: null,
      });
      if (done === null) throw new ApplyDeferred("work_not_open");
      const upserts = upsertsOf(d, result.followups, page, now);
      if (upserts.length > 0) await upsertDemands(tx, upserts);
      if (result.threadChainChanged !== undefined && d.onThreadChainChanged !== undefined) {
        await d.onThreadChainChanged(tx, { pageId: d.pageId, threadId: result.threadChainChanged.threadId });
      }
      await afterSettle(tx, d, work, done, result.work.closeReason ?? null);
      if (result.chatUnavailable !== undefined && d.onChatUnavailable !== undefined) {
        await d.onChatUnavailable(tx, { pageId: d.pageId, threadId: result.chatUnavailable.threadId });
      }
      for (const [name, by] of Object.entries(result.counters ?? {})) {
        d.metrics.increment("sync_apply_effect", { resource: work.resource, effect: name }, by);
      }
      return "applied";
    });
    if (settled === "fence_busy") d.metrics.increment("sync_local_fence_busy", { resource: work.resource });
    return settled;
  } catch (error) {
    if (error instanceof SyncCrashFault || error instanceof OwnershipLostError) throw error;
    return recordLocalError(d, work, error);
  }
}

/** A failed `local` step: the transaction rolled back; the work retries, or
 *  is quarantined when the same write would fail every time. A quarantine
 *  records why (`result.quarantine.detail`, as an apply's does); there is no
 *  attempt to name. */
async function recordLocalError(d: CommitDeps, work: SyncWorkRow, error: unknown): Promise<ApplyErrorKind> {
  const kind = error instanceof LocalStepRefusedError ? "other" : classifyApplyError(error);
  const name = errorName(error);
  const now = d.clock.wallNow();
  let quarantined = false;
  await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    if (kind === "deterministic") {
      quarantined = await quarantineWork(tx, {
        workId: work.id,
        generation: d.generation,
        errorClass: `local:${name}`,
        detail: applyErrorDetail(error),
        attemptId: null,
      });
      return;
    }
    const retryInMs = kind === "other"
      ? WAIT_RECHECK_MS
      : deferredRetryInMs(Math.max(0, now.getTime() - work.firstDemandAt.getTime()));
    const until = new Date(now.getTime() + retryInMs);
    await settleWork(tx, {
      workId: work.id,
      generation: d.generation,
      servedRevision: work.demandRevision,
      satisfiesRevision: false,
      nextDueAt: until,
      waitingReason: "dependency",
      waitingUntil: until,
      lastErrorClass: `local:${name}`,
    });
  });
  d.metrics.increment("sync_apply_errors", { kind, error: name, local: true });
  const log = kind === "transient" || kind === "deferred" ? d.logger.warn.bind(d.logger) : d.logger.error.bind(d.logger);
  log({ pageId: d.pageId, workId: work.id, resource: work.resource, kind, error: name, quarantined },
    "Fansly sync: a local step failed");
  if (quarantined) {
    await openAlerts(d, [{ subKey: "live_degraded", detail: "quarantined" }], { resource: work.resource, workId: work.id });
  }
  return kind;
}

// ── credentials (step-3 §3.5 item 3, G1/G2; step 3b ruling 5, A3) ───────────

/** The durable record of a quarantined verify closed because the credentials
 *  it verified are no longer stored (`ensureCredentialsVerify`). */
export const SYNC_CREDENTIALS_VERIFY_SUPERSEDED_AUDIT_EVENT = "sync.credentials_verify_superseded";

/** A quarantined verify `ensureCredentialsVerify` closed as superseded. */
interface SupersededVerify {
  workId: number;
  attemptId: number | null;
  /** The digest its last attempt carried (null: none journaled). */
  credentialsGeneration: string | null;
}

/**
 * The verify of the page's stored credentials, raised by the actor from what
 * the database says (never from memory): the stored digest (`storedDigest`,
 * read by the caller) is not the one the engine trusts (checks-only), or a
 * credentials hold admits the verify of changed credentials (A3). Created
 * only when the page has no open, running or quarantined verify of them — a
 * merge would bump a waiting one on every lap. One verify per digest: a
 * quarantined verify of OTHER credentials (its last attempt carried another
 * digest, or none) answers for nothing stored any more — it is closed as
 * superseded, with its audit row, in the same fenced transaction, and the
 * verify of the stored credentials is created. Kept, it would block every
 * later verify of the page (one row per key), and a credentials hold only
 * such a verify's proof clears would never end. A quarantined verify of the
 * stored digest stays (its answer is the owner's to re-apply). True: a new
 * verify was raised.
 */
export async function ensureCredentialsVerify(d: CommitDeps, reason: string, storedDigest: string | null): Promise<boolean> {
  const now = d.clock.wallNow();
  const raised = await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    const page = await getSyncPage(tx, d.pageId);
    const upserts = upsertsOf(d, [{ resource: VERIFY_KEY, demand: { reason } }], page, now)
      .map((upsert) => ({ ...upsert, createOnly: true }));
    if (upserts.length === 0) return { created: false, superseded: null };
    const superseded = storedDigest === null
      ? null
      : await supersedeQuarantinedVerify(tx, d, storedDigest);
    const created = (await upsertDemands(tx, upserts)).some((result) => result.created);
    return { created, superseded };
  });
  if (raised.superseded !== null) {
    d.metrics.increment("sync_credentials_verify_superseded", { pageId: d.pageId });
    d.logger.info({ pageId: d.pageId, ...raised.superseded },
      "Fansly sync: a quarantined verify of credentials no longer stored was superseded");
  }
  if (raised.created) d.metrics.increment("sync_credentials_verify_raised", { pageId: d.pageId, reason });
  return raised.created;
}

/** The page's quarantined verify, closed as superseded when its last attempt
 *  carried another digest than the stored one (`ensureCredentialsVerify`),
 *  with its audit row. Null: none, or one of the stored digest. */
async function supersedeQuarantinedVerify(
  tx: Database,
  d: CommitDeps,
  storedDigest: string,
): Promise<SupersededVerify | null> {
  const current = await getOpenWorkForKey(tx, { pageId: d.pageId, resource: VERIFY_KEY, subject: "" });
  if (current === null || current.state !== "quarantined") return null;
  const [work] = await lockWorkRows(tx, [current.id]);
  if (work === undefined || work.state !== "quarantined") return null;
  const attempt = work.lastAttemptId === null ? null : await getSyncAttempt(tx, work.lastAttemptId);
  const credentialsGeneration = attempt === null ? null : credentialsGenerationOfAttempt(attempt);
  if (credentialsGeneration === storedDigest) return null;
  const closed = await closeQuarantinedWork(tx, { workId: work.id, to: "superseded", closeReason: "credentials_changed" });
  if (!closed) return null;
  await insertAuditEvent(tx, {
    platformAccountId: d.pageId,
    source: "sync",
    eventType: SYNC_CREDENTIALS_VERIFY_SUPERSEDED_AUDIT_EVENT,
    metadata: {
      workId: work.id,
      attemptId: attempt?.id ?? null,
      quarantine: work.lastErrorClass,
      credentialsGeneration,
      storedCredentialsGeneration: storedDigest,
    },
  });
  return { workId: work.id, attemptId: attempt?.id ?? null, credentialsGeneration };
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

// ── tx 2: capture ───────────────────────────────────────────────────────────

export interface CaptureResult {
  /** A 2xx-ok answer was captured: apply it now (tx 3). */
  applyNow: boolean;
  /** The served answer and the contract's value, for the apply right after. */
  inMemory: { response: unknown; parsed: unknown } | null;
}

function pageErrorState(page: SyncPageRow, holds: HoldSet): PageErrorState {
  return {
    holds: holds.page,
    networkFailureStreak: page.networkFailureStreak,
    resourceHolds: holds.resources,
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
 * Capture an outcome (tx 2): the raw answer as an observation (2xx under
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
    ...(admission.spec.subjectScopedAuthStatuses === undefined
      ? {}
      : { subjectScopedAuthStatuses: admission.spec.subjectScopedAuthStatuses }),
  });
  const read: FanslyWireRead<unknown> | null = classified.read;
  const sent = armed.sentMono !== null;
  const durationMs = armed.sentMono === null ? null : d.clock.monoNow() - armed.sentMono;
  // A route that journals nothing (`capture`: the Upgrade, a CDN hop) writes
  // no observation, whatever it answered: its answer lives in memory until
  // the apply right after (design S3-04 item 3; owner decision №17).
  const journaled = wireSpec.kind === null || wireSpec.capture !== undefined ? null : wireSpec.kind;
  let observationPayload: { kind: string; payload: unknown } | null = null;
  if (outcome.kind === "response" && read !== null && journaled !== null) {
    observationPayload = read.kind === "accepted" || read.kind === "contract_violation"
      ? {
        kind: journaled,
        payload: (d.capture ?? defaultCaptureCodec).prepare({
          spec: admission.request.spec,
          kind: journaled,
          response: read.response,
          contractAccepted: read.kind === "accepted",
          request: admission.request,
          ownRef: d.ownRef,
          module,
        }),
      }
      : { kind: `${journaled}:failed`, payload: failedBody(outcome) };
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
    // The hold set as of this transaction (the page row is locked): a 429
    // holds and slows the route the request went out on.
    const holds = holdSetOf(page.holds);
    const routeState = holds.routes;
    const route = routeOfWireId(admission.request.spec);
    const decided = onOutcome({
      errorClass: classified.errorClass,
      now,
      resource: admission.work.resource,
      subject: admission.work.subject,
      httpStatus: classified.httpStatus,
      retryAfterMs: classified.retryAfterMs,
      page: pageErrorState(page, holds),
      ...(routeState.ok
        ? {
          route: {
            route,
            entry: routeState.state.routes[route] ?? null,
            attemptId: admission.attemptId,
            jitter: () => d.rng.next(),
          },
        }
        : {}),
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
          exemptKeys: [...RESOURCE_BREAKER_UNCOUNTED_KEYS],
        })
        : 0,
      requestCredentialsGeneration: admission.credentialsGeneration ?? null,
      attempt: { id: admission.attemptId, sentAt: armed.sentWall },
    });
    // The resource's own word on what this outcome means for it (a failed
    // WebSocket handshake belongs to the socket's reconnect ladder; Fansly's
    // own error envelope is an excluded chat's answer).
    const step = {
      request: admission.request,
      httpStatus: classified.httpStatus,
      outcome: outcome.kind,
      fanslyErrorEnvelope: (read?.kind === "http_error" || read?.kind === "envelope_unsuccessful") &&
        isFanslyErrorEnvelope(read.envelope),
    };
    let decision = module.outcome === undefined ? decided : module.outcome(decided, step);
    // Its transactional word (a chat's refusal → the chat-unavailability
    // episode), under a savepoint: what it cannot write is left out, the
    // capture never.
    let chatUnavailable: { threadId: number } | null = null;
    if (module.outcomeInCapture !== undefined) {
      const hook = module.outcomeInCapture;
      const hooked = await inSavepoint(tx, d, "outcome_in_capture", admission, (savepoint) => hook(savepoint, decision, {
        pageId: d.pageId,
        generation: d.generation,
        now,
        work: admission.work,
        attemptId: admission.attemptId,
        demandRevision: admission.demandRevision,
        demand: admission.demand,
        step,
        sent: outcome.kind === "response" || outcome.sent,
        sentAt: armed.sentWall ?? admission.admittedAt,
        observation,
      }));
      if (hooked !== null) {
        decision = hooked.decision;
        chatUnavailable = hooked.chatUnavailable ?? null;
      }
    }
    await writeOutcomeDecision(tx, d, {
      attemptId: admission.attemptId,
      work: admission.work,
      demandRevision: admission.demandRevision,
      subjectQueue: admission.spec.subjectQueue === true,
      request: admission.request,
      ...(read?.kind === "contract_violation"
        ? { quarantineDetail: { field: read.violation.field, detail: read.violation.detail } }
        : {}),
    }, decision, module);
    // history_* last (lock order): the chat's open fans that need its head.
    const onChatUnavailable = d.onChatUnavailable;
    if (chatUnavailable !== null && onChatUnavailable !== undefined) {
      const threadId = chatUnavailable.threadId;
      await inSavepoint(tx, d, "chat_unavailable", admission, (savepoint) =>
        onChatUnavailable(savepoint, { pageId: d.pageId, threadId }));
    }
    return { decision, paceGapMs: captured.paceGapMs };
  });

  if (committed.decision === null) return { applyNow: false, inMemory: null };
  const routeHold = committed.decision.routeHold;
  if (routeHold.action === "set") {
    d.metrics.increment("sync_route_held", {
      pageId: d.pageId,
      route: routeHold.route,
      status: classified.httpStatus ?? 0,
      resource: admission.work.resource,
    });
    d.logger.warn({
      pageId: d.pageId,
      route: routeHold.route,
      status: classified.httpStatus,
      retryAfterMs: classified.retryAfterMs,
      holdUntil: routeHold.holdUntil.toISOString(),
      effectivePerMin: routeHold.entry.effectivePerMin,
      ladderStep: routeHold.entry.ladderStep,
      attemptId: admission.attemptId,
    }, "Fansly sync: a route is held (only that route waits)");
  }
  const alerts = [...committed.decision.alerts];
  // "Проверка, а не вера" (plan §2.4, I1): this send against the page's
  // previous send by both clocks — this pacer's monotonic gap against its own
  // pause, and the recorded instants of ANY owner (`paceGapMs`) as the
  // independent test: closer than the setting whatever the pacer measured,
  // short of the pause when no monotonic gap vouches for the pair. A
  // violation opens alert 1 (the evaluator's send audit re-reads the journal
  // by the same rule, and reports the pairs whose clocks disagree).
  const pace = judgePaceGap({
    monoGapMs: armed.gapPrevMs,
    wallGapMs: committed.paceGapMs,
    pauseMs: armed.pauseMs,
    settingMs: armed.settingMs,
  });
  if (pace?.verdict === "fail") {
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

/**
 * Run a hook of the capture transaction under a savepoint: its writes commit
 * with the capture, or — when it throws (a thread an erasure deletes under it,
 * a lock it loses) — roll back alone, the capture goes on, and the failure is
 * counted and logged. Null: it failed. A test's crash fault and an ownership
 * loss are never swallowed.
 */
async function inSavepoint<T>(
  tx: Database,
  d: CommitDeps,
  hook: string,
  admission: Pick<AdmissionRecord, "attemptId" | "work">,
  body: (savepoint: Database) => Promise<T>,
): Promise<T | null> {
  try {
    return await tx.transaction((savepoint) => body(savepoint as unknown as Database));
  } catch (error) {
    if (error instanceof SyncCrashFault || error instanceof OwnershipLostError) throw error;
    d.metrics.increment("sync_capture_hook_failed", { resource: admission.work.resource, hook });
    d.logger.warn({
      pageId: d.pageId,
      attemptId: admission.attemptId,
      resource: admission.work.resource,
      hook,
      err: errorName(error),
    }, "Fansly sync: a capture hook failed; its writes rolled back, the capture is kept");
    return null;
  }
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
  /** What a quarantine of the work records as its detail (the contract
   *  violation's field, the apply's refusal). */
  quarantineDetail?: Readonly<Record<string, unknown>>;
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
    await setPageHold(tx, { ...fenced, kind: hold.kind, until: hold.until, detail: hold.detail });
  } else if (hold.action === "clear") {
    await clearPageHold(tx, { ...fenced, kinds: hold.kinds });
  }
  if (decision.networkFailureStreak !== null) {
    await setNetworkFailureStreak(tx, { ...fenced, streak: decision.networkFailureStreak });
  }
  const routeHold = decision.routeHold;
  if (routeHold.action === "set") {
    const { entry } = routeHold;
    const written = await writeSyncRouteState(tx, {
      ...fenced,
      route: routeHold.route,
      expectRevision: routeHold.expectRevision,
      entry: {
        holdUntil: entry.holdUntil === null ? null : new Date(entry.holdUntil),
        ladderStep: entry.ladderStep,
        effectivePerMin: entry.effectivePerMin,
        policyVersion: entry.policyVersion,
        last429AttemptId: entry.last429AttemptId,
        last429At: entry.last429At === null ? null : new Date(entry.last429At),
      },
    });
    // The state was read under this transaction's page lock: another writer
    // in between is a bug, never a race to paper over — the commit retries
    // from a fresh read.
    if (written.kind === "stale") throw new Error(`route state of ${routeHold.route} changed under the page lock`);
  }
  const resourceHold = decision.resourceHold;
  if (resourceHold.action === "set") {
    await setResourceHold(tx, { ...fenced, file: resourceHold.file, hold: { until: resourceHold.until, step: resourceHold.step } });
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
    // A breaker reset (an answer after failures) is an `ok`, never a failure.
    const breakerReset = !decision.subjectBreaker.terminal && decision.subjectBreaker.failureCount === 0;
    await module.onSubjectOutcome(tx, work, {
      kind: decision.subjectBreaker.terminal ? "terminal" : breakerReset ? "ok" : "failure",
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
      await quarantineWork(tx, {
        workId: work.id,
        generation: d.generation,
        errorClass: next.reason,
        detail: target.quarantineDetail ?? {},
        attemptId: target.attemptId,
      });
      return;
    case "close": {
      // A close may carry the resource's own result (a CDN 403 is the
      // describer's `http_status` failure), close with its demand unserved
      // (a chat Fansly stopped serving), and say how the row waits while a
      // newer demand keeps it open.
      const terminal = next.result === undefined ? {} : { result: next.result };
      const settled = await settleWork(tx, {
        workId: work.id,
        generation: d.generation,
        servedRevision: target.demandRevision,
        satisfiesRevision: next.satisfiesRevision !== false,
        close: "done",
        closeReason: next.closeReason,
        lastErrorClass: decision.attemptErrorClass,
        ...(next.dueAt === undefined ? {} : { nextDueAt: next.dueAt }),
        ...(next.waitingReason === undefined ? {} : { waitingReason: next.waitingReason }),
        ...(next.waitingUntil === undefined ? {} : { waitingUntil: next.waitingUntil }),
        ...terminal,
        ...(breaker === undefined ? {} : { breaker }),
      });
      await afterSettle(tx, d, work, settled, next.closeReason);
      return;
    }
  }
}

// ── tx 3: apply ─────────────────────────────────────────────────────────────

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

/** What a quarantined work records of the apply error that stopped it
 *  (`sync_work.result.quarantine.detail`): a resource's refusal and its own
 *  account, a contract violation's field — never a driver message, which may
 *  embed SQL and parameters. */
export function applyErrorDetail(error: unknown): Record<string, unknown> {
  for (const link of errorChain(error)) {
    if (link instanceof ApplyQuarantine) return { ...link.detail, refusal: link.reason };
    if (link instanceof FanslyContractViolationError) return { field: link.field, detail: link.detail };
  }
  return { error: errorName(error) };
}

/** When to try a deferred apply again, by the age of its answer. */
export function deferredRetryInMs(answerAgeMs: number): number {
  for (const step of DEFERRED_RETRY_LADDER) {
    if (answerAgeMs < step.ageBelowMs) return step.retryInMs;
  }
  return DEFERRED_RETRY_CAP_MS;
}

async function readJournalBody(
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

/** The routes whose answer is an identity proof of the page (`/account/me`:
 *  `account.*`, the followers reconcile's ends): their apply writes the proof
 *  and may clear a credentials hold, so it takes the page row FOR NO KEY
 *  UPDATE from its start — never an upgrade of a held FOR SHARE, which
 *  deadlocks with the heartbeat waiting on the row. */
export const IDENTITY_PROOF_OPERATIONS: readonly FanslyWireId[] = ["account.me"];

/**
 * Apply a captured answer (tx 3), from memory right after the capture or from
 * the journal after a restart (no HTTP, I8). Idempotent: an attempt that is no
 * longer `captured`/`deferred` is left alone. Every error is classified and
 * written in its own fenced transaction; only an ownership loss (foreign
 * generation) and a test crash leave this function by throwing. An identity
 * proof is written in this same transaction (ruling 5): a failure leaves the
 * attempt captured/deferred, and its stored answer is applied again — never
 * a new request.
 */
export async function apply(
  d: CommitDeps,
  target: { attemptId: number; operation: string },
  inMemory: { response: unknown; parsed: unknown } | null = null,
): Promise<ApplyOutcome> {
  const attemptId = target.attemptId;
  const lock = (IDENTITY_PROOF_OPERATIONS as readonly string[]).includes(target.operation) ? "no_key_update" : "share";
  try {
    const applied = await inTx(d.db, async (tx) => {
      await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock });
      const attempt = await lockAttemptForApply(tx, attemptId);
      if (attempt === null) return "nothing" as const;
      const spec = d.registry.spec(attempt.resource);
      if (spec === null) throw new ApplyDeferred("no_registry_entry");
      const module = await d.registry.module(attempt.resource);
      // A route that journals nothing is applied from memory or not at all
      // (`recordApplyError` skips it and the work is read again).
      const answerInMemory = isAnswerInMemory(attempt.operation);
      if (answerInMemory && inMemory === null) throw new ApplyDeferred("answer_not_in_memory");
      let fenced = false;
      if (spec.fence === "dm_archive") {
        if (!(await tryAcquireDmArchiveWriterFenceLock(tx, d.pageId))) throw new ApplyDeferred("erasure_busy");
        fenced = true;
      }
      if (attempt.workId === null) throw new ApplyDeferred("no_work");
      const work = await getSyncWork(tx, attempt.workId);
      if (work === null) throw new ApplyDeferred("work_missing");
      const request = requestOfAttempt(attempt);
      let result: ApplyResult;
      if (answerInMemory) {
        if (module.applyAnswer === undefined) throw new ApplyQuarantine("no_answer_apply", { resource: attempt.resource });
        await fault(d, "in_apply");
        const page = await getSyncPage(tx, d.pageId);
        if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
        result = await module.applyAnswer(tx, {
          pageId: d.pageId,
          now: d.clock.wallNow(),
          ownRef: d.ownRef,
          work,
          attempt,
          request,
          parsed: inMemory!.parsed,
          fenced,
          page,
          generation: d.generation,
          secrets: d.secrets ?? null,
        });
        return settleApplied(tx, d, { attempt, work, spec, page, result });
      }
      let response: unknown;
      let parsed: unknown;
      if (inMemory !== null) {
        ({ response, parsed } = inMemory);
      } else {
        // The journal holds the answer inside the envelopes its kind carries
        // (a reply page's walk, a tips answer's scope quarantine): the codec
        // takes them off before the same parse the capture ran.
        const wire = fanslyWireSpec(request.spec);
        response = (d.capture ?? defaultCaptureCodec).served({
          spec: request.spec,
          kind: wire.kind ?? request.spec,
          payload: await readJournalBody(tx, d, attempt),
          request,
        });
        const reparsed = wire.parse(response, request.params as never);
        if (!reparsed.ok) throw new FanslyContractViolationError(reparsed.violation.field, reparsed.violation.detail);
        parsed = reparsed.value;
      }
      await fault(d, "in_apply");
      // Read once: the module sees the page's overrides, the settle below
      // the same row (the page row is the actor's; no resource writes it).
      const page = await getSyncPage(tx, d.pageId);
      if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
      result = await module.apply(tx, {
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
        page,
        ...(d.settings === undefined ? {} : { settings: d.settings }),
      });
      if (d.canonicalize !== undefined && result.canonicalized !== true) {
        await d.canonicalize(tx, {
          pageId: d.pageId,
          ownRef: d.ownRef,
          observationId: attempt.observationId!,
          receivedAt: attempt.observationReceivedAt!,
        });
      }
      return settleApplied(tx, d, { attempt, work, spec, page, result });
    });
    if (applied === "nothing") return "nothing";
    for (const [name, by] of Object.entries(applied.counters ?? {})) {
      d.metrics.increment("sync_apply_effect", { resource: applied.resource, effect: name }, by);
    }
    if (applied.proof?.superseded === true) d.metrics.increment("sync_identity_proof_superseded", { pageId: d.pageId });
    if (applied.proof?.cleared != null) {
      d.metrics.increment("sync_credentials_hold_cleared", { pageId: d.pageId, kind: applied.proof.cleared });
      d.logger.info({ pageId: d.pageId, attemptId, kind: applied.proof.cleared },
        "Fansly sync: an identity proof sent after the latest refusal cleared the credentials hold");
    }
    return applied.outcome;
  } catch (error) {
    if (error instanceof SyncCrashFault || error instanceof OwnershipLostError) throw error;
    return recordApplyError(d, attemptId, error);
  }
}

/** The end of tx 3 every apply shares: the work row, then the follow-ups in
 *  (resource, subject) order, the history hooks (`history_*` last in the lock
 *  order), the attempt `applied`. */
async function settleApplied(
  tx: Database,
  d: CommitDeps,
  input: { attempt: SyncAttemptRow; work: SyncWorkRow; spec: EngineResourceSpec; page: SyncPageRow; result: ApplyResult },
) {
  const { attempt, work, spec, page, result } = input;
  const proof = result.pageIdentity === undefined
    ? null
    : await recordIdentityProof(tx, d, attempt, page, result.pageIdentity.accountId);
  // sync_work after every event append (lock order): the work row, then the
  // follow-ups in (resource, subject) order.
  const now = d.clock.wallNow();
  const settle = settleInputOf(d, work, spec, result.work, attempt.demandRevision ?? work.demandRevision, page, now);
  const breakerSet = work.failureCount !== 0 || work.breakerUntil !== null || work.blockedByVendorAt !== null;
  const settled = await settleWork(tx, {
    ...settle,
    lastErrorClass: null,
    ...(breakerSet && spec.subjectQueue !== true
      ? { breaker: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null } }
      : {}),
  });
  const upserts = upsertsOf(d, result.followups, page, now);
  if (upserts.length > 0) await upsertDemands(tx, upserts);
  // history_* last (lock order): the chain hook first (anchors, satisfied
  // fans, the work closed when none is left), then the fans of a work that
  // closed for another reason.
  if (result.threadChainChanged !== undefined && d.onThreadChainChanged !== undefined) {
    await d.onThreadChainChanged(tx, { pageId: d.pageId, threadId: result.threadChainChanged.threadId });
  }
  await afterSettle(tx, d, work, settled, result.work.closeReason ?? null);
  await markApplied(tx, { attemptId: attempt.id });
  return {
    outcome: "applied" as const,
    counters: result.counters ?? null,
    proof,
    resource: attempt.resource,
  };
}

/** The durable record of a credentials hold an identity proof cleared: the
 *  verifying attempt, the digest it proved and the refusal it cleared
 *  (`audit_events`, beside the page row's proof — ruling 5). */
export const SYNC_CREDENTIALS_HOLD_CLEARED_AUDIT_EVENT = "sync.credentials_hold_cleared";

/** What an identity proof wrote: the credentials hold it cleared (kind), and
 *  whether a newer proof was recorded already. */
interface IdentityProofWrite {
  cleared: string | null;
  superseded: boolean;
}

/**
 * The identity proof of an applied `/account/me` of the page's own account
 * (the identity guard is `updatePageMetadata` inside the apply), in the
 * apply's transaction (ruling 5): the page's identity and the digest of the
 * credentials that request carried — the engine has verified them (G1) —
 * unless a newer proof is recorded already; and a credentials hold whose
 * latest refusal came before this request was sent is cleared — a network
 * hold beside it stands — with its audit row naming the
 * verifying attempt and the refusal it cleared. Requires the page row FOR NO KEY
 * UPDATE (`IDENTITY_PROOF_OPERATIONS`).
 */
async function recordIdentityProof(
  tx: Database,
  d: CommitDeps,
  attempt: SyncAttemptRow,
  page: SyncPageRow,
  accountId: string,
): Promise<IdentityProofWrite> {
  if (!(IDENTITY_PROOF_OPERATIONS as readonly string[]).includes(attempt.operation)) {
    // Its apply held the page row FOR SHARE: never upgraded (see above).
    throw new ApplyQuarantine("identity_proof_route", { operation: attempt.operation });
  }
  const sentAt = attempt.sentAt ?? attempt.admittedAt;
  const recorded = await recordSyncPageIdentityProof(tx, {
    pageId: d.pageId,
    generation: d.generation,
    accountId,
    credentialsGeneration: credentialsGenerationOfAttempt(attempt),
    sentAt,
  });
  // `superseded`: an answer applied late — a newer proof stands; the hold
  // rule below still judges this one by its own send.
  const proof = { cleared: null, superseded: !recorded };
  const { credentials: held } = holdSetOf(page.holds).page;
  if (held === null || !proofClearsCredentialsHold(held, { attemptId: attempt.id, sentAt })) return proof;
  // The credentials hold alone: a network hold beside it stands until its end.
  await clearPageHold(tx, { pageId: d.pageId, generation: d.generation, kinds: [held.kind] });
  await insertAuditEvent(tx, {
    platformAccountId: d.pageId,
    source: "sync",
    eventType: SYNC_CREDENTIALS_HOLD_CLEARED_AUDIT_EVENT,
    metadata: {
      attemptId: attempt.id,
      resource: attempt.resource,
      sentAt: sentAt.toISOString(),
      credentialsGeneration: credentialsGenerationOfAttempt(attempt),
      cleared: {
        kind: held.kind,
        since: held.since?.toISOString() ?? null,
        failedAttemptId: held.failure.attemptId,
        failedAt: held.failure.at?.toISOString() ?? null,
        credentialsGeneration: held.failure.digest,
      },
    },
  });
  return { ...proof, cleared: held.kind };
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
    const answerInMemory = isAnswerInMemory(attempt.operation);
    if (answerInMemory && (kind === "deferred" || kind === "transient")) {
      // An answer that lived in memory only has nothing to be re-applied
      // from: the attempt is skipped and its work is read again, as a new
      // admission, once the retry delay passed.
      await skipAttemptApply(tx, { attemptId, error: name });
      if (attempt.workId !== null) {
        await settleWork(tx, {
          workId: attempt.workId,
          generation: d.generation,
          servedRevision: attempt.demandRevision ?? 0,
          satisfiesRevision: false,
          nextDueAt: new Date(now.getTime() + retryInMs),
          waitingReason: null,
          lastErrorClass: `apply:${name}`,
        });
      }
      return { quarantined: false, alerts: [] };
    }
    let quarantine = false;
    if (kind === "deferred" || kind === "transient") {
      const payloadGone = [...errorChain(error)].some((link) => isCapturePayloadUnavailable(link));
      if (payloadGone && answerAgeMs > PAYLOAD_UNAVAILABLE_QUARANTINE_MS) {
        quarantine = await markAttemptQuarantined(tx, { attemptId, error: `${SYNC_APPLY_ERROR_PAYLOAD_UNAVAILABLE}${name}` });
      } else {
        await markDeferred(tx, { attemptId, error: name, retryInMs });
      }
    } else {
      const recorded = await recordApplyFailure(tx, {
        attemptId,
        error: name,
        retryInMs,
        // An unexpected error of an in-memory answer cannot be retried from
        // the journal: it is quarantined at once, as a deterministic one.
        deterministic: kind === "deterministic" || answerInMemory,
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
        page: pageErrorState(page, holdSetOf(page.holds)),
        subjectState: {
          failureCount: work?.failureCount ?? 0,
          breakerUntil: work?.breakerUntil ?? null,
          blockedByVendorAt: work?.blockedByVendorAt ?? null,
        },
        subjectQueue,
        recentFailedSubjects: 0,
        requestCredentialsGeneration: credentialsGenerationOfAttempt(attempt),
        attempt: { id: attempt.id, sentAt: attempt.sentAt },
      });
      // The decision has no subject breaker, so no module hook is needed.
      await writeOutcomeDecision(tx, d, {
        attemptId,
        work,
        demandRevision: attempt.demandRevision ?? work?.demandRevision ?? 0,
        subjectQueue,
        request: requestOfAttempt(attempt),
        quarantineDetail: applyErrorDetail(error),
      }, decision, null);
      return { quarantined: true, alerts: decision.alerts };
    }
    if (scope === "resource_writer") {
      // Another writer owns this page's ledger: the file waits on the
      // resource-hold ladder instead of failing every one of its works.
      const page = await getSyncPage(tx, d.pageId);
      if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
      const hold = escalateResourceHold(holdSetOf(page.holds).resources, attempt.resource, now);
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
      await quarantineWork(tx, {
        workId: attempt.workId,
        generation: d.generation,
        errorClass: `apply:${name}`,
        detail: applyErrorDetail(error),
        attemptId,
      });
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

/** Apply the captured/deferred attempts whose retry time passed, at most
 *  `max` per lap; never waits for one (a failing apply never blocks the page). */
export async function drainDueApplies(d: CommitDeps, max: number): Promise<number> {
  const due = await listUnfinishedAttempts(d.db, { pageId: d.pageId, phase: "apply", dueOnly: true, limit: max });
  let applied = 0;
  for (const attempt of due) {
    if ((await apply(d, { attemptId: attempt.id, operation: attempt.operation })) === "applied") applied += 1;
  }
  return applied;
}

// ── recovery ────────────────────────────────────────────────────────────────

/**
 * Recovery at actor start (design §3.7.5), under the new generation: unfinished
 * attempts become `unknown` (the read is repeated as a new attempt; the
 * takeover floor covers a possible send), running work without a pending
 * apply opens again, and pending applies are due now (applied by
 * `drainDueApplies` before any admission).
 */
export async function recoverUnfinished(d: CommitDeps): Promise<RecoverUnfinishedAttemptsResult> {
  return inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    return recoverUnfinishedAttempts(tx, { pageId: d.pageId, answerInMemoryOperations: ANSWER_IN_MEMORY_OPERATIONS });
  });
}

// ── alerts ──────────────────────────────────────────────────────────────────

/** Open the decided alerts; the sink decides what pages the owner. Never
 *  throws. */
export async function openAlerts(
  d: CommitDeps,
  alerts: readonly AlertDecision[],
  context: Record<string, unknown> = {},
): Promise<void> {
  for (const alert of alerts) {
    const route = alert.subKey === "route_limited" ? { route: alert.route } : {};
    d.metrics.increment("sync_alerts", { subKey: alert.subKey, detail: alert.detail, ...route });
    try {
      await d.alerts.open({
        subKey: alert.subKey,
        pageId: d.pageId,
        ...route,
        detail: alert.detail,
        context,
      });
    } catch (error) {
      d.logger.warn({ pageId: d.pageId, subKey: alert.subKey, err: errorName(error) }, "Fansly sync: alert could not be opened");
    }
  }
}
