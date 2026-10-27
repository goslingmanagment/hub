import {
  finishPageFanListWalk,
  maxPageFanListGeneration,
  upsertPageFanListMembers,
  upsertPageFanLists,
  type Database,
} from "@agency_hub_core/db";

import { ApplyQuarantine } from "../../engine/commit.ts";
import type { ApplyInput, ApplyResult, RequestPlan, ResourceModule, StepPlan } from "../../engine/resource.ts";
import { upsertHydratedFansForPage } from "../lib/fan-hydration.ts";
import {
  FAN_LIST_MAX_PAGES,
  fanListsToWalk,
  parseFanListItemsAnswer,
  parseFanListsAnswer,
} from "../lib/fan-lists-rules.ts";
import { lookupFollowups, partitionLookupIds } from "./fan-profiles.ts";

// `fan-lists.poll` (fan marks, 2026-10-27): the page's Fansly user lists every
// 6 hours, for the «💩 Бомж» mark in the chat header. One request a step, the
// position in the poll row's cursor (as `catalog.fixed`):
//
// 1. `/lists/account`: every list of the page with its label and count —
//    stored (page_fan_lists), the lists it no longer names inactive. The walk
//    takes a generation above every one the page used.
// 2. `/lists/itemsnew` for each list labelled «бомж» (FAN_LIST_MARK_LABEL),
//    100 members a page `after` the last member's `sortId`, to an empty page.
//    Each member is the fan's Fansly account id: his fan row is ensured
//    (unverified, its profile asked of `fan-profiles.lookup`, as the
//    subscribers walk does) and his membership stamped with the generation.
// 3. Past the last list, the page's members the walk did not see are retired
//    (a list no longer labelled so, or gone, included) and the walk is the
//    page's last (page_fan_list_walks): what `listsReadAt` reads.
//
// A cursor that does not move or a list past FAN_LIST_MAX_PAGES ends the walk
// withheld: what it saw is kept, nobody is retired, the last walk stays the
// previous one. Every answer is journaled first (`account_lists`,
// `list_items`); the typed rows are written in the capture's transaction.

const KEY = "fan-lists.poll";

interface FanListsWalk {
  generation: number;
  lists: Array<{ listRef: string; label: string }>;
  /** The list the next request reads. */
  index: number;
  /** Its members after this `sortId`; null: from its head. */
  after: string | null;
  /** Pages of the current list read. */
  pages: number;
  /** Members seen by the walk. */
  seen: number;
}

export interface FanListsCursor {
  /** The newest generation a walk of this row used. */
  generation: number;
  walk: FanListsWalk | null;
  /** The receipt of the last finished walk. */
  last: Record<string, unknown> | null;
}

type Step = { phase: "lists" } | { phase: "items"; listRef: string; after: string | null };

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseWalk(value: unknown): FanListsWalk | null {
  const record = recordOf(value);
  const generation = count(record.generation);
  const index = count(record.index);
  const lists = Array.isArray(record.lists)
    ? record.lists.flatMap((item) => {
      const list = recordOf(item);
      const listRef = text(list.listRef);
      return listRef === null ? [] : [{ listRef, label: typeof list.label === "string" ? list.label : "" }];
    })
    : [];
  if (generation === null || generation < 1 || index === null || index >= lists.length) return null;
  return { generation, lists, index, after: text(record.after), pages: count(record.pages) ?? 0, seen: count(record.seen) ?? 0 };
}

export function parseFanListsCursor(value: unknown): FanListsCursor {
  const record = recordOf(value);
  return {
    generation: count(record.generation) ?? 0,
    walk: parseWalk(record.walk),
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
  };
}

function stepOf(request: Pick<RequestPlan, "step">): Step | null {
  const record = recordOf(request.step);
  if (record.phase === "lists") return { phase: "lists" };
  const listRef = text(record.listRef);
  return record.phase === "items" && listRef !== null ? { phase: "items", listRef, after: text(record.after) } : null;
}

/** The walk read every list it walks: retire whom it did not see, record it, close the poll. */
async function finish(tx: Database, input: ApplyInput, walk: Pick<FanListsWalk, "generation" | "lists" | "seen">): Promise<ApplyResult> {
  const done = await finishPageFanListWalk(tx, {
    pageId: input.pageId,
    generation: walk.generation,
    completedAt: input.observation.receivedAt,
    listsWalked: walk.lists.length,
  });
  const receipt = {
    generation: walk.generation,
    completedAt: input.observation.receivedAt.toISOString(),
    listsWalked: walk.lists.length,
    membersSeen: done.membersSeen,
    retired: done.retired,
  };
  return {
    work: {
      satisfiesRevision: true,
      close: "done",
      closeReason: "walk_complete",
      cursor: { generation: walk.generation, walk: null, last: receipt } satisfies FanListsCursor,
      proof: receipt,
    },
    followups: [],
    counters: { fan_lists_walks: 1, ...(done.retired > 0 ? { fan_list_members_retired: done.retired } : {}) },
  };
}

