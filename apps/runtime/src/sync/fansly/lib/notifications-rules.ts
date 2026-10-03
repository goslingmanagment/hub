import { FANSLY_NOTIFICATION_DECLARED_TYPE_CODES, FANSLY_NOTIFICATION_TYPE_GROUPS } from "@agency_hub_core/shared";

import { classifyFanslyResponse } from "./lane.ts";

// The notifications rules of the Sync Engine's `notifications.*` resources
// (resources/notifications.ts): the `notifications` cursor, the `type` filter
// forms, and the reads of a served page (its rows, its walkable id bounds, the
// overlap stop). Pure.

/** The head of the list. The UI's own first call sends exactly this. */
const HEAD_CURSOR = "0";

// ── cursor state ─────────────────────────────────────────────────────────────

/** Which `type` form the lane is issuing. Durable, because a provider that
 *  refuses the unfiltered form refuses it on every chunk. */
export type FanslyNotificationsFilterMode = "unfiltered" | "declared_csv" | "type_groups";

interface ForwardWalkState {
  /** `before` for the next forward call; null = start at the head. */
  beforeRef: string | null;
  /** The newest id of THIS poll's first page. Committed to
   *  `newestSeenNotificationId` only when the walk reaches overlap or runs out
   *  — an early commit would skip whatever sits between here and the overlap. */
  pendingHeadRef: string | null;
  /** Repeat-request guard: the `before` the previous forward call carried. */
  lastRequestedBefore: string | null;
  pages: number;
}

interface BackfillWalkState {
  /** `before` for the next backfill call. Starts at the head. */
  nextBeforeRef: string;
  /** Repeat-request guard. Same `before` twice ⇒ the walk is looping. */
  lastRequestedBefore: string | null;
  /** ISO instant of the OLDEST notification the provider ever served —
   *  `notificationFloorAt`. */
  floorAt: string | null;
  /** The observation that journaled this walk's last response, so a terminal
   *  coverage row points at the bytes that prove it. */
  lastObservationId: number | null;
  done: boolean;
}

export interface FanslyNotificationsCursorState {
  version: 1;
  /** Which phase the NEXT dispatch resumes in. */
  phase: "forward" | "backfill";
  /** The UTC day `callsToday` belongs to; a different day resets the counter. */
  utcDay: string;
  /** HTTP ATTEMPTS spent by this lane on `utcDay`. Retries included. */
  callsToday: number;
  /**
   * The BACKFILL'S OWN share of `callsToday`, same UTC day, retries included.
   *
   * Its own counter because the head always spends first (the cursor starts in
   * `forward`, and a due head poll interrupts a running backfill), so measuring
   * the backfill's ceiling against the lane-wide counter let the head consume
   * the backfill's whole allowance: at any cap ≤ 61 the walk got zero calls per
   * day, forever, with no anomaly. The reserve is about the HEAD's share, so
   * the thing it bounds has to be the BACKFILL's spend.
   */
  backfillCallsToday: number;
  /** The overlap stop for the forward poll. */
  newestSeenNotificationId: string | null;
  /** ISO instant of the last completed forward poll. */
  lastForwardPollAt: string | null;
  filterMode: FanslyNotificationsFilterMode;
  /** Next group to issue while `filterMode === "type_groups"`. */
  typeGroupIndex: number;
  /** The one-time "is the unfiltered form actually serving rows?" probe. */
  unfilteredProbeSpent: boolean;
  /**
   * Consecutive type-form REFUSALS, durable across chunks.
   *
   * It has to survive a chunk boundary for the same reason WP-F1's window
   * guard does: the loop that burned a day's cap on production spanned five
   * chunks, so a counter that lived inside one chunk would have watched it
   * happen five times and said nothing. Reset to 0 by any served call.
   */
  filterRefusals: number;
  /** The `post_likes` negative-coverage row has been written for this page. It
   *  is a standing claim, not a per-chunk one. */
  postLikesCoverageWritten: boolean;
  forward: ForwardWalkState;
  /** null once the one-off deep backfill has finished. */
  backfill: BackfillWalkState | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseFilterMode(value: unknown): FanslyNotificationsFilterMode {
  return value === "declared_csv" || value === "type_groups" ? value : "unfiltered";
}

function parseForwardWalk(value: unknown): ForwardWalkState {
  const record = asRecord(value);
  return {
    beforeRef: asNullableString(record?.beforeRef),
    pendingHeadRef: asNullableString(record?.pendingHeadRef),
    lastRequestedBefore: asNullableString(record?.lastRequestedBefore),
    pages: Math.max(0, asInt(record?.pages, 0)),
  };
}

function parseBackfillWalk(value: unknown): BackfillWalkState | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  return {
    nextBeforeRef: asNullableString(record.nextBeforeRef) ?? HEAD_CURSOR,
    lastRequestedBefore: asNullableString(record.lastRequestedBefore),
    floorAt: asNullableString(record.floorAt),
    lastObservationId: typeof record.lastObservationId === "number"
        && Number.isSafeInteger(record.lastObservationId)
      ? record.lastObservationId
      : null,
    done: record.done === true,
  };
}

