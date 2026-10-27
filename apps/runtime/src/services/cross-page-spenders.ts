import {
  listCrossPageSpenders,
  readCrossPageSpendersFreshness,
  type CrossPageAudience,
  type CrossPageAudienceFreshness,
  type Database,
  type PlaneReadWitness,
} from "@agency_hub_core/db";
import { sumMills, type Mills } from "@agency_hub_core/shared";

/**
 * Cross-page spenders: the fans in one page's audience (the TARGET T) who paid
 * other pages of the same platform (the SOURCES S). A fan who spends on lora-2
 * often follows lora-1 for free, and lora-1's mass message to every follower
 * then lands in his chat out of place: this set is what such a message leaves
 * out. `hub cross-spenders` reads it (agent-read `agentCrossSpenders`); a
 * hub-managed Fansly list of T will hold it.
 *
 * A pure database read. The caller hands in the pages it may draw from (an
 * agent key's grant, or every page for Hub's own work) and decides what a
 * refusal answers.
 *
 * The rules:
 *   - the audience of T is its `page_fans` rows with `is_follower` and/or
 *     `is_subscriber` (`audience`: followers, subscribers, any);
 *   - the sources are the other pages of T's model on T's platform by default
 *     (lora-1 → lora-2, lora-3), every other page of T's platform with `all`,
 *     or a list; a listed page on another platform, or T itself, is refused —
 *     a fan is `fans.id`, one identity per platform, never across platforms;
 *   - a fan qualifies when his gross over S (`fan_spend_lifetime`) is at least
 *     `minSourceSpendMills` and his gross on T at most `maxTargetSpendMills`
 *     (null: any);
 *   - largest source spend first, then the fan's platform id.
 */

/** A page the sources may be drawn from (an agent key's grant page fits). */
export interface CrossPageSpendersPage {
  id: number;
  pageLabel: string;
  platform: string;
  /** The model the page belongs to: its pages are the default sources. */
  modelSlug: string;
}

/** `model`: T's model's other pages; `all`: every other page of T's platform;
 *  a list: these pages, by label. */
export type CrossPageSourceSelection = "model" | "all" | readonly string[];

export type CrossPageSourceRefusalReason = "unknown_page" | "other_platform" | "target_page";

/** A listed source that cannot be one. `unknown_page`: not among the pages
 *  the caller may draw from (an agent answers it like any page out of reach). */
export class CrossPageSourceRefusal extends Error {
  constructor(readonly reason: CrossPageSourceRefusalReason, readonly pageLabel: string) {
    super(reason === "other_platform"
      ? `source page ${pageLabel} is on another platform than the target page`
      : reason === "target_page"
        ? `source page ${pageLabel} is the target page itself`
        : `source page ${pageLabel} is not known`);
  }
}

/** The source pages of a selection, in label order. Throws
 *  {@link CrossPageSourceRefusal} for a listed page that cannot be one. */
export function resolveCrossPageSources(input: {
  target: CrossPageSpendersPage;
  candidates: readonly CrossPageSpendersPage[];
  sources: CrossPageSourceSelection;
}): CrossPageSpendersPage[] {
  const { target } = input;
  const others = input.candidates.filter((page) => page.id !== target.id && page.platform === target.platform);
  let chosen: CrossPageSpendersPage[];
  if (input.sources === "model") {
    chosen = others.filter((page) => page.modelSlug === target.modelSlug);
  } else if (input.sources === "all") {
    chosen = others;
  } else {
    const byLabel = new Map(input.candidates.map((page) => [page.pageLabel, page]));
    const picked = new Map<number, CrossPageSpendersPage>();
    for (const label of input.sources) {
      const page = byLabel.get(label);
      if (page === undefined) throw new CrossPageSourceRefusal("unknown_page", label);
      if (page.id === target.id) throw new CrossPageSourceRefusal("target_page", label);
      if (page.platform !== target.platform) throw new CrossPageSourceRefusal("other_platform", label);
      picked.set(page.id, page);
    }
    chosen = [...picked.values()];
  }
  return chosen.sort((a, b) => (a.pageLabel < b.pageLabel ? -1 : a.pageLabel > b.pageLabel ? 1 : 0));
}

export interface CrossPageSpendersInput {
  target: CrossPageSpendersPage;
  /** Already resolved ({@link resolveCrossPageSources}). */
  sources: readonly CrossPageSpendersPage[];
  audience: CrossPageAudience;
  /** At least 1 mill. */
  minSourceSpendMills: Mills;
  /** At least 0; null: the target's spend does not matter. */
  maxTargetSpendMills: Mills | null;
}

