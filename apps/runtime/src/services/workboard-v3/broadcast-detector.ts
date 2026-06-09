import { createHash } from "node:crypto";

import {
  type Database,
  type Wb3ModelMessageRow,
  createWb3BroadcastGroup,
  extendWb3BroadcastGroup,
  findWb3BroadcastGroup,
  getWb3BroadcastScanWindow,
  getWb3BroadcastWatermark,
  insertWb3BroadcastTouches,
  listWb3ModelMessagesForScan,
  mapWb3BroadcastMessages,
  refreshWb3BroadcastGroupCount,
  setWb3BroadcastWatermark,
} from "@agency_hub_core/db";

// Broadcast detector (PRD §4). Model messages with identical normalized text in
// ≥ minRecipients threads within windowMinutes are a broadcast group. Without
// this, one blast to 5,000 fans reads as "everyone was touched today" and
// zeroes out the cadence logic. Mapping lives in dm_broadcast_messages; sync
// tables are never modified. A short "hey" pasted into 30 gray threads also
// groups — for mass that is honestly a broadcast (semi-template outreach).

export const WB3_BROADCAST_MIN_RECIPIENTS = 10;
export const WB3_BROADCAST_WINDOW_MINUTES = 60;

export function normalizeBroadcastContent(content: string): string {
  return content.toLowerCase().trim();
}

export function hashBroadcastContent(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

export interface DetectBroadcastsOptions {
  platformAccountId: number;
  now?: Date;
  minRecipients?: number;
  windowMinutes?: number;
}

export interface DetectBroadcastsResult {
  platformAccountId: number;
  scanned: number;
  groupsCreated: number;
  groupsExtended: number;
  messagesMapped: number;
  touchesCreated: number;
}

type Cluster = {
  hash: string;
  messages: Wb3ModelMessageRow[];
  firstAt: Date;
  lastAt: Date;
};

// Anchored-window clustering: a cluster collects messages within windowMs of
// its first message. Consecutive clusters of one long blast merge through the
// group-overlap lookup, since each new cluster starts inside the previous
// cluster's extended window.
function clusterByHash(messages: Wb3ModelMessageRow[], windowMs: number): Cluster[] {
  const byHash = new Map<string, Wb3ModelMessageRow[]>();
  for (const message of messages) {
    const normalized = normalizeBroadcastContent(message.content);
    if (!normalized) {
      continue; // media-only / empty messages never group
    }
    const hash = hashBroadcastContent(normalized);
    const bucket = byHash.get(hash);
    if (bucket) {
      bucket.push(message);
    } else {
      byHash.set(hash, [message]);
    }
  }

  const clusters: Cluster[] = [];
  for (const [hash, bucket] of byHash) {
    let current: Wb3ModelMessageRow[] = [];
    let anchor: number | null = null;
    const flush = () => {
      if (current.length > 0) {
        clusters.push({
          hash,
          messages: current,
          firstAt: current[0]!.createdAt,
          lastAt: current[current.length - 1]!.createdAt,
        });
      }
    };
    for (const message of bucket) {
      const at = message.createdAt.getTime();
      if (anchor === null || at - anchor > windowMs) {
        flush();
        current = [message];
        anchor = at;
      } else {
        current.push(message);
      }
    }
    flush();
  }
  clusters.sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());
  return clusters;
}

/**
 * Scans model messages synced since the last run (plus a window of created_at
 * context around them, so a blast split across sync runs still reaches the
 * threshold), groups broadcasts, and credits `broadcast` touches to the fans
 * of newly mapped messages. Idempotent: re-scans only refresh counters.
 */
export async function detectBroadcastsForPage(
  db: Database,
  options: DetectBroadcastsOptions,
): Promise<DetectBroadcastsResult> {
  const {
    platformAccountId,
    minRecipients = WB3_BROADCAST_MIN_RECIPIENTS,
    windowMinutes = WB3_BROADCAST_WINDOW_MINUTES,
  } = options;
  const windowMs = windowMinutes * 60_000;

  const result: DetectBroadcastsResult = {
    platformAccountId,
    scanned: 0,
    groupsCreated: 0,
    groupsExtended: 0,
    messagesMapped: 0,
    touchesCreated: 0,
  };

  const watermark = await getWb3BroadcastWatermark(db, platformAccountId);
  const window = await getWb3BroadcastScanWindow(db, { platformAccountId, syncedAfter: watermark });
  if (!window) {
    return result;
  }

  const messages = await listWb3ModelMessagesForScan(db, {
    platformAccountId,
    from: new Date(window.minCreatedAt.getTime() - windowMs),
    to: new Date(window.maxCreatedAt.getTime() + windowMs),
  });
  result.scanned = messages.length;

  for (const cluster of clusterByHash(messages, windowMs)) {
    const distinctThreads = new Set(cluster.messages.map((m) => m.conversationId));
    if (distinctThreads.size < minRecipients) {
      continue;
    }

    const overlapStart = new Date(cluster.firstAt.getTime() - windowMs);
    const overlapEnd = new Date(cluster.lastAt.getTime() + windowMs);
    const existing = await findWb3BroadcastGroup(db, {
      platformAccountId,
      contentHash: cluster.hash,
      overlapStart,
      overlapEnd,
    });

    let groupId: number;
    if (existing) {
      groupId = existing.id;
      await extendWb3BroadcastGroup(db, {
        groupId,
        firstSentAt: cluster.firstAt,
        lastSentAt: cluster.lastAt,
      });
      result.groupsExtended += 1;
    } else {
      groupId = await createWb3BroadcastGroup(db, {
        platformAccountId,
        contentHash: cluster.hash,
        firstSentAt: cluster.firstAt,
        lastSentAt: cluster.lastAt,
      });
      result.groupsCreated += 1;
    }

    const newlyMapped = await mapWb3BroadcastMessages(db, {
      groupId,
      messagePks: cluster.messages.map((m) => m.id),
    });
    result.messagesMapped += newlyMapped.length;
    await refreshWb3BroadcastGroupCount(db, groupId);

    if (newlyMapped.length > 0) {
      const newlyMappedSet = new Set(newlyMapped);
      const touchRows = cluster.messages
        .filter((m) => newlyMappedSet.has(m.id) && m.fanId != null)
        .map((m) => ({
          platformAccountId,
          fanId: m.fanId!,
          confirmedAt: m.createdAt,
          modelMessagePk: m.id,
        }));
      result.touchesCreated += await insertWb3BroadcastTouches(db, touchRows);
    }
  }

  await setWb3BroadcastWatermark(db, { platformAccountId, scannedUntil: window.maxSyncedAt });
  return result;
}
