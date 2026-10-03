import { parseDmFullSweepSchedule, type DmFullSweepSchedule } from "./dm-bounded-state.ts";
import { parseDmShadowState, type DmShadowState } from "./dm-shadow-state.ts";

type SubscribersCursorState = {
  revision: number;
  generation: number;
  mode: "active" | "expired";
  historyBackfilledAt: string | null;
  offset: number;
  observedCount: number;
  /** Distinct subscription ids summed per page: the generation rows a
   * multi-page walk must find before it retires unseen subscriptions. */
  distinctObservedCount: number;
  pageCount: number;
  providerReportedTotal: number | null;
  /** Restarts of this walk after its provider total shifted or its pages overlapped. */
  restartCount: number;
  /** When this active walk began: taken again right before each read until
   * the walk has written a page, so a retried or yielded first read is judged
   * by its own start, not a failed attempt's. Finalization spares every row
   * touched since (Audit P-25), and an empty snapshot vouches only for
   * subscriptions that had lapsed by then. Null on a cursor written before
   * the fence existed; execution never finalizes an active walk without one. */
  walkStartedAt: string | null;
  /** Why this revision's active walk retired nothing past the restart bound;
   * the history walk carries it so the revision's completion records it. */
  activeWithheldReason?: string;
  /** Why this history walk cannot certify the archive past the restart bound;
   * the walk still reads on to its last page. */
  historyWithheldReason?: string;
};

type FollowersCursorState = {
  revision: number;
  knownFollowId: string | null;
  newestFollowId: string | null;
  offset: number;
  pageCount: number;
  sourceFollowerCount: number;
};

type FollowersReconcileCursorState = {
  revision: number;
  generation: number;
  fullSweepStartedAt: string;
  offset: number;
  observedCount: number;
  pageCount: number;
  sourceFollowerCount: number;
  snapshotRestartCount: number;
  restartReason: "snapshot_mismatch" | null;
  verificationPending: boolean;
};

type FollowersReconcileProgressState = Omit<
  FollowersReconcileCursorState,
  "fullSweepStartedAt"
> & {
  fullSweepStartedAt: string | null;
};

/**
 * G3 (checkpoint cutover): scalars only. Version 1 carried
 * `snapshotConversationIds` — every group id the sweep had seen, rewritten in
 * full on every page (O(N²) bytes across a sweep, the top storage writer
 * measured on 2026-08-11). Membership now lives row-side in
 * `page_dm_threads.last_seen_generation`, which G2 slice 1 made monotonic and
 * G2 slice 2 proved equal to the array in production; `observedCount` is the
 * persisted count the sweep maintains against it.
 */
type DmConversationProviderTotalMode = "unobserved" | "absent" | "present";

type DmConversationCursorState = {
  version: 2;
  mode: "full_scan";
  generation: number;
  offset: number;
  observedCount: number;
  pageCount: number;
  providerTotalMode: DmConversationProviderTotalMode;
  providerReportedTotal: number | null;
  unchangedPageStreak: number;
  fullSweepStartedAt: string;
  lastFullSweepCompletedAt: string | null;
  /** Consecutive non-final pages whose every id an earlier page of this sweep
   *  already applied. Persisted only while positive, so a document without it
   *  is byte-identical to the one every earlier writer produced. */
  repeatOnlyPageStreak?: number;
  diagnostics?: DmShadowState;
  polling?: DmFullSweepSchedule;
};

type DmMessagesCursorState = {
  version: 1;
  currentConversationId: number | null;
  currentPlatformConversationId: string | null;
  currentBeforeMessageId: string | null;
  currentMode: "backfill" | "deep_backfill" | "incremental" | null;
  liveMessageRequestsSinceDeepBackfill?: number;
  headCatchup?: { messageId: string; startedAt: string; pagesRead: number; overlapReached?: boolean };
  /** An earlier page of this conversation's walk left a message unstored; the
   * walk's final coverage verdict must not be 'complete'. */
  normalizationDebt?: true;
  /** ISO dispatch time of this walk's head page (before = null). Finalize
   * stamps it as last_message_sync_at; a walk without it (from a stored
   * cursor, or checkpointed before the field existed) leaves that alone. */
  headReadAt?: string;
  /** Pages this first read has walked past the 25-message start window
   * because the thread's history began after the page's DM onboarding;
   * bounded by PAGE_DM_NEW_THREAD_EXTRA_HISTORY_PAGES across chunks. */
  newThreadHistoryPages?: number;
};

