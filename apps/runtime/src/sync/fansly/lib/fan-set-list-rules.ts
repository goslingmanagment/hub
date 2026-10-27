import type { SyncAttemptRow } from "@agency_hub_core/db";
import { FANSLY_LIST_WRITE_BATCH_MAX } from "@agency_hub_core/fansly";

import type { FanListServed } from "./fan-lists-rules.ts";

// Fan set lists (2026-10-28): the pure rules of `fan-set-lists.sync`, the
// Fansly user list Hub keeps equal to a set of fans (the cross-page spenders
// of services/cross-page-spenders.ts). The resource is
// ../resources/fan-set-lists.ts. Answers as the test model's own session got
// them on 2026-10-28 (packages/fansly/src/wire/publish.ts):
//
//   POST /lists              → { accountId, type: 1, label, id }
//   POST /lists/items/add    → [{ id, listId, type, metadata }] one per account
//   POST /lists/items/remove → [ id, … ] the ids sent

/** How often the plan looks at the setting while nothing is due: a change
 *  of it starts a sync within this. */
export const FAN_SET_LIST_RECHECK_MS = 10 * 60_000;
/** A list in sync is walked and compared again this long after. */
export const FAN_SET_LIST_EVERY_MS = 6 * 3_600_000;
/** A sync cut short (a write that failed or may have gone, a list it could
 *  not tell) starts again this long after: the next one re-reads everything
 *  and recomputes the diff, never re-sends what it cut short at. */
export const FAN_SET_LIST_AFTER_CUT_MS = 3_600_000;
/** A sync older than this is dropped and started over: its diff is stale. */
export const FAN_SET_LIST_CYCLE_MAX_MS = 2 * 3_600_000;
/** Pages of the list a walk reads at most (100 members a page). */
export const FAN_SET_LIST_MAX_PAGES = 50;
/** Removals a sync makes in any case: a small list's churn. More than this,
 *  and more than half the list, is withheld (the guard). */
export const FAN_SET_LIST_FREE_REMOVALS = 3;
/** How long a plan waits for its write's answer to be applied. */
export const FAN_SET_LIST_AWAIT_MS = 5_000;
/** How often a sync whose next write the page's browser cannot take now
 *  looks again (until the sync is too old and is dropped). */
export const FAN_SET_LIST_TRANSPORT_RECHECK_MS = 60_000;

/** The hub's list among the page's lists. */
export type HubListResolution =
  | { kind: "found"; listRef: string; itemCount: number | null }
  | { kind: "absent" }
  /** Several lists carry the label and none is the one Hub stored: Hub
   *  never guesses which is its own. */
  | { kind: "ambiguous"; listRefs: string[] };

/**
 * The page's list Hub keeps: the one it stored (created or found before)
 * while it is still there and was made under this label; else the one list
 * whose label is exactly this one (a create whose answer was lost made it).
 * A list Hub did not make under its label is never its own.
 */
export function resolveHubList(
  lists: readonly FanListServed[],
  stored: { listRef: string; label: string } | null,
  label: string,
): HubListResolution {
  if (stored !== null && stored.label === label) {
    const kept = lists.find((list) => list.listRef === stored.listRef);
    if (kept !== undefined) return { kind: "found", listRef: kept.listRef, itemCount: kept.itemCount };
  }
  const named = lists.filter((list) => list.label.trim() === label);
  if (named.length === 1) return { kind: "found", listRef: named[0]!.listRef, itemCount: named[0]!.itemCount };
  if (named.length > 1) return { kind: "ambiguous", listRefs: named.map((list) => list.listRef) };
  return { kind: "absent" };
}

/** One write of a sync: accounts added to the list, or removed from it. */
export interface FanSetListWrite {
  op: "add" | "remove";
  accountIds: string[];
}

export interface FanSetListDiff {
  /** The set's accounts not in the list, in the set's order. */
  toAdd: string[];
  /** The list's accounts not in the set, in the list's order (all of them,
   *  withheld or not). */
  toRemove: string[];
  /** Why the removals are withheld; null: they go. */
  withheld: "set_empty" | "removes_over_half" | null;
  /** The writes, adds first, each at most FANSLY_LIST_WRITE_BATCH_MAX accounts. */
  writes: FanSetListWrite[];
}

function batches(op: FanSetListWrite["op"], ids: readonly string[], size: number): FanSetListWrite[] {
  const writes: FanSetListWrite[] = [];
  for (let at = 0; at < ids.length; at += size) writes.push({ op, accountIds: ids.slice(at, at + size) });
  return writes;
}