export function parseFanslyNotificationsCursorState(
  value: unknown,
): FanslyNotificationsCursorState | null {
  const state = asRecord(value);
  if (!state || state.version !== 1) {
    return null;
  }
  const utcDay = asNullableString(state.utcDay);
  if (utcDay === null) {
    return null;
  }
  return {
    version: 1,
    phase: state.phase === "backfill" ? "backfill" : "forward",
    utcDay,
    callsToday: Math.max(0, asInt(state.callsToday, 0)),
    // A cursor written before this field existed reads as "the backfill has
    // spent nothing today", which is the safe default: the UTC day it belongs
    // to is the one being resumed and the lane-wide cap still bounds it.
    backfillCallsToday: Math.max(0, asInt(state.backfillCallsToday, 0)),
    newestSeenNotificationId: asNullableString(state.newestSeenNotificationId),
    lastForwardPollAt: asNullableString(state.lastForwardPollAt),
    filterMode: parseFilterMode(state.filterMode),
    typeGroupIndex: Math.max(0, asInt(state.typeGroupIndex, 0)),
    unfilteredProbeSpent: state.unfilteredProbeSpent === true,
    filterRefusals: Math.max(0, asInt(state.filterRefusals, 0)),
    postLikesCoverageWritten: state.postLikesCoverageWritten === true,
    forward: parseForwardWalk(state.forward),
    backfill: Object.hasOwn(state, "backfill") && state.backfill === null
      ? null
      : parseBackfillWalk(state.backfill) ?? emptyBackfillWalk(),
  };
}

function emptyBackfillWalk(): BackfillWalkState {
  return {
    nextBeforeRef: HEAD_CURSOR,
    lastRequestedBefore: null,
    floorAt: null,
    lastObservationId: null,
    done: false,
  };
}

// ── shape helpers over the journaled bodies ──────────────────────────────────

/** The notification rows of a response, or `[]`. The rest of the envelope
 *  (tips, accountMedia, subscriptions, …) is journaled and parsed elsewhere. */
export function notificationRows(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  if (record === null) {
    return [];
  }
  return Array.isArray(record.notifications)
    ? record.notifications.filter((row): row is Record<string, unknown> => asRecord(row) !== null)
    : [];
}

/** The id a notification row is walked by — the one `pageRefBounds` reads. */
function notificationRef(row: Record<string, unknown>): string | null {
  return asNullableString(row.id) ?? asNullableString(row.idString);
}

/**
 * Valid when `notifications` is an array that is either empty or carries at
 * least ONE row with a usable id. A non-empty page with none — `[null]`, rows
 * whose id key drifted — used to read as empty, and in the backfill an empty
 * page is the archive's FLOOR: a durable `provider_exhausted` claim from a body
 * nothing can walk. One odd row among good ones stays tolerated per row.
 */
export function classifyNotificationResponse(payload: unknown) {
  return classifyFanslyResponse(payload, {
    isValid: (value) => {
      const record = asRecord(value);
      if (record === null || !Array.isArray(record.notifications)) {
        return false;
      }
      return record.notifications.length === 0
        || notificationRows(value).some((row) => notificationRef(row) !== null);
    },
    isEmpty: (value) => notificationRows(value).length === 0,
  });
}

/**
 * Snowflake ids sort lexicographically WITHIN one length, so compare length
 * first. Returns < 0 when `left` is older.
 *
 * This is the same comparison WP-F1 uses for the broadcast walk, extracted
 * because the forward poll's overlap test and the backfill's cursor both need
 * it and a second, subtly different copy is how a walk starts skipping pages.
 */
export function compareNotificationRefs(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The newest and oldest walkable ids of a page. */
export function pageRefBounds(
  rows: readonly Record<string, unknown>[],
): { newest: string | null; oldest: string | null } {
  let newest: string | null = null;
  let oldest: string | null = null;
  for (const row of rows) {
    const id = notificationRef(row);
    if (id === null) {
      continue;
    }
    if (newest === null || compareNotificationRefs(id, newest) > 0) {
      newest = id;
    }
    if (oldest === null || compareNotificationRefs(id, oldest) < 0) {
      oldest = id;
    }
  }
  return { newest, oldest };
}

/** The oldest `createdAt` on the page, as an ISO instant. Fansly serves
 *  notification timestamps in SECONDS. */
export function oldestCreatedAtIso(rows: readonly Record<string, unknown>[]): string | null {
  let oldest: number | null = null;
  for (const row of rows) {
    const created = row.createdAt;
    if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) {
      continue;
    }
    oldest = oldest === null || created < oldest ? created : oldest;
  }
  return oldest === null ? null : new Date(oldest * 1000).toISOString();
}

/** True when the page carries a row at or older than the overlap stop. */
export function pageReachesOverlap(
  rows: readonly Record<string, unknown>[],
  newestSeen: string,
): boolean {
  for (const row of rows) {
    const id = asNullableString(row.id) ?? asNullableString(row.idString);
    if (id !== null && compareNotificationRefs(id, newestSeen) <= 0) {
      return true;
    }
  }
  return false;
}

/** The `types` argument for a filter mode. `null` is the unfiltered form. */
export function typesForFilterMode(
  mode: FanslyNotificationsFilterMode,
  groupIndex: number,
): readonly number[] | null {
  if (mode === "unfiltered") {
    return null;
  }
  if (mode === "declared_csv") {
    return FANSLY_NOTIFICATION_DECLARED_TYPE_CODES;
  }
  const group = FANSLY_NOTIFICATION_TYPE_GROUPS[
    groupIndex % FANSLY_NOTIFICATION_TYPE_GROUPS.length
  ];
  return group ?? FANSLY_NOTIFICATION_DECLARED_TYPE_CODES;
}
