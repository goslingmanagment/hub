// Offset walks of the Fansly Sync Engine (plan §6.2 "offset-walk с проверкой
// стабильности"): one page per step, the position in the work's cursor. The
// stability rules of each list (a total that moved, rows served twice, a
// restart bound) are the resource's own; this file holds what every offset
// walk shares.

/**
 * Whether a served offset page ends its walk: a short page, or — when the
 * list states a total — the page that reaches it. The adapter's own `done`
 * rule (`getSubscribersPage`, `getFollowersPage`), unchanged.
 */
export function offsetPageDone(input: { offset: number; itemCount: number; limit: number; total: number | null }): boolean {
  if (input.itemCount < input.limit) return true;
  return input.total !== null && input.offset + input.itemCount >= input.total;
}