/**
 * The writes that make the list the set. `ignored`: accounts of the set no
 * write is about (a fan the page's account lookup no longer returns: nothing
 * reaches him anyway): never added, never removed. The guard: a set that
 * came back empty while the list is not, or more than half the list to
 * remove (beyond FAN_SET_LIST_FREE_REMOVALS), withholds every removal (a
 * broken audience walk never empties the list), and the adds still go.
 */
export function diffFanSetList(input: {
  members: readonly string[];
  set: readonly string[];
  ignored?: readonly string[];
  batch?: number;
}): FanSetListDiff {
  const batch = input.batch ?? FANSLY_LIST_WRITE_BATCH_MAX;
  const members = [...new Set(input.members)];
  const inList = new Set(members);
  const set = [...new Set(input.set)];
  const inSet = new Set(set);
  const ignored = new Set(input.ignored ?? []);
  const toAdd = set.filter((id) => !inList.has(id) && !ignored.has(id));
  const toRemove = members.filter((id) => !inSet.has(id) && !ignored.has(id));
  let withheld: FanSetListDiff["withheld"] = null;
  if (toRemove.length > 0) {
    if (set.length === 0) withheld = "set_empty";
    else if (toRemove.length > FAN_SET_LIST_FREE_REMOVALS && toRemove.length * 2 > members.length) withheld = "removes_over_half";
  }
  return {
    toAdd,
    toRemove,
    withheld,
    writes: [...batches("add", toAdd, batch), ...(withheld === null ? batches("remove", toRemove, batch) : [])],
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === "string" && /^\d{1,30}$/.test(value) ? value : null;
}

/** The created list's id, or null when the answer names none. */
export function readListCreateAnswer(response: unknown): string | null {
  return idOf(recordOf(response)?.id);
}

/**
 * How many of the accounts sent the answer of a write names, or null when it
 * is not the route's answer: an add answers one item per account of this
 * list, a remove the ids themselves. An account it does not name is left to
 * the next sync's walk.
 */
export function readListWriteAnswer(write: FanSetListWrite, listRef: string, response: unknown): number | null {
  if (!Array.isArray(response)) return null;
  const named = new Set<string>();
  for (const item of response) {
    if (write.op === "add") {
      const row = recordOf(item);
      const id = idOf(row?.id);
      if (row === null || id === null || (row.listId !== undefined && idOf(row.listId) !== listRef)) return null;
      named.add(id);
    } else {
      const id = idOf(item);
      if (id === null) return null;
      named.add(id);
    }
  }
  return write.accountIds.filter((id) => named.has(id)).length;
}

/** What became of a write's one attempt, as the plan reads it. */
export type WriteAttemptVerdict =
  | { kind: "pending" }
  /** It never left, may have left, or was answered with an error: the sync
   *  ends here, and the write is never sent again (the next sync re-reads). */
  | { kind: "ended"; reason: string };

export function writeAttemptVerdict(
  attempt: Pick<SyncAttemptRow, "outcome" | "applyState" | "errorClass" | "httpStatus">,
): WriteAttemptVerdict {
  switch (attempt.outcome) {
    case "admitted":
    case "sent":
      return { kind: "pending" };
    case "response":
      if (attempt.applyState === "captured" || attempt.applyState === "deferred") return { kind: "pending" };
      // An applied answer moved the cursor past its write: one that did not
      // (applied, yet the row still stands at it) is no answer to go on from.
      return { kind: "ended", reason: attempt.applyState === "applied" ? "write_applied_cursor_behind" : `write_failed:${attempt.httpStatus ?? "none"}` };
    case "aborted_before_send":
      return { kind: "ended", reason: `write_not_sent:${attempt.errorClass ?? "aborted_before_send"}` };
    default:
      // A transport error or a timeout after the send, an attempt recovered
      // `unknown` after a crash: it may have gone.
      return { kind: "ended", reason: `write_unknown:${attempt.outcome}` };
  }
}

/** When the next sync of a page is due: at once for a list never synced or
 *  a setting that changed, else after the last one (sooner after a cut). */
export function nextFanSetListSyncAt(
  last: { endedAt: string; outcome: "synced" | "cut"; settingsKey: string } | null,
  settingsKey: string,
  now: Date,
): Date {
  if (last === null || last.settingsKey !== settingsKey) return now;
  const ended = Date.parse(last.endedAt);
  if (!Number.isFinite(ended)) return now;
  return new Date(ended + (last.outcome === "synced" ? FAN_SET_LIST_EVERY_MS : FAN_SET_LIST_AFTER_CUT_MS));
}
