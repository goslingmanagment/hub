import {
  TRAFFIC_LINK_UNBOUND_FAN_DAYS,
  TRAFFIC_LINK_UNBOUND_MADE_DAYS,
} from "@agency_hub_core/contracts";
import {
  listUnboundOfLinks,
  readTrafficSourceVocabulary,
  type Database,
  type TrafficSourceVocabularyRow,
  type UnboundOfLinkRow,
} from "@agency_hub_core/db";

import type { MirrorItem } from "./matters-mirror.ts";
import { proposedChannelOf } from "./of-link-fans.ts";
import { ofLinkState } from "./of-links.ts";

// «Ждут вас» → Трафик (`traffic.link_unbound`): a new OnlyFans link must not
// wait for someone to remember to file it. One matter per link without a
// binding at any time that still works and is new or brings fans; it closes
// itself when the link gets a source, finishes, or falls out of that. Written
// by the checks' pass (matter-checks.ts) on the live realm's pages only.

const DAY_MS = 86_400_000;

export type UnboundLinkFacts = Pick<UnboundOfLinkRow, "linkCreatedAt" | "linkEndsAt" | "isFinished" | "fansNow" | "fansThen">;

/** Made within the last 30 days (by the link's own creation date; unknown is not new). */
function madeRecently(link: UnboundLinkFacts, now: Date): boolean {
  return link.linkCreatedAt !== null && now.getTime() - link.linkCreatedAt.getTime() <= TRAFFIC_LINK_UNBOUND_MADE_DAYS * DAY_MS;
}

/**
 * Whether an OnlyFans link with no binding at any time waits for its source:
 * it has not ended or finished, and it was made within the last 30 days or
 * its fans grew over the last 14 (against its read 14 days ago, or its first
 * read when it is younger in the series). An old dead link with a stray click
 * raises nothing.
 */
export function linkUnboundWaits(link: UnboundLinkFacts, now: Date): boolean {
  if (ofLinkState(link, now) !== "active") return false;
  const gotFan = link.fansNow !== null && link.fansThen !== null && link.fansNow > link.fansThen;
  return madeRecently(link, now) || gotFan;
}

/** The matters the unbound links make, each with its proposal when one fits. */
export function linkUnboundItems(
  links: readonly UnboundOfLinkRow[],
  vocabulary: readonly TrafficSourceVocabularyRow[],
  now: Date,
): MirrorItem[] {
  return links.filter((link) => linkUnboundWaits(link, now)).map((link) => {
    const ref = `${link.pageId}:${link.linkKind}:${link.linkRef}`;
    const proposal = proposedChannelOf(link.name, false, vocabulary);
    return {
      key: `traffic.link_unbound:${ref}`,
      title: `Ссылка «${link.name ?? link.linkRef}» без источника`.slice(0, 300),
      object: { type: "of_link", id: ref },
      pageLabels: [link.pageLabel],
      money: false,
      evidence: {
        pageId: link.pageId,
        linkKind: link.linkKind,
        linkRef: link.linkRef,
        name: link.name,
        proposedChannel: proposal === null ? null : { key: proposal.channelKey, title: proposal.channelTitle },
        // A new link waits since it was made; an old one that brings fans again, since the matter opened.
        ...(madeRecently(link, now) ? { since: link.linkCreatedAt!.toISOString() } : {}),
      },
      link: `/traffic/link/${link.pageId}/${link.linkKind}/${link.linkRef}`,
    };
  });
}

/** The check's read: the live pages' unbound links and the sources' vocabulary. */
export async function readLinkUnboundItems(db: Database, now: Date): Promise<MirrorItem[]> {
  const [links, vocabulary] = await Promise.all([
    listUnboundOfLinks(db, { fanSince: new Date(now.getTime() - TRAFFIC_LINK_UNBOUND_FAN_DAYS * DAY_MS) }),
    readTrafficSourceVocabulary(db),
  ]);
  return linkUnboundItems(links, vocabulary, now);
}
