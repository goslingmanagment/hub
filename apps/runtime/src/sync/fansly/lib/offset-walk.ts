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

/**
 * The pages a full walk over `total` rows reads (shadow estimate, design
 * §3.12 "offset walks ⇒ pages = ceil(estimatedTotal / limit)"), by the rule
 * of `offsetPageDone`: a list that states its total ends on the page that
 * reaches it; one that does not ends on a short page, so an exact multiple
 * reads the empty page after it. At least one.
 */
export function offsetWalkPages(input: { total: number | null; limit: number; statedTotal: boolean }): number {
  const total = input.total;
  if (total === null || !(total > 0)) return 1;
  return input.statedTotal ? Math.max(1, Math.ceil(total / input.limit)) : Math.floor(total / input.limit) + 1;
}

/** The shadow progress of a walk whose length is estimated at its start. */
export interface ShadowWalkProgress {
  /** Steps the walk is estimated to take. */
  steps: number;
  /** Steps simulated so far. */
  done: number;
}

/** One simulated step of a walk; `finished` when it was the last. */
export function advanceShadowWalk(progress: ShadowWalkProgress | null, estimatedSteps: () => number): {
  progress: ShadowWalkProgress;
  finished: boolean;
} {
  const steps = progress?.steps ?? Math.max(1, Math.trunc(estimatedSteps()));
  const done = (progress?.done ?? 0) + 1;
  return { progress: { steps, done }, finished: done >= steps };
}