export interface CrossPageSpender {
  fanId: number;
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  isFollower: boolean;
  followerSince: Date | null;
  isSubscriber: boolean;
  subscriptionExpiresAt: Date | null;
  /** T's last account answer did not return the fan (deleted or blocked T). */
  accountLookupMissAt: Date | null;
  targetSpendMills: Mills;
  sourceSpendMills: Mills;
  lastSourceTransactionAt: Date | null;
  /** The sources the fan paid, largest first. */
  sources: Array<{ page: CrossPageSpendersPage; grossMills: Mills; lastTransactionAt: Date | null }>;
}

export interface CrossPageSpendersSet {
  input: CrossPageSpendersInput;
  /** Every qualifying fan, largest source spend first, then platform id
   *  (byte order: {@link compareCrossPageSpenders}). */
  fans: CrossPageSpender[];
  /** Per source page: how many qualifying fans paid it and what they paid it,
   *  and its transactions capture floor (the oldest transaction Hub stores). */
  perSource: Array<{ page: CrossPageSpendersPage; fans: number; grossMills: Mills; transactionsFloorAt: Date | null }>;
  /** When T's audience walks last completed. */
  audience: CrossPageAudienceFreshness;
  /** What the statements read (the agent plane's capture evidence). */
  witnesses: PlaneReadWitness[];
  /** The latest of the sources' transactions floors; null when a source
   *  stores no transaction or there is no source. */
  transactionsFloorAt: Date | null;
}

/** The set's order: source spend descending, then platform id in byte order. */
export function compareCrossPageSpenders(
  a: { sourceSpendMills: Mills; platformUserId: string },
  b: { sourceSpendMills: Mills; platformUserId: string },
): number {
  if (a.sourceSpendMills !== b.sourceSpendMills) return a.sourceSpendMills > b.sourceSpendMills ? -1 : 1;
  return a.platformUserId < b.platformUserId ? -1 : a.platformUserId > b.platformUserId ? 1 : 0;
}

export async function readCrossPageSpenders(db: Database, input: CrossPageSpendersInput): Promise<CrossPageSpendersSet> {
  if (input.minSourceSpendMills < 1n) throw new RangeError("minSourceSpendMills must be at least 1 mill");
  if (input.maxTargetSpendMills !== null && input.maxTargetSpendMills < 0n) {
    throw new RangeError("maxTargetSpendMills must not be negative");
  }
  for (const source of input.sources) {
    if (source.id === input.target.id || source.platform !== input.target.platform) {
      throw new CrossPageSourceRefusal(source.id === input.target.id ? "target_page" : "other_platform", source.pageLabel);
    }
  }
  const sourcePageIds = input.sources.map((page) => page.id);
  const listed = await listCrossPageSpenders(db, {
    targetPageId: input.target.id,
    sourcePageIds,
    audience: input.audience,
    minSourceSpendMills: input.minSourceSpendMills,
    maxTargetSpendMills: input.maxTargetSpendMills,
  });
  const freshness = await readCrossPageSpendersFreshness(db, { targetPageId: input.target.id, sourcePageIds });
  const pageById = new Map(input.sources.map((page) => [page.id, page]));
  const fans = listed.rows.map((row): CrossPageSpender => ({
    ...row,
    sources: row.sources.flatMap((source) => {
      const page = pageById.get(source.pageId);
      return page === undefined ? [] : [{ page, grossMills: source.grossMills, lastTransactionAt: source.lastTransactionAt }];
    }),
  }));
  // The statement sorts the same way; sorting again here makes the order this
  // module's own, so a resumed page compares with the function that sorted.
  fans.sort(compareCrossPageSpenders);
  const perSource = input.sources.map((page) => {
    const paid = fans.flatMap((fan) => fan.sources.filter((source) => source.page.id === page.id));
    return {
      page,
      fans: paid.length,
      grossMills: sumMills(paid.map((source) => source.grossMills)),
      transactionsFloorAt: freshness.transactionFloors.get(page.id) ?? null,
    };
  });
  const floors = perSource.map((source) => source.transactionsFloorAt);
  const transactionsFloorAt = floors.length === 0 || floors.some((floor) => floor === null)
    ? null
    : floors.reduce<Date | null>((best, floor) => (best === null || (floor !== null && floor > best) ? floor : best), null);
  return {
    input,
    fans,
    perSource,
    audience: freshness.audience,
    witnesses: [...listed.witnesses, ...freshness.witnesses],
    transactionsFloorAt,
  };
}
