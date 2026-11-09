/**
 * Disputed sales of the demo team: sales on a shared page where two chatters'
 * marks do not agree. As in Hub, a sale is two chatters' only when both their
 * shifts held it: two shifts on the same page at the sale's minute («оба моё»,
 * «моё» against «делим»). A «делим» the teammate never confirmed needs only the
 * holder's shift — then only the holder's side is known. The disputes, the
 * payouts (team.ts), the reviews of both shifts (team-review.ts: the fan's chat
 * is there, around the sale) and the fan's card tell one story.
 */
import { DEMO_CHATTERS, type DemoUser } from "../world.ts";
import { DAY, HOUR, between, rng, teamWorld, workedPages, workingAt, type DemoSale, type DemoShift, type DemoTeamWorld } from "./team-world.ts";

export interface DemoDispute {
  sale: DemoSale;
  /** The shift holding the sale, of the chatter the sale is credited to in the world. */
  shift: DemoShift;
  reason: "two_mine" | "share_not_agreed" | "conflicting";
  other: DemoUser;
  /** The other claimant's shift that held the sale too; null when only the holder's mark is known («делим» not confirmed). */
  otherShift: DemoShift | null;
  /** The owner's split, or null. */
  resolution: Array<{ user: DemoUser; percent: number }> | null;
  resolvedAt: number | null;
}

const cache = new WeakMap<DemoTeamWorld, DemoDispute[]>();

/** A shift of another chatter that held the sale on its page too (worked there, the sale's minute inside it). */
function alsoHeldBy(world: DemoTeamWorld, shift: DemoShift, sale: DemoSale): DemoShift | null {
  return world.shifts.find((other) => other.user.id !== shift.user.id && other.confirmedAt !== null
    && other.startedAt <= sale.at && sale.at <= other.endedAt && workedPages(other).includes(sale.pageLabel)) ?? null;
}

export function teamDisputes(now: Date): DemoDispute[] {
  const world = teamWorld(now);
  const known = cache.get(world);
  if (known) return known;
  const disputes: DemoDispute[] = [];
  // Sales two shifts held: the demo's waiting dispute is the last week's biggest, when chance made none.
  const candidates: Array<{ sale: DemoSale; shift: DemoShift; both: DemoShift }> = [];
  for (const shift of world.shifts) {
    if (shift.confirmedAt === null) continue;
    const pages = workedPages(shift);
    for (const sale of shift.sales) {
      if (!pages.includes(sale.pageLabel) || sale.netMills < 12_000) continue;
      const random = rng(`dispute:${sale.ref}`);
      const both = alsoHeldBy(world, shift, sale);
      let reason: DemoDispute["reason"];
      let other: DemoUser;
      if (both) {
        candidates.push({ sale, shift, both });
        // Two shifts held it: now and then both reports claim it.
        if (random() > 0.25) continue;
        reason = random() < 0.6 ? "two_mine" : "conflicting";
        other = both.user;
      } else {
        // One shift held it and its chatter marked «делим» with a teammate of the page, who never confirmed.
        const others = DEMO_CHATTERS.filter((user) => user.id !== shift.user.id && user.pages.includes(sale.pageLabel) && workingAt(user, sale.at, now));
        if (others.length === 0 || random() > 0.015) continue;
        reason = "share_not_agreed";
        other = others[Math.floor(random() * others.length)]!;
      }
      const age = now.getTime() - sale.at;
      const resolved = age > 4 * DAY && random() < 0.7;
      const resolution = !resolved
        ? null
        : random() < 0.5
          ? [{ user: shift.user, percent: 50 }, { user: other, percent: 50 }]
          : random() < 0.7
            ? [{ user: shift.user, percent: 100 }]
            : [{ user: shift.user, percent: 70 }, { user: other, percent: 30 }];
      disputes.push({ sale, shift, reason, other, otherShift: both, resolution, resolvedAt: resolved ? sale.at + Math.round(between(random, 1.6, 3.5) * DAY) : null });
    }
  }
  // Calm, as on production: one dispute waits for the owner — a fresh one of two shifts, so both sides can be read; the
  // others were settled.
  const fresh = now.getTime() - 7 * DAY;
  const open = disputes.filter((dispute) => dispute.resolution === null).sort((left, right) => right.sale.at - left.sale.at);
  let waiting = open.find((dispute) => dispute.otherShift !== null && dispute.sale.at >= fresh);
  if (!waiting) {
    // The week's biggest such sale: a dispute worth the owner's minute.
    const biggest = candidates.filter((item) => item.sale.at >= fresh && !disputes.some((dispute) => dispute.sale === item.sale))
      .sort((left, right) => right.sale.netMills - left.sale.netMills || right.sale.at - left.sale.at)[0];
    if (biggest) {
      waiting = { sale: biggest.sale, shift: biggest.shift, reason: "two_mine", other: biggest.both.user, otherShift: biggest.both, resolution: null, resolvedAt: null };
      disputes.push(waiting);
    }
  }
  waiting ??= open[0];
  for (const dispute of disputes) {
    if (dispute.resolution !== null || dispute === waiting) continue;
    dispute.resolution = [{ user: dispute.shift.user, percent: 50 }, { user: dispute.other, percent: 50 }];
    dispute.resolvedAt = Math.min(now.getTime() - HOUR, dispute.sale.at + DAY);
  }
  cache.set(world, disputes);
  return disputes;
}