// OFAPI-fed OnlyFans dm_conversations checkpoint (mode "ofapi" keeps it
// distinct from the OnlyMonster/Fansly full_scan shape): bootstrap walks the
// chats list by offset once; afterwards page-1 reconciles run on an interval.
type OfapiDmConversationCursorState = {
  version: 1;
  mode: "ofapi";
  offset: number;
  pageCount: number;
  bootstrapCompletedAt: string | null;
  lastReconcileAt: string | null;
};

// OFAPI-fed OnlyFans subscribers checkpoint (docs/ofapi-parity-plan.md Phase 3):
// full fans/active offset sweeps on an interval; generation drives the Fansly-
// style end-of-sweep expiry of subscriptions missing from the sweep.
type OfapiAudienceCursorState = {
  version: 1;
  mode: "ofapi_audience";
  generation: number;
  offset: number;
  pageCount: number;
  observedFans: number;
  sweepStartedAt: string | null;
  lastSweepCompletedAt: string | null;
  lastSweepUnverifiedAt: string | null;
};

// The raw checkpoint-record readers. Exported because a handler that opens a
// FRESH sweep still has to read a couple of fields straight off the stored
// record (the parser refused it, so there is no typed state to read them from)
// — one definition, here, next to the shapes they read.
export function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableNumber(value: unknown) {
  return value === null ? null : asNumber(value);
}

export function asNullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : null;
}

function asOptionalStringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : null;
}

function parseRevision(revision: number | null | undefined) {
  return typeof revision === "number" && Number.isFinite(revision) ? revision : null;
}

