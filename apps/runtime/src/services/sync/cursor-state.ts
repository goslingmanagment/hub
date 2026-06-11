type SubscribersCursorState = {
  revision: number;
  generation: number;
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
  offset: number;
  observedCount: number;
  pageCount: number;
  sourceFollowerCount: number;
};

type DmConversationCursorState = {
  version: 1;
  mode: "full_scan";
  generation: number;
  offset: number;
  pageCount: number;
  providerReportedTotal: number | null;
  unchangedPageStreak: number;
  fullSweepStartedAt: string;
  lastFullSweepCompletedAt: string | null;
  snapshotConversationIds?: string[];
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
  sweepStartedAt: string | null;
  lastSweepCompletedAt: string | null;
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
  const offset = asNumber(state.offset);
  const observedCount = asNumber(state.observedCount) ?? offset;
  const pageCount = asNumber(state.pageCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  if (
    generation === null ||
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

export function parseFollowersReconcileCursorState(
  value: unknown,
  revision: number | null | undefined,
): FollowersReconcileCursorState | null {
  const expectedRevision = parseRevision(revision);
  if (expectedRevision === null) {
    return null;
  }

  const state = asRecord(value);
  if (!state || asNumber(state.revision) !== expectedRevision) {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const observedCount = asNumber(state.observedCount) ?? offset;
  const pageCount = asNumber(state.pageCount);
  const sourceFollowerCount = asNumber(state.sourceFollowerCount);
  if (
    generation === null ||
    offset === null ||
    observedCount === null ||
    pageCount === null ||
    sourceFollowerCount === null
  ) {
    return null;
  }

  return {
    revision: expectedRevision,
    generation,
    offset,
    observedCount,
    pageCount,
    sourceFollowerCount,
  };
}

export function parseDmConversationCursorState(value: unknown): DmConversationCursorState | null {
  const state = asRecord(value);
  if (!state || asNumber(state.version) !== 1 || state.mode !== "full_scan") {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  const unchangedPageStreak = asNumber(state.unchangedPageStreak);
  const fullSweepStartedAt = asNullableString(state.fullSweepStartedAt);
  const lastFullSweepCompletedAt = asNullableString(state.lastFullSweepCompletedAt);
  const snapshotConversationIds = asOptionalStringArray(state.snapshotConversationIds);
  if (
    generation === null ||
    offset === null ||
    pageCount === null ||
    providerReportedTotal === undefined ||
    unchangedPageStreak === null ||
    !fullSweepStartedAt ||
    snapshotConversationIds === null
  ) {
    return null;
  }

  return {
    version: 1,
    mode: "full_scan",
    generation,
    offset,
    pageCount,
    providerReportedTotal,
    unchangedPageStreak,
    fullSweepStartedAt,
    lastFullSweepCompletedAt,
    ...(snapshotConversationIds ? { snapshotConversationIds } : {}),
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
    sweepStartedAt,
    lastSweepCompletedAt,
  };
}

export function emptyOfapiAudienceCursorState(): OfapiAudienceCursorState {
  return {
    version: 1,
    mode: "ofapi_audience",
    generation: 0,
    offset: 0,
    pageCount: 0,
    sweepStartedAt: null,
    lastSweepCompletedAt: null,
  };
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
  OfapiDmConversationCursorState,
  SubscribersCursorState,
  TopSpendersCursorState,
  TopSpendersCursorWindow,
};