/** The walk cannot be certified: keep what it saw, retire nobody, record no walk. */
function withheld(walk: FanListsWalk, reason: string, now: Date): ApplyResult {
  const receipt = { generation: walk.generation, withheldAt: now.toISOString(), reason, listRef: walk.lists[walk.index]?.listRef ?? null };
  return {
    work: {
      satisfiesRevision: true,
      close: "done",
      closeReason: "walk_withheld",
      cursor: { generation: walk.generation, walk: null, last: { withheld: receipt } } satisfies FanListsCursor,
      result: receipt,
    },
    followups: [],
    counters: { fan_lists_walk_withheld: 1 },
  };
}

export const fanListsModule: ResourceModule = {
  async plan(work): Promise<StepPlan> {
    const walk = parseFanListsCursor(work.cursor).walk;
    if (walk === null) {
      return { kind: "request", request: { spec: "lists.account", params: {}, step: { phase: "lists" } satisfies Step } };
    }
    const list = walk.lists[walk.index]!;
    return {
      kind: "request",
      request: {
        spec: "lists.items",
        params: { listId: list.listRef, after: walk.after },
        step: { phase: "items", listRef: list.listRef, after: walk.after } satisfies Step,
      },
    };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const cursor = parseFanListsCursor(input.work.cursor);
    const step = stepOf(input.request);
    const walk = cursor.walk;

    if (step?.phase === "lists" && input.request.spec === "lists.account" && walk === null) {
      const lists = parseFanListsAnswer(input.response);
      if (lists === null) throw new ApplyQuarantine("fan_lists_response_invalid", { spec: "lists.account" });
      await upsertPageFanLists(tx, {
        pageId: input.pageId,
        lists,
        observationId: input.observation.id,
        capturedAt: input.observation.receivedAt,
      });
      const generation = Math.max(cursor.generation, await maxPageFanListGeneration(tx, input.pageId)) + 1;
      const toWalk = fanListsToWalk(lists);
      if (toWalk.length === 0) return finish(tx, input, { generation, lists: [], seen: 0 });
      const next: FanListsWalk = { generation, lists: toWalk, index: 0, after: null, pages: 0, seen: 0 };
      return {
        work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, generation, walk: next } satisfies FanListsCursor },
        followups: [],
        counters: { fan_lists_listed: lists.length },
      };
    }

    const list = walk === null ? null : walk.lists[walk.index]!;
    if (step?.phase !== "items" || input.request.spec !== "lists.items" || walk === null || list === null
      || step.listRef !== list.listRef || step.after !== walk.after) {
      throw new ApplyQuarantine("fan_lists_step_mismatch", { spec: input.request.spec, phase: step?.phase ?? null });
    }
    const items = parseFanListItemsAnswer(input.response, list.listRef);
    if (items === null) throw new ApplyQuarantine("fan_lists_response_invalid", { spec: "lists.items" });

    if (items.length === 0) {
      // The list is read to its end: the next list, or the walk is done.
      const index = walk.index + 1;
      if (index >= walk.lists.length) return finish(tx, input, walk);
      const next: FanListsWalk = { ...walk, index, after: null, pages: 0 };
      return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, walk: next } satisfies FanListsCursor }, followups: [] };
    }

    const fanRefs = [...new Set(items.map((item) => item.fanRef))];
    const lookup = await partitionLookupIds(tx, { pageId: input.pageId, ids: fanRefs, now: input.now });
    const fanMap = await upsertHydratedFansForPage(tx, {
      platformAccountId: input.pageId,
      accounts: [],
      unverifiedIds: lookup.due,
      reusedIds: lookup.fresh,
    });
    await upsertPageFanListMembers(tx, {
      pageId: input.pageId,
      listRef: list.listRef,
      fanIds: fanRefs.flatMap((ref) => fanMap.get(ref) ?? []),
      generation: walk.generation,
      seenAt: input.observation.receivedAt,
    });
    const followups = lookupFollowups(lookup.due, KEY);
    const after = items[items.length - 1]!.sortId;
    const next: FanListsWalk = { ...walk, after, pages: walk.pages + 1, seen: walk.seen + fanRefs.length };
    if (after === walk.after) return { ...withheld(next, "cursor_repeated", input.now), followups };
    if (next.pages >= FAN_LIST_MAX_PAGES) return { ...withheld(next, "page_cap", input.now), followups };
    return {
      work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, walk: next } satisfies FanListsCursor },
      followups,
      counters: { fan_list_members_seen: fanRefs.length },
    };
  },
};