export function parseSubscribersCursorState(
  value: unknown,
  revision: number | null | undefined,
): SubscribersCursorState | null {
  const expectedRevision = parseRevision(revision);
  if (expectedRevision === null) {
    return null;
  }

  const state = asRecord(value);
  if (!state || asNumber(state.revision) !== expectedRevision) {
    return null;
  }

  const generation = asNumber(state.generation);
  const mode = state.mode === undefined
    ? "active"
    : state.mode === "active" || state.mode === "expired"
      ? state.mode
      : null;
  const historyBackfilledAt = typeof state.historyBackfilledAt === "string"
    ? state.historyBackfilledAt
    : null;
  const offset = asNumber(state.offset);
  const observedCount = asNumber(state.observedCount) ?? offset;
  const distinctObservedCount = asNumber(state.distinctObservedCount) ?? observedCount;
  const pageCount = asNumber(state.pageCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  const restartCount = asNumber(state.restartCount) ?? 0;
  const walkStartedAt = typeof state.walkStartedAt === "string"
    && Number.isFinite(Date.parse(state.walkStartedAt))
    ? state.walkStartedAt
    : null;
  const activeWithheldReason = typeof state.activeWithheldReason === "string"
    ? state.activeWithheldReason
    : undefined;
  const historyWithheldReason = typeof state.historyWithheldReason === "string"
    ? state.historyWithheldReason
    : undefined;
  if (
    generation === null ||
    mode === null ||
    offset === null ||
    observedCount === null ||
    distinctObservedCount === null ||
    pageCount === null ||
    providerReportedTotal === undefined
  ) {
    return null;
  }

  return {
    revision: expectedRevision,
    generation,
    mode,
    historyBackfilledAt,
    offset,
    observedCount,
    distinctObservedCount,
    pageCount,
    providerReportedTotal,
    restartCount,
    walkStartedAt,
    ...(activeWithheldReason === undefined ? {} : { activeWithheldReason }),
    ...(historyWithheldReason === undefined ? {} : { historyWithheldReason }),
  };
}

export function parseFollowersCursorState(
  value: unknown,
  revision: number | null | undefined,
): FollowersCursorState | null {
  const expectedRevision = parseRevision(revision);
  if (expectedRevision === null) {
    return null;
  }

  const state = asRecord(value);
  if (!state || asNumber(state.revision) !== expectedRevision) {
    return null;
  }

  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const sourceFollowerCount = asNumber(state.sourceFollowerCount);
  const knownFollowId = asNullableString(state.knownFollowId);
  const newestFollowId = asNullableString(state.newestFollowId);
  if (
    offset === null ||
    pageCount === null ||
    sourceFollowerCount === null ||
    knownFollowId === undefined ||
    newestFollowId === undefined
  ) {
    return null;
  }

  return {
    revision: expectedRevision,
    knownFollowId,
    newestFollowId,
    offset,
    pageCount,
    sourceFollowerCount,
  };
}

export function parseFollowersReconcileProgressState(
  value: unknown,
  revision: number | null | undefined,
): FollowersReconcileProgressState | null {
  const expectedRevision = parseRevision(revision);
  if (expectedRevision === null) {
    return null;
  }

  const state = asRecord(value);
  if (!state || asNumber(state.revision) !== expectedRevision) {
    return null;
  }

  const generation = asNumber(state.generation);
  const fullSweepStartedAt = typeof state.fullSweepStartedAt === "string"
    && Number.isFinite(Date.parse(state.fullSweepStartedAt))
    ? state.fullSweepStartedAt
    : null;
  const offset = asNumber(state.offset);
  const observedCount = asNumber(state.observedCount) ?? offset;
  const pageCount = asNumber(state.pageCount);
  const sourceFollowerCount = asNumber(state.sourceFollowerCount);
  const restartReason = state.restartReason === "snapshot_mismatch"
    ? state.restartReason
    : null;
  // Counts from older completed checkpoints were lifetime-shaped. Only a
  // cursor explicitly scoped to the active mismatch may consume this
  // revision's bounded restart allowance.
  const snapshotRestartCount = restartReason === "snapshot_mismatch"
    ? asNumber(state.snapshotRestartCount) ?? 0
    : 0;
  const verificationPending = state.verificationPending === true;
  if (
    generation === null ||
    offset === null ||
    observedCount === null ||
    pageCount === null ||
    sourceFollowerCount === null ||
    snapshotRestartCount < 0
  ) {
    return null;
  }

  return {
    revision: expectedRevision,
    generation,
    fullSweepStartedAt,
    offset,
    observedCount,
    pageCount,
    sourceFollowerCount,
    snapshotRestartCount,
    restartReason,
    verificationPending,
  };
}

/** Execution must never resume a legacy sweep that predates the retirement
 * time fence. Read-only progress consumers may still display its counters via
 * parseFollowersReconcileProgressState without fabricating a start time. */
export function parseFollowersReconcileCursorState(
  value: unknown,
  revision: number | null | undefined,
): FollowersReconcileCursorState | null {
  const state = parseFollowersReconcileProgressState(value, revision);
  if (!state?.fullSweepStartedAt) {
    return null;
  }

  return {
    ...state,
    fullSweepStartedAt: state.fullSweepStartedAt,
  };
}

/**
 * Accepts BOTH stored shapes and always returns the v2 one.
 *
 * v1 → v2 migration on load: the sweep read its observed count back out of
 * `snapshotConversationIds.length` on every resume, so adopting that length
 * makes a migrated cursor resume with exactly the count the pre-G3 binary
 * would have computed. The array is then dropped and never written again.
 *
 * A v1 state that carries NEITHER the array NOR a persisted `observedCount`
 * parses with a zero count, which is a lie about a sweep already in flight —
 * isUnresumableLegacyDmConversationCursorState flags exactly that record and
 * the handler restarts the sweep before the zero can reach a decision, which
 * is what the retired legacy-snapshot guard did with the missing array.
 */
export function parseDmConversationCursorState(value: unknown): DmConversationCursorState | null {
  const state = asRecord(value);
  const version = asNumber(state?.version);
  if (!state || (version !== 1 && version !== 2) || state.mode !== "full_scan") {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  const unchangedPageStreak = asNumber(state.unchangedPageStreak);
  const fullSweepStartedAt = asNullableString(state.fullSweepStartedAt);
  const lastFullSweepCompletedAt = asNullableString(state.lastFullSweepCompletedAt);
  const snapshotConversationIds = version === 1
    ? asOptionalStringArray(state.snapshotConversationIds)
    : undefined;
  // v2 must carry the count — it is the whole reason the array could go. v1 may
  // fall back to zero because the handler refuses such a cursor outright.
  const observedCount = version === 1
    ? snapshotConversationIds?.length ?? asNumber(state.observedCount) ?? 0
    : asNumber(state.observedCount);
  if (
    generation === null ||
    offset === null ||
    pageCount === null ||
    providerReportedTotal === undefined ||
    unchangedPageStreak === null ||
    !fullSweepStartedAt ||
    snapshotConversationIds === null ||
    observedCount === null ||
    observedCount < 0
  ) {
    return null;
  }

  const providerTotalMode = state.providerTotalMode === "unobserved" ||
      state.providerTotalMode === "absent" || state.providerTotalMode === "present"
    ? state.providerTotalMode
    : providerReportedTotal !== null
      ? "present"
      : pageCount > 0
        ? "absent"
        : "unobserved";
  if (
    (providerTotalMode === "present" && providerReportedTotal === null) ||
    (providerTotalMode !== "present" && providerReportedTotal !== null) ||
    (providerTotalMode === "unobserved" && pageCount !== 0)
  ) {
    return null;
  }

  const diagnostics = parseDmShadowState(state.diagnostics);
  const polling = parseDmFullSweepSchedule(state.polling);
  // A garbled streak reads as none: it can only let one more repeat-only page
  // through before the guard counts again, never refuse a healthy cursor.
  const repeatOnlyPageStreak = asNumber(state.repeatOnlyPageStreak);
  return {
    version: 2,
    mode: "full_scan",
    generation,
    offset,
    observedCount,
    pageCount,
    providerTotalMode,
    providerReportedTotal,
    unchangedPageStreak,
    fullSweepStartedAt,
    lastFullSweepCompletedAt,
    ...(repeatOnlyPageStreak !== null && Number.isSafeInteger(repeatOnlyPageStreak) && repeatOnlyPageStreak > 0
      ? { repeatOnlyPageStreak }
      : {}),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(polling === undefined ? {} : { polling }),
  };
}

/**
 * A stored in-progress sweep from before either count representation existed:
 * version 1, no id array, no `observedCount`. Resuming it would restart the
 * count at zero mid-sweep, so the sweep restarts from offset 0 under a fresh
 * generation instead (loudly — the anomaly is the operator's signal), which is
 * what the retired legacy-snapshot guard did. Deliberately narrow: every OTHER
 * reason the parser refuses a record already meant a silent fresh sweep before
 * G3, and still does.
 */
export function isUnresumableLegacyDmConversationCursorState(value: unknown) {
  const state = asRecord(value);
  if (!state || state.mode !== "full_scan" || asNumber(state.version) !== 1) {
    return false;
  }

  return asOptionalStringArray(state.snapshotConversationIds) === undefined &&
    asNumber(state.observedCount) === null;
}

/**
 * The dm_conversations sweep as the HANDLER holds it: one tagged union over the
 * two documents this stream persists. The tag lives in memory ONLY — the JSON
 * in `page_sync_cursors.state` is unchanged to the byte, because a rolled-back
 * binary parses that JSON with the pre-union reader and an added or renamed key
 * would strand it (the `mode`-presence test below is exactly what the old
 * reader keys off).
 *
 *   in_progress — `mode: "full_scan"`, a resumable cursor;
 *   completed   — no `mode` at all, which is what makes the next chunk open a
 *                 FRESH sweep under a higher generation instead of resuming a
 *                 finished one.
 *
 * `unchangedPageStreak` stays in the persisted in-progress document as it
 * always was, even though nothing reads it back yet.
 */
type DmConversationSweepInProgressState = {
  kind: "in_progress";
  generation: number;
  offset: number;
  observedCount: number;
  pageCount: number;
  providerTotalMode: DmConversationProviderTotalMode;
  providerReportedTotal: number | null;
  unchangedPageStreak: number;
  fullSweepStartedAt: string;
  lastFullSweepCompletedAt: string | null;
  repeatOnlyPageStreak?: number;
  diagnostics?: DmShadowState;
  polling?: DmFullSweepSchedule;
};

type DmConversationSweepCompletedState = {
  kind: "completed";
  generation: number;
  observedCount: number;
  generationSetCount: number;
  providerTotalMode: DmConversationProviderTotalMode;
  providerReportedTotal: number | null;
  destructiveFinalization: boolean;
  membershipCertified: boolean;
  /** Serialized ONLY when non-null — the completed document omits the key
   *  entirely otherwise, which is what it has always done. */
  erasureDelta: number | null;
  lastFullSweepCompletedAt: string | null;
  diagnostics?: DmShadowState;
  polling?: DmFullSweepSchedule;
};

type DmConversationSweepState =
  | DmConversationSweepInProgressState
  | DmConversationSweepCompletedState;

function parseCompletedDmConversationSweepState(
  value: unknown,
): DmConversationSweepCompletedState | null {
  const state = asRecord(value);
  // No `mode` — not "some other mode": an unknown mode is a shape this codec
  // does not know, and guessing at it is how a sweep resumes a cursor that
  // means something else.
  if (!state || asNumber(state.version) !== 2 || state.mode !== undefined) {
    return null;
  }

  const generation = asNumber(state.generation);
  const observedCount = asNumber(state.observedCount);
  const generationSetCount = asNumber(state.generationSetCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  const lastFullSweepCompletedAt = asNullableString(state.lastFullSweepCompletedAt);
  const providerTotalMode = state.providerTotalMode === "unobserved" ||
      state.providerTotalMode === "absent" || state.providerTotalMode === "present"
    ? state.providerTotalMode
    : null;
  const erasureDelta = state.erasureDelta === undefined ? null : asNumber(state.erasureDelta);
  if (
    generation === null ||
    observedCount === null ||
    generationSetCount === null ||
    providerTotalMode === null ||
    (providerReportedTotal === null && state.providerReportedTotal !== null) ||
    typeof state.destructiveFinalization !== "boolean" ||
    typeof state.membershipCertified !== "boolean" ||
    (state.erasureDelta !== undefined && erasureDelta === null)
  ) {
    return null;
  }

  const diagnostics = parseDmShadowState(state.diagnostics);
  const polling = parseDmFullSweepSchedule(state.polling);
  return {
    kind: "completed",
    generation,
    observedCount,
    generationSetCount,
    providerTotalMode,
    providerReportedTotal,
    destructiveFinalization: state.destructiveFinalization,
    membershipCertified: state.membershipCertified,
    erasureDelta,
    lastFullSweepCompletedAt,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(polling === undefined ? {} : { polling }),
  };
}

/**
 * Parses BOTH persisted forms. The in-progress arm delegates to
 * parseDmConversationCursorState, so the v1 → v2 migration and every refusal it
 * encodes apply unchanged; only when that returns null is the completed shape
 * tried. A record that is neither (an unknown `mode`, a version this codec does
 * not know, a missing count) is null — the caller's fresh-sweep path.
 */
export function parseDmConversationSweepState(value: unknown): DmConversationSweepState | null {
  const inProgress = parseDmConversationCursorState(value);
  if (inProgress) {
    const { version: _version, mode: _mode, ...rest } = inProgress;
    return { kind: "in_progress", ...rest };
  }

  return parseCompletedDmConversationSweepState(value);
}

/**
 * The inverse: the exact JSON document each form has always written.
 *
 * `generationSetCount` on an in-progress write is TELEMETRY, not cursor state —
 * the mid-sweep progress write rides it along so summarizeCheckpoint can carry
 * it into the bounded projection, and parseDmConversationCursorState drops it on
 * resume. It is a parameter rather than a union field for that reason: the two
 * checkpoint writes that open a sweep (fresh init, restart) do not carry one,
 * and must keep not carrying one.
 */
export function serializeDmConversationSweepState(
  state: DmConversationSweepState,
  telemetry?: { generationSetCount: number },
): Record<string, unknown> {
  if (state.kind === "completed") {
    return {
      version: 2,
      generation: state.generation,
      observedCount: state.observedCount,
      generationSetCount: state.generationSetCount,
      providerTotalMode: state.providerTotalMode,
      providerReportedTotal: state.providerReportedTotal,
      destructiveFinalization: state.destructiveFinalization,
      membershipCertified: state.membershipCertified,
      lastFullSweepCompletedAt: state.lastFullSweepCompletedAt,
      ...(state.erasureDelta === null ? {} : { erasureDelta: state.erasureDelta }),
      ...(state.diagnostics === undefined ? {} : { diagnostics: state.diagnostics }),
      ...(state.polling === undefined ? {} : { polling: state.polling }),
    };
  }

  return {
    version: 2,
    mode: "full_scan",
    generation: state.generation,
    offset: state.offset,
    observedCount: state.observedCount,
    pageCount: state.pageCount,
    providerTotalMode: state.providerTotalMode,
    providerReportedTotal: state.providerReportedTotal,
    unchangedPageStreak: state.unchangedPageStreak,
    fullSweepStartedAt: state.fullSweepStartedAt,
    lastFullSweepCompletedAt: state.lastFullSweepCompletedAt,
    ...(state.repeatOnlyPageStreak ? { repeatOnlyPageStreak: state.repeatOnlyPageStreak } : {}),
    ...(telemetry === undefined ? {} : { generationSetCount: telemetry.generationSetCount }),
    ...(state.diagnostics === undefined ? {} : { diagnostics: state.diagnostics }),
    ...(state.polling === undefined ? {} : { polling: state.polling }),
  };
}

export function parseOfapiDmConversationCursorState(value: unknown): OfapiDmConversationCursorState | null {
  const state = asRecord(value);
  if (!state || asNumber(state.version) !== 1 || state.mode !== "ofapi") {
    return null;
  }

  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const bootstrapCompletedAt = asNullableString(state.bootstrapCompletedAt);
  const lastReconcileAt = asNullableString(state.lastReconcileAt);
  if (
    offset === null ||
    pageCount === null ||
    bootstrapCompletedAt === undefined ||
    lastReconcileAt === undefined
  ) {
    return null;
  }

  return {
    version: 1,
    mode: "ofapi",
    offset,
    pageCount,
    bootstrapCompletedAt,
    lastReconcileAt,
  };
}

export function emptyOfapiDmConversationCursorState(): OfapiDmConversationCursorState {
  return {
    version: 1,
    mode: "ofapi",
    offset: 0,
    pageCount: 0,
    bootstrapCompletedAt: null,
    lastReconcileAt: null,
  };
}

export function parseOfapiAudienceCursorState(value: unknown): OfapiAudienceCursorState | null {
  const state = asRecord(value);
  if (!state || asNumber(state.version) !== 1 || state.mode !== "ofapi_audience") {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const sweepStartedAt = asNullableString(state.sweepStartedAt);
  const lastSweepCompletedAt = asNullableString(state.lastSweepCompletedAt);
  if (
    generation === null ||
    offset === null ||
    pageCount === null ||
    sweepStartedAt === undefined ||
    lastSweepCompletedAt === undefined
  ) {
    return null;
  }

  return {
    version: 1,
    mode: "ofapi_audience",
    generation,
    offset,
    pageCount,
    observedFans: asNumber(state.observedFans) ?? 0,
    sweepStartedAt,
    lastSweepCompletedAt,
    lastSweepUnverifiedAt: asNullableString(state.lastSweepUnverifiedAt) ?? null,
  };
}

export function emptyOfapiAudienceCursorState(): OfapiAudienceCursorState {
  return {
    version: 1,
    mode: "ofapi_audience",
    generation: 0,
    offset: 0,
    pageCount: 0,
    observedFans: 0,
    sweepStartedAt: null,
    lastSweepCompletedAt: null,
    lastSweepUnverifiedAt: null,
  };
}

export const OFAPI_AUDIENCE_EMPTY_SWEEP_HOLD = "subscribers_empty_sweep_guard";

/** The checkpoint survives unrelated completions and lost-lease run records. */
export function ofapiAudienceQualityHoldFor(value: unknown): string | null {
  return parseOfapiAudienceCursorState(value)?.lastSweepUnverifiedAt
    ? OFAPI_AUDIENCE_EMPTY_SWEEP_HOLD
    : null;
}

export function parseDmMessagesCursorState(value: unknown): DmMessagesCursorState | null {
  const state = asRecord(value);
  if (!state || asNumber(state.version) !== 1) {
    return null;
  }

  const currentConversationId = state.currentConversationId === null
    ? null
    : asNumber(state.currentConversationId);
  const currentPlatformConversationId = asNullableString(state.currentPlatformConversationId);
  const currentBeforeMessageId = asNullableString(state.currentBeforeMessageId);
  const rawLiveMessageRequestsSinceDeepBackfill = state.liveMessageRequestsSinceDeepBackfill;
  const liveMessageRequestsSinceDeepBackfill = rawLiveMessageRequestsSinceDeepBackfill === undefined ||
      rawLiveMessageRequestsSinceDeepBackfill === null
    ? 0
    : asNumber(rawLiveMessageRequestsSinceDeepBackfill);
  const currentMode = state.currentMode === "backfill" ||
    state.currentMode === "deep_backfill" ||
    state.currentMode === "incremental"
    ? state.currentMode
    : state.currentMode === null || state.currentMode === undefined
      ? null
      : undefined;

  if (
    currentConversationId === undefined ||
    currentPlatformConversationId === undefined ||
    currentBeforeMessageId === undefined ||
    liveMessageRequestsSinceDeepBackfill === null ||
    currentMode === undefined
  ) {
    return null;
  }

  const headCatchup = asRecord(state.headCatchup);
  if (state.headCatchup !== undefined && (
    !headCatchup || typeof headCatchup.messageId !== "string" || !headCatchup.messageId ||
    typeof headCatchup.startedAt !== "string" || !Number.isFinite(Date.parse(headCatchup.startedAt)) ||
    typeof headCatchup.pagesRead !== "number" || !Number.isInteger(headCatchup.pagesRead) ||
    headCatchup.pagesRead < 0 || headCatchup.pagesRead >= 5 ||
    (currentMode !== "incremental" && currentMode !== "backfill")
  )) return null;

  return {
    ...(headCatchup ? { headCatchup: {
      messageId: headCatchup.messageId as string,
      startedAt: headCatchup.startedAt as string,
      pagesRead: headCatchup.pagesRead as number,
      ...(headCatchup.overlapReached === true ? { overlapReached: true } : {}),
    } } : {}),
    version: 1,
    currentConversationId,
    currentPlatformConversationId,
    currentBeforeMessageId,
    currentMode,
    ...(liveMessageRequestsSinceDeepBackfill > 0
      ? { liveMessageRequestsSinceDeepBackfill: Math.floor(liveMessageRequestsSinceDeepBackfill) }
      : {}),
    ...(state.normalizationDebt === true ? { normalizationDebt: true } : {}),
    // Unparseable means unknown: preserve last_message_sync_at, never "now".
    ...(typeof state.headReadAt === "string" && Number.isFinite(Date.parse(state.headReadAt))
      ? { headReadAt: state.headReadAt }
      : {}),
    ...(typeof state.newThreadHistoryPages === "number" && Number.isSafeInteger(state.newThreadHistoryPages) &&
        state.newThreadHistoryPages > 0
      ? { newThreadHistoryPages: state.newThreadHistoryPages }
      : {}),
  };
}

export function emptyDmMessagesCursorState(): DmMessagesCursorState {
  return {
    version: 1,
    currentConversationId: null,
    currentPlatformConversationId: null,
    currentBeforeMessageId: null,
    currentMode: null,
  };
}

export type {
  DmConversationCursorState,
  DmConversationProviderTotalMode,
  DmConversationSweepCompletedState,
  DmConversationSweepInProgressState,
  DmConversationSweepState,
  DmMessagesCursorState,
  FollowersCursorState,
  FollowersReconcileCursorState,
  FollowersReconcileProgressState,
  OfapiDmConversationCursorState,
  SubscribersCursorState,
};
