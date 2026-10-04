
// The checkpoint documents of the legacy page-sync executor's OnlyFans
// streams. (The Fansly lanes' cursor shapes, and the status readers' parsers of
// them, went at step 4: the Fansly Sync Engine keeps its cursors on its work
// rows.)

// OFAPI-fed OnlyFans dm_conversations checkpoint (mode "ofapi" keeps it
// distinct from the retired full_scan shape): bootstrap walks the chats list
// by offset once; afterwards page-1 reconciles run on an interval.
type OfapiDmConversationCursorState = {
  version: 1;
  mode: "ofapi";
  offset: number;
  pageCount: number;
  bootstrapCompletedAt: string | null;
  lastReconcileAt: string | null;
};

// OFAPI-fed OnlyFans subscribers checkpoint (docs/ofapi-parity-plan.md Phase 3):
// full fans/active offset sweeps on an interval; generation drives the
// end-of-sweep expiry of subscriptions missing from the sweep.
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

export function asNullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : null;
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

export type {
  OfapiDmConversationCursorState,
};
