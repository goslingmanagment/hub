// The scheduler: which class the page's next slot serves (plan §3, design
// §3.4). One rule — a fixed cycle of 10 slots, U R U R U R U R U P:
//
//   - urgent    (U) — everything a live event caused: chat confirmations,
//                     money heads, a new chat, repairs, identity checks, …
//   - requests  (R) — history requests of agents and the owner;
//   - planned   (P) — registry polls and long walks.
//
// The slot is chosen when the pacer opens it ("работа выбирается в момент
// слота"): urgent work that arrived during the pause takes the nearest U. An
// empty or blocked class is skipped without waiting and earns no credit; the
// pointer lives in `sync_pages.cycle_pos` (written by the admission
// transaction) and survives restarts. Under full contention the shares are
// 50 / 40 / 10 %; without urgent work 80 / 20 %; a single class gets every
// slot; the urgent class waits at most two slots (U positions are 0,2,4,6,8;
// the longest stretch without one is 9 → 0).
//
// Which work a class serves next is the class picker's business (the
// repository queries: urgent by deadline then age, requests round robin
// between requests and their fans, planned due polls first then round robin
// by resource key). Changing the order or the shares is this file only.
//
// The short look-ahead (step 3b ruling 1): route budgets close a key for a
// few seconds after its route sent (`engine/route-policy.ts`). When the class
// whose turn it is has nothing admissible now but a candidate that opens
// within one longest pause (1.2 × S), the slot waits for it: serving a later
// class now would push that candidate a whole pause past its opening (a
// `/message` every 4 s with a planned read squeezed in each time ≈ 655
// reads an hour instead of ≈ 823). A candidate further off than that does
// not hold the slot — another class's request fits before it, pause
// included. Nothing is reserved: the wait ends in a new pick, and the
// pointer moves only on an admission.

export const CYCLE = ["U", "R", "U", "R", "U", "R", "U", "R", "U", "P"] as const;
export type CycleSlot = (typeof CYCLE)[number];

export const WORK_CLASSES = ["urgent", "requests", "planned"] as const;
export type WorkClass = (typeof WORK_CLASSES)[number];

const CLASS_OF_SLOT: Readonly<Record<CycleSlot, WorkClass>> = {
  U: "urgent",
  R: "requests",
  P: "planned",
};

export function classOf(slot: CycleSlot): WorkClass {
  return CLASS_OF_SLOT[slot];
}

/** What the scheduler needs to know about the page at the slot. Field names
 *  follow the `sync_pages` row, so the repository row satisfies it. */
export interface SchedulerPage {
  /** `sync_pages.cycle_pos`: the position of the next slot, 0..9. */
  cyclePos: number;
  /** Owner pause of the whole page. */
  pausedAll: boolean;
  /** Owner pause of history requests (the requests class). */
  pausedRequests: boolean;
  /** The end of what holds the page itself (§9: auth, identity, network —
   *  `engine/admission.ts`): every class waits. */
  holdUntil: Date | null;
}

export interface ClassWorkSource<W> {
  /** The next runnable work of `workClass` in that class's own order, or null
   *  when the class has none (or all of it is paused, held or broken).
   *  `admissibleAt`: the work its routes admit at that instant rather than
   *  now (the look-ahead's question). */
  pickInClass(workClass: WorkClass, now: Date, admissibleAt?: Date): Promise<W | null>;
}

export interface Picked<W> {
  work: W;
  workClass: WorkClass;
  /** The cycle position this slot was taken from (`sync_attempts.slot`). */
  slot: number;
  /** The pointer to store with the admission (`sync_pages.cycle_pos`). */
  nextCyclePos: number;
}

/** The slot waits for the class whose turn it is: its best candidate opens
 *  at `waitUntil` (the short look-ahead). Nothing was picked. */
export interface PickWait {
  waitUntil: Date;
  workClass: WorkClass;
  /** The cycle position the wait is for. */
  slot: number;
}

export function isPickWait<W>(result: Picked<W> | PickWait): result is PickWait {
  return "waitUntil" in result;
}

/** True when the page as a whole may not be served now (owner pause or hold). */
export function pageBlocked(page: SchedulerPage, now: Date): boolean {
  return page.pausedAll || (page.holdUntil !== null && page.holdUntil.getTime() > now.getTime());
}

/** Whether a class is blocked at the slot: a page pause or hold blocks all
 *  three; the owner's requests pause blocks the requests class. */
export function classBlocked(page: SchedulerPage, workClass: WorkClass, now: Date): boolean {
  if (pageBlocked(page, now)) return true;
  return workClass === "requests" && page.pausedRequests;
}

export function assertCyclePos(cyclePos: number): number {
  if (!Number.isInteger(cyclePos) || cyclePos < 0 || cyclePos >= CYCLE.length) {
    throw new RangeError(`sync_pages.cycle_pos must be an integer in 0..${CYCLE.length - 1} (got ${cyclePos})`);
  }
  return cyclePos;
}

/**
 * Pick the work of the page's next slot: walk the cycle from `cyclePos`,
 * skipping blocked classes and classes without runnable work, and take the
 * first class that has some. Null = the page is idle (the pointer stays).
 * Each class is asked about now at most once per pick.
 *
 * `lookahead`: the instants within the next 1.2 × S at which a key closed by
 * its route budget opens, ascending. A class with nothing admissible now is
 * asked again at each; the first that finds a candidate makes the slot wait
 * for it (`PickWait`) instead of serving a later class.
 */
export async function pick<W>(
  source: ClassWorkSource<W>,
  page: SchedulerPage,
  now: Date,
  lookahead: readonly Date[] = [],
): Promise<Picked<W> | PickWait | null> {
  const start = assertCyclePos(page.cyclePos);
  const asked = new Set<WorkClass>();
  for (let k = 0; k < CYCLE.length; k += 1) {
    const slot = (start + k) % CYCLE.length;
    const workClass = classOf(CYCLE[slot]!);
    if (asked.has(workClass)) continue;
    asked.add(workClass);
    if (classBlocked(page, workClass, now)) continue;
    const work = await source.pickInClass(workClass, now);
    if (work !== null) {
      return { work, workClass, slot, nextCyclePos: (slot + 1) % CYCLE.length };
    }
    const waitUntil = await earliestOpening(source, workClass, now, lookahead);
    if (waitUntil !== null) return { waitUntil, workClass, slot };
  }
  return null;
}

/** The first look-ahead instant at which `workClass` has a candidate, or null.
 *  Openings only add candidates, so the last instant is asked first: a class
 *  with nothing then has nothing at any earlier one (one question). */
async function earliestOpening<W>(
  source: ClassWorkSource<W>,
  workClass: WorkClass,
  now: Date,
  lookahead: readonly Date[],
): Promise<Date | null> {
  const ahead = lookahead.filter((at) => at.getTime() > now.getTime());
  const last = ahead.at(-1);
  if (last === undefined || (await source.pickInClass(workClass, now, last)) === null) return null;
  for (const at of ahead.slice(0, -1)) {
    if ((await source.pickInClass(workClass, now, at)) !== null) return at;
  }
  return last;
}
