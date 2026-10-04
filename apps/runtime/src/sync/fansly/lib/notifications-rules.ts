import { FANSLY_NOTIFICATION_DECLARED_TYPE_CODES, FANSLY_NOTIFICATION_TYPE_GROUPS } from "@agency_hub_core/shared";

import { classifyFanslyResponse } from "./lane.ts";

// The notifications rules of the Sync Engine's `notifications.*` resources
// (resources/notifications.ts): the `type` filter forms, and the reads of a
// served page (its rows, its walkable id bounds, the overlap stop). Pure.

/** Which `type` form the lane is issuing. Durable, because a provider that
 *  refuses the unfiltered form refuses it on every chunk. */
export type FanslyNotificationsFilterMode = "unfiltered" | "declared_csv" | "type_groups";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
