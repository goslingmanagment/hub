// The page of one OnlyFans link, beside services/of-links.ts: the fans the
// link brought (the paid walks of its fan lists, read locally — no request to
// OnlyFans) and its source when it has none: which one it probably is, the
// sources to choose from, and the owner's first binding through the CLI's own
// writer (services/traffic-bindings.ts). Owner only (the routes check it).

import type {
  OfLinkFan,
  OfLinkFansResponse,
  OfLinkSourcePutBody,
  OfLinkSourceResponse,
} from "@agency_hub_core/contracts";
import {
  listOfLinkPages,
  ofLinkHasTrafficBinding,
  readOfLinkFans,
  readOfLinkSeriesStart,
  readTrafficSourceVocabulary,
  TrafficBindingsConflictError,
  TrafficLinkAlreadyBoundError,
  type Database,
  type OfLinkFanRow,
  type OfLinkKey,
  type TrafficSourceVocabularyRow,
} from "@agency_hub_core/db";
import { proposeTrafficSource, resolveFanLabelForScope } from "@agency_hub_core/shared";

import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { bindNewTrafficLink, TrafficBindingsFileError } from "./traffic-bindings.ts";

export const OF_LINK_FANS_DEFAULT_LIMIT = 20;

async function requireLink(db: Database, link: OfLinkKey) {
  const [page] = await listOfLinkPages(db, { pageId: link.pageId });
  if (page === undefined) throw new NotFoundError("No OnlyFans page with this id");
  const start = await readOfLinkSeriesStart(db, link);
  if (!start.seen) throw new NotFoundError("The series has never seen this link");
  return { page, start };
}

function millsNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`mills out of range: ${value}`);
  return number;
}

/** Still subscribed by the walks' own fields: active and not missed twice — the period on the link is open. */
export function ofLinkFanStatus(row: Pick<OfLinkFanRow, "inSubscriberList" | "lastSeenActive" | "absentWalks">): OfLinkFan["status"] {
  if (!row.inSubscriberList) return null;
  return row.lastSeenActive === true && row.absentWalks < 2 ? "active" : "left";
}

function fanOut(row: OfLinkFanRow): OfLinkFan {
  const label = resolveFanLabelForScope({ platformUserId: row.fanRef, pageAlias: row.pageAlias, displayName: row.displayName, username: row.username }, "page");
  return {
    fanId: row.fanId,
    fanRef: row.fanRef,
    name: label.primarySource === "pageAlias" || label.primarySource === "displayName" ? label.label : null,
    username: label.username,
    deleted: row.deleted,
    subscribedAt: row.subscribedAt === null ? null : row.subscribedAt.toISOString(),
    firstSeenAt: row.firstSeenAt.toISOString(),
    status: ofLinkFanStatus(row),
    paidMills: row.vendorNetMills === null ? null : millsNumber(row.vendorNetMills),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/of-links/fans

export async function getOfLinkFans(
  db: Database,
  input: OfLinkKey & { limit?: number | undefined; offset?: number | undefined; now: Date },
): Promise<OfLinkFansResponse> {
  const link = { pageId: input.pageId, linkKind: input.linkKind, linkRef: input.linkRef };
  await requireLink(db, link);
  const limit = input.limit ?? OF_LINK_FANS_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const read = await readOfLinkFans(db, { ...link, limit, offset });
  return {
    generatedAt: input.now.toISOString(),
    ...link,
    total: read.total,
    paying: read.moneyKnown === 0 ? null : read.paying,
    walkedAt: read.walkedAt === null ? null : read.walkedAt.toISOString(),
    limit,
    offset,
    fans: read.fans.map(fanOut),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/of-links/source, PUT the same

const choiceOf = (row: TrafficSourceVocabularyRow) => ({ channelKey: row.key, channelTitle: row.title });

/** Which source an unbound link probably is (null: bound, or nothing fits): the one pure rule. */
export function proposedChannelOf(name: string | null, bound: boolean, vocabulary: readonly TrafficSourceVocabularyRow[]) {
  if (bound) return null;
  const key = proposeTrafficSource(name, vocabulary);
  const row = key === null ? undefined : vocabulary.find((candidate) => candidate.key === key);
  return row === undefined ? null : choiceOf(row);
}

async function sourceOf(db: Database, link: OfLinkKey, name: string | null): Promise<OfLinkSourceResponse> {
  const [bound, vocabulary] = await Promise.all([ofLinkHasTrafficBinding(db, link), readTrafficSourceVocabulary(db)]);
  return {
    ...link,
    bound,
    proposedChannel: proposedChannelOf(name, bound, vocabulary),
    channels: vocabulary.map(choiceOf),
  };
}

export async function getOfLinkSource(db: Database, link: OfLinkKey): Promise<OfLinkSourceResponse> {
  const { start } = await requireLink(db, link);
  return sourceOf(db, { pageId: link.pageId, linkKind: link.linkKind, linkRef: link.linkRef }, start.name);
}

/**
 * The first source of a link that never had one, from the link's creation
 * (the latest read's date; unknown: the series' first read of it), basis
 * confirmed, written by the CLI's own writer with the owner as the actor.
 * A link with a binding at any time is refused (409): changing a source stays
 * with `traffic:bindings:set`.
 */
export async function setOfLinkSource(
  db: Database,
  input: { body: OfLinkSourcePutBody; actorUserId: number; actorUsername: string },
) {
  const link = { pageId: input.body.pageId, linkKind: input.body.linkKind, linkRef: input.body.linkRef };
  const { page, start } = await requireLink(db, link);
  if (await ofLinkHasTrafficBinding(db, link)) throw new ConflictError("The link already has a source; change it with traffic:bindings:set");
  const vocabulary = await readTrafficSourceVocabulary(db);
  if (!vocabulary.some((row) => row.key === input.body.channelKey)) throw new BadRequestError("No source with this key");
  const validFrom = start.linkCreatedAt ?? start.firstObservedAt!;
  try {
    await bindNewTrafficLink(db, {
      page: page.pageLabel,
      kind: link.linkKind,
      link: link.linkRef,
      channel: input.body.channelKey,
      validFrom,
      actor: `dashboard:${input.actorUsername}`,
      actorUserId: input.actorUserId,
    });
  } catch (error) {
    if (error instanceof TrafficLinkAlreadyBoundError) throw new ConflictError("The link already has a source; change it with traffic:bindings:set");
    if (error instanceof TrafficBindingsConflictError) throw new ConflictError(error.conflicts.join("; "));
    if (error instanceof TrafficBindingsFileError) throw new BadRequestError(error.message);
    throw error;
  }
  return { ...(await sourceOf(db, link, start.name)), validFrom: validFrom.toISOString() };
}
