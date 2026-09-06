type SubscribersCursorState = {
  revision: number;
  generation: number;
  mode: "active" | "expired";
  historyBackfilledAt: string | null;
  offset: number;
  observedCount: number;
  pageCount: number;
  providerReportedTotal: number | null;
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
type DmConversationCursorState = {
  version: 2;
  mode: "full_scan";
  generation: number;
  offset: number;
  observedCount: number;
  pageCount: number;
  providerTotalMode: "unobserved" | "absent" | "present";
  providerReportedTotal: number | null;
  unchangedPageStreak: number;
  fullSweepStartedAt: string;
  lastFullSweepCompletedAt: string | null;
};

type DmMessagesCursorState = {
  version: 1;
  currentConversationId: number | null;
  currentPlatformConversationId: string | null;
  currentBeforeMessageId: string | null;
  currentMode: "backfill" | "deep_backfill" | "incremental" | null;
  liveMessageRequestsSinceDeepBackfill?: number;
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

type TopSpendersCursorWindow = {
  kind: "month" | "week" | "day";
  monthKey: string;
  startedAt: string;
  endedAt: string;
};

type TopSpendersCursorState = {
  version: 1;
  mode: "bootstrap" | "steady_state";
  accountCreatedAt: string;
  totalMonths: number;
  completedMonths: number;
  pendingWindows: TopSpendersCursorWindow[];
  lastWindowStartedAt: string | null;
  lastWindowEndedAt: string | null;
};

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableNumber(value: unknown) {
  return value === null ? null : asNumber(value);
}

function asNullableString(value: unknown) {
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
  const pageCount = asNumber(state.pageCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  if (
    generation === null ||
    mode === null ||
    offset === null ||
    observedCount === null ||
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
    pageCount,
    providerReportedTotal,
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

  return {
    version: 1,
    currentConversationId,
    currentPlatformConversationId,
    currentBeforeMessageId,
    currentMode,
    ...(liveMessageRequestsSinceDeepBackfill > 0
      ? { liveMessageRequestsSinceDeepBackfill: Math.floor(liveMessageRequestsSinceDeepBackfill) }
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

export function parseTopSpendersCursorState(value: unknown): TopSpendersCursorState | null {
  const state = asRecord(value);
  if (!state || asNumber(state.version) !== 1) {
    return null;
  }

  const mode = state.mode === "bootstrap" || state.mode === "steady_state"
    ? state.mode
    : null;
  const accountCreatedAt = asNullableString(state.accountCreatedAt);
  const totalMonths = asNumber(state.totalMonths);
  const completedMonths = asNumber(state.completedMonths);
  const lastWindowStartedAt = asNullableString(state.lastWindowStartedAt);
  const lastWindowEndedAt = asNullableString(state.lastWindowEndedAt);
  const rawPendingWindows = Array.isArray(state.pendingWindows) ? state.pendingWindows : null;

  if (
    mode === null ||
    !accountCreatedAt ||
    totalMonths === null ||
    completedMonths === null ||
    lastWindowStartedAt === undefined ||
    lastWindowEndedAt === undefined ||
    rawPendingWindows === null
  ) {
    return null;
  }

  const pendingWindows = rawPendingWindows.flatMap((window) => {
    const record = asRecord(window);
    if (!record) {
      return [];
    }

    const kind = record.kind === "month" || record.kind === "week" || record.kind === "day"
      ? record.kind
      : null;
    const monthKey = asNullableString(record.monthKey);
    const startedAt = asNullableString(record.startedAt);
    const endedAt = asNullableString(record.endedAt);
    if (!kind || !monthKey || !startedAt || !endedAt) {
      return [];
    }

    return [{ kind, monthKey, startedAt, endedAt } satisfies TopSpendersCursorWindow];
  });

  if (pendingWindows.length !== rawPendingWindows.length) {
    return null;
  }

  return {
    version: 1,
    mode,
    accountCreatedAt,
    totalMonths,
    completedMonths,
    pendingWindows,
    lastWindowStartedAt,
    lastWindowEndedAt,
  };
}

export type {
  DmConversationCursorState,
  DmMessagesCursorState,
  FollowersCursorState,
  FollowersReconcileCursorState,
  FollowersReconcileProgressState,
  OfapiDmConversationCursorState,
  SubscribersCursorState,
  TopSpendersCursorState,
  TopSpendersCursorWindow,
};
