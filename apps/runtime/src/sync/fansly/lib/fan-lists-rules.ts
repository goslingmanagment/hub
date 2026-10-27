// Fan marks (2026-10-27): the pure rules of `fan-lists.poll` — which lists it
// walks, and how it reads the two answers. The resource is
// ../resources/fan-lists.ts; the marks read is services/client-fan-marks.ts.
//
// Answers as the test model's own session got them on 2026-10-27:
//   GET /lists/account?itemId=  → [{ id, accountId, pos, type, label, itemCount }]
//   GET /lists/itemsnew?listId=&limit=&sortMode=3[&after=<sortId>]
//                               → [{ id, sortId, listId, type, metadata }], `id`
//                                 the member's Fansly account id; [] past the end

/** A list whose label says this is walked, and its members mark the fan
 *  («💩 Бомж», «Бомж» on the pages of 2026-10). Every list's label and count
 *  are stored; only these lists' members are read. */
export const FAN_LIST_MARK_LABEL = /бомж/i;

/** Pages of one list a walk reads at most (100 members a page): past it the
 *  walk stops without retiring anyone. */
export const FAN_LIST_MAX_PAGES = 500;

export interface FanListServed {
  listRef: string;
  /** As served (the pages pad theirs with spaces: " 💩 Бомж "). */
  label: string;
  type: number | null;
  itemCount: number | null;
}

export interface FanListItemServed {
  /** The member's Fansly account id. */
  fanRef: string;
  sortId: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** An id as Fansly serves it: a nonblank string of digits (a number is taken as its digits). */
function idOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === "string" && /^\d{1,30}$/.test(value) ? value : null;
}

function intOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** The lists answer, or null when it is not an array of lists with an id and a label. */
export function parseFanListsAnswer(response: unknown): FanListServed[] | null {
  if (!Array.isArray(response)) return null;
  const lists: FanListServed[] = [];
  for (const item of response) {
    const row = recordOf(item);
    const listRef = idOf(row?.id);
    if (row === null || listRef === null || typeof row.label !== "string") return null;
    lists.push({ listRef, label: row.label, type: intOf(row.type), itemCount: intOf(row.itemCount) });
  }
  return lists;
}

/**
 * One page of a list's members, or null when it is not an array of members
 * with an account id and a sort id, or names a member of another list.
 */
export function parseFanListItemsAnswer(response: unknown, listRef: string): FanListItemServed[] | null {
  if (!Array.isArray(response)) return null;
  const items: FanListItemServed[] = [];
  for (const item of response) {
    const row = recordOf(item);
    const fanRef = idOf(row?.id);
    const sortId = idOf(row?.sortId);
    if (row === null || fanRef === null || sortId === null) return null;
    if (row.listId !== undefined && idOf(row.listId) !== listRef) return null;
    items.push({ fanRef, sortId });
  }
  return items;
}

/** The label a chatter reads: trimmed. */
export function fanListLabel(label: string): string {
  return label.trim();
}

/** Whether a list's members mark the fan. */
export function isMarkList(label: string): boolean {
  return FAN_LIST_MARK_LABEL.test(label);
}

/** The lists a walk reads the members of, in the order served: the marked ones that are not stated empty. */
export function fanListsToWalk(lists: readonly FanListServed[]): Array<{ listRef: string; label: string }> {
  return lists
    .filter((list) => isMarkList(list.label) && list.itemCount !== 0)
    .map((list) => ({ listRef: list.listRef, label: list.label }));
}
